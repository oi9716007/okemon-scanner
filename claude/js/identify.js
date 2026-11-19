// Okemon Scanner – azonosítás: OCR-eredmény (recognize) → pontozott jelöltek → „biztos” döntés.
// A felülettől független, így tesztből is hívható. Nincs ritkaság-, típus- vagy szettszűrés:
// a teljes TCGdex EN + JA katalógusban keres (common, Trainer, Energy, régi szettek is).
import { getSets, findCandidates, jaImage } from './api.js';
import { bestSim, printOfUrl, ocrNameJa, detectScript } from './recognize.js';
import { imageSearch } from './imageindex.js';
import { FEATURED } from './packinfo.js';

const POOL_MAX = 14;
const featuredPairs = () => FEATURED.map(f => [f.lang === 'JP' ? 'ja' : 'en', f.setId]);

// képi pontszám a szöveges jelöltekre
async function scoreImages(r, cands, list) {
  await Promise.all(list.map(async c => {
    if (c.sim != null) return;
    let url = c.image ? c.image + '/low.webp' : c.imgUrl || null;
    if (!url && c.lang === 'ja') { const ji = await jaImage(c.setId, c.localId).catch(() => null); if (ji) { url = ji.small; c.imgUrl = ji.small; } }
    if (!url) return;
    const p = await printOfUrl(url);
    if (!p) return;
    c.sim = bestSim(r.prints || r.print, p);
    c.score += 4 * c.sim;
    if (c.sim > 0.5) c.why.push('kép');
  }));
  cands.sort((a, b) => b.score - a.score);
}
// a döntetlen környéki jelöltek mind kapjanak képi pontot (pl. 022/128 angol és japán szettben is létezik)
const nearTop = cands => cands.filter(c => c.score >= (cands[0]?.score ?? 0) - 2).slice(0, 16).concat(cands.slice(0, 6));

// Melyik szettekben keressünk képpel, ha a szöveg nem elég?
async function imagePool(r, cands, ctx) {
  const langs = ctx.lang === 'auto' ? ['en', 'ja'] : [ctx.lang];
  const pool = [];
  const push = p => { if (langs.includes(p[0]) && !pool.some(x => x[0] === p[0] && x[1] === p[1])) pool.push(p); };
  // 1) az OCR szettkódja (japán: M6a, SV2a…) és szett-összlapszáma (pl. /103)
  for (const l of langs) {
    const sets = await getSets(l).catch(() => []);
    if (l === 'ja') r.setCodes.forEach(code => { if (sets.some(s => s.id === code)) push(['ja', code]); });
    if (r.total) sets.filter(s => +s.cardCount?.official === +r.total).slice(-4).reverse().forEach(s => push([l, s.id]));
  }
  // 2) a 4 kiemelt szett mindig (különben a sok „legutóbbi” szett kiszoríthatná őket)
  featuredPairs().forEach(push);
  // 3) a szöveges jelöltek szettjei, 4) mostanában szkennelt és a készletben szereplő szettek
  cands.slice(0, 4).forEach(c => push([c.lang, c.setId]));
  (ctx.recentSets || []).forEach(push);
  (ctx.ownedSets || []).forEach(push);
  return pool.slice(0, POOL_MAX);
}

export async function identify(r, ctx = {}) {
  const lang = ctx.lang || 'auto';
  const status = ctx.onStatus || (() => {});
  const q = { lang, number: r.number, total: r.total, name: r.name, setCodes: r.setCodes, hasJapanese: r.hasJapanese };
  let cands = [];
  if (r.number || r.name) {
    status('Keresés az adatbázisban…');
    cands = await findCandidates(q);
    status('Képi összevetés…');
    await scoreImages(r, cands, nearTop(cands));
  }
  // Japán név utólag: csak akkor fogadjuk el, ha a név tényleg egyezik egy lappal (különben szemét kiszorítaná a jó jelöltet)
  const nameHit = cands.slice(0, 3).some(c => c.why.includes('név'));
  if (lang !== 'en' && !r.nameJa && !nameHit && (cands.slice(0, 3).some(c => c.lang === 'ja') || !cands.length || !r.number) && ctx.allowJaName !== false) {
    status('Japán név olvasása…');
    try {
      for (const n of await ocrNameJa(r.card, { max: ctx.allowJaName === 'one' ? 1 : 3 })) {
        const jc = await findCandidates({ ...q, lang: 'ja', name: n, hasJapanese: true });
        if (!jc[0]?.why.includes('név')) continue;
        r.nameJa = n; r.hasJapanese = true;
        const seen = new Map(cands.map(c => [c.lang + c.id, c]));
        for (const c of jc) { const ex = seen.get(c.lang + c.id); if (ex) { if (!ex.why.includes('név')) { ex.score += 4 * 0.8; ex.why.push('név'); } } else cands.push(c); }
        cands.sort((a, b) => b.score - a.score);
        await scoreImages(r, cands, nearTop(cands));
        break;
      }
    } catch (e) { console.warn(e); }
  }
  // sok azonos nevű lap (pl. több tucat Charizard): a névvel egyezőket is vessük össze képpel, ne csak a pontszám-élbolyt
  const nameTied = cands.filter(c => c.why.includes('név') && c.sim == null);
  if (nameTied.length > 3) { status('Képi összevetés…'); await scoreImages(r, cands, nameTied.slice(0, 40)); }
  let best = cands[0], second = cands[1];
  let sure = !!best && best.score >= 7 && (!second || best.score - second.score >= 1.5);
  let via = sure ? 'szöveg' : null;

  // Ha a szöveg nem elég (holós lap, olvashatatlan név/szám, japán stilizált betű): képi keresés szett-indexekben
  if (!sure && ctx.imageSearch !== false) {
    const pool = await imagePool(r, cands, { ...ctx, lang });
    const img = await imageSearch(r.prints || r.print, pool, (d, t) => status(`Képi keresés… ${d}/${t}`), { cachedOnly: !!ctx.fast });
    const [i1, i2] = img;
    if (i1 && i1.sim >= 0.3) {
      const numOk = c => r.number && parseInt(String(c.localId).replace(/\D/g, ''), 10) === parseInt(String(r.number).replace(/\D/g, ''), 10);
      const margin = i1.sim - (i2?.sim || 0);
      // képi biztos: egyértelmű kép-előny, vagy jó kép + a kiolvasott szám is egyezik
      const imgSure = margin >= 0.12 || !!(i1.sim >= 0.35 && margin >= 0.06 && numOk(i1));
      for (const ic of img.slice(0, 6)) {
        const ex = cands.find(c => c.id === ic.id && c.lang === ic.lang);
        const add = 6 * ic.sim + (imgSure && ic === i1 ? 4 : 0);
        if (ex) { if (ex.sim == null) { ex.sim = ic.sim; ex.score += add; ex.why.push('kép'); } else if (imgSure && ic === i1) ex.score += 4; }
        else cands.push({ ...ic, imgUrl: ic.url, image: null, score: add + (numOk(ic) ? 2 : 0), why: ['kép ' + Math.round(ic.sim * 100) + '%'] });
      }
      // nagyon erős képi egyezés, ami messze jobb a csak névben egyező lapokénál (pl. sok „Wishiwashi” más-más rajzzal):
      // a kép döntsön – a rossz rajzú névrokonok ne előzzék meg
      const textOnly = cands.filter(c => c !== cands.find(x => x.id === i1.id && x.lang === i1.lang) && c.why.some(w => w === 'név' || w === 'szám'));
      const bestTextSim = Math.max(0, ...textOnly.map(c => c.sim || 0));
      const strong = cands.find(c => c.id === i1.id && c.lang === i1.lang);
      if (strong && i1.sim >= 0.6 && i1.sim - bestTextSim >= 0.25 && !strong.why.includes('erős kép')) { strong.score += 3; strong.why.push('erős kép'); }
      cands.sort((a, b) => b.score - a.score);
      // azonos rajzú angol–japán pár (csak képi bizonyíték, közeli hasonlóság): a szöveg írásrendszere dönt
      const [c1, c2] = cands, textEv = c => ['szám', 'név', 'szettkód'].some(w => c?.why?.some(x => x === w));
      if (c1 && c2 && c1.lang !== c2.lang && !textEv(c1) && Math.abs((c1.sim || 0) - (c2.sim || 0)) < 0.18 && ctx.lang === 'auto') {
        status('Nyelv ellenőrzése…');
        const sc = await detectScript(r.card).catch(() => null);
        if (sc?.lang) { for (const c of cands) if (c.lang === sc.lang && c.sim != null) { c.score += 3; c.why.push(sc.lang === 'ja' ? 'japán szöveg' : 'angol szöveg'); } cands.sort((a, b) => b.score - a.score); r.scriptLang = sc.lang; }
      }
      best = cands[0]; second = cands[1];
      sure = (imgSure && best.id === i1.id && best.lang === i1.lang || (r.scriptLang === best.lang && (best.sim || 0) >= 0.4)) && best.score >= 6 && (!second || best.score - second.score >= 1.5);
      if (sure) via = 'kép';
    }
  }
  return { cands, best: cands[0] || null, sure: !!sure, via };
}
