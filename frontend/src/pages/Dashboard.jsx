import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReports, deleteReport, updateReport, lookupFlight, airlineFromFlightNumber } from '../utils/api';
import { getRole, isSupervisor, clearRole } from '../utils/auth';

function fmt(dt) {
  if (!dt) return '—';
  try { return new Date(dt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return dt; }
}

function stdToDatetime(std) {
  if (!std) return '';
  const today = new Date().toISOString().slice(0, 10);
  return `${today}T${std}`;
}

const STATUS_LABELS = {
  under_process: 'Under Process',
  flight_confirmed: 'Flight Confirmed',
  closed: 'Closed',
};

const STATUS_COLORS = {
  under_process: '#e67e22',
  flight_confirmed: '#27ae60',
  closed: '#95a5a6',
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [reports, setReports]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [copied, setCopied]       = useState(null);
  const [deleting, setDeleting]   = useState(null);
  const [search, setSearch]       = useState('');
  const [activeTab, setActiveTab] = useState('under_process');

  // Flight confirmed modal state
  const [confirmModal, setConfirmModal] = useState(null); // report being confirmed
  const [newFlightForm, setNewFlightForm] = useState({ new_flight: '', new_datetime: '', new_destination: '', new_airline: '' });
  const [lookupStatus, setLookupStatus] = useState('idle');
  const [saving, setSaving] = useState(false);

  const role = getRole();

  useEffect(() => { load(); }, []);

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

  // ── Status change handlers
  function openConfirmModal(report) {
    setConfirmModal(report);
    setNewFlightForm({
      new_flight: report.new_flight || '',
      new_datetime: report.new_datetime || '',
      new_destination: report.new_destination || '',
      new_airline: report.new_airline || '',
    });
    setLookupStatus('idle');
  }

  async function lookupNewFlight() {
    const fn = newFlightForm.new_flight.trim();
    if (!fn) return;
    setLookupStatus('loading');
    try {
      const data = await lookupFlight(fn);
      setNewFlightForm(prev => ({
        ...prev,
        new_datetime: stdToDatetime(data.std),
        new_destination: `${data.city} (${data.destination})`,
        new_airline: airlineFromFlightNumber(fn),
      }));
      setLookupStatus('found');
    } catch {
      setLookupStatus('notfound');
    }
  }

  async function saveFlightConfirmed() {
    if (!confirmModal) return;
    if (!newFlightForm.new_flight.trim()) {
      alert('Please enter the new flight number');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateReport(confirmModal.id, {
        status: 'flight_confirmed',
        ...newFlightForm,
      });
      setReports(prev => prev.map(r => r.id === updated.id ? updated : r));
      setConfirmModal(null);
    } catch (err) {
      alert('Failed to update: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  async function markClosed(report) {
    try {
      const updated = await updateReport(report.id, { status: 'closed' });
      setReports(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  }

  async function reopenReport(report) {
    try {
      const newStatus = report.new_flight ? 'flight_confirmed' : 'under_process';
      const updated = await updateReport(report.id, { status: newStatus });
      setReports(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  }

  function logout() {
    clearRole();
    navigate('/login');
  }

  // ── Filter by search + status tab
  const filtered = reports.filter(r => {
    const status = r.status || 'under_process';
    if (status !== activeTab) return false;
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

  // Count per status
  const counts = {
    under_process: reports.filter(r => (r.status || 'under_process') === 'under_process').length,
    flight_confirmed: reports.filter(r => r.status === 'flight_confirmed').length,
    closed: reports.filter(r => r.status === 'closed').length,
  };

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

      {/* ── Status Tabs */}
      <div className="status-tabs">
        {['under_process', 'flight_confirmed', 'closed'].map(status => (
          <button
            key={status}
            className={`status-tab ${activeTab === status ? 'active' : ''}`}
            onClick={() => setActiveTab(status)}
            style={activeTab === status ? { borderBottomColor: STATUS_COLORS[status], color: STATUS_COLORS[status] } : {}}
          >
            <span className="tab-label">{STATUS_LABELS[status]}</span>
            <span className="tab-count" style={{ backgroundColor: STATUS_COLORS[status] }}>{counts[status]}</span>
          </button>
        ))}
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
          ? <div className="state-msg">No {STATUS_LABELS[activeTab].toLowerCase()} reports{search ? ' for "' + search + '"' : ''}.</div>
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
                    {activeTab !== 'under_process' && <th>New Flight</th>}
                    {activeTab !== 'under_process' && <th>New Flight Date</th>}
                    {activeTab !== 'under_process' && <th>Days</th>}
                    <th>Status</th>
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
                      {activeTab !== 'under_process' && (
                        <td className="col-flight">
                          <span className="flight-badge">{r.new_flight || '—'}</span>
                        </td>
                      )}
                      {activeTab !== 'under_process' && <td>{fmt(r.new_datetime)}</td>}
                      {activeTab !== 'under_process' && <td className="col-center">{r.days_at_airport != null ? r.days_at_airport : '—'}</td>}
                      <td>
                        <span className="status-badge" style={{ backgroundColor: STATUS_COLORS[r.status || 'under_process'] }}>
                          {STATUS_LABELS[r.status || 'under_process']}
                        </span>
                      </td>
                      <td className="col-actions">
                        {/* Status action buttons */}
                        {(r.status || 'under_process') === 'under_process' && (
                          <button
                            className="btn btn-xs btn-confirm"
                            onClick={() => openConfirmModal(r)}
                            title="Mark as flight confirmed"
                          >
                            ✈ Confirm Flight
                          </button>
                        )}
                        {r.status === 'flight_confirmed' && (
                          <button
                            className="btn btn-xs btn-close-report"
                            onClick={() => markClosed(r)}
                            title="Mark as closed"
                          >
                            ✓ Close
                          </button>
                        )}
                        {r.status === 'closed' && (
                          <button
                            className="btn btn-xs btn-secondary"
                            onClick={() => reopenReport(r)}
                            title="Reopen report"
                          >
                            ↩ Reopen
                          </button>
                        )}
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
                          {copied === r.id ? '✓ Copied' : 'WA'}
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

      {/* ── Flight Confirmed Modal */}
      {confirmModal && (
        <div className="modal-overlay" onClick={() => setConfirmModal(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Confirm New Flight — Report #{confirmModal.id}</h2>
            <p className="modal-subtitle">
              Passenger: {confirmModal.pax_count}× {confirmModal.pax_type} ({confirmModal.nationality})<br/>
              Previous Flight: {confirmModal.prev_flight} → {confirmModal.prev_destination}
            </p>

            <div className="field">
              <label className="field-label">New Flight Number <span className="req">*</span></label>
              <div className="lookup-row">
                <input
                  type="text"
                  className="field-input"
                  placeholder="e.g. SV309"
                  value={newFlightForm.new_flight}
                  onChange={e => { setNewFlightForm(prev => ({ ...prev, new_flight: e.target.value.toUpperCase() })); setLookupStatus('idle'); }}
                  onBlur={lookupNewFlight}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), lookupNewFlight())}
                />
                <button type="button" className="btn btn-lookup" onClick={lookupNewFlight}
                  disabled={lookupStatus === 'loading'}>
                  {lookupStatus === 'loading' ? '…' : 'Look up'}
                </button>
                {lookupStatus === 'found'    && <span className="badge badge-found">Found</span>}
                {lookupStatus === 'notfound' && <span className="badge badge-notfound">Not found</span>}
              </div>
            </div>

            <div className="field-grid">
              <div className="field">
                <label className="field-label">New Flight Date & Time</label>
                <input type="datetime-local" className="field-input autofilled"
                  value={newFlightForm.new_datetime}
                  onChange={e => setNewFlightForm(prev => ({ ...prev, new_datetime: e.target.value }))} />
              </div>
              <div className="field">
                <label className="field-label">New Destination</label>
                <input type="text" className="field-input autofilled" placeholder="Auto-filled"
                  value={newFlightForm.new_destination}
                  onChange={e => setNewFlightForm(prev => ({ ...prev, new_destination: e.target.value }))} />
              </div>
              <div className="field">
                <label className="field-label">New Airline</label>
                <input type="text" className="field-input autofilled" placeholder="Auto-filled"
                  value={newFlightForm.new_airline}
                  onChange={e => setNewFlightForm(prev => ({ ...prev, new_airline: e.target.value }))} />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveFlightConfirmed} disabled={saving}>
                {saving ? 'Saving…' : 'Confirm Flight'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
