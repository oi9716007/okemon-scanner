// Web Worker: kártyakeresés és perspektíva-korrekció a fő szálon kívül (az élő kép és az animáció ne akadjon).
// Üzenetek: { id, type: 'detect', w, h, buf } → { id, res }
//           { id, type: 'warp', w, h, buf, quad (0..1), outW, outH } → { id, buf } (RGBA, átadva)
import { detectQuad, warpPerspective } from './detect-core.js';

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'detect') {
      const res = detectQuad(new Uint8ClampedArray(m.buf), m.w, m.h);
      self.postMessage({ id: m.id, res: res ? { quad: res.quad, area: res.area, ratio: res.ratio, sharp: res.sharp } : null });
    } else if (m.type === 'warp') {
      const quadPx = m.quad.map(p => ({ x: p.x * m.w, y: p.y * m.h }));
      const out = warpPerspective(new Uint8ClampedArray(m.buf), m.w, m.h, quadPx, m.outW, m.outH);
      self.postMessage({ id: m.id, buf: out.buffer }, [out.buffer]);
    }
  } catch (err) { self.postMessage({ id: m.id, error: String(err && err.message || err) }); }
};
