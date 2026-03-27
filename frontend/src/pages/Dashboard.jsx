import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReports, deleteReport, updateReport, lookupFlight, airlineFromFlightNumber, getShiftSummary } from '../utils/api';
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

// Calculate live days since prev_flight datetime
function liveDays(prevDatetime) {
  if (!prevDatetime) return null;
  const diff = (Date.now() - new Date(prevDatetime).getTime()) / (1000 * 60 * 60 * 24);
  if (isNaN(diff) || diff < 0) return null;
  return parseFloat(diff.toFixed(1));
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
  const [airlineFilter, setAirlineFilter] = useState('');

  // Bulk select
  const [selected, setSelected] = useState(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);

  // Flight confirmed modal state
  const [confirmModal, setConfirmModal] = useState(null);
  const [newFlightForm, setNewFlightForm] = useState({ new_flight: '', new_datetime: '', new_destination: '', new_airline: '' });
  const [lookupStatus, setLookupStatus] = useState('idle');
  const [saving, setSaving] = useState(false);

  // Shift summary modal
  const [shiftModal, setShiftModal] = useState(false);
  const [shiftData, setShiftData] = useState(null);
  const [shiftDate, setShiftDate] = useState(new Date().toISOString().slice(0, 10));
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftCopied, setShiftCopied] = useState(null);

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

  // ── Get unique airlines from reports for filter dropdown
  const airlines = [...new Set(reports.map(r => r.prev_airline).filter(Boolean))].sort();

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

  // ── Bulk status update
  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(r => r.id)));
    }
  }

  async function bulkConfirmFlight() {
    // For bulk, we just move to flight_confirmed without new flight details (can add later per report)
    if (!confirm(`Move ${selected.size} report(s) to Flight Confirmed? You can add flight details individually later.`)) return;
    setBulkUpdating(true);
    try {
      const updates = [...selected].map(id => updateReport(id, { status: 'flight_confirmed' }));
      const results = await Promise.all(updates);
      setReports(prev => {
        const map = new Map(results.map(r => [r.id, r]));
        return prev.map(r => map.get(r.id) || r);
      });
      setSelected(new Set());
    } catch (err) {
      alert('Bulk update failed: ' + err.message);
    } finally {
      setBulkUpdating(false);
    }
  }

  async function bulkClose() {
    if (!confirm(`Close ${selected.size} report(s)?`)) return;
    setBulkUpdating(true);
    try {
      const updates = [...selected].map(id => updateReport(id, { status: 'closed' }));
      const results = await Promise.all(updates);
      setReports(prev => {
        const map = new Map(results.map(r => [r.id, r]));
        return prev.map(r => map.get(r.id) || r);
      });
      setSelected(new Set());
    } catch (err) {
      alert('Bulk update failed: ' + err.message);
    } finally {
      setBulkUpdating(false);
    }
  }

  // ── Shift summary
  async function openShiftSummary() {
    setShiftModal(true);
    setShiftLoading(true);
    try {
      const data = await getShiftSummary(shiftDate);
      setShiftData(data);
    } catch (err) {
      alert('Failed to load shift summary: ' + err.message);
    } finally {
      setShiftLoading(false);
    }
  }

  async function loadShiftForDate(date) {
    setShiftDate(date);
    setShiftLoading(true);
    try {
      const data = await getShiftSummary(date);
      setShiftData(data);
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setShiftLoading(false);
    }
  }

  function copyShiftText(shiftName, text) {
    navigator.clipboard.writeText(text).then(() => {
      setShiftCopied(shiftName);
      setTimeout(() => setShiftCopied(null), 2000);
    });
  }

  function logout() {
    clearRole();
    navigate('/login');
  }

  // ── Filter by search + status tab + airline
  const filtered = reports.filter(r => {
    const status = r.status || 'under_process';
    if (status !== activeTab) return false;
    if (airlineFilter && r.prev_airline !== airlineFilter) return false;
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

  // Clear selection when tab changes
  useEffect(() => { setSelected(new Set()); }, [activeTab]);

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
          <button className="btn btn-secondary btn-sm" onClick={openShiftSummary} title="Shift Summary">
            Shift Summary
          </button>
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

      {/* ── Search + Airline Filter + count */}
      <div className="dashboard-toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Search reports…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="airline-filter"
          value={airlineFilter}
          onChange={e => setAirlineFilter(e.target.value)}
        >
          <option value="">All Airlines</option>
          {airlines.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="report-count">{filtered.length} report{filtered.length !== 1 ? 's' : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={load} title="Refresh">↻ Refresh</button>
      </div>

      {/* ── Bulk actions */}
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          {activeTab === 'under_process' && (
            <button className="btn btn-xs btn-confirm" onClick={bulkConfirmFlight} disabled={bulkUpdating}>
              {bulkUpdating ? '…' : '✈ Bulk Confirm Flight'}
            </button>
          )}
          {activeTab === 'flight_confirmed' && (
            <button className="btn btn-xs btn-close-report" onClick={bulkClose} disabled={bulkUpdating}>
              {bulkUpdating ? '…' : '✓ Bulk Close'}
            </button>
          )}
          <button className="btn btn-xs btn-secondary" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

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
                    {activeTab !== 'closed' && (
                      <th style={{ width: 36 }}>
                        <input type="checkbox"
                          checked={selected.size === filtered.length && filtered.length > 0}
                          onChange={toggleSelectAll} />
                      </th>
                    )}
                    <th>#</th>
                    <th>Pax ID Date</th>
                    <th>Prev Flight</th>
                    <th>Destination</th>
                    <th>Nationality</th>
                    <th>Pax Type</th>
                    <th>Pax</th>
                    <th>Days</th>
                    {activeTab !== 'under_process' && <th>New Flight</th>}
                    {activeTab !== 'under_process' && <th>New Flight Date</th>}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const days = liveDays(r.prev_datetime);
                    const urgent = days !== null && days >= 1;
                    return (
                      <tr key={r.id} className={urgent && activeTab === 'under_process' ? 'row-urgent' : ''}>
                        {activeTab !== 'closed' && (
                          <td>
                            <input type="checkbox" checked={selected.has(r.id)}
                              onChange={() => toggleSelect(r.id)} />
                          </td>
                        )}
                        <td className="col-id">
                          #{r.id}
                          {r.comment && <span className="comment-indicator" title={r.comment}>💬</span>}
                        </td>
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
                        <td className="col-center">
                          {days !== null ? (
                            <span className={`days-badge ${days >= 1 ? 'days-urgent' : ''}`}>
                              {days}d
                            </span>
                          ) : '—'}
                        </td>
                        {activeTab !== 'under_process' && (
                          <td className="col-flight">
                            <span className="flight-badge">{r.new_flight || '—'}</span>
                          </td>
                        )}
                        {activeTab !== 'under_process' && <td>{fmt(r.new_datetime)}</td>}
                        <td className="col-actions">
                          {(r.status || 'under_process') === 'under_process' && (
                            <button
                              className="btn btn-xs btn-confirm"
                              onClick={() => openConfirmModal(r)}
                              title="Mark as flight confirmed"
                            >
                              ✈ Confirm
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
                            title="Duplicate"
                          >
                            Dup
                          </button>
                          <button
                            className={`btn btn-xs ${copied === r.id ? 'btn-success' : 'btn-whatsapp'}`}
                            onClick={() => copyWhatsApp(r)}
                            title="Copy WhatsApp message"
                          >
                            {copied === r.id ? '✓' : 'WA'}
                          </button>
                          {isSupervisor() && (
                            <button
                              className="btn btn-xs btn-danger"
                              onClick={() => handleDelete(r.id)}
                              disabled={deleting === r.id}
                              title="Delete report"
                            >
                              {deleting === r.id ? '…' : 'Del'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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

      {/* ── Shift Summary Modal */}
      {shiftModal && (
        <div className="modal-overlay" onClick={() => setShiftModal(false)}>
          <div className="modal-content shift-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Shift Summary</h2>
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="field-label">Date</label>
              <input type="date" className="field-input" value={shiftDate}
                onChange={e => loadShiftForDate(e.target.value)} />
            </div>

            {shiftLoading && <p className="state-msg">Loading…</p>}

            {!shiftLoading && shiftData && (
              <div className="shift-cards">
                {['A', 'B', 'C'].map(s => {
                  const shift = shiftData.shifts[s];
                  const hours = s === 'A' ? '06:00–14:00' : s === 'B' ? '14:00–22:00' : '22:00–06:00';
                  return (
                    <div key={s} className="shift-card">
                      <div className="shift-card-header">
                        <strong>Shift {s}</strong>
                        <span className="shift-hours">{hours}</span>
                        <span className="shift-total">{shift.totalPax} PAX</span>
                      </div>
                      <pre className="shift-text">{shift.text}</pre>
                      <button
                        className={`btn btn-sm ${shiftCopied === s ? 'btn-success' : 'btn-whatsapp'}`}
                        onClick={() => copyShiftText(s, shift.text)}
                      >
                        {shiftCopied === s ? '✓ Copied' : 'Copy for WhatsApp'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShiftModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
