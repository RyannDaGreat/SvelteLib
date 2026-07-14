<!--
  Toolbar — top bar. Buttons are surfacings of registry commands (same
  entries the palette and shortcuts run), so nothing here has behavior of
  its own.
-->
<script>
  import "iconify-icon";

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
      <button class="btn-icon" onclick={() => app.runCommand(id)} title={tip}>
        <iconify-icon {icon} width="18" height="18"></iconify-icon>
      </button>
    {/each}
  {/each}
  <span class="spacer"></span>
  <button class="btn-icon" onclick={() => app.toggleLightDark()} title="Toggle light/dark (all themes: palette → Color Theme)">
    <iconify-icon icon={app.theme === "light" ? "mdi:weather-night" : "mdi:weather-sunny"} width="18" height="18"></iconify-icon>
  </button>
  <button class="btn palette-hint" onclick={() => (app.paletteOpen = true)} title="Command palette">
    ⌘⇧P
  </button>
</div>
