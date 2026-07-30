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
  import "iconify-icon"; // registers the <iconify-icon> web component (used in the Open Project grid's placeholder tiles)
  import SplitPane from "../../../lib/SplitPane.svelte";
  import HintBar from "../../../lib/HintBar.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Toolbar from "./Toolbar.svelte";
  import StaticModeNotice from "./StaticModeNotice.svelte";
  import SlideNav from "./SlideNav.svelte";
  import AssetExplorer from "./AssetExplorer.svelte";
  import BuiltinAssetBrowser from "./BuiltinAssetBrowser.svelte";
  import CanvasView from "./CanvasView.svelte";
  import Inspector from "./Inspector.svelte";
  import KeyframePanel from "./KeyframePanel.svelte";
  import VariablesPanel from "./VariablesPanel.svelte";
  import ToolsPane from "./ToolsPane.svelte";
  import FpsCounter from "./FpsCounter.svelte";
  import CommandPalette from "./CommandPalette.svelte";
  import PresentMode from "./PresentMode.svelte";
  import Panel from "./Panel.svelte";
  import Modal from "../../../lib/Modal.svelte";
  import GridSizePicker from "./GridSizePicker.svelte";
  import RenderCenterModal from "./RenderCenterModal.svelte";
  import CodeEditorModal from "./CodeEditorModal.svelte";
  import { renderBadgeCount } from "./renderJobView.js";
  import { listRenderJobs } from "./projectApi.js";
  import { PowerRPApp, THEMES } from "./app.svelte.js";
  import { keyframed, foldState } from "../core/document.js";
  import { isEquationValue, evaluateState } from "../core/expressions.js";
  import { cameraRectAt } from "./cameraFrame.js";
  import { renderCameraFrame } from "./gpuService.js";
  import {
    PROJECT_PREVIEW_CONCURRENCY,
    PROJECT_PREVIEW_BASE_W,
    previewRenderSize,
    mapWithConcurrency,
    projectMetaLine,
  } from "./projectPreviews.js";
  import { createKeybindings } from "../core/keybindings.js";
  import { createShortcuts } from "../core/shortcuts.js";
  // THE entry set + context predicates (core/shortcut_entries.js). They live in
  // DOM-free core so node tests can sweep them; this file keeps only the browser
  // half — localStorage overrides, classifying the focused element into context
  // axes, and the $derived that feeds the bar.
  import {
    KEYBINDING_DEFAULTS,
    KEYBINDING_LABELS,
    WHEN_RESOLVERS,
    handShortcutEntries,
    hintProbeContexts,
    canvasModeStepAxis,
    unsatisfiableEntries,
  } from "../core/shortcut_entries.js";
  import { DRAG_KIND_MODIFIERS, DRAG_KINDS } from "./canvas/dragKinds.js";
  // Widget-owned editor behaviour (see web/widget_handlers.js): every handler that
  // declares a sustained canvas mode — an activation's interior explore, a
  // creation's multi-step placement — contributes its own registry entries.
  import { activations, canvasModes, handlerFor } from "./widget_handlers.js";
  import { unionRect, alignedPosition, mirroredPosition, flippedBox } from "../core/geometry.js";
  import { reportAction } from "../core/report.js";
  // The camera-bind pair's sentences live beside `frameBindable`, the predicate
  // they explain, so the Tools pane's pool row and these command entries show the
  // same words without either transcribing the other's (core/registry.js).
  import { CAMERA_BIND_HELP, CAMERA_BIND_REQUIRES, CAMERA_FREEZE_HELP, CAMERA_FREEZE_REQUIRES, MAKE_STATIC_HELP, MAKE_STATIC_REQUIRES, SLIDE_KEYFRAMES_HELP, SLIDE_KEYFRAMES_REQUIRES } from "../core/registry.js";
  import { FAMILIES } from "../plugins/shapeshifter.js";
  import { subpathsPathD } from "../core/shapes.js";

  const app = new PowerRPApp();

  // Open Project from Server… modal — a PREVIEW GRID of every saved project (was a
  // bare name list). The list loads fresh on every open (the server's projects
  // folder is the source of truth); each card then fills in a first-slide
  // thumbnail rendered CLIENT-side (the server keeps no per-project thumb), so
  // Open reads as "load from server, with previews". Clicking a card runs the
  // SAME load path as before (app.loadProject). Errors surface in the grid area.
  let openModalVisible = $state(false);
  let openProjects = $state(null); // null = loading; [] = none; [{name,mtime,slideCount}] = ready
  let openError = $state(null);
  // name → { status: "pending" | "ready" | "failed", src: dataURL|null }. Cards
  // render immediately from openProjects; thumbnails stream in here as they
  // resolve (a $state object → per-key reads in the grid are reactive).
  let openPreviews = $state({});
  let openNowMs = $state(Date.now()); // captured once per open, for the relative-mtime meta line
  // Bumped on every open; async preview writes carrying a STALE generation (the
  // modal was closed or reopened mid-render) are dropped — no cross-open bleed.
  let openGeneration = 0;

  app.showOpenModal = async () => {
    const gen = ++openGeneration;
    openModalVisible = true;
    openProjects = null;
    openError = null;
    openPreviews = {};
    openNowMs = Date.now();
    let list;
    try {
      list = await app.listProjects();
    } catch (e) {
      if (gen !== openGeneration) return; // modal moved on while listing
      openError = String(e.message ?? e);
      console.error("Open Project from Server: could not list server projects:", e);
      return;
    }
    if (gen !== openGeneration) return;
    openProjects = list;
    for (const p of list) openPreviews[p.name] = { status: "pending", src: null };
    generateOpenPreviews(list, gen); // fire-and-forget: cards are already visible
  };

  /**
   * Command. Render each listed project's slide-0 preview into `openPreviews`,
   * bounded to PROJECT_PREVIEW_CONCURRENCY at a time so N projects don't spawn N
   * simultaneous CanvasKit rasters/fetches. Reads each project's doc read-only
   * (app.fetchProjectDoc — NOT loadProject, which would mutate the editor),
   * rasterizes slide 0 through the shared Skia pixel service at the proxy quality
   * the slide thumbnails use, and stores a data URL. A degenerate/failed render →
   * a name-only placeholder card + a console.warn (never a throw — the pool's
   * worker swallows+reports so one bad project can't halt the rest). Writes
   * carrying a stale `gen` are dropped.
   */
  function generateOpenPreviews(list, gen) {
    const dpr = window.devicePixelRatio || 1;
    mapWithConcurrency(list, PROJECT_PREVIEW_CONCURRENCY, async (p) => {
      if (gen !== openGeneration) return; // modal closed/reopened — stop early
      try {
        const { doc } = await app.fetchProjectDoc(p.name);
        if (gen !== openGeneration) return;
        const repaired = app.repaired(doc); // match what opening it would show (idempotent on clean docs)
        const rect = cameraRectAt(repaired, 0, 1, app.registry);
        const size = previewRenderSize(rect, PROJECT_PREVIEW_BASE_W, dpr);
        if (!size) throw new Error(`degenerate camera rect (${rect.w}×${rect.h})`);
        const canvas = await renderCameraFrame(repaired, {
          slideIndex: 0, alpha: 1, registry: app.registry,
          width: size.width, height: size.height, quality: "proxy",
        });
        if (gen !== openGeneration) return;
        openPreviews[p.name] = { status: "ready", src: canvas.toDataURL("image/png") };
      } catch (e) {
        if (gen !== openGeneration) return;
        openPreviews[p.name] = { status: "failed", src: null };
        console.warn(`Open Project from Server: preview render failed for "${p.name}":`, e);
      }
    });
  }

  async function pickProject(name) {
    openGeneration++; // stop any in-flight preview renders — we're leaving the grid
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
      console.error("Save Project to Server: could not list existing projects (conflict check skipped):", e);
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
      console.error("Save Project to Server failed:", e);
    } finally {
      saveBusy = false;
    }
  }

  // Rename modal (bug: double-clicking the top-left title did nothing). A pure
  // LOCAL edit — writes doc.meta.name via app.renameProject (undoable), no server
  // round-trip, no conflict check (that is a Save concern). Opened by the toolbar
  // title's double-click and the "Rename Project…" command.
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

  // Import-a-.zip RESULT modal. Importing an archive is the one storage action
  // whose OUTCOME the user cannot read off the screen: the deck that appears is
  // the one they dropped, so a COLLISION RENAME ("Imitations" → "Imitations 2")
  // would otherwise be a silent difference between what they dropped and what
  // they now have. This says it — and says a refusal (not a zip, no doc.json,
  // an unsafe member) in the same place, so the drop always answers back. The
  // clean, un-renamed case is not worth a dialog, so it reports to the console
  // only and the modal stays shut; app.svelte.js owns the import itself and
  // knows nothing about this DOM (showImportResult is a hook, like the others).
  let importResult = $state(null); // {ok, name, requested, renamed} | {ok:false, requested, error}
  let importResultVisible = $state(false);
  app.showImportResult = (result) => {
    importResult = result;
    if (!result.ok) {
      console.error(`Import Project from .zip failed for "${result.requested}":`, result.error);
    } else if (result.renamed) {
      console.warn(`Import Project from .zip: "${result.requested}" already existed — imported as "${result.name}".`);
    } else {
      console.log(`Import Project from .zip: opened "${result.name}".`);
      return; // nothing surprising happened; the open project IS the feedback
    }
    importResultVisible = true;
  };

  // Built-in Assets… modal (task #68 follow-up): a SEPARATE, discovery-only
  // browser for ship-with-the-app assets (cursors today), distinct from the
  // project Asset Explorer. Wires app.browseBuiltinAssets()'s hook to the Modal;
  // the catalog is web/builtinAssets.js (loaded lazily by the browser on open).
  let builtinAssetsVisible = $state(false);
  app.showBuiltinAssets = () => {
    builtinAssetsVisible = true;
  };

  // Arrange-into-Grid picker (the bento tool). The "Arrange into Grid" command
  // opens the Office-style grid-size picker via this hook (mirrors showOpenModal);
  // confirming with rows×cols runs the one-undo-unit arrange. `gridPickerCount`
  // seeds the picker's near-square default + item/overflow hint.
  let gridPickerVisible = $state(false);
  let gridPickerCount = $state(0);
  app.showGridPicker = (count) => {
    gridPickerCount = count;
    gridPickerVisible = true;
  };
  function confirmGrid({ rows, cols }) {
    gridPickerVisible = false;
    app.arrangeSelectionIntoGrid(rows, cols);
  }

  // RENDER CENTER modal: the "Render Center" command TOGGLES it (in and out —
  // the same button closes it), hosting the submit form + this project's
  // renderings. The modal owns submit and polling; the wrapper is here, mirroring
  // the Built-in Assets modal.
  let renderCenterVisible = $state(false);
  app.toggleRenderCenter = () => {
    renderCenterVisible = !renderCenterVisible;
  };

  // THE TOOLBAR BADGE. Polled here rather than inside the modal because the whole
  // point is to be visible WHILE THE MODAL IS CLOSED — a render running in the
  // background is exactly the thing the old design let you forget about. Counts
  // jobs still working plus finished ones not yet seen (renderJobView's one
  // definition, shared with the list). A backend that is down simply reports 0:
  // this is an ambient indicator, and a poll failure here must not throw a dialog
  // in front of someone who is drawing — the Render Center itself shows the real
  // error when opened.
  const RENDER_BADGE_POLL_MS = 4000;
  let renderBadge = $state(0);
  async function pollRenderBadge() {
    try {
      renderBadge = renderBadgeCount(await listRenderJobs(app.projectName()));
    } catch {
      renderBadge = 0;
    }
  }
  // NOT POLLED IN STATIC MODE. Render jobs are a SERVER-OWNED noun (a detached
  // process running ffmpeg), so with no backend there is nothing to count and the
  // badge stays 0 — polling a route that cannot exist every 4 seconds forever
  // would be a network error every 4 seconds forever. The absence is stated
  // LOUDLY instead, by the static-mode notice below and by the Render Center's
  // own unavailability panel — never as a silent zero.
  if (!app.isStatic()) {
    pollRenderBadge();
    setInterval(pollRenderBadge, RENDER_BADGE_POLL_MS);
  }
  app.loadAutosave();
  app.loadTheme();
  window.__powerrp_app = app; // dev/test hook (headless smoke tests introspect via this)

  // SplitPane splits are BOUNDARY positions: [0.16, 0.78] → 3 panes.
  let hSplits = $state([0.16, 0.78]);
  // Left column: Slide Navigator (top) / Asset Explorer (bottom) — one split.
  let leftSplits = $state([0.62]);
  // Right column: Property Panel / Tools / Variables Panel / Keyframe Panel.
  // Tools got a little taller than the old Presets pane's 0.18: it now holds
  // several tools (a category accordion per group), and at 0.18 its FIRST section
  // header was already scrolled out of sight at rest — which is how the "bind to
  // camera" tool would look like it was never built. 0.22 shows every tool with
  // its heading, closed, without scrolling. The 9px comes off the Property Panel.
  let rightSplits = $state([0.35, 0.57, 0.78]);

  // ── Core commands (plugins added theirs at registration) ──────────────────
  const needsSelection = (a) => a.selection !== null;
  // The HANDLE-scope commands need the INNER selection scope (app.svelte.js
  // handleSelection) to be live. `handles()` already restricts itself to a single
  // item selection, so this needs no separate selection check.
  const needsHandles = (a) => a.handleSelection.length > 0;
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
  // FLIP needs only ONE flippable item — a lone widget reflects about its own
  // center, so unlike align/mirror there is no missing second reference to invent.
  // Goes through flipTargetIds so a selected GROUP counts via its bbox members
  // (the group itself has no flippable box — see there).
  const needsFlippable = (a) => flipTargetIds(a).ids.length > 0;

  // ── THE REASONS a gated command is greyed out ───────────────────────────────
  // Each completes the sentence "Unavailable — requires …" (core/registry.js
  // TOOL_POOL states the wording rule; web/Toolbar.svelte, web/ToolsPane.svelte
  // and the command palette's help section all render it). Every `when` above is
  // shared by several commands, so the sentence belongs to the GATE and is
  // written ONCE here rather than copied per entry — a sentence transcribed
  // fourteen times is fourteen chances to drift, which is the same defect
  // tests/toolbar_surfacing_test.js exists to have removed from the Toolbar.
  const REQUIRES_SELECTION = "at least one selected widget";
  const REQUIRES_HANDLES = "at least one selected modifier point — click a widget first, then one of its points";
  const REQUIRES_PURGEABLE = "a selected widget that may be removed (THE camera is mandatory, so it can be neither hidden nor purged)";
  const REQUIRES_MULTI_BBOX = "at least two selected widgets that have a box — a lone widget has no second one to line up against";
  const REQUIRES_THREE_BBOX = "at least three selected widgets — distributing spaces the ones BETWEEN the two extremes, so two is already evenly spaced";

  // ── HELP shared by a family of commands ─────────────────────────────────────
  // The optional `help` a surfacing shows on hover (core/commands.js): the
  // CONSEQUENCE and the reason you would reach for it, never a restatement of the
  // title. Written once where a whole family behaves the same way, for the same
  // reason the REQUIRES sentences above are.
  const HELP_Z_ORDER = "Z is renumbered document-wide after every move: the widget takes a z between its new neighbours and the whole deck is then normalised, so z values you never touched change too. Order is what is preserved, not the numbers.";
  const HELP_ALIGN = "Aligns to the SELECTION's own edge, not the slide's — the outermost selected widget stays exactly where it is and the rest come to it.";
  const HELP_DISTRIBUTE = "Leaves the two outermost widgets alone and evens out the gaps between the ones in between, which is why it needs a third widget to have anything to move.";
  const HELP_MIRROR = "Swaps the widgets' SIDES about the selection's centre and leaves each widget's own content untouched. Flip Content is the other half — run both to reflect an arrangement completely.";
  const HELP_EXPORT_CAMERA = "THE CAMERA decides the output — its rect IS the image, at its own size and aspect. Not the visible viewport, and not the widgets' extent, so what you export does not change when you pan or zoom.";
  const HELP_FLIP = "Reverses ONE widget's own content about its own centre (a negative size with the position compensated), leaving it where it sits. Mirror Layout is the one that moves widgets to each other's side.";

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
    // Material set:
    blueprint: "mdi:ruler-square-compass",
    sunrise: "mdi:weather-sunset-up",
    desert: "mdi:cactus",
    // Material set II (the non-colour levers):
    nocturne: "mdi:glass-tulip",
    "futura-dark": "mdi:format-letter-case",
    "futura-light": "mdi:format-letter-case-upper",
    // Material set III:
    eink: "mdi:book-open-page-variant-outline",
    phosphor: "mdi:console",
    platinum: "mdi:desktop-classic",
    ember: "mdi:fire",
  };
  // Local box the `insert-shape` family tile previews are generated in; matches
  // ShapePicker's 100-unit tile viewBox content area (`-6 -6 112 112`).
  const SHAPE_PREVIEW_DIM = 100;

  // ── BIND TO CAMERA (a GENERAL tool, surfaced in the Tools pane) ─────────────
  // "Bind to camera" writes the four frame properties of the SELECTION as
  // EQUATIONS reading THE camera's own frame, so the widget tracks the camera
  // when it moves, resizes or zooms across slides instead of holding baked
  // numbers. plugins/demo/lens_flare.js already ships this as its DEFAULT pose
  // ("x: '= camera.x', …"); this is the same idea as an on-demand action for any
  // widget, which is why nothing here mentions a widget type.
  //
  // SAME KEY ON BOTH SIDES: core/properties.js PROPS defines x/y as the
  // widget's TOP-LEFT corner and w/h as its size for EVERY bbox widget, and the
  // camera is an ordinary bbox item, so x=camera.x … h=camera.h makes the widget
  // exactly cover the camera rect with no arithmetic.
  const CAMERA_BIND_KEYS = ["x", "y", "w", "h"];

  /**
   * Query. The current slide's folded state WITHOUT any live preview blended in:
   * {raw, evaluated} — raw keeps equation strings, evaluated has numbers.
   *
   * app.rawState()/app.state() DO blend previewDelta, which is exactly wrong for
   * a tool that both HOVER-PREVIEWS itself and asks "is there anything left to
   * do?": its own preview answers "no", so the button greys out under the
   * pointer and the registry's `when` gate then refuses the click that follows.
   * That was a real, reproduced silent no-op on Unbind, not a hypothetical.
   * Both maps are memoized (foldState per document, evaluateState per state
   * identity), so this costs no more than reading app.state().
   */
  function documentState(a) {
    const raw = foldState(a.doc, a.slideIndex, 1);
    // The PROJECT SCRIPT rides along (a.projectScript()) for the same reason it does
    // everywhere else: it lives in doc.meta, not in the fold, so an evaluation that
    // omits it sees every script-driven property fall back to its default — and a
    // "is there anything left to unbind?" gate reading defaults would answer about a
    // document the user is not looking at.
    return { raw, evaluated: evaluateState(raw, a.registry, a.projectScript()).state };
  }

  /**
   * Pure function. The setPreview path/value pairs that BIND every item in
   * `itemIds` to the camera: one stored equation per CAMERA_BIND_KEYS entry.
   *
   * The stored form is a BARE "@<cameraId>.<prop>" reference — exactly what the
   * Inspector's own numeric field commits (NumericField → displayToStored,
   * which strips the "=" marker on a numeric slot), and what storedToDisplay
   * renders back as the readable "camera.x". Storing the camera's UUID rather
   * than its slug is core/expressions.js's rule ("store by itemId, display as
   * slugs"), so renaming the camera can never break a binding.
   *
   * @example cameraBindPairs(["a1"], "cam9")
   * // [[["items","a1","x"], "@cam9.x"], [["items","a1","y"], "@cam9.y"],
   * //  [["items","a1","w"], "@cam9.w"], [["items","a1","h"], "@cam9.h"]]
   * @example cameraBindPairs([], "cam9") // []
   */
  function cameraBindPairs(itemIds, cameraId) {
    return itemIds.flatMap((id) => CAMERA_BIND_KEYS.map((key) => [["items", id, key], `@${cameraId}.${key}`]));
  }

  /**
   * Query. Which SELECTED items can take a camera bind: every selected item
   * whose plugin declares all four frame properties, minus THE camera itself
   * (binding the camera to its own frame is a dependency cycle). Widgets with
   * no frame at all (a blur layer: z/blur/opacity only) and endpoint widgets
   * (arrows carry from/to, not x/y/w/h) drop out by that same declaration
   * test — the generality gate is "does this widget HAVE the properties",
   * never a type list. Preview-free (documentState) for the reason documented
   * there. THE camera is found through app.cameraState(), the one house accessor
   * for the mandatory singleton — never a hardcoded id or type scan here.
   */
  function cameraBindTargets(a) {
    const camera = a.cameraState();
    if (!camera) return []; // degenerate pre-repair document (no active camera)
    const items = documentState(a).raw.items ?? {};
    return a.selectedIds().filter((id) => {
      if (id === camera.id) return false;
      const type = items[id]?.type;
      if (typeof type !== "string") return false; // not created on this slide
      const plugin = a.registry.get(type);
      return CAMERA_BIND_KEYS.every((key) => plugin.defaults[key] !== undefined);
    });
  }

  /** Query. cameraBindPairs for the current selection (empty when nothing can
   * be bound), shared by the command's `preview` and its `run` so the hover
   * preview and the commit are the same write by construction. */
  function cameraBindWrite(a) {
    const camera = a.cameraState();
    return camera ? cameraBindPairs(cameraBindTargets(a), camera.id) : [];
  }

  /**
   * Query. THE INVERSE of a camera bind: pairs that FREEZE each selected
   * item's equation-bound frame properties to the plain numbers they currently
   * evaluate to. Only keys that actually hold an equation are written (a
   * literal x is left exactly as it is), and only when the evaluated value is a
   * number — an equation that failed to evaluate is skipped here rather than
   * baked, and the Inspector's error affordance is already reporting it.
   * Deliberately not camera-specific: it unbinds a frame property bound to
   * ANYTHING, which is what makes it the honest inverse of one-click binding.
   * Preview-free (documentState) — see there; this is the function whose
   * preview-blended version disabled its own button on hover.
   */
  function cameraFreezeWrite(a) {
    const { raw, evaluated } = documentState(a);
    return a.selectedIds().flatMap((id) => {
      const type = raw.items?.[id]?.type;
      if (typeof type !== "string") return [];
      const plugin = a.registry.get(type);
      return CAMERA_BIND_KEYS
        .filter((key) => isEquationValue(plugin, [key], raw.items[id][key]))
        .filter((key) => typeof evaluated.items?.[id]?.[key] === "number")
        .map((key) => [["items", id, key], evaluated.items[id][key]]);
    });
  }

  const coreCommands = [
    { id: "delete-item", title: "Delete (deactivate on this slide)", icon: "mdi:eye-off-outline", when: needsPurgeable, requires: REQUIRES_PURGEABLE, help: "Keyframes `active` off from this slide onward. The widget still exists and still appears on the slides before this one — Show puts it back, and Purge is the irreversible one.", run: (a) => a.deleteSelection() },
    { id: "purge-item", title: "Purge Item (remove from existence)", icon: "mdi:delete-forever-outline", when: needsPurgeable, requires: REQUIRES_PURGEABLE, help: "Removes the widget from the DOCUMENT — every slide at once, and Show cannot bring it back. Reach for Delete when you only meant to stop it appearing here.", run: (a) => a.purgeSelection() },
    // The inverse of delete-item — registry-routed per the cruft audit (un-hide
    // previously had NO command surfacing, so it could never get a shortcut).
    { id: "show-item", title: "Show (activate on this slide)", icon: "mdi:eye-outline", when: needsSelection, requires: REQUIRES_SELECTION, help: "The inverse of Delete: keyframes `active` back on here, so a widget that was switched off earlier in the deck reappears from this slide onward.", run: (a) => a.showSelection() },
    // ── THE HANDLE SCOPE (selected modifier points — the inner selection scope) ──
    // Deliberately the SAME three verbs as the item block above, one level down, so
    // the vocabulary is learned once. Gated on a live handle selection, which is
    // also what makes the Backspace/Cmd+Backspace bindings unambiguous (the item
    // commands' `when` excludes it — core/shortcut_entries.js editSelection).
    // The purge title states the renumbering consequence rather than hiding it: it
    // shifts every later element's address, so an equation bound to one of them
    // comes to mean its neighbour (core/lists.js indexAfterPurge is the remap the
    // not-yet-built document-wide equation rewrite needs).
    { id: "hide-points", title: "Hide Points (draw straight past them; nothing is renumbered)", icon: "mdi:eye-off", when: needsHandles, requires: REQUIRES_HANDLES, help: "The point keeps its index, so an equation naming it still means the same point — that is the whole difference from Purge Points.", run: (a) => a.setHandleSelectionActive(false) },
    { id: "show-points", title: "Show Points", icon: "mdi:eye", when: needsHandles, requires: REQUIRES_HANDLES, run: (a) => a.setHandleSelectionActive(true) },
    { id: "purge-points", title: "Purge Points (remove for good — renumbers the later points)", icon: "mdi:delete-forever-outline", when: needsHandles, requires: REQUIRES_HANDLES, help: "The renumbering is the part that bites: every later point shifts down an index, so an equation written against point 4 comes to mean what used to be point 5. Hide Points is the non-destructive one.", run: (a) => a.purgeHandleSelection() },
    // ── THE KEYFRAME SCOPE (two tools, one per SCOPE) ───────────────────────────
    // Both are surfaced in the Tools pane's "Keyframes" section (core/registry.js
    // TOOL_POOL); help + requires come from there so the pane, the palette and any
    // future toolbar button read the same sentence. Their titles OPEN with
    // different words on purpose — the palette is fuzzy-searched, so two "Remove
    // Keyframes…" entries would both match one query (registry.js says more) — and
    // each names its own SCOPE, which is the exact thing the first version of the
    // sweeping one left unsaid and got reported for.
    { id: "remove-slide-keyframes", title: "Remove Keyframes on This Slide (the widget inherits the previous slide)", icon: "mdi:vector-point-minus", when: (a) => a.slideKeyframeTargets().length > 0, requires: SLIDE_KEYFRAMES_REQUIRES, help: SLIDE_KEYFRAMES_HELP, run: (a) => a.removeSlideKeyframes() },
    { id: "make-static", title: "Make Static from Current Slide (every slide from where it appears until it is hidden)", icon: "mdi:motion-pause-outline", when: (a) => a.makeStaticTargets().length > 0, requires: MAKE_STATIC_REQUIRES, help: MAKE_STATIC_HELP, run: (a) => a.makeSelectionStatic() },
    { id: "bring-forward", title: "Bring Forward", icon: "mdi:arrange-bring-forward", when: needsSelection, requires: REQUIRES_SELECTION, help: HELP_Z_ORDER, run: (a) => a.reorderSelection(+1) },
    { id: "send-backward", title: "Send Backward", icon: "mdi:arrange-send-backward", when: needsSelection, requires: REQUIRES_SELECTION, help: HELP_Z_ORDER, run: (a) => a.reorderSelection(-1) },
    { id: "put-on-top", title: "Put on Top", icon: "mdi:arrange-bring-to-front", when: needsSelection, requires: "a selected widget to reorder", help: HELP_Z_ORDER, run: (a) => a.sendToExtreme(+1) },
    { id: "put-on-bottom", title: "Put on Bottom", icon: "mdi:arrange-send-to-back", when: needsSelection, requires: "a selected widget to reorder", help: HELP_Z_ORDER, run: (a) => a.sendToExtreme(-1) },
    { id: "distribute-h", title: "Distribute Horizontally", icon: "mdi:distribute-horizontal-center", when: (a) => a.selectedIds().length >= 3, requires: REQUIRES_THREE_BBOX, help: HELP_DISTRIBUTE, run: (a) => distribute(a, "x", "w") },
    { id: "distribute-v", title: "Distribute Vertically", icon: "mdi:distribute-vertical-center", when: (a) => a.selectedIds().length >= 3, requires: REQUIRES_THREE_BBOX, help: HELP_DISTRIBUTE, run: (a) => distribute(a, "y", "h") },
    // OBJECT ALIGN (manifest 16.3, distinct from 15.6's text-paragraph align):
    // moves every selected bbox widget so its edge/center matches the
    // SELECTION's own collective edge/center — same needsMultiBbox gate as
    // distribute (≥2 items: aligning a single item to itself is a no-op, so
    // unlike distribute's ≥3 this only needs ≥2 to be meaningful).
    { id: "align-left", title: "Align Left", icon: "mdi:align-horizontal-left", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_ALIGN, run: (a) => align(a, "x", "min") },
    { id: "align-right", title: "Align Right", icon: "mdi:align-horizontal-right", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_ALIGN, run: (a) => align(a, "x", "max") },
    { id: "align-top", title: "Align Top", icon: "mdi:align-vertical-top", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_ALIGN, run: (a) => align(a, "y", "min") },
    { id: "align-bottom", title: "Align Bottom", icon: "mdi:align-vertical-bottom", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_ALIGN, run: (a) => align(a, "y", "max") },
    { id: "align-center-h", title: "Align Center Horizontal", icon: "mdi:align-horizontal-center", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_ALIGN, run: (a) => align(a, "x", "center") },
    { id: "align-center-v", title: "Align Center Vertical", icon: "mdi:align-vertical-center", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_ALIGN, run: (a) => align(a, "y", "center") },
    // MIRROR (manifest 16.3): LAYOUT-ONLY mirror — reflects each selected
    // item's POSITION about the selection's own center axis; items swap
    // sides but their own content is NOT flipped. Titled "Mirror Layout"
    // (not plain "Mirror") so it is never mistaken for a content flip —
    // that is FLIP below, which 16.3's design fork left unbuilt and the
    // user has since settled ("a flip simply should change the height and
    // width to negative and put the position to where it would have to be
    // to accommodate"). The two COMPOSE: Mirror Layout swaps sides, Flip
    // reverses each item's own content, and together they reflect an
    // arrangement completely. See core/geometry.js mirroredPosition and
    // flippedBox for the two pieces of math.
    { id: "mirror-h", title: "Mirror Layout Horizontal", icon: "mdi:flip-horizontal", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_MIRROR, run: (a) => mirror(a, "x") },
    { id: "mirror-v", title: "Mirror Layout Vertical", icon: "mdi:flip-vertical", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: HELP_MIRROR, run: (a) => mirror(a, "y") },
    // FLIP (the CONTENT reflection — see the `flip` helper below). Needs only ONE
    // item, unlike align/mirror: a lone widget has its own center to reflect
    // about, so there is nothing arbitrary to invent here. The titles say
    // "Content" because "Flip" alone next to "Mirror Layout" would leave the
    // difference to be guessed — the same reason `mirror-h` is not plain "Mirror"
    // and `unbind-from-camera` names the keys it touches.
    { id: "flip-h", title: "Flip Content Horizontal (mirror left ↔ right)", icon: "mdi:flip-horizontal", when: needsFlippable, requires: "a selected widget with a width to flip", help: HELP_FLIP, run: (a) => flip(a, "x") },
    { id: "flip-v", title: "Flip Content Vertical (mirror top ↔ bottom)", icon: "mdi:flip-vertical", when: needsFlippable, requires: "a selected widget with a height to flip", help: HELP_FLIP, run: (a) => flip(a, "y") },
    // FLAGGED — PENDING USER RATIFICATION: no keybindings assigned to any of
    // the 10 align/mirror/flip commands above. Followed the exact precedent of
    // distribute-h/distribute-v (also palette-only, no bound keys) rather
    // than inventing new key combos — the manifest's "no arbitrary
    // constraints invented by Claude" rule requires picking new bindings be
    // run by the user first, not guessed. All 8 are reachable via the
    // command palette today; add to the `kb` array below if/when the user
    // picks combos.
    // BIND TO CAMERA + its inverse (the Tools pane's first non-preset tools).
    // Registry commands, not pane-local buttons, because the command registry is
    // THE action layer — so the palette gets them for free and a keybinding can
    // be added later without touching the pane. Both write through
    // setPreview → commitPreview, the Inspector-row commit path, so the whole
    // bind (four equations × every eligible selected item) is ONE undo unit.
    // Each also declares `preview(app) -> revert`, the general previewable-
    // command protocol (core/commands.js): the palette AND the Tools pane show
    // the bind LIVE on hover with the document untouched, the house
    // hover-to-preview trope the preset cards established.
    {
      id: "bind-to-camera",
      // "Bind to Camera" did not say WHAT it binds, the same gap the user named
      // on the inverse ("you have bind to camera, and then unbind. Unbind
      // what?"). The object is the widget's FRAME, and the words are not invented
      // here: core/registry.js FRAME_KEYS defines a frame as "a position and a
      // size", hasFrame's docstring calls it that, and the Inspector groups those
      // four rows under Positioning — so the pair now reads
      //   Bind Position & Size to Camera / Unbind Position & Size (freeze …)
      // and neither half leaves its object to be guessed.
      title: "Bind Position & Size to Camera",
      icon: "mdi:link-variant",
      when: (a) => cameraBindWrite(a).length > 0,
      requires: CAMERA_BIND_REQUIRES,
      help: CAMERA_BIND_HELP,
      preview: (a) => {
        a.setPreview(cameraBindWrite(a));
        return () => a.cancelPreview();
      },
      run: (a) => {
        // setPreview REPLACES previewDelta wholesale, so any staged hover preview
        // is superseded rather than compounded; both writes are derived from the
        // preview-free documentState, so hover-then-click and a cold click commit
        // exactly the same thing.
        a.setPreview(cameraBindWrite(a));
        a.commitPreview();
      },
    },
    {
      id: "unbind-from-camera",
      // "Unbind" alone did not say WHAT (the user asked exactly that), so the
      // title names the keys it touches. It is deliberately NOT "Unbind from
      // Camera": it freezes an equation on x/y/w/h whatever that equation
      // references, which is what makes it the honest inverse of one-click bind.
      title: "Unbind Position & Size (freeze x/y/w/h to numbers)",
      icon: "mdi:link-variant-off",
      when: (a) => cameraFreezeWrite(a).length > 0,
      requires: CAMERA_FREEZE_REQUIRES,
      help: CAMERA_FREEZE_HELP,
      preview: (a) => {
        a.setPreview(cameraFreezeWrite(a));
        return () => a.cancelPreview();
      },
      run: (a) => {
        a.setPreview(cameraFreezeWrite(a)); // preview-free derivation; see documentState
        a.commitPreview();
      },
    },
    // GROUPS (manifest rough draft): Group Selection needs ≥2 groupable items;
    // Ungroup is enabled when any selected node is a group. Both operate on the
    // selection through the app helpers (which own the AABB + keyframe baking).
    { id: "group", title: "Group Selection", icon: "mdi:group", when: (a) => a.canGroup(), requires: "at least two groupable widgets — a one-widget group is inert, so grouping starts at two", help: "A group is a flat MEMBERSHIP parent, not a nested object: every member keeps its own id, its own keyframes and its own place in the delta, and gains one box that moves and resizes them together.", run: (a) => a.groupSelection() },
    { id: "ungroup", title: "Ungroup", icon: "mdi:ungroup", when: (a) => a.selectedNodes().some((n) => n.type === "group"), requires: "a selected group", help: "Dissolves the group and BAKES what its box was doing into the members, so they stay exactly where they look like they are rather than springing back to their pre-group values.", run: (a) => a.ungroupSelection() },
    // ARRANGE INTO GRID (the bento tool): lays the selection out as a BENTO GRID.
    // Same ≥2-bbox gate as align/mirror. INTERACTIVE (palette commands take no
    // args): `run` opens the Office-style grid-size picker; its confirm calls
    // a.arrangeSelectionIntoGrid(rows, cols) — creating ONE bento sized to the
    // selection's union AABB and re-flowing each item's center into a cell, in one
    // undo unit. Consumes the bento widget (parallel lane #86); reports loudly
    // if that lane hasn't merged yet (the picker + pure math still work).
    // Ellipsis per the storage-vocabulary rule below: `run` opens the grid-size
    // picker, so it needs further input before anything happens.
    { id: "arrange-grid", title: "Arrange into Grid…", icon: "mdi:view-grid-plus-outline", when: needsMultiBbox, requires: REQUIRES_MULTI_BBOX, help: "Creates ONE bento widget sized to the selection's combined box and re-flows each widget's centre into a cell. The widgets are MOVED, not parented — the bento is a layout scaffold they sit on, so moving one afterwards just moves it.", run: (a) => a.arrangeIntoGrid() },
    { id: "toggle-anchors", title: "Toggle Anchor Visibility", icon: "mdi:anchor", run: (a) => (a.anchorsVisible = !a.anchorsVisible) },
    { id: "toggle-snap", title: "Toggle Snapping", icon: "mdi:magnet", run: (a) => a.toggleSnap() },
    { id: "toggle-snap-size", title: "Toggle Snap to Matching Size", icon: "mdi:magnet-on", help: "Adds the OTHER widgets' widths and heights as snap targets while resizing, so two widgets can be made exactly the same size without reading a number off either.", run: (a) => a.toggleSnapSize() },
    { id: "toggle-minimap", title: "Toggle Minimap", icon: "mdi:map-outline", run: (a) => a.toggleMinimap() },
    { id: "toggle-fps", title: "Toggle FPS Counter", icon: "mdi:speedometer", run: (a) => a.toggleFps() },
    { id: "toggle-grid", title: "Toggle Grid", icon: "mdi:grid", run: (a) => a.toggleGrid() },
    { id: "toggle-ruler", title: "Toggle Ruler", icon: "mdi:ruler", run: (a) => a.toggleRuler() },
    // "Show Ghosts" was the odd one out in this Toggle… run: it is a boolean
    // toggle (toggleGhosts), and the manifest's own words are "GHOST OBJECTS"
    // + a TOGGLE — so the title now matches both the siblings and the manifest.
    { id: "toggle-ghosts", title: "Toggle Ghost Objects (crop box / empty-text / group outlines)", icon: "mdi:eye-outline", run: (a) => a.toggleGhosts() },
    { id: "toggle-panel-names", title: "Toggle Panel Names", icon: "mdi:format-title", run: (a) => a.togglePanelNames() },
    // The QUICK light/dark flip, next to its Toggle… siblings. It was the ONE
    // toolbar button with no entry, which meant the one button that could never
    // take a keybinding, never appear in the palette, and whose label/tip the
    // toolbar had to write out by hand — the exact gap the command registry
    // exists to close. `color-theme` above stays the full set; this is the
    // two-state flip between the light theme and the dark default.
    // NO KEYBINDING, deliberately: a keycap is a scarce, user-facing resource and
    // this is a cosmetic viewer preference, so it earns a palette row (where the
    // full Color Theme submenu also lives) rather than a key. The toolbar draws a
    // STATE-DEPENDENT glyph for it (the theme it would switch TO), which the
    // registry's single `icon` string cannot express — the same documented
    // icon-override case as the anchor and ghost composites — so the entry's icon
    // is the neutral both-states glyph the palette shows.
    { id: "toggle-light-dark", title: "Toggle Light / Dark Theme", icon: "mdi:theme-light-dark", run: (a) => a.toggleLightDark() },
    { id: "new-slide", title: "New Slide", icon: "mdi:plus-box-outline", help: "The new slide starts as an EMPTY delta, so it looks identical to the one before it until you change something — and then only the difference is recorded. That is what makes a widget on both slides the same widget.", run: (a) => a.addSlide() },
    // "Fresh" said nothing next to plain "New Slide"; the id and the handler both
    // say BLANK (addBlankSlide), and the parenthetical now uses the same word as
    // delete-item's "deactivate" for the same underlying operation.
    { id: "new-blank-slide", title: "New Blank Slide (deactivates every visible item)", icon: "mdi:plus-box", help: "Nothing is purged: the slide keyframes `active` off for each currently visible widget, so you start on an empty stage and can bring any of them back with Show.", run: (a) => a.addBlankSlide() },
    { id: "delete-slide", title: "Delete Slide", icon: "mdi:file-remove-outline", when: (a) => a.doc.slides.length > 1, requires: "more than one slide — a document always has at least one", help: "Deletes this slide's DELTA, not the widgets in it. Anything an earlier slide created still exists; what is lost is the changes this slide made, so the slides after it now inherit from the one before it.", run: (a) => a.deleteSlide() },
    { id: "toggle-slide", title: "Toggle Slide Visibility (enable/disable delta)", icon: "mdi:eye-check-outline", help: "A disabled slide is SKIPPED when the deltas are folded, so every slide after it inherits as though it were not there — the way to park a variant without deleting it.", run: (a) => a.toggleSlide() },
    { id: "move-slide-up", title: "Move Slide Up", icon: "mdi:arrow-up", run: (a) => a.moveSlide(-1) },
    { id: "move-slide-down", title: "Move Slide Down", icon: "mdi:arrow-down", run: (a) => a.moveSlide(+1) },
    { id: "next-slide", title: "Next Slide", icon: "mdi:chevron-right", run: (a) => (a.slideIndex = Math.min(a.slideIndex + 1, a.doc.slides.length - 1)) },
    { id: "prev-slide", title: "Previous Slide", icon: "mdi:chevron-left", run: (a) => (a.slideIndex = Math.max(a.slideIndex - 1, 0)) },
    // NUDGE — the arrow keys move the SELECTION one pixel (user ruling: "arrow
    // keys should move widgets by one pixel in the direction I press, not go
    // between slides" — slide navigation moved to [ and ]). One undo unit per
    // press; routed through CanvasView's installed nudgeSelection so a nudge
    // and a drag translate members through the SAME translationPairs rule.
    { id: "nudge-left", title: "Nudge Left (1px)", icon: "mdi:arrow-left", run: (a) => a.nudgeSelection(-1, 0) },
    { id: "nudge-right", title: "Nudge Right (1px)", icon: "mdi:arrow-right", run: (a) => a.nudgeSelection(1, 0) },
    { id: "nudge-up", title: "Nudge Up (1px)", icon: "mdi:arrow-up", run: (a) => a.nudgeSelection(0, -1) },
    { id: "nudge-down", title: "Nudge Down (1px)", icon: "mdi:arrow-down", run: (a) => a.nudgeSelection(0, 1) },
    { id: "present", title: "Present (fullscreen)", icon: "mdi:play", run: (a) => a.enterPresentMode() },
    // ── STORAGE COMMAND VOCABULARY (the one scheme every title below obeys) ───
    // The user read "open project / load presentation / download project / save
    // presentation / save to server as project" as one inscrutable pile: three
    // nouns for one object, and verbs that never said WHERE the bytes went.
    // The scheme, derived from the manifest (Round 12 "Projects are FOLDERS")
    // and the oldest title precedent ("Export Slide as PNG"), not from taste:
    //
    //   NOUNS — two real, different payloads; the titles make the difference
    //   VISIBLE rather than collapsing it:
    //     PROJECT  = document + assets/ (a server folder; a .zip when it leaves).
    //                doc.meta.name IS the project name (app.svelte.js).
    //     DOCUMENT = the {meta, slides} JSON body ALONE — NO assets. Asset refs
    //                are backend /asset/<project>/<file> URLs, so a bare
    //                document is not self-contained; the titles say "no assets".
    //     "Presentation" is NOT a storage noun. It is the ACT (Present mode) —
    //     the only place it survives is the `present` command above.
    //
    //   VERBS — the verb alone tells you the target, in both directions:
    //     SERVER project store  → Open / Save   (+ explicit "…Server" in title)
    //     LOCAL DISK file       → Import / Export (+ the file extension)
    //     SYSTEM CLIPBOARD      → Copy
    //   Download/Upload are deliberately RETIRED from these titles: "upload"
    //   already means "put an asset on the server" everywhere else in this app
    //   (app.svelte.js uploadAsset), so a local-disk "Download" beside it read
    //   backwards.
    //
    //   ELLIPSIS — "…" iff the command opens a dialog/modal/file picker. NOT for
    //   submenus (CommandPalette draws them a chevron) and NOT for crosshair
    //   placement (a mode with a visible cursor, not a dialog).
    { id: "save-file", title: "Export Document as .powerrp.json (no assets)", icon: "mdi:file-export-outline", run: (a) => a.saveFile() },
    { id: "load-file", title: "Import Document from .powerrp.json…", icon: "mdi:file-import-outline", run: (a) => a.loadFile() },
    { id: "clear-doc", title: "New Empty Document (replaces this one; undoable)", icon: "mdi:broom", run: (a) => a.clearDoc() },
    // Project server (manifest Round 12: projects are FOLDERS on the server;
    // the leaving format is a .zip of the folder). Save opens a NAME chooser
    // with conflict/overwrite protection (a project of that name already on the
    // server warns before clobbering); Open opens the project-picker modal;
    // Rename edits the project name (doc.meta.name, which the toolbar shows as
    // the title) — all three delegate to App.svelte modal hooks and share the
    // one name model. The .zip export SAVES TO THE SERVER FIRST (downloadZip
    // does, so the archive reflects the live document) — a server write the old
    // "Download Project" title hid, so the title now states it.
    { id: "rename-presentation", title: "Rename Project…", icon: "mdi:rename-outline", run: (a) => a.renamePresentation() },
    { id: "save-to-server", title: "Save Project to Server…", icon: "mdi:cloud-upload-outline", run: (a) => a.saveProjectAs() },
    { id: "open-project", title: "Open Project from Server…", icon: "mdi:folder-network-outline", run: (a) => a.openProject() },
    { id: "download-zip", title: "Export Project as .zip (with assets; saves to the server first)", icon: "mdi:folder-zip-outline", run: (a) => a.downloadZip() },
    // The INVERSE of download-zip, and titled by the same scheme: Import = from
    // LOCAL DISK, the extension named, "…" because it opens a picker. Its noun is
    // PROJECT (assets included), which is exactly what separates it from
    // load-file's DOCUMENT. Dropping a .zip on the canvas runs the same path.
    { id: "import-zip", title: "Import Project from .zip (with assets; opens it as a new project)…", icon: "mdi:folder-zip", run: (a) => a.importZipFile() },
    // Built-in Assets browser (task #68 follow-up): a SEPARATE surface for
    // ship-with-the-app assets (cursors today) — never mixed into the project
    // Asset Explorer. Discovery only; widgets read built-ins directly.
    // Titled with a VERB like every other entry ("Built-in Assets…" alone was the
    // registry's only verbless title, so it read as a place, not an action).
    { id: "builtin-assets", title: "Browse Built-in Assets…", icon: "mdi:package-variant-closed", run: (a) => a.browseBuiltinAssets() },
    { id: "undo", title: "Undo", icon: "mdi:undo", run: (a) => a.undo() },
    { id: "redo", title: "Redo", icon: "mdi:redo", run: (a) => a.redo() },
    { id: "deselect", title: "Deselect", icon: "mdi:select-off", when: needsSelection, requires: REQUIRES_SELECTION, run: (a) => (a.selection = null) },
    // Select All / Deselect All (manifest Round 12B "Palette / selection
    // commands"): distinct from the single-item "Deselect" above (Escape's
    // existing path — needsSelection, singular semantics unaffected) — these
    // are explicit SET commands, always visible, so they're discoverable via
    // fuzzy search without first knowing something is already selected.
    { id: "select-all", title: "Select All", icon: "mdi:select-all", run: (a) => a.selectAll() },
    { id: "deselect-all", title: "Deselect All", icon: "mdi:select-off", when: needsSelection, requires: REQUIRES_SELECTION, run: (a) => a.deselectAll() },
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
      id: "insert-demo-widget", // id is a stable reference (probes, ShapePicker's sibling); only the TITLE says "Add" — the app's verb (user ruling)
      title: "Add Demo Widget",
      icon: "mdi:flask-outline",
      children: [
        { id: "demo-insert-showcase", title: "Demo Showcase (custom self.* prop)", icon: "mdi:flask", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_showcase")) },
        { id: "demo-insert-video-v2", title: "Video V2 (Skia direct upload)", icon: "mdi:video", run: (a) => a.armCrosshairPlacement(a.registry.get("video_v2")) },
        { id: "demo-insert-glass", title: "Liquid Glass (backdrop refraction shader)", icon: "mdi:blur", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_glass")) },
        { id: "demo-insert-crt", title: "CRT (backdrop material shader)", icon: "mdi:television-classic", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_crt")) },
        { id: "demo-insert-metaball", title: "Metaball (merging water droplets — backdrop material shader)", icon: "mdi:water", run: (a) => a.armCrosshairPlacement(a.registry.get("metaball")) },
        { id: "demo-insert-frosted-glass", title: "Frosted Glass (basic backdrop blur + frost)", icon: "mdi:card-outline", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_frosted_glass")) },
        { id: "demo-insert-magnify", title: "Magnifier (sampler material: circle / square / star lens)", icon: "mdi:magnify-expand", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_magnify")) },
        // TELESCOPIC MAGNIFIER — a rig ASSEMBLED from THREE items wired with `=`
        // equations to a shared tween var `t` (default 0): a source marker, a
        // demo_magnify lens that pulls out + zooms as t→1, and a tangent_lines
        // widget bridging them (the "zoom into this" callout). Two shapeKinds prove
        // the tangent geometry is general (circle + box).
        //
        // PLACED BY GESTURE (#189): "I first click and drag to create the first one
        // and then I click and drag again to create the second one." Box 1 is the
        // region magnified, box 2 is the lens at full pull-out. It arms a CREATION
        // MODE rather than a plain crosshair placement because the rig has no plugin
        // of its own to declare one — see web/telescopicRig.js.
        { id: "demo-insert-telescopic-circle", title: "Telescopic Magnifier — Circle (zoom-callout rig, tween = t)", icon: "mdi:magnify-plus-outline", run: (a) => a.armCrosshairRig("telescopic_rig", { shapeKind: "circle" }) },
        { id: "demo-insert-telescopic-box", title: "Telescopic Magnifier — Box (zoom-callout rig, tween = t)", icon: "mdi:magnify-plus-outline", run: (a) => a.armCrosshairRig("telescopic_rig", { shapeKind: "box" }) },
        // The reusable two-tangent-line widget on its OWN (standalone): draws the
        // external tangents between its two equation-bindable shapes (A, B).
        { id: "add-tangent-lines", title: "Tangent Lines (two external tangents between two shapes)", icon: "mdi:vector-line", run: (a) => a.addItem(a.registry.get("tangent_lines").defaults) },
        { id: "demo-insert-raycast-dither", title: "Raycast Dither (animated grain gradient)", icon: "mdi:gradient-vertical", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_raycast_dither")) },
        { id: "demo-insert-mandelbrot", title: "Mandelbrot (deep-zoom fractal — double-click to explore inside)", icon: "mdi:fingerprint", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_mandelbrot")) },
        // Lens Flare inserts CAMERA-FILLING via addItem (its default x/y/w/h are `=
        // camera.*` equations; the crosshair click-places-default path does arithmetic
        // on defaults.w, which is an equation here — so it must NOT use crosshair).
        { id: "demo-insert-lens-flare", title: "Lens Flare (generative material + presets)", icon: "mdi:flare", run: (a) => a.addItem(a.registry.get("demo_lens_flare").defaults) },
        { id: "demo-insert-rainy-window", title: "Rainy Window (animated backdrop rain-on-glass shader)", icon: "mdi:weather-pouring", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_rainy_window")) },
        // The `sky*` archetype — a physically-based sky family whose members INTERACT
        // (a skySun's position/colour drives the sky's scattering + the clouds' colour,
        // via the derive-time sibling query). Insert `sky` first, then place suns/moon/
        // clouds on top of it.
        { id: "demo-insert-sky", title: "Sky (atmospheric scattering — reads suns/moon)", icon: "mdi:weather-sunny", run: (a) => a.armCrosshairPlacement(a.registry.get("sky")) },
        { id: "demo-insert-sky-sun", title: "Sky Sun (drives the sky's colour — multiple allowed)", icon: "mdi:white-balance-sunny", run: (a) => a.armCrosshairPlacement(a.registry.get("skySun")) },
        { id: "demo-insert-sky-moon", title: "Sky Moon (waxing/waning phases)", icon: "mdi:moon-waning-crescent", run: (a) => a.armCrosshairPlacement(a.registry.get("skyMoon")) },
        { id: "demo-insert-sky-clouds", title: "Sky Clouds (lit by the sun — catch sunset colour)", icon: "mdi:weather-cloudy", run: (a) => a.armCrosshairPlacement(a.registry.get("skyClouds")) },
        { id: "demo-insert-text-dissolve", title: "Text Dissolve (tween word → word)", icon: "mdi:transition", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_text_dissolve")) },
        { id: "demo-insert-text-type", title: "Text Typewriter (reveal by alpha)", icon: "mdi:cursor-text", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_text_type")) },
        { id: "demo-insert-text-scramble", title: "Text Scramble (decode by alpha)", icon: "mdi:shuffle-variant", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_text_scramble")) },
        { id: "demo-insert-corkboard", title: "Corkboard (foreground material shader)", icon: "mdi:bulletin-board", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboard")) },
        { id: "demo-insert-corkboard-note", title: "Corkboard Note (lined, holes, ripped, curl)", icon: "mdi:note-outline", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboardNote")) },
        { id: "demo-insert-corkboard-thumbtack", title: "Corkboard Thumbtack (press-in dome)", icon: "mdi:pin", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboardThumbtack")) },
        { id: "demo-insert-corkboard-yarn", title: "Corkboard Yarn (sagging string)", icon: "mdi:vector-line", run: (a) => a.armCrosshairPlacement(a.registry.get("corkboardYarn")) },
        { id: "demo-insert-magnifier", title: "Magnifier", icon: "mdi:magnify", run: (a) => a.armCrosshairPlacement(a.registry.get("magnifier")) },
        { id: "demo-insert-cursor", title: "macOS Cursor (built-in SVG + animated wait spin)", icon: "mdi:cursor-default-outline", run: (a) => a.armCrosshairPlacement(a.registry.get("cursor")) },
        // A LIVE seven-segment digital clock preset: same clock_digital plugin,
        // but its `time` is pre-bound to the shared `time` identifier (the folded
        // presentation playback clock) so it TICKS during a presentation. The
        // plain "Add Digital Clock" command (palette) drops a static 00:00 the
        // user can set or bind themselves; this preset shows the live use up front.
        { id: "demo-insert-clock-digital", title: "Digital Clock (seven-segment, live = time)", icon: "mdi:clock-digital", run: (a) => { const p = a.registry.get("clock_digital"); a.armCrosshairPlacement({ ...p, defaults: { ...p.defaults, time: "=time" } }); } },
        // Analog clock preset whose TIME is bound to the presentation clock var
        // (`= time`, seconds) — a LIVE clock that ticks in Present mode.
        { id: "demo-insert-clock-live", title: "Analog Clock (live — time = presentation clock)", icon: "mdi:clock-time-four-outline", run: (a) => a.armCrosshairPlacement({ ...a.registry.get("clock_analog"), defaults: { ...a.registry.get("clock_analog").defaults, time: "= time" } }) },
        // PROGRESS BAR — two boxes (track + fill) whose `fraction` (0..1) is
        // equation-bindable. Plain crosshair placement; bind its fraction later.
        { id: "demo-insert-progress-bar", title: "Progress Bar (track + fill; fraction is equation-bindable)", icon: "mdi:gauge", run: (a) => a.armCrosshairPlacement(a.registry.get("progress_bar")) },
        // VIDEO WITH PROGRESS BAR — creates a video SCRUBBER + a progress bar
        // LINKED on creation (bar.fraction = `= @<scrubber>.progress`). Direct
        // multi-item create (not crosshair): the cross-reference needs the runtime id.
        { id: "demo-insert-video-progress", title: "Video with Progress Bar (scrubber + linked bar)", icon: "mdi:video-box", run: (a) => a.insertVideoWithProgressBar() },
        { id: "demo-insert-video-v5", title: "Video V5 (OffscreenCanvas/worker)", icon: "mdi:video", run: (a) => a.armCrosshairPlacement(a.registry.get("video_v5")) },
        // The DETERMINISTIC V5 scrubber: video_scrub.js's scrubTime UX driven
        // through the V5 off-main-thread scrub decoder (videoV5Frame op).
        { id: "demo-insert-video-v5-scrub", title: "Video V5 Scrubber (deterministic scrubTime)", icon: "mdi:video-image", run: (a) => a.armCrosshairPlacement(a.registry.get("video_v5_scrub")) },
        { id: "demo-insert-video-v6", title: "Video V6 (WebGPU external texture)", icon: "mdi:video", run: (a) => a.armCrosshairPlacement(a.registry.get("video_v6")) },
        // VIDEO V7 — a video PLAYER rendered by a PER-WIDGET WebGPU overlay
        // canvas (web/VideoV7Overlay.svelte), zero-copy external texture on a
        // secure context, 2D drawImage fallback on plain HTTP. Rendered OUTSIDE
        // the Skia scene; the scene shows only its deterministic poster.
        { id: "demo-insert-video-v7", title: "Video V7 (WebGPU per-widget canvas)", icon: "mdi:video-vintage", run: (a) => a.armCrosshairPlacement(a.registry.get("video_v7")) },
        { id: "demo-insert-video-v8", title: "Video V8 (WebGPU + WebGL2 fallback)", icon: "mdi:video", run: (a) => a.armCrosshairPlacement(a.registry.get("video_v8")) },
        { id: "demo-insert-comic", title: "Comic Halftone (Ben-Day dots — backdrop material shader)", icon: "mdi:dots-grid", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_comic")) },
        { id: "demo-insert-glitch", title: "Digital Glitch (animated datamosh — backdrop material shader)", icon: "mdi:image-broken-variant", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_glitch")) },
        { id: "demo-insert-brightness-contrast", title: "Brightness / Contrast (tone adjustment — backdrop material shader)", icon: "mdi:brightness-6", run: (a) => a.armCrosshairPlacement(a.registry.get("demo_brightness_contrast")) },
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
      id: "insert-shape", // id is a stable reference (ShapePicker reads this command's children); only the TITLE says "Add"
      title: "Add Shape",
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
    { id: "export-png", title: "Export Slide as PNG", icon: "mdi:image-outline", help: HELP_EXPORT_CAMERA, run: (a) => a.exportPng() },
    { id: "export-pdf", title: "Export Slide as PDF", icon: "mdi:file-pdf-box", help: HELP_EXPORT_CAMERA, run: (a) => a.exportPdf() },
    { id: "export-svg", title: "Export Slide as SVG", icon: "mdi:svg", help: HELP_EXPORT_CAMERA, run: (a) => a.exportSvg() },
    // WHOLE-DECK MP4 (deterministic, client-side). Opens an options modal
    // (resolution/fps/quality/slide range/…); the encode runs there. The title
    // says "All Slides" because the three Export Slide … commands above emit ONE
    // slide and the old "Export as MP4…" gave no way to tell the scopes apart
    // (the modal is where the range gets narrowed, hence the ellipsis).
    // THE RENDER CENTER. Submitting a video is no longer an "export" that this
    // page performs and holds — it is a JOB the server owns, so the command opens
    // the place where jobs are submitted AND where every past and in-flight
    // rendering for this project is listed. It TOGGLES, because it is surfaced as
    // a persistent toolbar button rather than a one-shot menu action.
    { id: "render-center", title: "Render Center (Video)…", icon: "mdi:movie-open-outline", help: "Submit a video render and watch every rendering for this project. A Server job keeps going if you close the dialog, refresh the page, or shut the laptop — come back any time.", run: (a) => a.toggleRenderCenter() },
    { id: "copy-item", title: "Copy Item", icon: "mdi:content-copy", when: needsSelection, requires: "at least one selected widget to copy", help: "Copies TWICE, on purpose: the element itself (as deltas, on the server clipboard) and a rendered PNG onto the system clipboard. Pasting back into PowerRP round-trips the real widget; pasting into another app gets the picture.", run: (a) => a.copySelection() },
    { id: "paste", title: "Paste", icon: "mdi:content-paste", help: "Pastes the ELEMENT back when the system clipboard still holds the PNG this app wrote for it; any other image or file is uploaded and inserted as a new widget instead.", run: (a) => a.pasteClipboard() },
    // 14.9: Duplicate = clone the selection in place (new UUIDs, one undo unit),
    // reusing the copy/paste serialize→insert path locally (no clipboard trip).
    { id: "duplicate", title: "Duplicate", icon: "mdi:content-duplicate", aliases: ["duplicate object", "duplicate widget", "duplicate item", "clone", "copy item"], when: (a) => a.canDuplicate(), requires: "a selected widget that may be duplicated", help: "Each copy gets a NEW id and the SAME raw state, equations verbatim — but a reference INTO the duplicated set is rerouted to the new copy, so duplicating two linked widgets gives you a linked pair, not two widgets pointing at the originals.", run: (a) => a.duplicateSelection() },
    // Copy selection region to the SYSTEM clipboard (manifest Round 12B
    // "Palette / selection commands"): renders the selection's world AABB,
    // not the whole slide (unlike Export Slide as PNG/PDF above). when: selection
    // non-empty — needsSelection is exactly that (a.selection !== null).
    // The titles name SELECTION because that scope difference was invisible:
    // beside "Export Slide as PNG" a bare "Copy as PNG" read as the same picture
    // going somewhere else, when it is in fact a different picture.
    { id: "copy-as-png", title: "Copy Selection as PNG", icon: "mdi:image-multiple-outline", when: needsSelection, requires: REQUIRES_SELECTION, run: (a) => a.copyAsPng() },
    { id: "copy-as-pdf", title: "Copy Selection as PDF", icon: "mdi:file-pdf-box", when: needsSelection, requires: REQUIRES_SELECTION, help: "Vector where it can be: shapes and text stay real PDF geometry (text is still selectable in the pasted result), and only the regions that cannot be expressed as vectors — a blur, a material — go across as raster.", run: (a) => a.copyAsPdf() },
    {
      id: "copy-property",
      title: "Copy Property",
      when: needsSelection,
      requires: REQUIRES_SELECTION,
      help: "Copies ONE property's value — the equation verbatim if it is one — so it can be pasted onto the same property of another widget. The children are the properties the registered widgets actually declare.",
      children: [...new Map(
        app.registry.all().flatMap((p) => (p.inspector ?? []).map((row) => [row.key, row.label])),
      )].map(([key, label]) => ({
        id: `copy-prop-${key}`,
        title: `Copy ${label}`,
        icon: "mdi:content-copy",
        when: (a) => a.selectedNode() && key in a.selectedNode().state,
        requires: "a single selected widget that actually has this property",
        run: (a) => a.copyProperty(key),
      })),
    },
    // EDIT SOURCE IN CODE EDITOR (ROUND 2 #32/#33/#35) — the ONE command that opens
    // the reusable Monaco modal (CodeEditorModal). It is widget-agnostic: it reads
    // the selection's plugin `codeEditor: {property, language, title}` descriptor,
    // so every code-ish widget (mermaid, latex, …) gets the same editor by
    // DECLARING that descriptor and surfacing this command — as a double-click
    // activation (web/widget_handlers.js "code_modal") AND as the Inspector's
    // "</>" action row. `when` gates it to a selection that actually declares one.
    {
      id: "edit-code-source",
      title: "Edit Source in Code Editor",
      icon: "mdi:code-braces",
      when: (a) => !!a.selectedNode()?.plugin?.codeEditor,
      requires: "a selected widget with an editable code source (a Mermaid or LaTeX diagram)",
      help: "Opens the full-screen VS-Code-style editor (syntax highlighting, autocomplete, minimap) on this widget's source, committing your edit as one undo unit.",
      run: (a) => {
        const ce = a.selectedNode()?.plugin?.codeEditor;
        if (ce) a.openCodeModal(a.selection, ce.property, { language: ce.language, title: ce.title });
      },
    },
    // THE PROJECT SCRIPT (core/project_script.js) — the per-document JavaScript
    // library whose exported functions and values every property equation can call.
    // A REGISTRY COMMAND, not a bare toolbar onclick, because that is the rule here:
    // the palette, the keyboard and the toolbar are surfacings of one action layer,
    // and an action that only exists as a button can never be found by search or
    // bound to a key. NO `when` gate: a document always has a script (it may be
    // empty), so this is never unavailable.
    {
      id: "edit-project-script",
      title: "Project Script…",
      icon: "mdi:script-text-outline",
      aliases: ["global script", "project functions", "javascript library", "script editor"],
      help: "One JavaScript file per project. Assign to `exports` and any property equation can call it: `exports.ease = t => t*t` makes `= ease(0.5)` work everywhere. It runs in the same sandbox equations do, so Date and Math.random stay unavailable and `time` and the seeded `random` are the same ones equations see.",
      run: (a) => a.openProjectScript(),
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

  // ── FLIP: the CONTENT reflection (user: "we need flip horizontal and flip vert
  // ── tools in our command palette....and thus the abilitty to have a negative
  // ── height or width") ──────────────────────────────────────────────────────
  // The counterpart to Mirror Layout above, and the thing 16.3's design fork left
  // unbuilt. Mirror Layout reflects where items SIT; Flip reflects what they SHOW.
  // The mechanism is the user's own: negate the size, move the origin to
  // compensate (core/geometry.js flippedBox — see there for why a negative
  // dimension is the correct representation and not a hack, and why there is no
  // rotation term). Composing the two gives the full reflection of an arrangement.
  //
  // WHY NOT ONE COMMAND THAT DOES BOTH: PowerPoint's Flip Horizontal on a
  // multi-selection flips each object where it stands, and Mirror Layout already
  // owns the arrangement half. Keeping them separate means the user can have
  // either alone, and the pair composes — collapsing them would delete a
  // capability. A GROUP is the exception (below): it is ONE object, so flipping it
  // must reflect the whole assembly.

  /**
   * Query. The item ids a flip should write, EXPANDING every selected group into
   * its bbox members.
   *
   * WHY A GROUP EXPANDS. A group is an ARMATURE: its members inherit its
   * {x, y, rotation, scale} similarity through core/derive.applyGroupParenting and
   * explicitly NOT its w/h (web/canvas/dragKinds.js groupResizeState documents
   * this — a group resize drives `scale`, because writing w/h is a no-op on
   * members). A similarity has no handedness, so a group CANNOT transmit a
   * reflection to its members: flipping the group's own box would flip nothing but
   * its ghost outline, and worse, shifting the group's `x` would TRANSLATE every
   * member through the influence. So the flip goes straight to the members and the
   * group's own frame is left untouched — which is also exactly right, because a
   * reflection of the contents leaves the group's hull where it was.
   *
   * Returns {ids, groupIds} — `groupIds` records which groups were expanded, so the
   * caller knows to reflect those members' POSITIONS about the group as well.
   */
  function flipTargetIds(a) {
    const nodes = a.nodes();
    const byId = new Map(nodes.map((n) => [n.itemId, n]));
    const selected = new Set(a.selectedIds());
    const ids = [], groupIds = [], seen = new Set();
    const visit = (node) => {
      if (!node || seen.has(node.itemId)) return; // `seen` also breaks a membership cycle
      seen.add(node.itemId);
      if (node.type === "group" && Array.isArray(node.state.members)) {
        groupIds.push(node.itemId);
        // Flat membership, but a member may itself be a group — recurse so a
        // nested group's members are reached too (groupMembership's own reading).
        for (const id of node.state.members) visit(byId.get(id));
        return;
      }
      if (node.plugin.capabilities.bbox) ids.push(node.itemId);
    };
    for (const n of nodes) if (selected.has(n.itemId)) visit(n);
    return { ids, groupIds };
  }

  /**
   * Pure function. The flip write for ONE item: `flippedBox`, plus the position
   * reflection that turns a set of in-place flips into a reflection of the WHOLE
   * set (used for a group's members; `line` is null for a standalone item, which
   * then flips exactly in place).
   *
   * The two compose cleanly because an in-place flip leaves the box's own center
   * where it was, so reflecting that center about `line` afterwards is a pure
   * translation of the already-flipped origin.
   *
   * @param {object} s - the item's evaluated state (its w/h may already be negative)
   * @param {"x"|"y"} axis
   * @param {number|null} line - the coordinate of the reflection axis, or null for in-place
   * @returns {object} the changed leaves only — {x, w} or {y, h}
   *
   * @example flipWrite({x: 10, y: 0, w: 100, h: 50}, "x", null) // {x: 110, w: -100}
   * @example // reflecting a 100-wide box at x=10 about the line X=200: its center
   * @example // moves from 60 to 340, so the flipped origin 110 shifts by 280:
   * @example flipWrite({x: 10, y: 0, w: 100, h: 50}, "x", 200) // {x: 390, w: -100}
   * @example flipWrite({x: 0, y: 10, w: 50, h: 100}, "y", 200) // {y: 390, h: -100}
   */
  function flipWrite(s, axis, line) {
    const out = flippedBox(s, axis);
    if (line === null) return out;
    const sizeKey = axis === "x" ? "w" : "h";
    const center = (s[axis] ?? 0) + (s.scale ?? 1) * (s[sizeKey] ?? 0) / 2;
    out[axis] += 2 * (line - center);
    return out;
  }

  /**
   * Command (one undo unit, or NO writes at all). FLIP the selection's content
   * along `axis` — the user's "flip horizontal / flip vert" tools.
   *
   * REFUSES LOUDLY on a stored equation. A flip writes BOTH leaves of an axis
   * (size and origin), so if either currently holds an `=` equation the write would
   * silently replace a binding with a literal — a whole class of destroyed work
   * with no undo affordance the user would think to look for. The established
   * answer to "this action would clobber something the user authored" is to refuse
   * entry, report, and change nothing (beginTextEdit and the Mandelbrot interior
   * nav both do exactly this), so that is what happens here, atomically: one
   * blocked item blocks the whole flip rather than leaving half a reflection.
   *
   * The refusal goes through reportAction, NOT reportOnce: reportOnce's dedup set is
   * never cleared, so the SECOND click on Flip printed nothing at all and the tool
   * looked broken rather than refused. A click cannot flood a console — see
   * core/report.js's header for the rule.
   */
  function flip(a, axis) {
    const { raw, evaluated } = documentState(a);
    const sizeKey = axis === "x" ? "w" : "h";
    const { ids, groupIds } = flipTargetIds(a);
    if (ids.length === 0) return;
    const bound = ids.filter((id) => [axis, sizeKey].some((key) =>
      isEquationValue(a.registry.get(raw.items[id].type), [key], raw.items[id][key])));
    if (bound.length > 0) {
      reportAction(
        `PowerRP: Flip ${axis === "x" ? "Horizontal" : "Vertical"} refused — ${bound.length} selected item(s) store an equation on ${axis} or ${sizeKey} (${bound.join(", ")}), and a flip must write both. Nothing was changed. Unbind those properties (or use "Unbind Position & Size") first.`,
      );
      return;
    }
    // A GROUP flips as ONE object, so its members' positions are reflected about
    // the members' own union center too (flipTargetIds explains why the group's own
    // frame is never written). The union is taken in the MEMBERS' stored space,
    // which is the same space their boxes live in — the group's influence is one
    // similarity applied to all of them, so reflecting there and inheriting the
    // influence afterwards yields the correctly reflected assembly, with no need to
    // reason about the group's bind frame.
    const line = groupIds.length > 0
      ? (() => {
        const u = unionRect(ids.map((id) => {
          const s = evaluated.items[id];
          const box = { x: s.x ?? 0, y: s.y ?? 0, w: s.w ?? 0, h: s.h ?? 0 };
          // A negative extent spans backwards; unionRect needs a forward rect.
          return { x: Math.min(box.x, box.x + box.w), y: Math.min(box.y, box.y + box.h), w: Math.abs(box.w), h: Math.abs(box.h) };
        }));
        return axis === "x" ? u.x + u.w / 2 : u.y + u.h / 2;
      })()
      : null;
    let doc = a.doc;
    for (const id of ids) {
      const s = evaluated.items[id];
      const write = flipWrite(s, axis, line);
      // MINIMAL DELTA (the interaction-commit rule): only leaves that actually
      // changed are written, so flipping a zero-width box is a true no-op and never
      // disturbs a stored value.
      for (const [key, value] of Object.entries(write))
        if (value !== (s[key] ?? 0)) doc = keyframed(doc, a.slideIndex, ["items", id, key], value);
    }
    if (doc !== a.doc) a.commit(doc);
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
  // THE entry set, the context predicates and the reachability prober all live in
  // core/shortcut_entries.js — DOM-free, so tests/shortcut_registry_test.js can
  // sweep them from bare node. That move is what makes the convention enforceable
  // rather than aspirational: while they were inline in this component NO node test
  // could see them, and the only guard was the console.error tripwire below — which
  // was itself structurally blind to the multiresize defect it existed to catch,
  // because it walked a HAND-MAINTAINED list of drag kinds. Both the hints and the
  // prober now derive from DRAG_KIND_MODIFIERS.
  //
  // What stays in THIS file is the browser half, and only that:
  //   - creating the keybinding registry and layering localStorage overrides;
  //   - shortcutCtx(): reading live app state AND the focused element into the
  //     context axes;
  //   - the $derived that feeds the HintBar.
  //
  // Command-bound key combos live in core/keybindings.js (an EDITOR setting:
  // defaults in code, user overrides persisted in localStorage). The bridge
  // (toShortcutEntries) turns them into shortcut-registry entries, so EVERYTHING
  // still routes through the command registry (user invariant) and the palette
  // still displays each command's keys automatically.
  const KEYBINDINGS_KEY = "powerrp.keybindings";
  const kb = createKeybindings(KEYBINDING_DEFAULTS);
  const storedOverrides = localStorage.getItem(KEYBINDINGS_KEY);
  if (storedOverrides) kb.loadOverrides(JSON.parse(storedOverrides));
  // Hidden key aliases, display-only pointer/modifier hints, the modal transform's
  // own keys, and the inputs other components dispatch but the registry must still
  // KNOW (present mode, the in-place editors, the palette, a focused numeric field).
  const handEntries = handShortcutEntries({
    app,
    canvasModes: canvasModes(),
    dragKindModifiers: DRAG_KIND_MODIFIERS,
    activations: activations(),
  });

  /**
   * Command (console.error on failure). Reports any registered shortcut entry that
   * is UNSATISFIABLE — no reachable app context makes its `when` true, so it never
   * dispatches and never shows in the HintBar while looking completely alive in the
   * source. That shipped twice before this check existed (both armed-crosshair
   * gesture hints ANDed `editMode` with a state editMode excludes).
   *
   * A DEV TRIPWIRE, deliberately not a throw: bricking the editor at boot over a
   * cosmetic hint defect is worse than the defect. The real gate is
   * tests/shortcut_registry_test.js, which asserts the same property and FAILS —
   * that is what makes this line unreachable in practice. Silent when clean.
   */
  function assertShortcutsReachable(entries) {
    const contexts = hintProbeContexts({
      dragKinds: DRAG_KINDS,
      canvasModeIds: [null, ...canvasModes().map((m) => m.handlerId)],
      canvasModeSteps: canvasModeStepAxis(canvasModes()),
      activationIds: activations().map((a) => a.handlerId),
      app,
    });
    for (const e of unsatisfiableEntries(entries, contexts))
      console.error(`Shortcut "${e.label}" (${e.keys.join("+")}) has an UNSATISFIABLE \`when\` predicate — no reachable app context makes it true, so it can never dispatch and never appears in the HintBar. It most likely ANDs \`editMode\` with a state editMode excludes (an armed crosshair, a widget canvas mode, an open palette, a live modal transform, a typing target, an open dialog); compose it from \`editBase\` / \`armed()\` / \`inCanvasMode()\` instead.`);
  }

  /** Command. (Re)builds the shortcut registry from the keybinding registry +
   * hand entries — also how a rebind takes effect (createShortcuts has no
   * remove; rebuilding is the documented pattern). */
  function wireShortcuts() {
    const shortcuts = createShortcuts();
    const bound = kb.toShortcutEntries(KEYBINDING_LABELS, WHEN_RESOLVERS);
    assertShortcutsReachable([...bound, ...handEntries]); // no invisible shortcuts
    for (const e of bound)
      // Ctrl+V is owned by the native `paste` ClipboardEvent (onPaste), which
      // is the SINGLE Ctrl+V authority so a paste fires exactly once and can
      // read the pasted image to disambiguate our own render from an external
      // one. nativeEvent: keydown dispatch skips it so it never double-fires —
      // the palette still shows the Ctrl+V hint via commandKeys.
      //
      // NOT hidden. It used to be, on a "pre-existing lean-bar choice" that was a
      // description rather than a reason: Copy sat on the bar and Paste did not,
      // for one of the two halves of the same gesture. Paste is not an ALIAS of
      // any visible chip (the rule Space/Delete follow) and it genuinely fires,
      // so the bar shows it. Being dispatched by a different DOM event than
      // keydown is an implementation detail the user cannot see.
      shortcuts.add(e.command === "paste" ? { ...e, nativeEvent: true } : e);
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

  // ── THE FOCUS TRACKER ──────────────────────────────────────────────────────
  // The DOM's focus is not reactive, so the shortcut context cannot read
  // document.activeElement directly — a $derived would never invalidate. This
  // mirrors the ONE fact the registry needs ("what does the focused element own?")
  // into $state on focusin/focusout, which is the same shape CanvasView's modifier
  // trackers use for held keys: an event pair feeding reactive state.
  //
  // Read-only on the DOM and it edits nothing: the two shared-lib controls it
  // classifies (DraggableNumber, Modal) are identified by the ARIA/role they
  // ALREADY publish, so no component had to learn about the registry.
  const NO_FOCUS_CONTEXT = { typing: false, dialog: false, numericField: null, numericFieldBounded: false, fieldScope: null, popoverKind: null };
  /**
   * Pure function. What the focused element owns, as the shortcut context's focus
   * axes. `el` is null when nothing is focused.
   *
   * numericField: "scrubber" is lib/DraggableNumber (role="spinbutton" — the only
   * one in the app) and "dial" is AngleField's rotary knob (.angle-dial; the role
   * alone would also catch ColorPicker's handles, which read no modifier).
   * numericFieldBounded is whether Home/End have anywhere to jump: DraggableNumber
   * publishes aria-valuemin/max ONLY when it was given a min and a max, which is
   * exactly when its Home/End branches do anything.
   *
   * fieldScope / popoverKind are THE HINTBAR COMPLETENESS LAW's two new focus axes
   * (item 61), the direct generalization of numericField from two hardcoded kinds to
   * arbitrary DECLARED ones. A committable field (a rename box, an equation entry, a
   * property row) publishes `data-hint-scope="rename"|"commit"|…`, and an open
   * popover/menu/combobox publishes `data-hint-popover="menu"|"combobox"|…`, on an
   * ancestor of whatever they focus. Reading them here — off the ALREADY-focused
   * element, the DraggableNumber precedent — is what lets the registry announce their
   * Enter/Escape verbs (which used to be the sweep's chipless "LOCAL" drift) without
   * any component learning about the registry.
   *
   * @example // focusContext(null) → {typing: false, dialog: false, numericField: null, numericFieldBounded: false, fieldScope: null, popoverKind: null}
   * @example // focusContext(<input>) → {typing: true, dialog: false, …}
   * @example // focusContext(<div role="spinbutton" aria-valuemin="0" aria-valuemax="1">)
   * @example // → {typing: false, dialog: false, numericField: "scrubber", numericFieldBounded: true, …}
   * @example // focusContext(<input data-hint-scope="rename">) → {…, fieldScope: "rename"}
   */
  function focusContext(el) {
    if (!el || !el.closest) return NO_FOCUS_CONTEXT;
    const scrubber = el.closest('[role="spinbutton"]');
    return {
      typing: isTypingTarget(el),
      // A lib/Modal.svelte dialog traps focus inside its panel for as long as it is
      // open, so "focus is inside a dialog" and "a dialog owns the screen" are the
      // same condition — and it is the condition under which the dialog's own
      // window keydown listener claims keys.
      dialog: !!el.closest('[role="dialog"]'),
      numericField: scrubber ? "scrubber" : el.closest(".angle-dial") ? "dial" : null,
      numericFieldBounded: !!scrubber?.hasAttribute("aria-valuemin") && !!scrubber?.hasAttribute("aria-valuemax"),
      // The two item-61 axes. A closest() up the tree, exactly like the dialog and
      // spinbutton reads above: the field/popover marks an ancestor of what it
      // focuses, so a focus INSIDE it resolves the scope. Nothing focused ⇒ null.
      fieldScope: el.closest("[data-hint-scope]")?.dataset.hintScope ?? null,
      popoverKind: el.closest("[data-hint-popover]")?.dataset.hintPopover ?? null,
    };
  }
  let focus = $state(NO_FOCUS_CONTEXT);
  /** Command. Mirrors the newly-focused element into `focus`. focusout carries the
   * INCOMING element in relatedTarget (null when focus leaves for nothing), which
   * document.activeElement does not yet reflect at that point. */
  function onFocusIn() {
    focus = focusContext(document.activeElement);
  }
  function onFocusOut(e) {
    focus = focusContext(e.relatedTarget);
  }
  // A popover that KEEPS focus on its trigger (ShapePicker, ColorField, lib/Dropdown)
  // toggles its data-hint-popover attribute AFTER the click that opened it, with NO
  // focus change — so onFocusIn never re-reads it, and the "Close" chip would never
  // appear. Re-derive the focus context whenever a hint-scope/hint-popover attribute
  // appears or disappears anywhere in the tree, so the bar picks up a popover the
  // instant it opens (and drops it when it closes) while activeElement.closest still
  // gives innermost-wins for the autofocus popovers (a search box's own scope beats
  // the enclosing menu's). Runes-only lifecycle: one observer for the component's life.
  $effect(() => {
    const obs = new MutationObserver(() => { focus = focusContext(document.activeElement); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-hint-popover", "data-hint-scope"], subtree: true });
    return () => obs.disconnect();
  });

  function shortcutCtx() {
    return {
      mode: app.mode,
      paletteOpen: app.paletteOpen,
      hasSelection: app.selection !== null,
      // The INNER selection scope (app.svelte.js handleSelection): are any of the
      // selected widget's MODIFIER POINTS selected? A contested key (Backspace,
      // Escape) then means the point operation, not the item one — the item entries
      // exclude this flag and the handle entries require it, so exactly one meaning
      // and exactly one chip is ever live (core/shortcut_entries.js editSelection /
      // handlesSelected).
      handlesSelected: app.handleSelection.length > 0,
      dragging: app.dragging,
      dragKind: app.dragKind,
      // The ARMED crosshair's kind ("band"|"place"), or null — both a truthy
      // "is anything armed" check (editMode's !c.crosshairArmed) and a per-skin
      // discriminator (the two pointer hints) from one field.
      crosshairArmed: app.crosshair?.kind ?? null,
      // The live WIDGET CANVAS MODE's handler id, or null (web/widget_handlers.js).
      // Same two-jobs-one-field shape as crosshairArmed: a truthy "is a widget
      // holding the canvas" check (editMode excludes it, so ordinary editor keys
      // go quiet during a takeover — the modal-transform precedent) AND the
      // per-mode discriminator inCanvasMode() scopes each mode's own hints with.
      canvasMode: app.canvasMode?.handlerId ?? null,
      // WHICH STEP of a multi-step creation mode is current (0 for a mode with no
      // sequence). What makes the bar narrate "drag the region to magnify" and then
      // "now drag where the magnified view goes" off ONE mechanism — see
      // core/shortcut_entries.js inCanvasStep.
      canvasModeStep: app.canvasMode?.step ?? 0,
      // WHAT A DOUBLE-CLICK ON THE SELECTED WIDGET WOULD DO: the ACTIVATE handler
      // id its plugin declares (web/widget_handlers.js), or null for a widget with
      // no activation — a rect. The crosshairArmed shape again: one field serving
      // as both "is there anything to announce" and the per-handler discriminator
      // core/shortcut_entries.js `activatable` scopes each activation's chip with.
      // Resolved from the plugin's declaration, so it is the SAME resolution
      // CanvasView's onDblClick performs to run the behaviour.
      activation: handlerFor("activate", app.selectedNode()?.plugin ?? {})?.id ?? null,
      modalActive: app.modalXform !== null, // a live G/S transform locks input (Blender modal)
      snapEngaged: app.snapEngaged, // manifest ARCHITECTURE PLAN #4: a drag has an active snap CORRECTION (what the guides and the toolbar tint read)
      // ...and whether that correction is one the A release can actually BIND. The two
      // are not the same, which is the defect: applyResizeSnap raises snapEngaged from
      // its SIZE-MATCH branch alone, and size-match is DELIBERATELY out of anchor snap's
      // v1 scope (manifest ARCHITECTURE PLAN #4: "skip size-match snaps"), so the "A —
      // Anchor snap" chip lit up on a snap where holding A does nothing at all. This
      // field comes from the SAME provenance the release path reads, so the offer and
      // the action cannot disagree.
      snapBindable: app.snapBindable,
      // ── THE FOCUS AXES ────────────────────────────────────────────────────
      // What the FOCUSED ELEMENT owns, mirrored out of the DOM by the focus
      // tracker below. These exist because onKeydown suppresses dispatch on a
      // typing target and lib/Modal.svelte claims keys while a dialog is up — and
      // for a long time NOTHING told the registry that, so the bar advertised 26
      // chips during inline text editing of which 6 were real (pressing B or P
      // provably no-opped) and kept every canvas chip up behind a modal dialog.
      // editBase excludes both, so one lever fixes the hints and the `when`
      // guards together.
      typingTarget: focus.typing,
      dialogOpen: focus.dialog,
      // ── THE ITEM-61 FOCUS AXES ──────────────────────────────────────────────
      // A focused COMMITTABLE FIELD's declared scope ("rename"|"commit"|…), or null:
      // the generalization of numericField, feeding the Enter/Escape chips that used
      // to be the sweep's chipless LOCAL entries (core/shortcut_entries.js fieldScope).
      fieldScope: focus.fieldScope,
      // An OPEN popover/menu/combobox's kind ("menu"|"combobox"|…), or null, and the
      // truthy "is a popover holding the keyboard" flag derived from it. Like a dialog,
      // a popover is a TAKEOVER: editorInput excludes it, so the canvas chips stand
      // down and the popover's own Esc/nav chips show instead (core/shortcut_entries.js
      // popover / SUPPRESSED_AXES).
      popoverKind: focus.popoverKind,
      popoverOpen: focus.popoverKind !== null,
      // A focused numeric field, by KIND ("scrubber" = lib/DraggableNumber,
      // "dial" = web/AngleField) or null — the crosshairArmed shape again, because
      // the two read Shift OPPOSITE ways (finer vs coarser) and one averaged chip
      // would be wrong for one of them.
      numericField: focus.numericField,
      numericFieldBounded: focus.numericFieldBounded,
      // WYSIWYG rich-text editing (Round 13.4): true while a text box is being
      // edited in place — gates the format-shortcut HINTS (Cmd+B/I/U, Cmd+=/-)
      // whose actual keys TextEditController handles (a focused contentEditable is
      // a typing target, so onKeydown early-returns and these entries are
      // DISPLAY-ONLY, like the modifier/A-key hints).
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
    app.mode; app.paletteOpen; app.selection; app.dragging; app.dragKind; app.crosshair; app.modalXform; app.snapEngaged; app.snapBindable; app.textEditing; app.latexEditing; app.codeEditing; app.canvasMode; focus;
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

  /**
   * Command. THE keydown entry point: hands the event to the registry.
   *
   * The three early returns are the DISPATCH-SIDE statement of "something else owns
   * the keyboard", and core/shortcut_entries.js `editorInput` is the HINT-SIDE
   * statement of the same three facts. They must stay mirrored — that is what makes
   * the bar honest, since a chip is then shown iff the key can fire, and
   * tests/shortcut_registry_test.js asserts it (no entry with a run/command may be
   * live in a context listed in SUPPRESSED_AXES). Keeping both is deliberate belt
   * and braces: the guard here also covers the modal transform's entries, which
   * descend from editorInput but not from editBase.
   */
  function onKeydown(e) {
    if (isTypingTarget(document.activeElement)) return;
    if (app.mode === "present") return; // PresentMode owns its keys
    if (app.paletteOpen) return; // palette owns its keys
    if (app.shortcuts.dispatch(e, shortcutCtx())) e.preventDefault();
  }

  /**
   * Command. THE Ctrl+V handler — the single paste authority (the keydown
   * binding is nativeEvent, so it does NOT also fire). Rides the native `paste`
   * ClipboardEvent because only that event exposes the pasted image bytes,
   * which the either/or decision needs. Hands the OS-clipboard Files to
   * app.pasteFromClipboard, which decides between pasting our own copied
   * ELEMENT (image signature matches the internal payload) and pasting an
   * EXTERNAL image/video as a new widget, and falls back to the internal
   * element/property paste when the OS clipboard carries no files. Guarded
   * identically to onKeydown (skip while typing/present/palette-open).
   */
  function onPaste(e) {
    if (isTypingTarget(document.activeElement)) return;
    if (app.mode === "present" || app.paletteOpen) return;
    e.preventDefault();
    app.pasteFromClipboard([...(e.clipboardData?.files ?? [])]);
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  onpaste={onPaste}
  onpointerdowncapture={onPointerDownCapture}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
/>

<!-- --a-label-frac rides the APP ROOT, not either panel: the Property Panel and
     the Variables Panel are separate subtrees in separate panes, and the
     round-11 ruling is that their columns LINE UP. One variable on their nearest
     common ancestor is what makes that structural instead of a coincidence two
     independent drags would have to keep re-establishing. -->
<div class="app" style:--a-label-frac={app.labelFrac}>
  <Toolbar {app} {renderBadge} />
  <!-- Only renders when there is NO backend: says so, names the server-only
       features that are unavailable, and offers persistent storage. -->
  <StaticModeNotice {app} />
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
                  <Panel {app} name="Tools">
                    <ToolsPane {app} />
                  </Panel>
                {:else if row === 2}
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
  <!-- Open Project from Server: a PREVIEW GRID of saved projects (the "load from
       server" browser). One card per project — a first-slide thumbnail (rendered
       client-side, streamed in) + name + slide-count/relative-mtime meta. Click a
       card to load it (same path as before). Empty/loading/error are captions. -->
  <!-- size="large" is REQUIRED, not decoration: the card grid is
       repeat(auto-fill, minmax(…, 1fr)), which resolves to ONE column under the
       content-sized default. -->
  <Modal bind:open={openModalVisible} title="Open Project from Server" size="large">
    {#if openError}
      <div class="open-project-error">{openError}</div>
    {:else if openProjects === null}
      <div class="open-project-empty">Loading projects…</div>
    {:else if openProjects.length === 0}
      <div class="open-project-empty">No projects saved on the server yet — use "Save Project to Server" first.</div>
    {:else}
      <ul class="open-project-grid">
        {#each openProjects as p (p.name)}
          {@const preview = openPreviews[p.name]}
          <li>
            <!-- The card name is ellipsized by the grid track, so the full name
                 lives in the hover tip (our immediate Tooltip; native title= is
                 banned in app chrome — manifest). -->
            <Tooltip text={p.name}>
              <button type="button" class="open-project-card" onclick={() => pickProject(p.name)}>
                <span class="open-project-thumb" class:is-empty={!preview || preview.status !== "ready"}>
                  {#if preview?.status === "ready"}
                    <img src={preview.src} alt={`Preview of ${p.name}`} loading="lazy" />
                  {:else if preview?.status === "failed"}
                    <iconify-icon class="open-project-thumb-icon" icon="mdi:image-broken-variant" width="1.6em" height="1.6em"></iconify-icon>
                  {:else}
                    <iconify-icon class="open-project-thumb-icon" icon="mdi:image-outline" width="1.6em" height="1.6em"></iconify-icon>
                  {/if}
                </span>
                <span class="open-project-card-name">{p.name}</span>
                <span class="open-project-card-meta">{projectMetaLine(p, openNowMs)}</span>
              </button>
            </Tooltip>
          </li>
        {/each}
      </ul>
    {/if}
  </Modal>
  <!-- Save Project to Server: a NAME chooser with conflict/overwrite protection.
       Shares the one name model (doc.meta.name) with the title and Open. -->
  <Modal bind:open={saveModalVisible} title="Save Project to Server" size="compact">
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
  <!-- Rename Project: writes doc.meta.name — which IS the project name (manifest
       Round 12) and what the toolbar shows as the title. Opened by the title's
       double-click and the "Rename Project…" command. -->
  <Modal bind:open={renameModalVisible} title="Rename Project" size="compact">
    <form class="name-modal" onsubmit={(e) => { e.preventDefault(); confirmRename(); }}>
      <label class="name-modal-field">
        <!-- Same field label as the Save modal's, because it is the same string:
             doc.meta.name. It used to say "Presentation name" here and "Project
             name" there for one value — the three-nouns bug in miniature. -->
        <span class="name-modal-label">Project name</span>
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
  <!-- Import a .zip: the RESULT. Only opens when the outcome differs from what
       the user asked for — a collision rename, or a refusal. See showImportResult. -->
  <Modal bind:open={importResultVisible} title={importResult?.ok ? "Imported as a New Project" : "Import Failed"} size="compact">
    <div class="name-modal">
      {#if importResult?.ok}
        <div class="name-modal-note">
          A project named “{importResult.requested}” already exists on the server, and an import never overwrites one.
          This archive was opened as “{importResult.name}”.
        </div>
      {:else}
        <!-- .name-modal-warning is the existing LOUD line of these dialogs (the
             Save modal's clobber warning) — the refusal reuses it, no new color. -->
        <div class="name-modal-warning">
          “{importResult?.requested}” was not imported: {importResult?.error}
        </div>
        <div class="name-modal-note">Nothing was changed — the open project is untouched.</div>
      {/if}
      <div class="name-modal-actions">
        <button type="button" class="btn" onclick={() => (importResultVisible = false)}>OK</button>
      </div>
    </div>
  </Modal>
  <!-- Built-in Assets browser: a SEPARATE, discovery-only surface for ship-with-
       the-app assets (cursors today). Distinct from the project Asset Explorer —
       built-ins never appear in the user's project asset list. -->
  <Modal bind:open={builtinAssetsVisible} title="Built-in Assets">
    <BuiltinAssetBrowser {app} />
  </Modal>
  <!-- Arrange-into-Grid picker: the Office "Insert Table" sweep selector. The
       Modal owns the overlay (backdrop/Escape/click-away/focus); GridSizePicker
       owns the sweep. Confirming runs the one-undo-unit bento arrange. -->
  <Modal bind:open={gridPickerVisible} title="Arrange into Grid" size="compact">
    <GridSizePicker itemCount={gridPickerCount} onconfirm={confirmGrid} />
  </Modal>
  <!-- RENDER CENTER — submit on the left, this project's renderings on the right.
       A submitted job belongs to the SERVER, so closing this dialog (or the tab)
       does not touch it; reopening re-reads the same truth from the backend.
       SIZE "large" = the shared 90%-of-viewport dialog (src/lib/Modal.svelte's
       one definition of that geometry, the same one Open Project and the asset
       picker ask for). Two panes side by side plus a list of video rows has no
       usable intrinsic width, so the default content-sized "auto" shrink-wrapped
       it into a column — the case Modal's header already names as the reason
       "large" exists.
       titleIcon comes from the REGISTRY ENTRY the toolbar button reads, so the
       clapperboard in the header and the clapperboard on the button are one
       string in one place (App.svelte's "render-center" entry) — the same rule
       Toolbar.svelte follows for every glyph it draws. -->
  <Modal
    bind:open={renderCenterVisible}
    title="Render Center"
    titleIcon={app.commands.get("render-center").icon}
    size="large"
  >
    {#if renderCenterVisible}
      <RenderCenterModal {app} />
    {/if}
  </Modal>

  <!-- THE reusable Monaco code editor (ROUND 2 #32/#33). Mounted off app.codeModal
       so any surface (a mermaid/latex double-click, the Inspector "</>" action
       row → edit-code-source, or the toolbar's PROJECT SCRIPT icon) opens the SAME
       editor. `value` is seeded ONCE from app.codeModalValue() — the one place that
       maps the modal's target to its stored source, so an item leaf and a doc.meta
       field are read the same way; the editor owns its buffer after that. Save
       commits ONE undo unit (app.commitCodeModal); cancel drops it. -->
  {#if app.codeModal}
    <CodeEditorModal
      value={app.codeModalValue()}
      language={app.codeModal.language}
      title={app.codeModal.title}
      onsave={(text) => app.commitCodeModal(text)}
      oncancel={() => app.closeCodeModal()}
    />
  {/if}
</div>
