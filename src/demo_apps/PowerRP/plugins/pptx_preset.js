import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { presetShapePath } from "../core/pptx/preset_geometry.js";
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

// ── EFFECTS-BUNDLE IDENTITIES, named for the same reason plugins/group.js
// names them: application is an OVERLAY (applyPreset writes exactly the keys
// in `props`), so a row that omits an effect key keeps whatever the
// PREVIOUSLY HOVERED row left there. Every preset below sets all six —
// including these OFF identities — because this is a whole-LOOK family (each
// row pairs a shape with a full fill/stroke/effects treatment), the same
// completeness rule preset_contract_test.js gate (7) enforces from
// BUNDLES.effects rather than from a transcribed count.
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
 * EVERY `adj` VALUE BELOW WAS VERIFIED AGAINST ITS SHAPE'S OWN `ahLst`
 * min/max (read directly out of core/pptx/preset_shape_defs.json — see this
 * file's test for the bare-node re-check), so a tuned row sits inside
 * PowerPoint's own declared handle range, never merely "a plausible number."
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
    description: "A speech-bubble callout with its pointer dragged in close and sharp — adj1 near its negative extreme pulls the tail almost under the box, adj2 near its own max keeps the tail LONG, so it reads as urgent rather than casual.",
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
    description: "A curly brace opened to its widest declared bulge (adj1 near its 50000 max) and centered (adj2 at the midpoint), sized for wrapping a section header rather than a single line.",
    props: {
      preset: "leftBrace", adj: { adj1: 45000, adj2: 50000 },
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
    description: "PowerPoint's teardrop at its one legal adj (100000, the shape's only declared avLst value — the corner-pull ratio is fixed) with a glassy fill and a tight glow, styled as a liquid drop or map pin.",
    props: {
      preset: "teardrop", adj: { adj: 100000 },
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
  /** Pure function. State -> display-list: every subpath `presetShapePath`
   * returns, joined into ONE path op (PowerPoint preset geometry never mixes
   * fill/stroke per-subpath in a way this app's paint model needs to keep
   * separate — a ring/frame/hole shape's counter subpath is carved by
   * fillRule alone, exactly like the shapeshifter `fillRule: "evenodd"`
   * families), effects-wrapped (all-off = pass-through). */
  emit(s, _targetWorldIR, world) {
    const geo = geometryOf(s, DEFS);
    if (!geo) return [];
    const d = geo.subpaths.map((sp) => sp.d).join(" ");
    return applyEffects([path({
      d, fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      fillRule: "evenodd", // safe superset: a single-subpath shape (the overwhelming majority) renders identically under evenodd and nonzero
      opacity: s.opacity ?? 1,
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths`
   * protocol) — this preset's silhouette as cubic contours in box space, from
   * the SAME `geometryOf` emit() draws with, so a keyframed `preset` change
   * (or a change to `ss_*`/`shape`/any other path-morphable widget) flows
   * smoothly instead of snapping. Mirrors plugins/shapeshifter.js's own
   * `morphPaths`, which this widget is the PPTX-import counterpart of.
   */
  morphPaths(s) {
    const geo = geometryOf(s, DEFS);
    if (!geo) return { space: { w: 0, h: 0 }, subpaths: [], fillRule: "evenodd" };
    return morphPayloadFromPaths(
      geo.subpaths.map((sp) => ({ d: sp.d, paint: statePaint(s) })),
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
   * correctly-inverting handles for free, and the 67 with none simply return
   * an empty array (spread conditionally below, so they carry no
   * `modifierPoints` key at all — the same "absent, not empty-returning"
   * shape shapeshifter.js's own conditional spread uses).
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
