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

module.exports = router;


