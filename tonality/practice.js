/* Tonality — outils de pratique : tempo de la chanson, métronome synchronisé, boucle aimantée sur les temps, décompte.
   Chargé après app.js : utilise ses variables (SRC, P, ctx, eng, CAP, POP, TEMPO, A, B, LOOP…).
   Le métronome suit les temps détectés dans la chanson (pas une grille fixe) : il reste calé même si le musicien accélère. */
'use strict';
const TP = window.TonalityTempo;
const PR = window.PR = {};
PR._grid = () => grid();
PR._bars = () => { const g = grid(); return g ? barsOf(g) : []; };
PR._segs = () => LV.segs;
PR._mlv = () => MLV;
PR._ruler = () => { BR.key = ''; buildRuler(); };
PR._stab = () => ({ dbg: STAB.dbg, n: STAB.n, sig: STAB.sig, busy: MLBUSY, st: MLSTATE, ns: LV.newSec, lock: !!MLLOCK, mla: MLA && MLA.beats.length });
PR._t = { fresh: () => { MLTOKEN++; MLA = null; MLLOCK = null; REF = null; MLBUSY = false; lvReset(); changed(); return MLC ? MLC.reset() : null; }, run: () => { RUN = { kind: "yt", prev: null }; }, finish: () => finishRun(), raw: () => rawTempo() };

/* ---------- état ---------- */
let TT = null, TANA = null, TSAVED = null;   // ancienne détection (secours si l'IA n'est pas disponible)
let MANUAL = null;                            // tempo tapé : {period, anchor} (secondes de chanson)
let MULT = 1;                                 // 2× plus lent (0.5) / 2× plus vite (2)
let METER = null;                             // mesure choisie (null = trouvée)
let ADJ = 0;                                  // déplacement du « 1 » choisi par l'utilisateur, en temps
let SNAP = 'beat';
let COUNTING = false;
const LAT_CAP = 0.04;                          // délai approximatif de la capture d'onglet (le même dans l'analyse et pour les clics : une erreur s'annule)
PR.LAT_CAP = LAT_CAP;
const MET = Object.assign({ on: false, sub: 1, sound: 'bois', vol: 0.7, accent: true, offset: 0, countIn: false, songVol: 1 },
  (() => { try { return JSON.parse(localStorage.getItem('tonality-metro') || '{}'); } catch (e) { return {}; } })());
MET.on = false;
try { SNAP = localStorage.getItem('tonality-snap2') || 'beat'; } catch (e) { }
const saveMetPrefs = () => { try { localStorage.setItem('tonality-metro', JSON.stringify(MET)); localStorage.setItem('tonality-snap2', SNAP); } catch (e) { } };

/* ---------- Beat This! (réseau de neurones, dans un fil de calcul) : source des temps et des premiers temps ----------
   Deux étapes : une grille provisoire pendant l'écoute (qui garde ses choix : même vitesse, même « 1 »),
   puis une grille VERROUILLÉE quand toute la chanson a été analysée. Une grille verrouillée ne bouge plus. */
const ML_OK = !!(window.BeatML && BeatML.supported());
let MLC = null, MLA = null, MLLOCK = null, MLSTATE = '', MLPROG = 0, MLTOKEN = 0, MLBUSY = false, MLV = 0;
let RUN = null;     // analyse complète en cours : {kind:'file'|'yt', prev:{tempo, loop}}
let REF = null;     // choix déjà faits (vitesse des temps, « 1 », mesure) que les analyses suivantes doivent garder
const LV = { seg: -1, segs: new Map(), pend: [], pendLen: 0, sr: 0, lastEnd: null, newSec: 0, total: 0 };
const COV = [];     // portions de la chanson déjà entendues par l'analyse [[a, b], …]
// téléchargement du modèle (une seule fois) : progression
let DLP = null;
const onDl = p => { DLP = p; PR.sync(); };
// deux analyseurs : le petit (rapide) suit l'écoute en direct; le grand (précis) fait l'analyse qui verrouille
let MLB = null;
function mlClient() { if (!MLC) MLC = BeatML.create({ model: 'vendor/beatthis/beatthis_small0_int8.onnx.gz' }); return MLC; }
function bigClient() { if (!MLB) MLB = BeatML.create(); return MLB; }
function lvReset() { LV.seg = -1; LV.segs.clear(); LV.pend = []; LV.pendLen = 0; LV.sr = 0; LV.lastEnd = null; LV.newSec = 0; LV.total = 0; COV.length = 0; }
function covAdd(a, b) {
  COV.push([a, b]); COV.sort((x, y) => x[0] - y[0]);
  const o = []; for (const c of COV) { if (o.length && c[0] <= o[o.length - 1][1] + 0.3) o[o.length - 1][1] = Math.max(o[o.length - 1][1], c[1]); else o.push(c.slice()); }
  COV.length = 0; COV.push(...o);
}
const covered = () => COV.reduce((s, c) => s + c[1] - c[0], 0);
const covHas = (a, b) => COV.some(c => c[0] <= a + 0.05 && c[1] >= b - 0.05);
const changed = () => { MLV++; GRID = null; };

PR.mlFile = async (mono, sr, dur) => {
  if (!ML_OK || MLLOCK) return;
  const token = ++MLTOKEN; MLSTATE = 'loading'; MLPROG = 0; RUN = { kind: 'file' }; PR.sync();
  try {
    const cl = bigClient(); await cl.load(onDl); DLP = null; if (token !== MLTOKEN) return;
    MLSTATE = 'running'; PR.sync();
    const r = await BeatML.analyzeBuffer(cl, mono, sr, p => { if (token === MLTOKEN) { MLPROG = p; PR.sync(); } });
    if (token !== MLTOKEN) return;
    MLLOCK = { beats: r.beats, downs: r.downs, heard: dur, done: true }; MLSTATE = 'done'; changed(); DIRTY = true;
  } catch (e) { if (token === MLTOKEN) MLSTATE = 'error'; console.warn('Tonality : analyse IA des temps impossible', e); }
  if (token === MLTOKEN) RUN = null;
  PR.sync();
};
function mlFlush() {
  if (!LV.pendLen) return;
  const a = new Float32Array(LV.pendLen); let o = 0; for (const c of LV.pend) { a.set(c, o); o += c.length; }
  LV.pend = []; LV.pendLen = 0;
  mlClient().append(LV.seg, a.slice(), LV.sr).catch(() => { });
  bigClient().append(LV.seg, a, LV.sr).catch(() => { });
}
function mlPush(chunk, t0, rate, sr) {
  if (!ML_OK || (MLLOCK && !MLLOCK.partial)) return;   // grille partielle : on continue d'écouter pour la vérifier à la fin
  // l'IA reconnaît mal les temps d'un son ralenti ou accéléré : on n'écoute qu'à vitesse normale
  if (Math.abs(rate - 1) > 0.02) { LV.lastEnd = null; return; }
  if (covHas(t0, t0 + chunk.length / sr * rate)) { LV.lastEnd = null; return; }   // déjà entendu (boucle, retour en arrière)
  // un saut dans la chanson ou un changement de fréquence : nouveau segment
  if (LV.lastEnd == null || Math.abs(t0 - LV.lastEnd) > 0.25 || sr !== LV.sr) {
    mlFlush(); LV.seg++; LV.sr = sr; LV.segs.set(LV.seg, { pieces: [], a: 0, audio: [], sr });
  }
  const sg = LV.segs.get(LV.seg), len = chunk.length / sr;
  const last = sg.pieces[sg.pieces.length - 1];
  const pred = last ? last.t + (sg.a - last.a) * last.rate : null;
  // même segment : on garde une correspondance régulière (médiane des écarts) plutôt que de suivre chaque petit écart d'horloge
  if (!last || last.rate !== rate || Math.abs(pred + (last.fix || 0) - t0) > 0.08) sg.pieces.push({ a: sg.a, t: t0, rate, err: [0] });
  else { last.err.push(t0 - pred); if (last.err.length > 400) last.err.splice(0, 200); last.fix = median(last.err); }
  sg.a += len; LV.lastEnd = t0 + len * rate; covAdd(t0, LV.lastEnd);
  sg.audio.push(new Float32Array(chunk));   // gardé pour l'analyse des accords
  LV.pend.push(new Float32Array(chunk)); LV.pendLen += chunk.length; LV.newSec += len; LV.total += len;
  if (LV.pendLen >= sr) mlFlush();
  if (!PRELOAD) { PRELOAD = true; bigClient().load(onDl).then(() => { DLP = null; PR.sync(); }).catch(() => { }); }
}
let PRELOAD = false;
function audioToMedia(sg, x) { let p = sg.pieces[0]; for (const q of sg.pieces) { if (q.a <= x) p = q; else break; } return p.t + (p.fix || 0) + (x - p.a) * p.rate; }
async function mlRun(final, big) {
  const token = MLTOKEN, cl = big ? bigClient() : mlClient();
  if (!MLA) { MLSTATE = 'loading'; PR.sync(); }
  await cl.load(big ? onDl : undefined); if (big) DLP = null; if (token !== MLTOKEN) return null;
  if (!MLA) { MLSTATE = 'running'; PR.sync(); }
  mlFlush();
  const heardAt = LV.total, covAt = covered();
  const res = await cl.analyze(final ? { final: true } : {});
  if (token !== MLTOKEN) return null;
  let beats = [], downs = [];
  for (const [k, r] of Object.entries(res)) { const sg = LV.segs.get(+k); if (!sg || !sg.pieces.length) continue; beats = beats.concat(r.beats.map(x => audioToMedia(sg, x))); downs = downs.concat(r.downs.map(x => audioToMedia(sg, x))); }
  const dedupe = a => { a.sort((x, y) => x - y); const o = []; for (const t of a) if (!o.length || t - o[o.length - 1] > 0.08) o.push(t); return o; };
  return { beats: dedupe(beats), downs: dedupe(downs), heard: heardAt, cov: covAt };
}
const STAB = { sig: null, n: 0 };
async function mlLive(force) {
  if (!ML_OK || (MLLOCK && !MLLOCK.partial) || MLBUSY || LV.total < 12 || (!force && LV.newSec < 8)) return;
  MLBUSY = true; LV.newSec = 0;
  try {
    const r = await mlRun(false);
    if (r && r.beats.length >= 8) {
      MLA = r; MLSTATE = 'done'; changed();
      // verrouillage automatique : deux analyses de suite qui donnent la même grille, après assez d'écoute
      const g = grid();
      if (g && g.source === 'live' && !MLLOCK) {
        const lastB = r.beats[r.beats.length - 1] - 0.5, downs = g.beats.filter((_, i) => g.pos[i] === 0 && g.beats[i] <= lastB);   // seulement ce qui a vraiment été analysé
        const sig = { p: g.period, meter: g.meter, downs };
        const prev = STAB.sig;
        const same = prev && Math.abs(prev.p - sig.p) / sig.p < 0.01 && prev.meter === sig.meter &&
          prev.downs.length >= 4 && prev.downs.filter(t => downs.some(u => Math.abs(u - t) < 0.06)).length >= prev.downs.length * 0.9;
        if (prev) STAB.dbg = { dp: Math.abs(prev.p - sig.p) / sig.p, m: [prev.meter, sig.meter], match: prev.downs.filter(t => downs.some(u => Math.abs(u - t) < 0.06)).length, of: prev.downs.length, miss: prev.downs.filter(t => !downs.some(u => Math.abs(u - t) < 0.06)).slice(0, 4).map(t => +t.toFixed(2)) };
        STAB.n = same ? STAB.n + 1 : 0; STAB.sig = sig;
        STAB.runs = (STAB.runs || 0) + 1;
        if ((STAB.n >= 1 || STAB.runs >= 3) && LV.total >= 45 && !RUN) { RUN = { kind: 'yt', prev: null, auto: true }; setTimeout(finishRun, 0); }
      }
    }
  }
  catch (e) { MLSTATE = 'error'; console.warn('Tonality : analyse IA des temps impossible', e); }
  finally { MLBUSY = false; }
  PR.sync();
}
// fin de l'analyse complète (YouTube) : dernière analyse, puis on verrouille
let FINISH_FAIL = 0;
async function finishRun() {
  if (!RUN || RUN.kind !== 'yt' || RUN.finishing) return;
  RUN.finishing = true; PR.sync();
  while (MLBUSY) await new Promise(r => setTimeout(r, 100));
  MLBUSY = true;
  let ok = false;
  try {
    const r = LV.total > 5 ? await mlRun(true, true) : null;
    const best = r && r.beats.length >= 8 ? r : MLA && MLA.beats.length >= 8 ? MLA : null;   // au pire, on garde la grille provisoire
    const dur = P.dur() || 0, partial = !!(dur > 30 && ((r && r.cov) != null ? r.cov : covered()) < dur * 0.95);
    if (best) { MLLOCK = Object.assign({}, best, { done: true, partial }); MLA = best; MLSTATE = 'done'; changed(); DIRTY = true; ok = true; }
  } catch (e) { console.warn('Tonality : fin d\'analyse impossible', e); if (MLA && MLA.beats.length >= 8) { MLLOCK = Object.assign({}, MLA, { done: true }); changed(); DIRTY = true; ok = true; } }
  finally { MLBUSY = false; }
  if (!ok) { FINISH_FAIL = Date.now(); setStatus($('src-status'), 'L\'analyse du tempo n\'a pas entendu la chanson. Vérifie que le son transposé est activé (le niveau doit bouger), puis relance « Analyser le tempo ».', 'err'); }
  const prev = RUN.prev; RUN = null;
  if (prev) { LOOP = prev.loop; if (Math.abs(prev.tempo - TEMPO) > 0.001) { TEMPO = prev.tempo; applyTempo(); } syncControls(); }
  if (ok && DIRTY && typeof autoSave === 'function') { try { autoSave(); } catch (e) { } }
  PR.sync();
}
PR.reset = () => {
  if (window.CH) CH.reset();
  STAB.sig = null; STAB.n = 0; STAB.runs = 0;
  TT = null; TANA = null; TSAVED = null; MANUAL = null; MULT = 1; METER = null; ADJ = 0; GRID = null; SCHED.clear(); COUNTING = false; TAPS.length = 0;
  MLTOKEN++; MLA = null; MLLOCK = null; MLSTATE = ''; MLPROG = 0; MLBUSY = false; RUN = null; REF = null; lvReset(); changed(); if (MLC) MLC.reset().catch(() => { }); if (MLB) MLB.reset().catch(() => { });
  SY.tr = null; SY.L0 = null; SY.corr = 0; SY.hist.length = 0;
  PR.sync();
};
PR.newTracker = sr => new TP.Tracker(sr);
PR.setAnalysis = (r, heard) => { if (r) { TANA = r; TANA.heard = heard; } changed(); PR.sync(); };
PR.push = (chunk, t0, rate, sr, fresh = true) => {
  syPush(chunk, t0, rate, sr); if (fresh) { if (!TT || TT.sr !== sr) TT = new TP.Tracker(sr); TT.push(chunk, t0, rate); } mlPush(chunk, t0, rate, sr); };
PR.live = () => {
  mlLive();
  if (useDsp() && TT && TT.frames.length >= 300) { const r = TT.analyze(); if (r) { TANA = r; TANA.heard = TT.heard; changed(); PR.sync(); } }
};
const r2 = x => Math.round(x * 100) / 100;
PR.save = () => {
  const m = MLLOCK || MLA, a = shownTempo();
  return {
    tempo: useDsp() && a ? { bpm: Math.round(a.bpm * 10) / 10, beats: a.beats.map(r2), d4: a.downbeat4, d3: a.downbeat3, mg: a.meterGuess, heard: Math.round((a.heard || 0) * 10) / 10 } : null,
    ml: m ? { beats: m.beats.map(r2), downs: m.downs.map(r2), heard: Math.round((m.heard || 0) * 10) / 10, done: !!m.done, partial: !!m.partial || undefined } : null,
    chords: window.CH ? CH.save() : null,
    manual: MANUAL, mult: MULT, meter: METER, adj: ADJ
  };
};
PR.load = p => {
  p = p || {};
  TSAVED = p.tempo ? { bpm: p.tempo.bpm, beats: p.tempo.beats, downbeat4: p.tempo.d4, downbeat3: p.tempo.d3, meterGuess: p.tempo.mg, heard: p.tempo.heard } : null;
  const m = p.ml && p.ml.beats && p.ml.beats.length >= 8 ? { beats: p.ml.beats, downs: p.ml.downs || [], heard: p.ml.heard || 0, done: !!p.ml.done, partial: !!p.ml.partial } : null;
  MLLOCK = m && m.done ? m : null; if (m && !m.done && !MLA) MLA = m;
  SY.corr = 0; SY.hist.length = 0;
  if (window.CH) CH.load(p.chords);
  // plus de corrections manuelles : on se fie à l'analyse
  MANUAL = null; MULT = 1; METER = null; ADJ = 0; REF = null; changed(); PR.sync();
};
function useDsp() { return !ML_OK || MLSTATE === 'error'; }
function shownTempo() {
  if (TSAVED && (!TANA || (TANA.heard || 0) < (TSAVED.heard || 0) * 0.9)) return TSAVED;
  return TANA;
}
function rawTempo() { // {beats, downs} de la meilleure source, ou null
  if (MLLOCK && MLLOCK.partial && MLA && MLA.beats.length && MLLOCK.beats.length) {
    // grille vérifiée par le grand modèle, puis ce que le petit modèle a entendu depuis
    const end = MLLOCK.beats[MLLOCK.beats.length - 1] - 2.5;
    if (MLA.beats[MLA.beats.length - 1] > end + 4) {
      const cut = (a, b) => a.filter(t => t <= end).concat(b.filter(t => t > end + 0.1));
      return { beats: cut(MLLOCK.beats, MLA.beats), downs: cut(MLLOCK.downs, MLA.downs), heard: MLA.heard, partial: true };
    }
  }
  if (MLLOCK) return MLLOCK;
  if (MLA) return MLA;
  if (useDsp()) {
    const a = shownTempo(); if (!a || !a.beats || a.beats.length < 4) return null;
    const m = a.meterGuess || 4, d0 = (m === 3 ? a.downbeat3 : a.downbeat4) || 0;
    return { beats: a.beats, downs: a.beats.filter((_, i) => i >= d0 && (i - d0) % m === 0), heard: a.heard, dsp: true };
  }
  return null;
}

/* ---------- grille des temps ---------- */
let GRID = null, GRIDKEY = '';
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const nearestIdx = (arr, t) => { let lo = 0, hi = arr.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; } return Math.abs(arr[lo] - t) <= Math.abs(arr[hi] - t) ? lo : hi; };
// Ramène tous les temps à une même « vitesse » de pulsation (évite les passages comptés deux fois trop vite ou trop lentement)
function sameLevel(b, p) {
  const out = [b[0]];
  for (let i = 1; i < b.length; i++) {
    const last = out[out.length - 1], d = b[i] - last;
    if (d < 0.7 * p) { // temps de trop : on garde celui qui tombe le mieux
      const prev = out.length > 1 ? out[out.length - 2] : null;
      if (prev != null && Math.abs((b[i] - prev) - p) < Math.abs((last - prev) - p)) out[out.length - 1] = b[i];
      continue;
    }
    const n = Math.round(d / p);
    if (n >= 2 && n <= 64 && Math.abs(d / n - p) < 0.2 * p) for (let k = 1; k < n; k++) out.push(last + k * d / n);
    out.push(b[i]);
  }
  return out;
}
// Lisse les temps : un métronome garde un tempo régulier, il ne suit pas chaque petite variation de jeu
function regularize(b, p) {
  const runs = []; let st = 0;
  for (let i = 1; i <= b.length; i++) if (i === b.length || b[i] - b[i - 1] > 1.4 * p || b[i] - b[i - 1] < 0.6 * p) { runs.push([st, i]); st = i; }
  const out = new Float64Array(b.length);
  for (const [s0, s1] of runs) {
    const n = s1 - s0;
    const fit = (i0, i1) => { let sx = 0, sy = 0, sxx = 0, sxy = 0; const m = i1 - i0; for (let i = i0; i < i1; i++) { const x = i - s0, y = b[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; } const sl = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1); return { sl, ic: (sy - sl * sx) / m }; };
    if (n < 4) { for (let i = s0; i < s1; i++) out[i] = b[i]; continue; }
    const g = fit(s0, s1); let rms = 0; for (let i = s0; i < s1; i++) rms += (b[i] - (g.ic + g.sl * (i - s0))) ** 2; rms = Math.sqrt(rms / n);
    if (rms < 0.02) { for (let i = s0; i < s1; i++) out[i] = g.ic + g.sl * (i - s0); continue; }   // tempo constant (chanson enregistrée au clic)
    const W = 8;
    for (let i = s0; i < s1; i++) { const l = fit(Math.max(s0, i - W), Math.min(s1, i + W + 1)); out[i] = l.ic + l.sl * (i - s0); }
  }
  return Array.from(out);
}
function grid() {
  const raw = MANUAL ? null : rawTempo();
  const lastKnown = raw && raw.beats.length ? raw.beats[raw.beats.length - 1] : 0;
  const songEnd = Math.max(P.dur() || 0, lastKnown + 1, 30);
  const key = [MLV, MANUAL ? MANUAL.period + ':' + MANUAL.anchor : '', MULT, METER, ADJ, Math.round(songEnd)].join('|');
  if (GRID && key === GRIDKEY) return GRID;
  GRIDKEY = key; GRID = null;
  let beats, downIdx = [], p;
  if (MANUAL) {
    p = MANUAL.period; const k0 = Math.ceil(-MANUAL.anchor / p), k1 = Math.floor((songEnd + 30 - MANUAL.anchor) / p);
    beats = []; for (let k = k0; k <= k1; k++) beats.push(MANUAL.anchor + k * p);
    downIdx = [-k0];
  } else {
    if (!raw || raw.beats.length < 8) return null;
    const d = []; for (let i = 1; i < raw.beats.length; i++) d.push(raw.beats[i] - raw.beats[i - 1]);
    p = median(d);
    // garder la vitesse de pulsation déjà choisie (pas de passage soudain au double ou à la moitié)
    if (REF && !raw.done) { const q = p / REF.period; if (q > 1.7 && q < 2.3) p /= 2; else if (q > 0.43 && q < 0.6) p *= 2; }
    const rb = raw.partial && raw.beats.length > 24 ? raw.beats.filter(t => t < raw.beats[raw.beats.length - 1] - 2.5) : raw.beats;   // fin d'une analyse partielle : moins fiable
    beats = regularize(sameLevel(rb, p), p);
    // avant le premier temps entendu et au-delà du dernier : même tempo (écart médian, position calée sur 16 temps)
    const n = beats.length, med = (i0, i1) => { const dd = []; for (let i = Math.max(1, i0); i < i1; i++) dd.push(beats[i] - beats[i - 1]); return dd.length ? median(dd) : p; };
    const pe = med(n - 64, n), ps = med(0, Math.min(n, 64));
    const endAt = median(beats.slice(-16).map((t, k, arr) => t + (arr.length - 1 - k) * pe));
    const startAt = median(beats.slice(0, 16).map((t, k) => t - k * ps));
    const pre = []; for (let t = startAt - ps; t > -0.001; t -= ps) pre.unshift(t); beats = pre.concat(beats);
    for (let k = 1; endAt + k * pe < songEnd + 30; k++) beats.push(endAt + k * pe);
    for (const t of raw.downs) { const i = nearestIdx(beats, t); if (Math.abs(beats[i] - t) < 0.12) downIdx.push(i); }
  }
  // mesure : nombre de temps le plus fréquent entre deux premiers temps
  let autoMeter = 4;
  if (!MANUAL && downIdx.length >= 3) {
    const cnt = {}; for (let j = 1; j < downIdx.length; j++) { const n = downIdx[j] - downIdx[j - 1]; if (n >= 2 && n <= 7) cnt[n] = (cnt[n] || 0) + 1; }
    let best = 0; for (const [n, c] of Object.entries(cnt)) if (c > best || (c === best && +n === 4)) { best = c; autoMeter = +n; }
    if (REF && !raw.done && REF.meter !== autoMeter && (cnt[REF.meter] || 0) >= best * 0.6) autoMeter = REF.meter;
  } else if (MANUAL) autoMeter = (REF && REF.meter) || 4;
  // 6 temps très rapides = des croches : on revient à 3 temps au tempo de la noire (valse)
  if (!MANUAL && autoMeter === 6 && p < 60 / 130 && downIdx.length >= 2) {
    const par = ((downIdx[0] % 2) + 2) % 2;
    beats = beats.filter((_, i) => i % 2 === par); downIdx = downIdx.filter(i => i % 2 === par).map(i => (i - par) / 2); autoMeter = 3; p *= 2;
  }
  const meter0 = autoMeter;
  // « 1 » : vote sur toute la chanson. On ne change de place qu'après au moins 6 mesures de suite qui le demandent.
  const phases = [];
  if (downIdx.length) {
    const res = downIdx.map(i => ((i % meter0) + meter0) % meter0);
    const vote = rs => { const c = new Array(meter0).fill(0); rs.forEach(r => c[r]++); let b = 0; for (let r = 1; r < meter0; r++) if (c[r] > c[b]) b = r; return { r: b, share: c[b] / rs.length }; };
    let cur = vote(res.slice(0, 8)).r;
    if (REF && !raw.done && REF.anchor != null && !MANUAL) {     // garder le « 1 » déjà entendu, sauf si toute la chanson dit le contraire
      const ri = ((nearestIdx(beats, REF.anchor) % meter0) + meter0) % meter0, all = vote(res);
      cur = all.r !== ri && all.share > 0.75 && res.length >= 8 ? all.r : ri;
    }
    phases.push({ from: -Infinity, r: cur });
    for (let j = 0; j < res.length;) {
      if (res[j] === cur) { j++; continue; }
      let k = j; while (k < res.length && res[k] === res[j]) k++;
      if (k - j >= 6) { cur = res[j]; phases.push({ from: downIdx[j], r: cur }); }
      j = k;
    }
  } else phases.push({ from: -Infinity, r: 0 });
  // corrections : 2× plus vite / plus lent
  let rOf = i => { let r = phases[0].r; for (const ph of phases) if (ph.from <= i) r = ph.r; return r; };
  if (MULT === 2) {
    const o = []; for (let i = 0; i < beats.length; i++) { o.push(beats[i]); if (i + 1 < beats.length) o.push((beats[i] + beats[i + 1]) / 2); }
    const f = rOf; beats = o; rOf = j => 2 * f(j >> 1);
  } else if (MULT === 0.5) {
    const par = phases[0].r % 2, f = rOf; beats = beats.filter((_, i) => i % 2 === par);
    rOf = j => Math.floor((f(2 * j + par) - par) / 2);
  }
  const meter = METER || meter0;
  const pos = new Int8Array(beats.length);
  for (let i = 0; i < beats.length; i++) pos[i] = (((i - rOf(i) - ADJ) % meter) + meter) % meter;
  const dd = []; for (let i = 1; i < Math.min(beats.length, 400); i++) dd.push(beats[i] - beats[i - 1]);
  const source = MANUAL ? 'tap' : raw.dsp ? 'dsp' : MLLOCK ? 'lock' : 'live';
  GRID = { beats, meter, pos, period: median(dd), source };
  // mémoriser les choix (pulsation, « 1 », mesure) pour les prochaines analyses
  if (!MANUAL && !raw.dsp) { const f = pos.indexOf(0), fi = f >= 0 ? f : 0; REF = { period: MULT === 1 ? GRID.period : GRID.period * MULT, meter: meter0, anchor: beats[fi] }; }
  return GRID;
}
const posOf = (g, i) => i >= 0 && i < g.pos.length ? g.pos[i] : 0;
const isDown = (g, i) => posOf(g, i) === 0;
function idxAt(g, t) { // dernier temps <= t
  const b = g.beats; if (t < b[0]) return -1;
  let lo = 0, hi = b.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= t) lo = m; else hi = m; }
  return b[hi] <= t ? hi : lo;
}
// liste des mesures de la chanson : [{n, t, i, end}]
function barsOf(g) {
  const out = [], dur = P.dur() || g.beats[g.beats.length - 1];
  for (let i = 0; i < g.beats.length; i++) if (g.pos[i] === 0 && g.beats[i] < dur - 0.3) out.push({ i, t: g.beats[i] });
  // levée avant la première mesure
  out.forEach((b, k) => { b.n = k + 1; b.end = k + 1 < out.length ? out[k + 1].t : Math.min(dur, b.t + g.period * g.meter); });
  return out;
}

/* ---------- horloge de la chanson (lisse les valeurs de YouTube, qui arrivent par à-coups) ---------- */
const CLK = { t: null, perf: 0, last: null, out: null };
function rateNow() {
  if (SRC && SRC.type === 'file' && media) return media.playbackRate || 1;
  const p = ytp(); if (p) { try { return p.getPlaybackRate() || 1; } catch (e) { } }
  return TEMPO || 1;
}
// position lissée, qui ne recule jamais pendant la lecture (sauf vrai saut : retour en arrière, boucle)
function mediaNow() {
  const raw = P.time(); if (raw == null) return null;
  const now = performance.now();
  if (!P.playing()) { CLK.t = raw; CLK.perf = now; CLK.last = raw; CLK.out = raw; return raw; }
  const rate = rateNow(), pred = CLK.t == null ? raw : CLK.t + (now - CLK.perf) / 1000 * rate;
  let v = pred;
  if (raw !== CLK.last) {
    CLK.last = raw;
    if (CLK.t == null || Math.abs(raw - pred) > 0.3) { CLK.t = raw; CLK.perf = now; CLK.out = raw; return raw; }
    CLK.t = pred + 0.15 * (raw - pred); CLK.perf = now; v = CLK.t;
  }
  if (CLK.out != null && v < CLK.out && CLK.out - v < 0.3) v = CLK.out;
  CLK.out = v;
  return v;
}
PR.mediaNow = mediaNow;

/* ---------- sortie des clics ---------- */
// Quand la vidéo ou le fichier joue plus lentement, l'étirement du temps de Chrome fait entendre la musique un peu plus tôt
// que la position annoncée : compensation mesurée (0,5 → 47 ms, 0,75 → 31 ms, 0,9 → 17 ms, 1 → 0).
function slowCorr(r) {
  const pts = [[0.5, 0.047], [0.75, 0.031], [0.9, 0.017], [1, 0]];
  if (r >= 1) return 0; if (r <= 0.5) return 0.047;
  for (let i = 1; i < pts.length; i++) if (r <= pts[i][0]) { const [r0, c0] = pts[i - 1], [r1, c1] = pts[i]; return c0 + (c1 - c0) * (r - r0) / (r1 - r0); }
  return 0;
}
function clickOut() {
  if (SRC && SRC.type === 'youtube' && CAP && CAP.engine && POP && !POP.closed && POP.ENG && POP.ENG.state === 'active') {
    const E = POP.ENG;
    return { now: () => E.now(), play: (w, l) => E.click(w, MET.sound, l, MET.vol), delay: LAT_CAP + (E.latency() || 0) - slowCorr(rateNow()) };
  }
  if (!ctx) return null;
  return { now: () => ctx.currentTime, play: (w, l) => TonalityAudio.playClick(ctx, w, MET.sound, l, MET.vol), delay: ((SRC && SRC.type === 'file' && eng) ? eng.latency : 0) - slowCorr(rateNow()) };
}

/* ---------- synchronisation automatique (YouTube) ----------
   Le son capturé est comparé en continu à la grille des temps. Si la musique arrive plus tôt ou plus tard que prévu
   (reprise après une pause, délai de capture de Chrome qui change…), les clics et l'affichage se recalent tout seuls. */
const SY = { tr: null, L0: null, corr: 0, hist: [], last: 0, est: null, at: 0 };
const SY_DEFAULT_L0 = 0.005;   // écart habituel entre l'attaque entendue et le temps trouvé par l'IA, mesuré en direct
if (MET.autoSync == null) MET.autoSync = true;
function syPush(chunk, t0, rate, sr) {
  if (!SRC || SRC.type !== 'youtube') return;
  if (!SY.tr || SY.tr.sr !== sr) SY.tr = new TP.Tracker(sr);
  SY.tr.push(chunk, t0, rate);
  const F = SY.tr.frames;
  if (!RUN && F.length > 2400) F.splice(0, F.length - 1600);   // garder ~18 s (tout garder pendant l'analyse complète)
}
function syInterp(ts, vs, t) {
  let lo = 0, hi = ts.length - 1; if (t <= ts[0] || t >= ts[hi]) return 0;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
  const a = (t - ts[lo]) / (ts[hi] - ts[lo] || 1); return vs[lo] * (1 - a) + vs[hi] * a;
}
// décalage (s) qui aligne le mieux les attaques entendues sur la grille, entre t0 et t1
function syEstimate(F, g, t0, t1, center, span) {
  const W = F.filter(f => f.t >= t0 && f.t <= t1); if (W.length < 150 || W[W.length - 1].t - W[0].t < (t1 - t0) * 0.9) return null;
  for (let i = 1; i < W.length; i++) if (W[i].t - W[i - 1].t > 0.1 || W[i].t < W[i - 1].t) return null;   // pas de saut dans la fenêtre
  const ts = W.map(f => f.t), raw = W.map(f => f.v), vs = raw.map((v, i) => (raw[i - 1] || 0) * 0.25 + v * 0.5 + (raw[i + 1] || 0) * 0.25);
  const B = []; for (let i = Math.max(0, idxAt(g, t0)); i < g.beats.length && g.beats[i] < t1; i++) if (g.beats[i] > t0 + span + 0.05 && g.beats[i] < t1 - span - 0.05) B.push(g.beats[i]);
  if (B.length < 6) return null;
  let best = -1, bl = 0, sum = 0, n = 0;
  for (let L = center - span; L <= center + span + 1e-9; L += 0.004) { let sc = 0; for (const b of B) sc += syInterp(ts, vs, b + L); sum += sc; n++; if (sc > best) { best = sc; bl = L; } }
  return best > 1.6 * (sum / n) ? bl : null;
}
setInterval(() => {
  if (!SRC || SRC.type !== 'youtube' || !SY.tr || !MET.autoSync || RUN) return;
  if (!CAP || !P.playing() || Math.abs(rateNow() - 1) > 0.3) { SY.hist.length = 0; return; }
  const g = grid(); if (!g || g.source === 'dsp') return;
  const F = SY.tr.frames; if (F.length < 300) return;
  const t1 = F[F.length - 1].t - 0.05, t0 = t1 - Math.max(4.5, 8 * g.period);
  const L0 = SY.L0 != null ? SY.L0 : SY_DEFAULT_L0;
  const span = Math.min(0.3, 0.45 * g.period);   // au-delà d'un demi-temps, impossible de savoir dans quel sens corriger
  const e = syEstimate(F, g, t0, t1, L0, span);
  SY.at = Date.now();
  if (e == null) return;
  SY.est = e - L0; SY.hist.push(SY.est); if (SY.hist.length > 5) SY.hist.shift();
  const h = SY.hist.slice(-3); if (h.length < 2) return;
  if (Math.max(...h) - Math.min(...h) > 0.025) return;            // mesures pas encore d'accord entre elles
  if (false) return;            // mesures pas encore d'accord entre elles
  const target = median(h), diff = target - SY.corr;
  if (Math.abs(diff) < 0.008) return;
  SY.corr = Math.abs(diff) > 0.035 ? target : SY.corr + 0.6 * diff;
  SCHED.clear(); PR.sync();
}, 1000);
const syncShift = () => (MET.autoSync && SRC && SRC.type === 'youtube' && CAP) ? SY.corr : 0;
PR._sy = SY;

/* ---------- ordonnanceur du métronome ---------- */
const SCHED = new Set();
let lastMt = null;
function ticksBetween(g, t0, t1) {
  const out = [], b = g.beats; let i = Math.max(0, idxAt(g, t0));
  for (; i < b.length - 1 && b[i] <= t1; i++) {
    const step = (b[i + 1] - b[i]) / MET.sub;
    for (let k = 0; k < MET.sub; k++) {
      const e = b[i] + k * step; if (e <= t0 || e > t1) continue;
      out.push({ e, level: k ? 0 : (MET.accent && isDown(g, i) ? 2 : 1) });
    }
  }
  return out;
}
setInterval(() => {
  applySongVol();
  if (!MET.on || COUNTING) return;
  if (!SRC || !P.canSeek() || !P.playing()) { lastMt = null; return; }
  const g = grid(), out = clickOut(); if (!g || !out) return;
  const mt = mediaNow(), rate = rateNow(); if (mt == null) return;
  if (lastMt != null && (mt < lastMt - 0.05 || mt > lastMt + 0.6)) SCHED.clear();
  lastMt = mt;
  const now = out.now(), d = out.delay + MET.offset / 1000 + syncShift() / rate;
  const from = mt - Math.max(0, d) * rate - 0.01, to = mt + 0.22 * rate;
  const loopOn = LOOP && A != null && B != null && B > A + 0.2;
  for (const { e, level } of ticksBetween(g, from, to)) {
    const k = Math.round(e * 1000); if (SCHED.has(k)) continue; SCHED.add(k);
    if (loopOn && e >= B - 0.01) continue;
    const when = now + (e - mt) / rate + d;
    if (when < now - 0.003) continue;
    out.play(when, level);
  }
  if (SCHED.size > 400) { const lim = Math.round((mt - 5) * 1000); for (const k of SCHED) if (k < lim) SCHED.delete(k); }
}, 25);

/* ---------- volume de la chanson ---------- */
let volApplied = null;
function applySongVol() {
  const v = MET.songVol;
  if (SRC && SRC.type === 'file' && eng) { if (eng.__v !== v) { eng.setVolume(v); eng.__v = v; } }
  else if (SRC && SRC.type === 'youtube') { const p = ytp(); if (p && volApplied !== v) { try { p.setVolume(Math.round(v * 100)); volApplied = v; } catch (e) { } } }
}

/* ---------- boucle : fin de boucle, décompte ---------- */
setInterval(() => {
  if (!SRC || COUNTING) return;
  const t = P.time();
  if (LOOP && A != null && B != null && B > A + 0.2 && t != null && t >= B && P.canSeek()) {
    if (MET.countIn && grid()) countIn(); else P.seek(A);
  }
}, 40);
async function countIn() {
  const g = grid(); if (!g) { P.seek(A); return; }
  COUNTING = true;
  P.pause(); P.seek(A);
  if (!ctx) { try { await ensureCtx(); } catch (e) { } }
  const out = clickOut();
  const rate = rateNow(), i = Math.max(0, idxAt(g, A + 0.05)), T = ((g.beats[i + 1] || g.beats[i] + g.period) - g.beats[i]) / rate;
  const M = g.meter, lead = 0.2;
  if (out) { const now = out.now(); for (let k = 0; k < M; k++) out.play(now + lead + k * T, k === 0 ? 2 : 1); }
  countVis(M, T, lead);
  const startLat = SRC.type === 'youtube' ? 0.15 : 0.03;
  const wait = Math.max(0.05, lead + M * T - startLat - (out ? out.delay : 0)) * 1000;
  setTimeout(() => { P.play(); setTimeout(() => { COUNTING = false; lastMt = null; SCHED.clear(); }, 250); }, wait);
}

/* ---------- indicateur visuel des temps ---------- */
let VIS = null, countUntil = 0;
function buildBeats(M) {
  const box = $('m-beats'); if (box.childElementCount === M && box.dataset.m == M) return;
  box.textContent = ''; box.dataset.m = M;
  for (let k = 0; k < M; k++) { const d = mk('div', 'b' + (k === 0 ? ' one' : ''), String(k + 1), box); d.dataset.k = k; }
}
function lightBeat(k) { [...$('m-beats').children].forEach((el, j) => el.classList.toggle('on', j === k)); }
function countVis(M, T, lead) {
  buildBeats(M); const t0 = performance.now() + lead * 1000; countUntil = t0 + M * T * 1000;
  for (let k = 0; k < M; k++) setTimeout(() => lightBeat(k), lead * 1000 + k * T * 1000);
}
function visLoop() {
  requestAnimationFrame(visLoop);
  if ($('practice').hidden) return;
  const g = grid();
  let heard = null;
  if (g) {
    if (P.playing()) { const out = clickOut(), rate = rateNow(), mt = mediaNow(); if (mt != null) heard = mt - ((out ? out.delay : 0) + MET.offset / 1000) * rate - syncShift(); }
    else heard = P.time();
  }
  buildRuler(); paintRuler(heard);
  if (performance.now() < countUntil) return;
  buildBeats(g ? g.meter : (METER || 4));
  const box = $('m-beats');
  if (!g || !P.playing() || heard == null) { box.classList.add('idle'); lightBeat(-1); return; }
  box.classList.remove('idle');
  const i = idxAt(g, heard);
  lightBeat(i < 0 ? -1 : posOf(g, i));
}
requestAnimationFrame(visLoop);

/* ---------- aimant de la boucle ---------- */
function snapTo(t, mode) {
  const g = grid();
  if (!g || mode === 'off') return Math.round(t * 10) / 10;
  const b = g.beats; let best = null, bd = Infinity;
  const i0 = Math.max(0, idxAt(g, t) - g.meter - 1);
  for (let i = i0; i < Math.min(b.length, i0 + 3 * g.meter + 4); i++) {
    if (mode === 'bar' && !isDown(g, i)) continue;
    const d = Math.abs(b[i] - t); if (d < bd) { bd = d; best = b[i]; }
  }
  return best != null ? Math.round(best * 1000) / 1000 : Math.round(t * 10) / 10;
}
function stepFrom(t, dir) {
  const g = grid();
  if (!g || SNAP === 'off') return Math.max(0, Math.round((t + dir * 0.1) * 10) / 10);
  const b = g.beats, i = idxAt(g, t + 1e-3);
  if (dir > 0) { for (let j = Math.max(0, i + 1); j < b.length; j++) if (b[j] > t + 1e-3 && (SNAP === 'beat' || isDown(g, j))) return b[j]; }
  else { for (let j = Math.min(i, b.length - 1); j >= 0; j--) if (b[j] < t - 1e-3 && (SNAP === 'beat' || isDown(g, j))) return b[j]; }
  return t;
}
function barStartAt(t) { const g = grid(); if (!g) return null; for (let i = idxAt(g, t + 0.05); i >= 0; i--) if (isDown(g, i)) return { i, t: g.beats[i] }; const f = g.pos.indexOf(0); return { i: f, t: g.beats[f] }; }
function setLoop(a, b, seek) {
  A = a; B = b; LOOP = true; DIRTY = true;
  syncControls(); renderKeys();
  const t = P.time(); if (seek || (t != null && (t < A || t > B))) P.seek(A);
}
function loopBars(n) {
  const g = grid(); if (!g) return;
  const st = A != null ? barStartAt(snapTo(A, 'bar') + 0.01) : barStartAt(P.time() || 0);
  if (!st) return;
  let j = st.i, c = 0; while (c < n && j < g.beats.length - 1) { j++; if (isDown(g, j)) c++; } if (c < n) return;
  setLoop(st.t, g.beats[j], false);
}

/* ---------- tempo tapé ---------- */
const TAPS = [];
function tap() {
  const now = performance.now();
  if (TAPS.length && now - TAPS[TAPS.length - 1] > 2500) TAPS.length = 0;
  TAPS.push(now); if (TAPS.length > 8) TAPS.shift();
  const b = $('m-tap'); b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse');
  if (TAPS.length < 4) { $('m-bpm-s').textContent = `Continue de taper… (${TAPS.length}/4)`; return; }
  const d = []; for (let i = 1; i < TAPS.length; i++) d.push(TAPS[i] - TAPS[i - 1]);
  const rate = rateNow(), period = median(d) / 1000 * rate;
  const out = clickOut(), mt = P.playing() ? mediaNow() : (P.time() || 0);
  const anchor = mt - (P.playing() ? ((out ? out.delay : 0) + MET.offset / 1000) * rate : 0);
  MANUAL = { period: Math.round(period * 10000) / 10000, anchor: Math.round(anchor * 1000) / 1000 };
  MULT = 1; ADJ = 0; changed(); SCHED.clear(); DIRTY = true;
  PR.sync();
}

/* ---------- règle des mesures (sous la vidéo) ---------- */
const BR = { key: '', cells: [], bars: [], drag: null, userScroll: 0, cur: -1 };
function buildRuler() {
  const box = $('bars'), g = grid();
  const key = g ? MLV + '|' + MULT + '|' + METER + '|' + ADJ + '|' + (MANUAL ? MANUAL.period + ':' + MANUAL.anchor : '') + '|' + Math.round(P.dur() || 0) + '|' + (window.CH ? CH.key() : '') : 'none';
  if (key === BR.key) return;
  BR.key = key; box.textContent = ''; BR.cells = []; BR.cur = -1;
  if (!g) { BR.bars = []; return; }
  BR.bars = barsOf(g);
  for (const b of BR.bars) {
    const c = mk('button', 'bar', null, box); c.type = 'button'; c.dataset.k = b.n - 1;
    c.setAttribute('aria-label', 'Mesure ' + b.n);
    const top = mk('span', 'num', String(b.n), c);
    const sec = window.CH && CH.sectionAt(b); if (sec) { mk('b', 'sec', sec, top); c.classList.add('secstart'); }
    const chd = window.CH ? CH.barText(b, g) : null; if (chd != null) mk('span', 'chd', chd, c);
    const dots = mk('span', 'dots', null, c);
    const nb = Math.max(1, Math.min(12, (idxAt(g, b.end - 0.01) - b.i) + 1));
    for (let k = 0; k < nb; k++) mk('i', k === 0 ? 'one' : '', null, dots);
    BR.cells.push(c);
  }
}
function paintRuler(heard) {
  const g = grid(); if (!g || !BR.cells.length) return;
  const loopOn = A != null && B != null && B > A;
  let cur = -1;
  if (heard != null) { let lo = 0, hi = BR.bars.length - 1; if (heard >= BR.bars[0].t) { while (hi > lo) { const m = (lo + hi + 1) >> 1; if (BR.bars[m].t <= heard + 0.001) lo = m; else hi = m - 1; } cur = lo; } }
  const sel = BR.drag ? [Math.min(BR.drag.k0, BR.drag.k1), Math.max(BR.drag.k0, BR.drag.k1)] : null;
  BR.cells.forEach((c, k) => {
    const b = BR.bars[k];
    const inL = sel ? (k >= sel[0] && k <= sel[1]) : loopOn && b.t >= A - 0.05 && b.end <= B + 0.05;
    c.classList.toggle('inloop', !!inL);
    c.classList.toggle('lstart', !!inL && (sel ? k === sel[0] : Math.abs(b.t - A) < 0.06));
    c.classList.toggle('lend', !!inL && (sel ? k === sel[1] : Math.abs(b.end - B) < 0.06));
    c.classList.toggle('now', k === cur);
  });
  // temps allumé dans la mesure courante
  if (cur !== BR.cur && BR.cur >= 0 && BR.cells[BR.cur]) [...BR.cells[BR.cur].querySelectorAll('i')].forEach(d => d.classList.remove('on'));
  if (cur >= 0) {
    const i = idxAt(g, heard), k = i - BR.bars[cur].i, dots = BR.cells[cur].querySelectorAll('i');
    dots.forEach((d, j) => d.classList.toggle('on', j === k && P.playing()));
    if (cur !== BR.cur && Date.now() - BR.userScroll > 4000) {   // la rangée en cours reste visible
      const box = $('bars'), c = BR.cells[cur];
      const top = c.offsetTop - box.offsetTop, h = c.offsetHeight;
      if (top < box.scrollTop || top + h > box.scrollTop + box.clientHeight) box.scrollTo({ top: Math.max(0, top - h * 0.5), behavior: 'smooth' });
    }
  }
  BR.cur = cur;
}
function cellFromEvent(e) { const el = document.elementFromPoint(e.clientX, e.clientY); const c = el && el.closest && el.closest('#bars .bar'); return c ? +c.dataset.k : null; }
$('bars').addEventListener('pointerdown', e => {
  const k = cellFromEvent(e); if (k == null || e.button > 0) return;
  BR.drag = { k0: k, k1: k, moved: false, id: e.pointerId };
  try { $('bars').setPointerCapture(e.pointerId); } catch (er) { }
  paintRuler(null); e.preventDefault();
});
$('bars').addEventListener('pointermove', e => {
  if (!BR.drag) return; const k = cellFromEvent(e); if (k == null || k === BR.drag.k1) return;
  BR.drag.k1 = k; BR.drag.moved = true; paintRuler(null);
});
const endDrag = e => {
  if (!BR.drag) return; const d = BR.drag; BR.drag = null;
  const b0 = BR.bars[Math.min(d.k0, d.k1)], b1 = BR.bars[Math.max(d.k0, d.k1)];
  if (!b0) return;
  if (d.moved) setLoop(b0.t, b1.end, true);
  else if (e.shiftKey && A != null) { const a = Math.min(A, b0.t), z = Math.max(B || 0, b0.end); setLoop(a, z, false); }
  else {
    if (LOOP && A != null && B != null && (b0.t < A - 0.05 || b0.t >= B - 0.05)) { LOOP = false; syncControls(); }
    P.seek(b0.t); if (!P.playing()) setTimeout(() => updateTransport && updateTransport(), 60);
  }
  paintRuler(null);
};
$('bars').addEventListener('pointerup', endDrag);
$('bars').addEventListener('pointercancel', () => { BR.drag = null; paintRuler(null); });
$('bars').addEventListener('wheel', () => BR.userScroll = Date.now(), { passive: true });
$('bars').addEventListener('touchmove', () => BR.userScroll = Date.now(), { passive: true });

/* ---------- analyse complète (bouton « Analyser le tempo ») ---------- */
async function startAnalysis() {
  if (!SRC) return;
  if (SRC.type === 'file') { PR.redo(); return; }
  if (SRC.type !== 'youtube' || !P.canSeek()) return;
  if (!CAP) {   // l'IA doit entendre la chanson : on active d'abord le son
    activate();
    setStatus($('src-status'), 'Pour analyser le tempo, Tonality doit entendre la chanson : choisis l\'onglet Tonality dans la petite fenêtre « Moteur audio ». L\'analyse commencera ensuite.');
    PENDING_RUN = Date.now(); PR.sync(); return;
  }
  MLTOKEN++; MLA = null; MLLOCK = null; MLSTATE = ''; MLBUSY = false; REF = null; lvReset(); changed();
  if (MLC) await MLC.reset().catch(() => { });
  if (MLB) await MLB.reset().catch(() => { });
  RUN = { kind: 'yt', prev: { tempo: TEMPO, loop: LOOP }, t0: Date.now() };
  SY.tr = null; SY.L0 = null; SY.corr = 0; SY.hist.length = 0;
  if (Math.abs(TEMPO - 1) > 0.001) { TEMPO = 1; applyTempo(); }
  LOOP = false; syncControls();
  P.seek(0); P.play();
  PR.sync();
}
let PENDING_RUN = 0;
setInterval(() => {   // démarrer l'analyse demandée dès que le son est actif
  if (PENDING_RUN && CAP && SRC && SRC.type === 'youtube') { PENDING_RUN = 0; startAnalysis(); }
  if (PENDING_RUN && Date.now() - PENDING_RUN > 120000) PENDING_RUN = 0;
}, 500);
function stopAnalysis() {
  if (!RUN || RUN.kind !== 'yt') return;
  const prev = RUN.prev; RUN = null;
  if (prev) { LOOP = prev.loop; if (Math.abs(prev.tempo - TEMPO) > 0.001) { TEMPO = prev.tempo; applyTempo(); } syncControls(); }
  PR.sync();
}
PR.redo = () => {   // refaire : on oublie la grille verrouillée et les corrections
  MANUAL = null; MULT = 1; METER = null; ADJ = 0; MLLOCK = null; REF = null; changed(); DIRTY = true;
  if (SRC && SRC.type === 'file' && window.__lastMono) PR.mlFile(window.__lastMono.mono, window.__lastMono.sr, window.__lastMono.dur);
  else if (SRC && (SRC.type === 'youtube' || SRC.type === 'tab')) { MLTOKEN++; MLA = null; MLSTATE = ''; MLBUSY = false; STAB.sig = null; STAB.n = 0; STAB.runs = 0; lvReset(); SY.tr = null; if (MLC) MLC.reset().catch(() => { }); if (MLB) MLB.reset().catch(() => { }); }
  PR.sync();
};
function keepTempo() { const m = MLA; if (!m) return; MLLOCK = Object.assign({}, m, { done: true }); STAB.sig = null; STAB.n = 0; changed(); DIRTY = true; if (typeof autoSave === 'function') { try { autoSave(); } catch (e) { } } PR.sync(); }
// fin de chanson atteinte pendant l'analyse, ou chanson presque entièrement entendue en écoutant normalement
setInterval(() => {
  if (!SRC || SRC.type !== 'youtube' || (MLLOCK && !MLLOCK.partial)) return;
  const dur = P.dur(), t = P.time();
  if (RUN && RUN.kind === 'yt') {
    if (Math.abs(rateNow() - 1) > 0.02 && P.playing()) { try { ytp().setPlaybackRate(1); } catch (e) { } }
    if (dur && t != null && (t >= dur - 1.2 || (covered() >= dur * 0.97))) finishRun();
  } else if (dur > 30 && covered() >= dur * 0.97 && LV.total > 30 && Date.now() - FINISH_FAIL > 60000) { RUN = { kind: 'yt', prev: null }; finishRun(); }
}, 500);

/* ---------- affichage ---------- */
const fmtMs = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
PR.sync = () => {
  if (!$('m-bpm')) return;
  const g = grid(), rate = TEMPO || 1;
  $('m-on').setAttribute('aria-pressed', MET.on ? 'true' : 'false');
  $('m-on').textContent = MET.on ? 'Métronome activé' : 'Activer le métronome';
  if (g) {
    const bpm = 60 / g.period;
    $('m-bpm').textContent = Math.round(bpm * rate);
    $('m-bpm-s').textContent = Math.abs(rate - 1) > 0.001 ? `Tempo original : ${Math.round(bpm)} BPM · vitesse ${Math.round(rate * 100)} %` : `${g.meter} temps par mesure`;
  } else { $('m-bpm').textContent = '—'; $('m-bpm-s').textContent = ''; }
  // --- bloc d'analyse ---
  const yt = SRC && SRC.type === 'youtube', file = SRC && SRC.type === 'file', tab = SRC && SRC.type === 'tab';
  const st = $('m-ana'), dur = P.dur() || 0;
  let mode = 'none';
  if (!SRC) mode = 'nosrc';
  else if (MANUAL) mode = 'tap';
  else if (RUN) mode = 'run';
  else if (MLLOCK) mode = 'lock';
  else if (useDsp()) mode = 'dsp';
  else if (yt || tab) mode = 'idle';
  else if (file) mode = MLSTATE === 'error' ? 'dsp' : 'run';
  st.dataset.mode = mode;
  $('m-analyze').hidden = true;
  $('m-prog').hidden = !(mode === 'run' || (mode === 'idle' && covered() > 1 && dur));
  $('m-cancel').hidden = !(mode === 'run' && RUN && RUN.kind === 'yt');
  $('m-keep').hidden = true;
  $('m-done').hidden = !(mode === 'lock' || mode === 'tap');
  let pct = 0, ptxt = '', note = '';
  if (mode === 'run') {
    if (RUN && RUN.auto) { pct = DLP != null && DLP < 1 ? DLP : 1; ptxt = DLP != null && DLP < 1 ? `Téléchargement… ${Math.round(DLP * 100)} %` : 'Vérification…'; note = 'Le tempo est stable : vérification précise, puis il se fixe.'; }
    else if (RUN && RUN.kind === 'yt') {
      pct = dur ? Math.min(1, covered() / dur) : 0; const left = dur ? dur * (1 - pct) : 0;
      ptxt = `Analyse… ${Math.round(pct * 100)} %`;
      if (DLP != null && DLP < 1) { ptxt += ` · téléchargement ${Math.round(DLP * 100)} %`; }
      note = RUN.finishing ? 'Dernière vérification…' : !CAP ? 'Le son transposé n\'est pas activé : l\'analyse n\'entend rien. Clique sur « Activer le son transposé ».' : `La chanson joue du début à la fin à vitesse normale. Encore environ ${fmtMs(left)}.`;
    } else {
      if (DLP != null && DLP < 1) { pct = DLP; ptxt = `Téléchargement… ${Math.round(pct * 100)} %`; note = 'Téléchargement de l\'analyse des temps (75 Mo, une seule fois par appareil).'; }
      else { pct = MLSTATE === 'loading' ? 0.02 : MLPROG; ptxt = `Analyse… ${Math.round(pct * 100)} %`; note = MLSTATE === 'loading' ? 'Préparation de l\'analyse des temps…' : 'Analyse des temps et des mesures du fichier.'; }
    }
  } else if (mode === 'idle') {
    pct = dur ? Math.min(1, covered() / dur) : 0; ptxt = `Écouté : ${Math.round(pct * 100)} %`;
    note = !CAP ? 'Active le son transposé et fais jouer la chanson : le tempo s\'analyse pendant l\'écoute.'
      : Math.abs((TEMPO || 1) - 1) > 0.02 ? 'L\'analyse du tempo écoute seulement à vitesse 100 %.'
      : g ? 'Tempo provisoire : il se fixe tout seul dès qu\'il est sûr.' : 'Analyse du tempo pendant l\'écoute : les temps apparaissent après une douzaine de secondes.';
  } else if (mode === 'lock') {
    $('m-done-t').textContent = `Tempo analysé et verrouillé · ${Math.round(60 / g.period)} BPM · ${g.meter} temps`;
    note = (MULT !== 1 || METER || ADJ ? 'Avec tes corrections. ' : '') + (OPENED ? '' : 'Enregistre la chanson dans ta librairie (Fiche de la chanson) pour garder cette analyse.');
  } else if (mode === 'tap') { $('m-done-t').textContent = `Tempo tapé · ${g ? Math.round(60 / g.period) : '—'} BPM`; note = ''; }
  else if (mode === 'dsp') note = g ? 'Tempo détecté (méthode simple).' : 'Le tempo apparaît après quelques secondes d\'écoute. Tu peux aussi le taper.';
  else if (mode === 'nosrc') note = 'Ouvre une chanson pour trouver son tempo.';
  $('m-prog-i').style.width = Math.round(pct * 100) + '%';
  $('m-prog-t').textContent = ptxt;
  $('m-ana-n').textContent = note; $('m-ana-n').hidden = !note;
  $('m-redo').textContent = mode === 'tap' ? 'Revenir à l\'analyse' : 'Refaire l\'analyse';
  // --- corrections ---
  ['m-half', 'm-double', 'm-one', 'm-prev', 'm-next', 'm-meter'].forEach(id => $(id).disabled = !g);
  $('m-half').setAttribute('aria-pressed', String(MULT === 0.5)); $('m-double').setAttribute('aria-pressed', String(MULT === 2));
  $('m-meter').value = String(g ? g.meter : (METER || 4));
  document.querySelectorAll('[data-sub]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.sub === MET.sub)));
  $('m-sound').value = MET.sound; $('m-accent').checked = MET.accent; $('o-countin').checked = MET.countIn;
  $('m-vol').value = Math.round(MET.vol * 100); $('m-vol-v').textContent = Math.round(MET.vol * 100) + ' %';
  $('s-vol').value = Math.round(MET.songVol * 100); $('s-vol-v').textContent = Math.round(MET.songVol * 100) + ' %';
  $('m-autosync').checked = !!MET.autoSync;
  $('m-sync-v').textContent = !(SRC && SRC.type === 'youtube') ? '(YouTube seulement)' : !MET.autoSync ? '' : SY.corr ? `correction actuelle : ${SY.corr > 0 ? '+' : '−'}${Math.round(Math.abs(SY.corr) * 1000)} ms` : 'en place';
  $('m-off').value = MET.offset; $('m-off-v').textContent = (MET.offset > 0 ? '+' : MET.offset < 0 ? '−' : '') + Math.abs(MET.offset) + ' ms';
  // --- règle des mesures ---
  buildRuler();
  $('bars-card').hidden = !SRC || $('practice').hidden;
  $('bars-empty').hidden = !!g; $('bars').hidden = !g;
  $('bars-empty').textContent = !SRC ? '' : yt && !MLA && !MLLOCK && !MANUAL ? 'Les mesures apparaîtront ici après l\'analyse du tempo (bouton « Analyser le tempo » dans le métronome).'
    : 'Les mesures apparaîtront ici dès que le tempo sera trouvé.';
  $('bars-info').textContent = g ? (g.source === 'live' ? 'Provisoire' : g.source === 'tap' ? 'Tempo tapé' : '🔒 Verrouillé') : '';
  if (window.CH) {
    const cs = CH.status(); $('ch-st').textContent = cs; $('ch-st').hidden = !cs;
    $('bars-card').classList.toggle('withchords', CH.has());
    $('ch-on').checked = CH.shown();
    if (CH.has() && CAPO) $('bars-info').textContent += ` · formes pour capo ${CAPO}`;
  }
  // --- boucle ---
  document.querySelectorAll('[data-snap]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.snap === SNAP)); b.disabled = b.dataset.snap !== 'off' && !g; });
  document.querySelectorAll('[data-bars]').forEach(b => b.disabled = !g);
  $('snap-note').textContent = g ? (SNAP === 'off' ? 'Les flèches ◀ ▶ déplacent les points de 0,1 s.' : SNAP === 'beat' ? 'A et B se placent sur le temps le plus proche; ◀ ▶ avancent d\'un temps.' : 'A et B se placent au début de la mesure la plus proche; ◀ ▶ avancent d\'une mesure.')
    : 'Quand le tempo sera trouvé, A et B s\'aimanteront aux temps.';
  let info = '';
  if (A != null && B != null && B > A) {
    if (g) {
      const ia = idxAt(g, A + 0.02), ib = idxAt(g, B + 0.02), nb = ib - ia;
      let bars = 0; for (let k = ia; k < ib; k++) if (isDown(g, k)) bars++;
      info = nb > 0 && isDown(g, ia) && isDown(g, ib) && bars > 0 ? `${bars} ${bars > 1 ? 'mesures' : 'mesure'} · ` : nb > 0 ? `${nb} temps · ` : '';
    }
    const len = B - A; info += len >= 60 ? fmtT1(len) : len.toFixed(1).replace('.', ',') + ' s';
  }
  $('loop-info').textContent = info;
};

/* ---------- branchements ---------- */
const fix = f => () => { f(); changed(); SCHED.clear(); DIRTY = true; PR.sync(); };
$('ch-on').onchange = e => { if (window.CH) CH.setShow(e.target.checked); };
$('m-on').onclick = async () => {
  MET.on = !MET.on;
  if (MET.on) { try { await ensureCtx(); } catch (e) { } SCHED.clear(); lastMt = null; }
  PR.sync();
};
$('m-analyze').onclick = startAnalysis;
$('m-cancel').onclick = stopAnalysis;
$('m-keep').onclick = keepTempo;
$('m-redo').onclick = () => { if (MANUAL) { MANUAL = null; TAPS.length = 0; changed(); DIRTY = true; PR.sync(); } else PR.redo(); };
$('m-half').onclick = fix(() => { MULT = MULT === 0.5 ? 1 : MULT === 2 ? 1 : 0.5; ADJ = 0; });
$('m-double').onclick = fix(() => { MULT = MULT === 2 ? 1 : MULT === 0.5 ? 1 : 2; ADJ = 0; });
$('m-prev').onclick = fix(() => { ADJ -= 1; });
$('m-next').onclick = fix(() => { ADJ += 1; });
$('m-tap').onclick = tap;
$('m-meter').onchange = fix(() => { METER = +$('m-meter').value; });
$('m-one').onclick = () => {
  const g = grid(); if (!g) return;
  const out = clickOut(), rate = rateNow(), mt = P.playing() ? mediaNow() : P.time();
  if (mt == null) return;
  const heard = mt - (P.playing() ? ((out ? out.delay : 0) + MET.offset / 1000) * rate : 0) - (P.playing() ? 0.06 * rate : 0); // on appuie un peu en retard
  const i = Math.max(0, idxAt(g, heard)), j = (i + 1 < g.beats.length && Math.abs(g.beats[i + 1] - heard) < Math.abs(g.beats[i] - heard)) ? i + 1 : i;
  const p = g.pos[j]; if (!p) return;
  fix(() => { ADJ += p; })();
};
document.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { MET.sub = +b.dataset.sub; saveMetPrefs(); SCHED.clear(); PR.sync(); });
$('m-sound').onchange = e => { MET.sound = e.target.value; saveMetPrefs(); if (ctx) TonalityAudio.playClick(ctx, ctx.currentTime + 0.02, MET.sound, 2, MET.vol); };
$('m-accent').onchange = e => { MET.accent = e.target.checked; saveMetPrefs(); SCHED.clear(); };
$('o-countin').onchange = e => { MET.countIn = e.target.checked; saveMetPrefs(); };
$('m-vol').oninput = e => { MET.vol = +e.target.value / 100; $('m-vol-v').textContent = e.target.value + ' %'; saveMetPrefs(); };
$('s-vol').oninput = e => { MET.songVol = +e.target.value / 100; $('s-vol-v').textContent = e.target.value + ' %'; saveMetPrefs(); };
$('m-autosync').onchange = e => { MET.autoSync = e.target.checked; SY.hist.length = 0; saveMetPrefs(); SCHED.clear(); PR.sync(); };
$('m-off').oninput = e => { MET.offset = +e.target.value; saveMetPrefs(); SCHED.clear(); PR.sync(); };
document.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => {
  SNAP = b.dataset.snap; saveMetPrefs();
  if (SNAP !== 'off') { if (A != null) A = snapTo(A, SNAP); if (B != null) { B = snapTo(B, SNAP); if (A != null && B <= A) B = stepFrom(A, 1); } syncControls(); renderKeys(); }
  PR.sync();
});
document.querySelectorAll('[data-bars]').forEach(b => b.onclick = () => loopBars(+b.dataset.bars));
// points A et B : on appuie souvent un peu après le temps voulu
const heardNow = () => { const t = P.time(); if (t == null) return null; return P.playing() ? t - 0.08 * rateNow() : t; };
$('set-a').onclick = () => { const t = heardNow(); if (t == null) return; A = snapTo(t, SNAP); if (B != null && B <= A + 0.05) B = null; DIRTY = true; syncControls(); renderKeys(); };
$('set-b').onclick = () => {
  const t = heardNow(); if (t == null) return;
  const v = snapTo(t, SNAP);
  if (A != null && v <= A + 0.05) { setStatus($('src-status'), 'Le point B doit venir après le point A.', 'err'); return; }
  B = v; if (A != null) LOOP = true; DIRTY = true; syncControls(); renderKeys();
};
$('a-m').onclick = () => { if (A == null) return; A = stepFrom(A, -1); syncControls(); renderKeys(); };
$('a-p').onclick = () => { if (A == null) return; const v = stepFrom(A, 1); if (B == null || v < B - 0.05) A = v; syncControls(); renderKeys(); };
$('b-m').onclick = () => { if (B == null) return; const v = stepFrom(B, -1); if (A == null || v > A + 0.05) B = v; syncControls(); renderKeys(); };
$('b-p').onclick = () => { if (B == null) return; B = stepFrom(B, 1); syncControls(); renderKeys(); };
// mise à jour régulière (tempo qui se précise, progression de l'analyse)
setInterval(() => { if (!$('practice').hidden) PR.sync(); }, 1000);
PR.sync();
