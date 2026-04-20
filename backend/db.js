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
      created_at       TEXT DEFAULT (datetime('now')),
      closed_at        TEXT,
      confirmed_at     TEXT
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
  if (!cols.find(c => c.name === 'closed_at')) {
    database.exec("ALTER TABLE reports ADD COLUMN closed_at TEXT");
    console.log('Migrated: added closed_at column');
  }
  if (!cols.find(c => c.name === 'confirmed_at')) {
    database.exec("ALTER TABLE reports ADD COLUMN confirmed_at TEXT");
    console.log('Migrated: added confirmed_at column');
  }

  // ── Audit log (every create/edit/status change/delete is recorded)
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      user        TEXT,
      action      TEXT NOT NULL,
      report_id   INTEGER,
      changes     TEXT,
      snapshot    TEXT
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_audit_report ON audit_log(report_id)`);

  // ── Export access tokens (magic-link URLs for Excel From Web)
  database.exec(`
    CREATE TABLE IF NOT EXISTS export_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      role        TEXT NOT NULL DEFAULT 'view',
      created_at  TEXT DEFAULT (datetime('now')),
      last_used   TEXT,
      revoked     INTEGER DEFAULT 0
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_export_token ON export_tokens(token)`);

  console.log('Database ready:', DB_PATH);
}

// ── Audit helper — call from anywhere a report is created/changed/deleted
function logAudit({ user, action, reportId, changes, snapshot }) {
  const database = getDb();
  // Jeddah time (UTC+3)
  const ts = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  database.prepare(`
    INSERT INTO audit_log (ts, user, action, report_id, changes, snapshot)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ts,
    user || 'unknown',
    action,
    reportId || null,
    changes ? JSON.stringify(changes) : null,
    snapshot ? JSON.stringify(snapshot) : null
  );
}

// Diff helper: compares old vs new object and returns {field: {from, to}}
function diffFields(oldRow, newRow, fields) {
  const changes = {};
  fields.forEach(f => {
    const a = oldRow[f];
    const b = newRow[f];
    if (a !== b && !(a == null && b == null)) {
      changes[f] = { from: a, to: b };
    }
  });
  return Object.keys(changes).length > 0 ? changes : null;
}

// Auto-close reports whose new flight departure has passed
function autoCloseReports() {
  const database = getDb();
  // Users enter times in Jeddah local time (UTC+3) without timezone info,
  // so we must compare against Jeddah time, not UTC.
  const jeddahNow = new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().slice(0, 16); // e.g. "2026-03-30T14:30"
  const closedAt = jeddahNow.replace('T', ' ') + ':00';

  // Find soon-to-close ones for audit logging
  const toClose = database.prepare(`
    SELECT id FROM reports
    WHERE status = 'flight_confirmed'
      AND new_datetime IS NOT NULL
      AND new_datetime != ''
      AND new_datetime < ?
  `).all(jeddahNow);

  const result = database.prepare(`
    UPDATE reports
    SET status = 'closed', closed_at = ?
    WHERE status = 'flight_confirmed'
      AND new_datetime IS NOT NULL
      AND new_datetime != ''
      AND new_datetime < ?
  `).run(closedAt, jeddahNow);

  if (result.changes > 0) {
    toClose.forEach(r => {
      logAudit({ user: 'system', action: 'auto_close', reportId: r.id,
        changes: { status: { from: 'flight_confirmed', to: 'closed' } } });
    });
    console.log(`Auto-closed ${result.changes} report(s) at Jeddah time ${jeddahNow}`);
  }
}

module.exports = { getDb, initDb, autoCloseReports, logAudit, diffFields };
