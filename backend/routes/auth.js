const express   = require('express');
const crypto    = require('crypto');
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
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function makeToken(role) {
  const w = Math.floor(Date.now() / WINDOW_MS);
  const sig = crypto.createHmac('sha256', SECRET()).update(`${role}:${w}`).digest('hex');
  return `${role}.${w}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [role, win, sig] = parts;
  const now = Math.floor(Date.now() / WINDOW_MS);
  for (const w of [now, now - 1]) {
    const expected = crypto.createHmac('sha256', SECRET()).update(`${role}:${w}`).digest('hex');
    if (sig === expected && parseInt(win) === w) return role;
  }
  return null;
}

router.post('/login', loginLimiter, (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN is required' });

  const staffPin      = process.env.STAFF_PIN;
  const supervisorPin = process.env.SUPERVISOR_PIN;

  if (!staffPin || !supervisorPin) {
    return res.status(500).json({ error: 'Server PIN configuration missing' });
  }

  if (pin === supervisorPin) return res.json({ role: 'supervisor', token: makeToken('supervisor') });
  if (pin === staffPin)      return res.json({ role: 'staff',       token: makeToken('staff') });

  return res.status(401).json({ error: 'Invalid PIN' });
});

module.exports = router;
module.exports.verifyToken = verifyToken;
