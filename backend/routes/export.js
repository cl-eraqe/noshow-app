const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb, jeddahNowStr } = require('../db');

async function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-export-token'];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM export_tokens WHERE token = $1 AND revoked = 0', [token]);
    if (!rows[0]) return res.status(403).json({ error: 'Invalid or revoked token' });
    await pool.query('UPDATE export_tokens SET last_used = $1 WHERE id = $2', [jeddahNowStr(), rows[0].id]);
    req.exportUser = rows[0];
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function genToken() {
  return crypto.randomBytes(24).toString('base64url');
}

router.get('/tokens', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT id, email, role, created_at, last_used, revoked FROM export_tokens ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tokens', express.json(), async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const pool = getDb();
    const token = genToken();
    const { rows } = await pool.query(
      `INSERT INTO export_tokens (email, token, role) VALUES ($1, $2, $3) RETURNING *`,
      [email.trim().toLowerCase(), token, role || 'view']
    );
    res.json({ ...rows[0], token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/tokens/:id', express.json(), async (req, res) => {
  try {
    const pool = getDb();
    const { revoked } = req.body;
    if (revoked !== undefined) {
      await pool.query('UPDATE export_tokens SET revoked = $1 WHERE id = $2', [revoked ? 1 : 0, req.params.id]);
    }
    const { rows } = await pool.query('SELECT * FROM export_tokens WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tokens/:id', async (req, res) => {
  try {
    const pool = getDb();
    await pool.query('DELETE FROM export_tokens WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tokens/:id/rotate', async (req, res) => {
  try {
    const pool = getDb();
    const newToken = genToken();
    await pool.query('UPDATE export_tokens SET token = $1, revoked = 0 WHERE id = $2', [newToken, req.params.id]);
    const { rows } = await pool.query('SELECT * FROM export_tokens WHERE id = $1', [req.params.id]);
    res.json({ ...rows[0], token: newToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/live-state', requireToken, async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports ORDER BY created_at DESC');
    res.json(rows.map(r => ({
      id: r.id, status: r.status, created_at: r.created_at, confirmed_at: r.confirmed_at,
      closed_at: r.closed_at, pax_id_datetime: r.pax_id_datetime, prev_flight: r.prev_flight,
      prev_datetime: r.prev_datetime, prev_destination: r.prev_destination, prev_airline: r.prev_airline,
      nationality: r.nationality, pax_type: r.pax_type, pax_count: r.pax_count,
      new_flight: r.new_flight, new_datetime: r.new_datetime, new_destination: r.new_destination,
      new_airline: r.new_airline, days_at_airport: r.days_at_airport, comment: r.comment,
      submitted_by: r.submitted_by,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/audit-log', requireToken, async (req, res) => {
  try {
    const pool = getDb();
    const limit = parseInt(req.query.limit) || 5000;
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    res.json(rows.map(r => ({
      id: r.id, timestamp: r.ts, user: r.user, action: r.action,
      report_id: r.report_id, changes: r.changes, snapshot: r.snapshot,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ping', requireToken, (req, res) => {
  res.json({ ok: true, email: req.exportUser.email, role: req.exportUser.role });
});

module.exports = router;
