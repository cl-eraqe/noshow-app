// Daily pull of the KAIA window into kaia_flights.
//
// Runs once a day at 00:01 Jeddah. Everything a lookup needs is answered from
// the local copy, so no user ever waits on KAIA's network.

const { getDb, jeddahNowStr } = require('./db');
const kaia = require('./kaia');

const SYNC_HOUR = 0;
const SYNC_MINUTE = 1;

// Re-sync at startup if the last successful sync is older than this, so a
// container that restarts mid-day does not run on a stale copy until midnight.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

// ── One sync run ──────────────────────────────────────────────────────────

async function syncWindow({ reason = 'scheduled' } = {}) {
  const pool = getDb();
  const startedAt = jeddahNowStr();
  const dates = kaia.windowDates();

  let daysOk = 0;
  let daysFailed = 0;
  let rowsSynced = 0;
  const failures = [];
  const newAirlines = new Map();

  for (const date of dates) {
    try {
      const { rows } = await kaia.fetchDay(date);
      const shaped = rows.map(r => kaia.shapeFlight(r, date)).filter(Boolean);

      // Upsert rather than delete-then-insert for the date: if this process
      // dies mid-day the previous copy is still there, which beats an empty
      // table falling back to the timetable for everything.
      for (const f of shaped) {
        await pool.query(
          `INSERT INTO kaia_flights
             (flight_number, date, scheduled_time, estimated_time, terminal_raw, gate,
              airline_code, airline_name, destination_code, destination_city, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (flight_number, date, scheduled_time) DO UPDATE SET
             estimated_time = EXCLUDED.estimated_time,
             terminal_raw = EXCLUDED.terminal_raw,
             gate = EXCLUDED.gate,
             airline_code = EXCLUDED.airline_code,
             airline_name = EXCLUDED.airline_name,
             destination_code = EXCLUDED.destination_code,
             destination_city = EXCLUDED.destination_city,
             synced_at = EXCLUDED.synced_at`,
          [f.flight_number, f.date, f.scheduled_time, f.estimated_time, f.terminal_raw, f.gate,
           f.airline_code, f.airline_name, f.destination_code, f.destination_city, startedAt]
        );
        if (f.airline_code) {
          const seen = newAirlines.get(f.airline_code) || { name: f.airline_name, samples: [], count: 0 };
          seen.count++;
          if (seen.samples.length < 3 && !seen.samples.includes(f.flight_number)) seen.samples.push(f.flight_number);
          if (!seen.name && f.airline_name) seen.name = f.airline_name;
          newAirlines.set(f.airline_code, seen);
        }
      }

      // Rows for this date that KAIA no longer lists (cancelled, retimed onto
      // another day) are dropped, but only for a date we successfully fetched.
      await pool.query(
        `DELETE FROM kaia_flights WHERE date = $1 AND (synced_at IS DISTINCT FROM $2)`,
        [date, startedAt]
      );

      daysOk++;
      rowsSynced += shaped.length;
    } catch (e) {
      // One bad day must not abort the other eight, and the existing rows for
      // that date are deliberately left untouched.
      daysFailed++;
      failures.push(`${date}: ${e.message}`);
      console.error(`[kaia-sync] ${date} failed:`, e.message);
    }
  }

  // Anything outside the window is gone from KAIA anyway; keeping it would
  // grow the table without bound.
  await pool.query(`DELETE FROM kaia_flights WHERE date < $1 OR date > $2`,
    [dates[0], dates[dates.length - 1]]);

  await recordAirlines(newAirlines);

  const ok = daysOk > 0 && daysFailed === 0;
  await pool.query(
    `INSERT INTO kaia_sync_log (started_at, finished_at, ok, days_ok, days_failed, rows_synced, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [startedAt, jeddahNowStr(), ok ? 1 : 0, daysOk, daysFailed, rowsSynced,
     [reason, ...failures].join(' | ').slice(0, 2000)]
  );

  console.log(`[kaia-sync] ${reason}: ${daysOk}/${dates.length} days, ${rowsSynced} flights, ${daysFailed} failed`);
  return { ok, daysOk, daysFailed, rowsSynced, failures };
}

// Record every airline code seen. Known codes are only counted; a code with no
// approved name lands in the review queue and stays out of reports until a
// supervisor names it.
async function recordAirlines(seen) {
  if (!seen.size) return;
  const pool = getDb();
  const now = jeddahNowStr();
  for (const [code, info] of seen) {
    await pool.query(
      `INSERT INTO airlines (code, name, kaia_name, status, seen_count, samples, first_seen, updated_at)
       VALUES ($1, NULL, $2, 'pending', $3, $4, $5, $5)
       ON CONFLICT (code) DO UPDATE SET
         kaia_name  = COALESCE(EXCLUDED.kaia_name, airlines.kaia_name),
         seen_count = EXCLUDED.seen_count,
         samples    = CASE WHEN airlines.status = 'pending' THEN EXCLUDED.samples ELSE airlines.samples END,
         updated_at = EXCLUDED.updated_at`,
      [code, info.name || null, info.count, JSON.stringify(info.samples), now]
    );
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────

// Milliseconds until the next 00:01 Jeddah.
function msUntilNextSync(now = Date.now()) {
  const jed = new Date(now + kaia.JEDDAH_OFFSET_MS);
  const next = new Date(Date.UTC(
    jed.getUTCFullYear(), jed.getUTCMonth(), jed.getUTCDate(), SYNC_HOUR, SYNC_MINUTE, 0
  ));
  let delta = next.getTime() - jed.getTime();
  if (delta <= 0) delta += 86400000;
  return delta;
}

async function lastSuccessfulSyncMs() {
  const pool = getDb();
  const { rows } = await pool.query(
    `SELECT finished_at FROM kaia_sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1`
  );
  if (!rows[0]?.finished_at) return null;
  // finished_at is a Jeddah wall-clock string; pin the offset to compare.
  const t = Date.parse(String(rows[0].finished_at).replace(' ', 'T') + '+03:00');
  return isNaN(t) ? null : t;
}

function start() {
  if (process.env.KAIA_SYNC_DISABLED === '1') {
    console.log('[kaia-sync] disabled via KAIA_SYNC_DISABLED');
    return;
  }

  // Catch up at boot only when the copy is actually stale, so a redeploy does
  // not hammer KAIA for no reason.
  lastSuccessfulSyncMs()
    .then(last => {
      if (last === null || Date.now() - last > STALE_AFTER_MS) {
        return syncWindow({ reason: last === null ? 'first-run' : 'stale-at-boot' });
      }
      console.log('[kaia-sync] copy is fresh, skipping boot sync');
    })
    .catch(e => console.error('[kaia-sync] boot sync failed:', e.message));

  const schedule = () => {
    const wait = msUntilNextSync();
    console.log(`[kaia-sync] next run in ${(wait / 3600000).toFixed(1)}h`);
    setTimeout(() => {
      syncWindow({ reason: 'scheduled' })
        .catch(e => console.error('[kaia-sync] scheduled run failed:', e.message))
        .finally(schedule);   // re-arm from the clock, not a fixed interval
    }, wait);
  };
  schedule();
}

module.exports = { syncWindow, msUntilNextSync, start, SYNC_HOUR, SYNC_MINUTE };
