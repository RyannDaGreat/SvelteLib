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
 * own `inspector` row array. The SAME nine transform rows (x/y/w/h/rotation/
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
 *   {key, label, kind, category, min?, max?, scrubMin?, scrubMax?, display?,
 *    scrub?, options?, optionsFrom?, optionLabels?}
 * web/Inspector.svelte consumes rows purely by field name (row.key, row.label,
 * row.kind, row.category, row.min, ...), so a registry-composed row drives it
 * exactly as a hand-written one did. `defaults()`/`bundleDefaults()` return a
 * flat state fragment ({x: 100, ...}) plugins spread into their `defaults`.
 *
 * ── SCRUB RANGE vs HARD BOUNDS (`scrubMin`/`scrubMax`) ─────────────────────────
 * `min`/`max` mean "this value cannot go there" — TYPING or an EQUATION binding
 * beyond them is refused (where anything downstream enforces it at all; most
 * rows have no such enforcement and `min`/`max` are pure UI/scrub hints, but a
 * row that WANTS a real hard bound has always used these two names for it).
 * `scrubMin`/`scrubMax` mean "the mouse sweeps this far" — the DRAG's clamp and
 * Home/End jump targets, and (via resolveScrub) the span the coefficient is
 * derived from — with NO implication that a typed number or an equation result
 * outside that span is wrong. When only `min`/`max` are declared (the common
 * case) the two coincide, byte-identically to before this split: NumericField
 * falls back to `min`/`max` for the drag when `scrubMin`/`scrubMax` are absent,
 * so an existing row needs no edit. A row declares `scrubMin`/`scrubMax`
 * INSTEAD of (not in addition to a differing) `min`/`max` only when the useful
 * DRAG SWEEP is narrower than the value's real domain — strokeOffset is the
 * first: -1..1 is the alignment sweep worth fine-grained dragging, but any
 * finite offset beyond it is a meaningful (if to be typed/equation-bound rather
 * than dragged) detached contour, so the row has no `min`/`max` at all.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { SHAPE_NAMES, SHAPE_LABELS } from "./shapes.js";
import { checkListDeclaration, LIST_ROW_KIND } from "./lists.js";
import { NODE_INPUT_ROW_KIND } from "./nodeflow.js";
import { VEC2_ROW_KIND, VECTOR_KINDS, COLOR_CHANNEL_MAX, COLOR_VECTOR_ADDRESS, colorAlphaAxis } from "./vector_values.js";
import { PERF_FAMILY_IDS, PERF_FAMILY_LABELS } from "./film.js";
import { RAMP_SPACES, RAMP_SPACE_LABELS, DEFAULT_RAMP_SPACE, RAMP_PRESET_LIBRARIES, COLOR_RAMP_LIBRARY } from "./ramps.js";
import { displayedDefaultModeFor, interpKeyFor, interpMode, interpModeLabels, interpParamKeyFor, isInterpKey, isInterpParamKey, modeParams, modesForKey } from "./interp_modes.js";
import { MORPH_KEY, MORPH_MODES, MORPH_MODE_HELP, MORPH_MODE_LABELS } from "./morph_property.js";

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
 * THE dither-pattern modes. "off" disables dithering; "bayer" is an ordered
 * checkerboard threshold matrix; "blueNoise" is a softer, less regular
 * precomputed scatter. The array VALUES are the stored state / equation slugs;
 * DITHER_MODE_LABELS maps each to the human label the Inspector select shows.
 * Single-sourced here so render_gpu/skia/dither_shader.js (which asserts this
 * exact list at import time) and the property rows can never disagree on the ids.
 *
 * THESE USED TO BE CAMERA PROPS AND ARE NOW PAINT PROPS (user ruling, 2026-08-07:
 * "It will be a material-level thing you uproot any code in the camera for
 * dithering"). Dithering was a WHOLE-FRAME post-effect on THE camera, which meant
 * a document could not de-band one banding gradient without putting grain over
 * every pixel in the deck — including the text, the photos and the flat fills that
 * had no banding to fix. The modes themselves were never the problem, so the two
 * ids and their labels survive the uprooting unchanged; what moved is WHO OWNS
 * THEM. See PAINT_DITHER_* below for the paint-level defaults, and
 * core/document.js withCameraDitherDropped for the loud migration that removes the
 * dead camera leaves from documents that still carry them.
 */
export const DITHER_MODES = ["off", "bayer", "blueNoise"];
export const DITHER_MODE_LABELS = { off: "Off", bayer: "Bayer", blueNoise: "Blue noise" };

/**
 * THE PAINT-LEVEL DITHER DEFAULTS. A paint stores `ditherMode` / `ditherEmphasis`
 * beside its `type` (NOT inside the `linear`/`radial` sub-state), so switching a
 * gradient between linear and radial keeps its dither exactly as switching keeps
 * its `type`-level identity — and so a future solid/material/pattern paint can opt
 * in by reading the SAME two leaves rather than minting its own pair.
 *
 * ABSENT IS OFF, AND OFF IS BYTE-IDENTICAL. render_gpu/ir.js parsePaint omits both
 * keys from the parsed paint whenever the dither is inactive, so every gradient
 * authored before this feature produces the same parsed object, the same Skia
 * shader, the same PDF shading dictionary and the same SVG def it always did. That
 * is the same absent-is-legacy discipline `spread`, `phase` and `wavelength` hold.
 */
export const PAINT_DITHER_DEFAULT_MODE = "off";
export const PAINT_DITHER_DEFAULT_EMPHASIS = 1;

/**
 * THE PAINT'S COLOUR BIT DEPTH, PER CHANNEL (user, 2026-08-08: "more options for
 * dithering too actually - like bit depth (by default 8 bit but can go down to 1
 * bit)"). 8 is the surface's own depth and therefore today's behaviour; 1 bit is
 * two levels per channel, i.e. eight colours — the classic posterized look.
 *
 * ── IT IS ITS OWN PROPERTY, NOT A SUB-OPTION OF DITHER, AND THAT IS THE WHOLE
 * SHAPE OF THIS FEATURE. Quantisation and dithering are two SEPARATE, composable
 * operations, and conflating them would make one of the three useful combinations
 * unreachable:
 *   depth alone            → hard posterized bands. A real, wanted look.
 *   depth + dither         → the noise breaks the bands up, trading spatial
 *                            resolution for apparent colour depth. THE classic
 *                            1-bit dither picture.
 *   dither alone (depth 8) → what shipped 2026-08-07: noise at the surface's own
 *                            8-bit boundary, which de-bands a smooth ramp.
 * So bit depth is reachable with dither OFF, and the third row above is revealed
 * for what it always was — dithering at the 8-bit boundary. Depth simply MOVES
 * that boundary; nothing about the dither's meaning changes.
 *
 * THE TWO KNOBS ARE ORTHOGONAL, AND THIS IS THE RELATIONSHIP TO STATE:
 * `bitDepth` sets the SIZE of one quantisation step (1 / (2^bits - 1)), and
 * `ditherEmphasis` scales the wobble IN UNITS OF THAT STEP — emphasis 1 is
 * ±half a step at EVERY depth. That is exactly what emphasis 1 already meant at 8
 * bits (±half of 1/255), so the existing knob is unchanged in meaning and merely
 * generalized. At 1 bit a step is the whole 0..1 range, so emphasis 1 there is a
 * ±0.5 wobble — which is precisely the amount that makes a 1-bit dither resolve
 * the full ramp.
 *
 * ABSENT IS 8 AND 8 IS BYTE-IDENTICAL: render_gpu/ir.js omits the leaf whenever it
 * is 8, and the shader does NOT add an explicit quantisation step at 8 bits — it
 * leaves that to the surface write, exactly as before — so a pre-feature gradient
 * takes a byte-identical path. Below 8 the shader quantises explicitly.
 */
export const PAINT_DEFAULT_BIT_DEPTH = 8;
/** 1 bit = two levels per channel (eight colours) — the floor the user named. */
export const PAINT_MIN_BIT_DEPTH = 1;
/** 8 bits IS the render surface's depth; above it there is nothing to reduce. */
export const PAINT_MAX_BIT_DEPTH = 8;

/**
 * Pure function. Whether a PAINT's dither is switched on — THE gate for the
 * `ditherEmphasis` row in web/PaintField.svelte, and for that row ONLY.
 *
 * USER RULING, 2026-08-08: "they should be suboptions btw submenu like other
 * things right" / "like dither emphasis need not exist if dither is off". This
 * REVERSES the rule the camera-era code carried (plugins/camera.js used to argue
 * emphasis must stay visible under mode "off" because "application is an
 * overlay"); that reasoning was about PRESET application and never about the
 * Inspector, and the user has overruled it for the panel.
 *
 * IT DOES NOT GATE `bitDepth`, AND THE ASYMMETRY IS THE POINT. Emphasis is
 * meaningless without a mode — it scales a noise that is not being added — so
 * hiding it hides nothing an author could have used. Depth means something on its
 * own: quantising with no noise is HARD POSTERIZATION, a look in its own right.
 * Gating depth here would have forced it to be inert while hidden (an
 * invisible-but-active knob is the divergence this codebase forbids) and so would
 * have deleted that capability to satisfy a row rule. Keeping the depth row
 * VISIBLE obeys the same rule without the loss. See render_gpu/ir.js
 * paintDepthFields for the render half of this decision.
 *
 * IT LIVES HERE, BESIDE strokeJoinIsMiter AND strokeMaterialIsOn, and is a NAMED
 * function rather than an inline lambda for their reason: a row-visibility gate
 * that greps is one a later reader can find from either end. It differs from those
 * two only in what it reads — they take an ITEM STATE because they gate PROPS rows
 * that Inspector.svelte's groupRows resolves, while a gradient's dither rows are
 * sub-leaves of a PAINT and have no PROPS row to hang `visibleWhen` on (the same
 * reason Direction/Wavelength/Spread/Phase are hand-written markup). So PaintField
 * resolves this one directly, with the `{#if}` idiom that block already uses for
 * its linear-vs-radial split.
 *
 * @param {object|string|null} paint - the RAW stored paint
 * @returns {boolean}
 *
 * @example paintDitherIsOn({ ditherMode: "bayer" }) // true
 * @example paintDitherIsOn({ ditherMode: "off" }) // false
 * @example paintDitherIsOn({}) // false (absent IS off — the default)
 * @example paintDitherIsOn("#ff0000") // false (a bare solid has no dither)
 * @example paintDitherIsOn(null) // false
 */
export function paintDitherIsOn(paint) {
  return !!paint && typeof paint === "object" && (paint.ditherMode ?? PAINT_DITHER_DEFAULT_MODE) !== PAINT_DITHER_DEFAULT_MODE;
}

/**
 * THE BAYER MATRIX ORDER (user, 2026-08-08: "i should be able to, if i select
 * bayer, choose the bayer grid size"). A 2^k x 2^k ordered matrix holding size²
 * distinct thresholds: 2x2 is four levels and reads as a coarse cross-hatch, 16x16
 * is 256 levels and is nearly as smooth as noise while staying strictly periodic.
 *
 * NUMBERS, NOT STRINGS, because the value IS the matrix edge length and the shader
 * derives its recursion depth (log2) and level count (size²) from it arithmetically.
 * `selectRowItems` maps numeric options through unchanged and `optionLabels` keys
 * coerce, so a numeric select needs nothing special from the Inspector.
 *
 * 8 STAYS THE DEFAULT AND MUST STAY BYTE-IDENTICAL — it is what shipped before this
 * row existed, and render_gpu/tests/gradient_dither_test.js pins the equality.
 */
export const DITHER_BAYER_SIZES = [2, 4, 8, 16];
export const DITHER_BAYER_SIZE_LABELS = { 2: "2×2 (coarse)", 4: "4×4", 8: "8×8", 16: "16×16 (fine)" };
/** The order that shipped before the row existed. Absent MUST render identically. */
export const PAINT_DITHER_DEFAULT_BAYER_SIZE = 8;

/**
 * Pure function. Whether this paint/state dithers with the BAYER matrix — the gate
 * for the grid-size row, which describes a knob only that mode has.
 *
 * A SECOND, NARROWER GATE THAN paintDitherIsOn, and deliberately so: grid size is
 * meaningless under "off" AND under "blueNoise" (which has no matrix at all), so
 * showing it beside a blue-noise dither would promise a control that does nothing.
 *
 * @param {object|string|null} paint - the RAW stored paint (or an item state
 *   composing BUNDLES.dither — the four keys have the same names in both)
 * @returns {boolean}
 *
 * @example paintDitherIsBayer({ ditherMode: "bayer" }) // true
 * @example paintDitherIsBayer({ ditherMode: "blueNoise" }) // false (no matrix to size)
 * @example paintDitherIsBayer({}) // false (absent IS off)
 */
export function paintDitherIsBayer(paint) {
  return !!paint && typeof paint === "object" && paint.ditherMode === "bayer";
}

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
 * THE STROKE-JOIN modes: how a stroke turns a CORNER. The sibling of the caps —
 * a cap finishes a free END, a join finishes an interior VERTEX — and unlike the
 * caps it applies to every stroke, trimmed or not, closed or open.
 *
 * The ids are the SVG `stroke-linejoin` attribute values verbatim, which is not a
 * naming choice but a discovery: the exporter is then a pass-through with no
 * translation layer, and a translation layer is where two spellings drift apart.
 * The same three words are Skia's `StrokeJoin` members lowercased and PDF's three
 * line-join codes, so all three backends already speak this vocabulary.
 *
 * "miter" extends both outer edges until they meet in a point — the sharp corner,
 * and today's rendering everywhere; "round" arcs a disc of radius width/2 across
 * the corner; "bevel" cuts straight across between the two outer edge ends.
 *
 * Single-sourced here so the property rows, the op validation and the three
 * backends agree on the exact ids (the STROKE_CAP_MODES precedent, which says the
 * same); render_gpu/ir.js imports this list for its op validation.
 */
export const STROKE_JOIN_MODES = ["miter", "round", "bevel"];
export const STROKE_JOIN_LABELS = { miter: "Miter (sharp)", round: "Round", bevel: "Bevel (flat)" };
/** The join id that is today's rendering everywhere — the ABSENT default, so a
 *  document authored before this row renders byte-identically. */
export const STROKE_JOIN_MITER = "miter";

/**
 * THE MITER LIMIT: the ratio past which a miter joint gives up and renders as a
 * bevel, so an ever-sharper corner cannot grow an ever-longer spike.
 *
 * For a corner of interior angle θ the miter tip reaches (width/2)/sin(θ/2) past
 * the vertex, i.e. a multiple 1/sin(θ/2) of the half-width — and THAT ratio is
 * what the limit bounds. So a limit L gives up at θ = 2·asin(1/L): L = 4 keeps
 * the point down to about 29°, L = 10 down to about 11.5°, L = 1 never miters.
 *
 * 4 IS NOT AN ARBITRARY PICK AND IT IS NOT COPIED FROM ONE BACKEND. It is Skia's
 * SkPaint default AND SVG's `stroke-miterlimit` initial value, so it is what every
 * pixel this app has ever drawn to a screen or an SVG already used — choosing
 * anything else would silently restyle every existing deck. PDF's own default is
 * 10, which is the ONE backend that disagreed; render_gpu/pdf_backend.js therefore
 * STATES this number rather than inheriting its own (measured: a 20° corner at
 * width 24 spiked 66px past the vertex in the PDF export while the SVG export and
 * the painter both bevelled it flat).
 *
 * The row has no hard max — a huge limit is a legitimate "never give up" — but a
 * limit below 1 is geometrically meaningless (no corner can beat a ratio of 1),
 * which is where the row's `min` comes from.
 */
export const STROKE_MITER_LIMIT = 4;
/** The smallest meaningful limit: the miter tip always reaches at least the
 *  half-width, so a ratio under 1 can never be satisfied and means "never miter". */
export const STROKE_MITER_LIMIT_MIN = 1;

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

// THERE IS NO WAVELENGTH FLOOR (user ruling, 2026-08-02: the old 0.05 minimum was
// "an arbitrary limitation" — remove it). GRADIENT_MIN_WAVELENGTH used to clamp the
// Inspector scrubber AND core/paint_handles.js's direction bead, so a gradient could
// not be tiled finer than 20 ramps across its box for no reason the renderer needed:
// Skia/SVG tile a ramp of any positive length perfectly well. Wavelength now scrubs
// and drags all the way DOWN TO 0.
//
// AT EXACTLY 0 THE RAMP HAS NO EXTENT, and the honest picture is its LIMIT, not an
// error and not a divide-by-zero: as w → 0 the tiles get infinitely fine, so every
// pixel averages the whole ramp and the fill converges to ONE SOLID COLOUR — the
// ramp's segment-weighted mean (rampAverageColor below). That is why parsePaint
// ACCEPTS 0 and still rejects negatives loudly: 0 is a meaningful, renderable value;
// a negative axis is still nonsense.
//
// THE MEAN IS OF THE RAMP AS THAT MODE TILES IT — which is the same ramp for mirror
// and pad, and a DIFFERENT one for loop. This sentence used to read "the limit is the
// same in every spread mode", justified by mirror alone (a reflected copy has the
// same average as the copy it reflects, so mirror's mean is the authored ramp's).
// That was true of mirror and pad and quietly assumed of loop. It stopped being true
// of loop when WORKSTREAM BB baked loop's WRAP SEGMENT into the stops that reach the
// backends (render_gpu/ir.js loopWrappedStops): a looping ramp's real extent includes
// the stretch from the last stop back round to the first, so that stretch is part of
// what an infinitely fine tiling averages. The law is unchanged — the collapse is
// still "the mean of what this mode actually paints" — but it now has to be computed
// over the tiled ramp rather than assumed equal across modes.
//
// MEASURED, on stops 0.1/0.55 red→blue: pad/mirror collapse to (0.325, 0, 0.675),
// loop to (0.5, 0, 0.5) — and the mean of an ACTUALLY RENDERED loop fill at w = 0.02
// and w = 0.005 is (0.5, 0, 0.5), i.e. the collapse matches the limit it claims to be
// and would NOT have if loop had kept the authored ramp's mean. The two modes agree
// again whenever the wrap changes nothing: identical first/last colours, or stops at
// both 0 and 1 (the authored hard seam, which has no wrap segment to average).
/** Wavelength at which the ramp collapses to its average colour — the exact 0 case,
 *  named so the three backends' solid-fill branches read as one decision. */
export const GRADIENT_COLLAPSE_WAVELENGTH = 0;

// THE GRADIENT SPREAD MODE (user ruling, 2026-08-02): what a tiled ramp does OUTSIDE
// its one wavelength-long segment. These are the three NATIVE tile modes every
// backend already has — Skia TileMode, SVG spreadMethod — so this row costs no
// shader work, only plumbing:
//
//   mirror — reflects there-and-back (Skia Mirror / SVG "reflect"). TODAY'S
//     BEHAVIOUR AND THE DEFAULT, so an ABSENT spread is byte-identical to every
//     gradient authored before this feature (the same absent-is-legacy precedent as
//     center/wavelength/phase).
//   loop — restarts the ramp each segment (Skia Repeat / SVG "repeat"). The user's
//     test of it: with looping "I should see purple on the right of it" — the FIRST
//     colour reappears immediately after the last, instead of the last colour being
//     reflected back.
//   pad — no tiling at all (Skia Clamp / SVG "pad"): "basically just keeps the last
//     color", holding each end colour out to the edge of the shape.
//
// THE PERIOD DIFFERS PER MODE, and that is the one thing this row changes about the
// phase math (render_gpu/ir.js linearGradientRender). One ramp SEGMENT spans
// 2·w·half. Mirror repeats only after a there-AND-back pair, so its period is
// 4·w·half — which is why phase has always been a fraction of 4·w·half. Loop repeats
// after ONE segment, so its period is 2·w·half. Pad never repeats, but a phase row
// still needs a full-cycle unit, and one ramp is the only meaningful one — so pad
// shares loop's 2·w·half. The phase-1-is-identity law is preserved in every mode
// because phase is taken as a fraction OF THAT MODE'S OWN period.
export const GRADIENT_SPREAD_MODES = ["mirror", "loop", "pad"];
/** Human labels for the spread row, naming the visible consequence rather than the
 *  graphics-API word (an author picking one is choosing a picture, not a TileMode). */
export const GRADIENT_SPREAD_LABELS = {
  mirror: "Mirror (reflect back)",
  loop: "Loop (repeat from the start)",
  pad: "Pad (hold the end colours)",
};
/** Default spread: today's mirror reflection, so absent-is-legacy holds. */
export const GRADIENT_DEFAULT_SPREAD = "mirror";
/** How many half-vectors long ONE FULL CYCLE of a spread mode is, as a multiple of
 *  `wavelength·half`. Mirror needs the reflected "back" ramp to return to itself
 *  (4); loop and pad repeat/measure on a single ramp (2). This is THE number the
 *  phase shift multiplies, and the reason phase=1 is identity in every mode.
 *
 * @example spreadPeriodHalves("mirror") // 4  (there and back)
 * @example spreadPeriodHalves("loop") // 2  (one ramp, then start over)
 * @example spreadPeriodHalves("pad") // 2  (no repeat; one ramp is the cycle unit)
 * @example spreadPeriodHalves(undefined) // 4  (absent → mirror, the legacy default)
 */
export function spreadPeriodHalves(spread) {
  return (spread ?? GRADIENT_DEFAULT_SPREAD) === "mirror" ? 4 : 2;
}

// THE LINEAR-GRADIENT PHASE (user ruling: "the gradients have a wavelength option,
// but they don't have a phase option. All gradients should have a phase option.").
// PHASE is in WAVELENGTH UNITS: it shifts `center` along the axis by
// phase·wavelength·half (render_gpu/ir.js linearGradientRender folds it in beside
// wavelength, the SAME seam every backend already calls). phase=0 is the identity
// — an ABSENT phase is byte-identical to before this feature, the same
// absent-is-legacy precedent as center/wavelength. Because the mirror-tiled ramp
// (wavelength ≠ 1) repeats with period = one ramp segment, shifting by exactly one
// wavelength (phase = 1) maps the pattern onto itself: "phase 1.0 = shifted one
// full wavelength = identical" (user ruling). For an untiled ramp (wavelength = 1,
// Clamp tiling) phase still shifts the centered ramp along the axis, same as
// moving `center`, but there is no periodicity to return the picture to identical
// — Clamp has no repeat to return to.
/** Default phase: no shift (today's behaviour). */
export const GRADIENT_DEFAULT_PHASE = 0;

/**
 * Pure function. THE AVERAGE COLOUR of a piecewise-linear colour ramp — the exact
 * mean of the ramp read over its whole 0..1 domain, per channel.
 *
 * THIS IS WHAT A ZERO-WAVELENGTH GRADIENT PAINTS, and it is a LIMIT, not a
 * fallback. As the wavelength shrinks the ramp tiles ever more finely, so the
 * colour any pixel integrates over converges to the mean of one whole ramp. Every
 * spread mode converges to the SAME value: a mirrored copy is the same ramp read
 * backwards and has the same mean, and a looped copy is the same ramp again. So
 * the three backends can each paint a plain solid here and cannot disagree.
 *
 * THE INTEGRAL. Between two neighbouring stops the ramp is a straight line, whose
 * mean over that span is the midpoint of its endpoints — so a segment from t_i to
 * t_{i+1} contributes (c_i + c_{i+1})/2 · (t_{i+1} − t_i). Outside the stops the
 * ramp is CONSTANT (every backend clamps to the first/last stop colour), so the
 * PADDINGS contribute c_first · (t_first − 0) and c_last · (1 − t_last). Summing
 * those over the unit domain — total weight is exactly 1 — gives the mean directly,
 * with no sampling and no resolution to choose.
 *
 * Stops are taken in the order given (the stored order is authoritative everywhere
 * else in the paint pipeline — see the GRADIENT STOP LIST note above), and a
 * zero-width segment simply contributes zero weight, so duplicate offsets are
 * harmless rather than a special case.
 *
 * Args:
 *   stops ({offset: number, color: number[]}[]): >= 1 stop; color is [r,g,b,a] 0..1
 *
 * Returns:
 *   number[] — the mean [r, g, b, a]
 *
 * Examples:
 *   >>> rampAverageColor([{offset: 0, color: [0,0,0,1]}, {offset: 1, color: [1,1,1,1]}])
 *   [0.5, 0.5, 0.5, 1]   // black→white across the whole domain averages mid grey
 *   >>> rampAverageColor([{offset: 0, color: [1,0,0,1]}, {offset: 1, color: [0,0,1,1]}])
 *   [0.5, 0, 0.5, 1]     // red→blue averages purple — the colour a w=0 fill shows
 *   >>> rampAverageColor([{offset: 0.5, color: [1,1,1,1]}, {offset: 1, color: [1,1,1,1]}])
 *   [1, 1, 1, 1]         // the 0..0.5 padding is the first stop's colour, not black
 *
 * @example rampAverageColor([{offset: 0, color: [0,0,0,1]}, {offset: 1, color: [1,1,1,1]}]) // [0.5, 0.5, 0.5, 1]
 * @example rampAverageColor([{offset: 0, color: [1,0,0,1]}, {offset: 1, color: [0,0,1,1]}]) // [0.5, 0, 0.5, 1]
 * @example rampAverageColor([{offset: 0, color: [1,0,0,1]}, {offset: 0.5, color: [1,0,0,1]}, {offset: 1, color: [0,0,0,1]}]) // [0.75, 0, 0, 1]  (half held red, half ramping down)
 * @example rampAverageColor([{offset: 0.25, color: [1,1,1,1]}, {offset: 0.75, color: [1,1,1,1]}]) // [1, 1, 1, 1]  (paddings hold the end colours)
 * @example rampAverageColor([{offset: 0, color: [0.2,0.4,0.6,0.8]}]) // [0.2, 0.4, 0.6, 0.8]  (one stop is a solid)
 */
export function rampAverageColor(stops) {
  if (!Array.isArray(stops) || stops.length === 0)
    throw new Error(`rampAverageColor: needs at least one stop, got ${JSON.stringify(stops)}`);
  const sum = [0, 0, 0, 0];
  const addWeighted = (color, weight) => { for (let k = 0; k < 4; k++) sum[k] += color[k] * weight; };
  // The flat paddings out to the domain ends — the ramp holds its end colours there.
  addWeighted(stops[0].color, stops[0].offset);
  addWeighted(stops[stops.length - 1].color, 1 - stops[stops.length - 1].offset);
  // Each straight segment's mean is its endpoint midpoint, weighted by its span.
  for (let i = 0; i < stops.length - 1; i++) {
    const span = stops[i + 1].offset - stops[i].offset;
    for (let k = 0; k < 4; k++) sum[k] += ((stops[i].color[k] + stops[i + 1].color[k]) / 2) * span;
  }
  return sum;
}

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

/** Degrees → radians, THE one conversion factor. Every `kind: "angle"` consumer
 *  that needs radians goes through `angleRadians` below rather than redefining
 *  this; it was defined seven times across the material packers before R7-44a. */
export const DEG2RAD = Math.PI / HALF_TURN_DEG;

/**
 * Pure function. THE STORAGE UNIT of a `kind: "angle"` row — "radians" or
 * "degrees" — read from the row's OWN declaration.
 *
 * WHY THIS EXISTS AT ALL. `display: "degrees"` is not decoration: the rotary dial
 * always works in degrees, and `display` names the transform bridging the dial to
 * whatever the row STORES (web/displayUnits.js). So `display: "degrees"` has
 * ALWAYS meant "this row stores RADIANS" — the dial divides by 180/π on commit.
 * A row with no `display` stores whatever the dial writes, i.e. DEGREES.
 *
 * That was true but UNSTATED, so each material packer re-decided the unit for
 * itself: eleven agreed with their row and TWO DID NOT (atmosphere and mandelbrot
 * declared `display: "degrees"` — radians — while their packers multiplied by
 * π/180 as if degrees). Both were live bugs, not style drift: atmosphere's `-35`
 * default rendered on the dial as -2005°, and a -35° edit reached the shader as
 * -0.0107 rad instead of -0.611. Naming the rule as a function makes the unit
 * READ from one place instead of re-decided per packer, and makes the disagreement
 * expressible as a test rather than a comment.
 *
 * NOT a new key: reusing `display` is what keeps this a zero-migration change —
 * every stored angle in every deck and preset keeps its exact value.
 *
 * THE OTHER SPELLING. A plugin-material row (core/material_plugins.js) declares
 * `unit: "degrees"` instead, and it means the OPPOSITE — stored DEGREES, because a
 * data schema has no dial behind it and its author is answering "what unit is this
 * number". Both spellings are resolved HERE so that no caller has to know there are
 * two; a row carries one or the other, and declaring BOTH is refused rather than
 * silently resolved, since the two keys would be making contradictory claims.
 *
 * @param {{display?: string, unit?: string}} row - a material/inspector param row
 * @returns {"radians"|"degrees"}
 *
 * @example angleStorageUnit({name: "lightAngle", kind: "angle", display: "degrees"}) // "radians"
 * @example angleStorageUnit({name: "lightAngle", kind: "angle"}) // "degrees"
 * @example angleStorageUnit({name: "rotation", kind: "angle", unit: "degrees"}) // "degrees"
 */
export function angleStorageUnit(row) {
  if (row?.display === "degrees" && row?.unit === "degrees")
    throw new Error(`angleStorageUnit: row "${row.name ?? "?"}" declares BOTH display:"degrees" (stores radians) and unit:"degrees" (stores degrees) — these contradict; keep one`);
  return row?.display === "degrees" ? "radians" : "degrees";
}

/**
 * Pure function. A stored angle → RADIANS, converting per the row's declared
 * storage unit. THE one seam a shader packer calls: a packer states WHICH ROW it
 * is packing and never restates the unit, so a row and its packer cannot drift
 * apart the way atmosphere's and mandelbrot's did.
 *
 * @param {number} value - the stored angle, in the row's own unit
 * @param {{display?: string}} row - that row's declaration
 * @returns {number} radians
 *
 * @example angleRadians(-111.6, {name: "lightAngle", kind: "angle"}) // -1.9477874452256716
 * @example angleRadians(-1.9477874452256716, {name: "lightAngle", kind: "angle", display: "degrees"}) // -1.9477874452256716
 * @example angleRadians(90, {kind: "angle"}) // 1.5707963267948966
 */
export function angleRadians(value, row) {
  return angleStorageUnit(row) === "radians" ? value : value * DEG2RAD;
}

/**
 * Pure function. Builds a packer's degrees→radians converter by LOOKING THE ROW UP
 * in the schema it belongs to, by name: `schemaAngleRadians(ATMOSPHERE_FILL_PARAMS)`
 * returns `(name, value) => radians`.
 *
 * This is the shape that makes the unit un-restatable. A packer that wrote
 * `angleRadians(v, {display: "degrees"})` would be declaring the unit a SECOND
 * time next to the row, which is exactly the duplication that let atmosphere and
 * mandelbrot drift from their own declarations. Going through the schema means the
 * row is the only place the unit is written, so editing the row moves the packer
 * with it.
 *
 * LOUD on an unknown name: a typo'd or renamed knob would otherwise silently take
 * the degrees branch and mis-scale by 57.3.
 *
 * @param {Array<{name: string}>} params - a material's fillParams schema
 * @returns {function(string, number): number} (rowName, storedValue) → radians
 *
 * @example
 * // A row declaring display:"degrees" stores RADIANS, so its value passes through;
 * // a bare row stores DEGREES and is converted.
 * const toRad = schemaAngleRadians([{name: "spin", kind: "angle", display: "degrees"},
 *                                   {name: "tilt", kind: "angle"}]);
 * toRad("spin", 1.5) // 1.5
 * @example
 * const toRad = schemaAngleRadians([{name: "tilt", kind: "angle"}]);
 * toRad("tilt", 90) // 1.5707963267948966
 */
export function schemaAngleRadians(params) {
  const rows = new Map(params.map((row) => [row.name, row]));
  return (name, value) => {
    const row = rows.get(name);
    if (!row) throw new Error(`schemaAngleRadians: no param named "${name}" in this schema (declared: ${[...rows.keys()].join(", ")})`);
    return angleRadians(value, row);
  };
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
 *   vec2    → Vector2Pad over a SINGLE slot holding an `[x, y]` tuple, plus two
 *             numeric boxes — the collapsed `[X] [Y] [pad]` grammar R7-36 names,
 *             mounted as one control because the value here is ONE value.
 *             DISTINCT FROM THE COMPOUND ROW, and the difference is the whole
 *             reason this kind exists: a COMPOUND (core/properties.js COMPOUNDS)
 *             is GROUPING over two rows the widget already declares separately,
 *             so it writes two leaf paths; a `vec2` row's value is a single
 *             stored tuple with no leaves to group, so it writes one. A global
 *             variable is the case that has no leaves (core/var_kinds.js), which
 *             is why the vec2 VAR KIND waited on this control and not the
 *             reverse.
 *   nodeinput → a NODE WIDGET'S INPUT PORT: which output of which item is wired
 *             into it (core/nodeflow.js's `{item, port}`). A dropdown over the
 *             type-compatible outputs on the slide, plus a clear that
 *             DISCONNECTS. Its value is a reference, not a scalar, which is why
 *             it is its own kind rather than a `select` over item names: a select
 *             stores the string it shows, and this stores an itemId whose LABEL is
 *             re-derived from the item's current name at display time (so a rename
 *             needs no document rewrite — see core/expressions.js's header).
 *
 * @example ROW_KINDS.includes("boolean") // true
 * @example ROW_KINDS.includes("checkbox") // false (retired — see RETIRED_ROW_KINDS)
 * @example ROW_KINDS.includes("list") // true
 * @example ROW_KINDS.includes(NODE_INPUT_ROW_KIND) // true
 * @example ROW_KINDS.includes(VEC2_ROW_KIND) // true
 */
export const ROW_KINDS = ["number", "angle", "color", "boolean", "select", "asset", "text", "richtext", "action", LIST_ROW_KIND, NODE_INPUT_ROW_KIND, VEC2_ROW_KIND];

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
 * The row kinds whose Inspector control can render an UNSET state — a "(none)"
 * display plus a clear-to-nothing button — so `nullable: true` means something on
 * them (see THE `nullable` ROW ASPECT below). "asset" has had it since the
 * transition `sound` row (AssetField's own `nullable` prop); "number" gained it
 * with the slide LINGER, where absent and 0 are different instructions.
 *
 * Kept beside ROW_KINDS for the reason NUMERIC_ROW_KINDS is: "which controls can
 * show nothing" is a fact about the control vocabulary, and it is the ONE list a
 * new nullable kind is added to once its control learns the affordance.
 *
 * @example NULLABLE_ROW_KINDS // ["number", "asset"]
 * @example NULLABLE_ROW_KINDS.includes("boolean") // false (a checkbox has no unset display)
 */
export const NULLABLE_ROW_KINDS = ["number", "asset"];

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

/**
 * THE `code` ROW ASPECT — "this property's VALUE IS CODE" (user request,
 * 2026-08-02: "we need to have a way and properties for anything that is code…
 * you just have a bracket thing, like a double bracket at the end of it, which
 * would let you edit in the code editor… code things would always have a
 * language, so that it's syntax-related properly").
 *
 * A row declares `code: {language}` and web/Inspector.svelte renders a `{}`
 * button at the row's VALUE END which opens the shared full-screen editor
 * (web/CodeEditorModal.svelte, via app.openCodeModal) on THAT property, in THAT
 * language, committing as one undo unit. Nothing else is needed — no per-widget
 * UI, no companion button row.
 *
 * WHAT IT REPLACED, AND WHY. Five plugins (graph_line, graph_bars, mermaid,
 * codeblock, latex) each shipped a full-width `action` row labelled "Edit in code
 * editor…" underneath the property it edited. The user's objection is that this
 * is the wrong SHAPE: "there's an entire button under it. That's not how this
 * should be. It should be in the same property." A whole row for one property's
 * editor also cannot scale — every code-valued property in the app would cost a
 * row, and the reader has to infer which property the button below refers to.
 * The aspect makes the affordance a property of the ROW, exactly as `paint`,
 * `gallery` and `presets` are, so it is declared once per code-valued property
 * and looks the same everywhere.
 *
 * `language` is EITHER a string (the widget always writes that language) OR a
 * FUNCTION `(state) => string|null` when the widget's language is itself
 * document state — codeblock has a `language` PROPERTY, so its `code` row
 * declares `language: (s) => s.language`, and the editor colours what the widget
 * actually renders instead of a hardcoded guess. `null` means plain text.
 *
 * SEPARATE FROM the plugin-level `codeEditor: {property, language, title}`
 * descriptor, which is what DOUBLE-CLICKING the widget opens (web/widget_handlers.js
 * "code_modal") — one widget has at most one double-click target, but may have
 * any number of code-valued rows. Where both exist they name the same property
 * and agree on the language; the row aspect is the per-property affordance and
 * the descriptor is the per-widget activation.
 */
/** Query (throws). Validates one row's `code` aspect declaration. A malformed
 *  one would render a button that opens an editor on nothing, so it fails where
 *  it is written. `label` names the declaration in the error. */
function checkCodeRow(label, def) {
  if (!("code" in def)) return;
  const spec = def.code;
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new Error(`properties: ${label} declares a \`code\` aspect that is not an object — write \`code: {language: "javascript"}\` (see THE \`code\` ROW ASPECT).`);
  if (!("language" in spec))
    throw new Error(`properties: ${label} declares \`code\` with no \`language\` — a code editor with no language cannot highlight, so name one (or \`language: null\` for plain text).`);
  const { language } = spec;
  if (language !== null && typeof language !== "string" && typeof language !== "function")
    throw new Error(`properties: ${label} declares \`code.language\` of type ${typeof language} — it must be a string, a (state) => string|null function, or null.`);
  if (def.kind !== "text")
    throw new Error(`properties: ${label} declares \`code\` on a "${def.kind}" row — code is edited as TEXT, and the editor writes a string back, so only a text row may carry it.`);
}

/**
 * Pure function. This row's code LANGUAGE for a given widget state, or null for
 * plain text. Resolves the `code.language` aspect's two forms (a literal string,
 * or a function of the state — see THE `code` ROW ASPECT) so the Inspector and
 * any test read it through ONE place and cannot disagree about which form won.
 *
 * Args:
 *   row (object): a resolved Inspector row (may or may not carry `code`)
 *   state (object): the widget's folded state, read only by a function language
 *
 * Returns:
 *   string|null — the language id, or null (plain text / no code aspect)
 *
 * @example codeRowLanguage({key: "definition", code: {language: "mermaid"}}, {}) // "mermaid"
 * @example codeRowLanguage({key: "code", code: {language: (s) => s.language}}, {language: "python"}) // "python"
 * @example codeRowLanguage({key: "code", code: {language: null}}, {}) // null
 * @example codeRowLanguage({key: "w", kind: "number"}, {}) // null (no code aspect)
 */
export function codeRowLanguage(row, state) {
  const language = row?.code?.language;
  if (typeof language === "function") return language(state ?? {}) ?? null;
  return language ?? null;
}

/**
 * THE `nullable` ROW ASPECT — "this property may hold NOTHING, and nothing is
 * not zero". A row declares `nullable: true` and web/Inspector.svelte gives it a
 * CLEAR affordance (an × button at the value end) plus an UNSET DISPLAY: the
 * value column reads "(none)" in the dim empty styling instead of a scrubber.
 *
 * It already existed for kind:"asset" — AssetField has taken a `nullable` prop
 * since the transition `sound` row (an absent sound is silence, and "" is not a
 * legible spelling of that). What did NOT exist was any GENERAL machinery, so
 * nullability was bespoke to one control. This aspect is that machinery: a
 * number row declaring it gets the same two affordances, in the same language,
 * with no per-row code — and the next nullable kind is a branch in ONE place.
 *
 * WHY A NUMBER NEEDS IT AT ALL, given that a number row can already hold 0. For
 * `autoAdvance` (the slide LINGER) null and 0 are DIFFERENT INSTRUCTIONS: 0 says
 * "advance the instant this slide arrives", ABSENT says "never auto-advance —
 * wait for a click". Both consumers read it that way already
 * (core/presentation.armAutoAdvance arms a timer only for `typeof secs ===
 * "number"`; web/videoExport.timelinePlan falls back to DEFAULT_HOLD_SECONDS
 * only when it is absent), so a control that could only ever write a number
 * could set the linger but never take it back.
 *
 * SEMANTICS AT THE SEAM. The clear affordance writes literal `null`, never ""
 * and never NaN — the Inspector's `coerce()` passes null straight through
 * instead of running it into `Number(null) === 0`, which is precisely the
 * confusion this aspect exists to prevent. A nullable row's stored ABSENCE may
 * be `undefined` (never written) or `null` (cleared); both display as unset, and
 * only the write path normalizes to null.
 */
/** Query (throws). Validates one row's `nullable` aspect. `nullable` on a kind
 *  with no unset display would silently do nothing, so it fails where written. */
function checkNullableRow(label, def) {
  if (!("nullable" in def)) return;
  if (def.nullable !== true && def.nullable !== false)
    throw new Error(`properties: ${label} declares \`nullable: ${JSON.stringify(def.nullable)}\` — it is a boolean aspect (see THE \`nullable\` ROW ASPECT).`);
  if (def.nullable === true && !NULLABLE_ROW_KINDS.includes(def.kind))
    throw new Error(`properties: ${label} declares \`nullable\` on a "${def.kind}" row, but only ${JSON.stringify(NULLABLE_ROW_KINDS)} render a clear affordance and an unset display — give that kind one in web/Inspector.svelte before declaring it.`);
}

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
 *   tooltip is banned). `code` — THE CODE ASPECT: this property's value IS code,
 *   so the Inspector gives the row a `{}` button opening the shared full-screen
 *   editor on it, in the language the aspect names (see THE `code` ROW ASPECT
 *   above checkCodeRow). `default` — the fragment default value; omitted for
 *   keys with no universal default (a widget supplies it).
 *
 * NOTE the two rotation-anchor entries carry a NESTED-KEY convention: their
 * keys contain a dot ("rotationAnchor.x") — the Inspector's valueAt/keyframe
 * paths already split on ".", so a dotted registry key round-trips unchanged.
 */
/**
 * Pure function. Is a widget's `stroke` paint anything other than the OFF tag?
 * The row-visibility test for every stroke-ONLY row (width, offset, trim, caps —
 * PROPS' `visibleWhen`, read by web/Inspector.svelte's groupRows): while stroke
 * is Off there is nothing for those knobs to modify, so they hide rather than sit
 * there doing nothing (user ruling: "I still have stroke width options even when
 * stroke material is off, which is kind of dumb").
 *
 * A local re-implementation of render_gpu/ir.js's isPaintOff, not an import of
 * it: ir.js imports FROM this module (STROKE_TRIM_KEYS, the gradient defaults),
 * so the reverse import would cycle. The OFF tag's shape ({type:"none"}) is the
 * one piece of contract duplicated here, same as render_gpu/decorate.js's
 * independent fillIsVisible does for the fill slot.
 *
 * Args:
 *   state (object): the widget's evaluated state (only `.stroke` is read)
 *
 * Returns:
 *   boolean — true when the stroke-only rows should show
 *
 * @example strokeMaterialIsOn({ stroke: "#000000" }) // true
 * @example strokeMaterialIsOn({ stroke: { type: "none" } }) // false
 * @example strokeMaterialIsOn({}) // true (absent = a pre-row document's plain solid; never hide by default)
 */
export function strokeMaterialIsOn(state) {
  const stroke = state?.stroke;
  return !(stroke && typeof stroke === "object" && !Array.isArray(stroke) && stroke.type === "none");
}

/**
 * Pure function. Does this widget have a POSTER image set? The `visibleWhen` for
 * the `showThumbnail` toggle — a choice between the still and the clip is
 * meaningless when there is no still, so the row hides rather than sitting inert
 * (the `ditherEmphasis` precedent; see the `thumbnail` row's own comment for why
 * this one hides where `bitDepth` does not).
 *
 * THE THREE SPELLINGS OF "NO THUMBNAIL" ARE ALL ONE ANSWER, and that is the whole
 * reason this is a named predicate rather than a truthiness check inline: absent
 * (a document written before the row existed), `null` (the Inspector's clear
 * affordance, and the default the fill writes) and `""` all mean nothing is set.
 * `emit` reads the same three the same way.
 *
 * Args:
 *   state (object): the widget's evaluated state (only `.thumbnail` is read)
 *
 * Returns:
 *   boolean — true when a poster image is set, so the toggle has two things to choose between
 *
 * @example hasThumbnail({ thumbnail: "/asset/Deck/poster.png" }) // true
 * @example hasThumbnail({ thumbnail: null }) // false (cleared with the × affordance)
 * @example hasThumbnail({}) // false (a pre-poster document never wrote the key)
 */
export function hasThumbnail(state) {
  return typeof state?.thumbnail === "string" && state.thumbnail.length > 0;
}

/**
 * Pure function. Should the MITER LIMIT row show? Only when the stroke is on AND
 * its join is Miter — the limit is a knob ON the miter, meaningless for round or
 * bevel (neither can grow a spike, so neither has a length to cap). This is the
 * "subcategory for the dropdown" the miter-limit request asked for, expressed the
 * way this Inspector already expresses conditional rows.
 *
 * It COMPOSES strokeMaterialIsOn rather than re-testing the stroke: a bare join
 * check would leave the limit row sitting under an Off stroke, which is the exact
 * complaint that produced strokeMaterialIsOn in the first place.
 *
 * Args:
 *   state (object): the widget's evaluated state (`.stroke` and `.strokeJoin`)
 *
 * Returns:
 *   boolean — true when the miter-limit row should show
 *
 * @example strokeJoinIsMiter({ stroke: "#000", strokeJoin: "miter" }) // true
 * @example strokeJoinIsMiter({ stroke: "#000", strokeJoin: "round" }) // false
 * @example strokeJoinIsMiter({ stroke: "#000" }) // true (absent join IS miter)
 * @example strokeJoinIsMiter({ stroke: { type: "none" } }) // false (nothing to join)
 */
export function strokeJoinIsMiter(state) {
  return strokeJoinApplies(state) && (state?.strokeJoin ?? STROKE_JOIN_MITER) === STROKE_JOIN_MITER;
}

/**
 * Pure function. Can a JOIN reach this widget's stroke at all? Only a PLAIN
 * stroke — solid or gradient — is drawn by stroking the author's own outline with
 * a Skia Paint, which is the only thing a join setting acts on. A stroke MATERIAL
 * (wavy, dashes, along-gradient, the brushes) rebuilds or resamples that outline
 * and draws its own geometry, so a join id would either land on sampling
 * artefacts or on nothing (render_gpu/skia/stroke_materials.js strokePaintOf says
 * which, per material).
 *
 * So the two join rows hide behind a material rather than sitting there inert —
 * the same reason strokeMaterialIsOn hides the whole stroke block behind an Off
 * stroke, and the same standing rule that a control which looks settable and
 * changes nothing is a lie.
 *
 * A local re-implementation of render_gpu/ir.js's isMaterialPaint for the same
 * reason strokeMaterialIsOn re-implements isPaintOff: ir.js imports FROM this
 * module, so the reverse import would cycle.
 *
 * Args:
 *   state (object): the widget's evaluated state (only `.stroke` is read)
 *
 * Returns:
 *   boolean — true when the join rows should show
 *
 * @example strokeJoinApplies({ stroke: "#000000" }) // true (a plain solid stroke)
 * @example strokeJoinApplies({ stroke: { type: "linear", stops: [] } }) // true (a gradient strokes the same way)
 * @example strokeJoinApplies({ stroke: { type: "material", material: { id: "wavy" } } }) // false
 * @example strokeJoinApplies({ stroke: { type: "none" } }) // false (no stroke to join)
 */
export function strokeJoinApplies(state) {
  const stroke = state?.stroke;
  const isMaterial = !!(stroke && typeof stroke === "object" && !Array.isArray(stroke) && stroke.type === "material");
  return strokeMaterialIsOn(state) && !isMaterial;
}

export const PROPS = {
  // ── transform (bbox) ──────────────────────────────────────────────────────
  x: { label: "X", kind: "number", category: "transform", help: "Horizontal position of the widget's top-left corner, in canvas units (right is positive)." },
  y: { label: "Y", kind: "number", category: "transform", help: "Vertical position of the widget's top-left corner, in canvas units (down is positive)." },
  // cx/cy: a DERIVED shortcut for the box's center — x/y's own bundle-mate, not
  // a stored field of its own (no plugin default; core/expressions.js resolves
  // `self.cx`/`@slug.cx` by computing core/geometry.js boxCenter, never by
  // reading a stored slot, and this row NEVER appears in a saved document —
  // see the doctest at PROPS' bottom).
  //
  // `key` stays "cx"/"cy" — UNIQUE within a plugin's `.inspector` array, same as
  // every other row (core/multiselect.js intersectRows' own comment: "a key
  // declared twice by one plugin is a plugin defect"; a cx row sharing "x"
  // with the real x row broke exactly that invariant on first landing — a
  // plugin's inspector array is a LOOKUP TABLE by key elsewhere, e.g.
  // Inspector.svelte's multiByKey). `writeKey` ("x"/"y") is the SEPARATE
  // aspect naming the REAL stored slot: Inspector.svelte's own `writeKey(row)`
  // helper resolves it (falling back to `key` for every ordinary row) and uses
  // THAT — never `row.key` — to build every path/keyframe/equation call, so
  // NumericField's `path` prop already points at x/y by the time it gets
  // there; NumericField itself only needs `centerAxis` for its item-aware
  // inverse (core/geometry.js xForBoxCenterX/yForBoxCenterY). Typing "=" on
  // the row stores the equation on that same real path verbatim (same as any
  // other numeric row, no inversion attempted on a general equation).
  cx: { label: "Center X", kind: "number", category: "transform", writeKey: "x", centerAxis: "x", help: "Horizontal position of the widget's CENTER, in canvas units — a shortcut for x + width/2. Typing a value here moves x so the center lands exactly there; equivalent to reading self.cx in an equation." },
  cy: { label: "Center Y", kind: "number", category: "transform", writeKey: "y", centerAxis: "y", help: "Vertical position of the widget's CENTER, in canvas units — a shortcut for y + height/2. Typing a value here moves y so the center lands exactly there; equivalent to reading self.cy in an equation." },
  // NO `min` ON w/h — a NEGATIVE size is meaningful: it is a FLIP (core/geometry.js
  // "THE FLIP"; the Flip Content commands write exactly this, and dragging a resize
  // handle past the opposite edge produces it). A `min: 0` here would have made the
  // Inspector the one place in the app that could not express a flipped widget, and
  // would have silently clamped a legitimate stored value on edit. Contrast the
  // `min: 0` rows below (strokeWidth, blur, radii, rates): for those a negative
  // number has no meaning at all, which is what earns them a bound.
  w: { label: "Width", kind: "number", category: "transform", help: "How wide the widget is, in canvas units. Drag the side/corner handles to resize instead. A NEGATIVE width flips the widget horizontally — it covers the same area with its content mirrored left ↔ right." },
  h: { label: "Height", kind: "number", category: "transform", help: "How tall the widget is, in canvas units. Drag the side/corner handles to resize instead. A NEGATIVE height flips the widget vertically — it covers the same area with its content mirrored top ↔ bottom." },
  // THE universal transform rotation, inherited by every bbox widget through the
  // `transform` bundle. core stores RADIANS; the field edits/shows DEGREES
  // (manifest "Rotation is DEGREES" — round-10 ruling), which is what `display`
  // does — single-sourced here rather than re-typed per widget.
  // kind "angle" (the rotary DIAL) because a rotation IS a heading and the dial
  // is the control for one: the user's "why are we not using that [dial] in the
  // other places we have angles?". Storage is UNCHANGED by that switch (still
  // radians, still `display`-bridged) and the heading stays UNWRAPPED so a
  // 0 → 720° keyframe pair still tweens two whole spins (manifest: "Rotation is
  // an unwrapped angle (deltas can spin 720°)") — see the unit-kind note above.
  rotation: { label: "Rotation", kind: "angle", display: "degrees", category: "transform", default: 0, help: "Clockwise rotation in degrees, pivoting about the rotation anchor (its own center by default). Drag the dial, or type an exact angle — past 360° keeps counting, so a keyframed 720° spins twice." },
  "rotationAnchor.x": { label: "Rot anchor X", kind: "number", category: "transform", help: "The X of the point the widget rotates around. Defaults to the widget's own center; set it to another item's anchor to spin about that point." },
  "rotationAnchor.y": { label: "Rot anchor Y", kind: "number", category: "transform", help: "The Y of the point the widget rotates around. Defaults to the widget's own center; set it to another item's anchor to spin about that point." },
  z: { label: "Z order", kind: "number", category: "transform", help: "Stacking order: higher numbers draw on top of lower ones. Use Bring to Front / Send to Back to reorder without typing." },
  // THE ASPECT CHAIN LOCK's stored leaf (backburner AF; see ASPECT_LOCK_KEY for
  // why it is stored rather than panel-local, and why it is not keyframeable).
  // It carries NO `default`, so composing it into the transform bundle adds
  // nothing to any widget's stored state — absent IS off. It is declared here
  // rather than only in COMPOUNDS because core needs to NAME its kind (Tier 0
  // validates every "="-bindable slot against a declared kind) and because
  // core/expressions.js resolves `self.aspectLocked` like any other leaf.
  // IT IS DELIBERATELY NOT IN `BUNDLES.transform`, and that absence is what
  // keeps it out of every widget's row list: it surfaces as the Size compound's
  // CHAIN GLYPH, which reads the leaf directly. A `hidden` row aspect was
  // considered and rejected — nothing in the Inspector reads one, so declaring it
  // would have been an aspect that only looks like it does something.
  aspectLocked: { label: "Lock aspect ratio", kind: "boolean", category: "transform", keyframes: false, help: "While locked, editing width writes height (and vice versa) to preserve the widget's current proportions, and a corner or edge resize drag keeps them too." },
  // Declared here ONLY so core can NAME its kind: Tier 0 says every property is
  // "="-bindable, and resultKindForSlot needs a kind to validate against. There is
  // deliberately NO `default` — nothing composes `active` from a BUNDLES list, and
  // absent-means-visible must keep working for every existing document.
  active: { label: "Visible", kind: "boolean", category: "transform", help: "Whether the item draws on this slide. Deleting keyframes this off rather than removing the item, so it can come back on a later slide; Purge removes it for good." },
  // THE UNIVERSAL MORPH PROPERTY (core/morph_property.js is the authority on the
  // design and carries the user ruling verbatim). Declared here, beside `active`,
  // because it is the same KIND of thing: a universal per-widget property that
  // core must be able to name a kind for, with deliberately NO `default` —
  // absent means Auto and must keep meaning that for every existing document.
  //
  // It replaces the per-key `~interp` morph mode, which could only ever ask about
  // the ONE leaf that changed and therefore could not reach an equation edit at
  // all. This row asks about the widget's OUTLINE, so a retype, an icon swap, a
  // re-typeset equation and a tooth-count change all travel through one control.
  [MORPH_KEY]: {
    label: "Morph", kind: "select", options: MORPH_MODES, optionLabels: MORPH_MODE_LABELS,
    category: "transform",
    help: `How this widget's SHAPE crosses a transition when it changes — a different widget type, a new icon, an edited equation, a different number of teeth. ${MORPH_MODES.map((id) => `${MORPH_MODE_LABELS[id]} — ${MORPH_MODE_HELP[id]}`).join(" ")}`,
  },
  // THE UNIVERSAL delay PROPERTY (manifest "THE `delay` UNIVERSAL PROPERTY —
  // DESIGN"; user, request 3: "we have to add... a delay to visibility... the
  // delay option should delay whatever tween a given object has"). Declared
  // beside `active`/morph for the same reason both are: a per-widget property
  // core must be able to name a kind for, universal rather than plugin-owned.
  //
  // SECONDS, and the shared unit-kind (SECONDS_SCRUB) rather than a re-typed
  // one, so it scrubs at the same rate every other seconds row does (manifest
  // 14.6). UNCLAMPED — no `min`/`max` — per the no-arbitrary-constraints law: a
  // delay longer than the transition itself is a legal STEP-AT-THE-END, not an
  // error (core/document.js foldState is where that degenerate case is enforced).
  // Deliberately NO `default`: absent means 0, and 0 must stay byte-identical to
  // every document written before this property existed.
  delay: {
    label: "Delay", kind: "number", scrub: SECONDS_SCRUB, category: "transform",
    help: "Seconds to hold this item at its PREVIOUS state before its own tween into this slide begins — transform, fade, visibility, whatever the item's delta changes here. The item's own transition then plays over whatever time remains, eased by the transition's curve. A delay at or beyond the transition's length holds the item until the very end, then switches — no floor, no ceiling.",
  },

  // ── transform (endpoint-pair — arrows) ────────────────────────────────────
  "from.x": { label: "From X", kind: "number", category: "transform", help: "X of the arrow's tail (its start point). Drag the tail handle on canvas, or bind it to an anchor to make it follow another item." },
  "from.y": { label: "From Y", kind: "number", category: "transform", help: "Y of the arrow's tail (its start point). Drag the tail handle on canvas, or bind it to an anchor to make it follow another item." },
  "to.x": { label: "To X", kind: "number", category: "transform", help: "X of the arrow's head (its end point). Drag the head handle on canvas, or bind it to an anchor to make it point at another item." },
  "to.y": { label: "To Y", kind: "number", category: "transform", help: "Y of the arrow's head (its end point). Drag the head handle on canvas, or bind it to an anchor to make it point at another item." },
  // THE THIRD POINT of a three-point connector (the brace family). Declared here
  // beside from/to rather than inside plugins/brace.js because it is the SAME
  // KIND OF THING — a free, draggable, anchorable world point with an equation-
  // aware numeric field — and the shared registry is what stops two rows that
  // mean the same thing drifting apart. Deliberately NOT added to the
  // `endpoints` bundle: that bundle is a PAIR, composed by every two-point
  // connector, and widening it would give every arrow a tip row it has no use for.
  "tip.x": { label: "Tip X", kind: "number", category: "transform", help: "X of the brace's pointy bit. It is a free point like the two ends — drag it, or bind it to an anchor so it follows another item. Where it sits ALONG the span slides the point left or right; how far it sits OFF the span is how far the brace bulges, and which SIDE it is on flips the brace." },
  "tip.y": { label: "Tip Y", kind: "number", category: "transform", help: "Y of the brace's pointy bit. It is a free point like the two ends — drag it, or bind it to an anchor so it follows another item. Where it sits ALONG the span slides the point left or right; how far it sits OFF the span is how far the brace bulges, and which SIDE it is on flips the brace." },
  // THE BRACE'S LOOK, as two CONTINUOUS knobs rather than a style enum — so a
  // curly brace, a right-angle bracket and a straight chevron are points in one
  // square and every path between them is reachable, keyframeable and tweenable.
  // An enum could not be halfway between two of its values, which is exactly what
  // the user asked for ("interpolate between that and a straight-liney version…
  // and another that's right angle, smoothly").
  curl: { label: "Curl", kind: "number", min: 0, max: 1, step: 0.01, scrub: true, category: "formatting", help: "How rounded the brace's corners are. 0 is a sharp right-angle bracket, 1 is a fully rounded curly brace, and everything between is a smooth blend — so you can keyframe a bracket softening into a brace." },
  shoulder: { label: "Shoulder", kind: "number", min: 0, max: 1, step: 0.01, scrub: true, category: "formatting", help: "How much of a bracket profile the arms have. 1 runs them alongside the span before turning out to the point — the classic brace or bracket. 0 collapses them into straight lines from each end to the point, giving a plain chevron. Blend it with Curl to reach any look between a curly brace, a square bracket and a simple V." },

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
  strokeWidth: { label: "Stroke width", kind: "number", min: 0, category: "strokeMaterial", default: 0, help: "Thickness of the outline in canvas units. Zero means no outline.", visibleWhen: strokeMaterialIsOn },
  // SCREEN-SPACE STROKE (user, 2026-08-02): "this is NOT a material, this is an
  // OPTION FOR STROKE which is screen space… it stays the same width no matter how
  // much I zoom in or zoom out, similar to how UI elements are." A boolean on the
  // SHARED bundle, so every stroke-bearing widget gets it at once — he corrected
  // himself to exactly that shape mid-request, and R6-4's audit agrees this is a
  // property row (one key, no canvas mode) rather than a tool in property clothes.
  //
  // THE UNIT IS THE CAMERA'S LOGICAL PIXEL: "screen pixels is literally just LOGICAL
  // PIXELS; the camera defines pixels, and it changes when we do high DPI vs low
  // DPI." So it cancels magnification and leaves resolution alone — see
  // core/clip.screenSpaceDivisor, which explains why cancelling view.zoom outright
  // would have halved every exported stroke.
  strokeScreenSpace: { label: "Screen-space width", kind: "boolean", category: "strokeMaterial", default: false, help: "Keep the outline the same thickness on screen however far you zoom — like a UI element rather than part of the drawing. Measured in the camera's logical pixels, so a higher-resolution export still renders it proportionally.", visibleWhen: strokeMaterialIsOn },
  // THE STROKE ALIGNMENT knob (user ruling: "-1 means completely inner, 1 means
  // completely outer, 0 means the default, which is in the middle... for every
  // stroke thing"). CONTINUOUS, not a three-way select, so it keyframes and takes
  // an equation like any other number; the row's [-8,8] range is wider than the
  // MEANINGFUL range (below) so NumericField's scrub has room without clamping a
  // deliberately large drag. NO `default` — absent IS centered (the strokeStart/
  // End absent-is-legacy precedent): nothing bakes it into a widget's state and
  // every existing document renders byte-identically.
  //
  // THE SEMANTICS, once, here: the band's CENTER sits at distance |o|·w/2 from the
  // path edge. |o| ≤ 1 (the ORIGINAL range) the band still touches the edge — the
  // ink covers a·w INSIDE the outline and (1−a)·w OUTSIDE it, a = (1−o)/2. So o=0 ⇒
  // a=1/2 (half in, half out — Skia's centered stroke), o=−1 ⇒ a=1 (all inside),
  // o=+1 ⇒ a=0 (all outside). render_gpu/ir.js strokeInsideFraction is that
  // formula, single-sourced. |o| > 1 (user ruling: "Stroke contour beyond plus or
  // minus one — yeah, I'd like that") DETACHES the band into a PARALLEL CONTOUR
  // ring floating past the edge — inside for o < -1, outside for o > 1 —
  // continuous with the attached case at exactly ±1 (both describe the same
  // center distance). render_gpu/ir.js strokeOutwardReach/detachedRectContour/
  // detachedEllipseContour carry that half of the law.
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
  // scrubMin/scrubMax, not min/max: -1..1 is the useful DRAG sweep (the
  // alignment range), but any finite value is a meaningful detached contour
  // (render_gpu/ir.js normalizeStrokeOffset refuses only non-finite) — a typed
  // number or an equation binding must reach it uncapped. See this file's
  // "SCRUB RANGE vs HARD BOUNDS" note. Was min:-8/max:8 (a round-18 guess at
  // "far enough to be useless past it" that clamped typing and equations too,
  // the wrong half of the fix once detachment made every finite value real).
  strokeOffset: { label: "Stroke offset", kind: "number", scrubMin: -1, scrubMax: 1, category: "strokeMaterial", help: "Which side of the edge the outline sits on: -1 draws it fully inside the shape, 0 straddles the edge, +1 draws it fully outside. Beyond ±1 the outline DETACHES into a parallel contour floating past the edge — inward beyond -1, outward beyond +1. Drag is limited to -1..1; type or bind any finite value to place a detached ring.", visibleWhen: strokeMaterialIsOn },
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
  strokeStart: { label: "Stroke start", kind: "number", min: 0, max: 1, category: "strokeMaterial", help: "Where the drawn outline BEGINS, as a fraction of its total length (0 = the very start, 1 = the very end). Raise it to reveal the stroke from its end inward; keyframe it for a draw-on animation.", visibleWhen: strokeMaterialIsOn },
  strokeEnd: { label: "Stroke end", kind: "number", min: 0, max: 1, category: "strokeMaterial", help: "Where the drawn outline ENDS, as a fraction of its total length (1 = fully drawn). Lower it to leave the tail undrawn; keyframe 0 → 1 to draw the stroke on over time.", visibleWhen: strokeMaterialIsOn },
  // AN ANGLE PROPERTY (user ruling: "phase can be represented as an angle
  // property") — the rotation DIAL, stored in DEGREES exactly as the commit
  // that introduced it says ("Storage is degrees"): render_gpu/ir.js
  // applyStrokeTrim divides by 360 once at the state->op seam, and every
  // consumer wraps via mod1, so a 0° → 360° keyframe marches the pattern once
  // around the outline "like a choo-choo train" (the user's spec, verbatim).
  // display IS ABSENT (identity), not "degrees": web/displayUnits.js's
  // "degrees" name means "stored value is RADIANS" (the ROTATION convention —
  // AngleField/NumericField's dial divides a typed value by 180/π before
  // storing). Naming it here made a typed 90° store as ~1.571, which the /360
  // seam above then read as 1.571 RAW DEGREES-OF-LOOP — a full loop needed a
  // typed value in the TENS OF THOUSANDS (the reported bug, verbatim: "I have
  // to go through an absurdly high number, like in the thousands"). AngleField's
  // own docstring names the right precedent: "gradient angle/particleAngle
  // store raw degrees and pass nothing (identity)" — strokePhase is that same
  // shape (dial shows what is stored, no conversion), not the rotation shape.
  strokePhase: { label: "Stroke phase", kind: "angle", category: "strokeMaterial", help: "Rotates where position 0 sits along the outline, in degrees — and where a dashed/dotted pattern starts and collapses. Keyframe 0° → 360° and the pattern marches once around the shape like a train on a loop of track; it wraps seamlessly, so 370° looks exactly like 10°.", visibleWhen: strokeMaterialIsOn },
  strokeCapStart: { label: "Start cap", kind: "select", options: STROKE_CAP_MODES, optionLabels: STROKE_CAP_LABELS, category: "strokeMaterial", help: "How the START of a trimmed/open stroke is finished: Flat cuts it flush, Round adds a half-disc, Taper narrows it to a point like a lifted brush. No effect on a closed shape drawn at full length (it has no free end).", visibleWhen: strokeMaterialIsOn },
  strokeCapEnd: { label: "End cap", kind: "select", options: STROKE_CAP_MODES, optionLabels: STROKE_CAP_LABELS, category: "strokeMaterial", help: "How the END of a trimmed/open stroke is finished: Flat cuts it flush, Round adds a half-disc, Taper narrows it to a point. No effect on a closed shape drawn at full length (it has no free end).", visibleWhen: strokeMaterialIsOn },

  // ── formatting: THE STROKE-JOIN pair ─────────────────────────────────────────
  // Where the caps above finish a stroke's free ENDS, these two finish its
  // CORNERS — so unlike the caps they bite on every stroke, closed or open,
  // trimmed or full. Same ABSENT-IS-LEGACY discipline as the whole block: neither
  // carries a `default`, an absent join IS miter and an absent limit IS
  // STROKE_MITER_LIMIT, and render_gpu/ir.js drops either at the op boundary when
  // it holds the identity, so no existing document's state or rendering moves.
  //
  // strokeMiter's row hides unless the join is Miter (strokeJoinIsMiter) — it is
  // the miter's own sub-option, and a limit row beside a Round join would be a
  // control that reports nothing and changes nothing. Both rows hide behind a
  // stroke MATERIAL too (strokeJoinApplies): a material draws its own resampled
  // geometry, so a join id cannot reach the author's corners.
  //
  // NO `step`, deliberately: the strokeOffset note above applies verbatim — no
  // `default` means defaultStep's precision fallback gives continuous scrubbing,
  // and tests/default_step_test.js pins opacity/particleFade as the ONLY two
  // number props allowed to declare one.
  // `min` but no `max`: a ratio under 1 is geometrically unsatisfiable (see
  // STROKE_MITER_LIMIT_MIN), while a huge limit is the legitimate "never give up
  // on the point" — the SCRUB RANGE vs HARD BOUNDS split, landing on a hard floor
  // and no ceiling.
  strokeJoin: { label: "Stroke join", kind: "select", options: STROKE_JOIN_MODES, optionLabels: STROKE_JOIN_LABELS, category: "strokeMaterial", help: "How the outline turns a CORNER: Miter runs both outer edges out to a sharp point, Round arcs across it, Bevel cuts straight across. A sharp enough corner would give Miter an arbitrarily long spike, so it falls back to a bevel past the miter limit below.", visibleWhen: strokeJoinApplies },
  strokeMiter: { label: "Miter limit", kind: "number", min: STROKE_MITER_LIMIT_MIN, category: "strokeMaterial", help: "How long a mitered point may get before it gives up and bevels, measured in multiples of the half stroke width. 4 (the standard) keeps the point down to about a 29° corner, 10 down to about 11°, and 1 bevels every corner. Only applies to the Miter join.", visibleWhen: strokeJoinIsMiter },

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
  // ── dither: THE REUSABLE DITHER BUNDLE (user, 2026-08-08: "These should all be
  // bundled up into a dithering options property bundle - since other things might
  // use dither soon too" … "not just gradient") ────────────────────────────────
  //
  // These four are THE declaration of the dither options — labels, help, options,
  // bounds, defaults and visibility — and they are single-sourced HERE rather than
  // in the one editor that happens to render them today. Compose them anywhere with
  // `bundle("dither")` + `bundleDefaults("dither")`, exactly as a widget composes
  // `bundle("effects")`.
  //
  // TWO SURFACINGS, ONE DECLARATION. A future ITEM-level consumer gets these rows
  // through Inspector's ordinary PROPS path (including `visibleWhen`, which
  // groupRows already resolves) and lands them in a "Dither" accordion — the
  // category id title-cases, so no Inspector change is needed. The PAINT-level
  // consumer that ships today (web/PaintField.svelte, on a gradient fill/stroke)
  // reads the SAME rows out of this bundle instead of hand-writing them, so the two
  // cannot drift. That also RESOLVED a deviation recorded a day earlier: those rows
  // used to be hand-written markup with no PROPS row for a `visibleWhen` to sit on,
  // which is why the emphasis gate had to be spelled as a bare `{#if}`. It now hangs
  // where every other gate in this file hangs.
  //
  // THE KEYS ARE THE SAME AT BOTH LEVELS (`ditherMode` on a paint, `ditherMode` on
  // an item), which is what lets ONE `visibleWhen` predicate serve both: the
  // functions below read `.ditherMode` off whatever object they are handed.
  ditherMode: { label: "Dither", kind: "select", options: DITHER_MODES, optionLabels: DITHER_MODE_LABELS, category: "dither", default: PAINT_DITHER_DEFAULT_MODE, help: "Scatters pixels between the nearest representable colors so stair-step banding dissolves into fine grain. Bayer is a fixed ordered matrix (a regular cross-hatch); blue noise is an irregular scatter with no pattern the eye can lock onto; off disables it." },
  ditherBayerSize: { label: "Bayer grid", kind: "select", options: DITHER_BAYER_SIZES, optionLabels: DITHER_BAYER_SIZE_LABELS, category: "dither", default: PAINT_DITHER_DEFAULT_BAYER_SIZE, visibleWhen: paintDitherIsBayer, help: "Edge length of the ordered Bayer matrix. Smaller is a coarser, more obvious cross-hatch with fewer levels (2×2 has four); larger is finer and closer to smooth (16×16 has 256). Only applies to the Bayer mode — blue noise has no matrix." },
  ditherEmphasis: { label: "Dither emphasis", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "dither", default: PAINT_DITHER_DEFAULT_EMPHASIS, visibleWhen: paintDitherIsOn, help: "How strongly the pattern is applied, measured in quantization steps: 1 spreads each pixel across the two nearest levels, which is full strength at any bit depth. Above 1 over-emphasizes into pronounced grain (no upper cap); 0 is none." },
  bitDepth: { label: "Bit depth", kind: "number", min: PAINT_MIN_BIT_DEPTH, max: PAINT_MAX_BIT_DEPTH, scrub: 1, category: "dither", default: PAINT_DEFAULT_BIT_DEPTH, help: "How many bits per color channel to reduce to. 8 is the screen's own depth and changes nothing; 1 is two levels per channel — eight colors — for a hard posterized look. Reachable WITHOUT a dither, which is what makes flat banded color a look of its own." },
  // NO EXPLICIT `step` ON bitDepth, deliberately: its default is the INTEGER 8, so
  // numberStep's precision fallback already derives step 1: an explicit one would be
  // redundant AND would break tests/default_step_test.js's enumeration, which exists
  // to state that only the 0..1-knob-with-integer-default rows need to override it.
  // `scrub` (drag sensitivity) is a different aspect and is set: one bit per unit.

  // NO CAMERA DITHER ROWS. `ditherMode`/`ditherEmphasis` used to sit on this line as
  // whole-scene camera render settings and were UPROOTED (user ruling, 2026-08-07 —
  // see DITHER_MODES above). Dither is now a PAINT property, authored per gradient
  // in web/PaintField.svelte, because the thing that bands is one fill, not the
  // frame. Do not re-add them here: a camera-wide dither is the design that was
  // overruled, and core/document.js withCameraDitherDropped exists to remove the
  // leaves from documents that still carry them.

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
  // THE SLIDE LINGER. Stored on the SLIDE (`slide.autoAdvance`), not inside the
  // transition record — see core/transitions.js's `slideField` aspect for why the
  // row sits with the transition rows anyway. It shares `seconds`' unit-kind
  // (SECONDS_SCRUB, min 0) so both time rows on that panel scrub at one rate.
  // `nullable` is the whole point: null and 0 are different instructions here
  // (0 = advance immediately, absent = never), and BOTH consumers already read it
  // that way, so a row that could only write a number could set a linger but never
  // take it back.
  autoAdvance: { label: "Linger", kind: "number", min: 0, scrub: SECONDS_SCRUB, nullable: true, category: "transition", help: "How long this slide waits before advancing on its own, in seconds. Cleared (—) it never advances by itself: the presenter waits for a click, and a video export holds the slide for its default dwell. Set, the presenter lingers this long after the transition finishes and then moves on, and an export uses it as this slide's dwell." },

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
  // ── THE VIDEO POSTER (user: "for powerpoint, they have thumbnail files for
  // their videos to be shown before playing … we have to have an optional
  // thumbnail parameter on videos - that has a toggle between whether we show
  // the thumbnail image or show the video") ──────────────────────────────────
  // TWO ROWS, NOT ONE, because they answer two different questions and PowerPoint
  // asks both: WHICH still (an image asset, optional) and WHETHER it is showing
  // instead of the clip. A single tri-state ("off | thumbnail | video") would make
  // choosing a poster and displaying it the same act, so an author could not keep a
  // poster attached while previewing the video — which is exactly the state a PPTX
  // import lands in (see plugins/video.js's POSTER section).
  //
  // NULLABLE, and its default is `null` — the transition `sound` discipline (THE
  // `nullable` ROW ASPECT above): an absent poster is NOTHING, and "" is not a
  // legible spelling of that. `null` is also what makes the addition FREE for
  // every existing deck, and that is MEASURED rather than assumed: a `null` leaf
  // in a delta is the DELETE SENTINEL, so `withMissingDefaultsFilled` writes it
  // once, `foldState` folds it straight back to ABSENT, and `emit` sees
  // `undefined` — the same value it would have seen had the row never existed.
  // The fill is quiet (version skew, not a deletion) and idempotent on the second
  // pass. So a pre-poster video renders byte-identically and re-saves clean.
  thumbnail: { label: "Thumbnail", kind: "asset", assetKinds: ["image"], assetForm: "url", nullable: true, default: null, category: "formatting", help: "An optional still image to show in place of the video — PowerPoint's poster frame. Pick an image asset, or clear it (×) for none. The Show thumbnail toggle below chooses which one is actually displayed." },
  // THE TOGGLE. Default FALSE so a video keeps showing the video: attaching a
  // poster must not silently replace what the widget already draws, and a PPTX
  // import that carries a poster in deliberately leaves this off (our players are
  // click-to-play, so the poster is AVAILABLE, not forced — stated in
  // core/pptx_translate/media.js).
  // HIDDEN UNTIL THERE IS A THUMBNAIL, the `ditherEmphasis` precedent: a toggle
  // between a picture and a clip is meaningless when one of the two does not
  // exist. Unlike `bitDepth` (which means something alone and therefore stays
  // visible), this row has NOTHING to choose between with no poster set — so it
  // hides rather than sitting there inert.
  showThumbnail: { label: "Show thumbnail", kind: "boolean", category: "formatting", default: false, visibleWhen: hasThumbnail, help: "Show the thumbnail image instead of the video. Off (the default) plays the video as usual; on, the widget draws the still — which is also what a headless render draws when it cannot decode video." },
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

  // ── formatting: RASTER DENSITY (the shared "how crisp is this raster" knob) ──
  // User, 2026-08-02: "why no control over DPI in pdf packet and paper peacock?"
  // Both widgets computed their raster resolution ENTIRELY automatically —
  // `(world.scale ?? 1) * SUPERSAMPLE_DENSITY` — with no way to ask for more (a
  // fan of sheets printed at poster size) or less (a deck of many packets whose
  // rasters are eating the budget). This row is that control, defined ONCE so the
  // two widgets cannot drift apart on what "density" means.
  //
  // ── IT MULTIPLIES, IT IS NOT AN ABSOLUTE DPI, AND THE CACHE KEY IS WHY ───────
  // The number that reaches render_gpu/gpu/pdf_page_raster.js is a pdfjs `scale`:
  // DEVICE PX PER PDF POINT. Both widgets derive it as
  // (the local px the page spans · density) / (the PDF points it spans), so the
  // scale ALREADY carries the widget's size and the camera's zoom, and the cache
  // key `pdfpage:<src>:<page>:<roundPdfScale(scale)>` is keyed on exactly that
  // resolved figure. An ABSOLUTE DPI would have to overwrite that composition
  // — it would mean "ignore how big this is on screen and how far you are zoomed
  // in" — which is a DIFFERENT feature (plugins/pdf_page.js's `renderMode:
  // "raster"` + rasterWidth/rasterHeight/rasterDPI is that feature, and it is
  // deliberately a fixed-size CACHED mode, not a density tweak). A multiplier
  // COMPOSES with zoom instead of fighting it: 2 means "twice the pixels you
  // would have picked", at every size and every zoom, which is the thing an
  // author actually wants when a fanned sheet looks soft.
  //
  // DEFAULT 1 IS EXACTLY TODAY'S BEHAVIOUR, and that is the point: an absent
  // value multiplies by 1, so the computed scale, the rounded scale, the cache
  // key and the pixels are all byte-identical for every document written before
  // this row existed (the absent-is-legacy precedent).
  //
  // NO UPPER CAP on the row: pdf_page_raster caps the ACTUAL allocation itself
  // (rasterFitFactor against PDF_MAX_RASTER_DIM) and reports loudly when it bites,
  // so an ambitious number degrades to "as crisp as the heap allows, and it said
  // so" rather than being silently clamped at the Inspector. `min` IS declared:
  // a zero or negative density has no meaning (roundPdfScale would floor it to
  // the step anyway, which would be a silent lie about what was asked for).
  rasterDensity: { label: "Raster density", kind: "number", min: 0.1, step: 0.1, category: "formatting", default: 1, help: "Multiplies how many pixels each PDF page is rasterized at. 1 (the default) is the automatic choice, which already accounts for the widget's size and your zoom level; 2 renders twice as densely for a crisper page when it is printed or exported large; 0.5 halves it to save memory in a deck with many pages. Very high values are capped to what fits in memory, and the console says when that happens." },

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

  // ── effects: BLUR (the effects bundle's sixth effect) ───────────────────────
  // A plain GAUSSIAN BLUR of the widget's whole composite — the SIMPLEST member
  // of the family, and the one the other blur-shaped effects were already built
  // on: bloom is this blur plus an RGB over-glow added back on top
  // (render_gpu/skia/paint_skia.js bloomFilter = MakeBlur ∘ channelScaleMatrix),
  // and the drop shadow is this blur applied to a tinted silhouette. Adding it as
  // its own knob costs one ImageFilter.MakeBlur at the SAME effectSubtree seam;
  // it is not a new substrate.
  //
  // NOT the same thing as plugins/blur.js (the full-screen backdrop blur, which
  // blurs what is BEHIND a region and has no widget of its own). This blurs the
  // WIDGET, is universal through the bundle, and every drawn widget inherits it.
  //
  // THE KEY IS `gaussianBlur`, NOT `blur`, AND THAT IS FORCED RATHER THAN CHOSEN.
  // `blur` is already a TOP-LEVEL property of plugins/blur.js (its backdrop radius,
  // in its own `blur` category), and tests/universal_effects_test.js's exclusion
  // check reads exactly this: an EXCLUDED plugin must not offer a single row whose
  // key is in BUNDLES.effects. The blur widget is one of the four declared
  // exclusions (no bbox, no effectBounds hook — nothing to bound a substrate with),
  // so a bundle key named `blur` would make its own unrelated radius row read as a
  // universal effect row it cannot honour. That is a real collision in the ONE
  // namespace equations and keyframe paths share, not a test technicality: `= blur`
  // in an equation would be ambiguous between the two. (`blurRadius` was the next
  // candidate and is likewise taken — plugins/demo/crt.js.) Note that the drop
  // shadow's own softness is NESTED (`shadow.blur`) and so never collided.
  //
  // GATE = the RADIUS itself, like softEdges and unlike shadow/inner-shadow (which
  // gate on opacity): gaussianBlur default 0 is THE off state — a 0-radius Gaussian
  // is the identity, so every pre-blur document renders byte-identically. A single
  // scalar (equation slug `gaussianBlur`), min 0 (a negative sigma is meaningless).
  //
  // UNLIKE softEdges IT SPILLS OUTWARD, so it DOES contribute a cull halo:
  // effectsCullMargin / effectSubtree.margin count BLUR_SUPPORT_SIGMAS·radius for
  // it, exactly as they do for the bloom radius (same Gaussian, same support
  // bound). A blurred widget's ink genuinely reaches past its box.
  //
  // The radius is a Gaussian SIGMA in canvas units — the shared convention of
  // shadow.blur / bloom.radius / blurBackdrop (render_gpu/ir.js). NO `scrub`
  // declaration: it is an open-topped magnitude with a nonzero-feeling range in the
  // tens, exactly like `shadow.blur` and `bloom.radius`, and those take the
  // default 1 unit/px. (The `scrub: UNIT_SPAN_SCRUB` rows are the ones whose
  // interesting span is 0..1, where 1 unit/px would flick the control end to end.)
  gaussianBlur: { label: "Blur", kind: "number", min: 0, category: "effects", default: 0, help: "Blurs the whole widget with a Gaussian blur of this radius, in canvas units. Zero is perfectly sharp (off — the default); larger values smear it further, and the blur spreads OUTSIDE the widget's box the way a soft shadow does. This blurs the widget itself; the separate Blur widget blurs whatever is behind it." },

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

  // ── keyboard: THE LATCHED CHORD (a LIST property — core/lists.js) ─────────────
  // R7-13, user verbatim: "I also want a keyboard whose keys I can lock in place …
  // When it's locked on, the keys will stay turned on at all times. In the UI, in
  // other words, to let me play different chords and different slides."
  //
  // ── WHY A LATCHED KEY IS DOCUMENT STATE WHEN A PRESSED ONE IS NOT ────────────
  // core/live_control.js's ruling on a PRESS stands and is not being weakened: "a
  // button/key PRESS is LIVE — a moment is not a value, and a leaf for it would be
  // the ephemeral state this project has none of". A LATCH is the other thing. The
  // user asked for keys that stay on "at all times", per slide, so that slide 2 can
  // hold a different chord from slide 1 — that is not a moment, it is a VALUE, and
  // the only way "different chords on different slides" can work is if it folds and
  // keyframes like every other property. So the two coexist without contradiction:
  // the press that TOGGLES a latch is live, and the latch it toggles is state.
  //
  // A SEQUENCE, not sorted: the order is the order the author latched them, and a
  // chord has no canonical order to enforce. Nothing reads position — the consumer
  // is a SET of notes — so sorting would buy nothing and would renumber the very
  // indices `heldNotes.2.note` equations are bound to.
  //
  // Storage is a TUPLE ([note]) for the reason `frames` and `points` are tuples:
  // core/interpolators.js interpolate() takes its pure-numeric-array branch for an
  // all-number array, where a RECORD would recurse to the per-element path.
  //
  // CORRECTION (2026-08-08, measured): the sentence that used to follow said the
  // "int rule ROUNDS a lerp between two" integers on this branch. IT DOES NOT —
  // interpolators.js:146 says so in as many words ("NO int-rounding"); the int rule
  // is on the SCALAR path. A numeric tuple LERPS CONTINUOUSLY, so a chord tweening
  // across a transition really does pass through quarter-tones. Nothing is broken by
  // that, because `latchedNotes` ROUNDS on read — but it rounds because it chooses
  // to, not because the tween did it. Do not design against the old claim.
  //
  // No minLength: an empty chord is the ordinary resting state of an unlatched
  // keyboard, not a malformed list.
  heldNotes: {
    label: "Held Notes", kind: LIST_ROW_KIND, category: "control",
    element: {
      storage: "tuple",
      fields: [
        { name: "note", kind: "number", step: 1, label: "Note", help: "A MIDI note number this keyboard is holding down. 60 is middle C and every 12 is an octave. Bind it to an equation to make a latched chord move with the deck." },
      ],
    },
    order: "sequence",
    activeKey: "heldNotesActive",
    help: "The notes this keyboard is HOLDING — the latched chord, one entry per key. Only meaningful while Lock Keys is on: with the lock on, clicking a key adds it here and clicking it again removes it, so each slide can hold its own chord. Hiding an entry silences that note without losing which one it was.",
  },

  // ── piano roll: THE PATTERN (a LIST property — core/lists.js) ────────────────
  // R7-14. The notes a Piano Roll plays: a SPARSE list of (step, note) pairs, one
  // entry per authored note and nothing at all for a rest.
  //
  // SPARSE, NOT ONE ENTRY PER STEP, and the reason is the pattern's LENGTH. A dense
  // list would state the length as its own length, which is tidy — and then a bar
  // ending in four rests would be indistinguishable from a bar four steps shorter,
  // because a trailing rest has no element to be. The length is therefore its own
  // property (`audioStepCount`, the engine's construct-time step count, which the
  // shared transport already reads) and this list says only what SOUNDS.
  //
  // A TUPLE of two numbers, for the reason `points` and `frames` are tuples:
  // core/interpolators.js interpolate() takes its pure-numeric-array branch for an
  // all-number array.
  //
  // CORRECTION (2026-08-08, measured): this used to say "the tweenline INT RULE
  // rounds a lerp between two of them". IT DOES NOT on this branch —
  // interpolators.js:146 is explicit ("NO int-rounding"), and the int rule lives on
  // the SCALAR path. A keyframed pattern therefore does NOT walk the grid cell by
  // cell mid-tween; it slides continuously and `patternNotes` ROUNDS on read, which
  // is where the cell-by-cell behaviour actually comes from.
  //
  // HIDE MEANS "THIS NOTE DOES NOT SOUND", not "close the sequence over it". That is
  // the per-flavour reading core/lists.js's own header asks each consumer to state:
  // an element carries its own step, so removing one from the picture leaves every
  // other note exactly where it was, and the gap it leaves is a rest.
  notes: {
    label: "Notes", kind: LIST_ROW_KIND, category: "control",
    element: {
      storage: "tuple",
      fields: [
        { name: "step", kind: "number", min: 0, step: 1, label: "Step", help: "Which step of the pattern this note plays on, counting from 0. A note past the last step is kept but does not sound — raise Steps to reach it." },
        { name: "note", kind: "number", step: 1, label: "Note", help: "The MIDI note this step plays. 60 is middle C and every 12 is an octave. Bind it to an equation to transpose a phrase without redrawing it." },
      ],
    },
    order: "sequence",
    activeKey: "notesActive",
    help: "The pattern, as one entry per note: WHICH step and WHICH pitch. Click a cell on the widget to place a note, click it again to clear it. Hiding an entry turns that step into a rest without losing the note. One note per step — the sequencer sounds a single pitch at a time, so placing a note on an occupied step MOVES it.",
  },

  // ── midi clip: THE CLIP (a LIST property — core/lists.js) ───────────────────
  // The note stream a `midi` wire carries, and the model the embedded `signal`
  // editor imports into. `core/midi_clip.js` is what READS it; this is the
  // declaration.
  //
  // ── WHY IT IS A LIST PROPERTY AND NOT A NEW KIND OF THING ───────────────────
  // CLAUDE.md's four-kinds-of-state law leaves exactly one place to put a clip. The
  // hardware reading of MIDI — bytes arriving from a device as a hand plays — is
  // EPHEMERAL state, which this project has none of, so a deck containing one could
  // not be exported or re-rendered identically. The AUTHORED clip is ordinary
  // property state, and being a LIST is what buys it everything for free:
  // per-element equations (`= clip.3.pitch` is a slot), insert-between, hide-vs-purge,
  // an Inspector control, a keyframe per leaf, and a delta that folds.
  //
  // FOUR FIELDS, AND THE ORDER IS THE TIMELINE'S: start, duration, pitch, velocity.
  // `start` leads because it is what a reader scans for and what every consumer
  // sorts by.
  //
  // A TUPLE, for the reason `points`, `frames` and `notes` are tuples:
  // core/interpolators.js interpolate() sends an all-numeric array down its
  // pure-numeric-array branch, which is a PLAIN LERP. **AND IT DOES NOT ROUND** —
  // interpolators.js:146 says so ("NO int-rounding"); the int rule is on the SCALAR
  // path. The `heldNotes` and `notes` comments above claim the opposite and are
  // WRONG about it (harmlessly, since both consumers round on read). So a clip
  // TWEENS CONTINUOUSLY and `core/midi_clip.noteRecord` rounds pitch and velocity
  // ITSELF, where the rounding can be seen. START AND DURATION ARE NOT ROUNDED,
  // deliberately: they are BEATS, and an eighth note is 0.5 of one.
  //
  // "sequence", NOT "sorted by start", and this is the trap worth naming. A sorted
  // list CANONICALIZES ON EVERY WRITE (core/lists.js), so dragging a note left past
  // its neighbour would RENUMBER both — mid-gesture, while the pointer holds index
  // 3 — and every equation bound to a later note would come to mean a different
  // note. Nothing reads the stored order, so leaving it alone costs nothing;
  // `clipNotes` sorts a COPY on read.
  //
  // No minLength: an empty clip is the resting state of a fresh widget, not a
  // malformed list. And the element may GROW a fifth field (channel, bend) with no
  // migration — core/lists.js appends it at index 4, where every stored 4-tuple
  // already reads `undefined` and `noteRecord` already defaults.
  // ── THE VISUAL NODE'S PORT LISTS (core/visual_node.js) ───────────────────────
  // Two SEQUENCE lists of RECORDS: element i of `inPorts` is the input port `in<i>`,
  // element i of `outPorts` the output `out<i>`. A sequence, because the order IS
  // the column the beads are drawn in; a record, because the fields are a string, a
  // colour and (inputs only) a boolean — nothing here is the numeric tuple the
  // tweenline int rule was designed around. HIDE keeps a port's number (and its
  // wires); PURGE renumbers later ports exactly as it renumbers a polygon's
  // corners, and the header of core/visual_node.js states that trade.
  //
  // `multiple` is the per-INPUT "accept several wires" permission (user,
  // 2026-08-21: "that should probably be a Boolean … by default turned off"). It
  // is declared on the element so it keyframes and unifies like any other field;
  // the protocol it switches on is core/nodeflow.js's `multiple` port flag.
  // No `default` here — the plugin seeds one port a side.
  inPorts: {
    label: "Inputs", kind: LIST_ROW_KIND, category: "ports",
    element: {
      storage: "record",
      fields: [
        { name: "label", kind: "text", label: "Label", help: "The name drawn beside this input's bead. Leave it blank for the jack alone — a bare socket still says where a wire comes in." },
        { name: "color", kind: "color", label: "Colour", help: "The bead's colour, and the colour of every wire drawn into it. A visual port carries no value, so its colour means whatever you say it means." },
        { name: "multiple", kind: "boolean", label: "Accept several", help: "Let this one input take wires from SEVERAL outputs at once, in no particular order. Off, it holds one wire and a new drop replaces it." },
      ],
    },
    order: "sequence",
    activeKey: "inPortsActive",
    help: "The node's inputs, top to bottom. Insert to add a socket; hide one to take it off the card without renumbering the others (its wires come back when it does); purge to remove it for good.",
  },
  outPorts: {
    label: "Outputs", kind: LIST_ROW_KIND, category: "ports",
    element: {
      storage: "record",
      fields: [
        { name: "label", kind: "text", label: "Label", help: "The name drawn beside this output's bead. Leave it blank for the jack alone." },
        { name: "color", kind: "color", label: "Colour", help: "The bead's colour, and the colour of every wire drawn out of it." },
      ],
    },
    order: "sequence",
    activeKey: "outPortsActive",
    help: "The node's outputs, top to bottom. Insert to add a socket; hide one to take it off the card without renumbering the others; purge to remove it for good.",
  },

  clip: {
    label: "Clip", kind: LIST_ROW_KIND, category: "control",
    element: {
      storage: "tuple",
      fields: [
        { name: "start", kind: "number", min: 0, label: "Start", help: "When this note begins, in BEATS from the clip's start. A beat is a quarter note, so 0.5 is an eighth note in. Bind it to an equation to make a phrase move with the deck." },
        { name: "duration", kind: "number", min: 0, label: "Length", help: "How long this note lasts, in BEATS. 1 is a quarter note, 0.5 an eighth, 4 a whole note in 4/4." },
        { name: "pitch", kind: "number", min: 0, max: 127, step: 1, label: "Pitch", help: "The MIDI note number. 60 is middle C and every 12 is an octave. Bind it to an equation to transpose a phrase without redrawing it." },
        { name: "velocity", kind: "number", min: 1, max: 127, step: 1, label: "Velocity", help: "How hard the note is struck, 1 to 127. 100 is the default a freshly drawn note gets; what it changes is up to the instrument it is wired to." },
      ],
    },
    order: "sequence",
    activeKey: "clipActive",
    help: "The notes this clip holds, one entry per note: WHEN it starts, HOW LONG it lasts, WHICH pitch and HOW HARD. Double-click the widget to edit it in signal, the full MIDI sequencer. Hiding an entry silences that note without losing it or renumbering the ones after it.",
  },

  // ── midi clip: THE CONTROL LANE (a LIST property — core/lists.js) ───────────
  // Pitch bend and CC automation, beside `clip` and read by
  // `core/midi_clip.clipControls`. THE OTHER HALF OF THE MIDI VOCABULARY:
  // `MIDI_EVENT_RANK` has declared `cc` and `pitchBend` since the type was
  // written and the Surge worklet has implemented both for longer than that —
  // what was missing was a PRODUCER, and the embedded `signal` editor is one,
  // because it has full automation lanes. A converter that read its notes and
  // dropped its bends would silently discard authored work.
  //
  // THREE FIELDS: start, controller, value. `controller` is -1 for a pitch bend
  // or a CC NUMBER 0..127; a negative can never be a CC by the protocol, so the
  // sentinel cannot collide. ONE list rather than two keeps the element an
  // all-numeric tuple (the plain-lerp branch, exactly as `clip`) and keeps "what
  // automation happens at beat 3" one thing to look at.
  //
  // VALUES ARE RAW MIDI, NOT NORMALIZED — 0..127 for a CC, 0..16383 for a bend
  // with 8192 as centre. Both ends of the pipe already speak those units (signal
  // stores them; the worklet takes them), so a normalized middle would be two
  // conversions and two roundings buying nothing. core/midi_clip.js states the
  // full argument.
  ctrl: {
    label: "Automation", kind: LIST_ROW_KIND, category: "control",
    element: {
      storage: "tuple",
      fields: [
        { name: "start", kind: "number", min: 0, label: "Start", help: "When this automation point takes effect, in BEATS from the clip's start. A beat is a quarter note." },
        { name: "controller", kind: "number", min: -1, max: 127, step: 1, label: "Controller", help: "WHICH controller this point moves. -1 is PITCH BEND. 0 to 127 is a MIDI CC number — 1 is the mod wheel, 7 volume, 11 expression, 74 the filter cutoff most synths map. What a CC actually does is up to the instrument this clip is wired to." },
        { name: "value", kind: "number", min: 0, max: 16383, step: 1, label: "Value", help: "The value to send, in the controller's OWN MIDI range: 0 to 127 for a CC, and 0 to 16383 for a pitch bend where 8192 is dead centre (no bend). Out-of-range values are clamped to the range the controller actually has." },
      ],
    },
    order: "sequence",
    activeKey: "ctrlActive",
    help: "Pitch-bend and CC automation for this clip, one entry per point. Sent at its beat, and — when it lands on the same beat as a note — sent BEFORE that note, so the note is heard under the controller state written for it. Hiding an entry drops that point without losing it or renumbering the ones after it.",
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
  checkCodeRow(`PROPS."${key}"`, def);
  checkNullableRow(`PROPS."${key}"`, def);
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
 * `transform` — the nine bbox transform rows every bbox widget shares.
 * `strokedBox` — the four-property box style (fill/stroke/strokeWidth/
 *   cornerRadius) + its render decoration (render_gpu/decorate.js). This is
 *   THE bundle the user meant by "make the stroke composition inherit... I'd
 *   like everything to inherit them at once, including images and videos".
 * `media` — the shared media chrome: a `src` string row + `opacity`. Media
 *   widgets compose transform + media + (the border half of) strokedBox.
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

/** THE STROKE-JOIN keys, single-sourced for the same reason the two lists above
 *  are. Order = Inspector row order: the corner treatment, then the one knob that
 *  modifies it. They travel as a PAIR and they travel WITH STROKE_TRIM_KEYS —
 *  every widget that splices the trim rows standalone splices these too, which
 *  tests/stroke_join_keys_test.js turns from a convention into a gate. */
export const STROKE_JOIN_KEYS = ["strokeJoin", "strokeMiter"];

/**
 * THE SCREEN-SPACE-WIDTH key, single-sourced for the reason the three lists above
 * are — and it is the one that PROVED the reason, by being the only universal
 * stroke option written as a bare literal in the two bundles instead of a shared
 * name.
 *
 * The cost of that asymmetry was the whole feature on five widgets. The bundle
 * composers (rect, the media family, …) got the row; the hand-splicing widgets —
 * circle, shape, polygon, paint_path — splice `...STROKE_TRIM_KEYS,
 * ...STROKE_JOIN_KEYS` and so inherited every universal stroke option EXCEPT this
 * one, because it was not in a list to splice. They never showed the checkbox at
 * all, which is the quieter half of the user's "does jack shit" report: on the
 * bundle widgets the knob was visible and inert, and on these it was missing.
 *
 * `line` is DELIBERATELY NOT a subject: its round-cap branch emits `polyline` and
 * its flat-cap branch emits a FILLED path whose cap geometry is baked at world
 * width, so there is no stroke width for a divisor to scale. See
 * tests/screen_space_test.js, which asserts that exclusion rather than leaving it
 * to be re-litigated.
 */
export const STROKE_SPACE_KEYS = ["strokeScreenSpace"];

export const BUNDLES = {
  transform: ["x", "y", "cx", "cy", "w", "h", "rotation", "rotationAnchor.x", "rotationAnchor.y", "z"],
  // The endpoint-pair transform every arrow-family widget shares (from/to
  // coordinates + z). Distinct from `transform` — arrows have no bbox/rotation
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
  strokedBorder: ["stroke", "strokeWidth", ...STROKE_OFFSET_KEYS, ...STROKE_SPACE_KEYS, "cornerRadius", ...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS],
  // The full filled-and-stroked box: fill + the border slice (trim keys included).
  strokedBox: ["fill", "stroke", "strokeWidth", ...STROKE_OFFSET_KEYS, ...STROKE_SPACE_KEYS, "cornerRadius", ...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS],
  // EDGE-CROP INSETS (manifest "Edge-crop insets"): the four per-edge source
  // trims. Media widgets (image/video) compose this; groups will too (their
  // subtree-crop consumption is a follow-up — the bundle is defined once here).
  cropInsets: ["cropTop", "cropLeft", "cropRight", "cropBottom"],
  // THE EFFECTS BUNDLE (manifest Round 12D): drop shadow + bloom + blend mode +
  // inner shadow + soft edges + blur, composed by every DRAWN widget (render half:
  // render_gpu/effects.js — exclusions justified in its header). Defaults are
  // effect-OFF; use bundleNestedDefaults("effects") in plugin defaults (the
  // shadow/inner-shadow keys are nested, blendMode/softEdges/gaussianBlur are plain
  // scalars). ADDING A KEY HERE IS NOT A LOCAL EDIT — render_gpu/effects.js
  // EFFECT_STATE_KEYS must gain the matching top-level key (core/registry.js
  // cross-checks the two at import), the render halves must implement it
  // (ir.js effectSubtree, skia/paint_skia.js), pdf_backend.js must CLASSIFY it
  // vector-safe or raster-only (its own import-time guard), and every effects
  // PRESET FAMILY must carry the new key's identity (see plugins/group.js's FULL
  // note — an overlay that omits a knob leaves the previously hovered row's value).
  effects: ["shadow.dx", "shadow.dy", "shadow.blur", "shadow.color", "shadow.opacity", "bloom.radius", "bloom.strength", "blendMode", "innerShadow.dx", "innerShadow.dy", "innerShadow.blur", "innerShadow.color", "innerShadow.opacity", "softEdges", "gaussianBlur"],
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
  rendering: ["antialias", "retina"],
  // THE DITHER bundle (user, 2026-08-08: "bundled up into a dithering options
  // property bundle - since other things might use dither soon too"). Order = row
  // order, and it is the order the picture is built in: what depth to quantise TO,
  // then whether/how to distribute the error, then that mode's own knob, then how
  // hard. Composed today by web/PaintField.svelte for a gradient fill/stroke; any
  // future non-gradient consumer spreads `bundle("dither")` +
  // `bundleDefaults("dither")` and gets identical rows, help and visibility.
  dither: ["bitDepth", "ditherMode", "ditherBayerSize", "ditherEmphasis"],
};

/* ═══ COMPOUND ROWS (WORKSTREAM COMPOUND_, backburner CY) ═══════════════════
 *
 * ── WHAT THE USER ASKED FOR (verbatim) ────────────────────────────────────
 * "For some properties, we should be able to have dropdowns. We already do this
 * for things like gradients btw. For like colors etc, we can have triangles that
 * indicate dropdown next to the property name, which push the property name to
 * the right a little (they're always visible those arrows) and so colors can be
 * dropped down into R,G,B and then the color would actually be a compount
 * keyframe (you know how sections can be none, some or all for keyframes? Same
 * for these properties that have subproperties. We might even have
 * sub-subproperties so leave the architecture clean to implement that in the
 * future. For now, XY and HW are 2-vectors, RGB is a 3-vecrtor, and XY can be
 * controlled similar to rot in that if not dropped down we might have a drag pad
 * where we click and drag that pad to move the x and y values which are like
 * > [X] [Y] [dragpad] unless dropped down then it would be like  v [DragPad] \n
 * [X] [Y]"
 *
 * ── WHAT A COMPOUND ROW *IS*, AND WHAT IT DELIBERATELY IS NOT ─────────────
 * A compound is PURE GROUPING OVER EXISTING LEAF ROWS. `x` and `y` are already
 * separate delta leaves with their own keyframes, their own equations and their
 * own undo units; a compound adds a PARENT ROW that renders a disclosure
 * triangle, an aggregate keyframe diamond and (optionally) a joint editor —
 * and NOTHING about storage changes. There is no `xy` key in any document, no
 * migration, and a document written before compounds exist is byte-identical to
 * one written after. That is the whole reason XY and WH could ship first: they
 * are the compounds whose leaves the document ALREADY has.
 *
 * A compound is therefore NOT a way to make a scalar leaf into a vector. `color`
 * is ONE hex string today, so an honest RGB compound needs real `color.r/g/b`
 * delta leaves and a loud repair migration — a separate, larger piece of work.
 * It is NOT declared here, because declaring it would render a tri-state diamond
 * over three paths the document cannot hold: a control that lies about what it
 * keyframes. (See the workstream report; the plan is written down, not faked.)
 *
 * ── ARBITRARY DEPTH IS THE DECLARATION'S SHAPE, NOT A FUTURE REFACTOR ─────
 * The user asked for sub-subproperties, so a child is spelled the same way a
 * parent is: `{key, label, children: [...]}` where a child is EITHER a leaf key
 * (a string) or another compound node. `compoundLeafKeys` recurses, and
 * `Inspector.svelte` renders the tree recursively through the same snippet, so
 * a three-level compound needs no new code — only a declaration. Nothing in
 * this file or in the Inspector counts levels.
 *
 * ── THE TRI-STATE IS THE SECTION GRAMMAR, REUSED VERBATIM ─────────────────
 * The user's own reference is sections ("you know how sections can be none, some
 * or all for keyframes? Same for these"). So a compound's diamond is
 * core/section_keyframes.js's bubble over a DIFFERENT path set: a section reads
 * every row in a category, a compound reads every LEAF UNDER THIS NODE (at any
 * depth). Same `sectionTriState`, same HALF→ALL ruling, same one-undo-unit
 * toggle, same ‹ › union jump — reused rather than restated, which is why a
 * compound diamond and a section diamond cannot ever disagree about what "some"
 * means. web/Inspector.svelte mounts the very same SectionKeyframeControls
 * component; only the paths and the title differ.
 */

/**
 * THE COMPOUND DECLARATIONS. Keyed by the compound's own id (unique among row
 * keys — a compound row occupies a row slot, and core/multiselect.js treats a
 * repeated key as a plugin defect).
 *
 * `leafFor` names the plugin-declared LEAF ROW each child maps to, so the
 * compound reuses that row's label, help, bounds and control verbatim instead of
 * restating them (the copy-paste drift this whole registry exists to kill).
 * `editor` names the JOINT control the parent row shows when the compound is
 * COLLAPSED (and, for a pad, larger when expanded); absent = no joint editor,
 * the parent row is triangle + label + diamond alone.
 */
export const COMPOUNDS = {
  // POSITION — the user's worked example. Collapsed: `▸ [X] [Y] [pad]`.
  // Expanded: `▾ [big pad]` with the X and Y rows beneath it.
  xy: {
    label: "Position",
    editor: "pad2d",
    category: "transform",
    help: "The widget's top-left corner as one X/Y pair. Drag the pad to move both at once; the triangle opens X and Y as their own rows. The diamond keyframes BOTH — hollow when neither is keyed here, half when one is, filled when both are.",
    children: ["x", "y"],
  },
  // SIZE — the same grouping over w/h, and the row the ASPECT CHAIN LOCK
  // (backburner AF) hangs on: a chain is a statement about the RATIO of two
  // leaves, so it belongs on the row that owns both of them and nowhere else.
  wh: {
    label: "Size",
    editor: "pad2d",
    category: "transform",
    aspectLock: true,
    help: "The widget's width and height as one pair. Drag the pad to resize both at once; the chain link ties them to their current ratio, so editing either writes the other. The diamond keyframes BOTH.",
    children: ["w", "h"],
  },
};

/**
 * THE PER-ITEM ASPECT-LOCK LEAF (backburner AF). An ordinary boolean stored
 * property, absent = OFF, so every existing document is byte-identical and a
 * deck written before the chain existed loads with no repair.
 *
 * WHY A STORED LEAF AND NOT A PANEL-LOCAL TOGGLE: the lock changes what a RESIZE
 * GESTURE does (web/canvas/dragKinds.js), not merely what the Inspector writes.
 * A viewer-local toggle would make the same drag produce different geometry on
 * two machines, and would be lost the moment the panel unmounted — while the
 * author's intent ("this logo is 16:9 and must stay that way") is a fact about
 * the ITEM. It is deliberately NOT keyframeable: a ratio constraint that tweened
 * on and off mid-transition would silently rewrite w/h keyframes the author set
 * by hand, which is the quiet wrongness this codebase forbids.
 */
export const ASPECT_LOCK_KEY = "aspectLocked";

/**
 * Pure function. Every LEAF key under a compound node, at ANY depth, in
 * declaration order. THE recursion — no caller counts levels.
 *
 * A child is a leaf when it is a string; an object child is a nested compound
 * and is descended into. A node with no children yields `[]` rather than
 * throwing, so a declaration under construction degrades to "a compound that
 * keyframes nothing" and the Inspector's own `sectionBubbleApplies` then
 * declines to render a dead diamond.
 *
 * Args:
 *   node (object): a COMPOUNDS entry (or a nested child node)
 *
 * Returns:
 *   string[]: leaf property keys
 *
 * Examples:
 *     >>> compoundLeafKeys(COMPOUNDS.xy)
 *     ['x', 'y']
 *     >>> compoundLeafKeys({children: ["w", "h"]})
 *     ['w', 'h']
 *     >>> // ARBITRARY DEPTH: a hypothetical transform compound of two compounds
 *     >>> compoundLeafKeys({children: [{key: "xy", children: ["x", "y"]},
 *     ...                              {key: "wh", children: ["w", "h"]}, "rotation"]})
 *     ['x', 'y', 'w', 'h', 'rotation']
 *     >>> compoundLeafKeys({children: []})
 *     []
 */
export function compoundLeafKeys(node) {
  const out = [];
  for (const child of node.children ?? []) {
    if (typeof child === "string") out.push(child);
    else out.push(...compoundLeafKeys(child));
  }
  return out;
}

/**
 * Pure function. Resolves a compound DECLARATION against the rows a widget
 * actually declares, yielding the render tree the Inspector walks — or `null`
 * when the widget does not declare ALL of the compound's leaves.
 *
 * ALL, NOT SOME, AND THAT IS THE LOAD-BEARING RULE. A compound whose leaves are
 * partly present would render a "Position" row that moves X and silently drops
 * Y, and its diamond would report "all keyframed" while keying one leaf. A
 * widget that declares only some leaves keeps its plain rows, unchanged — which
 * is also what makes this safe to apply to EVERY plugin at once without auditing
 * them: an arrow (from.x/to.x, no `x`) simply gets no Position compound.
 *
 * The resolved node carries the compound's own aspects plus `rows` — the
 * widget's REAL row objects, in the compound's declared order — so the Inspector
 * renders a child through the same propRow it would have rendered standalone.
 *
 * Args:
 *   node (object): a COMPOUNDS entry (or nested child node)
 *   rowsByKey (Map<string, object>): the widget's declared rows, by key
 *   key (string): this node's id (the COMPOUNDS key, or a nested child's `key`)
 *
 * Returns:
 *   object|null: {key, label, compound: true, children: [...], ...aspects}
 *
 * Examples:
 *     >>> const byKey = new Map([["x", {key: "x", label: "X"}], ["y", {key: "y", label: "Y"}]])
 *     >>> resolveCompound(COMPOUNDS.xy, byKey, "xy").children.map((c) => c.key)
 *     ['x', 'y']
 *     >>> // a widget missing a leaf gets NO compound (its plain rows stand)
 *     >>> resolveCompound(COMPOUNDS.xy, new Map([["x", {key: "x"}]]), "xy")
 *     null
 */
export function resolveCompound(node, rowsByKey, key) {
  const children = [];
  for (const child of node.children ?? []) {
    if (typeof child === "string") {
      const leaf = rowsByKey.get(child);
      if (!leaf) return null;
      children.push(leaf);
    } else {
      const nested = resolveCompound(child, rowsByKey, child.key);
      if (!nested) return null;
      children.push(nested);
    }
  }
  const { children: _decl, ...aspects } = node;
  return { key, compound: true, ...aspects, children };
}

/**
 * Pure function. Rewrites a widget's row array so that every compound whose
 * leaves are ALL present becomes ONE compound row, mounted at the position of
 * its FIRST leaf, with the remaining leaves removed from the top level.
 *
 * MOUNTED AT THE FIRST LEAF, so a category's reading order is preserved: the
 * transform bundle lists x, y, cx, cy, w, h, … and the Position compound takes
 * x's slot, leaving cx/cy exactly where the author expects them. Appending
 * compounds instead would have shuffled Transform's order for every widget in
 * the app to satisfy an implementation detail.
 *
 * IT IS A PURE REWRITE OF ROWS, so nothing downstream needs to know compounds
 * exist unless it renders them: `groupRows`, the multi-selection intersection
 * and the section bubble all keep taking row arrays.
 *
 * Args:
 *   rows (object[]): a widget's resolved inspector rows
 *   compounds (object): a COMPOUNDS-shaped table (defaults to COMPOUNDS)
 *
 * Returns:
 *   object[]: rows with compounds folded in
 *
 * Examples:
 *     >>> const rows = [{key: "x"}, {key: "y"}, {key: "z"}]
 *     >>> withCompoundRows(rows).map((r) => r.key)
 *     ['xy', 'z']
 *     >>> // the compound sits where its FIRST leaf was, not at the end:
 *     >>> withCompoundRows([{key: "z"}, {key: "x"}, {key: "y"}]).map((r) => r.key)
 *     ['z', 'xy']
 *     >>> // an incomplete set is left completely alone
 *     >>> withCompoundRows([{key: "x"}, {key: "z"}]).map((r) => r.key)
 *     ['x', 'z']
 */
export function withCompoundRows(rows, compounds = COMPOUNDS) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  /** Which compound (if any) each leaf key belongs to, and each compound's node. */
  const mountAt = new Map(); // leafKey -> compound row (only the FIRST leaf)
  const absorbed = new Set(); // every leaf key the compound now owns
  for (const [key, node] of Object.entries(compounds)) {
    const resolved = resolveCompound(node, byKey, key);
    if (!resolved) continue;
    const leaves = compoundLeafKeys(node);
    // A leaf already absorbed by an earlier compound must not be claimed twice —
    // two compounds sharing a leaf would render it under both and keyframe it
    // twice from one click. First declaration wins, loudly ordered by COMPOUNDS.
    if (leaves.some((k) => absorbed.has(k))) continue;
    mountAt.set(leaves[0], resolved);
    for (const k of leaves) absorbed.add(k);
  }
  const out = [];
  for (const r of rows) {
    if (mountAt.has(r.key)) out.push(mountAt.get(r.key));
    else if (!absorbed.has(r.key)) out.push(r);
  }
  return out;
}

// ── COLOUR CHANNEL CHILDREN (R7-36's UI grammar over R7-38's addresses) ──────
//
// A colour row gets a disclosure triangle and R/G/B/A children, exactly as the
// Position row gets X and Y. The two are the SAME compound machinery over
// different storage: `COMPOUNDS.xy` groups leaf rows that already exist, and a
// colour has no leaf rows at all — its components are an ADDRESS over one stored
// value (core/vector_values.js's "the vector is the storage, the components are
// the view"). So the children have to be GENERATED, and this is the generator.
//
// IT IS ONE FUNCTION, NOT 32 HAND-WRITTEN ROWS (R7-38c forbids arity and name
// hardcoding). The channels come from `VECTOR_KINDS.color.axes`, so a kind that
// gains, loses or renames a component follows with NO edit here and no edit in
// the Inspector — pinned by planting a fake 5-channel kind in the tests and
// asserting five rows appear. There is no "r" in this file.

/**
 * Pure function. Is this row a COLOUR-BEARING row — one whose value has an
 * addressable `.color`, and which therefore earns channel children?
 *
 * BOTH PAINT AND PLAIN COLOUR ROWS QUALIFY, because both address the same way at
 * the value layer: `fill.color.r` on a paint, `shadow.color.r` on a plain colour
 * (core/expressions.js readVectorAddress takes `<anything>.color[.axis]` and maps
 * the paint through paintColorPath, which answers the EMPTY path for a bare
 * string — so the two collapse to one rule rather than two).
 *
 * @example colorRowIsChannelBearing({key: "fill", kind: "color", paint: true}) // true
 * @example colorRowIsChannelBearing({key: "shadow.color", kind: "color"}) // true
 * @example colorRowIsChannelBearing({key: "x", kind: "number"}) // false
 */
export function colorRowIsChannelBearing(row) {
  return rowKindOf(row) === "color";
}

/**
 * Pure function. A row's kind through the retired-spelling map — THE resolver, and
 * the only place `RETIRED_ROW_KINDS` is consulted to classify a row.
 *
 * ONE DECLARATION, THREE CONSUMERS. This body existed verbatim in three files
 * (here, `core/retype.js`'s `canonicalRowKind`, and `web/Inspector.svelte`'s
 * `rowKind`), which is precisely the shape that lets a retired spelling be honoured
 * in two of them and missed in the third. The alias table already lived in ONE place
 * so that deleting an entry stops that spelling working everywhere; three copies of
 * the READ put that guarantee back at risk from the other side.
 *
 * NULL-SAFE, and that is the contract the copies did NOT share: two of them indexed
 * `row.kind` unguarded and threw on a null row, while this one answered `undefined`.
 * The safe behaviour is the one kept — a caller asking the kind of nothing is asking
 * a question with an answer ("no kind"), and every call site here reaches it through
 * a `=== "color"`-style comparison that a thrown TypeError would only turn into a
 * crash further from the cause.
 *
 * @param {object} row - an inspector row ({key, kind, ...}), or null/undefined
 * @returns {string|undefined} the canonical kind
 *
 * @example rowKindOf({kind: "color"}) // "color"
 * @example rowKindOf({kind: "checkbox"}) // "boolean" (retired V1 spelling)
 * @example rowKindOf({kind: "number"}) // "number"
 * @example rowKindOf(null) // undefined (a null row has no kind — it does not throw)
 */
export function rowKindOf(row) {
  return RETIRED_ROW_KINDS[row?.kind] ?? row?.kind;
}

/**
 * Pure function. The CHANNEL CHILD ROWS for one colour row — one per component
 * of the `color` vector kind, in the declaration table's own order.
 *
 * ── THE KEY IS THE REAL DOTTED WRITE PATH ───────────────────────────────────
 * A child's `key` is `<row.key>.color.<axis>`, which is precisely the delta path
 * `core/deltas.js`'s colour-component seam resolves and precisely the address an
 * equation types. So a channel row keyframes, tweens, copies its path and binds
 * an equation by BEING an ordinary row — the property the compound machinery
 * already buys, extended to a value that has no leaves.
 *
 * A PLAIN COLOUR ROW WHOSE KEY ALREADY ENDS IN `color` DOES NOT REPEAT IT:
 * `shadow.color` yields `shadow.color.r`, not `shadow.color.color.r`. The address
 * grammar is "<the thing holding a colour>.color.<axis>", and for that row the
 * thing holding the colour is `shadow`.
 *
 * ── THE UNITS ARE THE ADDRESS'S UNITS, NOT A UI CHOICE ──────────────────────
 * R/G/B are 0..255 bytes and alpha is a 0..1 fraction — `COLOR_CHANNEL_MAX` and
 * `colorChannelValue`'s rule, restated as row bounds so the scrubber cannot
 * disagree with what an equation reading the same address gets. The alpha row is
 * identified by ASKING the vector layer (`colorAlphaAxis`), never by comparing
 * against the literal "a".
 *
 * Args:
 *   row (object): a colour-bearing row
 *
 * Returns:
 *   object[]: the channel rows, or [] when `row` is not colour-bearing
 *
 * Examples:
 *     >>> colorChannelRows({key: "fill", label: "Fill", kind: "color", paint: true, category: "fillMaterial"}).map((r) => r.key)
 *     ['fill.color.r', 'fill.color.g', 'fill.color.b', 'fill.color.a']
 *     >>> // a plain colour row already ending in `color` does not say it twice:
 *     >>> colorChannelRows({key: "shadow.color", label: "Shadow color", kind: "color"}).map((r) => r.key)
 *     ['shadow.color.r', 'shadow.color.g', 'shadow.color.b', 'shadow.color.a']
 *     >>> colorChannelRows({key: "fill", label: "Fill", kind: "color"})[0].label
 *     'R'
 *     >>> // RGB are BYTES; alpha is a FRACTION — the address's own units:
 *     >>> colorChannelRows({key: "fill", label: "Fill", kind: "color"})[0].max
 *     255
 *     >>> colorChannelRows({key: "fill", label: "Fill", kind: "color"})[3].max
 *     1
 *     >>> colorChannelRows({key: "x", kind: "number"})
 *     []
 */
export function colorChannelRows(row) {
  if (!colorRowIsChannelBearing(row)) return [];
  const base = row.key.split(".").at(-1) === COLOR_VECTOR_ADDRESS
    ? row.key
    : `${row.key}.${COLOR_VECTOR_ADDRESS}`;
  const alpha = colorAlphaAxis();
  return VECTOR_KINDS[COLOR_VECTOR_ADDRESS].axes.map((axis) => {
    const isAlpha = axis === alpha;
    return {
      key: `${base}.${axis}`,
      label: axis.toUpperCase(),
      kind: "number",
      category: row.category,
      min: 0,
      max: isAlpha ? 1 : COLOR_CHANNEL_MAX,
      // The scrub coefficient follows the units, so one dragged pixel means a
      // comparable amount of colour on every channel rather than 255x more on
      // three of them than on the fourth.
      scrub: isAlpha ? UNIT_SPAN_SCRUB : 1,
      channelOf: row.key,
      help: isAlpha
        ? `The alpha of ${row.label}'s own colour, 0..1 — a property of THIS paint, separate from the widget's Opacity row (which multiplies every paint at once). Keyframe it alone to fade one slot.`
        : `The ${axis.toUpperCase()} channel of ${row.label}'s colour, 0..255. Keyframing it alone animates ${axis.toUpperCase()} and leaves the other channels wherever the base colour puts them.`,
    };
  });
}

/**
 * Pure function. The COMPOUND NODE a colour row becomes once it has channel
 * children — the parent keeps its own control (the picker edits the whole
 * colour) and gains a disclosure triangle plus the tri-state diamond.
 *
 * `editor: "self"` is what tells the Inspector to render THE ROW'S OWN control in
 * the parent's value cell, rather than the `pad2d` a transform compound shows.
 * That is the R7-36 requirement stated exactly: whole-colour editing stays the
 * parent row's job, and the children are the per-channel addresses.
 *
 * RETURNS null WHEN THE ROW HAS NO ADDRESSABLE COLOUR, which is how the
 * "disclosure is ABSENT, not disabled-and-lying" rule is enforced: the caller
 * gets the plain row back and there is no triangle to click. Whether a given
 * PAINT has one is a question about its stored VALUE, not about its row, so it is
 * answered per-item at render time (`paintColorPath`) rather than here.
 *
 * Args:
 *   row (object): a colour-bearing row
 *
 * Returns:
 *   object|null: the compound node, or null for a non-colour row
 *
 * Examples:
 *     >>> colorCompoundRow({key: "fill", label: "Fill", kind: "color", paint: true}).compound
 *     true
 *     >>> colorCompoundRow({key: "fill", label: "Fill", kind: "color"}).children.map((c) => c.label)
 *     ['R', 'G', 'B', 'A']
 *     >>> // the PARENT keeps its own control — the picker still edits the whole colour:
 *     >>> colorCompoundRow({key: "fill", label: "Fill", kind: "color"}).editor
 *     'self'
 *     >>> colorCompoundRow({key: "x", kind: "number"})
 *     null
 */
export function colorCompoundRow(row) {
  const children = colorChannelRows(row);
  if (children.length === 0) return null;
  return { ...row, compound: true, editor: "self", channelParent: true, children };
}

/**
 * Pure function. A row list with every colour row expanded into its channel
 * compound — the one seam a panel calls, mirroring `withCompoundRows`.
 *
 * SEPARATE FROM `withCompoundRows` BECAUSE THE TWO ANSWER DIFFERENT QUESTIONS.
 * That one folds SEVERAL declared rows into one (grouping); this one gives ONE
 * declared row children it did not have (generation). Composing them in the
 * caller keeps each honest about what it does, and means a colour row nested
 * inside a future transform compound would still get its channels.
 *
 * Args:
 *   rows (object[]): a widget's resolved inspector rows
 *
 * Returns:
 *   object[]: the same rows, colour ones replaced by their compound node
 *
 * Examples:
 *     >>> withColorChannelRows([{key: "x", kind: "number"}, {key: "fill", label: "Fill", kind: "color"}]).map((r) => r.compound === true)
 *     [false, true]
 *     >>> // ORDER AND COUNT ARE PRESERVED — this never adds or moves a row:
 *     >>> withColorChannelRows([{key: "a", kind: "number"}, {key: "b", kind: "number"}]).length
 *     2
 */
export function withColorChannelRows(rows) {
  return rows.map((r) => colorCompoundRow(r) ?? r);
}

/**
 * Pure function. The width and height a locked ASPECT RATIO implies when ONE of
 * the pair is edited — the whole of backburner AF's arithmetic, in one place so
 * the Inspector field and the canvas resize gesture cannot derive it differently.
 *
 * THE RATIO COMES FROM THE VALUES AT THE START OF THE EDIT, not from a stored
 * ratio leaf: the lock means "keep the shape it has now", and storing a number
 * would let the stored ratio and the visible box disagree the moment anything
 * else wrote w or h (a keyframe tween, an equation, an undo).
 *
 * SIGN IS PRESERVED, because a negative extent is a FLIP (core/geometry.js "THE
 * FLIP") and not a smaller number: locking the aspect of a horizontally flipped
 * widget must keep it flipped. The magnitude scales; the sign is the edited
 * value's own for the driven axis... except that the driven axis keeps ITS OWN
 * sign, so flipping W while locked does not also flip H.
 *
 * A ZERO DRIVER IS NOT AN ERROR AND HAS NO RATIO: from w=0 there is no shape to
 * preserve, so the other axis is left exactly as it was rather than being sent to
 * 0 (which would collapse the widget to a point on one keystroke and lose the
 * author's other dimension with it).
 *
 * Args:
 *   axis ("w"|"h"): which leaf the author edited
 *   value (number): the new value of that leaf
 *   before ({w: number, h: number}): both values before the edit
 *
 * Returns:
 *   {w: number, h: number}: both values after the edit
 *
 * Examples:
 *     >>> aspectLockedPair("w", 200, {w: 100, h: 50})
 *     { w: 200, h: 100 }
 *     >>> aspectLockedPair("h", 25, {w: 100, h: 50})
 *     { w: 50, h: 25 }
 *     >>> // a FLIP keeps the driven axis's own sign
 *     >>> aspectLockedPair("w", -200, {w: 100, h: 50})
 *     { w: -200, h: 100 }
 *     >>> // no ratio to preserve from a zero: the other axis is untouched
 *     >>> aspectLockedPair("w", 200, {w: 0, h: 50})
 *     { w: 200, h: 50 }
 */
export function aspectLockedPair(axis, value, before) {
  const driver = axis === "w" ? before.w : before.h;
  const driven = axis === "w" ? before.h : before.w;
  if (!Number.isFinite(driver) || driver === 0 || !Number.isFinite(driven)) {
    return axis === "w" ? { w: value, h: before.h } : { w: before.w, h: value };
  }
  const scaled = Math.sign(driven || 1) * Math.abs(driven) * (Math.abs(value) / Math.abs(driver));
  return axis === "w" ? { w: value, h: scaled } : { w: scaled, h: value };
}

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
 * [{"key":"x","label":"X","kind":"number","category":"transform"},{"key":"y","label":"Y","kind":"number","category":"transform"}]
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
 * {key: overrides} map as props(). `bundle("transform")` is the shared bbox
 * rows (x/y, the cx/cy center shortcut, w/h, rotation + its anchor, z);
 * `bundle("strokedBox")` the four box-style rows.
 *
 * Args:
 *   name (string): a BUNDLES key
 *   overrides (object): {propKey: partialRow} overrides (optional)
 *
 * Returns:
 *   object[]: resolved rows
 *
 * @example bundle("strokedBorder").map((r) => r.key)
 * ["stroke","strokeWidth","strokeOffset","strokeScreenSpace","cornerRadius","strokeStart","strokeEnd","strokePhase","strokeCapStart","strokeCapEnd","strokeJoin","strokeMiter"]
 * @example bundle("transform").map((r) => r.key)
 * ["x","y","cx","cy","w","h","rotation","rotationAnchor.x","rotationAnchor.y","z"]
 * @example // cx/cy keep their OWN unique key (never collide with x/y — a
 * @example // repeated key is a plugin defect per core/multiselect.js
 * @example // intersectRows) but carry `writeKey` naming the REAL stored slot:
 * @example bundle("transform")[2]
 * {"key":"cx","label":"Center X","kind":"number","category":"transform","writeKey":"x","centerAxis":"x","help":"Horizontal position of the widget's CENTER, in canvas units — a shortcut for x + width/2. Typing a value here moves x so the center lands exactly there; equivalent to reading self.cx in an equation."}
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
 * {"strokeWidth":0,"strokeScreenSpace":false,"cornerRadius":0}
 * @example bundleDefaults("transform")
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
 * {"shadow":{"dx":0,"dy":0,"blur":0,"color":"#000000","opacity":0},"bloom":{"radius":10,"strength":0},"blendMode":"normal","innerShadow":{"dx":0,"dy":0,"blur":0,"color":"#000000","opacity":0},"softEdges":0,"gaussianBlur":0}
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
    checkCodeRow(`customProps def "${def.name}"`, def);
    checkNullableRow(`customProps def "${def.name}"`, def);
    const { name, kind, default: defaultValue, label, category, ...rest } = def;
    rows.push({ key: name, kind, label: label ?? defaultLabel(name), category: category ?? CUSTOM_CATEGORY, ...rest });
    defaultsOut[name] = defaultValue;
  }
  return { rows, defaults: defaultsOut };
}

// ── Per-property interpolation modes (core/interp_modes.js) ──────────────────

/**
 * Pure function. THE INTERP ROW for a property row: a derived `select` row that
 * edits the property's sibling mode companion `<writeKey>~interp`.
 *
 * It is DERIVED, never declared. No plugin lists an interp row and none ever
 * should — the mode applies to EVERY keyframeable property of every widget, so
 * declaring them would be the exact copy-paste this registry exists to kill (and
 * would double the row count of every plugin file). The Inspector builds one on
 * demand for whichever row the user opens the affordance on.
 *
 * The result is an ORDINARY row: same {key, label, kind, options, ...} shape
 * every other row has, so it renders through the same select control, writes
 * through the same keyframe path, and undoes through the same machinery. The
 * mode is a real keyframeable property, which is what the whole design rests on.
 *
 * NO `default` and no defaults-fill: an ABSENT companion is the mode the
 * default-mode seam picks and must stay absent, so a legacy document keeps
 * folding to identical bytes. The Inspector SHOWS that same seam's answer when
 * the key is missing; writing it stores an explicit mode, a real (undoable) edit.
 *
 * THE DISPLAYED ABSENT MODE IS VALUE-AWARE, and must be. `absentValue` was a
 * hardcoded "tween", which made the select LIE on a paint row: with nothing
 * stored, core/interp_modes.defaultModeFor blends a paint pair while the control
 * read "Tween". So the absent display now comes from displayedDefaultModeFor
 * over the property's CURRENT VALUE — one seam answering both the render and the
 * label, which is the only way they cannot drift.
 *
 * It takes the VALUE, not the state, deliberately: the caller has already read
 * this row's possibly-dotted key ("rotationAnchor.x") out of state to render the
 * control, so asking for the state here would mean a second path-walker in core
 * that could disagree with the Inspector's. `undefined` (the default, and what a
 * not-yet-created item reads) falls back to DEFAULT_INTERP_MODE, so every caller
 * that only wants key/label/kind is unaffected.
 *
 * Args:
 *   propRow (object): the row whose blend law this edits (only its key/writeKey
 *     and label are read)
 *   value (*): the property's folded value on the slide being shown. Read to pick
 *     the displayed absent mode AND to filter the option list by value shape (a
 *     paint offers Blend, a boolean offers Fade). Optional.
 *   type (string): the owning widget's type, when the caller knows it — lets the
 *     filter recognize a widget's CONTENT leaf (an equation's source, a text
 *     box's string) and offer Morph on it. Optional.
 *
 * Returns:
 *   object: a select row over the mode ids that APPLY to this property
 *
 * @example interpRowFor({key: "x", label: "X"}).key
 * "x~interp"
 * @example interpRowFor({key: "x", label: "X"}).label
 * "X interp"
 * @example interpRowFor({key: "cx", writeKey: "x", label: "Center X"}).key
 * "x~interp"
 * @example interpRowFor({key: "x", label: "X"}).kind
 * "select"
 * @example interpRowFor({key: "x", label: "X"}, 5).absentValue
 * "tween"
 * @example interpRowFor({key: "fill", label: "Fill"}, {type: "material", material: {id: "crt"}}).absentValue
 * "blend"
 * @example // THE OPTION LIST IS FILTERED: a coordinate has no outline and no second paint
 * @example // (but it IS a scalar, so the geometric law applies — WORKSTREAM BG)
 * @example interpRowFor({key: "x", label: "X"}, 5).options
 * [ 'tween', 'step', 'expTween' ]
 * @example // the TYPE row no longer offers Morph — that moved to the UNIVERSAL
 * @example // Morph property, which asks about the widget's outline rather than
 * @example // about one leaf. `tween` is the displayed default and is always kept
 * @example // (a select whose current value is absent from its options renders blank).
 * @example interpRowFor({key: "type", label: "Type"}, "rect").options
 * [ 'tween', 'step' ]
 * @example // an equation's SOURCE morphs through the UNIVERSAL row, not its own
 * @example interpRowFor({key: "latex", label: "LaTeX"}, "x^2", "latex").options
 * [ 'tween', 'step' ]
 */
export function interpRowFor(propRow, value, type) {
  const target = propRow.writeKey ?? propRow.key;
  const labels = interpModeLabels();
  // THE APPLICABILITY FILTER (core/interp_modes.modesForKey), not the whole
  // registry. User ruling: "Tween doesn't really make sense in terms of widget
  // type interpolation… blend and tween, those don't really make any sense". A
  // mode that cannot do anything for this row degraded silently to the discrete
  // switch, so the select was offering several names for one behavior with
  // nothing to tell them apart — a confident wrong answer in the one place an
  // author goes to ask what a property can do. Each mode declares its own domain;
  // this reads them.
  const options = modesForKey(target, value, type);
  return {
    key: interpKeyFor(target),
    label: `${propRow.label} interp`,
    kind: "select",
    category: propRow.category,
    options,
    optionLabels: labels,
    // The option the Inspector SHOWS when the companion key is absent from state
    // — which is the normal, untouched condition and must stay that way. It is
    // the DEFAULT-MODE SEAM's own answer for this property's current value, not
    // a constant: see the docblock's "THE DISPLAYED ABSENT MODE IS VALUE-AWARE"
    // and the `absentValue` note in web/Inspector.svelte's select branch.
    absentValue: displayedDefaultModeFor(value, target),
    interpOf: target,
    // The help explains EXACTLY the options the select offers, never the whole
    // registry: describing a mode the author cannot pick here is the same
    // confident wrong answer the filter above removes, one line down.
    //
    // `interpNote` (WORKSTREAM BI) IS THE SAME ARGUMENT ONE STEP FURTHER. A row
    // may declare a trailing sentence naming something that OUTRANKS the selected
    // mode — today only the camera's x/y, whose pan a `interpolateState` coupling
    // replaces whenever the frame is also scaling (plugins/camera.js). The option
    // filter above stops the select naming a law the author cannot pick; this
    // stops it implying the law it names is the last word when the widget's own
    // hook says otherwise. It is appended, never substituted, because the stored
    // mode IS still real and still governs the moment the override does not apply.
    // Absent on every other row, so nothing else changes by a character.
    help: `How "${propRow.label}" moves across a transition. ${options.map((id) => `${labels[id]} — ${interpMode(id).help}`).join(" ")}${propRow.interpNote ?? ""}`,
  };
}

/**
 * Pure function. THE INTERP MODE'S OWN OPTION ROWS — the number rows the
 * SELECTED mode declares, or `[]` for every mode that declares none (which is
 * every mode but `blurFade` today).
 *
 * ── WHY IT EXISTS (user ruling, 2026-08-02, verbatim) ────────────────────────
 *   "BlurFade should have suboptions, by the way. For BlurFade, I should be able
 *    to choose how blurry was it, right? What is the difference in blur?
 *    BlurFade is too subtle for me right now, so I can't adjust it."
 *
 * A mode used to be a bare name, so every number its picture depended on was a
 * module constant no author could reach. This is the standing surfacing ruling
 * ("generally I want a gooey way of doing it") applied to that gap: a knob the
 * renderer reads must be a row the author can drag.
 *
 * ── IT IS DRIVEN BY THE DECLARATION, WHICH IS THE WHOLE POINT ────────────────
 * The rows come from `modeParams(mode)`, so a FUTURE mode that declares its own
 * options gets its rows with NO change here and none in web/Inspector.svelte.
 * That is why this is a general mapping of declarations onto rows rather than a
 * blurFade-shaped special case, even though blurFade is the only caller today —
 * the alternative is a second hand-maintained list that drifts from the
 * declarations the renderer actually reads.
 *
 * ── WHY THE ROWS FOLLOW THE SELECTED MODE, NOT THE STORED KEYS ───────────────
 * The parameter state key survives a mode change (it is an ordinary leaf), which
 * is deliberate: an author who tries Manim and comes back to Blur Fade finds
 * their amount still set. But a row for a mode that is NOT selected would be a
 * control with no picture behind it — the same "confident wrong answer" the
 * option filter above removes — so the ROWS are a function of the selected mode
 * while the VALUES are not.
 *
 * Args:
 *   propRow (object): the row whose mode these parameterize (key/writeKey, label)
 *   mode (string): the mode SELECTED for that property (stored, or the displayed
 *     default when nothing is stored — the caller resolves which)
 *
 * Returns:
 *   object[]: number rows, one per declared parameter, in declaration order
 *
 * @example interpParamRowsFor({key: "active", label: "Visible"}, "blurFade")[0].key
 * "active~interp~blur"
 * @example interpParamRowsFor({key: "active", label: "Visible"}, "blurFade")[0].label
 * "Blur Amount"
 * @example interpParamRowsFor({key: "active", label: "Visible"}, "blurFade")[0].kind
 * "number"
 * @example // the default is the row's absent value, so an untouched row SHOWS the
 * @example // number the renderer really uses rather than an empty box:
 * @example interpParamRowsFor({key: "active", label: "Visible"}, "blurFade")[0].default
 * 64
 * @example // every other mode declares nothing, so the gutter is unchanged there:
 * @example interpParamRowsFor({key: "x", label: "X"}, "tween")
 * []
 */
export function interpParamRowsFor(propRow, mode) {
  const target = propRow.writeKey ?? propRow.key;
  return modeParams(mode).map((decl) => ({
    key: interpParamKeyFor(target, decl.param),
    label: decl.label,
    kind: "number",
    category: propRow.category,
    min: decl.min,
    max: decl.max,
    step: decl.step,
    // ABSENT IS THE DECLARED DEFAULT, and stating it here is what makes the row
    // honest about the untouched case: the state holds nothing, and the renderer
    // uses this number, so the row must show this number. It is the same
    // argument interpRowFor's `absentValue` makes one row up.
    default: decl.default,
    help: decl.help,
    // The parameter this row edits, mirroring `interpOf` on the mode row — a
    // reader walking rows can tell mode plumbing from real properties without
    // parsing the key.
    interpParamOf: target,
  }));
}

/**
 * Pure function. May this row carry an interpolation mode? A row edits a real
 * keyframeable state leaf iff it keyframes at all — an ACTION row triggers a
 * command and owns no state, and a row opting out with `keyframes: false` (Name,
 * a transition's config rows) has no transition to blend across. Everything else
 * qualifies, INCLUDING booleans, colors, selects and text: the user's request
 * names `visible` explicitly, and a property whose values happen to be discrete
 * TODAY is exactly the one a future `fade`/`morph` mode is for.
 *
 * A MODE'S OWN PARAMETER ROW IS EXCLUDED TOO (WORKSTREAM AP), for exactly the
 * reason a mode row is: there is no mode-of-a-mode, and no mode of a mode's
 * knob. It needs its own test because `isInterpKey` is a SUFFIX check on
 * `~interp` and a parameter key ends in the parameter name instead, so a
 * parameter row would otherwise sail past it and grow a gutter of its own.
 *
 * @example rowSupportsInterp({key: "x", kind: "number"}) // true
 * @example rowSupportsInterp({key: "visible", kind: "boolean"}) // true
 * @example rowSupportsInterp({key: "name", kind: "text", keyframes: false}) // false
 * @example rowSupportsInterp({key: "__ungroup", kind: "action"}) // false
 * @example rowSupportsInterp({key: "active~interp", kind: "select"}) // false (no mode of a mode)
 * @example rowSupportsInterp({key: "active~interp~blur", kind: "number"}) // false (nor of its knob)
 */
export function rowSupportsInterp(propRow) {
  return propRow.keyframes !== false && propRow.kind !== "action"
    && !isInterpKey(propRow.key) && !isInterpParamKey(propRow.key);
}
