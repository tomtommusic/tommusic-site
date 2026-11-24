/* Tonality — client du fil de calcul Beat This! (temps et premiers temps par réseau de neurones).
   Beat This! : Foscarin, Schlüter, Widmer, ISMIR 2024, JKU Linz, licence MIT. Voir beatml-worker.js.
   Rien n'est téléchargé tant qu'on n'en a pas besoin (≈ 75 Mo la première fois, ensuite gardé dans le cache du navigateur). */
(function (root) {
  'use strict';
  const HERE = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') : '';
  const supported = () => typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof DecompressionStream !== 'undefined';
  function create(opts) {
    const w = new Worker(HERE + 'beatml-worker.js?v=3' + (opts && opts.model ? '&model=' + encodeURIComponent(opts.model) : ''));
    let seq = 0; const pend = new Map();
    w.onmessage = e => {
      const m = e.data, p = pend.get(m.id); if (!p) return;
      if (m.progress != null) { if (m.dl) { p.onDl ? p.onDl(m.progress) : (root.BeatML.onDownload && root.BeatML.onDownload(m.progress)); } else p.onProg && p.onProg(m.progress, m.seg); return; }
      pend.delete(m.id); m.ok ? p.res(m) : p.rej(new Error(m.error || 'beatml'));
    };
    w.onerror = () => { for (const p of pend.values()) p.rej(new Error('worker')); pend.clear(); };
    const call = (msg, onProg, transfer) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej, onProg, onDl: msg.type === 'load' ? onProg : null }); w.postMessage(Object.assign({ id, base: HERE }, msg), transfer || []); });
    return {
      load: onDl => call({ type: 'load' }, onDl),
      reset: () => call({ type: 'reset' }),
      append: (seg, samples, sr) => { const c = new Float32Array(samples); return call({ type: 'append', seg, samples: c, sr }, null, [c.buffer]); },
      analyze: (opts, onProg) => call({ type: 'analyze', final: !!(opts && opts.final), only: opts && opts.only != null ? opts.only : null }, onProg).then(m => m.segs),
      terminate: () => { w.terminate(); for (const p of pend.values()) p.rej(new Error('terminated')); pend.clear(); }
    };
  }
  // Analyse d'un fichier complet (audio mono, fréquence quelconque)
  async function analyzeBuffer(client, mono, sr, onProg) {
    await client.reset();
    for (let i = 0; i < mono.length; i += 1 << 20) await client.append(0, mono.subarray(i, i + (1 << 20)), sr);
    const segs = await client.analyze({ final: true }, onProg);
    return segs[0];
  }
  root.BeatML = { supported, create, analyzeBuffer };
})(window);
