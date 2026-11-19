// Okemon Scanner – élő, automatikus kártyafelismerés.
// Folyamat: kamera → kicsinyített képkockák (~8/mp) → kártya-négyszög keresése (Web Worker) → stabil + éles?
// → zöld keret + szkennervonal → perspektíva-korrigált kivágás (Worker) → felismerés (gyors út, 2–3 kocka szavazása;
// ha kell, részletes út) → döntés → eredmény-kártya. Ugyanazt a lapot nem ismeri fel újra, amíg ki nem kerül a képből.
import { detectQuad, warpPerspective } from './detect-core.js';
import { artPrint, printSim, CW, CH } from './recognize.js';

const TICK_MS = 120;          // ~8 képkocka/mp a figyeléshez
const DETECT_MAX = 480;       // a figyelő képkocka hosszabb oldala (px)
const STABLE_MS = 450;        // ennyi ideig egy helyben → stabil
const STABLE_TOL = 0.03;      // sarok-elmozdulás tűrése (a képkocka arányában)
const SHARP_MIN = 120;        // Laplace-variancia alsó határa (alatta: elmosódott)
const GONE_MS = 650;          // ennyi ideig nincs lap → kikerült a képből
const TIMEOUT_MS = 4500;      // ennyi idő alatt nincs döntés → „Nem ismerem fel”
const SAME_CARD_SIM = 0.5;    // képi hasonlóság e fölött: ugyanaz a lap (duplázásvédelem)

export const CAMERA_HELP = {
  NotAllowedError: 'A kamera nincs engedélyezve. iPhone-on: Beállítások › Safari › Kamera › „Engedélyezés”, vagy a címsor „aA” menüjében: Webhely-beállítások › Kamera. Főképernyőre tett appnál: Beállítások › Adatvédelem › Kamera. Utána koppints a „Kamera indítása” gombra.',
  NotFoundError: 'Nem található kamera ezen az eszközön. Használd a „Fotó” gombot.',
  NotReadableError: 'A kamerát most egy másik alkalmazás használja. Zárd be, majd koppints a „Kamera indítása” gombra.',
  SecurityError: 'A kamera csak biztonságos (https://) kapcsolaton működik.',
  insecure: 'A kamera csak https:// címen működik (pl. a GitHub Pages linken). Addig a „Fotó” gombbal tudsz lapot beolvasni.',
};

export class LiveScanner {
  constructor({ video, overlay, recognizeFrame, onDecision, onFail, onStatus, onState }) {
    Object.assign(this, { video, overlay, recognizeFrame, onDecision, onFail, onStatus, onState });
    this.state = 'off'; this.gen = 0; this.hist = []; this.quad = null; this.lastSeen = 0;
    this.small = document.createElement('canvas'); this.full = document.createElement('canvas');
    this.reqId = 0; this.pending = new Map();
    try {
      this.worker = new Worker(new URL('./detect-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => { const p = this.pending.get(e.data.id); if (p) { this.pending.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); } };
      this.worker.onerror = () => { this.worker = null; };
    } catch { this.worker = null; } // tartalék: fő szálon
    this.stats = { detections: 0, decisions: 0, frames: 0 };
  }
  call(msg, transfer) {
    if (!this.worker) return null;
    const id = ++this.reqId;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.worker.postMessage({ ...msg, id }, transfer); });
  }
  setState(s, info) { if (this.state !== s) { this.state = s; this.onState?.(s, info); } }
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
    this.setState('searching'); this.status('Tarts egy kártyát a kamera elé');
    this.loop(); this.draw();
    return true;
  }
  stop() {
    this.running = false; this.gen++;
    clearTimeout(this.timer); cancelAnimationFrame(this.raf);
    if (this.stream && this.ownStream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.video.srcObject = null; this.quad = null; this.hist = [];
    this.setState('off');
    const g = this.overlay.getContext('2d'); g.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
  // az eredmény-kártya bezárása után: figyelés tovább, de ugyanazt a lapot ne ismerje fel újra
  resume({ print = null, id = null } = {}) {
    this.lastPrint = print || this.lastPrint; this.lastPrintCheck = performance.now();
    if (id) this.lastId = id; // amíg a lap a képben marad, ugyanez az azonosító nem ad új találatot
    this.setState(this.quad ? 'cooldown' : 'searching');
    this.status(this.quad ? 'Kész – vedd el a lapot, vagy tedd be a következőt' : 'Tarts egy kártyát a kamera elé');
  }
  retry() { this.lastPrint = null; this.lastId = null; this.setState('searching'); this.hist = []; }

  // ---- figyelő ciklus ----
  loop() {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick().finally(() => this.loop()), TICK_MS);
  }
  async tick() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return;
    const sc = DETECT_MAX / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.round(v.videoWidth * sc), h = Math.round(v.videoHeight * sc);
    if (this.small.width !== w || this.small.height !== h) { this.small.width = w; this.small.height = h; }
    const g = this.small.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    let res;
    try {
      const p = this.call({ type: 'detect', w, h, buf: data.buffer }, [data.buffer]);
      res = p ? (await p).res : (r => r && { quad: r.quad, area: r.area, ratio: r.ratio, sharp: r.sharp })(detectQuad(data, w, h));
    } catch { res = null; }
    this.stats.frames++;
    this.onDetect(res, performance.now());
  }
  onDetect(res, now) {
    if (res) {
      this.lastSeen = now; this.quad = res.quad; this.sharp = res.sharp;
      this.hist.push({ t: now, q: res.quad, sharp: res.sharp });
      this.hist = this.hist.filter(h => now - h.t < 900);
    } else if (now - this.lastSeen > GONE_MS) {
      // a lap kikerült a képből → új lap jöhet; a folyamatban lévő felismerés megszakad
      if (this.quad || this.state === 'cooldown' || this.state === 'failed') {
        this.quad = null; this.hist = []; this.lastPrint = null; this.lastId = null;
        if (this.state !== 'result') { this.gen++; this.setState('searching'); this.status('Tarts egy kártyát a kamera elé'); }
      }
      return;
    }
    if (!this.quad || this.state === 'result') return;
    const stable = this.isStable(now), sharp = (this.sharp || 0) >= SHARP_MIN;
    if (this.state === 'searching') {
      this.setState('tracking'); this.stats.detections++;
      try { navigator.vibrate?.(30); } catch {}
    }
    if (this.state === 'tracking') {
      if (!sharp) this.status('Tartsd stabilan – a kép elmosódott', 'warn');
      else if (!stable) this.status('Tartsd stabilan…');
      else this.recognizeLoop();
    } else if (this.state === 'cooldown' && stable && sharp && now - (this.lastPrintCheck || 0) > 1000) {
      this.lastPrintCheck = now;
      this.checkNewCard();
    }
  }
  isStable(now) {
    const recent = this.hist.filter(h => now - h.t <= STABLE_MS + 60);
    if (recent.length < 3 || now - recent[0].t < STABLE_MS * 0.8) return false;
    const a = recent[0].q;
    return recent.every(h => h.q.every((p, i) => Math.hypot(p.x - a[i].x, p.y - a[i].y) < STABLE_TOL));
  }
  // perspektíva-korrigált, teljes felbontású kivágás az aktuális négyszögből
  async captureCard() {
    const v = this.video, q = this.quad;
    if (!q || !v.videoWidth) return null;
    const W = v.videoWidth, H = v.videoHeight;
    if (this.full.width !== W || this.full.height !== H) { this.full.width = W; this.full.height = H; }
    const g = this.full.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, W, H);
    const src = g.getImageData(0, 0, W, H).data;
    let out;
    const p = this.call({ type: 'warp', w: W, h: H, buf: src.buffer, quad: q, outW: CW, outH: CH }, [src.buffer]);
    if (p) out = new Uint8ClampedArray((await p).buf);
    else out = warpPerspective(src, W, H, q.map(pt => ({ x: pt.x * W, y: pt.y * H })), CW, CH);
    const c = document.createElement('canvas'); c.width = CW; c.height = CH;
    c.getContext('2d').putImageData(new ImageData(out, CW, CH), 0, 0);
    return c;
  }
  async checkNewCard() {
    const gen = this.gen;
    const c = await this.captureCard().catch(() => null);
    if (!c || gen !== this.gen || this.state !== 'cooldown') return;
    const sim = this.lastPrint ? printSim(artPrint(c), this.lastPrint) : 0;
    if (sim < SAME_CARD_SIM) { this.lastPrint = null; this.setState('tracking'); }
  }
  // ---- felismerés több képkockán, szavazással ----
  async recognizeLoop() {
    if (this.state === 'recognizing') return;
    const gen = ++this.gen;
    this.setState('recognizing'); this.status('Felismerés…');
    const t0 = performance.now(), votes = new Map();
    this.trace = []; // diagnosztika: képkockánkénti eredmény
    let frames = 0, last = null, lastCanvas = null;
    // szavazni csak érdemi bizonyítékkal lehet: biztos találat, szöveges egyezés (szám / név / szettkód), vagy erős képi egyezés.
    // (gyenge, csak képi tipp – pl. egy nem letöltött szett lapja helyett a leghasonlóbb ismert lap – nem dönthet)
    const quality = o => o.sure || ['szám', 'szettkód'].some(w => o.best?.why?.includes(w)) || (o.best?.why?.includes('név') && (o.best?.sim || 0) >= 0.3) || (o.best?.why?.some(w => w.endsWith('szöveg')) && (o.best?.sim || 0) >= 0.38) || (o.best?.sim || 0) >= 0.45;
    const vote = (o) => {
      const b = o.best; if (!b || !quality(o)) return null;
      const k = b.lang + '|' + b.id, v = votes.get(k) || { n: 0, sure: false, o };
      v.n++; v.sure = v.sure || o.sure; if (o.sure || !v.o.sure) v.o = o; votes.set(k, v);
      return v;
    };
    const strong = o => o.sure && o.best?.why?.includes('szám') && (o.best.why.includes('szett-összlap') || o.best.why.includes('szettkód')) && (o.best.why.includes('név') || (o.best.sim || 0) > 0.5);
    const decide = (v, via) => {
      if (gen !== this.gen) return;
      const key = v.o.best.lang + '|' + v.o.best.id;
      if (this.lastId && key === this.lastId) { // ugyanaz a lap, ki sem került a képből → nem duplázunk
        this.stats.suppressed = (this.stats.suppressed || 0) + 1;
        this.setState('cooldown'); this.lastPrintCheck = performance.now(); this.status('Kész – vedd el a lapot, vagy tedd be a következőt');
        return;
      }
      this.stats.decisions++;
      this.setState('result');
      this.status('');
      this.onDecision?.({ ...v.o, votes: v.n, auto: v.n >= 2 && v.sure, via, ms: Math.round(performance.now() - t0), frames });
    };
    try {
      while (gen === this.gen && this.running) {
        if (performance.now() - t0 > TIMEOUT_MS) break;
        const c = await this.captureCard();
        if (!c || gen !== this.gen) return;
        frames++; lastCanvas = c;
        last = await this.recognizeFrame(c, { fast: true, skipNumber: frames > 1 && last && !last.r?.number });
        if (gen !== this.gen) return;
        this.trace.push({ t: Math.round(performance.now() - t0), num: last.r?.number ? last.r.number + '/' + last.r.total : null, name: last.r?.name, codes: last.r?.setCodes, best: last.best?.id, sure: last.sure, sim: last.best?.sim, why: last.best?.why?.join('+'), n: last.cands?.length, img: (c => c ? c.id + ' ' + (c.sim || 0).toFixed(2) : null)(last.cands?.filter(c => c.sim != null).sort((a, b) => b.sim - a.sim)[0]) });
        const v = vote(last);
        if (v && (v.n >= 2 || (frames === 1 && strong(last)))) return decide(v, v.n >= 2 ? 'szavazás' : 'erős első kocka');
        if (frames >= 3) break;
      }
      if (gen !== this.gen) return;
      const detailed = async () => {
        const o = await this.recognizeFrame(lastCanvas, { fast: false });
        if (gen !== this.gen) return false;
        this.trace.push({ detailed: true, t: Math.round(performance.now() - t0), num: o.r?.number ? o.r.number + '/' + o.r.total : null, name: o.r?.name, best: o.best?.id, sure: o.sure, why: o.best?.why?.join('+') });
        const v = vote(o);
        if (v && (o.sure || v.n >= 2)) { decide(v, 'részletes'); return true; }
        return false;
      };
      // részletes út: ha a gyors út 3 kockán sem döntött, és még van idő
      if (lastCanvas && performance.now() - t0 < 2600) {
        this.status('Részletes olvasás…');
        if (await detailed()) return;
        if (gen !== this.gen) return;
      } else if (lastCanvas) {
        // nincs idő: sárga jelzés MOST, de a részletes olvasás a háttérben még lefut – ha biztos, mégis felhozzuk
        this.setState('failed');
        this.status('Nem ismerem fel. Próbáld jobb fényben, tükröződés nélkül', 'fail');
        this.onFail?.(last, { ms: Math.round(performance.now() - t0), frames });
        this.state = 'recognizing-bg';
        if (await detailed()) return;
        if (gen !== this.gen) return;
      }
      // nincs döntés: sárga keret, a legjobb tippek felajánlva (nem adjuk hozzá magától)
      const top = [...votes.values()].sort((a, b) => b.n - a.n || (b.o.best?.score || 0) - (a.o.best?.score || 0))[0];
      this.state = 'recognizing'; this.setState('failed');
      this.status('Nem ismerem fel. Próbáld jobb fényben, tükröződés nélkül', 'fail');
      this.onFail?.(top ? top.o : last, { ms: Math.round(performance.now() - t0), frames });
    } catch (e) {
      console.error(e);
      if (gen === this.gen) { this.setState('failed'); this.status('Hiba a felismerésben: ' + e.message, 'fail'); this.onFail?.(null, {}); }
    }
  }

  // ---- rajzolás: zöld keret + fel-le futó szkennervonal ----
  draw() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.draw());
    const cv = this.overlay, v = this.video;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!this.quad || !v.videoWidth || this.state === 'off') return;
    // object-fit: cover leképezés
    const s = Math.max(W / v.videoWidth, H / v.videoHeight);
    const ox = (W - v.videoWidth * s) / 2, oy = (H - v.videoHeight * s) / 2;
    const P = this.quad.map(p => ({ x: ox + p.x * v.videoWidth * s, y: oy + p.y * v.videoHeight * s }));
    const fail = this.state === 'failed' || this.state === 'recognizing-bg', dim = this.state === 'cooldown';
    const col = fail ? '#ffc61a' : '#2dff7a';
    g.save();
    g.globalAlpha = dim ? 0.45 : 1;
    g.lineJoin = 'round'; g.lineWidth = 4 * dpr; g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = 16 * dpr;
    g.beginPath(); P.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.stroke();
    g.fillStyle = fail ? 'rgba(255,198,26,.08)' : 'rgba(45,255,122,.07)'; g.fill();
    if (this.state === 'tracking' || this.state === 'recognizing') {
      const t = (Math.sin(performance.now() / (this.state === 'recognizing' ? 260 : 420)) + 1) / 2;
      const a = { x: P[0].x + (P[3].x - P[0].x) * t, y: P[0].y + (P[3].y - P[0].y) * t };
      const b = { x: P[1].x + (P[2].x - P[1].x) * t, y: P[1].y + (P[2].y - P[1].y) * t };
      const grd = g.createLinearGradient(a.x, a.y, b.x, b.y);
      grd.addColorStop(0, 'rgba(45,255,122,0)'); grd.addColorStop(0.5, 'rgba(45,255,122,1)'); grd.addColorStop(1, 'rgba(45,255,122,0)');
      g.strokeStyle = grd; g.lineWidth = 5 * dpr; g.shadowBlur = 26 * dpr;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    g.restore();
  }
}
