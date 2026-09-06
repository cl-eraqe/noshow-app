import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { lookupFlight, getCustomFlights, saveFlight, deleteFlight,
         getPendingAirlines, approveAirline, ignoreAirline, getKaiaStatus } from '../utils/api';

const EMPTY = { flight_number: '', destination: '', std: '', city: '', country: '', nationality: '' };

export default function FlightManager() {
  const navigate = useNavigate();

  const [customs, setCustoms]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [form, setForm]           = useState(EMPTY);
  const [editKey, setEditKey]     = useState(null); // null = new, string = editing
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [lookupStatus, setLookupStatus] = useState('idle');
  const [confirmDel, setConfirmDel]     = useState(null);

  const [pending, setPending]       = useState([]);
  const [kaiaStatus, setKaiaStatus] = useState(null);

  async function load() {
    setLoading(true);
    try { setCustoms(await getCustomFlights()); } catch { setCustoms([]); }
    setLoading(false);
  }
  async function loadPending() {
    try { setPending(await getPendingAirlines()); } catch { setPending([]); }
    try { setKaiaStatus(await getKaiaStatus()); } catch { setKaiaStatus(null); }
  }
  useEffect(() => { load(); loadPending(); }, []);

  async function handleLookup() {
    const key = form.flight_number.toUpperCase().trim();
    if (!key) return;
    setLookupStatus('loading');
    try {
      const data = await lookupFlight(key);
      setForm(f => ({
        ...f,
        flight_number: key,
        destination: data.destination || f.destination,
        std: data.std || f.std,
        city: data.city || f.city,
        country: data.country || f.country,
        nationality: data.nationality || f.nationality,
      }));
      setLookupStatus('found');
    } catch {
      setLookupStatus('notfound');
    }
  }

  function startEdit(row) {
    setEditKey(row.flight_number);
    setForm({
      flight_number: row.flight_number,
      destination:   row.destination || '',
      std:           row.std || '',
      city:          row.city || '',
      country:       row.country || '',
      nationality:   row.nationality || '',
    });
    setLookupStatus('idle');
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() {
    setForm(EMPTY);
    setEditKey(null);
    setLookupStatus('idle');
    setError('');
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!form.flight_number.trim()) return setError('Flight number is required.');
    setSaving(true);
    setError('');
    try {
      await saveFlight({ ...form, flight_number: form.flight_number.toUpperCase().trim() });
      await load();
      resetForm();
    } catch {
      setError('Failed to save. Please try again.');
    }
    setSaving(false);
  }

  async function handleDelete(key) {
    try {
      await deleteFlight(key);
      await load();
      setConfirmDel(null);
      if (editKey === key) resetForm();
    } catch {
      setError('Failed to delete.');
    }
  }

  const filtered = customs.filter(r =>
    !search || r.flight_number.toLowerCase().includes(search.toLowerCase()) ||
    (r.city || '').toLowerCase().includes(search.toLowerCase()) ||
    (r.destination || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="page-wrap">
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Back</button>
        <h1 className="page-title">✈ Flight Manager</h1>
        <p className="page-sub">Add, edit, or remove flights from the lookup database</p>
        {kaiaStatus && (
          <p className="page-sub" style={{ marginTop: 4 }}>
            Live schedule: {kaiaStatus.flights.toLocaleString()} flights
            {kaiaStatus.last
              ? <> · last synced {kaiaStatus.last.finished_at}
                  {kaiaStatus.last.ok ? '' : ` (${kaiaStatus.last.days_failed} day(s) failed)`}</>
              : ' · not synced yet'}
          </p>
        )}
      </div>

      <PendingAirlines
        rows={pending}
        onDone={loadPending}
      />

      {/* ── Add / Edit Form */}
      <div className="form-card">
        <h2 className="section-title">{editKey ? `Editing ${editKey}` : 'Add / Update Flight'}</h2>

        <form onSubmit={handleSave}>
          <div className="field-grid">
            <div className="field">
              <label className="field-label">Flight Number <span className="req">*</span></label>
              <div className="lookup-row">
                <input
                  type="text" className="field-input" placeholder="e.g. SV309"
                  value={form.flight_number}
                  disabled={!!editKey}
                  onChange={e => { setForm(f => ({ ...f, flight_number: e.target.value.toUpperCase() })); setLookupStatus('idle'); }}
                  onBlur={handleLookup}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleLookup())}
                />
                {!editKey && (
                  <button type="button" className="btn btn-lookup" onClick={handleLookup} disabled={lookupStatus === 'loading'}>
                    {lookupStatus === 'loading' ? '…' : 'Look up'}
                  </button>
                )}
                {lookupStatus === 'found'    && <span className="badge badge-found">Found</span>}
                {lookupStatus === 'notfound' && <span className="badge badge-notfound">Not in DB</span>}
              </div>
            </div>
            <div className="field">
              <label className="field-label">STD (e.g. 14:30)</label>
              <input type="text" className="field-input" placeholder="HH:MM"
                value={form.std} onChange={e => setForm(f => ({ ...f, std: e.target.value }))} />
            </div>
            <div className="field">
              <label className="field-label">Destination (IATA)</label>
              <input type="text" className="field-input" placeholder="e.g. CAI"
                value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value.toUpperCase() }))} />
            </div>
            <div className="field">
              <label className="field-label">City</label>
              <input type="text" className="field-input" placeholder="e.g. Cairo"
                value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            </div>
            <div className="field">
              <label className="field-label">Country</label>
              <input type="text" className="field-input" placeholder="e.g. Egypt"
                value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} />
            </div>
            <div className="field">
              <label className="field-label">Nationality (suggested)</label>
              <input type="text" className="field-input" placeholder="e.g. Egyptian"
                value={form.nationality} onChange={e => setForm(f => ({ ...f, nationality: e.target.value }))} />
            </div>
          </div>

          {error && <p style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : editKey ? 'Save Changes' : 'Add Flight'}
            </button>
            {editKey && (
              <>
                <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
                <button type="button" className="btn btn-danger" onClick={() => setConfirmDel(editKey)}>Delete</button>
              </>
            )}
          </div>
        </form>
      </div>

      {/* ── Custom flights list */}
      <div className="form-card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Custom Flights ({customs.filter(r => !r.deleted).length})
          </h2>
          <input
            className="field-input" style={{ width: 180, marginBottom: 0 }}
            placeholder="Search…"
            value={search} onChange={e => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        ) : filtered.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>
            {customs.length === 0 ? 'No custom flights yet. Add one above.' : 'No results.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="reports-table" style={{ fontSize: '0.88rem' }}>
              <thead>
                <tr>
                  <th>Flight</th><th>Dest</th><th>STD</th><th>City</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.flight_number} style={r.deleted ? { opacity: 0.4 } : {}}>
                    <td><strong>{r.flight_number}</strong></td>
                    <td>{r.destination || '—'}</td>
                    <td>{r.std || '—'}</td>
                    <td>{r.city || '—'}</td>
                    <td>
                      {r.deleted
                        ? <span style={{ color: 'var(--danger)' }}>Deleted</span>
                        : r.isOverride
                          ? <span style={{ color: 'var(--gold)' }}>Override</span>
                          : <span style={{ color: 'var(--success)' }}>Custom</span>}
                    </td>
                    <td>
                      {!r.deleted && (
                        <button className="btn btn-sm btn-secondary" onClick={() => startEdit(r)}>Edit</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Delete confirmation */}
      {confirmDel && (
        <div className="modal-overlay" onClick={() => setConfirmDel(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Delete {confirmDel}?</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
              {customs.find(r => r.flight_number === confirmDel)?.isOverride
                ? 'This will hide the flight from lookups. The original entry in the built-in database is not affected.'
                : 'This will remove the custom flight from the database.'}
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => handleDelete(confirmDel)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Airline codes KAIA reported that we have no approved name for.
//
// KAIA's own spelling is shown but never adopted automatically: analytics
// groups by the airline name, so "SAUDI ARABIAN AIRLINES" alongside "Saudia"
// would split one airline into two bars and lose its logo. Until a name is
// approved here, reports for the code keep an empty airline — exactly the
// behaviour before this feature existed.
function PendingAirlines({ rows, onDone }) {
  const [names, setNames]       = useState({});
  const [backfill, setBackfill] = useState({});
  const [busy, setBusy]         = useState(null);
  const [error, setError]       = useState('');

  if (!rows.length) return null;

  const nameFor = r => (names[r.code] ?? r.kaia_name ?? '');

  async function approve(r) {
    const name = nameFor(r).trim();
    if (!name) { setError(`Enter a name for ${r.code}.`); return; }
    setBusy(r.code); setError('');
    try {
      await approveAirline(r.code, name, !!backfill[r.code]);
      await onDone();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function ignore(r) {
    setBusy(r.code); setError('');
    try { await ignoreAirline(r.code); await onDone(); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }

  return (
    <div className="form-card">
      <h2 className="section-title">
        ✈ New airlines awaiting approval <span className="pending-count">{rows.length}</span>
      </h2>
      <p className="field-hint" style={{ marginBottom: 12 }}>
        Seen in the live schedule with no name set here. Their reports keep an empty
        airline until you approve one.
      </p>

      {error && <p className="login-error">{error}</p>}

      {rows.map(r => (
        <div key={r.code} className="pending-airline">
          <div className="pending-airline-head">
            <strong>{r.code}</strong>
            <span className="field-hint">
              {r.seen_count} flight{r.seen_count === 1 ? '' : 's'}
              {r.samples?.length ? ` · ${r.samples.join(', ')}` : ''}
            </span>
          </div>
          <div className="field-hint">KAIA calls it: {r.kaia_name || '—'}</div>
          <input
            className="field-input"
            value={nameFor(r)}
            placeholder="Name to use in reports and analytics"
            onChange={e => setNames(n => ({ ...n, [r.code]: e.target.value }))}
          />
          <label className="pending-airline-backfill">
            <input
              type="checkbox"
              checked={!!backfill[r.code]}
              onChange={e => setBackfill(b => ({ ...b, [r.code]: e.target.checked }))}
            />
            Also apply to existing reports with no airline
          </label>
          <div className="pending-airline-actions">
            <button type="button" className="btn btn-primary btn-sm"
              disabled={busy === r.code} onClick={() => approve(r)}>
              {busy === r.code ? 'Saving…' : 'Approve'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm"
              disabled={busy === r.code} onClick={() => ignore(r)}>
              Ignore
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
