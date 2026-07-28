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
  import { linearEndpointsToAngle, GRADIENT_DEFAULT_ANGLE } from "../core/properties.js";
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
   * @example freshLinear("#f00").stops.length // 2
   * @example freshLinear("#f00").angle // 0
   * @example freshLinear("#f00").from // undefined (endpoints derived from angle at render time)
   */
  export function freshLinear(seed) {
    return { stops: [{ offset: 0, color: seed }, { offset: 1, color: NEW_STOP_COLOR }], angle: GRADIENT_DEFAULT_ANGLE };
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
    return { type, solid, linear, radial };
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
  import ColorField from "./ColorField.svelte";
  import NumericField from "./NumericField.svelte";
  import AngleField from "./AngleField.svelte";
  import ListField from "./ListField.svelte";
  import { GRADIENT_STOPS_LIST } from "../core/properties.js";
  import { getPath } from "../core/deltas.js";

  let { app, path, label, value, disabled = false } = $props();

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

  /** Command. Commits the WHOLE paint object to `path` (one undo unit) — used
   * only when the stored value must be MATERIALIZED into the object form. */
  function commitWhole(paint) {
    app.setPreview([[path, paint]]);
    app.commitPreview();
  }

  /** Command. Commits a value at a SUB-PATH of the paint (one undo unit) — the
   * minimal-delta write for type flips, stop add/remove, and geometry. */
  function commitAt(subpath, val) {
    app.setPreview([[[...path, ...subpath], val]]);
    app.commitPreview();
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
    app.setPreview([[[...path, "linear", "angle"], heading]]);
    if (commit) app.commitPreview();
  }
  const previewDirection = (heading) => writeDirection(heading, false);
  const commitDirection = (heading) => writeDirection(heading, true);

  const TYPES = [
    { id: "solid", label: "Solid" },
    { id: "linearGradient", label: "Linear" },
    { id: "radialGradient", label: "Radial" },
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
      <ColorField {app} {path} {label} value={raw} {disabled} />
    {:else}
      <ColorField {app} path={[...path, "solid"]} label={`${label} color`} value={sub.solid} {disabled} />
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
      <ListField
        {app}
        decl={GRADIENT_STOPS_LIST}
        path={[...path, subKey, "stops"]}
        label={`${label} stop`}
        {disabled}
        seedElement={{ offset: 0, color: NEW_STOP_COLOR }}
      />
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
          label={`${label} direction`}
          value={linearAngle}
          {disabled}
          onpreview={previewDirection}
          oncommit={commitDirection}
        />
      </div>
    {:else}
      <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
        <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">Radius</span>
        <div style="width:var(--a-input-w);">
          <NumericField {app} path={[...path, "radial", "r"]} label={`${label} radius`} min={0} />
        </div>
      </div>
    {/if}
  {/if}
</div>
