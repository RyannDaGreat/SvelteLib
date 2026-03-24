<!--
  ScrubBar — video transport controls with timeline scrubber.

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
  } = $props();

  /* Track whether user was playing before scrub, to resume after */
  let wasPlaying = false;

  function handleScrubStart() {
    wasPlaying = state.playing;
    if (wasPlaying) actions.pause();
  }

  function handleScrubInput(e) {
    actions.seek(+e.target.value);
  }

  function handleScrubEnd() {
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
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.6);
    border-radius: 8px;
    user-select: none;
  }

  .transport {
    display: flex;
    gap: 2px;
  }

  .transport button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    color: #e0e0e0;
    cursor: pointer;
    border-radius: 4px;
  }
  .transport button:hover {
    background: rgba(255, 255, 255, 0.15);
  }
  .transport button.active {
    color: #7aa2f7;
  }

  /* -- Timeline range input -- */
  .timeline {
    flex: 1;
    height: 6px;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }

  .timeline::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      #7aa2f7 0%,
      #7aa2f7 var(--fill),
      rgba(255, 255, 255, 0.15) var(--fill),
      rgba(255, 255, 255, 0.15) 100%
    );
  }
  .timeline::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      #7aa2f7 0%,
      #7aa2f7 var(--fill),
      rgba(255, 255, 255, 0.15) var(--fill),
      rgba(255, 255, 255, 0.15) 100%
    );
  }

  .timeline::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #e0e0e0;
    margin-top: -4px;
  }
  .timeline::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #e0e0e0;
    border: none;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .speed {
    background: rgba(255, 255, 255, 0.1);
    color: #e0e0e0;
    border: none;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .time {
    color: #888;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
