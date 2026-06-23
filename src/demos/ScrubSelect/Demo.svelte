<script>
  import ScrubSelect from "../../lib/ScrubSelect.svelte";

  let segments = $state([]);
</script>

<main class="demo-page">
  <h1>ScrubSelect Demo</h1>
  <p class="demo-hint">
    Scrub & annotate a video. Left-drag paints <span class="g">good</span>,
    right-drag paints <span class="b">bad</span>, middle / alt-drag erases.
    Two-finger pan scrolls the timeline; pinch zooms (min = whole clip). Green ▶
    plays only good regions, red ▶ only bad ones.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="widget">
    <ScrubSelect src="/videos/sample.mp4" bind:segments />
  </div>

  <details class="state">
    <summary>Selected regions ({segments.length})</summary>
    <pre>{JSON.stringify(
        segments.map((s) => ({
          label: s.label,
          start: +s.start.toFixed(2),
          end: +s.end.toFixed(2),
        })),
        null,
        2,
      )}</pre>
  </details>
</main>

<style>
  .widget {
    width: 80vw;
  }
  .g {
    color: #3fb950;
    font-weight: 600;
  }
  .b {
    color: #e5534b;
    font-weight: 600;
  }
  .state {
    width: 80vw;
    margin-top: 1.5rem;
    font-size: 0.8rem;
  }
  .state summary {
    cursor: pointer;
    color: var(--fg-dim);
  }
  .state pre {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 240px;
    overflow: auto;
    font-variant-numeric: tabular-nums;
  }
</style>
