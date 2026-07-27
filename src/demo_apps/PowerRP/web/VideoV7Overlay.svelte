<!--
  VideoV7Overlay — the per-widget WebGPU video layer, stacked OVER the Skia
  scene (a sibling of the .scene canvas inside PanZoom). It owns ONE small
  <canvas> per visible video_v7 widget, sized to the video's NATURAL resolution
  and CSS-transformed to the widget's on-screen quad, so full-resolution frames
  land pixel-aligned over the scene under pan/zoom/rotate.

  RENDER PATH (secure-context gated):
    • WebGPU (navigator.gpu present): each canvas draws its video ZERO-COPY via
      device.importExternalTexture (shared device, web/videoV7Gpu.js).
    • 2D fallback (plain HTTP / no WebGPU): ctx.drawImage(video) of the current
      frame — same full resolution, same frame rate, just a CPU copy. PowerRP is
      HTTPS-independent, so this path MUST work; the mode is chosen ONCE up front
      (a <canvas> can hold only one context type).

  PLAYBACK GATE (zero cost off-view): `descs` is the POST-cull visible set. A
  widget absent from it is PARKED — its <video> is PAUSED (browser stops
  decoding) and its canvas hidden, with currentTime preserved so panning back
  RESUMES from where it left off (not a restart). Repaints are driven by
  requestVideoFrameCallback — one canvas repaint per presented video frame,
  entirely decoupled from the scene's paint loop; a paused video fires no
  callbacks, so an off-view clip costs nothing.

  The <video> elements are DETACHED (never in the DOM): a muted video decodes,
  plays, and serves as a texture/drawImage source without being laid out, which
  sidesteps hidden-element throttling. Only the canvases live in the container.

  No <style> block (annotator convention): all CSS is in web/app.css.
-->
<script>
  import { onDestroy } from "svelte";
  import { webgpuAvailable, acquireVideoV7Gpu, configureV7Canvas, drawV7External } from "./videoV7Gpu.js";

  /** @type {{descs: Array<{itemId,src,w,h,matrix,opacity,cornerRadius,autoplay,loop,muted}>}} */
  let { descs = [] } = $props();

  const HAVE_CURRENT_DATA = 2; // HTMLMediaElement.readyState: a decoded frame exists

  let container = $state(null);
  /** itemId -> live entry {video, canvas, mode, gpuCtx, ctx2d, rvfc, ready, active, lastSrc}. Non-reactive. */
  const entries = new Map();
  let gpu = null;          // shared WebGPU bundle, or null once we've decided on 2D
  let gpuReady = false;    // true once the mode (WebGPU vs 2D) is settled
  let gpuInitStarted = false;
  let latestDescs = [];

  const hasRVFC = () => typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;

  /** Command. Settles the render mode ONCE: acquire the shared WebGPU device if
   * available, else fall back to 2D. Loudly logs a WebGPU init failure (never a
   * silent fallback) then reconciles with whatever descs are current. */
  async function ensureGpu() {
    if (gpuInitStarted) return;
    gpuInitStarted = true;
    if (webgpuAvailable()) {
      try {
        gpu = await acquireVideoV7Gpu();
      } catch (err) {
        console.error("VideoV7: WebGPU init failed — using 2D drawImage fallback:", err);
        gpu = null;
      }
    }
    gpuReady = true;
    reconcile(latestDescs);
  }

  /** Command. Requests one repaint per presented frame while active + playing. */
  function pump(e) {
    if (!e.active) return;
    const step = () => {
      e.rvfc = 0;
      renderEntry(e);
      if (e.active && !e.video.paused) pump(e);
    };
    e.rvfc = hasRVFC() ? e.video.requestVideoFrameCallback(step) : requestAnimationFrame(step);
  }

  /** Command. Stops the repaint loop (no-op if not pumping). */
  function cancelPump(e) {
    if (!e.rvfc) return;
    if (hasRVFC()) e.video.cancelVideoFrameCallback(e.rvfc);
    else cancelAnimationFrame(e.rvfc);
    e.rvfc = 0;
  }

  /** Command. Draws the video's current frame into its canvas (WebGPU or 2D).
   * Does nothing until the canvas is sized (metadata) and a frame is decoded. */
  function renderEntry(e) {
    if (!e.canvas.width || !e.canvas.height) return;
    if (e.mode === "webgpu") {
      if (e.gpuCtx) drawV7External(gpu, e.gpuCtx, e.video);
    } else if (e.ctx2d) {
      e.ctx2d.drawImage(e.video, 0, 0, e.canvas.width, e.canvas.height);
    }
  }

  /** Command. On metadata: size the canvas to the video's NATURAL resolution
   * (full-res, no downscale) and configure its context; paint the first frame. */
  function onMeta(e) {
    const w = e.video.videoWidth, h = e.video.videoHeight;
    if (w === 0 || h === 0) return;
    e.canvas.width = w;
    e.canvas.height = h;
    if (e.mode === "webgpu" && !e.gpuCtx) e.gpuCtx = configureV7Canvas(gpu, e.canvas);
    else if (e.mode === "2d" && !e.ctx2d) e.ctx2d = e.canvas.getContext("2d");
    if (e.video.readyState >= HAVE_CURRENT_DATA) { e.ready = true; renderEntry(e); }
  }

  /** Command. Creates the detached <video> + its canvas for one descriptor.
   * Mode is fixed here (WebGPU if the shared device exists, else 2D). */
  function createEntry(d) {
    const video = document.createElement("video");
    video.muted = d.muted; // muted is required for autoplay under browser policy
    video.loop = d.loop;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    const canvas = document.createElement("canvas");
    canvas.className = "video-v7-canvas";
    const e = { itemId: d.itemId, video, canvas, mode: gpu ? "webgpu" : "2d", gpuCtx: null, ctx2d: null, rvfc: 0, ready: false, active: true, lastSrc: d.src };
    video.addEventListener("loadedmetadata", () => onMeta(e));
    video.addEventListener("loadeddata", () => { e.ready = true; renderEntry(e); }); // first frame even when paused
    video.addEventListener("error", () => console.error(`VideoV7: <video> failed to load src="${e.lastSrc}"`, video.error));
    container.appendChild(canvas);
    video.src = d.src;
    return e;
  }

  /** Command. Positions a canvas to its widget's on-screen quad via CSS matrix. */
  function positionEntry(e, d, zIndex) {
    const c = e.canvas.style;
    const m = d.matrix;
    c.width = d.w + "px";
    c.height = d.h + "px";
    c.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
    c.opacity = String(d.opacity);
    c.borderRadius = d.cornerRadius > 0 ? d.cornerRadius + "px" : "0";
    c.zIndex = String(zIndex);
    c.display = "";
  }

  /** Command. Marks an entry visible and ensures the correct playback state:
   * autoplay → play + pump; else paused with the current frame shown. */
  function ensurePlaying(e, d) {
    e.active = true;
    if (d.autoplay) {
      if (e.video.paused) e.video.play().then(() => pump(e)).catch((err) => console.error(`VideoV7: play() rejected for src="${d.src}"`, err));
      else if (!e.rvfc) pump(e);
    } else {
      if (!e.video.paused) e.video.pause();
      renderEntry(e);
    }
  }

  /** Command. Parks an off-view entry: pause (browser stops decoding, currentTime
   * preserved) + stop repaints + hide the canvas. Kept for instant resume. */
  function parkEntry(e) {
    if (!e.active) return;
    e.active = false;
    cancelPump(e);
    if (!e.video.paused) e.video.pause();
    e.canvas.style.display = "none";
  }

  /** Command. Fully disposes an entry (src changed, or component destroyed). */
  function teardownEntry(e) {
    cancelPump(e);
    e.video.pause();
    e.video.removeAttribute("src");
    e.video.load();
    if (e.canvas.parentNode) e.canvas.parentNode.removeChild(e.canvas);
  }

  /** Command. Reconciles the live entries to the visible descriptor set: create/
   * rebuild/position/play each visible widget; park any that dropped out of view. */
  function reconcile(ds) {
    latestDescs = ds;
    if (!container) return;
    if (!gpuReady) { ensureGpu(); return; }
    const seen = new Set();
    ds.forEach((d, i) => {
      seen.add(d.itemId);
      let e = entries.get(d.itemId);
      if (e && e.lastSrc !== d.src) { teardownEntry(e); entries.delete(d.itemId); e = null; }
      if (!e) { e = createEntry(d); entries.set(d.itemId, e); }
      positionEntry(e, d, i);
      ensurePlaying(e, d);
    });
    for (const [, e] of entries) if (!seen.has(e.itemId)) parkEntry(e);
  }

  $effect(() => { reconcile(descs); });

  /** Query. A snapshot of every live entry's playback + canvas state. Exposed as
   * a dev/test seam (window.__powerrp_videoV7, mirroring window.__powerrp_app) so
   * a probe can assert pause-off-view / resume / full-res sizing. Since the
   * <video> elements are detached, this is the only handle onto them. ZERO
   * production effect — nothing reads it. */
  function videoV7Probe() {
    return [...entries.values()].map((e) => ({
      itemId: e.itemId, mode: e.mode, active: e.active, paused: e.video.paused,
      currentTime: e.video.currentTime, display: e.canvas.style.display,
      canvasW: e.canvas.width, canvasH: e.canvas.height,
    }));
  }

  $effect(() => {
    window.__powerrp_videoV7 = videoV7Probe;
    return () => { if (window.__powerrp_videoV7 === videoV7Probe) delete window.__powerrp_videoV7; };
  });

  onDestroy(() => {
    for (const [, e] of entries) teardownEntry(e);
    entries.clear();
  });
</script>

<div class="video-v7-overlay" bind:this={container}></div>
