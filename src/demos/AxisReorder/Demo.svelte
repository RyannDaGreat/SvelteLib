<script>
  import AxisReorder from "../../lib/AxisReorder.svelte";

  const ORIGINAL_CARDS = [
    { id: "alfa", label: "Alfa" },
    { id: "bravo", label: "Bravo" },
    { id: "charlie", label: "Charlie" },
    { id: "delta", label: "Delta" }
  ];
  const ORIGINAL_ROWS = [
    { id: "cedar", label: "Cedar" },
    { id: "maple", label: "Maple" },
    { id: "oak", label: "Oak" },
    { id: "pine", label: "Pine" }
  ];

  let cards = $state([...ORIGINAL_CARDS]);
  let rows = $state([...ORIGINAL_ROWS]);
  let message = $state("Drag an item or activate it.");
  let commits = $state(0);
  let activations = $state(0);

  /** Command. Publishes one completed reorder for the demo. */
  function commit(kind, next) {
    if (kind === "card") cards = next;
    else rows = next;
    commits += 1;
    message = `${kind} order committed`;
  }

  /** Command. Records one click or keyboard activation for the demo. */
  function activate(kind, item) {
    activations += 1;
    message = `${kind} ${item.label} activated`;
  }

  /** Command. Restores both controlled sequences. */
  function reset() {
    cards = [...ORIGINAL_CARDS];
    rows = [...ORIGINAL_ROWS];
    message = "Orders reset.";
    commits = 0;
    activations = 0;
  }
</script>

<main class="demo-page">
  <h1>AxisReorder</h1>
  <p class="demo-hint">One headless mechanism previews and commits either horizontal or vertical order. All visuals live in this demo.</p>
  <a class="demo-back" href="/">&larr; All Components</a>

  <div class="demo-controls">
    <button onclick={reset}>Reset</button>
    <span class="demo-label" data-message>{message}</span>
    <span class="demo-label" data-commits>{commits} commits</span>
    <span class="demo-label" data-activations>{activations} activations</span>
  </div>

  <section class="examples">
    <AxisReorder axis="x" items={cards} onchange={next => commit("card", next)} onactivate={item => activate("card", item)}>
      {#snippet children(state, actions)}
        <div class="cards" data-axis="x">
          {#each state.items as card (card.id)}
            <button
              class="card"
              class:source={state.isSource(card)}
              data-id={card.id}
              {@attach actions.slot(card)}
              onpointerdown={event => actions.begin(card, event)}
              onclick={event => actions.click(card, event)}
            >{card.label}</button>
          {/each}
        </div>
        {#if state.drag}
          <div
            class="card ghost"
            data-ghost="x"
            style:left={`${state.drag.position}px`}
            style:top={`${state.drag.rect.top}px`}
            style:width={`${state.drag.size}px`}
            style:height={`${state.drag.rect.height}px`}
          >{state.drag.item.label}</div>
        {/if}
      {/snippet}
    </AxisReorder>

    <AxisReorder axis="y" items={rows} onchange={next => commit("row", next)} onactivate={item => activate("row", item)}>
      {#snippet children(state, actions)}
        <div class="rows" data-axis="y">
          {#each state.items as row (row.id)}
            <button
              class="row"
              class:source={state.isSource(row)}
              data-id={row.id}
              {@attach actions.slot(row)}
              onpointerdown={event => actions.begin(row, event)}
              onclick={event => actions.click(row, event)}
            >{row.label}</button>
          {/each}
        </div>
        {#if state.drag}
          <div
            class="row ghost"
            data-ghost="y"
            style:left={`${state.drag.rect.left}px`}
            style:top={`${state.drag.position}px`}
            style:width={`${state.drag.rect.width}px`}
            style:height={`${state.drag.size}px`}
          >{state.drag.item.label}</div>
        {/if}
      {/snippet}
    </AxisReorder>
  </section>
</main>

<style>
  .demo-controls { margin-bottom: 1rem; }
  .examples { width: min(48rem, 80vw); display: grid; gap: 2rem; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); }
  .rows { display: grid; }
  .card, .row { min-width: 0; padding: 1rem; border: 1px solid var(--border); border-radius: 0; background: var(--bg-surface); color: var(--fg); cursor: grab; touch-action: none; }
  .card + .card, .row + .row { border-left: 0; }
  .row + .row { border-top: 0; border-left: 1px solid var(--border); }
  .source { visibility: hidden; }
  .ghost { position: fixed; z-index: 1; pointer-events: none; background: var(--accent); color: var(--bg); }
</style>
