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
      self.postMessage({ id, ok: true, corners: detect(cv, image) });
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

// TL, TR, BR, BL — by the sum and difference of the coordinates.
function order(pts) {
  const bySum  = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

function polygonArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Run each edge strategy and keep the largest convex four-sided shape that
// covers a believable share of the frame. Several strategies, because a white
// A4 on a dark counter and a passport on a light desk fail in different ways.
// Whatever comes back is only a starting point — the employee drags the
// corners into place before anything is cut.
function detect(cv, image) {
  const w = image.width, h = image.height, frame = w * h;
  const minArea = frame * 0.15, maxArea = frame * 0.98;
  const mats = [];
  const keep = m => (mats.push(m), m);
  let best = null, bestArea = 0, fallback = null, fallbackArea = 0;

  try {
    const src  = keep(cv.matFromImageData(image));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const kernel = keep(cv.Mat.ones(5, 5, cv.CV_8U));

    const masks = [];
    for (const [lo, hi] of [[50, 150], [20, 80]]) {
      const edges = keep(new cv.Mat());
      cv.Canny(blur, edges, lo, hi);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
      cv.dilate(edges, edges, kernel);
      masks.push(edges);
    }
    const otsu = keep(new cv.Mat());
    cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    masks.push(otsu);

    for (const mask of masks) {
      const contours = keep(new cv.MatVector());
      const hierarchy = keep(new cv.Mat());
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        try {
          const area = cv.contourArea(c);
          if (area < minArea || area > maxArea) continue;
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
              const pts = [];
              for (let k = 0; k < 4; k++) pts.push([approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
              const a = polygonArea(pts);
              if (a > bestArea) { bestArea = a; best = pts; }
            } else if (area > fallbackArea) {
              // Not a clean quadrilateral (a rounded passport corner, a thumb
              // over an edge): remember its tightest rotated rectangle.
              const rect = cv.minAreaRect(c);
              fallback = cv.RotatedRect.points(rect).map(p => [p.x, p.y]);
              fallbackArea = area;
            }
          } finally { approx.delete(); }
        } finally { c.delete(); }
      }
    }
  } finally {
    mats.forEach(m => m.delete());
  }

  const pts = best || fallback;
  if (!pts) return null;
  return order(pts).map(([x, y]) => [clamp01(x / w), clamp01(y / h)]);
}

const clamp01 = v => Math.min(1, Math.max(0, v));
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
