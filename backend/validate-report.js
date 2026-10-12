// Checks a case's dates and flight numbers before they are saved, so the
// impossible combinations seen in the data cannot be stored:
//   - pax identified in the future, or after the case was registered
//   - a flight number without an airline code ("000", "123")
//   - a new flight that leaves before, or at the same minute as, the missed one
//
// Each check runs only on the fields given, so a PATCH that only closes a case
// or changes the pax count is never blocked by an older mistake on the case.

const { normalizeFlightNumber } = require('./flight-lookup');

// Airline code (two characters, at least one a letter) + 1–4 digits: SV123, 6E92, C63318.
const FLIGHT_RE = /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}$/;
const SLACK_MS = 5 * 60 * 1000;   // device clocks drift a little

// Stored times are Jeddah wall-clock text: "2026-10-04T09:30" or "2026-10-04 09:30:00".
function jeddahMs(s) {
  if (!s) return null;
  const ms = Date.parse(String(s).replace(' ', 'T').slice(0, 16) + ':00+03:00');
  return Number.isNaN(ms) ? null : ms;
}
const show = s => String(s).replace('T', ' ').slice(0, 16);

// " sv 0309" -> "SV309"; empty stays empty, undefined stays undefined.
function cleanFlight(v) {
  return v === undefined || v === null ? v : normalizeFlightNumber(v);
}

// Returns the first problem as a message for the employee, or null.
function checkReport(f, { registeredAt, now = Date.now() } = {}) {
  const paxId = jeddahMs(f.pax_id_datetime);
  if (paxId != null && paxId > now + SLACK_MS) {
    return 'Pax identified time is in the future. Check the date and the time.';
  }
  const reg = jeddahMs(registeredAt);
  if (paxId != null && reg != null && paxId > reg + SLACK_MS) {
    return `Pax identified time is after the case was registered (${show(registeredAt)}). Check the date.`;
  }

  for (const [key, label] of [['prev_flight', 'Previous flight'], ['new_flight', 'New flight']]) {
    if (f[key] && !FLIGHT_RE.test(f[key])) {
      return `${label} "${f[key]}" is not a flight number: it needs the airline code and the number, e.g. SV123.`;
    }
  }

  const prev = jeddahMs(f.prev_datetime), next = jeddahMs(f.new_datetime);
  if (prev != null && next != null) {
    if (next === prev) {
      return 'The new flight has the same date and time as the missed flight. Check the new flight\'s date.';
    }
    if (next < prev) {
      return `The new flight (${show(f.new_datetime)}) leaves before the missed flight (${show(f.prev_datetime)}). ` +
        'If it leaves after midnight, set the next day.';
    }
  }
  return null;
}

module.exports = { checkReport, cleanFlight, FLIGHT_RE };
