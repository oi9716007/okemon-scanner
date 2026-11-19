// ?test=live – a teljes élő folyamat kamera nélkül: a tesztfotók canvas-videófolyamként (captureStream) mennek a szkennernek.
// Lapnként: üres asztal (nem érzékelhet kártyát) → lap → zöld keret → felugró eredmény → „Hozzáadás” (+1 db)
// → a lap még 2,5 mp-ig a képen marad: nem jöhet újabb találat (duplázásvédelem).
const SEQ = [
  ['photo_en_delta_reign_120.jpg', 'me06-120'],
  ['photo_en_delta_reign_010.jpg', 'me06-010'],
  ['photo_en_30th_022.jpg', '30th-022'],
  ['photo_jp_30th_129.jpg', 'M6a-129'],
  ['photo_jp_storm_emeralda_050.jpg', 'M6-050'],
  ['photo_jp_151_201.jpg', 'SV2a-201'],
  ['photo_en_delta_reign_010_persp.jpg', 'me06-010'], // perspektivikus, és már megvan → +1 db (2 db)
];
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runLive({ keep = false, report }) {
  const tests = [];
  const ok = (name, cond, detail = '') => { tests.push({ name, ok: !!cond, detail }); report(tests); };
  while (!window.okemon) await sleep(100);
  okemon.setLang('auto'); okemon.setFast(false);
  if (!keep) await okemon.Store.clear();
  // az app első megnyitáskori „Előkészítés”-e (OCR eng + jpn, a 4 kiemelt szett képi indexe) – mint éles használatban
  const tp = performance.now(); await okemon.prepare();
  const { getIndex } = await import('../js/imageindex.js');
  const sizes = [];
  for (const [l, id] of [['en', 'me06'], ['en', '30th'], ['ja', 'M6a'], ['ja', 'M6']]) sizes.push(`${id}: ${(await getIndex(l, id, null, { cachedOnly: true })).length}`);
  ok('előkészítés (OCR-modellek + képi index) kész', true, `${Math.round(performance.now() - tp)} ms – éles használatban egyszer, az első megnyitáskor · index: ${sizes.join(', ')}`);
  document.querySelector('.tabs [data-go=scan]').click();
  // „kamera”: 1080×1440 canvas, ~30 kép/mp
  const stage = document.createElement('canvas'); stage.width = 1080; stage.height = 1440;
  const g = stage.getContext('2d');
  const empty = await load('tests/photo_empty_table.jpg');
  let cur = empty;
  // remegés: a „kézben tartott” lap minden képkockán kicsit elmozdul / elfordul (mint egy valódi kamerában)
  let jitter = false;
  const paint = () => {
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#5c4028'; g.fillRect(0, 0, stage.width, stage.height);
    if (jitter) { g.translate(stage.width / 2 + (Math.random() - 0.5) * 30, stage.height / 2 + (Math.random() - 0.5) * 30); g.rotate((Math.random() - 0.5) * 0.03); g.scale(0.97 + Math.random() * 0.04, 0.97 + Math.random() * 0.04); g.translate(-stage.width / 2, -stage.height / 2); }
    g.drawImage(cur, 0, 0, stage.width, stage.height);
  };
  paint();
  const painter = setInterval(paint, 33);
  const stream = stage.captureStream(30);
  await okemon.startLive({ stream });
  const L = okemon.live;
  let adds = 0;
  try {
    for (const [f, want] of SEQ) {
      // 1) üres asztal
      cur = empty; await sleep(1500);
      ok(`üres asztal (${f} előtt): nincs kártya`, !L.quad && (L.state === 'searching'), `állapot: ${L.state}`);
      // 2) a lap
      const before = (await okemon.Store.all()).filter(c => c.apiId === want).reduce((a, c) => a + c.qty, 0);
      const dec0 = L.stats.decisions;
      cur = await load('tests/' + f);
      const t0 = performance.now();
      let tDetect = null;
      while (performance.now() - t0 < 15000) {
        if (!tDetect && L.quad) tDetect = performance.now() - t0;
        if (okemon.resultVisible() || L.state === 'failed') break;
        await sleep(50);
      }
      const total = Math.round(performance.now() - t0);
      const dec = okemon.rcDec();
      ok(`${f}: kártya érzékelve (zöld keret)`, tDetect != null, tDetect != null ? `${Math.round(tDetect)} ms` : 'nem érzékelte');
      if (!okemon.resultVisible() || !dec) { ok(`${f}: felismerés → ${want}`, false, `nincs eredmény (${L.state}) · ${total} ms · kockák: ${JSON.stringify(L.trace)}`); continue; }
      ok(`${f}: felismerés → ${want}`, dec.best.id === want, `kapott: ${dec.best.id}${dec.sure ? ' (biztos)' : ' (nem biztos)'} · ${dec.votes} kocka egyezett · felismerés ${dec.ms} ms · összesen ${total} ms` + (dec.best.id !== want ? ' · kockák: ' + JSON.stringify(L.trace) + ' · jelöltek: ' + dec.cands.slice(0, 4).map(c => `${c.id} ${c.score.toFixed(1)} ${c.why.join('+')}`).join(' | ') : ''));
      // 3) Hozzáadás (1 koppintás)
      document.getElementById('rcAdd').click();
      await sleep(900);
      const after = (await okemon.Store.all()).filter(c => c.apiId === want).reduce((a, c) => a + c.qty, 0);
      if (dec.best.id === want) adds++;
      ok(`${f}: „Hozzáadás” → +1 darab`, after === before + 1, `${before} → ${after} db`);
      // 4) ugyanaz a lap marad a képen (remegve): nem lehet újabb találat
      jitter = true; await sleep(3500); jitter = false;
      ok(`${f}: duplázásvédelem (a képen maradó lap nem ad új találatot)`, !okemon.resultVisible() && L.stats.decisions === dec0 + 1, `döntések: ${L.stats.decisions - dec0}, elnyomott ismétlés: ${L.stats.suppressed || 0}, állapot: ${L.state}`);
    }
    cur = empty; await sleep(1200);
    const all = await okemon.Store.all();
    ok('készlet a végén: me06-010 = 2 db (normál + perspektivikus fotó), a többi 1-1 db', all.find(c => c.apiId === 'me06-010')?.qty === 2 && SEQ.slice(0, 6).every(([, id]) => all.some(c => c.apiId === id)), all.map(c => c.apiId + '×' + c.qty).join(', '));
  } finally {
    clearInterval(painter);
    okemon.stopLive();
  }
  return tests;
}
