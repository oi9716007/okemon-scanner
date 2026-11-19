// „Melyik csomagban van?” – a bolt valós termékadataiból (products.js) + általános szabályok.
import { EN_PRODUCTS, JP_PRODUCTS, JP_SET_EN_NAMES } from './products.js';

export const FEATURED = [
  { lang: 'EN', setId: 'me06', label: 'Delta Reign', flag: '🇬🇧' },
  { lang: 'EN', setId: '30th', label: '30th Celebration', flag: '🇬🇧' },
  { lang: 'JP', setId: 'M6a', label: '30th Celebration', flag: '🇯🇵' },
  { lang: 'JP', setId: 'M6', label: 'Storm Emeralda', flag: '🇯🇵' },
];
export const isFeatured = c => FEATURED.some(f => f.lang === c.lang && f.setId === c.setId) || (c.lang === 'EN' && c.setId === '30th-c');

const isPromo = c => /(^|[-.])p$|promo|-P$|^P-|^SVP|^MEP|^SWSHP|^SMP|^XYP/i.test(c.setId) || /promo/i.test(c.setName || '');

export function packInfo(c) {
  const notes = [];
  let products = [];
  let setLabel = c.setName;
  if (c.lang === 'JP') {
    products = JP_PRODUCTS[c.setId] || [];
    if (JP_SET_EN_NAMES[c.setId]) setLabel = `${c.setName} (${JP_SET_EN_NAMES[c.setId]})`;
  } else {
    const key = (c.setId === '30th-c' ? '30th celebration' : (c.setName || '').toLowerCase());
    products = EN_PRODUCTS[key] || [];
    if (c.setId === '30th-c') notes.push('Classic Collection al-szett: a 30th Celebration termékcsaládhoz tartozik.');
  }
  const num = parseInt(String(c.number).replace(/\D/g, ''), 10);
  if (isPromo(c)) notes.push('Promó lap: nem a booster pakkokban van, hanem külön termékben (kollekció, tin, előrendelés) vagy eseményen adják.');
  else if (c.printedTotal && num > c.printedTotal) notes.push(`Titkos ritkaság (${c.number} > ${c.printedTotal}): a szett booster pakkjaiban található, ritkán.`);
  const withPacks = products.filter(p => p.p == null || p.p > 0);
  const fixed = products.filter(p => p.p === 0);
  if (!products.length && !isPromo(c)) notes.push('A bolt termékadataiban ehhez a szetthez nincs termék. Általánosan: a szett booster pakkjaiban, illetve a pakkokat tartalmazó termékekben (booster doboz, ETB, bundle, blister).');
  return { setLabel, products: withPacks, fixedDecks: fixed, notes, featured: isFeatured(c) };
}

// Megjelenítendő szettnév: japán szettnél (ha ismert) az angol név is, pl. „Storm Emeralda · ストームエメラルダ”
export function setTitle(c, short = false) {
  if (short && c.lang === 'JP' && JP_SET_EN_NAMES[c.setId]) return JP_SET_EN_NAMES[c.setId];
  if (c.lang === 'JP' && JP_SET_EN_NAMES[c.setId]) return `${JP_SET_EN_NAMES[c.setId]} · ${c.setName}`;
  return c.setName;
}
