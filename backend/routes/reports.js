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

module.exports = router;
