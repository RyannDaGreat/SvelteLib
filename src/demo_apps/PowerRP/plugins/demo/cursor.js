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

// ── POINTER PRESETS ──────────────────────────────────────────────────────────
// Order is content: the four plain-arrow treatments from NOTHING to MOST effect, then the
// two transparency cases, then six glyph presets.
//
// WHERE THE NUMBERS COME FROM (sourced, not nudged)
// UNITS — shadow.blur and bloom.radius are Gaussian SIGMAS (paint_skia.js:2944 feeds
//   shadow.blur straight into MaskFilter.MakeBlur), so the measured sigmas transfer with
//   no radius conversion. Every distance is a figure measured on a 32-unit nominal glyph
//   box multiplied by 3, because this widget's shipped box is 96 px.
// THE SHADOW — measured off two shipping vector pointers, and both bake in a CONTACT
//   shadow with essentially zero offset rather than a floating-object one. A desktop
//   theme's arrow: offset (0, +1), two blur passes at sigma 1.0 and 0.6, opacities 0.20
//   and 0.30. A screen recorder's redrawn arrow: no offset at all, sigma 1.5, opacity
//   0.60. Normalised to the 32-unit box that is offset 0..+1, sigma 1.0..2.7, opacity
//   0.20..0.60 — hence 0/3/sigma 3/0.30 for the desktop look and 0/0/sigma 8/0.60 for the
//   recording look. The recorder pushes to 0.60 because a recorded pointer must survive
//   arbitrary video AND chroma subsampling, which can partly destroy a one-unit outline.
// THE HALO — a shipping pointer utility publishes HighlightRadius 30 with a left-click
//   colour of #a6FFFF00, i.e. alpha 0xA6 = 0.651; its wider spotlight is radius 100 at
//   #80FFFFFF = alpha 0.50 over 500 ms. bloom is a blurred COPY of the glyph rather than a
//   filled disc, so radius 30 here is an approximation of that circle's reach, not the
//   circle itself.
// THE SPIN — 1.06 rev/s, measured: a current scalable cursor theme's blocking wait
//   indicator is 59 frames at 16 ms each = 944 ms per revolution, and its secondary busy
//   indicator is authored at exactly the same rate. Cross-checks land in the same band: a
//   web framework's ring spinner at 0.75 s per turn = 1.33 rev/s, a mobile toolkit's
//   indeterminate circular indicator at 1520 deg / 5400 ms = 0.78 rev/s constant. The
//   widget's own 0.75 default sits in the band but is not sourced to anything.
// SPIN RATES ALIAS AT THE EDITOR FREEZE — particleTime() is pinned to EDITOR_FREEZE_TIME
//   = 2 s outside the presenter and the angle is t*revs*2*PI, so the frozen angle is
//   4*PI*revs and TWO RATES 0.5 rev/s APART RENDER IDENTICALLY. Only one spinning preset
//   ships here; a second must not sit a multiple of 0.5 away from 1.06.
// GHOSTING — 0.75 is a real shipped constant (a browser engine's drag-image alpha). The
//   0.35 idle value is NOT: every shipping product HIDES an idle pointer rather than
//   dimming it (at 2.0 s), so no fade end-state is published anywhere. 0.35 is chosen.
// THE INVERTING POINTER — the historical monochrome cursor is a two-plane AND/XOR bitmap
//   whose fourth per-pixel state is literally "reverse screen". A difference blend is the
//   closest this widget has, and it is NOT equivalent: difference(a,b) = |a-b|, so white
//   ink inverts exactly (1-B) while black ink vanishes (|0-B| = B). The description says so.
// THE CROSSHAIR — a shipping crosshair overlay ships at opacity 75%, which is where that
//   value comes from; it carries no shadow because any softness on a reticle is a defect.
//
// preserveAspect is EXCLUDED from every preset: it is the "how the glyph FITS its box"
// knob, which is what flareScale is to the lens flare (SPEC section 5). Position, size and
// rotation are excluded for the same reason. The glyph's COLOUR is not a knob at all — the
// built-in artwork carries its own black-and-white ink.
const MEASURED_SHADOW_BLACK = "#000000"; // every measured pointer shadow is plain black
const NO_SHADOW = { dx: 0, dy: 0, blur: 0, color: MEASURED_SHADOW_BLACK, opacity: 0 };
const NO_INNER_SHADOW = { dx: 0, dy: 0, blur: 0, color: MEASURED_SHADOW_BLACK, opacity: 0 };
const NO_BLOOM = { radius: 10, strength: 0 }; // radius is the shipped default; strength 0 is the gate
// The two measured shadows, at the shipped 96 px box (3x the 32-unit nominal):
const CONTACT_SHADOW = { dx: 0, dy: 3, blur: 3, color: MEASURED_SHADOW_BLACK, opacity: 0.3 };
const RECORDING_SHADOW = { dx: 0, dy: 0, blur: 8, color: MEASURED_SHADOW_BLACK, opacity: 0.6 };
const MEASURED_SPIN_REVS_PER_SEC = 0.75; // the widget's own default, kept where spin is inert

const PRESETS = [
  // ── ONE ROW WAS CUT HERE BY MEASUREMENT, AND THE REASON GENERALISES ─────────
  // "Highlight Halo" modelled the coloured circle a screencast tool draws behind
  // the pointer, as a wide bloom OVER the recording shadow. It was shipped in the
  // design table on the strength of differing from "Recording Pointer" in a whole
  // effect. Rendered, the two are FOUR code values apart at maximum — the same
  // picture. TWO separate reasons, both measured, and neither is "bloom is dead":
  //   COMPOSITIONAL SATURATION. Swept alone against a shadowless pointer, bloom
  //     at radius 30 / strength 0.65 moves maxAbs 38 and mean 2.1 — MORE than
  //     shadow.opacity 0 -> 0.6 moves (maxAbs 40, mean 1.3). But `bloom` is a
  //     blurred copy of the glyph, and this glyph's ink is BLACK, so it is a
  //     black soft spread laid over a black soft spread that has already darkened
  //     those same pixels. Stacking the second is nearly a no-op.
  //   AND THE COLOUR WAS NEVER AVAILABLE. A bloom of black ink cannot be the
  //     "coloured circle" the description leads with, at any strength. R6-25.4:
  //     a description may not lead with an axis the family's probe cannot separate.
  // The general lesson is about the design table, not this row: cursor's
  // distinctness section reasoned from a KNOB matrix ("each differs in at least
  // one whole effect") where every other family in that wave rendered. The one
  // pair certified that way is the one that collided.
  {
    name: "Crisp Pointer",
    description: "The arrow exactly as a compositor draws it with the system shadow switched off: no shadow, no glow, no feather. This is also the documentation convention — an inline pointer glyph used as a noun in a sentence carries no effects at all.",
    props: {
      cursorKind: "default", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: NO_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Contact Shadow Pointer",
    description: "The shadow real desktop pointer artwork bakes in: a one-unit drop and a tight blur at 30% — a contact shadow for figure-ground separation, not a floating object. Measured off a shipping vector cursor and scaled to this widget's 96 px box.",
    props: {
      cursorKind: "default", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: CONTACT_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Recording Pointer",
    description: "A screen recorder's redrawn pointer: no offset at all, a much wider blur, and double the opacity — because a recorded pointer has to survive arbitrary video and chroma subsampling, which can eat the one-pixel outline a desktop pointer relies on.",
    props: {
      cursorKind: "default", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: RECORDING_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Idle Ghost Pointer",
    description: "A pointer part-way through the idle fade, for a still where it should be present but recessive. The two-second idle TIMING is a documented convention; the 35% opacity is not — every shipping product hides an idle pointer rather than dimming it, so no fade value exists to copy.",
    props: {
      cursorKind: "default", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 0.35,
      shadow: NO_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 1.5, blendMode: "normal",
    },
  },
  {
    name: "Drag Ghost Pointer",
    description: "The closed grabbing hand at the exact alpha a browser engine uses for a drag preview — 0.75, a shipped constant rather than a guess — over the desktop contact shadow.",
    props: {
      cursorKind: "handgrabbing", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 0.75,
      shadow: CONTACT_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Inverting Pointer",
    description: "The historical monochrome cursor's fourth state, reverse-screen — visible on any background by construction, and the reason the classic I-beam was readable over black text and white page alike. A difference blend is not identical to it: the white ink inverts exactly, the black ink disappears.",
    props: {
      cursorKind: "textcursor", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: NO_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "difference",
    },
  },
  {
    name: "Text Editing Pointer",
    description: "The I-beam over selectable text, with a soft shadow at zero offset in both axes so the top and bottom crossbeams stay symmetric — an offset shadow makes a thin glyph look bent.",
    props: {
      cursorKind: "textcursor", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: { dx: 0, dy: 0, blur: 3, color: MEASURED_SHADOW_BLACK, opacity: 0.25 }, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Link Finger",
    description: "The pointing hand, which means one thing only — this target is a link — and by convention must never be used for anything else. Carries the desktop contact shadow.",
    props: {
      cursorKind: "handpointing", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: CONTACT_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Busy Disc",
    description: "The blocking wait indicator, spinning at a measured 1.06 revolutions per second — 59 frames at 16 ms is what a shipping cursor theme authors, and independent spinners cluster in the same 0.7-1.35 band. It appears after about two seconds of an unserviced event loop, and while it shows nothing is clickable.",
    props: {
      cursorKind: "beachball", spin: true, spinRevsPerSec: 1.06, animated: true, opacity: 1,
      shadow: CONTACT_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Precision Crosshair",
    description: "A reticle for two-dimensional work at the 75% opacity a shipping crosshair overlay ships with, and with nothing soft on it at all — a shadow or a feather on a reticle destroys the thing it is for. Its hotspot is dead centre, unlike the arrow's.",
    props: {
      cursorKind: "cross", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 0.75,
      shadow: NO_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
  {
    name: "Resize Grip",
    description: "The double-headed diagonal resize arrow, one of twelve resize forms in the built-in set (four edges, four corners, and four double-headed axes), over the desktop contact shadow.",
    props: {
      cursorKind: "resizenorthwestsoutheast", spin: false, spinRevsPerSec: MEASURED_SPIN_REVS_PER_SEC, animated: false, opacity: 1,
      shadow: CONTACT_SHADOW, bloom: NO_BLOOM, innerShadow: NO_INNER_SHADOW, softEdges: 0, blendMode: "normal",
    },
  },
];
export const cursorPlugin = {
  type: "cursor",
  presets: PRESETS,
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
