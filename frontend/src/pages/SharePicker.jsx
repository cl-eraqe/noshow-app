import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReports, attachFilesToReport, readSharedFiles } from '../utils/api';
import { getRole, isLoggedIn } from '../utils/auth';

function fmtDate(dt) {
  if (!dt) return '';
  const d = new Date(String(dt).replace(' ', 'T'));
  if (isNaN(d)) return '';
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${m[d.getMonth()]}`;
}

export default function SharePicker() {
  const navigate = useNavigate();
  const [files,    setFiles]    = useState([]);
  const [reports,  setReports]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [uploading, setUploading] = useState(null); // report id being uploaded to
  const [error,    setError]    = useState('');

  useEffect(() => {
    if (!isLoggedIn()) { navigate('/login'); return; }
    (async () => {
      try {
        const [shared, reps] = await Promise.all([readSharedFiles(), getReports()]);
        setFiles(shared);
        // Active reports first, newest first
        const active = reps
          .filter(r => r.status !== 'closed')
          .sort((a, b) => (b.id || 0) - (a.id || 0))
          .slice(0, 100);
        setReports(active);
        if (shared.length === 0) setError('No file received from share. Try sharing again from your scanner app.');
      } catch (e) {
        setError(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [navigate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter(r =>
      String(r.id).includes(q) ||
      (r.prev_flight || '').toLowerCase().includes(q) ||
      (r.new_flight  || '').toLowerCase().includes(q) ||
      (r.prev_destination || '').toLowerCase().includes(q) ||
      (r.new_destination  || '').toLowerCase().includes(q) ||
      (r.nationality || '').toLowerCase().includes(q) ||
      (r.pax_type || '').toLowerCase().includes(q)
    );
  }, [reports, search]);

  async function attachToReport(r) {
    if (uploading) return;
    setUploading(r.id);
    setError('');
    try {
      await attachFilesToReport(r.id, files, getRole());
      navigate(`/edit-report/${r.id}`);
    } catch (e) {
      setError(`Upload failed: ${e.message}`);
      setUploading(null);
    }
  }

  function createNew() {
    // Files stay in the SW cache; NewReport reads them via ?shared=1
    navigate('/new-report?shared=1');
  }

  return (
    <div className="page-wrap">
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Cancel</button>
        <h1 className="page-title">📎 Attach shared file</h1>
        <p className="page-sub">
          {files.length > 0
            ? `${files.length} file${files.length > 1 ? 's' : ''} ready: ${files.map(f => f.name).join(', ')}`
            : 'Waiting for shared files…'}
        </p>
      </div>

      {error && <p className="form-error" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="form-card">
        <button
          className="btn btn-primary btn-full"
          onClick={createNew}
          disabled={files.length === 0 || !!uploading}
          style={{ marginBottom: 16 }}
        >
          + Create new report with this file
        </button>

        <h2 className="section-title">Or attach to existing report</h2>
        <input
          className="field-input"
          placeholder="Search by ID, flight, destination, nationality..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading reports…</p>
        ) : filtered.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No matching active reports.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.map(r => {
              const isUploading = uploading === r.id;
              const dest = (r.new_destination || r.prev_destination || '').match(/\(([A-Z]{3})\)/)?.[1]
                || (r.new_destination || r.prev_destination || '');
              const flight = r.new_flight || r.prev_flight || '—';
              const dt     = r.new_datetime || r.prev_datetime;
              return (
                <li key={r.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '12px 8px', borderBottom: '1px solid var(--border, #eee)',
                    cursor: uploading ? 'default' : 'pointer',
                    opacity: uploading && !isUploading ? 0.4 : 1,
                  }}
                  onClick={() => !uploading && files.length > 0 && attachToReport(r)}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      #{r.id} &nbsp; {flight} → {dest || '—'}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {(r.pax_count || 1)} PAX • {r.pax_type || '—'} • {fmtDate(dt)}
                      {r.status === 'flight_confirmed' && ' • ✈ Confirmed'}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={uploading || files.length === 0}
                    onClick={e => { e.stopPropagation(); attachToReport(r); }}
                  >
                    {isUploading ? 'Uploading…' : 'Attach'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
