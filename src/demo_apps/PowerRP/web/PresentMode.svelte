<!--
  PresentMode — fullscreen playback. Arrow keys step slides (tweened via
  core/presentation.js, honoring each slide's TRANSITION: type/seconds/curve —
  manifest Round 12); Esc exits. Renders through THE renderer (WebGPU) like the
  editor and the CLI.

  Two draw surfaces:
    - the GPU swapchain canvas: TWEEN and instant frames (direct present, fast).
    - a 2D FADE canvas: FADE frames only — a crossfade of the two completed-state
      snapshots (renderTransitionFrame), a pure function of alpha so the CLI can
      render the same frame. Only one surface is visible per frame.
-->
<script>
  import { onMount } from "svelte";
  import { createPresenter } from "../core/presentation.js";
  import { foldState } from "../core/document.js";
  import { cameraRect, deriveRenderTree } from "../core/derive.js";
  import { evaluateState } from "../core/expressions.js";
  import { fitRectView, canSkipNode } from "../core/view.js";
  import { sceneIR } from "../render_gpu/ports.js";
  import { rect as rectCmd, parseColor } from "../render_gpu/ir.js";
  import { GpuCompositor } from "../render_gpu/gpu/compositor.js";
  import { isFadeFrame, renderTransitionFrame } from "./transitionRender.js";

  let { app } = $props();

  let canvasEl = $state(null); // GPU swapchain (tween/instant)
  let fadeEl = $state(null); // 2D crossfade surface (fade frames)
  let frame = $state({ index: 0, alpha: 1, transition: null });
  let gpu = null; // set once at mount; the rAF presenter drives paint(), not reactivity
  // Which surface is showing (drives visibility). A fade frame shows the 2D
  // canvas; everything else shows the GPU canvas.
  let showFade = $state(false);
  // Monotonic token so a slow async fade render can't paint over a newer frame.
  let paintToken = 0;

  const presenter = createPresenter(() => app.doc, (f) => {
    frame = f;
    paint();
  });

  /** Command. Paints the current frame. Branches on whether this is a FADE
   * crossfade frame (async 2D snapshot blend) or an ordinary tween/instant
   * frame (direct GPU render). */
  function paint() {
    const token = ++paintToken;
    if (isFadeFrame(app.doc, frame.index, frame.alpha)) paintFade(token);
    else paintGpu();
  }

  /** Command. GPU swapchain render of the tween/instant frame — THE CAMERA's
   * bbox at this (slide, alpha), letterboxed by a black clear + scissor. */
  function paintGpu() {
    showFade = false;
    if (!canvasEl || !gpu) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
    // The presentation views THE CAMERA's bbox at this (slide, alpha) — the
    // camera tweens between slides. Evaluated state: any property may be an
    // equation. Letterbox = black clear + scissor to the camera region (the
    // camera background is the first draw, since loadOp clear paints the bars).
    const state = evaluateState(foldState(app.doc, frame.index, frame.alpha), app.registry).state;
    const rect = cameraRect(state, app.doc.meta);
    const view = fitRectView(rect, innerWidth, innerHeight, dpr);
    const nodes = deriveRenderTree(state, app.registry).filter((n) => !canSkipNode(n, rect));
    const ir = [
      rectCmd({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: parseColor(rect.background) }),
      ...sceneIR(nodes),
    ];
    gpu.render(ir, view, {
      background: [0, 0, 0, 1], // letterbox bars
      scissor: {
        x: (rect.x * view.zoom + view.panX) * dpr,
        y: (rect.y * view.zoom + view.panY) * dpr,
        w: rect.w * view.zoom * dpr,
        h: rect.h * view.zoom * dpr,
      },
    });
    app.renderFrameCount += 1; // the FPS counter reads PRESENTATION frames (round 11)
  }

  /** Command (async). FADE crossfade of the two completed-state snapshots,
   * letterboxed onto the 2D surface. Bounded to the CAMERA region so the fade
   * matches the tween's letterbox (bars stay black). */
  async function paintFade(token) {
    if (!fadeEl) return;
    const dpr = app.dpr();
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    // The camera rect at the completed NEW slide defines the fit + letterbox
    // (both endpoints share the deck's camera; the new slide's is the target).
    const state = evaluateState(foldState(app.doc, frame.index, 1), app.registry).state;
    const rect = cameraRect(state, app.doc.meta);
    const view = fitRectView(rect, innerWidth, innerHeight, dpr);
    // Camera region in device px (the fit places the whole rect on screen).
    const camW = Math.max(1, Math.round(rect.w * view.zoom * dpr));
    const camH = Math.max(1, Math.round(rect.h * view.zoom * dpr));
    const camX = Math.round((rect.x * view.zoom + view.panX) * dpr);
    const camY = Math.round((rect.y * view.zoom + view.panY) * dpr);
    // renderTransitionFrame does the pure crossfade at the camera's own
    // resolution; we then place it inside the letterbox.
    const crossfade = await renderTransitionFrame(app.doc, frame.index, frame.alpha, app.registry, camW, camH);
    if (token !== paintToken) return; // a newer frame superseded this one
    if (fadeEl.width !== w || fadeEl.height !== h) {
      fadeEl.width = w;
      fadeEl.height = h;
    }
    const ctx = fadeEl.getContext("2d");
    ctx.fillStyle = "#000"; // letterbox bars, matching the GPU path
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(crossfade, camX, camY);
    showFade = true;
    app.renderFrameCount += 1;
  }

  function onkeydown(e) {
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") presenter.next();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") presenter.prev();
    else if (e.key === "Escape") exit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function exit() {
    presenter.stop();
    if (document.fullscreenElement) document.exitFullscreen();
    app.mode = "edit";
  }

  onMount(() => {
    presenter.goTo(app.slideIndex);
    document.documentElement.requestFullscreen?.().catch(() => {}); // headless/iframe: fine without
    window.addEventListener("keydown", onkeydown, true);
    window.addEventListener("resize", paint);
    const onFsChange = () => {
      if (!document.fullscreenElement) exit();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    // THE renderer, async init: frames before the device is ready are skipped
    // (black); failure is LOUD — no canvas2D fallback by decree.
    GpuCompositor.create(canvasEl)
      .then((g) => {
        gpu = g;
        paint();
      })
      .catch((e) => {
        console.error("PowerRP: WebGPU init failed in present mode:", e);
        exit();
        throw e;
      });
    return () => {
      window.removeEventListener("keydown", onkeydown, true);
      window.removeEventListener("resize", paint);
      document.removeEventListener("fullscreenchange", onFsChange);
      presenter.stop();
    };
  });
</script>

<div class="present">
  <canvas bind:this={canvasEl} class:hidden={showFade}></canvas>
  <canvas bind:this={fadeEl} class:hidden={!showFade}></canvas>
  <div class="present-pos">{frame.index + 1} / {app.doc.slides.length}</div>
</div>
