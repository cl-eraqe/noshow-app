import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getUsers, setUserActive, setUserTerminal,
  createInvite, getInvites, deleteInvite,
} from '../utils/api';

function terminalLabel(t) {
  return t === 'North' ? 'North Terminal' : t === 'T1' ? 'Terminal 1' : '—';
}

const BASE = import.meta.env.VITE_API_URL || window.location.origin;

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

export default function UsersPage() {
  const navigate = useNavigate();

  const [users, setUsers]     = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [copied, setCopied]   = useState('');

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

  async function toggleActive(user) {
    try {
      const updated = await setUserActive(user.id, !user.active);
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u));
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleCreateInvite(role, terminal) {
    try {
      const inv = await createInvite(role, terminal);
      await load(); // reload to get proper ids from DB
      const url = buildInviteUrl(inv.token);
      copyToClipboard(url);
      setCopied(inv.token);
      setTimeout(() => setCopied(''), 3000);
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleSetTerminal(user, terminal) {
    try {
      const updated = await setUserTerminal(user.id, terminal);
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...updated } : u));
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleDeleteInvite(id) {
    try {
      await deleteInvite(id);
      setInvites(prev => prev.filter(i => i.id !== id));
    } catch (e) {
      alert(e.message);
    }
  }

  function handleCopy(token) {
    copyToClipboard(buildInviteUrl(token));
    setCopied(token);
    setTimeout(() => setCopied(''), 3000);
  }

  return (
    <div className="page-container" style={{ maxWidth: 720, margin: '0 auto', padding: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/dashboard')}>
          Back
        </button>
        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>User Management</h2>
      </div>

      {err && <p style={{ color: 'red', marginBottom: '1rem' }}>{err}</p>}

      {/* ── Invite Links ─────────────────────────────────────────────────── */}
      <section style={{ marginBottom: '2rem' }}>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Invite Links</h3>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <button className="btn btn-primary btn-sm" onClick={() => handleCreateInvite('staff', 'T1')}>
            + Staff Invite · Terminal 1 (24h)
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => handleCreateInvite('staff', 'North')}>
            + Staff Invite · North Terminal (24h)
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => handleCreateInvite('supervisor')}>
            + Supervisor Invite (6h)
          </button>
        </div>

        {invites.length === 0 && !loading && (
          <p style={{ color: 'var(--text-muted, #888)', fontSize: '0.9rem' }}>No invite links yet.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {invites.map(inv => {
            const expired = isExpired(inv.expires_at);
            const url     = buildInviteUrl(inv.token);
            return (
              <div
                key={inv.token}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                  padding: '0.6rem 0.75rem',
                  borderRadius: 8,
                  background: expired || inv.used ? 'var(--bg-muted, #f5f5f5)' : 'var(--bg-card, #fff)',
                  border: '1px solid var(--border, #e0e0e0)',
                  opacity: expired || inv.used ? 0.6 : 1,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.85rem', minWidth: 80 }}>
                  {inv.role === 'supervisor' ? 'Supervisor' : 'Staff'}
                </span>
                {inv.role === 'staff' && (
                  <span style={{
                    fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: 4,
                    background: inv.owner_terminal === 'North' ? '#fdf1e0' : '#e8f4fd',
                    color: inv.owner_terminal === 'North' ? '#a85d00' : '#1a6fb0',
                  }}>
                    {terminalLabel(inv.owner_terminal)}
                  </span>
                )}
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted, #888)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {inv.used ? 'Used' : expired ? 'Expired' : `Expires ${formatExpiry(inv.expires_at)}`}
                </span>
                {!inv.used && !expired && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleCopy(inv.token)}
                    style={{ fontSize: '0.78rem', padding: '0.2rem 0.6rem' }}
                  >
                    {copied === inv.token ? 'Copied!' : 'Copy Link'}
                  </button>
                )}
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDeleteInvite(inv.id)}
                  style={{ fontSize: '0.78rem', padding: '0.2rem 0.6rem' }}
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Users ────────────────────────────────────────────────────────── */}
      <section>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
          Registered Users ({users.length})
        </h3>

        {loading && <p style={{ color: 'var(--text-muted, #888)' }}>Loading…</p>}

        {!loading && users.length === 0 && (
          <p style={{ color: 'var(--text-muted, #888)', fontSize: '0.9rem' }}>No users registered yet. Share an invite link to get started.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {users.map(user => (
            <div
              key={user.id}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
                padding: '0.6rem 0.75rem',
                borderRadius: 8,
                background: 'var(--bg-card, #fff)',
                border: '1px solid var(--border, #e0e0e0)',
                opacity: user.active ? 1 : 0.55,
              }}
            >
              <span style={{ fontWeight: 600, flex: 1, fontSize: '0.95rem' }}>{user.name}</span>
              <span style={{
                fontSize: '0.78rem', padding: '0.15rem 0.5rem', borderRadius: 4,
                background: user.role === 'supervisor' ? '#e8f4fd' : '#f0f0f0',
                color: user.role === 'supervisor' ? '#1a6fb0' : '#555',
              }}>
                {user.role === 'supervisor' ? 'Supervisor' : 'Staff'}
              </span>
              {user.role === 'staff' && (
                <div style={{ display: 'flex', gap: '0.3rem' }}>
                  {['T1', 'North'].map(t => (
                    <button
                      key={t}
                      className={`btn btn-sm ${user.owner_terminal === t ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ fontSize: '0.72rem', padding: '0.15rem 0.5rem' }}
                      onClick={() => handleSetTerminal(user, t)}
                      title={`Assign to ${terminalLabel(t)}`}
                    >
                      {t === 'North' ? 'North' : 'T1'}
                    </button>
                  ))}
                </div>
              )}
              <span style={{
                fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: 4,
                background: user.active ? '#e6f9ec' : '#fbe8e8',
                color: user.active ? '#1a8a3a' : '#b01a1a',
              }}>
                {user.active ? 'Active' : 'Inactive'}
              </span>
              <button
                className={`btn btn-sm ${user.active ? 'btn-danger' : 'btn-primary'}`}
                style={{ fontSize: '0.78rem', padding: '0.2rem 0.65rem' }}
                onClick={() => toggleActive(user)}
              >
                {user.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
