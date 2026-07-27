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

  KNOWN BOUND: an EQUATION typed into a stop offset/color (a leading "=") is not
  evaluated — list elements are not equation slots (core leaves() keeps arrays
  opaque for equation detection), so parsePaint reports it loudly rather than
  silently. Gradient geometry (linear direction / radial radius) is edited here;
  radius is a NumericField (keyframable), direction is a 4-way preset.

  Props mirror ColorField: app, path (["items", id, "fill"|"stroke"]), label,
  value (the raw stored paint — string or multi-sub-state object), disabled.
  Styling: inline styles over existing app.css --a-*/--fg/--border tokens (this
  field adds no app.css classes; the house token convention is preserved).
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
  import KeyframeControls from "./KeyframeControls.svelte";
  import GradientPresetPicker from "./GradientPresetPicker.svelte";
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
  // The active stop list. A non-array here means the fold produced a corrupt
  // (numeric-keyed object) stops value — a LOUD signal of a delta/fold bug, NOT
  // something to silently coerce: report it and render no stops rather than
  // exploding (`[...stops]`). With array-aware setPath this should never fire.
  let stops = $derived.by(() => {
    if (mode === "solid" || mode === "equation") return [];
    const s = sub[subKey]?.stops;
    if (Array.isArray(s)) return s;
    console.error(`PaintField: ${subKey} gradient "stops" is not an array (delta/fold bug) — got ${JSON.stringify(s)}`);
    return [];
  });
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

  /** Command. Appends a stop (white at offset 1) to the active gradient — a
   * whole-list write (length change). The user drags its offset afterward. */
  function addStop() {
    commitAt([subKey, "stops"], [...stops, { offset: 1, color: NEW_STOP_COLOR }]);
  }

  /** Command. Removes stop `i` (kept >= 2 — a gradient needs two stops). */
  function removeStop(i) {
    if (stops.length <= 2) return;
    commitAt([subKey, "stops"], stops.filter((_, j) => j !== i));
  }

  /** Command. Replaces the active gradient's stops with a preset's (from the
   * GradientPresetPicker — a baked rp gradient). One whole-list write, one undo
   * unit. Geometry (angle / center+radius) is untouched; only the color ramp
   * changes. */
  function applyPreset(presetStops) {
    if (disabled) return;
    commitAt([subKey, "stops"], presetStops);
  }

  // The linear DIRECTION as a heading in DEGREES — the authoritative stored
  // `angle` if present, else derived from the from/to endpoints (old, un-migrated
  // docs) so the dial always reflects what actually renders.
  let linearAngle = $derived(
    sub.linear.angle != null ? sub.linear.angle
      : sub.linear.from && sub.linear.to ? linearEndpointsToAngle(sub.linear.from, sub.linear.to)
      : GRADIENT_DEFAULT_ANGLE,
  );

  /** Command. Writes the linear DIRECTION from a dial heading (degrees): ONLY
   * the authoritative `angle` — the single source of truth. The renderer derives
   * the objectBoundingBox from/to endpoints from it (render_gpu/ir.js linearAxis),
   * so keyframing the angle tweens as a ROTATING axis rather than lerping endpoints
   * through a degenerate midpoint. `commit` settles it as one undo unit; otherwise
   * it is a live preview (viewport re-renders while the user drags the dial). */
  function writeDirection(deg, commit) {
    app.setPreview([[[...path, "linear", "angle"], deg]]);
    if (commit) app.commitPreview();
  }
  const previewDirection = (deg) => writeDirection(deg, false);
  const commitDirection = (deg) => writeDirection(deg, true);

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
               color:var(--fg); border:1px solid var(--border); border-radius:var(--radius);
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
      style="width:100%; box-sizing:border-box; font-family:var(--a-font-mono, monospace); font-size:var(--a-font-sm);
             color:var(--fg); background:transparent; border:1px solid var(--border); border-radius:var(--radius);
             padding:var(--a-sp-1) var(--a-sp-2);"
    />
  {:else}
    <!-- STOPS — each row: ColorField (standard) + NumericField offset (scrubber)
         + per-slot ◆ KeyframeControls + remove. All operate on real state paths
         (…stops.<i>.color / .offset), so each keyframes + tweens independently. -->
    <div style="display:flex; flex-direction:column; gap:var(--a-sp-2);">
      {#each stops as stop, i (i)}
        <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
          <div style="flex:1.4; min-width:0;">
            <ColorField
              {app}
              path={[...path, subKey, "stops", i, "color"]}
              label={`${label} stop ${i + 1} color`}
              value={stop.color}
              {disabled}
            />
          </div>
          <div style="flex:1; min-width:0;">
            <NumericField
              {app}
              path={[...path, subKey, "stops", i, "offset"]}
              label={`${label} stop ${i + 1} offset`}
              min={0}
              max={1}
            />
          </div>
          <span style="display:inline-flex; align-items:center;">
            <KeyframeControls {app} path={[...path, subKey, "stops", i]} />
          </span>
          <button
            type="button" aria-label="Remove stop" title="Remove stop"
            disabled={disabled || stops.length <= 2}
            onclick={() => removeStop(i)}
            style="color:var(--fg-dim); background:transparent; border:none; cursor:pointer; padding:0 var(--a-sp-1);"
          >×</button>
        </div>
      {/each}
      <button
        type="button" {disabled} onclick={addStop}
        style="align-self:flex-start; font-size:var(--a-font-sm); color:var(--fg-dim); background:transparent;
               border:1px dashed var(--border); border-radius:var(--radius); padding:var(--a-sp-1) var(--a-sp-2); cursor:pointer;"
      >+ Add stop</button>

      <!-- PRESET LIBRARY — a tiled grid of gradient swatches (baked from rp's
           gradient library). Picking one replaces the stops above. -->
      <GradientPresetPicker {disabled} onpick={applyPreset} />
    </div>

    <!-- GEOMETRY -->
    {#if mode === "linearGradient"}
      <!-- DIRECTION — a continuous rotary dial (AngleField) in place of the old
           four ↑↓ preset buttons. It writes the paint's authoritative `angle`
           plus the from/to render projection together (writeDirection). -->
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
        <div style="width:80px;">
          <NumericField {app} path={[...path, "radial", "r"]} label={`${label} radius`} min={0} />
        </div>
      </div>
    {/if}
  {/if}
</div>
