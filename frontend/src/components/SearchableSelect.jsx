import { useState, useRef, useEffect } from 'react';

export default function SearchableSelect({
  value, onChange, options = [], placeholder = 'Select…',
  required = false, className = '',
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef  = useRef(null);
  const searchRef = useRef(null);

  const filtered = query
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, []);

  function pick(opt) {
    onChange(opt);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={wrapRef} className={`ss-wrap ${className}`}>
      {/* hidden native input keeps browser form validation */}
      {required && (
        <input
          tabIndex={-1} required aria-hidden="true"
          style={{ opacity: 0, height: 0, position: 'absolute', pointerEvents: 'none' }}
          value={value} onChange={() => {}}
        />
      )}

      {/* Trigger */}
      <button
        type="button"
        className={`ss-trigger field-input ${!value ? 'ss-placeholder' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ss-value">{value || placeholder}</span>
        <span className="ss-arrow">{open ? '▲' : '▼'}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="ss-dropdown" role="listbox">
          <div className="ss-search-row">
            <svg className="ss-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="8.5" cy="8.5" r="5.5"/>
              <line x1="13" y1="13" x2="18" y2="18"/>
            </svg>
            <input
              ref={searchRef}
              className="ss-search-input"
              placeholder="Search…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" className="ss-clear" onClick={() => setQuery('')}>✕</button>
            )}
          </div>

          <div className="ss-list">
            {filtered.length === 0 ? (
              <div className="ss-empty">No results for "{query}"</div>
            ) : (
              filtered.map(opt => (
                <div
                  key={opt}
                  role="option"
                  aria-selected={opt === value}
                  className={`ss-option ${opt === value ? 'ss-selected' : ''}`}
                  onMouseDown={() => pick(opt)}
                >
                  {opt}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
