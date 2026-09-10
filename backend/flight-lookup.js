// Flight lookup.
//
// Two sources, each answering only what it is authoritative for:
//
//   flights_custom / flights.json → flight number, departure time, destination
//   airports.json                 → city, country and nationality, by IATA code
//
// Nationality is resolved from the destination airport rather than from the
// flight number: the same number can serve a different destination on a
// different day, and the airport is what actually determines the answer.

const { getDb } = require('./db');
const airports = require('./airports.json');
const timetableJson = require('./flights.json');

// Jeddah is UTC+3 year-round (no DST).
const JEDDAH_OFFSET_MS = 3 * 60 * 60 * 1000;

// A flight counts as departed from 30 min before STD: that is when the gate
// closes and a no-show is actually identified.
const DEPARTURE_GRACE_MS = 30 * 60 * 1000;
const DAY_MS = 86400000;

const pad2 = n => String(n).padStart(2, '0');

// A Date whose UTC fields read as Jeddah wall-clock. Deliberately not
// `new Date()` read locally: the server runs in UTC, where between 00:00 and
// 03:00 Jeddah the calendar date is still yesterday.
function jeddahNow() {
  return new Date(Date.now() + JEDDAH_OFFSET_MS);
}

// Users type SV309, sv 309, SV0309. Normalize before looking anything up.
//
// The {2} is exact on purpose. Widening it to {2,3} lets 0* swallow a real
// zero inside the number and turns SV309 into SV39.
function normalizeFlightNumber(input) {
  if (!input) return '';
  const clean = String(input).toUpperCase().replace(/\s+/g, '');
  const m = clean.match(/^([A-Z\d]{2})0*(\d+)$/);   // IATA carrier code is 2 chars
  return m ? m[1] + m[2] : clean;
}

// The timetable stores a recurring departure time ("08:50") with no date, so a
// lookup has to choose which day's departure is meant:
//
//   'past'   → previous flight: the most recent departure already gone
//   'future' → new flight: the next departure still to come
//
// 'past' honours the same 30-minute gate-close grace as the departed check, so
// a case opened just before STD resolves to today rather than yesterday.
// This is only the starting guess — the field stays editable.
function resolveTimetableDate(time, direction) {
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!t) return null;
  const h = +t[1], min = +t[2];
  if (h > 23 || min > 59) return null;

  const nowJed = jeddahNow();
  const stdMs = Date.UTC(nowJed.getUTCFullYear(), nowJed.getUTCMonth(), nowJed.getUTCDate(), h, min);

  let shift = 0;
  if (direction === 'past'   && stdMs - DEPARTURE_GRACE_MS > nowJed.getTime()) shift = -1;
  if (direction === 'future' && stdMs <= nowJed.getTime())                     shift = +1;

  const d = new Date(stdMs + shift * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Everything about the destination comes from one table keyed by IATA code, so
// the same airport always yields the same city, country and nationality.
function destinationFacts(code) {
  const a = airports[String(code || '').toUpperCase()];
  return a
    ? { city: a.city, country: a.country, nationality: a.nationality }
    : { city: '', country: '', nationality: '' };
}

// flights_custom is read ahead of flights.json: it holds supervisor additions
// and overrides, and a row marked deleted hides a flights.json entry.
async function timetableEntry(flightNumber) {
  const { rows } = await getDb().query(
    `SELECT * FROM flights_custom WHERE flight_number = $1`, [flightNumber]
  );
  const custom = rows[0];
  if (custom) {
    if (custom.deleted) return null;
    return {
      std: custom.std,
      destination: (custom.destination || '').toUpperCase(),
      city: custom.city,
      country: custom.country,
      nationality: custom.nationality,
      // flights_custom has no terminal column; the client's flights.json cache
      // and airline-code map fill that in.
      terminal: null,
      source: 'custom',
    };
  }
  const base = timetableJson[flightNumber];
  if (!base) return null;
  return {
    std: base.std,
    destination: (base.destination || '').toUpperCase(),
    city: base.city,
    country: base.country,
    nationality: base.nationality,
    terminal: base.terminal || null,
    source: 'timetable',
  };
}

/**
 * @param {string} rawNumber   what the user typed
 * @param {'past'|'future'} direction  which occurrence of the recurring time
 */
async function resolveFlight(rawNumber, direction = 'past') {
  const flightNumber = normalizeFlightNumber(rawNumber);
  if (!flightNumber) return null;

  const entry = await timetableEntry(flightNumber);
  if (!entry) return null;

  const date = resolveTimetableDate(entry.std, direction);
  const dest = destinationFacts(entry.destination);

  return {
    flight_number: flightNumber,
    source:        entry.source,
    date,
    std:           entry.std,
    datetime:      date && entry.std ? `${date}T${entry.std}` : null,
    destination:   entry.destination,
    // The airport table wins; the row's own values are the fallback for an
    // airport it does not list.
    city:          dest.city || entry.city || '',
    country:       dest.country || entry.country || '',
    nationality:   dest.nationality || entry.nationality || '',
    terminal:      entry.terminal,
  };
}

module.exports = {
  resolveFlight,
  resolveTimetableDate,
  destinationFacts,
  normalizeFlightNumber,
  jeddahNow,
  JEDDAH_OFFSET_MS,
  DEPARTURE_GRACE_MS,
};
