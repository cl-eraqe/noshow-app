/**
 * Seed test data for CEO report testing
 * Run: node scripts/seed-test-data.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'noshow.db');
const db = new Database(DB_PATH);

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pax_id_datetime  TEXT NOT NULL,
    prev_flight      TEXT,
    prev_datetime    TEXT,
    prev_destination TEXT,
    prev_airline     TEXT,
    nationality      TEXT,
    pax_type         TEXT,
    new_flight       TEXT,
    new_datetime     TEXT,
    new_destination  TEXT,
    new_airline      TEXT,
    days_at_airport  REAL,
    pax_count        INTEGER,
    file_paths       TEXT DEFAULT '[]',
    whatsapp_text    TEXT,
    submitted_by     TEXT,
    status           TEXT DEFAULT 'under_process',
    comment          TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  )
`);

const now = new Date();
function hoursAgo(h) {
  return new Date(now.getTime() - h * 60 * 60 * 1000).toISOString().slice(0, 16);
}
function hoursFromNow(h) {
  return new Date(now.getTime() + h * 60 * 60 * 1000).toISOString().slice(0, 16);
}
function daysAgo(d) {
  return new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

const insert = db.prepare(`
  INSERT INTO reports (pax_id_datetime, prev_flight, prev_datetime, prev_destination, prev_airline,
    nationality, pax_type, new_flight, new_datetime, new_destination, new_airline,
    days_at_airport, pax_count, whatsapp_text, submitted_by, status, comment, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'staff', ?, ?, datetime('now'))
`);

const reports = [
  // ── CLOSED (departed within last 12 hrs) → CEO section 1
  {
    pax_id: hoursAgo(8), prev_flight: 'SV305', prev_dt: daysAgo(2), prev_dest: 'Cairo (CAI)', prev_airline: 'Saudia',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: 'SV309', new_dt: hoursAgo(3), new_dest: 'Cairo (CAI)', new_airline: 'Saudia',
    days: 2, pax: 4, status: 'closed', comment: 'Family group, all departed together'
  },
  {
    pax_id: hoursAgo(10), prev_flight: 'TK95', prev_dt: daysAgo(1), prev_dest: 'Istanbul (IST)', prev_airline: 'Turkish Airlines',
    nat: 'Turkish', pax_type: 'Tourist', new_flight: 'TK95', new_dt: hoursAgo(2), new_dest: 'Istanbul (IST)', new_airline: 'Turkish Airlines',
    days: 1, pax: 2, status: 'closed', comment: ''
  },
  {
    pax_id: hoursAgo(6), prev_flight: 'MS986', prev_dt: daysAgo(1), prev_dest: 'Cairo (CAI)', prev_airline: 'EgyptAir',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: 'SV305', new_dt: hoursAgo(5), new_dest: 'Cairo (CAI)', new_airline: 'Saudia',
    days: 1, pax: 3, status: 'closed', comment: ''
  },
  {
    pax_id: hoursAgo(7), prev_flight: 'PK751', prev_dt: daysAgo(1), prev_dest: 'Karachi (KHI)', prev_airline: 'PIA',
    nat: 'Pakistani', pax_type: 'Umrah', new_flight: 'PK752', new_dt: hoursAgo(4), new_dest: 'Karachi (KHI)', new_airline: 'PIA',
    days: 1, pax: 5, status: 'closed', comment: 'Large group from same hotel'
  },

  // ── FLIGHT CONFIRMED, departs < 12 hrs → CEO section 3
  {
    pax_id: hoursAgo(18), prev_flight: 'SV796', prev_dt: daysAgo(2), prev_dest: 'Peshawar (PEW)', prev_airline: 'Saudia',
    nat: 'Pakistani', pax_type: 'Umrah', new_flight: 'SV796', new_dt: hoursFromNow(4), new_dest: 'Peshawar (PEW)', new_airline: 'Saudia',
    days: 2, pax: 6, status: 'flight_confirmed', comment: ''
  },
  {
    pax_id: hoursAgo(12), prev_flight: 'EK802', prev_dt: daysAgo(1), prev_dest: 'Dubai (DXB)', prev_airline: 'Emirates',
    nat: 'Indian', pax_type: 'Transit', new_flight: 'EK803', new_dt: hoursFromNow(6), new_dest: 'Dubai (DXB)', new_airline: 'Emirates',
    days: 1, pax: 3, status: 'flight_confirmed', comment: 'Transit to Mumbai'
  },
  {
    pax_id: hoursAgo(9), prev_flight: 'SV305', prev_dt: daysAgo(1), prev_dest: 'Cairo (CAI)', prev_airline: 'Saudia',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: 'SV309', new_dt: hoursFromNow(8), new_dest: 'Cairo (CAI)', new_airline: 'Saudia',
    days: 1, pax: 8, status: 'flight_confirmed', comment: ''
  },

  // ── FLIGHT CONFIRMED, departs > 12 hrs → CEO section 4
  {
    pax_id: hoursAgo(30), prev_flight: 'SV305', prev_dt: daysAgo(3), prev_dest: 'Cairo (CAI)', prev_airline: 'Saudia',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: 'SV305', new_dt: hoursFromNow(24), new_dest: 'Cairo (CAI)', new_airline: 'Saudia',
    days: 3, pax: 11, status: 'flight_confirmed', comment: 'Waiting for next available SV flight'
  },
  {
    pax_id: hoursAgo(48), prev_flight: 'F3777', prev_dt: daysAgo(2), prev_dest: 'Algiers (ALG)', prev_airline: 'Flyadeal',
    nat: 'Algerian', pax_type: 'Umrah', new_flight: 'F3777', new_dt: hoursFromNow(36), new_dest: 'Algiers (ALG)', new_airline: 'Flyadeal',
    days: 2, pax: 11, status: 'flight_confirmed', comment: 'Group from same tour'
  },
  {
    pax_id: hoursAgo(36), prev_flight: 'TK95', prev_dt: daysAgo(2), prev_dest: 'Istanbul (IST)', prev_airline: 'Turkish Airlines',
    nat: 'Turkish', pax_type: 'Tourist', new_flight: 'TK95', new_dt: hoursFromNow(14), new_dest: 'Istanbul (IST)', new_airline: 'Turkish Airlines',
    days: 2, pax: 4, status: 'flight_confirmed', comment: ''
  },
  {
    pax_id: hoursAgo(40), prev_flight: 'PK796', prev_dt: daysAgo(2), prev_dest: 'Lahore (LHE)', prev_airline: 'PIA',
    nat: 'Pakistani', pax_type: 'Umrah', new_flight: 'PK797', new_dt: hoursFromNow(20), new_dest: 'Lahore (LHE)', new_airline: 'PIA',
    days: 2, pax: 15, status: 'flight_confirmed', comment: ''
  },
  {
    pax_id: hoursAgo(24), prev_flight: 'GF154', prev_dt: daysAgo(1), prev_dest: 'Bahrain (BAH)', prev_airline: 'Gulf Air',
    nat: 'Bahraini', pax_type: 'Family Visit', new_flight: 'GF155', new_dt: hoursFromNow(18), new_dest: 'Bahrain (BAH)', new_airline: 'Gulf Air',
    days: 1, pax: 7, status: 'flight_confirmed', comment: ''
  },
  {
    pax_id: hoursAgo(28), prev_flight: 'QR1168', prev_dt: daysAgo(1), prev_dest: 'Doha (DOH)', prev_airline: 'Qatar Airways',
    nat: 'Indian', pax_type: 'Transit', new_flight: 'QR1169', new_dt: hoursFromNow(30), new_dest: 'Doha (DOH)', new_airline: 'Qatar Airways',
    days: 1, pax: 9, status: 'flight_confirmed', comment: 'Transit to Kerala'
  },
  {
    pax_id: hoursAgo(20), prev_flight: 'ET416', prev_dt: daysAgo(1), prev_dest: 'Addis Ababa (ADD)', prev_airline: 'Ethiopian Airlines',
    nat: 'Ethiopian', pax_type: 'Resident', new_flight: 'ET417', new_dt: hoursFromNow(16), new_dest: 'Addis Ababa (ADD)', new_airline: 'Ethiopian Airlines',
    days: 1, pax: 6, status: 'flight_confirmed', comment: ''
  },
  {
    pax_id: hoursAgo(32), prev_flight: 'AI902', prev_dt: daysAgo(2), prev_dest: 'Mumbai (BOM)', prev_airline: 'Air India',
    nat: 'Indian', pax_type: 'Umrah', new_flight: 'AI903', new_dt: hoursFromNow(22), new_dest: 'Mumbai (BOM)', new_airline: 'Air India',
    days: 2, pax: 10, status: 'flight_confirmed', comment: ''
  },

  // ── UNDER PROCESS → CEO section 5
  {
    pax_id: hoursAgo(3), prev_flight: 'SV309', prev_dt: hoursAgo(4), prev_dest: 'Cairo (CAI)', prev_airline: 'Saudia',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 4, status: 'under_process', comment: 'Contacted airline, waiting for response'
  },
  {
    pax_id: hoursAgo(2), prev_flight: 'TK95', prev_dt: hoursAgo(3), prev_dest: 'Istanbul (IST)', prev_airline: 'Turkish Airlines',
    nat: 'Turkish', pax_type: 'Tourist', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 1, status: 'under_process', comment: ''
  },
  {
    pax_id: hoursAgo(5), prev_flight: 'MS986', prev_dt: hoursAgo(6), prev_dest: 'Cairo (CAI)', prev_airline: 'EgyptAir',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 6, status: 'under_process', comment: 'EgyptAir counter closed, trying Saudia'
  },
  {
    pax_id: hoursAgo(1), prev_flight: 'EK802', prev_dt: hoursAgo(2), prev_dest: 'Dubai (DXB)', prev_airline: 'Emirates',
    nat: 'Indian', pax_type: 'Transit', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 2, status: 'under_process', comment: ''
  },
  {
    pax_id: hoursAgo(4), prev_flight: 'BG402', prev_dt: hoursAgo(5), prev_dest: 'Dhaka (DAC)', prev_airline: 'Biman Bangladesh',
    nat: 'Bangladeshi', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 3, status: 'under_process', comment: ''
  },
  {
    pax_id: hoursAgo(6), prev_flight: 'XY205', prev_dt: hoursAgo(8), prev_dest: 'Cairo (CAI)', prev_airline: 'flynas',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 5, status: 'under_process', comment: ''
  },
  {
    pax_id: hoursAgo(2), prev_flight: 'SV796', prev_dt: hoursAgo(3), prev_dest: 'Peshawar (PEW)', prev_airline: 'Saudia',
    nat: 'Pakistani', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 5, status: 'under_process', comment: ''
  },

  // ── UNDER PROCESS but over 24 hrs (will show in CEO section 7 detail)
  {
    pax_id: daysAgo(2), prev_flight: 'SV305', prev_dt: daysAgo(3), prev_dest: 'Cairo (CAI)', prev_airline: 'Saudia',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 2, status: 'under_process', comment: 'Airline not responding, escalated to supervisor'
  },
  {
    pax_id: daysAgo(1.5), prev_flight: 'PK751', prev_dt: daysAgo(2), prev_dest: 'Karachi (KHI)', prev_airline: 'PIA',
    nat: 'Pakistani', pax_type: 'Umrah', new_flight: null, new_dt: null, new_dest: null, new_airline: null,
    days: null, pax: 3, status: 'under_process', comment: 'No seats available on next 2 PIA flights'
  },

  // ── Older closed reports (departed more than 12 hrs ago — should NOT appear in CEO section 1)
  {
    pax_id: daysAgo(3), prev_flight: 'SV309', prev_dt: daysAgo(4), prev_dest: 'Cairo (CAI)', prev_airline: 'Saudia',
    nat: 'Egyptian', pax_type: 'Umrah', new_flight: 'SV305', new_dt: daysAgo(2), new_dest: 'Cairo (CAI)', new_airline: 'Saudia',
    days: 2, pax: 7, status: 'closed', comment: ''
  },
  {
    pax_id: daysAgo(5), prev_flight: 'TK95', prev_dt: daysAgo(6), prev_dest: 'Istanbul (IST)', prev_airline: 'Turkish Airlines',
    nat: 'Turkish', pax_type: 'Resident', new_flight: 'TK95', new_dt: daysAgo(4), new_dest: 'Istanbul (IST)', new_airline: 'Turkish Airlines',
    days: 2, pax: 1, status: 'closed', comment: ''
  },
];

console.log(`Inserting ${reports.length} test reports…`);

const insertMany = db.transaction(() => {
  for (const r of reports) {
    insert.run(
      r.pax_id, r.prev_flight, r.prev_dt, r.prev_dest, r.prev_airline,
      r.nat, r.pax_type, r.new_flight, r.new_dt, r.new_dest, r.new_airline,
      r.days, r.pax, r.status, r.comment
    );
  }
});

insertMany();

const total = db.prepare('SELECT COUNT(*) as count FROM reports').get();
console.log(`Done! Total reports in database: ${total.count}`);
console.log('\nExpected CEO report breakdown:');
console.log('  Section 1 (Closed <12hrs): 14 PAX (4 reports)');
console.log('  Section 3 (Confirmed <12hrs): 17 PAX (3 reports)');
console.log('  Section 4 (Confirmed >12hrs): 73 PAX (8 reports)');
console.log('  Section 5 (Under Process): ~31 PAX (9 reports, including 2 over 24hrs)');
console.log('  Section 7 (Over 24hrs): details for reports with prev_datetime > 24hrs ago');

db.close();
