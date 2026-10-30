# Character House

A house of physical furniture made from characters. Each piece is a small,
tactile toy where the physics is the control (the lamp's cord of 灯 is a rope
you pull to switch it).

One page (`index.html`, `house.js`, `style.css`): one piece at a time, full screen and
live, on its own background colour, with ← → to turn the page. `#lamp`, `#curtain`,
`#chair`, `#clock`, `#pram` open a piece; each piece folder's `index.html` redirects there.

Under each piece is its dictionary entry: the pinyin, the character in a calligraphy
practice square (米字格, coral), and the English meaning. The piece's art (its `BOUNDS`) is
centred in the space between the nav and the entry, so it sits balanced over it.

The lamp's cord switches the theme for the whole house (dark = lamp on): each piece's
background turns to a night version of its colour, and the deep-blue characters turn light
blue. The theme persists in localStorage (`character-house-theme`).

Pieces:

- One folder per piece of furniture (`lamp/`, `curtain/`, `chair/`, `clock/`,
  `pram/`), plain HTML/JS, no build.
- Each piece lives in `<piece>/<piece>.js` as `mount(stage)` (scoped styles in
  `<piece>.css`), returning `{ STAGE, toStage, hit, down, move, up, leave,
  step, destroy }`, which `house.js` mounts.
- Add a new piece to `PIECES` in `house.js`, with its `pinyin`, a `bg` and a `night`
  colour, and export the art's opaque box as `BOUNDS` so it can be centred.

Sound: `sound.js`, synthesised with Web Audio (no files), every pitch in D
major; on by default, muted with `localStorage.sound = "off"` (the speaker in
the nav).

Serve the whole house: `python3 serve.py` (port 5180, no caching), then open
http://localhost:5180.

The table lamp is also ported into the portfolio (`portfolio/src/lib/lamp.ts`)
as the dark-mode switch.

Conventions for new pieces:

- Simplified Chinese only (帘, not 簾). The English word next to a character is
  the character's meaning, like a dictionary (轮 Wheel, not "Table").
- Art is a flat, one-colour cut-paper silhouette, 2048² with a transparent
  background, generated without the moving parts (those are characters in
  code). Snap the fill to the exact palette hex, keeping the alpha:
  `ffmpeg -i in.png -vf "format=rgba,geq=r=R:g=G:b=B:a='alpha(X,Y)'" out.png`.
  Check transparent art on a light background: on black it looks like it glows.
- Palette: light blue #94ADD7, deep blue #4565AD (characters), pink #EDB5C1,
  coral #E0694C; the lamps stay yellow. A piece whose body is close to deep
  blue gets its own character colour (the clock's is coral).
- Calm: heavy damping, quiet sounds, no extra UI.
