<!--
  ScrubSelect [composed, opinionated] — video scrub + region annotation widget.

  A self-contained tool for marking continuous stretches of a video as "good"
  (green) or "bad" (red) and reviewing them. Owns a single <video>, a lightweight
  playback engine tuned for precise scrubbing, the annotation model, and the
  transport. The zoomable timeline lives in <AnnotateBar>; this component holds
  the segment state and applies edits, drives playback, and tints the video with
  a green/red glow matching the region under the playhead.

  Interaction (on the bar, or pinch/pan anywhere over the widget):
    - left-drag        paint GREEN (good) + scrub
    - right-drag       paint RED (bad) + scrub
    - middle / alt+left erase + scrub
    - two-finger pan   scroll timeline · pinch zoom (min = whole clip)

  Transport: ▶ plays everything · green ▶ plays only good regions · red ▶ plays
  only bad regions. Speed + loop as on the other players.

  Selected regions are kept in widget state and exposed via the `segments`
  bindable prop and the `onchange` callback.

  Usage:
    <ScrubSelect src="/videos/clip.mp4" bind:segments onchange={(s) => ...} />
-->
<script>
  import "iconify-icon";
  import Dropdown from "./Dropdown.svelte";
  import AnnotateBar from "./AnnotateBar.svelte";

  /**
   * @typedef {Object} Segment
   * @property {number} start - seconds
   * @property {number} end - seconds
   * @property {'good'|'bad'} label
   */

  // -- Pure functions (general): interval algebra -----------------------------

  /**
   * Pure function, general. Clamp value to [min, max].
   *
   * @example clamp(5, 0, 10) // 5
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Pure function, general. Remove the time range [lo, hi] from every segment,
   * clipping any that straddle it. Segments keep their labels.
   *
   * @param {Segment[]} segs
   * @returns {Segment[]}
   *
   * @example
   * // subtractRange([{start:0,end:10,label:'good'}], 4, 6)
   * // -> [{start:0,end:4,label:'good'}, {start:6,end:10,label:'good'}]
   */
  function subtractRange(segs, lo, hi) {
    const out = [];
    for (const s of segs) {
      if (s.end <= lo || s.start >= hi) {
        out.push(s);
        continue;
      }
      if (s.start < lo) out.push({ start: s.start, end: lo, label: s.label });
      if (s.end > hi) out.push({ start: hi, end: s.end, label: s.label });
    }
    return out;
  }

  /**
   * Pure function, general. Sort segments and merge ones that touch or overlap
   * and share a label, yielding a disjoint, normalised list.
   *
   * @param {Segment[]} segs
   * @returns {Segment[]}
   *
   * @example
   * // mergeSegments([{start:2,end:4,label:'good'},{start:0,end:2,label:'good'}])
   * // -> [{start:0,end:4,label:'good'}]
   */
  function mergeSegments(segs) {
    const sorted = [...segs].sort((a, b) => a.start - b.start);
    const out = [];
    for (const seg of sorted) {
      const last = out[out.length - 1];
      if (last && last.label === seg.label && seg.start <= last.end + 1e-6) {
        last.end = Math.max(last.end, seg.end);
      } else {
        out.push({ ...seg });
      }
    }
    return out;
  }

  /**
   * Pure function, general. Apply one paint stroke to a segment list.
   * 'good'/'bad' overwrite the range with that label; 'erase' clears it.
   * A zero-width stroke is a no-op (so a plain click only scrubs).
   *
   * @param {Segment[]} segs
   * @param {'good'|'bad'|'erase'} mode
   * @param {number} a - stroke endpoint (s)
   * @param {number} b - stroke endpoint (s)
   * @returns {Segment[]}
   *
   * @example
   * // paintSegments([], 'good', 5, 2) -> [{start:2,end:5,label:'good'}]
   * // paintSegments([{start:0,end:10,label:'good'}], 'erase', 3, 6)
   * //   -> [{start:0,end:3,label:'good'},{start:6,end:10,label:'good'}]
   */
  function paintSegments(segs, mode, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo < 1e-6) return segs;
    const cleared = subtractRange(segs, lo, hi);
    if (mode === "erase") return mergeSegments(cleared);
    cleared.push({ start: lo, end: hi, label: mode });
    return mergeSegments(cleared);
  }

  /**
   * Pure function, general. Label of the segment containing t, or null.
   *
   * @example
   * // labelAt([{start:0,end:5,label:'bad'}], 3) -> 'bad'
   * // labelAt([{start:0,end:5,label:'bad'}], 7) -> null
   */
  function labelAt(segs, t) {
    for (const s of segs) if (t >= s.start && t < s.end) return s.label;
    return null;
  }

  /**
   * Pure function, general. From segments of one label (sorted, disjoint), find
   * where playback should be at time t: the segment containing t, else the next
   * one after t, else null (nothing left to play).
   *
   * @param {Segment[]} allowed - segments of the active label, sorted by start
   * @param {number} t
   * @returns {Segment|null}
   *
   * @example
   * // segmentToPlay([{start:2,end:4,label:'good'}], 1) -> {start:2,end:4,...}
   * // segmentToPlay([{start:2,end:4,label:'good'}], 3) -> {start:2,end:4,...}
   * // segmentToPlay([{start:2,end:4,label:'good'}], 5) -> null
   */
  function segmentToPlay(allowed, t) {
    let next = null;
    for (const s of allowed) {
      if (t >= s.start && t < s.end) return s;
      if (s.start > t && (next === null || s.start < next.start)) next = s;
    }
    return next;
  }

  /**
   * Pure function. Build {value,label} items for the speed dropdown.
   *
   * @example speedItems([1, 2]) // [{value:1,label:"1x"},{value:2,label:"2x"}]
   */
  function speedItems(speeds) {
    return speeds.map((s) => ({ value: s, label: `${s}x` }));
  }

  /**
   * Pure function, general. Format seconds as M:SS.
   *
   * @example formatTime(65.4) // "1:05"
   */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // -- Component --------------------------------------------------------------

  const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16];

  let {
    /** @type {string} Video source URL */
    src,
    /** @type {Segment[]} Bindable annotation model */
    segments = $bindable([]),
    /** @type {(segments: Segment[]) => void} Fired whenever segments change */
    onchange = undefined,
  } = $props();

  /** @type {HTMLVideoElement|undefined} */
  let videoEl = $state(undefined);
  /** @type {ReturnType<typeof AnnotateBar>|undefined} */
  let bar = $state(undefined);

  let duration = $state(0);
  let currentTime = $state(0);
  let playing = $state(false);
  let looped = $state(false);
  let playbackRate = $state(1);
  /** @type {'all'|'good'|'bad'} Which regions playback is restricted to */
  let playMode = $state("all");

  let rafId = null;

  // Paint-stroke bookkeeping (not reactive).
  let paintBase = [];
  let paintMode = "good";
  let wasPlaying = false;

  let currentLabel = $derived(labelAt(segments, currentTime));

  function commit(next) {
    segments = next;
    onchange?.(segments);
  }

  // -- Playback engine --------------------------------------------------------

  function allowedFor(mode) {
    return mode === "all" ? [] : segments.filter((s) => s.label === mode);
  }

  /** Command. Jump to a region boundary and keep playback alive. A big forward
      seek can briefly drop the element out of the playing state; re-issue play. */
  function jumpTo(t) {
    seekTo(t);
    if (playing && videoEl?.paused) {
      videoEl.play().catch((err) => {
        if (err.name !== "AbortError") console.error("ScrubSelect: resume failed:", err);
      });
    }
  }

  /** Command. rAF loop: mirror video time, enforce label-restricted playback.
      Region playback condenses the timeline — at the end of one allowed region
      it seeks straight to the start of the next, skipping the gaps. */
  function tick() {
    if (!videoEl) return;
    // While a seek is in flight, currentTime reports the *target*, not the real
    // decoded position — re-evaluating now would fire a fresh seek every frame
    // and the original seek would never land. Wait for it to settle.
    if (videoEl.seeking) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    currentTime = videoEl.currentTime;

    if (playMode !== "all") {
      const allowed = allowedFor(playMode);
      const target = segmentToPlay(allowed, currentTime);
      if (!target) {
        // Past the last allowed region: loop to first or stop.
        if (looped && allowed.length) jumpTo(allowed[0].start);
        else return pause();
      } else if (currentTime < target.start - 1e-3) {
        jumpTo(target.start);
      }
    } else if (currentTime >= duration) {
      if (looped) seekTo(0);
      else return pause();
    }

    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId == null) rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function play() {
    if (!videoEl || duration <= 0) return;
    playing = true;
    videoEl.playbackRate = playbackRate;
    videoEl.play().catch((err) => {
      if (err.name !== "AbortError") console.error("ScrubSelect: play failed:", err);
    });
    startLoop();
  }

  function pause() {
    playing = false;
    stopLoop();
    videoEl?.pause();
  }

  /** Command. Seek the main video. `fast` uses fastSeek (nearest keyframe) for
      snappy scrubbing; programmatic jumps need exact landings so leave it off. */
  function seekTo(t, fast = false) {
    const clamped = clamp(t, 0, duration || 0);
    currentTime = clamped;
    if (!videoEl) return;
    if (fast && videoEl.fastSeek) videoEl.fastSeek(clamped);
    else videoEl.currentTime = clamped;
  }

  /** Command. Begin playback restricted to `mode`, seeking into the first
      relevant region when the playhead is outside it. */
  function startMode(mode) {
    playMode = mode;
    if (mode !== "all") {
      const allowed = allowedFor(mode);
      if (allowed.length === 0) {
        pause();
        return;
      }
      if (!segmentToPlay(allowed, currentTime)) seekTo(allowed[0].start);
      else {
        const target = segmentToPlay(allowed, currentTime);
        if (currentTime < target.start) seekTo(target.start);
      }
    }
    play();
  }

  /** Command. Toggle a transport mode: pressing the active one pauses. */
  function toggleMode(mode) {
    if (playing && playMode === mode) pause();
    else startMode(mode);
  }

  function setRate(rate) {
    playbackRate = rate;
    if (videoEl) videoEl.playbackRate = rate;
  }

  function onMeta() {
    duration = videoEl.duration;
    currentTime = videoEl.currentTime;
  }

  $effect(() => () => stopLoop());

  // -- Bar callbacks ----------------------------------------------------------

  function onPaintStart(mode) {
    paintMode = mode;
    paintBase = segments;
    wasPlaying = playing;
    if (playing) pause();
  }
  function onPaint(t0, t1) {
    commit(paintSegments(paintBase, paintMode, t0, t1));
  }
  function onPaintEnd() {
    if (wasPlaying) play();
  }

  // -- Hover preview ----------------------------------------------------------

  /** Command. Hovering the timeline scrubs the main video to that frame so the
      big picture previews the cursor position (whether or not a drag is active).
      Skipped while playing so it doesn't fight the play loop. */
  function onHover(t) {
    if (playing) return;
    seekTo(t, true);
  }

  function clearAll() {
    pause();
    commit([]);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrub-select" onwheel={(e) => bar?.handleWheel(e)}>
  <div class="stage">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      class:glow-good={currentLabel === "good"}
      class:glow-bad={currentLabel === "bad"}
      bind:this={videoEl}
      {src}
      muted
      playsinline
      preload="metadata"
      onloadedmetadata={onMeta}
    ></video>
  </div>

  <div class="transport">
    <button onclick={() => seekTo(0)} title="Rewind to start">
      <iconify-icon icon="mdi:skip-previous" width="20" height="20"></iconify-icon>
    </button>
    <button
      class="play-all"
      class:active={playing && playMode === "all"}
      onclick={() => toggleMode("all")}
      title={playing && playMode === "all" ? "Pause" : "Play all"}
    >
      <iconify-icon icon={playing && playMode === "all" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
    </button>
    <button
      class="play-good"
      class:active={playing && playMode === "good"}
      onclick={() => toggleMode("good")}
      title="Play good regions"
    >
      <iconify-icon icon={playing && playMode === "good" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
    </button>
    <button
      class="play-bad"
      class:active={playing && playMode === "bad"}
      onclick={() => toggleMode("bad")}
      title="Play bad regions"
    >
      <iconify-icon icon={playing && playMode === "bad" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
    </button>
    <button class:active={looped} onclick={() => (looped = !looped)} title="Toggle loop">
      <iconify-icon icon={looped ? "mdi:repeat" : "mdi:repeat-off"} width="20" height="20"></iconify-icon>
    </button>

    <span class="spacer"></span>

    <button onclick={clearAll} title="Clear all regions" disabled={segments.length === 0}>
      <iconify-icon icon="mdi:delete-sweep" width="20" height="20"></iconify-icon>
    </button>
    <Dropdown items={speedItems(SPEEDS)} value={playbackRate} onchange={setRate} />
    <span class="time">{formatTime(currentTime)} / {formatTime(duration)}</span>
  </div>

  <AnnotateBar
    bind:this={bar}
    {duration}
    {currentTime}
    {segments}
    onseek={(t) => seekTo(t, true)}
    onpaintstart={onPaintStart}
    onpaint={onPaint}
    onpaintend={onPaintEnd}
    onhover={onHover}
  />
</div>

<style>
  .scrub-select {
    /* -- Themeable custom properties -- */
    --ss-gap: 12px;
    --ss-radius: 8px;
    --ss-glow-good: #3fb950;
    --ss-glow-bad: #e5534b;
    --ss-glow-spread: 28px;
    --ss-bg: rgba(0, 0, 0, 0.6);
    --ss-btn-size: 32px;
    --ss-btn-color: #e0e0e0;
    --ss-btn-hover-bg: rgba(255, 255, 255, 0.15);
    --ss-btn-radius: 4px;
    --ss-good: #3fb950;
    --ss-bad: #e5534b;
    --ss-accent: #7aa2f7;
    --ss-time-color: #888;
    /* Cap the video so a tall/portrait clip never runs off-screen — only its
       displayed height changes, width follows from the aspect ratio. */
    --ss-video-max-h: 55vh;

    display: flex;
    flex-direction: column;
    gap: var(--ss-gap);
    width: 100%;
    touch-action: none;
    user-select: none;
  }

  /* Video stage — centers the height-bounded frame in the full-width row. */
  .stage {
    display: flex;
    justify-content: center;
    align-items: center;
    max-height: var(--ss-video-max-h);
  }
  video {
    display: block;
    max-width: 100%;
    max-height: var(--ss-video-max-h);
    width: auto;
    height: auto;
    border-radius: var(--ss-radius);
    background: #000;
    transition: box-shadow 0.2s ease;
  }
  /* Glow hugs the actual frame and reflects the region under the playhead. */
  video.glow-good {
    box-shadow: 0 0 var(--ss-glow-spread) 4px var(--ss-glow-good);
  }
  video.glow-bad {
    box-shadow: 0 0 var(--ss-glow-spread) 4px var(--ss-glow-bad);
  }

  /* -- Transport row (shares the look of ScrubBar) -- */
  .transport {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 12px;
    background: var(--ss-bg);
    border-radius: var(--ss-radius);
  }
  .transport button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ss-btn-size);
    height: var(--ss-btn-size);
    padding: 0;
    background: transparent;
    border: none;
    color: var(--ss-btn-color);
    cursor: pointer;
    border-radius: var(--ss-btn-radius);
  }
  .transport button:hover {
    background: var(--ss-btn-hover-bg);
  }
  .transport button:disabled {
    opacity: 0.25;
    cursor: default;
  }
  /* Distinct per-mode icon colors. Selectors are scoped under .transport so
     they out-specify the base `.transport button { color }` rule. */
  .transport .play-all {
    color: var(--ss-accent);
  }
  .transport .play-good {
    color: var(--ss-good);
  }
  .transport .play-bad {
    color: var(--ss-bad);
  }
  /* Active = filled background in the button's own hue (icon keeps its color). */
  .transport button.active {
    background: var(--ss-btn-hover-bg);
  }
  .transport .play-all.active {
    background: color-mix(in srgb, var(--ss-accent) 30%, transparent);
  }
  .transport .play-good.active {
    background: color-mix(in srgb, var(--ss-good) 30%, transparent);
  }
  .transport .play-bad.active {
    background: color-mix(in srgb, var(--ss-bad) 30%, transparent);
  }

  .spacer {
    flex: 1;
  }
  .transport :global(.dd) {
    min-width: 56px;
  }
  .time {
    color: var(--ss-time-color);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: var(--ss-gap);
  }
</style>
