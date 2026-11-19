// Okemon Scanner – kártya-, ár- és árfolyam-források.
//  • TCGdex (api.tcgdex.net)   – EN + JA lapok, képek, Cardmarket (EUR) és TCGplayer (USD) árak. Elsődleges.
//  • Pokémon TCG API (pokemontcg.io) – angol tartalék (kép + ár), ha a TCGdex-ben nincs ár/kép.
//  • Frankfurter (ECB) / open.er-api – élő EUR/USD→HUF árfolyam.
// SZABÁLY: árat soha nem találunk ki. Ha egyik forrásnak sincs ára, a price = null.
import { Store } from './db.js';

const TD = 'https://api.tcgdex.net/v2';
const PTCG = 'https://api.pokemontcg.io/v2';
const DAY = 864e5;

async function getJSON(url, { timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function cached(key, maxAge, fn) {
  const c = await Store.cacheGet(key, maxAge);
  if (c) return c;
  const v = await fn();
  if (v) Store.cacheSet(key, v);
  return v;
}

export const LANGS = { en: 'EN', ja: 'JP' };
const apiLang = l => (l === 'JP' || l === 'ja') ? 'ja' : 'en';

// ---------- szettek ----------
export async function getSets(lang) {
  const l = apiLang(lang);
  return cached('sets:' + l, DAY, () => getJSON(`${TD}/${l}/sets`));
}
export async function getSet(lang, id) {
  const l = apiLang(lang);
  return cached(`set:${l}:${id}`, DAY, () => getJSON(`${TD}/${l}/sets/${encodeURIComponent(id)}`));
}
async function setMap(lang) {
  const m = new Map();
  (await getSets(lang) || []).forEach(s => m.set(s.id, s));
  return m;
}

// ---------- lapok ----------
export async function getCard(lang, id, { fresh = false } = {}) {
  const l = apiLang(lang);
  const k = `card:${l}:${id}`;
  if (!fresh) { const c = await Store.cacheGet(k, 6 * 3600e3); if (c) return c; }
  const c = await getJSON(`${TD}/${l}/cards/${encodeURIComponent(id)}`);
  Store.cacheSet(k, c);
  return c;
}
const setIdOf = brief => brief.id.slice(0, brief.id.length - brief.localId.length - 1);
const pad3 = s => /^\d+$/.test(s) ? s.padStart(3, '0') : s;

export async function searchByLocalId(lang, localId) {
  const l = apiLang(lang);
  const vars = [...new Set([localId, String(parseInt(localId, 10)), pad3(localId)].filter(v => v && v !== 'NaN'))];
  const res = await Promise.all(vars.map(v => cached(`lid:${l}:${v}`, DAY, () => getJSON(`${TD}/${l}/cards?localId=${encodeURIComponent(v)}`)).catch(() => [])));
  const seen = new Map();
  res.flat().forEach(c => seen.set(c.id, c));
  return [...seen.values()];
}
export async function searchByName(lang, name) {
  const l = apiLang(lang);
  if (!name || name.length < 2) return [];
  return cached(`name:${l}:${name.toLowerCase()}`, DAY, () => getJSON(`${TD}/${l}/cards?name=like:${encodeURIComponent(name)}`)).catch(() => []);
}
// OCR-zajos névhez: teljes név → leghosszabb szavak eleje → (japánnál) egyre rövidebb előtagok
export async function fuzzyNameSearch(lang, name) {
  const l = apiLang(lang);
  let r = await searchByName(l, name);
  if (r.length) return r;
  const tries = [];
  if (/[぀-ヿ一-鿿]/.test(name)) {
    const jn = name.replace(/[^぀-ヿ一-鿿ー]/g, '');
    for (let n = jn.length - 1; n >= 4; n--) tries.push(jn.slice(0, n));
    // OCR gyakran elhagyja / hozzáteszi a dakutent (サ↔ザ, ハ↔バ↔パ): az első 4 karakterben egy-egy csere, 4 hosszú előtaggal
    const toggles = ch => { const d = ch.normalize('NFD'); if (d.length > 1) return [d[0], (d[0] + (d[1] === '゙' ? '゚' : '゙')).normalize('NFC')].filter(x => x.length === 1 && x !== ch); return ['゙', '゚'].map(m => (ch + m).normalize('NFC')).filter(x => x.length === 1); };
    const base = jn.slice(0, Math.min(5, jn.length));
    for (let i = 0; i < Math.min(4, base.length); i++) for (const alt of toggles(base[i])) tries.push((base.slice(0, i) + alt + base.slice(i + 1)).slice(0, 4));
    for (let n = Math.min(3, jn.length - 1); n >= 2; n--) tries.push(jn.slice(0, n));
  } else {
    const words = name.split(/\s+/).map(w => w.replace(/[^A-Za-z']/g, '')).filter(w => w.length >= 4).sort((a, b) => b.length - a.length);
    for (const w of words.slice(0, 2)) { tries.push(w); if (w.length >= 6) tries.push(w.slice(0, 5)); tries.push(w.slice(-5)); }
  }
  const out = new Map();
  for (const t of [...new Set(tries)].slice(0, 16)) {
    const res = await searchByName(l, t);
    res.forEach(c => out.set(c.id, c));
    // csak akkor állunk meg, ha a találatok közt van a kiolvasott névhez tényleg hasonló
    if (res.some(c => nameSim(name, c.name) > 0.6)) break;
  }
  return [...out.values()].slice(0, 120);
}

// Japán lapkép: a TCGdex-ben az új japán szettekhez gyakran nincs kép → Scrydex CDN (a pokemontcg.io képszervere).
// A nem létező lapra a CDN egy kártyahátlapot ad vissza (fix méret) – ezt kiszűrjük.
const SCRYDEX_PLACEHOLDER = { small: '53687', large: '350441' };
export async function jaImage(setId, localId) {
  const n = parseInt(String(localId).replace(/\D/g, ''), 10);
  if (!n) return null;
  const base = `https://images.scrydex.com/pokemon/${setId.toLowerCase()}_ja-${n}`;
  return cached('jaimg:' + base, 7 * DAY, async () => {
    try {
      const r = await fetch(base + '/small', { method: 'HEAD' });
      if (!r.ok || r.headers.get('content-length') === SCRYDEX_PLACEHOLDER.small) return { none: true };
      return { small: base + '/small', large: base + '/large' };
    } catch { return null; }
  }).then(v => v && !v.none ? v : null);
}

// Japán lap keresése angol névvel: EN név → Pokédex-szám → JA lapok
export async function searchJaByEnglishName(name) {
  const en = (await searchByName('en', name)).slice(0, 6);
  const dex = new Set();
  for (const b of en.slice(0, 3)) {
    try { (await getCard('en', b.id)).dexId?.forEach(d => dex.add(d)); } catch {}
  }
  const out = [];
  for (const d of dex) out.push(...await cached(`dex:ja:${d}`, DAY, () => getJSON(`${TD}/ja/cards?dexId=eq:${d}`)).catch(() => []));
  return out;
}

// ---------- szöveg-hasonlóság ----------
export function norm(s) {
  // a dakuten/handakuten (゛゜) és az ékezetek nem számítanak: az OCR gyakran elhagyja őket (リサードン ≈ リザードン)
  return (s || '').toLowerCase().normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f\u3099\u309a]/g, '').normalize('NFC').replace(/[^a-z0-9぀-ヿ一-鿿]/g, '');
}
function lev(a, b) {
  if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function nameSim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // rész-szöveg egyezés csak érdemi átfedésnél (különben pl. az OCR-szemét „MISA” ≈ „Simisage” lenne)
  const contain = (long, short) => short.length >= 3 && long.includes(short) && (short.length / long.length >= 0.6 || (short.length >= 5 && short.length / long.length >= 0.4));
  if (contain(a, b)) return 0.9;
  if (contain(b, a)) return 0.85;
  // a legjobb egyezés a hosszabb szöveg egy azonos hosszú részletével (OCR-zaj körülötte)
  let best = 1 - lev(a, b) / Math.max(a.length, b.length);
  if (a.length > b.length + 2) for (let i = 0; i + b.length <= a.length; i++) best = Math.max(best, 1 - lev(a.slice(i, i + b.length), b) / b.length - 0.05);
  return Math.max(0, best);
}

// legfeljebb egy karakter eltérés (azonos hossz) – OCR-tévesztés a számjegyben
const near1 = (a, b) => a.length === b.length && [...a].filter((c, i) => c !== b[i]).length <= 1;

// ---------- jelöltek keresése az OCR eredményéből ----------
// q: { lang: 'auto'|'en'|'ja', number, total, name, setCodes: [] }
export async function findCandidates(q) {
  const langs = q.lang === 'auto' ? ['en', 'ja'] : [apiLang(q.lang)];
  const all = [];
  for (const l of langs) {
    const sets = await setMap(l).catch(() => new Map());
    let briefs = [];
    if (q.number) briefs = await searchByLocalId(l, q.number);
    if (q.name && (!q.number || briefs.length === 0)) {
      briefs = briefs.concat(await fuzzyNameSearch(l, q.name));
      if (l === 'ja' && !/[぀-ヿ一-鿿]/.test(q.name)) briefs = briefs.concat(await searchJaByEnglishName(q.name).catch(() => []));
    }
    for (const b of briefs) {
      const sid = setIdOf(b);
      const st = sets.get(sid);
      let score = 0;
      const why = [];
      if (q.number && parseInt(b.localId.replace(/\D/g, ''), 10) === parseInt(String(q.number).replace(/\D/g, ''), 10)) { score += 2; why.push('szám'); }
      if (q.total && st?.cardCount?.official) {
        if (+st.cardCount.official === +q.total) { score += 3; why.push('szett-összlap'); }
        // OCR-hiba az összlapban (pl. 103 → 102): ha a név biztosan egyezik, ne büntessük
        else if (q.name && nameSim(q.name, b.name) > 0.8 && near1(String(st.cardCount.official), String(q.total))) { score += 1; why.push('összlap≈'); }
        else score -= 1.5;
      }
      if (q.setCodes?.length && q.setCodes.some(c => c.toLowerCase() === sid.toLowerCase())) { score += 4; why.push('szettkód'); }
      if (q.name) { const s = nameSim(q.name, b.name); score += 4 * s; if (s > 0.6) why.push('név'); }
      if (l === 'ja' && q.hasJapanese) score += 1;
      if (l === 'en' && q.hasJapanese === false && q.lang === 'auto') score += 0.3;
      all.push({ lang: l, id: b.id, localId: b.localId, name: b.name, image: b.image || null, setId: sid, setName: st?.name || sid, official: st?.cardCount?.official, score, why });
    }
  }
  // EN szettkód (pl. DLR) – csak a legjobb néhány jelölt szettjét kérjük le
  const enCodes = (q.setCodes || []).filter(c => /^[A-Z]{3}$/.test(c));
  if (enCodes.length) {
    const top = all.filter(c => c.lang === 'en').sort((a, b) => b.score - a.score).slice(0, 12);
    await Promise.all([...new Set(top.map(c => c.setId))].map(async sid => {
      const s = await getSet('en', sid).catch(() => null);
      const ab = s?.abbreviation?.official;
      if (ab && enCodes.includes(ab)) all.forEach(c => { if (c.lang === 'en' && c.setId === sid) { c.score += 3; c.why.push('szettkód'); } });
    }));
  }
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, 12);
}

// ---------- árak ----------
const pos = v => (typeof v === 'number' && v > 0) ? v : null;
const TP_KEYS = {
  normal: ['normal', 'holofoil', 'unlimited', 'unlimitedHolofoil', '1stEditionHolofoil', '1stEdition'],
  holo: ['holofoil', 'unlimitedHolofoil', 'normal', '1stEditionHolofoil'],
  reverse: ['reverse-holofoil', 'reverseHolofoil', 'reverse'],
};
// Visszaadja az összes elérhető árat (eredeti devizában) – semmi becslés.
export function extractPrices(pricing, variant = 'normal') {
  const out = {};
  const cm = pricing?.cardmarket;
  if (cm) {
    const v = variant === 'reverse'
      ? (pos(cm['trend-holo']) || pos(cm['avg30-holo']) || pos(cm['avg-holo']))
      : (pos(cm.trend) || pos(cm.avg30) || pos(cm.avg));
    const label = variant === 'reverse'
      ? (pos(cm['trend-holo']) ? 'trend (reverse)' : pos(cm['avg30-holo']) ? '30 napos átlag (reverse)' : 'átlag (reverse)')
      : (pos(cm.trend) ? 'trend' : pos(cm.avg30) ? '30 napos átlag' : 'átlag');
    if (v) out.cardmarket = { value: v, currency: cm.unit || 'EUR', label, low: variant === 'reverse' ? pos(cm['low-holo']) : pos(cm.low), updated: cm.updated };
  }
  const tp = pricing?.tcgplayer;
  if (tp) {
    for (const k of TP_KEYS[variant] || TP_KEYS.normal) {
      const p = tp[k];
      const v = p && (pos(p.marketPrice) || pos(p.midPrice));
      if (v) { out.tcgplayer = { value: v, currency: tp.unit || 'USD', label: (pos(p.marketPrice) ? 'market' : 'mid') + ' (' + k + ')', low: pos(p.lowPrice), updated: tp.updated }; break; }
    }
  }
  return out;
}
// Változat / árforrás-preferencia módosítása után az ár újraszámolása a tárolt nyers adatokból (hálózat nélkül).
export function repriceRecord(rec, pref) {
  if (!rec.pricingRaw) return rec; // pl. CSV-ből importált tétel: az „Ár frissítése” tölti be a nyers árakat
  rec.prices = extractPrices(rec.pricingRaw, rec.variant);
  const p = choosePrice(rec.prices, pref);
  rec.price = p ? p.value : null; rec.priceCurrency = p ? p.currency : null;
  rec.priceSource = p ? p.source + ' ' + p.label + ' via ' + (rec.pricingVia || 'TCGdex') : null;
  rec.priceSourceUpdated = p?.updated || null;
  return rec;
}
export function choosePrice(prices, pref = 'cardmarket') {
  const order = pref === 'tcgplayer' ? ['tcgplayer', 'cardmarket'] : ['cardmarket', 'tcgplayer'];
  for (const k of order) if (prices?.[k]) return { ...prices[k], source: k === 'cardmarket' ? 'Cardmarket' : 'TCGplayer' };
  return null;
}

// pokemontcg.io tartalék (csak angol): ár + kép
async function ptcgFallback(name, number, total) {
  const q = [`name:"${name.replace(/"/g, '')}"`, `number:${String(number).replace(/^0+/, '') || 0}`];
  if (total) q.push(`set.printedTotal:${total}`);
  const d = await getJSON(`${PTCG}/cards?q=${encodeURIComponent(q.join(' '))}&pageSize=3&select=id,name,number,images,tcgplayer,cardmarket,set`, { timeout: 15000 });
  const c = d?.data?.[0];
  if (!c) return null;
  const pricing = {};
  const cp = c.cardmarket?.prices;
  if (cp) pricing.cardmarket = { unit: 'EUR', trend: cp.trendPrice, avg30: cp.avg30, avg: cp.averageSellPrice, low: cp.lowPrice, 'trend-holo': cp.reverseHoloTrend, 'avg30-holo': cp.reverseHoloAvg30, 'low-holo': cp.reverseHoloLow, updated: c.cardmarket.updatedAt };
  if (c.tcgplayer?.prices) pricing.tcgplayer = { unit: 'USD', updated: c.tcgplayer.updatedAt, ...Object.fromEntries(Object.entries(c.tcgplayer.prices).map(([k, v]) => [k, { marketPrice: v.market, midPrice: v.mid, lowPrice: v.low }])) };
  return { pricing, image: c.images?.large || c.images?.small, ptcgId: c.id };
}

// Teljes lapadat (a készletrekord alapja) egy TCGdex-azonosítóból
export async function cardRecord(lang, id, { variant, fresh = false, pref = 'cardmarket' } = {}) {
  const l = apiLang(lang);
  const c = await getCard(l, id, { fresh });
  const set = await getSet(l, c.set.id).catch(() => null);
  const v = c.variants || {};
  variant = variant || (v.normal === false && v.holo ? 'holo' : 'normal');
  let pricing = c.pricing || null;
  let prices = extractPrices(pricing, variant);
  let image = c.image ? c.image + '/high.webp' : null;
  let imageSmall = c.image ? c.image + '/low.webp' : null;
  let fallbackUsed = false;
  if (l === 'ja' && !image) {
    const ji = await jaImage(c.set.id, c.localId).catch(() => null);
    if (ji) { image = ji.large; imageSmall = ji.small; }
  }
  if (l === 'en' && (!Object.keys(prices).length || !image)) {
    try {
      const fb = await ptcgFallback(c.name, c.localId, c.set?.cardCount?.official);
      if (fb) {
        if (!Object.keys(prices).length) { prices = extractPrices(fb.pricing, variant); fallbackUsed = Object.keys(prices).length > 0; if (fallbackUsed) pricing = fb.pricing; }
        if (!image && fb.image) { image = imageSmall = fb.image; }
      }
    } catch (e) { console.warn('pokemontcg.io tartalék hiba', e); }
  }
  const price = choosePrice(prices, pref);
  return {
    apiId: c.id,
    lang: l === 'ja' ? 'JP' : 'EN',
    name: c.name,
    setId: c.set.id,
    setName: c.set.name,
    setCode: (l === 'ja' ? c.set.id : (set?.abbreviation?.official || c.set.id)),
    series: set?.serie?.name || '',
    number: c.localId,
    printedTotal: c.set?.cardCount?.official || set?.cardCount?.official || null,
    rarity: c.rarity || '',
    category: c.category || '', // Pokemon / Trainer / Energy (TCGdex)
    image, imageSmall,
    illustrator: c.illustrator || '',
    dexId: c.dexId || [],
    variants: v,
    variant,
    prices,
    pricingRaw: pricing,
    pricingVia: fallbackUsed ? 'pokemontcg.io' : 'TCGdex',
    price: price ? price.value : null,
    priceCurrency: price ? price.currency : null,
    priceSource: price ? price.source + ' ' + price.label + (fallbackUsed ? ' via pokemontcg.io' : ' via TCGdex') : null,
    priceUpdatedAt: new Date().toISOString(),
    priceSourceUpdated: price?.updated || null,
  };
}

// ---------- árfolyam ----------
export async function fetchFx() {
  try {
    const d = await getJSON('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=HUF,USD', { timeout: 10000 });
    if (d?.rates?.HUF && d.rates.USD) return { eurHuf: d.rates.HUF, usdHuf: d.rates.HUF / d.rates.USD, date: d.date, source: 'Frankfurter / EKB', fetchedAt: new Date().toISOString() };
  } catch (e) { console.warn(e); }
  const d = await getJSON('https://open.er-api.com/v6/latest/EUR', { timeout: 10000 });
  if (d?.rates?.HUF && d.rates.USD) return { eurHuf: d.rates.HUF, usdHuf: d.rates.HUF / d.rates.USD, date: d.time_last_update_utc, source: 'open.er-api.com', fetchedAt: new Date().toISOString() };
  throw new Error('Nincs árfolyam');
}

// Egy szett összes lapja képpel (a képi kereséshez). Japánnál, ha a TCGdex-ben nincs kép, Scrydex-URL.
export async function setCardImages(lang, setId) {
  const l = apiLang(lang);
  const s = await getSet(l, setId);
  return (s.cards || []).map(c => {
    let url = c.image ? c.image + '/low.webp' : null;
    if (!url && l === 'ja') { const n = parseInt(c.localId.replace(/\D/g, ''), 10); if (n) url = `https://images.scrydex.com/pokemon/${setId.toLowerCase()}_ja-${n}/small`; }
    return { lang: l, id: c.id, localId: c.localId, name: c.name, url, setId, setName: s.name, official: s.cardCount?.official };
  }).filter(c => c.url);
}
