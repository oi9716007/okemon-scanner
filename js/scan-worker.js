// Élő szkenner háttérszála: a kártya kivágása és az OCR nem a főszálon fut,
// így a kamerakép és a zöld szkennervonal közben is mozog.
import { recognize, warmUp } from './recognize.js';
import { warpCard } from './detect.js';

self.onmessage = async (e) => {
  const m = e.data || {};
  const reply = (data, transfer) => self.postMessage(Object.assign({ id: m.id }, data), transfer || []);
  try {
    if (m.type === 'warmup') {
      await warmUp(m.langs || ['eng']);
      reply({ type: 'warmup', ok: true });
      return;
    }
    if (m.type === 'recognize') {
      const bmp = m.bitmap;
      let card = bmp;
      if (m.quad?.points?.length === 4) {
        card = warpCard(bmp, m.quad, 900);
        bmp.close?.();
      }
      const r = await recognize(card, {
        fast: !!m.fast,
        normalized: true,
        lang: m.lang || 'auto',
        totals: m.totals,
        jaSetIds: m.jaSetIds || [],
      });
      let preview = null;
      try { preview = card.transferToImageBitmap(); } catch { /* a főszál a saját kivágását használja */ }
      reply({
        type: 'recognize',
        number: r.number || null,
        total: r.total || null,
        setCodes: r.setCodes || [],
        numberSure: !!r.numberSure,
        numberVotes: r.numberVotes || 0,
        numberHint: r.numberHint || '',
        name: r.name || '',
        ms: r.ms || 0,
        jobs: r.numberJobs || 0,
        fast: !!r.fast,
        print: r.print ? { bits: r.print.bits, col: r.print.col } : null,
        preview,
      }, preview ? [preview] : []);
      return;
    }
    reply({ type: 'error', message: 'ismeretlen üzenet' });
  } catch (err) {
    reply({ type: 'error', message: (err && (err.stack || err.message)) || String(err) });
  }
};
