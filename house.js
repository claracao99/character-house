// The house: one piece at a time, full screen and live, on its own background colour.
// ← → (or the arrows) turn to the previous / next piece, wrapping around; the hash names the
// piece (#lamp, #curtain, …) so links and reloads open it. Each piece is mounted through its
// module API (see lamp/lamp.js); the page owns the listeners and the loop.

import * as lamp from "./lamp/lamp.js";
import * as curtain from "./curtain/curtain.js";
import * as chair from "./chair/chair.js";
import * as clock from "./clock/clock.js";
import * as pram from "./pram/pram.js";
import { playSound, unlockOnGesture, soundEnabled, setSoundEnabled } from "./sound.js";

// Pulling the lamp's cord switches it on and off: dark (on) or light (off), for the whole
// house. The theme lives on <html> and in localStorage; a script in index.html's <head>
// restores it before the first paint.
const THEME = "character-house-theme";
const isDark = () => document.documentElement.dataset.theme === "dark";
const toggleTheme = () => {
  const dark = !isDark();
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME, dark ? "dark" : "light"); } catch {}
  paint();
  playSound("tap");
};

// In order. The English word is the character's meaning; `bg` is the piece's own colour,
// complementary to it, picked by eye, and `night` the same hue in the dark.
const PIECES = [
  { key: "lamp", module: lamp, glyph: "灯", pinyin: "dēng", meaning: "Lamp", bg: "#c8c0f0", night: "#1d1934",
    mount: (el) => lamp.mount(el, lamp.TABLE_LAMP, { onToggle: toggleTheme }) },
  { key: "curtain", module: curtain, glyph: "帘", pinyin: "lián", meaning: "Curtain", bg: "#a9dcc6", night: "#193428" },
  { key: "chair", module: chair, glyph: "椅", pinyin: "yǐ", meaning: "Chair", bg: "#9cd6dc", night: "#193134" },
  { key: "clock", module: clock, glyph: "钟", pinyin: "zhōng", meaning: "Clock", bg: "#f6dc8c", night: "#342d19" },
  { key: "pram", module: pram, glyph: "轮", pinyin: "lún", meaning: "Wheel", bg: "#b4d2f0", night: "#192634" },
];

// --- DOM ---------------------------------------------------------------------------------

const stage = document.getElementById("stage");
const entry = document.getElementById("entry");

let index = -1, piece = null;

// The piece's frame fits the space between the nav and the entry, and the art itself (its
// opaque box, BOUNDS, which sits anywhere in the frame) is centred in that space, so every
// piece looks balanced over its entry rather than wherever its frame puts it. A piece can
// name its own horizontal centre instead (CENTRE_X: the pram's is between its wheels, the
// chair's where it sits at rest).
const NAV_CLEAR = 72; // px kept at the top for the nav
const ENTRY_GAP = 32; // px between the piece and its entry
const fit = () => {
  if (!piece) return;
  const S = piece.STAGE;
  const m = PIECES[index].module;
  const b = m.BOUNDS ?? { x0: 0, y0: 0, x1: S, y1: S };
  const cx = m.CENTRE_X ?? (b.x0 + b.x1) / 2;
  const top = NAV_CLEAR, bottom = entry.getBoundingClientRect().top - ENTRY_GAP;
  const scale = Math.min(innerWidth, bottom - top) / S;
  const x = innerWidth / 2 - scale * cx;
  const y = (top + bottom) / 2 - (scale * (b.y0 + b.y1)) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
};
addEventListener("resize", fit);

// The page takes the piece's colour for the current theme.
const paint = () => {
  const { bg, night } = PIECES[index];
  document.documentElement.style.setProperty("--bg", isDark() ? night : bg);
};

// Unmount the old piece, mount the new one, and let the background fade across.
const show = (i) => {
  i = (i + PIECES.length) % PIECES.length;
  if (i === index) return;
  index = i;
  const { key, module: m, glyph, pinyin, meaning } = PIECES[i];
  piece?.destroy();
  stage.className = "stage";
  stage.style.width = stage.style.height = `${m.STAGE}px`;
  piece = (PIECES[i].mount ?? m.mount)(stage);
  paint();
  entry.querySelector(".hanzi").textContent = glyph;
  entry.querySelector(".pinyin").textContent = pinyin;
  entry.querySelector(".meaning").textContent = meaning;
  fit(); // after the entry, which it's measured against
  document.title = `${glyph} ${meaning}`;
  history.replaceState(null, "", `#${key}`);
};

const fromHash = () => Math.max(0, PIECES.findIndex((p) => `#${p.key}` === location.hash));

// --- Input -------------------------------------------------------------------------------

// The piece listens to the whole page, not just its stage's box: a piece can leave its frame
// (the pram rolls out to the screen's edges) and must stay as easy to take hold of there.
// The nav and the turn strips keep their own clicks.
const onChrome = (e) => !!e.target.closest?.(".nav, .turn");
const held = (e) => stage.hasPointerCapture(e.pointerId);
addEventListener("pointerdown", (e) => {
  if (onChrome(e)) return;
  if (piece.down(piece.toStage(e), e)) stage.setPointerCapture(e.pointerId);
});
addEventListener("pointermove", (e) => {
  if (onChrome(e) && !held(e)) piece.leave(); // over a strip, as if the pointer had left
  else piece.move(piece.toStage(e), e);
});
addEventListener("pointerup", (e) => piece.up(e));
addEventListener("pointercancel", (e) => piece.up(e));
document.documentElement.addEventListener("pointerleave", () => piece.leave());

document.getElementById("prev").addEventListener("click", () => show(index - 1));
document.getElementById("next").addEventListener("click", () => show(index + 1));
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") show(index - 1);
  if (e.key === "ArrowRight") show(index + 1);
});
addEventListener("hashchange", () => show(fromHash()));

// On a desktop the turn strips reach in past the end of the name (style.css).
const nameEl = document.querySelector(".nav a");
const NAME_GAP = 24; // px past the end of the name, as far as the name sits from the edge
const measureTurns = () => document.documentElement.style.setProperty(
  "--turn-w", `${Math.round(nameEl.getBoundingClientRect().right + NAME_GAP)}px`);
measureTurns();
addEventListener("resize", measureTurns);
document.fonts?.ready.then(measureTurns);

// --- Sound -------------------------------------------------------------------------------

// On by default, silent until the first gesture. The speaker in the nav mutes it
// (localStorage.sound = "off").
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

unlockOnGesture();
show(fromHash());

let prev = performance.now();
const frame = (now) => {
  piece.step(Math.min(0.1, (now - prev) / 1000)); // don't spiral after a background tab
  prev = now;
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
