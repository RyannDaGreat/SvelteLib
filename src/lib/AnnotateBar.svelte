<!--
  AnnotateBar [visual, general] — zoomable timeline with paintable label regions.

  Renders a horizontal time track for a single clip: colored label segments,
  a playhead, and density-adaptive tick marks. Handles the interaction layer
  only — it converts pointer/wheel gestures into time-domain callbacks and
  owns its own zoom/pan window. It holds NO annotation model and no video;
  the parent owns those and feeds segments down + applies edits on callback.

  Gestures:
    - left-drag           paint "good"  (and scrub to cursor)
    - right-drag          paint "bad"   (and scrub to cursor)
    - middle / alt+left   erase         (and scrub to cursor)
    - two-finger pan      scroll the timeline (wheel deltaX/deltaY)
    - pinch               zoom; min = whole clip visible (100%), zoom in for finer scrubbing

  The parent forwards wheel events from anywhere in the widget via the
  exported handleWheel(e) so pinch/pan work over the video too.

  Usage:
    <AnnotateBar
      bind:this={bar}
      {duration} {currentTime} {segments}
      onseek={(t) => ...}
      onpaintstart={(mode) => ...}
      onpaint={(t0, t1) => ...}
      onpaintend={() => ...}
    />
-->
<script>
  // -- Pure functions (general) -----------------------------------------------

  /**
   * Pure function, general. Clamp value to [min, max].
   *
   * @example clamp(5, 0, 10) // 5
   * @example clamp(-3, 0, 10) // 0
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Pure function, general. Exponential zoom factor from a wheel delta.
   * Matches PanZoom's convention: negative delta (pinch out) zooms in (>1).
   *
   * @example expZoomFactor(-100) // ~2 (zoom in)
   * @example expZoomFactor(100) // ~0.5 (zoom out)
   * @example expZoomFactor(0) // 1
   */
  function expZoomFactor(deltaY, sensitivity = 0.01) {
    return Math.pow(2, -deltaY * sensitivity);
  }

  /**
   * Pure function, general. Round a raw spacing up to a "nice" 1-2-5 step.
   * Used so tick intervals land on human-friendly values (…0.5, 1, 2, 5, 10…).
   *
   * @example niceStep(0.8) // 1
   * @example niceStep(3) // 5
   * @example niceStep(0.03) // 0.05
   */
  function niceStep(target) {
    if (target <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const norm = target / pow;
    const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return mult * pow;
  }

  /**
   * Pure function, general. Format a timeline tick as M:SS, adding a decimal
   * when the step is sub-second so finely-zoomed ticks stay distinct.
   *
   * @example formatTick(65, 5) // "1:05"
   * @example formatTick(3.4, 0.2) // "0:03.4"
   */
  function formatTick(seconds, step) {
    if (!Number.isFinite(seconds)) return "";
    const m = Math.floor(seconds / 60);
    const whole = Math.floor(seconds % 60);
    if (step < 1) {
      const dec = Math.round((seconds - Math.floor(seconds)) * 10);
      return `${m}:${whole.toString().padStart(2, "0")}.${dec}`;
    }
    return `${m}:${whole.toString().padStart(2, "0")}`;
  }

  // Target pixel spacing between labelled (major) ticks.
  const TARGET_MAJOR_PX = 90;
  // Minor ticks per major tick.
  const MINORS_PER_MAJOR = 5;
  // Minor-tick spacing (px) at which they fully appear / fully fade.
  const MINOR_FADE_LO_PX = 4;
  const MINOR_FADE_HI_PX = 14;
  // Smallest visible window (seconds) — limits how far you can zoom in.
  const MIN_VISIBLE_S = 0.4;

  /**
   * Pure function, general. Build tick marks for a visible time window.
   *
   * Returns minor ticks (lines only, with a density-based opacity that fades
   * them out as they crowd) and flags which coincide with a major step
   * (taller, labelled). x is in pixels within a track of the given width.
   *
   * @param {number} viewStart - window start (s)
   * @param {number} viewEnd - window end (s)
   * @param {number} width - track width (px)
   * @returns {{ticks: {t:number,x:number,major:boolean,label:string}[], minorOpacity:number}}
   *
   * @example
   * // computeTicks(0, 10, 900)
   * // -> major step 1s, minors every 0.2s, opacity 1, labels "0:00","0:01",…
   */
  function computeTicks(viewStart, viewEnd, width) {
    const visible = viewEnd - viewStart;
    if (!(visible > 0) || !(width > 0)) return { ticks: [], minorOpacity: 0 };
    const pxPerSec = width / visible;
    const majorStep = niceStep(TARGET_MAJOR_PX / pxPerSec);
    const minorStep = majorStep / MINORS_PER_MAJOR;
    const minorPx = minorStep * pxPerSec;
    const minorOpacity = clamp(
      (minorPx - MINOR_FADE_LO_PX) / (MINOR_FADE_HI_PX - MINOR_FADE_LO_PX),
      0,
      1,
    );

    const ticks = [];
    const firstIdx = Math.ceil(viewStart / minorStep);
    for (let i = firstIdx; ; i++) {
      const t = i * minorStep;
      if (t > viewEnd) break;
      const majorRatio = t / majorStep;
      const major = Math.abs(majorRatio - Math.round(majorRatio)) < 1e-6;
      ticks.push({
        t,
        x: ((t - viewStart) / visible) * width,
        major,
        label: major ? formatTick(t, majorStep) : "",
      });
    }
    return { ticks, minorOpacity };
  }

  /**
   * Pure function, general. New visible window after a pinch-zoom about a focal
   * point, clamped so it never exceeds the full clip nor shrinks past MIN_VISIBLE_S.
   * The focal time stays pinned under the cursor.
   *
   * @param {{start:number,end:number}} view - current window (s)
   * @param {number} focalFrac - cursor position within track, 0..1
   * @param {number} factor - zoom factor (>1 zooms in)
   * @param {number} duration - full clip length (s)
   * @returns {{start:number,end:number}}
   *
   * @example
   * // zoomView({start:0,end:10}, 0.5, 2, 10) -> {start:2.5, end:7.5}
   */
  function zoomView(view, focalFrac, factor, duration) {
    const visible = view.end - view.start;
    const focalT = view.start + focalFrac * visible;
    const newVisible = clamp(visible / factor, Math.min(MIN_VISIBLE_S, duration), duration);
    let start = focalT - focalFrac * newVisible;
    start = clamp(start, 0, duration - newVisible);
    return { start, end: start + newVisible };
  }

  /**
   * Pure function, general. New window after panning by a pixel delta, clamped
   * to the clip. Positive dxPx scrolls content left (view moves right in time).
   *
   * @example
   * // panView({start:2,end:7}, 90, 900, 20) -> {start:2.5, end:7.5}
   */
  function panView(view, dxPx, width, duration) {
    const visible = view.end - view.start;
    const dt = (dxPx / width) * visible;
    let start = clamp(view.start + dt, 0, duration - visible);
    return { start, end: start + visible };
  }

  // -- Component --------------------------------------------------------------

  let {
    /** @type {number} Clip duration in seconds */
    duration = 0,
    /** @type {number} Playhead position in seconds */
    currentTime = 0,
    /** @type {{start:number,end:number,label:'good'|'bad'}[]} Disjoint label segments */
    segments = [],
    /** @type {(t:number) => void} Seek request (paint drag also seeks) */
    onseek = () => {},
    /** @type {(mode:'good'|'bad'|'erase') => void} Begin a paint stroke */
    onpaintstart = () => {},
    /** @type {(t0:number, t1:number) => void} Update the active stroke's range */
    onpaint = () => {},
    /** @type {() => void} Commit the active stroke */
    onpaintend = () => {},
    /** @type {(t:number, clientX:number) => void} Cursor hovering the bar (not dragging) */
    onhover = () => {},
    /** @type {() => void} Cursor left the bar */
    onhoverleave = () => {},
  } = $props();

  /** @type {HTMLDivElement|undefined} */
  let barEl = $state(undefined);
  let width = $state(0);

  // Zoom/pan window over the clip (seconds). Initialised to full clip.
  let view = $state({ start: 0, end: 0 });
  let inited = false;

  // Active drag stroke (not reactive — pointer bookkeeping).
  let drag = null; // { mode, startTime, lastClientX }

  $effect(() => {
    // Initialise / re-fit the window when a clip's duration first arrives.
    if (duration > 0 && (!inited || view.end === 0)) {
      view = { start: 0, end: duration };
      inited = true;
    }
  });

  let visible = $derived(view.end - view.start || duration || 1);

  /** Query. Map a clientX (px) to clip time, clamped to the clip. */
  function timeAt(clientX) {
    const rect = barEl.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return clamp(view.start + frac * visible, 0, duration);
  }

  /** Pure. Map a clip time to an x offset (px) within the current window. */
  function xOf(t) {
    return ((t - view.start) / visible) * width;
  }

  let playheadX = $derived(xOf(currentTime));
  let tickData = $derived(computeTicks(view.start, view.end, width));
  let majorTicks = $derived(tickData.ticks.filter((t) => t.major));

  /** Pure. Pixel rect for a segment within the current window. */
  function segRect(seg) {
    const left = xOf(seg.start);
    return { left, width: xOf(seg.end) - left };
  }

  // -- Wheel: pan + pinch-zoom (exported so the parent can forward video-area wheels) --

  /** Command. Handle a wheel event as timeline pan (plain) or zoom (ctrl/pinch). */
  export function handleWheel(e) {
    if (!barEl || duration <= 0) return;
    e.preventDefault();
    if (e.ctrlKey) {
      const rect = barEl.getBoundingClientRect();
      const focalFrac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      view = zoomView(view, focalFrac, expZoomFactor(e.deltaY), duration);
    } else {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      view = panView(view, dx, width, duration);
    }
    // A pan/zoom under a held drag changes which time the cursor covers.
    if (drag) applyDrag(drag.lastClientX);
  }

  // -- Pointer: scrub + paint/erase --

  /** Pure. Pick a paint mode from mouse button + modifiers. */
  function modeFor(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) return "erase";
    if (e.button === 2) return "bad";
    return "good";
  }

  function applyDrag(clientX) {
    const t = timeAt(clientX);
    drag.lastClientX = clientX;
    onseek(t);
    onpaint(drag.startTime, t);
  }

  function onPointerDown(e) {
    if (duration <= 0) return;
    e.preventDefault();
    /* Best-effort capture so a drag keeps tracking past the bar's edges.
       Expected to reject when there's no active pointer (e.g. synthetic
       events in tests); the drag still works without it, so ignore that. */
    try {
      barEl.setPointerCapture(e.pointerId);
    } catch (err) {
      if (err.name !== "InvalidStateError" && err.name !== "NotFoundError") throw err;
    }
    const mode = modeFor(e);
    const startTime = timeAt(e.clientX);
    drag = { mode, startTime, lastClientX: e.clientX };
    onpaintstart(mode);
    applyDrag(e.clientX);
    onhover(startTime, e.clientX);
  }

  function onPointerMove(e) {
    if (drag) applyDrag(e.clientX);
    // Preview the frame under the cursor whether or not a drag is in progress.
    onhover(timeAt(e.clientX), e.clientX);
  }

  function onPointerUp(e) {
    if (!drag) return;
    barEl.releasePointerCapture?.(e.pointerId);
    drag = null;
    onpaintend();
    onhover(timeAt(e.clientX), e.clientX);
  }

  function onPointerLeave() {
    if (!drag) onhoverleave();
  }
</script>

<div class="annotate" style="--playhead-x: {playheadX}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="bar"
    bind:this={barEl}
    bind:clientWidth={width}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={onPointerLeave}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each segments as seg}
      {@const r = segRect(seg)}
      <div
        class="seg seg-{seg.label}"
        style="left: {r.left}px; width: {r.width}px"
      ></div>
    {/each}

    <div class="ticks">
      {#each tickData.ticks as tick}
        <div
          class="tick"
          class:major={tick.major}
          style="left: {tick.x}px; opacity: {tick.major ? 1 : tickData.minorOpacity}"
        ></div>
      {/each}
    </div>
  </div>

  <div class="playhead"><span class="cap cap-top"></span><span class="cap cap-bottom"></span></div>

  <div class="labels">
    {#each majorTicks as tick}
      <span class="label" style="left: {tick.x}px">{tick.label}</span>
    {/each}
  </div>
</div>

<style>
  .annotate {
    /* -- Themeable custom properties -- */
    --bar-height: 50px;
    --bar-bg: #2b2b3a;
    --bar-radius: 6px;
    --seg-good: #3fb950;
    --seg-bad: #e5534b;
    --tick-color: rgba(255, 255, 255, 0.35);
    --tick-major-color: rgba(255, 255, 255, 0.6);
    --tick-minor-height: 8px;
    --tick-major-height: 14px;
    --playhead-color: #ffffff;
    --playhead-width: 2px;
    --playhead-overhang: 6px;
    --playhead-cap: 6px;
    --label-color: #999;
    --label-size: 0.7rem;

    position: relative;
    width: 100%;
    user-select: none;
    touch-action: none;
  }

  .bar {
    position: relative;
    width: 100%;
    height: var(--bar-height);
    background: var(--bar-bg);
    border-radius: var(--bar-radius);
    overflow: hidden;
    cursor: crosshair;
  }

  /* -- Label regions -- */
  .seg {
    position: absolute;
    top: 0;
    bottom: 0;
  }
  .seg-good {
    background: var(--seg-good);
  }
  .seg-bad {
    background: var(--seg-bad);
  }

  /* -- Tick lines (drawn on the bar, anchored to its bottom edge) -- */
  .ticks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .tick {
    position: absolute;
    bottom: 0;
    width: 1px;
    height: var(--tick-minor-height);
    background: var(--tick-color);
  }
  .tick.major {
    height: var(--tick-major-height);
    background: var(--tick-major-color);
  }

  /* -- Playhead: thin white bar overhanging the track with rounded caps -- */
  .playhead {
    position: absolute;
    top: calc(-1 * var(--playhead-overhang));
    height: calc(var(--bar-height) + 2 * var(--playhead-overhang));
    left: var(--playhead-x);
    width: var(--playhead-width);
    margin-left: calc(var(--playhead-width) / -2);
    background: var(--playhead-color);
    pointer-events: none;
  }
  .cap {
    position: absolute;
    left: 50%;
    width: var(--playhead-cap);
    height: var(--playhead-cap);
    margin-left: calc(var(--playhead-cap) / -2);
    background: var(--playhead-color);
    border-radius: 50%;
  }
  .cap-top {
    top: calc(-1 * var(--playhead-cap) / 2);
  }
  .cap-bottom {
    bottom: calc(-1 * var(--playhead-cap) / 2);
  }

  /* -- Timestamp labels under the bar -- */
  .labels {
    position: relative;
    height: 1rem;
    margin-top: 4px;
  }
  .label {
    position: absolute;
    transform: translateX(-50%);
    color: var(--label-color);
    font-size: var(--label-size);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
