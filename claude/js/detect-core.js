// Okemon Scanner – kártya-négyszög keresése és perspektíva-korrekció (tiszta függvények, DOM nélkül).
// Web Workerben (detect-worker.js) és a fő szálon / tesztekben is használható.
//
// detectQuad(rgba, w, h) → { quad: [tl, tr, br, bl] (0..1 arányban), area, ratio, sharp } | null
//   1) szürkeárnyalat + enyhe elmosás, 2) Sobel-élek, 3) a háttér elárasztása a kép széléről az éleken át nem jutva,
//   4) a legnagyobb körbezárt folt = a lap, 5) sarkok a szélső pontokból (x±y), 6) ellenőrzés: méret, oldalarány
//   (63×88 ≈ 0,716), kitöltöttség (négyszög-e). Tartalék: háttérszín-különbség alapú maszk.
// warpPerspective(src, sw, sh, quadPx, outW, outH) → Uint8ClampedArray (RGBA), bilineáris mintavétel.

import { edgeField, houghQuad, scoreQuadPts } from './quadlines.js';

const CARD_RATIO = 63 / 88;

function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  return g;
}
function boxBlur(src, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    tmp[i] = (src[i - (x > 0 ? 1 : 0)] + src[i] + src[i + (x < w - 1 ? 1 : 0)]) / 3;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    out[i] = (tmp[i - (y > 0 ? w : 0)] + tmp[i] + tmp[i + (y < h - 1 ? w : 0)]) / 3;
  }
  return out;
}
function sobel(g, w, h) {
  const m = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    m[i] = Math.abs(gx) + Math.abs(gy);
  }
  return m;
}
function percentile(arr, p) {
  const hist = new Uint32Array(1024); let n = 0;
  for (const v of arr) { hist[Math.min(1023, v | 0)]++; n++; }
  let acc = 0; const target = n * p;
  for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 1023;
}
function dilate(mask, w, h, r = 1) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) out[yy * w + xx] = 1; } }
  }
  return out;
}
// a háttér elárasztása a kép szélétől: csak nem-él pixeleken keresztül
function floodBackground(wall, w, h) {
  const bg = new Uint8Array(w * h), q = new Int32Array(w * h); let qh = 0, qt = 0;
  const push = i => { if (!bg[i] && !wall[i]) { bg[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  return bg;
}
// a legnagyobb összefüggő folt (mask = 1) adatai: terület, szélső pontok
function largestComponent(mask, w, h) {
  const lab = new Int32Array(w * h), q = new Int32Array(w * h);
  let best = null, id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s]) continue;
    id++; let qh = 0, qt = 0; q[qt++] = s; lab[s] = id;
    let area = 0, sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity, tl = 0, br = 0, tr = 0, bl = 0, touch = 0;
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i / w) | 0; area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch++;
      const sm = x + y, df = x - y;
      if (sm < sMin) { sMin = sm; tl = i; } if (sm > sMax) { sMax = sm; br = i; }
      if (df > dMax) { dMax = df; tr = i; } if (df < dMin) { dMin = df; bl = i; }
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && mask[j] && !lab[j]) { lab[j] = id; q[qt++] = j; }
    }
    if (!best || area > best.area) best = { area, touch, id, pts: [tl, tr, br, bl].map(i => ({ x: i % w, y: (i / w) | 0 })) };
  }
  if (best) { best.lab = lab; best.w = w; best.h = h; }
  return best;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const polyArea = p => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a.x * b.y - b.x * a.y; }, 0)) / 2;
function convex(p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-6) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}
// Sarkok pontosítása: a folt határpontjaira oldalanként egyenest illesztünk (a lekerekített sarkok kihagyásával),
// a sarkok a szomszédos egyenesek metszéspontjai. A szélsőpontos becslésnél pontosabb (ferde, lekerekített lapnál is).
function refineCorners(comp) {
  const { lab, id, w, h, pts } = comp;
  const bnd = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (lab[i] !== id) continue;
    if (lab[i - 1] !== id || lab[i + 1] !== id || lab[i - w] !== id || lab[i + w] !== id) bnd.push(x, y);
  }
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const a = pts[k], b = pts[(k + 1) % 4], L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 8) return null;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, tol = Math.max(2.5, L * 0.04);
    let n = 0, mx = 0, my = 0; const sel = [];
    for (let j = 0; j < bnd.length; j += 2) {
      const px = bnd[j] - a.x, py = bnd[j + 1] - a.y, t = px * ux + py * uy, d = Math.abs(px * uy - py * ux);
      if (t > L * 0.15 && t < L * 0.85 && d < tol) { sel.push(bnd[j], bnd[j + 1]); mx += bnd[j]; my += bnd[j + 1]; n++; }
    }
    if (n < 8) return null;
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let j = 0; j < sel.length; j += 2) { const dx = sel[j] - mx, dy = sel[j + 1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // fő irány (PCA)
    lines.push({ x: mx, y: my, dx: Math.cos(ang), dy: Math.sin(ang) });
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const l1 = lines[(k + 3) % 4], l2 = lines[k]; // a k. sarok: az előző és a k. oldal metszéspontja
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / den;
    const p = { x: l1.x + t * l1.dx, y: l1.y + t * l1.dy };
    if (Math.hypot(p.x - pts[k].x, p.y - pts[k].y) > Math.max(w, h) * 0.08) return null; // biztonsági korlát
    out.push(p);
  }
  return out;
}
function evaluate(comp, w, h) {
  if (!comp) return null;
  const q = refineCorners(comp) || comp.pts;
  if (!convex(q)) return null;
  const qa = polyArea(q), frac = qa / (w * h);
  if (frac < 0.07 || frac > 0.96) return null;
  const fill = comp.area / qa;
  if (fill < 0.82 || fill > 1.25) return null;                       // nem négyszög alakú folt
  if (comp.touch > (w + h) * 0.25) return null;                     // a kép szélébe olvad (háttér)
  const top = dist(q[0], q[1]), bot = dist(q[3], q[2]), left = dist(q[0], q[3]), right = dist(q[1], q[2]);
  const sw = (top + bot) / 2, sh = (left + right) / 2;
  const ratio = Math.min(sw, sh) / Math.max(sw, sh);
  if (ratio < 0.56 || ratio > 0.9) return null;                     // nem kártya-arány (63×88 ≈ 0,716)
  let quad = q;
  if (sw > sh) quad = [q[3], q[0], q[1], q[2]];                      // fekvő lap → álló kimenet
  return { quadPx: quad, area: frac, ratio, fill, score: 1 - Math.abs(ratio - CARD_RATIO) * 2 + Math.min(frac, 0.5) };
}
// élesség: Laplace-variancia a négyszög befoglaló téglalapjának belső részén
export function sharpness(g, w, h, quadPx) {
  const xs = quadPx.map(p => p.x), ys = quadPx.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.15;
  x0 = Math.max(1, Math.round(x0 + mx)); x1 = Math.min(w - 2, Math.round(x1 - mx)); y0 = Math.max(1, Math.round(y0 + my)); y1 = Math.min(h - 2, Math.round(y1 - my));
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    s += l; s2 += l * l; n++;
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

export function detectQuad(rgba, w, h) {
  const g0 = toGray(rgba, w, h);
  const g = boxBlur(boxBlur(g0, w, h), w, h);
  const mag = sobel(g, w, h);
  const T = Math.max(28, percentile(mag, 0.86));
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) edge[i] = mag[i] > T ? 1 : 0;
  const wall = dilate(edge, w, h, 1);
  const bg = floodBackground(wall, w, h);
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = bg[i] ? 0 : 1;
  let res = evaluate(largestComponent(fg, w, h), w, h);
  if (!res) {
    // tartalék: háttérszín-különbség (egyszínű asztal, gyenge kártyaszél)
    const border = [];
    for (let x = 0; x < w; x += 2) border.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y += 2) border.push(y * w, y * w + w - 1);
    const ch = k => border.map(i => rgba[i * 4 + k]).sort((a, b) => a - b)[border.length >> 1];
    const bgc = [ch(0), ch(1), ch(2)];
    const dev = border.reduce((s, i) => s + Math.hypot(rgba[i * 4] - bgc[0], rgba[i * 4 + 1] - bgc[1], rgba[i * 4 + 2] - bgc[2]), 0) / border.length;
    const thr = Math.max(40, dev * 2.5);
    const m = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < m.length; i += 4, j++) m[j] = Math.hypot(rgba[i] - bgc[0], rgba[i + 1] - bgc[1], rgba[i + 2] - bgc[2]) > thr ? 1 : 0;
    res = evaluate(largestComponent(dilate(m, w, h, 1), w, h), w, h);
  }
  if (res) res.via = 'folt';
  // ÚJ: egyenes-élek alapú keresés. A színfolt-módszer elbukik, ha a kártyát kéz fogja (kéz + kar + kártya = nem téglalap alakú folt),
  // és csonka négyszöget adhat, ha az ujjak takarják az éleket. A két jelölt közül az él-lefedettség szerint jobbat választjuk.
  let F = null, hq = null;
  try { F = edgeField(rgba, w, h); hq = houghQuad(F); } catch { hq = null; }
  // a színfolt-eredmény megbízható, ha a folt kitölti a négyszöget és lap-arányú (nincs kéz a folthoz tapadva): megtartjuk
  const blobTrusted = res && res.fill >= 0.93 && res.ratio > 0.64 && res.ratio < 0.80;
  if (hq && !blobTrusted) {
    let useHough = !res;
    if (res) { const sb = scoreQuadPts(F, res.quadPx); useHough = !sb || hq.score > sb.score * 1.08; }
    if (useHough) {
      const p = hq.points, d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const sw = (d(p[0], p[1]) + d(p[3], p[2])) / 2, sh = (d(p[0], p[3]) + d(p[1], p[2])) / 2;
      res = { quadPx: sw > sh ? [p[3], p[0], p[1], p[2]] : p, area: hq.areaRatio, ratio: hq.aspect, fill: 1, score: hq.score, via: 'élek', support: hq.support };
    }
  }
  if (!res) return null;
  res.sharp = sharpness(g0, w, h, res.quadPx);
  res.quad = res.quadPx.map(p => ({ x: p.x / w, y: p.y / h }));
  return res;
}

// egységnégyzet → négyszög homográfia (Heckbert); p: [tl, tr, br, bl]
function squareToQuad(p) {
  const [a0, a1, a2, a3] = p;
  const sx = a0.x - a1.x + a2.x - a3.x, sy = a0.y - a1.y + a2.y - a3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [a1.x - a0.x, a3.x - a0.x, a0.x, a1.y - a0.y, a3.y - a0.y, a0.y, 0, 0];
  const dx1 = a1.x - a2.x, dx2 = a3.x - a2.x, dy1 = a1.y - a2.y, dy2 = a3.y - a2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [a1.x - a0.x + g * a1.x, a3.x - a0.x + h * a3.x, a0.x, a1.y - a0.y + g * a1.y, a3.y - a0.y + h * a3.y, a0.y, g, h];
}
export function warpPerspective(src, sw, sh, quadPx, outW, outH) {
  const [a, b, c, d, e, f, g, h] = squareToQuad(quadPx);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW, den = g * u + h * v + 1;
      const fx = (a * u + b * v + c) / den, fy = (d * u + e * v + f) / den;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), o = (y * outW + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { out[o] = out[o + 1] = out[o + 2] = 128; out[o + 3] = 255; continue; }
      const tx = fx - x0, ty = fy - y0, i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let k = 0; k < 3; k++) out[o + k] = (src[i00 + k] * (1 - tx) + src[i10 + k] * tx) * (1 - ty) + (src[i01 + k] * (1 - tx) + src[i11 + k] * tx) * ty;
      out[o + 3] = 255;
    }
  }
  return out;
}

// Vezetőkeret-elvű kereső (tokban / fóliában tartott laphoz): a kivágásban a lap-arányú (63×88), a vezetőkerethez illeszkedő,
// élekkel jól alátámasztott négyszöget keresi. A tok / fólia külső (kicsit más arányú, nagyobb) kerete így nem nyer a lap belső széle felett.
// guide: a vezetőkeret négy sarka 0..1 arányban a képen. Visszaad: { quad (0..1), support, aspect, iou, score } | null
export function detectCardGuided(rgba, w, h, guide) {
  const F = edgeField(rgba, w, h);
  const gp = guide.map(p => ({ x: p.x * w, y: p.y * h }));
  const bb = pts => { const xs = pts.map(p => p.x), ys = pts.map(p => p.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const G = bb(gp), gA = (G[2] - G[0]) * (G[3] - G[1]);
  const iouOf = pts => {
    const A = bb(pts), iw = Math.min(A[2], G[2]) - Math.max(A[0], G[0]), ih = Math.min(A[3], G[3]) - Math.max(A[1], G[1]);
    if (iw <= 0 || ih <= 0) return 0;
    const inter = iw * ih; return inter / ((A[2] - A[0]) * (A[3] - A[1]) + gA - inter);
  };
  const scorer = (pts, sup, aspect) => {
    const iou = iouOf(pts); if (iou < 0.45) return 0;
    const asp = Math.exp(-(((aspect - 0.716) / 0.04) ** 2));
    return (0.5 * sup.mean + 0.5 * sup.top3) * asp * iou * iou;
  };
  const hq = houghQuad(F, { maxPeaks: 60, scorer });
  if (!hq || hq.score <= 0) return null;
  const iou = iouOf(hq.points);
  if (hq.support < 0.5 || Math.abs(hq.aspect - 0.716) > 0.07) return null;
  return { quad: hq.points.map(p => ({ x: p.x / w, y: p.y / h })), support: hq.support, aspect: hq.aspect, iou, score: hq.score };
}
