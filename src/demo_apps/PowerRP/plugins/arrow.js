/**
 * Arrow widget — endpoints are plain {x, y} pairs whose coordinates, like any
 * numeric property, may be EQUATIONS (THE UNIFICATION): binding an endpoint
 * to an anchor just writes equation strings ("@<itemId>_tm.x") into from/to.
 * By emit time the derivation stage has evaluated every equation, so this
 * plugin only ever sees numbers. Legacy {item, anchor} binding objects are
 * migrated to equation pairs on load (core/expressions.withBindingsMigrated).
 *
 * The arrow has no transform of its own (world == local); shaft drags
 * translate the endpoints directly via the moveBy hook — equation-bound
 * coordinates stay put (they're anchored), free ones translate. The endpoint
 * plumbing (editPoints/moveBy/closestToward + the padded shaft grab) comes
 * from core/endpoints.js — the ONE home shared by all arrow-family widgets.
 *
 * Head parameters (manifest Round 11, "Arrow head parameters"): headLength
 * (tip to base, along the shaft axis) and headWidth (across the base) are
 * INDEPENDENT. The old single `headSize` — really a barb radius at a fixed
 * 0.44 rad flare — was renamed/split; legacy docs migrate via the
 * `legacyKeys` declaration (core/document.withLegacyKeysRenamed applies it
 * at the load boundary; values move verbatim — numbers AND equations).
 *
 * headMode (manifest ARCHITECTURE PLAN #6): none|start|end|both, default
 * "end" (byte-identical to the pre-headMode behavior — no migration needed,
 * a document without the key gets the same rendering via the plugin default).
 * headEnds()/headTriangle()/shaftPullback() are the shared head-geometry
 * helpers (core/endpoints.js) every arrow-family plugin now calls, so the
 * mirrored start-head triangle math is written ONCE, not per plugin.
 *
 * STROKE NAMING MIGRATION (manifest ARCHITECTURE PLAN #6): arrows are
 * line-objects, so color/width become stroke/strokeWidth — aligning with
 * every other stroked shape (rect, circle, donut all use stroke/
 * strokeWidth). Migrated via `legacyKeys`, same declarative mechanism as the
 * headSize rename above; loud per-item console.error comes from the existing
 * withLegacyKeysRenamed call sites (web/main.js, web/app.svelte.js) —
 * nothing in this plugin needs to report anything itself.
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { endpointPairHooks, hitsShaft, headEnds, headTriangle, shaftPullback, HEAD_MODES } from "../core/endpoints.js";

export const arrowPlugin = {
  type: "arrow",
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "arrow", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    // headWidth 12 ≈ the old fixed-flare head's width (2·14·sin(0.44) = 11.93):
    // the default arrow renders visually unchanged by the re-parameterization.
    stroke: "#1a1a2e", strokeWidth: 3, headLength: 14, headWidth: 12, headMode: "end", opacity: 1,
  },
  // Legacy top-level state keys → their current names. headSize was really
  // the head LENGTH (manifest Round 11); color/width → stroke/strokeWidth
  // (manifest ARCHITECTURE PLAN #6, "arrows are line-objects"). Applied
  // document-wide at the load boundary by core/document.withLegacyKeysRenamed;
  // reported loudly there.
  legacyKeys: { headSize: "headLength", color: "stroke", width: "strokeWidth" },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"). Endpoints/z → positioning;
  // stroke/opacity → formatting; head geometry → an "arrow" extras category.
  inspector: [
    // Endpoint rows are equation-aware number fields (dotted keys = nested
    // paths) — the Property Panel shows "@…" bindings as editable equations.
    { key: "from.x", label: "From X", kind: "number", category: "positioning" },
    { key: "from.y", label: "From Y", kind: "number", category: "positioning" },
    { key: "to.x", label: "To X", kind: "number", category: "positioning" },
    { key: "to.y", label: "To Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "stroke", label: "Stroke", kind: "color", category: "formatting" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow" },
    { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow" },
    { key: "headMode", label: "Head", kind: "select", options: HEAD_MODES, category: "arrow" },
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers, and the arrow's world transform is IDENTITY (no
   * x/y/rotation/scale state), so these local commands are world coordinates.
   * A head triangle is emitted per ACTIVE end (headMode); the shaft's own
   * endpoints pull back only on the ends that have one (shaftPullback).
   */
  emit(s) {
    const { from, to } = s;
    const ends = headEnds(s.headMode);
    const opacity = s.opacity ?? 1;
    const pbEnd = shaftPullback(ends.end, s.headLength);
    const pbStart = shaftPullback(ends.start, s.headLength);
    const axisLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / axisLen, uy = (to.y - from.y) / axisLen;
    const shaftFrom = { x: from.x + ux * pbStart, y: from.y + uy * pbStart };
    const shaftTo = { x: to.x - ux * pbEnd, y: to.y - uy * pbEnd };
    const cmds = [polyline({ points: [[shaftFrom.x, shaftFrom.y], [shaftTo.x, shaftTo.y]], width: s.strokeWidth, color: s.stroke, opacity })];
    if (ends.end) cmds.push(polygon({ points: headTriangle(to, from, s.headLength, s.headWidth), fill: s.stroke, opacity }));
    if (ends.start) cmds.push(polygon({ points: headTriangle(from, to, s.headLength, s.headWidth), fill: s.stroke, opacity }));
    return cmds;
  },
  hitTestWorld(node, wx, wy) {
    return hitsShaft(node.state, wx, wy, node.state.strokeWidth ?? 3);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js: draggable endpoint handles, free-coordinate shaft
  // translation, closest-anchor toward-context).
  ...endpointPairHooks(),
  commands: [
    { id: "add-arrow", title: "Add Arrow", icon: "mdi:arrow-top-right", run: (app) => app.addItem(arrowPlugin.defaults) },
  ],
};
