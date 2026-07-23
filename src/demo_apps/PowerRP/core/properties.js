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
 * The property definition table. Each entry is keyed by its property key (the
 * state field / equation slug) and holds the DEFAULT row aspects + an optional
 * `default` value (the fragment default). A widget composes rows/defaults by
 * naming keys; per-widget overrides layer on top (see props()).
 *
 * `kind` — the Inspector control: "number" | "color" | "text" | "checkbox" |
 *   "boolean" | "select". `category` — the collapsible-accordion group
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
  w: { label: "Width", kind: "number", min: 0, category: "positioning", help: "How wide the widget is, in canvas units. Drag the side/corner handles to resize instead." },
  h: { label: "Height", kind: "number", min: 0, category: "positioning", help: "How tall the widget is, in canvas units. Drag the side/corner handles to resize instead." },
  // core stores rotation in RADIANS; the field edits/shows DEGREES (manifest
  // "Rotation is DEGREES" — round-10 ruling). `display` is the only difference
  // from a plain number row, single-sourced here.
  rotation: { label: "Rotation", kind: "number", display: "degrees", category: "positioning", default: 0, help: "Clockwise rotation in degrees, pivoting about the rotation anchor (its own center by default)." },
  "rotationAnchor.x": { label: "Rot anchor X", kind: "number", category: "positioning", help: "The X of the point the widget rotates around. Defaults to the widget's own center; set it to another item's anchor to spin about that point." },
  "rotationAnchor.y": { label: "Rot anchor Y", kind: "number", category: "positioning", help: "The Y of the point the widget rotates around. Defaults to the widget's own center; set it to another item's anchor to spin about that point." },
  z: { label: "Z order", kind: "number", category: "positioning", help: "Stacking order: higher numbers draw on top of lower ones. Use Bring to Front / Send to Back to reorder without typing." },

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
  fill: { label: "Fill", kind: "color", paint: true, category: "formatting", help: "The color or gradient that fills the widget's interior. Lower a color's alpha for a translucent fill, pick a linear/radial gradient, or set it fully transparent for outline-only." },
  stroke: { label: "Stroke", kind: "color", paint: true, category: "formatting", help: "The color or gradient of the outline drawn around the widget's edge. Only visible when stroke width is above zero." },
  strokeWidth: { label: "Stroke width", kind: "number", min: 0, category: "formatting", default: 0, help: "Thickness of the outline in canvas units. Zero means no outline." },
  cornerRadius: { label: "Corner radius", kind: "number", min: 0, category: "formatting", default: 0, help: "Rounds the widget's corners by this radius in canvas units. Zero is a sharp square corner; larger values round more." },

  // ── formatting: opacity ─────────────────────────────────────────────────────
  // Bounded [0,1] → NumericField range-scales its scrub automatically (the fix
  // for opacity "flicking between 0 and 1"; manifest "Number slider
  // sensitivity"). default 1 (fully opaque).
  opacity: { label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting", default: 1, help: "How see-through the whole widget is, from 0 (invisible) to 1 (fully solid)." },

  // ── formatting: color (single-color widgets: camera background) ─────────────
  background: { label: "Background", kind: "color", category: "formatting", help: "The color painted behind everything in this camera's view — the slide's backdrop in exports and presentation." },

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
  // against the project's assets/ server-side by the frames endpoint). Default
  // "url" (the more common case); filmstrip overrides to "filename".
  src: { label: "Source", kind: "asset", assetKinds: ["image"], assetForm: "url", category: "formatting", help: "The image or video this widget shows — pick from the project's assets, upload a file, or drag one in from the Asset Explorer or Finder." },
  frames: { label: "Frames", kind: "number", min: 1, category: "formatting", help: "How many evenly-spaced frames to sample across the whole clip and lay out left to right." },
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
  "shadow.dx": { label: "Shadow X", kind: "number", category: "effects", default: 0, help: "How far the drop shadow shifts horizontally, in canvas units (positive is right). The shadow appears once Shadow opacity is above zero." },
  "shadow.dy": { label: "Shadow Y", kind: "number", category: "effects", default: 0, help: "How far the drop shadow shifts vertically, in canvas units (positive is down). The shadow appears once Shadow opacity is above zero." },
  "shadow.blur": { label: "Shadow blur", kind: "number", min: 0, category: "effects", default: 0, help: "How soft the drop shadow is (Gaussian blur amount, canvas units). Zero is a crisp, hard-edged shadow — the shadow is on whenever Shadow opacity is above zero, softness is separate." },
  "shadow.color": { label: "Shadow color", kind: "color", category: "effects", default: "#000000", help: "The drop shadow's color — classically black, but any color works (a colored glow-like shadow, for instance)." },
  "shadow.opacity": { label: "Shadow opacity", kind: "number", min: 0, max: 1, category: "effects", default: 0, help: "How dark the drop shadow is, from 0 (invisible — NO shadow, the default) to 1 (fully solid shadow color). This is the shadow's on/off gate: raise it above 0 to turn the shadow on." },
  "bloom.radius": { label: "Bloom radius", kind: "number", min: 0, category: "effects", default: 10, help: "How far the bloom glow spreads (Gaussian blur amount, canvas units). Takes effect once Bloom strength is above zero." },
  "bloom.strength": { label: "Bloom strength", kind: "number", min: 0, category: "effects", default: 0, help: "How bright the glow is: a blurred copy of the widget added on top of itself. Zero means NO bloom; 1 adds a full-brightness copy; higher over-glows." },
  // Options mirror render_gpu/ir.js BLEND_MODES (the validating home — kept a
  // literal here because core/ never imports render_gpu/; the effects IR test
  // asserts the two lists stay identical).
  blendMode: { label: "Blend mode", kind: "select", options: ["normal", "multiply", "add", "screen"], category: "effects", default: "normal", help: "How the widget's pixels combine with what's behind it: normal paints over, multiply darkens, add/screen brighten (light-like)." },

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
  particleLifetime: { label: "Lifetime", kind: "number", min: 0, category: "particles", default: 2, help: "How many seconds each particle lives before it disappears. Longer lifetimes keep more particles on screen at once." },
  particleAngle: { label: "Angle", kind: "number", category: "particles", default: 270, help: "The central launch direction in degrees (0 = right, 90 = down, 270 = up). Particles fly outward from the origin along this heading." },
  particleSpread: { label: "Spread", kind: "number", min: 0, max: 360, category: "particles", default: 50, help: "How wide the launch fan is, in degrees, centered on the angle. Zero is a tight jet; 360 is a full radial burst in every direction." },
  particleSpeedMin: { label: "Speed min", kind: "number", min: 0, category: "particles", default: 60, help: "The slowest a particle can be launched, in canvas units per second. Each particle picks a random speed between min and max." },
  particleSpeedMax: { label: "Speed max", kind: "number", min: 0, category: "particles", default: 140, help: "The fastest a particle can be launched, in canvas units per second. Set equal to Speed min for a uniform speed." },
  particleGravityX: { label: "Gravity X", kind: "number", category: "particles", default: 0, help: "A constant sideways pull on every particle, in canvas units per second squared (positive drifts them right, like wind)." },
  particleGravityY: { label: "Gravity Y", kind: "number", category: "particles", default: 120, help: "A constant downward pull on every particle, in canvas units per second squared (positive is down — real gravity). Negative makes them float up." },
  particleSizeMin: { label: "Size min", kind: "number", min: 0, category: "particles", default: 2, help: "The smallest a particle's radius can be at birth, in canvas units. Each particle picks a random size between min and max." },
  particleSizeMax: { label: "Size max", kind: "number", min: 0, category: "particles", default: 5, help: "The largest a particle's radius can be at birth, in canvas units. Set equal to Size min for uniform dots." },
  particleColor: { label: "Color", kind: "color", category: "particles", default: "#ffcc33", help: "The color of every particle. Lower its alpha for translucent sparks; combine with Fade to have them dim out over their life." },
  particleFade: { label: "Fade", kind: "number", min: 0, max: 1, category: "particles", default: 1, help: "How much a particle fades out over its life, from 0 (stays solid then vanishes) to 1 (fades all the way to transparent by the end)." },
  particleShrink: { label: "Shrink", kind: "number", min: 0, max: 1, category: "particles", default: 0, help: "How much a particle shrinks over its life, from 0 (keeps its birth size) to 1 (shrinks down to nothing by the end)." },
  particleSeed: { label: "Seed", kind: "number", category: "particles", default: 1, help: "The randomness seed. The same seed always produces the exact same particle pattern (so renders reproduce); change it to reshuffle." },

  // ── filmstrip: the FULL film_strip API (manifest ROUND 14.1) ──────────────────
  // These four give the filmstrip widget the rest of the original Python
  // film_strip(video, length, height, width, vertical, film_color) signature
  // (frames == length; src == video). Filmstrip-specific, so they live as plain
  // rows here rather than a bundle. `vertical` flips orientation; `filmColor` is
  // the strip's film color (default black, matching the Python default);
  // `frameW`/`frameH` are the PER-FRAME extraction/cell resolution in pixels
  // (empty = the video's native size — feeds BOTH the server extraction
  // resolution and the on-canvas cell layout). min 1 so a set resolution is a
  // real pixel size; no default value → an empty field means "native".
  vertical: { label: "Vertical", kind: "boolean", category: "formatting", default: false, help: "Lay the frames top-to-bottom in a vertical strip instead of left-to-right. The frames stay upright either way." },
  filmColor: { label: "Film color", kind: "color", category: "formatting", default: "#000000", help: "The color of the film base the frames sit on — the strip and its sprocket-hole bands. Classic film is black." },
  frameW: { label: "Frame width", kind: "number", min: 1, category: "formatting", help: "The pixel width to extract and lay out each frame at. Leave empty to use the video's native width." },
  frameH: { label: "Frame height", kind: "number", min: 1, category: "formatting", help: "The pixel height to extract and lay out each frame at. Leave empty to use the video's native height." },
};

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
export const BUNDLES = {
  positioning: ["x", "y", "w", "h", "rotation", "rotationAnchor.x", "rotationAnchor.y", "z"],
  // The endpoint-pair positioning every arrow-family widget shares (from/to
  // coordinates + z). Distinct from `positioning` — arrows have no bbox/rotation
  // of their own; their geometry IS the two endpoints (core/endpoints.js).
  endpoints: ["from.x", "from.y", "to.x", "to.y", "z"],
  // The BORDER-only slice of the stroked box: stroke + strokeWidth + cornerRadius
  // (no fill). Media widgets (image/video/filmstrip) compose THIS — a photo has
  // no fill color of its own, only a frame. rect/donut/cropbox add `fill`
  // themselves (they ARE filled boxes).
  strokedBorder: ["stroke", "strokeWidth", "cornerRadius"],
  // The full filled-and-stroked box: fill + the border slice.
  strokedBox: ["fill", "stroke", "strokeWidth", "cornerRadius"],
  // EDGE-CROP INSETS (manifest "Edge-crop insets"): the four per-edge source
  // trims. Media widgets (image/video) compose this; groups will too (their
  // subtree-crop consumption is a follow-up — the bundle is defined once here).
  cropInsets: ["cropTop", "cropLeft", "cropRight", "cropBottom"],
  // THE EFFECTS BUNDLE (manifest Round 12D): drop shadow + bloom + blend mode,
  // composed by every DRAWN widget (render half: render_gpu/effects.js —
  // exclusions justified in its header). Defaults are effect-OFF; use
  // bundleNestedDefaults("effects") in plugin defaults (the keys are nested).
  effects: ["shadow.dx", "shadow.dy", "shadow.blur", "shadow.color", "shadow.opacity", "bloom.radius", "bloom.strength", "blendMode"],
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
 * ["stroke","strokeWidth","cornerRadius"]
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
 * {"shadow":{"dx":0,"dy":0,"blur":0,"color":"#000000","opacity":0},"bloom":{"radius":10,"strength":0},"blendMode":"normal"}
 */
export function bundleNestedDefaults(name) {
  const keys = BUNDLES[name];
  if (!keys) throw new Error(`properties.bundleNestedDefaults: unknown bundle "${name}"`);
  return nestedDefaults(...keys);
}
