// Szám-OCR stresszteszt: index.html?test=stress[&files=a.jpg,b.jpg]
// Minden fotót többféle torzítással (méret, elmosás, élsimítás nélküli átméretezés, forgatás, JPEG) futtat át
// a recognize()-on, és megszámolja, hányszor jön ki a várt gyűjtői szám. Más böngésző / OS képfeldolgozását utánozza.
const WANT = {
  'photo_en_30th_022.jpg': ['022', 128],
  'photo_en_delta_reign_120.jpg': ['120', 103],
  'photo_en_delta_reign_010.jpg': ['010', 103],
  'photo_jp_storm_emeralda_050.jpg': ['050', 76],
  'photo_jp_151_201.jpg': ['201', 165],
};
export const VARIANTS = [
  { name: 'eredeti' },
  { name: 'kicsi 0.55×', scale: 0.55 },
  { name: 'közepes 0.75×', scale: 0.75 },
  { name: 'nagy 1.3×', scale: 1.3 },
  { name: 'élsimítás nélkül 0.7×', scale: 0.7, smooth: false },
  { name: 'elmosva 1px', blur: 1 },
  { name: 'elmosva 1.8px', blur: 1.8 },
  { name: 'forgatva +1.5°', rot: 1.5 },
  { name: 'forgatva −1.5°', rot: -1.5 },
  { name: 'JPEG q=0.45', jpeg: 0.45 },
  { name: 'sötétebb + kontraszt', filter: 'brightness(0.8) contrast(0.85)' },
  { name: 'kicsi + elmosva + JPEG', scale: 0.6, blur: 1, jpeg: 0.5 },
];
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
export async function variant(img, v) {
  const s = v.scale || 1, W = Math.round(img.naturalWidth * s), H = Math.round(img.naturalHeight * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = v.smooth !== false;
  g.fillStyle = '#777'; g.fillRect(0, 0, W, H);
  const f = [v.blur ? `blur(${v.blur}px)` : '', v.filter || ''].join(' ').trim();
  if (f) g.filter = f;
  if (v.rot) { g.translate(W / 2, H / 2); g.rotate(v.rot * Math.PI / 180); g.translate(-W / 2, -H / 2); }
  g.drawImage(img, 0, 0, W, H);
  if (!v.jpeg) return c;
  const j = await load(c.toDataURL('image/jpeg', v.jpeg));
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; c2.getContext('2d').drawImage(j, 0, 0);
  return c2;
}
const API = { 'photo_en_30th_022.jpg': '30th-022', 'photo_en_delta_reign_120.jpg': 'me06-120', 'photo_en_delta_reign_010.jpg': 'me06-010', 'photo_jp_storm_emeralda_050.jpg': 'M6-050', 'photo_jp_151_201.jpg': 'SV2a-201' };
// full = true: a teljes azonosítást (identify) is lefuttatja – a lényeg: hamis automatikus hozzáadás ne legyen
export async function runStress(files, { full = false } = {}) {
  const { recognize } = await import('../js/recognize.js');
  const { identify } = await import('../js/identify.js');
  const { getSets } = await import('../js/api.js');
  const [ja, en] = await Promise.all([getSets('ja'), getSets('en')]);
  const totals = new Set(ja.concat(en).map(s => +s.cardCount?.official).filter(n => n > 0));
  const jaIds = ja.map(s => s.id);
  const out = [];
  for (const f of files) {
    const img = await load('tests/' + f);
    const [num, tot] = WANT[f];
    let ok = 0, autos = 0, falseAdds = 0; const rows = [];
    for (const v of VARIANTS) {
      const c = await variant(img, v);
      const t = performance.now();
      const r = await recognize(c, { lang: 'auto', jaSetIds: jaIds, totals });
      const hit = r.number && parseInt(r.number, 10) === parseInt(num, 10) && r.total === tot;
      if (hit) ok++;
      let idTxt = '';
      if (full) {
        const id = await identify(r, { lang: 'auto' });
        const top = id.cands[0]?.id, want = API[f];
        const verdict = id.sure ? (top === want ? 'AUTO ✔' : 'HAMIS AUTO ✘✘') : (top === want ? 'választás, 1. jelölt jó' : 'választás, 1. jelölt: ' + (top || '–'));
        if (id.sure && top !== want) falseAdds++;
        if (id.sure && top === want) autos++;
        idTxt = ' → ' + verdict;
      }
      rows.push(`${hit ? '✔' : '✘'} ${v.name}: ${r.number ? r.number + '/' + r.total : 'szám –'} (${Math.round(performance.now() - t)} ms)${idTxt}`);
    }
    out.push({ f, ok, n: VARIANTS.length, rows, autos, falseAdds });
  }
  return out;
}
