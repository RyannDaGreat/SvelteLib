<script>
  import DirtyImage from "../../lib/DirtyImage.svelte";

  // A long list of procedurally-rendered tiles. Each tile has a `version` that
  // acts as its dirty key: bump it and the tile is dirty. "Dirty all" bumps the
  // GLOBAL version (folded into every tile's key) — proving that even though
  // ALL tiles go dirty, only the ones on screen actually re-render.
  const TILE_COUNT = 500;
  const TILE_ASPECT = 9 / 16; // 16:9 tiles

  let globalVersion = $state(0);
  let renderCount = $state(0); // total render() calls — the lazy-render proof
  let tiles = $state(
    Array.from({ length: TILE_COUNT }, (_, i) => ({ id: i, hue: (i * 47) % 360, version: 0 })),
  );

  /** Command. render() for a tile: paints a procedural gradient + label at the
      REQUESTED device-pixel size (so it's always crisp), and increments the
      global render counter so the demo can prove laziness. */
  function renderTile(tile) {
    return (wPx, hPx) => {
      renderCount += 1;
      const c = document.createElement("canvas");
      c.width = wPx;
      c.height = hPx;
      const ctx = c.getContext("2d");
      const key = tile.version + globalVersion; // total times this tile went dirty
      const g = ctx.createLinearGradient(0, 0, wPx, hPx);
      g.addColorStop(0, `hsl(${tile.hue}, 70%, 55%)`);
      g.addColorStop(1, `hsl(${(tile.hue + 60) % 360}, 70%, 30%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, wPx, hPx);
      // A crisp label sized to the DEVICE pixels — proves natural size == displayed × dpr.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = `${Math.round(hPx * 0.28)}px monospace`;
      ctx.textBaseline = "middle";
      ctx.fillText(`#${tile.id}  v${key}`, hPx * 0.12, hPx * 0.5);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `${Math.round(hPx * 0.13)}px monospace`;
      ctx.fillText(`${wPx}×${hPx}px`, hPx * 0.12, hPx * 0.82);
      return c;
    };
  }

  /** Command. Marks EVERY tile dirty (global version bump). Only visible tiles
      will actually re-render — watch the counter jump by ~a screenful, not 500. */
  function dirtyAll() {
    globalVersion += 1;
  }

  /** Command. Marks a single tile dirty by bumping its own version. */
  function dirtyOne(tile) {
    tile.version += 1;
    tiles = tiles; // re-trigger the each block's key read
  }
</script>

<main class="demo-page">
  <h1>DirtyImage</h1>
  <p class="demo-hint">
    A lazy, dirty-tracked raster tile. Each tile renders ONLY when it is on screen AND
    (its <code>dirtyKey</code> changed or its displayed size changed). Scroll the list, or hit
    <strong>Dirty all</strong>: every one of the {TILE_COUNT} tiles is marked dirty, yet the
    render counter climbs by roughly one <em>screenful</em> — off-screen dirty tiles wait until
    scrolled into view. Resize the window: tiles re-render at the new size (× dpr) so they stay crisp.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="demo-controls">
    <button data-testid="dirty-all" onclick={dirtyAll}>Dirty all ({TILE_COUNT})</button>
    <span class="demo-label">
      Total <code>render()</code> calls:
      <strong data-testid="render-count">{renderCount}</strong>
    </span>
    <span class="demo-label">dpr: {typeof window !== "undefined" ? window.devicePixelRatio : 1}</span>
  </div>

  <div class="list" data-testid="list">
    {#each tiles as tile (tile.id)}
      <div class="cell" data-testid="cell" data-id={tile.id}>
        <DirtyImage
          render={renderTile(tile)}
          dirtyKey={`${tile.id}:${tile.version}:${globalVersion}`}
          aspect={TILE_ASPECT}
          alt={`Tile ${tile.id}`}
        />
        <button class="bump" data-testid="dirty-one" onclick={() => dirtyOne(tile)}>bump v</button>
      </div>
    {/each}
  </div>
</main>

<style>
  .list {
    width: min(560px, 92vw);
    height: 70vh;
    overflow-y: auto;
    margin-top: 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .cell {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* The tile takes most of the row width; the button sits beside it. Because
     DirtyImage fills its container's width, this is what it measures. */
  .cell :global(.di) {
    flex: 1;
    border: 1px solid var(--border);
  }

  .bump {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
  }
</style>
