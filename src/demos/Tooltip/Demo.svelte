<script>
  import Tooltip from "../../lib/Tooltip.svelte";
</script>

<main class="demo-page">
  <h1>Tooltip</h1>
  <p class="demo-hint">
    Immediate hover/focus tooltips (no native <code>title</code> delay). Optional
    <code>delay</code> adds a hover threshold. Flips <code>top</code>/<code>bottom</code> near the
    viewport edge. Themable via <code>--tt-*</code> custom properties.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <section class="grid">
    <div class="card">
      <h2>Immediate (default)</h2>
      <p class="note">Shows instantly on hover or keyboard focus.</p>
      <Tooltip text="Save file">
        <button data-testid="immediate">💾 Save</button>
      </Tooltip>
    </div>

    <div class="card">
      <h2>Delayed 500ms</h2>
      <p class="note">Pointer must rest 500ms before it appears.</p>
      <Tooltip text="Appears after 500ms" delay={500}>
        <button data-testid="delayed">Hover &amp; wait</button>
      </Tooltip>
    </div>

    <div class="card">
      <h2>Placement: bottom</h2>
      <p class="note">Requested below; flips above only if clipped.</p>
      <Tooltip text="Below the button" placement="bottom">
        <button data-testid="bottom">Below me</button>
      </Tooltip>
    </div>

    <div class="card">
      <h2>Rich content via <code>tip</code> snippet</h2>
      <p class="note">Custom markup instead of plain <code>text</code>.</p>
      <Tooltip placement="bottom">
        {#snippet tip()}
          <strong>Rich</strong> tooltip with <em>markup</em> and a shortcut
          <kbd>⌘K</kbd>.
        {/snippet}
        <button data-testid="rich">Info</button>
      </Tooltip>
    </div>

    <div class="card themed">
      <h2>Re-themed via CSS custom properties</h2>
      <p class="note">Same component, different <code>--tt-*</code> vars.</p>
      <Tooltip text="Light-on-dark accent tooltip">
        <button data-testid="themed">Themed</button>
      </Tooltip>
    </div>
  </section>

  <!-- Edge target pinned to the very top of the viewport: "top" must flip to
       "bottom" here because there is no room above. -->
  <div class="edge-top">
    <Tooltip text="Flipped below (no room above)" placement="top">
      <button data-testid="edge-top">Top-edge target</button>
    </Tooltip>
  </div>
</main>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
    width: 80vw;
    margin-top: 1rem;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    background: var(--bg-surface);
  }

  h2 {
    font-size: 1rem;
    margin-bottom: 0.25rem;
  }
  .note {
    color: var(--fg-dim);
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
  }

  code {
    color: var(--accent);
    font-size: 0.85em;
  }

  .card button {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--control-pad);
    font: inherit;
    font-size: 0.85rem;
    cursor: default;
  }

  /* Re-skin via custom properties — no component changes required. */
  .themed :global(.tt-tip) {
    --tt-bg: var(--accent);
    --tt-fg: #0b1020;
    --tt-border: var(--accent);
  }

  /* Pin an anchor to the top edge so "top" placement is forced to flip. */
  .edge-top {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    padding: 2px;
  }
  .edge-top button {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 10px;
    font: inherit;
    font-size: 0.8rem;
    cursor: default;
  }
</style>
