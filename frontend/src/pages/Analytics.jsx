import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, AreaChart, Area,
} from 'recharts';
import { getDashboardData, getFilterOptions } from '../utils/api';

// ── Nationality → ISO country code for flagcdn.com
// Each entry maps BOTH the adjective form ("Ethiopian") and the country name
// ("Ethiopia") so legacy reports with inconsistent entries still get a flag.
const NATIONALITY_FLAGS = {
  Afghan: 'af', Afghanistan: 'af',
  Algerian: 'dz', Algeria: 'dz',
  American: 'us', 'United States': 'us',
  Bahraini: 'bh', Bahrain: 'bh',
  Bangladeshi: 'bd', Bangladesh: 'bd',
  Belgian: 'be', Belgium: 'be',
  Beninese: 'bj', Benin: 'bj',
  British: 'gb', 'United Kingdom': 'gb',
  Burkinabe: 'bf', 'Burkina Faso': 'bf',
  Burundian: 'bi', Burundi: 'bi',
  Cameroonian: 'cm', Cameroon: 'cm',
  Canadian: 'ca', Canada: 'ca',
  Chadian: 'td', Chad: 'td',
  Chinese: 'cn', China: 'cn',
  Czech: 'cz', 'Czech Republic': 'cz', Czechia: 'cz',
  Djiboutian: 'dj', Djibouti: 'dj',
  Dutch: 'nl', Netherlands: 'nl', Holland: 'nl',
  Egyptian: 'eg', Egypt: 'eg',
  Emirati: 'ae', UAE: 'ae', 'United Arab Emirates': 'ae',
  Ethiopian: 'et', Ethiopia: 'et',
  Filipino: 'ph', Philippines: 'ph',
  French: 'fr', France: 'fr',
  Gambian: 'gm', Gambia: 'gm',
  Indian: 'in', India: 'in',
  Indonesian: 'id', Indonesia: 'id',
  Jordanian: 'jo', Jordan: 'jo',
  Kenyan: 'ke', Kenya: 'ke',
  Kuwaiti: 'kw', Kuwait: 'kw',
  Malian: 'ml', Mali: 'ml',
  Mauritian: 'mu', Mauritius: 'mu',
  Moroccan: 'ma', Morocco: 'ma',
  Nepali: 'np', Nepal: 'np',
  Nigerian: 'ng', Nigeria: 'ng',
  Nigerien: 'ne', Niger: 'ne',
  Omani: 'om', Oman: 'om',
  Pakistani: 'pk', Pakistan: 'pk',
  Palestinian: 'ps', Palestine: 'ps',
  Saudi: 'sa', 'Saudi Arabia': 'sa',
  Spanish: 'es', Spain: 'es',
  Sudanese: 'sd', Sudan: 'sd',
  Swiss: 'ch', Switzerland: 'ch',
  Syrian: 'sy', Syria: 'sy',
  Tajik: 'tj', Tajikistan: 'tj',
  Tunisian: 'tn', Tunisia: 'tn',
  Turkish: 'tr', Turkey: 'tr',
  Ugandan: 'ug', Uganda: 'ug',
  Uzbek: 'uz', Uzbekistan: 'uz',
  Yemeni: 'ye', Yemen: 'ye',
  Zimbabwean: 'zw', Zimbabwe: 'zw',
};
const flagUrl = (nat) => {
  const code = NATIONALITY_FLAGS[nat];
  return code ? `https://flagcdn.com/w640/${code}.png` : null;
};

// ── Airline brand colors + logos (place logos at /public/airlines/{IATA}.png)
const AIRLINE_BRAND = {
  Saudia:   { color: '#00623B', accent: '#b99657', logo: '/airlines/SV.png' },
  flynas:   { color: '#00B2A9', accent: '#004F4B', logo: '/airlines/XY.png' },
  Flyadeal: { color: '#5B2A86', accent: '#C4D600', logo: '/airlines/F3.png' },
};

const RANGE_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This Week',
  month: 'This Month',
  year: 'This Year',
  all: 'All Time',
  custom: 'Custom',
};

// ── Widget list (used by the toggle drawer) ──
const WIDGETS = [
  { id: 'kpi_underProcess',  label: 'KPI · Under Process',      defaultOn: true },
  { id: 'kpi_nusuk',         label: 'KPI · Nusuk Intervention', defaultOn: true },
  { id: 'kpi_departedRecent',label: 'KPI · Departed (last 12h)',defaultOn: true },
  { id: 'kpi_atAirportSoon', label: 'KPI · New Flight < 12h',   defaultOn: true },
  { id: 'kpi_atAirportLater',label: 'KPI · New Flight ≥ 12h',   defaultOn: true },
  { id: 'kpi_stuck24',       label: 'KPI · At Airport > 24h',   defaultOn: true },
  { id: 'kpi_confirmed',     label: 'KPI · Flight Confirmed',   defaultOn: true },
  { id: 'kpi_closed',        label: 'KPI · Closed',             defaultOn: true },
  { id: 'kpi_total',         label: 'KPI · Total Cases',        defaultOn: true },
  { id: 'kpi_rebook',        label: 'KPI · Avg Rebook Time',    defaultOn: true },
  { id: 'kpi_close',         label: 'KPI · Avg Close Time',     defaultOn: true },
  { id: 'kpi_days',          label: 'KPI · Avg Days at Airport',defaultOn: true },
  { id: 'chart_nationality', label: 'Chart · By Nationality',   defaultOn: true },
  { id: 'chart_airline',     label: 'Chart · By Airline',       defaultOn: true },
  { id: 'chart_destination', label: 'Chart · By Destination',   defaultOn: true },
  { id: 'chart_shift',       label: 'Chart · By Shift',         defaultOn: true },
  { id: 'chart_paxtype',     label: 'Chart · Passenger Type',   defaultOn: true },
  { id: 'chart_days',        label: 'Chart · Days at Airport',  defaultOn: true },
  { id: 'chart_resolution',  label: 'Chart · Resolution Time',  defaultOn: true },
  { id: 'chart_heatmap',     label: 'Chart · Peak Hours',       defaultOn: true },
  { id: 'chart_trend',       label: 'Chart · Volume Trend',     defaultOn: true },
  { id: 'table_drill',       label: 'Table · Recent Cases',     defaultOn: true },
];

const PIE_COLORS = ['#39d0d8','#f5c842','#ff6b9d','#b794f4','#4ade80','#fb923c','#60a5fa'];

function fmtHrs(hrs) {
  if (hrs == null || isNaN(hrs)) return '—';
  if (hrs < 1)  return `${Math.round(hrs * 60)}m`;
  if (hrs < 24) return `${hrs.toFixed(1)}h`;
  return `${(hrs / 24).toFixed(1)}d`;
}

// ── Sparkline (mini area under KPI)
function Sparkline({ data, color = '#39d0d8' }) {
  if (!data || data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={32}>
      <AreaChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <defs>
          <linearGradient id={`sg-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor={color} stopOpacity={0.6}/>
            <stop offset="100%" stopColor={color} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5}
              fill={`url(#sg-${color})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── KPI Card ──
function KpiCard({ label, value, sub, cases, pax, color, accent, spark, status, onClick, flash, active }) {
  return (
    <div className={`xkpi ${flash ? 'xkpi-flash' : ''} ${active ? 'xkpi-active' : ''} ${onClick ? 'xkpi-clickable' : ''}`}
         style={{ '--kpi-color': color, '--kpi-accent': accent || color }}
         onClick={onClick}>
      <div className="xkpi-top">
        <span className="xkpi-label">{label}</span>
        {status && <span className="xkpi-status">{status}</span>}
      </div>
      <div className="xkpi-value">{value}</div>
      {(cases != null || pax != null) ? (
        <div className="xkpi-meta">
          {cases != null && <span><b>{cases}</b> cases</span>}
          {pax != null && <span><b>{pax}</b> pax</span>}
        </div>
      ) : sub ? <div className="xkpi-sub">{sub}</div> : null}
      {spark && <div className="xkpi-spark"><Sparkline data={spark} color={color} /></div>}
    </div>
  );
}

// ── Custom horizontal bar list (for Nationality with flags & Airline with logos)
function BrandedBarList({ data, mode, onClick }) {
  if (!data || data.length === 0) {
    return <div className="xchart-empty">No data</div>;
  }
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="xbarlist">
      {data.map((d, i) => {
        const pct = Math.max(4, (d.value / max) * 100);
        const brand = mode === 'airline' ? AIRLINE_BRAND[d.name] : null;
        const flag = mode === 'nationality' ? flagUrl(d.name) : null;
        const bg =
          flag ? `linear-gradient(90deg, rgba(12,22,40,0.10), rgba(12,22,40,0.25)), url(${flag}) center/cover no-repeat` :
          brand ? brand.color :
          'linear-gradient(90deg, #2563eb, #38bdf8)';
        return (
          <div key={i} className="xbarlist-row" onClick={() => onClick && onClick(d.name)}>
            <div className="xbarlist-name">
              {brand && <img src={brand.logo} alt="" className="xbarlist-logo"
                             onError={e => { e.target.style.display='none'; }} />}
              <span>{d.name}</span>
            </div>
            <div className="xbarlist-track">
              <div className="xbarlist-fill"
                   style={{
                     width: `${pct}%`,
                     background: bg,
                     borderColor: brand ? brand.accent : 'transparent',
                   }}>
                <span className="xbarlist-val">
                  <b>{d.value}</b>{d.pax != null && <span className="pax"> · {d.pax} pax</span>}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Peak Hours Heatmap (dark) ──
function Heatmap({ data }) {
  const max = Math.max(1, ...data.map(d => d.value));
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return (
    <div className="xheatmap">
      <div className="xheatmap-row xheatmap-head">
        <div className="xheatmap-dlab"></div>
        {Array.from({length:24}).map((_, h) => (
          <div key={h} className="xheatmap-hlab">{h}</div>
        ))}
      </div>
      {dayNames.map((d, di) => (
        <div key={d} className="xheatmap-row">
          <div className="xheatmap-dlab">{d}</div>
          {Array.from({length:24}).map((_, h) => {
            const cell = data.find(x => x.dayIdx === di && x.hour === h);
            const v = cell ? cell.value : 0;
            const intensity = v / max;
            const bg = intensity === 0
              ? 'rgba(255,255,255,0.04)'
              : `rgba(57, 208, 216, ${0.12 + intensity * 0.78})`;
            return (
              <div key={h} className="xheatmap-cell"
                   style={{ background: bg, color: intensity > 0.55 ? '#0b1220' : '#a9bfd1' }}
                   title={`${d} ${h}:00 → ${v} cases`}>
                {v > 0 ? v : ''}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── LocalStorage helper
const loadWidgets = () => {
  try {
    const s = JSON.parse(localStorage.getItem('exec_widgets') || 'null');
    if (s && typeof s === 'object') return s;
  } catch (_) {}
  const init = {};
  WIDGETS.forEach(w => { init[w.id] = w.defaultOn; });
  return init;
};

export default function Analytics() {
  const navigate = useNavigate();
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  // Filters
  const [range, setRange]   = useState('all');
  const [from, setFrom]     = useState('');
  const [to, setTo]         = useState('');
  const [shift, setShift]   = useState('');
  const [status, setStatus] = useState('');
  const [airline, setAirline] = useState('');
  const [nationality, setNat] = useState('');
  const [destination, setDest] = useState('');
  const [paxType, setPaxType] = useState('');
  const [drill, setDrill] = useState(null);

  const [filterOpts, setFilterOpts] = useState({ airlines: [], nationalities: [], destinations: [], paxTypes: [] });
  const [widgets, setWidgets] = useState(loadWidgets);
  const [widgetDrawer, setWidgetDrawer] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [kpiFilter, setKpiFilter] = useState(null); // { id, label, predicate }

  // persist widget toggles
  useEffect(() => {
    localStorage.setItem('exec_widgets', JSON.stringify(widgets));
  }, [widgets]);

  // live clock
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getFilterOptions().then(setFilterOpts).catch(() => {});
  }, []);

  async function reload() {
    setLoading(true);
    setError('');
    try {
      const payload = {
        range: range === 'custom' ? '' : range,
        from: range === 'custom' ? from : '',
        to:   range === 'custom' ? to : '',
        shift, status, airline, nationality, destination, pax_type: paxType,
      };
      if (drill) payload[drill.field] = drill.value;
      const d = await getDashboardData(payload);
      setData(d);
    } catch (e) { setError(e.message); }
    finally    { setLoading(false); }
  }

  useEffect(() => { reload(); }, [range, from, to, shift, status, airline, nationality, destination, paxType, drill]);

  // auto-refresh every 30s for TV mode
  useEffect(() => {
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  });

  const kpi = data?.kpi;

  const activeFilterCount = [shift, status, airline, nationality, destination, paxType].filter(Boolean).length + (drill ? 1 : 0);

  function onDrill(field, name) { setDrill({ field, value: name, label: name }); }
  function clearDrill() { setDrill(null); }
  function clearAllFilters() {
    setShift(''); setStatus(''); setAirline(''); setNat('');
    setDest(''); setPaxType(''); setDrill(null);
  }
  function toggleWidget(id) {
    setWidgets(prev => ({ ...prev, [id]: !prev[id] }));
  }

  // ── KPI drill-down predicates (client-side filter on data.reports)
  function parseMs(dt) {
    if (!dt) return null;
    const s = String(dt).replace(' ', 'T');
    const ms = Date.parse(s + (s.length === 16 ? ':00' : '') + '+03:00');
    return isNaN(ms) ? null : ms;
  }
  function pickKpi(id, label) {
    if (kpiFilter && kpiFilter.id === id) { setKpiFilter(null); return; }
    const now = Date.now();
    const H12 = 12 * 3600 * 1000;
    const H24 = 24 * 3600 * 1000;
    const preds = {
      kpi_underProcess: r => r.status === 'under_process',
      kpi_confirmed:    r => r.status === 'flight_confirmed',
      kpi_closed:       r => r.status === 'closed',
      kpi_total:        () => true,
      kpi_nusuk: r => r.pax_type === 'Umrah' && r.status === 'flight_confirmed'
                     && !r.nusuk_received && r.new_datetime
                     && (parseMs(r.new_datetime) - now) >= H24,
      kpi_departedRecent: r => {
        if (r.status !== 'closed' || !r.new_datetime) return false;
        const ms = parseMs(r.new_datetime); if (!ms) return false;
        const d = now - ms; return d >= 0 && d <= H12;
      },
      kpi_atAirportSoon: r => {
        if (r.status !== 'flight_confirmed' || !r.new_datetime) return false;
        const ms = parseMs(r.new_datetime); if (!ms) return false;
        const d = ms - now; return d > 0 && d < H12;
      },
      kpi_atAirportLater: r => {
        if (r.status !== 'flight_confirmed' || !r.new_datetime) return false;
        const ms = parseMs(r.new_datetime); if (!ms) return false;
        return (ms - now) >= H12;
      },
      kpi_stuck24: r => {
        if (r.status === 'closed' || !r.prev_datetime) return false;
        const ms = parseMs(r.prev_datetime); if (!ms) return false;
        return (now - ms) >= H24;
      },
    };
    if (preds[id]) setKpiFilter({ id, label, predicate: preds[id] });
  }
  function clearKpiFilter() { setKpiFilter(null); }

  const jeddahTime = clock.toLocaleString('en-GB', {
    timeZone: 'Asia/Riyadh',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const on = (id) => widgets[id];

  return (
    <div className="exec-dashboard">
      {/* ── Header Bar ── */}
      <header className="xheader">
        <div className="xheader-left">
          <div className="xlive-dot"/>
          <div>
            <div className="xtitle">NO-SHOW PASSENGER INTELLIGENCE</div>
            <div className="xsubtitle">Operations Control Center · Terminal 1</div>
          </div>
        </div>
        <div className="xheader-center">
          <div className="xchips">
            {['today','yesterday','week','month','year','all','custom'].map(r => (
              <button key={r}
                      className={`xchip ${range === r ? 'active' : ''}`}
                      onClick={() => setRange(r)}>
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="xcustomrange">
              <input type="date" className="xinput" value={from} onChange={e => setFrom(e.target.value)} />
              <span>→</span>
              <input type="date" className="xinput" value={to} onChange={e => setTo(e.target.value)} />
            </div>
          )}
        </div>
        <div className="xheader-right">
          <div className="xclock">
            <div className="xclock-time">{jeddahTime}</div>
            <div className="xclock-label">Jeddah Local</div>
          </div>
          <button className="xiconbtn" onClick={() => setWidgetDrawer(!widgetDrawer)}
                  title="Configure visible widgets">⚙</button>
          <button className="xiconbtn" onClick={() => navigate('/dashboard')}
                  title="Back to Dashboard">←</button>
        </div>
      </header>

      {/* ── Secondary filter row ── */}
      <div className="xfilterbar">
        <select className="xinput" value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">All Shifts</option>
          <option value="A">Shift A (06-14)</option>
          <option value="B">Shift B (14-22)</option>
          <option value="C">Shift C (22-06)</option>
        </select>
        <select className="xinput" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All Status</option>
          <option value="under_process">Under Process</option>
          <option value="flight_confirmed">Flight Confirmed</option>
          <option value="closed">Closed</option>
        </select>
        <select className="xinput" value={paxType} onChange={e => setPaxType(e.target.value)}>
          <option value="">All Pax Types</option>
          {filterOpts.paxTypes.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="xinput" value={airline} onChange={e => setAirline(e.target.value)}>
          <option value="">All Airlines</option>
          {filterOpts.airlines.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="xinput" value={nationality} onChange={e => setNat(e.target.value)}>
          <option value="">All Nationalities</option>
          {filterOpts.nationalities.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className="xinput" value={destination} onChange={e => setDest(e.target.value)}>
          <option value="">All Destinations</option>
          {filterOpts.destinations.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        {activeFilterCount > 0 && (
          <button className="xclearbtn" onClick={clearAllFilters}>Clear ({activeFilterCount}) ✕</button>
        )}
        {drill && (
          <div className="xdrill">
            Drill: <strong>{drill.label}</strong>
            <button onClick={clearDrill}>×</button>
          </div>
        )}
      </div>

      {/* ── Widget drawer ── */}
      {widgetDrawer && (
        <div className="xdrawer-overlay" onClick={() => setWidgetDrawer(false)}>
          <div className="xdrawer" onClick={e => e.stopPropagation()}>
            <div className="xdrawer-head">
              <h3>Customize Dashboard</h3>
              <button className="xiconbtn" onClick={() => setWidgetDrawer(false)}>×</button>
            </div>
            <p className="xdrawer-hint">Uncheck widgets to hide them — the remaining ones will expand to fill the screen.</p>
            <div className="xdrawer-list">
              {WIDGETS.map(w => (
                <label key={w.id} className="xdrawer-item">
                  <input type="checkbox" checked={!!widgets[w.id]} onChange={() => toggleWidget(w.id)} />
                  <span>{w.label}</span>
                </label>
              ))}
            </div>
            <div className="xdrawer-foot">
              <button className="xchip" onClick={() => {
                const all = {}; WIDGETS.forEach(w => { all[w.id] = true; }); setWidgets(all);
              }}>Show all</button>
              <button className="xchip" onClick={() => {
                const none = {}; WIDGETS.forEach(w => { none[w.id] = false; }); setWidgets(none);
              }}>Hide all</button>
            </div>
          </div>
        </div>
      )}

      {loading && !data && <div className="xstate">Loading intelligence…</div>}
      {error && <div className="xstate xerror">{error}</div>}

      {data && kpi && (
        <>
          {/* ── KPI strip ── */}
          <section className="xkpi-strip">
            {on('kpi_underProcess') && (
              <KpiCard label="UNDER PROCESS"
                       value={kpi.underProcessCases}
                       cases={kpi.underProcessCases}
                       pax={kpi.underProcessPax}
                       status={kpi.underProcessCases > 0 ? 'Needs action' : 'All clear'}
                       color="#ff8c42" accent="#ffb366"
                       active={kpiFilter?.id === 'kpi_underProcess'}
                       onClick={() => pickKpi('kpi_underProcess', 'Under Process')} />
            )}
            {on('kpi_nusuk') && (
              <KpiCard label="NUSUK INTERVENTION"
                       value={kpi.needsNusukCases}
                       cases={kpi.needsNusukCases}
                       pax={kpi.needsNusukPax}
                       status={kpi.needsNusukCases > 0 ? '⚠ Notify Ministry' : '✓ Up to date'}
                       color="#1abc9c" accent="#26d7b3"
                       flash={kpi.needsNusukCases > 0}
                       active={kpiFilter?.id === 'kpi_nusuk'}
                       onClick={() => pickKpi('kpi_nusuk', 'Nusuk Intervention')} />
            )}
            {on('kpi_departedRecent') && (
              <KpiCard label="DEPARTED · LAST 12H"
                       value={kpi.departedRecentCases}
                       cases={kpi.departedRecentCases}
                       pax={kpi.departedRecentPax}
                       status="Process completed"
                       color="#4ade80" accent="#86efac"
                       active={kpiFilter?.id === 'kpi_departedRecent'}
                       onClick={() => pickKpi('kpi_departedRecent', 'Departed (last 12h)')} />
            )}
            {on('kpi_atAirportSoon') && (
              <KpiCard label="NEW FLIGHT < 12H"
                       value={kpi.atAirportSoonCases}
                       cases={kpi.atAirportSoonCases}
                       pax={kpi.atAirportSoonPax}
                       status="At airport · departing soon"
                       color="#fb923c" accent="#fdba74"
                       active={kpiFilter?.id === 'kpi_atAirportSoon'}
                       onClick={() => pickKpi('kpi_atAirportSoon', 'New flight < 12h')} />
            )}
            {on('kpi_atAirportLater') && (
              <KpiCard label="NEW FLIGHT ≥ 12H"
                       value={kpi.atAirportLaterCases}
                       cases={kpi.atAirportLaterCases}
                       pax={kpi.atAirportLaterPax}
                       status="At airport · 12h+ wait"
                       color="#60a5fa" accent="#93c5fd"
                       active={kpiFilter?.id === 'kpi_atAirportLater'}
                       onClick={() => pickKpi('kpi_atAirportLater', 'New flight ≥ 12h')} />
            )}
            {on('kpi_stuck24') && (
              <KpiCard label="AT AIRPORT > 24H"
                       value={kpi.stuck24Cases}
                       cases={kpi.stuck24Cases}
                       pax={kpi.stuck24Pax}
                       status={kpi.stuck24Cases > 0 ? '⚠ Extended stay' : '✓ None'}
                       color="#ef476f" accent="#ff7a9e"
                       flash={kpi.stuck24Cases > 0}
                       active={kpiFilter?.id === 'kpi_stuck24'}
                       onClick={() => pickKpi('kpi_stuck24', 'At airport > 24h')} />
            )}
            {on('kpi_confirmed') && (
              <KpiCard label="FLIGHT CONFIRMED"
                       value={kpi.confirmedCases}
                       cases={kpi.confirmedCases}
                       pax={kpi.confirmedPax}
                       status="Awaiting departure"
                       color="#22c55e"
                       active={kpiFilter?.id === 'kpi_confirmed'}
                       onClick={() => pickKpi('kpi_confirmed', 'Flight Confirmed')} />
            )}
            {on('kpi_closed') && (
              <KpiCard label="CLOSED"
                       value={kpi.closedCases}
                       cases={kpi.closedCases}
                       pax={kpi.closedPax}
                       status="Departed" color="#64748b"
                       active={kpiFilter?.id === 'kpi_closed'}
                       onClick={() => pickKpi('kpi_closed', 'Closed')} />
            )}
            {on('kpi_total') && (
              <KpiCard label="TOTAL CASES"
                       value={kpi.totalCases}
                       cases={kpi.totalCases}
                       pax={kpi.totalPax}
                       status={RANGE_LABELS[range] || 'Range'}
                       spark={kpi.sparkCases}
                       color="#39d0d8"
                       active={kpiFilter?.id === 'kpi_total'}
                       onClick={() => pickKpi('kpi_total', 'All Cases')} />
            )}
            {on('kpi_rebook') && (
              <KpiCard label="AVG REBOOK TIME"
                       value={fmtHrs(kpi.avgRebookHrs)}
                       sub="created → confirmed"
                       status={kpi.avgRebookHrs == null ? '—' :
                              (kpi.avgRebookHrs < 12 ? '▼ Within SLA' : '▲ Above SLA')}
                       color="#f5c842" />
            )}
            {on('kpi_close') && (
              <KpiCard label="AVG CLOSE TIME"
                       value={fmtHrs(kpi.avgCloseHrs)}
                       sub="created → closed"
                       status="— Stable"
                       color="#38bdf8" />
            )}
            {on('kpi_days') && (
              <KpiCard label="AVG DAYS AT AIRPORT"
                       value={kpi.avgDaysAtAirport != null ? kpi.avgDaysAtAirport.toFixed(1) : '—'}
                       sub="days per case"
                       status={kpi.avgDaysAtAirport != null && kpi.avgDaysAtAirport > 3
                                 ? '▲ Review extended stays' : '— Normal'}
                       spark={kpi.sparkDays}
                       color="#b794f4" />
            )}
          </section>

          {/* ── Nusuk intervention list (only when there are cases needing it) ── */}
          {on('kpi_nusuk') && kpi.needsNusukCases > 0 && (
            <section className="xpanel xpanel-alert">
              <div className="xpanel-head">
                <img src="/nusuk-logo.svg" alt="Nusuk" className="xnusuk-icon"/>
                <h3>Ministry of Hajj & Umrah — Pax Awaiting Nusuk Confirmation</h3>
                <span className="xpanel-count">{kpi.needsNusukCases} cases · {kpi.needsNusukPax} pax</span>
              </div>
              <div className="xnusuk-grid">
                {kpi.needsNusukList.map(r => (
                  <div key={r.id} className="xnusuk-card" onClick={() => navigate(`/edit-report/${r.id}`)}>
                    <div className="xnusuk-id">#{r.id}</div>
                    <div className="xnusuk-main">
                      <div className="xnusuk-line"><b>{r.pax_count} pax</b> · {r.nationality}</div>
                      <div className="xnusuk-line small">{r.new_flight} → {r.new_destination}</div>
                      <div className="xnusuk-line small">Departs: {(r.new_datetime || '').replace('T',' ').slice(0,16)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Charts Grid ── */}
          <section className="xgrid">
            {on('chart_nationality') && (
              <div className="xpanel xspan-6">
                <div className="xpanel-head">
                  <h3>BY NATIONALITY</h3>
                  {data.byNationality.most &&
                    <span className="xtag xtag-hot">🔥 {data.byNationality.most.name} ({data.byNationality.most.value})</span>}
                </div>
                <BrandedBarList data={data.byNationality.data} mode="nationality"
                                onClick={name => onDrill('nationality', name)} />
              </div>
            )}

            {on('chart_airline') && (
              <div className="xpanel xspan-6">
                <div className="xpanel-head">
                  <h3>BY AIRLINE</h3>
                  {data.byAirline.most &&
                    <span className="xtag xtag-hot">🔥 {data.byAirline.most.name} ({data.byAirline.most.value})</span>}
                </div>
                <BrandedBarList data={data.byAirline.data} mode="airline"
                                onClick={name => onDrill('airline', name)} />
              </div>
            )}

            {on('chart_trend') && (
              <div className="xpanel xspan-8">
                <div className="xpanel-head"><h3>VOLUME TREND</h3></div>
                {data.trend.length === 0 ? <div className="xchart-empty">No data for selected period</div> : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={data.trend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2b45"/>
                      <XAxis dataKey="date" tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                      <YAxis allowDecimals={false} tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                      <Tooltip contentStyle={{ background:'#0f1a2e', border:'1px solid #2b3a5a', color:'#e6eefb' }}/>
                      <Legend wrapperStyle={{ color:'#a9bfd1' }}/>
                      <Line type="monotone" dataKey="value" stroke="#39d0d8" strokeWidth={2} name="Cases" dot={false}/>
                      <Line type="monotone" dataKey="pax" stroke="#f5c842" strokeWidth={2} strokeDasharray="4 3" name="Pax" dot={false}/>
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}

            {on('chart_destination') && (
              <div className="xpanel xspan-4">
                <div className="xpanel-head">
                  <h3>BY DESTINATION</h3>
                  {data.byDestination.most &&
                    <span className="xtag">{data.byDestination.data.slice(0,3).map(d => d.name).join(' · ')}</span>}
                </div>
                {data.byDestination.data.length === 0 ? <div className="xchart-empty">No data</div> : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={data.byDestination.data}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2b45"/>
                      <XAxis dataKey="name" tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                      <YAxis allowDecimals={false} tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                      <Tooltip contentStyle={{ background:'#0f1a2e', border:'1px solid #2b3a5a', color:'#e6eefb' }}/>
                      <Bar dataKey="value" fill="#38bdf8" radius={[4,4,0,0]}
                           onClick={d => onDrill('destination', d.name)}
                           style={{ cursor:'pointer' }}/>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}

            {on('chart_days') && (
              <div className="xpanel xspan-4">
                <div className="xpanel-head"><h3>DAYS AT AIRPORT</h3></div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.daysHistogram}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2b45"/>
                    <XAxis dataKey="name" tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                    <YAxis allowDecimals={false} tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                    <Tooltip contentStyle={{ background:'#0f1a2e', border:'1px solid #2b3a5a', color:'#e6eefb' }}/>
                    <Bar dataKey="value" fill="#b794f4" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {on('chart_resolution') && (
              <div className="xpanel xspan-4">
                <div className="xpanel-head"><h3>RESOLUTION TIME</h3><span className="xtag">created → confirmed</span></div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.resolutionHistogram}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2b45"/>
                    <XAxis dataKey="name" tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                    <YAxis allowDecimals={false} tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                    <Tooltip contentStyle={{ background:'#0f1a2e', border:'1px solid #2b3a5a', color:'#e6eefb' }}/>
                    <Bar dataKey="value" fill="#22c55e" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {on('chart_shift') && (
              <div className="xpanel xspan-4">
                <div className="xpanel-head">
                  <h3>BY SHIFT</h3>
                  {data.byShift.most && <span className="xtag xtag-hot">🔥 {data.byShift.most.name}</span>}
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.byShift.data}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2b45"/>
                    <XAxis dataKey="name" tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                    <YAxis allowDecimals={false} tick={{ fill:'#8ba3b8', fontSize:11 }} stroke="#2b3a5a"/>
                    <Tooltip contentStyle={{ background:'#0f1a2e', border:'1px solid #2b3a5a', color:'#e6eefb' }}/>
                    <Bar dataKey="value" radius={[4,4,0,0]}
                         onClick={d => onDrill('shift', d.name)} style={{ cursor:'pointer' }}>
                      {data.byShift.data.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {on('chart_paxtype') && (
              <div className="xpanel xspan-4">
                <div className="xpanel-head"><h3>PASSENGER TYPE</h3></div>
                {data.byPaxType.data.length === 0 ? <div className="xchart-empty">No data</div> : (
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={data.byPaxType.data} dataKey="value" nameKey="name"
                           cx="50%" cy="50%" innerRadius={40} outerRadius={78} paddingAngle={3}
                           onClick={d => onDrill('pax_type', d.name)} style={{ cursor:'pointer' }}>
                        {data.byPaxType.data.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="#0b1220" />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background:'#0f1a2e', border:'1px solid #2b3a5a', color:'#e6eefb' }}/>
                      <Legend wrapperStyle={{ color:'#a9bfd1', fontSize:11 }}/>
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}

            {on('chart_heatmap') && (
              <div className="xpanel xspan-8">
                <div className="xpanel-head">
                  <h3>PEAK HOURS HEATMAP</h3>
                  <span className="xtag">Day of week × Hour · darker = more cases</span>
                </div>
                <Heatmap data={data.heatmapData}/>
              </div>
            )}

            {on('table_drill') && (() => {
              const filteredReports = kpiFilter
                ? data.reports.filter(kpiFilter.predicate)
                : data.reports;
              return (
              <div className="xpanel xspan-12">
                <div className="xpanel-head">
                  <h3>RECENT CASES</h3>
                  {kpiFilter ? (
                    <span className="xtag xtag-hot" style={{cursor:'pointer'}} onClick={clearKpiFilter}>
                      Filtered: {kpiFilter.label} ({filteredReports.length}) ✕
                    </span>
                  ) : (
                    <span className="xtag">{filteredReports.length} reports · click a card or row</span>
                  )}
                </div>
                {filteredReports.length === 0 ? <div className="xchart-empty">No reports match current filters</div> : (
                  <div className="xtable-wrap">
                    <table className="xtable">
                      <thead>
                        <tr>
                          <th>#</th><th>Created</th><th>Shift</th><th>Status</th>
                          <th>Prev Flight</th><th>Dest</th><th>Nationality</th>
                          <th>Pax Type</th><th>Pax</th><th>New Flight</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredReports.slice(0, 30).map(r => {
                          const hr = parseInt((r.created_at || '').slice(11, 13));
                          const sh = isNaN(hr) ? '?' :
                                    hr >= 6 && hr < 14 ? 'A' : hr >= 14 && hr < 22 ? 'B' : 'C';
                          return (
                            <tr key={r.id} onClick={() => navigate(`/edit-report/${r.id}`)}>
                              <td><b>#{r.id}</b></td>
                              <td>{(r.created_at || '').slice(0, 16)}</td>
                              <td>{sh}</td>
                              <td><span className={`xstatus xstatus-${r.status}`}>{r.status.replace('_',' ')}</span></td>
                              <td><span className="xflight">{r.prev_flight || '—'}</span></td>
                              <td>{r.prev_destination || '—'}</td>
                              <td>{r.nationality || '—'}</td>
                              <td>{r.pax_type || '—'}</td>
                              <td>{r.pax_count ?? '—'}</td>
                              <td>{r.new_flight ? <span className="xflight">{r.new_flight}</span> : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              );
            })()}
          </section>
        </>
      )}
    </div>
  );
}
