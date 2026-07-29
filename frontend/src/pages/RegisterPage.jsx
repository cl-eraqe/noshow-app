import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { checkInvite, registerUser } from '../utils/api';
import { saveRole, saveToken, saveUsername, saveOwnerTerminal } from '../utils/auth';

const PIN_RULES = 'At least 6 digits. No sequences (123456) or repeated digits (111111).';

export default function RegisterPage() {
  const [params]         = useSearchParams();
  const navigate          = useNavigate();
  const inviteToken       = params.get('token') || '';

  const [invite, setInvite]     = useState(null);   // { role, expiresAt }
  const [inviteErr, setInviteErr] = useState('');

  const [name, setName]   = useState('');
  const [pin, setPin]     = useState('');
  const [pin2, setPin2]   = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!inviteToken) { setInviteErr('No invite token found in link.'); return; }
    checkInvite(inviteToken)
      .then(setInvite)
      .catch(err => setInviteErr(err.message));
  }, [inviteToken]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!/^[A-Za-z ]{1,60}$/.test(name.trim())) {
      setError('Name must be English letters only (no numbers or symbols).');
      return;
    }
    if (!/^\d{6,}$/.test(pin)) {
      setError('PIN must be at least 6 digits.');
      return;
    }
    if (pin !== pin2) {
      setError('PINs do not match.');
      return;
    }
    setLoading(true);
    try {
      const data = await registerUser(inviteToken, name.trim(), pin);
      saveRole(data.role);
      saveToken(data.token);
      saveOwnerTerminal(data.ownerTerminal);
      saveUsername(data.username);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (inviteErr) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1 className="login-title">Invalid Invite</h1>
          <p className="login-error" style={{ textAlign: 'center' }}>{inviteErr}</p>
          <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--text-muted, #888)', fontSize: '0.9rem' }}>
            Ask your supervisor for a new invite link.
          </p>
        </div>
      </div>
    );
  }

  if (!invite) {
    return (
      <div className="login-screen">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <p>Validating invite…</p>
        </div>
      </div>
    );
  }

  const roleLabel = invite.role === 'supervisor' ? 'Supervisor' : 'Staff';
  const terminalLabel = invite.ownerTerminal === 'North' ? 'North Terminal' : invite.ownerTerminal === 'T1' ? 'Terminal 1' : null;

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <img src="/jedco-logo-en.png" alt="JEDCO" style={{ height: 64, width: 'auto', objectFit: 'contain' }} />
        </div>
        <h1 className="login-title">Create Account</h1>
        <p className="login-subtitle">
          You're registering as <strong>{roleLabel}</strong>
          {terminalLabel && <> · <strong>{terminalLabel}</strong></>}
        </p>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="field-label">Your Name (English)</label>
          <input
            type="text"
            autoComplete="name"
            className="pin-input"
            placeholder="e.g. Ahmed Ali"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={60}
            required
            autoFocus
          />

          <label className="field-label" style={{ marginTop: '0.75rem' }}>PIN (6+ digits)</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="new-password"
            className="pin-input"
            placeholder="Choose a PIN"
            value={pin}
            onChange={e => setPin(e.target.value)}
            maxLength={12}
            required
          />

          <label className="field-label" style={{ marginTop: '0.75rem' }}>Confirm PIN</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="new-password"
            className="pin-input"
            placeholder="Repeat PIN"
            value={pin2}
            onChange={e => setPin2(e.target.value)}
            maxLength={12}
            required
          />

          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted, #888)', marginTop: '0.4rem' }}>
            {PIN_RULES}
          </p>

          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading || !name.trim() || !pin || !pin2}
            style={{ marginTop: '1rem' }}
          >
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
