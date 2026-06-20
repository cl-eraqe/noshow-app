require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' }
    : false,
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
      created_at       TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS'),
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
      created_at  TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS'),
      last_used   TEXT,
      revoked     INTEGER DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_export_token ON export_tokens(token)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL CHECK (role IN ('staff', 'supervisor')),
      pin_hash   TEXT NOT NULL,
      active     BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_name ON users(LOWER(name))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_tokens (
      id         SERIAL PRIMARY KEY,
      token      TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL CHECK (role IN ('staff', 'supervisor')),
      created_by TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invite_token ON invite_tokens(token)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS airline_brand_overrides (
      iata         TEXT PRIMARY KEY,
      logo_file    TEXT NOT NULL,
      avatar_file  TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      updated_by   TEXT
    )
  `);

  // Add confirmed_by column if not exists (idempotent migration)
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS confirmed_by TEXT`);

  // Fix column defaults on existing tables (safe, idempotent)
  await pool.query(`ALTER TABLE reports ALTER COLUMN created_at SET DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')`);
  await pool.query(`ALTER TABLE export_tokens ALTER COLUMN created_at SET DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')`);

  // One-time migration: convert existing UTC created_at values to Jeddah time (+3h)
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT)`);
  const { rows: migRows } = await pool.query(`SELECT 1 FROM _migrations WHERE name = 'utc_to_jeddah_created_at'`);
  if (migRows.length === 0) {
    await pool.query(`
      UPDATE reports
      SET created_at = to_char((created_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')
      WHERE created_at IS NOT NULL AND created_at != ''
    `);
    await pool.query(`
      UPDATE export_tokens
      SET created_at = to_char((created_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')
      WHERE created_at IS NOT NULL AND created_at != ''
    `);
    await pool.query(`INSERT INTO _migrations (name, applied_at) VALUES ('utc_to_jeddah_created_at', $1)`, [jeddahNowStr()]);
    console.log('Migration applied: created_at converted from UTC to Jeddah time');
  }

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
    // Lazy-load to avoid circular dependency
    const { deleteFile } = require('./storage');
    for (const r of toClose) {
      await logAudit({
        user: 'system', action: 'auto_close', reportId: r.id,
        changes: { status: { from: 'flight_confirmed', to: 'closed' } },
      });
      // Purge attachments — case is closed, files no longer needed
      const { rows: fr } = await pool.query('SELECT file_paths FROM reports WHERE id = $1', [r.id]);
      const paths = JSON.parse(fr[0]?.file_paths || '[]');
      if (paths.length) {
        await Promise.all(paths.map(p => deleteFile(p.split('/').pop()).catch(() => {})));
        await pool.query('UPDATE reports SET file_paths = $1 WHERE id = $2', ['[]', r.id]);
      }
    }
    console.log(`Auto-closed ${rowCount} report(s) at Jeddah time ${jeddahNow}`);
  }
}

module.exports = { getDb, initDb, autoCloseReports, logAudit, diffFields, jeddahNowStr };
