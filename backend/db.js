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
      created_at       TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('Database ready:', DB_PATH);
}

module.exports = { getDb, initDb };
