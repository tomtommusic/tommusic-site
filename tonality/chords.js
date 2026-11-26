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
  let EDITS = [];            // corrections : [{t, c}] (temps de la chanson, accord au ton d'origine)
  let EDITING = false;
  const OPTS = Object.assign({ vocab: 'sept', detail: 2, inv: true }, (() => { try { return JSON.parse(localStorage.getItem('tonality-chord-opts') || '{}'); } catch (e) { return {}; } })());

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
  function near(arr, t) {
    let lo = 0, hi = arr.length - 1; if (hi < 0) return null;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].t <= t) lo = m; else hi = m; }
    const j = Math.abs(arr[lo].t - t) <= Math.abs(arr[hi].t - t) ? lo : hi;
    return Math.abs(arr[j].t - t) < 0.15 ? arr[j] : null;
  }
  function chordAt(t) { const e = near(EDITS, t); if (e) return e.c; const x = near(LIST, t); return x ? x.c : null; }
  CH.key = () => [VER, SHOW ? 1 : 0, ST, CAPO, LANG()].join(':');
  CH.has = () => SHOW && LIST.length > 0;
  // faut-il encore du son ? (pas si les accords viennent de la librairie, déjà complets)
  CH.wantsAudio = () => SHOW && !(LOADED && FINAL && LIST.length);
  function barChords(bar, g) {   // accords de la mesure (temps → accord), sans regroupement
    const out = []; for (let i = bar.i; i < g.beats.length && g.beats[i] < bar.end - 0.02; i++) out.push({ i, t: g.beats[i], c: chordAt(g.beats[i]) });
    return out;
  }
  CH.barText = (bar, g) => {
    if (!SHOW || !LIST.length) return null;
    // accord du temps précédent : on n'écrit un accord que lorsqu'il change (sauf au début d'une section)
    const prev = bar.i > 0 && !SECS.some(x => Math.abs(x.t - bar.t) < 0.15) ? chordAt(g.beats[bar.i - 1]) : null;
    const out = []; let last = prev ? E.chordKey(prev) : null;
    for (let i = bar.i; i < g.beats.length && g.beats[i] < bar.end - 0.02; i++) {
      const c = chordAt(g.beats[i]); if (!c) continue;
      const k = E.chordKey(c); if (k !== last) { out.push(chordName(c, g.beats[i])); last = k; }
    }
    return out.length ? out.join('  ') : '';
  };
  CH.isEdited = (bar, g) => EDITS.some(e => e.t >= bar.t - 0.05 && e.t < bar.end - 0.02);
  CH.sectionAt = bar => { if (!SHOW) return null; const s = SECS.find(x => Math.abs(x.t - bar.t) < 0.15); return s ? s.label : null; };
  CH.status = () => {
    if (!SHOW) return '';
    if (STATE === 'extract') return CMDL != null ? `Accords : téléchargement du réseau… ${Math.round(CMDL * 100)} %` : `Accords : analyse… ${Math.round(PROG * 100)} %`;
    if (STATE === 'wait') return 'Accords : après la grille des temps';
    if (STATE === 'listen') return 'Accords : fais jouer la chanson, ils apparaissent après une trentaine de secondes';
    return '';
  };

  /* ---------- réseau d'accords ChordMini (fil de calcul) ---------- */
  const CM_W = 0.15;    // poids de l'avis du réseau (mesuré sur GuitarSet : 78,6 % → 82,3 % d'accords justes)
  let CMW = null, cmSeq = 0, CMDL = null; const cmPend = new Map();
  const HERE = (document.currentScript && document.currentScript.src) ? new URL('.', document.currentScript.src).href : new URL('./', location.href).href;
  function cm() {
    if (CMW) return CMW;
    if (!window.Worker || !window.DecompressionStream) return null;
    CMW = new Worker(HERE + 'chordml-worker.js?v=1');
    CMW.onmessage = e => { const m = e.data, p = cmPend.get(m.id); if (!p) return; if (m.progress != null) { if (m.dl) { CMDL = m.progress < 1 ? m.progress : null; tickUI(); } else p.onProg && p.onProg(m.progress); return; } cmPend.delete(m.id); CMDL = null; m.ok ? p.res(m.result) : p.rej(new Error(m.error)); };
    CMW.onerror = () => { for (const p of cmPend.values()) p.rej(new Error('worker')); cmPend.clear(); CMW = null; };
    return CMW;
  }
  const cmRun = (y, onProg) => new Promise((res, rej) => { const w = cm(); if (!w) return rej(new Error('indisponible')); const id = ++cmSeq; cmPend.set(id, { res, rej, onProg }); const c = new Float32Array(y); w.postMessage({ id, type: 'analyze', base: HERE, y: c }, [c.buffer]); });
  const CMQ = { min: 'min', '': 'maj', '7': '7', maj7: 'maj7', min7: 'm7', dim: 'dim', hdim7: 'm7b5', sus4: 'sus4', sus2: 'sus2', min6: 'm6', maj6: '6', dim7: 'dim7', aug: 'aug' };
  const CMPC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function cmIndex(vocab) { const idx = {}; vocab.forEach((v, i) => { if (v === 'N' || v === 'X') return; const [r, q] = v.split(':'); idx[((CMPC[r[0]] + (r[1] === '#' ? 1 : r[1] === 'b' ? -1 : 0)) % 12 + 12) % 12 + ':' + (CMQ[q || ''] || q)] = i; }); return { idx, N: vocab.indexOf('N') }; }
  // probabilités du réseau pour chaque temps (moyenne des logits sur la durée du temps, puis softmax)
  function cmBeats(cmr, xs, dur) {
    const T = cmr.frames, L = cmr.logits, fd = cmr.frame, K = 170;
    return xs.map((x, i) => {
      const e = i + 1 < xs.length ? xs[i + 1] : Math.min(dur, x + 0.5), i0 = Math.max(0, Math.min(T - 1, Math.floor(x / fd))), i1 = Math.min(T, Math.max(i0 + 1, Math.floor(e / fd)));
      const m = new Float64Array(K); for (let f = i0; f < i1; f++) for (let k = 0; k < K; k++) m[k] += L[f * K + k];
      let mx = -Infinity; for (let k = 0; k < K; k++) { m[k] /= (i1 - i0); if (m[k] > mx) mx = m[k]; }
      let sum = 0; for (let k = 0; k < K; k++) { m[k] = Math.exp(m[k] - mx); sum += m[k]; } for (let k = 0; k < K; k++) m[k] /= sum;
      return m;
    });
  }

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
    const cmP = cmRun(x).catch(e => { console.warn('Tonality : réseau d\'accords indisponible', e); return null; });
    const feat = await E.extract(x, p => { PROG = p; tickUI(); });
    return [{ feat, cm: await cmP, toAudio: t => t, toMedia: a => a, t0: 0, t1: feat.duration }];
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
      const cmP = cmRun(y).catch(e => { console.warn('Tonality : réseau d\'accords indisponible', e); return null; });
      const feat = await E.extract(y, p => { PROG = (base + p * len) / total; tickUI(); });
      const cmr = await cmP;
      done += len;
      const pcs = sg.pieces.map(p => ({ a: p.a, t: p.t + (p.fix || 0) }));
      const toMedia = a => { let p = pcs[0]; for (const q of pcs) { if (q.a <= a) p = q; else break; } return p.t + (a - p.a); };
      const toAudio = t => { let p = pcs[0]; for (const q of pcs) { if (q.t <= t) p = q; else break; } return p.a + (t - p.t); };
      out.push({ feat, cm: cmr, toAudio, toMedia, t0: toMedia(0), t1: toMedia(feat.duration) });
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
      let extra = null, extraNC = null;
      if (F.cm) {
        const P = cmBeats(F.cm, xs, F.feat.duration), ix = F.cmIx || (F.cmIx = cmIndex(F.cm.vocab));
        extra = (b, ch) => { const i = ix.idx[ch.r + ':' + ch.q]; return i == null ? 0 : CM_W * P[b][i]; };
        extraNC = b => ix.N >= 0 ? CM_W * P[b][ix.N] : 0;
      }
      const dec = E.decode(F.feat, xs, { vocab: OPTS.vocab, minBeats: OPTS.detail, inversions: OPTS.inv, extra, extraNC });
      let phase = idx.findIndex(i => g.pos[i] === 0); if (phase < 0) phase = 0; phase %= g.meter;
      const tidy = E.tidyChords(dec.chords, g.meter, phase, { passing: OPTS.detail > 1 });
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
    if (!FEATS && !LIST.length && heard <= 15) { STATE = live ? 'listen' : STATE; tickUI(); return; }
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
  CH.reset = () => { EDITS = []; EDITING = false; LIST = []; SECS = []; KEY0 = null; FEATS = null; FEATAT = 0; DECV = ''; STATE = ''; LOADED = false; FINAL = false; VER++; };
  const pk = x => { const a = [Math.round(x.t * 100) / 100, x.c.r, x.c.q, x.c.b]; if (x.c.x != null) a.push(x.c.x); return a; };
  const up = a => ({ t: a[0], c: Object.assign({ r: a[1], q: a[2], b: a[3] }, a[4] != null ? { x: a[4] } : {}) });
  CH.save = () => LIST.length || EDITS.length ? { v: 2, l: LIST.map(pk), e: EDITS.map(pk), s: SECS.map(x => [Math.round(x.t * 100) / 100, x.label]), k: KEY0 } : null;
  CH.load = d => {
    CH.reset();
    if (!d || !d.l) return;
    LIST = d.l.map(up); EDITS = (d.e || []).map(up); SECS = (d.s || []).map(a => ({ t: a[0], label: a[1] })); KEY0 = d.k || null;
    LOADED = true; FINAL = true; VER++;
  };
  /* ---------- corrections à la main (comme dans Chart It) ---------- */
  const QMAP = { '': 'maj', 'M': 'maj', 'maj': 'maj', 'm': 'min', 'mi': 'min', 'min': 'min', '-': 'min', '7': '7', 'maj7': 'maj7', 'M7': 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', 'ma7': 'maj7',
    'm7': 'm7', '-7': 'm7', 'mi7': 'm7', 'min7': 'm7', 'dim': 'dim', '°': 'dim', 'o': 'dim', 'm7b5': 'm7b5', 'm7♭5': 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', '-7b5': 'm7b5', 'mi7b5': 'm7b5',
    'sus4': 'sus4', 'sus': 'sus4', 'sus2': 'sus2', '+': 'aug', 'aug': 'aug', 'dim7': 'dim7', '°7': 'dim7', 'o7': 'dim7', '6': '6', 'm6': 'm6', '-6': 'm6', 'mi6': 'm6' };
  function parseNote(s, lang) {
    let m = s.match(/^(do|ré|re|mi|fa|sol|la|si)/i), pc, rest;
    if (m) { pc = { do: 0, 'ré': 2, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 }[m[1].toLowerCase()]; rest = s.slice(m[1].length); }
    else {
      m = s.match(/^[A-Ha-h]/); if (!m) return null;
      const L = m[0].toUpperCase();
      pc = L === 'H' ? 11 : (L === 'B' && lang === 'de') ? 10 : { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[L];
      rest = s.slice(1);
    }
    const a = rest.match(/^(#|♯|b|♭)/);
    if (a) { pc = (pc + (a[1] === '#' || a[1] === '♯' ? 1 : 11)) % 12; rest = rest.slice(1); }
    return [pc, rest];
  }
  function parseChord(tok, lang) {
    tok = tok.trim();
    if (/^(n\.?c\.?|x|—)$/i.test(tok)) return { r: -1, q: '', b: -1 };
    let bass = -1, main = tok;
    const sl = tok.lastIndexOf('/');
    if (sl > 0) { const bn = parseNote(tok.slice(sl + 1), lang); if (bn && bn[1] === '') { bass = bn[0]; main = tok.slice(0, sl); } }
    const n = parseNote(main, lang); if (!n) return null;
    const rest = n[1];
    let q = QMAP[rest], x;
    if (q === undefined && rest !== 'M') q = QMAP[rest.toLowerCase()];
    if (q === undefined) { if (!/^[\w#b♯♭+°ø()-]{1,10}$/.test(rest)) return null; x = rest; q = /^(m(?!aj)|-)/.test(rest) ? 'min' : 'maj'; }
    const c = { r: n[0], q, b: bass === n[0] ? -1 : bass };
    if (x != null) c.x = x;
    return c;
  }
  // accord tapé (au ton affiché, ou en formes de capo) → accord au ton d'origine
  const unshift = c => { if (c.r < 0) return c; const sh = shiftNow(), o = Object.assign({}, c); o.r = ((c.r - sh) % 12 + 12) % 12; if (c.b >= 0) o.b = ((c.b - sh) % 12 + 12) % 12; return o; };
  let EDBOX = null;
  function closeEditor() { if (EDBOX) { EDBOX.remove(); EDBOX = null; } }
  CH.editing = () => EDITING;
  CH.setEditing = v => { EDITING = !!v; if (!EDITING) closeEditor(); VER++; if (window.PR) PR.sync(); };
  CH.edit = (bar, g, cell) => {
    closeEditor();
    const beats = barChords(bar, g); if (!beats.length) return;
    // texte de départ : tous les accords de la mesure (même répétés), un par changement
    const parts = []; let last = null;
    for (const b of beats) { const k = b.c ? E.chordKey(b.c) : 'N'; if (k !== last) { parts.push(b.c ? chordName(b.c, b.t) : 'N.C.'); last = k; } }
    const box = EDBOX = document.createElement('div'); box.className = 'ch-editor'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Accords de la mesure ' + bar.n);
    const lab = document.createElement('label'); lab.textContent = `Mesure ${bar.n} · ${beats.length} temps`; box.appendChild(lab);
    const inp = document.createElement('input'); inp.value = parts.join(' '); inp.setAttribute('aria-label', 'Accords, séparés par des espaces'); box.appendChild(inp);
    const hint = document.createElement('p'); hint.className = 'note'; hint.textContent = 'Un accord par moitié ou par temps : « Sol Ré/Fa♯ », « Do Do Fa Sol ». N.C. = pas d\'accord.'; box.appendChild(hint);
    const err = document.createElement('p'); err.className = 'status err'; box.appendChild(err);
    const row = document.createElement('div'); row.className = 'toolbar'; box.appendChild(row);
    const bt = (txt, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small ' + (cls || ''); b.textContent = txt; b.onclick = fn; row.appendChild(b); return b; };
    const save = () => {
      const toks = inp.value.trim().split(/\s+/).filter(Boolean); if (!toks.length) return;
      const cs = []; for (const tk of toks) { if (tk === '%' || tk === '-') { cs.push(cs.length ? cs[cs.length - 1] : null); continue; } const c = parseChord(tk, LANG()); if (!c) { err.textContent = `« ${tk} » n'est pas un accord reconnu.`; return; } cs.push(unshift(c)); }
      const m = beats.length, n = cs.length;
      EDITS = EDITS.filter(e => !(e.t >= bar.t - 0.05 && e.t < bar.end - 0.02));
      beats.forEach((b, j) => { const c = cs[Math.min(n - 1, Math.floor(j * n / m))]; if (c) EDITS.push({ t: b.t, c }); });
      EDITS.sort((a, b) => a.t - b.t); VER++; DIRTY = true; closeEditor(); if (window.PR) PR.sync();
    };
    bt('Enregistrer', 'primary', save);
    bt('Annuler', '', closeEditor);
    if (CH.isEdited(bar, g)) bt('Remettre l\'analyse', '', () => { EDITS = EDITS.filter(e => !(e.t >= bar.t - 0.05 && e.t < bar.end - 0.02)); VER++; DIRTY = true; closeEditor(); if (window.PR) PR.sync(); });
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') closeEditor(); };
    const host = document.getElementById('bars-card'); host.appendChild(box);
    const r = cell.getBoundingClientRect(), h = host.getBoundingClientRect();
    box.style.left = Math.max(0, Math.min(r.left - h.left, h.width - 300)) + 'px'; box.style.top = (r.bottom - h.top + 6) + 'px';
    inp.focus(); inp.select();
  };
  document.addEventListener('pointerdown', e => { if (EDBOX && !EDBOX.contains(e.target) && !e.target.closest('#bars')) closeEditor(); });

  /* ---------- options des accords ---------- */
  CH.opts = () => OPTS;
  CH.setOpt = (k, v) => { OPTS[k] = v; try { localStorage.setItem('tonality-chord-opts', JSON.stringify(OPTS)); } catch (e) { } DECV = ''; step(); };

  /* ---------- impression / PDF façon Real Book ---------- */
  CH.print = () => {
    const g = PR._grid(); if (!g || !LIST.length) return;
    const bars = PR._bars(); if (!bars.length) return;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const title = ($('f-title').value || '').trim() || 'Sans titre', artist = ($('f-artist').value || '').trim();
    const k0 = keyAt(bars[0].t), sh = shiftNow(), kk = k0 ? { tonic: ((k0.tonic + sh) % 12 + 12) % 12, mode: k0.mode } : null;
    const meta = [kk ? 'Tonalité : ' + keyName(kk) : '', '♩ = ' + Math.round(60 / g.period), g.meter + ' temps', CAPO ? `Formes pour capo ${CAPO} (case ${CAPO})` : '', ST ? `Transposé de ${ST > 0 ? '+' : '−'}${Math.abs(ST)} demi-ton${Math.abs(ST) > 1 ? 's' : ''}` : ''].filter(Boolean);
    const barStr = b => { const out = []; let last = null; for (const x of barChords(b, g)) { const k = x.c ? E.chordKey(x.c) : 'N'; if (k !== last) { out.push(x.c ? chordName(x.c, x.t) : 'N.C.'); last = k; } } return out; };
    // rangées de 4 mesures; une nouvelle section commence une nouvelle rangée
    const rows = []; let row = null, prevKey = null;
    bars.forEach(b => {
      const sec = CH.sectionAt(b);
      if (!row || row.cells.length === 4 || sec) { row = { label: sec || '', cells: [] }; rows.push(row); }
      const cs = barStr(b), key = cs.join(' ');
      row.cells.push(key && key === prevKey ? '%' : cs); prevKey = key;
    });
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(artist ? artist + ' - ' + title : title)} (grille)</title>
<style>
@page{size:letter;margin:16mm 14mm}
body{font-family:"Atkinson Hyperlegible",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;padding:18px}
h1{font-size:28px;margin:0 0 2px;letter-spacing:-.01em} .by{font-size:15px;color:#333;margin:0 0 6px}
.meta{font-size:13px;color:#222;margin:0 0 18px;display:flex;gap:14px;flex-wrap:wrap}
.row{display:grid;grid-template-columns:44px repeat(4,minmax(0,1fr));align-items:stretch;margin-bottom:10px;break-inside:avoid}
.lab{font-weight:900;font-size:15px;align-self:center}
.lab span{display:inline-block;border:2px solid #111;border-radius:5px;padding:0 6px}
.bar{border-left:2px solid #111;min-height:46px;padding:4px 8px;display:flex;align-items:center;gap:12px;font-size:20px;font-weight:700}
.bar:last-child{border-right:2px solid #111}
.pct{font-size:24px;color:#333;margin:auto}
.foot{margin-top:20px;font-size:11px;color:#555}
@media screen{body{max-width:900px;margin:0 auto}.tip{background:#eef7f2;border:1px solid #b9ddcd;border-radius:10px;padding:8px 12px;font-size:13px;margin-bottom:14px}}
@media print{.tip{display:none}}
</style></head><body>
<p class="tip">Pour un PDF : dans la fenêtre d'impression, choisis « Enregistrer au format PDF ».</p>
<h1>${esc(title)}</h1>${artist ? `<p class="by">${esc(artist)}</p>` : ''}
<p class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</p>
${rows.map(r => `<div class="row"><div class="lab">${r.label ? `<span>${esc(r.label)}</span>` : ''}</div>${[0, 1, 2, 3].map(i => i < r.cells.length ? `<div class="bar">${r.cells[i] === '%' ? '<span class="pct">%</span>' : r.cells[i].map(c => `<span>${esc(c)}</span>`).join('')}</div>` : '<div></div>').join('')}</div>`).join('\n')}
<p class="foot">Grille faite avec Tonality · tommusic.ca</p>
<script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
</body></html>`;
    const w = window.open('', '_blank');
    if (!w) { setStatus($('status'), 'La fenêtre d\'impression a été bloquée : autorise les fenêtres pour tommusic.ca.', 'err'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  };

  /* ---------- branchements ---------- */
  $('ch-edit').onclick = () => CH.setEditing(!EDITING);
  $('ch-print').onclick = () => CH.print();
  $('ch-vocab').value = OPTS.vocab; $('ch-detail').value = String(OPTS.detail); $('ch-inv').checked = !!OPTS.inv;
  $('ch-vocab').onchange = e => CH.setOpt('vocab', e.target.value);
  $('ch-detail').onchange = e => CH.setOpt('detail', +e.target.value);
  $('ch-inv').onchange = e => CH.setOpt('inv', e.target.checked);

  CH.setShow = v => { SHOW = !!v; try { localStorage.setItem('tonality-chords', SHOW ? '1' : '0'); } catch (e) { } VER++; if (window.PR) PR.sync(); };
  CH.shown = () => SHOW;
})();
