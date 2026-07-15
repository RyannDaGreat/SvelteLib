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
  import KeyCombo from "../../../lib/KeyCombo.svelte";
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
  let resultsEl = $state(null); // the scrollable results list

  let parent = $derived(stack.length ? stack[stack.length - 1] : null);
  // `used` inside the registry is a plain (non-reactive) Map, so markUsed() from
  // runCommand can't dirty this derived. Read app.paletteOpen (flips on every
  // open) so the empty-query MRU order is recomputed fresh each time the palette
  // is shown — even when query/stack are unchanged from the prior open.
  let results = $derived(app.paletteOpen ? app.commands.search(query, app, parent) : []);

  /** Command. Resets the highlight to the first row AND snaps the list back
   * to the top — the two must move together: open, typing, submenu drill,
   * and back-up all restart the list, and a stale scroll offset would leave
   * row 0 highlighted but out of view. */
  function resetHighlight() {
    highlighted = 0;
    if (resultsEl) resultsEl.scrollTop = 0;
  }

  /** Command. Keeps the KEYBOARD-highlighted row visible. Called ONLY from
   * the arrow-key branches — row hover (pointermove) also moves `highlighted`,
   * but hover must never yank the scroll position. scrollIntoView follows Dropdown's
   * scrollTargetIntoView precedent (src/lib/Dropdown.svelte); it centers on
   * OPEN, whereas per-keystroke stepping wants {block: "nearest"} so the list
   * moves only when the row would leave view. Safe pre-flush: the row
   * elements already exist — arrows just move the highlight among them. */
  function scrollHighlightedIntoView() {
    resultsEl?.querySelectorAll(".palette-item")[highlighted]?.scrollIntoView({ block: "nearest" });
  }

  $effect(() => {
    if (app.paletteOpen && inputEl) {
      query = "";
      stack = [];
      resetHighlight();
      inputEl.focus();
    }
  });

  function activate(cmd) {
    if (cmd.children) {
      stack = [...stack, cmd];
      query = "";
      resetHighlight();
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
      resetHighlight();
    } else {
      app.paletteOpen = false;
    }
  }

  function onkeydown(e) {
    if (e.key === "Escape") back();
    else if (e.key === "Backspace" && query === "" && stack.length) back();
    else if (e.key === "ArrowDown") {
      highlighted = Math.min(highlighted + 1, results.length - 1);
      scrollHighlightedIntoView();
    } else if (e.key === "ArrowUp") {
      highlighted = Math.max(highlighted - 1, 0);
      scrollHighlightedIntoView();
    } else if (e.key === "Enter" && results[highlighted]) activate(results[highlighted]);
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
          <!-- Separator is an mdi chevron (iconify-only rule — the "›" glyph
               is in the manifest's banned set), matching the row sub-arrow. -->
          {#each stack as s, i}{#if i > 0}<iconify-icon class="crumb-sep" icon="mdi:chevron-right" width="12" height="12"></iconify-icon>{/if}{s.title}{/each}
        </div>
      {/if}
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onkeydown}
        oninput={resetHighlight}
        placeholder={parent ? `${parent.title}…` : "Type a command…"}
        spellcheck="false"
      />
      <div class="palette-results" bind:this={resultsEl}>
        {#each results as cmd, i (cmd.id)}
          <!-- Hover-highlight keys on pointerMOVE, not pointerenter: keyboard
               navigation scrolls the list, which slides rows UNDER a stationary
               cursor — that fires pointerenter (yanking the highlight off the
               keyboard row) but never pointermove, which only fires on genuine
               mouse movement. So hover still highlights instantly, and hover
               and keyboard can't fight (the VS Code list rule). -->
          <button
            class="palette-item"
            class:highlighted={i === highlighted}
            onpointermove={() => (highlighted = i)}
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
                <KeyCombo keys={app.shortcuts.commandKeys(cmd.id)} />
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
