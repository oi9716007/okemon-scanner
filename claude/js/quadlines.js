// Okemon Scanner – egyenes-éleken alapuló kártya-négyszög keresés (tartalék / pontosító módszer).
// A színfolt-alapú keresés (háttér-elárasztás) elbukik, ha a kártyát kéz fogja: a kéz és a kar a kártyával egy folttá
// olvad, így a folt nem téglalap. Itt nem a folt alakját nézzük, hanem a kép egyenes éleit (orientált Hough-szavazás),
// és olyan négyszöget keresünk, amelynek oldalait az élek legalább részben (kitakarás mellett is) lefedik.
// Tiszta függvények, DOM nélkül: Web Workerben, fő szálon és tesztekben is futnak.
//
//   edgeField(rgba, w, h)            → { w, h, gray, dx, dy, mag, thr }
//   houghQuad(field)                 → { points:[tl,tr,br,bl], support, aspect, areaRatio, score } | null
//   quadSupport(field, points)       → { sides:[4 × 0..1], mean, top3 }   (élek általi lefedettség oldalanként)
const CARD_AR = 63 / 88;
const NT = 180;

export function edgeField(rgba, w, h) {
  const n = w * h;
  let g = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  // 3×3 átlagolás (zaj ellen)
  const t = new Float32Array(n), b = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; t[i] = (g[i - (x > 0 ? 1 : 0)] + g[i] + g[i + (x < w - 1 ? 1 : 0)]) / 3; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; b[i] = (t[i - (y > 0 ? w : 0)] + t[i] + t[i + (y < h - 1 ? w : 0)]) / 3; }
  const dx = new Float32Array(n), dy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (-b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1] + b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1]) / 4;
    const gy = (-b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1]) / 4;
    dx[i] = gx; dy[i] = gy; mag[i] = Math.hypot(gx, gy);
  }
  // küszöb: a gradiens-eloszlás 90. percentilise, de legalább 9 szürkeárnyalat-lépcső
  const hist = new Uint32Array(256); let cnt = 0;
  for (let i = 0; i < n; i++) { hist[Math.min(255, mag[i] | 0)]++; cnt++; }
  let acc = 0, p = 0; for (; p < 256; p++) { acc += hist[p]; if (acc >= cnt * 0.90) break; }
  return { w, h, gray: g, dx, dy, mag, thr: Math.max(9, p) };
}

function normDiff(a, b) { // két irány (π szerint körbeforgó) különbsége, 0..π/2
  let d = Math.abs(a - b) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d;
}

// egy szakasz mentén az élekkel való fedés (0..1): a pont ±2 px-en belül van-e a szakasszal párhuzamos él
export function quadSupport(F, pts) {
  const { w, h, dx, dy, mag, thr } = F;
  const sides = [];
  for (let s = 0; s < 4; s++) {
    const a = pts[s], c = pts[(s + 1) % 4];
    const L = Math.hypot(c.x - a.x, c.y - a.y);
    if (L < 6) { sides.push(0); continue; }
    const ang = Math.atan2(c.y - a.y, c.x - a.x) + Math.PI / 2; // az oldal normálisának iránya
    const nx = Math.cos(ang), ny = Math.sin(ang);
    const N = Math.max(12, Math.min(60, Math.round(L / 3)));
    let hit = 0, tot = 0;
    for (let k = 0; k < N; k++) {
      const u = 0.04 + 0.92 * (k + 0.5) / N;
      const px = a.x + (c.x - a.x) * u, py = a.y + (c.y - a.y) * u;
      if (px < 1 || py < 1 || px > w - 2 || py > h - 2) continue;
      tot++;
      let ok = false;
      for (let o = -2; o <= 2 && !ok; o++) {
        const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const i = y * w + x;
        if (mag[i] >= thr && normDiff(Math.atan2(dy[i], dx[i]), ang) < 0.44) ok = true; // ±25°
      }
      if (ok) hit++;
    }
    sides.push(tot ? hit / tot : 0);
  }
  const sorted = [...sides].sort((x, y) => y - x);
  return { sides, mean: sides.reduce((x, y) => x + y, 0) / 4, top3: (sorted[0] + sorted[1] + sorted[2]) / 3, third: sorted[2] };
}

function intersect(l1, l2) { // l: {th, rho}  x cos th + y sin th = rho
  const c1 = Math.cos(l1.th), s1 = Math.sin(l1.th), c2 = Math.cos(l2.th), s2 = Math.sin(l2.th);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 0.2) return null;
  return { x: (l1.rho * s2 - l2.rho * s1) / det, y: (c1 * l2.rho - c2 * l1.rho) / det };
}
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function polyArea(p) { let s = 0; for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; } return Math.abs(s) / 2; }

export function findPeaks(F, maxPeaks) {
  const { w, h, dx, dy, mag, thr } = F;
  const diag = Math.hypot(w, h), off = w + 2, R = Math.ceil(diag) + off + 2; // ρ ∈ [−w, átló]
  const acc = new Float32Array(NT * (R + 1));
  const cs = new Float32Array(NT), sn = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cs[t] = Math.cos(t * Math.PI / NT); sn[t] = Math.sin(t * Math.PI / NT); }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (mag[i] < thr) continue;
    let phi = Math.atan2(dy[i], dx[i]); if (phi < 0) phi += Math.PI; if (phi >= Math.PI) phi -= Math.PI;
    const t0 = Math.round(phi * NT / Math.PI);
    for (let dt = -2; dt <= 2; dt++) {
      const t = (t0 + dt + NT) % NT;
      // a (π-n túli) fordulásnál a ρ előjele átfordul: a t0+dt kívül esik [0,NT) -n, de ugyanaz az egyenes (th+π, -rho)
      const tu = t0 + dt, th = tu * Math.PI / NT;
      let rho = x * Math.cos(th) + y * Math.sin(th);
      if (tu < 0 || tu >= NT) rho = -rho; // (θ+π, −ρ) ugyanaz az egyenes
      const r = Math.round(rho) + off;
      if (r >= 0 && r <= R) acc[t * (R + 1) + r] += 1;
    }
  }
  // kisimítás ρ mentén és lokális maximumok (θ±5°, ρ±7 px)
  const minV = Math.max(12, Math.min(w, h) * 0.06);
  const peaks = [];
  for (let t = 0; t < NT; t++) for (let r = 1; r < R; r++) {
    const v = acc[t * (R + 1) + r - 1] + acc[t * (R + 1) + r] + acc[t * (R + 1) + r + 1];
    if (v < minV) continue;
    let isMax = true;
    for (let dt = -5; dt <= 5 && isMax; dt++) {
      const tt = (t + dt + NT) % NT;
      for (let dr = -7; dr <= 7; dr++) {
        if (!dt && !dr) continue;
        const rr = r + dr; if (rr < 1 || rr >= R) continue;
        const v2 = acc[tt * (R + 1) + rr - 1] + acc[tt * (R + 1) + rr] + acc[tt * (R + 1) + rr + 1];
        if (v2 > v || (v2 === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
      }
    }
    if (isMax) peaks.push({ th: t * Math.PI / NT, rho: r - off, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, maxPeaks);
}

// tetszőleges négyszög (pl. a színfolt-módszeré) pontszáma ugyanazzal a mércével, mint a Hough-jelölteké
export function scoreQuadPts(F, pts) {
  const { w, h } = F;
  const ar = polyArea(pts) / (w * h);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const sw = (d(pts[0], pts[1]) + d(pts[3], pts[2])) / 2, sh = (d(pts[0], pts[3]) + d(pts[1], pts[2])) / 2;
  if (!sw || !sh) return null;
  const aspect = Math.min(sw, sh) / Math.max(sw, sh);
  const sup = quadSupport(F, pts);
  const aspScore = 1 - Math.min(1, Math.abs(aspect - CARD_AR) / 0.25);
  return { score: (0.5 * sup.mean + 0.5 * sup.top3) * (0.55 + 0.45 * aspScore) * Math.sqrt(ar), support: sup.mean, third: sup.third, aspect, areaRatio: ar };
}

export function houghQuad(F, { maxPeaks = 40, scorer = null } = {}) {
  const { w, h } = F;
  const peaks = findPeaks(F, maxPeaks);
  if (peaks.length < 4) return null;
  const short = Math.min(w, h);
  // párhuzamos párok (egymástól legalább a rövidebb oldal 14%-ára)
  const pairs = [];
  for (let i = 0; i < peaks.length; i++) for (let j = i + 1; j < peaks.length; j++) {
    const a = peaks[i], b = peaks[j];
    if (normDiff(a.th, b.th) > 0.2) continue; // ~11°
    // ρ távolság: az irányokat azonos félsíkba hozzuk
    let ra = a.rho, rb = b.rho;
    if (Math.abs(a.th - b.th) > Math.PI / 2) rb = -rb;
    if (Math.abs(ra - rb) < short * 0.14) continue;
    pairs.push([a, b]);
  }
  let best = null;
  for (let p = 0; p < pairs.length; p++) for (let q = p + 1; q < pairs.length; q++) {
    const [a, b] = pairs[p], [c, d] = pairs[q];
    const ang = normDiff(a.th, c.th);
    if (ang < 1.05) continue; // a két párhuzamos-család legalább ~60°-ot zár be
    const p1 = intersect(a, c), p2 = intersect(a, d), p3 = intersect(b, d), p4 = intersect(b, c);
    if (!p1 || !p2 || !p3 || !p4) continue;
    let pts = [p1, p2, p3, p4];
    // rendezés: a középpont körüli szög szerint, majd tl kezdéssel
    const cx = pts.reduce((s, v) => s + v.x, 0) / 4, cy = pts.reduce((s, v) => s + v.y, 0) / 4;
    pts.sort((u, v) => Math.atan2(u.y - cy, u.x - cx) - Math.atan2(v.y - cy, v.x - cx));
    // legyen tl: a legkisebb x+y
    let k0 = 0, sm = Infinity; pts.forEach((v, i) => { if (v.x + v.y < sm) { sm = v.x + v.y; k0 = i; } });
    pts = [0, 1, 2, 3].map(i => pts[(k0 + i) % 4]);
    // konvex és a kép (kis tűréssel) belsejében
    const z = [cross(pts[0], pts[1], pts[2]), cross(pts[1], pts[2], pts[3]), cross(pts[2], pts[3], pts[0]), cross(pts[3], pts[0], pts[1])];
    if (!(z.every(v => v > 0) || z.every(v => v < 0))) continue;
    const mx = w * 0.03, my = h * 0.03;
    if (pts.some(v => v.x < -mx || v.y < -my || v.x > w + mx || v.y > h + my)) continue;
    const area = polyArea(pts), ar = area / (w * h);
    if (ar < 0.07 || ar > 0.92) continue;
    const d01 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), d32 = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y);
    const d03 = Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y), d12 = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
    const sw = (d01 + d32) / 2, sh = (d03 + d12) / 2;
    const aspect = Math.min(sw, sh) / Math.max(sw, sh);
    if (aspect < 0.54 || aspect > 0.92) continue;
    // a szemközti oldalak aránya (perspektíva-torzítás korlátja)
    if (Math.max(d01, d32) / Math.min(d01, d32) > 1.6 || Math.max(d03, d12) / Math.min(d03, d12) > 1.6) continue;
    const sup = quadSupport(F, pts);
    if (sup.third < 0.45 || sup.mean < 0.42) continue;
    const aspScore = 1 - Math.min(1, Math.abs(aspect - CARD_AR) / 0.25);
    const score = scorer ? scorer(pts, sup, aspect, ar) : (0.5 * sup.mean + 0.5 * sup.top3) * (0.55 + 0.45 * aspScore) * Math.sqrt(ar);
    if (!best || score > best.score) best = { points: pts, support: sup.mean, top3: sup.top3, aspect, areaRatio: ar, score, sides: sup.sides };
  }
  return best;
}
