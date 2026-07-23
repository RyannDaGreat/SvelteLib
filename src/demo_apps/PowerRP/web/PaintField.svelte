<!--
  PaintField — the Axis-1 PAINT property field for fill/stroke rows. A paint is
  polymorphic (render_gpu/ir.js parsePaint): a SOLID color string, or a LINEAR /
  RADIAL gradient object {type, stops:[{offset,color}], from/to | center/r}. This
  field is the editor for that union:

    • SOLID  → delegates to ColorField verbatim (the proven swatch+picker+alpha
               control) — so a solid fill/stroke behaves EXACTLY as before and a
               document that never touches a gradient never changes shape.
    • LINEAR / RADIAL → a compact, FUNCTIONAL stop editor: pick the type, add /
               remove color stops, set each stop's offset (0..1) and hex color,
               and choose a direction (linear) or radius (radial). Any edit
               commits the WHOLE gradient object to `path` as ONE undo unit
               (app.setPreview + commitPreview — the same house commit contract
               ColorField uses), so it keyframes like any other color leaf.

  Not-polished-by-design (the task brief): stop colors are hex text inputs (no
  per-stop picker), direction is a 4-way preset, radial center is fixed at the
  bbox center. The RENDER path (Skia shader + SVG/PDF export) is the polished
  half; this is the minimum viable authoring surface over it.

  Props mirror ColorField: app, path (["items", id, "fill"|"stroke"]), label,
  value (the raw stored paint — string or gradient object), disabled.
  Styling: inline styles over existing app.css --a-*/--fg/--border tokens (this
  field adds no app.css classes; the house token convention is preserved).
-->
<script module>
  const DEFAULT_SOLID = "#7aa2f7";

  /**
   * Pure function. The paint's mode id: "solid" for a string / null / rgba array,
   * else the gradient object's own type ("linearGradient" | "radialGradient").
   *
   * @example paintMode("#f00") // "solid"
   * @example paintMode(null) // "solid"
   * @example paintMode({type: "linearGradient"}) // "linearGradient"
   */
  export function paintMode(value) {
    if (value && typeof value === "object" && !Array.isArray(value) && value.type) return value.type;
    return "solid";
  }

  /**
   * Pure function. A representative solid hex for a paint (its value if solid, its
   * first stop if a gradient, DEFAULT_SOLID if empty) — used when switching a
   * gradient back to solid, or seeding a new gradient's stops.
   *
   * @example firstSolid("#abc") // "#abc"
   * @example firstSolid({type: "linearGradient", stops: [{offset: 0, color: "#123"}]}) // "#123"
   * @example firstSolid(null) // "#7aa2f7"
   */
  export function firstSolid(value) {
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object" && Array.isArray(value.stops) && value.stops[0]) return value.stops[0].color;
    return DEFAULT_SOLID;
  }

  /**
   * Pure function. Builds a fresh gradient object of `type` seeded from a solid
   * color: two stops (the solid → white) and a default geometry (linear = a
   * left→right sweep; radial = centered, r 0.5, objectBoundingBox space).
   *
   * @example freshGradient("linearGradient", "#f00").stops.length // 2
   * @example freshGradient("linearGradient", "#f00").from // {x: 0, y: 0}
   * @example freshGradient("radialGradient", "#f00").center // {x: 0.5, y: 0.5}
   */
  export function freshGradient(type, seedColor) {
    const stops = [{ offset: 0, color: seedColor }, { offset: 1, color: "#ffffff" }];
    if (type === "radialGradient") return { type, stops, center: { x: 0.5, y: 0.5 }, r: 0.5 };
    return { type, stops, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
  }

  // Linear direction presets (objectBoundingBox from→to), keyed by an arrow glyph.
  export const LINEAR_DIRECTIONS = [
    { icon: "→", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { icon: "↓", from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
    { icon: "↘", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    { icon: "↗", from: { x: 0, y: 1 }, to: { x: 1, y: 0 } },
  ];
</script>

<script>
  import ColorField from "./ColorField.svelte";

  let { app, path, label, value, disabled = false } = $props();

  let mode = $derived(paintMode(value));
  let grad = $derived(mode === "solid" ? null : value);

  /** Command. Commits a paint value (string or gradient object) to `path` as one
   * undo unit — the ColorField preview+commit contract. */
  function commit(paint) {
    app.setPreview([[path, paint]]);
    app.commitPreview();
  }

  /** Command. Switches the paint mode, seeding a gradient from the current solid
   * (or collapsing a gradient back to its first stop). */
  function setMode(next) {
    if (disabled || next === mode) return;
    if (next === "solid") commit(firstSolid(value));
    else commit(freshGradient(next, firstSolid(value)));
  }

  /** Command. Re-commits `grad` with `patch` shallow-merged (geometry edits). */
  function patchGrad(patch) {
    commit({ ...grad, ...patch });
  }

  /** Command. Replaces stop `i` with the given partial ({offset?, color?}). */
  function editStop(i, partial) {
    const stops = grad.stops.map((s, j) => (j === i ? { ...s, ...partial } : s));
    patchGrad({ stops });
  }

  /** Command. Appends a stop at offset 1 (white), so the list always grows in a
   * predictable place; the user drags its offset afterward. */
  function addStop() {
    patchGrad({ stops: [...grad.stops, { offset: 1, color: "#ffffff" }] });
  }

  /** Command. Removes stop `i` (kept >= 2 — a gradient needs two stops). */
  function removeStop(i) {
    if (grad.stops.length <= 2) return;
    patchGrad({ stops: grad.stops.filter((_, j) => j !== i) });
  }

  const TYPES = [
    { id: "solid", label: "Solid" },
    { id: "linearGradient", label: "Linear" },
    { id: "radialGradient", label: "Radial" },
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
    <ColorField {app} {path} {label} {value} {disabled} />
  {:else}
    <!-- STOPS -->
    <div style="display:flex; flex-direction:column; gap:var(--a-sp-1);">
      {#each grad.stops as stop, i}
        <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
          <span style="width:var(--a-color-swatch, 18px); height:var(--a-color-swatch, 18px); border:1px solid var(--border);
                       border-radius:var(--radius); background:{stop.color};"></span>
          <input
            type="number" min="0" max="1" step="0.05" value={stop.offset} {disabled}
            onchange={(e) => editStop(i, { offset: Math.max(0, Math.min(1, Number(e.target.value))) })}
            style="width:52px; font-size:var(--a-font-sm); color:var(--fg); background:transparent;
                   border:1px solid var(--border); border-radius:var(--radius);"
          />
          <input
            type="text" value={stop.color} {disabled} spellcheck="false"
            onchange={(e) => editStop(i, { color: e.target.value })}
            style="flex:1; min-width:0; font-size:var(--a-font-sm); color:var(--fg); background:transparent;
                   border:1px solid var(--border); border-radius:var(--radius);"
          />
          <button
            type="button" aria-label="Remove stop" title="Remove stop"
            disabled={disabled || grad.stops.length <= 2}
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
    </div>

    <!-- GEOMETRY -->
    {#if mode === "linearGradient"}
      <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
        <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">Direction</span>
        {#each LINEAR_DIRECTIONS as d}
          <button
            type="button" {disabled}
            aria-pressed={grad.from?.x === d.from.x && grad.from?.y === d.from.y && grad.to?.x === d.to.x && grad.to?.y === d.to.y}
            onclick={() => patchGrad({ from: d.from, to: d.to })}
            style="width:var(--a-control-h, 22px); font-size:var(--a-font-md); color:var(--fg); cursor:pointer;
                   border:1px solid var(--border); border-radius:var(--radius);
                   background:{grad.from?.x === d.from.x && grad.from?.y === d.from.y && grad.to?.x === d.to.x && grad.to?.y === d.to.y ? 'var(--a-hover-bg)' : 'transparent'};"
          >{d.icon}</button>
        {/each}
      </div>
    {:else}
      <div style="display:flex; align-items:center; gap:var(--a-sp-2);">
        <span style="font-size:var(--a-font-sm); color:var(--fg-dim);">Radius</span>
        <input
          type="number" min="0" max="1.5" step="0.05" value={grad.r} {disabled}
          onchange={(e) => patchGrad({ r: Math.max(0, Number(e.target.value)) })}
          style="width:64px; font-size:var(--a-font-sm); color:var(--fg); background:transparent;
                 border:1px solid var(--border); border-radius:var(--radius);"
        />
      </div>
    {/if}
  {/if}
</div>
