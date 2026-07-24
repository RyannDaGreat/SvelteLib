/**
 * macOS Cursor — a DEMO WIDGET (plugins/demo/, kept out of the core roster) built
 * ON TOP of the SVG widget's capability, WITHOUT importing it (the "no plugin
 * imports another" rule). It composes through the SHARED flatten: it picks a
 * built-in cursor SVG (assets/builtin/cursors/, via render_gpu/gpu/svg_raster.js)
 * and feeds it to the SAME svgToIR both this widget and plugins/svg.js call — so
 * the SVG-flatten logic has ONE home; this widget is a thin curated-picker +
 * one ephemeral behaviour (the beach-ball spin).
 *
 * ── WHY A DEMO WIDGET ─────────────────────────────────────────────────────────
 * The manifest's demo-widget split: the SVG widget is the GENERAL capability
 * ("render any SVG"); the cursor widget is a thin SPECIALIZATION (a curated SVG
 * picker + one behaviour). Composition happens through STATE + shared helpers,
 * never a plugin↔plugin import — exactly the manifest's magnifier→demo plan.
 *
 * ── THE BEACH-BALL SPIN IS EPHEMERAL (not serialized, not keyframed) ──────────
 * Per the user, the spin is EPHEMERAL state — presentation-time animation,
 * identical in kind to the particle emitter's `t`. The render tree stays a pure
 * function of (document, [[slide, alpha]]); the instantaneous rotation angle is
 * an AMBIENT presentation input, derived PER FRAME from the ambient clock
 * (render_gpu/particle_clock.particleTime — a FIXED freeze in the editor / CLI /
 * thumbnails, a wall clock in the presenter). There is NO stored angle, no delta,
 * no keyframe — the angle is recomputed from `t` every emit(), exactly like
 * plugins/particles.js derives its whole picture from (params, t).
 *   - `spin` (boolean) and `spinRevsPerSec` (number) are ORDINARY document state
 *     (keyframable parameters that CONFIGURE the animation);
 *   - the ANGLE they produce is ephemeral (recomputed from `t`).
 * This is the clean particle split: parameters are document state, the
 * instantaneous phase is ambient.
 *
 * Surfaced ONLY via the "Insert Demo Widget" submenu (web/App.svelte) — NO
 * top-level `commands`, keeping the core palette clean (the demo-widget intent).
 * Bare-node-safe at import time (the glob/DOMParser in svg_raster.js are lazy;
 * CURSOR_NAMES is a static list), so plugins/index.js stays node-importable.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
import { bundle, bundleNestedDefaults, customProps, defaultLabel, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { pushTransform, popTransform } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
import { svgToIR, cursorSource, CURSOR_NAMES, SPINNING_CURSOR } from "../../render_gpu/gpu/svg_raster.js";
import { particleTime } from "../../render_gpu/particle_clock.js";

/** Default spin rate in REVOLUTIONS PER SECOND — a smooth, readable turn (~1.3 s
 * per revolution), in the ballpark of the real macOS wait-cursor spin: fast
 * enough to read as "busy", slow enough not to strobe. */
const SPIN_DEFAULT_REVS_PER_SEC = 0.75;

/** Ink for any `currentColor` cursor (the built-in cursors use explicit colors,
 * so this is only a fallback) — the shared INK convention (#1a1a2e). */
const CURSOR_INK = "#1a1a2e";

// The cursor-specific self.* properties. `cursorKind` is a select over the
// built-in library (options derived from the ONE canonical CURSOR_NAMES list —
// add a file to assets/builtin/cursors/ + a name to CURSOR_NAMES and it becomes
// a variant). `spin`/`spinRevsPerSec` are ORDINARY (keyframable) parameters; the
// angle they produce is the EPHEMERAL part (derived from the clock in emit).
const CUSTOM = customProps([
  {
    name: "cursorKind", kind: "select", default: SPINNING_CURSOR,
    options: CURSOR_NAMES, optionLabels: Object.fromEntries(CURSOR_NAMES.map((n) => [n, defaultLabel(n)])),
    label: "Cursor", category: "formatting",
    help: "Which built-in macOS-style cursor to draw, as crisp vector. The beach ball is the classic busy spinner.",
  },
  {
    name: "spin", kind: "checkbox", default: true, label: "Spin", category: "formatting",
    help: "Rotate the cursor continuously (the beach-ball busy spin). The rotation is EPHEMERAL — it animates live in the presenter and shows a representative frozen frame in the editor; it is never keyframed or saved.",
  },
  {
    name: "spinRevsPerSec", kind: "number", default: SPIN_DEFAULT_REVS_PER_SEC, min: 0, label: "Spin speed (rev/s)", category: "formatting",
    help: "How many full turns per second the spin makes (only when Spin is on). Zero holds it still.",
  },
]);

export const cursorPlugin = {
  type: "cursor",
  title: "macOS Cursor",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "cursor", x: 140, y: 140, w: 96, h: 96, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    preserveAspect: true, // a cursor must keep its shape — uniform scale-to-fit
    // ANIMATED (default true): the presenter keeps repainting so the spin
    // advances (the particles/video precedent). Turn off for a static cursor.
    ...defaults("animated", "opacity"), // animated:true, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // cursorKind, spin, spinRevsPerSec
  },
  inspector: [
    ...bundle("positioning"),
    ...CUSTOM.rows, // cursorKind + spin + spinRevsPerSec
    ...props("animated"),
    { key: "preserveAspect", label: "Preserve aspect", kind: "checkbox", category: "formatting", help: "Scale the cursor uniformly to fit the box (keeps its shape). Off stretches it to the box's exact size." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (reads the ambient clock; the RETURNED IR is a pure
   * function of state + the ambient `t`). State → display-list commands (local
   * space). Resolves cursorKind → the built-in SVG string, flattens it through
   * the SHARED svgToIR (same as plugins/svg.js), then — when `spin` is on —
   * wraps the ops in ONE center-pivot rotation whose angle is DERIVED from the
   * ambient clock (ephemeral: no stored angle). Effects wrap the whole thing.
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const src = cursorSource(s.cursorKind ?? SPINNING_CURSOR); // throws loud on a corrupt build (trusted committed assets)
    let ops = svgToIR(src, w, h, { ink: CURSOR_INK, preserveAspect: s.preserveAspect !== false, opacity: s.opacity ?? 1 });
    if (s.spin) {
      // EPHEMERAL angle: recomputed from the ambient clock every frame (NOT
      // document state) — a fixed freeze in the editor/CLI, wall-clock in the
      // presenter. Rotate about the box CENTER via the shared similarity pivot.
      const angle = particleTime() * (s.spinRevsPerSec ?? SPIN_DEFAULT_REVS_PER_SEC) * 2 * Math.PI;
      const spin = T.aboutPivot({ x: 0, y: 0, rotation: angle, scale: 1 }, w / 2, h / 2);
      ops = [pushTransform(spin), ...ops, popTransform()];
    }
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  // NO top-level `commands`: reachable ONLY via the "Insert Demo Widget" submenu
  // (web/App.svelte), keeping the core command palette clean.
};
