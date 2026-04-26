require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

function getDb() {
  return pool;
}

function jeddahNowStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id               SERIAL PRIMARY KEY,
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
      created_at       TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      closed_at        TEXT,
      confirmed_at     TEXT,
      nusuk_received   TEXT,
      nusuk_by         TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flights_custom (
      flight_number TEXT PRIMARY KEY,
      destination   TEXT,
      std           TEXT,
      city          TEXT,
      country       TEXT,
      nationality   TEXT,
      deleted       INTEGER DEFAULT 0,
      updated_at    TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      ts          TEXT NOT NULL,
      "user"      TEXT,
      action      TEXT NOT NULL,
      report_id   INTEGER,
      changes     TEXT,
      snapshot    TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_report ON audit_log(report_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS export_tokens (
      id          SERIAL PRIMARY KEY,
      email       TEXT NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      role        TEXT NOT NULL DEFAULT 'view',
      created_at  TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      last_used   TEXT,
      revoked     INTEGER DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_export_token ON export_tokens(token)`);

  console.log('Database ready (PostgreSQL)');
}

async function logAudit({ user, action, reportId, changes, snapshot }) {
  const ts = jeddahNowStr();
  await pool.query(
    `INSERT INTO audit_log (ts, "user", action, report_id, changes, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ts,
      user || 'unknown',
      action,
      reportId || null,
      changes ? JSON.stringify(changes) : null,
      snapshot ? JSON.stringify(snapshot) : null,
    ]
  );
}

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

async function autoCloseReports() {
  const jeddahNow = new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().slice(0, 16);
  const closedAt = jeddahNow.replace('T', ' ') + ':00';

  const { rows: toClose } = await pool.query(
    `SELECT id FROM reports
     WHERE status = 'flight_confirmed'
       AND new_datetime IS NOT NULL AND new_datetime != ''
       AND new_datetime < $1`,
    [jeddahNow]
  );

  const { rowCount } = await pool.query(
    `UPDATE reports
     SET status = 'closed', closed_at = $1
     WHERE status = 'flight_confirmed'
       AND new_datetime IS NOT NULL AND new_datetime != ''
       AND new_datetime < $2`,
    [closedAt, jeddahNow]
  );

  if (rowCount > 0) {
    for (const r of toClose) {
      await logAudit({
        user: 'system', action: 'auto_close', reportId: r.id,
        changes: { status: { from: 'flight_confirmed', to: 'closed' } },
      });
    }
    console.log(`Auto-closed ${rowCount} report(s) at Jeddah time ${jeddahNow}`);
  }
}

module.exports = { getDb, initDb, autoCloseReports, logAudit, diffFields, jeddahNowStr };
