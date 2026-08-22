/**
 * PPTX PRESET SHAPE — a PARAMETRIC widget for PowerPoint's 187 AutoShapes
 * (`prstGeom prst="..."`), imported and KEPT PARAMETRIC rather than baked to
 * a frozen path. User ruling (verbatim): "all 187 preset shapes should also
 * have the correct handles that powerpoint has too. a lot of these are
 * parametric and they should be treated as such."
 *
 * RESTORED, AND WHY THAT IS WORTH A LINE: 48e2b413 ("pptx_preset gets 10
 * shape-family looks") DELETED this header wholesale and said nothing about
 * it, taking the user ruling above, the parser contract below and the handles
 * doctrine with it — none of which was written down anywhere else in the app
 * (`grep -rn "HANDLES MATCH POWERPOINT"` returned nothing for the days it was
 * gone). It is restored from 48e2b413^ and RE-CHECKED CLAUSE BY CLAUSE against
 * what this file does TODAY, because a header restored unread would install a
 * confident lie rather than repair one: the paint paragraph now states the
 * PER-SUBPATH model workstream PPTXPAINT landed, the handles paragraph no
 * longer claims a conditionally-absent `modifierPoints` key that a single
 * plugin serving all 187 presets structurally cannot have, and the Inspector
 * paragraph no longer calls state-dependent rows unsupported — `dynamicInspector`
 * exists now, so that paragraph gives the reason this widget still has none.
 *
 * STATE is `{preset, adj, w, h, ...}` — `preset` a name into
 * `preset_shape_defs.json`'s `shapes` table, `adj` a `{gdName: value}` map of
 * instance-level adjustment overrides in POWERPOINT'S OWN NAMES (`adj`,
 * `adj1`, `hf`, ...  — whatever that preset's `avLst` declares), absent keys
 * falling back to the preset's own `avLst` defaults. TYPE IS `"pptxPreset"`
 * (camelCase) and the `adj` SHAPE IS NAMED, NOT POSITIONAL, deliberately
 * matching `core/pptx_translate/shape_geometry.js`'s `classifyGeometry`
 * (owned elsewhere, and now shipping): it emits
 * `{widgetType: "pptxPreset", extraState: {preset: name, adj: adjustments}}`
 * straight from the parsed `<a:avLst>` overrides, so this widget's state
 * shape is the parser's OUTPUT contract, not an independent invention —
 * changing either side would break the other.
 *
 * `emit()` calls `presetShapePath` (core/pptx/preset_geometry.js — the pure
 * DrawingML geometry evaluator) fresh on every render, so a keyframed `adj`
 * value or a resized box re-derives the exact PowerPoint silhouette every
 * frame; NOTHING is baked. This is the same "parametric, not frozen" shape
 * this app already ships for its own shape families (plugins/shapeshifter.js's
 * `ss_*` widgets) — this widget is the PPTX-import counterpart of that
 * pattern, reusing the SAME display-list path op, effects bundle and morph
 * protocol, only swapping the geometry source (`presetShapePath` instead of
 * `core/outline.js`'s hand-authored generators). It draws ONE `path` OP PER
 * DRAWN SUBPATH, honouring each subpath's own declared fill/stroke flags —
 * NOT one joined path, which is what this file did until workstream PPTXPAINT
 * and what drew 69 of the 187 shapes wrong; see `presetPaintOps` below for the
 * paint order and the measured counts.
 *
 * ── HANDLES MATCH POWERPOINT'S OWN, NOT INVENTED ONES ────────────────────────
 * `modifierPoints` is DERIVED FROM THE SHAPE'S OWN `ahLst` (core/pptx/
 * preset_handles.js — parses PowerPoint's adjust-handle declarations, computes
 * each handle's on-canvas position from the current `adj`, and inverts a drag
 * back into the `adj` value(s) it controls, clamped to PowerPoint's own
 * declared min/max). So a roundRect shows the ONE corner-radius handle
 * PowerPoint shows, a pie shows the same two angle handles at the same two
 * points, a block arrow shows shaft-thickness and head-length handles in the
 * same places — never a hand-guessed approximation of where PowerPoint's
 * handle would be. A preset with none (67 of 187 — `rect`, the
 * `actionButton*` family, plain connectors, …) returns an EMPTY handle array,
 * so the canvas draws no yellow diamonds on it, exactly as PowerPoint offers
 * none there. (Empty and not an ABSENT `modifierPoints` key: one plugin
 * serves all 187 presets, so the key cannot vary per preset. The only
 * protocol that reads the key's presence is core/registry.js's
 * `pointListEditable`, which ALSO requires a `kind: "list"` Inspector row —
 * this widget has none, so the two forms are indistinguishable here.)
 *
 * NO NUMBERED "ADJUSTMENT N" INSPECTOR ROWS, AND THAT IS DELIBERATE, NOT AN
 * OMISSION. This app's Inspector rows have a STATIC `key`/`writeKey`
 * (web/Inspector.svelte's `writeKey(row) = row.writeKey ?? row.key`, never a
 * function of state), but which GUIDE NAME a given "slot" means varies per
 * preset (`roundRect`'s only adjustment is named `adj`; `pie`'s two are
 * `adj1`/`adj2`; `star5`'s three are `adj`/`hf`/`vf`) — so there is no static
 * row key that could target the right nested `adj.<name>` path across every
 * preset without either (a) betraying the parser's named-`adj` contract with
 * a second positional-slot storage scheme translated at read/write time (an
 * earlier version of this file did exactly that, and it worked, but it
 * existed ONLY to feed a static row key — see concerns.md/this repo's history
 * for the false start), or (b) growing per-preset dynamic Inspector arrays.
 * (b) IS EXPRESSIBLE TODAY AND WAS NOT WHEN THIS PARAGRAPH WAS WRITTEN: the
 * clause restored here used to say the Inspector "does not support" it, and
 * `dynamicInspector?(state)` has since landed in core/registry.js's protocol.
 * It is still not taken, now for a REASON rather than a limit — dynamic rows
 * are read by the single-selection and creation panels only, NOT by the
 * multi-selection intersection (that same docblock says so), so per-preset
 * adjustment rows would silently vanish the moment a second item was selected.
 * PowerPoint itself has no such panel either — its ONLY UI for an
 * adjustment is the on-canvas handle, or none at all for an adjustment no
 * handle reaches. This widget matches that: `modifierPoints` IS the editing
 * surface; an adjustment with no handle is reachable only via `=`-binding an
 * equation onto `adj.<name>` directly (every property in this app is
 * equation-bindable at Tier 0), the same route any nested leaf with no
 * dedicated row already uses.
 *
 * ── WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────────────
 * `core/pptx/preset_geometry.js`, `core/pptx/preset_handles.js` and
 * `core/pptx/preset_shape_defs.json` are pure, DOM-free, and owned elsewhere
 * (the PPTX geometry evaluator and its handle-inversion counterpart) — this
 * plugin is thin glue: it reads that pure geometry, renders it through the
 * SAME path/fill/stroke display-list op every other vector shape widget uses
 * (render_gpu/ir.js `path()`, exactly as plugins/shapeshifter.js and
 * plugins/shape.js do), and turns handle drags into `adj` writes. No plugin
 * may import another plugin (core/registry.js's rule) — this widget composes
 * only through core/* and render_gpu/*, like every other widget.
 * `core/pptx_translate/shape_geometry.js` (the parser half that PRODUCES
 * `{type: "pptxPreset", preset, adj, w, h, ...}` items from real slide XML)
 * is likewise out of scope here — this widget is the RENDER + EDIT half:
 * given that state shape, draw PowerPoint's exact silhouette and offer
 * PowerPoint's exact handles.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, BUNDLES, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { presetShapePath, shadeSubpathFill } from "../core/pptx/preset_geometry.js";
import { parseAhLst, handlePositions, adjFromHandleDrag } from "../core/pptx/preset_handles.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { path } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import presetShapeDefsFile from "../core/pptx/preset_shape_defs.json" with { type: "json" };

/** The compiled preset table (`{name: {avLst, gdLst, ahLst, rect, pathLst}}`),
 *  loaded once at module load via Vite/Node's native JSON import (works
 *  identically in the browser bundle and bare-node `cli/render.js` — both
 *  resolve `with {type: "json"}`, unlike a plain unattributed JSON import,
 *  which Node's ESM loader refuses). NOT wired through
 *  `preset_geometry.installPresetDefs`'s module-level cache: this widget
 *  passes `DEFS` explicitly to every call instead, so it never depends on
 *  some OTHER module (the PPTX parser) having called that installer first —
 *  the plugin registry can construct this widget's defaults at import time
 *  with no ordering requirement on anything else. */
const DEFS = presetShapeDefsFile.shapes;

/** Every preset name, for the `preset` selector row's `options`. Sorted so
 *  the dropdown is browsable rather than in the vendored table's own
 *  (alphabetical-ish but not guaranteed) JSON key order — sorting here makes
 *  that guarantee explicit rather than incidental. */
const PRESET_NAMES = Object.keys(DEFS).sort();

/**
 * Pure function. This shape's declared `adj` defaults — `avLst`, already a
 * NAMED `{gdName: value}` map in the vendored table (PowerPoint's own units:
 * 100,000ths of the box for a ratio, 60,000ths of a degree for an angle; see
 * core/pptx/preset_geometry.js's header). A copy, so callers may freely
 * mutate the result.
 *
 * @example defaultAdjOf("roundRect", DEFS) // {adj: 16667}
 * @example defaultAdjOf("pie", DEFS) // {adj1: 0, adj2: 16200000}
 */
function defaultAdjOf(preset, defs) {
  return { ...(defs[preset]?.avLst ?? {}) };
}

/**
 * Pure function. This state's EFFECTIVE adjustments: the preset's own
 * `avLst` defaults with the instance's `adj` overrides layered on — the same
 * defaults-then-overrides shape `foldGuides` itself applies (both are named
 * maps, so this is a plain merge, no translation), computed once here so
 * `emit`/`modifierPoints` read an identical table rather than each
 * re-deriving it.
 *
 * ── THE FILTER IS THE FIX FOR THE PRESET-SWITCH CRASH (R7-31) ───────────────
 * AN OVERRIDE THE CURRENT PRESET DOES NOT DECLARE IS DROPPED, and that single
 * line is what makes the `preset` row usable at all. The row is an ordinary
 * select writing ONE leaf, so `state.adj` KEEPS THE PREVIOUS PRESET'S GUIDE
 * NAMES across a switch — and `foldGuides` (core/pptx/preset_geometry.js)
 * LOUDLY refuses an adj name absent from the new preset's `avLst`. Measured on
 * the unfixed tree: every insert ships roundRect's `{adj: 16667}`, which only
 * 39 of 187 presets declare, so 148/187 threw on switch; worse, a handle drag
 * writes the FULL effective adj (see `adjFromHandleDrag`'s contract quoted at
 * `modifierPoints` below), so ONE drag on star5 poisoned the item into
 * 185/187 failing — INCLUDING the default roundRect — with no UI route back.
 * Filtering here heals render, handles and ALREADY-POISONED documents at once,
 * with no migration pass and no stored-state rewrite.
 *
 * FOLDGUIDES STAYS LOUD, deliberately. This filter removes the one case that
 * is NOT a wiring bug — a leftover key from a preset the user switched away
 * from, which PowerPoint itself simply forgets — while an adj name that
 * reaches `foldGuides` through any OTHER route still throws, because that
 * genuinely means a caller built a table the shape never declared.
 *
 * PRESET ROWS BELOW WRITE `{preset, adj}` TOGETHER, and this is exactly why
 * that is safe: `applyPreset` writes both keys of one preset row in the same
 * commit, so `adj` never lands ahead of `preset` — but even a stale key
 * surviving a hover-then-switch is filtered here rather than thrown.
 *
 * @example effectiveAdjOf({preset: "roundRect", adj: {}}, DEFS) // {adj: 16667}
 * @example effectiveAdjOf({preset: "roundRect", adj: {adj: 30000}}, DEFS) // {adj: 30000}
 * @example // a stale key from a PREVIOUS preset is dropped, not passed to foldGuides
 * @example effectiveAdjOf({preset: "roundRect", adj: {adj: 30000, hf: 105146}}, DEFS) // {adj: 30000}
 * @example // a preset with NO adjustments ignores every override
 * @example effectiveAdjOf({preset: "rect", adj: {adj: 16667}}, DEFS) // {}
 */
function effectiveAdjOf(state, defs) {
  const declared = defaultAdjOf(state.preset, defs);
  for (const [name, value] of Object.entries(state.adj ?? {}))
    if (name in declared) declared[name] = value;
  return declared;
}

/**
 * Pure function. This state's rendered geometry — `presetShapePath`'s result,
 * degenerate-box-guarded (a zero-size box has nothing to fold `wd2`/`hd2`-style
 * guides against; `preset_geometry.emitPathCommands` throws on a zero path
 * dimension, so this widget refuses to even ask rather than propagate that
 * throw into a render pass, matching shapeshifter.js's own `(s.w??0)<=0`
 * guard).
 *
 * @example geometryOf({preset: "rect", adj: {}, w: 100, h: 50}, DEFS).subpaths[0].d
 * // "M 0,0 L 100,0 L 100,50 L 0,50 Z"
 * @example geometryOf({preset: "rect", adj: {}, w: 0, h: 50}, DEFS) // null (degenerate box)
 */
function geometryOf(state, defs) {
  const w = state.w ?? 0, h = state.h ?? 0;
  if (w <= 0 || h <= 0) return null;
  return presetShapePath(state.preset, effectiveAdjOf(state, defs), w, h, defs);
}

/**
 * Pure function. THE SUBPATH PAINT MODEL — one `path` op per drawn subpath,
 * honouring each subpath's OWN declared `fill`/`stroke` flags, in the order
 * LibreOffice paints them.
 *
 * ── WHAT WAS WRONG BEFORE, AND HOW BADLY ────────────────────────────────────
 * This widget used to `join(" ")` every subpath into ONE `d` and paint it with
 * one fill + one stroke + a hardcoded `fillRule: "evenodd"`, on a comment
 * claiming preset geometry "never mixes fill/stroke per-subpath in a way this
 * app's paint model needs to keep separate". That is true of the 118
 * single-subpath presets and FALSE of the other 69, which is 37% of the table.
 * MEASURED on the vendored defs: 95 subpaths declare `fill="none"` (stroke-only
 * detail lines — the joined path FLOOD-FILLED them), 52 declare `stroke=false`
 * (fill-only silhouettes — the joined path OUTLINED them), and 33 declare a
 * darken/lighten shade (the 3D faces of `cube`, `can`, `bevel`, the curved
 * arrows — all painted flat). The user's report was "a lot of these shapes just
 * look very broken"; the count behind it was 69/187.
 *
 * The evaluator ALREADY returned `{d, fill, stroke}` per subpath and
 * `tests/pptx_geometry_test.js` already pinned that it does. Nothing consumed
 * them. This function is that consumption.
 *
 * ── THE PAINT ORDER IS FILLS-THEN-STROKES, AND IT IS NOT DECLARATION ORDER ──
 * Every subpath's fill is painted (in declaration order), and only then is every
 * subpath's stroke painted (in declaration order). This is LibreOffice's own
 * rule, not an inference: `EnhancedCustomShape2d.cxx` splits each subpath into a
 * separate fill object and stroke object (`CreateSubPath`) and then STABLE-
 * PARTITIONS the list so non-line objects precede line objects, under the
 * comment "sort objects so that filled ones are in front. Necessary for some
 * strange objects".
 *
 * IT IS LOAD-BEARING FOR EXACTLY THREE SHAPES and they are the reason a naive
 * declaration-order implementation looks right and is not: `chartX`, `chartPlus`
 * and `chartStar` declare their stroke-only detail lines FIRST and their filled
 * square SECOND. In declaration order the square covers the lines and the shape
 * renders as a blank box — which is what a first attempt at this fix produced.
 * VERIFIED against LibreOffice's raw PDF content stream for chartX, which emits
 * the blue fill (`f*`) before the two diagonal strokes (`S S`) despite the
 * reverse declaration order. `cube`/`can`/`bevel`/`ribbon` show the same
 * `f f ... S S` shape; `cloudCallout`'s apparent `f S f S` interleave is that
 * same rule seen through subpaths that are each BOTH filled and stroked.
 *
 * THE ACCIDENT THIS DELIBERATELY DOES NOT PRESERVE: under the joined path,
 * chartX's diagonals were flood-filled, which read as BOLDER than the reference.
 * Honouring the flags makes them 2px strokes, and the correct answer is
 * whichever LibreOffice draws — it draws strokes.
 *
 * ── FILL RULE ───────────────────────────────────────────────────────────────
 * `evenodd` per subpath, retained and now VERIFIED rather than assumed: every
 * fill in LibreOffice's PDF of all 187 shapes carries `even_odd: true`,
 * including the ring/counter shapes (`donut`, `sun`) the rule actually matters
 * for. The old code's `evenodd` was right; only its SCOPE was wrong.
 *
 * ── WHAT EACH FLAG MEANS HERE ───────────────────────────────────────────────
 *   fill "none"          -> no fill op contribution (stroke only)
 *   fill "norm"          -> the widget's own fill
 *   fill darken/lighten* -> `shadeSubpathFill` of the widget's fill
 *   stroke false         -> no stroke contribution
 *   stroke true          -> the widget's stroke at the widget's strokeWidth
 * A subpath that would draw NOTHING (no fill and no stroke) emits no op at all,
 * rather than an invisible one — `path()` would accept it, but an op that cannot
 * produce a pixel is cost in every backend and noise in every op-count test.
 *
 * Args:
 *   subpaths (Array<{d, fill, stroke}>): `presetShapePath`'s own return.
 *   s (object): the widget state (fill, stroke, strokeWidth, opacity).
 *
 * Returns:
 *   Array<object> -- `path` IR ops, in paint order.
 *
 * @example // a plain one-subpath shape: ONE op, filled and stroked, as before
 * @example presetPaintOps([{d: "M 0,0 L 1,1", fill: "norm", stroke: true}], {fill: "#f00", stroke: "#000", strokeWidth: 2}).length // 1
 * @example // cube-like: 3 shaded fills then 1 outline stroke = 4 ops
 * @example presetPaintOps([{d: "M 0,0", fill: "norm", stroke: false}, {d: "M 1,1", fill: "darkenLess", stroke: false}, {d: "M 2,2", fill: "none", stroke: true}], {fill: "#7dcfff", stroke: "#000", strokeWidth: 2}).map((o) => o.op) // ["path", "path", "path"]
 * @example // chartX: the fill-second subpath is painted FIRST
 * @example presetPaintOps([{d: "M 0,0", fill: "none", stroke: true}, {d: "M 9,9", fill: "norm", stroke: false}], {fill: "#7dcfff", stroke: "#000", strokeWidth: 2}).map((o) => o.d) // ["M 9,9", "M 0,0"]
 */
function presetPaintOps(subpaths, s) {
  const strokeWidth = s.strokeWidth ?? 0;
  const strokeColor = strokeWidth > 0 ? (s.stroke ?? null) : null;
  const opacity = s.opacity ?? 1;
  const common = { fillRule: "evenodd", opacity };

  const fills = subpaths
    .filter((sp) => sp.fill !== "none")
    .map((sp) => path({ ...common, d: sp.d, fill: shadeSubpathFill(s.fill, sp.fill), stroke: null, strokeWidth: 0 }));
  const strokes = strokeColor === null ? [] : subpaths
    .filter((sp) => sp.stroke)
    .map((sp) => path({ ...common, d: sp.d, fill: null, stroke: strokeColor, strokeWidth }));
  return [...fills, ...strokes];
}

/**
 * Pure function. ONE MORPH PIECE'S PAINT for `morphPaths` — the paint that
 * subpath is actually drawn with, and `statePaint`'s MARK only when that paint
 * IS the widget's own state ink. See `morphPaths`'s docblock for why the mark
 * has to be conditional; the short version is that `render_gpu/ports.js` treats
 * the mark as permission to REREAD the ink from state, which is a lie for a
 * shaded face and would repaint a cube flat mid-morph.
 *
 * A `norm` + stroked subpath is exactly `statePaint(s)`, mark included, so the
 * 118 single-subpath presets produce a byte-identical payload to before.
 *
 * @example // the ordinary case: state ink, marked, unchanged from before
 * @example subpathMorphPaint({fill: "norm", stroke: true}, {fill: "#f00", stroke: "#000", strokeWidth: 2, opacity: 1}) // {fill: "#f00", stroke: "#000", strokeWidth: 2, opacity: 1}
 * @example // a shaded face: derived colour, and NOT marked as state ink
 * @example subpathMorphPaint({fill: "darken", stroke: false}, {fill: "#7dcfff", stroke: "#000", strokeWidth: 2, opacity: 1}).fill // "#4b7c99"
 * @example // a stroke-only detail line carries NO fill
 * @example subpathMorphPaint({fill: "none", stroke: true}, {fill: "#7dcfff", stroke: "#000", strokeWidth: 2, opacity: 1}).fill // null
 */
function subpathMorphPaint(sp, s) {
  const strokeWidth = s.strokeWidth ?? 0;
  if (sp.fill === "norm" && sp.stroke) return statePaint(s);
  return {
    fill: sp.fill === "none" ? null : shadeSubpathFill(s.fill, sp.fill),
    stroke: sp.stroke && strokeWidth > 0 ? (s.stroke ?? null) : null,
    strokeWidth,
    opacity: s.opacity ?? 1,
  };
}

// ── EFFECTS-BUNDLE IDENTITIES, named for the same reason plugins/group.js
// names them: application is an OVERLAY (applyPreset writes exactly the keys
// in `props`), so a row that omits an effect key keeps whatever the
// PREVIOUSLY HOVERED row left there. Every preset below sets all six —
// including these OFF identities — because this is a whole-LOOK family (each
// row pairs a shape with a full fill/stroke/effects treatment), the same
// completeness rule preset_contract_test.js gate (7) enforces from
// BUNDLES.effects rather than from a transcribed count.
//
// THE HEAD SET IS DERIVED, NOT TRANSCRIBED, exactly as rect.js/trail.js/
// labeled_circle.js/iconify.js each derive it: the comment above invoked that
// rule while the code below hand-listed six keys, so the day BUNDLES.effects
// grows a seventh head this file would have gone on leaking the previously
// hovered row's value with nothing to notice. The import-time throw names the
// missing head instead.
const EFFECT_HEADS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];
if (EFFECT_HEADS.length !== 6)
  throw new Error(`pptx_preset presets: BUNDLES.effects grew a new head (${EFFECT_HEADS.join(", ")}) — add its OFF identity below and extend every preset row`);
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLUR_OFF = 0;
const EFFECTS_OFF = { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF };

/**
 * TEN PRESETS: SHAPE-FAMILY LOOKS, EACH A {preset, adj, fill/stroke, effects}
 * TREATMENT — not a sampler of the 187 names, a small set of coherent looks
 * an author reaches for without re-deriving an avLst by hand.
 *
 * EVERY `adj` VALUE BELOW SITS INSIDE ITS SHAPE'S OWN `ahLst` min/max, AND
 * THAT IS NOW CHECKED RATHER THAN ASSERTED. This paragraph made the claim from
 * the day the rows landed while tests/pptx_presets_test.js checked each key
 * against a list of eleven generic guide NAMES and no range at all — and one
 * row was wrong under it (`leftBrace` adj1 = 45000 against its own maxAdj1 of
 * 25000, silently pinned by `foldGuides` and drawn at 25000). That test now
 * resolves each handle's real bounds through `parseAhLst` + `foldGuides` at
 * three box aspect ratios, because a bound may itself be a GUIDE and move with
 * the box. ONE row (the callout) is bounded only by the `+-2147483647` sentinel
 * PowerPoint uses for an unbounded handle, where "inside the declared range" is
 * true but says nothing — so that row states its values as offsets instead of
 * claiming a nearby extreme.
 * `adj` KEY SETS ARE PER-SHAPE (roundRect -> {adj}; pie -> {adj1,adj2};
 * star5 -> {adj,hf,vf}) and every row below writes exactly the keys its own
 * shape declares in `avLst` — nothing borrowed from a different preset's
 * guide names, which is the hazard `effectiveAdjOf` above exists to survive
 * even when it DOES happen via a stale hover.
 *
 * NO PLACEMENT KEY (`x`/`y`/`z`/`rotation`/`scale`/`rotationAnchor`/`type`) is
 * written — a preset changes the look, never something the author already
 * placed. `w`/`h` are likewise untouched: unlike a crop-aspect family, none
 * of these rows has a layout claim on the box.
 */
const PRESETS = [
  {
    name: "Steep Tail Callout",
    // NO SUPERLATIVE HERE, BECAUSE THIS SHAPE HAS NO EXTREME TO BE NEAR. This
    // row used to read "adj1 near its negative extreme … adj2 near its own max";
    // wedgeRoundRectCallout's ahLst bounds BOTH axes by the +-2147483647
    // sentinel PowerPoint uses for an unbounded handle, so neither value is near
    // anything. The guides say what they really are: dxPos = w*adj1/100000 and
    // dyPos = h*adj2/100000, the tail tip's offset from the box centre.
    description: "A speech-bubble callout with its pointer thrown far out and down — the tail tip sits 55% of the box width left of centre and 90% of its height below, against defaults of 21% and 63%, so it reads as urgent rather than casual.",
    props: {
      preset: "wedgeRoundRectCallout", adj: { adj1: -55000, adj2: 90000, adj3: 16667 },
      fill: "#f7d842", stroke: "#8a6d00", strokeWidth: 2,
      ...EFFECTS_OFF, shadow: { dx: 3, dy: 5, blur: 10, color: "#000000", opacity: 0.3 },
    },
  },
  {
    name: "Shallow Pie Slice",
    description: "A thin sliver of pie — adj1 at 0 and adj2 pulled down to a 40-degree sweep, styled like a single wedge on a chart rather than a full quadrant.",
    props: {
      preset: "pie", adj: { adj1: 0, adj2: 2400000 },
      fill: "#e0555a", stroke: "#7a1418", strokeWidth: 3,
      ...EFFECTS_OFF,
    },
  },
  {
    name: "Fat-Armed Star",
    description: "A five-point star with its inner radius pulled way out (adj near its declared max of 50000) so the points read as short, blunt spikes instead of the sharp default proportions.",
    props: {
      preset: "star5", adj: { adj: 46000, hf: 105146, vf: 110557 },
      fill: "#f2b632", stroke: "#7a4c00", strokeWidth: 2,
      ...EFFECTS_OFF, bloom: { radius: 18, strength: 0.4 },
    },
  },
  {
    name: "Chevron Banner",
    description: "A chevron pushed to a shallow, wide point (adj low, near 0) so the arrow reads as a flat process-step banner rather than a sharp directional arrow.",
    props: {
      preset: "chevron", adj: { adj: 12000 },
      fill: "#3f7fbf", stroke: "#123a5c", strokeWidth: 2,
      ...EFFECTS_OFF,
    },
  },
  {
    name: "Wide Braced Header",
    // adj1 = 23000 IS A CEILING, NOT A TASTE CHOICE. leftBrace's ahLst bounds
    // adj1 by its own `maxAdj1` guide = q3*h/ss with q3 = min(adj2, 100000-adj2)/2,
    // which at adj2 = 50000 is 25000*h/ss — i.e. exactly 25000 on any box at
    // least as wide as it is tall (ss = min(w,h) = h), and larger only on a tall
    // one. So 23000 is inside the declared range at EVERY aspect ratio, where the
    // 45000 this row shipped with was outside it at the widget's own default box
    // and at the test's: `pin 0 adj1 maxAdj1` silently clamped it to 25000, so the
    // stored number was never the number the shape drew.
    description: "A curly brace opened to a wide bulge (adj1 = 23000, just under the 25000 ceiling its own maxAdj1 guide imposes at adj2 = 50000 on any box at least as wide as it is tall) and centered (adj2 at the midpoint), sized for wrapping a section header rather than a single line.",
    props: {
      preset: "leftBrace", adj: { adj1: 23000, adj2: 50000 },
      fill: "#00000000", stroke: "#2b2b2b", strokeWidth: 4,
      ...EFFECTS_OFF,
    },
  },
  {
    name: "Soft-Cornered Card",
    description: "A rounded rectangle with the corner radius pulled to its declared max (adj = 50000, the largest legal roundRect radius) plus a soft lifted shadow, styled as a UI card rather than a plain box.",
    props: {
      preset: "roundRect", adj: { adj: 50000 },
      fill: "#ffffff", stroke: "#d8dde3", strokeWidth: 1,
      ...EFFECTS_OFF, shadow: { dx: 0, dy: 10, blur: 24, color: "#1a1a2e", opacity: 0.22 },
    },
  },
  {
    name: "Bold Block Arrow",
    description: "A right-arrow block with a thick shaft (adj1 near its 100000 max, so the tail nearly fills the box height) and a short head (adj2 pulled low), reading as a heavy, confident directional callout.",
    props: {
      preset: "rightArrow", adj: { adj1: 85000, adj2: 22000 },
      fill: "#d9502b", stroke: "#5c1f0d", strokeWidth: 3,
      ...EFFECTS_OFF,
    },
  },
  {
    name: "Thick Donut Ring",
    description: "A block arc pushed to a near-full ring (adj1 at 0deg, adj2 swept almost all the way to 359deg) with a thick band (adj3 near its 50000 max), reading as a heavy gauge or progress ring.",
    props: {
      preset: "blockArc", adj: { adj1: 0, adj2: 21000000, adj3: 44000 },
      fill: "#5aa06e", stroke: "#1f3d28", strokeWidth: 2,
      ...EFFECTS_OFF,
    },
  },
  {
    name: "Teardrop Bubble",
    // adj IS ADJUSTABLE HERE, and this row used to say it was not: teardrop's
    // ahLst declares `<ahXY gdRefX="adj" minX="0" maxX="200000">`, so 100000 is
    // its avLst DEFAULT, not "its one legal value" — the row shipped the default
    // back and described the ratio as fixed. At 100000 the pulled corner lands
    // exactly ON the box's top-right corner (dx1 = wd2 by the shape's own
    // guides); 130000 draws it 30% of a half-width further out, which is the
    // tail this look is named for.
    description: "PowerPoint's teardrop with its corner pulled out into a real tail — adj = 130000 of the declared 0..200000 range, against the 100000 default that plants that corner exactly on the box's top-right corner — with a glassy fill and a tight glow.",
    props: {
      preset: "teardrop", adj: { adj: 130000 },
      fill: "#7ec8e3", stroke: "#1c5f7a", strokeWidth: 2,
      ...EFFECTS_OFF, bloom: { radius: 14, strength: 0.35 }, blendMode: "normal",
    },
  },
  {
    name: "Ribbon Banner",
    description: "An up-ribbon opened to a shallow, wide fold (adj1 low near its 0 floor, adj2 pulled toward its 75000 max) so the banner reads as broad and flat, like a title strip rather than a narrow tag.",
    props: {
      preset: "ribbon", adj: { adj1: 6000, adj2: 68000 },
      fill: "#8a4fbf", stroke: "#402764", strokeWidth: 2,
      ...EFFECTS_OFF, shadow: { dx: 0, dy: 4, blur: 8, color: "#000000", opacity: 0.25 },
    },
  },
];

export const pptxPresetPlugin = {
  type: "pptxPreset",
  ephemeral: EPHEMERAL.NONE, // pure vector geometry, correct on the first frame — no async source, no cheap tier to converge from
  title: "PowerPoint Shape",
  insertMenu: "shape", // joins the same Add Shape grid the shapeshifter families populate (core/registry.js INSERT_MENUS)
  icon: "mdi:shape-outline",
  shapePreview: (dim) => {
    const geo = geometryOf({ preset: "roundRect", adj: {}, w: dim, h: dim }, DEFS);
    return { d: geo.subpaths.map((sp) => sp.d).join(" "), fillRule: "nonzero" };
  },
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "pptxPreset", x: 120, y: 120, w: 200, h: 200, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    preset: "roundRect",
    adj: defaultAdjOf("roundRect", DEFS),
    fill: "#7dcfff", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"),
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "preset", label: "Shape", kind: "select", category: "formatting", options: PRESET_NAMES, help: "Which PowerPoint AutoShape geometry this widget draws. Its adjustment handles change to match — drag them on canvas, exactly like in PowerPoint." },
    ...props("fill", "stroke", "strokeWidth"),
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  presets: PRESETS,
  /**
   * Pure function. State -> display-list, ONE PATH OP PER SUBPATH, honouring
   * each subpath's own declared `fill`/`stroke` — see `presetPaintOps`.
   * Effects-wrapped as one unit (all-off = pass-through), so a shadow
   * silhouettes the WHOLE assembled shape rather than each face separately.
   */
  emit(s, _targetWorldIR, world) {
    const geo = geometryOf(s, DEFS);
    if (!geo) return [];
    return applyEffects(presetPaintOps(geo.subpaths, s), s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths`
   * protocol) — this preset's silhouette as cubic contours in box space, from
   * the SAME `geometryOf` emit() draws with, so a keyframed `preset` change
   * (or a change to `ss_*`/`shape`/any other path-morphable widget) flows
   * smoothly instead of snapping. Mirrors plugins/shapeshifter.js's own
   * `morphPaths`, which this widget is the PPTX-import counterpart of.
   *
   * THE PAYLOAD CARRIES EACH SUBPATH'S OWN PAINT, matching what emit() now
   * draws — a `cube`'s three faces morph as three differently-shaded pieces
   * rather than one flat silhouette. Two consequences worth stating, because
   * they are the reason this is not simply `statePaint(s)` on every piece:
   *
   *   THE `statePaint` MARK IS KEPT ONLY WHERE IT IS TRUE. render_gpu/ports.js
   *   rereads a morph's ink from the tweened state ONLY when every piece is
   *   marked (`morphStateInk` / `isStatePainted`), which is sound exactly when
   *   the piece's ink IS the widget's fill/stroke — i.e. a `norm` fill. A SHADED
   *   face's ink is a DERIVED colour, so marking it would make a morph repaint
   *   every face with the flat widget fill and silently undo this whole fix.
   *   Unmarked pieces fall back to the endpoint blend, which is the same route
   *   an SVG icon's per-contour art already takes.
   *   Consequence, stated rather than discovered later: a shape with any shaded
   *   face is no longer "state-inked", so a morph between two such shapes blends
   *   their endpoint colours instead of rereading state. That is correct — there
   *   is no single state colour that describes a three-tone cube — and it only
   *   changes shapes that were being painted WRONG before.
   *
   *   A `fill: "none"` PIECE IS STROKE-ONLY, so its paint carries `fill: null`.
   *   Handing it the widget fill would flood-fill a detail line mid-morph — the
   *   defect this workstream removed from emit(), reintroduced on the morph path.
   */
  morphPaths(s) {
    const geo = geometryOf(s, DEFS);
    if (!geo) return { space: { w: 0, h: 0 }, subpaths: [], fillRule: "evenodd" };
    return morphPayloadFromPaths(
      geo.subpaths.map((sp) => ({ d: sp.d, paint: subpathMorphPaint(sp, s) })),
      { w: s.w ?? 0, h: s.h ?? 0 },
      "evenodd",
    );
  },
  /** Pure function. Why this shape cannot morph YET, or null — mirrors
   * shapeshifter.js's own guard: a degenerate box has no silhouette to hand
   * over. */
  morphNotReady(s) {
    return (s.w ?? 0) > 0 && (s.h ?? 0) > 0 ? null : "a shape with a non-zero width and height (this one is collapsed)";
  },
  cullMargin: effectsCullMargin,
  // NO custom hitTest/closestAnchor: PowerPoint preset geometry can include
  // cubic Beziers and arcs (roundRect's corners, any *Arc/*Callout family),
  // which core/outline.js's polyline-based closestPointOnOutlines/
  // pointInOutlines contract does not accept directly (that machinery is
  // built for the shapeshifter families' own tessellated-polyline
  // generators). Falling back to the registry's bbox default — the WHOLE
  // box counts for hit-testing, and closestAnchor falls back to the box
  // border — is the same choice plugins/svg.js makes for arbitrary vector
  // artwork with no declared hitTest; see registry.js's own docblock ("Absent
  // -> the whole bbox counts, selection-grab parity with every design tool").
  anchors: standardBBoxAnchors,
  /**
   * THE POWERPOINT-MATCHING HANDLES. Derived ENTIRELY from this preset's own
   * `ahLst` (core/pptx/preset_handles.js) — not hand-authored per shape, so
   * all 120 of the 187 presets that declare at least one adjust handle (see
   * that module's header for the coverage count) get correctly-positioned,
   * correctly-inverting handles for free, and the 67 with none return an EMPTY
   * array. Empty, NOT an absent `modifierPoints` key: shapeshifter.js can spread
   * the key conditionally (plugins/shapeshifter.js:1181) because each of its
   * families is its own plugin object, while this is ONE plugin serving all 187
   * presets, so the key cannot vary per preset. Nothing here turns on the
   * difference — the only protocol reading the key's presence is
   * core/registry.js's `pointListEditable`, which also requires a `kind: "list"`
   * Inspector row this widget does not have.
   */
  modifierPoints(s) {
    if ((s.w ?? 0) <= 0 || (s.h ?? 0) <= 0) return [];
    if (parseAhLst(DEFS[s.preset]?.ahLst).length === 0) return [];
    const adj = effectiveAdjOf(s, DEFS);
    const positions = handlePositions(s.preset, adj, s.w, s.h, DEFS);
    return positions.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      // WRITES THE WHOLE `adj` OBJECT, NOT A PATCH — CanvasView.svelte's drag
      // loop shallow-spreads a handle's `apply` result onto item state
      // (`state = {...state, ...partial}`), so returning
      // `{adj: adjFromHandleDrag(...)}` DIRECTLY would be correct ONLY
      // because `adjFromHandleDrag` itself already returns a FULL adj object
      // (it takes the current adj and shallow-copies+updates just the
      // guide(s) its own handle controls — see that function's own
      // docstring), not merely the changed key(s). So the merge this widget
      // needs is already done one call away; re-merging here would be
      // redundant, not protective, and IS omitted.
      apply: (st, desired) => {
        const stAdj = effectiveAdjOf(st, DEFS);
        const nextAdj = adjFromHandleDrag(st.preset, p.id, desired.x, desired.y, stAdj, st.w ?? 0, st.h ?? 0, DEFS);
        return { adj: nextAdj };
      },
      constrain: (st, desired) => {
        // Re-solve, then read the resulting on-canvas position back — this is
        // the shapeshifter.js `constrain` idiom ("segmentAt(...segmentT(...)")
        // applied here: the ALLOWED position is whatever adjFromHandleDrag's
        // own clamped adj actually draws at, so the ghost handle during a drag
        // never disagrees with where `apply` will really leave it.
        const stAdj = effectiveAdjOf(st, DEFS);
        const w = st.w ?? 0, h = st.h ?? 0;
        const nextAdj = adjFromHandleDrag(st.preset, p.id, desired.x, desired.y, stAdj, w, h, DEFS);
        const solved = handlePositions(st.preset, nextAdj, w, h, DEFS).find((q) => q.id === p.id);
        return solved ? { x: solved.x, y: solved.y } : desired;
      },
    }));
  },
  commands: [
    { id: "add-pptx-preset", title: "Add PowerPoint Shape", icon: "mdi:shape-outline", run: (app) => app.armCrosshairPlacement(pptxPresetPlugin) },
  ],
};
