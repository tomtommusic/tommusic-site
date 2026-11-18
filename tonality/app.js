/* Tonality — interface : lecteur (fichier, YouTube dans la page avec une fenêtre « Moteur audio », autre onglet), transposition en temps réel,
   tonalité et modulations, capo, boucle A-B, tempo, notes et librairie. */
'use strict';
const KE = window.TonalityKeys;
const $ = id => document.getElementById(id);
const mk = (tag, cls, text, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };

/* ================= Noms de notes et de tonalités ================= */
const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const FRN = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
function tonicSpelled(k) { // nom anglais de la tonique selon l'armure habituelle
  const flat = k.mode === 'maj' ? [5, 10, 3, 8, 1].includes(k.tonic) : [2, 7, 0, 5, 10, 3].includes(k.tonic);
  return (flat ? FLAT : SHARP)[k.tonic];
}
const LANG = () => $('o-lang').value;
function noteIn(en, lang) {
  if (lang === 'fr') return FRN[en[0]] + en.slice(1);
  if (lang === 'de') { if (en === 'B♭') return 'B'; if (en === 'B') return 'H'; return en.replace('♭', 'es').replace('♯', 'is').replace(/^Ees$/, 'Es').replace(/^Aes$/, 'As'); }
  return en;
}
function keyName(k, lang) {
  if (!k) return '—';
  lang = lang || LANG();
  const n = noteIn(tonicSpelled(k), lang);
  if (lang === 'fr') return n + (k.mode === 'maj' ? ' majeur' : ' mineur');
  if (lang === 'de') return k.mode === 'maj' ? n + '-Dur' : n.toLowerCase() + '-Moll';
  return n + (k.mode === 'maj' ? ' major' : ' minor');
}
function keyShort(k, lang) {
  lang = lang || LANG();
  const n = noteIn(tonicSpelled(k), lang);
  if (lang === 'de') return k.mode === 'maj' ? n : n.toLowerCase();
  return n + (k.mode === 'maj' ? '' : 'm');
}
const shiftKey = (k, st) => k ? { tonic: ((k.tonic + st) % 12 + 12) % 12, mode: k.mode } : null;
const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtT1 = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1).replace('.', ','); };
const signed = n => n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0';
const pl = (n, one, many) => Math.abs(n) > 1 ? many : one;
function setStatus(el, text, kind, actionLabel, action) {
  el.className = 'status' + (kind ? ' ' + kind : ''); el.textContent = text;
  if (actionLabel) { el.append(' '); const b = mk('button', '', actionLabel, el); b.type = 'button'; b.onclick = action; }
}

/* ================= État ================= */
let SRC = null;            // {type:'youtube', id, url} | {type:'file', name} | {type:'tab', id?}
let ST = 0, CT = 0;         // transposition (demi-tons) et accordage fin (cents)
let TEMPO = 1;              // vitesse de lecture
let A = null, B = null, LOOP = false;
let CAPO = null;            // capo choisi (nombre de cases)
let OVR = [];               // corrections de tonalité : [{t, key}]
let TR = null;              // suivi de tonalité en direct
let ANA = null;             // dernière analyse (brute)
let SAVED = null;           // analyse venant de la librairie {…, heard}
let DUR = 0;                // durée de la chanson (si connue)
let LIVE = false;           // l'analyse se fait pendant l'écoute
let DIRTY = false;
let OPENED = null;          // élément de librairie ouvert
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canCapture = !isMobile && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

/* ================= Audio ================= */
// Fichier et « autre onglet » : le son est transposé dans cette page.
// YouTube : la vidéo joue dans cette page, et une petite fenêtre « Moteur audio » capte cet onglet et fait sortir le son transposé.
let ctx = null, eng = null, media = null, mediaSrc = null, CAP = null;
let ENGINE = null;
let NATURAL = (() => { try { return localStorage.getItem('tonality-voix') !== '0'; } catch (e) { return true; } })();
async function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { } }
  return ctx;
}
async function newEngine(record) {
  if (eng) { eng.dispose(); eng = null; }
  eng = await TonalityAudio.build(ctx, { params: params(), onChunk: record ? onChunk : null });
  ENGINE = eng.kind; syncEngine();
  return eng;
}
const params = () => ({ st: ST, ct: CT, natural: NATURAL });
function applyRatio() {
  if (eng) eng.set(params());
  if (CAP && CAP.engine && POP && !POP.closed && POP.ENG) { try { POP.ENG.set(params()); } catch (e) { } }
}
function syncEngine() {
  const cb = $('o-voice');
  cb.checked = NATURAL; cb.disabled = ENGINE === 'maison';
  $('voice-note').textContent = ENGINE === 'maison' ? 'Ce navigateur utilise le moteur de secours : la correction de la voix n\'est pas offerte.' : 'Garde le timbre naturel de la voix quand tu transposes (moins d\'effet « Chipmunks »). Décoche-la pour comparer.';
}

/* ================= Lecteur : fichier ================= */
function clearSource() {
  deactivate(true);
  if (media) { try { media.pause(); URL.revokeObjectURL(media.src); } catch (e) { } }
  if (mediaSrc) { try { mediaSrc.disconnect(); } catch (e) { } }
  media = null; mediaSrc = null;
  if (YTP) { try { YTP.destroy(); } catch (e) { } YTP = null; ytReady = false; }
  const box = $('player-box'); box.className = 'player';
  [...box.children].forEach(c => { if (c.id !== 'player-ph') c.remove(); });
  $('player-ph').hidden = false;
  $('cap-box').hidden = true; $('transport').hidden = true; $('practice').hidden = true;
  setStatus($('src-status'), '');
  TR = null; ANA = null; SAVED = null; DUR = 0; LIVE = false; OVR = []; CAPO = null; MAXT = -1; TABT = 0;
}
function resetSong() {
  ST = 0; CT = 0; TEMPO = 1; A = null; B = null; LOOP = false;
  $('notes').value = ''; $('f-title').value = ''; $('f-artist').value = '';
  delete $('f-title').dataset.touched; delete $('f-artist').dataset.touched;
  OPENED = null; DIRTY = false;
  syncControls();
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
}
function loadFile(file, keepSettings) {
  if (!file) return;
  const keep = keepSettings || (OPENED && OPENED.source && OPENED.source.type === 'file' && OPENED.source.name === file.name);
  const saved = keep ? { SAVED, OVR: OVR.slice(), CAPO } : null;
  clearSource(); if (!keep) resetSong();
  if (saved) { SAVED = saved.SAVED; OVR = saved.OVR; CAPO = saved.CAPO; }
  SRC = { type: 'file', name: file.name };
  const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
  const el = document.createElement(isVideo ? 'video' : 'audio');
  el.src = URL.createObjectURL(file); el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
  el.preservesPitch = true; el.mozPreservesPitch = true; el.webkitPreservesPitch = true;
  const box = $('player-box');
  if (isVideo) { box.appendChild(el); $('player-ph').hidden = true; el.addEventListener('click', togglePlay); }
  else { box.className = 'player audio'; setPh('♪ ' + file.name.replace(/\.[^.]+$/, ''), 'Fichier audio prêt. Clique sur ▶ pour l\'écouter.'); }
  media = el;
  el.addEventListener('loadedmetadata', () => { DUR = el.duration || DUR; renderAll(); });
  el.addEventListener('play', updateTransport); el.addEventListener('pause', updateTransport);
  $('transport').hidden = false; $('practice').hidden = false;
  if (!$('f-title').dataset.touched && !keep) fillTitle(file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '), '');
  analyzeFile(file);
  syncControls(); renderAll();
}
async function connectMedia() {
  await ensureCtx();
  if (!mediaSrc && media) { mediaSrc = ctx.createMediaElementSource(media); await newEngine(false); eng.plug(mediaSrc); }
}
async function analyzeFile(file) {
  const st = $('src-status');
  setStatus(st, 'Analyse de la tonalité…');
  $('an-state').textContent = 'Analyse…';
  try {
    const ab = await file.arrayBuffer();
    const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    const buf = await oc.decodeAudioData(ab);
    if (!SRC || SRC.type !== 'file' || SRC.name !== file.name) return;
    DUR = buf.duration;
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const tr = new KE.Tracker(buf.sampleRate), n = 16384, chunk = new Float32Array(n);
    for (let i = 0; i < L.length; i += n) {
      const len = Math.min(n, L.length - i), c = len === n ? chunk : new Float32Array(len);
      for (let j = 0; j < len; j++) c[j] = R ? (L[i + j] + R[i + j]) / 2 : L[i + j];
      tr.push(c, i / buf.sampleRate, 1);
      if ((i / n) % 40 === 39) { $('an-state').textContent = 'Analyse… ' + Math.round(100 * i / L.length) + ' %'; await new Promise(r => setTimeout(r, 0)); }
    }
    TR = tr; LIVE = false;
    ANA = tr.analyze();
    if (ANA) ANA.heard = DUR;
    SAVED = null;
    setStatus(st, ANA ? `« ${file.name} » est prêt. Clique sur ▶ pour l'écouter.` : 'Ce fichier semble muet : aucune tonalité trouvée.', ANA ? 'ok' : 'err');
    renderAll();
  } catch (e) {
    console.error(e);
    setStatus(st, 'Ce fichier ne peut pas être lu par le navigateur. Essaie un MP3, un M4A, un WAV ou une vidéo MP4.', 'err');
    $('an-state').textContent = '';
  }
}

/* ================= Lecteur : YouTube dans la page ================= */
let YTP = null, ytReady = false, ytApi = null, POP = null;
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
const ytp = () => (YTP && ytReady) ? YTP : null;
function loadYTApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((res, rej) => {
    if (window.YT && window.YT.Player) return res();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch (e) { } res(); };
    const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api';
    sc.onerror = () => { ytApi = null; rej(new Error('api')); }; document.head.appendChild(sc);
  });
  return ytApi;
}
function loadYouTube(id, fromLib) {
  clearSource();
  SRC = { type: 'youtube', id, url: 'https://www.youtube.com/watch?v=' + id, fromLib: !!fromLib };
  const box = $('player-box');
  setPh('Chargement de la vidéo…', '');
  const holder = document.createElement('div'); holder.id = 'yt'; box.appendChild(holder);
  $('transport').hidden = false; $('practice').hidden = false;
  showCaptureBox('youtube');
  loadYTApi().then(() => {
    if (!SRC || SRC.id !== id) return;
    YTP = new YT.Player('yt', {
      videoId: id, playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          ytReady = true; $('player-ph').hidden = true;
          try { const d = YTP.getVideoData(); if (!SRC.fromLib) fillTitle(d.title, d.author); } catch (e) { }
          const d = YTP.getDuration(); if (d > 0) DUR = d;
          applyTempo(); renderAll();
        },
        onStateChange: () => { updateTransport(); const d = YTP && YTP.getDuration ? YTP.getDuration() : 0; if (d > 0 && Math.abs(d - DUR) > 0.5) { DUR = d; renderAll(); } },
        onError: e => ytError(e.data)
      }
    });
  }).catch(() => setStatus($('src-status'), 'YouTube ne répond pas. Vérifie ta connexion, puis réessaie.', 'err'));
  if (!canCapture) {
    setStatus($('src-status'), isMobile ? 'Sur téléphone et tablette, le navigateur ne laisse pas une page transposer le son d\'une vidéo YouTube : la vidéo joue à sa hauteur originale. Pour transposer, ouvre un fichier audio (bouton « Ouvrir un fichier »).' : 'Ce navigateur ne permet pas de transposer une vidéo YouTube : la vidéo joue à sa hauteur originale. Utilise Chrome ou Edge sur un ordinateur, ou ouvre un fichier audio.', 'err');
  }
  syncControls(); renderAll();
}
function ytError(code) {
  const st = $('src-status');
  if (code === 101 || code === 150) {
    setStatus(st, 'Le propriétaire de cette vidéo empêche sa lecture ailleurs que sur YouTube.', 'err', 'L\'ouvrir sur YouTube et la transposer', () => {
      const id = SRC.id; window.open('https://www.youtube.com/watch?v=' + id, '_blank');
      useOtherTab(id);
    });
  } else setStatus(st, code === 100 ? 'Vidéo introuvable ou privée.' : code === 2 ? 'Ce lien YouTube ne semble pas valide.' : 'La vidéo ne peut pas être lue ici.', 'err');
}
function useOtherTab(fromId) {
  const keepT = $('f-title').value, keepA = $('f-artist').value;
  clearSource();
  SRC = { type: 'tab', id: fromId || null };
  if (fromId) { $('f-title').value = keepT; $('f-artist').value = keepA; }
  setPh('Transposer un autre onglet', 'Fais jouer ta chanson dans un autre onglet de Chrome (YouTube, Spotify Web, etc.). Tonality capte son son et le transpose.');
  showCaptureBox('tab');
  syncControls(); renderAll();
}
function showCaptureBox(mode) {
  $('cap-box').hidden = false; $('live').hidden = true; $('activate').hidden = false; $('howto').hidden = false;
  $('howto-yt').hidden = mode !== 'youtube'; $('howto-tab').hidden = mode === 'youtube';
  if (!canCapture) { $('activate').disabled = true; $('howto').hidden = true; }
  else $('activate').disabled = false;
}

/* ================= Son transposé ================= */
let MAXT = -1, TABT = 0, LAT = 0.12, lastLevel = 0;
function activate() {
  if (!SRC || (SRC.type !== 'youtube' && SRC.type !== 'tab')) return;
  if (SRC.type === 'youtube') return openEngine();
  return captureOtherTab();
}
// YouTube : la fenêtre « Moteur audio » capte cet onglet (doit être ouverte directement dans le clic)
function openEngine() {
  const st = $('src-status');
  if (POP && !POP.closed) { try { POP.focus(); } catch (e) { } }
  else {
    const w = 460, h = 330, left = Math.max(0, (window.screenX || 0) + (window.outerWidth || 1200) - w - 40), top = (window.screenY || 0) + 120;
    POP = window.open('moteur.html', 'tonality-moteur', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  }
  if (!POP) { setStatus(st, 'Ton navigateur a bloqué la petite fenêtre « Moteur audio ». Autorise les fenêtres surgissantes pour tommusic.ca, puis réessaie.', 'err'); return; }
  setStatus(st, 'Dans la petite fenêtre « Moteur audio », clique sur « Choisir l\'onglet Tonality ».');
  hookEngine();
}
window.__tonalityEngineReady = () => hookEngine();
function hookEngine() {
  if (!POP || POP.closed || !POP.ENG) return;
  const E = POP.ENG;
  E.set(params());
  E.onChunk = (chunk, sr) => onChunk(chunk, sr);
  E.onState = (state, msg, kind) => {
    if (state === 'active') engineOn(kind);
    else if (CAP && CAP.engine) deactivate(false, msg || 'Son transposé arrêté.');
  };
  if (E.state === 'active' && !(CAP && CAP.engine)) engineOn(E.kind);
}
function engineOn(kind) {
  CAP = { engine: true, sr: 0 };
  ENGINE = kind; syncEngine();
  LIVE = true;
  $('activate').hidden = true; $('howto').hidden = true; $('live').hidden = false;
  setStatus($('src-status'), 'Son transposé actif. Fais jouer la vidéo : la tonalité apparaît pendant l\'écoute. La petite fenêtre « Moteur audio » peut rester derrière, mais ne la ferme pas.', 'ok');
  const p = ytp(); if (p) { try { if (p.getPlayerState() !== 1) p.playVideo(); } catch (e) { } }
  renderAll();
}
// Autre onglet : cette page capte l'autre onglet et fait sortir le son transposé
async function captureOtherTab() {
  const st = $('src-status');
  setStatus(st, 'Choisis l\'onglet à partager dans la fenêtre qui vient de s\'ouvrir…');
  let stream, controller = null;
  try { controller = window.CaptureController ? new CaptureController() : null; } catch (e) { controller = null; }
  try {
    const o = {
      video: { displaySurface: 'browser', frameRate: 1, width: 320 },
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'exclude'
    };
    if (controller) o.controller = controller;
    stream = await navigator.mediaDevices.getDisplayMedia(o);
    try { controller && controller.setFocusBehavior('focus-captured-surface'); } catch (e) { }
  } catch (e) {
    console.warn('Tonality : partage refusé ou impossible', e && e.name);
    setStatus(st, e && e.name === 'NotAllowedError' ? 'Partage annulé. Clique de nouveau sur « Activer le son transposé » quand tu es prêt.' : 'Impossible de capter le son dans ce navigateur. Essaie Chrome ou Edge sur un ordinateur.', 'err');
    return;
  }
  const at = stream.getAudioTracks()[0];
  if (!at) { stream.getTracks().forEach(t => t.stop()); setStatus(st, 'Aucun son n\'a été partagé. Recommence et garde « Partager aussi l\'audio de l\'onglet » coché.', 'err'); return; }
  try { await ensureCtx(); await newEngine(true); } catch (e) { stream.getTracks().forEach(t => t.stop()); setStatus(st, 'Le moteur audio n\'a pas pu démarrer. Recharge la page.', 'err'); return; }
  const src = ctx.createMediaStreamSource(new MediaStream([at]));
  eng.plug(src);
  CAP = { stream, src };
  at.addEventListener('ended', () => { if (CAP && CAP.stream === stream) deactivate(false, 'Le partage s\'est arrêté. Clique sur « Activer le son transposé » pour reprendre.'); });
  LIVE = true;
  $('activate').hidden = true; $('howto').hidden = true; $('live').hidden = false;
  setStatus(st, 'Son transposé actif. Fais jouer la chanson dans l\'autre onglet : la tonalité apparaît pendant l\'écoute.', 'ok');
  renderAll();
}
function deactivate(silent, msg) {
  if (!CAP) return;
  const c = CAP; CAP = null;
  if (c.engine) {
    if (POP && !POP.closed && POP.ENG) { try { POP.ENG.onState = null; POP.ENG.stop(); } catch (e) { } try { POP.close(); } catch (e) { } }
    POP = null;
  } else {
    try { c.src.disconnect(); } catch (e) { }
    c.stream.getTracks().forEach(t => t.stop());
    if (eng) { eng.dispose(); eng = null; }
  }
  if (!silent) {
    $('live').hidden = true; $('activate').hidden = false; $('howto').hidden = false;
    setStatus($('src-status'), msg || (SRC && SRC.type === 'youtube' ? 'Son transposé arrêté. La vidéo joue maintenant à sa hauteur originale.' : 'Son transposé arrêté.'));
  }
  if (TR) { ANA = TR.analyze() || ANA; LIVE = false; }
  renderAll();
}
function onChunk(chunk, sr) {
  let e = 0; for (let i = 0; i < chunk.length; i += 4) e += chunk[i] * chunk[i];
  lastLevel = Math.sqrt(e / (chunk.length / 4));
  if (!CAP || !SRC) return;
  if (!TR || TR.sr !== sr) { TR = new KE.Tracker(sr); MAXT = -1; TABT = 0; }
  const len = chunk.length / sr;
  if (SRC.type === 'youtube') {
    const p = ytp(); if (!p) return;
    let state = -1, vt = 0, rate = 1;
    try { state = p.getPlayerState(); vt = p.getCurrentTime(); rate = p.getPlaybackRate() || 1; } catch (er) { return; }
    if (state !== 1) return;
    const t0 = vt - (len + LAT) * rate;
    if (t0 < MAXT - 1.5) return;               // passage déjà entendu (retour en arrière, boucle) : rien à apprendre
    TR.push(chunk, Math.max(0, t0), rate);
    MAXT = Math.max(MAXT, t0 + len * rate);
  } else {
    if (lastLevel < 0.0008 && TR.frames.length === 0) return; // attendre que la musique commence
    TR.push(chunk, TABT, 1); TABT += len;
  }
}
// fenêtre « Moteur audio » fermée par l'utilisateur
setInterval(() => { if (CAP && CAP.engine && (!POP || POP.closed)) { POP = null; CAP.engine = true; deactivate(false, 'La fenêtre « Moteur audio » a été fermée : le son transposé est arrêté. Clique sur « Activer le son transposé » pour reprendre.'); } }, 700);
window.addEventListener('pagehide', () => { try { POP && !POP.closed && POP.close(); } catch (e) { } });
// analyse en direct, toutes les 3 secondes
let lastFrames = 0;
setInterval(() => {
  if (!TR || !LIVE || TR.frames.length === lastFrames) return;
  lastFrames = TR.frames.length;
  const r = TR.analyze();
  if (r) { ANA = r; ANA.heard = TR.heard; renderKeys(); renderCapo(); renderTp(); }
}, 3000);

/* ================= Commandes de lecture ================= */
const P = {
  time() {
    if (SRC && SRC.type === 'file' && media) return media.currentTime;
    const p = ytp(); if (SRC && SRC.type === 'youtube' && p) { try { return p.getCurrentTime(); } catch (e) { } }
    if (SRC && SRC.type === 'tab' && TR) return TABT;
    return null;
  },
  dur() { return DUR || (ANA ? ANA.end : 0); },
  playing() {
    if (SRC && SRC.type === 'file' && media) return !media.paused;
    const p = ytp(); if (p) { try { return p.getPlayerState() === 1; } catch (e) { } }
    return false;
  },
  async play() {
    if (SRC && SRC.type === 'file' && media) { await connectMedia(); media.playbackRate = TEMPO; return media.play().catch(() => { }); }
    const p = ytp(); if (p) p.playVideo();
  },
  pause() { if (SRC && SRC.type === 'file' && media) media.pause(); else { const p = ytp(); if (p) p.pauseVideo(); } },
  seek(t) {
    t = Math.max(0, t);
    if (SRC && SRC.type === 'file' && media) { media.currentTime = t; return true; }
    const p = ytp(); if (p) { p.seekTo(t, true); return true; }
    return false;
  },
  canSeek() { return !!(SRC && ((SRC.type === 'file' && media) || (SRC.type === 'youtube' && ytp()))); }
};
function togglePlay() { if (P.playing()) P.pause(); else P.play(); setTimeout(updateTransport, 120); }
function applyTempo() {
  if (SRC && SRC.type === 'file' && media) { media.playbackRate = TEMPO; $('tempo-note').textContent = 'Le tempo change sans changer la hauteur.'; }
  const p = ytp();
  if (SRC && SRC.type === 'youtube' && p) {
    try {
      const av = p.getAvailablePlaybackRates() || [1];
      const best = av.reduce((a, b) => Math.abs(b - TEMPO) < Math.abs(a - TEMPO) ? b : a, 1);
      p.setPlaybackRate(TEMPO);
      setTimeout(() => {
        const r = p.getPlaybackRate();
        $('tempo-note').textContent = Math.abs(r - TEMPO) > 0.01 ? `YouTube permet seulement certaines vitesses : la vidéo joue à ${Math.round(r * 100)} %.` : 'Le tempo change sans changer la hauteur.';
        if (Math.abs(r - TEMPO) > 0.01 && Math.abs(best - r) < 0.01) { /* arrondi par YouTube */ }
      }, 300);
    } catch (e) { }
  }
}
function updateTransport() {
  const playing = P.playing();
  $('ic-play').toggleAttribute('hidden', playing); $('ic-pause').toggleAttribute('hidden', !playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
  $('q-ic-play').toggleAttribute('hidden', playing); $('q-ic-pause').toggleAttribute('hidden', !playing); $('q-play').setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
  const t = P.time(), d = P.dur();
  if (t != null) {
    const sk = $('seek');
    if (d > 0) { sk.max = d.toFixed(1); if (document.activeElement !== sk || !sk.dataset.drag) sk.value = Math.min(d, t).toFixed(1); }
    $('time').textContent = fmtT(t) + ' / ' + (d > 0 ? fmtT(d) : '—');
    $('stamp-t').textContent = fmtT(t);
  }
}
// boucle A-B + suivi de la position
setInterval(() => {
  if (!SRC) return;
  const t = P.time();
  if (LOOP && A != null && B != null && B > A + 0.2 && t != null && t >= B && P.canSeek()) P.seek(A);
}, 40);
let lastSegIdx = -2;
setInterval(() => {
  if (!SRC) return;
  updateTransport();
  if (CAP) $('level').style.width = Math.min(100, Math.round(Math.sqrt(lastLevel) * 260)) + '%';
  if (CAP && LIVE && TR) $('live-text').textContent = 'Son transposé actif · ' + fmtT(TR.heard) + ' analysées';
  drawHead();
  const si = curSegIdx();
  if (si !== lastSegIdx) { lastSegIdx = si; renderNow(); }
}, 200);

/* ================= Analyse affichée (avec corrections) ================= */
function shownAnalysis() {
  let base = ANA;
  if (SAVED && (!ANA || (ANA.heard || 0) < (SAVED.heard || 0) * 0.9)) base = SAVED;
  if (!base || !base.segments || !base.segments.length) return null;
  let segs = base.segments.map(s => Object.assign({}, s));
  for (const o of OVR) {
    const s = segs.find(x => Math.abs(x.t0 - o.t) < 4);
    if (s) { s.key = o.key; s.edited = true; s.conf = 1; s.alt = null; }
  }
  const merged = [];
  for (const s of segs) {
    const L = merged[merged.length - 1];
    if (L && L.key.tonic === s.key.tonic && L.key.mode === s.key.mode) L.t1 = s.t1; else merged.push(s);
  }
  return { tuning: base.tuning, segments: merged, start: base.start, end: base.end, heard: base.heard, fromSaved: base === SAVED };
}
function curSegIdx() {
  const an = shownAnalysis(); if (!an) return -1;
  const t = P.time(); if (t == null) return 0;
  let k = 0; an.segments.forEach((s, i) => { if (s.t0 <= t + 0.5) k = i; });
  return k;
}

/* ================= Rendu ================= */
function renderAll() { syncControls(); renderTp(); renderKeys(); renderCapo(); renderStamps(); updateTransport(); }
function syncBar() {
  $('q-n').textContent = signed(ST);
  const an = shownAnalysis();
  let k = null;
  if (an) { const i = Math.max(0, curSegIdx()); k = shiftKey(an.segments[i].key, ST); }
  $('q-k').textContent = k ? keyName(k) : (ST === 0 ? 'original' : pl(ST, 'demi-ton', 'demi-tons'));
  $('q-zero').disabled = ST === 0;
  $('q-play').hidden = !P.canSeek();
  updateBarVisibility();
}
let tpCardVisible = true;
function updateBarVisibility() {
  const show = !!SRC && !$('v-ec').hidden && !tpCardVisible;
  $('qbar').hidden = !show; document.body.classList.toggle('qbar-on', show);
}
function syncControls() {
  syncBar();
  $('tp-n').textContent = signed(ST);
  $('tp-range').value = ST;
  $('tp-u').textContent = ST === 0 ? 'demi-ton (tonalité originale)' : (ST > 0 ? 'demi-' + pl(ST, 'ton plus haut', 'tons plus haut') : 'demi-' + pl(ST, 'ton plus bas', 'tons plus bas'));
  $('tp-warn').hidden = Math.abs(ST) <= 5;
  $('cents').value = CT; $('cents-val').textContent = signed(CT) + ' ' + pl(CT, 'cent', 'cents');
  $('tempo').value = Math.round(TEMPO * 100); $('tempo-val').textContent = Math.round(TEMPO * 100) + ' %';
  $('pt-a').textContent = 'A ' + (A != null ? fmtT1(A) : '—'); $('pt-b').textContent = 'B ' + (B != null ? fmtT1(B) : '—');
  $('loop').setAttribute('aria-pressed', LOOP ? 'true' : 'false');
  ['a-m', 'a-p', 'go-a'].forEach(id => $(id).disabled = A == null);
  ['b-m', 'b-p'].forEach(id => $(id).disabled = B == null);
  $('loop').disabled = A == null || B == null;
  const hint = $('tp-hint');
  if ((ST || CT) && SRC && (SRC.type === 'youtube' || SRC.type === 'tab') && !CAP) { hint.hidden = false; hint.textContent = 'Clique sur « Activer le son transposé » (à gauche) pour entendre la transposition.'; }
  else if ((ST || CT) && SRC && SRC.type === 'file' && !mediaSrc) { hint.hidden = false; hint.textContent = 'Clique sur ▶ pour entendre la chanson transposée.'; }
  else hint.hidden = true;
}
function renderTp() {
  const an = shownAnalysis(), box = $('tp-keys'); box.textContent = '';
  const sel = $('tp-target'); sel.textContent = '';
  if (!an) {
    mk('span', 'note', ST ? `La chanson joue ${Math.abs(ST)} ${pl(ST, 'demi-ton', 'demi-tons')} plus ${ST > 0 ? 'haut' : 'bas'}.` : 'La chanson joue à sa hauteur originale.', box);
    const o = mk('option', '', '(après l\'analyse)', sel); o.value = ''; sel.disabled = true;
    return;
  }
  const k0 = an.segments[0].key;
  mk('span', '', keyName(k0), box); mk('span', '', '→', box).setAttribute('aria-hidden', 'true'); mk('span', 'k', keyName(shiftKey(k0, ST)), box);
  if (an.segments.length > 1) mk('span', 'note', `(+ ${an.segments.length - 1} ${pl(an.segments.length - 1, 'modulation', 'modulations')}, transposée${an.segments.length > 2 ? 's' : ''} aussi)`, box);
  sel.disabled = false;
  for (let d = -6; d <= 6; d++) {
    if (d === -6) continue;
    const k = shiftKey(k0, d), o = mk('option', '', `${keyName(k)} (${signed(d)})`, sel); o.value = d;
    if (d === ST) o.selected = true;
  }
  if (Math.abs(ST) > 6 || ST === -6) { const o = mk('option', '', `${keyName(shiftKey(k0, ST))} (${signed(ST)})`, sel); o.value = ST; o.selected = true; }
}
const PATS = ['p0', 'p1', 'p2'];
function renderKeys() {
  const an = shownAnalysis();
  $('keys-empty').hidden = !!an; $('keys-body').hidden = !an;
  if (!an) {
    $('an-state').textContent = '';
    $('keys-empty-t').textContent = SRC && SRC.type === 'file' ? 'Analyse du fichier en cours…' : SRC && (SRC.type === 'youtube' || SRC.type === 'tab') ? 'Active le son transposé et fais jouer la chanson : la tonalité apparaît après une vingtaine de secondes d\'écoute.' : 'Ouvre un fichier, ou active le son transposé d\'une vidéo : la tonalité apparaît pendant l\'écoute.';
    return;
  }
  $('an-state').textContent = LIVE ? `Analyse en direct · ${fmtT(an.heard || 0)} écoutées` : an.fromSaved ? 'Analyse enregistrée' : (SRC && SRC.type === 'file') ? 'Analyse complète' : `Analyse de ${fmtT(an.heard || 0)} écoutées`;
  const segs = an.segments, s0 = segs[0];
  $('k-start').textContent = keyName(s0.key);
  $('k-start-s').textContent = [s0.conf < 0.5 && !s0.edited ? 'à vérifier à l\'oreille' : null, s0.alt ? 'ou ' + keyName(s0.alt) : null, s0.edited ? 'corrigée par toi' : null].filter(Boolean).join(' · ') || (segs.length > 1 ? `${segs.length - 1} ${pl(segs.length - 1, 'modulation', 'modulations')}` : 'aucune modulation');
  // ligne du temps
  const tl = $('tl'); tl.textContent = '';
  const total = Math.max(P.dur() || 0, an.end || 0, segs[segs.length - 1].t1, 1);
  const heardEnd = segs[segs.length - 1].t1;
  segs.forEach((s, i) => {
    const a = i === 0 ? 0 : s.t0, b = i === segs.length - 1 ? (LIVE || (SRC && SRC.type !== 'file' && total - heardEnd > 8) ? heardEnd : total) : segs[i + 1].t0;
    const el = mk('div', 'seg ' + PATS[i % 3], null, tl);
    el.style.left = (100 * a / total) + '%'; el.style.width = Math.max(0.5, 100 * (b - a) / total) + '%';
    mk('span', '', keyShort(shiftKey(s.key, ST)), el);
    if (ST) mk('small', '', 'orig. ' + keyShort(s.key), el);
    el.title = `${fmtT(s.t0)} : ${keyName(shiftKey(s.key, ST))}` + (ST ? ` (original : ${keyName(s.key)})` : '');
  });
  if (heardEnd < total - 8 && SRC && SRC.type !== 'file') {
    const u = mk('div', 'unheard', 'pas encore écouté', tl); u.style.left = (100 * heardEnd / total) + '%';
  }
  if (A != null && B != null && B > A) { const l = mk('div', 'loop', null, tl); l.style.left = (100 * A / total) + '%'; l.style.width = (100 * (B - A) / total) + '%'; }
  const hd = mk('div', 'head', null, tl); hd.id = 'tl-head';
  tl.dataset.total = total;
  tl.setAttribute('aria-label', 'Ligne du temps des tonalités : ' + segs.map(s => fmtT(s.t0) + ' ' + keyName(shiftKey(s.key, ST))).join(', '));
  $('tl-a').textContent = '0:00'; $('tl-b').textContent = fmtT(total);
  drawHead();
  // liste des passages
  const ul = $('mods'); ul.textContent = '';
  segs.forEach((s, i) => {
    const li = mk('li', 'mod', null, ul);
    const w = mk('button', 'when', i === 0 ? 'Début' : fmtT(s.t0), li); w.type = 'button';
    w.title = P.canSeek() ? 'Écouter à partir d\'ici' : '';
    w.onclick = () => { if (P.canSeek()) { P.seek(Math.max(0, s.t0 - (i ? 2 : 0))); P.play(); } };
    const what = mk('div', 'what', null, li);
    const kk = mk('div', 'k', null, what);
    kk.append(i === 0 ? 'Départ : ' : 'Modulation : ');
    if (ST) { kk.append(keyName(shiftKey(s.key, ST))); mk('span', 'note', ` (original : ${keyName(s.key)})`, kk); }
    else kk.append(keyName(s.key));
    if (s.conf < 0.5 && !s.edited) mk('span', 'flag', 'à vérifier', kk);
    const desc = [];
    if (i > 0) desc.push('La chanson ' + KE.describeChange(segs[i - 1].key, s.key));
    if (s.alt) desc.push('ou ' + keyName(shiftKey(s.alt, ST)));
    if (CAPO != null) { const sh = shiftKey(s.key, ST - CAPO); desc.push(`capo ${CAPO} : forme de ${keyName(sh)}` + (friendly(sh) ? '' : ' (moins pratique)')); }
    if (s.edited) desc.push('corrigée par toi');
    if (desc.length) mk('div', 'd', desc.join(' · '), what);
    // correction
    const sel = mk('select', 'sel', null, what); sel.setAttribute('aria-label', 'Corriger la tonalité de ce passage');
    const o0 = mk('option', '', 'Corriger…', sel); o0.value = '';
    for (const mode of ['maj', 'min']) for (let t = 0; t < 12; t++) { const k = { tonic: t, mode }, o = mk('option', '', keyName(k), sel); o.value = t + ':' + mode; }
    sel.onchange = () => {
      if (!sel.value) return;
      const [t, m] = sel.value.split(':');
      OVR = OVR.filter(o => Math.abs(o.t - s.t0) >= 4); OVR.push({ t: s.t0, key: { tonic: +t, mode: m } });
      DIRTY = true; renderAll();
    };
  });
  // accordage
  const tu = an.tuning || 0;
  $('tuning-line').textContent = Math.abs(tu) >= 8 ? `Accordage de l'enregistrement : environ ${signed(tu)} cents (La ≈ ${Math.round(440 * Math.pow(2, tu / 1200))} Hz). Tu peux le ramener à La 440 dans « Accordage fin ».` : 'L\'enregistrement est accordé à La 440.';
  $('tune-440').disabled = Math.abs(tu) < 3;
  $('tuning-note').textContent = Math.abs(tu) >= 3 ? `Cet enregistrement est accordé environ ${signed(tu)} cents ${tu > 0 ? 'plus haut' : 'plus bas'} que La 440. « Ramener à La 440 » le corrige pour que ton instrument sonne juste avec lui.` : 'Utile quand un enregistrement n\'est pas accordé à La 440 : ton instrument sonnera juste avec la chanson.';
  renderNow();
}
function drawHead() {
  const tl = $('tl'), hd = $('tl-head'); if (!hd) return;
  const t = P.time(), total = +tl.dataset.total || 1;
  if (t == null || SRC && SRC.type === 'tab') { hd.hidden = true; return; }
  hd.hidden = false; hd.style.left = Math.min(100, 100 * t / total) + '%';
}
function renderNow() {
  const an = shownAnalysis(); if (!an) return;
  const i = Math.max(0, curSegIdx()), s = an.segments[i], k = shiftKey(s.key, ST);
  $('k-tr-t').textContent = an.segments.length > 1 && P.time() != null ? 'Ce que tu entends maintenant' : 'Ce que tu entends';
  $('k-tr').textContent = keyName(k); syncBar();
  $('k-tr-s').textContent = ST ? `transposée de ${signed(ST)} ${pl(ST, 'demi-ton', 'demi-tons')}` : 'tonalité originale';
}
/* ---- Capo ---- */
const FRIENDLY = { maj: [7, 0, 2, 4, 9], min: [4, 9, 2] };
const friendly = k => FRIENDLY[k.mode].includes(k.tonic);
function capoOptions(k) {
  const out = [];
  for (let c = 0; c <= 7; c++) { const sh = shiftKey(k, -c); if (friendly(sh)) out.push({ c, sh }); }
  return out.slice(0, 4);
}
function renderCapo() {
  const an = shownAnalysis();
  $('capo-card').hidden = !an;
  if (!an) return;
  const k = shiftKey(an.segments[0].key, ST), opts = capoOptions(k), box = $('capo'); box.textContent = '';
  $('capo-for').textContent = 'pour ' + keyName(k);
  if (CAPO != null && !opts.some(o => o.c === CAPO)) CAPO = null;
  opts.forEach(o => {
    const b = mk('button', '', null, box); b.type = 'button';
    mk('b', '', o.c === 0 ? 'Sans capo' : 'Capo ' + o.c, b); mk('span', '', 'forme de ' + keyName(o.sh), b);
    b.setAttribute('aria-pressed', CAPO === o.c ? 'true' : 'false');
    b.onclick = () => { CAPO = CAPO === o.c ? null : o.c; DIRTY = true; renderCapo(); renderKeys(); };
  });
  $('capo-note').textContent = CAPO != null
    ? (CAPO ? `Avec le capo à la case ${CAPO}, joue les accords comme en ${keyName(shiftKey(k, -CAPO))}.` : `Joue directement en ${keyName(k)}.`) + (an.segments.length > 1 ? ' La forme à jouer après chaque modulation est indiquée dans la liste plus haut.' : '')
    : 'Choisis un capo : Tonality te dira quelle forme d\'accords jouer, même après les modulations.';
}
/* ---- Notes ---- */
function renderStamps() {
  const box = $('stamps'); box.textContent = '';
  const seen = new Set(), re = /\[(\d{1,2}):(\d{2})(?:[.,](\d))?\]/g; let m;
  while ((m = re.exec($('notes').value)) && seen.size < 12) {
    const t = +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 10 : 0); if (seen.has(t)) continue; seen.add(t);
    const b = mk('button', 'chip', '▶ ' + fmtT(t), box); b.type = 'button'; b.title = 'Aller à ' + fmtT(t);
    b.onclick = () => { if (P.canSeek()) { P.seek(t); P.play(); } };
  }
}

/* ================= Librairie ================= */
const LS_KEY = 'tonality-librairie';
const norm = s => (s || '').toLocaleLowerCase('fr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const store = {
  kind: 'local', items: [], col: null, loaded: false,
  async init() {
    let db = null, user = null, uid = null;
    try { [db, user] = await Promise.all([window.claude?.use?.('db'), window.claude?.use?.('user')]); uid = user ? await user.id() : null; } catch (e) { }
    if (db && uid) {
      this.kind = 'db'; this.col = db.collection('data/users/' + uid);
      const timer = setTimeout(() => { if (!this.loaded) $('lib-meta').textContent = 'La librairie tarde à répondre…'; }, 10000);
      this.col.onSnapshot(snap => { clearTimeout(timer); this.loaded = true; this.items = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.kind === 'tonality'); renderLib(); },
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
function itemData() {
  const an = shownAnalysis();
  const src = SRC ? (SRC.type === 'youtube' ? { type: 'youtube', id: SRC.id, url: SRC.url } : SRC.type === 'file' ? { type: 'file', name: SRC.name } : { type: 'tab', id: SRC.id || null }) : null;
  const base = an ? (an.fromSaved ? SAVED : ANA) : null;
  return {
    kind: 'tonality', title: $('f-title').value.trim(), artist: $('f-artist').value.trim(), savedAt: Date.now(), source: src,
    st: ST, cents: CT, tempo: TEMPO, a: A, b: B, loop: LOOP, capo: CAPO, lang: LANG(), notes: $('notes').value, duration: Math.round((DUR || 0) * 10) / 10,
    analysis: base ? { tuning: base.tuning, start: base.start, end: base.end, heard: Math.round((base.heard || 0) * 10) / 10, segments: base.segments.map(s => ({ t0: Math.round(s.t0 * 10) / 10, t1: Math.round(s.t1 * 10) / 10, key: s.key, conf: s.conf, alt: s.alt || null })) } : null,
    ovr: OVR
  };
}
async function saveToLibrary() {
  const st = $('status');
  if (!SRC && !OPENED) { setStatus(st, 'Rien à enregistrer pour l\'instant. Ouvre une chanson d\'abord.', 'err'); return; }
  if (!$('f-title').value.trim()) { setStatus(st, 'Donne un titre à la chanson avant de l\'enregistrer.', 'err'); $('f-title').focus(); return; }
  const item = itemData();
  if (!item.source && OPENED) item.source = OPENED.source;
  if (!item.analysis && OPENED && OPENED.analysis) item.analysis = OPENED.analysis;
  $('save').disabled = true;
  try { const replaced = await store.put(item); OPENED = item; DIRTY = false; setStatus(st, `« ${item.title} » ${replaced ? 'mis à jour' : 'ajouté'} dans la librairie.`, 'ok'); }
  catch (e) { setStatus(st, e && (e.code === 'quota' || e.code === 'quota_exceeded') ? 'La librairie est pleine. Supprime quelques chansons puis réessaie.' : 'L\'enregistrement n\'a pas fonctionné. Réessaie.', 'err'); }
  finally { $('save').disabled = false; }
}
function openItem(it) {
  const src = it.source || {};
  if (src.type === 'youtube' && src.id) loadYouTube(src.id, true);   // ouvre la fenêtre tout de suite (dans le clic)
  else {
    clearSource();
    if (src.type === 'file') { setPh('Fichier : ' + src.name, 'Rouvre ce fichier (bouton « Ouvrir un fichier ») pour l\'écouter avec tes réglages.'); }
    else if (src.type === 'tab') { SRC = { type: 'tab', id: src.id || null }; setPh('Chanson captée dans un autre onglet', 'Fais-la jouer dans un autre onglet, puis active le son transposé.'); showCaptureBox('tab'); }
  }
  OPENED = it;
  ST = it.st || 0; CT = it.cents || 0; TEMPO = it.tempo || 1; A = it.a != null ? it.a : null; B = it.b != null ? it.b : null; LOOP = !!it.loop; CAPO = it.capo != null ? it.capo : null;
  OVR = (it.ovr || []).map(o => ({ t: o.t, key: o.key }));
  SAVED = it.analysis ? Object.assign({}, it.analysis) : null;
  DUR = it.duration || DUR;
  if (it.lang) $('o-lang').value = it.lang;
  $('f-title').value = it.title; $('f-artist').value = it.artist || '';
  $('f-title').dataset.touched = '1'; $('f-artist').dataset.touched = '1';
  $('notes').value = it.notes || '';
  DIRTY = false;
  applyRatio(); applyTempo();
  go('ecouter'); renderAll();
  setStatus($('status'), `« ${it.title} » ouvert depuis la librairie.`, 'ok');
}
const fmtDate = ts => new Date(ts).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' });
function renderLib() {
  const items = store.items;
  $('lib-count').textContent = items.length;
  if (!store.loaded) { $('lib-meta').textContent = 'Chargement de la librairie…'; $('lib').textContent = ''; return; }
  const artistsAll = new Set(items.map(x => norm(x.artist) || '~'));
  $('lib-meta').textContent = items.length ? `${items.length} chanson${items.length > 1 ? 's' : ''} · ${artistsAll.size} artiste${artistsAll.size > 1 ? 's' : ''}` : 'Aucune chanson pour l\'instant';
  const q = norm($('q').value), list = items.filter(x => !q || norm(x.title).includes(q) || norm(x.artist).includes(q) || norm(x.notes).includes(q));
  const box = $('lib'); box.textContent = '';
  if (!items.length || !list.length) {
    const e = mk('div', 'empty', null, box);
    if (!items.length) {
      mk('strong', '', 'Ta librairie est vide', e);
      mk('span', '', 'Ouvre une chanson, règle la transposition, écris tes notes, puis clique sur « Enregistrer dans la librairie ». Elle apparaîtra ici, classée par artiste.', e);
      const b = mk('button', 'btn primary', 'Écouter une chanson', e); b.onclick = () => go('ecouter');
    } else { mk('strong', '', 'Aucun résultat', e); mk('span', '', 'Aucune chanson, aucun artiste ni aucune note ne correspond à ta recherche.', e); }
    return;
  }
  const groups = new Map();
  for (const it of list) { const k = it.artist || 'Artiste inconnu'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const keys = [...groups.keys()].sort((a, b) => (a === 'Artiste inconnu') - (b === 'Artiste inconnu') || a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  for (const k of keys) {
    const songs = groups.get(k).sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
    const g = mk('section', 'artist-group', null, box), h = mk('h2', '', k, g); mk('span', '', songs.length + (songs.length > 1 ? ' chansons' : ' chanson'), h);
    const ul = mk('ul', 'files', null, g);
    for (const it of songs) {
      const li = mk('li', 'file', null, ul);
      const segs = it.analysis && it.analysis.segments || [];
      const k0 = segs[0] ? segs[0].key : null;
      // corrections de la tonalité de départ
      const o0 = (it.ovr || []).find(o => segs[0] && Math.abs(o.t - segs[0].t0) < 4), kStart = o0 ? o0.key : k0;
      const d = mk('div', 'doc', kStart ? keyShort(shiftKey(kStart, it.st || 0), it.lang) : '♪', li); d.setAttribute('aria-hidden', 'true');
      const info = mk('div', 'info', null, li); mk('div', 'name', it.title, info);
      const parts = [];
      if (kStart) parts.push((it.st ? keyName(kStart, it.lang) + ' → ' + keyName(shiftKey(kStart, it.st), it.lang) : keyName(kStart, it.lang)));
      if (it.st) parts.push('transposée ' + signed(it.st));
      if (segs.length > 1) parts.push(`${segs.length - 1} ${pl(segs.length - 1, 'modulation', 'modulations')}`);
      if (it.capo) parts.push('capo ' + it.capo);
      if (it.tempo && it.tempo !== 1) parts.push('tempo ' + Math.round(it.tempo * 100) + ' %');
      if (it.source && it.source.type === 'youtube') parts.push('YouTube'); else if (it.source && it.source.type === 'file') parts.push('fichier');
      parts.push('enregistrée le ' + fmtDate(it.savedAt));
      mk('div', 'sub2', parts.join(' · '), info);
      if (it.notes && it.notes.trim()) mk('div', 'nt', '📝 ' + it.notes.trim().split('\n')[0], info);
      const acts = mk('div', 'acts', null, li);
      const op = mk('button', 'btn small primary', 'Ouvrir', acts); op.setAttribute('aria-label', 'Ouvrir ' + it.title); op.onclick = () => openItem(it);
      const del = mk('button', 'btn small', 'Supprimer', acts); del.setAttribute('aria-label', 'Supprimer ' + it.title);
      del.onclick = () => {
        acts.textContent = '';
        const yes = mk('button', 'btn small danger', 'Oui, supprimer', acts), no = mk('button', 'btn small', 'Annuler', acts);
        yes.onclick = async () => { yes.disabled = true; try { await store.remove(it.id); setStatus($('lib-status'), `« ${it.title} » supprimée.`, 'ok'); } catch (e) { setStatus($('lib-status'), 'La suppression n\'a pas fonctionné. Réessaie.', 'err'); renderLib(); } };
        no.onclick = renderLib; yes.focus();
      };
    }
  }
}

/* ================= Navigation ================= */
function go(view, push = true) {
  const lib = view === 'librairie';
  $('v-ec').hidden = lib; $('v-lib').hidden = !lib;
  $('t-ec').removeAttribute('aria-current'); $('t-lib').removeAttribute('aria-current');
  (lib ? $('t-lib') : $('t-ec')).setAttribute('aria-current', 'page');
  if (lib) renderLib();
  updateBarVisibility();
  if (push && location.hash !== '#' + view) try { history.replaceState(null, '', '#' + view); } catch (e) { location.hash = view; }
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
window.addEventListener('hashchange', () => go(location.hash === '#librairie' ? 'librairie' : 'ecouter', false));

/* ================= Branchements ================= */
const confirmLeave = () => !DIRTY || confirm('Tes notes ou tes réglages pour cette chanson ne sont pas enregistrés. Continuer quand même?');
$('url-form').addEventListener('submit', e => {
  e.preventDefault();
  const id = ytId($('url').value);
  if (!id) { setStatus($('src-status'), 'Ce lien ne ressemble pas à une vidéo YouTube. Pour un autre site, utilise « Transposer un autre onglet ».', 'err'); return; }
  if (!confirmLeave()) return;
  resetSong();
  loadYouTube(id);
});
$('file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (!(OPENED && OPENED.source && OPENED.source.name === f.name) && !confirmLeave()) return; loadFile(f); });
$('other-tab').addEventListener('click', () => { if (!confirmLeave()) return; resetSong(); useOtherTab(); });
const drop = $('url-form');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) { e.preventDefault(); if (confirmLeave()) loadFile(e.dataTransfer.files[0]); } });
$('activate').onclick = activate;
$('deactivate').onclick = () => deactivate(false);
$('play').onclick = togglePlay;
$('back5').onclick = () => { const t = P.time(); if (t != null) P.seek(t - 5); };
$('seek').addEventListener('pointerdown', e => e.target.dataset.drag = '1');
$('seek').addEventListener('pointerup', e => delete e.target.dataset.drag);
$('seek').addEventListener('input', e => P.seek(+e.target.value));
// transposition
const setST = v => { ST = Math.max(-12, Math.min(12, v)); applyRatio(); DIRTY = true; syncControls(); renderTp(); renderKeys(); renderCapo(); };
$('tp-up').onclick = () => setST(ST + 1);
$('q-up').onclick = () => setST(ST + 1);
$('q-down').onclick = () => setST(ST - 1);
$('q-zero').onclick = () => setST(0);
$('q-play').onclick = togglePlay;
// la barre apparaît quand les boutons de transposition principaux ne sont plus à l'écran
if ('IntersectionObserver' in window) {
  new IntersectionObserver(es => { tpCardVisible = es[0].isIntersecting; updateBarVisibility(); }, { threshold: 0.15 }).observe($('tp-n').closest('.tp'));
} else tpCardVisible = false;
$('tp-down').onclick = () => setST(ST - 1);
$('tp-zero').onclick = () => setST(0);
$('tp-range').addEventListener('input', e => setST(+e.target.value));
$('tp-target').addEventListener('change', e => { if (e.target.value !== '') setST(+e.target.value); });
$('cents').addEventListener('input', e => { CT = +e.target.value; applyRatio(); DIRTY = true; syncControls(); });
$('o-voice').addEventListener('change', e => { NATURAL = e.target.checked; try { localStorage.setItem('tonality-voix', NATURAL ? '1' : '0'); } catch (er) { } applyRatio(); });
$('cents-zero').onclick = () => { CT = 0; applyRatio(); syncControls(); };
$('tune-440').onclick = () => { const an = shownAnalysis(); if (!an) return; CT = Math.max(-50, Math.min(50, -an.tuning)); applyRatio(); DIRTY = true; syncControls(); };
$('o-lang').addEventListener('change', () => { try { localStorage.setItem('tonality-lang', LANG()); } catch (e) { } renderAll(); renderLib(); });
try { const l = localStorage.getItem('tonality-lang'); if (l) $('o-lang').value = l; } catch (e) { }
// boucle et tempo
const nowT = () => { const t = P.time(); return t == null ? null : Math.round(t * 10) / 10; };
$('set-a').onclick = () => { const t = nowT(); if (t == null) return; A = t; if (B != null && B <= A) B = null; DIRTY = true; syncControls(); renderKeys(); };
$('set-b').onclick = () => { const t = nowT(); if (t == null) return; if (A != null && t <= A + 0.2) { setStatus($('src-status'), 'Le point B doit venir après le point A.', 'err'); return; } B = t; if (A != null) LOOP = true; DIRTY = true; syncControls(); renderKeys(); };
$('a-m').onclick = () => { A = Math.max(0, Math.round((A - 0.1) * 10) / 10); syncControls(); renderKeys(); };
$('a-p').onclick = () => { A = Math.round((A + 0.1) * 10) / 10; if (B != null && A >= B) A = B - 0.2; syncControls(); renderKeys(); };
$('b-m').onclick = () => { B = Math.round((B - 0.1) * 10) / 10; if (A != null && B <= A) B = A + 0.2; syncControls(); renderKeys(); };
$('b-p').onclick = () => { B = Math.round((B + 0.1) * 10) / 10; syncControls(); renderKeys(); };
$('loop').onclick = () => { LOOP = !LOOP; syncControls(); if (LOOP && A != null) { const t = P.time(); if (t != null && (t < A || t > B)) P.seek(A); } };
$('go-a').onclick = () => { if (A != null) { P.seek(A); P.play(); } };
$('clear-ab').onclick = () => { A = null; B = null; LOOP = false; syncControls(); renderKeys(); };
$('tempo').addEventListener('input', e => { TEMPO = +e.target.value / 100; DIRTY = true; syncControls(); applyTempo(); });
$('tempo-reset').onclick = () => { TEMPO = 1; syncControls(); applyTempo(); };
// ligne du temps : clic = aller à ce moment
$('tl').addEventListener('click', e => {
  if (!P.canSeek()) return;
  const r = e.currentTarget.getBoundingClientRect(), total = +e.currentTarget.dataset.total || 0;
  if (total) P.seek(total * (e.clientX - r.left) / r.width);
});
// notes
$('stamp').onclick = () => {
  const t = P.time(), ta = $('notes'); if (t == null) { ta.focus(); return; }
  const s = '[' + fmtT(t) + '] ', a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  const pre = ta.value.slice(0, a), lead = pre && !/\n$/.test(pre) ? '\n' : '';
  ta.value = pre + lead + s + ta.value.slice(b);
  const pos = (pre + lead + s).length; ta.focus(); ta.setSelectionRange(pos, pos);
  DIRTY = true; renderStamps();
};
$('notes').addEventListener('input', () => { DIRTY = true; renderStamps(); });
['f-title', 'f-artist'].forEach(id => $(id).addEventListener('input', e => { e.target.dataset.touched = '1'; DIRTY = true; }));
$('save').addEventListener('click', saveToLibrary);
$('q').addEventListener('input', renderLib);
// raccourcis clavier : espace = lecture/pause, flèches haut/bas = transposition
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || e.ctrlKey || e.metaKey || e.altKey || $('v-ec').hidden) return;
  if (e.key === ' ' && SRC && P.canSeek()) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setST(ST + 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setST(ST - 1); }
});
window.addEventListener('beforeunload', e => { if (DIRTY || CAP) { e.preventDefault(); e.returnValue = ''; } });

if (!canCapture) $('other-tab').hidden = true;
syncEngine();
renderAll();
go(location.hash === '#librairie' ? 'librairie' : 'ecouter', false);
store.init();
// Pour les tests
if (/[?&]demo\b/.test(location.search)) window.__tonality = { get ENGINE() { return ENGINE; }, get ANA() { return ANA; }, set ANA(v) { ANA = v; }, loadFile, renderAll, shownAnalysis, store, setST, get ST() { return ST; } };
