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
  preview/commit seam). Any widget can opt in; the macOS cursor uses it to pick a
  cursor from a visual grid instead of an Inspector dropdown.

  Styling lives in app.css (.canvas-toolbar-*; the app convention: NO <style>
  block, every color/size from an --a-* token). Positioned in the render-area
  screen frame via worldToScreen (the same camera map the other overlays use), so
  it tracks the widget through pan/zoom.
-->
<script>
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

  /** Command. Writes the picked value onto the widget's grid property as ONE
   * undo unit (the standard preview→commit seam the Inspector uses). */
  function pick(property, value) {
    app.setPreview([[["items", node.itemId, property], value]]);
    app.commitPreview();
  }
</script>

{#if spec?.grid}
  <div
    class="canvas-toolbar-root"
    class:canvas-toolbar-below={anchor.below}
    style:left="{anchor.x}px"
    style:top="{anchor.below ? anchor.bottomY : anchor.y}px"
  >
    <div class="canvas-toolbar">
      <div class="canvas-toolbar-grid" role="listbox" aria-label="Cursor">
        {#each spec.grid.cells as cell (cell.value)}
          <button
            type="button"
            class="canvas-toolbar-tile"
            class:selected={cell.value === spec.grid.value}
            role="option"
            aria-selected={cell.value === spec.grid.value}
            title={cell.label}
            onclick={() => pick(spec.grid.property, cell.value)}
          >
            <img class="canvas-toolbar-thumb" src={dataUri(cell.svg)} alt={cell.label} draggable="false" />
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
