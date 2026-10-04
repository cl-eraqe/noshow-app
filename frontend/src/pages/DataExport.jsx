import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ExcelJS from 'exceljs';
import { getExportCases, getExportEdits } from '../utils/api';

// Excel downloads for the supervisor's own analysis. Reached by its address
// only (/data-export); nothing in the app links here.
//
// Dates and times go into Excel as real dates, so they filter, sort and
// pivot. Stored times are Jeddah wall-clock, and are written so Excel shows
// exactly that clock — no time-zone shift on any computer.

// "2026-10-04 09:30:00" / "2026-10-04T09:30" / "2026-10-04" → a Date Excel shows as written
function xlDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))) : null;
}

const DATETIME = 'dd-mmm-yyyy hh:mm', DATE = 'dd-mmm-yyyy';

const CASE_COLUMNS = [
  // Registration
  { key: 'id', header: 'Case #', width: 8, note: 'The case number in the app.' },
  { key: 'registered_by', header: 'Registered by', width: 18, note: 'The employee who created the case.' },
  { key: 'registered_at', header: 'Registered at', width: 18, fmt: DATETIME, note: 'When the case was created.' },
  { key: 'pax_identified_at', header: 'Pax identified at', width: 18, fmt: DATETIME, note: 'When the passenger was identified as a no-show (field 1 of the form).' },
  // Previous flight
  { key: 'prev_flight', header: 'Prev flight', width: 11, note: 'The flight the passenger missed.' },
  { key: 'prev_date', header: 'Prev date', width: 13, fmt: DATE, note: 'Its departure date.' },
  { key: 'prev_time', header: 'Prev time', width: 10, note: 'Its departure time (Jeddah).' },
  { key: 'prev_destination', header: 'Prev destination', width: 22, note: 'Its destination, with the airport code.' },
  { key: 'prev_country', header: 'Prev country', width: 16, note: 'The destination\'s country.' },
  { key: 'prev_airline', header: 'Prev airline', width: 20, note: 'Its airline.' },
  { key: 'prev_terminal', header: 'Prev terminal', width: 15, note: 'Its departure terminal, from the current timetable.' },
  // Passenger
  { key: 'nationality', header: 'Nationality', width: 15, note: 'The passenger\'s nationality.' },
  { key: 'pax_type', header: 'Pax type', width: 16, note: 'Umrah, Tourist, Resident and so on.' },
  { key: 'pax_count', header: 'Pax', width: 6, note: 'Number of passengers in the case.' },
  // New flight
  { key: 'new_flight', header: 'New flight', width: 11, note: 'The flight the passenger was rebooked on (empty until confirmed).' },
  { key: 'new_date', header: 'New date', width: 13, fmt: DATE, note: 'Its departure date.' },
  { key: 'new_time', header: 'New time', width: 10, note: 'Its departure time (Jeddah).' },
  { key: 'new_destination', header: 'New destination', width: 22, note: 'Its destination.' },
  { key: 'new_airline', header: 'New airline', width: 20, note: 'Its airline.' },
  { key: 'new_terminal', header: 'New terminal', width: 15, note: 'Its departure terminal, from the current timetable.' },
  // Follow-up
  { key: 'status', header: 'Status', width: 16, note: 'Under process, Flight confirmed or Closed — as of the download.' },
  { key: 'confirmed_by', header: 'Confirmed by', width: 18, note: 'The employee who confirmed the new flight.' },
  { key: 'confirmed_at', header: 'Confirmed at', width: 18, fmt: DATETIME, note: 'When the new flight was confirmed.' },
  { key: 'closed_at', header: 'Closed at', width: 18, fmt: DATETIME, note: 'When the case was closed.' },
  { key: 'comment', header: 'Comment', width: 40, note: 'The case\'s notes.' },
  // Ready-made for analysis
  { key: 'shift', header: 'Shift', width: 7, note: 'Shift of the missed flight\'s departure: A 06–14, B 14–22, C 22–06.' },
  { key: 'weekday', header: 'Weekday', width: 11, note: 'Day of the week of the missed flight.' },
  { key: 'hours_to_confirm', header: 'Hours to confirm', width: 10, num: '0.0', note: 'Hours from registering the case to confirming the new flight.' },
  { key: 'hours_to_close', header: 'Hours to close', width: 10, num: '0.0', note: 'Hours from registering the case to closing it.' },
  { key: 'days_at_airport', header: 'Days at airport', width: 10, num: '0.0', note: 'Days the passenger spent at the airport, as recorded on the case.' },
];

const EDIT_COLUMNS = [
  { key: 'time', header: 'Time', width: 18, fmt: DATETIME },
  { key: 'user', header: 'Employee', width: 18 },
  { key: 'action', header: 'Action', width: 18 },
  { key: 'case_id', header: 'Case #', width: 8 },
  { key: 'flight', header: 'Flight', width: 11 },
  { key: 'field', header: 'Field', width: 24 },
  { key: 'from', header: 'From', width: 28 },
  { key: 'to', header: 'To', width: 28 },
];

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width }));
  for (const r of rows) {
    const values = {};
    for (const c of columns) {
      const v = r[c.key];
      values[c.key] = c.fmt ? (xlDate(v) ?? '') : (v ?? '');
    }
    ws.addRow(values);
  }
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.fmt) col.numFmt = c.fmt;
    if (c.num) col.numFmt = c.num;
  });
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A5C' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

async function save(wb, name) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const today = () => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 10);

export default function DataExport() {
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  async function downloadCases() {
    setBusy('cases'); setMessage('');
    try {
      const rows = await getExportCases(from, to);
      const wb = new ExcelJS.Workbook();
      addSheet(wb, 'Cases', CASE_COLUMNS, rows);
      const readme = wb.addWorksheet('Read me');
      readme.columns = [{ header: 'Column', key: 'c', width: 20 }, { header: 'Meaning', key: 'm', width: 90 }];
      readme.getRow(1).font = { bold: true };
      CASE_COLUMNS.forEach(c => readme.addRow({ c: c.header, m: c.note }));
      readme.addRow({});
      readme.addRow({ c: 'Range', m: from || to ? `Registered ${from || 'from the start'} to ${to || 'today'}` : 'All cases' });
      readme.addRow({ c: 'Downloaded', m: today() });
      const range = from || to ? `${from || 'start'}_to_${to || today()}` : `all_${today()}`;
      await save(wb, `no-show-cases-${range}.xlsx`);
      setMessage(`${rows.length} case${rows.length === 1 ? '' : 's'} downloaded.`);
    } catch (e) {
      setMessage(`Could not download: ${e.message}`);
    } finally { setBusy(''); }
  }

  async function downloadEdits() {
    setBusy('edits'); setMessage('');
    try {
      const { rows } = await getExportEdits(10);
      const wb = new ExcelJS.Workbook();
      addSheet(wb, 'Edits', EDIT_COLUMNS, rows);
      await save(wb, `no-show-edits-last-10-days-${today()}.xlsx`);
      setMessage(`${rows.length} change${rows.length === 1 ? '' : 's'} downloaded.`);
    } catch (e) {
      setMessage(`Could not download: ${e.message}`);
    } finally { setBusy(''); }
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Back</button>
        <h1 className="page-title">Data export</h1>
      </div>

      <div className="form-section">
        <h2 className="section-title">All cases</h2>
        <p className="export-hint">Every case, one row each, with who registered it, both flights, the passenger and the follow-up.
          Leave the dates empty for every case ever recorded.</p>
        <div className="export-dates">
          <label className="field">
            <span className="field-label">Registered from</span>
            <input type="date" className="field-input" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">to</span>
            <input type="date" className="field-input" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
          </label>
        </div>
        <button className="btn btn-primary" onClick={downloadCases} disabled={!!busy}>
          {busy === 'cases' ? 'Preparing…' : '⭳ Download cases'}
        </button>
      </div>

      <div className="form-section" style={{ marginTop: 16 }}>
        <h2 className="section-title">Edit log — last 10 days</h2>
        <p className="export-hint">Every change made to a case, one row per changed field: who, when, and the value before and after.</p>
        <button className="btn btn-primary" onClick={downloadEdits} disabled={!!busy}>
          {busy === 'edits' ? 'Preparing…' : '⭳ Download edit log'}
        </button>
      </div>

      {message && <p className="export-message">{message}</p>}
    </div>
  );
}
