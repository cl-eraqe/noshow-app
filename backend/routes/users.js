const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { requireRole } = require('../middleware/auth');
const { makeToken, validatePin } = require('./auth');
const bcrypt  = require('bcryptjs');

// All routes here are mounted under /api/users and already gated by requireAuth.

// ── List users (supervisor only) ──────────────────────────────────────────────
router.get('/', requireRole('supervisor'), async (req, res) => {
  try {
    const { getDb } = require('../db');
    const { rows } = await getDb().query(
      `SELECT id, name, role, owner_terminal, active, created_at FROM users ORDER BY created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    console.error('List users error:', err);
    return res.status(500).json({ error: 'Could not fetch users.' });
  }
});

// ── Assign / change a staff user's terminal (supervisor only) ─────────────────
// The supervisor account itself has no terminal (owner_terminal stays NULL) —
// reassigning it is rejected. Per the design, owner_terminal on already-
// created REPORTS is immutable; this only affects the USER's future reports.
router.patch('/:id/terminal', requireRole('supervisor'), async (req, res) => {
  const { terminal } = req.body;
  if (terminal !== 'T1' && terminal !== 'North') {
    return res.status(400).json({ error: 'terminal must be "T1" or "North".' });
  }
  try {
    const { getDb, logAudit } = require('../db');
    const db = getDb();
    const { rows: existing } = await db.query(
      `SELECT id, name, role, owner_terminal FROM users WHERE id = $1`, [req.params.id]
    );
    const target = existing[0];
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role === 'supervisor') {
      return res.status(400).json({ error: 'The supervisor account is not assigned to a single terminal.' });
    }
    if (target.owner_terminal === terminal) return res.json(target); // no-op

    const { rows } = await db.query(
      `UPDATE users SET owner_terminal = $1 WHERE id = $2 RETURNING id, name, role, owner_terminal, active`,
      [terminal, req.params.id]
    );
    await logAudit({
      user: req.username || req.role,
      action: 'user_terminal_change',
      changes: { user: target.name, owner_terminal: { from: target.owner_terminal, to: terminal } },
    });
    return res.json(rows[0]);
  } catch (err) {
    console.error('Assign terminal error:', err);
    return res.status(500).json({ error: 'Could not assign terminal.' });
  }
});

// ── Toggle active status (supervisor only) ────────────────────────────────────
router.patch('/:id/active', requireRole('supervisor'), async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be a boolean.' });
  try {
    const { getDb } = require('../db');
    const { rows } = await getDb().query(
      `UPDATE users SET active = $1 WHERE id = $2 RETURNING id, name, role, active`,
      [active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('Toggle active error:', err);
    return res.status(500).json({ error: 'Could not update user.' });
  }
});

// ── Delete a user permanently (supervisor only) ───────────────────────────────
// Reports keep their submitted_by name (plain TEXT, no foreign key), so past
// cases and their audit history survive the account being removed. Guarded so
// the supervisor can't lock themselves — or everyone — out.
router.delete('/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const { getDb, logAudit } = require('../db');
    const db = getDb();
    const { rows: existing } = await db.query(
      `SELECT id, name, role, owner_terminal, active, created_at FROM users WHERE id = $1`,
      [req.params.id]
    );
    const target = existing[0];
    if (!target) return res.status(404).json({ error: 'User not found.' });

    if (req.username && target.name.toLowerCase() === req.username.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    if (target.role === 'supervisor') {
      const { rows: sup } = await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'supervisor'`);
      if (sup[0].n <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only supervisor account.' });
      }
    }

    await db.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    await logAudit({
      user: req.username || req.role,
      action: 'user_delete',
      snapshot: {
        id: target.id, name: target.name, role: target.role,
        owner_terminal: target.owner_terminal, active: target.active,
        created_at: target.created_at,
      },
    });
    return res.json({ success: true, deleted: target.name });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ error: 'Could not delete user.' });
  }
});

// ── Reset a user's PIN (supervisor only) ──────────────────────────────────────
router.patch('/:id/pin', requireRole('supervisor'), async (req, res) => {
  const { pin } = req.body;
  const err = validatePin(String(pin || ''));
  if (err) return res.status(400).json({ error: err });
  try {
    const { getDb } = require('../db');
    const hash = await bcrypt.hash(String(pin), 12);
    const { rows } = await getDb().query(
      `UPDATE users SET pin_hash = $1 WHERE id = $2 RETURNING id, name, role, active`,
      [hash, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    return res.json({ success: true });
  } catch (err2) {
    console.error('Reset PIN error:', err2);
    return res.status(500).json({ error: 'Could not reset PIN.' });
  }
});

// ── Create invite link (supervisor only) ──────────────────────────────────────
// role=staff → 24h, role=supervisor → 6h. A staff invite must carry a terminal
// (T1 or North) — that's how a self-registered user's owner_terminal gets set,
// since the supervisor never creates their row directly. Supervisor invites
// don't take a terminal (stored NULL).
router.post('/invite', requireRole('supervisor'), async (req, res) => {
  const { role, terminal } = req.body;
  if (!['staff', 'supervisor'].includes(role)) {
    return res.status(400).json({ error: 'role must be staff or supervisor.' });
  }
  let ownerTerminal = null;
  if (role === 'staff') {
    if (terminal !== 'T1' && terminal !== 'North') {
      return res.status(400).json({ error: 'terminal is required for a staff invite — choose T1 or North.' });
    }
    ownerTerminal = terminal;
  }
  const hours     = role === 'supervisor' ? 6 : 24;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  const token     = crypto.randomBytes(32).toString('hex');
  const createdBy = req.username || 'supervisor';

  try {
    const { getDb } = require('../db');
    await getDb().query(
      `INSERT INTO invite_tokens (token, role, owner_terminal, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [token, role, ownerTerminal, createdBy, expiresAt.toISOString()]
    );
    return res.status(201).json({ token, role, ownerTerminal, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error('Create invite error:', err);
    return res.status(500).json({ error: 'Could not create invite.' });
  }
});

// ── List invite tokens (supervisor only) ──────────────────────────────────────
router.get('/invites', requireRole('supervisor'), async (req, res) => {
  try {
    const { getDb } = require('../db');
    const { rows } = await getDb().query(
      `SELECT id, token, role, owner_terminal, created_by, expires_at, used, created_at
       FROM invite_tokens ORDER BY created_at DESC LIMIT 50`
    );
    return res.json(rows);
  } catch (err) {
    console.error('List invites error:', err);
    return res.status(500).json({ error: 'Could not fetch invites.' });
  }
});

// ── Delete invite (supervisor only) ──────────────────────────────────────────
router.delete('/invites/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const { getDb } = require('../db');
    await getDb().query(`DELETE FROM invite_tokens WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete invite error:', err);
    return res.status(500).json({ error: 'Could not delete invite.' });
  }
});

module.exports = router;
