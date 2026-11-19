// Laponkénti árelőzmény és árgrafikon. Árat nem találunk ki:
//  • saját pontok: minden árfrissítéskor (szkennelés, kézi frissítés, napi első megnyitás) forrásonként 1 pont/nap
//  • referencia: a TCGdex Cardmarket-adat 1 / 7 / 30 napos átlaga és trendje – címkézett vonalként, nem napi árként
import { Store } from './db.js';

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const SRC = { cardmarket: 'Cardmarket', tcgplayer: 'TCGplayer' };
const COLOR = { cardmarket: '#f5c518', tcgplayer: '#6ec6ff' };

// Pontok egy készletrekord aktuális áraiból (prices: { cardmarket: {value,currency,label}, tcgplayer: … })
export function pointsFromRecord(rec, fx, date = today()) {
  const out = [];
  for (const [source, p] of Object.entries(rec.prices || {})) {
    if (!(p?.value > 0)) continue;
    const rate = p.currency === 'EUR' ? fx?.eurHuf : p.currency === 'USD' ? fx?.usdHuf : null;
    out.push({
      key: `${rec.apiId}|${rec.variant || 'normal'}|${date}|${source}`,
      apiId: rec.apiId, lang: rec.lang, variant: rec.variant || 'normal', date, ts: new Date().toISOString(),
      value: p.value, currency: p.currency, source, label: p.label || '', via: rec.pricingVia || 'TCGdex', hufRate: rate || null,
    });
  }
  return out;
}
export async function recordPrices(rec, fx) { const pts = pointsFromRecord(rec, fx); await Store.historyPut(pts); return pts.length; }

// Referencia-átlagok a nyers TCGdex-árból (csak ami tényleg benne van)
export function referenceLines(pricingRaw, variant = 'normal') {
  const cm = pricingRaw?.cardmarket, refs = [];
  const pos = v => typeof v === 'number' && v > 0 ? v : null;
  if (cm) {
    const sfx = variant === 'reverse' ? '-holo' : '';
    for (const [k, label] of [['avg1', '1 napos átlag'], ['avg7', '7 napos átlag'], ['avg30', '30 napos átlag'], ['trend', 'trend']]) {
      const v = pos(cm[k + sfx]);
      if (v) refs.push({ source: 'cardmarket', label: 'Cardmarket ' + label, value: v, currency: cm.unit || 'EUR' });
    }
  }
  return refs;
}

const fmtV = (v, cur) => cur === 'HUF' ? Math.round(v).toLocaleString('hu-HU') + ' Ft' : (cur === 'EUR' ? '€' : '$') + v.toFixed(2);
// Könnyű SVG-vonaldiagram. unit: 'EUR' | 'USD' | 'HUF'; rateNow: { EUR, USD } a referencia-vonalak HUF-átváltásához
export function chartSvg(points, refs, { days = 30, unit = 'EUR', rateNow = {} } = {}) {
  const W = 600, H = 230, L = 58, R = 12, T = 14, B = 28;
  const since = days ? Date.now() - days * 864e5 : 0;
  const conv = (v, cur, rate) => unit === 'HUF' ? (rate ? v * rate : null) : (cur === unit ? v : null);
  const series = {};
  for (const p of points) {
    const t = new Date(p.date + 'T12:00:00').getTime();
    if (t < since) continue;
    const y = conv(p.value, p.currency, p.hufRate);
    if (y == null) continue;
    (series[p.source] ||= []).push({ t, y });
  }
  Object.values(series).forEach(s => s.sort((a, b) => a.t - b.t));
  const lines = refs.map(r => ({ ...r, y: conv(r.value, r.currency, rateNow[r.currency]) })).filter(r => r.y != null);
  const ys = Object.values(series).flat().map(p => p.y).concat(lines.map(l => l.y));
  if (!ys.length) return null;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < y1 * 0.04) { y0 -= y1 * 0.05 || 1; y1 += y1 * 0.05 || 1; }
  const pad = (y1 - y0) * 0.08; y0 = Math.max(0, y0 - pad); y1 += pad;
  const ts = Object.values(series).flat().map(p => p.t);
  let t0 = ts.length ? Math.min(...ts) : Date.now() - 864e5, t1 = ts.length ? Math.max(...ts) : Date.now();
  if (t1 - t0 < 864e5) { t0 -= 864e5; t1 += 864e5 * 0.2; }
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const fmtD = t => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}.`; };
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="pchart" role="img" aria-label="Árváltozás">`;
  for (let i = 0; i <= 3; i++) { const v = y0 + (y1 - y0) * i / 3, y = Y(v); svg += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="ax">${fmtV(v, unit)}</text>`; }
  svg += `<text x="${L}" y="${H - 8}" class="ax">${fmtD(t0)}</text><text x="${W - R}" y="${H - 8}" text-anchor="end" class="ax">${fmtD(t1)}</text>`;
  lines.forEach((l, i) => { const y = Y(l.y); svg += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="ref" stroke="${COLOR[l.source]}"/><text x="${W - R - 4}" y="${i % 2 ? y + 13 : y - 4}" text-anchor="end" class="reft">${l.label}: ${fmtV(l.y, unit)}</text>`; });
  for (const [src, s] of Object.entries(series)) {
    const c = COLOR[src] || '#fff';
    if (s.length > 1) svg += `<polyline fill="none" stroke="${c}" stroke-width="2.5" points="${s.map(p => X(p.t) + ',' + Y(p.y)).join(' ')}"/>`;
    s.forEach(p => { svg += `<circle cx="${X(p.t)}" cy="${Y(p.y)}" r="4" fill="${c}"><title>${SRC[src]} ${fmtD(p.t)}: ${fmtV(p.y, unit)}</title></circle>`; });
  }
  return svg + '</svg>';
}
export { SRC, COLOR };
