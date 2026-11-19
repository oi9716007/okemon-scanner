// Okemon Scanner – felület
import { Store, onChange, itemKey } from './db.js';
import { extractPrices, choosePrice, getSets, getSet, getCard, searchByName, searchJaByEnglishName, findCandidates, cardRecord, repriceRecord, fetchFx, nameSim, jaImage, setCardImages } from './api.js';
import { recognize, printSim, printOfUrl, thumb, normalizeCard, warmUp, ocrNameJa } from './recognize.js';
import { imageSearch, buildIndex, getIndex } from './imageindex.js';
import { identify } from './identify.js';
import { computeProgress } from './completeness.js';
import { setLogo, catalogItems, catalogGridHtml, topCards } from './catalog.js';
import { recordPrices, referenceLines, chartSvg, today, SRC } from './history.js';
import { SnapScanner, CAMERA_HELP } from './snap.js';
import { detectQuad, warpPerspective } from './detect-core.js';
import { CW, CH } from './recognize.js';
import { packInfo, FEATURED, isFeatured, setTitle } from './packinfo.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtHuf = v => v == null ? '–' : Math.round(v).toLocaleString('hu-HU') + ' Ft';
const fmtCur = (v, c) => v == null ? '–' : (c === 'EUR' ? '€' : c === 'USD' ? '$' : '') + v.toFixed(2) + (c && c !== 'EUR' && c !== 'USD' ? ' ' + c : '');
const fmtDate = s => s ? new Date(s).toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const CONDS = [['NM', 'Near Mint'], ['LP', 'Lightly Played'], ['MP', 'Moderately Played'], ['HP', 'Heavily Played'], ['DMG', 'Damaged']];
const VARS = { normal: 'Normál', holo: 'Holo', reverse: 'Reverse holo' };
const CATS = { Pokemon: 'Pokémon', Trainer: 'Trainer', Energy: 'Energy' };

let S = { fastMode: false, catFilter: 'all', setSort: 'value', compMode: 'total', pref: 'cardmarket', fxManual: false, eurHuf: null, usdHuf: null, fx: null, lastRefresh: null, scanLang: 'auto' };
let CARDS = [];

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
async function saveSettings() { await Store.meta('settings', S); }

// ---------- pénzügy ----------
function rate(cur) {
  if (cur === 'EUR') return S.eurHuf;
  if (cur === 'USD') return S.usdHuf;
  if (cur === 'HUF') return 1;
  return null;
}
const hufOf = c => (c.price == null || rate(c.priceCurrency) == null) ? null : c.price * rate(c.priceCurrency);
function totals(list = CARDS) {
  let sum = 0, cards = 0, noPrice = 0, noPriceUnique = 0;
  for (const c of list) {
    const q = c.qty || 0; cards += q;
    const h = hufOf(c);
    if (h == null) { noPrice += q; noPriceUnique++; } else sum += h * q;
  }
  return { sum, cards, unique: list.length, noPrice, noPriceUnique };
}

// ---------- navigáció ----------
function go(v) {
  $$('.view').forEach(e => e.classList.toggle('active', e.id === 'v-' + v));
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.go === v));
  document.body.classList.toggle('scan-mode', v === 'scan');
  if (v === 'scan') { if (!location.search.includes('test=')) startLive(); } else stopLive();
  if (v === 'coll') renderColl();
  window.scrollTo(0, 0);
  history.replaceState(null, '', '#' + v);
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go);
  if (e.target.closest('[data-close]')) closeSheet();
});

// ---------- főképernyő ----------
function cardImg(c, cls = '') {
  const src = c.imageSmall || c.image || c.photo;
  return src ? `<img loading="lazy" class="${cls}" src="${esc(src)}" alt="">` : `<div class="noimg ${cls}">${esc(c.name)}</div>`;
}
function itemRow(c) {
  const h = hufOf(c);
  return `<div class="item" data-uid="${c.uid}">${cardImg(c)}
    <div class="mid"><b>${c.qty > 1 ? `<span class="qty">${c.qty}×</span>` : ''}${esc(c.name)}</b>
      <small>${c.lang === 'JP' ? '🇯🇵' : '🇬🇧'} ${esc(setTitle(c, true))} · ${esc(c.number)}${c.printedTotal ? '/' + c.printedTotal : ''}</small>
      <small>${c.category && c.category !== 'Pokemon' ? `<span class="cat">${esc(CATS[c.category] || c.category)}</span> ` : ''}${esc(c.rarity || '')}${c.variant && c.variant !== 'normal' ? ' · ' + VARS[c.variant] : ''}${c.condition && c.condition !== 'NM' ? ' · ' + c.condition : ''}</small></div>
    <div class="val">${h == null ? '<span class="noprice">nincs ár</span>' : `<b>${fmtHuf(h * c.qty)}</b><small>${fmtCur(c.price, c.priceCurrency)}${c.qty > 1 ? ' /db' : ''}</small>`}</div></div>`;
}
function renderHome() {
  const t = totals();
  $('#totalHuf').textContent = fmtHuf(t.sum);
  $('#stCards').textContent = t.cards;
  $('#stUnique').textContent = t.unique;
  $('#stNoPrice').textContent = t.noPrice;
  $('#lastRefresh').textContent = 'Utolsó árfrissítés: ' + fmtDate(S.lastRefresh);
  $('#fxLine').textContent = S.eurHuf ? `Árfolyam: 1 € = ${S.eurHuf.toFixed(2)} Ft · 1 $ = ${S.usdHuf.toFixed(2)} Ft (${S.fxManual ? 'kézi' : (S.fx?.source || 'élő') + ', ' + (S.fx?.date || '')})` : 'Árfolyam: nincs – állítsd be a Beállításokban';
  // kiemelt szettek
  // (a 30th Celebration Classic Collection – 30th-c – mindenhol külön szettként szerepel)
  $('#featured').innerHTML = FEATURED.map(f => {
    const l = CARDS.filter(c => c.lang === f.lang && c.setId === f.setId);
    const tt = totals(l);
    return `<div class="feat" data-fset="${f.lang}|${f.setId}"><b>${f.flag} ${esc(f.label)}</b><small>${tt.cards} lap${tt.noPrice ? ' · ' + tt.noPrice + ' ár nélkül' : ''}</small><div class="v">${fmtHuf(tt.sum)}</div>${progMini(f.lang, f.setId, true)}</div>`;
  }).join('');
  $$('#compSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.compMode));
  // szettenként
  const m = new Map();
  for (const c of CARDS) {
    const k = c.lang + '|' + c.setId;
    const e = m.get(k) || { name: setTitle(c), lang: c.lang, setId: c.setId, list: [] };
    e.list.push(c); m.set(k, e);
  }
  const sets = [...m.values()].map(e => ({ ...e, t: totals(e.list) })).sort((a, b) => b.t.sum - a.t.sum);
  const max = Math.max(1, ...sets.map(s => s.t.sum));
  $('#bySet').innerHTML = sets.length ? sets.map(s => `<div class="setrow" data-fset="${s.lang}|${s.setId}"><div class="l"><div>${s.lang === 'JP' ? '🇯🇵' : '🇬🇧'} ${esc(s.name)} ${isFeatured(s) ? '<span class="badge">kiemelt</span>' : ''}</div><small>${s.t.cards} lap${s.t.noPrice ? ' · ' + s.t.noPrice + ' ár nélkül' : ''}</small>${progMini(s.lang, s.setId)}</div>${s.t.noPrice === s.t.cards ? '<span class="noprice">nincs ár</span>' : `<b>${fmtHuf(s.t.sum)}</b>`}</div>`).join('') : '<div class="empty">Még nincs lap a készletben. Szkennelj be egyet!</div>';
  ensureSetData([...FEATURED.map(f => [f.lang, f.setId]), ...sets.map(x => [x.lang, x.setId])]);
  const top = CARDS.filter(c => hufOf(c) != null).sort((a, b) => hufOf(b) - hufOf(a)).slice(0, 10);
  $('#topCards').innerHTML = top.length ? top.map(itemRow).join('') : '<div class="empty">Nincs áras lap.</div>';
}
document.addEventListener('click', e => {
  const f = e.target.closest('[data-fset]');
  if (f) { const [l, s] = f.dataset.fset.split('|'); openSetSheet(l, s); }
  const it = e.target.closest('.item[data-uid]');
  if (it) openDetail(it.dataset.uid);
});

// tájékoztató ár egy (nem birtokolt) laphoz – csak a forrás adata, semmi becslés
const choosePriceOf = (full, pref) => choosePrice(extractPrices(full.pricing, full.variants?.normal === false && full.variants?.holo ? 'holo' : 'normal'), pref);

// ---------- szett-komplettség ----------
const setData = new Map(); // 'EN|me06' → getSet() eredmény (IndexedDB-cache-ből)
const loadingSets = new Set(), failedSets = new Map();
function ensureSetData(pairs) {
  const now = Date.now();
  const need = pairs.filter(([l, s]) => { const k = l + '|' + s; return !setData.has(k) && !loadingSets.has(k) && !(failedSets.get(k) > now - 60e3); });
  if (!need.length) return;
  need.forEach(([l, s]) => loadingSets.add(l + '|' + s));
  Promise.all(need.map(([l, s]) => getSet(l === 'JP' ? 'ja' : 'en', s).then(d => setData.set(l + '|' + s, d)).catch(() => failedSets.set(l + '|' + s, Date.now())).finally(() => loadingSets.delete(l + '|' + s))))
    .then(() => { renderHome(); if ($('#v-coll').classList.contains('active')) renderColl(); });
}
function progressOf(lang, setId, mode = S.compMode) {
  const d = setData.get(lang + '|' + setId);
  return d ? computeProgress(d, CARDS.filter(c => c.lang === lang), mode) : null;
}
const progText = p => `${p.haveTotal} / ${p.total} teljes · ${p.haveOfficial} / ${p.official} hivatalos · <b>${p.missingCount}</b> hiányzik`;
function progMini(lang, setId, compact = false) {
  const p = progressOf(lang, setId);
  if (!p) return `<div class="prog"><small>${failedSets.has(lang + '|' + setId) ? 'komplettség most nem elérhető (nincs hálózat?)' : 'komplettség betöltése…'}</small></div>`;
  const txt = compact ? `${p.have} / ${p.of} ${p.mode === 'official' ? 'hivatalos' : 'teljes'} · <b>${p.missingCount}</b> hiányzik` : progText(p);
  return `<div class="prog"><div class="pbar"><i style="width:${(p.pct * 100).toFixed(1)}%"></i></div><small>${txt}</small></div>`;
}
$('#compSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.compMode = b.dataset.mode; saveSettings(); renderHome(); };

// Szett-katalógus: a szett teljes lapkínálata rácsban – hiányzó = szürke/halvány, megvan = színes + darabszám-karika
async function openSetSheet(lang, setId, filter = 'all') {
  if (filter === 'missing' || filter === 'owned' || filter === 'all') S.catFilter = filter;
  let d = setData.get(lang + '|' + setId);
  openSheet('<div class="hint">Szett betöltése…</div>');
  if (!d) { try { d = await getSet(lang === 'JP' ? 'ja' : 'en', setId); setData.set(lang + '|' + setId, d); } catch (e) { $('#sheetContent').innerHTML = '<div class="hint">Nem sikerült betölteni a szettet: ' + esc(e.message) + '</div>'; return; } }
  const mine = CARDS.filter(c => c.lang === lang && c.setId === setId);
  const p = computeProgress(d, mine, S.compMode);
  const t = totals(mine);
  const title = setTitle({ lang, setId, setName: d.name });
  const items = catalogItems(d, mine);
  const shown = S.compMode === 'official' ? items.filter(c => !c.secret && /^\d+$/.test(c.localId)) : items;
  const imgOf = c => c.image ? c.image + '/low.webp' : (lang === 'JP' && /\d/.test(c.localId) ? `https://images.scrydex.com/pokemon/${setId.toLowerCase()}_ja-${parseInt(c.localId.replace(/\D/g, ''), 10)}/small` : null);
  const nOwn = shown.filter(c => c.qty > 0).length;
  $('#sheetContent').innerHTML = `<div class="cat-head"><div class="cat-logo" id="catLogo"><span>${esc(title)}</span></div>
      <div><h3 style="margin:0 0 2px">${lang === 'JP' ? '🇯🇵 JP' : '🇬🇧 EN'} · ${esc(title)} ${isFeatured({ lang, setId }) ? '<span class="badge">kiemelt</span>' : ''}</h3>
      <div class="hint cat-meta"><span>${esc(setId)}</span>${d.abbreviation?.official ? ` · <span>${esc(d.abbreviation.official)}</span>` : ''}${d.releaseDate ? ` · <span>${esc(d.releaseDate)}</span>` : ''}</div></div></div>
    <div class="comp-big"><b>${p.have}</b> / ${p.of} <span>megvan · ${p.missingCount} hiányzik</span></div>
    <div class="pbar big"><i style="width:${(p.pct * 100).toFixed(1)}%"></i></div>
    <div class="hint">${progText(p)}</div>
    <div class="seg small" id="sMode"><button data-mode="total" class="${S.compMode === 'total' ? 'on' : ''}">Teljes szett (${p.total})</button><button data-mode="official" class="${S.compMode === 'official' ? 'on' : ''}">Hivatalos (${p.official})</button></div>
    <div class="hint">A meglévő lapok értéke: <b style="color:var(--gold)">${fmtHuf(t.sum)}</b>${t.noPrice ? ` · ${t.noPrice} lap ár nélkül` : ''}. A hiányzó lapok nem számítanak bele.</div>
    <div class="seg small" id="sFilter"><button data-f="all" class="${S.catFilter === 'all' ? 'on' : ''}">Mind (${shown.length})</button><button data-f="owned" class="${S.catFilter === 'owned' ? 'on' : ''}">Megvan (${nOwn})</button><button data-f="missing" class="${S.catFilter === 'missing' ? 'on' : ''}">Hiányzik (${shown.length - nOwn})</button></div>
    ${p.total > items.length ? `<p class="hint">Az adatbázis laplistája hiányos ehhez a szetthez (${items.length} lap listázható a ${p.total}-ból).</p>` : ''}
    <div id="catGrid">${catalogGridHtml(shown, { filter: S.catFilter, imgOf })}</div>
    <p class="hint">Koppints egy lapra: a meglévő lap adatlapja nyílik; hiányzó lapnál a ritkaság és a tájékoztató piaci ár jelenik meg.</p>
    <div class="row"><button class="btn grow small" id="sOpenColl">🗂 Megnyitás a listában</button></div>`;
  setLogo(lang, d).then(u => { const el = $('#catLogo'); if (u && el) el.innerHTML = `<img src="${esc(u)}" alt="${esc(title)}" onerror="this.parentNode.innerHTML='<span>${esc(title).replace(/'/g, '')}</span>'">`; });
  $('#sMode').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.compMode = b.dataset.mode; saveSettings(); renderHome(); openSetSheet(lang, setId, S.catFilter); };
  $('#sFilter').onclick = e => { const b = e.target.closest('button'); if (b) openSetSheet(lang, setId, b.dataset.f); };
  $('#sOpenColl').onclick = () => { closeSheet(); go('coll'); collTab('list'); $('#fLang').value = lang; fillSetFilter(); $('#fSet').value = lang + '|' + setId; renderColl(); };
  $('#catGrid').onclick = async e => {
    const el = e.target.closest('.ctile'); if (!el) return;
    if (el.dataset.uid) return openDetail(el.dataset.uid);
    const c = items.find(x => x.id === el.dataset.cid);
    toast(`${c.localId} ${c.name} · …`);
    try {
      const full = await getCard(lang === 'JP' ? 'ja' : 'en', c.id);
      const pr = choosePriceOf(full, S.pref);
      toast(`${c.localId} ${c.name} · ${full.rarity || '–'} · ${pr ? fmtCur(pr.value, pr.currency) + (rate(pr.currency) ? ' ≈ ' + fmtHuf(pr.value * rate(pr.currency)) : '') + ' (tájékoztató)' : 'nincs ár'}`, 4500);
    } catch { /* offline */ }
  };
}

// ---------- Készletem: összérték, szett-rács logókkal, top 10 ----------
function collTab(name) {
  S.collTab = name;
  $$('#collTabs button').forEach(b => b.classList.toggle('on', b.dataset.ct === name));
  $('#ctSets').hidden = name !== 'sets'; $('#ctTop').hidden = name !== 'top'; $('#ctList').hidden = name !== 'list';
}
$('#collTabs').onclick = e => { const b = e.target.closest('button'); if (b) { collTab(b.dataset.ct); renderColl(); } };
$('#setSort').onchange = e => { S.setSort = e.target.value; saveSettings(); renderColl(); };
const logoUrl = new Map(); // 'EN|me06' → URL | null (null: egyik forrás sem ad logót)
function ownedSetsSummary() {
  const m = new Map();
  for (const c of CARDS) {
    const k = c.lang + '|' + c.setId;
    const e = m.get(k) || { lang: c.lang, setId: c.setId, name: setTitle(c, true), list: [], last: '' };
    e.list.push(c); if ((c.lastScannedAt || '') > e.last) e.last = c.lastScannedAt || '';
    m.set(k, e);
  }
  return [...m.values()].map(e => ({ ...e, t: totals(e.list), p: progressOf(e.lang, e.setId) }));
}
function setTileHtml(e) {
  const k = e.lang + '|' + e.setId, u = logoUrl.get(k);
  const logo = u ? `<img loading="lazy" src="${esc(u)}" alt="${esc(e.name)}">` : `<span class="stext">${esc(e.name)}</span>`;
  const p = e.p;
  return `<div class="stile" data-fset="${esc(k)}"><div class="slogo">${logo}</div>
    <div class="sinfo"><span class="lang ${e.lang === 'JP' ? 'jp' : 'en'}">${e.lang}</span>${u ? ` <b>${esc(e.name)}</b>` : ''}</div>
    ${p ? `<div class="pbar"><i style="width:${(p.pct * 100).toFixed(1)}%"></i></div><small>${p.have} / ${p.of} megvan</small>` : '<small>komplettség betöltése…</small>'}
    <div class="sval">${e.t.noPrice === e.t.cards ? '<span class="noprice">nincs ár</span>' : fmtHuf(e.t.sum)}</div></div>`;
}
function renderCollTop() {
  const t = totals();
  $('#cTotal').textContent = fmtHuf(t.sum);
  $('#cTotalSub').innerHTML = `${t.cards} lap · ${t.unique} különböző${t.noPrice ? ` · <span class="noprice">${t.noPrice} lap ár nélkül (nem számít bele)</span>` : ''}`;
  collTab(S.collTab || 'sets');
  $('#setSort').value = S.setSort || 'value';
  const sets = ownedSetsSummary();
  ensureSetData(sets.map(e => [e.lang, e.setId]));
  const so = S.setSort || 'value';
  sets.sort(so === 'name' ? (a, b) => a.name.localeCompare(b.name) : so === 'recent' ? (a, b) => b.last.localeCompare(a.last) : so === 'comp' ? (a, b) => (b.p?.pct || 0) - (a.p?.pct || 0) : (a, b) => b.t.sum - a.t.sum);
  $('#setGrid').innerHTML = sets.length ? sets.map(setTileHtml).join('') : '<div class="empty">Még nincs lap a készletben. Szkennelj be egyet!</div>';
  for (const e of sets) {
    const k = e.lang + '|' + e.setId, d = setData.get(k);
    if (d && !logoUrl.has(k)) {
      logoUrl.set(k, null);
      setLogo(e.lang, d).then(u => { if (!u) { if (e.lang === 'EN') setTimeout(() => logoUrl.delete(k), 60e3); return; } logoUrl.set(k, u); const el = document.querySelector(`.stile[data-fset="${CSS.escape(k)}"] .slogo`); if (el) { el.innerHTML = `<img loading="lazy" src="${esc(u)}" alt="${esc(e.name)}">`; const info = el.parentNode.querySelector('.sinfo'); if (info && !info.querySelector('b')) info.insertAdjacentHTML('beforeend', ` <b>${esc(e.name)}</b>`); } });
    }
  }
  const top = topCards(CARDS, hufOf, 10);
  $('#topList').innerHTML = top.length ? top.map((c, i) => `<div class="item top" data-uid="${c.uid}"><span class="rank">${i + 1}</span>${cardImg(c)}
    <div class="mid"><b>${esc(c.name)}</b><small>${c.lang === 'JP' ? '🇯🇵' : '🇬🇧'} ${esc(setTitle(c, true))} · ${esc(c.number)}</small>
      <small><span class="cond" title="${esc((CONDS.find(x => x[0] === (c.condition || 'NM')) || [])[1] || '')}">${esc(c.condition || 'NM')}</span>${c.variant && c.variant !== 'normal' ? ` <span class="cond">${esc(VARS[c.variant])}</span>` : ''} ${c.qty > 1 ? `<span class="qty">${c.qty} db</span>` : '1 db'}</small></div>
    <div class="val"><b>${fmtHuf(hufOf(c) * c.qty)}</b><small class="unit">${fmtHuf(hufOf(c))}/db</small><small>${fmtCur(c.price, c.priceCurrency)}/db</small></div></div>`).join('') : '<div class="empty">Nincs áras lap.</div>';
}

// ---------- készlet ----------
function fillSetFilter() {
  const cur = $('#fSet').value, l = $('#fLang').value;
  const m = new Map();
  CARDS.filter(c => !l || c.lang === l).forEach(c => m.set(c.lang + '|' + c.setId, (c.lang === 'JP' ? '🇯🇵 ' : '🇬🇧 ') + setTitle(c)));
  $('#fSet').innerHTML = '<option value="">Minden szett</option>' + [...m].sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  if (m.has(cur)) $('#fSet').value = cur;
  const ccur = $('#fCat').value;
  const cs = [...new Set(CARDS.map(c => c.category).filter(Boolean))].sort();
  $('#fCat').innerHTML = '<option value="">Minden típus</option>' + cs.map(c => `<option value="${esc(c)}">${esc(CATS[c] || c)}</option>`).join('');
  if (cs.includes(ccur)) $('#fCat').value = ccur;
  const rcur = $('#fRarity').value;
  const rs = [...new Set(CARDS.map(c => c.rarity).filter(Boolean))].sort();
  $('#fRarity').innerHTML = '<option value="">Minden ritkaság</option>' + rs.map(r => `<option>${esc(r)}</option>`).join('');
  if (rs.includes(rcur)) $('#fRarity').value = rcur;
}
function renderColl() {
  renderCollTop();
  fillSetFilter();
  const q = $('#fText').value.trim().toLowerCase(), l = $('#fLang').value, s = $('#fSet').value, r = $('#fRarity').value, so = $('#fSort').value, cat = $('#fCat').value;
  let list = CARDS.filter(c => (!l || c.lang === l) && (!s || c.lang + '|' + c.setId === s) && (!r || c.rarity === r) && (!cat || c.category === cat) &&
    (!q || [c.name, c.setName, setTitle(c), c.setCode, c.number, c.number + '/' + c.printedTotal].join(' ').toLowerCase().includes(q)));
  const v = c => hufOf(c) ?? -1;
  const sorts = {
    value: (a, b) => v(b) * b.qty - v(a) * a.qty, price: (a, b) => v(b) - v(a), name: (a, b) => a.name.localeCompare(b.name),
    date: (a, b) => (b.lastScannedAt || '').localeCompare(a.lastScannedAt || ''),
    number: (a, b) => a.setName.localeCompare(b.setName) || parseInt(a.number.replace(/\D/g, '')) - parseInt(b.number.replace(/\D/g, '')),
  };
  list.sort(sorts[so]);
  const t = totals(list);
  if (s) {
    const [sl, sid] = s.split('|');
    ensureSetData([[sl, sid]]);
    const p = progressOf(sl, sid);
    $('#collProg').innerHTML = p ? `<div class="collprog"><div class="pbar"><i style="width:${(p.pct * 100).toFixed(1)}%"></i></div><small>${progText(p)}</small><button class="btn small" id="collMissing">Hiányzó lapok</button></div>` : '<div class="collprog"><small>komplettség betöltése…</small></div>';
    $('#collMissing')?.addEventListener('click', () => openSetSheet(sl, sid, 'missing'));
  } else $('#collProg').innerHTML = '';
  $('#collSum').innerHTML = `${t.unique} tétel · ${t.cards} lap · <b style="color:var(--gold)">${fmtHuf(t.sum)}</b>${t.noPrice ? ` · <span class="noprice">${t.noPrice} lap ár nélkül</span>` : ''}`;
  $('#collList').innerHTML = list.length ? list.map(itemRow).join('') : '<div class="empty">Nincs a szűrésnek megfelelő lap.</div>';
}
['#fText', '#fLang', '#fSet', '#fRarity', '#fCat', '#fSort'].forEach(id => $(id).addEventListener('input', renderColl));

// ---------- részletek ----------
function openSheet(html) { $('#sheetContent').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheetContent').innerHTML = ''; }
function packHtml(c) {
  const p = packInfo(c);
  return `<h2>Melyik csomagban van? ${p.featured ? '<span class="badge">kiemelt szett</span>' : ''}</h2>
    <div class="hint" style="margin-bottom:8px">Szett: <b style="color:var(--tx)">${esc(p.setLabel)}</b> (${esc(c.setCode || c.setId)})</div>
    ${p.notes.map(n => `<p class="hint">• ${esc(n)}</p>`).join('')}
    ${p.products.map(x => `<div class="pack">${x.i ? `<img loading="lazy" src="${esc(x.i)}" alt="">` : ''}<div><b>${esc(x.t)}</b><small>${esc(x.k)}${x.p ? ` · ${x.p} booster pakk` : ''}${x.c ? ` · ${x.c} lap/pakk` : ''}</small></div></div>`).join('')}
    ${p.fixedDecks.length ? `<p class="hint">Fix tartalmú (nem véletlen lapos) termék: ${p.fixedDecks.map(x => esc(x.t)).join(', ')}</p>` : ''}
    ${p.products.length ? '<p class="hint">A lista a bolt termékadataiból származik; a lap véletlenszerűen, a szett booster pakkjaiban fordul elő.</p>' : ''}`;
}
async function openDetail(uid) {
  const c = await Store.get(uid); if (!c) return;
  const h = hufOf(c);
  const other = Object.entries(c.prices || {}).map(([k, p]) => `<span>${k === 'cardmarket' ? 'Cardmarket' : 'TCGplayer'}</span><span>${fmtCur(p.value, p.currency)} ${esc(p.label)}${p.low ? ` · min ${fmtCur(p.low, p.currency)}` : ''}${rate(p.currency) ? ' ≈ ' + fmtHuf(p.value * rate(p.currency)) : ''}</span>`).join('');
  const vopts = Object.entries(VARS).filter(([k]) => k === 'normal' || (k === 'holo' && c.variants?.holo) || (k === 'reverse' && c.variants?.reverse) || c.variant === k);
  openSheet(`<div class="det-top">${c.image || c.photo ? `<img src="${esc(c.image || c.photo)}" alt="">` : `<div class="noimg">${esc(c.name)}</div>`}
    <div><h3>${esc(c.name)}</h3><div class="hint">${c.lang === 'JP' ? '🇯🇵 Japán' : '🇬🇧 Angol'} · ${esc(setTitle(c))}</div>
      <div class="price-big">${h == null ? '<span class="noprice">nincs ár</span>' : fmtHuf(h)}</div>
      <div class="hint">${c.price != null ? fmtCur(c.price, c.priceCurrency) + ' · ' + esc(c.priceSource) : 'Egyik forrásnak sincs ára erre a lapra/változatra.'}</div>
      ${h != null && c.qty > 1 ? `<div class="hint">Összesen ${c.qty} db: <b style="color:var(--gold)">${fmtHuf(h * c.qty)}</b></div>` : ''}
    </div></div>
    <div class="qtybox"><button data-q="-1">−</button><b id="dQty">${c.qty}</b><button data-q="1">+</button><span class="hint">darab</span></div>
    <div class="row"><label class="fld grow">Állapot<select id="dCond">${CONDS.map(([k, v]) => `<option value="${k}" ${c.condition === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="fld grow">Változat<select id="dVar">${vopts.map(([k, v]) => `<option value="${k}" ${c.variant === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
    <p class="hint">Az ár mindig a piaci (Near Mint) ár – állapot szerinti levonást nem számolunk bele.</p>
    <div class="kv">
      <span>Szettkód</span><span>${esc(c.setCode || '')} (${esc(c.setId)})</span>
      <span>Gyűjtői szám</span><span>${esc(c.number)}${c.printedTotal ? '/' + c.printedTotal : ''}</span>
      <span>Ritkaság</span><span>${esc(c.rarity || '–')}</span>
      ${c.illustrator ? `<span>Illusztrátor</span><span>${esc(c.illustrator)}</span>` : ''}
      ${other}
      <span>Ár frissítve</span><span>${fmtDate(c.priceUpdatedAt)}${c.priceSourceUpdated ? ' (forrás: ' + fmtDate(c.priceSourceUpdated) + ')' : ''}</span>
      <span>Szkennelve</span><span>${fmtDate(c.scannedAt)}</span>
      <span>Azonosító</span><span>${esc(c.apiId)}</span>
    </div>
    <button class="btn big" id="dRefresh">↻ Ár frissítése</button>
    <h2>Árváltozás</h2>
    <div id="pChart" class="pchart-box"><div class="hint">Árelőzmény betöltése…</div></div>
    ${packHtml(c)}
    ${c.photo ? `<h2>Szkennelt fotó</h2><img src="${c.photo}" style="width:120px;border-radius:8px">` : ''}
    <h2>&nbsp;</h2><button class="btn danger" id="dDel">Tétel törlése</button>`);
  const body = $('#sheetContent');
  body.querySelectorAll('[data-q]').forEach(b => b.onclick = async () => {
    c.qty = Math.max(0, c.qty + +b.dataset.q);
    if (c.qty === 0) { if (confirm('Törlöd a tételt a készletből?')) { await Store.remove(c.uid); closeSheet(); toast('Törölve'); return; } c.qty = 1; }
    await Store.put(c); $('#dQty').textContent = c.qty;
  });
  const reKey = async () => {
    // ha az új kulcs már létezik (ugyanaz a lap ilyen állapotban/változatban), összevonjuk
    const ex = await Store.findByKey(itemKey(c));
    if (ex && ex.uid !== c.uid) { ex.qty += c.qty; await Store.put(ex); await Store.remove(c.uid); closeSheet(); toast('Összevonva a meglévő tétellel'); openDetail(ex.uid); return; }
    await Store.put(c); openDetail(c.uid);
  };
  $('#dCond').onchange = e => { c.condition = e.target.value; reKey(); };
  $('#dVar').onchange = e => { c.variant = e.target.value; repriceRecord(c, S.pref); reKey(); };
  renderPriceChart(c);
  $('#dDel').onclick = async () => { if (confirm(`Törlöd: ${c.name} (${c.qty} db)?`)) { await Store.remove(c.uid); closeSheet(); toast('Törölve'); } };
  $('#dRefresh').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Frissítés…';
    try { await refreshOne(c); toast('Ár frissítve'); openDetail(c.uid); } catch (err) { toast('Hiba: ' + err.message); e.target.disabled = false; }
  };
}

// ---------- árgrafikon ----------
async function renderPriceChart(c, opt = {}) {
  const box = $('#pChart'); if (!box) return;
  const pts = (await Store.historyFor(c.apiId).catch(() => [])).filter(p => (p.variant || 'normal') === (c.variant || 'normal'));
  const refs = referenceLines(c.pricingRaw, c.variant);
  const curs = [...new Set(pts.map(p => p.currency).concat(refs.map(r => r.currency)))].filter(x => x === 'EUR' || x === 'USD');
  if (!pts.length && !refs.length) { box.innerHTML = '<div class="hint">Ehhez a laphoz egyik forrás sem ad árat – nincs mit ábrázolni.</div>'; return; }
  const st = renderPriceChart.st ||= { days: 30, unit: null };
  Object.assign(st, opt);
  if (!st.unit || (st.unit !== 'HUF' && !curs.includes(st.unit))) st.unit = curs[0] || 'HUF';
  const days = { 7: 7, 30: 30, 90: 90, 0: 0 }[st.days] ?? 30;
  const svg = chartSvg(pts, refs, { days, unit: st.unit, rateNow: { EUR: S.eurHuf, USD: S.usdHuf } });
  const dates = [...new Set(pts.map(p => p.date))];
  const srcs = [...new Set(pts.map(p => p.source))];
  box.innerHTML = `<div class="seg small" id="pcDays">${[[7, '7 nap'], [30, '30 nap'], [90, '90 nap'], [0, 'Összes']].map(([d, l]) => `<button data-d="${d}" class="${st.days == d ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="seg small" id="pcUnit">${curs.concat(['HUF']).map(u => `<button data-u="${u}" class="${st.unit === u ? 'on' : ''}">${u === 'EUR' ? '€ EUR' : u === 'USD' ? '$ USD' : 'Ft HUF'}</button>`).join('')}</div>
    ${svg || '<div class="hint">Ebben a pénznemben / időszakban nincs adat.</div>'}
    <div class="legend">${srcs.map(sr => `<span><i style="background:${sr === 'tcgplayer' ? '#6ec6ff' : '#f5c518'}"></i>${SRC[sr] || sr} (saját előzmény)</span>`).join('')}${refs.length ? '<span><i class="dash"></i>Cardmarket átlagok (referencia, nem napi ár)</span>' : ''}</div>
    <p class="hint">${dates.length <= 1 ? '⏳ Még gyűlik az árelőzmény – minden árfrissítéskor (szkennelés, „Ár frissítése”, napi első megnyitás) új pont kerül be, forrásonként naponta legfeljebb egy. Addig a Cardmarket 1 / 7 / 30 napos átlaga és trendje látszik referenciaként.' : `${dates.length} nap saját árelőzménye (${dates[0]} – ${dates[dates.length - 1]}).`} A szaggatott vonalak a forrás által számolt átlagok, nem napi árak.${st.unit === 'HUF' ? ' HUF-ban a saját pontok a rögzítéskori, az átlagok a mai árfolyammal vannak átszámolva.' : ''}</p>`;
  $('#pcDays').onclick = e => { const b = e.target.closest('button'); if (b) renderPriceChart(c, { days: +b.dataset.d }); };
  $('#pcUnit').onclick = e => { const b = e.target.closest('button'); if (b) renderPriceChart(c, { unit: b.dataset.u }); };
}

// ---------- árfrissítés ----------
async function refreshOne(c) {
  const r = await cardRecord(c.lang, c.apiId, { variant: c.variant, fresh: true, pref: S.pref });
  for (const k of ['prices', 'pricingRaw', 'pricingVia', 'price', 'priceCurrency', 'priceSource', 'priceUpdatedAt', 'priceSourceUpdated', 'rarity', 'printedTotal', 'category']) c[k] = r[k];
  if (!c.image && r.image) { c.image = r.image; c.imageSmall = r.imageSmall; }
  await Store.put(c);
  await recordPrices(c, S).catch(() => {});
}
let refreshing = false;
async function refreshAll() {
  if (refreshing) return; refreshing = true;
  const btns = [$('#btnRefresh'), $('#btnRefreshHome')]; btns.forEach(b => b.disabled = true);
  try {
    if (!S.fxManual) await loadFx(true).catch(() => {});
    const list = [...CARDS]; let done = 0, fail = 0;
    const work = async () => { while (list.length) { const c = list.shift(); try { await refreshOne(c); } catch { fail++; } done++; btns.forEach(b => b.textContent = `Frissítés… ${done}/${CARDS.length}`); } };
    await Promise.all([work(), work(), work(), work()]);
    S.lastRefresh = new Date().toISOString(); await saveSettings();
    toast(`Árak frissítve (${done - fail}/${done})${fail ? ' – ' + fail + ' hiba' : ''}`);
  } finally { refreshing = false; btns.forEach(b => b.disabled = false); $('#btnRefresh').textContent = '↻ Minden ár frissítése'; $('#btnRefreshHome').textContent = '↻ Árak frissítése'; await reload(); }
}
$('#btnRefresh').onclick = refreshAll;
async function runIndex(btn, pairs, label) {
  btn.disabled = true;
  try { const n = await buildIndex(pairs, t => btn.textContent = '🖼 ' + t); toast(`Képi index kész: ${n} lap (${pairs.length} szett)`); }
  catch (err) { toast('Hiba: ' + err.message); }
  btn.disabled = false; btn.textContent = label;
}
$('#btnIndexOwned').onclick = e => { const pairs = ownedSetPairs.all(); if (!pairs.length) return toast('A készlet üres'); runIndex(e.currentTarget, pairs, '🖼 Index a készletben szereplő szettekhez'); };
$('#btnIndexOne').onclick = e => { const v = $('#ixSet').value; if (!v) return; runIndex(e.currentTarget, [[$('#ixLang').value, v]], '🖼 Index ehhez a szetthez'); };
async function fillIxSets() { const sets = (await getSets($('#ixLang').value).catch(() => [])).slice().reverse(); $('#ixSet').innerHTML = sets.map(x => `<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.id)})</option>`).join(''); }
$('#ixLang').onchange = fillIxSets;
document.querySelector('.tabs [data-go=set]').addEventListener('click', () => { if (!$('#ixSet').options.length) fillIxSets(); });
$('#btnIndex').onclick = async e => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const n = await buildIndex(FEATURED.map(f => [f.lang === 'JP' ? 'ja' : 'en', f.setId]), t => b.textContent = '🖼 ' + t);
    toast(`Képi index kész: ${n} lap`);
  } catch (err) { toast('Hiba: ' + err.message); }
  b.disabled = false; b.textContent = '🖼 Képi index letöltése (kiemelt szettek)';
};
$('#btnRefreshHome').onclick = refreshAll;

// ---------- árfolyam ----------
async function loadFx(force = false) {
  if (S.fxManual) return;
  const fresh = S.fx && Date.now() - new Date(S.fx.fetchedAt).getTime() < 6 * 3600e3;
  if (fresh && !force) return;
  const fx = await fetchFx();
  S.fx = fx; S.eurHuf = fx.eurHuf; S.usdHuf = fx.usdHuf;
  await saveSettings(); renderSettings(); renderHome();
}
function renderSettings() {
  $('#fxManual').checked = S.fxManual;
  $('#fxEur').value = S.eurHuf ? S.eurHuf.toFixed(2) : '';
  $('#fxUsd').value = S.usdHuf ? S.usdHuf.toFixed(2) : '';
  $('#fxEur').disabled = $('#fxUsd').disabled = !S.fxManual;
  $('#fxInfo').textContent = S.fxManual ? 'Kézi árfolyam van érvényben.' : S.fx ? `Élő árfolyam: ${S.fx.source}, ${S.fx.date} (lekérve ${fmtDate(S.fx.fetchedAt)})` : 'Élő árfolyam még nincs lekérve.';
  $$('#prefSeg button').forEach(b => b.classList.toggle('on', b.dataset.pref === S.pref));
}
$('#fxManual').onchange = async e => { S.fxManual = e.target.checked; await saveSettings(); renderSettings(); if (!S.fxManual) loadFx(true).catch(err => toast('Árfolyam hiba: ' + err.message)); };
$('#btnFx').onclick = async () => { S.fxManual = false; try { await loadFx(true); toast('Árfolyam frissítve'); } catch (e) { toast('Nem sikerült: ' + e.message); } };
$('#btnFxSave').onclick = async () => {
  const e = parseFloat($('#fxEur').value), u = parseFloat($('#fxUsd').value);
  if (!(e > 0 && u > 0)) return toast('Adj meg érvényes árfolyamot');
  S.fxManual = true; S.eurHuf = e; S.usdHuf = u; await saveSettings(); renderSettings(); renderHome(); toast('Kézi árfolyam mentve');
};
$('#prefSeg').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  S.pref = b.dataset.pref; await saveSettings(); renderSettings();
  const all = await Store.all(); all.forEach(c => repriceRecord(c, S.pref)); await Store.putMany(all);
  toast('Árforrás: ' + b.textContent);
};

// ---------- fotózós szkenner (kamera): állandó vezetőkeret → kioldás → feldolgozás → eredményoldal ----------
let idxCountP = null;
function indexCount() {
  return idxCountP || (idxCountP = (async () => {
    let n = 0; const seen = new Set();
    for (const [l, id] of [...FEATURED.map(f => [f.lang === 'JP' ? 'ja' : 'en', f.setId]), ...ownedSetPairs()]) {
      const k = l + '|' + id; if (seen.has(k)) continue; seen.add(k);
      try { n += (await getIndex(l, id, null, { cachedOnly: true })).length; } catch {}
    }
    return n || null;
  })());
}
const live = new SnapScanner({
  video: $('#video'), overlay: $('#overlay'),
  recognizeFrame: (canvas, opt) => recognizeFrame(canvas, opt),
  onDecision: dec => onLiveDecision(dec),
  onFail: (best, info) => onLiveFail(best, info),
  onStatus: (t, kind) => liveStatus(t, kind),
  onState: s => { $('#live').dataset.state = s; },
  onProcessing: (t, sub) => procShow(t, sub),
  indexCount,
});
function liveStatus(t) { const el = $('#liveStatus'); el.innerHTML = t ? `<span>${esc(t)}</span>` : ''; }
// feldolgozás közben a kép elsötétül, a lépés neve látszik
function procShow(t, sub = '') {
  const el = $('#proc');
  if (!t) { el.hidden = true; return; }
  el.hidden = false; $('#procTitle').textContent = t; $('#procSub').textContent = sub || '';
  $('#failBox').hidden = true;
}
let lastFail = null;
function onLiveFail(best, info) {
  lastFail = best && best.cands?.length ? best : null;
  const fb = $('#failBox');
  fb.innerHTML = `<div class="fb-t">${info?.timeout ? 'A felismerés túl sokáig tartott.' : 'Nem ismertem fel a lapot.'}</div><div class="fb-s">Tartsd laposan, a keretben, csillogás nélkül (a tok fényfoltja ront rajta).</div>
    <div class="live-actions"><button class="btn small" id="fbRetry">↻ Újra</button><button class="btn small" id="fbManual">🔎 Kézi keresés</button>${lastFail ? '<button class="btn small" id="fbTips">Tippek</button>' : ''}<button class="btn small" id="fbClose">✕</button></div>`;
  fb.hidden = false;
  $('#fbRetry').onclick = () => { fb.hidden = true; live.shutter(); };
  $('#fbManual').onclick = () => { fb.hidden = true; openManual(lastFail?.r?.name || '', lastFail?.r?.number || ''); };
  $('#fbTips')?.addEventListener('click', () => { fb.hidden = true; showResultCard(lastFail, { unsure: true }); });
  $('#fbClose').onclick = () => { fb.hidden = true; };
}
async function onLiveDecision(dec) {
  try { navigator.vibrate?.(60); } catch {}
  $('#failBox').hidden = true;
  showResultCard(dec, { unsure: !dec.sure || dec.weak });   // sosem adja hozzá magától: az „+ Hozzáadás” gomb a felhasználóé
}
async function startLive({ stream } = {}) {
  const msg = $('#camMsg');
  try {
    await live.start({ stream });
    msg.hidden = true;
  } catch (e) {
    msg.hidden = false;
    $('#camMsgText').textContent = CAMERA_HELP[e.name] || ('Nem érhető el a kamera (' + (e.name || e.message) + '). Használd a „Fotó” gombot.');
  }
}
function stopLive() { live.stop(); hideResultCard(); procShow(null); $('#failBox').hidden = true; }
$('#btnCamStart').onclick = () => startLive();
$('#shutter').onclick = () => { $('#failBox').hidden = true; live.shutter(); };
$('#zoomPill').onclick = () => { const z = live.cycleZoom(); $('#zoomPill').textContent = (z === 1.5 ? '1,5' : z) + '×'; };

// ---------- felismerés egy (kivágott vagy feltöltött) képen ----------
$('#langSeg').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  S.scanLang = b.dataset.lang; jaSetIds = null; $$('#langSeg button').forEach(x => x.classList.toggle('on', x === b)); saveSettings();
};
let jaSetIds = null, totalsSet = null;
const recentSets = [];
// a készletben szereplő szettek, a legutóbb szkenneltek elöl
const ownedSetPairs = () => {
  const m = new Map();
  [...CARDS].sort((a, b) => (b.lastScannedAt || '').localeCompare(a.lastScannedAt || '')).forEach(c => { const k = (c.lang === 'JP' ? 'ja' : 'en') + '|' + c.setId; if (!m.has(k)) m.set(k, [c.lang === 'JP' ? 'ja' : 'en', c.setId]); });
  return [...m.values()].slice(0, 6);
};
ownedSetPairs.all = () => { const m = new Map(); CARDS.forEach(c => m.set(c.lang + '|' + c.setId, [c.lang === 'JP' ? 'ja' : 'en', c.setId])); return [...m.values()]; };
const status = () => {};
let busy = false, lastAdded = null;
const sessionList = [];
async function ensureSetMeta() {
  if (jaSetIds) return;
  const [ja, en] = await Promise.all([getSets('ja').catch(() => []), getSets('en').catch(() => [])]);
  jaSetIds = ja.map(s => s.id);
  const pick = S.scanLang === 'ja' ? ja : S.scanLang === 'en' ? en : ja.concat(en);
  totalsSet = new Set(pick.map(s => +s.cardCount?.official).filter(n => n > 0));
}
// gyors út (élő szkenner): kevesebb számolvasás, japán név nélkül, csak már letöltött képi indexek; részletes: minden
async function recognizeFrame(canvas, { fast = true, skipNumber = false } = {}) {
  await ensureSetMeta();
  const r = await recognize(canvas, { lang: S.scanLang, jaSetIds, totals: totalsSet, rect: { x: 0, y: 0, w: canvas.width, h: canvas.height }, fast, skipNumber });
  // gyors úton a japán név csak egy kivágással (és csak ha az angol név nem értelmes – ezt az identify dönti el)
  const id = await identify(r, { lang: S.scanLang, recentSets, ownedSets: ownedSetPairs(), fast, allowJaName: fast ? 'one' : true });
  return { r, ...id };
}
// kártya-négyszög keresése egy képen (fő szálon) és perspektíva-korrekció; null, ha nincs kártya-alakzat
function warpFromCanvas(src) {
  const sw = src.width, sh = src.height, sc = 480 / Math.max(sw, sh);
  const w = Math.round(sw * sc), h = Math.round(sh * sc);
  const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
  const g = sm.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h);
  const det = detectQuad(g.getImageData(0, 0, w, h).data, w, h);
  if (!det) return null;
  const full = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = warpPerspective(full, sw, sh, det.quad.map(p => ({ x: p.x * sw, y: p.y * sh })), CW, CH);
  const c = document.createElement('canvas'); c.width = CW; c.height = CH;
  c.getContext('2d').putImageData(new ImageData(out, CW, CH), 0, 0);
  return c;
}
// feltöltött fotó / teszt: egy kép, részletes úttal
async function scanSource(src) {
  if (busy) return; busy = true;
  try {
    await ensureSetMeta();
    const warped = warpFromCanvas(src);
    const r = await recognize(warped || src, { lang: S.scanLang, jaSetIds, totals: totalsSet, rect: warped ? { x: 0, y: 0, w: CW, h: CH } : undefined });
    const id = await identify(r, { lang: S.scanLang, recentSets, ownedSets: ownedSetPairs() });
    const dec = { r, ...id };
    if (!id.cands.length) { lastCands = []; lastScan = r; toast((!r.number && !r.name) ? 'Nem sikerült kiolvasni a lapot, képi egyezés sem volt. Próbáld élesebben, vagy keress kézzel.' : 'Nincs találat. Próbáld újra vagy keress kézzel.', 4000); return; }
    if (S.fastMode && id.sure) { await addCandidate(id.best, r); showResultCard(dec, { added: true, undoMs: 2000 }); }
    else showResultCard(dec);
  } catch (e) {
    console.error(e); toast('Hiba: ' + e.message, 4000);
  } finally { busy = false; }
}
function candHtml(c, i, best) {
  const src = c.image ? c.image + '/low.webp' : c.imgUrl;
  const img = src ? `<img loading="lazy" src="${esc(src)}" alt="">` : `<div class="noimg">${esc(c.name)}<br>${esc(c.setId)} ${esc(c.localId)}</div>`;
  return `<div class="cand ${best ? 'best' : ''}" data-ci="${i}">${img}<b>${c.lang === 'ja' ? '🇯🇵' : '🇬🇧'} ${esc(c.name)}</b><small>${esc(c.setName)}</small><small>${esc(c.localId)}${c.official ? '/' + c.official : ''}</small></div>`;
}

// ---------- eredményoldal (teljes képernyő): kép, adatok, állapot, árak, alternatívák, „+ Hozzáadás”, „Új szkennelés” ----------
let lastCands = [], lastScan = null, rcDec = null, rcState = null;
function hideResultCard() { $('#resultPage').hidden = true; document.body.classList.remove('rp-open'); rcDec = null; rcState = null; }
// vissza a kamerához: azonnal újra figyel (nem kell üres kép); a keretben maradt lapot csak változás után olvassa újra magától
function finishCard() { hideResultCard(); if (live.state !== 'off') live.newScan(); }
const priceBoxes = rec => {
  const P = rec.prices || {}, boxes = [];
  const add = (label, p) => { if (!p) return; const h = p.value * (rate(p.currency) ?? NaN); boxes.push(`<div class="pbox"><small>${label}</small><b>${Number.isFinite(h) ? fmtHuf(h) : '–'}</b><span>${fmtCur(p.value, p.currency)}</span></div>`); };
  add('Cardmarket · ' + (P.cardmarket?.label || 'trend'), P.cardmarket);
  if (P.cardmarket?.low) add('Cardmarket · legolcsóbb', { value: P.cardmarket.low, currency: P.cardmarket.currency });
  add('TCGplayer · ' + (P.tcgplayer?.label || ''), P.tcgplayer);
  return boxes.length ? boxes.join('') : '<div class="pbox none"><small>Ár</small><b>nincs ár</b><span>ehhez a laphoz most nincs adat</span></div>';
};
function showResultCard(dec, { added = false, undoMs = 0, unsure = false } = {}) {
  const { r, cands } = dec;
  lastCands = cands; lastScan = r; rcDec = dec; live.pause();
  rcState = { cur: dec.best, added: false, cond: 'NM' };
  const st = rcState;
  const render = () => {
    if (rcState !== st) return;
    const best = st.cur;
    const own = CARDS.filter(c => c.apiId === best.id).reduce((a, c) => a + (c.qty || 0), 0);
    const img = best.image ? best.image + '/high.webp' : (best.imgUrl || (r.card ? thumb(r.card, 360) : ''));
    const alts = cands.slice(0, 8);
    $('#scanResult').innerHTML = `
      <div class="rp-hero">${img ? `<img id="rcImg" src="${esc(img)}" alt="${esc(best.name)}">` : '<div class="noimg big"></div>'}</div>
      <div class="rp-name">${esc(best.name)}</div>
      <div class="rp-set"><span class="lang ${best.lang === 'ja' ? 'jp' : 'en'}">${best.lang === 'ja' ? 'JP' : 'EN'}</span> ${esc(best.setName)} • ${esc(best.localId)}${best.official ? '/' + best.official : ''}</div>
      ${unsure && best === dec.best ? '<div class="rc-warn">Nem biztos a felismerés – ellenőrizd, vagy válassz az alternatívák közül!</div>' : ''}
      <div class="rp-row"><label class="fld">Állapot<select id="rpCond">${CONDS.map(([k, v]) => `<option value="${k}" ${st.cond === k ? 'selected' : ''}>${k} – ${v}</option>`).join('')}</select></label>
        <div class="tags" id="rcRar"><span class="tag">…</span></div></div>
      ${own ? `<div class="rc-own">Már megvan: ${own} db</div>` : ''}
      <div class="pboxes" id="rcPrice"><div class="pbox none"><small>Ár</small><b>…</b></div></div>
      <div class="rp-alt-t">Nem ez a lap? Alternatívák lent</div>
      <div class="rp-alts">${alts.map((c, i) => { const src = c.image ? c.image + '/low.webp' : c.imgUrl; return `<button type="button" class="alt ${c === best ? 'sel' : ''}" data-ci="${i}">${src ? `<img loading="lazy" src="${esc(src)}" alt="">` : `<div class="noimg">${esc(c.name)}</div>`}<b>${c.lang === 'ja' ? '🇯🇵' : '🇬🇧'} ${esc(c.name)}</b><small>${esc(c.setName)} · ${esc(c.localId)}${c.official ? '/' + c.official : ''}</small></button>`; }).join('')}
        <button type="button" class="alt manual" id="rcManual"><span>🔎</span><b>Kézi keresés</b></button></div>`;
    const bar = $('#rpBar');
    bar.innerHTML = st.added
      ? `<button class="btn big green done" id="rcAdd" disabled>Hozzáadva ✓</button><button class="btn big white" id="rcNew">Új szkennelés</button>`
      : `<button class="btn big green" id="rcAdd">＋ Hozzáadás a gyűjteményhez</button><button class="btn big white" id="rcNew">Új szkennelés</button>`;
    const note = $('#rpAdded'); note.hidden = !st.added; if (st.added) { note.innerHTML = `✓ Lap hozzáadva a gyűjteményhez${added || st.undoable ? ' · <button type="button" id="rcUndo">visszavonás</button>' : ''}`; }
    $('#rpCond').onchange = e => { st.cond = e.target.value; };
    $('#rcNew').onclick = () => finishCard();
    $('#rcUndo')?.addEventListener('click', async () => { await undoLast(); st.added = false; st.undoable = false; render(); });
    $('#rcAdd').onclick = async e => {
      if (st.added) return;
      e.currentTarget.disabled = true;
      // hiba / lassú hálózat esetén se ragadjon be: a gomb újra megnyomható
      try { await Promise.race([addCandidate(st.cur, r, st.cond), new Promise((_, rej) => setTimeout(() => rej(new Error('időtúllépés')), 25000))]); }
      catch (err) { console.error(err); toast('Nem sikerült hozzáadni (' + (err.message || err) + '). Próbáld újra.'); const b = $('#rcAdd'); if (b) b.disabled = false; return; }
      st.added = true; st.undoable = true; idxCountP = null; render();
    };
    $('#rcManual').onclick = () => { finishCard(); openManual(r.name, r.number); };
    $('#scanResult').querySelectorAll('[data-ci]').forEach(el => el.onclick = () => { if (st.added) return; st.cur = alts[+el.dataset.ci]; render(); });
    // ár, ritkaság (API) – árat nem találunk ki
    cardRecord(best.lang, best.id, { pref: S.pref }).then(rec => {
      if (rcState !== st || st.cur !== best) return;
      const tags = [rec.rarity, CATS[rec.category] && rec.category !== 'Pokemon' ? CATS[rec.category] : (rec.category === 'Pokemon' ? 'Pokémon' : ''), ...(rec.variant && rec.variant !== 'normal' ? [VARS[rec.variant]] : [])].filter(Boolean);
      $('#rcRar').innerHTML = tags.length ? tags.map(t => `<span class="tag">${esc(t)}</span>`).join('') : '<span class="tag">–</span>';
      $('#rcPrice').innerHTML = priceBoxes(rec);
      if (rec.image && $('#rcImg') && !best.image) $('#rcImg').src = rec.image;
    }).catch(() => { if (rcState === st) { $('#rcRar').innerHTML = '<span class="tag">–</span>'; $('#rcPrice').innerHTML = '<div class="pbox none"><small>Ár</small><b>most nem elérhető</b></div>'; } });
  };
  if (added) { st.added = true; st.undoable = true; }
  $('#resultPage').hidden = false; document.body.classList.add('rp-open'); $('#resultPage').scrollTop = 0; $('#scanResult').scrollTop = 0;
  render();
}
$('#rpBack').onclick = () => finishCard();
async function addCandidate(c, r, cond = 'NM') {
  const rec = await cardRecord(c.lang, c.id, { pref: S.pref });
  rec.condition = cond || 'NM';
  if (r?.card) rec.photo = thumb(r.card);
  const { card, merged } = await Store.addOrIncrement(rec);
  recordPrices(card, S).catch(() => {});
  lastAdded = { uid: card.uid, print: r?.print, merged };
  const rs = [c.lang, c.setId]; if (!recentSets.some(x => x.join() === rs.join())) { recentSets.unshift(rs); recentSets.length = Math.min(recentSets.length, 12); }
  sessionList.unshift({ uid: card.uid, merged });
  const h = hufOf(card);
  toast(`${merged ? '+1 darab' : 'Új lap'}: ${card.name} · ${h == null ? 'nincs ár' : fmtHuf(h)}`);
  try { navigator.vibrate?.(40); } catch {}
  return card;
}
async function undoLast(silent) {
  const s = sessionList.shift(); if (!s) return;
  const c = await Store.get(s.uid);
  if (c) { if (c.qty > 1) { c.qty--; await Store.put(c); } else await Store.remove(c.uid); }
  lastAdded = null;
  if (!silent) toast('Visszavonva');
}
function renderSession() {}
$('#fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  const url = URL.createObjectURL(f);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const sc = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = img.naturalWidth * sc; c.height = img.naturalHeight * sc;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  toast('Felismerés…');
  scanSource(c);
};

// ---------- kézi keresés ----------
async function openManual(name = '', number = '') {
  let lang = S.scanLang === 'ja' ? 'ja' : 'en';
  openSheet(`<h3 style="margin:0 0 10px">🔎 Kézi keresés</h3>
    <div class="seg" id="mLang"><button data-l="en" class="${lang === 'en' ? 'on' : ''}">🇬🇧 Angol</button><button data-l="ja" class="${lang === 'ja' ? 'on' : ''}">🇯🇵 Japán</button></div>
    <label class="fld">Név (japánnál angol név is jó)<input id="mName" value="${esc(name)}" placeholder="pl. Charizard, リザードン"></label>
    <label class="fld" style="margin-top:8px">Szett<select id="mSet"><option value="">Bármely szett</option></select></label>
    <label class="fld" style="margin-top:8px">Gyűjtői szám<input id="mNum" value="${esc(number || '')}" placeholder="pl. 125 vagy 125/103" inputmode="text"></label>
    <button class="btn big gold" id="mGo" style="margin-top:12px">Keresés</button>
    <div id="mRes" class="cands"></div>`);
  const fillSets = async () => {
    const sets = (await getSets(lang).catch(() => [])).slice().reverse();
    const feat = FEATURED.filter(f => (f.lang === 'JP') === (lang === 'ja')).map(f => f.setId);
    const fs = sets.filter(s => feat.includes(s.id)), rest = sets.filter(s => !feat.includes(s.id));
    $('#mSet').innerHTML = '<option value="">Bármely szett</option>' + (fs.length ? '<optgroup label="Kiemelt">' + fs.map(s => `<option value="${esc(s.id)}">★ ${esc(s.name)} (${esc(s.id)})</option>`).join('') + '</optgroup>' : '') +
      '<optgroup label="Minden szett (legújabb elöl)">' + rest.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.id)})</option>`).join('') + '</optgroup>';
  };
  fillSets();
  $('#mLang').onclick = e => { const b = e.target.closest('button'); if (!b) return; lang = b.dataset.l; $$('#mLang button').forEach(x => x.classList.toggle('on', x === b)); fillSets(); };
  $('#mGo').onclick = async () => {
    const nm = $('#mName').value.trim(), set = $('#mSet').value, numRaw = $('#mNum').value.trim();
    const num = numRaw.split('/')[0].trim(), tot = numRaw.includes('/') ? parseInt(numRaw.split('/')[1]) : null;
    const res = $('#mRes'); res.innerHTML = '<div class="hint">Keresés…</div>';
    let cands = [];
    try {
      if (set) {
        const s = await getSet(lang, set);
        cands = (s.cards || []).filter(c => (!num || parseInt(c.localId.replace(/\D/g, '')) === parseInt(num.replace(/\D/g, '')) || c.localId.toLowerCase() === num.toLowerCase()) && (!nm || nameSim(c.name, nm) > 0.5 || c.name.toLowerCase().includes(nm.toLowerCase())))
          .map(c => ({ lang, id: c.id, localId: c.localId, name: c.name, image: c.image, setId: set, setName: s.name, official: s.cardCount?.official, why: [] }));
        if (nm && lang === 'ja' && !cands.length) {
          const jl = await searchJaByEnglishName(nm);
          cands = jl.filter(c => c.id.startsWith(set + '-')).map(c => ({ lang, id: c.id, localId: c.localId, name: c.name, image: c.image, setId: set, setName: s.name, official: s.cardCount?.official, why: [] }));
        }
      } else {
        cands = await findCandidates({ lang, number: num || null, total: tot, name: nm, setCodes: [] });
        if (nm && num) cands = cands.filter(c => c.score > 3);
      }
    } catch (e) { res.innerHTML = '<div class="hint">Hiba: ' + esc(e.message) + '</div>'; return; }
    cands = cands.slice(0, 60);
    res.innerHTML = cands.length ? cands.map((c, i) => candHtml(c, i, false)).join('') : '<div class="hint">Nincs találat.</div>';
    res.querySelectorAll('[data-ci]').forEach(el => el.onclick = async () => {
      const c = cands[+el.dataset.ci];
      el.style.opacity = .5;
      try { const card = await addCandidate(c, null); closeSheet(); openDetail(card.uid); } catch (e) { toast('Hiba: ' + e.message); el.style.opacity = 1; }
    });
  };
  if (name || number) $('#mGo').click();
}
$('#btnManual').onclick = () => openManual();

// ---------- export / import ----------
const COLS = ['uid', 'name', 'lang', 'set_name', 'set_code', 'set_id', 'number', 'printed_total', 'rarity', 'category', 'variant', 'condition', 'qty', 'price', 'price_currency', 'price_huf', 'total_huf', 'price_source', 'price_updated_at', 'scanned_at', 'last_scanned_at', 'api_id', 'image'];
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
$('#btnCsv').onclick = () => {
  const q = v => { v = v == null ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = CARDS.map(c => { const h = hufOf(c); return [c.uid, c.name, c.lang, c.setName, c.setCode, c.setId, c.number, c.printedTotal, c.rarity, c.category, c.variant, c.condition, c.qty, c.price, c.priceCurrency, h == null ? '' : Math.round(h), h == null ? '' : Math.round(h * c.qty), c.priceSource, c.priceUpdatedAt, c.scannedAt, c.lastScannedAt, c.apiId, c.image].map(q).join(';'); });
  download(`okemon-keszlet-${stamp()}.csv`, '﻿' + COLS.join(';') + '\n' + rows.join('\n'), 'text/csv;charset=utf-8');
  toast(`CSV export: ${CARDS.length} tétel`);
};
async function exportJson() {
  const t = totals();
  return { app: 'okemon-scanner', version: 2, exportedAt: new Date().toISOString(), fx: { eurHuf: S.eurHuf, usdHuf: S.usdHuf, manual: S.fxManual, source: S.fx?.source }, totalHuf: Math.round(t.sum), cards: t.cards, noPriceCards: t.noPrice, items: CARDS.map(({ photo, ...c }) => c), priceHistory: await Store.historyAll() };
}
// árelőzmény importja: csak érvényes pontok; ugyanaz a kulcs (lap|változat|nap|forrás) felülíródik, nem duplikálódik
async function importHistory(list) {
  const ok = (list || []).filter(p => p && p.key && p.apiId && p.date && p.value > 0 && p.currency && p.source);
  await Store.historyPut(ok);
  return ok.length;
}
$('#btnJson').onclick = async () => {
  const data = await exportJson();
  download(`okemon-keszlet-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json');
  toast(`JSON export: ${CARDS.length} tétel`);
};
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === sep) { row.push(f); f = ''; } else if (ch === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(h.map((k, i) => [k.trim(), r[i]])));
}
$('#impIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  const text = await f.text();
  let items = [], histIn = [];
  try {
    if (/^\s*[{[]/.test(text)) { const d = JSON.parse(text); items = Array.isArray(d) ? d : d.items || []; histIn = Array.isArray(d) ? [] : d.priceHistory || []; }
    else items = parseCsv(text).map(r => ({
      uid: r.uid || undefined, name: r.name, lang: r.lang, setName: r.set_name, setCode: r.set_code, setId: r.set_id, number: r.number, printedTotal: r.printed_total ? +r.printed_total : null,
      rarity: r.rarity, category: r.category || '', variant: r.variant || 'normal', condition: r.condition || 'NM', qty: +r.qty || 1, price: r.price === '' ? null : +r.price, priceCurrency: r.price_currency || null,
      priceSource: r.price_source, priceUpdatedAt: r.price_updated_at, scannedAt: r.scanned_at, lastScannedAt: r.last_scanned_at, apiId: r.api_id, image: r.image, imageSmall: r.image,
    }));
  } catch (err) { return toast('Hibás fájl: ' + err.message); }
  items = items.filter(c => c.apiId && c.lang && c.name);
  if (!items.length && histIn.length) { const nh = await importHistory(histIn); return toast(`Import kész: ${nh} árpont`); }
  if (!items.length) return toast('Nem találtam importálható tételt');
  if (!confirm(`${items.length} tétel importálása? (Az egyező tételek darabszáma összeadódik.)`)) return;
  let added = 0, merged = 0;
  for (const it of items) {
    const ex = await Store.findByKey(itemKey(it));
    if (ex) { ex.qty += +it.qty || 1; await Store.put(ex); merged++; }
    else { const { uid, ...rest } = it; const existsUid = uid && await Store.get(uid); await Store.put({ ...rest, uid: existsUid ? undefined : uid, deleted: false, qty: +it.qty || 1 }); added++; }
  }
  const nh = histIn.length ? await importHistory(histIn) : 0;
  toast(`Import kész: ${added} új, ${merged} összevont${nh ? `, ${nh} árpont` : ''}`);
};
$('#btnWipe').onclick = async () => {
  if (!CARDS.length) return toast('A készlet üres');
  if (!confirm(`Biztosan törlöd mind a ${CARDS.length} tételt? Előtte érdemes exportálni. Nem vonható vissza.`)) return;
  if (!confirm('Utolsó megerősítés: végleges törlés?')) return;
  await Store.clear(); toast('Készlet törölve');
};

// ---------- előkészítés (egyszer) ----------
const PREP_V = 1;
async function prepare() {
  const ban = $('#prep');
  const show = t => { ban.hidden = false; ban.textContent = '⏳ Előkészítés… ' + t; };
  try {
    if (S.preparedV === PREP_V) { warmUp(['eng']).catch(() => {}); return; }
    if (!navigator.onLine) return;
    show('szövegfelismerő (angol)'); await warmUp(['eng']);
    show('szövegfelismerő (japán)'); await warmUp(['jpn']);
    const pairs = FEATURED.map(f => [f.lang === 'JP' ? 'ja' : 'en', f.setId]);
    await buildIndex(pairs, t => show('képi index – ' + t));
    S.preparedV = PREP_V; await saveSettings();
    show('kész ✓'); setTimeout(() => { ban.hidden = true; }, 1500);
  } catch (e) { console.warn('előkészítés', e); ban.hidden = true; }
}

// ---------- betöltés ----------
async function reload() {
  CARDS = await Store.all();
  renderHome();
  if ($('#v-coll').classList.contains('active')) renderColl();
  if ($('#v-scan').classList.contains('active')) renderSession();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  $('#storeInfo').textContent = `${CARDS.length} tétel ezen az eszközön (IndexedDB)${est ? ` · tárhely: ${(est.usage / 1e6).toFixed(1)} MB` : ''}. Szinkron: nincs (helyi mód).`;
}
let rt = null;
onChange(() => { clearTimeout(rt); rt = setTimeout(reload, 80); });
function net() { const n = $('#netState'); n.textContent = navigator.onLine ? '● online' : '● offline'; n.classList.toggle('off', !navigator.onLine); }
addEventListener('online', net); addEventListener('offline', net);

(async function init() {
  const s = await Store.meta('settings'); if (s) S = { ...S, ...s };
  $$('#langSeg button').forEach(x => x.classList.toggle('on', x.dataset.lang === S.scanLang));
  net(); renderSettings(); await reload(); renderSession();
  navigator.storage?.persist?.().catch(() => {});
  loadFx().catch(e => { console.warn(e); if (!S.eurHuf) toast('Nincs élő árfolyam – adj meg kézit a Beállításokban'); })
    .finally(() => {
      if (S.lastDaily !== today() && navigator.onLine && CARDS.length && !location.search.includes('test=')) {
        S.lastDaily = today(); saveSettings(); refreshAll();
      }
    });
  const h = location.hash.slice(1); if (['home', 'scan', 'coll', 'set'].includes(h)) go(h);
  // első megnyitás: OCR-modellek (eng + jpn) és a 4 kiemelt szett képi indexe – egyszer, „Előkészítés…” jelzéssel
  if (!location.search.includes('test=')) setTimeout(prepare, 1200);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// tesztelési horog
if (location.search.includes('test=')) import('../tests/harness.js');
window.okemon = { setLang: l => { S.scanLang = l; jaSetIds = null; $$('#langSeg button').forEach(x => x.classList.toggle('on', x.dataset.lang === l)); }, scanSource, Store, recognize, findCandidates, normalizeCard, totals: () => totals(), hufOf, S: () => S,
  // a legutóbbi szkennelés jelöltjei, és egy jelölt kiválasztása (mintha a felhasználó rákoppintana)
  exportJson, importHistory, renderCollTop: () => renderColl(),
  prepare: () => { S.preparedV = 0; return prepare(); }, lastCands: () => lastCands, setFast: v => { S.fastMode = !!v; }, live, startLive, stopLive, warpFromCanvas, recognizeFrame,
  resultVisible: () => !$('#resultPage').hidden, rcDec: () => rcDec, pick: i => addCandidate(lastCands[i], lastScan) };
