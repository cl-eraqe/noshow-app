import { useEffect, useRef, useState } from 'react';

// Review queue for photos picked with "Choose File": each photo is shown with
// four handles already placed on the document's corners, the employee drags
// any that are off, and the document is cut out, squared up and evened out.
// A photo can also be kept as it is (a screenshot, an earlier scan) or
// removed, and "Crop all automatically" processes the rest in one go and then
// shows the results side by side, so the employee picks, per photo, the
// cropped version, the original, or neither.
//
// Everything happens on the phone. Nothing is uploaded until the report is
// saved, and a cut photo is re-encoded through a canvas, which also drops its
// EXIF data (GPS position included).

const DETECT_SIDE = 1280;    // handed to the worker, which shrinks it to 640 by area averaging
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
  const [detecting, setDetecting] = useState(false);  // no handles until they can be placed
  const [busy, setBusy] = useState('');                // '' or what is happening
  const [scannerState, setScannerState] = useState('loading');  // loading | ready | failed
  const [error, setError] = useState('');
  const [picks, setPicks] = useState(null);           // after "Crop all": [{ original, cropped, choice, ... }]
  const cameraRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let alive = true;
    scanner.ready.then(() => alive && setScannerState('ready'), () => alive && setScannerState('failed'));
    return () => { alive = false; };
  }, [scanner]);

  // Revoke object URLs whenever what they show is replaced or unmounted.
  useEffect(() => () => { if (current) URL.revokeObjectURL(current.url); }, [current]);
  const pickUrls = useRef([]);
  useEffect(() => () => pickUrls.current.forEach(u => URL.revokeObjectURL(u)), []);

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
      setDetecting(true);
      try {
        await scanner.ready;
        const found = await scanner.detect(toImageData(shown.img, DETECT_SIDE));
        if (!alive) return;
        setCorners(found ? found.corners : DEFAULT_CORNERS);
        setFound(!!found);
        setDetecting(false);
      } catch {
        if (alive) { setFound(false); setDetecting(false); }
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

  // Detect and cut every remaining photo, then show the results so the
  // employee chooses for each. A photo whose edges are not found has no
  // cropped version and starts on "Original".
  async function cropAll() {
    const out = [];
    for (let j = index; j < queue.length; j++) {
      setBusy(`Cropping ${j - index + 1} of ${queue.length - index}…`);
      const original = queue[j];
      let cropped = null, confident = false;
      try {
        const { img, url } = await loadImage(original);
        try {
          const found = await scanner.detect(toImageData(img, DETECT_SIDE));
          if (found) {
            cropped = await imageDataToFile(await scanner.warp(toImageData(img, WARP_SIDE), found.corners), croppedName(original));
            confident = found.confident;
          }
        } finally { URL.revokeObjectURL(url); }
      } catch { /* left without a cropped version */ }
      const urls = { original: URL.createObjectURL(original), cropped: cropped && URL.createObjectURL(cropped) };
      pickUrls.current.push(...Object.values(urls).filter(Boolean));
      // A crop the detector is unsure of starts on the original: it is only
      // used if the employee looks at it and picks it.
      out.push({ original, cropped, confident, urls, choice: cropped && confident ? 'cropped' : 'original' });
    }
    setBusy('');
    setPicks(out);
  }

  function setChoice(i, choice) {
    setPicks(ps => ps.map((p, j) => j === i ? { ...p, choice } : p));
  }

  function addPicks() {
    const chosen = picks.filter(p => p.choice !== 'removed').map(p => p.choice === 'cropped' ? p.cropped : p.original);
    setResults(r => [...r, ...chosen]);
    setPicks(null);
    setIndex(queue.length);
  }

  function keepAllAsTheyAre() {
    setResults(r => [...r, ...queue.slice(index)]);
    setIndex(queue.length);
  }

  function cancel() {
    if ((index > 0 || picks) && !window.confirm('Discard these photos?')) return;
    doneRef.current = true;
    onCancel();
  }

  if (index >= queue.length) return null;
  const remaining = queue.length - index;
  const ready = scannerState === 'ready';

  if (picks) {
    return <PageBrowser picks={picks} onChoice={setChoice} onAdd={addPicks} onCancel={cancel} />;
  }

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
            {detecting ? 'Finding the edges…'
              : found ? 'Drag the corners if they are not on the document.'
              : 'Edges not found — drag the four corners onto the document, or keep the photo as it is.'}
          </p>
        )}

        {current && (
          <CornerEditor img={current.img} url={current.url} corners={corners} onChange={setCorners}
            disabled={!ready || detecting || !!busy} outline={!detecting} />
        )}

        {busy ? (
          <p className="scanner-note">{busy}</p>
        ) : (
          <>
            <div className="scanner-actions">
              {scannerState !== 'failed' && (
                <button type="button" className="btn btn-primary" disabled={!ready || !current || detecting} onClick={crop}>✓ Crop</button>
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

// The results of "Crop all", one page at a time, in the manner of a scanner
// app's page view: swipe (or use the arrows) between pages, with the next and
// previous ones peeking in at the sides, and choose for the page on screen.
// A removed page stays in place, dimmed, so the numbering does not shift
// under the employee's finger, and can be restored.
function PageBrowser({ picks, onChoice, onAdd, onCancel }) {
  const trackRef = useRef(null);
  const [current, setCurrent] = useState(0);
  const count = picks.filter(p => p.choice !== 'removed').length;
  const page = picks[current];

  // The page on screen is the slide whose centre is nearest the track's centre.
  function onScroll() {
    const track = trackRef.current;
    if (!track) return;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = 0, bestDist = Infinity;
    [...track.children].forEach((el, i) => {
      const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setCurrent(best);
  }

  function go(i) {
    const el = trackRef.current?.children[i];
    if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  return (
    <div className="pb" role="dialog" aria-modal="true" aria-label="Review pages">
      <div className="pb-head">
        <button type="button" className="pb-icon" onClick={onCancel} aria-label="Cancel">✕</button>
        <strong>Review</strong>
        <span className="pb-icon-spacer" />
      </div>

      <div className="pb-track" ref={trackRef} onScroll={onScroll}>
        {picks.map((p, i) => (
          <div key={i} className={`pb-slide ${p.choice === 'removed' ? 'pb-slide-removed' : ''}`} onClick={() => go(i)}>
            <img src={p.choice === 'cropped' ? p.urls.cropped : p.urls.original} alt={`Page ${i + 1}`} draggable={false} />
            {p.choice === 'removed' && <span className="pb-badge">Removed</span>}
          </div>
        ))}
      </div>

      <div className="pb-counter">
        <button type="button" onClick={() => go(current - 1)} disabled={current === 0} aria-label="Previous page">◀</button>
        <span>{current + 1}/{picks.length}</span>
        <button type="button" onClick={() => go(current + 1)} disabled={current === picks.length - 1} aria-label="Next page">▶</button>
      </div>

      <div className="pb-controls">
        <div className="pb-options">
          {page.choice === 'removed' ? (
            <button type="button" className="pb-opt" onClick={() => onChoice(current, page.cropped && page.confident ? 'cropped' : 'original')}>↺ Restore</button>
          ) : (
            <>
              <button type="button" className={`pb-opt ${page.choice === 'cropped' ? 'pb-opt-on' : ''}`}
                disabled={!page.cropped} onClick={() => onChoice(current, 'cropped')}>Cropped</button>
              <button type="button" className={`pb-opt ${page.choice === 'original' ? 'pb-opt-on' : ''}`}
                onClick={() => onChoice(current, 'original')}>Original</button>
              <button type="button" className="pb-opt pb-opt-danger" onClick={() => onChoice(current, 'removed')}
                aria-label="Remove this page">🗑</button>
            </>
          )}
          {page.choice !== 'removed' && !page.cropped && <span className="pb-note">Edges not found</span>}
          {page.choice !== 'removed' && page.cropped && !page.confident && (
            <span className="pb-note">Not sure about the edges — check the cropped version before choosing it.</span>
          )}
        </div>
        <button type="button" className="pb-add" disabled={count === 0} onClick={onAdd}>
          ✓ Add {count} photo{count === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

// The photo with four draggable corner handles over it.
function CornerEditor({ img, url, corners, onChange, disabled, outline = true }) {
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
        {outline && <polygon points={pts.map(p => p.join(',')).join(' ')} className="scanner-poly" />}
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
