<!--
  CanvasToolbar — the GENERAL floating canvas toolbar. A small, theme-following
  popover mounted as a DOM OVERLAY on the canvas (a sibling of the in-place text/
  latex/code editors in CanvasView), anchored just above (or, near the top edge,
  below) the widget it belongs to. Opened by DOUBLE-CLICKING a widget whose
  plugin declares `floatingToolbar(state)`.

  DECLARATIVE, GENERAL MECHANISM: a plugin returns a toolbar SPEC — analogous to
  how it declares inspector rows — and this component renders it. The one content
  kind today is a visual GRID: `{ grid: { property, value, cells:[{value,label,
  svg}] } }`. Each cell is rendered as its own SVG thumbnail; clicking a cell
  writes `property = cell.value` on the widget (one undo unit, via the standard
  preview/commit seam). Any widget can opt in; the cursor widget uses it to pick
  a cursor from a visual grid instead of an Inspector dropdown.

  HOVERING a cell LIVE-PREVIEWS it on the widget: preview() stages the same
  property write into app.previewDelta (the viewport re-renders it; the document
  is untouched and no undo entry is created), each pointerenter overwrites the
  last, and leaving the GRID reverts via app.cancelPreview(). This is the
  ToolsPane preset card-grid contract applied to a cell grid — the house rule that a
  palette selection previews under the pointer before you commit to it.

  Styling lives in app.css (.canvas-toolbar-*; the app convention: NO <style>
  block, every color/size from an --a-* token). Positioned in the render-area
  screen frame via worldToScreen (the same camera map the other overlays use), so
  it tracks the widget through pan/zoom.
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import * as T from "../core/transform.js";

  // app = the app store; node = the widget's derived render node; worldToScreen =
  // the PanZoom camera map (render-area frame); zoom = viewport.zoom (kept for
  // parity with the sibling controllers / future zoom-aware sizing).
  let { app, node, worldToScreen, zoom } = $props();

  // The plugin's declarative toolbar spec for this widget's current state.
  let spec = $derived(node.plugin.floatingToolbar?.(node.state) ?? null);

  // Anchor points (render-area screen px): the widget's top-center and
  // bottom-center. The panel sits ABOVE the top-center, unless the widget is so
  // near the top edge that the panel wouldn't fit — then it flips BELOW.
  let anchor = $derived.by(() => {
    const w = node.state.w ?? 0, h = node.state.h ?? 0;
    const t = T.apply(node.world, w / 2, 0), b = T.apply(node.world, w / 2, h);
    const top = worldToScreen(t.x, t.y), bottom = worldToScreen(b.x, b.y);
    // Read the panel's would-be max height from the CSS token so the flip
    // decision uses ONE source of truth (no magic px here).
    const maxH = cssPx("--a-canvas-toolbar-max-h", 300);
    return { x: top.x, y: top.y, bottomY: bottom.y, below: top.y < maxH };
  });

  /** Query. A CSS custom-property length (px) resolved off :root, or a fallback.
   * @example cssPx("--a-canvas-toolbar-max-h", 300) // 300 (when unset)
   */
  function cssPx(name, fallback) {
    if (typeof getComputedStyle === "undefined") return fallback;
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  }

  /** Pure function. A self-contained SVG data URI for an <img> thumbnail.
   * @example dataUri("<svg/>").startsWith("data:image/svg+xml,") // true
   */
  function dataUri(svg) {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  // Whether OUR hover currently owns app.previewDelta. A PLAIN (non-$state)
  // bridge variable — written and read imperatively, it must never drive a
  // re-render — following CommandPalette's previewRevert/previewedId.
  let previewing = false;

  /** Command. Live-previews `value` on the widget's grid property WITHOUT
   * committing: stages it into app.previewDelta so the viewport (and this
   * grid's own selected ring, which reads the derived state) shows the hovered
   * cell, while the document stays untouched and no undo entry is created. The
   * next hover overwrites it; leaving the grid reverts it. */
  function preview(property, value) {
    previewing = true;
    app.setPreview([[["items", node.itemId, property], value]]);
  }

  /** Command. Reverts the hover preview. Guarded on `previewing` so a revert
   * that lands after a commit — or while another surface owns previewDelta —
   * never discards someone else's staged change. */
  function revert() {
    if (!previewing) return;
    previewing = false;
    app.cancelPreview();
  }

  /** Command. Writes the picked value onto the widget's grid property as ONE
   * undo unit (the standard preview→commit seam the Inspector uses). Re-staging
   * the value keeps a pointer-less activation (Enter on a focused tile, which
   * fires no pointerenter) on the same path; commitPreview consumes the stage,
   * so the hover no longer owns it. */
  function pick(property, value) {
    app.setPreview([[["items", node.itemId, property], value]]);
    app.commitPreview();
    previewing = false;
  }

  // The toolbar can UNMOUNT with the pointer still over a tile (Escape, a
  // deselect, or a purge closes it), which fires no pointerleave — so the
  // revert must not depend on one (the GradientPresetPicker close() rule).
  // Without this a staged hover would outlive the grid and be baked into the
  // document by the NEXT commitPreview from anywhere in the app.
  $effect(() => {
    return () => revert();
  });
</script>

{#if spec?.grid}
  <div
    class="canvas-toolbar-root"
    class:canvas-toolbar-below={anchor.below}
    style:left="{anchor.x}px"
    style:top="{anchor.below ? anchor.bottomY : anchor.y}px"
  >
    <div class="canvas-toolbar">
      <!-- pointerleave on the GRID (not each tile) reverts only when the
           pointer leaves the tiles entirely; moving BETWEEN tiles fires each
           one's pointerenter, overwriting the preview without a revert in
           between (the ToolsPane preset card-grid precedent). -->
      <div class="canvas-toolbar-grid" role="listbox" aria-label="Cursor" tabindex="-1" onpointerleave={revert}>
        {#each spec.grid.cells as cell (cell.value)}
          <!-- Cell name on hover via SvelteLib's immediate Tooltip (native
               title= is banned in app chrome — manifest). Its anchor is
               display:contents, so the button stays the grid item AND the
               listbox's own option child. NOTE: the tip is position:fixed, so
               .canvas-toolbar must not carry a transform — a transform makes it
               the containing block and the tip lands offset by the panel's
               origin. -->
          <Tooltip text={cell.label}>
            <button
              type="button"
              class="canvas-toolbar-tile"
              class:selected={cell.value === spec.grid.value}
              role="option"
              aria-selected={cell.value === spec.grid.value}
              onpointerenter={() => preview(spec.grid.property, cell.value)}
              onclick={() => pick(spec.grid.property, cell.value)}
            >
              <img class="canvas-toolbar-thumb" src={dataUri(cell.svg)} alt={cell.label} draggable="false" />
            </button>
          </Tooltip>
        {/each}
      </div>
    </div>
  </div>
{/if}
