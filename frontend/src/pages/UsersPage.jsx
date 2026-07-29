import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getUsers, setUserActive, setUserTerminal, deleteUser,
  createInvite, getInvites, deleteInvite,
} from '../utils/api';
import { getUsername } from '../utils/auth';

function terminalLabel(t) {
  return t === 'North' ? 'North Terminal' : t === 'T1' ? 'Terminal 1' : 'Unassigned';
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  });
}

function buildInviteUrl(token) {
  return `${window.location.origin}/register?token=${token}`;
}

function formatExpiry(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function isExpired(isoStr) {
  return new Date(isoStr) < new Date();
}

const TABS = [
  { key: 'T1',    label: 'Terminal 1' },
  { key: 'North', label: 'North Terminal' },
  { key: 'sup',   label: 'Supervisors' },
  { key: 'all',   label: 'All' },
];

export default function UsersPage() {
  const navigate = useNavigate();
  const me = getUsername();

  const [users, setUsers]     = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [copied, setCopied]   = useState('');
  const [tab, setTab]         = useState('T1');
  const [busyId, setBusyId]   = useState(null);
  // Single reusable confirmation dialog:
  // { title, message, confirmLabel, danger, onConfirm }
  const [confirmDialog, setConfirmDialog] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, inv] = await Promise.all([getUsers(), getInvites()]);
      setUsers(u);
      setInvites(inv);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => ({
    T1:    users.filter(u => u.role === 'staff' && u.owner_terminal === 'T1').length,
    North: users.filter(u => u.role === 'staff' && u.owner_terminal === 'North').length,
    sup:   users.filter(u => u.role === 'supervisor').length,
    all:   users.length,
  }), [users]);

  const visible = useMemo(() => {
    if (tab === 'all') return users;
    if (tab === 'sup') return users.filter(u => u.role === 'supervisor');
    return users.filter(u => u.role === 'staff' && u.owner_terminal === tab);
  }, [users, tab]);

  async function run(id, fn) {
    setBusyId(id);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusyId(null);
    }
  }

  function askToggleActive(user) {
    const turningOff = user.active;
    setConfirmDialog({
      title: turningOff ? 'Deactivate user?' : 'Reactivate user?',
      message: turningOff
        ? `${user.name} will be signed out and unable to log in until reactivated. Their existing reports are not affected.`
        : `${user.name} will be able to log in again.`,
      confirmLabel: turningOff ? 'Deactivate' : 'Reactivate',
      danger: turningOff,
      onConfirm: () => run(user.id, async () => {
        const updated = await setUserActive(user.id, !user.active);
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u));
      }),
    });
  }

  function askSetTerminal(user, terminal) {
    if (user.owner_terminal === terminal) return;
    setConfirmDialog({
      title: 'Change assigned terminal?',
      message: `Move ${user.name} from ${terminalLabel(user.owner_terminal)} to ${terminalLabel(terminal)}?\n\n`
             + `From now on their new reports will be filed under ${terminalLabel(terminal)}, and they will only see `
             + `that terminal's cases. Reports they already created keep their original terminal and are not moved.`,
      confirmLabel: `Move to ${terminalLabel(terminal)}`,
      danger: false,
      onConfirm: () => run(user.id, async () => {
        const updated = await setUserTerminal(user.id, terminal);
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u));
      }),
    });
  }

  function askDelete(user) {
    setConfirmDialog({
      title: 'Delete user permanently?',
      message: `${user.name} will be removed from the system and cannot log in again. `
             + `This cannot be undone.\n\nReports they submitted are kept — their name stays on past cases. `
             + `If you only want to block access, use Deactivate instead.`,
      confirmLabel: 'Delete permanently',
      danger: true,
      onConfirm: () => run(user.id, async () => {
        await deleteUser(user.id);
        setUsers(prev => prev.filter(u => u.id !== user.id));
      }),
    });
  }

  async function handleCreateInvite(role, terminal) {
    setErr('');
    try {
      const inv = await createInvite(role, terminal);
      await load(); // reload to get proper ids from DB
      copyToClipboard(buildInviteUrl(inv.token));
      setCopied(inv.token);
      setTimeout(() => setCopied(''), 3000);
    } catch (e) {
      setErr(e.message);
    }
  }

  async function handleDeleteInvite(id) {
    setErr('');
    try {
      await deleteInvite(id);
      setInvites(prev => prev.filter(i => i.id !== id));
    } catch (e) {
      setErr(e.message);
    }
  }

  function handleCopy(token) {
    copyToClipboard(buildInviteUrl(token));
    setCopied(token);
    setTimeout(() => setCopied(''), 3000);
  }

  return (
    <div className="um-page">
      <div className="um-header">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/dashboard')}>Back</button>
        <h2 className="um-title">User Management</h2>
      </div>

      {err && (
        <p style={{
          color: '#b01a1a', background: '#fbe8e8', padding: '0.6rem 0.8rem',
          borderRadius: 8, fontSize: '0.88rem', marginBottom: '1rem',
        }}>{err}</p>
      )}

      {/* ── Invite Links ─────────────────────────────────────────────────── */}
      <section style={{ marginBottom: '2rem' }}>
        <h3 className="um-section-title">Invite Links</h3>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
          <button className="btn btn-primary btn-sm" onClick={() => handleCreateInvite('staff', 'T1')}>
            + Staff · Terminal 1
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => handleCreateInvite('staff', 'North')}>
            + Staff · North Terminal
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => handleCreateInvite('supervisor')}>
            + Supervisor
          </button>
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.8rem' }}>
          Staff links expire in 24h, supervisor links in 6h. The link is copied to your clipboard automatically.
        </p>

        {invites.length === 0 && !loading && (
          <p className="um-empty">No invite links yet.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {invites.map(inv => {
            const expired = isExpired(inv.expires_at);
            const dead    = expired || inv.used;
            return (
              <div key={inv.token} className={`um-card ${dead ? 'inactive' : ''}`}>
                <div className="um-row">
                  <span className={`um-badge ${inv.role === 'supervisor' ? 'um-badge-sup' : 'um-badge-staff'}`}>
                    {inv.role === 'supervisor' ? 'Supervisor' : 'Staff'}
                  </span>
                  {inv.role === 'staff' && (
                    <span className={`um-badge ${inv.owner_terminal === 'North' ? 'um-badge-north' : 'um-badge-t1'}`}>
                      {terminalLabel(inv.owner_terminal)}
                    </span>
                  )}
                  <span style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {inv.used ? 'Used' : expired ? 'Expired' : `Expires ${formatExpiry(inv.expires_at)}`}
                  </span>
                  <div className="um-actions">
                    {!dead && (
                      <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(inv.token)}>
                        {copied === inv.token ? '✓ Copied' : 'Copy Link'}
                      </button>
                    )}
                    <button className="btn btn-danger-soft btn-sm" onClick={() => handleDeleteInvite(inv.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Users ────────────────────────────────────────────────────────── */}
      <section>
        <h3 className="um-section-title">Registered Users ({users.length})</h3>

        <div className="um-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`um-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <span className="um-tab-label">{t.label}</span>
              <span className="um-tab-count">{counts[t.key]}</span>
            </button>
          ))}
        </div>

        {loading && <p className="um-empty">Loading…</p>}

        {!loading && visible.length === 0 && (
          <p className="um-empty">
            {users.length === 0
              ? 'No users registered yet. Share an invite link to get started.'
              : `No users in ${TABS.find(t => t.key === tab)?.label}.`}
          </p>
        )}

        {visible.map(user => {
          const isSup  = user.role === 'supervisor';
          const isMe   = me && user.name.toLowerCase() === me.toLowerCase();
          const busy   = busyId === user.id;
          return (
            <div key={user.id} className={`um-card ${user.active ? '' : 'inactive'}`}>
              <div className="um-row">
                <span className="um-name">
                  {user.name}
                  {isMe && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (you)</span>}
                </span>
                <span className={`um-badge ${isSup ? 'um-badge-sup' : 'um-badge-staff'}`}>
                  {isSup ? 'Supervisor' : 'Staff'}
                </span>
                <span className={`um-badge ${user.active ? 'um-badge-active' : 'um-badge-inactive'}`}>
                  {user.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="um-row">
                {isSup ? (
                  <span className="um-field-label">Sees all terminals</span>
                ) : (
                  <>
                    <span className="um-field-label">Terminal</span>
                    <div className="um-seg">
                      {['T1', 'North'].map(t => (
                        <button
                          key={t}
                          className={`um-seg-btn ${user.owner_terminal === t ? 'active' : ''}`}
                          onClick={() => askSetTerminal(user, t)}
                          disabled={busy}
                          title={`Assign to ${terminalLabel(t)}`}
                        >
                          {t === 'North' ? 'North' : 'T1'}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="um-actions">
                  <button
                    className={`btn btn-sm ${user.active ? 'btn-secondary' : 'btn-primary'}`}
                    onClick={() => askToggleActive(user)}
                    disabled={busy}
                  >
                    {user.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button
                    className="btn btn-danger-soft btn-sm"
                    onClick={() => askDelete(user)}
                    disabled={busy || isMe}
                    title={isMe ? 'You cannot delete your own account' : 'Delete permanently'}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Confirmation dialog ──────────────────────────────────────────── */}
      {confirmDialog && (
        <div className="modal-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="modal-content" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">{confirmDialog.title}</h2>
            <p style={{ fontSize: '0.88rem', lineHeight: 1.5, whiteSpace: 'pre-line', margin: '0 0 1.2rem' }}>
              {confirmDialog.message}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDialog(null)}>
                Cancel
              </button>
              <button
                className={`btn btn-sm ${confirmDialog.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => { const fn = confirmDialog.onConfirm; setConfirmDialog(null); fn(); }}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
