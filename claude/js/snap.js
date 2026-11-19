// Okemon Scanner – „fotózós” szkennelés (Pokellect-folyamat): állandó vezetőkeret, automatikus (vagy kézi) kioldás,
// 1–2 mp feldolgozás, majd teljes képernyős eredményoldal. Egy lap = egy szkennelés, utána „Új szkennelés”.
// Folyamat: kamera → (8/mp) a vezetőkeretben lévő kép stabil és éles? → 3 kocka a keret + margó tartományból →
// (ha van magabiztos kártya-négyszög a kivágásban: perspektíva-korrekció, különben a keret közvetlen kivágása) →
// csillogás-csillapítás + helyi kontraszt → felismerés (képi ujjlenyomat + OCR, több kocka szavazása) → döntés.
import { detectQuad, warpPerspective, detectCardGuided } from './detect-core.js';
import { CW, CH } from './recognize.js';
import { quadSig, sigDist, guideQuadNorm } from './cardsig.js';

const TICK_MS = 125;
const SMALL_MAX = 360;        // a figyelő kocka hosszabb oldala (px)
const STEADY_MS = 600;        // ennyi ideig nyugodt a keret tartalma → kioldás
const STEP_TOL = 0.17;        // szomszédos kockák képaláírás-távolsága: ez alatt „nem mozog” (remegő kéz, mozgó csillogás belefér)
const DRIFT_TOL = 0.32;       // a nyugalmi ablak elejéhez képest legfeljebb ennyit sodródhat (másik lap: ≥0,4)
const SHARP_G = 28;           // Laplace-variancia alsó határa a keretben (alatta: elmosódott)
const NOQUAD_STEADY_MS = 2000;// kártya-négyszög nélkül ennyi nyugalom után is kioldunk (ha van tartalom)
const REARM_T = 0.30;         // „Új szkennelés” után: ennyit kell változnia a keretnek (a cellák legjobb 60%-án mérve, a csillogás-foltok ne számítsanak), hogy újra magától kioldjon
const MARGIN = 0.14;          // a keret körüli margó a kivágásban
const WATCHDOG_MS = 40000;
const BUDGET_MS = 13000;      // ennyi után nem indítunk újabb (lassú) olvasási kört – a legjobb tippet mutatjuk, alternatívákkal

export const CAMERA_HELP = {
  NotAllowedError: 'A kamera nincs engedélyezve. iPhone-on: Beállítások › Safari › Kamera › „Engedélyezés”, vagy a címsor „aA” menüjében: Webhely-beállítások › Kamera. Főképernyőre tett appnál: Beállítások › Adatvédelem › Kamera. Utána koppints a „Kamera indítása” gombra.',
  NotFoundError: 'Nem található kamera ezen az eszközön. Használd a „Fotó” gombot.',
  NotReadableError: 'A kamerát most egy másik alkalmazás használja. Zárd be, majd koppints a „Kamera indítása” gombra.',
  SecurityError: 'A kamera csak biztonságos (https://) kapcsolaton működik.',
  insecure: 'A kamera csak https:// címen működik (pl. a GitHub Pages linken). Addig a „Fotó” gombbal tudsz lapot beolvasni.',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Laplace-variancia egy téglalapon (szürke, RGBA-ból) – élességmérő
export function lapVar(rgba, w, h, x0 = 0, y0 = 0, x1 = w, y1 = h) {
  x0 = Math.max(1, Math.floor(x0)); y0 = Math.max(1, Math.floor(y0)); x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
  let n = 0, s = 0, s2 = 0;
  const L = (x, y) => { const o = (y * w + x) * 4; return rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114; };
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const l = 4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1);
    n++; s += l; s2 += l * l;
  }
  if (!n) return 0;
  const m = s / n; return s2 / n - m * m;
}

// ---- csillogás-csillapítás + helyi kontraszt (tiszta függvény, vásznon) ----
// A tok / védőfólia fényfoltja (a környezetnél jóval világosabb, telített folt) helyére a környező színt töltjük be
// (normált konvolúció negyedfelbontáson), majd a helyi kontrasztot kiegyenlítjük (a „fátyol” alatti szöveg is kijön).
function boxBlurF(a, w, h, r) {
  const out = new Float32Array(a.length), tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) { let s = 0, c = 0; const o = y * w;
    for (let x = -r; x < w; x++) { const xi = x + r; if (xi < w) { s += a[o + xi]; c++; } const xo = x - r - 1; if (xo >= 0) { s -= a[o + xo]; c--; } if (x >= 0) tmp[o + x] = s / c; } }
  for (let x = 0; x < w; x++) { let s = 0, c = 0;
    for (let y = -r; y < h; y++) { const yi = y + r; if (yi < h) { s += tmp[yi * w + x]; c++; } const yo = y - r - 1; if (yo >= 0) { s -= tmp[yo * w + x]; c--; } if (y >= 0) out[y * w + x] = s / c; } }
  return out;
}
export function deglare(src, { strength = 1 } = {}) {
  const W = src.width, H = src.height;
  const g = src.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, W, H), d = img.data;
  const f = 4, w = Math.max(8, Math.round(W / f)), h = Math.max(8, Math.round(H / f));
  const L = new Float32Array(w * h), R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h), mn = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, gg = 0, b = 0, m = 255;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) { const o = (Math.min(H - 1, y * f + j) * W + Math.min(W - 1, x * f + i)) * 4; r += d[o]; gg += d[o + 1]; b += d[o + 2]; m = Math.min(m, d[o], d[o + 1], d[o + 2]); }
    const k = y * w + x; R[k] = r / 16; G[k] = gg / 16; B[k] = b / 16; L[k] = R[k] * 0.299 + G[k] * 0.587 + B[k] * 0.114; mn[k] = m;
  }
  const rad = Math.max(4, Math.round(w * 0.09));
  const M = boxBlurF(L, w, h, rad);
  // glare = a környezeténél jóval világosabb ÉS közel fehér (min csatorna magas) folt
  const gl = new Float32Array(w * h);
  for (let k = 0; k < gl.length; k++) { const ex = L[k] - M[k]; gl[k] = Math.max(0, Math.min(1, (ex - 28) / 45)) * Math.max(0, Math.min(1, (mn[k] - 190) / 40)) * strength; }
  const glb = boxBlurF(gl, w, h, 1);
  // kitöltés: a nem-glare képpontok normált elmosása
  const wR = new Float32Array(w * h), wG = new Float32Array(w * h), wB = new Float32Array(w * h), wW = new Float32Array(w * h);
  for (let k = 0; k < gl.length; k++) { const a = 1 - Math.min(1, glb[k] * 1.6); wR[k] = R[k] * a; wG[k] = G[k] * a; wB[k] = B[k] * a; wW[k] = a; }
  const bR = boxBlurF(wR, w, h, 6), bG = boxBlurF(wG, w, h, 6), bB = boxBlurF(wB, w, h, 6), bW = boxBlurF(wW, w, h, 6);
  // helyi kontraszt (szórás)
  const dev = new Float32Array(w * h); for (let k = 0; k < dev.length; k++) dev[k] = (L[k] - M[k]) ** 2;
  const S = boxBlurF(dev, w, h, Math.max(3, Math.round(rad * 0.6)));
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const oimg = new ImageData(W, H), od = oimg.data;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, y / f), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, x / f), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
      const bl = a => (a[i00] * (1 - tx) + a[i10] * tx) * (1 - ty) + (a[i01] * (1 - tx) + a[i11] * tx) * ty;
      const o = (y * W + x) * 4;
      const m = bl(glb);
      let r = d[o], gg = d[o + 1], b = d[o + 2];
      if (m > 0.02) {
        const ww = bl(bW) || 1e-3, fr = bl(bR) / ww, fg = bl(bG) / ww, fb = bl(bB) / ww, a = Math.min(1, m * 1.6);
        r = r * (1 - a) + fr * a; gg = gg * (1 - a) + fg * a; b = b * (1 - a) + fb * a;
      }
      // helyi kontraszt-kiegyenlítés: gyenge kontrasztú (fátyolos) tájon erősítés
      const sd = Math.sqrt(bl(S)) + 1, gain = Math.max(1, Math.min(1.9, 34 / sd));
      if (gain > 1.02) { const mm = bl(M); r = mm + (r - mm) * gain; gg = mm + (gg - mm) * gain; b = mm + (b - mm) * gain; }
      od[o] = r < 0 ? 0 : r > 255 ? 255 : r; od[o + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg; od[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b; od[o + 3] = 255;
    }
  }
  out.getContext('2d').putImageData(oimg, 0, 0);
  return out;
}

export class SnapScanner {
  constructor({ video, overlay, recognizeFrame, onDecision, onFail, onStatus, onState, onProcessing, indexCount }) {
    Object.assign(this, { video, overlay, recognizeFrame, onDecision, onFail, onStatus, onState, onProcessing, indexCount });
    this.state = 'off'; this.gen = 0; this.zoom = 1;
    this.small = document.createElement('canvas'); this.full = document.createElement('canvas');
    this.reqId = 0; this.pending = new Map();
    try {
      this.worker = new Worker(new URL('./detect-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => { const p = this.pending.get(e.data.id); if (p) { this.pending.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); } };
      this.worker.onerror = () => { this.worker = null; };
    } catch { this.worker = null; }
    this.stats = { captures: 0, decisions: 0, frames: 0, auto: 0, manual: 0 };
    this.debug = /[?&]debug=1/.test(location.search);
    this.hist = []; this.refRoi = null; this.armed = true; this.chg = 0; this.steadySince = 0; this.quadOk = false;
    this.fps = 0; this.fpsN = 0; this.fpsT = performance.now(); this.sharp = 0; this.motion = 0; this.lastD = 0; this.how = '–';
    this.stateSince = performance.now(); this.gq = null;
  }
  call(msg, transfer) {
    if (!this.worker) return null;
    const id = ++this.reqId;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.worker.postMessage({ ...msg, id }, transfer); });
  }
  setState(s, info) { if (this.state !== s) { this.state = s; this.stateSince = performance.now(); this.onState?.(s, info); } }
  status(t, kind = '') { if (this.lastStatus !== t + kind) { this.lastStatus = t + kind; this.onStatus?.(t, kind); } }

  async start({ stream } = {}) {
    if (this.running) return true;
    if (!stream) {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(CAMERA_HELP.insecure), { name: 'insecure' });
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      this.ownStream = true;
      const tr = stream.getVideoTracks()[0];
      try { const cap = tr.getCapabilities?.(); if (cap?.focusMode?.includes('continuous')) await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
    } else this.ownStream = false;
    this.stream = stream;
    const v = this.video;
    v.setAttribute('playsinline', ''); v.muted = true; v.srcObject = stream;
    await v.play().catch(() => {});
    this.running = true; this.gen++;
    this.hist = []; this.refRoi = null; this.armed = true;
    this.setState('ready'); this.status('Tedd a lapot a keretbe');
    this.loop(); this.draw();
    document.addEventListener('visibilitychange', this.onVis = () => { if (!document.hidden && this.running && v.paused) v.play().catch(() => {}); });
    return true;
  }
  stop() {
    this.running = false; this.gen++;
    clearTimeout(this.timer); cancelAnimationFrame(this.raf);
    if (this.onVis) document.removeEventListener('visibilitychange', this.onVis);
    if (this.stream && this.ownStream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.video.srcObject = null;
    this.setState('off');
    const g = this.overlay.getContext('2d'); g.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
  // „Új szkennelés”: azonnal újra figyel. A kereten lévő (előző) lapot nem olvassa újra magától, amíg a keret tartalma meg nem változik
  // (kézi kioldás mindig működik) – NEM kell hozzá üres kép.
  newScan() {
    this.gen++; this.hist = []; this.chg = 0; this.steadySince = 0;
    this.armed = !this.refRoi;
    if (this.running) { this.setState('ready'); this.status('Tedd a lapot a keretbe'); }
  }
  pause() { if (this.running && this.state === 'ready') this.setState('result'); }
  cycleZoom() {
    const z = this.zoom >= 2 ? 1 : this.zoom >= 1.5 ? 2 : 1.5;
    this.setZoom(z); return z;
  }
  setZoom(z) { this.zoom = z; this.video.style.transform = z === 1 ? '' : `scale(${z})`; this.hist = []; this.refRoi = null; this.armed = true; }
  // a vezetőkeret négyszöge a videó normált koordinátáiban (a nagyítást beleszámítva)
  guideNorm() {
    const v = this.video;
    const gq = guideQuadNorm(this.overlay.clientWidth || 360, this.overlay.clientHeight || 640, v.videoWidth, v.videoHeight);
    if (!gq) return null;
    const z = this.zoom;
    return z === 1 ? gq : gq.map(p => ({ x: 0.5 + (p.x - 0.5) / z, y: 0.5 + (p.y - 0.5) / z }));
  }
  loop() {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick().catch(e => console.error(e)).finally(() => this.loop()), TICK_MS);
  }
  async tick() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) { if (this.running && v.paused) v.play().catch(() => {}); return; }
    const now = performance.now();
    // őrkutya: a beragadt feldolgozás ne bénítsa meg a szkennert
    if (['capturing', 'identifying'].includes(this.state) && now - this.stateSince > WATCHDOG_MS) {
      this.gen++; this.setState('ready'); this.onProcessing?.(null); this.onFail?.(null, { timeout: true });
    }
    const sc = SMALL_MAX / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.round(v.videoWidth * sc), h = Math.round(v.videoHeight * sc);
    if (this.small.width !== w || this.small.height !== h) { this.small.width = w; this.small.height = h; }
    const g = this.small.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, w, h);
    // nagyítás: a videó CSS-sel van nagyítva, a mintavétel viszont a teljes képből történik – a keret a nagyítással igazodik
    const data = g.getImageData(0, 0, w, h).data;
    const gq = this.gq = this.guideNorm(); if (!gq) return;
    const px = gq.map(p => ({ x: p.x * w, y: p.y * h }));
    const roi = quadSig(data, w, h, px, { inset: 0.04 });
    const x0 = Math.min(...px.map(p => p.x)), x1 = Math.max(...px.map(p => p.x)), y0 = Math.min(...px.map(p => p.y)), y1 = Math.max(...px.map(p => p.y));
    this.sharp = lapVar(data, w, h, x0, y0, x1, y1);
    this.stats.frames++; this.fpsN++; if (now - this.fpsT > 1000) { this.fps = this.fpsN * 1000 / (now - this.fpsT); this.fpsN = 0; this.fpsT = now; }
    if (!roi) return;
    this.hist.push({ t: now, roi, sharp: this.sharp }); this.hist = this.hist.filter(r => now - r.t < 1500);
    this.motion = this.hist.length > 1 ? sigDist(this.hist[this.hist.length - 2].roi, roi) : 0;
    if (this.state !== 'ready') return;
    // kártya-alakzat a keret körül? (a sima asztal ne oldjon ki)
    if (this.worker) {
      try { const r = (await this.call({ type: 'detect', w, h, buf: data.buffer }, [data.buffer])).res; this.quadOk = !!r && this.overlapsGuide(r.quad, gq); this.via = r?.via; } catch { this.quadOk = false; }
    } else { const r = detectQuad(data, w, h); this.quadOk = !!r && this.overlapsGuide(r.quad, gq); this.via = r?.via; }
    if (this.state !== 'ready') return;
    // újrafegyverkezés „Új szkennelés” után: a keret tartalmának érdemben meg kell változnia
    if (!this.armed && this.refRoi) {
      this.lastD = sigDist(roi, this.refRoi, 0.6);
      this.chg = this.lastD > REARM_T ? this.chg + 1 : 0;
      if (this.chg >= 3) { this.armed = true; this.hist = [{ t: now, roi, sharp: this.sharp }]; }
      else { this.status('Tedd a következő lapot a keretbe'); return; }
    }
    const win = this.hist.filter(r => now - r.t <= STEADY_MS + 70);
    const span = win.length ? now - win[0].t : 0;
    // éles: az utóbbi ~1,5 mp legjobbjának legalább 55%-a (a fókuszkereső / mozgás miatt elmosódott kockák kiesnek) és az abszolút minimum
    const bestSharp = Math.max(...this.hist.map(r => r.sharp));
    const nsharp = win.filter(r => r.sharp >= SHARP_G && r.sharp >= bestSharp * 0.55).length;
    // nyugodt: a szomszédos kockák többsége közel azonos (a remegő kéz kis elmozdulása belefér), és nincs nagy sodródás
    let calm = false;
    if (win.length >= 4 && span >= STEADY_MS - 100) {
      let small = 0; for (let i = 1; i < win.length; i++) if (sigDist(win[i - 1].roi, win[i].roi) < STEP_TOL) small++;
      calm = small >= Math.ceil((win.length - 1) * 0.75) && win.every(r => sigDist(r.roi, roi) < DRIFT_TOL);
    }
    const content = roi.std > 16;
    if (!content) { this.steadySince = 0; this.status('Tedd a lapot a keretbe'); return; }
    if (calm && nsharp >= Math.ceil(win.length * 0.66)) {
      if (!this.steadySince) this.steadySince = now;
      if (this.quadOk || now - this.steadySince >= NOQUAD_STEADY_MS) { this.status('Tartsd mozdulatlanul…'); this.capture({ manual: false }); return; }
      this.status('Tartsd mozdulatlanul…');
    } else { this.steadySince = 0; this.status(calm ? 'Tartsd mozdulatlanul – a kép elmosódott' : 'Tedd a lapot a keretbe, és tartsd mozdulatlanul'); }
  }
  overlapsGuide(quad, gq) {
    const bb = pts => { const xs = pts.map(p => p.x), ys = pts.map(p => p.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
    const a = bb(quad), b = bb(gq);
    const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (iw <= 0 || ih <= 0) return false;
    const inter = iw * ih, uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return inter / uni > 0.35;
  }

  // ---- kioldás: 3 kocka a keret + margó tartományból ----
  async grabShots(n = 3, gap = 140) {
    const v = this.video, W = v.videoWidth, H = v.videoHeight;
    const gq = this.guideNorm();
    const xs = gq.map(p => p.x * W), ys = gq.map(p => p.y * H);
    const gx0 = Math.min(...xs), gx1 = Math.max(...xs), gy0 = Math.min(...ys), gy1 = Math.max(...ys);
    const mx = (gx1 - gx0) * MARGIN, my = (gy1 - gy0) * MARGIN;
    const cx0 = Math.max(0, Math.floor(gx0 - mx)), cy0 = Math.max(0, Math.floor(gy0 - my)), cx1 = Math.min(W, Math.ceil(gx1 + mx)), cy1 = Math.min(H, Math.ceil(gy1 + my));
    const shots = [];
    if (this.full.width !== W || this.full.height !== H) { this.full.width = W; this.full.height = H; }
    const fg = this.full.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < n; i++) {
      fg.drawImage(v, 0, 0, W, H);
      const c = document.createElement('canvas'); c.width = cx1 - cx0; c.height = cy1 - cy0;
      c.getContext('2d', { willReadFrequently: true }).drawImage(this.full, cx0, cy0, c.width, c.height, 0, 0, c.width, c.height);
      // élesség a kivágáson (kicsinyítve)
      const k = 360 / Math.max(c.width, c.height), sw = Math.round(c.width * k), sh = Math.round(c.height * k);
      const t = document.createElement('canvas'); t.width = sw; t.height = sh; const tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(c, 0, 0, sw, sh);
      const sharp = lapVar(tg.getImageData(0, 0, sw, sh).data, sw, sh, sw * 0.1, sh * 0.1, sw * 0.9, sh * 0.9);
      shots.push({ canvas: c, sharp, guide: { x0: gx0 - cx0, y0: gy0 - cy0, x1: gx1 - cx0, y1: gy1 - cy0 } });
      if (i < n - 1) await sleep(gap);
    }
    return shots;
  }
  // a kivágáson belül: magabiztos kártya-négyszög → arra igazítunk; különben a vezetőkeret téglalapja
  async refineAndWarp(shot) {
    const c = shot.canvas, cw = c.width, ch = c.height, gd = shot.guide;
    const gR = [{ x: gd.x0 / cw, y: gd.y0 / ch }, { x: gd.x1 / cw, y: gd.y0 / ch }, { x: gd.x1 / cw, y: gd.y1 / ch }, { x: gd.x0 / cw, y: gd.y1 / ch }];
    let quad = gR, how = 'keret';
    try {
      const sc = 480 / Math.max(cw, ch), w = Math.round(cw * sc), h = Math.round(ch * sc);
      const t = document.createElement('canvas'); t.width = w; t.height = h; const tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(c, 0, 0, w, h);
      const data = tg.getImageData(0, 0, w, h).data;
      const p = this.call({ type: 'guided', w, h, buf: data.buffer, guide: gR }, [data.buffer]);
      const res = p ? (await p).res : detectCardGuided(data, w, h, gR);
      if (res && this.confident(res.quad, cw, ch, gR)) { quad = res.quad; how = 'négyszög'; this.lastSupport = res.support; }
    } catch (e) { console.warn('guided', e); }
    const src = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
    let out;
    const p = this.call({ type: 'warp', w: cw, h: ch, buf: src.buffer, quad, outW: CW, outH: CH }, [src.buffer]);
    if (p) out = new Uint8ClampedArray((await p).buf);
    else out = warpPerspective(src, cw, ch, quad.map(q => ({ x: q.x * cw, y: q.y * ch })), CW, CH);
    const o = document.createElement('canvas'); o.width = CW; o.height = CH;
    o.getContext('2d').putImageData(new ImageData(out, CW, CH), 0, 0);
    return { canvas: o, how, sharp: shot.sharp };
  }
  confident(q, cw, ch, gR) {
    const P = q.map(p => ({ x: p.x * cw, y: p.y * ch }));
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const wd = (d(P[0], P[1]) + d(P[3], P[2])) / 2, ht = (d(P[0], P[3]) + d(P[1], P[2])) / 2;
    const ar = wd / ht;
    if (!(ar > 0.64 && ar < 0.79)) return false;
    let a = 0; for (let i = 0; i < 4; i++) { const p = P[i], n = P[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
    const area = Math.abs(a) / 2 / (cw * ch);
    if (area < 0.38 || area > 0.85) return false;
    const gb = gR.map(p => ({ x: p.x * cw, y: p.y * ch }));
    const bb = pts => { const xs = pts.map(p => p.x), ys = pts.map(p => p.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
    const A = bb(P), B = bb(gb), iw = Math.min(A[2], B[2]) - Math.max(A[0], B[0]), ih = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
    if (iw <= 0 || ih <= 0) return false;
    const inter = iw * ih, uni = (A[2] - A[0]) * (A[3] - A[1]) + (B[2] - B[0]) * (B[3] - B[1]) - inter;
    if (inter / uni <= 0.55) return false;
    // a felhasználó a lapot a keretbe illeszti: a finomítás csak kis korrekció lehet (forgatás, perspektíva), nem ugorhat másik (tok / fólia / háttér) élre
    const gw = Math.hypot(gb[1].x - gb[0].x, gb[1].y - gb[0].y), dev = Math.max(...P.map((p, i) => Math.hypot(p.x - gb[i].x, p.y - gb[i].y)));
    return dev <= gw * 0.08;
  }
  async shutter() { if (this.state === 'ready') return this.capture({ manual: true }); }
  async capture({ manual = false } = {}) {
    if (this.state !== 'ready' || !this.running) return;
    const gen = ++this.gen, t0 = performance.now();
    this.setState('capturing'); this.status('');
    manual ? this.stats.manual++ : this.stats.auto++; this.stats.captures++;
    this.onProcessing?.('Kép előkészítése…', '');
    try { navigator.vibrate?.(30); } catch {}
    try {
      const lastRoi = this.hist.length ? this.hist[this.hist.length - 1].roi : null;
      const shots = await this.grabShots(3, 130);
      if (gen !== this.gen) return;
      this.refRoi = lastRoi; this.armed = false; this.chg = 0;
      shots.sort((a, b) => b.sharp - a.sharp);
      const cards = [];
      for (const s of shots) { if (gen !== this.gen) return; cards.push(await this.refineAndWarp(s)); }
      this.how = cards[0].how;
      const prepMs = Math.round(performance.now() - t0);
      this.setState('identifying');
      let n = null; try { n = await this.indexCount?.(); } catch {}
      this.onProcessing?.('Lap azonosítása…', n ? `Összevetés ${n.toLocaleString('hu-HU')} lappal` : 'Összevetés az adatbázissal');
      const res = await this.identifyShots(cards.map(c => c.canvas), gen);
      if (gen !== this.gen || !res) return;
      const info = { ms: Math.round(performance.now() - t0), prepMs, how: cards[0].how, shots: cards.length, manual };
      this.setState(res.dec ? 'result' : 'ready'); this.onProcessing?.(null);
      this.lastShot = cards[0].canvas;
      if (res.dec) { this.stats.decisions++; this.onDecision?.({ ...res.dec, ...info }); }
      else this.onFail?.(res.weak, info);
    } catch (e) {
      console.error(e);
      if (gen === this.gen) { this.setState('ready'); this.onProcessing?.(null); this.onFail?.(null, { error: e.message }); }
    }
  }
  // több kocka + több út, szavazással; mindig a legjobb tippet adja, ha nincs elég bizonyíték: gyenge (weak)
  async identifyShots(cards, gen) {
    const votes = new Map();
    const quality = o => o.sure || ['szám', 'szettkód'].some(w => o.best?.why?.includes(w)) || (o.best?.why?.includes('név') && (o.best?.sim || 0) >= 0.3) || (o.best?.why?.some(w => w.endsWith('szöveg')) && (o.best?.sim || 0) >= 0.38) || (o.best?.sim || 0) >= 0.45;
    const vote = o => {
      const b = o.best; if (!b || !quality(o)) return null;
      const k = b.lang + '|' + b.id, v = votes.get(k) || { n: 0, sure: false, o };
      v.n++; v.sure = v.sure || o.sure; if (o.sure || !v.o.sure) v.o = o; votes.set(k, v); return v;
    };
    const strong = o => o.sure && o.best?.why?.includes('szám') && (o.best.why.includes('szett-összlap') || o.best.why.includes('szettkód')) && (o.best.why.includes('név') || (o.best.sim || 0) > 0.5);
    const trace = this.trace = [];
    const t0 = performance.now(); let last = null;
    const run = async (c, fast, tag) => {
      const o = await this.recognizeFrame(c, { fast, skipNumber: false });
      trace.push({ tag, t: Math.round(performance.now() - t0), num: o.r?.number ? o.r.number + '/' + o.r.total : null, name: o.r?.name, best: o.best?.id, sure: o.sure, why: o.best?.why?.join('+') });
      last = o; return o;
    };
    const done = (v, via) => ({ dec: { ...v.o, votes: v.n, via, frames: trace.length, trace }, });
    const fin = (v, via) => { if (v.o.r) v.o.r.card = cards[0]; return done(v, via); };
    // 1) a legélesebb kocka, gyors út
    let o = await run(cards[0], true, 'gyors#1'); if (gen !== this.gen) return null;
    let v = vote(o);
    if (v && (strong(o) || (o.sure && (o.best?.sim || 0) >= 0.5 && ['szám', 'név', 'szöveg', 'szettkód'].some(w => o.best?.why?.some(x => x.includes(w)))))) return fin(v, 'első kocka');
    const over = (ms = BUDGET_MS) => performance.now() - t0 > ms;
    // 2) ugyanaz a kocka csillogás-csillapítva (olcsó, ~70 ms): a fényfolt alatti szöveg / szám gyakran így jön elő
    let dg = null; try { dg = deglare(cards[0]); } catch (e) { console.warn('deglare', e); }
    if (dg) { o = await run(dg, true, 'gyors+csillapított'); if (gen !== this.gen) return null; v = vote(o); if (v && (strong(o) || v.n >= 2)) return fin(v, v.n >= 2 ? 'szavazás' : 'csillogás-csillapítás'); }
    // 3) második kocka, gyors út → szavazás
    if (cards[1] && !over()) { o = await run(cards[1], true, 'gyors#2'); if (gen !== this.gen) return null; v = vote(o); if (v && v.n >= 2) return fin(v, 'szavazás'); }
    // 4) részletes olvasás (előbb az eredeti, majd a csillogás-csillapított változat)
    if (!over(7000)) { o = await run(cards[0], false, 'részletes'); if (gen !== this.gen) return null; v = vote(o); if (v && (o.sure || v.n >= 2)) return fin(v, 'részletes'); }
    if (dg && !over(9500)) { o = await run(dg, false, 'részletes+csillapított'); if (gen !== this.gen) return null; v = vote(o); if (v && (o.sure || v.n >= 2)) return fin(v, 'csillogás-csillapítás'); }
    if (cards[2] && !over()) { o = await run(cards[2], true, 'gyors#3'); if (gen !== this.gen) return null; v = vote(o); if (v && v.n >= 2) return fin(v, 'szavazás'); }
    // nincs biztos döntés: a legtöbb szavazatot kapott (vagy utolsó) tipp – az eredményoldal „nem biztos” jelzéssel, alternatívákkal mutatja
    const top = [...votes.values()].sort((a, b) => b.n - a.n || (b.o.best?.score || 0) - (a.o.best?.score || 0))[0];
    const weak = top ? top.o : last;
    if (weak?.r) weak.r.card = cards[0];
    if (top && quality(top.o)) return { dec: { ...top.o, votes: top.n, via: 'gyenge tipp', weak: true, frames: trace.length, trace } };
    return { dec: null, weak };
  }

  // ---- rajzolás: állandó vezetőkeret (4 fehér sarok), nincs szkennervonal ----
  draw() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.draw());
    const cv = this.overlay, v = this.video;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!v.videoWidth || this.state === 'off') return;
    // a keret a NÉZET koordinátáiban áll (nem a videóéban): nagyítástól független
    const gq = guideQuadNorm(cv.clientWidth, cv.clientHeight, v.videoWidth, v.videoHeight); if (!gq) return;
    const s = Math.max(W / v.videoWidth, H / v.videoHeight), ox = (W - v.videoWidth * s) / 2, oy = (H - v.videoHeight * s) / 2;
    const G = gq.map(p => ({ x: ox + p.x * v.videoWidth * s, y: oy + p.y * v.videoHeight * s }));
    const busy = this.state === 'capturing' || this.state === 'identifying';
    g.save(); g.strokeStyle = busy ? 'rgba(255,255,255,.35)' : '#fff'; g.lineWidth = 4 * dpr; g.lineCap = 'round'; g.lineJoin = 'round';
    const L = 0.16;
    for (let i = 0; i < 4; i++) {
      const p = G[i], n = G[(i + 1) % 4], pr = G[(i + 3) % 4];
      g.beginPath(); g.moveTo(p.x + (pr.x - p.x) * L, p.y + (pr.y - p.y) * L); g.lineTo(p.x, p.y); g.lineTo(p.x + (n.x - p.x) * L, p.y + (n.y - p.y) * L); g.stroke();
    }
    g.restore();
    if (this.debug) {
      g.save(); g.font = `${11 * dpr}px ui-monospace,monospace`; g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 150 * dpr, W, 78 * dpr); g.fillStyle = '#9fffb7';
      const hh = this.hist.length ? this.hist[this.hist.length - 1] : null;
      [`állapot ${this.state} · ${this.fps.toFixed(1)} fps · videó ${v.videoWidth}×${v.videoHeight} · nagyítás ${this.zoom}×`,
        `élesség ${Math.round(this.sharp)} (min ${SHARP_G}) · mozgás ${this.motion.toFixed(2)} · tartalom-szórás ${hh ? hh.roi.std.toFixed(0) : '–'} · lap-alakzat ${this.quadOk ? 'igen' : 'nem'} · fegyverkezve ${this.armed ? 'igen' : 'nem'} Δ${this.lastD.toFixed(2)}`,
        `kioldás ${this.stats.captures} (auto ${this.stats.auto} / kézi ${this.stats.manual}) · döntés ${this.stats.decisions} · kivágás: ${this.how} · worker ${this.worker ? 'igen' : 'nem'}`].forEach((t, i) => g.fillText(t, 8 * dpr, (166 + i * 16) * dpr));
      g.restore();
    }
  }
}
