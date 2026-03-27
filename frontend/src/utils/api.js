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
export async function getHandoverReport() {
  return request('/api/reports/handover');
}

// ── Airline code → name mapping (client-side, no API call needed)
const AIRLINE_CODES = {
  SV: 'Saudia',
  TK: 'Turkish Airlines',
  EK: 'Emirates',
  QR: 'Qatar Airways',
  ET: 'Ethiopian Airlines',
  MS: 'EgyptAir',
  FZ: 'flydubai',
  PK: 'Pakistan International Airlines',
  GF: 'Gulf Air',
  WY: 'Oman Air',
  OV: 'SalamAir',
  BA: 'British Airways',
  LH: 'Lufthansa',
  AF: 'Air France',
  KL: 'KLM',
  XY: 'flynas',
  F3: 'Flyadeal',
  J9: 'Jazeera Airways',
  G9: 'Air Arabia',
  RJ: 'Royal Jordanian',
  ME: 'Middle East Airlines',
  IR: 'Iran Air',
  W5: 'Mahan Air',
  AI: 'Air India',
  IX: 'Air India Express',
  '6E': 'IndiGo',
  BG: 'Biman Bangladesh Airlines',
  UL: 'SriLankan Airlines',
  PR: 'Philippine Airlines',
  GA: 'Garuda Indonesia',
  MH: 'Malaysia Airlines',
  TG: 'Thai Airways',
  SQ: 'Singapore Airlines',
  KQ: 'Kenya Airways',
};

// ── Terminal mapping (T1 = our terminal, North/Hajj = needs bus 🚌)
const TERMINAL_MAP = {
  // Terminal 1 — no bus
  SV: 'T1', XY: 'T1', F3: 'T1', QR: 'T1', EK: 'T1', KU: 'T1',
  WY: 'T1', FZ: 'T1', RJ: 'T1', ME: 'T1', AZ: 'T1', TK: 'T1',
  GF: 'T1', EY: 'T1', '9W': 'T1', TR: 'T1', EW: 'T1', HV: 'T1',
  BI: 'T1', KC: 'T1', A3: 'T1', MH: 'T1', BA: 'T1', MS: 'T1',
  // North Terminal — bus needed
  G9: 'North', NE: 'North', IY: 'North', '6E': 'North', PC: 'North',
  '3T': 'North', SM: 'North', J4: 'North', AI: 'North', ET: 'North',
  NP: 'North', HY: 'North', W6: 'North', W4: 'North', OV: 'North',
  IX: 'North', J2: 'North', SZ: 'North', RB: 'North', UJ: 'North',
  UL: 'North', D3: 'North', SD: 'North', DV: 'North', J9: 'North',
  UK: 'North', TU: 'North',
  // Hajj Terminal — bus needed
  PA: 'Hajj', PF: 'Hajj', BG: 'Hajj', PK: 'Hajj', ER: 'Hajj',
  AH: 'Hajj', GA: 'Hajj', JT: 'Hajj', ID: 'Hajj', VM: 'Hajj',
  RQ: 'Hajj', T5: 'Hajj', BS: 'Hajj', '9P': 'Hajj', QP: 'Hajj',
  HC: 'Hajj', R5: 'Hajj',
};

export function getTerminal(flightNumber) {
  if (!flightNumber) return 'T1';
  const code = flightNumber.toUpperCase().trim().replace(/[0-9]/g, '').trim();
  return TERMINAL_MAP[code] || 'T1';
}

export function needsBus(flightNumber) {
  const terminal = getTerminal(flightNumber);
  return terminal === 'North' || terminal === 'Hajj';
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
