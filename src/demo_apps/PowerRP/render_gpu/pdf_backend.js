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
 *   effectSubtree (Round 12D shadow/bloom/blend) — the hybrid rule per
 *     effect: shadow = raster PNG under VECTOR content (the manifest's
 *     verbatim case); bloom = the widget becomes a raster region; multiply/
 *     screen blends = raster region under an exact /BM ExtGState; add blends
 *     = the everything-below raster split (like blur). See emitEffect.
 *   ANY OTHER unrepresentable op (glassBackdrop today; any future backdrop/
 *     effect op with no vector form) — the GENERAL raster fallback: rasterize
 *     JUST that op's own region (the content it samples + the op, through the
 *     SAME GPU compositor the editor/thumbnails use), embed it as one image
 *     XObject, keep everything around it vector. This is the hybrid rule
 *     generalized from an enumerated list to "not in VECTOR_OPS → rasterize
 *     the component" — see emitRasterOp. (The SVG backend needs the same.)
 *
 * Structure: content-stream generation is pure string work (bare-node
 * testable, doctested); pdf-lib assembles the document (fonts, images,
 * ExtGStates, xref). The `rasterize` callback keeps this module DOM-free:
 * browsers pass the GPU pixel service, node tests pass a stub.
 */

import { flattenIR, parseColor, parsePaint, isGradientPaint, pushTransform, popTransform, SUPERSAMPLE_DENSITY, MAX_LENS_DEPTH as LENS_DEPTH_CAP } from "./ir.js";
import * as T from "../core/transform.js";
import { PDFDocument, PDFName, PDFDict, StandardFonts } from "pdf-lib";
import { DEFAULT_FONT, fontFileFor, hasEmbeddableFile } from "./fonts.js";
import { richTextDraws } from "../core/richtext.js";
import { fitBox } from "../core/geometry.js";

/**
 * Lens re-emit recursion cap — re-exported from ir.js (the single source shared
 * with the SVG backend and the GPU/Skia compositors): one level of true lens
 * re-interpretation; deeper lenses fall back (here: to a raster embed).
 */
export const MAX_LENS_DEPTH = LENS_DEPTH_CAP;

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

/** Pure function. The bbox {x,y,w,h} of a point list (a polygon's gradient
 * objectBoundingBox frame). Empty → a zero rect.
 *
 * @example pointsPathBounds([[0, 0], [10, 0], [5, 8]]) // {x: 0, y: 0, w: 10, h: 8}
 */
export function pointsPathBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pure function. An approximate bbox {x,y,w,h} of an SVG path `d` (its gradient
 * objectBoundingBox frame), from every on-path AND control point (control points
 * inflate the box slightly — a safe over-estimate for a gradient frame, no curve
 * flattening needed). Walks tokenizeSvgPath tracking the current point so relative
 * commands resolve. Covers the PDF-safe subset (M L H V C S Q T A Z, abs+rel).
 *
 * @example svgPathBounds("M0 0L10 0L5 8Z") // {x: 0, y: 0, w: 10, h: 8}
 * @example svgPathBounds("M2 3h10v6") // {x: 2, y: 3, w: 10, h: 6}
 */
export function svgPathBounds(d) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cx = 0, cy = 0;
  const hit = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const tok of tokenizeSvgPath(d)) {
    const cmd = tok[0], rel = cmd === cmd.toLowerCase(), a = tok.slice(1);
    const up = cmd.toUpperCase();
    if (up === "Z") continue;
    if (up === "H") { cx = rel ? cx + a[0] : a[0]; hit(cx, cy); continue; }
    if (up === "V") { cy = rel ? cy + a[0] : a[0]; hit(cx, cy); continue; }
    // All other commands: coords are (x,y) pairs. An A's leading 5 args
    // (rx,ry,rot,large,sweep) are NOT points — only its final (ex,ey) pair is.
    const coords = up === "A" ? a.slice(5) : a;
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const px = rel ? cx + coords[i] : coords[i];
      const py = rel ? cy + coords[i + 1] : coords[i + 1];
      hit(px, py);
    }
    // Advance the current point to the command's endpoint (last coord pair).
    if (coords.length >= 2) {
      cx = rel ? cx + coords[coords.length - 2] : coords[coords.length - 2];
      cy = rel ? cy + coords[coords.length - 1] : coords[coords.length - 1];
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pure function. Tokenizes an SVG path `d` string into [command, ...numbers]
 * runs. Splits on command letters (MLHVCSQTAZ, absolute+relative) and parses the
 * number list between them (commas/whitespace/sign-boundaries). MathJax v3
 * tex-svg glyph paths use ONLY absolute M L H V Q T Z (verified against the
 * bundled tex font) — this tokenizer covers the broader SVG grammar so a future
 * MathJax/font change can't silently drop geometry.
 *
 * @example tokenizeSvgPath("M0 0L10 10Z") // [["M", 0, 0], ["L", 10, 10], ["Z"]]
 * @example tokenizeSvgPath("M1 2 3 4") // [["M", 1, 2], ["L", 3, 4]] (repeated M coords → implicit L, SVG rule)
 * @example tokenizeSvgPath("H5V-3") // [["H", 5], ["V", -3]]
 */
export function tokenizeSvgPath(d) {
  const tokens = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m, cur = null;
  while ((m = re.exec(d)) !== null) {
    if (m[1] !== undefined) { cur = [m[1]]; tokens.push(cur); }
    else {
      if (!cur) throw new Error(`tokenizeSvgPath: number before any command in "${d.slice(0, 40)}"`);
      // SVG rule: extra coord pairs after M/m implicitly continue as L/l.
      const expected = SVG_ARGS[cur[0].toUpperCase()];
      if (expected > 0 && cur.length - 1 === expected && (cur[0] === "M" || cur[0] === "m")) {
        cur = [cur[0] === "M" ? "L" : "l"]; tokens.push(cur);
      }
      cur.push(Number(m[2]));
    }
  }
  return tokens;
}

/** Number of numeric args per SVG path command (per pair for repeatable ones). */
const SVG_ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Pure function. Converts an SVG path `d` string into PDF path operators
 * (m/l/c/h) in the SAME y-DOWN coordinate frame the string uses (no flip — the
 * page is already y-down when this content emits, and MathJax's exported viewBox
 * paths are y-down as drawn). Quadratic beziers (Q/T) are ELEVATED to cubic (c)
 * via the exact degree-elevation c1=p0+⅔(qc−p0), c2=p1+⅔(qc−p1) — PDF has no
 * quadratic operator. Relative commands (lowercase) accumulate off the current
 * point; H/V are horizontal/vertical lines; T reflects the previous quadratic
 * control point (identity if the previous command was not Q/T, per the SVG spec).
 * Fill rule is the CALLER's choice (`f` nonzero — glyph counters are wound
 * opposite the outer contour, the TrueType/Type1 convention MathJax inherits).
 *
 * Args:
 *   d (string): an SVG path data string (M L H V C S Q T Z, abs+rel)
 *
 * Returns:
 *   string: newline-joined PDF path operators (no paint operator — caller fills)
 *
 * @example svgPathToPdfOps("M0 0L10 0Z") // "0 0 m\n10 0 l\nh"
 * @example svgPathToPdfOps("M0 0H10V10") // "0 0 m\n10 0 l\n10 10 l"
 * @example svgPathToPdfOps("M0 0Q10 0 10 10") // "0 0 m\n6.6667 0 10 3.3333 10 10 c" (quadratic elevated to cubic)
 */
export function svgPathToPdfOps(d) {
  const n = pdfNum;
  const out = [];
  let cx = 0, cy = 0;        // current point
  let sx = 0, sy = 0;        // subpath start (for Z)
  let qpx = null, qpy = null; // previous quadratic control point (for T reflection)
  // Emit a quadratic (control qcx,qcy → end ex,ey from current) as a cubic.
  const quadTo = (qcx, qcy, ex, ey) => {
    const c1x = cx + (2 / 3) * (qcx - cx), c1y = cy + (2 / 3) * (qcy - cy);
    const c2x = ex + (2 / 3) * (qcx - ex), c2y = ey + (2 / 3) * (qcy - ey);
    out.push(`${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(ex)} ${n(ey)} c`);
    qpx = qcx; qpy = qcy; cx = ex; cy = ey;
  };
  for (const tok of tokenizeSvgPath(d)) {
    const cmd = tok[0];
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const a = tok.slice(1);
    if (up === "M") {
      cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1];
      sx = cx; sy = cy; qpx = qpy = null;
      out.push(`${n(cx)} ${n(cy)} m`);
    } else if (up === "L") {
      cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1]; qpx = qpy = null;
      out.push(`${n(cx)} ${n(cy)} l`);
    } else if (up === "H") {
      cx = rel ? cx + a[0] : a[0]; qpx = qpy = null;
      out.push(`${n(cx)} ${n(cy)} l`);
    } else if (up === "V") {
      cy = rel ? cy + a[0] : a[0]; qpx = qpy = null;
      out.push(`${n(cx)} ${n(cy)} l`);
    } else if (up === "C") {
      const c1x = rel ? cx + a[0] : a[0], c1y = rel ? cy + a[1] : a[1];
      const c2x = rel ? cx + a[2] : a[2], c2y = rel ? cy + a[3] : a[3];
      cx = rel ? cx + a[4] : a[4]; cy = rel ? cy + a[5] : a[5]; qpx = qpy = null;
      out.push(`${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(cx)} ${n(cy)} c`);
    } else if (up === "Q") {
      const qcx = rel ? cx + a[0] : a[0], qcy = rel ? cy + a[1] : a[1];
      quadTo(qcx, qcy, rel ? cx + a[2] : a[2], rel ? cy + a[3] : a[3]);
    } else if (up === "T") {
      // Reflect the previous quad control point about the current point; if the
      // previous command was not a quadratic, the control point IS the current
      // point (SVG spec) — a straight segment expressed as a degenerate quad.
      const qcx = qpx === null ? cx : 2 * cx - qpx, qcy = qpy === null ? cy : 2 * cy - qpy;
      quadTo(qcx, qcy, rel ? cx + a[0] : a[0], rel ? cy + a[1] : a[1]);
    } else if (up === "Z") {
      out.push("h"); cx = sx; cy = sy; qpx = qpy = null;
    } else {
      throw new Error(`svgPathToPdfOps: unsupported SVG path command "${cmd}" (MathJax uses M L H V Q T Z)`);
    }
    // Reflection state (qpx/qpy) is maintained inside each branch: quads set it,
    // every other command clears it — so a T after a non-quad reflects nothing.
  }
  return out.join("\n");
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
 * Pure function. The view that magnifies `view` by M so the lens's ORIGIN world
 * point renders where the lens CENTER did (the origin — what the lens magnifies
 * FROM — appears at the lens center, magnified by M). The same lens-view
 * algebra as the GPU's lensRenderView, in dpr-free page space. `originWorld`
 * defaults to `centerWorld` (a magnifier with no target magnifies about its own
 * center), reducing to the pre-origin page-space fixed point about the center.
 *
 * @example magnifiedView({zoom: 1, panX: 0, panY: 0}, {x: 100, y: 50}, 2) // {zoom: 2, panX: -100, panY: -50}
 * @example magnifiedView({zoom: 1, panX: 0, panY: 0}, {x: 100, y: 50}, 2, {x: 20, y: 10}) // {zoom: 2, panX: 60, panY: 30} (origin 20 renders where center 100 was)
 */
export function magnifiedView(view, centerWorld, m, originWorld = centerWorld) {
  return {
    zoom: view.zoom * m,
    panX: centerWorld.x * view.zoom + view.panX - originWorld.x * view.zoom * m,
    panY: centerWorld.y * view.zoom + view.panY - originWorld.y * view.zoom * m,
  };
}

/**
 * Near-pure function (console.error on unencodable text — reported, then
 * degraded to "?"). Encodes a string for Tj with a pdf-lib font.
 *
 * @example // tjHex(helvetica, "Hi") → "<4869>"
 */
export function tjHex(font, text) {
  return font.encodeText(encodableText(font, text)).toString();
}

/**
 * Near-pure function (console.error on unencodable text — reported, then
 * degraded to "?"). The exact string a font can show. Shared by tjHex (the
 * hex it encodes) and textGroupOps (the width the next piece is positioned
 * by), so the shown glyphs and the advance computed for them can never
 * disagree.
 *
 * @example // encodableText(helvetica, "Hi") → "Hi"
 * @example // encodableText(helvetica, "Hi\u{1F600}") → "Hi?" (+ console.error)
 */
function encodableText(font, text) {
  try {
    font.encodeText(text);
    return text;
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
    return kept;
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
 * Pure function. The DISTINCT (font id, bold) faces used by text ops — the set
 * ensureFonts embeds. Order-preserving, deduped. A text op with no `font`
 * defaults to DEFAULT_FONT (old IR / the system stack). Keyed "<fontId>|<0|1>".
 * A RICH text op contributes its op-level (font, bold) fallback face PLUS every
 * (font, bold) face across its runs (italic is NOT a separate face — the
 * committed fonts ship Regular+Bold only, so PDF fakes italic with a text-matrix
 * shear on the regular/bold face; see the text case). The op-level face is
 * included because it is the single-run FALLBACK the text case draws when no
 * measureText seam is available.
 *
 * @example textFaces([{op: "text", font: "inter", bold: false}, {op: "text", font: "inter", bold: true}]) // [{font: "inter", bold: false}, {font: "inter", bold: true}]
 * @example textFaces([{op: "text", bold: false}]) // [{font: "system", bold: false}]
 * @example textFaces([{op: "rect"}]) // []
 * @example textFaces([{op: "text", font: "inter", rich: {runs: [{font: "inter", bold: false}, {font: "lora", bold: true}], paras: [{}]}}]).length // 3 (op-level inter + inter/lora runs)
 */
export function textFaces(commands) {
  const seen = new Set();
  const out = [];
  const add = (font, bold) => {
    const key = `${font || DEFAULT_FONT}|${bold ? 1 : 0}`;
    if (!seen.has(key)) { seen.add(key); out.push({ font: font || DEFAULT_FONT, bold: !!bold }); }
  };
  const walk = (cmds) => {
    for (const c of cmds) {
      // Content-bearing ops re-emit their sub-list through the vector path
      // (emitCrop / emitEffect's vector-preserving branch), so text inside a
      // crop target or an effected widget needs its face embedded too — a
      // flat scan would throw "font not embedded" at emit time (caught by
      // the effects tests; the crop case was the same latent gap).
      if ((c.op === "cropSubtree" || c.op === "effectSubtree") && Array.isArray(c.content)) walk(c.content);
      if (c.op !== "text") continue;
      // Always include the op-level (font, bold): it is the single-run FALLBACK
      // face the text case uses when no measureText seam is present (rich op → its
      // plain-text degrade), so it must be embedded even for a rich op.
      add(c.font, c.bold);
      if (c.rich && Array.isArray(c.rich.runs)) {
        for (const r of c.rich.runs) add(r.font, r.bold);
      }
    }
  };
  walk(commands);
  return out;
}

/** Pure function. The PDF resource name + dictionary key for a (fontId, bold)
 * face — one per distinct face. Slugs the id so the name is a valid PDF token.
 * @example fontResName("inter", false) // "F_inter_R"
 * @example fontResName("source-serif", true) // "F_source_serif_B"
 * @example fontResName("system", false) // "F_system_R"
 */
export function fontResName(fontId, bold) {
  return `F_${fontId.replace(/[^A-Za-z0-9]/g, "_")}_${bold ? "B" : "R"}`;
}

/**
 * Pure function. The DISTINCT refs of ops with the given `op` in an IR list
 * (each embeds once, like a font). Order-preserving, deduped, and RECURSES into
 * `cropSubtree` content — a bordered/rounded/cropped image or video (the SHARED
 * STROKED-BOX BUNDLE) nests its image/video op INSIDE a cropSubtree's `content`
 * (an independently-flattened sub-list), so a top-level-only scan would miss it
 * and ensureImages/ensureVideoFrames would never embed the XObject, making
 * imageXObject/videoXObject throw at emit time (the crop box's OWN content
 * subtree — its target — likewise carries these ops). The magnifier lens's
 * "below" sub-list is a PREFIX of the outer stream (already scanned), so only
 * cropSubtree needs the descent.
 *
 * @example refsOfOp([{op: "image", ref: "a"}, {op: "rect"}, {op: "image", ref: "a"}], "image") // ["a"]
 * @example refsOfOp([{op: "cropSubtree", content: [{op: "image", ref: "x"}]}], "image") // ["x"]
 */
export function refsOfOp(commands, op) {
  const seen = new Set();
  const out = [];
  const walk = (cmds) => {
    for (const c of cmds) {
      if (c.op === op && !seen.has(c.ref)) { seen.add(c.ref); out.push(c.ref); }
      // Both content-carrying ops: a crop's clipped target subtree AND an
      // effected widget's own ops (its vector path re-emits them — their
      // media must be embedded like any other).
      if ((c.op === "cropSubtree" || c.op === "effectSubtree") && Array.isArray(c.content)) walk(c.content);
    }
  };
  walk(commands);
  return out;
}

/**
 * Pure function. The DISTINCT image refs in an IR list (each embeds once,
 * like a font). Order-preserving, deduped, recurses into cropSubtree content.
 *
 * @example imageRefs([{op: "image", ref: "a"}, {op: "rect"}, {op: "image", ref: "a"}]) // ["a"]
 * @example imageRefs([{op: "rect"}]) // []
 * @example imageRefs([{op: "cropSubtree", content: [{op: "image", ref: "b"}]}]) // ["b"]
 */
export function imageRefs(commands) {
  return refsOfOp(commands, "image");
}

/**
 * Pure function. The DISTINCT video refs in an IR list (each embeds ONE
 * current-frame image, like image refs). Order-preserving, deduped, recurses
 * into cropSubtree content.
 *
 * @example videoRefs([{op: "video", ref: "clip"}, {op: "rect"}, {op: "video", ref: "clip"}]) // ["clip"]
 * @example videoRefs([{op: "rect"}]) // []
 * @example videoRefs([{op: "cropSubtree", content: [{op: "video", ref: "c"}]}]) // ["c"]
 */
export function videoRefs(commands) {
  return refsOfOp(commands, "video");
}

/**
 * Pure function. The DISTINCT `pdfpage:` image refs eligible for a LOSSLESS
 * PAGE-EMBED (pdf-lib embedPdf — copies the source page's real vectors, text,
 * fonts, images): a ref used ONLY in FULL-FRAME, OPAQUE `image` ops. A cropped
 * (source sub-rect) or translucent placement is NOT a clean whole-page copy, so
 * it rasters through the image XObject path instead; a ref that appears in ANY
 * such non-eligible op is EXCLUDED here (one embedding kind per ref). Recurses
 * into cropSubtree/effectSubtree content exactly like refsOfOp — a page under a
 * stroked border (cropSubtree) or a shadow (effectSubtree's vector branch)
 * re-emits its full-frame image op through emitVector, where the embed is placed.
 *
 * @example pdfPageEmbedRefs([{op: "image", ref: "pdfpage:a:1:1", opacity: 1, src: {sx:0,sy:0,sw:1,sh:1}}]) // Set(["pdfpage:a:1:1"])
 * @example pdfPageEmbedRefs([{op: "image", ref: "pdfpage:a:1:1", opacity: 0.5, src: {sx:0,sy:0,sw:1,sh:1}}]).size // 0 (translucent → raster)
 * @example pdfPageEmbedRefs([{op: "image", ref: "pdfpage:a:1:1", opacity: 1, src: {sx:0.1,sy:0,sw:0.9,sh:1}}]).size // 0 (cropped → raster)
 * @example pdfPageEmbedRefs([{op: "image", ref: "data:image/png;base64,AA", opacity: 1, src: {sx:0,sy:0,sw:1,sh:1}}]).size // 0 (not a pdfpage ref)
 */
export function pdfPageEmbedRefs(commands) {
  const eligible = new Set();
  const excluded = new Set();
  const isFullFrame = (c) => { const s = c.src; return !s || (s.sx === 0 && s.sy === 0 && s.sw === 1 && s.sh === 1); };
  const walk = (cmds) => {
    for (const c of cmds) {
      if (c.op === "image" && typeof c.ref === "string" && c.ref.startsWith("pdfpage:")) {
        if (isFullFrame(c) && (c.opacity ?? 1) >= 1) eligible.add(c.ref);
        else excluded.add(c.ref);
      }
      if ((c.op === "cropSubtree" || c.op === "effectSubtree") && Array.isArray(c.content)) walk(c.content);
    }
  };
  walk(commands);
  for (const r of excluded) eligible.delete(r);
  return eligible;
}

/**
 * Pure function. Decodes a `data:` URI to {mime, bytes}. Only base64 payloads
 * are supported (that is what the image widget and drops produce); a non-base64
 * or non-data URI is a loud error (callers fetch URLs separately).
 *
 * @example decodeDataUri("data:image/png;base64,AAAA").mime // "image/png"
 * @example decodeDataUri("data:image/png;base64,AAAA").bytes.length // 3
 */
export function decodeDataUri(uri) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error(`decodeDataUri: not a data URI: "${uri.slice(0, 32)}…"`);
  if (!m[2]) throw new Error(`decodeDataUri: only base64 data URIs are supported, got "${m[1]}"`);
  const bin = base64ToBytes(m[3]);
  return { mime: m[1], bytes: bin };
}

/** Pure function. base64 string → Uint8Array (bare-node + browser: Buffer or
 * atob, whichever exists). Whitespace in the payload is stripped first.
 * @example base64ToBytes("AAAA").length // 3
 */
export function base64ToBytes(b64) {
  const clean = b64.replace(/\s/g, "");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(clean, "base64"));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Pure function. Sniffs an image encoding from its magic bytes — pdf-lib
 * embeds PNG and JPEG through different code paths, and the mime label in a
 * data URI can lie, so trust the bytes.
 *
 * @example imageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) // "png"
 * @example imageFormat(new Uint8Array([0xff, 0xd8, 0xff])) // "jpeg"
 */
export function imageFormat(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  throw new Error(`imageFormat: unsupported image encoding (magic ${[...bytes.slice(0, 4)].map((b) => b.toString(16)).join(" ")}) — PDF embed handles PNG and JPEG`);
}

/**
 * Pure function. Is `ref` a SYNTHETIC image ref — a custom URL scheme that
 * fetch() cannot load (pdfpage: / latex: / any future rasterized-source ref) —
 * rather than a fetchable data:/http(s)/blob/file/path ref? The runtime resolves
 * these through the image_registry (a bitmap injected via registerRasterizedBitmap,
 * never fetched); the PDF exporter routes them to the resolveImageBytes seam.
 *
 * @example isSyntheticImageRef("pdfpage:blob:x:1:1") // true
 * @example isSyntheticImageRef("latex:x^2:#000:1") // true
 * @example isSyntheticImageRef("data:image/png;base64,AAAA") // false
 * @example isSyntheticImageRef("https://x/a.png") // false
 * @example isSyntheticImageRef("blob:https://h/uuid") // false
 * @example isSyntheticImageRef("/assets/a.png") // false (path, no scheme)
 */
export function isSyntheticImageRef(ref) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(ref);
  if (!m) return false; // no scheme → a relative/absolute path, fetchable
  return !["data", "http", "https", "blob", "file"].includes(m[1].toLowerCase());
}

/**
 * Pure function. Parses a synthetic PDF-page image ref (the
 * gpu/pdf_page_raster.pdfPageRef format "pdfpage:<src>:<page>:<scale>") into
 * {src, page}, or null when `ref` is not a pdf_page ref. `page` and `scale` are
 * the TRAILING numeric fields, so a `src` that itself contains ':' (a data:/blob:
 * URI) parses correctly — the regex is right-anchored on :<int>:<number>.
 *
 * @example parsePdfPageRef("pdfpage:blob:x:3:2.3") // {src: "blob:x", page: 3}
 * @example parsePdfPageRef("pdfpage:blob:x:1:1") // {src: "blob:x", page: 1}
 * @example parsePdfPageRef("latex:eq:#000:1") // null
 */
export function parsePdfPageRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("pdfpage:")) return null;
  const m = /^pdfpage:(.*):(\d+):(\d+(?:\.\d+)?)$/.exec(ref);
  if (!m) return null;
  return { src: m[1], page: Number(m[2]) };
}

/**
 * Query (async; may fetch or resolve). The raw bytes for an image `ref`. A
 * `data:` URI decodes in-module (DOM-free); a fetchable URL (http(s)/blob/file/
 * path) is fetched (global fetch, browser + node ≥18). A SYNTHETIC ref
 * (isSyntheticImageRef — pdfpage:/latex:/…) is NOT fetchable: it is resolved
 * through the injected `resolveImageBytes(ref)` seam (the image_registry
 * bitmap → PNG bytes in browsers). A synthetic ref with NO seam is a loud
 * error (this was the "URL scheme not supported" fetch crash); the seam may
 * return null for a not-yet-rasterized source (draw nothing — a reported skip).
 *
 * Returns: Uint8Array of encoded image bytes, or null (resolver reported no
 * drawable content).
 */
async function loadImageBytes(ref, resolveImageBytes = null) {
  if (typeof ref !== "string" || ref.length === 0)
    throw new Error(`pdf_backend: image ref must be a non-empty string, got ${JSON.stringify(ref)}`);
  if (ref.startsWith("data:")) return decodeDataUri(ref).bytes;
  if (isSyntheticImageRef(ref)) {
    if (!resolveImageBytes)
      throw new Error(`pdf_backend: image ref "${ref}" is a synthetic scheme fetch() cannot load (pdfpage:/latex: are resolved via the image registry) but no resolveImageBytes seam was provided — pass irToPDF opts.resolveImageBytes`);
    return await resolveImageBytes(ref); // Uint8Array | null (null = no drawable content)
  }
  const res = await fetch(ref);
  if (!res.ok) throw new Error(`pdf_backend: failed to fetch image "${ref}" — HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
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
 *   opts.textAscent (number|fn|null): baseline offset as a FRACTION of font
 *     size (IR text is top-anchored; baseline = top + fraction·size). Now that
 *     each font is a DIFFERENT face, this is PER-FONT: pass a function
 *     (fontId, bold) → fraction (the browser measures each committed face's
 *     canvas fontBoundingBoxAscent/size so PDF baselines land exactly where the
 *     GPU atlas puts them). A bare number still works (applies to every face —
 *     legacy single-font callers); null → the embedded/AFM font's own Ascender.
 *   opts.loadFontBytes (fn|null): (basename) → Uint8Array|Promise<Uint8Array>
 *     of a committed TTF (../fonts/<basename>). The environment seam that keeps
 *     this backend DOM-free (browser: fetch a Vite ?url; node: readFileSync);
 *     null → committed fonts can't embed and fall back to standard-14 Helvetica
 *     (with a loud warning) — only `system` text embeds cleanly without it.
 *   opts.registerFontkit (fontkit|null): the @pdf-lib/fontkit instance, needed
 *     for pdf-lib to embed a custom TTF (embedFont throws FontkitNotRegistered
 *     otherwise). Injected (not hard-imported) so the backend stays dependency-
 *     light and node tests can supply it; null → committed fonts fall back to
 *     Helvetica (loud). `system` never needs it (standard-14).
 *   opts.videoFrame (async fn|null): (ref) → {mime, bytes} of the video's
 *     CURRENT FRAME as a PNG/JPEG (the manifest rule: PDF export of a video
 *     is a current-frame raster embed), or null for a blank/undrawable src.
 *     This keeps the backend DOM-free: a browser caller grabs the `<video>`
 *     element's current frame to a canvas → PNG here; node tests pass a
 *     fixture resolver (a STILL video's frame is deterministic — the sparkler
 *     rule). null → a scene containing a video op THROWS loudly (no silent
 *     drop) — a video export needs its frame resolver.
 *   opts.measureText (fn|null): (text, {size, bold, font, italic}) → {width,
 *     ascent, descent} in the same units as `size` — the per-RUN metric seam
 *     the SHARED rich-text layout (core/richtext) needs for wrap/align/baseline.
 *     Inject the SAME canvas2D-backed measure the GPU atlas uses so BOTH
 *     backends lay text out identically (the parity lever). null → a RICH text
 *     op falls back to its single-run plain-text draw (never a silent blank);
 *     legacy single-run text ops don't need it.
 *   opts.resolveImageBytes (async fn|null): (ref) → Uint8Array of PNG/JPEG bytes
 *     for a SYNTHETIC image ref (isSyntheticImageRef — pdfpage:/latex:/…, which
 *     fetch() cannot load), or null for a source not yet rasterized (draw
 *     nothing — a reported skip). The browser caller reads the image_registry
 *     ImageBitmap → canvas → toBlob PNG (the SAME shape as videoFrame). null +
 *     a synthetic ref in the scene → THROWS loudly (this was the "URL scheme
 *     pdfpage not supported" crash). data:/URL image refs never touch this seam.
 *   opts.resolvePdfPageEmbed (async fn|null): (ref) → {bytes, pageIndex} of the
 *     SOURCE PDF a `pdfpage:` ref points at, for a LOSSLESS whole-page embed
 *     (pdf-lib embedPdf — keeps the page's real vectors, selectable text, and
 *     fonts on export), or null when the ref is not a page-embed candidate (a
 *     non-pdf_page synthetic ref like latex:, or a source that can't be copied).
 *     Only full-frame opaque `pdfpage:` placements are offered here
 *     (pdfPageEmbedRefs); a null return (or an absent seam) falls the page back
 *     to the raster image path via resolveImageBytes. Keeps the backend DOM-free
 *     (the browser caller fetches/decodes the source bytes).
 *
 * Returns:
 *   Promise<Uint8Array>: the PDF file bytes
 *
 * @example // await irToPDF(sceneIR(nodes), {width: 1280, height: 720, view: fitRectView(camRect, 1280, 720, 1), background: "#ffffff", rasterize}) → Uint8Array starting "%PDF-"
 * @example // no-effect scenes need no rasterize: await irToPDF([rect({...})], {width: 100, height: 100, view: {zoom: 1, panX: 0, panY: 0}})
 */
export async function irToPDF(commands, { width, height, view, background = null, rasterize = null, rasterScale = SUPERSAMPLE_DENSITY, textAscent = null, videoFrame = null, loadFontBytes = null, registerFontkit = null, measureText = null, resolveImageBytes = null, resolvePdfPageEmbed = null }) {
  const doc = await PDFDocument.create();
  if (registerFontkit) doc.registerFontkit(registerFontkit); // required for embedFont(customTTF)
  const page = doc.addPage([width, height]);
  const ctx = new PdfAssembly(doc, page, rasterize, rasterScale, textAscent, videoFrame, loadFontBytes, measureText, resolveImageBytes, resolvePdfPageEmbed);
  await ctx.ensureFonts(textFaces(commands)); // sub-lists are slices, so scanning the top list covers lens re-emits
  await ctx.ensureImages(imageRefs(commands), pdfPageEmbedRefs(commands)); // embed image XObjects + lossless page-embeds up-front — emit is synchronous per command (same seam as fonts)
  await ctx.ensureVideoFrames(videoRefs(commands)); // grab + embed each video's current frame as an XObject (same up-front seam)

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

  // The raster-split ops: blurBackdrop (the original hybrid case), and an
  // ADD-blended effect widget (Round 12D) — true additive compositing needs
  // the real backdrop pixels (PDF has no /Add blend mode; /Screen ≠ add), so
  // it claims the same everything-below raster split a blur does. Multiply/
  // screen blends do NOT split — PDF has exact /BM equivalents (emitEffect).
  let lastBlurFlat = -1;
  flat.forEach((fc, i) => {
    if (fc.cmd.op === "blurBackdrop" || (fc.cmd.op === "effectSubtree" && fc.cmd.blend === "add")) lastBlurFlat = i;
  });

  if (lastBlurFlat >= 0) {
    // HYBRID RULE: the blurred/add-composited result below (and including)
    // the last split op is raster by necessity; embed it as one image
    // covering the region.
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
    } else if (cmd.op === "cropSubtree") {
      await emitCrop(cmd, world, region, out, ctx);
    } else if (cmd.op === "effectSubtree") {
      await emitEffect(cmd, world, region, out, ctx);
    } else if (!VECTOR_OPS.has(cmd.op)) {
      // GENERAL RASTER FALLBACK (the HYBRID RULE, generalized): an op this vector
      // backend cannot represent — a backdrop/effect op with no vector form
      // (glassBackdrop today; any FUTURE such op automatically) — rasterizes JUST
      // its own region instead of throwing. Everything vector-representable around
      // it stays vector. This is the same rule blurBackdrop/bloom already follow,
      // now applied to any unknown op rather than an enumerated list.
      await emitRasterOp(cmd, world, commands, rawIndexOf[i], region, out, ctx);
    } else {
      emitVector(cmd, world, out, ctx);
    }
  }
}

/**
 * Command (async; appends operators). One EFFECTED widget (manifest Round
 * 12D; ir.js effectSubtree) under the HYBRID RULE:
 *
 *   SHADOW — "compositing a shadow png under a vector thingy" (the manifest's
 *     verbatim anticipated case): the shadow ALONE (the op re-issued
 *     shadowOnly through the GPU rasterizer — same pixels as the editor)
 *     embeds as one raster XObject placed under the widget; the widget's own
 *     content then stays fully VECTOR (text stays text).
 *   BLOOM — the widget becomes a hybrid raster region (spec: "documented;
 *     loud, deliberate"): widget + bloom render together over transparency
 *     and embed as one PNG. KNOWN DIVERGENCE (documented): inside the raster
 *     the bloom halo carries alpha, so it OCCLUDES the page by its coverage
 *     where the GPU's pure ADD only brightens — a small halo-area delta the
 *     parity floor absorbs.
 *   BLEND multiply/screen — the widget region rasters over transparency and
 *     draws under a /BM Multiply|Screen ExtGState: PDF's blend semantics
 *     match the GPU's fixed-function multiply/screen EXACTLY against the
 *     page, and everything below stays vector. (A future upgrade could keep
 *     the content vector inside a transparency-group Form XObject with the
 *     same /BM — the group isolation is what makes per-op /BM correct;
 *     raster-first per the spec.) KNOWN DIVERGENCE: bloom baked into a
 *     multiplied/screened raster composites INSIDE the blend (GPU adds it
 *     after) — bloom+non-normal-blend simultaneously is the edge case.
 *   BLEND add — never reaches here: emitRegion's split detection claims the
 *     whole below-region as raster (the blur precedent; PDF has no additive
 *     blend mode, and screen ≠ add). Loud guard below.
 */
async function emitEffect(cmd, world, region, out, ctx) {
  if (cmd.blend === "add") throw new Error("pdf_backend: an add-blend effectSubtree must be consumed by emitRegion's raster split — it cannot compose as a vector-adjacent region (no /Add blend mode in PDF)");
  // The effect region's WORLD AABB: the local bbox inflated by the op's
  // margin (blur spill + shadow offset — ir.js computes it), through the four
  // rotated corners (conservative under rotation, exact unrotated).
  const m = cmd.margin;
  const corners = [
    [cmd.x - m, cmd.y - m], [cmd.x + cmd.w + m, cmd.y - m],
    [cmd.x - m, cmd.y + cmd.h + m], [cmd.x + cmd.w + m, cmd.y + cmd.h + m],
  ].map(([lx, ly]) => T.apply(world, lx, ly));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const placeRect = {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
  };
  // Raster ops re-render through the GPU (the SAME effect substrate the
  // editor uses — pixel-identical shadows/blooms) over TRANSPARENT background
  // so the PNG's alpha composites onto the page.
  const rasterOp = (op) => [pushTransform(world), op, popTransform()];
  const transparent = [0, 0, 0, 0];
  if (cmd.shadow) {
    await ctx.emitRasterRegion(rasterOp({ ...cmd, shadowOnly: true }), {
      placeRect, srcView: region.view, background: transparent,
    }, out);
  }
  if (cmd.shadowOnly) return; // shadow-only re-issues never carry content
  if (!cmd.bloom && cmd.blend === "normal") {
    // Vector-preserving path: shadow (if any) is already down as raster;
    // the widget's own commands re-emit as ordinary vectors (the content is
    // self-contained with its own absolute world — the emitCrop convention).
    await emitRegion(cmd.content, region, out, ctx);
    return;
  }
  // Bloom and/or multiply/screen: the widget region becomes ONE raster
  // (shadow already emitted above — stripped here so it isn't doubled).
  await ctx.emitRasterRegion(rasterOp({ ...cmd, shadow: null, blend: "normal" }), {
    placeRect, srcView: region.view, background: transparent,
  }, out, ctx.gsBlend(cmd.blend));
}

/**
 * A soft backdrop/effect (blur, drop shadow, refraction) spills PAST its
 * geometric footprint, so the general raster fallback inflates the op's local
 * bbox by this FRACTION of the footprint's larger half-extent on every side
 * before rasterizing. Sized to comfortably cover the largest current spill — the
 * Liquid Glass drop shadow, ≈ 0.12·h offset + 3·0.22·h blur ≈ 0.78·h (paint_skia
 * GLASS_SHADOW_* constants) — so no effect edge is clipped. Op-agnostic (no
 * effect-specific field is read); an op needing MORE than this can additionally
 * declare a `margin` (world units, added on top — the effectSubtree convention).
 */
export const RASTER_OP_SPILL_FRAC = 0.9;

/**
 * Pure function. The intersection of two world-space AABBs, or null when they do
 * not overlap. Used to clamp a raster-op tile to the visible region (a bounded
 * raster — a huge off-region op never mints a giant canvas).
 *
 * @example intersectRect({x:0,y:0,w:10,h:10},{x:5,y:5,w:10,h:10}) // {x:5,y:5,w:5,h:5}
 * @example intersectRect({x:0,y:0,w:2,h:2},{x:5,y:5,w:2,h:2}) // null
 */
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Pure function. The WORLD-space placement rect for an op's general raster
 * fallback: the op's LOCAL geometry bbox (detected from standard geometry fields,
 * so it stays op-agnostic) inflated by the soft-spill margin, mapped through
 * `world` (four rotated corners → AABB, conservative under rotation), then
 * clamped to the visible region. An op with NO recognizable geometry rasterizes
 * the WHOLE region (the safe catch-all — a page-level backdrop, like blur).
 * Returns null when the (clamped) rect is empty — the op is off-region; draw
 * nothing.
 *
 * Recognized geometry (in priority order): {cx,cy,halfW,halfH} (rounded box —
 * glass, box lens), {cx,cy,r} (circle), {x,y,w,h} (axis rect).
 *
 * @param {object} cmd the IR op (may carry a `margin` world-unit spill hint)
 * @param {number[]} world the op's absolute similarity transform (core/transform)
 * @param {{worldRect:{x,y,w,h}}} region the enclosing region (visible AABB)
 * @returns {{x,y,w,h}|null}
 */
export function rasterOpPlaceRect(cmd, world, region) {
  let local = null, spill = 0;
  if (Number.isFinite(cmd.halfW) && Number.isFinite(cmd.halfH)) {
    local = { x: cmd.cx - cmd.halfW, y: cmd.cy - cmd.halfH, w: cmd.halfW * 2, h: cmd.halfH * 2 };
    spill = Math.max(cmd.halfW, cmd.halfH);
  } else if (Number.isFinite(cmd.r)) {
    local = { x: cmd.cx - cmd.r, y: cmd.cy - cmd.r, w: cmd.r * 2, h: cmd.r * 2 };
    spill = cmd.r;
  } else if (Number.isFinite(cmd.w) && Number.isFinite(cmd.h)) {
    local = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };
    spill = Math.max(cmd.w, cmd.h) / 2;
  }
  if (!local) return region.worldRect; // no footprint → whole-region raster (page-level backdrop)
  const m = spill * RASTER_OP_SPILL_FRAC + (cmd.margin ?? 0);
  const corners = [
    [local.x - m, local.y - m], [local.x + local.w + m, local.y - m],
    [local.x - m, local.y + local.h + m], [local.x + local.w + m, local.y + local.h + m],
  ].map(([lx, ly]) => T.apply(world, lx, ly));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const worldAABB = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  return intersectRect(worldAABB, region.worldRect);
}

/**
 * Command (async; appends operators, registers an image XObject). The GENERAL
 * raster fallback for an op the vector path cannot represent. It rasterizes the
 * commands UP TO AND INCLUDING this op (balancedSlice through rawIdx) through the
 * injected GPU rasterizer — so the GPU applies the op's real effect (e.g. the
 * Liquid Glass SkSL) to exactly the below-content it samples — over the region's
 * background, capturing only the op's own placement rect, and embeds that as one
 * image XObject at that rect. Content around/below the rect stays fully VECTOR:
 * only this component pixelates. The tile is bounded to the visible region
 * (rasterOpPlaceRect), so an extreme-size op can never mint an unbounded canvas.
 *
 * Placing an OPAQUE tile (rendered over the opaque region background) at the op's
 * z-position cleanly overpaints the vector below-content within the rect (the
 * ground-truth pixels the editor shows), while later vector ops still draw ON TOP
 * — the z-order is preserved.
 *
 * @param {object} cmd the unrepresentable op.
 * @param {number[]} world its absolute transform.
 * @param {object[]} commands the region's raw IR list.
 * @param {number} rawIdx this op's index in `commands`.
 * @param {object} region {view, worldRect, background, ...} — the enclosing region.
 * @param {string[]} out the content-stream operator sink.
 * @param {PdfAssembly} ctx the document assembler.
 */
async function emitRasterOp(cmd, world, commands, rawIdx, region, out, ctx) {
  const placeRect = rasterOpPlaceRect(cmd, world, region);
  if (!placeRect || !(placeRect.w > 0) || !(placeRect.h > 0)) return; // off-region → nothing to draw
  const through = balancedSlice(commands, rawIdx + 1); // include this op so the GPU applies its effect
  await ctx.emitRasterRegion(through, {
    placeRect,
    srcView: region.view,
    background: region.background,
  }, out);
}

/**
 * Command (async; appends operators). One SHAPED-LENS magnifier (manifest
 * "BOX-SHAPED MAGNIFIERS"): a shaped clip (circle | rounded rect) + a
 * magnify-about-ORIGIN cm + recursive re-emit of the commands below the lens
 * (depth-capped → raster embed), then the vector rim/border ring. This is the
 * PDF form of the GPU shaped-lens; a crop box (emitCrop) is the magnification-1
 * named-subtree sibling of the same family. The ORIGIN (manifest "magnifier
 * target": what the lens magnifies FROM) is the world point shown at the lens
 * CENTER — the magnify cm maps origin → center; a default origin = center
 * reduces to the pre-origin magnify-about-center (byte-identical).
 *
 * SHAPE: a CIRCLE is rotation-invariant, so its clip/rim are emitted directly
 * in WORLD coordinates about the world center (the current CTM maps them to the
 * page) — unchanged from before shapes existed. A ROUNDED RECT genuinely has
 * orientation, so its clip/border are emitted in LOCAL coordinates under an
 * explicit cmSimilarity(world), then the CTM returns to the base frame before
 * the magnify cm (the emitCrop rotation convention — see emitCrop's comment).
 */
async function emitLens(cmd, world, commands, rawIdx, region, out, ctx) {
  const isBox = cmd.shape === "box";
  const center = T.apply(world, cmd.cx, cmd.cy);
  const originWorld = T.apply(world, cmd.originX, cmd.originY);
  const m = Math.max(cmd.magnification, 0.01);
  const below = balancedSlice(commands, rawIdx);
  // The lens shows a magnified view of the region about the ORIGIN. For the
  // hybrid raster split, the source rect is centered on the origin (what shows
  // at the lens center), sized by the lens extent / M (lensSourceRect's rule,
  // generalized to the box's half-extents).
  const halfSrcX = (isBox ? cmd.halfW : cmd.r) * world.scale / m;
  const halfSrcY = (isBox ? cmd.halfH : cmd.r) * world.scale / m;
  const sub = {
    view: magnifiedView(region.view, center, m, originWorld),
    worldRect: { x: originWorld.x - halfSrcX, y: originWorld.y - halfSrcY, w: halfSrcX * 2, h: halfSrcY * 2 },
    depth: region.depth + 1,
    background: region.background,
  };
  // The border geometry (circle path in world coords, or box path in local
  // coords under the box's transform) + its stroke color/width. ONE stroke ring
  // for both shapes (ir.js collapsed the legacy circle rim into stroke/strokeWidth).
  const strokeColor = cmd.stroke;
  // Pen width lives in the space its path is DRAWN in: the circle's path is in
  // base coords (scale by world), but the box strokes inside cm(world) — the cm
  // scales the pen at stroke time, so pre-multiplying by world.scale would
  // SQUARE it under scaled worlds. (Identical output at lens worlds' scale=1.)
  const strokeW = isBox ? cmd.strokeWidth : cmd.strokeWidth * world.scale;
  const clipOps = () => isBox
    ? [cmSimilarity(world), rectPath({ x: cmd.cx - cmd.halfW, y: cmd.cy - cmd.halfH, w: cmd.halfW * 2, h: cmd.halfH * 2, cornerRadius: cmd.cornerRadius }), "W n", cmSimilarity(T.invert(world))]
    : [ellipsePath({ cx: center.x, cy: center.y, rx: cmd.r * world.scale, ry: cmd.r * world.scale }), "W n"];

  out.push("q");
  out.push(...clipOps()); // clip (in the box's local frame, then back to base), no paint
  if (region.depth < MAX_LENS_DEPTH) {
    // VECTOR lens: magnify about the origin (maps origin → center), re-emit the
    // display list below. cm `m 0 0 m (center - m·origin)` scales world space by
    // m with origin landing at center; default origin=center ⇒ center·(1-m).
    out.push(`${pdfNum(m)} 0 0 ${pdfNum(m)} ${pdfNum(center.x - m * originWorld.x)} ${pdfNum(center.y - m * originWorld.y)} cm`);
    await emitRegion(below, sub, out, ctx);
  } else {
    // Depth cap (MAX_LENS_DEPTH = the GPU recursion bound): a lens inside a
    // lens embeds as raster — the user-ratified pixelated fallback. Sample the
    // SOURCE region (about the origin), place it over the lens bbox.
    const placeHalfX = (isBox ? cmd.halfW : cmd.r) * world.scale;
    const placeHalfY = (isBox ? cmd.halfH : cmd.r) * world.scale;
    await ctx.emitRasterRegion(below, {
      placeRect: { x: center.x - placeHalfX, y: center.y - placeHalfY, w: placeHalfX * 2, h: placeHalfY * 2 },
      srcRect: sub.worldRect,
      srcView: region.view,
      background: region.background,
    }, out);
  }
  out.push("Q");

  if (strokeColor && strokeW > 0) { // width 0 = NO rim/border (manifest spec)
    const gs = ctx.gsAlphaPair(1, strokeColor[3] * cmd.opacity);
    out.push("q", ...(gs ? [gs] : []));
    out.push(`${pdfNum(strokeColor[0])} ${pdfNum(strokeColor[1])} ${pdfNum(strokeColor[2])} RG`);
    out.push(`${pdfNum(strokeW)} w`);
    if (isBox) {
      out.push(cmSimilarity(world), rectPath({ x: cmd.cx - cmd.halfW, y: cmd.cy - cmd.halfH, w: cmd.halfW * 2, h: cmd.halfH * 2, cornerRadius: cmd.cornerRadius }), "S", "Q");
    } else {
      out.push(ellipsePath({ cx: center.x, cy: center.y, rx: cmd.r * world.scale, ry: cmd.r * world.scale }), "S", "Q");
    }
  }
}

/**
 * Command (async; appends operators). One crop box (manifest ARCHITECTURE
 * PLAN #3 — the vector-lens precedent, simplified): fill the rounded-rect
 * region, clip to it, re-emit `cmd.content` (the target's OWN commands,
 * already wrapped in the relative transform by sceneIR — a SELF-CONTAINED IR
 * list, unlike a lens's "everything below in the raw stream", so this needs
 * no balancedSlice/rawIdx), then stroke the border on top. No magnification
 * (view is unchanged — the crop box re-renders its target 1:1, matching the
 * GPU's CROP_WGSL) and no depth cap: `content` can never contain a NESTED
 * cropSubtree targeting this same box (core/derive.resolveCropTargets
 * forbids a crop box's target from being another crop box, and the target's
 * own render is suppressed from the normal tree), so recursion is naturally
 * bounded by the document's own crop-box count — no artificial cap needed
 * here (unlike the GPU's MAX_CROP_DEPTH, which bounds re-render TEXTURE
 * depth, a resource limit the PDF vector path doesn't share).
 *
 * ROTATION: unlike emitLens's circle (rotation-invariant — a rotated circle
 * IS the same circle, so emitLens only ever needed the WORLD-space center),
 * a rounded RECT genuinely has orientation. The clip/fill/stroke geometry is
 * therefore emitted in LOCAL coordinates under an explicit cmSimilarity(world)
 * — the SAME convention emitVector uses for rect/ellipse — instead of
 * pre-transforming a single origin point (which silently drops rotation,
 * the bug this comment replaced: a 45°-rotated crop box rendered as an
 * axis-aligned square in early testing until this fix).
 *
 * CRITICAL: `content`'s commands carry their own ABSOLUTE world transforms
 * (see ports.sceneIR's doc comment) — they must NOT be emitted while the
 * crop box's OWN cmSimilarity(world) is still active on the CTM, or the
 * box's rotation/translation composes ON TOP of content's already-absolute
 * transform (double-applied — the bug THIS comment replaced: content
 * appeared missing/mispositioned under a rotated box). The clip path
 * survives a CTM change within the same q/Q block (PDF clip regions are
 * fixed in DEVICE space once "W n" executes), so cmSimilarity(T.invert(world))
 * immediately after the clip returns the CTM to the page's base frame
 * before content re-emits in its own absolute space — exactly matching the
 * GPU's cropView, which is the OUTER view unchanged (never composed with
 * the crop box's own transform).
 */
async function emitCrop(cmd, world, region, out, ctx) {
  // Honor cmd.x/cmd.y (the region's LOCAL top-left), not a hardcoded 0,0. A
  // real crop box always has x=y=0 (its position lives in `world`), so this was
  // latent — but a DECORATED media widget (render_gpu/decorate.js) emits a
  // cropSubtree at the CROPPED rect's inset offset (x=cropLeft, y=cropTop) so
  // the frame hugs the visible pixels; the GPU compositor already reads cmd.x/
  // cmd.y (its rounded-rect region is centered at cmd.x+cmd.w/2), so using them
  // here makes the PDF clip/fill/border match the GPU exactly.
  const local = { x: cmd.x ?? 0, y: cmd.y ?? 0, w: cmd.w, h: cmd.h, cornerRadius: cmd.cornerRadius };

  if (cmd.fill) {
    const gs = ctx.gsAlphaPair(cmd.fill[3] * cmd.opacity, 1);
    out.push("q", cmSimilarity(world), ...(gs ? [gs] : []));
    out.push(`${pdfNum(cmd.fill[0])} ${pdfNum(cmd.fill[1])} ${pdfNum(cmd.fill[2])} rg`);
    out.push(rectPath(local), "f", "Q");
  }

  out.push("q", cmSimilarity(world));
  out.push(rectPath(local), "W n"); // clip, no paint — fixed in DEVICE space now
  out.push(cmSimilarity(T.invert(world))); // undo the box's own transform: back to the page's base frame
  // Content re-emits in ABSOLUTE world space exactly like the top-level
  // region does (its commands carry their own absolute transforms), so
  // `sub` reuses the SAME view/worldRect as the outer region, unchanged.
  const sub = { view: region.view, worldRect: region.worldRect, depth: region.depth + 1, background: region.background };
  await emitRegion(cmd.content, sub, out, ctx);
  out.push("Q");

  const strokeW = cmd.strokeWidth ?? 0;
  if (cmd.stroke && strokeW > 0) {
    const gs = ctx.gsAlphaPair(1, cmd.stroke[3] * cmd.opacity);
    out.push("q", cmSimilarity(world), ...(gs ? [gs] : []));
    out.push(`${pdfNum(cmd.stroke[0])} ${pdfNum(cmd.stroke[1])} ${pdfNum(cmd.stroke[2])} RG`);
    out.push(`${pdfNum(strokeW)} w`);
    out.push(rectPath(local), "S", "Q");
  }
}

/**
 * The ops the VECTOR path (emitVector, below) can represent directly. THE single
 * source of truth for "is this op vector-representable": emitRegion routes any op
 * NOT in this set — and not one of its OWN compositing ops handled earlier
 * (magnifyBackdrop / cropSubtree / effectSubtree, and blurBackdrop / add-blend,
 * consumed by the raster split) — through the general raster fallback
 * (emitRasterOp) rather than throwing. Keep in lockstep with emitVector's switch;
 * its `default` stays a LOUD guard so a set/switch drift fails fast (no silent
 * fallback) rather than mis-rendering.
 */
export const VECTOR_OPS = new Set(["rect", "ellipse", "polyline", "polygon", "path", "text", "latexVector", "image", "video", "videoV5"]);

/** Command (appends operators, registers resources via ctx). One vector drawable. */
function emitVector(cmd, world, out, ctx) {
  const ops = [];
  switch (cmd.op) {
    case "rect":
    case "ellipse": {
      if (!cmd.fill && !(cmd.stroke && cmd.strokeWidth > 0)) return;
      const pathStr = cmd.op === "rect" ? rectPath(cmd) : ellipsePath(cmd);
      if (isGradientPaint(cmd.fill) || isGradientPaint(cmd.stroke)) {
        const bounds = cmd.op === "rect"
          ? { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }
          : { x: cmd.cx - cmd.rx, y: cmd.cy - cmd.ry, w: 2 * cmd.rx, h: 2 * cmd.ry };
        ops.push(...gradientShapeOps(pathStr, bounds, cmd, ctx, false));
        break;
      }
      ops.push(...paintSetup(cmd.fill, cmd.stroke, cmd.strokeWidth, cmd.opacity, ctx));
      ops.push(pathStr);
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
      if (isGradientPaint(cmd.fill)) {
        ops.push(...gradientShapeOps(pointsPath(cmd.points) + " h", pointsPathBounds(cmd.points), cmd, ctx, false));
        break;
      }
      ops.push(...paintSetup(cmd.fill, null, 0, cmd.opacity, ctx));
      ops.push(pointsPath(cmd.points), "h f");
      break;
    }
    case "path": {
      // Generic vector path (Wave 2): the `d` string → PDF path operators via
      // the existing svgPathToPdfOps (m/l/c; Q/T elevated to cubic). fill/stroke
      // setup is the shared paintSetup; the paint operator gets its even-odd
      // variant (f*/B*) when the fill rule asks for it (nonzero is the default).
      if (!cmd.fill && !(cmd.stroke && cmd.strokeWidth > 0)) return;
      if (isGradientPaint(cmd.fill) || isGradientPaint(cmd.stroke)) {
        ops.push(...gradientShapeOps(svgPathToPdfOps(cmd.d), svgPathBounds(cmd.d), cmd, ctx, cmd.fillRule === "evenodd"));
        break;
      }
      ops.push(...paintSetup(cmd.fill, cmd.stroke, cmd.strokeWidth, cmd.opacity, ctx));
      ops.push(svgPathToPdfOps(cmd.d));
      let po = paintOp(cmd.fill, cmd.stroke, cmd.strokeWidth);
      if (cmd.fillRule === "evenodd" && (po === "f" || po === "B")) po += "*";
      ops.push(po);
      break;
    }
    case "text": {
      if (cmd.rich && ctx.measureText) {
        // RICH TEXT: run the SHARED pure layout (core/richtext) with the PDF's
        // OWN measure seam (the SAME canvas-backed metrics the GPU atlas uses —
        // the parity lever), then emit each same-style LINE CLUSTER as ONE text
        // object with a TJ array (groupedTextDraws/textGroupOps): pieces (words
        // AND their spaces) verbatim and contiguous in one show sequence so
        // pdftotext reproduces the visible text EXACTLY — spaces included —
        // while TJ adjustments pin every piece to the layout's x (GPU parity).
        // Underline/strike follow as filled rects.
        const draws = richTextDraws(cmd, ctx.richMeasure());
        // HIGHLIGHT backgrounds FIRST (Round 13.4): a filled rect behind each
        // highlighted run, emitted BEFORE the glyph text objects so it paints
        // under the glyphs (painter's order — the whole op shares one q…Q + world
        // cm, so all three layers, highlight/glyph/decoration, transform crisply).
        // Reuses the decoration-rect idiom (rg + re + f); a highlight is just a
        // full-height rect rather than a thin bar.
        for (const h of draws.highlights) {
          const c = parseColor(h.color);
          const gs = ctx.gsAlphaPair(c[3] * h.opacity, 1);
          if (gs) ops.push(gs);
          ops.push(`${pdfNum(c[0])} ${pdfNum(c[1])} ${pdfNum(c[2])} rg`);
          ops.push(`${pdfNum(h.x)} ${pdfNum(h.y)} ${pdfNum(h.w)} ${pdfNum(h.h)} re`, "f");
        }
        for (const g of groupedTextDraws(draws.textDraws)) {
          ops.push(...textGroupOps(g, ctx));
        }
        for (const ln of draws.lines) {
          // Decoration bar: a filled rect in local space (crisp, rotates/scales
          // with the run's world transform like the glyphs).
          const c = parseColor(ln.color);
          const gs = ctx.gsAlphaPair(c[3] * ln.opacity, 1);
          if (gs) ops.push(gs);
          ops.push(`${pdfNum(c[0])} ${pdfNum(c[1])} ${pdfNum(c[2])} rg`);
          ops.push(`${pdfNum(ln.x)} ${pdfNum(ln.y - ln.thickness / 2)} ${pdfNum(ln.w)} ${pdfNum(ln.thickness)} re`, "f");
        }
        break;
      }
      // LEGACY single-run text op (parity scenes / hand-built IR / no measure
      // seam): one run top-anchored at cmd.y via ascentFraction, exactly as
      // before. Its color is already a parsed rgba array (from the text builder).
      const fontId = cmd.font || DEFAULT_FONT;
      const baseline = cmd.y + ctx.ascentFraction(fontId, cmd.bold) * cmd.size;
      ops.push(...textRunOps(cmd.text, cmd.x, baseline, cmd.size, cmd.bold, false, cmd.color, cmd.opacity, fontId, ctx));
      break;
    }
    case "latexVector": {
      // TRUE VECTOR EQUATION (Round 15.1): MathJax glyph <path>s → PDF path
      // operators (m/l/c) filled NONZERO (`f`) — the file's universal fill rule
      // AND the correct rule for font-derived outlines (glyph counters in
      // e/a/0/8 are wound opposite the outer contour, so nonzero winding leaves
      // them as holes; even-odd would misfill nested/self-intersecting glyphs).
      // emitVector already applied cmSimilarity(world); here we push ONE extra
      // local cm mapping the glyph viewBox onto the draw box {x,y,w,h} — a plain
      // box→box scale+translate (BOTH y-DOWN, so no flip, unlike the image op's
      // -h). This is the same "extra local cm inside ops" shape image placement
      // uses (imagePlacementOps), minus the flip.
      const vb = cmd.viewBox;
      if (cmd.glyphs.length === 0 || vb.w <= 0 || vb.h <= 0) return; // nothing to draw
      // preserveAspect (default): UNIFORM fit + center (letterbox) so export
      // matches the on-screen render; else the legacy non-uniform box→box scale.
      let sxScale, syScale, ox = 0, oy = 0;
      if (cmd.preserveAspect !== false) {
        const f = fitBox(vb.w, vb.h, cmd.w, cmd.h);
        sxScale = syScale = f.scale; ox = f.offsetX; oy = f.offsetY;
      } else {
        sxScale = cmd.w / vb.w; syScale = cmd.h / vb.h;
      }
      // box→box: glyph point (px,py) → (x + ox + (px−minX)·sx, y + oy + (py−minY)·sy).
      const tx = cmd.x + ox - vb.minX * sxScale, ty = cmd.y + oy - vb.minY * syScale;
      ops.push(`${pdfNum(sxScale)} 0 0 ${pdfNum(syScale)} ${pdfNum(tx)} ${pdfNum(ty)} cm`);
      // Group consecutive glyphs by fill color: set `rg` + alpha once per color
      // run, concatenate all that run's subpaths, fill once (the polygon/rich-
      // text "many subpaths, one fill" idiom — fewest operators, and nonzero
      // winding across a glyph's outer+counter contours produces the holes).
      let curFill = null;
      let pending = [];
      const flush = () => {
        if (pending.length === 0) return;
        const c = curFill;
        const gs = ctx.gsAlphaPair(c[3] * (cmd.opacity ?? 1), 1);
        if (gs) ops.push(gs);
        ops.push(`${pdfNum(c[0])} ${pdfNum(c[1])} ${pdfNum(c[2])} rg`);
        ops.push(pending.join("\n"), "f");
        pending = [];
      };
      for (const glyph of cmd.glyphs) {
        const c = parseColor(glyph.fill);
        if (curFill === null || c[0] !== curFill[0] || c[1] !== curFill[1] || c[2] !== curFill[2] || c[3] !== curFill[3]) {
          flush(); curFill = c;
        }
        pending.push(svgPathToPdfOps(glyph.d));
      }
      flush();
      break;
    }
    case "image": {
      // EMBEDDED image XObject (manifest HYBRID RULE: a bitmap is embedded raster
      // among the vector elements). The XObject was pre-embedded by ensureImages;
      // here we just place it. The image unit square has v=1 at its TOP row, so
      // in the page's y-DOWN space the cm carries -h and lands the top row at the
      // rect's visual top (same convention as emitRasterRegion). Alpha via
      // ExtGState so per-item opacity composites like every other op. A source
      // rect (edge-crop insets) becomes a clip-to-dest + scaled-up placement so
      // only the cropped sub-region shows (imagePlacementOps).
      // LOSSLESS PAGE-EMBED (a pdf_page whose source page was copied whole via
      // pdf-lib embedPdf — real vectors + selectable text + fonts): placed as a
      // Form XObject, not the raster image XObject. ensureImages built it for a
      // full-frame opaque `pdfpage:` ref (pdfPageEmbedRefs); the placement flips
      // the page's y-UP point box onto the dest rect.
      const embed = ctx.pdfPageEmbed(cmd.ref);
      if (embed) {
        const gsE = ctx.gsAlphaPair(cmd.opacity ?? 1, 1);
        if (gsE) ops.push(gsE);
        ops.push(...pdfPageEmbedPlacementOps(cmd, embed));
        break;
      }
      const name = ctx.imageXObject(cmd.ref);
      if (name === null) return; // src had no drawable bytes (empty/blank) — draw nothing, matching the GPU skip
      const gs = ctx.gsAlphaPair(cmd.opacity ?? 1, 1);
      if (gs) ops.push(gs);
      ops.push(...imagePlacementOps(cmd, name));
      break;
    }
    case "video": {
      // CURRENT-FRAME raster embed (manifest: a video exports to PDF as its
      // current frame). The grabbed frame was pre-embedded as an image XObject
      // by ensureVideoFrames; here we place it exactly like the image case
      // (y-flip cm so the frame's top row lands at the rect's visual top,
      // opacity via ExtGState, source-rect crop via imagePlacementOps). A
      // CLI/deterministic export shows the poster/first frame (the sparkler
      // rule) — the frame the resolver grabs.
      const name = ctx.videoXObject(cmd.ref);
      if (name === null) return; // src had no drawable frame (blank/undecoded) — draw nothing, matching the GPU skip
      const gs = ctx.gsAlphaPair(cmd.opacity ?? 1, 1);
      if (gs) ops.push(gs);
      ops.push(...imagePlacementOps(cmd, name));
      break;
    }
    case "videoV5":
      // V5 is an EDITOR off-main-thread perf experiment; the vector PDF backend
      // has no frame-embed for it (its <video> lives in the browser-only V5
      // registry, unreachable from a node/export grab), so it draws NOTHING here —
      // deterministic and crash-free. (In-browser PNG export DOES show the current
      // V5 frame, since skia/browser_media.sceneMedia resolves videoV5.) A known
      // bound, matched by svg_backend. In VECTOR_OPS so it routes here, not the
      // raster fallback.
      break;
    default:
      throw new Error(`pdf_backend: unknown op "${cmd.op}"`);
  }
  out.push("q", cmSimilarity(world), ...ops, "Q");
}

/**
 * Pure function. The content-stream ops that place an image/video XObject
 * `name` into the op's dest rect (cmd.x/y/w/h), honoring an optional source
 * rect (cmd.src, edge-crop insets). Full-frame source ({0,0,1,1} or absent) →
 * the plain y-flip cm placement, byte-identical to the pre-crop backend. A
 * cropped source → clip to the dest rect, then place the WHOLE image scaled up
 * so its sub-rect (sx,sy,sw,sh) lands exactly on the dest rect (only that
 * sub-region survives the clip). This is the PDF equivalent of the GPU's UV
 * source rect — a source crop, not a stretch.
 *
 * DERIVATION (page y-DOWN space; image data has v=0 at its TOP row, and the
 * plain placement's `-h` in the cm flips the unit square so the image's TOP row
 * lands at the dest rect's TOP). With no crop the placement maps the image's
 * [0,1]² unit square onto the dest rect via `w 0 0 -h  x  y+h cm`. To instead
 * map the source sub-rect (sx,sy,sw,sh) onto the dest rect, scale the FULL image
 * up to width w/sw, height h/sh, and shift its origin by the cropped-away
 * margins measured FROM THE TOP-LEFT of the source (the sx,sy corner is the
 * sub-rect's top-left, same convention as the GPU UV origin): left crop = sx of
 * the full width, TOP crop = sy of the full height. The clip to the dest rect
 * (re W n) then shows only the sub-rect. (The earlier 1−(sy+sh) top margin was
 * an inverted-v bug — the source top IS sy from the top, verified against the
 * GPU UV output.)
 *
 * @example imagePlacementOps({x: 10, y: 20, w: 100, h: 80}, "Im0") // ["100 0 0 -80 10 100 cm", "/Im0 Do"]
 * @example imagePlacementOps({x: 0, y: 0, w: 100, h: 100, src: {sx: 0, sy: 0, sw: 0.5, sh: 0.5}}, "Im0")[0] // "0 0 100 100 re W n"
 * @example imagePlacementOps({x: 40, y: 30, w: 100, h: 76, src: {sx: 0.25, sy: 0.25, sw: 0.625, sh: 0.6333}}, "Im0")[1] // "160 0 0 -120.0063 0 120.0047 cm" (full image origin: left crop 0.25·160 back from x=40 → 0; top crop 0.25·120 up from y=30 → 0, +fullH for the flip)
 */
export function imagePlacementOps(cmd, name) {
  const n = pdfNum;
  const s = cmd.src;
  const full = !s || (s.sx === 0 && s.sy === 0 && s.sw === 1 && s.sh === 1);
  if (full) {
    return [`${n(cmd.w)} 0 0 ${n(-cmd.h)} ${n(cmd.x)} ${n(cmd.y + cmd.h)} cm`, `/${name} Do`];
  }
  // Full image size so the sub-rect fills the dest rect; origin shifted by the
  // cropped-away margins measured from the source TOP-LEFT (sx, sy).
  const fullW = cmd.w / s.sw, fullH = cmd.h / s.sh;
  const originX = cmd.x - s.sx * fullW;      // left crop = sx of the full width
  const originYTop = cmd.y - s.sy * fullH;    // top crop = sy of the full height (v=0 at top)
  return [
    `${n(cmd.x)} ${n(cmd.y)} ${n(cmd.w)} ${n(cmd.h)} re W n`, // clip to the dest rect (no paint)
    `${n(fullW)} 0 0 ${n(-fullH)} ${n(originX)} ${n(originYTop + fullH)} cm`,
    `/${name} Do`,
  ];
}

/**
 * Pure function. The content-stream ops that place an embedded-PDF-page Form
 * XObject `embed` ({name, width, height} — the source page's box in PDF points,
 * y-UP) into the op's dest rect (cmd.x/y/w/h) in the page's y-DOWN space. The
 * page content is y-UP in its own [0,width]×[0,height] box; the cm maps that box
 * onto the dest rect with a -h/H entry so the page's TOP row lands at the rect's
 * visual top — the SAME flip convention as imagePlacementOps' full-frame case,
 * generalized from the image unit square (w, -h) to the page's point box
 * (w/W, -h/H). Page-embeds are only built for full-frame opaque placements
 * (pdfPageEmbedRefs), so there is no source sub-rect to honor.
 *
 * @example pdfPageEmbedPlacementOps({x: 10, y: 20, w: 100, h: 80}, {name: "Pg1", width: 200, height: 160}) // ["0.5 0 0 -0.5 10 100 cm", "/Pg1 Do"]
 */
export function pdfPageEmbedPlacementOps(cmd, embed) {
  const n = pdfNum;
  const sx = cmd.w / embed.width, sy = cmd.h / embed.height;
  return [`${n(sx)} 0 0 ${n(-sy)} ${n(cmd.x)} ${n(cmd.y + cmd.h)} cm`, `/${embed.name} Do`];
}

/** Oblique shear (tan of the synthesized-italic slant angle) for PDF fake-italic
 * — the committed fonts ship Regular+Bold only (no italic file), so an italic
 * run is drawn on the regular/bold face with a text-matrix skew, mirroring the
 * GPU's canvas2D-synthesized oblique. ≈ tan(12°) — the de-facto oblique angle
 * (FreeType/Cairo synthesize italic at ~12°; a common typographic default).
 * PENDING RATIFICATION (no linked in-repo precedent). NOTE: a face that HAS a
 * real italic (canvas2D uses it on the GPU) will differ from this fixed oblique
 * — a documented italic parity delta for those faces. */
const PDF_OBLIQUE_SHEAR = 0.2126; // tan(12°)

/**
 * Pure function. Groups CONSECUTIVE rich-text draws (core/richtext.richTextDraws
 * output — already ordered line-by-line, left-to-right) that sit on the SAME
 * baseline with the SAME style into clusters a single TJ array can show.
 *
 * WHY (the text-EXTRACTION cornerstone): emitting each laid-out piece (word /
 * space) as its own absolutely-positioned Tj block breaks pdftotext whenever
 * canvas metrics ≠ the PDF font's metrics (the `system` font measures SF Pro
 * but draws Helvetica): the wider drawn word overruns the next piece's
 * position, poppler's GEOMETRIC word-builder sees overlapping clusters, and the
 * isolated space fragment is eaten → "PowerRPV1". Inside ONE text object the
 * space CHARACTER itself separates the words in stream order — extraction is
 * verbatim by construction, immune to metric drift.
 *
 * Args:
 *   textDraws (object[]): [{text, x, baselineY, size, color, bold, italic,
 *     font, opacity}] in layout order
 *
 * Returns:
 *   object[][]: clusters of consecutive same-line same-style draws
 *
 * @example groupedTextDraws([{text: "a", baselineY: 10, size: 12, font: "system", bold: false, italic: false, color: "#000", opacity: 1, x: 0}, {text: " ", baselineY: 10, size: 12, font: "system", bold: false, italic: false, color: "#000", opacity: 1, x: 8}]).length // 1 (same line+style → one cluster)
 * @example groupedTextDraws([{text: "a", baselineY: 10, size: 12, font: "system", bold: false, italic: false, color: "#000", opacity: 1, x: 0}, {text: "b", baselineY: 10, size: 12, font: "system", bold: true, italic: false, color: "#000", opacity: 1, x: 8}]).length // 2 (bold change splits)
 * @example groupedTextDraws([{text: "a", baselineY: 10, size: 12, font: "system", bold: false, italic: false, color: "#000", opacity: 1, x: 0}, {text: "b", baselineY: 30, size: 12, font: "system", bold: false, italic: false, color: "#000", opacity: 1, x: 0}]).length // 2 (new line splits)
 * @example groupedTextDraws([]) // []
 */
export function groupedTextDraws(textDraws) {
  const groups = [];
  let key = null;
  for (const d of textDraws) {
    // OUTLINE (Round 13.4) joins the cluster key: an outline change splits the
    // cluster exactly like a color change, so each cluster is style-homogeneous
    // and the single Tr/RG/w emitted per cluster (textGroupOps) is correct for
    // every piece in it. A run with no outline (width 0) keys "0|..." identically
    // to before — non-outlined text keeps its historical single-cluster grouping
    // (the extraction-fidelity invariant: uniform-style lines stay ONE BT…ET).
    const k = `${d.baselineY}|${d.size}|${d.font}|${d.bold ? 1 : 0}|${d.italic ? 1 : 0}|${d.color}|${d.opacity}|${(d.outlineWidth ?? 0) > 0 ? 1 : 0}|${d.outlineColor}|${d.outlineWidth}`;
    if (key !== k) { groups.push([]); key = k; }
    groups[groups.length - 1].push(d);
  }
  return groups;
}

/**
 * Command (may register an ExtGState via ctx). Operators drawing ONE same-style
 * line cluster of rich-text pieces as a SINGLE text object: BT / Tf / color,
 * then per piece [Tz] + Tm (y-flip + oblique skew when italic) + Tj, then ET.
 *
 * TWO guarantees, both required by the extraction cornerstone ("pdftotext
 * reproduces the visible text VERBATIM including spaces"):
 *   1. STREAM CONTIGUITY — all of a line-cluster's characters (words AND their
 *      space pieces) are shown in order inside ONE text object, so stream-order
 *      extractors read them verbatim.
 *   2. GEOMETRIC FIDELITY — each piece's drawn ink spans EXACTLY the layout's
 *      width: `Tz` (horizontal scaling) is set per piece to layoutWidth /
 *      naturalWidth, and an absolute `Tm` positions the piece at the layout's
 *      x. poppler's DEFAULT extractor rebuilds words purely from glyph
 *      geometry — when canvas metrics ≠ the PDF face's metrics (the `system`
 *      font measures SF Pro but draws Helvetica), an unscaled word's ink
 *      overruns the next word's position and poppler merges them
 *      ("PowerRPV1"); Tz pins both ENDS of every piece so the inter-word gaps
 *      the extractor sees ARE the layout's gaps. (Rejected alternatives: TJ
 *      pen adjustments — pin only piece STARTS, the overrunning ink still
 *      merges words, reproduced; Tw word-spacing — only applies to single-byte
 *      code 32, dead on Identity-H CID-embedded TTFs.)
 * For committed fonts canvas and PDF share the TTF, so Tz ≈ 100 (a no-op
 * emitted only when it differs after pdfNum rounding).
 */
function textGroupOps(group, ctx) {
  const d0 = group[0];
  const font = ctx.font(d0.font, d0.bold);
  const [r, g, b, a] = pdfTextInk(d0.color);
  const ops = [];
  const gs = ctx.gsAlphaPair(a * (d0.opacity ?? 1), 1);
  if (gs) ops.push(gs);
  ops.push(`${pdfNum(r)} ${pdfNum(g)} ${pdfNum(b)} rg`);
  ops.push("BT", `${ctx.fontName(d0.font, d0.bold)} ${pdfNum(d0.size)} Tf`);
  // OUTLINE (Round 13.4): a run with outlineWidth > 0 draws its glyphs in text
  // rendering mode 2 (fill + STROKE) with a stroke color (RG) and width (w);
  // else mode 0 (fill only, the historical default). Tr is a text-state
  // operator — emitted once per cluster (each cluster is outline-homogeneous by
  // the grouping key). The mode is ALWAYS emitted (0 or 2) so a prior outlined
  // cluster's Tr never leaks into a later fill-only cluster (Tr persists across
  // BT/ET within one content stream). The stroke width is the LOCAL run-unit
  // value — the surrounding world `cm` (line width applies POST-cm) scales it
  // with the glyphs; pre-multiplying by world.scale would double-apply it (the
  // emitLens scale² stroke bug — concerns.md — which the SVG/PDF text path
  // deliberately avoids by keeping width LOCAL).
  const outlined = (d0.outlineWidth ?? 0) > 0;
  if (outlined) {
    const [sr, sg, sb] = parseColor(d0.outlineColor);
    ops.push(`${pdfNum(sr)} ${pdfNum(sg)} ${pdfNum(sb)} RG`);
    ops.push(`${pdfNum(d0.outlineWidth)} w`);
    ops.push("2 Tr");
  } else {
    ops.push("0 Tr");
  }
  // Italic skews via the Tm `c` slot (see textRunOps); y-flip keeps glyphs
  // upright in the page's y-down space.
  const c = d0.italic ? -PDF_OBLIQUE_SHEAR : 0;
  const style = { size: d0.size, bold: d0.bold, font: d0.font, italic: d0.italic };
  let lastTz = "100"; // PDF default horizontal scaling
  for (const d of group) {
    const shown = encodableText(font, d.text);
    // Fit the piece's drawn ink to the LAYOUT width (the same measure the GPU
    // laid out with — ctx.measureText is the shared seam). measure the ORIGINAL
    // text (that width is where the layout put the next piece) but the PDF
    // font's natural width of what is SHOWN (encodableText substitution).
    const layoutW = ctx.measureText(d.text, style).width;
    const naturalW = font.widthOfTextAtSize(shown, d0.size);
    const tz = naturalW > 0 ? pdfNum((layoutW / naturalW) * 100) : "100";
    if (tz !== lastTz) { ops.push(`${tz} Tz`); lastTz = tz; }
    ops.push(`1 0 ${pdfNum(c)} -1 ${pdfNum(d.x)} ${pdfNum(d.baselineY)} Tm`);
    ops.push(`${font.encodeText(shown).toString()} Tj`);
  }
  ops.push("ET");
  return ops;
}

/** Command (may register an ExtGState via ctx). Operators drawing ONE text run's
 * glyphs: BT / Tf / color / Tm (y-flip, + oblique skew when italic) / Tj / ET.
 * `baseline` is the run's baseline y in local (op) space; italic applies a
 * text-matrix shear (PDF fake-italic) since the committed fonts have no italic
 * file. Color is a parsed [r,g,b,a] array. */
function textRunOps(str, x, baseline, size, bold, italic, color, opacity, fontId, ctx) {
  if (str.length === 0) return [];
  const ops = [];
  const font = ctx.font(fontId, bold);
  // color is a parsed rgba array (solid) OR a gradient Paint (rare gradient text)
  // — pdfTextInk degrades a gradient to its first stop (loud, one-time).
  const [r, g, b, a] = pdfTextInk(color);
  const gs = ctx.gsAlphaPair(a * (opacity ?? 1), 1);
  if (gs) ops.push(gs);
  ops.push(`${pdfNum(r)} ${pdfNum(g)} ${pdfNum(b)} rg`);
  ops.push("BT", `${ctx.fontName(fontId, bold)} ${pdfNum(size)} Tf`);
  // Tm: y-flip (d = -1) keeps glyphs upright in the page's y-down space. Italic
  // adds a skew in the `c` slot; with d = -1 the skew is negated so the top of
  // each glyph leans RIGHT (the standard forward italic slant).
  const c = italic ? -PDF_OBLIQUE_SHEAR : 0;
  ops.push(`1 0 ${pdfNum(c)} -1 ${pdfNum(x)} ${pdfNum(baseline)} Tm`);
  ops.push(`${tjHex(font, str)} Tj`, "ET");
  return ops;
}

/**
 * Command (may register a /Shading + ExtGState via ctx). Emits a shape whose
 * fill and/or stroke is a gradient Paint (Axis-1). `pathStr` is the shape's path
 * construction ops (in local coords); `bounds` its local bbox (the gradient
 * objectBoundingBox frame). A gradient FILL clips to the shape and paints the
 * shading through a unit→bbox cm (CTM-relative `sh`); a gradient STROKE has no
 * clean `sh` analogue, so it degrades to the gradient's first stop as a solid
 * (a loud one-time report — PDF gradient strokes are the rare tail). Solid fill/
 * stroke on the same shape take the byte-identical rg/RG path.
 */
function gradientShapeOps(pathStr, bounds, cmd, ctx, evenOdd) {
  const ops = [];
  const opacity = cmd.opacity ?? 1;
  if (cmd.fill) {
    if (isGradientPaint(cmd.fill)) {
      const sh = ctx.shadingName(cmd.fill);
      const gs = ctx.gsAlphaPair(opacity, 1);
      ops.push("q");
      if (gs) ops.push(gs);
      ops.push(pathStr, evenOdd ? "W* n" : "W n"); // clip to the shape
      ops.push(`${pdfNum(bounds.w)} 0 0 ${pdfNum(bounds.h)} ${pdfNum(bounds.x)} ${pdfNum(bounds.y)} cm`); // unit → local bbox
      ops.push(`/${sh} sh`);
      ops.push("Q");
    } else {
      const gs = ctx.gsAlphaPair(cmd.fill[3] * opacity, 1);
      ops.push("q");
      if (gs) ops.push(gs);
      ops.push(`${pdfNum(cmd.fill[0])} ${pdfNum(cmd.fill[1])} ${pdfNum(cmd.fill[2])} rg`, pathStr, evenOdd ? "f*" : "f", "Q");
    }
  }
  if (cmd.stroke && cmd.strokeWidth > 0) {
    const stroke = isGradientPaint(cmd.stroke) ? gradientStrokeSolid(cmd.stroke) : cmd.stroke;
    const gs = ctx.gsAlphaPair(1, stroke[3] * opacity);
    ops.push("q");
    if (gs) ops.push(gs);
    ops.push(`${pdfNum(stroke[0])} ${pdfNum(stroke[1])} ${pdfNum(stroke[2])} RG`, `${pdfNum(cmd.strokeWidth)} w`, pathStr, "S", "Q");
  }
  return ops;
}

/** Query. A gradient stroke's representative solid (its first stop) — PDF has no
 * clean stroked-gradient primitive, so a gradient STROKE degrades to this with a
 * loud one-time report (the documented rare-tail deviation). */
function gradientStrokeSolid(paint) {
  reportOncePdf("pdf-gradient-stroke", "pdf_backend: gradient STROKE is not expressible as a PDF shading — degrading to the gradient's first stop as a solid stroke (fills use true shadings; gradient strokes are the rare tail)");
  return paint.stops[0].color;
}

/** Query. A text run's ink color → an [r,g,b,a] solid. A solid (string or rgba)
 * parses normally; a GRADIENT text fill degrades to its first stop with a loud
 * one-time report (shapes get true PDF shadings; gradient TEXT export is the rare
 * tail — SVG export keeps it via <text fill=url(#..)>). */
function pdfTextInk(color) {
  if (isGradientPaint(color)) {
    reportOncePdf("pdf-gradient-text", "pdf_backend: gradient TEXT fill is not expressible as a PDF text color — degrading to the gradient's first stop (SVG export keeps gradient text via url(#..))");
    return parsePaint(color).stops[0].color;
  }
  return parseColor(color);
}

const _pdfWarned = new Set();
function reportOncePdf(key, msg) {
  if (_pdfWarned.has(key)) return;
  _pdfWarned.add(key);
  console.warn(msg);
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
  constructor(doc, page, rasterize, rasterScale, textAscent = null, videoFrame = null, loadFontBytes = null, measureText = null, resolveImageBytes = null, resolvePdfPageEmbed = null) {
    this.doc = doc;
    this.page = page;
    this.rasterize = rasterize;
    this.rasterScale = rasterScale;
    this.textAscent = textAscent; // number | (fontId, bold)=>fraction | null
    this.videoFrame = videoFrame; // (ref) → {mime, bytes} of the current frame, or null
    this.loadFontBytes = loadFontBytes; // (basename) → Uint8Array | null (env seam)
    this.measureText = measureText; // (text, {size,bold,font,italic}) → {width,ascent,descent} | null (rich layout seam)
    this.resolveImageBytes = resolveImageBytes; // (ref) → Uint8Array | null — synthetic-ref (pdfpage:/latex:) byte resolver
    this.resolvePdfPageEmbed = resolvePdfPageEmbed; // (ref) → {bytes, pageIndex} | null — lossless page-embed source
    this._fonts = new Map();  // "<fontId>|<0|1>" → PDFFont
    this._fontNames = new Map(); // "<fontId>|<0|1>" → PDF resource name
    this._gs = new Map(); // "ca,CA" → ExtGState name
    this._imgCount = 0;
    this._imageXObjects = new Map(); // image ref → XObject name, or null (blank/undrawable src)
    this._pageEmbeds = new Map(); // pdfpage ref → {name, width, height} (lossless Form XObject page-embed)
    this._videoXObjects = new Map(); // video ref → XObject name, or null (blank/undrawable frame)
    this._shadings = new Map(); // JSON(paint) → /Shading resource name (Axis-1 gradient shadings)
  }

  /**
   * Command (registers a /Shading resource on first use). A parsed gradient Paint
   * → its PDF Shading resource name. Coords are in the gradient's objectBoundingBox
   * UNIT space (0..1); the emit clips to the shape and pushes a unit→bbox cm before
   * `/name sh`, so the same 0..1 numbers render the same objectBoundingBox gradient
   * as the Skia shader + SVG def. Axial (ShadingType 2) for linear, radial
   * (ShadingType 3, two concentric circles r=0→r) for radial; Extend clamps both
   * ends. Colors are DeviceRGB (per-stop alpha is not expressible in a PDF shading
   * — the item opacity rides an ExtGState at the call site).
   */
  shadingName(paint) {
    const key = JSON.stringify(paint);
    if (this._shadings.has(key)) return this._shadings.get(key);
    const ctx = this.doc.context;
    const fnRef = this._gradientColorFn(paint.stops);
    const dict = paint.type === "radialGradient"
      ? { ShadingType: 3, ColorSpace: "DeviceRGB", Coords: [paint.center.x, paint.center.y, 0, paint.center.x, paint.center.y, paint.r], Function: fnRef, Extend: [true, true] }
      : { ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [paint.from.x, paint.from.y, paint.to.x, paint.to.y], Function: fnRef, Extend: [true, true] };
    const ref = ctx.register(ctx.obj(dict));
    const name = `Sh${this._shadings.size + 1}`;
    this._shadingDict().set(PDFName.of(name), ref);
    this._shadings.set(key, name);
    return name;
  }

  /** Query→build. The page Resources /Shading subdictionary (created on demand,
   * mirroring pdf-lib's normalizedEntries for Font/XObject/ExtGState). */
  _shadingDict() {
    const ctx = this.doc.context;
    const Resources = this.page.node.normalizedEntries().Resources;
    let Shading = Resources.lookupMaybe(PDFName.of("Shading"), PDFDict);
    if (!Shading) { Shading = ctx.obj({}); Resources.set(PDFName.of("Shading"), Shading); }
    return Shading;
  }

  /** Command (registers Function objects). A gradient's stops → a PDF color
   * Function ref: a single exponential (FunctionType 2) for 2 stops, else a
   * stitching (FunctionType 3) over per-gap exponentials with the interior stop
   * offsets as Bounds. DeviceRGB triples (per-stop alpha dropped). */
  _gradientColorFn(stops) {
    const ctx = this.doc.context;
    const rgb = (c) => [c[0], c[1], c[2]];
    if (stops.length === 2)
      return ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: rgb(stops[0].color), C1: rgb(stops[1].color), N: 1 }));
    const subs = [];
    for (let i = 0; i < stops.length - 1; i++)
      subs.push(ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: rgb(stops[i].color), C1: rgb(stops[i + 1].color), N: 1 })));
    const encode = [];
    for (let i = 0; i < subs.length; i++) encode.push(0, 1);
    return ctx.register(ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: subs, Bounds: stops.slice(1, -1).map((s) => s.offset), Encode: encode }));
  }

  /**
   * Command (async). Embeds each image `ref` up-front, keyed by ref for the
   * synchronous emit (the same seam as ensureFonts). A ref in `embedRefs`
   * (pdfPageEmbedRefs — a full-frame opaque `pdfpage:` page) is offered to the
   * LOSSLESS page-embed path first (pdf-lib embedPdf; keeps real vectors + text
   * + fonts); on success it registers a Form XObject and skips the raster embed.
   * Everything else embeds as an image XObject: data:/URL bytes via fetch/decode,
   * a synthetic ref via the resolveImageBytes seam. A blank/undrawable transparent
   * 1×1 (the widget's default src) — or a resolver that returns null (source not
   * yet rasterized) — maps to null (draw nothing) rather than a useless pixel.
   */
  async ensureImages(refs, embedRefs = new Set()) {
    for (const ref of refs) {
      if (this._imageXObjects.has(ref) || this._pageEmbeds.has(ref)) continue;
      // LOSSLESS page-embed first for an eligible pdf_page ref when the source
      // seam is wired and yields bytes; a null result falls through to raster.
      if (embedRefs.has(ref) && this.resolvePdfPageEmbed) {
        const embed = await this._embedPdfPage(ref);
        if (embed) { this._pageEmbeds.set(ref, embed); continue; }
      }
      const bytes = await loadImageBytes(ref, this.resolveImageBytes);
      if (bytes === null) { this._imageXObjects.set(ref, null); continue; } // resolver reported no drawable content
      // A 1×1 fully-transparent PNG (the widget's BLANK_SRC default) carries no
      // visible content — record null so emit draws nothing, matching the GPU.
      const fmt = imageFormat(bytes);
      const img = fmt === "png" ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
      if (img.width <= 1 && img.height <= 1) { this._imageXObjects.set(ref, null); continue; }
      const name = `Img${++this._imgCount}`;
      this.page.node.setXObject(PDFName.of(name), img.ref);
      this._imageXObjects.set(ref, name);
    }
  }

  /**
   * Command (async). Embeds the SOURCE page a `pdfpage:` ref points at as a
   * LOSSLESS Form XObject (pdf-lib embedPdf copies the page's content stream
   * whole — vectors, selectable text, fonts, images) and registers it on the
   * page, returning {name, width, height} (the source box in PDF points), or
   * null when the source can't be copied (the caller then rasters). The
   * resolvePdfPageEmbed seam returns {bytes, pageIndex}; a resolver null (not a
   * page-embed candidate) or an embedPdf failure (encrypted / malformed / no
   * page contents) is a REPORTED fallback to raster — never a silent drop.
   */
  async _embedPdfPage(ref) {
    const src = await this.resolvePdfPageEmbed(ref); // {bytes, pageIndex} | null
    if (!src) return null;
    try {
      const [embeddedPage] = await this.doc.embedPdf(src.bytes, [src.pageIndex]);
      const name = `Pg${++this._imgCount}`;
      this.page.node.setXObject(PDFName.of(name), embeddedPage.ref);
      return { name, width: embeddedPage.width, height: embeddedPage.height };
    } catch (e) {
      reportOncePdf(`pdf-embed:${ref}`, `pdf_backend: lossless page-embed failed for "${ref}" — falling back to a raster embed (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  }

  /** Query. The registered lossless page-embed {name, width, height} for a
   * `pdfpage:` ref, or null when the ref was not page-embedded (draw it via the
   * image XObject path instead). Never throws — a non-embedded ref is the normal
   * raster case. */
  pdfPageEmbed(ref) {
    return this._pageEmbeds.get(ref) ?? null;
  }

  /** Query. The XObject name for a pre-embedded image ref, or null for a
   * blank/undrawable src. Throws if the ref was never embedded (a bug — emit
   * only runs after ensureImages scanned the same command list). */
  imageXObject(ref) {
    if (!this._imageXObjects.has(ref))
      throw new Error(`pdf_backend: image ref "${ref}" not embedded (image op outside the scanned command list?)`);
    return this._imageXObjects.get(ref);
  }

  /**
   * Command (async). Grabs each video `ref`'s CURRENT FRAME (via the injected
   * videoFrame resolver) and embeds it as a PDF image XObject, keyed by ref for
   * the synchronous emit. Runs before the content walk — the same up-front seam
   * as ensureImages/ensureFonts. A blank/undrawable frame (the widget's default
   * transparent src, or a resolver that returns null) maps to null (draw
   * nothing) rather than embedding a useless pixel. No videoFrame resolver +
   * a video op present = a loud error (a video export needs its frame source;
   * no silent drop).
   */
  async ensureVideoFrames(refs) {
    if (refs.length === 0) return;
    if (!this.videoFrame)
      throw new Error(`pdf_backend: scene has a video op but no videoFrame resolver was provided (a video exports as its current frame — pass irToPDF opts.videoFrame)`);
    for (const ref of refs) {
      if (this._videoXObjects.has(ref)) continue;
      const frame = await this.videoFrame(ref); // {mime, bytes} | null
      if (!frame || !frame.bytes || frame.bytes.length === 0) { this._videoXObjects.set(ref, null); continue; }
      const fmt = imageFormat(frame.bytes); // trust the bytes, not the mime label
      const img = fmt === "png" ? await this.doc.embedPng(frame.bytes) : await this.doc.embedJpg(frame.bytes);
      if (img.width <= 1 && img.height <= 1) { this._videoXObjects.set(ref, null); continue; } // 1×1 = no visible content
      const name = `Vid${++this._imgCount}`;
      this.page.node.setXObject(PDFName.of(name), img.ref);
      this._videoXObjects.set(ref, name);
    }
  }

  /** Query. The XObject name for a pre-embedded video current-frame ref, or
   * null for a blank/undrawable frame. Throws if the ref was never embedded (a
   * bug — emit only runs after ensureVideoFrames scanned the same list). */
  videoXObject(ref) {
    if (!this._videoXObjects.has(ref))
      throw new Error(`pdf_backend: video ref "${ref}" not embedded (video op outside the scanned command list?)`);
    return this._videoXObjects.get(ref);
  }

  /**
   * Command (async). Embeds each distinct (fontId, bold) face the scene uses,
   * keyed for the synchronous emit. A COMMITTED font (fonts.js has a file)
   * embeds the SAME TTF the glyph atlas rasterizes — via embedFont(bytes,
   * {subset}), which needs the injected fontkit + loadFontBytes; the atlas and
   * PDF then share a face and metrics. `system` (no file), or any committed
   * font when the byte/fontkit seam is absent, falls back to standard-14
   * Helvetica/Bold (a loud warning in the latter case — a degradation, never
   * silent). Runs before the content walk (emit is sync per command).
   */
  async ensureFonts(faces) {
    for (const { font: fontId, bold } of faces) {
      const key = `${fontId}|${bold ? 1 : 0}`;
      if (this._fonts.has(key)) continue;
      const resName = fontResName(fontId, bold);
      const embedded = await this._embedFace(fontId, bold);
      this._fonts.set(key, embedded);
      this._fontNames.set(key, resName);
      this.page.node.setFontDictionary(PDFName.of(resName), embedded.ref);
    }
  }

  /** Command (async). The PDFFont for one (fontId, bold) — the committed TTF
   * when embeddable (fontkit + loadFontBytes both present), else standard-14
   * Helvetica. Command because it mutates the pdf-lib doc (embeds a font). */
  async _embedFace(fontId, bold) {
    const std = bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
    if (!hasEmbeddableFile(fontId)) return this.doc.embedFont(std); // `system` — standard-14
    const basename = fontFileFor(fontId, bold);
    if (!this.loadFontBytes) {
      console.warn(`pdf_backend: font "${fontId}" has a committed file (${basename}) but no loadFontBytes seam was provided — falling back to Helvetica (baselines/metrics will differ). Pass irToPDF opts.loadFontBytes.`);
      return this.doc.embedFont(std);
    }
    const bytes = await this.loadFontBytes(basename);
    // subset:true = embed only the glyphs actually used (small PDFs); needs the
    // fontkit registered on the doc (irToPDF opts.registerFontkit).
    return this.doc.embedFont(bytes, { subset: true });
  }

  /** Query. The embedded PDFFont for a (fontId, bold). Throws if the face was
   * never embedded (a bug — emit only runs after ensureFonts scanned the same
   * list). */
  font(fontId, bold) {
    const f = this._fonts.get(`${fontId}|${bold ? 1 : 0}`);
    if (!f) throw new Error(`pdf_backend: font "${fontId}" (${bold ? "bold" : "regular"}) not embedded (text op outside the scanned command list?)`);
    return f;
  }

  /** Query. The /resource-name for a (fontId, bold) face's Tf operator. */
  fontName(fontId, bold) {
    const n = this._fontNames.get(`${fontId}|${bold ? 1 : 0}`);
    if (!n) throw new Error(`pdf_backend: font "${fontId}" (${bold ? "bold" : "regular"}) has no resource name (not embedded?)`);
    return `/${n}`;
  }

  /** Query. Baseline offset as a fraction of font size for (fontId, bold): the
   * caller-measured canvas ascent when provided (GPU-atlas parity — see irToPDF
   * textAscent), else the embedded/standard font's own metrics. textAscent may
   * be a per-font FUNCTION (now that faces differ) or a legacy scalar. */
  ascentFraction(fontId, bold) {
    if (typeof this.textAscent === "function") return this.textAscent(fontId, bold);
    if (this.textAscent !== null) return this.textAscent;
    const embedder = this.font(fontId, bold).embedder.font;
    // Committed TTFs expose ascent/unitsPerEm (fontkit); standard-14 exposes
    // AFM Ascender (per-mille). Prefer the em-normalized TTF metric.
    if (typeof embedder.ascent === "number" && typeof embedder.unitsPerEm === "number")
      return embedder.ascent / embedder.unitsPerEm;
    if (typeof embedder.Ascender === "number") return embedder.Ascender / 1000;
    throw new Error(`pdf_backend: font "${fontId}" has no ascent metric`);
  }

  /** Query. The per-RUN measure seam the SHARED rich-text layout needs, adapting
   * the injected measureText(text, {size,bold,font,italic}) to the layout's
   * (text, runStyle) → {width, ascent, descent} contract. Injecting the SAME
   * canvas metrics the GPU atlas uses is what makes ONE layout serve both
   * backends identically. Throws if called without a seam (the text case guards
   * on ctx.measureText before ever running the rich path). */
  richMeasure() {
    if (!this.measureText) throw new Error("pdf_backend: rich text layout needs a measureText seam (irToPDF opts.measureText)");
    return (str, style) => this.measureText(str, { size: style.size ?? 36, bold: !!style.bold, font: style.font ?? DEFAULT_FONT, italic: !!style.italic });
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
   * Command (registers an ExtGState on first use). A /BM blend-mode gs op for
   * a widget blend mode (ir.js BLEND_MODES → PDF standard separable blend
   * modes: multiply → /Multiply, screen → /Screen — EXACT equivalents of the
   * GPU's fixed-function states). "normal" needs no gs (empty string, the
   * gsAlphaPair convention). "add" throws: PDF has no additive blend mode
   * (emitRegion's raster split consumes add-blend effects instead — see
   * emitEffect's loud guard).
   *
   * @example // ctx.gsBlend("multiply") → "/GSbm1 gs" (registered once)
   * @example // ctx.gsBlend("normal") → ""
   */
  gsBlend(mode) {
    if (mode === "normal") return "";
    const bm = { multiply: "Multiply", screen: "Screen" }[mode];
    if (!bm) throw new Error(`pdf_backend: no PDF blend-mode mapping for "${mode}" (add-blend effects go through the raster split)`);
    const key = `bm:${bm}`;
    if (!this._gs.has(key)) {
      const name = `GSbm${this._gs.size + 1}`;
      const dict = this.doc.context.obj({ Type: "ExtGState", BM: bm });
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
  async emitRasterRegion(rawCmds, { placeRect, srcRect = placeRect, srcView, background }, out, gs = "") {
    if (!this.rasterize)
      throw new Error("pdf_backend: scene needs a raster region (blur / deep lens / effects) but no rasterize callback was provided");
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
    // needs a -h so the top row lands at the rect's visual top. `gs` (an
    // optional ExtGState op — a /BM blend for an effected widget region,
    // gsBlend) rides inside the q/Q so it scopes to this draw only.
    const n = pdfNum;
    out.push("q", ...(gs ? [gs] : []), `${n(placeRect.w)} 0 0 ${n(-placeRect.h)} ${n(placeRect.x)} ${n(placeRect.y + placeRect.h)} cm`, `/${name} Do`, "Q");
  }

  /** Command. Registers the finished content stream on the page. */
  setContent(content) {
    const stream = this.doc.context.stream(content, {});
    this.page.node.set(PDFName.of("Contents"), this.doc.context.register(stream));
  }
}
