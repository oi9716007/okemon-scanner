// Kártya-négyszög keresése és perspektíva-korrekció.
// A függvények vásznon és ImageData-n is működnek (főszál és Web Worker).
const CARD_AR = 63 / 88;

export function makeCanvas(w, h) {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  if (typeof document === 'undefined') return new OffscreenCanvas(W, H);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return c;
}

function srcSize(src) {
  return {
    w: src.videoWidth || src.naturalWidth || src.width,
    h: src.videoHeight || src.naturalHeight || src.height,
  };
}

function canvasOf(src, w, h) {
  if (src.data && src.width && !src.getContext) return null;
  const c = makeCanvas(w, h);
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, w, h);
  return c;
}

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function quadArea(pts) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const p = pts[i], q = pts[(i + 1) % 4];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

function cornerAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d));
  return Math.acos(cos) * 180 / Math.PI;
}

function anglesOk(pts) {
  for (let i = 0; i < 4; i++) {
    const a = cornerAngle(pts[(i + 3) % 4], pts[i], pts[(i + 1) % 4]);
    if (a < 52 || a > 128) return false;
  }
  return true;
}

// Két oldal átlagos hossza → szélesség/magasság. A pontok: tl, tr, br, bl.
export function quadMetrics(pts) {
  const width = (dist(pts[0], pts[1]) + dist(pts[3], pts[2])) / 2;
  const height = (dist(pts[0], pts[3]) + dist(pts[1], pts[2])) / 2;
  return { width, height, aspect: height > 1 ? width / height : 0, area: quadArea(pts) };
}

function expandQuad(pts, k = 0.035) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  return pts.map(p => ({ x: cx + (p.x - cx) * (1 + k), y: cy + (p.y - cy) * (1 + k) }));
}

function scoreQuad(pts, blobArea, frameW, frameH) {
  if (!anglesOk(pts)) return null;
  const m = quadMetrics(pts);
  if (m.aspect < 0.52 || m.aspect > 0.96 || m.area < 80) return null;
  const areaRatio = m.area / (frameW * frameH);
  if (areaRatio < 0.10 || areaRatio > 0.94) return null;
  const rect = blobArea ? blobArea / m.area : 1;
  if (rect < 0.55 || rect > 1.35) return null;
  const aspectScore = 1 - Math.min(1, Math.abs(m.aspect - CARD_AR) / 0.30);
  const score = (0.25 + areaRatio) * Math.min(rect, 1) * (0.4 + 0.6 * aspectScore);
  return { points: pts, aspect: m.aspect, areaRatio, rectangularity: rect, score };
}

function dominantBorder(d, w, h) {
  const samp = [];
  const push = (x, y) => { const i = (y * w + x) * 4; samp.push([d[i], d[i + 1], d[i + 2]]); };
  const inset = 1;
  for (let x = 0; x < w; x += 2) { push(x, inset); push(x, h - 1 - inset); }
  for (let y = 0; y < h; y += 2) { push(inset, y); push(w - 1 - inset, y); }
  if (!samp.length) return { bg: [0, 0, 0], spread: 0 };
  // a keret domináns színe (8-as kvantálás): a kártya érhet egy-egy élt, a háttér akkor is többség
  const bins = new Map();
  for (const p of samp) {
    const k = (p[0] >> 3) + ',' + (p[1] >> 3) + ',' + (p[2] >> 3);
    const b = bins.get(k) || { n: 0, s: [0, 0, 0] };
    b.n++; b.s[0] += p[0]; b.s[1] += p[1]; b.s[2] += p[2];
    bins.set(k, b);
  }
  let best = null;
  for (const b of bins.values()) if (!best || b.n > best.n) best = b;
  const bg = best.s.map(v => v / best.n);
  let spread = 0;
  for (const p of samp) spread += Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);
  return { bg, spread: spread / samp.length, cover: best.n / samp.length };
}

function maskFrom(d, w, h, bg, thr, far) {
  const mask = new Uint8Array(w * h);
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const distC = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
    const on = far ? distC > thr : distC <= thr;
    if (on) { mask[y * w + x] = 1; n++; }
  }
  return { mask, n };
}

// 1 px-es zárás: vékony rés ne vágja ketté a lapot
function dilate(mask, w, h) {
  const o = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i]) { o[i] = 1; continue; }
    let on = false;
    for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) { on = true; break; }
    }
    if (on) o[i] = 1;
  }
  return o;
}

function components(mask, w, h, minArea) {
  const seen = new Uint8Array(mask.length);
  const qx = new Int32Array(mask.length);
  const qy = new Int32Array(mask.length);
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s0 = y * w + x;
    if (!mask[s0] || seen[s0]) continue;
    let qs = 0, qe = 0;
    qx[qe] = x; qy[qe] = y; qe++; seen[s0] = 1;
    let area = 0, minx = x, maxx = x, miny = y, maxy = y;
    let tlS = Infinity, brS = -Infinity, trD = -Infinity, blD = Infinity;
    let tl = s0, tr = s0, br = s0, bl = s0;
    while (qs < qe) {
      const cx = qx[qs], cy = qy[qs]; qs++;
      area++;
      const sum = cx + cy, dif = cx - cy;
      if (sum < tlS) { tlS = sum; tl = cy * w + cx; }
      if (sum > brS) { brS = sum; br = cy * w + cx; }
      if (dif > trD) { trD = dif; tr = cy * w + cx; }
      if (dif < blD) { blD = dif; bl = cy * w + cx; }
      if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
      if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
      if (cx > 0 && mask[cy * w + cx - 1] && !seen[cy * w + cx - 1]) { seen[cy * w + cx - 1] = 1; qx[qe] = cx - 1; qy[qe++] = cy; }
      if (cx + 1 < w && mask[cy * w + cx + 1] && !seen[cy * w + cx + 1]) { seen[cy * w + cx + 1] = 1; qx[qe] = cx + 1; qy[qe++] = cy; }
      if (cy > 0 && mask[(cy - 1) * w + cx] && !seen[(cy - 1) * w + cx]) { seen[(cy - 1) * w + cx] = 1; qx[qe] = cx; qy[qe++] = cy - 1; }
      if (cy + 1 < h && mask[(cy + 1) * w + cx] && !seen[(cy + 1) * w + cx]) { seen[(cy + 1) * w + cx] = 1; qx[qe] = cx; qy[qe++] = cy + 1; }
    }
    if (area >= minArea) out.push({ area, minx, maxx, miny, maxy, tl, tr, br, bl });
  }
  return out;
}

function ptOf(i, w) { return { x: i % w, y: (i / w) | 0 }; }

function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let xx = 0, xy = 0, yy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
}

function intersect(l1, l2) {
  const det = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(det) < 1e-4) return null;
  const qx = l2.px - l1.px, qy = l2.py - l1.py;
  const a = (qx * l2.dy - qy * l2.dx) / det;
  return { x: l1.px + a * l1.dx, y: l1.py + a * l1.dy };
}

function distToSeg(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-6) return dist(p, a);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

// A lekerekített sarok helyett a négy él egyenesének metszete.
function refineCorners(mask, w, h, rough) {
  const sides = [[], [], [], []];
  const minx = Math.max(0, Math.floor(Math.min(...rough.map(p => p.x))) - 2);
  const maxx = Math.min(w - 1, Math.ceil(Math.max(...rough.map(p => p.x))) + 2);
  const miny = Math.max(0, Math.floor(Math.min(...rough.map(p => p.y))) - 2);
  const maxy = Math.min(h - 1, Math.ceil(Math.max(...rough.map(p => p.y))) + 2);
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    const edge = (x === 0 || !mask[i - 1]) || (x === w - 1 || !mask[i + 1]) || (y === 0 || !mask[i - w]) || (y === h - 1 || !mask[i + w]);
    if (!edge) continue;
    const p = { x, y };
    let bi = 0, bd = Infinity;
    for (let s = 0; s < 4; s++) {
      const dd = distToSeg(p, rough[s], rough[(s + 1) % 4]);
      if (dd < bd) { bd = dd; bi = s; }
    }
    if (bd < 8) sides[bi].push(p);
  }
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const arr = sides[s];
    if (arr.length < 8) return null;
    arr.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const a0 = Math.floor(arr.length * 0.18), a1 = Math.ceil(arr.length * 0.82);
    const mid = arr.slice(a0, Math.max(a0 + 4, a1));
    if (mid.length < 4) return null;
    lines.push(fitLine(mid));
  }
  const corners = [];
  for (let s = 0; s < 4; s++) {
    const p = intersect(lines[(s + 3) % 4], lines[s]);
    if (!p) return null;
    corners.push(p);
  }
  return corners;
}

function bestFromMask(mask, w, h) {
  const minArea = w * h * 0.08;
  const comps = components(mask, w, h, minArea).sort((a, b) => b.area - a.area).slice(0, 4);
  let best = null;
  for (const c of comps) {
    const rough = [c.tl, c.tr, c.br, c.bl].map(i => ptOf(i, w));
    const refined = refineCorners(mask, w, h, rough) || rough;
    const scored = scoreQuad(refined, c.area, w, h) || scoreQuad(rough, c.area, w, h);
    if (scored && (!best || scored.score > best.score)) best = { ...scored, area: c.area };
  }
  return best;
}

export function detectQuadImageData(imageData) {
  const { width: w, height: h, data: d } = imageData;
  if (w < 30 || h < 30) return null;
  const { bg, spread } = dominantBorder(d, w, h);
  const thr = Math.max(32, spread * 2.1 + 12);
  const far = maskFrom(d, w, h, bg, thr, true);
  let best = null;
  if (far.n > w * h * 0.08 && far.n < w * h * 0.92) best = bestFromMask(dilate(far.mask, w, h), w, h);
  // ha a keret színéhez közeli folt a lap (a lap kitölti a keretet), a közeli maszkot is nézzük
  if (!best) {
    const near = maskFrom(d, w, h, bg, thr, false);
    if (near.n > w * h * 0.08 && near.n < w * h * 0.92) {
      const b2 = bestFromMask(dilate(near.mask, w, h), w, h);
      if (b2 && (!best || b2.score > best.score)) best = b2;
    }
  }
  if (!best) return null;
  const points = expandQuad(best.points, 0.03).map(p => ({
    x: Math.max(-2, Math.min(w + 1, p.x)),
    y: Math.max(-2, Math.min(h + 1, p.y)),
  }));
  const m = quadMetrics(points);
  return {
    points,
    aspect: m.aspect,
    areaRatio: m.area / (w * h),
    rectangularity: best.rectangularity,
    score: best.score,
  };
}

// Forrás: kép, vászon vagy videó. A négyszög a forrás saját képpontjaiban van.
export function detectCardQuad(src) {
  const { w: sw, h: sh } = srcSize(src);
  if (!sw || !sh) return null;
  const MAX = 360;
  const sc = MAX / Math.max(sw, sh);
  const w = Math.max(40, Math.round(sw * sc)), h = Math.max(40, Math.round(sh * sc));
  const c = canvasOf(src, w, h);
  if (!c) return null;
  const im = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const q = detectQuadImageData(im);
  if (!q) return null;
  const inv = 1 / sc;
  const points = q.points.map(p => ({ x: p.x * inv, y: p.y * inv }));
  const m = quadMetrics(points);
  return { points, aspect: m.aspect, areaRatio: m.area / (sw * sh), rectangularity: q.rectangularity, score: q.score };
}

// Laplace-szórás: alacsony = elmosódott. rect vagy quad opcionális (különben az egész kép).
export function laplacianVariance(src, region) {
  const { w: sw, h: sh } = srcSize(src);
  if (!sw || !sh) return 0;
  let x = 0, y = 0, rw = sw, rh = sh;
  if (region?.points) {
    x = Math.max(0, Math.min(...region.points.map(p => p.x)));
    y = Math.max(0, Math.min(...region.points.map(p => p.y)));
    rw = Math.min(sw, Math.max(...region.points.map(p => p.x))) - x;
    rh = Math.min(sh, Math.max(...region.points.map(p => p.y))) - y;
  } else if (region && region.w) { x = region.x; y = region.y; rw = region.w; rh = region.h; }
  const W = 160, H = Math.max(24, Math.round(W * rh / Math.max(1, rw)));
  const c = makeCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, x, y, Math.max(1, rw), Math.max(1, rh), 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  let n = 0, mean = 0, m2 = 0;
  for (let yy = 1; yy < H - 1; yy++) for (let xx = 1; xx < W - 1; xx++) {
    const i = yy * W + xx;
    const v = L[i - W] + L[i - 1] + L[i + 1] + L[i + W] - 4 * L[i];
    n++;
    const delta = v - mean; mean += delta / n; m2 += delta * (v - mean);
  }
  return n ? m2 / n : 0;
}

function solve3(m, v) {
  const a = m.map(r => r.slice());
  const b = v.slice();
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    [a[i], a[p]] = [a[p], a[i]]; [b[i], b[p]] = [b[p], b[i]];
    const piv = a[i][i] || 1e-12;
    for (let r = i + 1; r < 3; r++) {
      const f = a[r][i] / piv;
      for (let c = i; c < 3; c++) a[r][c] -= f * a[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < 3; c++) s -= a[i][c] * x[c];
    x[i] = s / (a[i][i] || 1e-12);
  }
  return x;
}

function affineMap(s0, s1, s2, d0, d1, d2) {
  const m = [[s0.x, s0.y, 1], [s1.x, s1.y, 1], [s2.x, s2.y, 1]];
  const X = solve3(m, [d0.x, d1.x, d2.x]);
  const Y = solve3(m, [d0.y, d1.y, d2.y]);
  return [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
}

function drawTri(g, src, s, d) {
  const [a, b, c, dd, e, f] = affineMap(s[0], s[1], s[2], d[0], d[1], d[2]);
  g.save();
  g.beginPath();
  g.moveTo(d[0].x, d[0].y); g.lineTo(d[1].x, d[1].y); g.lineTo(d[2].x, d[2].y); g.closePath();
  g.clip();
  g.setTransform(a, b, c, dd, e, f);
  g.drawImage(src, 0, 0);
  g.restore();
}

// A négyszöget kártya-arányú (63×88) vászonra vetíti. dw a kimenet szélessége.
export function warpCard(src, quad, dw = 720) {
  const dh = Math.round(dw * 88 / 63);
  const c = makeCanvas(dw, dh);
  const g = c.getContext('2d');
  const [tl, tr, br, bl] = quad.points;
  const D = [{ x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: dh }, { x: 0, y: dh }];
  drawTri(g, src, [tl, tr, br], [D[0], D[1], D[2]]);
  drawTri(g, src, [tl, br, bl], [D[0], D[2], D[3]]);
  return c;
}

// Két négyszög mennyire ugyanott van: 0 = egybeesik, 1 ≈ a lap méretével arrébb.
export function quadDelta(a, b) {
  if (!a?.points || !b?.points) return Infinity;
  let s = 0;
  for (let i = 0; i < 4; i++) s += dist(a.points[i], b.points[i]);
  const size = Math.max(40, (dist(a.points[0], a.points[1]) + dist(a.points[0], a.points[3])) / 2);
  return (s / 4) / size;
}

export function rectToQuad(r) {
  return {
    points: [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ],
    aspect: r.w / r.h,
    areaRatio: null,
    rectangularity: 1,
    score: 0,
  };
}
