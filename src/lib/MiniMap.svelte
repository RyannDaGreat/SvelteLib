<!--
  MiniMap [visual, general] — viewport overview indicator.

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

  // -- Pure functions (general) -----------------------------------------------

  /**
   * Pure function, general. Check if viewport is at default (no pan, no zoom).
   *
   * @param {{zoom: number, panX: number, panY: number}} vp
   * @returns {boolean}
   *
   * @example isDefaultViewport({zoom:1, panX:0, panY:0}) // true
   * @example isDefaultViewport({zoom:2, panX:0, panY:0}) // false
   * @example isDefaultViewport({zoom:1, panX:5, panY:0}) // false
   */
  function isDefaultViewport(vp) {
    return vp.zoom === 1 && vp.panX === 0 && vp.panY === 0;
  }

  // -- Component --------------------------------------------------------------

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

  /** Stroke width that stays constant regardless of world-space scale. */
  let strokeW = $derived(1.5 / minimapScale);
  let strokeHalf = $derived(strokeW / 2);
</script>

<svg
  class="minimap"
  class:hidden={isDefaultViewport(viewport)}
  {width}
  {height}
  viewBox="{unionX} {unionY} {unionW} {unionH}"
>
  <!-- Caller-provided world-space content (optional) -->
  {#if children}
    {@render children()}
  {/if}

  <!-- World bounds outline (inset so stroke stays inside) -->
  <rect
    x={worldBounds.x + strokeHalf}
    y={worldBounds.y + strokeHalf}
    width={worldBounds.w - strokeW}
    height={worldBounds.h - strokeW}
    class="minimap-world"
    stroke-width={strokeW}
  />

  <!-- Viewport indicator (inset so stroke stays inside) -->
  <rect
    x={visibleX + strokeHalf}
    y={visibleY + strokeHalf}
    width={visibleW - strokeW}
    height={visibleH - strokeW}
    class="minimap-viewport"
    stroke-width={strokeW}
  />
</svg>

<style>
  .minimap {
    display: block;
    background: var(--minimap-bg, rgba(0, 0, 0, 0.6));
    overflow: hidden;
    opacity: 1;
    transition: opacity 0.2s;
  }
  .minimap.hidden {
    opacity: 0;
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
