<!--
  PresentMode — fullscreen playback. Arrow keys step slides (tweened via
  core/presentation.js, honoring per-slide duration and autoAdvance); Esc
  exits. Renders through THE renderer (WebGPU) like the editor and the CLI.
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

  let { app } = $props();

  let canvasEl = $state(null);
  let frame = $state({ index: 0, alpha: 1 });
  let gpu = null; // set once at mount; the rAF presenter drives paint(), not reactivity

  const presenter = createPresenter(() => app.doc, (f) => {
    frame = f;
    paint();
  });

  function paint() {
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
    // canvas2D ctx.clip() equivalent); the camera background is the first
    // draw (loadOp clear paints the bars, so the background must be a draw).
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
  <canvas bind:this={canvasEl}></canvas>
  <div class="present-pos">{frame.index + 1} / {app.doc.slides.length}</div>
</div>
