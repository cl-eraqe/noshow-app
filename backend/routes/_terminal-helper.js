// Shared terminal mapping used by reports.js and analytics.js
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
  JT:'Hajj',RQ:'Hajj',C6:'Hajj',TK:'T1',D7:'Hajj',
  '2S':'Hajj','7Q':'Hajj',BJ:'Hajj',BM:'Hajj',FH:'Hajj',
  UZ:'Hajj',XC:'Hajj',
};

function getAirlineCode(flight) {
  if (!flight) return '';
  return String(flight).toUpperCase().trim().slice(0, 2);
}

module.exports = { TERMINAL_MAP, getAirlineCode };
