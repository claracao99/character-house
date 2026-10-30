// Grandfather clock: a small face with plain hands that keep real time, and a pendulum made
// of 钟 (a column of them for the rod, a bigger one for the bob) swinging in the trunk's
// arched window.
//
// The hands only tell the time. The pendulum is the clock's one toy: a real pendulum (angle,
// angular velocity, gravity, damping) with a soft escapement that keeps it swinging gently
// forever; drag it to swing it. The clock image sits on top; the face and pendulum only show
// through its holes. All units are design-frame pixels (2048²).
//
// mount(stage) draws one clock into a 2048² element and returns its controls; the page owns
// the pointer listeners and the animation loop (see house.js).

import { playSound } from "../sound.js";

export const STAGE = 2048;
export const IMAGE = new URL("assets/grandfather-clock.png", import.meta.url).href;
const CHAR = "钟";

// --- Clock silhouette, measured from the image's alpha --------------------------------------

const FACE = { x: 1023.6, y: 451.6, r: 146 };
const WINDOW = { x0: 932, x1: 1115, y0: 775, y1: 1531 }; // arched top, radius ~92

// The opaque box of the art (the page centres it).
export const BOUNDS = { x0: 781, y0: 92, x1: 1266, y1: 1953 };

// --- Tuning ------------------------------------------------------------------------------

const STEP = 1 / 120;
const SUBSTEPS = 4;

const MARK_RADIUS = 118; // from the centre of the face to the centre of each hour dot
const HOUR = { length: 56, width: 10 };
const MINUTE = { length: 88, width: 7 };
const DOT = 20; // the centre dot the hands turn on

const PERIOD = 2; // s, a full swing there and back (a seconds pendulum)
const PIVOT = { x: (WINDOW.x0 + WINDOW.x1) / 2, y: 812 }; // just under the top of the arch
const ROD_CHARS = 11;
const ROD_STEP = 54; // spacing of the rod's characters (52px, as big as the window allows)
const ROD_START = 30; // first character's distance from the pivot
const BOB = 84; // the bob's character
const BOB_RADIUS = 40;
const LENGTH = ROD_START + (ROD_CHARS - 1) * ROD_STEP + ROD_STEP / 2 + BOB / 2; // pivot to bob
const IDLE_AMPLITUDE = (2.2 * Math.PI) / 180; // the escapement keeps it at this
const ESCAPEMENT = 0.35; // 1/s, how firmly it is nudged toward the idle swing
const SWING_DAMPING = 0.08; // 1/s, plain air drag on top
const WALL_BOUNCE = 0.25; // fraction of speed kept when the bob touches the window side
const PULL_FREQ = 14; // rad/s, how tightly a held bob follows the pointer
const TICK_GAIN = 0.9; // the tick-tock is always on, so keep it low
const KNOCK_SPEED = 0.15; // rad/s into the window side before it knocks

const HIT_RADIUS = 30; // around the rod
const BOB_HIT_RADIUS = 56;

const GRAVITY = LENGTH * ((2 * Math.PI) / PERIOD) ** 2; // so a small swing takes PERIOD
// widest the swing can go before the bob meets the side of the window
const SWING_MAX = Math.asin(((WINDOW.x1 - WINDOW.x0) / 2 - BOB_RADIUS - 4) / LENGTH);

// --- Time --------------------------------------------------------------------------------

// Angles run clockwise from twelve, in radians. The minute hand moves smoothly.
const timeAngles = () => {
  const d = new Date();
  const s = d.getSeconds() + d.getMilliseconds() / 1000;
  const m = d.getMinutes() + s / 60;
  const h = (d.getHours() % 12) + m / 60;
  return { hour: (h / 12) * 2 * Math.PI, minute: (m / 60) * 2 * Math.PI };
};

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

  stage.classList.add("piece-clock");
  const make = (parent, cls, text) => {
    const el = document.createElement(text ? "span" : "div");
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  };

  // The face and pendulum sit under the clock; they show through its holes.
  const faceEl = make(stage, "face");
  faceEl.setAttribute("aria-hidden", "true");
  for (let k = 1; k <= 12; k++) {
    const a = (k * Math.PI) / 6;
    const el = make(faceEl, "mark");
    el.style.transform =
      `translate(${FACE.x + MARK_RADIUS * Math.sin(a)}px, ${FACE.y - MARK_RADIUS * Math.cos(a)}px)`;
  }

  // A hand is a rounded bar standing on the centre, turned about its foot.
  const makeHand = (size, label) => {
    const el = make(stage, "hand");
    el.setAttribute("aria-label", label);
    el.style.width = `${size.width}px`;
    el.style.height = `${size.length + size.width}px`;
    el.style.borderRadius = `${size.width / 2}px`;
    el.style.transformOrigin = `${size.width / 2}px ${size.length + size.width / 2}px`;
    return el;
  };
  const hourEl = makeHand(HOUR, "Hour hand");
  const minuteEl = makeHand(MINUTE, "Minute hand");
  const dotEl = make(stage, "dot");
  dotEl.style.width = dotEl.style.height = `${DOT}px`;
  dotEl.style.transform = `translate(${FACE.x - DOT / 2}px, ${FACE.y - DOT / 2}px)`;

  // The pendulum: a column of 钟 hanging from the pivot, a bigger 钟 at the bottom.
  const pendulumEl = make(stage, "pendulum");
  pendulumEl.setAttribute("aria-label", "Pendulum");
  const rodEls = Array.from({ length: ROD_CHARS }, () => make(pendulumEl, "rod", CHAR));
  const bobEl = make(pendulumEl, "bob", CHAR);

  const img = document.createElement("img");
  img.className = "clock";
  img.src = IMAGE;
  img.alt = "Blue grandfather clock";
  img.draggable = false;
  stage.append(img);

  let mask = null; // image alpha, once decoded
  readAlpha(img, STAGE, (a) => { mask = a; });

  // --- Hands: they only tell the time ----------------------------------------------------

  const now = timeAngles();
  const hands = [
    { name: "hour", el: hourEl, ...HOUR, a: now.hour },
    { name: "minute", el: minuteEl, ...MINUTE, a: now.minute },
  ];

  const grab = { bob: false, x: 0, y: 0 };

  // --- Pendulum --------------------------------------------------------------------------

  const swing = { a: IDLE_AMPLITUDE, w: 0 };

  // Sounds: tick, tock as the pendulum passes the middle; a knock on the window's side.
  let knock = 0, side = Math.sign(swing.a), tock = false;
  const listen = () => {
    if (knock) playSound("knock", { gain: Math.min(1, knock / 1.5) * 0.6 });
    knock = 0;
    const now = Math.sign(swing.a);
    if (now && now !== side) {
      playSound(tock ? "tock" : "tick", { gain: TICK_GAIN });
      tock = !tock;
      side = now;
    }
  };
  const W0 = (2 * Math.PI) / PERIOD;

  const stepPendulum = (h) => {
    let acc = -(GRAVITY / LENGTH) * Math.sin(swing.a) - SWING_DAMPING * swing.w;

    if (grab.bob) {
      // the hand pulls the bob toward the pointer, along the arc
      const target = Math.max(-SWING_MAX, Math.min(SWING_MAX,
        Math.atan2(PIVOT.x - grab.x, grab.y - PIVOT.y)));
      acc += PULL_FREQ * PULL_FREQ * (target - swing.a) - 2 * PULL_FREQ * swing.w;
    } else {
      // Escapement: from the current energy, how wide is the swing? Push a little when it is
      // under the idle swing, hold back when over, so it always drifts back to the same tick.
      const amp = Math.hypot(swing.a, swing.w / W0) || 1e-6;
      acc -= 2 * ESCAPEMENT * (amp / IDLE_AMPLITUDE - 1) * swing.w;
    }

    swing.w += acc * h;
    swing.a += swing.w * h;

    // the window sides: a soft knock, not a bounce
    if (Math.abs(swing.a) > SWING_MAX) {
      swing.a = Math.sign(swing.a) * SWING_MAX;
      if (swing.w * swing.a > 0) {
        if (Math.abs(swing.w) > KNOCK_SPEED) knock = Math.max(knock, Math.abs(swing.w));
        swing.w *= -WALL_BOUNCE;
      }
    }
  };

  // --- Rendering -------------------------------------------------------------------------

  const render = () => {
    for (const hand of hands) {
      const x = FACE.x - hand.width / 2, y = FACE.y - hand.length - hand.width / 2;
      hand.el.style.transform = `translate(${x}px, ${y}px) rotate(${hand.a}rad)`;
    }

    // a = 0 hangs straight down; positive swings left. Characters hang upright along the rod.
    const sx = -Math.sin(swing.a), cy = Math.cos(swing.a);
    const place = (el, r) => {
      el.style.transform = `translate(${PIVOT.x + r * sx}px, ${PIVOT.y + r * cy}px) rotate(${swing.a}rad)`;
    };
    rodEls.forEach((el, i) => place(el, ROD_START + i * ROD_STEP));
    place(bobEl, LENGTH);
  };

  // --- Input -----------------------------------------------------------------------------

  // Pointer -> design frame, from the stage's rendered size (whatever scales it).
  const toStage = (e) => {
    const r = stage.getBoundingClientRect();
    const s = r.width / STAGE;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  // On the pendulum (bob or rod)? `pad` widens the reach, for when the clock is drawn small.
  const hitTest = (p, pad = 0) => {
    const reach = HIT_RADIUS + pad;
    const sx = -Math.sin(swing.a), cy = Math.cos(swing.a);
    if (Math.hypot(p.x - (PIVOT.x + LENGTH * sx), p.y - (PIVOT.y + LENGTH * cy)) < BOB_HIT_RADIUS + pad) {
      return "bob";
    }
    const along = (p.x - PIVOT.x) * sx + (p.y - PIVOT.y) * cy;
    const across = Math.abs((p.x - PIVOT.x) * cy - (p.y - PIVOT.y) * sx);
    return along > 0 && along < LENGTH && across < reach ? "bob" : null;
  };

  // The pendulum is the clock's physics; the case (face and window included) carries it.
  const hit = (p, pad = 0) => {
    if (hitTest(p, pad)) return "physics";
    const inFace = Math.hypot(p.x - FACE.x, p.y - FACE.y) < FACE.r;
    const inWindow = p.x > WINDOW.x0 && p.x < WINDOW.x1 && p.y > WINDOW.y0 && p.y < WINDOW.y1;
    return inFace || inWindow || opaque(mask, STAGE, p, pad / 2) ? "body" : null;
  };

  const down = (p, e, pad) => {
    if (!hitTest(p, pad)) return false;
    Object.assign(grab, { bob: true, x: p.x, y: p.y });
    stage.classList.add("grabbing");
    return true;
  };

  const move = (p) => {
    if (grab.bob) { grab.x = p.x; grab.y = p.y; }
    else stage.classList.toggle("can-grab", !!hitTest(p));
  };

  const up = () => {
    grab.bob = false;
    stage.classList.remove("grabbing");
  };

  const leave = () => {};

  // --- Loop ------------------------------------------------------------------------------

  let acc = 0;
  const step = (dt) => {
    for (acc += dt; acc >= STEP; acc -= STEP) {
      for (let s = 0; s < SUBSTEPS; s++) stepPendulum(STEP / SUBSTEPS);
    }
    const time = timeAngles();
    for (const hand of hands) hand.a = time[hand.name];
    listen();
    render();
  };
  render();

  const destroy = () => {
    stage.replaceChildren();
    stage.classList.remove("piece-clock", "can-grab", "grabbing");
  };

  return { STAGE, toStage, hit, down, move, up, leave, step, destroy };
}
