// Rocking chair whose rockers are made of characters.
//
// The chair image and the arc of characters under its feet are one rigid body. The arc is a
// circle that rolls without slipping on an invisible flat floor, so the contact point travels
// along the rocker as it tips, like a real rocking chair. The body has one degree of freedom
// (its tilt), integrated from the exact rolling equations with gravity acting at the centre of
// mass, heavy damping, and a soft stop at each end of the rocker. All units are design-frame
// pixels (2048²); positive angles tip the chair forward (clockwise on screen).
//
// mount(stage) draws one chair into a 2048² element and returns its controls; the page owns
// the pointer listeners and the animation loop (see house.js).

import { playSound } from "../sound.js";

export const STAGE = 2048;
const CHAR = "椅";
const SIZE = 64; // one character per 64px of rocker (64px font, 64px line-height)
export const IMAGE = new URL("assets/chair.png", import.meta.url).href;

// --- Chair silhouette, measured from the image's alpha --------------------------------------

const FEET = { back: { x: 667, y: 1588 }, front: { x: 1488, y: 1586 } }; // bottom tips of the legs
const AREA = 372619; // opaque pixels
const COM = { x: 966.8, y: 970.9 }; // centre of those pixels
const GYRATION2 = 190180; // mean squared distance from COM (px²)

// --- Tuning ------------------------------------------------------------------------------

const ROCKER_RADIUS = 1400; // circle through the feet; bigger = flatter rocker, less rest tilt
const INSET = 24; // rocker centreline sits this far below the feet, so legs dip into the glyphs
const INK = 29; // glyph ink below its centre; the rolling surface is centreline + INK
const EXTEND_BACK = 360; // rocker beyond the back foot, along the arc
const EXTEND_FRONT = 100; // rocker beyond the front foot
const ROCKER_FILL = 0.45; // how much of each 64² cell is ink, for the rocker's mass

const FLOOR = 1700; // invisible floor the rocker rolls on
const REST_X = 1070; // where the centre of mass sits at rest

// The art's opaque box (the page centres it): its height as it rests (top of the back at
// 361, measured), wide enough for the rock's sweep.
export const BOUNDS = { x0: 330, y0: 361, x1: 1640, y1: FLOOR };
// ...but centred on what's visible at rest: the tilted chair and its rocker span 1114 ± 653
// (measured from pixels), right of the sweep's middle
export const CENTRE_X = 1114;

const STEP = 1 / 120;
const SUBSTEPS = 4;
const GRAVITY = 6000;
const DAMPING = 0.9; // 1/s; calm: a push dies out in a few slow rocks

// Idle rock, as if someone just got up: a soft escapement (like the clock's) feeds back what
// damping takes while the rock is under IDLE_AMPLITUDE, so a push settles back to it rather
// than to stillness. The target wanders a little so it never feels mechanical.
const IDLE_AMPLITUDE = (1.5 * Math.PI) / 180; // rad either side of rest
const IDLE_DRIVE = 0.8; // 1/s, how firmly the escapement tops it up
const IDLE_PERIOD = 2.4; // s, the chair's own rocking period (for the swing's size)
const IDLE_WANDER = 0.25; // the target amplitude drifts by up to this fraction...
const IDLE_WANDER_RATE = [0.11, 0.047]; // ...at these slow rates (Hz)
const MAX_SPIN = 2.2; // rad/s, so a wild flick still rocks gently

const LIMIT_MARGIN = 0.05; // rad kept in reserve before the rocker ends
const LIMIT_K = 300; // soft stop near the ends of the rocker, 1/s²
const LIMIT_DAMPING = 12; // 1/s, inside the soft stop
const LIMIT_SLACK = 0.06; // rad the soft stop may give before it's a hard stop

const GRAB_K = 25; // pull of the hand on the grabbed point, 1/s²
const GRAB_DAMPING = 7; // 1/s, along the hand's pull
const ROCKER_HIT = 8; // extra px around the rocker characters that still grabs

const CREAK_SWING = IDLE_AMPLITUDE * 1.8; // rad from rest: the idle rock turns around silently
const CREAK_FULL = 0.2; // rad: a creak this far out is at full volume
const CREAK_SPEED = 0.08; // rad/s the rock must have reached since the last turnaround
const KNOCK_SPIN = 0.35; // rad/s into a hard stop before it knocks

// --- Rocker geometry (body frame = image pixels) -------------------------------------------

// Centre of the circle through both feet, above them.
const C = (() => {
  const { back: b, front: f } = FEET;
  const mx = (b.x + f.x) / 2, my = (b.y + f.y) / 2;
  const half = Math.hypot(f.x - b.x, f.y - b.y) / 2;
  const ux = (f.x - b.x) / (2 * half), uy = (f.y - b.y) / (2 * half);
  const h = Math.sqrt(ROCKER_RADIUS ** 2 - half ** 2);
  return { x: mx + uy * h, y: my - ux * h };
})();
const CENTRELINE = ROCKER_RADIUS + INSET;
const ROLL = CENTRELINE + INK; // radius of the rolling surface

// Arc from the back end (larger angle, left of C) to the front end, angles on screen from C.
const footAngle = (p) => Math.atan2(p.y - C.y, p.x - C.x);
const ARC_BACK = footAngle(FEET.back) + EXTEND_BACK / CENTRELINE;
const ARC_FRONT = footAngle(FEET.front) - EXTEND_FRONT / CENTRELINE;
const COUNT = Math.round(((ARC_BACK - ARC_FRONT) * CENTRELINE) / SIZE);
const ARC_STEP = (ARC_BACK - ARC_FRONT) / COUNT; // packs the characters edge to edge

const chars = Array.from({ length: COUNT }, (_, i) => {
  const a = ARC_BACK - (i + 0.5) * ARC_STEP;
  return { a, x: C.x + CENTRELINE * Math.cos(a), y: C.y + CENTRELINE * Math.sin(a) };
});

// Contact sits straight below C, so the tilt picks which part of the rocker touches the floor.
const TILT_MIN = Math.PI / 2 - ARC_BACK + LIMIT_MARGIN; // tipped back
const TILT_MAX = Math.PI / 2 - ARC_FRONT - LIMIT_MARGIN; // tipped forward

// --- Mass (per unit mass from here on) ------------------------------------------------------

const { D, K2 } = (() => {
  const m = (ARC_STEP * CENTRELINE) * SIZE * ROCKER_FILL; // per character
  const M = AREA + m * COUNT;
  let gx = AREA * COM.x, gy = AREA * COM.y;
  for (const c of chars) { gx += m * c.x; gy += m * c.y; }
  gx /= M; gy /= M;
  let I = AREA * (GYRATION2 + (COM.x - gx) ** 2 + (COM.y - gy) ** 2);
  for (const c of chars) I += m * ((c.x - gx) ** 2 + (c.y - gy) ** 2);
  return { D: { x: gx - C.x, y: gy - C.y }, K2: I / M }; // D: from C to the centre of mass
})();
const D2 = D.x * D.x + D.y * D.y;
const TILT_REST = Math.atan(D.x / D.y); // centre of mass straight below C
const X0 = REST_X - ROLL * TILT_REST; // C's x on the floor at zero tilt

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

export function mount(stage) {
  // --- DOM -------------------------------------------------------------------------------

  stage.classList.add("piece-chair");
  const chairEl = document.createElement("div");
  chairEl.className = "chair";
  chairEl.setAttribute("aria-label", "Chair");
  const img = document.createElement("img");
  img.src = IMAGE;
  img.alt = "Coral lounge chair";
  img.draggable = false;
  const rockerEl = document.createElement("div");
  rockerEl.className = "rocker";
  rockerEl.setAttribute("aria-hidden", "true");
  chairEl.append(img, rockerEl);
  stage.append(chairEl);

  // Each character turned to follow the arc, its top toward the chair.
  for (const c of chars) {
    const el = document.createElement("span");
    el.className = "char";
    el.textContent = CHAR;
    el.style.transform = `translate(${c.x}px, ${c.y}px) rotate(${c.a - Math.PI / 2}rad)`;
    rockerEl.appendChild(el);
  }
  chairEl.style.transformOrigin = `${C.x}px ${C.y}px`;

  // Alpha of the image, for grabbing the chair by its silhouette.
  let mask = null;
  readAlpha(img, STAGE, (a) => { mask = a; });

  // --- Simulation ------------------------------------------------------------------------

  // Each chair starts somewhere in its own idle rock (none for reduced motion).
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const W0 = (2 * Math.PI) / IDLE_PERIOD;
  const phase = Math.random() * 2 * Math.PI;
  const wander = IDLE_WANDER_RATE.map(() => Math.random() * 2 * Math.PI);
  const body = still ? { tilt: TILT_REST, spin: 0 } : {
    tilt: TILT_REST + IDLE_AMPLITUDE * Math.cos(phase),
    spin: -IDLE_AMPLITUDE * W0 * Math.sin(phase),
  };
  let clock = 0; // s, for the idle target's drift
  const grab = { on: false, bx: 0, by: 0, tx: 0, ty: 0 }; // grabbed point (body frame), hand (world)

  // Rolling without slipping: C moves along the floor by the arc length rolled.
  const centre = (t) => ({ x: X0 + ROLL * t, y: FLOOR - ROLL });

  // Body point -> world, and how fast it moves per radian of tilt.
  const toWorld = (t, bx, by) => {
    const s = Math.sin(t), c = Math.cos(t), w = centre(t);
    const vx = bx - C.x, vy = by - C.y;
    return {
      x: w.x + c * vx - s * vy, y: w.y + s * vx + c * vy,
      jx: ROLL - s * vx - c * vy, jy: c * vx - s * vy,
    };
  };
  const toBody = (t, x, y) => {
    const s = Math.sin(t), c = Math.cos(t), w = centre(t);
    const vx = x - w.x, vy = y - w.y;
    return { x: C.x + c * vx + s * vy, y: C.y - s * vx + c * vy };
  };

  const substep = (h) => {
    const { tilt: t, spin: w } = body;
    const s = Math.sin(t), c = Math.cos(t);

    // inertia about the contact point, and how it changes with tilt
    const lever = D.x * c - D.y * s; // horizontal offset of the centre of mass from C
    const inertia = K2 + D2 + ROLL * ROLL - 2 * ROLL * (D.x * s + D.y * c);
    const dInertia = -2 * ROLL * lever;

    // gravity, plus the hand as a damped spring on the grabbed point
    let torque = GRAVITY * lever;
    if (grab.on) {
      const p = toWorld(t, grab.bx, grab.by);
      const fx = GRAB_K * (grab.tx - p.x) - GRAB_DAMPING * p.jx * w;
      const fy = GRAB_K * (grab.ty - p.y) - GRAB_DAMPING * p.jy * w;
      torque += fx * p.jx + fy * p.jy;
    }
    let acc = (torque - 0.5 * dInertia * w * w) / inertia - DAMPING * w;

    // the escapement: while the rock is under its idle size, give back a little more than
    // damping takes (never under a hand)
    clock += h;
    if (!still && !grab.on) {
      const drift = IDLE_WANDER_RATE
        .reduce((d, f, i) => d + Math.sin(2 * Math.PI * f * clock + wander[i]), 0) / 2;
      const target = IDLE_AMPLITUDE * (1 + IDLE_WANDER * drift);
      const amp = Math.hypot(t - TILT_REST, w / W0);
      if (amp < target) acc += (DAMPING + 2 * IDLE_DRIVE * (1 - amp / target)) * w;
    }

    // soft stops before the rocker runs out
    if (t < TILT_MIN) acc += LIMIT_K * (TILT_MIN - t) - LIMIT_DAMPING * w;
    if (t > TILT_MAX) acc += LIMIT_K * (TILT_MAX - t) - LIMIT_DAMPING * w;

    body.spin = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, w + acc * h));
    body.tilt += body.spin * h;

    // hard stops: never past the ends, never over
    const lo = TILT_MIN - LIMIT_SLACK, hi = TILT_MAX + LIMIT_SLACK;
    if ((body.tilt < lo || body.tilt > hi) && Math.abs(body.spin) > KNOCK_SPIN) {
      knock = Math.max(knock, Math.abs(body.spin));
    }
    if (body.tilt < lo) { body.tilt = lo; body.spin = Math.max(0, body.spin); }
    if (body.tilt > hi) { body.tilt = hi; body.spin = Math.min(0, body.spin); }
  };

  // Sounds: a creak where the rock turns around, a knock at a hard stop.
  let knock = 0, lastSpin = 0, peakSpin = 0;
  const listen = () => {
    if (knock) playSound("knock", { gain: Math.min(1, knock / MAX_SPIN) });
    knock = 0;
    peakSpin = Math.max(peakSpin, Math.abs(body.spin));
    if (body.spin * lastSpin < 0) {
      const swing = Math.abs(body.tilt - TILT_REST);
      if (swing > CREAK_SWING && peakSpin > CREAK_SPEED) {
        playSound("creak", { gain: Math.min(1, swing / CREAK_FULL) });
      }
      peakSpin = 0;
    }
    if (body.spin) lastSpin = body.spin;
  };

  // --- Rendering -------------------------------------------------------------------------

  const render = () => {
    const w = centre(body.tilt);
    chairEl.style.transform = `translate(${w.x - C.x}px, ${w.y - C.y}px) rotate(${body.tilt}rad)`;
  };

  // --- Input -----------------------------------------------------------------------------

  // Pointer -> design frame, from the stage's rendered size (whatever scales it).
  const toStage = (e) => {
    const r = stage.getBoundingClientRect();
    const s = r.width / STAGE;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  // On the rocker's band of characters (body frame)? `pad` widens it, for when the chair is small.
  const onRocker = (b, pad = 0) => {
    const r = Math.hypot(b.x - C.x, b.y - C.y), a = Math.atan2(b.y - C.y, b.x - C.x);
    const reach = ROCKER_HIT + pad, slack = reach / CENTRELINE;
    return Math.abs(r - CENTRELINE) < SIZE / 2 + reach && a < ARC_BACK + slack && a > ARC_FRONT - slack;
  };

  // The chair by its silhouette, or the rocker by its band of characters.
  const hitTest = (p, pad = 0) => {
    const b = toBody(body.tilt, p.x, p.y);
    return opaque(mask, STAGE, b) || onRocker(b, pad) ? b : null;
  };

  // The rocker is the chair's physics; the rest of the silhouette is what carries it.
  const hit = (p, pad = 0) => {
    const b = toBody(body.tilt, p.x, p.y);
    if (onRocker(b, pad)) return "physics";
    return opaque(mask, STAGE, b, pad / 2) ? "body" : null;
  };

  // Grab anywhere and drag to tilt; letting go keeps whatever spin the hand gave it.
  const down = (p, e, pad) => {
    const b = hitTest(p, pad);
    if (!b) return false;
    Object.assign(grab, { on: true, bx: b.x, by: b.y, tx: p.x, ty: p.y });
    stage.classList.add("grabbing");
    return true;
  };

  const move = (p) => {
    if (grab.on) { grab.tx = p.x; grab.ty = p.y; }
    else stage.classList.toggle("can-grab", !!hitTest(p));
  };

  const up = () => {
    grab.on = false;
    stage.classList.remove("grabbing");
  };

  const leave = () => {};

  // --- Loop ------------------------------------------------------------------------------

  let acc = 0;
  const step = (dt) => {
    for (acc += dt; acc >= STEP; acc -= STEP) {
      for (let s = 0; s < SUBSTEPS; s++) substep(STEP / SUBSTEPS);
    }
    render();
    listen();
  };
  render();

  const destroy = () => {
    stage.replaceChildren();
    stage.classList.remove("piece-chair", "can-grab", "grabbing");
  };

  return { STAGE, toStage, hit, down, move, up, leave, step, destroy };
}
