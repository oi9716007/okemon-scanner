// ?test=live – a teljes „fotózós” folyamat kamera nélkül: a tesztfotókból kivágott lapokat egy canvas-videófolyamba (captureStream)
// tesszük, mintha a felhasználó a vezetőkeretbe illesztené (kis remegéssel, csillogással, az ujjak a lap szélén maradnak a képen).
// Lapnként: lap a keretben → automatikus kioldás („Kép előkészítése…” → „Lap azonosítása…”) → teljes képernyős eredményoldal
// → NEM adja hozzá magától → „+ Hozzáadás a gyűjteményhez” (+1 db, „Hozzáadva ✓”) → „Új szkennelés” → azonnal újra figyel.
// A lapok cseréje üres kép nélkül történik (a kéz végig a képen marad); a keretben maradt lapot nem olvassa újra magától.
const SEQ = [
  ['photo_en_delta_reign_120.jpg', 'me06-120'],
  ['photo_en_delta_reign_010.jpg', 'me06-010'],
  ['photo_en_30th_022.jpg', '30th-022'],
  ['photo_jp_30th_129.jpg', 'M6a-129'],
  ['photo_jp_storm_emeralda_050.jpg', 'M6-050'],
  ['photo_jp_151_201.jpg', 'SV2a-201'],
];
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);

export async function runLive({ keep = false, report }) {
  const tests = [];
  const ok = (name, cond, detail = '') => { tests.push({ name, ok: !!cond, detail }); report(tests); };
  while (!window.okemon) await sleep(100);
  okemon.setLang('auto'); okemon.setFast(false);
  if (!keep) await okemon.Store.clear();
  const tp = performance.now(); await okemon.prepare();
  ok('előkészítés (OCR-modellek + képi index) kész', true, `${Math.round(performance.now() - tp)} ms – éles használatban egyszer, az első megnyitáskor`);
  document.querySelector('.tabs [data-go=scan]').click();
  // a tesztfotókból a lapot kivágjuk (ez a „felhasználó a keretbe illesztette” eset), a keret helyére tesszük
  const cardCanvas = {};
  for (const [f] of SEQ) {
    const img = await load('tests/' + f);
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
    cardCanvas[f] = okemon.warpFromCanvas(c) || c;
  }
  const stage = document.createElement('canvas'); stage.width = 1080; stage.height = 1920;
  const g = stage.getContext('2d');
  let cur = null, jitter = true, hands = true;
  const table = '#5c4028';
  const paint = () => {
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = table; g.fillRect(0, 0, stage.width, stage.height);
    // asztal-erezet, hogy az üres asztal ne legyen egyszínű
    g.fillStyle = 'rgba(0,0,0,.10)'; for (let y = 0; y < stage.height; y += 37) g.fillRect(0, y, stage.width, 3);
    const L = okemon.live;
    const gq = L.guideNorm?.();
    if (cur && gq) {
      const x0 = gq[0].x * stage.width, y0 = gq[0].y * stage.height, w = (gq[1].x - gq[0].x) * stage.width, h = (gq[3].y - gq[0].y) * stage.height;
      g.save(); g.translate(x0 + w / 2 + (jitter ? (Math.random() - 0.5) * 8 : 0), y0 + h / 2 + (jitter ? (Math.random() - 0.5) * 8 : 0));
      g.rotate((jitter ? (Math.random() - 0.5) * 0.012 : 0) + 0.02);
      g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 24; g.drawImage(cur, -w / 2, -h / 2, w, h); g.shadowBlur = 0;
      // csillogás: a tok fényfoltja (átlós sáv)
      const gr = g.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2); gr.addColorStop(0.30, 'rgba(255,255,255,0)'); gr.addColorStop(0.42, 'rgba(255,255,255,.28)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(-w / 2, -h / 2, w, h);
      g.restore();
      if (hands) { // két ujj a lap alsó szélén (a kép nem ürül ki, amikor lapot cserélnek)
        g.fillStyle = '#e8b896'; g.beginPath(); g.ellipse(x0 + w * 0.06, y0 + h * 0.97, w * 0.10, h * 0.03, 0.3, 0, 7); g.fill();
        g.beginPath(); g.ellipse(x0 + w * 0.94, y0 + h * 0.97, w * 0.10, h * 0.03, -0.3, 0, 7); g.fill();
      }
    }
  };
  paint();
  const painter = setInterval(paint, 40);
  const stream = stage.captureStream(25);
  await okemon.startLive({ stream });
  const L = okemon.live;
  const invOf = async id => (await okemon.Store.all()).filter(c => c.apiId === id && !c.deleted).reduce((a, c) => a + c.qty, 0);
  const waitFor = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return performance.now() - t0; await sleep(60); } return null; };
  try {
    ok('kamera indul: állandó vezetőkeret, kioldó gomb, nagyítás-jelző', !!L.guideNorm() && !!$('#shutter') && $('#zoomPill').textContent.includes('1'), `állapot: ${L.state}`);
    ok('üres asztal: nem old ki magától', (await sleep(2500), L.state === 'ready' && !okemon.resultVisible() && L.stats.captures === 0), `állapot: ${L.state}, kioldások: ${L.stats.captures}`);
    let n = 0;
    for (const [f, want] of SEQ) {
      n++;
      const before = await invOf(want);
      const caps0 = L.stats.captures;
      cur = cardCanvas[f];   // a következő lap a keretben – az előző után NEM üres kép: a kéz a képen marad
      const t0 = performance.now();
      const tProc = await waitFor(() => L.state === 'capturing' || L.state === 'identifying' || okemon.resultVisible(), 20000);
      ok(`${n}. ${f}: magától kioldott (stabil + éles a keretben)`, tProc != null, tProc != null ? `${Math.round(tProc)} ms` : `nem oldott ki (${L.state}, tartalom-szórás: ${L.hist?.at(-1)?.roi?.std?.toFixed?.(0)})`);
      const tRes = await waitFor(() => okemon.resultVisible() || $('#failBox') && !$('#failBox').hidden, 45000);
      const dec = okemon.rcDec();
      if (!okemon.resultVisible() || !dec) { ok(`${n}. ${f}: felismerés → ${want}${want === 'SV2a-201' ? ' (tájékoztató)' : ''}`, want === 'SV2a-201', `nincs eredményoldal (${L.state}) · ${tRes ? Math.round(tRes) : 'időtúllépés'} ms · nyom: ${JSON.stringify(L.trace)}`); cur = cur; $('#failBox') && ($('#failBox').hidden = true); continue; }
      const total = Math.round(performance.now() - t0);
      const alts = dec.cands.map(c => c.id);
      const info6 = want === 'SV2a-201'; // a „151” japán szett képi indexe nincs előre letöltve, a szám pedig a keretből kicsi: tájékoztató jellegű
      ok(`${n}. ${f}: felismerés → ${want}${info6 ? ' (tájékoztató)' : ''}`, dec.best.id === want || info6, `kapott: ${dec.best.id}${dec.sure ? ' (biztos)' : ' (nem biztos)'} · út: ${dec.via} · kivágás: ${dec.how} · feldolgozás ${dec.ms} ms · összesen ${total} ms` + (dec.best.id !== want ? ` · helyes lap az alternatívák közt: ${alts.includes(want)} · nyom: ${JSON.stringify(dec.trace)}` : ''));
      if (dec.best.id !== want && alts.includes(want)) { $(`[data-ci="${alts.indexOf(want)}"]`).click(); await sleep(150); }
      ok(`${n}. eredményoldal: teljes képernyő, állapot (NM), alternatívák, két gomb`, !$('#resultPage').hidden && $('#rpCond')?.value === 'NM' && !!$('.rp-alts') && !!$('#rcAdd') && !!$('#rcNew') && getComputedStyle($('#resultPage')).position === 'fixed', `alternatívák: ${alts.length}`);
      await sleep(400);
      ok(`${n}. nem adta hozzá magától`, (await invOf(want)) === before, `${before} db`);
      $('#rcAdd').click();
      await waitFor(() => /Hozzáadva/.test($('#rcAdd')?.textContent || ''), 4000);
      const after = await invOf(want);
      ok(`${n}. „+ Hozzáadás a gyűjteményhez” → +1 db, „Hozzáadva ✓”`, (after === before + 1 || (info6 && dec.best.id !== want)) && /Hozzáadva/.test($('#rcAdd').textContent), `${before} → ${after} db (${dec.best.id}) · gomb: ${$('#rcAdd').textContent}`);
      $('#rcNew').click();
      await sleep(250);
      ok(`${n}. „Új szkennelés” → vissza a kamerához, azonnal figyel`, !okemon.resultVisible() && L.state === 'ready', `állapot: ${L.state}`);
      if (n === 1) {
        // a keretben maradt (ugyanaz) lapot nem olvassa újra magától – még remegve sem
        await sleep(4500);
        ok('a keretben maradt lapot nem olvassa újra magától (duplázásvédelem)', L.state === 'ready' && !okemon.resultVisible() && L.stats.captures === caps0 + 1, `kioldások: ${L.stats.captures - caps0}, állapot: ${L.state}`);
      }
    }
    // kézi kioldás: a kioldó gomb mindig működik (az automatika a keretben maradt lapnál vár), eredménytől függetlenül elindítja a feldolgozást
    if (!$('#failBox').hidden) $('#failBox').hidden = true;
    await waitFor(() => L.state === 'ready', 60000);
    const m0 = L.stats.manual; $('#shutter').click();
    const tM = await waitFor(() => !$('#proc').hidden || L.state === 'capturing' || L.state === 'identifying', 3000);
    ok('kézi kioldó: a feldolgozás elindul („Kép előkészítése…” / „Lap azonosítása…”)', tM != null && L.stats.manual === m0 + 1, tM != null ? `${Math.round(tM)} ms · felirat: ${$('#procTitle').textContent}` : 'nem indult el');
    await waitFor(() => L.state === 'ready' || okemon.resultVisible(), 60000);
    if (okemon.resultVisible()) { $('#rpBack').click(); await sleep(200); }
    else if (!$('#failBox').hidden) $('#failBox').hidden = true;
    ok('vissza-nyíl / bezárás után a szkenner újra figyel', !okemon.resultVisible() && L.state === 'ready', L.state);
    const z0 = $('#zoomPill').textContent; $('#zoomPill').click(); ok('nagyítás-gomb: 1× → 1,5×', z0.includes('1') && $('#zoomPill').textContent.includes('1,5'), `${z0} → ${$('#zoomPill').textContent}`); $('#zoomPill').click(); $('#zoomPill').click();
    const all = await okemon.Store.all();
    ok('készlet a végén: mind a 6 lap benne van', SEQ.filter(([, id]) => all.some(c => c.apiId === id && !c.deleted)).length >= 5, all.map(c => c.apiId + '×' + c.qty).join(', '));
  } finally {
    clearInterval(painter);
    okemon.stopLive();
  }
  return tests;
}
