require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { initDb, autoCloseReports } = require('./db');
const { getFileUrl, USE_R2, LOCAL_DIR } = require('./storage');

const authRoutes      = require('./routes/auth');
const flightRoutes    = require('./routes/flights');
const reportRoutes    = require('./routes/reports');
const analyticsRoutes = require('./routes/analytics');
const exportRoutes    = require('./routes/export');
const { requireAuth } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3001;

if (!USE_R2 && !fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());

// Protected file downloads
app.get('/api/files/:filename', requireAuth, async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (USE_R2) {
    try {
      const url = await getFileUrl(filename);
      return res.redirect(url);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
  }
  const filepath = path.join(LOCAL_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filepath);
});

app.use('/api/auth',      authRoutes);
app.use('/api/flights',   flightRoutes);
app.use('/api/reports',   reportRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/export',    exportRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString(), storage: USE_R2 ? 'r2' : 'local' }));

async function start() {
  await initDb();
  app.listen(PORT, () => console.log(`JEDCO No-Show API running on port ${PORT} [storage: ${USE_R2 ? 'R2' : 'local'}]`));
  autoCloseReports().catch(console.error);
  setInterval(() => autoCloseReports().catch(console.error), 60 * 1000);
}

start().catch(err => { console.error('Failed to start server:', err); process.exit(1); });
