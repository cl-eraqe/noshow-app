import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../utils/api';
import { saveRole } from '../utils/auth';

export default function LoginPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { role } = await login(pin);
      saveRole(role);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message === 'Invalid PIN' ? 'Incorrect PIN. Please try again.' : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <img src="/jedco-logo-en.png" alt="JEDCO" style={{ height: 64, width: 'auto', objectFit: 'contain' }} />
        </div>
        <h1 className="login-title">No-Show App</h1>
        <p className="login-subtitle">JEDCO Terminal Operations<br />King Abdulaziz International Airport</p>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="field-label">Staff PIN</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="current-password"
            className="pin-input"
            placeholder="• • • • • •"
            value={pin}
            onChange={e => setPin(e.target.value)}
            maxLength={10}
            required
            autoFocus
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="btn btn-primary btn-full" disabled={loading || !pin}>
            {loading ? 'Verifying…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
