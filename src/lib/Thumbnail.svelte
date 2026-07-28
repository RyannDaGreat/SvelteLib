<!--
  Thumbnail [visual, general] — an image tile that fills its grid cell.

  Deliberately dumb about its own size: it stretches to fill whatever cell the
  parent grid gives it (`width/height: 100%`) and covers it with the image. The
  CELL SHAPE is the grid's job — and the grid must give it a DEFINITE size
  (definite column width AND `grid-auto-rows`), because anything that makes the
  tile's height depend on its width (aspect-ratio on the tile, percentage chains)
  hits a grid row-sizing cycle that collapses the row to ~0 — tiles vanish and
  the list never scrolls. Definite rows = no cycle = square tiles that scroll.

  Themeable via --thumb-* custom properties.

  Usage (parent grid sets a square cell, e.g. grid-auto-rows = column width):
    <Thumbnail src={url} badge="0:14" ring="current" title={name} onclick={...} />
-->
<script>
  let {
    /** @type {string} Image URL (cover-fit into the square). */
    src = "",
    /** @type {string} Small corner badge, e.g. a duration. */
    badge = "",
    /** @type {'none'|'comment'|'current'} Ring color, or none. */
    ring = "none",
    /** @type {string} */
    title = "",
    /** @type {(e: Event) => void} */
    onclick = () => {},
  } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="thumb ring-{ring}"
  role="button"
  tabindex="0"
  data-hint-scope="tile"
  {title}
  {onclick}
  onkeydown={(e) => e.key === "Enter" && onclick(e)}
>
  {#if src}<img class="img" {src} alt="" loading="lazy" />{/if}
  {#if badge}<span class="badge">{badge}</span>{/if}
</div>

<style>
  .thumb {
    /* Fills the grid cell the parent gives it (the grid sets the square shape). */
    display: block;
    width: 100%;
    height: 100%;
    position: relative;
    border-radius: var(--thumb-radius, 4px);
    background: black;
    overflow: hidden;
    cursor: pointer;
  }
  .img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover; /* crop the (landscape) frame to fill the cell */
  }
  /* Ring drawn on a ::after overlay so it sits ON TOP of the image (an inset
     box-shadow on .thumb itself paints UNDER the child <img> and is invisible).
     Inset, so it never affects layout or bleeds into the grid gap. */
  .thumb::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 var(--thumb-ring-width, 2px) var(--thumb-ring, transparent);
    pointer-events: none;
  }
  .ring-comment {
    --thumb-ring: var(--thumb-ring-comment, #e3b341);
  }
  .ring-current {
    --thumb-ring: var(--thumb-ring-current, #00ffff);
  }
  .badge {
    position: absolute;
    right: var(--thumb-badge-pad, 4px);
    bottom: var(--thumb-badge-pad, 4px);
    padding: 1px var(--thumb-badge-pad, 4px);
    background: var(--thumb-badge-bg, rgba(0, 0, 0, 0.75));
    color: white;
    font-size: var(--thumb-badge-fs, 0.7rem);
    border-radius: var(--thumb-badge-radius, 3px);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
</style>
