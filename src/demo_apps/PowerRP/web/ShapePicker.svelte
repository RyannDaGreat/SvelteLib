<!--
  ShapePicker — a visual GRID of shape families beside "Add Rectangle".

  ONE PICKER, ONE SYSTEM. Every tile is a PROJECTION of the `insert-shape` entry's
  `shapeMenu` — the list web/App.svelte DERIVES from the registered roster, one
  entry per plugin that declares `insertMenu: "shape"` (core/registry.js). This
  popover and the palette read that same list, so a new shape reaches both by
  saying so in its own plugin file.

  WHAT THAT REPLACED, because the old rule looked derived and was not the right
  one. The grid used to be the `insert-shape` submenu's `children`, built from
  `plugins/shapeshifter.js`'s FAMILIES table. That table IS derived — nobody was
  hand-listing tiles — but "is it a shapeshifter family" describes how a shape is
  BUILT, not what it is, so `aperture` and `iris_blades` (standalone plugins that
  draw shapes) could never appear here. The user's report: "New shapes that we add
  can go into the shape menu — Add Shape menu — but I don't see them there."

  TWO TILE KINDS, one row of markup. A widget that can draw its own silhouette
  supplies `shapePreview` and gets a path tile; one that cannot gets its command's
  ICON. That is what lets a shape join without owning a path generator, and it is
  why the fallback is not a placeholder box — the icon is a real, chosen glyph.
  Titles and icons come from the COMMAND entry in both cases, never transcribed.

  This grid USED TO carry a second row of tiles for the legacy `shape` plugin's
  17 baked presets, and that row was the bug: 15 of those presets ignored their
  own shapePoints/shapeInnerRatio knobs (an octagon at points=8 and points=5 were
  byte-identical), and none of them had on-canvas handles. A user clicking a tile
  had no way to tell which of the two systems they had just inserted — the
  parameters simply did nothing. The families cover every one of those
  silhouettes and are genuinely parametric, so the legacy row is gone and the
  legacy type is no longer insertable. Documents that already contain one still
  load and render it unchanged (tests/shape_legacy_freeze_test.js).

  No <style> block — all styling is in app.css via --a-* tokens (annotator
  convention).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { app } = $props();
  let open = $state(false);

  // Every shape the roster offers, each paired with the command that inserts it.
  // Lazily read (only when the popover opens) so it stays loud-if-missing without
  // gating boot on registration.
  let tiles = $derived(app.commands.get("insert-shape").shapeMenu);

  /** Query. The command entry a tile surfaces — its title and, for a tile with no
   *  silhouette, its glyph. Loud on an unknown id: a tile naming an unregistered
   *  command would draw a blank, unclickable square. */
  const entryOf = (tile) => app.commands.get(tile.commandId);

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
      {#each tiles as tile (tile.commandId)}
        {@const cmd = entryOf(tile)}
        <button
          class="shape-tile"
          role="menuitem"
          aria-label={cmd.title}
          onclick={() => { app.runCommand(tile.commandId); open = false; }}
        >
          {#if tile.shapePreview}
            <svg class="shape-tile-svg" viewBox="-6 -6 112 112" aria-hidden="true">
              <path d={tile.shapePreview.d} fill-rule={tile.shapePreview.fillRule} />
            </svg>
          {:else}
            <!-- No silhouette of its own: the command's own glyph, at the tile's
                 own art size, so the two kinds of tile are the same control.
                 SIZED INLINE OFF THE SAME TOKEN rather than through .shape-tile-svg,
                 which also sets fill/stroke/stroke-width — correct for a bare <path>
                 and wrong for a glyph (it would embolden every icon tile).
                 FONT-SIZE, NOT width/height — MEASURED, because the obvious way is
                 wrong here. `iconify-icon` renders an inner <svg> at 1em, so CSS
                 width/height sizes only the HOST box: the tiles measured a correct
                 40x40 while the glyph inside them drew at ~14px, top-aligned in an
                 empty square. Sizing by font-size makes the glyph itself the tile's
                 art size, which is what the path tiles do.
                 HANDBACK, web/app.css: this wants a `.shape-tile-icon { font-size:
                 var(--a-shape-tile-icon); }` beside .shape-tile-svg — it cannot
                 reuse that class, which also sets fill/stroke/stroke-width (right
                 for a bare <path>, and it would embolden every glyph). The inline
                 read is a token read, not a hardcoded size, and it is here only
                 because that file is contended. -->
            <iconify-icon
              icon={cmd.icon}
              aria-hidden="true"
              style="font-size: var(--a-shape-tile-icon)"
            ></iconify-icon>
          {/if}
          <span class="shape-tile-label">{cmd.title}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
