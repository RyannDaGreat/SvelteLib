<!--
  SlideNav — the left-hand slide navigator. Shows display NUMBERS (which
  shift on insert) while slides keep permanent UUIDs underneath.

  Thumbnails use the generic DirtyImage widget (src/lib): each renders THROUGH
  its slide's camera, at the size it's DISPLAYED (panel width × dpr) so it's
  crisp, and only when it's on screen AND dirty. "Dirty" = the document changed
  (app.doc identity flips on every commit) or the panel was resized. Editing
  never re-renders every thumbnail — a commit marks them all dirty, but only the
  ones scrolled into view repaint (scales to "5 million slides" — manifest).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DirtyImage from "../../../lib/DirtyImage.svelte";
  import { foldState } from "../core/document.js";
  import { cameraRect } from "../core/derive.js";
  import { evaluateState } from "../core/expressions.js";
  import { paintScene, fitRectView } from "../render/compositor.js";

  let { app } = $props();

  /** Camera rect of slide `i` at full alpha (the thumbnail's view + aspect).
      Evaluated state: the camera's own properties may be equations. */
  function slideRect(i) {
    return cameraRect(evaluateState(foldState(app.doc, i, 1), app.registry).state, app.doc.meta);
  }

  /** Thumbnail aspect (h/w) for slide `i`, or null when the camera is degenerate
      (no positive-area rect → no thumbnail). */
  function thumbAspect(i) {
    const rect = slideRect(i);
    return rect.w > 0 && rect.h > 0 ? rect.h / rect.w : null;
  }

  /**
   * render() for slide `i`'s thumbnail: paints the committed slide state through
   * its camera at the REQUESTED device-pixel size — displayed-size × dpr, so it
   * is exactly as crisp as the panel shows it (no fixed-256px upscale). Returns
   * a canvas; DirtyImage turns it into the <img>. Renders committed state only
   * (never the live drag preview), so a drag can't trigger thumbnail repaints.
   */
  function renderThumb(i) {
    return (wPx, hPx) => {
      const rect = slideRect(i);
      const c = document.createElement("canvas");
      c.width = wPx;
      c.height = hPx;
      paintScene(c.getContext("2d"), app.doc, {
        slideIndex: i,
        alpha: 1,
        registry: app.registry,
        view: fitRectView(rect, wPx, hPx, 1), // wPx/hPx are already device px
      });
      return c;
    };
  }

  // The document identity (app.doc changes on every commit) is the dirty key —
  // a NEW object reference per commit, so every mounted thumbnail goes dirty on
  // any edit (only the visible ones repaint). Per-slide identity is handled by
  // the {#each ... (slide.id)} key: each tile instance is bound to one slide, so
  // committedDoc alone is a stable, meaningful key.
  // While a drag preview is active we FREEZE it (keep the last committed doc) so
  // thumbnails never re-render at drag rate — the preview lives in previewDelta,
  // not app.doc, and thumbnails show committed state only.
  // svelte-ignore state_referenced_locally — the initial value is immediately
  // reconciled by the effect below (previewDelta is null at mount).
  let committedDoc = $state(app.doc);
  $effect(() => {
    if (!app.previewDelta) committedDoc = app.doc;
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
        {#if thumbAspect(i)}
          <DirtyImage
            class="thumb"
            render={renderThumb(i)}
            dirtyKey={committedDoc}
            aspect={thumbAspect(i)}
            alt={`Slide ${i + 1} preview`}
          />
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
