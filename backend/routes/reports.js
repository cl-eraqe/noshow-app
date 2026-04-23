const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, autoCloseReports, logAudit, diffFields } = require('../db');

// ── Jeddah time helpers ────────────────────────────────────────────────

function jeddahNowStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

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

// ── Terminal mapping ───────────────────────────────────────────────────

const TERMINAL_MAP = {
  SV:'T1',XY:'T1',F3:'T1',QR:'T1',EK:'T1',KU:'T1',WY:'T1',FZ:'T1',
  RJ:'T1',ME:'T1',GF:'T1',EY:'T1',AT:'T1',VF:'T1',EW:'T1',
  A3:'T1',MH:'T1',BA:'T1',MS:'T1',HU:'T1',
  G9:'North',NE:'North',IY:'North','6E':'North',PC:'North','3T':'North',
  SM:'North',J4:'North',AI:'North',ET:'North',NP:'North',HY:'North',
  SZ:'North',RB:'North',D3:'North',SD:'North',DV:'North',
  OV:'North',IX:'North',TU:'North',W9:'North',E5:'North',
  PA:'Hajj',PF:'Hajj',BG:'Hajj',PK:'Hajj',AH:'Hajj',
  GA:'Hajj',FG:'Hajj',BS:'Hajj','9P':'Hajj',QP:'Hajj',
  JT:'Hajj',RQ:'Hajj',C6:'Hajj',TK:'T1',D7:'Hajj',
  '2S':'Hajj','7Q':'Hajj',BJ:'Hajj',BM:'Hajj',FH:'Hajj',
  UZ:'Hajj',XC:'Hajj',
};

function getAirlineCode(flight) {
  if (!flight) return '';
  return flight.toUpperCase().trim().slice(0, 2);
}
function getTerminal(flight) {
  return TERMINAL_MAP[getAirlineCode(flight)] || 'T1';
}
function needsBus(flight) {
  const t = getTerminal(flight);
  return t === 'North' || t === 'Hajj';
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

// ── Multer (file uploads) ──────────────────────────────────────────────

const uploadsDir = path.join(__dirname, '..', 'uploads');
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// ── Analytics summary (must be before /:id) ───────────────────────────

router.get('/analytics/summary', async (_req, res) => {
  try {
    const pool = getDb();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const startOfMonth = jeddahISO().slice(0, 7) + '-01';

    const [week, month, topDest, byNat, byType] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM reports WHERE LEFT(created_at,10) >= $1`, [sevenDaysAgo]),
      pool.query(`SELECT COUNT(*) AS count FROM reports WHERE LEFT(created_at,10) >= $1`, [startOfMonth]),
      pool.query(`SELECT prev_destination AS destination, SUM(pax_count) AS total FROM reports GROUP BY prev_destination ORDER BY total DESC LIMIT 10`),
      pool.query(`SELECT nationality, SUM(pax_count) AS total FROM reports GROUP BY nationality ORDER BY total DESC`),
      pool.query(`SELECT pax_type, COUNT(*) AS report_count, SUM(pax_count) AS total_pax FROM reports GROUP BY pax_type ORDER BY total_pax DESC`),
    ]);

    res.json({
      thisWeek:        parseInt(week.rows[0].count),
      thisMonth:       parseInt(month.rows[0].count),
      topDestinations: topDest.rows,
      byNationality:   byNat.rows,
      byPaxType:       byType.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    const [upRes, fuRes] = await Promise.all([
      pool.query("SELECT * FROM reports WHERE status = 'under_process' ORDER BY prev_datetime ASC"),
      pool.query("SELECT * FROM reports WHERE status = 'flight_confirmed' ORDER BY new_datetime ASC"),
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
    res.status(500).json({ error: e.message });
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

    const result = {};
    for (const [shiftName, range] of Object.entries(shifts)) {
      const { rows } = await pool.query(
        `SELECT pax_count, pax_id_datetime FROM reports
         WHERE pax_id_datetime >= $1 AND pax_id_datetime < $2
         ORDER BY pax_id_datetime ASC`,
        [range.start, range.end]
      );
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
    res.status(500).json({ error: e.message });
  }
});

// ── GET all reports ────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    autoCloseReports().catch(console.error);
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET single report ──────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST create report ─────────────────────────────────────────────────

router.post('/', upload.array('files', 10), async (req, res) => {
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

    const filePaths = req.files ? req.files.map(f => `/uploads/${f.filename}`) : [];
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
         days_at_airport, pax_count, file_paths, whatsapp_text, submitted_by, status, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
      await pool.query('UPDATE reports SET confirmed_at = $1 WHERE id = $2', [jeddahNowStr(), id]);
    }

    const { rows: reportRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [id]);
    const report = reportRows[0];

    await logAudit({ user: submitted_by || 'staff', action: 'create', reportId: id, snapshot: report });

    res.status(201).json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT full update ────────────────────────────────────────────────────

router.put('/:id', upload.array('files', 10), async (req, res) => {
  try {
    const pool = getDb();
    const { rows: existingRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!existingRows[0]) return res.status(404).json({ error: 'Report not found' });
    const existing = existingRows[0];

    const {
      pax_id_datetime,
      prev_flight, prev_datetime, prev_destination, prev_airline,
      nationality, pax_type,
      new_flight, new_datetime, new_destination, new_airline,
      days_at_airport, pax_count,
      status, comment,
    } = req.body;

    const reportStatus = status || existing.status || 'under_process';

    let filePaths;
    if (req.files && req.files.length > 0) {
      const newPaths = req.files.map(f => `/uploads/${f.filename}`);
      const oldPaths = JSON.parse(existing.file_paths || '[]');
      filePaths = [...oldPaths, ...newPaths];
    } else {
      filePaths = JSON.parse(existing.file_paths || '[]');
    }

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
      await pool.query('UPDATE reports SET confirmed_at = $1 WHERE id = $2', [jeddahNowStr(), req.params.id]);
    }
    if (existing.status !== 'closed' && reportStatus === 'closed' && !existing.closed_at) {
      await pool.query('UPDATE reports SET closed_at = $1 WHERE id = $2', [jeddahNowStr(), req.params.id]);
    }

    const { rows: updatedRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    const updated = updatedRows[0];

    const changes = diffFields(existing, updated, AUDIT_FIELDS);
    if (changes) {
      await logAudit({ user: req.body.submitted_by || 'staff', action: 'edit', reportId: updated.id, changes });
    }

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH update status / fields ──────────────────────────────────────

router.patch('/:id', express.json(), async (req, res) => {
  try {
    const pool = getDb();
    const { rows: existing } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Report not found' });
    const report = existing[0];

    const { status, new_flight, new_datetime, new_destination, new_airline, comment, pax_count } = req.body;

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

    if (updates.length === 0) return res.json(report);

    values.push(req.params.id);
    await pool.query(`UPDATE reports SET ${updates.join(', ')} WHERE id = $${idx}`, values);

    if (status && report.status !== 'flight_confirmed' && status === 'flight_confirmed' && !report.confirmed_at) {
      await pool.query('UPDATE reports SET confirmed_at = $1 WHERE id = $2', [jeddahNowStr(), req.params.id]);
    }
    if (status && report.status !== 'closed' && status === 'closed' && !report.closed_at) {
      await pool.query('UPDATE reports SET closed_at = $1 WHERE id = $2', [jeddahNowStr(), req.params.id]);
    }

    const { rows: updatedRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    const updated = updatedRows[0];

    const changes = diffFields(report, updated, AUDIT_FIELDS);
    if (changes) {
      const action =
        changes.status?.to === 'flight_confirmed' ? 'confirm_flight' :
        changes.status?.to === 'closed'           ? 'close'          :
        changes.status?.to === 'under_process'    ? 'reopen'         : 'edit';
      await logAudit({ user: req.body.submitted_by || 'staff', action, reportId: updated.id, changes });
    }

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE report ──────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
    const report = rows[0];

    try {
      const files = JSON.parse(report.file_paths || '[]');
      files.forEach(fp => {
        const full = path.join(__dirname, '..', fp);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      });
    } catch (_) {}

    await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    await logAudit({ user: req.query.user || 'supervisor', action: 'delete', reportId: report.id, snapshot: report });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Nusuk confirmation ─────────────────────────────────────────────────

router.post('/:id/nusuk', express.json(), async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
    const report = rows[0];

    const { received, user } = req.body;
    const ts = received ? jeddahNowStr() : null;
    const by = received ? (user || 'staff') : null;

    await pool.query('UPDATE reports SET nusuk_received = $1, nusuk_by = $2 WHERE id = $3', [ts, by, req.params.id]);
    await logAudit({
      user: user || 'staff',
      action: received ? 'nusuk_confirm' : 'nusuk_unconfirm',
      reportId: report.id,
      changes: { nusuk_received: { from: report.nusuk_received, to: ts } },
    });

    const { rows: updatedRows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    res.json(updatedRows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;






