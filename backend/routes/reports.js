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

// ── Terminal mapping (T1 = ours, North/Hajj = bus needed)
// Updated from POWERAPP.xlsx — 2026-04-09
const TERMINAL_MAP = {
  // T1 (20)
  SV:'T1',XY:'T1',F3:'T1',QR:'T1',EK:'T1',KU:'T1',WY:'T1',FZ:'T1',
  RJ:'T1',ME:'T1',GF:'T1',EY:'T1',AT:'T1',VF:'T1',EW:'T1',
  A3:'T1',MH:'T1',BA:'T1',MS:'T1',HU:'T1',
  // North (22)
  G9:'North',NE:'North',IY:'North','6E':'North',PC:'North','3T':'North',
  SM:'North',J4:'North',AI:'North',ET:'North',NP:'North',HY:'North',
  SZ:'North',RB:'North',D3:'North',SD:'North',DV:'North',
  OV:'North',IX:'North',TU:'North',W9:'North',E5:'North',
  // Hajj (22)
  PA:'Hajj',PF:'Hajj',BG:'Hajj',PK:'Hajj',AH:'Hajj',
  GA:'Hajj',FG:'Hajj',BS:'Hajj','9P':'Hajj',QP:'Hajj',
  JT:'Hajj',RQ:'Hajj',C6:'Hajj',TK:'Hajj',D7:'Hajj',
  '2S':'Hajj','7Q':'Hajj',BJ:'Hajj',BM:'Hajj',FH:'Hajj',
  UZ:'Hajj',XC:'Hajj',
};

function getAirlineCode(flight) {
  if (!flight) return '';
  // IATA codes are always first 2 characters (e.g. SV, G9, 6E, 3T)
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
  const d = new Date(dt);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return String(d.getDate()).padStart(2, '0') + months[d.getMonth()];
}

function fmtTimeShort(dt) {
  if (!dt) return '????';
  const d = new Date(dt);
  return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
}

// ── Handover Report (must be before /:id)
router.get('/handover', (req, res) => {
  const db = getDb();
  autoCloseReports();
  const now = new Date();

  // Use Jeddah time (UTC+3) for auto-detect
  const jeddahHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })).getHours();

  // Allow caller to pick the shift, otherwise auto-detect from Jeddah time
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

  // All active reports
  const underProcess = db.prepare("SELECT * FROM reports WHERE status = 'under_process' ORDER BY prev_datetime ASC").all();
  const flightConfirmed = db.prepare("SELECT * FROM reports WHERE status = 'flight_confirmed' ORDER BY new_datetime ASC").all();

  const threeHoursFromNow = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Group under_process by airline (SV first, then others)
  const upSV = underProcess.filter(r => getAirlineCode(r.prev_flight) === 'SV');
  const upOther = underProcess.filter(r => getAirlineCode(r.prev_flight) !== 'SV');

  // Group follow-up by airline
  const fuSV = flightConfirmed.filter(r => getAirlineCode(r.prev_flight) === 'SV');
  const fuOther = flightConfirmed.filter(r => getAirlineCode(r.prev_flight) !== 'SV');

  // Departing soon (within 3 hours)
  const departingSoon = flightConfirmed.filter(r =>
    r.new_datetime && r.new_datetime <= threeHoursFromNow && r.new_datetime > now.toISOString()
  );

  // Bus transfers (flight_confirmed with new flight from North/Hajj terminal)
  const busTransfers = flightConfirmed.filter(r => needsBus(r.new_flight));

  // Over 24hrs (not closed)
  const over24 = [...underProcess, ...flightConfirmed].filter(r =>
    r.prev_datetime && r.prev_datetime < twentyFourHoursAgo
  );

  // Format a single report line
  function fmtReport(r, showNewFlight = false) {
    const count = String(r.pax_count || 1).padStart(2, '0');
    const paxType = (r.pax_type || 'Unknown').toUpperCase();
    const dest = iataCode(r.prev_destination);
    const airline = getAirlineCode(r.prev_flight);
    const prevDate = fmtDateShort(r.prev_datetime);
    const prevTime = fmtTimeShort(r.prev_datetime);
    const bus = needsBus(r.new_flight) ? ' 🚌' : '';

    let line = `${count}PAX ${paxType} ${airline} ${dest} ${prevDate} STD ${prevTime}`;

    if (showNewFlight && r.status === 'flight_confirmed' && r.new_flight) {
      const newDate = fmtDateShort(r.new_datetime);
      const newTime = fmtTimeShort(r.new_datetime);
      const terminal = getTerminal(r.new_flight);
      const terminalNote = terminal !== 'T1' ? ` (${terminal})` : '';
      line += `\n- ALT FLT ${r.new_flight} STD ${newTime} ${newDate} ✅${terminalNote}${bus}`;
    }

    if (r.comment) {
      line += `\n   → ${r.comment}`;
    }

    line += ` #${r.id}`;

    return line;
  }

  // Build sections
  const lines = [];

  lines.push(`📋 SHIFT HANDOVER ${currentShift} → ${nextShift}`);
  lines.push(`${fmtDateShort(now.toISOString())} ${fmtTimeShort(now.toISOString())}`);
  lines.push('');

  // Departing soon
  if (departingSoon.length > 0) {
    lines.push('━━ ⏰ DEPARTING SOON (< 3hrs) ━━');
    lines.push('');
    departingSoon.forEach(r => {
      const bus = needsBus(r.new_flight) ? ' 🚌' : '';
      const terminal = getTerminal(r.new_flight);
      const termNote = terminal !== 'T1' ? ` (${terminal})` : '';
      lines.push(`${String(r.pax_count || 1).padStart(2, '0')}PAX ${r.new_flight} ${iataCode(r.new_destination)} → STD ${fmtTimeShort(r.new_datetime)} TODAY${termNote}${bus} #${r.id}`);
      if (r.comment) lines.push(`   → ${r.comment}`);
    });
    lines.push('');
  }

  // Bus transfers
  if (busTransfers.length > 0) {
    lines.push('━━ 🚌 BUS TRANSFER NEEDED ━━');
    lines.push('');
    busTransfers.forEach(r => {
      const terminal = getTerminal(r.new_flight);
      lines.push(`${String(r.pax_count || 1).padStart(2, '0')}PAX → ${r.new_flight} ${iataCode(r.new_destination)} STD ${fmtTimeShort(r.new_datetime)} ${fmtDateShort(r.new_datetime)} (${terminal}) #${r.id}`);
      if (r.comment) lines.push(`   → ${r.comment}`);
    });
    lines.push('');
  }

  // Under process SV
  if (upSV.length > 0) {
    lines.push('━━ UNDER PROCESS SV ━━');
    lines.push('');
    upSV.forEach(r => lines.push(fmtReport(r)));
    lines.push('');
  }

  // Under process other
  if (upOther.length > 0) {
    lines.push('━━ UNDER PROCESS OTHER AIRLINES ━━');
    lines.push('');
    upOther.forEach(r => lines.push(fmtReport(r)));
    lines.push('');
  }

  // Follow up SV
  if (fuSV.length > 0) {
    lines.push('━━ FOLLOW UP SV ━━');
    lines.push('');
    fuSV.forEach(r => lines.push(fmtReport(r, true)));
    lines.push('');
  }

  // Follow up other
  if (fuOther.length > 0) {
    lines.push('━━ FOLLOW UP OTHER AIRLINES ━━');
    lines.push('');
    fuOther.forEach(r => lines.push(fmtReport(r, true)));
    lines.push('');
  }

  // Over 24hrs
  if (over24.length > 0) {
    lines.push('━━ ⚠ OVER 24HRS ━━');
    lines.push('');
    over24.forEach(r => {
      const days = ((Date.now() - new Date(r.prev_datetime).getTime()) / (1000*60*60*24)).toFixed(0);
      lines.push(fmtReport(r, true) + ` (${days} days)`);
    });
    lines.push('');
  }

  // Summary
  const totalUp = underProcess.reduce((s, r) => s + (r.pax_count || 0), 0);
  const totalFu = flightConfirmed.reduce((s, r) => s + (r.pax_count || 0), 0);
  lines.push('━━ SUMMARY ━━');
  lines.push(`Under Process: ${underProcess.length} cases (${totalUp} PAX)`);
  lines.push(`Flight Confirmed: ${flightConfirmed.length} cases (${totalFu} PAX)`);
  lines.push(`Total Active: ${underProcess.length + flightConfirmed.length} cases (${totalUp + totalFu} PAX)`);

  const text = lines.join('\n');
  res.json({ text, shift: { current: currentShift, next: nextShift } });
});

// ── CEO Report (must be before /:id)
router.get('/ceo-report', (_req, res) => {
  const db = getDb();
  const now = new Date();
  const nowISO = now.toISOString();
  const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const twelveHoursFromNow = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Helper: format date as "23MAR"
  function fmtDate(dt) {
    if (!dt) return '??';
    const d = new Date(dt);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return String(d.getDate()).padStart(2, '0') + months[d.getMonth()];
  }

  // Helper: format time as "0945"
  function fmtTime(dt) {
    if (!dt) return '????';
    const d = new Date(dt);
    return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  // Helper: extract IATA code from destination like "Cairo (CAI)" → "CAI"
  function iataCode(dest) {
    if (!dest) return '???';
    const match = dest.match(/\(([A-Z]{3})\)/);
    return match ? match[1] : dest.slice(0, 3).toUpperCase();
  }

  // Helper: extract airline code from flight number "SV309" → "SV"
  function airlineCode(flight) {
    if (!flight) return '??';
    return flight.replace(/[0-9]/g, '').trim() || flight.slice(0, 2);
  }

  // 1. Process completed and departed — closed + new_datetime within last 12 hrs
  const completedRows = db.prepare(`
    SELECT * FROM reports
    WHERE status = 'closed'
      AND new_datetime IS NOT NULL AND new_datetime != ''
      AND new_datetime >= ? AND new_datetime <= ?
  `).all(twelveHoursAgo, nowISO);
  const completedPax = completedRows.reduce((s, r) => s + (r.pax_count || 0), 0);

  // 2. Cancelled Stamp — always 0
  const cancelledPax = 0;

  // 3. Flight confirmed, departs within 12 hrs
  const departSoonRows = db.prepare(`
    SELECT * FROM reports
    WHERE status = 'flight_confirmed'
      AND new_datetime IS NOT NULL AND new_datetime != ''
      AND new_datetime > ? AND new_datetime <= ?
  `).all(nowISO, twelveHoursFromNow);
  const departSoonPax = departSoonRows.reduce((s, r) => s + (r.pax_count || 0), 0);

  // 4. Flight confirmed, departs after 12 hrs
  const departLaterRows = db.prepare(`
    SELECT * FROM reports
    WHERE status = 'flight_confirmed'
      AND new_datetime IS NOT NULL AND new_datetime != ''
      AND new_datetime > ?
  `).all(twelveHoursFromNow);
  const departLaterPax = departLaterRows.reduce((s, r) => s + (r.pax_count || 0), 0);

  // 5. Under process
  const underProcessRows = db.prepare(`
    SELECT * FROM reports WHERE status = 'under_process'
  `).all();
  const underProcessPax = underProcessRows.reduce((s, r) => s + (r.pax_count || 0), 0);

  // 6. Refusal — always 0
  const refusalPax = 0;

  // 7. Over 24hrs — not closed, prev_datetime > 24hrs ago
  const over24Rows = db.prepare(`
    SELECT * FROM reports
    WHERE status IN ('under_process', 'flight_confirmed')
      AND prev_datetime IS NOT NULL AND prev_datetime != ''
      AND prev_datetime < ?
    ORDER BY prev_datetime ASC
  `).all(twentyFourHoursAgo);
  const over24Pax = over24Rows.reduce((s, r) => s + (r.pax_count || 0), 0);

  // Build detailed lines for over 24hrs
  const over24Lines = over24Rows.map(r => {
    const count = String(r.pax_count || 1).padStart(2, '0');
    const paxType = (r.pax_type || 'Unknown').toUpperCase();
    const airline = airlineCode(r.prev_flight);
    const dest = iataCode(r.prev_destination);
    const prevDate = fmtDate(r.prev_datetime);
    const prevTime = fmtTime(r.prev_datetime);
    let line = `${count}PAX ${paxType} ${airline} ${dest} ${prevDate} STD ${prevTime}`;

    if (r.status === 'flight_confirmed' && r.new_flight) {
      const newDate = fmtDate(r.new_datetime);
      const newTime = fmtTime(r.new_datetime);
      line += `\nNEW FLT✅ ${newDate} STD ${newTime}`;
    }
    return line;
  });

  // Build full report text
  const text = [
    `*Process completed and departed*`,
    ``,
    `${String(completedPax).padStart(2, '0')}PAX`,
    ``,
    `*Cancelled Stamp*`,
    ``,
    `${String(cancelledPax).padStart(2, '0')}PAX`,
    ``,
    `*Currently at airport and being supported with alternative flight and will depart in less than 12 hrs*`,
    ``,
    `${String(departSoonPax).padStart(2, '0')}PAX`,
    ``,
    `*Currently at airport and being supported with alternative flight and will depart after 12 hrs*`,
    ``,
    `${String(departLaterPax).padStart(2, '0')}PAX`,
    ``,
    `*Under process to rebook the flight by airlines*`,
    ``,
    `${String(underProcessPax).padStart(2, '0')} PAX`,
    ``,
    `*Passengers spend 12 hrs or more with refusal to support by airline*`,
    ``,
    `${String(refusalPax).padStart(2, '0')}PAX`,
    ``,
    `*Passengers at airport over 24hrs*`,
    ``,
    `${String(over24Pax).padStart(2, '0')}PAX`,
    ``,
    ...over24Lines,
  ].join('\n');

  res.json({
    text,
    sections: {
      completed: completedPax,
      cancelled: cancelledPax,
      departSoon: departSoonPax,
      departLater: departLaterPax,
      underProcess: underProcessPax,
      refusal: refusalPax,
      over24: over24Pax,
      over24Details: over24Lines,
    },
  });
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

// ── Seed test data (temporary, for testing)
router.post('/seed-test-data', (_req, res) => {
  const db = getDb();
  const now = new Date();
  const ha = (h) => new Date(now.getTime() - h*60*60*1000).toISOString().slice(0,16);
  const hf = (h) => new Date(now.getTime() + h*60*60*1000).toISOString().slice(0,16);
  const da = (d) => new Date(now.getTime() - d*24*60*60*1000).toISOString().slice(0,16);

  const insert = db.prepare(`INSERT INTO reports (pax_id_datetime,prev_flight,prev_datetime,prev_destination,prev_airline,nationality,pax_type,new_flight,new_datetime,new_destination,new_airline,days_at_airport,pax_count,whatsapp_text,submitted_by,status,comment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'','staff',?,?)`);

  const data = [
    // CLOSED departed <12hrs (CEO section 1)
    [ha(8),'SV305',da(2),'Cairo (CAI)','Saudia','Egyptian','Umrah','SV309',ha(3),'Cairo (CAI)','Saudia',2,4,'closed','Family group'],
    [ha(10),'TK95',da(1),'Istanbul (IST)','Turkish Airlines','Turkish','Tourist','TK95',ha(2),'Istanbul (IST)','Turkish Airlines',1,2,'closed',''],
    [ha(6),'MS986',da(1),'Cairo (CAI)','EgyptAir','Egyptian','Umrah','SV305',ha(5),'Cairo (CAI)','Saudia',1,3,'closed',''],
    [ha(7),'PK751',da(1),'Karachi (KHI)','PIA','Pakistani','Umrah','PK752',ha(4),'Karachi (KHI)','PIA',1,5,'closed','Large group'],
    // CONFIRMED depart <12hrs (CEO section 3)
    [ha(18),'SV796',da(2),'Peshawar (PEW)','Saudia','Pakistani','Umrah','SV796',hf(4),'Peshawar (PEW)','Saudia',2,6,'flight_confirmed',''],
    [ha(12),'EK802',da(1),'Dubai (DXB)','Emirates','Indian','Transit','EK803',hf(6),'Dubai (DXB)','Emirates',1,3,'flight_confirmed','Transit to Mumbai'],
    [ha(9),'SV305',da(1),'Cairo (CAI)','Saudia','Egyptian','Umrah','SV309',hf(8),'Cairo (CAI)','Saudia',1,8,'flight_confirmed',''],
    // CONFIRMED depart >12hrs (CEO section 4)
    [ha(30),'SV305',da(3),'Cairo (CAI)','Saudia','Egyptian','Umrah','SV305',hf(24),'Cairo (CAI)','Saudia',3,11,'flight_confirmed','Waiting for next SV flight'],
    [ha(48),'F3777',da(2),'Algiers (ALG)','Flyadeal','Algerian','Umrah','F3777',hf(36),'Algiers (ALG)','Flyadeal',2,11,'flight_confirmed','Group from same tour'],
    [ha(36),'TK95',da(2),'Istanbul (IST)','Turkish Airlines','Turkish','Tourist','TK95',hf(14),'Istanbul (IST)','Turkish Airlines',2,4,'flight_confirmed',''],
    [ha(40),'PK796',da(2),'Lahore (LHE)','PIA','Pakistani','Umrah','PK797',hf(20),'Lahore (LHE)','PIA',2,15,'flight_confirmed',''],
    [ha(24),'GF154',da(1),'Bahrain (BAH)','Gulf Air','Bahraini','Family Visit','GF155',hf(18),'Bahrain (BAH)','Gulf Air',1,7,'flight_confirmed',''],
    [ha(28),'QR1168',da(1),'Doha (DOH)','Qatar Airways','Indian','Transit','QR1169',hf(30),'Doha (DOH)','Qatar Airways',1,9,'flight_confirmed','Transit to Kerala'],
    [ha(20),'ET416',da(1),'Addis Ababa (ADD)','Ethiopian Airlines','Ethiopian','Resident','ET417',hf(16),'Addis Ababa (ADD)','Ethiopian Airlines',1,6,'flight_confirmed',''],
    [ha(32),'AI902',da(2),'Mumbai (BOM)','Air India','Indian','Umrah','AI903',hf(22),'Mumbai (BOM)','Air India',2,10,'flight_confirmed',''],
    // UNDER PROCESS (CEO section 5)
    [ha(3),'SV309',ha(4),'Cairo (CAI)','Saudia','Egyptian','Umrah',null,null,null,null,null,4,'under_process','Contacted airline'],
    [ha(2),'TK95',ha(3),'Istanbul (IST)','Turkish Airlines','Turkish','Tourist',null,null,null,null,null,1,'under_process',''],
    [ha(5),'MS986',ha(6),'Cairo (CAI)','EgyptAir','Egyptian','Umrah',null,null,null,null,null,6,'under_process','EgyptAir counter closed'],
    [ha(1),'EK802',ha(2),'Dubai (DXB)','Emirates','Indian','Transit',null,null,null,null,null,2,'under_process',''],
    [ha(4),'BG402',ha(5),'Dhaka (DAC)','Biman Bangladesh','Bangladeshi','Umrah',null,null,null,null,null,3,'under_process',''],
    [ha(6),'XY205',ha(8),'Cairo (CAI)','flynas','Egyptian','Umrah',null,null,null,null,null,5,'under_process',''],
    [ha(2),'SV796',ha(3),'Peshawar (PEW)','Saudia','Pakistani','Umrah',null,null,null,null,null,5,'under_process',''],
    // UNDER PROCESS over 24hrs (CEO section 7 detail)
    [da(2),'SV305',da(3),'Cairo (CAI)','Saudia','Egyptian','Umrah',null,null,null,null,null,2,'under_process','Airline not responding'],
    [da(1.5),'PK751',da(2),'Karachi (KHI)','PIA','Pakistani','Umrah',null,null,null,null,null,3,'under_process','No seats on next PIA flights'],
    // Old closed (should NOT show in CEO section 1)
    [da(3),'SV309',da(4),'Cairo (CAI)','Saudia','Egyptian','Umrah','SV305',da(2),'Cairo (CAI)','Saudia',2,7,'closed',''],
    [da(5),'TK95',da(6),'Istanbul (IST)','Turkish Airlines','Turkish','Resident','TK95',da(4),'Istanbul (IST)','Turkish Airlines',2,1,'closed',''],
  ];

  const tx = db.transaction(() => {
    for (const r of data) {
      insert.run(...r);
    }
  });
  tx();

  const count = db.prepare('SELECT COUNT(*) as c FROM reports').get();
  res.json({ success: true, inserted: data.length, total: count.c });
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

  const { status, new_flight, new_datetime, new_destination, new_airline, comment, pax_count } = req.body;

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
  if (pax_count !== undefined) {
    updates.push('pax_count = ?');
    values.push(parseInt(pax_count) || 0);
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
  const finalPaxCount = pax_count !== undefined ? (parseInt(pax_count) || 0) : report.pax_count;
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
