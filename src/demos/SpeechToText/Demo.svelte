<script>
  import "iconify-icon";
  import SpeechToText from "../../lib/SpeechToText.svelte";

  let recording = $state(false);
  let segments = $state([]);

  let lang = $state("en-US");
  const LANGS = [
    ["en-US", "English (US)"],
    ["en-GB", "English (UK)"],
    ["es-ES", "Spanish"],
    ["fr-FR", "French"],
    ["de-DE", "German"],
    ["ja-JP", "Japanese"],
  ];

  let logEl = $state(null);
  /** @type {import('../../lib/SpeechToText.svelte').default | null} */
  let stt = $state(null);

  /**
   * Pure function. Format a wall-clock ms timestamp as HH:MM:SS (24h).
   *
   * @param {number} ms - Epoch milliseconds
   * @returns {string}
   *
   * @example formatClock(0) // '00:00:00' (UTC midnight; actual output is local time)
   */
  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  }

  // Auto-scroll the log to the newest entry whenever it grows.
  $effect(() => {
    segments.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  /**
   * Command. Toggle recording when Space is pressed, unless a focused control
   * (button/input/select/textarea) should receive the key itself.
   */
  function onKeydown(e) {
    if (e.code !== "Space" || !stt) return;
    const tag = document.activeElement?.tagName;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    stt.toggle();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<SpeechToText
  bind:this={stt}
  {lang}
  bind:recording
  bind:segments
>
  {#snippet children(state, actions)}
    <main class="demo-page">
      <h1>SpeechToText Demo</h1>
      <p class="demo-hint">
        Press <kbd>Space</kbd> to start/stop dictation. Words appear live as you
        speak; each finished phrase is appended to the log below. Client-side via
        the browser's Web Speech API.
      </p>
      <a class="demo-back" href="/">&larr; All Components</a>

      {#if !state.supported}
        <p class="banner err">
          The Web Speech API isn't available in this browser. Use Chrome or Edge.
        </p>
      {:else if state.error}
        <p class="banner err">
          {state.error === "not-allowed"
            ? "Microphone permission denied — allow mic access and try again."
            : `Recognition error: ${state.error}`}
        </p>
      {/if}

      <div class="stage">
        <div class="controls">
          <button
            class="mic"
            class:on={state.recording}
            disabled={!state.supported}
            onclick={actions.toggle}
            title="Toggle dictation (Space)"
          >
            <iconify-icon
              icon={state.recording ? "mdi:microphone" : "mdi:microphone-outline"}
              width="28"
            ></iconify-icon>
          </button>

          <div class="status">
            <span class="dot" class:on={state.recording}></span>
            {state.recording ? "Listening…" : "Idle"}
          </div>

          <select bind:value={lang} disabled={state.recording} title="Recognition language">
            {#each LANGS as [code, label]}
              <option value={code}>{label}</option>
            {/each}
          </select>

          <span class="spacer"></span>

          <button onclick={actions.clear} disabled={state.segments.length === 0}>
            Clear log
          </button>
        </div>

        <div class="interim" class:empty={!state.interim}>
          {state.interim || "…spoken words will stream here…"}
        </div>

        <div class="log" bind:this={logEl}>
          {#if state.segments.length === 0}
            <p class="log-empty">No transcripts yet.</p>
          {:else}
            {#each state.segments as seg (seg.at)}
              <p class="entry">
                <span class="ts">{formatClock(seg.at)}</span>
                <span class="text">{seg.text}</span>
              </p>
            {/each}
          {/if}
        </div>
      </div>
    </main>
  {/snippet}
</SpeechToText>

<style>
  :root {
    --stt-width: 60vw;
    --stt-gap: 1rem;
    --stt-pad: 1rem;
    --stt-mic-size: 56px;
    --stt-dot-size: 9px;
    --stt-log-height: 38vh;
    --stt-rec: #e5534b;
    --stt-rec-glow: rgba(229, 83, 75, 0.5);
    --stt-ts: #6a6a85;
  }

  .stage {
    width: var(--stt-width);
    display: flex;
    flex-direction: column;
    gap: var(--stt-gap);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .spacer {
    flex: 1;
  }

  .mic {
    width: var(--stt-mic-size);
    height: var(--stt-mic-size);
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.15s, color 0.15s;
  }
  .mic:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
  }
  .mic.on {
    background: var(--stt-rec);
    color: #fff;
    border-color: var(--stt-rec);
    box-shadow: 0 0 0 6px var(--stt-rec-glow);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .mic:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 12px transparent;
    }
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--fg-dim);
    font-size: 0.9rem;
  }
  .dot {
    width: var(--stt-dot-size);
    height: var(--stt-dot-size);
    border-radius: 50%;
    background: var(--fg-dim);
  }
  .dot.on {
    background: var(--stt-rec);
    box-shadow: 0 0 6px var(--stt-rec);
  }

  select {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--control-pad);
    font-size: 0.85rem;
  }
  select:disabled {
    opacity: 0.5;
  }

  button {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--control-pad);
    cursor: pointer;
    font-size: 0.85rem;
  }
  button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .interim {
    min-height: 2.5rem;
    padding: var(--stt-pad);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 1.1rem;
  }
  .interim.empty {
    color: var(--fg-dim);
    font-style: italic;
  }

  .log {
    height: var(--stt-log-height);
    overflow-y: auto;
    padding: var(--stt-pad);
    background: var(--control-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .log-empty {
    color: var(--fg-dim);
  }
  .entry {
    display: flex;
    gap: 0.75rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--border);
  }
  .entry .ts {
    color: var(--stt-ts);
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    flex-shrink: 0;
    padding-top: 0.15rem;
  }
  .entry .text {
    line-height: 1.5;
  }

  .banner {
    width: var(--stt-width);
    padding: 0.6rem var(--stt-pad);
    border-radius: var(--radius);
    margin-bottom: var(--stt-gap);
    font-size: 0.9rem;
  }
  .banner.err {
    background: rgba(229, 83, 75, 0.15);
    border: 1px solid var(--stt-rec);
    color: #f5a3a3;
  }

  kbd {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.8rem;
    font-family: ui-monospace, monospace;
  }
</style>
