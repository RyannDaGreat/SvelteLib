<!--
  Toolbar — top bar. Buttons are surfacings of registry commands (same
  entries the palette and shortcuts run), so nothing here has behavior of
  its own. Hover help uses SvelteLib's immediate Tooltip (never native
  title= — manifest rule).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { app } = $props();

  // [command id, icon, tooltip]
  const groups = [
    [
      ["add-rect", "mdi:rectangle-outline", "Add Rectangle"],
      ["add-circle", "mdi:circle-outline", "Add Circle"],
      ["add-text", "mdi:format-text", "Add Text"],
      ["add-arrow", "mdi:arrow-top-right", "Add Arrow"],
      ["add-magnifier", "mdi:magnify", "Add Magnifier"],
      ["add-blur", "mdi:blur", "Add Blur Layer"],
    ],
    [
      ["undo", "mdi:undo", "Undo (Cmd+Z)"],
      ["redo", "mdi:redo", "Redo (Cmd+Shift+Z)"],
    ],
    [
      ["copy-item", "mdi:content-copy", "Copy item (Cmd+C)"],
      ["paste", "mdi:content-paste", "Paste (Cmd+V)"],
    ],
    [
      ["put-on-top", "mdi:arrange-bring-to-front", "Put on Top"],
      ["put-on-bottom", "mdi:arrange-send-to-back", "Put on Bottom"],
    ],
    [
      ["save-file", "mdi:content-save-outline", "Save (.powerrp.json)"],
      ["load-file", "mdi:folder-open-outline", "Load"],
    ],
    [
      ["reset-view", "mdi:fit-to-screen-outline", "Zoom to fit slide"],
      ["present", "mdi:play", "Present (fullscreen)"],
    ],
  ];
</script>

<div class="toolbar">
  <span class="doc-name">{app.doc.meta.name}</span>
  {#each groups as group, gi}
    {#if gi > 0}<span class="sep"></span>{/if}
    {#each group as [id, icon, tip]}
      <!-- Disabled state comes from the command's own `when` (grayed out when
           it can't run — e.g. Copy with nothing selected). -->
      <Tooltip text={tip}>
        <button
          class="btn-icon"
          aria-label={tip}
          disabled={app.commands.get(id).when && !app.commands.get(id).when(app)}
          onclick={() => app.runCommand(id)}
        >
          <iconify-icon {icon} width="18" height="18"></iconify-icon>
        </button>
      </Tooltip>
    {/each}
  {/each}
  <span class="spacer"></span>
  <Tooltip text="Toggle light/dark — all themes: palette › Color Theme">
    <button class="btn-icon" aria-label="Toggle light/dark theme" onclick={() => app.toggleLightDark()}>
      <iconify-icon icon={app.theme === "light" ? "mdi:weather-night" : "mdi:weather-sunny"} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Command palette (Cmd+Shift+P)">
    <button class="btn-icon" aria-label="Command palette" onclick={() => app.runCommand("toggle-palette")}>
      <iconify-icon icon="mdi:chevron-down-box-outline" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
</div>
