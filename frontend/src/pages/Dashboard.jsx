import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReports, deleteReport } from '../utils/api';
import { getRole, isSupervisor, clearRole } from '../utils/auth';

function fmt(dt) {
  if (!dt) return '—';
  try { return new Date(dt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return dt; }
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [reports, setReports]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [copied, setCopied]       = useState(null);
  const [deleting, setDeleting]   = useState(null);
  const [search, setSearch]       = useState('');

  const role = getRole();

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await getReports();
      setReports(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function copyWhatsApp(report) {
    const text = report.whatsapp_text || buildWhatsApp(report);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(report.id);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  function buildWhatsApp(r) {
    return (
      `No-Show Report #${r.id}\n` +
      `Flight: ${r.prev_flight || '—'} → ${r.prev_destination || '—'}\n` +
      `Pax: ${r.pax_count} × ${r.pax_type || '—'}\n` +
      `Nationality: ${r.nationality || '—'}\n` +
      `New Flight: ${r.new_flight || '—'} on ${fmt(r.new_datetime)}`
    );
  }

  function duplicate(report) {
    navigate('/new-report', {
      state: {
        prefill: {
          prev_flight:      report.prev_flight,
          prev_datetime:    report.prev_datetime,
          prev_destination: report.prev_destination,
          prev_airline:     report.prev_airline,
          nationality:      report.nationality,
          pax_type:         report.pax_type,
          new_flight:       report.new_flight,
          new_datetime:     report.new_datetime,
          new_destination:  report.new_destination,
          new_airline:      report.new_airline,
        },
      },
    });
  }

  async function handleDelete(id) {
    if (!confirm(`Delete report #${id}? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      await deleteReport(id);
      setReports(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      alert('Delete failed: ' + err.message);
    } finally {
      setDeleting(null);
    }
  }

  function logout() {
    clearRole();
    navigate('/login');
  }

  const filtered = reports.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      String(r.id).includes(q) ||
      (r.prev_flight || '').toLowerCase().includes(q) ||
      (r.new_flight  || '').toLowerCase().includes(q) ||
      (r.nationality || '').toLowerCase().includes(q) ||
      (r.pax_type    || '').toLowerCase().includes(q) ||
      (r.prev_destination || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="page">
      {/* ── Header */}
      <div className="dashboard-header">
        <div className="header-brand">
          <svg viewBox="0 0 64 64" width="32" height="32">
            <rect width="64" height="64" rx="8" fill="#1a3a5c"/>
            <text x="32" y="44" fontSize="32" textAnchor="middle" fill="white" fontFamily="Arial" fontWeight="bold">✈</text>
          </svg>
          <span className="header-title">No-Show App</span>
          <span className="header-role">{role}</span>
        </div>
        <div className="header-actions">
          {isSupervisor() && (
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/analytics')}>
              Analytics
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/new-report')}>
            + New Report
          </button>
          <button className="btn btn-ghost btn-sm" onClick={logout} title="Sign out">
            Sign out
          </button>
        </div>
      </div>

      {/* ── Search + count */}
      <div className="dashboard-toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Search reports…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="report-count">{filtered.length} report{filtered.length !== 1 ? 's' : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={load} title="Refresh">↻ Refresh</button>
      </div>

      {/* ── States */}
      {loading && <div className="state-msg">Loading reports…</div>}
      {error   && <div className="state-msg error">{error}</div>}

      {/* ── Table */}
      {!loading && !error && (
        filtered.length === 0
          ? <div className="state-msg">No reports found{search ? ' for "' + search + '"' : ''}.</div>
          : (
            <div className="table-wrapper">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Pax ID Date</th>
                    <th>Prev Flight</th>
                    <th>Destination</th>
                    <th>Nationality</th>
                    <th>Pax Type</th>
                    <th>Pax Count</th>
                    <th>New Flight</th>
                    <th>New Flight Date</th>
                    <th>Days</th>
                    <th>By</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id}>
                      <td className="col-id">#{r.id}</td>
                      <td>{fmt(r.pax_id_datetime)}</td>
                      <td className="col-flight">
                        <span className="flight-badge">{r.prev_flight || '—'}</span>
                      </td>
                      <td>{r.prev_destination || '—'}</td>
                      <td>{r.nationality || '—'}</td>
                      <td>
                        <span className="pax-type-badge">{r.pax_type || '—'}</span>
                      </td>
                      <td className="col-center">{r.pax_count ?? '—'}</td>
                      <td className="col-flight">
                        <span className="flight-badge">{r.new_flight || '—'}</span>
                      </td>
                      <td>{fmt(r.new_datetime)}</td>
                      <td className="col-center">{r.days_at_airport != null ? r.days_at_airport : '—'}</td>
                      <td className="col-role">{r.submitted_by || '—'}</td>
                      <td className="col-actions">
                        <button
                          className="btn btn-xs btn-secondary"
                          onClick={() => duplicate(r)}
                          title="Duplicate this report"
                        >
                          Duplicate
                        </button>
                        <button
                          className={`btn btn-xs ${copied === r.id ? 'btn-success' : 'btn-whatsapp'}`}
                          onClick={() => copyWhatsApp(r)}
                          title="Copy WhatsApp message"
                        >
                          {copied === r.id ? '✓ Copied' : '📋 WA'}
                        </button>
                        {isSupervisor() && (
                          <button
                            className="btn btn-xs btn-danger"
                            onClick={() => handleDelete(r.id)}
                            disabled={deleting === r.id}
                            title="Delete report"
                          >
                            {deleting === r.id ? '…' : 'Delete'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}
    </div>
  );
}
