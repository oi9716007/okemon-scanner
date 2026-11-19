# A webshop/pokemon termékfájljaiból (products.txt, variants.txt, packs.json, japanese.txt)
# legenerálja a js/products.js-t: szettnév/szettkód -> bontatlan termékek (pakk/termék).
import json, os, re, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Desktop/webshop/pokemon')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'js', 'products.js')
PFX = 'https://cdn.shopify.com/s/files/1/0716/4254/6435/files/'
packs = json.load(open(os.path.join(SRC, 'packs.json')))
# angol szettek (TCGdex-név szerint) – csak ismert, élő szettnevek
EN_SETS = ['Delta Reign', '30th Celebration', 'Pitch Black', 'Ascended Heroes', 'Perfect Order', 'Chaos Rising',
           'Phantasmal Flames', 'Mega Evolution', 'Destined Rivals', 'Journey Together', 'Prismatic Evolutions',
           'Surging Sparks', 'Stellar Crown', 'Shrouded Fable', 'Twilight Masquerade', 'Temporal Forces',
           'Paldean Fates', 'Paradox Rift', '151', 'Obsidian Flames', 'Paldea Evolved', 'Black Bolt', 'White Flare']
def kind(t):
    t = t.lower()
    for k, v in [('elite trainer', 'Elite Trainer Box'), ('booster bundle', 'Booster bundle'), ('booster box', 'Booster doboz'),
                 ('booster pack', 'Booster pakk'), ('blister', 'Blister'), ('tin', 'Tin doboz'), ('build and battle', 'Build & Battle doboz'),
                 ('premium collection', 'Prémium kollekció'), ('collection', 'Kollekció'), ('battle deck', 'Battle deck'), ('box', 'Doboz')]:
        if k in t: return v
    return 'Termék'
en = {}
variants = {}
cur = None
for line in open(os.path.join(SRC, 'variants.txt')):
    if not line.strip(): continue
    if not line.startswith(' '): cur = line.strip(); variants[cur] = []; continue
    variants[cur].append(line.strip().split('|'))
for line in open(os.path.join(SRC, 'products.txt')):
    f = line.rstrip('\n').split('|')
    if len(f) < 5: continue
    title, h, img = f[0], f[1], f[4]
    for s in EN_SETS:
        if title.lower().startswith(s.lower() + ' '):
            vs = variants.get(h)
            items = [(title.replace('Pokemon Trading Card Game', '').replace('Pokemon Trading Card Gam', '').strip() + (' – ' + v[0] if vs and len(vs) > 1 else ''), v[3] if len(v) > 3 else img) for v in vs] if vs and len(vs) > 1 else [(title.replace('Pokemon Trading Card Game', '').replace('Pokemon Trading Card Gam', '').strip(), img)]
            for t, im in items:
                p = packs.get(h)
                if 'Booster Pack' in t and '– Booster Pack' in t: p = 1
                if '– Booster Box' in t: p = 36
                if 'Battle Deck' in t: p = 0
                en.setdefault(s.lower(), []).append({'t': t, 'k': kind(t.split('–')[-1] if '–' in t else t), 'p': p, 'i': PFX + im if im else ''})
            break
# japán szettek: név -> TCGdex ja id (a webshop/pokemon/jptop.py listája)
IDS = {'30th Celebration':'M6a','Storm Emeralda':'M6','Abyss Eye':'M5','Ninja Spinner':'M4','Nullifying Zero':'M3','Mega Dream ex':'M2a','Inferno X':'M2','Mega Symphonia':'M1S','Mega Brave':'M1L','White Flare':'SV11W','Black Bolt':'SV11B','Glory of Team Rocket':'SV10','Heat Wave Arena':'SV9a','Battle Partners':'SV9','Terastal Festival':'SV8a','Super Electric Breaker':'SV8','Paradise Dragona':'SV7a','Stellar Miracle':'SV7','Night Wanderer':'SV6a','Crimson Haze':'SV5a','Mask of Change':'SV6','Wild Force':'SV5K','Cyber Judge':'SV5M','Shiny Treasure ex':'SV4a','Ancient Roar':'SV4K','Future Flash':'SV4M','Raging Surf':'SV3a','Pokémon 151':'SV2a','Ruler of the Black Flame':'SV3','Clay Burst':'SV2D','Snow Hazard':'SV2P','Triplet Beat':'SV1a','Scarlet ex':'SV1S','Violet ex':'SV1V','VSTAR Universe':'S12a','Paradigm Trigger':'S12','VMAX Climax':'S8b','Star Birth':'S9','Shiny Star V':'S4a'}
jp, jpnames = {}, {}
cur = None
for line in open(os.path.join(SRC, 'japanese.txt')):
    if line.startswith('#') or not line.strip(): continue
    if not line.startswith(' '):
        h, nm, cpp, ppb = line.strip().split('|'); cur = (nm, int(cpp), int(ppb)); continue
    vn, vp, va, vi = line.strip().split('|')[:4]
    nm, cpp, ppb = cur
    sid = IDS.get(nm)
    if not sid: continue
    jpnames[sid] = nm
    t = nm + ' ' + vn
    item = {'t': t, 'k': kind(vn), 'i': PFX + vi}
    if 'Booster Pack' in vn: item['c'] = cpp; item['p'] = 1
    elif 'Booster Box' in vn: item['c'] = cpp; item['p'] = ppb
    if not any(x['t'] == t for x in jp.get(sid, [])): jp.setdefault(sid, []).append(item)
js = ('// AUTOMATIKUSAN GENERÁLT – tools/build_products.py (forrás: webshop/pokemon termékfájlok)\n'
      '// p = pakkok száma a termékben, c = lap/pakk. Csak a bolt valós termékei szerepelnek.\n'
      'export const EN_PRODUCTS = ' + json.dumps(en, ensure_ascii=False) + ';\n'
      'export const JP_PRODUCTS = ' + json.dumps(jp, ensure_ascii=False) + ';\n'
      'export const JP_SET_EN_NAMES = ' + json.dumps(jpnames, ensure_ascii=False) + ';\n')
open(OUT, 'w').write(js)
print('EN sets:', {k: len(v) for k, v in en.items()}); print('JP sets:', len(jp))
