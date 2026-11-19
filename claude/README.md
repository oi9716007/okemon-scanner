# Okemon Scanner

Telefonra optimalizált, telepíthető webapp (PWA) Pokémon TCG-lapok beszkenneléséhez, készletépítéshez és értékbecsléshez. Felület: magyar. Build-lépés nincs: sima HTML + JS modulok.

## Indítás

### A) Végleges HTTPS-link: GitHub Pages

1. Hozz létre egy új repót a GitHubon (pl. `okemon-scanner`).
2. Töltsd fel a mappa **tartalmát** a repó gyökerébe. Az `index.html` legyen legfelül, ne egy almappában.
   - Böngészőből: „Add file → Upload files”, és húzd be a mappa tartalmát.
   - Terminálból: `git init`, `git add .`, `git commit`, `git push`.
3. Kapcsold be a közzétételt: Settings → Pages → Source: „Deploy from a branch”, branch: `main`, mappa: `/ (root)` → Save.
4. 1–2 perc múlva elérhető itt: `https://<felhasználónév>.github.io/okemon-scanner/`. Ezt nyisd meg a telefonon.
   - iPhone (Safari): Megosztás → „Főképernyőhöz adás”.
   - Android (Chrome): ⋮ → „Alkalmazás telepítése”.

Jó tudni:
- Minden útvonal relatív, így a `/okemon-scanner/` al-útvonalon is működik.
- A fájlnevek csak ASCII karakterek, a GitHub kis- és nagybetű-érzékeny.
- A `.nojekyll` fájl kikapcsolja a Jekyll-feldolgozást.
- Frissítés után a telefonon egyszer újra kell tölteni az appot, és megjelenik az új verzió.
- A `screenshots/` és a `tests/src/` mappát nem kell feltölteni, a működéshez nem kellenek.

Ugyanez a mappa Netlify Dropra vagy Vercelre is feltölthető (statikus oldal, nincs build parancs).

### B) Helyi próba a Macen

```bash
cd ~/Desktop/webshop/okemon-scanner && python3 -m http.server 8824
```

Utána a Macen: http://localhost:8824. A kamera localhoston HTTPS nélkül is megy.
A telefonról a `http://<a-Mac-IP-címe>:8824` cím is megnyílik, de HTTPS nélkül az élő kamera nem indul. A „Fotó” gomb viszont így is működik.

Fejlesztéshez inkább ezt indítsd: `python3 tools/serve.py`. Gyorsítótár nélkül szolgál ki, és fogadja a tesztek eredményét (`&report=1`).

### Teszt

- `index.html?test=live`: a teljes élő szkenner-folyamat kamera nélkül. A tesztfotók canvas-videófolyamként (`captureStream`) mennek a szkennernek.
  - Lapnként: üres asztal, amin nem érzékelhet kártyát → lap → zöld keret → felugró eredmény-kártya → „Hozzáadás” (+1 db) → a lap még 3,5 mp-ig remegve a képen marad, és közben nem jöhet új találat (duplázásvédelem).
  - A perspektivikusan fotózott Wimpod a végén már meglévő lap, így 2 db lesz belőle.
- `tools/headless-test.sh all|live|unit [mp]`: ugyanezek fejnélküli Chrome-ban. Rejtett böngészőfülön a böngésző lefojtja a lapot, és az időmérés torzul; így nem. Kell hozzá a futó `tools/serve.py`. Az eredmény a `tests/reports/<mód>.json` fájlba kerül.
- `index.html?test=all`: minden teszt.
  - Fotó nélküli tesztek:
  - névtisztítás (Energy/Trainer), szám-értelmezés, szett-komplettség;
  - keresés élő API-val (Base Set Pikachu, Fire Energy, Switch, japán 151 フシギダネ, Delta Reign Wimpod);
  - katalógus-karikák (me06-010 2 db → „2”, me06-120 1 db → „1”, a többi 139 lap szürke és karika nélküli);
  - top 10 sorrend;
  - árelőzmény (napi 1 pont forrásonként, export → import után megmarad, kétszeri import sem duplikál);
  - nincs kitalált logó vagy ár;
  - kártyaérzékelés a 6 fotón és a perspektivikus fotón, negatív teszt üres asztalra, perspektíva-korrekció (900×1257-es álló kivágás);
  - képi ujjlenyomat: két különböző lap < 0,5;
  - a gyors út időmérése, cél: átlag ≤ 3 mp.
  - Utána a 6 mintafotó (3 angol, 3 japán) beszkennelése. Minden fotónál ellenőrzi a várt lapazonosítót, a végén a készletet és a gyűjteményértéket.
  - Az eredmény a képernyő alján látszik (✔ / ✘).
- Fotónként: automatikus hozzáadásnál csak a várt lap lehet, a hamis auto-add hiba. Ha az app nem biztos és választást kér, a teszt akkor fogadja el, ha a helyes lap az 1. jelölt; ilyenkor kiválasztja, és így a készletbe kerül.
- `&strict=1`: minden fotónál automatikus hozzáadást vár.
- `index.html?test=stress[&files=a.jpg,b.jpg]`: szám-OCR stresszteszt. A fotókat 12-féleképpen torzítja (kicsinyítés, nagyítás, élsimítás nélküli átméretezés, elmosás, ±1,5° forgatás, erős JPEG, sötétítés, kombinált), és megszámolja, hányszor jön ki a helyes szám. Más böngésző / OS képfeldolgozását utánozza.
- Helyi fejlesztéshez: `python3 tools/serve.py`. Ez gyorsítótár nélkül szolgál ki, így a módosított JS-modulok azonnal frissülnek.
- `index.html?test=unit`: csak a fotó nélküli tesztek. Ha nincs hálózat, az API-tesztek „kihagyva” állapotot kapnak, a helyiek ettől függetlenül lefutnak.
- A fotós teszt előtte törli a készletet; ha nem akarod, add hozzá a `&keep=1` paramétert. A nyelvet Auto-ra állítja.

## Élő szkenner (Szkennelés fül)

- **Indulás:** a fül megnyitásakor azonnal teljes képernyős élő kamerakép jelenik meg. Hátsó kamera (`facingMode: environment`), ideális esetben 1920×1080, folyamatos fókusszal, ha a böngésző támogatja. Gombot nyomni nem kell.
- **Figyelés** (~8 képkocka/mp, a videó 480 px-esre kicsinyített másolatán, Web Workerben – `js/detect-worker.js`, `js/detect-core.js`):
  1. Kártya-négyszöget keres: Sobel-élek, a háttér elárasztása a kép széléről, a legnagyobb körbezárt folt.
  2. A sarkokat oldalanként illesztett egyenesek metszéspontjai adják.
  3. Ellenőrzi az oldalarányt (63×88), a méretet és a kitöltöttséget.
  4. Stabilitás: a sarkok kb. 0,45 mp-ig egy helyben vannak. Élesség: Laplace-variancia; ha kevés, kiírja: „Tartsd stabilan”.
- **Érzékelés:** zöld keret a lap körvonalán, fel-le futó zöld szkennervonal, rövid rezgés (ahol a böngésző támogatja; iPhone Safari nem).
- **Felismerés** a perspektíva-korrigált, 900×1257-es kivágáson (a korrekció is a Workerben fut):
  - **Gyors út:** csak kis kivágásokból olvassa a gyűjtői számot (a megtalált szám-blokkot), a nevet kisebb nagyítással, és csak a már letöltött képi indexekben keres. Ha az első kockán nem volt szám, a következő kockán nem próbálja újra.
  - **Szavazás:** 2–3 képkocka eredménye dönt. Egy kocka is elég, ha erős (szám + összlap/szettkód + név/kép egyezik).
  - **Mi számít szavazatnak:** csak érdemi bizonyíték. Biztos találat; szám vagy szettkód; név és legalább 0,3-es kép; ellenőrzött nyelv és legalább 0,38-as kép; vagy legalább 0,45-ös kép. A gyenge, csak képi tipp nem dönt.
  - **Részletes út:** ha 3 kockán sincs döntés, még egyszer, teljes olvasással.
  - **Azonos rajzú EN/JP pár** (pl. 30th Celebration Mew ex): a lap szöveges részének írásrendszere (kana / latin) dönti el a nyelvet.
- **Eredmény-kártya** alulról felcsúszik:
  - lapkép, név, nyelv, szett és szám, ritkaság, ár HUF-ban (vagy „nincs ár”), és ha már van belőle: „Már megvan: N db”;
  - nagy zöld **„＋ Hozzáadás”** (+1 db) gomb, mellette **„Nem ez”**: ez a következő 2–4 jelöltet mutatja képpel, alatta kézi keresés;
  - ha a felismerés nem biztos: „Nem biztos – ellenőrizd!”.
- **Gyors mód** (alapból KI): ha a felismerés nagyon biztos (2 egyező képkocka és biztos találat), magától hozzáadja, és 2 mp-ig visszavonható. Alapból mindig a felhasználó nyomja a „Hozzáadás”-t.
- **Duplázásvédelem:** amíg a lap a képben marad, ugyanaz a lap (azonosító) nem ad új találatot, akkor sem, ha remeg a kép. Ha a lap ~0,65 mp-re kikerül a képből, a következő lap új felismerés.
- **Ha nem megy:** 4,5 mp alatt nincs döntés → a keret sárga, és kiírja: „Nem ismerem fel. Próbáld jobb fényben, tükröződés nélkül”. Mellette gombok: Kézi keresés / Tippek / Újra. A részletes olvasás a háttérben még lefut, és ha biztos találatot ad, mégis felhozza a lapot.
- **Előkészítés:** az app első megnyitásakor egyszer letölti és eltárolja az OCR-modelleket (angol + japán) és a 4 kiemelt szett képi indexét. Közben a fejlécben „Előkészítés…” látszik, így szkenneléskor már nem kell várni.
- **iPhone / Safari:**
  - `playsinline` + `muted` videó, HTTPS kell (GitHub Pages). Főképernyőre tett PWA módban is működik.
  - Ha nincs kamera-engedély, magyar útmutatót mutat (Beállítások › Safari › Kamera, illetve a címsor „aA” menüje), és egy „Kamera indítása” gombot, ami koppintásra újra kéri az engedélyt.
  - A rezgés iPhone-on nem működik (a Safari nem támogatja), máshol igen.
- **Fotó:** a „Fotó” gombbal feltöltött képen ugyanaz a kártyakeresés és perspektíva-korrekció fut, mint élőben.

**Mérések** (fejnélküli Chrome, Mac; `?test=live`):
- érzékelés 0,05–0,26 mp;
- felismerés 1,2–3 mp az angol és a japán közönséges lapoknál, 2,5–5,5 mp a holós / teljes-art lapoknál;
- a 151 Charizard ex (japán, teljes-art) kb. 11 mp: 4,5 mp-nél sárgára vált, és a háttérben futó részletes olvasás hozza fel.

Valódi iPhone-on nem mértem; a telefon lassabb lehet.

## Hogyan ismeri fel a lapot?

A felismerés a teljes TCGdex-katalógusban keres: angol és japán, régi és új szett, common és ritka lap, Pokémon, Trainer és Energy egyaránt. A 4 kiemelt szett csak a kezdőlapi kiemeléshez és a képi index előtöltéséhez kell. Ritkaságra, típusra vagy szettre nincs szűrés.

1. **Kivágás.** Megkeresi a lapot a háttér előtt, és normál kártyaméretre vágja (élő kameránál a sárga keretből).
2. **OCR (Tesseract.js, a böngészőben).**
   - Alsó sáv: gyűjtői szám (`120/103`), szettkód (pl. `DLR`, japánnál `M6`, `M6a`).
   - Felső sáv: név (angol: `eng`, japán: `jpn`).
   - Ha a felső sávból nem jön értelmes név (Energy- és Trainer-lapoknál a név máshol lehet), a fejléc alatti sávot, a középső címkét és az alsó névsávot is megpróbálja.
   - Névtisztítás: a fejléc-címkéket leveszi (Stage 1, Evolves from…, a sor eleji BASIC/VMAX/TERA, az önálló TRAINER/ITEM/SUPPORTER címkesor). A kártya nevének részét megtartja: „Fire Energy”, „Basic Lightning Energy”, „Energy Search”, „Professor's Research”, japánnál „基本炎エネルギー”.
   - A szám olvasása több lépésben történik:
     1. A lap alján megkeresi a szövegsorokat.
     2. A sorokat blokkokra bontja (szett-ikon, szám, jobb oldali szöveg).
     3. A szám-blokkot egységes betűméretre nagyítja, a dőlt számokat kiegyenesíti (nyírás), és többféle előfeldolgozással olvassa: szürke, sötét és világos binarizálás. Ferde lapnál a kiegyenesített képből is.
   - Az olvasatok szavaznak. Az összlapszám csak létező szett összlapja lehet, és a tévesztett számjegyeket (pl. 128 → 138 / 928 / 7128) a legfeljebb 1 karakteres eltérés alapján is a helyes összlaphoz rendeli.
   - A szám akkor biztos, ha legalább 2 olvasat egyezik. Egyetlen bizonytalan olvasatból nem lesz szám: rossz szám helyett inkább nincs szám, és ilyenkor a név, illetve a kép dönt.
3. **Keresés a TCGdex-ben.** Szám + szett-összlapszám + név + szettkód alapján jelölteket pontoz.
4. **Képi egyezés.** A lap illusztrációjának 256 bites ujjlenyomatát összeveti a jelöltek képével.
   - Ha a szöveg nem elég (holós, teljes-art lap, japán stilizált név, vagy semmi nem olvasható), szettenkénti „képi indexben” keres, legfeljebb 14 szettben, ebben a sorrendben:
     1. a kiolvasott szettkód és szett-összlapszám szerinti szettek,
     2. a szöveges jelöltek szettjei,
     3. a legutóbb szkennelt 12 szett,
     4. a készletben szereplő szettek,
     5. a 4 kiemelt szett.
   - Az indexet a telefon eltárolja.
   - A Beállításokban bármely szett, illetve a készletben szereplő összes szett indexe előre letölthető.
5. **Döntés.** Biztos találatnál (sorozat módban) azonnal hozzáadja. Ha a lap már megvan, csak a darabszám nő. Bizonytalan találatnál a legvalószínűbb jelölteket mutatja választásra. Kézi keresés is van név, szett és szám alapján; japán lapot angol névvel is lehet keresni.
6. **Mentés.** A lap TCGdex-kategóriája (Pokemon / Trainer / Energy) is eltárolódik. A Készletben típus szerint is lehet szűrni, a CSV-ben ez a `category` oszlop.

### Korlátok, főleg a japán lapoknál

- **A japán név OCR-je gyenge.** A stilizált, vastag katakana betűket a Tesseract gyakran félreolvassa. A japán felismerés ezért elsősorban a gyűjtői számra, a szett-összlapszámra és a képi egyezésre épül, a név csak kiegészítő jel.
- **Japán lapképek.** A TCGdex-ben az új japán szettekhez (pl. M6, M6a) nincs kép, ezért ezeket a Scrydex CDN-ről tölti (ez a pokemontcg.io képszervere). Ha ott sincs kép, a lapnál a saját szkennelt fotód jelenik meg.
- **Azonos rajzú lapok.** Az angol és a japán változat képe ugyanaz: pl. a 30th Celebration Mew ex, vagy a Delta Reign és a Storm Emeralda közös lapjai (Wimpod, Jangmo-o). Ha csak a kép döntene, az app választást kér, és nem ad hozzá magától rossz lapot. A nyelvválasztó (Auto / Angol / Japán) ilyenkor sokat segít.
- **Sima (nem teljes-art) lap csak képből.** Ha se a szám, se a név nem olvasható, a képi egyezés a kis illusztráció miatt gyengébb. Ilyenkor a helyes lap általában az első jelöltek között van, de az app nem adja hozzá magától.
- **Mire van szükség.** Jó fény, éles kép, a lap kitöltse a keretet. Csillogó fóliánál kerüld a tükröződést.
- **Időigény.**
  - Az első szkennelés lassabb: letölti az OCR-motort (kb. 15 MB).
  - Az első japán / teljes-art lapnál letölti a képi indexet. Ez Wi-Fi-n előre is megtehető a Beállításokban.
  - Utána egy lap 1–5 mp.
- **Régi lapok.** A régi (WOTC-kori) lapoknál a szám jobb alul van; ezt is próbálja, de kevésbé tesztelt.

## Készletem (a „Készlet” fül)

A fül tetején nagyban a teljes gyűjtemény értéke HUF-ban (ár × darab). Az ár nélküli lapok nem számítanak bele, de a fül kiírja, hány ilyen lap van. Alatta három fül:

- **Szettjeim** (ez az alapnézet): rács azokról a szettekről, amelyekből legalább 1 lapod van; az angol és a japán szett külön csempe.
  - Minden csempén: szettlogó, EN/JP jelzés, „megvan / összes” előrehaladás-sávval, és a szettből meglévő lapjaid értéke.
  - Rendezés: érték, komplettség, név vagy legutóbb szkennelt szerint.
  - **Logó:** a TCGdex `set.logo` mezőjéből, ha az nincs, a pokemontcg.io `images.logo` mezőjéből (csak angol szettekhez van). Ha egyik sem ad logót, például az összes japán szettnél, stílusos szöveges csempe jelenik meg, kitalált logó nincs.
  - **Offline:** a logókat és a lapképeket a Service Worker gyorsítótárazza, a pokemontcg.io szettlistáját az IndexedDB tárolja 7 napig.
- **Top 10:** a 10 legértékesebb lapod egységár szerint, képpel, szettel, darabszámmal, egységárral és összértékkel. Ha egy lapból több darab van, azt jelzi. Rákoppintva a lap adatlapja nyílik.
- **Lista:** a korábbi szűrhető, rendezhető lista.

### Szett-katalógus

Egy szett csempéjére (vagy a kezdőlapi szett-sorra) koppintva a szett teljes lapkínálata nyílik meg rácsban.
- **Sorrend:** gyűjtői szám szerint; a titkos ritkaságok és a nem számos (TG/GG) lapok a végén.
- **Megjelenés:** a hiányzó lap szürke és halvány (`grayscale(1)`, `opacity: .35`). A meglévő lap színes, arany kerettel, a jobb felső sarkában karikában a darabszám (az összes változat és állapot együtt, 1 darabnál is).
- **Fejléc:** szettlogó, „X / Y megvan · Z hiányzik”, teljes/hivatalos váltó, a meglévő lapok összértéke, és szűrő (mind / megvan / hiányzik).
- **Képek:** kis felbontású (`/low.webp`), lazy loaddal.
- **Koppintás:** meglévő lapnál az adatlap nyílik; hiányzó lapnál a ritkaság és a tájékoztató piaci ár jelenik meg (ha nincs: „nincs ár”).

### Árgrafikon (lap adatlapja)

Árat nem találunk ki. Két valós forrásból rajzol:
1. **Saját árelőzmény** (`priceHistory` IndexedDB-store). Pont kerül bele minden árfrissítéskor: szkenneléskor, „Ár frissítése” / „Árak frissítése” gombra, és naponta egyszer automatikusan, az app első megnyitásakor.
   - Egy pont tartalma: lapazonosító, változat, dátum, ár, pénznem, forrás, a rögzítéskori HUF-árfolyam.
   - Ugyanarra a napra és forrásra csak 1 pont kerül (a nap utolsó ára).
2. **Referencia:** a TCGdex Cardmarket-adat 1, 7 és 30 napos átlaga, valamint a trend. Ezek szaggatott, felcímkézett vonalak, nem napi árak.

A TCGplayer-ár a saját előzményben külön sorozat (kék vonal). Időszak: 7 / 30 / 90 nap / összes; pénznem: EUR, USD vagy HUF. HUF-ban a saját pontok a rögzítéskori, a referenciavonalak a mai árfolyammal vannak átszámolva. Amíg csak 1 napnyi pont van, a grafikon alatt „Még gyűlik az árelőzmény” látszik, és a referencia-átlagok jelennek meg. A grafikon saját SVG, külső könyvtár nélkül.

A `priceHistory` a JSON export/import része (a CSV-é nem). Importnál a pontok kulcs szerint felülíródnak, így nem duplikálódnak.

## Szett-komplettség

Szettenként látszik, hány különböző lap van meg, mennyi a szett, és mi hiányzik. Például: „2 / 141 teljes · 1 / 103 hivatalos · 139 hiányzik”.

**Két mód**, amit a kezdőlapon vagy a szett-lapon lehet váltani:
- **Teljes szett** (alapértelmezés): a TCGdex `cardCount.total` értéke, a titkos ritkaságokkal együtt.
- **Hivatalos szett**: az 1-től a lapon lévő „/103”-ig számozott lapok (`cardCount.official`). A titkos ritkaság (pl. 120/103) ebbe nem számít bele.

**Hol látszik:**
- a kezdőlapon a kiemelt szettek kártyáin (0 lapnál is) és a „Szettek: érték és komplettség” sorokban, előrehaladás-sávval;
- a Készlet nézetben, ha egy szettre szűrsz („Hiányzó lapok” gombbal);
- a szett-lapon, ami a szett sorára koppintva nyílik: „Hiányzik” és „Megvan” lista számmal, névvel, képpel, ritkasággal.

**Árak:** a hiányzó lapoknál a piaci ár csak tájékoztató. Nem számít bele a gyűjtemény értékébe, és ha a forrásnak nincs ára, „nincs ár” látszik.

**Adatok:** a szett laplistája a `getSet()` hívásból jön, és a telefon eltárolja.

**30th Celebration Classic Collection:** mindenhol külön szettként szerepel (`30th-c`, 30 lap). A „30th Celebration” kiemelt kártya csak a fő szettet (`30th`) mutatja.

## Árforrások (semmit nem becsül)

| Forrás | Mit ad | Megjegyzés |
|---|---|---|
| **TCGdex** (api.tcgdex.net) | EN + JA lapadat, Cardmarket-ár (EUR: trend → 30 napos átlag → átlag), TCGplayer-ár (USD: market → mid) | elsődleges, ingyenes, kulcs nélkül |
| **Pokémon TCG API** (pokemontcg.io) | angol tartalék: ár + kép, ha a TCGdex-ben nincs | ingyenes, néha lassú |
| **Frankfurter / EKB** (api.frankfurter.dev) | élő EUR→HUF, USD→HUF | tartalék: open.er-api.com; kézi árfolyam is megadható |

- Ha egyik forrásnak sincs ára: **„nincs ár”**. Az ilyen lap nem számít bele az összegbe, a főképernyő mutatja, hány ilyen lap van.
- A két forrás ára néha nagyon eltér; a Beállításokban választható, melyik az elsődleges.
- Az ár mindig a Near Mint piaci ár, állapot szerinti levonás nincs.

## „Melyik csomagban van?”

A `js/products.js` a webshop termékfájljaiból készül (`~/Desktop/webshop/pokemon`: products.txt, variants.txt, packs.json, japanese.txt). Újragenerálás:

```bash
python3 tools/build_products.py ~/Desktop/webshop/pokemon
```

Kiemelt szettek:
- angol Delta Reign (`me06`)
- angol 30th Celebration (`30th` + Classic Collection `30th-c`)
- japán 30th Celebration (`M6a`)
- japán Storm Emeralda (`M6`)

Más szettnél általános leírást ad (booster pakk / doboz / ETB). Promó lapnál jelzi, hogy nem pakkban van, titkos ritkaságnál (szám > összlap) pedig azt, hogy a pakkokban ritkán fordul elő.

## Felépítés (későbbi backendhez)

```
index.html, styles.css, manifest.webmanifest, sw.js, icons/
js/app.js         – felület
js/db.js          – tároló (IndexedDB) + szinkron-interfész (NoopSync)
js/api.js         – TCGdex / pokemontcg.io / árfolyam
js/recognize.js   – kivágás, OCR, szám-értelmezés, képi ujjlenyomat
js/imageindex.js  – szettenkénti képi index (IndexedDB)
js/identify.js    – jelöltpontozás + „biztos” döntés (UI-tól független, tesztelhető)
js/completeness.js – szett-komplettség számítása
js/catalog.js     – szettlogók, szett-katalógus rács (karika, szürke/színes), top 10
js/history.js     – árelőzmény-pontok, referencia-átlagok, SVG-árgrafikon
js/live.js        – élő szkenner: kamera, figyelő ciklus, stabilitás, zöld keret, szavazás, duplázásvédelem
js/detect-core.js – kártya-négyszög keresése, sarokpontosítás, perspektíva-korrekció (DOM nélkül)
js/detect-worker.js – a fenti Web Workerben (az élő kép és az animáció nem akad)
tools/serve.py, tools/headless-test.sh – fejlesztői szerver, fejnélküli tesztfuttatás
js/packinfo.js    – szett → bontatlan termékek
js/products.js    – generált termékadat
tests/            – mintafotók, tesztfuttató (harness.js), fotó nélküli tesztek (unit.js)
```

- Minden készlettétel kap egy globálisan egyedi `uid`-t és egy `updatedAt` időbélyeget.
- A változott tételek `dirty` jelzést kapnak, a törlés `deleted` jelzést („tombstone”) hagy.
- Egy felhős backend a `db.js`-ben lévő `push`/`pull` interfészt valósítja meg, a felületet nem kell hozzá módosítani.
- A JSON-export ugyanezt a sémát adja, ezzel tölthető fel később a webshop vagy a pakkbontó rendszer.
