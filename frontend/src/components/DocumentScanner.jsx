import { useEffect, useRef, useState } from 'react';

// Review queue for photos picked with "Choose File": each photo is shown with
// four handles already placed on the document's corners, the employee drags
// any that are off, and the document is cut out, squared up and evened out.
// A photo can also be kept as it is (a screenshot, an earlier scan) or
// removed, and "Crop all automatically" processes the rest without review.
//
// Everything happens on the phone. Nothing is uploaded until the report is
// saved, and a cut photo is re-encoded through a canvas, which also drops its
// EXIF data (GPS position included).

const DETECT_SIDE = 640;     // detection does not need more, and runs faster
const WARP_SIDE   = 2000;    // input to the final cut
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

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); }
  catch (e) { URL.revokeObjectURL(url); throw e; }
  return { img, url };
}

const croppedName = file => `${file.name.replace(/\.[^.]+$/, '') || 'scan'}-cropped.jpg`;

/**
 * @param {File[]}   files     the photos to review
 * @param {object}   scanner   from createScanner(), already loading
 * @param {Function} onDone    receives the resulting files, in order
 * @param {Function} onCancel  nothing from this selection is added
 */
export default function DocumentScanner({ files, scanner, onDone, onCancel }) {
  const [queue, setQueue] = useState(files);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState([]);
  const [current, setCurrent] = useState(null);        // { img, url }
  const [corners, setCorners] = useState(DEFAULT_CORNERS);
  const [found, setFound] = useState(true);
  const [busy, setBusy] = useState('');                // '' or what is happening
  const [scannerState, setScannerState] = useState('loading');  // loading | ready | failed
  const [error, setError] = useState('');
  const cameraRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let alive = true;
    scanner.ready.then(() => alive && setScannerState('ready'), () => alive && setScannerState('failed'));
    return () => { alive = false; };
  }, [scanner]);

  // Revoke the shown photo's object URL whenever it is replaced or unmounted.
  useEffect(() => () => { if (current) URL.revokeObjectURL(current.url); }, [current]);

  // Show and analyse the current photo; past the end, hand the results back.
  // Keyed on the photo itself, not the queue, so adding a page with
  // "+ Page" does not reload the photo on screen and undo corner adjustments.
  const currentFile = index < queue.length ? queue[index] : null;
  useEffect(() => {
    if (!currentFile) {
      if (!doneRef.current) { doneRef.current = true; onDone(results); }
      return;
    }
    let alive = true;
    setError('');
    setCurrent(null);
    (async () => {
      let shown;
      try { shown = await loadImage(currentFile); }
      catch { if (alive) { setError('Could not read this photo — it will be added as it is.'); setFound(false); } return; }
      if (!alive) { URL.revokeObjectURL(shown.url); return; }
      setCurrent(shown);
      setCorners(DEFAULT_CORNERS);
      setFound(true);
      try {
        await scanner.ready;
        const c = await scanner.detect(toImageData(shown.img, DETECT_SIDE));
        if (!alive) return;
        setCorners(c || DEFAULT_CORNERS);
        setFound(!!c);
      } catch {
        if (alive) setFound(false);
      }
    })();
    return () => { alive = false; };
  }, [currentFile]);   // eslint-disable-line react-hooks/exhaustive-deps

  const next = add => {
    if (add) setResults(r => [...r, add]);
    setIndex(i => i + 1);
  };

  async function crop() {
    setBusy('Cropping…');
    try {
      const out = await scanner.warp(toImageData(current.img, WARP_SIDE), corners);
      next(await imageDataToFile(out, croppedName(queue[index])));
    } catch (e) {
      setError(`Could not crop this photo: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  // Detect and cut every remaining photo with no review. A photo whose edges
  // are not found is kept as it is rather than cut along a guess.
  async function cropAll() {
    const out = [];
    for (let j = index; j < queue.length; j++) {
      setBusy(`Cropping ${j - index + 1} of ${queue.length - index}…`);
      try {
        const { img, url } = await loadImage(queue[j]);
        try {
          const c = await scanner.detect(toImageData(img, DETECT_SIDE));
          out.push(c ? await imageDataToFile(await scanner.warp(toImageData(img, WARP_SIDE), c), croppedName(queue[j])) : queue[j]);
        } finally { URL.revokeObjectURL(url); }
      } catch {
        out.push(queue[j]);
      }
    }
    setBusy('');
    setResults(r => [...r, ...out]);
    setIndex(queue.length);
  }

  function keepAllAsTheyAre() {
    setResults(r => [...r, ...queue.slice(index)]);
    setIndex(queue.length);
  }

  function cancel() {
    if (index > 0 && !window.confirm('Discard these photos?')) return;
    doneRef.current = true;
    onCancel();
  }

  if (index >= queue.length) return null;
  const remaining = queue.length - index;
  const ready = scannerState === 'ready';

  return (
    <div className="scanner-overlay" role="dialog" aria-modal="true" aria-label="Review photos">
      <div className="scanner-panel">
        <div className="scanner-head">
          <strong>Photo {index + 1} of {queue.length}</strong>
          <button type="button" className="btn btn-xs btn-secondary" onClick={cancel} disabled={!!busy}>✕</button>
        </div>

        {error && <p className="scanner-error">{error}</p>}

        {scannerState === 'failed' ? (
          <p className="scanner-note">The scanner could not load on this phone. Photos can be added as they are.</p>
        ) : !ready ? (
          <p className="scanner-note">Preparing scanner… (first time only)</p>
        ) : (
          <p className="scanner-hint">
            {found ? 'Drag the corners if they are not on the document.' : 'Edges not found — drag the four corners onto the document, or keep the photo as it is.'}
          </p>
        )}

        {current && (
          <CornerEditor img={current.img} url={current.url} corners={corners} onChange={setCorners}
            disabled={!ready || !!busy} />
        )}

        {busy ? (
          <p className="scanner-note">{busy}</p>
        ) : (
          <>
            <div className="scanner-actions">
              {scannerState !== 'failed' && (
                <button type="button" className="btn btn-primary" disabled={!ready || !current} onClick={crop}>✓ Crop</button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => next(queue[index])}>Keep as it is</button>
              <button type="button" className="btn btn-danger" onClick={() => next(null)} title="Remove this photo">🗑</button>
            </div>
            <div className="scanner-actions">
              <button type="button" className="btn btn-secondary" onClick={() => cameraRef.current.click()}>📷 + Page</button>
              {remaining > 1 && ready && (
                <button type="button" className="btn btn-secondary" onClick={cropAll}>Crop all automatically ({remaining})</button>
              )}
              {remaining > 1 && scannerState === 'failed' && (
                <button type="button" className="btn btn-secondary" onClick={keepAllAsTheyAre}>Add all as they are ({remaining})</button>
              )}
            </div>
          </>
        )}

        {/* Straight to the camera — no menu. The photo joins the end of this review. */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
          onChange={e => { const f = e.target.files[0]; if (f) setQueue(q => [...q, f]); e.target.value = ''; }} />
      </div>
    </div>
  );
}

// The photo with four draggable corner handles over it.
function CornerEditor({ img, url, corners, onChange, disabled }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const maxW = Math.min(window.innerWidth - 48, 560);
  const maxH = Math.round(window.innerHeight * 0.55);
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
        {!disabled && pts.map(([x, y], i) => (
          <g key={i}
            onPointerDown={e => {
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
