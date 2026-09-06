// KAIA live flight schedule.
//
// https://www.kaia.sa/ext-api/flightsearch/flights is Jeddah airport's public
// OData endpoint — no key, no token, no auth header. It is pulled once a day
// and cached locally; nothing here runs while a user is typing.
//
// Note the query parameter is `filter`, not the OData-standard `$filter`.
// The rest ($top, $skip, $count, $orderby) do take the `$` prefix.

const BASE = 'https://www.kaia.sa/ext-api/flightsearch/flights';

// Jeddah is UTC+3 year-round (no DST).
const JEDDAH_OFFSET_MS = 3 * 60 * 60 * 1000;

// KAIA caps $top at 100 and a Jeddah day is ~390 international departures, so
// a day is always several pages. Fetching one page silently returns a partial
// day with no error, which is why @odata.count is read and paged on.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;          // hard stop; a day never needs this many

const REQUEST_TIMEOUT_MS = 20000;
const RETRIES_PER_PAGE = 2;

// The window KAIA actually serves, measured against the live API:
//   -8 and older → 0 rows (nothing retained)
//   -7           → full, but the window rolls, so a date answering now can be
//                  empty an hour later. -6 is the dependable floor.
//   +1, +2       → full
//   +3           → ~38 rows carrying a LastUpdateTime from months earlier and
//                  no gates: leftovers of a seasonal schedule, not the real
//                  operational one, which KAIA loads about two days out.
//                  Worse than nothing, so it is excluded.
const DAYS_BACK = 6;
const DAYS_FORWARD = 2;

// ── Helpers ───────────────────────────────────────────────────────────────

// Users type SV309, sv 309, SV0309; KAIA returns 3T0203. Normalize both sides
// before comparing.
//
// The {2} is exact on purpose. Widening it to {2,3} lets 0* swallow a real
// zero inside the number and turns SV309 into SV39.
function normalizeFlightNumber(input) {
  if (!input) return '';
  const clean = String(input).toUpperCase().replace(/\s+/g, '');
  const m = clean.match(/^([A-Z\d]{2})0*(\d+)$/);   // IATA carrier code is 2 chars
  return m ? m[1] + m[2] : clean;
}

// A Date whose UTC fields read as Jeddah wall-clock.
function jeddahNow() {
  return new Date(Date.now() + JEDDAH_OFFSET_MS);
}

// Today's date in Jeddah as YYYY-MM-DD. Deliberately not toISOString() on a
// plain `new Date()`: that is UTC, and between 00:00 and 03:00 Jeddah it
// yields yesterday.
function jeddahToday() {
  return jeddahNow().toISOString().slice(0, 10);
}

// Every date in the sync window, oldest first.
function windowDates(today = jeddahToday()) {
  const base = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (let d = -DAYS_BACK; d <= DAYS_FORWARD; d++) {
    out.push(new Date(base + d * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

// "2026-08-30T10:30:00+03:00" → { date: "2026-08-30", time: "10:30" }, read
// off the string so the Jeddah wall-clock survives whatever timezone the
// server runs in.
function splitJeddahStamp(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(stamp || '').trim());
  return m ? { date: m[1], time: `${m[2]}:${m[3]}` } : null;
}

function gateOf(flight) {
  const g = (flight.Resources || []).find(r => r.ResourceType === 'GATE');
  // Gate is routinely absent for future flights — KAIA assigns it close to
  // departure — so an empty gate is normal, not a failure.
  return g ? (g.Identifier || g.Code || '') : '';
}

// ── Fetching ──────────────────────────────────────────────────────────────

function dayFilter(date) {
  return [
    // Filter on STODateTime, not EarlyOrDelayedDateTime: a flight scheduled
    // 23:40 that departs 00:30 would otherwise land on the next day and vanish
    // from the day it was scheduled for. The whole model is built on scheduled
    // time, so the day must be defined by the schedule.
    `(STODateTime ge ${date}T00:00:00.000+03:00 and STODateTime lt ${date}T23:59:59.999+03:00)`,
    `PublicRemark/Code ne 'NOP'`,
    `tolower(FlightNature) eq 'departure'`,
    `InternationalStatus eq 'INTERNATIONAL'`,
  ].join(' and ');
}

async function fetchPage(date, skip) {
  const params = new URLSearchParams({
    filter: dayFilter(date),
    $orderby: 'STODateTime',
    $top: String(PAGE_SIZE),
    $skip: String(skip),
    $count: 'true',
  });

  let lastErr;
  for (let attempt = 0; attempt <= RETRIES_PER_PAGE; attempt++) {
    const ctl = AbortSignal.timeout
      ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      : {};
    try {
      const res = await fetch(`${BASE}?${params}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'noshow-app/1.0' },
        ...ctl,
      });
      if (!res.ok) throw new Error(`KAIA HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES_PER_PAGE) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// All departures for one Jeddah date, paged to completion.
async function fetchDay(date) {
  const rows = [];
  let total = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchPage(date, page * PAGE_SIZE);
    if (total === null) total = Number(json['@odata.count']) || 0;
    const batch = json.value || [];
    rows.push(...batch);
    if (!batch.length || rows.length >= total) break;
  }

  return { total, rows };
}

// Shape one KAIA record into what the database stores. Returns null for a
// record we cannot key on.
function shapeFlight(raw, queriedDate) {
  const flightNumber = normalizeFlightNumber(raw.FullFlightNumber);
  if (!flightNumber) return null;

  const sto = splitJeddahStamp(raw.STODateTime);
  if (!sto) return null;

  const eta = splitJeddahStamp(raw.EarlyOrDelayedDateTime);

  return {
    flight_number:    flightNumber,
    // The day the schedule puts it on, which is what the filter selected. It
    // can differ from queriedDate only if KAIA returns something out of range.
    date:             sto.date || queriedDate,
    scheduled_time:   sto.time,
    estimated_time:   eta ? `${eta.date}T${eta.time}` : null,
    terminal_raw:     (raw.Terminal || '').trim() || null,
    gate:             gateOf(raw) || null,
    airline_code:     (raw.Airline?.IATA || '').trim().toUpperCase() || null,
    airline_name:     (raw.Airline?.Name || '').trim() || null,
    destination_code: (raw.RouteDestinationAirport?.IATA || '').trim().toUpperCase() || null,
    destination_city: (raw.RouteDestinationAirport?.City || '').trim() || null,
  };
}

module.exports = {
  BASE,
  JEDDAH_OFFSET_MS,
  DAYS_BACK,
  DAYS_FORWARD,
  PAGE_SIZE,
  normalizeFlightNumber,
  jeddahNow,
  jeddahToday,
  windowDates,
  splitJeddahStamp,
  gateOf,
  dayFilter,
  fetchDay,
  shapeFlight,
};
