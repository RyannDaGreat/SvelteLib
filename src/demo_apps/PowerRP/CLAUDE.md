# PowerRP (V1)

A PowerPoint-like presentation/figure editor that is ALSO headlessly
CLI-renderable. Full institutional memory (requirements, research, lessons)
lives in the PowerRP dump's `claude_instructions.md` + `concerns.md` (outside
this repo); this file covers what a contributor to THIS directory must know.

## The core invariant

RenderTree = pure(document, [[slide, alpha]]).

A serialized document is `{meta, slides: [{id, name, transition, delta, ...}]}`
with no separate item table; slide 0's delta creates everything. `transition`
is `{type, seconds, curve, sound}` and supersedes legacy `duration`, which the
repair pipeline migrates loudly. Slides may also carry `enabled` and
`autoAdvance`. Folding slide deltas yields `{items, vars}`. Tween alpha applies
a delta partially (numbers lerp from the CURRENT folded value — lazy start
capture; discrete values switch at alpha > 0). Slides have permanent UUIDs;
displayed numbers shift on insert. An item appearing across slides IS the
"symlink". `active: false` (universal property) is how items exist on some
slides and not others — Delete keyframes it; Purge actually removes.

## Layout

- `core/` — DOM-free pure JS (MUST run in bare node; tests enforce this).
  deltas, interpolators, similarity transform (NO skew, parametric
  {x,y,rotation,scale}), geometry (infinite-guide clipping), document model,
  derive (state → render tree; anchors; hit tests), snap solver, shortcut
  registry, command registry, undo, presentation playback.
- `plugins/` — one file per widget type. Declarative: capabilities,
  defaults, inspector rows, emit(state) → display-list commands, anchors,
  snapFeatures, editPoints, commands. **No plugin may import another
  plugin** — composition happens through capabilities and document state.
- `render_gpu/` — the display-list renderer family. The runtime raster backend is
  SKIA/CanvasKit on WebGL2, NOT WebGPU: `skia/browser_surface.js` does
  `GetWebGLContext` → `MakeWebGLContext` → `MakeOnScreenGLSurface`, deliberately
  avoiding `navigator.gpu` so the app works on plain HTTP (WebGPU needs a secure
  context; only the videoV8 experiments touch it). `pdf_backend.js` and
  `svg_backend.js` are the hybrid vector exporters. Canvas2D remains an internal
  glyph/media/readback helper, not a scene-renderer backend. `ir.js` builds the
  device-independent display list; `ports.js` walks a derived tree through plugin
  `emit()` AND applies the universal effects there; `skia/paint_skia.js` is THE
  painter; `gpu/` is NOT a compositor — it holds asset rasterizers and registries
  (glyph atlas, image/video registries, latex/mermaid/pdf/svg raster).
- `core/view.js` — view math (fitRectView = THE camera mapping,
  worldViewRect) + the culling protocol (canSkipNode).
- `web/` — Svelte 5 app shell. App components carry NO <style> blocks; all
  styling in `app.css` via `--a-*` tokens (annotator convention).
  gpuService.js = shared offscreen compositor for pixel consumers
  (thumbnails, minimap, PNG export).
- `cli/render.js` — headless PNG renderer. It runs in BARE NODE (its own header
  says "no browser, no Vite, no puppeteer") and rasterizes on a SOFTWARE Skia
  surface: `render_gpu/skia/node_render.js` calls `CanvasKit.MakeSurface`, and
  node has no GL context. It shares the display list, `paint_skia.js` and the
  plugin `emit()` path with the editor, but NOT the GPU. Consequence: heavy
  per-pixel SkSL materials cost ~0.28 ms/px there, so a material-laden slide can
  take minutes headlessly even though the editor draws it at 60fps on the GPU.
- `examples/make_demo.js` — a legacy worked example, not a safe canonical
  fixture regenerator; it still emits legacy rich-text/magnifier fields. Any
  regenerated fixture must pass `repairedDocument()` with zero repair reports.
- `tests/` and `render_gpu/tests/` — node suites, Vite/Puppeteer browser probes,
  Python server tests, GPU tests, and PDF/SVG parity gates. Existing green
  suites do not cover the five frozen-baseline defects recorded in the dump's
  Round 18 manifest.

## Command architecture

The command registry is the single action layer. The palette (Cmd+Shift+P),
keyboard shortcuts, toolbar buttons, and future context menus are all just
surfacings of the same entries. The shortcut registry is the single source of
truth for inputs: it BOTH dispatches keydowns AND feeds the bottom HintBar —
a shortcut that isn't registered there does not exist.

## Running

- Editor + project backend: `bash src/demo_apps/PowerRP/run_server.sh`, then use
  the printed browser URL. The launcher uses trusted HTTPS when host TLS is
  available because WebGPU is unavailable on non-loopback HTTP origins. Raw
  Vite alone is frontend-only.
- Core tests: `node src/demo_apps/PowerRP/tests/core_test.js`
- Server lifecycle: `bash src/demo_apps/PowerRP/tests/server_launcher_test.sh`
- Editor smoke: `node src/demo_apps/PowerRP/tests/editor_smoke.js <shot_dir>`
- CLI render: `node src/demo_apps/PowerRP/cli/render.js <doc.json> <out.png>
  [--slide N] [--alpha A] [--width W] [--height H]`

## Known bounds (deliberate)

Multi-selection, box selection, drag-all/multi-resize, alignment, and grouping
exist; the heterogeneous multi-selection Inspector intersection remains
unbuilt. Groups are flat-membership derivation parents, not nested object trees
or compositing subtrees, and retain the five Round 18 frozen-baseline defects.
The video player exists; the deterministic video scrubber and replicators do
not. Z-order UI = bisect then document-wide normalize (core/document.js). THE
CAMERA is built and mandatory (exactly one, `purgeable:false`, owns the
background and every view). Presentations are UNCAPPED — no frame caps exist
(`meta.fps` is dead; one frame per rAF tick).
