<!--
  ShapePicker — a visual GRID of preset shapes beside "Add Rectangle" (Wave 2).
  The headline "shapeshifter" family tiles are a PROJECTION of the command
  registry's `insert-shape` submenu (its `children`, built from FAMILIES in
  web/App.svelte) — so this toolbar popover and the command palette read the
  SAME single source of truth. Each tile previews the child's `shapePreview`
  (the family generator at its default seed) and clicking it runs the child
  command (MRU-tracked, exactly like the palette). The legacy fixed presets
  below still come from the local `shape` plugin. No <style> block — all styling
  is in app.css via --a-* tokens (annotator convention).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { SHAPE_NAMES, SHAPE_LABELS, shapePath } from "../core/shapes.js";

  let { app } = $props();
  let open = $state(false);

  // SHAPESHIFTER families first (the headline power shapes): the children of the
  // single `insert-shape` submenu command. Lazily read (only when the popover
  // opens) so it stays loud-if-missing without gating boot on registration.
  let familyItems = $derived(app.commands.get("insert-shape").children);

  // Legacy fixed presets (the original shape widget) below the families.
  const previews = SHAPE_NAMES.map((name) => ({ name, label: SHAPE_LABELS[name], d: shapePath(name, 100, 100) }));

  /** Command. Arms crosshair placement for `name`. A defaults-override copy of
   * the registered shape plugin — the SAME plugin surface CanvasView.placementUp
   * reads (.defaults + .placement) — so placement is fully generic. */
  function pick(name) {
    const plugin = app.registry.get("shape");
    app.armCrosshairPlacement({ ...plugin, defaults: { ...plugin.defaults, shape: name } });
    open = false;
  }

  // Lightweight popover: close on outside pointerdown — a press we are not the
  // target of is only visible from a global listener, so this one stays at the
  // window (the same split Dropdown.svelte makes: document listener for the
  // outside press, element handler for the keys).
  function onWindowPointerDown(e) {
    if (!e.target.closest(".shape-picker")) open = false;
  }
  /** Command. Escape closes the popup and is CONSUMED, so it does not ALSO
   * bubble into Deselect — the ColorField/Dropdown precedent, and the reason
   * this is bound to the picker's own root rather than the window: the keystroke
   * belongs to the focused widget (the trigger button and every tile live inside
   * `.shape-picker`), and its effect is confined to it. */
  function onKeydown(e) {
    if (e.key === "Escape" && open) {
      open = false;
      e.stopPropagation();
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="shape-picker" data-hint-popover={open ? "menu" : null} onkeydown={onKeydown}>
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
      {#each familyItems as c}
        <button
          class="shape-tile"
          role="menuitem"
          aria-label={c.title}
          onclick={() => { app.runCommand(c.id); open = false; }}
        >
          <svg class="shape-tile-svg" viewBox="-6 -6 112 112" aria-hidden="true">
            <path d={c.shapePreview.d} fill-rule={c.shapePreview.fillRule} />
          </svg>
          <span class="shape-tile-label">{c.title}</span>
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
