<!--
  PaintField — the Axis-1 PAINT property field for fill/stroke rows. A paint is
  polymorphic (render_gpu/ir.js parsePaint): a SOLID color, or a LINEAR / RADIAL
  gradient. This field is the editor for that union — rebuilt on the state
  foundation so it fixes the three long-standing complaints:

    (1) TYPE-SWITCH NEVER FORGETS. A gradient paint is stored as ONE
        multi-sub-state object {type, solid, linear, radial} that carries EVERY
        mode's state at once. Switching Solid→Linear→Radial→Solid only flips
        `type`; the other modes' colors/stops/geometry persist untouched. (A
        paint that has never been a gradient stays a bare solid STRING, so a
        document that never touches a gradient never changes shape — and a solid
        renders byte-identically either way, parsePaint "solid" case.)

    (2) STOPS ARE KEYFRAMABLE. Each stop's color + offset live at a real state
        path (…fill.<mode>.stops.<i>.color / .offset), so the standard fields
        and the shared KeyframeControls operate on them like any other property:
        a stop's offset/color TWEENS across slides (core structural keyframing —
        core/deltas.blendApplied applies the sparse per-element keyframe; the
        offset lerps and the color blends). A per-slot ◆ keyframes that stop on
        the current slide.

    (3) STANDARD CONTROLS. Stop colors render through the app's standard
        ColorField (swatch + inline picker + integral alpha); stop offsets
        through NumericField (the DraggableNumber scrubber) — NOT hand-typed hex
        or bare number inputs. Exactly the controls every other property uses.

  ── THE STOP LIST IS NO LONGER BESPOKE (the DRY consolidation) ────────────────
  This field used to hand-write a stop row per element plus its own "+ Add stop"
  and "×" buttons. That WAS the general list mechanism, built once here for one
  property — which is exactly the duplication core/lists.js exists to end. The
  stops now render through web/ListField.svelte, driven by the SAME declaration
  core types the slots from (core/properties.js GRADIENT_STOPS_LIST), so:
    - stop colours/offsets keep the identical controls, paths and per-element ◆
      (points 2 and 3 above are unchanged — ListField delegates to the same
      ColorField / NumericField at the same paths, and the offset's 0..1 bounds
      now come from the DECLARATION instead of being re-typed here);
    - every stop gains a VISIBILITY toggle (hiding one ramps straight past it,
      byte-identically to never having authored it) and INSERT-BETWEEN /
      insert-at-either-end, which is what the user asked for ("the add stop
      inside the gradient UI could be better… insertions at the ends or in
      between… And that should be generalized");
    - removal is now PURGE, which REFUSES below the declared minimum of two
      stops with the reason in its tooltip, where the old × silently no-oped.
  WHAT CHANGED VISIBLY, and nothing else: the two fields now read in DECLARATION
  order (position, then colour — the old row put colour first), and an insert at
  the end EXTRAPOLATES from the last two stops rather than always appending white
  at offset 1.

  ── THE PRESET LIBRARY IS NOT MOUNTED HERE ANY MORE ──────────────────────────
  It was, privately, which is exactly why no property other than a paint could
  have one — and why the Mandelbrot palette had to be a `select` over six
  hard-coded colour lists instead of the same control. GRADIENT_STOPS_LIST now
  DECLARES `presets: COLOR_RAMP_LIBRARY` and web/ListField.svelte mounts the
  library from the declaration, above the rows and folding them while it is open,
  for the reasons that used to be recorded here (a swatch being pointed at must
  not be able to move when the list under it resizes: measured, 13 height changes
  over 14 swatches). Nothing about the behaviour changed; the OWNER did.

  KNOWN BOUND: a stop COLOUR can hold an `=` equation (core evaluates it now —
  the old "list elements are not equation slots" bound is closed) and ColorField
  displays it, but ENTERING one is not offered inside a list: the universal Tier-0
  `=` field lives at web/Inspector.svelte's row seam and is not reachable from
  inside a value control. A stop OFFSET has full equation entry (NumericField owns
  its own). Gradient geometry (linear direction / radial radius) is edited here;
  radius is a NumericField (keyframable), direction is an AngleField dial. Both
  are equation-bindable like every other property (manifest Tier 0) — the
  direction's leaf simply carries the "=" expression instead of a number.

  Props mirror ColorField: app, path (["items", id, "fill"|"stroke"]), label,
  value (the raw stored paint — string or multi-sub-state object), disabled.
  Styling: inline styles over existing app.css --a-*/--fg/--border tokens (this
  field adds no app.css classes; the house token convention is preserved). The
  stop list brings its own (.listfield / .list-*, in app.css where the house
  convention puts chrome) — one more reason not to keep a second copy here.
-->
<script module>
  import { fillCapableMaterialIds } from "../render_gpu/skia/materials.js";
  import { strokeMaterialIds } from "../render_gpu/skia/stroke_materials.js";
  /** The material a fresh "Mat" paint starts on — the first fill-capable entry
   * (the registry grows as materials opt in; comic is the exemplar). A STROKE
   * slot uses the first stroke-capable entry instead (see the `strokeMaterials`
   * prop below). */
  const DEFAULT_FILL_MATERIAL = fillCapableMaterialIds()[0] ?? "comic";
  const DEFAULT_STROKE_MATERIAL = strokeMaterialIds()[0] ?? "alongGradient";
  import { linearEndpointsToAngle, GRADIENT_DEFAULT_ANGLE, GRADIENT_DEFAULT_WAVELENGTH } from "../core/properties.js";
  const DEFAULT_SOLID = "#7aa2f7";
  const NEW_STOP_COLOR = "#ffffff";

  /**
   * Pure function. True iff the paint is an EQUATION — a string with a leading
   * "=" (the UNIVERSAL any-type equation affordance; core/expressions). The whole
   * fill is then a computed color, evaluated by evaluateState like any other
   * "=" property.
   *
   * @example isEquationPaint("=#ff0000") // true
   * @example isEquationPaint("= other.fill") // true
   * @example isEquationPaint("#ff0000") // false (a literal color)
   * @example isEquationPaint({type: "linearGradient"}) // false
   */
  export function isEquationPaint(value) {
    return typeof value === "string" && /^\s*=/.test(value);
  }

  /**
   * Pure function. The paint's mode id: "equation" for a leading-"=" string,
   * "solid" for a plain string / null / rgba array or an object whose type is
   * "solid", else the gradient object's own type.
   *
   * @example paintMode("#f00") // "solid"
   * @example paintMode("=#f00") // "equation"
   * @example paintMode(null) // "solid"
   * @example paintMode({type: "solid", solid: "#f00"}) // "solid"
   * @example paintMode({type: "linearGradient"}) // "linearGradient"
   */
  export function paintMode(value) {
    if (isEquationPaint(value)) return "equation";
    if (value && typeof value === "object" && !Array.isArray(value) && value.type) return value.type;
    return "solid";
  }

  /**
   * Pure function. A representative solid hex for a paint (its value if a bare
   * solid, its stored `solid` sub-state, else DEFAULT_SOLID) — the seed when a
   * fresh gradient is built from the current solid.
   *
   * @example seedSolid("#abc") // "#abc"
   * @example seedSolid({type: "linearGradient", solid: "#123"}) // "#123"
   * @example seedSolid(null) // "#7aa2f7"
   */
  export function seedSolid(value) {
    if (isEquationPaint(value)) return DEFAULT_SOLID; // an equation string is not a color literal
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object" && typeof value.solid === "string") return value.solid;
    return DEFAULT_SOLID;
  }

  /**
   * Pure function. A fresh linear gradient sub-state seeded from a solid color:
   * two stops (solid → white) sweeping left→right (GRADIENT_DEFAULT_ANGLE = 0°).
   * `angle` (degrees) is the single source of truth for direction — the renderer
   * derives the from/to endpoints from it (render_gpu/ir.js linearAxis), so no
   * from/to is stored here.
   *
   * `wavelength` (GRADIENT_DEFAULT_WAVELENGTH = 1: one ramp spans the whole axis)
   * is stored explicitly, like `angle`, so the Inspector's Wavelength scrubber
   * shows it; w=1 renders byte-identically to a gradient that omits it (render_gpu
   * /ir.js linearGradientRender returns the untouched axis at w=1). `center` is
   * NOT seeded — its absence is the box-center default, surfaced by the on-canvas
   * center bead once dragged.
   *
   * @example freshLinear("#f00").stops.length // 2
   * @example freshLinear("#f00").angle // 0
   * @example freshLinear("#f00").wavelength // 1
   * @example freshLinear("#f00").from // undefined (endpoints derived from angle at render time)
   */
  export function freshLinear(seed) {
    return { stops: [{ offset: 0, color: seed }, { offset: 1, color: NEW_STOP_COLOR }], angle: GRADIENT_DEFAULT_ANGLE, wavelength: GRADIENT_DEFAULT_WAVELENGTH };
  }

  /**
   * Pure function. A fresh radial gradient sub-state seeded from a solid color:
   * two stops (solid → white), centered, radius 0.5, objectBoundingBox space.
   *
   * @example freshRadial("#f00").center // {x: 0.5, y: 0.5}
   * @example freshRadial("#f00").r // 0.5
   */
  export function freshRadial(seed) {
    return { stops: [{ offset: 0, color: seed }, { offset: 1, color: NEW_STOP_COLOR }], center: { x: 0.5, y: 0.5 }, r: 0.5 };
  }

  /**
   * Pure function. Normalizes ANY stored paint value into the complete
   * multi-sub-state record {type, solid, linear, radial} — filling missing
   * sub-states with fresh defaults (seeded from the current solid) and lifting
   * a LEGACY inline gradient ({type, stops, from/to|center/r}) into its wrapper.
   * This is what a type-switch writes when the stored value is not yet a
   * complete object, so no mode's state is ever lost.
   *
   * @example paintSubstates("#f00").type // "solid"
   * @example paintSubstates("#f00").linear.stops[0].color // "#f00" (seeded)
   * @example paintSubstates({type: "linearGradient", stops: [{offset: 0, color: "#000"}, {offset: 1, color: "#fff"}], from: {x: 0, y: 0}, to: {x: 1, y: 0}}).linear.stops.length // 2 (legacy inline lifted)
   * @example paintSubstates({type: "radialGradient", solid: "#111", linear: {stops: []}, radial: {stops: [], center: {x: 0.5, y: 0.5}, r: 1}}).radial.r // 1
   */
  export function paintSubstates(value) {
    const isObj = value && typeof value === "object" && !Array.isArray(value);
    const type = paintMode(value);
    const seed = seedSolid(value);
    const solid = isObj && typeof value.solid === "string" ? value.solid : seed;
    const linear = isObj && value.linear ? value.linear
      : isObj && value.type === "linearGradient" && Array.isArray(value.stops) ? { stops: value.stops, angle: value.angle, from: value.from, to: value.to }
      : freshLinear(seed);
    const radial = isObj && value.radial ? value.radial
      : isObj && value.type === "radialGradient" && Array.isArray(value.stops) ? { stops: value.stops, center: value.center, r: value.r }
      : freshRadial(seed);
    // The MATERIAL sub-state (fill-material framework): {id, params} — sparse
    // params, no state until written. Carried through every mode switch like
    // linear/radial so choosing a material, trying a gradient, and coming back
    // loses nothing.
    const material = isObj && value.material ? value.material : { id: DEFAULT_FILL_MATERIAL, params: {} };
    return { type, solid, linear, radial, material };
  }

  /**
   * Pure function. True iff `value` is already a COMPLETE multi-sub-state object
   * (all three sub-states present) — then a type switch only flips `type`
   * (minimal delta); otherwise the full object is materialized first.
   *
   * @example isCompletePaint({type: "solid", solid: "#f00", linear: {}, radial: {}}) // true
   * @example isCompletePaint("#f00") // false
   * @example isCompletePaint({type: "linearGradient", stops: []}) // false (legacy inline)
   */
  export function isCompletePaint(value) {
    return !!(value && typeof value === "object" && !Array.isArray(value)
      && typeof value.solid === "string" && value.linear && value.radial);
  }
</script>

<script>
  import "iconify-icon";
  import ColorField from "./ColorField.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import SearchableDropdown from "../../../lib/SearchableDropdown.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import NumericField from "./NumericField.svelte";
  import AngleField from "./AngleField.svelte";
  import ListField, { collapseKeyFor } from "./ListField.svelte";
  import BrushPalette from "./BrushPalette.svelte";
  import { makeHoverPreview } from "./hoverPreview.js";
  import { resolveScrub } from "../../../lib/numberStep.js";
  import { GRADIENT_STOPS_LIST, GRADIENT_MIN_WAVELENGTH } from "../core/properties.js";
  import { getPath } from "../core/deltas.js";
  import { getMaterial, fillCapableMaterialIds as fillIds, materialFillParamDefaults } from "../render_gpu/skia/materials.js";
  import { getStrokeMaterial, strokeMaterialIds as strokeIds } from "../render_gpu/skia/stroke_materials.js";

  // `strokeMaterials` (Inspector passes true for the `stroke` row): the "Mat" mode
  // then offers the STROKE-material registry (arc-length gradients, width profiles,
  // dashes, wavy) and renders each entry's strokeParams, instead of the fill
  // registry. Default false keeps every fill/background PaintField byte-identical.
  let { app, path, paths = null, label, value, disabled = false, strokeMaterials = false } = $props();

  // Fan-out (the NumericField convention): `paths` present = a multi-selection
  // writes every selected item's paint; absent = the single path, byte-identical.
  // Reads (raw/mode/sub) stay on `path` — the PRIMARY — which is safe because the
  // Inspector only mounts a non-mixed multi row, so every target stores an equal
  // paint. The ONE aspect that cannot fan out is the gradient STOP LIST
  // (ListField has no `paths`); in multi it is replaced by an honest note below
  // rather than silently editing the primary alone.
  let writePaths = $derived(paths ?? [path]);
  let multi = $derived(writePaths.length > 1);
  /** Pure-ish per-call helper. The value for ONE fan-out target: objects cloned
   *  per target so N items never share a stored reference. $state.snapshot FIRST:
   *  a paint assembled from the reactive doc (setMode re-materializing a stored
   *  material's params, matSub, …) is a Svelte 5 DEEP PROXY, and structuredClone
   *  THROWS DataCloneError on proxies — clicking Mat crashed the SECOND time
   *  (the first click cloned a fresh literal; re-entry cloned the live doc
   *  state; user-reported live). snapshot() unwraps to plain data and is the
   *  identity on non-reactive values, so every other path is byte-identical. */
  const perTarget = (v) => (v !== null && typeof v === "object" ? structuredClone($state.snapshot(v)) : v);

  // THE stored paint — read RAW (not the `value` prop, which the Inspector
  // passes EVALUATED: a "=" equation paint is already resolved to a color there,
  // so the raw read is the ONLY way to see the equation and drive Equation mode).
  // Mirrors NumericField's stored/evaluated split. For solid/gradient paints raw
  // == evaluated, so every other mode is unchanged.
  let raw = $derived(getPath(app.rawState(), path));
  let mode = $derived(paintMode(raw));
  // The active gradient sub-state's key in the stored object ("linear"/"radial").
  let subKey = $derived(mode === "radialGradient" ? "radial" : "linear");
  let sub = $derived(paintSubstates(raw));
  // (The stop list itself is read by ListField, from the SAME path written below —
  // including the loud report for a corrupt non-array stops value, which used to
  // be derived here. One reader, so the control and the writes cannot disagree.)
  // A solid that has NEVER been a gradient is a bare STRING: its ColorField
  // edits `path` directly (byte-identical). Once the paint is the object form,
  // solid lives at path+["solid"].
  let solidIsBare = $derived(typeof raw === "string" || raw == null);

  /** Command. Commits the WHOLE paint object to every write path (one undo
   * unit) — used only when the stored value must be MATERIALIZED into the
   * object form. */
  function commitWhole(paint) {
    app.setPreview(writePaths.map((p) => [p, perTarget(paint)]));
    app.commitPreview();
  }

  /** Command. Commits a value at a SUB-PATH of the paint on every write path
   * (one undo unit) — the minimal-delta write for type flips, stop add/remove,
   * and geometry. */
  function commitAt(subpath, val) {
    app.setPreview(writePaths.map((p) => [[...p, ...subpath], perTarget(val)]));
    app.commitPreview();
  }

  /** Command. LIVE-previews a value at a SUB-PATH on every write path — the
   * mid-gesture half of the ColorField preview/commit contract: the viewport
   * re-renders while the DOCUMENT stays untouched (no undo entry) until commitAt
   * settles it. Drives the material-knob DraggableNumber's `oninput`. */
  function previewAt(subpath, val) {
    app.setPreview(writePaths.map((p) => [[...p, ...subpath], perTarget(val)]));
  }

  /** Command. Switches the paint mode. EQUATION mode makes the WHOLE paint a
   * "=" expression (a computed color, evaluated like any other any-type
   * property — the UNIFICATION reaches paint). Leaving equation mode seeds a
   * fresh paint from the default solid (the expression has no sub-states to keep).
   * Between object modes only `type` flips when the object is complete (every
   * sub-state persists — the fix for "switching forgets"); otherwise the full
   * multi-sub-state object is materialized. */
  function setMode(next) {
    if (disabled || next === mode) return;
    if (next === "equation") commitWhole(`=${seedSolid(raw)}`); // seed: a color-literal equation
    else if (next === "material") {
      // Materialize the whole paint AND force a material id valid for THIS slot: a
      // stroke slot must never store a fill-material id (the painter would call
      // getStrokeMaterial on it and throw). An existing valid id + its params are
      // kept; a foreign/absent one falls back to the slot default.
      const base = paintSubstates(raw);
      const stored = base.material ?? {};
      const id = matRegistryIds.includes(stored.id) ? stored.id : matDefaultId;
      // Seed any kind:"stops" list the chosen material declares (a fresh alongGradient
      // gets its default ramp), so the stops editor is never empty and the render
      // matches — withSeededLists leaves every other knob sparse.
      commitWhole({ ...base, type: "material", material: { id, params: withSeededLists(matGet(id), stored.params ?? {}) } });
    }
    else if (isCompletePaint(raw)) commitAt(["type"], next);
    else commitWhole({ ...paintSubstates(raw), type: next });
  }

  /** Command. Commits the raw equation text (the whole fill becomes the "="
   * expression string). A blank/"="-less entry is still stored verbatim so the
   * evaluator reports it loudly rather than this field second-guessing it. */
  function commitEquation(text) {
    commitWhole(text);
  }

  // The linear DIRECTION as a heading in DEGREES — the authoritative stored
  // `angle` if present, else derived from the from/to endpoints (old, un-migrated
  // docs) so the dial always reflects what actually renders. Passed to AngleField
  // as its `value`, which the field uses only when the ANGLE LEAF ITSELF holds
  // nothing (the legacy-endpoints case): a present angle — literal or "=" bound —
  // is read straight from the document by the field.
  let linearAngle = $derived(
    sub.linear.angle != null ? sub.linear.angle
      : sub.linear.from && sub.linear.to ? linearEndpointsToAngle(sub.linear.from, sub.linear.to)
      : GRADIENT_DEFAULT_ANGLE,
  );

  /** Command. Writes the linear DIRECTION from the dial: ONLY the authoritative
   * `angle` — the single source of truth. The renderer derives the
   * objectBoundingBox from/to endpoints from it (render_gpu/ir.js linearAxis),
   * so keyframing the angle tweens as a ROTATING axis rather than lerping endpoints
   * through a degenerate midpoint. `commit` settles it as one undo unit; otherwise
   * it is a live preview (viewport re-renders while the user drags the dial).
   * `heading` is a DEGREES number or an "=" EQUATION STRING — a direction is
   * equation-bindable like every other property (manifest Tier 0), and the write
   * is the same either way (the stored leaf simply carries the expression). */
  function writeDirection(heading, commit) {
    app.setPreview(writePaths.map((p) => [[...p, "linear", "angle"], heading]));
    if (commit) app.commitPreview();
  }
  const previewDirection = (heading) => writeDirection(heading, false);
  const commitDirection = (heading) => writeDirection(heading, true);

  // ── the MATERIAL mode's derived pieces (fill- AND stroke-material frameworks) ──
  // The slot decides the registry: a STROKE paint offers stroke materials + their
  // strokeParams; a fill/background paint offers fill materials + fillParams.
  let matRegistryIds = $derived(strokeMaterials ? strokeIds() : fillIds());
  let matDefaultId = $derived(strokeMaterials ? DEFAULT_STROKE_MATERIAL : DEFAULT_FILL_MATERIAL);
  const matGet = (id) => (strokeMaterials ? getStrokeMaterial(id) : getMaterial(id));
  /** The stored material sub-state ({id, params} — params sparse), but ONLY when its
   *  id belongs to THIS slot's registry; a stale/foreign id falls back to the slot
   *  default for DISPLAY (a stroke slot never asks getStrokeMaterial for a fill id).
   *  setMode() rewrites a foreign stored id on the next mode entry. */
  let matSub = $derived.by(() => {
    const stored = (raw && typeof raw === "object" && raw.material) ? raw.material : null;
    if (stored && matRegistryIds.includes(stored.id)) return stored;
    return { id: matDefaultId, params: stored?.params ?? {} };
  });
  let matEntry = $derived(matGet(matSub.id));
  // HIDDEN rows (`hidden: true`) are part of the SCHEMA for resolution but render no
  // Inspector row: the alongGradient legacy colour knobs (kept so a pre-stops-list
  // document still resolves its stored colours) and a stops list's `stopsActive`
  // visibility companion. Everything else — scalars, selects, and the kind:"stops"
  // list — is an editable row.
  let matRows = $derived(((strokeMaterials ? matEntry.strokeParams : matEntry.fillParams) ?? []).filter((r) => !r.hidden));
  /** Query. A knob's DISPLAY value: stored when written, else its schema default. */
  function matValue(row) {
    return matSub.params?.[row.name] ?? row.default;
  }

  /**
   * Pure function. The material params to store when a material becomes the chosen
   * one: the existing sparse params, plus a CONCRETE SEED for any kind:"stops" list
   * the entry declares (`seed`) that is not already stored. A LIST control needs
   * real elements to edit — unlike a scalar knob, which stays sparse and resolves
   * from its schema default at render time — so selecting a material with a stops
   * list materializes that list's default (byte-identical colours), while every
   * other knob keeps the "no state until written" rule. Stops are deep-copied so a
   * document never aliases the shared schema seed.
   */
  function withSeededLists(entry, params) {
    const rows = entry.strokeParams ?? entry.fillParams ?? [];
    const out = { ...(params ?? {}) };
    for (const row of rows)
      if (row.kind === "stops" && Array.isArray(row.seed) && !Array.isArray(out[row.name]))
        out[row.name] = row.seed.map((s) => ({ ...s }));
    return out;
  }

  // Pixels of drag that span a BOUNDED knob's whole range (and the scale an
  // unbounded fractional knob spreads over one run). LINKED to NumericField's
  // RANGE_DRAG_PX = 100 — one calibration for both numeric-scrubber families, so a
  // material knob and a property row drag at the same feel. Without it every one of
  // the ~174 material knobs fell back to DraggableNumber's raw 1 unit/px, and a
  // fully-bounded knob (crt convergence, 0..0.2) swept its whole range in ≤1px.
  const KNOB_DRAG_PX = 100;

  /**
   * Pure function. A material knob's calibrated {step, coefficient} for the
   * DraggableNumber scrubber, via the SHARED resolveScrub — so a bounded knob
   * sweeps its declared range over KNOB_DRAG_PX pixels rather than 1 unit/px, and
   * a schema-declared `scrub` (sky turbidity, lens_flare) is honoured instead of
   * silently dropped. Mirrors NumericField's resolveScrub call; material params
   * carry no display-unit conversion (an "angle" knob already stores degrees), so
   * bounds/default pass through raw. Null coefficient = "nothing knowable" (a 0
   * default, no bounds) → the call site keeps DraggableNumber's own 1 unit/px.
   *
   * @example knobScrub({min: 0, max: 0.2, default: 0.1}) // {step: 0.001, coefficient: 0.002}
   * @example knobScrub({scrub: 0.05, default: 2}) // {step: 0.01, coefficient: 0.05}
   * @example knobScrub({default: 0}) // {step: null, coefficient: null}
   */
  function knobScrub(row) {
    return resolveScrub({
      step: row.step ?? null,
      scrub: row.scrub ?? null,
      min: row.min ?? null,
      max: row.max ?? null,
      defaultValue: row.default ?? null,
      dragPx: KNOB_DRAG_PX,
    });
  }

  // The units-per-pixel for the gradient's fraction-of-box knobs (wavelength,
  // radial radius): 1 / KNOB_DRAG_PX, so a full 0..1 fraction sweeps over one drag
  // run. They live inside the paint OBJECT, not a plugin default, so resolveScrub
  // has no default/bound magnitude to see there and would leave them at 1 unit/px
  // — an explicit scrub is the only calibration reachable.
  const FRACTION_SCRUB = 1 / KNOB_DRAG_PX;
  let MATERIAL_OPTIONS = $derived(matRegistryIds.map((id) => ({ value: id, label: matGet(id).title ?? id })));

  // HOVER PREVIEW on the material dropdown (the FontPicker trope): pointing at an
  // entry stages material.id LIVE on the canvas and reverts on leave, the document
  // untouched (web/hoverPreview.js owns the contract; the SvelteLib Dropdown owns
  // the guarded onpreview/oncancelpreview effect, so no effect lives here — the
  // FontPicker effect_update_depth footgun cannot be reintroduced). Derived so it
  // re-binds if `app`/`writePaths` change (and reads them reactively, not as a
  // captured initial value); a multi-selection previews every target.
  let matHover = $derived(makeHoverPreview(app, (id) => writePaths.map((p) => [[...p, "material", "id"], id])));
  // TEXTURE PALETTE (entry contract `texturePalette`: the named select knob is
  // picked from a thumbnail grid — the texture brush's rp-demo sidebar). Hover
  // previews the texture live through the SAME factory as the material dropdown.
  let texKnobRow = $derived(matEntry.texturePalette ? matRows.find((r) => r.name === matEntry.texturePalette) : null);
  let texHover = $derived(makeHoverPreview(app, (id) => writePaths.map((p) => [[...p, "material", "params", matEntry.texturePalette], id])));

  /** Command. Switches the chosen material — writes the id AND seeds any stops
   * list the new material declares, as ONE undo unit. Carries the existing sparse
   * params over (byte-identical to the old id-only write for a material with no
   * stops list; resolveMaterialPaint drops any cross-material stale knob loudly,
   * exactly as before). */
  function commitMaterial(id) {
    commitAt(["material"], { id, params: withSeededLists(matGet(id), matSub.params ?? {}) });
  }

  /**
   * Query (reads matEntry/matSub). The single {subpath, value} write a select
   * knob PICK performs — factored out so the hover PREVIEW stages EXACTLY what
   * the commit writes (the manifest's hover doctrine: "point at an option, see
   * what choosing it would do"). Honors the entry's `presetExpand` contract: a
   * non-neutral pick on the preset knob EXPANDS to its continuous knobs (the
   * entry's own expand()) and resets the select to neutral, so the Inspector
   * always shows the values that render; any other select writes its one param.
   *
   * @example
   * // selectKnobWrite({name:"metalType"}, "brass")
   * // // → { subpath: ["material","params","metalType"], value: "brass" }
   */
  function selectKnobWrite(mrow, v) {
    const pe = matEntry.presetExpand;
    if (pe && mrow.name === pe.knob && v !== pe.neutral) {
      const expanded = pe.expand({ ...(matSub.params ?? {}), preset: v });
      return { subpath: ["material", "params"], value: { ...expanded, [pe.knob]: pe.neutral } };
    }
    return { subpath: ["material", "params", mrow.name], value: v };
  }

  /** Command. Commits a Mat SELECT knob (one undo unit) via selectKnobWrite —
   * so a preset pick expands and never silently overrides the rows beneath it. */
  function commitSelectKnob(mrow, v) {
    const w = selectKnobWrite(mrow, v);
    commitAt(w.subpath, w.value);
  }

  /** Command factory. The hover-preview {preview, cancel} pair for ONE select
   * knob (metalType, blendMode, …): pointing at an option — pointer OR arrow key,
   * the Dropdown collapses both to one "active" notion — stages selectKnobWrite's
   * write LIVE on every target and reverts on leave, the document untouched. It
   * is the SAME write commitSelectKnob makes, staged not committed
   * (web/hoverPreview.js's doctrine). Built per row because each knob writes a
   * different param; a multi-selection previews every target. */
  function selectKnobHover(mrow) {
    return makeHoverPreview(app, (v) => {
      const w = selectKnobWrite(mrow, v);
      return writePaths.map((p) => [[...p, ...w.subpath], perTarget(w.value)]);
    });
  }

  // ── THE MATERIAL KNOBS ARE THEIR OWN COLLAPSIBLE SECTION ──────────────────────
  // A material's knob list can be long (CRT ships 23), so it MUST fold rather than
  // flooding the Fill/Stroke row's value cell. It reuses the app's ONE section
  // accordion (.cat-header + chevron + .cat-rows, the same idiom the Inspector
  // categories and ListField use) and remembers its OWN collapse choice per SLOT —
  // keyed by the paint path with the item id dropped ("fill"/"stroke", via
  // ListField.collapseKeyFor), so folding Fill Material stays folded as the
  // selection changes, exactly like the Inspector's category rule one level up.
  const MATERIAL_COLLAPSE_KEY = "powerrp.materialCollapsed";
  let matCollapseKey = $derived(collapseKeyFor(path));
  let matSummary = $derived(`${matRows.length} ${matRows.length === 1 ? "knob" : "knobs"}`);

  /** Query (reads localStorage). The persisted collapse map, or {} when absent —
   *  and a REPORT plus {} when corrupt, never a silent swallow (web/ListField and
   *  web/Inspector loadCollapsed, verbatim). */
  function loadMatCollapsed() {
    try {
      const raw = localStorage.getItem(MATERIAL_COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn("PowerRP: bad materialCollapsed setting, ignoring:", e);
      return {};
    }
  }

  // The user's own fold choice for THIS slot. Re-read whenever the key changes,
  // because one mounted PaintField is reused across selections (ListField's
  // userCollapsed resync, one level down).
  let matCollapsed = $state(false);
  $effect(() => {
    matCollapsed = loadMatCollapsed()[matCollapseKey] === true;
  });

  /** Command. Toggles this slot's fold choice and persists it. Re-READS the map
   *  immediately before writing so a sibling PaintField (a fill gradient's twin
   *  stroke material section) mounted at the same time is never clobbered. */
  function toggleMatCollapsed() {
    const next = !matCollapsed;
    localStorage.setItem(MATERIAL_COLLAPSE_KEY, JSON.stringify({ ...loadMatCollapsed(), [matCollapseKey]: next }));
    matCollapsed = next;
  }

  const TYPES = [
    { id: "solid", label: "Solid" },
    { id: "linearGradient", label: "Linear" },
    { id: "radialGradient", label: "Radial" },
    { id: "material", label: "Mat" },
    { id: "equation", label: "= Eq" },
  ];
</script>

<div style="display:flex; flex-direction:column; gap:var(--a-sp-2); width:100%;">
  <div style="display:flex; gap:var(--a-sp-1);">
    {#each TYPES as t}
      <button
        type="button"
        {disabled}
        aria-pressed={mode === t.id}
        onclick={() => setMode(t.id)}
        style="flex:1; font-size:var(--a-font-sm); padding:var(--a-sp-1) var(--a-sp-2); cursor:pointer;
               color:var(--fg); border:1px solid var(--border); border-radius:0;
               background:{mode === t.id ? 'var(--a-hover-bg)' : 'transparent'};"
      >{t.label}</button>
    {/each}
  </div>

  {#if mode === "solid"}
    <!-- SOLID → the standard ColorField. A bare-string paint edits `path`
         directly (byte-identical); the object form edits path.solid. -->
    {#if solidIsBare}
      <ColorField {app} {path} paths={writePaths} {label} value={raw} {disabled} />
    {:else}
      <ColorField {app} path={[...path, "solid"]} paths={writePaths.map((p) => [...p, "solid"])} label={`${label} color`} value={sub.solid} {disabled} />
    {/if}
  {:else if mode === "material"}
    <!-- MATERIAL fill (the fill-material framework): pick a registered material,
         edit its knobs. Params are stored SPARSE — a row writes only when the
         user commits it; unwritten knobs resolve from the schema at render time
         (ports.resolveMaterialFillPaints), so "no state until written".
         HOVER PREVIEW: pointing at a dropdown entry previews that material LIVE on
         the canvas and reverts on leave (matHover; web/hoverPreview.js). A pick
         drops the transient revert FIRST — ListField.pickPreset's discipline — so
         the commit is the user's choice, never a hovered-past one left staged. -->
    <!-- SEARCHABLE (Round 2 #28/#29): the fill/stroke material registries grow
         past a dozen entries, so this picker types-to-filter. It is otherwise the
         same Dropdown contract — hover still previews LIVE, a pick still drops the
         transient revert then commits. -->
    <SearchableDropdown
      items={MATERIAL_OPTIONS}
      value={matSub.id}
      onchange={(id) => { app.transientPreview = null; commitMaterial(id); }}
      onpreview={matHover.preview}
      oncancelpreview={matHover.cancel}
    />
    {#if texKnobRow}
      <!-- THE BRUSH TEXTURE PALETTE (entry contract `texturePalette`): the rp
           paint demo's thumbnail sidebar. Hovering a swatch previews the texture
           LIVE on the canvas; picking commits ONE undo unit (transient revert
           dropped first, the ListField.pickPreset discipline). The plain select
           row below still lists the same ids — the palette is the visual door. -->
      <BrushPalette
        value={matValue(texKnobRow)}
        onpick={(id) => { app.transientPreview = null; commitAt(["material", "params", matEntry.texturePalette], id); }}
        onpreview={texHover.preview}
        oncancelpreview={texHover.cancel}
      />
    {/if}
    {#if matRows.length > 0}
      <!-- THE KNOBS ARE A DEDICATED COLLAPSIBLE SECTION (A material can ship 23 —
           CRT does): the app's ONE accordion (.cat-header + chevron + .cat-rows),
           folding this slot's knob list rather than flooding the row's value cell.
           The fold choice is remembered per slot (toggleMatCollapsed). -->
      <!-- Header names the MATERIAL, not the slot: this fold now lives INSIDE
           the top-level "Fill Material"/"Stroke Material" Inspector section
           (Round 2 #26), so repeating the slot name would read twice. -->
      <Tooltip text={matCollapsed ? `Show ${matEntry.title ?? matSub.id} knobs (${matSummary})` : `Fold ${matEntry.title ?? matSub.id} knobs away (${matSummary})`}>
        <button
          type="button"
          class="cat-header"
          aria-expanded={!matCollapsed}
          aria-label={`${matEntry.title ?? matSub.id} knobs: ${matSummary}`}
          onclick={toggleMatCollapsed}
        >
          <iconify-icon icon={matCollapsed ? "mdi:chevron-right" : "mdi:chevron-down"} width="16" height="16"></iconify-icon>
          <span class="cat-title">{matEntry.title ?? matSub.id} · {matSummary}</span>
        </button>
      </Tooltip>
      {#if !matCollapsed}
        <div class="cat-rows">
          {#each matRows as mrow (mrow.name)}
            {#if mrow.kind === "stops"}
              <!-- STOPS — THE REAL GRADIENT EDITOR, mounted for a material colour ramp
                   (alongGradient) exactly as it is for a gradient PAINT: the SAME
                   ListField driven by the SAME GRADIENT_STOPS_LIST declaration (its
                   `presets: COLOR_RAMP_LIBRARY` mounts the ramp preset library above
                   the rows), writing each stop's colour/offset at real state paths
                   (…material.params.stops.<i>.color/.offset) with per-stop keyframe ◆,
                   insert-between, visibility and purge-with-minimum. A REUSABLE row
                   kind: any fill/stroke material param declared kind:"stops" gets it,
                   with no alongGradient special-case here. -->
              {#if multi}
                <p class="paint-stops-multi-note">
                  Gradient stops are edited one item at a time — select a single item to edit them.
                </p>
              {:else}
                <ListField
                  {app}
                  decl={GRADIENT_STOPS_LIST}
                  path={[...path, "material", "params", mrow.name]}
                  label={mrow.label ?? mrow.name}
                  {disabled}
                  seedElement={{ offset: 0, color: NEW_STOP_COLOR }}
                />
              {/if}
            {:else}
            {@const scrub = knobScrub(mrow)}
            <div class="paint-material-row">
              <span class="paint-material-label">{mrow.label ?? mrow.name}</span>
              <span class="paint-material-control">
                {#if mrow.kind === "color"}
                  <ColorField {app} path={[...path, "material", "params", mrow.name]} paths={writePaths.map((p) => [...p, "material", "params", mrow.name])} label={mrow.name} value={matValue(mrow)} {disabled} />
                {:else if mrow.kind === "select"}
                  <!-- commitSelectKnob honors the entry's presetExpand contract:
                       a preset pick writes the continuous knobs and resets itself.
                       HOVER PREVIEW (the material-picker trope, web/hoverPreview.js,
                       via selectKnobHover): pointing at an option — pointer OR arrow
                       key, one "active" notion in the Dropdown — stages that pick
                       LIVE on the canvas and reverts on leave, the document
                       untouched; a real pick drops the transient revert FIRST
                       (ListField.pickPreset discipline) then commits ONE undo unit.
                       Closes the "metal material options don't preview on hover"
                       gap — the material id + texture palette already had it; the
                       per-param select knobs (metalType brass/chrome/…) did not. -->
                  {@const selHover = selectKnobHover(mrow)}
                  <Dropdown
                    items={mrow.options.map((o) => ({ value: o, label: mrow.optionLabels?.[o] ?? o }))}
                    value={matValue(mrow)}
                    onchange={(v) => { app.transientPreview = null; commitSelectKnob(mrow, v); }}
                    onpreview={selHover.preview}
                    oncancelpreview={selHover.cancel}
                  />
                {:else if mrow.kind === "boolean"}
                  <input type="checkbox" checked={matValue(mrow)} {disabled} aria-label={mrow.label ?? mrow.name} onchange={(e) => commitAt(["material", "params", mrow.name], e.target.checked)} />
                {:else}
                  <!-- number + angle (degrees) share the numeric scrubber. A bare
                       DraggableNumber, NOT NumericField: the field reads the DOC at
                       its path, and a sparse unwritten knob stores nothing there —
                       this control displays the RESOLVED value (stored ?? schema
                       default) and only a commit writes the knob.
                       LIVE PREVIEW (the ColorField contract): `oninput` stages the
                       drag on the canvas (previewAt — no undo entry) and `onchange`
                       settles ONE undo unit (commitAt). CALIBRATED scrub: the knob
                       schema's step/scrub/bounds/default route through resolveScrub
                       (knobScrub), so a bounded knob sweeps its range over
                       KNOB_DRAG_PX instead of DraggableNumber's raw 1 unit/px. -->
                  <DraggableNumber
                    value={matValue(mrow)}
                    min={mrow.min ?? null}
                    max={mrow.max ?? null}
                    step={scrub.step}
                    coefficient={scrub.coefficient ?? 1}
                    label={mrow.label ?? mrow.name}
                    oninput={(v) => previewAt(["material", "params", mrow.name], v)}
                    onchange={(v) => commitAt(["material", "params", mrow.name], v)}
                  />
                {/if}
              </span>
            </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  {:else if mode === "equation"}
    <!-- EQUATION → the whole paint is a "=" expression (a computed color).
         evaluateState resolves it and validates the result is a color; a
         wrong-type/broken expr falls back LOUDLY (core/expressions). Minimal
         monospace entry (the discoverable equation UX lives on numeric rows). -->
    <input
      type="text" value={typeof raw === "string" ? raw : ""} {disabled} spellcheck="false"
      aria-label={`${label} equation`} placeholder="=#ff0000"
      onchange={(e) => commitEquation(e.target.value)}
      style="width:100%; box-sizing:border-box; font-family:var(--a-mono); font-size:var(--a-font-sm);
             color:var(--fg); background:transparent; border:1px solid var(--border); border-radius:0;
             padding:var(--a-sp-1) var(--a-sp-2);"
    />
  {:else}
    <!-- STOPS — THE GENERAL LIST CONTROL (web/ListField.svelte), driven by the
         SAME declaration core types these slots from (GRADIENT_STOPS_LIST). It
         renders each stop's colour through ColorField and its offset through
         NumericField at the identical state paths this field used to write by
         hand (…stops.<i>.color / .offset), keeps the per-stop ◆, and adds the
         visibility toggle, insert-between / insert-at-either-end, and a purge
         that refuses below the declared two-stop minimum. The header records
         exactly what this consolidation changed. -->
    <div style="display:flex; flex-direction:column; gap:var(--a-sp-2);">
      <!-- The PRESET LIBRARY is no longer mounted here: GRADIENT_STOPS_LIST
           declares `presets: COLOR_RAMP_LIBRARY` and ListField mounts the library
           from that declaration, along with the fold-while-open behaviour this
           field used to drive through `forceCollapsed`. Same grid, same live
           hover-preview on the canvas, same one-undo-unit commit — one mount point
           instead of a private one, which is what lets any other ramp property
           have the library at all. -->
      {#if multi}
        <!-- ListField has no `paths` fan-out, and a stop edit that silently
             wrote only the primary would re-diverge a set the user just
             unified. Say so, beside the thing it gates, instead. -->
        <p class="paint-stops-multi-note">
          Gradient stops are edited one item at a time for now — select a single
          item to edit them. Direction{mode === "radialGradient" ? "/radius" : ""} below writes to all {writePaths.length}.
        </p>
      {:else}
        <ListField
          {app}
          decl={GRADIENT_STOPS_LIST}
          path={[...path, subKey, "stops"]}
          label={`${label} stop`}
          {disabled}
          seedElement={{ offset: 0, color: NEW_STOP_COLOR }}
        />
      {/if}
    </div>

    <!-- GEOMETRY -->
    {#if mode === "linearGradient"}
      <!-- DIRECTION — a continuous rotary dial (AngleField) in place of the old
           four ↑↓ preset buttons. It writes the paint's authoritative `angle`
           (writeDirection), as a degrees number or an "=" equation. -->
      <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
        <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">Direction</span>
        <AngleField
          {app}
          path={[...path, "linear", "angle"]}
          paths={writePaths.map((p) => [...p, "linear", "angle"])}
          label={`${label} direction`}
          value={linearAngle}
          {disabled}
          onpreview={previewDirection}
          oncommit={commitDirection}
        />
      </div>
      <!-- WAVELENGTH — the fraction of the box one full colour ramp spans (the
           on-canvas direction bead sets it too). 1 = the whole-box axis (today);
           below 1 the ramp mirror-tiles (render_gpu/ir.js linearGradientRender).
           A keyframable NumericField like the radial Radius, floored at
           GRADIENT_MIN_WAVELENGTH so the axis can't collapse. -->
      <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
        <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">Wavelength</span>
        <div style="width:var(--a-input-w);">
          <NumericField {app} path={[...path, "linear", "wavelength"]} paths={writePaths.map((p) => [...p, "linear", "wavelength"])} label={`${label} wavelength`} min={GRADIENT_MIN_WAVELENGTH} scrub={FRACTION_SCRUB} />
        </div>
      </div>
    {:else}
      <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
        <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">Radius</span>
        <div style="width:var(--a-input-w);">
          <NumericField {app} path={[...path, "radial", "r"]} paths={writePaths.map((p) => [...p, "radial", "r"])} label={`${label} radius`} min={0} scrub={FRACTION_SCRUB} />
        </div>
      </div>
    {/if}
  {/if}
</div>
