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
    if (!ctx.__tonalityModule) ctx.__tonalityModule = ctx.audioWorklet.addModule(HERE + 'shifter.js?v=3');
    await ctx.__tonalityModule;
    let node = null, kind = 'maison';
    if (!opts.forceMaison && typeof root.SignalsmithStretch === 'function') {
      try {
        node = await root.SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        kind = 'signalsmith'; node.start();
      } catch (e) { console.warn('Tonality : Signalsmith Stretch indisponible, moteur maison utilisé', e); node = null; }
    }
    if (!node) node = new AudioWorkletNode(ctx, 'tonality-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { ratio: 1 } });
    node.connect(opts.destination || ctx.destination);
    let tap = null, sink = null;
    if (opts.onChunk) {
      tap = new AudioWorkletNode(ctx, 'tonality-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      tap.port.onmessage = e => { if (e.data && e.data.chunk) opts.onChunk(e.data.chunk, ctx.sampleRate); };
      sink = ctx.createGain(); sink.gain.value = 0; tap.connect(sink); sink.connect(ctx.destination);
    }
    const srcs = [];
    const eng = {
      kind, node,
      plug(src) { src.connect(node); if (tap) src.connect(tap); srcs.push(src); },
      set(p) { // p : {st, ct, natural}
        const st = p.st || 0, ct = p.ct || 0;
        if (kind === 'signalsmith') node.schedule({ active: true, semitones: st + ct / 100, formantCompensation: !!p.natural && (st !== 0 || ct !== 0), formantSemitones: 0, formantBaseHz: FORMANT_BASE_HZ });
        else node.port.postMessage({ ratio: Math.pow(2, (st * 100 + ct) / 1200) });
      },
      dispose() {
        srcs.forEach(s => { try { s.disconnect(); } catch (e) { } });
        [node, tap, sink].forEach(n => { if (n) try { n.disconnect(); } catch (e) { } });
      }
    };
    if (opts.params) eng.set(opts.params);
    return eng;
  }
  root.TonalityAudio = { build, FORMANT_BASE_HZ };
})(window);
