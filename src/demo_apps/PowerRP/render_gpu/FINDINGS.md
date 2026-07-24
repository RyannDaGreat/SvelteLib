# WebGPU Rendering Prototype — Findings

> **SUPERSEDED — HISTORICAL (2026-07-24).** This documents the original WebGPU
> prototype. The runtime raster backend has since moved to Skia/CanvasKit
> (`render_gpu/skia/`), and several files referenced below (`gpu/compositor.js`,
> `gpu/shaders.js`, the `bench/` dir) no longer exist. Kept for the design "why"
> (benchmark numbers, the glyph-atlas decision, rejected alternatives) — still
> cited by comments in `gpu/glyph_atlas.js` and `gpu/image_registry.js`. Do NOT
> read this as the current architecture.

Prototype for the approved two-render-mode architecture (manifest: "RENDER
MODES DECISION" / "Round 7"): widgets emit a device-independent **draw-command
IR**; the **WebGPU** backend rasterizes it (the only runtime renderer), the
**VECTOR** backend serializes it (SVG now, PDF from the same IR later). Camera
region = the one view function for every target. This directory adds files
only — the live canvas2D pipeline (`render/`, `plugins/*.paint`) is untouched.

## What was built (all verified running)

| Piece | File | Status |
|---|---|---|
| Draw-command IR (doctested, DOM-free) | `ir.js` | done — rect/ellipse/polyline/polygon/text/image/video, push/popTransform, blurBackdrop, magnifyBackdrop; `flattenIR`; memoized `parseColor` |
| Widget ports (state → IR) | `ports.js` | done — rect, circle, arrow (bindings incl. "closest"), text, video, blur, magnifier + `sceneIR` over real `deriveRenderTree` nodes |
| WebGPU compositor | `gpu/compositor.js`, `gpu/shaders.js` | done — instanced SDF shape pipeline, mesh (polygon) pipeline, glyph-atlas text, image pipeline, video external-texture pipeline, blur + magnifier as shader passes over offscreen textures, GPU pixel readback |
| Glyph atlas | `gpu/glyph_atlas.js` | done — canvas2D-rasterized, shelf-packed, half-octave size buckets |
| SVG serializer stub | `svg_backend.js` | done — shapes/text/transforms fully; image/video/effects as documented stubs |
| Benchmark | `bench/bench.html`, `bench/run_bench.mjs` | done — N animated squares + arrows + text + blur + magnifier; WebGPU vs canvas2D on the SAME IR; headless puppeteer driver |
| Video proof | `bench/video.html` | done — `importExternalTexture` from a playing `<video>` (MediaStream source), verified headlessly by GPU readback (moving pixels) |
| Headless tests | `tests/render_gpu_test.js` | 22 pass (bare node — IR, ports, SVG, colors, scene) |

Run them:

```sh
node src/demo_apps/PowerRP/render_gpu/tests/render_gpu_test.js
node src/demo_apps/PowerRP/render_gpu/bench/run_bench.mjs --seconds 4
npx vite  # then open /src/demo_apps/PowerRP/render_gpu/bench/bench.html?mode=webgpu&n=5000
```

## Benchmark numbers (measured)

Headless Chrome for Testing 148 (puppeteer 24), macOS arm64, Apple Metal-3
adapter, **2560×1440 device px (1280×720 CSS @ devicePixelRatio 2)**, vsync
uncapped (`--disable-frame-rate-limit --disable-gpu-vsync`), 4-second
measurement after 0.75 s warmup. Scene: N animated rounded squares (~half with
strokes) + 8 animated arrows + 3 text runs + full-canvas backdrop blur (80% of
squares below it) + orbiting magnifier lens. `build` = IR emission (CPU,
identical work for both renderers); `raster` = renderer submit time.

| N squares | canvas2D fps | WebGPU fps | canvas2D raster | WebGPU raster | IR build |
|---:|---:|---:|---:|---:|---:|
| 100 | 562 | 290 | 0.8 ms | 0.8 ms | 0.1 ms |
| 1 000 | 243 | **278** | 2.9 ms | 2.4 ms | 0.6–1.0 ms |
| 5 000 | 66.8 | **226** | 10.9 ms | **1.5 ms** | 2.8–3.6 ms |
| 20 000 | 18.0 | **61.2** | 40.7 ms | **4.6 ms** | 11.5–14 ms |

Deliverable target met: **at n=5000 WebGPU holds 226 fps (p95 5.6 ms) where
canvas2D is at 66.8 fps** — canvas2D cannot hold even 120 fps beyond ~2 000
squares at dpr 2 with effects on, WebGPU stays >120 fps to ~10 000.

What the split exposes:

- **GPU raster scales ~flat**: 0.8 → 4.6 ms from 100 → 20 000 squares (one
  instanced draw call for all consecutive shapes — the DiskVis pattern). The
  effects cost (~2 passes + 2 texture copies at 2560×1440) is a fixed ~1–2 ms.
- **At 20 000 widgets the bottleneck is CPU IR emission** (11.5 ms/frame:
  object allocation in builders + flatten). The fix is architectural and easy
  later: persistent display lists with per-node dirty re-emission (only moved
  widgets re-emit), or typed-array IR. Not needed for PowerRP-scale documents.
- Accelerated canvas2D is *fast at low N* (Skia is GPU-backed); it dies from
  per-primitive CPU dispatch, not from software rasterization. That matches
  the user's observation on heavier scenes/machines.
- One-off stalls (worst_ms ~0.5–1.2 s) appeared on the first WebGPU frames at
  low N: late Metal pipeline compilation. Mitigation for production: render
  one warmup frame exercising every pipeline at init (p50/p95 are unaffected).

## WebGPU availability / fallback story

- **Support (mid-2026)**: Chrome/Edge 113+ (2023), Safari 26 (2025),
  Firefox 141+ (2025) — all evergreen desktop + mobile browsers ship WebGPU.
  `navigator.gpu` exists **only in secure contexts** (https or localhost).
- **Fallback**: none, by decree (no canvas2D mode). `GpuCompositor.create`
  throws loudly with a diagnosable message (missing `navigator.gpu` vs no
  adapter). The app should surface that as a "browser too old / GPU disabled"
  screen.
- **Headless CLI (measured here, the important finding)**: puppeteer 24 +
  Chrome for Testing 148 on macOS exposes a REAL Metal-3 adapter in headless
  mode with **zero extra flags**. Two gotchas cost an hour of probing:
  1. `about:blank` is not a secure context — `navigator.gpu` is absent there.
     Probe/render only after navigating to `http://127.0.0.1:…` (the CLI's
     vite-server recipe already does this).
  2. Reading the WebGPU canvas back via `drawImage`/2D-canvas is unreliable
     post-present; use `GpuCompositor.readPixels` (copyTextureToBuffer +
     mapAsync, handles bgra swizzle + 256-byte row alignment) — this is the
     seam `cli/render.js` will use for PNG export.
  - Linux CI (not tested here): typically needs `--enable-unsafe-webgpu
    --enable-features=Vulkan` and may land on SwiftShader (software, correct
    but slow). Document as a CI caveat, not a product one.

## Text rendering tradeoffs (decision: canvas2D-rasterized glyph atlas)

Chosen: rasterize glyphs white-on-transparent with an offscreen canvas2D at
half-octave-bucketed device sizes into a shelf-packed 2048² atlas; draw one
tinted instanced quad per glyph (`gpu/glyph_atlas.js`).

- Why not a DOM/canvas text overlay (DiskVis's approach): **text must live
  inside the composite** so backdrop widgets (blur, magnifier) affect it — an
  overlay can never be blurred or magnified. This kills the overlay option for
  PowerRP regardless of quality.
- Why not MSDF: crisp at every zoom from one atlas, but needs font-file
  plumbing (harfbuzz/opentype.js + msdfgen offline or wasm), loses native
  platform font stacks (`system-ui`), and is real work. The IR is unchanged
  either way (a text run stays a text run), so MSDF is a drop-in backend
  upgrade later.
- Why not glyph path tessellation: highest quality + vector-exact, most work;
  same "later, behind the same IR" argument.
- Accepted costs of the atlas: ≤ ~19% upscale between buckets (slight softness
  mid-zoom-gesture; re-rasterizes at the settled zoom), no kerning/complex
  shaping (per-glyph advances — matches simple `fillText` closely for Latin),
  single 2048² page throws when full (production: LRU/multi-page eviction).
- Parity note: SVG/PDF text uses real vector text (`<text>`); the atlas is
  raster-backend-only, exactly as intended.

## Effects: what changed vs canvas2D

- The canvas2D compositor snapshots the FULL canvas per backdrop widget per
  frame (CPU-side `drawImage` copy). Here a backdrop boundary is:
  end pass → `copyTextureToTexture` (GPU-GPU, ~free) → effect pass(es) →
  resume drawing on the scene texture. Blur = separable Gaussian (σ = CSS
  radius semantics, 3σ kernel capped at 96 taps, renormalized); magnifier =
  circle-SDF lens quad sampling the backdrop with UVs contracted by 1/M,
  rim ring in-shader.
- The magnifier's supersample path (re-render the sub-list under a lens view)
  is NOT in the prototype; the architecture makes it trivial (the display
  list is re-interpretable: render commands[0..lens) into a small texture with
  a lens view, depth-capped like the canvas version). ~1 day when needed.

## Effort estimate to fully replace `render/`

Roughly **3–5 focused days** for the raster path:

1. Plugin API: `paint(ctx, state, env)` → `emit(state, env) → commands`
   (bodies already written in `ports.js`; arrow's world-space special case
   becomes a declared capability). ~0.5 day.
2. Editor integration: CanvasView/PresentMode/thumbnails swap `paintScene`
   for `GpuCompositor.render(sceneIR(...))`; editor chrome (camera dashed
   bbox, guides, anchors) needs a `dash` option on polyline + a few emitters;
   culling hooks reuse `canSkipNode` before emitting a node. ~1–1.5 days.
3. CLI: replace the 2D-canvas hook with GpuCompositor + `readPixels` → PNG
   (headless viability proven above). ~0.5 day.
4. Magnifier supersample region re-render + pipeline warmup frame + image
   cache invalidation for animated sources. ~1 day.
5. Tests: port culling A/B + visual parity checks (readPixels diffing against
   golden renders). ~0.5–1 day.

Vector completion (separate track): finish SVG (images via href, blur via
`feGaussianBlur` over preceding group, magnifier via `clipPath` +
re-serialized sub-list) ~1 day; **PDF directly from the IR** (content-stream
operators; shapes/transforms/text map 1:1, effects rasterize into embedded
images) ~2–3 days with a small library (e.g. pdf-lib) or raw streams.

## Merge vs redo

**Merge as-is** (already shaped for production):
- `ir.js` — the seam. Schema is deliberately minimal; grows by adding ops.
- `ports.js` — becomes the plugins' `emit` bodies verbatim.
- `gpu/shaders.js`, `gpu/glyph_atlas.js`, `gpu/compositor.js` — the renderer.
- `svg_backend.js` — grows into the real exporter.
- `tests/render_gpu_test.js`, `bench/` — keep as the perf harness
  (`run_bench.mjs` is CI-runnable).

**Redo / delete during integration:**
- `bench/ir_canvas2d.js` — benchmark-only by design; delete once the A/B has
  served its purpose (it is NOT a third render mode).
- `sceneIR`'s arrow special-case → plugin-declared "emits world-space" flag.
- Image textures upload once per ref — needs invalidation/re-upload policy
  for animated canvas/image sources.
- Polygon (arrowhead) edges are unantialiased (mesh pipeline has no SDF);
  either MSAA 4× on the scene texture or capsule-outline the head. Cosmetic.
- Ellipse SDF is the scaled-space approximation — exact for circles, slightly
  off for extreme aspect ratios; swap in an iterative ellipse SDF if it ever
  shows.
- Glyph atlas: single page, no eviction (loud throw when full).

## Known limitations (prototype-honest list)

- No MSAA; SDF shapes/text are shader-antialiased (look great), mesh polygons
  are not.
- `polyline` has round caps/joins only (capsule segments) and no dash.
- Backdrop effects assume an opaque scene (PowerRP scenes start from an
  opaque camera background, so this holds).
- One glyph-atlas page; no eviction.
- Image refs upload once (no animated-source refresh).
- Video draws nothing until the element has a decoded frame (correct per
  spec: there is no frame yet).
