import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { lookupFlight, airlineFromFlightNumber, createReport } from '../utils/api';
import { getRole } from '../utils/auth';

const PAX_TYPES = [
  'Umrah',
  'Tourist',
  'Resident',
  'Transit',
  'Transit Visa 3-day',
  'Family Visit',
  'Final Exit',
];

const NATIONALITIES = [
  'Algerian','American','Bahraini','Bangladeshi','British','Egyptian','Emirati',
  'Ethiopian','Filipino','French','German','Ghanaian','Indian','Indonesian',
  'Iranian','Iraqi','Jordanian','Kenyan','Lebanese','Libyan','Malaysian',
  'Maldivian','Moroccan','Nepali','Nigerian','Omani','Pakistani','Qatari',
  'Saudi','Singaporean','Sri Lankan','Sudanese','Syrian','Thai','Tunisian','Turkish',
];

function useFlightLookup() {
  const [status, setStatus] = useState('idle'); // idle | loading | found | notfound
  return { status, setStatus };
}

function calcDaysAtAirport(paxIdDatetime, newDatetime) {
  if (!paxIdDatetime || !newDatetime) return '';
  const diff = (new Date(newDatetime) - new Date(paxIdDatetime)) / (1000 * 60 * 60 * 24);
  if (isNaN(diff)) return '';
  return Math.max(0, parseFloat(diff.toFixed(2)));
}

// Format STD (HH:MM) + today's date into a datetime-local value
function stdToDatetime(std) {
  if (!std) return '';
  const today = new Date().toISOString().slice(0, 10);
  return `${today}T${std}`;
}

export default function NewReport({ prefill }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Support duplicate prefill passed via router state
  const seed = prefill || location.state?.prefill || {};

  const [form, setForm] = useState({
    pax_id_datetime:  seed.pax_id_datetime  || '',
    prev_flight:      seed.prev_flight      || '',
    prev_datetime:    seed.prev_datetime    || '',
    prev_destination: seed.prev_destination || '',
    prev_airline:     seed.prev_airline     || '',
    nationality:      seed.nationality      || '',
    pax_type:         seed.pax_type         || '',
    new_flight:       seed.new_flight       || '',
    new_datetime:     seed.new_datetime     || '',
    new_destination:  seed.new_destination  || '',
    new_airline:      seed.new_airline      || '',
    pax_count:        seed.pax_count        || '',
  });

  const [files, setFiles] = useState([]);
  const [prevStatus, setPrevStatus]   = useState('idle');
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [success, setSuccess]         = useState(null);

  // Days at airport not calculated at submit time anymore — calculated when new flight is added via status update

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  // ── Previous flight auto-fill
  const lookupPrev = useCallback(async () => {
    const fn = form.prev_flight.trim();
    if (!fn) return;
    setPrevStatus('loading');
    try {
      const data = await lookupFlight(fn);
      setForm(prev => ({
        ...prev,
        prev_datetime:    stdToDatetime(data.std),
        prev_destination: `${data.city} (${data.destination})`,
        prev_airline:     airlineFromFlightNumber(fn),
        nationality:      prev.nationality || data.nationality,
      }));
      setPrevStatus('found');
    } catch {
      setPrevStatus('notfound');
    }
  }, [form.prev_flight]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError('');
    try {
      const fd = new FormData();
      // Only send relevant fields (no new flight info at creation time)
      const fieldsToSend = ['pax_id_datetime', 'prev_flight', 'prev_datetime', 'prev_destination', 'prev_airline', 'nationality', 'pax_type', 'pax_count'];
      fieldsToSend.forEach(k => fd.append(k, form[k] || ''));
      fd.append('status', 'under_process');
      fd.append('submitted_by', getRole());
      files.forEach(f => fd.append('files', f));

      const report = await createReport(fd);
      setSuccess(report);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="page">
        <div className="success-card">
          <div className="success-icon">✓</div>
          <h2>Report #{success.id} Submitted</h2>
          <p>The no-show report has been saved successfully.</p>
          <div className="whatsapp-preview">
            <label className="field-label">WhatsApp Text</label>
            <pre className="whatsapp-text">{success.whatsapp_text}</pre>
            <button
              className="btn btn-secondary"
              onClick={() => navigator.clipboard.writeText(success.whatsapp_text)}
            >
              Copy to Clipboard
            </button>
          </div>
          <div className="success-actions">
            <button className="btn btn-primary" onClick={() => navigate('/dashboard')}>
              Back to Dashboard
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { setSuccess(null); setForm({ pax_id_datetime:'',prev_flight:'',prev_datetime:'',prev_destination:'',prev_airline:'',nationality:'',pax_type:'',new_flight:'',new_datetime:'',new_destination:'',new_airline:'',pax_count:'' }); setFiles([]); setPrevStatus('idle'); }}
            >
              New Report
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Dashboard</button>
        <h1 className="page-title">New No-Show Report</h1>
      </div>

      <form onSubmit={handleSubmit} className="report-form">

        {/* ── 1. PAX ID Date & Time */}
        <div className="form-section">
          <h2 className="section-title">Identification</h2>
          <div className="field">
            <label className="field-label">1. Pax Identification Date & Time <span className="req">*</span></label>
            <input type="datetime-local" className="field-input" required
              value={form.pax_id_datetime} onChange={e => set('pax_id_datetime', e.target.value)} />
          </div>
        </div>

        {/* ── Previous Flight */}
        <div className="form-section">
          <h2 className="section-title">Previous Flight</h2>

          <div className="field">
            <label className="field-label">2. Previous Flight Number <span className="req">*</span></label>
            <div className="lookup-row">
              <input
                type="text"
                className="field-input"
                placeholder="e.g. SV305"
                value={form.prev_flight}
                onChange={e => { set('prev_flight', e.target.value.toUpperCase()); setPrevStatus('idle'); }}
                onBlur={lookupPrev}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), lookupPrev())}
                required
              />
              <button type="button" className="btn btn-lookup" onClick={lookupPrev}
                disabled={prevStatus === 'loading'}>
                {prevStatus === 'loading' ? '…' : 'Look up'}
              </button>
              {prevStatus === 'found'    && <span className="badge badge-found">✓ Found</span>}
              {prevStatus === 'notfound' && <span className="badge badge-notfound">Not found</span>}
            </div>
          </div>

          <div className="field-grid">
            <div className="field">
              <label className="field-label">3. Previous Flight Date & Time</label>
              <input type="datetime-local" className="field-input autofilled"
                value={form.prev_datetime} onChange={e => set('prev_datetime', e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label">4. Previous Destination</label>
              <input type="text" className="field-input autofilled" placeholder="Auto-filled"
                value={form.prev_destination} onChange={e => set('prev_destination', e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label">5. Previous Airline</label>
              <input type="text" className="field-input autofilled" placeholder="Auto-filled"
                value={form.prev_airline} onChange={e => set('prev_airline', e.target.value)} />
            </div>
          </div>
        </div>

        {/* ── Passenger Details */}
        <div className="form-section">
          <h2 className="section-title">Passenger Details</h2>

          <div className="field-grid">
            <div className="field">
              <label className="field-label">6. Nationality</label>
              <select className="field-input autofilled" value={form.nationality}
                onChange={e => set('nationality', e.target.value)}>
                <option value="">Select nationality…</option>
                {NATIONALITIES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field-label">7. Passenger Type <span className="req">*</span></label>
              <select className="field-input" required value={form.pax_type}
                onChange={e => set('pax_type', e.target.value)}>
                <option value="">Select type…</option>
                {PAX_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field-label">13. Number of Passengers <span className="req">*</span></label>
              <input type="number" className="field-input" min="1" required
                value={form.pax_count} onChange={e => set('pax_count', e.target.value)} />
            </div>
          </div>
        </div>

        {/* ── New Flight (only shown when not in "under_process" mode, i.e. user chose to add flight) */}
        {/* This section is now optional — report can be submitted without it */}

        {/* ── Attachments */}
        <div className="form-section">
          <h2 className="section-title">Attachments</h2>
          <div className="field">
            <label className="field-label">14. File Attachments</label>
            <input type="file" className="field-input" multiple
              onChange={e => setFiles(Array.from(e.target.files))} />
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, i) => <li key={i}>{f.name} ({(f.size/1024).toFixed(1)} KB)</li>)}
              </ul>
            )}
          </div>
        </div>

        {submitError && <p className="form-error">{submitError}</p>}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/dashboard')}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Submitting…' : '15. Submit Report'}
          </button>
        </div>
      </form>
    </div>
  );
}
