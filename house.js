// The house: one piece at a time, full screen and live, on its own background colour.
// ← → (or the arrows) turn to the previous / next piece, wrapping around; the hash names the
// piece (#lamp, #curtain, …) so links and reloads open it. Each piece is mounted through its
// module API (see lamp/lamp.js); the page owns the listeners and the loop.

import * as lamp from "./lamp/lamp.js";
import * as curtain from "./curtain/curtain.js";
import * as chair from "./chair/chair.js";
import * as clock from "./clock/clock.js";
import * as table from "./table/table.js";
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
  { key: "lamp", module: lamp, glyph: "灯", meaning: "Lamp", bg: "#c8c0f0", night: "#1d1934",
    mount: (el) => lamp.mount(el, lamp.TABLE_LAMP, { onToggle: toggleTheme }) },
  { key: "curtain", module: curtain, glyph: "帘", meaning: "Curtain", bg: "#a9dcc6", night: "#193428" },
  { key: "chair", module: chair, glyph: "椅", meaning: "Chair", bg: "#9cd6dc", night: "#193134" },
  { key: "clock", module: clock, glyph: "钟", meaning: "Clock", bg: "#f6dc8c", night: "#342d19" },
  { key: "table", module: table, glyph: "轮", meaning: "Wheel", bg: "#c5dfa0", night: "#293419" },
  { key: "pram", module: pram, glyph: "轮", meaning: "Wheel", bg: "#b4d2f0", night: "#192634" },
];

// --- DOM ---------------------------------------------------------------------------------

const stage = document.getElementById("stage");
const entry = document.getElementById("entry");

let index = -1, piece = null;

const ROOM_FOR_TEXT = 96; // px of height kept for the nav above and the entry below
const fit = () => {
  if (!piece) return;
  const scale = Math.min(innerWidth, innerHeight - ROOM_FOR_TEXT) / piece.STAGE;
  stage.style.transform = `scale(${scale}) translate(-50%, -50%)`;
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
  const { key, module: m, glyph, meaning } = PIECES[i];
  piece?.destroy();
  stage.className = "stage";
  stage.style.width = stage.style.height = `${m.STAGE}px`;
  piece = (PIECES[i].mount ?? m.mount)(stage);
  fit();
  paint();
  entry.querySelector(".glyph").textContent = glyph;
  entry.querySelector(".meaning").textContent = meaning;
  document.title = `${glyph} ${meaning} · Character House`;
  history.replaceState(null, "", `#${key}`);
};

const fromHash = () => Math.max(0, PIECES.findIndex((p) => `#${p.key}` === location.hash));

// --- Input -------------------------------------------------------------------------------

stage.addEventListener("pointerdown", (e) => {
  if (piece.down(piece.toStage(e), e)) stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => piece.move(piece.toStage(e), e));
stage.addEventListener("pointerup", (e) => piece.up(e));
stage.addEventListener("pointercancel", (e) => piece.up(e));
stage.addEventListener("pointerleave", () => piece.leave());

document.getElementById("prev").addEventListener("click", () => show(index - 1));
document.getElementById("next").addEventListener("click", () => show(index + 1));
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") show(index - 1);
  if (e.key === "ArrowRight") show(index + 1);
});
addEventListener("hashchange", () => show(fromHash()));

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
