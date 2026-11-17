/* Tonality — transposition en temps réel (AudioWorklet).
   Vocodeur de phase dans le domaine fréquentiel (méthode de Bernsee) : la hauteur change, le tempo ne bouge pas.
   Le même code tourne dans Node pour les tests (classe PitchShifter exportée). */
'use strict';

class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } this.rev[i] = r; }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
  }
  // transformée en place; sign = -1 (directe) ou +1 (inverse, non normalisée)
  run(re, im, sign) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, c = cos[k], s = sign * sin[k];
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

// Un canal. Latence fixe : N - hop échantillons.
class PitchShifter {
  constructor(N, osamp) {
    this.N = N; this.os = osamp; this.hop = N / osamp; this.lat = N - this.hop;
    this.fft = new FFT(N);
    this.win = new Float64Array(N); for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    this.inF = new Float64Array(N); this.outF = new Float64Array(N); this.acc = new Float64Array(2 * N);
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    const H = N / 2 + 1;
    this.lastPh = new Float64Array(H);
    this.aMag = new Float64Array(H); this.aFrq = new Float64Array(H);
    this.aPh = new Float64Array(H); this.sRe = new Float64Array(H); this.sIm = new Float64Array(H);
    this.synPh = new Float64Array(H); this.synOwn = new Uint8Array(H); this.newPh = new Float64Array(H); this.newOwn = new Uint8Array(H);
    this.peaks = new Int32Array(H);
    this.rover = this.lat;
    this.ratio = 1;
  }
  reset() { this.inF.fill(0); this.outF.fill(0); this.acc.fill(0); this.lastPh.fill(0); this.synOwn.fill(0); this.rover = this.lat; }
  // traite `inp` vers `out` (mêmes longueurs); `dry` reçoit l'entrée retardée de la même latence (pour la valeur 0)
  process(inp, out, dry) {
    const { N, hop, lat, os, win, inF, outF, acc, re, im, lastPh, aMag, aFrq, aPh, sRe, sIm, synPh, synOwn, newPh, newOwn, peaks } = this;
    // frontière entre deux pics : la case de plus petite amplitude entre eux
    const bnd = (a, b) => { let m = a + 1, mv = Infinity; for (let k = a + 1; k <= b; k++) if (aMag[k] < mv) { mv = aMag[k]; m = k; } return m; };
    const prevOwnPh = j => { for (let d = 0; d < 4; d++) { if (j - d >= 0 && synOwn[j - d]) return synPh[j - d]; if (j + d < synOwn.length && synOwn[j + d]) return synPh[j + d]; } return 0; };
    const H = N / 2, expct = 2 * Math.PI * hop / N, ratio = this.ratio;
    for (let i = 0; i < inp.length; i++) {
      inF[this.rover] = inp[i];
      out[i] = outF[this.rover - lat];
      if (dry) dry[i] = inF[this.rover - lat];
      this.rover++;
      if (this.rover < N) continue;
      this.rover = lat;
      // analyse
      for (let k = 0; k < N; k++) { re[k] = inF[k] * win[k]; im[k] = 0; }
      this.fft.run(re, im, -1);
      // phase et fréquence vraie (en cases) de chaque case
      for (let k = 0; k <= H; k++) {
        const r = re[k], m = im[k], ph = Math.atan2(m, r);
        aMag[k] = Math.sqrt(r * r + m * m); aPh[k] = ph;
        let d = ph - lastPh[k]; lastPh[k] = ph;
        d -= k * expct; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        aFrq[k] = k + os * d / (2 * Math.PI);
      }
      // pics (maxima locaux) et zones d'influence; chaque zone est déplacée d'un nombre entier de cases
      // et garde la forme du lobe et les écarts de phase (verrouillage de phase de Laroche et Dolson)
      let mx = 0; for (let k = 0; k <= H; k++) if (aMag[k] > mx) mx = aMag[k];
      const thr = mx * 1e-5; let np = 0;
      for (let k = 1; k < H; k++) if (aMag[k] > thr && aMag[k] >= aMag[k - 1] && aMag[k] > aMag[k + 1]) peaks[np++] = k;
      sRe.fill(0); sIm.fill(0); newPh.fill(0); newOwn.fill(0);
      for (let q = 0; q < np; q++) {
        const p = peaks[q];
        const lo = q === 0 ? 0 : bnd(peaks[q - 1], p), hi = q === np - 1 ? H : bnd(p, peaks[q + 1]) - 1;
        const w = aFrq[p] * ratio, j = Math.round(p * ratio), sh = j - p;
        if (j < 1 || j >= H) continue;
        // phase de synthèse du pic : on poursuit celle du pic le plus proche de la trame précédente
        const prev = prevOwnPh(j);
        const php = prev + 2 * Math.PI * hop * w / N;
        newPh[j] = php - 2 * Math.PI * Math.round(php / (2 * Math.PI)); newOwn[j] = 1;
        const rot = newPh[j] - aPh[p];
        const c = Math.cos(rot), s2 = Math.sin(rot);
        for (let k = lo; k <= hi; k++) {
          const t = k + sh; if (t < 0 || t > H) continue;
          const r = re[k], m = im[k];
          sRe[t] += r * c - m * s2; sIm[t] += r * s2 + m * c;
        }
      }
      synPh.set(newPh); synOwn.set(newOwn);
      for (let k = 0; k <= H; k++) { re[k] = sRe[k]; im[k] = sIm[k]; }
      for (let k = H + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
      this.fft.run(re, im, 1);
      const g = 2 / (N * 3 * os / 8); // fenêtre de Hann appliquée deux fois : somme des recouvrements = 3·os/8
      for (let k = 0; k < N; k++) acc[k] += g * win[k] * re[k];
      for (let k = 0; k < hop; k++) outF[k] = acc[k];
      acc.copyWithin(0, hop, hop + N); acc.fill(0, N, 2 * N);
      for (let k = 0; k < lat; k++) inF[k] = inF[k + hop];
    }
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class TonalityProcessor extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      const N = sampleRate > 60000 ? 8192 : 4096;
      this.ch = [new PitchShifter(N, 4), new PitchShifter(N, 4)];
      this.ratio = 1; this.wet = 0; this.target = 0;            // fondu entre le son original (retardé) et transposé
      this.fade = 1 / (0.03 * sampleRate);
      this.rec = !!(opts && opts.processorOptions && opts.processorOptions.record);
      this.recBuf = new Float32Array(4096); this.recN = 0;
      this.tmpOut = [new Float32Array(128), new Float32Array(128)]; this.tmpDry = [new Float32Array(128), new Float32Array(128)];
      this.level = 0;
      this.port.onmessage = e => {
        const d = e.data || {};
        if (typeof d.ratio === 'number') { this.ratio = d.ratio; this.target = Math.abs(d.ratio - 1) < 1e-4 ? 0 : 1; this.ch.forEach(c => c.ratio = d.ratio); }
        if (typeof d.record === 'boolean') this.rec = d.record;
      };
      const r0 = opts && opts.processorOptions && opts.processorOptions.ratio;
      if (typeof r0 === 'number') { this.ratio = r0; this.target = this.wet = Math.abs(r0 - 1) < 1e-4 ? 0 : 1; this.ch.forEach(c => c.ratio = r0); }
      this.port.postMessage({ latency: this.ch[0].lat / sampleRate });
    }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0];
      if (!out || !out.length) return true;
      const n = out[0].length;
      const L = inp && inp[0] ? inp[0] : null, R = inp && inp[1] ? inp[1] : L;
      if (!L) { for (const o of out) o.fill(0); return true; }
      if (this.tmpOut[0].length !== n) { this.tmpOut = [new Float32Array(n), new Float32Array(n)]; this.tmpDry = [new Float32Array(n), new Float32Array(n)]; }
      const srcs = [L, R];
      for (let c = 0; c < 2; c++) this.ch[c].process(srcs[c], this.tmpOut[c], this.tmpDry[c]);
      let w = this.wet, e = 0;
      for (let i = 0; i < n; i++) {
        if (w < this.target) w = Math.min(this.target, w + this.fade); else if (w > this.target) w = Math.max(this.target, w - this.fade);
        for (let c = 0; c < out.length; c++) {
          const cc = Math.min(c, 1), v = w * this.tmpOut[cc][i] + (1 - w) * this.tmpDry[cc][i];
          out[c][i] = v;
        }
        const m = (L[i] + R[i]) / 2; e += m * m;
        if (this.rec) { this.recBuf[this.recN++] = m; if (this.recN === this.recBuf.length) { this.port.postMessage({ chunk: this.recBuf, t: currentTime }, [this.recBuf.buffer]); this.recBuf = new Float32Array(4096); this.recN = 0; } }
      }
      this.wet = w;
      this.level = 0.9 * this.level + 0.1 * Math.sqrt(e / n);
      return true;
    }
  }
  registerProcessor('tonality-shifter', TonalityProcessor);
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PitchShifter, FFT };
}
