import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { getAnalytics } from '../utils/api';

const COLORS = [
  '#1a3a5c', '#2a5298', '#3a7bd5', '#5a9fd4', '#7ab8e0',
  '#9ad0ec', '#b4ddf5', '#ce8a35', '#e6a93a', '#f5c842',
];

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function Analytics() {
  const navigate = useNavigate();
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  useEffect(() => {
    getAnalytics()
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Dashboard</button>
        <h1 className="page-title">Analytics</h1>
        <span className="supervisor-badge">Supervisor</span>
      </div>

      {loading && <div className="state-msg">Loading analytics…</div>}
      {error   && <div className="state-msg error">{error}</div>}

      {data && (
        <>
          {/* ── Summary stats */}
          <div className="stats-row">
            <StatCard label="Reports this week"  value={data.thisWeek} />
            <StatCard label="Reports this month" value={data.thisMonth} />
            <StatCard label="Total destinations" value={data.topDestinations.length} />
            <StatCard label="Nationalities"      value={data.byNationality.length} />
          </div>

          {/* ── Top Destinations Bar Chart */}
          <div className="chart-card">
            <h2 className="chart-title">Top 10 Destinations by No-Show Count</h2>
            {data.topDestinations.length === 0
              ? <p className="no-data">No data yet.</p>
              : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={data.topDestinations} margin={{ top: 10, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="destination" angle={-40} textAnchor="end" interval={0} tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip formatter={(v) => [v, 'Passengers']} />
                    <Bar dataKey="total" fill="#1a3a5c" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )
            }
          </div>

          <div className="charts-row">
            {/* ── Nationality Donut */}
            <div className="chart-card chart-half">
              <h2 className="chart-title">Nationality Breakdown</h2>
              {data.byNationality.length === 0
                ? <p className="no-data">No data yet.</p>
                : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={data.byNationality}
                        dataKey="total"
                        nameKey="nationality"
                        cx="50%"
                        cy="50%"
                        innerRadius={70}
                        outerRadius={110}
                        paddingAngle={2}
                      >
                        {data.byNationality.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [v, n]} />
                      <Legend
                        formatter={(value, entry) => `${entry.payload.nationality} (${entry.payload.total})`}
                        wrapperStyle={{ fontSize: 12 }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )
              }
            </div>

            {/* ── Pax Type Table */}
            <div className="chart-card chart-half">
              <h2 className="chart-title">Breakdown by Passenger Type</h2>
              {data.byPaxType.length === 0
                ? <p className="no-data">No data yet.</p>
                : (
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th>Passenger Type</th>
                        <th>Reports</th>
                        <th>Total Pax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byPaxType.map(row => (
                        <tr key={row.pax_type}>
                          <td>{row.pax_type || '—'}</td>
                          <td className="col-center">{row.report_count}</td>
                          <td className="col-center">{row.total_pax}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>Total</strong></td>
                        <td className="col-center">
                          <strong>{data.byPaxType.reduce((s, r) => s + r.report_count, 0)}</strong>
                        </td>
                        <td className="col-center">
                          <strong>{data.byPaxType.reduce((s, r) => s + r.total_pax, 0)}</strong>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )
              }
            </div>
          </div>
        </>
      )}
    </div>
  );
}
