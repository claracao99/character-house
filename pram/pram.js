// Pram on two wheels of 轮.
//
// It rolls along an invisible floor. Grab it anywhere and push: it follows the hand on a soft
// spring, keeps its momentum when let go and slows with rolling friction, stopping softly at
// the ends of the frame. Each wheel turns by the distance
// travelled over its radius, so the 轮 spins at the right speed and the right way. A sharp
// start or stop sways the body a touch (under a degree, heavily damped). All units are
// design-frame pixels (2048²).
//
// mount(stage) draws one pram into a 2048² element and returns its controls; the page owns
// the pointer listeners and the animation loop. See house.js.

import { rumble } from "../sound.js";

export const STAGE = 2048;
export const IMAGE = new URL("assets/pram.png", import.meta.url).href;
const CHAR = "轮";

// --- Pram silhouette, measured from the image's alpha --------------------------------------

// Axles at the centres of the round hubs the struts end in (discs about 96px across).
const AXLES = [{ x: 772.5, y: 1435 }, { x: 1571.5, y: 1435 }];
const WHEEL = 240; // the wheel's character, centred on its axle, in front of the hub
const WHEEL_RADIUS = WHEEL * 0.45; // from the axle to the glyph's bottom edge: rolls on the floor
const FLOOR = AXLES[0].y + WHEEL_RADIUS;

// Where the wheels meet the floor, and the opaque box of the art, wheels included.
export const FOOT = { x: 1172, y: FLOOR };
export const BOUNDS = { x0: 313, y0: 399, x1: AXLES[1].x + WHEEL / 2, y1: FLOOR };

// --- Tuning ------------------------------------------------------------------------------

const STEP = 1 / 120;
const PUSH_K = 60; // 1/s², the hand's pull on the pram while held
const PUSH_DAMPING = 14; // 1/s, along the hand's pull
const ROLL_FRICTION = 700; // px/s², rolling friction: a brisk push stops within about a second
const ROLL_DRAG = 1.2; // 1/s, plus a little drag
const SPEED_MAX = 2400; // px/s
const OFFSTAGE = 40; // px outside the edge of the screen it comes back in from
const EDGE = 24; // px inside the edge of the screen it rolls back to if it stops half out

const SWAY_GAIN = 0.00002; // rad per px/s² of acceleration
const SWAY_MAX = Math.PI / 180; // a degree at most
const SWAY_FREQ = 9; // rad/s
const SWAY_ZETA = 0.8; // heavily damped

const RUMBLE_SPEED = 120; // px/s: slower than this rolls silently
const RUMBLE_FULL = 1600; // px/s: full rumble
const HIT_PAD = 10; // extra px around the wheels that still grabs

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

  stage.classList.add("piece-pram");
  const pramEl = document.createElement("div");
  pramEl.className = "pram";
  pramEl.setAttribute("aria-label", "Wheel");
  const bodyEl = document.createElement("div");
  bodyEl.className = "body";
  const img = document.createElement("img");
  img.src = IMAGE;
  img.alt = "Pink pram";
  img.draggable = false;
  bodyEl.appendChild(img);
  // the body sways about the middle of its axles
  bodyEl.style.transformOrigin = `${FOOT.x}px ${AXLES[0].y}px`;
  const wheelEls = AXLES.map(() => {
    const el = document.createElement("span");
    el.className = "char wheel";
    el.textContent = CHAR;
    return el;
  });
  pramEl.append(bodyEl, ...wheelEls);
  stage.append(pramEl);

  let mask = null; // image alpha, once decoded
  readAlpha(img, STAGE, (a) => { mask = a; });

  // --- Simulation ------------------------------------------------------------------------

  // x: how far the pram has rolled from where it starts.
  const cart = { x: 0, v: 0 };
  const grab = { on: false, ox: 0, tx: 0 };
  const turn = { a: 0, v: 0 }; // wheels' angle, and the speed they last rolled at
  const sway = { a: 0, w: 0 };
  const sound = rumble();

  // Rolling by dx (px) over dt (s): the wheels turn, a sharp change of speed sways the body.
  let rolled = false;
  const roll = (dx, dt) => {
    if (!dt) return;
    rolled = true;
    turn.a += dx / WHEEL_RADIUS;
    const v = dx / dt;
    sway.w -= (v - turn.v) * SWAY_GAIN * SWAY_FREQ; // a kick against the change of speed
    turn.v = v;
    const speed = Math.abs(v);
    sound.set(Math.max(0, Math.min(1, (speed - RUMBLE_SPEED) / (RUMBLE_FULL - RUMBLE_SPEED))));
  };

  const substep = (h) => {
    if (grab.on) {
      cart.v += (PUSH_K * (grab.tx + grab.ox - cart.x) - PUSH_DAMPING * cart.v) * h;
    } else if (cart.v) {
      const slow = (ROLL_FRICTION + ROLL_DRAG * Math.abs(cart.v)) * h;
      cart.v = Math.abs(cart.v) <= slow ? 0 : cart.v - Math.sign(cart.v) * slow;
    }
    if (grab.on) cart.v = Math.max(-SPEED_MAX, Math.min(SPEED_MAX, cart.v)); // caps a flick
    cart.x += cart.v * h;

    // sway: a damped spring back to upright
    sway.w += (-SWAY_FREQ * SWAY_FREQ * sway.a - 2 * SWAY_ZETA * SWAY_FREQ * sway.w) * h;
    sway.a = Math.max(-SWAY_MAX, Math.min(SWAY_MAX, sway.a + sway.w * h));
  };

  // Pushed off one side of the screen, it comes back in from the other: once it's out of
  // sight it moves to just past the far edge and rolls in, slowing under the same friction as
  // a push, to rest where it started. The screen is usually wider than the design frame, so
  // the edges come from the stage's rendered box.
  const view = () => {
    const r = stage.getBoundingClientRect();
    const s = r.width / STAGE;
    return { x0: -r.left / s, x1: (innerWidth - r.left) / s };
  };

  // The speed that rolls `distance` px before friction and drag stop it (the inverse of the
  // stopping distance v/k − a/k²·ln(1 + kv/a) under a = ROLL_FRICTION, k = ROLL_DRAG).
  const speedToRoll = (distance) => {
    const a = ROLL_FRICTION, k = ROLL_DRAG;
    let lo = 0, hi = 4 * SPEED_MAX; // a wide screen needs more than a flick to cross
    for (let i = 0; i < 40; i++) {
      const v = (lo + hi) / 2;
      if (v / k - (a / (k * k)) * Math.log(1 + (k * v) / a) < distance) lo = v; else hi = v;
    }
    return lo;
  };

  // Returns how far it jumped, 0 if it didn't. Stopped with only part of it out of sight, it
  // rolls gently back into view instead, as if the edge were a slight slope.
  const wrap = () => {
    const v = view();
    const left = BOUNDS.x0 + cart.x, right = BOUNDS.x1 + cart.x;
    if (!grab.on && !cart.v) {
      if (left < v.x0 && right > v.x0) cart.v = speedToRoll(v.x0 + EDGE - left);
      else if (right > v.x1 && left < v.x1) cart.v = -speedToRoll(right - (v.x1 - EDGE));
    }
    let to = null;
    if (right < v.x0 && cart.v <= 0) to = v.x1 + OFFSTAGE - BOUNDS.x0; // gone left
    else if (left > v.x1 && cart.v >= 0) to = v.x0 - OFFSTAGE - BOUNDS.x1; // gone right
    if (to === null) return 0;
    const jump = to - cart.x;
    cart.x = to;
    cart.v = -Math.sign(to) * speedToRoll(Math.abs(to));
    grab.on = false;
    stage.classList.remove("grabbing");
    turn.v = cart.v; // already rolling at this speed: no kick, no sway
    sway.a = sway.w = 0;
    return jump;
  };

  // --- Rendering -------------------------------------------------------------------------

  const render = () => {
    pramEl.style.transform = `translateX(${cart.x}px)`;
    bodyEl.style.transform = `rotate(${sway.a}rad)`;
    AXLES.forEach((a, i) => {
      wheelEls[i].style.transform = `translate(${a.x}px, ${a.y}px) rotate(${turn.a}rad)`;
    });
  };

  // --- Input -----------------------------------------------------------------------------

  // Pointer -> design frame, from the stage's rendered size (whatever scales it).
  const toStage = (e) => {
    const r = stage.getBoundingClientRect();
    const s = r.width / STAGE;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  // The pram, wheels included.
  const onPram = (p, pad = 0) => {
    const q = { x: p.x - cart.x, y: p.y };
    const reach = WHEEL / 2 + HIT_PAD + pad;
    const onWheel = AXLES.some((a) => Math.hypot(q.x - a.x, q.y - a.y) < reach);
    return onWheel || opaque(mask, STAGE, q, pad / 2);
  };
  const hit = (p, pad = 0) => (onPram(p, pad) ? "body" : null);

  // Grab anywhere and push; letting go keeps the push. Once let go it's on its own: it can't be
  // caught again until it has rolled to a stop.
  const rolling = () => !grab.on && cart.v !== 0;
  const down = (p, e, pad) => {
    if (rolling() || !onPram(p, pad)) return false;
    Object.assign(grab, { on: true, ox: cart.x - p.x, tx: p.x });
    stage.classList.add("grabbing");
    return true;
  };

  const move = (p) => {
    if (grab.on) grab.tx = p.x;
    else stage.classList.toggle("can-grab", !rolling() && onPram(p));
  };

  const up = () => {
    grab.on = false;
    stage.classList.remove("grabbing");
  };

  const leave = () => {};

  // --- Loop ------------------------------------------------------------------------------

  let acc = 0;
  const step = (dt) => {
    let x0 = cart.x;
    for (acc += dt; acc >= STEP; acc -= STEP) substep(STEP);
    x0 += wrap(); // a jump to the other side isn't rolling
    if (cart.x !== x0 || (turn.v && !rolled)) roll(cart.x - x0, dt);
    rolled = false;
    render();
  };
  render();

  const destroy = () => {
    sound.stop();
    stage.replaceChildren();
    stage.classList.remove("piece-pram", "can-grab", "grabbing");
  };

  return { STAGE, toStage, hit, down, move, up, leave, step, destroy };
}
