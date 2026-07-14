<!--
  CommandPalette — Cmd+Shift+P, center-top, fuzzy search over the command
  registry (core/commands.js). The palette is a pure SURFACING of commands:
  shortcuts, toolbar buttons, and future context menus run the same entries.
-->
<script>
  let { app } = $props();

  let query = $state("");
  let highlighted = $state(0);
  let inputEl = $state(null);

  let results = $derived(app.commands.search(query, app));

  $effect(() => {
    if (app.paletteOpen && inputEl) {
      query = "";
      highlighted = 0;
      inputEl.focus();
    }
  });

  function run(cmd) {
    app.paletteOpen = false;
    cmd.run(app);
  }

  function onkeydown(e) {
    if (e.key === "Escape") app.paletteOpen = false;
    else if (e.key === "ArrowDown") highlighted = Math.min(highlighted + 1, results.length - 1);
    else if (e.key === "ArrowUp") highlighted = Math.max(highlighted - 1, 0);
    else if (e.key === "Enter" && results[highlighted]) run(results[highlighted]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#if app.paletteOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-backdrop" onpointerdown={() => (app.paletteOpen = false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="palette" onpointerdown={(e) => e.stopPropagation()}>
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onkeydown}
        oninput={() => (highlighted = 0)}
        placeholder="Type a command…"
        spellcheck="false"
      />
      <div class="palette-results">
        {#each results as cmd, i (cmd.id)}
          <button
            class="palette-item"
            class:highlighted={i === highlighted}
            onpointerenter={() => (highlighted = i)}
            onclick={() => run(cmd)}
          >{cmd.title}</button>
        {/each}
        {#if !results.length}
          <div class="palette-none">No matching commands</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
