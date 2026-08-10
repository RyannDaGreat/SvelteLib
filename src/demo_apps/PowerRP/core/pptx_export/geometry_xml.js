/**
 * GEOMETRY -> <a:prstGeom> / <a:custGeom>. There is no `pptxPreset` annotation
 * anywhere in plugins/ (confirmed by grep before writing this module) — this
 * file is the FIRST place PowerRP widget types get mapped to OOXML preset
 * names, informed by core/pptx/preset_shape_defs.json's vendored 187-name
 * table (the importer's geometry-resolution vocabulary; reused here only for
 * NAME/ADJUSTMENT-SHAPE consistency, not for its evaluator).
 *
 * v1 SCOPE (task spec): rect/box family -> prstGeom (rect or roundRect,
 * adjustment values round-tripped exactly for the ones this module maps);
 * ellipse/circle -> prstGeom "ellipse"; polygon (straight-edge point list) ->
 * custGeom. Everything else is the caller's (export.js) job to placeholder.
 */

import { tag } from "./xml_writer.js";

/** roundRect's ONE adjustment guide is `adj`, in 1/100000ths of `ss` (the
 * shape's shorter side, min(w,h)) — read directly off
 * core/pptx/preset_shape_defs.json's "roundRect" entry (`"pin 0 adj 50000"`,
 * scaled against `ss`) so this exporter's adjustment math matches exactly what
 * the importer's own preset evaluator assumes for the same preset name. */
const ROUND_RECT_ADJ_DIVISOR = 100000;

/**
 * Pure function. `<a:prstGeom>` for a rect-family shape: plain "rect" when
 * `cornerRadius` is 0 (or absent), else "roundRect" with its `adj` guide set
 * so the rendered corner radius round-trips EXACTLY (the task spec's "map
 * back adjust values where the widget is a preset-mapped one" requirement).
 * `adj` is clamped to roundRect's own valid range (0..50000 — the ahLst bound
 * in preset_shape_defs.json) since a cornerRadius past half the shorter side
 * is already visually clamped by PowerRP's own renderer (core/svg_paths.js
 * rectPathD: `RX = Math.min(RX, w/2)`), so this mirrors that clamp rather than
 * emitting an out-of-range guide PowerPoint would reject.
 *
 * @param {number} w - local box width (px, already positive)
 * @param {number} h - local box height (px, already positive)
 * @param {number} cornerRadius - px
 * @returns {string}
 *
 * @example rectPrstGeomXml(100, 50, 0) // '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
 * @example rectPrstGeomXml(100, 100, 25) // '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>'
 */
export function rectPrstGeomXml(w, h, cornerRadius) {
  if (!(cornerRadius > 0)) return tag("a:prstGeom", { prst: "rect" }, tag("a:avLst"));
  const shortSide = Math.min(w, h);
  const adjRaw = shortSide > 0 ? (cornerRadius / shortSide) * ROUND_RECT_ADJ_DIVISOR : 0;
  const adj = Math.max(0, Math.min(50000, Math.round(adjRaw)));
  return tag("a:prstGeom", { prst: "roundRect" }, tag("a:avLst", {}, tag("a:gd", { name: "adj", fmla: `val ${adj}` })));
}

/** `<a:prstGeom prst="ellipse">` — an ellipse/circle widget has no adjustment
 * guides (its shape IS w/h, per plugins/circle.js's own header: "A circle has
 * NO geometry knob"). */
export function ellipsePrstGeomXml() {
  return tag("a:prstGeom", { prst: "ellipse" }, tag("a:avLst"));
}

/**
 * Pure function. `<a:custGeom>` for a closed or open straight-edge polyline in
 * LOCAL box-fraction coordinates (plugins/polygon.js's own `points` shape:
 * `[[x,y],...]`, 0..1 nominal, NOT clamped). Scaled to the shape's own EMU
 * extent (`<a:path w= h=>` — OOXML custGeom paths declare their OWN coordinate
 * space, independent of the enclosing xfrm's ext, so a path authored at
 * `w=extEmuW h=extEmuH` maps 1:1 onto the shape's bounding box with no extra
 * scale transform needed).
 *
 * @param {number[][]} points - [[x,y],...] box fractions
 * @param {boolean} closed
 * @param {number} extEmuW - the shape's own EMU width (the path's coordinate space)
 * @param {number} extEmuH - the shape's own EMU height
 * @returns {string}
 *
 * @example polygonCustGeomXml([[0,0],[1,0],[0.5,1]], true, 1000, 1000).includes('<a:close/>') // true
 * @example polygonCustGeomXml([[0,0],[1,1]], false, 1000, 1000).includes('<a:close/>') // false
 */
export function polygonCustGeomXml(points, closed, extEmuW, extEmuH) {
  if (points.length === 0) return tag("a:custGeom", {}, tag("a:pathLst"));
  const px = (frac) => Math.round(frac * extEmuW);
  const py = (frac) => Math.round(frac * extEmuH);
  const [first, ...rest] = points;
  let body = tag("a:moveTo", {}, tag("a:pt", { x: px(first[0]), y: py(first[1]) }));
  for (const [x, y] of rest) body += tag("a:lnTo", {}, tag("a:pt", { x: px(x), y: py(y) }));
  if (closed) body += tag("a:close");
  const pathAttrs = { w: extEmuW, h: extEmuH, fill: "norm" };
  return tag(
    "a:custGeom",
    {},
    tag("a:avLst") + tag("a:gdLst") + tag("a:ahLst") + tag("a:cxnLst") + tag("a:rect", { l: 0, t: 0, r: extEmuW, b: extEmuH }) + tag("a:pathLst", {}, tag("a:path", pathAttrs, body)),
  );
}
