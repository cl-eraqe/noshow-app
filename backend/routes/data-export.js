// Data for the supervisor's Excel downloads (the /data-export page): every
// case, one row each, and the edit log of the last days, one row per changed
// field. The browser turns these rows into .xlsx files.
const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { requireRole } = require('../middleware/auth');
const { getTerminal } = require('./_terminal-helper');
const airports = require('../airports.json');

router.use(requireRole('supervisor'));

const TERMINAL_NAMES = { T1: 'Terminal 1', North: 'North Terminal', Hajj: 'Hajj Terminal', T4: 'Terminal 4' };
const STATUS = { under_process: 'Under process', flight_confirmed: 'Flight confirmed', closed: 'Closed' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86400000;

// Stored times are Jeddah wall-clock text: "2026-10-04T09:30" or "2026-10-04 09:30:00".
const ms = s => s ? Date.parse(String(s).replace(' ', 'T').slice(0, 16) + ':00+03:00') : NaN;
const datePart = s => s ? String(s).slice(0, 10) : '';
const timePart = s => s ? String(s).replace(' ', 'T').slice(11, 16) : '';
const hoursBetween = (a, b) => {
  const d = ms(b) - ms(a);
  return Number.isFinite(d) && d >= 0 ? Math.round(d / 36e5 * 10) / 10 : null;
};
// Shifts by the hour the missed flight was due to leave: A 06–14, B 14–22, C 22–06.
function shiftOf(dt) {
  const h = parseInt(timePart(dt).slice(0, 2), 10);
  if (Number.isNaN(h)) return '';
  return h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'C';
}
function weekdayOf(dt) {
  const d = datePart(dt);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()] : '';
}
// "Cairo (CAI)" → Egypt
function countryOf(dest) {
  const code = String(dest || '').match(/\(([A-Z]{3})\)/)?.[1];
  return (code && airports[code]?.country) || '';
}
const terminalOf = flight => flight ? (TERMINAL_NAMES[getTerminal(flight)] || '') : '';
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// GET /api/data-export/cases[?from=YYYY-MM-DD&to=YYYY-MM-DD] — by registration date
router.get('/cases', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = [], params = [];
    if (isDate(from)) { params.push(from); where.push(`LEFT(r.created_at, 10) >= $${params.length}`); }
    if (isDate(to))   { params.push(to);   where.push(`LEFT(r.created_at, 10) <= $${params.length}`); }
    // Who registered it: the edit log's "create" entry carries the signed-in
    // user from the session; submitted_by is what the phone sent, kept as the
    // fallback for cases older than the log.
    const { rows } = await getDb().query(
      `SELECT r.*, (SELECT a."user" FROM audit_log a WHERE a.report_id = r.id AND a.action = 'create'
                    ORDER BY a.id LIMIT 1) AS created_by_log
         FROM reports r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.created_at ASC, r.id ASC`, params);
    res.json(rows.map(r => ({
      id: r.id,
      registered_by: r.created_by_log || r.submitted_by || '',
      registered_at: r.created_at,
      pax_identified_at: r.pax_id_datetime,
      prev_flight: r.prev_flight || '',
      prev_date: datePart(r.prev_datetime),
      prev_time: timePart(r.prev_datetime),
      prev_destination: r.prev_destination || '',
      prev_country: countryOf(r.prev_destination),
      prev_airline: r.prev_airline || '',
      prev_terminal: terminalOf(r.prev_flight),
      nationality: r.nationality || '',
      pax_type: r.pax_type || '',
      pax_count: r.pax_count ?? null,
      new_flight: r.new_flight || '',
      new_date: datePart(r.new_datetime),
      new_time: timePart(r.new_datetime),
      new_destination: r.new_destination || '',
      new_airline: r.new_airline || '',
      new_terminal: terminalOf(r.new_flight),
      status: STATUS[r.status] || r.status || '',
      confirmed_by: r.confirmed_by || '',
      confirmed_at: r.confirmed_at || '',
      closed_at: r.closed_at || '',
      comment: r.comment || '',
      shift: shiftOf(r.prev_datetime),
      weekday: weekdayOf(r.prev_datetime),
      hours_to_confirm: hoursBetween(r.created_at, r.confirmed_at),
      hours_to_close: hoursBetween(r.created_at, r.closed_at),
      days_at_airport: r.days_at_airport ?? null,
    })));
  } catch (e) {
    console.error('[GET /data-export/cases]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const FIELD_NAMES = {
  pax_id_datetime: 'Pax identified at', prev_flight: 'Previous flight', prev_datetime: 'Previous flight date/time',
  prev_destination: 'Previous destination', prev_airline: 'Previous airline', nationality: 'Nationality',
  pax_type: 'Passenger type', pax_count: 'Number of passengers', new_flight: 'New flight',
  new_datetime: 'New flight date/time', new_destination: 'New destination', new_airline: 'New airline',
  status: 'Status', comment: 'Comment', nusuk_received: 'Nusuk received',
};
const ACTIONS = {
  create: 'Created', edit: 'Edited', confirm_flight: 'Flight confirmed', close: 'Closed', reopen: 'Reopened',
  delete: 'Deleted', attach_files: 'Files attached', delete_attachment: 'File removed',
  nusuk_confirm: 'Nusuk confirmed', nusuk_unconfirm: 'Nusuk unconfirmed', auto_close: 'Closed automatically',
};
const show = (field, v) => v == null || v === '' ? '' : field === 'status' ? (STATUS[v] || String(v)) : String(v);

// GET /api/data-export/edits[?days=10] — one row per changed field
router.get('/edits', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 10, 1), 90);
    const since = new Date(Date.now() + 3 * 36e5 - days * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
    const { rows } = await getDb().query(
      `SELECT a.*, r.prev_flight AS case_flight
         FROM audit_log a LEFT JOIN reports r ON r.id = a.report_id
        WHERE a.ts >= $1 ORDER BY a.id ASC`, [since]);
    const out = [];
    for (const a of rows) {
      let changes = null, snapshot = null;
      try { changes = a.changes ? JSON.parse(a.changes) : null; } catch { /* unreadable: no detail */ }
      try { snapshot = a.snapshot ? JSON.parse(a.snapshot) : null; } catch { /* idem */ }
      const base = {
        time: a.ts, user: a.user || '', action: ACTIONS[a.action] || a.action,
        case_id: a.report_id, flight: a.case_flight || snapshot?.prev_flight || '',
      };
      const fields = changes && typeof changes === 'object'
        ? Object.entries(changes).filter(([k, v]) => FIELD_NAMES[k] && v && typeof v === 'object' && ('from' in v || 'to' in v))
        : [];
      if (fields.length) {
        for (const [k, v] of fields) out.push({ ...base, field: FIELD_NAMES[k], from: show(k, v.from), to: show(k, v.to) });
      } else {
        const note = a.action === 'delete_attachment' && changes?.removed ? String(changes.removed)
          : a.action === 'attach_files' && changes?.file_paths?.added ? `${changes.file_paths.added.length} file(s)` : '';
        out.push({ ...base, field: '', from: '', to: note });
      }
    }
    res.json({ since, rows: out });
  } catch (e) {
    console.error('[GET /data-export/edits]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
