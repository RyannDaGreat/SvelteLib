<!--
  ScrubBar [visual, general] — video transport controls with timeline scrubber.

  Reads state and calls actions from a SyncPlayer (or anything with
  the same interface). Icons via iconify-icon web component.

  Usage:
    <ScrubBar {state} {actions} />
-->
<script>
  import "iconify-icon";

  // -- Pure functions (general) -----------------------------------------------

  /**
   * Pure function, general. Format seconds as M:SS.
   *
   * @example formatTime(0) // "0:00"
   * @example formatTime(65.4) // "1:05"
   * @example formatTime(3661) // "61:01"
   */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // -- Component --------------------------------------------------------------

  const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

  let {
    /** @type {import('./SyncPlayer.svelte').SyncState} */
    state,
    /** @type {import('./SyncPlayer.svelte').SyncActions} */
    actions,
    /** Optional snippet for extra transport controls (rendered inside button row) */
    extra,
  } = $props();

  /* Track whether user was playing before scrub, to resume after */
  let wasPlaying = false;

  function handleScrubStart() {
    wasPlaying = state.playing;
    if (wasPlaying) actions.pause();
  }

  function handleScrubInput(e) {
    actions.scrubSeek(+e.target.value);
  }

  function handleScrubEnd(e) {
    actions.seek(+e.target.value);
    if (wasPlaying) actions.play();
  }

  /* Timeline fill percentage for the custom track background */
  function progress() {
    if (!state.duration) return 0;
    return (state.currentTime / state.duration) * 100;
  }
</script>

<div class="scrub-bar">
  <div class="transport">
    <button onclick={actions.seekToStart} title="Rewind to start">
      <iconify-icon icon="mdi:skip-previous" width="20" height="20"></iconify-icon>
    </button>
    <button onclick={actions.toggle} title={state.playing ? "Pause" : "Play"}>
      <iconify-icon
        icon={state.playing ? "mdi:pause" : "mdi:play"}
        width="22"
        height="22"
      ></iconify-icon>
    </button>
    <button onclick={actions.seekToEnd} title="Skip to end">
      <iconify-icon icon="mdi:skip-next" width="20" height="20"></iconify-icon>
    </button>
    <button
      onclick={actions.toggleLoop}
      title="Toggle loop"
      class:active={state.looped}
    >
      <iconify-icon
        icon={state.looped ? "mdi:repeat" : "mdi:repeat-off"}
        width="20"
        height="20"
      ></iconify-icon>
    </button>
    {#if extra}{@render extra()}{/if}
  </div>

  <input
    type="range"
    class="timeline"
    min="0"
    max={state.duration || 1}
    step="any"
    value={state.currentTime}
    style="--fill: {progress()}%"
    onpointerdown={handleScrubStart}
    oninput={handleScrubInput}
    onpointerup={handleScrubEnd}
  />

  <div class="right">
    <select
      class="speed"
      value={state.playbackRate}
      onchange={(e) => actions.setPlaybackRate(+e.target.value)}
    >
      {#each SPEEDS as speed}
        <option value={speed}>{speed}x</option>
      {/each}
    </select>

    <span class="time">
      {formatTime(state.currentTime)} / {formatTime(state.duration)}
    </span>
  </div>
</div>

<style>
  .scrub-bar {
    /* -- Themeable custom properties -- */
    --scrub-bg: rgba(0, 0, 0, 0.6);
    --scrub-radius: 8px;
    --scrub-gap: 8px;
    --scrub-padding: 8px 12px;
    --scrub-btn-size: 32px;
    --scrub-btn-color: #e0e0e0;
    --scrub-btn-hover-bg: rgba(255, 255, 255, 0.15);
    --scrub-btn-active-color: #7aa2f7;
    --scrub-btn-radius: 4px;
    --scrub-accent: #7aa2f7;
    --scrub-track-bg: rgba(255, 255, 255, 0.15);
    --scrub-track-height: 4px;
    --scrub-thumb-color: #e0e0e0;
    --scrub-thumb-size: 12px;
    --scrub-time-color: #888;
    --scrub-font-size: 0.75rem;

    display: flex;
    align-items: center;
    gap: var(--scrub-gap);
    padding: var(--scrub-padding);
    background: var(--scrub-bg);
    border-radius: var(--scrub-radius);
    user-select: none;
  }

  .transport {
    display: flex;
    gap: 2px;
  }

  /* :global so snippet-injected buttons get styled too.
     Scoped under .transport so it won't leak outside the bar. */
  .transport :global(button) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--scrub-btn-size);
    height: var(--scrub-btn-size);
    padding: 0;
    background: transparent;
    border: none;
    color: var(--scrub-btn-color);
    cursor: pointer;
    border-radius: var(--scrub-btn-radius);
  }
  .transport :global(button:hover) {
    background: var(--scrub-btn-hover-bg);
  }
  .transport :global(button.active) {
    color: var(--scrub-btn-active-color);
  }
  .transport :global(button:disabled) {
    opacity: 0.25;
    cursor: default;
  }

  /* -- Timeline range input -- */
  .timeline {
    flex: 1;
    height: 24px; /* Large hit target; track is visually thin inside */
    appearance: none;
    background: transparent;
    cursor: pointer;
  }

  .timeline::-webkit-slider-runnable-track {
    height: var(--scrub-track-height);
    border-radius: calc(var(--scrub-track-height) / 2);
    background: linear-gradient(
      to right,
      var(--scrub-accent) 0%,
      var(--scrub-accent) var(--fill),
      var(--scrub-track-bg) var(--fill),
      var(--scrub-track-bg) 100%
    );
  }
  .timeline::-moz-range-track {
    height: var(--scrub-track-height);
    border-radius: calc(var(--scrub-track-height) / 2);
    background: linear-gradient(
      to right,
      var(--scrub-accent) 0%,
      var(--scrub-accent) var(--fill),
      var(--scrub-track-bg) var(--fill),
      var(--scrub-track-bg) 100%
    );
  }

  .timeline::-webkit-slider-thumb {
    appearance: none;
    width: var(--scrub-thumb-size);
    height: var(--scrub-thumb-size);
    border-radius: 50%;
    background: var(--scrub-thumb-color);
    margin-top: calc((var(--scrub-thumb-size) - var(--scrub-track-height)) / -2);
  }
  .timeline::-moz-range-thumb {
    width: var(--scrub-thumb-size);
    height: var(--scrub-thumb-size);
    border-radius: 50%;
    background: var(--scrub-thumb-color);
    border: none;
  }

  .right {
    display: flex;
    align-items: center;
    gap: var(--scrub-gap);
  }

  .speed {
    background: var(--scrub-track-bg);
    color: var(--scrub-btn-color);
    border: none;
    border-radius: var(--scrub-btn-radius);
    padding: 2px 6px;
    font-size: var(--scrub-font-size);
    cursor: pointer;
  }

  .time {
    color: var(--scrub-time-color);
    font-size: var(--scrub-font-size);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
