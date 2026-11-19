// Készletem: szett-logók, szett-katalógus rács (megvan / hiányzik + darabszám-karika), top 10.
// Logót soha nem találunk ki: TCGdex set.logo → pokemontcg.io images.logo → nincs (szöveges csempe).
import { Store } from './db.js';

const PTCG = 'https://api.pokemontcg.io/v2';
const WEEK = 7 * 864e5;
const norm = s => (s || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9]/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// pokemontcg.io szettlista (csak angol): név → logó; IndexedDB-ben 7 napig
let ptcgSetsP = null;
async function ptcgSets() {
  if (ptcgSetsP) return ptcgSetsP;
  ptcgSetsP = (async () => {
    const c = await Store.cacheGet('ptcg:sets', WEEK);
    if (c) return c;
    let r;
    for (let i = 0; i < 3; i++) { // a pokemontcg.io néha hibát ad (CORS-fejléc nélkül): két újrapróbálás
      try { r = await fetch(`${PTCG}/sets?pageSize=250&select=id,name,printedTotal,images`); if (r.ok) break; } catch { r = null; }
      await new Promise(res => setTimeout(res, 1200 * (i + 1)));
    }
    if (!r?.ok) throw new Error('pokemontcg.io nem elérhető');
    const d = (await r.json()).data || [];
    const slim = d.map(s => ({ id: s.id, name: s.name, printedTotal: s.printedTotal, logo: s.images?.logo || null }));
    Store.cacheSet('ptcg:sets', slim);
    return slim;
  })().catch(e => { ptcgSetsP = null; throw e; });
  return ptcgSetsP;
}

// A szett logójának URL-je, vagy null, ha egyik forrás sem ad logót.
export async function setLogo(lang, setData) {
  if (!setData) return null;
  if (setData.logo) return setData.logo + '.webp';                // TCGdex (kiterjesztés nélküli asset-URL)
  if (lang === 'JP' || lang === 'ja') return null;                 // japán szettekhez a pokemontcg.io nem ad logót
  try {
    const list = await ptcgSets();
    const n = norm(setData.name), off = +setData.cardCount?.official || 0;
    const hit = list.find(s => norm(s.name) === n)
      || list.find(s => off && s.printedTotal === off && (norm(s.name).includes(n) || n.includes(norm(s.name))));
    return hit?.logo || null;
  } catch { return null; }
}

// ---- katalógus ----
const numKey = c => /^\d+$/.test(c.localId) ? parseInt(c.localId, 10) : 1e6 + (parseInt(c.localId.replace(/\D/g, ''), 10) || 0);
// A szett összes lapja gyűjtői szám szerint (a nem számos, pl. TG/GG azonosítók a végén), darabszámmal.
export function catalogItems(setData, owned) {
  const qty = new Map(), uid = new Map();
  for (const c of owned) {
    if (c.deleted || !(c.qty > 0) || c.setId !== setData.id) continue;
    qty.set(c.apiId, (qty.get(c.apiId) || 0) + c.qty);
    if (!uid.has(c.apiId)) uid.set(c.apiId, c.uid);
  }
  const official = +setData.cardCount?.official || 0;
  return (setData.cards || []).slice().sort((a, b) => numKey(a) - numKey(b)).map(c => ({
    id: c.id, localId: c.localId, name: c.name, image: c.image || null,
    qty: qty.get(c.id) || 0, uid: uid.get(c.id) || null,
    secret: official > 0 && /^\d+$/.test(c.localId) && parseInt(c.localId, 10) > official,
  }));
}
// Rács HTML: hiányzó = szürke + halvány; megvan = színes + darabszám-karika (1 db-nál is)
export function catalogGridHtml(items, { filter = 'all', imgOf = c => c.image ? c.image + '/low.webp' : null } = {}) {
  const list = items.filter(c => filter === 'all' || (filter === 'owned' ? c.qty > 0 : c.qty === 0));
  if (!list.length) return `<div class="empty">${filter === 'missing' ? 'Nincs hiányzó lap – komplett! 🎉' : filter === 'owned' ? 'Ebből a szettből még nincs lapod.' : 'A szett laplistája üres az adatbázisban.'}</div>`;
  return '<div class="cgrid">' + list.map(c => {
    const src = imgOf(c);
    return `<div class="ctile ${c.qty > 0 ? 'own' : 'missing'}${c.secret ? ' secret' : ''}" data-cid="${esc(c.id)}"${c.uid ? ` data-uid="${esc(c.uid)}"` : ''} title="${esc(c.localId + ' ' + c.name)}">
      ${src ? `<img loading="lazy" decoding="async" src="${esc(src)}" alt="">` : `<div class="cnoimg">${esc(c.name)}</div>`}
      ${c.qty > 0 ? `<span class="qbadge">${c.qty}</span>` : ''}<span class="cnum">${esc(c.localId)}</span></div>`;
  }).join('') + '</div>';
}

// ---- top 10: egységár (HUF) szerint; az ár nélküliek kimaradnak ----
export function topCards(cards, hufOf, n = 10) {
  return cards.filter(c => !c.deleted && c.qty > 0 && hufOf(c) != null).sort((a, b) => hufOf(b) - hufOf(a)).slice(0, n);
}
