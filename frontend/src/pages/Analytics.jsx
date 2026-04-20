import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, AreaChart, Area,
} from 'recharts';
import { getDashboardData, getFilterOptions } from '../utils/api';

const COLORS = [
  '#1a3a5c', '#2a5298', '#3a7bd5', '#5a9fd4', '#7ab8e0',
  '#9ad0ec', '#b4ddf5', '#ce8a35', '#e6a93a', '#f5c842',
];

const RANGE_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This Week',
  month: 'This Month',
  year: 'This Year',
  all: 'All Time',
  custom: 'Custom',
};

function fmtHrs(hrs) {
  if (hrs == null || isNaN(hrs)) return '—';
  if (hrs < 1) return `${Math.round(hrs * 60)}m`;
  if (hrs < 24) return `${hrs.toFixed(1)}h`;
  return `${(hrs / 24).toFixed(1)}d`;
}

// Sparkline: mini line chart for a KPI card
function Sparkline({ data, color = '#1a3a5c' }) {
  if (!data || data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={40}>
      <AreaChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <defs>
          <linearGradient id={`g-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4}/>
            <stop offset="100%" stopColor={color} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5}
          fill={`url(#g-${color})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// KPI Card with sparkline + trend vs previous value
function KpiCard({ label, value, spark, color, subtitle }) {
  return (
    <div className="kpi-card" style={{ borderTopColor: color || '#1a3a5c' }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {subtitle && <div className="kpi-sub">{subtitle}</div>}
      {spark && <Sparkline data={spark} color={color || '#1a3a5c'} />}
    </div>
  );
}

// Highlight badge (🔥 most / ❄ least)
function Highlight({ type, item }) {
  if (!item) return null;
  const emoji = type === 'most' ? '🔥' : '❄';
  const label = type === 'most' ? 'Most' : 'Least';
  return (
    <div className={`highlight highlight-${type}`}>
      {emoji} {label}: <strong>{item.name}</strong> ({item.value})
    </div>
  );
}

// Heatmap — 7 days × 24 hours
function Heatmap({ data }) {
  const max = Math.max(1, ...data.map(d => d.value));
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return (
    <div className="heatmap-wrap">
      <div className="heatmap-hours">
        <div className="heatmap-day-label"></div>
        {Array.from({length:24}).map((_, h) => (
          <div key={h} className="heatmap-hour-label">{h}</div>
        ))}
      </div>
      {dayNames.map((d, di) => (
        <div key={d} className="heatmap-row">
          <div className="heatmap-day-label">{d}</div>
          {Array.from({length:24}).map((_, h) => {
            const cell = data.find(x => x.dayIdx === di && x.hour === h);
            const v = cell ? cell.value : 0;
            const intensity = v / max;
            const bg = intensity === 0
              ? '#f0f4f8'
              : `rgba(26, 58, 92, ${0.15 + intensity * 0.85})`;
            return (
              <div key={h} className="heatmap-cell"
                style={{ background: bg, color: intensity > 0.55 ? '#fff' : '#333' }}
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

export default function Analytics() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [data, setData]       = useState(null);
  const [error, setError]     = useState('');

  // Filters
  const [range, setRange]       = useState('today');
  const [from, setFrom]         = useState('');
  const [to, setTo]             = useState('');
  const [shift, setShift]       = useState('');
  const [status, setStatus]     = useState('');
  const [airline, setAirline]   = useState('');
  const [nationality, setNat]   = useState('');
  const [destination, setDest] = useState('');
  const [terminal, setTerminal] = useState('');
  const [paxType, setPaxType]   = useState('');

  // Drill-through chip (from clicking a chart)
  const [drill, setDrill] = useState(null); // { field, value, label }

  const [filterOpts, setFilterOpts] = useState({ airlines: [], nationalities: [], destinations: [], paxTypes: [] });

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
        to: range === 'custom' ? to : '',
        shift, status, airline, nationality, destination, terminal, pax_type: paxType,
      };
      // Apply drill-through
      if (drill) {
        payload[drill.field] = drill.value;
      }
      const d = await getDashboardData(payload);
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();

  }, [range, from, to, shift, status, airline, nationality, destination, terminal, paxType, drill]);

  const kpi = data?.kpi;

  // Drill-through handlers
  function onDrill(field, name) {
    setDrill({ field, value: name, label: name });
  }
  function clearDrill() { setDrill(null); }

  function clearAllFilters() {
    setShift(''); setStatus(''); setAirline(''); setNat('');
    setDest(''); setTerminal(''); setPaxType(''); setDrill(null);
  }

  const activeFilterCount = [shift, status, airline, nationality, destination, terminal, paxType].filter(Boolean).length + (drill ? 1 : 0);

  return (
    <div className="page analytics-page">
      {/* ── Header */}
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Dashboard</button>
        <h1 className="page-title">Executive Analytics</h1>
        <span className="supervisor-badge">Supervisor</span>
      </div>

      {/* ── Filter Bar */}
      <div className="filter-bar">
        <div className="filter-group">
          <label className="filter-label">Period</label>
          <div className="range-chips">
            {['today','yesterday','week','month','year','all','custom'].map(r => (
              <button key={r}
                className={`range-chip ${range === r ? 'active' : ''}`}
                onClick={() => setRange(r)}>
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>
        </div>

        {range === 'custom' && (
          <div className="filter-group">
            <label className="filter-label">Range</label>
            <div className="custom-range">
              <input type="date" className="filter-input" value={from} onChange={e => setFrom(e.target.value)} />
              <span>→</span>
              <input type="date" className="filter-input" value={to} onChange={e => setTo(e.target.value)} />
            </div>
          </div>
        )}

        <div className="filter-group">
          <label className="filter-label">Filters</label>
          <div className="filter-row">
            <select className="filter-input" value={shift} onChange={e => setShift(e.target.value)}>
              <option value="">All Shifts</option>
              <option value="A">Shift A (06–14)</option>
              <option value="B">Shift B (14–22)</option>
              <option value="C">Shift C (22–06)</option>
            </select>

            <select className="filter-input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All Status</option>
              <option value="under_process">Under Process</option>
              <option value="flight_confirmed">Flight Confirmed</option>
              <option value="closed">Closed</option>
            </select>

            <select className="filter-input" value={terminal} onChange={e => setTerminal(e.target.value)}>
              <option value="">All Terminals</option>
              <option value="T1">Terminal 1</option>
              <option value="North">North Terminal</option>
              <option value="Hajj">Hajj Terminal</option>
            </select>

            <select className="filter-input" value={paxType} onChange={e => setPaxType(e.target.value)}>
              <option value="">All Pax Types</option>
              {filterOpts.paxTypes.map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            <select className="filter-input" value={airline} onChange={e => setAirline(e.target.value)}>
              <option value="">All Airlines</option>
              {filterOpts.airlines.map(a => <option key={a} value={a}>{a}</option>)}
            </select>

            <select className="filter-input" value={nationality} onChange={e => setNat(e.target.value)}>
              <option value="">All Nationalities</option>
              {filterOpts.nationalities.map(n => <option key={n} value={n}>{n}</option>)}
            </select>

            <select className="filter-input" value={destination} onChange={e => setDest(e.target.value)}>
              <option value="">All Destinations</option>
              {filterOpts.destinations.map(d => <option key={d} value={d}>{d}</option>)}
            </select>

            {activeFilterCount > 0 && (
              <button className="btn btn-xs btn-secondary" onClick={clearAllFilters}>
                Clear ({activeFilterCount})
              </button>
            )}
          </div>
        </div>

        {drill && (
          <div className="drill-chip">
            <span>Filtered by <strong>{drill.label}</strong></span>
            <button onClick={clearDrill}>×</button>
          </div>
        )}
      </div>

      {loading && <div className="state-msg">Loading dashboard…</div>}
      {error   && <div className="state-msg error">{error}</div>}

      {data && kpi && (
        <>
          {/* ── KPI Cards Row */}
          <div className="kpi-grid">
            <KpiCard
              label="Total Cases"
              value={kpi.totalCases}
              subtitle={`${kpi.totalPax} pax`}
              color="#1a3a5c"
              spark={kpi.sparkCases}
            />
            <KpiCard
              label="Avg Time to Rebook"
              value={fmtHrs(kpi.avgRebookHrs)}
              subtitle="created → flight confirmed"
              color="#27ae60"
            />
            <KpiCard
              label="Avg Time to Close"
              value={fmtHrs(kpi.avgCloseHrs)}
              subtitle="created → closed"
              color="#2a5298"
            />
            <KpiCard
              label="Active Cases"
              value={kpi.active}
              subtitle="not yet closed"
              color="#e67e22"
            />
            <KpiCard
              label="Avg Days at Airport"
              value={kpi.avgDaysAtAirport != null ? kpi.avgDaysAtAirport.toFixed(1) : '—'}
              subtitle="days per case"
              color="#8e44ad"
              spark={kpi.sparkDays}
            />
            <KpiCard
              label="Bus Transfers"
              value={kpi.busPct.toFixed(1) + '%'}
              subtitle="new flight at N/H terminal"
              color="#f39c12"
            />
          </div>

          {/* ── Row 1: Nationality + Airline */}
          <div className="charts-row">
            <div className="chart-card chart-half">
              <h2 className="chart-title">By Nationality</h2>
              <Highlight type="most" item={data.byNationality.most} />
              <Highlight type="least" item={data.byNationality.least} />
              {data.byNationality.data.length === 0
                ? <p className="no-data">No data for current filters.</p>
                : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart layout="vertical" data={data.byNationality.data} margin={{ left: 20, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" allowDecimals={false} />
                      <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#1a3a5c" radius={[0, 4, 4, 0]}
                        onClick={(d) => onDrill('nationality', d.name)}
                        style={{ cursor: 'pointer' }} />
                    </BarChart>
                  </ResponsiveContainer>
                )
              }
            </div>

            <div className="chart-card chart-half">
              <h2 className="chart-title">By Airline</h2>
              <Highlight type="most" item={data.byAirline.most} />
              <Highlight type="least" item={data.byAirline.least} />
              {data.byAirline.data.length === 0
                ? <p className="no-data">No data for current filters.</p>
                : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart layout="vertical" data={data.byAirline.data} margin={{ left: 20, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" allowDecimals={false} />
                      <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#ce8a35" radius={[0, 4, 4, 0]}
                        onClick={(d) => onDrill('airline', d.name)}
                        style={{ cursor: 'pointer' }} />
                    </BarChart>
                  </ResponsiveContainer>
                )
              }
            </div>
          </div>

          {/* ── Row 2: Destination + Shift */}
          <div className="charts-row">
            <div className="chart-card chart-half">
              <h2 className="chart-title">By Destination</h2>
              <Highlight type="most" item={data.byDestination.most} />
              <Highlight type="least" item={data.byDestination.least} />
              {data.byDestination.data.length === 0
                ? <p className="no-data">No data for current filters.</p>
                : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.byDestination.data} margin={{ top: 10, bottom: 30 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#2a5298" radius={[4, 4, 0, 0]}
                        onClick={(d) => onDrill('destination', d.name)}
                        style={{ cursor: 'pointer' }} />
                    </BarChart>
                  </ResponsiveContainer>
                )
              }
            </div>

            <div className="chart-card chart-half">
              <h2 className="chart-title">By Shift</h2>
              <Highlight type="most" item={data.byShift.most} />
              {data.byShift.data.every(d => d.value === 0)
                ? <p className="no-data">No data for current filters.</p>
                : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.byShift.data}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#1a3a5c" radius={[4, 4, 0, 0]}
                        onClick={(d) => onDrill('shift', d.name)}
                        style={{ cursor: 'pointer' }}>
                        {data.byShift.data.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )
              }
            </div>
          </div>

          {/* ── Row 3: Pax Type pie + Terminal pie */}
          <div className="charts-row">
            <div className="chart-card chart-half">
              <h2 className="chart-title">By Passenger Type</h2>
              {data.byPaxType.data.length === 0
                ? <p className="no-data">No data.</p>
                : (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie data={data.byPaxType.data} dataKey="value" nameKey="name"
                        cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2}
                        onClick={(d) => onDrill('pax_type', d.name)}
                        style={{ cursor: 'pointer' }}>
                        {data.byPaxType.data.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )
              }
            </div>

            <div className="chart-card chart-half">
              <h2 className="chart-title">By Terminal</h2>
              {data.byTerminal.data.length === 0
                ? <p className="no-data">No data.</p>
                : (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie data={data.byTerminal.data} dataKey="value" nameKey="name"
                        cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2}
                        onClick={(d) => onDrill('terminal', d.name)}
                        style={{ cursor: 'pointer' }}>
                        {data.byTerminal.data.map((_, i) => (
                          <Cell key={i} fill={['#1a3a5c','#ce8a35','#2a5298'][i % 3]} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )
              }
            </div>
          </div>

          {/* ── Row 4: Days-at-airport + Resolution-time histograms */}
          <div className="charts-row">
            <div className="chart-card chart-half">
              <h2 className="chart-title">Days at Airport Distribution</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.daysHistogram}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#8e44ad" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-card chart-half">
              <h2 className="chart-title">Resolution Time Distribution</h2>
              <p className="chart-sub">created → flight confirmed</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.resolutionHistogram}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#27ae60" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Peak Hours Heatmap */}
          <div className="chart-card">
            <h2 className="chart-title">🕐 Peak Hours Heatmap</h2>
            <p className="chart-sub">Day of week × hour of day · darker = more cases</p>
            <Heatmap data={data.heatmapData} />
          </div>

          {/* ── Volume Trend */}
          <div className="chart-card">
            <h2 className="chart-title">Volume Trend</h2>
            {data.trend.length === 0
              ? <p className="no-data">No data for selected period.</p>
              : (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="value" stroke="#1a3a5c" strokeWidth={2} name="Cases" />
                    <Line type="monotone" dataKey="pax" stroke="#ce8a35" strokeWidth={2} name="Pax" />
                  </LineChart>
                </ResponsiveContainer>
              )
            }
          </div>

          {/* ── Drill-through table */}
          <div className="chart-card">
            <h2 className="chart-title">Reports ({data.reports.length})</h2>
            <p className="chart-sub">Matching current filters · click a chart to drill down</p>
            {data.reports.length === 0
              ? <p className="no-data">No reports match.</p>
              : (
                <div className="drill-table-wrap">
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Created</th>
                        <th>Shift</th>
                        <th>Status</th>
                        <th>Prev Flight</th>
                        <th>Dest</th>
                        <th>Nationality</th>
                        <th>Pax Type</th>
                        <th>Pax</th>
                        <th>New Flight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.reports.slice(0, 100).map(r => {
                        const hr = parseInt((r.created_at || '').slice(11, 13));
                        const sh = isNaN(hr) ? '?' : (hr >= 6 && hr < 14 ? 'A' : hr >= 14 && hr < 22 ? 'B' : 'C');
                        return (
                          <tr key={r.id} className="clickable-row" onClick={() => navigate(`/edit-report/${r.id}`)}>
                            <td><strong>#{r.id}</strong></td>
                            <td>{(r.created_at || '').slice(0, 16)}</td>
                            <td className="col-center">{sh}</td>
                            <td>{r.status}</td>
                            <td>{r.prev_flight || '—'}</td>
                            <td>{r.prev_destination || '—'}</td>
                            <td>{r.nationality || '—'}</td>
                            <td>{r.pax_type || '—'}</td>
                            <td className="col-center">{r.pax_count ?? '—'}</td>
                            <td>{r.new_flight || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {data.reports.length > 100 && (
                    <p className="no-data" style={{ padding: 10 }}>Showing first 100 of {data.reports.length}.</p>
                  )}
                </div>
              )
            }
          </div>
        </>
      )}
    </div>
  );
}
