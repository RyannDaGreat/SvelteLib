<script>
  import DraggableNumber from "../../lib/DraggableNumber.svelte";

  // A little "transform inspector" — the classic home for scrubbable numbers.
  let x = $state(120);
  let y = $state(64);
  let rotation = $state(0);
  let scale = $state(1);

  let opacity = $state(0.5); // bounded 0..1, fine coefficient
  let volume = $state(50); // bounded 0..100, stepped
  let free = $state(0); // fully unbounded, plain (no wheel)
  let lastEvent = $state("—");
</script>

<main class="demo-page">
  <h1>DraggableNumber</h1>
  <p class="demo-hint">
    Click-drag a number up/down to scrub it. The cursor is pinned in place via the Pointer Lock
    API while you drag (grant the permission if prompted). Hold <kbd>Shift</kbd> for fine
    adjustment; <kbd>↑</kbd>/<kbd>↓</kbd> nudge; <kbd>Home</kbd>/<kbd>End</kbd> jump to min/max when
    bounded. NOT a slider — there is no track, no begin, no end.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <section class="grid">
    <div class="card">
      <h2>Transform inspector</h2>
      <p class="note">Unbounded position, wrapped rotation, fine scale. The classic use case.</p>
      <div class="rows">
        <label class="field"><span>X</span><DraggableNumber bind:value={x} suffix="px" /></label>
        <label class="field"><span>Y</span><DraggableNumber bind:value={y} suffix="px" /></label>
        <label class="field"
          ><span>Rotation</span><DraggableNumber bind:value={rotation} suffix="°" /></label
        >
        <label class="field"
          ><span>Scale</span><DraggableNumber
            bind:value={scale}
            coefficient={0.01}
            min={0}
            step={0.01}
          /></label
        >
      </div>
      <div class="preview">
        <div
          class="box"
          style:transform={`translate(${x % 200}px, ${y % 120}px) rotate(${rotation}deg) scale(${Math.max(0, scale)})`}
        ></div>
      </div>
    </div>

    <div class="card">
      <h2>Bounded &amp; stepped</h2>
      <p class="note">
        Opacity clamps to <code>[0, 1]</code> with a <code>0.01</code> coefficient. Volume clamps to
        <code>[0, 100]</code> in steps of <code>5</code>. Try <kbd>Home</kbd>/<kbd>End</kbd>.
      </p>
      <div class="rows">
        <label class="field"
          ><span>Opacity</span><DraggableNumber
            bind:value={opacity}
            coefficient={0.01}
            min={0}
            max={1}
            step={0.01}
          /></label
        >
        <label class="field"
          ><span>Volume</span><DraggableNumber
            bind:value={volume}
            min={0}
            max={100}
            step={5}
            suffix="%"
          /></label
        >
      </div>
      <div class="bars">
        <div class="bar"><span style:width={`${opacity * 100}%`}></span></div>
        <div class="bar"><span style:width={`${volume}%`}></span></div>
      </div>
    </div>

    <div class="card">
      <h2>No wheel, callbacks</h2>
      <p class="note">
        <code>wheel={false}</code> — just the number with a scrub cursor. Wired to
        <code>oninput</code>/<code>onchange</code>. Last event: <code>{lastEvent}</code>.
      </p>
      <label class="field"
        ><span>Free</span><DraggableNumber
          bind:value={free}
          wheel={false}
          oninput={(v) => (lastEvent = `input ${v}`)}
          onchange={(v) => (lastEvent = `change ${v} (settled)`)}
        /></label
      >
    </div>

    <div class="card themed">
      <h2>Re-themed via CSS custom properties</h2>
      <p class="note">Same component; only <code>--dn-*</code> vars differ on the wrapper.</p>
      <div class="rows">
        <label class="field"
          ><span>X</span><DraggableNumber bind:value={x} suffix="px" /></label
        >
        <label class="field"
          ><span>Scale</span><DraggableNumber bind:value={scale} coefficient={0.01} min={0} /></label
        >
      </div>
    </div>
  </section>
</main>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
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
  kbd {
    font-size: 0.8em;
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .field > span {
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  .preview {
    margin-top: 0.9rem;
    height: 140px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    position: relative;
    background: rgba(0, 0, 0, 0.25);
  }
  .box {
    position: absolute;
    left: 12px;
    top: 8px;
    width: 40px;
    height: 40px;
    background: var(--accent);
    border-radius: 2px;
  }

  .bars {
    margin-top: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar {
    height: 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  /* Re-skin via custom properties — no component changes required. */
  .themed :global(.dn) {
    --dn-bg: #fdf6e3;
    --dn-fg: #586e75;
    --dn-fg-dim: #93a1a1;
    --dn-border: #93a1a1;
    --dn-accent: #b58900;
    --dn-hover-bg: #eee8d5;
    --dn-radius: 2px;
  }
</style>
