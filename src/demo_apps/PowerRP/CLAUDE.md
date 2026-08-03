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

`meta.script` is THE PROJECT SCRIPT (`core/project_script.js`): one per-document
JavaScript library, first-class and defaulted to `""` (repairedDocument fills it
quietly when absent, discards a non-string LOUDLY). Assign to a provided
`exports` object and any property equation can call it — `exports.ease = t => …`
makes `= ease(0.5)` work in every widget. It compiles in the SAME jail equations
do, so the determinism law is untouched (`Date`/`fetch`/`Math.random` unreachable,
`Math` = SAFE_MATH, seeded `random` and the one `time` clock available); it gets
the pure value-level built-ins an equation does not (`Object`/`Array`/`JSON`/
`Error`/… — `SCRIPT_STDLIB`, justified there). It is NOT part of the fold, so
`evaluateState(state, registry, script)` takes it as a third argument and MEMOIZES
ON IT; `web/cameraFrame.evaluationAt` is the ONE seam that threads it for every
pixel consumer. Precedence: built-ins and the FUNCTIONS library are not
shadowable (a colliding export is a LOUD compile error), a variable or item slug
beats an export at read time, and a broken script exports NOTHING so its callers
fail through the normal equation-error path. Reading `time`/`random` at the
script's TOP LEVEL is refused — the compile is memoized per source, so such a
value would freeze forever; read it inside an exported function. Edited in the
Monaco modal off the top-right `mdi:script-text-outline` button
(`edit-project-script`); a script that will not compile keeps the modal open with
the error in its footer.

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

## The boot surface

A DEAD BOOT MUST NEVER LOOK LIKE A SLOW ONE (user, 2026-08-02: "it actually
crashed when it was loading and I couldn't tell because ... I'm so used to it
taking such a long time to say starting that I didn't even think to look in the
console for this error"). `web/index.html`'s FIRST INLINE SCRIPT owns this and
nothing else may: it declares the stage roster, and it installs `window.onerror`
+ `unhandledrejection`, which must be there because an import-graph throw fires
during the bundle's EVALUATION — a handler that ships with the bundle cannot
catch the bundle failing to arrive. A crash renders IN the splash (message, top
stack frame, remedy) and stands down at the first painted frame. `failed` is a
one-way latch separate from `finished`; both gate done()/stage()/reportCrash(),
because a boot that crashed and then limped to a frame used to erase its own
error. Keep it pre-framework: no Svelte, no imports.

THE SERVICE WORKER'S LAW IS ATOMICITY: at no instant may a page load assets from
two different versions. A version's shell cache is written by exactly ONE thing —
`install`'s all-or-nothing `addAll` — and navigations are CACHE-FIRST from it.
A network response is never stored in a shell cache; that write is what built the
chimera behind the incident above. Deploy discovery is the SW lifecycle plus an
explicit `reg.update()`, never a fresh document over stale chunks. The shell is
PREPENDED to the precache list rather than discovered in vite's bundle (it is not
in `bundle` at `generateBundle` time). **The dev server registers no worker AND
unregisters any it finds** — abstaining is not the same as being uncontrolled,
because scope is per ORIGIN and `localhost` is shared with `vite preview`.

## Command architecture

The command registry is the single action layer. The palette (Cmd+Shift+P),
keyboard shortcuts, toolbar buttons, and future context menus are all just
surfacings of the same entries. The shortcut registry is the single source of
truth for inputs: it BOTH dispatches keydowns AND feeds the bottom HintBar —
a shortcut that isn't registered there does not exist.

An entry's `requires` (the clause completing "Unavailable — requires …") MAY BE A
FUNCTION of the app, not only a string. Most gates have one reason and a literal
says it best; a gate with SEVERAL disqualifying conditions has several true
sentences, and a fixed string would be a confident wrong answer for all but one.
`save-project` is why this exists. ALWAYS read it through
`core/commands.commandUnavailableReason`, never `cmd.requires` directly — reading
the field raw renders a function's source text (that mistake is why
`tests/palette_probe.js` and `web/ToolsPane.svelte` both resolve it).

THE SAVE DOT AND THE SAVE BUTTON ARE ONE STATE IN TWO ELEMENTS (user ruling,
2026-07-31: "I said they share the same state, not the same element" — commit
`d595e95`, reverting `aba0aa9`). Both read `app.saveState()`, so they cannot
disagree. THE DOT REPORTS: a standalone `role="status"` span beside the title
(`web/Toolbar.svelte:263`) carrying `saveText`'s four sentences as its tooltip,
focusable so the information is not pointer-only, and deliberately NOT a button —
"a control that looks clickable but only reports would be a lie about its own
affordance" is why it stayed SEPARATE, not something a merge satisfied. THE BUTTON
ACTS: its gate is `draftKeys.quickSaveBlocker`, which answers BOTH "may it run" and
"why not" from one call, and blocks on THREE conditions — an unsaved draft, a CLEAN
working copy (user: "should the save button be enabled when there are no changes?"
— no), and a save in flight. Because a clean project's Save is disabled and its tip
is the only place that gate's reason is written down, the toolbar's buttons use
`aria-disabled` + a handler guard, NOT the native attribute — a natively disabled
button is not focusable, so the keyboard could never reach that sentence.
`tests/toolbar_surfacing_test.js:188-190` pins the dot present in markup AND css;
`:192-194` make the merged form INEXPRESSIBLE (`saveMarkFor` and `.btn-save-mark`
asserted absent).

**THIS PARAGRAPH WAS WRONG FOR A DAY AND THE REASON IS INSTRUCTIVE** (found by an
audit agent, 2026-08-01, which caught it only by going to the code). `aba0aa9`
wrote both the merged design AND the paragraph describing it; `d595e95` reverted
the CODE seven hours later and re-pinned the tests both directions, but did not
touch this file. So doctrine went on teaching a design the user had overruled —
in the very passage agents are pointed at for the `aria-disabled` ruling. **When a
commit reverts a design, the same commit must revert its doctrine**; a revert that
leaves the prose standing installs a confident lie in the one file every
contributor is told to trust.

OPENING A PROJECT FROM THE NETWORK IS ONE FIELD WITH TWO GRAMMARS.
`draftKeys.projectSourceKind` decides repo-slug vs URL and `app.openProjectFromAnySource`
routes to `openProjectFromRepo` or `openProjectFromUrl`; anything matching neither
is refused there with a sentence about the input rather than pushed at a loader to
fail as a network error. A repo slug is `owner/name[@ref]` or a github.com URL, and
`@ref` is a branch, tag or commit that must survive all the way to the contents
API's `?ref=` AND into the `?repo=` share link (`githubProject.shareLink` carries
it; a repo draft stores `draftMode.repoSlug`, which is what `app.shareLink()`
branches on). `tests/github_live_probe.js` proves the ref really lands, against a
STANDING BRANCH on the demo repo — `RyannDaGreat/PowerRP-RobotSim-Demo@branch-fixture`,
which differs from `main` by `doc.meta.name` alone. Do not delete that branch: it
IS the assertion, and without it the check silently degrades to a second
default-branch load.

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
- **BEFORE BELIEVING A BROWSER RED, CHECK THE HOST CAN SCREENSHOT AT ALL**:
  `node src/demo_apps/PowerRP/tests/browser_capture_preflight.mjs`
  64 of the 166 browser probes call `page.screenshot`, and a host whose Chrome
  cannot capture turns every one of them into a `Page.captureScreenshot timed
  out` ProtocolError — a puppeteer stack with NO assertion text, which reads
  exactly like a PowerRP regression and is not one. This is not hypothetical: a
  whole triage session attributed 22 reds to the app before measuring the host,
  and the measurement showed `page.screenshot` hanging forever on a page
  containing one `<h1>` — no canvas, no WebGL, no Vite — under SwiftShader flags,
  under `--no-sandbox`, and under bare defaults alike, while `page.evaluate` on
  the same connection answered in 1 ms. It is also SLOW to discover the wrong
  way: each probe burns its full 180 s protocolTimeout before dying. The
  preflight is deliberately NOT named `*_probe` so the collector never runs it —
  a broken host must produce ONE sentence, not a 167th red.
  `tests/puppeteerLaunch.js` is the ONE seam every probe's `puppeteer.launch`
  goes through (`POWERRP_HEADLESS=shell` swaps old-headless in when a host's
  new-headless capture path is the thing that's broken, per above). That
  override is DIAGNOSTIC ONLY — a run under it measures whether the APP passes
  once capture stops hanging, it is never itself "passing"; the canonical gate
  stays new-headless (the default, unset).
- **BUILDING POWERRP — `npx vite build` FROM THE REPO ROOT DOES NOT BUILD THIS APP.**
  Measured 2026-08-01. The SvelteLib root `vite.config.js` takes exactly two kinds of
  entry — `index.html` and `src/demos/*/demo.html` — and **PowerRP is neither.** It has
  its OWN config and entry at `web/vite.config.js` + `web/index.html`, emitting to
  `dist-powerrp`. So a root build exits 0 with PowerRP completely broken, and several
  agents have cited that exit 0 as proof their PowerRP work compiles. It proves nothing.
  Build it as `npx vite build --config <app>/web/vite.config.js`, or from inside `web/`.
- **A MISSING NAMED IMPORT IS SILENT HERE — NEITHER ERROR NOR WARNING.** Also measured
  2026-08-01, on a real instance: `web/CanvasView.svelte` imported `itemGeometryPairs`
  after it had been un-exported from `web/canvas/dragKinds.js`; the PowerRP build ran to
  completion in 51.6 s, exit 0, with **zero** hits for `not exported` / `Missing export`
  in its output. Rollup binds the name to `undefined` and ships it, so the failure
  surfaces as `X is not a function` in the user's hands, on a green build. **Therefore a
  green build is NOT evidence that the module graph is sound**, and any change that
  removes or renames an export must land its call-site fixes IN THE SAME COMMIT — the
  intermediate state is caught by nothing we have.
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
exist, and so does the heterogeneous multi-selection Inspector intersection —
it SHIPPED 2026-07-28 (`26dd94f`, `3e68e99`): `core/multiselect.js`, plus
`tests/multiselect_test.js` and `tests/multiselect_inspector_probe.js`. This line
said "being built now" for four days after it landed, and a lead briefed an agent
from it; read `core/multiselect.js`'s header for the actual contract. The
intersection is by row name AND CONTRACT (`sameRowContract`, with a DENYLIST of
presentational aspects so a NEW row aspect defaults to contract and fails loud);
disagreeing values render `MIXED_MARK` "…"; unify is one undo unit via
`app.unifySelection` -> `setPreview` -> `commitPreview`. Groups are flat-membership derivation parents, not nested object trees,
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

GRADIENT SPREAD MODES are LINEAR-ONLY, and that is a real boundary, not an
oversight. A linear gradient carries `spread` — mirror (the default, so absent is
byte-identical legacy), loop, pad — mapping to the backends' native tile modes
(Skia TileMode, SVG spreadMethod). RADIAL HAS NO SPREAD ROW because it has no
`wavelength` and no `phase`: its ramp spans 0..r with nothing outside to tile, so
there is no second tile for a mode to describe. Skia's radial does take a
TileMode, so the plumbing would be trivial — what is missing is the FEATURE it
would modify. A radial wavelength is a separate piece of work, and until it
exists a radial spread row would be a control with no picture behind it.
THE PHASE PERIOD IS PER MODE and this is the one thing spread changes about the
existing math: mirror repeats only after a there-and-back pair (4·w·half), loop
and pad after ONE ramp (2·w·half). Phase is a fraction of THAT MODE's period, so
phase=1 stays identity in every mode. It folds in at the one seam every backend
already calls (`render_gpu/ir.js linearGradientRender`, which now reports
`tile` + `collapsed` where it used to report a `mirror` boolean).
THERE IS NO WAVELENGTH FLOOR (user ruling, 2026-08-02: the old 0.05 minimum was
"an arbitrary limitation"). Wavelength scrubs and drags to 0, and 0 is not an
error: it is the LIMIT of infinitely fine tiling, so the fill collapses to a
SOLID of the ramp's segment-weighted average (`core/properties.rampAverageColor`)
— identical in every spread mode, because a mirrored copy has the same mean.
`parsePaint` accepts 0 and still refuses NEGATIVE loudly.
THE PDF BACKEND NO LONGER RASTERIZES A TILED GRADIENT. A PDF axial shading has no
tile mode, but its Function's `Domain` need not be [0,1], so mirror/loop are
emitted as a stitching function replicating the ramp per tile (mirrored tiles
`Encode`d backwards). `opHasMirrorLinearFill` therefore returns false always —
kept as a named predicate because that raster-routing line is a list of measured
capability gaps and "linear gradients are not one" belongs where the others are.

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
  **THE DEFINING TEST IS Δt (user ruling, 2026-07-28), and it is sharper than the
  prose above.** Recordable state is a function of ELAPSED TIME ALONE. So:
  **Δt = 0 ⟹ recordable state is UNCHANGED.** Not "usually", not "unless
  something else moved" — by definition. Two consequences that make this worth
  stating as a law rather than a description:
    1. RECORDABLE AND PROPERTY STATE ARE ORTHOGONAL. Freeze `t`, vary any property
       state you like, re-render as many times as you want: the recordable
       contribution is identical every time, so what changed between those renders
       is exactly what you changed. That is the whole reason the two kinds are
       separable, and it is what lets an author A/B a design without the sparkler
       moving underneath them.
    2. IT IS MECHANICALLY CHECKABLE, in both directions. Hold `t` and the document
       fixed: the frame must be BYTE-IDENTICAL. Hold `t` and change one property:
       only that property's effect may differ. A widget that fails either half is
       not recordable — it is EPHEMERAL, and we have none (see below).
  This is why reading a wall clock inside `emit()` is a category error and not
  merely untidy: it makes Δt = 0 produce two different pictures, which breaks
  orthogonality, breaks frame-range sharding, and breaks reproducibility of an
  export, all at once. It is also why carrying state from frame N-1 (a physics
  sim) is disqualifying — that state is a function of HISTORY, not of `t`.
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
