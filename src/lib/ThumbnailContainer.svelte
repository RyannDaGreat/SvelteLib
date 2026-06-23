<!--
  ThumbnailContainer [visual, general] — a responsive grid of equal, aspect-locked
  cells that BALLOON to fill the width (the largest cells >= minSize), stay exactly
  proportioned at every width, shrink evenly in a tiny container, and scroll on
  overflow. Whatever you render inside becomes the cells — they stretch to fill
  their square (or `aspect`-shaped) cell. Not thumbnail-specific; holds anything.

  Why there's JS here (and why this was painful to get right): pure CSS cannot do
  fill-to-width AND a locked aspect AND scroll at the same time. Flexible `1fr`
  columns make each cell's height depend on a width that depends back on the row,
  a cycle the browser breaks by collapsing the rows to ~0 — cells vanish and the
  list never scrolls. And `repeat(auto-fill, <size>)` leaves a leftover empty
  column at some widths (sub-pixel rounding). So we measure the width once per
  resize and set an EXACT column count (`repeat(n, 1fr)`) plus a DEFINITE row
  height — no cycle, no empty column, square at every width.

  Usage:
    <ThumbnailContainer minSize={120} gap={10} padding={10} class="fill">
      {#each items as it}<Thumbnail .../>{/each}
    </ThumbnailContainer>
  (Pass a class whose CSS makes it fill its parent, e.g. `flex: 1` in a flex column.)
-->
<script>
  let {
    /** @type {number} Minimum cell size (px). Cells grow past this to fill the row. */
    minSize = 120,
    /** @type {number} Gap between cells (px). */
    gap = 8,
    /** @type {number} Cell aspect ratio, width / height (1 = square). */
    aspect = 1,
    /** @type {number} Inner padding around the grid (px). */
    padding = 0,
    /** @type {boolean} Hide the scrollbar (still scrolls via wheel / drag / trackpad). */
    hideScrollbar = true,
    /** @type {string} Extra class (e.g. to size the container in its parent). */
    class: klass = "",
    children,
  } = $props();

  /** Svelte action (Command). Fits the largest aspect-locked cells across the
      width and keeps them fitted on resize. Sets the exact column count and a
      definite row height inline. */
  function fit(node, params) {
    let p = params;
    const apply = () => {
      const avail = node.clientWidth - 2 * p.padding;
      if (avail <= 0) return;
      const cols = Math.max(1, Math.floor((avail + p.gap) / (p.minSize + p.gap)));
      const cellW = (avail - (cols - 1) * p.gap) / cols;
      node.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      node.style.gridAutoRows = `${cellW / p.aspect}px`;
    };
    const ro = new ResizeObserver(apply);
    ro.observe(node);
    apply();
    return {
      update(next) { p = next; apply(); },
      destroy() { ro.disconnect(); },
    };
  }
</script>

<div
  class="tc {klass}"
  class:hide-scrollbar={hideScrollbar}
  style="gap: {gap}px; padding: {padding}px"
  use:fit={{ minSize, gap, aspect, padding }}
>
  {@render children()}
</div>

<style>
  .tc {
    display: grid;
    align-content: start;
    min-height: 0; /* so it can shrink in a flex parent and actually scroll */
    overflow-y: auto;
    overscroll-behavior: contain; /* don't bubble scroll to the page */
    box-sizing: border-box;
  }
  .hide-scrollbar {
    scrollbar-width: none; /* Firefox */
  }
  .hide-scrollbar::-webkit-scrollbar {
    display: none; /* WebKit */
  }
</style>
