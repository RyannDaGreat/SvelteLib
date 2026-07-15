<script>
  import ColorPicker from "../../lib/ColorPicker.svelte";

  // The value is an 8-digit hex "#rrggbbaa" — the SAME storage format PowerRP
  // uses for color properties (alpha integral). Bindable both ways.
  let fill = $state("#3b82f6ff");
  let stroke = $state("#ff0080cc");
  let translucent = $state("#00c85340");

  // Callback demo: split live oninput (preview) from onchange (settle).
  let cb = $state("#e11d48ff");
  let lastInput = $state("—");
  let lastChange = $state("—");
  let inputCount = $state(0);

  // Controlled (no bind:value): the parent owns state, onchange writes it back.
  let controlled = $state("#f59e0bff");

  // Light/dark toggle. The demo theme.css is a FIXED dark :root; toggling this
  // class re-points the theme tokens the ColorPicker consumes (--control-bg,
  // --fg, --border, --accent…) so we can verify BOTH looks. (Lib components
  // style themselves; this proves it tracks the ambient theme.)
  let light = $state(false);

  $effect(() => {
    document.documentElement.classList.toggle("light", light);
  });
</script>

<main class="demo-page">
  <h1>ColorPicker</h1>
  <p class="demo-hint">
    A saturation/value square + hue strip + alpha strip + hex field. Value is an
    8-digit <code>#rrggbbaa</code> string with <strong>integral alpha</strong>.
    Every gesture applies <strong>immediately</strong> — there is no commit key.
    Drag the square/strips or type a hex; a checkerboard shows through
    transparency. Native browser color input is not used.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="theme-toggle">
    <button onclick={() => (light = !light)}>
      Switch to {light ? "dark" : "light"} theme
    </button>
    <span class="demo-label">Verifying the picker in both light and dark.</span>
  </div>

  <section class="grid">
    <div class="card">
      <h2>Two-way binding</h2>
      <p class="note">
        <code>bind:value</code> — the swatches below reflect the live values.
      </p>
      <div class="pickers">
        <div class="labeled">
          <span>Fill</span>
          <ColorPicker bind:value={fill} />
          <code class="val">{fill}</code>
        </div>
        <div class="labeled">
          <span>Stroke</span>
          <ColorPicker bind:value={stroke} />
          <code class="val">{stroke}</code>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Transparency</h2>
      <p class="note">
        A translucent color (<code>{translucent}</code>) — drag the alpha strip;
        the checkerboard reads through.
      </p>
      <div class="labeled">
        <ColorPicker bind:value={translucent} />
      </div>
      <div class="over-image">
        <div class="over-swatch" style:background={translucent}></div>
        <span class="demo-label">over a photo</span>
      </div>
    </div>

    <div class="card">
      <h2>Callbacks (oninput / onchange)</h2>
      <p class="note">
        <code>oninput</code> fires on every gesture (live preview);
        <code>onchange</code> on settle. Wire only <code>onchange</code> and it
        still fires live per gesture.
      </p>
      <ColorPicker
        bind:value={cb}
        oninput={(v) => {
          lastInput = v;
          inputCount++;
        }}
        onchange={(v) => (lastChange = v)}
      />
      <ul class="events">
        <li>oninput: <code>{lastInput}</code> <span class="demo-label">({inputCount} fired)</span></li>
        <li>onchange: <code>{lastChange}</code></li>
      </ul>
    </div>

    <div class="card">
      <h2>Controlled (no bind)</h2>
      <p class="note">
        Parent owns the state; <code>onchange</code> writes it back. Value:
        <code>{controlled}</code>.
      </p>
      <ColorPicker value={controlled} onchange={(v) => (controlled = v)} />
    </div>

    <div class="card">
      <h2>Disabled</h2>
      <p class="note">Non-interactive.</p>
      <ColorPicker value="#7c3aedff" disabled={true} />
    </div>

    <div class="card themed">
      <h2>Re-themed via CSS custom properties</h2>
      <p class="note">
        Same component; only <code>--cp-*</code> vars differ on the wrapper
        (rounded corners, larger square, warm checkerboard).
      </p>
      <ColorPicker value="#0ea5e9ff" />
    </div>
  </section>
</main>

<style>
  /* Light-theme override of the demo tokens the picker reads. */
  :global(:root.light) {
    --bg: #f4f4f6;
    --bg-surface: rgba(0, 0, 0, 0.03);
    --fg: #1a1a1a;
    --fg-dim: #666;
    --accent: #2563eb;
    --border: rgba(0, 0, 0, 0.18);
    --control-bg: #ffffff;
  }
  /* Dark-theme control background (theme.css sets --control-bg to a translucent
     black; the picker wants an opaque surface behind its inputs). */
  :global(:root:not(.light)) {
    --control-bg: #23232e;
  }

  .theme-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 1rem;
  }
  .theme-toggle button {
    background: var(--control-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 12px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
    width: 80vw;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .val {
    display: inline-block;
    margin-top: 4px;
  }

  .pickers {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .labeled {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .labeled > span {
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  .events {
    list-style: none;
    padding: 0;
    margin-top: 0.75rem;
    font-size: 0.85rem;
  }
  .events li {
    margin: 2px 0;
  }

  .over-image {
    margin-top: 0.9rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .over-swatch {
    width: 100%;
    height: 44px;
    border: 1px solid var(--border);
    /* A busy backdrop so translucency is visible. */
    background-image: repeating-linear-gradient(
      45deg,
      var(--accent) 0 10px,
      transparent 0 20px
    );
  }

  /* Re-skin via custom properties — no component changes. */
  .themed :global(.cp) {
    --cp-corner: 8px;
    --cp-square-size: 200px;
    --cp-checker-light: #fff8e7;
    --cp-checker-dark: #e6d9b8;
    --cp-accent: #b58900;
  }
</style>
