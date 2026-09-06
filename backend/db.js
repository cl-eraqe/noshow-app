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
      nusuk_by         TEXT,
      owner_terminal   TEXT CHECK (owner_terminal IN ('T1', 'North'))
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
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL UNIQUE,
      role           TEXT NOT NULL CHECK (role IN ('staff', 'supervisor')),
      owner_terminal TEXT CHECK (owner_terminal IN ('T1', 'North')),
      pin_hash       TEXT NOT NULL,
      active         BOOLEAN NOT NULL DEFAULT true,
      created_at     TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_name ON users(LOWER(name))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_tokens (
      id              SERIAL PRIMARY KEY,
      token           TEXT NOT NULL UNIQUE,
      role            TEXT NOT NULL CHECK (role IN ('staff', 'supervisor')),
      owner_terminal  TEXT CHECK (owner_terminal IN ('T1', 'North')),
      created_by      TEXT NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL,
      used            BOOLEAN NOT NULL DEFAULT false,
      created_at      TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI:SS')
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

  // Multi-terminal support (idempotent migration) — owner_terminal records which
  // terminal's queue a user/report/invite belongs to. This is a distinct concept
  // from the flight-derived terminal (TERMINAL_MAP / getTerminal / needsBus), which
  // continues to drive bus-transfer badges and the existing analytics terminal
  // breakdown unchanged. See ALTER statements + backfill below.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_terminal TEXT`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS owner_terminal TEXT`);
  await pool.query(`ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS owner_terminal TEXT`);

  // Gate and estimated departure, captured from the live schedule. Neither is
  // displayed anywhere — they are recorded so a history exists to analyse
  // later. Both are volatile during the day (a gate assigned at 00:01 can move
  // by noon), so they are written at save time and then corrected by each sync
  // for as long as the flight stays inside KAIA's window; once it falls out,
  // the value that stands is the last one KAIA reported, which is the final one.
  for (const col of ['prev_gate', 'prev_estimated', 'new_gate', 'new_estimated']) {
    await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS ${col} TEXT`);
  }

  // Where a flights_custom row came from. The sync copies flights KAIA knows
  // but flights.json does not into this table, so they survive KAIA forgetting
  // them a week later — and this column keeps those distinguishable from the
  // ones a supervisor typed, which the sync must never overwrite.
  await pool.query(`ALTER TABLE flights_custom ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`);
  // Add the CHECK constraints separately (idempotent — Postgres has no "ADD CONSTRAINT
  // IF NOT EXISTS", so guard with a catalog lookup instead of failing on re-run).
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_owner_terminal_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_owner_terminal_check
          CHECK (owner_terminal IN ('T1', 'North') OR owner_terminal IS NULL);
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reports_owner_terminal_check'
      ) THEN
        ALTER TABLE reports ADD CONSTRAINT reports_owner_terminal_check
          CHECK (owner_terminal IN ('T1', 'North') OR owner_terminal IS NULL);
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'invite_tokens_owner_terminal_check'
      ) THEN
        ALTER TABLE invite_tokens ADD CONSTRAINT invite_tokens_owner_terminal_check
          CHECK (owner_terminal IN ('T1', 'North') OR owner_terminal IS NULL);
      END IF;
    END $$;
  `);

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

  // One-time migration: backfill existing staff users and all existing reports
  // to Terminal 1, preserving historical data now that multi-terminal support
  // exists. The sole supervisor account is left with owner_terminal = NULL
  // (supervisors aren't scoped to one terminal).
  const { rows: termMigRows } = await pool.query(`SELECT 1 FROM _migrations WHERE name = 'backfill_owner_terminal_t1'`);
  if (termMigRows.length === 0) {
    await pool.query(`UPDATE users SET owner_terminal = 'T1' WHERE owner_terminal IS NULL AND role = 'staff'`);
    await pool.query(`UPDATE reports SET owner_terminal = 'T1' WHERE owner_terminal IS NULL`);
    await pool.query(`INSERT INTO _migrations (name, applied_at) VALUES ('backfill_owner_terminal_t1', $1)`, [jeddahNowStr()]);
    console.log('Migration applied: existing users and reports backfilled to Terminal 1');
  }

  // ── KAIA live schedule ──────────────────────────────────────────────────
  // A rolling copy of the -6..+2 day window pulled from KAIA once a day. Old
  // rows are deleted as the window moves, so this table's size is constant
  // (~390 departures x 9 days). Unlike flights.json / flights_custom, which
  // are recurring timetables keyed by flight number alone, these rows carry a
  // date — that is the whole point of them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kaia_flights (
      flight_number    TEXT NOT NULL,
      date             TEXT NOT NULL,
      scheduled_time   TEXT NOT NULL,
      estimated_time   TEXT,
      terminal_raw     TEXT,
      gate             TEXT,
      airline_code     TEXT,
      airline_name     TEXT,
      destination_code TEXT,
      destination_city TEXT,
      synced_at        TEXT,
      PRIMARY KEY (flight_number, date, scheduled_time)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kaia_flights_number ON kaia_flights (flight_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kaia_flights_date ON kaia_flights (date)`);

  // One row per sync attempt, so staleness is visible rather than silent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kaia_sync_log (
      id          SERIAL PRIMARY KEY,
      started_at  TEXT,
      finished_at TEXT,
      ok          INTEGER DEFAULT 0,
      days_ok     INTEGER DEFAULT 0,
      days_failed INTEGER DEFAULT 0,
      rows_synced INTEGER DEFAULT 0,
      detail      TEXT
    )
  `);

  // KAIA's terminal codes, as data rather than as a hardcoded map: when
  // Terminal 4 opens it is one row, not a code change and a deploy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS terminal_codes (
      code       TEXT PRIMARY KEY,   -- what KAIA sends, e.g. 'N'
      terminal   TEXT NOT NULL,      -- what the app uses, e.g. 'North'
      needs_bus  INTEGER DEFAULT 0,
      label      TEXT,
      updated_at TEXT
    )
  `);
  const { rows: tcRows } = await pool.query(`SELECT 1 FROM _migrations WHERE name = 'seed_terminal_codes'`);
  if (tcRows.length === 0) {
    for (const [code, terminal, bus, label] of [
      ['N',  'North', 1, 'North Terminal'],
      ['T1', 'T1',    0, 'Terminal 1'],
      ['H',  'Hajj',  1, 'Hajj Terminal'],
      ['T4', 'T4',    1, 'Terminal 4'],
    ]) {
      await pool.query(
        `INSERT INTO terminal_codes (code, terminal, needs_bus, label, updated_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING`,
        [code, terminal, bus, label, jeddahNowStr()]
      );
    }
    await pool.query(`INSERT INTO _migrations (name, applied_at) VALUES ('seed_terminal_codes', $1)`, [jeddahNowStr()]);
    console.log('Migration applied: terminal codes seeded (N/T1/H/T4)');
  }

  // Airline names are the key that analytics groups by, so a name KAIA spells
  // differently ("SAUDI ARABIAN AIRLINES" vs "Saudia") would split one airline
  // into two bars and break its logo lookup. KAIA's name is therefore never
  // used directly: the IATA code is the key, our name wins, and a code we do
  // not know waits here until a supervisor approves a name for it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS airlines (
      code       TEXT PRIMARY KEY,        -- IATA, e.g. 'IA'
      name       TEXT,                    -- the approved name; NULL until approved
      kaia_name  TEXT,                    -- what KAIA calls it, for reference
      status     TEXT DEFAULT 'pending',  -- pending | approved | ignored
      seen_count INTEGER DEFAULT 0,
      samples    TEXT DEFAULT '[]',       -- a few flight numbers, to identify it
      first_seen TEXT,
      updated_at TEXT
    )
  `);

  // Seed the 75 airlines the app already knows as approved, so only genuinely
  // new codes ever surface for review.
  const { rows: alRows } = await pool.query(`SELECT 1 FROM _migrations WHERE name = 'seed_airlines'`);
  if (alRows.length === 0) {
    const seed = require('./airlines-seed.json');
    const now = jeddahNowStr();
    for (const [code, name] of Object.entries(seed)) {
      await pool.query(
        `INSERT INTO airlines (code, name, status, first_seen, updated_at)
         VALUES ($1, $2, 'approved', $3, $3) ON CONFLICT (code) DO NOTHING`,
        [code, name, now]
      );
    }
    await pool.query(`INSERT INTO _migrations (name, applied_at) VALUES ('seed_airlines', $1)`, [jeddahNowStr()]);
    console.log(`Migration applied: ${Object.keys(seed).length} known airlines seeded as approved`);
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
