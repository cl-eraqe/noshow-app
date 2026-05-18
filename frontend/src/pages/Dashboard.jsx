import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import ExcelJS from 'exceljs';
import { getReports, deleteReport, updateReport, lookupFlight, airlineFromFlightNumber, getShiftSummary, getHandoverReport, needsBus, getTerminal, confirmNusuk, getFilterOptions, deleteReportFile, getFileObjectUrl, downloadFile, apiLogout } from '../utils/api';
import SearchableSelect from '../components/SearchableSelect';

import { getRole, isSupervisor, logout as clearLocalAuth } from '../utils/auth';

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

// ── Excel export helpers (Last 24h)
const EXP_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function friendlyFilename(report, originalPath, index, total) {
  const ext     = originalPath.includes('.') ? originalPath.split('.').pop().toLowerCase() : '';
  const pax     = report.pax_count || 1;
  const paxType = (report.pax_type || 'PAX').trim();
  const rawDest = report.new_destination || report.prev_destination || '';
  const dest    = (rawDest.match(/\(([A-Z]{3})\)/)?.[1] || rawDest).toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
  const flight  = (report.new_flight || report.prev_flight || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dt      = report.new_datetime || report.prev_datetime || '';
  let dayMonth  = '';
  if (dt) { const d = new Date(dt.replace(' ', 'T')); if (!isNaN(d)) dayMonth = `${d.getDate()} ${EXP_MONTHS[d.getMonth()]}`; }
  const parts  = [`${pax} PAX`, paxType, dest, flight, dayMonth].filter(Boolean);
  const base   = parts.join(' - ');
  const suffix = total > 1 ? ` (${index + 1})` : '';
  return ext ? `${base}${suffix}.${ext}` : `${base}${suffix}`;
}

function fmtDayMonth(dt) {
  if (!dt) return '';
  const d = new Date(typeof dt === 'string' ? dt.replace(' ', 'T') : dt);
  if (isNaN(d)) return '';
  return `${d.getDate()}-${EXP_MONTHS[d.getMonth()]}`;
}
function fmtTime24(dt) {
  if (!dt) return '';
  const d = new Date(typeof dt === 'string' ? dt.replace(' ', 'T') : dt);
  if (isNaN(d)) return '';
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function statusToText(s) {
  return s === 'closed' ? 'Departed' : 'In progress';
}
function actionTakenText(s) {
  if (s === 'closed') return 'Departed';
  if (s === 'flight_confirmed') return 'Scheduled an Alternative Flight';
  return 'Under Process';
}
function paxTypeColumn(visa) {
  return (visa === 'Umrah' || visa === 'Hajj Group') ? 'Umrah / Hajj Grp' : 'Normal Pax';
}
function terminalLabel(prevFlight) {
  const t = getTerminal(prevFlight);
  if (t === 'T1') return 'Terminal 1';
  if (t === 'Hajj') return 'Hajj Terminal';
  if (t === 'North') return 'North Terminal';
  return t || '';
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

  // Single confirm modal (for single report from ✈ Confirm button)
  const [confirmModal, setConfirmModal] = useState(null);
  const [newFlightForm, setNewFlightForm] = useState({ new_flight: '', new_datetime: '', new_destination: '', new_airline: '' });
  const [lookupStatus, setLookupStatus] = useState('idle');
  const [saving, setSaving] = useState(false);

  // Bulk confirm modal
  const [bulkConfirmModal, setBulkConfirmModal] = useState(false);
  const [bulkSameFlight, setBulkSameFlight] = useState(true);
  const [bulkSharedFlight, setBulkSharedFlight] = useState({ new_flight: '', new_datetime: '', new_destination: '', new_airline: '' });
  const [bulkSharedLookup, setBulkSharedLookup] = useState('idle');
  const [bulkPerReport, setBulkPerReport] = useState({}); // { [id]: { new_flight, new_datetime, new_destination, new_airline } }
  const [bulkPerLookup, setBulkPerLookup] = useState({}); // { [id]: 'idle'|'loading'|'found'|'notfound' }
  const [bulkSaving, setBulkSaving] = useState(false);

  // Shift summary modal
  const [shiftModal, setShiftModal] = useState(false);
  const [shiftData, setShiftData] = useState(null);
  const [shiftDate, setShiftDate] = useState(new Date().toISOString().slice(0, 10));
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftCopied, setShiftCopied] = useState(null);


  // Inline pax edit
  const [editingPax, setEditingPax] = useState(null); // report id
  const [editPaxValue, setEditPaxValue] = useState('');

  // Handover modal
  const [handoverModal, setHandoverModal] = useState(false);
  const [handoverData, setHandoverData] = useState(null);
  const [handoverLoading, setHandoverLoading] = useState(false);
  const [handoverNotes, setHandoverNotes] = useState('');
  const [handoverCopied, setHandoverCopied] = useState(false);
  const [handoverShift, setHandoverShift] = useState(() => {
    // Default based on Jeddah time (UTC+3)
    const jeddahHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })).getHours();
    if (jeddahHour >= 6 && jeddahHour < 14) return 'A';
    if (jeddahHour >= 14 && jeddahHour < 22) return 'B';
    return 'C';
  });

  const role = getRole();
  const [knownDestinations, setKnownDestinations] = useState([]);

  // Quick-view modal (comment / attachments from emoji click)
  const [quickView, setQuickView] = useState(null); // { report, tab: 'comment'|'attachments' }
  const [qvDeleting, setQvDeleting] = useState(null); // filename being deleted
  const [excelMenu, setExcelMenu] = useState(false);
  const excelMenuRef = useRef(null);

  useEffect(() => { load(); }, []);
  useEffect(() => {
    getFilterOptions().then(o => setKnownDestinations(o.destinationsFull || [])).catch(() => {});
  }, []);
  useEffect(() => {
    function onDown(e) { if (excelMenuRef.current && !excelMenuRef.current.contains(e.target)) setExcelMenu(false); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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

  // ── Single confirm modal
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

  async function markClosed(report, e) {
    e.stopPropagation();
    try {
      const updated = await updateReport(report.id, { status: 'closed' });
      setReports(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  }

  async function reopenReport(report, e) {
    e.stopPropagation();
    try {
      const newStatus = report.new_flight ? 'flight_confirmed' : 'under_process';
      const updated = await updateReport(report.id, { status: newStatus });
      setReports(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  }

  // ── Inline pax edit
  function startEditPax(r, e) {
    e.stopPropagation();
    setEditingPax(r.id);
    setEditPaxValue(String(r.pax_count ?? 0));
  }

  async function savePax(id) {
    const val = parseInt(editPaxValue);
    if (isNaN(val) || val < 0) { setEditingPax(null); return; }
    try {
      const updated = await updateReport(id, { pax_count: val });
      setReports(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (err) {
      alert('Failed to update pax count: ' + err.message);
    }
    setEditingPax(null);
  }

  // ── Bulk select
  function toggleSelect(id, e) {
    e.stopPropagation();
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

  // ── Bulk confirm modal
  function openBulkConfirmModal() {
    const selectedReports = reports.filter(r => selected.has(r.id));
    setBulkConfirmModal(true);
    setBulkSameFlight(true);
    setBulkSharedFlight({ new_flight: '', new_datetime: '', new_destination: '', new_airline: '' });
    setBulkSharedLookup('idle');
    const perReport = {};
    const perLookup = {};
    selectedReports.forEach(r => {
      perReport[r.id] = { new_flight: '', new_datetime: '', new_destination: '', new_airline: '' };
      perLookup[r.id] = 'idle';
    });
    setBulkPerReport(perReport);
    setBulkPerLookup(perLookup);
  }

  async function bulkSharedLookupFn() {
    const fn = bulkSharedFlight.new_flight.trim();
    if (!fn) return;
    setBulkSharedLookup('loading');
    try {
      const data = await lookupFlight(fn);
      setBulkSharedFlight(prev => ({
        ...prev,
        new_datetime: stdToDatetime(data.std),
        new_destination: `${data.city} (${data.destination})`,
        new_airline: airlineFromFlightNumber(fn),
      }));
      setBulkSharedLookup('found');
    } catch {
      setBulkSharedLookup('notfound');
    }
  }

  async function bulkPerReportLookup(id) {
    const fn = (bulkPerReport[id]?.new_flight || '').trim();
    if (!fn) return;
    setBulkPerLookup(prev => ({ ...prev, [id]: 'loading' }));
    try {
      const data = await lookupFlight(fn);
      setBulkPerReport(prev => ({
        ...prev,
        [id]: {
          ...prev[id],
          new_datetime: stdToDatetime(data.std),
          new_destination: `${data.city} (${data.destination})`,
          new_airline: airlineFromFlightNumber(fn),
        }
      }));
      setBulkPerLookup(prev => ({ ...prev, [id]: 'found' }));
    } catch {
      setBulkPerLookup(prev => ({ ...prev, [id]: 'notfound' }));
    }
  }

  function setBulkPerField(id, field, value) {
    setBulkPerReport(prev => ({
      ...prev,
      [id]: { ...prev[id], [field]: value }
    }));
    if (field === 'new_flight') {
      setBulkPerLookup(prev => ({ ...prev, [id]: 'idle' }));
    }
  }

  async function saveBulkConfirm() {
    setBulkSaving(true);
    try {
      const ids = [...selected];
      const updates = ids.map(id => {
        const flightData = bulkSameFlight ? bulkSharedFlight : (bulkPerReport[id] || {});
        if (!flightData.new_flight?.trim()) {
          throw new Error(`Please enter flight number for all reports`);
        }
        return updateReport(id, {
          status: 'flight_confirmed',
          ...flightData,
        });
      });
      const results = await Promise.all(updates);
      setReports(prev => {
        const map = new Map(results.map(r => [r.id, r]));
        return prev.map(r => map.get(r.id) || r);
      });
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

  // ── Handover
  async function openHandover() {
    setHandoverModal(true);
    setHandoverCopied(false);
    setHandoverNotes('');
    await loadHandover(handoverShift);
  }

  async function loadHandover(shift) {
    setHandoverLoading(true);
    try {
      const data = await getHandoverReport(shift);
      setHandoverData(data);
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

  // ── Export cases to Excel (supervisor only) — range: '24h' | 'week'
  async function exportExcel(range) {
    setExcelMenu(false);
    try {
      const all = await getReports();
      const ms = range === 'week' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - ms;
      const recent = all.filter(r => {
        if (!r.created_at) return false;
        const t = new Date(r.created_at.replace(' ', 'T')).getTime();
        return !isNaN(t) && t >= cutoff;
      });

      if (recent.length === 0) {
        alert(`No reports were recorded in the last ${range === 'week' ? '7 days' : '24 hours'}.`);
        return;
      }

      const headers = [
        'Recorded Date', 'Recorded Time', 'Terminal',
        'Original Departure Time', 'Original Departure Date', 'Original Flight Number',
        'Visa Type', 'Pax Type', 'Nationality', 'Total Pax',
        'Status', 'Root Causes', 'Action Taken',
        'Responsible Stakeholder of Passenger', 'Notes', 'Welfare (Food / Drinks)',
        'New Departure Time', 'New Departure Date', 'New Flight Number',
      ];

      const ORIGINAL_HEADERS = new Set(['Original Departure Time', 'Original Departure Date', 'Original Flight Number']);
      const NEW_HEADERS = new Set(['New Departure Time', 'New Departure Date', 'New Flight Number']);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(range === 'week' ? 'Last 7 Days' : 'Last 24h');

      ws.addRow(headers);

      recent.forEach(r => {
        ws.addRow([
          fmtDayMonth(r.created_at),
          fmtTime24(r.created_at),
          terminalLabel(r.prev_flight),
          fmtTime24(r.prev_datetime),
          fmtDayMonth(r.prev_datetime),
          r.prev_flight || '',
          r.pax_type || '',
          paxTypeColumn(r.pax_type),
          r.nationality || '',
          r.pax_count || 0,
          statusToText(r.status),
          'Late Arrivals',
          actionTakenText(r.status),
          '',
          r.comment || '',
          'Yes',
          fmtTime24(r.new_datetime),
          fmtDayMonth(r.new_datetime),
          r.new_flight || '',
        ]);
      });

      // Style header row
      const headerRow = ws.getRow(1);
      headerRow.height = 22;
      headerRow.eachCell((cell, colNumber) => {
        const headerName = headers[colNumber - 1];
        let bg = 'FF002060';
        if (ORIGINAL_HEADERS.has(headerName)) bg = 'FF375623';
        else if (NEW_HEADERS.has(headerName)) bg = 'FF0070C0';
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF000000' } },
          left: { style: 'thin', color: { argb: 'FF000000' } },
          bottom: { style: 'thin', color: { argb: 'FF000000' } },
          right: { style: 'thin', color: { argb: 'FF000000' } },
        };
      });

      // Borders + alignment for body rows
      for (let i = 2; i <= recent.length + 1; i++) {
        const row = ws.getRow(i);
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
            left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
            bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
            right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
          };
        });
      }

      // Column widths
      ws.columns.forEach((col, idx) => {
        col.width = Math.max(headers[idx].length + 2, 14);
      });
      ws.views = [{ state: 'frozen', ySplit: 1 }];

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const today = fmtDayMonth(new Date()).toLowerCase();
      const a = document.createElement('a');
      a.href = url;
      a.download = `no-show-last-${range}-${today}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to export: ' + err.message);
    }
  }

  function copyHandover() {
    if (!handoverData) return;
    let text = handoverData.text;
    if (handoverNotes.trim()) {
      text += '\n\n━━ NOTES ━━\n' + handoverNotes.trim();
    }
    navigator.clipboard.writeText(text).then(() => {
      setHandoverCopied(true);
      setTimeout(() => setHandoverCopied(false), 2000);
    });
  }

  async function logout() {
    await apiLogout();
    clearLocalAuth();
    navigate('/login');
  }

  // ── Swipe handling for mobile
  const touchRef = useRef({ startX: 0, startY: 0, id: null });

  function handleTouchStart(r, e) {
    const touch = e.touches[0];
    touchRef.current.startX = touch.clientX;
    touchRef.current.startY = touch.clientY;
    touchRef.current.id = r.id;
  }

  function handleTouchEnd(r, e) {
    if (touchRef.current.id !== r.id) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchRef.current.startX;
    const dy = touch.clientY - touchRef.current.startY;
    // Only register horizontal swipes (dx > 60px, and more horizontal than vertical)
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;

    if (dx < 0) {
      // Swipe left → confirm flight (only if under_process)
      if ((r.status || 'under_process') === 'under_process') {
        openConfirmModal(r);
      }
    } else {
      // Swipe right → duplicate
      duplicate(r);
    }
  }

  // ── Row click → edit (but not on action buttons/checkboxes)
  function handleRowClick(r, e) {
    // Don't navigate if clicking on buttons, inputs, or action cells
    if (e.target.closest('.col-actions') || e.target.closest('input[type="checkbox"]') || e.target.tagName === 'BUTTON') return;
    navigate(`/edit-report/${r.id}`);
  }

  // ── Filter
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

  useEffect(() => { setSelected(new Set()); }, [activeTab]);

  // Sort flight_confirmed: bus transfers first, then by new_datetime
  const sorted = [...filtered].sort((a, b) => {
    if (activeTab === 'flight_confirmed') {
      const aBus = needsBus(a.new_flight) ? 0 : 1;
      const bBus = needsBus(b.new_flight) ? 0 : 1;
      if (aBus !== bBus) return aBus - bBus;
    }
    return 0;
  });

  const counts = {
    under_process: reports.filter(r => (r.status || 'under_process') === 'under_process').length,
    flight_confirmed: reports.filter(r => r.status === 'flight_confirmed').length,
    closed: reports.filter(r => r.status === 'closed').length,
  };

  const paxCounts = {
    under_process: reports.filter(r => (r.status || 'under_process') === 'under_process').reduce((s, r) => s + (r.pax_count || 0), 0),
    flight_confirmed: reports.filter(r => r.status === 'flight_confirmed').reduce((s, r) => s + (r.pax_count || 0), 0),
    closed: reports.filter(r => r.status === 'closed').reduce((s, r) => s + (r.pax_count || 0), 0),
  };

  // Selected reports for bulk modal
  const selectedReports = reports.filter(r => selected.has(r.id));

  return (
    <div className="page">
      {/* ── Header */}
      <div className="dashboard-header">
        <div className="header-brand">
          <img src="/jedco-logo.png" alt="JEDCO" className="header-logo" />
          <span className="header-title">No-Show App</span>
          <span className="header-role">{role}</span>
        </div>
        <div className="header-actions">
          <button className="btn btn-handover btn-sm" onClick={openHandover} title="Shift Handover">
            Handover
          </button>
          <button className="btn btn-secondary btn-sm" onClick={openShiftSummary} title="Shift Summary">
            Shift Summary
          </button>
          {isSupervisor() && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/analytics')}>
                Analytics
              </button>
              <div ref={excelMenuRef} style={{ position: 'relative' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => setExcelMenu(m => !m)} title="Export to Excel">
                  📊 Excel ▾
                </button>
                {excelMenu && (
                  <div style={{
                    position: 'absolute', left: 0, top: '100%', marginTop: 4, zIndex: 50,
                    background: '#0f1a2e', border: '1px solid #2b3a5a',
                    borderRadius: 8, minWidth: 160, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                  }}>
                    {[{ label: 'Last 24 hours', range: '24h' }, { label: 'Last 7 days', range: 'week' }].map(({ label, range }) => (
                      <button key={range}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 16px',
                          background: 'none', border: 'none', color: '#e6eefb',
                          cursor: 'pointer', fontSize: '0.92rem', fontWeight: 500 }}
                        onMouseEnter={e => e.currentTarget.style.background = '#1a2a45'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        onClick={() => exportExcel(range)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/flight-manager')} title="Manage flight database">
                ✈ Flights
              </button>
            </>
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
            <span className="tab-pax">{paxCounts[status]} pax</span>
          </button>
        ))}
      </div>

      {/* ── Search + Airline Filter */}
      <div className="dashboard-toolbar">
        <input type="search" className="search-input" placeholder="Search reports…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="airline-filter" value={airlineFilter} onChange={e => setAirlineFilter(e.target.value)}>
          <option value="">All Airlines</option>
          {airlines.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="report-count">{sorted.length} report{sorted.length !== 1 ? 's' : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={load} title="Refresh">↻ Refresh</button>
      </div>

      {/* ── Bulk actions */}
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

      {/* ── States */}
      {loading && <div className="state-msg">Loading reports…</div>}
      {error   && <div className="state-msg error">{error}</div>}

      {/* ── Table */}
      {!loading && !error && (
        filtered.length === 0
          ? <div className="state-msg">No {STATUS_LABELS[activeTab].toLowerCase()} reports{search ? ' for "' + search + '"' : ''}.</div>

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
                    const urgent = days !== null && days >= 1;
                    const bus = needsBus(r.new_flight);
                    const showNusuk = r.pax_type === 'Umrah' && r.new_datetime &&
                      (new Date(r.new_datetime) - Date.now()) >= 24 * 60 * 60 * 1000;
                    return (
                      <tr key={r.id}
                        className={`clickable-row ${urgent && activeTab === 'under_process' ? 'row-urgent' : ''} ${bus && activeTab === 'flight_confirmed' ? 'row-bus' : ''}`}
                        onClick={e => handleRowClick(r, e)}
                        onTouchStart={e => handleTouchStart(r, e)}
                        onTouchEnd={e => handleTouchEnd(r, e)}
                      >
                        {activeTab !== 'closed' && (
                          <td data-label="" className="mobile-checkbox">
                            <input type="checkbox" checked={selected.has(r.id)}
                              onChange={e => toggleSelect(r.id, e)} />
                          </td>
                        )}
                        <td data-label="#" className="col-id">
                          #{r.id}
                          {r.comment && (
                            <span className="comment-indicator" title="View comment" style={{ cursor: 'pointer' }}
                              onClick={e => { e.stopPropagation(); setQuickView({ report: r, tab: 'comment' }); }}>💬</span>
                          )}
                          {(() => { try { return JSON.parse(r.file_paths || '[]').length > 0; } catch { return false; } })() && (
                            <span className="comment-indicator" title="View attachments" style={{ cursor: 'pointer' }}
                              onClick={e => { e.stopPropagation(); setQuickView({ report: r, tab: 'attachments' }); }}>📎</span>
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
                            <input
                              type="number"
                              min="0"
                              className="pax-inline-edit"
                              value={editPaxValue}
                              onChange={e => setEditPaxValue(e.target.value)}
                              onBlur={() => savePax(r.id)}
                              onKeyDown={e => { if (e.key === 'Enter') savePax(r.id); if (e.key === 'Escape') setEditingPax(null); }}
                              autoFocus
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            <span className="pax-editable" onClick={e => startEditPax(r, e)} title="Click to edit">
                              {r.pax_count ?? '—'}
                            </span>
                          )}
                        </td>
                        <td data-label="Days" className="col-center">
                          {days !== null ? (
                            <span className={`days-badge ${days >= 1 ? 'days-urgent' : ''}`}>
                              {days}d
                            </span>
                          ) : '—'}
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
                                try {
                                  await confirmNusuk(r.id, !r.nusuk_received, role);
                                  await load();
                                } catch (err) { alert('Failed: ' + err.message); }
                              }}
                              title={r.nusuk_received
                                ? `Nusuk received pax on ${r.nusuk_received} — click to undo`
                                : 'Confirm Nusuk received pax'}>
                              {r.nusuk_received ? '✓ Nusuk' : 'Nusuk?'}
                            </button>
                          )}
                          {(r.status || 'under_process') === 'under_process' && (
                            <button className="btn btn-xs btn-confirm"
                              onClick={e => { e.stopPropagation(); openConfirmModal(r); }}
                              title="Mark as flight confirmed">
                              ✈ Confirm
                            </button>
                          )}
                          {r.status === 'flight_confirmed' && (
                            <button className="btn btn-xs btn-close-report"
                              onClick={e => markClosed(r, e)} title="Mark as closed">
                              ✓ Close
                            </button>
                          )}
                          {r.status === 'closed' && (
                            <button className="btn btn-xs btn-secondary"
                              onClick={e => reopenReport(r, e)} title="Reopen report">
                              ↩ Reopen
                            </button>
                          )}
                          <button className="btn btn-xs btn-secondary"
                            onClick={e => { e.stopPropagation(); duplicate(r); }} title="Duplicate">
                            Dup
                          </button>
                          <button
                            className={`btn btn-xs ${copied === r.id ? 'btn-success' : 'btn-whatsapp'}`}
                            onClick={e => { e.stopPropagation(); copyWhatsApp(r); }}
                            title="Copy WhatsApp message">
                            {copied === r.id ? '✓' : 'WA'}
                          </button>
                          {isSupervisor() && (
                            <button className="btn btn-xs btn-danger"
                              onClick={e => handleDelete(r.id, e)}
                              disabled={deleting === r.id} title="Delete report">
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

      {/* ── Single Confirm Modal */}
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
                <button type="button" className="btn btn-lookup" onClick={lookupNewFlight}
                  disabled={lookupStatus === 'loading'}>
                  {lookupStatus === 'loading' ? '…' : 'Look up'}
                </button>
                {lookupStatus === 'found' && <span className="badge badge-found">Found</span>}
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
                <SearchableSelect
                  placeholder="Auto-filled or search…"
                  options={knownDestinations}
                  value={newFlightForm.new_destination}
                  onChange={v => setNewFlightForm(prev => ({ ...prev, new_destination: v }))}
                />
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

      {/* ── Bulk Confirm Modal */}
      {bulkConfirmModal && (
        <div className="modal-overlay" onClick={() => setBulkConfirmModal(false)}>
          <div className="modal-content bulk-confirm-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Confirm Flights — {selectedReports.length} Reports</h2>

            <label className="same-flight-toggle">
              <input type="checkbox" checked={bulkSameFlight}
                onChange={e => setBulkSameFlight(e.target.checked)} />
              <span>Same flight for all</span>
            </label>

            {/* ── Same flight mode */}
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
                    <button type="button" className="btn btn-lookup" onClick={bulkSharedLookupFn}
                      disabled={bulkSharedLookup === 'loading'}>
                      {bulkSharedLookup === 'loading' ? '…' : 'Look up'}
                    </button>
                    {bulkSharedLookup === 'found' && <span className="badge badge-found">Found</span>}
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
                    <SearchableSelect
                      placeholder="Auto-filled or search…"
                      options={knownDestinations}
                      value={bulkSharedFlight.new_destination}
                      onChange={v => setBulkSharedFlight(prev => ({ ...prev, new_destination: v }))}
                    />
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

            {/* ── Different flights mode */}
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
                        {bulkPerLookup[r.id] === 'found' && <span className="badge badge-found">Found</span>}
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
                        <SearchableSelect
                          placeholder="Destination"
                          options={knownDestinations}
                          value={bulkPerReport[r.id]?.new_destination || ''}
                          onChange={v => setBulkPerField(r.id, 'new_destination', v)}
                        />
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

      {/* ── Handover Modal */}
      {handoverModal && (
        <div className="modal-overlay" onClick={() => setHandoverModal(false)}>
          <div className="modal-content handover-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Shift Handover</h2>

            <div className="handover-shift-picker">
              {[
                { value: 'A', label: 'A → B', hours: '06–14' },
                { value: 'B', label: 'B → C', hours: '14–22' },
                { value: 'C', label: 'C → A', hours: '22–06' },
              ].map(s => (
                <button
                  key={s.value}
                  className={`shift-pick-btn ${handoverShift === s.value ? 'active' : ''}`}
                  onClick={() => changeHandoverShift(s.value)}
                  disabled={handoverLoading}
                >
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
                  <textarea
                    className="field-input"
                    rows="3"
                    placeholder="e.g. EgyptAir counter closes at 22:00, tell pax to go early…"
                    value={handoverNotes}
                    onChange={e => setHandoverNotes(e.target.value)}
                  />
                </div>
              </>
            )}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setHandoverModal(false)}>Close</button>
              <button
                className={`btn ${handoverCopied ? 'btn-success' : 'btn-whatsapp'}`}
                onClick={copyHandover}
                disabled={!handoverData}
              >
                {handoverCopied ? '✓ Copied!' : 'Copy for WhatsApp'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick View Modal (comment / attachments) */}
      {quickView && (
        <div className="modal-overlay" onClick={() => setQuickView(null)}>
          <div className="modal-content" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Report #{quickView.report.id}</h2>

            {/* Tab switcher when both exist */}
            {quickView.report.comment && (() => { try { return JSON.parse(quickView.report.file_paths || '[]').length > 0; } catch { return false; } })() && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {['comment', 'attachments'].map(t => (
                  <button key={t} className={`btn btn-sm ${quickView.tab === t ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setQuickView(v => ({ ...v, tab: t }))}>
                    {t === 'comment' ? '💬 Comment' : '📎 Attachments'}
                  </button>
                ))}
              </div>
            )}

            {quickView.tab === 'comment' && (
              <div>
                <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--text, #e6eefb)', margin: '0 0 16px' }}>
                  {quickView.report.comment || '—'}
                </p>
                {navigator.share && quickView.report.comment && (
                  <button className="btn btn-sm btn-secondary" onClick={() =>
                    navigator.share({ text: quickView.report.comment }).catch(() => {})
                  }>Share 🔗</button>
                )}
              </div>
            )}

            {quickView.tab === 'attachments' && (() => {
              const filePaths = (() => { try { return JSON.parse(quickView.report.file_paths || '[]'); } catch { return []; } })();
              return (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {filePaths.length === 0 && <li style={{ color: '#aaa' }}>No attachments</li>}
                  {filePaths.map((fp, i) => {
                    const fname     = fp.split('/').pop();
                    const saveName  = friendlyFilename(quickView.report, fname, i, filePaths.length);
                    return (
                      <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid #2b3a5a', flexWrap: 'wrap' }}>
                        <span style={{ flex: 1, wordBreak: 'break-all', fontSize: '0.9rem' }}>📄 {saveName}</span>
                        <button className="btn btn-sm btn-secondary" onClick={() => {
                          const win = window.open('', '_blank');
                          getFileObjectUrl(fp).then(({ url }) => { win.location.href = url; }).catch(() => { win.close(); alert('Failed to open'); });
                        }}>Open</button>
                        <button className="btn btn-sm btn-primary" onClick={() => downloadFile(fp, saveName).catch(() => alert('Download failed'))}>Download</button>
                        {navigator.canShare && (
                          <button className="btn btn-sm btn-secondary" onClick={async () => {
                            try {
                              const { url, type } = await getFileObjectUrl(fp);
                              const blob = await (await fetch(url)).blob();
                              const file = new File([blob], saveName, { type: type || blob.type });
                              if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: saveName });
                              else await navigator.share({ title: saveName });
                            } catch (err) { if (err?.name !== 'AbortError') alert('Share failed'); }
                          }}>Share</button>
                        )}
                        {role === 'supervisor' && (
                          <button className="btn btn-sm btn-danger" disabled={qvDeleting === fname}
                            onClick={async () => {
                              if (!confirm('Delete this attachment?')) return;
                              setQvDeleting(fname);
                              try {
                                const { file_paths } = await deleteReportFile(quickView.report.id, fname);
                                setReports(rs => rs.map(r => r.id === quickView.report.id ? { ...r, file_paths: JSON.stringify(file_paths) } : r));
                                setQuickView(v => ({ ...v, report: { ...v.report, file_paths: JSON.stringify(file_paths) } }));
                              } catch { alert('Failed to delete'); }
                              finally { setQvDeleting(null); }
                            }}>
                            {qvDeleting === fname ? '…' : 'Delete'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              );
            })()}

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setQuickView(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
