// Okemon Scanner – olcsó „képaláírás” egy négyszög (a kártya vagy a vezetőkeret) tartalmáról.
// Cél: eldönteni, hogy a képen lévő lap UGYANAZ-e, mint az előbb, vagy másik lap került a kéz(ek) közé, anélkül, hogy a képkocka
// kiürülne. A négyszögön belüli rácsot mintavételezzük (perspektívától, mozgástól független), a fényességet normáljuk (expozíció),
// a távolság a legjobban egyező 80% cellából számolódik (egy-egy ujj takarása ne számítson új lapnak).
// Tiszta függvények, DOM nélkül.
const GW = 10, GH = 14;

export function quadSig(rgba, w, h, pts, { inset = 0.08 } = {}) {
  const vals = new Float32Array(GW * GH), ok = new Uint8Array(GW * GH);
  const [tl, tr, br, bl] = pts;
  let n = 0, s = 0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const u = inset + (1 - 2 * inset) * (i + 0.5) / GW, v = inset + (1 - 2 * inset) * (j + 0.5) / GH;
    const x = (tl.x * (1 - u) + tr.x * u) * (1 - v) + (bl.x * (1 - u) + br.x * u) * v;
    const y = (tl.y * (1 - u) + tr.y * u) * (1 - v) + (bl.y * (1 - u) + br.y * u) * v;
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
    let acc = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const o = ((yi + dy) * w + xi + dx) * 4; acc += rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114; }
    const k = j * GW + i; vals[k] = acc / 9; ok[k] = 1; n++; s += vals[k];
  }
  if (n < GW * GH * 0.5) return null;
  const mean = s / n; let v2 = 0;
  for (let k = 0; k < vals.length; k++) if (ok[k]) v2 += (vals[k] - mean) ** 2;
  const std = Math.sqrt(v2 / n);
  for (let k = 0; k < vals.length; k++) if (ok[k]) vals[k] = (vals[k] - mean) / (std || 1);
  return { vals, ok, std, mean };
}

// 0 = azonos, ~1+ = más kép. A legjobban egyező 80% cella átlagos eltérése.
export function sigDist(a, b, keep = 0.8) {
  if (!a || !b) return 1;
  const d = [];
  for (let k = 0; k < a.vals.length; k++) if (a.ok[k] && b.ok[k]) d.push(Math.abs(a.vals[k] - b.vals[k]));
  if (d.length < 20) return 1;
  d.sort((x, y) => x - y);
  const m = Math.max(1, Math.floor(d.length * keep));
  let s = 0; for (let i = 0; i < m; i++) s += d[i];
  return s / m;
}

// vezetőkeret (kártya-arányú téglalap) a megjelenített felületen; a videó normált koordinátáiban adja vissza
// view: a felület mérete (CSS px), video: a kép mérete; object-fit: cover leképezés
export function guideQuadNorm(viewW, viewH, vidW, vidH) {
  if (!viewW || !viewH || !vidW || !vidH) return null;
  const gh = Math.min(viewH * 0.60, viewW * 0.82 * 88 / 63), gw = gh * 63 / 88;
  const cx = viewW / 2, cy = viewH * 0.47;
  const s = Math.max(viewW / vidW, viewH / vidH), ox = (viewW - vidW * s) / 2, oy = (viewH - vidH * s) / 2;
  const P = (x, y) => ({ x: (x - ox) / s / vidW, y: (y - oy) / s / vidH });
  return [P(cx - gw / 2, cy - gh / 2), P(cx + gw / 2, cy - gh / 2), P(cx + gw / 2, cy + gh / 2), P(cx - gw / 2, cy + gh / 2)];
}
