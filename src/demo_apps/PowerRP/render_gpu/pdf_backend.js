/**
 * VECTOR backend: IR → PDF bytes, directly from the display list (never via
 * SVG — manifest "PDF export, round 11"). THE HYBRID RULE (user): everything
 * that CAN be vector IS vector; only content that must be pixelated (backdrop
 * blur) renders at pixel resolution and is composited as an embedded raster
 * region under the subsequent vector elements. TEXT IS TEXT: real Tf/Tj
 * operators (selectable), standard-14 Helvetica today — the committed-fonts
 * task supplies TTFs for true embedding later (the embedFont seam is ready).
 *
 * Coordinates: PDF pages are y-UP; the content stream opens with a flip cm
 * (1 0 0 -1 0 H) so everything after it works in the y-DOWN world/page space
 * every other backend uses, then the camera view cm (fitRectView semantics —
 * the camera region IS the page). Each drawable wraps its similarity world
 * transform as a cm; text runs locally re-flip (Tm with a -1 d entry) so
 * glyphs stay upright.
 *
 * Effects:
 *   blurBackdrop — cannot be vector. The LAST blur in a region splits it:
 *     everything at or below renders through the injected `rasterize`
 *     callback (the GPU pipeline, blur applied) and embeds as ONE image
 *     XObject covering the region; everything above stays vector.
 *   magnifyBackdrop — VECTOR lens: a clipped, magnified re-emit of the
 *     commands below the lens (q, circle clip, magnify-about-center cm,
 *     recursive walk, Q — the display list is re-interpretable, the same
 *     trick as the GPU supersample). Recursion capped at MAX_LENS_DEPTH
 *     (the GPU compositor's MAX_SUPERSAMPLE_DEPTH bound); a lens beyond the
 *     cap embeds as a raster region (user: pixelated lens acceptable).
 *
 * Structure: content-stream generation is pure string work (bare-node
 * testable, doctested); pdf-lib assembles the document (fonts, images,
 * ExtGStates, xref). The `rasterize` callback keeps this module DOM-free:
 * browsers pass the GPU pixel service, node tests pass a stub.
 */

import { flattenIR, parseColor, popTransform } from "./ir.js";
import * as T from "../core/transform.js";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

/**
 * Lens re-emit recursion cap — mirrors the GPU compositor's
 * MAX_SUPERSAMPLE_DEPTH (gpu/compositor.js): one level of true lens
 * re-interpretation; deeper lenses fall back (here: to a raster embed).
 */
export const MAX_LENS_DEPTH = 1;

/**
 * Cubic-bezier circle constant k = 4(√2−1)/3 ≈ 0.5523: the standard 4-arc
 * approximation of a circle/ellipse quadrant (the constant every vector
 * library uses; max radial error ~0.02%).
 */
export const BEZIER_K = 0.5522847498307936;

/** Pure function. Compact PDF number (4 decimals, trimmed).
 * @example pdfNum(1.230000001) // "1.23"
 * @example pdfNum(-0.5) // "-0.5"
 */
export function pdfNum(n) {
  return String(+n.toFixed(4));
}

/**
 * Pure function. A similarity transform as a PDF cm operator
 * [a b -b a x y] with a = s·cosθ, b = s·sinθ (the packXform convention).
 *
 * @example cmSimilarity({x: 10, y: 20, rotation: 0, scale: 2}) // "2 0 0 2 10 20 cm"
 * @example cmSimilarity({x: 0, y: 0, rotation: Math.PI / 2, scale: 1}) // "0 1 -1 0 0 0 cm"
 */
export function cmSimilarity(world) {
  const a = world.scale * Math.cos(world.rotation);
  const b = world.scale * Math.sin(world.rotation);
  return `${pdfNum(a)} ${pdfNum(b)} ${pdfNum(-b)} ${pdfNum(a)} ${pdfNum(world.x)} ${pdfNum(world.y)} cm`;
}

/**
 * Pure function. Path operators for a (possibly rounded) rect. Radius clamps
 * to the half-extents like the GPU shader's sdRoundBox clamp.
 *
 * @example rectPath({x: 0, y: 0, w: 10, h: 5, cornerRadius: 0}) // "0 0 10 5 re"
 * @example rectPath({x: 0, y: 0, w: 10, h: 5, cornerRadius: 2}).split(" c").length - 1 // 4 (four corner arcs)
 */
export function rectPath({ x, y, w, h, cornerRadius = 0 }) {
  const r = Math.min(cornerRadius, w / 2, h / 2);
  if (r <= 0) return `${pdfNum(x)} ${pdfNum(y)} ${pdfNum(w)} ${pdfNum(h)} re`;
  const k = BEZIER_K * r;
  const n = pdfNum;
  return [
    `${n(x + r)} ${n(y)} m`,
    `${n(x + w - r)} ${n(y)} l`,
    `${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c`,
    `${n(x + w)} ${n(y + h - r)} l`,
    `${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`,
    `${n(x + r)} ${n(y + h)} l`,
    `${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c`,
    `${n(x)} ${n(y + r)} l`,
    `${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c`,
    "h",
  ].join("\n");
}

/**
 * Pure function. Path operators for an ellipse (four bezier quadrants).
 *
 * @example ellipsePath({cx: 0, cy: 0, rx: 10, ry: 5}).endsWith("h") // true
 * @example ellipsePath({cx: 0, cy: 0, rx: 10, ry: 5}).split(" c").length - 1 // 4
 */
export function ellipsePath({ cx, cy, rx, ry }) {
  const kx = BEZIER_K * rx, ky = BEZIER_K * ry;
  const n = pdfNum;
  return [
    `${n(cx + rx)} ${n(cy)} m`,
    `${n(cx + rx)} ${n(cy + ky)} ${n(cx + kx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
    `${n(cx - kx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ky)} ${n(cx - rx)} ${n(cy)} c`,
    `${n(cx - rx)} ${n(cy - ky)} ${n(cx - kx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
    `${n(cx + kx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ky)} ${n(cx + rx)} ${n(cy)} c`,
    "h",
  ].join("\n");
}

/**
 * Pure function. m/l operators for a point list (open path).
 *
 * @example pointsPath([[0, 0], [10, 0], [10, 5]]) // "0 0 m\n10 0 l\n10 5 l"
 */
export function pointsPath(points) {
  return points.map(([x, y], i) => `${pdfNum(x)} ${pdfNum(y)} ${i === 0 ? "m" : "l"}`).join("\n");
}

/**
 * Pure function. The paint operator for a fill/stroke combination.
 *
 * @example paintOp([0, 0, 0, 1], null, 0) // "f"
 * @example paintOp([0, 0, 0, 1], [0, 0, 0, 1], 2) // "B"
 * @example paintOp(null, [0, 0, 0, 1], 2) // "S"
 */
export function paintOp(fill, stroke, strokeWidth) {
  const hasStroke = stroke && strokeWidth > 0;
  return fill ? (hasStroke ? "B" : "f") : "S";
}

/**
 * Pure function. Raw IR slice [0, end) with unclosed pushTransforms balanced
 * by appended popTransforms — flattenIR (and the GPU renderer) throw on
 * unbalanced stacks, and a mid-list slice can cut inside a push/pop pair.
 *
 * @example balancedSlice([{op: "pushTransform"}, {op: "rect"}, {op: "popTransform"}], 2).length // 3 (pop appended)
 * @example balancedSlice([{op: "rect"}], 1).length // 1
 */
export function balancedSlice(commands, end) {
  const slice = commands.slice(0, end);
  let open = 0;
  for (const c of slice) {
    if (c.op === "pushTransform") open++;
    else if (c.op === "popTransform") open--;
  }
  return open > 0 ? [...slice, ...Array.from({ length: open }, () => popTransform())] : slice;
}

/**
 * Pure function. The view that magnifies `view` by M about world point C
 * (page-space fixed point): page' = Cp + M·(page − Cp). The same lens-view
 * algebra as the GPU's lensRenderView, in dpr-free page space.
 *
 * @example magnifiedView({zoom: 1, panX: 0, panY: 0}, {x: 100, y: 50}, 2) // {zoom: 2, panX: -100, panY: -50}
 */
export function magnifiedView(view, centerWorld, m) {
  const cpx = centerWorld.x * view.zoom + view.panX;
  const cpy = centerWorld.y * view.zoom + view.panY;
  return {
    zoom: view.zoom * m,
    panX: m * view.panX + cpx * (1 - m),
    panY: m * view.panY + cpy * (1 - m),
  };
}

/**
 * Near-pure function (console.error on unencodable text — reported, then
 * degraded to "?"). Encodes a string for Tj with a pdf-lib font.
 *
 * @example // tjHex(helvetica, "Hi") → "<4869>"
 */
export function tjHex(font, text) {
  try {
    return font.encodeText(text).toString();
  } catch (e) {
    const kept = [...text].map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return "?";
      }
    }).join("");
    console.error(`pdf_backend: text "${text}" has characters outside the font encoding — substituted "?" (${e.message})`);
    return font.encodeText(kept).toString();
  }
}

/** Pure function. Does the IR contain a text op? (Fonts embed lazily.)
 * @example hasTextOp([{op: "rect"}]) // false
 * @example hasTextOp([{op: "text"}]) // true
 */
export function hasTextOp(commands) {
  return commands.some((c) => c.op === "text");
}

/**
 * Command (async; builds a PDF). IR command list → PDF file bytes.
 *
 * Args:
 *   commands (object[]): raw IR (transforms nested), z-ordered
 *   opts.width/opts.height (number): page size in PDF points (camera rect
 *     dims — the camera region IS the page)
 *   opts.view (object): {zoom, panX, panY} world → page-pt mapping
 *     (fitRectView(cameraRect, width, height, 1))
 *   opts.background (string|number[]|null): page fill; also the clear color
 *     handed to `rasterize` so raster regions composite seamlessly
 *   opts.rasterize (async fn|null): (rawCmds, {zoom, panX, panY, dpr: 1},
 *     wPx, hPx, background) → PNG bytes. The GPU pixel service in browsers,
 *     a stub in node tests. null → scenes needing raster regions THROW.
 *   opts.rasterScale (number): raster-region px per page pt. Default 2 — the
 *     retina-dpr supersample cap precedent (manifest: browser-settings dpr).
 *   opts.textAscent (number|null): baseline offset as a FRACTION of font
 *     size (IR text is top-anchored; baseline = top + fraction·size).
 *     Browser callers pass the measured canvas fontBoundingBoxAscent/size of
 *     the glyph atlas's font stack so PDF baselines land exactly where the
 *     GPU puts them; null → the PDF font's own AFM Ascender (correct for
 *     the PDF font, but a different face than the atlas's system-ui).
 *
 * Returns:
 *   Promise<Uint8Array>: the PDF file bytes
 *
 * @example // await irToPDF(sceneIR(nodes), {width: 1280, height: 720, view: fitRectView(camRect, 1280, 720, 1), background: "#ffffff", rasterize}) → Uint8Array starting "%PDF-"
 * @example // no-effect scenes need no rasterize: await irToPDF([rect({...})], {width: 100, height: 100, view: {zoom: 1, panX: 0, panY: 0}})
 */
export async function irToPDF(commands, { width, height, view, background = null, rasterize = null, rasterScale = 2, textAscent = null }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const ctx = new PdfAssembly(doc, page, rasterize, rasterScale, textAscent);
  if (hasTextOp(commands)) await ctx.ensureFonts(); // sub-lists are slices, so scanning the top list covers lens re-emits

  const out = [];
  out.push("q");
  out.push(`1 0 0 -1 0 ${pdfNum(height)} cm`); // y-down page space (world convention)
  if (background !== null) {
    const [r, g, b, a] = Array.isArray(background) ? background : parseColor(background);
    const gs = ctx.gsAlphaPair(a, 1);
    out.push("q", ...(gs ? [gs] : []), `${pdfNum(r)} ${pdfNum(g)} ${pdfNum(b)} rg`, `0 0 ${pdfNum(width)} ${pdfNum(height)} re f`, "Q");
  }
  out.push(`${pdfNum(view.zoom)} 0 0 ${pdfNum(view.zoom)} ${pdfNum(view.panX)} ${pdfNum(view.panY)} cm`);

  // The page's visible world rect = the raster-base coverage for a page-level blur.
  const pageWorldRect = {
    x: -view.panX / view.zoom,
    y: -view.panY / view.zoom,
    w: width / view.zoom,
    h: height / view.zoom,
  };
  await emitRegion(commands, { view, worldRect: pageWorldRect, depth: 0, background }, out, ctx);
  out.push("Q");

  ctx.setContent(out.join("\n"));
  return doc.save({ useObjectStreams: false });
}

/**
 * Command (async; appends operators, registers resources via ctx). The
 * hybrid-rule walker for ONE region (the page, or a lens's source square):
 * splits at the region's LAST blurBackdrop (everything at/below it becomes
 * one raster embed covering the region), emits everything above as vector,
 * and re-enters itself per magnifier lens.
 *
 * region: {view: world→page-pt mapping incl. lens magnifications,
 *          worldRect: the region's visible world AABB,
 *          depth: lens recursion depth, background}
 */
async function emitRegion(commands, region, out, ctx) {
  const flat = flattenIR(commands);
  // Map each flattened drawable back to its RAW index — effect ops slice the
  // raw list (rasterize and lens re-emits consume raw commands).
  const rawIndexOf = [];
  {
    let f = 0;
    commands.forEach((c, i) => {
      if (c.op !== "pushTransform" && c.op !== "popTransform") rawIndexOf[f++] = i;
    });
  }

  let lastBlurFlat = -1;
  flat.forEach((fc, i) => { if (fc.cmd.op === "blurBackdrop") lastBlurFlat = i; });

  if (lastBlurFlat >= 0) {
    // HYBRID RULE: the blurred composite below (and including) the last blur
    // is raster by necessity; embed it as one image covering the region.
    const below = balancedSlice(commands, rawIndexOf[lastBlurFlat] + 1);
    await ctx.emitRasterRegion(below, {
      placeRect: region.worldRect,
      srcView: region.view,
      background: region.background,
    }, out);
  }

  for (let i = lastBlurFlat + 1; i < flat.length; i++) {
    const { cmd, world } = flat[i];
    if (cmd.op === "magnifyBackdrop") {
      await emitLens(cmd, world, commands, rawIndexOf[i], region, out, ctx);
    } else {
      emitVector(cmd, world, out, ctx);
    }
  }
}

/**
 * Command (async; appends operators). One magnifier lens: circle clip +
 * magnify-about-center cm + recursive re-emit of the commands below the lens
 * (depth-capped → raster embed), then the vector rim ring. All geometry is
 * in WORLD coordinates — the current CTM maps them to the page.
 */
async function emitLens(cmd, world, commands, rawIdx, region, out, ctx) {
  const center = T.apply(world, cmd.cx, cmd.cy);
  const rWorld = cmd.r * world.scale;
  const m = Math.max(cmd.magnification, 0.01);
  const below = balancedSlice(commands, rawIdx);
  // The lens shows the source square about its center, side 2r/M
  // (plugins/magnifier.js lensSourceRect) — the sub-region's world rect.
  const half = rWorld / m;
  const sub = {
    view: magnifiedView(region.view, center, m),
    worldRect: { x: center.x - half, y: center.y - half, w: half * 2, h: half * 2 },
    depth: region.depth + 1,
    background: region.background,
  };

  out.push("q");
  out.push(ellipsePath({ cx: center.x, cy: center.y, rx: rWorld, ry: rWorld }), "W n"); // clip, no paint
  if (region.depth < MAX_LENS_DEPTH) {
    // VECTOR lens: magnify about the center, re-emit the display list below.
    out.push(`${pdfNum(m)} 0 0 ${pdfNum(m)} ${pdfNum(center.x * (1 - m))} ${pdfNum(center.y * (1 - m))} cm`);
    await emitRegion(below, sub, out, ctx);
  } else {
    // Depth cap (MAX_LENS_DEPTH = the GPU recursion bound): a lens inside a
    // lens embeds as raster — the user-ratified pixelated fallback. Sample
    // the SOURCE square, place it over the lens bbox (that IS magnification).
    await ctx.emitRasterRegion(below, {
      placeRect: { x: center.x - rWorld, y: center.y - rWorld, w: rWorld * 2, h: rWorld * 2 },
      srcRect: sub.worldRect,
      srcView: region.view,
      background: region.background,
    }, out);
  }
  out.push("Q");

  const rimW = cmd.rimColor ? cmd.rimWidth * world.scale : 0;
  if (rimW > 0) { // rimWidth 0 = NO rim (manifest spec)
    const gs = ctx.gsAlphaPair(1, cmd.rimColor[3] * cmd.opacity);
    out.push("q", ...(gs ? [gs] : []));
    out.push(`${pdfNum(cmd.rimColor[0])} ${pdfNum(cmd.rimColor[1])} ${pdfNum(cmd.rimColor[2])} RG`);
    out.push(`${pdfNum(rimW)} w`);
    out.push(ellipsePath({ cx: center.x, cy: center.y, rx: rWorld, ry: rWorld }), "S", "Q");
  }
}

/** Command (appends operators, registers resources via ctx). One vector drawable. */
function emitVector(cmd, world, out, ctx) {
  const ops = [];
  switch (cmd.op) {
    case "rect":
    case "ellipse": {
      if (!cmd.fill && !(cmd.stroke && cmd.strokeWidth > 0)) return;
      ops.push(...paintSetup(cmd.fill, cmd.stroke, cmd.strokeWidth, cmd.opacity, ctx));
      ops.push(cmd.op === "rect" ? rectPath(cmd) : ellipsePath(cmd));
      ops.push(paintOp(cmd.fill, cmd.stroke, cmd.strokeWidth));
      break;
    }
    case "polyline": {
      ops.push(...paintSetup(null, cmd.color, cmd.width, cmd.opacity, ctx));
      ops.push("1 J 1 j"); // round caps + joins (the IR polyline contract)
      ops.push(pointsPath(cmd.points), "S");
      break;
    }
    case "polygon": {
      ops.push(...paintSetup(cmd.fill, null, 0, cmd.opacity, ctx));
      ops.push(pointsPath(cmd.points), "h f");
      break;
    }
    case "text": {
      const font = ctx.font(cmd.bold);
      const [r, g, b, a] = cmd.color;
      const gs = ctx.gsAlphaPair(a * cmd.opacity, 1);
      if (gs) ops.push(gs);
      ops.push(`${pdfNum(r)} ${pdfNum(g)} ${pdfNum(b)} rg`);
      // Baseline from the font's own metrics (canvas textBaseline="top"
      // semantics: baseline = top + ascent). Tm re-flips locally (-1 d
      // entry) so glyphs stay upright inside the page's y-down space.
      const baseline = cmd.y + ctx.ascentFraction(cmd.bold) * cmd.size;
      ops.push("BT", `${ctx.fontName(cmd.bold)} ${pdfNum(cmd.size)} Tf`);
      ops.push(`1 0 0 -1 ${pdfNum(cmd.x)} ${pdfNum(baseline)} Tm`);
      ops.push(`${tjHex(font, cmd.text)} Tj`, "ET");
      break;
    }
    case "image":
    case "video":
      // No media plugins exist yet (IR ops proven, plugins unbuilt). Loud:
      throw new Error(`pdf_backend: "${cmd.op}" op not supported yet (media raster-embed lands with the media plugins)`);
    default:
      throw new Error(`pdf_backend: unknown op "${cmd.op}"`);
  }
  out.push("q", cmSimilarity(world), ...ops, "Q");
}

/** Command (may register an ExtGState via ctx). Color + alpha + width setup ops. */
function paintSetup(fill, stroke, strokeWidth, opacity, ctx) {
  const ops = [];
  const fillA = fill ? fill[3] * (opacity ?? 1) : 1;
  const strokeA = stroke && strokeWidth > 0 ? stroke[3] * (opacity ?? 1) : 1;
  const gs = ctx.gsAlphaPair(fillA, strokeA);
  if (gs) ops.push(gs);
  if (fill) ops.push(`${pdfNum(fill[0])} ${pdfNum(fill[1])} ${pdfNum(fill[2])} rg`);
  if (stroke && strokeWidth > 0) {
    ops.push(`${pdfNum(stroke[0])} ${pdfNum(stroke[1])} ${pdfNum(stroke[2])} RG`);
    ops.push(`${pdfNum(strokeWidth)} w`);
  }
  return ops;
}

/**
 * The pdf-lib assembly context: owns resource registration (fonts, alpha
 * ExtGStates, image XObjects) and the final content stream. Command object
 * (mutates the pdf-lib document).
 */
class PdfAssembly {
  constructor(doc, page, rasterize, rasterScale, textAscent = null) {
    this.doc = doc;
    this.page = page;
    this.rasterize = rasterize;
    this.rasterScale = rasterScale;
    this.textAscent = textAscent;
    this._fonts = {};     // F1 (regular) / F1B (bold) → PDFFont
    this._gs = new Map(); // "ca,CA" → ExtGState name
    this._imgCount = 0;
  }

  /**
   * Command (async). Embeds Helvetica + Helvetica-Bold (standard-14; the
   * committed-fonts task swaps this for embedFont(ttfBytes, {subset}) when
   * font files land in the repo). Must run before emitting text — emit is
   * synchronous per command, so irToPDF pre-embeds when the IR has text.
   */
  async ensureFonts() {
    if (this._fonts.F1) return;
    this._fonts.F1 = await this.doc.embedFont(StandardFonts.Helvetica);
    this._fonts.F1B = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.page.node.setFontDictionary(PDFName.of("F1"), this._fonts.F1.ref);
    this.page.node.setFontDictionary(PDFName.of("F1B"), this._fonts.F1B.ref);
  }

  font(bold) {
    const f = bold ? this._fonts.F1B : this._fonts.F1;
    if (!f) throw new Error("pdf_backend: fonts not embedded (text op outside the scanned command list?)");
    return f;
  }

  fontName(bold) {
    return bold ? "/F1B" : "/F1";
  }

  /** Query. Baseline offset as a fraction of font size: the caller-measured
   * canvas ascent when provided (GPU-atlas parity — see irToPDF textAscent),
   * else the font's own AFM metrics (Helvetica Ascender = 718 per mille). */
  ascentFraction(bold) {
    if (this.textAscent !== null) return this.textAscent;
    const ascender = this.font(bold).embedder.font.Ascender;
    if (typeof ascender !== "number") throw new Error("pdf_backend: font has no Ascender metric");
    return ascender / 1000;
  }

  /** Command. ExtGState op for a (fill, stroke) alpha pair; "" when opaque. */
  gsAlphaPair(ca, CA) {
    if (ca >= 1 && CA >= 1) return "";
    const key = `${+ca.toFixed(4)},${+CA.toFixed(4)}`;
    if (!this._gs.has(key)) {
      const name = `GS${this._gs.size + 1}`;
      const dict = this.doc.context.obj({ Type: "ExtGState", ca: +ca.toFixed(4), CA: +CA.toFixed(4) });
      this.page.node.setExtGState(PDFName.of(name), this.doc.context.register(dict));
      this._gs.set(key, name);
    }
    return `/${this._gs.get(key)} gs`;
  }

  /**
   * Command (async). Rasterizes `rawCmds` through the injected callback and
   * appends an image XObject draw. `placeRect` (WORLD coords in the current
   * CTM frame) is where the image lands; `srcRect` (default placeRect) is
   * the world region the pixels sample — they differ only for the deep-lens
   * fallback, where sampling the source square and placing it over the lens
   * bbox IS the magnification. Resolution: placeRect at the region view's
   * page-pt density × rasterScale.
   */
  async emitRasterRegion(rawCmds, { placeRect, srcRect = placeRect, srcView, background }, out) {
    if (!this.rasterize)
      throw new Error("pdf_backend: scene needs a raster region (blur / deep lens) but no rasterize callback was provided");
    const density = srcView.zoom * this.rasterScale; // px per world unit at the placed location
    const wPx = Math.max(1, Math.round(placeRect.w * density));
    const hPx = Math.max(1, Math.round(placeRect.h * density));
    const rasterView = {
      zoom: wPx / srcRect.w,
      panX: -srcRect.x * (wPx / srcRect.w),
      panY: -srcRect.y * (hPx / srcRect.h),
      dpr: 1,
    };
    const png = await this.rasterize(rawCmds, rasterView, wPx, hPx, background);
    const img = await this.doc.embedPng(png);
    const name = `Im${++this._imgCount}`;
    this.page.node.setXObject(PDFName.of(name), img.ref);
    // Image unit square: v=1 is the image's TOP row; in y-down space the cm
    // needs a -h so the top row lands at the rect's visual top.
    const n = pdfNum;
    out.push("q", `${n(placeRect.w)} 0 0 ${n(-placeRect.h)} ${n(placeRect.x)} ${n(placeRect.y + placeRect.h)} cm`, `/${name} Do`, "Q");
  }

  /** Command. Registers the finished content stream on the page. */
  setContent(content) {
    const stream = this.doc.context.stream(content, {});
    this.page.node.set(PDFName.of("Contents"), this.doc.context.register(stream));
  }
}
