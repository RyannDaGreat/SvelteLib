<!--
  PresentMode — fullscreen playback. Arrow keys step slides (tweened via
  core/presentation.js, honoring per-slide duration and autoAdvance); Esc
  exits. Renders through the SAME compositor as the editor and the CLI.
-->
<script>
  import { onMount } from "svelte";
  import { createPresenter } from "../core/presentation.js";
  import { foldState } from "../core/document.js";
  import { cameraRect } from "../core/derive.js";
  import { evaluateState } from "../core/expressions.js";
  import { paintScene, fitRectView } from "../render/compositor.js";

  let { app } = $props();

  let canvasEl = $state(null);
  let frame = $state({ index: 0, alpha: 1 });

  const presenter = createPresenter(() => app.doc, (f) => {
    frame = f;
    paint();
  });

  function paint() {
    if (!canvasEl) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    canvasEl.width = Math.round(innerWidth * dpr);
    canvasEl.height = Math.round(innerHeight * dpr);
    const ctx = canvasEl.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    // The presentation views THE CAMERA's bbox at this (slide, alpha) — the
    // camera tweens between slides. Letterbox: clip to the camera region.
    // Evaluated state: the camera's own properties may be equations.
    const rect = cameraRect(evaluateState(foldState(app.doc, frame.index, frame.alpha), app.registry).state, app.doc.meta);
    const view = fitRectView(rect, innerWidth, innerHeight, dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      (rect.x * view.zoom + view.panX) * dpr,
      (rect.y * view.zoom + view.panY) * dpr,
      rect.w * view.zoom * dpr,
      rect.h * view.zoom * dpr,
    );
    ctx.clip();
    paintScene(ctx, app.doc, {
      slideIndex: frame.index,
      alpha: frame.alpha,
      registry: app.registry,
      view,
    });
    ctx.restore();
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
    paint();
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
