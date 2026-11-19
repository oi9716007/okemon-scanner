// Élő szkenner: kamerakép → kártya-négyszög → zöld keret → felismerés a háttérszálon.
// Ugyanazt a lapot nem ismeri fel újra, amíg a képben marad.
import { detectQuadImageData, laplacianVariance, quadDelta, warpCard } from './detect.js';
import { recognize } from './recognize.js';

const DETECT_FPS = 8;
const STABLE_MS = 500;
const GONE_FRAMES = 6;
const SHARP_MIN = 80;
const FAIL_MS = 3600;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function verySure(res) {
  const best = res?.best, cands = res?.cands || [];
  if (!res?.sure || !best) return false;
  const margin = best.score - (cands[1]?.score || 0);
  const numbered = (best.why || []).some(w => w === 'szám' || String(w).startsWith('szám'));
  return best.score >= 9 && margin >= 3 && (numbered || (best.sim || 0) >= 0.5);
}

function voteReads(a, b) {
  if (!b?.number) return a;
  if (!a?.number) return b;
  const same = parseInt(a.number, 10) === parseInt(b.number, 10) && +a.total === +b.total;
  if (same) {
    const codes = [...new Set([...(a.setCodes || []), ...(b.setCodes || [])])];
    return { ...a, setCodes: codes, numberSure: true, numberVotes: (a.numberVotes || 1) + (b.numberVotes || 1) };
  }
  const pick = (a.numberVotes || 0) >= (b.numberVotes || 0) ? a : b;
  return { ...pick, numberSure: false };
}

export function createLive(host) {
  const video = host.video;
  const overlay = host.overlay;
  let worker = null, workerReady = null, workerBroken = false;
  let seq = 0;
  const pending = new Map();
  let running = false, timer = 0, raf = 0;
  let external = false;
  let phase = 'watching'; // watching | arming | scanning | result | added | fail
  let frameColor = 'none';
  let scanLine = false;
  let quad = null;
  let lockQuad = null;
  let gone = 0;
  let hits = 0;
  let gen = 0;
  let history = [];
  let lastResult = null; // { r, id, chosen }
  let failTimer = 0;
  let undoTimer = 0;
  let addedThisLock = false;
  const small = typeof document === 'undefined' ? null : document.createElement('canvas');
  const grabC = typeof document === 'undefined' ? null : document.createElement('canvas');

  function post(msg, transfer) {
    return new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      worker.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }

  function onWorkerMessage(e) {
    const m = e.data || {};
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.rej(new Error(m.message || 'worker'));
    else p.res(m);
  }

  function ensureWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker(new URL('./scan-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = onWorkerMessage;
      worker.onerror = (ev) => {
        workerBroken = true;
        pending.forEach(p => p.rej(new Error(ev.message || 'A felismerő szál leállt')));
        pending.clear();
      };
    } catch (e) {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  function warmup(langs = ['eng', 'jpn']) {
    if (workerReady) return workerReady;
    const w = ensureWorker();
    if (!w) { workerReady = Promise.resolve(false); return workerReady; }
    workerReady = post({ type: 'warmup', langs }).then(() => true).catch(err => {
      console.warn('OCR worker', err);
      workerBroken = true;
      return false;
    });
    return workerReady;
  }

  async function recognizeBitmap(bitmap, quadPx, fast, opts) {
    const w = ensureWorker();
    if (w && !workerBroken) {
      try {
        const msg = await post({
          type: 'recognize', fast, quad: quadPx, bitmap,
          lang: opts.lang, totals: opts.totals, jaSetIds: opts.jaSetIds,
        }, [bitmap]);
        return msg;
      } catch (err) {
        console.warn('worker recognize', err);
      }
    }
    try { bitmap.close?.(); } catch { /* már átadva */ }
    // Tartalék: a főszálon, ha a worker nem elérhető (a kép már átadódott, újra kell venni).
    throw new Error('worker');
  }

  async function recognizeOnMain(src, fast, opts) {
    const r = await recognize(src, { fast, normalized: true, lang: opts.lang, totals: opts.totals, jaSetIds: opts.jaSetIds });
    return {
      number: r.number, total: r.total, setCodes: r.setCodes, numberSure: !!r.numberSure,
      numberVotes: r.numberVotes || 0, name: r.name || '', ms: r.ms, jobs: r.numberJobs,
      fast: !!r.fast, print: r.print, card: r.card,
    };
  }

  function sample() {
    const v = video();
    if (!v?.videoWidth || !small) return null;
    const MAX = 320;
    const sc = MAX / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.max(1, Math.round(v.videoWidth * sc));
    const h = Math.max(1, Math.round(v.videoHeight * sc));
    small.width = w; small.height = h;
    const g = small.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, w, h);
    const q = detectQuadImageData(g.getImageData(0, 0, w, h));
    if (!q) return { quad: null, sharp: 0 };
    const inv = 1 / sc;
    const quadV = {
      points: q.points.map(p => ({ x: p.x * inv, y: p.y * inv })),
      aspect: q.aspect, areaRatio: q.areaRatio, rectangularity: q.rectangularity,
    };
    const sharp = laplacianVariance(small, q);
    return { quad: quadV, sharp };
  }

  function stable(q, sharp) {
    const now = performance.now();
    history.push({ t: now, quad: q, sharp });
    while (history.length && now - history[0].t > 800) history.shift();
    const win = history.filter(s => now - s.t <= STABLE_MS + 80);
    if (win.length < 3) return false;
    if (win[win.length - 1].t - win[0].t < STABLE_MS - 80) return false;
    const base = win[0].quad;
    if (!win.every(s => quadDelta(base, s.quad) < 0.055)) return false;
    if (win.some(s => s.sharp < SHARP_MIN)) return false;
    return true;
  }

  function grab(maxW, q) {
    const v = video();
    const sc = Math.min(1, maxW / v.videoWidth);
    const w = Math.max(1, Math.round(v.videoWidth * sc));
    const h = Math.max(1, Math.round(v.videoHeight * sc));
    grabC.width = w; grabC.height = h;
    grabC.getContext('2d').drawImage(v, 0, 0, w, h);
    const copy = document.createElement('canvas');
    copy.width = w; copy.height = h;
    copy.getContext('2d').drawImage(grabC, 0, 0);
    const s = w / v.videoWidth;
    const quadPx = q ? { points: q.points.map(p => ({ x: p.x * s, y: p.y * s })) } : null;
    return { canvas: copy, quadPx, bitmap: createImageBitmap(copy) };
  }

  function cardFromPreview(preview, fallback) {
    if (preview?.width) {
      const c = document.createElement('canvas');
      c.width = preview.width; c.height = preview.height;
      c.getContext('2d').drawImage(preview, 0, 0);
      preview.close?.();
      return c;
    }
    return fallback || null;
  }

  function toRead(msg, card) {
    return {
      card,
      print: msg.print,
      number: msg.number || null,
      total: msg.total || null,
      setCodes: msg.setCodes || [],
      name: msg.name || '',
      numberSure: !!msg.numberSure,
      numberVotes: msg.numberVotes || 0,
      raw: {},
      ms: msg.ms || 0,
      fast: msg.fast !== false,
    };
  }

  async function runRecognize(my) {
    await host.ensureCatalog();
    if (my !== gen) return null;
    const opts = { lang: host.lang(), totals: host.totals(), jaSetIds: host.jaSetIds() };
    const q = lockQuad;
    let shot;
    try { shot = grab(1100, q); } catch { return null; }
    const bmp1 = await shot.bitmap;
    if (my !== gen) { bmp1.close?.(); return null; }
    await new Promise(r => setTimeout(r, 120));
    let shot2 = null;
    try { shot2 = grab(1100, lockQuad || q); } catch {}
    const bmp2 = shot2 ? await shot2.bitmap : null;
    if (my !== gen) { bmp1.close?.(); bmp2?.close?.(); return null; }
    let msg;
    try {
      msg = await recognizeBitmap(bmp1, shot.quadPx, true, opts);
    } catch {
      // a bitmap már átkerült vagy eldobódott: a vászonmásolatból olvasunk a főszálon
      const copy = document.createElement('canvas');
      copy.width = shot.canvas.width; copy.height = shot.canvas.height;
      copy.getContext('2d').drawImage(shot.canvas, 0, 0);
      const warped = shot.quadPx ? warpCard(copy, shot.quadPx, 900) : copy;
      msg = await recognizeOnMain(warped, true, opts);
    }
    if (my !== gen) return null;
    let card = cardFromPreview(msg.preview, null);
    if (!msg.numberSure && bmp2) {
      let msg2 = null;
      try { msg2 = await recognizeBitmap(bmp2, shot2.quadPx, true, opts); }
      catch { bmp2.close?.(); }
      if (msg2) {
        const voted = voteReads(msg, msg2);
        card = cardFromPreview(msg2.preview, card) || card;
        msg = { ...msg, ...voted, print: voted.print || msg.print, preview: undefined };
      }
    } else bmp2?.close?.();
    if (!card && shot.quadPx) {
      const copy = document.createElement('canvas');
      copy.width = shot.canvas.width; copy.height = shot.canvas.height;
      copy.getContext('2d').drawImage(shot.canvas, 0, 0);
      card = warpCard(copy, shot.quadPx, 900);
    }
    let r = toRead(msg, card);
    if (my !== gen) return null;
    host.status('Keresés az adatbázisban…');
    let id = await host.identify(r, { fast: true });
    if (my !== gen) return null;
    if (!id.sure && !r.number) {
      host.status('Részletes olvasás…');
      const shot3 = grab(1100, lockQuad || q);
      const bmp3 = await shot3.bitmap;
      let slow = null;
      try { slow = await recognizeBitmap(bmp3, shot3.quadPx, false, opts); }
      catch {
        const copy = document.createElement('canvas');
        copy.width = shot3.canvas.width; copy.height = shot3.canvas.height;
        copy.getContext('2d').drawImage(shot3.canvas, 0, 0);
        slow = await recognizeOnMain(shot3.quadPx ? warpCard(copy, shot3.quadPx, 900) : copy, false, opts);
      }
      if (my !== gen) return null;
      if (slow?.number || slow?.name) {
        const card2 = cardFromPreview(slow.preview, card);
        r = toRead(slow, card2 || card);
        id = await host.identify(r, { fast: false });
      }
    }
    return { r, id };
  }

  function hideCard() {
    const el = document.getElementById('liveCard');
    if (!el) return;
    el.classList.remove('show');
    el.hidden = true;
    el.innerHTML = '';
  }

  function showFail() {
    const el = document.getElementById('liveCard');
    if (!el) return;
    el.hidden = false;
    el.classList.add('show');
    el.innerHTML = `<div class="lc-fail">
      <b>Nem ismerem fel.</b>
      <p>Próbáld jobb fényben, tükröződés nélkül.</p>
      <button class="btn" id="lcFailManual" type="button">Kézi keresés</button>
    </div>`;
    document.getElementById('lcFailManual').onclick = () => host.openManual('', '');
  }

  function priceLine(view) {
    if (view.priceState === 'wait') return 'Ár…';
    if (view.priceState === 'err') return 'az ár most nem elérhető';
    if (view.priceState === 'none') return 'nincs ár';
    return view.priceText;
  }

  function paintCard() {
    const el = document.getElementById('liveCard');
    const view = lastResult?.view;
    if (!el || !view) return;
    const c = view.cand;
    const src = c.image ? c.image + '/low.webp' : (c.imgUrl || '');
    const lang = c.lang === 'ja' ? 'Japán' : 'Angol';
    const num = `${esc(c.localId)}${c.official ? '/' + esc(c.official) : ''}`;
    const owned = view.qty > 0 ? `<div class="lc-owned">Már megvan: ${view.qty} db</div>` : '';
    const alts = view.alts || [];
    el.hidden = false;
    el.classList.add('show');
    el.innerHTML = `<div class="lc-main">
      ${src ? `<img alt="" src="${esc(src)}">` : `<div class="noimg lc-ph">${esc(c.name)}</div>`}
      <div class="lc-txt">
        <div class="lc-name">${esc(c.name)}</div>
        <div class="lc-set">${esc(c.setName || c.setId)} · ${num}</div>
        <div class="lc-meta">${lang}${view.rarity ? ' · ' + esc(view.rarity) : ''}</div>
        <div class="lc-price ${view.priceState === 'none' ? 'noprice' : ''}">${esc(priceLine(view))}</div>
        ${owned}
      </div>
    </div>
    <div class="lc-actions">
      <button class="btn add" id="lcAdd" type="button">Hozzáadás</button>
      <button class="btn" id="lcNo" type="button">Nem ez</button>
    </div>
    <div class="lc-alts" id="lcAlts" ${view.showAlts ? '' : 'hidden'}></div>`;
    document.getElementById('lcAdd').onclick = () => onAdd();
    document.getElementById('lcNo').onclick = () => onReject();
    const box = document.getElementById('lcAlts');
    if (view.showAlts) {
      const cells = alts.map((a, i) => {
        const im = a.image ? a.image + '/low.webp' : (a.imgUrl || '');
        return `<button type="button" class="cand" data-alt="${i}">${im ? `<img alt="" src="${esc(im)}">` : `<div class="noimg">${esc(a.name)}</div>`}<b>${esc(a.name)}</b><small>${esc(a.setName || '')} ${esc(a.localId)}</small></button>`;
      }).join('');
      box.innerHTML = cells + `<button type="button" class="btn small" id="lcManual">Kézi keresés</button>`;
      box.querySelectorAll('[data-alt]').forEach(b => b.onclick = () => chooseAlt(+b.dataset.alt));
      document.getElementById('lcManual').onclick = () => host.openManual(lastResult.r.name || '', lastResult.r.number || '');
    }
  }

  async function fillPrice(cand) {
    const view = lastResult.view;
    view.priceState = 'wait';
    view.rarity = '';
    view.qty = host.ownedQty(cand.id);
    paintCard();
    try {
      const rec = await host.cardRecord(cand);
      if (lastResult?.view?.cand !== cand && lastResult?.view?.cand?.id !== cand.id) return;
      view.rarity = rec.rarity || '';
      view.qty = host.ownedQty(rec.apiId || cand.id);
      if (rec.price == null) view.priceState = 'none';
      else {
        const h = host.hufOf(rec);
        view.priceState = h == null ? 'err' : 'ok';
        view.priceText = h == null ? '' : host.fmtHuf(h);
      }
      if (rec.imageSmall && !cand.image && !cand.imgUrl) cand.imgUrl = rec.imageSmall;
    } catch {
      if (lastResult?.view?.cand?.id === cand.id) view.priceState = 'err';
    }
    if (phase === 'result') paintCard();
  }

  function present(found) {
    const { r, id } = found;
    const cands = id.cands || [];
    const best = id.best || cands[0];
    if (!best) {
      phase = 'fail';
      frameColor = 'yellow';
      scanLine = false;
      host.status('Nem ismerem fel. Próbáld jobb fényben, tükröződés nélkül');
      showFail();
      return;
    }
    hits++;
    phase = 'result';
    frameColor = 'green';
    scanLine = true;
    host.status('');
    const alts = cands.filter(c => c !== best).slice(0, 4);
    lastResult = { r, id, cand: best, view: { cand: best, alts, showAlts: false, priceState: 'wait', rarity: '', qty: 0, priceText: '' } };
    clearTimeout(failTimer);
    paintCard();
    fillPrice(best);
    if (host.quick() && verySure(id) && !addedThisLock) quickAdd();
  }

  async function onAdd() {
    if (!lastResult || addedThisLock || phase === 'added') return;
    const btn = document.getElementById('lcAdd');
    if (btn) btn.disabled = true;
    addedThisLock = true;
    try {
      await host.addCandidate(lastResult.view.cand, lastResult.r);
      phase = 'added';
      hideCard();
      host.status('');
    } catch (e) {
      addedThisLock = false;
      if (btn) btn.disabled = false;
      host.toast('Hiba: ' + e.message);
    }
  }

  async function quickAdd() {
    if (addedThisLock || !lastResult) return;
    addedThisLock = true;
    const cand = lastResult.view.cand;
    try {
      await host.addCandidate(cand, lastResult.r);
      phase = 'added';
      hideCard();
      const bar = document.getElementById('undoBar');
      if (bar) {
        bar.hidden = false;
        bar.innerHTML = `Hozzáadva: ${esc(cand.name)} <button type="button" id="lcUndo">Visszavonás</button>`;
        document.getElementById('lcUndo').onclick = async () => {
          clearTimeout(undoTimer);
          bar.hidden = true;
          await host.undoLast();
          addedThisLock = false;
          phase = 'result';
          paintCard();
        };
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => { bar.hidden = true; }, 2000);
      }
    } catch (e) {
      addedThisLock = false;
      host.toast('Hiba: ' + e.message);
    }
  }

  function onReject() {
    if (!lastResult) return;
    lastResult.view.showAlts = !lastResult.view.showAlts;
    paintCard();
  }

  function chooseAlt(i) {
    const alt = lastResult?.view?.alts?.[i];
    if (!alt) return;
    lastResult.view.cand = alt;
    lastResult.view.showAlts = false;
    lastResult.view.priceState = 'wait';
    paintCard();
    fillPrice(alt);
  }

  function releaseLock() {
    lockQuad = null;
    addedThisLock = false;
    gone = 0;
    history = [];
    gen++;
    clearTimeout(failTimer);
    if (phase !== 'watching') {
      phase = 'watching';
      frameColor = 'none';
      scanLine = false;
      hideCard();
      host.status('Tartsd a lapot a kamera elé');
    }
  }

  async function tick() {
    if (!running) return;
    const s = sample();
    if (!s) return;
    const held = phase === 'scanning' || phase === 'result' || phase === 'added' || phase === 'fail';
    if (s.quad) {
      quad = s.quad;
      if (held && lockQuad && quadDelta(lockQuad, s.quad) < 0.22) {
        gone = 0;
        lockQuad = s.quad;
        if (phase !== 'fail') frameColor = 'green';
      } else if (held && lockQuad && quadDelta(lockQuad, s.quad) >= 0.22) {
        gone++;
        if (gone >= GONE_FRAMES) releaseLock();
      } else if (!held) {
        frameColor = 'green';
        scanLine = true;
        if (s.sharp < SHARP_MIN) {
          phase = 'arming';
          history = [];
          host.status('Tartsd stabilan');
        } else if (stable(s.quad, s.sharp)) {
          if (!host.isBusy() && phase !== 'scanning') beginScan(s.quad);
        } else {
          phase = 'arming';
          host.status('Tartsd stabilan');
        }
      }
    } else {
      quad = held ? quad : null;
      if (held) {
        gone++;
        if (gone >= GONE_FRAMES) releaseLock();
      } else {
        history = [];
        frameColor = 'none';
        scanLine = false;
        if (phase !== 'watching') phase = 'watching';
        if (!host.preparing()) host.status('Tartsd a lapot a kamera elé');
      }
    }
  }

  function beginScan(q) {
    phase = 'scanning';
    lockQuad = q;
    gone = 0;
    frameColor = 'green';
    scanLine = true;
    addedThisLock = false;
    const my = ++gen;
    host.status('Felismerés…');
    if (navigator.vibrate) navigator.vibrate(35);
    clearTimeout(failTimer);
    failTimer = setTimeout(() => {
      if (my !== gen || phase !== 'scanning') return;
      frameColor = 'yellow';
      host.status('Nem ismerem fel. Próbáld jobb fényben, tükröződés nélkül');
      showFail();
    }, FAIL_MS);
    runRecognize(my).then(found => {
      if (my !== gen || !found) return;
      clearTimeout(failTimer);
      present(found);
    }).catch(err => {
      if (my !== gen) return;
      console.error(err);
      clearTimeout(failTimer);
      phase = 'fail';
      frameColor = 'yellow';
      host.status('Nem ismerem fel. Próbáld jobb fényben, tükröződés nélkül');
      showFail();
    });
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    const cv = overlay();
    const v = video();
    if (!cv || !v) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!quad || frameColor === 'none' || !v.videoWidth) return;
    const vr = v.getBoundingClientRect();
    const s = Math.max(vr.width / v.videoWidth, vr.height / v.videoHeight);
    const ox = (vr.width - v.videoWidth * s) / 2 + (vr.left - rect.left);
    const oy = (vr.height - v.videoHeight * s) / 2 + (vr.top - rect.top);
    const pts = quad.points.map(p => ({ x: (ox + p.x * s) * dpr, y: (oy + p.y * s) * dpr }));
    g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
    g.closePath();
    g.lineWidth = 3 * dpr;
    g.strokeStyle = frameColor === 'yellow' ? '#f5c518' : '#3dff86';
    g.shadowColor = g.strokeStyle;
    g.shadowBlur = 12;
    g.stroke();
    if (scanLine && frameColor === 'green') {
      const t = (Math.sin(performance.now() / 320) + 1) / 2;
      const a = { x: pts[0].x + (pts[3].x - pts[0].x) * t, y: pts[0].y + (pts[3].y - pts[0].y) * t };
      const b = { x: pts[1].x + (pts[2].x - pts[1].x) * t, y: pts[1].y + (pts[2].y - pts[1].y) * t };
      g.beginPath();
      g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
      g.strokeStyle = '#b8ffd4';
      g.lineWidth = 2.5 * dpr;
      g.shadowBlur = 16;
      g.stroke();
    }
  }

  function start() {
    if (running) return;
    running = true;
    if (!raf) draw();
    timer = setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, 1000 / DETECT_FPS);
    if (phase === 'watching') host.status('Tartsd a lapot a kamera elé');
  }

  function stop() {
    running = false;
    clearInterval(timer); timer = 0;
    cancelAnimationFrame(raf); raf = 0;
    const cv = overlay();
    if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
  }

  async function attachStream(stream) {
    external = true;
    const v = video();
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play().catch(() => {});
    const msg = document.getElementById('camMsg');
    if (msg) msg.classList.add('hide');
    start();
  }

  async function recognizeFast(src) {
    await host.ensureCatalog();
    await warmup(['eng']);
    const q = (await import('./detect.js')).detectCardQuad(src);
    const card = q ? warpCard(src, q, 900) : src;
    const opts = { lang: host.lang(), totals: host.totals(), jaSetIds: host.jaSetIds() };
    const t0 = performance.now();
    let msg;
    try {
      const bmp = await createImageBitmap(card);
      msg = await recognizeBitmap(bmp, null, true, opts);
    } catch {
      msg = await recognizeOnMain(card, true, opts);
    }
    msg.ms = Math.round(performance.now() - t0);
    msg.quad = !!q;
    return msg;
  }

  return {
    start, stop, warmup, attachStream, recognizeFast,
    external: () => external,
    quad: () => quad,
    SHARP_MIN,
    state: () => ({
      phase, hits, frame: frameColor, scanLine,
      topId: lastResult?.view?.cand?.id || null,
      alts: !!lastResult?.view?.showAlts,
      worker: !workerBroken,
    }),
    add: () => onAdd(),
    reject: () => onReject(),
    resetHits: () => { hits = 0; },
  };
}
