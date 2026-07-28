/**
 * macOS Cursor — a DEMO WIDGET (plugins/demo/, kept out of the core roster) built
 * ON TOP of the SVG widget's capability, WITHOUT importing it (the "no plugin
 * imports another" rule). It composes through the SHARED flatten: it picks a
 * built-in cursor SVG (assets/builtin/cursors/, via render_gpu/gpu/svg_raster.js)
 * and feeds it to the SAME svgToIR both this widget and plugins/svg.js call — so
 * the SVG-flatten logic has ONE home; this widget is a thin curated-picker +
 * one clock-driven behaviour (the beach-ball spin).
 *
 * ── WHY A DEMO WIDGET ─────────────────────────────────────────────────────────
 * The manifest's demo-widget split: the SVG widget is the GENERAL capability
 * ("render any SVG"); the cursor widget is a thin SPECIALIZATION (a curated SVG
 * picker + one behaviour). Composition happens through STATE + shared helpers,
 * never a plugin↔plugin import — exactly the manifest's magnifier→demo plan.
 *
 * ── THE BEACH-BALL SPIN IS RECORDABLE STATE (not serialized, not keyframed) ───
 * The spin is RECORDABLE state (see CLAUDE.md "The three kinds of state"),
 * identical in kind to the particle emitter's `t`: it is NOT derivable from
 * [[slide, alpha]] alone, but it IS a pure function of an ambient presentation
 * time, so it is deterministic given a timeline and therefore reproducible in a
 * recording. The render tree stays a pure function of (document, [[slide,
 * alpha]]); the instantaneous rotation angle is an AMBIENT presentation input,
 * derived PER FRAME from the ambient clock (render_gpu/particle_clock.
 * particleTime — a FIXED freeze in the editor / CLI / thumbnails, a wall clock in
 * the presenter, and a per-frame value the video exporter drives through
 * setParticleTimeOverride). There is NO stored angle, no delta, no keyframe — the
 * angle is recomputed from `t` every emit(), exactly like plugins/particles.js
 * derives its whole picture from (params, t).
 *   - `spin` (boolean) and `spinRevsPerSec` (number) are ORDINARY document state
 *     (keyframable parameters that CONFIGURE the animation);
 *   - the ANGLE they produce is recomputed from `t` and never stored.
 * This is the clean particle split: parameters are document state, the
 * instantaneous phase is ambient. And because the angle is a function of `t`
 * alone — never of the previous frame — frame N renders without frame N-1, so a
 * spinning cursor does not block the frame-range sharding in cli/render_job.js.
 *
 * Surfaced ONLY via the "Add Demo Widget" submenu (web/App.svelte) — NO
 * top-level `commands`, keeping the core palette clean (the demo-widget intent).
 * Bare-node-safe at import time (the glob/DOMParser in svg_raster.js are lazy;
 * CURSOR_NAMES is a static list), so plugins/index.js stays node-importable.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { closestPointOnRectBorder, fitBox } from "../../core/geometry.js";
import { tokenizePathD } from "../../core/svg_paths.js";
import { bundle, bundleNestedDefaults, customProps, defaultLabel, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { pushTransform, popTransform } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
import { svgToIR, cursorSource, CURSOR_NAMES, SPINNING_CURSOR, CURSOR_HOTSPOTS, CURSOR_VIEWBOX } from "../../render_gpu/gpu/svg_raster.js";
import { particleTime } from "../../render_gpu/particle_clock.js";

/** Default spin rate in REVOLUTIONS PER SECOND — a smooth, readable turn (~1.3 s
 * per revolution), in the ballpark of the real macOS wait-cursor spin: fast
 * enough to read as "busy", slow enough not to strobe. */
const SPIN_DEFAULT_REVS_PER_SEC = 0.75;

/** Ink for any `currentColor` cursor (the built-in cursors use explicit colors,
 * so this is only a fallback) — the shared INK convention (#000000). */
const CURSOR_INK = "#000000";

/**
 * Pure function. Maps a cursor's HOTSPOT (its pointing tip, in the shared 0..32
 * viewBox frame — CURSOR_HOTSPOTS) into BOX-LOCAL coordinates, through the SAME
 * letterbox the SVG flatten uses (fitBox for preserveAspect ON; a straight
 * box/viewBox stretch for OFF). This is the widget's registration point: the
 * `hotspot` anchor and the placement anchor both read it, so placing a cursor
 * lands its TIP where you point (not the bounding-box center).
 *
 * Args:
 *   state ({cursorKind, w, h, preserveAspect}): the folded cursor item state
 *
 * Returns:
 *   {x, y}: the hotspot in box-local (0..w × 0..h, y-DOWN) coordinates
 *
 * @example hotspotLocal({cursorKind: "cross", w: 32, h: 32}) // {x: 16, y: 16}
 * @example hotspotLocal({cursorKind: "default", w: 32, h: 32}) // {x: 10, y: 7} (arrow tip)
 * @example hotspotLocal({cursorKind: "default", w: 64, h: 64}) // {x: 20, y: 14} (scaled 2×)
 */
function hotspotLocal(state) {
  const hs = CURSOR_HOTSPOTS[state.cursorKind ?? SPINNING_CURSOR] ?? [CURSOR_VIEWBOX / 2, CURSOR_VIEWBOX / 2];
  const w = state.w ?? 0, h = state.h ?? 0, vb = CURSOR_VIEWBOX;
  if (state.preserveAspect !== false) {
    const fit = fitBox(vb, vb, w, h);
    return { x: fit.offsetX + hs[0] * fit.scale, y: fit.offsetY + hs[1] * fit.scale };
  }
  return { x: hs[0] * (w / vb), y: hs[1] * (h / vb) };
}

/**
 * Pure function. The BOX-LOCAL bounding box of a flattened cursor's drawn
 * geometry (the emit() ops: an optional viewBox→box pushTransform wrapping the
 * `path` ops). Walks each path's `d` (tokenized to coordinate pairs) through the
 * active pushTransform so the result is in the 0..w × 0..h box frame. Used to
 * spin the beach ball about ITS OWN center (not the box center), so the wait
 * spinner rotates in place instead of orbiting. Returns null for an empty op
 * list (caller falls back to the box center).
 *
 * Note: the bezier CONTROL points are included, so the box is a slight superset
 * of the visible ink — exact enough for a rotation pivot (and for the symmetric
 * beach ball the control-point box is centered identically to the ink).
 *
 * @example artworkBounds([{op: "path", d: "M0 0L10 0L10 8L0 8Z"}]) // {minX: 0, minY: 0, maxX: 10, maxY: 8}
 * @example artworkBounds([]) // null
 */
function artworkBounds(ops) {
  let t = { x: 0, y: 0, rotation: 0, scale: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const op of ops) {
    if (op.op === "pushTransform") t = { x: op.x, y: op.y, rotation: op.rotation, scale: op.scale };
    else if (op.op === "popTransform") t = { x: 0, y: 0, rotation: 0, scale: 1 };
    else if (op.op === "path") {
      const nums = tokenizePathD(op.d).filter((v) => typeof v === "number");
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const p = T.apply(t, nums[i], nums[i + 1]);
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); any = true;
      }
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

// The cursor-specific self.* properties. `cursorKind` is a select over the
// built-in library (options derived from the ONE canonical CURSOR_NAMES list —
// add a file to assets/builtin/cursors/ + a name to CURSOR_NAMES and it becomes
// a variant). `spin`/`spinRevsPerSec` are ORDINARY (keyframable) parameters; the
// angle they produce is the RECORDABLE part (recomputed from the ambient clock
// in emit, never stored — deterministic given a timeline, so it records).
const CUSTOM = customProps([
  {
    name: "cursorKind", kind: "select", default: SPINNING_CURSOR,
    options: CURSOR_NAMES, optionLabels: Object.fromEntries(CURSOR_NAMES.map((n) => [n, defaultLabel(n)])),
    label: "Cursor", category: "formatting",
    help: "Which built-in macOS-style cursor to draw, as crisp vector. The beach ball is the classic busy spinner.",
  },
  {
    name: "spin", kind: "boolean", default: true, label: "Spin", category: "formatting",
    help: "Rotate the cursor continuously (the beach-ball busy spin). The rotation is driven by presentation time rather than by a saved value — it animates live in the presenter, records correctly into a video export, and shows a representative frozen frame in the editor; it is never keyframed or saved.",
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
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): mount this
  // widget's canvas-overlay palette. The `floatingToolbar(state)` descriptor below
  // is that palette's CONTENT (the cursor grid); this string is what says the
  // double-click opens it at all.
  activate: "overlay_palette",
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
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the cursor uniformly to fit the box (keeps its shape). Off stretches it to the box's exact size." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (reads the ambient clock; the RETURNED IR is a pure
   * function of state + the ambient `t`). State → display-list commands (local
   * space). Resolves cursorKind → the built-in SVG string, flattens it through
   * the SHARED svgToIR (same as plugins/svg.js), then — for the BEACH BALL ONLY,
   * when `spin` is on — wraps the ops in ONE rotation about the BALL'S OWN CENTER
   * (the flattened-artwork center, so it spins in place, not orbiting) whose
   * angle is DERIVED from the ambient clock (recordable state: no stored angle,
   * but a pure function of `t`, so it records). Every OTHER cursor (arrow,
   * crosshair, I-beam, …) renders STATIC — the wait spinner is the beach ball
   * alone. Effects wrap the whole thing.
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const kind = s.cursorKind ?? SPINNING_CURSOR;
    const src = cursorSource(kind); // throws loud on a corrupt build (trusted committed assets)
    let ops = svgToIR(src, w, h, { ink: CURSOR_INK, preserveAspect: s.preserveAspect !== false, opacity: s.opacity ?? 1 });
    // The spin is the WAIT indicator — it applies ONLY to the beach ball. Any
    // other cursor is a static pointer even if `spin` is on.
    if (s.spin && kind === SPINNING_CURSOR) {
      // RECORDABLE angle: recomputed from the ambient clock every frame (NOT
      // document state) — a fixed freeze in the editor/CLI, wall-clock in the
      // presenter, an exporter-driven `t` in a render. Pivot about the BALL'S OWN
      // center (artwork bbox center), so the ball spins in place; the box center
      // can differ from it.
      const angle = particleTime() * (s.spinRevsPerSec ?? SPIN_DEFAULT_REVS_PER_SEC) * 2 * Math.PI;
      const b = artworkBounds(ops);
      const cx = b ? (b.minX + b.maxX) / 2 : w / 2;
      const cy = b ? (b.minY + b.maxY) / 2 : h / 2;
      const spin = T.aboutPivot({ x: 0, y: 0, rotation: angle, scale: 1 }, cx, cy);
      ops = [pushTransform(spin), ...ops, popTransform()];
    }
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  cullMargin: effectsCullMargin,
  /**
   * Pure function. The 9 standard bbox anchors PLUS a custom `hotspot` anchor at
   * the cursor's pointing tip — so the tip is a first-class, bindable anchor
   * (self.anchors.hotspot) and renders as an X where the cursor actually points.
   */
  anchors(state) {
    const hs = hotspotLocal(state);
    return [...standardBBoxAnchors(state), { id: "hotspot", x: hs.x, y: hs.y }];
  },
  /**
   * Pure function. The widget's PLACEMENT anchor — the local point that lands
   * on the click when the cursor is dropped (the CanvasView placement path reads
   * this; absent → bounding-box center, the universal default). Returning the
   * HOTSPOT makes a placed cursor put its TIP where you point, not its box
   * center — the custom "cursor anchor" the widget carries.
   */
  placementAnchor(state) {
    return hotspotLocal(state);
  },
  /**
   * Pure function (a spec; the SVG strings come from the trusted built-in glob).
   * The declarative FLOATING-TOOLBAR content: a VISUAL GRID of the built-in
   * cursors (each rendered as its own SVG thumbnail), picking one writes
   * `cursorKind`. This is the general floating-toolbar protocol — any plugin may
   * return `{ grid: { property, value, cells } }` and the canvas overlay renders
   * it; the cursor widget uses it so you pick a cursor from a grid, never a
   * dropdown.
   */
  floatingToolbar(state) {
    return {
      grid: {
        property: "cursorKind",
        value: state.cursorKind ?? SPINNING_CURSOR,
        cells: CURSOR_NAMES.map((name) => ({ value: name, label: defaultLabel(name), svg: cursorSource(name) })),
      },
    };
  },
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  // NO top-level `commands`: reachable ONLY via the "Add Demo Widget" submenu
  // (web/App.svelte), keeping the core command palette clean.
};
