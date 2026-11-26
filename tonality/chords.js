/* Tonality — accords (moteur de Chart It) posés sur la grille des mesures de Tonality.
   Les accords sont trouvés une fois la grille des temps fixée : un accord par temps, regroupés en mesures,
   transposés avec la chanson, et donnés en formes de guitare quand un capo est choisi. */
'use strict';
(function () {
  const E = window.ChartEngine;
  if (!E) return;
  const CH = window.CH = {};
  let SHOW = true; try { SHOW = localStorage.getItem('tonality-chords') !== '0'; } catch (e) { }
  let LIST = [], SECS = [], KEY0 = null, VER = 0, STATE = '', PROG = 0;
  let FEATS = null;          // [{feat, toAudio(t), toMedia(x), t0, t1}]
  let FEATAT = 0;            // secondes d'audio quand les traits ont été calculés
  let DECV = '';             // grille utilisée pour le dernier calcul
  let BUSY = false, LOADED = false, FINAL = false;

  /* ---------- noms d'accords (mêmes réglages que la tonalité : Do Ré Mi / C D E / C D H) ---------- */
  const MS = 'm';
  function suffix(q) {
    switch (q) {
      case 'maj': return ''; case 'min': return MS; case '7': return '7'; case 'maj7': return 'maj7'; case 'm7': return MS + '7';
      case 'dim': return 'dim'; case 'm7b5': return MS + '7♭5'; case 'sus4': return 'sus4'; case 'sus2': return 'sus2';
      case 'aug': return '+'; case 'dim7': return 'dim7'; case '6': return '6'; case 'm6': return MS + '6';
    }
    return '';
  }
  const isFlatKey = k => k && (k.mode === 'maj' ? [5, 10, 3, 8, 1].includes(k.tonic) : [2, 7, 0, 5, 10, 3].includes(k.tonic));
  function keyAt(t) {
    try { const a = shownAnalysis(); if (a) { const s = a.segments.find(x => t >= x.t0 && t < x.t1) || a.segments[a.segments.length - 1]; if (s && s.key) return s.key; } } catch (e) { }
    return KEY0;
  }
  function shiftNow() { return (ST || 0) - (CAPO || 0); }
  function noteName(pc, k) { const en = (isFlatKey(k) ? FLAT : SHARP)[((pc % 12) + 12) % 12]; return noteIn(en, LANG()); }
  function chordName(c, t) {
    if (!c || c.r < 0) return 'N.C.';
    const sh = shiftNow(), k0 = keyAt(t), k = k0 ? { tonic: ((k0.tonic + sh) % 12 + 12) % 12, mode: k0.mode } : null;
    let s = noteName(c.r + sh, k) + (c.x != null ? c.x : suffix(c.q));
    if (c.b >= 0 && c.b !== c.r) s += '/' + noteName(c.b + sh, k);
    return s;
  }

  /* ---------- lecture par l'interface ---------- */
  function chordAt(t) {
    let lo = 0, hi = LIST.length - 1; if (hi < 0) return null;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (LIST[m].t <= t) lo = m; else hi = m; }
    const j = Math.abs(LIST[lo].t - t) <= Math.abs(LIST[hi].t - t) ? lo : hi;
    return Math.abs(LIST[j].t - t) < 0.15 ? LIST[j].c : null;
  }
  CH.key = () => [VER, SHOW ? 1 : 0, ST, CAPO, LANG()].join(':');
  CH.has = () => SHOW && LIST.length > 0;
  CH.barText = (bar, g) => {
    if (!SHOW || !LIST.length) return null;
    const out = []; let last = null;
    for (let i = bar.i; i < g.beats.length && g.beats[i] < bar.end - 0.02; i++) {
      const c = chordAt(g.beats[i]); if (!c) continue;
      const k = E.chordKey(c); if (k !== last) { out.push(chordName(c, g.beats[i])); last = k; }
    }
    return out.length ? out.join('  ') : '';
  };
  CH.sectionAt = bar => { if (!SHOW) return null; const s = SECS.find(x => Math.abs(x.t - bar.t) < 0.15); return s ? s.label : null; };
  CH.status = () => {
    if (!SHOW) return '';
    if (STATE === 'extract') return `Accords : analyse… ${Math.round(PROG * 100)} %`;
    if (STATE === 'wait') return 'Accords : après la grille des temps';
    return '';
  };

  /* ---------- audio → traits (une seule fois par portion de chanson) ---------- */
  async function to22k(x, sr) {
    if (sr === E.SR) return x;
    const len = Math.ceil(x.length * E.SR / sr), oc = new OfflineAudioContext(1, len, E.SR);
    const b = oc.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
    const s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start();
    return (await oc.startRendering()).getChannelData(0);
  }
  async function extractFile() {
    const m = window.__lastMono; if (!m) return null;
    const x = await to22k(m.mono, m.sr);
    const feat = await E.extract(x, p => { PROG = p; tickUI(); });
    return [{ feat, toAudio: t => t, toMedia: a => a, t0: 0, t1: feat.duration }];
  }
  async function extractLive() {
    const out = [], segs = PR._segs();
    const all = [...segs.values()].filter(sg => sg.audio && sg.audio.length && sg.pieces.length);
    const total = all.reduce((s, sg) => s + sg.a, 0); let done = 0;
    for (const sg of all) {
      if (sg.a < 15) { done += sg.a; continue; }
      const n = sg.audio.reduce((s, c) => s + c.length, 0), x = new Float32Array(n); let o = 0;
      for (const c of sg.audio) { x.set(c, o); o += c.length; }
      const y = await to22k(x, sg.sr);
      const base = done, len = sg.a;
      const feat = await E.extract(y, p => { PROG = (base + p * len) / total; tickUI(); });
      done += len;
      const pcs = sg.pieces.map(p => ({ a: p.a, t: p.t + (p.fix || 0) }));
      const toMedia = a => { let p = pcs[0]; for (const q of pcs) { if (q.a <= a) p = q; else break; } return p.t + (a - p.a); };
      const toAudio = t => { let p = pcs[0]; for (const q of pcs) { if (q.t <= t) p = q; else break; } return p.a + (t - p.t); };
      out.push({ feat, toAudio, toMedia, t0: toMedia(0), t1: toMedia(feat.duration) });
    }
    return out;
  }

  /* ---------- traits + grille → accords ---------- */
  function decodeAll() {
    const g = PR._grid(); if (!g || !FEATS) return;
    const list = [], secs = []; let key0 = null;
    for (const F of FEATS) {
      const idx = []; for (let i = 0; i < g.beats.length; i++) { const t = g.beats[i]; if (t >= F.t0 + 0.05 && t < F.t1 - 0.1) idx.push(i); }
      if (idx.length < 8) continue;
      const xs = idx.map(i => F.toAudio(g.beats[i]));
      const dec = E.decode(F.feat, xs, { vocab: 'sept', minBeats: 2, inversions: true });
      let phase = idx.findIndex(i => g.pos[i] === 0); if (phase < 0) phase = 0; phase %= g.meter;
      const tidy = E.tidyChords(dec.chords, g.meter, phase, { passing: true });
      idx.forEach((i, j) => list.push({ t: g.beats[i], c: tidy[j] }));
      if (!key0) key0 = dec.key;
      try {
        const bars = E.buildBars(tidy, g.meter, phase);
        for (const s of E.findSections(bars, tidy, dec.key)) { const b = bars[s.start]; if (b && !b.pickup && s.label !== 'Intro') secs.push({ t: g.beats[idx[b.start]], label: s.label }); }
      } catch (e) { }
    }
    list.sort((a, b) => a.t - b.t);
    // étiquette seulement quand la section change (A, B, A…)
    secs.sort((a, b) => a.t - b.t); for (let i = secs.length - 1; i > 0; i--) if (secs[i].label === secs[i - 1].label) secs.splice(i, 1);
    if (new Set(secs.map(x => x.label)).size < 2) secs.length = 0;
    LIST = list; SECS = secs; KEY0 = key0; VER++; STATE = ''; DIRTY = true;
    if (window.PR) PR.sync();
  }

  async function step() {
    if (BUSY || !SHOW || !SRC || $('practice').hidden) return;
    const g = PR._grid();
    if (!g || g.source === 'live' || g.source === 'dsp') { if (!LIST.length) STATE = 'wait'; tickUI(); return; }
    const live = SRC.type !== 'file';
    const heard = live ? [...PR._segs().values()].reduce((s, sg) => s + sg.a, 0) : (window.__lastMono ? window.__lastMono.dur : 0);
    const lockFinal = g.source === 'lock' && !(PR._t && PR._t.raw && PR._t.raw() && PR._t.raw().partial);
    // traits audio : au départ, puis quand beaucoup de nouvel audio a été entendu (ou à la vérification finale)
    const needFeat = !FEATS ? !(LOADED && live) || heard > FEATAT + 30
      : live && (heard > FEATAT + 45 || (lockFinal && !FINAL && heard > FEATAT + 5));
    BUSY = true;
    try {
      if (needFeat && heard > 15) {
        STATE = 'extract'; PROG = 0; tickUI();
        const f = live ? await extractLive() : await extractFile();
        if (f && f.length) { FEATS = f; FEATAT = heard; if (lockFinal) FINAL = true; DECV = ''; }
        STATE = '';
      }
      const v = PR._mlv() + '|' + g.meter + '|' + g.beats.length;
      if (FEATS && v !== DECV) { DECV = v; decodeAll(); }
    } catch (e) { console.warn('Tonality : accords', e); STATE = ''; }
    finally { BUSY = false; }
    tickUI();
  }
  let lastUI = 0;
  function tickUI() { const now = performance.now(); if (now - lastUI < 300) return; lastUI = now; if (window.PR) PR.sync(); }
  setInterval(step, 1500);

  /* ---------- état, librairie ---------- */
  CH.reset = () => { LIST = []; SECS = []; KEY0 = null; FEATS = null; FEATAT = 0; DECV = ''; STATE = ''; LOADED = false; FINAL = false; VER++; };
  CH.save = () => LIST.length ? { v: 1, l: LIST.map(x => [Math.round(x.t * 100) / 100, x.c.r, x.c.q, x.c.b]), s: SECS.map(x => [Math.round(x.t * 100) / 100, x.label]), k: KEY0 } : null;
  CH.load = d => {
    CH.reset();
    if (!d || !d.l) return;
    LIST = d.l.map(a => ({ t: a[0], c: { r: a[1], q: a[2], b: a[3] } })); SECS = (d.s || []).map(a => ({ t: a[0], label: a[1] })); KEY0 = d.k || null;
    LOADED = true; FINAL = true; VER++;
  };
  CH.setShow = v => { SHOW = !!v; try { localStorage.setItem('tonality-chords', SHOW ? '1' : '0'); } catch (e) { } VER++; if (window.PR) PR.sync(); };
  CH.shown = () => SHOW;
})();
