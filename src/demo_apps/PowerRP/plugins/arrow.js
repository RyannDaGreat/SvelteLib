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
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { endpointPairHooks, hitsShaft } from "../core/endpoints.js";

/** Fraction of headLength the shaft stops short of the tip — the shaft end
 * sits INSIDE the head triangle, so shaft and head always overlap seamlessly
 * (and the round cap never pokes past the tip). Same value/semantics as the
 * pre-headWidth geometry (0.6 of the old headSize). */
const SHAFT_PULLBACK = 0.6;

export const arrowPlugin = {
  type: "arrow",
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "arrow", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    // headWidth 12 ≈ the old fixed-flare head's width (2·14·sin(0.44) = 11.93):
    // the default arrow renders visually unchanged by the re-parameterization.
    color: "#1a1a2e", width: 3, headLength: 14, headWidth: 12, opacity: 1,
  },
  // Legacy top-level state keys → their current names (headSize was really
  // the head LENGTH — manifest Round 11). Applied document-wide at the load
  // boundary by core/document.withLegacyKeysRenamed; reported loudly there.
  legacyKeys: { headSize: "headLength" },
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
    { key: "color", label: "Color", kind: "color", category: "formatting" },
    { key: "width", label: "Width", kind: "number", min: 0, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow" },
    { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow" },
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers, and the arrow's world transform is IDENTITY (no
   * x/y/rotation/scale state), so these local commands are world coordinates.
   * Head triangle: tip at `to`, base headLength back along the axis, base
   * corners ±headWidth/2 across it.
   */
  emit(s) {
    const { from, to } = s;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const ux = Math.cos(angle), uy = Math.sin(angle); // unit axis, from → to
    const nx = -uy, ny = ux; // unit normal
    const len = s.headLength, half = s.headWidth / 2;
    const opacity = s.opacity ?? 1;
    const shaftEnd = { x: to.x - ux * len * SHAFT_PULLBACK, y: to.y - uy * len * SHAFT_PULLBACK };
    return [
      polyline({ points: [[from.x, from.y], [shaftEnd.x, shaftEnd.y]], width: s.width, color: s.color, opacity }),
      polygon({
        points: [
          [to.x, to.y],
          [to.x - ux * len + nx * half, to.y - uy * len + ny * half],
          [to.x - ux * len - nx * half, to.y - uy * len - ny * half],
        ],
        fill: s.color, opacity,
      }),
    ];
  },
  hitTestWorld(node, wx, wy) {
    return hitsShaft(node.state, wx, wy, node.state.width ?? 3);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js: draggable endpoint handles, free-coordinate shaft
  // translation, closest-anchor toward-context).
  ...endpointPairHooks(),
  commands: [
    { id: "add-arrow", title: "Add Arrow", icon: "mdi:arrow-top-right", run: (app) => app.addItem(arrowPlugin.defaults) },
  ],
};
