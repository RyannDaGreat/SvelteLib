/**
 * SVG widget — a `svgSrc` source string flattened to FIRST-CLASS VECTOR content
 * on the canvas (crisp at any zoom; real vector in SVG/PDF export). It is the
 * CORE, general capability ("render an arbitrary SVG"); the cursor demo widget
 * (plugins/demo/cursor.js) is a thin specialization built ON it — both call the
 * SAME shared flatten (render_gpu/gpu/svg_raster.js → core/svg_paths.js — this
 * widget through svgToIRWithWarnings, since it HAS somewhere to show a notice, the
 * cursor through the ops-only svgToIR), neither imports the other (the "no plugin
 * imports another" rule).
 *
 * ── HOW IT REACHES THE RENDERER (reusing the path op, NO new IR op) ───────────
 * Every SVG shape flattens to ONE SVG-path-data `d`, emitted as render_gpu/ir.js
 * `path` ops (the op whose docstring already names "any future arbitrary-path
 * widget"). rect/circle/ellipse/polygon/polyline/line all become `d` too, so a
 * single op family renders everything — crisp vector, effects-complete,
 * PDF/SVG-exportable — with ZERO new backend code. This file is deliberately
 * near-identical to plugins/latex.js / plugins/image.js; the only new concerns
 * are `svgSrc` + `preserveAspect` + `ink` and the parse→flatten underneath.
 *
 * ── ASPECT-PRESERVE (default ON, the user directive) ──────────────────────────
 * preserveAspect ON uniform-scales the SVG to FIT the box (centered, letterbox,
 * no squash) via core/geometry.fitBox — the latex `preserveAspect` precedent. OFF
 * stretches to the box (a resize then distorts). Exposed as a "Preserve aspect"
 * boolean row, exactly like latex.
 *
 * ── CAPABILITIES / BOX (a generic box, everything free from the bundles) ──────
 * bbox + transform + resizable + opacity, backdrop:false — composites under
 * magnifiers/blur and culls for free. Composes positioning + the stroked-BORDER
 * slice (a FRAMED svg — no fill row: the SVG's own paint IS its interior, like
 * image/latex) + crop insets? (left out — an SVG has no raster source to UV-crop)
 * + opacity + effects. So shadow/bloom/blend + anchors come for free.
 *
 * ── ERRORS AND WARNINGS REPORT LOUDLY IN-WIDGET (no silent blank, no silently
 *    WRONG art) ───────────────────────────────────────────────────────────────
 * A malformed SVG (not well-formed XML / no root <svg>) makes the flatten THROW;
 * emit catches it and draws a LOUD red error affordance (a red-bordered box + the
 * parser message, vector rect+text — the latex errorAffordance pattern), visible
 * in every backend.
 * A PUNTED FEATURE is the subtler failure and gets the SAME chrome in a softer
 * key: mask/clip-path/filter, inline style=, arcs, radial gradients, <text>/<use>
 * all render DEGRADED (e.g. a masked element is drawn UNMASKED), which used to be
 * a console.error only — invisible to the user, so wrong art passed for correct.
 * emit now appends warningAffordance: an amber notice band along the bottom edge
 * naming the feature AND the element. The art still renders (a mildly-degraded
 * SVG stays usable); it just can no longer look correct. The adapter still reports
 * each punt once to the console (the CLI/headless surface).
 *
 * ── CONDITIONAL GHOST ─────────────────────────────────────────────────────────
 * An empty `svgSrc` renders nothing and is a GHOST (svgIsEmpty is the canonical
 * predicate, shared with emit()'s short-circuit) — the empty-latex/text precedent.
 *
 * ── ASYNC ─────────────────────────────────────────────────────────────────────
 * SVG parse+flatten is SYNCHRONOUS (DOMParser, no network/font load) — simpler
 * than latex. emit() is pure-ish (same state → same ops); the adapter caches the
 * parsed tree by source string. A bare-node emit() (no DOMParser) throws loudly
 * at call time — correct for a browser/CLI-facing widget (the CLI runs puppeteer,
 * which has a DOM, so headless export works).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { rect, text } from "../render_gpu/ir.js";
import { decorateStrokedBox } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { svgToIRWithWarnings, svgIsEmpty } from "../render_gpu/gpu/svg_raster.js";

/** The ink for `currentColor` fills/strokes — the INK convention every stroked
 * shape / the text / the latex widget uses (#000000), so an SVG that inherits
 * `currentColor` reads the same default color as default text. */
export const SVG_DEFAULT_INK = "#000000";

/** A freshly added SVG widget's default source — a self-contained sample that
 * exercises BOTH a filled shape (a rounded rect, testing the rect→rounded-path
 * conversion) and a stroked open path (the check, testing stroke), so a new
 * widget is visibly a real vector SVG. Replaced the instant the user edits it. */
export const DEFAULT_SVG_SRC =
  '<svg viewBox="0 0 48 48"><rect x="4" y="4" width="40" height="40" rx="8" fill="#7aa2f7"/><path d="M14 25L21 32L35 16" fill="none" stroke="#ffffff" stroke-width="4"/></svg>';

/** Error-affordance colors — a LOUD, unmissable red treatment (the "not silent,
 * not a blank widget" rule), the SAME literals plugins/latex.js documents (emit
 * can't read app.css --a-* tokens; DOM-free IR chrome). */
const ERROR_BG = "#f6c9c4";
const ERROR_BORDER = "#c0392b";
const ERROR_TEXT = "#7a1210";
const ERROR_BORDER_WIDTH = 3;
const ERROR_PADDING = 8;
const ERROR_TEXT_FRACTION = 0.16; // an SVG error message can be long; a smaller fraction fits more

/** Warning-affordance colors — the SAME rect+text chrome as the error box in an
 * AMBER notice treatment. Deliberately not red and not full-box: a flatten warning
 * means the art DID render, only degraded, so the affordance ANNOTATES it instead
 * of replacing it (a mildly-degraded SVG must stay usable). */
const WARN_BG = "#f7dfa5";
const WARN_BORDER = "#a5761b";
const WARN_TEXT = "#4a3505";
const WARN_BORDER_WIDTH = 1;
/** The notice band sits along the BOTTOM edge, at this fraction of the box height
 * but never taller than WARN_BAND_MAX box units — so a small icon is not swallowed
 * and a huge widget gets a slim strip, not a billboard. */
const WARN_BAND_FRACTION = 0.24;
const WARN_BAND_MAX = 40;
/** Slightly translucent, so whatever art the band overlaps stays readable. */
const WARN_BAND_OPACITY = 0.9;
const WARN_TEXT_FRACTION = 0.34; // of the BAND height (the band is the text's box)
const WARN_PADDING = 3;
/** How many punts the band spells out before summarizing the rest as "+N more" —
 * bounded text keeps the band legible on a badly-degraded SVG. */
const WARN_MAX_LISTED = 2;

// The custom self.* source property. Declared inline (widget-specific props do
// NOT belong in the cross-widget core/properties.js registry — the latex `latex`
// / codeblock `code` precedent). A "text" row round-trips the whole SVG string;
// a richer editor is future UI work (flagged), the string flattens fully regardless.
const CUSTOM = customProps([
  {
    name: "svgSrc",
    kind: "text",
    default: DEFAULT_SVG_SRC,
    label: "SVG source",
    category: "formatting",
    help: "The SVG markup to render as vector (paths, basic shapes, fills/strokes, simple transforms, objectBoundingBox linear gradients). Malformed SVG shows a red error box; an unsupported feature (mask, clip-path, filter, inline style=, arcs, radial gradients) still draws, with an amber band naming what was ignored. currentColor uses the Color below.",
  },
]);

/**
 * Pure function. The loud in-widget ERROR affordance IR: a red-bordered filled
 * box across the widget's local bbox + the parser error message in red, as
 * VECTOR rect+text ops (crisp, identical in every backend — never a blank
 * widget). The plugins/latex.js errorAffordance, verbatim in shape.
 *
 * @example errorAffordance(200, 60, "malformed SVG").length // 2
 * @example errorAffordance(200, 60, "x")[0].op // "rect"
 */
export function errorAffordance(w, h, message) {
  const box = rect({ x: 0, y: 0, w, h, cornerRadius: 0, fill: ERROR_BG, stroke: ERROR_BORDER, strokeWidth: ERROR_BORDER_WIDTH });
  const size = Math.max(1, h * ERROR_TEXT_FRACTION);
  const label = text({
    text: `SVG error: ${message}`,
    x: ERROR_PADDING, y: ERROR_PADDING,
    size, color: ERROR_TEXT,
    boxW: Math.max(1, w - 2 * ERROR_PADDING), boxH: Math.max(1, h - 2 * ERROR_PADDING),
  });
  return [box, label];
}

/**
 * Pure function. The user-facing label for a flatten warning list: each notice
 * with core/svg_paths.js's `svg: ` prefix dropped (the band already says SVG),
 * the first WARN_MAX_LISTED spelled out, the rest summarized. Empty list → "".
 *
 * @param {string[]} warnings - core/svg_paths.js flatten warnings
 * @returns {string} the band's text
 *
 * @example warningLabel([]) // ""
 * @example warningLabel(["svg: <text> is unsupported in v1 (skipped)"]) // "Unsupported: <text> is unsupported in v1 (skipped)"
 * @example warningLabel(["svg: a", "svg: b", "svg: c"]) // "Unsupported: a; b (+1 more)"
 */
export function warningLabel(warnings) {
  if (!warnings.length) return "";
  const shown = warnings.slice(0, WARN_MAX_LISTED).map((w) => w.replace(/^svg:\s*/, ""));
  const rest = warnings.length - shown.length;
  return `Unsupported: ${shown.join("; ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * Pure function. The in-widget WARNING affordance IR: an amber notice band along
 * the widget's BOTTOM edge naming the unsupported features (and the elements
 * carrying them), as the same VECTOR rect+text pair errorAffordance uses — so a
 * degraded SVG (a mask/filter/clip-path ignored, an arc dropped, a radial gradient
 * flattened) can never quietly look correct. The ART IS STILL DRAWN: this band is
 * appended OVER it, not in place of it (the error box's opposite trade).
 *
 * @param {number} w - widget box width (box-local units)
 * @param {number} h - widget box height
 * @param {string[]} warnings - core/svg_paths.js flatten warnings (non-empty)
 * @returns {object[]} [rect, text] IR ops in box-local space
 *
 * @example warningAffordance(200, 100, ["svg: <text> unsupported"]).length // 2
 * @example warningAffordance(200, 100, ["svg: <text> unsupported"])[0].op // "rect"
 * @example warningAffordance(200, 100, ["svg: <text> unsupported"])[0].y // 76  (h − band, the band hugs the bottom edge)
 */
export function warningAffordance(w, h, warnings) {
  const band = Math.min(h * WARN_BAND_FRACTION, WARN_BAND_MAX);
  const top = h - band;
  const box = rect({
    x: 0, y: top, w, h: band, cornerRadius: 0,
    fill: WARN_BG, stroke: WARN_BORDER, strokeWidth: WARN_BORDER_WIDTH, opacity: WARN_BAND_OPACITY,
  });
  const label = text({
    text: warningLabel(warnings),
    x: WARN_PADDING, y: top + WARN_PADDING,
    size: Math.max(1, band * WARN_TEXT_FRACTION), color: WARN_TEXT,
    boxW: Math.max(1, w - 2 * WARN_PADDING), boxH: Math.max(1, band - 2 * WARN_PADDING),
  });
  return [box, label];
}

export const svgPlugin = {
  type: "svg",
  title: "SVG",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * Pure function. Is this widget a GHOST (empty source)? svgIsEmpty is the
   * canonical predicate, shared with emit()'s short-circuit.
   * @example svgPlugin.isGhost({ svgSrc: "" }) // true
   * @example svgPlugin.isGhost({ svgSrc: "<svg viewBox='0 0 1 1'></svg>" }) // false
   */
  isGhost(state) {
    return svgIsEmpty(state.svgSrc);
  },
  defaults: {
    type: "svg", x: 120, y: 120, w: 160, h: 160, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // PRESERVE ASPECT default ON (the user directive) — uniform scale-to-fit,
    // centered, no squash; OFF stretches to the box.
    preserveAspect: true,
    // INK — the `currentColor` resolution color (the latex ink precedent).
    ink: SVG_DEFAULT_INK,
    // stroke COLOR default matches every stroked shape (INK); paints only once
    // strokeWidth > 0 (0 by default → an unframed SVG is undecorated).
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // svgSrc
  },
  inspector: [
    ...bundle("positioning"),
    ...CUSTOM.rows, // the SVG source
    // INK — the currentColor resolution (a standard color row, keyframable).
    { key: "ink", label: "Color", kind: "color", category: "formatting", help: "The color used wherever the SVG says fill/stroke=currentColor. Ignored by shapes with their own explicit colors." },
    // Aspect-preservation toggle (default ON) — the latex row, verbatim.
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the SVG uniformly to fit the box (centered, no distortion). Turn off to stretch it to the box's exact width and height." },
    // The stroked-BORDER bundle (a FRAMED svg) — no `fill` row: the SVG's own
    // paint IS its interior, like image/latex.
    ...bundle("strokedBorder"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (the RETURNED IR is a pure function of state; the adapter
   * memoizes the parse as a side effect). State → display-list commands (local
   * space). Empty source → [] (GHOST). A malformed SVG makes the flatten throw →
   * the loud vector error affordance (never a blank widget); an SVG that flattened
   * with PUNTS keeps its art and gains the warning band (never silently wrong
   * art). Effects wrap OUTSIDE the border decoration (the render_gpu/effects.js
   * order rule), so shadow/bloom silhouette the FRAMED svg.
   */
  emit(s, _targetWorldIR, world) {
    const src = s.svgSrc;
    if (svgIsEmpty(src)) return []; // GHOST — draws nothing (isGhost grants the editor affordance)
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const style = { x: 0, y: 0, w, h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    let ops;
    try {
      const flat = svgToIRWithWarnings(src, w, h, { ink: s.ink ?? SVG_DEFAULT_INK, preserveAspect: s.preserveAspect !== false, opacity: s.opacity ?? 1 });
      // A PUNTED feature draws degraded art, so the art is kept AND annotated —
      // never silently wrong (see warningAffordance). A clean SVG adds nothing.
      ops = flat.warnings.length ? [...flat.ops, ...warningAffordance(w, h, flat.warnings)] : flat.ops;
    } catch (e) {
      // Malformed SVG → LOUD in-widget error affordance (the latex precedent).
      ops = errorAffordance(w, h, e instanceof Error ? e.message : String(e));
    }
    return applyEffects(decorateStrokedBox(ops, style, world), s, world, { x: 0, y: 0, w, h });
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-svg", title: "Add SVG", icon: "mdi:svg", run: (app) => app.armCrosshairPlacement(svgPlugin) }, // crosshair bbox placement, matching image/latex's add command
  ],
};
