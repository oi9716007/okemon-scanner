// Képi index: szettenként a lapképek ujjlenyomata (256 bit + átlagszín), IndexedDB-ben tárolva.
// Ezzel akkor is felismerhető a lap, ha az OCR nem tud szöveget olvasni (holós teljes-art, japán stilizált név).
import { Store } from './db.js';
import { setCardImages } from './api.js';
import { printOfUrl, printSim, bestSim } from './recognize.js';

const MAX_AGE = 30 * 864e5;
const mem = new Map();
let placeholder = null;
const getPlaceholder = () => placeholder || (placeholder = printOfUrl('https://images.scrydex.com/pokemon/zzzz_ja-999/small'));

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export async function getIndex(lang, setId, onProgress, { cachedOnly = false } = {}) {
  const key = `idx:${lang}:${setId}`;
  if (mem.has(key)) return mem.get(key);
  const cached = await Store.cacheGet(key, MAX_AGE);
  if (cached) { mem.set(key, cached); return cached; }
  if (cachedOnly) return []; // gyors út: nem töltünk le új indexet szkennelés közben
  const cards = await setCardImages(lang, setId).catch(() => []);
  const ph = lang === 'ja' ? await getPlaceholder() : null;
  let done = 0, failed = 0;
  const out = [];
  await pool(cards, 8, async c => {
    let p = await printOfUrl(c.url);
    if (!p) { await new Promise(r => setTimeout(r, 400)); p = await printOfUrl(c.url + (c.url.includes('?') ? '&' : '?') + 'r=1'); } // egy újrapróbálás
    done++; onProgress?.(done, cards.length);
    if (!p) { failed++; return; }
    if (ph && printSim(p, ph) > 0.85) return; // a CDN kártyahátlapja: nincs kép
    out.push({ ...c, p });
  });
  // hiányos indexet (pl. hálózati hiba miatt) nem mentünk el tartósan: legközelebb újra próbálja
  if (out.length && failed <= Math.max(2, cards.length * 0.03)) await Store.cacheSet(key, out);
  else if (failed) console.warn(`képi index ${setId}: ${failed}/${cards.length} kép nem töltődött be – nem mentve`);
  mem.set(key, out);
  return out;
}

// sets: [[lang, setId], ...] → a legjobb egyezések csökkenő sorrendben
export async function imageSearch(print, sets, onProgress, opt = {}) {
  const res = [];
  let total = 0, base = 0;
  for (const [lang, setId] of sets) {
    const idx = await getIndex(lang, setId, (d, t) => onProgress?.(base + d, base + t), opt);
    base += idx.length; total += idx.length;
    for (const e of idx) res.push({ ...e, p: undefined, sim: bestSim(print, e.p) });
  }
  res.sort((a, b) => b.sim - a.sim);
  return res.slice(0, 10);
}

export async function buildIndex(sets, onProgress) {
  let n = 0;
  for (const [lang, setId] of sets) { const idx = await getIndex(lang, setId, (d, t) => onProgress?.(`${setId}: ${d}/${t}`)); n += idx.length; }
  return n;
}
