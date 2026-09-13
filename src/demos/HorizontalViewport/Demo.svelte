<script>
  import HorizontalViewport from "../../lib/HorizontalViewport.svelte";

  const CELL_WIDTH = 160;
  const ORIGINAL_COLUMNS = 12;

  let columns = $state(ORIGINAL_COLUMNS);
  let narrow = $state(false);
  let scale = $state(1);
  let scrollLeft = $state(0);
  let viewport = $state({ scale: 1, scrollLeft: 0, viewportWidth: 0, contentWidth: 0 });
  const contentWidth = $derived(columns * CELL_WIDTH);

  /** Command. Records viewport state for the live readout. */
  function recordViewport(next) {
    viewport = next;
  }
</script>

<main class="demo-page">
  <h1>HorizontalViewport</h1>
  <p class="demo-hint">Scroll horizontally to pan; pinch or Ctrl-wheel to zoom at the pointer. Drag the navigator center or edges.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="demo-controls">
    <button onclick={() => (columns = columns === ORIGINAL_COLUMNS ? 7 : ORIGINAL_COLUMNS)}>Change content width</button>
    <button onclick={() => (narrow = !narrow)}>Change viewport width</button>
    <span class="demo-label">{scale.toFixed(2)}× · {Math.round(scrollLeft)}px · {Math.round(viewport.viewportWidth)}px viewport</span>
  </div>

  <div class="frame" class:narrow>
    <HorizontalViewport {contentWidth} bind:scale bind:scrollLeft onchange={recordViewport}>
      {#snippet children(state)}
        <div class="cells" style={`--cell-width:${CELL_WIDTH * state.scale}px`}>
          {#each Array(columns) as _, index}
            <div class="cell">
              <strong>Column {index + 1}</strong>
              <span>Text is never transformed.</span>
            </div>
          {/each}
        </div>
      {/snippet}
    </HorizontalViewport>
  </div>
</main>

<style>
  .demo-controls {
    margin-bottom: 0.75rem;
  }

  .frame {
    --horizontal-viewport-line: var(--border);
    --horizontal-viewport-window: var(--accent);

    width: 80vw;
    height: 20rem;
    border: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .frame.narrow {
    width: 52vw;
  }

  .cells {
    min-width: 100%;
    min-height: 100%;
    display: flex;
  }

  .cell {
    flex: 0 0 var(--cell-width);
    min-width: 0;
    padding: 1rem;
    overflow: hidden;
    border-right: 1px solid var(--border);
    white-space: nowrap;
  }

  .cell strong,
  .cell span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cell span {
    color: var(--fg-dim);
    font-size: 0.8rem;
  }
</style>
