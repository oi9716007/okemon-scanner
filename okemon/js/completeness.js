// Szett-komplettség: egy kiadáson belül hány különböző lap van meg, mennyi a szett, mi hiányzik.
// A szett laplistája a TCGdex getSet()-ből jön (cache-elve az IndexedDB-ben, lásd api.js cached()).
//  • hivatalos szett: 1…cardCount.official (a lapon lévő „/103”)
//  • teljes szett:    cardCount.total (titkos ritkaságokkal együtt) – ez az alapértelmezés
// A 30th Celebration Classic Collection (30th-c) külön szett: saját 30 lapos listája van.
import { getSet } from './api.js';

const apiLang = l => (l === 'JP' || l === 'ja') ? 'ja' : 'en';
const numOf = id => parseInt(String(id).replace(/\D/g, ''), 10);

// Tiszta számítás (tesztelhető): setData = getSet() eredménye, owned = készlettételek
export function computeProgress(setData, owned, mode = 'total') {
  const cards = setData?.cards || [];
  const official = +setData?.cardCount?.official || 0;
  const total = +setData?.cardCount?.total || cards.length;
  const have = new Set(owned.filter(c => !c.deleted && (c.qty || 0) > 0 && c.setId === setData.id).map(c => c.apiId));
  const isOfficial = c => official > 0 && /^\d+$/.test(c.localId) && numOf(c.localId) >= 1 && numOf(c.localId) <= official;
  const haveTotal = cards.filter(c => have.has(c.id)).length;
  const haveOfficial = cards.filter(c => have.has(c.id) && isOfficial(c)).length;
  const scope = mode === 'official' ? cards.filter(isOfficial) : cards;
  const denom = mode === 'official' ? official : total;
  const missing = scope.filter(c => !have.has(c.id));
  const owned_ = scope.filter(c => have.has(c.id));
  const haveN = mode === 'official' ? haveOfficial : haveTotal;
  return {
    setId: setData.id, name: setData.name, official, total, haveOfficial, haveTotal,
    mode, have: haveN, of: denom, missingCount: Math.max(0, denom - haveN),
    pct: denom ? haveN / denom : 0, missing, owned: owned_,
  };
}

export async function setProgress(lang, setId, owned, mode = 'total') {
  const s = await getSet(apiLang(lang), setId);
  return computeProgress(s, owned, mode);
}
