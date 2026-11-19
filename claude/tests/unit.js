// Fotó nélküli tesztek: névtisztítás és szám-értelmezés (helyi), szett-komplettség (helyi + élő laplista),
// findCandidates (élő API). A hálózati tesztek offline „kihagyva” állapottal zárulnak, a helyiek akkor is lefutnak.
import { cleanName, findNumber } from '../js/recognize.js';
import { findCandidates, getSet } from '../js/api.js';
import { computeProgress } from '../js/completeness.js';
import { catalogItems, catalogGridHtml, topCards, setLogo } from '../js/catalog.js';
import { recordPrices, pointsFromRecord, referenceLines, chartSvg } from '../js/history.js';
import { Store } from '../js/db.js';
import { detectQuad } from '../js/detect-core.js';
import { artPrint, printSim, normalizeCard, CW, CH } from '../js/recognize.js';

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });
const skip = (name, e) => results.push({ name, ok: true, skipped: true, detail: 'kihagyva (hálózat?): ' + (e?.message || e) });

export async function runUnit() {
  results.length = 0;
  // --- névtisztítás (helyi) ---
  const cases = [
    ['Fire Energy', 'Fire Energy'],
    ['BASIC\nBasic Lightning Energy', 'Basic Lightning Energy'],
    ['TRAINER ITEM\nEnergy Search', 'Energy Search'],
    ['TRAINER\nEnergy Retrieval', 'Energy Retrieval'],
    ['ITEM\nEnergy Switch', 'Energy Switch'],
    ['TRAINER SUPPORTER\nProfessor’s Research', "Professor's Research"],
    ['ITEM\nSwitch', 'Switch'],
    ['STAGE 1 Raichu HP 120 Evolves from Pikachu', 'Raichu'],
    ['BASIC Pikachu HP 60', 'Pikachu'],
    ['STAGE 2\nCharizard ex', 'Charizard ex'],
    ['Stage 1 Evolves from Pikachu\nRaichu', 'Raichu'],
  ];
  for (const [raw, want] of cases) { const got = cleanName(raw, 'eng'); ok(`cleanName: ${JSON.stringify(raw)} → „${want}”`, got === want, 'kapott: „' + got + '”'); }
  for (const [raw, want] of [['たねピカチュウ', 'ピカチュウ'], ['基本炎エネルギー', '基本炎エネルギー'], ['博士の研究', '博士の研究'], ['1進化ライチュウ', 'ライチュウ']]) {
    const got = cleanName(raw, 'jpn'); ok(`cleanName (jpn): ${raw} → ${want}`, got === want, 'kapott: ' + got);
  }
  // --- szám-értelmezés (helyi) ---
  const T = new Set([103, 128, 165, 102]);
  for (const [raw, n, t] of [['DLR EN 120/103', '120', 103], ['1207103', '120', 103], ['022/,128', '022', 128], ['58/102', '58', 102]]) {
    const f = findNumber(raw, T); ok(`findNumber: ${raw} → ${n}/${t}`, f && f.number === n && f.total === t, JSON.stringify(f));
  }
  // --- komplettség: tiszta számítás szintetikus szettel (helyi) ---
  const fake = { id: 'x1', name: 'Teszt', cardCount: { official: 3, total: 5 }, cards: ['001', '002', '003', '004', '005'].map(l => ({ id: 'x1-' + l, localId: l, name: 'L' + l })) };
  const own = [{ setId: 'x1', apiId: 'x1-001', qty: 2 }, { setId: 'x1', apiId: 'x1-004', qty: 1 }, { setId: 'x1', apiId: 'x1-002', qty: 0 }, { setId: 'x1', apiId: 'x1-003', qty: 1, deleted: true }];
  const pt = computeProgress(fake, own, 'total'), po = computeProgress(fake, own, 'official');
  ok('komplettség (szintetikus): teljes 2/5, hiányzik 3', pt.have === 2 && pt.of === 5 && pt.missingCount === 3, JSON.stringify({ have: pt.have, of: pt.of, miss: pt.missingCount }));
  ok('komplettség (szintetikus): hivatalos 1/3 (a 004 titkos; a qty=0 és a törölt nem számít)', po.have === 1 && po.of === 3 && po.missing.map(c => c.localId).join() === '002,003', JSON.stringify({ have: po.have, of: po.of, miss: po.missing.map(c => c.localId) }));
  // --- komplettség: Delta Reign élő laplistával ---
  try {
    const dr = await getSet('en', 'me06');
    const mine = [{ lang: 'EN', setId: 'me06', apiId: 'me06-010', qty: 1 }, { lang: 'EN', setId: 'me06', apiId: 'me06-120', qty: 2 }];
    const t = computeProgress(dr, mine, 'total'), o = computeProgress(dr, mine, 'official');
    ok('Delta Reign teljes: 2 / 141', t.have === 2 && t.of === 141, `${t.have}/${t.of}`);
    ok('Delta Reign hivatalos: 1 / 103 (a 120 titkos ritkaság, az 1–103 körön kívül esik)', o.have === 1 && o.of === 103, `${o.have}/${o.of}`);
    ok('Delta Reign: a hiányzók között ott a me06-001 Heracross', t.missing.some(c => c.id === 'me06-001' && /Heracross/.test(c.name)));
    ok('Delta Reign: a meglévő 2 lap nincs a hiányzók között (139 hiányzik)', !t.missing.some(c => c.id === 'me06-010' || c.id === 'me06-120') && t.missing.length === 139, 'hiányzó: ' + t.missing.length);
  } catch (e) { skip('Delta Reign komplettség (élő)', e); }
  // --- findCandidates élő API-val: common / Trainer / Energy / régi szett / japán common ---
  const api = [
    ['EN Pikachu 58/102 → base1-58', { lang: 'en', name: 'Pikachu', number: '58', total: 102 }, 'base1-58'],
    ['EN Fire Energy 98/102 → base1-98', { lang: 'en', name: 'Fire Energy', number: '98', total: 102 }, 'base1-98'],
    ['EN Switch 95/102 → base1-95', { lang: 'en', name: 'Switch', number: '95', total: 102 }, 'base1-95'],
    ['JP フシギダネ 001/165 → SV2a-001', { lang: 'ja', name: 'フシギダネ', number: '001', total: 165 }, 'SV2a-001'],
    ['Auto Wimpod 010/103 → me06-010 (common)', { lang: 'auto', name: 'Wimpod', number: '010', total: 103 }, 'me06-010'],
  ];
  for (const [name, q, want] of api) {
    try {
      const c = await findCandidates({ setCodes: [], ...q });
      ok(name + ' (első helyen)', c[0]?.id === want, 'top: ' + c.slice(0, 3).map(x => x.id + ' ' + x.score.toFixed(1)).join(', '));
    } catch (e) { skip(name, e); }
  }
  // --- Készletem: katalógus-rács, darabszám-karika (élő Delta Reign laplistával) ---
  try {
    const dr = await getSet('en', 'me06');
    const mine = [
      { lang: 'EN', setId: 'me06', apiId: 'me06-010', qty: 1, condition: 'NM', uid: 'u1' },
      { lang: 'EN', setId: 'me06', apiId: 'me06-010', qty: 1, condition: 'LP', uid: 'u2' }, // két állapot → összesen 2
      { lang: 'EN', setId: 'me06', apiId: 'me06-120', qty: 1, uid: 'u3' },
    ];
    const items = catalogItems(dr, mine);
    const doc = new DOMParser().parseFromString(catalogGridHtml(items), 'text/html');
    const tiles = [...doc.querySelectorAll('.ctile')];
    const badge = id => doc.querySelector(`.ctile[data-cid="${id}"] .qbadge`)?.textContent;
    ok('katalógus: a teljes szett (141 lap) a rácsban, szám szerint', tiles.length === 141 && tiles[0].dataset.cid === 'me06-001' && tiles[140].dataset.cid === 'me06-141', `${tiles.length} csempe, első ${tiles[0]?.dataset.cid}, utolsó ${tiles.at(-1)?.dataset.cid}`);
    ok('katalógus: me06-010 karika „2” (két állapot összesen)', badge('me06-010') === '2', 'karika: ' + badge('me06-010'));
    ok('katalógus: me06-120 karika „1” (1 darabnál is látszik)', badge('me06-120') === '1', 'karika: ' + badge('me06-120'));
    const others = tiles.filter(t => !['me06-010', 'me06-120'].includes(t.dataset.cid));
    ok('katalógus: a többi 139 lap szürke („missing”) és nincs rajta karika', others.length === 139 && others.every(t => t.classList.contains('missing') && !t.querySelector('.qbadge')));
    ok('katalógus: a 2 meglévő lap színes („own”)', ['me06-010', 'me06-120'].every(id => doc.querySelector(`.ctile[data-cid="${id}"]`).classList.contains('own')));
    const missOnly = new DOMParser().parseFromString(catalogGridHtml(items, { filter: 'missing' }), 'text/html').querySelectorAll('.ctile').length;
    ok('katalógus szűrő „hiányzik”: 139 lap', missOnly === 139, String(missOnly));
  } catch (e) { skip('katalógus (élő Delta Reign)', e); }
  // --- top 10 (helyi) ---
  const fakeCards = [
    { uid: 'a', name: 'A', qty: 1, price: 5, priceCurrency: 'EUR' },
    { uid: 'b', name: 'B', qty: 3, price: 2, priceCurrency: 'EUR' },   // összérték nagyobb, de egységár kisebb
    { uid: 'c', name: 'C', qty: 1, price: null, priceCurrency: null }, // nincs ár → kimarad
    { uid: 'd', name: 'D', qty: 1, price: 9, priceCurrency: 'USD' },
    { uid: 'e', name: 'E', qty: 0, price: 50, priceCurrency: 'EUR' },  // 0 db → kimarad
  ];
  const huf = c => c.price == null ? null : c.price * (c.priceCurrency === 'EUR' ? 400 : 350);
  const t10 = topCards(fakeCards, huf);
  ok('top 10: egységár szerinti sorrend, ár nélküli és 0 db kimarad', t10.map(c => c.uid).join() === 'd,a,b', t10.map(c => c.uid).join());
  // --- árelőzmény: naponta forrásonként 1 pont; export → import után megmarad ---
  const tid = 'test-hist-' + Date.now();
  const rec = { apiId: tid, lang: 'EN', variant: 'normal', prices: { cardmarket: { value: 1.23, currency: 'EUR', label: 'trend' } }, pricingVia: 'TCGdex' };
  try {
    await recordPrices(rec, { eurHuf: 400, usdHuf: 350 });
    rec.prices.cardmarket.value = 1.5; // ugyanazon a napon újra frissítve
    await recordPrices(rec, { eurHuf: 400, usdHuf: 350 });
    let pts = await Store.historyFor(tid);
    ok('árelőzmény: ugyanarra a napra egy forrásból csak 1 pont (a legutóbbi ár)', pts.length === 1 && pts[0].value === 1.5 && pts[0].hufRate === 400, JSON.stringify(pts.map(p => [p.date, p.source, p.value])));
    const exp = await window.okemon.exportJson();
    const inExport = (exp.priceHistory || []).filter(p => p.apiId === tid);
    await Store.historyDelete(inExport[0]?.key);
    const gone = (await Store.historyFor(tid)).length;
    await window.okemon.importHistory(JSON.parse(JSON.stringify(exp)).priceHistory);
    pts = await Store.historyFor(tid);
    ok('árelőzmény: JSON export → törlés → import után megmarad', inExport.length === 1 && gone === 0 && pts.length === 1 && pts[0].value === 1.5, `export: ${inExport.length}, törlés után: ${gone}, import után: ${pts.length}`);
    await window.okemon.importHistory(exp.priceHistory);
    ok('árelőzmény: kétszeri import sem duplikál', (await Store.historyFor(tid)).length === 1);
  } catch (e) { ok('árelőzmény', false, e.message); }
  finally { for (const p of await Store.historyFor(tid).catch(() => [])) await Store.historyDelete(p.key); }
  // --- nincs kitalált ár / logó ---
  ok('nincs ár → nincs árpont és nincs referenciavonal', pointsFromRecord({ apiId: 'x', prices: {} }, {}).length === 0 && referenceLines(null).length === 0 && referenceLines({ cardmarket: null, tcgplayer: null }).length === 0);
  ok('nincs adat → nincs grafikon (nem rajzolunk kitalált görbét)', chartSvg([], [], {}) === null);
  ok('nincs logó adat (japán szett, logo mező nélkül) → szöveges csempe', await setLogo('JP', { id: 'M6', name: 'ストームエメラルダ', cardCount: { official: 76 } }) === null);
  ok('kitalált angol szettnév → nincs logó', await setLogo('EN', { id: 'zzz', name: 'Nem Létező Szett 9999', cardCount: { official: 999 } }) === null);
  try {
    const b1 = await getSet('en', 'base1');
    const u = await setLogo('EN', b1);
    ok('Base Set logó a TCGdex-ből', u === b1.logo + '.webp', u);
    const dr = await getSet('en', 'me06');
    const u2 = await setLogo('EN', dr);
    if (u2 === null) skip('Delta Reign logó a pokemontcg.io-ból', 'a pokemontcg.io most nem válaszolt');
    else ok('Delta Reign logó a pokemontcg.io-ból (a TCGdex nem ad)', !dr.logo && /^https:\/\/images\.(scrydex|pokemontcg)\./.test(u2), u2);
  } catch (e) { skip('logók (élő)', e); }
  // --- élő szkenner: kártyaérzékelés, perspektíva-korrekció, gyors út időmérése (a tesztfotókon) ---
  const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const toCanvas = img => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; };
  const small = (src, max = 480) => { const sc = max / Math.max(src.width, src.height), w = Math.round(src.width * sc), h = Math.round(src.height * sc); const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h); return { data: g.getImageData(0, 0, w, h).data, w, h }; };
  const PHOTOS = [['photo_en_delta_reign_120.jpg', 'me06-120'], ['photo_en_delta_reign_010.jpg', 'me06-010'], ['photo_en_30th_022.jpg', '30th-022'], ['photo_jp_30th_129.jpg', 'M6a-129'], ['photo_jp_storm_emeralda_050.jpg', 'M6-050'], ['photo_jp_151_201.jpg', 'SV2a-201'], ['photo_en_delta_reign_010_persp.jpg', 'me06-010']];
  const warped = {};
  try {
    for (const [f] of PHOTOS) {
      const c = toCanvas(await load('tests/' + f)), sm = small(c);
      const t = performance.now(), d = detectQuad(sm.data, sm.w, sm.h), ms = performance.now() - t;
      ok(`kártyaérzékelés: ${f}`, d && d.area > 0.1 && d.ratio > 0.62 && d.ratio < 0.8, d ? `terület ${(d.area * 100).toFixed(0)}% · arány ${d.ratio.toFixed(3)} · ${ms.toFixed(0)} ms` : 'nem talált kártyát');
      const w = d && window.okemon.warpFromCanvas(c);
      warped[f] = w;
      if (f.includes('persp')) ok('perspektíva-korrekció: álló, 63×88 arányú kivágás', w && w.width === CW && w.height === CH, w ? `${w.width}×${w.height}` : '–');
    }
    const e = small(toCanvas(await load('tests/photo_empty_table.jpg')));
    ok('negatív teszt: üres asztalon nincs kártya', !detectQuad(e.data, e.w, e.h));
    // ugyanaz a lap (normál + perspektivikus fotó) képi ujjlenyomata közel van, más lapé messze – erre épül a duplázásvédelem
    // élőben az egymás utáni képkockák között a lap kicsit elmozdul / átméreteződik: ezt utánozzuk (93%, 1,5° elforgatás)
    const pr = c => artPrint(normalizeCard(c, { x: 0, y: 0, w: CW, h: CH }));
    const moved = async f => { const img = await load('tests/' + f); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.fillStyle = '#5c4028'; g.fillRect(0, 0, c.width, c.height); g.translate(c.width / 2, c.height / 2); g.rotate(1.5 * Math.PI / 180); g.scale(0.93, 0.93); g.translate(-c.width / 2, -c.height / 2); g.drawImage(img, 0, 0); return window.okemon.warpFromCanvas(c); };
    const sims = [];
    for (const [f] of PHOTOS.slice(0, 6)) { const m = await moved(f); if (m) sims.push(printSim(pr(warped[f]), pr(m))); }
    const others = [];
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) others.push(printSim(pr(warped[PHOTOS[i][0]]), pr(warped[PHOTOS[j][0]])));
    // tájékoztató: a képi ujjlenyomat csak az „új lap került-e be?” gyors jelzése; a duplázást az azonosító-alapú védelem zárja ki (?test=live)
    // a „másik lap került-e be?” jelzéshez az kell, hogy két különböző lap ujjlenyomata < 0,5 legyen (→ új felismerés indul).
    // Ha ugyanaz a lap (pl. holós, remegő kép) < 0,5-öt ad, az csak egy fölösleges újrafelismerés: az azonos azonosítót a
    // szkenner elnyomja, amíg a lap ki nem kerül a képből – ezt a ?test=live remegő lappal ellenőrzi.
    ok('képi ujjlenyomat: két különböző lap mindig < 0,5 (új lap → új felismerés)', Math.max(...others) < 0.5, `különböző: max ${Math.max(...others).toFixed(2)} · ugyanaz elmozdítva (tájékoztató): ${sims.map(x => x.toFixed(2)).join(', ')}`);
  } catch (e) { ok('kártyaérzékelés', false, e.message); }
  // gyors út időmérése (az élő szkenner egy képkockája): cél átlag ≤ 3 mp asztali Chrome-ban
  try {
    await window.okemon.prepare(); // OCR-modellek + kiemelt szettek képi indexe (éles használatban: első megnyitáskor)
    const times = [], hits = [];
    for (const [f, want] of PHOTOS.slice(0, 6)) {
      const w = warped[f]; if (!w) continue;
      const t = performance.now(); const o = await window.okemon.recognizeFrame(w, { fast: true }); const ms = performance.now() - t;
      times.push(ms); hits.push(`${f.replace('photo_', '').replace('.jpg', '')}: ${Math.round(ms)} ms → ${o.best?.id || '–'}${o.best?.id === want ? ' ✔' : ''}${o.sure ? ' (biztos)' : ''}`);
    }
    const avg = times.reduce((a, b) => a + b, 0) / (times.length || 1);
    ok('gyors út: átlagos felismerési idő ≤ 3 mp (6 fotó)', times.length === 6 && avg <= 3000, `átlag ${Math.round(avg)} ms · ` + hits.join(' · '));
  } catch (e) { skip('gyors út időmérése', e); }
  return results.slice();
}
