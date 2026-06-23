<!--
  Demo videos live in public/videos/ (gitignored). The optional low-res proxy
  (~1/30 the size, shown through while the main stream resolves a seek) was made
  with:
    ffmpeg -i sample.mp4 -an -vf "scale=-2:180,fps=12" -c:v libx264 \
      -preset veryfast -crf 32 -g 12 -keyint_min 12 -sc_threshold 0 \
      -movflags +faststart sample.proxy.mp4
  (small frame + frequent keyframes = fast scrubbing). proxySrc is optional;
  drop it and ScrubSelect runs on the main stream alone.
-->
<script>
  import ScrubSelect from "../../lib/ScrubSelect.svelte";

  let segments = $state([]);
</script>

<main class="demo-page">
  <h1>ScrubSelect Demo</h1>
  <p class="demo-hint">
    Scrub & annotate a video. Left-drag paints <span class="g">good</span>,
    right-drag paints <span class="b">bad</span>, middle / alt-drag erases.
    Scroll wheel zooms; two-finger horizontal pans the timeline (pinch zooms
    too; min = whole clip). Green ▶ plays only good regions, red ▶ only bad
    ones.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="widget">
    <ScrubSelect
      src="/videos/sample.mp4"
      proxySrc="/videos/sample.proxy.mp4"
      bind:segments
    />
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
