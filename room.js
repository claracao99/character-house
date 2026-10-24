// An empty room to furnish, and the house's landing page. Open the drawer at the bottom, drag
// a card out and its piece comes with it; put it down and it keeps its live physics (pull the
// cord, sweep the curtain, rock the chair, swing the pendulum). Grab a piece by its
// silhouette to move it, drag it back onto the drawer to put it away.
//
// Every piece is mounted from its own folder (see lamp/lamp.js for the API) into a frame of
// its own design size, scaled and placed here. The frames never take the pointer: the room
// hit-tests the pieces front to back and hands each event to the one underneath. One
// requestAnimationFrame steps them all. Placements persist in localStorage.

import * as lamp from "./lamp/lamp.js";
import * as curtain from "./curtain/curtain.js";
import * as chair from "./chair/chair.js";
import * as clock from "./clock/clock.js";
import * as table from "./table/table.js";
import { playSound, unlockOnGesture, soundEnabled, setSoundEnabled } from "./sound.js";

// Pulling the floor lamp's cord switches it on and off: dark (on) or light (off). The theme
// lives on <html> and in localStorage; a script in index.html's <head> restores it before the
// first paint. Without the lamp in the room the theme stays as it is.
const THEME = "character-house-theme";
const toggleTheme = () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME, dark ? "dark" : "light"); } catch {}
  playSound("tap");
};

// The room's lamp is the tall floor lamp, with the same cord as the table lamp.
const floorLamp = {
  ...lamp.FLOOR_LAMP,
  mount: (el) => lamp.mount(el, lamp.FLOOR_LAMP, { onToggle: toggleTheme }),
};

// --- Tuning ------------------------------------------------------------------------------

const FLOOR_TOP = 0.4; // feet can stand from this far down the room to just above the drawer
// One real-world scale for every piece, set only by the room's size: px per cm is the smaller
// of these fractions of the room's height and width. The height rule puts a 2.1 m door at 62%
// of the room on a desktop; on a phone in portrait the width rule wins, so the door frame and
// the clock still fit side by side.
const CM_PER_HEIGHT = 0.00296; // px/cm per px of room height
const CM_PER_WIDTH = 0.0045; // px/cm per px of room width
const LIFT = 0.03; // a carried piece grows this much...
const LIFT_UP = 4; // ...and rises this many px
const LIFT_RATE = 14; // 1/s, how quickly it lifts and settles
const MARGIN = 8; // px kept between a piece and the room's sides
const HEADROOM = 56; // px kept above the tallest piece, clear of the nav
const DRAWER_ZONE = 52; // px at the bottom kept for the drawer's handle; floor pieces stand above
const DRAWER_REACH = 24; // px around the drawer (or its handle) where a dropped piece is put away
const PICK_SLOP = 6; // px a card moves before a mouse drag picks it up
const PULL_UP = 10; // px a finger pulls a card upward to pick it up (sideways scrolls the row)
const PULL_ANGLE = 0.7; // ...as long as it's at least this much more up than sideways
const LONG_PRESS = 380; // ms a finger rests on a card to pick it up
const FIRST_OPEN = 900; // ms after a first visit to an empty room before the drawer opens
const TAP_SLOP = 6; // px a press can wander before a piece is lifted
// A piece that rolls (the table) keeps its sideways momentum when let go, and slows down.
const ROLL_FRICTION = 5; // m/s², rolling friction: stops within about a second
const ROLL_DRAG = 1.2; // 1/s
const ROLL_MAX = 6; // m/s
const BUMP_SPEED = 0.3; // m/s into a wall before it bumps
const REACH = 10; // px of extra reach around small characters and thin silhouettes
const STORE = "character-house-room";
const SEEN = "character-house-drawer"; // the drawer has opened by itself once
// With nothing saved, the room starts with just the floor lamp (its switch is the theme), a
// little left of centre and partway down the floor, clear of the open drawer. Stored like a
// placement.
const START = { lamp: { x: 0.4, y: 0.45 } };

// Every piece shares one real-world scale (px per cm, set only by the room's size), so they
// keep their sizes relative to each other wherever they stand. `cm` is the real height of the
// opaque art (its BOUNDS), so empty frame margins don't skew it. Every piece stands with its
// feet anywhere on the (unseen) floor, nearer ones drawn in front.
const PIECES = {
  lamp: { module: floorLamp, cm: 160, glyph: "灯", name: "Lamp" },
  curtain: { module: curtain, cm: 210, glyph: "帘", name: "Curtain" },
  chair: { module: chair, cm: 100, glyph: "椅", name: "Rocking chair" },
  clock: { module: clock, cm: 190, glyph: "钟", name: "Clock" },
  table: { module: table, cm: 75, glyph: "轮", name: "Wheel" },
};

// --- DOM ---------------------------------------------------------------------------------

const room = document.getElementById("room");
const piecesEl = document.getElementById("pieces");
const drawer = document.getElementById("drawer");
const handle = document.getElementById("handle");
const cardsEl = document.getElementById("cards");

// One card per piece: its silhouette in a tray, the character and its name underneath, and a
// quiet note while it's in the room.
const cards = Object.fromEntries(Object.entries(PIECES).map(([key, { module: m, glyph, name }]) => {
  const card = document.createElement("div");
  card.className = `card card-${key}`;
  card.dataset.piece = key;
  card.innerHTML =
    `<div class="preview"><div class="art"><img alt="" draggable="false"></div></div>` +
    `<div class="label"><span class="glyph" lang="zh-Hans">${glyph}</span>` +
    `<span>${name}</span></div><div class="note">In room</div>`;
  const img = card.querySelector("img");
  img.src = m.IMAGE;
  img.style.width = img.style.height = `${m.STAGE}px`;
  cardsEl.appendChild(card);
  return [key, card];
}));

// Fit each silhouette (its opaque BOUNDS, not the empty frame) into its tray, tall pieces
// using its full height.
const PREVIEW_FILL = 0.9;
const fitPreviews = () => {
  for (const [key, card] of Object.entries(cards)) {
    const { BOUNDS: b } = PIECES[key].module;
    const box = card.querySelector(".preview").clientWidth;
    const k = (box * PREVIEW_FILL) / Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const x = box / 2 - ((b.x0 + b.x1) / 2) * k, y = box / 2 - ((b.y0 + b.y1) / 2) * k;
    card.querySelector("img").style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  }
};

let drawerOpen = false;
const setDrawer = (open) => {
  if (open !== drawerOpen) playSound(open ? "slideOpen" : "slideClose");
  drawerOpen = open;
  drawer.classList.toggle("open", open);
  handle.setAttribute("aria-expanded", String(open));
};

// --- Layout ------------------------------------------------------------------------------

let W = 0, H = 0, floorTop = 0, floorBottom = 0, pxPerCm = 0, metre = 0;
const layout = () => {
  W = room.clientWidth;
  H = room.clientHeight;
  floorTop = H * FLOOR_TOP;
  floorBottom = Math.max(floorTop + 1, H - DRAWER_ZONE);
  pxPerCm = Math.min(H * CM_PER_HEIGHT, W * CM_PER_WIDTH);
  metre = 100 * pxPerCm;
};

// Scale of a piece's design frame on screen: the same px per cm for every piece.
const scaleOf = (key) => {
  const { module: m, cm } = PIECES[key];
  return (pxPerCm * cm) / (m.BOUNDS.y1 - m.BOUNDS.y0);
};

// The nearest allowed spot for a piece's foot (screen px): on the floor, and the whole piece
// inside the room.
const constrain = (key, x, y) => {
  const s = scaleOf(key);
  const { FOOT: f, BOUNDS: b } = PIECES[key].module;
  const top = Math.max(floorTop, HEADROOM + (f.y - b.y0) * s);
  y = Math.min(floorBottom, Math.max(Math.min(top, floorBottom), y));
  const left = MARGIN + (f.x - b.x0) * s, right = W - MARGIN - (b.x1 - f.x) * s;
  x = right < left ? (left + right) / 2 : Math.min(right, Math.max(left, x));
  return { x, y };
};

// Stored as fractions of the room (y by how far down the floor the feet stand), so a
// placement survives a resize or another screen.
const toStored = (key, p) => ({
  x: p.x / W,
  y: (p.y - floorTop) / (floorBottom - floorTop),
});
const fromStored = (key, v) => ({
  x: v.x * W,
  y: floorTop + v.y * (floorBottom - floorTop),
});

// --- Pieces ------------------------------------------------------------------------------

// key -> { piece, el, x, y (foot, screen px, stored as fractions), lift, away }
const placed = {};

const add = (key, x, y) => {
  const el = document.createElement("div");
  el.className = "piece";
  const { STAGE } = PIECES[key].module;
  el.style.width = el.style.height = `${STAGE}px`;
  piecesEl.appendChild(el);
  placed[key] = {
    piece: PIECES[key].module.mount(el), el, x, y, lift: 0, away: false, vx: 0, rolledTo: x,
  };
  cards[key].classList.add("placed");
  return placed[key];
};

const save = () => {
  const out = {};
  for (const [key, p] of Object.entries(placed)) out[key] = toStored(key, p);
  try { localStorage.setItem(STORE, JSON.stringify(out)); } catch {}
};

const remove = (key) => {
  placed[key].piece.destroy();
  placed[key].el.remove();
  delete placed[key];
  cards[key].classList.remove("placed");
};

// Foot position (relative to the room) and current scale of a placed piece.
const render = (key, p) => {
  const { FOOT: f } = PIECES[key].module;
  const s = scaleOf(key) * (1 + LIFT * p.lift);
  const y = p.y - LIFT_UP * p.lift;
  p.el.style.transform = `translate(${p.x - f.x * s}px, ${y - f.y * s}px) scale(${s})`;
  p.el.style.zIndex = p.away ? 100001 : Math.round(10 + p.y); // nearer feet, in front
  p.el.classList.toggle("away", p.away);
};

// Front to back, as drawn.
const ordered = () =>
  Object.entries(placed).sort(([, a], [, b]) => b.y - a.y);

// The frontmost piece under the pointer, and what it was hit on ("physics" or "body").
const pick = (e) => {
  for (const [key, p] of ordered()) {
    const pt = p.piece.toStage(e);
    const pad = REACH / scaleOf(key);
    const kind = p.piece.hit(pt, pad);
    if (kind) return { key, p, pt, pad, kind };
  }
  return null;
};

// --- Input -------------------------------------------------------------------------------

const local = (e) => {
  const r = room.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

const within = (e, r, reach) =>
  e.clientX > r.left - reach && e.clientX < r.right + reach &&
  e.clientY > r.top - reach && e.clientY < r.bottom + reach;

// Over the open drawer, or over where its handle rests when closed (it may still be sliding).
const overDrawer = (e) => {
  if (drawerOpen) return within(e, drawer.getBoundingClientRect(), DRAWER_REACH);
  const r = room.getBoundingClientRect(), h = handle.getBoundingClientRect();
  const left = r.left + (r.width - h.width) / 2;
  const rest = { left, right: left + h.width, top: r.bottom - h.height, bottom: r.bottom };
  return within(e, rest, DRAWER_REACH);
};

// One pointer at a time: playing with a piece, carrying one (dx, dy from pointer to foot), or
// pulling the drawer by its handle. A card that's pressed but not yet picked up is `pending`.
let drag = null;
let pending = null;

const carry = (e) => {
  const { key, dx, dy } = drag;
  const p = placed[key];
  const q = local(e);
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > TAP_SLOP) {
    drag.moved = true;
    if (!drag.fresh) playSound("lift");
  }
  // the drawer gets out of the way as soon as a piece leaves it
  if (drawerOpen && !within(e, drawer.getBoundingClientRect(), 0)) setDrawer(false);
  p.away = overDrawer(e);
  // over the drawer it simply hangs from the pointer; in the room it keeps to the rules
  const x0 = p.x;
  Object.assign(p, p.away ? { x: q.x + dx, y: q.y + dy } : constrain(key, q.x + dx, q.y + dy));
  // how fast it's being pushed sideways, for a rolling piece's momentum
  const t = e.timeStamp ?? performance.now(), dt = (t - (drag.t ?? t)) / 1000;
  if (dt > 0) drag.vx = 0.6 * (drag.vx ?? 0) + 0.4 * ((p.x - x0) / dt);
  drag.t = t;
};

const grabbing = (id) => {
  try { room.setPointerCapture(id); } catch {}
  room.classList.add("grabbing");
};

// Pick a card up: its piece appears centred under the pointer and follows it.
const pickUp = (key, id, e) => {
  clearTimeout(pending?.timer);
  pending = null;
  const { FOOT: f, BOUNDS: b } = PIECES[key].module;
  const s = scaleOf(key);
  add(key, 0, 0);
  drag = {
    id, key, carry: true, fresh: true, moved: true, x0: e.clientX, y0: e.clientY,
    dx: (f.x - (b.x0 + b.x1) / 2) * s, dy: (f.y - (b.y0 + b.y1) / 2) * s,
  };
  carry(e);
  grabbing(id);
  playSound("lift");
};

// Fingers on the room: only one at a time does anything.
const fingers = new Set();

room.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") fingers.add(e.pointerId);
  if (drag || pending || fingers.size > 1) return;

  if (e.target.closest(".handle")) {
    drag = { id: e.pointerId, drawer: true, y0: e.clientY, open: drawerOpen, moved: false };
    drawer.classList.add("dragging");
    grabbing(e.pointerId);
    return;
  }

  const card = e.target.closest(".card");
  if (card) {
    const key = card.dataset.piece;
    if (placed[key]) return;
    // a mouse picks it up as soon as it moves; a finger by pulling up or resting on it, so a
    // sideways swipe can still scroll the row
    const at = { clientX: e.clientX, clientY: e.clientY };
    const mouse = e.pointerType === "mouse";
    pending = { id: e.pointerId, key, mouse, x0: e.clientX, y0: e.clientY, at };
    if (pending.mouse) room.setPointerCapture(e.pointerId);
    else pending.timer = setTimeout(() => pickUp(key, pending.id, pending.at), LONG_PRESS);
    return;
  }
  if (e.target.closest(".drawer")) return;

  // tapping the room closes the drawer, and does nothing else
  if (drawerOpen) {
    setDrawer(false);
    return;
  }

  const hit = pick(e);
  if (!hit) return;
  if (hit.kind === "physics") {
    if (!hit.p.piece.down(hit.pt, e, hit.pad)) return;
    drag = { id: e.pointerId, key: hit.key, carry: false };
  } else {
    const q = local(e);
    drag = {
      id: e.pointerId, key: hit.key, carry: true, x0: e.clientX, y0: e.clientY,
      dx: hit.p.x - q.x, dy: hit.p.y - q.y,
    };
    hit.p.piece.leave();
  }
  grabbing(e.pointerId);
});

room.addEventListener("pointermove", (e) => {
  if (pending && e.pointerId === pending.id) {
    pending.at = { clientX: e.clientX, clientY: e.clientY };
    const dx = e.clientX - pending.x0, dy = e.clientY - pending.y0;
    const up = -dy > PULL_UP && -dy > Math.abs(dx) * PULL_ANGLE;
    if (pending.mouse ? Math.hypot(dx, dy) > PICK_SLOP : up) {
      pickUp(pending.key, e.pointerId, e);
    } else if (!pending.mouse && Math.abs(dx) > PULL_UP && Math.abs(dx) * PULL_ANGLE > -dy) {
      clearTimeout(pending.timer); // a sideways swipe: the row scrolls
      pending = null;
    }
    return;
  }
  if (drag) {
    if (e.pointerId !== drag.id) return;
    if (drag.drawer) {
      // the drawer follows the handle, between closed and open
      const h = drawer.offsetHeight, dy = e.clientY - drag.y0;
      if (Math.abs(dy) > PICK_SLOP) drag.moved = true;
      const y = Math.min(h, Math.max(0, (drag.open ? 0 : h) + dy));
      drawer.style.transform = `translate(-50%, ${y}px)`;
      drag.dy = dy;
    } else if (drag.carry) carry(e);
    else placed[drag.key].piece.move(placed[drag.key].piece.toStage(e), e);
    return;
  }
  // hovering: every piece feels the pointer pass (the curtain parts, the cord sways)
  for (const { piece } of Object.values(placed)) piece.move(piece.toStage(e), e);
  room.classList.toggle("can-grab", !e.target.closest(".drawer") && !!pick(e));
});

const release = (e) => {
  fingers.delete(e.pointerId);
  if (pending && e.pointerId === pending.id) {
    clearTimeout(pending.timer);
    pending = null;
  }
  if (!drag || e.pointerId !== drag.id) return;
  const { key } = drag;
  room.classList.remove("grabbing");
  if (drag.drawer) {
    // a tap toggles it; a pull opens or closes it by its direction
    drawer.classList.remove("dragging");
    drawer.style.transform = "";
    setDrawer(drag.moved ? drag.dy < 0 : !drag.open);
    drag = null;
    return;
  }
  if (!drag.carry) placed[key].piece.up(e);
  else if (placed[key].away) {
    remove(key);
    playSound("pop");
  } else if (drag.moved) {
    playSound("thud");
    // a rolling piece keeps rolling, unless the hand had stopped
    const still = e.timeStamp - (drag.t ?? 0) > 80;
    if (PIECES[key].module.ROLLS && !still) {
      placed[key].vx = Math.max(-ROLL_MAX * metre, Math.min(ROLL_MAX * metre, drag.vx ?? 0));
    }
  }
  drag = null;
  save();
};
room.addEventListener("pointerup", release);
room.addEventListener("pointercancel", release);
room.addEventListener("pointerleave", () => {
  for (const { piece } of Object.values(placed)) piece.leave();
});

// Once a card is picked up by a finger, the row must not start scrolling under it.
cardsEl.addEventListener("touchmove", (e) => { if (drag) e.preventDefault(); }, { passive: false });

// The handle is a button, so the keyboard can open and close the drawer too.
handle.addEventListener("click", (e) => { if (e.detail === 0) setDrawer(!drawerOpen); });

// --- Sound -------------------------------------------------------------------------------

// On by default, silent until the first gesture. The speaker in the nav mutes it
// (localStorage.sound = "off").
unlockOnGesture();
const soundButton = document.getElementById("sound");
const showSound = () => {
  const on = soundEnabled();
  soundButton.setAttribute("aria-pressed", String(!on));
  soundButton.setAttribute("aria-label", on ? "Mute sound" : "Unmute sound");
};
soundButton.addEventListener("click", () => {
  setSoundEnabled(!soundEnabled());
  showSound();
});
showSound();

// --- Start -------------------------------------------------------------------------------

layout();
try {
  const stored = JSON.parse(localStorage.getItem(STORE)) || START;
  for (const [key, v] of Object.entries(stored)) {
    if (!PIECES[key] || !Number.isFinite(v?.x) || !Number.isFinite(v?.y)) continue;
    const at = fromStored(key, v);
    const p = add(key, at.x, at.y);
    Object.assign(p, constrain(key, p.x, p.y));
  }
} catch {}
fitPreviews();

// A first visit (nothing saved yet) opens the drawer once, after a beat, so it's found.
try {
  if (!localStorage.getItem(STORE) && !localStorage.getItem(SEEN)) {
    localStorage.setItem(SEEN, "1");
    setTimeout(() => { if (!drag && !pending) setDrawer(true); }, FIRST_OPEN);
  }
} catch {}

// Resizing keeps every piece at the same place in the room.
addEventListener("resize", () => {
  const stored = Object.entries(placed).map(([key, p]) => [key, p, toStored(key, p)]);
  layout();
  fitPreviews();
  for (const [key, p, v] of stored) {
    const at = fromStored(key, v);
    Object.assign(p, constrain(key, at.x, at.y));
  }
});

// A rolling piece: carry on at its speed after being let go, slowing with friction, and stop
// softly at a wall. However it moved, its wheels turn by the distance (in its own frame px).
const glide = (key, p, held, dt) => {
  if (held) p.vx = 0;
  else if (p.vx) {
    const slow = (ROLL_FRICTION * metre + ROLL_DRAG * Math.abs(p.vx)) * dt;
    p.vx = Math.abs(p.vx) <= slow ? 0 : p.vx - Math.sign(p.vx) * slow;
    const to = p.x + p.vx * dt, at = constrain(key, to, p.y);
    if (at.x !== to) {
      const speed = Math.abs(p.vx) / metre;
      if (speed > BUMP_SPEED) playSound("bump", { gain: Math.min(1, speed) });
      p.vx = 0;
    }
    p.x = at.x;
  }
  // over the drawer it's carried, not rolled
  if (!p.away) p.piece.roll((p.x - p.rolledTo) / scaleOf(key), dt);
  p.rolledTo = p.x;
};

// --- Loop --------------------------------------------------------------------------------

let prev = performance.now();
const frame = (now) => {
  const dt = Math.min(0.1, (now - prev) / 1000); // don't spiral after a background tab
  prev = now;
  for (const [key, p] of Object.entries(placed)) {
    const held = drag?.carry && drag.key === key;
    p.lift += ((held ? 1 : 0) - p.lift) * (1 - Math.exp(-LIFT_RATE * dt));
    if (PIECES[key].module.ROLLS) glide(key, p, held, dt);
    p.piece.step(dt);
    render(key, p);
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
