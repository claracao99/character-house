#!/usr/bin/env node
// Renders Character House as short clips for sharing (lamp, curtain, pram) and stills of every
// piece, in light and dark.
//
//   python3 serve.py                                    # in another terminal (port 5180)
//   node scripts/render-videos.mjs [lamp curtain pram stills]   # default: all of them
//   → ~/Downloads/character-house-social/
//
// Nothing is filmed. A headless Chrome runs the page on a virtual clock that only moves when
// this script ticks it, and every 1/60 s is screenshotted: a constant 60fps however busy the
// machine is, nothing from the desktop in frame, the same take every render.
//
// The cursor is drawn into the page (a real one isn't in a screenshot): macOS's own hand
// cursors and a matching arrow, taking the page's cursor wherever it is. It follows the
// scripted mouse, which moves like a hand: eased, slightly curved paths with a little tremor
// and small corrections.
//
// Sound: the page logs every sound it plays (sound.js, window.__sounds) with its time on the
// virtual clock. After the take the log is played again into an OfflineAudioContext from the
// same recipes (sound.js's SOUNDS, VOLUME, RUMBLE), and muxed in frame-accurately.
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN
  || join(homedir(), ".cache/puppeteer/chrome/mac_arm-154.0.8037.92/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
if (!existsSync(CHROME)) { console.error(`Chrome for Testing not found at ${CHROME} (set CHROME_BIN)`); process.exit(1); }
const SERVER = "http://localhost:5180";
const OUT = join(homedir(), "Downloads/character-house-social");
const FPS = 60, DT = 1000 / FPS;
const VIEW = { w: 1280, h: 720 }; // CSS px; clips render at 1.5× → 1920×1080, stills at 3× → 3840×2160
const CLIP_SCALE = 1.5, STILL_SCALE = 3;
const PORT = 9700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);

// A minimal DevTools client over Node's WebSocket.
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data), p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
    close: () => ws.close(),
  };
}

// ── Virtual time (as in clara-rider-playground's render-activity-clips.mjs) ───────────────
// The page's clocks and schedulers advance only in __tick(dt); CSS animations and transitions
// are paused as they appear and have their currentTime set from the virtual clock.
const VIRTUAL_TIME = `(() => {
  let now = 0
  const realSetTimeout = window.setTimeout.bind(window)
  const timers = []; let tid = 1
  const rafs = []; let rid = 1
  performance.now = () => now
  const epoch = Date.now(), RealDate = Date
  RealDate.now = () => epoch + now
  window.setTimeout = (fn, ms = 0, ...args) => { const id = tid++; timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn, args }); return id }
  window.clearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
  window.setInterval = (fn, ms = 0, ...args) => { const id = tid++; const every = Math.max(1, Number(ms) || 0); timers.push({ id, at: now + every, fn, args, every }); return id }
  window.clearInterval = window.clearTimeout
  window.requestAnimationFrame = (fn) => { const id = rid++; rafs.push({ id, fn }); return id }
  window.cancelAnimationFrame = (id) => { const i = rafs.findIndex((r) => r.id === id); if (i >= 0) rafs.splice(i, 1) }
  const seen = new Map()
  const syncAnimations = () => {
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) { seen.set(a, now); a.pause() }
      try { a.currentTime = now - seen.get(a) } catch {}
    }
    for (const a of [...seen.keys()]) if (a.playState === 'finished' || a.playState === 'idle') seen.delete(a)
  }
  const yieldReal = () => new Promise((r) => realSetTimeout(r, 0))
  window.__tick = async (dt) => {
    now += dt
    for (let guard = 0; guard < 1000; guard++) {
      timers.sort((a, b) => a.at - b.at)
      if (!timers.length || timers[0].at > now) break
      const t = timers.shift()
      try { t.fn(...t.args) } catch (e) { console.error(e) }
      if (t.every) { t.at = Math.max(t.at + t.every, now + 0.01); timers.push(t) }
    }
    for (const r of rafs.splice(0)) { try { r.fn(now) } catch (e) { console.error(e) } }
    await yieldReal(); syncAnimations(); await yieldReal(); syncAnimations()
    window.__cursorUpdate?.()
    return now
  }
})()`;

// ── The drawn cursor ──────────────────────────────────────────────────────────────────────
// The hands are macOS's own cursors (HIServices' openhand, closedhand and pointinghand PDFs,
// rasterised at 4× with sips, hotspots from their info.plist); the arrow, which macOS doesn't
// keep as a file, is drawn to match. Each has a box (CSS px) and the hotspot within it.
const MAC_CURSORS = "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Resources/cursors";
const macCursor = (name, hot) => {
  const png = join(mkdtempSync(join(tmpdir(), "ch-cursor-")), `${name}.png`);
  execSync(`sips -s format png -z 128 128 "${MAC_CURSORS}/${name}/cursor.pdf" --out "${png}"`, { stdio: "ignore" });
  const src = `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  return { box: 32, hot, html: `<img src="${src}" width="100%" height="100%" style="display:block">` };
};
const ICONS = {
  arrow: { box: 26, hot: [4.55, 4.55], html: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>` },
  pointer: macCursor("pointinghand", [13, 8]),
  grab: macCursor("openhand", [16, 17]),
  grabbing: macCursor("closedhand", [16, 17]),
};
const CURSOR = `(() => {
  const ICONS = ${JSON.stringify(ICONS)}
  let el = null, x = -200, y = -200, kind = ''
  const show = () => {
    if (!el) {
      if (!document.body) return
      el = document.createElement('div')
      // the soft shadow macOS draws under its cursors
      Object.assign(el.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', filter: 'drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35))' })
      document.body.append(el)
    }
    const t = document.elementFromPoint(x, y)
    const c = t ? getComputedStyle(t).cursor : 'default'
    const k = c === 'grab' || c === 'grabbing' || c === 'pointer' ? c : 'arrow'
    const icon = ICONS[k]
    if (k !== kind) { kind = k; el.innerHTML = icon.html; el.style.width = el.style.height = icon.box + 'px' }
    el.style.transform = 'translate(' + (x - icon.hot[0]) + 'px,' + (y - icon.hot[1]) + 'px)'
  }
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; show() }, true)
  window.__cursorUpdate = show
})()`;

// ── Driver ───────────────────────────────────────────────────────────────────────────────
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "ch-render-"));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars",
    `--window-size=${VIEW.w},${VIEW.h}`, "--force-device-scale-factor=1", "--mute-audio", "--no-first-run", "--use-mock-keychain",
    "--password-store=basic", "--disable-features=PaintHolding", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
  const t0 = Date.now();
  while (!(await reachable(`http://localhost:${PORT}/json/version`))) { if (Date.now() - t0 > 20000) throw new Error("Chrome never came up"); await sleep(200); }
  return { close: async () => { proc.kill(); await sleep(500); rmSync(profile, { recursive: true, force: true }); } };
}

async function openPage(hash, { theme = "light", cursor = true, still = false, virtual = true } = {}) {
  const target = await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // stills hold every piece at rest (the chair's idle rock, the pendulum)
  if (still) await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (virtual) await c.send("Page.addScriptToEvaluateOnNewDocument", { source: VIRTUAL_TIME });
  await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.clear(); ${theme === "dark" ? "localStorage.setItem('character-house-theme', 'dark');" : ""} } catch {} window.__sounds = [];` });
  if (cursor) await c.send("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR });
  await c.send("Page.navigate", { url: `${SERVER}/#${hash}` });
  const ev = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  { const t0 = Date.now(); while (!(await ev(`!!document.querySelector('#stage > *') && (${!virtual} || typeof window.__tick === 'function')`))) { if (Date.now() - t0 > 30000) throw new Error("page never mounted"); await sleep(200); } }
  await ev(`document.fonts.ready.then(() => true)`);
  { const t0 = Date.now(); while (!(await ev(`[...document.images].every((i) => i.complete && i.naturalWidth > 0)`))) { if (Date.now() - t0 > 30000) throw new Error("images never loaded"); await sleep(200); } }
  if (virtual) for (let i = 0; i < FPS * 2; i++) await ev(`window.__tick(${DT})`); // settle: fades, the cord's first sway
  return { c, ev, close: () => { c.close(); fetch(`http://localhost:${PORT}/json/close/${target.id}`).catch(() => {}); } };
}

// The script's hand: ticks frames (recording them while a sink is set) and moves the mouse.
function driver({ c, ev }) {
  let sink = null, held = false;
  const at = { x: VIEW.w + 40, y: VIEW.h * 0.8 };
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await ev(`window.__tick(${DT})`);
      if (sink) {
        const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: VIEW.w, height: VIEW.h, scale: sink.scale }, captureBeyondViewport: false });
        sink.write(Buffer.from(shot.data, "base64"));
      }
    }
  };
  const wait = (ms) => tick(Math.round(ms / DT));
  const mouse = (type, x, y) => c.send("Input.dispatchMouseEvent", {
    type, x, y, button: type === "mouseMoved" && !held ? "none" : "left", buttons: held || type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
  });
  const place = async (x, y) => { at.x = x; at.y = y; await mouse("mouseMoved", x, y); };
  // A hand's move: minimum-jerk timing along a gently bowed path, a faint tremor, and (for
  // long moves) a small overshoot that's corrected. `ms` defaults to Fitts-ish: farther is longer.
  const move = async (x, y, ms, { bow = 0.12, tremor = 0.35 } = {}) => {
    const x0 = at.x, y0 = at.y, dx = x - x0, dy = y - y0, dist = Math.hypot(dx, dy);
    if (dist < 0.5) return wait(ms ?? 0);
    ms ??= (260 + dist * 0.75) * (0.9 + rand() * 0.25);
    const n = Math.max(2, Math.round(ms / DT));
    const side = (rand() - 0.5) * 2 * bow * dist; // the bow: perpendicular to the move, mid-way
    const cx = x0 + dx / 2 - (dy / dist) * side, cy = y0 + dy / 2 + (dx / dist) * side;
    const over = dist > 180 ? 0.018 + rand() * 0.02 : 0; // overshoot, as a share of the way
    const ph = rand() * 6.28;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      let s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5; // minimum jerk
      s += over * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (t > 0.6 ? 1 : 0) * (1 - t) * 4;
      const bx = (1 - s) ** 2 * x0 + 2 * (1 - s) * s * cx + s ** 2 * x;
      const by = (1 - s) ** 2 * y0 + 2 * (1 - s) * s * cy + s ** 2 * y;
      const tr = tremor * (1 - Math.abs(2 * t - 1));
      await place(bx + tr * Math.sin(ph + i * 0.9), by + tr * Math.cos(ph + i * 0.7));
      await tick(1);
    }
    await place(x, y);
  };
  const down = async () => { held = true; await mouse("mousePressed", at.x, at.y); };
  const up = async () => { held = false; await mouse("mouseReleased", at.x, at.y); };
  return { tick, wait, move, down, up, place, ev, at, record: (s) => { sink = s; } };
}

// design px of the stage → screen px
const toScreen = (d, x, y) => d.ev(`(() => { const r = document.getElementById('stage').getBoundingClientRect(), s = r.width / document.getElementById('stage').offsetWidth; return { x: r.left + ${x} * s, y: r.top + ${y} * s } })()`);

// ── Takes ────────────────────────────────────────────────────────────────────────────────
const TAKES = {
  // Straight to the cord: three clicks (on, off, on), then one pull down (off).
  lamp: {
    hash: "lamp",
    flow: async (d) => {
      const cord = async () => d.ev(`(() => { const r = [...document.querySelectorAll('.cord .char')].map((c) => c.getBoundingClientRect()).filter((r) => r.width).sort((a, b) => b.bottom - a.bottom)[0]; return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height } })()`);
      const HOLDS = [105, 120, 98]; // ms a click is held: a hand's, never quite the same
      const click = async (i) => { await d.down(); await d.wait(HOLDS[i]); await d.up(); };
      let c = await cord();
      await d.place(1030, 610); await d.wait(800);
      await d.move(c.x + 1, c.y + 2, 1050); await d.wait(420);
      for (let i = 0; i < 3; i++) {
        await click(i);
        await d.wait(1250);
        c = await cord(); // the cord has swung back; meet it where it hangs
        await d.move(c.x + 1, c.y + 2, 240, { bow: 0, tremor: 0.15 }); await d.wait(120);
      }
      await d.wait(250);
      await d.down(); await d.wait(110);
      await d.move(c.x + 2, c.y + 4.6 * c.h, 520, { bow: 0, tremor: 0.2 }); await d.wait(160);
      await d.up(); await d.wait(1700);
      await d.move(c.x + 150, c.y + 150, 900); await d.wait(900);
    },
  },
  // Through the strands: high and slow, low and quicker, then a slow wander in the middle.
  curtain: {
    hash: "curtain",
    flow: async (d) => {
      const L = await toScreen(d, 560, 0), R = await toScreen(d, 1490, 0);
      const Y = async (y) => (await toScreen(d, 0, y)).y;
      const [hi, mid, lo] = [await Y(620), await Y(900), await Y(1220)];
      await d.place(L.x - 60, hi - 80); await d.wait(600);
      await d.move(L.x + 10, hi, 600);
      await d.move(R.x - 10, hi + 30, 2100, { bow: 0.06 }); await d.wait(300);
      await d.move(R.x + 20, lo - 20, 650);
      await d.move(L.x - 10, lo + 10, 1300, { bow: 0.08 }); await d.wait(350);
      const midX = (L.x + R.x) / 2;
      await d.move(midX - 120, mid, 800);
      await d.move(midX + 60, mid + 20, 1100, { bow: 0.1 });
      await d.move(midX - 40, mid - 30, 1000, { bow: 0.1 });
      await d.move(midX + 140, mid + 10, 1100, { bow: 0.1 }); await d.wait(400);
      await d.move(R.x + 160, lo + 120, 1000); await d.wait(1200);
    },
  },
  // Take the handle and push it off the right edge (holding on past it, as you would: a throw
  // alone doesn't carry it that far), watch it come round from the left and settle; then come
  // back and give it a gentle push by the body.
  pram: {
    hash: "pram",
    flow: async (d) => {
      const shift = () => d.ev(`(() => { const p = document.querySelector('.piece-pram .pram').style.transform.match(/translateX\\(([-\\d.]+)px/); return p ? +p[1] : 0 })()`);
      const grip = async () => toScreen(d, 380 + (await shift()), 505);
      const body = async () => toScreen(d, 1250 + (await shift()), 880);
      const settle = async (maxMs) => { // until it has stood still for half a second
        let last = await shift(), still = 0;
        for (let t = 0; t < maxMs && still < 30; t += DT) { await d.tick(1); const x = await shift(); still = Math.abs(x - last) < 0.05 ? still + 1 : 0; last = x; }
      };
      const g = await grip();
      await d.place(1010, 640); await d.wait(700);
      await d.move(g.x, g.y); await d.wait(320);
      await d.down(); await d.wait(120);
      await d.move(g.x + 140, g.y + 3, 650, { bow: 0, tremor: 0.2 }); // the push gets going
      await d.move(VIEW.w + 300, g.y + 12, 1250, { bow: 0.02, tremor: 0.2 }); // and on, off the edge
      await d.wait(250);
      await d.up();
      await settle(6000); // round from the left, to rest
      await d.wait(400);
      await d.place(VIEW.w + 60, 560);
      const b = await body();
      await d.move(b.x, b.y, 1300); await d.wait(300);
      await d.down(); await d.wait(110);
      await d.move(b.x - 110, b.y - 2, 560, { bow: 0, tremor: 0.2 });
      await d.move(b.x - 190, b.y - 3, 240, { bow: 0, tremor: 0.1 });
      await d.up();
      await d.move(b.x - 230, b.y + 45, 450);
      await settle(4000);
      await d.move(b.x + 160, b.y + 140, 1100); await d.wait(900);
    },
  },
};

// ── Audio: the take's sound log, played again offline from sound.js's own recipes ──────────
const RENDER_AUDIO = `async (events, duration) => {
  const { SOUNDS, VOLUME, RUMBLE } = await import('/sound.js')
  const rate = 48000, ctx = new OfflineAudioContext(2, Math.ceil(rate * duration), rate)
  const out = new GainNode(ctx, { gain: VOLUME })
  out.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000 })).connect(ctx.destination)
  const noise = new AudioBuffer({ length: rate * 0.5, sampleRate: rate })
  { let s = 1; const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1 } }
  const SILENT = 0.0001
  const playLayer = (layer, start, gain, pitch) => {
    if (start < 0) return
    const attack = layer.attack ?? 0.001, end = start + attack + layer.decay
    const peak = Math.max(SILENT * 2, layer.gain * gain)
    const env = new GainNode(ctx, { gain: SILENT })
    env.gain.setValueAtTime(SILENT, start); env.gain.exponentialRampToValueAtTime(peak, start + attack); env.gain.exponentialRampToValueAtTime(SILENT, end)
    env.connect(out)
    const srcs = []
    if (layer.noise) {
      const [from, to] = typeof layer.noise.freq === 'number' ? [layer.noise.freq, layer.noise.freq] : layer.noise.freq
      const src = new AudioBufferSourceNode(ctx, { buffer: noise })
      const f = new BiquadFilterNode(ctx, { type: layer.noise.filter, frequency: from, Q: layer.noise.q ?? 1 })
      if (to !== from) f.frequency.exponentialRampToValueAtTime(to, end)
      src.connect(f).connect(env); srcs.push(src)
    } else {
      const [from, to] = (typeof layer.freq === 'number' ? [layer.freq, layer.freq] : layer.freq).map((f) => f * pitch)
      const osc = new OscillatorNode(ctx, { type: layer.type, frequency: from })
      if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, end)
      if (layer.fm) { const mod = new OscillatorNode(ctx, { frequency: from * layer.fm[0] }); mod.connect(new GainNode(ctx, { gain: layer.fm[1] })).connect(osc.frequency); srcs.push(mod) }
      osc.connect(env); srcs.push(osc)
    }
    for (const s of srcs) { s.start(start); s.stop(end + 0.02) }
  }
  for (const e of events) {
    if (e.name === 'rumble') continue
    for (const layer of SOUNDS[e.name] ?? []) playLayer(layer, e.t + (layer.delay ?? 0), e.gain, e.pitch ?? 1)
  }
  const rumbles = events.filter((e) => e.name === 'rumble')
  if (rumbles.length) {
    const src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true })
    const level = new GainNode(ctx, { gain: 0 })
    src.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: RUMBLE.freq, Q: RUMBLE.q })).connect(level).connect(out)
    for (const e of rumbles) level.gain.setTargetAtTime(e.gain * RUMBLE.gain, Math.max(0, e.t), 0.06)
    src.start(0)
  }
  const buf = await ctx.startRendering()
  // 16-bit PCM WAV, base64
  const n = buf.length, ch = [buf.getChannelData(0), buf.getChannelData(1)]
  const bytes = new DataView(new ArrayBuffer(44 + n * 4))
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); bytes.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true)
  bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 4, true); bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true); str(36, 'data'); bytes.setUint32(40, n * 4, true)
  let peak = 0
  for (let i = 0, o = 44; i < n; i++) for (const c of ch) { const v = Math.max(-1, Math.min(1, c[i])); peak = Math.max(peak, Math.abs(v)); bytes.setInt16(o, v * 32767, true); o += 2 }
  let bin = ''; const u8 = new Uint8Array(bytes.buffer)
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return { wav: btoa(bin), peak }
}`;

async function renderTake(name) {
  const take = TAKES[name];
  const page = await openPage(take.hash);
  const d = driver(page);
  const frames = mkdtempSync(join(tmpdir(), `ch-${name}-`));
  let n = 0;
  await page.ev(`window.__sounds = []`);
  const t0 = await page.ev(`performance.now()`);
  d.record({ scale: CLIP_SCALE, write: (buf) => writeFileSync(join(frames, `${String(n++).padStart(5, "0")}.png`), buf) });
  const started = Date.now();
  await take.flow(d);
  d.record(null);
  // frame k shows the page at t0 + (k + 1) · DT, so a sound at t lands (t − t0 − DT) in
  const sounds = (await page.ev(`window.__sounds`)).map((e) => ({ ...e, t: e.t - t0 / 1000 - DT / 1000 }));
  page.close();
  const duration = n / FPS;
  const counts = {}; for (const s of sounds) counts[s.name] = (counts[s.name] || 0) + 1;
  console.log(`${name}: ${n} frames (${duration.toFixed(1)}s) in ${Math.round((Date.now() - started) / 1000)}s; sounds ${JSON.stringify(counts)}`);
  writeFileSync(join(frames, "sounds.json"), JSON.stringify(sounds));
  // audio, rendered in a page on the site's own origin so it can import sound.js, on the real
  // clock (inside a virtual-clock page the render can stall)
  const ap = await openPage("lamp", { cursor: false, virtual: false });
  const audioStart = Date.now();
  // the WAV stays in the page and comes back in slices: one multi-MB reply can stall the socket
  const { length, peak } = await Promise.race([
    ap.ev(`(${RENDER_AUDIO})(${JSON.stringify(sounds)}, ${duration + 0.5}).then((r) => { window.__wav = r.wav; return { length: r.wav.length, peak: r.peak } })`),
    sleep(90000).then(() => { throw new Error(`${name}: the audio render took over 90s (sounds.json is in ${frames})`); }),
  ]);
  let wav = "";
  for (let i = 0; i < length; i += 1 << 20) wav += await ap.ev(`window.__wav.slice(${i}, ${i + (1 << 20)})`);
  ap.close();
  console.log(`${name}: audio rendered in ${((Date.now() - audioStart) / 1000).toFixed(1)}s`);
  writeFileSync(join(frames, "audio.wav"), Buffer.from(wav, "base64"));
  console.log(`${name}: audio peak ${peak.toFixed(2)}, turned up ${(peak > 0 ? 20 * Math.log10(0.708 / peak) : 0).toFixed(1)} dB`);
  // The site is quiet on purpose; a clip for a feed is turned up so its loudest moment peaks
  // at −3 dB (the balance between sounds stays as it is).
  const gainDb = peak > 0 ? 20 * Math.log10(0.708 / peak) : 0;
  const out = join(OUT, `${name}.mp4`);
  execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i "${frames}/%05d.png" -i "${frames}/audio.wav" -map 0:v -map 1:a `
    + `-af volume=${gainDb.toFixed(2)}dB -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart "${out}"`);
  rmSync(frames, { recursive: true, force: true });
  console.log(`→ ${out}`);
}

async function renderStills() {
  const dir = join(OUT, "stills");
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    for (const key of ["lamp", "curtain", "chair", "clock", "pram"]) {
      const page = await openPage(key, { theme, cursor: false, still: true });
      const shot = await page.c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: VIEW.w, height: VIEW.h, scale: STILL_SCALE } });
      const file = join(dir, `${key}-${theme}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      page.close();
      console.log(`→ ${file}`);
    }
  }
}

if (!(await reachable(`${SERVER}/`))) { console.error(`nothing at ${SERVER}: run python3 serve.py first`); process.exit(1); }
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : [...Object.keys(TAKES), "stills"];
for (const w of wanted) if (w !== "stills" && !TAKES[w]) { console.error(`unknown take ${w}; have ${Object.keys(TAKES).join(", ")}, stills`); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const chrome = await launch();
try {
  for (const w of wanted) await (w === "stills" ? renderStills() : renderTake(w));
} finally {
  await chrome.close();
}
