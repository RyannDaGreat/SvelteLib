<!--
  ResizeHandles [visual, general] — reusable SVG resize handles.
  Takes screen-space handle positions [{id, x, y}] and reports pointerdowns.
  Pure presentation: owns no geometry logic, so any widget/editor can reuse it.

  A handle may ALSO carry {lockedX, lockedY, lockNote} — the R6-28 equation-lock
  affordance, computed by CanvasView's resizeAffordance from the real gesture.
  This file only RENDERS it, and renders it PER DEGREE OF FREEDOM: a corner whose
  height is locked still resizes the width, so it takes the one-axis cursor rather
  than a disabled look. Only a handle with nothing left to do reads as dead.

  "DEAD" IS AN OPACITY, INLINE, AND THAT IS A CORRECTION. R6-28 shipped a "locked"
  class directive here with NO rule anywhere in web/app.css, so the user's own ask —
  "the canvas shows GREYED affordances" — rendered exactly like a live handle and
  the cursor was the whole signal. tests/orphan_class_test.js says so in one line
  and was RED at HEAD because of it. (The class NAME is spelled around rather than
  quoted in this comment on purpose: that gate strips CSS comments but not markup
  ones, so prose naming a class reads to it as a USE — ledger C-14's third
  instance, reported with a plan rather than patched from here, since the shared
  stripper deliberately owns the CSS case alone.) The grey is now the app-wide
  --a-disabled-opacity, set beside the cursor it belongs with, which is the same
  inline-from-tokens form CanvasView's ghost stem lines already use for overlay
  chrome while web/app.css is another agent's file.
-->
<script>
  let { handles = [], onstart } = $props();

  const CURSORS = {
    tl: "nwse-resize", br: "nwse-resize",
    tr: "nesw-resize", bl: "nesw-resize",
    tm: "ns-resize", bm: "ns-resize",
    ml: "ew-resize", mr: "ew-resize",
  };
  /** The cursor for a handle with ONE axis left. A corner degrades to the
   *  surviving axis's cursor, which is how the pointer says "this still does
   *  something, just less". */
  const AXIS_CURSOR = { x: "ew-resize", y: "ns-resize" };

  /**
   * Pure function. The cursor a handle shows, given which axes the equation lock
   * has taken away. A handle whose remaining freedom is one axis shows that axis's
   * cursor; one with none shows `not-allowed`; one with both shows its own.
   *
   * WHICH AXES A HANDLE ACTUALLY DRIVES IS READ OFF ITS OWN CURSOR, not off its
   * id: `ns-resize` IS "this handle moves in y". So a mid-edge handle whose only
   * axis is locked comes out `not-allowed` with no per-id table here, and this
   * file keeps owning no geometry.
   *
   * @param {{id: string, lockedX?: boolean, lockedY?: boolean}} h - a handle
   * @returns {string} a CSS cursor keyword
   *
   * @example cursorFor({id: "br"}) // "nwse-resize"
   * @example cursorFor({id: "br", lockedY: true}) // "ew-resize" (the corner still resizes width)
   * @example cursorFor({id: "br", lockedX: true, lockedY: true}) // "not-allowed"
   * @example cursorFor({id: "bm", lockedY: true}) // "not-allowed" (a bottom-edge handle has only y)
   */
  function cursorFor(h) {
    const own = CURSORS[h.id];
    const drivesX = own !== "ns-resize", drivesY = own !== "ew-resize";
    const liveX = drivesX && !h.lockedX, liveY = drivesY && !h.lockedY;
    if (liveX && liveY) return own;
    if (liveX) return AXIS_CURSOR.x;
    if (liveY) return AXIS_CURSOR.y;
    return "not-allowed";
  }
</script>

{#each handles as h}
  {@const cursor = cursorFor(h)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <rect
    class="handle"
    x={h.x - 4}
    y={h.y - 4}
    width="8"
    height="8"
    style:cursor={cursor}
    style:opacity={cursor === "not-allowed" ? "var(--a-disabled-opacity)" : null}
    onpointerdown={(e) => onstart(h.id, e)}
  >
    <!-- SVG-native hover hint. The HTML Tooltip component cannot mount inside an
         <svg>, which is why the anchor copy chips use <title> too; the app-wide
         ban is on native title= as a substitute for Tooltip in HTML chrome, not
         on the one accessible-name mechanism SVG has. -->
    {#if h.lockNote}<title>{h.lockNote}</title>{/if}
  </rect>
{/each}

<!-- Styling lives in app.css (app convention: no <style> blocks in app components). -->
