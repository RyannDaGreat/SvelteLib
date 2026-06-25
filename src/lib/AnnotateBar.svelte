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
  import "iconify-icon";
  import { makeStripeCanvas } from "./stripes.js";

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
    /** @type {{id:string,time:number,text:string}[]} Comment markers (bindable) */
    comments = $bindable([]),
    /** @type {(time:number) => void} A comment was clicked — jump the playhead there */
    oncommentjump = () => {},
    /** @type {() => void} Comments changed (added/edited/deleted) — for save/undo */
    oncommentschange = () => {},
    /** @type {boolean} Bindable — true while in pointer-lock capture scrub mode */
    captured = $bindable(false),
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
  let lastFitDuration = -1; // the duration we last fit the window to (per-clip)
  let viewAnimId = null;
  let viewAnimLastMs = 0;
  const VIEW_SMOOTH_TAU_MS = 32; // EMA time constant for wheel easing (snappy)
  const DISCRETE_WHEEL_PX = 40; // |delta| at/above this ⇒ a discrete wheel notch

  // Active drag stroke (not reactive — pointer bookkeeping).
  let drag = null; // { mode, startTime, lastClientX, downClientX, moved }

  // Pointer-lock "capture" scrub mode: a plain left click (no drag) locks the
  // cursor to the bar's mid-line; horizontal motion scrubs; Esc exits. Uses the
  // live element rect so it keeps working if the bar gets moved on the page.
  const CLICK_SLOP_PX = 4;
  const SLOW_SCRUB_FACTOR = 0.25; // Shift in capture mode → 4× slower scrubbing
  const EDGE_LEAD_FRAC = 0.1; // capture edge-scroll keeps 10% lead ahead of cursor
  // Releasing one button of an L+R (erase) chord starts this window: if the other
  // releases within it, the two count as released TOGETHER → the erase commits.
  // If it expires with one still held, we fall to that button's mode (good/bad).
  const CHORD_RELEASE_MS = 100;
  let chordTimer = null;
  // `captured` is a bindable prop (declared above) so the app can read it.
  let captureX = 0; // virtual clientX accumulated from movementX (plain)

  // Proposed selection (the range under an active paint drag) — shown striped.
  let proposed = $state(null); // { lo, hi } in seconds, or null

  // Comments: time-positioned markers floating above the bar.
  let hovered = $state(false); // pointer is over the timeline (for the C hotkey)
  let editingId = $state(null); // id of the comment being typed, or null
  let hoverCommentId = $state(null); // comment under the pointer → expand it
  let draft = $state(""); // text being typed for editingId
  const ON_TIMECODE_PX = 9; // playhead within this many px of a comment expands it
  const COMMENT_BOX_HALF_PX = 256; // half of --comment-max-w — for edge-clamping the box

  $effect(() => {
    // Fit the window to the whole clip whenever a NEW clip arrives (its duration
    // differs) — so selecting a clip RESETS the timeline's zoom/pan. A repeat of
    // the same duration is left alone, preserving a manual zoom. (view.end === 0
    // also re-fits, covering a collapsed/uninitialised window.)
    if (duration > 0 && (duration !== lastFitDuration || view.end === 0)) {
      setViewNow({ start: 0, end: duration });
      lastFitDuration = duration;
    }
  });

  $effect(() => () => {
    if (viewAnimId != null) cancelAnimationFrame(viewAnimId);
    clearChordTimeout();
  });

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
    // Snap once the remaining move is sub-pixel — kills the slow asymptotic tail
    // so it stops crisply instead of creeping.
    const eps = (0.5 / Math.max(width, 1)) * (end - start || 1);
    const settled = Math.abs(targetView.start - start) < eps && Math.abs(targetView.end - end) < eps;
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

  // Proposed-selection hatch: a crisp 45° canvas tile (5px white + 1px black,
  // both at 20%) built with the SAME makeStripeCanvas() the video backdrop uses.
  // Recomputed on dpr change; exposed on the root as --proposed-bg.
  const PROPOSED_WHITE = "rgba(255, 255, 255, 0.2)";
  const PROPOSED_BLACK = "rgba(0, 0, 0, 0.2)";
  const PROPOSED_WHITE_PX = 5;
  const PROPOSED_BLACK_PX = 1;
  let proposedBg = $state("");
  $effect(() => {
    const dpr = window.devicePixelRatio || 1;
    const { url, cssSize } = makeStripeCanvas(
      [
        { color: PROPOSED_WHITE, width: PROPOSED_WHITE_PX },
        { color: PROPOSED_BLACK, width: PROPOSED_BLACK_PX },
      ],
      dpr,
    );
    proposedBg = `--proposed-bg: url('${url}'); --proposed-bg-size: ${cssSize}px ${cssSize}px;`;
  });

  // Scroll affordance: chevrons fade in when the window hides clip content to a
  // side (you can pan/zoom there, you just can't see it yet).
  const EDGE_EPS = 1e-3;
  let moreLeft = $derived(view.start > EDGE_EPS);
  let moreRight = $derived(duration > 0 && view.end < duration - EDGE_EPS);

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
      // In capture mode the OS cursor is locked, so e.clientX is frozen at the
      // lock-entry point — using it would teleport the playhead there. Paint at
      // the virtual captureX instead; in normal mode e.clientX is the real cursor.
      applyPaint(captured ? captureX : e.clientX);
    } else if (!drag && !captured && horizontalPan) {
      // Hover-preview only in normal mode — in capture the cursor is locked, so
      // e.clientX is frozen and would teleport the playhead. The playhead stays
      // put under the locked cursor (synced below).
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

  /** Pure. Paint mode from the pressed-button bitmask (1=left, 2=right, 4=middle)
      plus the alt modifier. Left+Right together OR alt+Left = erase. Null when no
      paint button is down.

      @example paintModeFromButtons(1) // 'good'
      @example paintModeFromButtons(2) // 'bad'
      @example paintModeFromButtons(3) // 'erase' (left+right)
      @example paintModeFromButtons(1, true) // 'erase' (alt+left)
      @example paintModeFromButtons(4) // null (middle only) */
  function paintModeFromButtons(buttons, alt = false) {
    const left = buttons & 1;
    const right = buttons & 2;
    if ((left && right) || (alt && left)) return "erase";
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

  /** Recompute a paint drag's mode from the live button chord (+ alt), then
      re-apply the whole stroke against the parent's stable base — so changing
      buttons/modifiers mid-drag is retroactive, as if used from the start.

      Erase is STICKY for the rest of the stroke once an L+R chord has been seen
      (drag.everChord): the two buttons rarely release on the exact same event,
      so without this, dropping one would momentarily recompute the held button's
      mode (good/bad) and commit that instead of the erase. The chord-release
      window (scheduleChordRelease) is what later clears everChord to fall to a
      single button's mode when one is deliberately held past CHORD_RELEASE_MS. */
  function repaint(buttons, x, alt = false) {
    clearChordTimeout(); // any deliberate re-apply resolves a pending chord window
    const mode = drag.everChord ? "erase" : paintModeFromButtons(buttons, alt);
    if (mode) {
      drag.mode = mode;
      if (mode !== "good") drag.everNonGood = true;
    }
    applyPaint(x);
  }

  /** Command. Fold an event's live button bitmask into the active paint stroke:
      latch drag.everChord once both left+right are down together, then update
      drag.lastButtons. Returns { pressedNew, releasedOld } — which paint buttons
      (1|2) appeared / disappeared since the last event.

      This is the heart of the chord fix. Empirically (verified by Puppeteer):
        - Pressing a 2nd mouse button while the first is held does NOT fire a
          fresh pointerdown — it arrives as a pointermove with buttons & 3 === 3.
        - RELEASING one button of an L+R chord while the other stays held also
          arrives as a pointermove (buttons drops 3→1 or 3→2), NOT a pointerup.
      So both the chord press AND the partial chord release surface through the
      move handler, and every pointer handler (down/move/up + capture equivalents)
      routes its buttons through here — the chord is detected from whatever event
      actually carries the change, never relying on a specific event type firing. */
  function noteButtons(buttons) {
    const prev = drag.lastButtons;
    const pressedNew = buttons & ~prev & 3;
    const releasedOld = prev & ~buttons & 3;
    drag.lastButtons = buttons;
    if ((buttons & 3) === 3) drag.everChord = true;
    return { pressedNew, releasedOld };
  }

  function clearChordTimeout() {
    if (chordTimer != null) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
  }
  /** After a partial chord release (one button up, one still held), wait
      CHORD_RELEASE_MS. If the stroke is still alive when it fires — i.e. the
      other button did NOT come up together — drop the sticky-erase latch and
      fall to the held button's mode (the erase was abandoned, not committed). */
  function scheduleChordRelease(buttons, alt) {
    clearChordTimeout();
    chordTimer = setTimeout(() => {
      chordTimer = null;
      if (drag?.kind === "paint") {
        drag.everChord = false; // window expired with one held → no longer an erase
        drag.lastButtons = buttons;
        repaint(buttons, drag.lastClientX, alt);
      }
    }, CHORD_RELEASE_MS);
  }

  /** Grab-style pan by a pixel delta — dragging right reveals earlier content.
      Direct manipulation, so it jumps immediately (no easing). */
  function panBy(dxPx) {
    setViewNow(panView(view, -dxPx, width, duration));
  }

  function startPaint(x, buttons, alt = false) {
    drag = {
      kind: "paint",
      mode: paintModeFromButtons(buttons, alt) ?? "good",
      startTime: timeAt(x),
      downClientX: x,
      lastClientX: x,
      lastButtons: 0,
      moved: false,
      everNonGood: false,
      everChord: false, // sticky once an L+R chord is seen (see noteButtons)
    };
    noteButtons(buttons); // latch everChord if the press already starts chorded
    onpaintstart();
    repaint(buttons, x, alt);
  }

  /** Update a paint stroke from a move/chord event. Folds the live buttons in,
      then:
        - If a paint button was RELEASED while erase is latched and one paint
          button is still held, this is a partial chord release (it arrives as a
          pointermove, not a pointerup). Keep erase and start the chord-release
          window — do NOT recompute, or it would revert to the held button's mode
          and commit good/bad instead of the erase.
        - Otherwise repaint when the cursor MOVED or a NEW button was pressed.
      A release with no paint button left is the stroke's end, handled by *Up. */
  function paintMove(buttons, x, alt) {
    const { pressedNew, releasedOld } = noteButtons(buttons);
    // A partial chord release (erase latched, one paint button still held).
    if (drag.everChord && releasedOld && buttons & 3) {
      if (chordTimer == null) scheduleChordRelease(buttons, alt);
      applyPaint(x); // keep erasing under the cursor while the window decides
      return;
    }
    // While the chord-release window is pending, a new press re-commits to the
    // chord; anything else just keeps the current (erase) mode under the cursor —
    // applyPaint, NOT repaint, so the pending window is not cleared.
    if (chordTimer != null && !pressedNew) {
      if (x !== drag.lastClientX) applyPaint(x);
      return;
    }
    if (x !== drag.lastClientX || pressedNew) repaint(buttons, x, alt);
  }

  function endPaintDrag() {
    clearChordTimeout(); // full release commits the stroke as-is (e.g. erase)
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
    if (duration <= 0 || captured) return;
    // A button pressed mid-drag is a CHORD change (e.g. adding right to a held
    // left = erase). Empirically the browser does NOT fire a fresh pointerdown
    // for the 2nd button — it surfaces as a pointermove (and sometimes only via
    // the later pointerup) with an updated e.buttons. So chord detection lives in
    // paintMove/noteButtons and runs on every event; this branch just forwards a
    // pointerdown if one ever does arrive mid-drag (harmless, and keeps parity).
    if (drag) {
      if (drag.kind === "paint") paintMove(e.buttons, e.clientX, e.altKey);
      return;
    }
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
    startPaint(e.clientX, e.buttons, e.altKey); // already seeks to the press point via onseek
  }

  function onPointerMove(e) {
    if (captured) return; // capture mode is driven by movementX, not clientX
    if (!drag) {
      onhover(timeAt(e.clientX), e.clientX); // scrub-preview the frame under the cursor
    } else if (drag.kind === "pan") {
      panBy(e.clientX - drag.lastClientX);
      drag.lastClientX = e.clientX;
    } else {
      paintMove(e.buttons, e.clientX, e.altKey);
    }
  }

  function onPointerUp(e) {
    if (!drag || captured) return;
    // A pointerup releasing ONE paint button while the OTHER is still held is the
    // tail of an L+R chord — and on some platforms it's the FIRST event that ever
    // reveals the chord (the buttons=3 pointermove having been suppressed). The
    // released button is e.button (0=left, 2=right); if the opposite paint button
    // is still in e.buttons, both were down → latch erase retroactively.
    if (drag.kind === "paint") {
      const opposite = e.button === 0 ? 2 : e.button === 2 ? 1 : 0;
      if (opposite && e.buttons & opposite) drag.everChord = true;
    }
    // pointerup fires when the LAST button is released (buttons→0). If a button
    // of this drag is still held (a chord release), keep the current mode — do
    // NOT recompute (paintMove won't, since this is a release without a move).
    if (drag.kind === "paint" && e.buttons & 3) {
      paintMove(e.buttons, e.clientX, e.altKey); // keep mode (no revert on release)
      scheduleChordRelease(e.buttons, e.altKey); // …unless the window expires still held
      return;
    }
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

  // -- Comments ---------------------------------------------------------------

  /** Command. Add a comment at `time` and immediately put it in edit mode. */
  export function addCommentAt(time) {
    const id = crypto.randomUUID();
    comments = [...comments, { id, time, text: "" }];
    editingId = id;
    draft = "";
  }
  function startEdit(c) {
    editingId = c.id;
    draft = c.text;
  }
  /** Command. Commit the active edit; an empty comment is discarded. */
  function commitEdit() {
    if (editingId == null) return;
    const id = editingId;
    const text = draft.trim();
    comments = text
      ? comments.map((c) => (c.id === id ? { ...c, text } : c))
      : comments.filter((c) => c.id !== id);
    editingId = null;
    oncommentschange();
  }
  function deleteComment(id) {
    comments = comments.filter((c) => c.id !== id);
    if (editingId === id) editingId = null;
    oncommentschange();
  }
  /** Query. A comment expands when edited, hovered, or the playhead sits on it. */
  function commentExpanded(c) {
    return (
      editingId === c.id ||
      hoverCommentId === c.id ||
      Math.abs(xOf(currentTime) - xOf(c.time)) < ON_TIMECODE_PX
    );
  }
  /** Query. The "highlighted" comment: the hovered one, else the one under the
      playhead (on its timecode). Null if none — used by the X delete hotkey. */
  function highlightedComment() {
    return (
      comments.find((c) => c.id === hoverCommentId) ||
      comments.find((c) => Math.abs(xOf(currentTime) - xOf(c.time)) < ON_TIMECODE_PX) ||
      null
    );
  }
  /** Svelte action: focus a freshly-mounted comment textarea. */
  function autofocus(node) {
    node.focus();
  }

  // Hotkeys: C adds a comment (while hovering the timeline), X deletes the
  // highlighted one, T toggles scrub-capture from ANYWHERE (even over the video).
  $effect(() => {
    function onKey(e) {
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (typing || editingId != null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd/Ctrl shortcuts to the browser
      const k = e.key.toLowerCase();
      if (k === "c" && hovered) {
        e.preventDefault();
        addCommentAt(currentTime);
      } else if (k === "x") {
        const target = highlightedComment();
        if (target) {
          e.preventDefault();
          deleteComment(target.id);
        }
      } else if (k === "t" && duration > 0 && barEl) {
        // Toggle capture. Entering from anywhere locks the pointer; on exit the
        // browser restores the OS cursor to where it was (Pointer Lock default).
        e.preventDefault();
        if (captured) document.exitPointerLock?.();
        else {
          syncCaptureToPlayhead();
          barEl.requestPointerLock?.();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // -- Capture scrub mode (Pointer Lock), driven by movementX -----------------

  /** All buttons work while captured, against the virtual (pinned) cursor. */
  function onCaptureDown(e) {
    if (!captured) return;
    // Same chord handling as onPointerDown: a 2nd button mid-drag updates the mode.
    if (drag) {
      if (drag.kind === "paint") paintMove(e.buttons, captureX, e.altKey);
      return;
    }
    if (e.button === 1) drag = { kind: "pan", lastClientX: captureX };
    else startPaint(captureX, e.buttons, e.altKey);
  }

  function onCaptureMove(e) {
    if (!captured || !barEl) return;
    // Hold Shift for fine scrubbing — 4× slower than the raw mouse movement.
    const mv = e.shiftKey ? e.movementX * SLOW_SCRUB_FACTOR : e.movementX;
    if (drag?.kind === "pan") { panBy(mv); syncCaptureToPlayhead(); return; }
    // Move the virtual cursor; near an edge, push past it by panning the view.
    // Keep a LEAD gap (10% of the bar) between the cursor and the edge while
    // there's more clip that way — so you can see a little ahead of the playhead
    // instead of jamming it under the edge chevron. At the true clip start/end
    // (nothing more to reveal, no chevron) the cursor reaches the real edge.
    const rect = barEl.getBoundingClientRect();
    const lead = EDGE_LEAD_FRAC * width;
    const loBound = rect.left + lead;
    const hiBound = rect.right - lead;
    const next = captureX + mv;
    let panned = false;
    if (next < loBound) {
      const v = panView(view, next - loBound, width, duration);
      if (v.start !== view.start) { setViewNow(v); captureX = loBound; panned = true; }
      else captureX = Math.max(next, rect.left);
    } else if (next > hiBound) {
      const v = panView(view, next - hiBound, width, duration);
      if (v.start !== view.start) { setViewNow(v); captureX = hiBound; panned = true; }
      else captureX = Math.min(next, rect.right);
    } else {
      captureX = next;
    }
    // Always reflect the time under captureX. While edge-scrolling captureX is
    // pinned but the VIEW slid, so the time (hence selection + playhead) changed —
    // paintMove's "x unchanged" guard would skip it, so force a repaint when we
    // panned. Either path folds the live button chord in via noteButtons, so the
    // L+R erase latch (drag.everChord) is honoured here exactly as in plain mode.
    if (drag) {
      if (panned) {
        noteButtons(e.buttons);
        repaint(e.buttons, captureX, e.altKey);
      } else {
        paintMove(e.buttons, captureX, e.altKey);
      }
    } else {
      onseek(timeAt(captureX));
    }
  }

  function onCaptureUp(e) {
    if (!captured || !drag) return;
    // Releasing one paint button with the other still held = chord tail; latch
    // erase even if the buttons=3 move never arrived (same as onPointerUp).
    if (drag.kind === "paint") {
      const opposite = e.button === 0 ? 2 : e.button === 2 ? 1 : 0;
      if (opposite && e.buttons & opposite) drag.everChord = true;
    }
    if (drag.kind === "paint" && e.buttons & 3) {
      scheduleChordRelease(e.buttons, e.altKey); // keep erase unless held past the window
      return;
    }
    if (drag.kind === "pan" && e.buttons & 4) return;
    // A plain click (no drag, only ever "good") while captured EXITS capture mode
    // — the mirror of click-to-enter.
    const wasClick = drag.kind === "paint" && !drag.moved && !drag.everNonGood;
    endPaintDrag();
    if (wasClick) document.exitPointerLock?.();
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="annotate"
  style="--playhead-x: {playheadX}px; {proposedBg}"
  onwheel={handleWheel}
  onpointerenter={() => (hovered = true)}
  onpointerleave={() => (hovered = false)}
>
  <!-- Comments float ABOVE the bar so nothing is needed below the timeline. -->
  <div class="comments">
    {#each comments as c (c.id)}
      {@const x = xOf(c.time)}
      {@const boxShift =
        x - COMMENT_BOX_HALF_PX < 0
          ? COMMENT_BOX_HALF_PX - x
          : x + COMMENT_BOX_HALF_PX > width
          ? width - COMMENT_BOX_HALF_PX - x
          : 0}
      {#if x >= -600 && x <= width + 600}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="comment"
          class:expanded={commentExpanded(c)}
          class:editing={editingId === c.id}
          style="left: {x}px; --box-shift: {boxShift}px"
          onpointerenter={() => (hoverCommentId = c.id)}
          onpointerleave={() => (hoverCommentId = null)}
        >
          {#if editingId === c.id}
            <textarea
              class="comment-box"
              use:autofocus
              bind:value={draft}
              placeholder="comment…"
              onkeydown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                else if (e.key === "Escape") { e.preventDefault(); commitEdit(); }
              }}
              onblur={commitEdit}
            ></textarea>
          {:else}
            <button
              class="comment-box"
              onclick={() => oncommentjump(c.time)}
              ondblclick={() => startEdit(c)}
              title="Click to jump · double-click to edit"
            >
              <span class="comment-text">{c.text}</span>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <span class="comment-del" role="button" tabindex="-1" onclick={(e) => { e.stopPropagation(); deleteComment(c.id); }}>×</span>
            </button>
          {/if}
          <span class="comment-dot">
            <iconify-icon icon="mdi:comment-text" width="12" height="12"></iconify-icon>
          </span>
        </div>
      {/if}
    {/each}
  </div>

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

    <!-- Scroll affordance: double-chevrons that fade in when clip content is
         hidden beyond the visible window on that side. -->
    <div class="scroll-hint left" class:visible={moreLeft}>
      <iconify-icon icon="mdi:chevron-double-left" width="22" height="22"></iconify-icon>
    </div>
    <div class="scroll-hint right" class:visible={moreRight}>
      <iconify-icon icon="mdi:chevron-double-right" width="22" height="22"></iconify-icon>
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
    /* Default to the host's theme tokens so the timeline follows light/dark; the
       literals are the standalone fallback. */
    --bar-bg: var(--control-bg, #2b2b3a);
    /* --bar-radius is read with a fallback below so an ancestor can override it. */
    --seg-good: #3fb950;
    --seg-bad: #e5534b;
    --tick-color: color-mix(in srgb, var(--fg, #ffffff) 35%, transparent);
    --tick-major-color: color-mix(in srgb, var(--fg, #ffffff) 60%, transparent);
    --tick-minor-height: 8px;
    --tick-major-height: 14px;
    --playhead-color: var(--fg, #ffffff);
    --playhead-width: 2px;
    --playhead-overhang: 6px;
    --playhead-cap: 6px;
    --label-color: var(--fg-dim, #999);
    --label-size: 0.7rem;
    --comment-color: #e3b341; /* yellow — comment markers */
    --comment-max-w: 512px;
    --comment-bg: var(--control-bg, #20232e);

    position: relative;
    width: 100%;
    user-select: none;
    touch-action: none;
    /* Fill the parent (e.g. a resizable pane) and clip timeline content beyond
       its width. overflow-x: clip lets comments still float above (y visible). */
    overflow-x: clip;
  }

  /* -- Comments: markers floating above the bar (no layout space taken) -- */
  .comments {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 0;
    z-index: 20;
    pointer-events: none;
  }
  .comment {
    position: absolute;
    bottom: 3px; /* sits just above the bar's top edge */
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    pointer-events: auto;
  }
  .comment-dot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--comment-color);
    color: #1a1a2e;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }
  /* The text bubble: hidden until the comment is expanded (hover / on-timecode / editing). */
  .comment-box {
    display: none;
    max-width: var(--comment-max-w);
    width: max-content;
    /* Shift the box (not the dot) so it stays on-screen near the timeline edges. */
    transform: translateX(var(--box-shift, 0));
    padding: 6px 8px;
    background: var(--comment-bg);
    color: var(--fg, #e0e0e0);
    border: 1px solid var(--comment-color);
    border-radius: 6px;
    font-size: 0.8rem;
    line-height: 1.35;
    text-align: left;
    white-space: pre-wrap;
    word-break: break-word;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }
  .comment.expanded .comment-box {
    display: block;
  }
  button.comment-box {
    position: relative;
    font-family: inherit;
  }
  .comment-text {
    display: block;
    min-width: 1ch;
    min-height: 1em;
  }
  .comment-del {
    position: absolute;
    top: 2px;
    right: 4px;
    color: var(--label-color);
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
  }
  .comment-del:hover {
    color: var(--seg-bad);
  }
  textarea.comment-box {
    width: var(--comment-max-w);
    min-height: 3.2em;
    resize: none;
    outline: none;
    font-family: inherit;
  }

  .bar {
    position: relative;
    width: 100%;
    height: var(--bar-height);
    background: var(--bar-bg);
    border-radius: var(--bar-radius, 6px);
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

  /* Proposed selection (active drag): a crisp 45° white/black hatch rendered by
     makeStripeCanvas() (exposed on the root as --proposed-bg). background-
     attachment: fixed anchors the pattern to the viewport so it stays put
     globally while the selection slides over it like a window. */
  .proposed {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    pointer-events: none;
    background-image: var(--proposed-bg);
    background-size: var(--proposed-bg-size);
    background-attachment: fixed;
  }

  /* -- Scroll-affordance chevrons: fade in when content is hidden off-screen.
        Themeable: --chevron-fade (transition), --chevron-blur (backdrop), and
        --chevron-opacity (visible level). -- */
  .scroll-hint {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    padding: 0 var(--playhead-cap);
    color: var(--playhead-color);
    opacity: 0;
    transition: opacity var(--chevron-fade, 0.2s) ease;
    backdrop-filter: blur(var(--chevron-blur, 20px));
    -webkit-backdrop-filter: blur(var(--chevron-blur, 20px));
    pointer-events: none;
    z-index: 3; /* above segments + hatch, below the playhead caps */
  }
  .scroll-hint.left {
    left: 0;
  }
  .scroll-hint.right {
    right: 0;
  }
  .scroll-hint.visible {
    opacity: var(--chevron-opacity, 0.5);
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
