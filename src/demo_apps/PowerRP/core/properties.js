/**
 * The SHARED PROPERTY REGISTRY (manifest "SHARED PROPERTY REGISTRY" + "SHARED
 * STYLE BUNDLES"). ONE place where a common property (x, y, opacity, stroke,
 * cornerRadius, seconds, ...) is DEFINED ONCE — its label, control kind,
 * Inspector category, numeric bounds, scrub sensitivity, display unit — and
 * widgets REFERENCE that definition in their row/defaults declarations,
 * overriding only what differs. It subsumes the per-plugin copy-pasted row
 * objects that used to drift out of sync.
 *
 * ── WHY (the problem this solves) ─────────────────────────────────────────────
 * Before this module every plugin hand-wrote its own `defaults` object AND its
 * own `inspector` row array. The SAME nine positioning rows (x/y/w/h/rotation/
 * rotationAnchor.x/rotationAnchor.y/z) and the SAME four stroked-box rows
 * (fill/stroke/strokeWidth/cornerRadius) were literally re-typed in rect,
 * circle, image, video, filmstrip, cropbox, donut, camera... The costs the user
 * hit: (1) an added stroke aspect (dashes/caps/joins are COMING in the Figures
 * wave) would need editing N files; (2) drift bugs — rect's `opacity` default
 * was accidentally swallowed into a trailing line comment and silently went
 * missing while every sibling had it. Centralizing kills both: a new aspect is
 * added to ONE prop def / bundle and every consumer inherits it at once, and
 * there is exactly one source of truth per property so nothing drifts.
 *
 * ── THE NEW-WIDGET / NEW-ASPECT RULE (manifest requirement #4) ─────────────────
 * A future stroke feature (dash/cap/join — the Figures stroke-style system) is
 * added to the `strokedBox` BUNDLE *once* (a new PROP def + its key appended to
 * the bundle's key list, plus the emit-decoration reading it in
 * render_gpu/decorate.js) and EVERY box-like consumer (rect, image, video,
 * filmstrip, crop box, ...) inherits the property row, the default, AND the
 * render decoration together — no per-plugin edits. Likewise a brand-new
 * box-like widget composes the bundle and is stroke-complete for free. This is
 * the whole point: compose, never copy.
 *
 * ── SHAPE CONTRACT (the Inspector needs ZERO changes) ─────────────────────────
 * `props()`/`bundle()` return ROW ARRAYS whose element shape is byte-identical
 * to the plain-object rows plugins used to hand-write:
 *   {key, label, kind, category, min?, max?, display?, scrub?, options?,
 *    optionsFrom?, optionLabels?}
 * web/Inspector.svelte consumes rows purely by field name (row.key, row.label,
 * row.kind, row.category, row.min, ...), so a registry-composed row drives it
 * exactly as a hand-written one did. `defaults()`/`bundleDefaults()` return a
 * flat state fragment ({x: 100, ...}) plugins spread into their `defaults`.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { SHAPE_NAMES, SHAPE_LABELS } from "./shapes.js";
import { checkListDeclaration, LIST_ROW_KIND } from "./lists.js";
import { PERF_FAMILY_IDS, PERF_FAMILY_LABELS } from "./film.js";
import { RAMP_SPACES, RAMP_SPACE_LABELS, DEFAULT_RAMP_SPACE, RAMP_PRESET_LIBRARIES, COLOR_RAMP_LIBRARY } from "./ramps.js";

/**
 * Default scrub coefficient (seconds PER dragged pixel) for TIME-IN-SECONDS
 * numeric rows — the seconds/time UNIT-KIND (manifest 14.6: "a time in seconds
 * property number slider should default to MUCH less sensitivity", the user's
 * SECOND report of this pain). Every seconds row (transition duration, slide
 * autoAdvance, any future time property) inherits it from ONE place, so there is
 * no per-widget patching to drift.
 *
 * WHY THIS VALUE: an unbounded numeric row falls back to 1 unit/px in
 * DraggableNumber — for seconds that is enormous (a 1px twitch = a whole second,
 * and dragging down instantly clamps to 0, which turns any transition into an
 * instant CUT). 0.01 s/px makes a full 100px drag span 1 second — LINKED to the
 * same 100px full-range feel opacity uses (web/NumericField.svelte RANGE_DRAG_PX
 * = 100, coefficient 0.01 over the 0..1 range): a seconds row now scrubs with the
 * same tactile range as a bounded 0..1 slider, one second per 100px. It replaces
 * the old hand-written `scrub: 0.1` on the transition seconds row (Round 12,
 * 10s/100px — still ~10× too coarse; the user reported it a SECOND time).
 *
 * FLAG — PENDING RATIFICATION: 0.01 s/px is at the tight end of the manifest's
 * "~0.01-0.02 s/px" target (100px ≈ 1s). Confirm the feel with the user.
 */
export const SECONDS_SCRUB = 0.01;

/**
 * Default scrub coefficient (UNIT-SPANS per dragged pixel) for an UNBOUNDED
 * NORMALIZED numeric row — the fractions/normalized UNIT-KIND: a knob whose
 * useful domain is ONE unit wide (a 0..1 position or mix, a periodic turn with
 * period 1) but which carries no min AND max, so web/NumericField.svelte cannot
 * range-scale it and DraggableNumber falls back to 1 unit per drag-pixel. A 1px
 * twitch would then fling a light source a whole widget-width or spin a star
 * sphere a full turn. 0.01 unit/px makes a full 100px drag span one unit —
 * the same RANGE_DRAG_PX = 100 feel a bounded 0..1 slider has, so freeing a row
 * of its bounds costs nothing in tactile behavior.
 *
 * WHY IT IS A SECOND CONSTANT AND NOT `SECONDS_SCRUB`. The two are numerically
 * identical (0.01) and derived the same way — the span the row would have had if
 * bounded, divided by RANGE_DRAG_PX — but they are NOT the same quantity:
 * SECONDS_SCRUB is seconds per pixel (span 1 SECOND), this is unit-spans per
 * pixel (span 1 UNIT). Merging them would erase that distinction and invite the
 * next reader to justify a seconds row by a unit-span rationale (or to "retune"
 * one unit-kind and silently move the other). They are kept apart deliberately;
 * if either unit-kind is ever retuned, only its own consumers move.
 *
 * Declared here rather than per-plugin because three widgets (lens flare, sky,
 * mandelbrot) had each hand-written it locally with near-identical docstrings —
 * the exact copy-paste drift this registry exists to kill.
 */
export const UNIT_SPAN_SCRUB = 0.01;

/**
 * THE camera's dither-pattern modes (manifest "CAMERA RENDERING"). "off"
 * disables dithering; "bayer" is an ordered checkerboard threshold matrix;
 * "blueNoise" is a softer, less regular precomputed scatter. The array VALUES
 * are the stored state / equation slugs; DITHER_MODE_LABELS maps each to the
 * human label the Inspector select shows. Single-sourced here so the future
 * dither final-pass (a SEPARATE task — this module only declares the property)
 * and the property row can never disagree on the exact ids.
 */
export const DITHER_MODES = ["off", "bayer", "blueNoise"];
export const DITHER_MODE_LABELS = { off: "Off", bayer: "Bayer", blueNoise: "Blue noise" };

/**
 * THE camera's ANTI-ALIASING quality/algorithm modes (manifest "CAMERA
 * RENDERING"). This SELECT replaces the old `antialias` BOOLEAN (true→"standard",
 * false→"off"; migrated loudly in core/document.js). "off" disables per-draw
 * COVERAGE anti-aliasing so shape/text edges are crisp and jagged (and renders a
 * touch faster); "standard" is today's look — Skia coverage AA on every draw.
 * The array VALUES are the stored state / select ids; ANTIALIAS_MODE_LABELS maps
 * each to the human label. Single-sourced here so the reader
 * (render_gpu/skia/render_settings.cameraAntialias) and the property row can
 * never disagree on the exact ids.
 *
 * SUPERSAMPLE TODO ("high"): a third mode — render the frame at 2× into an
 * offscreen and downsample (spatial supersampling, smoother than coverage AA) —
 * is NOT shipped yet. It is deliberately absent (no fake option, per the user
 * ruling): render_settings.js throws at import if a mode it does not implement
 * appears here. To add it: append "high", give it a label, and thread a
 * supersample factor from render_settings through the three raster sinks
 * (CanvasView/gpuService/CLI) into a 2×-dpr offscreen render + downsample blit.
 */
export const ANTIALIAS_MODES = ["off", "standard"];
export const ANTIALIAS_MODE_LABELS = { off: "Off (crisp)", standard: "Standard" };

/**
 * The video SCRUBBER's past-the-end behavior for its `scrubTime` (resolved
 * against the real clip duration at decode time): "clamp" holds the last frame,
 * "loop" wraps modulo the duration (the graceful "tweening a looping video"
 * answer). Single-sourced here (the option-list home) so the `scrubWrap` row and
 * the render layer (render_gpu/ir.videoFrame, video_registry.resolveScrubTime)
 * agree on the exact ids; ir.js imports this list for its op validation.
 */
export const SCRUB_WRAP_MODES = ["clamp", "loop"];
export const SCRUB_WRAP_LABELS = { clamp: "Clamp (hold last frame)", loop: "Loop" };

/**
 * THE STROKE-CAP modes (the general stroke-trim framework, manifest E.15): how a
 * stroke's FREE ENDS are drawn. Free ends only exist where the outline is OPEN —
 * an open path, or ANY stroke the trim (strokeStart/strokeEnd) has cut, so a
 * closed rect/ellipse at full length shows no cap difference. "flat" is a butt
 * cut flush with the end (today's default for every filled/stroked box — so an
 * ABSENT cap renders byte-identically); "round" adds a half-disc of radius
 * width/2; "taper" ramps the width down to a point over a few stroke-widths (a
 * lifted-brush end, the rp trail demo's size_start/size_end feel).
 *
 * The array VALUES are the stored select ids; STROKE_CAP_LABELS maps each to the
 * human label. Single-sourced here so the two ir/paint readers and the property
 * rows agree on the exact ids (the ANTIALIAS_MODES precedent); render_gpu/ir.js
 * imports this list for its op validation.
 */
export const STROKE_CAP_MODES = ["flat", "round", "taper"];
export const STROKE_CAP_LABELS = { flat: "Flat", round: "Round", taper: "Taper" };
/** The stroke-cap id that is a no-op (flush butt end) — the ABSENT default, so an
 *  untrimmed flat-capped stroke is byte-identical legacy rendering. */
export const STROKE_CAP_FLAT = "flat";

/**
 * THE WIDGET-COMPOSITE BLEND MODES (manifest Round 12D "BLEND MODES", whose
 * spec reads "normal/add/multiply/screen/..." — this is the "..."): how a
 * widget's own draw combines with the backdrop. The user ruling was "everything
 * that Photoshop has, we should have too", so this is Photoshop's layer-blend
 * list — but NOT in Photoshop's order.
 *
 * ORDERED BY EXPECTED FREQUENCY OF USE, THEN GROUPED (the user's second ruling:
 * "Normal, add, and multiply should be the top on the blend modes, because those
 * are the most commonly used ones. Order them by how commonly people would use
 * them. Be logical about it, like group similar things together apart from the
 * top three maybe."). So:
 *
 *   1. THE COMMON TRIO — normal, add, multiply. These three are hoisted OUT of
 *      their Photoshop families to the top because they are what people reach
 *      for. They are NOT also repeated inside their families below: one mode,
 *      one row. (The cost of the hoist is that someone scanning the darkening
 *      group for Multiply does not find it there. The user's ruling takes it,
 *      and the top-three position makes it more findable, not less.)
 *   2..6 THE REMAINING FAMILIES, kept intact so like sits with like, and ordered
 *      by their most-used member: lightening, darkening, contrast, comparative,
 *      component.
 *
 * Within each family the relative order is still Photoshop's — that preserves
 * muscle memory everywhere the frequency ruling does not override it — with ONE
 * deviation: `screen` leads the lightening family instead of `lighten`, because
 * Screen is the most-used mode in the app after the trio (every lens-flare
 * preset composites with it, and it is the standard for glows and light leaks).
 * Lightening precedes darkening for the same frequency reason, and because `add`
 * being in the trio makes lightening the continuing theme.
 *
 * NOTHING MAY DEPEND ON THIS ORDER except the UI listing. The one order
 * assertion in the suites is that "normal" stays FIRST (it is the default);
 * every other consumer looks a mode up by value.
 *
 * THE FAMILIES ARE DECLARED, NOT COMMENTED. The six groups above used to be
 * trailing `// 1: the common trio` comments on a flat array, so the dropdown
 * could only render 26 undifferentiated rows — the families were ORDERED but did
 * not READ as groups. They are now BLEND_MODE_GROUPS, and BLEND_MODES is
 * DERIVED from it by flattening. One declaration therefore fixes both the order
 * AND the group boundaries, so the separators in the UI cannot drift out of step
 * with the list the way a hand-placed index array would the moment someone
 * reorders a family (a hand-maintained mirror has already bitten this codebase).
 *
 * THE ONE HOME. This used to be duplicated as a literal here AND as
 * `render_gpu/ir.js BLEND_MODES` (with a test asserting the two agreed);
 * ir.js now imports THIS list, exactly as it already imports SCRUB_WRAP_MODES
 * above for its own op validation. Array VALUES are the stored state / equation
 * slugs; BLEND_MODE_LABELS maps each to the human label the Inspector shows.
 *
 * BACK-COMPAT IS ABSOLUTE: the four modes that existed before ("normal",
 * "multiply", "add", "screen") keep their EXACT stored spellings, so every
 * existing document renders byte-identically and the repair pipeline has nothing
 * to migrate. In particular "add" is NOT renamed to Photoshop's "linearDodge" —
 * it only gains that human LABEL ("Linear Dodge (Add)"), the storage-key vs
 * label split every other select here uses (ANTIALIAS_MODES, DITHER_MODES).
 *
 * DISSOLVE IS DELIBERATELY ABSENT (the only Photoshop mode missing). It is not
 * a blend function of (backdrop, source) at all: it is a stochastic per-pixel
 * coverage dither, so it cannot be expressed in the composite-op slot this
 * property feeds — and a random one would break the core invariant
 * `RenderTree = pure(document, [[slide, alpha]])`. Offering it as a fake option
 * that silently did nothing is forbidden (the ANTIALIAS_MODES "high" ruling), so
 * it is left out until someone builds it as what it actually is: a seeded
 * coverage effect beside `softEdges`, hashing device position + a seed
 * (the deterministic-hash discipline plugins/demo/glitch.js already sets).
 */
export const BLEND_MODE_GROUPS = [
  { id: "common", title: "Common", options: ["normal", "add", "multiply"] }, // "add" IS Photoshop's Linear Dodge
  { id: "lighten", title: "Lighten", options: ["screen", "lighten", "colorDodge", "lighterColor"] }, // minus the hoisted "add"
  { id: "darken", title: "Darken", options: ["darken", "colorBurn", "linearBurn", "darkerColor"] }, // minus the hoisted "multiply"
  { id: "contrast", title: "Contrast", options: ["overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "hardMix"] },
  { id: "comparative", title: "Comparative", options: ["difference", "exclusion", "subtract", "divide"] },
  { id: "component", title: "Component", options: ["hue", "saturation", "color", "luminosity"] }, // non-separable
];
export const BLEND_MODES = BLEND_MODE_GROUPS.flatMap((group) => group.options);
export const BLEND_MODE_LABELS = {
  normal: "Normal", add: "Linear Dodge (Add)", multiply: "Multiply",
  screen: "Screen", lighten: "Lighten", colorDodge: "Color Dodge", lighterColor: "Lighter Color",
  darken: "Darken", colorBurn: "Color Burn", linearBurn: "Linear Burn", darkerColor: "Darker Color",
  overlay: "Overlay", softLight: "Soft Light", hardLight: "Hard Light", vividLight: "Vivid Light", linearLight: "Linear Light", pinLight: "Pin Light", hardMix: "Hard Mix",
  difference: "Difference", exclusion: "Exclusion", subtract: "Subtract", divide: "Divide",
  hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity",
};

// LOUD IMPORT-TIME GUARD (the render_settings.js ANTIALIAS_MODES precedent): with
// 26 modes, a mode added to BLEND_MODES without a label would show its raw camelCase
// id in the Inspector, and a stale label entry is a mode someone forgot to delete.
for (const mode of BLEND_MODES)
  if (!(mode in BLEND_MODE_LABELS))
    throw new Error(`properties: BLEND_MODES declares "${mode}" but BLEND_MODE_LABELS has no human label for it — add one (the Inspector would show the raw id).`);
for (const mode of Object.keys(BLEND_MODE_LABELS))
  if (!BLEND_MODES.includes(mode))
    throw new Error(`properties: BLEND_MODE_LABELS labels "${mode}", which is not in BLEND_MODES — remove the stale entry.`);

// ── THE "angle" unit-kind + linear-gradient DIRECTION math ───────────────────
// An ANGLE property (kind "angle") is a HEADING, edited by the rotary DIAL
// (web/AngleField.svelte), with the SCREEN convention 0° = +x (right), 90° = +y
// (down) — the SAME convention the particle emitter's `particleAngle` documents,
// so all headings in the app read alike.
//
// STORAGE UNIT IS THE ROW'S BUSINESS, NOT THE KIND'S. The dial always shows
// DEGREES; `display` (web/displayUnits.js) is the bridge, exactly as it is for a
// kind:"number" row. `rotation` stores RADIANS and carries display:"degrees";
// gradient `angle`, `particleAngle` and the halftone screen angles store raw
// degrees and carry no `display`. Nothing about the kind converts anything —
// storage is untouched by adopting the dial.
//
// THE HEADING IS UNBOUNDED (the multi-turn invariant). An angle is NOT folded
// into [0, 360): the manifest requires the transform's rotation to be "an
// unwrapped angle (deltas can spin 720°)", so a keyframe of 720° must tween
// through TWO whole spins. The dial therefore DRAWS wrapDegrees(v) — a needle
// can only point one way — but READS OUT and WRITES the raw value, integrating
// drags through shortestTurn() so turn count survives the gesture. Every
// consumer takes the heading through cos/sin (or wraps internally, like
// angleToLinearEndpoints below), so an unwrapped value renders identically to
// its wrapped congruent.
//
// This is where the LINEAR-GRADIENT DIRECTION lives now. It used to be four
// discrete preset buttons (→ ↓ ↘ ↗) that wrote objectBoundingBox from/to point
// pairs; the user asked for a CONTINUOUS angle instead. `angle` (degrees) is now
// the SINGLE SOURCE OF TRUTH: web/PaintField.svelte writes only `angle` on a dial
// edit, and the renderer DERIVES the objectBoundingBox from/to endpoints from it
// (render_gpu/ir.js linearAxis, via angleToLinearEndpoints). Because a keyframed
// angle is what tweens, 0°→180° interpolates as a rotating axis through 90° (a
// vertical gradient) instead of two endpoints lerping through a degenerate,
// collapsed midpoint. The load-boundary migration (core/document.js
// withLinearGradientAngleMigrated) stamps an `angle` onto every legacy from/to
// doc so old documents render byte-identically; a stored from/to is otherwise
// only a fallback parsePaint uses for an un-migrated in-memory paint.

/** Full turn, in degrees — the modulus for angle wrapping. */
export const FULL_TURN_DEG = 360;
// objectBoundingBox is the unit square [0,1]²; its center is (0.5, 0.5) and each
// axis half-extent is 0.5. Named so the gradient-endpoint math reads clearly.
const BBOX_CENTER = 0.5;
/** Default linear-gradient direction (0° = left→right) — the old freshLinear "→". */
export const GRADIENT_DEFAULT_ANGLE = 0;

// THE LINEAR-GRADIENT CENTER + WAVELENGTH (the gradient-handle feature). A linear
// gradient gained a draggable CENTER (objectBoundingBox 0..1, default box-center)
// and a WAVELENGTH — the fraction of the axis one full colour ramp spans. w=1 with
// the default center reproduces today's whole-box axis EXACTLY (render_gpu/ir.js
// linearGradientRender returns the untouched from/to in that case, so an ABSENT
// center/wavelength is byte-identical to before the feature — the same absent-is-
// legacy precedent as the angle-endpoints migration). w≠1 TILES the ramp with a
// smooth MIRROR repeat centered on `center` (Skia TileMode.Mirror / SVG
// spreadMethod="reflect"); the vector PDF backend cannot express mirror tiling, so
// a w≠1 fill routes to its raster fallback (opHasMirrorLinearFill).
/** Default gradient center (objectBoundingBox) — the box center. */
export const GRADIENT_DEFAULT_CENTER = { x: 0.5, y: 0.5 };
/** Default wavelength: one ramp spans the whole axis (today's behaviour). */
export const GRADIENT_DEFAULT_WAVELENGTH = 1;
/** Smallest wavelength the UI scrubber and the direction handle allow — a floor
 * that keeps the ramp from collapsing to a zero-length (degenerate) axis. Not a
 * hard render bound: parsePaint accepts any positive wavelength and only throws
 * on <= 0 / non-finite. */
export const GRADIENT_MIN_WAVELENGTH = 0.05;

/** Fewest stops a gradient can describe — one colour is a solid, so
 *  render_gpu/ir.js normalizeStops throws below this. It is the list
 *  declaration's `minLength`, so the purge affordance refuses to go under it. */
export const MIN_GRADIENT_STOPS = 2;

/**
 * THE GRADIENT STOP LIST — a LIST DECLARATION (core/lists.js) for the `stops`
 * array inside a paint's gradient sub-state (fill/stroke/background .linear.stops
 * and .radial.stops). It lives HERE, beside the `paint: true` flag and the
 * gradient-direction math, because it describes the PAINT's shape; core/expressions
 * .js imports it to type those slots, exactly as render_gpu/ir.js imports
 * SCRUB_WRAP_MODES / BLEND_MODES from this file rather than keeping a copy.
 *
 * It is NOT a PROPS entry: `stops` is not a top-level property key, it is a leaf
 * inside a paint sub-state (its path is e.g. ["fill", "linear", "stops"]), which is
 * the same reason the paint sub-state kinds are a separate table.
 *
 * SORTED, keyed on `offset` — a stop's position is ABSOLUTE (0..1 along the
 * gradient), so the array order carries no information a user authored and moving
 * one stop past another simply swaps them. MEASURED CAVEAT, recorded in
 * core/lists.js: "sorted" means CANONICALIZED ON WRITE, because the raster/SVG/PDF
 * paths all treat the stored ORDER as authoritative (Skia pins each position to
 * >= the previous, so an out-of-order stop collapses instead of swapping).
 */
/**
 * THE COLOUR-RAMP STOP ELEMENT — the {offset, color} record shape, declared ONCE
 * and referenced by every ramp declaration (the gradient paint's `stops` below
 * and the top-level `rampStops` property). A second copy is exactly how the two
 * would come to disagree about a stop's bounds or its help text, and a stop is
 * the same thing wherever it is stored: a position along a ramp and the colour
 * there.
 *
 * @example RAMP_STOP_ELEMENT.storage // "record"
 * @example RAMP_STOP_ELEMENT.fields.map((f) => f.name) // ["offset", "color"]
 */
export const RAMP_STOP_ELEMENT = {
  storage: "record",
  fields: [
    { name: "offset", kind: "number", min: 0, max: 1, label: "Position", help: "Where this colour sits along the ramp, from 0 (the start) to 1 (the end). When the ramp LOOPS, 0 and 1 are the SAME point on the cycle." },
    { name: "color", kind: "color", label: "Colour", help: "The colour at this position. Lower its alpha for a ramp that fades to transparent." },
  ],
};

export const GRADIENT_STOPS_LIST = {
  kind: LIST_ROW_KIND,
  label: "Stops",
  element: RAMP_STOP_ELEMENT,
  order: "sorted",
  orderKey: "offset",
  activeKey: "stopsActive",
  minLength: MIN_GRADIENT_STOPS,
  presets: COLOR_RAMP_LIBRARY,
  help: "The colours the gradient ramps through. Insert between two stops to get their average position and blended colour; hide a stop to ramp straight past it without losing it.",
};

/** Rounds tiny floating-point dust so cos/sin of the cardinal angles land on
 * exact 0/0.5/1 objectBoundingBox coordinates (e.g. cos(90°) ≈ 6e-17 → 0). */
function tidy(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Pure function. Wraps an angle in degrees into the canonical half-open range
 * [0, 360). Negative and over-full-turn inputs fold in.
 *
 * @example wrapDegrees(370) // 10
 * @example wrapDegrees(-90) // 270
 * @example wrapDegrees(360) // 0
 * @example wrapDegrees(45) // 45
 */
export function wrapDegrees(deg) {
  return ((deg % FULL_TURN_DEG) + FULL_TURN_DEG) % FULL_TURN_DEG;
}

/** Half turn, in degrees — the branch cut shortestTurn folds around. */
export const HALF_TURN_DEG = FULL_TURN_DEG / 2;

/**
 * Pure function. The SHORTEST signed turn congruent to `delta` degrees modulo a
 * full turn — the representative in [-180, 180). This is THE rotary dial's drag
 * integrator (web/AngleField.svelte) and the reason a dial drag cannot destroy
 * keyframe data.
 *
 * WHY (the MULTI-TURN INVARIANT): a dial reads an ABSOLUTE pointer heading,
 * which is only ever known modulo a full turn — so a dial that WRITES the
 * pointer heading directly folds every value into [0, 360), and a rotation
 * keyframed to 720° (two full spins, which the manifest REQUIRES of the
 * transform: "Rotation is an unwrapped angle (deltas can spin 720°)") collapses
 * to 0 — an animation silently reduced to no rotation at all. Integrating the
 * SHORTEST turn from the PREVIOUS value instead accumulates turns: sweeping past
 * the top takes 350 → 370, never 350 → 10. It also removes the ±360 seam jump
 * for free, because no single integrated step is ever more than a half turn.
 *
 * @example shortestTurn(10) // 10
 * @example shortestTurn(350) // -10   (advancing 350° IS retreating 10°)
 * @example shortestTurn(-350) // 10
 * @example shortestTurn(730) // 10    (two whole turns are no turn)
 * @example shortestTurn(0) // 0
 */
export function shortestTurn(delta) {
  return wrapDegrees(delta + HALF_TURN_DEG) - HALF_TURN_DEG;
}

/**
 * Pure function. The objectBoundingBox endpoints {from, to} of a linear gradient
 * whose axis points at `deg` degrees (0° = +x/right, 90° = +y/down). The axis is
 * the CHORD of the unit square through its center along the heading, so the
 * gradient spans the whole box — this reproduces the four legacy presets EXACTLY
 * (→ 0°, ↓ 90°, ↘ 45°, ↗ 315°), which is why migrated documents render
 * unchanged. The chord half-length from the center along a unit direction
 * (dx, dy) inside the unit square is 0.5 / max(|dx|, |dy|) (the nearer wall):
 *
 *     from = center − halfExtent·(dx, dy),   to = center + halfExtent·(dx, dy)
 *
 * Args:
 *   deg (number): heading in degrees (any value; wrapped internally)
 *
 * Returns:
 *   {from: {x, y}, to: {x, y}} — objectBoundingBox (0..1) endpoints
 *
 * @example angleToLinearEndpoints(0)   // {from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}}
 * @example angleToLinearEndpoints(90)  // {from: {x: 0.5, y: 0}, to: {x: 0.5, y: 1}}
 * @example angleToLinearEndpoints(45)  // {from: {x: 0, y: 0}, to: {x: 1, y: 1}}
 * @example angleToLinearEndpoints(315) // {from: {x: 0, y: 1}, to: {x: 1, y: 0}}
 */
export function angleToLinearEndpoints(deg) {
  const rad = (wrapDegrees(deg) * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const halfExtent = BBOX_CENTER / Math.max(Math.abs(dx), Math.abs(dy));
  return {
    from: { x: tidy(BBOX_CENTER - dx * halfExtent), y: tidy(BBOX_CENTER - dy * halfExtent) },
    to: { x: tidy(BBOX_CENTER + dx * halfExtent), y: tidy(BBOX_CENTER + dy * halfExtent) },
  };
}

/**
 * Pure function. The heading in DEGREES [0, 360) of a linear gradient's axis
 * from its objectBoundingBox endpoints — the inverse of angleToLinearEndpoints
 * for DIRECTION (endpoint magnitude/extent is not recovered, only the heading).
 * Used by the dial to show a stored gradient's angle and by the migration to
 * convert legacy from/to → angle.
 *
 * Args:
 *   from ({x, y}): axis start (objectBoundingBox)
 *   to ({x, y}): axis end (objectBoundingBox)
 *
 * Returns:
 *   number: heading in degrees, [0, 360)
 *
 * @example linearEndpointsToAngle({x: 0, y: 0.5}, {x: 1, y: 0.5}) // 0
 * @example linearEndpointsToAngle({x: 0, y: 0}, {x: 0, y: 1}) // 90
 * @example linearEndpointsToAngle({x: 0, y: 0}, {x: 1, y: 1}) // 45
 * @example linearEndpointsToAngle({x: 0, y: 1}, {x: 1, y: 0}) // 315
 */
export function linearEndpointsToAngle(from, to) {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return wrapDegrees(tidy(deg));
}

/**
 * ROW_KINDS — THE Inspector control vocabulary: the complete, closed set of
 * `kind` values a property row may declare. Every name here maps to exactly ONE
 * control in web/Inspector.svelte's field dispatcher, and every control has
 * exactly ONE name — a concept must never be reachable under two spellings, or
 * the two spellings drift apart (which is exactly what happened to the boolean
 * row; see RETIRED_ROW_KINDS).
 *
 *   number  → NumericField (DraggableNumber scrubber / equation editor)
 *   angle   → AngleField (rotary dial; a HEADING shown in degrees, stored in
 *             whatever unit the row's `display` names — see the unit-kind note above)
 *   color   → ColorField, or PaintField when the row is `paint: true`
 *   boolean → BooleanField (the square icon TOGGLE — THE on/off control)
 *   select  → Dropdown over the row's `options`
 *   asset   → AssetField (name + Browse + Upload + drag-drop)
 *   text    → plain text input
 *   action  → a command trigger, not a value slot (group.js "__ungroup")
 *   list    → the VARIABLE-LENGTH element list control: one sub-row per element
 *             per declared element field, plus insert/remove. The row additionally
 *             declares its ELEMENT SHAPE and its ORDER flavour (sorted vs
 *             sequence) — see core/lists.js, which owns that mechanism and whose
 *             checkListDeclaration the import-time guard below runs over every
 *             list row.
 *
 * @example ROW_KINDS.includes("boolean") // true
 * @example ROW_KINDS.includes("checkbox") // false (retired — see RETIRED_ROW_KINDS)
 * @example ROW_KINDS.includes("list") // true
 */
export const ROW_KINDS = ["number", "angle", "color", "boolean", "select", "asset", "text", "action", LIST_ROW_KIND];

/**
 * The row kinds that edit a NUMBER, so a value stored under them has an ORDERING
 * — which is exactly what a SORTED list's key field needs (core/lists.js
 * checkListDeclaration takes this list; a gradient stop's `offset` qualifies, its
 * `color` does not). Kept beside ROW_KINDS because "which controls edit a number"
 * is a fact about the control vocabulary, and core/lists.js deliberately holds no
 * second copy of that vocabulary.
 *
 * @example NUMERIC_ROW_KINDS // ["number", "angle"]
 */
export const NUMERIC_ROW_KINDS = ["number", "angle"];

/**
 * RETIRED_ROW_KINDS — {oldName: canonicalName} for a row kind that has been
 * renamed. It is NOT an accepted spelling: it exists so a guard can say what to
 * write INSTEAD of merely "unknown kind".
 *
 * "checkbox" was the V1 seed's name for the boolean row back when the Inspector
 * really did render `<input type="checkbox">`. That native input was deleted the
 * same day BooleanField.svelte was written (2026-07-14), so the name has
 * outlived its widget by the whole life of the project while half the plugins
 * kept copying it — two names, one concept, and the visual drift the user
 * finally noticed. The manifest names the concept BOOLEAN ("a standard BOOLEAN
 * row control"; "an AssetField, sibling of Numeric/Boolean/ColorField") and this
 * registry has only ever spelled it `boolean`, so `boolean` is canonical.
 *
 * ENFORCEMENT: tests/row_kinds_test.js sweeps EVERY plugin row and rejects any
 * retired spelling (a superset of what customProps() can see, since most rows
 * are written as plain object literals that never pass through this module).
 *
 * @example RETIRED_ROW_KINDS.checkbox // "boolean"
 */
export const RETIRED_ROW_KINDS = { checkbox: "boolean" };

/**
 * Pure function. The SvelteLib Dropdown `items` list for a select row: one
 * {value, label} per option, with a {insert: title} CAPTION row ahead of each
 * family when the row declares `optionGroups`.
 *
 * WHY A ROW DECLARES GROUPS INSTEAD OF THE UI PLACING SEPARATORS. `blendMode`
 * offers 26 options in six families; ordered but unseparated they read as one
 * flat list. The families are declared ONCE (BLEND_MODE_GROUPS) and BOTH the
 * option order and the caption positions are derived from that single
 * declaration here, so a family cannot be reordered into disagreement with its
 * own separator — the failure mode a hand-placed index list has.
 *
 * `insert` is Dropdown's own pre-existing decoration entry (src/lib/Dropdown.
 * svelte, and the sectioned-list recipe in src/demos/Dropdown/Demo.svelte):
 * arrow-key navigation skips it, it cannot be selected, and it never reaches
 * `onpreview` — so hover-preview keeps firing for all 26 real options and for
 * none of the captions. The look is entirely consumer CSS (--dd-insert-*).
 *
 * @param {object} row - a property row: {options, optionLabels?, optionGroups?}
 * @returns {Array<{value: string, label: string}|{insert: string}>}
 *
 * @example selectRowItems({options: ["a", "b"], optionLabels: {a: "A", b: "B"}})
 * // [{value: "a", label: "A"}, {value: "b", label: "B"}]
 * @example selectRowItems({options: ["a", "b"], optionGroups: [{id: "g1", title: "First", options: ["a"]}, {id: "g2", title: "Second", options: ["b"]}]})
 * // [{insert: "First"}, {value: "a", label: "a"}, {insert: "Second"}, {value: "b", label: "b"}]
 * @example selectRowItems({}) // [] (a row with no options offers nothing)
 */
export function selectRowItems(row) {
  const labelled = (value) => ({ value, label: row.optionLabels?.[value] ?? value });
  if (!row.optionGroups) return (row.options ?? []).map(labelled);
  return row.optionGroups.flatMap((group) => [{ insert: group.title }, ...group.options.map(labelled)]);
}

// LOUD IMPORT-TIME GUARD for `optionGroups` (the ANTIALIAS_MODES precedent). The
// groups are the DERIVATION SOURCE of the row's `options`, so the two agreeing is
// not a coincidence to test for — it is the invariant that makes the grouping
// drift-proof, and it fails at boot rather than shipping a dropdown whose
// captions sit one family off. Runs over PROPS below (see the call site).
/**
 * Query (throws). Validates one row's LIST declaration (a no-op for every other
 * kind) — the same loud import-time discipline checkOptionGroups gets, because a
 * list row's ELEMENT SHAPE is what types its per-element `=` slots: a malformed
 * one would leave those slots UNRESOLVED at runtime, far from the declaration.
 * `label` names the declaration in an error; `key` is the property key, checked
 * against the visibility companion's name so the two cannot drift apart.
 */
function checkListRow(label, key, def) {
  if (def.kind !== LIST_ROW_KIND) return;
  checkListDeclaration(label, def, ROW_KINDS, NUMERIC_ROW_KINDS);
  const expected = `${key}${ACTIVE_KEY_SUFFIX}`;
  if (def.activeKey !== expected)
    throw new Error(`properties: ${label} declares activeKey "${def.activeKey}" — a list's visibility companion is named after the list itself, so write "${expected}" (see core/lists.js).`);
  // A `presets` aspect names WHICH preset library the list control offers above
  // its rows (web/ListField.svelte mounts it from the DECLARATION, so a list gets
  // the library by saying so and no mount point owns one privately). An unknown id
  // would silently render no library at all, which is the failure mode this guard
  // exists to make impossible.
  if ("presets" in def && !RAMP_PRESET_LIBRARIES.includes(def.presets))
    throw new Error(`properties: ${label} declares presets "${def.presets}", which is not one of ${JSON.stringify(RAMP_PRESET_LIBRARIES)} — add the library to core/ramps.js RAMP_PRESET_LIBRARIES (and teach web/ListField.svelte to serve it) before declaring it.`);
  // `presetAspectKeys` only means anything to a preset APPLICATION, so declaring it
  // without a library is a declaration that does nothing — reported where it is
  // written rather than discovered as a preset that half-applies.
  if ("presetAspectKeys" in def && !("presets" in def))
    throw new Error(`properties: ${label} declares presetAspectKeys but no \`presets\` library — the aspect map is only read when a preset is applied, so it would do nothing.`);
}

/** How a list's visibility-companion key is spelled: the list key plus this
 *  suffix ("points" → "pointsActive"), so the pair is greppable from either
 *  side and checkListRow can prove the declaration did not drift. */
const ACTIVE_KEY_SUFFIX = "Active";

/** Query (throws). Validates one row's optionGroups against its options. */
function checkOptionGroups(key, def) {
  if (!def.optionGroups) return;
  if (def.kind !== "select")
    throw new Error(`properties: "${key}" declares optionGroups but kind "${def.kind}" — only a select row renders an option list.`);
  const ids = new Set();
  for (const group of def.optionGroups) {
    if (!group.id || !group.title || !Array.isArray(group.options) || group.options.length === 0)
      throw new Error(`properties: "${key}" has a malformed option group (need id, title, non-empty options): ${JSON.stringify(group).slice(0, 120)}`);
    if (ids.has(group.id)) throw new Error(`properties: "${key}" declares option group "${group.id}" twice.`);
    ids.add(group.id);
  }
  const flattened = def.optionGroups.flatMap((group) => group.options);
  if (JSON.stringify(flattened) !== JSON.stringify(def.options))
    throw new Error(`properties: "${key}" optionGroups flatten to [${flattened.join(", ")}] but options is [${(def.options ?? []).join(", ")}] — the groups must BE the option list (derive one from the other; a hand-kept copy drifts).`);
}

/**
 * The property definition table. Each entry is keyed by its property key (the
 * state field / equation slug) and holds the DEFAULT row aspects + an optional
 * `default` value (the fragment default). A widget composes rows/defaults by
 * naming keys; per-widget overrides layer on top (see props()).
 *
 * `kind` — the Inspector control, one of ROW_KINDS (above), which documents
 *   what each name renders. The "angle" KIND is a HEADING edited by a rotary
 *   DIAL (web/AngleField.svelte) that also accepts typed degrees; the dial
 *   shows DEGREES and `display` bridges to whatever the row STORES (radians for
 *   `rotation`, raw degrees for `particleAngle`) exactly as it does for a number
 *   row. The heading is UNBOUNDED, not folded into [0, 360) — see the unit-kind
 *   note above for why (multi-turn keyframes). Its convention matches the
 *   particle emitter's: 0° = +x (right), 90° = +y (down). `category` — the
 *   collapsible-accordion group
 *   (Inspector CATEGORY_ORDER). `min`/`max` — numeric bounds (also drive the
 *   NumericField range-scaled scrub). `scrub` — explicit per-property drag
 *   coefficient (units/px) for UNBOUNDED small-magnitude rows (manifest
 *   "Number-slider sensitivity round 2"). `display` — display-unit id
 *   (web/displayUnits.js), storage stays raw. `help` — a one-to-two-sentence
 *   plain-language explanation of what the property MEANS, shown in the
 *   Inspector's (?) hover chrome (built by another agent — this module just
 *   supplies the text; per-row override allowed). Theory of mind: a first-time
 *   user must LEARN something, so `help` never echoes the label (that class of
 *   tooltip is banned). `default` — the fragment default value; omitted for
 *   keys with no universal default (a widget supplies it).
 *
 * NOTE the two rotation-anchor entries carry a NESTED-KEY convention: their
 * keys contain a dot ("rotationAnchor.x") — the Inspector's valueAt/keyframe
 * paths already split on ".", so a dotted registry key round-trips unchanged.
 */
export const PROPS = {
  // ── positioning (bbox) ──────────────────────────────────────────────────────
  x: { label: "X", kind: "number", category: "positioning", help: "Horizontal position of the widget's top-left corner, in canvas units (right is positive)." },
  y: { label: "Y", kind: "number", category: "positioning", help: "Vertical position of the widget's top-left corner, in canvas units (down is positive)." },
  // NO `min` ON w/h — a NEGATIVE size is meaningful: it is a FLIP (core/geometry.js
  // "THE FLIP"; the Flip Content commands write exactly this, and dragging a resize
  // handle past the opposite edge produces it). A `min: 0` here would have made the
  // Inspector the one place in the app that could not express a flipped widget, and
  // would have silently clamped a legitimate stored value on edit. Contrast the
  // `min: 0` rows below (strokeWidth, blur, radii, rates): for those a negative
  // number has no meaning at all, which is what earns them a bound.
  w: { label: "Width", kind: "number", category: "positioning", help: "How wide the widget is, in canvas units. Drag the side/corner handles to resize instead. A NEGATIVE width flips the widget horizontally — it covers the same area with its content mirrored left ↔ right." },
  h: { label: "Height", kind: "number", category: "positioning", help: "How tall the widget is, in canvas units. Drag the side/corner handles to resize instead. A NEGATIVE height flips the widget vertically — it covers the same area with its content mirrored top ↔ bottom." },
  // THE universal transform rotation, inherited by every bbox widget through the
  // `positioning` bundle. core stores RADIANS; the field edits/shows DEGREES
  // (manifest "Rotation is DEGREES" — round-10 ruling), which is what `display`
  // does — single-sourced here rather than re-typed per widget.
  // kind "angle" (the rotary DIAL) because a rotation IS a heading and the dial
  // is the control for one: the user's "why are we not using that [dial] in the
  // other places we have angles?". Storage is UNCHANGED by that switch (still
  // radians, still `display`-bridged) and the heading stays UNWRAPPED so a
  // 0 → 720° keyframe pair still tweens two whole spins (manifest: "Rotation is
  // an unwrapped angle (deltas can spin 720°)") — see the unit-kind note above.
  rotation: { label: "Rotation", kind: "angle", display: "degrees", category: "positioning", default: 0, help: "Clockwise rotation in degrees, pivoting about the rotation anchor (its own center by default). Drag the dial, or type an exact angle — past 360° keeps counting, so a keyframed 720° spins twice." },
  "rotationAnchor.x": { label: "Rot anchor X", kind: "number", category: "positioning", help: "The X of the point the widget rotates around. Defaults to the widget's own center; set it to another item's anchor to spin about that point." },
  "rotationAnchor.y": { label: "Rot anchor Y", kind: "number", category: "positioning", help: "The Y of the point the widget rotates around. Defaults to the widget's own center; set it to another item's anchor to spin about that point." },
  z: { label: "Z order", kind: "number", category: "positioning", help: "Stacking order: higher numbers draw on top of lower ones. Use Bring to Front / Send to Back to reorder without typing." },
  // Declared here ONLY so core can NAME its kind: Tier 0 says every property is
  // "="-bindable, and resultKindForSlot needs a kind to validate against. There is
  // deliberately NO `default` — nothing composes `active` from a BUNDLES list, and
  // absent-means-visible must keep working for every existing document.
  active: { label: "Visible", kind: "boolean", category: "positioning", help: "Whether the item draws on this slide. Deleting keyframes this off rather than removing the item, so it can come back on a later slide; Purge removes it for good." },

  // ── positioning (endpoint-pair — arrows) ────────────────────────────────────
  "from.x": { label: "From X", kind: "number", category: "positioning", help: "X of the arrow's tail (its start point). Drag the tail handle on canvas, or bind it to an anchor to make it follow another item." },
  "from.y": { label: "From Y", kind: "number", category: "positioning", help: "Y of the arrow's tail (its start point). Drag the tail handle on canvas, or bind it to an anchor to make it follow another item." },
  "to.x": { label: "To X", kind: "number", category: "positioning", help: "X of the arrow's head (its end point). Drag the head handle on canvas, or bind it to an anchor to make it point at another item." },
  "to.y": { label: "To Y", kind: "number", category: "positioning", help: "Y of the arrow's head (its end point). Drag the head handle on canvas, or bind it to an anchor to make it point at another item." },

  // ── formatting: the STROKED-BOX render bundle (fill + border + rounding) ─────
  // These four are the shared box style — the SAME set rect, image, video,
  // filmstrip and the crop box all compose. A future dash/cap/join aspect
  // (Figures stroke-style system) is added HERE (a new PROP + strokedBox key +
  // the emit decoration reading it) and every box inherits it (rule #4 above).
  // `paint: true` marks a color row as PAINT-capable (Axis-1): the Inspector
  // renders PaintField (solid | linear/radial gradient) instead of the plain
  // ColorField. A stored solid string stays byte-identical; a gradient stores a
  // {type,stops,from/to|center/r} object the render/export backends understand.
  fill: { label: "Fill", kind: "color", paint: true, category: "fillMaterial", help: "The color or gradient that fills the widget's interior. Lower a color's alpha for a translucent fill, pick a linear/radial gradient, or set it fully transparent for outline-only." },
  stroke: { label: "Stroke", kind: "color", paint: true, category: "strokeMaterial", help: "The color or gradient of the outline drawn around the widget's edge. Only visible when stroke width is above zero." },
  strokeWidth: { label: "Stroke width", kind: "number", min: 0, category: "strokeMaterial", default: 0, help: "Thickness of the outline in canvas units. Zero means no outline." },
  // THE STROKE ALIGNMENT knob (user ruling: "-1 means completely inner, 1 means
  // completely outer, 0 means the default, which is in the middle... for every
  // stroke thing"). CONTINUOUS, not a three-way select, so it keyframes and takes
  // an equation like any other number; bounded [-1,1] so NumericField range-scales
  // its scrub. NO `default` — absent IS centered (the strokeStart/End
  // absent-is-legacy precedent): nothing bakes it into a widget's state and every
  // existing document renders byte-identically.
  //
  // THE SEMANTICS, once, here: at offset o the ink covers a·w INSIDE the outline
  // and (1−a)·w OUTSIDE it, where a = (1−o)/2. So o=0 ⇒ a=1/2 (half in, half out —
  // exactly Skia's centered stroke), o=−1 ⇒ a=1 (all inside), o=+1 ⇒ a=0 (all
  // outside). render_gpu/ir.js strokeInsideFraction is that formula, single-sourced.
  //
  // CLOSED SHAPES ONLY, and that is not a caveat this row has to apologise for:
  // "inside" is only defined for a closed outline, and EVERY widget that composes
  // strokedBox/strokedBorder is one (rect/circle/image/video/svg/latex/mermaid/…).
  // The open-path widgets — line, arrow, fancy_arrow — emit `polyline`, which has
  // no stroke/strokeWidth pair at all and never composes these bundles, so the row
  // cannot reach them and there is no silent half-effect to warn about.
  // NO explicit `step`, deliberately: it carries no `default`, so defaultStep's
  // precision fallback already resolves to CONTINUOUS scrubbing. opacity and
  // particleFade need `step: 0.01` only because their integer default 1 would
  // otherwise snap them to 0/1 — the tests/default_step_test.js rule, which pins
  // those two as the ONLY number props that may declare one.
  strokeOffset: { label: "Stroke offset", kind: "number", min: -1, max: 1, category: "strokeMaterial", help: "Which side of the edge the outline sits on: -1 draws it fully inside the shape, 0 straddles the edge, +1 draws it fully outside." },
  cornerRadius: { label: "Corner radius", kind: "number", min: 0, category: "formatting", default: 0, help: "Rounds the widget's corners by this radius in canvas units. Zero is a sharp square corner; larger values round more." },

  // ── formatting: THE STROKE-TRIM framework (manifest E.12-15) ─────────────────
  // strokeStart/strokeEnd cut the outline to an arc-length WINDOW so any stroked
  // shape draws on with a plain keyframe; strokePhase rotates where position 0
  // sits (and where a dash pattern begins/collapses) on a closed outline; the two
  // caps decide how the trimmed FREE ENDS look. These are UNIVERSAL stroke
  // options, so they live in the strokedBox/strokedBorder BUNDLES and every
  // stroked box inherits the rows for free (the rule #4 story above, now realized).
  //
  // ABSENT-IS-LEGACY (the gradient center/wavelength precedent, mirrored EXACTLY):
  // NONE of these carries a `default`, so nothing bakes them into a widget's
  // state — an absent strokeStart/End/Phase/cap is the identity (full stroke, flat
  // caps) and renders byte-identically to before the feature. The enable
  // affordance for "cut stroke on/off" (E.12) IS this sparseness: trimming is OFF
  // until the knobs move off full, so there is no separate boolean to disagree
  // with the knobs (a `trim:false` while strokeEnd=0.5 would be meaningless state).
  // render_gpu/ir.js drops any identity field at the op boundary and paint_skia
  // keeps its direct-draw fast path when none are active.
  strokeStart: { label: "Stroke start", kind: "number", min: 0, max: 1, category: "strokeMaterial", help: "Where the drawn outline BEGINS, as a fraction of its total length (0 = the very start, 1 = the very end). Raise it to reveal the stroke from its end inward; keyframe it for a draw-on animation." },
  strokeEnd: { label: "Stroke end", kind: "number", min: 0, max: 1, category: "strokeMaterial", help: "Where the drawn outline ENDS, as a fraction of its total length (1 = fully drawn). Lower it to leave the tail undrawn; keyframe 0 → 1 to draw the stroke on over time." },
  // AN ANGLE PROPERTY (user ruling: "phase can be represented as an angle
  // property") — the rotation dial, stored in DEGREES, unbounded and periodic
  // (370° == 10°; render_gpu/ir.js applyStrokeTrim converts to turns and every
  // consumer wraps via mod1). Keyframing 0° → 360° marches the pattern once
  // around the outline "like a choo-choo train" — the user's spec, verbatim.
  strokePhase: { label: "Stroke phase", kind: "angle", display: "degrees", category: "strokeMaterial", help: "Rotates where position 0 sits along the outline, in degrees — and where a dashed/dotted pattern starts and collapses. Keyframe 0° → 360° and the pattern marches once around the shape like a train on a loop of track; it wraps seamlessly, so 370° looks exactly like 10°." },
  strokeCapStart: { label: "Start cap", kind: "select", options: STROKE_CAP_MODES, optionLabels: STROKE_CAP_LABELS, category: "strokeMaterial", help: "How the START of a trimmed/open stroke is finished: Flat cuts it flush, Round adds a half-disc, Taper narrows it to a point like a lifted brush. No effect on a closed shape drawn at full length (it has no free end)." },
  strokeCapEnd: { label: "End cap", kind: "select", options: STROKE_CAP_MODES, optionLabels: STROKE_CAP_LABELS, category: "strokeMaterial", help: "How the END of a trimmed/open stroke is finished: Flat cuts it flush, Round adds a half-disc, Taper narrows it to a point. No effect on a closed shape drawn at full length (it has no free end)." },

  // ── formatting: opacity ─────────────────────────────────────────────────────
  // Bounded [0,1] → NumericField range-scales its scrub automatically (the fix
  // for opacity "flicking between 0 and 1"; manifest "Number slider
  // sensitivity"). default 1 (fully opaque).
  opacity: { label: "Opacity", kind: "number", min: 0, max: 1, step: 0.01, category: "formatting", default: 1, help: "How see-through the whole widget is, from 0 (invisible) to 1 (fully solid)." },

  // ── formatting: THE CAMERA BACKGROUND — a full PAINT (Axis-1) ────────────────
  // The camera's background IS its fill, so it composes the SAME paint seam as
  // fill/stroke (`paint: true` → the Inspector renders PaintField, not the plain
  // ColorField): Solid / Linear / Radial / `=` equation. Rendered via parsePaint
  // (gradients + equations), NOT parseColor (solid-only). BACK-COMPAT: a stored
  // plain "#rrggbb" string still works untouched — parsePaint treats a bare
  // string/rgba as a solid, byte-identically to the old ColorField behavior.
  background: { label: "Background", kind: "color", paint: true, category: "formatting", help: "The color or gradient painted behind everything in this camera's view — the slide's backdrop in exports and presentation. Lower a stop's alpha for a translucent backdrop, or bind it to an equation." },

  // ── rendering: SCENE-GLOBAL render settings on THE camera (manifest "CAMERA
  // RENDERING") ────────────────────────────────────────────────────────────────
  // These live on THE singleton camera (purgeable:false, exactly one) because
  // they are WHOLE-SCENE render toggles, not per-widget style — a document has
  // one render configuration. If multi-camera is ever introduced they RELOCATE
  // to wherever the scene-global render config then lives (a MOVE, not a
  // redesign). Category "rendering" is their own Inspector accordion group.
  //
  // DEFAULTS MATCH TODAY'S HARDCODED BEHAVIOR so every existing document renders
  // byte-identically until a user changes a knob: antialias "standard" (Skia
  // coverage AA on every draw — paint_skia/text_layout setAntiAlias, wired via
  // render_settings.cameraAntialias), retina ON (core/view dpr =
  // devicePixelRatio), dither OFF.
  antialias: { label: "Anti-aliasing", kind: "select", options: ANTIALIAS_MODES, optionLabels: ANTIALIAS_MODE_LABELS, category: "rendering", default: "standard", help: "How shape and text edges are smoothed. Standard blends edge pixels (the default look). Off gives crisp, pixelated staircase edges and renders a little faster. (A higher-quality supersample mode is planned.)" },
  retina: { label: "Retina (HiDPI)", kind: "boolean", category: "rendering", default: true, help: "Renders at the display's full pixel density (its device pixel ratio) so edges stay sharp on high-DPI screens. Off renders at 1:1 CSS pixels — softer on a Retina display but faster." },
  ditherMode: { label: "Dither", kind: "select", options: DITHER_MODES, optionLabels: DITHER_MODE_LABELS, category: "rendering", default: "off", help: "Scatters pixels between adjacent colors to hide the visible stair-step banding in smooth gradients. Bayer is a fixed ordered checkerboard; blue-noise is a softer irregular scatter; off disables it." },
  ditherEmphasis: { label: "Dither emphasis", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "rendering", default: 1, help: "How strongly the dither pattern is applied. 0 is none, 1 is full strength; above 1 over-emphasizes into pronounced, gritty grain (no upper cap). Only matters when a dither mode is on." },

  // ── shape: the PRESET-SHAPE selector + its adjustable knobs (Wave 2) ─────────
  // Only the `shape` widget (plugins/shape.js) composes these — a single-consumer
  // family that still lives in the registry so its rows/help/bounds are single-
  // sourced like every other. `shape` is a select over the preset names (options
  // + human labels single-sourced in core/shapes.js). `shapePoints` (star points
  // / generic-polygon sides) and `shapeInnerRatio` (star inner-radius fraction)
  // are the adjustable generator knobs; they have no effect on shapes that don't
  // read them (heart, cloud, …) — harmless, like cornerRadius on a square rect.
  shape: { label: "Shape", kind: "select", options: SHAPE_NAMES, optionLabels: SHAPE_LABELS, category: "formatting", default: "star", help: "Which preset silhouette this widget draws. All of them are one vector path, so shadow, glow and border apply the same as any other shape." },
  shapePoints: { label: "Points / sides", kind: "number", min: 2, category: "formatting", default: 5, help: "How many points a star has, or sides a generic polygon has. Ignored by shapes with a fixed outline (heart, cloud, arrows, …)." },
  shapeInnerRatio: { label: "Inner ratio", kind: "number", min: 0, max: 1, category: "formatting", default: 0.5, help: "For a star, how deep the notches cut: the inner radius as a fraction of the outer. Smaller is spikier. Ignored by non-star shapes." },

  // ── geometry: THE VERTEX LIST (a LIST property — core/lists.js) ──────────────
  // The freeform polygon's variable-length vertex list. A SEQUENCE, not a sorted
  // list: the order IS the outline, so sorting the vertices would turn the shape
  // into a different polygon — insert-between means "insert at this index", and
  // reordering is an explicit gesture, never a side effect of dragging a
  // coordinate. Storage is a TUPLE ([x, y] pairs, NOT {x, y} records) and that is
  // load-bearing, not cosmetic: core/interpolators.js interpolate() rounds a lerp
  // between two integers, normalized corners are routinely exactly 0 and 1, and a
  // record would therefore SNAP every vertex tween at alpha 0.5 — see
  // plugins/polygon.js's header and core/lists.js's ELEMENT_STORAGE note.
  // Coordinates are box FRACTIONS (0..1 nominal, deliberately NOT clamped: a
  // vertex may be dragged outside the box), so the fields carry no bounds.
  // No `default` here — the polygon plugin generates its own default pentagon.
  // NO minLength: 0 and 1 vertex are legitimate degenerate states the plugin
  // handles explicitly (it draws nothing and stays selectable).
  points: {
    label: "Points", kind: LIST_ROW_KIND, category: "formatting",
    element: {
      storage: "tuple",
      fields: [
        { name: "x", kind: "number", label: "X", help: "This vertex's horizontal position as a fraction of the widget's box (0 = left edge, 1 = right edge). Values outside 0..1 are allowed — the vertex simply sits outside the box." },
        { name: "y", kind: "number", label: "Y", help: "This vertex's vertical position as a fraction of the widget's box (0 = top edge, 1 = bottom edge). Values outside 0..1 are allowed — the vertex simply sits outside the box." },
      ],
    },
    order: "sequence",
    activeKey: "pointsActive",
    help: "The polygon's corners, in order — the order IS the outline. Insert between two corners to add one at their midpoint; hide a corner to draw straight past it without losing where it was.",
  },

  // ── geometry: THE BEZIER PATH POINT LIST (a LIST property — core/lists.js) ───
  // plugins/paint_path.js's variable-length list of cubic-bezier anchors. A
  // SEQUENCE (the order IS the path, exactly like the polygon's `points`). Storage
  // is a TUPLE [x, y, hx, hy, brk] and that is LOAD-BEARING, not cosmetic:
  // core/interpolators.js interpolate() ROUNDS a lerp between two integers (the
  // tweenline int rule), and normalized anchor coordinates are routinely exactly 0
  // and 1 — so a RECORD, or a MIXED tuple carrying a BOOLEAN `brk`, would recurse to
  // that integer path and SNAP every anchor tween at alpha 0.5. An ALL-NUMBER tuple
  // takes interpolate's pure-numeric-array branch (a plain lerp, NO rounding, 0↔1
  // safe), so `brk` is stored as 0/1 rather than a boolean SPECIFICALLY to keep the
  // tuple numeric — the same reasoning, and conclusion, as the polygon's `points`
  // and the filmstrip's `frames`. (x, y) is the anchor as a box FRACTION; (hx, hy)
  // is its MIRRORED control-handle offset (outgoing control = anchor + handle,
  // incoming = anchor − handle), so every anchor is a smooth C1 point and a zero
  // handle makes a corner; `brk` >= 0.5 STARTS A NEW SUBPATH (the "breaks" that make
  // one widget several strokes). No `default` here — the plugin ships its own curve.
  paintPoints: {
    label: "Path points", kind: LIST_ROW_KIND, category: "formatting",
    element: {
      storage: "tuple",
      fields: [
        { name: "x", kind: "number", label: "X", help: "This anchor's horizontal position as a fraction of the widget's box (0 = left edge, 1 = right edge). Values outside 0..1 are allowed — the anchor simply sits outside the box." },
        { name: "y", kind: "number", label: "Y", help: "This anchor's vertical position as a fraction of the widget's box (0 = top edge, 1 = bottom edge). Values outside 0..1 are allowed — the anchor simply sits outside the box." },
        { name: "hx", kind: "number", label: "Handle X", help: "The horizontal reach of this anchor's mirrored bezier handle, as a box fraction. The outgoing control point sits at anchor + handle and the incoming one at anchor − handle, so the curve stays smooth through the anchor. Zero on both axes makes a sharp corner." },
        { name: "hy", kind: "number", label: "Handle Y", help: "The vertical reach of this anchor's mirrored bezier handle, as a box fraction. The outgoing control point sits at anchor + handle and the incoming one at anchor − handle, so the curve stays smooth through the anchor. Zero on both axes makes a sharp corner." },
        { name: "brk", kind: "number", min: 0, max: 1, label: "New subpath", help: "1 starts a NEW subpath at this anchor — the pen lifts, leaving a gap so the widget draws as several separate strokes; 0 continues the current stroke. (Stored as a number rather than a toggle so the point list tweens exactly, per core/lists.js.)" },
      ],
    },
    order: "sequence",
    activeKey: "paintPointsActive",
    help: "The path's anchors, in order — the order IS the path. Each carries a mirrored bezier handle (drag it on canvas) so the segments curve; a New-subpath flag lifts the pen to start a separate stroke. Insert between two anchors to add one on the curve; hide an anchor to draw straight past it without losing it.",
  },

  // ── formatting: THE COLOUR RAMP (core/ramps.js) ─────────────────────────────
  // A ramp is a stop list PLUS the two aspects that decide how it is READ. It
  // exists as a TOP-LEVEL property family because a ramp is not always a paint:
  // a gradient paint is `ramp + geometry` (a direction dial, a radius), while a
  // Mandelbrot palette is a ramp read cyclically against an escape-time axis and
  // has NO geometry to give — offering it a linear/radial choice would be a false
  // affordance. So the shared thing is the RAMP (user ruling: "The palette in the
  // Mandelbrot viewer could be the same as a gradient selector… make it
  // generalizable… then make them ramp-capable? and make the gradient loop
  // perhaps"), and `paint` composes it with geometry inside its own sub-state.
  //
  // WHAT THIS BUYS, concretely: the palette gains the 343-preset shared library,
  // per-stop `=` equations, per-stop hide/insert/purge through the general list
  // control, and — the capability that did not exist at all — TWEENING. The old
  // palette was a `select` plus a comma-separated `text` override whose own help
  // admitted "Being text, this switches rather than tweens".
  //
  // NO `default` on rampStops: a ramp's colours are the widget's own identity
  // (the Mandelbrot default is gold), exactly as `points` has no universal
  // default pentagon here.
  rampStops: {
    label: "Ramp", kind: LIST_ROW_KIND, category: "formatting",
    element: RAMP_STOP_ELEMENT,
    order: "sorted",
    orderKey: "offset",
    activeKey: "rampStopsActive",
    minLength: MIN_GRADIENT_STOPS,
    presets: COLOR_RAMP_LIBRARY,
    // WHERE A PICKED PRESET'S ASPECTS LAND: a preset record is a whole ramp value
    // ({stops, loop, space}), so applying one must write the aspects too or picking
    // a cyclic OKLab palette would land clamped and muddy. This maps each aspect to
    // its SIBLING state key beside the list — the same declarative shape `activeKey`
    // has, so web/ListField.svelte writes them with no knowledge of what a ramp is.
    // A declaration that OMITS this (the gradient paint's `stops`, which stores no
    // loop/space today) simply has the aspects not written, so a picked gradient
    // changes only the stops, byte-identically to before.
    presetAspectKeys: { loop: "rampLoop", space: "rampSpace" },
    help: "The colours this ramp runs through, and the shared preset library to pick one from. Insert between two stops for their average position and blended colour; hide a stop to ramp straight past it without losing it. Each stop's position and colour is an ordinary keyframable, equation-bindable value, so a ramp TWEENS from slide to slide.",
  },
  // LOOP is a RAMP aspect, not a widget behaviour — which is the whole reason the
  // Mandelbrot palette can now BE a ramp: its cyclicity is mandatory (measured, a
  // 1e-12 frame spans about two iterations, so a ramp stretched across the whole
  // iteration range is one flat colour), and expressing that as `loop: true`
  // costs no special case. A looping LINEAR or RADIAL gradient is a real
  // capability in its own right besides (CSS repeating-linear-gradient,
  // Photoshop's gradient repeat mode).
  // DEFAULT false = today's behaviour exactly (Skia/SVG/PDF gradients clamp), so
  // no existing ramp changes by gaining the property.
  // The exact boundary semantics are ONE paragraph in core/ramps.js's header and
  // are deliberately not restated here; the short form is in `help`.
  rampLoop: { label: "Loop", kind: "boolean", category: "formatting", default: false, help: "Repeats the ramp end to end instead of holding its end colours. The cycle has period 1 and the segment from the LAST stop back to the FIRST is filled in, so a ramp whose stops span 0 to just under 1 loops SEAMLESSLY — put stops at both 0 and 1 to get a hard edge at the seam on purpose." },
  // The interpolation SPACE travels WITH the ramp because it has to: a ramp
  // authored for perceptual blending and read as a direct channel blend is a
  // different ramp. Moving the named palettes into the shared preset library
  // without this would have silently changed how they look in their new home.
  // DEFAULT sRGB = what Skia/SVG/PDF gradients already do, so nothing moves.
  rampSpace: { label: "Blend space", kind: "select", options: RAMP_SPACES, optionLabels: RAMP_SPACE_LABELS, category: "formatting", default: DEFAULT_RAMP_SPACE, help: "How two neighbouring stops are blended. sRGB mixes the stored channels directly (what gradients have always done). OKLab mixes perceptually, so a blend between distant hues stays bright instead of passing through mud — at the cost of not matching a browser gradient exactly." },
  // THE RAMP PHASE — the generalization of the Mandelbrot palette's own
  // `paletteOffset`, whose help already described a phase in as many words:
  // "one full cycle per unit, and it wraps, so 1.25 looks exactly like 0.25".
  // That is exactly `fract(t + phase)` on a period-1 looping ramp, so it is ONE
  // concept and not two; the old key is migrated by the declarative `legacyKeys`
  // rename seam (plugins/demo/mandelbrot.js).
  // `scrub` is MANDATORY and cannot be inferred: the row is unbounded (the
  // rotation is PERIODIC, not large) with a 0 default, so NumericField has no
  // evidence of scale and DraggableNumber would fall back to 1 unit per drag
  // PIXEL — measured, a 100px drag ran 0 → 90 on a knob whose whole domain is one
  // unit wide. UNIT_SPAN_SCRUB makes 100px one full cycle.
  rampPhase: { label: "Phase", kind: "number", scrub: UNIT_SPAN_SCRUB, category: "formatting", default: 0, help: "Rotates the ramp along its own axis — one full cycle per unit, and it wraps, so 1.25 looks exactly like 0.25. KEYFRAME THIS for a colour-cycling animation. It is only periodic when Loop is on; on a clamped ramp it slides the ramp and holds the end colours." },

  // ── time: the SECONDS unit-kind (manifest 14.6) ─────────────────────────────
  // A duration in seconds. Its `scrub` (SECONDS_SCRUB, ~0.01 s/px) is the SANE
  // DEFAULT every seconds row inherits — the fix for the transition seconds slider
  // "jumping by so much" (a bare unbounded number scrubs at 1 unit/px, so a 1px
  // twitch was a whole second and dragging down snapped it to 0 → an instant CUT).
  // `min: 0` (a negative duration is meaningless). Consumers (transition duration,
  // slide autoAdvance) compose this via row("seconds", {...}); `category` is
  // already "transition" here (its current sole home) — a future non-transition
  // time property overrides it.
  seconds: { label: "Seconds", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "transition", help: "How long the transition takes, in seconds. Zero is an instant cut; larger values make the fade or tween slower and smoother." },

  // ── media: source + playback ────────────────────────────────────────────────
  // `src` is the media asset reference (image data URI / URL, video filename).
  // A first-class ASSET row kind (manifest "ASSET property kind" + "ASSET UX
  // ROUND 2"): the AssetField control (web/AssetField.svelte) renders a
  // picker-modal button (filtered to `assetKinds`, reusing the Asset Explorer's
  // tile grid), an upload button, and drag-and-drop acceptance from BOTH the
  // Asset Explorer pane (the ASSET_DRAG_MIME payload) and Finder (raw OS
  // Files — uploads then sets the property). `assetKinds` names which asset
  // KINDS (server asset_kind(): image|video|sound) the field accepts; default
  // ["image"] here, overridden per consumer (video.js/filmstrip.js pass
  // {assetKinds:["video"]}). `assetForm` says what STRING FORM the field writes
  // on pick: "url" (the served /asset/<project>/<file> path — image/video's
  // storage) or "filename" (the bare basename — filmstrip's storage, resolved
  // against the project's assets/). Default "url" — which is now the ONLY form in
  // use: the filmstrip's former "filename" storage existed solely so a SERVER
  // endpoint could resolve the basename, and its frames are decoded in the browser
  // now, so it stores the served URL like every other media widget.
  src: { label: "Source", kind: "asset", assetKinds: ["image"], assetForm: "url", category: "formatting", help: "The image or video this widget shows — pick from the project's assets, upload a file, or drag one in from the Asset Explorer or Finder." },
  // `frames` (the filmstrip's FRAME LIST) is declared with the rest of the
  // filmstrip's rows at the bottom of this registry — it is a LIST, not a count.
  autoplay: { label: "Autoplay", kind: "boolean", category: "formatting", default: true, help: "Start playing as soon as the slide loads. Requires Muted on — browsers block autoplay with sound." },
  loop: { label: "Loop", kind: "boolean", category: "formatting", default: true, help: "Restart the clip from the beginning each time it reaches the end, so it plays forever." },
  muted: { label: "Muted", kind: "boolean", category: "formatting", default: true, help: "Play with no sound. Turn off for audio, but note that browsers won't autoplay an unmuted clip." },
  // `animated` (manifest ANIMATED WIDGET capability): the presenter renders every
  // frame while an animated widget is visible; off = a static widget the
  // presenter can render once and leave alone, saving CPU/battery. Default true
  // for widgets whose content moves on its own (video). Read (evaluated) by the
  // presenter — the presenter agent owns that consumption, this module supplies
  // the property.
  animated: { label: "Animated", kind: "boolean", category: "formatting", default: true, help: "Keeps the presenter redrawing every frame while this widget is on screen (needed for moving content). Turn off to save CPU and battery on a static widget." },
  // THE SCRUBBER'S current time (seconds) — a keyframable, EQUATION-BINDABLE
  // number (leading "=" like any prop). Unlike the video PLAYER (wall-clock
  // playback, no state), the scrubber's displayed frame is the video decoded at
  // THIS time, so it is pure(document, slide, alpha): keyframe it across slides
  // to tween-scrub, or bind it to a shared doc variable so many scrubbers stay
  // frame-locked. scrub = SECONDS_SCRUB (fine drag step, matches the transition
  // "Seconds" row). Default 0 (first frame) — deterministic with no source yet.
  scrubTime: { label: "Time (s)", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "formatting", default: 0, help: "Which moment of the video to show, in seconds — the frame decoded at this time. Keyframe it across slides to scrub as the slide tweens, or bind it (=) to a shared variable so multiple scrubbers stay in sync." },
  // Past-the-end behavior for scrubTime (resolved against the real clip duration
  // at decode time). "clamp" holds the last frame; "loop" wraps modulo duration
  // — the graceful answer to "tweening a looping video".
  scrubWrap: { label: "Past end", kind: "select", options: SCRUB_WRAP_MODES, optionLabels: SCRUB_WRAP_LABELS, category: "formatting", default: "clamp", help: "What to show when the time goes past the end of the clip: Clamp holds the last frame; Loop wraps back to the start (so a tweening time scrubs the clip over and over)." },

  // ── formatting: EDGE-CROP INSETS (manifest "Edge-crop insets") ──────────────
  // Four per-edge inset amounts (canvas units) that trim the media's SOURCE from
  // each side — a source-rect crop, NOT a stretch: the drawn quad shrinks by the
  // inset and the texture's sampled region contracts to match, so what remains
  // stays at its original scale (cheap quad+UV math, no clip pipeline). STORAGE
  // keys are camelCase cropTop/cropLeft/cropRight/cropBottom; the equation
  // grammar DISPLAYS them snake_case (crop_top/crop_left/…) automatically via
  // camelToSnake (verified bijective — core/expressions.js). min 0, default 0 →
  // an all-zero crop is byte-identical to no crop (the emit fast-path skips it).
  // Composed into image + video (a still/moving photo you want to trim); GROUPS
  // get this bundle too per the spec, but the group widget's subtree-crop
  // consumption is a separate agent's follow-up — this module only DEFINES the
  // bundle. Filmstrip is intentionally left out for now (its frames are already
  // an evenly-sampled selection of the clip; a per-edge pixel crop of the strip
  // would fight that resampling — flagged, revisit if the user wants it).
  cropTop: { label: "Crop top", kind: "number", min: 0, category: "formatting", default: 0, help: "Trims this many canvas units off the TOP of the source media (a crop, not a squash) — the rest keeps its scale." },
  cropLeft: { label: "Crop left", kind: "number", min: 0, category: "formatting", default: 0, help: "Trims this many canvas units off the LEFT of the source media (a crop, not a squash) — the rest keeps its scale." },
  cropRight: { label: "Crop right", kind: "number", min: 0, category: "formatting", default: 0, help: "Trims this many canvas units off the RIGHT of the source media (a crop, not a squash) — the rest keeps its scale." },
  cropBottom: { label: "Crop bottom", kind: "number", min: 0, category: "formatting", default: 0, help: "Trims this many canvas units off the BOTTOM of the source media (a crop, not a squash) — the rest keeps its scale." },

  // ── effects: the EFFECTS BUNDLE (manifest Round 12D — shadow/bloom/blend) ────
  // ONE substrate, three effects, every drawn widget (render half:
  // render_gpu/effects.js applyEffects — the module header there records which
  // widgets compose this and why the rest are excluded). DEFAULTS = EFFECT-OFF
  // (shadow OPACITY 0 / bloom strength 0 / blendMode normal) so every old
  // document renders byte-identically (the Round 12D requirement). Nested dotted
  // keys, the rotationAnchor.{x,y} precedent — Inspector paths/keyframes/
  // equations all split on "." (equations read them as shadow.dx etc.).
  //
  // SHADOW GATE (manifest 14.8, user verbatim: "shadow should default x and y
  // to 0 and blur should be allowed to be 0 and still visible - but shadow
  // opacity = 0 gates whether we render it which is by default 0"): shadow.dx/dy
  // default 0 (no offset), shadow.opacity default 0 (THE render gate — off).
  // blur default 0 is now LEGAL AND VISIBLE (opacity>0, blur 0 = a hard-edged
  // tinted offset silhouette; the GPU shader clamps sigma to 0.01 so a 0-blur
  // shadow is a crisp copy, and no backend gates the shadow on blur).
  //
  // Enabled-state (color/bloom) defaults are LINKED PRECEDENTS (arbitrary-
  // constants rule): color black = refs/Figures/paper_peacock.py's production
  // call with_drop_shadows(color='black'); bloom radius 10 = rp
  // with_drop_shadow's blur=10 default (the same Gaussian-sigma family; rp
  // r.py:5002). Blur/radius are Gaussian SIGMAS in world units — the
  // blurBackdrop radius convention (render_gpu/ir.js).
  //
  // SHADOW OPACITY HAS NO CEILING (user verbatim: "It should be possible to have
  // a shadow opacity greater than 1. Like, why not? The alpha blending equation
  // would allow it, wouldn't it?" / "lift the shadow opacity ceiling"). It is a
  // COVERAGE MULTIPLIER, not an alpha byte: the render half computes the final
  // coverage as min(1, colorAlpha · opacity · silhouetteCoverage), so past 1 the
  // shadow OVERDRIVES — the fully covered core is already at the shadow colour
  // and cannot change, while the soft penumbra is driven to full strength, which
  // HARDENS the falloff. Same gesture, same mechanism and the same open-topped
  // declaration as `bloom.strength` right below ("higher over-glows"): a
  // colour-matrix scale on the effect composite, ceiling-free, min 0 only. The
  // old `max: 1` was an invented bound AND (until this round) a lie: the value
  // was folded into an 8-bit tint alpha that pinned at 1, so anything above it
  // was byte-identical to 1 — see render_gpu/skia/paint_skia.js
  // handleEffectSubtree / drawInnerShadow for the mechanism and the proof gate
  // in render_gpu/tests/shadow_overdrive_test.js.
  //
  // WHY NOT CLAMP AT THE SATURATION POINT. There IS a real one: coverage lives
  // in an 8-bit alpha channel, so its smallest non-zero value is 1/255 and any
  // multiplier ≥ 255 drives EVERY reachable pixel to full coverage — 255 and
  // 1e6 render byte-identically, and 254 does NOT (both measured, and both
  // asserted in shadow_overdrive_test.js). That bound is a property of the
  // current render target's bit depth, not of the document, so baking it into
  // the file format's schema would be writing a device detail into the data.
  // Above it the knob is idempotent, which is a no-op and not a failure, so
  // there is nothing to report either (it is also keyframable and equation-
  // driven — an animation ramping past it must not spam the console).
  //
  // The bound the RENDERER does care about is the cull halo, and it needs no
  // change: overdrive cannot push visible shadow past BLUR_SUPPORT_SIGMAS·σ
  // (render_gpu/ir.js) because a Gaussian edge profile ½·erfc(d/(σ√2)) at 3σ is
  // 0.00135, which QUANTIZES TO BYTE 0 in the coverage channel — a pixel storing
  // zero coverage can never be resurrected by any multiplier. The saturated
  // shadow's visible edge lands at ≈2.9σ (where the byte first reaches 1), just
  // inside the existing margin.
  //
  // Both opacity rows declare `scrub: UNIT_SPAN_SCRUB` — the documented cost of
  // freeing a normalized row of its bounds (that constant's own docstring: "so
  // freeing a row of its bounds costs nothing in tactile behavior"). It
  // reproduces EXACTLY the sensitivity the removed `max` used to imply, since
  // NumericField derived (max − min)/RANGE_DRAG_PX = 1/100 = UNIT_SPAN_SCRUB;
  // without it a 0-default unbounded row falls back to 1 unit/px and the control
  // would flick 0↔1 in a single pixel (src/lib/numberStep.js's doctrine — a
  // 0 default is "doubly mute" there and nothing can rescue it but a declared
  // scrub).
  "shadow.dx": { label: "Shadow X", kind: "number", category: "effects", default: 0, help: "How far the drop shadow shifts horizontally, in canvas units (positive is right). The shadow appears once Shadow opacity is above zero." },
  "shadow.dy": { label: "Shadow Y", kind: "number", category: "effects", default: 0, help: "How far the drop shadow shifts vertically, in canvas units (positive is down). The shadow appears once Shadow opacity is above zero." },
  "shadow.blur": { label: "Shadow blur", kind: "number", min: 0, category: "effects", default: 0, help: "How soft the drop shadow is (Gaussian blur amount, canvas units). Zero is a crisp, hard-edged shadow — the shadow is on whenever Shadow opacity is above zero, softness is separate." },
  "shadow.color": { label: "Shadow color", kind: "color", category: "effects", default: "#000000", help: "The drop shadow's color — classically black, but any color works (a colored glow-like shadow, for instance)." },
  "shadow.opacity": { label: "Shadow opacity", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "effects", default: 0, help: "How dark the drop shadow is: 0 is invisible (NO shadow — the default) and 1 is the fully solid shadow color. NO UPPER CAP — above 1 the shadow OVERDRIVES: the solid core cannot get darker, but the soft penumbra is driven to full strength too, so the falloff hardens (past about 255 nothing more can change — every pixel the shadow reaches is already solid). This is the shadow's on/off gate: raise it above 0 to turn the shadow on." },
  "bloom.radius": { label: "Bloom radius", kind: "number", min: 0, category: "effects", default: 10, help: "How far the bloom glow spreads (Gaussian blur amount, canvas units). Takes effect once Bloom strength is above zero." },
  "bloom.strength": { label: "Bloom strength", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "effects", default: 0, help: "How bright the glow is: a blurred copy of the widget added on top of itself. Zero means NO bloom; 1 adds a full-brightness copy; higher over-glows." },

  // ── effects: INNER SHADOW (the effects bundle's fourth effect) ──────────────
  // A shadow cast INSIDE the widget's own silhouette (a recess/inset look — the
  // shape appears pressed INTO the page), the exact mirror of the drop shadow
  // above. It joins the SAME effects bundle so ANY drawn vector object inherits
  // it for free, is rendered in the SAME per-widget effect pass (the render half:
  // render_gpu/effects.js applyEffects wraps the content in ONE effectSubtree op;
  // the Skia backend darkens the widget's interior edge from the offscreen
  // silhouette — see render_gpu/skia/paint_skia.js drawInnerShadow), and its
  // params are ordinary effect props (equation-bindable through the universal `=`
  // path, no engine change). It adds NO outward halo (it is clipped INSIDE the
  // shape), so it needs no cull-margin contribution.
  //
  // SAME GATE AS THE DROP SHADOW (manifest 14.8, mirrored): innerShadow.dx/dy
  // default 0 (no offset), innerShadow.opacity default 0 (THE render gate — off,
  // so every old document renders byte-identically), innerShadow.blur default 0
  // is LEGAL AND VISIBLE (opacity>0, blur 0 = a hard-edged inset silhouette),
  // color black (the with_drop_shadows(color='black') precedent).
  //
  // AND THE SAME OPEN TOP: innerShadow.opacity is likewise a ceiling-free
  // coverage multiplier, for the same reason and by the same mechanism as
  // shadow.opacity (the long note above it is the ONE home for that reasoning —
  // read it there). Mirrored here in one line rather than restated.
  "innerShadow.dx": { label: "Inner shadow X", kind: "number", category: "effects", default: 0, help: "How far the inner shadow shifts horizontally, in canvas units (positive is right). The inner shadow appears once Inner shadow opacity is above zero." },
  "innerShadow.dy": { label: "Inner shadow Y", kind: "number", category: "effects", default: 0, help: "How far the inner shadow shifts vertically, in canvas units (positive is down). The inner shadow appears once Inner shadow opacity is above zero." },
  "innerShadow.blur": { label: "Inner shadow blur", kind: "number", min: 0, category: "effects", default: 0, help: "How soft the inner shadow is (Gaussian blur amount, canvas units). Zero is a crisp inset edge; the inner shadow is on whenever Inner shadow opacity is above zero, softness is separate." },
  "innerShadow.color": { label: "Inner shadow color", kind: "color", category: "effects", default: "#000000", help: "The inner shadow's color — classically black for a recessed look, but any color works (a colored inner glow, for instance)." },
  "innerShadow.opacity": { label: "Inner shadow opacity", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "effects", default: 0, help: "How dark the inner shadow is: 0 is invisible (NO inner shadow — the default) and 1 is fully solid. NO UPPER CAP — above 1 it OVERDRIVES, driving the soft inward fade to full strength so the recess reads as a harder, deeper cut (past about 255 nothing more can change). This is its on/off gate: raise it above 0 to turn the inner shadow on." },
  // Options + labels come from BLEND_MODES / BLEND_MODE_LABELS at the top of this
  // file (THE one home — render_gpu/ir.js imports the same list for its op
  // validation, so the two can no longer disagree). Photoshop's full layer-blend
  // set minus Dissolve; see the BLEND_MODES docstring for the ordering rationale,
  // the "add" back-compat spelling, and why Dissolve is absent.
  // `optionGroups` is the SAME declaration BLEND_MODES is flattened from, so the
  // dropdown's family captions and its option order have one source and cannot
  // disagree (checkOptionGroups above proves that at boot).
  blendMode: { label: "Blend mode", kind: "select", options: BLEND_MODES, optionGroups: BLEND_MODE_GROUPS, optionLabels: BLEND_MODE_LABELS, category: "effects", default: "normal", help: "How the widget's pixels combine with what's behind it — Photoshop's blend modes, ordered by how often they get used and then grouped. The three most-reached-for come first (Normal just paints over; Linear Dodge adds light; Multiply darkens), then the lightening group (Screen, Lighten, Color Dodge, …), the darkening group (Darken, Color Burn, …), the contrast group (Overlay, Soft Light, …), the comparative group (Difference, Subtract, …), and the component group (Hue, Color, Luminosity)." },

  // ── effects: SOFT EDGES (the effects bundle's fifth effect — PowerPoint) ────
  // FEATHERS the widget's silhouette: fades its ALPHA from full inside to 0 at
  // the border over `softEdges` canvas units, so the edges softly dissolve to
  // transparent (PowerPoint's "Soft Edges"). A modification of the widget's OWN
  // coverage — applied to the ONE offscreen render BEFORE shadow/inner-shadow/
  // bloom so those all follow the softened outline (render_gpu/skia/paint_skia.js
  // handleEffectSubtree → featherEdges). It only ERODES inward (never spills
  // outward), so it adds NO cull halo (effectSubtree.margin ignores it) and any
  // vector widget inherits it for free through the shared effects bundle.
  //
  // GATE = the SIZE itself (unlike shadow/inner-shadow, which gate on opacity):
  // softEdges default 0 is THE off state — 0 feathers nothing, so every old
  // document renders byte-identically. A single scalar amount (like blendMode,
  // not a nested {dx,dy,...} sub-object), so its equation slug is plain
  // `softEdges`. min 0 (a negative feather is meaningless).
  softEdges: { label: "Soft edges", kind: "number", min: 0, category: "effects", default: 0, help: "Feathers the widget's edges inward to transparent over this many canvas units, so its border softly dissolves (like PowerPoint's Soft Edges). Zero is a crisp edge (off); larger values fade a wider band." },

  // ── particles: the EMITTER bundle (manifest 13.5 PARTICLE EFFECT WIDGET) ──────
  // The sparkler's emission parameters — all equation-capable numeric properties
  // (kind "number"), read by the PURE simulation core/particles.js. There are no
  // magic literals here: every default is a plain, self-explanatory value a user
  // would set (a modest steady stream, a 2-second life, a small upward-ish burst
  // under light gravity). Category "particles" is the emitter's own Inspector
  // accordion group. Bounds are mathematical (rate/lifetime/sizes/speeds are
  // non-negative; fade/shrink are proportions in [0,1]). `angle`/`spread` are in
  // DEGREES (no display unit needed — they ARE degrees in storage, unlike
  // rotation which is stored in radians). Only the particle widget composes this
  // bundle (it is the only emitter), but it lives in the registry so its rows/
  // help/bounds are single-sourced like every other family.
  particleRate: { label: "Rate", kind: "number", min: 0, category: "particles", default: 40, help: "How many particles are emitted per second. Zero emits nothing (the emitter becomes an invisible ghost you can still select)." },
  particleLifetime: { label: "Lifetime", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "particles", default: 2, help: "How many seconds each particle lives before it disappears. Longer lifetimes keep more particles on screen at once." },
  // A launch HEADING → the rotary dial (kind "angle"). Stored in raw DEGREES, so
  // NO `display` — the dial shows exactly what is stored.
  particleAngle: { label: "Angle", kind: "angle", category: "particles", default: 270, help: "The central launch direction in degrees (0 = right, 90 = down, 270 = up). Particles fly outward from the origin along this heading." },
  particleSpread: { label: "Spread", kind: "number", min: 0, max: 360, category: "particles", default: 50, help: "How wide the launch fan is, in degrees, centered on the angle. Zero is a tight jet; 360 is a full radial burst in every direction." },
  particleSpeedMin: { label: "Speed min", kind: "number", min: 0, category: "particles", default: 60, help: "The slowest a particle can be launched, in canvas units per second. Each particle picks a random speed between min and max." },
  particleSpeedMax: { label: "Speed max", kind: "number", min: 0, category: "particles", default: 140, help: "The fastest a particle can be launched, in canvas units per second. Set equal to Speed min for a uniform speed." },
  particleGravityX: { label: "Gravity X", kind: "number", category: "particles", default: 0, help: "A constant sideways pull on every particle, in canvas units per second squared (positive drifts them right, like wind)." },
  particleGravityY: { label: "Gravity Y", kind: "number", category: "particles", default: 120, help: "A constant downward pull on every particle, in canvas units per second squared (positive is down — real gravity). Negative makes them float up." },
  particleSizeMin: { label: "Size min", kind: "number", min: 0, category: "particles", default: 2, help: "The smallest a particle's radius can be at birth, in canvas units. Each particle picks a random size between min and max." },
  particleSizeMax: { label: "Size max", kind: "number", min: 0, category: "particles", default: 5, help: "The largest a particle's radius can be at birth, in canvas units. Set equal to Size min for uniform dots." },
  particleColor: { label: "Color", kind: "color", category: "particles", default: "#ffcc33", help: "The color of every particle. Lower its alpha for translucent sparks; combine with Fade to have them dim out over their life." },
  particleFade: { label: "Fade", kind: "number", min: 0, max: 1, step: 0.01, category: "particles", default: 1, help: "How much a particle fades out over its life, from 0 (stays solid then vanishes) to 1 (fades all the way to transparent by the end)." },
  particleShrink: { label: "Shrink", kind: "number", min: 0, max: 1, category: "particles", default: 0, help: "How much a particle shrinks over its life, from 0 (keeps its birth size) to 1 (shrinks down to nothing by the end)." },
  particleSeed: { label: "Seed", kind: "number", category: "particles", default: 1, help: "The randomness seed. The same seed always produces the exact same particle pattern (so renders reproduce); change it to reshuffle." },

  // ── filmstrip: orientation + film base colour ─────────────────────────────────
  // Two of the original Python film_strip(video, length, height, width, vertical,
  // film_color) signature (src == video; `frames` below is length). Filmstrip-
  // specific, so they live as plain rows here rather than a bundle. The former
  // `frameW`/`frameH` rows are GONE with the server frame-extraction endpoint they
  // fed: a frame is now decoded live at the video's own resolution by the scrub
  // path, so there is no extraction resolution left to choose.
  vertical: { label: "Vertical", kind: "boolean", category: "formatting", default: false, help: "Lay the frames top-to-bottom in a vertical strip instead of left-to-right. The frames stay upright either way." },
  // The PERFORATION FAMILY — the film gauge + sprocket-hole geometry, keyed by the axis
  // that actually determines it (negative vs print, and gauge), NOT by manufacturer. Its
  // options and their PUBLISHED millimetre dimensions live in ONE data table,
  // plugins/filmstrip.js PERF_FAMILIES; the row's `options` are that table's keys, so
  // adding a family is one data entry and never an edit here. A `select`, because the
  // families are named specifications rather than a continuum.
  perfFamily: {
    label: "Perforations", kind: "select", category: "formatting",
    options: PERF_FAMILY_IDS,
    optionLabels: PERF_FAMILY_LABELS,
    help: "Which film gauge and sprocket-hole specification the strip is drawn to. The hole size, corner radius and spacing come from the family's published millimetre dimensions scaled to the strip's width, so a 16 mm strip really does read as coarser than a 35 mm one.",
  },
  filmColor: { label: "Film color", kind: "color", category: "formatting", default: "#000000", help: "The color of the film base the frames sit on — the strip and its sprocket-hole bands. Classic film is black." },

  // ── filmstrip: the SAMPLED WINDOW into the clip ───────────────────────────────
  // The two ends of the span the frames sample, in seconds. They exist so that ONE
  // number (the end) spreads a whole strip across a clip: every frame's default
  // time is an EQUATION spanning start→end (plugins/filmstrip.js FRAME_TIME_EQ), so
  // dragging `videoEnd` re-times the entire strip at once, and any single frame can
  // still be overridden by typing over its own equation.
  //
  // WHY THE END IS AN INPUT, NOT DERIVED: a clip's real duration is only knowable at
  // browser DECODE time (`<video>.duration`), which is not in pure document state —
  // the same reason the scrubber's `duration` is a user-supplied number
  // (plugins/video_scrub.js). Default 0 (an honest "not told yet"), which collapses
  // every frame's default time onto `videoStart`; the widget SAYS so in-widget rather
  // than inventing a length.
  videoStart: { label: "Video start (s)", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "formatting", default: 0, help: "The time in the clip the first sampled frame comes from, in seconds. Raise it to skip a slate or a fade-in." },
  videoEnd: { label: "Video end (s)", kind: "number", min: 0, scrub: SECONDS_SCRUB, category: "formatting", default: 0, help: "The time in the clip the sampled span ends at, in seconds — normally the clip's length. Every frame's default time is an equation across start→end, so this one number spreads the whole strip. Left 0 the span is empty and all frames show the start (the real duration is only known once the video decodes, so it is a value you provide)." },

  // ── filmstrip: THE FRAME LIST (a LIST property — core/lists.js) ────────────────
  // `frames` used to be a COUNT (a number) that a server endpoint turned into N
  // extracted stills. It is now the frames THEMSELVES: a variable-length list whose
  // one field is the TIME in the clip that frame is decoded at. The count is the
  // list's length, so there is no second source of truth for it, and each frame's
  // time is an ordinary keyframable, equation-bindable leaf — which is what makes an
  // ANIMATED filmstrip fall out (keyframe or bind the times and the little frames
  // scrub as the slide tweens) with no autoplay clock anywhere.
  //
  // A SEQUENCE, not sorted: the order IS the strip, left to right. Sorting by time
  // would silently reorder a deliberately non-monotonic strip (a boomerang, a
  // shuffled contact sheet), and insert-between means "insert at this position".
  //
  // Storage is a TUPLE ([time]) even though there is only one field, and that is
  // load-bearing rather than cosmetic: core/interpolators.js interpolate() ROUNDS a
  // lerp between two INTEGERS (the tweenline int rule), and frame times are
  // routinely whole seconds — so a RECORD ({time: 0} → {time: 2}) would recurse to
  // that integer path and SNAP mid-tween, while a numeric PAIR-shaped array takes
  // interpolate's pure-numeric-array branch (a plain lerp). Same reasoning, and the
  // same conclusion, as the polygon's `points`.
  //
  // minLength 1: a strip with no frames is not a filmstrip, and the geometry divides
  // by the frame count.
  frames: {
    label: "Frames", kind: LIST_ROW_KIND, category: "formatting",
    element: {
      storage: "tuple",
      fields: [
        { name: "time", kind: "number", min: 0, label: "Time (s)", help: "The time in the clip this frame is decoded at, in seconds. Its default is an equation across Video start → Video end, so re-timing the whole strip is one edit; type a number (or your own equation) here to pin this one frame." },
      ],
    },
    order: "sequence",
    activeKey: "framesActive",
    minLength: 1,
    help: "The frames the strip shows, left to right — each one a TIME in the clip. Insert between two frames to sample the moment between them; hide a frame to close the strip over it without losing its time.",
  },
};

// LOUD IMPORT-TIME GUARD (the render_settings.js ANTIALIAS_MODES precedent, the
// same shape core/expressions.js uses for KIND_RESULT): a registry entry whose
// `kind` is not in ROW_KINDS has no control — the Inspector's field dispatcher
// ends in a catch-all text input, so an unknown kind renders a plain text box
// for a color/boolean/enum instead of failing. Cross-checking at import makes
// that impossible to ship rather than merely unlikely.
for (const [key, def] of Object.entries(PROPS)) {
  if (!ROW_KINDS.includes(def.kind))
    throw new Error(`properties: PROPS."${key}" declares kind "${def.kind}"${def.kind in RETIRED_ROW_KINDS ? ` — that spelling is RETIRED, write "${RETIRED_ROW_KINDS[def.kind]}"` : `, which is not one of ${JSON.stringify(ROW_KINDS)} — add its Inspector control before declaring it`}.`);
  checkOptionGroups(`PROPS."${key}"`, def);
  checkListRow(`PROPS."${key}"`, key, def);
}
// The gradient stop list is a declaration too (it is just not a PROPS key — see
// GRADIENT_STOPS_LIST), so it gets the SAME guard rather than a weaker one.
checkListRow("GRADIENT_STOPS_LIST", "stops", GRADIENT_STOPS_LIST);

/**
 * BUNDLES — named ORDERED lists of property keys (manifest "SHARED STYLE
 * BUNDLES"). A bundle is the reusable group a family of widgets composes;
 * `bundle(name)` expands it to rows, `bundleDefaults(name)` to a defaults
 * fragment.
 *
 * `positioning` — the nine bbox positioning rows every bbox widget shares.
 * `strokedBox` — the four-property box style (fill/stroke/strokeWidth/
 *   cornerRadius) + its render decoration (render_gpu/decorate.js). This is
 *   THE bundle the user meant by "make the stroke composition inherit... I'd
 *   like everything to inherit them at once, including images and videos".
 * `media` — the shared media chrome: a `src` string row + `opacity`. Media
 *   widgets compose positioning + media + (the border half of) strokedBox.
 */
/** THE STROKE-TRIM property keys, single-sourced so strokedBorder and strokedBox
 *  cannot drift on which trim/cap rows a box inherits (manifest E.12-15). Order =
 *  Inspector row order: the arc-length window, its phase, then the two caps. */
export const STROKE_TRIM_KEYS = ["strokeStart", "strokeEnd", "strokePhase", "strokeCapStart", "strokeCapEnd"];

/** THE STROKE-ALIGNMENT key, single-sourced for the same reason STROKE_TRIM_KEYS
 *  is: strokedBorder and strokedBox must not drift on whether a box inherits the
 *  inner/outer knob. It sits immediately after strokeWidth in Inspector order —
 *  offset is a modifier OF the width, so the two read as one thought. */
export const STROKE_OFFSET_KEYS = ["strokeOffset"];

export const BUNDLES = {
  positioning: ["x", "y", "w", "h", "rotation", "rotationAnchor.x", "rotationAnchor.y", "z"],
  // The endpoint-pair positioning every arrow-family widget shares (from/to
  // coordinates + z). Distinct from `positioning` — arrows have no bbox/rotation
  // of their own; their geometry IS the two endpoints (core/endpoints.js).
  endpoints: ["from.x", "from.y", "to.x", "to.y", "z"],
  // The BORDER-only slice of the stroked box: stroke + strokeWidth + cornerRadius
  // (no fill), plus THE STROKE-TRIM keys (trim window + phase + the two caps —
  // manifest E.12-15). Media widgets (image/video/filmstrip) compose THIS — a
  // photo has no fill color of its own, only a frame. rect/donut/cropbox add
  // `fill` themselves (they ARE filled boxes). The trim keys ride along here (and
  // in strokedBox) so EVERY stroked box inherits drawing-on/caps for free; they
  // carry no default (absent-is-legacy), so composing them changes no widget's
  // stored state or rendering until a knob moves.
  strokedBorder: ["stroke", "strokeWidth", ...STROKE_OFFSET_KEYS, "cornerRadius", ...STROKE_TRIM_KEYS],
  // The full filled-and-stroked box: fill + the border slice (trim keys included).
  strokedBox: ["fill", "stroke", "strokeWidth", ...STROKE_OFFSET_KEYS, "cornerRadius", ...STROKE_TRIM_KEYS],
  // EDGE-CROP INSETS (manifest "Edge-crop insets"): the four per-edge source
  // trims. Media widgets (image/video) compose this; groups will too (their
  // subtree-crop consumption is a follow-up — the bundle is defined once here).
  cropInsets: ["cropTop", "cropLeft", "cropRight", "cropBottom"],
  // THE EFFECTS BUNDLE (manifest Round 12D): drop shadow + bloom + blend mode +
  // inner shadow + soft edges, composed by every DRAWN widget (render half:
  // render_gpu/effects.js — exclusions justified in its header). Defaults are
  // effect-OFF; use bundleNestedDefaults("effects") in plugin defaults (the
  // shadow/inner-shadow keys are nested, blendMode/softEdges are plain scalars).
  effects: ["shadow.dx", "shadow.dy", "shadow.blur", "shadow.color", "shadow.opacity", "bloom.radius", "bloom.strength", "blendMode", "innerShadow.dx", "innerShadow.dy", "innerShadow.blur", "innerShadow.color", "innerShadow.opacity", "softEdges"],
  // THE PRESET-SHAPE bundle (Wave 2): the shape selector + its two generator
  // knobs, composed only by plugins/shape.js. Order = Inspector row order.
  shape: ["shape", "shapePoints", "shapeInnerRatio"],
  // THE PARTICLE EMITTER BUNDLE (manifest 13.5): the sparkler's emission
  // parameters, all equation-capable numbers read by the pure simulation
  // (core/particles.js). Composed only by plugins/particles.js (the sole
  // emitter), single-sourced here like every other family. Order = the
  // Inspector row order (rate/lifetime first, then launch, gravity, size,
  // appearance, seed).
  particles: [
    "particleRate", "particleLifetime",
    "particleAngle", "particleSpread", "particleSpeedMin", "particleSpeedMax",
    "particleGravityX", "particleGravityY",
    "particleSizeMin", "particleSizeMax",
    "particleColor", "particleFade", "particleShrink", "particleSeed",
  ],
  // THE COLOUR-RAMP bundle (core/ramps.js): the stop list plus the three aspects
  // that decide how it is read. Composed by any widget whose value IS a ramp
  // (plugins/demo/mandelbrot.js is the first); a gradient PAINT composes the same
  // stop declaration inside its own sub-state and adds geometry. Order = Inspector
  // row order: the stops, then how the ramp is read, then the animatable phase.
  ramp: ["rampStops", "rampLoop", "rampSpace", "rampPhase"],
  // THE CAMERA RENDERING bundle (manifest "CAMERA RENDERING"): the scene-global
  // render toggles the singleton camera owns — anti-aliasing, retina/DPR, and
  // the dither mode + its emphasis. Composed ONLY by plugins/camera.js (the sole
  // camera), single-sourced here like every other family. Order = Inspector row
  // order (the two on/off toggles first, then the dither pair). Spread its
  // defaults with bundleDefaults("rendering") — every key has a scalar default.
  rendering: ["antialias", "retina", "ditherMode", "ditherEmphasis"],
};

/**
 * Pure function. Resolves one property key to a ROW object: {key, ...def,
 * ...override}. The def comes from PROPS (throws loudly on an unknown key — a
 * typo must not silently vanish); `override` shallow-merges on top (a widget
 * refining a label, adding min/max, changing category, overriding help, etc.).
 * The fragment-only `default` aspect is STRIPPED from rows (it belongs to
 * defaults(), not the Inspector row); every OTHER aspect — including `help`,
 * which the Inspector's (?) hover chrome reads — flows through, so a resolved
 * row carries exactly the fields the Inspector consumes.
 *
 * Args:
 *   key (string): a PROPS key (may be dotted, e.g. "rotationAnchor.x")
 *   override (object): per-widget row aspect overrides (optional)
 *
 * Returns:
 *   object: {key, label, kind, category, help, ...} row
 *
 * @example row("cornerRadius").min
 * 0
 * @example row("cornerRadius").default
 * undefined
 * @example row("rotation", {category: "layout"}).category
 * "layout"
 * @example row("src", {label: "Video"}).label
 * "Video"
 */
export function row(key, override = {}) {
  const def = PROPS[key];
  if (!def) throw new Error(`properties.row: unknown property "${key}" (known: ${Object.keys(PROPS).join(", ")})`);
  const { default: _drop, ...rowAspects } = def;
  return { key, ...rowAspects, ...override };
}

/**
 * Pure function. Builds a ROW ARRAY from a list of property keys, with optional
 * per-key overrides. The LAST argument, when it is a plain object (not a
 * string), is the OVERRIDES MAP: {propKey: {…aspect overrides}} applied to the
 * matching resolved row (manifest: "a category name, a name and certain aspects
 * which of course can be overridden by the widgets"). Every earlier argument is
 * a property key (string). Unknown keys throw (via row()).
 *
 * Args:
 *   ...keys (string): property keys, in the order they should appear
 *   overrides? (object): trailing {key: partialRow} override map
 *
 * Returns:
 *   object[]: resolved rows
 *
 * @example props("x", "y")
 * [{"key":"x","label":"X","kind":"number","category":"positioning"},{"key":"y","label":"Y","kind":"number","category":"positioning"}]
 * @example props("strokeWidth", { strokeWidth: { label: "Border" } })[0].label
 * "Border"
 */
export function props(...args) {
  const last = args[args.length - 1];
  const hasOverrides = args.length > 0 && typeof last === "object" && last !== null;
  const overrides = hasOverrides ? last : {};
  const keys = hasOverrides ? args.slice(0, -1) : args;
  return keys.map((k) => row(k, overrides[k] ?? {}));
}

/**
 * Pure function. Expands a named BUNDLE to a row array, with the same trailing
 * {key: overrides} map as props(). `bundle("positioning")` is the nine shared
 * bbox rows; `bundle("strokedBox")` the four box-style rows.
 *
 * Args:
 *   name (string): a BUNDLES key
 *   overrides (object): {propKey: partialRow} overrides (optional)
 *
 * Returns:
 *   object[]: resolved rows
 *
 * @example bundle("strokedBorder").map((r) => r.key)
 * ["stroke","strokeWidth","strokeOffset","cornerRadius","strokeStart","strokeEnd","strokePhase","strokeCapStart","strokeCapEnd"]
 * @example bundle("positioning").length
 * 8
 */
export function bundle(name, overrides = {}) {
  const keys = BUNDLES[name];
  if (!keys) throw new Error(`properties.bundle: unknown bundle "${name}" (known: ${Object.keys(BUNDLES).join(", ")})`);
  return props(...keys, overrides);
}

/**
 * Pure function. A DEFAULTS FRAGMENT for the given property keys: {key: default}
 * for every key whose PROPS def carries a `default` (keys without one are
 * skipped — the widget supplies its own value, e.g. x/y positions differ per
 * widget). Dotted keys are NOT expanded into nested objects here (rotationAnchor
 * has no scalar default anyway; widgets set the nested rotationAnchor equation
 * pair explicitly). The result is spread into a plugin's `defaults`.
 *
 * Args:
 *   ...keys (string): property keys
 *
 * Returns:
 *   object: {key: defaultValue} for keys that declare a default
 *
 * @example defaults("opacity", "cornerRadius", "strokeWidth")
 * {"opacity":1,"cornerRadius":0,"strokeWidth":0}
 * @example defaults("x", "y")
 * {}
 */
export function defaults(...keys) {
  const out = {};
  for (const k of keys) {
    const def = PROPS[k];
    if (!def) throw new Error(`properties.defaults: unknown property "${k}"`);
    if ("default" in def) out[k] = def.default;
  }
  return out;
}

/**
 * Pure function. A DEFAULTS FRAGMENT for a named bundle (bundleDefaults is to
 * defaults what bundle is to props). Only keys with a declared default appear.
 *
 * @example bundleDefaults("strokedBox")
 * {"strokeWidth":0,"cornerRadius":0}
 * @example bundleDefaults("positioning")
 * {"rotation":0}
 */
export function bundleDefaults(name) {
  const keys = BUNDLES[name];
  if (!keys) throw new Error(`properties.bundleDefaults: unknown bundle "${name}"`);
  return defaults(...keys);
}

/**
 * Pure function. A NESTED defaults fragment: like defaults(), but dotted keys
 * expand into nested objects — "shadow.dx" becomes {shadow: {dx: ...}} — so a
 * plugin can spread a bundle whose state shape is nested (the effects bundle:
 * state.shadow.dx, the rotationAnchor.{x,y} nesting precedent). Sibling dotted
 * keys merge into one object. Keys without a declared default are skipped,
 * same as defaults().
 *
 * @example nestedDefaults("shadow.blur", "shadow.opacity", "blendMode")
 * {"shadow":{"blur":0,"opacity":0},"blendMode":"normal"}
 * @example nestedDefaults("opacity")
 * {"opacity":1}
 */
export function nestedDefaults(...keys) {
  const out = {};
  for (const k of keys) {
    const def = PROPS[k];
    if (!def) throw new Error(`properties.nestedDefaults: unknown property "${k}"`);
    if (!("default" in def)) continue;
    const path = k.split(".");
    let node = out;
    for (const part of path.slice(0, -1)) node = node[part] ??= {};
    node[path[path.length - 1]] = def.default;
  }
  return out;
}

/**
 * Pure function. nestedDefaults for a named bundle — THE way a plugin spreads
 * the effects bundle's effect-off defaults into its `defaults` dict:
 * `...bundleNestedDefaults("effects")`.
 *
 * @example bundleNestedDefaults("effects")
 * {"shadow":{"dx":0,"dy":0,"blur":0,"color":"#000000","opacity":0},"bloom":{"radius":10,"strength":0},"blendMode":"normal","innerShadow":{"dx":0,"dy":0,"blur":0,"color":"#000000","opacity":0},"softEdges":0}
 */
export function bundleNestedDefaults(name) {
  const keys = BUNDLES[name];
  if (!keys) throw new Error(`properties.bundleNestedDefaults: unknown bundle "${name}"`);
  return nestedDefaults(...keys);
}

// ── CUSTOM PER-WIDGET PROPERTIES ("self.*", Blender-style) ────────────────────
// A plugin may declare its OWN properties beyond the shared PROPS table / the
// named BUNDLES — the manifest "Demo widget" extensibility story: bespoke knobs
// a widget owns, referenceable in its own equations as `self.<name>`. The
// Inspector accordion group they default into: a dedicated "Custom" region
// (Blender's "Custom Properties" panel), so a widget's own knobs never mix with
// its shared-bundle rows. web/Inspector.svelte registers this id in its
// CATEGORY_ORDER / CATEGORY_TITLES so the group renders titled + ordered (not
// the start-cased fallback). A per-def `category` override still wins (a widget
// may file a custom prop under an existing group instead).
export const CUSTOM_CATEGORY = "custom";

/**
 * Pure function. A human label from a property NAME: split camelCase and
 * snake/kebab-case into words, sentence-case the result (matching the registry's
 * "Corner radius" style). The fallback when a custom-prop declaration omits an
 * explicit `label`.
 *
 * @example defaultLabel("inset") // "Inset"
 * @example defaultLabel("cornerCut") // "Corner cut"
 * @example defaultLabel("edge_gap") // "Edge gap"
 */
export function defaultLabel(name) {
  const spaced = name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Pure function. THE custom per-widget property mechanism ("self.*", Blender-
 * style): expands a plugin's OWN property declarations into the {rows, defaults}
 * a plugin spreads into its `inspector` and `defaults`. A declaration is
 * {name, kind, default, label?, category?, ...aspects}; `name` is BOTH the
 * item-state key AND the equation slug (referenceable as `self.<name>`). The
 * row shape is byte-identical to a PROPS-composed row (the Inspector consumes
 * rows purely by field name), and `default` is STRIPPED from the row (it belongs
 * to `defaults`, exactly as row() drops it) while every other aspect flows
 * through.
 *
 * WHY this is all it takes — NO evaluation-engine changes: the Inspector
 * (web/Inspector.svelte) renders a row purely by its {key, label, kind,
 * category, min, max, ...} fields, and evaluateState (core/expressions.js)
 * evaluates ANY item-state leaf that is an equation value — the universal `=`
 * gate is registration-free, and a NUMBER default additionally enables bare
 * arithmetic + `self.<name>` references (isNumericSlot / numericPropertyPaths
 * key off the default's type, not a PROPS entry; resultKindForSlot infers a
 * `=` slot's result kind from the default when the key is unregistered). So a
 * declared custom prop is at once (a) an Inspector row, (b) a default stored in
 * item state, and (c) equation-capable — with zero edits to the eval path.
 *
 * Args:
 *   defs (object[]): [{name, kind, default, label?, category?, min?, max?, ...}]
 *
 * Returns:
 *   {rows: object[], defaults: object} — `rows` for `inspector`, `defaults` for
 *   `defaults`. Declaration order preserved. Loud on a malformed def.
 *
 * @example customProps([{ name: "inset", kind: "number", default: 16 }]).rows[0]
 * {"key":"inset","kind":"number","label":"Inset","category":"custom"}
 * @example customProps([{ name: "inset", kind: "number", default: 16 }]).defaults
 * {"inset":16}
 * @example customProps([{ name: "gap", kind: "number", default: 8, label: "Gap", min: 0 }]).rows[0].min
 * 0
 */
export function customProps(defs) {
  const rows = [];
  const defaultsOut = {};
  for (const def of defs) {
    if (!def || typeof def.name !== "string" || typeof def.kind !== "string")
      throw new Error(`customProps: each def needs a string name + kind (got ${JSON.stringify(def)})`);
    // An INVENTED kind ("toggle", "bool", "switch") has no control: the
    // Inspector's dispatcher would fall through to its catch-all text input and
    // silently edit a boolean as a string. Reject it here, where the widget
    // author is standing. A RETIRED spelling is not rejected here (one call site
    // outside this migration's ownership still uses it, and a boot-time throw
    // would take the whole app down mid-flight) — tests/row_kinds_test.js
    // rejects it app-wide instead, over EVERY row, literal or composed.
    if (!ROW_KINDS.includes(def.kind) && !(def.kind in RETIRED_ROW_KINDS))
      throw new Error(`customProps: def "${def.name}" declares kind "${def.kind}", which is not one of ${JSON.stringify(ROW_KINDS)} — a kind with no Inspector control would render as a plain text box.`);
    if (!("default" in def))
      throw new Error(`customProps: def "${def.name}" needs a default value`);
    // Same gate PROPS gets: a grouped select whose captions do not partition its
    // own option list would render family headings one family off, and a list
    // whose element shape is malformed would leave its per-element `=` slots
    // untyped at runtime instead of at the declaration.
    checkOptionGroups(`customProps def "${def.name}"`, def);
    checkListRow(`customProps def "${def.name}"`, def.name, def);
    const { name, kind, default: defaultValue, label, category, ...rest } = def;
    rows.push({ key: name, kind, label: label ?? defaultLabel(name), category: category ?? CUSTOM_CATEGORY, ...rest });
    defaultsOut[name] = defaultValue;
  }
  return { rows, defaults: defaultsOut };
}
