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
    { id: "export-svg", title: "Export Slide as SVG", icon: "mdi:svg", run: (a) => a.exportSvg() },
    { id: "copy-item", title: "Copy Item", icon: "mdi:content-copy", when: needsSelection, run: (a) => a.copySelection() },
    { id: "paste", title: "Paste", icon: "mdi:content-paste", run: (a) => a.pasteClipboard() },
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
    { keys: ["Left", "Right"], label: "Step slides", when: (c) => c.mode === "present" },
    { keys: ["Esc"], label: "Exit", when: (c) => c.mode === "present" },
    // WYSIWYG RICH-TEXT EDITING (Round 13.4): while a text box is being edited,
    // the bar announces the per-selection format shortcuts. DISPLAY-ONLY — the
    // TextEditOverlay's own keydown handles them (a focused contentEditable makes
    // onKeydown early-return, so no registry `run` fires here — the same pattern
    // as the modifier/A-key hints, which the pointer code reads directly). These
    // route THROUGH the registry so the HintBar knows them (the "only registered
    // inputs may exist" convention: an unregistered shortcut does not exist).
    { keys: ["Cmd", "B"], label: "Bold", when: (c) => c.textEditing },
    { keys: ["Cmd", "I"], label: "Italic", when: (c) => c.textEditing },
    { keys: ["Cmd", "U"], label: "Underline", when: (c) => c.textEditing },
    { keys: ["Cmd", "Plus"], label: "Bigger", when: (c) => c.textEditing },
    { keys: ["Cmd", "Minus"], label: "Smaller", when: (c) => c.textEditing },
    { keys: ["Esc"], label: "Done editing", when: (c) => c.textEditing },
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
      app,
    };
  }

  let hints = $derived.by(() => {
    app.mode; app.paletteOpen; app.selection; app.dragging; app.dragKind; app.crosshair; app.modalXform; app.snapEngaged; app.textEditing;
    const base = app.shortcuts.hints(shortcutCtx());
    // While a modal transform is live, LEAD the bar with its announcement —
    // mode · active axis · typed buffer — so the live state is the first thing
    // read (spec: "Scale · X · 2.5 — Enter commit, Esc cancel"). The [keys] slot
    // shows the mode key (G/S); Enter/Esc chips follow from the entries above.
    const m = app.modalXform;
    if (!m) return base;
    return [[[m.kind === "scale" ? "S" : "G"], modalAnnouncement(m)], ...base];
  });

  function onKeydown(e) {
    const el = document.activeElement;
    // isContentEditable added alongside the SPACEBAR-opens-palette binding
    // (manifest Round 12B): no contenteditable exists in the app YET (rich
    // text is future work), but the guard is the general "am I typing text
    // right now" check the spec calls for, so it belongs here rather than
    // waiting for rich text to reintroduce the same gap.
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
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
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    if (app.mode === "present" || app.paletteOpen) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return; // no OS files — defer entirely to the existing Ctrl+V path
    e.preventDefault();
    app.pasteFiles(files);
  }
</script>

<svelte:window onkeydown={onKeydown} onpaste={onPaste} />

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
