/**
 * PDF page → VECTOR IR mapper (PDF P1 — "render a placed PDF page's vector
 * graphics as vector"). The PURE, DOM-free half of the PDF-as-vector feature:
 * it turns a pdf.js `page.getOperatorList()` (plain data — `{fnArray, argsArray}`)
 * into a list of PowerRP `path` IR ops, baking the running CTM into absolute
 * coordinates. It imports NO pdf.js and touches NO DOM, so it runs and tests in
 * bare node (PowerRP CLAUDE.md invariant); the async fetch of the operator list
 * (which needs pdf.js) lives in the browser/CLI-facing sibling
 * render_gpu/gpu/pdf_page_vector.js, exactly the ir.js(pure) / gpu/*_raster.js
 * (browser) split.
 *
 * ── THE DUAL PATTERN (mirrors latexVector, render_gpu/gpu/latex_raster.js) ────
 * A placed PDF page keeps its existing whole-page raster ref (pdf_page_raster.js)
 * as the ALWAYS-AVAILABLE fallback, and ADDS this vector sub-list when the page
 * is "vector-safe". emit() (plugins/pdf_page.js) prefers the vector sub-list when
 * present, else the raster `image()` quad — the same "vector for export, raster
 * as fallback" bet latexVector makes. No new IR op: a PDF page's vector content
 * is a list of the EXISTING `path` op, so all four backends (Skia/SVG/PDF)
 * render it for free (core/shapes.js proved the `path` pipeline end-to-end).
 *
 * ── WHY BAKE THE CTM (no pushTransform) ───────────────────────────────────────
 * A PDF content-stream `transform`/`cm` is a FULL affine and routinely carries
 * skew/shear; PowerRP's pushTransform is a SIMILARITY only (no skew — see
 * core/transform.js, ir.js pushTransform). So we transform every path control
 * point through the running CTM and emit a `path` whose `d` is ABSOLUTE
 * coordinates in the widget's local box. Transforming points (not the coordinate
 * system) represents arbitrary affine — skew included — losslessly, sidestepping
 * the similarity limitation. `strokeWidth` collapses to a scalar
 * (pdfLineWidth × meanScale(CTM)); anisotropic-scale stroke width is a documented
 * minor approximation (the same class the codebase tolerates for scaled worlds).
 *
 * ── COORDINATE FRAMES (verified against pdfjs-dist 5.7.284) ───────────────────
 * `constructPath` coordinates live in raw PDF user space (y-UP, origin
 * bottom-left, in points), AFTER the accumulated content-stream CTM but BEFORE
 * the page's y-flip. We compose one fixed page matrix Mpage that (1) applies the
 * pdf.js scale-1 viewport transform ([1,0,0,-1,0,Hpts] — y-up→y-down, origin to
 * top-left) then (2) a box→box scale into the widget's local box (same shape as
 * latexVector's viewBox→box). Then per drawable, Mfull = Mpage ∘ CTM, applied to
 * every control point. See render_gpu/gpu/tests/pdf_vector_test.js for the
 * placement math proven against a real fixture PDF.
 *
 * ── HYBRID / LOUD FALLBACK (Figma/Illustrator pattern) ────────────────────────
 * classifyPdfPage is a cheap pure gate: it vectorizes the SAFE set (solid
 * RGB/gray path fills & strokes) and RASTER-falls-back the hard set (text,
 * shading/gradient, pattern/colorspace, CMYK, clip, non-Normal blend, soft mask,
 * constant alpha < 1, transparency groups, form XObjects, image masks, embedded
 * images, over-budget, and ANY op it does not handle) with a human reason string
 * so the ingest logs WHY it fell back (loud, never silent — house rule).
 *
 * ── P1 TEXT RULE (text is P2) ─────────────────────────────────────────────────
 * If the page contains ANY text-showing op, it is classified vectorSafe=false →
 * whole-page raster. This GUARANTEES P1 never ships a page with MISSING text.
 * P1's win is pure-vector-graphics pages (diagrams/charts/figures with no text)
 * rendering crisp and zoom-independent; text pages stay raster (P0) until P2 adds
 * a text path. Selectable/outlined text extraction is P2.
 *
 * ── P1 IMAGE RULE (raster islands are P3) ─────────────────────────────────────
 * A page containing an embedded image (paintImageXObject / inline / mask /
 * repeat) also falls back to whole-page raster. WHY, precisely: pdf.js resolves
 * an image XObject's pixels only asynchronously through `page.objs` and bound to
 * a canvas/ImageBitmap (verified: `page.objs.get` throws "isn't resolved yet" in
 * bare node), so hybrid raster-islands (vector paths + `image` ops in one page)
 * cannot be produced or VERIFIED within P1's bare-node-testable scope, and the
 * whole-page raster (P0) already renders image content correctly. Raster islands
 * are explicit P3 work; the placement math (unit square → CTM) is documented
 * above for that follow-up.
 */

import { path } from "./ir.js";

/**
 * The pdf.js OPERATOR-LIST layout this mapper is pinned to (pdfjs-dist 5.7.284,
 * verified live). `getOperatorList` internals are pdf.js-private and reshape
 * across MAJORS (older versions used per-segment moveTo/lineTo ops and a
 * different `constructPath` arg layout). These constants are the single point of
 * version coupling: render_gpu/gpu/tests/pdf_vector_test.js asserts each entry
 * equals the live `pdfjsLib.OPS.*`, so a pdf.js bump that moves the layout FAILS
 * LOUDLY rather than silently dropping geometry (the house "no silent fallback"
 * rule; this is the feature's single biggest maintenance liability).
 */
export const PDF_OP = {
  dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5,
  setDash: 6, setRenderingIntent: 7, setFlatness: 8, setGState: 9,
  save: 10, restore: 11, transform: 12,
  moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25,
  closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30,
  beginText: 31, endText: 32, showText: 44, showSpacedText: 45,
  nextLineShowText: 46, nextLineSetSpacingShowText: 47, setFont: 37,
  setStrokeColorSpace: 50, setFillColorSpace: 51, setStrokeColor: 52, setStrokeColorN: 53,
  setFillColor: 54, setFillColorN: 55, setStrokeGray: 56, setFillGray: 57,
  setStrokeRGBColor: 58, setFillRGBColor: 59, setStrokeCMYKColor: 60, setFillCMYKColor: 61,
  shadingFill: 62, beginInlineImage: 63, beginImageData: 64, endInlineImage: 65, paintXObject: 66,
  markPoint: 67, markPointProps: 68, beginMarkedContent: 69, beginMarkedContentProps: 70,
  endMarkedContent: 71, beginCompat: 72, endCompat: 73,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
  beginAnnotation: 80, endAnnotation: 81,
  paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84, paintImageXObject: 85,
  paintInlineImageXObject: 86, paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88, paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90,
  constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93, rawFillPath: 94,
};

/**
 * The DrawOPS codes pdf.js encodes a `constructPath` segment buffer with (a
 * SEPARATE enum from PDF_OP — verified in pdfjs-dist 5.7.284's own
 * `makePathFromDrawOPS`). Not exported by pdf.js; pinned here and asserted by the
 * snapshot test via a decoded fixture path.
 *   moveTo(2 args) lineTo(2) curveTo(cubic, 6) quadraticCurveTo(4) closePath(0)
 */
export const DRAW_OP = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

/** constructPath paint verbs → how the fused path is painted. */
const FILL_PAINTS = new Set([PDF_OP.fill, PDF_OP.fillStroke, PDF_OP.closeFillStroke]);
const EOFILL_PAINTS = new Set([PDF_OP.eoFill, PDF_OP.eoFillStroke, PDF_OP.closeEOFillStroke]);
const STROKE_PAINTS = new Set([
  PDF_OP.stroke, PDF_OP.closeStroke, PDF_OP.fillStroke, PDF_OP.eoFillStroke,
  PDF_OP.closeFillStroke, PDF_OP.closeEOFillStroke,
]);
const CLOSE_PAINTS = new Set([
  PDF_OP.closeStroke, PDF_OP.closeFillStroke, PDF_OP.closeEOFillStroke,
]);
const ALL_PAINTS = new Set([...FILL_PAINTS, ...EOFILL_PAINTS, ...STROKE_PAINTS]);

/**
 * Per-page vector-op budget. A page with more drawing ops than this rasterizes
 * instead (a 50k-vector CAD page would swamp the scene and the exporters). Named
 * so the fallback reason can cite it; the value is generous — well above any
 * hand-figure/chart, below "a whole vector map".
 */
export const MAX_VECTOR_OP_COUNT = 20000;

/**
 * A PDF line width of 0 means "thinnest device-renderable line" (a hairline). Our
 * `path` op has no hairline concept and a strokeWidth of 0 renders as NO stroke
 * (backends skip `strokeWidth <= 0`), so a 0-width stroke would VANISH. We floor
 * it to this many PDF points (× the CTM mean-scale) so hairlines stay visible — a
 * documented minor approximation, not a silent drop.
 */
export const HAIRLINE_MIN_PT = 0.5;

// ── pure matrix helpers ───────────────────────────────────────────────────────
// A 2D affine is a 6-array [a,b,c,d,e,f] meaning x' = a·x + c·y + e,
// y' = b·x + d·y + f (the pdf.js / SVG DOMMatrix / core latex_raster convention).

/**
 * Pure function. Composes two affines: matMul(m1, m2) applies m2 FIRST then m1
 * (i.e. the matrix product m1·m2). Same semantics as pdf.js `Util.transform`.
 *
 * @param {number[]} m1 6-array [a,b,c,d,e,f] (outer)
 * @param {number[]} m2 6-array [a,b,c,d,e,f] (inner, applied first)
 * @returns {number[]} 6-array [a,b,c,d,e,f]
 *
 * @example matMul([1,0,0,1,0,0], [2,0,0,2,5,6]) // [2,0,0,2,5,6] (identity ∘ M = M)
 * @example matMul([1,0,0,-1,0,240], [1,0,0,1,20,20]) // [1,0,0,-1,20,220] (y-flip after a translate)
 */
export function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Pure function. The geometric mean scale of an affine's linear part
 * (√|det|) — the isotropic factor a scalar stroke width scales by. A pure
 * rotation/flip has mean scale 1; a uniform 2× has mean scale 2.
 *
 * @param {number[]} m 6-array [a,b,c,d,e,f]
 * @returns {number}
 *
 * @example matrixMeanScale([1,0,0,1,9,9]) // 1
 * @example matrixMeanScale([2,0,0,2,0,0]) // 2
 * @example matrixMeanScale([1,0,0,-1,0,240]) // 1 (a y-flip preserves lengths)
 */
export function matrixMeanScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/**
 * Pure function. The page matrix Mpage that maps raw PDF user space (y-up) into
 * the widget's local box (y-down): the pdf.js scale-1 viewport transform, then a
 * box→box scale/translate onto {box.x..x+w, box.y..y+h}. Composed once per page;
 * the running content CTM is applied on top (Mfull = Mpage ∘ CTM).
 *
 * @param {number[]} viewportTransform pdf.js getViewport({scale:1}).transform, e.g. [1,0,0,-1,0,H]
 * @param {number} pageWidth  scale-1 viewport width  (PDF points)
 * @param {number} pageHeight scale-1 viewport height (PDF points)
 * @param {{x:number,y:number,w:number,h:number}} box widget-local target box
 * @returns {number[]} 6-array [a,b,c,d,e,f]
 *
 * @example pageToBoxMatrix([1,0,0,-1,0,240], 300, 240, {x:0,y:0,w:300,h:240}) // [1,0,0,-1,0,240] (box == page → identity box-scale)
 * @example pageToBoxMatrix([1,0,0,-1,0,240], 300, 240, {x:0,y:0,w:150,h:120}) // [0.5,0,0,-0.5,0,120] (half-size box)
 */
export function pageToBoxMatrix(viewportTransform, pageWidth, pageHeight, box) {
  const boxScale = [box.w / pageWidth, 0, 0, box.h / pageHeight, box.x, box.y];
  return matMul(boxScale, viewportTransform);
}

/**
 * Pure function. A DeviceGray level (0..1) → a "#rrggbb" sRGB hex (gray → equal
 * channels). pdf.js keeps DeviceGray fills as their own setFillGray op rather
 * than pre-resolving to RGB; this is the sRGB-faithful conversion.
 *
 * @param {number} g gray level, 0 (black) .. 1 (white)
 * @returns {string} "#rrggbb"
 *
 * @example grayToHex(0) // "#000000"
 * @example grayToHex(1) // "#ffffff"
 * @example grayToHex(0.5) // "#808080"
 */
export function grayToHex(g) {
  const b = Math.max(0, Math.min(255, Math.round(g * 255)));
  const h = b.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

/** Pure helper. Rounds a coordinate to 3 decimals as a compact string. */
function fmt(v) {
  return String(+v.toFixed(3));
}

/**
 * Pure function. Decodes a pdf.js `constructPath` DrawOPS segment buffer into an
 * SVG `d` string in ABSOLUTE coordinates, transforming every control point
 * through `m`. Emits ONLY the PDF-export-safe subset M/L/C/Q/Z (no arcs, no S) —
 * exactly what svg_backend passes verbatim and pdf_backend's svgPathToPdfOps
 * accepts — so the result round-trips to every backend with zero new backend
 * code (the core/shapes.js contract). An unknown DrawOPS code throws (no silent
 * geometry drop).
 *
 * @param {ArrayLike<number>} buffer DrawOPS-encoded segments (Float32Array in 5.x)
 * @param {number[]} m 6-array affine applied to each point
 * @returns {string} SVG path data (M/L/C/Q/Z absolute)
 *
 * @example drawOpsToPathD([0,0,0, 1,0,80, 1,100,80, 1,100,0, 4], [1,0,0,1,0,0]) // "M0 0L0 80L100 80L100 0Z"
 * @example drawOpsToPathD([0,0,0, 1,60,0, 1,30,-50, 4], [1,0,0,-1,0,0]) // "M0 0L60 0L30 50Z" (y-flip)
 * @example drawOpsToPathD([0,0,0, 2,1,1,2,2,3,0], [1,0,0,1,0,0]) // "M0 0C1 1 2 2 3 0" (cubic)
 */
export function drawOpsToPathD(buffer, m) {
  const P = (x, y) => `${fmt(m[0] * x + m[2] * y + m[4])} ${fmt(m[1] * x + m[3] * y + m[5])}`;
  const out = [];
  let i = 0;
  while (i < buffer.length) {
    const code = buffer[i++];
    if (code === DRAW_OP.moveTo) {
      const x = buffer[i++], y = buffer[i++];
      out.push(`M${P(x, y)}`);
    } else if (code === DRAW_OP.lineTo) {
      const x = buffer[i++], y = buffer[i++];
      out.push(`L${P(x, y)}`);
    } else if (code === DRAW_OP.curveTo) {
      const c1x = buffer[i++], c1y = buffer[i++], c2x = buffer[i++], c2y = buffer[i++], ex = buffer[i++], ey = buffer[i++];
      out.push(`C${P(c1x, c1y)} ${P(c2x, c2y)} ${P(ex, ey)}`);
    } else if (code === DRAW_OP.quadraticCurveTo) {
      const cx = buffer[i++], cy = buffer[i++], ex = buffer[i++], ey = buffer[i++];
      out.push(`Q${P(cx, cy)} ${P(ex, ey)}`);
    } else if (code === DRAW_OP.closePath) {
      out.push("Z");
    } else {
      throw new Error(`drawOpsToPathD: unknown DrawOPS code ${code} at index ${i - 1}`);
    }
  }
  return out.join("");
}

/**
 * Pure Query. Inspects a `setGState` op's argument (an array of [key, value]
 * pairs, e.g. [["ca",0.5]], [["BM","multiply"]]) for graphics-state features P1
 * cannot represent in a solid `path` op. Returns a reason string when the gState
 * carries a non-Normal blend mode, a soft mask, or constant alpha < 1; else null
 * (only benign line/font params → safe to ignore).
 *
 * @param {Array} pairs argsArray[i][0] — an array of [key, value] pairs
 * @returns {string|null} fallback reason, or null if benign
 *
 * @example gStateFallbackReason([["LW", 4]]) // null
 * @example gStateFallbackReason([["ca", 0.5]]) // "constant alpha < 1 (ca=0.5)"
 * @example gStateFallbackReason([["BM", "multiply"]]) // "blend mode \"multiply\""
 */
export function gStateFallbackReason(pairs) {
  if (!Array.isArray(pairs)) return null;
  for (const pair of pairs) {
    if (!Array.isArray(pair)) continue;
    const [key, value] = pair;
    if (key === "SMask") {
      if (value !== null && value !== "None") return "soft mask (SMask)";
    } else if (key === "BM") {
      const bm = Array.isArray(value) ? value[0] : value;
      const norm = typeof bm === "string" ? bm.toLowerCase() : bm;
      if (norm !== "normal" && norm !== "compatible" && bm != null) return `blend mode "${bm}"`;
    } else if (key === "ca" || key === "CA") {
      if (typeof value === "number" && value < 1) return `constant alpha < 1 (${key}=${value})`;
    }
  }
  return null;
}

/**
 * Pure Query. Classifies whether a page's operator list can render as SOLID
 * vector `path` ops in P1, or must fall back to the whole-page raster. Walks
 * `fnArray` once; the FIRST op it cannot faithfully vectorize decides the
 * fallback and its reason (loud logging is the caller's job). See the module
 * header for the full SAFE / hard-set split and the P1 text & image rules.
 *
 * @param {{fnArray:number[], argsArray:any[]}} operatorList pdf.js getOperatorList() output
 * @returns {{vectorSafe:boolean, reason:string}}
 *
 * @example classifyPdfPage({fnArray:[12,91], argsArray:[[1,0,0,1,0,0],[22,[[0,0,0,4]],null]]}) // {vectorSafe:true, reason:"vector-safe"}
 * @example classifyPdfPage({fnArray:[31], argsArray:[null]}) // {vectorSafe:false, reason:"text (rasterized in P1; text is P2)"}
 * @example classifyPdfPage({fnArray:[85], argsArray:[["img_p0_1",64,48]]}) // {vectorSafe:false, reason:"embedded image (raster in P1; hybrid raster-islands are P3)"}
 */
export function classifyPdfPage(operatorList) {
  const { fnArray, argsArray } = operatorList;
  if (fnArray.length > MAX_VECTOR_OP_COUNT)
    return { vectorSafe: false, reason: `over budget (${fnArray.length} ops > ${MAX_VECTOR_OP_COUNT})` };
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    if (op === PDF_OP.setGState) {
      const reason = gStateFallbackReason(argsArray[i]?.[0]);
      if (reason) return { vectorSafe: false, reason };
      continue;
    }
    const reason = unsafeOpReason(op);
    if (reason) return { vectorSafe: false, reason };
  }
  return { vectorSafe: true, reason: "vector-safe" };
}

/** Ops the mapper consumes or safely ignores; a page using ONLY these vectorizes. */
const HANDLED_OR_BENIGN = new Set([
  PDF_OP.dependency, PDF_OP.setLineWidth, PDF_OP.setLineCap, PDF_OP.setLineJoin,
  PDF_OP.setMiterLimit, PDF_OP.setDash, PDF_OP.setRenderingIntent, PDF_OP.setFlatness,
  PDF_OP.save, PDF_OP.restore, PDF_OP.transform,
  PDF_OP.setStrokeGray, PDF_OP.setFillGray, PDF_OP.setStrokeRGBColor, PDF_OP.setFillRGBColor,
  PDF_OP.setStrokeTransparent, PDF_OP.setFillTransparent, PDF_OP.constructPath,
  PDF_OP.markPoint, PDF_OP.markPointProps, PDF_OP.beginMarkedContent,
  PDF_OP.beginMarkedContentProps, PDF_OP.endMarkedContent, PDF_OP.beginCompat, PDF_OP.endCompat,
  // setGState is handled specially (inspected) by the classifier before this set.
]);

/**
 * Pure Query. A human reason a specific op forces a raster fallback in P1, or
 * null if the op is handled/benign. The catch-all: any op NOT in the handled set
 * returns a reason (so a pdf.js addition or an unexpected op rasterizes loudly
 * rather than silently mis-rendering).
 *
 * @param {number} op a PDF_OP value
 * @returns {string|null}
 *
 * @example unsafeOpReason(91) // null (constructPath is handled)
 * @example unsafeOpReason(62) // "shading/gradient fill"
 */
export function unsafeOpReason(op) {
  if (HANDLED_OR_BENIGN.has(op)) return null;
  const O = PDF_OP;
  if (op >= O.beginText && op <= 49) return "text (rasterized in P1; text is P2)";
  if (op === O.clip || op === O.eoClip) return "clip path";
  if (op === O.shadingFill) return "shading/gradient fill";
  if (op === O.setStrokeCMYKColor || op === O.setFillCMYKColor) return "CMYK color";
  if (op === O.setStrokeColorSpace || op === O.setFillColorSpace ||
      op === O.setStrokeColor || op === O.setFillColor ||
      op === O.setStrokeColorN || op === O.setFillColorN) return "pattern/colorspace fill";
  if (op === O.paintImageXObject || op === O.paintImageXObjectRepeat)
    return "embedded image (raster in P1; hybrid raster-islands are P3)";
  if (op === O.paintInlineImageXObject || op === O.paintInlineImageXObjectGroup ||
      op === O.beginInlineImage || op === O.beginImageData || op === O.endInlineImage)
    return "inline image (raster in P1)";
  if (op === O.paintImageMaskXObject || op === O.paintImageMaskXObjectGroup ||
      op === O.paintImageMaskXObjectRepeat || op === O.paintSolidColorImageMask)
    return "image mask (raster in P1)";
  if (op === O.paintFormXObjectBegin || op === O.paintFormXObjectEnd || op === O.paintXObject)
    return "form XObject (raster in P1)";
  if (op === O.beginGroup || op === O.endGroup) return "transparency group";
  if (op === O.beginAnnotation || op === O.endAnnotation) return "annotation content";
  if ((op >= O.moveTo && op <= O.rectangle) || (op >= O.stroke && op <= O.endPath) || op === O.rawFillPath)
    return `unfused path op (${op})`;
  return `unhandled op (${op})`;
}

/**
 * Pure function. Maps a vector-safe page's operator list to a list of `path` IR
 * ops in the widget's local box space, baking the running CTM into absolute
 * coordinates (see the module header for the coordinate/CTM reasoning). Assumes
 * the page passed classifyPdfPage; if it meets an op or paint verb it does not
 * handle (which classifyPdfPage should have caught, or a pdf.js layout drift), it
 * THROWS loudly so the async ingest reports and falls back to raster — never a
 * silent mis-render.
 *
 * Args:
 *   operatorList ({fnArray, argsArray}): pdf.js getOperatorList() output
 *   opts.pageViewport ({width, height, transform}): pdf.js getViewport({scale:1})
 *   opts.box ({x, y, w, h}): the widget's local target box (crop-inset rect)
 *
 * Returns:
 *   object[]: `path` IR ops (local space), z-ordered as the op list is
 *
 * @example // pdfPageVectorIR({fnArray:[12,91], argsArray:[[1,0,0,1,0,0],[22,[new Float32Array([0,0,0,1,10,0,1,5,8,4])],null]]},
 * //   {pageViewport:{width:10,height:10,transform:[1,0,0,-1,0,10]}, box:{x:0,y:0,w:10,h:10}})
 * // → [ path({ d:"M0 10L10 10L5 2Z", fill:"#000000", fillRule:"nonzero" }) ]  (one filled triangle, y-flipped; default black fill, no color op)
 */
export function pdfPageVectorIR(operatorList, { pageViewport, box }) {
  const { fnArray, argsArray } = operatorList;
  const mPage = pageToBoxMatrix(pageViewport.transform, pageViewport.width, pageViewport.height, box);
  // The PDF graphics-state STACK: save(q)/restore(Q) snapshot the WHOLE state
  // (CTM + fill + stroke + line width), not just the CTM. Initial state = the
  // PDF defaults: DeviceGray black fill+stroke and line width 1 (a shape drawn
  // before any color op is black — dropping it would lose real content). `ctm`
  // is only ever REPLACED (matMul returns a fresh array), never mutated in place,
  // so a shallow copy on save safely isolates parent/child CTMs.
  const stack = [{ ctm: mPage, fill: "#000000", stroke: "#000000", lineWidth: 1 }];
  const gs = () => stack[stack.length - 1];
  const ops = [];

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];
    switch (op) {
      case PDF_OP.save:
        stack.push({ ...gs() });
        break;
      case PDF_OP.restore:
        if (stack.length === 1) throw new Error("pdfPageVectorIR: unbalanced restore (stack underflow)");
        stack.pop();
        break;
      case PDF_OP.transform:
        gs().ctm = matMul(gs().ctm, args);
        break;
      case PDF_OP.setFillRGBColor:
        gs().fill = args[0];
        break;
      case PDF_OP.setStrokeRGBColor:
        gs().stroke = args[0];
        break;
      case PDF_OP.setFillGray:
        gs().fill = grayToHex(args[0]);
        break;
      case PDF_OP.setStrokeGray:
        gs().stroke = grayToHex(args[0]);
        break;
      case PDF_OP.setFillTransparent:
        gs().fill = null;
        break;
      case PDF_OP.setStrokeTransparent:
        gs().stroke = null;
        break;
      case PDF_OP.setLineWidth:
        gs().lineWidth = args[0];
        break;
      case PDF_OP.constructPath: {
        const g = gs();
        const pathOp = emitConstructPath(args, g.ctm, g.fill, g.stroke, g.lineWidth);
        if (pathOp) ops.push(pathOp);
        break;
      }
      default:
        // Benign no-geometry state (dash/cap/join/miter/intent/flatness/marked
        // content/compat/dependency/gState) is safely ignored; anything else the
        // classifier should have rasterized — a THROW here means a classifier gap
        // or pdf.js layout drift, surfaced loudly for the ingest to catch.
        if (!HANDLED_OR_BENIGN.has(op) && op !== PDF_OP.setGState)
          throw new Error(`pdfPageVectorIR: unhandled op ${op} at index ${i} (classifier should have rasterized this page)`);
    }
  }
  return ops;
}

/**
 * Pure helper. Builds ONE `path` IR op from a `constructPath` arg triple
 * [paintOp, [segsBuffer], minMax] under the current CTM + paint state, or null
 * when the path would paint nothing (no fill and no visible stroke). Throws on an
 * unexpected paint verb or a non-numeric segment buffer (e.g. the main-thread
 * Path2D swap pdf.js can do — which we must never silently drop).
 */
function emitConstructPath(args, m, fill, stroke, lineWidth) {
  const paintOp = args[0];
  if (!ALL_PAINTS.has(paintOp))
    throw new Error(`pdfPageVectorIR: constructPath paint verb ${paintOp} not a fill/stroke (clip or unknown)`);
  const segs = Array.isArray(args[1]) ? args[1][0] : args[1];
  if (!segs || typeof segs.length !== "number" || (segs.length > 0 && typeof segs[0] !== "number"))
    throw new Error("pdfPageVectorIR: constructPath segment buffer is not numeric (pdf.js Path2D swap or layout drift)");
  let d = drawOpsToPathD(segs, m);
  if (d === "") return null;
  if (CLOSE_PAINTS.has(paintOp) && !d.endsWith("Z")) d += "Z";

  const doesFill = FILL_PAINTS.has(paintOp) || EOFILL_PAINTS.has(paintOp);
  const doesStroke = STROKE_PAINTS.has(paintOp);
  const fillColor = doesFill ? fill : null;
  const strokeColor = doesStroke ? stroke : null;
  // A 0-width PDF stroke is a hairline; floor it so it stays visible (see
  // HAIRLINE_MIN_PT). Stroke width scales by the CTM's isotropic mean scale.
  const strokeWidth = doesStroke ? Math.max(lineWidth, HAIRLINE_MIN_PT) * matrixMeanScale(m) : 0;
  if (fillColor === null && (strokeColor === null || strokeWidth <= 0)) return null; // nothing visible to draw

  return path({
    d,
    fill: fillColor,
    stroke: strokeColor,
    strokeWidth,
    fillRule: EOFILL_PAINTS.has(paintOp) ? "evenodd" : "nonzero",
  });
}
