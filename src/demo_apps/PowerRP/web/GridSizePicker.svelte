<!--
  GridSizePicker — the classic Office "Insert Table" grid-size selector, used by
  the "Arrange into Grid" tool. The user SWEEPS the pointer over a small N×M cell
  matrix to choose rows × cols (a live "3 × 4" label), then CLICKS to confirm —
  no typing. Arrow keys + Enter give the same choice for keyboard users. The
  displayed matrix GROWS one row/col past the current selection (Office style) up
  to a cap, so you can always sweep bigger; it never shrinks below the near-square
  seed for the current item count.

  Mounted inside the SvelteLib Modal (App.svelte), which owns the overlay
  mechanics (backdrop, Escape, click-away, focus trap, portal). This component
  owns only the picker itself and its `onconfirm({rows, cols})` callback.

  STYLE: like every PowerRP web/ app-shell component, this carries NO <style> —
  all styling lives in app.css (the `.grid-picker*` rules), fully theme-following
  via --a-*/theme tokens. (It briefly kept a scoped block during the parallel
  Arrange-into-Grid lane for merge safety; relocated to app.css in task #98.)
-->
<script module>
  // The grid never displays more than this many rows/cols. Overflow beyond a
  // confirmed grid is handled by the arrange command (rows grow to fit), so this
  // is purely a sweep-area cap, not a limit on the final layout.
  const MAX_DIM = 10;
  // How many empty rows/cols to show BEYOND the current selection, so there is
  // always a cell to sweep into to grow the grid (Office behavior).
  const HEADROOM = 1;

  /**
   * Pure function. Clamps `n` to the inclusive [lo, hi] range.
   *
   * @example clamp(5, 1, 10) // 5
   * @example clamp(0, 1, 10) // 1
   * @example clamp(99, 1, 10) // 10
   */
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
</script>

<script>
  import { nearSquareGrid, effectiveRows } from "../core/grid.js";

  let {
    /** @type {number} How many items will be arranged (seeds the default + hint). */
    itemCount = 0,
    /** @type {(sel: {rows: number, cols: number}) => void} Confirm callback. */
    onconfirm,
  } = $props();

  // Near-square seed for this item count, capped to the sweep area. The picker
  // opens with this block highlighted (a sensible default, not a magic shape).
  const seed = $derived.by(() => {
    const s = nearSquareGrid(itemCount);
    return { rows: clamp(s.rows, 1, MAX_DIM), cols: clamp(s.cols, 1, MAX_DIM) };
  });

  // The current swept selection (1-based counts). Initialized to the seed.
  let sel = $state({ rows: 1, cols: 1 });
  $effect(() => { sel = { rows: seed.rows, cols: seed.cols }; });

  // Displayed matrix size: one row/col of headroom past the selection, never
  // below the seed, capped at MAX_DIM.
  const disp = $derived({
    rows: clamp(Math.max(sel.rows + HEADROOM, seed.rows), 1, MAX_DIM),
    cols: clamp(Math.max(sel.cols + HEADROOM, seed.cols), 1, MAX_DIM),
  });

  // What the arrange command will ACTUALLY build: cols as chosen, rows grown to
  // hold every item (the "overflow → grow rows" rule). Drives the hint line.
  const usedRows = $derived(effectiveRows(itemCount, sel.rows, sel.cols));
  const overflow = $derived(usedRows > sel.rows);

  /** Command. Sets the swept selection to an (r, c) cell (0-based). */
  function sweepTo(row, col) {
    sel = { rows: row + 1, cols: col + 1 };
  }

  /** Command. Confirms the current selection. */
  function confirm() {
    onconfirm?.({ rows: sel.rows, cols: sel.cols });
  }

  /** Command. Arrow keys move the selection within [1, MAX_DIM]; Enter/Space
   *  confirm. Keeps the picker fully usable without a pointer. */
  function onKeydown(e) {
    const step = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
    if (step) {
      e.preventDefault();
      sel = { rows: clamp(sel.rows + step[0], 1, MAX_DIM), cols: clamp(sel.cols + step[1], 1, MAX_DIM) };
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      confirm();
    }
  }
</script>

<div class="grid-picker">
  <div class="grid-picker-label" aria-live="polite">{sel.rows} × {sel.cols}</div>

  <!-- One focus stop (role=grid); cells are non-tabbable buttons swept by the
       pointer. Arrow keys roam, Enter/Space confirm (onKeydown). -->
  <div
    class="grid-picker-grid"
    role="grid"
    tabindex="0"
    aria-label="Grid size: {sel.rows} by {sel.cols}. Arrow keys to size, Enter to confirm."
    onkeydown={onKeydown}
    style="--gp-cols: {disp.cols};"
  >
    {#each Array(disp.rows) as _, row}
      {#each Array(disp.cols) as _, col}
        <button
          type="button"
          tabindex="-1"
          class="grid-picker-cell"
          class:on={row < sel.rows && col < sel.cols}
          aria-label="{row + 1} by {col + 1}"
          onpointerenter={() => sweepTo(row, col)}
          onpointerdown={() => sweepTo(row, col)}
          onclick={confirm}
        ></button>
      {/each}
    {/each}
  </div>

  <div class="grid-picker-hint">
    {#if overflow}
      grows to {usedRows} × {sel.cols} to fit {itemCount} items
    {:else}
      {itemCount} items · {sel.rows * sel.cols} cells
    {/if}
  </div>
</div>

