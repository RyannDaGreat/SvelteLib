<!--
  SlideNav — the left-hand slide navigator. Shows display NUMBERS (which
  shift on insert) while slides keep permanent UUIDs underneath.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { foldState } from "../core/document.js";
  import { cameraRect } from "../core/derive.js";
  import { paintScene, fitRectView, THUMB_W } from "../render/compositor.js";

  let { app } = $props();

  /** Per-slide thumbnails rendered THROUGH each slide's camera (the camera
   * determines the thumbnails — manifest). Regenerated on commit, never at
   * drag rate (previewDelta skips). */
  let thumbs = $state([]);
  $effect(() => {
    app.doc;
    if (app.previewDelta) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    thumbs = app.doc.slides.map((_, i) => {
      const rect = cameraRect(foldState(app.doc, i, 1), app.doc.meta);
      if (rect.w <= 0 || rect.h <= 0) return "";
      const cssH = Math.max(1, Math.round((THUMB_W * rect.h) / rect.w));
      const c = document.createElement("canvas");
      c.width = Math.round(THUMB_W * dpr);
      c.height = Math.round(cssH * dpr);
      paintScene(c.getContext("2d"), app.doc, {
        slideIndex: i,
        alpha: 1,
        registry: app.registry,
        view: fitRectView(rect, THUMB_W, cssH, dpr),
      });
      return c.toDataURL("image/png");
    });
  });
</script>

<div class="slidenav">
  <div class="slides">
    {#each app.doc.slides as slide, i (slide.id)}
      <button
        class="slide"
        class:current={i === app.slideIndex}
        class:disabled={slide.enabled === false}
        onclick={() => (app.slideIndex = i)}
        title={slide.id}
      >
        <span class="row-top">
          <span class="num">{i + 1}</span>
          <span class="name">{slide.name}</span>
          <Tooltip text={slide.enabled === false ? "Enable slide (apply its delta)" : "Disable slide (skip its delta)"}>
            <span
              class="eye"
              role="button"
              tabindex="-1"
              onclick={(e) => { e.stopPropagation(); app.toggleSlide(i); }}
              onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); app.toggleSlide(i); } }}
            >
              <iconify-icon icon={slide.enabled === false ? "mdi:eye-off" : "mdi:eye"} width="14" height="14"></iconify-icon>
            </span>
          </Tooltip>
        </span>
        {#if thumbs[i]}
          <img class="thumb" src={thumbs[i]} alt="Slide {i + 1} preview" draggable="false" />
        {/if}
      </button>
    {/each}
  </div>
  <div class="nav-actions">
    <Tooltip text="New slide after current">
      <button class="btn-icon" aria-label="New slide" onclick={() => app.runCommand("new-slide")}>
        <iconify-icon icon="mdi:plus" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Move slide up">
      <button class="btn-icon" aria-label="Move slide up" onclick={() => app.runCommand("move-slide-up")}>
        <iconify-icon icon="mdi:arrow-up" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Move slide down">
      <button class="btn-icon" aria-label="Move slide down" onclick={() => app.runCommand("move-slide-down")}>
        <iconify-icon icon="mdi:arrow-down" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Delete slide">
      <button class="btn-icon" aria-label="Delete slide" onclick={() => app.runCommand("delete-slide")} disabled={app.doc.slides.length <= 1}>
        <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
  </div>
</div>
