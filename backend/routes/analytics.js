const express = require('express');
const router  = express.Router();
const { getDb, jeddahNowStr } = require('../db');
const { requireRole } = require('../middleware/auth');

function getShift(dtStr) {
  if (!dtStr) return null;
  const hour = parseInt(String(dtStr).slice(11, 13));
  if (isNaN(hour)) return null;
  if (hour >= 6 && hour < 14) return 'A';
  if (hour >= 14 && hour < 22) return 'B';
  return 'C';
}

function jeddahNowDateOnly() {
  return jeddahNowStr().slice(0, 10);
}

function parseJeddahMs(dtStr) {
  if (!dtStr) return null;
  const s = String(dtStr).replace(' ', 'T');
  const ms = Date.parse(s + (s.length === 16 ? ':00' : '') + '+03:00');
  return isNaN(ms) ? null : ms;
}

function computeRange({ range, from, to }) {
  const today = jeddahNowDateOnly();
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
    fromDate = d.toISOString().slice(0, 10); toDate = today;
  } else if (range === 'month') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(1);
    fromDate = d.toISOString().slice(0, 10); toDate = today;
  } else if (range === 'year') {
    fromDate = today.slice(0, 4) + '-01-01'; toDate = today;
  } else if (range === 'all') {
    fromDate = '1970-01-01'; toDate = '2099-12-31';
  } else if (from || to) {
    fromDate = from || '1970-01-01'; toDate = to || '2099-12-31';
  }
  return { fromDate, toDate };
}

function highlights(arr, metric = 'value') {
  if (!arr || arr.length === 0) return { most: null, least: null };
  let most = arr[0], least = arr[0];
  arr.forEach(r => {
    if (r[metric] > most[metric]) most = r;
    if (r[metric] < least[metric]) least = r;
  });
  return { most, least };
}

router.get('/dashboard', async (req, res) => {
  try {
    const pool = getDb();
    const { fromDate, toDate } = computeRange(req.query);

    const { rows } = await pool.query(
      `SELECT * FROM reports
       WHERE LEFT(created_at, 10) >= $1 AND LEFT(created_at, 10) <= $2
       ORDER BY created_at ASC`,
      [fromDate, toDate]
    );

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

    const totalCases = filtered.length;
    const totalPax = filtered.reduce((s, r) => s + (r.pax_count || 0), 0);
    const active = filtered.filter(r => r.status !== 'closed').length;
    const activePax = filtered.filter(r => r.status !== 'closed').reduce((s, r) => s + (r.pax_count || 0), 0);

    const underProcessList = filtered.filter(r => r.status === 'under_process');
    const underProcessCases = underProcessList.length;
    const underProcessPax = underProcessList.reduce((s, r) => s + (r.pax_count || 0), 0);

    const closedList = filtered.filter(r => r.status === 'closed');
    const closedCases = closedList.length;
    const closedPax = closedList.reduce((s, r) => s + (r.pax_count || 0), 0);

    const confirmedList = filtered.filter(r => r.status === 'flight_confirmed');
    const confirmedCases = confirmedList.length;
    const confirmedPax = confirmedList.reduce((s, r) => s + (r.pax_count || 0), 0);

    const now = Date.now();
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;

    // Process completed: closed AND new (confirmed) flight departed within last 12 hrs
    const departedRecentList = filtered.filter(r => {
      if (r.status !== 'closed') return false;
      if (!r.new_datetime) return false;
      const ms = parseJeddahMs(r.new_datetime);
      if (!ms) return false;
      const diff = now - ms;
      return diff >= 0 && diff <= twelveHoursMs;
    });
    const departedRecentCases = departedRecentList.length;
    const departedRecentPax = departedRecentList.reduce((s, r) => s + (r.pax_count || 0), 0);

    // Currently at airport with a new flight departing in <12 hrs
    const atAirportSoonList = filtered.filter(r => {
      if (r.status !== 'flight_confirmed') return false;
      if (!r.new_datetime) return false;
      const ms = parseJeddahMs(r.new_datetime);
      if (!ms) return false;
      const diff = ms - now;
      return diff > 0 && diff < twelveHoursMs;
    });
    const atAirportSoonCases = atAirportSoonList.length;
    const atAirportSoonPax = atAirportSoonList.reduce((s, r) => s + (r.pax_count || 0), 0);

    // Currently at airport with a new flight departing in >=12 hrs
    const atAirportLaterList = filtered.filter(r => {
      if (r.status !== 'flight_confirmed') return false;
      if (!r.new_datetime) return false;
      const ms = parseJeddahMs(r.new_datetime);
      if (!ms) return false;
      return (ms - now) >= twelveHoursMs;
    });
    const atAirportLaterCases = atAirportLaterList.length;
    const atAirportLaterPax = atAirportLaterList.reduce((s, r) => s + (r.pax_count || 0), 0);

    // Pax at airport over 24 hrs: not closed AND prev (missed) flight was >24h ago
    const stuck24List = filtered.filter(r => {
      if (r.status === 'closed') return false;
      if (!r.prev_datetime) return false;
      const ms = parseJeddahMs(r.prev_datetime);
      if (!ms) return false;
      return (now - ms) >= twentyFourHoursMs;
    });
    const stuck24Cases = stuck24List.length;
    const stuck24Pax = stuck24List.reduce((s, r) => s + (r.pax_count || 0), 0);

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

    const daysAtAirport = filtered.map(r => r.days_at_airport).filter(d => d != null && !isNaN(d));
    const avgDaysAtAirport = daysAtAirport.length ? daysAtAirport.reduce((a,b)=>a+b,0) / daysAtAirport.length : null;

    const busCount = filtered.filter(r => {
      const t = TERMINAL_MAP[getAirlineCode(r.new_flight)] || 'T1';
      return t === 'North' || t === 'Hajj';
    }).length;
    const busPct = totalCases > 0 ? (busCount / totalCases) * 100 : 0;

    function groupCount(key, extractor, sortBy = 'value') {
      const map = {};
      filtered.forEach(r => {
        const k = extractor ? extractor(r) : r[key];
        if (!k) return;
        if (!map[k]) map[k] = { name: k, value: 0, pax: 0 };
        map[k].value += 1;
        map[k].pax += (r.pax_count || 0);
      });
      return Object.values(map).sort((a,b) => b[sortBy] - a[sortBy]);
    }

    // Nationality, airline and flight lists are ranked by total pax (a single
    // 40-pax case matters more than ten 1-pax cases), not by case count.
    const byNationality = groupCount('nationality', null, 'pax').slice(0, 10);
    const byAirline = groupCount('prev_airline', null, 'pax').slice(0, 10);
    // Top no-show flights, aggregated by flight number across all dates.
    const byFlight = groupCount('prev_flight', null, 'pax').slice(0, 15);
    const byDestination = groupCount(null, r => {
      const m = (r.prev_destination || '').match(/\(([A-Z]{3})\)/);
      return m ? m[1] : r.prev_destination;
    }).slice(0, 10);
    const byPaxType = groupCount('pax_type');
    const byShift = groupCount(null, r => getShift(r.created_at));
    ['A','B','C'].forEach(s => { if (!byShift.find(x => x.name === s)) byShift.push({name:s, value:0, pax:0}); });
    byShift.sort((a,b) => a.name.localeCompare(b.name));
    const byTerminal = groupCount(null, r => TERMINAL_MAP[getAirlineCode(r.prev_flight)] || 'T1');

    const daysBuckets = { '0d': 0, '1d': 0, '2d': 0, '3d': 0, '4d+': 0 };
    daysAtAirport.forEach(d => {
      if (d < 1) daysBuckets['0d']++;
      else if (d < 2) daysBuckets['1d']++;
      else if (d < 3) daysBuckets['2d']++;
      else if (d < 4) daysBuckets['3d']++;
      else daysBuckets['4d+']++;
    });
    const daysHistogram = Object.entries(daysBuckets).map(([name, value]) => ({ name, value }));

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

    const heatmap = Array.from({length: 7}, () => Array(24).fill(0));
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    filtered.forEach(r => {
      if (!r.created_at || r.created_at.length < 13) return;
      const jeddahHour = parseInt(r.created_at.slice(11, 13));
      const jeddahDay  = new Date(r.created_at.slice(0, 10) + 'T12:00:00Z').getUTCDay();
      if (isNaN(jeddahHour) || isNaN(jeddahDay)) return;
      heatmap[jeddahDay][jeddahHour] += 1;
    });
    const heatmapData = [];
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        heatmapData.push({ day: dayNames[d], dayIdx: d, hour: h, value: heatmap[d][h] });
      }
    }

    const byDay = {};
    filtered.forEach(r => {
      const day = String(r.created_at || '').slice(0, 10);
      if (!day) return;
      if (!byDay[day]) byDay[day] = { date: day, value: 0, pax: 0 };
      byDay[day].value += 1;
      byDay[day].pax += (r.pax_count || 0);
    });
    const trend = Object.values(byDay).sort((a,b) => a.date.localeCompare(b.date));

    // 7-day sparkline — compute 6-days-ago date in JS
    const sixDaysAgoD = new Date(jeddahNowDateOnly() + 'T00:00:00Z');
    sixDaysAgoD.setUTCDate(sixDaysAgoD.getUTCDate() - 6);
    const sixDaysAgo = sixDaysAgoD.toISOString().slice(0, 10);

    const { rows: last7DaysRaw } = await pool.query(
      `SELECT LEFT(created_at, 10) as day, COUNT(*) as cases, SUM(pax_count) as pax,
              AVG(days_at_airport) as avg_days,
              SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed_count
       FROM reports
       WHERE LEFT(created_at, 10) >= $1
       GROUP BY LEFT(created_at, 10)
       ORDER BY day ASC`,
      [sixDaysAgo]
    );

    const sparkCases = [], sparkPax = [], sparkDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(jeddahNowDateOnly() + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = last7DaysRaw.find(r => r.day === key);
      sparkCases.push({ day: key, value: found ? parseInt(found.cases) : 0 });
      sparkPax.push({ day: key, value: found ? (parseInt(found.pax) || 0) : 0 });
      sparkDays.push({ day: key, value: found && found.avg_days != null ? parseFloat(parseFloat(found.avg_days).toFixed(1)) : 0 });
    }

    res.json({
      meta: { range: { from: fromDate, to: toDate }, filters: { shift, status, airline, nationality, destination, terminal, pax_type }, totalMatched: filtered.length },
      kpi: { totalCases, totalPax, active, activePax, underProcessCases, underProcessPax, confirmedCases, confirmedPax, closedCases, closedPax, needsNusukCases, needsNusukPax, needsNusukList, departedRecentCases, departedRecentPax, atAirportSoonCases, atAirportSoonPax, atAirportLaterCases, atAirportLaterPax, stuck24Cases, stuck24Pax, avgRebookHrs, avgCloseHrs, avgDaysAtAirport, busPct, sparkCases, sparkPax, sparkDays },
      byNationality: { data: byNationality, ...highlights(byNationality, 'pax') },
      byAirline: { data: byAirline, ...highlights(byAirline, 'pax') },
      byFlight: { data: byFlight, ...highlights(byFlight, 'pax') },
      byDestination: { data: byDestination, ...highlights(byDestination) },
      byPaxType: { data: byPaxType },
      byShift: { data: byShift, ...highlights(byShift) },
      byTerminal: { data: byTerminal },
      daysHistogram, resolutionHistogram, heatmapData, trend,
      reports: filtered,
    });
  } catch (e) {
    console.error('[GET /analytics/dashboard]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/filter-options', async (_req, res) => {
  try {
    const pool = getDb();
    const [a, n, d, p] = await Promise.all([
      pool.query("SELECT DISTINCT prev_airline AS v FROM reports WHERE prev_airline IS NOT NULL AND prev_airline != '' ORDER BY prev_airline"),
      pool.query("SELECT DISTINCT nationality AS v FROM reports WHERE nationality IS NOT NULL AND nationality != '' ORDER BY nationality"),
      pool.query("SELECT DISTINCT prev_destination AS v FROM reports WHERE prev_destination IS NOT NULL AND prev_destination != '' ORDER BY prev_destination"),
      pool.query("SELECT DISTINCT pax_type AS v FROM reports WHERE pax_type IS NOT NULL AND pax_type != '' ORDER BY pax_type"),
    ]);
    const airlines = a.rows.map(r => r.v);
    const nationalities = n.rows.map(r => r.v);
    const destinationsFull = d.rows.map(r => r.v).filter(Boolean);
    const destinations = destinationsFull.map(v => { const m = (v || '').match(/\(([A-Z]{3})\)/); return m ? m[1] : v; }).filter((v, i, arr) => v && arr.indexOf(v) === i).sort();
    const paxTypes = p.rows.map(r => r.v);
    res.json({ airlines, nationalities, destinations, destinationsFull, paxTypes });
  } catch (e) {
    console.error('[GET /analytics/filter-options]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Full audit log is sensitive — supervisor access only.
router.get('/audit-log', requireRole('supervisor'), async (req, res) => {
  try {
    const pool = getDb();
    const limit = parseInt(req.query.limit) || 500;
    const reportId = req.query.report_id;
    let rows;
    if (reportId) {
      ({ rows } = await pool.query('SELECT * FROM audit_log WHERE report_id = $1 ORDER BY id DESC LIMIT $2', [reportId, limit]));
    } else {
      ({ rows } = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit]));
    }
    res.json(rows.map(r => ({
      ...r,
      changes: r.changes ? JSON.parse(r.changes) : null,
      snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
    })));
  } catch (e) {
    console.error('[GET /analytics/audit-log]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
