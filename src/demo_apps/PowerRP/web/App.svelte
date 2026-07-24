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
  import BuiltinAssetBrowser from "./BuiltinAssetBrowser.svelte";
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
  import { keyframed } from "../core/document.js";
  import { cameraRectAt } from "./cameraFrame.js";
  import { createKeybindings } from "../core/keybindings.js";
  import { createShortcuts } from "../core/shortcuts.js";
  import { unionRect, alignedPosition, mirroredPosition } from "../core/geometry.js";
  import { FAMILIES } from "../plugins/shapeshifter.js";
  import { subpathsPathD } from "../core/shapes.js";

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

  // Save-to-Server modal (bug: "Save to server" gave no way to CHOOSE a name and
  // silently overwrote). Choose/confirm a name (default = the current meta.name)
  // with CONFLICT protection: if a project of that name already exists on the
  // server — the SAME list the Open modal renders — the primary action becomes a
  // loud "Overwrite" (destructive-action-confirm; never a silent clobber). On
  // confirm the name is applied (renameProject → the title updates too) then
  // pushed (saveToServer), so title / open / save all agree on one name.
  let saveModalVisible = $state(false);
  let saveName = $state("");
  let saveProjectNames = $state([]); // existing project names, for the conflict check
  let saveBusy = $state(false);
  let saveError = $state(null);
  app.showSaveModal = async () => {
    saveName = app.projectName();
    saveError = null;
    saveBusy = false;
    saveProjectNames = [];
    saveModalVisible = true;
    try {
      saveProjectNames = (await app.listProjects()).map((p) => p.name);
    } catch (e) {
      // Non-fatal: without the list we can't warn, but the user can still save.
      console.error("Save to Server: could not list existing projects (conflict check skipped):", e);
    }
  };
  const saveTrimmed = $derived(saveName.trim());
  const saveNameExists = $derived(saveProjectNames.includes(saveTrimmed));
  const saveIsCurrent = $derived(saveTrimmed === app.projectName()); // re-saving the open project is expected, not a clobber
  const saveWouldClobber = $derived(saveNameExists && !saveIsCurrent);
  async function confirmSave() {
    const name = saveTrimmed;
    if (!name || saveBusy) return;
    saveBusy = true;
    saveError = null;
    try {
      app.renameProject(name); // one name model — applies to the title before the push
      await app.saveToServer(name);
      saveModalVisible = false;
    } catch (e) {
      saveError = String(e.message ?? e);
      console.error("Save to Server failed:", e);
    } finally {
      saveBusy = false;
    }
  }

  // Rename modal (bug: double-clicking the top-left title did nothing). A pure
  // LOCAL edit — writes doc.meta.name via app.renameProject (undoable), no server
  // round-trip, no conflict check (that is a Save concern). Opened by the toolbar
  // title's double-click and the "Rename Presentation" command.
  let renameModalVisible = $state(false);
  let renameName = $state("");
  app.showRenameModal = () => {
    renameName = app.projectName();
    renameModalVisible = true;
  };
  function confirmRename() {
    app.renameProject(renameName);
    renameModalVisible = false;
  }

  // Built-in Assets… modal (task #68 follow-up): a SEPARATE, discovery-only
  // browser for ship-with-the-app assets (cursors today), distinct from the
  // project Asset Explorer. Wires app.browseBuiltinAssets()'s hook to the Modal;
  // the catalog is web/builtinAssets.js (loaded lazily by the browser on open).
  let builtinAssetsVisible = $state(false);
  app.showBuiltinAssets = () => {
    builtinAssetsVisible = true;
  };
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
  // Align/mirror (manifest 16.3) need ≥2 selected BBOX items — a single item
  // has no OTHER extreme/center to align or mirror against (single-item
  // align-to-canvas is a plausible future fallback, deliberately NOT built
  // here per the task's "your call, flag it": no precedent command reads
  // the camera as an alignment target yet, and inventing one would be an
  // arbitrary scope decision the manifest's "no arbitrary constraints" rule
  // says to run by the user first — so a lone selection simply disables
  // these, same as distribute disables below 3).
  const needsMultiBbox = (a) => a.nodes().filter((n) => new Set(a.selectedIds()).has(n.itemId) && n.plugin.capabilities.bbox).length >= 2;
  // Per-theme palette icons (mdi), keyed by THEMES[].id. No colors (user spec).
  const THEME_ICONS = {
    graphite: "mdi:brightness-6",
    light: "mdi:weather-sunny",
    black: "mdi:weather-night",
    warm: "mdi:palette-swatch-outline",
    // 14.11 additions:
    sepia: "mdi:file-document-outline",
    slate: "mdi:contrast-box",
    nord: "mdi:snowflake",
    gruvbox: "mdi:coffee-outline",
    aurora: "mdi:creation",
    // Colorful set:
    dracula: "mdi:bat",
    tokyonight: "mdi:city-variant-outline",
    catppuccin: "mdi:cat",
    rosepine: "mdi:flower-outline",
    monokai: "mdi:code-tags",
    synthwave: "mdi:sine-wave",
  };
  // Local box the `insert-shape` family tile previews are generated in; matches
  // ShapePicker's 100-unit tile viewBox content area (`-6 -6 112 112`).
  const SHAPE_PREVIEW_DIM = 100;
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
    // OBJECT ALIGN (manifest 16.3, distinct from 15.6's text-paragraph align):
    // moves every selected bbox widget so its edge/center matches the
    // SELECTION's own collective edge/center — same needsMultiBbox gate as
    // distribute (≥2 items: aligning a single item to itself is a no-op, so
    // unlike distribute's ≥3 this only needs ≥2 to be meaningful).
    { id: "align-left", title: "Align Left", icon: "mdi:align-horizontal-left", when: needsMultiBbox, run: (a) => align(a, "x", "min") },
    { id: "align-right", title: "Align Right", icon: "mdi:align-horizontal-right", when: needsMultiBbox, run: (a) => align(a, "x", "max") },
    { id: "align-top", title: "Align Top", icon: "mdi:align-vertical-top", when: needsMultiBbox, run: (a) => align(a, "y", "min") },
    { id: "align-bottom", title: "Align Bottom", icon: "mdi:align-vertical-bottom", when: needsMultiBbox, run: (a) => align(a, "y", "max") },
    { id: "align-center-h", title: "Align Center Horizontal", icon: "mdi:align-horizontal-center", when: needsMultiBbox, run: (a) => align(a, "x", "center") },
    { id: "align-center-v", title: "Align Center Vertical", icon: "mdi:align-vertical-center", when: needsMultiBbox, run: (a) => align(a, "y", "center") },
    // MIRROR (manifest 16.3): LAYOUT-ONLY mirror — reflects each selected
    // item's POSITION about the selection's own center axis; items swap
    // sides but their own content is NOT flipped. DESIGN FORK (recorded per
    // the task): PowerRP's transform is a similarity {x,y,rotation,scale}
    // with a SINGLE scalar scale — no per-axis/negative scale, so a true
    // per-item content flip isn't representable without extending the
    // model (a flipX/flipY boolean the renderer would need to honor, across
    // both render backends). Titled "Mirror Layout" (not plain "Mirror") so
    // it is never mistaken for a content flip. See core/geometry.js
    // mirroredPosition's docstring for the full math + rationale.
    { id: "mirror-h", title: "Mirror Layout Horizontal", icon: "mdi:flip-horizontal", when: needsMultiBbox, run: (a) => mirror(a, "x") },
    { id: "mirror-v", title: "Mirror Layout Vertical", icon: "mdi:flip-vertical", when: needsMultiBbox, run: (a) => mirror(a, "y") },
    // FLAGGED — PENDING USER RATIFICATION: no keybindings assigned to any of
    // the 8 align/mirror commands above. Followed the exact precedent of
    // distribute-h/distribute-v (also palette-only, no bound keys) rather
    // than inventing new key combos — the manifest's "no arbitrary
    // constraints invented by Claude" rule requires picking new bindings be
    // run by the user first, not guessed. All 8 are reachable via the
    // command palette today; add to the `kb` array below if/when the user
    // picks combos.
    // GROUPS (manifest rough draft): Group Selection needs ≥2 groupable items;
    // Ungroup is enabled when any selected node is a group. Both operate on the
    // selection through the app helpers (which own the AABB + keyframe baking).
    { id: "group", title: "Group Selection", icon: "mdi:group", when: (a) => a.canGroup(), run: (a) => a.groupSelection() },
    { id: "ungroup", title: "Ungroup", icon: "mdi:ungroup", when: (a) => a.selectedNodes().some((n) => n.type === "group"), run: (a) => a.ungroupSelection() },
    { id: "toggle-anchors", title: "Toggle Anchor Visibility", icon: "mdi:anchor", run: (a) => (a.anchorsVisible = !a.anchorsVisible) },
    { id: "toggle-snap", title: "Toggle Snapping", icon: "mdi:magnet", run: (a) => a.toggleSnap() },
    { id: "toggle-snap-size", title: "Toggle Snap to Matching Size", icon: "mdi:magnet-on", run: (a) => a.toggleSnapSize() },
    { id: "toggle-minimap", title: "Toggle Minimap", icon: "mdi:map-outline", run: (a) => a.toggleMinimap() },
    { id: "toggle-fps", title: "Toggle FPS Counter", icon: "mdi:speedometer", run: (a) => a.toggleFps() },
    { id: "toggle-grid", title: "Toggle Grid", icon: "mdi:grid", run: (a) => a.toggleGrid() },
    { id: "toggle-ruler", title: "Toggle Ruler", icon: "mdi:ruler", run: (a) => a.toggleRuler() },
    { id: "toggle-ghosts", title: "Show Ghosts", icon: "mdi:eye-outline", run: (a) => a.toggleGhosts() },
    { id: "toggle-panel-names", title: "Toggle Panel Names", icon: "mdi:format-title", run: (a) => a.togglePanelNames() },
    { id: "new-slide", title: "New Slide", icon: "mdi:plus-box-outline", run: (a) => a.addSlide() },
    { id: "new-blank-slide", title: "New Fresh Slide (hide everything)", icon: "mdi:plus-box", run: (a) => a.addBlankSlide() },
    { id: "delete-slide", title: "Delete Slide", icon: "mdi:file-remove-outline", when: (a) => a.doc.slides.length > 1, run: (a) => a.deleteSlide() },
    { id: "toggle-slide", title: "Toggle Slide Visibility (enable/disable delta)", icon: "mdi:eye-check-outline", run: (a) => a.toggleSlide() },
    { id: "move-slide-up", title: "Move Slide Up", icon: "mdi:arrow-up", run: (a) => a.moveSlide(-1) },
    { id: "move-slide-down", title: "Move Slide Down", icon: "mdi:arrow-down", run: (a) => a.moveSlide(+1) },
    { id: "next-slide", title: "Next Slide", icon: "mdi:chevron-right", run: (a) => (a.slideIndex = Math.min(a.slideIndex + 1, a.doc.slides.length - 1)) },
    { id: "prev-slide", title: "Previous Slide", icon: "mdi:chevron-left", run: (a) => (a.slideIndex = Math.max(a.slideIndex - 1, 0)) },
    { id: "present", title: "Present (fullscreen)", icon: "mdi:play", run: (a) => a.enterPresentMode() },
    { id: "save-file", title: "Save Presentation", icon: "mdi:content-save-outline", run: (a) => a.saveFile() },
    { id: "load-file", title: "Load Presentation", icon: "mdi:folder-open-outline", run: (a) => a.loadFile() },
    { id: "clear-doc", title: "Clear Document (new)", icon: "mdi:broom", run: (a) => a.clearDoc() },
    // Project server (manifest Round 12: projects are FOLDERS on the server;
    // Download = a .zip of the folder). Save opens a NAME chooser with conflict/
    // overwrite protection (a project of that name already on the server warns
    // before clobbering); Open opens the project-picker modal; Rename edits the
    // title (doc.meta.name) — all three delegate to App.svelte modal hooks and
    // share the one name model.
    { id: "rename-presentation", title: "Rename Presentation…", icon: "mdi:rename-outline", run: (a) => a.renamePresentation() },
    { id: "save-to-server", title: "Save to Server (as project)…", icon: "mdi:cloud-upload-outline", run: (a) => a.saveProjectAs() },
    { id: "open-project", title: "Open Project…", icon: "mdi:folder-network-outline", run: (a) => a.openProject() },
    { id: "download-zip", title: "Download Project (.zip)", icon: "mdi:folder-zip-outline", run: (a) => a.downloadZip() },
    // Built-in Assets browser (task #68 follow-up): a SEPARATE surface for
    // ship-with-the-app assets (cursors today) — never mixed into the project
    // Asset Explorer. Discovery only; widgets read built-ins directly.
    { id: "builtin-assets", title: "Built-in Assets…", icon: "mdi:package-variant-closed", run: (a) => a.browseBuiltinAssets() },
    { id: "undo", title: "Undo", icon: "mdi:undo", run: (a) => a.undo() },
    { id: "redo", title: "Redo", icon: "mdi:redo", run: (a) => a.redo() },
    { id: "deselect", title: "Deselect", icon: "mdi:select-off", when: needsSelection, run: (a) => (a.selection = null) },
    // Select All / Deselect All (manifest Round 12B "Palette / selection
    // commands"): distinct from the single-item "Deselect" above (Escape's
    // existing path — needsSelection, singular semantics unaffected) — these
    // are explicit SET commands, always visible, so they're discoverable via
    // fuzzy search without first knowing something is already selected.
    { id: "select-all", title: "Select All", icon: "mdi:select-all", run: (a) => a.selectAll() },
    { id: "deselect-all", title: "Deselect All", icon: "mdi:select-off", when: needsSelection, run: (a) => a.deselectAll() },
    // Rubber-band selection — armed via the palette (manifest round 11) OR the
    // toolbar button (Round 12B "Box select round 2"; Toolbar.svelte), and
    // (Round 12B) directly via an empty-space drag with NO arming at all
    // (CanvasView.onPointerDown). Each armed command sets the CROSSHAIR
    // (manifest ARCHITECTURE PLAN #5) to the band skin for the NEXT canvas
    // drag; CanvasView performs the drag and applies selectInBox in the armed
    // mode. INNER = fully enclosed; OUTER = touching counts; "Regular" uses
    // the default bandMode browser setting (drilldown submenu below) — same
    // resolution the toolbar button's plain press uses.
    { id: "band-select-inner", title: "Select in Box (Inner — fully enclosed)", icon: "mdi:select-all", run: (a) => a.armCrosshairBand("inner") },
    { id: "band-select-outer", title: "Select in Box (Outer — touching)", icon: "mdi:selection-ellipse", run: (a) => a.armCrosshairBand("outer") },
    { id: "band-select-regular", title: "Select in Box (Regular — default mode)", icon: "mdi:selection-drag", run: (a) => a.armCrosshairBand("regular") },
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
    { id: "reset-view", title: "Zoom to Fit Camera", icon: "mdi:fit-to-screen-outline", run: (a) => a.canvasActions?.zoomToFit(cameraRectAt(a.doc, a.slideIndex, 1, a.registry)) },
    {
      id: "color-theme",
      title: "Color Theme",
      icon: "mdi:palette-outline",
      children: THEMES.map((t) => ({
        id: `theme-${t.id}`,
        title: t.title,
        icon: THEME_ICONS[t.id],
        run: (a) => a.setTheme(t.id),
        // Previewable-command hook (see CommandPalette.svelte): hovering/
        // arrowing this entry applies the theme LIVE; moving off restores the
        // previously-applied theme; selecting commits via `run` (which persists).
        preview: (a) => a.previewTheme(t.id),
      })),
    },
    // ADD NUMBER — a numeric READOUT (plugins/number.js): a plaintext-like box
    // whose value is a NUMBER, formatted (decimals / pad / group) and, above all,
    // equation-bindable (= my_var, = box.w, …). Registered HERE (not via the
    // plugin's own commands) so this is its ONE add-command registration — the
    // shapeshifter/demo precedent — armed via the generic crosshair-placement
    // path, resolving the plugin lazily from the registry at click time.
    { id: "add-number", title: "Add Number", icon: "mdi:numeric", run: (a) => a.armCrosshairPlacement(a.registry.get("number")) },
    // ADD LINE — the simplest arrow-family widget (a straight stroke, no head).
    // Top-level insert command like the arrow's own Add; owned HERE (App.svelte)
    // matching the demo/shapeshifter inserts — one owner, since the command
    // registry throws on a duplicate id. Arms the shared endpoint crosshair.
    { id: "add-line", title: "Add Line", icon: "mdi:minus", run: (a) => a.armCrosshairPlacement(a.registry.get("line")) },
    // INSERT DEMO WIDGET — a submenu (exactly the color-theme `children` pattern
    // above) surfacing the DEMO widgets (plugins/demo/): the showcase widget
    // that proves the custom self.* property mechanism, plus the magnifier (the
    // original "PowerPoint can't do this" demo). Each child arms the GENERIC
    // crosshair placement for its type via the existing insert path — the plugin
    // is resolved lazily from the registry at click time, so registration order
    // is irrelevant. Reachable like every submenu: Cmd+Shift+P → drill in.
    {
      id: "insert-demo-widget",
      title: "Insert Demo Widget",
      icon: "mdi:flask-outline",
      children: [
        { id: "demo-insert-showcase", title: "Demo Showcase (custom self.* prop)", icon: "mdi:flask", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_showcase")) },
        { id: "demo-insert-glass", title: "Liquid Glass (backdrop refraction shader)", icon: "mdi:blur", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_glass")) },
        { id: "demo-insert-crt", title: "CRT (backdrop material shader)", icon: "mdi:television-classic", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_crt")) },
        { id: "demo-insert-magnify", title: "Magnifier (sampler material: circle / square / star lens)", icon: "mdi:magnify-expand", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_magnify")) },
        { id: "demo-insert-raycast-dither", title: "Raycast Dither (animated grain gradient)", icon: "mdi:gradient-vertical", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_raycast_dither")) },
        { id: "demo-insert-text-dissolve", title: "Text Dissolve (tween word → word)", icon: "mdi:transition", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_text_dissolve")) },
        { id: "demo-insert-text-type", title: "Text Typewriter (reveal by alpha)", icon: "mdi:cursor-text", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_text_type")) },
        { id: "demo-insert-text-scramble", title: "Text Scramble (decode by alpha)", icon: "mdi:shuffle-variant", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_text_scramble")) },
        { id: "demo-insert-corkboard", title: "Corkboard (foreground material shader)", icon: "mdi:bulletin-board", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboard")) },
        { id: "demo-insert-corkboard-note", title: "Corkboard Note (lined, holes, ripped, curl)", icon: "mdi:note-outline", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboardNote")) },
        { id: "demo-insert-corkboard-thumbtack", title: "Corkboard Thumbtack (press-in dome)", icon: "mdi:pin", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboardThumbtack")) },
        { id: "demo-insert-corkboard-yarn", title: "Corkboard Yarn (sagging string)", icon: "mdi:vector-line", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboardYarn")) },
        { id: "demo-insert-magnifier", title: "Magnifier", icon: "mdi:magnify", run: (a) => a.armCrosshairPlacement(a.registry.get("magnifier")) },
        { id: "demo-insert-cursor", title: "macOS Cursor (built-in SVG + ephemeral spin)", icon: "mdi:cursor-default-outline", run: (a) => a.armCrosshairPlacement(a.registry.get("cursor")) },
        // A LIVE seven-segment digital clock preset: same clock_digital plugin,
        // but its `time` is pre-bound to the shared `time` identifier (the folded
        // presentation playback clock) so it TICKS during a presentation. The
        // plain "Add Digital Clock" command (palette) drops a static 00:00 the
        // user can set or bind themselves; this preset shows the live use up front.
        { id: "demo-insert-clock-digital", title: "Digital Clock (seven-segment, live = time)", icon: "mdi:clock-digital", run: (a) => { const p = a.registry.get("clock_digital"); a.armCrosshairPlacement({ ...p, defaults: { ...p.defaults, time: "=time" } }); } },
        // Analog clock preset whose TIME is bound to the presentation clock var
        // (`= time`, seconds) — a LIVE clock that ticks in Present mode.
        { id: "demo-insert-clock-live", title: "Analog Clock (live — time = presentation clock)", icon: "mdi:clock-time-four-outline", run: (a) => a.armCrosshairPlacement({ ...a.registry.get("clock_analog"), defaults: { ...a.registry.get("clock_analog").defaults, time: "= time" } }) },
      ],
    },
    // INSERT SHAPE — ONE submenu collecting the arbitrary parametric
    // shapeshifter families (star, gear, callout, banner, …); everyday
    // primitives (rect/circle/text/arrow) stay top-level. FAMILIES is the single
    // source of truth: these children feed BOTH the palette drill-down AND the
    // toolbar ShapePicker grid (which reads this command's children). Each child
    // arms generic crosshair placement for its family plugin (resolved lazily).
    // `shapePreview` is opaque tile metadata (registry ignores it; only
    // ShapePicker consumes it). Removing the per-family plugin.commands makes
    // these children the ONLY registration of each add-ss_* id.
    {
      id: "insert-shape",
      title: "Insert Shape",
      icon: "mdi:shape-plus",
      children: FAMILIES.map((fam) => ({
        id: `add-${fam.type}`,
        title: `Add ${fam.title}`,
        icon: fam.icon,
        shapePreview: {
          d: subpathsPathD(fam.outline({ ...fam.defaults, w: SHAPE_PREVIEW_DIM, h: SHAPE_PREVIEW_DIM })),
          fillRule: fam.fillRule ?? "nonzero",
        },
        run: (a) => a.armCrosshairPlacement(a.registry.get(fam.type)),
      })),
    },
    // BENTO GRID — a layout scaffold whose value is its rich anchor set (cell
    // centers/corners/edge-mids + grid-line intersections) that other widgets
    // snap to or reference in `=` equations. Registered ONCE here (its Add menu
    // entry; the plugin declares no `commands` to avoid a duplicate id); arms
    // the generic crosshair placement like every other insert command.
    { id: "add-bento", title: "Add Bento Grid (layout scaffold)", icon: "mdi:view-grid-outline", run: (a) => a.armCrosshairPlacement(a.registry.get("bento")) },
    { id: "export-png", title: "Export Slide as PNG", icon: "mdi:image-outline", run: (a) => a.exportPng() },
    { id: "export-pdf", title: "Export Slide as PDF", icon: "mdi:file-pdf-box", run: (a) => a.exportPdf() },
    { id: "export-svg", title: "Export Slide as SVG", icon: "mdi:svg", run: (a) => a.exportSvg() },
    { id: "copy-item", title: "Copy Item", icon: "mdi:content-copy", when: needsSelection, run: (a) => a.copySelection() },
    { id: "paste", title: "Paste", icon: "mdi:content-paste", run: (a) => a.pasteClipboard() },
    // 14.9: Duplicate = clone the selection in place (new UUIDs, one undo unit),
    // reusing the copy/paste serialize→insert path locally (no clipboard trip).
    { id: "duplicate", title: "Duplicate", icon: "mdi:content-duplicate", when: (a) => a.canDuplicate(), run: (a) => a.duplicateSelection() },
    // Copy selection region to the SYSTEM clipboard (manifest Round 12B
    // "Palette / selection commands"): renders the selection's world AABB,
    // not the whole slide (unlike Export as PNG/PDF above). when: selection
    // non-empty — needsSelection is exactly that (a.selection !== null).
    { id: "copy-as-png", title: "Copy as PNG", icon: "mdi:image-multiple-outline", when: needsSelection, run: (a) => a.copyAsPng() },
    { id: "copy-as-pdf", title: "Copy as PDF", icon: "mdi:file-pdf-box", when: needsSelection, run: (a) => a.copyAsPdf() },
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

  /** Command. Selected bbox nodes as {n, box} pairs — the shared basis for
   * align/mirror, mirroring distribute's own node-filter above. */
  function selectedBboxNodes(a) {
    const ids = new Set(a.selectedIds());
    return a.nodes()
      .filter((n) => ids.has(n.itemId) && n.plugin.capabilities.bbox)
      .map((n) => ({ n, box: { x: n.state.x ?? 0, y: n.state.y ?? 0, w: n.state.w ?? 0, h: n.state.h ?? 0 } }));
  }

  /**
   * Command (one undo unit). OBJECT ALIGN (manifest 16.3): moves every
   * selected bbox item so its `axis` edge/center matches the SELECTION's own
   * union AABB `edge` ("min"|"max"|"center" — see core/geometry.js
   * alignedPosition). No-op below 2 bbox items (needsMultiBbox gates the
   * command's visibility; this direct-call guard keeps the function safe if
   * ever invoked outside the registry, e.g. from a test).
   */
  function align(a, axis, edge) {
    const items = selectedBboxNodes(a);
    if (items.length < 2) return;
    const union = unionRect(items.map((it) => it.box));
    let doc = a.doc;
    for (const { n, box } of items) {
      const target = alignedPosition(box, union, axis, edge);
      if (target[axis] === box[axis]) continue;
      doc = keyframed(doc, a.slideIndex, ["items", n.itemId, axis], target[axis]);
    }
    a.commit(doc);
  }

  /**
   * Command (one undo unit). MIRROR LAYOUT (manifest 16.3 design fork — see
   * the command registration comment + core/geometry.js mirroredPosition for
   * the full rationale): reflects every selected item's POSITION about the
   * selection's own center axis. Content itself is untouched — this is a
   * layout reflection, not a per-item flip (not representable by the single-
   * scalar {x,y,rotation,scale} transform without a model extension).
   */
  function mirror(a, axis) {
    const items = selectedBboxNodes(a);
    if (items.length < 2) return;
    const union = unionRect(items.map((it) => it.box));
    let doc = a.doc;
    for (const { n, box } of items) {
      const target = mirroredPosition(box, union, axis);
      if (target[axis] === box[axis]) continue;
      doc = keyframed(doc, a.slideIndex, ["items", n.itemId, axis], target[axis]);
    }
    a.commit(doc);
  }

  /**
   * Pure function. The HintBar label for a live modal transform — mode, active
   * axis, and typed numeric buffer, joined by " · " (spec: "Scale · X · 2.5").
   * A grab with no axis carries the "pick an axis (X/Y) to type a distance"
   * prompt (the G-numeric-requires-axis ruling — a grab number needs an axis;
   * the digit keystroke is a no-op until one is chosen). Absent axis/buffer
   * segments are simply omitted.
   *
   * @param {{kind:string, axis:(null|"x"|"y"), buffer:string}} m — modalXform
   * @returns {string}
   *
   * @example modalAnnouncement({ kind: "scale", axis: null, buffer: "" })
   * // "Scale · type a factor"
   * @example modalAnnouncement({ kind: "scale", axis: "x", buffer: "2.5" })
   * // "Scale · X · 2.5"
   * @example modalAnnouncement({ kind: "grab", axis: null, buffer: "" })
   * // "Grab · pick an axis (X/Y) to type a distance"
   * @example modalAnnouncement({ kind: "grab", axis: "x", buffer: "2" })
   * // "Grab · X · 2"
   * @example modalAnnouncement({ kind: "scale", axis: "y", buffer: "" })
   * // "Scale · Y"
   */
  function modalAnnouncement(m) {
    const parts = [m.kind === "scale" ? "Scale" : "Grab"];
    if (m.axis) parts.push(m.axis.toUpperCase());
    if (m.buffer) parts.push(m.buffer);
    else if (!m.axis) parts.push(m.kind === "grab" ? "pick an axis (X/Y) to type a distance" : "type a factor");
    return parts.join(" · ");
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
  // Every edit-context resolver therefore also requires !modalActive. An armed
  // CROSSHAIR mode (manifest ARCHITECTURE PLAN #5) gets the SAME treatment for
  // Escape specifically: while armed, Escape must cancel the crosshair, not
  // fall through to "deselect" — excluding crosshairArmed from editMode (the
  // same lever modalActive uses) means the crosshair-cancel hand entry below,
  // guarded on crosshairArmed alone, is the only Escape handler live at that
  // moment (registry `when`-guards do the disambiguation, not entry order).
  const editAny = (c) => c.mode === "edit" && !c.modalActive && !c.crosshairArmed;
  const editMode = (c) => c.mode === "edit" && !c.paletteOpen && !c.modalActive && !c.crosshairArmed;
  const editSelection = (c) => editMode(c) && c.hasSelection;
  const presentMode = (c) => c.mode === "present";
  const kb = createKeybindings([
    { command: "toggle-palette", keys: ["Cmd", "Shift", "P"], when: "editAny" },
    { command: "undo", keys: ["Ctrl", "Z"], when: "editMode" },
    { command: "redo", keys: ["Ctrl", "Shift", "Z"], when: "editMode" },
    { command: "delete-item", keys: ["Backspace"], when: "editSelection" },
    { command: "copy-item", keys: ["Ctrl", "C"], when: "editSelection" },
    { command: "paste", keys: ["Ctrl", "V"], when: "editMode" },
    // 14.9: Cmd/Ctrl+D = Duplicate. FLAGGED — the binding is the convention
    // candidate PENDING USER RATIFICATION (Cmd+D is the browser bookmark key;
    // onKeydown preventDefaults on dispatch so the bookmark is suppressed while
    // editing). No existing binding uses D, so createKeybindings finds no
    // conflict (keybindings_test guards this).
    { command: "duplicate", keys: ["Cmd", "D"], when: "editSelection" },
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
    duplicate: "Duplicate",
    "put-on-top": "To front", "put-on-bottom": "To back",
    "prev-slide": "Prev slide", "next-slide": "Next slide", deselect: "Deselect",
  };
  const WHEN_RESOLVERS = { editAny, editMode, editSelection };
  // Hidden key aliases + display-only pointer hints stay hand-registered
  // (core/keybindings.js scope: ONE binding per command; gestures aren't keys).
  const handEntries = [
    { keys: ["Delete"], label: "Delete", hidden: true, when: editSelection, command: "delete-item" },
    // SPACEBAR opens the palette (manifest Round 12B: Blender spacebar
    // precedent, same action as Cmd+Shift+P) — a second key ALIAS for
    // toggle-palette, hand-registered exactly like the Delete/Backspace alias
    // above (core/keybindings.js is ONE binding per command by design, for a
    // future keybinding-editor UI; a second alias to the same command is the
    // documented escape hatch). `editAny` matches Cmd+Shift+P's own `when` —
    // same three guards it already encodes: NOT mode==="present" (PresentMode
    // mounts its own capture-phase keydown listener where Space already means
    // "next slide" — completely separate from this dispatcher, so scoping to
    // editAny is both necessary and sufficient to stay out of its way), NOT
    // modalActive (a live G/S modal transform locks input to its own keys —
    // Space isn't one of them), and it's naturally excluded from the
    // INPUT/TEXTAREA/SELECT focus guard in onKeydown below (typing a literal
    // space in a text field never reaches the shortcut registry at all).
    // hidden:true: the palette's OWN shortcut chip (Cmd+Shift+P, via the kb
    // default below) already shows in the HintBar/palette row — a second
    // visible chip for the same command would be redundant clutter, same
    // reasoning as the Delete alias.
    { keys: ["Space"], label: "Palette", hidden: true, when: editAny, command: "toggle-palette" },
    { keys: ["mouse_left"], label: "Select / drag", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed },
    // Shift-click ADDS/REMOVES from the multi-selection (manifest "Shift-click
    // multi-select"). Display-only, same registry pathway as the other pointer
    // hints — the pick code reads the modifier itself. Alongside "Select / drag"
    // while idle over the canvas; hidden mid-drag (shift then means axis-lock,
    // whose own hint fires) and while a crosshair mode is armed.
    { keys: ["Shift", "mouse_left"], label: "Add to selection", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed },
    // An armed CROSSHAIR mode (manifest ARCHITECTURE PLAN #5) replaces the
    // plain pointer hint until the one-shot gesture happens — one hint per
    // skin (band-select vs placement), each named for what the drag DOES.
    { keys: ["mouse_left"], label: "Drag box to select", when: (c) => editMode(c) && !c.dragging && c.crosshairArmed === "band" },
    { keys: ["mouse_left"], label: "Click or drag to place", when: (c) => editMode(c) && !c.dragging && c.crosshairArmed === "place" },
    // Escape cancels an ARMED (not-yet-gesturing) crosshair mode — the
    // editAny/editMode exclusion above (!c.crosshairArmed) means this is the
    // ONLY live Escape handler while armed, so no ordering trick is needed
    // (same disambiguation-by-`when` the modalActive Escape entry below uses).
    { keys: ["Escape"], label: "Cancel", when: (c) => !!c.crosshairArmed, run: () => app.cancelCrosshair() },
    // ANCHOR SNAP (manifest ARCHITECTURE PLAN #4): while a move/resize drag
    // has an ACTIVE snap correction, announce the A-key equation-write. Held
    // A is read directly by CanvasView at pointer-up (a plain keydown/keyup
    // pair, not a command — nothing to run here; display-only, like the
    // Shift/Cmd resize-modifier hints above).
    { keys: ["A"], label: "Anchor snap", when: (c) => editMode(c) && (c.dragKind === "move" || c.dragKind === "resize") && c.snapEngaged },
    // MODIFIER-DRAG CANCEL (Round 18 audit INV5). DISPLAY-ONLY, guarded on a live
    // modifier drag: CanvasView owns the actual Escape→cancel via a CAPTURE-phase
    // listener (it MUST pre-empt App's bubble-phase `deselect` Escape so the
    // selection survives the cancel — see that listener's comment). This entry
    // exists ONLY so the registry knows the input and the HintBar shows it, the
    // same discoverability-parity treatment as the A-hold anchor-snap hint above.
    { keys: ["Escape"], label: "Cancel drag", when: (c) => editMode(c) && c.dragKind === "modifier" },
    // Modifier hints auto-announce PER DRAG KIND (manifest "Drag/resize
    // modifiers": the axis-auto-lock hint pattern, extended) — same registry,
    // never a second pathway. Display-only: the pointer code reads the
    // modifier keys itself. Endpoint drags have no modifiers → no hints.
    { keys: ["Shift"], label: "Axis lock", when: (c) => editMode(c) && c.dragKind === "move" },
    { keys: ["Shift"], label: "Uniform scale", when: (c) => editMode(c) && c.dragKind === "resize" },
    { keys: ["Cmd"], label: "Symmetric resize", when: (c) => editMode(c) && c.dragKind === "resize" },
    // ROUND 13.2 CREATION-DRAG MODIFIERS: a crosshair placement drag
    // (dragKind "place") inherits resize's OWN modifier reading verbatim
    // (CanvasView.placementDrag) — Shift = uniform/aspect-lock, Cmd =
    // symmetric-about-the-start-point — so the hints mirror resize's wording.
    // The BBOX (rect/donut/...) and ENDPOINTS (arrow family) placement kinds
    // share both modifiers (creationRect/creationEndpoint in dragKinds.js),
    // unlike plain resize where an endpoint drag has none — a placement
    // ALWAYS has two live coordinates (start + pointer) to shape, so both
    // hints apply regardless of which kind is armed.
    { keys: ["Shift"], label: "Uniform scale", when: (c) => editMode(c) && c.dragKind === "place" },
    { keys: ["Cmd"], label: "Symmetric resize", when: (c) => editMode(c) && c.dragKind === "place" },
    // Blender-style MODAL transforms (manifest "G/S modal transforms round 2"):
    // G grabs the selection (it follows the mouse with no button held), S scales
    // it about its collective center. Available with a selection in edit mode
    // (editSelection already excludes an active modal, so G/S don't re-enter).
    // These START the modal via the app; CanvasView captures the geometry and
    // drives the preview.
    { keys: ["G"], label: "Grab", when: editSelection, run: () => app.beginModalTransform("grab") },
    { keys: ["S"], label: "Scale", when: editSelection, run: () => app.beginModalTransform("scale") },
    // While a modal transform is live, ONLY its own inputs are active (every
    // edit-context resolver excludes modalActive). Enter or a left click
    // CONFIRMS (one undo unit); Escape CANCELS (reverts the preview). The click
    // is display-only here — CanvasView's pointer handler commits it. The modal
    // announcement (mode · axis · buffer) is injected into the hints below.
    { keys: ["Enter"], label: "Confirm", when: (c) => c.modalActive, run: () => app.modalCommit() },
    { keys: ["mouse_left"], label: "Confirm", when: (c) => c.modalActive },
    { keys: ["Escape"], label: "Cancel", when: (c) => c.modalActive, run: () => app.modalCancel() },
    // AXIS CONSTRAINTS (Blender X/Y): during a live modal, X constrains to the
    // x-axis, Y to the y-axis; same key clears, other key switches. CanvasView
    // toggles the constraint + draws the infinite axis guide through the center.
    { keys: ["X"], label: "X axis", when: (c) => c.modalActive, run: () => app.modalSetAxis("x") },
    { keys: ["Y"], label: "Y axis", when: (c) => c.modalActive, run: () => app.modalSetAxis("y") },
    // NUMERIC ENTRY: digits / "." / "-" build a value buffer applied EXACTLY
    // (S 2 = factor 2; G X 2 = +2 world units along X). Backspace edits it. The
    // digit/sign keys DISPATCH but don't each show a chip (hidden) — one visible
    // hint below announces the capability; the live buffer shows in the modal
    // announcement. modalAppendBuffer no-ops a grab digit with no axis (ruling).
    ...["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-"].map((ch) => ({
      keys: [ch], label: "Type value", hidden: true, when: (c) => c.modalActive, run: () => app.modalAppendBuffer(ch),
    })),
    { keys: ["Backspace"], label: "Edit value", when: (c) => c.modalActive, run: () => app.modalBackspace() },
    { keys: ["mouse_scroll"], label: "Pan", when: editMode },
    { keys: ["Ctrl", "mouse_scroll"], label: "Zoom", when: editMode },
    // PRESENT-MODE keys (Round 18 audit INV5). DISPLAY-ONLY: PresentMode.svelte
    // owns the actual dispatch via its own CAPTURE-phase window listener (it
    // stopPropagation()s to claim these keys during the fullscreen takeover and
    // drives the presenter lifecycle) — the SAME registered-but-externally-
    // dispatched pattern as the pointer/modifier/A-key hints (see shortcuts.js:
    // "gestures handled by pointer code still REGISTER here for the HintBar").
    // Registering EVERY present key (not just Left/Right/Esc) closes the audit
    // gap where Space/PageDown/PageUp existed in the listener but NOT the
    // registry ("a shortcut not in the registry does not exist"). Keep in sync
    // with PresentMode.onkeydown.
    { keys: ["Right"], label: "Next slide", when: presentMode },
    { keys: ["Space"], label: "Next slide", hidden: true, when: presentMode },
    { keys: ["PageDown"], label: "Next slide", hidden: true, when: presentMode },
    { keys: ["Left"], label: "Prev slide", when: presentMode },
    { keys: ["PageUp"], label: "Prev slide", hidden: true, when: presentMode },
    { keys: ["Escape"], label: "Exit", when: presentMode },
    // WYSIWYG RICH-TEXT EDITING (Round 13.4): while a text box is being edited,
    // the bar announces the per-selection format shortcuts. DISPLAY-ONLY — the
    // TextEditOverlay's own keydown handles them (a focused contentEditable makes
    // onKeydown early-return, so no registry `run` fires here — the same pattern
    // as the modifier/A-key hints, which the pointer code reads directly). These
    // route THROUGH the registry so the HintBar knows them (the "only registered
    // inputs may exist" convention: an unregistered shortcut does not exist).
    // Rich-text formatting shortcuts — gated on textEditingRich so they neither
    // dispatch nor appear in the HintBar while a PLAINTEXT box is inline-edited
    // (plain-string mode has no runs/styling; these would be no-ops + clutter).
    { keys: ["Cmd", "B"], label: "Bold", when: (c) => c.textEditingRich },
    { keys: ["Cmd", "I"], label: "Italic", when: (c) => c.textEditingRich },
    { keys: ["Cmd", "U"], label: "Underline", when: (c) => c.textEditingRich },
    { keys: ["Cmd", "Plus"], label: "Bigger", when: (c) => c.textEditingRich },
    { keys: ["Cmd", "Minus"], label: "Smaller", when: (c) => c.textEditingRich },
    // Esc applies to BOTH plain and rich editing (commit + exit).
    { keys: ["Esc"], label: "Done editing", when: (c) => c.textEditing },
    // WYSIWYG LATEX EDITING: while a MathLive field is open the bar announces the
    // exit gesture. DISPLAY-ONLY (the field itself is a typing target, so
    // onKeydown early-returns — LatexEditController's own Escape handler commits).
    { keys: ["Esc"], label: "Done editing", when: (c) => c.latexEditing },
    // CODE editing (CodeEditController overlay): DISPLAY-ONLY exit hint (the
    // focused textarea makes onKeydown early-return, so the panel's own Escape/
    // ⌘⏎ handler commits — this just announces the gesture in the bar).
    { keys: ["Esc"], label: "Done editing", when: (c) => c.codeEditing },
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
      // The ARMED crosshair's kind ("band"|"place"), or null — both a truthy
      // "is anything armed" check (editAny/editMode's !c.crosshairArmed) and a
      // per-skin discriminator (the two pointer hints above) from one field.
      crosshairArmed: app.crosshair?.kind ?? null,
      modalActive: app.modalXform !== null, // a live G/S transform locks input (Blender modal)
      snapEngaged: app.snapEngaged, // manifest ARCHITECTURE PLAN #4: "A = anchor snap" while a drag has an active snap
      // WYSIWYG rich-text editing (Round 13.4): true while a text box is being
      // edited in place — gates the format-shortcut HINTS (Ctrl+B/I/U, Cmd±)
      // whose actual keys the TextEditOverlay handles (a focused contentEditable
      // makes onKeydown below early-return, so these entries are DISPLAY-ONLY,
      // like the modifier/A-key hints — they announce the capability in the bar).
      textEditing: app.textEditing !== null,
      // RICH text editing only (not a plaintext box's plain-string inline edit):
      // gates the Bold/Italic/Underline/± format shortcuts + hints, which have no
      // meaning for a single plain string (plaintext sets app.textEditing.plain).
      textEditingRich: app.textEditing !== null && !app.textEditing.plain,
      // WYSIWYG latex editing (MathLive overlay): true while a latex field is
      // open — gates the "Done editing" hint (the field owns its own keys).
      latexEditing: app.latexEditing !== null,
      // CODE editing (CodeEditController overlay): true while the multi-line code
      // editor is open — gates its "Done editing" hint (the textarea owns keys).
      codeEditing: app.codeEditing !== null,
      app,
    };
  }

  let hints = $derived.by(() => {
    app.mode; app.paletteOpen; app.selection; app.dragging; app.dragKind; app.crosshair; app.modalXform; app.snapEngaged; app.textEditing; app.latexEditing; app.codeEditing;
    const base = app.shortcuts.hints(shortcutCtx());
    // While a modal transform is live, LEAD the bar with its announcement —
    // mode · active axis · typed buffer — so the live state is the first thing
    // read (spec: "Scale · X · 2.5 — Enter commit, Esc cancel"). The [keys] slot
    // shows the mode key (G/S); Enter/Esc chips follow from the entries above.
    const m = app.modalXform;
    if (!m) return base;
    return [[[m.kind === "scale" ? "S" : "G"], modalAnnouncement(m)], ...base];
  });

  /**
   * [ROUND 15.2] CLICK-AWAY commits + exits WYSIWYG text edit (manifest: "the
   * universal editor convention" — pointerdown anywhere outside the overlay
   * AND outside the toolbar). CAPTURE phase, at the window: it must run
   * BEFORE the click's own target handler (CanvasView's onPointerDown may
   * start a NEW drag/selection/band-select on the very same pointerdown;
   * SlideNav/Inspector may reassign selection/slideIndex) so that handler
   * sees an already-dismissed app — this is the "commit-then-continue" half
   * of the spec's ordering choice (see the design note below).
   *
   * ORDERING CHOICE (documented per the task's "pick one, record why"): a
   * plain dismiss here does NOT preventDefault/stopPropagation — the click
   * is allowed to CONTINUE to its normal target after the commit fires, so
   * clicking another item selects it in the SAME gesture (verified live:
   * one click, old text committed + new item selected). This works cleanly
   * because every state change a click could trigger (selection, slideIndex,
   * a fresh beginTextEdit) is itself gated through dismissTextEdit()-calling
   * accessors/methods (see app.svelte.js), so nothing downstream can act on
   * stale textEditing state even though the event keeps going. The
   * alternative (swallow the first click, require a second click to act on
   * the new target) was rejected: PowerPoint/Figma/Keynote all let a
   * click-away-and-select land in one gesture, and re-entrancy here is
   * already safe, so swallowing would only add friction with no benefit.
   *
   * `.closest(".text-edit-overlay-root")` covers BOTH the contenteditable
   * AND the floating TextFormatToolbar in one check — they share that one
   * wrapper div (TextEditOverlay.svelte's template), so a toolbar button
   * click (color pickers, B/I/U, size stepper) never dismisses.
   */
  function onPointerDownCapture(e) {
    if (!app.textEditing && !app.latexEditing && !app.codeEditing) return;
    // Covers all in-place editors' roots (the text overlay/toolbar, the MathLive
    // latex overlay, AND the code-editor panel) in one check — a click inside
    // any is not a click-away. dismissEdit dismisses text/latex; dismissCodeEdit
    // dismisses code (each a no-op when its editor isn't open).
    if (e.target.closest(".text-edit-overlay-root, .latex-edit-overlay-root, .code-edit-overlay-root")) return;
    app.dismissEdit();
    app.dismissCodeEdit();
  }

  /**
   * Query. Is `el` a text-entry target that owns keystrokes, so app shortcuts
   * must NOT fire while it is focused? Covers native inputs, contenteditable,
   * AND the MathLive `<math-field>` custom element — its focused
   * `document.activeElement` is the host tag (NOT an INPUT and NOT reporting
   * isContentEditable), so without the MATH-FIELD case canvas shortcuts would
   * fire while the user types math (a correctness bug, not just jank).
   */
  function isTypingTarget(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.tagName === "MATH-FIELD" || el.isContentEditable);
  }

  function onKeydown(e) {
    if (isTypingTarget(document.activeElement)) return;
    if (app.mode === "present") return; // PresentMode owns its keys
    if (app.paletteOpen) return; // palette owns its keys
    if (app.shortcuts.dispatch(e, shortcutCtx())) e.preventDefault();
  }

  /**
   * Command. Native OS-paste handler (manifest 13.3 PASTE-TO-UPLOAD): Cmd/
   * Ctrl+V with image/video/file data on the OS clipboard uploads it via
   * app.pasteFiles (same upload endpoint as the canvas OS-file drop) and
   * inserts the matching widget. COMPOSES with the pre-existing Ctrl+V
   * keyboard shortcut (dispatched on keydown, above) rather than replacing
   * it: this listener is a no-op whenever clipboardData carries no Files —
   * the internal powerrp_item/powerrp_props JSON paste (system-clipboard
   * text, no Files present) is untouched and always wins in that case, per
   * spec. Guarded identically to onKeydown (skip while typing/present/
   * palette-open). Hash-dedup is explicitly DEFERRED (user, 13.3).
   */
  function onPaste(e) {
    if (isTypingTarget(document.activeElement)) return;
    if (app.mode === "present" || app.paletteOpen) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return; // no OS files — defer entirely to the existing Ctrl+V path
    e.preventDefault();
    app.pasteFiles(files);
  }
</script>

<svelte:window onkeydown={onKeydown} onpaste={onPaste} onpointerdowncapture={onPointerDownCapture} />

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
  <!-- Save to Server: a NAME chooser with conflict/overwrite protection. Shares
       the one name model (doc.meta.name) with the title and Open. -->
  <Modal bind:open={saveModalVisible} title="Save to Server">
    <form class="name-modal" onsubmit={(e) => { e.preventDefault(); confirmSave(); }}>
      <label class="name-modal-field">
        <span class="name-modal-label">Project name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="name-modal-input"
          type="text"
          bind:value={saveName}
          placeholder="Untitled"
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
      </label>
      {#if saveError}
        <div class="name-modal-warning">{saveError}</div>
      {:else if saveWouldClobber}
        <div class="name-modal-warning">A different project named “{saveTrimmed}” already exists — saving will OVERWRITE it.</div>
      {:else if saveNameExists && saveIsCurrent}
        <div class="name-modal-note">Updates the existing project “{saveTrimmed}”.</div>
      {/if}
      <div class="name-modal-actions">
        <button type="button" class="btn" onclick={() => (saveModalVisible = false)}>Cancel</button>
        <button type="submit" class="btn" class:danger={saveWouldClobber} disabled={!saveTrimmed || saveBusy}>
          {saveWouldClobber ? "Overwrite" : "Save"}
        </button>
      </div>
    </form>
  </Modal>
  <!-- Rename Presentation: writes doc.meta.name (the toolbar title). Opened by
       the title's double-click and the "Rename Presentation" command. -->
  <Modal bind:open={renameModalVisible} title="Rename Presentation">
    <form class="name-modal" onsubmit={(e) => { e.preventDefault(); confirmRename(); }}>
      <label class="name-modal-field">
        <span class="name-modal-label">Presentation name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="name-modal-input"
          type="text"
          bind:value={renameName}
          placeholder="Untitled"
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
      </label>
      <div class="name-modal-actions">
        <button type="button" class="btn" onclick={() => (renameModalVisible = false)}>Cancel</button>
        <button type="submit" class="btn" disabled={!renameName.trim()}>Rename</button>
      </div>
    </form>
  </Modal>
  <!-- Built-in Assets browser: a SEPARATE, discovery-only surface for ship-with-
       the-app assets (cursors today). Distinct from the project Asset Explorer —
       built-ins never appear in the user's project asset list. -->
  <Modal bind:open={builtinAssetsVisible} title="Built-in Assets">
    <BuiltinAssetBrowser {app} />
  </Modal>
</div>
