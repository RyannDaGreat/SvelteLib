<!--
  ShapePicker — a visual GRID of preset shapes beside "Add Rectangle" (Wave 2).
  Selecting a tile arms crosshair placement for a `shape` widget with that preset
  (the SAME placement gesture every Add button uses — the next canvas click/drag
  places it), so this is just another surfacing of the shape plugin's placement.
  Each tile previews the REAL generator output (core/shapes.js) as an inline SVG,
  so the grid always matches what gets drawn. No <style> block — all styling is
  in app.css via --a-* tokens (annotator convention).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { SHAPE_NAMES, SHAPE_LABELS, shapePath } from "../core/shapes.js";

  let { app } = $props();
  let open = $state(false);

  // One preview `d` per preset in a 100×100 viewBox — the exact generator the
  // widget renders, so a tile is a faithful thumbnail (built once, pure).
  const previews = SHAPE_NAMES.map((name) => ({ name, label: SHAPE_LABELS[name], d: shapePath(name, 100, 100) }));

  /** Command. Arms crosshair placement for `name`. A defaults-override copy of
   * the registered shape plugin — the SAME plugin surface CanvasView.placementUp
   * reads (.defaults + .placement) — so placement is fully generic. */
  function pick(name) {
    const plugin = app.registry.get("shape");
    app.armCrosshairPlacement({ ...plugin, defaults: { ...plugin.defaults, shape: name } });
    open = false;
  }

  // Lightweight popover: close on outside pointerdown or Escape.
  function onWindowPointerDown(e) {
    if (!e.target.closest(".shape-picker")) open = false;
  }
  function onWindowKeydown(e) {
    if (e.key === "Escape") open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="shape-picker">
  <Tooltip text="Add Shape (star, polygon, arrow, heart, …)">
    <button
      class="btn-icon"
      class:active={open}
      aria-label="Add Shape"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <iconify-icon icon="mdi:shape-plus" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  {#if open}
    <div class="shape-picker-grid" role="menu" aria-label="Preset shapes">
      {#each previews as s}
        <button
          class="shape-tile"
          role="menuitem"
          aria-label={"Add " + s.label}
          onclick={() => pick(s.name)}
        >
          <svg class="shape-tile-svg" viewBox="-6 -6 112 112" aria-hidden="true">
            <path d={s.d} />
          </svg>
          <span class="shape-tile-label">{s.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
