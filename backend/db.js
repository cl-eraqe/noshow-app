const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'noshow.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const database = getDb();
  database.exec(`
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
  // Migration: add status column if missing (for existing databases)
  const cols = database.prepare("PRAGMA table_info(reports)").all();
  if (!cols.find(c => c.name === 'status')) {
    database.exec("ALTER TABLE reports ADD COLUMN status TEXT DEFAULT 'under_process'");
    console.log('Migrated: added status column');
  }
  if (!cols.find(c => c.name === 'comment')) {
    database.exec("ALTER TABLE reports ADD COLUMN comment TEXT DEFAULT ''");
    console.log('Migrated: added comment column');
  }

  console.log('Database ready:', DB_PATH);
}

// Auto-close reports whose new flight departure has passed
function autoCloseReports() {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE reports
    SET status = 'closed'
    WHERE status = 'flight_confirmed'
      AND new_datetime IS NOT NULL
      AND new_datetime != ''
      AND new_datetime < ?
  `).run(now);
}

module.exports = { getDb, initDb, autoCloseReports };
