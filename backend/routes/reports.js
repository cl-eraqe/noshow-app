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

// ── Shift Summary (must be before /:id)
// Shifts: A = 06:00-14:00, B = 14:00-22:00, C = 22:00-06:00
router.get('/shift-summary', (req, res) => {
  const db = getDb();
  const { date } = req.query; // YYYY-MM-DD, defaults to today
  // Use local date (not UTC) for default
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const targetDate = date || localToday;

  // Build shift time ranges
  const shifts = {
    A: { start: `${targetDate}T06:00`, end: `${targetDate}T14:00` },
    B: { start: `${targetDate}T14:00`, end: `${targetDate}T22:00` },
    C: { start: `${targetDate}T22:00`, end: `${targetDate}T06:00` },
  };
  // Shift C spans midnight: 22:00 today → 06:00 next day
  const nextDay = new Date(targetDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  shifts.C.end = `${nextDayStr}T06:00`;

  const result = {};

  for (const [shiftName, range] of Object.entries(shifts)) {
    const reports = db.prepare(`
      SELECT pax_count, pax_id_datetime FROM reports
      WHERE pax_id_datetime >= ? AND pax_id_datetime < ?
      ORDER BY pax_id_datetime ASC
    `).all(range.start, range.end);

    const lines = reports.map(r => {
      const time = r.pax_id_datetime ? r.pax_id_datetime.slice(11, 16) : '??:??';
      const count = String(r.pax_count || 1).padStart(2, '0');
      return `${count}PAX Identified at ${time}`;
    });

    const totalPax = reports.reduce((sum, r) => sum + (r.pax_count || 1), 0);
    const totalReports = reports.length;

    result[shiftName] = {
      lines,
      totalPax,
      totalReports,
      text: lines.length > 0
        ? `No-Show App Summary SHIFT ${shiftName}\n${lines.join('\n')}\n\nTotal pax added during shift ${shiftName} is ${totalPax}PAX in the No-Show App.`
        : `No-Show App Summary SHIFT ${shiftName}\nNo reports during this shift.`,
    };
  }

  res.json({ date: targetDate, shifts: result });
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
    submitted_by, status, comment,
  } = req.body;

  const filePaths = req.files
    ? req.files.map(f => `/uploads/${f.filename}`)
    : [];

  const reportStatus = status || 'under_process';

  // Calculate days_at_airport from prev_flight datetime to now
  let computedDays = parseFloat(days_at_airport) || null;
  if (!computedDays && prev_datetime) {
    const diff = (Date.now() - new Date(prev_datetime).getTime()) / (1000 * 60 * 60 * 24);
    if (!isNaN(diff) && diff >= 0) {
      computedDays = parseFloat(Math.max(0, diff).toFixed(2));
    }
  }

  const stmt = db.prepare(`
    INSERT INTO reports
      (pax_id_datetime,
       prev_flight, prev_datetime, prev_destination, prev_airline,
       nationality, pax_type,
       new_flight, new_datetime, new_destination, new_airline,
       days_at_airport, pax_count, file_paths, whatsapp_text, submitted_by, status, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    pax_id_datetime,
    prev_flight, prev_datetime, prev_destination, prev_airline,
    nationality, pax_type,
    new_flight || null, new_datetime || null, new_destination || null, new_airline || null,
    computedDays,
    parseInt(pax_count) || 0,
    JSON.stringify(filePaths),
    '', // placeholder
    submitted_by,
    reportStatus,
    comment || '',
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

// ── PUT full update of a report (edit mode)
router.put('/:id', upload.array('files', 10), (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Report not found' });

  const {
    pax_id_datetime,
    prev_flight, prev_datetime, prev_destination, prev_airline,
    nationality, pax_type,
    new_flight, new_datetime, new_destination, new_airline,
    days_at_airport, pax_count,
    status, comment,
  } = req.body;

  const reportStatus = status || existing.status || 'under_process';

  // If new files uploaded, merge with existing; otherwise keep old
  let filePaths;
  if (req.files && req.files.length > 0) {
    const newPaths = req.files.map(f => `/uploads/${f.filename}`);
    const oldPaths = JSON.parse(existing.file_paths || '[]');
    filePaths = [...oldPaths, ...newPaths];
  } else {
    filePaths = JSON.parse(existing.file_paths || '[]');
  }

  // Compute days from prev_flight to now
  let computedDays = parseFloat(days_at_airport) || null;
  if (!computedDays && prev_datetime) {
    const diff = (Date.now() - new Date(prev_datetime).getTime()) / (1000 * 60 * 60 * 24);
    if (!isNaN(diff) && diff >= 0) computedDays = parseFloat(Math.max(0, diff).toFixed(2));
  }

  const whatsapp_text =
    `No-Show Report #${existing.id}\n` +
    `Flight: ${prev_flight || '—'} → ${prev_destination || '—'}\n` +
    `Pax: ${pax_count} × ${pax_type || '—'}\n` +
    `Nationality: ${nationality || '—'}\n` +
    `New Flight: ${new_flight || '—'} on ${new_datetime || '—'}`;

  db.prepare(`
    UPDATE reports SET
      pax_id_datetime = ?, prev_flight = ?, prev_datetime = ?, prev_destination = ?, prev_airline = ?,
      nationality = ?, pax_type = ?,
      new_flight = ?, new_datetime = ?, new_destination = ?, new_airline = ?,
      days_at_airport = ?, pax_count = ?, file_paths = ?, whatsapp_text = ?,
      status = ?, comment = ?
    WHERE id = ?
  `).run(
    pax_id_datetime,
    prev_flight, prev_datetime, prev_destination, prev_airline,
    nationality, pax_type,
    new_flight || null, new_datetime || null, new_destination || null, new_airline || null,
    computedDays,
    parseInt(pax_count) || 0,
    JSON.stringify(filePaths),
    whatsapp_text,
    reportStatus,
    comment || '',
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ── PATCH update report status (and optionally new flight info)
router.patch('/:id', express.json(), (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const { status, new_flight, new_datetime, new_destination, new_airline, comment } = req.body;

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
  if (comment !== undefined) {
    updates.push('comment = ?');
    values.push(comment);
  }

  // Recalculate days_at_airport from prev_flight to now
  if (report.prev_datetime) {
    const diff = (Date.now() - new Date(report.prev_datetime).getTime()) / (1000 * 60 * 60 * 24);
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
  const finalNewDatetime = new_datetime !== undefined ? new_datetime : report.new_datetime;

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
