<!--
  CommandPalette — Cmd+Shift+P, center-top, fuzzy search over the command
  registry (core/commands.js). Supports SUBMENUS: a command with `children`
  drills down (breadcrumb shown above the input; Backspace on an empty query
  or Esc goes back up; Esc at the root closes). The palette is a pure
  SURFACING of commands: shortcuts, toolbar buttons, and future context menus
  run the same entries.
-->
<script>
  import "iconify-icon";
  import { keyIcon } from "../../../lib/keyicons.js";
  import { rpFuzzyMatchIndices } from "../core/fuzzy.js";

  let { app } = $props();

  /**
   * Pure function. Splits `title` into consecutive runs by whether each code
   * point is a fuzzy match (per rpFuzzyMatchIndices for `query`) — for wrapping
   * matched chars in <mark>. Empty/non-matching query → one unhit run of the
   * whole title. Iterates Array.from(title) so indices align with the walk.
   *
   * @example titleSegments("Distribute Horizontally", "dh")
   *   // [{text:"D",hit:true},{text:"istribute ",hit:false},
   *   //  {text:"H",hit:true},{text:"orizontally",hit:false}]
   * @example titleSegments("Group", "") // [{text:"Group",hit:false}]
   */
  function titleSegments(title, query) {
    const indices = query ? rpFuzzyMatchIndices(query, title) : null;
    if (!indices || !indices.length) return [{ text: title, hit: false }];
    const hit = new Set(indices);
    const chars = Array.from(title);
    const runs = [];
    for (let i = 0; i < chars.length; i += 1) {
      const isHit = hit.has(i);
      const last = runs[runs.length - 1];
      if (last && last.hit === isHit) last.text += chars[i];
      else runs.push({ text: chars[i], hit: isHit });
    }
    return runs;
  }

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
      app.runCommand(cmd.id); // routes through MRU tracking
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
            <!-- Fixed-width icon slot (same width whether filled or blank, so
                 titles align — user spec). -->
            <span class="icon-slot">
              {#if cmd.icon}
                <iconify-icon icon={cmd.icon} width="16" height="16"></iconify-icon>
              {/if}
            </span>
            <span class="title"
              >{#each titleSegments(cmd.title, query) as seg}{#if seg.hit}<mark class="fuzzy-hit">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
            >
            {#if app.shortcuts.commandKeys(cmd.id)}
              <span class="shortcut">
                {#each app.shortcuts.commandKeys(cmd.id) as key, ki}
                  {#if ki > 0}<span class="plus">+</span>{/if}<kbd>
                    {#if keyIcon(key)}<iconify-icon icon={keyIcon(key)} width="11" height="11"></iconify-icon>{:else}{key}{/if}
                  </kbd>
                {/each}
              </span>
            {/if}
            {#if cmd.children}<iconify-icon class="sub-arrow" icon="mdi:chevron-right" width="16" height="16"></iconify-icon>{/if}
          </button>
        {/each}
        {#if !results.length}
          <div class="palette-none">No matching commands</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
