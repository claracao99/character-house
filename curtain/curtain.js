// Bead curtain made of characters, simulated with XPBD (extended position-based dynamics).
//
// Strands of 帘 hang from the rod across the doorway. Each strand is a chain of slightly
// elastic links pinned at the rod, like the lamp's cord. The pointer is a soft round body
// moving through them: strands part around it, brush their neighbours, then sway back and
// settle. Characters can also be grabbed and dragged. All units are design-frame pixels (2048²).
//
// mount(stage) draws one curtain into a 2048² element and returns its controls; the page (or
// the room) owns the pointer listeners and the animation loop. See main.js.

import { playSound, BEAD_PITCHES } from "../sound.js";

export const STAGE = 2048;
const CHAR = "帘";
const SEG = 64; // one character per link (64px font, 64px line-height)
export const IMAGE = new URL("assets/curtain.png", import.meta.url).href;

// --- Door frame, measured from the image's alpha ------------------------------------------

const ROD_Y = 316; // rod spans y 271–326 in the opening; strands hang from just above its lower edge
const OPEN_X0 = 704; // inner edge of the left post
const OPEN_X1 = 1345; // inner edge of the right post

const STRANDS = 9; // ~71px apart, a little more than one character
const LENGTH = 18; // characters per strand; ends around knee height (posts end at 1795)

// Where the posts meet the floor, and the opaque box of the art (for placing it in a room).
export const FOOT = { x: 1024, y: 1795 };
export const BOUNDS = { x0: 457, y0: 253, x1: 1591, y1: 1795 };

// --- Tuning ------------------------------------------------------------------------------

const STEP = 1 / 120;
const SUBSTEPS = 10;
const GRAVITY = 3900; // the lamp's 2400 scaled to the bigger frame
const AIR_DRAG = 4; // 1/s
const RADIUS = 26; // collision radius of a character

const LINK_COMPLIANCE = 1e-6; // strands barely stretch
const LINK_DAMPING = 0.05; // per substep, along each link
const BEND_COMPLIANCE = 2e-4; // strands curve softly rather than fold
const MIN_GAP = 58; // characters on a strand never overlap

const STRAND_GAP = 62; // side by side, neighbouring strands keep at least this far apart
const STRAND_REACH = 52; // ...whenever their characters are within this of each other vertically
const STRAND_COMPLIANCE = 2e-7; // firm enough that glyphs never sit on top of each other

const HAND_RADIUS = 90; // the pointer as a round body moving through the curtain
const HAND_PUSH = 90000; // px/s² at its centre, fading to 0 at the edge
const HAND_CARRY = 6; // 1/s, how strongly strands are dragged along with its motion
const HAND_SPEED_MAX = 2500; // ignore flicks faster than this

const GRAB_COMPLIANCE = 1e-4; // softness of the hand when holding a character
const HIT_RADIUS = 34;

const CLICK_SPEED = 260; // px/s: strands brushing slower than this are silent
const CLICK_FULL = 1600; // ...and click at full volume from this

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

// Is the image opaque at p, or within `pad` of it (thin posts are easier to catch)?
const opaque = (alpha, size, p, pad = 0) =>
  !!alpha && [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad]].some(([dx, dy]) => {
    const x = Math.round(p.x + dx), y = Math.round(p.y + dy);
    return x >= 0 && y >= 0 && x < size && y < size && alpha[y * size + x] > 128;
  });

export function mount(stage) {
  // --- DOM -------------------------------------------------------------------------------

  stage.classList.add("piece-curtain");
  const strandsEl = document.createElement("div");
  strandsEl.className = "strands";
  strandsEl.setAttribute("aria-label", "Bead curtain");
  const img = document.createElement("img");
  img.className = "frame";
  img.src = IMAGE;
  img.alt = "Pink door frame with a curtain rod";
  img.draggable = false;
  stage.append(strandsEl, img);

  const charEls = Array.from({ length: STRANDS }, () =>
    Array.from({ length: LENGTH }, () => {
      const el = document.createElement("span");
      el.className = "char";
      el.textContent = CHAR;
      strandsEl.appendChild(el);
      return el;
    }),
  );

  let mask = null; // image alpha, once decoded
  readAlpha(img, STAGE, (a) => { mask = a; });

  // --- Simulation ------------------------------------------------------------------------

  // strands[s][0] is pinned to the rod; strands[s][i + 1] is the bottom of character i.
  const pitch = (OPEN_X1 - OPEN_X0) / STRANDS;
  const strands = Array.from({ length: STRANDS }, (_, s) => {
    const x = OPEN_X0 + pitch * (s + 0.5);
    return Array.from({ length: LENGTH + 1 }, (_, i) => ({
      x, y: ROD_Y + i * SEG, px: 0, py: 0, vx: 0, vy: 0,
      w: i === 0 ? 0 : 1, // inverse mass; the pin doesn't move
    }));
  });

  const grab = { node: null, ox: 0, oy: 0, tx: 0, ty: 0 };

  // The pointer body: eased from where it was last frame to where it is now, across the steps.
  const hand = { on: false, x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0, tx: 0, ty: 0 };

  let impact = 0; // fastest knock between neighbouring strands since the last frame

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
    if (mode === "min" && (Math.abs(dx) >= rest || Math.abs(dy) >= rest)) return; // cheap reject
    const len = Math.hypot(dx, dy) || 1e-6;
    const delta = len - rest;
    if ((mode === "max" && delta <= 0) || (mode === "min" && delta >= 0)) return;
    if (a.w + b.w === 0) return;
    separate(a, b, dx, dy, len, delta, alpha);
  };

  // posts on either side, nothing above the rod
  const collide = (n) => {
    n.x = Math.min(OPEN_X1 - RADIUS, Math.max(OPEN_X0 + RADIUS, n.x));
    n.y = Math.min(STAGE - RADIUS, Math.max(ROD_Y + RADIUS, n.y));
  };

  const substep = (h) => {
    const ih2 = 1 / (h * h);

    // integrate: gravity and drag, plus the pointer's push and pull on anything inside it
    const drag = 1 - AIR_DRAG * h;
    for (const strand of strands) {
      for (let i = 1; i < strand.length; i++) {
        const n = strand[i];
        n.vx *= drag;
        n.vy = (n.vy + GRAVITY * h) * drag;
        if (hand.on && n !== grab.node) {
          const dx = n.x - hand.x, dy = n.y - hand.y;
          const d = Math.hypot(dx, dy);
          if (d < HAND_RADIUS && d > 1e-3) {
            const f = 1 - d / HAND_RADIUS;
            n.vx += ((dx / d) * HAND_PUSH * f + (hand.vx - n.vx) * HAND_CARRY * f) * h;
            n.vy += ((dy / d) * HAND_PUSH * f + (hand.vy - n.vy) * HAND_CARRY * f) * h;
          }
        }
      }
      for (const n of strand) {
        n.px = n.x; n.py = n.y;
        n.x += n.vx * h;
        n.y += n.vy * h;
      }
    }

    // hand holding a character
    if (grab.node) {
      const n = grab.node;
      const k = n.w / (n.w + GRAB_COMPLIANCE * ih2);
      n.x += (grab.tx + grab.ox - n.x) * k;
      n.y += (grab.ty + grab.oy - n.y) * k;
    }

    for (const strand of strands) {
      // links: barely elastic
      for (let i = 0; i < LENGTH; i++) distance(strand[i], strand[i + 1], SEG, LINK_COMPLIANCE * ih2);

      // bending: every second node is softly pulled toward a straight line
      for (let i = 0; i + 2 < strand.length; i++) {
        distance(strand[i], strand[i + 2], 2 * SEG, BEND_COMPLIANCE * ih2);
      }

      // no overlapping characters
      for (let i = 0; i < strand.length; i++) {
        for (let j = i + 2; j < strand.length; j++) distance(strand[i], strand[j], MIN_GAP, 0, "min");
      }
    }

    // neighbouring strands (and the next one over, once they bunch up) brush each other.
    // Characters are square, so this is sideways only and keeps strands in rod order: they
    // stack up flat instead of interleaving, and never swap places.
    const alpha = STRAND_COMPLIANCE * ih2;
    for (let s = 0; s < STRANDS; s++) {
      for (let t = s + 1; t <= s + 2 && t < STRANDS; t++) {
        const gap = STRAND_GAP * (t - s);
        for (const a of strands[s]) {
          if (!a.w) continue;
          for (const b of strands[t]) {
            if (!b.w || Math.abs(b.y - a.y) > STRAND_REACH) continue;
            const delta = b.x - a.x - gap;
            if (delta >= 0) continue;
            impact = Math.max(impact, Math.abs(a.vx - b.vx)); // for the beads' click
            const d = delta / (a.w + b.w + alpha);
            a.x += a.w * d;
            b.x -= b.w * d;
          }
        }
      }
    }

    for (const strand of strands) for (let i = 1; i < strand.length; i++) collide(strand[i]);

    // velocities from positions, then damp motion along each link
    for (const strand of strands) {
      for (const n of strand) {
        n.vx = (n.x - n.px) / h;
        n.vy = (n.y - n.py) / h;
      }
      for (let i = 0; i < LENGTH; i++) {
        const a = strand[i], b = strand[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-6;
        const imp = (((b.vx - a.vx) * dx + (b.vy - a.vy) * dy) / len) * LINK_DAMPING / (a.w + b.w) / len;
        a.vx += a.w * imp * dx; a.vy += a.w * imp * dy;
        b.vx -= b.w * imp * dx; b.vy -= b.w * imp * dy;
      }
    }
  };

  // --- Rendering -------------------------------------------------------------------------

  const place = (el, x, y, deg) => {
    el.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg)`;
  };

  const render = () => {
    for (let s = 0; s < STRANDS; s++) {
      const strand = strands[s];
      for (let i = 0; i < LENGTH; i++) {
        const a = strand[i], b = strand[i + 1];
        const deg = (-Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
        place(charEls[s][i], (a.x + b.x) / 2, (a.y + b.y) / 2, deg);
      }
    }
  };

  // --- Input -----------------------------------------------------------------------------

  // Pointer -> design frame, from the stage's rendered size (whatever scales it).
  const toStage = (e) => {
    const r = stage.getBoundingClientRect();
    const s = r.width / STAGE;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  // A character grabs its lower node. `pad` widens the reach, for when the curtain is drawn small.
  const hitTest = (p, pad = 0) => {
    let best = null, bestD = HIT_RADIUS + pad;
    for (const strand of strands) {
      for (let i = 0; i < LENGTH; i++) {
        const a = strand[i], b = strand[i + 1];
        const d = Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2);
        if (d < bestD) { bestD = d; best = b; }
      }
    }
    return best;
  };

  // Characters, or the doorway they hang in (a finger there sweeps through the strands), are
  // the curtain itself; the frame is what carries it.
  const hit = (p, pad = 0) => {
    if (hitTest(p, pad)) return "physics";
    let bottom = ROD_Y;
    for (const strand of strands) bottom = Math.max(bottom, strand[LENGTH].y);
    if (p.x > OPEN_X0 && p.x < OPEN_X1 && p.y > ROD_Y && p.y < bottom + SEG / 2) return "physics";
    return opaque(mask, STAGE, p, pad / 2) ? "body" : null;
  };

  // Hovering (mouse) or a finger down off a character moves the body through the curtain.
  const moveHand = (p) => {
    if (!hand.on) Object.assign(hand, { x: p.x, y: p.y, fx: p.x, fy: p.y, vx: 0, vy: 0 });
    hand.on = true;
    hand.tx = p.x; hand.ty = p.y;
  };

  const down = (p, e, pad) => {
    const node = e.pointerType === "mouse" || e.isPrimary ? hitTest(p, pad) : null;
    if (node) {
      Object.assign(grab, { node, ox: node.x - p.x, oy: node.y - p.y, tx: p.x, ty: p.y });
      hand.on = false;
      stage.classList.add("grabbing");
    } else {
      moveHand(p);
    }
    return true;
  };

  const move = (p, e) => {
    if (grab.node) {
      grab.tx = p.x; grab.ty = p.y;
      return;
    }
    // touch only parts the curtain while the finger is down
    if (e.pointerType !== "mouse" && !e.buttons) return;
    stage.classList.toggle("can-grab", !!hitTest(p));
    moveHand(p);
  };

  const up = (e) => {
    grab.node = null;
    stage.classList.remove("grabbing");
    if (e.pointerType !== "mouse") hand.on = false;
  };

  const leave = () => { hand.on = false; };

  // --- Loop ------------------------------------------------------------------------------

  let acc = 0;
  const step = (dt) => {
    // this frame the body travels from where it was to where the pointer is now
    const steps = Math.floor((acc + dt) / STEP);
    if (hand.on && dt > 0) {
      hand.fx = hand.x; hand.fy = hand.y;
      const vx = (hand.tx - hand.fx) / dt, vy = (hand.ty - hand.fy) / dt;
      const k = Math.min(1, HAND_SPEED_MAX / (Math.hypot(vx, vy) || 1));
      hand.vx = vx * k; hand.vy = vy * k;
    }

    let k = 0;
    for (acc += dt; acc >= STEP; acc -= STEP) {
      k++;
      if (hand.on) {
        hand.x = hand.fx + (hand.tx - hand.fx) * (k / steps);
        hand.y = hand.fy + (hand.ty - hand.fy) * (k / steps);
      }
      for (let s = 0; s < SUBSTEPS; s++) substep(STEP / SUBSTEPS);
    }
    render();

    // the hardest knock this frame clicks, softly, on a D-major note
    if (impact > CLICK_SPEED) {
      const gain = Math.min(1, (impact - CLICK_SPEED) / (CLICK_FULL - CLICK_SPEED));
      const pitch = BEAD_PITCHES[Math.floor(Math.random() * BEAD_PITCHES.length)];
      playSound("bead", { gain: 0.3 + 0.7 * gain, pitch });
    }
    impact = 0;
  };
  render();

  const destroy = () => {
    stage.replaceChildren();
    stage.classList.remove("piece-curtain", "can-grab", "grabbing");
  };

  return { STAGE, toStage, hit, down, move, up, leave, step, destroy };
}
