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
app.use('/uploads', express.static(uploadsDir));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/flights', flightRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/export', exportRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

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
