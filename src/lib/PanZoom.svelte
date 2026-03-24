<!--
  PanZoom — headless viewport controller component.

  Owns pan/zoom transform state. Handles wheel (trackpad pinch + two-finger pan),
  touch pinch-to-zoom, and animated transitions.
  Renders nothing itself — passes viewport state to children for consumer to apply.

  Usage:
    <PanZoom let:viewport let:reset>
      <MyCanvas {viewport} />
    </PanZoom>

  Or with snippet syntax:
    <PanZoom>
      {#snippet children(viewport, actions)}
        <canvas use:applyTransform={viewport} />
        <button onclick={actions.reset}>Reset</button>
        <button onclick={() => actions.zoomTo(2)}>2x</button>
      {/snippet}
    </PanZoom>
-->
<script>
  /**
   * @typedef {Object} Viewport
   * @property {number} zoom
   * @property {number} panX
   * @property {number} panY
   */

  /**
   * @typedef {Object} Actions
   * @property {() => void} reset - Animated reset to identity
   * @property {(z: number) => void} zoomTo - Animated zoom to level
   * @property {(rect: {x:number,y:number,w:number,h:number}) => void} zoomToFit - Animated zoom to fit rect
   * @property {(sx:number, sy:number) => {x:number,y:number}} screenToWorld
   * @property {(wx:number, wy:number) => {x:number,y:number}} worldToScreen
   */

  // -- Pure math (general) --------------------------------------------------

  /**
   * Pure function, general. Exponential zoom factor from wheel delta.
   *
   * @example expZoomFactor(100) // ~0.5 (zoom out)
   * @example expZoomFactor(-100) // ~2.0 (zoom in)
   * @example expZoomFactor(0) // 1.0 (no change)
   */
  function expZoomFactor(deltaY, sensitivity = 0.01) {
    return Math.pow(2, -deltaY * sensitivity);
  }

  /**
   * Pure function, general. Clamp value to [min, max].
   *
   * @example clamp(0.5, 1, 100) // 1
   * @example clamp(50, 1, 100) // 50
   * @example clamp(200, 1, 100) // 100
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Pure function, general. Screen coords to world coords.
   *
   * @example screenToWorldPure(100, 100, {zoom:2, panX:50, panY:50}) // {x:25, y:25}
   * @example screenToWorldPure(0, 0, {zoom:1, panX:0, panY:0}) // {x:0, y:0}
   */
  function screenToWorldPure(screenX, screenY, vp) {
    return {
      x: (screenX - vp.panX) / vp.zoom,
      y: (screenY - vp.panY) / vp.zoom,
    };
  }

  /**
   * Pure function, general. World coords to screen coords.
   *
   * @example worldToScreenPure(25, 25, {zoom:2, panX:50, panY:50}) // {x:100, y:100}
   */
  function worldToScreenPure(worldX, worldY, vp) {
    return {
      x: worldX * vp.zoom + vp.panX,
      y: worldY * vp.zoom + vp.panY,
    };
  }

  /**
   * Pure function, general. New viewport zoomed towards a screen point (point stays fixed).
   *
   * @example zoomTowards(100, 100, 2, {zoom:1, panX:0, panY:0}) // {zoom:2, panX:-100, panY:-100}
   */
  function zoomTowards(screenX, screenY, newZoom, vp) {
    const world = screenToWorldPure(screenX, screenY, vp);
    return {
      zoom: newZoom,
      panX: screenX - world.x * newZoom,
      panY: screenY - world.y * newZoom,
    };
  }

  /**
   * Pure function, general. Apply pan delta to viewport.
   *
   * @example pan({zoom:1, panX:0, panY:0}, 10, 20) // {zoom:1, panX:-10, panY:-20}
   */
  function pan(vp, deltaX, deltaY) {
    return { zoom: vp.zoom, panX: vp.panX - deltaX, panY: vp.panY - deltaY };
  }

  /**
   * Pure function, general. Euclidean distance between two touch points.
   *
   * @example touchDistance({clientX:0,clientY:0}, {clientX:3,clientY:4}) // 5
   */
  function touchDistance(t1, t2) {
    const dx = t2.clientX - t1.clientX;
    const dy = t2.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Pure function, general. Midpoint between two touches relative to element rect.
   *
   * @example touchMidpoint({clientX:0,clientY:0}, {clientX:100,clientY:100}, {left:0,top:0}) // {x:50, y:50}
   */
  function touchMidpoint(t1, t2, rect) {
    return {
      x: (t1.clientX + t2.clientX) / 2 - rect.left,
      y: (t1.clientY + t2.clientY) / 2 - rect.top,
    };
  }

  /** Pure function, general. Compute viewport from pinch gesture state. */
  function calcPinchZoom(pinch, currentDist, currentMid, minZoom, maxZoom) {
    const zoomDelta = currentDist / pinch.initialDist;
    const newZoom = clamp(pinch.initialZoom * zoomDelta, minZoom, maxZoom);
    const world = screenToWorldPure(pinch.initialMidX, pinch.initialMidY, {
      zoom: pinch.initialZoom,
      panX: pinch.initialPanX,
      panY: pinch.initialPanY,
    });
    return {
      zoom: newZoom,
      panX: currentMid.x - world.x * newZoom,
      panY: currentMid.y - world.y * newZoom,
    };
  }

  /**
   * Pure function, general. Ease-out cubic.
   *
   * @example easeOutCubic(0) // 0
   * @example easeOutCubic(1) // 1
   * @example easeOutCubic(0.5) // 0.875
   */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // -- Component ------------------------------------------------------------

  const IDENTITY = { zoom: 1, panX: 0, panY: 0 };

  let {
    /** @type {number} */ minZoom = 0.01,
    /** @type {number} */ maxZoom = 1_000_000,
    /** @type {number} */ zoomSensitivity = 0.01,
    /** @type {number} */ animationDuration = 300,
    /** @type {boolean} */ enableTouch = true,
    /** @type {(vp: Viewport) => void} */ onviewport = undefined,
    children,
  } = $props();

  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);

  /** @type {HTMLDivElement|undefined} */
  let containerEl = $state(undefined);

  // Pinch gesture state (not reactive — internal bookkeeping)
  let pinchState = null;
  let animationId = null;

  function viewport() {
    return { zoom, panX, panY };
  }

  function applyState(vp) {
    zoom = vp.zoom;
    panX = vp.panX;
    panY = vp.panY;
    onviewport?.(viewport());
  }

  // -- Animated transitions --

  function animateTo(target) {
    if (animationId) cancelAnimationFrame(animationId);
    const start = viewport();
    const startTime = performance.now();

    function tick(now) {
      const t = Math.min((now - startTime) / animationDuration, 1);
      const e = easeOutCubic(t);
      applyState({
        zoom: start.zoom + (target.zoom - start.zoom) * e,
        panX: start.panX + (target.panX - start.panX) * e,
        panY: start.panY + (target.panY - start.panY) * e,
      });
      if (t < 1) {
        animationId = requestAnimationFrame(tick);
      } else {
        animationId = null;
      }
    }
    animationId = requestAnimationFrame(tick);
  }

  // -- Actions exposed to consumer --

  const actions = {
    reset() {
      animateTo(IDENTITY);
    },

    zoomTo(z) {
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const clamped = clamp(z, minZoom, maxZoom);
      animateTo(zoomTowards(centerX, centerY, clamped, viewport()));
    },

    zoomToFit(worldRect) {
      if (!containerEl) return;
      const cr = containerEl.getBoundingClientRect();
      const scaleX = cr.width / worldRect.w;
      const scaleY = cr.height / worldRect.h;
      const fitZoom = clamp(Math.min(scaleX, scaleY) * 0.9, minZoom, maxZoom);
      animateTo({
        zoom: fitZoom,
        panX: (cr.width - worldRect.w * fitZoom) / 2 - worldRect.x * fitZoom,
        panY: (cr.height - worldRect.h * fitZoom) / 2 - worldRect.y * fitZoom,
      });
    },

    screenToWorld(sx, sy) {
      return screenToWorldPure(sx, sy, viewport());
    },

    worldToScreen(wx, wy) {
      return worldToScreenPure(wx, wy, viewport());
    },
  };

  // -- Event handlers --

  function handleWheel(e) {
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.ctrlKey) {
      const newZoom = clamp(
        zoom * expZoomFactor(e.deltaY, zoomSensitivity),
        minZoom,
        maxZoom,
      );
      applyState(zoomTowards(sx, sy, newZoom, viewport()));
    } else {
      applyState(pan(viewport(), e.deltaX, e.deltaY));
    }
  }

  function handleTouchStart(e) {
    if (!enableTouch || e.touches.length < 2) return;
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const mid = touchMidpoint(e.touches[0], e.touches[1], rect);
    pinchState = {
      initialZoom: zoom,
      initialPanX: panX,
      initialPanY: panY,
      initialDist: touchDistance(e.touches[0], e.touches[1]),
      initialMidX: mid.x,
      initialMidY: mid.y,
    };
  }

  function handleTouchMove(e) {
    if (!pinchState || !enableTouch || e.touches.length < 2) return;
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const dist = touchDistance(e.touches[0], e.touches[1]);
    const mid = touchMidpoint(e.touches[0], e.touches[1], rect);
    applyState(calcPinchZoom(pinchState, dist, mid, minZoom, maxZoom));
  }

  function handleTouchEnd() {
    pinchState = null;
  }
</script>

<div
  class="panzoom-container"
  bind:this={containerEl}
  onwheel={handleWheel}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  role="application"
  tabindex="-1"
>
  {@render children(viewport(), actions)}
</div>

<style>
  .panzoom-container {
    width: 100%;
    height: 100%;
    overflow: hidden; /* Clip panned content that extends beyond the viewport */
    touch-action: none; /* Prevent browser from intercepting pinch/pan gestures */
  }
</style>
