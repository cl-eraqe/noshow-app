import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReports, deleteReport, updateReport, lookupFlight, airlineFromFlightNumber, getShiftSummary, getHandoverReport, needsBus, getTerminal, confirmNusuk, getFilterOptions } from '../utils/api';
import SearchableSelect from '../components/SearchableSelect';
import { getRole, isSupervisor, logout as authLogout } from '../utils/auth';

function fmt(dt) {
  if (!dt) return '—';
  try { return new Date(dt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return dt; }
}

function stdToDatetime(std) {
  if (!std) return '';
  return `${new Date().toISOString().slice(0, 10)}T${std}`;
}

function liveDays(prevDatetime) {
  if (!prevDatetime) return null;
  const diff = (Date.now() - new Date(prevDatetime).getTime()) / (1000 * 60 * 60 * 24);
  return (!isNaN(diff) && diff >= 0) ? parseFloat(diff.toFixed(1)) : null;
}

const STATUS_LABELS = { under_process: 'Under Process', flight_confirmed: 'Flight Confirmed', closed: 'Closed' };
const STATUS_COLORS = { under_process: '#e67e22', flight_confirmed: '#27ae60', closed: '#95a5a6' };
const EMPTY_FLIGHT  = { new_flight: '', new_datetime: '', new_destination: '', new_airline: '' };

const _jeddahHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })).getHours();
const INIT_SHIFT = _jeddahHour >= 6 && _jeddahHour < 14 ? 'A' : _jeddahHour >= 14 && _jeddahHour < 22 ? 'B' : 'C';

export default function Dashboard() {
  const navigate = useNavigate();
  const [reports, setReports]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [copied, setCopied]         = useState(null);
  const [deleting, setDeleting]     = useState(null);
  const [search, setSearch]         = useState('');
  const [activeTab, setActiveTab]   = useState('under_process');
  const [airlineFilter, setAirlineFilter] = useState('');
  const [selected, setSelected]     = useState(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  const [newFlightForm, setNewFlightForm] = useState(EMPTY_FLIGHT);
  const [lookupStatus, setLookupStatus] = useState('idle');
  const [saving, setSaving]         = useState(false);
  const [bulkConfirmModal, setBulkConfirmModal] = useState(false);
  const [bulkSameFlight, setBulkSameFlight]     = useState(true);
  const [bulkSharedFlight, setBulkSharedFlight] = useState(EMPTY_FLIGHT);
  const [bulkSharedLookup, setBulkSharedLookup] = useState('idle');
  const [bulkPerReport, setBulkPerReport]       = useState({});
  const [bulkPerLookup, setBulkPerLookup]       = useState({});
  const [bulkSaving, setBulkSaving]   = useState(false);
  const [shiftModal, setShiftModal]   = useState(false);
  const [shiftData, setShiftData]     = useState(null);
  const [shiftDate, setShiftDate]     = useState(new Date().toISOString().slice(0, 10));
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftCopied, setShiftCopied]   = useState(null);
  const [editingPax, setEditingPax]   = useState(null);
  const [editPaxValue, setEditPaxValue] = useState('');
  const [handoverModal, setHandoverModal]   = useState(false);
  const [handoverData, setHandoverData]     = useState(null);
  const [handoverLoading, setHandoverLoading] = useState(false);
  const [handoverNotes, setHandoverNotes]   = useState('');
  const [handoverCopied, setHandoverCopied] = useState(false);
  const [handoverShift, setHandoverShift]   = useState(INIT_SHIFT);
  const [knownDestinations, setKnownDestinations] = useState([]);

  const role = getRole();

  useEffect(() => { load(); }, []);
  useEffect(() => {
    getFilterOptions().then(o => setKnownDestinations(o.destinationsFull || [])).catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setReports(await getReports());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function applyUpdates(results) {
    const map = new Map(results.map(r => [r.id, r]));
    setReports(prev => prev.map(r => map.get(r.id) || r));
  }

  const airlines = useMemo(
    () => [...new Set(reports.map(r => r.prev_airline).filter(Boolean))].sort(),
    [reports]
  );

  function copyWhatsApp(report) {
    const text = report.whatsapp_text || (
      `No-Show Report #${report.id}\n` +
      `Flight: ${report.prev_flight || '—'} → ${report.prev_destination || '—'}\n` +
      `Pax: ${report.pax_count} × ${report.pax_type || '—'}\n` +
      `Nationality: ${report.nationality || '—'}\n` +
      `New Flight: ${report.new_flight || '—'} on ${fmt(report.new_datetime)}`
    );
    navigator.clipboard.writeText(text).then(() => {
      setCopied(report.id);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  function duplicate(report) {
    navigate('/new-report', { state: { prefill: {
      prev_flight: report.prev_flight, prev_datetime: report.prev_datetime,
      prev_destination: report.prev_destination, prev_airline: report.prev_airline,
      nationality: report.nationality, pax_type: report.pax_type,
    }}});
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
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

  function openConfirmModal(report) {
    setConfirmModal(report);
    setNewFlightForm({
      new_flight: report.new_flight || '', new_datetime: report.new_datetime || '',
      new_destination: report.new_destination || '', new_airline: report.new_airline || '',
    });
    setLookupStatus('idle');
  }

  async function doLookup(fn, onFound) {
    try {
      const data = await lookupFlight(fn);
      onFound({
        new_datetime: stdToDatetime(data.std),
        new_destination: `${data.city} (${data.destination})`,
        new_airline: airlineFromFlightNumber(fn),
      });
      return 'found';
    } catch {
      return 'notfound';
    }
  }

  async function lookupNewFlight() {
    const fn = newFlightForm.new_flight.trim();
    if (!fn) return;
    setLookupStatus('loading');
    setLookupStatus(await doLookup(fn, fields => setNewFlightForm(prev => ({ ...prev, ...fields }))));
  }

  async function saveFlightConfirmed() {
    if (!confirmModal) return;
    if (!newFlightForm.new_flight.trim()) { alert('Please enter the new flight number'); return; }
    setSaving(true);
    try {
      applyUpdates([await updateReport(confirmModal.id, { status: 'flight_confirmed', ...newFlightForm })]);
      setConfirmModal(null);
    } catch (err) {
      alert('Failed to update: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  async function markClosed(report, e) {
    e.stopPropagation();
    try { applyUpdates([await updateReport(report.id, { status: 'closed' })]); }
    catch (err) { alert('Failed to update: ' + err.message); }
  }

  async function reopenReport(report, e) {
    e.stopPropagation();
    const newStatus = report.new_flight ? 'flight_confirmed' : 'under_process';
    try { applyUpdates([await updateReport(report.id, { status: newStatus })]); }
    catch (err) { alert('Failed to update: ' + err.message); }
  }

  function startEditPax(r, e) {
    e.stopPropagation();
    setEditingPax(r.id);
    setEditPaxValue(String(r.pax_count ?? 0));
  }

  async function savePax(id) {
    const val = parseInt(editPaxValue);
    if (!isNaN(val) && val >= 0) {
      try { applyUpdates([await updateReport(id, { pax_count: val })]); }
      catch (err) { alert('Failed to update pax count: ' + err.message); }
    }
    setEditingPax(null);
  }

  function toggleSelect(id, e) {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map(r => r.id)));
  }

  function openBulkConfirmModal() {
    setBulkConfirmModal(true);
    setBulkSameFlight(true);
    setBulkSharedFlight(EMPTY_FLIGHT);
    setBulkSharedLookup('idle');
    const ids = [...selected];
    setBulkPerReport(Object.fromEntries(ids.map(id => [id, { ...EMPTY_FLIGHT }])));
    setBulkPerLookup(Object.fromEntries(ids.map(id => [id, 'idle'])));
  }

  async function bulkSharedLookupFn() {
    const fn = bulkSharedFlight.new_flight.trim();
    if (!fn) return;
    setBulkSharedLookup('loading');
    setBulkSharedLookup(await doLookup(fn, fields => setBulkSharedFlight(prev => ({ ...prev, ...fields }))));
  }

  async function bulkPerReportLookup(id) {
    const fn = (bulkPerReport[id]?.new_flight || '').trim();
    if (!fn) return;
    setBulkPerLookup(prev => ({ ...prev, [id]: 'loading' }));
    const status = await doLookup(fn, fields => setBulkPerReport(prev => ({ ...prev, [id]: { ...prev[id], ...fields } })));
    setBulkPerLookup(prev => ({ ...prev, [id]: status }));
  }

  function setBulkPerField(id, field, value) {
    setBulkPerReport(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    if (field === 'new_flight') setBulkPerLookup(prev => ({ ...prev, [id]: 'idle' }));
  }

  async function saveBulkConfirm() {
    setBulkSaving(true);
    try {
      const results = await Promise.all([...selected].map(id => {
        const flightData = bulkSameFlight ? bulkSharedFlight : (bulkPerReport[id] || {});
        if (!flightData.new_flight?.trim()) throw new Error('Please enter flight number for all reports');
        return updateReport(id, { status: 'flight_confirmed', ...flightData });
      }));
      applyUpdates(results);
      setSelected(new Set());
      setBulkConfirmModal(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setBulkSaving(false);
    }
  }

  async function bulkClose() {
    if (!confirm(`Close ${selected.size} report(s)?`)) return;
    setBulkUpdating(true);
    try {
      const results = await Promise.all([...selected].map(id => updateReport(id, { status: 'closed' })));
      applyUpdates(results);
      setSelected(new Set());
    } catch (err) {
      alert('Bulk update failed: ' + err.message);
    } finally {
      setBulkUpdating(false);
    }
  }

  async function loadShift(date) {
    if (date !== undefined) setShiftDate(date);
    const d = date ?? shiftDate;
    setShiftLoading(true);
    try {
      setShiftData(await getShiftSummary(d));
    } catch (err) {
      alert('Failed to load shift summary: ' + err.message);
    } finally {
      setShiftLoading(false);
    }
  }

  function openShiftSummary() { setShiftModal(true); loadShift(); }

  function copyShiftText(shiftName, text) {
    navigator.clipboard.writeText(text).then(() => {
      setShiftCopied(shiftName);
      setTimeout(() => setShiftCopied(null), 2000);
    });
  }

  async function openHandover() {
    setHandoverModal(true);
    setHandoverCopied(false);
    setHandoverNotes('');
    await loadHandover(handoverShift);
  }

  async function loadHandover(shift) {
    setHandoverLoading(true);
    try {
      setHandoverData(await getHandoverReport(shift));
    } catch (err) {
      alert('Failed to generate handover: ' + err.message);
    } finally {
      setHandoverLoading(false);
    }
  }

  async function changeHandoverShift(shift) {
    setHandoverShift(shift);
    await loadHandover(shift);
  }

  function copyHandover() {
    if (!handoverData) return;
    let text = handoverData.text;
    if (handoverNotes.trim()) text += '\n\n━━ NOTES ━━\n' + handoverNotes.trim();
    navigator.clipboard.writeText(text).then(() => {
      setHandoverCopied(true);
      setTimeout(() => setHandoverCopied(false), 2000);
    });
  }

  function logout() { authLogout(); navigate('/login'); }

  const touchRef = useRef({ startX: 0, startY: 0, id: null });

  function handleTouchStart(r, e) {
    const { clientX, clientY } = e.touches[0];
    touchRef.current = { startX: clientX, startY: clientY, id: r.id };
  }

  function handleTouchEnd(r, e) {
    if (touchRef.current.id !== r.id) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.startX;
    const dy = e.changedTouches[0].clientY - touchRef.current.startY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
    dx < 0
      ? ((r.status || 'under_process') === 'under_process' && openConfirmModal(r))
      : duplicate(r);
  }

  function handleRowClick(r, e) {
    if (e.target.closest('.col-actions') || e.target.closest('input[type="checkbox"]') || e.target.tagName === 'BUTTON') return;
    navigate(`/edit-report/${r.id}`);
  }

  const filtered = reports.filter(r => {
    if ((r.status || 'under_process') !== activeTab) return false;
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

  useEffect(() => { setSelected(new Set()); }, [activeTab]);

  const sorted = [...filtered].sort((a, b) => {
    if (activeTab !== 'flight_confirmed') return 0;
    return (needsBus(a.new_flight) ? 0 : 1) - (needsBus(b.new_flight) ? 0 : 1);
  });

  const tabStats = useMemo(() => {
    const s = {
      under_process:    { count: 0, pax: 0 },
      flight_confirmed: { count: 0, pax: 0 },
      closed:           { count: 0, pax: 0 },
    };
    reports.forEach(r => {
      const k = r.status || 'under_process';
      s[k].count++;
      s[k].pax += r.pax_count || 0;
    });
    return s;
  }, [reports]);

  const selectedReports = reports.filter(r => selected.has(r.id));

  return (
    <div className="page">
      <div className="dashboard-header">
        <div className="header-brand">
          <img src="/jedco-logo.png" alt="JEDCO" className="header-logo" />
          <span className="header-title">No-Show App</span>
          <span className="header-role">{role}</span>
        </div>
        <div className="header-actions">
          <button className="btn btn-handover btn-sm" onClick={openHandover}>Handover</button>
          <button className="btn btn-secondary btn-sm" onClick={openShiftSummary}>Shift Summary</button>
          {isSupervisor() && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/analytics')}>Analytics</button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/access-management')}>Access</button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/flight-manager')}>✈ Flights</button>
            </>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/new-report')}>+ New Report</button>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
        </div>
      </div>

      <div className="status-tabs">
        {['under_process', 'flight_confirmed', 'closed'].map(status => (
          <button
            key={status}
            className={`status-tab ${activeTab === status ? 'active' : ''}`}
            onClick={() => setActiveTab(status)}
            style={activeTab === status ? { borderBottomColor: STATUS_COLORS[status], color: STATUS_COLORS[status] } : {}}
          >
            <span className="tab-label">{STATUS_LABELS[status]}</span>
            <span className="tab-count" style={{ backgroundColor: STATUS_COLORS[status] }}>{tabStats[status].count}</span>
            <span className="tab-pax">{tabStats[status].pax} pax</span>
          </button>
        ))}
      </div>

      <div className="dashboard-toolbar">
        <input type="search" className="search-input" placeholder="Search reports…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="airline-filter" value={airlineFilter} onChange={e => setAirlineFilter(e.target.value)}>
          <option value="">All Airlines</option>
          {airlines.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="report-count">{sorted.length} report{sorted.length !== 1 ? 's' : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          {activeTab === 'under_process' && (
            <button className="btn btn-xs btn-confirm" onClick={openBulkConfirmModal} disabled={bulkUpdating}>
              ✈ Bulk Confirm Flight
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

      {loading && <div className="state-msg">Loading reports…</div>}
      {error   && <div className="state-msg error">{error}</div>}

      {!loading && !error && (
        filtered.length === 0
          ? <div className="state-msg">No {STATUS_LABELS[activeTab].toLowerCase()} reports{search ? ` for "${search}"` : ''}.</div>
          : (
            <div className="table-wrapper">
              <div className="swipe-hint">
                <span>← Swipe left: Confirm</span>
                <span>Swipe right: Duplicate →</span>
              </div>
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
                  {sorted.map(r => {
                    const days = liveDays(r.prev_datetime);
                    const bus  = needsBus(r.new_flight);
                    const showNusuk = r.pax_type === 'Umrah' && r.new_datetime &&
                      (new Date(r.new_datetime) - Date.now()) >= 24 * 60 * 60 * 1000;
                    return (
                      <tr key={r.id}
                        className={`clickable-row ${days >= 1 && activeTab === 'under_process' ? 'row-urgent' : ''} ${bus && activeTab === 'flight_confirmed' ? 'row-bus' : ''}`}
                        onClick={e => handleRowClick(r, e)}
                        onTouchStart={e => handleTouchStart(r, e)}
                        onTouchEnd={e => handleTouchEnd(r, e)}
                      >
                        {activeTab !== 'closed' && (
                          <td data-label="" className="mobile-checkbox">
                            <input type="checkbox" checked={selected.has(r.id)} onChange={e => toggleSelect(r.id, e)} />
                          </td>
                        )}
                        <td data-label="#" className="col-id">
                          #{r.id}
                          {r.comment && <span className="comment-indicator" title={r.comment}>💬</span>}
                          {(() => { try { return JSON.parse(r.file_paths || '[]').length > 0; } catch { return false; } })() && (
                            <span className="comment-indicator" title="Has attachments">📎</span>
                          )}
                        </td>
                        <td data-label="Prev Flight" className="col-flight">
                          <span className="flight-badge">{r.prev_flight || '—'}</span>
                        </td>
                        <td data-label="Destination">{r.prev_destination || '—'}</td>
                        <td data-label="Nationality">{r.nationality || '—'}</td>
                        <td data-label="Pax Type">
                          <span className="pax-type-badge">{r.pax_type || '—'}</span>
                          {showNusuk && <img src="/nusuk-logo.svg" alt="Nusuk" className="nusuk-inline" title="Nusuk notification required" />}
                        </td>
                        <td data-label="Pax" className="col-center">
                          {editingPax === r.id ? (
                            <input type="number" min="0" className="pax-inline-edit"
                              value={editPaxValue}
                              onChange={e => setEditPaxValue(e.target.value)}
                              onBlur={() => savePax(r.id)}
                              onKeyDown={e => { if (e.key === 'Enter') savePax(r.id); if (e.key === 'Escape') setEditingPax(null); }}
                              autoFocus onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            <span className="pax-editable" onClick={e => startEditPax(r, e)} title="Click to edit">
                              {r.pax_count ?? '—'}
                            </span>
                          )}
                        </td>
                        <td data-label="Days" className="col-center">
                          {days !== null
                            ? <span className={`days-badge ${days >= 1 ? 'days-urgent' : ''}`}>{days}d</span>
                            : '—'}
                        </td>
                        {activeTab !== 'under_process' && (
                          <td data-label="New Flight" className="col-flight">
                            <span className="flight-badge">{r.new_flight || '—'}</span>
                            {bus && <span className="bus-badge" title={`Bus to ${getTerminal(r.new_flight)} Terminal`}>🚌 {getTerminal(r.new_flight)}</span>}
                          </td>
                        )}
                        {activeTab !== 'under_process' && <td data-label="New Flight Date">{fmt(r.new_datetime)}</td>}
                        <td data-label="" className="col-actions">
                          {showNusuk && (
                            <button
                              className={`btn btn-xs ${r.nusuk_received ? 'btn-success' : 'btn-nusuk'}`}
                              onClick={async e => {
                                e.stopPropagation();
                                try { await confirmNusuk(r.id, !r.nusuk_received, role); await load(); }
                                catch (err) { alert('Failed: ' + err.message); }
                              }}
                              title={r.nusuk_received ? `Nusuk received pax on ${r.nusuk_received} — click to undo` : 'Confirm Nusuk received pax'}>
                              {r.nusuk_received ? '✓ Nusuk' : 'Nusuk?'}
                            </button>
                          )}
                          {(r.status || 'under_process') === 'under_process' && (
                            <button className="btn btn-xs btn-confirm"
                              onClick={e => { e.stopPropagation(); openConfirmModal(r); }}>
                              ✈ Confirm
                            </button>
                          )}
                          {r.status === 'flight_confirmed' && (
                            <button className="btn btn-xs btn-close-report" onClick={e => markClosed(r, e)}>✓ Close</button>
                          )}
                          {r.status === 'closed' && (
                            <button className="btn btn-xs btn-secondary" onClick={e => reopenReport(r, e)}>↩ Reopen</button>
                          )}
                          <button className="btn btn-xs btn-secondary"
                            onClick={e => { e.stopPropagation(); duplicate(r); }}>Dup</button>
                          <button
                            className={`btn btn-xs ${copied === r.id ? 'btn-success' : 'btn-whatsapp'}`}
                            onClick={e => { e.stopPropagation(); copyWhatsApp(r); }}>
                            {copied === r.id ? '✓' : 'WA'}
                          </button>
                          {isSupervisor() && (
                            <button className="btn btn-xs btn-danger"
                              onClick={e => handleDelete(r.id, e)} disabled={deleting === r.id}>
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

      {confirmModal && (
        <div className="modal-overlay" onClick={() => setConfirmModal(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Confirm New Flight — Report #{confirmModal.id}</h2>
            <p className="modal-subtitle">
              {confirmModal.pax_count}× {confirmModal.pax_type} ({confirmModal.nationality})<br/>
              Previous: {confirmModal.prev_flight} → {confirmModal.prev_destination}
            </p>
            <div className="field">
              <label className="field-label">New Flight Number <span className="req">*</span></label>
              <div className="lookup-row">
                <input type="text" className="field-input" placeholder="e.g. SV309"
                  value={newFlightForm.new_flight}
                  onChange={e => { setNewFlightForm(prev => ({ ...prev, new_flight: e.target.value.toUpperCase() })); setLookupStatus('idle'); }}
                  onBlur={lookupNewFlight}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), lookupNewFlight())} />
                <button type="button" className="btn btn-lookup" onClick={lookupNewFlight} disabled={lookupStatus === 'loading'}>
                  {lookupStatus === 'loading' ? '…' : 'Look up'}
                </button>
                {lookupStatus === 'found'    && <span className="badge badge-found">Found</span>}
                {lookupStatus === 'notfound' && <span className="badge badge-notfound">Not found</span>}
              </div>
            </div>
            <div className="field-grid">
              <div className="field">
                <label className="field-label">Date & Time</label>
                <input type="datetime-local" className="field-input autofilled"
                  value={newFlightForm.new_datetime}
                  onChange={e => setNewFlightForm(prev => ({ ...prev, new_datetime: e.target.value }))} />
              </div>
              <div className="field">
                <label className="field-label">Destination</label>
                <SearchableSelect placeholder="Auto-filled or search…" options={knownDestinations}
                  value={newFlightForm.new_destination}
                  onChange={v => setNewFlightForm(prev => ({ ...prev, new_destination: v }))} />
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

      {bulkConfirmModal && (
        <div className="modal-overlay" onClick={() => setBulkConfirmModal(false)}>
          <div className="modal-content bulk-confirm-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Confirm Flights — {selectedReports.length} Reports</h2>
            <label className="same-flight-toggle">
              <input type="checkbox" checked={bulkSameFlight} onChange={e => setBulkSameFlight(e.target.checked)} />
              <span>Same flight for all</span>
            </label>

            {bulkSameFlight && (
              <div className="bulk-shared-section">
                <div className="field">
                  <label className="field-label">New Flight Number <span className="req">*</span></label>
                  <div className="lookup-row">
                    <input type="text" className="field-input" placeholder="e.g. SV309"
                      value={bulkSharedFlight.new_flight}
                      onChange={e => { setBulkSharedFlight(prev => ({ ...prev, new_flight: e.target.value.toUpperCase() })); setBulkSharedLookup('idle'); }}
                      onBlur={bulkSharedLookupFn}
                      onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), bulkSharedLookupFn())} />
                    <button type="button" className="btn btn-lookup" onClick={bulkSharedLookupFn} disabled={bulkSharedLookup === 'loading'}>
                      {bulkSharedLookup === 'loading' ? '…' : 'Look up'}
                    </button>
                    {bulkSharedLookup === 'found'    && <span className="badge badge-found">Found</span>}
                    {bulkSharedLookup === 'notfound' && <span className="badge badge-notfound">Not found</span>}
                  </div>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label className="field-label">Date & Time</label>
                    <input type="datetime-local" className="field-input autofilled"
                      value={bulkSharedFlight.new_datetime}
                      onChange={e => setBulkSharedFlight(prev => ({ ...prev, new_datetime: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label">Destination</label>
                    <SearchableSelect placeholder="Auto-filled or search…" options={knownDestinations}
                      value={bulkSharedFlight.new_destination}
                      onChange={v => setBulkSharedFlight(prev => ({ ...prev, new_destination: v }))} />
                  </div>
                </div>
                <div className="bulk-applies-to">
                  <label className="field-label">Applies to:</label>
                  {selectedReports.map(r => (
                    <div key={r.id} className="bulk-report-row">
                      <span className="bulk-report-id">#{r.id}</span>
                      <span>{r.pax_count}× {r.pax_type}</span>
                      <span>{r.nationality}</span>
                      <span className="flight-badge">{r.prev_flight}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!bulkSameFlight && (
              <div className="bulk-per-section">
                {selectedReports.map(r => (
                  <div key={r.id} className="bulk-per-card">
                    <div className="bulk-per-header">
                      <span className="bulk-report-id">#{r.id}</span>
                      <span>{r.pax_count}× {r.pax_type} ({r.nationality})</span>
                      <span className="flight-badge">{r.prev_flight} → {r.prev_destination}</span>
                    </div>
                    <div className="field">
                      <div className="lookup-row">
                        <input type="text" className="field-input" placeholder="New flight…"
                          value={bulkPerReport[r.id]?.new_flight || ''}
                          onChange={e => setBulkPerField(r.id, 'new_flight', e.target.value.toUpperCase())}
                          onBlur={() => bulkPerReportLookup(r.id)}
                          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), bulkPerReportLookup(r.id))} />
                        <button type="button" className="btn btn-lookup" onClick={() => bulkPerReportLookup(r.id)}
                          disabled={bulkPerLookup[r.id] === 'loading'}>
                          {bulkPerLookup[r.id] === 'loading' ? '…' : 'Look up'}
                        </button>
                        {bulkPerLookup[r.id] === 'found'    && <span className="badge badge-found">Found</span>}
                        {bulkPerLookup[r.id] === 'notfound' && <span className="badge badge-notfound">Not found</span>}
                      </div>
                    </div>
                    <div className="field-grid">
                      <div className="field">
                        <input type="datetime-local" className="field-input autofilled"
                          value={bulkPerReport[r.id]?.new_datetime || ''}
                          onChange={e => setBulkPerField(r.id, 'new_datetime', e.target.value)} />
                      </div>
                      <div className="field">
                        <SearchableSelect placeholder="Destination" options={knownDestinations}
                          value={bulkPerReport[r.id]?.new_destination || ''}
                          onChange={v => setBulkPerField(r.id, 'new_destination', v)} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setBulkConfirmModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveBulkConfirm} disabled={bulkSaving}>
                {bulkSaving ? 'Saving…' : `Confirm ${selectedReports.length} Reports`}
              </button>
            </div>
          </div>
        </div>
      )}

      {shiftModal && (
        <div className="modal-overlay" onClick={() => setShiftModal(false)}>
          <div className="modal-content shift-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Shift Summary</h2>
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="field-label">Date</label>
              <input type="date" className="field-input" value={shiftDate}
                onChange={e => loadShift(e.target.value)} />
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
                      <button className={`btn btn-sm ${shiftCopied === s ? 'btn-success' : 'btn-whatsapp'}`}
                        onClick={() => copyShiftText(s, shift.text)}>
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

      {handoverModal && (
        <div className="modal-overlay" onClick={() => setHandoverModal(false)}>
          <div className="modal-content handover-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Shift Handover</h2>
            <div className="handover-shift-picker">
              {[{ value: 'A', label: 'A → B', hours: '06–14' }, { value: 'B', label: 'B → C', hours: '14–22' }, { value: 'C', label: 'C → A', hours: '22–06' }].map(s => (
                <button key={s.value}
                  className={`shift-pick-btn ${handoverShift === s.value ? 'active' : ''}`}
                  onClick={() => changeHandoverShift(s.value)} disabled={handoverLoading}>
                  <span className="shift-pick-label">{s.label}</span>
                  <span className="shift-pick-hours">{s.hours}</span>
                </button>
              ))}
            </div>
            {handoverLoading && <p className="state-msg">Generating handover…</p>}
            {!handoverLoading && handoverData && (
              <>
                <pre className="handover-text">{handoverData.text}</pre>
                <div className="field" style={{ marginTop: 12 }}>
                  <label className="field-label">Notes (added at the end)</label>
                  <textarea className="field-input" rows="3"
                    placeholder="e.g. EgyptAir counter closes at 22:00, tell pax to go early…"
                    value={handoverNotes} onChange={e => setHandoverNotes(e.target.value)} />
                </div>
              </>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setHandoverModal(false)}>Close</button>
              <button className={`btn ${handoverCopied ? 'btn-success' : 'btn-whatsapp'}`}
                onClick={copyHandover} disabled={!handoverData}>
                {handoverCopied ? '✓ Copied!' : 'Copy for WhatsApp'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
