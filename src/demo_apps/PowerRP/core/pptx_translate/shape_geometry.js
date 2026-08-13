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

import { presetShapePath, custGeomPath, shadeSubpathFill } from "../pptx/preset_geometry.js";

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
 * like an unrecolored icon).
 *
 * ── ONE `<path>` ELEMENT PER SUBPATH, NOT ONE FOR THE WHOLE SHAPE ────────────
 * This used to JOIN every subpath's `d` into a single element and decide its
 * fill/stroke with `.some()` — "is ANY subpath filled?", "is ANY subpath
 * stroked?". That is the same defect `plugins/pptx_preset.js` was fixed for, and
 * it discards the very flags ECMA-376 puts on each `<a:path>`: a shape whose
 * first subpath is a filled body and whose rest are stroke-only DETAIL LINES
 * (chartX's diagonals, a cube's edges) had those details FLOOD-FILLED, because
 * one `fill="norm"` anywhere turned the fill on for all of them.
 *
 * So each subpath becomes its own element carrying its OWN flags, and the
 * semantics are `presetPaintOps`' — the one place these rules are already
 * reasoned out — transposed to markup:
 *   fill "none"          -> that subpath contributes no fill element
 *   fill "norm"          -> the shape's own resolved fill
 *   fill darken/lighten* -> `shadeSubpathFill` of it (LibreOffice's cube faces)
 *   stroke false/true    -> no / one stroke element
 * A subpath that would draw NOTHING emits no element at all, rather than an
 * invisible one.
 *
 * ── PAINT ORDER IS WHY FILLS AND STROKES ARE SEPARATE PASSES ────────────────
 * SVG paints in DOCUMENT ORDER, so emitting every fill element and then every
 * stroke element reproduces `presetPaintOps`' `[...fills, ...strokes]` exactly:
 * outlines land on top of bodies rather than being half-buried by whichever
 * subpath happens to come next. It also means a stroke-only detail line is drawn
 * over the body it annotates, which is the whole point of it being separate.
 *
 * ── FILL RULE ───────────────────────────────────────────────────────────────
 * `evenodd`, PER ELEMENT, matching `presetPaintOps` — and now correct for the
 * right reason. The old joined path relied on NONZERO winding to punch holes,
 * which only worked because the holes shared one element with their body; with
 * one element per subpath a ring's two contours are still in the SAME `d` (a
 * subpath here is one `<a:path>`, which may contain several contours), so
 * `evenodd` is what LibreOffice writes for every fill in its own PDF of these
 * shapes.
 *
 * @param {{d:string, fill:string, stroke:boolean}[]} subpaths
 * @param {number} wPx
 * @param {number} hPx
 * @param {{fillHex:string|null, strokeHex:string|null}} paints - null means "this shape draws no fill/stroke at all" (PAINT_NONE)
 * @returns {string}
 *
 * @example custGeomToSvgSrc([{d:"M 0,0 L 10,0 L 10,10 Z", fill:"norm", stroke:true}], 10, 10, {fillHex:"#336699", strokeHex:"#000000"}) // '<svg viewBox="0 0 10 10"><path d="M 0,0 L 10,0 L 10,10 Z" fill="#336699" fill-rule="evenodd"/><path d="M 0,0 L 10,0 L 10,10 Z" fill="none" stroke="#000000"/></svg>'
 * @example // a stroke-only detail line is NOT flood-filled by its filled sibling
 * @example custGeomToSvgSrc([{d:"M 0,0 L 9,9 Z", fill:"norm", stroke:false}, {d:"M 0,9 L 9,0", fill:"none", stroke:true}], 9, 9, {fillHex:"#f00", strokeHex:"#000"}) // '<svg viewBox="0 0 9 9"><path d="M 0,0 L 9,9 Z" fill="#f00" fill-rule="evenodd"/><path d="M 0,9 L 9,0" fill="none" stroke="#000"/></svg>'
 * @example // PAINT_NONE on both: every subpath draws nothing, so the svg is empty
 * @example custGeomToSvgSrc([{d:"M 0,0 L 1,1", fill:"norm", stroke:true}], 1, 1, {fillHex:null, strokeHex:null}) // '<svg viewBox="0 0 1 1"></svg>'
 */
export function custGeomToSvgSrc(subpaths, wPx, hPx, paints = {}) {
  const fills = paints.fillHex
    ? subpaths
      .filter((p) => p.fill !== "none")
      .map((p) => `<path d="${p.d}" fill="${shadeSubpathFill(paints.fillHex, p.fill)}" fill-rule="evenodd"/>`)
    : [];
  const strokes = paints.strokeHex
    ? subpaths
      .filter((p) => p.stroke)
      .map((p) => `<path d="${p.d}" fill="none" stroke="${paints.strokeHex}"/>`)
    : [];
  return `<svg viewBox="0 0 ${wPx} ${hPx}">${[...fills, ...strokes].join("")}</svg>`;
}
