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

import { flattenIR, parseColor, isGradientPaint, MAX_LENS_DEPTH } from "../ir.js";
import { getTextLayout } from "./text_layout.js";
import { skShaderForPaint } from "./gradient.js";
import { GLASS_SKSL, packGlassUniforms } from "./glass_shader.js";
import * as T from "../../core/transform.js";
import { fitBox } from "../../core/geometry.js";

const RAD2DEG = 180 / Math.PI;

// Recursion caps: a lens NESTED inside a lens replay falls back to backdrop
// sampling at MAX_SUPERSAMPLE_DEPTH (= the shared ir.js MAX_LENS_DEPTH, the SAME
// bound every backend uses); crop/effect content re-renders are separately
// bounded (unreachable for plugin-emitted documents — the deepest legit chain is
// ~3 — but a pathological hand-built nesting is skipped loudly, not crashed).
const MAX_SUPERSAMPLE_DEPTH = MAX_LENS_DEPTH; // shared lens-depth cap (ir.js)
const MAX_REENDER_DEPTH = 4;     // crop re-render nesting bound
const MAX_EFFECT_DEPTH = 2;      // effect re-render nesting bound

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
 */
export function paintIR(CanvasKit, canvas, commands, view, { media = {}, background = "#ffffff", fontCollection, scissor = null, makeSurface = null } = {}) {
  if (!fontCollection) throw new Error("paintIR(skia): a fontCollection is required (committed families + Noto fallback chain)");
  const flat = flattenIR(commands);
  const bg = parseColor(background);
  const bgColor = CanvasKit.Color4f(bg[0], bg[1], bg[2], bg[3]);
  const bounds = canvas.getDeviceClipBounds(); // [l, t, r, b] in device px; fresh canvas ⇒ full surface
  // Offscreen surfaces for backdrop/lens/effect. Browser passes a GPU-backed
  // factory (MakeRenderTarget); Node defaults to CPU MakeSurface.
  const mkSurface = makeSurface || ((w, h) => CanvasKit.MakeSurface(w, h));
  const ctx = { media, fontCollection, deviceW: bounds[2] - bounds[0], deviceH: bounds[3] - bounds[1], makeSurface: mkSurface };
  // The letterbox clip (device px), built once — applied AFTER the full-surface
  // clear so the bars keep `background` and only the scene is clipped.
  const scissorRect = scissor ? CanvasKit.LTRBRect(scissor.x, scissor.y, scissor.x + scissor.w, scissor.y + scissor.h) : null;

  // Only blur and SOFT (non-supersample) magnifiers read the composite-so-far, so
  // only they need the whole-scene offscreen. A supersample magnifier RE-RENDERS
  // just the content below it into a small lens-sized surface, so a scene whose
  // only samplers are supersample lenses takes the fast direct-to-canvas path — no
  // full-scene offscreen, no CPU→GPU blit.
  // glassBackdrop RE-RENDERS the below-content itself (at its chosen resolution),
  // like a supersample magnifier, so it does NOT force the owned-offscreen path.
  const needsBackdrop = flat.some(({ cmd }) => cmd.op === "blurBackdrop" || (cmd.op === "magnifyBackdrop" && !cmd.supersample));
  if (!needsBackdrop) {
    // Fast path: no backdrop sampler ⇒ draw straight onto the caller's canvas.
    canvas.clear(bgColor);
    if (scissorRect) { canvas.save(); canvas.clipRect(scissorRect, CanvasKit.ClipOp.Intersect, true); }
    paintFlat(CanvasKit, { canvas, surface: null }, flat, view, ctx, 0);
    if (scissorRect) canvas.restore();
    return;
  }

  // Backdrop path: own an offscreen surface so samplers can read composite-so-far.
  const scene = ctx.makeSurface(ctx.deviceW, ctx.deviceH);
  if (!scene) throw new Error("paintIR(skia): makeSurface for backdrop compositing returned null");
  const sceneCanvas = scene.getCanvas();
  sceneCanvas.clear(bgColor);
  paintFlat(CanvasKit, { canvas: sceneCanvas, surface: scene }, flat, view, ctx, 0);
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
 * Command (draws on target.canvas). Walks the FLATTENED command list, drawing
 * each op in its already-resolved `world`. Leaf ops draw in local space (the
 * view+world CTM); backdrop/subtree ops are handled from the device root
 * (between-op state) where they control their own transforms and clips.
 *
 * Args:
 *   target ({canvas, surface}): the canvas to draw on and the Surface backing
 *     it (surface is null on the fast path; backdrop samplers require it)
 *   flat (object[]): flattenIR output — [{cmd, world}]
 *   depth (number): re-render recursion depth (for the compositor's caps)
 */
function paintFlat(CanvasKit, target, flat, view, ctx, depth) {
  const canvas = target.canvas;
  for (let i = 0; i < flat.length; i++) {
    const { cmd, world } = flat[i];
    switch (cmd.op) {
      case "blurBackdrop":
        handleBlurBackdrop(CanvasKit, target, cmd, world, view);
        break;
      case "magnifyBackdrop":
        // "Below" (z-order) = everything emitted before this op at this level.
        handleMagnifyBackdrop(CanvasKit, target, cmd, world, view, flat.slice(0, i), ctx, depth);
        break;
      case "glassBackdrop":
        // "Below" (z-order) = everything emitted before this op at this level.
        handleGlassBackdrop(CanvasKit, target, cmd, world, view, flat.slice(0, i), ctx, depth);
        break;
      case "cropSubtree":
        handleCropSubtree(CanvasKit, target, cmd, world, view, ctx, depth);
        break;
      case "effectSubtree":
        handleEffectSubtree(CanvasKit, target, cmd, world, view, ctx, depth);
        break;
      default: {
        const opacity = cmd.opacity ?? 1;
        canvas.save();
        applyView(canvas, view, world);
        drawLeafOp(CanvasKit, canvas, cmd, opacity, ctx.media, ctx.fontCollection);
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

/** Command (draws one leaf op on `canvas` in its already-transformed local space). */
function drawLeafOp(CanvasKit, canvas, cmd, opacity, media, fontCollection) {
  switch (cmd.op) {
    case "rect": {
      const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius, cmd.cornerRadius);
      const bounds = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };
      if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds), (p) => canvas.drawRRect(rr, p));
      if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds), (p) => canvas.drawRRect(rr, p));
      break;
    }
    case "ellipse": {
      const oval = CanvasKit.LTRBRect(cmd.cx - cmd.rx, cmd.cy - cmd.ry, cmd.cx + cmd.rx, cmd.cy + cmd.ry);
      const bounds = { x: cmd.cx - cmd.rx, y: cmd.cy - cmd.ry, w: 2 * cmd.rx, h: 2 * cmd.ry };
      if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds), (p) => canvas.drawOval(oval, p));
      if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds), (p) => canvas.drawOval(oval, p));
      break;
    }
    case "polyline": {
      const path = buildPath(CanvasKit, cmd.points, false);
      const p = strokePaint(CanvasKit, cmd.color, cmd.width, opacity);
      p.setStrokeCap(CanvasKit.StrokeCap.Round);
      p.setStrokeJoin(CanvasKit.StrokeJoin.Round);
      canvas.drawPath(path, p);
      path.delete(); p.delete();
      break;
    }
    case "polygon": {
      const path = buildPath(CanvasKit, cmd.points, true);
      withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, pointsBounds(cmd.points)), (p) => canvas.drawPath(path, p));
      path.delete();
      break;
    }
    case "path":
      drawPathOp(CanvasKit, canvas, cmd, opacity);
      break;
    case "text":
      drawTextOp(CanvasKit, canvas, cmd, opacity, fontCollection);
      break;
    case "image":
    case "video": {
      const img = media[cmd.ref];
      // Absent media ⇒ draw NOTHING this frame (the async media contract): a
      // genuinely FAILED asset is reported loudly by image_registry/video_registry
      // (console.error), and an UNDECODED one is the normal in-flight state that
      // repaints when it lands (onImageLoad/onVideoFrame nudge the reactive
      // canvas). The caller-side media builder (skia/browser_media.js) omits an
      // unresolved ref for exactly this reason — never a placeholder, never a
      // blocking wait — matching the SVG/PDF backends' "blank ref → draw nothing".
      if (!img) break;
      const iw = img.width(), ih = img.height();
      const s = cmd.src;
      const src = CanvasKit.LTRBRect(s.sx * iw, s.sy * ih, (s.sx + s.sw) * iw, (s.sy + s.sh) * ih);
      const dest = CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h);
      const p = new CanvasKit.Paint();
      p.setAlphaf(opacity);
      canvas.drawImageRect(img, src, dest, p, false);
      p.delete();
      break;
    }
    case "latexVector":
      drawLatexVector(CanvasKit, canvas, cmd, opacity);
      break;
    default:
      throw new Error(`paintIR(skia): unknown op "${cmd.op}"`);
  }
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
function drawPathOp(CanvasKit, canvas, cmd, opacity) {
  const skPath = CanvasKit.Path.MakeFromSVGString(cmd.d);
  if (!skPath) throw new Error(`paintIR(skia): path "d" failed to parse: ${JSON.stringify(cmd.d).slice(0, 64)}`);
  skPath.setFillType(cmd.fillRule === "evenodd" ? CanvasKit.FillType.EvenOdd : CanvasKit.FillType.Winding);
  // Gradient objectBoundingBox = the path's own tight bounds (getBounds → [l,t,r,b]).
  const gb = skPath.getBounds();
  const bounds = { x: gb[0], y: gb[1], w: gb[2] - gb[0], h: gb[3] - gb[1] };
  if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds), (p) => canvas.drawPath(skPath, p));
  if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds), (p) => canvas.drawPath(skPath, p));
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
function drawLatexVector(CanvasKit, canvas, cmd, opacity) {
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
    p.setAntiAlias(true);
    canvas.drawPath(path, p);
    p.delete(); path.delete();
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
 */
function handleBlurBackdrop(CanvasKit, target, cmd, world, view) {
  if (!target.surface) throw new Error("paintIR(skia): blurBackdrop requires an owned offscreen surface (internal invariant)");
  target.surface.flush();
  const snap = target.surface.makeImageSnapshot();
  const sigma = cmd.radius * world.scale * view.zoom * view.dpr;
  const p = new CanvasKit.Paint();
  p.setAlphaf(cmd.opacity ?? 1);
  let filt = null;
  if (sigma > 0) {
    filt = CanvasKit.ImageFilter.MakeBlur(sigma, sigma, CanvasKit.TileMode.Clamp, null);
    p.setImageFilter(filt);
  }
  target.canvas.drawImage(snap, 0, 0, p);
  p.delete();
  if (filt) filt.delete();
  snap.delete();
}

/**
 * Command (draws on target.canvas). magnifyBackdrop: a shaped lens (circle|box)
 * showing a magnified view about the ORIGIN.
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

  if (cmd.supersample && depth < MAX_SUPERSAMPLE_DEPTH) {
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
      const lensView = lensViewFor(view, centerWorld, cmd.magnification, originWorld);
      // Shift the lens view so device (x0,y0) maps to the small surface's origin.
      const shifted = { ...lensView, panX: lensView.panX - x0 / view.dpr, panY: lensView.panY - y0 / view.dpr };
      const sub = ctx.makeSurface(rw, rh);
      if (!sub) throw new Error("paintIR(skia): makeSurface for lens re-render returned null");
      sub.getCanvas().clear(CanvasKit.Color4f(0, 0, 0, 0));
      paintFlat(CanvasKit, { canvas: sub.getCanvas(), surface: sub }, belowFlat, shifted, ctx, depth + 1);
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
    // Soft: sample the composite-so-far, magnified about the origin.
    if (!target.surface) throw new Error("paintIR(skia): magnifyBackdrop sampling requires an owned offscreen surface");
    target.surface.flush();
    const snap = target.surface.makeImageSnapshot();
    const ds = view.zoom * view.dpr;
    const centerDev = { x: centerWorld.x * ds + view.panX * view.dpr, y: centerWorld.y * ds + view.panY * view.dpr };
    const originDev = { x: originWorld.x * ds + view.panX * view.dpr, y: originWorld.y * ds + view.panY * view.dpr };
    const M = cmd.magnification;
    canvas.save();
    canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
    // Device pixel q inside the lens samples the backdrop at
    // origin + (q − center)/M ⇒ draw the snapshot under q = center + (s − origin)·M.
    canvas.concat(CanvasKit.Matrix.multiply(
      CanvasKit.Matrix.translated(centerDev.x, centerDev.y),
      CanvasKit.Matrix.scaled(M, M),
      CanvasKit.Matrix.translated(-originDev.x, -originDev.y),
    ));
    const p = new CanvasKit.Paint();
    p.setAlphaf(opacity);
    canvas.drawImageOptions(snap, 0, 0, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, p);
    p.delete();
    canvas.restore();
    snap.delete();
  }
  clip.delete();
  drawLensBorder(CanvasKit, canvas, cmd, view, world, opacity);
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

/** Query→build. The lens region as a device-space Path (circle or rounded box). Caller deletes. */
function lensClipPath(CanvasKit, cmd, deviceM) {
  const b = new CanvasKit.PathBuilder();
  if (cmd.shape === "box") {
    b.addRRect(CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius));
  } else {
    b.addOval(CanvasKit.LTRBRect(cmd.cx - cmd.r, cmd.cy - cmd.r, cmd.cx + cmd.r, cmd.cy + cmd.r));
  }
  b.transform(deviceM);
  const path = b.detach();
  b.delete();
  return path;
}

/** Command (draws the lens rim/border in local space). ONE stroke ring for both
 * shapes — the collapsed stroke/strokeWidth bundle (ir.js folded the legacy rim). */
function drawLensBorder(CanvasKit, canvas, cmd, view, world, opacity) {
  const isBox = cmd.shape === "box";
  const color = cmd.stroke;
  const width = cmd.strokeWidth;
  if (!color || !(width > 0)) return;
  canvas.save();
  applyView(canvas, view, world);
  const p = strokePaint(CanvasKit, color, width, opacity);
  if (isBox) {
    const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius);
    canvas.drawRRect(rr, p);
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
const GLASS_CLIP_SLOP_PX = 2;         // AABB clip slack (device px) covering the coverage antialias band

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

  // (1)+(2) the backdrop images (sharp + blurred) + the localMatrix that maps a
  // DEVICE coordinate to the (possibly scaled) backdrop image's pixel space.
  const bd = glassBackdropImages(CanvasKit, target, belowFlat, view, ctx, depth, cmd.backdropScale, blurSigma);

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
  const reach = Math.hypot(halfWDev, halfHDev) + GLASS_CLIP_SLOP_PX;
  canvas.save();
  canvas.clipRect(CanvasKit.LTRBRect(cxDev - reach, cyDev - reach, cxDev + reach, cyDev + reach), CanvasKit.ClipOp.Intersect, false);
  canvas.drawPaint(p);
  canvas.restore();

  p.delete(); glass.delete(); blurChild.delete(); sharpChild.delete();
  bd.blurred.delete(); bd.sharp.delete();

  // (5) optional bright hairline border on top (local space, rotation-safe).
  drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity);
}

/**
 * Query→build. The glass backdrop images {sharp, blurred, sampleMatrix} at the
 * requested resolution factor. depth < cap ⇒ RE-RENDER the below-content at
 * `scale × device` resolution (true supersample/downsample — the distortion
 * samples a backdrop rendered at that resolution). depth ≥ cap ⇒ fall back to
 * sampling the surface being drawn into (device res, scale ignored; non-null at
 * depth ≥ 1, matching the magnifier's recursion guard). `sampleMatrix` maps a
 * device coordinate to the image's pixel space (scaled(1/scale) for the re-render;
 * identity for the fallback). Caller deletes sharp + blurred.
 */
function glassBackdropImages(CanvasKit, target, belowFlat, view, ctx, depth, scale, blurSigma) {
  if (depth < MAX_SUPERSAMPLE_DEPTH) {
    const sw = Math.max(1, Math.round(ctx.deviceW * scale));
    const sh = Math.max(1, Math.round(ctx.deviceH * scale));
    const sub = ctx.makeSurface(sw, sh);
    if (!sub) throw new Error("paintIR(skia): makeSurface for glass backdrop re-render returned null");
    sub.getCanvas().clear(CanvasKit.Color4f(0, 0, 0, 0));
    // dpr·scale maps the same world region onto the scale-sized surface (every
    // device point d → scale·d), so the re-render IS the device backdrop at `scale`.
    const scaledView = { ...view, dpr: view.dpr * scale };
    paintFlat(CanvasKit, { canvas: sub.getCanvas(), surface: sub }, belowFlat, scaledView, ctx, depth + 1);
    sub.flush();
    const sharp = sub.makeImageSnapshot();
    sub.dispose();
    const blurred = blurredImageOf(CanvasKit, ctx, sharp, blurSigma * scale, sw, sh);
    return { sharp, blurred, sampleMatrix: CanvasKit.Matrix.scaled(1 / scale, 1 / scale) };
  }
  // Fallback (nested beyond the re-render cap): sample the surface we draw into.
  if (!target.surface) throw new Error("paintIR(skia): glassBackdrop fallback requires an owned offscreen surface (internal invariant)");
  target.surface.flush();
  const sharp = target.surface.makeImageSnapshot();
  const blurred = blurredImageOf(CanvasKit, ctx, sharp, blurSigma, ctx.deviceW, ctx.deviceH);
  return { sharp, blurred, sampleMatrix: null }; // null ⇒ identity local space (device px)
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
  p.setAntiAlias(true);
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
 * edge catch-light). One stroked rounded rect; skipped when strokeWidth is 0. */
function drawGlassBorder(CanvasKit, canvas, cmd, view, world, opacity) {
  if (!cmd.stroke || !(cmd.strokeWidth > 0)) return;
  canvas.save();
  applyView(canvas, view, world);
  const p = strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity);
  const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.cx - cmd.halfW, cmd.cy - cmd.halfH, cmd.cx + cmd.halfW, cmd.cy + cmd.halfH), cmd.cornerRadius, cmd.cornerRadius);
  canvas.drawRRect(rr, p);
  p.delete();
  canvas.restore();
}

// ── subtree re-renders (self-contained `content`) ─────────────────────────────

/**
 * Command (draws on target.canvas). cropSubtree: fill a rounded-rect region,
 * clip to it, re-emit `content` (self-contained absolute-world IR), stroke the
 * border on top. Fill + border draw in the crop node's local space; the clip is
 * a device-space path (so `content`, which carries its own world, can render
 * from the device root through `view` while the clip persists).
 */
function handleCropSubtree(CanvasKit, target, cmd, world, view, ctx, depth) {
  const canvas = target.canvas;
  const opacity = cmd.opacity ?? 1;
  const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius, cmd.cornerRadius);
  const bounds = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };

  if (cmd.fill) {
    canvas.save();
    applyView(canvas, view, world);
    withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity, bounds), (p) => canvas.drawRRect(rr, p));
    canvas.restore();
  }

  if (depth < MAX_REENDER_DEPTH) {
    const clip = deviceRRectPath(CanvasKit, cmd, deviceMatrix(CanvasKit, view, world));
    canvas.save();
    canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
    paintFlat(CanvasKit, target, flattenIR(cmd.content), view, ctx, depth + 1);
    canvas.restore();
    clip.delete();
  } else {
    reportOnce("crop-reender-depth", `paintIR(skia): crop re-render nesting exceeded MAX_REENDER_DEPTH (${MAX_REENDER_DEPTH}) — skipping content (pathological nesting)`);
  }

  if (cmd.stroke && cmd.strokeWidth > 0) {
    canvas.save();
    applyView(canvas, view, world);
    withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity, bounds), (p) => canvas.drawRRect(rr, p));
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
 * UNDER, the WIDGET through its BLEND mode, and BLOOM (blurred bright copy) ADD
 * on top. shadowOnly ⇒ only the shadow. All composites are device-root blits of
 * the one content image; the effect node's world scales the device sigmas/offset
 * (sigma = value·world.scale·zoom·dpr), matching gpu/compositor.js.
 *
 * PARITY NOTES vs the WebGPU compositor:
 *   - SHADOW uses ImageFilter.MakeDropShadowOnly — a Skia-faithful drop shadow,
 *     soft on ALL FOUR sides by construction (fixes the old 16.1 top/left clip;
 *     the dormant analytic-erf path is unnecessary here).
 *   - BLEND multiply/screen are true separable Porter-Duff (Skia) vs the GPU's
 *     fixed-function factors; they differ where the backdrop is non-opaque.
 *   - No large-sigma source downscale (compositor's 15.3/15.5): the scratch
 *     surface is full device size, so extreme zoom is heavier but visually equal.
 */
function handleEffectSubtree(CanvasKit, target, cmd, world, view, ctx, depth) {
  const canvas = target.canvas;
  if (depth >= MAX_EFFECT_DEPTH) {
    reportOnce("effect-reender-depth", `paintIR(skia): effect re-render nesting exceeded MAX_EFFECT_DEPTH (${MAX_EFFECT_DEPTH}) — skipping effected widget (pathological nesting)`);
    return;
  }
  const ds = view.zoom * view.dpr;
  const scale = world.scale * ds; // world value → device px

  // ONE offscreen render of the widget's own content (carries its own world).
  const sub = ctx.makeSurface(ctx.deviceW, ctx.deviceH);
  if (!sub) throw new Error("paintIR(skia): makeSurface for effect content returned null");
  sub.getCanvas().clear(CanvasKit.Color4f(0, 0, 0, 0));
  paintFlat(CanvasKit, { canvas: sub.getCanvas(), surface: sub }, flattenIR(cmd.content), view, ctx, depth + 1);
  sub.flush();
  const contentImg = sub.makeImageSnapshot();

  // SHADOW (under): blurred, offset, tinted alpha silhouette of the content.
  if (cmd.shadow) {
    const c = cmd.shadow.color;
    const tint = CanvasKit.Color4f(c[0], c[1], c[2], c[3] * cmd.shadow.opacity);
    const sig = cmd.shadow.blur * scale;
    const filt = CanvasKit.ImageFilter.MakeDropShadowOnly(cmd.shadow.dx * scale, cmd.shadow.dy * scale, sig, sig, tint, null);
    const p = new CanvasKit.Paint();
    p.setImageFilter(filt);
    canvas.drawImage(contentImg, 0, 0, p);
    p.delete(); filt.delete();
  }

  if (!cmd.shadowOnly) {
    // WIDGET: the content itself, composited against the backdrop via blend mode.
    const p = new CanvasKit.Paint();
    p.setBlendMode(blendModeFor(CanvasKit, cmd.blend));
    canvas.drawImage(contentImg, 0, 0, p);
    p.delete();

    // BLOOM (on top): the content's own Gaussian-blurred copy × strength, ADD.
    if (cmd.bloom) {
      const filt = bloomFilter(CanvasKit, cmd.bloom.radius * scale, cmd.bloom.strength);
      const p2 = new CanvasKit.Paint();
      p2.setImageFilter(filt);
      p2.setBlendMode(CanvasKit.BlendMode.Plus);
      canvas.drawImage(contentImg, 0, 0, p2);
      p2.delete(); filt.delete();
    }
  }

  contentImg.delete();
  sub.dispose();
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

/** Pure-ish helper. IR blend name → CanvasKit BlendMode (add ⇒ Plus). */
function blendModeFor(CanvasKit, blend) {
  switch (blend) {
    case "multiply": return CanvasKit.BlendMode.Multiply;
    case "add": return CanvasKit.BlendMode.Plus;
    case "screen": return CanvasKit.BlendMode.Screen;
    default: return CanvasKit.BlendMode.SrcOver;
  }
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
 * on the paint as `_gradientShader` so withPaint disposes it. Caller deletes. */
function fillPaint(CanvasKit, paint, opacity, bounds = null) {
  const p = new CanvasKit.Paint();
  p.setStyle(CanvasKit.PaintStyle.Fill);
  p.setAntiAlias(true);
  applyPaint(CanvasKit, p, paint, opacity, bounds);
  return p;
}

/** Helper. A stroked Paint for a solid rgba OR a gradient Paint. `bounds` frames
 * a gradient stroke's objectBoundingBox (see fillPaint). Caller deletes. */
function strokePaint(CanvasKit, paint, width, opacity, bounds = null) {
  const p = new CanvasKit.Paint();
  p.setStyle(CanvasKit.PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setAntiAlias(true);
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
function drawTextOp(CanvasKit, canvas, cmd, opacity, fontCollection) {
  const layout = getTextLayout(CanvasKit, fontCollection, cmd, opacity);
  layout.draw(canvas, cmd.x, cmd.y);
}
