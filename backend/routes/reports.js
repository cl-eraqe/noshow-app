const express = require('express');
const router = express.Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { uploadFile, deleteFile } = require('../storage');
const { getDb, autoCloseReports, logAudit, diffFields, jeddahNowStr } = require('../db');
const { TERMINAL_MAP, getAirlineCode } = require('./_terminal-helper');
const { requireRole } = require('../middleware/auth');

// ── Jeddah time helpers ────────────────────────────────────────────────

// Returns "YYYY-MM-DDTHH:mm" in Jeddah local time, shifted by offsetMs
function jeddahISO(offsetMs = 0) {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 + offsetMs).toISOString().slice(0, 16);
}

// Converts a stored Jeddah-local datetime string to real UTC ms
function jeddahDtMs(dtStr) {
  if (!dtStr) return NaN;
  const s = String(dtStr).replace(' ', 'T').slice(0, 16);
  return new Date(s + ':00+03:00').getTime();
}

// ── Audit fields tracked on every change ──────────────────────────────

const AUDIT_FIELDS = [
  'prev_flight', 'prev_datetime', 'prev_destination', 'prev_airline',
  'nationality', 'pax_type', 'pax_count',
  'new_flight', 'new_datetime', 'new_destination', 'new_airline',
  'status', 'comment', 'nusuk_received',
];

function getTerminal(flight) {
  return TERMINAL_MAP[getAirlineCode(flight)] || 'T1';
}
function needsBus(flight) {
  const t = getTerminal(flight);
  return t === 'North' || t === 'Hajj';
}

// ── Multi-terminal scoping ──────────────────────────────────────────────
// owner_terminal ('T1' | 'North') records which terminal's queue a report
// belongs to — it comes from the REPORTING USER, never from the flight. This
// is a completely separate concept from getTerminal()/needsBus() above, which
// derive a terminal from the flight's airline purely to decide whether a bus
// transfer badge is needed; that logic is untouched by anything below.

// Returns the owner_terminal value a list/aggregate query should filter by,
// or null for "no filter" (supervisor viewing All Terminals).
// Normal users are ALWAYS forced to their own assigned terminal — the
// ?scope= query param, if present, is ignored for them.
function scopeValue(req) {
  if (req.role === 'supervisor') {
    const q = String(req.query.scope || '').trim();
    return (q === 'T1' || q === 'North') ? q : null;
  }
  return req.ownerTerminal || null;
}

// Returns true if req's user is allowed to see/act on a single report.
// Supervisors can access any report; normal users only their own terminal's.
function ownsReport(req, report) {
  if (req.role === 'supervisor') return true;
  return report.owner_terminal === req.ownerTerminal;
}
function iataCode(dest) {
  if (!dest) return '???';
  const match = dest.match(/\(([A-Z]{3})\)/);
  return match ? match[1] : dest.slice(0, 3).toUpperCase();
}
function fmtDateShort(dt) {
  if (!dt) return '??';
  const d = new Date(String(dt).replace(' ', 'T'));
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return String(d.getDate()).padStart(2, '0') + months[d.getMonth()];
}
function fmtTimeShort(dt) {
  if (!dt) return '????';
  const d = new Date(String(dt).replace(' ', 'T'));
  return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
}

// ── Multer (memory storage — files uploaded to cloud/local via storage.js) ──

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
]);

function makeFilename(originalname) {
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(originalname)}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(Object.assign(new Error('نوع الملف غير مسموح. المسموح: صور (JPEG/PNG/GIF/WebP/HEIC) و PDF فقط.'), { status: 400 }));
    }
    cb(null, true);
  },
});

// Wraps upload.array so multer validation errors return 400 JSON instead of crashing.
function uploadFiles(req, res, next) {
  upload.array('files', 10)(req, res, err => {
    if (!err) return next();
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'حجم الملف تجاوز الحد المسموح (20MB).'
      : (err.message || 'خطأ في رفع الملف.');
    return res.status(status).json({ error: message });
  });
}

async function saveFiles(files) {
  return Promise.all(files.map(f => uploadFile(makeFilename(f.originalname), f.buffer, f.mimetype)));
}

async function purgeFiles(pool, reportId) {
  const { rows } = await pool.query('SELECT file_paths FROM reports WHERE id = $1', [reportId]);
  if (!rows[0]) return;
  const paths = JSON.parse(rows[0].file_paths || '[]');
  if (!paths.length) return;
  await Promise.all(paths.map(p => deleteFile(p.split('/').pop()).catch(() => {})));
  await pool.query('UPDATE reports SET file_paths = $1 WHERE id = $2', ['[]', reportId]);
}

// ── Analytics summary (must be before /:id) ───────────────────────────

router.get('/analytics/summary', async (req, res) => {
  try {
    const pool = getDb();
    const scope = scopeValue(req);
    const scopeAnd   = scope ? ' AND owner_terminal = $2' : '';
    const scopeWhere = scope ? ' WHERE owner_terminal = $1' : '';
    const scopeOnly  = scope ? [scope] : [];

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const startOfMonth = jeddahISO().slice(0, 7) + '-01';

    const [week, month, topDest, byNat, byType] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM reports WHERE LEFT(created_at,10) >= $1${scopeAnd}`, [sevenDaysAgo, ...scopeOnly]),
      pool.query(`SELECT COUNT(*) AS count FROM reports WHERE LEFT(created_at,10) >= $1${scopeAnd}`, [startOfMonth, ...scopeOnly]),
      pool.query(`SELECT prev_destination AS destination, SUM(pax_count) AS total FROM reports${scopeWhere} GROUP BY prev_destination ORDER BY total DESC LIMIT 10`, scopeOnly),
      pool.query(`SELECT nationality, SUM(pax_count) AS total FROM reports${scopeWhere} GROUP BY nationality ORDER BY total DESC`, scopeOnly),
      pool.query(`SELECT pax_type, COUNT(*) AS report_count, SUM(pax_count) AS total_pax FROM reports${scopeWhere} GROUP BY pax_type ORDER BY total_pax DESC`, scopeOnly),
    ]);

    res.json({
      thisWeek:        parseInt(week.rows[0].count),
      thisMonth:       parseInt(month.rows[0].count),
      topDestinations: topDest.rows,
      byNationality:   byNat.rows,
      byPaxType:       byType.rows,
    });
  } catch (e) {
    console.error('[GET /reports/analytics/summary]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Handover Report (must be before /:id) ─────────────────────────────

router.get('/handover', async (req, res) => {
  try {
    const pool = getDb();
    await autoCloseReports();

    const jeddahHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })).getHours();
    const shiftParam = (req.query.shift || '').toUpperCase();
    let currentShift, nextShift;
    if (['A','B','C'].includes(shiftParam)) {
      currentShift = shiftParam;
      nextShift = shiftParam === 'A' ? 'B' : shiftParam === 'B' ? 'C' : 'A';
    } else if (jeddahHour >= 6 && jeddahHour < 14) {
      currentShift = 'A'; nextShift = 'B';
    } else if (jeddahHour >= 14 && jeddahHour < 22) {
      currentShift = 'B'; nextShift = 'C';
    } else {
      currentShift = 'C'; nextShift = 'A';
    }

    const scope = scopeValue(req);
    const scopeAnd = scope ? ' AND owner_terminal = $1' : '';
    const scopeOnly = scope ? [scope] : [];
    const [upRes, fuRes] = await Promise.all([
      pool.query(`SELECT * FROM reports WHERE status = 'under_process'${scopeAnd} ORDER BY prev_datetime ASC`, scopeOnly),
      pool.query(`SELECT * FROM reports WHERE status = 'flight_confirmed'${scopeAnd} ORDER BY new_datetime ASC`, scopeOnly),
    ]);
    const underProcess = upRes.rows;
    const flightConfirmed = fuRes.rows;

    const nowJeddah          = jeddahISO();
    const threeHoursFromNow  = jeddahISO(3 * 60 * 60 * 1000);
    const twentyFourHoursAgo = jeddahISO(-24 * 60 * 60 * 1000);

    const upSV    = underProcess.filter(r => getAirlineCode(r.prev_flight) === 'SV');
    const upOther = underProcess.filter(r => getAirlineCode(r.prev_flight) !== 'SV');
    const fuSV    = flightConfirmed.filter(r => getAirlineCode(r.prev_flight) === 'SV');
    const fuOther = flightConfirmed.filter(r => getAirlineCode(r.prev_flight) !== 'SV');

    const departingSoon = flightConfirmed.filter(r =>
      r.new_datetime && r.new_datetime <= threeHoursFromNow && r.new_datetime > nowJeddah
    );
    const busTransfers = flightConfirmed.filter(r => needsBus(r.new_flight));
    const over24 = [...underProcess, ...flightConfirmed].filter(r =>
      r.prev_datetime && r.prev_datetime < twentyFourHoursAgo
    );

    function fmtReport(r, showNewFlight = false) {
      const count    = String(r.pax_count || 1).padStart(2, '0');
      const paxType  = (r.pax_type || 'Unknown').toUpperCase();
      const dest     = iataCode(r.prev_destination);
      const airline  = getAirlineCode(r.prev_flight);
      const prevDate = fmtDateShort(r.prev_datetime);
      const prevTime = fmtTimeShort(r.prev_datetime);
      const bus      = needsBus(r.new_flight) ? ' 🚌' : '';
      let line = `${count}PAX ${paxType} ${airline} ${dest} ${prevDate} STD ${prevTime}`;
      if (showNewFlight && r.status === 'flight_confirmed' && r.new_flight) {
        const newDate    = fmtDateShort(r.new_datetime);
        const newTime    = fmtTimeShort(r.new_datetime);
        const terminal   = getTerminal(r.new_flight);
        const termNote   = terminal !== 'T1' ? ` (${terminal})` : '';
        line += `\n- ALT FLT ${r.new_flight} STD ${newTime} ${newDate} ✅${termNote}${bus}`;
      }
      if (r.comment) line += `\n   → ${r.comment}`;
      line += ` #${r.id}`;
      return line;
    }

    const lines = [];
    lines.push(`📋 SHIFT HANDOVER ${currentShift} → ${nextShift}`);
    lines.push(`${fmtDateShort(nowJeddah)} ${fmtTimeShort(nowJeddah)}`);
    lines.push('');

    if (departingSoon.length > 0) {
      lines.push('━━ ⏰ DEPARTING SOON (< 3hrs) ━━'); lines.push('');
      departingSoon.forEach(r => {
        const bus      = needsBus(r.new_flight) ? ' 🚌' : '';
        const terminal = getTerminal(r.new_flight);
        const termNote = terminal !== 'T1' ? ` (${terminal})` : '';
        lines.push(`${String(r.pax_count||1).padStart(2,'0')}PAX ${r.new_flight} ${iataCode(r.new_destination)} → STD ${fmtTimeShort(r.new_datetime)} TODAY${termNote}${bus} #${r.id}`);
        if (r.comment) lines.push(`   → ${r.comment}`);
      });
      lines.push('');
    }
    if (busTransfers.length > 0) {
      lines.push('━━ 🚌 BUS TRANSFER NEEDED ━━'); lines.push('');
      busTransfers.forEach(r => {
        const terminal = getTerminal(r.new_flight);
        lines.push(`${String(r.pax_count||1).padStart(2,'0')}PAX → ${r.new_flight} ${iataCode(r.new_destination)} STD ${fmtTimeShort(r.new_datetime)} ${fmtDateShort(r.new_datetime)} (${terminal}) #${r.id}`);
        if (r.comment) lines.push(`   → ${r.comment}`);
      });
      lines.push('');
    }
    if (upSV.length > 0)    { lines.push('━━ UNDER PROCESS SV ━━'); lines.push(''); upSV.forEach(r => lines.push(fmtReport(r))); lines.push(''); }
    if (upOther.length > 0) { lines.push('━━ UNDER PROCESS OTHER AIRLINES ━━'); lines.push(''); upOther.forEach(r => lines.push(fmtReport(r))); lines.push(''); }
    if (fuSV.length > 0)    { lines.push('━━ FOLLOW UP SV ━━'); lines.push(''); fuSV.forEach(r => lines.push(fmtReport(r, true))); lines.push(''); }
    if (fuOther.length > 0) { lines.push('━━ FOLLOW UP OTHER AIRLINES ━━'); lines.push(''); fuOther.forEach(r => lines.push(fmtReport(r, true))); lines.push(''); }
    if (over24.length > 0) {
      lines.push('━━ ⚠ OVER 24HRS ━━'); lines.push('');
      over24.forEach(r => {
        const days = ((Date.now() - new Date(r.prev_datetime).getTime()) / (1000*60*60*24)).toFixed(0);
        lines.push(fmtReport(r, true) + ` (${days} days)`);
      });
      lines.push('');
    }

    const totalUp = underProcess.reduce((s,r) => s+(r.pax_count||0), 0);
    const totalFu = flightConfirmed.reduce((s,r) => s+(r.pax_count||0), 0);
    lines.push('━━ SUMMARY ━━');
    lines.push(`Under Process: ${underProcess.length} cases (${totalUp} PAX)`);
    lines.push(`Flight Confirmed: ${flightConfirmed.length} cases (${totalFu} PAX)`);
    lines.push(`Total Active: ${underProcess.length + flightConfirmed.length} cases (${totalUp + totalFu} PAX)`);

    res.json({ text: lines.join('\n'), shift: { current: currentShift, next: nextShift } });
  } catch (e) {
    console.error('[GET /reports/handover]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Shift Summary (must be before /:id) ───────────────────────────────

router.get('/shift-summary', async (req, res) => {
  try {
    const pool = getDb();
    const { date } = req.query;
    const localToday = jeddahISO().slice(0, 10);
    const targetDate = date || localToday;

    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().slice(0, 10);

    const shifts = {
      A: { start: `${targetDate}T06:00`, end: `${targetDate}T14:00` },
      B: { start: `${targetDate}T14:00`, end: `${targetDate}T22:00` },
      C: { start: `${targetDate}T22:00`, end: `${nextDayStr}T06:00` },
    };

    const scope = scopeValue(req);
    const result = {};
    for (const [shiftName, range] of Object.entries(shifts)) {
      const params = [range.start, range.end];
      let sql = `SELECT pax_count, pax_id_datetime FROM reports WHERE pax_id_datetime >= $1 AND pax_id_datetime < $2`;
      if (scope) { sql += ' AND owner_terminal = $3'; params.push(scope); }
      sql += ' ORDER BY pax_id_datetime ASC';
      const { rows } = await pool.query(sql, params);
      const lines = rows.map(r => {
        const time  = r.pax_id_datetime ? r.pax_id_datetime.slice(11, 16) : '??:??';
        const count = String(r.pax_count || 1).padStart(2, '0');
        return `${count}PAX Identified at ${time}`;
      });
      const totalPax     = rows.reduce((sum, r) => sum + (r.pax_count || 1), 0);
      const totalReports = rows.length;
      result[shiftName] = {
        lines, totalPax, totalReports,
        text: lines.length > 0
          ? `No-Show App Summary SHIFT ${shiftName}\n${lines.join('\n')}\n\nTotal pax added during shift ${shiftName} is ${totalPax}PAX in the No-Show App.`
          : `No-Show App Summary SHIFT ${shiftName}\nNo reports during this shift.`,
      };
    }

    res.json({ date: targetDate, shifts: result });
  } catch (e) {
    console.error('[GET /reports/shift-summary]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET all reports ────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    autoCloseReports().catch(console.error);
    const pool = getDb();
    const scope = scopeValue(req);
    const { rows } = scope
      ? await pool.query('SELECT * FROM reports WHERE owner_terminal = $1 ORDER BY created_at DESC', [scope])
      : await pool.query('SELECT * FROM reports ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    console.error('[GET /reports]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET single report ──────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0] || !ownsReport(req, rows[0])) return res.status(404).json({ error: 'Report not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /reports/:id]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST create report ─────────────────────────────────────────────────

router.post('/', uploadFiles, async (req, res) => {
  try {
    const pool = getDb();
    const {
      pax_id_datetime,
      prev_flight, prev_datetime, prev_destination, prev_airline,
      nationality, pax_type,
      new_flight, new_datetime, new_destination, new_airline,
      days_at_airport, pax_count,
      submitted_by, status, comment,
    } = req.body;

    // owner_terminal always comes from the reporting user's assigned terminal —
    // never from the flight. Normal users can't override it even if they send
    // one. Supervisors have no fixed terminal, so they must choose explicitly.
    let ownerTerminal;
    if (req.role === 'supervisor') {
      const t = req.body.owner_terminal;
      if (t !== 'T1' && t !== 'North') {
        return res.status(400).json({ error: 'Terminal is required — choose Terminal 1 or North Terminal.' });
      }
      ownerTerminal = t;
    } else {
      if (req.ownerTerminal !== 'T1' && req.ownerTerminal !== 'North') {
        return res.status(403).json({ error: 'Your account has no terminal assigned. Contact your supervisor.' });
      }
      ownerTerminal = req.ownerTerminal;
    }

    const filePaths = req.files?.length ? await saveFiles(req.files) : [];
    const reportStatus = status || 'under_process';

    let computedDays = parseFloat(days_at_airport) || null;
    if (!computedDays && prev_datetime) {
      const diff = (Date.now() - jeddahDtMs(prev_datetime)) / (1000 * 60 * 60 * 24);
      if (!isNaN(diff) && diff >= 0) computedDays = parseFloat(Math.max(0, diff).toFixed(2));
    }

    const { rows } = await pool.query(
      `INSERT INTO reports
        (pax_id_datetime,
         prev_flight, prev_datetime, prev_destination, prev_airline,
         nationality, pax_type,
         new_flight, new_datetime, new_destination, new_airline,
         days_at_airport, pax_count, file_paths, whatsapp_text, submitted_by, status, comment, created_at,
         owner_terminal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        pax_id_datetime,
        prev_flight, prev_datetime, prev_destination, prev_airline,
        nationality, pax_type,
        new_flight || null, new_datetime || null, new_destination || null, new_airline || null,
        computedDays,
        parseInt(pax_count) || 0,
        JSON.stringify(filePaths),
        '',
        submitted_by,
        reportStatus,
        comment || '',
        jeddahNowStr(),
        ownerTerminal,
      ]
    );

    const id = rows[0].id;

    const whatsapp_text =
      `No-Show Report #${id}\n` +
      `Flight: ${prev_flight || '—'} → ${prev_destination || '—'}\n` +
      `Pax: ${pax_count} × ${pax_type || '—'}\n` +
      `Nationality: ${nationality || '—'}\n` +
      `New Flight: ${new_flight || '—'} on ${new_datetime || '—'}`;

    await pool.query('UPDATE reports SET whatsapp_text = $1 WHERE id = $2', [whatsapp_text, id]);

    if (reportStatus === 'flight_confirmed') {
      await pool.query('UPDATE reports SET confirmed_at = $1, confirmed_by = $2 WHERE id = $3', [jeddahNowStr(), req.username || req.role, id]);
    }

    const { rows: reportRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [id]);
    const report = reportRows[0];

    await logAudit({ user: req.username || req.role, action: 'create', reportId: id, snapshot: report });

    res.status(201).json(report);
  } catch (e) {
    console.error('[POST /reports]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT full update ────────────────────────────────────────────────────

router.put('/:id', uploadFiles, async (req, res) => {
  try {
    const pool = getDb();
    const { rows: existingRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!existingRows[0] || !ownsReport(req, existingRows[0])) return res.status(404).json({ error: 'Report not found' });
    const existing = existingRows[0];

    const {
      pax_id_datetime,
      prev_flight, prev_datetime, prev_destination, prev_airline,
      nationality, pax_type,
      new_flight, new_datetime, new_destination, new_airline,
      days_at_airport, pax_count,
      status, comment,
    } = req.body;
    // owner_terminal is immutable once set at creation — never touched here,
    // even by a supervisor editing the case.

    const reportStatus = status || existing.status || 'under_process';

    const oldPaths = JSON.parse(existing.file_paths || '[]');
    const filePaths = req.files?.length
      ? [...oldPaths, ...await saveFiles(req.files)]
      : oldPaths;

    let computedDays = parseFloat(days_at_airport) || null;
    if (!computedDays && prev_datetime) {
      const diff = (Date.now() - jeddahDtMs(prev_datetime)) / (1000 * 60 * 60 * 24);
      if (!isNaN(diff) && diff >= 0) computedDays = parseFloat(Math.max(0, diff).toFixed(2));
    }

    const whatsapp_text =
      `No-Show Report #${existing.id}\n` +
      `Flight: ${prev_flight || '—'} → ${prev_destination || '—'}\n` +
      `Pax: ${pax_count} × ${pax_type || '—'}\n` +
      `Nationality: ${nationality || '—'}\n` +
      `New Flight: ${new_flight || '—'} on ${new_datetime || '—'}`;

    await pool.query(
      `UPDATE reports SET
        pax_id_datetime=$1, prev_flight=$2, prev_datetime=$3, prev_destination=$4, prev_airline=$5,
        nationality=$6, pax_type=$7,
        new_flight=$8, new_datetime=$9, new_destination=$10, new_airline=$11,
        days_at_airport=$12, pax_count=$13, file_paths=$14, whatsapp_text=$15,
        status=$16, comment=$17
       WHERE id=$18`,
      [
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
      ]
    );

    if (existing.status !== 'flight_confirmed' && reportStatus === 'flight_confirmed' && !existing.confirmed_at) {
      await pool.query('UPDATE reports SET confirmed_at = $1, confirmed_by = $2 WHERE id = $3', [jeddahNowStr(), req.username || req.role, req.params.id]);
    }
    if (existing.status !== 'closed' && reportStatus === 'closed' && !existing.closed_at) {
      await pool.query('UPDATE reports SET closed_at = $1 WHERE id = $2', [jeddahNowStr(), req.params.id]);
      await purgeFiles(pool, req.params.id);
    }

    const { rows: updatedRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    const updated = updatedRows[0];

    const changes = diffFields(existing, updated, AUDIT_FIELDS);
    if (changes) {
      await logAudit({ user: req.username || req.role, action: 'edit', reportId: updated.id, changes });
    }

    res.json(updated);
  } catch (e) {
    console.error('[PUT /reports/:id]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH update status / fields ──────────────────────────────────────

router.patch('/:id', express.json(), async (req, res) => {
  try {
    const pool = getDb();
    const { rows: existing } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!existing[0] || !ownsReport(req, existing[0])) return res.status(404).json({ error: 'Report not found' });
    const report = existing[0];

    const { status, new_flight, new_datetime, new_destination, new_airline, comment, pax_count } = req.body;
    // owner_terminal is immutable — not accepted as a patchable field.

    const validStatuses = ['under_process', 'flight_confirmed', 'closed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (status !== undefined)          { updates.push(`status = $${idx++}`);          values.push(status); }
    if (new_flight !== undefined)      { updates.push(`new_flight = $${idx++}`);      values.push(new_flight); }
    if (new_datetime !== undefined)    { updates.push(`new_datetime = $${idx++}`);    values.push(new_datetime); }
    if (new_destination !== undefined) { updates.push(`new_destination = $${idx++}`); values.push(new_destination); }
    if (new_airline !== undefined)     { updates.push(`new_airline = $${idx++}`);     values.push(new_airline); }
    if (comment !== undefined)         { updates.push(`comment = $${idx++}`);         values.push(comment); }
    if (pax_count !== undefined)       { updates.push(`pax_count = $${idx++}`);       values.push(parseInt(pax_count) || 0); }

    if (report.prev_datetime) {
      const diff = (Date.now() - jeddahDtMs(report.prev_datetime)) / (1000 * 60 * 60 * 24);
      if (!isNaN(diff)) { updates.push(`days_at_airport = $${idx++}`); values.push(parseFloat(Math.max(0, diff).toFixed(2))); }
    }

    if (updates.length === 0) return res.json(report);

    const finalNewFlight   = new_flight   !== undefined ? new_flight   : report.new_flight;
    const finalNewDatetime = new_datetime !== undefined ? new_datetime : report.new_datetime;
    const finalPaxCount    = pax_count    !== undefined ? (parseInt(pax_count) || 0) : report.pax_count;

    const whatsapp_text =
      `No-Show Report #${report.id}\n` +
      `Flight: ${report.prev_flight || '—'} → ${report.prev_destination || '—'}\n` +
      `Pax: ${finalPaxCount} × ${report.pax_type || '—'}\n` +
      `Nationality: ${report.nationality || '—'}\n` +
      `New Flight: ${finalNewFlight || '—'} on ${finalNewDatetime || '—'}`;
    updates.push(`whatsapp_text = $${idx++}`);
    values.push(whatsapp_text);

    values.push(req.params.id);
    await pool.query(`UPDATE reports SET ${updates.join(', ')} WHERE id = $${idx}`, values);

    if (status && report.status !== 'flight_confirmed' && status === 'flight_confirmed' && !report.confirmed_at) {
      await pool.query('UPDATE reports SET confirmed_at = $1, confirmed_by = $2 WHERE id = $3', [jeddahNowStr(), req.username || req.role, req.params.id]);
    }
    if (status && report.status !== 'closed' && status === 'closed' && !report.closed_at) {
      await pool.query('UPDATE reports SET closed_at = $1 WHERE id = $2', [jeddahNowStr(), req.params.id]);
      await purgeFiles(pool, req.params.id);
    }

    const { rows: updatedRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    const updated = updatedRows[0];

    const changes = diffFields(report, updated, AUDIT_FIELDS);
    if (changes) {
      const action =
        changes.status?.to === 'flight_confirmed' ? 'confirm_flight' :
        changes.status?.to === 'closed'           ? 'close'          :
        changes.status?.to === 'under_process'    ? 'reopen'         : 'edit';
      await logAudit({ user: req.username || req.role, action, reportId: updated.id, changes });
    }

    res.json(updated);
  } catch (e) {
    console.error('[PATCH /reports/:id]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete single attachment ───────────────────────────────────────────
router.delete('/:id/files/:filename', requireRole('supervisor'), async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT file_paths FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
    const paths = JSON.parse(rows[0].file_paths || '[]');
    const fname = req.params.filename;
    const newPaths = paths.filter(p => p.split('/').pop() !== fname);
    if (newPaths.length === paths.length) return res.status(404).json({ error: 'File not in report' });
    await deleteFile(fname).catch(() => {});
    await pool.query('UPDATE reports SET file_paths = $1 WHERE id = $2', [JSON.stringify(newPaths), req.params.id]);
    await logAudit({ user: req.username || req.role, action: 'delete_attachment', reportId: Number(req.params.id), changes: { removed: fname } });
    res.json({ success: true, file_paths: newPaths });
  } catch (e) {
    console.error('[DELETE /reports/:id/files/:filename]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE report ──────────────────────────────────────────────────────

// ── Attach additional files to an existing report (no other fields changed)
router.post('/:id/files', uploadFiles, async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0] || !ownsReport(req, rows[0])) return res.status(404).json({ error: 'Report not found' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const oldPaths = JSON.parse(rows[0].file_paths || '[]');
    const newPaths = await saveFiles(req.files);
    const filePaths = [...oldPaths, ...newPaths];

    await pool.query('UPDATE reports SET file_paths = $1 WHERE id = $2', [JSON.stringify(filePaths), req.params.id]);
    await logAudit({
      user: req.username || req.role,
      action: 'attach_files',
      reportId: rows[0].id,
      changes: { file_paths: { added: newPaths } },
    });

    res.json({ success: true, file_paths: filePaths, added: newPaths });
  } catch (e) {
    console.error('[POST /reports/:id/files]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireRole('supervisor'), async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
    const report = rows[0];

    try {
      const files = JSON.parse(report.file_paths || '[]');
      await Promise.all(files.map(fp => deleteFile(fp.split('/').pop()).catch(() => {})));
    } catch (_) {}

    await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    await logAudit({ user: req.username || req.role, action: 'delete', reportId: report.id, snapshot: report });

    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /reports/:id]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Nusuk confirmation ─────────────────────────────────────────────────

router.post('/:id/nusuk', express.json(), async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0] || !ownsReport(req, rows[0])) return res.status(404).json({ error: 'Report not found' });
    const report = rows[0];

    const { received, user } = req.body;
    const ts = received ? jeddahNowStr() : null;
    const by = received ? (user || 'staff') : null;

    await pool.query('UPDATE reports SET nusuk_received = $1, nusuk_by = $2 WHERE id = $3', [ts, by, req.params.id]);
    await logAudit({
      user: req.username || req.role,
      action: received ? 'nusuk_confirm' : 'nusuk_unconfirm',
      reportId: report.id,
      changes: { nusuk_received: { from: report.nusuk_received, to: ts } },
    });

    const { rows: updatedRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    res.json(updatedRows[0]);
  } catch (e) {
    console.error('[POST /reports/:id/nusuk]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;


