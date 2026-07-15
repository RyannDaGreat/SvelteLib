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
      ["clear-doc", "mdi:broom", "Clear document (undoable)"],
    ],
    [
      ["reset-view", "mdi:fit-to-screen-outline", "Zoom to fit camera"],
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
  <span class="sep"></span>
  <!-- Snap toggles: ACTIVE (accent) when the setting is on; while a snap is
       actually ENGAGED mid-drag the icon takes the guide color (snap-engaged). -->
  <Tooltip text="Toggle snapping (guides on move/resize)">
    <button
      class="btn-icon"
      class:active={app.snapEnabled}
      class:snap-engaged={app.snapEngaged}
      aria-label="Toggle snapping"
      aria-pressed={app.snapEnabled}
      onclick={() => app.runCommand("toggle-snap")}
    >
      <iconify-icon icon="mdi:magnet" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Toggle snap to matching size (dimension indicators)">
    <button
      class="btn-icon"
      class:active={app.snapSizeEnabled}
      class:snap-engaged={app.snapEngaged}
      aria-label="Toggle snap to matching size"
      aria-pressed={app.snapSizeEnabled}
      onclick={() => app.runCommand("toggle-snap-size")}
    >
      <iconify-icon icon="mdi:magnet-on" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Toggle anchor visibility (endpoint binding targets)">
    <button
      class="btn-icon"
      class:active={app.anchorsVisible}
      aria-label="Toggle anchor visibility"
      aria-pressed={app.anchorsVisible}
      onclick={() => app.runCommand("toggle-anchors")}
    >
      <!-- User-specified composite (round-11 correction: NOT a literal
           anchor glyph — the X-cross that anchors render as on canvas,
           CENTERED in the magnet; iconify-only rule, stacked mdi glyphs). -->
      <span class="icon-stack">
        <iconify-icon icon="mdi:magnet" width="18" height="18"></iconify-icon>
        <iconify-icon class="icon-stack-overlay" icon="mdi:close" width="9" height="9"></iconify-icon>
      </span>
    </button>
  </Tooltip>
  <span class="spacer"></span>
  <!-- Tooltip is a plain-text prop (no iconify possible), so no arrow glyph:
       worded around it instead ("›" is in the manifest's banned set). -->
  <Tooltip text={'Toggle light/dark — all themes: palette, "Color Theme"'}>
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
