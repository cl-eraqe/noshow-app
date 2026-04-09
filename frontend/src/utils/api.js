// Base URL: empty string uses Vite proxy in dev; set VITE_API_URL for production
const BASE = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Auth
export async function login(pin) {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
}

// ── Flights
export async function lookupFlight(flightNumber) {
  return request(`/api/flights/${encodeURIComponent(flightNumber.toUpperCase().trim())}`);
}

// ── Reports
export async function getReports() {
  return request('/api/reports');
}

export async function getReport(id) {
  return request(`/api/reports/${id}`);
}

export async function createReport(formData) {
  // formData is a FormData object (supports file uploads)
  const res = await fetch(`${BASE}/api/reports`, {
    method: 'POST',
    body: formData, // do NOT set Content-Type; browser sets multipart boundary
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function updateReport(id, data) {
  return request(`/api/reports/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateReportFull(id, formData) {
  const res = await fetch(`${BASE}/api/reports/${id}`, {
    method: 'PUT',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteReport(id) {
  return request(`/api/reports/${id}`, { method: 'DELETE' });
}

// ── Analytics
export async function getAnalytics() {
  return request('/api/reports/analytics/summary');
}

// ── Shift Summary
export async function getShiftSummary(date) {
  const params = date ? `?date=${date}` : '';
  return request(`/api/reports/shift-summary${params}`);
}

// ── CEO Report
export async function getCeoReport() {
  return request('/api/reports/ceo-report');
}

// ── Handover Report
export async function getHandoverReport(shift) {
  const params = shift ? `?shift=${shift}` : '';
  return request(`/api/reports/handover${params}`);
}

// ── Airline code → name mapping (client-side, no API call needed)
// Updated from POWERAPP.xlsx — 2026-04-09
const AIRLINE_CODES = {
  // Terminal 1 (20 airlines)
  SV: 'Saudia',
  XY: 'flynas',
  F3: 'Flyadeal',
  QR: 'Qatar Airways',
  EK: 'Emirates',
  KU: 'Kuwait Airways',
  WY: 'Oman Air',
  FZ: 'flydubai',
  AT: 'Royal Air Maroc',
  ME: 'Middle East Airlines',
  A3: 'Aegean',
  MH: 'Malaysia Airlines',
  BA: 'British Airways',
  MS: 'EgyptAir',
  EY: 'Etihad Airways',
  GF: 'Gulf Air',
  RJ: 'Royal Jordanian',
  VF: 'AJet',
  EW: 'Eurowings',
  HU: 'Hainan Airlines',
  // North Terminal (22 airlines)
  G9: 'Air Arabia',
  NE: 'Nesma Airlines',
  IY: 'Yemenia',
  PC: 'Pegasus',
  '3T': 'Tarco Aviation',
  SM: 'Air Cairo',
  J4: 'Badr Airlines',
  ET: 'Ethiopian Airlines',
  NP: 'Nile Air',
  HY: 'Uzbekistan Airways',
  SZ: 'Somon Air',
  RB: 'SyrianAir',
  D3: 'Daallo Airlines',
  SD: 'Sudan Airways',
  DV: 'SCAT Airlines',
  '6E': 'IndiGo',
  AI: 'Air India',
  OV: 'SalamAir',
  IX: 'Air India Express',
  TU: 'Tunisair',
  W9: 'Wizz Air Abu Dhabi',
  E5: 'Air Arabia Egypt',
  // Hajj Terminal (22 airlines)
  PA: 'airblue',
  PF: 'Air Sial',
  BG: 'Biman Bangladesh Airlines',
  AH: 'Air Algérie',
  GA: 'Garuda Indonesia',
  FG: 'Ariana Afghan Airlines',
  BS: 'US-Bangla Airlines',
  '9P': 'Fly Jinnah',
  QP: 'Akasa Air',
  PK: 'Pakistan International Airlines',
  JT: 'Lion Air',
  RQ: 'Kam Air',
  C6: 'Centrum Air',
  TK: 'Turkish Airlines',
  D7: 'AirAsia X',
  '2S': 'Star Peru',
  '7Q': 'Elite Airways',
  BJ: 'Nouvelair',
  BM: 'BMI Regional',
  FH: 'Freebird Airlines',
  UZ: 'Buraq Air',
  XC: 'Corendon Airlines',
  // Other (kept for reference)
  LH: 'Lufthansa',
  AF: 'Air France',
  KL: 'KLM',
  IR: 'Iran Air',
  W5: 'Mahan Air',
  PR: 'Philippine Airlines',
  TG: 'Thai Airways',
  SQ: 'Singapore Airlines',
  KQ: 'Kenya Airways',
};

// ── Terminal mapping (T1 = our terminal, North/Hajj = needs bus 🚌)
// Updated from POWERAPP.xlsx — 2026-04-09
const TERMINAL_MAP = {
  // Terminal 1 — no bus (20 airlines)
  SV: 'T1', XY: 'T1', F3: 'T1', QR: 'T1', EK: 'T1', KU: 'T1',
  WY: 'T1', FZ: 'T1', RJ: 'T1', ME: 'T1', GF: 'T1', EY: 'T1',
  AT: 'T1', VF: 'T1', EW: 'T1', A3: 'T1', MH: 'T1', BA: 'T1',
  MS: 'T1', HU: 'T1',
  // North Terminal — bus needed 🚌 (22 airlines)
  G9: 'North', NE: 'North', IY: 'North', '6E': 'North', PC: 'North',
  '3T': 'North', SM: 'North', J4: 'North', AI: 'North', ET: 'North',
  NP: 'North', HY: 'North', SZ: 'North', RB: 'North', D3: 'North',
  SD: 'North', DV: 'North', OV: 'North', IX: 'North', TU: 'North',
  W9: 'North', E5: 'North',
  // Hajj Terminal — bus needed 🚌 (22 airlines)
  PA: 'Hajj', PF: 'Hajj', BG: 'Hajj', PK: 'Hajj', AH: 'Hajj',
  GA: 'Hajj', FG: 'Hajj', BS: 'Hajj', '9P': 'Hajj', QP: 'Hajj',
  JT: 'Hajj', RQ: 'Hajj', C6: 'Hajj', TK: 'Hajj', D7: 'Hajj',
  '2S': 'Hajj', '7Q': 'Hajj', BJ: 'Hajj', BM: 'Hajj', FH: 'Hajj',
  UZ: 'Hajj', XC: 'Hajj',
};

export function getTerminal(flightNumber) {
  if (!flightNumber) return 'T1';
  const code = getAirlineCode(flightNumber);
  return TERMINAL_MAP[code] || 'T1';
}

export function needsBus(flightNumber) {
  const terminal = getTerminal(flightNumber);
  return terminal === 'North' || terminal === 'Hajj';
}

export function getAirlineCode(flightNumber) {
  if (!flightNumber) return '';
  // IATA airline codes are always 2 characters (e.g. SV, G9, 6E, 3T)
  return flightNumber.toUpperCase().trim().slice(0, 2);
}

export function airlineLogo(flightNumber) {
  const code = getAirlineCode(flightNumber);
  if (!code) return null;
  // Kiwi.com airline logo CDN – small PNGs, widely available
  return `https://images.kiwi.com/airlines/64/${code}.png`;
}

export function airlineFromFlightNumber(flightNumber) {
  if (!flightNumber) return '';
  const fn = flightNumber.toUpperCase().trim();
  // Try 2-char code first, then check if first char + next digit gives a known code
  const twoChar = fn.slice(0, 2);
  if (AIRLINE_CODES[twoChar]) return AIRLINE_CODES[twoChar];
  // Some airlines use digit+letter (e.g. 6E)
  const threeChar = fn.slice(0, 3);
  if (AIRLINE_CODES[threeChar]) return AIRLINE_CODES[threeChar];
  return twoChar; // fallback: return raw code
}
