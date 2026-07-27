<!--
  VideoV6Overlay — ONE shared canvas stacked ABOVE the Skia scene canvas that
  draws every visible V6 video widget's live frame (WebGPU external-texture
  zero-copy; WebGL2 upload fallback on plain HTTP). Transparent everywhere a
  video isn't, so the Skia scene shows through.

  It is DECOUPLED from the Skia paint loop: playing frames drive THIS canvas's
  redraw via requestVideoFrameCallback (onVideoV6Frame) and never re-run the
  scene paint — so video plays at full rate at zero scene cost. Camera/edit
  changes flow in as reactive props (nodes/view/device size); per-video-frame
  advances redraw the same quads with the newly-decoded frames.

  App component → NO <style> block (the .video-v6-overlay rule lives in app.css).
-->
<script>
  import { onDestroy } from "svelte";
  import { createVideoV6Engine } from "./videoV6Gpu.js";
  import { acquireVideoV6El, setActiveVideoV6, onVideoV6Frame, disposeVideoV6 } from "./videoV6Registry.js";
  import { videoV6DeviceQuad } from "./videoV6Layout.js";

  // nodes: the POST-CULL visible video_v6 render nodes (CanvasView filters + feeds
  // these); view: the camera {zoom,panX,panY,dpr}; deviceW/H: the scene canvas
  // backing size in device px (so the overlay aligns pixel-for-pixel).
  let { nodes = [], view = null, deviceW = 0, deviceH = 0 } = $props();

  let canvasEl = $state(null);
  let engine = null;      // non-reactive: async-created GPU/GL engine
  let engineStarted = false;
  let drawList = [];      // non-reactive: [{el, corners, opacity}] for visible clips
  let rafPending = false; // coalesce redraws to one per animation frame

  /** Command. Redraw the overlay once on the next animation frame (coalesced). */
  function scheduleDraw() {
    if (rafPending || !engine) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (engine) engine.drawFrame(drawList, deviceW, deviceH);
    });
  }

  /** Command. Lazily build the engine on first use (kept out of mount so a doc
   *  with no video widget pays nothing). Redraws once the engine lands. */
  async function ensureEngine() {
    if (engineStarted || !canvasEl) return;
    engineStarted = true;
    engine = await createVideoV6Engine(canvasEl);
    scheduleDraw();
  }

  // Per painted video frame: redraw the OVERLAY ONLY (no Skia repaint).
  $effect(() => onVideoV6Frame(() => scheduleDraw()));

  // Rebuild the draw list on any camera / edit / size change: size the canvas,
  // acquire each visible clip's <video>, compute its on-screen quad, and gate
  // playback (pausing every off-view clip).
  $effect(() => {
    nodes; view; deviceW; deviceH;
    if (canvasEl && (canvasEl.width !== deviceW || canvasEl.height !== deviceH)) {
      canvasEl.width = deviceW;
      canvasEl.height = deviceH;
    }
    const list = [];
    const flagsBySrc = new Map();
    if (view) {
      for (const n of nodes) {
        const src = n.state.src;
        if (typeof src !== "string" || src.length === 0) continue;
        const flags = { autoplay: n.state.autoplay !== false, loop: n.state.loop !== false, muted: n.state.muted !== false };
        const el = acquireVideoV6El(src, flags);
        flagsBySrc.set(src, flags);
        list.push({ el, corners: videoV6DeviceQuad(n, view), opacity: n.state.opacity ?? 1 });
      }
    }
    drawList = list;
    setActiveVideoV6(new Set(flagsBySrc.keys()), flagsBySrc);
    if (list.length > 0) ensureEngine();
    scheduleDraw();
  });

  onDestroy(() => {
    engine?.dispose?.();
    disposeVideoV6();
  });
</script>

<canvas class="video-v6-overlay" bind:this={canvasEl}></canvas>
