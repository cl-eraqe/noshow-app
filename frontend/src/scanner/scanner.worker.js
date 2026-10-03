// Document scanner worker: finds a document's four corners in a photo and
// flattens it. OpenCV lives only here.
//
// Why a worker:
//   - OpenCV is ~10 MB (≈2.3 MB compressed). Loading it inside a worker keeps
//     it out of the app bundle and off the main thread, so the page never
//     freezes while it compiles.
//   - Isolation. A worker has no DOM, no localStorage and no cookies of the
//     page, so this third-party code cannot reach the login token. vercel.json
//     also serves this file with a Content-Security-Policy that forbids any
//     network connection, so it cannot send an image anywhere either.
//
// Protocol (each request carries an id, echoed in the reply):
//   { type: 'detect', image: ImageData }            → { corners: [[x,y]×4] | null }
//   { type: 'warp',   image: ImageData, corners }   → { image: ImageData }
// Corners are normalised to 0..1 and ordered TL, TR, BR, BL.

import cvModule from '@techstark/opencv-js';
import { detectCorners } from './detect.js';

const MAX_SIDE = 4096;          // refuse anything larger: a malformed or huge
const MIN_SIDE = 16;            // image must not exhaust the phone's memory
const OUTPUT_MAX_SIDE = 1800;   // the PDF page is ~794×1123 px; more is waste

// The module object has a `then` that resolves to itself. Awaiting it, or
// passing it to resolve(), makes the promise adopt it and call that `then`
// again, forever — an endless microtask loop that freezes the worker. So it is
// only ever handed over wrapped in a plain object.
const cvReady = new Promise(resolve => {
  if (cvModule.Mat) resolve({ cv: cvModule });
  else cvModule.onRuntimeInitialized = () => resolve({ cv: cvModule });
});

cvReady.then(() => self.postMessage({ type: 'ready' }));

self.onmessage = async ({ data }) => {
  const { id, type } = data || {};
  try {
    const { cv } = await cvReady;
    const image = checkImage(data.image);
    if (type === 'detect') {
      self.postMessage({ id, ok: true, corners: detectCorners(cv, image) });
    } else if (type === 'warp') {
      const out = warp(cv, image, checkCorners(data.corners));
      self.postMessage({ id, ok: true, image: out }, [out.data.buffer]);
    } else {
      throw new Error(`unknown request: ${type}`);
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};

function checkImage(img) {
  const ok = img && img.data instanceof Uint8ClampedArray
    && Number.isInteger(img.width) && Number.isInteger(img.height)
    && img.width >= MIN_SIDE && img.height >= MIN_SIDE
    && img.width <= MAX_SIDE && img.height <= MAX_SIDE
    && img.data.length === img.width * img.height * 4;
  if (!ok) throw new Error('invalid image');
  return img;
}

function checkCorners(c) {
  const ok = Array.isArray(c) && c.length === 4 && c.every(p =>
    Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  if (!ok) throw new Error('invalid corners');
  return c;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Cut the document out along the four corners, square it up as if photographed
// from directly above, and even out the lighting. Colour is kept: passports
// and visas carry colour photos and stamps.
function warp(cv, image, corners) {
  const px = corners.map(([x, y]) => [x * image.width, y * image.height]);
  const [tl, tr, br, bl] = px;
  let outW = Math.max(dist(tl, tr), dist(bl, br));
  let outH = Math.max(dist(tl, bl), dist(tr, br));
  if (outW < MIN_SIDE || outH < MIN_SIDE) throw new Error('selection too small');
  const scale = Math.min(1, OUTPUT_MAX_SIDE / Math.max(outW, outH));
  outW = Math.round(outW * scale);
  outH = Math.round(outH * scale);

  const mats = [];
  const keep = m => (mats.push(m), m);
  try {
    const src = keep(cv.matFromImageData(image));
    const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, px.flat()));
    const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]));
    const M = keep(cv.getPerspectiveTransform(from, to));
    const flat = keep(new cv.Mat());
    cv.warpPerspective(src, flat, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    // Even out shadows and glare on lightness only, so colours stay true.
    const rgb = keep(new cv.Mat());
    cv.cvtColor(flat, rgb, cv.COLOR_RGBA2RGB);
    const lab = keep(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const planes = keep(new cv.MatVector());
    cv.split(lab, planes);
    const L = planes.get(0); mats.push(L);
    const clahe = new cv.CLAHE(1.5, new cv.Size(8, 8));
    try { clahe.apply(L, L); } finally { clahe.delete(); }
    planes.set(0, L);
    cv.merge(planes, lab);
    cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
    const out = keep(new cv.Mat());
    cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);

    return new ImageData(new Uint8ClampedArray(out.data), outW, outH);
  } finally {
    mats.forEach(m => m.delete());
  }
}
