const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, autoCloseReports } = require('../db');

const uploadsDir = path.join(__dirname, '..', 'uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per file
});

// ── Analytics (must be before /:id to avoid Express treating "analytics" as an ID)
router.get('/analytics/summary', (_req, res) => {
  const db = getDb();

  const thisWeek = db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE created_at >= datetime('now', '-7 days')
  `).get();

  const thisMonth = db.prepare(`
    SELECT COUNT(*) as count FROM reports
    WHERE created_at >= datetime('now', 'start of month')
  `).get();

  const topDestinations = db.prepare(`
    SELECT prev_destination AS destination, SUM(pax_count) AS total
    FROM reports
    GROUP BY prev_destination
    ORDER BY total DESC
    LIMIT 10
  `).all();

  const byNationality = db.prepare(`
    SELECT nationality, SUM(pax_count) AS total
    FROM reports
    GROUP BY nationality
    ORDER BY total DESC
  `).all();

  const byPaxType = db.prepare(`
    SELECT pax_type, COUNT(*) AS report_count, SUM(pax_count) AS total_pax
    FROM reports
    GROUP BY pax_type
    ORDER BY total_pax DESC
  `).all();

  res.json({ thisWeek: thisWeek.count, thisMonth: thisMonth.count, topDestinations, byNationality, byPaxType });
});

// ── GET all reports (auto-close expired ones first)
router.get('/', (_req, res) => {
  autoCloseReports();
  const reports = getDb().prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json(reports);
});

// ── GET single report
router.get('/:id', (req, res) => {
  const report = getDb().prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

// ── POST create report
router.post('/', upload.array('files', 10), (req, res) => {
  const db = getDb();
  const {
    pax_id_datetime,
    prev_flight, prev_datetime, prev_destination, prev_airline,
    nationality, pax_type,
    new_flight, new_datetime, new_destination, new_airline,
    days_at_airport, pax_count,
    submitted_by, status,
  } = req.body;

  const filePaths = req.files
    ? req.files.map(f => `/uploads/${f.filename}`)
    : [];

  // Insert first to get the auto-increment ID
  const reportStatus = status || 'under_process';

  const stmt = db.prepare(`
    INSERT INTO reports
      (pax_id_datetime,
       prev_flight, prev_datetime, prev_destination, prev_airline,
       nationality, pax_type,
       new_flight, new_datetime, new_destination, new_airline,
       days_at_airport, pax_count, file_paths, whatsapp_text, submitted_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    pax_id_datetime,
    prev_flight, prev_datetime, prev_destination, prev_airline,
    nationality, pax_type,
    new_flight || null, new_datetime || null, new_destination || null, new_airline || null,
    parseFloat(days_at_airport) || null,
    parseInt(pax_count) || 0,
    JSON.stringify(filePaths),
    '', // placeholder
    submitted_by,
    reportStatus,
  );

  const id = result.lastInsertRowid;

  const whatsapp_text =
    `No-Show Report #${id}\n` +
    `Flight: ${prev_flight || '—'} → ${prev_destination || '—'}\n` +
    `Pax: ${pax_count} × ${pax_type || '—'}\n` +
    `Nationality: ${nationality || '—'}\n` +
    `New Flight: ${new_flight || '—'} on ${new_datetime || '—'}`;

  db.prepare('UPDATE reports SET whatsapp_text = ? WHERE id = ?').run(whatsapp_text, id);

  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  res.status(201).json(report);
});

// ── PATCH update report status (and optionally new flight info)
router.patch('/:id', express.json(), (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const { status, new_flight, new_datetime, new_destination, new_airline } = req.body;

  // Validate status
  const validStatuses = ['under_process', 'flight_confirmed', 'closed'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Build dynamic update
  const updates = [];
  const values = [];

  if (status) {
    updates.push('status = ?');
    values.push(status);
  }
  if (new_flight !== undefined) {
    updates.push('new_flight = ?');
    values.push(new_flight);
  }
  if (new_datetime !== undefined) {
    updates.push('new_datetime = ?');
    values.push(new_datetime);
  }
  if (new_destination !== undefined) {
    updates.push('new_destination = ?');
    values.push(new_destination);
  }
  if (new_airline !== undefined) {
    updates.push('new_airline = ?');
    values.push(new_airline);
  }

  // Recalculate days_at_airport if we have both dates
  const finalNewDatetime = new_datetime !== undefined ? new_datetime : report.new_datetime;
  if (report.pax_id_datetime && finalNewDatetime) {
    const diff = (new Date(finalNewDatetime) - new Date(report.pax_id_datetime)) / (1000 * 60 * 60 * 24);
    if (!isNaN(diff)) {
      updates.push('days_at_airport = ?');
      values.push(parseFloat(Math.max(0, diff).toFixed(2)));
    }
  }

  // Regenerate whatsapp text
  const finalPrevFlight = report.prev_flight;
  const finalPrevDest = report.prev_destination;
  const finalPaxCount = report.pax_count;
  const finalPaxType = report.pax_type;
  const finalNationality = report.nationality;
  const finalNewFlight = new_flight !== undefined ? new_flight : report.new_flight;

  const whatsapp_text =
    `No-Show Report #${report.id}\n` +
    `Flight: ${finalPrevFlight || '—'} → ${finalPrevDest || '—'}\n` +
    `Pax: ${finalPaxCount} × ${finalPaxType || '—'}\n` +
    `Nationality: ${finalNationality || '—'}\n` +
    `New Flight: ${finalNewFlight || '—'} on ${finalNewDatetime || '—'}`;
  updates.push('whatsapp_text = ?');
  values.push(whatsapp_text);

  if (updates.length === 0) {
    return res.json(report);
  }

  values.push(req.params.id);
  db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ── DELETE report
router.delete('/:id', (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  // Clean up uploaded files
  try {
    const files = JSON.parse(report.file_paths || '[]');
    files.forEach(fp => {
      const full = path.join(__dirname, '..', fp);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    });
  } catch (_) { /* ignore parse errors */ }

  db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
