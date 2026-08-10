/**
 * SHAPE GEOMETRY — DeckIR `geometry` (`{preset:{name,adjustments}}` or
 * `{custGeom}`) -> the PowerRP widget TYPE + geometry-specific state leaves,
 * per the mapping spec §3 verdicts:
 *   - `rect`/`roundRect` -> `plugins/rect.js` (DIRECT; roundRect's `adj`
 *     fraction-of-shorter-side -> `cornerRadius` absolute canvas units).
 *   - `ellipse` -> `plugins/circle.js` (DIRECT).
 *   - every other of the ~185 named presets -> `type: "pptxPreset"`, state
 *     `{preset, adj}` — the parametric-handle widget being built in parallel
 *     (task brief: "that plugin is being built in parallel"). NOT baked to a
 *     frozen path (user ruling, request 20: presets stay parametric).
 *   - `custGeom` -> the `svg` widget, baked via
 *     core/pptx/preset_geometry.custGeomPath (genuinely non-parametric per
 *     the mapping spec, so baking is correct here specifically).
 */

import { presetShapePath, custGeomPath } from "../pptx/preset_geometry.js";

/** Presets with an existing 1:1 PowerRP native widget (mapping spec §3
 * DIRECT rows). Every other preset name routes to "pptxPreset". */
const DIRECT_PRESET_WIDGETS = { rect: "rect", roundRect: "rect", ellipse: "circle" };

/**
 * Pure function. `roundRect`'s adjustment guide (a FRACTION of the shape's
 * shorter side, PowerPoint's own `adj` convention, in 1/100000ths per
 * ECMA-376 `fmla="val N"`) -> PowerRP's absolute-canvas-unit `cornerRadius`.
 * Absent `adj` uses PowerPoint's own default (16667 / 100000 ≈ 1/6).
 *
 * @param {Record<string,number>} adjustments - ShapeIR geometry.preset.adjustments
 * @param {number} wPx
 * @param {number} hPx
 * @returns {number}
 *
 * @example roundRectCornerRadiusPx({}, 100, 50) // 8.3335 (default adj 16667/100000 of the shorter side 50)
 * @example roundRectCornerRadiusPx({adj: 50000}, 100, 50) // 25
 */
export function roundRectCornerRadiusPx(adjustments, wPx, hPx) {
  const adjFraction = (adjustments.adj ?? 16667) / 100000;
  return adjFraction * Math.min(wPx, hPx);
}

/**
 * Pure function. Classify a DeckIR shape's geometry into a translation
 * plan — the widget `type` to emit plus any geometry-specific state leaves
 * and refusal. `wPx`/`hPx` are the shape's already-EMU-converted box size
 * (roundRect's corner radius needs them; other presets don't).
 *
 * @param {{preset:{name:string,adjustments:object}}|{custGeom:object}|null} geometryIR
 * @param {number} wPx
 * @param {number} hPx
 * @param {{fillHex:string|null, strokeHex:string|null}} paints - resolved shape fill/stroke, baked into custGeom SVG markup literally (see custGeomToSvgSrc)
 * @returns {{widgetType: string, extraState: object, refusal: string|null}}
 *
 * @example classifyGeometry({preset:{name:"rect", adjustments:{}}}, 100, 50, {}).widgetType // "rect"
 * @example classifyGeometry({preset:{name:"ellipse", adjustments:{}}}, 100, 50, {}).widgetType // "circle"
 * @example classifyGeometry({preset:{name:"star5", adjustments:{}}}, 100, 50, {}).widgetType // "pptxPreset"
 * @example classifyGeometry(null, 100, 50, {}).widgetType // "rect" (no geometry element at all — PPTX's own implied-rect default, e.g. a plain picture/textbox frame)
 */
export function classifyGeometry(geometryIR, wPx, hPx, paints = {}) {
  if (!geometryIR) return { widgetType: "rect", extraState: {}, refusal: null };
  if (geometryIR.preset) {
    const { name, adjustments } = geometryIR.preset;
    const widgetType = DIRECT_PRESET_WIDGETS[name];
    if (widgetType === "rect") {
      const extraState = name === "roundRect" ? { cornerRadius: roundRectCornerRadiusPx(adjustments, wPx, hPx) } : {};
      return { widgetType, extraState, refusal: null };
    }
    if (widgetType === "circle") return { widgetType, extraState: {}, refusal: null };
    // Every other preset -> the parametric preset widget (pending in
    // parallel — see this file's header). Verify the name is one this
    // repo's vendored table actually knows, so an unrecognized `prst` (a
    // future ECMA-376 revision, a typo'd deck) is reported rather than
    // silently handed to a widget that will fail to resolve it.
    let known = true;
    try {
      presetShapePath(name, adjustments, Math.max(wPx, 1), Math.max(hPx, 1));
    } catch {
      known = false;
    }
    return {
      widgetType: "pptxPreset",
      extraState: { preset: name, adj: adjustments },
      refusal: known ? null : `preset shape "${name}" is not in the vendored preset-geometry table — the pptxPreset widget will not be able to resolve its outline`,
    };
  }
  if (geometryIR.custGeom) {
    // custGeomPath THROWS on a pathLst-less custGeom (its own documented
    // contract) — a legal-but-degenerate real-world shape (measured on the
    // real deck: a custGeom element present with no <a:pathLst> at all,
    // e.g. an author-cleared freeform). Caught here specifically (a known,
    // expected condition per this app's "no silent guessing" rule, not
    // ignorance of the function's contract) so one degenerate shape never
    // aborts the whole deck's translation.
    let subpaths;
    try {
      ({ subpaths } = custGeomPath(geometryIR.custGeom, Math.max(wPx, 1), Math.max(hPx, 1)));
    } catch (e) {
      return { widgetType: "rect", extraState: {}, refusal: `custGeom shape could not be resolved to a path (${e.message}) — rendered as a plain rect` };
    }
    const svgSrc = custGeomToSvgSrc(subpaths, wPx, hPx, paints);
    return { widgetType: "svg", extraState: { svgSource: "inline", svgSrc }, refusal: null };
  }
  return { widgetType: "rect", extraState: {}, refusal: `unrecognized geometry shape ${JSON.stringify(Object.keys(geometryIR))} — treated as a plain rect` };
}

/**
 * Pure function. Bakes preset_geometry.js's `{subpaths:[{d,fill,stroke}]}`
 * output into one inline `<svg>` markup string for `plugins/svg.js`'s
 * `svgSrc` state leaf — VECTORS STAY VECTORS (dump manifest verbatim law
 * #5: "PPT boolean-operator shapes ⇒ SVG... No rasterizing vector art"). The
 * fill/stroke COLORS are baked in LITERALLY (not `currentColor`) because
 * `plugins/svg.js`'s `ink` is a single color driving both fill and stroke
 * currentColor references, while a PPTX shape's fill and line are
 * independently colored — literal hex is the only way both survive without
 * inventing a second ink row. The svg widget's own whole-graphic `fill`
 * override row is left OFF (the artwork's own literal colors stand, exactly
 * like an unrecolored icon). Per-path `fill="norm"`/`stroke` flags (ECMA-376)
 * decide whether THAT path participates in fill/stroke at all — multi-path
 * custGeom (Merge Shapes results, holes) collapses to ONE `<path>` element
 * with every subpath's `d` concatenated (nonzero-winding fill-rule handles
 * the holes), per the mapping spec §3 "Multi-path shapes" row.
 *
 * @param {{d:string, fill:string, stroke:boolean}[]} subpaths
 * @param {number} wPx
 * @param {number} hPx
 * @param {{fillHex:string|null, strokeHex:string|null}} paints - null means "this shape draws no fill/stroke at all" (PAINT_NONE)
 * @returns {string}
 *
 * @example custGeomToSvgSrc([{d:"M 0,0 L 10,0 L 10,10 Z", fill:"norm", stroke:true}], 10, 10, {fillHex:"#336699", strokeHex:"#000000"}) // '<svg viewBox="0 0 10 10"><path d="M 0,0 L 10,0 L 10,10 Z" fill="#336699" stroke="#000000"/></svg>'
 */
export function custGeomToSvgSrc(subpaths, wPx, hPx, paints = {}) {
  const d = subpaths.map((p) => p.d).join(" ");
  const hasFill = subpaths.some((p) => p.fill !== "none") && paints.fillHex;
  const hasStroke = subpaths.some((p) => p.stroke) && paints.strokeHex;
  return `<svg viewBox="0 0 ${wPx} ${hPx}"><path d="${d}" fill="${hasFill ? paints.fillHex : "none"}" stroke="${hasStroke ? paints.strokeHex : "none"}"/></svg>`;
}
