<!--
  PowerRP App shell. Layout via SvelteLib SplitPane:
    [ toolbar ]
    [ SlideNav | Canvas | Inspector/Keyframes ]
    [ HintBar ]
  All actions live in the command registry; keyboard shortcuts and toolbar
  buttons surface those commands. The HintBar is fed by the shortcut registry
  — the single source of truth for "what inputs exist right now".
-->
<script>
  import SplitPane from "../../../lib/SplitPane.svelte";
  import HintBar from "../../../lib/HintBar.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Toolbar from "./Toolbar.svelte";
  import SlideNav from "./SlideNav.svelte";
  import CanvasView from "./CanvasView.svelte";
  import Inspector from "./Inspector.svelte";
  import KeyframePanel from "./KeyframePanel.svelte";
  import CommandPalette from "./CommandPalette.svelte";
  import PresentMode from "./PresentMode.svelte";
  import { PowerRPApp, THEMES } from "./app.svelte.js";
  import { keyframed } from "../core/document.js";

  const app = new PowerRPApp();
  app.loadAutosave();
  app.loadTheme();
  app.loadMru();
  window.__powerrp_app = app; // dev/test hook (headless smoke tests introspect via this)

  // SplitPane splits are BOUNDARY positions: [0.16, 0.78] → 3 panes.
  let hSplits = $state([0.16, 0.78]);
  let rightSplits = $state([0.5]);

  // ── Core commands (plugins added theirs at registration) ──────────────────
  const needsSelection = (a) => a.selection !== null;
  // purgeable:false widgets (the camera) can be neither deleted nor purged.
  const needsPurgeable = (a) => a.selectedNode()?.plugin.capabilities.purgeable !== false && a.selection !== null;
  // Per-theme palette icons (mdi), keyed by THEMES[].id. No colors (user spec).
  const THEME_ICONS = {
    graphite: "mdi:brightness-6",
    light: "mdi:weather-sunny",
    black: "mdi:weather-night",
    warm: "mdi:palette-swatch-outline",
  };
  const coreCommands = [
    { id: "delete-item", title: "Delete (deactivate on this slide)", icon: "mdi:eye-off-outline", when: needsPurgeable, run: (a) => a.deleteSelection() },
    { id: "purge-item", title: "Purge Item (remove from existence)", icon: "mdi:delete-forever-outline", when: needsPurgeable, run: (a) => a.purgeSelection() },
    { id: "bring-forward", title: "Bring Forward", icon: "mdi:arrange-bring-forward", when: needsSelection, run: (a) => a.reorderSelection(+1) },
    { id: "send-backward", title: "Send Backward", icon: "mdi:arrange-send-backward", when: needsSelection, run: (a) => a.reorderSelection(-1) },
    { id: "put-on-top", title: "Put on Top", icon: "mdi:arrange-bring-to-front", when: needsSelection, run: (a) => a.sendToExtreme(+1) },
    { id: "put-on-bottom", title: "Put on Bottom", icon: "mdi:arrange-send-to-back", when: needsSelection, run: (a) => a.sendToExtreme(-1) },
    { id: "distribute-h", title: "Distribute Horizontally", icon: "mdi:distribute-horizontal-center", run: (a) => distribute(a, "x", "w") },
    { id: "distribute-v", title: "Distribute Vertically", icon: "mdi:distribute-vertical-center", run: (a) => distribute(a, "y", "h") },
    { id: "toggle-anchors", title: "Toggle Anchor Visibility", icon: "mdi:anchor", run: (a) => (a.anchorsVisible = !a.anchorsVisible) },
    { id: "toggle-snap", title: "Toggle Snapping", icon: "mdi:magnet", run: (a) => a.toggleSnap() },
    { id: "toggle-snap-size", title: "Toggle Snap to Matching Size", icon: "mdi:magnet-on", run: (a) => a.toggleSnapSize() },
    { id: "toggle-minimap", title: "Toggle Minimap", icon: "mdi:map-outline", run: (a) => a.toggleMinimap() },
    { id: "toggle-retina", title: "Toggle Retina Rendering (browser setting)", icon: "mdi:monitor-eye", run: (a) => a.toggleRetina() },
    { id: "new-slide", title: "New Slide", icon: "mdi:plus-box-outline", run: (a) => a.addSlide() },
    { id: "delete-slide", title: "Delete Slide", icon: "mdi:file-remove-outline", when: (a) => a.doc.slides.length > 1, run: (a) => a.deleteSlide() },
    { id: "toggle-slide", title: "Toggle Slide Visibility (enable/disable delta)", icon: "mdi:eye-check-outline", run: (a) => a.toggleSlide() },
    { id: "move-slide-up", title: "Move Slide Up", icon: "mdi:arrow-up", run: (a) => a.moveSlide(-1) },
    { id: "move-slide-down", title: "Move Slide Down", icon: "mdi:arrow-down", run: (a) => a.moveSlide(+1) },
    { id: "next-slide", title: "Next Slide", icon: "mdi:chevron-right", run: (a) => (a.slideIndex = Math.min(a.slideIndex + 1, a.doc.slides.length - 1)) },
    { id: "prev-slide", title: "Previous Slide", icon: "mdi:chevron-left", run: (a) => (a.slideIndex = Math.max(a.slideIndex - 1, 0)) },
    { id: "present", title: "Present (fullscreen)", icon: "mdi:play", run: (a) => (a.mode = "present") },
    { id: "save-file", title: "Save Presentation", icon: "mdi:content-save-outline", run: (a) => a.saveFile() },
    { id: "load-file", title: "Load Presentation", icon: "mdi:folder-open-outline", run: (a) => a.loadFile() },
    { id: "undo", title: "Undo", icon: "mdi:undo", run: (a) => a.undo() },
    { id: "redo", title: "Redo", icon: "mdi:redo", run: (a) => a.redo() },
    { id: "deselect", title: "Deselect", icon: "mdi:select-off", when: needsSelection, run: (a) => (a.selection = null) },
    { id: "toggle-palette", title: "Toggle Command Palette", icon: "mdi:chevron-down-box-outline", run: (a) => (a.paletteOpen = !a.paletteOpen) },
    { id: "reset-view", title: "Zoom to Fit Slide", icon: "mdi:fit-to-screen-outline", run: (a) => a.canvasActions?.zoomToFit({ x: 0, y: 0, w: a.doc.meta.slideW, h: a.doc.meta.slideH }) },
    {
      id: "color-theme",
      title: "Color Theme",
      icon: "mdi:palette-outline",
      children: THEMES.map((t) => ({
        id: `theme-${t.id}`,
        title: t.title,
        icon: THEME_ICONS[t.id],
        run: (a) => a.setTheme(t.id),
      })),
    },
    { id: "export-png", title: "Export Slide as PNG", icon: "mdi:image-outline", run: (a) => a.exportPng() },
    { id: "copy-item", title: "Copy Item", icon: "mdi:content-copy", when: needsSelection, run: (a) => a.copySelection() },
    { id: "paste", title: "Paste", icon: "mdi:content-paste", run: (a) => a.pasteClipboard() },
    {
      id: "copy-property",
      title: "Copy Property",
      when: needsSelection,
      children: [...new Map(
        app.registry.all().flatMap((p) => (p.inspector ?? []).map((row) => [row.key, row.label])),
      )].map(([key, label]) => ({
        id: `copy-prop-${key}`,
        title: `Copy ${label}`,
        icon: "mdi:content-copy",
        when: (a) => a.selectedNode() && key in a.selectedNode().state,
        run: (a) => a.copyProperty(key),
      })),
    },
  ];
  for (const c of coreCommands) app.commands.add(c);

  /** Distributes all active bbox items on the current slide with equal center spacing. */
  function distribute(a, axis, sizeKey) {
    const nodes = a.nodes().filter((n) => n.plugin.capabilities.bbox);
    if (nodes.length < 3) return;
    const centers = nodes
      .map((n) => ({ n, c: (n.state[axis] ?? 0) + (n.state[sizeKey] ?? 0) / 2 }))
      .sort((p, q) => p.c - q.c);
    const first = centers[0].c, last = centers[centers.length - 1].c;
    let doc = a.doc;
    centers.forEach(({ n, c }, i) => {
      const target = first + ((last - first) * i) / (centers.length - 1);
      if (target === c) return;
      const value = (n.state[axis] ?? 0) + (target - c);
      doc = keyframed(doc, a.slideIndex, ["items", n.itemId, axis], value);
    });
    a.commit(doc);
  }

  // ── Shortcuts (single registry → dispatch AND HintBar) ────────────────────
  const editMode = (c) => c.mode === "edit" && !c.paletteOpen;
  // EVERYTHING routes through the command registry (user invariant): shortcut
  // entries reference command ids, which is what lets the palette display each
  // command's keys automatically.
  const entries = [
    { keys: ["Cmd", "Shift", "P"], label: "Palette", when: (c) => c.mode === "edit", command: "toggle-palette" },
    { keys: ["Ctrl", "Z"], label: "Undo", when: editMode, command: "undo" },
    { keys: ["Ctrl", "Shift", "Z"], label: "Redo", when: editMode, command: "redo" },
    { keys: ["Backspace"], label: "Delete", when: (c) => editMode(c) && c.hasSelection, command: "delete-item" },
    { keys: ["Delete"], label: "Delete", hidden: true, when: (c) => editMode(c) && c.hasSelection, command: "delete-item" },
    { keys: ["Ctrl", "C"], label: "Copy", when: (c) => editMode(c) && c.hasSelection, command: "copy-item" },
    { keys: ["Ctrl", "V"], label: "Paste", hidden: true, when: editMode, command: "paste" },
    { keys: ["Cmd", "Shift", "F"], label: "To front", when: (c) => editMode(c) && c.hasSelection, command: "put-on-top" },
    { keys: ["Cmd", "Shift", "B"], label: "To back", when: (c) => editMode(c) && c.hasSelection, command: "put-on-bottom" },
    { keys: ["Left"], label: "Prev slide", when: editMode, command: "prev-slide" },
    { keys: ["Right"], label: "Next slide", when: editMode, command: "next-slide" },
    { keys: ["Escape"], label: "Deselect", when: (c) => editMode(c) && c.hasSelection, command: "deselect" },
    // Display-only hints (pointer gestures handled by CanvasView/PanZoom):
    { keys: ["mouse_left"], label: "Select / drag", when: (c) => editMode(c) && !c.dragging },
    { keys: ["Shift"], label: "Axis lock", when: (c) => editMode(c) && c.dragging },
    { keys: ["mouse_scroll"], label: "Pan", when: editMode },
    { keys: ["Ctrl", "mouse_scroll"], label: "Zoom", when: editMode },
    { keys: ["Left", "Right"], label: "Step slides", when: (c) => c.mode === "present" },
    { keys: ["Esc"], label: "Exit", when: (c) => c.mode === "present" },
  ];
  for (const e of entries) app.shortcuts.add(e);

  function shortcutCtx() {
    return {
      mode: app.mode,
      paletteOpen: app.paletteOpen,
      hasSelection: app.selection !== null,
      dragging: app.dragging,
      app,
    };
  }

  let hints = $derived.by(() => {
    app.mode; app.paletteOpen; app.selection; app.dragging;
    return app.shortcuts.hints(shortcutCtx());
  });

  function onKeydown(e) {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
    if (app.mode === "present") return; // PresentMode owns its keys
    if (app.paletteOpen) return; // palette owns its keys
    if (app.shortcuts.dispatch(e, shortcutCtx())) e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <Toolbar {app} />
  <div class="main">
    <SplitPane orientation="horizontal" bind:splits={hSplits}>
      {#snippet children(col)}
        <!-- Region names from the manifest glossary, revealed on mouse-over
                          RATIFICATION). The Canvas is exempt — it's an interaction surface. -->
        {#if col === 0}
          <Tooltip text="Slide Navigator" delay={500}>
            <SlideNav {app} />
          </Tooltip>
        {:else if col === 1}
          <CanvasView {app} />
        {:else}
          <div class="right-col">
            <SplitPane orientation="vertical" bind:splits={rightSplits}>
              {#snippet children(row)}
                {#if row === 0}
                  <Tooltip text="Property Panel" delay={500}>
                    <Inspector {app} />
                  </Tooltip>
                {:else}
                  <Tooltip text="Keyframe Panel" delay={500}>
                    <KeyframePanel {app} />
                  </Tooltip>
                {/if}
              {/snippet}
            </SplitPane>
          </div>
        {/if}
      {/snippet}
    </SplitPane>
  </div>
  <HintBar {hints} />
  <CommandPalette {app} />
  {#if app.mode === "present"}
    <PresentMode {app} />
  {/if}
</div>
