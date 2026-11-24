/* Tonality — moteur audio partagé (page principale et fenêtre « Moteur audio »).
   Transposition : Signalsmith Stretch (WASM, licence MIT) avec correction des formants; moteur maison (shifter.js) en secours.
   Une écoute séparée du son original (avant transposition) alimente l'analyse de tonalité. */
(function (root) {
  'use strict';
  const HERE = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') : '';
  // Fréquence de base fixe pour l'analyse des formants : en mode automatique, le moteur suit parfois les instruments
  // (mélodie discrète, voix de tête) et baisse alors le volume de la voix. 200 Hz donne un timbre aussi juste, sans baisse.
  const FORMANT_BASE_HZ = 200;

  async function build(ctx, opts) {
    opts = opts || {};
    if (!ctx.__tonalityModule) ctx.__tonalityModule = ctx.audioWorklet.addModule(HERE + 'shifter.js?v=4');
    await ctx.__tonalityModule;
    let node = null, kind = 'maison';
    if (!opts.forceMaison && typeof root.SignalsmithStretch === 'function') {
      try {
        node = await root.SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        kind = 'signalsmith'; node.start();
      } catch (e) { console.warn('Tonality : Signalsmith Stretch indisponible, moteur maison utilisé', e); node = null; }
    }
    if (!node) node = new AudioWorkletNode(ctx, 'tonality-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { ratio: 1 } });
    // volume de la chanson (après le moteur), puis sortie
    const out = ctx.createGain(); out.gain.value = opts.volume != null ? opts.volume : 1;
    node.connect(out); out.connect(opts.destination || ctx.destination);
    // latence du moteur (secondes) : sert à caler le métronome sur le son entendu
    let latency = kind === 'maison' ? (ctx.sampleRate > 60000 ? 8192 : 4096) * 0.75 / ctx.sampleRate : 0.1;
    if (kind === 'signalsmith') { try { latency = await node.latency(); } catch (e) { } }
    let tap = null, sink = null;
    if (opts.onChunk) {
      tap = new AudioWorkletNode(ctx, 'tonality-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      // t : heure (horloge audio) du dernier échantillon du bloc → convertie en heure absolue, pour situer le bloc dans la chanson sans dépendre des délais de messages
      tap.port.onmessage = e => { if (e.data && e.data.chunk) { const abs = e.data.t != null ? performance.timeOrigin + performance.now() - (ctx.currentTime - e.data.t) * 1000 : null; opts.onChunk(e.data.chunk, ctx.sampleRate, abs); } };
      sink = ctx.createGain(); sink.gain.value = 0; tap.connect(sink); sink.connect(ctx.destination);
    }
    const srcs = [];
    const eng = {
      kind, node, latency,
      setVolume(v) { out.gain.setTargetAtTime(v, ctx.currentTime, 0.02); },
      plug(src) { src.connect(node); if (tap) src.connect(tap); srcs.push(src); },
      set(p) { // p : {st, ct, natural}
        const st = p.st || 0, ct = p.ct || 0;
        if (kind === 'signalsmith') node.schedule({ active: true, semitones: st + ct / 100, formantCompensation: !!p.natural && (st !== 0 || ct !== 0), formantSemitones: 0, formantBaseHz: FORMANT_BASE_HZ });
        else node.port.postMessage({ ratio: Math.pow(2, (st * 100 + ct) / 1200) });
      },
      dispose() {
        srcs.forEach(s => { try { s.disconnect(); } catch (e) { } });
        [node, out, tap, sink].forEach(n => { if (n) try { n.disconnect(); } catch (e) { } });
      }
    };
    if (opts.params) eng.set(opts.params);
    return eng;
  }
  /* ---------- Métronome : sons synthétisés (aucun fichier à charger) ---------- */
  // level : 2 = premier temps (accent), 1 = temps, 0 = subdivision
  function clickSamples(sr, sound, level) {
    const len = Math.floor(sr * (sound === 'cloche' ? 0.22 : 0.09)), x = new Float32Array(len);
    const f = { 2: 1.5, 1: 1, 0: 0.8 }[level], amp = { 2: 1, 1: 0.75, 0: 0.42 }[level];
    let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let i = 0; i < len; i++) {
      const t = i / sr; let v = 0;
      if (sound === 'bip') v = Math.sin(2 * Math.PI * 1000 * f * t) * Math.exp(-t / 0.025);
      else if (sound === 'bois') v = (0.8 * Math.sin(2 * Math.PI * 1150 * f * t) + 0.45 * Math.sin(2 * Math.PI * 2380 * f * t)) * Math.exp(-t / 0.014) + 0.35 * rnd() * Math.exp(-t / 0.0015);
      else if (sound === 'clave') v = Math.sin(2 * Math.PI * 2500 * f * t) * Math.exp(-t / 0.02);
      else if (sound === 'cloche') { const a = Math.sign(Math.sin(2 * Math.PI * 562 * f * t)), b = Math.sign(Math.sin(2 * Math.PI * 845 * f * t)); v = 0.35 * (a + b) * (Math.exp(-t / 0.03) * 0.6 + Math.exp(-t / 0.12) * 0.4); }
      else v = rnd() * Math.exp(-t / (0.0025 * f)); // clic
      x[i] = v * amp * Math.min(1, i / 8);
    }
    return x;
  }
  const bufCache = new WeakMap();
  function playClick(ctx, when, sound, level, volume) {
    let m = bufCache.get(ctx); if (!m) { m = {}; bufCache.set(ctx, m); }
    const key = sound + level;
    if (!m[key]) { const d = clickSamples(ctx.sampleRate, sound, level), b = ctx.createBuffer(1, d.length, ctx.sampleRate); b.copyToChannel(d, 0); m[key] = b; }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = m[key]; g.gain.value = Math.max(0, Math.min(1.5, volume));
    src.connect(g); g.connect(ctx.destination);
    src.start(Math.max(ctx.currentTime, when));
    src.onended = () => { try { g.disconnect(); } catch (e) { } };
  }
  root.TonalityAudio = { build, FORMANT_BASE_HZ, playClick, clickSamples };
})(window);
