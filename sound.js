// Interaction sounds, synthesised with Web Audio: no audio files, no library. Ported from the
// portfolio's lib/sound.ts: layered recipes, a very short burst of filtered noise for the
// tick and a short tone for the body. Low and round (soft felt, not bright plastic), and
// every pitched note sits in D major so the sounds agree with each other.
//
// Silent until the first gesture (browsers keep audio locked until then). Off for anyone who
// set localStorage.sound = "off" (the speaker button in the nav). On by default.

// D major, around D5 587.33
const D3 = 146.83, A3 = 220, D4 = 293.66, A4 = 440;
const D5 = 587.33, A5 = 880, D6 = 1174.66;
// Notes a bead can ring at: D6 E6 F#6 A6, as ratios of D6 (`pitch` below).
export const BEAD_PITCHES = [1, 1318.51 / D6, 1479.98 / D6, 1760 / D6];

// A layer is a tone ({ type, freq: Hz or [from, to] glide, fm: [ratio, depth] }) or filtered
// noise ({ noise: { filter, freq or [from, to] sweep, q } }), with attack, decay and gain, and
// an optional delay (s). `gap` is how soon the sound may play again (s).
export const SOUNDS = {
  // the lamp's switch: the portfolio's soft, deep felt tap, unchanged
  tap: [
    { noise: { filter: "lowpass", freq: 1200, q: 0.7 }, decay: 0.014, gain: 0.35 },
    { type: "sine", freq: [D5 / 2, 230], attack: 0.002, decay: 0.07, gain: 0.55 },
    { type: "sine", freq: [D5, 520], attack: 0.002, decay: 0.035, gain: 0.18, delay: 0.004 },
  ],
  // curtain: wooden beads clicking together
  bead: Object.assign([
    { noise: { filter: "bandpass", freq: 2600, q: 2 }, decay: 0.007, gain: 0.16 },
    { type: "sine", freq: D6, attack: 0.001, decay: 0.03, gain: 0.07 },
  ], { gap: 0.03 }),
  // rocking chair: a low wooden creak as it turns around, and a knock at an end stop
  creak: Object.assign([
    { type: "triangle", freq: [D3, 138.59], fm: [1.5, 14], attack: 0.05, decay: 0.24, gain: 0.1 },
    { noise: { filter: "bandpass", freq: 520, q: 4 }, attack: 0.04, decay: 0.2, gain: 0.05 },
  ], { gap: 0.3 }),
  knock: [
    { noise: { filter: "lowpass", freq: 800, q: 0.7 }, decay: 0.012, gain: 0.22 },
    { type: "sine", freq: [D4, A3], attack: 0.002, decay: 0.06, gain: 0.26 },
  ],
  // clock: a very quiet tick-tock as the pendulum passes the middle
  tick: [
    { noise: { filter: "bandpass", freq: 3000, q: 2 }, decay: 0.005, gain: 0.05 },
    { type: "sine", freq: A5, attack: 0.001, decay: 0.018, gain: 0.025 },
  ],
  tock: [
    { noise: { filter: "bandpass", freq: 2400, q: 2 }, decay: 0.005, gain: 0.05 },
    { type: "sine", freq: D5, attack: 0.001, decay: 0.02, gain: 0.025 },
  ],
  // room: picking a piece up, setting it down, putting it away, and the drawer sliding
  lift: [
    { noise: { filter: "lowpass", freq: 1500, q: 0.7 }, decay: 0.01, gain: 0.06 },
    { type: "sine", freq: [A4, D5], attack: 0.006, decay: 0.06, gain: 0.1 },
  ],
  thud: [
    { noise: { filter: "lowpass", freq: 480, q: 0.7 }, decay: 0.03, gain: 0.32 },
    { type: "sine", freq: [D4, D3], attack: 0.002, decay: 0.09, gain: 0.4 },
  ],
  pop: [
    { noise: { filter: "lowpass", freq: 900, q: 0.7 }, decay: 0.02, gain: 0.16 },
    { type: "sine", freq: [D5, A4], attack: 0.003, decay: 0.05, gain: 0.18 },
  ],
  // rolling table: a tiny soft bump against a wall
  bump: [
    { noise: { filter: "lowpass", freq: 600, q: 0.7 }, decay: 0.015, gain: 0.18 },
    { type: "sine", freq: [A3, D3], attack: 0.002, decay: 0.07, gain: 0.22 },
  ],
  slideOpen: [
    { noise: { filter: "bandpass", freq: [500, 1400], q: 1.2 }, attack: 0.05, decay: 0.17,
      gain: 0.07 },
  ],
  slideClose: [
    { noise: { filter: "bandpass", freq: [1400, 500], q: 1.2 }, attack: 0.05, decay: 0.17,
      gain: 0.07 },
  ],
};

const VOLUME = 0.35;
const MIN_GAP = 0.04; // s: the same sound can't retrigger faster than this
const SILENT = 0.0001;
const STORE = "sound";

let ctx = null, out = null, noiseBuffer = null;
const lastPlayed = new Map();

export const soundEnabled = () => {
  try { return localStorage.getItem(STORE) !== "off"; } catch { return true; }
};

export const setSoundEnabled = (on) => {
  try { localStorage.setItem(STORE, on ? "on" : "off"); } catch {}
  if (on) unlockSound();
};

// Call from a user gesture; audio stays locked until one happens.
export function unlockSound() {
  if (!soundEnabled()) return;
  if (!ctx) {
    ctx = new AudioContext();
    out = new GainNode(ctx, { gain: VOLUME });
    // rounds off anything harsh before it reaches the speakers
    const soften = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6000 });
    out.connect(soften).connect(ctx.destination);
    noiseBuffer = new AudioBuffer({ length: ctx.sampleRate * 0.5, sampleRate: ctx.sampleRate });
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume();
}

// Starting audio the first time can hold the page for a moment (~170 ms in Chrome), which at
// pointerdown or pointerup hitches the first drag or the cord springing back. So after the
// first gesture ends, wait until nothing is held for a beat, then unlock (Chrome and Firefox
// allow it once the page has been used). Where that isn't enough (Safari wants it inside a
// gesture), the next gesture's end unlocks right away.
const UNLOCK_QUIET = 600; // ms with no pointer held
export function unlockOnGesture() {
  const ends = ["pointerup", "touchend", "keydown"];
  let held = 0, timer = 0, tried = false;
  const done = () => {
    for (const type of ends) removeEventListener(type, onEnd, true);
    removeEventListener("pointerdown", onDown, true);
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (held ? later() : unlockSound()), UNLOCK_QUIET);
  };
  const onDown = () => { held++; };
  const onEnd = (e) => {
    if (e.type === "pointerup") held = Math.max(0, held - 1);
    if (ctx?.state === "running") return done();
    if (!tried) { tried = true; later(); } else unlockSound();
  };
  addEventListener("pointerdown", onDown, true);
  for (const type of ends) addEventListener(type, onEnd, true);
}

// Debug hook for tests, off unless a page sets window.__sounds = [].
const log = (name, gain) => window.__sounds?.push({
  name, gain: +gain.toFixed(2), t: +(performance.now() / 1000).toFixed(3),
});

// A continuous sound that follows a level instead of playing once: the table's rolling rumble
// (low filtered noise). `set(level)` takes 0–1 and glides there; 0 is silent.
const RUMBLE = { freq: 260, q: 0.8, gain: 0.12 };
export function rumble() {
  let source = null, level = null, on = false;
  const start = () => {
    source = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer, loop: true });
    level = new GainNode(ctx, { gain: 0 });
    const filter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: RUMBLE.freq, Q: RUMBLE.q });
    source.connect(filter).connect(level).connect(out);
    source.start();
  };
  return {
    set(x) {
      const playing = x > 0.001 && soundEnabled();
      if (playing && !on) log("rumble", x);
      on = playing;
      if (!ctx || ctx.state !== "running") return;
      if (!source) start();
      level.gain.setTargetAtTime(playing ? x * RUMBLE.gain : 0, ctx.currentTime, 0.06);
    },
    stop() {
      source?.stop();
      source?.disconnect();
      source = null;
    },
  };
}

// `gain` scales the whole sound (0–1), `pitch` multiplies every tone's frequency.
export function playSound(name, { gain = 1, pitch = 1 } = {}) {
  const recipe = SOUNDS[name];
  if (!recipe || !soundEnabled()) return;
  const t = performance.now() / 1000;
  if (t - (lastPlayed.get(name) ?? -1) < (recipe.gap ?? MIN_GAP)) return;
  lastPlayed.set(name, t);
  log(name, gain);
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const layer of recipe) playLayer(layer, now + (layer.delay ?? 0), gain, pitch);
}

function playLayer(layer, start, gain, pitch) {
  const attack = layer.attack ?? 0.001;
  const end = start + attack + layer.decay;
  const peak = Math.max(SILENT * 2, layer.gain * gain);

  const envelope = new GainNode(ctx, { gain: SILENT });
  envelope.gain.setValueAtTime(SILENT, start);
  envelope.gain.exponentialRampToValueAtTime(peak, start + attack);
  envelope.gain.exponentialRampToValueAtTime(SILENT, end);
  envelope.connect(out);

  const sources = [];
  if (layer.noise) {
    const [from, to] = typeof layer.noise.freq === "number"
      ? [layer.noise.freq, layer.noise.freq] : layer.noise.freq;
    const source = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer });
    const { filter: type, q = 1 } = layer.noise;
    const filter = new BiquadFilterNode(ctx, { type, frequency: from, Q: q });
    if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, end);
    source.connect(filter).connect(envelope);
    sources.push(source);
  } else {
    const [from, to] = (typeof layer.freq === "number" ? [layer.freq, layer.freq] : layer.freq)
      .map((f) => f * pitch);
    const osc = new OscillatorNode(ctx, { type: layer.type, frequency: from });
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, end);
    if (layer.fm) {
      const [ratio, depth] = layer.fm;
      const mod = new OscillatorNode(ctx, { frequency: from * ratio });
      mod.connect(new GainNode(ctx, { gain: depth })).connect(osc.frequency);
      sources.push(mod);
    }
    osc.connect(envelope);
    sources.push(osc);
  }

  for (const source of sources) {
    source.start(start);
    source.stop(end + 0.02);
  }
  sources[sources.length - 1].onended = () => envelope.disconnect();
}
