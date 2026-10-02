// A flight's departure terminal, and whether its passenger needs a bus.
//
// flights.json has the terminal per flight and comes first. The airline table
// below is only the fallback for a flight that is not in it: one airline can
// fly from two terminals (SV regular from T1, SV2xxx from Hajj), so the table
// alone put every Saudia Hajj charter in T1 with no bus.
//
// The app keeps the same table in frontend/src/utils/api.js for its badges.
// Change both together.

const flights = require('../flights.json');
const { normalizeFlightNumber } = require('../flight-lookup');

const TERMINAL_MAP = {
  // Terminal 1 — no bus
  SV:'T1',XY:'T1',F3:'T1',QR:'T1',EK:'T1',KU:'T1',WY:'T1',FZ:'T1',
  RJ:'T1',ME:'T1',GF:'T1',EY:'T1',AT:'T1',EW:'T1',A3:'T1',MH:'T1',
  BA:'T1',MS:'T1',HU:'T1',TK:'T1',
  // North Terminal — bus
  G9:'North',IY:'North','6E':'North',
  SM:'North',J4:'North',AI:'North',ET:'North',NP:'North',HY:'North',
  SZ:'North',D3:'North',SD:'North',DV:'North',
  IX:'North',W9:'North',E5:'North',J9:'North',
  // Terminal 4 — bus (airlines moved there, Sep–Oct 2026)
  OV:'T4',NE:'T4',W4:'T4','9P':'T4',
  VF:'T4',TU:'T4',J2:'T4',PC:'T4',QP:'T4',RB:'T4',
  // Hajj Terminal — bus. 3T (Tarco) moved here as a whole airline, Oct 2026.
  PA:'Hajj',PF:'Hajj',BG:'Hajj',PK:'Hajj',AH:'Hajj','3T':'Hajj',
  GA:'Hajj',FG:'Hajj',BS:'Hajj',JT:'Hajj',RQ:'Hajj',C6:'Hajj',D7:'Hajj',
  '2S':'Hajj','7Q':'Hajj',BJ:'Hajj',BM:'Hajj',FH:'Hajj',
  UZ:'Hajj',XC:'Hajj',ER:'Hajj',DH:'Hajj',
};

const BUS_TERMINALS = new Set(['North', 'Hajj', 'T4']);
const KNOWN_TERMINALS = new Set(['T1', 'North', 'Hajj', 'T4']);

function getAirlineCode(flight) {
  if (!flight) return '';
  return String(flight).toUpperCase().trim().slice(0, 2);
}

function getTerminal(flight) {
  const key = normalizeFlightNumber(flight);   // SV0309 -> SV309, as stored
  const known = flights[key]?.terminal;
  if (KNOWN_TERMINALS.has(known)) return known;
  return TERMINAL_MAP[getAirlineCode(key)] || 'T1';
}

function needsBus(flight) {
  return BUS_TERMINALS.has(getTerminal(flight));
}

module.exports = { TERMINAL_MAP, getAirlineCode, getTerminal, needsBus };
