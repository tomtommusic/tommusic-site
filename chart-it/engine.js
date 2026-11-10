/* Chart It — moteur d'analyse (accords, pulsation, mesures, tonalité, sections).
   JavaScript pur, sans dépendance ni accès au DOM : il tourne dans le navigateur et dans Node pour les tests.
   Entrée : audio mono Float32 à 22 050 Hz. Tout reste en mémoire; rien n'est envoyé nulle part. */
(function (root) {
  'use strict';
  const SR = 22050;

  /* ---------------- FFT (radix 2, en place) ---------------- */
  const fftCache = {};
  function getFFT(n) {
    if (fftCache[n]) return fftCache[n];
    const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return (fftCache[n] = { n, rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) });
  }
  // Magnitude du spectre d'une trame de x commençant à `start` (fenêtre de Hann, zéros hors du signal)
  function frameMag(x, start, F, out) {
    const { n, rev, cos, sin, win, re, im } = F;
    for (let i = 0; i < n; i++) { const j = start + i; re[rev[i]] = (j >= 0 && j < x.length ? x[j] : 0) * win[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, c = cos[k], s = sin[k];
          const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return out;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  /* ---------------- Accordage global (écart au La 440, en cents) ---------------- */
  function estimateTuning(x) {
    const F = getFFT(8192), mag = new Float32Array(4097), hop = 8192;
    let sx = 0, sy = 0;
    const kmin = Math.ceil(150 * 8192 / SR), kmax = Math.floor(2000 * 8192 / SR);
    for (let start = 0; start + 8192 < x.length; start += hop) {
      frameMag(x, start, F, mag);
      let mx = 0; for (let k = kmin; k <= kmax; k++) if (mag[k] > mx) mx = mag[k];
      if (mx <= 0) continue;
      for (let k = kmin; k <= kmax; k++) {
        const m = mag[k];
        if (m < 0.15 * mx || m <= mag[k - 1] || m < mag[k + 1]) continue;
        const a = mag[k - 1], c = mag[k + 1], d = 0.5 * (a - c) / (a - 2 * m + c || 1e-9);
        const f = (k + d) * SR / 8192, cents = 1200 * Math.log2(f / 440);
        const ang = 2 * Math.PI * cents / 100;
        sx += m * Math.cos(ang); sy += m * Math.sin(ang);
      }
    }
    if (!sx && !sy) return 0;
    return Math.atan2(sy, sx) / (2 * Math.PI) * 100; // entre -50 et 50
  }

  /* ---------------- Spectre en demi-tons (MIDI lo..hi) ---------------- */
  function pitchMap(n, lo, hi, tuning) {
    // pour chaque case FFT utile : demi-ton cible et poids (cos² selon la distance au centre)
    const ref = 440 * Math.pow(2, tuning / 1200), map = [];
    for (let k = 1; k <= n / 2; k++) {
      const f = k * SR / n, midi = 69 + 12 * Math.log2(f / ref);
      if (midi < lo - 0.5) continue; if (midi > hi + 0.5) break;
      const m = Math.round(midi), d = midi - m;
      if (m < lo || m > hi) continue;
      map.push(k, m - lo, Math.cos(Math.PI * d) ** 2);
    }
    return map;
  }
  async function pitchSpectrogram(x, n, hop, lo, hi, tuning, onStep) {
    const F = getFFT(n), mag = new Float32Array(n / 2 + 1), map = pitchMap(n, lo, hi, tuning), P = hi - lo + 1;
    const frames = Math.max(1, Math.ceil(x.length / hop)), out = new Float32Array(frames * P);
    for (let f = 0; f < frames; f++) {
      frameMag(x, f * hop - n / 2, F, mag); // trame centrée sur f*hop
      const o = f * P;
      for (let i = 0; i < map.length; i += 3) out[o + map[i + 1]] += mag[map[i]] * map[i + 2];
      if (f % 64 === 63) { onStep && onStep(f / frames); await tick(); }
    }
    return { data: out, frames, P, hop, lo };
  }
  // Compression log + filtre médian dans le temps (atténue les frappes de batterie) + retrait du plancher de bruit
  function cleanSpec(S, medLen) {
    const { data, frames, P } = S;
    let mx = 0; for (let i = 0; i < data.length; i++) if (data[i] > mx) mx = data[i];
    const g = mx > 0 ? 1000 / mx : 0, L = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) L[i] = Math.log1p(g * data[i]);
    const out = new Float32Array(data.length), h = medLen >> 1, buf = new Float32Array(medLen);
    for (let p = 0; p < P; p++) {
      for (let f = 0; f < frames; f++) {
        let c = 0;
        for (let d = -h; d <= h; d++) { const ff = Math.min(frames - 1, Math.max(0, f + d)); buf[c++] = L[ff * P + p]; }
        const s = Array.from(buf.subarray(0, c)).sort((a, b) => a - b);
        out[f * P + p] = s[c >> 1];
      }
    }
    for (let f = 0; f < frames; f++) {
      let mean = 0; for (let p = 0; p < P; p++) mean += out[f * P + p]; mean /= P;
      for (let p = 0; p < P; p++) out[f * P + p] = Math.max(0, out[f * P + p] - 0.6 * mean);
    }
    return { data: out, frames, P, hop: S.hop, lo: S.lo };
  }
  function toChroma(S, wLow) {
    const { data, frames, P, lo } = S, C = new Float32Array(frames * 12);
    for (let f = 0; f < frames; f++) for (let p = 0; p < P; p++) {
      const m = lo + p, w = wLow ? wLow(m) : 1;
      C[f * 12 + (m % 12)] += data[f * P + p] * w;
    }
    return C;
  }

  /* ---------------- Enveloppe d'attaques (pour la pulsation) ---------------- */
  async function onsetEnvelope(x) {
    const n = 1024, hop = 512, F = getFFT(n), mag = new Float32Array(n / 2 + 1), prev = new Float32Array(n / 2 + 1);
    const frames = Math.ceil(x.length / hop), env = new Float32Array(frames), low = new Float32Array(frames), rms = new Float32Array(frames);
    const kmax = Math.floor(8000 * n / SR), klow = Math.floor(150 * n / SR);
    for (let f = 0; f < frames; f++) {
      frameMag(x, f * hop - n / 2, F, mag);
      let s = 0, sl = 0;
      for (let k = 1; k <= kmax; k++) {
        const v = Math.log1p(100 * mag[k]), d = v - prev[k];
        if (d > 0) { s += d; if (k <= klow) sl += d; }
        prev[k] = v;
      }
      env[f] = s; low[f] = sl;
      { let e = 0; const a = f * hop, b = Math.min(x.length, a + hop); for (let i = a; i < b; i++) e += x[i] * x[i]; rms[f] = Math.sqrt(e / Math.max(1, b - a)); }
      if (f % 512 === 511) await tick();
    }
    const norm = (e) => { // retrait de la moyenne locale (≈1 s), redressement, normalisation
      const w = 43, out = new Float32Array(e.length); let acc = 0;
      const cs = new Float64Array(e.length + 1); for (let i = 0; i < e.length; i++) cs[i + 1] = cs[i] + e[i];
      for (let i = 0; i < e.length; i++) { const a = Math.max(0, i - w), b = Math.min(e.length, i + w + 1); out[i] = Math.max(0, e[i] - (cs[b] - cs[a]) / (b - a)); acc += out[i] * out[i]; }
      const sd = Math.sqrt(acc / Math.max(1, e.length)) || 1; for (let i = 0; i < e.length; i++) out[i] /= sd;
      return out;
    };
    return { env: norm(env), low: norm(low), rms, fps: SR / hop };
  }

  /* ---------------- Tempo + suivi des temps (programmation dynamique, Ellis 2007) ---------------- */
  function estimatePeriod(env, fps, prefBpm) {
    const minL = Math.floor(fps * 60 / 200), maxL = Math.ceil(fps * 60 / 55);
    let best = minL, bestV = -Infinity; const ac = new Float64Array(maxL + 2);
    for (let L = minL; L <= maxL + 1; L++) { let s = 0; for (let i = L; i < env.length; i++) s += env[i] * env[i - L]; ac[L] = s; }
    for (let L = minL; L <= maxL; L++) {
      const bpm = 60 * fps / L, w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prefBpm) / 0.7, 2));
      // appui des multiples (2L) : une vraie pulsation se répète
      const v = w * (ac[L] + 0.5 * (2 * L <= maxL + 1 ? ac[2 * L] : 0));
      if (v > bestV) { bestV = v; best = L; }
    }
    const a = ac[best - 1], b = ac[best], c = ac[best + 1], d = 0.5 * (a - c) / (a - 2 * b + c || 1e-9);
    return best + Math.max(-0.5, Math.min(0.5, d));
  }
  function trackBeats(env, fps, period, tightness) {
    const N = env.length, score = new Float64Array(N), back = new Int32Array(N).fill(-1), a = tightness || 100;
    for (let t = 0; t < N; t++) {
      const lo = Math.round(t - 2 * period), hi = Math.round(t - period / 2);
      let best = 0, bi = -1;
      for (let p = Math.max(0, lo); p <= hi; p++) {
        const r = Math.log((t - p) / period), v = score[p] - a * r * r;
        if (bi < 0 || v > best) { best = v; bi = p; }
      }
      score[t] = env[t] + (bi >= 0 ? Math.max(0, best) : 0);
      back[t] = bi >= 0 && best > 0 ? bi : -1;
    }
    // fin : meilleur score dans la dernière période
    let t = N - 1, bv = -Infinity;
    for (let i = Math.max(0, N - Math.round(period)); i < N; i++) if (score[i] > bv) { bv = score[i]; t = i; }
    const beats = [];
    while (t >= 0) { beats.push(t); t = back[t]; }
    beats.reverse();
    // combler le début et la fin par extrapolation
    while (beats.length && beats[0] - period > 0) beats.unshift(beats[0] - period);
    while (beats.length && beats[beats.length - 1] + period < N) beats.push(beats[beats.length - 1] + period);
    return beats.map(f => f / fps);
  }

  /* ---------------- Vocabulaire d'accords ---------------- */
  const QUAL = {
    maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    dim: [0, 3, 6], m7b5: [0, 3, 6, 10], sus4: [0, 5, 7], sus2: [0, 2, 7], aug: [0, 4, 8], dim7: [0, 3, 6, 9], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9]
  };
  const VOCAB = {
    simple: ['maj', 'min'],
    sept: ['maj', 'min', '7', 'maj7', 'm7'],
    etendu: ['maj', 'min', '7', 'maj7', 'm7', 'dim', 'm7b5', 'sus4', 'sus2']
  };
  const MINOR_Q = new Set(['min', 'm7', 'dim', 'm7b5', 'dim7', 'm6']);
  function template(root, q) {
    const t = new Float64Array(12), s = 0.6;
    for (const iv of QUAL[q]) for (let h = 1; h <= 6; h++) t[(root + iv + Math.round(12 * Math.log2(h))) % 12] += Math.pow(s, h - 1);
    let n = 0; for (const v of t) n += v * v; n = Math.sqrt(n);
    for (let i = 0; i < 12; i++) t[i] /= n;
    return t;
  }
  function chordList(vocab) {
    const L = [];
    for (const q of VOCAB[vocab] || VOCAB.sept) for (let r = 0; r < 12; r++) L.push({ r, q, T: template(r, q), n: QUAL[q].length });
    return L;
  }

  /* ---------------- Tonalité (profils de Krumhansl) ---------------- */
  const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) {
    const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
    return s / Math.sqrt(sa * sb || 1);
  }
  function keyScores(chroma) {
    const out = [];
    for (let k = 0; k < 12; k++) {
      const rot = i => chroma[(i + k) % 12], c = Array.from({ length: 12 }, (_, i) => rot(i));
      out.push({ tonic: k, mode: 'maj', s: corr(c, KMAJ) }, { tonic: k, mode: 'min', s: corr(c, KMIN) });
    }
    return out.sort((a, b) => b.s - a.s);
  }
  function diatonic(key) {
    // ensemble « racine:qualité » d'accords diatoniques (+ V et V7 en mineur)
    const set = new Set(), add = (iv, qs) => qs.forEach(q => set.add(((key.tonic + iv) % 12) + ':' + q));
    if (key.mode === 'maj') {
      add(0, ['maj', 'maj7', '6']); add(2, ['min', 'm7']); add(4, ['min', 'm7']); add(5, ['maj', 'maj7', '6']);
      add(7, ['maj', '7', 'sus4']); add(9, ['min', 'm7']); add(11, ['dim', 'm7b5']); add(2, ['sus2', 'sus4']); add(0, ['sus2', 'sus4']);
    } else {
      add(0, ['min', 'm7']); add(2, ['dim', 'm7b5']); add(3, ['maj', 'maj7']); add(5, ['min', 'm7']); add(7, ['min', 'm7', 'maj', '7', 'sus4']);
      add(8, ['maj', 'maj7']); add(10, ['maj', '7']); add(11, ['dim', 'dim7']);
    }
    return set;
  }

  /* ---------------- Étape 1 : traits audio (lourd, fait une seule fois) ---------------- */
  async function extract(x, onProgress) {
    const p = (a, b) => v => onProgress && onProgress(a + (b - a) * v);
    onProgress && onProgress(0);
    const tuning = estimateTuning(x);
    onProgress && onProgress(0.04); await tick();
    const on = await onsetEnvelope(x); onProgress && onProgress(0.15);
    const hop = 2048;
    const Ct = cleanSpec(await pitchSpectrogram(x, 8192, hop, 43, 95, tuning, p(0.15, 0.55)), 9);
    const Cb = cleanSpec(await pitchSpectrogram(x, 16384, hop, 28, 55, tuning, p(0.55, 0.92)), 9);
    const chroma = toChroma(Ct), bass = toChroma(Cb, m => m <= 40 ? 1.3 : m <= 48 ? 1 : 0.6);
    // énergie par trame (pour repérer le silence)
    const energy = new Float32Array(Ct.frames);
    for (let f = 0; f < Ct.frames; f++) { let s = 0; for (let i = 0; i < 12; i++) s += chroma[f * 12 + i]; energy[f] = s; }
    onProgress && onProgress(0.95);
    return { tuning, onset: on, chroma, bass, energy, frames: Ct.frames, hop, duration: x.length / SR };
  }

  /* ---------------- Étape 2 : pulsation ---------------- */
  function beatsFrom(feat, opts) {
    const o = feat.onset, period = estimatePeriod(o.env, o.fps, (opts && opts.prefBpm) || 110);
    let beats = trackBeats(o.env, o.fps, period, 100).filter(t => t >= 0 && t <= feat.duration);
    return { beats, bpm: 60 * o.fps / period };
  }
  // Doubler (×2) ou réduire de moitié (÷2) la pulsation trouvée
  function scaleBeats(beats, factor, phase) {
    if (factor === 2) { const out = []; for (let i = 0; i < beats.length; i++) { out.push(beats[i]); if (i + 1 < beats.length) out.push((beats[i] + beats[i + 1]) / 2); } return out; }
    if (factor === 0.5) return beats.filter((_, i) => i % 2 === (phase || 0));
    return beats.slice();
  }

  /* ---------------- Étape 3 : accords sur la grille des temps ---------------- */
  function beatAverages(feat, beats) {
    const { chroma, bass, energy, hop, frames } = feat, fr = t => t * SR / hop;
    const B = beats.length, bc = [], bb = [], be = new Float64Array(B);
    for (let i = 0; i < B; i++) {
      const t0 = beats[i], t1 = i + 1 < B ? beats[i + 1] : Math.min(feat.duration, t0 + (i ? beats[i] - beats[i - 1] : 0.5));
      const len = t1 - t0, a = fr(t0 + 0.1 * len), b = fr(t1 - 0.1 * len);
      let f0 = Math.round(a), f1 = Math.round(b); if (f1 < f0) f1 = f0;
      const c = new Float64Array(12), d = new Float64Array(12); let e = 0, n = 0;
      for (let f = Math.max(0, f0); f <= Math.min(frames - 1, f1); f++) {
        for (let k = 0; k < 12; k++) { c[k] += chroma[f * 12 + k]; d[k] += bass[f * 12 + k]; }
        e += energy[f]; n++;
      }
      if (n) { for (let k = 0; k < 12; k++) { c[k] /= n; d[k] /= n; } e /= n; }
      // niveau sonore réel du temps (sans le débordement des longues fenêtres)
      const o = feat.onset, r0 = Math.max(0, Math.floor(t0 * o.fps)), r1 = Math.min(o.rms.length - 1, Math.ceil(t1 * o.fps));
      let rs = 0, rn = 0; for (let f = r0; f <= r1; f++) { rs += o.rms[f]; rn++; }
      bc.push(c); bb.push(d); be[i] = rn ? rs / rn : 0;
    }
    return { bc, bb, be };
  }
  const l2 = v => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s) || 1; };
  const maxn = v => { let m = 0; for (const x of v) if (x > m) m = x; return m || 1; };

  function decode(feat, beats, opts) {
    opts = Object.assign({ vocab: 'sept', minBeats: 2, inversions: true, key: null }, opts || {});
    const { bc, bb, be } = beatAverages(feat, beats), B = beats.length;
    const chords = chordList(opts.vocab), C = chords.length, NC = C;
    // silence : énergie très faible par rapport à la médiane
    const med = Array.from(be).sort((a, b) => a - b)[Math.floor(B / 2)] || 1;
    // tonalité provisoire à partir du chroma global
    const tot = new Float64Array(12);
    for (let i = 0; i < B; i++) { const n = l2(bc[i]); for (let k = 0; k < 12; k++) tot[k] += bc[i][k] / n; }
    let key = opts.key || keyScores(tot)[0];
    const dia = diatonic(key);
    // scores d'émission
    const S = []; // S[b][c]
    for (let b = 0; b < B; b++) {
      const v = bc[b], n = l2(v), bn = maxn(bb[b]), row = new Float64Array(C + 1);
      for (let c = 0; c < C; c++) {
        const ch = chords[c]; let s = 0;
        for (let k = 0; k < 12; k++) s += ch.T[k] * v[k] / n;
        s += 0.12 * bb[b][ch.r] / bn;               // basse sur la fondamentale
        if (ch.n > 3) s -= 0.025;                    // prudence pour les accords à 4 sons
        if (ch.q !== 'maj' && ch.q !== 'min' && ch.n === 3) s -= 0.02;
        if (dia.has(ch.r + ':' + ch.q)) s += 0.035;  // accords de la tonalité
        row[c] = s;
      }
      row[NC] = be[b] < 0.12 * med ? 2 : 0.25;      // « pas d'accord »
      S.push(row);
    }
    // Viterbi (rester sur le même accord est favorisé)
    const beta = 30, lam = 3.2, prev = new Float64Array(C + 1), cur = new Float64Array(C + 1), back = [];
    for (let c = 0; c <= C; c++) prev[c] = beta * S[0][c];
    for (let b = 1; b < B; b++) {
      let bi = 0; for (let c = 1; c <= C; c++) if (prev[c] > prev[bi]) bi = c;
      const bk = new Int16Array(C + 1);
      for (let c = 0; c <= C; c++) {
        let v = prev[c], from = c;
        if (prev[bi] - lam > v) { v = prev[bi] - lam; from = bi; }
        cur[c] = v + beta * S[b][c]; bk[c] = from;
      }
      back.push(bk); prev.set(cur);
    }
    const path = new Int16Array(B); let bi = 0; for (let c = 1; c <= C; c++) if (prev[c] > prev[bi]) bi = c;
    path[B - 1] = bi; for (let b = B - 1; b > 0; b--) path[b - 1] = back[b - 1][path[b]];
    // segments + durée minimale
    let segs = toSegs(path);
    const segScore = (s, c) => { let t = 0; for (let b = s.a; b < s.b; b++) t += S[b][c]; return t; };
    let changed = true;
    while (changed && opts.minBeats > 1) {
      changed = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]; if (s.b - s.a >= opts.minBeats || segs.length < 2) continue;
        const L = segs[i - 1], R = segs[i + 1];
        const toL = L ? segScore(s, L.c) : -Infinity, toR = R ? segScore(s, R.c) : -Infinity;
        (toL >= toR ? L : R).merge = true;
        if (toL >= toR) L.b = s.b; else R.a = s.a;
        segs.splice(i, 1); changed = true; break;
      }
      segs = mergeSame(segs);
    }
    // affinage sur la moyenne du segment (meilleure décision pour les 7e), confiance et renversements
    const out = new Array(B);
    for (const s of segs) {
      const avg = new Float64Array(12), bavg = new Float64Array(12);
      for (let b = s.a; b < s.b; b++) { const n = l2(bc[b]); for (let k = 0; k < 12; k++) { avg[k] += bc[b][k] / n; bavg[k] += bb[b][k] / maxn(bb[b]); } }
      let c = s.c, conf = 0;
      if (c !== NC) {
        // parmi les accords de même fondamentale et même mode (majeur/mineur), garder le meilleur sur la moyenne
        const base = chords[c], an = l2(avg), sc = cc => { const ch = chords[cc]; let v = 0; for (let k = 0; k < 12; k++) v += ch.T[k] * avg[k] / an; if (ch.n > 3) v -= 0.025; if (dia.has(ch.r + ':' + ch.q)) v += 0.035; return v; };
        let best = c, bv = sc(c);
        // une 7e (ou 6e) n'est gardée que si la note ajoutée ressort nettement du bruit (distorsion, notes de passage)
        const ok = cc => {
          const ch = chords[cc]; if (ch.n <= 3) return true;
          const ivs = QUAL[ch.q], extra = (ch.r + ivs[3]) % 12, tri = ivs.slice(0, 3).map(iv => (ch.r + iv) % 12);
          const others = []; for (let k = 0; k < 12; k++) if (!ivs.some(iv => (ch.r + iv) % 12 === k)) others.push(avg[k]);
          others.sort((a, b) => a - b);
          const noise = others[others.length >> 1] || 1e-9, triM = tri.reduce((a, k) => a + avg[k], 0) / 3;
          return avg[extra] > 2.2 * noise && avg[extra] > 0.42 * triM;
        };
        if (!ok(best)) { best = -1; bv = -Infinity; }
        for (let cc = 0; cc < C; cc++) if (chords[cc].r === base.r && MINOR_Q.has(chords[cc].q) === MINOR_Q.has(base.q) && ok(cc) && sc(cc) > bv + (best < 0 ? 0 : 0.01)) { best = cc; bv = sc(cc); }
        if (best < 0) best = c;
        c = best;
        // confiance : écart avec le meilleur accord d'une autre fondamentale ou d'un autre mode
        let m = 0, nb = 0;
        for (let b = s.a; b < s.b; b++) {
          let alt = -Infinity;
          for (let cc = 0; cc < C; cc++) if (chords[cc].r !== chords[c].r || MINOR_Q.has(chords[cc].q) !== MINOR_Q.has(chords[c].q)) alt = Math.max(alt, S[b][cc]);
          m += S[b][c] - alt; nb++;
        }
        m /= nb;
        conf = Math.max(0, Math.min(1, (m + 0.01) / 0.09)) * (s.b - s.a === 1 ? 0.75 : 1);
      }
      let lab = c === NC ? null : { r: chords[c].r, q: chords[c].q };
      const bassOf = new Int16Array(s.b - s.a).fill(-1);
      if (lab && opts.inversions) {
        // basse jouée : petit Viterbi parmi les notes de l'accord (la basse peut changer sous un même accord)
        const tones = QUAL[lab.q].map(iv => (lab.r + iv) % 12), n = s.b - s.a, T = tones.length;
        const em = [], bk = [];
        for (let b = s.a; b < s.b; b++) { const m = maxn(bb[b]); em.push(tones.map(t => bb[b][t] / m)); }
        let pv = em[0].slice();
        for (let i = 1; i < n; i++) {
          const nv = new Array(T), kk = new Array(T);
          for (let t = 0; t < T; t++) { let best = -Infinity, bi2 = 0; for (let u = 0; u < T; u++) { const v = pv[u] - (u === t ? 0 : 0.8); if (v > best) { best = v; bi2 = u; } } nv[t] = best + em[i][t]; kk[t] = bi2; }
          bk.push(kk); pv = nv;
        }
        const seq = new Array(n); let bt = 0; for (let t = 1; t < T; t++) if (pv[t] > pv[bt]) bt = t;
        seq[n - 1] = bt; for (let i = n - 1; i > 0; i--) seq[i - 1] = bk[i - 1][seq[i]];
        // pour chaque suite de temps avec la même basse : renversement seulement si la basse est nette
        for (let i = 0; i < n;) {
          let j = i; while (j < n && seq[j] === seq[i]) j++;
          const t = seq[i];
          if (t !== 0 && (j - i >= 2 || n === 1)) {
            let av = 0, ar = 0; for (let k = i; k < j; k++) { av += em[k][t]; ar += em[k][0]; }
            av /= (j - i); ar /= (j - i);
            if (av >= 0.6 && ar < 0.8 * av) for (let k = i; k < j; k++) bassOf[k] = tones[t];
          }
          i = j;
        }
      }
      for (let b = s.a; b < s.b; b++) out[b] = lab ? { r: lab.r, q: lab.q, b: bassOf[b - s.a], c: Math.round(conf * 100) / 100 } : { r: -1, q: '', b: -1, c: 1 };
    }
    // tonalité finale : profils + accord de tonique (durée) pour départager relatif majeur/mineur
    if (!opts.key) key = refineKey(tot, out);
    return { chords: out, key };
  }
  function toSegs(path) {
    const segs = []; let a = 0;
    for (let b = 1; b <= path.length; b++) if (b === path.length || path[b] !== path[a]) { segs.push({ a, b, c: path[a] }); a = b; }
    return segs;
  }
  function mergeSame(segs) {
    const out = [];
    for (const s of segs) { const l = out[out.length - 1]; if (l && l.c === s.c) l.b = s.b; else out.push(s); }
    return out;
  }
  function refineKey(tot, chords) {
    const ks = keyScores(tot).slice(0, 4), dur = {};
    chords.forEach(c => { if (c && c.r >= 0) { const k = c.r + (MINOR_Q.has(c.q) ? 'm' : ''); dur[k] = (dur[k] || 0) + 1; } });
    const total = chords.length || 1, first = chords.find(c => c && c.r >= 0), last = [...chords].reverse().find(c => c && c.r >= 0);
    let best = ks[0], bv = -Infinity;
    for (const k of ks) {
      const tk = k.tonic + (k.mode === 'min' ? 'm' : '');
      let v = k.s + 0.6 * (dur[tk] || 0) / total;
      const isT = c => c && c.r === k.tonic && MINOR_Q.has(c.q) === (k.mode === 'min');
      if (isT(last)) v += 0.08; if (isT(first)) v += 0.04;
      if (v > bv) { bv = v; best = k; }
    }
    return { tonic: best.tonic, mode: best.mode };
  }

  /* ---------------- Étape 4 : métrique et premier temps ---------------- */
  function chordKey(c) { return c ? c.r + ':' + c.q + ':' + c.b + (c.x ? ':' + c.x : '') : ''; }
  function meterAndPhase(chords, lowOnsetAtBeat) {
    const B = chords.length, chg = new Float64Array(B);
    for (let b = 1; b < B; b++) if (chordKey(chords[b]) !== chordKey(chords[b - 1])) chg[b] = 1;
    const total = chg.reduce((a, v) => a + v, 0);
    const best = {};
    for (const M of [4, 3]) {
      let bp = 0, bs = -Infinity;
      for (let p = 0; p < M; p++) {
        let c = 0, lo = 0, n = 0;
        for (let b = p; b < B; b += M) { c += chg[b]; lo += lowOnsetAtBeat ? lowOnsetAtBeat[b] : 0; n++; }
        const s = (total ? c / total : 0) + 0.15 * (n ? lo / n : 0) / (mean(lowOnsetAtBeat) || 1) * (total ? 0.3 : 1);
        if (s > bs) { bs = s; bp = p; }
      }
      best[M] = { phase: bp, ratio: total ? (bs * M) : 0, s: bs };
    }
    const M = total >= 6 && best[3].ratio > best[4].ratio * 1.25 && best[3].s > 0.6 ? 3 : 4;
    return { beatsPerBar: M, phase: best[M].phase };
  }
  const mean = a => { if (!a || !a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; };

  /* ---------------- Mesures ---------------- */
  // Retourne [{beats:[indices], start:index}] ; mesure incomplète au début si phase > 0 (anacrouse)
  // Les premiers temps sont les indices i tels que i ≡ phase (mod beatsPerBar), sur l'intervalle [a, b)
  function makeBars(a, b, beatsPerBar, phase) {
    const bars = []; let i = a;
    const first = a + ((((phase - a) % beatsPerBar) + beatsPerBar) % beatsPerBar);
    if (first > a) { bars.push({ start: a, beats: range(a, Math.min(first, b)), pickup: true }); i = first; }
    for (; i < b; i += beatsPerBar) bars.push({ start: i, beats: range(i, Math.min(i + beatsPerBar, b)) });
    return bars;
  }
  const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };

  // Retirer le silence au début et à la fin (accords « N.C. »)
  function trimBounds(chords) {
    let a = 0, b = chords.length;
    while (a < b && (!chords[a] || chords[a].r < 0)) a++;
    while (b > a && (!chords[b - 1] || chords[b - 1].r < 0)) b--;
    return { a, b };
  }

  function buildBars(chords, beatsPerBar, phase) {
    const { a, b } = trimBounds(chords);
    if (b <= a) return [];
    const bars = makeBars(a, b, beatsPerBar, phase);
    // anacrouse qui ne fait que répéter l'accord de la première mesure (souvent du débordement) : on la retire
    if (bars.length > 1 && bars[0].pickup) {
      const ks = bars[0].beats.map(i => chordKey(chords[i])), first = chordKey(chords[bars[1].start]);
      if (ks.every(k => k === first) || bars[0].beats.length === 1) bars.shift();
    }
    // dernière mesure incomplète d'un seul temps : on l'ajoute à la précédente si c'est le même accord
    const L = bars[bars.length - 1];
    if (bars.length > 1 && L.beats.length < beatsPerBar && L.beats.every(i => chordKey(chords[i]) === chordKey(chords[L.beats[0] - 1]))) bars.pop();
    return bars;
  }

  /* ---------------- Étape 5 : sections (forme) ---------------- */
  // Pour comparer les phrases, on ne garde que la fondamentale et le mode (une 7e ou un renversement de plus ne change pas la section)
  function barSig(bar, chords) { return bar.beats.map(i => { const c = chords[i]; return !c || c.r < 0 ? 'N' : c.r + (MINOR_Q.has(c.q) ? 'm' : ''); }); }
  function simBars(A, B) {
    // proportion de temps identiques entre deux suites de mesures (même longueur)
    let same = 0, n = 0;
    for (let i = 0; i < Math.min(A.length, B.length); i++) { const a = A[i], b = B[i]; for (let j = 0; j < Math.max(a.length, b.length); j++) { n++; if (a[j] !== undefined && a[j] === b[j]) same++; } }
    return n ? same / n : 0;
  }
  // Choix de la longueur des phrases (4 ou 8 mesures) et du décalage de départ : on cherche la façon la plus
  // « économique » d'écrire la grille (peu de matériel unique, peu de différences entre les reprises, peu de sections),
  // avec une petite préférence pour les phrases qui commencent sur l'accord de tonique.
  function findSections(bars, chords, key) {
    const sigs = bars.map(b => barSig(b, chords)), N = bars.length;
    if (N < 6) return [{ start: 0, label: 'A' }];
    const isTonic = i => { if (!key) return false; const c = chords[bars[i].start]; return c && c.r === key.tonic && MINOR_Q.has(c.q) === (key.mode === 'min'); };
    let best = null;
    for (const L of [8, 4]) for (let off = 0; off < Math.min(L, N - L); off++) {
      const phr = []; for (let s = off; s < N; s += L) phr.push({ s, e: Math.min(N, s + L) });
      const reps = [], lab = [];
      let cost = off + (off ? 1.5 : 0);
      for (let i = 0; i < phr.length; i++) {
        const A = sigs.slice(phr[i].s, phr[i].e), len = A.length;
        let found = -1, fs = 0;
        for (let r = 0; r < reps.length; r++) {
          const R = sigs.slice(reps[r].s, reps[r].e).slice(0, len);
          const sim = simBars(A, R);
          if (sim >= 0.7 && sim > fs) { found = r; fs = sim; }
        }
        if (found >= 0) { cost += (1 - fs) * len; lab.push(found); }
        else { reps.push(phr[i]); lab.push(reps.length - 1); cost += len; }
        cost += 1.5 - (isTonic(phr[i].s) ? 0.6 : 0);
      }
      if (!best || cost < best.cost - 1e-9) best = { cost, L, off, phr, lab };
    }
    const secs = [];
    if (best.off > 0) secs.push({ start: 0, label: 'Intro' });
    const letters = 'ABCDEFGHIJKLMNOP';
    // lettres dans l'ordre d'apparition
    const order = []; best.lab.forEach(l => { if (!order.includes(l)) order.push(l); });
    best.phr.forEach((p, i) => {
      if (i > 0 && i === best.phr.length - 1 && p.e - p.s <= 2) return; // petit reste à la fin : il prolonge la section précédente
      const uniqueLast = i === best.phr.length - 1 && p.e - p.s < best.L && !best.lab.slice(0, i).includes(best.lab[i]);
      secs.push({ start: p.s, label: uniqueLast && i > 0 ? 'Outro' : letters[order.indexOf(best.lab[i])] || '?' });
    });
    return secs;
  }

  /* ---------------- Analyse complète ---------------- */
  async function analyze(x, opts, onProgress) {
    opts = opts || {};
    const feat = await extract(x, onProgress);
    const result = await analyzeFeatures(feat, opts);
    onProgress && onProgress(1);
    return result;
  }
  async function analyzeFeatures(feat, opts) {
    const { beats, bpm } = beatsFrom(feat, opts);
    const dec = decode(feat, beats, opts);
    const low = beats.map(t => { const f = Math.round(t * feat.onset.fps); let m = 0; for (let d = -2; d <= 2; d++) m = Math.max(m, feat.onset.low[f + d] || 0); return m; });
    const mp = meterAndPhase(dec.chords, low);
    return { feat, beats, bpm, chords: dec.chords, key: dec.key, beatsPerBar: mp.beatsPerBar, phase: mp.phase, tuning: feat.tuning };
  }

  const api = { SR, analyze, extract, analyzeFeatures, beatsFrom, scaleBeats, decode, meterAndPhase, makeBars, buildBars, findSections, trimBounds, chordKey, keyScores, QUAL, MINOR_Q, VOCAB };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ChartEngine = api;
})(typeof self !== 'undefined' ? self : this);
