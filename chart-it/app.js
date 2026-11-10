/* Chart It — interface (lecteur, écoute, grille Real Book, corrections, PDF, librairie). */
'use strict';
const E = window.ChartEngine;
const $ = id => document.getElementById(id);

/* ================= Noms d'accords ================= */
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MIXED = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const FRN = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
function spelling(key) {
  if (!key) return MIXED;
  if (key.mode === 'maj') { if ([5, 10, 3, 8, 1].includes(key.tonic)) return FLAT; if ([7, 2, 9, 4, 11, 6].includes(key.tonic)) return SHARP; return MIXED; }
  if ([2, 7, 0, 5, 10, 3].includes(key.tonic)) return FLAT; if ([4, 11, 6, 1, 8].includes(key.tonic)) return SHARP; return MIXED;
}
function noteName(pc, o, key) {
  const en = spelling(key)[pc];
  if (o.lang === 'fr') return FRN[en[0]] + en.slice(1);
  if (o.lang === 'de') { if (en === 'Bb') return 'B'; if (en === 'B') return 'H'; }
  return en;
}
function suffix(q, ms) {
  switch (q) {
    case 'maj': return ''; case 'min': return ms; case '7': return '7'; case 'maj7': return 'maj7'; case 'm7': return ms + '7';
    case 'dim': return ms === '-' ? '°' : 'dim'; case 'm7b5': return ms === '-' ? 'ø' : ms + '7b5'; case 'sus4': return 'sus4'; case 'sus2': return 'sus2';
    case 'aug': return '+'; case 'dim7': return '°7'; case '6': return '6'; case 'm6': return ms + '6';
  }
  return '';
}
function chordName(c, o, key) {
  if (!c || c.r < 0) return 'N.C.';
  let s = noteName(c.r, o, key) + (c.x != null ? c.x : suffix(c.q, o.minor));
  if (c.b >= 0 && c.b !== c.r) s += '/' + noteName(c.b, o, key);
  return s;
}
function keyName(k, o) {
  if (!k) return '';
  const n = noteName(k.tonic, o, k);
  return n + (k.mode === 'maj' ? ' majeur' : ' mineur');
}
const QMAP = { '': 'maj', 'M': 'maj', 'maj': 'maj', 'm': 'min', 'mi': 'min', 'min': 'min', '-': 'min', '7': '7', 'maj7': 'maj7', 'M7': 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', 'ma7': 'maj7',
  'm7': 'm7', '-7': 'm7', 'mi7': 'm7', 'min7': 'm7', 'dim': 'dim', '°': 'dim', 'o': 'dim', 'm7b5': 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', '-7b5': 'm7b5', 'mi7b5': 'm7b5',
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
  if (/^(n\.?c\.?|x|—)$/i.test(tok)) return { r: -1, q: '', b: -1, c: 1 };
  let bass = -1, main = tok;
  const sl = tok.lastIndexOf('/');
  if (sl > 0) { const bn = parseNote(tok.slice(sl + 1), lang); if (bn && bn[1] === '') { bass = bn[0]; main = tok.slice(0, sl); } }
  const n = parseNote(main, lang); if (!n) return null;
  const rest = n[1];
  let q = QMAP[rest], x;
  if (q === undefined && rest !== 'M') q = QMAP[rest.toLowerCase()];
  if (q === undefined) { if (!/^[\w#b+°ø()-]{1,10}$/.test(rest)) return null; x = rest; q = /^(m(?!aj)|-)/.test(rest) ? 'min' : 'maj'; }
  const c = { r: n[0], q, b: bass === n[0] ? -1 : bass, c: 1 };
  if (x != null) c.x = x;
  return c;
}
const RN_MAJ = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
const RN_MIN = ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII'];
function roman(c, key) {
  if (!key || !c || c.r < 0) return '';
  const d = (c.r - key.tonic + 12) % 12, s = (key.mode === 'maj' ? RN_MAJ : RN_MIN)[d];
  const minor = E.MINOR_Q.has(c.q);
  const pre = s.match(/^[b#]*/)[0]; let core = s.slice(pre.length); if (minor) core = core.toLowerCase();
  let suf = c.x != null ? '' : ({ dim: '°', m7b5: 'ø7', '7': '7', maj7: 'maj7', m7: '7', dim7: '°7', aug: '+', sus4: 'sus4', sus2: 'sus2', '6': '6', m6: '6' }[c.q] || '');
  if (c.b >= 0 && c.b !== c.r && c.x == null && E.QUAL[c.q]) {
    const tones = E.QUAL[c.q], idx = tones.indexOf((c.b - c.r + 12) % 12), sev = tones.length > 3 && /7/.test(suf);
    if (idx === 1) suf = sev ? suf.replace('7', '') + '65' : suf + '6';
    else if (idx === 2) suf = sev ? suf.replace('7', '') + '43' : suf + '64';
    else if (idx === 3) suf = suf.replace('7', '') + '42';
  }
  return pre + core + suf;
}

/* ================= État ================= */
const METERS = { '4/4': 4, '3/4': 3, '2/4': 2, '6/8': 2, '12/8': 4 };
let S = null;        // grille courante (sauvegardable)
let RUN = null;      // traits audio de la dernière écoute (en mémoire seulement)
let SRC = null;      // source chargée dans le lecteur
let BARS = [];       // mesures calculées pour l'affichage
let hist = [];
const bpb = () => METERS[S.meter] || 4;
const curKey = () => (S && (S.keyOverride || S.key)) || null;
function viewOpts() {
  return { lang: $('o-lang').value, minor: $('o-minor').value, roman: $('o-roman').checked, pct: $('o-pct').checked, reps: $('o-reps').checked };
}
function decodeOpts() { return { vocab: $('o-vocab').value, minBeats: +$('o-detail').value, inversions: $('o-inv').checked }; }
function getBars() { return S ? E.buildBars(S.chords, bpb(), S.phase) : []; }
function autoSections() {
  const bars = getBars();
  S.sections = E.findSections(bars, S.chords, curKey()).map(s => ({ start: s.start, label: s.label }));
}
function snap() { return JSON.stringify({ beats: S.beats, chords: S.chords, meter: S.meter, phase: S.phase, key: S.key, keyOverride: S.keyOverride, bpm: S.bpm, sections: S.sections, edited: S.edited, ab: RUN ? RUN.audioBeats : null }); }
function pushHist() { if (!S) return; hist.push(snap()); if (hist.length > 40) hist.shift(); $('undo').disabled = false; }
function undo() {
  if (!hist.length) return;
  const h = JSON.parse(hist.pop());
  Object.assign(S, h); if (RUN && h.ab) RUN.audioBeats = h.ab; delete S.ab;
  $('undo').disabled = !hist.length;
  syncTools(); render(); setStatus($('status'), 'Modification annulée.', 'ok');
}
function setStatus(el, text, kind, actionLabel, action) {
  el.className = 'status' + (kind ? ' ' + kind : ''); el.textContent = text;
  if (actionLabel) { const b = document.createElement('button'); b.type = 'button'; b.textContent = actionLabel; b.onclick = action; el.append(' ', b); }
}

/* ================= Mise en page de la grille ================= */
const barKey = bar => bar.beats.map(i => E.chordKey(S.chords[i])).join(',') + (bar.pickup ? 'p' : '');
function secRanges(bars) {
  let secs = (S.sections || []).filter(s => s.start < bars.length).sort((a, b) => a.start - b.start);
  if (!secs.length || secs[0].start !== 0) secs = [{ start: 0, label: secs.length ? 'Intro' : 'A' }, ...secs];
  return secs.map((s, i) => ({ label: s.label, s: s.start, e: i + 1 < secs.length ? secs[i + 1].start : bars.length }));
}
function layout(bars, secs, o) {
  const keys = sec => bars.slice(sec.s, sec.e).map(barKey), eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const out = [];
  for (let i = 0; i < secs.length;) {
    const a = secs[i], A = keys(a);
    if (o.reps && A.length >= 2) {
      let j = i; while (j + 1 < secs.length && secs[j + 1].label === a.label && eq(keys(secs[j + 1]), A)) j++;
      if (j > i) { out.push({ type: 'rep', insts: secs.slice(i, j + 1) }); i = j + 1; continue; }
      const b = secs[i + 1];
      if (b && b.label === a.label && b.e - b.s === a.e - a.s) {
        const B = keys(b); let p = 0; while (p < A.length && A[p] === B[p]) p++;
        if (p >= 2 && p < A.length && A.length - p <= 2) { out.push({ type: 'volta', insts: [a, b], common: p }); i += 2; continue; }
      }
    }
    out.push({ type: 'one', insts: [a] }); i++;
  }
  // cellules de chaque groupe
  out.forEach((g, gi) => {
    const a = g.insts[0], cells = [];
    if (g.type === 'one') for (let k = a.s; k < a.e; k++) cells.push({ bars: [k] });
    else if (g.type === 'rep') {
      for (let k = 0; k < a.e - a.s; k++) cells.push({ bars: g.insts.map(s => s.s + k) });
      cells[0].rs = true; cells[cells.length - 1].re = true;
    } else {
      const b = g.insts[1], n = a.e - a.s;
      for (let k = 0; k < g.common; k++) cells.push({ bars: [a.s + k, b.s + k] });
      for (let k = g.common; k < n; k++) cells.push({ bars: [a.s + k], volta: '1.', vfirst: k === g.common });
      cells[cells.length - 1].re = true;
      for (let k = g.common; k < n; k++) cells.push({ bars: [b.s + k], volta: '2.', vfirst: k === g.common });
      cells[0].rs = true;
    }
    const last = cells[cells.length - 1];
    if (!last.re) last.end = gi === out.length - 1 ? 'fin' : 'dbl';
    g.cells = cells;
    g.len = g.insts.reduce((t, s) => t + (s.e - s.s), 0);
  });
  return out;
}
// Contenu d'une mesure : [{c, n}] (accord + nombre de temps) ou jetons par temps
function barTokens(bar) {
  const groups = [];
  for (const i of bar.beats) { const c = S.chords[i], l = groups[groups.length - 1]; if (l && E.chordKey(l.c) === E.chordKey(c)) l.n++; else groups.push({ c, n: 1 }); }
  const n = bar.beats.length;
  if (groups.length === 1) return [{ c: groups[0].c }];
  if (groups.length === 2 && n % 2 === 0 && groups[0].n === n / 2) return groups.map(g => ({ c: g.c }));
  const out = []; groups.forEach(g => { out.push({ c: g.c }); for (let k = 1; k < g.n; k++) out.push({ slash: true }); });
  return out;
}
function barText(bar, o, key) {
  return barTokens(bar).map(t => t.slash ? '/' : chordName(t.c, o, key)).join(' ');
}

/* ================= Rendu de la feuille ================= */
const mk = (tag, cls, txt, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; if (parent) parent.appendChild(n); return n; };
function title() { return $('f-title').value.trim() || 'Sans titre'; }
function artist() { return $('f-artist').value.trim(); }
let GROUPS = [];
function render() {
  const el = $('sheet'); el.textContent = '';
  $('tools').hidden = !S; $('sheet-help').hidden = !S;
  if (!S) {
    const e = mk('div', 'empty-sheet', null, el);
    mk('strong', '', 'La grille apparaîtra ici', e);
    mk('span', '', 'Charge une chanson, puis clique sur « Écouter et analyser ». Tu pourras corriger chaque mesure, imprimer la grille ou la télécharger en PDF.', e);
    return;
  }
  const o = viewOpts(), key = curKey();
  BARS = getBars();
  const secs = secRanges(BARS);
  GROUPS = layout(BARS, secs, o);
  mk('h2', 'title', title(), el);
  if (artist()) mk('p', 'artist', artist(), el);
  const meta = mk('p', 'meta', null, el);
  mk('span', '', 'Tonalité : ' + keyName(key, o), meta);
  mk('span', '', '♩ = ' + Math.round(S.bpm), meta);
  mk('span', '', S.meter, meta);
  mk('span', '', BARS.length + ' mesures', meta);
  const form = mk('p', 'form', null, el); mk('b', '', 'Forme : ', form); form.append(secs.map(s => s.label).join(' – '));
  if (!BARS.length) { mk('p', 'form', 'Aucun accord trouvé : la chanson était peut-être muette pendant l\'écoute.', el); return; }
  GROUPS.forEach((g, gi) => {
    const sec = mk('div', 'csec', null, el);
    const lb = mk('button', 'slabel', g.insts[0].label, sec); lb.type = 'button';
    lb.setAttribute('aria-label', 'Section ' + g.insts[0].label + ', renommer');
    const n = g.insts[0].e - g.insts[0].s;
    mk('small', '', n + ' mes.', lb);
    if (g.type === 'rep') mk('span', 'rx', '×' + g.insts.length, lb);
    lb.onclick = () => openSecDialog(gi);
    const rows = mk('div', 'rows', null, sec);
    if (g.cells.some(c => c.volta)) rows.classList.add('hasv');
    let row = null;
    g.cells.forEach((cell, ci) => {
      if (ci % 4 === 0) row = mk('div', 'row', null, rows);
      const bar = BARS[cell.bars[0]], b = mk('button', 'bar', null, row); b.type = 'button';
      b.dataset.bars = cell.bars.join(',');
      if (cell.rs) { b.classList.add('rs'); mk('span', 'rpl', null, b); }
      if (cell.re) { b.classList.add('re'); mk('span', 'rpr', null, b); }
      if (cell.end) b.classList.add(cell.end);
      if (cell.volta) { const v = mk('span', 'volta', cell.vfirst ? cell.volta : '', b); if (!cell.vfirst) v.style.borderLeft = '0'; }
      // % si identique à la mesure précédente du groupe
      const prev = ci > 0 && !(cell.volta && cell.vfirst) ? BARS[g.cells[ci - 1].bars[0]] : null;
      const txt = barText(bar, o, key);
      if (o.pct && prev && !prev.pickup && barKey(prev) === barKey(bar)) mk('span', 'pct', '%', b);
      else for (const t of barTokens(bar)) {
        const tk = mk('span', t.slash ? 'tk s' : 'tk', null, b);
        if (t.slash) { mk('span', 'sl', '/', tk); continue; }
        if (t.c.r < 0) { mk('span', 'nc', 'N.C.', tk); continue; }
        const ch = mk('span', 'ch', chordName(t.c, o, key), tk);
        if (t.c.c < 0.35) { const qm = mk('span', 'qm', '?', ch); qm.title = 'Accord à vérifier'; }
        if (o.roman) mk('span', 'rn', roman(t.c, key), tk);
      }
      b.setAttribute('aria-label', `Mesure ${cell.bars[0] + 1} : ${txt}${bar.beats.some(i => S.chords[i].c < 0.35) ? ' (à vérifier)' : ''}`);
      b.onclick = () => openBarDialog(cell.bars);
    });
  });
  const lg = mk('p', 'legend', null, el);
  lg.textContent = (S.chords.some(c => c.c < 0.35) ? '? = accord à vérifier à l\'oreille · ' : '') + 'Grille faite avec Chart It · tommusic.ca';
  NOW = -1; tickNow(true);
  fitBars();
}
// Réduire la taille des accords qui ne tiennent pas dans leur mesure (ex. deux accords à 7e côte à côte)
function fitBars() {
  document.querySelectorAll('#sheet .bar').forEach(b => {
    const tks = b.querySelectorAll('.tk'); if (!tks.length) return;
    let f = 1; b.style.removeProperty('--fit');
    const over = () => [...tks].some(t => t.scrollWidth > t.clientWidth + 1);
    while (over() && f > 0.5) { f -= 0.07; b.style.setProperty('--fit', f.toFixed(2)); }
  });
}
let fitT = null;
window.addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitBars, 120); });

/* ================= Texte à copier ================= */
function plainText() {
  const o = viewOpts(), key = curKey(), out = [title().toUpperCase() + (artist() ? ' — ' + artist() : '')];
  out.push(`Tonalité : ${keyName(key, o)} · Tempo ${Math.round(S.bpm)} · ${S.meter}`);
  out.push('Forme : ' + secRanges(BARS).map(s => s.label).join(' – '), '');
  for (const g of GROUPS) {
    out.push(`[${g.insts[0].label}]` + (g.type === 'rep' ? ` ×${g.insts.length}` : ''));
    const parts = g.cells.map((cell, ci) => {
      let t = barText(BARS[cell.bars[0]], o, key);
      if (cell.volta && cell.vfirst) t = cell.volta + ' ' + t;
      return t;
    });
    for (let i = 0; i < parts.length; i += 4) {
      const seg = g.cells.slice(i, i + 4);
      let line = (seg[0].rs ? '||: ' : '| ') + parts.slice(i, i + 4).join(' | ');
      const lc = seg[seg.length - 1];
      line += lc.re ? ' :||' : lc.end ? ' ||' : ' |';
      out.push(line);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/* ================= PDF ================= */
let PDF_FONTS = null;
async function loadPdfFonts() {
  if (PDF_FONTS !== null) return PDF_FONTS;
  try {
    const get = async f => {
      const r = await fetch('../fonts/' + f); if (!r.ok) throw new Error('font');
      const b = new Uint8Array(await r.arrayBuffer()); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    };
    PDF_FONTS = { reg: await get('AtkinsonHyperlegible-Regular.ttf'), bold: await get('AtkinsonHyperlegible-Bold.ttf') };
  } catch (e) { PDF_FONTS = false; }
  return PDF_FONTS;
}
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const pdfSafe = s => s.normalize('NFC').replace(/./gu, c => (c.charCodeAt(0) < 256 || WINANSI_EXTRA.includes(c)) ? c : (c === 'ø' ? 'ø' : c === '♩' ? 'Tempo' : c.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\xFF]/g, '') || ''));
function fileName(t, a) {
  const clean = s => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  return (a ? clean(a) + ' - ' : '') + (clean(t) || 'Sans titre') + ' (grille).pdf';
}
async function buildPdf() {
  const fonts = await loadPdfFonts();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  let F = 'helvetica', txt = pdfSafe;
  if (fonts) {
    doc.addFileToVFS('AH-R.ttf', fonts.reg); doc.addFont('AH-R.ttf', 'AH', 'normal');
    doc.addFileToVFS('AH-B.ttf', fonts.bold); doc.addFont('AH-B.ttf', 'AH', 'bold');
    F = 'AH'; txt = s => s.replace(/♩/g, 'Tempo').replace(/[♯]/g, '#').replace(/[♭]/g, 'b');
  }
  const T = title(), A = artist(), o = viewOpts(), key = curKey();
  doc.setProperties({ title: txt(T + (A ? ' - ' + A : '')), author: txt(A || ''), subject: 'Chart It - grille d\'accords', creator: 'Chart It' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 46, bottom = H - M - 18;
  const fs = Math.round(+$('fs').value * 0.72);
  const labelW = fs * 3.9, gridX = M + labelW, gridW = W - M - gridX, bw = gridW / 4;
  const rowH = fs * 2.55, rowGap = fs * 0.55, vPad = fs * 0.95;
  let y = M;
  const font = (style, size) => { doc.setFont(F, style); doc.setFontSize(size); };
  font('bold', fs + 9); doc.text(txt(T), M, y + fs + 6); y += fs + 14;
  if (A) { font('normal', fs); doc.setTextColor(70); doc.text(txt(A), M, y + fs * 0.9); doc.setTextColor(0); y += fs * 1.4; }
  font('bold', fs * 0.82);
  doc.text(txt(`Tonalité : ${keyName(key, o)}     Tempo ${Math.round(S.bpm)}     ${S.meter}     ${BARS.length} mesures`), M, y + fs * 0.9); y += fs * 1.35;
  font('normal', fs * 0.82); doc.setTextColor(70);
  doc.splitTextToSize(txt('Forme : ' + secRanges(BARS).map(s => s.label).join(' – ')), W - 2 * M).forEach(l => { doc.text(l, M, y + fs * 0.9); y += fs * 1.2; });
  doc.setTextColor(0); y += fs * 0.6;
  const line = (x1, y1, x2, y2, w) => { doc.setLineWidth(w); doc.line(x1, y1, x2, y2); };
  const dots = (x, yc) => { doc.circle(x, yc - 3.2, 1.25, 'F'); doc.circle(x, yc + 3.2, 1.25, 'F'); };
  for (const g of GROUPS) {
    const nRows = Math.ceil(g.cells.length / 4), hasV = g.cells.some(c => c.volta);
    const h = (hasV ? vPad : 0) + nRows * rowH + (nRows - 1) * rowGap;
    if (y + h + fs > bottom && y > M + 1) { doc.addPage(); y = M; }
    y += fs * 0.7;
    const top = y + (hasV ? vPad : 0);
    // étiquette
    const lab = g.insts[0].label, n = g.insts[0].e - g.insts[0].s;
    font('bold', fs * 0.85);
    const lw = Math.min(labelW - 8, Math.max(fs * 1.9, doc.getTextWidth(txt(lab)) + 10)), lh = fs * 1.5;
    doc.setLineWidth(1.4); doc.rect(M, top + 2, lw, lh);
    doc.text(txt(lab), M + lw / 2, top + 2 + lh / 2 + fs * 0.3, { align: 'center', maxWidth: lw - 4 });
    font('normal', fs * 0.62); doc.setTextColor(80);
    doc.text(txt(n + ' mes.' + (g.type === 'rep' ? '  ×' + g.insts.length : '')), M, top + 2 + lh + fs * 0.85);
    doc.setTextColor(0);
    g.cells.forEach((cell, ci) => {
      const r = Math.floor(ci / 4), col = ci % 4, x = gridX + col * bw, yy = top + r * (rowH + rowGap), bar = BARS[cell.bars[0]];
      const lastInRow = col === 3 || ci === g.cells.length - 1;
      // barre de gauche
      if (cell.rs) { line(x + 1.2, yy, x + 1.2, yy + rowH, 2.4); line(x + 4.6, yy, x + 4.6, yy + rowH, 0.8); dots(x + 8, yy + rowH / 2); }
      else line(x, yy, x, yy + rowH, 0.9);
      // barre de droite
      const xr = x + bw;
      if (cell.re) { dots(xr - 8, yy + rowH / 2); line(xr - 4.6, yy, xr - 4.6, yy + rowH, 0.8); line(xr - 1.2, yy, xr - 1.2, yy + rowH, 2.4); }
      else if (cell.end === 'fin') { line(xr - 4.6, yy, xr - 4.6, yy + rowH, 0.8); line(xr - 1.2, yy, xr - 1.2, yy + rowH, 2.4); }
      else if (cell.end === 'dbl') { line(xr - 3, yy, xr - 3, yy + rowH, 0.8); line(xr, yy, xr, yy + rowH, 0.8); }
      else if (lastInRow) line(xr, yy, xr, yy + rowH, 0.9);
      // volta
      if (cell.volta) {
        const vy = yy - vPad * 0.55; line(x, vy, x + bw - 2, vy, 0.8);
        if (cell.vfirst) { line(x, vy, x, vy + vPad * 0.45, 0.8); font('bold', fs * 0.6); doc.text(cell.volta, x + 3, vy + fs * 0.62); }
      }
      // contenu
      const pl = x + (cell.rs ? 13 : 5), pr = xr - (cell.re ? 13 : 5), cw = pr - pl;
      const prev = ci > 0 && !(cell.volta && cell.vfirst) ? BARS[g.cells[ci - 1].bars[0]] : null;
      const cy = yy + rowH * (o.roman ? 0.47 : 0.6);
      if (o.pct && prev && !prev.pickup && barKey(prev) === barKey(bar)) { font('bold', fs * 1.3); doc.text('%', pl + cw / 2, cy, { align: 'center' }); return; }
      const toks = barTokens(bar), wt = t => t.slash ? 0.55 : 1, unit = cw / toks.reduce((a, t) => a + wt(t), 0);
      let acc = 0;
      toks.forEach((t, k) => {
        const tx = pl + acc * unit, tw = wt(t) * unit; acc += wt(t);
        if (t.slash) { font('normal', fs * 1.2); doc.setTextColor(90); doc.text('/', tx + 2, cy); doc.setTextColor(0); return; }
        if (t.c.r < 0) { font('bold', fs * 0.8); doc.setTextColor(90); doc.text('N.C.', tx + 2, cy); doc.setTextColor(0); return; }
        let size = fs * 1.2; const name = txt(chordName(t.c, o, key)), unc = t.c.c < 0.35;
        font('bold', size); let w = doc.getTextWidth(name) + (unc ? size * 0.4 : 0);
        if (w > tw - 3) { size = Math.max(fs * 0.62, size * (tw - 3) / w); font('bold', size); }
        doc.text(name, tx + 1, cy);
        if (unc) { const nw = doc.getTextWidth(name); font('bold', size * 0.6); doc.text('?', tx + 1 + nw + 1, cy - size * 0.38); }
        if (o.roman) { font('bold', fs * 0.62); doc.setTextColor(80); doc.text(txt(roman(t.c, key)), tx + 1, yy + rowH * 0.85); doc.setTextColor(0); }
      });
    });
    y = top + h;
  }
  y += fs * 1.2;
  if (y > bottom) { doc.addPage(); y = M; }
  font('normal', 8.5); doc.setTextColor(90);
  doc.text(txt((S.chords.some(c => c.c < 0.35) ? '? = accord à vérifier à l\'oreille  ·  ' : '') + 'Grille faite avec Chart It  ·  tommusic.ca'), M, y);
  const nP = doc.getNumberOfPages();
  for (let p = 1; p <= nP; p++) {
    doc.setPage(p); font('normal', 8.5); doc.setTextColor(90);
    doc.text(doc.splitTextToSize(txt(T + (A ? ' — ' + A : '')), W - 2 * M - 70)[0], M, H - 26);
    doc.text(`Page ${p}/${nP}`, W - M, H - 26, { align: 'right' });
  }
  doc.setTextColor(0);
  return doc;
}

/* ================= Téléchargements ================= */
let downloads = null;
async function saveFile(name, blob, statusEl) {
  if (!downloads) {
    if (window.claude) { setStatus(statusEl, "Le téléchargement n'est pas disponible dans cette vue."); return; }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus(statusEl, `« ${name} » téléchargé.`, 'ok'); return;
  }
  try { await downloads.save({ filename: name, data: blob }); setStatus(statusEl, `« ${name} » téléchargé.`, 'ok'); }
  catch (e) { if (e && e.code === 'declined') return; setStatus(statusEl, "Le téléchargement n'a pas fonctionné. Réessaie plus tard.", 'err'); }
}

/* ================= Lecteur YouTube ================= */
let YTP = null, ytReady = false, ytApiP = null, MEDIA = null, FILE = null, TAB_URL = null;
function loadYTApi() {
  if (ytApiP) return ytApiP;
  ytApiP = new Promise((res, rej) => {
    if (window.YT && window.YT.Player) return res();
    window.onYouTubeIframeAPIReady = () => res();
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApiP = null; rej(new Error('api')); };
    document.head.appendChild(s);
  });
  return ytApiP;
}
function ytId(u) {
  u = (u || '').trim();
  if (/^[\w-]{11}$/.test(u)) return u;
  try {
    const url = new URL(u.startsWith('http') ? u : 'https://' + u), h = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (h === 'youtu.be') return url.pathname.slice(1, 12) || null;
    if (h.endsWith('youtube.com') || h.endsWith('youtube-nocookie.com')) {
      if (url.searchParams.get('v')) return url.searchParams.get('v').slice(0, 11);
      const m = url.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/); if (m) return m[2];
    }
  } catch (e) { }
  return null;
}
function clearPlayer() {
  if (CAP) cancelCapture();
  try { YTP && YTP.destroy(); } catch (e) { }
  YTP = null; ytReady = false;
  if (MEDIA) { try { MEDIA.pause(); URL.revokeObjectURL(MEDIA.src); } catch (e) { } MEDIA = null; }
  if (TAB_URL) { URL.revokeObjectURL(TAB_URL); TAB_URL = null; }
  const box = $('player-box'); box.className = 'player';
  [...box.children].forEach(c => { if (c.id !== 'player-ph') c.remove(); });
  $('player-ph').hidden = false;
}
function setPh(strong, span) {
  const ph = $('player-ph'); ph.hidden = false;
  ph.querySelector('strong').textContent = strong; ph.querySelector('span').textContent = span;
}
const cleanTitle = s => s.replace(/\s*[\(\[][^\)\]]*(official|officiel|vid[ée]o|clip|lyrics?|paroles|audio|visuali[sz]er|hd|4k|remaster(ed)?|music)[^\)\]]*[\)\]]/gi, '').replace(/\s+(official\s+)?(music\s+)?video\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
function fillTitle(rawTitle, author) {
  if (!rawTitle) return;
  let t = cleanTitle(rawTitle), a = (author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const m = t.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (m) { a = m[1].trim(); t = m[2].trim(); }
  if (!$('f-title').dataset.touched) $('f-title').value = t;
  if (!$('f-artist').dataset.touched) $('f-artist').value = a;
  render();
}
async function loadYouTube(id, fromLibrary) {
  clearPlayer();
  SRC = { type: 'youtube', id, url: 'https://www.youtube.com/watch?v=' + id };
  setPh('Chargement de la vidéo…', '');
  showCapture('yt');
  try { await loadYTApi(); } catch (e) { setPh('YouTube ne répond pas', 'Vérifie ta connexion, puis réessaie.'); return; }
  const div = document.createElement('div'); div.id = 'yt-' + Date.now(); $('player-box').appendChild(div);
  $('player-ph').hidden = true;
  const pv = { playsinline: 1, rel: 0 }; if (/^https?:/.test(location.protocol)) pv.origin = location.origin;
  YTP = new YT.Player(div.id, {
    videoId: id, playerVars: pv,
    events: {
      onReady: () => { ytReady = true; if (!fromLibrary) { try { const d = YTP.getVideoData(); fillTitle(d.title, d.author); } catch (e) { } } },
      onError: e => ytError(e.data),
      onStateChange: e => { if (e.data === 0 && CAP && CAP.mode === 'yt') finishCapture(); }
    }
  });
}
function ytError(code) {
  const st = $('cap-status');
  if (code === 101 || code === 150) {
    st.className = 'status err'; st.textContent = 'Le propriétaire de cette vidéo empêche sa lecture sur d\'autres sites. Ouvre-la sur YouTube, puis utilise « Écouter un autre onglet ». ';
    const a = document.createElement('a'); a.href = SRC.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Ouvrir sur YouTube'; a.style.fontWeight = '700'; st.appendChild(a);
    $('listen').disabled = true;
  } else setStatus(st, code === 100 ? 'Vidéo introuvable ou privée.' : code === 2 ? 'Ce lien YouTube ne semble pas valide.' : 'La vidéo ne peut pas être lue ici.', 'err');
}
function mediaTime() {
  if (SRC && SRC.type === 'youtube' && ytReady) { try { return YTP.getCurrentTime(); } catch (e) { return null; } }
  if (MEDIA) return MEDIA.currentTime;
  return null;
}
function seekTo(t) {
  if (SRC && SRC.type === 'youtube' && ytReady) { YTP.seekTo(Math.max(0, t - 0.05), true); YTP.playVideo(); return true; }
  if (MEDIA) { MEDIA.currentTime = Math.max(0, t - 0.05); MEDIA.play().catch(() => { }); return true; }
  return false;
}

/* ================= Mode d'écoute ================= */
// Sur téléphone et tablette, le partage d'écran existe parfois, mais sans le son : l'écoute d'onglet ne peut pas marcher.
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canCapture = !isMobile && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
function showCapture(mode) {
  $('capture').hidden = false;
  $('cap-status').textContent = ''; $('cap-status').className = 'status';
  const file = mode === 'file';
  $('listen').hidden = file; $('analyze-file').hidden = !file;
  $('howto').hidden = file; $('o-silent').closest('label').hidden = file;
  $('o-start').closest('label').hidden = mode !== 'yt';
  $('speed').parentElement.hidden = mode !== 'yt'; $('speed-note').hidden = mode !== 'yt';
  $('howto-tab').textContent = mode === 'yt' ? 'cet onglet (Chart It)' : 'l\'onglet où joue ta chanson';
  $('listen').disabled = false; $('cap-opts').hidden = false;
  if (!file && !canCapture) {
    $('listen').disabled = true;
    $('cap-opts').hidden = true; $('howto').hidden = true;
    setStatus($('cap-status'), isMobile ? 'Sur téléphone et tablette, le navigateur ne laisse pas une page capter le son d\'une vidéo. Pour YouTube, utilise Chrome ou Edge sur un ordinateur. Ici, tu peux quand même ouvrir un fichier audio ou vidéo (bouton « Ouvrir un fichier »).' : 'Ce navigateur ne permet pas d\'écouter un onglet. Utilise Chrome ou Edge sur un ordinateur, ou ouvre un fichier audio ou vidéo.', 'err');
  }
}
let RATE = 1;
$('speed').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  RATE = +b.dataset.r; [...$('speed').children].forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
});

/* ================= Capture d'onglet ================= */
let CAP = null, capTimer = null;
async function startCapture() {
  const mode = SRC && SRC.type === 'youtube' ? 'yt' : 'tab';
  if (mode === 'yt' && !ytReady) { setStatus($('cap-status'), 'La vidéo n\'est pas encore prête. Attends une seconde et réessaie.', 'err'); return; }
  const silent = $('o-silent').checked;
  let stream;
  setStatus($('cap-status'), 'Choisis l\'onglet à partager dans la fenêtre qui vient de s\'ouvrir…');
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: { suppressLocalAudioPlayback: silent, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: mode === 'yt', selfBrowserSurface: mode === 'yt' ? 'include' : 'exclude',
      systemAudio: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude'
    });
  } catch (e) {
    setStatus($('cap-status'), e && e.name === 'NotAllowedError' ? 'Partage annulé. Clique de nouveau sur « Écouter et analyser » quand tu es prêt.' : 'Impossible de démarrer l\'écoute dans ce navigateur. Essaie Chrome ou Edge sur un ordinateur.', 'err');
    return;
  }
  const at = stream.getAudioTracks()[0];
  if (!at) {
    stream.getTracks().forEach(t => t.stop());
    setStatus($('cap-status'), 'Aucun son n\'a été partagé. Recommence et garde « Partager aussi l\'audio de l\'onglet » coché.', 'err');
    return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try { await ctx.resume(); } catch (e) { }
  const src = ctx.createMediaStreamSource(new MediaStream([at]));
  const proc = ctx.createScriptProcessor(4096, 2, 1), mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const rate = mode === 'yt' ? RATE : 1;
  CAP = { mode, stream, ctx, src, proc, chunks: [], n: 0, anchors: [], sr: ctx.sampleRate, rate, quiet: 0, level: 0 };
  proc.onaudioprocess = e => {
    if (!CAP) return;
    const b = e.inputBuffer, L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
    if (CAP.mode === 'yt') { let st = -1; try { st = YTP.getPlayerState(); } catch (er) { } if (st !== 1) { CAP.level = 0; return; } }
    const m = new Float32Array(L.length); let e2 = 0;
    for (let i = 0; i < L.length; i++) { m[i] = (L[i] + R[i]) / 2; e2 += m[i] * m[i]; }
    if (CAP.mode === 'yt') {
      let vt = 0; try { vt = YTP.getCurrentTime(); } catch (er) { }
      vt -= (L.length / CAP.sr) * CAP.rate + 0.05 * CAP.rate;
      const a = CAP.n / CAP.sr, last = CAP.anchors[CAP.anchors.length - 1];
      const pred = last ? last.v + (a - last.a) * CAP.rate : null;
      if (!last || Math.abs(pred - vt) > 0.4) CAP.anchors.push({ a, v: Math.max(0, vt) });
    }
    CAP.chunks.push(m); CAP.n += m.length;
    const rms = Math.sqrt(e2 / m.length); CAP.level = rms;
    CAP.quiet = rms < 0.0015 ? CAP.quiet + m.length / CAP.sr : 0;
  };
  at.addEventListener('ended', () => { if (CAP) finishCapture(); });
  // interface
  $('recbox').hidden = false; $('listen').hidden = true; $('cap-opts').hidden = true; $('howto').hidden = true;
  setStatus($('cap-status'), mode === 'yt' ? 'Écoute en cours. L\'analyse démarre toute seule à la fin de la vidéo, ou quand tu cliques sur « Arrêter et analyser ».' : 'Écoute en cours. Fais jouer la chanson dans l\'autre onglet, puis reviens cliquer sur « Arrêter et analyser ».');
  if (mode === 'yt') {
    try { YTP.setPlaybackRate(rate); if ($('o-start').checked) YTP.seekTo(0, true); YTP.playVideo(); } catch (e) { }
  }
  capTimer = setInterval(() => {
    if (!CAP) return;
    const sec = CAP.n / CAP.sr * CAP.rate;
    $('rec-time').textContent = fmtT(sec);
    $('rec-level').style.width = Math.min(100, Math.round(Math.sqrt(CAP.level) * 260)) + '%';
    $('rec-note').textContent = CAP.quiet > 4 && CAP.n > 0 ? 'aucun son capté… la chanson joue-t-elle?' : CAP.mode === 'yt' && CAP.rate !== 1 ? `de chanson écoutée (à ${String(CAP.rate).replace('.', ',')}×)` : 'de chanson écoutée';
  }, 200);
}
const fmtT = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function stopCaptureNodes() {
  clearInterval(capTimer);
  if (!CAP) return null;
  const c = CAP; CAP = null;
  try { c.proc.onaudioprocess = null; c.src.disconnect(); c.proc.disconnect(); } catch (e) { }
  c.stream.getTracks().forEach(t => t.stop());
  try { c.ctx.close(); } catch (e) { }
  if (c.mode === 'yt') { try { YTP.pauseVideo(); YTP.setPlaybackRate(1); } catch (e) { } }
  $('recbox').hidden = true; $('cap-opts').hidden = false; $('listen').hidden = false; $('howto').hidden = false;
  return c;
}
function cancelCapture() { stopCaptureNodes(); setStatus($('cap-status'), 'Écoute annulée. Rien n\'a été gardé.'); }
async function finishCapture() {
  const c = stopCaptureNodes(); if (!c) return;
  if (c.n / c.sr < 6) { setStatus($('cap-status'), 'L\'écoute était trop courte (ou muette). Laisse jouer au moins 10 secondes de musique.', 'err'); return; }
  const data = new Float32Array(c.n); let o = 0; for (const ch of c.chunks) { data.set(ch, o); o += ch.length; }
  c.chunks = null;
  const x = await resample(data, c.sr);
  let map;
  if (c.mode === 'yt') {
    const an = c.anchors.length ? c.anchors : [{ a: 0, v: 0 }];
    map = t => { let k = 0; while (k + 1 < an.length && an[k + 1].a <= t) k++; return an[k].v + (t - an[k].a) * c.rate; };
  } else {
    map = t => t;
    // garder l'enregistrement pour réécouter (en mémoire seulement)
    TAB_URL = URL.createObjectURL(wavBlob(x));
    const box = $('player-box'); box.className = 'player audio'; $('player-ph').hidden = true;
    [...box.children].forEach(ch => { if (ch.id !== 'player-ph') ch.remove(); });
    const au = document.createElement('audio'); au.controls = true; au.src = TAB_URL; box.appendChild(au); MEDIA = au;
  }
  await runAnalysis(x, map, c.rate);
}
async function resample(data, sr) {
  if (sr === E.SR) return data;
  const len = Math.ceil(data.length * E.SR / sr), oc = new OfflineAudioContext(1, len, E.SR);
  const buf = oc.createBuffer(1, data.length, sr); buf.copyToChannel(data, 0);
  const s = oc.createBufferSource(); s.buffer = buf; s.connect(oc.destination); s.start();
  return (await oc.startRendering()).getChannelData(0);
}
function wavBlob(x) {
  const n = x.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, E.SR, true); v.setUint32(28, E.SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/* ================= Fichier local ================= */
function loadFile(file) {
  if (!file) return;
  clearPlayer();
  FILE = file; SRC = { type: 'file', name: file.name };
  const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
  const el = document.createElement(isVideo ? 'video' : 'audio');
  el.src = URL.createObjectURL(file); el.controls = true; el.playsInline = true; el.preload = 'metadata';
  const box = $('player-box'); if (!isVideo) box.className = 'player audio';
  $('player-ph').hidden = true; box.appendChild(el); MEDIA = el;
  showCapture('file');
  const base = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  fillTitle(base, '');
  setStatus($('cap-status'), `« ${file.name} » est prêt. Clique sur « Analyser le fichier ».`);
}
async function analyzeFile() {
  if (!FILE) return;
  $('analyze-file').disabled = true;
  showProgress(0, 'Lecture du fichier…');
  try {
    const ab = await FILE.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let buf;
    try { buf = await ctx.decodeAudioData(ab); } finally { try { ctx.close(); } catch (e) { } }
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null, m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = R ? (L[i] + R[i]) / 2 : L[i];
    const x = await resample(m, buf.sampleRate);
    await runAnalysis(x, t => t, 1);
  } catch (e) {
    hideProgress();
    setStatus($('cap-status'), 'Ce fichier ne peut pas être lu par le navigateur. Essaie un MP3, un M4A, un WAV ou une vidéo MP4.', 'err');
  } finally { $('analyze-file').disabled = false; }
}

/* ================= Analyse ================= */
function showProgress(p, text) { $('prog-box').hidden = false; $('prog-bar').style.width = Math.round(p * 100) + '%'; $('prog').setAttribute('aria-valuenow', Math.round(p * 100)); if (text) $('prog-text').textContent = text; }
function hideProgress() { $('prog-box').hidden = true; }
async function runAnalysis(x, map, rate) {
  showProgress(0, 'Analyse de la chanson…');
  setStatus($('cap-status'), '');
  const dur = x.length / E.SR;
  try {
    const r = await E.analyze(x, decodeOpts(), p => showProgress(p, p < 0.15 ? 'Recherche de la pulsation…' : p < 0.9 ? 'Recherche des accords…' : 'Mise en forme de la grille…'));
    RUN = { feat: r.feat, audioBeats: r.beats, map, rate };
    if (S) pushHist();
    S = { v: 1, beats: r.beats.map(map), chords: r.chords, meter: r.beatsPerBar === 3 ? '3/4' : '4/4', phase: r.phase, key: r.key, keyOverride: null, bpm: r.bpm / rate, tuning: Math.round(r.tuning), sections: [], source: SRC ? Object.assign({}, SRC) : null, edited: false };
    autoSections();
    syncTools(); render();
    hideProgress();
    const unsure = S.chords.filter(c => c.c < 0.35).length;
    setStatus($('cap-status'), `Analyse terminée (${fmtT(dur * rate)} de musique). L'audio enregistré restera en mémoire jusqu'à ce que tu fermes la page.`, 'ok');
    setStatus($('status'), `Grille prête : ${BARS.length} mesures.` + (unsure ? ' Les accords marqués « ? » sont à vérifier.' : ''), 'ok');
    if (innerWidth < 980) $('sheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e); hideProgress();
    setStatus($('cap-status'), 'L\'analyse n\'a pas fonctionné. Réessaie, ou essaie une autre chanson.', 'err');
  }
}
function redecode(reason) {
  if (!S) return;
  if (!RUN) { setStatus($('status'), 'Ces réglages serviront à la prochaine écoute : l\'audio de cette grille n\'est plus en mémoire.'); return; }
  const wasEdited = S.edited;
  pushHist();
  const dec = E.decode(RUN.feat, RUN.audioBeats, decodeOpts());
  S.chords = dec.chords; S.key = dec.key; S.edited = false;
  autoSections(); syncTools(); render();
  setStatus($('status'), reason + (wasEdited ? ' Tes corrections ont été remplacées.' : ''), 'ok', 'Annuler', undo);
}

/* ================= Outils de la grille ================= */
function fillKeySelect() {
  const sel = $('o-key'), o = viewOpts(), v = sel.value; sel.textContent = '';
  const auto = document.createElement('option'); auto.value = 'auto'; auto.textContent = 'Auto' + (S && S.key ? ' (' + keyName(S.key, o) + ')' : ''); sel.appendChild(auto);
  for (const mode of ['maj', 'min']) for (let t = 0; t < 12; t++) {
    const op = document.createElement('option'); op.value = t + ':' + mode; op.textContent = keyName({ tonic: t, mode }, o); sel.appendChild(op);
  }
  sel.value = S && S.keyOverride ? S.keyOverride.tonic + ':' + S.keyOverride.mode : 'auto';
  if (!sel.value) sel.value = v || 'auto';
}
function syncTools() {
  if (!S) return;
  $('o-meter').value = S.meter; fillKeySelect();
}
$('o-meter').addEventListener('change', e => {
  if (!S) return; pushHist();
  S.meter = e.target.value; S.phase = S.phase % bpb(); autoSections(); render();
  setStatus($('status'), `Mesure changée pour ${S.meter}. Les sections ont été refaites.`, 'ok', 'Annuler', undo);
});
function shiftPhase(d) {
  if (!S) return; pushHist();
  const n = bpb(); S.phase = ((S.phase + d) % n + n) % n; autoSections(); render();
  setStatus($('status'), 'Premier temps déplacé. Les sections ont été refaites.', 'ok', 'Annuler', undo);
}
$('ph-l').onclick = () => shiftPhase(-1);
$('ph-r').onclick = () => shiftPhase(1);
function changeTempo(f) {
  if (!S) return;
  if (f === 0.5 && S.beats.length < 8) return;
  pushHist();
  const n = bpb();
  if (f === 0.5) {
    const par = S.phase % 2, keep = S.beats.map((_, i) => i).filter(i => i % 2 === par);
    S.beats = keep.map(i => S.beats[i]); S.chords = keep.map(i => S.chords[i]);
    if (RUN) RUN.audioBeats = keep.map(i => RUN.audioBeats[i]);
    S.phase = (((S.phase - par) / 2) % n + n) % n; S.bpm /= 2;
  } else {
    const dbl = a => { const o = []; a.forEach((t, i) => { o.push(t); if (i + 1 < a.length) o.push((t + a[i + 1]) / 2); }); return o; };
    const ch = []; S.chords.forEach((c, i) => { ch.push(c); if (i + 1 < S.chords.length) ch.push(Object.assign({}, c)); });
    S.beats = dbl(S.beats); S.chords = ch; if (RUN) RUN.audioBeats = dbl(RUN.audioBeats);
    S.phase = (2 * S.phase) % n; S.bpm *= 2;
  }
  if (RUN && !S.edited) { const dec = E.decode(RUN.feat, RUN.audioBeats, decodeOpts()); S.chords = dec.chords; }
  autoSections(); render();
  setStatus($('status'), `Tempo ${f === 2 ? 'doublé' : 'divisé par deux'} (♩ = ${Math.round(S.bpm)}). Les sections ont été refaites.`, 'ok', 'Annuler', undo);
}
$('tp-half').onclick = () => changeTempo(0.5);
$('tp-dbl').onclick = () => changeTempo(2);
$('o-key').addEventListener('change', e => {
  if (!S) return; pushHist();
  const v = e.target.value; S.keyOverride = v === 'auto' ? null : { tonic: +v.split(':')[0], mode: v.split(':')[1] };
  render();
});
$('re-sec').onclick = () => { if (!S) return; pushHist(); autoSections(); render(); setStatus($('status'), 'Sections refaites automatiquement.', 'ok', 'Annuler', undo); };

/* ================= Dialogue : corriger une mesure ================= */
let EDIT = null;
function openBarDialog(barIdxs) {
  const o = viewOpts(), key = curKey(), bar = BARS[barIdxs[0]];
  EDIT = { bars: barIdxs };
  $('d-bar-h').textContent = barIdxs.length > 1 ? `Mesures ${barIdxs.map(i => i + 1).join(', ')}` : `Mesure ${barIdxs[0] + 1}`;
  $('d-bar-lab').textContent = `Accords (${bar.beats.length} temps${bar.pickup ? ', anacrouse' : ''})`;
  const ex = o.lang === 'fr' ? '« Do » · « Do Sol » · « Rém7 / / Sol7 » · « Do/Mi »' : o.lang === 'de' ? '« C » · « C G » · « Dm7 / / G7 » · « C/E »' : '« C » · « C G » · « Dm7 / / G7 » · « C/E »';
  $('d-bar-p').textContent = 'Écris les accords séparés par des espaces. Un seul accord remplit la mesure; « / » prolonge l\'accord d\'un temps. Exemples : ' + ex;
  $('d-bar-in').value = barText(bar, o, key);
  $('d-bar-err').textContent = '';
  const k = barKey(bar), same = BARS.map((b, i) => i).filter(i => !barIdxs.includes(i) && barKey(BARS[i]) === k);
  $('d-bar-n').textContent = same.length; $('d-bar-all').checked = false; $('d-bar-all').closest('label').hidden = !same.length;
  EDIT.same = same;
  const isStart = (S.sections || []).some(s => s.start === barIdxs[0]);
  $('d-bar-sec').textContent = isStart ? 'Retirer ce début de section' : 'Commencer une section ici';
  $('d-bar-sec').hidden = barIdxs[0] === 0;
  $('d-bar-play').hidden = !(SRC && (SRC.type === 'youtube' ? ytReady : MEDIA));
  $('d-bar').returnValue = ''; $('d-bar').showModal();
  $('d-bar-in').select();
}
function parseBar(text, n) {
  const toks = text.replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return { err: 'Écris au moins un accord (ou « N.C. » pour un silence).' };
  if (toks.length > n) return { err: `Trop d'accords : cette mesure a ${n} temps.` };
  const lang = $('o-lang').value, parsed = [];
  for (const t of toks) {
    if (t === '/' || t === '.' || t === '%') { parsed.push(null); continue; }
    const c = parseChord(t, lang); if (!c) return { err: `Je ne reconnais pas « ${t} ».` };
    parsed.push(c);
  }
  if (!parsed[0] && toks[0] !== '/' && toks[0] !== '.') return { err: 'Commence par un accord.' };
  let beats;
  if (parsed.length === 1) beats = Array(n).fill(parsed[0]);
  else if (parsed.length === 2 && n % 2 === 0 && parsed.every(Boolean)) beats = [...Array(n / 2).fill(parsed[0]), ...Array(n / 2).fill(parsed[1])];
  else { beats = []; for (let i = 0; i < n; i++) { const p = i < parsed.length ? parsed[i] : null; beats.push(p || beats[i - 1] || null); } }
  return { beats };
}
$('d-bar-form').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value !== 'ok') return;
  const bar = BARS[EDIT.bars[0]], res = parseBar($('d-bar-in').value, bar.beats.length);
  if (res.err) { e.preventDefault(); $('d-bar-err').textContent = res.err; return; }
  pushHist();
  const targets = [...EDIT.bars, ...($('d-bar-all').checked ? EDIT.same : [])];
  for (const bi of targets) {
    const b = BARS[bi]; if (!b || b.beats.length !== bar.beats.length) continue;
    b.beats.forEach((idx, k) => {
      let c = res.beats[k];
      if (!c) { const prev = S.chords[idx - 1]; c = prev ? prev : { r: -1, q: '', b: -1 }; }
      S.chords[idx] = Object.assign({}, c, { c: 1 });
    });
  }
  S.edited = true;
  // les mesures restent les mêmes : on garde les sections
  render();
  setStatus($('status'), targets.length > 1 ? `${targets.length} mesures corrigées.` : 'Mesure corrigée.', 'ok', 'Annuler', undo);
});
$('d-bar-play').onclick = () => { const bar = BARS[EDIT.bars[0]]; seekTo(S.beats[bar.beats[0]]); };
$('d-bar-sec').onclick = () => {
  const i = EDIT.bars[0]; pushHist();
  const k = S.sections.findIndex(s => s.start === i);
  if (k >= 0) S.sections.splice(k, 1);
  else {
    const used = new Set(S.sections.map(s => s.label)), L = 'ABCDEFGHIJKLMNOP'.split('').find(l => !used.has(l)) || 'X';
    S.sections.push({ start: i, label: L }); S.sections.sort((a, b) => a.start - b.start);
  }
  $('d-bar').close(); render();
  setStatus($('status'), k >= 0 ? 'Début de section retiré.' : 'Nouvelle section ajoutée. Clique sur son étiquette pour la renommer.', 'ok', 'Annuler', undo);
};

/* ================= Dialogue : renommer une section ================= */
let SEC_EDIT = null;
function openSecDialog(gi) {
  const g = GROUPS[gi], label = g.insts[0].label;
  SEC_EDIT = { starts: g.insts.map(s => s.s), label };
  $('d-sec-h').textContent = 'Section « ' + label + ' »';
  $('d-sec-in').value = label; $('d-sec-old').textContent = label;
  const others = secRanges(BARS).filter(s => s.label === label && !SEC_EDIT.starts.includes(s.s)).length;
  $('d-sec-all').closest('label').hidden = !others; $('d-sec-all').checked = true;
  $('d-sec-del').hidden = SEC_EDIT.starts[0] === 0;
  $('d-sec').returnValue = ''; $('d-sec').showModal(); $('d-sec-in').select();
}
$('d-sec').addEventListener('close', () => {
  if ($('d-sec').returnValue !== 'ok') return;
  const v = $('d-sec-in').value.trim().slice(0, 24); if (!v || v === SEC_EDIT.label) return;
  pushHist();
  const all = $('d-sec-all').checked;
  // une section de départ implicite (0) peut ne pas exister dans la liste
  if (!S.sections.some(s => s.start === 0)) S.sections.unshift({ start: 0, label: secRanges(BARS)[0].label });
  S.sections.forEach(s => { if (SEC_EDIT.starts.includes(s.start) || (all && s.label === SEC_EDIT.label)) s.label = v; });
  render();
  setStatus($('status'), `Section renommée « ${v} ».`, 'ok', 'Annuler', undo);
});
$('d-sec-del').onclick = () => {
  pushHist();
  S.sections = S.sections.filter(s => s.start !== SEC_EDIT.starts[0]);
  $('d-sec').close('cancel'); render();
  setStatus($('status'), 'Section fusionnée avec la précédente.', 'ok', 'Annuler', undo);
};

/* ================= Suivi de la lecture (mesure en cours) ================= */
let NOW = -1;
function tickNow(force) {
  if (!S || !BARS.length) return;
  const t = mediaTime(); let bi = -1;
  if (t != null && (SRC && (SRC.type !== 'file' || MEDIA))) {
    let lo = 0, hi = S.beats.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (S.beats[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k >= 0 && t - S.beats[k] < 4) for (let i = BARS.length - 1; i >= 0; i--) if (BARS[i].beats[0] <= k) { if (BARS[i].beats.includes(k)) bi = i; break; }
  }
  if (bi === NOW && !force) return;
  NOW = bi;
  document.querySelectorAll('#sheet .bar.now').forEach(b => b.classList.remove('now'));
  if (bi < 0) return;
  document.querySelectorAll('#sheet .bar').forEach(b => { if (b.dataset.bars.split(',').map(Number).includes(bi)) b.classList.add('now'); });
}
setInterval(() => tickNow(false), 150);

/* ================= Librairie ================= */
const LS_KEY = 'chart-it-librairie';
const norm = s => (s || '').toLocaleLowerCase('fr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const store = {
  kind: 'local', items: [], col: null, loaded: false,
  async init() {
    let db = null, user = null, uid = null;
    try { [db, user] = await Promise.all([window.claude?.use?.('db'), window.claude?.use?.('user')]); uid = user ? await user.id() : null; } catch (e) { }
    if (db && uid) {
      this.kind = 'db'; this.col = db.collection('data/users/' + uid);
      const timer = setTimeout(() => { if (!this.loaded) $('lib-meta').textContent = 'La librairie tarde à répondre…'; }, 10000);
      this.col.onSnapshot(snap => { clearTimeout(timer); this.loaded = true; this.items = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.kind === 'chart'); renderLib(); },
        () => { clearTimeout(timer); $('lib-meta').textContent = 'Impossible de lire la librairie pour l\'instant.'; });
      $('lib-where').textContent = 'Ta librairie est enregistrée dans ton compte : tu la retrouves sur tous tes appareils. Elle est privée.';
    } else {
      this.kind = 'local'; this.loaded = true;
      try { this.items = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { this.items = []; }
      $('lib-warn').hidden = false; renderLib();
    }
  },
  saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.items)); return true; } catch (e) { return false; } },
  async put(item) {
    const same = this.items.find(x => norm(x.title) === norm(item.title) && norm(x.artist) === norm(item.artist));
    if (this.kind === 'db') { if (same) await this.col.doc(same.id).set(item); else await this.col.add(item); }
    else { if (same) Object.assign(same, item); else this.items.push({ id: 'l' + Date.now().toString(36), ...item }); if (!this.saveLocal()) throw { code: 'quota' }; renderLib(); }
    return !!same;
  },
  async remove(id) {
    if (this.kind === 'db') await this.col.doc(id).delete();
    else { this.items = this.items.filter(x => x.id !== id); this.saveLocal(); renderLib(); }
  }
};
function chartData() {
  return { v: 1, beats: S.beats.map(t => Math.round(t * 1000) / 1000), chords: S.chords.map(c => { const o = { r: c.r, q: c.q, b: c.b, c: c.c }; if (c.x != null) o.x = c.x; return o; }),
    meter: S.meter, phase: S.phase, key: S.key, keyOverride: S.keyOverride, bpm: Math.round(S.bpm * 10) / 10, sections: S.sections, source: S.source, edited: !!S.edited };
}
async function saveToLibrary() {
  const st = $('status');
  if (!S) { setStatus(st, 'Aucune grille à enregistrer. Analyse une chanson d\'abord.', 'err'); return; }
  if (!$('f-title').value.trim()) { setStatus(st, 'Donne un titre à la chanson avant de l\'enregistrer.', 'err'); $('f-title').focus(); return; }
  const item = { kind: 'chart', title: title(), artist: artist(), savedAt: Date.now(), bars: BARS.length, view: viewOpts(), chart: chartData() };
  $('save').disabled = true;
  try { const replaced = await store.put(item); setStatus(st, `« ${item.title} » ${replaced ? 'mis à jour' : 'ajouté'} dans la librairie.`, 'ok'); }
  catch (e) { setStatus(st, e && (e.code === 'quota' || e.code === 'quota_exceeded') ? 'La librairie est pleine. Supprime quelques grilles puis réessaie.' : 'L\'enregistrement n\'a pas fonctionné. Réessaie.', 'err'); }
  finally { $('save').disabled = false; }
}
function openItem(it, thenPdf) {
  hist = []; $('undo').disabled = true;
  clearPlayer();
  RUN = null;
  S = Object.assign({}, it.chart);
  S.chords = S.chords.map(c => Object.assign({}, c)); S.sections = (S.sections || []).map(s => Object.assign({}, s));
  $('f-title').value = it.title; $('f-artist').value = it.artist || '';
  $('f-title').dataset.touched = '1'; $('f-artist').dataset.touched = '1';
  if (it.view) { $('o-lang').value = it.view.lang; $('o-minor').value = it.view.minor; $('o-roman').checked = !!it.view.roman; $('o-pct').checked = it.view.pct !== false; $('o-reps').checked = it.view.reps !== false; }
  const src = S.source;
  if (src && src.type === 'youtube' && src.id) loadYouTube(src.id, true);
  else {
    SRC = null; $('capture').hidden = true;
    setPh(src && src.type === 'file' ? 'Fichier : ' + src.name : 'Grille enregistrée', src && src.type === 'file' ? 'Rouvre le fichier pour réécouter la chanson avec la grille.' : 'Cette grille vient d\'un autre onglet. Ouvre la chanson pour la réécouter.');
  }
  syncTools(); go('analyser'); render();
  setStatus($('status'), `« ${it.title} » ouvert depuis la librairie.`, 'ok');
  if (thenPdf) $('pdf').click();
}
const fmtDate = ts => new Date(ts).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' });
function renderLib() {
  const items = store.items;
  $('lib-count').textContent = items.length;
  if (!store.loaded) { $('lib-meta').textContent = 'Chargement de la librairie…'; $('lib').textContent = ''; return; }
  const artistsAll = new Set(items.map(x => norm(x.artist) || '~'));
  $('lib-meta').textContent = items.length ? `${items.length} grille${items.length > 1 ? 's' : ''} · ${artistsAll.size} artiste${artistsAll.size > 1 ? 's' : ''}` : 'Aucune grille pour l\'instant';
  const q = norm($('q').value), list = items.filter(x => !q || norm(x.title).includes(q) || norm(x.artist).includes(q));
  const box = $('lib'); box.textContent = '';
  if (!items.length || !list.length) {
    const e = mk('div', 'empty', null, box);
    if (!items.length) {
      mk('strong', '', 'Ta librairie est vide', e);
      mk('span', '', 'Analyse une chanson, puis clique sur « Enregistrer dans la librairie ». La grille apparaîtra ici, classée par artiste.', e);
      const b = mk('button', 'btn primary', 'Analyser une chanson', e); b.onclick = () => go('analyser');
    } else { mk('strong', '', 'Aucun résultat', e); mk('span', '', 'Aucune chanson ni artiste ne correspond à ta recherche.', e); }
    return;
  }
  const groups = new Map();
  for (const it of list) { const k = it.artist || 'Artiste inconnu'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const keys = [...groups.keys()].sort((a, b) => (a === 'Artiste inconnu') - (b === 'Artiste inconnu') || a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  const o = viewOpts();
  for (const k of keys) {
    const songs = groups.get(k).sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
    const g = mk('section', 'artist-group', null, box), h = mk('h2', '', k, g); mk('span', '', songs.length + (songs.length > 1 ? ' chansons' : ' chanson'), h);
    const ul = mk('ul', 'files', null, g);
    for (const it of songs) {
      const li = mk('li', 'file', null, ul);
      mk('div', 'doc', null, li).setAttribute('aria-hidden', 'true');
      const info = mk('div', 'info', null, li); mk('div', 'name', it.title, info);
      const ch = it.chart || {}, kk = ch.keyOverride || ch.key;
      mk('div', 'sub', [kk ? keyName(kk, it.view || o) : null, ch.meter, it.bars ? it.bars + ' mesures' : null, ch.source && ch.source.type === 'youtube' ? 'YouTube' : null, 'enregistré le ' + fmtDate(it.savedAt)].filter(Boolean).join(' · '), info);
      const acts = mk('div', 'acts', null, li);
      const op = mk('button', 'btn small primary', 'Ouvrir', acts); op.setAttribute('aria-label', 'Ouvrir ' + it.title); op.onclick = () => openItem(it);
      const pdfb = mk('button', 'btn small', 'PDF', acts); pdfb.setAttribute('aria-label', 'Télécharger le PDF de ' + it.title); pdfb.onclick = () => openItem(it, true);
      if (!downloads && window.claude) pdfb.hidden = true;
      const del = mk('button', 'btn small', 'Supprimer', acts); del.setAttribute('aria-label', 'Supprimer ' + it.title);
      del.onclick = () => {
        acts.textContent = '';
        const yes = mk('button', 'btn small danger', 'Oui, supprimer', acts), no = mk('button', 'btn small', 'Annuler', acts);
        yes.onclick = async () => { yes.disabled = true; try { await store.remove(it.id); setStatus($('lib-status'), `« ${it.title} » supprimé.`, 'ok'); } catch (e) { setStatus($('lib-status'), 'La suppression n\'a pas fonctionné. Réessaie.', 'err'); renderLib(); } };
        no.onclick = renderLib; yes.focus();
      };
    }
  }
}

/* ================= Navigation ================= */
function go(view, push = true) {
  const lib = view === 'librairie';
  $('v-an').hidden = lib; $('v-lib').hidden = !lib;
  $('t-an').removeAttribute('aria-current'); $('t-lib').removeAttribute('aria-current');
  (lib ? $('t-lib') : $('t-an')).setAttribute('aria-current', 'page');
  if (lib) renderLib();
  if (push && location.hash !== '#' + view) try { history.replaceState(null, '', '#' + view); } catch (e) { location.hash = view; }
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
window.addEventListener('hashchange', () => go(location.hash === '#librairie' ? 'librairie' : 'analyser', false));

/* ================= Branchements ================= */
$('url-form').addEventListener('submit', e => {
  e.preventDefault();
  const id = ytId($('url').value);
  if (!id) { setStatus($('cap-status'), 'Ce lien ne ressemble pas à une vidéo YouTube. Pour un autre site, utilise « Écouter un autre onglet ».', 'err'); $('capture').hidden = false; return; }
  delete $('f-title').dataset.touched; delete $('f-artist').dataset.touched;
  loadYouTube(id);
});
$('file').addEventListener('change', e => { delete $('f-title').dataset.touched; delete $('f-artist').dataset.touched; loadFile(e.target.files[0]); e.target.value = ''; });
$('other-tab').addEventListener('click', () => {
  clearPlayer(); SRC = { type: 'tab' };
  setPh('Écoute d\'un autre onglet', 'Ouvre ta chanson dans un autre onglet (YouTube, Spotify Web, etc.), puis clique sur « Écouter et analyser » ici.');
  showCapture('tab');
});
// glisser-déposer un fichier sur la zone du lien
const drop = $('url-form');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) { e.preventDefault(); loadFile(e.dataTransfer.files[0]); } });
$('listen').onclick = startCapture;
$('stop').onclick = finishCapture;
$('cancel').onclick = cancelCapture;
$('analyze-file').onclick = analyzeFile;
['o-vocab', 'o-detail', 'o-inv'].forEach(id => $(id).addEventListener('change', () => redecode('Grille recalculée avec les nouveaux réglages.')));
['o-lang', 'o-minor'].forEach(id => $(id).addEventListener('change', () => { if (S) fillKeySelect(); render(); renderLib(); }));
['o-roman', 'o-pct', 'o-reps'].forEach(id => $(id).addEventListener('change', render));
['f-title', 'f-artist'].forEach(id => $(id).addEventListener('input', e => { e.target.dataset.touched = '1'; render(); }));
$('fs').addEventListener('input', e => { $('sheet').style.fontSize = e.target.value + 'px'; fitBars(); });
$('sheet').style.fontSize = '18px';
$('q').addEventListener('input', renderLib);
$('undo').onclick = undo;
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('undo').disabled) { e.preventDefault(); undo(); } });
$('copy').addEventListener('click', () => {
  if (!S) { setStatus($('status'), 'Aucune grille à copier pour l\'instant.'); return; }
  navigator.clipboard.writeText(plainText()).then(() => { $('copy').textContent = 'Copié'; setTimeout(() => $('copy').textContent = 'Copier', 1500); })
    .catch(() => setStatus($('status'), 'La copie n\'a pas fonctionné dans ce navigateur.', 'err'));
});
$('print').onclick = () => { if (!S) { setStatus($('status'), 'Aucune grille à imprimer pour l\'instant.'); return; } window.print(); };
$('pdf').addEventListener('click', async () => {
  if (!window.jspdf) { setStatus($('status'), 'Le générateur de PDF n\'a pas pu se charger. Recharge la page.', 'err'); return; }
  if (!S) { setStatus($('status'), 'Aucune grille pour l\'instant. Analyse une chanson d\'abord.'); return; }
  $('pdf').disabled = true;
  try { const doc = await buildPdf(); await saveFile(fileName(title(), artist()), doc.output('blob'), $('status')); }
  catch (e) { console.error(e); setStatus($('status'), 'Le PDF n\'a pas pu être créé.', 'err'); }
  finally { $('pdf').disabled = false; }
});
$('save').addEventListener('click', saveToLibrary);
window.addEventListener('beforeunload', e => { if (CAP) { e.preventDefault(); e.returnValue = ''; } });

render();
go(location.hash === '#librairie' ? 'librairie' : 'analyser', false);
(async () => {
  try { downloads = await window.claude?.use?.('downloads') || null; } catch (e) { downloads = null; }
  if (window.jspdf && (downloads || !window.claude)) $('pdf').hidden = false;
  if (!window.claude) $('print').hidden = false;
  renderLib();
})();
store.init();
// Pour les tests : charger une grille d'exemple avec ?demo
if (/[?&]demo\b/.test(location.search)) window.__chartit = { get S() { return S; }, render, loadFile, analyzeFile, openItem, plainText, buildPdf };
