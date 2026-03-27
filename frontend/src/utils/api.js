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
