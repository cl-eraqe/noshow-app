// Days a passenger spent at the airport: from the missed flight's departure
// until the case was closed, or until now while it is still open.
//
// Always worked out from the case's dates when it is shown, never read from
// the stored days_at_airport column. That column used to be rewritten on
// every edit (edit moment − missed flight), so a case touched months after it
// closed showed ~100 days. The dashboard's live "Days" badge is the same
// count while the case is open.

const DAY_MS = 86400000;

// Stored times are Jeddah wall-clock text: "2026-10-04T09:30" or "2026-10-04 09:30:00".
function jeddahMs(s) {
  if (!s) return null;
  const ms = Date.parse(String(s).replace(' ', 'T').slice(0, 16) + ':00+03:00');
  return Number.isNaN(ms) ? null : ms;
}

function daysAtAirport(r, now = Date.now()) {
  const start = jeddahMs(r.prev_datetime);
  if (start == null) return null;
  const end = r.status === 'closed' ? jeddahMs(r.closed_at) : now;
  if (end == null) return null;
  return Math.round(Math.max(0, end - start) / DAY_MS * 100) / 100;
}

module.exports = { daysAtAirport };
