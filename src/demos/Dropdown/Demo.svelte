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

  /* Multi-select: plain items, value is an array. */
  const toppings = [
    { value: "cheese", label: "Cheese" },
    { value: "mushroom", label: "Mushroom" },
    { value: "pepperoni", label: "Pepperoni" },
    { value: "olive", label: "Olive" },
    { value: "pineapple", label: "Pineapple", disabled: true },
    { value: "basil", label: "Basil" },
  ];

  /* Inserts: {insert} entries render BETWEEN rows. The dotted-line look here is
     adapter-supplied (via --dd-insert-* on the .sectioned wrapper below); the
     component bakes in no separator style. Section captions are inserts too. */
  const sectioned = [
    { insert: "Fruits" },
    { value: "apple", label: "Apple" },
    { value: "banana", label: "Banana" },
    { insert: "Vegetables" },
    { value: "carrot", label: "Carrot" },
    { value: "potato", label: "Potato" },
    { insert: "Grains" },
    { value: "rice", label: "Rice" },
    { value: "wheat", label: "Wheat" },
  ];

  /* Long list to demonstrate scroll-to-on-open. */
  const cities = [
    "Amsterdam", "Berlin", "Cairo", "Denver", "Edinburgh", "Florence",
    "Geneva", "Helsinki", "Istanbul", "Jakarta", "Kyoto", "Lisbon",
    "Madrid", "Nairobi", "Oslo", "Prague", "Quito", "Rome",
    "Seoul", "Tokyo", "Utrecht", "Vienna", "Warsaw", "Zurich",
  ].map((c) => ({ value: c.toLowerCase(), label: c }));

  let fruit = $state("banana");
  let theme = $state("tokyo-night");
  let font = $state("Inter");
  let query = $state("");
  let picks = $state(["cheese", "basil"]);
  let plant = $state("carrot");
  let city = $state("rome");

  const filteredFonts = $derived(
    fonts.filter((f) => f.label.toLowerCase().includes(query.toLowerCase())),
  );

  /* Custom summary override: list the labels instead of "N selected". */
  function joinLabels(values, items) {
    if (!values.length) return "Any toppings…";
    return values
      .map((v) => items.find((it) => it.value === v)?.label ?? v)
      .join(", ");
  }
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
      <p class="note">Same component, just different vars on the wrapper.</p>
      <Dropdown items={fruits} bind:value={fruit} />
    </div>

    <div class="card">
      <h2>Multi-select</h2>
      <p class="note">
        <code>multiple</code> + array <code>value</code>. Clicking toggles without closing;
        checkmarks show membership. Selected: <code>[{picks.join(", ")}]</code>.
      </p>
      <Dropdown items={toppings} bind:value={picks} multiple placeholder="Pick toppings" />
    </div>

    <div class="card">
      <h2>Multi-select + custom summary</h2>
      <p class="note">
        Same data, but a <code>summary(values, items)</code> prop lists the chosen labels
        instead of the default "N selected".
      </p>
      <Dropdown
        items={toppings}
        bind:value={picks}
        multiple
        summary={joinLabels}
        placeholder="Pick toppings"
      />
    </div>

    <div class="card sectioned">
      <h2>Inserts between items (sectioned)</h2>
      <p class="note">
        <code>{"{ insert: … }"}</code> entries render between rows. Arrow keys skip them; they
        select nothing. The dotted separators here are <em>adapter</em>-supplied via
        <code>--dd-insert-*</code> — the component bakes in no style. Selected: <code>{plant}</code>.
      </p>
      <Dropdown items={sectioned} bind:value={plant} placeholder="Pick produce" />
    </div>

    <div class="card">
      <h2>Scroll-to-value on open</h2>
      <p class="note">
        Long list; <code>scrollToValue</code> centers the target row when the menu opens.
        City: <code>{city}</code>.
      </p>
      <Dropdown items={cities} bind:value={city} scrollToValue={city} placeholder="Pick a city" />
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

  /* Demos with longer menu labels need a wider trigger so items don't
     truncate (the menu is constrained to the trigger's width). */
  .grid :global(.dd) {
    min-width: 160px;
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
    --dd-padding: 6px 14px;
  }

  /* Adapter recipe for sectioned lists: opt into a dotted separator + caption
     look purely via the insert custom properties. The component ships no
     separator style; this is entirely consumer-side. */
  .sectioned :global(.dd) {
    --dd-insert-padding: 8px 10px 2px;
    --dd-insert-color: var(--fg-dim);
    --dd-insert-border: 1px dotted var(--border);
  }
  .sectioned :global(.dd-insert) {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
</style>
