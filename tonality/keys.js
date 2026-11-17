/* Tonality — moteur de tonalité et de modulations.
   Fonctionne en continu : on lui donne l'audio au fur et à mesure (avec le moment de la chanson correspondant),
   et il peut à tout instant donner la tonalité de départ, les modulations et l'accordage.
   JavaScript pur, sans DOM : il tourne dans le navigateur et dans Node pour les tests. */
(function (root) {
  'use strict';

  function makeFFT(n) {
    const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), win = new Float64Array(n);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n), im = new Float64Array(n);
    return function mag(x, out) { // x : Float32Array de longueur n
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

  // Profils de Krumhansl-Kessler (majeur, mineur)
  const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  // Basse : la tonique et la dominante dominent nettement
  const BMAJ = [6, 0.5, 2, 0.5, 2.5, 3.5, 0.5, 4.5, 0.5, 2.5, 0.5, 1];
  const BMIN = [6, 0.5, 2, 2.5, 0.5, 3.5, 0.5, 4.5, 2.5, 0.5, 2, 1.5];
  const zprof = p => { const m = p.reduce((a, b) => a + b) / 12; const d = p.map(v => v - m); const s = Math.sqrt(d.reduce((a, v) => a + v * v, 0)); return d.map(v => v / s); };
  const PROF = [], BPROF = [];
  for (let k = 0; k < 24; k++) {
    const t = k % 12, maj = k < 12, P = zprof(maj ? KMAJ : KMIN), B = zprof(maj ? BMAJ : BMIN);
    PROF.push(Array.from({ length: 12 }, (_, i) => P[(i - t + 12) % 12]));
    BPROF.push(Array.from({ length: 12 }, (_, i) => B[(i - t + 12) % 12]));
  }
  // Armures : gamme majeure (états 0-11) et mineur avec 6e et 7e mobiles (états 12-23)
  const SET = [];
  for (let k = 0; k < 24; k++) {
    const t = k % 12, v = new Array(12).fill(0);
    if (k < 12) [0, 2, 4, 5, 7, 9, 11].forEach(i => v[(t + i) % 12] = 1);
    else { [0, 2, 3, 5, 7].forEach(i => v[(t + i) % 12] = 1); v[(t + 8) % 12] = 0.8; v[(t + 10) % 12] = 0.6; v[(t + 11) % 12] = 0.7; v[(t + 9) % 12] = 0.2; }
    SET.push(zprof(v));
  }
  const keyOf = k => ({ tonic: k % 12, mode: k < 12 ? 'maj' : 'min' });
  const idxOf = key => key.tonic + (key.mode === 'maj' ? 0 : 12);
  function corrZ(v, P) { // corrélation de Pearson (P déjà centré-réduit)
    let m = 0; for (let i = 0; i < 12; i++) m += v[i]; m /= 12;
    let s = 0, ss = 0; for (let i = 0; i < 12; i++) { const d = v[i] - m; s += d * P[i]; ss += d * d; }
    return ss > 0 ? s / Math.sqrt(ss) : 0;
  }

  /* ------------ Suivi continu ------------ */
  class Tracker {
    constructor(sr) {
      this.sr = sr;
      this.N = 1 << Math.round(Math.log2(sr * 0.37)); // ≈ 8192 à 22 kHz, 16384 à 44-48 kHz
      this.hop = this.N >> 1;
      this.mag = makeFFT(this.N);
      this.spec = new Float64Array(this.N / 2 + 1);
      this.buf = new Float32Array(this.N * 2); this.bn = 0;  // échantillons en attente
      this.times = [];   // pour chaque échantillon en attente : segments {i (index dans buf), t, rate}
      this.frames = [];  // {t, c: Float32Array(36), b: Float32Array(36), e}
      const o = Object.assign({ hiMidi: 84, loMidi: 43 }, Tracker.opts || {});
      this.loMidi = o.loMidi; this.hiMidi = o.hiMidi; this.fHi = 440 * Math.pow(2, (o.hiMidi + 1 - 69) / 12);
      this.heard = 0; // secondes de musique reçues
    }
    // samples : Float32Array mono; t : moment de la chanson (s) du premier échantillon; rate : vitesse de lecture
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
      const N = this.N, spec = this.mag(this.buf.subarray(0, N), this.spec);
      const c = new Float32Array(36), b = new Float32Array(36);
      let e = 0;
      // pics du spectre, fréquence précisée par interpolation parabolique (log) → position en tiers de demi-ton
      const K = N / 2, sr = this.sr, kLo = Math.max(2, Math.floor(30 * N / sr)), kHi = Math.min(K - 1, Math.ceil(this.fHi * N / sr));
      let mx = 0; for (let k = kLo; k <= kHi; k++) if (spec[k] > mx) mx = spec[k];
      const thr = mx * 0.01;
      for (let k = kLo; k <= kHi; k++) {
        const m = spec[k]; if (m < thr || m <= spec[k - 1] || m < spec[k + 1]) continue;
        const la = Math.log(spec[k - 1] + 1e-12), lb = Math.log(m), lc = Math.log(spec[k + 1] + 1e-12);
        const d = 0.5 * (la - lc) / (la - 2 * lb + lc || -1e-9), f = (k + Math.max(-0.5, Math.min(0.5, d))) * sr / N;
        const midi = 69 + 12 * Math.log2(f / 440), pos = midi * 3, j = Math.floor(pos), fr = pos - j, v = Math.sqrt(m);
        const j0 = ((j % 36) + 36) % 36, j1 = (j0 + 1) % 36;
        if (midi >= this.loMidi && midi <= this.hiMidi) { c[j0] += v * (1 - fr); c[j1] += v * fr; }
        if (midi >= 28 && midi <= 55) { const w = v * (midi <= 47 ? 1 : 0.5); b[j0] += w * (1 - fr); b[j1] += w * fr; }
      }
      for (let i = 0; i < 36; i++) e += c[i];
      let rms = 0; for (let i = 0; i < N; i++) rms += this.buf[i] * this.buf[i];
      this.frames.push({ t: this._timeAt(N / 2), c, b, e, rms: Math.sqrt(rms / N) });
      // décalage
      const h = this.hop;
      this.buf.copyWithin(0, h, this.bn); this.bn -= h;
      this.times = this.times.map(x => ({ i: x.i - h, t: x.t, rate: x.rate }));
      // garder le dernier repère avant 0 (recalé à 0)
      let k = 0; while (k + 1 < this.times.length && this.times[k + 1].i <= 0) k++;
      const first = this.times[k]; this.times = this.times.slice(k);
      if (first.i < 0) { this.times[0] = { i: 0, t: first.t - first.i / this.sr * first.rate, rate: first.rate }; }
    }
    get duration() { return this.frames.length ? this.frames[this.frames.length - 1].t : 0; }
    // Résultat : accordage, tonalité de chaque passage
    analyze(opts) { return analyzeFrames(this.frames, opts); }
  }

  /* ------------ Analyse des trames ------------ */
  function analyzeFrames(frames, opts) {
    opts = Object.assign({ block: 1, half: 6, penalty: 2.2, minSeg: 12, bassW: 0.8, bassMix: 0.5, relPenalty: 1.5 }, opts || {});
    if (frames.length < 8) return null;
    // 1) accordage : moyenne circulaire de l'énergie sur les 3 tiers de demi-ton
    let sx = 0, sy = 0;
    for (const f of frames) for (let j = 0; j < 36; j++) { const a = 2 * Math.PI * (j % 3) / 3; sx += f.c[j] * Math.cos(a); sy += f.c[j] * Math.sin(a); }
    const off = Math.atan2(sy, sx) / (2 * Math.PI) * 3;     // en tiers de demi-ton, entre -1,5 et 1,5
    const tuning = off * 100 / 3;                          // en cents
    const fold = (v36, out) => {
      out.fill(0);
      for (let s = 0; s < 12; s++) {
        const ctr = 3 * s + off;
        for (let d = -1; d <= 1; d++) {
          const pos = ctr + d * 1, base = Math.floor(pos), fr = pos - base;
          const w = 1 - Math.abs(d) * 0.5;
          out[s] += w * ((1 - fr) * v36[((base % 36) + 36) % 36] + fr * v36[(((base + 1) % 36) + 36) % 36]);
        }
      }
      return out;
    };
    // 2) blocs de ~1 s (énergie pondérée)
    const t0 = frames[0].t, blocks = [];
    const silentThr = (() => { const r = frames.map(f => f.rms).sort((a, b) => a - b); return Math.max(0.003, r[Math.floor(r.length * 0.5)] * 0.12); })();
    let cur = null;
    const tmp = new Float32Array(12), tmpb = new Float32Array(12);
    for (const f of frames) {
      const bi = Math.floor((f.t - t0) / opts.block);
      if (!cur || cur.i !== bi) {
        // une coupure (retour en arrière dans la chanson) fait commencer un nouveau bloc
        cur = { i: bi, t0: f.t, t1: f.t, c: new Float64Array(12), b: new Float64Array(12), n: 0, loud: 0 };
        blocks.push(cur);
      }
      cur.t1 = f.t;
      if (f.rms < silentThr) continue;
      fold(f.c, tmp); fold(f.b, tmpb);
      for (let i = 0; i < 12; i++) { cur.c[i] += tmp[i]; cur.b[i] += tmpb[i]; }
      cur.n++; cur.loud += f.rms;
    }
    const B = blocks.length;
    const active = blocks.map(b => b.n > 0);
    if (!active.some(Boolean)) return null;
    // 3) Étape A : l'armure (ensemble de notes) de chaque passage.
    //    États 0-11 : gamme majeure de tonique s (= relative mineure naturelle); états 12-23 : mineur de tonique s-12
    //    avec la sensible haussée (mineur harmonique / mélodique, très courant).
    const win = (i, h, arr) => {
      const c = new Float64Array(12); let any = false;
      for (let j = Math.max(0, i - h); j <= Math.min(B - 1, i + h); j++) {
        if (!active[j]) continue; any = true;
        const tri = 1 - Math.abs(i - j) / (h + 1);
        for (let p = 0; p < 12; p++) c[p] += tri * (blocks[j].c[p] + opts.bassMix * blocks[j].b[p]);
      }
      return any ? c : null;
    };
    const emit = [], own = [];
    for (let i = 0; i < B; i++) {
      const w = active[i] ? win(i, opts.half) : null, e = new Float64Array(24), o = new Float64Array(24);
      const ow = active[i] ? win(i, 0) : null;
      if (w) for (let k = 0; k < 24; k++) { e[k] = corrZ(w, SET[k]); o[k] = corrZ(ow, SET[k]); }
      emit.push(e); own.push(o);
    }
    const famOf = k => k < 12 ? k : (k - 12 + 3) % 12; // mineur de tonique t → même armure que majeur t+3
    const costA = (a, b) => a === b ? 0 : famOf(a) === famOf(b) ? opts.penalty * 0.25 : opts.penalty;
    const viterbi = (E, S, cost) => {
      const n = E.length; let sc = Float64Array.from(E[0]); const back = [];
      for (let i = 1; i < n; i++) {
        const ns = new Float64Array(S), bk = new Int8Array(S);
        for (let k = 0; k < S; k++) { let best = -Infinity, bj = k; for (let j = 0; j < S; j++) { const v = sc[j] - cost(j, k); if (v > best) { best = v; bj = j; } } ns[k] = best + E[i][k]; bk[k] = bj; }
        sc = ns; back.push(bk);
      }
      let k = 0; for (let j = 1; j < S; j++) if (sc[j] > sc[k]) k = j;
      const path = new Int8Array(n); path[n - 1] = k; for (let i = n - 1; i > 0; i--) { k = back[i - 1][k]; path[i - 1] = k; }
      return path;
    };
    const pathA = viterbi(emit, 24, costA).map(famOf);
    const toSegs = path => { const sg = []; for (let i = 0; i < path.length; i++) { if (!sg.length || sg[sg.length - 1].k !== path[i]) sg.push({ k: path[i], a: i, b: i + 1 }); else sg[sg.length - 1].b = i + 1; } return sg; };
    // 4) Étape B : dans chaque armure, la tonique (majeur ou relative mineure), avec la basse et les profils de Krumhansl
    const keyScore = (i, h, k) => { // k : 0-23 (tonalité)
      const c = new Float64Array(12), bb = new Float64Array(12); let any = false;
      for (let j = Math.max(0, i - h); j <= Math.min(B - 1, i + h); j++) { if (!active[j]) continue; any = true; for (let p = 0; p < 12; p++) { c[p] += blocks[j].c[p]; bb[p] += blocks[j].b[p]; } }
      return any ? corrZ(c, PROF[k]) + opts.bassW * corrZ(bb, BPROF[k]) : 0;
    };
    const path = new Int8Array(B);
    for (const sg of toSegs(pathA)) {
      const maj = sg.k, min = 12 + (sg.k + 9) % 12, cand = [maj, min];
      const E = []; for (let i = sg.a; i < sg.b; i++) E.push(active[i] ? cand.map(k => keyScore(i, opts.half * 2, k)) : [0, 0]);
      // passage à la relative : seulement s'il dure (pénalité plus forte)
      const pB = viterbi(E, 2, (x, y) => x === y ? 0 : opts.penalty * opts.relPenalty);
      for (let i = sg.a; i < sg.b; i++) path[i] = cand[pB[i - sg.a]];
    }
    let segs = toSegs(path);
    // ajuster chaque frontière d'armure avec les blocs eux-mêmes (sans le flou de la fenêtre)
    for (let s = 1; s < segs.length; s++) {
      const A = segs[s - 1], Bs = segs[s];
      if (famOf(A.k) === famOf(Bs.k)) continue;
      const lo = Math.max(A.a + 1, Bs.a - opts.half), hi = Math.min(Bs.b - 1, Bs.a + opts.half);
      let best = -Infinity, bpos = Bs.a;
      for (let p = lo; p <= hi; p++) {
        let v = 0;
        for (let i = lo - 1; i < p; i++) v += own[i][famOf(A.k)];
        for (let i = p; i <= hi; i++) v += own[i][famOf(Bs.k)];
        if (v > best) { best = v; bpos = p; }
      }
      A.b = bpos; Bs.a = bpos;
    }
    // 5) fusion des passages trop courts
    const dur = sg => blocks[sg.b - 1].t1 - blocks[sg.a].t0;
    const segScore = (sg, k) => { let v = 0; for (let i = sg.a; i < sg.b; i++) v += own[i][famOf(k)]; return v; };
    for (;;) {
      for (let i = 1; i < segs.length; i++) if (segs[i].k === segs[i - 1].k) { segs[i - 1].b = segs[i].b; segs.splice(i, 1); i--; }
      if (segs.length < 2) break;
      let si = -1, sd = Infinity;
      segs.forEach((sg, i) => { const d = dur(sg); if (d < opts.minSeg && d < sd) { sd = d; si = i; } });
      if (si < 0) break;
      const sg = segs[si], L = segs[si - 1], R = segs[si + 1];
      const into = !R || (L && segScore(sg, L.k) >= segScore(sg, R.k)) ? L : R;
      if (into === L) L.b = sg.b; else R.a = sg.a;
      segs.splice(si, 1);
    }
    // 6) sortie
    const out = segs.map(sg => {
      const c = new Float64Array(12), bb = new Float64Array(12);
      for (let i = sg.a; i < sg.b; i++) if (active[i]) for (let p = 0; p < 12; p++) { c[p] += blocks[i].c[p]; bb[p] += blocks[i].b[p]; }
      const tot = new Float64Array(12); for (let p = 0; p < 12; p++) tot[p] = c[p] + opts.bassMix * bb[p];
      const fam = famOf(sg.k), setFit = Array.from({ length: 12 }, (_, f) => corrZ(tot, SET[f])).map((v, f) => ({ f, v })).sort((x, y) => y.v - x.v);
      const second = setFit.find(x => x.f !== fam) || { v: 0 };
      const mine = setFit.find(x => x.f === fam).v;
      const confSet = Math.max(0, Math.min(1, (mine - second.v) / 0.3));
      const maj = fam, min = 12 + (fam + 9) % 12;
      const sMaj = corrZ(c, PROF[maj]) + opts.bassW * corrZ(bb, BPROF[maj]), sMin = corrZ(c, PROF[min]) + opts.bassW * corrZ(bb, BPROF[min]);
      const chosen = sg.k, other = chosen === maj ? min : maj, gap = Math.abs(sMaj - sMin);
      const confTonic = Math.max(0, Math.min(1, gap / 0.25));
      return {
        t0: blocks[sg.a].t0, t1: blocks[sg.b - 1].t1,
        key: keyOf(chosen), conf: Math.round(Math.min(confSet, 0.4 + 0.6 * confTonic) * 100) / 100,
        alt: confTonic < 0.5 ? keyOf(other) : null
      };
    });
    // le premier passage commence au début de la musique (on saute le silence initial)
    const firstActive = blocks.findIndex(b => b.n > 0);
    if (out.length && firstActive > 0) out[0].t0 = blocks[firstActive].t0;
    let lastActive = B - 1; while (lastActive > 0 && !active[lastActive]) lastActive--;
    if (out.length) out[out.length - 1].t1 = blocks[lastActive].t1;
    return { tuning: Math.round(tuning), segments: out, start: frames[0].t, end: frames[frames.length - 1].t };
  }

  // Intervalle entre deux tonalités, en mots (pour « monte d'un ton », etc.)
  const IV_UP = ['', 'un demi-ton', 'un ton', 'une tierce mineure', 'une tierce majeure', 'une quarte', 'un triton'];
  function describeChange(a, b) {
    if (a.tonic === b.tonic && a.mode !== b.mode) return b.mode === 'min' ? 'passe en mineur (même tonique)' : 'passe en majeur (même tonique)';
    const relOf = k => k.mode === 'maj' ? (k.tonic + 9) % 12 : (k.tonic + 3) % 12;
    if (a.mode !== b.mode && relOf(a) === b.tonic) return b.mode === 'min' ? 'passe à la relative mineure' : 'passe à la relative majeure';
    const d = (b.tonic - a.tonic + 12) % 12;
    if (d === 0) return 'reste dans la même tonique';
    if (d <= 6) return 'monte d\'' + IV_UP[d];
    return 'descend d\'' + IV_UP[12 - d];
  }
  function semis(a, b) { const d = (b.tonic - a.tonic + 12) % 12; return d <= 6 ? d : d - 12; }

  Tracker.opts = null;
  const api = { Tracker, analyzeFrames, describeChange, semis, keyOf, idxOf, PROF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TonalityKeys = api;
})(typeof self !== 'undefined' ? self : this);
