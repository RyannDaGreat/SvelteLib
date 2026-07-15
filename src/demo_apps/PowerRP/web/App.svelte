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
  import Toolbar from "./Toolbar.svelte";
  import SlideNav from "./SlideNav.svelte";
  import AssetExplorer from "./AssetExplorer.svelte";
  import CanvasView from "./CanvasView.svelte";
  import Inspector from "./Inspector.svelte";
  import KeyframePanel from "./KeyframePanel.svelte";
  import VariablesPanel from "./VariablesPanel.svelte";
  import FpsCounter from "./FpsCounter.svelte";
  import CommandPalette from "./CommandPalette.svelte";
  import PresentMode from "./PresentMode.svelte";
  import Panel from "./Panel.svelte";
  import Modal from "../../../lib/Modal.svelte";
  import { PowerRPApp, THEMES } from "./app.svelte.js";
  import { keyframed, foldState } from "../core/document.js";
  import { cameraRect } from "../core/derive.js";
  import { evaluateState } from "../core/expressions.js";
  import { createKeybindings } from "../core/keybindings.js";
  import { createShortcuts } from "../core/shortcuts.js";

  const app = new PowerRPApp();

  // Open Project… modal (manifest Round 12: Open brings up a modal listing
  // previously saved server projects). Wires the app's showOpenModal hook to
  // the SvelteLib Modal; the list loads fresh on every open (the server's
  // projects folder is the source of truth). Errors surface in the list area.
  let openModalVisible = $state(false);
  let openProjects = $state(null); // null = loading; [] = none; strings = names
  let openError = $state(null);
  app.showOpenModal = async () => {
    openModalVisible = true;
    openProjects = null;
    openError = null;
    try {
      openProjects = await app.listProjects();
    } catch (e) {
      openError = String(e.message ?? e);
      console.error("Open Project: could not list server projects:", e);
    }
  };
  async function pickProject(name) {
    openModalVisible = false;
    await app.loadProject(name);
  }
  app.loadAutosave();
  app.loadTheme();
  window.__powerrp_app = app; // dev/test hook (headless smoke tests introspect via this)

  // SplitPane splits are BOUNDARY positions: [0.16, 0.78] → 3 panes.
  let hSplits = $state([0.16, 0.78]);
  // Left column: Slide Navigator (top) / Asset Explorer (bottom) — one split.
  let leftSplits = $state([0.62]);
  // Right column: Property Panel / Variables Panel / Keyframe Panel.
  let rightSplits = $state([0.45, 0.7]);

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
    // The inverse of delete-item — registry-routed per the cruft audit (un-hide
    // previously had NO command surfacing, so it could never get a shortcut).
    { id: "show-item", title: "Show (activate on this slide)", icon: "mdi:eye-outline", when: needsSelection, run: (a) => a.showSelection() },
    { id: "bring-forward", title: "Bring Forward", icon: "mdi:arrange-bring-forward", when: needsSelection, run: (a) => a.reorderSelection(+1) },
    { id: "send-backward", title: "Send Backward", icon: "mdi:arrange-send-backward", when: needsSelection, run: (a) => a.reorderSelection(-1) },
    { id: "put-on-top", title: "Put on Top", icon: "mdi:arrange-bring-to-front", when: needsSelection, run: (a) => a.sendToExtreme(+1) },
    { id: "put-on-bottom", title: "Put on Bottom", icon: "mdi:arrange-send-to-back", when: needsSelection, run: (a) => a.sendToExtreme(-1) },
    { id: "distribute-h", title: "Distribute Horizontally", icon: "mdi:distribute-horizontal-center", when: (a) => a.selectedIds().length >= 3, run: (a) => distribute(a, "x", "w") },
    { id: "distribute-v", title: "Distribute Vertically", icon: "mdi:distribute-vertical-center", when: (a) => a.selectedIds().length >= 3, run: (a) => distribute(a, "y", "h") },
    { id: "toggle-anchors", title: "Toggle Anchor Visibility", icon: "mdi:anchor", run: (a) => (a.anchorsVisible = !a.anchorsVisible) },
    { id: "toggle-snap", title: "Toggle Snapping", icon: "mdi:magnet", run: (a) => a.toggleSnap() },
    { id: "toggle-snap-size", title: "Toggle Snap to Matching Size", icon: "mdi:magnet-on", run: (a) => a.toggleSnapSize() },
    { id: "toggle-minimap", title: "Toggle Minimap", icon: "mdi:map-outline", run: (a) => a.toggleMinimap() },
    { id: "toggle-fps", title: "Toggle FPS Counter", icon: "mdi:speedometer", run: (a) => a.toggleFps() },
    { id: "toggle-grid", title: "Toggle Grid", icon: "mdi:grid", run: (a) => a.toggleGrid() },
    { id: "toggle-ruler", title: "Toggle Ruler", icon: "mdi:ruler", run: (a) => a.toggleRuler() },
    { id: "toggle-panel-names", title: "Toggle Panel Names", icon: "mdi:format-title", run: (a) => a.togglePanelNames() },
    { id: "toggle-retina", title: "Toggle Retina Rendering (browser setting)", icon: "mdi:monitor-eye", run: (a) => a.toggleRetina() },
    { id: "new-slide", title: "New Slide", icon: "mdi:plus-box-outline", run: (a) => a.addSlide() },
    { id: "new-blank-slide", title: "New Fresh Slide (hide everything)", icon: "mdi:plus-box", run: (a) => a.addBlankSlide() },
    { id: "delete-slide", title: "Delete Slide", icon: "mdi:file-remove-outline", when: (a) => a.doc.slides.length > 1, run: (a) => a.deleteSlide() },
    { id: "toggle-slide", title: "Toggle Slide Visibility (enable/disable delta)", icon: "mdi:eye-check-outline", run: (a) => a.toggleSlide() },
    { id: "move-slide-up", title: "Move Slide Up", icon: "mdi:arrow-up", run: (a) => a.moveSlide(-1) },
    { id: "move-slide-down", title: "Move Slide Down", icon: "mdi:arrow-down", run: (a) => a.moveSlide(+1) },
    { id: "next-slide", title: "Next Slide", icon: "mdi:chevron-right", run: (a) => (a.slideIndex = Math.min(a.slideIndex + 1, a.doc.slides.length - 1)) },
    { id: "prev-slide", title: "Previous Slide", icon: "mdi:chevron-left", run: (a) => (a.slideIndex = Math.max(a.slideIndex - 1, 0)) },
    { id: "present", title: "Present (fullscreen)", icon: "mdi:play", run: (a) => (a.mode = "present") },
    { id: "save-file", title: "Save Presentation", icon: "mdi:content-save-outline", run: (a) => a.saveFile() },
    { id: "load-file", title: "Load Presentation", icon: "mdi:folder-open-outline", run: (a) => a.loadFile() },
    { id: "clear-doc", title: "Clear Document (new)", icon: "mdi:broom", run: (a) => a.clearDoc() },
    // Project server (manifest Round 12: projects are FOLDERS on the server;
    // Download = a .zip of the folder). Save/Download need no UI; Open opens a
    // project-picker modal — that UI lands in parallel (Sonnet1's Modal lib
    // component), so open-project delegates to app.openProject()'s modal hook.
    { id: "save-to-server", title: "Save to Server (as project)", icon: "mdi:cloud-upload-outline", run: (a) => a.saveToServer() },
    { id: "open-project", title: "Open Project…", icon: "mdi:folder-network-outline", run: (a) => a.openProject() },
    { id: "download-zip", title: "Download Project (.zip)", icon: "mdi:folder-zip-outline", run: (a) => a.downloadZip() },
    { id: "undo", title: "Undo", icon: "mdi:undo", run: (a) => a.undo() },
    { id: "redo", title: "Redo", icon: "mdi:redo", run: (a) => a.redo() },
    { id: "deselect", title: "Deselect", icon: "mdi:select-off", when: needsSelection, run: (a) => (a.selection = null) },
    // Rubber-band selection — armed via the palette (initiation is command-only
    // for now, manifest round 11). Each command arms a ONE-SHOT band drag on the
    // canvas; the CanvasView performs the drag and applies selectInBox in the
    // armed mode. INNER = fully enclosed; OUTER = touching counts; "Regular" uses
    // the default bandMode browser setting (drilldown submenu below).
    { id: "band-select-inner", title: "Select in Box (Inner — fully enclosed)", icon: "mdi:select-all", run: (a) => a.armBandSelect("inner") },
    { id: "band-select-outer", title: "Select in Box (Outer — touching)", icon: "mdi:selection-ellipse", run: (a) => a.armBandSelect("outer") },
    { id: "band-select-regular", title: "Select in Box (Regular — default mode)", icon: "mdi:selection-drag", run: (a) => a.armBandSelect("regular") },
    {
      id: "band-mode",
      title: "Default Band Select Mode",
      icon: "mdi:selection-drag",
      children: [
        { id: "band-mode-inner", title: "Inner (fully enclosed)", icon: "mdi:select-all", run: (a) => a.setBandMode("inner") },
        { id: "band-mode-outer", title: "Outer (touching)", icon: "mdi:selection-ellipse", run: (a) => a.setBandMode("outer") },
      ],
    },
    { id: "toggle-palette", title: "Toggle Command Palette", icon: "mdi:chevron-down-box-outline", run: (a) => (a.paletteOpen = !a.paletteOpen) },
    // Evaluated state: the camera's own properties may be equations.
    { id: "reset-view", title: "Zoom to Fit Camera", icon: "mdi:fit-to-screen-outline", run: (a) => a.canvasActions?.zoomToFit(cameraRect(evaluateState(foldState(a.doc, a.slideIndex, 1), a.registry).state, a.doc.meta)) },
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
    { id: "export-pdf", title: "Export Slide as PDF", icon: "mdi:file-pdf-box", run: (a) => a.exportPdf() },
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
  // Restore MRU only AFTER every command (plugins from the constructor + the
  // core commands above) is registered — loadUsage drops ids the registry
  // doesn't yet know, so calling it earlier would silently lose core commands.
  app.loadMru();

  /** Distributes all active bbox items on the current slide with equal center spacing. */
  function distribute(a, axis, sizeKey) {
    // Distributes the SELECTION (user, round 12B follow-up: the V1 version
    // distributed EVERY item on the slide — with a selection it ignored you,
    // which read as a no-op). Centers evenly spaced across the selection's
    // span; the first and last centers stay put (the user's stated spec).
    const ids = new Set(a.selectedIds());
    const nodes = a.nodes().filter((n) => ids.has(n.itemId) && n.plugin.capabilities.bbox);
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

  // ── Shortcuts: keybinding registry → shortcut registry (dispatch + HintBar)
  // Command-bound key combos live in core/keybindings.js (an EDITOR setting:
  // defaults in code, user overrides persisted in localStorage). The bridge
  // (toShortcutEntries) turns them into shortcut-registry entries, so
  // EVERYTHING still routes through the command registry (user invariant) and
  // the palette still displays each command's keys automatically.
  const KEYBINDINGS_KEY = "powerrp.keybindings";
  // A live modal transform (G/S) LOCKS INPUT like Blender: while it runs, normal
  // command shortcuts (palette, undo, delete, deselect, slide nav, …) are
  // suppressed so keys only reach the modal's own confirm/cancel entries below.
  // Every edit-context resolver therefore also requires !modalActive.
  const editAny = (c) => c.mode === "edit" && !c.modalActive;
  const editMode = (c) => c.mode === "edit" && !c.paletteOpen && !c.modalActive;
  const editSelection = (c) => editMode(c) && c.hasSelection;
  const kb = createKeybindings([
    { command: "toggle-palette", keys: ["Cmd", "Shift", "P"], when: "editAny" },
    { command: "undo", keys: ["Ctrl", "Z"], when: "editMode" },
    { command: "redo", keys: ["Ctrl", "Shift", "Z"], when: "editMode" },
    { command: "delete-item", keys: ["Backspace"], when: "editSelection" },
    { command: "copy-item", keys: ["Ctrl", "C"], when: "editSelection" },
    { command: "paste", keys: ["Ctrl", "V"], when: "editMode" },
    { command: "put-on-top", keys: ["Cmd", "Shift", "F"], when: "editSelection" },
    { command: "put-on-bottom", keys: ["Cmd", "Shift", "B"], when: "editSelection" },
    { command: "prev-slide", keys: ["Left"], when: "editMode" },
    { command: "next-slide", keys: ["Right"], when: "editMode" },
    { command: "deselect", keys: ["Escape"], when: "editSelection" },
  ]);
  const storedOverrides = localStorage.getItem(KEYBINDINGS_KEY);
  if (storedOverrides) kb.loadOverrides(JSON.parse(storedOverrides));
  const KEYBINDING_LABELS = {
    "toggle-palette": "Palette", undo: "Undo", redo: "Redo",
    "delete-item": "Delete", "copy-item": "Copy", paste: "Paste",
    "put-on-top": "To front", "put-on-bottom": "To back",
    "prev-slide": "Prev slide", "next-slide": "Next slide", deselect: "Deselect",
  };
  const WHEN_RESOLVERS = { editAny, editMode, editSelection };
  // Hidden key aliases + display-only pointer hints stay hand-registered
  // (core/keybindings.js scope: ONE binding per command; gestures aren't keys).
  const handEntries = [
    { keys: ["Delete"], label: "Delete", hidden: true, when: editSelection, command: "delete-item" },
    { keys: ["mouse_left"], label: "Select / drag", when: (c) => editMode(c) && !c.dragging && !c.bandArmed },
    // Shift-click ADDS/REMOVES from the multi-selection (manifest "Shift-click
    // multi-select"). Display-only, same registry pathway as the other pointer
    // hints — the pick code reads the modifier itself. Alongside "Select / drag"
    // while idle over the canvas; hidden mid-drag (shift then means axis-lock,
    // whose own hint fires) and while a band select is armed.
    { keys: ["Shift", "mouse_left"], label: "Add to selection", when: (c) => editMode(c) && !c.dragging && !c.bandArmed },
    // A palette-armed band select replaces the plain pointer hint until the
    // one-shot drag happens (band-select initiation is palette-only for now).
    { keys: ["mouse_left"], label: "Drag box to select", when: (c) => editMode(c) && !c.dragging && c.bandArmed },
    // Modifier hints auto-announce PER DRAG KIND (manifest "Drag/resize
    // modifiers": the axis-auto-lock hint pattern, extended) — same registry,
    // never a second pathway. Display-only: the pointer code reads the
    // modifier keys itself. Endpoint drags have no modifiers → no hints.
    { keys: ["Shift"], label: "Axis lock", when: (c) => editMode(c) && c.dragKind === "move" },
    { keys: ["Shift"], label: "Uniform scale", when: (c) => editMode(c) && c.dragKind === "resize" },
    { keys: ["Cmd"], label: "Symmetric resize", when: (c) => editMode(c) && c.dragKind === "resize" },
    // Blender-style MODAL transforms (manifest Round 12): G grabs the selection
    // (it follows the mouse with no button held), S scales it about its
    // collective center. Available with a selection in edit mode (editSelection
    // already excludes an active modal, so G/S don't re-enter). These START the
    // modal via the app; CanvasView captures the geometry and drives the preview.
    // No axis-constraint keys yet (X/Y) — flagged as a follow-up.
    { keys: ["G"], label: "Grab", when: editSelection, run: () => app.beginModalTransform("grab") },
    { keys: ["S"], label: "Scale", when: editSelection, run: () => app.beginModalTransform("scale") },
    // While a modal transform is live, ONLY its own confirm/cancel inputs are
    // active (every edit-context resolver excludes modalActive). Enter or a left
    // click CONFIRMS (one undo unit); Escape CANCELS (reverts the preview). The
    // click is display-only here — CanvasView's pointer handler commits it.
    { keys: ["Enter"], label: "Confirm", when: (c) => c.modalActive, run: () => app.modalCommit() },
    { keys: ["mouse_left"], label: "Confirm", when: (c) => c.modalActive },
    { keys: ["Escape"], label: "Cancel", when: (c) => c.modalActive, run: () => app.modalCancel() },
    { keys: ["mouse_scroll"], label: "Pan", when: editMode },
    { keys: ["Ctrl", "mouse_scroll"], label: "Zoom", when: editMode },
    { keys: ["Left", "Right"], label: "Step slides", when: (c) => c.mode === "present" },
    { keys: ["Esc"], label: "Exit", when: (c) => c.mode === "present" },
  ];
  /** Command. (Re)builds the shortcut registry from the keybinding registry +
   * hand entries — also how a rebind takes effect (createShortcuts has no
   * remove; rebuilding is the documented pattern). */
  function wireShortcuts() {
    const shortcuts = createShortcuts();
    for (const e of kb.toShortcutEntries(KEYBINDING_LABELS, WHEN_RESOLVERS))
      // Ctrl+V dispatches but is kept out of the HintBar (pre-existing
      // choice: paste is discoverable via the palette; the bar stays lean).
      shortcuts.add(e.command === "paste" ? { ...e, hidden: true } : e);
    for (const e of handEntries) shortcuts.add(e);
    app.shortcuts = shortcuts;
  }
  wireShortcuts();
  app.keybindings = kb; // future keybinding-editing UI reaches it here
  /** Command. Rebinds a command, persists overrides, rewires dispatch/HintBar.
   * Returns the conflicting command id (see keybindings.bind) or null. */
  app.rebindCommand = (command, keys, opts) => {
    const conflict = kb.bind(command, keys, opts);
    localStorage.setItem(KEYBINDINGS_KEY, JSON.stringify(kb.serializeOverrides()));
    wireShortcuts();
    return conflict;
  };

  function shortcutCtx() {
    return {
      mode: app.mode,
      paletteOpen: app.paletteOpen,
      hasSelection: app.selection !== null,
      dragging: app.dragging,
      dragKind: app.dragKind,
      bandArmed: app.bandArm !== null,
      modalActive: app.modalXform !== null, // a live G/S transform locks input (Blender modal)
      app,
    };
  }

  let hints = $derived.by(() => {
    app.mode; app.paletteOpen; app.selection; app.dragging; app.dragKind; app.bandArm; app.modalXform;
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
        <!-- Panels OPTIONALLY show their canonical name (manifest glossary) as
             a title bar at the top; toggled via the "Toggle Panel Names"
             palette command (OFF by default). The Canvas is exempt — it's an
             interaction surface, not a first-class named panel. -->
        {#if col === 0}
          <!-- Left column stacks the Slide Navigator over the Asset Explorer
               (manifest Round 12: "a pane BELOW the Slide Navigator"). Same
               boundary-split pattern as the right column. -->
          <div class="left-col">
            <SplitPane orientation="vertical" bind:splits={leftSplits}>
              {#snippet children(row)}
                {#if row === 0}
                  <Panel {app} name="Slide Navigator">
                    <SlideNav {app} />
                  </Panel>
                {:else}
                  <Panel {app} name="Asset Explorer">
                    <AssetExplorer {app} />
                  </Panel>
                {/if}
              {/snippet}
            </SplitPane>
          </div>
        {:else if col === 1}
          <CanvasView {app} />
        {:else}
          <div class="right-col">
            <SplitPane orientation="vertical" bind:splits={rightSplits}>
              {#snippet children(row)}
                {#if row === 0}
                  <Panel {app} name="Property Panel">
                    <Inspector {app} />
                  </Panel>
                {:else if row === 1}
                  <Panel {app} name="Variables Panel">
                    <VariablesPanel {app} />
                  </Panel>
                {:else}
                  <Panel {app} name="Keyframe Panel">
                    <KeyframePanel {app} />
                  </Panel>
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
  {#if app.fpsVisible}
    <FpsCounter {app} />
  {/if}
  <Modal bind:open={openModalVisible} title="Open Project">
    {#if openError}
      <div class="open-project-error">{openError}</div>
    {:else if openProjects === null}
      <div class="open-project-empty">Loading projects…</div>
    {:else if openProjects.length === 0}
      <div class="open-project-empty">No projects saved on the server yet — use "Save to Server" first.</div>
    {:else}
      <ul class="open-project-list">
        {#each openProjects as p}
          <li>
            <button type="button" class="btn open-project-row" onclick={() => pickProject(p.name)}>
              <span>{p.name}</span>
              <span class="open-project-meta">{p.slideCount} slides</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </Modal>
</div>
