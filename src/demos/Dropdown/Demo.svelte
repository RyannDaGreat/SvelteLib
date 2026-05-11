<script>
  import Dropdown from "../../lib/Dropdown.svelte";

  const fruits = [
    { value: "apple", label: "Apple" },
    { value: "banana", label: "Banana" },
    { value: "cherry", label: "Cherry" },
    { value: "durian", label: "Durian", disabled: true },
    { value: "elderberry", label: "Elderberry" },
    { value: "fig", label: "Fig" },
    { value: "grape", label: "Grape" },
  ];

  const themes = [
    { value: "tokyo-night", label: "Tokyo Night", icon: "mdi:weather-night" },
    { value: "solarized-light", label: "Solarized Light", icon: "mdi:weather-sunny" },
    { value: "dracula", label: "Dracula", icon: "mdi:ghost" },
    { value: "monokai", label: "Monokai", icon: "mdi:palette" },
  ];

  const fonts = ["Inter", "JetBrains Mono", "Fira Code", "IBM Plex Sans"].map((f) => ({
    value: f,
    label: f,
  }));

  let fruit = $state("banana");
  let theme = $state("tokyo-night");
  let font = $state("Inter");
  let query = $state("");

  const filteredFonts = $derived(
    fonts.filter((f) => f.label.toLowerCase().includes(query.toLowerCase())),
  );
</script>

<main class="demo-page">
  <h1>Dropdown</h1>
  <p class="demo-hint">
    Themable single-select. Drop-in replacement for <code>&lt;select&gt;</code>, plus snippet
    hooks for trigger / item / header / footer.
  </p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <section class="grid">
    <div class="card">
      <h2>Default</h2>
      <p class="note">Plain items array. Bound to <code>{fruit}</code>.</p>
      <Dropdown items={fruits} bind:value={fruit} />
    </div>

    <div class="card">
      <h2>Custom trigger + item snippets</h2>
      <p class="note">Icons in both trigger and rows. Theme: <code>{theme}</code>.</p>
      <Dropdown items={themes} bind:value={theme}>
        {#snippet trigger(current)}
          <iconify-icon icon={current?.icon ?? "mdi:palette-outline"} width="16" height="16"
          ></iconify-icon>
          <span>{current?.label ?? "Pick a theme"}</span>
          <span class="caret" aria-hidden="true">▾</span>
        {/snippet}
        {#snippet item(it)}
          <span class="row">
            <iconify-icon icon={it.icon} width="16" height="16"></iconify-icon>
            <span>{it.label}</span>
          </span>
        {/snippet}
      </Dropdown>
    </div>

    <div class="card">
      <h2>Header + footer (search-ahead sketch)</h2>
      <p class="note">
        Header hosts a filter input; list narrows live. Footer hosts an action. Selected:
        <code>{font}</code>.
      </p>
      <Dropdown items={filteredFonts} bind:value={font} placeholder="Pick a font">
        {#snippet header()}
          <input
            class="search"
            type="text"
            placeholder="Filter fonts…"
            bind:value={query}
            onkeydown={(e) => e.stopPropagation()}
          />
        {/snippet}
        {#snippet footer()}
          <button class="reset" onclick={() => (query = "")}>Clear filter</button>
        {/snippet}
      </Dropdown>
    </div>

    <div class="card themed">
      <h2>Re-themed via CSS custom properties</h2>
      <p class="note">Same component, different vars on the wrapper.</p>
      <Dropdown items={fruits} bind:value={fruit} />
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

  .row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .caret {
    font-size: 0.7em;
    opacity: 0.7;
  }

  .search {
    width: 100%;
    background: rgba(0, 0, 0, 0.4);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
    font: inherit;
    font-size: 0.85rem;
  }

  .reset {
    width: 100%;
    background: transparent;
    color: var(--accent);
    border: none;
    padding: 2px;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    text-align: left;
  }
  .reset:hover {
    text-decoration: underline;
  }

  /* Re-skin via custom properties — no component changes required. */
  .themed :global(.dd) {
    --dd-bg: #fdf6e3;
    --dd-fg: #586e75;
    --dd-border: #93a1a1;
    --dd-hover-bg: #eee8d5;
    --dd-active-bg: #b58900;
    --dd-active-fg: #fdf6e3;
    --dd-radius: 12px;
    --dd-padding: 6px 12px;
  }
</style>
