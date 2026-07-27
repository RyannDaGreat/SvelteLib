<!--
  GradientPresetPicker — a Photoshop-style TILED LIBRARY of gradient presets for
  the gradient stop editor. A "Preset library" toggle reveals a searchable grid
  of little gradient swatches; clicking one REPLACES the current gradient's stops
  with that preset's (via the onpick callback). The presets are baked from the
  `rp` Python library's gradient library (web/gradient_presets.js — 343 named
  gradients), so no runtime python dependency exists.

  WHY inline expansion (not a floating popover): this field lives in the
  Inspector, whose scroll/overflow would clip an absolutely-positioned popover —
  the same reason ColorField expands inline. The revealed grid lives in the
  panel's own flow (it can't be clipped or mispositioned) and simply pushes the
  rows below it down; the panel scrolls. The grid itself is height-capped and
  scrolls internally so a 343-swatch library never runs off the panel.

  No <style> block (web/ app convention): classes live in app.css
  (.gradient-presets / .gradient-swatch / … via --a-* tokens). Each swatch's
  gradient is DATA, not a design token, so it is passed as the --gp-swatch custom
  property exactly like ColorField passes its swatch color as --cf-swatch.

  Props: onpick(stops) — called with a fresh {offset, color}[] stop list when a
  preset is chosen; disabled — greys out the toggle.
-->
<script module>
  import { GRADIENT_PRESETS } from "./gradient_presets.js";

  const PERCENT = 100; // stop offsets are 0..1; CSS gradient stops are 0..100%

  /**
   * Pure function. A CSS linear-gradient() preview string for a stop list, with
   * each stop's ABSOLUTE offset (0..1) mapped to a percentage. Used both for the
   * swatch tiles and could preview any gradient at a glance.
   *
   * @param {{offset:number,color:string}[]} stops - ordered stops, offsets in [0,1]
   * @returns {string} a CSS `linear-gradient(...)` value
   *
   * @example cssGradientFromStops([{offset:0,color:"#000000"},{offset:1,color:"#ffffff"}]) // "linear-gradient(90deg, #000000 0%, #ffffff 100%)"
   * @example cssGradientFromStops([{offset:0,color:"#833ab4"},{offset:0.5,color:"#fd1d1d"},{offset:1,color:"#fcb045"}]) // "linear-gradient(90deg, #833ab4 0%, #fd1d1d 50%, #fcb045 100%)"
   */
  export function cssGradientFromStops(stops) {
    const parts = stops.map((s) => `${s.color} ${+(s.offset * PERCENT).toFixed(2)}%`);
    return `linear-gradient(90deg, ${parts.join(", ")})`;
  }

  /**
   * Pure function. Case-insensitive substring filter over presets by name. An
   * empty/blank query returns the full list unchanged.
   *
   * @param {{name:string}[]} presets
   * @param {string} query
   * @returns {{name:string}[]}
   *
   * @example filterPresets([{name:"sunset"},{name:"ocean"}], "sun").length // 1
   * @example filterPresets([{name:"sunset"},{name:"ocean"}], "  ").length // 2
   */
  export function filterPresets(presets, query) {
    const q = query.trim().toLowerCase();
    return q ? presets.filter((p) => p.name.toLowerCase().includes(q)) : presets;
  }
</script>

<script>
  import "iconify-icon";

  let { onpick, disabled = false } = $props();

  let open = $state(false);
  let query = $state("");
  let searchEl = $state(null);

  let filtered = $derived(filterPresets(GRADIENT_PRESETS, query));

  /** Command. Toggles the library open/closed; a fresh open starts unfiltered. */
  function toggle() {
    if (disabled) return;
    open = !open;
    if (!open) query = "";
  }

  /** Command. Applies a preset: hands a FRESH copy of its stops to onpick (never
   * the shared preset object, so the document can't alias author-time data) and
   * collapses the library. */
  function pick(preset) {
    onpick(preset.stops.map((s) => ({ offset: s.offset, color: s.color })));
    open = false;
    query = "";
  }

  /** Escape closes the library (mirrors ColorField's inline picker); stops
   * propagation so it doesn't also bubble into Deselect. */
  function onKeydown(e) {
    if (e.key === "Escape" && open) {
      open = false;
      query = "";
      e.stopPropagation();
    }
  }

  // Focus the search field the moment the library opens, so typing filters at once.
  $effect(() => {
    if (open && searchEl) searchEl.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gradient-presets" onkeydown={onKeydown}>
  <button
    type="button"
    class="gradient-presets-toggle"
    {disabled}
    aria-expanded={open}
    onclick={toggle}
  >
    <iconify-icon icon="mdi:gradient-horizontal" width="14" height="14"></iconify-icon>
    <span>Preset library</span>
    <iconify-icon class="gradient-presets-caret" icon="mdi:menu-down" width="14" height="14"></iconify-icon>
  </button>

  {#if open}
    <div class="gradient-presets-body">
      <input
        class="gradient-presets-search"
        type="text"
        placeholder="Search presets…"
        aria-label="Search gradient presets"
        bind:this={searchEl}
        bind:value={query}
      />
      <div class="gradient-presets-grid" role="listbox" aria-label="Gradient presets">
        {#each filtered as p (p.name)}
          <button
            type="button"
            class="gradient-swatch"
            role="option"
            aria-selected="false"
            title={p.name}
            aria-label={p.name}
            style:--gp-swatch={cssGradientFromStops(p.stops)}
            onclick={() => pick(p)}
          ></button>
        {:else}
          <div class="gradient-presets-empty">No presets match</div>
        {/each}
      </div>
    </div>
  {/if}
</div>
