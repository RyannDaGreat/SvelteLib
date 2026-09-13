<!--
  HorizontalViewport [visual, general] — one-dimensional scroll and zoom.

  The content uses real layout width rather than a CSS transform, so text and
  controls retain their size. Horizontal wheel input pans; Ctrl-wheel or a
  trackpad pinch zooms about the pointer. The navigator window pans from its
  center and zooms from either edge. Content and container width changes refit
  the complete content automatically.

  Usage:
    <HorizontalViewport contentWidth={2400} bind:scale bind:scrollLeft>
      {#snippet children(viewport)}
        <MyContent scale={viewport.scale} />
      {/snippet}
    </HorizontalViewport>
-->
<script>
  import { onDestroy, untrack } from "svelte";

  const ZOOM_SENSITIVITY = 0.01;

  let {
    /** Unscaled content width in CSS pixels. */
    contentWidth,
    /** Layout scale, bounded only by complete-content fit. */
    scale = $bindable(1),
    /** Native horizontal scroll offset in CSS pixels. */
    scrollLeft = $bindable(0),
    /** Called after viewport state changes. */
    onchange = undefined,
    children,
  } = $props();

  let scrollElement;
  let navigatorElement;
  let viewportWidth = $state(0);
  let navigatorDrag = $state("");
  let dragStartX = 0;
  let dragStart = 0;
  let dragEnd = 0;
  let deferredScrollFrame = 0;

  const minimumScale = $derived(contentWidth > 0 && viewportWidth > 0 ? viewportWidth / contentWidth : 1);
  const totalWidth = $derived(contentWidth * scale);
  const visibleStart = $derived(scale > 0 ? scrollLeft / scale : 0);
  const visibleWidth = $derived(scale > 0 ? viewportWidth / scale : contentWidth);
  const navigatorLeft = $derived(contentWidth > 0 ? visibleStart / contentWidth * 100 : 0);
  const navigatorWidth = $derived(contentWidth > 0 ? Math.min(100, visibleWidth / contentWidth * 100) : 100);

  /**
   * Pure function. Clamps a number to an inclusive interval.
   *
   * @param {number} value - Value to clamp
   * @param {number} minimum - Inclusive lower bound
   * @param {number} maximum - Inclusive upper bound
   * @returns {number}
   *
   * @example clamp(12, 0, 10) // 10
   */
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /**
   * Pure function. Zooms an interval about a fractional focal point.
   *
   * @param {{start:number,end:number}} view - Visible world interval
   * @param {number} focalFraction - Focal position in [0, 1]
   * @param {number} factor - Multiplicative zoom factor
   * @param {number} worldWidth - Complete world width
   * @returns {{start:number,end:number}}
   *
   * @example zoomWindow({start:0,end:100}, 0.5, 2, 100) // {start:25,end:75}
   */
  function zoomWindow(view, focalFraction, factor, worldWidth) {
    const width = view.end - view.start;
    const focal = view.start + focalFraction * width;
    const nextWidth = clamp(width / factor, 0, worldWidth);
    const start = clamp(focal - focalFraction * nextWidth, 0, worldWidth - nextWidth);
    return { start, end: start + nextWidth };
  }

  /** Command. Reports the current controlled viewport. */
  function report() {
    onchange?.({ scale, scrollLeft, viewportWidth, contentWidth });
  }

  /** Command. Cancels the pending post-layout scroll write. */
  function cancelDeferredScroll() {
    if (!deferredScrollFrame) return;
    cancelAnimationFrame(deferredScrollFrame);
    deferredScrollFrame = 0;
  }

  /** Command. Writes horizontal scroll after the changed extent has laid out. */
  function deferScrollWrite() {
    cancelDeferredScroll();
    deferredScrollFrame = requestAnimationFrame(() => {
      deferredScrollFrame = 0;
      scrollElement.scrollLeft = scrollLeft;
    });
  }

  /** Command. Applies a fit-bounded scale and legal native scroll offset. */
  function setView(nextScale, nextScrollLeft, deferScroll = false) {
    scale = Math.max(minimumScale, nextScale);
    scrollLeft = clamp(nextScrollLeft, 0, Math.max(0, contentWidth * scale - viewportWidth));
    if (deferScroll) deferScrollWrite();
    else {
      cancelDeferredScroll();
      scrollElement.scrollLeft = scrollLeft;
    }
    report();
  }

  /** Command. Synchronizes controlled state from a native scroll event. */
  function handleScroll(event) {
    scrollLeft = event.currentTarget.scrollLeft;
    report();
  }

  /** Command. Zooms about the pointer or pans from horizontal wheel input. */
  function handleWheel(event) {
    if (contentWidth <= 0 || viewportWidth <= 0) return;
    if (event.ctrlKey) {
      event.preventDefault();
      const rect = scrollElement.getBoundingClientRect();
      const view = zoomWindow(
        { start: visibleStart, end: visibleStart + visibleWidth },
        clamp((event.clientX - rect.left) / rect.width, 0, 1),
        Math.pow(2, -event.deltaY * ZOOM_SENSITIVITY),
        contentWidth,
      );
      if (view.end <= view.start) return;
      const nextScale = viewportWidth / (view.end - view.start);
      setView(nextScale, view.start * nextScale, true);
      return;
    }
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta) return;
    event.preventDefault();
    setView(scale, scrollElement.scrollLeft + delta);
  }

  /** Command. Starts a navigator center-pan or edge-resize gesture. */
  function beginNavigatorDrag(kind, event) {
    event.preventDefault();
    navigatorDrag = kind;
    dragStartX = event.clientX;
    dragStart = visibleStart;
    dragEnd = visibleStart + visibleWidth;
    window.addEventListener("pointermove", moveNavigatorDrag);
    window.addEventListener("pointerup", endNavigatorDrag);
  }

  /** Command. Maps navigator pointer movement to the visible world interval. */
  function moveNavigatorDrag(event) {
    const delta = (event.clientX - dragStartX) / navigatorElement.clientWidth * contentWidth;
    if (navigatorDrag === "pan") {
      setView(scale, (dragStart + delta) * scale);
      return;
    }
    if (navigatorDrag === "left") {
      const start = clamp(dragStart + delta, 0, dragEnd);
      if (start === dragEnd) return;
      const nextScale = viewportWidth / (dragEnd - start);
      setView(nextScale, start * nextScale, true);
      return;
    }
    if (navigatorDrag !== "right") return;
    const end = clamp(dragEnd + delta, dragStart, contentWidth);
    if (end === dragStart) return;
    const nextScale = viewportWidth / (end - dragStart);
    setView(nextScale, dragStart * nextScale, true);
  }

  /** Command. Releases the active navigator gesture and its window listeners. */
  function endNavigatorDrag() {
    navigatorDrag = "";
    window.removeEventListener("pointermove", moveNavigatorDrag);
    window.removeEventListener("pointerup", endNavigatorDrag);
  }

  $effect(() => {
    contentWidth;
    viewportWidth;
    untrack(() => {
      if (viewportWidth > 0) setView(minimumScale, 0, true);
    });
  });

  onDestroy(() => {
    cancelDeferredScroll();
    endNavigatorDrag();
  });
</script>

<div class="horizontal-viewport">
  <div class="navigator" bind:this={navigatorElement} role="group" aria-label="Horizontal viewport navigator">
    <div class="window" style={`left:${navigatorLeft}%;width:${navigatorWidth}%`}>
      <button class="edge" type="button" aria-label="Resize viewport from left" onpointerdown={event => beginNavigatorDrag("left", event)}></button>
      <button class="thumb" type="button" aria-label="Pan viewport" onpointerdown={event => beginNavigatorDrag("pan", event)}></button>
      <button class="edge" type="button" aria-label="Resize viewport from right" onpointerdown={event => beginNavigatorDrag("right", event)}></button>
    </div>
  </div>
  <div class="scroll" bind:this={scrollElement} bind:clientWidth={viewportWidth} onscroll={handleScroll} onwheel={handleWheel}>
    <div class="extent" style={`width:${totalWidth}px`}>
      {@render children({ scale, scrollLeft, viewportWidth, contentWidth, minimumScale })}
    </div>
  </div>
</div>

<style>
  .horizontal-viewport {
    display: grid;
    grid-template-rows: var(--horizontal-viewport-navigator-height, 1rem) minmax(0, 1fr);
    width: 100%;
    height: 100%;
  }

  .scroll {
    min-width: 0;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .extent {
    min-height: 100%;
  }

  .navigator {
    position: relative;
    border: var(--horizontal-viewport-line-width, 1px) solid var(--horizontal-viewport-line, currentColor);
  }

  .window {
    position: absolute;
    inset-block: 0;
    display: grid;
    grid-template-columns: var(--horizontal-viewport-hit-width, 0.5rem) minmax(0, 1fr) var(--horizontal-viewport-hit-width, 0.5rem);
    border: var(--horizontal-viewport-line-width, 1px) solid var(--horizontal-viewport-line, currentColor);
    background: var(--horizontal-viewport-window, color-mix(in srgb, currentColor 20%, transparent));
  }

  .edge,
  .thumb {
    min-height: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }

  .edge {
    cursor: ew-resize;
  }

  .thumb {
    cursor: grab;
  }
</style>
