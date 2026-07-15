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
 * core/strokeDecoration.js) and EVERY box-like consumer (rect, image, video,
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
  fill: { label: "Fill", kind: "color", category: "formatting", help: "The color that fills the widget's interior. Lower its alpha for a translucent fill, or set it fully transparent for outline-only." },
  stroke: { label: "Stroke", kind: "color", category: "formatting", help: "The color of the outline drawn around the widget's edge. Only visible when stroke width is above zero." },
  strokeWidth: { label: "Stroke width", kind: "number", min: 0, category: "formatting", default: 0, help: "Thickness of the outline in canvas units. Zero means no outline." },
  cornerRadius: { label: "Corner radius", kind: "number", min: 0, category: "formatting", default: 0, help: "Rounds the widget's corners by this radius in canvas units. Zero is a sharp square corner; larger values round more." },

  // ── formatting: opacity ─────────────────────────────────────────────────────
  // Bounded [0,1] → NumericField range-scales its scrub automatically (the fix
  // for opacity "flicking between 0 and 1"; manifest "Number slider
  // sensitivity"). default 1 (fully opaque).
  opacity: { label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting", default: 1, help: "How see-through the whole widget is, from 0 (invisible) to 1 (fully solid)." },

  // ── formatting: color (single-color widgets: camera background) ─────────────
  background: { label: "Background", kind: "color", category: "formatting", help: "The color painted behind everything in this camera's view — the slide's backdrop in exports and presentation." },

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
  // (shadow blur 0 / bloom strength 0 / blendMode normal) so every old document
  // renders byte-identically (the Round 12D requirement). Nested dotted keys,
  // the rotationAnchor.{x,y} precedent — Inspector paths/keyframes/equations all
  // split on "." (equations read them as shadow.dx etc.).
  //
  // Enabled-state defaults are LINKED PRECEDENTS (arbitrary-constants rule):
  // dx/dy 3 = refs/Figures/scratchpad.py's shadow_dx=3 (the Figures drop-shadow
  // demo); color black + opacity 0.5 = refs/Figures/paper_peacock.py's
  // production call with_drop_shadows(color='black', opacity=.5); bloom radius
  // 10 = rp with_drop_shadow's blur=10 default (the same Gaussian-sigma family;
  // rp r.py:5002). Blur/radius are Gaussian SIGMAS in world units — the
  // blurBackdrop radius convention (render_gpu/ir.js).
  "shadow.dx": { label: "Shadow X", kind: "number", category: "effects", default: 3, help: "How far the drop shadow shifts horizontally, in canvas units (positive is right). The shadow appears once Shadow blur is above zero." },
  "shadow.dy": { label: "Shadow Y", kind: "number", category: "effects", default: 3, help: "How far the drop shadow shifts vertically, in canvas units (positive is down). The shadow appears once Shadow blur is above zero." },
  "shadow.blur": { label: "Shadow blur", kind: "number", min: 0, category: "effects", default: 0, help: "How soft the drop shadow is (Gaussian blur amount, canvas units). Zero means NO shadow — raise it to turn the shadow on." },
  "shadow.color": { label: "Shadow color", kind: "color", category: "effects", default: "#000000", help: "The drop shadow's color — classically black, but any color works (a colored glow-like shadow, for instance)." },
  "shadow.opacity": { label: "Shadow opacity", kind: "number", min: 0, max: 1, category: "effects", default: 0.5, help: "How dark the drop shadow is, from 0 (invisible) to 1 (fully solid shadow color)." },
  "bloom.radius": { label: "Bloom radius", kind: "number", min: 0, category: "effects", default: 10, help: "How far the bloom glow spreads (Gaussian blur amount, canvas units). Takes effect once Bloom strength is above zero." },
  "bloom.strength": { label: "Bloom strength", kind: "number", min: 0, category: "effects", default: 0, help: "How bright the glow is: a blurred copy of the widget added on top of itself. Zero means NO bloom; 1 adds a full-brightness copy; higher over-glows." },
  // Options mirror render_gpu/ir.js BLEND_MODES (the validating home — kept a
  // literal here because core/ never imports render_gpu/; the effects IR test
  // asserts the two lists stay identical).
  blendMode: { label: "Blend mode", kind: "select", options: ["normal", "multiply", "add", "screen"], category: "effects", default: "normal", help: "How the widget's pixels combine with what's behind it: normal paints over, multiply darkens, add/screen brighten (light-like)." },
};

/**
 * BUNDLES — named ORDERED lists of property keys (manifest "SHARED STYLE
 * BUNDLES"). A bundle is the reusable group a family of widgets composes;
 * `bundle(name)` expands it to rows, `bundleDefaults(name)` to a defaults
 * fragment.
 *
 * `positioning` — the nine bbox positioning rows every bbox widget shares.
 * `strokedBox` — the four-property box style (fill/stroke/strokeWidth/
 *   cornerRadius) + its render decoration (core/strokeDecoration.js). This is
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
 * {"shadow":{"blur":0,"opacity":0.5},"blendMode":"normal"}
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
 * {"shadow":{"dx":3,"dy":3,"blur":0,"color":"#000000","opacity":0.5},"bloom":{"radius":10,"strength":0},"blendMode":"normal"}
 */
export function bundleNestedDefaults(name) {
  const keys = BUNDLES[name];
  if (!keys) throw new Error(`properties.bundleNestedDefaults: unknown bundle "${name}"`);
  return nestedDefaults(...keys);
}
