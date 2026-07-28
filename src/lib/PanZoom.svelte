<!--
  PanZoom [headless, general] — viewport controller.

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
  //
  // IN ./panZoomMath.js, not here. Every function below used to live in this
  // script block labelled "Pure function, general" — and a component script
  // cannot export, so every other zoomable surface in the library re-typed the
  // ones it needed (expZoomFactor reached three copies, one of them also
  // restating the 0.01 sensitivity). This component still owns the STATE, the
  // events and the animation; the arithmetic has one home that all of them
  // import. See that file's header for the laws and their examples.
  import {
    ZOOM_SENSITIVITY, expZoomFactor, clamp, screenToWorldPure, worldToScreenPure,
    zoomTowards, pan, touchDistance, touchMidpoint, calcPinchZoom, easeOutCubic,
  } from "./panZoomMath.js";

  // -- Component ------------------------------------------------------------

  const IDENTITY = { zoom: 1, panX: 0, panY: 0 };

  let {
    /** @type {number} */ minZoom = 0.01,
    /** @type {number} */ maxZoom = 1_000_000,
    /** @type {number} */ zoomSensitivity = ZOOM_SENSITIVITY,
    /** @type {number} */ animationDuration = 300,
    /** @type {boolean} */ enableTouch = true,
    /** @type {boolean} */ active = true,
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

    setViewport(vp) {
      applyState(vp);
    },
  };

  // -- Event handlers --

  function handleWheel(e) {
    if (!active) return;
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
    if (!active || !enableTouch || e.touches.length < 2) return;
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
    position: relative; /* Containing block for absolutely-positioned children (e.g. minimap) */
    width: 100%;
    height: 100%;
    overflow: hidden; /* Clip panned content that extends beyond the viewport */
    touch-action: none; /* Prevent browser from intercepting pinch/pan gestures */
  }
</style>
