/**
 * The Skia (CanvasKit) render backend — paints the device-independent IR
 * display list (render_gpu/ir.js) onto a CanvasKit canvas.
 *
 * THE NEW SEAM BACKEND (2026-07-22 render rewrite): replaces the hand-rolled
 * WebGPU compositor as the runtime rasterizer. The SAME function runs against a
 * WebGL2-backed surface in the browser AND a CPU raster surface in Node (the CLI
 * / tests), so browser and headless output share one code path. It consumes the
 * exact IR the WebGPU/SVG/PDF backends consume — no plugin changes required.
 *
 * DOM-free: it never touches document/window. CanvasKit and the typeface set are
 * INJECTED (the caller inits CanvasKit and resolves font files to Typefaces —
 * the same "callers resolve file→bytes through their own seam" contract fonts.js
 * documents). Browser path resolves fonts via fetch(?url); Node via readFileSync.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────────
 * Phase 1a: transforms + rect/ellipse/polyline/polygon/text(single run)/image/
 * video. Phase 1b (this file): the backdrop/effect/vector ops —
 *   - blurBackdrop / magnifyBackdrop  (backdrop samplers: read composite-so-far)
 *   - cropSubtree / effectSubtree     (self-contained re-render of `content`)
 *   - latexVector                     (glyph vector paths)
 *
 * ── HOW backdrop samplers read the composite-so-far ───────────────────────────
 * paintIR's caller hands us a Canvas, not a Surface, so we cannot snapshot the
 * composite that has been drawn so far. When the scene contains a backdrop
 * sampler (blur/magnify) we therefore render the WHOLE scene into an offscreen
 * Surface WE own (CanvasKit.MakeSurface — a CPU raster surface in Node, also
 * raster in the browser), snapshot it mid-pass at each sampler, and blit the
 * finished image onto the caller's canvas. When there is NO backdrop sampler we
 * keep the fast path: draw straight onto the caller's canvas (byte-identical to
 * Phase 1a, and no CPU→GPU blit in the browser).
 *
 * cropSubtree / effectSubtree do NOT read the composite-so-far — their `content`
 * is self-contained IR carrying its own absolute world — so they render `content`
 * into their own scratch Surface and compose it, in either path.
 *
 * Device-space transform math mirrors the Canvas2D bench interpreter
 * (render_gpu/bench/ir_canvas2d.js) and the WebGPU compositor (gpu/compositor.js):
 * device = (world·zoom + pan)·dpr; blur/shadow/bloom sigmas and the shadow
 * offset scale by world.scale·zoom·dpr.
 */

import { flattenIR, parseColor, isGradientPaint, scrubFrameKey, videoV5FrameKey, MAX_LENS_DEPTH, BLUR_SUPPORT_SIGMAS } from "../ir.js";
import { getTextLayout, DEFAULT_TEXT_SIZE } from "./text_layout.js";
import { skShaderForPaint } from "./gradient.js";
import { GLASS_SKSL, packGlassUniforms, maxGlassDisplacement } from "./glass_shader.js";
import { getMaterial, materialEffect, isBackdropMaterial, resolveProxyFill, resolveProxyBackdrop, DEFAULT_PROXY_BACKDROP_TINT, materialSampleReach } from "./materials.js";
import { SKIA_NATIVE_BLEND_MODES, blendNeedsSkSL, blenderFor } from "./blend_modes.js"; // blend id → native BlendMode or a custom SkSL runtime blender
import { effectSourceRect } from "../effects.js"; // THE per-side effect source rect (shared with the cull-margin half of the bundle)
import * as T from "../../core/transform.js";
import { fitBox } from "../../core/geometry.js";
import { ellipsePoints } from "../../core/shapes.js"; // star-lens silhouette (shared angle math)
import { drawVideoV2 } from "./video_v2.js"; // V2 direct-upload video op ("videoV2") — self-resolving frame registry (additive; import-safe in node)

const RAD2DEG = 180 / Math.PI;

// ── RE-RENDER NESTING BUDGETS ────────────────────────────────────────────────
// TWO INDEPENDENT counters (`depth` is {lens, subtree}) because the two kinds of
// re-render have completely different cost shapes. They used to share ONE scalar,
// and that conflation is exactly why wrapping a backdrop widget in an effect
// broke it: the effect scratch spent the LENS budget, so the panel inside
// instantly took its "nested too deep" fallback and sampled the (transparent)
// scratch — the dark smear this file's `below` context now fixes.
//
//   depth.lens — BACKDROP re-renders: a lens/glass replay of the content BELOW
//     it. THE nesting that MULTIPLIES work (a lens inside a lens's replay
//     re-renders the scene again), so it keeps the hard shared bound and falls
//     back to sampling a composited surface.
//   depth.subtree — crop/effect CONTENT re-renders. Linear, not multiplicative:
//     each subtree's content is painted exactly once, and a nested effect's
//     region surface is CONTAINED BY its parent's (effectRegion clamps to the
//     surface it draws on), so a level of nesting adds no work of its own. This
//     counter is a stack-recursion guard, not a cost guard.
const MAX_SUPERSAMPLE_DEPTH = MAX_LENS_DEPTH; // shared lens-depth cap (ir.js)
const MAX_REENDER_DEPTH = 4;     // crop content nesting bound
// Was 2 — a number the UNIVERSAL effects bundle made reachable in ORDINARY
// documents: an effected group holding an effected member already sits AT 2, so a
// group inside a group would have silently dropped the innermost widget's
// effects. Raised to a recursion guard now that the linear-cost argument above is
// written down; 12 is deeper than any hand-authored group nesting and nowhere
// near a stack limit. TOTAL work is bounded by EFFECT_PASS_BUDGET, not by depth.
const MAX_EFFECT_DEPTH = 12;
// Backstop on the TOTAL effect composites one paintIR call may run, so a
// malformed or pathological IR cannot ask for unbounded offscreen allocation even
// inside the depth bound. Two orders of magnitude above any real slide (a slide
// with more than 4096 separately effected widgets is not a slide), so it cannot
// bite a legitimate document; exhaustion degrades to drawing the widget WITHOUT
// its effects and is reported, never silent.
const EFFECT_PASS_BUDGET = 4096;

/** The re-render depth at the top of a paintIR pass (nothing nested yet). */
const ROOT_DEPTH = { lens: 0, subtree: 0 };

/** Pure function. `d` one BACKDROP re-render deeper.
 * @example deeperLens({lens: 0, subtree: 2}) // {lens: 1, subtree: 2}
 */
function deeperLens(d) {
  return { lens: d.lens + 1, subtree: d.subtree };
}

/** Pure function. `d` one crop/effect CONTENT re-render deeper.
 * @example deeperSubtree({lens: 1, subtree: 0}) // {lens: 1, subtree: 1}
 */
function deeperSubtree(d) {
  return { lens: d.lens, subtree: d.subtree + 1 };
}

// PROXY quality: the backdrop ops replaced by a cheap stand-in at thumbnail size
// (drawProxyBackdrop). materialFill has its own universal stand-in
// (drawProxyMaterialFill), and effectSubtree has drawProxyEffect. cropSubtree is
// the only subtree that stays on the full path — it is a clip + a re-emit of
// content already being drawn, with no offscreen and no per-pixel pass.
const PROXY_BACKDROP_OPS = new Set(["blurBackdrop", "magnifyBackdrop", "glassBackdrop", "materialBackdrop"]);
// The frost stand-in for a backdrop panel with no colour of its own now lives beside
// the material registry's other proxy defaults, as materials.DEFAULT_PROXY_BACKDROP_TINT
// — it is BOTH the untinted-glass fallback here AND what an undeclared backdrop
// material resolves to (materials.resolveProxyBackdrop), so it is declared once.

// Slack (device px) added around any rect that must fully contain a rasterized
// shape: Skia's COVERAGE ANTIALIAS band reaches outside a shape's geometric edge,
// and an integer-rounded rect can land flush against it. ONE constant for every
// such rect here — the glass/material clip AABB and the effectSubtree source
// region (effectRegion) — so the two can never drift apart.
const COVERAGE_AA_SLOP_PX = 2;

/**
 * Command (draws on `canvas`). Paints the IR `commands` through `view`
 * ({zoom, panX, panY, dpr}) onto a CanvasKit canvas.
 *
 * Args:
 *   CanvasKit: the initialized CanvasKit module (injected)
 *   canvas: a CanvasKit Canvas (from surface.getCanvas()) — assumed fresh
 *     (its device-clip bounds give the target size for offscreen compositing)
 *   commands (object[]): raw IR command list (ir.js builders' output)
 *   view ({zoom, panX, panY, dpr}): the camera mapping
 *   opts.media (object): ref → CanvasKit Image (caller decodes)
 *   opts.background (string): CSS color cleared behind the scene
 *   opts.fontCollection (CanvasKit.FontCollection): the shared FontCollection the
 *     text path lays out through — the committed selectable families PLUS the
 *     Noto fallback chain (Greek/Cyrillic/Arabic + COLOR EMOJI). Built once per
 *     CanvasKit instance by browser_canvaskit.js (fetch) / node_render.js (fs).
 *   opts.scissor ({x,y,w,h}|null): a device-px clip rect — the presenter's
 *     letterbox. The whole surface is cleared to `background` (the bars); the
 *     SCENE is clipped to this rect so off-camera content cannot bleed into the
 *     bars. Absent ⇒ the scene draws across the full surface.
 *   opts.antialias (boolean): THE camera's per-draw COVERAGE anti-aliasing
 *     (render_settings.cameraAntialias/antialiasCoverage — the LIVE edge-smoothing
 *     control). true ⇒ setAntiAlias(true) on every shape/text/border paint
 *     (smooth, today's look); false ⇒ setAntiAlias(false) ⇒ crisp, jagged edges.
 *     Default true = byte-identical to before this control was wired.
 *   opts.quality ("full"|"proxy"): the render QUALITY. "full" (default) is the
 *     editor/export path — the full backdrop machinery, byte-identical to before
 *     this flag. "proxy" is the CHEAP thumbnail/minimap path: every backdrop
 *     sampler (glass/material/magnify/blur) is replaced by drawProxyBackdrop (a
 *     cheap stand-in over the already-composited canvas — no composite read, no
 *     below-content re-render, no full-screen blur, no SkSL), every effectSubtree
 *     drops its per-pixel passes (drawProxyEffect: soft edges / inner shadow /
 *     bloom go, the widget + its opacity + its blend mode + a shadow that reaches
 *     at least a device pixel stay), and image/video ops sample through a mip
 *     chain. Invisible quality loss at ~100px.
 */
export function paintIR(CanvasKit, canvas, commands, view, { media = {}, background = "#ffffff", fontCollection, scissor = null, makeSurface = null, antialias = true, quality = "full" } = {}) {
  if (!fontCollection) throw new Error("paintIR(skia): a fontCollection is required (committed families + Noto fallback chain)");
  const flat = flattenIR(commands);
  const bg = parseColor(background);
  const bgColor = CanvasKit.Color4f(bg[0], bg[1], bg[2], bg[3]);
  const bounds = canvas.getDeviceClipBounds(); // [l, t, r, b] in device px; fresh canvas ⇒ full surface
  // Offscreen surfaces for backdrop/lens/effect. Browser passes a GPU-backed
  // factory (MakeRenderTarget); Node/CLI has no GL context, so it falls back to a
  // SOFTWARE surface (CanvasKit.MakeSurface).
  //
  // THE FALLBACK REPORTS, AND DELIBERATELY DOES NOT THROW. Bare-node rendering
  // (cli/render.js, every node test) legitimately has no factory to pass, so this
  // is EXPECTED there — but a BROWSER caller that forgets one silently allocates
  // every backdrop/material/lens offscreen in software, rastering per-pixel
  // material shaders on the CPU. That is the failure mode that froze a PDF export
  // for 56 s and a fade for 105 s: real, and completely invisible without a signal.
  // The two sibling fallbacks (browser_surface.js's null render target, and
  // gpuService's software path) already report; this was the last silent one.
  const mkSurface = makeSurface || ((w, h) => {
    reportOnce("paintIR-no-surface-factory", "paintIR: no makeSurface factory was passed — backdrop/material/lens offscreens will be allocated as SOFTWARE surfaces (CanvasKit.MakeSurface), which rasters generative material shaders on the CPU and is very slow. Expected only in node/CLI.");
    return CanvasKit.MakeSurface(w, h);
  });
  // `antialias` rides on ctx so every leaf/border draw reaches the ONE per-frame
  // coverage-AA setting without re-threading it through each helper signature.
  // bgColor rides on ctx because the backdrop RE-RENDER branch has to reproduce
  // the composite it is standing in for, and a composite starts with THE CLEAR.
  const ctx = { media, fontCollection, deviceW: bounds[2] - bounds[0], deviceH: bounds[3] - bounds[1], makeSurface: mkSurface, antialias, quality, bgColor };
  // liveGpu: was a real GPU factory passed in (editor/presenter on-screen or GPU
  // offscreen), or are we on a CPU surface (node/tests/gpuService)? The videoV2 op
  // uploads frames STRAIGHT to a GL texture only on the live path; on CPU it falls
  // back to a readback poster. `makeSurface !== null` is exactly that discriminator.
  ctx.liveGpu = makeSurface !== null;
  // Effect composites spent so far this pass (the EFFECT_PASS_BUDGET backstop).
  // Per-pass mutable state, like the surfaces above — never a module global. An
  // OBJECT, not a number, because nested passes see a SPREAD COPY of ctx (the
  // region-sized rctx): a counter must be shared by reference to be a total.
  ctx.effectBudget = { used: 0 };
  // The letterbox clip (device px), built once — applied AFTER the full-surface
  // clear so the bars keep `background` and only the scene is clipped.
  const scissorRect = scissor ? CanvasKit.LTRBRect(scissor.x, scissor.y, scissor.x + scissor.w, scissor.y + scissor.h) : null;

  // Only blur and SOFT (non-supersample) magnifiers read the composite-so-far, so
  // only they need the whole-scene offscreen. A supersample magnifier RE-RENDERS
  // just the content below it into a small lens-sized surface, so a scene whose
  // only samplers are supersample lenses takes the fast direct-to-canvas path — no
  // full-scene offscreen, no CPU→GPU blit.
  // glassBackdrop also needs the owned surface: for the common backdropScale <= 1
  // it CROPS its minimal region out of the composite-so-far (target.surface
  // snapshot) instead of re-walking the below-content — the redundant-walk win
  // (report Q3). It only re-renders when backdropScale > 1, and then only the
  // minimal region. materialBackdrop is NOT here: it always owns its own scratch
  // surface — region-bounded when the material DECLARES its outward sample reach
  // (materials.materialSampleReach), full-surface when it does not.
  // PROXY quality (thumbnails/minimap): every backdrop sampler is replaced by a
  // cheap stand-in drawn over the already-composited canvas (paintFlat's proxy
  // branch → drawProxyBackdrop), so NONE of them read the composite-so-far — the
  // whole-scene offscreen is unnecessary and paintIR takes the fast direct path.
  // FULL is untouched (byte-identical).
  const needsBackdrop = quality !== "proxy" && readsComposite(commands);
  if (!needsBackdrop) {
    // Fast path: no backdrop sampler ⇒ draw straight onto the caller's canvas.
    canvas.clear(bgColor);
    if (scissorRect) { canvas.save(); canvas.clipRect(scissorRect, CanvasKit.ClipOp.Intersect, true); }
    paintFlat(CanvasKit, { canvas, surface: null }, flat, view, ctx, ROOT_DEPTH);
    if (scissorRect) canvas.restore();
    return;
  }

  // Backdrop path: own an offscreen surface so samplers can read composite-so-far.
  const scene = ctx.makeSurface(ctx.deviceW, ctx.deviceH);
  if (!scene) throw new Error("paintIR(skia): makeSurface for backdrop compositing returned null");
  const sceneCanvas = scene.getCanvas();
  sceneCanvas.clear(bgColor);
  paintFlat(CanvasKit, { canvas: sceneCanvas, surface: scene }, flat, view, ctx, ROOT_DEPTH);
  scene.flush();
  const img = scene.makeImageSnapshot();
  canvas.clear(bgColor); // bars = background (transparent for the editor, opaque for the presenter letterbox)
  if (scissorRect) { canvas.save(); canvas.clipRect(scissorRect, CanvasKit.ClipOp.Intersect, true); }
  blitImage(CanvasKit, canvas, img, 1);
  if (scissorRect) canvas.restore();
  img.delete();
  scene.dispose();
}

/**
 * Pure function. Does one op read an ALREADY-COMPOSITED surface (crop or
 * snapshot) rather than re-rendering the content below it? `nested` is true
 * inside an effectSubtree's content, where the op draws on a fresh scratch and
 * must reach the OUTER composite instead.
 *
 * A SUPERSAMPLE magnifier is absent from both sets: it replays the below-LIST
 * into its own small surface and never snapshots. `materialBackdrop` is absent
 * from the top-level set for the same reason (its region is null, so it replays
 * the whole below-list) but present when nested, because inside a scratch the
 * region IS the widget footprint and cropping the outer composite is both exact
 * and far cheaper than replaying the scene.
 *
 * @example opReadsComposite({op: "blurBackdrop"}, false) // true
 * @example opReadsComposite({op: "magnifyBackdrop", supersample: true}, false) // false (it replays the below-list)
 * @example opReadsComposite({op: "materialBackdrop"}, false) // false (top level: full-surface replay)
 * @example opReadsComposite({op: "materialBackdrop"}, true) // true (nested: crops the outer composite)
 */
function opReadsComposite(cmd, nested) {
  if (cmd.op === "blurBackdrop" || cmd.op === "glassBackdrop") return true;
  if (cmd.op === "magnifyBackdrop") return !cmd.supersample;
  return nested && cmd.op === "materialBackdrop";
}

/**
 * Pure function. Must paintIR own an offscreen SCENE surface for this command
 * list — i.e. does anything in it read the composite-so-far?
 *
 * RECURSES into subtree content, which the flat top-level scan it replaced did
 * not: a sampler inside an effectSubtree needs the composite just as much as a
 * top-level one, and the omission is precisely why a backdrop widget nested in an
 * effect (a frosted panel with a drop shadow; any backdrop member of an effected
 * group) rendered as a dark smear — it snapshotted the transparent effect scratch
 * because no outer surface existed to crop.
 *
 * `cropSubtree` content draws on the SAME canvas/surface, so it inherits the
 * top-level rule; `effectSubtree` content draws on a scratch, so it takes the
 * nested rule.
 *
 * @param {object[]} commands - raw (unflattened) IR
 * @param {boolean} nested - true when scanning inside an effectSubtree's content
 * @returns {boolean}
 *
 * @example readsComposite([{op: "rect"}]) // false (fast path: no sampler)
 * @example readsComposite([{op: "blurBackdrop"}]) // true
 * @example readsComposite([{op: "effectSubtree", content: [{op: "materialBackdrop"}]}]) // true (nested sampler needs the outer composite)
 */
function readsComposite(commands, nested = false) {
  for (const cmd of commands) {
    if (opReadsComposite(cmd, nested)) return true;
    if (cmd.op === "effectSubtree" && Array.isArray(cmd.content) && readsComposite(cmd.content, true)) return true;
    if (cmd.op === "cropSubtree" && Array.isArray(cmd.content) && readsComposite(cmd.content, nested)) return true;
  }
  return false;
}

/**
 * Query. WHICH surface holds the composite-so-far for `target`, and the DEVICE
 * OFFSET from target's own device coordinates to that surface's. Inside an effect
 * scratch that is the OUTER surface (target.below, offset by the effect region
 * origin); otherwise it is the surface `target` draws on, at offset zero. Null
 * when nothing owns a surface (paintIR's fast path) — a composite-reading op then
 * throws its own loud internal-invariant error.
 *
 * @param {{surface: object|null, below?: {surface: object|null, dx: number, dy: number}}} target
 * @returns {{surface: object, dx: number, dy: number}|null}
 */
function compositeSource(target) {
  if (target.below?.surface) return target.below;
  return target.surface ? { surface: target.surface, dx: 0, dy: 0 } : null;
}

/**
 * Pure function. THE `below` context a subtree hands to its content: what a
 * backdrop sampler inside it must treat as "everything beneath me".
 *
 *   flat    — the outer below-LIST (for a sampler that REPLAYS it, e.g. a crisp
 *             supersample lens). A subtree's own content list starts empty, so
 *             without this a lens inside a crop box or an effect replayed NOTHING.
 *   surface — the composite-so-far SURFACE (for a sampler that CROPS or snapshots
 *             it), resolved through compositeSource so nesting accumulates.
 *   dx, dy  — the device offset from the CHILD's coordinates to that surface's
 *             (an effect scratch shifts by its region origin; a crop box draws on
 *             the same canvas, so it shifts by nothing).
 *
 * @param {object} target - the PARENT paint target
 * @param {object[]} belowFlat - the outer below-list at the subtree op's position
 * @param {number} dx - child→parent device x offset (0 for a crop box)
 * @param {number} dy - child→parent device y offset
 * @returns {{flat: object[], surface: object|null, dx: number, dy: number}}
 *
 * @example belowContext({canvas: {}, surface: null}, [], 0, 0) // {flat: [], surface: null, dx: 0, dy: 0}
 * @example belowContext({canvas: {}, surface: null, below: {surface: "S", dx: 5, dy: 7, flat: []}}, [], 10, 20) // {flat: [], surface: "S", dx: 15, dy: 27}
 */
function belowContext(target, belowFlat, dx, dy) {
  const outer = compositeSource(target);
  return { flat: belowFlat, surface: outer?.surface ?? null, dx: (outer?.dx ?? 0) + dx, dy: (outer?.dy ?? 0) + dy };
}

/**
 * Command (draws on target.canvas). Walks the FLATTENED command list, drawing
 * each op in its already-resolved `world`. Leaf ops draw in local space (the
 * view+world CTM); backdrop/subtree ops are handled from the device root
 * (between-op state) where they control their own transforms and clips.
 *
 * Args:
 *   target ({canvas, surface, below?}): the canvas to draw on, the Surface
 *     backing it (surface is null on the fast path; backdrop samplers require
 *     one), and — inside an effect scratch — the `below` context that names the
 *     OUTER composite surface, its device offset, and the outer below-LIST
 *     (see handleEffectSubtree).
 *   flat (object[]): flattenIR output — [{cmd, world}]
 *   depth ({lens, subtree}): re-render nesting levels (the two budgets above)
 */
function paintFlat(CanvasKit, target, flat, view, ctx, depth) {
  const canvas = target.canvas;
  const proxy = ctx.quality === "proxy";
  // "Below" (z-order) for a backdrop sampler at index i = everything emitted
  // before it AT THIS LEVEL, prefixed — inside an effect scratch — by the outer
  // below-list, because the scratch itself holds nothing but the effected widget.
  const belowOf = (i) => (target.below ? [...target.below.flat, ...flat.slice(0, i)] : flat.slice(0, i));
  for (let i = 0; i < flat.length; i++) {
    const { cmd, world } = flat[i];
    // PROXY: replace every backdrop sampler with a cheap stand-in over the
    // already-composited canvas (proxy forces the fast direct path, so the
    // below-content is already painted on `canvas` here) — no composite read, no
    // re-render, no full-screen blur/SkSL. FULL never enters this branch.
    if (proxy && PROXY_BACKDROP_OPS.has(cmd.op)) {
      drawProxyBackdrop(CanvasKit, canvas, cmd, view, world, ctx);
      continue;
    }
    // PROXY: EVERY generative materialFill is replaced by a cheap Skia stand-in
    // (materials.resolveProxyFill → a solid/linear/radial fill; the material's own
    // proxyFill if it declares one, else a representative flat default) — NO SkSL
    // compile or per-pixel raster on the thumbnail/minimap software surface. This is
    // UNIVERSAL (not an allowlist), so a future materialFill can never silently
    // regress thumbnails. FULL never enters this branch.
    if (proxy && cmd.op === "materialFill") {
      drawProxyMaterialFill(CanvasKit, canvas, cmd, view, world, ctx);
      continue;
    }
    // PROXY: EVERY per-pixel effect pass is dropped (drawProxyEffect keeps only
    // the widget, its opacity, its blend mode, and a drop shadow big enough to
    // show at this size). Like the materialFill stand-in this is UNIVERSAL, not an
    // allowlist — the reduced op is built field by field, so a SIXTH effect added
    // to effectSubtree is dropped here by default and can never silently blow up
    // thumbnails. FULL never enters this branch.
    if (proxy && cmd.op === "effectSubtree") {
      drawProxyEffect(CanvasKit, target, cmd, world, view, ctx, depth, belowOf(i));
      continue;
    }
    switch (cmd.op) {
      case "blurBackdrop":
        handleBlurBackdrop(CanvasKit, target, cmd, world, view);
        break;
      case "magnifyBackdrop":
        handleMagnifyBackdrop(CanvasKit, target, cmd, world, view, belowOf(i), ctx, depth);
        break;
      case "glassBackdrop":
        handleGlassBackdrop(CanvasKit, target, cmd, world, view, belowOf(i), ctx, depth);
        break;
      case "materialBackdrop":
        // A registry-dispatched SkSL material (generalizes glass).
        handleMaterialBackdrop(CanvasKit, target, cmd, world, view, belowOf(i), ctx, depth);
        break;
      case "materialFill":
        // A FOREGROUND registry material (the corkboard family): makeShader + fill,
        // NO backdrop re-render, NO children. The additive sibling of materialBackdrop.
        handleMaterialFill(CanvasKit, target, cmd, world, view, ctx);
        break;
      case "videoV2": {
        // V2 direct-upload video: draws in local space like a leaf (save +
        // applyView), but resolves its OWN texture-backed frame through
        // render_gpu/skia/video_v2.js (self-resolving — NOT via ctx.media, which
        // browser_media.js never populates for this op) using ctx.liveGpu +
        // ctx.makeSurface. Additive; leaves the default leaf branch untouched.
        canvas.save();
        applyView(canvas, view, world);
        drawVideoV2(CanvasKit, canvas, cmd, cmd.opacity ?? 1, ctx);
        canvas.restore();
        break;
      }
      case "cropSubtree":
        handleCropSubtree(CanvasKit, target, cmd, world, view, ctx, depth, belowOf(i));
        break;
      case "effectSubtree":
        handleEffectSubtree(CanvasKit, target, cmd, world, view, ctx, depth, belowOf(i));
        break;
      default: {
        const opacity = cmd.opacity ?? 1;
        canvas.save();
        applyView(canvas, view, world);
        drawLeafOp(CanvasKit, canvas, cmd, opacity, ctx.media, ctx.fontCollection, ctx.antialias, ctx.quality);
        canvas.restore();
      }
    }
  }
}

/** Command (mutates `canvas` CTM). Applies view+world so local geometry lands in device px (mirrors ir_canvas2d.js). */
function applyView(canvas, view, world) {
  const ds = view.zoom * view.dpr;
  canvas.translate(view.panX * view.dpr, view.panY * view.dpr);
  canvas.scale(ds, ds);
  canvas.translate(world.x, world.y);
  canvas.rotate(world.rotation * RAD2DEG, 0, 0);
  canvas.scale(world.scale, world.scale);
}

/**
 * Pure-ish helper. The local→device 3x3 matrix for (view, world) — the same
 * mapping applyView builds incrementally, as a CanvasKit.Matrix so a path can
 * be transformed into device space (for clips that must survive a CTM reset).
 */
function deviceMatrix(CanvasKit, view, world) {
  const ds = view.zoom * view.dpr;
  return CanvasKit.Matrix.multiply(
    CanvasKit.Matrix.translated(view.panX * view.dpr, view.panY * view.dpr),
    CanvasKit.Matrix.scaled(ds, ds),
    CanvasKit.Matrix.translated(world.x, world.y),
    CanvasKit.Matrix.rotated(world.rotation),
    CanvasKit.Matrix.scaled(world.scale, world.scale),
  );
}

/** Command (draws one leaf op on `canvas` in its already-transformed local
 *  space). `aa` is the camera's per-draw coverage-AA flag (ctx.antialias) —
 *  threaded into every fill/stroke/text paint so "off" produces crisp edges.
 *  `quality` ("full"|"proxy", ctx.quality) only bites on the image/video op: proxy
 *  samples through a mip chain to cap the raster-read resolution at thumbnail size. */
function drawLeafOp(CanvasKit, canvas, cmd, opacity, media, fontCollection, aa = true, quality = "full") {
  switch (cmd.op) {
    case "rect": {
      const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius, cmd.cornerRadius);
      const bounds = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };
      if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds, aa), (p) => canvas.drawRRect(rr, p));
      if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds, aa), (p) => canvas.drawRRect(rr, p));
      break;
    }
    case "ellipse": {
      const oval = CanvasKit.LTRBRect(cmd.cx - cmd.rx, cmd.cy - cmd.ry, cmd.cx + cmd.rx, cmd.cy + cmd.ry);
      const bounds = { x: cmd.cx - cmd.rx, y: cmd.cy - cmd.ry, w: 2 * cmd.rx, h: 2 * cmd.ry };
      if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds, aa), (p) => canvas.drawOval(oval, p));
      if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds, aa), (p) => canvas.drawOval(oval, p));
      break;
    }
    case "polyline": {
      const path = buildPath(CanvasKit, cmd.points, false);
      const p = strokePaint(CanvasKit, cmd.color, cmd.width, opacity, null, aa);
      p.setStrokeCap(CanvasKit.StrokeCap.Round);
      p.setStrokeJoin(CanvasKit.StrokeJoin.Round);
      canvas.drawPath(path, p);
      path.delete(); p.delete();
      break;
    }
    case "polygon": {
      const path = buildPath(CanvasKit, cmd.points, true);
      withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, pointsBounds(cmd.points), aa), (p) => canvas.drawPath(path, p));
      path.delete();
      break;
    }
    case "path":
      drawPathOp(CanvasKit, canvas, cmd, opacity, aa);
      break;
    case "text":
      drawTextOp(CanvasKit, canvas, cmd, opacity, fontCollection, aa);
      break;
    case "image":
    case "video":
    // V5 off-main-thread video: SAME quad draw as `video` (same op shape, same
    // media[ref] lookup) — only the media-resolution source differs (V5's own
    // registry populates media[ref] in browser_media.sceneMedia). Additive.
    case "videoV5": {
      const img = media[cmd.ref];
      // Absent media ⇒ draw NOTHING this frame (the async media contract): a
      // genuinely FAILED asset is reported loudly by image_registry/video_registry
      // (console.error), and an UNDECODED one is the normal in-flight state that
      // repaints when it lands (onImageLoad/onVideoFrame nudge the reactive
      // canvas). The caller-side media builder (skia/browser_media.js) omits an
      // unresolved ref for exactly this reason — never a placeholder, never a
      // blocking wait — matching the SVG/PDF backends' "blank ref → draw nothing".
      if (!img) break;
      drawSampledQuad(CanvasKit, canvas, img, cmd, opacity, quality);
      break;
    }
    case "videoFrame": {
      // The scrubber's deterministic frame-at-time. Same quad draw as image/
      // video, but resolved through the (ref+time+wrap) media key so two
      // scrubbers on one source at DIFFERENT times don't collide. Absent media
      // ⇒ draw nothing (the async seek contract): getScrubFrame kicked the seek
      // and video_registry.notify() will nudge a repaint when the frame lands.
      const img = media[scrubFrameKey(cmd.ref, cmd.seekTime, cmd.wrap)];
      if (!img) break;
      drawSampledQuad(CanvasKit, canvas, img, cmd, opacity, quality);
      break;
    }
    case "videoV5Frame": {
      // The V5 scrubber's deterministic frame-at-time — the A/B twin of
      // videoFrame, resolved through the "v5|"-prefixed videoV5FrameKey so it
      // never collides with a core scrubber on the same (ref, time, wrap): the
      // two are decoded by separate pipelines (V5's off-main-thread scrub
      // decoder) into separate caches. Absent media ⇒ draw nothing (the async
      // seek contract): getVideoV5ScrubFrame kicked the seek and video_v5's
      // notify() will nudge a repaint when the frame lands.
      const img = media[videoV5FrameKey(cmd.ref, cmd.seekTime, cmd.wrap)];
      if (!img) break;
      drawSampledQuad(CanvasKit, canvas, img, cmd, opacity, quality);
      break;
    }
    case "latexVector":
      drawLatexVector(CanvasKit, canvas, cmd, opacity, aa);
      break;
    case "mermaidVector":
      drawMermaidVector(CanvasKit, canvas, cmd, opacity, fontCollection, aa);
      break;
    default:
      throw new Error(`paintIR(skia): unknown op "${cmd.op}"`);
  }
}

/**
 * Command. Draws ONE image `img` as a sampled quad — the shared body of the
 * image / video / videoV5 / videoFrame / videoV5Frame cases (all identical: a
 * source sub-rect of `img` mapped to the dest box at `opacity`; only the
 * media-map lookup that produced `img` differs). `cmd.src` is the normalized
 * source rect ({sx, sy, sw, sh} in [0,1]) that ir.sourceRect built.
 *
 * PROXY caps the raster-read resolution: sampling THROUGH a mip chain (Linear
 * filter + Linear mipmap) minifies a large source page/photo from a coarser
 * level to the tiny thumbnail dest instead of reading every source texel per
 * output pixel — cheaper for the big downscales thumbnails do, and no visible
 * loss at ~100px (trilinear ≥ single-level linear on a downscale). FULL keeps
 * the exact drawImageRect(fastSample=false) it always used.
 *
 * @param cmd a draw op carrying {x, y, w, h, src:{sx, sy, sw, sh}}
 * @param opacity {number} folded into the paint's alpha
 * @param quality {"full"|"proxy"} raster-read fidelity (see above)
 */
function drawSampledQuad(CanvasKit, canvas, img, cmd, opacity, quality) {
  const iw = img.width(), ih = img.height();
  const s = cmd.src;
  const src = CanvasKit.LTRBRect(s.sx * iw, s.sy * ih, (s.sx + s.sw) * iw, (s.sy + s.sh) * ih);
  const dest = CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h);
  const p = new CanvasKit.Paint();
  p.setAlphaf(opacity);
  if (quality === "proxy") canvas.drawImageRectOptions(img, src, dest, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.Linear, p);
  else canvas.drawImageRect(img, src, dest, p, false);
  p.delete();
}

/**
 * Command (draws one generic vector-path op — Wave 2). Parses `d` (local-space
 * SVG path) via CanvasKit.Path.MakeFromSVGString (the proven latexVector path),
 * sets the winding rule for the fill (Winding == nonzero, the SkPath default;
 * EvenOdd for holed/star fills), then fills and/or strokes with the SAME shared
 * paint helpers as rect/ellipse (opacity folded into each paint's alpha). The
 * op is transform-applied by the caller, so `d` draws in the current local
 * space with no extra matrix here.
 */
function drawPathOp(CanvasKit, canvas, cmd, opacity, aa = true) {
  const skPath = CanvasKit.Path.MakeFromSVGString(cmd.d);
  if (!skPath) throw new Error(`paintIR(skia): path "d" failed to parse: ${JSON.stringify(cmd.d).slice(0, 64)}`);
  skPath.setFillType(cmd.fillRule === "evenodd" ? CanvasKit.FillType.EvenOdd : CanvasKit.FillType.Winding);
  // Gradient objectBoundingBox = the path's own tight bounds (getBounds → [l,t,r,b]).
  const gb = skPath.getBounds();
  const bounds = { x: gb[0], y: gb[1], w: gb[2] - gb[0], h: gb[3] - gb[1] };
  // Optional soft MASK blur (the additive `blur` field — a general soft-path
  // enhancement the corkboard YARN uses for its cast shadow). Sigma is in LOCAL
  // units; respectCTM=true lets Skia scale it to device px by the CTM, so the
  // softness tracks zoom. blur 0 (the default) ⇒ no filter, crisp as before.
  const maskBlur = cmd.blur > 0 ? CanvasKit.MaskFilter.MakeBlur(CanvasKit.BlurStyle.Normal, cmd.blur, true) : null;
  const drawWith = (p) => { if (maskBlur) p.setMaskFilter(maskBlur); canvas.drawPath(skPath, p); };
  if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds, aa), drawWith);
  if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds, aa), drawWith);
  if (maskBlur) maskBlur.delete();
  skPath.delete();
}

/**
 * Command (draws glyph vector paths). Each glyph's `d` (SVG path in `viewBox`
 * space) is drawn filled through a viewBox→box mapping (a straight box→box
 * scale, y-down already). The raster `ref` is ignored — this is the crisp
 * vector path the SVG/PDF backends also consume. Fill uses each glyph's own
 * color; nonzero winding (MathJax counters are reverse-wound), which is
 * SkPath's default from MakeFromSVGString.
 */
function drawLatexVector(CanvasKit, canvas, cmd, opacity, aa = true) {
  const { viewBox, glyphs } = cmd;
  // preserveAspect (default): UNIFORM scale-to-FIT the equation into the box,
  // centered (letterbox) — no aspect squash. Otherwise a non-uniform box→box
  // stretch (the legacy path, kept for preserveAspect === false).
  let sx, sy, ox = 0, oy = 0;
  if (cmd.preserveAspect !== false) {
    const f = fitBox(viewBox.w, viewBox.h, cmd.w, cmd.h);
    sx = sy = f.scale; ox = f.offsetX; oy = f.offsetY;
  } else {
    sx = cmd.w / viewBox.w; sy = cmd.h / viewBox.h;
  }
  canvas.save();
  canvas.translate(cmd.x + ox, cmd.y + oy);
  canvas.scale(sx, sy);
  canvas.translate(-viewBox.minX, -viewBox.minY);
  for (const g of glyphs) {
    const path = CanvasKit.Path.MakeFromSVGString(g.d);
    if (!path) throw new Error(`paintIR(skia): latexVector glyph "d" failed to parse: ${JSON.stringify(g.d).slice(0, 64)}`);
    const rgba = parseColor(g.fill);
    const p = new CanvasKit.Paint();
    p.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * opacity));
    p.setStyle(CanvasKit.PaintStyle.Fill);
    p.setAntiAlias(aa);
    canvas.drawPath(path, p);
    p.delete(); path.delete();
  }
  canvas.restore();
}

/**
 * Command (draws a flattened Mermaid diagram as crisp vector — the mirror of
 * drawLatexVector). Establishes the SAME viewBox→box mapping (preserveAspect ⇒
 * centered uniform fitBox scale; else box→box stretch), then draws each vector
 * `path` (fill and/or stroke, per-path CSS colors parsed here, fillRule honored,
 * group + per-path opacity folded into the paint alpha) followed by each `text`
 * label (through the SHARED text layout, so it uses the same font stack + stays
 * razor-sharp under the scaled CTM — Skia rasterizes glyphs in device space).
 * The raster `ref` is ignored here (it exists only for the hybrid raster split
 * that hands a mermaid UNDER a blur to the rasterize callback). Paths are drawn
 * before texts so labels sit ON TOP of their node fills.
 */
function drawMermaidVector(CanvasKit, canvas, cmd, opacity, fontCollection, aa = true) {
  const { viewBox, paths, texts } = cmd;
  let sx, sy, ox = 0, oy = 0;
  if (cmd.preserveAspect !== false) {
    const f = fitBox(viewBox.w, viewBox.h, cmd.w, cmd.h);
    sx = sy = f.scale; ox = f.offsetX; oy = f.offsetY;
  } else {
    sx = cmd.w / viewBox.w; sy = cmd.h / viewBox.h;
  }
  canvas.save();
  canvas.translate(cmd.x + ox, cmd.y + oy);
  canvas.scale(sx, sy);
  canvas.translate(-viewBox.minX, -viewBox.minY);
  for (const p of paths) {
    const skPath = CanvasKit.Path.MakeFromSVGString(p.d);
    if (!skPath) throw new Error(`paintIR(skia): mermaidVector path "d" failed to parse: ${JSON.stringify(p.d).slice(0, 64)}`);
    skPath.setFillType(p.fillRule === "evenodd" ? CanvasKit.FillType.EvenOdd : CanvasKit.FillType.Winding);
    const op = opacity * (p.opacity ?? 1);
    if (p.fill) {
      const rgba = parseColor(p.fill);
      const paint = new CanvasKit.Paint();
      paint.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * op));
      paint.setStyle(CanvasKit.PaintStyle.Fill);
      paint.setAntiAlias(aa);
      canvas.drawPath(skPath, paint);
      paint.delete();
    }
    if (p.stroke && p.strokeWidth > 0) {
      const rgba = parseColor(p.stroke);
      const paint = new CanvasKit.Paint();
      paint.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * op));
      paint.setStyle(CanvasKit.PaintStyle.Stroke);
      paint.setStrokeWidth(p.strokeWidth);
      paint.setAntiAlias(aa);
      canvas.drawPath(skPath, paint);
      paint.delete();
    }
    skPath.delete();
  }
  for (const t of texts) {
    // A single-run text op the shared layout understands (top-left origin at
    // t.x/t.y in viewBox space; no wrap). Per-text opacity folds with the group.
    const layout = getTextLayout(CanvasKit, fontCollection, { text: t.text, x: t.x, y: t.y, size: t.size, color: t.color, bold: t.bold, font: t.font }, opacity * (t.opacity ?? 1));
    layout.draw(canvas, t.x, t.y, aa);
  }
  canvas.restore();
}

// ── backdrop samplers (read composite-so-far) ─────────────────────────────────

/**
 * Command (draws on target.canvas). blurBackdrop: Gaussian-blurs the whole
 * composite-so-far and composites it back at `opacity`. Snapshots the owned
 * surface, resets to device space (drawImage is at the device root here — no
 * CTM), and redraws blurred. sigma_device = radius·world.scale·zoom·dpr (the
 * ir_canvas2d.js `blur()` convention; CSS blur radius == Gaussian sigma).
 *
 * PARITY NOTE: uses TileMode.Clamp (matches the GPU compositor's edge behavior)
 * rather than the transparent-edge CSS `filter:blur()` of the canvas2d bench —
 * avoids a darkened frame border on a full-screen blur.
 *
 * INSIDE AN EFFECT SCRATCH (a blur layer that is a member of an effected group)
 * the composite lives on the OUTER surface, so the snapshot comes from
 * compositeSource and is drawn shifted by -(dx, dy) — that lands outer device
 * (dx, dy) at the scratch origin, which is where the scratch's own device (0, 0)
 * is. Offset zero on the normal path ⇒ byte-identical.
 */
function handleBlurBackdrop(CanvasKit, target, cmd, world, view) {
  const src = compositeSource(target);
  if (!src) throw new Error("paintIR(skia): blurBackdrop requires an owned offscreen surface (internal invariant)");
  src.surface.flush();
  const snap = src.surface.makeImageSnapshot();
  const sigma = cmd.radius * world.scale * view.zoom * view.dpr;
  const p = new CanvasKit.Paint();
  p.setAlphaf(cmd.opacity ?? 1);
  let filt = null;
  if (sigma > 0) {
    filt = CanvasKit.ImageFilter.MakeBlur(sigma, sigma, CanvasKit.TileMode.Clamp, null);
    p.setImageFilter(filt);
  }
  target.canvas.drawImage(snap, -src.dx, -src.dy, p);
  p.delete();
  if (filt) filt.delete();
  snap.delete();
}

/**
 * Command (draws on target.canvas). magnifyBackdrop: a shaped lens (circle|box|
 * star) showing a magnified view about the ORIGIN.
 *
 *   supersample:true (default) — RE-RENDER the sub-list below the lens (z-order)
 *     into a scratch surface under the lens view (magnification·zoom about the
 *     origin, origin pinned at the lens center), then blit it 1:1 through the
 *     lens clip. This is the CRISP flagship path. Depth-capped: a lens inside a
 *     lens replay (depth ≥ MAX_SUPERSAMPLE_DEPTH) falls back to sampling.
 *   supersample:false — sample the composite-so-far, scaled by magnification
 *     about the origin (soft: an upscaled backdrop, ~1/M screen resolution).
 *
 * The lens clip is built in local space and transformed to device px (rotation
 * & scale safe). The rim/border is drawn last, in local space, on top.
 */
function handleMagnifyBackdrop(CanvasKit, target, cmd, world, view, belowFlat, ctx, depth) {
  const canvas = target.canvas;
  const opacity = cmd.opacity ?? 1;
  const centerWorld = T.apply(world, cmd.cx, cmd.cy);
  const originWorld = T.apply(world, cmd.originX, cmd.originY);
  const clip = lensClipPath(CanvasKit, cmd, deviceMatrix(CanvasKit, view, world));
  // Per-axis zoom (default to the isotropic magnification). aniso === false ⇒
  // the ISOTROPIC path runs unchanged (byte-identical to pre-anisotropy).
  const magX = cmd.magnificationX ?? cmd.magnification;
  const magY = cmd.magnificationY ?? cmd.magnification;
  const aniso = magX !== magY;

  if (cmd.supersample && depth.lens < MAX_SUPERSAMPLE_DEPTH) {
    // Crisp AND CHEAP: re-render the below-list ONLY within the lens footprint —
    // its device AABB clipped to the viewport, never the whole scene — into a
    // small GPU-backed scratch surface, then draw it back at the footprint,
    // clipped to the lens shape. This is render() applied to just the pixels the
    // lens needs (a small loupe on a huge canvas costs a small render, not two
    // full-device software renders).
    const cb = clip.getBounds(); // device-px AABB of the lens region [l,t,r,b]
    const x0 = Math.max(0, Math.floor(cb[0])), y0 = Math.max(0, Math.floor(cb[1]));
    const x1 = Math.min(ctx.deviceW, Math.ceil(cb[2])), y1 = Math.min(ctx.deviceH, Math.ceil(cb[3]));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw > 0 && rh > 0) {
      const sub = ctx.makeSurface(rw, rh);
      if (!sub) throw new Error("paintIR(skia): makeSurface for lens re-render returned null");
      sub.getCanvas().clear(CanvasKit.Color4f(0, 0, 0, 0));
      if (aniso) {
        // Anisotropic: rasterize the below-list ONCE under a per-axis scale about
        // the origin (crisp on BOTH axes — no isotropic view, no texture
        // resampling). Pre-concat translate(-x0,-y0)·[centerDev]·scale(magX,magY)·
        // [-originDev] onto the scratch canvas, then paint with the BASE view; each
        // op's applyView composes with this, so vector ops rasterize at the true
        // (magX·zoom, magY·zoom) device resolution and fill the lens footprint.
        const ds = view.zoom * view.dpr;
        const centerDev = { x: centerWorld.x * ds + view.panX * view.dpr, y: centerWorld.y * ds + view.panY * view.dpr };
        const originDev = { x: originWorld.x * ds + view.panX * view.dpr, y: originWorld.y * ds + view.panY * view.dpr };
        const subCanvas = sub.getCanvas();
        subCanvas.concat(CanvasKit.Matrix.multiply(
          CanvasKit.Matrix.translated(-x0, -y0),
          CanvasKit.Matrix.translated(centerDev.x, centerDev.y),
          CanvasKit.Matrix.scaled(magX, magY),
          CanvasKit.Matrix.translated(-originDev.x, -originDev.y),
        ));
        paintFlat(CanvasKit, { canvas: subCanvas, surface: sub }, belowFlat, view, ctx, deeperLens(depth));
      } else {
        const lensView = lensViewFor(view, centerWorld, magX, originWorld);
        // Shift the lens view so device (x0,y0) maps to the small surface's origin.
        const shifted = { ...lensView, panX: lensView.panX - x0 / view.dpr, panY: lensView.panY - y0 / view.dpr };
        paintFlat(CanvasKit, { canvas: sub.getCanvas(), surface: sub }, belowFlat, shifted, ctx, deeperLens(depth));
      }
      sub.flush();
      const lensImg = sub.makeImageSnapshot();
      canvas.save();
      canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
      const p = new CanvasKit.Paint();
      p.setAlphaf(opacity);
      canvas.drawImage(lensImg, x0, y0, p); // footprint origin, not (0,0)
      p.delete();
      canvas.restore();
      lensImg.delete();
      sub.dispose();
    }
  } else {
    // Soft: sample the composite-so-far, magnified about the origin. scale(magX,
    // magY) — with magX === magY this is the isotropic scale(M, M), byte-identical.
    // compositeSource resolves WHICH surface holds that composite: the outer one
    // when this lens sits inside an effect scratch (offset zero otherwise, so the
    // ordinary path is untouched).
    const src = compositeSource(target);
    if (!src) throw new Error("paintIR(skia): magnifyBackdrop sampling requires an owned offscreen surface");
    src.surface.flush();
    const snap = src.surface.makeImageSnapshot();
    const ds = view.zoom * view.dpr;
    const centerDev = { x: centerWorld.x * ds + view.panX * view.dpr, y: centerWorld.y * ds + view.panY * view.dpr };
    const originDev = { x: originWorld.x * ds + view.panX * view.dpr, y: originWorld.y * ds + view.panY * view.dpr };
    canvas.save();
    canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
    // Device pixel q inside the lens samples the backdrop at
    // origin + (q − center)/mag ⇒ draw the snapshot under q = center + (s − origin)·diag(magX,magY).
    canvas.concat(CanvasKit.Matrix.multiply(
      CanvasKit.Matrix.translated(centerDev.x, centerDev.y),
      CanvasKit.Matrix.scaled(magX, magY),
      CanvasKit.Matrix.translated(-originDev.x, -originDev.y),
    ));
    const p = new CanvasKit.Paint();
    p.setAlphaf(opacity);
    // Placing the snapshot at -(dx, dy) makes outer texel (dx, dy) the scratch's
    // own device origin, so the sampling relation above holds unchanged in the
    // scratch's coordinates. (0, 0) on the normal path.
    canvas.drawImageOptions(snap, -src.dx, -src.dy, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, p);
    p.delete();
    canvas.restore();
    snap.delete();
  }
  clip.delete();
  drawLensBorder(CanvasKit, canvas, cmd, view, world, opacity, ctx.antialias);
}

/**
 * Pure-ish helper. The lens view (mirrors gpu/compositor.js lensRenderView):
 * magnify about `originWorld`, positioned so the origin renders where the lens
 * center sits. Default origin == center reduces to magnify-about-center.
 *
 * @example lensViewFor({zoom: 1, panX: 0, panY: 0, dpr: 1}, {x: 100, y: 50}, 2, {x: 100, y: 50}) // {zoom: 2, panX: -100, panY: -50, dpr: 1}
 */
function lensViewFor(view, centerWorld, magnification, originWorld) {
  return {
    zoom: view.zoom * magnification,
    panX: view.panX + centerWorld.x * view.zoom - originWorld.x * view.zoom * magnification,
    panY: view.panY + centerWorld.y * view.zoom - originWorld.y * view.zoom * magnification,
    dpr: view.dpr,
  };
}

/**
 * Pure function. The LOCAL-space vertices of a STAR lens silhouette: an n-pointed
 * star inscribed in the (halfW, halfH) box centered at (cx, cy), pointing up — the
 * SAME geometry as core/shapes.js starPathD (outer tips on the box ellipse, inner
 * notches scaled by innerRatio). Reuses ellipsePoints for the outer ring so the
 * lens clip matches the star widget's outline exactly (shared angle math). Returns
 * 2·points vertices, outer/inner alternating (even = tip, odd = notch).
 *
 * @param {{cx:number,cy:number,halfW:number,halfH:number,points:number,innerRatio:number}} cmd
 * @returns {Array<[number,number]>}
 *
 * @example lensStarPoints({cx: 50, cy: 50, halfW: 50, halfH: 50, points: 5, innerRatio: 0.5}).length // 10
 * @example lensStarPoints({cx: 50, cy: 50, halfW: 50, halfH: 50, points: 5, innerRatio: 0.5})[0].map(Math.round) // [50, 0] (top tip)
 */
function lensStarPoints(cmd) {
  const ring = ellipsePoints(cmd.halfW * 2, cmd.halfH * 2, cmd.points * 2); // outer tips, TOP_UP start
  const ecx = cmd.halfW, ecy = cmd.halfH;      // ellipsePoints' own bbox center
  const dx = cmd.cx - ecx, dy = cmd.cy - ecy;  // shift the star to the lens center
  return ring.map(([x, y], i) => {
    const s = i % 2 === 0 ? 1 : cmd.innerRatio; // even = outer tip, odd = inner notch
    return [ecx + (x - ecx) * s + dx, ecy + (y - ecy) * s + dy];
  });
}

/** Query→build. The lens region as a device-space Path (circle, rounded box, or
 * star silhouette). Caller deletes. */
function lensClipPath(CanvasKit, cmd, deviceM) {
  const b = new CanvasKit.PathBuilder();
  if (cmd.shape === "box") {
    b.addRRect(CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius));
  } else if (cmd.shape === "star") {
    const v = lensStarPoints(cmd);
    b.moveTo(v[0][0], v[0][1]);
    for (let i = 1; i < v.length; i++) b.lineTo(v[i][0], v[i][1]);
    b.close();
  } else {
    b.addOval(CanvasKit.LTRBRect(cmd.cx - cmd.r, cmd.cy - cmd.r, cmd.cx + cmd.r, cmd.cy + cmd.r));
  }
  b.transform(deviceM);
  const path = b.detach();
  b.delete();
  return path;
}

/** Command (draws the lens rim/border in local space). ONE stroke ring for EVERY
 * shape (circle | box | star) — the collapsed stroke/strokeWidth bundle (ir.js
 * folded the legacy rim). `aa` is the camera's coverage-AA flag (ctx.antialias). */
function drawLensBorder(CanvasKit, canvas, cmd, view, world, opacity, aa = true) {
  const color = cmd.stroke;
  const width = cmd.strokeWidth;
  if (!color || !(width > 0)) return;
  canvas.save();
  applyView(canvas, view, world);
  const p = strokePaint(CanvasKit, color, width, opacity, null, aa);
  if (cmd.shape === "box") {
    const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius);
    canvas.drawRRect(rr, p);
  } else if (cmd.shape === "star") {
    const path = buildPath(CanvasKit, lensStarPoints(cmd), true);
    canvas.drawPath(path, p);
    path.delete();
  } else {
    canvas.drawOval(CanvasKit.LTRBRect(cmd.cx - cmd.r, cmd.cy - cmd.r, cmd.cx + cmd.r, cmd.cy + cmd.r), p);
  }
  p.delete();
  canvas.restore();
}

// ── Liquid Glass (the FIRST live SkSL RuntimeEffect) ──────────────────────────
// macOS "Liquid Glass" material: sample the composite-so-far, build a blurred
// copy, and draw the rounded-rect region through a RuntimeEffect whose children
// are {blurredBackdrop, sharpBackdrop}. The SkSL (glass_shader.js) does the edge-
// weighted refraction + luminance-adaptive tint + top-light specular + squircle
// corners. Compiled + cached ONCE per CanvasKit instance.

let _glassEffect = null;   // cached compiled RuntimeEffect
let _glassEffectCK = null; // the CanvasKit instance it was compiled against

// Drop-shadow tuning (device px, expressed relative to the panel so it scales
// with size). Light is from above ⇒ the shadow sits below the panel. Its DARKNESS
// is the per-widget cmd.shadowStrength; these fix its softness/offset shape.
const GLASS_SHADOW_SIGMA_FRAC = 0.22; // blur σ as a fraction of the panel half-height (soft, diffuse)
const GLASS_SHADOW_DY_FRAC = 0.12;    // downward offset as a fraction of half-height
const GLASS_SHADOW_APPEAR_END = 0.8;  // matches the SkSL APPEAR_END: the shadow fades in with the skin

/**
 * Query→build (compiles once, memoized per CanvasKit instance). Returns the
 * compiled glass RuntimeEffect. Throws LOUDLY with the SkSL compiler error on
 * failure (no silent fallback) — a shader that will not compile is a hard bug.
 */
function glassEffect(CanvasKit) {
  if (_glassEffect && _glassEffectCK === CanvasKit) return _glassEffect;
  let err = null;
  const eff = CanvasKit.RuntimeEffect.Make(GLASS_SKSL, (e) => { err = e; });
  if (!eff) throw new Error(`paintIR(skia): Liquid Glass SkSL failed to compile:\n${err}`);
  _glassEffect = eff;
  _glassEffectCK = CanvasKit;
  return eff;
}

/**
 * Command (draws on target.canvas). glassBackdrop: RE-RENDER the below-content
 * (z-order sub-list) at the chosen RESOLUTION FACTOR (cmd.backdropScale) into a
 * scratch surface = the SHARP backdrop; build a Gaussian-blurred copy = the frost;
 * draw a soft drop shadow under; then draw the rounded-rect region with the glass
 * SkSL, whose children are {blurred, sharp} device-space image shaders. Drawn at
 * the DEVICE ROOT (no CTM) — the shader's SDF + the child image shaders all work
 * in device px; world→device geometry (center, half-size, rotation) + world→device
 * length scaling (value·world.scale·zoom·dpr, the blurBackdrop convention) are
 * computed here and packed into the uniforms.
 *
 * The below-content re-render is depth-capped (MAX_SUPERSAMPLE_DEPTH, the shared
 * lens bound): glass NESTED inside a re-render falls back to sampling the surface
 * it is drawing into (guaranteed non-null at depth ≥ 1). This mirrors the
 * supersample magnifier exactly.
 */
function handleGlassBackdrop(CanvasKit, target, cmd, world, view, belowFlat, ctx, depth) {
  const canvas = target.canvas;
  const opacity = cmd.opacity ?? 1;

  // Device-space geometry (a similarity transform: center + rotated box + uniform
  // scale). ds = zoom·dpr (position); sd = world.scale·ds (world length → device px).
  const ds = view.zoom * view.dpr;
  const sd = world.scale * ds;
  const centerWorld = T.apply(world, cmd.cx, cmd.cy);
  const cxDev = centerWorld.x * ds + view.panX * view.dpr;
  const cyDev = centerWorld.y * ds + view.panY * view.dpr;
  const halfWDev = cmd.halfW * sd, halfHDev = cmd.halfH * sd;
  const cornerDev = cmd.cornerRadius * sd;
  const edgeFalloffDev = cmd.edgeFalloff * sd;
  const refractionDev = cmd.refractionStrength * sd;
  const blurSigma = cmd.blurRadius * sd;
  const angle = world.rotation;

  // The minimal device-px backdrop region this panel actually samples (panel
  // circumradius + refraction/chromatic/blur reach, clamped to the surface). The
  // backdrop is rendered/cropped + blurred over ONLY this box, not the whole
  // device surface — the primary perf win. null ⇒ the panel is entirely
  // off-surface, so nothing (backdrop, shader, shadow, border) is visible.
  const region = glassRegion(cxDev, cyDev, halfWDev, halfHDev, refractionDev, cmd.chromatic, blurSigma, ctx.deviceW, ctx.deviceH);
  if (!region) return;

  // (1)+(2) the backdrop images (sharp + blurred) + the localMatrix that maps a
  // DEVICE coordinate to the (possibly scaled) backdrop image's pixel space.
  const bd = glassBackdropImages(CanvasKit, target, belowFlat, view, ctx, depth, cmd.backdropScale, blurSigma, region);

  // (3) soft drop shadow UNDER the panel (drawn AFTER the backdrop images so it
  // never bleeds into the refracted backdrop the shader samples).
  drawGlassShadow(CanvasKit, canvas, cxDev, cyDev, halfWDev, halfHDev, cornerDev, angle, cmd.materialize, cmd.shadowStrength);

  // (4) the glass shader — children {blurred, sharp}.
  const effect = glassEffect(CanvasKit);
  const blurChild = bd.blurred.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, bd.sampleMatrix);
  const sharpChild = bd.sharp.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, bd.sampleMatrix);
  const tint = cmd.tint === null ? [0, 0, 0, 0] : parseColor(cmd.tint); // paint → representative solid rgba; null ⇒ no skin
  const uniforms = packGlassUniforms({
    cx: cxDev, cy: cyDev, halfW: halfWDev, halfH: halfHDev,
    cornerRadius: cornerDev, edgeFalloff: edgeFalloffDev, refractionStrength: refractionDev,
    angle, lightAngle: cmd.lightAngle, lightIntensity: cmd.lightIntensity,
    saturation: cmd.saturation, tint, materialize: cmd.materialize,
    squircle: cmd.squircle, sheen: cmd.sheen, specPower: cmd.specularPower,
    contactShadow: cmd.contactShadow, caustic: cmd.caustic, edgeLight: cmd.edgeLight,
    adaptivity: cmd.tintAdaptivity, chromatic: cmd.chromatic,
  });
  const glass = effect.makeShaderWithChildren(uniforms, [blurChild, sharpChild]);
  if (!glass) throw new Error("paintIR(skia): glass makeShaderWithChildren returned null");
  const p = new CanvasKit.Paint();
  p.setShader(glass);
  p.setAlphaf(opacity);
  // Bound the fill to the panel's device AABB. The shader returns premultiplied
  // zero outside the SDF, so the rounded/squircle edge + antialias come from the
  // shader itself; the circumradius (hypot of the half-extents) covers any
  // rotation, plus a small slop for the coverage antialias band.
  const reach = Math.hypot(halfWDev, halfHDev) + COVERAGE_AA_SLOP_PX;
  canvas.save();
  canvas.clipRect(CanvasKit.LTRBRect(cxDev - reach, cyDev - reach, cxDev + reach, cyDev + reach), CanvasKit.ClipOp.Intersect, false);
  canvas.drawPaint(p);
  canvas.restore();

  p.delete(); glass.delete(); blurChild.delete(); sharpChild.delete();
  bd.blurred.delete(); bd.sharp.delete();

  // (5) optional bright hairline border on top (local space, rotation-safe).
  drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity, ctx.antialias);
}

/**
 * Pure function. The minimal device-px backdrop rectangle a glass panel actually
 * samples — everything OUTSIDE it is irrelevant to the refracted/blurred result,
 * so rendering (or cropping) + blurring only this box instead of the whole device
 * surface is the primary glass-backdrop perf win (~15-20x fewer pixels for a
 * typical panel). Built from the panel's rotation-safe circumradius plus the
 * shader's maximum OUTWARD reach (refraction + chromatic displacement via
 * maxGlassDisplacement, the Gaussian blur kernel support, and the coverage AA
 * slop), clamped to the surface.
 *
 *   reach  = hypot(halfWDev, halfHDev)                        // circumradius (covers any rotation)
 *   margin = maxGlassDisplacement(refractionDev, chromatic)   // outward refraction + chromatic
 *          + BLUR_SUPPORT_SIGMAS · blurSigma                  // Gaussian frost support
 *          + COVERAGE_AA_SLOP_PX                              // coverage AA band
 *
 * @param {number} cxDev,cyDev - panel center (device px)
 * @param {number} halfWDev,halfHDev - panel half-extents (device px)
 * @param {number} refractionDev - refraction strength (device px)
 * @param {number} chromatic - chromatic aberration fraction (0..1)
 * @param {number} blurSigma - frost blur sigma (device px)
 * @param {number} deviceW,deviceH - surface size (the clamp bounds)
 * @returns {{x0:number,y0:number,x1:number,y1:number}|null} integer device-px
 *   bounds fully containing the panel + its sample footprint, or null when the
 *   clamped box is empty (panel entirely off-surface ⇒ nothing to draw).
 *
 * @example glassRegion(400, 300, 150, 100, 10, 0.08, 6, 1920, 1080)
 * //        // {x0: 181, y0: 81, x1: 619, y1: 519}
 * @example glassRegion(-500, 300, 100, 80, 10, 0.08, 6, 1920, 1080) // null (off-surface)
 */
function glassRegion(cxDev, cyDev, halfWDev, halfHDev, refractionDev, chromatic, blurSigma, deviceW, deviceH) {
  const margin = maxGlassDisplacement(refractionDev, chromatic) + BLUR_SUPPORT_SIGMAS * blurSigma + COVERAGE_AA_SLOP_PX;
  return backdropRegion(cxDev, cyDev, halfWDev, halfHDev, margin, deviceW, deviceH);
}

/**
 * Pure function. THE backdrop-region rectangle, shared by every panel-shaped
 * backdrop sampler: the panel's rotation-safe circumradius plus the caller's
 * `marginDev` (its shader's outward sample reach + blur support + AA slop), snapped
 * outward to integer device px and clamped to the surface. Null when the clamped
 * box is empty — the panel is entirely off-surface, so nothing it draws is visible.
 *
 *   half = hypot(halfWDev, halfHDev) + marginDev
 *
 * Factored out of glassRegion when materialBackdrop gained a declared reach
 * (materials.materialSampleReach): the two callers differ ONLY in how they compute
 * the margin, so the clamp/snap arithmetic — the part a second copy would drift on
 * — lives here once. INTEGER bounds are load-bearing: the region origin becomes a
 * device-pixel offset for the crop / re-render, and a fractional offset would
 * resample the backdrop instead of translating it.
 *
 * @param {number} cxDev,cyDev - panel center (device px)
 * @param {number} halfWDev,halfHDev - panel half-extents (device px)
 * @param {number} marginDev - outward reach to add on every side (device px, >= 0)
 * @param {number} deviceW,deviceH - surface size (the clamp bounds)
 * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
 *
 * @example backdropRegion(400, 300, 150, 100, 0, 1920, 1080) // {x0: 219, y0: 119, x1: 581, y1: 481}
 * @example backdropRegion(400, 300, 150, 100, 20, 1920, 1080) // {x0: 199, y0: 99, x1: 601, y1: 501}
 * @example backdropRegion(10, 10, 20, 20, 0, 1920, 1080) // {x0: 0, y0: 0, x1: 39, y1: 39} (clamped at the surface edge)
 * @example backdropRegion(-500, 300, 100, 80, 0, 1920, 1080) // null (entirely off-surface)
 */
function backdropRegion(cxDev, cyDev, halfWDev, halfHDev, marginDev, deviceW, deviceH) {
  const half = Math.hypot(halfWDev, halfHDev) + marginDev;
  const x0 = Math.max(0, Math.floor(cxDev - half)), y0 = Math.max(0, Math.floor(cyDev - half));
  const x1 = Math.min(deviceW, Math.ceil(cxDev + half)), y1 = Math.min(deviceH, Math.ceil(cyDev + half));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Query→build. The glass backdrop images {sharp, blurred, sampleMatrix} for the
 * `region` (device-px {x0,y0,x1,y1}) at the requested resolution factor. Only the
 * region — not the whole device surface — is allocated, rendered/cropped, and
 * blurred, which is the glass-backdrop perf win. `region` null ⇒ the whole surface
 * (the material full-surface fallback, until per-material reach lands).
 *
 * INSIDE AN EFFECT SCRATCH (target.below — a frosted/CRT/glass panel carrying a
 * drop shadow or soft edges, or any backdrop member of an effected group) the
 * composite lives on the OUTER surface and the scratch itself is empty, so the
 * region is CROPPED out of that outer surface at the effect region's offset. This
 * is taken at ANY depth, because a crop recurses into nothing — it is the branch
 * whose absence produced the dark smear (the old code fell through to
 * snapshotting the transparent scratch). It is also the CHEAP branch: inside a
 * scratch the "whole surface" IS the widget's own footprint, so even a material's
 * region-less request costs the panel's pixels rather than the canvas's. A
 * supersample request (backdropScale > 1) is clamped to 1 here — the outer
 * composite only exists at device resolution, so upsampling it would cost pixels
 * and add no detail.
 *
 * depth.lens < cap: two ways to produce the SHARP backdrop, both byte-equivalent
 * for a backdrop that fully covers the region (a camera-backed / full-coverage
 * scene — report Q3):
 *   - backdropScale <= 1 with a snapshot-able composite surface ⇒ CROP the region
 *     out of the composite-so-far (target.surface) and downsample (the redundant-
 *     walk elimination — no re-render of the below-content at all).
 *   - otherwise (backdropScale > 1, the true supersample; or no owned surface) ⇒
 *     RE-RENDER the below-content into a `scale`-sized region surface, shifted so
 *     region (x0,y0) maps to the surface origin.
 * depth.lens >= cap: fall back to sampling the WHOLE surface being drawn into
 * (device res, scale ignored; non-null at depth >= 1, matching the magnifier's
 * recursion guard).
 *
 * `sampleMatrix` maps an image texel to its DEVICE coordinate: translate(x0,y0)·
 * scale(1/scale) (texel t → region origin + t/scale) for the region paths, null
 * (identity, device px) for the whole-surface fallback. Caller deletes sharp +
 * blurred (blurred may be null — see below).
 *
 * `needBlur` (default true) is the OPT-OUT for a material that declares it never
 * samples the blurred child (materials carry `usesBlurredBackdrop: false`; see
 * handleMaterialBackdrop). When false the Gaussian pass is SKIPPED entirely and
 * `blurred` comes back null — the expensive half of this function, measured at
 * roughly two thirds of a comic-halftone widget's whole per-frame cost. It changes
 * NO pixels for such a material by construction: the texture it skips is one the
 * shader does not read, and the caller binds the sharp texture into the slot so
 * the child count/contract is unchanged.
 */
function glassBackdropImages(CanvasKit, target, belowFlat, view, ctx, depth, scale, blurSigma, region, needBlur = true) {
  const full = !region;
  const x0 = full ? 0 : region.x0, y0 = full ? 0 : region.y0;
  const x1 = full ? ctx.deviceW : region.x1, y1 = full ? ctx.deviceH : region.y1;
  if (target.below?.surface) {
    const s = Math.min(scale, 1); // the outer composite exists at device res only
    const sw = Math.max(1, Math.round((x1 - x0) * s));
    const sh = Math.max(1, Math.round((y1 - y0) * s));
    const { surface, dx, dy } = target.below;
    surface.flush();
    const composite = surface.makeImageSnapshot();
    const sharp = cropDownsample(CanvasKit, ctx, composite, x0 + dx, y0 + dy, x1 + dx, y1 + dy, sw, sh);
    composite.delete();
    const blurred = needBlur ? blurredImageOf(CanvasKit, ctx, sharp, blurSigma * s, sw, sh) : null;
    // The shader works in THIS surface's device coordinates, so the matrix maps a
    // texel back to (x0, y0) + texel/s exactly as on the ordinary crop path — the
    // outer offset was consumed by the crop rect above.
    const sampleMatrix = CanvasKit.Matrix.multiply(CanvasKit.Matrix.translated(x0, y0), CanvasKit.Matrix.scaled(1 / s, 1 / s));
    return { sharp, blurred, sampleMatrix };
  }
  if (depth.lens < MAX_SUPERSAMPLE_DEPTH) {
    const sw = Math.max(1, Math.round((x1 - x0) * scale));
    const sh = Math.max(1, Math.round((y1 - y0) * scale));
    let sharp;
    if (scale <= 1 && !full && target.surface) {
      // CROP the minimal region out of the composite-so-far (exact for a covering
      // backdrop; downsampled when scale < 1). No below-content re-render.
      target.surface.flush();
      const composite = target.surface.makeImageSnapshot();
      sharp = cropDownsample(CanvasKit, ctx, composite, x0, y0, x1, y1, sw, sh);
      composite.delete();
    } else {
      // RE-RENDER the below-content into the region surface. dpr·scale maps the
      // world region onto the scale-sized surface; panX/panY shift by -x0/-y0
      // (world units) so device (x0,y0) lands at the surface origin. (full ⇒
      // x0=y0=0 ⇒ this reduces to the former whole-surface re-render exactly.)
      const sub = ctx.makeSurface(sw, sh);
      if (!sub) throw new Error("paintIR(skia): makeSurface for glass backdrop re-render returned null");
      // CLEAR TO THE SCENE BACKGROUND, not to transparency. This branch STANDS IN
      // FOR the composite-so-far, and a composite begins with paintIR's clear — so
      // clearing transparent here silently dropped it: a material over an otherwise
      // empty page sampled pure transparency and exported BLACK (rgb(26,18,25)
      // instead of rgb(220,204,184), 92% of opaque pixels near-black — pixel-proven
      // by the export agent, PDF matching Skia exactly in both cases, i.e. the
      // exporter was faithful and this line was the bug). The editor hid it because
      // web/cameraFrame.js emits the camera background as a REAL rect op, which
      // this re-render does draw; exportPdf/exportSvg pass sceneIR() alone, which
      // has no such op. NOT to be copied to the EFFECT-content scratch: that one is
      // correctly transparent, because its alpha IS the widget silhouette every
      // composite reads (clearing it to the background would turn every shadow into
      // a solid rect).
      sub.getCanvas().clear(ctx.bgColor);
      const shiftedView = { ...view, dpr: view.dpr * scale, panX: view.panX - x0 / view.dpr, panY: view.panY - y0 / view.dpr };
      paintFlat(CanvasKit, { canvas: sub.getCanvas(), surface: sub }, belowFlat, shiftedView, ctx, deeperLens(depth));
      sub.flush();
      sharp = sub.makeImageSnapshot();
      sub.dispose();
    }
    const blurred = needBlur ? blurredImageOf(CanvasKit, ctx, sharp, blurSigma * scale, sw, sh) : null;
    const sampleMatrix = CanvasKit.Matrix.multiply(CanvasKit.Matrix.translated(x0, y0), CanvasKit.Matrix.scaled(1 / scale, 1 / scale));
    return { sharp, blurred, sampleMatrix };
  }
  // Fallback (nested beyond the re-render cap): sample the surface we draw into.
  if (!target.surface) throw new Error("paintIR(skia): glassBackdrop fallback requires an owned offscreen surface (internal invariant)");
  target.surface.flush();
  const sharp = target.surface.makeImageSnapshot();
  const blurred = needBlur ? blurredImageOf(CanvasKit, ctx, sharp, blurSigma, ctx.deviceW, ctx.deviceH) : null;
  return { sharp, blurred, sampleMatrix: null }; // null ⇒ identity local space (device px)
}

/**
 * Query→build. Crops the device-px rect [x0,y0,x1,y1] out of `img` into a fresh
 * `sw`×`sh` surface (a 1:1 pixel-aligned copy when sw==x1-x0; a linear downsample
 * when smaller), and returns the snapshot. The SHARP glass backdrop for the
 * backdropScale <= 1 crop path. Caller deletes the returned Image.
 */
function cropDownsample(CanvasKit, ctx, img, x0, y0, x1, y1, sw, sh) {
  const surf = ctx.makeSurface(sw, sh);
  if (!surf) throw new Error("paintIR(skia): makeSurface for glass backdrop crop returned null");
  const c = surf.getCanvas();
  c.clear(CanvasKit.Color4f(0, 0, 0, 0));
  const p = new CanvasKit.Paint();
  c.drawImageRectOptions(img, CanvasKit.LTRBRect(x0, y0, x1, y1), CanvasKit.LTRBRect(0, 0, sw, sh), CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, p);
  surf.flush();
  const out = surf.makeImageSnapshot();
  p.delete();
  surf.dispose();
  return out;
}

/** Query→build. A Gaussian-blurred `w`×`h` copy of `img` (σ px, in the image's
 * OWN pixel space) — the SAME ImageFilter.MakeBlur the real blurBackdrop uses.
 * σ=0 ⇒ a sharp copy. Caller deletes the returned Image. */
function blurredImageOf(CanvasKit, ctx, img, sigma, w, h) {
  const surf = ctx.makeSurface(w, h);
  if (!surf) throw new Error("paintIR(skia): makeSurface for glass blur returned null");
  const c = surf.getCanvas();
  c.clear(CanvasKit.Color4f(0, 0, 0, 0));
  const p = new CanvasKit.Paint();
  let filt = null;
  if (sigma > 0) {
    filt = CanvasKit.ImageFilter.MakeBlur(sigma, sigma, CanvasKit.TileMode.Clamp, null);
    p.setImageFilter(filt);
  }
  c.drawImage(img, 0, 0, p);
  surf.flush();
  const out = surf.makeImageSnapshot();
  p.delete();
  if (filt) filt.delete();
  surf.dispose();
  return out;
}

/**
 * Command (draws on `canvas` at the device root). A soft, diffuse drop shadow
 * under the glass panel: a blurred dark rounded-rect, offset DOWN in screen space
 * (light from above), darkness = `strength`, fading in with `materialize`.
 * Rotation-safe (the box is rotated about the offset center; the screen-space
 * downward offset is applied before the rotation so the shadow stays below).
 */
function drawGlassShadow(CanvasKit, canvas, cx, cy, halfW, halfH, corner, angle, materialize, strength) {
  const appear = Math.min(1, Math.max(0, materialize / GLASS_SHADOW_APPEAR_END));
  if (appear <= 0 || strength <= 0 || halfW <= 0 || halfH <= 0) return;
  const sigma = halfH * GLASS_SHADOW_SIGMA_FRAC;
  const dy = halfH * GLASS_SHADOW_DY_FRAC;
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(0, 0, 0, strength * appear));
  p.setAntiAlias(true); // a mask-blurred silhouette — coverage AA is imperceptible under the blur, so this ignores the camera flag by design
  if (sigma > 0) p.setMaskFilter(CanvasKit.MaskFilter.MakeBlur(CanvasKit.BlurStyle.Normal, sigma, false));
  canvas.save();
  canvas.translate(cx, cy + dy);
  canvas.rotate(angle * RAD2DEG, 0, 0);
  const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(-halfW, -halfH, halfW, halfH), corner, corner);
  canvas.drawRRect(rr, p);
  canvas.restore();
  p.delete();
}

/** Command (draws the optional bright hairline border in local space — the glass
 * edge catch-light). One stroked rounded rect; skipped when strokeWidth is 0.
 * `aa` is the camera's coverage-AA flag (ctx.antialias). */
function drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity, aa = true) {
  if (!cmd.stroke || !(cmd.strokeWidth > 0)) return;
  canvas.save();
  applyView(canvas, view, world);
  const p = strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, null, aa);
  const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius);
  canvas.drawRRect(rr, p);
  p.delete();
  canvas.restore();
}

// ── the MATERIAL FRAMEWORK (generalizes glass to registry-dispatched SkSL) ────
// A materialBackdrop op names a MATERIAL (render_gpu/skia/materials.js); this
// handler is the ONE piece of machinery every material shares — the glass
// groundwork, reused: re-render the below-content (glassBackdropImages) into a
// sharp + a Gaussian-blurred child image shader, compile+cache the material's
// SkSL (materialEffect, the generalized glassEffect memo), pack the material's
// uniforms (device geometry + its own knobs), and draw the region. New materials
// (CRT here; dirty-glass / magnify next) add NOTHING to this file.

/**
 * Command (draws on target.canvas). materialBackdrop: resolve the material by id,
 * build the sharp + blurred backdrop children (the SAME below-content re-render
 * glass uses — depth-capped, falling back to sampling the surface), pack the
 * material's uniforms from the DEVICE-space region geometry + its own `params`,
 * and draw the rounded-rect region through the material's RuntimeEffect (children
 * {blurred, sharp}). Drawn at the DEVICE ROOT (no CTM), bounded to the panel's
 * device AABB — the shader returns premultiplied zero outside its own SDF.
 *
 * World→device geometry (center, half-size, corner, rotation) + world→device
 * length scaling (value·world.scale·zoom·dpr, the blurBackdrop convention) mirror
 * handleGlassBackdrop exactly; `scale` (= sd) is handed to the material's packer
 * for any world-unit knob it exposes.
 */
function handleMaterialBackdrop(CanvasKit, target, cmd, world, view, belowFlat, ctx, depth) {
  const canvas = target.canvas;
  const opacity = cmd.opacity ?? 1;
  const material = getMaterial(cmd.material);

  // Device-space region geometry (a similarity transform), identical to glass.
  const ds = view.zoom * view.dpr;
  const sd = world.scale * ds;                 // world length → device px
  const centerWorld = T.apply(world, cmd.cx, cmd.cy);
  const cxDev = centerWorld.x * ds + view.panX * view.dpr;
  const cyDev = centerWorld.y * ds + view.panY * view.dpr;
  const halfWDev = cmd.halfW * sd, halfHDev = cmd.halfH * sd;
  const cornerDev = cmd.cornerRadius * sd;
  const angle = world.rotation;
  const blurSigma = cmd.blurRadius * sd;

  // THE BLURRED-CHILD OPT-OUT (a declared per-material capability). A material that
  // DECLARES the standard {blurred, sharp} pair but never evals the blurred one
  // (comic halftone: a print reads only the sharp tone) still paid a full-screen
  // Gaussian blur of the composite-so-far EVERY FRAME for a texture nothing reads —
  // measured at ~33 of the ~50 ms that widget cost per frame at 1400×900, i.e. two
  // thirds of its total cost, with zero visual contribution.
  //
  // ABSENCE MEANS BUILD IT. Only an explicit `usesBlurredBackdrop === false` opts
  // out, so glass / CRT / frosted / glitch / metaballs / rainy-window — every
  // material that really does sample it — keep their blur untouched and a future
  // material that forgets to declare anything can never silently lose it. The claim
  // itself is cross-checked against the material's SkSL at import (comic_shader.js),
  // so a material cannot declare false and then read the child.
  //
  // The CHILD SLOT IS STILL SUPPLIED — the contract is a fixed pair, and only the
  // BLUR is skipped, not the shader signature. The stand-in is the SHARP texture,
  // which is already built and therefore free; it is also the graceful choice if a
  // material ever lied (an un-blurred backdrop, not a 1×1 smear).
  const needBlur = material.usesBlurredBackdrop !== false;
  // The framework's normalized uniform input: device geometry + world→device
  // scale + the material's own (already-evaluated) knobs. The packer picks fields,
  // and so does the DECLARED REACH below — both read the same `u`.
  const u = { cx: cxDev, cy: cyDev, halfW: halfWDev, halfH: halfHDev, cornerRadius: cornerDev, angle, scale: sd, ...cmd.params };

  // THE BACKDROP REGION — the minimal box the backdrop children must cover, which
  // is the panel's circumradius plus how far outside itself this material's shader
  // READS (its coverage is already bounded by its own SDF; only the sample
  // displacement reaches out). A material that DECLARES that reach
  // (materialSampleReach) gets glass's region-bounded backdrop; one that does not
  // gets region=null, i.e. the historical FULL-surface re-render + full-surface
  // Gaussian — expensive but never wrong, because a region smaller than the shader
  // reads would make the child sampler clamp at the region edge and visibly wreck
  // the material. Measured on a 240×160 panel over a 960×540 frame: 1,036,800
  // offscreen px undeclared vs 68,644 declared (frosted), for a panel footprint of
  // 38,400 px. Null region (not null reach) ⇒ the panel is entirely off-surface, so
  // nothing it draws — backdrop, shader, border — is visible.
  const reachDev = materialSampleReach(material, u);
  let region = null;
  if (reachDev !== null) {
    region = backdropRegion(cxDev, cyDev, halfWDev, halfHDev,
      reachDev + (needBlur ? BLUR_SUPPORT_SIGMAS * blurSigma : 0) + COVERAGE_AA_SLOP_PX, ctx.deviceW, ctx.deviceH);
    if (!region) return;
  }
  const bd = glassBackdropImages(CanvasKit, target, belowFlat, view, ctx, depth, cmd.backdropScale, blurSigma, region, needBlur);

  const effect = materialEffect(CanvasKit, material);
  const blurSource = bd.blurred ?? bd.sharp;
  const blurChild = blurSource.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, bd.sampleMatrix);
  const sharpChild = bd.sharp.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, bd.sampleMatrix);
  const uniforms = material.pack(u);
  const shader = effect.makeShaderWithChildren(uniforms, [blurChild, sharpChild]);
  if (!shader) throw new Error(`paintIR(skia): material "${cmd.material}" makeShaderWithChildren returned null`);
  const p = new CanvasKit.Paint();
  p.setShader(shader);
  p.setAlphaf(opacity);
  const reach = Math.hypot(halfWDev, halfHDev) + COVERAGE_AA_SLOP_PX; // circumradius + AA slop covers any rotation
  canvas.save();
  canvas.clipRect(CanvasKit.LTRBRect(cxDev - reach, cyDev - reach, cxDev + reach, cyDev + reach), CanvasKit.ClipOp.Intersect, false);
  canvas.drawPaint(p);
  canvas.restore();

  p.delete(); shader.delete(); blurChild.delete(); sharpChild.delete();
  bd.blurred?.delete(); bd.sharp.delete(); // blurred is null when the material opted out

  // Optional bright hairline border on top (reuses the glass border helper — the
  // materialBackdrop op carries the same cx/halfW/cornerRadius/stroke fields).
  drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity, ctx.antialias);
}

/**
 * Command (draws on target.canvas). materialFill: the FOREGROUND twin of
 * handleMaterialBackdrop — a leaner handler with NO below-content re-render and NO
 * children (the corkboard family). Resolves the material (LOUD if it is actually a
 * backdrop material), draws the optional soft shadow BENEATH first, then fills the
 * region through the material's RuntimeEffect via `effect.makeShader(uniforms)`
 * (the shader returns premultiplied 0 outside its own SDF), clipped to the device
 * AABB. World→device geometry + length scaling mirror handleMaterialBackdrop; `sd`
 * (world length → device px) is handed to the packer as `scale`. `ctx` carries
 * the camera's coverage-AA flag (ctx.antialias) for the hairline border.
 */
function handleMaterialFill(CanvasKit, target, cmd, world, view, ctx) {
  const canvas = target.canvas;
  const opacity = cmd.opacity ?? 1;
  const material = getMaterial(cmd.material);
  if (isBackdropMaterial(material))
    throw new Error(`paintIR(skia): materialFill names BACKDROP material "${cmd.material}" — use materialBackdrop (foreground materials carry backdrop:false)`);

  // Device-space region geometry (a similarity transform), identical to glass/material backdrop.
  const ds = view.zoom * view.dpr;
  const sd = world.scale * ds;                 // world length → device px
  const centerWorld = T.apply(world, cmd.cx, cmd.cy);
  const cxDev = centerWorld.x * ds + view.panX * view.dpr;
  const cyDev = centerWorld.y * ds + view.panY * view.dpr;
  const halfWDev = cmd.halfW * sd, halfHDev = cmd.halfH * sd;
  const cornerDev = cmd.cornerRadius * sd;
  const angle = world.rotation;

  // (1) optional soft shadow BENEATH the fill (the glass drawGlassShadow precedent).
  if (cmd.shadow) drawMaterialShadow(CanvasKit, canvas, cxDev, cyDev, halfWDev, halfHDev, cornerDev, angle, cmd.shadow, sd);

  // (2) the FOREGROUND fill: pack uniforms, makeShader (NO children), clip AABB, drawPaint.
  const effect = materialEffect(CanvasKit, material);
  const u = { cx: cxDev, cy: cyDev, halfW: halfWDev, halfH: halfHDev, cornerRadius: cornerDev, angle, scale: sd, ...cmd.params };
  const uniforms = material.pack(u);
  const shader = effect.makeShader(uniforms);
  if (!shader) throw new Error(`paintIR(skia): material "${cmd.material}" makeShader returned null`);
  const p = new CanvasKit.Paint();
  p.setShader(shader);
  p.setAlphaf(opacity);
  const reach = Math.hypot(halfWDev, halfHDev) + COVERAGE_AA_SLOP_PX; // circumradius + AA slop covers any rotation
  canvas.save();
  canvas.clipRect(CanvasKit.LTRBRect(cxDev - reach, cyDev - reach, cxDev + reach, cyDev + reach), CanvasKit.ClipOp.Intersect, false);
  canvas.drawPaint(p);
  canvas.restore();
  p.delete(); shader.delete();

  // (3) optional bright hairline border on top (reuses the glass border helper).
  drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity, ctx.antialias);
}

/**
 * Command (draws on `canvas` at the device root). The materialFill op's optional
 * soft shadow: the fill's rounded-rect GROWN by `grow`, offset by (dx, dy), mask-
 * blurred by `blur`, filled black at `alpha` — all WORLD units scaled to device by
 * `sd` (except the 0..1 alpha). Rotation-safe (rotate about the offset center, like
 * drawGlassShadow). The plugin authors dx/dy/grow from the light + apparent height,
 * so a proud tack's shadow is larger + more offset than a pressed-in one.
 */
function drawMaterialShadow(CanvasKit, canvas, cx, cy, halfW, halfH, corner, angle, shadow, sd) {
  if (shadow.alpha <= 0 || halfW <= 0 || halfH <= 0) return;
  const grow = shadow.grow * sd;
  const sigma = shadow.blur * sd;
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(0, 0, 0, shadow.alpha));
  p.setAntiAlias(true); // a mask-blurred silhouette — coverage AA is imperceptible under the blur, so this ignores the camera flag by design
  if (sigma > 0) p.setMaskFilter(CanvasKit.MaskFilter.MakeBlur(CanvasKit.BlurStyle.Normal, sigma, false));
  canvas.save();
  canvas.translate(cx + shadow.dx * sd, cy + shadow.dy * sd);
  canvas.rotate(angle * RAD2DEG, 0, 0);
  const hw = halfW + grow, hh = halfH + grow, cr = corner + grow; // grow the corner too so a disk stays a disk
  const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(-hw, -hh, hw, hh), cr, cr);
  canvas.drawRRect(rr, p);
  canvas.restore();
  p.delete();
}

// ── PROXY-quality backdrop stand-in (thumbnails / minimap) ────────────────────

/**
 * Command (draws on `canvas`). THE proxy-quality stand-in for a backdrop sampler:
 * a CHEAP approximation over the ALREADY-composited canvas (proxy forces paintIR's
 * fast direct path, so the below-content is already painted here). Runs NONE of the
 * expensive machinery a ~100px thumbnail cannot show — no composite-so-far read, no
 * below-content re-render, no full-screen blur, no SkSL, no dither. Dispatches by op:
 *   - glassBackdrop    → a translucent frost rounded-rect (the panel's own tint, or
 *                        the shared faint white) + its hairline border.
 *   - materialBackdrop → the MATERIAL'S OWN overlay tint + its border
 *                        (materials.resolveProxyBackdrop: the material's
 *                        `proxyBackdrop(params)` if it declares one, else the same
 *                        shared frost). Declaring one is how a material whose effect
 *                        has a DIRECTION gets a stand-in that moves the same way —
 *                        before this hook every backdrop material shared the frost,
 *                        which LIGHTENS, so a dimming widget read as a brightening
 *                        one in its own thumbnail.
 *   - magnifyBackdrop  → just the lens rim (the content beneath shows un-magnified).
 *   - blurBackdrop     → nothing (a whole-frame backdrop blur is imperceptible at
 *                        thumbnail size; the sharp content beneath is a fair proxy).
 * The overlays land ON TOP of the real backdrop content, so the region reads as a
 * sensible preview, never a hole. `ctx` supplies the camera coverage-AA flag.
 *
 * CHEAPNESS IS THE CONTRACT: every branch is at most one drawRRect plus a border
 * stroke. No offscreen surface, no SkSL, no per-pixel pass — that is what the proxy
 * path buys, and a stand-in that did real work would defeat it.
 */
function drawProxyBackdrop(CanvasKit, canvas, cmd, view, world, ctx) {
  const opacity = cmd.opacity ?? 1;
  const aa = ctx.antialias;
  if (cmd.op === "blurBackdrop") return; // no geometry; the sharp content beneath is the proxy
  if (cmd.op === "magnifyBackdrop") { drawLensBorder(CanvasKit, canvas, cmd, view, world, opacity, aa); return; }
  // glass / material: a translucent overlay rounded-rect in the panel's LOCAL space
  // (applyView — rotation-safe, the same seam drawGlassBorder uses).
  const tint = cmd.op === "materialBackdrop"
    ? resolveProxyBackdrop(getMaterial(cmd.material), cmd.params)
    : (cmd.tint ? parseColor(cmd.tint) : DEFAULT_PROXY_BACKDROP_TINT);
  const materialize = cmd.materialize ?? 1; // glass fades in with materialize; a material has none ⇒ full
  const a = tint[3] * opacity * materialize;
  if (a > 0 && cmd.halfW > 0 && cmd.halfH > 0) {
    canvas.save();
    applyView(canvas, view, world);
    const p = new CanvasKit.Paint();
    p.setStyle(CanvasKit.PaintStyle.Fill);
    p.setAntiAlias(aa);
    p.setColor(CanvasKit.Color4f(tint[0], tint[1], tint[2], a));
    const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius);
    canvas.drawRRect(rr, p);
    p.delete();
    canvas.restore();
  }
  drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity, aa); // glass + material both carry stroke/strokeWidth
}

/**
 * Query→build (allocates a CanvasKit Shader — caller deletes). Turns a GRADIENT
 * proxyFill SPEC (materials.js: {kind:"linear"|"radial", …, stops:[{offset, color:
 * [r,g,b,a]}]}) into a Skia gradient shader in the region's LOCAL space (the caller
 * draws under the view+world CTM, so local coords land in device px). `opacity`
 * folds into every stop's alpha (item/group opacity, like skShaderForPaint). The
 * "solid" kind carries no gradient and is drawn via setColor by the caller, never
 * here. Throws LOUDLY on any other kind (a bad spec must not silently draw nothing).
 */
function proxyGradientShader(CanvasKit, spec, opacity) {
  const colors = spec.stops.map((s) => CanvasKit.Color4f(s.color[0], s.color[1], s.color[2], s.color[3] * opacity));
  const positions = spec.stops.map((s) => s.offset);
  if (spec.kind === "linear")
    return CanvasKit.Shader.MakeLinearGradient([spec.x0, spec.y0], [spec.x1, spec.y1], colors, positions, CanvasKit.TileMode.Clamp);
  if (spec.kind === "radial")
    return CanvasKit.Shader.MakeRadialGradient([spec.cx, spec.cy], spec.radius, colors, positions, CanvasKit.TileMode.Clamp);
  throw new Error(`paintIR(skia): proxyGradientShader got non-gradient spec kind "${spec.kind}"`);
}

/**
 * Command (draws on `canvas`). THE proxy-quality stand-in for a generative
 * materialFill (lens flare, sky family, corkboard, raycast_dither, and ANY future
 * one): fills the material's rounded-rect region with the CHEAP spec
 * materials.resolveProxyFill returns — the material's own proxyFill (a radial glow, a
 * vertical sky gradient, a flat board colour, …) or a representative flat DEFAULT —
 * INSTEAD of compiling + running its per-pixel SkSL. Runs in the region's LOCAL space
 * (applyView — rotation-safe, the same seam handleMaterialFill uses), so a
 * transparent-rimmed spec (sun/moon/flare/tack) composites over the scene beneath
 * without occluding it. The material's hairline border (if any) is drawn on top,
 * matching the full path. `ctx` supplies the camera coverage-AA flag.
 */
function drawProxyMaterialFill(CanvasKit, canvas, cmd, view, world, ctx) {
  const opacity = cmd.opacity ?? 1;
  const aa = ctx.antialias;
  if (cmd.halfW > 0 && cmd.halfH > 0) {
    const material = getMaterial(cmd.material);
    const spec = resolveProxyFill(material, cmd.params, { cx: cmd.cx, cy: cmd.cy, halfW: cmd.halfW, halfH: cmd.halfH });
    canvas.save();
    applyView(canvas, view, world);
    const p = new CanvasKit.Paint();
    p.setAntiAlias(aa);
    let shader = null;
    if (spec.kind === "solid") {
      p.setColor(CanvasKit.Color4f(spec.color[0], spec.color[1], spec.color[2], spec.color[3] * opacity));
    } else {
      shader = proxyGradientShader(CanvasKit, spec, opacity);
      if (!shader) throw new Error(`paintIR(skia): proxyFill gradient for material "${cmd.material}" returned null`);
      p.setShader(shader);
    }
    const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius);
    canvas.drawRRect(rr, p);
    p.delete();
    if (shader) shader.delete();
    canvas.restore();
  }
  drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity, aa); // materialFill carries stroke/strokeWidth
}

/**
 * The smallest device-px reach a proxy-quality effect must have to be worth
 * drawing: below one device pixel it cannot separate itself from the widget's own
 * edge at thumbnail/minimap resolution.
 */
const PROXY_MIN_EFFECT_REACH_PX = 1;

/**
 * Pure function. A drop shadow's OUTWARD reach in device px: its Gaussian kernel
 * support (BLUR_SUPPORT_SIGMAS·σ) plus the offset length (rotation-safe — a
 * rotation preserves lengths). The same quantity ir.js bakes into effectSubtree's
 * `margin`, recomputed here in DEVICE units because the proxy gate is a
 * device-resolution question.
 *
 * @param shadow ({dx, dy, blur}) the op's shadow, world units
 * @param scale (number) world length → device px (world.scale·zoom·dpr)
 * @returns {number}
 *
 * @example shadowReachPx({dx: 0, dy: 0, blur: 0}, 4) // 0 (a hard shadow exactly under the widget)
 * @example shadowReachPx({dx: 3, dy: 4, blur: 2}, 1) // 11 (3·2 blur support + 5 offset length)
 * @example shadowReachPx({dx: 3, dy: 4, blur: 2}, 0.05) // 0.55 (zoomed out past a pixel — invisible)
 */
function shadowReachPx(shadow, scale) {
  return (shadow.blur * BLUR_SUPPORT_SIGMAS + Math.hypot(shadow.dx, shadow.dy)) * scale;
}

/**
 * Command (draws on target.canvas). THE proxy-quality stand-in for an
 * effectSubtree: the widget's own content, its opacity (which rides on the
 * content ops) and its BLEND mode — plus a drop shadow when that shadow reaches
 * at least one device pixel. Everything that needs a per-pixel pass over an
 * offscreen (SOFT EDGES' morphology, the INNER SHADOW's field+blur+clip, BLOOM's
 * blur) is dropped: each is a rim treatment a ~100px preview cannot resolve, and
 * each costs more than the whole rest of the thumbnail.
 *
 * The reduction is built FIELD BY FIELD rather than by copying the op, so it is
 * universal: an effect added to effectSubtree later is absent from the reduced op
 * and is therefore dropped here automatically (the resolveProxyFill discipline —
 * a new effect can never silently blow up thumbnails).
 *
 * When nothing survives the reduction (no visible shadow, normal blend) there is
 * no reason to own an offscreen at all: the content draws STRAIGHT onto the
 * canvas, which is the whole point of the proxy path.
 */
function drawProxyEffect(CanvasKit, target, cmd, world, view, ctx, depth, belowFlat = []) {
  const scale = world.scale * view.zoom * view.dpr; // world length → device px
  const shadow = cmd.shadow && shadowReachPx(cmd.shadow, scale) >= PROXY_MIN_EFFECT_REACH_PX ? cmd.shadow : null;
  if (!shadow && cmd.blend === "normal") {
    // A shadow-only subtree (the PDF hybrid split's re-issue) whose shadow was
    // dropped has nothing left to draw.
    if (!cmd.shadowOnly) paintFlat(CanvasKit, target, flattenIR(cmd.content), view, ctx, depth);
    return;
  }
  handleEffectSubtree(CanvasKit, target, {
    op: "effectSubtree",
    x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h, margin: cmd.margin,
    content: cmd.content, blend: cmd.blend, shadowOnly: cmd.shadowOnly,
    shadow, bloom: null, innerShadow: null, softEdges: 0,
  }, world, view, ctx, depth, belowFlat);
}

// ── subtree re-renders (self-contained `content`) ─────────────────────────────

/**
 * Command (draws on target.canvas). cropSubtree: fill a rounded-rect region,
 * clip to it, re-emit `content` (self-contained absolute-world IR), stroke the
 * border on top. Fill + border draw in the crop node's local space; the clip is
 * a device-space path (so `content`, which carries its own world, can render
 * from the device root through `view` while the clip persists).
 *
 * `content` is opaque re-interpretable IR: a crop box's single target, OR — the
 * subtree-effects gap — a GROUP's whole member subtree (plugins/group.emit). The
 * device-space clip + absolute-world content re-render handle both identically.
 */
function handleCropSubtree(CanvasKit, target, cmd, world, view, ctx, depth, belowFlat = []) {
  const canvas = target.canvas;
  const opacity = cmd.opacity ?? 1;
  const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius, cmd.cornerRadius);
  const bounds = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };

  if (cmd.fill) {
    canvas.save();
    applyView(canvas, view, world);
    withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds, ctx.antialias), (p) => canvas.drawRRect(rr, p));
    canvas.restore();
  }

  if (depth.subtree < MAX_REENDER_DEPTH) {
    const clip = deviceRRectPath(CanvasKit, cmd, deviceMatrix(CanvasKit, view, world));
    canvas.save();
    canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
    // The content draws on THIS canvas/surface, so the below context carries no
    // offset — but it does carry the outer below-LIST and the composite SURFACE,
    // which the content's own (initially empty) list cannot supply. Without it a
    // backdrop material inside a crop box replayed an empty below-list onto a
    // transparent scratch and rendered BLACK in the editor (rgb(15,15,20)), and a
    // supersample lens inside one magnified nothing.
    paintFlat(CanvasKit, { ...target, below: belowContext(target, belowFlat, 0, 0) }, flattenIR(cmd.content), view, ctx, deeperSubtree(depth));
    canvas.restore();
    clip.delete();
  } else {
    reportOnce("crop-reender-depth", `paintIR(skia): crop re-render nesting exceeded MAX_REENDER_DEPTH (${MAX_REENDER_DEPTH}) — skipping content (pathological nesting)`);
  }

  if (cmd.stroke && cmd.strokeWidth > 0) {
    canvas.save();
    applyView(canvas, view, world);
    withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds, ctx.antialias), (p) => canvas.drawRRect(rr, p));
    canvas.restore();
  }
}

/** Query→build. The crop rounded-rect as a device-space Path. Caller deletes. */
function deviceRRectPath(CanvasKit, cmd, deviceM) {
  const b = new CanvasKit.PathBuilder();
  b.addRRect(CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius, cmd.cornerRadius));
  b.transform(deviceM);
  const path = b.detach();
  b.delete();
  return path;
}

/**
 * Command (draws on target.canvas). effectSubtree: render `content` ONCE to a
 * scratch surface, then compose SHADOW (blurred/tinted/offset alpha silhouette)
 * UNDER, the WIDGET through its BLEND mode, INNER SHADOW inside it, and BLOOM
 * (blurred bright copy) ADD on top. shadowOnly ⇒ only the shadow. All composites
 * are device-root blits of the one content image; the effect node's world scales
 * the device sigmas/offset (sigma = value·world.scale·zoom·dpr), matching
 * gpu/compositor.js.
 *
 * COMPOSE ORDER (soft edges FIRST): if softEdges > 0 the one content image is
 * FEATHERED (its alpha eroded inward + blurred → edges fade to transparent —
 * featherEdges) BEFORE any composite, so the shadow is cast by the softened
 * silhouette, the inner shadow is clipped to it, bloom glows it, and the widget
 * draw itself has soft edges — the PowerPoint "Soft Edges" look, where the whole
 * treatment follows the feathered outline. Then, over the backdrop: shadow (under)
 * → widget (blend) → inner shadow (inside) → bloom (add, on top).
 *
 * `content` is opaque: a single widget's own ops, OR — the subtree-effects gap —
 * a GROUP's whole member subtree (plugins/group.emit), so the ONE offscreen
 * render is the composited group and the soft-edge feather + shadow/bloom/blend/
 * inner-shadow apply to the group silhouette as a unit. No branch needed — it's
 * just more content.
 *
 * A BACKDROP SAMPLER IS ALSO JUST MORE CONTENT (the universal effects bundle: a
 * frosted panel with soft edges, a magnifier with a drop shadow). It works
 * because the scratch is cleared TRANSPARENT and these shaders write
 * premultiplied ZERO outside their own SDF, so the scratch's alpha IS the panel
 * silhouette — precisely what the feather, the shadow, the inner shadow and the
 * bloom read. What such an op must NOT do is sample the scratch it is drawing
 * into (it is empty), so `subTarget.below` points it at the OUTER composite and
 * the outer below-LIST. Before that context existed a nested panel rendered as a
 * dark smear (rgb(51,51,51) instead of rgb(148,51,158)) and a nested supersample
 * lens replayed nothing.
 *
 * REGION CROP: every one of those offscreens covers only the effect's SOURCE
 * REGION (effectRegion) — the device-px box the content can actually draw into,
 * clamped to the surface — not the whole device. A 200×150 widget on a 1280×720
 * canvas then costs its own pixels instead of the canvas's (the glassRegion /
 * glassBackdropImages precedent, applied to the effect substrate). Every
 * composite blits the content image at the region ORIGIN instead of (0, 0). The
 * crop is a pure optimization: Skia draws an ImageFilter's output BEYOND the
 * source image's rect (verified), so the shadow/bloom halo still spills exactly
 * as far as it did over a device-sized source.
 *
 * PARITY NOTES vs the WebGPU compositor:
 *   - SHADOW uses ImageFilter.MakeDropShadowOnly — a Skia-faithful drop shadow,
 *     soft on ALL FOUR sides by construction (fixes the old 16.1 top/left clip;
 *     the dormant analytic-erf path is unnecessary here).
 *   - BLEND is applyBlend: Photoshop's 26 modes, 17 as Skia's own SkBlendMode and
 *     9 (Linear Burn, Darker/Lighter Color, Vivid/Linear/Pin Light, Hard Mix,
 *     Subtract, Divide) as cached SkSL runtime blenders — see
 *     render_gpu/skia/blend_modes.js. multiply/screen are true separable
 *     Porter-Duff (Skia) vs the retired GPU path's fixed-function factors; they
 *     differ where the backdrop is non-opaque.
 *   - No large-sigma source downscale (compositor's 15.3/15.5): the source
 *     region is at full device resolution, so extreme zoom is heavier but
 *     visually equal.
 */
function handleEffectSubtree(CanvasKit, target, cmd, world, view, ctx, depth, belowFlat = []) {
  const canvas = target.canvas;
  // The two guards DEGRADE to the widget without its effects (loudly) instead of
  // dropping the widget: "no effect" is always a legal rendering of a widget, an
  // invisible widget never is.
  const bail = (key, msg) => {
    reportOnce(key, msg);
    if (!cmd.shadowOnly) paintFlat(CanvasKit, target, flattenIR(cmd.content), view, ctx, depth);
    return null;
  };
  if (depth.subtree >= MAX_EFFECT_DEPTH)
    return bail("effect-reender-depth", `paintIR(skia): effect nesting exceeded MAX_EFFECT_DEPTH (${MAX_EFFECT_DEPTH}) — drawing the widget without its effects (pathological nesting)`);
  if (ctx.effectBudget.used >= EFFECT_PASS_BUDGET)
    return bail("effect-pass-budget", `paintIR(skia): this pass exceeded EFFECT_PASS_BUDGET (${EFFECT_PASS_BUDGET}) effect composites — drawing further effected widgets without their effects`);
  ctx.effectBudget.used++;
  const ds = view.zoom * view.dpr;
  const scale = world.scale * ds; // world value → device px

  const flatContent = flattenIR(cmd.content);
  const region = effectRegion(CanvasKit, cmd, flatContent, view, scale, ctx);
  if (!region) return; // the content draws nothing on this surface (empty or fully off-screen)
  // The region surface is its own little device: helpers that size themselves by
  // deviceW/deviceH (featherEdges, drawInnerShadow, and any nested op) must see
  // the REGION size, and the content must render shifted so device (x0, y0) lands
  // at the surface origin — the glassBackdropImages shifted-view convention.
  const rctx = { ...ctx, deviceW: region.w, deviceH: region.h };
  const rview = { ...view, panX: view.panX - region.x0 / view.dpr, panY: view.panY - region.y0 / view.dpr };

  // ONE offscreen render of the widget's own content (carries its own world).
  const sub = ctx.makeSurface(region.w, region.h);
  if (!sub) throw new Error("paintIR(skia): makeSurface for effect content returned null");
  sub.getCanvas().clear(CanvasKit.Color4f(0, 0, 0, 0));
  // THE `below` CONTEXT — what makes a BACKDROP SAMPLER work inside an effect.
  // The scratch is cleared TRANSPARENT (that is what makes its alpha the widget's
  // silhouette, which every composite below needs), so a glass / material /
  // magnify / blur op inside it must not read the scratch: it must read the OUTER
  // composite. Handing down the outer surface + the device offset (region origin,
  // accumulated through nesting) + the outer below-LIST gives it exactly that.
  // Without this, such a panel sampled empty pixels and rendered as a dark smear
  // — rgb(51,51,51) where rgb(148,51,158) was correct (pixel-proven).
  const subTarget = { canvas: sub.getCanvas(), surface: sub, below: belowContext(target, belowFlat, region.x0, region.y0) };
  paintFlat(CanvasKit, subTarget, flatContent, rview, rctx, deeperSubtree(depth));
  sub.flush();
  let contentImg = sub.makeImageSnapshot();

  // SOFT EDGES (before every composite): feather the widget's OWN coverage inward
  // to transparency, so the shadow / widget / inner shadow / bloom below all read
  // the softened silhouette (PowerPoint "Soft Edges"). softEdges 0 leaves
  // contentImg untouched ⇒ byte-identical to a crisp widget. `scale` maps the
  // world-unit feather to device px (same scaling as shadow blur/offset).
  if (cmd.softEdges > 0) {
    const feathered = featherEdges(CanvasKit, rctx, contentImg, cmd.softEdges * scale);
    contentImg.delete();
    contentImg = feathered;
  }

  // SHADOW (under): blurred, offset, tinted alpha silhouette of the content.
  if (cmd.shadow) {
    const c = cmd.shadow.color;
    const tint = CanvasKit.Color4f(c[0], c[1], c[2], c[3] * cmd.shadow.opacity);
    const sig = cmd.shadow.blur * scale;
    const filt = CanvasKit.ImageFilter.MakeDropShadowOnly(cmd.shadow.dx * scale, cmd.shadow.dy * scale, sig, sig, tint, null);
    const p = new CanvasKit.Paint();
    p.setImageFilter(filt);
    canvas.drawImage(contentImg, region.x0, region.y0, p);
    p.delete(); filt.delete();
  }

  if (!cmd.shadowOnly) {
    // WIDGET: the content itself, composited against the backdrop via blend mode.
    const p = new CanvasKit.Paint();
    applyBlend(CanvasKit, p, cmd.blend);
    canvas.drawImage(contentImg, region.x0, region.y0, p);
    p.delete();

    // INNER SHADOW (inside the widget): darkens the interior near the edges — a
    // recess. Drawn AFTER the widget (over it) and clipped to its silhouette, so
    // it never spills outside; UNDER bloom (bloom is a glow of the widget).
    if (cmd.innerShadow) {
      drawInnerShadow(CanvasKit, canvas, contentImg, cmd.innerShadow, scale, rctx, region.x0, region.y0);
    }

    // BLOOM (on top): the content's own Gaussian-blurred copy × strength, ADD.
    if (cmd.bloom) {
      const filt = bloomFilter(CanvasKit, cmd.bloom.radius * scale, cmd.bloom.strength);
      const p2 = new CanvasKit.Paint();
      p2.setImageFilter(filt);
      p2.setBlendMode(CanvasKit.BlendMode.Plus);
      canvas.drawImage(contentImg, region.x0, region.y0, p2);
      p2.delete(); filt.delete();
    }
  }

  contentImg.delete();
  sub.dispose();
}

/**
 * The sentinel opLocalBounds returns for an op whose DRAWN extent this backend
 * cannot bound from the op alone — text (paragraph ink needs a layout) and
 * blurBackdrop (a whole-frame backdrop treatment with no geometry at all). It is
 * not an error: it makes effectRegion fall back to the WHOLE surface, i.e. exactly
 * the pre-crop behaviour. Conservative by construction — an unrecognized op can
 * never lose a pixel, only the speed-up.
 */
const UNBOUNDED_EXTENT = Symbol("unbounded op extent");

/** Pure function. A rounded-box op's LOCAL geometry rect (the {cx, cy, halfW,
 * halfH} shape every glass / material / box-lens op carries).
 * @example roundedBoxBounds({cx: 100, cy: 60, halfW: 40, halfH: 25}) // {x: 60, y: 35, w: 80, h: 50}
 */
function roundedBoxBounds(cmd) {
  return { x: cmd.cx - cmd.halfW, y: cmd.cy - cmd.halfH, w: cmd.halfW * 2, h: cmd.halfH * 2 };
}

/**
 * Pure function. How far the LIQUID GLASS auto drop shadow (drawGlassShadow)
 * reaches past the panel, in the panel's own local units. Its offset and blur are
 * FRACTIONS of the half-height, so the same fractions apply in any unit; the 3σ
 * kernel support is the shared BLUR_SUPPORT_SIGMAS. Zero when the shadow is off
 * (not yet materialized, or strength 0) — matching drawGlassShadow's own gate.
 * Applied symmetrically because the offset is SCREEN-down and the panel may be
 * rotated (a symmetric halo is rotation-safe, and only ever over-estimates).
 *
 * @example glassShadowReach({halfH: 100, materialize: 1, shadowStrength: 0.3}) // 78 (0.12·100 offset + 3·0.22·100 blur support)
 * @example glassShadowReach({halfH: 100, materialize: 1, shadowStrength: 0}) // 0 (shadow off)
 */
function glassShadowReach(cmd) {
  if (!(cmd.shadowStrength > 0) || !(cmd.materialize > 0)) return 0;
  return cmd.halfH * (GLASS_SHADOW_DY_FRAC + BLUR_SUPPORT_SIGMAS * GLASS_SHADOW_SIGMA_FRAC);
}

/**
 * Pure function. How far a materialFill's optional soft shadow (drawMaterialShadow)
 * reaches past the fill, in local units: the rounded rect is GROWN by `grow`,
 * offset by (dx, dy) and mask-blurred by `blur` (3σ support). Symmetric for the
 * same rotation-safety reason as glassShadowReach. Zero for no shadow.
 *
 * @example materialShadowReach(null) // 0
 * @example materialShadowReach({dx: 3, dy: 4, blur: 2, alpha: 0.4, grow: 1}) // 12 (1 grow + 5 offset + 3·2 blur)
 * @example materialShadowReach({dx: 3, dy: 4, blur: 2, alpha: 0, grow: 1}) // 0 (alpha 0 paints nothing)
 */
function materialShadowReach(shadow) {
  if (!shadow || !(shadow.alpha > 0)) return 0;
  return shadow.grow + Math.hypot(shadow.dx, shadow.dy) + shadow.blur * BLUR_SUPPORT_SIGMAS;
}

/** Pure function. `r` grown by `m` on every side.
 * @example inflateRect({x: 10, y: 20, w: 4, h: 6}, 1) // {x: 9, y: 19, w: 6, h: 8}
 */
function inflateRect(r, m) {
  return m > 0 ? { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m } : r;
}

// INK HEADROOM around laid-out glyph geometry, in ems of the largest font size in
// the op. Text metrics bound the ADVANCE box, not the outline: an italic's overhang,
// a swash, an emoji drawn past its cell, and the OUTLINE-stroke glyph pass all reach
// outside it. One em is the headroom text_layout.js already uses for exactly this
// question (glyphGroupBounds pads a glyph group's origin span by `group.size` to
// frame a gradient), so this is that convention reused rather than a second guess.
const TEXT_INK_PAD_EMS = 1;

/**
 * Pure function. The largest font size a text op can draw at: its own `size` plus
 * every rich run's (a run always carries a resolved size — core/richtext.js
 * normalizeRichText fills it from the widget style or DEFAULT_PARA_SIZE), falling
 * back to text_layout's DEFAULT_TEXT_SIZE when an op carries none at all. Used only
 * to scale the ink headroom, so an over-estimate is harmless and an under-estimate
 * would clip.
 *
 * @param {object} cmd a `text` IR op
 * @returns {number} the largest font size in local units
 *
 * @example textOpMaxFontSize({size: 36, rich: null}) // 36
 * @example textOpMaxFontSize({size: 12, rich: {runs: [{size: 12}, {size: 48}]}}) // 48
 * @example textOpMaxFontSize({}) // 36 (DEFAULT_TEXT_SIZE)
 */
function textOpMaxFontSize(cmd) {
  let max = Number.isFinite(cmd.size) ? cmd.size : DEFAULT_TEXT_SIZE;
  for (const run of cmd.rich?.runs ?? []) if (Number.isFinite(run.size) && run.size > max) max = run.size;
  return max;
}

/**
 * Query→build (builds/reuses the cached Paragraph stack). The LOCAL bounds of a
 * `text` op's INK, padded by TEXT_INK_PAD_EMS.
 *
 * WHY THIS EXISTS. Text used to have no case in opLocalBounds, so an effected text
 * widget — a drop shadow on a caption, a glow on a title — reported UNBOUNDED and
 * handleEffectSubtree allocated and processed an offscreen THE SIZE OF THE WHOLE
 * SURFACE for a few lines of type. Measured (a 240×60 caption over a 960×540 frame,
 * .frenzy/render_cost/probe_region_cost.js): 518,400 offscreen px and 137.0 ms,
 * against 40,836 px and 16.6 ms for the SAME shadow on a rect of the same size —
 * 12.7x the pixels for 8.3x the time, and it scaled with the CANVAS rather than with
 * the widget (34.4 / 137.0 / 311.0 ms at 480×270 / 960×540 / 1440×810).
 *
 * The bounds come from the SAME cached layout the draw uses (text_layout.getTextLayout),
 * so they cannot describe a different stack than the one rasterized:
 *   · WIDTH — the wrap box when finite, OR the longest intrinsic line, whichever is
 *     larger. Neither alone is safe: a fixed box can be overrun by a single unbroken
 *     word (which is why the intrinsic width matters), and a right/centre-aligned
 *     paragraph places glyphs against the box edge (which is why the box matters).
 *   · VERTICAL — from the vertical-align offset to the stack bottom. The offset is
 *     NEGATIVE when the text overflows its box (a middle/bottom valign of a stack
 *     taller than boxH), so the top is min(0, vOffset), never just 0.
 * `boxH` is deliberately NOT a bound: the op carries it, but overflow is not clipped.
 *
 * The layout cache is keyed partly on opacity, and bounds are opacity-INDEPENDENT, so
 * this passes the op's own opacity: worst case that is one extra cached build, never
 * a wrong rect.
 *
 * @param CanvasKit the initialized CanvasKit module
 * @param {object} cmd a `text` IR op
 * @param fontCollection the shared FontCollection (the layout needs real metrics)
 * @returns {{x: number, y: number, w: number, h: number}} local-unit bounds
 */
function textOpLocalBounds(CanvasKit, cmd, fontCollection) {
  const layout = getTextLayout(CanvasKit, fontCollection, cmd, cmd.opacity ?? 1);
  const pad = TEXT_INK_PAD_EMS * textOpMaxFontSize(cmd);
  const width = Math.max(Number.isFinite(cmd.boxW) ? cmd.boxW : 0, layout.contentWidth());
  const top = Math.min(0, layout.vOffset);
  return inflateRect({ x: cmd.x, y: cmd.y + top, w: width, h: layout.contentBottom - top }, pad);
}

/**
 * Pure function. The LOCAL bounds of a `mermaidVector` op: its own box, grown by the
 * two things a diagram draws past the fitted viewBox — the centred half stroke of its
 * widest path and one em of ink headroom for its largest text label — both mapped
 * from viewBox units into local units by the same fit the draw uses (drawMermaidVector:
 * fitBox when preserveAspect, else an independent stretch per axis).
 *
 * Same defect as text: with no case here a mermaid diagram carrying any effect
 * reported UNBOUNDED and took a whole-surface effect substrate.
 *
 * @param {object} cmd a `mermaidVector` IR op
 * @returns {{x: number, y: number, w: number, h: number}} local-unit bounds
 *
 * @example // a 100x50 viewBox fitted into a 200x200 box: scale 2, a 3-wide stroke reaches 3 local units out
 * @example mermaidVectorLocalBounds({x: 0, y: 0, w: 200, h: 200, viewBox: {minX: 0, minY: 0, w: 100, h: 50}, paths: [{strokeWidth: 3}], texts: []}) // {x: -3, y: -3, w: 206, h: 206}
 * @example mermaidVectorLocalBounds({x: 10, y: 10, w: 100, h: 100, viewBox: {minX: 0, minY: 0, w: 100, h: 100}, paths: [], texts: []}) // {x: 10, y: 10, w: 100, h: 100} (no strokes, no labels: exactly the box)
 */
function mermaidVectorLocalBounds(cmd) {
  const scale = cmd.preserveAspect !== false
    ? fitBox(cmd.viewBox.w, cmd.viewBox.h, cmd.w, cmd.h).scale
    : Math.max(cmd.w / cmd.viewBox.w, cmd.h / cmd.viewBox.h);
  let halfStroke = 0, labelEm = 0;
  for (const p of cmd.paths) if (Number.isFinite(p.strokeWidth) && p.strokeWidth / 2 > halfStroke) halfStroke = p.strokeWidth / 2;
  for (const t of cmd.texts) if (Number.isFinite(t.size) && t.size > labelEm) labelEm = t.size;
  return inflateRect({ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }, (halfStroke + TEXT_INK_PAD_EMS * labelEm) * scale);
}

/**
 * Near-pure function (transiently allocates + frees one WASM Path to measure a
 * `path` op, and builds/reuses the cached Paragraph stack for a `text` one;
 * deterministic, nothing outside is read or written). The LOCAL bounds ONE IR op can
 * draw into, in the op's own local units: its geometry grown by the HALF STROKE WIDTH
 * (Skia centres a stroke on the path, so a bordered widget reaches strokeWidth/2
 * OUTSIDE its declared box) and by the mask-blur support where an op carries one.
 *
 * Returns UNBOUNDED_EXTENT for anything it cannot bound (see that sentinel).
 * Subtree ops are NOT handled here — contentDeviceBounds recurses into them.
 *
 * @param cmd one flattened IR op
 * @param ctx the paint context (only `fontCollection` is read, to lay text out)
 * @returns {{x, y, w, h}|symbol}
 *
 * @example opLocalBounds(CanvasKit, {op: "rect", x: 0, y: 0, w: 200, h: 150, strokeWidth: 0}, ctx) // {x: 0, y: 0, w: 200, h: 150}
 * @example opLocalBounds(CanvasKit, {op: "rect", x: 0, y: 0, w: 200, h: 150, stroke: [0, 0, 0, 1], strokeWidth: 12}, ctx) // {x: -6, y: -6, w: 212, h: 162} (the centred border reaches 6 outside)
 * @example opLocalBounds(CanvasKit, {op: "blurBackdrop", radius: 4}, ctx) // UNBOUNDED_EXTENT (a full-canvas sampler has no geometry)
 */
function opLocalBounds(CanvasKit, cmd, ctx) {
  const halfStroke = cmd.stroke && cmd.strokeWidth > 0 ? cmd.strokeWidth / 2 : 0;
  switch (cmd.op) {
    case "text":
      return textOpLocalBounds(CanvasKit, cmd, ctx.fontCollection);
    case "mermaidVector":
      return mermaidVectorLocalBounds(cmd);
    case "rect":
      return inflateRect({ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }, halfStroke);
    case "ellipse":
      return inflateRect({ x: cmd.cx - cmd.rx, y: cmd.cy - cmd.ry, w: 2 * cmd.rx, h: 2 * cmd.ry }, halfStroke);
    case "polygon":
      return pointsBounds(cmd.points);
    case "polyline":
      // Round caps/joins reach exactly half the stroke width past every vertex.
      return inflateRect(pointsBounds(cmd.points), cmd.width / 2);
    case "path": {
      const skPath = CanvasKit.Path.MakeFromSVGString(cmd.d);
      if (!skPath) throw new Error(`paintIR(skia): path "d" failed to parse: ${JSON.stringify(cmd.d).slice(0, 64)}`);
      const b = skPath.getBounds();
      skPath.delete();
      // The optional soft mask blur spreads its kernel support past the geometry.
      return inflateRect({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] },
        halfStroke + (cmd.blur > 0 ? cmd.blur * BLUR_SUPPORT_SIGMAS : 0));
    }
    case "image": case "video": case "videoV5": case "videoFrame": case "videoV5Frame": case "videoV2":
      return { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }; // a sampled quad, exactly its dest box
    case "latexVector":
      return { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }; // fitBox maps the glyph viewBox INSIDE the box
    case "cropSubtree":
      // The content is CLIPPED to this rounded rect, so the op's own box + border
      // bounds the whole subtree — no recursion needed.
      return inflateRect({ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }, halfStroke);
    // ── the BACKDROP / MATERIAL region ops ────────────────────────────────────
    // Their COVERAGE is their own rounded box: every one of these shaders returns
    // premultiplied ZERO outside its SDF, and the box-shaped clip each handler
    // installs is only an outer bound on that. Their sample DISPLACEMENT
    // (refraction, chromatic aberration, a barrel warp, magnification) reaches
    // outward but only affects what they READ, never where they WRITE — which is
    // why these used to be UNBOUNDED here and no longer need to be. Bounding them
    // is what keeps an effected backdrop panel on the region-cropped effect
    // substrate instead of a whole-canvas one.
    case "glassBackdrop":
      return inflateRect(roundedBoxBounds(cmd), halfStroke + glassShadowReach(cmd));
    case "materialBackdrop":
      return inflateRect(roundedBoxBounds(cmd), halfStroke);
    case "materialFill":
      return inflateRect(roundedBoxBounds(cmd), halfStroke + materialShadowReach(cmd.shadow));
    case "magnifyBackdrop":
      // The lens clip bounds the write: the box/star silhouette is inscribed in
      // the (halfW, halfH) box, the circle in its radius.
      return inflateRect(cmd.shape === "circle"
        ? { x: cmd.cx - cmd.r, y: cmd.cy - cmd.r, w: cmd.r * 2, h: cmd.r * 2 }
        : roundedBoxBounds(cmd), halfStroke);
    default:
      return UNBOUNDED_EXTENT;
  }
}

/**
 * Near-pure function (inherits opLocalBounds' transient WASM Path allocation).
 * The DEVICE-px bounds the flattened content `flat` can draw into, as
 * {x0, y0, x1, y1} — or null when ANY op is unbounded (the caller then uses the
 * whole surface). An EMPTY result (x0 > x1) means the content draws nothing.
 *
 * Each op's local bounds (opLocalBounds) are mapped through its own absolute
 * world by all four corners (rotation-safe, exact unrotated) and then through the
 * view, mirroring applyView's device = (world·zoom + pan)·dpr. A nested
 * effectSubtree contributes ITS content's bounds grown by its own halo `margin`
 * (ir.js computes that from the nested blur support + shadow offset).
 */
function contentDeviceBounds(CanvasKit, flat, view, ctx) {
  const ds = view.zoom * view.dpr, px = view.panX * view.dpr, py = view.panY * view.dpr;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (dx, dy) => { x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); };
  for (const { cmd, world } of flat) {
    if (cmd.op === "effectSubtree") {
      const inner = contentDeviceBounds(CanvasKit, flattenIR(cmd.content), view, ctx);
      if (!inner) return null;
      if (inner.x0 > inner.x1) continue; // the nested effect draws nothing
      const m = cmd.margin * world.scale * ds; // its shadow/bloom halo, device px
      grow(inner.x0 - m, inner.y0 - m);
      grow(inner.x1 + m, inner.y1 + m);
      continue;
    }
    const local = opLocalBounds(CanvasKit, cmd, ctx);
    if (local === UNBOUNDED_EXTENT) return null;
    for (const [lx, ly] of [[local.x, local.y], [local.x + local.w, local.y], [local.x, local.y + local.h], [local.x + local.w, local.y + local.h]]) {
      const p = T.apply(world, lx, ly);
      grow(p.x * ds + px, p.y * ds + py);
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Near-pure function (inherits opLocalBounds' transient WASM Path allocation).
 * The device-px SOURCE REGION handleEffectSubtree renders the content into: the
 * content's own device bounds (contentDeviceBounds) plus the per-side margin the
 * composites need, clamped to the surface. Returns integer
 * {x0, y0, w, h}, or null when nothing of the effect can land on the surface.
 *
 * WHICH EFFECTS NEED SOURCE MARGIN — only the INNER SHADOW. The shadow and the
 * bloom are Skia ImageFilters applied when the content image is BLITTED, and
 * Skia draws a filter's output past the source image's rect, so their halo needs
 * no room in the source. Soft edges only erode coverage inward and are clipped
 * back to the sharp content (DstIn), so they need none either. The inner shadow
 * DOES: drawInnerShadow fills its field surface with opaque shadow colour, punches
 * the OFFSET silhouette out of it, and blurs that with TileMode.Clamp — the field
 * boundary must lie outside the offset silhouette or the clamp replicates a hole
 * instead of opaque colour. That is exactly effects.js effectSourceRect's per-side
 * contract: `reach` every side, plus the offset on the side the shadow moves toward.
 *
 * CLAMPING TO THE SURFACE is what keeps the crop a pure optimization: the
 * pre-crop code rendered the content into a device-sized surface, so content past
 * the canvas edge was already clipped away (and could not blur back inward).
 */
function effectRegion(CanvasKit, cmd, flatContent, view, scale, ctx) {
  const bounds = contentDeviceBounds(CanvasKit, flatContent, view, ctx);
  // Unbounded content ⇒ the whole surface: the exact pre-crop source rect.
  if (!bounds) return { x0: 0, y0: 0, w: ctx.deviceW, h: ctx.deviceH };
  if (bounds.x0 > bounds.x1) return null; // draws nothing
  const inner = cmd.innerShadow;
  const reach = COVERAGE_AA_SLOP_PX + (inner ? inner.blur * scale * BLUR_SUPPORT_SIGMAS : 0);
  const src = effectSourceRect(
    (bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2,
    (bounds.x1 - bounds.x0) / 2, (bounds.y1 - bounds.y0) / 2,
    reach, inner ? inner.dx * scale : 0, inner ? inner.dy * scale : 0);
  const x0 = Math.max(0, Math.floor(src.x)), y0 = Math.max(0, Math.floor(src.y));
  const x1 = Math.min(ctx.deviceW, Math.ceil(src.x + src.w)), y1 = Math.min(ctx.deviceH, Math.ceil(src.y + src.h));
  if (x1 <= x0 || y1 <= y0) return null; // entirely off-surface
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Query→build. A copy of `contentImg` whose ALPHA is feathered INWARD by
 * `feather` device px — the edges fade to transparency (PowerPoint "Soft
 * Edges"). Caller deletes the returned Image.
 *
 * TECHNIQUE (alpha-only, interior color stays crisp): build a FEATHER MASK from
 * the content's own silhouette by ERODING it inward `feather` px (Skia
 * morphology min) then Gaussian-blurring it with σ = feather / BLUR_SUPPORT_SIGMAS.
 * A step edge eroded inward `feather` then blurred at that σ ramps its coverage
 * from ≈0 at the ORIGINAL edge (the eroded boundary sits `feather` = 3σ inside,
 * so the edge is 3σ out on the falling tail → ~0) up to ≈1 by `feather` inside
 * (the 50% crossing) and fully opaque by ~2·`feather` inside — a smooth inward
 * fade that reaches transparent exactly at the silhouette. The mask is then
 * DstIn-multiplied onto a SHARP copy of the content (result.alpha =
 * sharpAlpha · maskAlpha), so only the rim's alpha is softened while the
 * interior keeps its crisp pixels. Because erosion only shrinks coverage, the
 * feather never spills OUTSIDE the original silhouette (no outward halo — why
 * effectSubtree.margin ignores soft edges).
 *
 * Erosion uses the FULL feather as its radius and the blur reuses the shared 3σ
 * kernel-support constant (BLUR_SUPPORT_SIGMAS), so there is no free magic
 * number — the two are tied to the codebase's existing "3σ = full support"
 * convention. A feather wider than the widget erodes the whole silhouette away,
 * dissolving it to transparent (a consistent over-feather, not an error).
 *
 * @param ctx - {makeSurface, deviceW, deviceH} sized to the effect SOURCE REGION
 * @param contentImg - the widget's offscreen render over that region (alpha = shape)
 * @param feather - the inward feather amount in DEVICE px (> 0; caller gates 0)
 */
function featherEdges(CanvasKit, ctx, contentImg, feather) {
  const sigma = feather / BLUR_SUPPORT_SIGMAS; // 3σ tail reaches ~0 at the original edge
  // MASK = silhouette eroded inward `feather`, then softened by σ. Decal tiles
  // treat outside as transparent so the blur can't invent coverage past the edge.
  const erode = CanvasKit.ImageFilter.MakeErode(feather, feather, null);
  const maskFilter = CanvasKit.ImageFilter.MakeBlur(sigma, sigma, CanvasKit.TileMode.Decal, erode);

  const surf = ctx.makeSurface(ctx.deviceW, ctx.deviceH);
  if (!surf) throw new Error("paintIR(skia): makeSurface for soft-edge feather returned null");
  const c = surf.getCanvas();
  c.clear(CanvasKit.Color4f(0, 0, 0, 0));
  // (1) SHARP content — keeps the interior color/detail unblurred.
  c.drawImage(contentImg, 0, 0, null);
  // (2) DstIn the feathered mask (dst · src.alpha) — multiplies the sharp
  //     content's alpha by the inward fade, softening only the rim.
  const p = new CanvasKit.Paint();
  p.setImageFilter(maskFilter);
  p.setBlendMode(CanvasKit.BlendMode.DstIn);
  c.drawImage(contentImg, 0, 0, p);
  p.delete();
  maskFilter.delete(); erode.delete();

  surf.flush();
  const out = surf.makeImageSnapshot();
  surf.dispose();
  return out;
}

/**
 * Command (draws on `canvas` at the device root). Composites an INNER SHADOW into
 * the widget's own silhouette from its offscreen render `contentImg` (whose alpha
 * IS the shape). The recipe, using only coverage blends (no ImageFilter branch):
 *
 *   1. FIELD = fill the surface with opaque shadow color, then DstOut the shape
 *      OFFSET by (dx, dy) — leaving shadow color everywhere EXCEPT the offset
 *      shape (a hole). Blur it (σ) so the hole edge is soft.
 *   2. CLIP = keep the blurred field only where the ORIGINAL shape has alpha
 *      (DstIn with `contentImg`) — so the darkness lives strictly INSIDE the
 *      shape, concentrated at the edge the offset pushes toward and fading inward.
 *   3. draw the result OVER the widget at alpha = colorAlpha·opacity.
 *
 * This is the exact mirror of the drop shadow (a blurred/offset silhouette), but
 * clipped INSIDE instead of drawn under — a recessed/inset look for any vector
 * object. `scale` = world.scale·zoom·dpr (world length → device px), so dx/dy/blur
 * match the drop shadow's device scaling.
 *
 * @param contentImg - the widget's offscreen render over the effect SOURCE REGION (alpha = shape)
 * @param inner - {dx, dy, blur, color:[r,g,b,a], opacity} (world-unit dx/dy/blur)
 * @param scale - world→device length factor
 * @param ctx - {makeSurface, deviceW, deviceH} sized to the source REGION, not the device
 * @param originX, originY - the region's device-px origin (where contentImg sits)
 */
function drawInnerShadow(CanvasKit, canvas, contentImg, inner, scale, ctx, originX, originY) {
  const alpha = (inner.color[3] ?? 1) * inner.opacity; // color alpha × the gate/strength
  if (alpha <= 0) return;
  const offX = inner.dx * scale, offY = inner.dy * scale;
  const sigma = inner.blur * scale;
  const [r, g, b] = inner.color;

  // (1) FIELD: opaque shadow color minus the offset shape (a soft-edged hole).
  const field = ctx.makeSurface(ctx.deviceW, ctx.deviceH);
  if (!field) throw new Error("paintIR(skia): makeSurface for inner-shadow field returned null");
  const fc = field.getCanvas();
  fc.clear(CanvasKit.Color4f(0, 0, 0, 0));
  const fill = new CanvasKit.Paint();
  fill.setColor(CanvasKit.Color4f(r, g, b, 1));
  fc.drawPaint(fill);
  fill.delete();
  const punch = new CanvasKit.Paint();
  punch.setBlendMode(CanvasKit.BlendMode.DstOut); // dst · (1 - srcAlpha): remove where the offset shape is
  fc.drawImage(contentImg, offX, offY, punch);
  punch.delete();
  field.flush();
  const fieldImg = field.makeImageSnapshot();
  const blurred = blurredImageOf(CanvasKit, ctx, fieldImg, sigma, ctx.deviceW, ctx.deviceH);
  fieldImg.delete();
  field.dispose();

  // (2) CLIP to the ORIGINAL shape interior (DstIn keeps dst where src alpha).
  const clip = ctx.makeSurface(ctx.deviceW, ctx.deviceH);
  if (!clip) throw new Error("paintIR(skia): makeSurface for inner-shadow clip returned null");
  const cc = clip.getCanvas();
  cc.clear(CanvasKit.Color4f(0, 0, 0, 0));
  cc.drawImage(blurred, 0, 0, null);
  const keep = new CanvasKit.Paint();
  keep.setBlendMode(CanvasKit.BlendMode.DstIn);
  cc.drawImage(contentImg, 0, 0, keep);
  keep.delete();
  clip.flush();
  const innerImg = clip.makeImageSnapshot();
  blurred.delete();
  clip.dispose();

  // (3) draw over the widget at colorAlpha·opacity, at the region's origin.
  const out = new CanvasKit.Paint();
  out.setAlphaf(Math.max(0, Math.min(1, alpha)));
  canvas.drawImage(innerImg, originX, originY, out);
  out.delete();
  innerImg.delete();
}

/**
 * Query→build. Bloom image filter: optional Gaussian blur (sigma device px)
 * then an RGB scale by `strength` (leaves alpha, so drawing with BlendMode.Plus
 * adds strength·premultiplied-color — additive light, clamped per pixel). Caller
 * deletes.
 */
function bloomFilter(CanvasKit, sigma, strength) {
  const s = strength;
  const cf = CanvasKit.ColorFilter.MakeMatrix([
    s, 0, 0, 0, 0,
    0, s, 0, 0, 0,
    0, 0, s, 0, 0,
    0, 0, 0, 1, 0,
  ]);
  const blur = sigma > 0 ? CanvasKit.ImageFilter.MakeBlur(sigma, sigma, CanvasKit.TileMode.Decal, null) : null;
  const filt = CanvasKit.ImageFilter.MakeColorFilter(cf, blur);
  cf.delete();
  if (blur) blur.delete();
  return filt;
}

/**
 * Command (mutates `paint`). Sets the composite for an IR blend name — the ONE
 * place a blend id becomes a Skia composite. Two dispatches, per
 * skia/blend_modes.js: a mode Skia implements natively is one setBlendMode()
 * (free), and one of Photoshop's nine Skia-less modes is a cached SkSL runtime
 * blender via setBlender(). The blender is module-cached, so nothing to delete.
 *
 * An UNKNOWN name THROWS. It used to fall through a `default:` to SrcOver, which
 * silently painted Normal — an invisible wrong render, and the one failure mode
 * that makes a typo'd or unimplemented mode impossible to notice.
 */
function applyBlend(CanvasKit, paint, blend) {
  const nativeKey = SKIA_NATIVE_BLEND_MODES[blend];
  if (nativeKey) { paint.setBlendMode(CanvasKit.BlendMode[nativeKey]); return; }
  if (blendNeedsSkSL(blend)) { paint.setBlender(blenderFor(CanvasKit, blend)); return; }
  throw new Error(`paintIR(skia): unknown blend mode "${blend}" — no native CanvasKit.BlendMode and no SkSL body (see render_gpu/skia/blend_modes.js; ir.js effectSubtree validates against core/properties.js BLEND_MODES)`);
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Command (draws `img` at the device origin at `opacity`, linear sampling). */
function blitImage(CanvasKit, canvas, img, opacity) {
  const p = new CanvasKit.Paint();
  p.setAlphaf(opacity);
  canvas.drawImageOptions(img, 0, 0, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, p);
  p.delete();
}

/** Command (console.warn, once per key). Loud-but-not-fatal notice for unreachable depth caps. */
const _warned = new Set();
function reportOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(msg);
}

/** Helper. A filled Paint for a solid rgba OR a gradient Paint (opacity folded
 * into alpha / stop alpha). A gradient needs the op's LOCAL `bounds` ({x,y,w,h})
 * — the objectBoundingBox the gradient maps onto. Any gradient shader is stashed
 * on the paint as `_gradientShader` so withPaint disposes it. `aa` is the camera's
 * coverage-AA flag (ctx.antialias): false ⇒ crisp jagged edges. Caller deletes. */
function fillPaint(CanvasKit, paint, opacity, bounds = null, aa = true) {
  const p = new CanvasKit.Paint();
  p.setStyle(CanvasKit.PaintStyle.Fill);
  p.setAntiAlias(aa);
  applyPaint(CanvasKit, p, paint, opacity, bounds);
  return p;
}

/** Helper. A stroked Paint for a solid rgba OR a gradient Paint. `bounds` frames
 * a gradient stroke's objectBoundingBox (see fillPaint); `aa` is the camera's
 * coverage-AA flag. Caller deletes. */
function strokePaint(CanvasKit, paint, width, opacity, bounds = null, aa = true) {
  const p = new CanvasKit.Paint();
  p.setStyle(CanvasKit.PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setAntiAlias(aa);
  applyPaint(CanvasKit, p, paint, opacity, bounds);
  return p;
}

/** Command (mutates `p`). Sets a solid color OR a gradient shader on a Paint. A
 * gradient (isGradientPaint) requires `bounds`; its shader is stashed on the
 * paint as `_gradientShader` for withPaint to dispose. A solid folds opacity into
 * alpha (byte-identical to the old fillPaint/strokePaint). */
function applyPaint(CanvasKit, p, paint, opacity, bounds) {
  if (isGradientPaint(paint)) {
    if (!bounds) throw new Error("paintIR(skia): a gradient paint needs the op's local bounds (internal invariant)");
    const shader = skShaderForPaint(CanvasKit, paint, bounds, opacity);
    p.setShader(shader);
    p._gradientShader = shader;
  } else {
    p.setColor(CanvasKit.Color4f(paint[0], paint[1], paint[2], paint[3] * opacity));
  }
}

/** Pure function. The LOCAL bbox {x,y,w,h} of a list of [x,y] points (a polygon's
 * gradient objectBoundingBox frame). Empty input → a zero rect.
 *
 * @example pointsBounds([[0, 0], [10, 0], [5, 8]]) // {x: 0, y: 0, w: 10, h: 8}
 */
function pointsBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Helper. Runs `draw` with `paint`, then deletes the paint AND any gradient
 * shader it carries (WASM cleanup). */
function withPaint(CanvasKit, paint, draw) {
  draw(paint);
  if (paint._gradientShader) paint._gradientShader.delete();
  paint.delete();
}

/** Helper. A Path from [[x,y],...] points via PathBuilder. Caller deletes. */
function buildPath(CanvasKit, points, close) {
  const b = new CanvasKit.PathBuilder();
  b.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) b.lineTo(points[i][0], points[i][1]);
  if (close) b.close();
  const path = b.detach();
  b.delete();
  return path;
}

// ── TEXT: the CanvasKit Paragraph path (fallback + shaping + COLOR EMOJI) ──────
// The text op is laid out with the Paragraph API against the injected
// FontCollection, so every codepoint the primary font lacks falls back
// per-glyph (Greek/Cyrillic/Arabic) and COLOR EMOJI renders in its own palette —
// the single-CanvasKit.Font drawText this replaced rendered those as ☐ tofu.
//
// WHAT MAPS TO PARAGRAPH: per-run bold/italic/underline/strike/size/font/color
// (TextStyle), per-run highlight (TextStyle.backgroundColor), per-paragraph
// align/lineSpacing/char+wordSpacing (ParagraphStyle + strut), box valign
// (a manual y-offset over the paragraph stack), and the top-left origin.
//
// WHAT IS NOT EXPRESSED (deliberate, flagged): per-run OUTLINE (outlineWidth) —
// Paragraph TextStyle has no per-run stroke Paint, and the single-Font path this
// replaced never rendered an outline either, so this is not a regression from the
// prior Skia baseline; it stays a follow-up. LAYOUT PARITY: the screen now shapes
// through HarfBuzz/Paragraph while SVG/PDF export still layouts via
// core/richtext.js — wrap points / line heights / decoration offsets can differ
// slightly (documented in fonts/README.md; the vector-export emoji/CJK work is a
// separate follow-up).

/**
 * Command (draws a text op on `canvas` in local space, top-left origin). Handles
 * BOTH the rich op ({rich:{runs,paras}, boxW, boxH, boxStyle}) and the legacy
 * single-run op (plain {text,size,color,bold,font}). Builds/reuses the ONE cached
 * CanvasKit Paragraph stack through text_layout.getTextLayout — the SAME layout
 * the in-place editor queries for caret/selection geometry, so render and editor
 * can never disagree — then draws each paragraph at its local yTop (valign-shifted).
 * The layout is CACHED (not deleted per frame); the cache bounds WASM lifetime.
 */
function drawTextOp(CanvasKit, canvas, cmd, opacity, fontCollection, aa = true) {
  const layout = getTextLayout(CanvasKit, fontCollection, cmd, opacity);
  // `aa` reaches the OUTLINE-stroke + gradient-fill glyph passes (text_layout
  // draw). The plain Paragraph fill is drawn by CanvasKit's own glyph rasterizer,
  // which has no per-draw coverage flag — so solid, un-outlined text keeps its
  // internal AA regardless; the toggle bites on shapes, outlines, and vector text.
  layout.draw(canvas, cmd.x, cmd.y, aa);
}
