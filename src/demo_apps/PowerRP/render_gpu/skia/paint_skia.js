/**
 * The Skia (CanvasKit) render backend — paints the device-independent IR
 * display list (render_gpu/ir.js) onto a CanvasKit canvas.
 *
 * THE NEW SEAM BACKEND (2026-07-22 render rewrite): replaces the hand-rolled
 * WebGPU compositor as the runtime rasterizer. The SAME function runs against a
 * WebGL2-backed surface in the browser AND a CPU raster surface in Node (the CLI
 * / tests), so browser and headless output share one code path. It consumes the
 * exact IR the WebGPU/SVG/PDF backends consume — no plugin changes required for
 * this first slice ("recreate what's there now").
 *
 * DOM-free: it never touches document/window. CanvasKit and the typeface set are
 * INJECTED (the caller inits CanvasKit and resolves font files to Typefaces —
 * the same "callers resolve file→bytes through their own seam" contract fonts.js
 * documents). Browser path resolves fonts via fetch(?url); Node via readFileSync.
 *
 * Phase 1a scope: transforms + rect/ellipse/polyline/polygon/text(single run)/
 * image/video. Backdrop/effect ops (blurBackdrop, magnifyBackdrop, cropSubtree,
 * effectSubtree) + rich-text layout + latexVector land in Phase 1b — they throw a
 * loud "not implemented" here rather than silently drawing nothing.
 */

import { flattenIR, parseColor } from "../ir.js";
import { DEFAULT_FONT } from "../fonts.js";

const RAD2DEG = 180 / Math.PI;

/** Ops this backend does not yet implement (Phase 1b — backdrop/effect/latex). */
const PHASE_1B_OPS = new Set(["blurBackdrop", "magnifyBackdrop", "cropSubtree", "effectSubtree", "latexVector"]);

/**
 * Command (draws on `canvas`). Paints the IR `commands` through `view`
 * ({zoom, panX, panY, dpr}) onto a CanvasKit canvas, mirroring the Canvas2D
 * bench interpreter's transform math exactly (device pixels).
 *
 * Args:
 *   CanvasKit: the initialized CanvasKit module (injected)
 *   canvas: a CanvasKit Canvas (from surface.getCanvas())
 *   commands (object[]): raw IR command list (ir.js builders' output)
 *   view ({zoom, panX, panY, dpr}): the camera mapping
 *   opts.media (object): ref → CanvasKit Image (caller decodes)
 *   opts.background (string): CSS color cleared behind the scene
 *   opts.typefaces (Map): `${fontId}:${bold?"b":"r"}` → CanvasKit Typeface
 */
export function paintIR(CanvasKit, canvas, commands, view, { media = {}, background = "#ffffff", typefaces } = {}) {
  if (!typefaces) throw new Error("paintIR(skia): a typefaces map is required (fontId:bold → Typeface)");
  const deviceScale = view.zoom * view.dpr;
  const bg = parseColor(background);
  canvas.clear(CanvasKit.Color4f(bg[0], bg[1], bg[2], bg[3]));

  for (const { cmd, world } of flattenIR(commands)) {
    if (PHASE_1B_OPS.has(cmd.op)) throw new Error(`paintIR(skia): op "${cmd.op}" not implemented yet (Phase 1b)`);
    const opacity = cmd.opacity ?? 1;
    canvas.save();
    canvas.translate(view.panX * view.dpr, view.panY * view.dpr);
    canvas.scale(deviceScale, deviceScale);
    canvas.translate(world.x, world.y);
    canvas.rotate(world.rotation * RAD2DEG, 0, 0);
    canvas.scale(world.scale, world.scale);
    drawOp(CanvasKit, canvas, cmd, opacity, media, typefaces);
    canvas.restore();
  }
}

/** Command (draws one op on `canvas` in its already-transformed local space). */
function drawOp(CanvasKit, canvas, cmd, opacity, media, typefaces) {
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
      // fallback (never a silent blank); rich layout is Phase 1b.
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
      if (!img) throw new Error(`paintIR(skia): no media Image for ref "${cmd.ref}"`);
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
    default:
      throw new Error(`paintIR(skia): unknown op "${cmd.op}"`);
  }
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
