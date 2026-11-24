/* Tonality — fil de calcul (Web Worker) pour Beat This! (temps et premiers temps par réseau de neurones).
   Beat This! : Foscarin, Schlüter, Widmer, ISMIR 2024, JKU Linz, licence MIT. Grand modèle final0 (ONNX, ReaBeat, MIT); petit modèle quantifié 8 bits en secours (kawaii-audio-visualizer, MIT).
   Le calcul se fait ici pour que la page (et le métronome) ne gèle jamais.
   Fonctionne en continu : l'audio arrive par morceaux (« segments » continus de la chanson); les tranches de 30 s
   déjà complètes sont gardées, seule la fin est recalculée. */
'use strict';
const SR = 22050, NFFT = 1024, HOP = 441, MELS = 128, FPS = SR / HOP, BINS = NFFT / 2 + 1, CHUNK = 1500, BORDER = 6, STRIDE = CHUNK - 2 * BORDER;
let M = null, loadP = null;

async function fetchBin(url, onProg, keep) {
  // gros fichiers : gardés dans le cache du navigateur (téléchargés une seule fois)
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
function load(base, onProg) {
  if (loadP) return loadP;
  loadP = (async () => {
    importScripts(base + 'vendor/ort/ort.wasm.min.js?v=1.17.1');
    const wasm = await fetchBin(base + 'vendor/ort/ort-wasm-simd.wasm.gz?v=1.17.1');
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    ort.env.wasm.numThreads = 1; ort.env.wasm.simd = true; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': wasmUrl, 'ort-wasm.wasm': wasmUrl };
    // grand modèle (final0, ≈ 75 Mo, le plus précis); petit modèle en secours si le grand ne peut pas être chargé
    const mq = /[?&]model=([^&]+)/.exec(self.location.search);
    const BIG = mq ? decodeURIComponent(mq[1]) : base + 'vendor/beatthis/beatthis_final0.onnx.gz?v=1', SMALL = base + 'vendor/beatthis/beatthis_small0_int8.onnx.gz';
    const fb = await fetchBin(base + 'vendor/beatthis/mel_fb.f32.gz');
    let session = null;
    try { const model = await fetchBin(BIG, onProg, true); session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] }); }
    catch (e) { console.warn('Tonality : grand modèle indisponible, petit modèle utilisé', e); session = await ort.InferenceSession.create(new Uint8Array(await fetchBin(SMALL)), { executionProviders: ['wasm'] }); }
    const F = new Float32Array(fb), bands = [];
    for (let m = 0; m < MELS; m++) { let k0 = -1, k1 = -1; for (let k = 0; k < BINS; k++) if (F[k * MELS + m] !== 0) { if (k0 < 0) k0 = k; k1 = k; } const w = new Float32Array(Math.max(0, k1 - k0 + 1)); if (k0 >= 0) for (let k = k0; k <= k1; k++) w[k - k0] = F[k * MELS + m]; bands.push({ k0: Math.max(0, k0), w }); }
    M = { session, bands, inName: session.inputNames[0], outB: session.outputNames.includes('beat') ? 'beat' : session.outputNames[0], outD: session.outputNames.includes('downbeat') ? 'downbeat' : session.outputNames[1] };
    return M;
  })();
  loadP.catch(() => { loadP = null; });
  return loadP;
}

/* ---------- rééchantillonnage continu vers 22 050 Hz (sinc fenêtré, table de phases) ---------- */
const HALF = 16, K = 2 * HALF, PH = 512;
const tabs = new Map();
function table(ratio) {
  if (tabs.has(ratio)) return tabs.get(ratio);
  const cutoff = Math.min(1, ratio), tab = new Float32Array(PH * K);
  for (let p = 0; p < PH; p++) {
    const frac = p / PH; let s = 0;
    for (let j = 0; j < K; j++) { const d = (j - HALF + 1) - frac, t = d * cutoff, sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t), wt = d / HALF, w = Math.abs(wt) > 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * wt) + 0.08 * Math.cos(2 * Math.PI * wt); tab[p * K + j] = sinc * w; s += sinc * w; }
    for (let j = 0; j < K; j++) tab[p * K + j] /= s;
  }
  tabs.set(ratio, tab); return tab;
}

/* ---------- segments ---------- */
// seg : { sr, raw (Float32Array, tampon des derniers échantillons bruts), rawStart (index du 1er échantillon de raw),
//         rawLen (total reçu), outLen (échantillons 22 kHz produits), wav (Float32Array 22 kHz, extensible),
//         melDone (images mel calculées), mel (Float32Array extensible), act: {beat, down} (Float32Array extensibles), winDone }
const segs = new Map();
function grow(a, n) { if (a.length >= n) return a; const b = new Float32Array(Math.max(n, a.length * 2)); b.set(a); return b; }
function newSeg(sr) { return { sr, raw: new Float32Array(0), rawStart: 0, rawLen: 0, outLen: 0, wav: new Float32Array(SR * 60), melDone: 0, mel: new Float32Array(3000 * MELS), beat: new Float32Array(3000), down: new Float32Array(3000), winDone: 0 }; }
function append(s, x) {
  // ajoute les échantillons bruts, puis produit les échantillons 22 kHz dont le noyau est complet
  const keep = s.raw.subarray(Math.max(0, s.raw.length - 4 * K));
  const keepStart = s.rawStart + (s.raw.length - keep.length);
  const raw = new Float32Array(keep.length + x.length); raw.set(keep); raw.set(x, keep.length);
  s.raw = raw; s.rawStart = keepStart; s.rawLen += x.length;
  produce(s, false);
}
function produce(s, final) {
  if (s.sr === SR) { const n = s.rawLen - s.outLen; s.wav = grow(s.wav, s.rawLen); s.wav.set(s.raw.subarray(s.raw.length - n), s.outLen); s.outLen = s.rawLen; return; }
  const ratio = SR / s.sr, tab = table(ratio);
  const maxOut = Math.floor(s.rawLen * ratio);
  s.wav = grow(s.wav, maxOut + 1);
  for (let i = s.outLen; i < maxOut; i++) {
    const pos = i / ratio, i0 = Math.floor(pos);
    if (!final && i0 + HALF >= s.rawLen) break;
    const p = Math.min(PH - 1, Math.round((pos - i0) * PH)), base = i0 - HALF + 1; let acc = 0;
    for (let j = 0; j < K; j++) { const k = base + j - s.rawStart; if (k >= 0 && k < s.raw.length) acc += tab[p * K + j] * s.raw[k]; }
    s.wav[i] = acc; s.outLen = i + 1;
  }
}

/* ---------- spectrogramme log-mel ---------- */
const hann = new Float32Array(NFFT); for (let i = 0; i < NFFT; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
const rev = new Uint32Array(NFFT); for (let i = 0; i < NFFT; i++) { let r = 0, x = i; for (let b = 0; b < 10; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
const cs = new Float64Array(NFFT / 2), sn = new Float64Array(NFFT / 2); for (let i = 0; i < NFFT / 2; i++) { cs[i] = Math.cos(-2 * Math.PI * i / NFFT); sn[i] = Math.sin(-2 * Math.PI * i / NFFT); }
const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mag = new Float64Array(BINS), frame = new Float32Array(NFFT);
// échantillon j du signal « centré » (réflexion aux deux bouts, comme torch.stft center=True)
function sample(s, j, final) {
  const n = s.outLen;
  if (j < 0) j = -j;
  if (j >= n) { if (!final) return null; j = 2 * (n - 1) - j; }
  return s.wav[Math.max(0, j)];
}
function melFrames(s, final) {
  const P = NFFT >> 1, n = s.outLen;
  const last = final ? Math.floor(n / HOP) : Math.floor((n - P) / HOP); // dernière image calculable
  s.mel = grow(s.mel, (last + 1) * MELS);
  for (let f = s.melDone; f <= last; f++) {
    const c = f * HOP - P;
    let ok = true; for (let i = 0; i < NFFT; i++) { const v = sample(s, c + i, final); if (v === null) { ok = false; break; } frame[i] = v; }
    if (!ok) break;
    for (let i = 0; i < NFFT; i++) { re[rev[i]] = frame[i] * hann[i]; im[rev[i]] = 0; }
    for (let len = 2; len <= NFFT; len <<= 1) { const h = len >> 1, st = NFFT / len; for (let i = 0; i < NFFT; i += len) for (let k = 0, ix = 0; k < h; k++, ix += st) { const a = i + k, b = a + h, wr = cs[ix], wi = sn[ix], xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; } }
    for (let k = 0; k < BINS; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / 32;
    const bands = M.bands;
    for (let m = 0; m < MELS; m++) { const { k0, w } = bands[m]; let acc = 0; for (let j = 0; j < w.length; j++) acc += mag[k0 + j] * w[j]; s.mel[f * MELS + m] = Math.log1p(1000 * acc); }
    s.melDone = f + 1;
  }
}

/* ---------- inférence par tranches de 30 s ---------- */
const buf = new Float32Array(CHUNK * MELS);
async function runWindow(s, w) {
  const start = -BORDER + w * STRIDE, frames = s.melDone;
  buf.fill(0);
  for (let i = 0; i < CHUNK; i++) { const t = start + i; if (t >= 0 && t < frames) buf.set(s.mel.subarray(t * MELS, t * MELS + MELS), i * MELS); }
  const out = await M.session.run({ [M.inName]: new ort.Tensor('float32', buf, [1, CHUNK, MELS]) });
  const b = out[M.outB].data, d = out[M.outD].data;
  s.beat = grow(s.beat, frames); s.down = grow(s.down, frames);
  for (let i = BORDER; i < CHUNK - BORDER; i++) { const t = start + i; if (t >= 0 && t < frames) { s.beat[t] = b[i]; s.down[t] = d[i]; } }
}
async function process(s, final, onProg) {
  produce(s, final); melFrames(s, final);
  const frames = s.melDone;
  // tranches complètes (gardées une fois calculées)
  const total = Math.ceil(frames / STRIDE);
  while (-BORDER + s.winDone * STRIDE + CHUNK <= frames) { await runWindow(s, s.winDone); s.winDone++; onProg && onProg(s.winDone / Math.max(1, total)); }
  // fin incomplète : calculée provisoirement (refaite quand plus d'audio arrive)
  if (-BORDER + s.winDone * STRIDE < frames - BORDER) await runWindow(s, s.winDone);
  onProg && onProg(1);
}

/* ---------- post-traitement de Beat This! : pics > 0,5 sur ±70 ms; premier temps calé sur le temps le plus proche ---------- */
function peaks(a, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (a[i] <= 0) continue;
    let mx = -Infinity; for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (a[j] > mx) mx = a[j];
    if (a[i] === mx) out.push(i);
  }
  const ded = []; for (const p of out) { const L = ded[ded.length - 1]; if (L && p - L.last <= 1) { L.sum += p; L.n++; L.last = p; } else ded.push({ sum: p, n: 1, last: p }); }
  // précision sous-image : parabole sur les logits autour du pic
  return ded.map(x => { const c = Math.round(x.sum / x.n); const l = a[c - 1], m = a[c], r = a[c + 1]; let d = 0; if (c > 0 && c < n - 1) { const den = l - 2 * m + r; if (den < 0) d = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den)); } return (x.n > 1 ? x.sum / x.n : c + d) / FPS; });
}
function result(s) {
  const n = s.melDone, beats = peaks(s.beat, n), d0 = peaks(s.down, n), downs = [];
  for (const d of d0) { let best = null, bd = Infinity; for (const b of beats) { const e = Math.abs(b - d); if (e < bd) { bd = e; best = b; } } if (best != null && bd < 0.1 && downs[downs.length - 1] !== best) downs.push(best); }
  return { beats, downs, seconds: s.outLen / SR };
}

/* ---------- messages ---------- */
let queue = Promise.resolve();
onmessage = e => {
  const m = e.data;
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') { await load(m.base, p => postMessage({ id: m.id, progress: p, dl: true })); postMessage({ id: m.id, ok: true }); return; }
      if (m.type === 'reset') { segs.clear(); postMessage({ id: m.id, ok: true }); return; }
      if (m.type === 'append') { let s = segs.get(m.seg); if (!s) { s = newSeg(m.sr); segs.set(m.seg, s); } append(s, m.samples); postMessage({ id: m.id, ok: true }); return; }
      if (m.type === 'analyze') {
        await load(m.base, p => postMessage({ id: m.id, progress: p, dl: true }));
        const out = {};
        for (const [k, s] of segs) {
          if (m.only != null && k !== m.only) continue;
          await process(s, !!m.final, p => postMessage({ id: m.id, progress: p, seg: k }));
          out[k] = result(s);
        }
        postMessage({ id: m.id, ok: true, segs: out });
        return;
      }
    } catch (err) { postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
  });
};
