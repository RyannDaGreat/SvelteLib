<!--
  MiniMap — viewport overview indicator.

  Displays a miniature overview of a pan/zoom world, showing the visible
  viewport as a highlighted rectangle within the total world bounds.
  The minimap auto-expands when the viewport extends beyond world bounds.

  Backend-agnostic: renders as SVG. For SVG-based content, pass the same
  scene elements as children and they render in world coordinates automatically
  (the viewBox handles scaling). For Canvas/WebGL/HTML, use the component
  as a viewport indicator overlay and render content separately.

  Usage:
    <MiniMap viewport={{zoom, panX, panY}} {containerWidth} {containerHeight}
            worldBounds={{x: 0, y: 0, w: 1000, h: 1000}} />

  With content mirroring (SVG):
    <MiniMap viewport={{zoom, panX, panY}} {containerWidth} {containerHeight}
            worldBounds={{x: 0, y: 0, w: 1000, h: 1000}}>
      {#snippet children()}
        <g>...same SVG shapes as main view...</g>
      {/snippet}
    </MiniMap>
-->
<script>
  /**
   * @typedef {Object} Viewport
   * @property {number} zoom
   * @property {number} panX
   * @property {number} panY
   */

  /**
   * @typedef {Object} WorldBounds
   * @property {number} x
   * @property {number} y
   * @property {number} w
   * @property {number} h
   */

  let {
    /** @type {Viewport} */
    viewport,
    /** @type {number} Container width in px */
    containerWidth,
    /** @type {number} Container height in px */
    containerHeight,
    /** @type {WorldBounds} */
    worldBounds = { x: 0, y: 0, w: 1000, h: 1000 },
    /** @type {number} Max pixel dimension of the minimap */
    maxSize = 150,
    children = undefined,
  } = $props();

  // -- Derived geometry -------------------------------------------------------

  /** Visible rectangle in world coordinates. */
  let visibleX = $derived(-viewport.panX / viewport.zoom);
  let visibleY = $derived(-viewport.panY / viewport.zoom);
  let visibleW = $derived(containerWidth / viewport.zoom);
  let visibleH = $derived(containerHeight / viewport.zoom);

  /** Union of world bounds and visible rect — minimap shows all of this. */
  let unionX = $derived(Math.min(worldBounds.x, visibleX));
  let unionY = $derived(Math.min(worldBounds.y, visibleY));
  let unionW = $derived(
    Math.max(worldBounds.x + worldBounds.w, visibleX + visibleW) - unionX,
  );
  let unionH = $derived(
    Math.max(worldBounds.y + worldBounds.h, visibleY + visibleH) - unionY,
  );

  /** Scale factor from world units to minimap pixels. */
  let minimapScale = $derived(Math.min(maxSize / unionW, maxSize / unionH));

  /** Final minimap pixel dimensions. */
  let width = $derived(unionW * minimapScale);
  let height = $derived(unionH * minimapScale);

  /** Stroke widths that stay constant regardless of world-space scale. */
  let thinStroke = $derived(1 / minimapScale);
  let thickStroke = $derived(2 / minimapScale);
</script>

<svg
  class="minimap"
  {width}
  {height}
  viewBox="{unionX} {unionY} {unionW} {unionH}"
>
  <!-- Caller-provided world-space content (optional) -->
  {#if children}
    {@render children()}
  {/if}

  <!-- World bounds outline -->
  <rect
    x={worldBounds.x}
    y={worldBounds.y}
    width={worldBounds.w}
    height={worldBounds.h}
    class="minimap-world"
    stroke-width={thinStroke}
  />

  <!-- Viewport indicator -->
  <rect
    x={visibleX}
    y={visibleY}
    width={visibleW}
    height={visibleH}
    class="minimap-viewport"
    stroke-width={thickStroke}
  />
</svg>

<style>
  .minimap {
    display: block;
    background: var(--minimap-bg, rgba(0, 0, 0, 0.6));
    overflow: hidden;
  }

  .minimap-world {
    fill: var(--minimap-world-fill, rgba(255, 255, 255, 0.05));
    stroke: var(--minimap-world-stroke, rgba(255, 255, 255, 0.2));
  }

  .minimap-viewport {
    fill: var(--minimap-viewport-fill, rgba(233, 69, 96, 0.1));
    stroke: var(--minimap-viewport-stroke, #e94560);
  }
</style>
