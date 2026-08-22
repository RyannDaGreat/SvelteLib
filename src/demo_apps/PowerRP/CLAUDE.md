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
— the limit of EACH MODE'S OWN tiling, which is NOT one number. Pad and mirror
share the authored ramp's mean (a reflected copy has the same mean); LOOP's
collapse also averages its baked wrap segment — ramp territory mirror never
paints — so it differs whenever the end colours differ. This line used to say
"identical in every spread mode"; that was reasoned from mirror alone and
measured wrong for loop (BB, 2026-08-02, pinned against a rendered w=0.02 fill).
`parsePaint` accepts 0 and still refuses NEGATIVE loudly.
LOOP IS CONTINUOUS AT THE SEAM (user ruling, 2026-08-02: a loop's "smooth
interpolation that goes 360 all the way around" is the semantics; a hard jump
"is not how loops should work"). The wrap segment the stop-bar preview
synthesizes (core/ramps.js, last stop → first stop + 1) is BAKED into the stop
list at the parsePaint funnel (`loopWrappedStops`, render_gpu/ir.js) — cut at
the tile boundary, both halves stated at 0 and 1 — so every backend's native
repeat tiling is C0-continuous and the picture matches
`sampleRampHex(loop:true)` byte-for-byte. An AUTHORED hard seam (stops at both
0 and 1, differing colours) still jumps: that ramp has a zero-length wrap, and
the jump is what the author drew.
THE PDF BACKEND NO LONGER RASTERIZES A TILED GRADIENT. A PDF axial shading has no
tile mode, but its Function's `Domain` need not be [0,1], so mirror/loop are
emitted as a stitching function replicating the ramp per tile (mirrored tiles
`Encode`d backwards). `opHasMirrorLinearFill` therefore returns false always —
kept as a named predicate because that raster-routing line is a list of measured
capability gaps and "linear gradients are not one" belongs where the others are.

DITHERING IS A PAINT PROPERTY, NOT A CAMERA ONE, AND IT NEVER WORKED AS A CAMERA
ONE (user ruling, 2026-08-07: "It will be a material-level thing you uproot any
code in the camera for dithering"). A gradient paint carries `ditherMode` ("off" |
"bayer" | "blueNoise", `DITHER_MODES`) and `ditherEmphasis` (no upper cap) BESIDE
its `type` — not inside `linear`/`radial`, so flipping a gradient between the two
modes carries the dither across, and so the next paint kind that wants one reads
the same two leaves. It applies to RADIAL as well as linear, which is the opposite
of the `spread` decision above and for a stated reason: radial has no wavelength or
phase for a spread row to modify, but a radial ramp quantises into 8-bit RINGS
exactly as a linear one quantises into bands, so the feature dither modifies is
fully present. ABSENT IS OFF AND OFF IS BYTE-IDENTICAL — `parsePaint` OMITS both
keys when the dither is inactive (mode "off" OR emphasis 0), so a pre-feature
gradient produces the same parsed object, the same shader and the same exported
bytes. `core/document.withCameraDitherDropped` removes the retired camera leaves
LOUDLY on load.
THE OLD CAMERA PASS WAS A NO-OP IN THE VIEWPORT FOR ITS WHOLE LIFE, and the
autopsy is why the replacement is shaped as it is. It de-banded by compositing the
frame into an RGBA16F offscreen and dithering on the F16 → 8-bit downconvert
(adding noise to an already-8-bit surface does nothing). But `browser_surface.js`
builds the on-screen GL context with `antialias: 1` whenever the camera's AA is
"standard" — the DEFAULT — so the surface is 4x MSAA, and `makeSurface` inherits
the source's sample count: it asked for a 4x-MSAA RGBA16F target, which Skia's
GLES caps refuse. It returned null, the try/catch swallowed it, `console.warn`ed
once and painted undithered. MEASURED on an M4 Max: `antialias:1` ⇒ null,
`antialias:0` ⇒ non-null, sample count the only variable. `gpuService` was
unaffected (`MakeRenderTarget` is always 1-sample), which is exactly why dither
worked in PNG/video export and never on screen — a difference nobody could
explain. THE PAINT-LEVEL VERSION NEEDS NO OFFSCREEN AT ALL: a paint shader's
output is a float Skia quantises as it writes to the destination, so the shader is
already standing on the quantisation boundary. MSAA is irrelevant to it.
THE THRESHOLD IS SAMPLED IN DEVICE SPACE, via a `uToDevice` float3x3 uniform
carrying `canvas.getTotalMatrix()`. A runtime-effect paint shader is invoked in
LOCAL space, so without that mapping each 2x2 block of device pixels at dpr 2
would share one threshold — the grain doubles and de-bands half as well, silently.
`render_gpu/tests/gradient_dither_test.js` pins it by counting how often
horizontally-adjacent device pixels differ on a VERTICAL ramp (where any
difference IS the dither); dropping the CTM takes that from ~19% to 0.0%.
BIT DEPTH IS THE SECOND HALF OF THE FEATURE (user, 2026-08-08: "more options for
dithering too actually - like bit depth (by default 8 bit but can go down to 1
bit)"). A paint carries `bitDepth`, 1..8 per channel, and 1 bit is two levels per
channel — eight colours. QUANTISATION AND DITHER ARE SEPARATE COMPOSABLE
OPERATIONS, so all three combinations are reachable: off+8 is today's picture,
off+1 is HARD POSTERIZE, bayer+1 is the dithered retro look. That also reveals what
the 8-bit-only version always was — dithering at the surface's own boundary; depth
just MOVES the boundary.
EMPHASIS IS IN QUANTISATION STEPS, AT EVERY DEPTH. `bitDepth` sets the step size
(1/(2^bits − 1)); `ditherEmphasis` scales the wobble in units of that step, so
emphasis 1 is ±half a step whether the step is 1/255 or the whole range. MEASURED,
and it is the sharpest statement of the orthogonality: emphasis 1 moves 18.8% of
bytes at 1, 2 and 4 bits against 18.5% at 8 — the same proportional work, only the
jump size changes. A shader that kept the hardcoded 1/255 collapses that to 0.2%.
8 BITS IS BYTE-IDENTICAL, AND THE SHADER KEEPS A SEPARATE BRANCH FOR IT: at 8 bits
it does NOT quantise explicitly (the surface write already does), because a second
round() risks differing in rounding mode. `parsePaint` drops a `bitDepth: 8` leaf
entirely, so it never reaches a backend, a cache key or a uniform. Forcing explicit
quantisation at 8 bits was MEASURED to change nothing on the software backend, so
that branch is DEFENSIVE (the GPU evaluates in `half`, where a divide by 255 has no
such guarantee) — do not delete it expecting a test to catch you; it is pinned
structurally instead, by the packer's quantise flag.
QUANTISATION IS DONE IN UNPREMULTIPLIED COLOUR. The incoming half4 is
premultiplied, and posterizing that would quantise colour and alpha together, so a
50%-transparent grey would land on a different colour than the same opaque grey and
a fading gradient would shift hue as it faded. Unpremultiply, quantise,
re-premultiply. (Testing this needs a TRANSPARENT backdrop: over an opaque one a
50%-alpha fill blends to alpha 1 and the straight value is gone before readback.)
THE DITHER OPTIONS ARE A `BUNDLES` ENTRY (user, 2026-08-08: "bundled up into a
dithering options property bundle - since other things might use dither soon too …
not just gradient"). `BUNDLES.dither = ["bitDepth", "ditherMode", "ditherBayerSize",
"ditherEmphasis"]` is THE declaration — labels, help, options, bounds, defaults and
`visibleWhen` — composed with `bundle("dither")` / `bundleDefaults("dither")` like
`bundle("effects")`. TWO SURFACINGS, ONE DECLARATION: a future ITEM-level consumer
gets these rows through Inspector's ordinary PROPS path and a "Dither" accordion
(the category id title-cases, so Inspector needed no change), and the PAINT-level
consumer that ships today (`web/PaintField.svelte`, on a gradient fill/stroke)
RENDERS FROM THE SAME BUNDLE rather than hand-writing rows. The keys are identical
at both levels, which is what lets ONE `visibleWhen` predicate serve both.
ONLY `ditherEmphasis` HIDES WITH THE MODE (user ruling: "like dither emphasis need
not exist if dither is off"), and `ditherBayerSize` hides more narrowly still —
blue noise has no matrix to size. `bitDepth` does NOT hide, and the asymmetry is
the point: emphasis is meaningless with no mode to scale, but depth means something
alone. Gating depth would have forced it INERT while hidden — an
invisible-but-active knob — and deleted hard posterize to satisfy a row rule. This
REVERSED the earlier "emphasis stays visible-but-inert" rule, and it also RESOLVED
a deviation recorded a day earlier: those rows were hand-written markup with no
PROPS row for a `visibleWhen` to hang on, which forced the gate to be a bare
`{#if}`. Moving to the bundle put it where every other gate in `properties.js` lives.
THE BAYER MATRIX ORDER IS SELECTABLE — 2×2, 4×4, 8×8 (default), 16×16 — from ONE
generator, not four baked matrices (user: "i should be able to, if i select bayer,
choose the bayer grid size"). The recursion b_{2n}(a) = b_n(a/2)/4 + b_2(a) unrolls
to a weighted SUM of the same 2×2 base cell at halving scales, so the order just
selects how many terms participate. THE HALF-CELL OFFSET MUST TRACK THE ORDER: a
2^k matrix holds 4^k thresholds and is centred by 0.5/4^k. The old hardcoded 0.5/64
biases every order but 8×8 — measured, it shifts a 2×2 dither's mean by 1.85 code
values, i.e. the dither LIGHTENS or DARKENS the fill instead of only scattering it,
which no "the pixels changed" test can see. 8×8 stays byte-identical (measured).
THE BLUE-NOISE TILE WAS NOT BLUE NOISE, AND THIS IS THE ROUND'S SHARPEST LESSON.
`blue_noise_64.js` claimed "Ulichney void-and-cluster (SPIE 1993)", a "toroidal
Gaussian energy field" and a "perceptually-flat blue noise spectrum", and cited a
generator script THAT DID NOT EXIST IN THIS REPO. Measured: high/low spectral power
ratio 0.90 (a white-noise control scores ~1; real blue noise scores in the
thousands) and a histogram of min 8 / max 17 where ranking every texel must give
exactly 16 of each. It was white noise wearing a blue-noise docblock. NOTHING
CAUGHT IT — not the render tests, which only asked whether the dither changed
pixels (white noise changes pixels perfectly well), and not review, because the
claim was confident and the data is unreadable base64. THE USER CAUGHT IT BY EYE at
1 bit and high emphasis, and an agent then DISMISSED it as a known quality
characteristic, which it was not: blue noise having no low-frequency energy is its
DEFINITION, so visible blobs are proof of absence, not a tuning axis.
THE REPLACEMENT IS DOWNLOADED, NOT GENERATED (user ruling: "you don't generate blue
noise. you download it"). `blue_noise_512.js` — 512×512 from
Calinou/free-blue-noise-textures (`512_512/LDR_LLL1_0.png`, Christoph Peters, CC0
1.0, no attribution obligation). Measured: spectral ratio 4904.8, and an exact rank
permutation (1024 of each value). It costs ~344 KB of base64 that does NOT gzip
(random bytes) — a real bundle cost, accepted for a correct spectrum and a repeat
period 8× longer (a 64px tile repeats ~30×17 across 1080p; 512px repeats ~4×2). The
repo ships 128 and 256 variants if that is later judged too expensive; NEVER
DOWNSAMPLE THE 512, because resampling destroys the spectrum that is the whole
point — take the repo's own tile at that size.
`render_gpu/tests/blue_noise_test.js` PINS BOTH PROPERTIES ON THE SHIPPED BYTES,
and each independently catches the old tile: the spectrum (via an FFT, because a
direct O(N⁴) DFT at 512 is ~7e10 ops) and the rank permutation. Its three controls
— white noise ~1, smooth blobs ~0, checkerboard enormous — are ASSERTED, because a
spectral test nobody calibrated is what let 0.90 read as acceptable.
THE VECTOR RULE IS DEPTH-AWARE, AND THE 8-BIT-ONLY VERSION OF IT WAS WRONG BELOW 8.
At 8 bits the exporters DROP the dither and say so (`ir.js
reportVectorDitherOmission`, shared by both so they cannot tell different stories):
the omitted wobble is at most 1/255, a shading has no bit depth to carry it (the
VIEWER picks the raster depth), and rasterizing would trade an infinitely-scalable
few-hundred-byte shading for a fixed-DPI image to carry something designed to be
invisible. **That argument is about MAGNITUDE and it dies below 8 bits.** At 1 bit
the step is the entire range — the posterization IS the picture, not a perturbation
of it — so exporting a smooth shading would export something the author never drew.
BELOW 8 BITS THE OP ROUTES TO RASTER in both exporters, through
`opHasReducedDepthGradient` on the same named `opHas…` line every other measured
gap uses, announced by `reportReducedDepthRaster`. `reportVectorDitherOmission`
refuses a sub-8-bit paint outright rather than describing its drop as invisible.
A VECTOR POSTERIZATION IS DEFERRED, NOT MISSED: an undithered low-depth ramp IS a
step function a PDF stitching function could express exactly, but quantisation is
PER CHANNEL, so the band boundaries are the union of the R/G/B step positions and a
reconstruction that lands them slightly differently would install a NEW divergence
in place of the one it fixed. A raster route also now REQUIRES a `rasterize`
callback, so a caller without one gets a loud configuration error rather than a
silently smooth gradient.

MIDI IS A REAL WIRE TYPE, AND THE CLIP THAT TRAVELS ON IT IS DOCUMENT STATE
(user, 2026-08-08: nodes with "a midi-in input node along with the signal midi
output nodes and abc language output midi nodes", and — when the shape was in
doubt — "**literally having signal as a node is important btw**"). `midi` is a
`core/nodeflow.PORT_TYPES` entry beside `number`/`trigger`/`audio`, so the beads,
the ghost wire, the colour, the fan-out and the refusal-on-a-bad-drop are the
machinery every other cable already uses. **There is no "source" property naming
another item**; clip → synth is a cable the author drags. The graph carries a
non-scalar value with NO changes — `typesCompatible` allows `midi→midi` by
identity, `deriveWires` colours by the source port's declared type, and
`resolveNode` passes the value through untouched (measured end to end,
`tests/midi_clip_test.js`).
WHAT TRAVELS IS THE CLIP, NOT A LIVE CABLE, and that is forced by the four-kinds
law rather than chosen: bytes arriving from a host MIDI device would be EPHEMERAL
state, so a deck containing one could not be exported or re-rendered. So the value
is an array of `{start, duration, pitch, velocity}` records — `core/midi_clip.js`
owns the rules, `PROPS.clip` is the declaration, and it is an ordinary `core/lists.js`
LIST property: per-element equations (`= clip.3.pitch`), insert-between,
hide-vs-purge, an Inspector control and a keyframe per leaf, all for free.
"sequence", NEVER "sorted by start" — a sorted list canonicalizes on every write, so
dragging a note past its neighbour would RENUMBER both mid-gesture and silently
rebind every equation; `clipNotes` sorts a COPY on read instead.
A NUMERIC TUPLE LERPS CONTINUOUSLY AND DOES NOT ROUND (`interpolators.js:146`, "NO
int-rounding" — the int rule is on the SCALAR path). The neighbouring `heldNotes`
and `notes` declarations in `properties.js` claim the opposite and are WRONG about
it; nothing depends on the mistake today because both round on read, as `clipNotes`
does, but do not design against it. Start and duration are deliberately NOT rounded:
they are BEATS, and an eighth note is 0.5 of one.
THE EVENT VOCABULARY IS `noteOff/cc/pitchBend/noteOn`, AND ALL FOUR NOW HAVE A
PRODUCER. `MIDI_EVENT_RANK` declared and ordered all four from the start, because the
Surge worklet already implemented `pitchBend` and `cc` in full and a note-only signal
type would have had to be widened later. **The bend/CC half landed with the `signal`
import** and cost exactly what that bet predicted — no change to the wire, the port
type or a receiver. It is a SECOND LIST PROPERTY beside `clip`: `ctrl`, tuple
`[start, controller, value]`, where `controller` is `BEND_CONTROLLER` (-1) or a CC
number 0..127. ONE list rather than two keeps the element an all-numeric tuple (the
plain-lerp branch, exactly as `clip`), and a negative can never be a CC by the
protocol so the sentinel cannot collide. **VALUES ARE RAW MIDI, NOT NORMALIZED** —
0..127 for a CC, 0..16383 for a bend with 8192 centre — because BOTH ENDS already
speak those units (signal stores them; the worklet takes them), so a normalized
middle would be two conversions and two roundings buying nothing a reader of the list
can see. `clipEvents(notes, controls)` takes the lane as an OPTIONAL second argument
and merges it into the one sorted stream, so every existing caller is byte-identical
and no caller has to re-implement the rank to interleave.
OFFS BEFORE ONS AT THE SAME BEAT is a law, not a tidy-up (the
`latchedChordDelta` rule): every legato line ends one note as the next begins, and
ons-first makes a full voice pool steal a voice that was about to be released.
NO `channel` FIELD, stated rather than omitted: the receiving facade hardcodes
channel 0, and the WIRE already answers what a channel would. One wire is one
instrument; two parts is two wires, which the graph shows and a channel would hide.
If it is ever wanted it is a FIFTH element field with no migration — `core/lists.js`
appends at index 4, every stored 4-tuple reads `undefined` there, and `noteRecord`
already defaults (pinned by `tests/midi_clip_test.js`).

WHEN A CLIP PLAYS DECIDES WHETHER THE DECK EXPORTS (user: "WHEN does the signal
editor start to play its song? what triggers it? a button node? … the signal editor
therefore needs an input node too"). **BOTH** midi sources — the clip node and the
ABC node — have a `trigger` INPUT of the EXISTING `trigger` type. Both, because the
user asked "how to trigger the abc notation to start playing?" when only the clip
node had one: how a phrase is AUTHORED (drawn vs typed) has nothing to do with WHEN
it starts, and one question must not have two answers. The playhead is always `now − startTime`; everything turns
on where `startTime` comes from, and `core/clip_playback.js` classifies it:
  NOTHING WIRED → the clip's own keyframable `startTime` leaf. RECORDABLE, seekable,
    shardable, exports correctly. **THE DEFAULT, so the off-the-shelf experience
    exports and non-reproducibility has to be asked for.**
  A CLOCK → pulse times are a pure function of elapsed time (`lastPulseSeconds` is
    the proof: frame 200's pulse needs no frame 199). Still RECORDABLE.
  A BUTTON → the moment a hand moved. HISTORY, so EPHEMERAL — and not SIMULATED
    either, because a contiguous walk from frame 0 cannot reproduce it. **The clip
    plays live and RENDERS SILENT.** Legal (live performance is the user's own
    suggestion) and WARNED ABOUT, never silently different.
WHICH WIDGETS ARE COVERED IS ASKED OF THE PORTS (`isTriggerableMidiSource`: emits
`midi` AND takes a `trigger`), never of a clip declaration. Keying on `midiClip`
covered the clip node ALONE, so a Button-driven ABC node would have rendered silent
with no warning — the exact failure the warning exists to prevent, reintroduced by
asking the wrong question about coverage. WHICH SOURCES ARE LIVE IS LIKEWISE ASKED
OF THE DECLARATION, never a type list: a plugin declaring `livePress`/`livePlay` is live, which is the same predicate
`core/live_control.js` already routes on, so a new live control is classified
correctly the day it is written. `server.py live_trigger_warning` attaches the
export warning — the `playback_clock_warning` precedent, naming the clips, saying
they will render SILENT and pointing at both fixes. Its two type lists are MIRRORS
across the language boundary; `tests/live_trigger_warning_test.py` derives them from
the real plugin registry in node and fails if they drift.

THE MIDI EDITOR IS ryohey's `signal`, VENDORED AND FRAMED — NOT ONE WE WROTE, AND
THIS PARAGRAPH REPLACES ONE THAT DESCRIBED ONE WE DID. `signal` is a PROPER NOUN
(<https://github.com/ryohey/signal>, MIT, pinned at `632de96` in
`web/public/signal/PROVENANCE.txt`): a React/TypeScript application with a WebGL
piano roll, an arrange view, a tempo graph and automation lanes. The user's ruling
is standing and was stated three times — "the piano roll open source thing should
NOT be vibecoded" / "Hopefully your agent is LITERALLY USING the midi code I gave?
Not just trying to reimplement it" / "Again, USE IT dont imitate it" — and it was
VIOLATED ONCE, by a hand-rolled roll (`web/PianoRollModal.svelte` +
`core/piano_roll.js`) that the user met with "this little chicken shit 'midi clip'
temu-quality 'we have signal at home' widget". **That lookalike is DELETED, not kept
beside the real one**, and its doctrine went with it in the same commit — the rule
this file states for itself two sections up. Do not grow another one: if the editor
lacks a behaviour, the answer is in signal's embed patch, never in a new canvas here.

It is `activate: "signal_edit"` — ONE string, resolved through the ACTIVATE registry
to `web/signalEdit.js` + `web/SignalModal.svelte`, which holds ONE same-origin
`<iframe>` and nothing else. A MODAL and not a canvas mode (a node card is 200px and
signal is a whole application), so it raises an app signal exactly as `code_modal`
does and declares no `mode`. A widget opts in by declaring
`midiClip: {key, activeKey, ctrlKey, ctrlActiveKey, editable}`; the ABC node
deliberately does NOT (its notes are derived from text, and dragging one would mean
rewriting source), so it declares `codeEditor` and gets the Monaco modal instead.

SAME-ORIGIN IS FORCED, NOT PREFERRED. signal posts with
`postMessage(msg, window.location.origin)` — it targets ITS OWN origin — and the
parent pins `ev.source !== frame.contentWindow`. A cross-origin copy receives
nothing and delivers nothing, from both sides. It lives in `web/public/` rather than
`vendor/` because it is an HTML PAGE for an iframe needing one stable URL identical
in dev and in the build; `/@fs/` is wrong because Vite TRANSFORMS HTML it serves, so
you would frame a rewritten page rather than the tested artifact. **`optimizeDeps.entries`
is pinned to `["index.html"]`** because Vite's dep scanner globs HTML under the root,
took `edit.html` as a second entry, and forced a mid-session re-optimization that
reloads the page. Do not undo that.

THE AUTHORING SEAM IS SIGNAL'S `localStorage` AUTOSAVE, AND IT IS A STANDARD MIDI
FILE. `core/signal_song.js` owns the whole argument; the short version is that the
stored `signal_autosave` value is `{midiData: <base64>, timestamp}` where `midiData`
is a complete format-1 SMF written by signal's own `songToMidi`. **So we are coupled
to SMF — a frozen 1996 grammar — and NOT to signal's minified internals**, which is
why a signal upgrade that renames every symbol cannot break the import. The bundle
exposes NO store handle (module-scoped `const`, no window global, no command bus), and
the three alternatives were each measured and refused: the live `signal:synth-output`
note stream is EPHEMERAL by construction (`delayMs` relative to post time, landed on
`setTimeout`) and must never reach a render tree; `export-midi` needs a native save
picker and REVOKES its blob URL, and its `onUserExplicitAction` DELETES the autosave;
IndexedDB holds only Firebase and a soundfont cache. Three caveats are engineered
around and written down there: a 10-SECOND interval (so the import is a BUTTON that
states the snapshot's age, never automatic), deletion on New/Open/Import/Export (so
the modal keeps the last snapshot in memory), and a `String.fromCharCode(...)` spread
that silently drops autosaves for very large songs (nothing this side can do).

MONITORING AND AUTHORING ARE TWO PIPES AND ONLY ONE IS DOCUMENT STATE. Authoring is
PROPERTY STATE (the `clip` and `ctrl` list leaves, one undo unit per import).
Monitoring — `web/signalBridge.js` — is EPHEMERAL and touches nothing but the live
engine, the same fence a hand on the Surge modal's piano sits behind.
**ITS `io` FACADE CARRIES `pitchBend` AND `cc`, WHICH IS THE GAP WEBSURGE SHIPPED.**
Their mode interface is `{noteOn, noteOff, allNotesOff, setModeStatus}` and their own
manifest calls what that costs "the biggest gap": signal has full automation lanes,
their worklet implements both, and the events died at that boundary. Here both pipes
carry them. ONE HALF IS STILL OPEN AND IS COUNTED RATHER THAN DROPPED: the engine
facade a route resolves to (`surgeControl`) has no `pitchBend`/`cc` METHOD yet
although the worklet behind it takes both message types, so monitored bends are
tallied and reported in the modal's footer; `signalBridge.js`'s header names the
two-line addition that closes it.

**A `controlNodePlugin` SPEC ONLY PASSES `extra` THROUGH.** `codeEditor` and
`outputProps` written at the spec's top level are SILENTLY DROPPED — the widget then
carries `activate: "code_modal"` with nothing for the handler to read and
double-clicking it throws. Measured, on the ABC node, and **nothing we have catches
it**: `activation_migration_test` reports widgets declaring NO handler, and this one
declared one; the handler's `claims` is migrationPlan-only so its false answer is
never consulted; the build is green. It is the plugins-half of the missing-named-import
hazard. `tests/signal_embed_probe.js` pins the double-click end to end because that is
the only place the whole chain is visible — and it reaches INTO the frame to assert
signal's own `#root` and WebGL canvases are there, because a `src` pointing at a 404
or at our own markup would pass every other check in the file. It also dispatches
inside the frame rather than at page coordinates, which is WebSurge's recorded trap:
a click at page coordinates can hit whatever the host floats over the frame and
produce a note, which looks exactly like success.

THE ABC SUBSET IS STATED EXHAUSTIVELY IN `core/abc.js`'s header — supported
constructs and, more importantly, every REFUSED one with the sentence it produces.
A silently-ignored ABC construct is the quiet wrongness this codebase forbids: a
dropped repeat, tie or broken rhythm parses green, produces notes, plays, and is the
wrong music with nothing to look at. So repeats, ties, slurs, broken rhythm, tuplets,
grace notes, decorations, inline fields, voices, lyrics and continuations are each
refused with a line, a column and what to write instead — and **a tune with ANY error
yields NO NOTES AT ALL** (the project-script rule: half a tune looks like it worked).
`tests/abc_test.js`'s BACKSTOP sweep is what makes that list a statement rather than a
hope: it feeds every printable ASCII character into a note position and fails if any
is neither understood nor refused. It caught `%` on its first run.

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
- **CONNECTION SLOTS HAVE TWO SHAPES** — `inputs.<port>` is one `{item, port}`
  record, or an ARRAY of them on an input declaring `multiple`. Read a slot ONLY
  through `core/nodeflow.inputRefs` / `inputWires`; a reader that indexes
  `inputs[port].item` directly silently drops every wire on a multiple input.

## The four kinds of state

Before you add a widget, decide which kind it introduces. This is not
bookkeeping: it decides whether a render can be split across machines.

(It was THREE until R7-9. The fourth, SIMULATED state, was named by the user
this round and is the only one that gives up frame-range sharding — read its
bullet before you reach for it.)

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
- **Simulated state** — a value at time `t` that depends on ITS OWN value at
  `t - dt`. Reached in an equation by `@` (this property's previous value;
  `@self.value`, `@osc1.phase`, `@theta` for another slot) and `dt` (the seconds
  this step covers). `core/simulation_history.js` owns the table and the rules;
  `core/expressions.js` owns the grammar. **`@` is the DISPLAY token and
  SERIALIZES TO `@@`**, because `@<itemId>` was already the stored item sigil.
  **ONE STEP PER RENDERED FRAME, AND `dt` IS REAL ELAPSED TIME** — not a fixed
  document timestep, which would make the simulation's resolution independent of
  the render's and leave 100 frames of a 1000 fps render sitting between two
  steps. So `rotation = @ + dt` is one degree per second at 24, 30, 60, 144 and
  1000 fps (measured, identical to twelve decimal places), and a higher framerate
  integrates more accurately rather than differently.
  **IT GIVES UP SEEKABILITY, DELIBERATELY, AND THAT IS THE WHOLE COST.** Frame N
  is a function of frames 0..N-1, so a strided shard cannot compute its own
  prefix: `core/document.stridedShardRefusal` is the loud refusal a render job
  must consult, and CONTIGUOUS ranges are the answer (each worker walks its own
  prefix in order). Everything else survives — **Δt = 0 still means a
  BYTE-IDENTICAL frame, absolutely**, which is what the history's two tables
  (`prev`/`cur`, rolled only when the clock moves) are for: `web/CanvasView.svelte`
  evaluates one frame SEVERAL times — 2 on a pan, 3 on a hover, MEASURED (the
  "~28" figure this once cited was a count of call SITES, most of them gated by
  mode/selection/drag) — and with one table a dt-free `= @ * 0.9` would advance
  once per evaluation, **with the count varying by gesture**. The exact number
  was never the argument; that the number is greater than one and not fixed is.
  The table is AMBIENT and global to the process, so **exactly one consumer per
  process may advance it**; every other must run inside `withSimulationFrozen()`,
  which makes a pass structurally unable to write (a thumbnail of another slide, a
  morph endpoint, a preview-free hypothetical). A violation is reported loudly, not
  merged. A PAUSED clock yields `dt = 0` by definition, so every still renderer is
  correct with no changes and a frozen simulation genuinely does not move.
- **Ephemeral state** — genuinely untrackable; gone at the end of every
  presentation, impossible to record or reproduce. **We have none, and avoiding
  it is a design goal.** A widget that reads a host input (`Date.now`,
  `Math.random`, an iframe, a live socket) inside `emit()` or a paint path
  introduces it. Carrying state from frame N-1 (a physics sim) used to be listed
  here too; since R7-9 that is SIMULATED state — legal, spelled `@`, and paying
  the stated sharding cost — so what remains ephemeral is state that cannot be
  reproduced from a timeline AT ALL. If you cannot avoid it, it must fail LOUDLY
  rather than silently emit wrong frames.

Randomness is not an exception: `core/expressions.js` blocks `Date`,
`performance` and `Math.random` outright and exposes a SEEDED `random`, and
`core/particles.js` hashes `(seed, i, stream)`. Picking a seed with `Math.random`
at INSERT time and STORING it is property state, and is fine.

(The word "ephemeral" also survives in the codebase in an ordinary-English sense
— a short-lived test port, process or scratch directory. That usage is unrelated
to this taxonomy.)
