/**
 * PAINT -> OOXML FILL XML. Solid + linear gradient only (v1 scope; see this
 * app's task spec: "Fill/stroke: solid + linear gradient v1; everything else
 * -> nearest + report"). Reuses render_gpu/ir.js's `parsePaint` — the SAME
 * function the renderer itself uses to resolve a fill/stroke property — so
 * this module never re-derives color/gradient parsing rules, only re-emits
 * their ALREADY-RESOLVED result as XML.
 *
 * WHY THE RAW ANGLE, NOT parsePaint's DERIVED from/to (see
 * .frenzy/research_09's finding + the export research pass on
 * render_gpu/ir.js): OOXML's `<a:lin ang>` fills the shape's own bounding box
 * uniformly at a stated angle — it has no concept of PowerRP's `wavelength`/
 * `phase`/`spread` tiling, and no need for explicit endpoint coordinates the
 * way an SVG gradientTransform would. So this module reads the paint's
 * AUTHORED `angle` (degrees, before axis derivation) directly off the paint
 * object, and ignores wavelength/phase/spread/center entirely — those are
 * REPORTED as a lossy downgrade by the caller (export.js), not silently
 * dropped.
 */

import { parsePaint } from "../../render_gpu/ir.js";
import { degreesToAng60k } from "./units.js";
import { tag } from "./xml_writer.js";

/** Pure function. `[r,g,b,a]` (0..1 floats, render_gpu/ir.js's parsed color
 * shape) -> a 6-digit uppercase hex string (no leading `#`, the bare `val`
 * OOXML's `<a:srgbClr>` expects).
 *
 * @param {number[]} rgba
 * @returns {string}
 *
 * @example rgbaToHex([1, 0, 0, 1]) // "FF0000"
 * @example rgbaToHex([0, 0, 0, 0]) // "000000"
 * @example rgbaToHex([0.2, 0.4, 0.6, 1]) // "336699"
 */
export function rgbaToHex([r, g, b]) {
  const byte = (c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * Pure function. `<a:srgbClr>` for one rgba color, with a nested `<a:alpha>`
 * whenever alpha < 1 (OOXML omits `<a:alpha>` entirely for fully opaque —
 * the absent-is-100% convention every other OOXML color reader assumes).
 *
 * @param {number[]} rgba - [r,g,b,a] 0..1
 * @returns {string}
 *
 * @example srgbClrXml([1, 0, 0, 1]) // '<a:srgbClr val="FF0000"/>'
 * @example srgbClrXml([1, 0, 0, 0.5]) // '<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>'
 */
export function srgbClrXml(rgba) {
  const hex = rgbaToHex(rgba);
  const a = rgba[3] ?? 1;
  if (a >= 1) return tag("a:srgbClr", { val: hex });
  return tag("a:srgbClr", { val: hex }, tag("a:alpha", { val: Math.round(a * 100000) }));
}

/**
 * Pure function. The raw AUTHORED angle (degrees) off a paint object's linear
 * sub-state — the same field linearAxis() in render_gpu/ir.js reads before
 * deriving from/to endpoints — defaulting to 0 (rightward) per
 * GRADIENT_DEFAULT_ANGLE (core/properties.js) when absent.
 *
 * @param {object} paint - a stored gradient paint (paint.linear ?? paint holds the fields)
 * @returns {number}
 *
 * @example linearAngleOf({type: "linearGradient", linear: {angle: 45}}) // 45
 * @example linearAngleOf({type: "linearGradient", angle: 90}) // 90 (legacy inline)
 * @example linearAngleOf({type: "linearGradient"}) // 0 (default)
 */
export function linearAngleOf(paint) {
  const g = paint.linear ?? paint;
  return typeof g.angle === "number" ? g.angle : 0;
}

/**
 * Pure function. True when `paint` carries a gradient FEATURE that OOXML's
 * `<a:lin>` cannot express — wavelength != 1, phase != 0, spread != "mirror"
 * default, or a non-default center — so the caller can report a lossy
 * downgrade rather than silently rendering a plain axial gradient. Read off
 * the SAME sub-state linearAngleOf reads, before defaults are substituted, so
 * an untouched paint (which never wrote these keys) is never falsely flagged.
 *
 * @param {object} paint
 * @returns {boolean}
 *
 * @example linearHasUnexportableTiling({type: "linearGradient", linear: {angle: 0}}) // false
 * @example linearHasUnexportableTiling({type: "linearGradient", linear: {angle: 0, wavelength: 0.5}}) // true
 * @example linearHasUnexportableTiling({type: "linearGradient", linear: {angle: 0, spread: "loop"}}) // true
 */
export function linearHasUnexportableTiling(paint) {
  const g = paint.linear ?? paint;
  if (typeof g.wavelength === "number" && g.wavelength !== 1) return true;
  if (typeof g.phase === "number" && g.phase !== 0) return true;
  if (typeof g.spread === "string" && g.spread !== "mirror") return true;
  if (g.center && (g.center.x !== 0.5 || g.center.y !== 0.5)) return true;
  return false;
}

/**
 * Pure function. True when `paint` is a gradient object (linear or radial) —
 * the same predicate export.js uses to decide solid-fill vs gradient-fill XML,
 * separate from render_gpu/ir.js's internal `isGradientPaint` (not exported
 * from that module) since this only needs the two type tags this exporter
 * actually targets.
 *
 * @param {*} paint
 * @returns {boolean}
 *
 * @example isLinearOrRadialGradient({type: "linearGradient"}) // true
 * @example isLinearOrRadialGradient("#ff0000") // false
 * @example isLinearOrRadialGradient(null) // false
 */
export function isLinearOrRadialGradient(paint) {
  return !!paint && typeof paint === "object" && (paint.type === "linearGradient" || paint.type === "radialGradient");
}

/**
 * Command (throws via parsePaint on a malformed paint — never silently
 * degrades a color it cannot parse). `<a:solidFill>` XML for a plain color
 * value (hex string, rgba array, or a `{type:"solid",...}` paint object) —
 * everything parsePaint resolves to a bare `[r,g,b,a]`.
 *
 * @param {string|number[]|object} paintValue
 * @returns {string}
 *
 * @example solidFillXml("#ff0000") // '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'
 */
export function solidFillXml(paintValue) {
  const rgba = parsePaint(paintValue);
  return tag("a:solidFill", {}, srgbClrXml(rgba));
}

/**
 * Command (throws via parsePaint on a malformed gradient). `<a:gradFill>` XML
 * for a linear gradient: `<a:gsLst>` (stop list, `pos` 0..100000) +
 * `<a:lin ang scaled="1">` from the paint's AUTHORED angle. `report`, if
 * given, is pushed a downgrade note when the paint carries tiling OOXML
 * cannot express (see linearHasUnexportableTiling) — the fill is still
 * emitted (a plain axial gradient, closest-available per the app's
 * extensibility law), just not byte-identical to the on-screen picture.
 *
 * @param {object} paint - a stored linearGradient paint
 * @param {string} where - "slide N, shape "X"" — context for the report line
 * @param {string[]} [report] - mutated: pushed a line iff tiling is lossy
 * @returns {string}
 */
export function linearGradFillXml(paint, where, report) {
  const parsed = parsePaint(paint); // {type, stops:[{offset,color}], from, to, ...}
  if (report && linearHasUnexportableTiling(paint))
    report.push(`${where}: linear gradient uses wavelength/phase/spread/center — OOXML <a:lin> has no tiling concept, exported as a plain axial gradient (nearest available)`);
  const angle = linearAngleOf(paint);
  const gsLst = parsed.stops
    .map((s) => tag("a:gs", { pos: Math.round(Math.max(0, Math.min(1, s.offset)) * 100000) }, srgbClrXml(s.color)))
    .join("");
  return tag("a:gradFill", {}, tag("a:gsLst", {}, gsLst) + tag("a:lin", { ang: degreesToAng60k(angle), scaled: "1" }));
}

/**
 * Command (throws via parsePaint on a malformed paint; delegates to
 * solidFillXml/linearGradFillXml). THE fill-XML dispatcher a shape builder
 * calls: null/undefined -> "" (no `<a:solidFill>` at all, i.e. no fill —
 * OOXML's own "absent means unfilled" convention, matching PowerRP's `null`
 * paint), radial/material/crossfade/etc -> nearest-solid + a report line
 * (v1 scope is solid + linear only; report.js's caller decides the message
 * format, this just resolves to SOMETHING renderable).
 *
 * @param {*} paintValue
 * @param {string} where
 * @param {string[]} [report]
 * @returns {string} `<a:solidFill>…` / `<a:gradFill>…` / "" (no fill element)
 */
export function fillXml(paintValue, where, report) {
  if (paintValue === null || paintValue === undefined) return "";
  if (isLinearOrRadialGradient(paintValue)) {
    if (paintValue.type === "linearGradient") return linearGradFillXml(paintValue, where, report);
    // Radial: not in v1 scope (task spec: "solid + linear gradient v1").
    // Downgrade to the gradient's own first stop's color (a representative
    // solid) rather than throwing — a slide with a radial-filled shape should
    // still open with SOMETHING the right rough color, not crash the export.
    if (report) report.push(`${where}: radial gradient fill — not supported in v1 export, downgraded to its first stop's solid color`);
    const parsed = parsePaint(paintValue);
    return tag("a:solidFill", {}, srgbClrXml(parsed.stops[0]?.color ?? [0, 0, 0, 1]));
  }
  // Anything else parsePaint resolves to a bare color (material/etc. would
  // throw inside parsePaint itself if truly unparseable, which is the correct
  // loud failure for a paint this exporter cannot even identify).
  return solidFillXml(paintValue);
}
