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
  import { SHAPE_NAMES, SHAPE_LABELS, shapePath, subpathsPathD } from "../core/shapes.js";
  import { FAMILIES } from "../plugins/shapeshifter.js";

  let { app } = $props();
  let open = $state(false);

  // SHAPESHIFTER families first (the headline power shapes): each tile previews
  // the family's own generator at its default seed in a 100×100 viewBox, so it
  // matches what gets placed. `fillRule` shows a ring/frame/gear hole.
  const familyPreviews = FAMILIES.map((fam) => ({
    type: fam.type, label: fam.title,
    d: subpathsPathD(fam.outline({ ...fam.defaults, w: 100, h: 100 })),
    fillRule: fam.fillRule ?? "nonzero",
  }));

  // Legacy fixed presets (the original shape widget) below the families.
  const previews = SHAPE_NAMES.map((name) => ({ name, label: SHAPE_LABELS[name], d: shapePath(name, 100, 100) }));

  /** Command. Arms crosshair placement for a SHAPESHIFTER family — the SAME
   * generic placement gesture, arming that family's registered plugin. */
  function pickFamily(type) {
    app.armCrosshairPlacement(app.registry.get(type));
    open = false;
  }

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
      {#each familyPreviews as s}
        <button
          class="shape-tile"
          role="menuitem"
          aria-label={"Add " + s.label}
          onclick={() => pickFamily(s.type)}
        >
          <svg class="shape-tile-svg" viewBox="-6 -6 112 112" aria-hidden="true">
            <path d={s.d} fill-rule={s.fillRule} />
          </svg>
          <span class="shape-tile-label">{s.label}</span>
        </button>
      {/each}
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
