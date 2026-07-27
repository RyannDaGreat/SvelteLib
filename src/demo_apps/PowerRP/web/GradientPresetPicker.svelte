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

  HOVERING a swatch LIVE-PREVIEWS its gradient on the selected item, mirroring
  ToolsPane's preset card grid: each pointerenter overwrites the last preview, and
  leaving the GRID (not each swatch — moving between neighbours must not flicker
  a revert) cancels it. The picker owns no document write of its own: it hands
  the stop list to the callbacks, and the mount point (PaintField) stages it
  through app.setPreview / app.cancelPreview, so the document is never mutated
  and no undo entry is created until a click commits.

  No <style> block (web/ app convention): classes live in app.css
  (.gradient-presets / .gradient-swatch / … via --a-* tokens). Each swatch's
  gradient is DATA, not a design token, so it is passed as the --gp-swatch custom
  property exactly like ColorField passes its swatch color as --cf-swatch.

  Props: onpick(stops) — called with a fresh {offset, color}[] stop list when a
  preset is chosen; onpreview(stops) — the same list, staged as a live preview
  while a swatch is hovered; oncancelpreview() — revert that preview; disabled —
  greys out the toggle. The two preview callbacks are optional and guarded at the
  call site, following the sibling AngleField's onpreview/oncommit convention.
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
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { onpick, onpreview = null, oncancelpreview = null, disabled = false } = $props();

  let open = $state(false);
  let query = $state("");
  let searchEl = $state(null);
  let bodyEl = $state(null);

  let filtered = $derived(filterPresets(GRADIENT_PRESETS, query));

  /**
   * Pure function. A FRESH copy of a preset's stops — never the shared preset
   * object, so neither the document nor a preview can alias author-time data.
   *
   * @param {{stops:{offset:number,color:string}[]}} preset
   * @returns {{offset:number,color:string}[]}
   *
   * @example freshStops({name:"x", stops:[{offset:0,color:"#000000"}]}) // [{offset:0, color:"#000000"}]
   */
  function freshStops(preset) {
    return preset.stops.map((s) => ({ offset: s.offset, color: s.color }));
  }

  /** Command. Reverts the hover preview (the mount point restores what the
   * document actually holds). Safe to call when nothing is staged. */
  function cancelPreview() {
    if (oncancelpreview) oncancelpreview();
  }

  /** Command. Collapses the library, clears the search, and reverts any hover
   * preview — the grid can unmount with the pointer still over a swatch, which
   * fires no pointerleave, so the revert must not depend on one. */
  function close() {
    open = false;
    query = "";
    cancelPreview();
  }

  /** Command. Toggles the library open/closed; a fresh open starts unfiltered. */
  function toggle() {
    if (disabled) return;
    if (open) close();
    else open = true;
  }

  /** Command. Live-previews `preset` on the selected item WITHOUT committing:
   * the mount point stages the stops into app.previewDelta, so the viewport
   * renders them while the document stays untouched and no undo entry is
   * created. The next hover overwrites it; leaving the grid reverts it. */
  function preview(preset) {
    if (disabled || !onpreview) return;
    onpreview(freshStops(preset));
  }

  /** Command. Applies a preset durably (one undo unit, via onpick) and collapses
   * the library. The commit consumes the staged preview, so close()'s revert is
   * a no-op here — it only guards the unmount-without-pointerleave case. */
  function pick(preset) {
    onpick(freshStops(preset));
    close();
  }

  /** Escape closes the library (mirrors ColorField's inline picker); stops
   * propagation so it doesn't also bubble into Deselect. */
  function onKeydown(e) {
    if (e.key === "Escape" && open) {
      close();
      e.stopPropagation();
    }
  }

  // On open: focus the search field so typing filters at once, and scroll the
  // revealed body into view. The Inspector pane SCROLLS, and this field sits far
  // down a long property list, so a library opened near the fold would otherwise
  // have its bottom rows cut off by the pane edge. `block: "nearest"` scrolls the
  // minimum needed (the EquationSuggest / CommandPalette scrollIntoView idiom).
  $effect(() => {
    if (!open || !searchEl || !bodyEl) return;
    searchEl.focus();
    bodyEl.scrollIntoView({ block: "nearest" });
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
    <div class="gradient-presets-body" bind:this={bodyEl}>
      <input
        class="gradient-presets-search"
        type="text"
        placeholder="Search presets…"
        aria-label="Search gradient presets"
        bind:this={searchEl}
        bind:value={query}
      />
      <!-- pointerleave on the GRID (not each swatch) reverts only when the
           pointer leaves the tiles entirely; moving BETWEEN swatches fires each
           one's pointerenter, overwriting the preview without a revert between
           them (the ToolsPane preset card-grid precedent). -->
      <div
        class="gradient-presets-grid"
        role="listbox"
        aria-label="Gradient presets"
        tabindex="-1"
        onpointerleave={cancelPreview}
      >
        {#each filtered as p (p.name)}
          <Tooltip text={p.name}>
            <button
              type="button"
              class="gradient-swatch"
              role="option"
              aria-selected="false"
              aria-label={p.name}
              style:--gp-swatch={cssGradientFromStops(p.stops)}
              onpointerenter={() => preview(p)}
              onclick={() => pick(p)}
            ></button>
          </Tooltip>
        {:else}
          <div class="gradient-presets-empty">No presets match</div>
        {/each}
      </div>
    </div>
  {/if}
</div>
