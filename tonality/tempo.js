/* Tonality — moteur de tempo : BPM, position de chaque temps et premier temps de la mesure.
   Fonctionne en continu (comme le moteur de tonalité) : on lui donne l'audio au fur et à mesure avec le moment
   de la chanson correspondant. Méthode : enveloppe d'attaques (flux spectral), autocorrélation pondérée pour le tempo,
   programmation dynamique (Ellis 2007) pour placer chaque temps, basses fréquences pour le premier temps.
   JavaScript pur, sans DOM : tourne dans le navigateur et dans Node pour les tests. */
(function (root) {
  'use strict';
  const FPS = 100; // résolution de la grille d'analyse (images par seconde de chanson)

  function makeFFT(n) {
    const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), win = new Float64Array(n);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n), im = new Float64Array(n);
    return function (x, out) {
      for (let i = 0; i < n; i++) { re[rev[i]] = x[i] * win[i]; im[rev[i]] = 0; }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, c = cos[k], s = sin[k];
          const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      for (let k = 0; k <= n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      return out;
    };
  }

  class Tracker {
    constructor(sr) {
      this.sr = sr;
      this.N = 1 << Math.round(Math.log2(sr * 0.046)); // ≈ 2048 à 44-48 kHz
      this.hop = this.N >> 2;                            // ≈ 11 ms
      this.fft = makeFFT(this.N);
      this.mag = new Float64Array(this.N / 2 + 1);
      this.prev = null;
      this.buf = new Float32Array(this.N * 4); this.bn = 0;
      this.times = [];
      this.frames = []; // {t, v (attaques, tout le spectre), lo (attaques graves)}
      this.kLo = Math.max(1, Math.round(30 * this.N / sr)); this.kHi = Math.round(8000 * this.N / sr);
      this.kBass = Math.round(180 * this.N / sr);
      // correspondance case FFT → classe de hauteur (100 Hz à 2 kHz), pour repérer les changements d'accord
      this.pc = new Int8Array(this.N / 2 + 1).fill(-1);
      for (let k = 1; k <= this.N / 2; k++) { const f = k * sr / this.N; if (f >= 100 && f <= 2000) this.pc[k] = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12; }
      this.heard = 0;
    }
    push(samples, t, rate) {
      rate = rate || 1;
      let off = 0;
      while (off < samples.length) {
        const n = Math.min(samples.length - off, this.buf.length - this.bn);
        this.times.push({ i: this.bn, t: t + off / this.sr * rate, rate });
        this.buf.set(samples.subarray(off, off + n), this.bn); this.bn += n; off += n;
        while (this.bn >= this.N) this._frame();
      }
      this.heard += samples.length / this.sr * rate;
    }
    _timeAt(i) {
      let s = this.times[0];
      for (const x of this.times) { if (x.i <= i) s = x; else break; }
      return s.t + (i - s.i) / this.sr * s.rate;
    }
    _frame() {
      const N = this.N, m = this.fft(this.buf.subarray(0, N), this.mag);
      const cur = new Float32Array(this.kHi + 1);
      for (let k = this.kLo; k <= this.kHi; k++) cur[k] = Math.log1p(1000 * m[k] / N);
      let v = 0, lo = 0;
      if (this.prev) for (let k = this.kLo; k <= this.kHi; k++) { const d = cur[k] - this.prev[k]; if (d > 0) { v += d; if (k <= this.kBass) lo += d; } }
      const t = this._timeAt(N / 2);
      // un saut dans le temps (retour en arrière, saut avant) : pas de flux entre deux moments éloignés
      const last = this.frames[this.frames.length - 1];
      if (last && Math.abs(t - last.t) > 0.25) { v = 0; lo = 0; }
      const ch = new Float32Array(12);
      for (let k = 1; k < this.pc.length; k++) if (this.pc[k] >= 0) ch[this.pc[k]] += m[k];
      this.frames.push({ t, v, lo, ch });
      this.prev = cur;
      const h = this.hop;
      this.buf.copyWithin(0, h, this.bn); this.bn -= h;
      this.times = this.times.map(x => ({ i: x.i - h, t: x.t, rate: x.rate }));
      let k = 0; while (k + 1 < this.times.length && this.times[k + 1].i <= 0) k++;
      const first = this.times[k]; this.times = this.times.slice(k);
      if (first.i < 0) this.times[0] = { i: 0, t: first.t - first.i / this.sr * first.rate, rate: first.rate };
    }
    analyze(opts) { return analyzeFrames(this.frames, opts); }
  }

  /* ---------- analyse ---------- */
  function analyzeFrames(frames, opts) {
    opts = Object.assign({ prefBpm: 120, octaveWidth: 1.0, tightness: 100, minBpm: 40, maxBpm: 220 }, opts || {});
    if (frames.length < 300) return null; // au moins ~3 s
    // 1) grille régulière en temps de chanson (100 images/s); trous = non entendus
    let t0 = Infinity, t1 = -Infinity;
    for (const f of frames) { if (f.t < t0) t0 = f.t; if (f.t > t1) t1 = f.t; }
    const start = Math.floor(t0 * FPS), L = Math.ceil(t1 * FPS) - start + 1;
    const env = new Float64Array(L), low = new Float64Array(L), cnt = new Float64Array(L), chg = new Array(L);
    for (const f of frames) { const i = Math.round(f.t * FPS) - start; if (i >= 0 && i < L) { env[i] += f.v; low[i] += f.lo; cnt[i]++; if (f.ch) { if (!chg[i]) chg[i] = new Float64Array(12); for (let q = 0; q < 12; q++) chg[i][q] += f.ch[q]; } } }
    const has = new Uint8Array(L);
    for (let i = 0; i < L; i++) if (cnt[i]) { env[i] /= cnt[i]; low[i] /= cnt[i]; has[i] = 1; }
    // combler les petits trous (moins de 3 images) par interpolation; les grands trous restent des coupures
    for (let i = 1; i < L - 1; i++) if (!has[i]) {
      let j = i; while (j < L && !has[j]) j++;
      if (j - i <= 3 && i > 0 && j < L) { for (let q = i; q < j; q++) { const a = (q - i + 1) / (j - i + 1); env[q] = env[i - 1] * (1 - a) + env[j] * a; low[q] = low[i - 1] * (1 - a) + low[j] * a; has[q] = 1; } }
      i = j;
    }
    // 2) enveloppe normalisée : retrait de la moyenne locale (~1 s), écart-type 1
    const o = new Float64Array(L), W = 50;
    let s = 0, c = 0; const pre = new Float64Array(L + 1), pc = new Float64Array(L + 1);
    for (let i = 0; i < L; i++) { pre[i + 1] = pre[i] + (has[i] ? env[i] : 0); pc[i + 1] = pc[i] + has[i]; }
    for (let i = 0; i < L; i++) {
      if (!has[i]) continue;
      const a = Math.max(0, i - W), b = Math.min(L, i + W + 1), n = pc[b] - pc[a];
      o[i] = env[i] - (n ? (pre[b] - pre[a]) / n : 0);
    }
    for (let i = 0; i < L; i++) if (has[i]) { s += o[i] * o[i]; c++; }
    const sd = Math.sqrt(s / Math.max(1, c)) || 1;
    for (let i = 0; i < L; i++) o[i] = has[i] ? Math.max(-1, o[i] / sd) : 0;
    // 3) tempo : autocorrélation pondérée autour du tempo préféré (sur une échelle logarithmique)
    const lagMin = Math.floor(60 * FPS / opts.maxBpm), lagMax = Math.ceil(60 * FPS / opts.minBpm);
    const xcr = new Float64Array(3 * lagMax + 3);
    const span = Math.min(L, 60 * FPS * 4); // au plus 4 minutes pour le calcul
    for (let lag = 1; lag < xcr.length; lag++) {
      let v = 0; for (let i = lag; i < span; i++) v += o[i] * o[i - lag];
      xcr[lag] = v;
    }
    const tau0 = 60 * FPS / opts.prefBpm;
    let best = -Infinity, bl = lagMin;
    const score = [];
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const w = Math.exp(-0.5 * Math.pow(Math.log2(lag / tau0) / opts.octaveWidth, 2));
      const x2 = xcr[2 * lag] + 0.5 * (xcr[2 * lag - 1] + xcr[2 * lag + 1]), x3 = xcr[3 * lag] + 0.5 * (xcr[3 * lag - 1] + xcr[3 * lag + 1]);
      const v = w * (xcr[lag] + 0.5 * Math.max(x2, x3));
      score.push(v);
      if (v > best) { best = v; bl = lag; }
    }
    // précision sous-image (parabole)
    let period = bl;
    { const a = xcr[bl - 1], b = xcr[bl], cc = xcr[bl + 1], d = a - 2 * b + cc; if (d < 0) period = bl + Math.max(-0.5, Math.min(0.5, 0.5 * (a - cc) / d)); }
    // confiance : pic de l'autocorrélation comparé au bruit de fond
    const sorted = score.slice().sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)];
    const conf = Math.max(0, Math.min(1, (best - med) / (Math.abs(best) + 1e-9)));
    // 4) placement des temps par programmation dynamique, segment entendu par segment entendu
    const P = period, sig = P / 32, gw = Math.ceil(3 * sig), g = [];
    for (let k = -gw; k <= gw; k++) g.push(Math.exp(-0.5 * (k / sig) ** 2));
    const loc = new Float64Array(L);
    for (let i = 0; i < L; i++) { let v = 0; for (let k = -gw; k <= gw; k++) { const j = i + k; if (j >= 0 && j < L) v += g[k + gw] * o[j]; } loc[i] = v; }
    const segs = []; { let a = -1; for (let i = 0; i <= L; i++) { const h = i < L && has[i]; if (h && a < 0) a = i; if (!h && a >= 0) { if (i - a > 2 * P) segs.push([a, i]); a = -1; } } }
    let beats = [];
    for (const [a, b] of segs) beats = beats.concat(dpBeats(loc, a, b, P, opts.tightness).map(i => (i + start) / FPS));
    beats.sort((x, y) => x - y);
    if (beats.length < 4) return null;
    // 5) premier temps : les accords changent surtout au début des mesures, et la grosse caisse / la basse y sont fortes
    const strengthAt = (arr, t) => { const i = Math.round(t * FPS) - start; let m = 0; for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < L && arr[k] > m) m = arr[k]; return m; };
    const lowB = beats.map(t => strengthAt(low, t)), allB = beats.map(t => strengthAt(env, t));
    // chroma moyen de chaque temps, puis nouveauté harmonique au début de chaque temps
    const bch = beats.map((t, i) => {
      const a = Math.round(t * FPS) - start, b = Math.round((beats[i + 1] || t + P / FPS) * FPS) - start, v = new Float64Array(12);
      for (let k = Math.max(0, a); k < Math.min(L, b); k++) if (chg[k]) for (let q = 0; q < 12; q++) v[q] += chg[k][q];
      let n = 0; for (let q = 0; q < 12; q++) n += v[q] * v[q]; n = Math.sqrt(n) || 1; for (let q = 0; q < 12; q++) v[q] /= n; return v;
    });
    const novB = beats.map((t, i) => {
      if (i < 2 || i > beats.length - 3) return 0;
      const pre = new Float64Array(12), post = new Float64Array(12);
      for (let q = 0; q < 12; q++) { pre[q] = bch[i - 1][q] + bch[i - 2][q]; post[q] = bch[i][q] + bch[i + 1][q]; }
      let d = 0, na = 0, nb = 0; for (let q = 0; q < 12; q++) { d += pre[q] * post[q]; na += pre[q] * pre[q]; nb += post[q] * post[q]; }
      return 1 - d / (Math.sqrt(na * nb) || 1);
    });
    const norm = arr => { const m = arr.reduce((a, b) => a + b, 0) / arr.length || 1; return arr.map(v => v / m); };
    const nL = norm(lowB), nA = norm(allB), nN = norm(novB);
    const phaseScores = M => {
      const sc = [];
      for (let p = 0; p < M; p++) { let v = 0, n = 0; for (let i = p; i < beats.length; i += M) { v += 1.5 * nN[i] + 0.6 * nL[i] + 0.2 * nA[i]; n++; } sc.push(v / Math.max(1, n)); }
      return sc;
    };
    const s4 = phaseScores(4), s3 = phaseScores(3);
    const argmax = a => a.indexOf(Math.max(...a));
    // mesure : on garde 4 temps, sauf si 3 temps ressort nettement mieux (contraste du premier temps)
    const contrast = a => { const m = Math.max(...a), mean = a.reduce((x, y) => x + y, 0) / a.length; return m / (mean || 1); };
    const meterGuess = contrast(s3) > contrast(s4) * 1.12 ? 3 : 4;
    const downbeat4 = argmax(s4), downbeat3 = argmax(s3);
    return { bpm: 60 * FPS / P, period: P / FPS, beats, conf: Math.round(conf * 100) / 100, downbeat4, downbeat3, meterGuess, start: t0, end: t1 };
  }

  function dpBeats(loc, a, b, P, tight) {
    const n = b - a, cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
    const lo = Math.round(P / 2), hi = Math.round(2 * P);
    let mx = 0; for (let i = a; i < b; i++) if (loc[i] > mx) mx = loc[i];
    for (let i = 0; i < n; i++) {
      let best = -Infinity, bj = -1;
      for (let d = lo; d <= hi; d++) {
        const j = i - d; if (j < 0) break;
        const v = cum[j] - tight * Math.pow(Math.log(d / P), 2);
        if (v > best) { best = v; bj = j; }
      }
      cum[i] = loc[a + i] + (bj >= 0 && best > 0 ? best : 0);
      back[i] = bj >= 0 && best > 0 ? bj : -1;
    }
    // dernier temps : maximum local tardif assez fort
    const maxima = [];
    for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(cum[i]);
    const med = maxima.length ? maxima.slice().sort((x, y) => x - y)[Math.floor(maxima.length / 2)] : 0;
    let end = n - 1; for (let i = n - 1; i > 0; i--) if (cum[i] > 0.5 * med && (i === n - 1 || cum[i] >= cum[i + 1]) && cum[i] >= cum[i - 1]) { end = i; break; }
    const out = []; for (let i = end; i >= 0; i = back[i]) { out.push(a + i); if (back[i] < 0) break; }
    out.reverse();
    // retirer les temps faibles au début et à la fin (introduction silencieuse, fin)
    const thr = 0.25 * Math.sqrt(out.reduce((s, i) => s + loc[i] * loc[i], 0) / Math.max(1, out.length));
    let s0 = 0, s1 = out.length;
    while (s0 < s1 && loc[out[s0]] < thr) s0++;
    while (s1 > s0 && loc[out[s1 - 1]] < thr) s1--;
    return out.slice(s0, s1);
  }

  const api = { Tracker, analyzeFrames, FPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TonalityTempo = api;
})(typeof self !== 'undefined' ? self : this);
