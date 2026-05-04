import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getExportTokens, createExportToken, revokeExportToken,
  rotateExportToken, deleteExportToken,
} from '../utils/api';

// Absolute origin — we need it embedded in the magic link
const API_ORIGIN = import.meta.env.VITE_API_URL || window.location.origin;

function buildLink(path, token) {
  return `${API_ORIGIN}${path}?token=${encodeURIComponent(token)}`;
}

export default function AccessManagement() {
  const navigate = useNavigate();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [email, setEmail]     = useState('');
  const [role, setRole]       = useState('view');
  const [newMagic, setNewMagic] = useState(null); // { email, liveStateUrl, auditLogUrl }

  async function reload() {
    setLoading(true);
    try { setTokens(await getExportTokens()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { reload(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!email.includes('@')) { setError('Valid email required'); return; }
    setError('');
    try {
      const row = await createExportToken(email.trim().toLowerCase(), role);
      setNewMagic({
        email: row.email,
        liveStateUrl: buildLink('/api/export/live-state', row.token),
        auditLogUrl:  buildLink('/api/export/audit-log',  row.token),
      });
      setEmail('');
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRevoke(id, revoked) {
    try {
      await revokeExportToken(id, !revoked);
      reload();
    } catch (e) { setError(e.message); }
  }

  async function handleRotate(id, emailLabel) {
    if (!window.confirm(`Rotate token for ${emailLabel}? The old link will stop working.`)) return;
    try {
      const row = await rotateExportToken(id);
      setNewMagic({
        email: row.email,
        liveStateUrl: buildLink('/api/export/live-state', row.token),
        auditLogUrl:  buildLink('/api/export/audit-log',  row.token),
      });
      reload();
    } catch (e) { setError(e.message); }
  }

  async function handleDelete(id, emailLabel) {
    if (!window.confirm(`Delete access for ${emailLabel}? This cannot be undone.`)) return;
    try {
      await deleteExportToken(id);
      reload();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="page access-page">
      <div className="page-header">
        <button className="btn-back" onClick={() => navigate('/dashboard')}>← Dashboard</button>
        <h1 className="page-title">Export Access Management</h1>
        <span className="supervisor-badge">Supervisor</span>
      </div>

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h2 className="chart-title">How it works</h2>
        <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.7 }}>
          Create a magic link for each person. They paste it into Excel → <strong>Data → Get Data → From Web</strong>.
          Excel refreshes the data every minute automatically.
          Two endpoints per user: <code>/live-state</code> (current reports) and <code>/audit-log</code> (all changes).
          Revoke or rotate any time if a link leaks.
        </p>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      <form className="token-form" onSubmit={handleCreate}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label">User Email</label>
          <input
            type="email" className="field-input" placeholder="person@company.com"
            value={email} onChange={e => setEmail(e.target.value)} required
          />
        </div>
        <div>
          <label className="field-label">Role</label>
          <select className="field-input" value={role} onChange={e => setRole(e.target.value)}>
            <option value="view">View only</option>
            <option value="analyst">Analyst</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary">+ Create Magic Link</button>
      </form>

      {newMagic && (
        <div className="magic-link-box">
          <div className="magic-link-title">
            🔑 Magic links for <strong>{newMagic.email}</strong> — copy now, they won't be shown again!
          </div>
          <label className="field-label">Live State (reports)</label>
          <code>{newMagic.liveStateUrl}</code>
          <button type="button" className="btn btn-xs btn-secondary"
            onClick={() => navigator.clipboard?.writeText(newMagic.liveStateUrl)}>Copy</button>
          <div style={{ height: 10 }}/>
          <label className="field-label">Audit Log</label>
          <code>{newMagic.auditLogUrl}</code>
          <button type="button" className="btn btn-xs btn-secondary"
            onClick={() => navigator.clipboard?.writeText(newMagic.auditLogUrl)}>Copy</button>
          <div className="hint">
            In Excel: <strong>Data → Get Data → From Web</strong> → paste URL → Load.
            Right-click table → <strong>Properties</strong> → enable "Refresh every 1 minute".
          </div>
          <button type="button" className="btn btn-xs btn-ghost" style={{ marginTop: 10 }}
            onClick={() => setNewMagic(null)}>Dismiss</button>
        </div>
      )}

      <div className="chart-card">
        <h2 className="chart-title">Active Access ({tokens.length})</h2>
        {loading ? (
          <div className="state-msg">Loading…</div>
        ) : tokens.length === 0 ? (
          <p className="no-data">No access granted yet. Create one above.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="token-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th>Last Used</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map(t => (
                  <tr key={t.id}>
                    <td><strong>{t.email}</strong></td>
                    <td><span className="badge badge-role">{t.role}</span></td>
                    <td>{(t.created_at || '').slice(0, 16)}</td>
                    <td>{t.last_used ? t.last_used.slice(0, 16) : '—'}</td>
                    <td>
                      <span className={`badge ${t.revoked ? 'badge-revoked' : 'badge-active'}`}>
                        {t.revoked ? 'Revoked' : 'Active'}
                      </span>
                    </td>
                    <td className="col-actions">
                      <button className="btn btn-xs btn-secondary"
                        onClick={() => handleRotate(t.id, t.email)}>Rotate</button>
                      <button className={`btn btn-xs ${t.revoked ? 'btn-confirm' : 'btn-secondary'}`}
                        onClick={() => handleRevoke(t.id, t.revoked)}>
                        {t.revoked ? 'Restore' : 'Revoke'}
                      </button>
                      <button className="btn btn-xs btn-danger"
                        onClick={() => handleDelete(t.id, t.email)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
