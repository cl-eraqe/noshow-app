require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDb, autoCloseReports } = require('./db');

const authRoutes = require('./routes/auth');
const flightRoutes = require('./routes/flights');
const reportRoutes = require('./routes/reports');
const analyticsRoutes = require('./routes/analytics');
const exportRoutes = require('./routes/export');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

app.use(express.json());

// Protected file downloads — requires a valid session token
app.get('/api/files/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(uploadsDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filepath);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/flights', flightRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/export', exportRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('/user-manual', (_req, res) => {
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
