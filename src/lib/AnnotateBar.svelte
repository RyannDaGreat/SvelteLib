<!--
  AnnotateBar [visual, general] — zoomable timeline with paintable label regions.

  Renders a horizontal time track for a single clip: colored label segments,
  a playhead, and density-adaptive tick marks. Handles the interaction layer
  only — it converts pointer/wheel gestures into time-domain callbacks and
  owns its own zoom/pan window. It holds NO annotation model and no video;
  the parent owns those and feeds segments down + applies edits on callback.

  Terms:
    - timeline cursor — the white playhead bar marking the displayed frame.
    - capture mode    — Pointer Lock scrub mode (cursor pinned to the bar's
                        mid-line, hidden OS cursor); horizontal motion scrubs.
    - proposed selection — the striped range under an active paint drag.

  Gestures:
    - left-drag            paint "good"  (and scrub to cursor)
    - right-drag           paint "bad"   (and scrub to cursor)
    - left+right drag      erase         (and scrub to cursor)
    - middle-drag          pan the timeline
    - left click (no drag) enter capture mode (Esc exits)
    - vertical wheel       zoom toward the timeline cursor (mouse wheel or two-finger vertical)
    - horizontal scroll    pan the timeline
    - pinch                zoom; min = whole clip visible (100%), zoom in for finer scrubbing

  In capture mode all the same buttons work against the pinned cursor, and
  pushing past the bar's edge pans the view (no scrub boundary).

  The paint mode tracks the live button chord — changing buttons mid-drag
  re-applies the whole stroke in the new mode (retroactive), since the parent
  recomputes from a stable base each onpaint call.

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
    /** @type {() => void} Begin a paint stroke (parent snapshots a stable base) */
    onpaintstart = () => {},
    /** @type {(mode:'good'|'bad'|'erase', t0:number, t1:number) => void}
        Apply the stroke against the parent's base snapshot. */
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
  // `view` is what's rendered; `targetView` is where wheel input is steering it.
  // Wheel changes ease view → targetView (smooths chunky discrete-scroll notches);
  // direct manipulation (drag/capture) jumps both at once.
  let view = $state({ start: 0, end: 0 });
  let targetView = { start: 0, end: 0 };
  let inited = false;
  let viewAnimId = null;
  let viewAnimLastMs = 0;
  const VIEW_SMOOTH_TAU_MS = 70; // exponential time constant for wheel easing
  const DISCRETE_WHEEL_PX = 40; // |delta| at/above this ⇒ a discrete wheel notch

  // Active drag stroke (not reactive — pointer bookkeeping).
  let drag = null; // { mode, startTime, lastClientX, downClientX, moved }

  // Pointer-lock "capture" scrub mode: a plain left click (no drag) locks the
  // cursor to the bar's mid-line; horizontal motion scrubs; Esc exits. Uses the
  // live element rect so it keeps working if the bar gets moved on the page.
  const CLICK_SLOP_PX = 4;
  let captured = $state(false);
  let captureX = 0; // virtual clientX accumulated from movementX (plain)

  // Proposed selection (the range under an active paint drag) — shown striped.
  let proposed = $state(null); // { lo, hi } in seconds, or null

  $effect(() => {
    // Initialise / re-fit the window when a clip's duration first arrives.
    if (duration > 0 && (!inited || view.end === 0)) {
      setViewNow({ start: 0, end: duration });
      inited = true;
    }
  });

  $effect(() => () => { if (viewAnimId != null) cancelAnimationFrame(viewAnimId); });

  /** Command. Jump the window immediately (direct manipulation: drag, capture). */
  function setViewNow(v) {
    if (viewAnimId != null) { cancelAnimationFrame(viewAnimId); viewAnimId = null; }
    targetView = v;
    view = v;
  }

  /** Command. Steer the window toward `v`, easing there over a few frames so a
      discrete mouse-wheel notch animates smoothly instead of snapping. */
  function animateViewTo(v) {
    targetView = v;
    if (viewAnimId == null) {
      viewAnimLastMs = performance.now();
      viewAnimId = requestAnimationFrame(viewAnimTick);
    }
  }

  function viewAnimTick(now) {
    const dt = now - viewAnimLastMs;
    viewAnimLastMs = now;
    const k = 1 - Math.exp(-dt / VIEW_SMOOTH_TAU_MS); // frame-rate independent
    const start = view.start + (targetView.start - view.start) * k;
    const end = view.end + (targetView.end - view.end) * k;
    const settled = Math.abs(targetView.start - start) < 1e-3 && Math.abs(targetView.end - end) < 1e-3;
    view = settled ? { ...targetView } : { start, end };
    if (captured) syncCaptureToPlayhead();
    viewAnimId = settled ? null : requestAnimationFrame(viewAnimTick);
  }

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

  // -- Wheel: zoom + pan (exported so the parent can forward video-area wheels) --

  /** Command. Vertical scroll (mouse wheel OR two-finger vertical) and pinch
      both zoom about the cursor; horizontal scroll pans the timeline. */
  export function handleWheel(e) {
    if (!barEl || duration <= 0) return;
    e.preventDefault();
    const horizontalPan = !e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY);
    // A discrete mouse wheel arrives as sparse, chunky notches (line mode, or
    // big pixel deltas) — ease those for a smooth zoom. A trackpad streams tiny
    // continuous deltas that are already smooth, so apply those instantly.
    const discrete =
      e.deltaMode !== 0 ||
      Math.abs(e.deltaY) >= DISCRETE_WHEEL_PX ||
      Math.abs(e.deltaX) >= DISCRETE_WHEEL_PX;
    const apply = discrete ? animateViewTo : setViewNow;
    // Steer the *target* (so rapid notches accumulate) and ease the view there.
    if (horizontalPan) {
      apply(panView(targetView, e.deltaX, width, duration));
    } else {
      // Zoom anchored to the timeline cursor (playhead), NOT the mouse — keeps
      // the current frame fixed on screen instead of drifting toward the bar
      // centre (which is where an over-the-video mouse maps to).
      const targetVisible = targetView.end - targetView.start;
      const focalFrac = clamp((currentTime - targetView.start) / targetVisible, 0, 1);
      apply(zoomView(targetView, focalFrac, expZoomFactor(e.deltaY), duration));
    }
    // Panning slides the timeline under a still cursor, so the time it covers
    // changes — re-emit so the active paint / preview follows. Zoom keeps the
    // focal time fixed, so it needs no re-seek (re-seeking caused a "jump to
    // centre" glitch).
    if (drag?.kind === "paint") {
      applyPaint(e.clientX);
    } else if (!drag && horizontalPan) {
      const r = barEl.getBoundingClientRect();
      const overBar =
        e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top && e.clientY <= r.bottom;
      if (overBar) onhover(timeAt(e.clientX), e.clientX);
    }
    // In capture mode the view just moved under the locked cursor — pull the
    // virtual cursor back onto the timeline cursor so they stay locked and the
    // next movementX continues from the right place.
    if (captured) syncCaptureToPlayhead();
  }

  // -- Pointer: scrub + paint/erase + pan --

  /** Pure. Paint mode from the pressed-button bitmask (1=left, 2=right, 4=middle).
      Left+Right held together = erase. Null when no paint button is down.

      @example paintModeFromButtons(1) // 'good'
      @example paintModeFromButtons(2) // 'bad'
      @example paintModeFromButtons(3) // 'erase' (left+right)
      @example paintModeFromButtons(4) // null (middle only) */
  function paintModeFromButtons(buttons) {
    const left = buttons & 1;
    const right = buttons & 2;
    if (left && right) return "erase";
    if (right) return "bad";
    if (left) return "good";
    return null;
  }

  function applyPaint(clientX) {
    const t = timeAt(clientX);
    drag.lastClientX = clientX;
    if (Math.abs(clientX - drag.downClientX) > CLICK_SLOP_PX) drag.moved = true;
    proposed = { lo: Math.min(drag.startTime, t), hi: Math.max(drag.startTime, t) };
    onseek(t);
    onpaint(drag.mode, drag.startTime, t);
  }

  /** Recompute a paint drag's mode from the live button chord, then re-apply the
      whole stroke against the parent's stable base — so changing buttons
      mid-drag is retroactive, as if that mode had been used from the start. */
  function repaint(buttons, x) {
    const mode = paintModeFromButtons(buttons);
    if (mode) {
      drag.mode = mode;
      if (mode !== "good") drag.everNonGood = true;
    }
    applyPaint(x);
  }

  /** Grab-style pan by a pixel delta — dragging right reveals earlier content.
      Direct manipulation, so it jumps immediately (no easing). */
  function panBy(dxPx) {
    setViewNow(panView(view, -dxPx, width, duration));
  }

  function startPaint(x, buttons) {
    drag = {
      kind: "paint",
      mode: paintModeFromButtons(buttons) ?? "good",
      startTime: timeAt(x),
      downClientX: x,
      lastClientX: x,
      moved: false,
      everNonGood: false,
    };
    onpaintstart();
    repaint(buttons, x);
  }

  function endPaintDrag() {
    proposed = null;
    if (drag?.kind === "paint") onpaintend();
    drag = null;
  }

  function enterCapture(clientX) {
    const rect = barEl.getBoundingClientRect();
    captureX = clamp(clientX, rect.left, rect.right);
    barEl.requestPointerLock?.();
  }

  /** Snap the virtual cursor onto the timeline cursor (playhead) so the capture
      circle and playhead are the same position by construction — keeps them
      locked through zoom/pan, and keeps movementX continuing from the right x. */
  function syncCaptureToPlayhead() {
    if (!barEl) return;
    captureX = barEl.getBoundingClientRect().left + clamp(playheadX, 0, width);
  }

  // -- Normal pointer handlers (clientX-driven) --

  function onPointerDown(e) {
    if (duration <= 0 || captured || drag) return;
    e.preventDefault();
    /* Best-effort capture so a drag keeps tracking past the bar's edges.
       Expected to reject when there's no active pointer (e.g. synthetic
       events in tests); the drag still works without it, so ignore that. */
    try {
      barEl.setPointerCapture(e.pointerId);
    } catch (err) {
      if (err.name !== "InvalidStateError" && err.name !== "NotFoundError") throw err;
    }
    if (e.button === 1) {
      drag = { kind: "pan", lastClientX: e.clientX }; // middle button → pan
      return;
    }
    startPaint(e.clientX, e.buttons);
    onhover(drag.startTime, e.clientX);
  }

  function onPointerMove(e) {
    if (captured) return; // capture mode is driven by movementX, not clientX
    if (!drag) {
      onhover(timeAt(e.clientX), e.clientX); // preview the frame under the cursor
    } else if (drag.kind === "pan") {
      panBy(e.clientX - drag.lastClientX);
      drag.lastClientX = e.clientX;
    } else {
      repaint(e.buttons, e.clientX);
    }
  }

  function onPointerUp(e) {
    if (!drag || captured) return;
    // Per the spec, pointerup fires when the LAST button is released (buttons→0).
    // If a button of this drag is still held (a chord release), keep going so the
    // mode change re-applies retroactively rather than ending the stroke.
    if (drag.kind === "paint" && e.buttons & 3) return repaint(e.buttons, e.clientX);
    if (drag.kind === "pan" && e.buttons & 4) {
      panBy(e.clientX - drag.lastClientX);
      drag.lastClientX = e.clientX;
      return;
    }
    barEl.releasePointerCapture?.(e.pointerId);
    const wasPaint = drag.kind === "paint";
    // A plain left click (no drag, only ever "good") enters capture scrub mode.
    const click = wasPaint && !drag.moved && !drag.everNonGood;
    const upX = e.clientX;
    endPaintDrag();
    if (click) enterCapture(upX);
    else if (wasPaint) onhover(timeAt(upX), upX);
  }

  function onPointerLeave() {
    if (!drag && !captured) onhoverleave();
  }

  // -- Capture scrub mode (Pointer Lock), driven by movementX -----------------

  /** All buttons work while captured, against the virtual (pinned) cursor. */
  function onCaptureDown(e) {
    if (!captured || drag) return;
    if (e.button === 1) drag = { kind: "pan", lastClientX: captureX };
    else startPaint(captureX, e.buttons);
  }

  function onCaptureMove(e) {
    if (!captured || !barEl) return;
    if (drag?.kind === "pan") { panBy(e.movementX); syncCaptureToPlayhead(); return; }
    // Move the virtual cursor; at the bar's edge, push past it by panning the
    // view instead of stopping — pointer lock keeps movementX coming even at the
    // screen edge, so there's no boundary.
    const rect = barEl.getBoundingClientRect();
    const next = captureX + e.movementX;
    if (next < rect.left) {
      setViewNow(panView(view, next - rect.left, width, duration)); // pan earlier
      captureX = rect.left;
    } else if (next > rect.right) {
      setViewNow(panView(view, next - rect.right, width, duration)); // pan later
      captureX = rect.right;
    } else {
      captureX = next;
    }
    // onseek/repaint set currentTime = timeAt(captureX), so the playhead lands at
    // captureX − left — i.e. exactly where the capture circle renders. Locked.
    if (drag) repaint(e.buttons, captureX);
    else onseek(timeAt(captureX));
  }

  function onCaptureUp(e) {
    if (!captured || !drag) return;
    if (drag.kind === "paint" && e.buttons & 3) return repaint(e.buttons, captureX);
    if (drag.kind === "pan" && e.buttons & 4) return;
    endPaintDrag();
  }

  $effect(() => {
    function onLockChange() {
      captured = document.pointerLockElement === barEl;
      if (!captured) { endPaintDrag(); onhoverleave(); }
    }
    function onLockError() {
      // Browsers reject re-locking too soon after an Esc exit — expected; surface it.
      console.warn("AnnotateBar: pointer lock request was rejected");
    }
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    document.addEventListener("mousedown", onCaptureDown);
    document.addEventListener("mousemove", onCaptureMove);
    document.addEventListener("mouseup", onCaptureUp);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      document.removeEventListener("mousedown", onCaptureDown);
      document.removeEventListener("mousemove", onCaptureMove);
      document.removeEventListener("mouseup", onCaptureUp);
    };
  });
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

    {#if proposed}
      {@const px = xOf(proposed.lo)}
      <!-- Proposed selection under an active drag: striped diagonal hatch. -->
      <div class="proposed" style="left: {px}px; width: {xOf(proposed.hi) - px}px"></div>
    {/if}

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

  {#if captured}
    <!-- Capture cursor: rendered AT the playhead so the two are locked by construction. -->
    <div class="capture-cursor" style="left: {playheadX}px"></div>
  {/if}

  <div class="labels">
    {#each majorTicks as tick}
      <span class="label" style="left: {tick.x}px">{tick.label}</span>
    {/each}
  </div>
</div>

<style>
  .annotate {
    /* -- Themeable custom properties -- */
    --bar-height: 100px;
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
    /* Proposed-selection diagonal hatch: solid 5px white + 1px black, no gaps. */
    --proposed-white: 5px;
    --proposed-black: 1px;

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

  /* Proposed selection (active drag): solid 45° white/black hatch at 20% opacity,
     no gaps. background-attachment: fixed anchors the pattern to the viewport so
     it stays put globally while the selection slides over it like a window. */
  .proposed {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    pointer-events: none;
    background-image: repeating-linear-gradient(
      45deg,
      rgba(255, 255, 255, 0.2) 0 var(--proposed-white),
      rgba(0, 0, 0, 0.2) var(--proposed-white) calc(var(--proposed-white) + var(--proposed-black))
    );
    background-attachment: fixed;
  }

  /* -- Tick lines (drawn on the bar, anchored to its bottom edge) -- */
  .ticks {
    position: absolute;
    inset: 0;
    z-index: 2; /* above the proposed-selection hatch */
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

  /* -- Capture (pointer-lock) scrub mode -- */
  .capture-cursor {
    position: absolute;
    top: calc(var(--bar-height) / 2);
    width: var(--capture-cursor-size, 14px);
    height: var(--capture-cursor-size, 14px);
    margin-top: calc(var(--capture-cursor-size, 14px) / -2);
    margin-left: calc(var(--capture-cursor-size, 14px) / -2);
    border-radius: 50%;
    background: var(--playhead-color);
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.6);
    pointer-events: none;
    z-index: 3;
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
