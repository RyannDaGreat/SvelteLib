<script>
  import ProgressBar from "../../lib/ProgressBar.svelte";

  let percent = $state(37);
</script>

<main class="demo-page">
  <h1>ProgressBar</h1>
  <p class="demo-hint">Controlled determinate and static indeterminate progress.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <section class="examples">
    <label>
      <span>Determinate: {percent}%</span>
      <ProgressBar label="Adjustable example" value={percent} />
      <input type="range" min="0" max="100" bind:value={percent} />
    </label>

    <label>
      <span>Indeterminate</span>
      <ProgressBar label="Preparing example" />
    </label>

    <label class="themed">
      <span>Re-themed: 7 of 12 files</span>
      <ProgressBar label="Files copied" value={7} max={12} valueText="7 of 12 files" />
    </label>
  </section>
</main>

<style>
  .examples {
    width: min(36rem, 80vw);
    display: grid;
    gap: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
  }

  label {
    display: grid;
    gap: 0.5rem;
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  input {
    width: 100%;
  }

  .themed {
    --progress-height: 0.75rem;
    --progress-track-bg: rgba(69, 210, 176, 0.15);
    --progress-value-bg: #45d2b0;
  }
</style>
