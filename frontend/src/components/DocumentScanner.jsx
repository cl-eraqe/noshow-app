import { useEffect, useRef, useState } from 'react';

// Photos picked with "Choose File" are all cropped automatically, then shown
// one page at a time, in the manner of a scanner app's page view:
//
//   ✕                               + Add      add a photo (camera or library)
//   [page, with 🗑 at its top left]           swipe between pages
//              ◀ 3/7 ▶
//   Retake        Left        Crop            per page
//   [            ✓ Attach 7 pages           ]
//
// Crop opens the page's corners — with a handle in the middle of each side
// that moves the whole side, and a magnifier under the finger — plus Left,
// Right, Auto Crop (back to the detected edges) and All (no crop).
//
// A page whose edges the detector is not sure of starts uncropped. Everything
// happens on the phone; nothing is uploaded until the report is saved, and
// every page is re-encoded through a canvas, which also drops the photo's
// EXIF data (GPS position included).

const DETECT_SIDE = 1280;   // handed to the worker, which shrinks it to 640 by area averaging
const WARP_SIDE   = 2000;   // input to the final cut
const OUT_SIDE    = 1800;   // an uncropped page is scaled to this; the PDF page needs less
const READY_TIMEOUT = 30000;
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

const isFull = c => c.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1e-6 && Math.abs(p[1] - FULL[i][1]) < 1e-6);
const clamp01 = v => Math.min(1, Math.max(0, v));

// TL, TR, BR, BL — by the sum and difference of the coordinates.
function order(pts) {
  const bySum  = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

// A point in the photo, seen on the photo turned clockwise by `rot` degrees.
function rotPt([x, y], rot) {
  if (rot === 90)  return [1 - y, x];
  if (rot === 180) return [1 - x, 1 - y];
  if (rot === 270) return [y, 1 - x];
  return [x, y];
}
function unrotPt([x, y], rot) {
  if (rot === 90)  return [y, 1 - x];
  if (rot === 180) return [1 - x, 1 - y];
  if (rot === 270) return [1 - y, x];
  return [x, y];
}

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
  return { img, url };
}

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

// `src` (an image or canvas) drawn turned clockwise by `rot`, at most `maxSide`.
function rotatedCanvas(src, rot, maxSide = Infinity) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const turned = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = turned ? h : w; canvas.height = turned ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  return canvas;
}

function canvasToFile(canvas, name) {
  return new Promise((resolve, reject) => canvas.toBlob(
    b => b ? resolve(new File([b], name, { type: 'image/jpeg' })) : reject(new Error('encode failed')),
    'image/jpeg', 0.9));
}

const pageName = file => `${file.name.replace(/\.[^.]+$/, '') || 'page'}-scan.jpg`;

/**
 * @param {File[]}   files     the photos picked
 * @param {object}   scanner   from createScanner(), already loading
 * @param {Function} onDone    receives the finished pages, in order
 * @param {Function} onCancel  nothing is added
 */
export default function DocumentScanner({ files, scanner, onDone, onCancel }) {
  const [pages, setPages] = useState([]);
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState('Preparing…');
  const [cropping, setCropping] = useState(null);    // the crop editor's state, or null
  const trackRef = useRef(null);
  const target = useRef(null);        // page a tap on ◀ ▶ is scrolling to
  const targetTimer = useRef(null);
  const retakeRef = useRef(null);
  const addRef = useRef(null);
  const urls = useRef(new Set());
  const nextKey = useRef(1);
  const scannerOk = useRef(true);

  useEffect(() => () => urls.current.forEach(u => URL.revokeObjectURL(u)), []);
  const track = url => (urls.current.add(url), url);
  const drop = url => { if (url) { URL.revokeObjectURL(url); urls.current.delete(url); } };

  async function ready() {
    if (!scannerOk.current) return false;
    try {
      await Promise.race([scanner.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), READY_TIMEOUT))]);
      return true;
    } catch { scannerOk.current = false; return false; }
  }

  // The page's final image: the photo cut along its corners (or whole), then turned.
  async function render(page) {
    const { img, url } = await loadImage(page.source);
    try {
      let flat = img;
      if (!isFull(page.corners) && await ready()) {
        const out = await scanner.warp(toImageData(img, WARP_SIDE), page.corners);
        flat = document.createElement('canvas');
        flat.width = out.width; flat.height = out.height;
        flat.getContext('2d').putImageData(out, 0, 0);
      }
      const file = await canvasToFile(rotatedCanvas(flat, page.rotation, OUT_SIDE), pageName(page.source));
      return { ...page, file, url: track(URL.createObjectURL(file)) };
    } finally { URL.revokeObjectURL(url); }
  }

  // A new photo: find its edges and crop it — or leave it whole when the
  // detector is not sure.
  async function makePage(source) {
    let detected = null;
    if (await ready()) {
      try {
        const { img, url } = await loadImage(source);
        try { detected = await scanner.detect(toImageData(img, DETECT_SIDE)); }
        finally { URL.revokeObjectURL(url); }
      } catch { /* no edges then */ }
    }
    const corners = detected && detected.confident ? detected.corners : FULL;
    return render({ key: nextKey.current++, source, detected, corners, rotation: 0 });
  }

  async function makePages(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(list.length > 1 ? `Cropping ${i + 1} of ${list.length}…` : 'Cropping…');
      try { out.push(await makePage(list[i])); } catch { /* unreadable photo: left out */ }
    }
    setBusy('');
    return out;
  }

  useEffect(() => {
    let alive = true;
    makePages(files).then(made => {
      if (!alive) return;
      if (!made.length) { onCancel(); return; }
      setPages(made);
    });
    return () => { alive = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // The page on screen is the slide whose centre is nearest the track's centre.
  function onScroll() {
    const t = trackRef.current;
    if (!t) return;
    const mid = t.scrollLeft + t.clientWidth / 2;
    let best = 0, bestDist = Infinity;
    [...t.children].forEach((el, i) => {
      const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    // While a tap's smooth scroll is under way, the pages it passes are not
    // "current" — otherwise a second quick tap would count from one of them.
    if (target.current !== null) {
      if (best !== target.current) return;
      target.current = null;
    }
    setCurrent(best);
  }
  function go(i) {
    const el = trackRef.current?.children[i];
    if (!el) return;
    target.current = i;
    setCurrent(i);
    clearTimeout(targetTimer.current);
    targetTimer.current = setTimeout(() => { target.current = null; }, 800);
    el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  function replace(i, page) {
    setPages(ps => ps.map((p, j) => { if (j === i && p !== page) drop(p.url); return j === i ? page : p; }));
  }

  async function retake(file) {
    if (!file) return;
    const i = current;
    setBusy('Cropping…');
    try { replace(i, await makePage(file)); } catch { /* keep the old page */ }
    setBusy('');
  }

  async function add(list) {
    if (!list.length) return;
    const made = await makePages(list);
    if (!made.length) return;
    const first = pages.length;
    setPages(ps => [...ps, ...made]);
    setTimeout(() => go(first), 50);
  }

  async function rotateLeft() {
    const i = current, page = pages[i];
    setBusy('Turning…');
    try { replace(i, await render({ ...page, rotation: (page.rotation + 270) % 360 })); } finally { setBusy(''); }
  }

  function remove(i) {
    const left = pages.filter((_, j) => j !== i);
    drop(pages[i].url);
    if (!left.length) { onCancel(); return; }
    setPages(left);
    setCurrent(c => Math.min(c, left.length - 1));
  }

  function cancel() {
    if (window.confirm('Discard these photos?')) onCancel();
  }

  // ── Crop editor ──
  async function openCrop() {
    const page = pages[current];
    const { img, url } = await loadImage(page.source);
    try {
      const view = rotatedCanvas(img, page.rotation, 1600);
      const blob = await new Promise(r => view.toBlob(r, 'image/jpeg', 0.85));
      setCropping({
        index: current, source: page.source, detected: page.detected, rotation: page.rotation,
        url: track(URL.createObjectURL(blob)), w: view.width, h: view.height,
        corners: order(page.corners.map(p => rotPt(p, page.rotation))),
      });
    } finally { URL.revokeObjectURL(url); }
  }

  async function turnCrop(dir) {          // -90 = left, +90 = right
    const c = cropping;
    const rotation = (c.rotation + dir + 360) % 360;
    const { img, url } = await loadImage(c.source);
    try {
      const view = rotatedCanvas(img, rotation, 1600);
      const blob = await new Promise(r => view.toBlob(r, 'image/jpeg', 0.85));
      drop(c.url);
      // The corners turn with the photo.
      const corners = order(c.corners.map(([x, y]) => dir > 0 ? [1 - y, x] : [y, 1 - x]));
      setCropping({ ...c, rotation, corners, url: track(URL.createObjectURL(blob)), w: view.width, h: view.height });
    } finally { URL.revokeObjectURL(url); }
  }

  async function applyCrop() {
    const c = cropping;
    const page = pages[c.index];
    const corners = order(c.corners.map(p => unrotPt(p, c.rotation)).map(([x, y]) => [clamp01(x), clamp01(y)]));
    setBusy('Cropping…');
    try {
      replace(c.index, await render({ ...page, corners, rotation: c.rotation }));
      drop(c.url);
      setCropping(null);
    } catch {
      window.alert('Could not crop this page.');
    } finally { setBusy(''); }
  }

  function closeCrop() {
    drop(cropping.url);
    setCropping(null);
  }

  // ── Screens ──
  if (cropping) {
    const c = cropping;
    return (
      <div className="pb" role="dialog" aria-modal="true" aria-label="Crop">
        <div className="pb-head">
          <button type="button" className="pb-icon" onClick={closeCrop} aria-label="Back">←</button>
          <strong>Crop</strong>
          <button type="button" className="pb-done" onClick={applyCrop} disabled={!!busy} aria-label="Done">✓</button>
        </div>
        <div className="pb-stage">
          <CornerEditor url={c.url} w={c.w} h={c.h} corners={c.corners}
            onChange={corners => setCropping(s => ({ ...s, corners }))} />
        </div>
        {busy && <p className="pb-busy">{busy}</p>}
        <div className="pb-tools">
          <Tool icon={<IconLeft />} label="Left" onClick={() => turnCrop(-90)} />
          <Tool icon={<IconRight />} label="Right" onClick={() => turnCrop(90)} />
          <Tool icon={<IconAuto />} label="Auto Crop" disabled={!c.detected}
            onClick={() => setCropping(s => ({ ...s, corners: order(s.detected.corners.map(p => rotPt(p, s.rotation))) }))} />
          <Tool icon={<IconAll />} label="All" onClick={() => setCropping(s => ({ ...s, corners: FULL }))} />
        </div>
      </div>
    );
  }

  if (!pages.length) {
    return (
      <div className="pb" role="dialog" aria-modal="true" aria-label="Preparing pages">
        <div className="pb-head"><span className="pb-icon-spacer" /><strong>Scan</strong><span className="pb-icon-spacer" /></div>
        <p className="pb-busy pb-busy-center">{busy || 'Preparing…'}</p>
      </div>
    );
  }

  return (
    <div className="pb" role="dialog" aria-modal="true" aria-label="Review pages">
      <div className="pb-head">
        <button type="button" className="pb-icon" onClick={cancel} aria-label="Cancel">✕</button>
        <strong>Review</strong>
        <button type="button" className="pb-text" onClick={() => addRef.current.click()} disabled={!!busy}>+ Add</button>
      </div>

      <div className="pb-track" ref={trackRef} onScroll={onScroll}>
        {pages.map((p, i) => (
          <div key={p.key} className="pb-slide" onClick={() => go(i)}>
            <span className="pb-page">
              <img src={p.url} alt={`Page ${i + 1}`} draggable={false} />
              <button type="button" className="pb-del" aria-label={`Delete page ${i + 1}`}
                onClick={e => { e.stopPropagation(); remove(i); }}><IconTrash /></button>
            </span>
          </div>
        ))}
      </div>

      <div className="pb-counter">
        <button type="button" onClick={() => go(current - 1)} disabled={current === 0} aria-label="Previous page">◀</button>
        <span>{current + 1}/{pages.length}</span>
        <button type="button" onClick={() => go(current + 1)} disabled={current >= pages.length - 1} aria-label="Next page">▶</button>
      </div>

      {busy && <p className="pb-busy">{busy}</p>}
      <div className="pb-tools">
        <Tool icon={<IconRetake />} label="Retake" disabled={!!busy} onClick={() => retakeRef.current.click()} />
        <Tool icon={<IconLeft />} label="Left" disabled={!!busy} onClick={rotateLeft} />
        <Tool icon={<IconCrop />} label="Crop" disabled={!!busy} onClick={openCrop} />
      </div>
      <div className="pb-bottom">
        <button type="button" className="pb-attach" disabled={!!busy} onClick={() => onDone(pages.map(p => p.file))}>
          ✓ Attach {pages.length} page{pages.length === 1 ? '' : 's'}
        </button>
      </div>

      {/* Retake: straight to the camera. + Add: iOS offers camera or library. */}
      <input ref={retakeRef} type="file" accept="image/*" capture="environment" hidden
        onChange={e => { retake(e.target.files[0]); e.target.value = ''; }} />
      <input ref={addRef} type="file" accept="image/*" multiple hidden
        onChange={e => { add(Array.from(e.target.files)); e.target.value = ''; }} />
    </div>
  );
}

function Tool({ icon, label, onClick, disabled }) {
  return (
    <button type="button" className="pb-tool" onClick={onClick} disabled={disabled}>
      {icon}<span>{label}</span>
    </button>
  );
}

// The photo with draggable corners, a handle in the middle of each side that
// moves the whole side, and a magnifier showing what is under the finger.
function CornerEditor({ url, w: natW, h: natH, corners, onChange }) {
  const svgRef = useRef(null);
  const drag = useRef(null);
  const [lens, setLens] = useState(null);       // { x, y } in px, while dragging
  const maxW = Math.min(window.innerWidth - 32, 560);
  const maxH = Math.round(window.innerHeight * 0.58);
  const scale = Math.min(maxW / natW, maxH / natH);
  const w = Math.round(natW * scale), h = Math.round(natH * scale);
  const pts = corners.map(([x, y]) => [x * w, y * h]);

  const at = e => {
    const r = svgRef.current.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };

  function start(e, kind, i) {
    drag.current = { kind, i, from: at(e), corners: corners.map(p => [...p]) };
    svgRef.current.setPointerCapture(e.pointerId);
    move(e);
  }

  function move(e) {
    const d = drag.current;
    if (!d) return;
    const [x, y] = at(e);
    const next = d.corners.map(p => [...p]);
    if (d.kind === 'corner') {
      next[d.i] = [x, y];
      setLens({ x: x * w, y: y * h });
    } else {
      // Move both ends of side i along its normal by how far the finger moved across it.
      const a = d.corners[d.i], b = d.corners[(d.i + 1) % 4];
      const sx = (b[0] - a[0]) * w, sy = (b[1] - a[1]) * h, len = Math.hypot(sx, sy) || 1;
      const nx = -sy / len, ny = sx / len;
      const off = (x - d.from[0]) * w * nx + (y - d.from[1]) * h * ny;
      next[d.i] = [clamp01(a[0] + nx * off / w), clamp01(a[1] + ny * off / h)];
      next[(d.i + 1) % 4] = [clamp01(b[0] + nx * off / w), clamp01(b[1] + ny * off / h)];
      setLens({ x: (next[d.i][0] + next[(d.i + 1) % 4][0]) / 2 * w, y: (next[d.i][1] + next[(d.i + 1) % 4][1]) / 2 * h });
    }
    onChange(next);
  }

  function end() { drag.current = null; setLens(null); }

  const L = 110, Z = 2.2;
  return (
    <div className="scanner-stage" style={{ width: w, height: h }}>
      <img src={url} width={w} height={h} alt="" draggable={false} />
      <svg ref={svgRef} width={w} height={h} className="scanner-svg"
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <polygon points={pts.map(p => p.join(',')).join(' ')} className="scanner-poly" />
        {pts.map(([x1, y1], i) => {
          const [x2, y2] = pts[(i + 1) % 4];
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
          return (
            <g key={`s${i}`} className="scanner-side" onPointerDown={e => start(e, 'side', i)}>
              <circle cx={mx} cy={my} r={22} className="scanner-hit" />
              <rect x={mx - 16} y={my - 6} width={32} height={12} rx={6}
                transform={`rotate(${ang} ${mx} ${my})`} className="scanner-pill" />
            </g>
          );
        })}
        {pts.map(([x, y], i) => (
          <g key={`c${i}`} onPointerDown={e => start(e, 'corner', i)}>
            <circle cx={x} cy={y} r={24} className="scanner-hit" />
            <circle cx={x} cy={y} r={11} className="scanner-handle" />
          </g>
        ))}
      </svg>
      {lens && (
        <div className="scanner-lens" style={{
          width: L, height: L,
          left: lens.x < w / 2 ? w - L - 6 : 6, top: 6,
          backgroundImage: `url(${url})`,
          backgroundSize: `${w * Z}px ${h * Z}px`,
          backgroundPosition: `${L / 2 - lens.x * Z}px ${L / 2 - lens.y * Z}px`,
        }} />
      )}
    </div>
  );
}

// ── Icons: plain white strokes ──
const svg = (children, size = 28) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconRetake = () => svg(<>
  <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><path d="M15 12.5a3 3 0 1 0-.9 2.1" /><path d="M15 10.5v2h-2" />
</>);
const IconLeft = () => svg(<>
  <rect x="4" y="11" width="10" height="9" rx="1.5" /><path d="M9 7h6a4 4 0 0 1 4 4v2" /><path d="M11 4.5 8.5 7 11 9.5" />
</>);
const IconRight = () => svg(<>
  <rect x="10" y="11" width="10" height="9" rx="1.5" /><path d="M15 7H9a4 4 0 0 0-4 4v2" /><path d="M13 4.5 15.5 7 13 9.5" />
</>);
const IconCrop = () => svg(<>
  <path d="M6 3v14h14" /><path d="M3 6h14v14" />
</>);
const IconAuto = () => svg(<>
  <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" /><path d="M9 15v-4a3 3 0 0 1 6 0v4" />
</>);
const IconAll = () => svg(<>
  <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /><path d="M4 4l5 5M20 4l-5 5M20 20l-5-5M4 20l5-5" />
</>);
const IconTrash = () => svg(<>
  <path d="M5 7h14" /><path d="M9 7V5h6v2" /><path d="M7 7l1 12h8l1-12" /><path d="M10.5 10.5v5M13.5 10.5v5" />
</>, 24);
