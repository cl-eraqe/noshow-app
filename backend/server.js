require('dotenv').config();

// ── Startup environment guards — fail fast, no silent fallbacks ──────────────
// SESSION_SECRET check happens inside routes/auth.js at require-time.
// Validate FRONTEND_URL here so the CORS config never falls back to wildcard.
if (!process.env.FRONTEND_URL) {
  console.error('FATAL: FRONTEND_URL environment variable is required but not set');
  process.exit(1);
}

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');
const { initDb, autoCloseReports } = require('./db');

const authRoutes      = require('./routes/auth');
const flightRoutes    = require('./routes/flights');
const reportRoutes    = require('./routes/reports');
const analyticsRoutes = require('./routes/analytics');
const exportRoutes    = require('./routes/export');
const { requireAuth } = require('./middleware/auth');
const { streamFile, USE_R2, LOCAL_DIR } = require('./storage');

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's reverse proxy so express-rate-limit sees the real client IP
// from the X-Forwarded-For header instead of the proxy's internal address.
app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https://images.kiwi.com'],
      connectSrc: ["'self'", process.env.FRONTEND_URL],
      fontSrc:    ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

// ── CORS — explicit origin only, no wildcard ─────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.get('/api/files/:filename', requireAuth, async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (USE_R2) {
    try { await streamFile(filename, res); }
    catch (err) {
      console.error('R2 file fetch error:', err?.message || err);
      if (!res.headersSent) res.status(404).json({ error: 'File not found' });
    }
    return;
  }
  const filepath = path.join(LOCAL_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filepath);
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/flights',   requireAuth, flightRoutes);
app.use('/api/reports',   requireAuth, reportRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);
// Export router: token-management routes use per-route requireAuth+requireRole('supervisor');
// external read endpoints (/live-state, /audit-log) use their own requireToken (export tokens).
app.use('/api/export',    exportRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/user-manual', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'user-manual.html'));
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`JEDCO No-Show API running on port ${PORT}`);
  });
  autoCloseReports().catch(console.error);
  setInterval(() => autoCloseReports().catch(console.error), 60 * 1000);
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
