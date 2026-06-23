<!--
  ScrubSelect [composed, opinionated] — video scrub + region annotation widget.

  A self-contained tool for marking continuous stretches of a video as "good"
  (green) or "bad" (red) and reviewing them. Composes the headless playback
  controller (player.svelte.js), the pure interval model (segments.js), the
  zoomable timeline (AnnotateBar), and a transport row. Tints the video with a
  green/red glow matching the region under the playhead.

  Interaction lives on the timeline (see AnnotateBar): left/right/left+right
  drag = good/bad/erase, middle-drag pans, click = capture scrub mode, wheel
  zooms. Transport: ▶ all · green ▶ good regions · red ▶ bad regions · loop.

  Selected regions are exposed via the `segments` bindable prop + `onchange`.

  Usage:
    <ScrubSelect src="/videos/clip.mp4" bind:segments onchange={(s) => ...} />
-->
<script>
  import "iconify-icon";
  import Dropdown from "./Dropdown.svelte";
  import AnnotateBar from "./AnnotateBar.svelte";
  import { Player } from "./player.svelte.js";
  import { paintSegments } from "./segments.js";
  import { formatTimeMinSec, speedItems } from "./format.js";

  const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16];

  let {
    /** @type {string} Video source URL */
    src,
    /** @type {string} [proxySrc] Optional tiny low-res proxy seeked in lockstep
        behind the main video; shown through while the main video resolves a seek. */
    proxySrc = undefined,
    /** @type {{start:number,end:number,label:'good'|'bad'}[]} Bindable model */
    segments = $bindable([]),
    /** @type {{id:string,time:number,text:string}[]} Bindable comments */
    comments = $bindable([]),
    /** @type {(segments) => void} Fired whenever segments change */
    onchange = undefined,
  } = $props();

  const player = new Player(() => segments);

  /** @type {ReturnType<typeof AnnotateBar>|undefined} */
  let bar = $state(undefined);

  // Paint-stroke bookkeeping (not reactive). A stroke applies against a stable
  // base snapshot; the bar passes the mode with each update.
  let paintBase = [];
  let wasPlaying = false;

  function commit(next) {
    segments = next;
    onchange?.(segments);
  }

  // -- Bar callbacks --

  function onPaintStart() {
    paintBase = segments;
    wasPlaying = player.playing;
    if (player.playing) player.pause();
  }
  function onPaint(mode, t0, t1) {
    commit(paintSegments(paintBase, mode, t0, t1));
  }
  function onPaintEnd() {
    if (wasPlaying) player.play();
  }
  /** Drag / capture scrub: seek the main video to the cursor time (drag already
      paused playback, so this never fights the play loop). */
  function onScrub(t) {
    player.seekTo(t, true);
  }
  /** Hover scrub-preview: seek to the frame under the cursor, but not while
      playing (so it doesn't fight the play loop). */
  function onHover(t) {
    if (player.playing) return;
    player.seekTo(t, true);
  }

  function clearAll() {
    player.pause();
    commit([]);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrub-select">
  <div class="stage">
    <!-- Frame carries the glow so it persists even while the main video is
         transparent mid-seek. Proxy sits behind; main on top. -->
    <div
      class="frame"
      class:glow-good={player.currentLabel === "good"}
      class:glow-bad={player.currentLabel === "bad"}
    >
      {#if proxySrc}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="proxy" use:player.attachProxy src={proxySrc} muted playsinline preload="auto"></video>
      {/if}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        class="main"
        class:revealing={proxySrc && player.mainSeeking}
        use:player.attachMain
        {src}
        muted
        playsinline
        preload="metadata"
      ></video>
    </div>
  </div>

  <div class="transport">
    <button onclick={() => player.seekTo(0)} title="Rewind to start">
      <iconify-icon icon="mdi:skip-previous" width="20" height="20"></iconify-icon>
    </button>
    <button
      class="play-all"
      class:active={player.playing && player.playMode === "all"}
      onclick={() => player.toggleMode("all")}
      title={player.playing && player.playMode === "all" ? "Pause" : "Play all"}
    >
      <iconify-icon icon={player.playing && player.playMode === "all" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
    </button>
    <button
      class="play-good"
      class:active={player.playing && player.playMode === "good"}
      onclick={() => player.toggleMode("good")}
      title="Play good regions"
    >
      <iconify-icon icon={player.playing && player.playMode === "good" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
    </button>
    <button
      class="play-bad"
      class:active={player.playing && player.playMode === "bad"}
      onclick={() => player.toggleMode("bad")}
      title="Play bad regions"
    >
      <iconify-icon icon={player.playing && player.playMode === "bad" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
    </button>
    <button class:active={player.looped} onclick={player.toggleLoop} title="Toggle loop">
      <iconify-icon icon={player.looped ? "mdi:repeat" : "mdi:repeat-off"} width="20" height="20"></iconify-icon>
    </button>

    <span class="spacer"></span>

    <button class="comment-btn" onclick={() => bar?.addCommentAt(player.currentTime)} title="Add comment at playhead (C)">
      <iconify-icon icon="mdi:comment-plus" width="20" height="20"></iconify-icon>
    </button>
    <button onclick={clearAll} title="Clear all regions" disabled={segments.length === 0}>
      <iconify-icon icon="mdi:delete-sweep" width="20" height="20"></iconify-icon>
    </button>
    <Dropdown items={speedItems(SPEEDS)} value={player.playbackRate} onchange={player.setRate} />
    <span class="time">{formatTimeMinSec(player.currentTime)} / {formatTimeMinSec(player.duration)}</span>
  </div>

  <AnnotateBar
    bind:this={bar}
    duration={player.duration}
    currentTime={player.currentTime}
    {segments}
    bind:comments
    onseek={onScrub}
    onpaintstart={onPaintStart}
    onpaint={onPaint}
    onpaintend={onPaintEnd}
    onhover={onHover}
    oncommentjump={(t) => player.animateSeekTo(t)}
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
  /* Frame stacks main + proxy in one grid cell so they overlap exactly. It
     shrinks to the video size, and carries the glow + rounded corners. */
  .frame {
    display: grid;
    border-radius: var(--ss-radius);
    background: #000;
    transition: box-shadow 0.2s ease;
  }
  .frame > video {
    grid-area: 1 / 1;
    display: block;
    max-width: 100%;
    max-height: var(--ss-video-max-h);
    width: auto;
    height: auto;
    border-radius: var(--ss-radius);
  }
  /* The main video (auto-sized) defines the cell; the proxy stretches to fill
     it so the two stay pixel-aligned regardless of intrinsic sizes. Same aspect
     ratio means `fill` introduces no distortion. */
  .frame > .proxy {
    z-index: 0;
    width: 100%;
    height: 100%;
    max-height: none;
    object-fit: fill;
  }
  .frame > .main {
    z-index: 1;
  }
  /* While the heavy stream resolves a seek it has no frame to show — fade it
     out to reveal the already-seeked proxy behind it (instant scrub preview). */
  .frame > .main.revealing {
    opacity: 0;
  }
  /* Glow hugs the frame and reflects the region under the playhead. */
  .frame.glow-good {
    box-shadow: 0 0 var(--ss-glow-spread) 4px var(--ss-glow-good);
  }
  .frame.glow-bad {
    box-shadow: 0 0 var(--ss-glow-spread) 4px var(--ss-glow-bad);
  }

  /* -- Transport row -- */
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
  /* Distinct per-mode icon colors. Scoped under .transport to out-specify the
     base `.transport button { color }` rule. */
  .transport .play-all {
    color: var(--ss-accent);
  }
  .transport .play-good {
    color: var(--ss-good);
  }
  .transport .play-bad {
    color: var(--ss-bad);
  }
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
