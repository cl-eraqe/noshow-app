const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// ── Helpers ───────────────────────────────────────────────────────────

// Convert a Jeddah-local ISO datetime (YYYY-MM-DDTHH:mm or with space) to shift letter
function getShift(dtStr) {
  if (!dtStr) return null;
  const hour = parseInt(String(dtStr).slice(11, 13));
  if (isNaN(hour)) return null;
  if (hour >= 6 && hour < 14) return 'A';
  if (hour >= 14 && hour < 22) return 'B';
  return 'C';
}

// Current Jeddah-time ISO stamp "YYYY-MM-DD HH:mm:ss"
function jeddahNowStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
function jeddahNowDateOnly() {
  return jeddahNowStr().slice(0, 10);
}

// Parse a Jeddah-local date-time to ms-since-epoch (approximation for duration math)
function parseJeddahMs(dtStr) {
  if (!dtStr) return null;
  // Normalize "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm"
  const s = String(dtStr).replace(' ', 'T');
  const ms = Date.parse(s + (s.length === 16 ? ':00' : '') + '+03:00');
  return isNaN(ms) ? null : ms;
}

// Compute date range based on preset ("today", "week", "month", "year") or custom from/to
function computeRange({ range, from, to }) {
  const today = jeddahNowDateOnly();
  // now = jeddah today's end
  let fromDate = today, toDate = today;

  if (range === 'today') {
    fromDate = today; toDate = today;
  } else if (range === 'yesterday') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    fromDate = toDate = d.toISOString().slice(0, 10);
  } else if (range === 'week') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 6);
    fromDate = d.toISOString().slice(0, 10);
    toDate = today;
  } else if (range === 'month') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(1);
    fromDate = d.toISOString().slice(0, 10);
    toDate = today;
  } else if (range === 'year') {
    fromDate = today.slice(0, 4) + '-01-01';
    toDate = today;
  } else if (range === 'all') {
    fromDate = '1970-01-01';
    toDate = '2099-12-31';
  } else if (from || to) {
    fromDate = from || '1970-01-01';
    toDate = to || '2099-12-31';
  }
  return { fromDate, toDate };
}

// Pick the "top and bottom" item in an array of {name, value}
function highlights(arr) {
  if (!arr || arr.length === 0) return { most: null, least: null };
  let most = arr[0], least = arr[0];
  arr.forEach(r => {
    if (r.value > most.value) most = r;
    if (r.value < least.value) least = r;
  });
  return { most, least };
}

// ── Main dashboard endpoint ───────────────────────────────────────────
// Query params: range (today/yesterday/week/month/year/all), from, to,
//   shift, status, airline, nationality, destination, terminal, pax_type
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const { fromDate, toDate } = computeRange(req.query);

  // Pull reports created in range (we base analytics on created_at because that's when
  // the case was logged by staff — matches operational reality)
  const rows = db.prepare(`
    SELECT * FROM reports
    WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)
    ORDER BY created_at ASC
  `).all(fromDate, toDate);

  // Apply secondary filters
  const { shift, status, airline, nationality, destination, terminal, pax_type } = req.query;
  const { TERMINAL_MAP, getAirlineCode } = require('./_terminal-helper');

  const filtered = rows.filter(r => {
    if (shift && getShift(r.created_at) !== shift) return false;
    if (status && r.status !== status) return false;
    if (airline && r.prev_airline !== airline) return false;
    if (nationality && r.nationality !== nationality) return false;
    if (destination) {
      const code = (r.prev_destination || '').match(/\(([A-Z]{3})\)/)?.[1] || r.prev_destination;
      if (code !== destination && r.prev_destination !== destination) return false;
    }
    if (terminal) {
      const t = TERMINAL_MAP[getAirlineCode(r.prev_flight)] || 'T1';
      if (t !== terminal) return false;
    }
    if (pax_type && r.pax_type !== pax_type) return false;
    return true;
  });

  // ── KPI computations ──
  const totalCases = filtered.length;
  const totalPax = filtered.reduce((s, r) => s + (r.pax_count || 0), 0);
  const active = filtered.filter(r => r.status !== 'closed').length;
  const activePax = filtered.filter(r => r.status !== 'closed').reduce((s, r) => s + (r.pax_count || 0), 0);

  // Under process only (not confirmed yet, not closed)
  const underProcessList = filtered.filter(r => r.status === 'under_process');
  const underProcessCases = underProcessList.length;
  const underProcessPax = underProcessList.reduce((s, r) => s + (r.pax_count || 0), 0);

  // Closed
  const closedList = filtered.filter(r => r.status === 'closed');
  const closedCases = closedList.length;
  const closedPax = closedList.reduce((s, r) => s + (r.pax_count || 0), 0);

  // Flight confirmed
  const confirmedList = filtered.filter(r => r.status === 'flight_confirmed');
  const confirmedCases = confirmedList.length;
  const confirmedPax = confirmedList.reduce((s, r) => s + (r.pax_count || 0), 0);

  // Nusuk intervention needed: Umrah + flight_confirmed + new_datetime >= now+24h + nusuk_received is null
  const now = Date.now();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  const needsNusukList = filtered.filter(r => {
    if (r.pax_type !== 'Umrah') return false;
    if (r.status !== 'flight_confirmed') return false;
    if (!r.new_datetime) return false;
    if (r.nusuk_received) return false;
    const newMs = parseJeddahMs(r.new_datetime);
    if (!newMs) return false;
    return (newMs - now) >= twentyFourHoursMs;
  });
  const needsNusukCases = needsNusukList.length;
  const needsNusukPax = needsNusukList.reduce((s, r) => s + (r.pax_count || 0), 0);

  // Avg time-to-rebook (created_at → confirmed_at)
  let rebookMs = [], closeMs = [];
  filtered.forEach(r => {
    const createdMs = parseJeddahMs(r.created_at);
    if (r.confirmed_at && createdMs) {
      const c = parseJeddahMs(r.confirmed_at);
      if (c && c >= createdMs) rebookMs.push(c - createdMs);
    }
    if (r.closed_at && createdMs) {
      const c = parseJeddahMs(r.closed_at);
      if (c && c >= createdMs) closeMs.push(c - createdMs);
    }
  });
  const avgRebookHrs = rebookMs.length ? (rebookMs.reduce((a,b)=>a+b,0) / rebookMs.length / 3600000) : null;
  const avgCloseHrs = closeMs.length ? (closeMs.reduce((a,b)=>a+b,0) / closeMs.length / 3600000) : null;

  // Avg days at airport (snapshot at report time)
  const daysAtAirport = filtered.map(r => r.days_at_airport).filter(d => d != null && !isNaN(d));
  const avgDaysAtAirport = daysAtAirport.length
    ? daysAtAirport.reduce((a,b)=>a+b,0) / daysAtAirport.length : null;

  // Bus transfer %
  const busCount = filtered.filter(r => {
    const t = TERMINAL_MAP[getAirlineCode(r.new_flight)] || 'T1';
    return t === 'North' || t === 'Hajj';
  }).length;
  const busPct = totalCases > 0 ? (busCount / totalCases) * 100 : 0;

  // ── Breakdowns ──
  function groupCount(key, extractor) {
    const map = {};
    filtered.forEach(r => {
      const k = extractor ? extractor(r) : r[key];
      if (!k) return;
      if (!map[k]) map[k] = { name: k, value: 0, pax: 0 };
      map[k].value += 1;
      map[k].pax += (r.pax_count || 0);
    });
    return Object.values(map).sort((a,b) => b.value - a.value);
  }

  const byNationality = groupCount('nationality').slice(0, 10);
  const byAirline = groupCount('prev_airline').slice(0, 10);
  const byDestination = groupCount(null, r => {
    const m = (r.prev_destination || '').match(/\(([A-Z]{3})\)/);
    return m ? m[1] : r.prev_destination;
  }).slice(0, 10);
  const byPaxType = groupCount('pax_type');
  const byShift = groupCount(null, r => getShift(r.created_at));
  // sort shifts A/B/C for display
  ['A','B','C'].forEach(s => { if (!byShift.find(x => x.name === s)) byShift.push({name:s, value:0, pax:0}); });
  byShift.sort((a,b) => a.name.localeCompare(b.name));

  const byTerminal = groupCount(null, r => TERMINAL_MAP[getAirlineCode(r.prev_flight)] || 'T1');

  // ── Days-at-airport histogram ──
  const daysBuckets = { '0d': 0, '1d': 0, '2d': 0, '3d': 0, '4d+': 0 };
  daysAtAirport.forEach(d => {
    if (d < 1) daysBuckets['0d']++;
    else if (d < 2) daysBuckets['1d']++;
    else if (d < 3) daysBuckets['2d']++;
    else if (d < 4) daysBuckets['3d']++;
    else daysBuckets['4d+']++;
  });
  const daysHistogram = Object.entries(daysBuckets).map(([name, value]) => ({ name, value }));

  // ── Resolution time histogram (<1h, 1-4h, 4-12h, 12-24h, 24h+) ──
  const resBuckets = { '<1h':0, '1-4h':0, '4-12h':0, '12-24h':0, '24h+':0 };
  rebookMs.forEach(ms => {
    const h = ms / 3600000;
    if (h < 1) resBuckets['<1h']++;
    else if (h < 4) resBuckets['1-4h']++;
    else if (h < 12) resBuckets['4-12h']++;
    else if (h < 24) resBuckets['12-24h']++;
    else resBuckets['24h+']++;
  });
  const resolutionHistogram = Object.entries(resBuckets).map(([name, value]) => ({ name, value }));

  // ── Peak hours heatmap (7 days × 24 hours) ──
  // Compute day-of-week × hour based on created_at (Jeddah time)
  const heatmap = Array.from({length: 7}, () => Array(24).fill(0));
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  filtered.forEach(r => {
    if (!r.created_at) return;
    const d = new Date(String(r.created_at).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return;
    const day = d.getUTCDay();
    const hr = d.getUTCHours();
    heatmap[day][hr] += 1;
  });
  const heatmapData = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      heatmapData.push({ day: dayNames[d], dayIdx: d, hour: h, value: heatmap[d][h] });
    }
  }

  // ── Volume trend (line) — by day across range ──
  const byDay = {};
  filtered.forEach(r => {
    const day = String(r.created_at || '').slice(0, 10);
    if (!day) return;
    if (!byDay[day]) byDay[day] = { date: day, value: 0, pax: 0 };
    byDay[day].value += 1;
    byDay[day].pax += (r.pax_count || 0);
  });
  const trend = Object.values(byDay).sort((a,b) => a.date.localeCompare(b.date));

  // ── 7-day sparkline data (regardless of range filter) for KPI cards ──
  const last7DaysRaw = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as cases, SUM(pax_count) as pax,
           AVG(days_at_airport) as avg_days,
           SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed_count
    FROM reports
    WHERE date(created_at) >= date(?, '-6 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(jeddahNowDateOnly());
  // Fill missing days
  const sparkCases = [], sparkPax = [], sparkDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(jeddahNowDateOnly() + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = last7DaysRaw.find(r => r.day === key);
    sparkCases.push({ day: key, value: found ? found.cases : 0 });
    sparkPax.push({ day: key, value: found ? (found.pax || 0) : 0 });
    sparkDays.push({ day: key, value: found && found.avg_days != null ? parseFloat(found.avg_days.toFixed(1)) : 0 });
  }

  res.json({
    meta: {
      range: { from: fromDate, to: toDate },
      filters: { shift, status, airline, nationality, destination, terminal, pax_type },
      totalMatched: filtered.length,
    },
    kpi: {
      totalCases,
      totalPax,
      active,
      activePax,
      underProcessCases,
      underProcessPax,
      confirmedCases,
      confirmedPax,
      closedCases,
      closedPax,
      needsNusukCases,
      needsNusukPax,
      needsNusukList,
      avgRebookHrs,
      avgCloseHrs,
      avgDaysAtAirport,
      busPct,
      sparkCases,
      sparkPax,
      sparkDays,
    },
    byNationality: {
      data: byNationality,
      ...highlights(byNationality),
    },
    byAirline: {
      data: byAirline,
      ...highlights(byAirline),
    },
    byDestination: {
      data: byDestination,
      ...highlights(byDestination),
    },
    byPaxType: { data: byPaxType },
    byShift: {
      data: byShift,
      ...highlights(byShift),
    },
    byTerminal: { data: byTerminal },
    daysHistogram,
    resolutionHistogram,
    heatmapData,
    trend,
    // Raw filtered reports for the drill-through table
    reports: filtered,
  });
});

// ── Filter options endpoint — unique values for dropdowns ──
router.get('/filter-options', (_req, res) => {
  const db = getDb();
  const airlines = db.prepare("SELECT DISTINCT prev_airline AS v FROM reports WHERE prev_airline IS NOT NULL AND prev_airline != '' ORDER BY prev_airline").all().map(r => r.v);
  const nationalities = db.prepare("SELECT DISTINCT nationality AS v FROM reports WHERE nationality IS NOT NULL AND nationality != '' ORDER BY nationality").all().map(r => r.v);
  const destinations = db.prepare("SELECT DISTINCT prev_destination AS v FROM reports WHERE prev_destination IS NOT NULL AND prev_destination != '' ORDER BY prev_destination").all()
    .map(r => {
      const m = (r.v || '').match(/\(([A-Z]{3})\)/);
      return m ? m[1] : r.v;
    })
    .filter((v, i, a) => v && a.indexOf(v) === i).sort();
  const paxTypes = db.prepare("SELECT DISTINCT pax_type AS v FROM reports WHERE pax_type IS NOT NULL AND pax_type != '' ORDER BY pax_type").all().map(r => r.v);
  const destinationsFull = db.prepare("SELECT DISTINCT prev_destination AS v FROM reports WHERE prev_destination IS NOT NULL AND prev_destination != '' ORDER BY prev_destination").all().map(r => r.v).filter(Boolean);
  res.json({ airlines, nationalities, destinations, destinationsFull, paxTypes });
});

// ── Audit log endpoint (supervisor only - protection handled at route level in future) ──
router.get('/audit-log', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 500;
  const reportId = req.query.report_id;
  let rows;
  if (reportId) {
    rows = db.prepare('SELECT * FROM audit_log WHERE report_id = ? ORDER BY id DESC LIMIT ?').all(reportId, limit);
  } else {
    rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }
  res.json(rows.map(r => ({
    ...r,
    changes: r.changes ? JSON.parse(r.changes) : null,
    snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
  })));
});

module.exports = router;
