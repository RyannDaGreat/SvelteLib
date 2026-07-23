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

import { flattenIR, parseColor } from "../ir.js";
import { DEFAULT_FONT } from "../fonts.js";
import * as T from "../../core/transform.js";

const RAD2DEG = 180 / Math.PI;

// Recursion caps mirror the WebGPU compositor's guards (gpu/compositor.js):
// a lens NESTED inside a lens replay falls back to backdrop sampling
// (MAX_SUPERSAMPLE_DEPTH), and crop/effect content re-renders are bounded
// (they are unreachable for plugin-emitted documents — the deepest legit chain
// is ~3 — but a pathological hand-built nesting is skipped loudly, not crashed).
const MAX_SUPERSAMPLE_DEPTH = 1; // compositor.js:89
const MAX_REENDER_DEPTH = 4;     // compositor.js:128 (crop)
const MAX_EFFECT_DEPTH = 2;      // compositor.js:112

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
 *   opts.typefaces (Map): `${fontId}:${bold?"b":"r"}` → CanvasKit Typeface
 *   opts.scissor ({x,y,w,h}|null): a device-px clip rect — the presenter's
 *     letterbox. The whole surface is cleared to `background` (the bars); the
 *     SCENE is clipped to this rect so off-camera content cannot bleed into the
 *     bars. Absent ⇒ the scene draws across the full surface.
 */
export function paintIR(CanvasKit, canvas, commands, view, { media = {}, background = "#ffffff", typefaces, scissor = null } = {}) {
  if (!typefaces) throw new Error("paintIR(skia): a typefaces map is required (fontId:bold → Typeface)");
  const flat = flattenIR(commands);
  const bg = parseColor(background);
  const bgColor = CanvasKit.Color4f(bg[0], bg[1], bg[2], bg[3]);
  const bounds = canvas.getDeviceClipBounds(); // [l, t, r, b] in device px; fresh canvas ⇒ full surface
  const ctx = { media, typefaces, deviceW: bounds[2] - bounds[0], deviceH: bounds[3] - bounds[1] };
  // The letterbox clip (device px), built once — applied AFTER the full-surface
  // clear so the bars keep `background` and only the scene is clipped.
  const scissorRect = scissor ? CanvasKit.LTRBRect(scissor.x, scissor.y, scissor.x + scissor.w, scissor.y + scissor.h) : null;

  const needsBackdrop = flat.some(({ cmd }) => cmd.op === "blurBackdrop" || cmd.op === "magnifyBackdrop");
  if (!needsBackdrop) {
    // Fast path: no backdrop sampler ⇒ draw straight onto the caller's canvas.
    canvas.clear(bgColor);
    if (scissorRect) { canvas.save(); canvas.clipRect(scissorRect, CanvasKit.ClipOp.Intersect, true); }
    paintFlat(CanvasKit, { canvas, surface: null }, flat, view, ctx, 0);
    if (scissorRect) canvas.restore();
    return;
  }

  // Backdrop path: own an offscreen surface so samplers can read composite-so-far.
  const scene = CanvasKit.MakeSurface(ctx.deviceW, ctx.deviceH);
  if (!scene) throw new Error("paintIR(skia): MakeSurface for backdrop compositing returned null");
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
        drawLeafOp(CanvasKit, canvas, cmd, opacity, ctx.media, ctx.typefaces);
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
function drawLeafOp(CanvasKit, canvas, cmd, opacity, media, typefaces) {
  switch (cmd.op) {
    case "rect": {
      const rr = CanvasKit.RRectXY(CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h), cmd.cornerRadius, cmd.cornerRadius);
      if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity), (p) => canvas.drawRRect(rr, p));
      if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity), (p) => canvas.drawRRect(rr, p));
      break;
    }
    case "ellipse": {
      const oval = CanvasKit.LTRBRect(cmd.cx - cmd.rx, cmd.cy - cmd.ry, cmd.cx + cmd.rx, cmd.cy + cmd.ry);
      if (cmd.fill) withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity), (p) => canvas.drawOval(oval, p));
      if (cmd.stroke && cmd.strokeWidth > 0) withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity), (p) => canvas.drawOval(oval, p));
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
      withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity), (p) => canvas.drawPath(path, p));
      path.delete();
      break;
    }
    case "text": {
      // Phase 1a: single run only. A rich op degrades to its plain-text
      // fallback (never a silent blank); rich layout is a separate Phase 1b slice.
      const tf = typefaceFor(typefaces, cmd.font, cmd.bold);
      const font = new CanvasKit.Font(tf, cmd.size);
      const m = font.getMetrics();
      const baseline = cmd.y - m.ascent; // ascent is negative → top-left origin (canvas textBaseline "top")
      withPaint(CanvasKit, fillPaint(CanvasKit, cmd.color, opacity), (p) => canvas.drawText(cmd.text, cmd.x, baseline, p, font));
      font.delete();
      break;
    }
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
 * Command (draws glyph vector paths). Each glyph's `d` (SVG path in `viewBox`
 * space) is drawn filled through a viewBox→box mapping (a straight box→box
 * scale, y-down already). The raster `ref` is ignored — this is the crisp
 * vector path the SVG/PDF backends also consume. Fill uses each glyph's own
 * color; nonzero winding (MathJax counters are reverse-wound), which is
 * SkPath's default from MakeFromSVGString.
 */
function drawLatexVector(CanvasKit, canvas, cmd, opacity) {
  const { viewBox, glyphs } = cmd;
  const sx = cmd.w / viewBox.w, sy = cmd.h / viewBox.h;
  canvas.save();
  canvas.translate(cmd.x, cmd.y);
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
    // Crisp: re-render the below-list under the lens view into a scratch surface.
    const lensView = lensViewFor(view, centerWorld, cmd.magnification, originWorld);
    const sub = CanvasKit.MakeSurface(ctx.deviceW, ctx.deviceH);
    if (!sub) throw new Error("paintIR(skia): MakeSurface for lens re-render returned null");
    sub.getCanvas().clear(CanvasKit.Color4f(0, 0, 0, 0));
    paintFlat(CanvasKit, { canvas: sub.getCanvas(), surface: sub }, belowFlat, lensView, ctx, depth + 1);
    sub.flush();
    const lensImg = sub.makeImageSnapshot();
    canvas.save();
    canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
    blitImage(CanvasKit, canvas, lensImg, opacity);
    canvas.restore();
    lensImg.delete();
    sub.dispose();
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

/** Command (draws the lens rim/border in local space). Circle ⇒ rimColor/rimWidth; box ⇒ stroke/strokeWidth. */
function drawLensBorder(CanvasKit, canvas, cmd, view, world, opacity) {
  const isBox = cmd.shape === "box";
  const color = isBox ? cmd.stroke : cmd.rimColor;
  const width = isBox ? cmd.strokeWidth : cmd.rimWidth;
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

  if (cmd.fill) {
    canvas.save();
    applyView(canvas, view, world);
    withPaint(CanvasKit, fillPaint(CanvasKit, cmd.fill, opacity), (p) => canvas.drawRRect(rr, p));
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
    withPaint(CanvasKit, strokePaint(CanvasKit, cmd.stroke, cmd.strokeWidth, opacity), (p) => canvas.drawRRect(rr, p));
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
  const sub = CanvasKit.MakeSurface(ctx.deviceW, ctx.deviceH);
  if (!sub) throw new Error("paintIR(skia): MakeSurface for effect content returned null");
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

/** Pure-ish helper. A filled Paint (opacity folded into alpha). Caller deletes. */
function fillPaint(CanvasKit, rgba, opacity) {
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * opacity));
  p.setStyle(CanvasKit.PaintStyle.Fill);
  p.setAntiAlias(true);
  return p;
}

/** Helper. A stroked Paint (opacity folded into alpha). Caller deletes. */
function strokePaint(CanvasKit, rgba, width, opacity) {
  const p = new CanvasKit.Paint();
  p.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * opacity));
  p.setStyle(CanvasKit.PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setAntiAlias(true);
  return p;
}

/** Helper. Runs `draw` with `paint`, then deletes the paint (WASM cleanup). */
function withPaint(CanvasKit, paint, draw) {
  draw(paint);
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

/**
 * Query (reads the injected typeface set). The Typeface for (fontId, bold),
 * degrading an unknown/file-less font (e.g. "system") to DEFAULT_FONT's stand-in
 * — a missing font must never throw in the paint path (fonts.js contract).
 */
function typefaceFor(typefaces, fontId, bold) {
  return (
    typefaces.get(`${fontId}:${bold ? "b" : "r"}`) ||
    typefaces.get(`${fontId}:r`) ||
    typefaces.get(`${DEFAULT_FONT}:${bold ? "b" : "r"}`) ||
    typefaces.get(`${DEFAULT_FONT}:r`)
  );
}
