// Finding a document's four corners in a photo. Kept apart from the worker
// so it can be measured against real photos outside the browser.
//
// `image` is an ImageData (or { data, width, height }). Returns four corners
// normalised to 0..1, ordered TL, TR, BR, BL — or null when no document is
// found, so the screen says so instead of offering a wrong outline.
//
// Real photos are hard in ways clean test images are not: a document held in
// the hand with a thumb over one edge, white paper on light granite or a white
// bag, a busy background, glare. So candidates come from two sources — closed
// outlines, and quadrilaterals built from pairs of long straight lines (which
// survive a thumb breaking one edge) — and each is scored by how much of its
// outline lies on real edges in the photo, side by side, with at most one
// weak side allowed. A shape stuck to the frame is never reported as found.
// Tuned on seven real airport photos: passports, boarding passes, visas.

const MIN_AREA = 0.08;      // of the frame
const MIN_SUPPORT = 0.45;   // share of the outline that must lie on real edges
const MAX_ANGLE_DEV = 35;   // degrees off square
const SUPPORT_SLACK = 7;    // px of tolerance, at detection size
const MAX_LINES = 24;       // longest straight lines kept per direction
const MIN_SCORE = 0.03;     // below this, report "not found" rather than guess

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

function maxAngleDeviation(q) {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const v1 = [p[0] - c[0], p[1] - c[1]], v2 = [n[0] - c[0], n[1] - c[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    worst = Math.max(worst, Math.abs(deg - 90));
  }
  return worst;
}

// Median of a single-channel Mat, from a sample of its pixels.
function median(mat) {
  const d = mat.data, s = [];
  for (let i = 0; i < d.length; i += 7) s.push(d[i]);
  s.sort((a, b) => a - b);
  return s[s.length >> 1];
}

function autoCanny(cv, src, dst) {
  const m = median(src);
  cv.Canny(src, dst, Math.max(5, 0.66 * m), Math.max(20, Math.min(255, 1.33 * m)));
}

// Share of each side's length that runs along an edge pixel, per side.
function sideSupport(edges, q) {
  const w = edges.cols, h = edges.rows, d = edges.data;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    const n = 60;
    let hit = 0;
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x1 + (x2 - x1) * k / n), y = Math.round(y1 + (y2 - y1) * k / n);
      if (x >= 0 && y >= 0 && x < w && y < h && d[y * w + x]) hit++;
    }
    out.push(hit / (n + 1));
  }
  return out;
}

// Convex, with no corner doubled up and no side shorter than `minSide`.
function wellFormed(q, minSide) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minSide) return false;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0) return false;
    if (sign === 0) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

function intersect(a, b) {
  const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-6) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

// Long straight segments, grouped into roughly horizontal and roughly
// vertical, with near-duplicates merged. A document's border shows up as four
// such lines even when a thumb breaks one of them, which no closed outline does.
function borderLines(cv, edges, w, h) {
  const minDim = Math.min(w, h);
  const lines = new cv.Mat();
  const segs = [];
  try {
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 50, minDim * 0.18, minDim * 0.04);
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
      const len = Math.hypot(x2 - x1, y2 - y1);
      let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI; if (ang < 0) ang += 180;
      // distance of the line from the image centre, signed, for merging
      const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
      const rho = (x1 - w / 2) * nx + (y1 - h / 2) * ny;
      segs.push({ l: [x1, y1, x2, y2], len, ang, rho });
    }
  } finally { lines.delete(); }
  segs.sort((a, b) => b.len - a.len);
  const groups = { h: [], v: [] };
  for (const s of segs) {
    const g = (s.ang < 45 || s.ang > 135) ? groups.h : groups.v;
    const dup = g.find(o => {
      let da = Math.abs(o.ang - s.ang); da = Math.min(da, 180 - da);
      return da < 6 && Math.abs(Math.abs(o.rho) - Math.abs(s.rho)) < minDim * 0.025;
    });
    if (!dup && g.length < MAX_LINES) g.push(s);
  }
  return groups;
}

// Detection runs at this size. The downscale happens here, by area averaging,
// rather than by the browser's canvas: a canvas shrinks by sampling, which
// leaves noise and fine texture (granite, carpet) behind as false edges, and
// differs between browsers. Done here, the phone and the test bench see the
// same pixels.
const DETECT_SIDE = 640;

function downscale(cv, image) {
  const s = DETECT_SIDE / Math.max(image.width, image.height);
  if (s >= 1) return image;
  const src = cv.matFromImageData(image), dst = new cv.Mat();
  try {
    cv.resize(src, dst, new cv.Size(Math.round(image.width * s), Math.round(image.height * s)), 0, 0, cv.INTER_AREA);
    return { data: new Uint8ClampedArray(dst.data), width: dst.cols, height: dst.rows };
  } finally { src.delete(); dst.delete(); }
}

export function detectCorners(cv, input) {
  const image = downscale(cv, input);
  const found = edgeDetect(cv, image);
  if (found) return found;
  const fallback = outlineDetect(cv, image);
  // Never the frame itself: that is "not found" wearing a disguise.
  if (!fallback) return null;
  const onBorder = fallback.filter(([x, y]) => x < 0.012 || x > 0.988 || y < 0.012 || y > 0.988).length;
  return onBorder >= 3 ? null : fallback;
}

function edgeDetect(cv, image) {
  const w = image.width, h = image.height, frame = w * h;
  const mats = [];
  const keep = m => (mats.push(m), m);
  const candidates = [];

  try {
    const src = keep(cv.matFromImageData(image));
    const rgb = keep(new cv.Mat()); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const gray = keep(new cv.Mat()); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const hsv = keep(new cv.Mat()); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const hsvPlanes = keep(new cv.MatVector()); cv.split(hsv, hsvPlanes);
    const sat = hsvPlanes.get(1); mats.push(sat);

    // Smooth away fine texture (granite, carpet, fabric) but keep long edges.
    const gS = keep(new cv.Mat()); cv.medianBlur(gray, gS, 7);
    const sS = keep(new cv.Mat()); cv.medianBlur(sat, sS, 7);

    const eGray = keep(new cv.Mat()); autoCanny(cv, gS, eGray);
    const eSat = keep(new cv.Mat()); autoCanny(cv, sS, eSat);
    const edges = keep(new cv.Mat()); cv.bitwise_or(eGray, eSat, edges);
    const k3 = keep(cv.Mat.ones(3, 3, cv.CV_8U));
    // A few pixels of slack: a real border is rarely exactly where a line fit
    // puts it (paper curl, blur, a downscaled photo).
    const edgesFat = keep(new cv.Mat()); cv.dilate(edges, edgesFat, keep(cv.Mat.ones(SUPPORT_SLACK, SUPPORT_SLACK, cv.CV_8U)));
    // Light smoothing keeps thin printed lines (a form's frame) for line finding;
    // texture rarely forms long straight segments, so it does little harm there.
    const gL = keep(new cv.Mat()); cv.GaussianBlur(gray, gL, new cv.Size(5, 5), 0);
    const eFine = keep(new cv.Mat()); autoCanny(cv, gL, eFine);

    // Shapes to consider: closed edge outlines, and bright / dark regions.
    const masks = [];
    const closed = keep(new cv.Mat());
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, keep(cv.Mat.ones(7, 7, cv.CV_8U)));
    masks.push(closed);
    const otsu = keep(new cv.Mat()); cv.threshold(gS, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); masks.push(otsu);
    const otsuInv = keep(new cv.Mat()); cv.bitwise_not(otsu, otsuInv); masks.push(otsuInv);
    // Paper: bright and colourless.
    const lowSat = keep(new cv.Mat()); cv.threshold(sS, lowSat, 40, 255, cv.THRESH_BINARY_INV);
    const bright = keep(new cv.Mat()); cv.threshold(gS, bright, median(gS), 255, cv.THRESH_BINARY);
    const paper = keep(new cv.Mat()); cv.bitwise_and(lowSat, bright, paper);
    cv.morphologyEx(paper, paper, cv.MORPH_OPEN, keep(cv.Mat.ones(9, 9, cv.CV_8U)));
    masks.push(paper);

    for (const mask of masks) {
      const contours = keep(new cv.MatVector());
      const hier = keep(new cv.Mat());
      cv.findContours(mask, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        try {
          if (cv.contourArea(c) < frame * MIN_AREA) continue;
          const hull = new cv.Mat();
          try {
            cv.convexHull(c, hull, false, true);
            const peri = cv.arcLength(hull, true);
            // Loosen the fit until the hull reduces to four corners.
            for (const eps of [0.02, 0.035, 0.05, 0.07, 0.09]) {
              const approx = new cv.Mat();
              try {
                cv.approxPolyDP(hull, approx, eps * peri, true);
                if (approx.rows === 4) {
                  const pts = [];
                  for (let k = 0; k < 4; k++) pts.push([approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
                  candidates.push(order(pts));
                  break;
                }
                if (approx.rows < 4) break;
              } finally { approx.delete(); }
            }
            // Also its tightest rotated rectangle, for rounded or occluded corners.
            const rect = cv.minAreaRect(hull);
            candidates.push(order(cv.RotatedRect.points(rect).map(p => [p.x, p.y])));
          } finally { hull.delete(); }
        } finally { c.delete(); }
      }
    }

    // Quadrilaterals from pairs of border lines.
    const thin = keep(new cv.Mat()); cv.bitwise_or(eGray, eSat, thin); cv.bitwise_or(thin, eFine, thin);
    const { h: hs, v: vs } = borderLines(cv, thin, w, h);
    const angDiff = (p, q) => { const d = Math.abs(p.ang - q.ang); return Math.min(d, 180 - d); };
    for (let a = 0; a < hs.length; a++) for (let b = a + 1; b < hs.length; b++) {
      if (angDiff(hs[a], hs[b]) > 20) continue;
      for (let c2 = 0; c2 < vs.length; c2++) for (let d2 = c2 + 1; d2 < vs.length; d2++) {
        if (angDiff(vs[c2], vs[d2]) > 20) continue;
        const pts = [intersect(hs[a].l, vs[c2].l), intersect(hs[a].l, vs[d2].l), intersect(hs[b].l, vs[c2].l), intersect(hs[b].l, vs[d2].l)];
        if (pts.some(p => !p || p[0] < -0.02 * w || p[0] > 1.02 * w || p[1] < -0.02 * h || p[1] > 1.02 * h)) continue;
        candidates.push(order(pts.map(([x, y]) => [Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y))])));
      }
    }

    // Score: lies on real edges, is roughly square-cornered, covers a believable
    // area, and is not just the frame itself.
    let best = null, bestScore = 0;
    const m = 0.012, minSide = Math.min(w, h) * 0.12;
    const evaluate = q => {
      const area = polygonArea(q) / frame;
      const onBorder = q.filter(([x, y]) => x < w * m || x > w * (1 - m) || y < h * m || y > h * (1 - m)).length;
      const dev = maxAngleDeviation(q);
      const sides = sideSupport(edgesFat, q);
      const sorted = [...sides].sort((a, b) => b - a);
      const sup = sides.reduce((a, b) => a + b, 0) / 4;
      const third = sorted[2];    // the weakest of the three best sides — one side may be under a thumb
      const ok = area >= MIN_AREA && onBorder < 3 && dev <= MAX_ANGLE_DEV && wellFormed(q, minSide)
        && sup >= MIN_SUPPORT && third >= 0.4;
      const score = ok ? sup * sup * third * area * (1 - dev / 60) * Math.pow(0.8, onBorder) : 0;
      return { q, area, onBorder, dev, sup, third, score };
    };
    const scored = candidates.map(evaluate);
    for (const c of scored) if (c.score > bestScore) { bestScore = c.score; best = c.q; }
    if (!best || bestScore < MIN_SCORE) return null;
    return best.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
  } finally {
    mats.forEach(mm => { try { mm.delete(); } catch { /* already freed */ } });
  }
}

// The first detector: largest clean four-sided outline, else the tightest
// rectangle around the largest shape. Kept as a fallback for a document that
// fills the frame, where the new one has no border to measure on one side.
function outlineDetect(cv, image) {
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
