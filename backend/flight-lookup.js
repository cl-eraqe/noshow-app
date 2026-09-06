// Merged flight lookup.
//
// Three sources, each answering only what it is authoritative for:
//
//   KAIA          → codes and timing (the only source carrying a real date)
//   airports.json → everything about the destination: city, country, nationality
//   airlines table→ airline names
//
// No name from KAIA ever reaches a report. Analytics groups by the airline
// name and the nationality string, so a name KAIA spells differently would
// split one airline into two bars and break its logo lookup. KAIA supplies the
// IATA code; our tables supply what the code means.

const { getDb } = require('./db');
const kaia = require('./kaia');
const airports = require('./airports.json');
const timetableJson = require('./flights.json');

const DEPARTURE_GRACE_MS = 30 * 60 * 1000;   // gate close: when a no-show is identified
const DAY_MS = 86400000;

// ── Time helpers ──────────────────────────────────────────────────────────

const pad2 = n => String(n).padStart(2, '0');

// "YYYY-MM-DD" + "HH:MM" as Jeddah wall-clock → epoch ms.
function jeddahMs(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) return NaN;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) - kaia.JEDDAH_OFFSET_MS;
}

// The occurrence of a recurring time that matches how the field is used.
// 'past' honours the same 30-minute gate-close grace as the departed check, so
// a case opened just before STD still resolves to today rather than yesterday.
function resolveTimetableDate(time, direction) {
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!t) return null;
  const h = +t[1], min = +t[2];
  if (h > 23 || min > 59) return null;

  const nowJed = kaia.jeddahNow();
  const stdMs = Date.UTC(nowJed.getUTCFullYear(), nowJed.getUTCMonth(), nowJed.getUTCDate(), h, min);

  let shift = 0;
  if (direction === 'past'   && stdMs - DEPARTURE_GRACE_MS > nowJed.getTime()) shift = -1;
  if (direction === 'future' && stdMs <= nowJed.getTime())                     shift = +1;

  const d = new Date(stdMs + shift * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ── Enrichment: the parts that never come from KAIA ───────────────────────

function destinationFacts(code) {
  const a = airports[String(code || '').toUpperCase()];
  return a
    ? { city: a.city, country: a.country, nationality: a.nationality }
    : { city: '', country: '', nationality: '' };
}

async function airlineName(code) {
  if (!code) return '';
  const pool = getDb();
  const { rows } = await pool.query(
    `SELECT name, status FROM airlines WHERE code = $1`, [String(code).toUpperCase()]
  );
  // An unapproved code contributes nothing: the field stays empty exactly as
  // it does today, rather than letting an unreviewed name into analytics.
  return rows[0]?.status === 'approved' ? (rows[0].name || '') : '';
}

async function terminalFromCode(raw) {
  if (!raw) return null;
  const pool = getDb();
  const { rows } = await pool.query(
    `SELECT terminal FROM terminal_codes WHERE code = $1`, [String(raw).trim().toUpperCase()]
  );
  // An unrecognised code is never guessed at — the caller falls through to the
  // existing airline-prefix chain, and the raw value is kept for review.
  return rows[0]?.terminal || null;
}

// ── The timetable (unchanged behaviour, now on the server) ────────────────

async function timetableEntry(flightNumber) {
  const pool = getDb();
  const { rows } = await pool.query(
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
    source: 'json',
  };
}

// ── KAIA occurrences ──────────────────────────────────────────────────────

async function kaiaOccurrences(flightNumber) {
  const pool = getDb();
  const { rows } = await pool.query(
    `SELECT * FROM kaia_flights WHERE flight_number = $1 ORDER BY date, scheduled_time`,
    [flightNumber]
  );
  return rows;
}

// Pick the occurrence the field means. Comparisons are absolute instants with
// an explicit +03:00 — never naive strings, and never the server's own
// timezone, which on Railway is UTC.
function pickOccurrence(rows, direction, on) {
  if (!rows.length) return null;

  if (on) return rows.filter(r => r.date === on).sort(
    (a, b) => jeddahMs(a.date, a.scheduled_time) - jeddahMs(b.date, b.scheduled_time)
  )[0] || null;

  const now = Date.now();
  const withMs = rows
    .map(r => ({ r, ms: jeddahMs(r.date, r.scheduled_time) }))
    .filter(x => !isNaN(x.ms));

  if (direction === 'future') {
    const ahead = withMs.filter(x => x.ms > now).sort((a, b) => a.ms - b.ms);
    return ahead[0]?.r || null;
  }
  // 'past' — the most recent departure already gone, gate-close grace included
  const behind = withMs.filter(x => x.ms - DEPARTURE_GRACE_MS <= now).sort((a, b) => b.ms - a.ms);
  return behind[0]?.r || null;
}

// ── The public resolver ───────────────────────────────────────────────────

/**
 * @param {string} rawNumber   what the user typed
 * @param {'past'|'future'} direction
 * @param {string} [on]        a specific YYYY-MM-DD, when the user edits the date
 */
async function resolveFlight(rawNumber, direction = 'past', on = null) {
  const flightNumber = kaia.normalizeFlightNumber(rawNumber);
  if (!flightNumber) return null;

  const occurrences = await kaiaOccurrences(flightNumber);
  const hit = pickOccurrence(occurrences, direction, on);
  const inWindow = on ? kaia.windowDates().includes(on) : true;

  if (hit) {
    const dest = destinationFacts(hit.destination_code);
    const mapped = await terminalFromCode(hit.terminal_raw);
    const fallback = await timetableEntry(flightNumber);
    return {
      flight_number:   flightNumber,
      source:          'kaia',
      date:            hit.date,
      std:             hit.scheduled_time,
      datetime:        `${hit.date}T${hit.scheduled_time}`,
      estimated:       hit.estimated_time || null,
      gate:            hit.gate || null,
      destination:     hit.destination_code || '',
      // City from our own table, not KAIA's, so the display name is stable.
      city:            dest.city || hit.destination_city || '',
      country:         dest.country,
      nationality:     dest.nationality,
      airline_code:    hit.airline_code || '',
      airline:         await airlineName(hit.airline_code),
      terminal:        mapped || fallback?.terminal || null,
      terminal_raw:    hit.terminal_raw || null,
      operated:        true,
    };
  }

  // No KAIA record. Fall through to the timetable — silently, because outside
  // the -6..+2 window a miss says nothing about whether the flight exists.
  const entry = await timetableEntry(flightNumber);
  if (!entry) return null;

  const date = on || resolveTimetableDate(entry.std, direction);
  const dest = destinationFacts(entry.destination);
  const code = flightNumber.slice(0, 2);

  return {
    flight_number: flightNumber,
    source:        entry.source === 'custom' ? 'custom' : 'timetable',
    date,
    std:           entry.std,
    datetime:      date && entry.std ? `${date}T${entry.std}` : null,
    estimated:     null,
    gate:          null,
    destination:   entry.destination,
    city:          dest.city || entry.city || '',
    country:       dest.country || entry.country || '',
    nationality:   dest.nationality || entry.nationality || '',
    airline_code:  code,
    airline:       await airlineName(code),
    terminal:      entry.terminal,
    terminal_raw:  null,
    // Inside the window KAIA is complete, so an absent record means the flight
    // genuinely did not operate that day — worth telling the user. Outside it,
    // absence means nothing and this stays null.
    operated:      on && inWindow && occurrences.length ? false : null,
  };
}

module.exports = {
  resolveFlight,
  resolveTimetableDate,
  pickOccurrence,
  destinationFacts,
  jeddahMs,
  DEPARTURE_GRACE_MS,
};
