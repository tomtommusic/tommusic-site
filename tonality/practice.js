/* Tonality — outils de pratique : tempo de la chanson, métronome synchronisé, boucle aimantée sur les temps, décompte.
   Chargé après app.js : utilise ses variables (SRC, P, ctx, eng, CAP, POP, TEMPO, A, B, LOOP…).
   Le métronome suit les temps détectés dans la chanson (pas une grille fixe) : il reste calé même si le musicien accélère. */
'use strict';
const TP = window.TonalityTempo;
const PR = window.PR = {};
PR._grid = () => grid();

/* ---------- état ---------- */
let TT = null, TANA = null, TSAVED = null;   // suivi du tempo, analyse en cours, analyse enregistrée
let MANUAL = null;                            // tempo tapé : {period, anchor} (secondes de chanson)
let MULT = 1;                                 // ×2 / ÷2
let METER = null;                             // mesure choisie (null = devinée)
let DBT = null;                               // moment d'un premier temps choisi par l'utilisateur
let SNAP = 'off';
let COUNTING = false;
const LAT_CAP = 0.04;                          // délai approximatif de la capture d'onglet
const MET = Object.assign({ on: false, sub: 1, sound: 'bois', vol: 0.7, accent: true, offset: 0, countIn: false, songVol: 1 },
  (() => { try { return JSON.parse(localStorage.getItem('tonality-metro') || '{}'); } catch (e) { return {}; } })());
MET.on = false;
try { SNAP = localStorage.getItem('tonality-snap') || 'off'; } catch (e) { }
const saveMetPrefs = () => { try { localStorage.setItem('tonality-metro', JSON.stringify(MET)); localStorage.setItem('tonality-snap', SNAP); } catch (e) { } };

/* ---------- alimentation des analyses (appelé par app.js) ---------- */
/* ---------- Beat This! (réseau de neurones, dans un fil de calcul) : source principale des temps et des premiers temps ---------- */
const ML_OK = !!(window.BeatML && BeatML.supported());
let MLC = null, MLA = null, MLSAVED = null, MLSTATE = '', MLPROG = 0, MLTOKEN = 0, MLBUSY = false;
const LV = { seg: -1, segs: new Map(), pend: [], pendLen: 0, sr: 0, lastEnd: null, newSec: 0, total: 0 };
function mlClient() { if (!MLC) MLC = BeatML.create(); return MLC; }
function lvReset() { LV.seg = -1; LV.segs.clear(); LV.pend = []; LV.pendLen = 0; LV.sr = 0; LV.lastEnd = null; LV.newSec = 0; LV.total = 0; }
PR.mlFile = async (mono, sr, dur) => {
  if (!ML_OK) return;
  const token = ++MLTOKEN; MLSTATE = 'loading'; MLPROG = 0; PR.sync();
  try {
    const cl = mlClient(); await cl.load(); if (token !== MLTOKEN) return;
    MLSTATE = 'running'; PR.sync();
    const r = await BeatML.analyzeBuffer(cl, mono, sr, p => { if (token === MLTOKEN) { MLPROG = p; PR.sync(); } });
    if (token !== MLTOKEN) return;
    MLA = { beats: r.beats, downs: r.downs, heard: dur }; MLSTATE = 'done'; GRID = null;
  } catch (e) { if (token === MLTOKEN) MLSTATE = 'error'; console.warn('Tonality : analyse IA des temps impossible', e); }
  PR.sync();
};
function mlFlush() {
  if (!LV.pendLen) return;
  const a = new Float32Array(LV.pendLen); let o = 0; for (const c of LV.pend) { a.set(c, o); o += c.length; }
  LV.pend = []; LV.pendLen = 0;
  mlClient().append(LV.seg, a, LV.sr).catch(() => { });
}
function mlPush(chunk, t0, rate, sr) {
  if (!ML_OK) return;
  // un saut dans la chanson (retour en arrière déjà filtré, saut avant, changement de fréquence) : nouveau segment
  if (LV.lastEnd == null || Math.abs(t0 - LV.lastEnd) > 0.25 || sr !== LV.sr) {
    mlFlush(); LV.seg++; LV.sr = sr; LV.segs.set(LV.seg, { pieces: [], a: 0 });
  }
  const sg = LV.segs.get(LV.seg), len = chunk.length / sr;
  const last = sg.pieces[sg.pieces.length - 1];
  const pred = last ? last.t + (sg.a - last.a) * last.rate : null;
  if (!last || last.rate !== rate || Math.abs(pred - t0) > 0.02) sg.pieces.push({ a: sg.a, t: t0, rate });
  sg.a += len; LV.lastEnd = t0 + len * rate;
  LV.pend.push(new Float32Array(chunk)); LV.pendLen += chunk.length; LV.newSec += len; LV.total += len;
  if (LV.pendLen >= sr) mlFlush();
}
function audioToMedia(sg, x) { let p = sg.pieces[0]; for (const q of sg.pieces) { if (q.a <= x) p = q; else break; } return p.t + (x - p.a) * p.rate; }
async function mlLive() {
  if (!ML_OK || MLBUSY || LV.total < 12 || LV.newSec < 8) return;
  MLBUSY = true; LV.newSec = 0; mlFlush();
  const token = MLTOKEN;
  try {
    if (!MLA) { MLSTATE = 'loading'; PR.sync(); }
    await mlClient().load(); if (token !== MLTOKEN) return;
    if (!MLA) { MLSTATE = 'running'; PR.sync(); }
    const res = await mlClient().analyze({});
    if (token !== MLTOKEN) return;
    let beats = [], downs = [];
    for (const [k, r] of Object.entries(res)) { const sg = LV.segs.get(+k); if (!sg || !sg.pieces.length) continue; beats = beats.concat(r.beats.map(x => audioToMedia(sg, x))); downs = downs.concat(r.downs.map(x => audioToMedia(sg, x))); }
    const dedupe = a => { a.sort((x, y) => x - y); const o = []; for (const t of a) if (!o.length || t - o[o.length - 1] > 0.08) o.push(t); return o; };
    MLA = { beats: dedupe(beats), downs: dedupe(downs), heard: LV.total }; MLSTATE = 'done'; GRID = null;
  } catch (e) { if (token === MLTOKEN) MLSTATE = 'error'; console.warn('Tonality : analyse IA des temps impossible', e); }
  finally { MLBUSY = false; }
  PR.sync();
}
PR.reset = () => {
  TT = null; TANA = null; TSAVED = null; MANUAL = null; MULT = 1; METER = null; DBT = null; GRID = null; SCHED.clear(); COUNTING = false; TAPS.length = 0;
  MLTOKEN++; MLA = null; MLSAVED = null; MLSTATE = ''; MLPROG = 0; MLBUSY = false; lvReset(); if (MLC) MLC.reset().catch(() => { });
  PR.sync();
};
PR.newTracker = sr => new TP.Tracker(sr);
PR.setAnalysis = (r, heard) => { if (r) { TANA = r; TANA.heard = heard; } GRID = null; PR.sync(); };
PR.push = (chunk, t0, rate, sr) => { if (!TT || TT.sr !== sr) TT = new TP.Tracker(sr); TT.push(chunk, t0, rate); mlPush(chunk, t0, rate, sr); };
PR.live = () => { mlLive(); if (!TT || TT.frames.length < 300) return; const r = TT.analyze(); if (r) { TANA = r; TANA.heard = TT.heard; GRID = null; PR.sync(); } };
PR.save = () => {
  const a = shownTempo();
  return {
    tempo: a ? { bpm: Math.round(a.bpm * 10) / 10, beats: a.beats.map(x => Math.round(x * 100) / 100), d4: a.downbeat4, d3: a.downbeat3, mg: a.meterGuess, heard: Math.round((a.heard || 0) * 10) / 10 } : null,
    ml: (() => { const m = mlTempo(); return m ? { beats: m.beats.map(x => Math.round(x * 100) / 100), downs: m.downs.map(x => Math.round(x * 100) / 100), heard: Math.round((m.heard || 0) * 10) / 10 } : null; })(),
    manual: MANUAL, mult: MULT, meter: METER, dbt: DBT
  };
};
PR.load = p => {
  p = p || {};
  TSAVED = p.tempo ? { bpm: p.tempo.bpm, beats: p.tempo.beats, downbeat4: p.tempo.d4, downbeat3: p.tempo.d3, meterGuess: p.tempo.mg, heard: p.tempo.heard } : null;
  MLSAVED = p.ml && p.ml.beats && p.ml.beats.length ? { beats: p.ml.beats, downs: p.ml.downs || [], heard: p.ml.heard || 0 } : null;
  MANUAL = p.manual || null; MULT = p.mult || 1; METER = p.meter || null; DBT = p.dbt != null ? p.dbt : null; GRID = null; PR.sync();
};
function mlTempo() {
  if (MLSAVED && (!MLA || (MLA.heard || 0) < (MLSAVED.heard || 0) * 0.9)) return MLSAVED;
  return MLA;
}
function shownTempo() {
  if (TSAVED && (!TANA || (TANA.heard || 0) < (TSAVED.heard || 0) * 0.9)) return TSAVED;
  return TANA;
}

/* ---------- grille des temps ---------- */
let GRID = null, GRIDKEY = '';
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
// temps manquants (passage doux, silence) : on les complète si l'écart vaut un nombre entier de temps
function fillGaps(b) {
  if (b.length < 3) return b.slice();
  const d = []; for (let i = 1; i < b.length; i++) d.push(b[i] - b[i - 1]);
  const p = median(d), out = [b[0]];
  for (let i = 1; i < b.length; i++) {
    const gap = b[i] - b[i - 1], n = Math.round(gap / p);
    if (n >= 2 && n <= 16 && Math.abs(gap / n - p) < 0.25 * p) for (let k = 1; k < n; k++) out.push(b[i - 1] + k * gap / n);
    out.push(b[i]);
  }
  return out;
}
function grid() {
  const ml = MANUAL ? null : mlTempo(), a = shownTempo();
  const lastKnown = ml && ml.beats.length ? ml.beats[ml.beats.length - 1] : a ? a.beats[a.beats.length - 1] : 0;
  const songEnd = Math.max(P.dur() || 0, lastKnown + 1, 30);
  const key = [ml ? 'ml' + ml.beats.length + ':' + ml.downs.length + ':' + ml.beats[0] + ':' + (ml.heard || 0) : '', a ? a.beats.length + ':' + a.beats[0] + ':' + (a.heard || 0) : '-', MANUAL ? MANUAL.period + ':' + MANUAL.anchor : '', MULT, METER, DBT, Math.round(songEnd)].join('|');
  if (GRID && key === GRIDKEY) return GRID;
  GRIDKEY = key; GRID = null;
  const useML = !!(ml && ml.beats.length >= 8);
  let beats;
  if (MANUAL) {
    const p = MANUAL.period, k0 = Math.ceil(-MANUAL.anchor / p), k1 = Math.floor((songEnd + 30 - MANUAL.anchor) / p);
    beats = []; for (let k = k0; k <= k1; k++) beats.push(MANUAL.anchor + k * p);
  } else {
    const src = useML ? fillGaps(ml.beats) : (a && a.beats && a.beats.length >= 4 ? a.beats.slice() : null);
    if (!src) return null;
    beats = src;
    const d = []; for (let i = 1; i < beats.length; i++) d.push(beats[i] - beats[i - 1]);
    const p0 = median(d.slice(0, 8)), p1 = median(d.slice(-8));
    while (beats[0] - p0 > 0) beats.unshift(beats[0] - p0);
    // au-delà de ce qui a été entendu : on continue au même tempo (utile pendant la première écoute)
    while (beats[beats.length - 1] + p1 < songEnd + 30) beats.push(beats[beats.length - 1] + p1);
  }
  const nearest = (arr, t) => { let lo = 0, hi = arr.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; } return Math.abs(arr[lo] - t) <= Math.abs(arr[hi] - t) ? lo : hi; };
  // premiers temps trouvés par l'IA, et mesure : nombre de temps le plus fréquent entre deux premiers temps
  let isD = null, mlMeter = null;
  if (useML && ml.downs.length >= 2) {
    isD = new Uint8Array(beats.length);
    for (const t of ml.downs) { const i = nearest(beats, t); if (Math.abs(beats[i] - t) < 0.07) isD[i] = 1; }
    const cnt = {}; let last = -1;
    for (let i = 0; i < beats.length; i++) if (isD[i]) { if (last >= 0) { const n = i - last; if (n >= 2 && n <= 7) cnt[n] = (cnt[n] || 0) + 1; } last = i; }
    let best = 0; for (const [n, c] of Object.entries(cnt)) if (c > best) { best = c; mlMeter = +n; }
  }
  const meter = METER || mlMeter || (!MANUAL && a && a.meterGuess) || 4;
  let pos = null, down = 0;
  if (isD && mlMeter && !METER && DBT == null && MULT === 1) {
    // position dans la mesure en suivant les vrais premiers temps (mesures irrégulières comprises)
    pos = new Int8Array(beats.length);
    const f = isD.indexOf(1);
    for (let i = f; i < beats.length; i++) {
      if (i === f) { pos[i] = 0; continue; }
      const nx = (pos[i - 1] + 1) % meter;
      pos[i] = isD[i] && pos[i - 1] >= 1 ? 0 : nx;
    }
    for (let i = f - 1; i >= 0; i--) pos[i] = ((pos[i + 1] - 1) % meter + meter) % meter;
    down = f;
  } else {
    let dbTime = DBT;
    if (dbTime == null) {
      if (useML && ml.downs.length) dbTime = ml.downs[0];
      else if (!MANUAL && a) { const idx = meter === 3 ? a.downbeat3 : a.downbeat4; dbTime = a.beats[Math.min(a.beats.length - 1, idx || 0)]; }
      else dbTime = beats[0];
    }
    if (MULT === 2) { const o = []; for (let i = 0; i < beats.length; i++) { o.push(beats[i]); if (i + 1 < beats.length) o.push((beats[i] + beats[i + 1]) / 2); } beats = o; }
    else if (MULT === 0.5) { const par = nearest(beats, dbTime) % 2; beats = beats.filter((_, i) => i % 2 === par); }
    down = ((nearest(beats, dbTime) % meter) + meter) % meter;
  }
  const dd = []; for (let i = 1; i < Math.min(beats.length, 400); i++) dd.push(beats[i] - beats[i - 1]);
  const source = MANUAL ? 'tap' : useML ? (ml === MLSAVED ? 'saved' : 'ml') : (a === TSAVED ? 'saved' : 'detect');
  GRID = { beats, meter, down, pos, period: median(dd), source };
  return GRID;
}
const posOf = (g, i) => g.pos && i >= 0 && i < g.pos.length ? g.pos[i] : ((i - g.down) % g.meter + g.meter) % g.meter;
const isDown = (g, i) => posOf(g, i) === 0;
function idxAt(g, t) { // dernier temps <= t
  const b = g.beats; if (t < b[0]) return -1;
  let lo = 0, hi = b.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= t) lo = m; else hi = m; }
  return b[hi] <= t ? hi : lo;
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
  const now = out.now(), d = out.delay + MET.offset / 1000;
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
  if ($('practice').hidden || performance.now() < countUntil) return;
  const g = grid();
  const meter = g ? g.meter : (METER || 4);
  buildBeats(meter);
  const box = $('m-beats');
  if (!g || !P.playing()) { box.classList.add('idle'); lightBeat(-1); return; }
  box.classList.remove('idle');
  const out = clickOut(), rate = rateNow(), mt = mediaNow(); if (mt == null) return;
  const heard = mt - ((out ? out.delay : 0) + MET.offset / 1000) * rate;
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
function barStartAt(t) { const g = grid(); if (!g) return null; for (let i = idxAt(g, t + 0.05); i >= 0; i--) if (isDown(g, i)) return { i, t: g.beats[i] }; return { i: g.down, t: g.beats[g.down] }; }
function loopBars(n) {
  const g = grid(); if (!g) return;
  const tNow = P.time() || 0;
  const st = A != null ? barStartAt(snapTo(A, 'bar') + 0.01) : barStartAt(tNow);
  if (!st) return;
  let j = st.i, c = 0; while (c < n && j < g.beats.length - 1) { j++; if (isDown(g, j)) c++; } if (c < n) return;
  A = st.t; B = g.beats[j]; LOOP = true; DIRTY = true;
  syncControls(); renderKeys();
  const t = P.time(); if (t != null && (t < A || t > B)) P.seek(A);
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
  MULT = 1; DBT = anchor; GRID = null; SCHED.clear(); DIRTY = true;
  PR.sync();
}

/* ---------- affichage ---------- */
PR.sync = () => {
  if (!$('m-bpm')) return;
  const g = grid(), rate = TEMPO || 1;
  $('m-on').setAttribute('aria-pressed', MET.on ? 'true' : 'false');
  $('m-on').textContent = MET.on ? 'Métronome activé' : 'Activer le métronome';
  if (g) {
    const bpm = 60 / g.period;
    $('m-bpm').textContent = Math.round(bpm * rate);
    const src = g.source === 'tap' ? 'tempo tapé' : g.source === 'saved' ? 'tempo enregistré'
      : g.source === 'ml' ? (LIVE ? 'temps trouvés par l\'IA (se précisent pendant l\'écoute)' : 'temps et mesures trouvés par l\'IA')
      : (MLSTATE === 'loading' ? 'aperçu · chargement de l\'analyse IA des temps…' : MLSTATE === 'running' ? `aperçu · analyse IA des temps… ${Math.round(MLPROG * 100)} %` : LIVE ? 'tempo détecté (se précise pendant l\'écoute)' : 'tempo détecté');
    $('m-bpm-s').textContent = Math.abs(rate - 1) > 0.001 ? `Tempo original : ${Math.round(bpm)} BPM · vitesse ${Math.round(rate * 100)} % · ${src}` : `Tempo original · ${src}`;
  } else {
    $('m-bpm').textContent = '—';
    $('m-bpm-s').textContent = !SRC ? 'Ouvre une chanson pour trouver son tempo.'
      : SRC.type === 'youtube' && !CAP ? 'Active le son transposé (ou tape le tempo) : Tonality trouve les temps pendant l\'écoute.'
      : 'Le tempo apparaît après quelques secondes d\'écoute. Tu peux aussi le taper.';
  }
  $('m-auto').hidden = !MANUAL;
  ['m-half', 'm-double', 'm-one'].forEach(id => $(id).disabled = !g);
  $('m-meter').value = String(g ? g.meter : (METER || 4));
  document.querySelectorAll('[data-sub]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.sub === MET.sub)));
  $('m-sound').value = MET.sound; $('m-accent').checked = MET.accent; $('o-countin').checked = MET.countIn;
  $('m-vol').value = Math.round(MET.vol * 100); $('m-vol-v').textContent = Math.round(MET.vol * 100) + ' %';
  $('s-vol').value = Math.round(MET.songVol * 100); $('s-vol-v').textContent = Math.round(MET.songVol * 100) + ' %';
  $('m-off').value = MET.offset; $('m-off-v').textContent = (MET.offset > 0 ? '+' : MET.offset < 0 ? '−' : '') + Math.abs(MET.offset) + ' ms';
  // boucle
  document.querySelectorAll('[data-snap]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.snap === SNAP)); b.disabled = b.dataset.snap !== 'off' && !g; });
  document.querySelectorAll('[data-bars]').forEach(b => b.disabled = !g);
  $('snap-note').textContent = g ? (SNAP === 'off' ? 'Les flèches ◀ ▶ déplacent les points de 0,1 s.' : SNAP === 'beat' ? 'Les points A et B se placent sur le temps le plus proche; les flèches ◀ ▶ avancent d\'un temps.' : 'Les points A et B se placent au début de la mesure la plus proche; les flèches ◀ ▶ avancent d\'une mesure.')
    : 'Pour aimanter la boucle aux temps, il faut le tempo : fais jouer la chanson quelques secondes (ou tape le tempo).';
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
$('m-on').onclick = async () => {
  MET.on = !MET.on;
  if (MET.on) { try { await ensureCtx(); } catch (e) { } SCHED.clear(); lastMt = null; }
  PR.sync();
};
$('m-half').onclick = () => { MULT = MULT === 2 ? 1 : 0.5; GRID = null; SCHED.clear(); DIRTY = true; PR.sync(); };
$('m-double').onclick = () => { MULT = MULT === 0.5 ? 1 : 2; GRID = null; SCHED.clear(); DIRTY = true; PR.sync(); };
$('m-tap').onclick = tap;
$('m-auto').onclick = () => { MANUAL = null; DBT = null; GRID = null; SCHED.clear(); TAPS.length = 0; DIRTY = true; PR.sync(); };
$('m-meter').onchange = e => { METER = +e.target.value; GRID = null; SCHED.clear(); DIRTY = true; PR.sync(); };
$('m-one').onclick = () => {
  const g = grid(); if (!g) return;
  const out = clickOut(), rate = rateNow(), mt = P.playing() ? mediaNow() : P.time();
  if (mt == null) return;
  const heard = mt - (P.playing() ? ((out ? out.delay : 0) + MET.offset / 1000) * rate : 0);
  const i = Math.max(0, idxAt(g, heard)), j = (i + 1 < g.beats.length && Math.abs(g.beats[i + 1] - heard) < Math.abs(g.beats[i] - heard)) ? i + 1 : i;
  // en temps « non multiplié » : on garde simplement le moment, la grille le retrouve
  DBT = g.beats[j]; GRID = null; SCHED.clear(); DIRTY = true; PR.sync();
};
document.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { MET.sub = +b.dataset.sub; saveMetPrefs(); SCHED.clear(); PR.sync(); });
$('m-sound').onchange = e => { MET.sound = e.target.value; saveMetPrefs(); if (ctx) TonalityAudio.playClick(ctx, ctx.currentTime + 0.02, MET.sound, 2, MET.vol); };
$('m-accent').onchange = e => { MET.accent = e.target.checked; saveMetPrefs(); SCHED.clear(); };
$('o-countin').onchange = e => { MET.countIn = e.target.checked; saveMetPrefs(); };
$('m-vol').oninput = e => { MET.vol = +e.target.value / 100; $('m-vol-v').textContent = e.target.value + ' %'; saveMetPrefs(); };
$('s-vol').oninput = e => { MET.songVol = +e.target.value / 100; $('s-vol-v').textContent = e.target.value + ' %'; saveMetPrefs(); };
$('m-off').oninput = e => { MET.offset = +e.target.value; saveMetPrefs(); SCHED.clear(); PR.sync(); };
document.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => {
  SNAP = b.dataset.snap; saveMetPrefs();
  if (SNAP !== 'off') { if (A != null) A = snapTo(A, SNAP); if (B != null) { B = snapTo(B, SNAP); if (A != null && B <= A) B = stepFrom(A, 1); } syncControls(); renderKeys(); }
  PR.sync();
});
document.querySelectorAll('[data-bars]').forEach(b => b.onclick = () => loopBars(+b.dataset.bars));
// points A et B (remplacent les anciens réglages au dixième de seconde)
const heardNow = () => { const t = P.time(); if (t == null) return null; return t; };
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
// mise à jour régulière (tempo qui se précise, changements de vitesse)
setInterval(() => { if (!$('practice').hidden) PR.sync(); }, 1000);
PR.sync();
