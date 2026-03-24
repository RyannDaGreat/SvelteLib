<script>
  import PanZoom from "../../lib/PanZoom.svelte";
</script>

<main>
  <h1>PanZoom Demo</h1>
  <p class="hint">Trackpad: two-finger pan, pinch zoom.</p>
  <a class="back" href="/">&#8592; All Components</a>

  <div class="canvas-frame">
    <PanZoom>
      {#snippet children(viewport, actions)}
        <svg width="100%" height="100%">
          <g transform="translate({viewport.panX}, {viewport.panY}) scale({viewport.zoom})">
            <!-- Grid -->
            {#each Array(21) as _, i}
              <line x1={i * 50} y1="0" x2={i * 50} y2="1000" stroke="rgba(255,255,255,0.08)" />
              <line x1="0" y1={i * 50} x2="1000" y2={i * 50} stroke="rgba(255,255,255,0.08)" />
            {/each}

            <!-- Objects to pan/zoom around -->
            <rect x="100" y="100" width="200" height="200" rx="12" fill="#e94560" opacity="0.8" />
            <circle cx="550" cy="300" r="80" fill="#6c9bcf" opacity="0.8" />
            <polygon points="400,50 450,150 350,150" fill="#45d2b0" opacity="0.8" />

            <text x="150" y="215" fill="white" font-size="16">Rect</text>
            <text x="525" y="305" fill="white" font-size="16">Circle</text>
            <text x="375" y="120" fill="white" font-size="16">Tri</text>
          </g>
        </svg>

        <div class="overlay-controls">
          <button onclick={actions.reset}>Reset</button>
          <button onclick={() => actions.zoomTo(2)}>2x</button>
          <button onclick={() => actions.zoomTo(0.5)}>0.5x</button>
          <button onclick={() => actions.zoomToFit({x: 100, y: 100, w: 200, h: 200})}>Fit Rect</button>
          <span class="zoom-label">{(viewport.zoom * 100).toFixed(0)}%</span>
        </div>
      {/snippet}
    </PanZoom>
  </div>
</main>

<style>
  :root {
    --bg: #1a1a2e;
    --fg: #eee;
    --accent: #e94560;
    --frame-border: rgba(255, 255, 255, 0.1);
    --frame-radius: 12px;
    --control-bg: rgba(0, 0, 0, 0.5);
    --control-radius: 8px;
    --control-pad: 8px 14px;
  }

  main {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem;
  }

  h1 { margin-bottom: 0.25rem; }

  .hint {
    color: #888;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
  }

  .back {
    color: var(--accent);
    font-size: 0.85rem;
    margin-bottom: 1rem;
    text-decoration: none;
  }
  .back:hover { text-decoration: underline; }

  .canvas-frame {
    width: 80vw;
    height: 70vh;
    border: 1px solid var(--frame-border);
    border-radius: var(--frame-radius);
    overflow: hidden;
    position: relative;
  }

  .overlay-controls {
    position: absolute;
    bottom: 12px;
    left: 12px;
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .overlay-controls button {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--frame-border);
    border-radius: var(--control-radius);
    padding: var(--control-pad);
    cursor: pointer;
    font-size: 0.8rem;
  }

  .overlay-controls button:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .zoom-label {
    color: #888;
    font-size: 0.8rem;
    margin-left: 8px;
    font-variant-numeric: tabular-nums;
  }
</style>
