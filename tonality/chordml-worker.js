/* Tonality — reconnaissance d'accords par réseau de neurones (ChordMini « ChordNet 2E1D », MIT), dans un fil de calcul.
   Entrée : audio mono à 22 050 Hz. Sortie : logits par trame (≈ 0,093 s) sur 170 accords.
   La transformée à Q constant (CQT) reproduit celle de librosa 0.11 grâce au plan publié avec le modèle
   (filtres creux par octave, demi-bandes successives) — même méthode que musetric (packages/cqt, MIT). */
'use strict';
let loadP = null, M = null;
const SEQ = 108, BINS = 144, NCH = 170;

async function fetchBin(url, onProg, keep) {
  let cache = null, r = null;
  if (keep && self.caches) { try { cache = await caches.open('tonality-models-v1'); r = await cache.match(url); } catch (e) { cache = null; } }
  const cached = !!r;
  if (!r) r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  let buf;
  const total = +r.headers.get('content-length') || 0;
  if (onProg && !cached && total && r.body) {
    const rd = r.body.getReader(), parts = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onProg(Math.min(1, got / total)); }
    const all = new Uint8Array(got); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } buf = all.buffer;
  } else buf = await r.arrayBuffer();
  if (cache && !cached) { try { await cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { } }
  const b = new Uint8Array(buf);
  if (/\.gz(\?|$)/.test(url) && b[0] === 0x1f && b[1] === 0x8b) return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return buf;
}

/* ---------- plan de la CQT (format musetric « MCQT ») ---------- */
function decodePlan(ab) {
  const bytes = new Uint8Array(ab.slice(0)), d = new DataView(bytes.buffer);
  if (d.getUint32(0, true) !== 0x5451434d) throw new Error('plan CQT invalide');
  const nBins = d.getUint32(28, true), early = d.getUint32(36, true), octN = d.getUint32(48, true), taps = d.getUint32(52, true), coefN = d.getUint32(56, true);
  const octOff = d.getUint32(72, true), rowOff = d.getUint32(76, true), binOff = d.getUint32(80, true), coefOff = d.getUint32(84, true), dsOff = d.getUint32(92, true);
  const octaves = [];
  for (let i = 0; i < octN; i++) { const b = octOff + i * 32; octaves.push({ index: d.getUint32(b, true), hop: d.getUint32(b + 12, true), fft: d.getUint32(b + 16, true), binStart: d.getUint32(b + 20, true), binCount: d.getUint32(b + 24, true) }); }
  return {
    nBins, early, octaves, taps, delay: (taps - 1) / 2,
    rows: new Uint32Array(bytes.buffer, rowOff, nBins + 1), fftBins: new Uint32Array(bytes.buffer, binOff, coefN),
    coefs: new Float32Array(bytes.buffer, coefOff, coefN * 2), half: new Float32Array(bytes.buffer, dsOff, (taps + 1) / 2)
  };
}
// demi-bande : filtre de Kaiser symétrique (255 coefficients), gain √2, bord à zéro, longueur ⌈n/2⌉
function halve(x, P) {
  const n = x.length, m = Math.ceil(n / 2), y = new Float32Array(m), h = P.half, D = P.delay, T = P.taps, g = Math.SQRT2;
  for (let o = 0; o < m; o++) {
    const c = 2 * o; let v = 0;
    const t0 = Math.max(0, D - c), t1 = Math.min(T, n - c + D);
    for (let t = t0; t < t1; t++) v += x[c + t - D] * h[t > D ? t - D : D - t];
    y[o] = v * g;
  }
  return y;
}
// FFT réelle (radix 2) → spectre complexe 0..N/2
const FFTC = {};
function fftPlan(n) {
  if (FFTC[n]) return FFTC[n];
  const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  return (FFTC[n] = { n, rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) });
}
function fft(F) {
  const { n, cos, sin, re, im } = F;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
      const a = i + j, b = a + half, c = cos[k], s = sin[k];
      const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
// CQT : log(|X| + 1e-6), [trames × 144]
function cqt(y, P) {
  const levels = []; let cur = y;
  for (let i = 0; i < P.early; i++) cur = halve(cur, P);
  const maxOct = Math.max(...P.octaves.map(o => o.index));
  for (let i = 0; i <= maxOct; i++) { levels.push(cur); if (i < maxOct) cur = halve(cur, P); }
  let frames = Infinity;
  for (const o of P.octaves) frames = Math.min(frames, 1 + Math.floor(levels[o.index].length / o.hop));
  const out = new Float32Array(frames * P.nBins);
  for (const o of P.octaves) {
    const x = levels[o.index], F = fftPlan(o.fft), N = o.fft, { rev, re, im } = F;
    for (let f = 0; f < frames; f++) {
      const st = f * o.hop - N / 2;
      for (let i = 0; i < N; i++) { const j = st + i; re[rev[i]] = j >= 0 && j < x.length ? x[j] : 0; im[rev[i]] = 0; }
      fft(F);
      for (let b = o.binStart; b < o.binStart + o.binCount; b++) {
        let sr = 0, si = 0;
        for (let c = P.rows[b]; c < P.rows[b + 1]; c++) { const k = P.fftBins[c], cr = P.coefs[2 * c], ci = P.coefs[2 * c + 1], xr = re[k], xi = im[k]; sr += cr * xr - ci * xi; si += cr * xi + ci * xr; }
        out[f * P.nBins + b] = Math.log(Math.sqrt(sr * sr + si * si) + 1e-6);
      }
    }
  }
  return { frames, data: out };
}

function load(base, onProg) {
  if (loadP) return loadP;
  loadP = (async () => {
    importScripts(base + 'vendor/ort/ort.wasm.min.js?v=1.17.1');
    const wasm = await fetchBin(base + 'vendor/ort/ort-wasm-simd.wasm.gz?v=1.17.1');
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    ort.env.wasm.numThreads = 1; ort.env.wasm.simd = true; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': wasmUrl, 'ort-wasm.wasm': wasmUrl };
    const [model, plan, cfg] = await Promise.all([fetchBin(base + 'vendor/chordmini/chordnet.onnx.gz?v=1', onProg, true), fetchBin(base + 'vendor/chordmini/cqt-plan.bin?v=1'), fetch(base + 'vendor/chordmini/config.json?v=1').then(r => r.json())]);
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    M = { session, plan: decodePlan(plan), vocab: cfg.chordVocab, frame: cfg.frameDuration };
    return M;
  })();
  loadP.catch(() => { loadP = null; });
  return loadP;
}
async function analyze(y, onProg) {
  const { session, plan } = M;
  const C = cqt(y, plan), T = C.frames, W = Math.max(1, Math.ceil(T / SEQ)), out = new Float32Array(T * NCH);
  const G = 4;   // fenêtres par passage
  for (let w0 = 0; w0 < W; w0 += G) {
    const n = Math.min(G, W - w0), x = new Float32Array(n * SEQ * BINS);
    x.set(C.data.subarray(w0 * SEQ * BINS, Math.min(T, (w0 + n) * SEQ) * BINS));
    const r = await session.run({ features: new ort.Tensor('float32', x, [n, SEQ, BINS]) });
    const lg = r.logits.data, keep = Math.min(n * SEQ, T - w0 * SEQ);
    out.set(lg.subarray(0, keep * NCH), w0 * SEQ * NCH);
    onProg && onProg(Math.min(1, (w0 + n) / W));
  }
  return { frames: T, logits: out, frame: M.frame, vocab: M.vocab };
}
let queue = Promise.resolve();
onmessage = e => {
  const m = e.data;
  queue = queue.then(async () => {
    try {
      await load(m.base, p => postMessage({ id: m.id, progress: p, dl: true }));
      if (m.type === 'load') { postMessage({ id: m.id, ok: true }); return; }
      if (m.type === 'cqt') { const c = cqt(m.y, M.plan); postMessage({ id: m.id, ok: true, result: c }, [c.data.buffer]); return; }
      const r = await analyze(m.y, p => postMessage({ id: m.id, progress: p }));
      postMessage({ id: m.id, ok: true, result: r }, [r.logits.buffer]);
    } catch (err) { postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
  });
};
