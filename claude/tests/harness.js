// Tesztfuttató:
//   index.html?test=all          – fotó nélküli tesztek + a 6 mintafotó beszkennelése + lapazonosító-ellenőrzés
//   index.html?test=unit         – csak a fotó nélküli tesztek
//   index.html?test=fajl1,fajl2  – csak ezek a fotók
//   &strict=1                    – minden fotónál automatikus hozzáadást vár (különben elfogadja,
//                                  ha nem biztos, de a helyes lap az 1. jelölt – ilyenkor kiválasztja)
//   index.html?test=live           – a teljes élő szkenner-folyamat a tesztfotókkal, canvas-videófolyamként (tests/live.js)
//   index.html?test=stress[&files=…] – szám-OCR stresszteszt torzított fotókkal (tests/stress.js)
// A készletet előtte törli (kivéve &keep=1), a nyelvet Auto-ra állítja. Eredmény: window.__tests + képernyőn.
import { runUnit } from './unit.js';

export const EXPECTED = {
  'photo_en_delta_reign_120.jpg': 'me06-120',      // Wishiwashi ex – Ultra Rare
  'photo_en_delta_reign_010.jpg': 'me06-010',      // Wimpod – Common
  'photo_en_30th_022.jpg': '30th-022',             // Wishiwashi – Common
  'photo_jp_30th_129.jpg': 'M6a-129',              // ミュウex – SIR
  'photo_jp_storm_emeralda_050.jpg': 'M6-050',     // ジャラコ – Common
  'photo_jp_151_201.jpg': 'SV2a-201',              // リザードンex – SIR (nem kiemelt szett)
};
const ALL = Object.keys(EXPECTED);
const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

function report(tests) {
  let el = document.getElementById('testReport');
  if (!el) { el = document.createElement('pre'); el.id = 'testReport'; el.style.cssText = 'position:fixed;left:0;right:0;bottom:84px;max-height:55vh;overflow:auto;z-index:90;background:#050505;border-top:2px solid #f5c518;color:#eee;font:12px/1.4 ui-monospace,monospace;margin:0;padding:10px;white-space:pre-wrap'; document.body.appendChild(el); }
  const fail = tests.filter(t => !t.ok).length, sk = tests.filter(t => t.skipped).length;
  el.textContent = `TESZT: ${tests.length - fail}/${tests.length} OK${sk ? `, ${sk} kihagyva` : ''}${fail ? `, ${fail} HIBA` : ''}${window.__done ? '' : ' (fut…)'}\n` +
    tests.map(t => `${t.skipped ? '–' : t.ok ? '✔' : '✘'} ${t.name}${t.detail ? '  [' + t.detail + ']' : ''}`).join('\n');
}

export async function run(list, { clear = true, unit = true, strict = false } = {}) {
  window.__res = []; window.__tests = []; window.__done = false;
  while (!window.okemon) await new Promise(r => setTimeout(r, 100));
  const tests = window.__tests;
  if (unit) { try { tests.push(...await runUnit()); } catch (e) { tests.push({ name: 'fotó nélküli tesztek', ok: false, detail: e.message }); } report(tests); }
  if (list.length) {
    okemon.setLang('auto'); okemon.setFast(true); // fotós teszt: a biztos találatot magától hozzáadja (Gyors mód)
    if (clear) await okemon.Store.clear();
    for (const f of list) {
      try {
        const before = new Map((await okemon.Store.all()).map(c => [c.apiId, c.qty]));
        const img = await load('tests/' + f);
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
        const t = performance.now(); await okemon.scanSource(c);
        const ms = Math.round(performance.now() - t);
        const added = (await okemon.Store.all()).filter(x => (before.get(x.apiId) || 0) < x.qty).map(x => x.apiId);
        const want = EXPECTED[f];
        window.__res.push({ f, ms, added, result: document.querySelector('#scanResult').innerText.replace(/\s+/g, ' ').slice(0, 200) });
        if (want) {
          const top = okemon.lastCands()[0];
          if (added.length) {
            // automatikus hozzáadás: csak a várt lap lehet (hamis auto-add = hiba)
            tests.push({ name: `fotó ${f} → ${want}`, ok: added.length === 1 && added[0] === want, detail: (added[0] === want ? 'auto-add' : 'HAMIS auto-add: ' + added.join(', ')) + ` · ${ms} ms` });
          } else if (!strict && top?.id === want) {
            // nem volt biztos → választást kért; elfogadjuk, ha a helyes lap az első jelölt, és „rákoppintunk”
            await okemon.pick(0);
            tests.push({ name: `fotó ${f} → ${want}`, ok: true, detail: `választást kért, a helyes lap az 1. jelölt → kiválasztva · ${ms} ms` });
          } else {
            const sc = okemon.rcDec()?.r || {};
            tests.push({ name: `fotó ${f} → ${want}`, ok: false, detail: `nincs auto-add, az 1. jelölt: ${top ? top.id : 'nincs'}${strict ? ' (strict: auto-add kell)' : ''} · ${ms} ms · olvasott: ${sc.number || '–'}/${sc.total || '–'} (tipp ${sc.numberHint || '–'}) „${sc.name || ''}” ${sc.nameJa || ''} · jelöltek: ` + okemon.lastCands().slice(0, 5).map(c => `${c.id} ${c.name} ${c.score.toFixed(1)} sim${(c.sim || 0).toFixed(2)} ${c.why.join('+')}`).join(' | ') });
          }
        }
      } catch (e) { tests.push({ name: 'fotó ' + f, ok: false, detail: e.message }); }
      report(tests);
    }
    await new Promise(r => setTimeout(r, 500)); // a felület 80 ms-mal késleltetve tölti újra a készletet
    const all = await okemon.Store.all();
    const ids = new Set(all.map(c => c.apiId));
    const wants = list.map(f => EXPECTED[f]).filter(Boolean);
    const miss = wants.filter(w => !ids.has(w));
    tests.push({ name: `készlet a végén: mind a ${wants.length} várt lap benne van`, ok: !miss.length, detail: miss.length ? 'hiányzik: ' + miss.join(', ') : '' });
    // gyűjteményérték = Σ ár × db × árfolyam (az ár nélküliek kihagyva)
    const S = okemon.S();
    let sum = 0; for (const x of all) { const r = x.priceCurrency === 'EUR' ? S.eurHuf : x.priceCurrency === 'USD' ? S.usdHuf : null; if (x.price != null && r) sum += x.price * r * x.qty; }
    tests.push({ name: 'gyűjteményérték = Σ ár × db × árfolyam', ok: Math.abs(sum - okemon.totals().sum) < 0.5, detail: `${Math.round(sum)} Ft` });
    tests.push({ name: 'minden tétel kapott kategóriát (Pokemon/Trainer/Energy)', ok: all.every(x => x.category), detail: all.filter(x => !x.category).map(x => x.apiId).join(', ') });
  }
  window.__done = true;
  report(tests);
  postReport(list.length ? (unit ? 'all' : 'photos') : 'unit', tests, { photos: window.__res });
}
const sp = new URLSearchParams(location.search), q = sp.get('test');
// &report=1: az eredmény elküldése a fejlesztői szervernek (tools/serve.py → tests/reports/<mód>.json), fejnélküli futtatáshoz
const postReport = (mode, tests, extra = {}) => { if (sp.has('report')) fetch('/__report?name=' + mode, { method: 'POST', body: JSON.stringify({ mode, at: new Date().toISOString(), ua: navigator.userAgent, tests, ...extra }) }).catch(() => {}); };
if (q === 'stress') import('./stress.js').then(async m => {
  while (!window.okemon) await new Promise(r => setTimeout(r, 100));
  window.__done = false;
  const files = (sp.get('files') || 'photo_en_30th_022.jpg').split(',');
  const res = await m.runStress(files, { full: sp.has('full') });
  window.__stress = res; window.__done = true;
  const el = document.createElement('pre'); el.id = 'testReport'; el.style.cssText = 'position:fixed;left:0;right:0;bottom:84px;max-height:60vh;overflow:auto;z-index:90;background:#050505;border-top:2px solid #f5c518;color:#eee;font:12px/1.4 monospace;margin:0;padding:10px;white-space:pre-wrap';
  el.textContent = res.map(r => `${r.f}: szám ${r.ok}/${r.n}${sp.has('full') ? ` · auto ${r.autos} · HAMIS auto ${r.falseAdds}` : ''}\n` + r.rows.join('\n')).join('\n\n'); document.body.appendChild(el);
});
if (q === 'live') import('./live.js').then(async m => {
  window.__done = false; window.__tests = [];
  const tests = await m.runLive({ keep: sp.has('keep'), report: t => { window.__tests = t; report(t); } });
  window.__tests = tests; window.__done = true; report(tests); postReport('live', tests);
});
if (q && q !== 'stress' && q !== 'live') run(q === "all" ? ALL : q === "unit" ? [] : q.split(","), { clear: !sp.has('keep'), unit: q === 'all' || q === 'unit', strict: sp.has('strict') });
