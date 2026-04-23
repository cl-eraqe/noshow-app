const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../db');

// ── Token validation middleware ──
function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-export-token'];
  if (!token) return res.status(401).json({ error: 'Token required' });
  const db = getDb();
  const row = db.prepare('SELECT * FROM export_tokens WHERE token = ? AND revoked = 0').get(token);
  if (!row) return res.status(403).json({ error: 'Invalid or revoked token' });
  // Update last_used
  db.prepare('UPDATE export_tokens SET last_used = datetime(\'now\') WHERE id = ?').run(row.id);
  req.exportUser = row;
  next();
}

// ── Generate a secure random token ──
function genToken() {
  return crypto.randomBytes(24).toString('base64url'); // ~32 chars URL-safe
}

// ── Supervisor-only token management ──
// Note: we rely on client-side 'supervisor' role for now — same pattern as analytics
router.get('/tokens', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, email, role, created_at, last_used, revoked FROM export_tokens ORDER BY created_at DESC').all();
  res.json(rows);
});

router.post('/tokens', express.json(), (req, res) => {
  const { email, role } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const db = getDb();
  const token = genToken();
  const result = db.prepare(`
    INSERT INTO export_tokens (email, token, role) VALUES (?, ?, ?)
  `).run(email.trim().toLowerCase(), token, role || 'view');
  const row = db.prepare('SELECT * FROM export_tokens WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...row, token }); // full token only returned at creation
});

router.patch('/tokens/:id', express.json(), (req, res) => {
  const db = getDb();
  const { revoked } = req.body;
  if (revoked !== undefined) {
    db.prepare('UPDATE export_tokens SET revoked = ? WHERE id = ?').run(revoked ? 1 : 0, req.params.id);
  }
  const row = db.prepare('SELECT * FROM export_tokens WHERE id = ?').get(req.params.id);
  res.json(row);
});

router.delete('/tokens/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM export_tokens WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/tokens/:id/rotate', (req, res) => {
  const db = getDb();
  const newToken = genToken();
  db.prepare('UPDATE export_tokens SET token = ?, revoked = 0 WHERE id = ?').run(newToken, req.params.id);
  const row = db.prepare('SELECT * FROM export_tokens WHERE id = ?').get(req.params.id);
  res.json({ ...row, token: newToken });
});

// ── Public endpoints (token-protected) — Excel "From Web" consumes these ──

// Live state: current reports, one row each, flattened
router.get('/live-state', requireToken, (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM reports ORDER BY created_at DESC`).all();
  res.json(rows.map(r => ({
    id: r.id,
    status: r.status,
    created_at: r.created_at,
    confirmed_at: r.confirmed_at,
    closed_at: r.closed_at,
    pax_id_datetime: r.pax_id_datetime,
    prev_flight: r.prev_flight,
    prev_datetime: r.prev_datetime,
    prev_destination: r.prev_destination,
    prev_airline: r.prev_airline,
    nationality: r.nationality,
    pax_type: r.pax_type,
    pax_count: r.pax_count,
    new_flight: r.new_flight,
    new_datetime: r.new_datetime,
    new_destination: r.new_destination,
    new_airline: r.new_airline,
    days_at_airport: r.days_at_airport,
    comment: r.comment,
    submitted_by: r.submitted_by,
  })));
});

// Audit log, newest first
router.get('/audit-log', requireToken, (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 5000;
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows.map(r => ({
    id: r.id,
    timestamp: r.ts,
    user: r.user,
    action: r.action,
    report_id: r.report_id,
    changes: r.changes,  // keep as JSON string — Excel will show raw text
    snapshot: r.snapshot, // same
  })));
});

// Health/info endpoint to verify token works
router.get('/ping', requireToken, (req, res) => {
  res.json({ ok: true, email: req.exportUser.email, role: req.exportUser.role });
});

module.exports = router;
