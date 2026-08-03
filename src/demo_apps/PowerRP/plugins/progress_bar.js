/**
 * ══ DEAD CODE. NOT THE SHIPPED WIDGET, AND NO LONGER THE PARITY BASELINE ═════
 *
 * The `progress_bar` widget SHIPS as a built-in plugin ASSET —
 * `assets/builtin/library/progress_bar.plugin.js`, registered through the sandbox by
 * core/builtin_plugin_assets.js. This module is not on plugins/index.js's roster, so
 * the object it exports is NOT what the editor, the CLI or a render job uses.
 *
 * THIS HEADER USED TO CLAIM TWO JOBS KEPT IT ALIVE. BOTH ARE NOW FALSE, and the
 * correction matters more than the file does — a stale justification is what stops
 * dead code from ever being removed:
 *
 *   1. "THE PARITY BASELINE" — NO. It named tests/builtin_plugin_assets_test.js,
 *      A FILE THAT DOES NOT EXIST. The real gate is the PARITY roster in
 *      tests/builtin_asset_library_test.js, and `progress_bar` was DELIBERATELY
 *      REMOVED from it (that file states the removal and why): the fill
 *      was redrawn on a user report ("looks a little bit weird" at low progress —
 *      it painted as a detached pill outside the track's rounded cap), so the asset
 *      is now the INTERSECTION of the progress rect with the track's rim, emitting
 *      no fill op at all at fraction 0. THIS MODULE STILL DRAWS THE OLD SECOND BOX,
 *      i.e. it is the side carrying the defect. Pinning the asset to it would pin
 *      the bug — which is exactly why that roster dropped it.
 *   2. "ITS PURE HELPER EXPORTS, WHICH OTHER SUITES ALREADY IMPORT" — NO. Exactly
 *      one file imports them (tests/progress_bar_test.js), and the asset does not
 *      and cannot: a sandboxed plugin asset has no import, so it defines its OWN
 *      clamp01/fillRect. The helpers here are shared with nothing.
 *
 * WHAT ACTUALLY KEEPS THE FILE ON DISK, for now: tests/progress_bar_test.js imports
 * it, and that suite's other six assertions are LIVE and valuable — they cover
 * video_scrub's referenceable exports and the `= @clip.progress` binding end to end.
 * Deleting this module means rehoming those first, and its own two helper tests plus
 * the "emit is two boxes" test (which asserts the SUPERSEDED geometry) go with it.
 * That is a small piece of real work, not a delete, so it is left as a named task
 * rather than done halfway here.
 *
 * DO NOT "fix" this file to match the asset. It is not a baseline any more; making
 * the two agree would restore the illusion that something is checking them.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/**
 * PROGRESS BAR widget — literally two boxes. A TRACK rectangle (the full bbox)
 * and a FILL rectangle whose length is `fraction` (0..1) of the track along its
 * orientation. The value the widget is built around is `fraction`: an ordinary
 * equation-bindable number, so it hooks to ANY live source through the universal
 * `=` path — most usefully a video's progress export (`= @clip.progress`, from
 * plugins/video_scrub.js), giving a scrubber a real progress readout.
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `fraction` (0..1, CLAMPED at render) drives the fill length. `orientation` is
 * "horizontal" (fills left→right, default) or "vertical" (fills bottom→top, a
 * rising bar). `trackColor` / `fillColor` paint the two boxes; `cornerRadius`
 * rounds both (pill bars). The bbox w×h IS the track's size — the standard resize
 * handles size the bar, so there is no separate width/height/thickness prop (a
 * horizontal bar is wide-and-short, a vertical one tall-and-narrow).
 *
 * ── WHY A PLAIN NUMBER, NOT A PRESET RANGE ────────────────────────────────────
 * `fraction` is a normal numeric slot (equation-capable, keyframable). Binding it
 * to a video scrubber's `progress` export is exactly the "combination of two
 * boxes with some equations" the widget is for; keyframing it across slides
 * animates a fill on its own. Out-of-range values are clamped at emit (fillLength)
 * rather than rejected, so a bound value that briefly overshoots reads as full/
 * empty instead of erroring.
 *
 * No plugin imports another (composition is through document state + equations):
 * the fill is emitted as a second `rect` op here, NOT by delegating to rect.js.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { rect } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

// ── defaults (no magic numbers) ───────────────────────────────────────────────
const DEFAULT_W = 240;          // a wide, short horizontal bar by default
const DEFAULT_H = 20;
// Black groove (the shared INK default): it is the UNFILLED part of the bar, so
// it must stay visible against the white default camera background — white here
// would make an empty bar disappear.
const DEFAULT_TRACK_COLOR = "#000000";
const DEFAULT_FILL_COLOR = "#7aa2f7";  // accent (matches rect's default fill)
const ORIENTATIONS = ["horizontal", "vertical"];
const ORIENTATION_LABELS = { horizontal: "Horizontal", vertical: "Vertical" };

/**
 * Pure function. Clamps a progress value to the unit interval [0, 1].
 *
 * @param {number} v - a (possibly out-of-range or missing) fraction
 * @returns {number} v clamped to [0, 1]; 0 for a missing/NaN value
 *
 * @example clamp01(0.25) // 0.25
 * @example clamp01(1.5)  // 1
 * @example clamp01(-3)   // 0
 */
export function clamp01(v) {
  return Math.max(0, Math.min(1, v ?? 0));
}

/**
 * Pure function. The FILL rectangle {x, y, w, h} covering `fraction` (clamped to
 * 0..1) of a w×h track, laid out along `orientation`, in LOCAL (top-left-origin)
 * coordinates. Horizontal fills from the LEFT (width = fraction·w). Vertical fills
 * from the BOTTOM upward (height = fraction·h, origin y dropped to h − fillH), so
 * a rising bar grows toward the top the way a thermometer / volume meter reads.
 *
 *   fillLength = fraction · trackLength(axis)
 *
 * @param {number} w - track width (local units)
 * @param {number} h - track height (local units)
 * @param {number} fraction - progress 0..1 (out-of-range clamped)
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {{x: number, y: number, w: number, h: number}} fill rect, local coords
 *
 * @example fillRect(200, 20, 0.25, "horizontal") // {x: 0, y: 0, w: 50, h: 20}
 * @example fillRect(200, 20, 0.75, "horizontal") // {x: 0, y: 0, w: 150, h: 20}
 * @example fillRect(20, 200, 0.25, "vertical")   // {x: 0, y: 150, w: 20, h: 50}
 * @example fillRect(200, 20, 5, "horizontal")    // {x: 0, y: 0, w: 200, h: 20} (clamped to 1)
 * @example fillRect(200, 20, -1, "horizontal")   // {x: 0, y: 0, w: 0, h: 20}   (clamped to 0)
 */
export function fillRect(w, h, fraction, orientation) {
  const f = clamp01(fraction);
  if (orientation === "vertical") {
    const fh = (h ?? 0) * f;
    return { x: 0, y: (h ?? 0) - fh, w: w ?? 0, h: fh };
  }
  return { x: 0, y: 0, w: (w ?? 0) * f, h: h ?? 0 };
}

const CAT = "formatting"; // groups the bar knobs in the Inspector accordion

export const progressBarPlugin = {
  type: "progress_bar",
  ephemeral: EPHEMERAL.NONE,
  title: "Progress Bar",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "progress_bar", x: 100, y: 100, w: DEFAULT_W, h: DEFAULT_H, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation —
    // the rect precedent). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // THE bindable value: progress 0..1. A plain numeric slot (equation-capable),
    // so `= @clip.progress` (a video scrubber's export) drives the fill.
    fraction: 0,
    orientation: "horizontal",
    trackColor: DEFAULT_TRACK_COLOR,
    fillColor: DEFAULT_FILL_COLOR,
    ...defaults("cornerRadius", "opacity"), // cornerRadius:0 (square), opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("transform"),
    { key: "fraction", label: "Fraction", kind: "number", min: 0, max: 1, category: CAT, help: "How full the bar is, 0 to 1. Type a number, or bind it with '=' to a live value — most usefully a video scrubber's progress: = @clip.progress. Keyframe it across slides to animate the fill. Values outside 0..1 are clamped." },
    { key: "orientation", label: "Orientation", kind: "select", options: ORIENTATIONS, optionLabels: ORIENTATION_LABELS, category: CAT, help: "Horizontal fills left to right; vertical fills bottom to top (a rising bar). The bbox size sets the track: make it wide and short for horizontal, tall and narrow for vertical." },
    { key: "trackColor", label: "Track color", kind: "color", category: CAT, help: "The color of the empty groove behind the fill." },
    { key: "fillColor", label: "Fill color", kind: "color", category: CAT, help: "The color of the filled portion." },
    ...props("cornerRadius", { cornerRadius: { label: "Corner radius", category: CAT, help: "Rounds the corners of both the track and the fill — set it near half the bar's thickness for a pill." } }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space): the TRACK rect
   * (the full w×h bbox) then the FILL rect (fraction of the track along the
   * orientation — fillRect). Both share `cornerRadius` (pill bars). Effects (the
   * shared EFFECTS BUNDLE) wrap both ops; all-off = pass-through. A zero-length
   * fill (fraction 0) still emits a degenerate rect the backend skips, so the
   * track alone shows.
   *
   * @param {object} s - the folded, equation-evaluated item state
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const cornerRadius = s.cornerRadius ?? 0;
    const opacity = s.opacity ?? 1;
    const track = rect({ x: 0, y: 0, w, h, cornerRadius, fill: s.trackColor, opacity });
    const f = fillRect(w, h, s.fraction, s.orientation ?? "horizontal");
    // The fill's corners never round MORE than its own extent (a short fill would
    // otherwise over-round into a lens); cap the radius at half the smaller side.
    const fillRadius = Math.min(cornerRadius, Math.min(f.w, f.h) / 2);
    const fill = rect({ x: f.x, y: f.y, w: f.w, h: f.h, cornerRadius: fillRadius, fill: s.fillColor, opacity });
    return applyEffects([track, fill], s, world, { x: 0, y: 0, w, h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — the bar's
  // selectable frame IS its track bounding box.
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const w = state.w ?? 0, h = state.h ?? 0;
    // Clamp the target to the bbox border (the rect convention, square corners).
    return { x: Math.max(0, Math.min(w, local.x)), y: Math.max(0, Math.min(h, local.y)) };
  },
};
