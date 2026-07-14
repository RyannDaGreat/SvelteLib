# PowerRP (V1)

A PowerPoint-like presentation/figure editor that is ALSO headlessly
CLI-renderable. Full institutional memory (requirements, research, lessons)
lives in the PowerRP dump's `claude_instructions.md` + `concerns.md` (outside
this repo); this file covers what a contributor to THIS directory must know.

## The core invariant

RenderTree = pure(document, [[slide, alpha]]).

A document is ONLY `{meta, slides: [{id, name, duration, delta}]}` — no item
table; slide 0's delta creates everything. Slide N's state = fold of deltas
0..N over `{}`. Tween alpha applies a delta partially (numbers lerp from the
CURRENT folded value — lazy start capture; discrete values switch at
alpha > 0). Slides have permanent UUIDs; displayed numbers shift on insert.
An item appearing across slides IS the "symlink". `active: false` (universal
property) is how items exist on some slides and not others — Delete keyframes
it; Purge actually removes.

## Layout

- `core/` — DOM-free pure JS (MUST run in bare node; tests enforce this).
  deltas, interpolators, similarity transform (NO skew, parametric
  {x,y,rotation,scale}), geometry (infinite-guide clipping), document model,
  derive (state → render tree; anchors; hit tests), snap solver, shortcut
  registry, command registry, undo, presentation playback.
- `plugins/` — one file per widget type. Declarative: capabilities,
  defaults, inspector rows, paint(ctx, state, env), anchors, snapFeatures,
  editPoints, commands. **No plugin may import another plugin** — composition
  happens through capabilities and document state only.
- `render/compositor.js` — bottom-up z-order painter shared by editor,
  presenter, and CLI. Backdrop-sampling widgets (magnifier, blur) receive the
  composite-so-far snapshot via env.backdrop.
- `web/` — Svelte 5 app shell. App components carry NO <style> blocks; all
  styling in `app.css` via `--a-*` tokens (annotator convention).
- `cli/render.js` — headless PNG renderer (programmatic Vite + puppeteer,
  same compositor as the editor).
- `examples/make_demo.js` — builds `demo.powerrp.json` via the core API.
- `tests/` — `core_test.js` (node assert, no framework) and
  `editor_smoke.js` (puppeteer boot + drag/palette/slide interactions with
  mid-drag invariants).

## Command architecture

The command registry is the single action layer. The palette (Cmd+Shift+P),
keyboard shortcuts, toolbar buttons, and future context menus are all just
surfacings of the same entries. The shortcut registry is the single source of
truth for inputs: it BOTH dispatches keydowns AND feeds the bottom HintBar —
a shortcut that isn't registered there does not exist.

## Running

- Editor: `npx vite --config src/demo_apps/PowerRP/web/vite.config.js` (port 3637)
- Core tests: `node src/demo_apps/PowerRP/tests/core_test.js`
- Editor smoke: `node src/demo_apps/PowerRP/tests/editor_smoke.js <shot_dir>`
- CLI render: `node src/demo_apps/PowerRP/cli/render.js <doc.json> <out.png>
  [--slide N] [--alpha A] [--width W] [--height H]`

## V1 known bounds (deliberate)

Single selection only; no parent widgets/replicators yet (the derivation
stage in core/derive.js is where they will land — see the dump manifest's
design bounds before touching it); no video widgets; no camera (backburner);
z-order UI = bisect then document-wide normalize (core/document.js).
