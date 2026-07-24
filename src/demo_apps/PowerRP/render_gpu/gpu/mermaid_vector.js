/**
 * MERMAID SVG → TRUE-VECTOR FLATTEN (the DOM-facing adapter). Turns a RENDERED,
 * document-attached Mermaid `<svg>` element into a flat list of vector `paths`
 * (viewBox-space `d` strings + solid paint) and `texts` (positioned label runs),
 * so the mermaid widget renders as crisp vector at any zoom instead of a bitmap
 * that pixelates — the mermaid analog of render_gpu/gpu/latex_raster.js's
 * resolveLatexGlyphs (its direct template; read that for the shared reasoning).
 *
 * ── WHY DOM-BASED, NOT the pure core/svg_paths flatten alone ──────────────────
 * core/svg_paths.js `flattenSvgTree` reads PRESENTATION ATTRIBUTES (fill=, stroke=)
 * and bakes element `transform=` attributes. A Mermaid SVG carries NEITHER: its
 * fills/strokes live in a scoped `<style>` block + CSS classes + inline `style=`,
 * and its node/edge placement is in `transform` attributes the browser has
 * already composed. So this adapter resolves each element's PAINT via
 * getComputedStyle and its GEOMETRY via getScreenCTM (the resolveLatexGlyphs
 * technique — REQUIRES the SVG be attached to the document, or the CTMs are null)
 * — but it REUSES core/svg_paths.js for all the geometry math: elementToPathD
 * (shape→`d`), transformPathD (bake a CTM into a `d`), matScale/matMul. It never
 * reinvents SVG path parsing (the task rule); it only supplies the paint + CTM
 * that the CSS-styled Mermaid tree hides from the attribute-only pure flatten.
 *
 * ── COORDINATE FRAME ──────────────────────────────────────────────────────────
 * Everything is emitted in the SVG ROOT VIEWBOX frame (y-DOWN, as drawn): for an
 * element E, m = rootInv · E.getScreenCTM() maps E-local → viewBox, INVARIANT to
 * the svg's on-screen pixel size (both CTMs scale identically), exactly like
 * resolveLatexGlyphs. The consumer (plugins/mermaid.js → the mermaidVector IR op
 * → render_gpu/skia/paint_skia.drawMermaidVector) maps viewBox → the widget box
 * with ONE fitBox scale (preserveAspect) — mirroring latexVector.
 *
 * ── MARKERS (arrowheads) ──────────────────────────────────────────────────────
 * Mermaid arrowheads are `<marker>` DEFS instanced via marker-end/marker-start on
 * edge paths — not real DOM elements, so getScreenCTM cannot reach them. Each is
 * reconstructed by the SVG marker-placement rule from the def's OWN attributes
 * (viewBox, refX/refY, markerWidth/Height, orient, markerUnits) + the edge's
 * endpoint & tangent (read from the already-baked viewBox-space `d`). No magic
 * numbers — every value is spec-defined or read from the def.
 *
 * ── LOUD, NO SILENT FALLBACK ──────────────────────────────────────────────────
 * A `<foreignObject>` (some non-flowchart diagram types still emit HTML labels
 * regardless of htmlLabels:false) CANNOT be vectorized → the flatten returns
 * `{unflattenable:true, reason}` so the caller rasterizes AND warns loudly (the
 * task's "keep raster only as a fallback, warn LOUDLY" rule). Per-element failures
 * (an unsupported arc, an unparseable color) are collected in `warnings` (the
 * caller reports them once) and that one element is skipped — never a silent drop.
 */

import { elementToPathD, transformPathD, matScale, matMul, tokenizePathD } from "../../core/svg_paths.js";

/** Bold threshold: a CSS font-weight >= this renders with the bold face (400 =
 * regular, 700 = bold; 600 is the conventional "semibold and up is bold" cut). */
const BOLD_WEIGHT = 600;

/** The IR text-op font id whose face (render_gpu/fonts.js "inter" → "PowerRP
 * Inter") equals the family Mermaid is pinned to and measures labels against
 * (web/mermaidRenderer.MERMAID_FONT_FAMILY) — so vector label metrics match the
 * layout Mermaid computed. */
const MERMAID_TEXT_FONT = "inter";

/** Geometry element tags this flatten renders (everything else — <g>, <text>,
 * <marker>, <defs> — is handled separately or skipped). */
const SHAPE_TAGS = "path, rect, circle, ellipse, polygon, polyline, line";

/** Ancestor tags that DEFINE (don't draw): an element inside one is a template /
 * clip / mask, never rendered directly, so it is skipped by the shape/text walk. */
const NON_RENDERING_ANCESTORS = "defs, marker, clipPath, mask, pattern, symbol, filter";

/**
 * Pure function. A browser DOMMatrix (or SVGMatrix) → the plain {a,b,c,d,e,f}
 * affine core/svg_paths.js transformPathD/matScale consume.
 *
 * @example domMatrixToMat({a: 2, b: 0, c: 0, d: 2, e: 5, f: 6}) // {a: 2, b: 0, c: 0, d: 2, e: 5, f: 6}
 */
export function domMatrixToMat(dm) {
  return { a: dm.a, b: dm.b, c: dm.c, d: dm.d, e: dm.e, f: dm.f };
}

/**
 * Pure function. Resolves a CSS computed paint value to a PowerRP path-op paint:
 * a CSS color STRING (solid) kept verbatim, or null for "none"/absent. A value
 * this v1 cannot render as a solid (a url(#gradient), currentColor left
 * unresolved) is recorded in `warnings` and returns null rather than throwing —
 * the element still draws its other paint (fill or stroke), never a silent lie.
 *
 * Args:
 *   css (string): a getComputedStyle fill/stroke value ("rgb(51,51,51)", "none", "url(...)")
 *   warnings (Set<string>): dedup accumulator for loud punt notices
 *
 * Returns:
 *   string | null
 *
 * @example resolveComputedPaint("rgb(51, 51, 51)", new Set()) // "rgb(51, 51, 51)"
 * @example resolveComputedPaint("none", new Set()) // null
 * @example resolveComputedPaint("", new Set()) // null
 */
export function resolveComputedPaint(css, warnings) {
  const v = (css ?? "").trim();
  if (v === "" || v === "none") return null;
  if (/^(#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(v)) return v;
  // A named color (e.g. "black") is also a valid CSS color parseColor accepts via
  // rgb()? No — getComputedStyle normalizes named colors to rgb(), so anything
  // NOT matching the forms above is a url()/currentColor/paint we cannot flatten.
  warnings.add(`mermaid: unsupported computed paint "${v.slice(0, 32)}" (v1 flattens solid colors only) — element drawn without it`);
  return null;
}

/**
 * Pure function. The final on-curve point of an ABSOLUTE `d` (only M/L/H/V/C/Q/Z,
 * as produced by transformPathD) and the reference point just before it, so a
 * consumer can take the end TANGENT as end−ref. For a cubic the ref is the second
 * control point; for a quad the control; for a line/Z the previous on-curve point.
 * Returns null for a `d` with no drawable end (a lone moveto).
 *
 * Args:
 *   d (string): an absolute-coordinate SVG path (transformPathD output)
 *
 * Returns:
 *   {end: {x, y}, ref: {x, y}} | null
 *
 * @example pathEndTangent("M0 0L10 0") // {end: {x: 10, y: 0}, ref: {x: 0, y: 0}}
 * @example pathEndTangent("M0 0C1 2 3 4 5 6").end // {x: 5, y: 6}
 * @example pathEndTangent("M0 0C1 2 3 4 5 6").ref // {x: 3, y: 4}
 */
export function pathEndTangent(d) {
  const toks = tokenizePathD(d);
  let cx = 0, cy = 0, sx = 0, sy = 0;   // current point + subpath start
  let end = null, ref = null;
  let i = 0;
  while (i < toks.length) {
    const cmd = toks[i++];
    const C = String(cmd).toUpperCase();
    if (C === "M") {
      let first = true;
      while (typeof toks[i] === "number") {
        const px = toks[i++], py = toks[i++];
        if (first) { sx = px; sy = py; first = false; } else { ref = { x: cx, y: cy }; end = { x: px, y: py }; }
        cx = px; cy = py;
      }
    } else if (C === "L") {
      while (typeof toks[i] === "number") { ref = { x: cx, y: cy }; cx = toks[i++]; cy = toks[i++]; end = { x: cx, y: cy }; }
    } else if (C === "H") {
      while (typeof toks[i] === "number") { ref = { x: cx, y: cy }; cx = toks[i++]; end = { x: cx, y: cy }; }
    } else if (C === "V") {
      while (typeof toks[i] === "number") { ref = { x: cx, y: cy }; cy = toks[i++]; end = { x: cx, y: cy }; }
    } else if (C === "C") {
      while (typeof toks[i] === "number") { const x1 = toks[i++], y1 = toks[i++], x2 = toks[i++], y2 = toks[i++], ex = toks[i++], ey = toks[i++]; ref = { x: x2, y: y2 }; end = { x: ex, y: ey }; cx = ex; cy = ey; void x1; void y1; }
    } else if (C === "Q") {
      while (typeof toks[i] === "number") { const x1 = toks[i++], y1 = toks[i++], ex = toks[i++], ey = toks[i++]; ref = { x: x1, y: y1 }; end = { x: ex, y: ey }; cx = ex; cy = ey; }
    } else if (C === "Z") {
      ref = { x: cx, y: cy }; end = { x: sx, y: sy }; cx = sx; cy = sy;
    } else {
      break; // unknown/unsupported (e.g. S/T not emitted by transformPathD end-use) — stop
    }
  }
  return end && ref ? { end, ref } : null;
}

/**
 * Pure function. The affine that maps a marker's own content (viewBox) coords into
 * the SVG root viewBox frame at a placed vertex — the SVG marker-placement rule:
 * translate(vertex) · rotate(angle) · scale(mw/vbW, mh/vbH) · translate(−refX,−refY),
 * with an extra ×strokeWidth on the scale when markerUnits is "strokeWidth". The
 * reference point (refX,refY) therefore lands exactly on the vertex, oriented
 * along `angleRad` (orient="auto").
 *
 * Args:
 *   def ({vbW, vbH, mw, mh, refX, refY, strokeScale}): marker def geometry (strokeScale
 *     = the edge stroke width for markerUnits "strokeWidth", else 1)
 *   vx, vy (number): the vertex (viewBox space) the marker's ref point aligns to
 *   angleRad (number): orientation (path tangent) in radians
 *
 * Returns:
 *   {a,b,c,d,e,f}: the composed affine (core/svg_paths matMul convention)
 *
 * @example markerPlacementMatrix({vbW: 10, vbH: 10, mw: 8, mh: 8, refX: 5, refY: 5, strokeScale: 1}, 100, 50, 0) // {a: 0.8, b: 0, c: 0, d: 0.8, e: 96, f: 46}
 */
export function markerPlacementMatrix(def, vx, vy, angleRad) {
  const s = def.strokeScale ?? 1;
  const sx = (def.mw / def.vbW) * s;
  const sy = (def.mh / def.vbH) * s;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  const T = { a: 1, b: 0, c: 0, d: 1, e: vx, f: vy };
  const R = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  const S = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
  const Tref = { a: 1, b: 0, c: 0, d: 1, e: -def.refX, f: -def.refY };
  return matMul(matMul(matMul(T, R), S), Tref);
}

/** Query. A DOM element's attributes as a plain {name: value} object — the shape
 * core/svg_paths.elementToPathD consumes. */
function attrsOf(el) {
  const out = {};
  for (const a of el.attributes) out[a.name] = a.value;
  return out;
}

/** Query (DOM). The marker `<marker>` def referenced by a computed marker value
 * ("url(\"#id\")"), parsed into the geometry markerPlacementMatrix needs + its
 * child shape (the arrowhead), or null if the value is "none" / the def or its
 * child is missing (skipped, not faked). */
function resolveMarkerDef(svg, cssMarker) {
  const m = /url\(\s*["']?#([^)"']+)["']?\s*\)/.exec(cssMarker ?? "");
  if (!m) return null;
  const def = svg.querySelector(`marker[id="${CSS.escape(m[1])}"]`);
  if (!def) return null;
  const child = def.querySelector("path, polygon, polyline, rect, circle, ellipse, line");
  if (!child) return null;
  const vb = (def.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(def.getAttribute("markerWidth") || "3");
  const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(def.getAttribute("markerHeight") || "3");
  return {
    child,
    vbW, vbH,
    mw: parseFloat(def.getAttribute("markerWidth") || "3"),
    mh: parseFloat(def.getAttribute("markerHeight") || "3"),
    refX: parseFloat(def.getAttribute("refX") || "0"),
    refY: parseFloat(def.getAttribute("refY") || "0"),
    orient: def.getAttribute("orient") || "0",
    units: def.getAttribute("markerUnits") || "strokeWidth",
  };
}

/** Query (DOM). Builds the arrowhead path ops for one edge element's markers
 * (marker-start + marker-end), each placed at the edge's start/end vertex,
 * oriented along the path tangent, in viewBox space. `dVB` is the edge's already
 * baked viewBox-space `d`. Returns [] when the edge has no resolvable markers. */
function markerPathsFor(svg, el, dVB, strokeWidth, warnings) {
  const cs = getComputedStyle(el);
  const geom = pathEndTangent(dVB);
  if (!geom) return [];
  const out = [];
  const place = (def, vx, vy, angleRad) => {
    const d0 = elementToPathD(def.child.tagName.toLowerCase(), attrsOf(def.child));
    if (d0 === null) { warnings.add(`mermaid: marker child <${def.child.tagName.toLowerCase()}> not flattenable — arrowhead skipped`); return; }
    const strokeScale = def.units === "strokeWidth" ? (strokeWidth > 0 ? strokeWidth : 1) : 1;
    const m = markerPlacementMatrix({ ...def, strokeScale }, vx, vy, angleRad);
    const dm = transformPathD(d0, m);
    const mcs = getComputedStyle(def.child);
    out.push({
      d: dm,
      fill: resolveComputedPaint(mcs.fill, warnings),
      stroke: resolveComputedPaint(mcs.stroke, warnings),
      strokeWidth: parseFloat(mcs.strokeWidth) || 0,
      fillRule: mcs.fillRule === "evenodd" ? "evenodd" : "nonzero",
      opacity: clampOpacity(mcs.opacity),
    });
  };
  const endDef = resolveMarkerDef(svg, cs.markerEnd);
  if (endDef) {
    const angle = orientAngle(endDef.orient, Math.atan2(geom.end.y - geom.ref.y, geom.end.x - geom.ref.x), false);
    place(endDef, geom.end.x, geom.end.y, angle);
  }
  const startDef = resolveMarkerDef(svg, cs.markerStart);
  if (startDef) {
    // marker-start orients along the path LEAVING the first vertex; the tangent
    // there is the start→ref direction reversed to point back along the incoming
    // convention (auto-start-reverse flips it a further 180°, per spec).
    const g0 = pathStartTangent(dVB);
    if (g0) {
      const angle = orientAngle(startDef.orient, Math.atan2(g0.next.y - g0.start.y, g0.next.x - g0.start.x), true);
      place(startDef, g0.start.x, g0.start.y, angle);
    }
  }
  return out;
}

/** Pure function. The first on-curve point of an absolute `d` and the next
 * on-curve point after it (for the start tangent). null for a `d` with < 2 points.
 *
 * @example pathStartTangent("M0 0L10 0") // {start: {x: 0, y: 0}, next: {x: 10, y: 0}}
 */
export function pathStartTangent(d) {
  const toks = tokenizePathD(d);
  const pts = [];
  let i = 0, cx = 0, cy = 0;
  while (i < toks.length && pts.length < 2) {
    const C = String(toks[i++]).toUpperCase();
    if (C === "M" || C === "L") { while (typeof toks[i] === "number" && pts.length < 2) { cx = toks[i++]; cy = toks[i++]; pts.push({ x: cx, y: cy }); } }
    else if (C === "H") { while (typeof toks[i] === "number" && pts.length < 2) { cx = toks[i++]; pts.push({ x: cx, y: cy }); } }
    else if (C === "V") { while (typeof toks[i] === "number" && pts.length < 2) { cy = toks[i++]; pts.push({ x: cx, y: cy }); } }
    else if (C === "C") { while (typeof toks[i] === "number" && pts.length < 2) { toks[i++]; toks[i++]; toks[i++]; toks[i++]; cx = toks[i++]; cy = toks[i++]; pts.push({ x: cx, y: cy }); } }
    else if (C === "Q") { while (typeof toks[i] === "number" && pts.length < 2) { toks[i++]; toks[i++]; cx = toks[i++]; cy = toks[i++]; pts.push({ x: cx, y: cy }); } }
    else break;
  }
  return pts.length >= 2 ? { start: pts[0], next: pts[1] } : null;
}

/** Pure function. Resolves a marker `orient` value to an angle in radians: "auto"
 * / "auto-start-reverse" use the path tangent (`autoRad`, +180° for the reversed
 * start case), a numeric value is degrees→radians.
 *
 * @example orientAngle("auto", 0, false) // 0
 * @example orientAngle("auto-start-reverse", 0, true) // Math.PI
 * @example orientAngle("90", 0, false) // Math.PI / 2
 */
export function orientAngle(orient, autoRad, isStart) {
  const o = String(orient).trim();
  if (o === "auto") return autoRad;
  if (o === "auto-start-reverse") return isStart ? autoRad + Math.PI : autoRad;
  const deg = parseFloat(o);
  return Number.isFinite(deg) ? (deg * Math.PI) / 180 : autoRad;
}

/** Pure function. Clamp a CSS opacity string to [0,1], defaulting to 1. */
function clampOpacity(css) {
  const v = parseFloat(css);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/**
 * Query (browser/CLI — reads SVG geometry + computed styles via the DOM). THE
 * flatten: a RENDERED, document-ATTACHED Mermaid `<svg>` → its vector content in
 * the root viewBox frame. Reuses core/svg_paths.js for every geometry step;
 * supplies paint from getComputedStyle and transforms from getScreenCTM.
 *
 * Args:
 *   svg (SVGSVGElement): a Mermaid SVG root, ATTACHED to the document (getScreenCTM
 *     / getBBox / getComputedStyle return null/garbage on a detached node)
 *
 * Returns:
 *   {
 *     paths: [{d, fill, stroke, strokeWidth, fillRule, opacity}],  // viewBox space
 *     texts: [{text, x, y, size, color, bold, font}],              // viewBox space, top-left
 *     viewBox: {minX, minY, w, h},
 *     warnings: string[],
 *     unflattenable: boolean, reason?: string
 *   }
 */
export function flattenMermaidSvg(svg) {
  const warnings = new Set();
  if (svg.querySelector("foreignObject"))
    return { paths: [], texts: [], viewBox: rootViewBox(svg), warnings: [], unflattenable: true, reason: "diagram uses <foreignObject> HTML labels (not vectorizable)" };

  const rootCTM = svg.getScreenCTM();
  if (!rootCTM) return { paths: [], texts: [], viewBox: rootViewBox(svg), warnings: [], unflattenable: true, reason: "SVG has no screen CTM (must be attached to the document)" };
  const rootInv = rootCTM.inverse();
  const viewBox = rootViewBox(svg);

  const paths = [];
  for (const el of svg.querySelectorAll(SHAPE_TAGS)) {
    if (el.closest(NON_RENDERING_ANCESTORS)) continue; // marker/def/clip template — skipped
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const fill = resolveComputedPaint(cs.fill, warnings);
    const stroke = resolveComputedPaint(cs.stroke, warnings);
    let d0;
    try {
      d0 = elementToPathD(el.tagName.toLowerCase(), attrsOf(el));
    } catch (e) {
      warnings.add(`mermaid: <${el.tagName.toLowerCase()}> geometry not flattenable (${e instanceof Error ? e.message : e}) — skipped`);
      continue;
    }
    if (d0 === null) continue; // a non-shape element (no geometry)
    const elCTM = el.getScreenCTM();
    if (!elCTM) continue;
    const m = domMatrixToMat(rootInv.multiply(elCTM));
    let dVB;
    try {
      dVB = transformPathD(d0, m);
    } catch (e) {
      warnings.add(`mermaid: <${el.tagName.toLowerCase()}> path could not be baked (${e instanceof Error ? e.message : e}) — skipped`);
      continue;
    }
    const strokeWidth = (parseFloat(cs.strokeWidth) || 0) * matScale(m);
    if (fill !== null || (stroke !== null && strokeWidth > 0)) {
      paths.push({
        d: dVB,
        fill, stroke,
        strokeWidth: stroke !== null ? strokeWidth : 0,
        fillRule: cs.fillRule === "evenodd" ? "evenodd" : "nonzero",
        opacity: clampOpacity(cs.opacity),
      });
    }
    // Instanced arrowhead markers draw ON TOP of their edge (appended after it).
    for (const mp of markerPathsFor(svg, el, dVB, strokeWidth, warnings)) paths.push(mp);
  }

  const texts = [];
  for (const el of svg.querySelectorAll("text")) {
    if (el.closest(NON_RENDERING_ANCESTORS)) continue;
    const content = el.textContent ?? "";
    if (content.trim() === "") continue; // empty / measurement-only text
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const elCTM = el.getScreenCTM();
    if (!elCTM) continue;
    const m = domMatrixToMat(rootInv.multiply(elCTM));
    let bbox;
    try {
      bbox = el.getBBox();
    } catch {
      continue; // a text node the browser can't measure (detached / zero-metric) — skip
    }
    // Top-left of the RENDERED glyph box (getBBox already accounts for
    // text-anchor:middle/end centering), mapped local → viewBox.
    const x = m.a * bbox.x + m.c * bbox.y + m.e;
    const y = m.b * bbox.x + m.d * bbox.y + m.f;
    const color = resolveComputedPaint(cs.fill, warnings) ?? "#000000";
    texts.push({
      text: content,
      x, y,
      size: (parseFloat(cs.fontSize) || 16) * matScale(m),
      color,
      bold: (parseInt(cs.fontWeight, 10) || 400) >= BOLD_WEIGHT,
      font: MERMAID_TEXT_FONT,
    });
  }

  if (paths.length === 0 && texts.length === 0)
    return { paths, texts, viewBox, warnings: [...warnings], unflattenable: true, reason: "flatten produced no drawable geometry" };
  return { paths, texts, viewBox, warnings: [...warnings], unflattenable: false };
}

/** Pure-ish query. The SVG root viewBox {minX,minY,w,h} (falls back to a unit box
 * so a degenerate SVG still has a valid frame — the caller has already sized the
 * raster from svgNaturalSize; this only frames the vector coords). */
function rootViewBox(svg) {
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { minX: vb[0], minY: vb[1], w: vb[2], h: vb[3] };
  const w = parseFloat(svg.getAttribute("width") || "");
  const h = parseFloat(svg.getAttribute("height") || "");
  if (w > 0 && h > 0) return { minX: 0, minY: 0, w, h };
  return { minX: 0, minY: 0, w: 1, h: 1 };
}
