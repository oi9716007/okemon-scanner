// Okemon Scanner – lapfelismerés: kártya kivágása → OCR (név + gyűjtői szám/szettkód) → képi ujjlenyomat.
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
export const CW = 900, CH = 1257; // normalizált kártyaméret (63×88 mm arány)

let tessP = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tessP) return tessP;
  tessP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TESS_URL; s.async = true;
    s.onload = () => res(window.Tesseract);
    s.onerror = () => { tessP = null; rej(new Error('Az OCR-motor (Tesseract.js) nem töltődött be – van internet?')); };
    document.head.appendChild(s);
  });
  return tessP;
}
const workers = {};
async function worker(lang) {
  if (!workers[lang]) workers[lang] = (async () => {
    const T = await loadTesseract();
    return T.createWorker(lang, 1, { logger: () => {} });
  })().catch(e => { delete workers[lang]; throw e; });
  return workers[lang];
}
export async function warmUp(langs = ['eng']) { await Promise.all(langs.map(worker)); }

// ---------- képsegédek ----------
export function canvasFrom(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w || src.videoWidth || src.naturalWidth || src.width;
  c.height = h || src.videoHeight || src.naturalHeight || src.height;
  return c;
}
export function loadImage(url, cors = true) {
  return new Promise((res, rej) => {
    const i = new Image();
    if (cors) i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = () => rej(new Error('kép: ' + url));
    i.src = url;
  });
}

// Kártya határának keresése egyszínű(bb) háttér előtt. Visszaad egy {x,y,w,h} téglalapot a forrás koordinátáiban.
export function detectCard(src, sw, sh) {
  const S = 220;
  const sc = S / Math.max(sw, sh);
  const w = Math.round(sw * sc), h = Math.round(sh * sc);
  const c = canvasFrom(src, w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  // háttérszín: a keret 3 px-es sávjának mediánja
  const bs = [];
  for (let x = 0; x < w; x += 2) for (const y of [1, h - 2]) bs.push(px(x, y));
  for (let y = 0; y < h; y += 2) for (const x of [1, w - 2]) bs.push(px(x, y));
  function px(x, y) { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; }
  const med = k => bs.map(p => p[k]).sort((a, b) => a - b)[bs.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const bgVar = bs.reduce((s, p) => s + Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]), 0) / bs.length;
  const thr = Math.max(38, bgVar * 2.2);
  const rows = new Float32Array(h), cols = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) > thr) { rows[y]++; cols[x]++; }
  }
  const run = (arr, len, need) => {
    let best = [0, -1], s = -1;
    for (let i = 0; i <= len; i++) {
      const on = i < len && arr[i] > need;
      if (on && s < 0) s = i;
      if (!on && s >= 0) { if (i - s > best[1] - best[0] + 1) best = [s, i - 1]; s = -1; }
    }
    return best;
  };
  const [y0, y1] = run(rows, h, w * 0.18);
  const [x0, x1] = run(cols, w, h * 0.18);
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  if (rw < w * 0.25 || rh < h * 0.25) return null;
  const ar = rw / rh;
  if (ar < 0.55 || ar > 0.92) return null;
  // ha szinte a teljes kép, nincs mit kivágni
  return { x: x0 / sc, y: y0 / sc, w: rw / sc, h: rh / sc, bgVar };
}

// Normalizált (630×880) kártyakép előállítása egy forrásból és opcionális vágásból.
export function normalizeCard(src, rect) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  let r = rect || { x: 0, y: 0, w: sw, h: sh };
  if (!rect) {
    const det = detectCard(src, sw, sh);
    if (det) r = det;
    else if (Math.abs(sw / sh - CW / CH) > 0.08) { // nem kártya-arányú kép: középre vágás kártyaarányban
      const tw = Math.min(sw, sh * CW / CH), th = tw * CH / CW;
      r = { x: (sw - tw) / 2, y: (sh - th) / 2, w: tw, h: th };
    }
  }
  const c = canvasFrom(src, CW, CH);
  c.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, CW, CH);
  return c;
}

// Egy régió kivágása, felnagyítása, szürkeárnyalat + Otsu-küszöb, a szöveg legyen fekete fehéren.
export function prepRegion(card, fx, fy, fw, fh, scale = 3, invert = null) {
  const sx = fx * CW, sy = fy * CH, w = fw * CW, h = fh * CH;
  const c = canvasFrom(card, Math.round(w * scale), Math.round(h * scale));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(card, sx, sy, w, h, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  const hist = new Uint32Array(256);
  const gray = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; gray[j] = v; hist[v]++; }
  // Otsu
  const tot = gray.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; t = i; } }
  let dark = 0; for (let j = 0; j < gray.length; j++) if (gray[j] <= t) dark++;
  // a szöveg a kisebbségi rész – legyen az a fekete
  const inv = invert == null ? dark > tot / 2 : invert;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = gray[j] > t ? 255 : 0; if (inv) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}
// Helyi (adaptív) küszöbölés: holós / teljes-art lapokon a globális küszöb szétesik.
// light=false: sötét szöveget keres; light=true: világos szöveget (fehér betű sötét/holó háttéren).
export function prepAdaptive(card, fx, fy, fw, fh, scale = 4, light = false) {
  const c = canvasFrom(card, Math.round(fw * CW * scale), Math.round(fh * CH * scale));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(card, fx * CW, fy * CH, fw * CW, fh * CH, 0, 0, c.width, c.height);
  const W = c.width, H = c.height, im = g.getImageData(0, 0, W, H), d = im.data;
  const gray = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gray[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const r = Math.max(8, Math.round(H * 0.35)), C = 14;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    const m = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    const v = gray[y * W + x];
    const ink = light ? v > m + C : v < m - C;
    const k = (y * W + x) * 4; d[k] = d[k + 1] = d[k + 2] = ink ? 0 : 255; d[k + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}
export function prepGray(card, fx, fy, fw, fh, scale = 2.5) {
  const c = canvasFrom(card, Math.round(fw * CW * scale), Math.round(fh * CH * scale));
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)';
  g.drawImage(card, fx * CW, fy * CH, fw * CW, fh * CH, 0, 0, c.width, c.height);
  return c;
}

const NUM_WL = '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
async function ocr(lang, canvas, psm, whitelist = '') {
  const w = await worker(lang);
  await w.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', tessedit_char_whitelist: whitelist });
  const { data } = await w.recognize(canvas);
  return data.text || '';
}

// ---------- szövegértelmezés ----------
const JP_RE = /[぀-ヿ一-鿿]/;
// Gyűjtői szám kiolvasása OCR-szövegből. Az OCR a „/” jelet gyakran „7”-nek, „,”-nek olvassa,
// ezért a lehetséges bontásokat a valós szett-összlapszámokkal (totals) ellenőrizzük.
export function findNumber(raw, totals) {
  const t = raw.replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1').replace(/[\\|]/g, '/');
  const ok = (n, tot) => (!totals || !totals.size || totals.has(tot)) && n > 0 && n <= tot + 200;
  // 1) szabályos alak: 123/198, TG12/TG30
  for (const m of t.matchAll(/(?<![0-9])([A-Z]{1,3})?\s?(\d{1,3})\s*[\/,.]{1,2}\s*([A-Z]{1,3})?\s?(\d{2,3})(?![0-9])/g)) {
    const pre = m[1] && m[3] ? m[1] : '';
    const n = parseInt(m[2], 10), tot = parseInt(m[4], 10);
    if (ok(n, tot) || pre) return { number: pre + m[2], total: tot, how: 'slash' };
  }
  // 2) összefolyt számjegyek: 1207103 → 120/103 (a „/” helyén 7 vagy 1), 120103 → 120/103
  const cands = [];
  for (const m of t.matchAll(/(?<![0-9])\d{5,7}(?![0-9])/g)) {
    const d = m[0];
    for (let i = 1; i <= 3; i++) {
      for (const skip of [1, 0]) {
        const l = d.slice(0, i), sep = d[i], r = d.slice(i + skip);
        if (skip && !'71'.includes(sep)) continue;
        if (r.length < 2 || r.length > 3) continue;
        const n = parseInt(l, 10), tot = parseInt(r, 10);
        if (ok(n, tot) && totals?.size) cands.push({ number: l, total: tot, how: skip ? 'sep7' : 'join', w: (skip ? 2 : 1) + (l.length === r.length ? 1 : 0) });
      }
    }
  }
  cands.sort((a, b) => b.w - a.w);
  return cands[0] || null;
}
export function parseBottom(raw, jaSetIds = [], totals = null) {
  const t = raw.replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1').replace(/[\\|]/g, '/');
  const f = findNumber(raw, totals);
  const number = f?.number || null, total = f?.total || null;
  const codes = new Set();
  // JP szettkód (pl. M6a, SV2a, S12a) – az ismert szettekkel vetjük össze
  const toks = t.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const jaLower = new Map(jaSetIds.map(s => [s.toLowerCase(), s]));
  for (const tk of toks) {
    const k = tk.toLowerCase();
    if (jaLower.has(k) && /\d/.test(k)) codes.add(jaLower.get(k));
    if (/^[A-Z]{3}$/.test(tk) && !['HP', 'GX', 'NM'].includes(tk)) codes.add(tk); // EN rövidítés, pl. DLR
  }
  return { number, total, setCodes: [...codes] };
}
// Névtisztítás. Levesszük a fejléc-címkéket (Stage 1, Evolves from…, BASIC/VMAX/TERA címke a sor elején,
// önálló TRAINER / ITEM / SUPPORTER / STADIUM / ENERGY címkesor), de a kártya nevének részét NEM:
// „Fire Energy”, „Basic Lightning Energy”, „Energy Search”, „Professor's Research”, „Pokémon Center Lady” megmarad.
const LABEL_LINE = /^(?:(?:basic|stage(?:\s*[12])?|trainer|item|supporter|stadium|tool|pok[eé]mon tool|special energy|energy|ace spec|vmax|vstar|tera|break|restored|evolves?|hp)\s*)+$/i;
const LEAD_STAGE = /^(?:basic|stage(?:\s*[12])?|vmax|vstar|tera|break|restored)\s+(?=\S)/i;
export function cleanName(raw, lang) {
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (lang === 'jpn') {
    const jl = lines.map(l => (l.match(/[぀-ヿ一-鿿ーA-Za-z]+/g) || []).join('')).filter(l => JP_RE.test(l));
    jl.sort((a, b) => b.length - a.length);
    return (jl[0] || '').replace(/^(たね|1進化|2進化|進化)/, '').replace(/HP.*/, '');
  }
  let best = '';
  for (let l of lines) {
    l = l.replace(/evolves?\s+from\b.*$/i, ' ')            // „Evolves from Pikachu”
      .replace(/\bHP\s*\d+.*$/i, ' ')                        // HP 60 és utána minden
      .replace(/[’`]/g, "'")
      .replace(/\d+/g, ' ')
      .replace(/[^A-Za-zéÉ' .:&-]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!l || LABEL_LINE.test(l)) continue;                  // csak címke a sor
    const energy = /\benergy\b/i.test(l);
    if (!energy) l = l.replace(LEAD_STAGE, '');              // „BASIC Pikachu” → „Pikachu”; „Basic Fire Energy” marad
    const words = l.split(' ').filter(w => w.length > 1 || /^[A-Z]$/.test(w));
    const out = words.join(' ').replace(/^[.:'-]+|[.:'-]+$/g, '');
    if (out.replace(/[^A-Za-z]/g, '').length > best.replace(/[^A-Za-z]/g, '').length) best = out;
  }
  return best.replace(/\s+(ex|EX|GX|V)$/i, m => m.toLowerCase() === ' ex' ? ' ex' : m);
}
const meaningful = n => (n || '').replace(/[^A-Za-z぀-ヿ一-鿿]/g, '').length >= 3;

// ---------- képi ujjlenyomat (a lap illusztrációja) ----------
export function artPrint(card, dx = 0, dy = 0, sc = 1) {
  const c = canvasFrom(card, 17, 16);
  const g = c.getContext('2d', { willReadFrequently: true });
  const w = 0.84 * CW * sc, h = 0.37 * CH * sc;
  g.drawImage(card, (0.5 + dx) * CW - w / 2, (0.295 + dy) * CH - h / 2, w, h, 0, 0, 17, 16);
  const d = g.getImageData(0, 0, 17, 16).data;
  const bits = []; const col = [0, 0, 0];
  const L = (x, y) => { const i = (y * 17 + x) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits.push(L(x, y) > L(x + 1, y) ? 1 : 0);
  for (let i = 0; i < d.length; i += 4) { col[0] += d[i]; col[1] += d[i + 1]; col[2] += d[i + 2]; }
  return { bits, col: col.map(v => v / (17 * 16)) };
}
// több kissé eltolt / átméretezett ujjlenyomat a felvett lapról: a kivágás pár %-os pontatlanságát kiegyenlíti
export function artPrints(card) {
  return [[0, 0, 1], [0.025, 0, 1], [-0.025, 0, 1], [0, 0.02, 1], [0, -0.02, 1], [0, 0, 0.95], [0, 0, 1.05]].map(([dx, dy, sc]) => artPrint(card, dx, dy, sc));
}
export const bestSim = (prints, p) => Math.max(...(Array.isArray(prints) ? prints : [prints]).map(q => printSim(q, p)));
export function printSim(a, b) {
  if (!a || !b) return 0;
  let same = 0; for (let i = 0; i < a.bits.length; i++) if (a.bits[i] === b.bits[i]) same++;
  const hs = same / a.bits.length; // 0.5 ≈ véletlen
  const cd = Math.hypot(a.col[0] - b.col[0], a.col[1] - b.col[1], a.col[2] - b.col[2]) / 441;
  return Math.max(0, Math.min(1, ((hs - 0.5) / 0.5) * 0.75 + (1 - cd * 2.5) * 0.25));
}
const printCache = new Map();
export async function printOfUrl(url) {
  if (printCache.has(url)) return printCache.get(url);
  const p = loadImage(url).then(img => artPrint(normalizeCard(img, { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }))).catch(() => null);
  printCache.set(url, p);
  return p;
}

// ---------- gyűjtői szám ----------
// Kontraszt-széthúzás (2–98. percentilis) egy szürke tömbön – elmosott / fakó képen is legyen él.
function stretch(L) {
  const h = new Uint32Array(256); for (const v of L) h[Math.max(0, Math.min(255, v | 0))]++;
  let lo = 0, hi = 255, acc = 0; const n = L.length;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= n * 0.02) { lo = i; break; } }
  acc = 0; for (let i = 255; i >= 0; i--) { acc += h[i]; if (acc >= n * 0.02) { hi = i; break; } }
  const k = 255 / Math.max(20, hi - lo);
  for (let i = 0; i < n; i++) L[i] = (L[i] - lo) * k;
  return L;
}
// Ferdeség becslése a lap alsó részén (vetületi szórás maximuma −3°…+3°), és korrekció.
export function deskew(card) {
  const W = 360, H = 120;
  const c = canvasFrom(card, W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  let best = 0, bestV = -1;
  for (let a = -3; a <= 3.001; a += 0.5) {
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#888'; g.fillRect(0, 0, W, H);
    g.translate(W / 2, H / 2); g.rotate(-a * Math.PI / 180); g.translate(-W / 2, -H / 2);
    g.drawImage(card, 0, 0.6 * CH, CW, 0.4 * CH, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const rows = new Float32Array(H);
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 1; x < W; x++) { const i = (y * W + x) * 4; s += Math.abs(d[i] - d[i - 4]); } rows[y] = s; }
    const m = rows.reduce((p, q) => p + q, 0) / H;
    const v = rows.reduce((p, q) => p + (q - m) ** 2, 0);
    if (v > bestV) { bestV = v; best = a; }
  }
  if (Math.abs(best) < 0.4) return { card, angle: 0 };
  const out = canvasFrom(card, CW, CH);
  const o = out.getContext('2d');
  o.fillStyle = '#888'; o.fillRect(0, 0, CW, CH);
  o.translate(CW / 2, CH / 2); o.rotate(-best * Math.PI / 180); o.translate(-CW / 2, -CH / 2);
  o.drawImage(card, 0, 0);
  return { card: out, angle: best };
}


// Szövegsorok keresése egy régióban: soronkénti vízszintes él-sűrűség → sávok (kártya-arányban).
export function lineBands(card, fx, fy, fw, fh) {
  const W = 480, H = Math.max(40, Math.round(W * (fh * CH) / (fw * CW)));
  const c = canvasFrom(card, W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(card, fx * CW, fy * CH, fw * CW, fh * CH, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  stretch(L);
  const prof = new Float32Array(H);
  for (let y = 0; y < H; y++) { let s = 0; for (let x = 1; x < W; x++) { const v = Math.abs(L[y * W + x] - L[y * W + x - 1]); if (v > 18) s += v; } prof[y] = s; }
  const sm = prof.map((_, y) => (prof[y - 1] || prof[y]) * 0.25 + prof[y] * 0.5 + (prof[y + 1] || prof[y]) * 0.25);
  const mean = sm.reduce((a, b) => a + b, 0) / H;
  const sd = Math.sqrt(sm.reduce((a, b) => a + (b - mean) ** 2, 0) / H);
  const bands = [];
  for (const k of [0.6, 0.2, -0.1]) {
    const thr = mean + k * sd;
    let s = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && sm[y] > thr;
      if (on && s < 0) s = y;
      if (!on && s >= 0) {
        const h = y - s;
        const minH = H * (0.009 * CH) / (fh * CH) * 1, maxH = H * (0.04 / fh);
        if (h >= Math.max(3, minH) && h <= maxH) {
          let str = 0; for (let t = s; t < y; t++) str += sm[t];
          bands.push({ y0: fy + (s / H) * fh, y1: fy + (y / H) * fh, str: str / h });
        }
        s = -1;
      }
    }
  }
  // átfedők összevonása, erősség szerint
  bands.sort((a, b) => b.str - a.str);
  const out = [];
  for (const b of bands) if (!out.some(o => Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0) > 0.5 * Math.min(o.y1 - o.y0, b.y1 - b.y0))) out.push(b);
  return out.slice(0, 5);
}
// Dőlt szám „kiegyenesítése”: vízszintes nyírás (x' = x + k·y), szürkeárnyalat + kontraszt.
export function prepShear(card, fx, fy, fw, fh, scale = 4, k = 0.22) {
  const w = fw * CW * scale, h = fh * CH * scale;
  const c = canvasFrom(card, Math.round(w + k * h + 4), Math.round(h));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.filter = 'grayscale(1) contrast(1.5)';
  g.imageSmoothingQuality = 'high';
  g.setTransform(1, 0, k, 1, 2, 0);
  g.drawImage(card, fx * CW, fy * CH, fw * CW, fh * CH, 0, 0, w, h);
  return c;
}
// Nyers szám-olvasatok egy OCR-szövegből (az összlap lehet hibás: a szavazás javítja)
export function numberReads(raw) {
  const t = raw.replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1').replace(/[\\|]/g, '/');
  const out = [];
  for (const m of t.matchAll(/(?<![0-9])([A-Z]{1,3})?\s?(\d{1,3})\s*[\/,.]{1,2}\s*([A-Z]{1,3})?\s?(\d{2,4})(?![0-9])/g))
    out.push({ number: (m[1] && m[3] ? m[1] : '') + m[2], tot: m[4] });
  return out;
}
const lev1 = (a, b) => { // legfeljebb 1 szerkesztési távolság?
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
};

// Egy szövegsoron belüli blokkok (pl. „J”, „30C EN”, „022/128”, jobb oldali szöveg) oszlop-él-profil alapján.
export function lineSegments(card, band) {
  const h = band.y1 - band.y0, y0 = Math.max(0, band.y0 - h * 0.2), hh = Math.min(1 - y0, h * 1.4);
  const W = 800, H = Math.max(8, Math.round(W * hh * CH / CW));
  const c = canvasFrom(card, W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(card, 0, y0 * CH, CW, hh * CH, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const G = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) G[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  stretch(G);
  const L = (x, y) => G[y * W + x];
  const col = new Uint16Array(W);
  for (let x = 1; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) if (Math.abs(L(x, y) - L(x - 1, y)) > 22) n++; col[x] = n; }
  const gap = Math.max(3, Math.round(H * 0.6)), segs = [];
  let s = -1, last = -1;
  for (let x = 0; x < W; x++) {
    if (col[x] > 0) { if (s < 0) s = x; last = x; }
    else if (s >= 0 && x - last > gap) { segs.push([s, last]); s = -1; }
  }
  if (s >= 0) segs.push([s, last]);
  return segs.map(([a, z]) => ({ x0: Math.max(0, a / W - 0.012), x1: Math.min(1, z / W + 0.012) }))
    .filter(sg => sg.x1 - sg.x0 >= 0.04 && sg.x1 - sg.x0 <= 0.6);
}
// Egy blokk kivágása ~60 px-es betűmagasságra, szürkén vagy adaptívan binarizálva.
function segCanvas(card, band, sg, mode) {
  const h = band.y1 - band.y0, y = Math.max(0, band.y0 - h * 0.45), hh = Math.min(1 - y, h * 1.9);
  const scale = Math.max(1.5, Math.min(10, 60 / (h * CH)));
  const fw = sg.x1 - sg.x0;
  if (mode === 'shear') return prepShear(card, sg.x0, y, fw, hh, scale);
  if (mode === 'gray') return prepGray(card, sg.x0, y, fw, hh, scale);
  if (mode === 'otsu') return prepRegion(card, sg.x0, y, fw, hh, scale);
  return prepAdaptive(card, sg.x0, y, fw, hh, scale, mode === 'light');
}
// Több kivágás, szavazással: két egyező olvasat (szám + összlap) elég; különben a legtöbb szavazatot kapott.
async function readNumber(cards, out, opts) {
  const totals = opts.totals && opts.totals.size ? opts.totals : null;
  const totList = totals ? [...totals].map(String) : null;
  const nums = new Map(); // számkulcs → { n, number, tot: Map(összlap → támogatás) }
  let reads = 0;
  const note = (txt) => {
    out.raw.bottom = (out.raw.bottom ? out.raw.bottom + '\n' : '') + txt;
    const p = parseBottom(txt, opts.jaSetIds || [], opts.totals);
    p.setCodes.forEach(c => out.setCodes.includes(c) || out.setCodes.push(c));
    const rs = numberReads(txt);
    // perjel nélküli, összefolyt számjegyekből kirakott olvasat (pl. „1207103” → 120/103): gyengébb jel
    if (!rs.length && p.number) rs.push({ number: p.number, tot: String(p.total), merged: true });
    for (const r of rs) {
      // érvényes összlap: pontos egyezés, vagy legfeljebb 1 karakter eltérés egy létező szett összlapjától
      let cand = !totList ? [r.tot] : totList.includes(String(+r.tot)) ? [String(+r.tot)] : totList.filter(x => lev1(x, r.tot) || lev1(x, String(+r.tot)));
      if (!cand.length || cand.length > 6) continue;
      const k = parseInt(r.number.replace(/\D/g, ''), 10) + (/^[A-Z]/.test(r.number) ? '|' + r.number.replace(/\d/g, '') : '');
      if (!(parseInt(r.number.replace(/\D/g, ''), 10) > 0)) continue;
      const v = nums.get(k) || { n: 0, number: r.number, tot: new Map() };
      // a lapon nyomtatott formátum (pl. 022/128: a szám annyi jegyű, mint az összlap) erősebb jel
      const digits = r.number.replace(/\D/g, '').length;
      v.n += (digits === String(+cand[0]).length ? 1 : 0.5) * (r.merged ? 0.3 : 1);
      if (digits > (v.number.replace(/\D/g, '').length)) v.number = r.number;
      const exact = cand.length === 1 && String(+r.tot) === cand[0];
      for (const t of cand) v.tot.set(t, (v.tot.get(t) || 0) + (exact ? 2 : 1));
      nums.set(k, v);
      reads++;
    }
    return decide(false);
  };
  // döntés: a legtöbbször olvasott szám + a legtöbb támogatást kapott összlap; „biztos”, ha ≥2 olvasat és ≥3 támogatás, egyértelműen
  const decide = (final) => {
    const best = [...nums.values()].sort((a, b) => b.n - a.n)[0];
    if (!best) return false;
    const ts = [...best.tot.entries()].sort((a, b) => b[1] - a[1]);
    const clear = !ts[1] || ts[0][1] > ts[1][1];
    const sure = best.n >= 2 && ts[0][1] >= 3 && clear;
    if (sure || final) {
      // gyenge végső döntés csak akkor, ha legalább egy, a nyomtatott formátumnak megfelelő olvasat van (n ≥ 1),
      // pontos összlappal, és nincs vele versengő szám – különben inkább nincs szám, mint rossz szám
      const rivals = [...nums.values()].filter(v => v !== best && v.n >= 1).length;
      if (final && !(best.n >= 1 && ts[0][1] >= 2 && clear && !rivals)) { out.numberHint = best.number + '/' + ts[0][0]; return false; }
      out.number = best.number; out.total = +ts[0][0]; out.numberVotes = best.n; out.numberSure = sure;
    }
    return sure;
  };
  const ST = [0.0, 0.87, 1.0, 0.13];
  const card = cards[0];
  const BL = [0.0, 0.895, 0.56, 0.09];
  // gyors út: csak kis kivágások (a megtalált szám-blokk), a nagy sávok kimaradnak – az OCR ideje a képmérettel nő
  const jobs = opts.fast ? [] : [() => [prepGray(card, ...ST, 2.5), 11, ''], () => [prepGray(card, ...BL, 3.5), 11, ''], () => [prepAdaptive(card, ...BL, 3.5, false), 11, '']];
  // szövegsorok a lap alján, soronként blokkokra bontva; a szám-blokk nagyítva, többféle előfeldolgozással.
  // Előbb az eredeti, aztán (ha ferde volt) a kiegyenesített kártyaképen – a szavazatok összeadódnak.
  const segJobs = cards.map(cd => {
    const list = [];
    // sorok a teljes szélességben ÉS a bal 60%-ban (teljes-art lapon a rajz elnyomhatja a számsort)
    const bands = [];
    for (const b of lineBands(cd, 0.0, 0.86, 1.0, 0.135).slice(0, 3).concat(lineBands(cd, 0.0, 0.86, 0.6, 0.135).slice(0, 3)))
      if (!bands.some(o => Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0) > 0.5 * Math.min(o.y1 - o.y0, b.y1 - b.y0))) bands.push(b);
    for (const b of bands) for (const sg of lineSegments(cd, b).slice(0, 5)) list.push([cd, b, sg]);
    // a szám-blokk tipikusan: bal oldalt (modern) vagy jobb alul (régi), 8–40% széles, a lap alsó 4–12%-ában
    const pri = ([, b, sg]) => { const w = sg.x1 - sg.x0, yc = (b.y0 + b.y1) / 2; return (sg.x0 < 0.45 ? 2 : sg.x1 > 0.8 ? 1 : 0) + (w >= 0.08 && w <= 0.4 ? 2 : 0) + (yc > 0.9 && yc < 0.975 ? 1 : 0); };
    return list.sort((a, b) => pri(b) - pri(a)).slice(0, 4);
  });
  for (const list of segJobs) for (const [cd, b, sg] of list) jobs.push(() => [segCanvas(cd, b, sg, 'shear'), 7, NUM_WL]);
  if (opts.fast) { for (const list of segJobs) for (const [cd, b, sg] of list) jobs.push(() => [segCanvas(cd, b, sg, 'gray'), 7, NUM_WL]); jobs.push(() => [prepGray(card, ...BL, 1.6), 11, '']); }
  // fix vékony sávok a bal alsó részen (a sorkereséstől függetlenül; teljes-art lapon fehér betű → „light”)
  for (const y of [0.935, 0.95, 0.92, 0.965, 0.905]) {
    jobs.push(() => [prepGray(card, 0.0, y, 0.6, 0.032, 4), 7, NUM_WL]);
    jobs.push(() => [prepAdaptive(card, 0.0, y, 0.6, 0.032, 4, true), 7, NUM_WL]);
  }
  for (const list of segJobs) for (const mode of ['gray', 'dark', 'light']) for (const [cd, b, sg] of list) jobs.push(() => [segCanvas(cd, b, sg, mode), 7, NUM_WL]);
  jobs.push(() => [prepAdaptive(card, ...ST, 2.5, true), 11, '']);
  out.numberJobs = 0;
  const MAX_JOBS = opts.fast ? 10 : 40; // gyors út (élő szkenner): kevesebb kivágás; részletes: 40. Utána szigorú végső döntés
  for (const mk of jobs.slice(0, MAX_JOBS - 2).concat(jobs.slice(-2))) {
    const [cv, psm, wl] = mk();
    out.numberJobs++;
    if (note(await ocr('eng', cv, psm, wl))) return;
  }
  decide(true);
}

// ---------- fő belépési pont ----------
// opts: { lang: 'auto'|'en'|'ja', jaSetIds, rect }
export async function recognize(src, opts = {}) {
  const t0 = performance.now();
  const card = normalizeCard(src, opts.rect);
  const out = { card, print: artPrint(card), prints: artPrints(card), number: null, total: null, setCodes: [], name: '', raw: {} };
  // 1) gyűjtői szám + szettkód az alsó sávból (modern lapok: bal alul; régiek: jobb alul)
  // kis, célzott kivágások: bal alsó sarok (modern lapok), jobb alsó (régi lapok), végül az egész alsó sáv
  const dk = deskew(card); out.skew = dk.angle;
  if (!opts.skipNumber) await readNumber(dk.angle ? [card, dk.card] : [card], out, opts); // élő szkenner: ha az előző kockán sem volt olvasható, kihagyjuk
  // 2) név a felső sávból
  const wantJa = opts.lang === 'ja' || (opts.lang === 'auto' && out.setCodes.some(c => /\d/.test(c)));
  const top = () => prepRegion(card, 0.04, 0.025, 0.70, 0.075, opts.fast ? 1.4 : 3); // a név ~50 px magas: gyors úton elég kisebb nagyítás
  if (opts.lang !== 'ja') {
    out.raw.name = await ocr('eng', top(), 7);
    out.name = cleanName(out.raw.name, 'eng');
    if (out.name.replace(/[^A-Za-z]/g, '').length < 3) { const t2 = await ocr('eng', prepGray(card, 0.04, 0.02, 0.72, 0.085, 3), 6); out.raw.name += '\n' + t2; out.name = cleanName(t2, 'eng') || out.name; }
    // Energy / Trainer elrendezés: a név a fejléc alatt, középen vagy alul is lehet
    if (!meaningful(out.name) && !opts.fast) {
      for (const [fx, fy, fw, fh] of [[0.04, 0.07, 0.92, 0.07], [0.05, 0.44, 0.9, 0.14], [0.05, 0.76, 0.9, 0.11], [0.04, 0.02, 0.92, 0.1]]) {
        const t3 = await ocr('eng', prepGray(card, fx, fy, fw, fh, 3), 6);
        const n3 = cleanName(t3, 'eng');
        out.raw.name += '\n' + t3;
        if (meaningful(n3) && n3.length > out.name.length) { out.name = n3; break; }
      }
    }
  }
  if (wantJa || (opts.lang === 'auto' && !opts.fast && out.name.replace(/[^A-Za-z]/g, '').length < 3)) {
    try {
      out.raw.nameJa = await ocr('jpn', top(), 7);
      const jn = cleanName(out.raw.nameJa, 'jpn');
      if (jn.length >= 2) { out.nameJa = jn; if (wantJa || !out.name) out.name = jn; }
    } catch (e) { console.warn('jpn OCR', e); }
  }
  out.hasJapanese = JP_RE.test(out.name) || out.setCodes.some(c => /\d/.test(c));
  out.ms = Math.round(performance.now() - t0);
  return out;
}

// japán név utólagos olvasása (ha az angol OCR nem adott értelmes nevet)
export async function ocrNameJa(card, { max = 3 } = {}) {
  const outs = [];
  const variants = [
    () => prepGray(card, 0.14, 0.025, 0.52, 0.07, 3),   // „たね/進化” címke nélkül
    () => prepGray(card, 0.04, 0.025, 0.70, 0.075, 3),
    () => prepRegion(card, 0.04, 0.025, 0.70, 0.075, 3),
  ];
  for (const mk of variants.slice(0, max)) {
    const n = cleanName(await ocr('jpn', mk(), 7), 'jpn');
    if (n.length >= 2 && !outs.includes(n)) outs.push(n);
  }
  return outs;
}

// Nyelvpróba: a lap szöveges részének (támadás-/képességszöveg) írásrendszere. Az azonos rajzú angol és japán lapok
// (pl. 30th Celebration Mew ex EN 152 / JP 129) képből nem különböztethetők meg, a szövegük igen.
export async function detectScript(card) {
  let kana = 0, latin = 0;
  for (const [fy, fh] of [[0.56, 0.12], [0.70, 0.1]]) {
    const t = await ocr('jpn', prepGray(card, 0.06, fy, 0.88, fh, 1.6), 6);
    kana += (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    latin += (t.match(/[A-Za-z]/g) || []).length;
  }
  return { lang: kana >= 6 && kana > latin * 0.6 ? 'ja' : latin >= 12 && latin > kana * 2 ? 'en' : null, kana, latin };
}

export function thumb(card, w = 160) {
  const c = canvasFrom(card, w, Math.round(w * CH / CW));
  c.getContext('2d').drawImage(card, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
