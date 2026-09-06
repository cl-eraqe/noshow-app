const express = require('express');
const router  = express.Router();
const flights = require('../flights.json');
const { getDb, jeddahNowStr, logAudit } = require('../db');
const { requireRole } = require('../middleware/auth');
const { normalizeFlightNumber } = require('../kaia');
const { resolveFlight } = require('../flight-lookup');

// GET /api/flights/terminals — { flightNumber: terminal } map sourced from flights.json
router.get('/terminals', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows: customs } = await pool.query('SELECT flight_number, deleted FROM flights_custom');
    const deletedSet = new Set(customs.filter(c => c.deleted).map(c => c.flight_number));
    const map = {};
    for (const k of Object.keys(flights)) {
      if (!deletedSet.has(k)) map[k] = flights[k].terminal;
    }
    res.json(map);
  } catch (e) {
    console.error('[GET /flights/terminals]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/flights/custom/list — must be before /:flightNumber
router.get('/custom/list', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM flights_custom ORDER BY flight_number ASC');
    const enriched = rows.map(r => ({ ...r, isOverride: !!flights[r.flight_number] }));
    res.json(enriched);
  } catch (e) {
    console.error('[GET /flights/custom/list]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/flights — all known flight numbers
router.get('/', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows: customs } = await pool.query('SELECT * FROM flights_custom');
    const customMap = {};
    customs.forEach(c => { customMap[c.flight_number] = c; });
    const jsonKeys = Object.keys(flights).filter(k => !customMap[k]?.deleted);
    const customAdditions = customs.filter(c => !c.deleted && !flights[c.flight_number]).map(c => c.flight_number);
    res.json([...jsonKeys, ...customAdditions].sort());
  } catch (e) {
    console.error('[GET /flights]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Airline review queue (supervisor only) — must precede /:flightNumber ──
// KAIA's own airline names are never used directly: a spelling it does not
// share with us would split one airline into two bars in analytics and break
// its logo lookup. A new IATA code waits here until a supervisor names it.

router.get('/airlines/pending', requireRole('supervisor'), async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(
      `SELECT code, kaia_name, seen_count, samples, first_seen
         FROM airlines WHERE status = 'pending' ORDER BY seen_count DESC, code`
    );
    res.json(rows.map(r => ({ ...r, samples: safeParse(r.samples) })));
  } catch (e) {
    console.error('[GET /flights/airlines/pending]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/flights/airlines/:code — { name, status:'ignored', backfill }
router.patch('/airlines/:code', requireRole('supervisor'), express.json(), async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ error: 'code required' });
    const { name, status, backfill } = req.body || {};
    const pool = getDb();

    if (status === 'ignored') {
      await pool.query(`UPDATE airlines SET status = 'ignored', updated_at = $1 WHERE code = $2`,
        [jeddahNowStr(), code]);
      return res.json({ success: true, code, status: 'ignored' });
    }

    const finalName = String(name || '').trim();
    if (!finalName) return res.status(400).json({ error: 'name required to approve' });

    await pool.query(
      `UPDATE airlines SET name = $1, status = 'approved', updated_at = $2 WHERE code = $3`,
      [finalName, jeddahNowStr(), code]
    );

    // Optional: fill the airline in on reports saved while the code was still
    // unknown, which therefore have an empty airline.
    let backfilled = 0;
    if (backfill) {
      const like = `${code}%`;
      const r1 = await pool.query(
        `UPDATE reports SET prev_airline = $1
          WHERE (prev_airline IS NULL OR prev_airline = '') AND upper(prev_flight) LIKE $2`, [finalName, like]);
      const r2 = await pool.query(
        `UPDATE reports SET new_airline = $1
          WHERE (new_airline IS NULL OR new_airline = '') AND upper(new_flight) LIKE $2`, [finalName, like]);
      backfilled = (r1.rowCount || 0) + (r2.rowCount || 0);
    }

    await logAudit({
      user: req.username || req.role, action: 'airline_approve',
      changes: JSON.stringify({ code, name: finalName, backfilled }),
    });
    res.json({ success: true, code, name: finalName, backfilled });
  } catch (e) {
    console.error('[PATCH /flights/airlines/:code]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/flights/kaia/status — when the local copy was last refreshed
router.get('/kaia/status', async (_req, res) => {
  try {
    const pool = getDb();
    const [{ rows: log }, { rows: cnt }] = await Promise.all([
      pool.query(`SELECT started_at, finished_at, ok, days_ok, days_failed, rows_synced
                    FROM kaia_sync_log ORDER BY id DESC LIMIT 1`),
      pool.query(`SELECT count(*)::int AS n FROM kaia_flights`),
    ]);
    res.json({ last: log[0] || null, flights: cnt[0]?.n || 0 });
  } catch (e) {
    console.error('[GET /flights/kaia/status]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function safeParse(s) {
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

// GET /api/flights/:flightNumber[?direction=past|future][&on=YYYY-MM-DD]
//
// Answers from KAIA's local copy when it holds the flight, and falls through
// to the timetable otherwise. Every field the old contract returned is still
// present, so a caller that ignores the new ones behaves exactly as before.
router.get('/:flightNumber', async (req, res) => {
  try {
    const key = normalizeFlightNumber(req.params.flightNumber);
    const direction = req.query.direction === 'future' ? 'future' : 'past';
    const on = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.on || '')) ? req.query.on : null;

    const hit = await resolveFlight(key, direction, on);
    if (!hit) return res.status(404).json({ error: `Flight ${key} not found` });
    res.json(hit);
  } catch (e) {
    console.error('[GET /flights/:flightNumber]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/flights — add or update a flight (supervisor only)
router.post('/', requireRole('supervisor'), express.json(), async (req, res) => {
  try {
    const { flight_number, destination, std, city, country, nationality } = req.body;
    if (!flight_number) return res.status(400).json({ error: 'flight_number required' });
    const key = flight_number.toUpperCase().trim();
    const pool = getDb();
    await pool.query(
      `INSERT INTO flights_custom (flight_number, destination, std, city, country, nationality, deleted, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
       ON CONFLICT (flight_number) DO UPDATE SET
         destination = EXCLUDED.destination, std = EXCLUDED.std, city = EXCLUDED.city,
         country = EXCLUDED.country, nationality = EXCLUDED.nationality,
         deleted = 0, updated_at = EXCLUDED.updated_at`,
      [key, destination || '', std || '', city || '', country || '', nationality || '', jeddahNowStr()]
    );
    res.json({ success: true, flight_number: key });
  } catch (e) {
    console.error('[POST /flights]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/flights/:flightNumber — soft-delete (supervisor only)
router.delete('/:flightNumber', requireRole('supervisor'), async (req, res) => {
  try {
    const key = req.params.flightNumber.toUpperCase().trim();
    const pool = getDb();
    await pool.query(
      `INSERT INTO flights_custom (flight_number, deleted, updated_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (flight_number) DO UPDATE SET deleted = 1, updated_at = EXCLUDED.updated_at`,
      [key, jeddahNowStr()]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /flights/:flightNumber]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
