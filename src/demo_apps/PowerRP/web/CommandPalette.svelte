<!--
  CommandPalette — Cmd+Shift+P, center-top, fuzzy search over the command
  registry (core/commands.js). Supports SUBMENUS: a command with `children`
  drills down (breadcrumb shown above the input; Backspace on an empty query
  or Esc goes back up; Esc at the root closes). The palette is a pure
  SURFACING of commands: shortcuts, toolbar buttons, and future context menus
  run the same entries.
-->
<script>
  let { app } = $props();

  let query = $state("");
  let highlighted = $state(0);
  let stack = $state([]); // drill-down path of submenu entries
  let inputEl = $state(null);

  let parent = $derived(stack.length ? stack[stack.length - 1] : null);
  let results = $derived(app.commands.search(query, app, parent));

  $effect(() => {
    if (app.paletteOpen && inputEl) {
      query = "";
      highlighted = 0;
      stack = [];
      inputEl.focus();
    }
  });

  function activate(cmd) {
    if (cmd.children) {
      stack = [...stack, cmd];
      query = "";
      highlighted = 0;
      inputEl.focus();
    } else {
      app.paletteOpen = false;
      cmd.run(app);
    }
  }

  function back() {
    if (stack.length) {
      stack = stack.slice(0, -1);
      query = "";
      highlighted = 0;
    } else {
      app.paletteOpen = false;
    }
  }

  function onkeydown(e) {
    if (e.key === "Escape") back();
    else if (e.key === "Backspace" && query === "" && stack.length) back();
    else if (e.key === "ArrowDown") highlighted = Math.min(highlighted + 1, results.length - 1);
    else if (e.key === "ArrowUp") highlighted = Math.max(highlighted - 1, 0);
    else if (e.key === "Enter" && results[highlighted]) activate(results[highlighted]);
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
      {#if stack.length}
        <div class="palette-crumbs">
          {#each stack as s, i}{i > 0 ? " › " : ""}{s.title}{/each}
        </div>
      {/if}
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onkeydown}
        oninput={() => (highlighted = 0)}
        placeholder={parent ? `${parent.title}…` : "Type a command…"}
        spellcheck="false"
      />
      <div class="palette-results">
        {#each results as cmd, i (cmd.id)}
          <button
            class="palette-item"
            class:highlighted={i === highlighted}
            onpointerenter={() => (highlighted = i)}
            onclick={() => activate(cmd)}
          >
            <span class="title">{cmd.title}</span>
            {#if cmd.children}<span class="sub-arrow">›</span>{/if}
          </button>
        {/each}
        {#if !results.length}
          <div class="palette-none">No matching commands</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
