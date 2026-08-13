/**
 * PPTX PRESET SHAPE — a PARAMETRIC widget for PowerPoint's ~187 AutoShapes
 * (`prstGeom prst="..."`), imported and KEPT PARAMETRIC rather than baked to
 * a frozen path. User ruling (verbatim): "all 187 preset shapes should also
 * have the correct handles that powerpoint has too. a lot of these are
 * parametric and they should be treated as such."
 *
 * STATE is `{preset, adj, w, h, ...}` — `preset` a name into
 * `preset_shape_defs.json`'s `shapes` table, `adj` a `{gdName: value}` map of
 * instance-level adjustment overrides in POWERPOINT'S OWN NAMES (`adj`,
 * `adj1`, `hf`, ...  — whatever that preset's `avLst` declares), absent keys
 * falling back to the preset's own `avLst` defaults. TYPE IS `"pptxPreset"`
 * (camelCase) and the `adj` SHAPE IS NAMED, NOT POSITIONAL, deliberately
 * matching `core/pptx_translate/shape_geometry.js`'s `classifyGeometry`
 * (owned elsewhere, built in parallel per the task brief): it already emits
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
 * `core/outline.js`'s hand-authored generators).
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
 * `actionButton*` family, plain connectors, …) declares no `modifierPoints`
 * key at all, exactly as PowerPoint itself offers no yellow diamonds on those.
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
 * for the false start), or (b) growing per-preset dynamic Inspector arrays,
 * which core/registry.js's docblock says this app's Inspector does not
 * support. PowerPoint itself has no such panel either — its ONLY UI for an
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
