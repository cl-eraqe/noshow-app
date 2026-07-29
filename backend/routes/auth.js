const express   = require('express');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

// Fail loudly at require-time if the secret is missing — no silent fallback.
if (!process.env.SESSION_SECRET) {
  throw new Error('FATAL: SESSION_SECRET environment variable is required but not set');
}
const SECRET = () => process.env.SESSION_SECRET;

const WINDOW_MS = 12 * 3600 * 1000; // 12-hour buckets

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Token format ─────────────────────────────────────────────────────────────
// role.ownerTerminal.b64name.window.sig  (5 parts) — every token is tied to a
// user account. ownerTerminal is 'T1' | 'North' | '' (empty = supervisor, who
// isn't scoped to a single terminal). This is a distinct concept from the
// flight-derived terminal (getTerminal/needsBus in _terminal-helper.js /
// utils/api.js), which is unaffected by this field.
//
// NOTE: this token format changed shape (was 4 parts). Deploying this drops
// every existing session — everyone must log in again. This is intentional
// and safe: old 4-part tokens simply fail verifyToken and redirect to /login.

function makeToken(role, ownerTerminal, username) {
  if (!username) throw new Error('makeToken requires a username');
  const term = ownerTerminal || '';
  const w    = Math.floor(Date.now() / WINDOW_MS);
  const b64  = Buffer.from(username).toString('base64');
  const sig  = crypto.createHmac('sha256', SECRET()).update(`${role}:${term}:${b64}:${w}`).digest('hex');
  return `${role}.${term}.${b64}.${w}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;

  const [role, term, b64name, win, sig] = parts;
  const now = Math.floor(Date.now() / WINDOW_MS);
  for (const w of [now, now - 1]) {
    const expected = crypto.createHmac('sha256', SECRET()).update(`${role}:${term}:${b64name}:${w}`).digest('hex');
    if (sig === expected && parseInt(win) === w) {
      const username = Buffer.from(b64name, 'base64').toString('utf8');
      return { role, ownerTerminal: term || null, username };
    }
  }
  return null;
}

// ── PIN validation helpers ────────────────────────────────────────────────────
const COMMON_PINS = new Set([
  '000000','111111','222222','333333','444444','555555','666666','777777','888888','999999',
  '123456','654321','012345','987654','112233','121212','123123','696969','159753','753951',
]);

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6,}$/.test(pin)) {
    return 'PIN must be at least 6 digits.';
  }
  if (COMMON_PINS.has(pin)) return 'PIN is too common. Choose a less predictable PIN.';
  // sequential ascending or descending run of 6+
  let asc = 1, desc = 1;
  for (let i = 1; i < pin.length; i++) {
    asc  = (pin.charCodeAt(i) - pin.charCodeAt(i - 1) === 1)  ? asc  + 1 : 1;
    desc = (pin.charCodeAt(i) - pin.charCodeAt(i - 1) === -1) ? desc + 1 : 1;
    if (asc >= 6 || desc >= 6) return 'PIN cannot be a sequential number sequence.';
  }
  if (new Set(pin.split('')).size === 1) return 'PIN cannot use all the same digit.';
  return null;
}

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { name, pin } = req.body;

  if (!name || !pin) {
    return res.status(400).json({ error: 'Name and PIN are required.' });
  }
  if (typeof name !== 'string' || !/^[A-Za-z ]{1,60}$/.test(name.trim())) {
    return res.status(400).json({ error: 'Name must be English letters only.' });
  }

  try {
    const { getDb } = require('../db');
    const db = getDb();
    const { rows } = await db.query(
      `SELECT id, name, role, owner_terminal, pin_hash, active FROM users WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [name.trim()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid name or PIN.' });
    if (!user.active) return res.status(403).json({ error: 'Account is deactivated. Contact your supervisor.' });

    const ok = await bcrypt.compare(String(pin), user.pin_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid name or PIN.' });

    const token = makeToken(user.role, user.owner_terminal, user.name);
    return res.json({ role: user.role, ownerTerminal: user.owner_terminal || null, username: user.name, token });
  } catch (err) {
    console.error('DB login error:', err);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── Register via invite ───────────────────────────────────────────────────────
router.post('/register', loginLimiter, async (req, res) => {
  const { token: inviteToken, name, pin } = req.body;
  if (!inviteToken || !name || !pin) {
    return res.status(400).json({ error: 'Invite token, name, and PIN are required.' });
  }
  if (typeof name !== 'string' || !/^[A-Za-z ]{1,60}$/.test(name.trim())) {
    return res.status(400).json({ error: 'Name must be English letters only (max 60 chars).' });
  }
  const pinErr = validatePin(String(pin));
  if (pinErr) return res.status(400).json({ error: pinErr });

  try {
    const { getDb } = require('../db');
    const db = getDb();

    const { rows: irows } = await db.query(
      `SELECT id, role, owner_terminal, expires_at, used FROM invite_tokens WHERE token = $1 LIMIT 1`,
      [inviteToken]
    );
    const invite = irows[0];
    if (!invite) return res.status(400).json({ error: 'Invalid or expired invite link.' });
    if (invite.used) return res.status(400).json({ error: 'This invite link has already been used.' });
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This invite link has expired.' });
    }
    // Every staff invite must carry a terminal (assigned by the supervisor when
    // the link was created). Supervisor invites have no terminal (NULL).
    if (invite.role === 'staff' && !invite.owner_terminal) {
      return res.status(400).json({ error: 'This invite link is missing a terminal assignment. Ask your supervisor for a new link.' });
    }

    const cleanName = name.trim();
    const { rows: erows } = await db.query(
      `SELECT id FROM users WHERE LOWER(name) = LOWER($1)`, [cleanName]
    );
    if (erows.length > 0) return res.status(409).json({ error: 'A user with that name already exists.' });

    const hash = await bcrypt.hash(String(pin), 12);
    await db.query(
      `INSERT INTO users (name, role, owner_terminal, pin_hash, active) VALUES ($1, $2, $3, $4, true)`,
      [cleanName, invite.role, invite.owner_terminal, hash]
    );
    await db.query(`UPDATE invite_tokens SET used = true WHERE id = $1`, [invite.id]);

    const authToken = makeToken(invite.role, invite.owner_terminal, cleanName);
    return res.status(201).json({ role: invite.role, ownerTerminal: invite.owner_terminal || null, username: cleanName, token: authToken });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── Validate invite token (GET) ───────────────────────────────────────────────
router.get('/invite/:token', async (req, res) => {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const { rows } = await db.query(
      `SELECT role, owner_terminal, expires_at, used FROM invite_tokens WHERE token = $1 LIMIT 1`,
      [req.params.token]
    );
    const invite = rows[0];
    if (!invite || invite.used || new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired invite link.' });
    }
    return res.json({ role: invite.role, ownerTerminal: invite.owner_terminal || null, expiresAt: invite.expires_at });
  } catch (err) {
    console.error('Invite check error:', err);
    return res.status(500).json({ error: 'Could not validate invite.' });
  }
});

module.exports = router;
module.exports.verifyToken = verifyToken;
module.exports.validatePin = validatePin;
module.exports.makeToken   = makeToken;
