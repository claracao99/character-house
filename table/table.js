// Rolling side table on two wheels of 轮.
//
// The table rolls along an invisible floor. Grab it anywhere and push: it follows the hand
// on a soft spring, keeps its momentum when let go and slows with rolling friction, stopping
// softly at the ends of the frame. Each wheel turns by the distance travelled over its
// radius, so the 轮 spins at the right speed and the right way. A sharp start or stop sways
// the body a touch (under a degree, heavily damped). All units are design-frame pixels
// (2048²).
//
// mount(stage) draws one table into a 2048² element and returns its controls; the page (or
// the room) owns the pointer listeners and the animation loop. See main.js. In the room the
// table is carried like any piece, and the room rolls it (see ROLLS and roll() below).

import { playSound, rumble } from "../sound.js";

export const STAGE = 2048;
export const IMAGE = new URL("assets/table.png", import.meta.url).href;
const CHAR = "轮";

// --- Table silhouette, measured from the image's alpha --------------------------------------

// Axles just below the round stubs the legs end in (stubs centred at y 1470, bottom 1489).
const AXLES = [{ x: 440.5, y: 1500 }, { x: 1606, y: 1500 }];
const WHEEL = 124; // the wheel's character, centred on its axle, behind the leg
const WHEEL_RADIUS = WHEEL * 0.45; // from the axle to the glyph's bottom edge: rolls on the floor
const FLOOR = AXLES[0].y + WHEEL_RADIUS;

// Where the wheels meet the floor, and the opaque box of the art (for placing it in a room).
export const FOOT = { x: 1024, y: FLOOR };
export const BOUNDS = { x0: 320, y0: 558, x1: 1727, y1: FLOOR };
// In the room, the table moves by rolling: the room keeps its momentum and calls roll().
export const ROLLS = true;

// --- Tuning ------------------------------------------------------------------------------

const STEP = 1 / 120;
const PUSH_K = 60; // 1/s², the hand's pull on the table while held
const PUSH_DAMPING = 14; // 1/s, along the hand's pull
const ROLL_FRICTION = 700; // px/s², rolling friction: a brisk push stops within about a second
const ROLL_DRAG = 1.2; // 1/s, plus a little drag
const SPEED_MAX = 2400; // px/s
const END_BOUNCE = 0.15; // fraction of speed kept off the ends of the frame
const MARGIN = 24; // px kept between the table and the frame's edges

const SWAY_GAIN = 0.00002; // rad per px/s² of acceleration
const SWAY_MAX = Math.PI / 180; // a degree at most
const SWAY_FREQ = 9; // rad/s
const SWAY_ZETA = 0.8; // heavily damped

const RUMBLE_SPEED = 120; // px/s: slower than this rolls silently
const RUMBLE_FULL = 1600; // px/s: full rumble
const BUMP_SPEED = 150; // px/s into an end before it bumps
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

  stage.classList.add("piece-table");
  const tableEl = document.createElement("div");
  tableEl.className = "table";
  tableEl.setAttribute("aria-label", "Wheel");
  const bodyEl = document.createElement("div");
  bodyEl.className = "body";
  const img = document.createElement("img");
  img.src = IMAGE;
  img.alt = "Coral side table";
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
  tableEl.append(...wheelEls, bodyEl);
  stage.append(tableEl);

  let mask = null; // image alpha, once decoded
  readAlpha(img, STAGE, (a) => { mask = a; });

  // --- Simulation ------------------------------------------------------------------------

  // x: how far the table has rolled from the middle of its frame (on its own page only; in
  // the room it stays put in its frame and the room moves the frame).
  const cart = { x: 0, v: 0 };
  const grab = { on: false, ox: 0, tx: 0 };
  const turn = { a: 0, v: 0 }; // wheels' angle, and the speed they last rolled at
  const sway = { a: 0, w: 0 };
  const sound = rumble();
  const lo = MARGIN - BOUNDS.x0, hi = STAGE - MARGIN - BOUNDS.x1;

  // Rolling by dx (px) over dt (s): the wheels turn, a sharp change of speed sways the body.
  // The room calls it (before step) as it moves the table; here step calls it.
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
    cart.v = Math.max(-SPEED_MAX, Math.min(SPEED_MAX, cart.v));
    cart.x += cart.v * h;

    // the ends of the frame: a soft stop
    if (cart.x < lo || cart.x > hi) {
      const speed = Math.abs(cart.v);
      if (speed > BUMP_SPEED) playSound("bump", { gain: Math.min(1, speed / 1200) });
      cart.x = Math.max(lo, Math.min(hi, cart.x));
      cart.v *= -END_BOUNCE;
    }

    // sway: a damped spring back to upright
    sway.w += (-SWAY_FREQ * SWAY_FREQ * sway.a - 2 * SWAY_ZETA * SWAY_FREQ * sway.w) * h;
    sway.a = Math.max(-SWAY_MAX, Math.min(SWAY_MAX, sway.a + sway.w * h));
  };

  // --- Rendering -------------------------------------------------------------------------

  const render = () => {
    tableEl.style.transform = `translateX(${cart.x}px)`;
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

  // The table, wheels included. Rolling is how it moves, so in the room it's all "body".
  const onTable = (p, pad = 0) => {
    const q = { x: p.x - cart.x, y: p.y };
    const reach = WHEEL / 2 + HIT_PAD + pad;
    const onWheel = AXLES.some((a) => Math.hypot(q.x - a.x, q.y - a.y) < reach);
    return onWheel || opaque(mask, STAGE, q, pad / 2);
  };
  const hit = (p, pad = 0) => (onTable(p, pad) ? "body" : null);

  // On its own page: grab anywhere and push; letting go keeps the push.
  const down = (p, e, pad) => {
    if (!onTable(p, pad)) return false;
    Object.assign(grab, { on: true, ox: cart.x - p.x, tx: p.x });
    stage.classList.add("grabbing");
    return true;
  };

  const move = (p) => {
    if (grab.on) grab.tx = p.x;
    else stage.classList.toggle("can-grab", onTable(p));
  };

  const up = () => {
    grab.on = false;
    stage.classList.remove("grabbing");
  };

  const leave = () => {};

  // --- Loop ------------------------------------------------------------------------------

  let acc = 0;
  const step = (dt) => {
    const x0 = cart.x;
    for (acc += dt; acc >= STEP; acc -= STEP) substep(STEP);
    if (cart.x !== x0 || (turn.v && !rolled)) roll(cart.x - x0, dt);
    rolled = false;
    render();
  };
  render();

  const destroy = () => {
    sound.stop();
    stage.replaceChildren();
    stage.classList.remove("piece-table", "can-grab", "grabbing");
  };

  return { STAGE, toStage, hit, down, move, up, leave, step, roll, destroy };
}
