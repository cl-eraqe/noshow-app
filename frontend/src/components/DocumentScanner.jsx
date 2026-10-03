import { useEffect, useRef, useState } from 'react';
import { createScanner } from '../scanner/scannerClient';

// Photograph a document, place its four corners, and get it back cut out,
// squared up and evened out. Several pages can be taken in one go; they are
// handed back together, so the form merges them into one PDF.
//
// Everything happens on the phone. Nothing is uploaded until the report is
// saved, and the result is re-encoded through a canvas, which also drops the
// photo's EXIF data (GPS position included).

const DETECT_SIDE = 640;     // detection does not need more, and runs faster
const WARP_SIDE   = 2000;    // input to the final cut
const MAX_BYTES   = 30 * 1024 * 1024;
const DEFAULT_CORNERS = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];

function toImageData(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function imageDataToFile(data, name) {
  const canvas = document.createElement('canvas');
  canvas.width = data.width; canvas.height = data.height;
  canvas.getContext('2d').putImageData(data, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(
    b => b ? resolve(new File([b], name, { type: 'image/jpeg' })) : reject(new Error('encode failed')),
    'image/jpeg', 0.9));
}

export default function DocumentScanner({ onDone, onClose }) {
  const scannerRef = useRef(null);
  const urlsRef = useRef([]);
  const [scannerState, setScannerState] = useState('loading'); // loading | ready | failed
  const [step, setStep] = useState('capture');                 // capture | detecting | adjust | processing | failed
  const [photo, setPhoto] = useState(null);                    // { img, url, file }
  const [corners, setCorners] = useState(DEFAULT_CORNERS);
  const [found, setFound] = useState(true);
  const [pages, setPages] = useState([]);                      // [{ file, url }]
  const [error, setError] = useState('');
  const cameraRef = useRef(null);
  const libraryRef = useRef(null);

  // Start loading OpenCV the moment the scanner opens: by the time the photo
  // is taken it is usually ready.
  useEffect(() => {
    const s = createScanner();
    scannerRef.current = s;
    let alive = true;
    s.ready.then(() => alive && setScannerState('ready'), () => alive && setScannerState('failed'));
    const fail = setTimeout(() => alive && setScannerState(st => st === 'loading' ? 'failed' : st), 60000);
    return () => {
      alive = false;
      clearTimeout(fail);
      s.close();
      urlsRef.current.forEach(u => URL.revokeObjectURL(u));
    };
  }, []);

  function track(url) { urlsRef.current.push(url); return url; }

  async function pick(file) {
    setError('');
    if (!file) return;
    if (!/^image\//.test(file.type) || file.size > MAX_BYTES) {
      setError('Please choose a photo (under 30 MB).');
      return;
    }
    const url = track(URL.createObjectURL(file));
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { setError('Could not read that photo.'); return; }
    setPhoto({ img, url, file });
    setStep('detecting');
    try { await scannerRef.current.ready; } catch { setStep('failed'); return; }
    try {
      const c = await scannerRef.current.detect(toImageData(img, DETECT_SIDE));
      setCorners(c || DEFAULT_CORNERS);
      setFound(!!c);
    } catch {
      setCorners(DEFAULT_CORNERS);
      setFound(false);
    }
    setStep('adjust');
  }

  async function confirm() {
    setStep('processing');
    try {
      const out = await scannerRef.current.warp(toImageData(photo.img, WARP_SIDE), corners);
      const file = await imageDataToFile(out, `scan-${Date.now()}-p${pages.length + 1}.jpg`);
      setPages(p => [...p, { file, url: track(URL.createObjectURL(file)) }]);
      setPhoto(null);
      setStep('capture');
    } catch (e) {
      setError(`Could not process the photo: ${e.message}`);
      setStep('adjust');
    }
  }

  // If the scanner cannot load (very old phone, failed download), the photo
  // can still be added uncut rather than lost.
  function addUncut() {
    setPages(p => [...p, { file: photo.file, url: photo.url }]);
    setPhoto(null);
    setStep('capture');
  }

  function finish() {
    onDone(pages.map(p => p.file));
    onClose();
  }

  return (
    <div className="scanner-overlay" role="dialog" aria-modal="true" aria-label="Scan document">
      <div className="scanner-panel">
        <div className="scanner-head">
          <strong>📷 Scan document</strong>
          <button type="button" className="btn btn-xs btn-secondary" onClick={onClose}>✕</button>
        </div>

        {error && <p className="scanner-error">{error}</p>}

        {step === 'capture' && (
          <>
            {pages.length > 0 && (
              <div className="scanner-pages">
                {pages.map((p, i) => (
                  <div key={p.url} className="scanner-thumb">
                    <img src={p.url} alt={`Page ${i + 1}`} />
                    <button type="button" className="btn btn-xs btn-danger"
                      onClick={() => setPages(ps => ps.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <p className="scanner-hint">
              {pages.length === 0
                ? 'Lay the document on a darker surface and take the photo from above.'
                : `${pages.length} page${pages.length > 1 ? 's' : ''} — they will be saved as one PDF.`}
            </p>
            <div className="scanner-actions">
              <button type="button" className="btn btn-primary" onClick={() => cameraRef.current.click()}>
                📷 {pages.length ? 'Add page' : 'Take photo'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => libraryRef.current.click()}>
                🖼 From photos
              </button>
              {pages.length > 0 && (
                <button type="button" className="btn btn-success" onClick={finish}>✓ Done ({pages.length})</button>
              )}
            </div>
            {scannerState === 'loading' && <p className="scanner-note">Preparing scanner… (first time only)</p>}
            {scannerState === 'failed' && <p className="scanner-note">The scanner could not load. Photos will be added without cropping.</p>}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
              onChange={e => { pick(e.target.files[0]); e.target.value = ''; }} />
            <input ref={libraryRef} type="file" accept="image/*" hidden
              onChange={e => { pick(e.target.files[0]); e.target.value = ''; }} />
          </>
        )}

        {step === 'detecting' && (
          <p className="scanner-note">
            {scannerState === 'loading' ? 'Preparing scanner… (first time only)' : 'Finding the edges…'}
          </p>
        )}
        {(step === 'failed' || (step === 'detecting' && scannerState === 'failed')) && photo && (
          <>
            <p className="scanner-note">The scanner could not load on this phone.</p>
            <div className="scanner-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setPhoto(null); setStep('capture'); }}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={addUncut}>Add photo without cropping</button>
            </div>
          </>
        )}

        {(step === 'adjust' || step === 'processing') && photo && (
          <>
            <p className="scanner-hint">
              {found ? 'Drag the corners if they are not on the document.' : 'Edges not found — drag the four corners onto the document.'}
            </p>
            <CornerEditor img={photo.img} url={photo.url} corners={corners} onChange={setCorners}
              disabled={step === 'processing'} />
            <div className="scanner-actions">
              <button type="button" className="btn btn-secondary" disabled={step === 'processing'}
                onClick={() => { setPhoto(null); setStep('capture'); }}>↺ Retake</button>
              <button type="button" className="btn btn-secondary" disabled={step === 'processing'}
                onClick={() => setCorners([[0, 0], [1, 0], [1, 1], [0, 1]])}>Whole photo</button>
              <button type="button" className="btn btn-primary" disabled={step === 'processing'} onClick={confirm}>
                {step === 'processing' ? 'Processing…' : '✓ Use this'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// The photo with four draggable corner handles over it.
function CornerEditor({ img, url, corners, onChange, disabled }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const maxW = Math.min(window.innerWidth - 48, 560);
  const maxH = Math.round(window.innerHeight * 0.58);
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const pts = corners.map(([x, y]) => [x * w, y * h]);

  function move(e) {
    if (dragRef.current === null) return;
    const r = svgRef.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const next = corners.map(p => [...p]);
    next[dragRef.current] = [x, y];
    onChange(next);
  }

  return (
    <div className="scanner-stage" style={{ width: w, height: h }}>
      <img src={url} width={w} height={h} alt="" draggable={false} />
      <svg ref={svgRef} width={w} height={h} className="scanner-svg"
        onPointerMove={move}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}>
        <polygon points={pts.map(p => p.join(',')).join(' ')} className="scanner-poly" />
        {pts.map(([x, y], i) => (
          <g key={i}
            onPointerDown={e => {
              if (disabled) return;
              dragRef.current = i;
              svgRef.current.setPointerCapture(e.pointerId);
            }}>
            <circle cx={x} cy={y} r={24} className="scanner-hit" />
            <circle cx={x} cy={y} r={10} className="scanner-handle" />
          </g>
        ))}
      </svg>
    </div>
  );
}
