// Keeping the local copy of KAIA's schedule current.
//
// Three cadences, because different fields go stale at different rates:
//
//   00:01 daily   all 9 days (-6..+2), prunes anything outside the window.
//                 Date, scheduled time, destination and airline never move, so
//                 once a day is enough for them — and a past day is re-fetched
//                 too, which is how a gate that moved during the day settles on
//                 its final value.
//   every 15 min  today only. Gates change through the day; this is the day
//                 that has any.
//   every 30 min  tomorrow only. KAIA assigns gates close to departure, so
//                 tomorrow is mostly empty and does not need 15-minute checks.
//
// ~612 requests a day. Nothing here runs while a user is typing: every lookup
// reads the local copy.

const { getDb, jeddahNowStr } = require('./db');
const kaia = require('./kaia');

const SYNC_HOUR = 0;
const SYNC_MINUTE = 1;

const TODAY_REFRESH_MS    = 15 * 60 * 1000;
const TOMORROW_REFRESH_MS = 30 * 60 * 1000;

// Re-sync at startup when the last success is older than this, so a container
// restarting mid-day does not run on a stale copy until midnight.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

// A day's rows are replaced by what the fetch returned, which is how a
// cancelled flight disappears. But a response that is valid yet far smaller
// than what we hold is more likely a bad day at KAIA than 90% of Jeddah's
// departures being cancelled, so the prune is skipped and the old rows kept.
const PRUNE_FLOOR_RATIO = 0.5;
const PRUNE_FLOOR_MIN_ROWS = 20;

// Repeated failures back off instead of retrying every 15 minutes forever.
const MAX_BACKOFF_CYCLES = 8;

// ── State ─────────────────────────────────────────────────────────────────

// One sync at a time. The full run and the two refreshes share a table, and
// overlapping them would have them delete each other's rows.
let running = false;
let consecutiveFailures = 0;
let skipCycles = 0;

// ── Core ──────────────────────────────────────────────────────────────────

/**
 * Fetch the given Jeddah dates and write them into kaia_flights.
 * @param {string[]} dates
 * @param {{mode: string, prune: boolean}} opts
 *   prune=false leaves rows for other dates alone (the refreshes touch one day)
 */
async function syncDates(dates, { mode = 'full', prune = true } = {}) {
  if (running) {
    console.log(`[kaia-sync] ${mode}: another sync is running, skipping`);
    return { skipped: true };
  }
  running = true;

  const pool = getDb();
  const startedAt = jeddahNowStr();
  const stamp = `${startedAt}#${mode}`;   // marks the rows this run touched

  let daysOk = 0, daysFailed = 0, rowsSynced = 0;
  const failures = [];
  const seenAirlines = new Map();

  try {
    for (const date of dates) {
      try {
        const { rows } = await kaia.fetchDay(date);
        const shaped = rows.map(r => kaia.shapeFlight(r, date)).filter(Boolean);

        // Upsert rather than delete-then-insert: if this process dies
        // mid-write the previous copy is still usable.
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
             f.airline_code, f.airline_name, f.destination_code, f.destination_city, stamp]
          );
          if (f.airline_code) {
            const seen = seenAirlines.get(f.airline_code) || { name: f.airline_name, samples: [], count: 0 };
            seen.count++;
            if (seen.samples.length < 3 && !seen.samples.includes(f.flight_number)) seen.samples.push(f.flight_number);
            if (!seen.name && f.airline_name) seen.name = f.airline_name;
            seenAirlines.set(f.airline_code, seen);
          }
        }

        await pruneDate(date, stamp, shaped.length);
        daysOk++;
        rowsSynced += shaped.length;
      } catch (e) {
        // One bad day must not abort the rest, and that date's existing rows
        // are deliberately left untouched.
        daysFailed++;
        failures.push(`${date}: ${e.message}`);
        console.error(`[kaia-sync] ${date} failed:`, e.message);
      }
    }

    if (prune) {
      const all = kaia.windowDates();
      await pool.query(`DELETE FROM kaia_flights WHERE date < $1 OR date > $2`,
        [all[0], all[all.length - 1]]);
    }

    await recordAirlines(seenAirlines);
    const settled = await settleReportExtras();

    const ok = daysOk > 0 && daysFailed === 0;
    if (ok) { consecutiveFailures = 0; skipCycles = 0; }
    else {
      consecutiveFailures++;
      skipCycles = Math.min(2 ** (consecutiveFailures - 1), MAX_BACKOFF_CYCLES);
    }

    await pool.query(
      `INSERT INTO kaia_sync_log (started_at, finished_at, ok, days_ok, days_failed, rows_synced, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [startedAt, jeddahNowStr(), ok ? 1 : 0, daysOk, daysFailed, rowsSynced,
       [mode, settled ? `settled ${settled} report field(s)` : null, ...failures]
         .filter(Boolean).join(' | ').slice(0, 2000)]
    );

    console.log(`[kaia-sync] ${mode}: ${daysOk}/${dates.length} days, ${rowsSynced} flights, ${daysFailed} failed`);
    return { ok, daysOk, daysFailed, rowsSynced, settled, failures };
  } finally {
    running = false;
  }
}

// Drop rows for this date that the fetch did not return — unless the fetch
// came back suspiciously thin, which reads as a KAIA problem rather than mass
// cancellation.
async function pruneDate(date, stamp, fetchedCount) {
  const pool = getDb();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM kaia_flights WHERE date = $1`, [date]);
  const existing = rows[0]?.n || 0;

  if (existing >= PRUNE_FLOOR_MIN_ROWS && fetchedCount < existing * PRUNE_FLOOR_RATIO) {
    console.warn(`[kaia-sync] ${date}: fetched ${fetchedCount} vs ${existing} held — keeping old rows`);
    return;
  }
  await pool.query(
    `DELETE FROM kaia_flights WHERE date = $1 AND synced_at IS DISTINCT FROM $2`, [date, stamp]);
}

async function syncWindow(opts = {}) {
  return syncDates(kaia.windowDates(), { mode: opts.reason || 'full', prune: true });
}

// ── Settling gate / estimated onto saved reports ──────────────────────────
//
// Both are written when a report is saved, but a gate assigned at 00:01 can
// move by noon. While the flight is still inside KAIA's window the live copy
// is more accurate than the snapshot, so each sync writes the current value
// back. Once the flight ages out of the window the last value written stands,
// which by then is the one it actually departed from.
async function settleReportExtras() {
  const pool = getDb();
  const dates = kaia.windowDates();
  const lo = dates[0], hi = dates[dates.length - 1] + 'T23:59';

  const { rows: reports } = await pool.query(
    `SELECT id, prev_flight, prev_datetime, prev_gate, prev_estimated,
            new_flight, new_datetime, new_gate, new_estimated
       FROM reports
      WHERE (prev_datetime >= $1 AND prev_datetime <= $2)
         OR (new_datetime  >= $1 AND new_datetime  <= $2)`, [lo, hi]);
  if (!reports.length) return 0;

  const { rows: flights } = await pool.query(
    `SELECT flight_number, date, gate, estimated_time FROM kaia_flights WHERE date >= $1 AND date <= $2`,
    [lo, dates[dates.length - 1]]);

  // Key on flight number + date; the time may have been edited by hand.
  const byKey = new Map();
  for (const f of flights) byKey.set(`${f.flight_number}|${f.date}`, f);

  const lookup = (flight, datetime) => {
    const day = String(datetime || '').slice(0, 10);
    if (!day) return null;
    return byKey.get(`${kaia.normalizeFlightNumber(flight)}|${day}`) || null;
  };

  let changed = 0;
  for (const r of reports) {
    const sets = [], vals = [];
    const prev = lookup(r.prev_flight, r.prev_datetime);
    if (prev) {
      if ((prev.gate || null) !== (r.prev_gate || null)) { sets.push(`prev_gate = $${sets.length + 1}`); vals.push(prev.gate || null); }
      if ((prev.estimated_time || null) !== (r.prev_estimated || null)) { sets.push(`prev_estimated = $${sets.length + 1}`); vals.push(prev.estimated_time || null); }
    }
    const next = lookup(r.new_flight, r.new_datetime);
    if (next) {
      if ((next.gate || null) !== (r.new_gate || null)) { sets.push(`new_gate = $${sets.length + 1}`); vals.push(next.gate || null); }
      if ((next.estimated_time || null) !== (r.new_estimated || null)) { sets.push(`new_estimated = $${sets.length + 1}`); vals.push(next.estimated_time || null); }
    }
    if (!sets.length) continue;
    vals.push(r.id);
    await pool.query(`UPDATE reports SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    changed += sets.length;
  }
  return changed;
}

// ── Airline review queue ──────────────────────────────────────────────────

// Record every airline code seen. A known code is only counted; a code with no
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
    `SELECT finished_at FROM kaia_sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1`);
  if (!rows[0]?.finished_at) return null;
  // finished_at is a Jeddah wall-clock string; pin the offset to compare.
  const t = Date.parse(String(rows[0].finished_at).replace(' ', 'T') + '+03:00');
  return isNaN(t) ? null : t;
}

// A refresh cycle that respects the failure backoff.
function makeRefresher(label, datesFn) {
  return async () => {
    if (skipCycles > 0) { skipCycles--; return; }
    try {
      await syncDates(datesFn(), { mode: label, prune: false });
    } catch (e) {
      console.error(`[kaia-sync] ${label} failed:`, e.message);
    }
  };
}

function start() {
  if (process.env.KAIA_SYNC_DISABLED === '1') {
    console.log('[kaia-sync] disabled via KAIA_SYNC_DISABLED');
    return;
  }

  // Catch up at boot only when the copy is actually stale, so a redeploy does
  // not pull the whole window again for nothing.
  lastSuccessfulSyncMs()
    .then(last => {
      if (last === null || Date.now() - last > STALE_AFTER_MS) {
        return syncWindow({ reason: last === null ? 'first-run' : 'stale-at-boot' });
      }
      console.log('[kaia-sync] copy is fresh, skipping boot sync');
    })
    .catch(e => console.error('[kaia-sync] boot sync failed:', e.message));

  // Full window, re-armed from the clock each night rather than on a fixed
  // interval, so it cannot drift.
  const scheduleFull = () => {
    const wait = msUntilNextSync();
    console.log(`[kaia-sync] next full run in ${(wait / 3600000).toFixed(1)}h`);
    setTimeout(() => {
      syncWindow({ reason: 'scheduled' })
        .catch(e => console.error('[kaia-sync] scheduled run failed:', e.message))
        .finally(scheduleFull);
    }, wait);
  };
  scheduleFull();

  // Gates move through the day; these keep today (and, more slowly, tomorrow)
  // current. windowDates() is recomputed each tick so the pair follows the
  // date over midnight without a restart.
  const today    = () => [kaia.windowDates()[kaia.DAYS_BACK]];
  const tomorrow = () => [kaia.windowDates()[kaia.DAYS_BACK + 1]];
  setInterval(makeRefresher('today', today), TODAY_REFRESH_MS);
  setInterval(makeRefresher('tomorrow', tomorrow), TOMORROW_REFRESH_MS);
  console.log('[kaia-sync] refreshing today every 15m, tomorrow every 30m');
}

module.exports = {
  syncWindow, syncDates, settleReportExtras, msUntilNextSync, start,
  SYNC_HOUR, SYNC_MINUTE, TODAY_REFRESH_MS, TOMORROW_REFRESH_MS,
  _state: () => ({ running, consecutiveFailures, skipCycles }),
  _resetState: () => { running = false; consecutiveFailures = 0; skipCycles = 0; },
};
