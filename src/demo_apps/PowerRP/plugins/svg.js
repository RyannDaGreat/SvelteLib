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
 * slice (a FRAMED svg) + crop insets? (left out — an SVG has no raster source to
 * UV-crop) + opacity + effects. So shadow/bloom/blend + anchors come for free.
 *
 * ── INK AND FILL ARE ONE SYSTEM (the colouring story) ─────────────────────────
 * Two rows decide what colour an SVG is, and they are only comprehensible together:
 *   INK  — what `currentColor` resolves to. It is why a fresh monochrome icon draws
 *          BLACK: the mono sets (tabler, mdi, lucide) author every path as
 *          `fill="currentColor"` or `stroke="currentColor"`, and ink defaults to
 *          #000000. Ink touches ONLY the currentColor parts, so a full-colour set
 *          (logos, twemoji) ignores it entirely.
 *   FILL — the whole-graphic OVERRIDE (a full PAINT row: solid, gradient, material,
 *          equation), DEFAULT OFF. Off means the artwork's own paints stand and ink
 *          still governs currentColor — i.e. exactly today's behaviour, which is what
 *          keeps every existing document byte-identical. On means EVERY path takes
 *          this one paint for its fill AND its stroke, like a stencil, so a
 *          multi-colour icon becomes a flat tint and an outline icon recolours too.
 * FILL SUPERSEDES INK when on. Both rows' help text says so, in both directions —
 * a user reading either one alone must still learn the pair (the shared strings
 * SVG_FILL_ROW / SVG_INK_HELP in render_gpu/gpu/svg_raster.js).
 *
 * ── ERRORS AND WARNINGS REPORT LOUDLY IN-WIDGET (no silent blank, no silently
 *    WRONG art) ───────────────────────────────────────────────────────────────
 * A malformed SVG (not well-formed XML / no root <svg>) makes the flatten THROW;
 * emit catches it and draws a LOUD red error affordance (a red-bordered box + the
 * parser message, vector rect+text — the latex errorAffordance pattern), visible
 * in every backend.
 * A PUNTED FEATURE is the subtler failure and gets the SAME chrome in a softer
 * key: mask/clip-path/filter, inline style=, radial gradients, <text>/<use>
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
 *
 * ── SOURCE MODES: INLINE vs URL (svgSource selects; an Iconify icon is just a
 *    url-mode svg) ─────────────────────────────────────────────────────────────
 * `svgSource: "inline"` renders `svgSrc` exactly as before. `svgSource: "url"`
 * renders the text behind `svgUrl` (a project `/asset/<Project>/<file>.svg` —
 * .svg is already an `image`-kind asset server-side — or any URL), loaded
 * through render_gpu/gpu/svg_source_registry.js: the image_registry contract
 * mirrored for text (idempotent ensure + sync get + load-event repaints +
 * pendingSvgSources for the headless render-job gate). An explicit mode select
 * beats "url wins when non-empty", which would make an authored svgSrc silently
 * unreachable. While a url is IN FLIGHT the widget draws nothing (a repaint
 * follows the load — the image precedent); a url that FAILED draws the red
 * errorAffordance naming the url (never a silent blank). In BARE NODE the
 * registry reads /asset/ urls off disk synchronously, so cli/render.js renders
 * url-mode icons in one pass — the one media type that renderer CAN draw.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { closestPointOnOutlines, pathDPolylines } from "../core/outline.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { decorateSilhouetteBorder } from "../render_gpu/decorate.js";
import { errorAffordance, warningLabel, warningAffordance } from "../render_gpu/affordances.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { svgToIRWithWarnings, svgIsEmpty, SVG_FILL_ROW, SVG_FILL_OFF, SVG_INK_HELP, svgOverridePaint, svgOverrideSlotPaint } from "../render_gpu/gpu/svg_raster.js";
import { ensureSvgSource, getSvgSource, svgSourceStatus, svgSourceError } from "../render_gpu/gpu/svg_source_registry.js";

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
    help: "The SVG markup to render as vector (paths, basic shapes, fills/strokes, simple transforms, objectBoundingBox linear gradients). Malformed SVG shows a red error box; an unsupported feature (mask, clip-path, filter, inline style=, radial gradients) still draws, with an amber band naming what was ignored. currentColor uses the Color below.",
  },
]);

// The affordance builders live in render_gpu/affordances.js (hoisted so
// plugins/iconify.js can draw the identical chrome without a plugin→plugin
// import); re-exported here so this widget's public surface is unchanged.
export { errorAffordance, warningLabel, warningAffordance };

// ── THE RIM IS THE ARTWORK, NOT THE FRAME AROUND IT ──────────────────────────
//
// THIS IS THE WIDGET THE USER'S BUG LANDED ON. He shattered a Mermaid flowchart;
// a shattered node becomes one of these (plugins/mermaid.js), and every anchored
// edge binds `@<node>_closest`. With the rim defined as the bounding rectangle,
// an edge approaching a DIAMOND from above-right met (w, 0) — a corner of empty
// space — which is exactly what he saw: "one end of the arrow is not connected
// to the other node… it's just that diamonds don't have anchors in the right
// place." Every NATIVE shape was fixed by THE INK RULE (core/derive.js
// withInkAnchors); this widget was the one that still lied, because the rule can
// only be as true as the rim a widget declares.
//
// COST, MEASURED, because it is what decides the shape of this code. The ink
// rule asks a widget's rim for EIGHT points inside one `anchors()` call, and
// `anchors()` runs per node per pointermove while the anchor overlay is on. One
// flatten costs 10 us for a Mermaid rhombus, 34 us for this widget's default
// source and 98 us for a twelve-petal curve graphic — so eight of them is
// 81-786 us per widget per mouse move, which on a shattered flowchart of twenty
// nodes is milliseconds of jank for a query nobody sees.
//
// A CACHE OF ONE IS THE WHOLE FIX, and it is worth saying why it is not the
// hazardous kind. Those eight calls are CONSECUTIVE, so a single-entry cache
// turns eight flattens into one and seven hits — the "compute it once per
// anchors() call" the cost demands, with no protocol change. It is keyed BY
// VALUE (the source text and the box), not by a state object's identity, so it
// cannot go stale the way a document-keyed memo can; and it holds exactly one
// entry, so a resize drag (which changes the key every frame) cannot grow it.
let rimCacheKey = null;
let rimCacheOutlines = null;

/**
 * Query (reads the SVG source registry; memoized in a one-entry cache — see the
 * block comment above for why that cache is safe). The widget's ARTWORK as
 * outline subpaths in BOX-LOCAL coordinates, or null when there is no artwork to
 * take a rim from.
 *
 * Null is returned — rather than an empty outline — for the three states in
 * which this widget genuinely has no drawn silhouette: an empty source (a
 * GHOST), a url still in flight or failed, and a source that will not parse
 * (which draws the red error BOX, whose rim really is the rectangle). The caller
 * falls back to the box border for exactly those, which is not a silent fallback
 * papering over a failure: it is the honest rim of the rectangle those states
 * actually draw. A source that parses with PUNTS keeps its art, so it keeps its
 * real rim.
 *
 * @param {object} state - the folded item state
 * @returns {number[][][]|null} subpaths [[[x, y], …], …] in box-local coords
 */
function svgRimOutlines(state) {
  const w = state.w ?? 0, h = state.h ?? 0;
  if (w <= 0 || h <= 0) return null;
  const src = state.svgSource === "url" ? (state.svgUrl ? getSvgSource(state.svgUrl) : null) : state.svgSrc;
  if (src === null || src === undefined || svgIsEmpty(src)) return null;
  const preserveAspect = state.preserveAspect !== false;
  const key = `${w}|${h}|${preserveAspect}|${state.ink ?? ""}|${src}`;
  if (key === rimCacheKey) return rimCacheOutlines;
  let outlines = null;
  try {
    // The SAME flatten emit() draws through, so the rim cannot disagree with the
    // ink. Paint is irrelevant to geometry, so the recolour overrides are not
    // passed — that also keeps the cache key free of the paint rows.
    const flat = svgToIRWithWarnings(src, w, h, { ink: state.ink ?? SVG_DEFAULT_INK, preserveAspect, opacity: 1 });
    // preserveAspect wraps the art in ONE pushTransform (a similarity) to
    // letterbox it; without it the map is baked into the coordinates and the ops
    // arrive bare. Track it so both cases land in the same box-local frame.
    let frame = null;
    outlines = [];
    for (const op of flat.ops) {
      if (op.op === "pushTransform") { frame = op; continue; }
      if (op.op === "popTransform") { frame = null; continue; }
      if (op.op !== "path" || !op.d) continue;
      for (const sub of pathDPolylines(op.d))
        outlines.push(frame ? sub.map(([x, y]) => { const p = T.apply(frame, x, y); return [p.x, p.y]; }) : sub);
    }
    if (outlines.length === 0) outlines = null;
  } catch {
    // A source that will not parse draws the red error BOX (see emit), whose rim
    // IS the rectangle — so this is not swallowing the error, it is agreeing with
    // what the widget actually paints. emit() reports the same failure loudly, in
    // the widget, on every backend; reporting it a second time from a geometry
    // query the user never invoked would be noise, not information.
    outlines = null;
  }
  rimCacheKey = key;
  rimCacheOutlines = outlines;
  return outlines;
}

export const svgPlugin = {
  type: "svg",
  ephemeral: EPHEMERAL.NONE,
  title: "SVG",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * Pure function. Is this widget a GHOST (empty source)? Mode-aware but in
   * LOCKSTEP with emit()'s short-circuit: inline → svgIsEmpty(svgSrc) (the
   * canonical predicate); url → an EMPTY url. An in-flight/errored url is NOT
   * a ghost — it has a rendered volume coming (or a loud error box).
   * @example svgPlugin.isGhost({ svgSrc: "" }) // true
   * @example svgPlugin.isGhost({ svgSrc: "<svg viewBox='0 0 1 1'></svg>" }) // false
   * @example svgPlugin.isGhost({ svgSource: "url", svgUrl: "" }) // true
   * @example svgPlugin.isGhost({ svgSource: "url", svgUrl: "/asset/P/a.svg" }) // false
   */
  isGhost(state) {
    if (state.svgSource === "url") return !state.svgUrl;
    return svgIsEmpty(state.svgSrc);
  },
  defaults: {
    type: "svg", x: 120, y: 120, w: 160, h: 160, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // SOURCE MODE — "inline" renders svgSrc (the original behavior), "url"
    // renders the text behind svgUrl via svg_source_registry (see docblock).
    svgSource: "inline",
    svgUrl: "",
    // PRESERVE ASPECT default ON (the user directive) — uniform scale-to-fit,
    // centered, no squash; OFF stretches to the box.
    preserveAspect: true,
    // INK — the `currentColor` resolution color (the latex ink precedent).
    ink: SVG_DEFAULT_INK,
    // FILL — the whole-graphic recolour override, default OFF, so the artwork keeps
    // its own intrinsic paints and this widget renders byte-identically to before
    // the row existed (render_gpu/gpu/svg_raster.js SVG_FILL_OFF).
    fill: SVG_FILL_OFF,
    // stroke COLOR default matches every stroked shape (INK); paints only once
    // strokeWidth > 0 (0 by default → an unframed SVG is undecorated).
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // svgSrc
  },
  inspector: [
    ...bundle("positioning"),
    // SOURCE MODE — explicit select (a non-empty url must never silently
    // shadow an authored svgSrc, and vice versa).
    { key: "svgSource", label: "Source", kind: "select", options: ["inline", "url"], optionLabels: { inline: "Inline markup", url: "URL / asset" }, category: "formatting", help: "Where the SVG comes from. Inline renders the markup below; URL loads an .svg asset (or any URL) — pick one from the project assets, e.g. an Iconify icon dropped into the asset library." },
    ...CUSTOM.rows, // the SVG source (inline mode)
    // The url-mode source — the image widget's asset row shape (`.svg` is an
    // image-kind asset server-side, so the picker offers it already).
    { key: "svgUrl", label: "SVG URL", kind: "asset", assetKinds: ["image"], assetForm: "url", category: "formatting", help: "The URL of the SVG to render when Source is set to URL — usually a project asset (/asset/<Project>/<file>.svg). A failed load shows a red error box naming the URL." },
    // INK — the currentColor resolution (a standard color row, keyframable). Its help
    // is SHARED with the iconify widget (SVG_INK_HELP) because ink and the Fill row
    // below are ONE system: ink says what `currentColor` means, Fill overrides
    // everything. Describing either alone is what left "why is my icon black?"
    // unanswerable.
    { key: "ink", label: "Color", kind: "color", category: "formatting", help: SVG_INK_HELP },
    // Aspect-preservation toggle (default ON) — the latex row, verbatim.
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the SVG uniformly to fit the box (centered, no distortion). Turn off to stretch it to the box's exact width and height." },
    // THE FILL OVERRIDE — a real PAINT row (solid / gradient / material / equation,
    // keyframable), DEFAULT OFF. Off is not "no row": it is the paint system's
    // first-class off state, and it means "the SVG's own paints stand", which is why
    // this widget can have a Fill row at all without changing what an existing
    // document renders. Declared ONCE in svg_raster.js and shared with iconify
    // (neither plugin imports the other).
    SVG_FILL_ROW,
    // The stroked-BORDER bundle (a FRAMED svg). Deliberately NOT bundle("strokedBox"):
    // that bundle's `fill` is a solid interior BEHIND the content, which is a
    // different property from the recolour override above — this widget's interior is
    // the artwork.
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
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const style = { x: 0, y: 0, w, h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    let src;
    if (s.svgSource === "url") {
      if (!s.svgUrl) return []; // GHOST — no url authored (isGhost grants the editor affordance)
      src = getSvgSource(s.svgUrl);
      if (src === null) {
        ensureSvgSource(s.svgUrl); // idempotent kick; in bare node this loads synchronously
        src = getSvgSource(s.svgUrl);
      }
      if (src === null) {
        // A FAILED url draws the loud error box (never a silent blank); an
        // in-flight one draws nothing — onSvgSourceLoad repaints when it lands.
        if (svgSourceStatus(s.svgUrl) === "error")
          return applyEffects(decorateSilhouetteBorder(errorAffordance(w, h, `failed to load ${s.svgUrl}: ${svgSourceError(s.svgUrl)}`), style, world), s, world, { x: 0, y: 0, w, h });
        return [];
      }
    } else {
      src = s.svgSrc;
      if (svgIsEmpty(src)) return []; // GHOST — draws nothing (isGhost grants the editor affordance)
    }
    let ops;
    try {
      // `overridePaint` is the Fill row (OFF → null → byte-identical to before it
      // existed). Applied inside the SHARED flatten, so every backend — Skia GPU, the
      // bare-node CLI still, the PDF and SVG vector exporters — gets the recolour
      // through the one display list with no backend code at all.
      // EACH SLOT ASKS ITS OWN REGISTRY. Fill and stroke materials are disjoint
      // rosters and each painter looks up only its own, so a material in the wrong
      // slot is a crash, not a colour — in BOTH directions. See svgOverrideSlotPaint.
      const override = svgOverridePaint(s);
      const flat = svgToIRWithWarnings(src, w, h, { ink: s.ink ?? SVG_DEFAULT_INK, preserveAspect: s.preserveAspect !== false, opacity: s.opacity ?? 1, overridePaint: svgOverrideSlotPaint(override, "fill"), overrideStrokePaint: svgOverrideSlotPaint(override, "stroke") });
      // A PUNTED feature draws degraded art, so the art is kept AND annotated —
      // never silently wrong (see warningAffordance). A clean SVG adds nothing.
      ops = flat.warnings.length ? [...flat.ops, ...warningAffordance(w, h, flat.warnings)] : flat.ops;
    } catch (e) {
      // Malformed SVG → LOUD in-widget error affordance (the latex precedent).
      ops = errorAffordance(w, h, e instanceof Error ? e.message : String(e));
    }
    return applyEffects(decorateSilhouetteBorder(ops, style, world), s, world, { x: 0, y: 0, w, h });
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  // THE ARTWORK'S rim, falling back to the box border only for the states that
  // genuinely draw a box (ghost / url in flight or failed / unparseable source —
  // see svgRimOutlines). THE INK RULE then puts this widget's eight standard rim
  // anchors on the artwork too, with no further code: one declaration, both
  // consumers. This is the last mile of todo #253 — a shattered Mermaid diamond
  // is one of these.
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const box = { x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 };
    const outlines = svgRimOutlines(state);
    if (!outlines) return closestPointOnRectBorder(box, local.x, local.y);
    return closestPointOnOutlines(outlines, local.x, local.y, { x: box.w / 2, y: box.h / 2 });
  },
  commands: [
    { id: "add-svg", title: "Add SVG", icon: "mdi:svg", run: (app) => app.armCrosshairPlacement(svgPlugin) }, // crosshair bbox placement, matching image/latex's add command
  ],
};
