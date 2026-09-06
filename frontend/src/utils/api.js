import { clearRole, clearToken, getToken } from './auth';

// Base URL: empty string uses Vite proxy in dev; set VITE_API_URL for production
const BASE = import.meta.env.VITE_API_URL || '';

function authHeaders(extra = {}) {
  const token = getToken();
  return token
    ? { Authorization: `Bearer ${token}`, ...extra }
    : { ...extra };
}

async function request(path, options = {}) {
  const opts = {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  };
  const res = await fetch(`${BASE}${path}`, opts);
  if (res.status === 401) {
    clearRole();
    clearToken();
    // username intentionally kept so the login page can pre-fill it
    window.location.replace('/login');
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Download a protected file by fetching with auth token, then triggering a browser download
export async function downloadFile(filePath, saveName) {
  const filename = filePath.split('/').pop();
  const res = await fetch(`${BASE}/api/files/${encodeURIComponent(filename)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = saveName || filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Get a temporary object URL for previewing a file inline (images, PDFs)
export async function getFileObjectUrl(filePath) {
  const filename = filePath.split('/').pop();
  const res = await fetch(`${BASE}/api/files/${encodeURIComponent(filename)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), type: blob.type };
}

// ── Auth
export async function login(name, pin) {
  return fetch(`${BASE}/api/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, pin }),
  }).then(async res => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
}

export async function registerUser(inviteToken, name, pin) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ token: inviteToken, name, pin }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function checkInvite(token) {
  const res = await fetch(`${BASE}/api/auth/invite/${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function apiLogout() {
  // Bearer token — just clear client-side state (no server call needed)
}

// ── Flights
//
// direction: 'past' for the previous flight (the most recent departure already
// gone) or 'future' for the new one (the next still to come). `on` pins a
// specific YYYY-MM-DD, used when the user edits the date by hand.
export async function lookupFlight(flightNumber, { direction = 'past', on = null } = {}) {
  const key = flightNumber.toUpperCase().trim();
  const q = new URLSearchParams({ direction: direction === 'future' ? 'future' : 'past' });
  // Only a real date is forwarded. These handlers hang off DOM events, and a
  // stray event object stringifies to "[object Object]" — which the server
  // would reject, silently turning a good lookup into "not found".
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(on || ''))) q.set('on', on);
  const data = await request(`/api/flights/${encodeURIComponent(key)}?${q}`);

  // Terminal precedence: a live KAIA value wins, because it is the only source
  // that knows about a terminal opening (T4) or an airline moving between
  // them. flights.json and the airline-code map only fill the gap behind it.
  await loadTerminalsCache().catch(() => {});
  if (!VALID_TERMINALS.has(data.terminal)) {
    const cached = _terminalCache?.[key];
    data.terminal = VALID_TERMINALS.has(cached)
      ? cached
      : (TERMINAL_MAP[key.slice(0, 2)] || 'T1');
  }
  return data;
}

// ── Reports
// scope: 'T1' | 'North' | 'All' (or omitted) — only meaningful for a
// supervisor; normal users are always forced server-side to their own
// assigned terminal regardless of what's passed here.
export async function getReports(scope) {
  const q = scope && scope !== 'All' ? `?scope=${encodeURIComponent(scope)}` : '';
  return request(`/api/reports${q}`);
}

export async function getReport(id) {
  return request(`/api/reports/${id}`);
}

export async function createReport(formData) {
  const res = await fetch(`${BASE}/api/reports`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData, // do NOT set Content-Type; browser sets multipart boundary
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteReportFile(reportId, filename) {
  return request(`/api/reports/${reportId}/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
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
    headers: authHeaders(),
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

// Nusuk confirmation (Ministry of Hajj & Umrah received pax)
export async function confirmNusuk(id, received, user) {
  return request(`/api/reports/${id}/nusuk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ received, user }),
  });
}

// Attach files (from Web Share Target or any source) to an existing report
export async function attachFilesToReport(id, fileList, user) {
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f, f.name);
  if (user) fd.append('user', user);
  const res = await fetch(`${BASE}/api/reports/${id}/files`, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Read files that were shared into the app via the Web Share Target API.
// These live in the service worker's SHARE_CACHE keyed under /__share__/...
export async function readSharedFiles() {
  try {
    const manifestRes = await fetch('/__share__/manifest', { cache: 'no-store' });
    if (!manifestRes.ok) return [];
    const manifest = await manifestRes.json();
    const files = await Promise.all(manifest.map(async ({ url, name, type }) => {
      const r = await fetch(url, { cache: 'no-store' });
      const blob = await r.blob();
      return new File([blob], name, { type: type || blob.type });
    }));
    return files;
  } catch {
    return [];
  }
}

// ── Analytics
export async function getAnalytics(scope) {
  const q = scope && scope !== 'All' ? `?scope=${encodeURIComponent(scope)}` : '';
  return request(`/api/reports/analytics/summary${q}`);
}

export async function getDashboardData(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
  return request(`/api/analytics/dashboard?${params.toString()}`);
}

export async function getFilterOptions(scope) {
  const q = scope && scope !== 'All' ? `?scope=${encodeURIComponent(scope)}` : '';
  return request(`/api/analytics/filter-options${q}`);
}

// ── Flight Manager (supervisor)
export async function getCustomFlights() {
  return request('/api/flights/custom/list');
}

// Airline codes KAIA reported that the app has no approved name for. Until a
// supervisor names one, reports for it keep an empty airline — an unreviewed
// name would split the airline in two in analytics and lose its logo.
export async function getPendingAirlines() {
  return request('/api/flights/airlines/pending');
}
export async function approveAirline(code, name, backfill) {
  return request(`/api/flights/airlines/${encodeURIComponent(code)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, backfill: !!backfill }),
  });
}
export async function ignoreAirline(code) {
  return request(`/api/flights/airlines/${encodeURIComponent(code)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ignored' }),
  });
}
export async function getKaiaStatus() {
  return request('/api/flights/kaia/status');
}
export async function saveFlight(data) {
  return request('/api/flights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
export async function deleteFlight(flightNumber) {
  return request(`/api/flights/${flightNumber}`, { method: 'DELETE' });
}

export async function getAuditLog(reportId) {
  const q = reportId ? `?report_id=${reportId}` : '';
  return request(`/api/analytics/audit-log${q}`);
}

// ── Export tokens (supervisor management)
export async function getExportTokens() {
  return request('/api/export/tokens');
}
export async function createExportToken(email, role = 'view') {
  return request('/api/export/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
}
export async function revokeExportToken(id, revoked) {
  return request(`/api/export/tokens/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revoked }),
  });
}
export async function rotateExportToken(id) {
  return request(`/api/export/tokens/${id}/rotate`, { method: 'POST' });
}
export async function deleteExportToken(id) {
  return request(`/api/export/tokens/${id}`, { method: 'DELETE' });
}

// ── User management (supervisor)
export async function getUsers() {
  return request('/api/users');
}
export async function setUserActive(id, active) {
  return request(`/api/users/${id}/active`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
}
export async function resetUserPin(id, pin) {
  return request(`/api/users/${id}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
}
export async function deleteUser(id) {
  return request(`/api/users/${id}`, { method: 'DELETE' });
}
export async function setUserTerminal(id, terminal) {
  return request(`/api/users/${id}/terminal`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal }),
  });
}
export async function createInvite(role, terminal) {
  return request('/api/users/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, terminal }),
  });
}
export async function getInvites() {
  return request('/api/users/invites');
}
export async function deleteInvite(id) {
  return request(`/api/users/invites/${id}`, { method: 'DELETE' });
}

// Convert a server-relative path (e.g. "/api/airline-brands/file/SV.png")
// into an absolute URL pointing at the backend. The dashboard renders these
// directly in <img src>, and without this they'd hit Vercel's origin (where
// /api/* doesn't exist) instead of Railway.
export function absoluteApiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;          // already absolute
  if (!path.startsWith('/api/')) return path;            // /airlines/SV.png stays on Vercel
  return `${BASE}${path}`;
}

// ── Airline brand management (supervisor)
// Returns just the overrides (keyed by IATA). The frontend merges them with
// its bundled defaults in airline-brands.json.
export async function getAirlineBrandOverrides() {
  const out = await request('/api/airline-brands/overrides');
  for (const ov of Object.values(out || {})) {
    if (ov.logo)   ov.logo   = absoluteApiUrl(ov.logo);
    if (ov.avatar) ov.avatar = absoluteApiUrl(ov.avatar);
  }
  return out;
}

export async function uploadAirlineLogo(iata, file) {
  const fd = new FormData();
  fd.append('logo', file, file.name);
  const res = await fetch(`${BASE}/api/airline-brands/${encodeURIComponent(iata)}/logo`, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.logo)   data.logo   = absoluteApiUrl(data.logo);
  if (data.avatar) data.avatar = absoluteApiUrl(data.avatar);
  return data;
}

export async function revertAirlineLogo(iata) {
  return request(`/api/airline-brands/${encodeURIComponent(iata)}/logo`, { method: 'DELETE' });
}

// ── Shift Summary
// The Shift Summary button was removed from the Dashboard header (its slot now
// holds the terminal filter), so this currently has no callers. The backend
// endpoint is still live and terminal-scoped — kept here so the feature can be
// re-surfaced elsewhere without rebuilding the client call.
export async function getShiftSummary(date, scope) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (scope && scope !== 'All') params.set('scope', scope);
  const qs = params.toString();
  return request(`/api/reports/shift-summary${qs ? `?${qs}` : ''}`);
}

// ── Handover Report
export async function getHandoverReport(shift, scope) {
  const params = new URLSearchParams();
  if (shift) params.set('shift', shift);
  if (scope && scope !== 'All') params.set('scope', scope);
  const qs = params.toString();
  return request(`/api/reports/handover${qs ? `?${qs}` : ''}`);
}

// ── Airline code → name mapping (client-side, no API call needed)
// Updated from POWERAPP.xlsx — 2026-04-09
export const AIRLINE_CODES = {
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
  J9: 'Jazeera Airways',
  ER: 'SereneAir',
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
  W9: 'North', E5: 'North', J9: 'North',
  // Hajj Terminal — bus needed 🚌
  PA: 'Hajj', PF: 'Hajj', BG: 'Hajj', PK: 'Hajj', AH: 'Hajj',
  GA: 'Hajj', FG: 'Hajj', BS: 'Hajj', '9P': 'Hajj', QP: 'Hajj',
  JT: 'Hajj', RQ: 'Hajj', C6: 'Hajj', TK: 'T1', D7: 'Hajj',
  '2S': 'Hajj', '7Q': 'Hajj', BJ: 'Hajj', BM: 'Hajj', FH: 'Hajj',
  UZ: 'Hajj', XC: 'Hajj', ER: 'Hajj', DH: 'Hajj',
};

// Cache of per-flight terminals from flights.json (loaded once after login)
let _terminalCache = null;
let _terminalCachePromise = null;
// T4 is included ahead of the terminal opening: KAIA starts reporting a new
// terminal from its first operational day, and a value missing from this set
// is discarded and replaced by a guess from the airline-code map.
const VALID_TERMINALS = new Set(['T1', 'Hajj', 'North', 'T4']);

// Terminals a passenger has to be bussed to.
const BUS_TERMINALS = new Set(['North', 'Hajj', 'T4']);

export async function loadTerminalsCache(force = false) {
  if (_terminalCache && !force) return _terminalCache;
  if (_terminalCachePromise) return _terminalCachePromise;
  _terminalCachePromise = fetch(`${BASE}/api/flights/terminals`, { credentials: 'include' })
    .then(r => r.ok ? r.json() : {})
    .then(map => { _terminalCache = map; _terminalCachePromise = null; return map; })
    .catch(() => { _terminalCachePromise = null; return {}; });
  return _terminalCachePromise;
}

export function getTerminal(flightNumber) {
  if (!flightNumber) return 'T1';
  const upper = String(flightNumber).toUpperCase().trim();
  // Primary source: per-flight terminal from flights.json (cached)
  const cached = _terminalCache?.[upper];
  if (cached && VALID_TERMINALS.has(cached)) return cached;
  // Fallback: airline-code mapping (used when cache miss or not yet loaded)
  const code = getAirlineCode(upper);
  return TERMINAL_MAP[code] || 'T1';
}

export function needsBus(flightNumber) {
  return BUS_TERMINALS.has(getTerminal(flightNumber));
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

// Reverse lookup: airline display name → IATA code (the first match wins).
// Used so the dashboard can upload a logo for any airline shown in the chart,
// even ones that don't have a bundled-default entry in airline-brands.json.
export function iataForAirlineName(name) {
  if (!name) return null;
  for (const [iata, n] of Object.entries(AIRLINE_CODES)) {
    if (n === name) return iata;
  }
  return null;
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
