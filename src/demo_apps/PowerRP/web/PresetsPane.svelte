<!--
  Presets Pane — a GENERIC, reusable tool, NOT lens-flare-specific.

  Any plugin may declare `presets: [{ name, description?, props }]` — built-in
  property-sets. When the selected widget's plugin has presets, this pane lists
  them as clickable cards; clicking one SETS those props on the selected item IN
  THE CURRENT FRAME (keyframed writes, ONE undo unit) via app.applyPreset — the
  same commit path the Inspector rows use. It is purely a surfacing of that
  command, exactly like the palette/toolbar surface the command registry.

  There is no save/load-your-own here by design (built-in presets only). Widgets
  without presets get a quiet empty state, like the Inspector's "nothing selected".

  Styling lives in app.css (.presetspane; app convention: no <style> blocks).
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { app } = $props();

  // The selected item's plugin + its presets (reactive off selection + doc).
  let node = $derived(app.selectedNode());
  let presets = $derived(node?.plugin?.presets ?? []);
</script>

<div class="presetspane">
  {#if !node}
    <div class="empty">Select a widget to see its presets.</div>
  {:else if presets.length === 0}
    <div class="empty">{node.plugin.title ?? node.plugin.type} has no presets.</div>
  {:else}
    <div class="preset-grid">
      {#each presets as preset (preset.name)}
        <Tooltip text={preset.description ?? `Apply the ${preset.name} preset to the current frame`}>
          <button
            class="preset-card"
            onclick={() => app.applyPreset(app.selection, preset)}
          >
            <span class="preset-name">{preset.name}</span>
            {#if preset.description}
              <span class="preset-desc">{preset.description}</span>
            {/if}
          </button>
        </Tooltip>
      {/each}
    </div>
  {/if}
</div>
