// Okemon Scanner – helyi tároló (IndexedDB).
// A UI csak ezen a modulon keresztül éri el az adatokat, így később ugyanez az
// interfész egy felhős backendre (webshop / pakkbontó rendszer) is ráköthető:
// minden rekord kap egy globálisan egyedi `uid`-t és `updatedAt` időbélyeget,
// a törlés pedig "tombstone"-t hagy (`deleted: true`), hogy a szinkron lássa.

const DB_NAME = 'okemon-scanner';
const DB_VER = 2; // 2: priceHistory store
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'uid' });
        s.createIndex('key', 'key', { unique: false });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      // árelőzmény: lapazonosító + változat + nap + forrás → egy pont (ugyanarra a napra/forrásra csak 1)
      if (!db.objectStoreNames.contains('priceHistory')) {
        const h = db.createObjectStore('priceHistory', { keyPath: 'key' });
        h.createIndex('apiId', 'apiId', { unique: false });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2));

// Egy készlettétel egyedi kulcsa: ugyanaz a lap + változat + állapot = darabszám nő.
export const itemKey = c => [c.lang, c.apiId, c.variant || 'normal', c.condition || 'NM'].join('|');

const listeners = new Set();
export const onChange = fn => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });

export const Store = {
  async all({ includeDeleted = false } = {}) {
    const rows = await tx('cards', 'readonly', s => req(s.getAll()));
    return includeDeleted ? rows : rows.filter(r => !r.deleted);
  },
  async get(uid) { return tx('cards', 'readonly', s => req(s.get(uid))); },
  async findByKey(key) {
    const rows = await tx('cards', 'readonly', s => req(s.index('key').getAll(key)));
    return rows.find(r => !r.deleted) || null;
  },
  async put(card) {
    card.key = itemKey(card);
    card.updatedAt = new Date().toISOString();
    card.uid = card.uid || uuid();
    card.dirty = true; // szinkronra vár
    await tx('cards', 'readwrite', s => req(s.put(card)));
    emit();
    return card;
  },
  async putMany(cards, { silent = false } = {}) {
    const now = new Date().toISOString();
    await tx('cards', 'readwrite', s => Promise.all(cards.map(c => {
      c.key = itemKey(c); c.uid = c.uid || uuid(); c.updatedAt = c.updatedAt || now; c.dirty = true;
      return req(s.put(c));
    })));
    if (!silent) emit();
  },
  // Hozzáad: ha már megvan, csak a darabszám nő.
  async addOrIncrement(card, qty = 1) {
    const ex = await this.findByKey(itemKey(card));
    if (ex) { ex.qty = (ex.qty || 0) + qty; ex.lastScannedAt = new Date().toISOString(); return { card: await this.put(ex), merged: true }; }
    card.qty = qty;
    card.scannedAt = card.lastScannedAt = new Date().toISOString();
    return { card: await this.put(card), merged: false };
  },
  async remove(uid) {
    const c = await this.get(uid);
    if (!c) return;
    c.deleted = true; c.qty = 0;
    await this.put(c);
  },
  async clear() { await tx('cards', 'readwrite', s => req(s.clear())); emit(); },
  async meta(k, v) {
    if (v === undefined) return tx('meta', 'readonly', s => req(s.get(k)));
    await tx('meta', 'readwrite', s => req(s.put(v, k)));
  },
  async cacheGet(k, maxAgeMs) {
    const v = await tx('cache', 'readonly', s => req(s.get(k)));
    if (!v) return null;
    if (maxAgeMs && Date.now() - v.t > maxAgeMs) return null;
    return v.d;
  },
  // ---- árelőzmény ----
  async historyPut(points) {
    if (!points.length) return;
    await tx('priceHistory', 'readwrite', s => Promise.all(points.map(p => req(s.put(p)))));
  },
  async historyFor(apiId) { return tx('priceHistory', 'readonly', s => req(s.index('apiId').getAll(apiId))); },
  async historyAll() { return tx('priceHistory', 'readonly', s => req(s.getAll())); },
  async historyDelete(key) { await tx('priceHistory', 'readwrite', s => req(s.delete(key))); },
  async historyClear() { await tx('priceHistory', 'readwrite', s => req(s.clear())); },
  async cacheSet(k, d) { await tx('cache', 'readwrite', s => req(s.put({ t: Date.now(), d }, k))); },
};

// Szinkron-csatlakozó helye. Egy későbbi backend ezt valósítja meg:
//   push(rows)  -> a `dirty` rekordok feltöltése, visszaadja a sikeres uid-kat
//   pull(since) -> a szerveren `since` óta változott rekordok
// A UI nem függ tőle; most a NoopSync fut.
export const NoopSync = {
  name: 'helyi (nincs szinkron)',
  async push() { return []; },
  async pull() { return []; },
};
