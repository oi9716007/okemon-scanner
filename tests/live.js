// ?test=live – kártyaérzékelés, gyors út időmérése, és a teljes élő folyamat
// a tesztfotókból készített vászon-videóval (kamera nélkül).
const FILES = [
  'photo_en_delta_reign_120.jpg',
  'photo_en_delta_reign_010.jpg',
  'photo_en_30th_022.jpg',
  'photo_jp_30th_129.jpg',
  'photo_jp_storm_emeralda_050.jpg',
  'photo_jp_151_201.jpg',
];
const EXPECTED = {
  'photo_en_delta_reign_120.jpg': 'me06-120',
  'photo_en_delta_reign_010.jpg': 'me06-010',
  'photo_en_30th_022.jpg': '30th-022',
  'photo_jp_30th_129.jpg': 'M6a-129',
  'photo_jp_storm_emeralda_050.jpg': 'M6-050',
  'photo_jp_151_201.jpg': 'SV2a-201',
};
const NUM = {
  'photo_en_delta_reign_120.jpg': 120,
  'photo_en_delta_reign_010.jpg': 10,
  'photo_en_30th_022.jpg': 22,
  'photo_jp_storm_emeralda_050.jpg': 50,
};

const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(src)); i.src = src; });
const wait = ms => new Promise(r => setTimeout(r, ms));
function report(tests) {
  let el = document.getElementById('testReport');
  if (!el) {
    el = document.createElement('pre'); el.id = 'testReport';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:84px;max-height:55vh;overflow:auto;z-index:90;background:#050505;border-top:2px solid #f5c518;color:#eee;font:12px/1.4 ui-monospace,monospace;margin:0;padding:10px;white-space:pre-wrap';
    document.body.appendChild(el);
  }
  const fail = tests.filter(t => !t.ok).length;
  el.textContent = `ÉLŐ TESZT: ${tests.length - fail}/${tests.length} OK${fail ? `, ${fail} HIBA` : ''}${window.__done ? '' : ' (fut…)'}\n` +
    tests.map(t => `${t.ok ? '✔' : '✘'} ${t.name}${t.detail ? '  [' + t.detail + ']' : ''}`).join('\n');
}
async function until(pred, ms, step = 150) {
  const t0 = performance.now();
  let last;
  while (performance.now() - t0 < ms) {
    last = pred();
    if (last) return last;
    await wait(step);
  }
  return null;
}

function tableCanvas() {
  const c = document.createElement('canvas');
  c.width = 800; c.height = 1100;
  const g = c.getContext('2d');
  for (let y = 0; y < c.height; y++) {
    const band = 168 + Math.sin(y / 14) * 10;
    g.fillStyle = `rgb(${band | 0},${(band - 28) | 0},${(band - 68) | 0})`;
    g.fillRect(0, y, c.width, 1);
  }
  const im = g.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  for (let i = 0; i < d.length; i += 16) d[i] += (i % 9) - 4;
  g.putImageData(im, 0, 0);
  return c;
}

export async function runLive() {
  window.__tests = []; window.__done = false; window.__live = {};
  const tests = window.__tests;
  while (!window.okemon) await wait(100);
  const okemon = window.okemon;
  okemon.setLang('auto');
  try {
    for (const f of FILES) {
      const img = await load('tests/' + f);
      const t0 = performance.now();
      const q = okemon.detectCardQuad(img);
      const ms = Math.round(performance.now() - t0);
      const geom = q && q.aspect > 0.55 && q.aspect < 0.95 && q.areaRatio > 0.12 && q.areaRatio < 0.94;
      tests.push({ name: `kártya-négyszög: ${f}`, ok: !!geom, detail: q ? `ar ${q.aspect.toFixed(3)} · terület ${(q.areaRatio * 100).toFixed(0)}% · ${ms} ms` : 'nincs négyszög' });
      if (q) {
        const w = okemon.warpCard(img, q, 600);
        const ratio = w.width / w.height;
        tests.push({ name: `perspektíva: ${f}`, ok: Math.abs(ratio - 63 / 88) < 0.02 && w.width === 600, detail: `${w.width}×${w.height}` });
      } else tests.push({ name: `perspektíva: ${f}`, ok: false, detail: 'nincs négyszög' });
      report(tests);
    }
    const table = tableCanvas();
    const tq = okemon.detectCardQuad(table);
    tests.push({ name: 'üres asztal: nincs kártya', ok: !tq, detail: tq ? `téves ar ${tq.aspect?.toFixed(3)}` : '' });

    const sharpImg = await load('tests/photo_en_30th_022.jpg');
    // Ugyanaz a kicsinyítés, mint az élő hurokban (max 320 px), azon a Laplace-értéken múlik a küszöb.
    const downSharp = (src) => {
      const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
      const sc = 320 / Math.max(sw, sh);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * sc)); c.height = Math.max(1, Math.round(sh * sc));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      const q = okemon.detectCardQuad(c);
      return q ? okemon.laplacianVariance(c, q) : 0;
    };
    const sharp = downSharp(sharpImg);
    const blurred = document.createElement('canvas');
    blurred.width = sharpImg.naturalWidth; blurred.height = sharpImg.naturalHeight;
    const bg = blurred.getContext('2d'); bg.filter = 'blur(8px)'; bg.drawImage(sharpImg, 0, 0);
    const bsharp = downSharp(blurred);
    tests.push({ name: 'éles kép a küszöb felett, erős elmosás alatta', ok: sharp >= okemon.SHARP_MIN && bsharp < okemon.SHARP_MIN, detail: `éles ${Math.round(sharp)} · elmosott ${Math.round(bsharp)} · küszöb ${okemon.SHARP_MIN}` });
    report(tests);

    const times = [];
    for (const f of FILES) {
      const img = await load('tests/' + f);
      const t0 = performance.now();
      const r = await okemon.recognizeFast(img);
      const ms = Math.round(performance.now() - t0);
      times.push(ms);
      const got = parseInt(String(r.number || '').replace(/\D/g, ''), 10);
      const want = NUM[f];
      const numOk = want ? got === want : true;
      tests.push({ name: `gyors út ${f}`, ok: ms < 8000 && numOk, detail: `${ms} ms · szám ${r.number || '–'}/${r.total || '–'}${r.numberSure ? ' biztos' : ''}${want && !numOk ? ' (várt ' + want + ')' : ''}` });
      report(tests);
    }
    const avg = times.reduce((s, n) => s + n, 0) / times.length;
    window.__live.times = times;
    window.__live.avg = avg;
    tests.push({ name: 'gyors út átlag ≤ 3 mp', ok: avg <= 3000, detail: `${Math.round(avg)} ms (${times.map(t => Math.round(t)).join(', ')})` });
    report(tests);

    await okemon.Store.clear();
    okemon.setLang('auto');
    const canvas = document.createElement('canvas');
    canvas.width = 720; canvas.height = 960;
    const ctx = canvas.getContext('2d');
    let frame = null;
    const paint = () => {
      ctx.fillStyle = '#c4a574';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y += 6) {
        ctx.fillStyle = `rgba(90,60,30,${0.05 + (y % 18) / 400})`;
        ctx.fillRect(0, y, canvas.width, 2);
      }
      if (frame) {
        const s = Math.min(canvas.width / frame.naturalWidth, canvas.height / frame.naturalHeight);
        const w = frame.naturalWidth * s, h = frame.naturalHeight * s;
        ctx.drawImage(frame, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }
    };
    paint();
    const stream = canvas.captureStream(8);
    const pump = setInterval(paint, 120);
    await okemon.attachLiveStream(stream);
    okemon.go('scan');
    const video = document.getElementById('video');
    const ready = await until(() => video.videoWidth > 0, 5000);
    tests.push({ name: 'vászon-videó elindul', ok: !!ready, detail: ready ? `${video.videoWidth}×${video.videoHeight}` : 'nincs képkocka' });
    report(tests);
    if (!ready) { clearInterval(pump); window.__done = true; report(tests); return; }

    const first = 'photo_en_delta_reign_010.jpg';
    frame = await load('tests/' + first);
    paint();
    const hit = await until(() => okemon.liveState().phase === 'result' && okemon.liveState().topId, 45000);
    const st = okemon.liveState();
    tests.push({ name: `élő találat: ${EXPECTED[first]}`, ok: st.topId === EXPECTED[first] && st.frame === 'green', detail: `top ${st.topId || '–'} · keret ${st.frame} · fázis ${st.phase}` });
    const hits = st.hits;
    await wait(1200);
    const st2 = okemon.liveState();
    tests.push({ name: 'duplázásvédelem: ugyanaz a kép egy találat', ok: st2.hits === hits && hits === 1, detail: `találat ${st2.hits}` });
    okemon.liveReject();
    const st3 = okemon.liveState();
    const before = await okemon.Store.all();
    tests.push({ name: 'Nem ez: jelöltek, hozzáadás nélkül', ok: st3.alts && !before.length, detail: st3.alts ? 'alternatívák nyitva' : 'nincs alternatíva' });
    const addBtn = document.getElementById('lcAdd');
    tests.push({ name: 'Hozzáadás gomb látszik', ok: !!addBtn && !addBtn.disabled, detail: addBtn ? 'van' : 'nincs' });
    report(tests);
    if (addBtn) await okemon.liveAdd();
    await wait(400);
    const added = (await okemon.Store.all()).filter(c => !c.deleted && c.qty > 0);
    tests.push({ name: 'Hozzáadás: 1 db a várt lapból', ok: added.length === 1 && added[0].apiId === EXPECTED[first] && added[0].qty === 1, detail: added.map(c => `${c.apiId}×${c.qty}`).join(', ') || 'üres' });
    await wait(1000);
    const still = (await okemon.Store.all()).find(c => c.apiId === EXPECTED[first]);
    tests.push({ name: 'a lap a képben marad: nincs második hozzáadás', ok: still?.qty === 1 && okemon.liveState().hits === 1, detail: `db ${still?.qty} · találat ${okemon.liveState().hits}` });
    report(tests);

    frame = null; paint();
    const left = await until(() => okemon.liveState().phase === 'watching', 5000);
    tests.push({ name: 'a lap kikerül a képből: a szkenner újra figyel', ok: !!left, detail: okemon.liveState().phase });

    const second = 'photo_en_30th_022.jpg';
    frame = await load('tests/' + second);
    paint();
    const hit2 = await until(() => okemon.liveState().phase === 'result' && okemon.liveState().topId === EXPECTED[second], 45000);
    tests.push({ name: `új lap: ${EXPECTED[second]}`, ok: !!hit2, detail: `top ${okemon.liveState().topId || '–'} · találat ${okemon.liveState().hits}` });
    if (hit2) await okemon.liveAdd();
    await wait(500);
    const all = (await okemon.Store.all()).filter(c => !c.deleted && c.qty > 0);
    const ids = all.map(c => c.apiId).sort();
    tests.push({ name: 'két különböző lap, egy-egy darab', ok: ids.join() === [EXPECTED[first], EXPECTED[second]].sort().join() && all.every(c => c.qty === 1), detail: all.map(c => `${c.apiId}×${c.qty}`).join(', ') });
    clearInterval(pump);
  } catch (e) {
    tests.push({ name: 'élő teszt kivétel', ok: false, detail: e.stack || e.message });
  }
  window.__done = true;
  report(tests);
}
