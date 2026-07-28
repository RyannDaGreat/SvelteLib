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
- `cli/render.js` — single-STILL renderer, and ONLY that. It runs in BARE NODE
  ("no browser, no Vite, no puppeteer") on a SOFTWARE Skia surface
  (`node_render.js` calls `CanvasKit.MakeSurface`; node has no GL context), so it
  shares the display list, `paint_skia.js` and plugin `emit()` with the editor but
  NOT the GPU — and it cannot draw image/video/PDF/filmstrip (no
  `createImageBitmap`), LaTeX (MathJax needs a DOM), Mermaid (font load) or motion
  blur. It counts those omissions and REPORTS them loudly, because it used to
  produce holed pictures while exiting 0. Kept because it is the one renderer with
  no system dependency beyond node: ~0.10 s for a light 1080p vector slide, no
  Chrome required. It is NOT the video path — see below.
- `cli/render_job.js` + `web/renderJobPage.js` — THE server-side video renderer,
  and the two halves of one worker. Per the user ruling "THE RENDERER IS ONE CODE
  PATH", the node half boots the real editor in headless Chrome and the page half
  produces frames through the editor's own modules (`transitionRender`'s letterbox
  composite, `videoExport`'s `createFrameSampler`, `gpuService`'s WebGL2 Skia
  surface). That is why the backend draws media/LaTeX/Mermaid/motion blur at all,
  and why it gets a GPU where one exists: `browser_surface.js` has no CPU branch,
  so ANGLE picks SwiftShader, Mesa or a real driver underneath. Measured against
  the bare-node worker it replaced: Mandelbrot deck 166 s/frame -> 0.67 s/frame at
  640x360; a 16-widget material deck >600 s -> 6.5 s for one 1080p frame.
  ONE dev server per job, N BROWSERS (not N processes: concurrent Vite servers
  fight the dep optimizer; not N tabs: same-origin tabs share a renderer thread).
  HMR is OFF in that dev server — a code edit mid-render would reload the page and
  kill the job, the same way an unsnapshotted document would corrupt it.
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
- **THE TEST GATE — "passing" means THIS, nothing less** (user ruling, 2026-07-28:
  "For now on passing must always include browser probes, duh."):
  `node src/demo_apps/PowerRP/tests/run_all.mjs`
  That script IS the definition, in four kinds — bare-node `*_test.{js,mjs}`, browser
  `*_probe.{js,mjs}`, python `*_test.py`, shell `*_test.sh` — collected from BOTH
  `tests/` and `render_gpu/tests/`. **`--list` is the authority on how many there
  are; do not quote a number from this file.** A pinned count was wrong twice over:
  it went stale as agents added suites, and it was already too low because the
  collector took `_probe.js` from `tests/` only, leaving three real browser probes in
  `render_gpu/tests/` plus one `.mjs` probe outside the gate entirely. Quoting a
  bare-node-only number is how a whole session went by with five browser probes
  failing at baseline and nobody noticing. A partial number manufactures false
  confidence — which is exactly what a stale one in this file did too. Use
  `--only=node` / `--filter=<substring>` while iterating, never to report.
  The gate STARTS ITS OWN BACKEND on a free port and passes `BACKEND_URL` to the
  browser children, because ~9 of the first sweep's 12 failures were `listAssets:
  500` from nothing listening. Probes do not *listen* on the fixed backend port, but
  each one's self-spun Vite *proxies* to `BACKEND_URL` — so without one they report
  an absent dependency as if the app were broken.
- Core tests only (iterating): `node src/demo_apps/PowerRP/tests/core_test.js`
- Server lifecycle: `bash src/demo_apps/PowerRP/tests/server_launcher_test.sh`
- Editor smoke: `node src/demo_apps/PowerRP/tests/editor_smoke.js <shot_dir>`
- CLI render, ONE still (no media/LaTeX/Mermaid — it reports what it omits):
  `node src/demo_apps/PowerRP/cli/render.js <doc.json> <out.png>
  [--slide N] [--alpha A] [--width W] [--height H]`
- Render-job worker by hand (needs a job dir with job.json + doc.json, and
  `BACKEND_URL` pointing at a running project server if the deck uses assets):
  `node src/demo_apps/PowerRP/cli/render_job.js <jobDir> [--workers N]`
  Its summary line names the GL backend ANGLE bound — that is how you confirm a GPU.
- System deps (ffmpeg + Chrome's ~30 shared libraries, derived from Chrome's own
  `deb.deps`): `bash src/demo_apps/PowerRP/setup.sh`. Required before ANY browser
  test or server-side render on a fresh Linux clone.

## Known bounds (deliberate)

Multi-selection, box selection, drag-all/multi-resize, alignment, and grouping
exist; the heterogeneous multi-selection Inspector intersection is being built
now. Groups are flat-membership derivation parents, not nested object trees,
and retain FOUR of the five Round 18 frozen-baseline defects — this line used to
say all five were group defects, which was WRONG: #1 was never one. It was
`fancyArrowFillMigrations()` silently rewriting a valid current-schema
later-slide `stroke` keyframe into `fill` on load (the manifest names it exactly,
at `claude_instructions.md:4612`), and it is FIXED — the gate was per-slide, so a
one-leaf Outline commit on slide 2 was byte-identical to a legacy pre-17.4 write;
it is now per-item, because a `fill` on ANY slide proves the item is post-17.4.
Both directions are pinned by tests: authored-today is left alone, genuinely
legacy still migrates. Defects 2-5 (group/anchor/ungroup) remain open. Groups DO
composite as a subtree when their effects bundle is active (`plugins/group.js` carries
`bundle("effects")` + `bundle("cropInsets")`, and `groupFoldsSubtree()`
composites). The video player exists, and so does the deterministic video
scrubber (`plugins/video_scrub.js`, plus `plugins/demo/video_v5_scrub.js`);
REPLICATORS still do not. Z-order UI = bisect then document-wide normalize
(core/document.js). THE CAMERA is built and mandatory (exactly one,
`purgeable:false`, owns the background and every view). Presentations are
UNCAPPED — no frame caps exist (`meta.fps` is dead; one frame per rAF tick).
Flip H/V exists and a stored w/h MAY BE NEGATIVE (see the contract below).
`plugins/magnifier.js` still exists alongside `plugins/demo/magnify.js` — that
migration is partial, not done.

## Protocols a plugin must know about

These are declared in `core/registry.js`'s docblock, which is the de-facto
widget base class. Read it before adding a widget.

- **BOUNDS** — `localBounds(state)` is the LOCAL rect this widget's INK occupies,
  and it is what culling, band select and the copy/export capture rect all read.
  A two-point widget (line/arrow) declares its endpoint hull here instead of
  being treated as having no extent. Distinct from `cullMargin`, which is the
  EFFECT halo around that ink.
- **NEGATIVE EXTENTS** — a stored `w`/`h` may be negative; that is a REFLECTION,
  the thing a similarity transform structurally cannot express, and it is how
  Flip is stored. Plugins NEVER see it: the sign is resolved at ONE map with two
  entrances — `core/geometry.js normalizedBox` for derived nodes, and
  `unsignedState` for the pre-derivation raw-state readers (`core/expressions.js`
  runs BEFORE any node exists and calls `anchors` itself, which is where this
  was silently wrong until 0570dff).
- **HANDLE CONSTRAINTS** — `constrain(state, desired)` projects a dragged handle
  to the nearest allowed point. Declared per modifier point, not per plugin, so
  it greps to zero at top level.
- **LIST PROPERTIES** — `core/lists.js`: per-element equations, insert-between,
  and hide-vs-purge via a companion `active` list (hiding keeps numbering, so
  equations bound to later elements survive; purging renumbers).

## The three kinds of state

Before you add a widget, decide which kind it introduces. This is not
bookkeeping: it decides whether a render can be split across machines.

- **Property state** — reproducible under a SHUFFLE OF TIME: computable from
  `[[slide, alpha]]` alone, with no history. This is the core invariant and the
  overwhelming majority of the app. Default to it.
- **Recordable state** — needs an ambient input (presentation time `t`) that is
  not document state, but is a PURE FUNCTION of it, so it is deterministic given
  a timeline and records correctly. Particle emitters, the material shaders, the
  cursor spin and a video SCRUBBER's frame live here. Read `t` ONLY through
  `render_gpu/particle_clock.particleTime()`, never a wall clock directly — that
  is the seam the presenter drives live, the editor/CLI freeze for determinism,
  and BOTH exporters override per frame (`videoExport.createFrameSampler` calls
  `setParticleTimeOverride`; forget it and you export a video of a FROZEN
  sparkler, with no error). Recordable state is SEEKABLE: frame 200 renders
  without frame 199, which is what lets `cli/render_job.js` shard a render by
  strided frame range.
  CORRECTION, because this bullet used to say otherwise: a video PLAYER's current
  frame is NOT recordable. `gpu/video_registry.js` has NO time-override seam — the
  `<video>` element runs on the browser's OWN playback clock, deliberately, because
  the manifest says a player's playing is not document state. So a player renders
  fine in an export but is not reproducible, in EITHER backend; `server.py` attaches
  a warning naming it and pointing at the scrubber, which IS deterministic (its
  current time is tweened state, and `browser_media.prepareSceneScrubFrames` parks
  and awaits the decoder before the paint).
- **Ephemeral state** — genuinely untrackable; gone at the end of every
  presentation, impossible to record or reproduce. **We have none, and avoiding
  it is a design goal.** A widget that reads a host input (`Date.now`,
  `Math.random`, an iframe, a live socket) inside `emit()` or a paint path
  introduces it; so does a widget carrying state from frame N-1 (a physics sim),
  which additionally breaks frame-range sharding. If you cannot avoid it, it must
  fail LOUDLY rather than silently emit wrong frames.

Randomness is not an exception: `core/expressions.js` blocks `Date`,
`performance` and `Math.random` outright and exposes a SEEDED `random`, and
`core/particles.js` hashes `(seed, i, stream)`. Picking a seed with `Math.random`
at INSERT time and STORING it is property state, and is fine.

(The word "ephemeral" also survives in the codebase in an ordinary-English sense
— a short-lived test port, process or scratch directory. That usage is unrelated
to this taxonomy.)
