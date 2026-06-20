import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAirlineBrands, uploadAirlineLogo, revertAirlineLogo } from '../utils/api';
import DEFAULTS from '../data/airline-brands.json';

export default function AirlineLogosPage() {
  const navigate = useNavigate();
  const [brands, setBrands]   = useState(DEFAULTS); // fall back to bundled defaults while loading
  const [loading, setLoading] = useState(true);
  const [busyIata, setBusy]   = useState(null);     // IATA currently uploading/reverting
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let cancelled = false;
    getAirlineBrands()
      .then(b => { if (!cancelled) setBrands(b); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function flash(msg) {
    setSuccess(msg);
    setError('');
    setTimeout(() => setSuccess(''), 2500);
  }

  async function handleUpload(name, brand, file) {
    if (!file) return;
    setError('');
    setBusy(brand.iata);
    try {
      const updated = await uploadAirlineLogo(brand.iata, file);
      setBrands(prev => ({ ...prev, [name]: { ...prev[name], ...updated } }));
      flash(`${name} logo updated.`);
    } catch (err) {
      setError(`${name}: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRevert(name, brand) {
    if (!brand.overridden) return;
    if (!confirm(`Revert ${name} to the default logo?`)) return;
    setError('');
    setBusy(brand.iata);
    try {
      await revertAirlineLogo(brand.iata);
      // Restore default from bundled JSON
      setBrands(prev => ({ ...prev, [name]: DEFAULTS[name] }));
      flash(`${name} reverted to default.`);
    } catch (err) {
      setError(`${name}: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: 880, margin: '0 auto', padding: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/dashboard')}>Back</button>
        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Airline Logos</h2>
      </div>

      <p style={{ color: 'var(--text-muted, #888)', fontSize: '0.88rem', marginTop: 0 }}>
        Upload a square logo image (PNG, JPEG, SVG, or WebP — max 5 MB). The system
        will automatically composite it onto the airline's brand color to generate
        the circular avatar used on the dashboard.
      </p>

      {loading && <p style={{ color: 'var(--text-muted, #888)' }}>Loading…</p>}
      {error && (
        <p style={{ color: '#b01a1a', background: '#fde8e8', padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.88rem' }}>
          {error}
        </p>
      )}
      {success && (
        <p style={{ color: '#1a8a3a', background: '#e6f9ec', padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.88rem' }}>
          {success}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
        {Object.entries(brands).map(([name, brand]) => (
          <AirlineRow
            key={brand.iata || name}
            name={name}
            brand={brand}
            busy={busyIata === brand.iata}
            onUpload={file => handleUpload(name, brand, file)}
            onRevert={() => handleRevert(name, brand)}
          />
        ))}
      </div>
    </div>
  );
}

function AirlineRow({ name, brand, busy, onUpload, onRevert }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);

  function pick() { fileRef.current?.click(); }

  function onChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPreview(URL.createObjectURL(f));
    onUpload(f);
    // Allow re-uploading the same file later
    e.target.value = '';
  }

  // Clean up the object URL after a moment to free memory
  useEffect(() => {
    if (!preview) return;
    const t = setTimeout(() => { URL.revokeObjectURL(preview); setPreview(null); }, 4000);
    return () => clearTimeout(t);
  }, [preview]);

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '0.85rem',
        padding: '0.65rem 0.85rem',
        borderRadius: 10,
        background: 'var(--bg-card, #fff)',
        border: '1px solid var(--border, #e0e0e0)',
      }}
    >
      <img
        src={preview || brand.avatar}
        alt=""
        width={40} height={40}
        style={{
          width: 40, height: 40, borderRadius: '50%', objectFit: 'cover',
          border: '1px solid rgba(0,0,0,0.08)',
          background: brand.avatarBg || brand.color,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{name}</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #888)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span>IATA <b>{brand.iata}</b></span>
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
            background: brand.color, border: '1px solid rgba(0,0,0,0.2)',
          }} title={brand.color} />
          <span>{brand.color}</span>
          {brand.overridden && (
            <span style={{
              fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 4,
              background: '#e8f4fd', color: '#1a6fb0',
            }}>Custom</span>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        style={{ display: 'none' }}
        onChange={onChange}
      />

      <button
        className="btn btn-primary btn-sm"
        onClick={pick}
        disabled={busy}
        style={{ fontSize: '0.78rem', padding: '0.3rem 0.7rem' }}
      >
        {busy ? 'Working…' : (brand.overridden ? 'Replace' : 'Upload')}
      </button>

      {brand.overridden && (
        <button
          className="btn btn-secondary btn-sm"
          onClick={onRevert}
          disabled={busy}
          style={{ fontSize: '0.78rem', padding: '0.3rem 0.7rem' }}
        >
          Revert
        </button>
      )}
    </div>
  );
}
