// Pull cord made of characters, simulated with XPBD (extended position-based dynamics).
//
// The cord exits a hole in the shade. Above the hole it runs on a spring-loaded slider
// (like a real pull switch), so pulling draws spare characters out of the lamp and letting
// go snaps them back. Below the hole the characters hang as a chain of slightly elastic
// links that swing, stretch and bounce. All units are design-frame pixels (1254² for the
// table lamp, 2048² for the floor lamp).
//
// mount(stage, lamp, { onToggle }) draws one lamp into an element of its STAGE size and
// returns its controls; the page (or the room) owns the pointer listeners and the animation
// loop. See main.js. With onToggle the cord is also a pull switch (as in the portfolio's
// lamp): pulling the slider past TOGGLE_AT clicks it, and a warm glow can show under the shade.

// Two lamps share this file: the table lamp (its own page, and the portfolio's original) and
// a floor lamp for the room. Same cord, same feel; each has its own art and measurements.
// Length tuning below is written for the table lamp's 40px characters and scales with SEG.

const CHAR = "灯";

// --- Tuning ------------------------------------------------------------------------------

const STEP = 1 / 120;
const SUBSTEPS = 12;
const GRAVITY = 2400; // per 40px of character, so a bigger cord swings at the same pace
const AIR_DRAG = 5; // 1/s
const RADIUS = 16; // collision radius of a character

const LINK_COMPLIANCE = 1e-5; // gaps open between characters on a hard pull
const LINK_STRETCH = 1.2; // past this many links' length the hand slips instead
const LINK_DAMPING = 0.04; // per substep, along each link
const BEND_COMPLIANCE = 5e-5; // characters straighten out rather than fold
const MIN_GAP = 36; // characters never overlap

const SLIDER_MASS = 3;
const SLIDER_K = 900;
const SLIDER_DAMPING = 65;
const SLIDER_UP = 22; // recoil into the shade
const SLIDER_DOWN = 120; // pull out of the shade

const GRAB_COMPLIANCE = 1e-4; // softness of the hand
const HIT_RADIUS = 30;
const PRESS_PULL = 85; // pressing pulls the cord down this far while held
const PRESS_RATE = 18; // 1/s, how quickly the press pull eases in and out
const DRAG_THRESHOLD = 8; // past this the pointer takes over from the press pull

const BRUSH_RADIUS = 24; // hovering past the cord nudges it
const BRUSH_GAIN = 0.05;
const BRUSH_MAX = 600;

// The switch (only with onToggle)
const TOGGLE_AT = 30; // the switch clicks once the slider is pulled this far below the hole...
const REARM_AT = 10; // ...and is ready again once it is back above this
const TAP_HOLD_MS = 260; // a quick tap is held this long, so it still pulls far enough to click
const SWITCH_DRAG_PX = 10; // screen px: a finger's wobble on a small lamp mustn't cancel the pull

// --- Lamps, measured from each image's alpha ---------------------------------------------

// SHADE is [x, shade top, shade bottom]; STEM and BASE are what the cord can't pass through.
// FOOT is where the lamp meets the floor and BOUNDS the opaque box of the art (for placing it
// in a room).
export const TABLE_LAMP = {
  STAGE: 1254,
  IMAGE: new URL("assets/lamp.png", import.meta.url).href,
  ALT: "Yellow mushroom lamp",
  HOLE: { x: 785.6, y: 556 }, // Figma has 534; lowered so the cord always runs into the shade
  SEG: 40, // one character per link (40px font, 40px line-height)
  FREE: 5, // hanging characters
  SPARE: 5, // characters waiting inside the shade
  SHADE: [
    [340, 505, 512], [350, 461, 523], [380, 399, 531], [410, 363, 535], [440, 339, 537],
    [470, 322, 539], [500, 310, 540], [530, 302, 541], [560, 298, 542], [590, 296, 543],
    [620, 277, 543], [650, 279, 543], [680, 297, 542], [710, 300, 541], [740, 306, 541],
    [770, 316, 540], [800, 331, 538], [830, 352, 536], [860, 383, 533], [890, 430, 527],
    [915, 505, 515],
  ],
  STEM: { x0: 608, x1: 645, y0: 540, y1: 900 },
  BASE: { cx: 626, cy: 921, rx: 184, ry: 51 },
  FOOT: { x: 626, y: 972 },
  BOUNDS: { x0: 339, y0: 276, x1: 914, y1: 972 },
};

// Tall and thin: a smaller shade on a long pole, with a cord of slightly bigger characters so
// it still reads when the lamp stands across a room. The hole sits as far out along the
// shade, and as far under its rim, as the table lamp's.
export const FLOOR_LAMP = {
  STAGE: 2048,
  IMAGE: new URL("assets/floor-lamp.png", import.meta.url).href,
  ALT: "Yellow floor lamp",
  HOLE: { x: 1137, y: 434 },
  SEG: 48,
  FREE: 5,
  SPARE: 5,
  SHADE: [
    [820, 386, 403], [845, 316, 412], [870, 290, 415], [895, 271, 418], [920, 257, 420],
    [945, 247, 421], [970, 244, 422], [995, 241, 422], [1020, 228, 424], [1045, 234, 422],
    [1070, 244, 421], [1095, 247, 420], [1120, 256, 418], [1145, 268, 416], [1170, 284, 414],
    [1195, 314, 411], [1220, 363, 406], [1226, 394, 404],
  ],
  STEM: { x0: 1009, x1: 1038, y0: 422, y1: 1775 },
  BASE: { cx: 1024.5, cy: 1818, rx: 144, ry: 48 },
  FOOT: { x: 1024.5, y: 1865 },
  BOUNDS: { x0: 818, y0: 228, x1: 1227, y1: 1865 },
};

// The table lamp is this module's default, so its own page reads as before.
export const { STAGE, FOOT, BOUNDS } = TABLE_LAMP;

// Alpha of an image as one byte per design pixel, for grabbing a piece by its silhouette.
const readAlpha = (img, size, done) =>
  img.decode().then(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const alpha = new Uint8Array(size * size);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    done(alpha);
  }, () => {});

// Is the image opaque at p, or within `pad` of it (thin parts are easier to catch)?
const opaque = (alpha, size, p, pad = 0) =>
  !!alpha && [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad]].some(([dx, dy]) => {
    const x = Math.round(p.x + dx), y = Math.round(p.y + dy);
    return x >= 0 && y >= 0 && x < size && y < size && alpha[y * size + x] > 128;
  });

export function mount(stage, lamp = TABLE_LAMP, { onToggle } = {}) {
  const { STAGE, HOLE, SEG, FREE, SPARE, SHADE, STEM, BASE } = lamp;

  // Lengths in the tuning are per 40px character.
  const k = SEG / 40;
  const gravity = GRAVITY * k, radius = RADIUS * k, minGap = MIN_GAP * k;
  const linkMax = SEG * LINK_STRETCH;
  const sliderMin = HOLE.y - SLIDER_UP * k, sliderMax = HOLE.y + SLIDER_DOWN * k;
  const sliderNatural = HOLE.y - (FREE * gravity) / SLIDER_K; // preload so it rests at HOLE.y
  const hitRadius = HIT_RADIUS * k, pressPull = PRESS_PULL * k, dragThreshold = DRAG_THRESHOLD * k;
  const brushRadius = BRUSH_RADIUS * k, brushMax = BRUSH_MAX * k;
  const toggleAt = HOLE.y + TOGGLE_AT * k, rearmAt = HOLE.y + REARM_AT * k;

  // --- Silhouette ------------------------------------------------------------------------

  const SHADE_X0 = SHADE[0][0];
  const SHADE_X1 = SHADE[SHADE.length - 1][0];

  const shadeAt = (x, col) => {
    for (let i = 1; i < SHADE.length; i++) {
      if (x <= SHADE[i][0]) {
        const [x0, ...a] = SHADE[i - 1], [x1, ...b] = SHADE[i];
        const t = (x - x0) / (x1 - x0);
        return a[col] + (b[col] - a[col]) * t;
      }
    }
    return SHADE[SHADE.length - 1][col + 1];
  };
  const shadeTop = (x) => shadeAt(x, 0);
  const shadeBottom = (x) => shadeAt(x, 1);

  // lowest point of the rim across the cord's width; spares are only visible below it
  const RIM = Math.max(shadeBottom(HOLE.x - SEG / 2), shadeBottom(HOLE.x + SEG / 2));

  // Hanging characters disappear into the shade; spares never show above the rim.
  const shadePath =
    "M" + SHADE.map(([x, t]) => `${x} ${t}`).join(" L") +
    " L" + [...SHADE].reverse().map(([x, , b]) => `${x} ${b}`).join(" L") + " Z";

  // --- DOM -------------------------------------------------------------------------------

  stage.classList.add("piece-lamp");
  if (SEG !== 40) stage.style.setProperty("--seg", `${SEG}px`);
  const img = document.createElement("img");
  img.className = "lamp";
  img.src = lamp.IMAGE;
  img.alt = lamp.ALT;
  img.draggable = false;
  const spareEl = document.createElement("div");
  spareEl.className = "cord";
  spareEl.setAttribute("aria-hidden", "true");
  const cordEl = document.createElement("div");
  cordEl.className = "cord";
  cordEl.setAttribute("aria-label", "Pull cord");
  stage.append(img, spareEl, cordEl);

  // Light under the shade, for when the lamp is on (shown by the page's CSS).
  if (onToggle) {
    const glow = document.createElement("div");
    glow.className = "glow";
    // Centred on the shade's rim and fading out on every side (the shade hides its top half),
    // so the light has no edge.
    const x0 = SHADE[0][0], x1 = SHADE[SHADE.length - 1][0], w = (x1 - x0) * 2.4;
    const cx = (x0 + x1) / 2, cy = shadeBottom(cx);
    Object.assign(glow.style, {
      left: `${cx - w / 2}px`, top: `${cy - w * 0.45}px`, width: `${w}px`, height: `${w * 1.2}px`,
    });
    stage.insertBefore(glow, img);
  }

  const makeChars = (parent, count) =>
    Array.from({ length: count }, () => {
      const el = document.createElement("span");
      el.className = "char";
      el.textContent = CHAR;
      parent.appendChild(el);
      return el;
    });
  const freeEls = makeChars(cordEl, FREE);
  const spareEls = makeChars(spareEl, SPARE);

  cordEl.style.clipPath = `path(evenodd, "M0 0 H${STAGE} V${STAGE} H0 Z ${shadePath}")`;
  spareEl.style.clipPath = `inset(${RIM}px 0 0 0)`;

  let mask = null; // image alpha, once decoded
  readAlpha(img, STAGE, (a) => { mask = a; });

  // --- Simulation ------------------------------------------------------------------------

  // nodes[0] is the slider at the hole; nodes[i + 1] is the bottom of character i.
  const nodes = Array.from({ length: FREE + 1 }, (_, i) => ({
    x: HOLE.x, y: HOLE.y + i * SEG, px: 0, py: 0, vx: 0, vy: 0,
    w: i === 0 ? 1 / SLIDER_MASS : 1, // inverse mass
  }));
  const slider = nodes[0];

  const grab = { node: null, ox: 0, oy: 0, tx: 0, ty: 0, sx: 0, sy: 0, pull: 0, pullTarget: 0 };
  let armed = true; // the switch clicks once per press

  // Centre of spare character k, stacked up the rail above the slider.
  const spareY = (k) => slider.y - SEG / 2 - k * SEG;

  // Move a and b along their axis so their distance changes by `delta` (split by inverse mass).
  const separate = (a, b, dx, dy, len, delta, alpha = 0) => {
    const s = delta / (a.w + b.w + alpha) / len;
    a.x += a.w * s * dx; a.y += a.w * s * dy;
    b.x -= b.w * s * dx; b.y -= b.w * s * dy;
  };

  // Distance constraint: `rest` exactly when compliance is 0, springy otherwise.
  // `mode` limits it to one side: "max" only resists stretching, "min" only resists squashing.
  const distance = (a, b, rest, alpha = 0, mode) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-6;
    const delta = len - rest;
    if ((mode === "max" && delta <= 0) || (mode === "min" && delta >= 0)) return;
    separate(a, b, dx, dy, len, delta, alpha);
  };

  const collide = (n) => {
    // stage edges
    n.x = Math.min(STAGE - radius, Math.max(radius, n.x));
    n.y = Math.min(STAGE - radius, Math.max(radius, n.y));

    // shade: out through the nearer of top or bottom, except at the hole where the cord retracts
    if (n.x > SHADE_X0 && n.x < SHADE_X1 && Math.abs(n.x - HOLE.x) > radius) {
      const top = shadeTop(n.x) - radius;
      const bottom = shadeBottom(n.x) + radius;
      if (n.y > top && n.y < bottom) n.y = n.y - top < bottom - n.y ? top : bottom;
    }

    // stem: out sideways
    if (n.y > STEM.y0 && n.y < STEM.y1 && n.x > STEM.x0 - radius && n.x < STEM.x1 + radius) {
      n.x = n.x < (STEM.x0 + STEM.x1) / 2 ? STEM.x0 - radius : STEM.x1 + radius;
    }

    // base: out along the ellipse normal
    const ex = (n.x - BASE.cx) / (BASE.rx + radius);
    const ey = (n.y - BASE.cy) / (BASE.ry + radius);
    const d = Math.hypot(ex, ey);
    if (d > 0 && d < 1) {
      n.x = BASE.cx + (ex / d) * (BASE.rx + radius);
      n.y = BASE.cy + (ey / d) * (BASE.ry + radius);
    }
  };

  const substep = (h) => {
    const ih2 = 1 / (h * h);

    // integrate: spring on the slider, gravity and drag on the chain
    slider.vy += (-SLIDER_K * (slider.y - sliderNatural) - SLIDER_DAMPING * slider.vy) * slider.w * h;
    for (let i = 1; i < nodes.length; i++) {
      const n = nodes[i];
      const drag = 1 - AIR_DRAG * h;
      n.vx *= drag;
      n.vy = (n.vy + gravity * h) * drag;
    }
    for (const n of nodes) {
      n.px = n.x; n.py = n.y;
      n.x += n.vx * h;
      n.y += n.vy * h;
    }

    // hand
    if (grab.node) {
      const n = grab.node;
      const k = n.w / (n.w + GRAB_COMPLIANCE * ih2);
      n.x += (grab.tx + grab.ox - n.x) * k;
      n.y += (grab.ty + grab.oy + grab.pull - n.y) * k;
    }

    // links: slightly elastic, with a hard stretch limit
    for (let i = 0; i < FREE; i++) {
      distance(nodes[i], nodes[i + 1], SEG, LINK_COMPLIANCE * ih2);
      distance(nodes[i], nodes[i + 1], linkMax, 0, "max");
    }

    // bending: every second node is softly pulled toward a straight line
    for (let i = 0; i + 2 < nodes.length; i++) {
      distance(nodes[i], nodes[i + 2], 2 * SEG, BEND_COMPLIANCE * ih2);
    }

    // no overlapping characters
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 2; j < nodes.length; j++) distance(nodes[i], nodes[j], minGap, 0, "min");
    }

    // the slider runs on a vertical rail with end stops
    slider.x = HOLE.x;
    slider.y = Math.min(sliderMax, Math.max(sliderMin, slider.y));

    for (let i = 1; i < nodes.length; i++) collide(nodes[i]);

    // velocities from positions, then damp motion along each link
    for (const n of nodes) {
      n.vx = (n.x - n.px) / h;
      n.vy = (n.y - n.py) / h;
    }
    for (let i = 0; i < FREE; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1e-6;
      const imp = (((b.vx - a.vx) * dx + (b.vy - a.vy) * dy) / len) * LINK_DAMPING / (a.w + b.w) / len;
      a.vx += a.w * imp * dx; a.vy += a.w * imp * dy;
      b.vx -= b.w * imp * dx; b.vy -= b.w * imp * dy;
    }
    slider.vx = 0;

    // the switch, only under a hand: settling on load must not click it
    if (!onToggle) return;
    if (armed && grab.node && slider.y > toggleAt) {
      armed = false;
      onToggle();
    } else if (!armed && slider.y < rearmAt) {
      armed = true;
    }
  };

  // --- Rendering -------------------------------------------------------------------------

  const place = (el, x, y, deg) => {
    el.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg)`;
  };

  const render = () => {
    for (let i = 0; i < FREE; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const deg = (-Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
      place(freeEls[i], (a.x + b.x) / 2, (a.y + b.y) / 2, deg);
    }
    for (let k = 0; k < SPARE; k++) place(spareEls[k], HOLE.x, spareY(k), 0);
  };

  // --- Input -----------------------------------------------------------------------------

  // Pointer -> design frame, from the stage's rendered size (whatever scales it).
  const toStage = (e) => {
    const r = stage.getBoundingClientRect();
    const s = r.width / STAGE;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  // Hanging characters grab their lower node; spares that are out of the shade grab the slider.
  // `pad` widens the reach, for when the lamp is drawn small.
  const hitTest = (p, pad = 0) => {
    let best = null, bestD = hitRadius + pad;
    for (let i = 0; i < FREE; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const d = Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2);
      if (d < bestD) { bestD = d; best = b; }
    }
    for (let k = 0; k < SPARE && spareY(k) + SEG / 2 > RIM; k++) {
      const d = Math.hypot(p.x - HOLE.x, p.y - spareY(k));
      if (d < bestD) { bestD = d; best = slider; }
    }
    return best;
  };

  // The cord is the lamp itself; the rest of the silhouette is what carries it.
  const hit = (p, pad = 0) => {
    if (hitTest(p, pad)) return "physics";
    return opaque(mask, STAGE, p, pad / 2) ? "body" : null;
  };

  // Pressing pulls the cord down for as long as you hold; letting go springs it back.
  let downAt = 0, releaseTimer = 0;
  const down = (p, e, pad) => {
    const node = hitTest(p, pad);
    if (!node) return false;
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    armed = true; // a fresh press always clicks, even while the cord is still springing back
    downAt = e.timeStamp;
    Object.assign(grab, {
      node, ox: node.x - p.x, oy: node.y - p.y, tx: p.x, ty: p.y,
      sx: p.x, sy: p.y, pull: 0, pullTarget: pressPull,
    });
    stage.classList.add("grabbing");
    return true;
  };

  let last = null; // previous pointer sample, for brushing
  const clampBrush = (v) => Math.max(-brushMax, Math.min(brushMax, v * BRUSH_GAIN));

  const move = (p, e) => {
    if (grab.node) {
      grab.tx = p.x; grab.ty = p.y;
      const s = stage.getBoundingClientRect().width / STAGE;
      const threshold = onToggle ? Math.max(dragThreshold, SWITCH_DRAG_PX / s) : dragThreshold;
      if (Math.hypot(p.x - grab.sx, p.y - grab.sy) > threshold) grab.pullTarget = 0;
    } else {
      stage.classList.toggle("can-grab", !!hitTest(p));
      if (last) {
        const dt = Math.max(1, e.timeStamp - last.t) / 1000;
        const vx = clampBrush((p.x - last.x) / dt), vy = clampBrush((p.y - last.y) / dt);
        for (let i = 1; i < nodes.length; i++) {
          const n = nodes[i];
          if (Math.hypot(n.x - p.x, n.y - p.y) < brushRadius) { n.vx += vx; n.vy += vy; }
        }
      }
    }
    last = { x: p.x, y: p.y, t: e.timeStamp };
  };

  const release = () => {
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    grab.node = null;
    stage.classList.remove("grabbing");
  };

  // As a switch, a quick tap (not a drag) is held a moment so it still clicks.
  const up = (e) => {
    if (!grab.node || releaseTimer) return;
    const left = TAP_HOLD_MS - ((e?.timeStamp ?? downAt) - downAt);
    if (!onToggle || !grab.pullTarget || left <= 0) return release();
    releaseTimer = setTimeout(release, left);
  };

  const leave = () => { last = null; };

  // --- Loop ------------------------------------------------------------------------------

  let acc = 0;
  const step = (dt) => {
    if (grab.node) grab.pull += (grab.pullTarget - grab.pull) * (1 - Math.exp(-PRESS_RATE * dt));
    for (acc += dt; acc >= STEP; acc -= STEP) {
      for (let s = 0; s < SUBSTEPS; s++) substep(STEP / SUBSTEPS);
    }
    render();
  };
  render();

  const destroy = () => {
    clearTimeout(releaseTimer);
    stage.replaceChildren();
    stage.classList.remove("piece-lamp", "can-grab", "grabbing");
    stage.style.removeProperty("--seg");
  };

  return { STAGE, toStage, hit, down, move, up, leave, step, destroy };
}
