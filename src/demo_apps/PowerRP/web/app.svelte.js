/**
 * PowerRPApp — the headless application state (Svelte 5 runes class, same
 * pattern as src/lib/player.svelte.js). Owns the document + undo log +
 * selection + registries, and is the `app` facade that ALL commands receive:
 * palette entries, keyboard shortcuts, toolbar buttons, and (future) context
 * menus are different surfacings of the ONE command registry.
 */

import {
  newDocument, foldState, keyframed, unkeyframed, hasKeyframe, keyframeIndices,
  uuid, clonedItemStates,
  withNewItem, withItemPurged, withNewSlide, withSlideDeleted, withSlideMoved,
  withSlideToggled, withNormalizedZ, bisectedZ, blockZToExtreme, serialize, deserialize,
  repairedDocument, printRepairReports, itemFallbackName, ungroupBakeSlides,
  itemAnimationKeyframes, lostEquationKeyframes, withKeyframesFrozen,
} from "../core/document.js";
import { setPath, getPath, blendApplied } from "../core/deltas.js";
import { unionRect } from "../core/geometry.js";
// Arrange-into-Grid (bento) layout math — DOM-free, doctested in core/grid.js.
import { gridAssign, cellCenters, effectiveRows } from "../core/grid.js";
import { resolveTransition, retypedTransition } from "../core/transitions.js";
import { deriveRenderTree, cameraRect, groupMembership, stateXYForCenterPivotWorld, nodeModifierPoints } from "../core/derive.js";
// The LIST-ELEMENT operations the HANDLE actions route through — one mechanism for
// per-element hide and purge, shared with the Inspector's list control.
import { LIST_ROW_KIND, withElementActive, withElementPurged } from "../core/lists.js";
import { evaluateState, withVariableRenamed, anchorRefName, isEquationValue } from "../core/expressions.js";
import { dedupeGroupSelection } from "../core/bandselect.js";
import { rotatedBBoxAABB, effectInclusiveAABB, fitRectView, effectiveDpr } from "../core/view.js";
import { bundleDefaults } from "../core/properties.js";
import { sceneIR } from "../render_gpu/ports.js";
import { renderCameraFrame, rasterizeIrPng } from "./gpuService.js";
import { imageSignature } from "./clipboard.js"; // canvas-clipboard disambiguation signature
import * as projectApi from "./projectApi.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { createShortcuts } from "../core/shortcuts.js";
import { DRAG_KINDS } from "./canvas/dragKinds.js"; // the dragKind setter's allowlist
import { createUndo } from "../core/undo.js";
import { registerAll } from "../plugins/index.js";
import { imagePlugin } from "../plugins/image.js"; // insertImageAsset reuses its defaults
import { videoPlugin } from "../plugins/video.js"; // insertVideoAsset reuses its defaults
// Telescopic-magnifier rig: the pure equation-override builders + rig constants.
// The command below spreads these over the registry defaults to mint 3 wired items.
import {
  TELESCOPIC, telescopicDefaultRects,
  telescopicSourceOverrides, telescopicLensOverrides, telescopicTangentOverrides,
} from "../plugins/tangent_lines.js";
import { browserSetting } from "./settings.js";
// Fonts-as-asset seam (#26): register an uploaded font file as a SELECTABLE
// family (render_gpu/fonts.js dynamic registry) + load it into the browser.
import { registerFontFamily, clearDynamicFonts, fontAssetId, fontDescriptor } from "../render_gpu/fonts.js";
import { loadDynamicFont } from "./fontLoader.js";
// Asset thumbnail generalization (#25): pure tile-presentation + page-count badge.
import { assetTilePresentation, pageCountBadge } from "./assetThumbnail.js";

const AUTOSAVE_KEY = "powerrp.autosave";
const THEME_KEY = "powerrp.theme";
const BAND_MODE_KEY = "powerrp.bandMode";

// The source id a LEGACY one-item clipboard payload ({powerrp_item: state} — no
// id, from before the selection became the copy unit) is normalized under, so
// the current {sourceId: state} insert path handles it unchanged. Deliberately
// not id-shaped: uuid() ids are 8 chars, so no equation can reference it and its
// clone's own references are therefore all EXTERNAL, which is exactly right —
// the payload never said which item it came from.
const LEGACY_CLIPBOARD_SOURCE_ID = "legacy-clipboard-payload";

// Retina/HiDPI is CAMERA-ONLY (the scene-global "Rendering" bundle on THE
// camera — core/properties.js). There is deliberately NO browser-level retina
// setting: the camera prop is the single source of truth (app.dpr() reads it).
// This default only backstops app.dpr()'s degenerate-doc path (no active
// camera); sourcing it from the shared registry keeps it from drifting from
// the Inspector's Rendering → Retina default.
const CAMERA_RETINA_DEFAULT = bundleDefaults("rendering").retina;

// THE settings repo (manifest "SETTINGS TAXONOMY"): every boolean BROWSER
// setting declared ONCE here (key + default), consumed by a $state field
// (`.initial`) + a toggle method (`.persist`) below. Adding a setting = one
// line here + a field + a toggle, never four scattered edits (cruft audit).
const SETTINGS = {
  minimap: browserSetting("powerrp.minimap", true),
  panelNames: browserSetting("powerrp.panelNames", false),
  snap: browserSetting("powerrp.snap", true),
  snapSize: browserSetting("powerrp.snapSize", true),
  grid: browserSetting("powerrp.grid", false),
  ruler: browserSetting("powerrp.ruler", false),
  showGhosts: browserSetting("powerrp.showGhosts", false),
  fps: browserSetting("powerrp.fps", false),
};

/** Theme catalog — viewer preference (localStorage), NOT document state.
 * Each id matches a `:root[data-theme="…"]` block in app.css. (14.11: five
 * new moods appended — sepia paper light, high-contrast slate dark, a
 * Nord-inspired cool dark, a gruvbox-inspired warm dark, and a saturated
 * "aurora" dark — each a full token override, see app.css for the palette.) */
export const THEMES = [
  { id: "graphite", title: "Graphite (dark)" },
  { id: "light", title: "Light" },
  { id: "black", title: "Pure Black" },
  { id: "warm", title: "Warm Gray (dark)" },
  { id: "sepia", title: "Sepia" },
  { id: "slate", title: "Slate" },
  { id: "nord", title: "Nord" },
  { id: "gruvbox", title: "Gruvbox" },
  { id: "aurora", title: "Aurora" },
  // Colorful set (user: "make some more colorful color themes") — six beloved
  // editor palettes; full token overrides live in app.css alongside the others.
  { id: "dracula", title: "Dracula" },
  { id: "tokyonight", title: "Tokyo Night" },
  { id: "catppuccin", title: "Catppuccin Mocha" },
  { id: "rosepine", title: "Rosé Pine" },
  { id: "monokai", title: "Monokai" },
  { id: "synthwave", title: "Synthwave '84" },
];

/**
 * Pure function. Asset kind of a File/Blob by MIME prefix — the paste-to-
 * upload twin of CanvasView's OS-file-drop `fileKind` (same MIME-prefix
 * convention, kept as a small local duplicate rather than a cross-file
 * import: neither file exports it, and this one is one line).
 *
 * Args:
 *     file (File|Blob): a clipboard or drop file, read via its `.type`.
 *
 * Returns:
 *     "image" | "video" | "sound" | "pdf" | "font" | "other"
 *
 * PDF and FONT have unreliable/empty MIME types across browsers, so they fall
 * back to the filename extension (matching the server's asset_kind classes).
 * This only picks the OPTIMISTIC upload tile's icon; the server list is the
 * source of truth for the settled kind.
 *
 * Examples:
 *     >>> assetKindForFile({type: "image/png", name: "a.png"})
 *     'image'
 *     >>> assetKindForFile({type: "video/quicktime", name: "clip.mov"})
 *     'video'
 *     >>> assetKindForFile({type: "", name: "paper.pdf"})
 *     'pdf'
 *     >>> assetKindForFile({type: "", name: "Handwriting.ttf"})
 *     'font'
 */
function assetKindForFile(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "sound";
  const ext = (file.name ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (["ttf", "otf", "woff", "woff2"].includes(ext)) return "font";
  return "other";
}

export class PowerRPApp {
  doc = $state(newDocument());
  // [ROUND 15.2] Backed by a private $state through an accessor (mirrors the
  // `selection` accessor immediately below) so that ANY slide switch (~13
  // write sites: SlideNav, KeyframePanel "Go To", jumpKeyframePath, addSlide/
  // addBlankSlide/deleteSlide/moveSlide, the palette+shortcut prev/next-slide
  // commands, loadFile/clearDoc/openProject) exits WYSIWYG text edit first —
  // a slide switch mid-edit must never strand the overlay (manifest 15.2:
  // "selection change via other UI ... must all commit ... never strand the
  // overlay"). Dismisses through the SAME dismissTextEdit() the click-away
  // and selection-change guards use, so all three share one commit/cancel
  // decision (see dismissTextEdit's doc).
  #slideIndex = $state(0);
  get slideIndex() {
    return this.#slideIndex;
  }
  set slideIndex(i) {
    this.dismissEdit();
    this.exitCanvasMode(); // a widget canvas mode is bound to an item on THIS slide
    this.#slideIndex = i;
  }
  // PRIMARY selection — a single itemId or null. Kept as the primary for full
  // single-select compatibility: selectedNode(), delete/purge/copy/rename/
  // reorder/keyframe, the Inspector's single-item UI, the KeyframePanel
  // highlight, and needsSelection/needsPurgeable all read THIS. Backed by a
  // private $state through an accessor so that ANY single-select write
  // (`app.selection = x`, of which there are ~10 sites) automatically CLEARS
  // the multi-select override below — that one coupling is what keeps the two
  // coherent with zero edits to the existing write sites (least-invasive
  // design; the manifest's multi-select is a minimal SUBSTRATE, not a rewrite).
  #selection = $state(null);
  get selection() {
    return this.#selection;
  }
  set selection(id) {
    // [ROUND 15.2] A selection change to a DIFFERENT item than the one being
    // edited must commit+exit text edit first (manifest: "selection change
    // via other UI (outline panel etc.) ... must all commit ... never strand
    // the overlay"). Excludes the id === textEditing.itemId case on purpose:
    // beginTextEdit() itself writes `this.selection = itemId` to select the
    // item it is about to edit, and that write must NOT immediately cancel
    // the edit it is starting.
    if (this.editingItemId !== null && id !== this.editingItemId) this.dismissEdit();
    // Same rule for a widget CANVAS MODE (web/widget_handlers.js): selecting a
    // different item leaves the mode (committing its pending gesture), so the mode
    // can never outlive the item it belongs to. The handler's own `run` writes
    // `selection = itemId` BEFORE entering, when canvasMode is still null, so this
    // never cancels the mode it is about to start.
    if (this.canvasMode !== null && id !== this.canvasMode.itemId) this.exitCanvasMode();
    this.#selection = id;
    this.selectionSet = []; // single-select write drops the multi override
    // The OUTER scope owns the INNER one: handle ids belong to whichever item was
    // selected, so any item-selection change invalidates them (see handleSelection).
    this.handleSelection = [];
    if (id !== null) this.selectedTransition = null; // item and transition selection are mutually exclusive
  }
  // MULTI-select override: the FULL set of selected itemIds (band select /
  // future multi-click). Authoritative when non-empty; its FIRST element is
  // mirrored into `selection` (the primary) so single-item consumers still
  // work. Empty → selectedIds() falls back to [selection]. Populated only by
  // selectMany(); cleared by any single-select `selection` write (see above).
  selectionSet = $state([]);
  // HANDLE SELECTION — the SECOND, INNER selection scope: which of the primary
  // selected item's MODIFIER POINTS (core/derive.nodeModifierPoints — "the PPT
  // yellow squares") are selected, as an array of modifier ids. Universal, not
  // polygon-specific: every widget that declares `modifierPoints` gets it.
  //
  // THE PRECEDENCE BETWEEN THE TWO SCOPES (the design's sharpest edge, stated once
  // here so no surface has to guess):
  //   1. ITEM selection is the OUTER scope and OWNS the inner one. Handles only
  //      exist for a single selected item (CanvasView draws them only then), so a
  //      selection change of any kind invalidates them — every write to
  //      `selection`/selectMany clears this, via clearHandleSelection().
  //   2. THE INNER SCOPE WINS A CONTESTED KEY. While handles are selected, Escape
  //      clears THEM and leaves the item selected; Backspace hides THEM, not the
  //      item. Both are enforced in core/shortcut_entries.js by `when` predicates
  //      (handlesSelected vs the item entries' exclusion of it) rather than by
  //      ordering, so exactly one meaning is ever live — and therefore exactly one
  //      chip is ever on the HintBar, which is what makes the bar honest.
  //   3. NOTHING here touches the item selection. Clearing handles never deselects
  //      the item; that would make Escape destroy two things at once.
  handleSelection = $state([]);
  // TRANSITION selection — the INCOMING slide's slideId whose between-rows
  // transition slice is selected, or null (manifest Round 12: transitions are
  // first-class SELECTABLE things whose properties show in the Property Panel).
  // MUTUALLY EXCLUSIVE with item selection: setting a transition clears the item
  // selection (via selectTransition); setting an item clears this (setter above).
  // Opus10 builds the Inspector side against selectionTarget/transitionAt.
  selectedTransition = $state(null);
  mode = $state("edit"); // "edit" | "present"
  anchorsVisible = $state(false);
  paletteOpen = $state(false);
  dragging = $state(false); // canvas sets this; drives HintBar context
  // Which drag gesture is live: null, or one of DRAG_KINDS (web/canvas/
  // dragKinds.js) — drives the HintBar's per-gesture modifier hints (manifest
  // "Drag/resize modifiers": auto-announce while dragging) AND the shortcut
  // registry's per-gesture contexts.
  //
  // Backed by an accessor that THROWS on an undeclared kind, the same
  // private-$state-behind-a-setter shape #slideIndex/#selection use. WHY: the
  // hint set and the reachability prober are both DERIVED from DRAG_KIND_MODIFIERS,
  // so a kind that is assigned here but missing there gets no modifier chips and
  // is never probed — which is exactly how multi-selection resize shipped reading
  // Shift/Cmd with nothing on the bar and no test able to see it. Failing loudly
  // at the assignment makes that state unreachable: you cannot introduce a drag
  // kind without declaring it, and declaring it wires the hints and the guard.
  #dragKind = $state(null);
  get dragKind() {
    return this.#dragKind;
  }
  set dragKind(kind) {
    if (kind !== null && !DRAG_KINDS.includes(kind))
      throw new Error(`app.dragKind = ${JSON.stringify(kind)} is not a declared drag kind — add it to DRAG_KIND_MODIFIERS in web/canvas/dragKinds.js (with the held modifiers it reads) so its HintBar chips and the shortcut reachability prober cover it. Legal: null, ${DRAG_KINDS.join(", ")}.`);
    this.#dragKind = kind;
  }
  // Active Blender-style MODAL transform (manifest "G/S modal transforms round
  // 2": G grab / S scale + axis constraints + numeric entry), or null. Shape:
  // { kind: "grab"|"scale", axis: null|"x"|"y", buffer: string }. The geometry
  // (start cursor, per-member start states, collective center) is captured and
  // driven entirely in CanvasView, which owns pointer/preview; this reactive
  // record is only the shared context the shortcut registry reads (to gate
  // normal edit shortcuts off mid-transform — Blender's modal lock) and the
  // HintBar reads (to announce mode · axis · typed buffer + commit/cancel keys).
  // CanvasView is the SOLE writer: beginModalTransform sets {kind, axis:null,
  // buffer:""}; the axis/buffer commands reassign it whole so the HintBar
  // $derived invalidates. (Round-2 shape addition — flagged in the report.)
  modalXform = $state(null);
  /** Canonical region name under the pointer (Panel sets it) — the substrate
   * for region-aware hints (manifest: panels are first-class). */
  hoverRegion = $state(null);
  /** Preview overlay delta shown during drags — NOT committed/undoable. */
  previewDelta = $state(null);
  /** A revert thunk set while a TRANSIENT preview — one that must NEVER be
   *  committed, e.g. the FontPicker's hover-a-font-to-see-it preview — is staged
   *  OVER a session's real value. There is exactly ONE preview slot, and an
   *  in-place text edit already occupies it for the whole session, so a hover has
   *  nowhere else to render; without this flag a dismissal landing mid-hover
   *  (click-away is a WINDOW-capture pointerdown, which always beats a picker's
   *  own document-capture close) would commit a font the user merely pointed at.
   *  Owned by whoever staged it; see dropTransientPreview. */
  transientPreview = null;
  /** ITEM ID whose asset (video) picker should AUTO-OPEN (manifest 14.3: placing
   *  a new filmstrip immediately opens the video-picker modal). Set by the widget
   *  handlers that ASK for an asset — the "bbox_then_asset" creation gesture and the
   *  "asset_picker" double-click activation (web/widget_handlers.js); the Inspector's
   *  AssetField for that item's `src` row reads it and opens its picker, then clears
   *  it (on pick OR cancel — cancel leaves the empty ghost widget, per 14.3).
   *  null = no pending auto-open. */
  pendingVideoPickFor = $state(null);
  /** TRUE IN-PLACE RICH-TEXT EDITING. While a text box is being edited in place,
   * `textEditing` = { itemId } (null otherwise). The item keeps rendering LIVE
   * through Skia (never suppressed) — the TextEditController draws only the caret
   * + selection, sourced from the SAME CanvasKit Paragraph the render draws, so
   * they are glyph-accurate across mixed runs with no browser-layout drift. Drives:
   * the controller (self-drawn caret/selection + hidden input sink for keys/IME/
   * clipboard); the floating format toolbar; and the textEditing shortcut context
   * (Ctrl/Cmd+B/I/U + Cmd±). Selection-style edits flow through the preview/commit
   * system as ONE undo unit per logical edit, exactly like the Inspector rows. */
  textEditing = $state(null);
  /** TRUE IN-PLACE LATEX EDITING (WYSIWYG equation editor). While a latex widget
   * is edited in place, `latexEditing` = { itemId } (or { itemId, closing:true }
   * during the exit crossfade), null otherwise. UNLIKE text (which is canvas-as-
   * truth — never suppressed), a MathJax equation has NO caret model, so the edit
   * is a DOM MathLive `<math-field>` OVERLAY at the widget's world pose and the
   * canvas equation is SUPPRESSED in paint() for the duration (LatexEditController
   * owns the field). Commit re-typesets through the normal emit() → latexVector
   * path (no new IR). The MathLive(KaTeX) ↔ MathJax(tex-svg) glyph-metric
   * difference is an IRREDUCIBLE small enter/exit "pop" with this overlay approach
   * (both are Computer-Modern lineage — close, not identical); the `closing`
   * crossfade (see commitLatexEdit) masks it as much as this design allows. */
  latexEditing = $state(null);
  theme = $state("graphite");
  // BROWSER settings below: each = a SETTINGS descriptor's .initial (the
  // localStorage-or-default value) and a toggle*() using .persist. See the
  // SETTINGS repo above.
  minimapVisible = $state(SETTINGS.minimap.initial);
  // Optionally show each panel's canonical name (Slide Navigator / Property
  // Panel / Keyframe Panel) as a title bar. OFF by default (panels are not
  // first-class — manifest Round 7).
  panelNames = $state(SETTINGS.panelNames.initial);
  // Master snap toggle (gates ALL snapping — move AND resize) and the
  // snap-size / matching-dimension toggle. Both default ON.
  snapEnabled = $state(SETTINGS.snap.initial);
  snapSizeEnabled = $state(SETTINGS.snapSize.initial);
  // BROWSER setting (viewer-local): the DEFAULT rubber-band mode — what a
  // "regular" (unspecified-mode) band select uses, AND what an empty-space
  // drag uses directly (manifest Round 12B "DEFAULT EMPTY-SPACE DRAG = BOX
  // SELECT" — no arming needed there). Persisted like snap. Default "inner"
  // (PowerPoint's default marquee behavior — a precedent, not invented).
  bandMode = $state(localStorage.getItem(BAND_MODE_KEY) === "outer" ? "outer" : "inner");

  // ── CROSSHAIR MODE (manifest ARCHITECTURE PLAN #5: "one mechanism, two
  // skins") ───────────────────────────────────────────────────────────────
  // ONE-SHOT arming record for a gesture that starts with full-viewport
  // infinite crosshairs following the cursor, consumed by CanvasView on the
  // NEXT pointer-down and cleared (one-shot) — or by Esc, which cancels the
  // mode with no gesture at all. null = not armed.
  //   {kind: "band", mode: "inner"|"outer"}   — band-select skin (dashed,
  //     the band-select dash style); armed by the toolbar button / palette
  //     band-select commands. The toolbar's default press resolves through
  //     bandMode (armCrosshairBand("regular")); a DIRECT empty-space drag
  //     (CanvasView onPointerDown, nothing hit) does NOT go through this
  //     arm at all — it starts the SAME "band" drag kind straight from
  //     bandMode, matching the spec's "no arming required" for that path.
  //   {kind: "place", plugin}                 — placement skin (gray,
  //     --a-ghost tone); armed by Add Box / Add Text so a widget button
  //     click-drags/clicks its rect into existence instead of spawning at
  //     defaults (manifest Round 12B "Boxes": "right now it just places a
  //     box wherever the hell it wants"). `plugin` carries the widget's
  //     `.defaults` (for default-size single-click placement) and `.type` —
  //     the ENTIRE generalization surface: any future plugin opts in by
  //     arming with itself, no CanvasView changes needed.
  crosshair = $state(null);

  // ── WIDGET CANVAS MODE (web/widget_handlers.js) ────────────────────────────
  // While a widget's ACTIVATION has taken over canvas input, `canvasMode` =
  // { handlerId, itemId } (null otherwise). The handler descriptor's `mode`
  // (looked up by handlerId) owns what drags and the wheel DO; CanvasView routes
  // the gestures; the HintBar shows that mode's own registered inputs, scoped by
  // handlerId; Escape exits. This is the SAME shape as textEditing/latexEditing/
  // codeEditing — one reactive record naming what is being edited and by what —
  // except the mode's behaviour lives in the registry instead of a dedicated
  // controller component, which is what lets a NEW kind of mode ship without
  // touching this file.
  canvasMode = $state(null);
  // Editor-only Blender-style background grid and top ruler strip. Both are
  // "options" defaulting OFF (manifest: Grid + Ruler).
  gridEnabled = $state(SETTINGS.grid.initial);
  rulerEnabled = $state(SETTINGS.ruler.initial);
  // Default OFF (manifest ARCHITECTURE PLAN #2 GHOST capability): shows/hides
  // GHOST outlines (empty text, groups) on the CanvasView SVG overlay. Crop-box
  // ghost outlines are NOT gated by this — they show ALWAYS (core/derive.
  // isGhostNode + the "always" rule: a crop box is unclickable otherwise).
  showGhosts = $state(SETTINGS.showGhosts.initial);
  // Default OFF: the bottom-left FPS counter (shows in the editor AND present
  // mode — user spec, round 11).
  fpsVisible = $state(SETTINGS.fps.initial);
  // Count of REAL rendered frames (editor viewport + presenter paints bump
  // it). Deliberately NOT $state — it changes at up to display rate and its
  // only consumer (FpsCounter) polls it from its own rAF loop; reactive
  // churn at 120Hz would be pure waste.
  renderFrameCount = 0;
  // Reactive flag CanvasView raises while any snap correction is applied in the
  // current pointer-move; cleared on pointer-up. Drives the toolbar toggle
  // taking the guide color while a snap is actually engaged.
  snapEngaged = $state(false);
  // The shortcut registry is $state so App.svelte can REBUILD it after a
  // keybinding rebind (createShortcuts has no remove — see core/keybindings.js
  // scope note) and the HintBar picks up the swap reactively.
  shortcuts = $state(null);

  // Toggles: flip the reactive field, persisting through the SETTINGS repo's
  // .persist (writes "on"/"off"). One line each — the read/write logic and the
  // localStorage key live in the descriptor.
  toggleMinimap() {
    this.minimapVisible = SETTINGS.minimap.persist(!this.minimapVisible);
  }

  toggleFps() {
    this.fpsVisible = SETTINGS.fps.persist(!this.fpsVisible);
  }

  togglePanelNames() {
    this.panelNames = SETTINGS.panelNames.persist(!this.panelNames);
  }

  toggleSnap() {
    this.snapEnabled = SETTINGS.snap.persist(!this.snapEnabled);
  }

  toggleSnapSize() {
    this.snapSizeEnabled = SETTINGS.snapSize.persist(!this.snapSizeEnabled);
  }

  toggleGrid() {
    this.gridEnabled = SETTINGS.grid.persist(!this.gridEnabled);
  }

  toggleRuler() {
    this.rulerEnabled = SETTINGS.ruler.persist(!this.rulerEnabled);
  }

  toggleGhosts() {
    this.showGhosts = SETTINGS.showGhosts.persist(!this.showGhosts);
  }

  /**
   * Query. THE camera's folded item state on the current slide as {id, state},
   * or null on a degenerate pre-repair document with no active camera (the
   * CAMERA invariant guarantees exactly one otherwise). Selected by the SAME
   * deterministic rule as core/derive.cameraRect — the first active
   * `type:"camera"` by id. Reads the memoized folded+evaluated state(), so a
   * caller in a reactive scope (app.dpr() ← CanvasView's paint effect)
   * recomputes when the document or slide changes; no render-tree derivation.
   */
  cameraState() {
    const entry = Object.entries(this.state().items ?? {})
      .filter(([, s]) => s.type === "camera" && s.active !== false)
      .sort(([a], [b]) => (a < b ? -1 : 1))[0];
    return entry ? { id: entry[0], state: entry[1] } : null;
  }

  /**
   * Query. The effective devicePixelRatio for ALL raster rendering — the SOLE
   * reader of the retina setting, which is CAMERA-ONLY: THE camera's `retina`
   * prop (Inspector → Rendering → Retina) is the single source of truth.
   * REACTIVE: flipping that prop reassigns this.doc, so the folded state() this
   * reads changes and CanvasView's paint effect (a dep of app.doc) repaints and
   * resizes the canvas backing store. retina ON → the display's device pixel
   * ratio (crisp on HiDPI); OFF → 1 (1:1 CSS px, softer, faster). The
   * camera-absent / missing-prop degenerate case falls back to the registry
   * default, matching core/derive.cameraRect's `?? default` idiom.
   */
  dpr() {
    const retina = this.cameraState()?.state.retina ?? CAMERA_RETINA_DEFAULT;
    return effectiveDpr(retina, window.devicePixelRatio || 1);
  }

  constructor() {
    this.registry = createRegistry();
    this.commands = createCommands();
    this.shortcuts = createShortcuts(); // App.svelte rebuilds this from the keybinding registry
    this.undoLog = createUndo(this.snapshot(this.doc));
    this.canvasActions = null; // PanZoom actions, set by CanvasView
    registerAll(this.registry, this.commands);
  }

  // ── State queries ──────────────────────────────────────────────────────────

  // Preview-blend cache: (base, previewDelta) identity pair → blended state.
  // Deliberately non-reactive (renderFrameCount precedent). WHY: during a drag
  // every reactive consumer (viewport paint, picker displayName × N items,
  // nodes(), per-row error checks, ...) reads state() on EVERY pointermove; a
  // fresh blendApplied object per CALL defeated evaluateState's state-identity
  // memo, so each consumer paid its own full O(items) equation pass per mouse
  // move — the profiled drag-lag cliff (concerns 2026-07-15, Opus4 risk (b)).
  // One stable object per (base, preview) pair = ONE evaluation per move.
  #blendCache = { base: null, preview: null, state: null };

  /**
   * Folded state of the current slide, with any live drag preview applied —
   * RAW: equation slots still hold their stored strings. The Property Panel
   * and Variables Panel read THIS to display/edit equations. IDENTITY-STABLE:
   * repeated calls return the SAME object until the fold or previewDelta
   * changes (evaluateState's memo — and thus drag latency — depends on this;
   * consumers must never mutate the returned state). setPreview reassigns
   * previewDelta wholesale each move, which is what keys the cache.
   */
  rawState() {
    const base = foldState(this.doc, this.slideIndex, 1);
    const preview = this.previewDelta;
    // ONE transient overlay: the live PREVIEW delta. A second one used to be blended
    // here — the filmstrip's fetch STATUS (processing / frameError) — and it went away
    // with the server frame-extraction round-trip that produced it: the filmstrip's
    // frames are decoded in the browser from ordinary document state now, so it has no
    // in-flight or fetch-failed condition to model outside the document at all.
    if (!preview) return base;
    const c = this.#blendCache;
    if (c.base !== base || c.preview !== preview) {
      c.base = base;
      c.preview = preview;
      c.state = blendApplied(base, preview, 1);
    }
    return c.state;
  }

  /** The derivation-stage expression pass over rawState(): {state, errors}.
   * Memoized on state identity inside evaluateState. */
  evalInfo() {
    return evaluateState(this.rawState(), this.registry);
  }

  /** Folded + EVALUATED state — every numeric property is a number. All
   * geometry (canvas, snapping, anchors, hit tests) reads this. */
  state() {
    return this.evalInfo().state;
  }

  /** Expression error message for a full state path (e.g. ["items", id, "x"]
   * or ["vars", name]), or null. Drives the equation-field error affordance. */
  exprErrorAt(path) {
    return this.evalInfo().errors.get(path.join(".")) ?? null;
  }

  /** RAW stored value at a path within an item (equation string or number). */
  storedItemValue(itemId, path) {
    return getPath(this.rawState().items?.[itemId] ?? {}, path);
  }

  /** RAW stored value at a FULL state path (e.g. ["items", id, "x"] or
   * ["vars", name]) — the KeyframeControls upsert reads this to copy the
   * current value into a new keyframe (equations stay equations). */
  storedValueAtPath(path) {
    return getPath(this.rawState(), path);
  }

  /** The referencable display name of an anchor ("circle_tm") — what the
   * hover tooltip shows and what equations type before .x/.y. */
  anchorName(itemId, anchorId) {
    return anchorRefName(this.rawState(), itemId, anchorId);
  }

  nodes() {
    return deriveRenderTree(this.state(), this.registry);
  }

  selectedNode() {
    return this.nodes().find((n) => n.itemId === this.selection) ?? null;
  }

  /** Query. The full set of selected itemIds: the multi override when non-empty,
   * else [selection] (or []). The ONE place set-aware consumers (canvas
   * outlines, the Inspector placeholder) read to know everything selected.
   * Always a FRESH plain array — never the internal $state proxy (callers
   * can't mutate selection state through it, and plain arrays survive
   * puppeteer serialization — the concerns.md proxy gotcha). */
  selectedIds() {
    return this.selectionSet.length ? [...this.selectionSet] : (this.selection !== null ? [this.selection] : []);
  }

  /** Query. Render nodes for every selected id (order = selectedIds()). */
  selectedNodes() {
    const ids = new Set(this.selectedIds());
    return this.nodes().filter((n) => ids.has(n.itemId));
  }

  /**
   * Command. Sets the selection to a SET of itemIds (band select / future
   * multi-click). The primary `selection` becomes the first id (drives every
   * single-item consumer); the multi override holds the whole set. Assigning
   * #selection directly (not through the accessor) so the set is NOT cleared.
   * Empty ids → full deselect.
   */
  selectMany(ids) {
    // GROUP INVARIANT (manifest Round-12B): a group and its members can never be
    // simultaneously selected. Enforced HERE — the ONE multi-select substrate —
    // so band select, Select All, and future multi-click paths all inherit it
    // with no per-caller code (and CanvasView's band commit needs no edit): a
    // member whose group is also in the set collapses out, leaving the group as
    // the top-level handle. A lone member (no group in the set) survives, so a
    // direct member click with Show Ghosts off still selects the member.
    const filtered = dedupeGroupSelection(ids, groupMembership(this.nodes()));
    // [ROUND 15.2] #selection is written directly below (not through the
    // `selection` accessor, which would clear selectionSet) — so this entry
    // point needs its OWN text-edit dismissal, same rule as that accessor:
    // a multi-select that doesn't merely re-affirm the item being edited
    // must commit+exit first. (In practice CanvasView's click-away guard
    // already dismisses before any band-select/shift-click logic runs; this
    // is the defensive second layer for any other caller, e.g. Select All.)
    if (this.editingItemId !== null && !(filtered.length === 1 && filtered[0] === this.editingItemId)) this.dismissEdit();
    if (filtered.length === 0) {
      this.selection = null; // clears both (accessor path)
      return;
    }
    this.#selection = filtered[0];
    this.selectionSet = [...filtered];
    this.handleSelection = []; // the outer scope owns the inner one (see handleSelection)
    this.selectedTransition = null; // selecting items clears a transition selection
  }

  /**
   * Command. Toggles an itemId's MEMBERSHIP in the current selection
   * (shift-click semantics — PowerPoint/Figma): if `id` is already selected it
   * is removed, otherwise it is added. Order-preserving: an added id lands at
   * the end. Routes ENTIRELY through the existing substrate — it builds the new
   * id list from selectedIds() ± `id` and applies it via selectMany (a
   * collapse-to-one still goes through selectMany, whose first-element mirror
   * keeps `selection` coherent); removing the last id fully deselects. No second
   * selection mechanism.
   */
  toggleInSelection(id) {
    const ids = this.selectedIds();
    this.selectMany(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  // ── HANDLE SELECTION (the INNER selection scope) ────────────────────────────
  // The vocabulary is deliberately the item scope's, one level down: selectHandle
  // ≙ `selection =`, toggleHandleInSelection ≙ toggleInSelection, hide/show/purge
  // ≙ deleteSelection/showSelection/purgeSelection. Copying the words is what makes
  // the two scopes one idea rather than two. See `handleSelection` for the
  // precedence rules between them.

  /** Query. The selected item's WORLD-space modifier points (all of them), or []
   * when the selection is not exactly one item — handles only exist for a single
   * selection, the same scope CanvasView draws them in.
   *
   * Always a FRESH plain array (the selectedIds() rule: never the $state proxy, so
   * a caller cannot mutate selection state through it and puppeteer can serialize
   * it). */
  handles() {
    const ids = this.selectedIds();
    if (ids.length !== 1) return [];
    const node = this.nodes().find((n) => n.itemId === ids[0]);
    return node ? nodeModifierPoints(node) : [];
  }

  /** Query. The selected handles, in the order the plugin declares them (NOT
   * selection order) — so a set operation walks the widget's own element order and
   * the toolbar's readout is stable as you add to the set. */
  selectedHandles() {
    const chosen = new Set(this.handleSelection);
    return this.handles().filter((h) => chosen.has(h.id));
  }

  /** Command. Makes `id` THE selected handle (a plain click on a handle) —
   * replacing whatever was selected, exactly as a plain item click replaces the
   * item selection. Leaves the ITEM selection alone. */
  selectHandle(id) {
    this.handleSelection = [id];
  }

  /**
   * Command. Toggles a handle's MEMBERSHIP in the handle selection — shift-click,
   * the SAME semantics `toggleInSelection` gives items (PowerPoint/Figma: shift on
   * an already-selected one REMOVES it). Order-preserving: an added id lands at the
   * end. Removing the last id leaves the handle selection empty, which is not a
   * deselect of the item — the two scopes are independent (see handleSelection).
   */
  toggleHandleInSelection(id) {
    const ids = this.handleSelection;
    this.handleSelection = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  /** Command. Clears the handle selection, leaving the ITEM selection intact —
   * Escape's inner-scope meaning (see handleSelection precedence rule 2). */
  clearHandleSelection() {
    this.handleSelection = [];
  }

  /**
   * Pure function. The LIST DECLARATION (core/lists.js) behind a handle, or null
   * when the handle is not a list element: `{decl, listKey, index}`.
   *
   * The handle carries the declaration BY REFERENCE (`element.list` is the very
   * object core/properties.js owns — PROPS.points for a polygon vertex), so the
   * canvas actions, the Inspector's list control and the plugin's own geometry read
   * ONE declaration and cannot disagree about the storage form or the visibility
   * companion's name. Deliberately NOT a lookup by key: a lookup needs a table to
   * look in, and every candidate table (the plugin's inspector rows, PROPS) is a
   * place the answer could be missing or a second copy could appear — a reference
   * cannot drift from itself. A malformed declaration is a plugin bug, so it throws.
   */
  #handleElement(handle) {
    if (!handle.element) return null;
    const { list: decl, index } = handle.element;
    if (decl?.kind !== LIST_ROW_KIND || !decl.key || !decl.activeKey)
      throw new Error(`app: handle "${handle.id}" of "${this.selectedNode()?.type}" declares an \`element\` whose \`list\` is not a list declaration (need kind "${LIST_ROW_KIND}" plus key/activeKey — pass the core/properties.js PROPS entry itself, e.g. \`element: {list: props("points")[0], index: i}\`). Got: ${JSON.stringify(decl)?.slice(0, 120)}`);
    return { decl, listKey: decl.key, index };
  }

  /** Query. The selected handles that ARE list elements, grouped by list key and
   *  sorted by DESCENDING index — the order a multi-element splice must run in, so
   *  each purge cannot invalidate the indices still to come. Handles with no
   *  element (a donut's inner radius) are absent, which is what makes the list
   *  actions silently inapplicable to them rather than wrong. */
  #selectedListElements() {
    const byKey = new Map();
    for (const h of this.selectedHandles()) {
      const el = this.#handleElement(h);
      if (!el) continue;
      if (!byKey.has(el.listKey)) byKey.set(el.listKey, { decl: el.decl, indices: [] });
      byKey.get(el.listKey).indices.push(el.index);
    }
    for (const entry of byKey.values()) entry.indices.sort((a, b) => b - a);
    return byKey;
  }

  /**
   * Command. Sets every selected handle's element VISIBILITY (hide/show) as ONE
   * undo unit — the list-element form of the item eye toggle, and the same rule one
   * level down: the element stops participating (a polygon draws straight past the
   * corner) but keeps its place, so it can come back.
   *
   * INDEX-STABLE BY CONSTRUCTION: routed through core/lists.withElementActive,
   * which writes ONLY the aligned visibility COMPANION and returns the element list
   * by identity. `points.3.x` therefore still names the same vertex afterwards, and
   * every equation bound to a later element keeps its meaning. That is the whole
   * reason hide exists alongside purge.
   *
   * KEEPS the handle selection (the item-scope ruling verbatim: "you shouldn't
   * deselect something when it's not visible anymore" — a hidden handle stays
   * selected so the same button flips it back).
   */
  setHandleSelectionActive(active) {
    const groups = this.#selectedListElements();
    if (groups.size === 0) return;
    const id = this.selection;
    const state = this.state().items?.[id];
    let doc = this.doc;
    for (const [listKey, { decl, indices }] of groups) {
      let value = { list: state[listKey], active: state[decl.activeKey] };
      for (const index of indices) value = withElementActive(decl, value, index, active);
      doc = keyframed(doc, this.slideIndex, ["items", id, decl.activeKey], value.active);
    }
    this.commit(doc);
  }

  /**
   * Command. PURGES every selected handle's element — spliced out of the list for
   * good — as ONE undo unit. The list-element form of purgeSelection, and like it
   * the DESTRUCTIVE half of the pair: hide is setHandleSelectionActive and moves
   * nothing.
   *
   * IT RENUMBERS, AND THAT IS USER-VISIBLE. Purge is one of the two renumbering
   * operations (core/lists.js): every LATER element's address shifts down by one, so
   * an equation bound to `points.4.x` comes to mean what was `points.5.x`. The
   * document-wide equation rewrite that would make this safe is not built
   * (core/lists.indexAfterPurge is the remap it needs), so the consequence is
   * surfaced in the command's own title and in the toolbar's tooltip rather than
   * hidden behind a button that looks like hide.
   *
   * Indices run DESCENDING (#selectedListElements' order) so each splice cannot
   * invalidate the ones still to come. CLEARS the handle selection: those elements
   * no longer exist, exactly as purgeSelection deselects a purged item.
   */
  purgeHandleSelection() {
    const groups = this.#selectedListElements();
    if (groups.size === 0) return;
    const id = this.selection;
    const state = this.state().items?.[id];
    let doc = this.doc;
    for (const [listKey, { decl, indices }] of groups) {
      let value = { list: state[listKey], active: state[decl.activeKey] };
      for (const index of indices) value = withElementPurged(decl, value, index);
      doc = keyframed(doc, this.slideIndex, ["items", id, listKey], value.list);
      // Only write the companion when there IS one: purging from a list that never
      // hid anything must not mint an all-true companion into the document.
      if (value.active) doc = keyframed(doc, this.slideIndex, ["items", id, decl.activeKey], value.active);
    }
    this.commit(doc);
    this.handleSelection = [];
  }

  /**
   * Command. Selects every selectable item on the current slide (palette
   * "Select All" — manifest Round 12B). Excludes purgeable:false widgets (the
   * camera) — the same set-operation exclusion `deleteSelection`/
   * `purgeSelection`/`showSelection`/`addBlankSlide` already use, since the
   * camera is not a content object a user means to grab with Select All.
   * Routes through selectMany (the ONE multi-select substrate).
   */
  selectAll() {
    const ids = this.nodes()
      .filter((n) => n.plugin.capabilities.purgeable !== false)
      .map((n) => n.itemId);
    this.selectMany(ids);
  }

  /** Command. Clears the selection (palette "Deselect All" — manifest Round
   * 12B). Same effect as Escape's existing deselect path (needsSelection
   * `deselect` command); a separate palette entry exists because Escape is
   * also read by other contexts (modal cancel) where "Deselect All" as a
   * distinct, always-nameable command is still useful (fuzzy search, no
   * keyboard focus required). */
  deselectAll() {
    this.selection = null; // clears both selection and selectionSet (accessor path)
  }

  // ── Transition selection (the between-rows navigator slice) ─────────────────
  // A transition is selected BY the incoming slide's slideId (stable identity;
  // slide indices shift on insert). Mutually exclusive with item selection.

  /** Command. Selects the transition INTO slide `slideId` (clears item
   * selection). Passing null deselects the transition. */
  selectTransition(slideId) {
    if (slideId === null) {
      this.selectedTransition = null;
      return;
    }
    this.selection = null; // clears item selection (accessor path)
    this.selectedTransition = slideId;
  }

  /**
   * Query. The unified selection target — what the Property Panel inspects.
   * One of: {kind: "item", itemId}, {kind: "transition", slideId}, or null.
   * The ONE thing Opus10's Inspector reads to decide which UI to show; item
   * selection wins if somehow both are set (they're kept mutually exclusive).
   */
  get selectionTarget() {
    if (this.selection !== null) return { kind: "item", itemId: this.selection };
    if (this.selectedTransition !== null) return { kind: "transition", slideId: this.selectedTransition };
    return null;
  }

  /** Query. The slide index for a slideId, or -1. */
  slideIndexOf(slideId) {
    return this.doc.slides.findIndex((s) => s.id === slideId);
  }

  /**
   * Query. The EFFECTIVE transition record for slide `slideId` — stored props
   * folded with the type-registry superclass + type defaults (every property
   * present). What the Inspector's transition rows display. Returns null when
   * the slide doesn't exist.
   */
  transitionAt(slideId) {
    const i = this.slideIndexOf(slideId);
    return i === -1 ? null : resolveTransition(this.doc, i);
  }

  /**
   * Command (one undo unit). Sets one transition property (seconds/curve/sound
   * or a type extra) on slide `slideId`. Writes the FULL resolved record back
   * so a partially-stored transition becomes complete (no half-written records
   * in the document). No-op when the slide is gone.
   */
  setTransitionProp(slideId, key, value) {
    const i = this.slideIndexOf(slideId);
    if (i === -1) return;
    const transition = { ...resolveTransition(this.doc, i), [key]: value };
    const slides = this.doc.slides.map((s, j) => (j === i ? { ...s, transition } : s));
    this.commit({ ...this.doc, slides });
  }

  /**
   * Command (one undo unit). Switches slide `slideId`'s transition TYPE,
   * PRESERVING the superclass props (seconds/curve/sound survive) and re-seeding
   * the type's extras from the new type's defaults (retypedTransition). No-op
   * when the slide is gone.
   */
  setTransitionType(slideId, type) {
    const i = this.slideIndexOf(slideId);
    if (i === -1) return;
    const transition = retypedTransition(resolveTransition(this.doc, i), type);
    const slides = this.doc.slides.map((s, j) => (j === i ? { ...s, transition } : s));
    this.commit({ ...this.doc, slides });
  }

  /**
   * Command. Enters a Blender-style modal transform ("grab" | "scale") over the
   * current selection (manifest Round 12). No-op with nothing selected. Only the
   * KIND is stored here; CanvasView (which owns pointer + preview) watches this
   * flag, captures the start geometry (cursor, member poses, collective center),
   * and drives the live preview. Confirm/cancel go through the callbacks below,
   * which CanvasView installs — the same seam pattern as canvasActions.
   */
  beginModalTransform(kind) {
    if (this.selectedIds().length === 0) return;
    this.modalXform = { kind, axis: null, buffer: "" };
  }

  // Confirm/cancel/constraint hooks for the active modal transform — installed
  // by CanvasView (which owns the preview) like canvasActions. The modal
  // shortcut entries (App.svelte) call these: Enter/left-click confirm, Escape
  // cancels, X/Y set the axis constraint, digit/./- keys build the numeric
  // buffer, Backspace edits it. All no-ops before the canvas mounts (and no-ops
  // outside a live transform — CanvasView guards each on a live modal record).
  modalCommit = () => {};
  modalCancel = () => {};
  modalSetAxis = () => {};
  modalAppendBuffer = () => {};
  modalBackspace = () => {};

  // FINALIZE hook for a live multi-step CREATION mode — installed by CanvasView,
  // which holds the in-flight session (a half-drawn polygon is not document state,
  // so it cannot live here). The mode's own `finish` key routes through the shortcut
  // registry to this, exactly as the modal's Enter routes to modalCommit; CanvasView
  // guards it on a live session, so it is a no-op otherwise.
  finishCanvasMode = () => {};

  /** Command. Arms a one-shot CROSSHAIR band-select drag in `mode`
   * ("inner"|"outer"|"regular"). "regular" resolves to the default bandMode
   * setting (the toolbar button's press — manifest Round 12B "TOOLBAR BUTTON
   * for default box select"). The next canvas drag performs the rubber band;
   * CanvasView clears the arm. */
  armCrosshairBand(mode) {
    this.crosshair = { kind: "band", mode: mode === "regular" ? this.bandMode : mode };
  }

  /** Command. Arms a one-shot CROSSHAIR placement drag for `plugin` (manifest
   * ARCHITECTURE PLAN #5 "PLACEMENT rides it"): the next canvas gesture
   * click-drags the widget's rect into existence, or a plain click places it
   * at `plugin.defaults` size centered on the point (CanvasView.onPointerDown
   * / placementDrag / placementUp). Generalizes to ANY plugin — the widget
   * type itself is the only per-plugin knowledge CanvasView needs.
   *
   * A plugin whose create handler declares a MULTI-STEP mode (polygon) arms the
   * same way: the first press enters that mode instead of finishing, and the
   * crosshair stays up for the whole session (see enterCanvasMode). */
  armCrosshairPlacement(plugin) {
    this.crosshair = { kind: "place", plugin };
  }

  /**
   * Command. Arms a CROSSHAIR creation for a RIG — several items wired by `=`
   * equations, which no single plugin can declare a creation gesture for (the
   * telescopic magnifier is three items of three types). `handlerId` names the
   * create-phase handler directly (web/widget_handlers.js) and `params` is whatever
   * that handler's `finalize` needs (the telescopic rig's shapeKind).
   *
   * Deliberately a SECOND method rather than an optional argument on
   * armCrosshairPlacement: the plugin-declares-its-own-gesture rule is what keeps
   * the create phase honest for widgets, and an override channel on the widget path
   * would invite using it for widgets. Every existing caller is untouched.
   */
  armCrosshairRig(handlerId, params = {}) {
    this.crosshair = { kind: "place", handlerId, params };
  }

  // ── WIDGET CANVAS MODE lifecycle ───────────────────────────────────────────

  /**
   * Command. Enters a widget handler's sustained canvas mode: the widget owns canvas
   * input until Escape. Dismisses any in-place edit first, for the reason
   * enterPresentMode does — a takeover that leaves a stranded editor overlay has no
   * exit path.
   *
   * `itemId` is null for a CREATION mode (a multi-step placement — nothing exists
   * yet to belong to), and `step` is which of the mode's declared steps is current;
   * CanvasView advances it as gestures land and the HintBar narrates off it. A mode
   * with no sequence simply stays at 0.
   */
  enterCanvasMode(handlerId, itemId) {
    this.dismissEdit();
    this.canvasMode = { handlerId, itemId, step: 0 };
  }

  /** Command. Sets which step of a multi-step creation mode is current. Reassigns
   * the whole record so every $derived tracking `canvasMode` invalidates (the
   * syncModalXform pattern). A no-op with no mode active. */
  setCanvasModeStep(step) {
    if (!this.canvasMode) return;
    this.canvasMode = { ...this.canvasMode, step };
  }

  /**
   * Command. Leaves the canvas mode, COMMITTING any gesture still staged in the
   * preview (a wheel gesture whose idle timer had not yet fired) as ONE undo unit
   * — the dismissTextEdit ruling: an exit boundary commits, it never discards work
   * the user can see. A no-op when no mode is active, so every "something else
   * happened" gate can call it unconditionally.
   *
   * It also DISARMS the crosshair, because a CREATION mode's crosshair deliberately
   * outlives the one-shot press that started it: a multi-step placement needs the
   * placement cursor for every step, not just the first. Leaving the mode is the end
   * of that session either way (finished or abandoned), so the cursor goes with it.
   * Harmless for an activation mode, which never has one armed (entering a mode does
   * not clear an arm, but nothing arms one to enter an activation).
   */
  exitCanvasMode() {
    if (!this.canvasMode) return;
    this.canvasMode = null;
    this.crosshair = null;
    if (this.previewDelta) this.commitPreview();
  }

  /** Command. Cancels an armed-but-not-yet-gestured crosshair mode (Esc,
   * manifest ARCHITECTURE PLAN #5: "Esc cancels"). No-op once a drag has
   * actually started — CanvasView's drag record takes over at that point and
   * its own Esc-cancel (mirroring the modifier-drag pattern) applies instead. */
  cancelCrosshair() {
    this.crosshair = null;
  }

  /** Command. Sets and persists the default ("regular") band-select mode. */
  setBandMode(mode) {
    this.bandMode = mode;
    localStorage.setItem(BAND_MODE_KEY, mode);
  }

  /** Display name for an item: its `name` state, else the shared fallback
   * "<Type> (id-prefix)" (itemFallbackName — one home). */
  displayName(itemId) {
    const s = this.state().items?.[itemId];
    if (!s) return itemId;
    if (s.name) return s.name;
    return itemFallbackName(this.registry.get(s.type).title, itemId);
  }

  // ── Theme (viewer preference — not document state, not undoable) ──────────

  /** Command. Applies theme `id` VISUALLY only: the reactive `theme` field +
   * the documentElement data-attr the CSS cascade keys on. Does NOT persist —
   * the shared core of both setTheme (which adds persistence) and previewTheme
   * (which must not persist a transient hover). Mutates document.documentElement
   * + this.theme. */
  applyThemeVisual(id) {
    this.theme = id;
    document.documentElement.dataset.theme = id;
  }

  setTheme(id) {
    this.applyThemeVisual(id);
    localStorage.setItem(THEME_KEY, id);
  }

  /**
   * Command (viewer-preference preview — NOT persisted, NOT undoable). The
   * previewable-command hook the palette calls when a theme entry is hovered/
   * arrow-focused: applies theme `id` LIVE and returns a `revert` closure that
   * restores whatever theme was applied before. Unlike setTheme it never writes
   * localStorage — only a COMMITTED setTheme (the entry's `run`) persists, so
   * scrubbing through themes leaves the saved preference untouched until the
   * user actually picks one. See the general preview protocol in
   * CommandPalette.svelte.
   */
  previewTheme(id) {
    const prev = this.theme;
    this.applyThemeVisual(id);
    return () => this.applyThemeVisual(prev);
  }

  loadTheme() {
    this.setTheme(localStorage.getItem(THEME_KEY) ?? "graphite");
  }

  /** Quick light/dark flip (toolbar); full set lives in the palette submenu. */
  toggleLightDark() {
    this.setTheme(this.theme === "light" ? "graphite" : "light");
  }

  // ── Transactions (undo units) ──────────────────────────────────────────────
  // Snapshots carry UI state too (selection, slide, viewport) — undoing a
  // purge reselects the item; undo/redo restores where you were looking.

  lastViewport = null; // kept fresh by CanvasView's onviewport

  snapshot(doc) {
    // handleSelection rides along for the SAME reason `selection` does, one scope
    // down: undoing a point hide must put you back with those points selected, so
    // the toolbar button you just pressed is still pointing at them. Without it the
    // `selection` write in applySnapshot would clear the inner scope (the
    // outer-owns-inner rule) and every point edit would silently deselect.
    return { doc, selection: this.selection, handleSelection: this.handleSelection, slideIndex: this.slideIndex, viewport: this.lastViewport };
  }

  applySnapshot(snap) {
    this.doc = snap.doc;
    this.selection = snap.selection;
    // AFTER `selection`, never before: that setter clears the handle selection.
    // Snapshots taken before this field existed carry none — [] is then correct,
    // which is also what the setter just wrote, so there is nothing to special-case.
    this.handleSelection = snap.handleSelection ?? [];
    this.slideIndex = Math.min(snap.slideIndex, snap.doc.slides.length - 1);
    if (snap.viewport) this.canvasActions?.setViewport(snap.viewport);
  }

  commit(doc) {
    if (doc === this.doc) return;
    this.undoLog.commit(this.snapshot(doc));
    this.doc = doc;
    try {
      localStorage.setItem(AUTOSAVE_KEY, serialize(doc));
    } catch (e) {
      console.warn("Autosave failed:", e); // quota etc. — report, keep working
    }
  }

  undo() {
    // Restore the PREVIOUS document, but the UI state captured at the moment
    // of the edit being undone — undoing a purge reselects the purged item.
    const undone = this.undoLog.doc;
    const prev = this.undoLog.undo();
    this.applySnapshot({ ...undone, doc: prev.doc });
  }

  redo() {
    this.applySnapshot(this.undoLog.redo());
  }

  // ── Preview (live drag without undo spam) ──────────────────────────────────

  setPreview(pathValuePairs) {
    let d = {};
    for (const [path, value] of pathValuePairs) d = setPath(d, path, value);
    this.previewDelta = d;
  }

  /** Commits the current preview as keyframes on the current slide (one undo unit). */
  commitPreview() {
    if (!this.previewDelta) return;
    let doc = this.doc;
    const walk = (tree, prefix) => {
      for (const [k, v] of Object.entries(tree)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) walk(v, [...prefix, k]);
        else doc = keyframed(doc, this.slideIndex, [...prefix, k], v);
      }
    };
    walk(this.previewDelta, []);
    this.previewDelta = null;
    this.commit(doc);
  }

  cancelPreview() {
    this.previewDelta = null;
  }

  /** Command. Restores the real value sitting under any TRANSIENT preview, so
   * what the slot holds is what the user actually chose. Every path that can
   * COMMIT the slot must call this first; it is a no-op when nothing transient
   * is staged. See the `transientPreview` field for why this exists. */
  dropTransientPreview() {
    const revert = this.transientPreview;
    this.transientPreview = null;
    if (revert) revert();
  }

  // ── Presets (the generic PRESETS tool — web/ToolsPane.svelte) ─────────────

  /**
   * Command. Applies a plugin PRESET's property-set to item `itemId` as keyframed
   * writes on the CURRENT slide, in ONE undo unit — the exact Inspector-row commit
   * path (setPreview → commitPreview). `preset.props` is a flat map of item-state
   * keys (a plugin's self.* look knobs + shared props like blendMode) to values;
   * each becomes a keyframe at ["items", itemId, key] on the current frame, so a
   * preset is just "set these current-frame properties at once". No-op if itemId is
   * null. Reusable for ANY plugin that declares `presets` — nothing here is
   * lens-flare-specific.
   *
   * @param {string|null} itemId - the target item
   * @param {{props: Object}} preset - a plugin preset descriptor ({name, props, ...})
   */
  applyPreset(itemId, preset) {
    if (itemId === null || !preset?.props) return;
    const pairs = Object.entries(preset.props).map(([key, value]) => [["items", itemId, key], value]);
    this.setPreview(pairs);
    this.commitPreview();
  }

  // ── WYSIWYG rich-text editing (Round 13.4) ─────────────────────────────────

  /** Command. Enters in-place edit mode on a text item: selects it (so the
   * Inspector + toolbar reflect it) and sets `textEditing`. The item keeps
   * rendering live through Skia; the TextEditController mounts and draws the
   * caret/selection on top. A no-op if already editing this item.
   *
   * `opts.plain` selects PLAIN-STRING mode (a single-string widget like
   * plaintext, via its `inlineTextEdit` descriptor): the editor edits one plain
   * string at `opts.property` (default "text") with no runs/format toolbar, and
   * the stored leaf is a bare string rather than a {runs,paras} value. In plain
   * mode an `=` equation-bound value is REFUSED (in-place editing flattens the
   * RESOLVED value back to a literal, which would silently overwrite the
   * equation) — reported LOUDLY, then the user edits it in the Inspector (the
   * mermaid/codeblock precedent). Rich mode (no opts) is unchanged. */
  beginTextEdit(itemId, opts = {}) {
    const plain = !!opts.plain;
    const property = opts.property ?? "text";
    if (plain) {
      const plugin = this.registry.get(this.storedItemValue(itemId, ["type"]));
      if (plugin && isEquationValue(plugin, [property], this.storedItemValue(itemId, [property]))) {
        console.warn(`beginTextEdit: "${property}" is an = equation — edit it in the Inspector (in-place editing would overwrite the equation with its value).`);
        return;
      }
    }
    if (this.textEditing?.itemId === itemId) return;
    this.selection = itemId;
    this.textEditing = { itemId, plain, property };
  }

  /** Command. Live-previews the edited text value — the viewport re-renders
   * through the overlay in real time (the house live-preview rule; the
   * Inspector-row commit path). Written as a single keyframable non-numeric leaf
   * at the editing property, EXACTLY the stored shape: a {runs,paras} value in
   * rich mode, a bare string in plain mode (the controller flattens before it
   * calls here). */
  previewTextValue(value) {
    if (!this.textEditing) return;
    this.setPreview([[["items", this.textEditing.itemId, this.textEditing.property ?? "text"], value]]);
  }

  /** Command. Commits the edit as ONE undo unit (setPreview already holds the
   * final value → commitPreview keyframes it on the current slide) and exits
   * edit mode. If there was no pending preview (no change), just exits. */
  commitTextEdit() {
    const editing = this.textEditing;
    // A hovered-but-unchosen style is staged in the SAME slot as the edit; drop
    // it first so a dismissal landing mid-hover commits the real value.
    this.dropTransientPreview();
    this.textEditing = null;
    if (!editing) return;
    if (this.previewDelta) this.commitPreview();
  }

  /** Command. Cancels the edit (reverts the live preview, no undo unit) and
   * exits edit mode. */
  cancelTextEdit() {
    this.transientPreview = null; // the whole preview is about to go; no need to revert it first
    this.textEditing = null;
    this.cancelPreview();
  }

  /**
   * [ROUND 15.2] Command. The ONE dismissal decision every "something else
   * happened mid-edit" gate calls (Esc, click-away, selectMany, the
   * slideIndex/selection accessors, mode→present, deleteSelection/
   * purgeSelection on the edited item): commit if the edited item still
   * EXISTS on the current slide (one undo unit, same as Esc — manifest:
   * "Keep the one-undo-unit commit semantics"), else cancel (nothing to
   * commit — the item is gone, e.g. purged or deactivated mid-edit). A no-op
   * when nothing is being edited, so every call site can call it
   * unconditionally without its own `if (app.textEditing)` guard.
   */
  dismissTextEdit() {
    if (!this.textEditing) return;
    const stillExists = !!this.state().items?.[this.textEditing.itemId];
    if (stillExists) this.commitTextEdit();
    else this.cancelTextEdit();
  }

  /** [ROUND 15.2] Command. Enters fullscreen presenter mode, dismissing any
   * live WYSIWYG text edit first (manifest: "presenter entry ... must all
   * commit ... never strand the overlay" — PresentMode has no canvas/overlay
   * DOM at all, so an un-dismissed edit would simply vanish with no exit
   * path). The one `mode = "present"` write site (the palette/toolbar
   * "Present" command) routes through here instead of writing `mode` bare. */
  enterPresentMode() {
    this.dismissEdit();
    this.exitCanvasMode(); // same reason: the presenter has no canvas for a mode to own
    this.mode = "present";
  }

  // ── WYSIWYG LaTeX editing (MathLive overlay) ───────────────────────────────
  // Mirrors the text lifecycle (begin/preview/commit/cancel/dismiss) but with a
  // canvas-SUPPRESSION + DOM-overlay model instead of canvas-as-truth (MathJax
  // has no caret to self-draw from — see latexEditing's doc).

  /** Command. Enters in-place edit on a latex item: selects it (Inspector
   * reflects it) and sets `latexEditing`. CanvasView suppresses the canvas
   * equation and mounts the LatexEditController `<math-field>` at its world
   * pose. No-op if already editing this item. */
  beginLatexEdit(itemId) {
    if (this.latexEditing?.itemId === itemId) return;
    this.selection = itemId;
    this.latexEditing = { itemId };
  }

  /** Command. Live-stages the edited latex string into previewDelta (so the
   * Inspector `latex` row reflects live and commit keyframes it as one undo
   * unit). The canvas equation is suppressed during edit, so this does NOT
   * re-typeset the canvas per keystroke — the visible math is the DOM field
   * itself (the no-jank rule: MathJax runs once, on commit). */
  previewLatexValue(latex) {
    if (!this.latexEditing || this.latexEditing.closing) return;
    this.setPreview([[["items", this.latexEditing.itemId, "latex"], latex]]);
  }

  /** Command. Commits the edit as ONE undo unit and enters the CLOSING phase.
   * commitPreview keyframes the final latex + clears previewDelta; setting
   * `closing:true` UN-suppresses the canvas equation (paint() stops skipping
   * it) so the freshly re-typeset MathJax render appears BENEATH the still-
   * mounted MathLive field, which the controller then fades out — a true
   * crossfade that masks the KaTeX↔tex-svg glyph pop. The un-suppress itself
   * fires the emit() → ensureLatexTypeset for the new value (no separate pre-
   * warm needed); the fade gives it time to land. finishLatexEdit unmounts. */
  commitLatexEdit() {
    const editing = this.latexEditing;
    if (!editing || editing.closing) return;
    if (this.previewDelta) this.commitPreview();
    this.latexEditing = { itemId: editing.itemId, closing: true };
  }

  /** Command. Ends the closing crossfade — unmounts the controller. Called by
   * LatexEditController when its fade-out transition completes. */
  finishLatexEdit() {
    this.latexEditing = null;
  }

  /** Command. Cancels the edit (drops the live preview, no undo unit) and exits
   * immediately (no crossfade — nothing changed on the canvas). */
  cancelLatexEdit() {
    this.latexEditing = null;
    this.cancelPreview();
  }

  /** Command. The latex twin of dismissTextEdit: the ONE decision every mid-edit
   * boundary calls — commit if the edited item still exists (one undo unit),
   * else cancel. No-op when not editing or already closing (so a second dismiss
   * during the fade is inert). */
  dismissLatexEdit() {
    if (!this.latexEditing || this.latexEditing.closing) return;
    const stillExists = !!this.state().items?.[this.latexEditing.itemId];
    if (stillExists) this.commitLatexEdit();
    else this.cancelLatexEdit();
  }

  /** Query. The itemId of whichever in-place edit (text OR latex) is active, or
   * null. The ONE thing every "selection/slide/mode changed mid-edit" guard
   * reads so it need not know which editor is open. */
  get editingItemId() {
    return this.textEditing?.itemId ?? this.latexEditing?.itemId ?? null;
  }

  /** Command. Dismisses whichever in-place edit (text or latex) is active — the
   * single gate slide-switch / selection-change / present-entry / delete /
   * purge all call. Each dismiss is a no-op when its editor isn't open, so this
   * is safe to call unconditionally. */
  dismissEdit() {
    this.dismissTextEdit();
    this.dismissLatexEdit();
  }

  // ── WYSIWYG code editing (multi-line CodeEditController overlay) ────────────
  // The code-property analog of the latex lifecycle (begin/preview/commit/
  // cancel/dismiss) — a canvas-SUPPRESSION + DOM-overlay model. `codeEditing` =
  // { itemId, property, language } (or { …, closing:true } during the exit
  // crossfade). `property` names WHICH multi-line string is edited ("definition"
  // for mermaid, "code" for codeblock); `language` drives the editor's syntax
  // highlighting. The canvas render of the item is SUPPRESSED while editing (see
  // CanvasView paint()), so the string stages into previewDelta with NO
  // per-keystroke re-render; `closing:true` un-suppresses it so the freshly
  // re-rendered content appears beneath the fading editor panel. APPENDED as a
  // self-contained section (new field + new methods; no existing method touched)
  // per the concurrent-edit constraint. dismissCodeEdit is reached from
  // App.svelte's click-away and the controller's Escape/⌘⏎.

  /** { itemId, property, language } while a widget's code string is edited in
   * place (or { …, closing:true } during the exit crossfade), else null. A
   * reactive $state field (CanvasView's codeEditNode + the paint suppression
   * both derive from it), exactly like `latexEditing`. */
  codeEditing = $state(null);

  /** Command. Enters in-place code edit on a widget's `property` string: closes
   * any other in-place edit, selects the item, and sets `codeEditing`.
   * CanvasView suppresses the item's canvas render and mounts the
   * CodeEditController. No-op if already editing this item+property. */
  beginCodeEdit(itemId, property, language = null) {
    if (this.codeEditing?.itemId === itemId && this.codeEditing?.property === property) return;
    this.dismissTextEdit();  // close any other in-place editor first (no-op if none)
    this.dismissLatexEdit();
    this.selection = itemId;
    this.codeEditing = { itemId, property, language };
  }

  /** Command. Live-stages the edited string into previewDelta (Inspector
   * reflects live; commit keyframes it as one undo unit). The canvas render is
   * suppressed during edit, so this does NOT re-render the item per keystroke —
   * it re-renders once on commit (the no-jank rule). No-op while closing. */
  previewCodeValue(value) {
    if (!this.codeEditing || this.codeEditing.closing) return;
    this.setPreview([[["items", this.codeEditing.itemId, this.codeEditing.property], value]]);
  }

  /** Command. Commits the edit as ONE undo unit and enters the CLOSING phase:
   * commitPreview keyframes the staged string; setting `closing:true`
   * un-suppresses the item's canvas render (which re-emits → re-renders the new
   * value) beneath the still-mounted editor panel, which the controller fades
   * out. finishCodeEdit unmounts. */
  commitCodeEdit() {
    const editing = this.codeEditing;
    if (!editing || editing.closing) return;
    if (this.previewDelta) this.commitPreview();
    this.codeEditing = { ...editing, closing: true };
  }

  /** Command. Ends the closing crossfade — unmounts the controller. Called by
   * CodeEditController when its fade-out transition completes. */
  finishCodeEdit() {
    this.codeEditing = null;
  }

  /** Command. Cancels the edit (drops the live preview, no undo unit) and exits
   * immediately. Also the controller's forced-unmount safety (item left the
   * slide mid-edit) so no dangling previewDelta survives. */
  cancelCodeEdit() {
    this.codeEditing = null;
    this.cancelPreview();
  }

  /** Command. The code twin of dismissLatexEdit: commit if the edited item
   * still exists (one undo unit), else cancel. No-op when not editing or already
   * closing (so a second dismiss during the fade is inert). */
  dismissCodeEdit() {
    if (!this.codeEditing || this.codeEditing.closing) return;
    const stillExists = !!this.state().items?.[this.codeEditing.itemId];
    if (stillExists) this.commitCodeEdit();
    else this.cancelCodeEdit();
  }

  // ── Item operations ────────────────────────────────────────────────────────

  addItem(defaults) {
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    // active:true is keyframed explicitly ON the creation slide — the
    // manifest's visibility model: everything defaults invisible; creation is
    // where visibility switches on, so objects appear at their own slide.
    const state = { ...defaults, active: true, z: (zs.length ? Math.max(...zs) : 0) + 1 };
    const [doc, id] = withNewItem(this.doc, this.slideIndex, state);
    this.commit(withNormalizedZ(doc));
    this.selection = id;
    // NO WIDGET TYPE IS NAMED HERE, deliberately. The one that used to be — 14.3's
    // "a fresh empty filmstrip auto-opens its video picker" — is a CREATION
    // behaviour, so the filmstrip now declares `placement: "bbox_then_asset"` and
    // web/widget_handlers.js owns it. Reading a type name in addItem made the prompt
    // fire on every route in (paste, duplicate, a rig builder), not on the placement
    // gesture 14.3 actually described.
  }

  /**
   * Command (one undo unit). Assembles the TELESCOPIC MAGNIFIER rig — a
   * "zoom-into-this" detail-loupe callout — as THREE items wired by `=`
   * equations to a shared tween VARIABLE `t` (default 0):
   *   1. a SOURCE MARKER outline filling the `source` rect (the region magnified),
   *   2. a demo_magnify LENS that samples the source centre and, as t→1, pulls
   *      out to the `lens` rect + grows + zooms (identity at t=0), and
   *   3. a TANGENT-LINES widget whose two shapes track the source and the lens.
   * The user animates the rig by keyframing / binding the `t` variable (e.g.
   * `= time`). shapeKind ∈ {"circle","box"} proves the geometry is general.
   * Items are created source→lens→tangent so every `@id` reference is BACKWARD
   * (points at an already-created item) — no dangling refs. Each item spreads
   * its plugin's registry defaults FIRST, then the builder's equation overrides,
   * so the rig loads with zero missing-default repairs. z: lens lowest of the
   * three (so it samples only the backdrop below, not its own callout), then
   * the tangents, then the source marker on top. Selects the lens.
   *
   * THE TWO RECTS ARE THE GESTURE (#189: "I first click and drag to create the
   * first one and then I click and drag again to create the second one"), supplied
   * by the telescopic_rig creation mode. Omitting them falls back to
   * telescopicDefaultRects() — the drop-in-place geometry the constants describe —
   * so the palette entry, a script, and the gesture all go through this one command.
   *
   * @param {"circle"|"box"} shapeKind - the source/lens/tangent geometry family
   * @param {{x,y,w,h}} [source] - world rect of the region magnified
   * @param {{x,y,w,h}} [lens] - world rect the lens occupies at t = 1
   */
  insertTelescopicMagnifier(shapeKind = "circle", source = null, lens = null) {
    const rects = telescopicDefaultRects();
    const sourceRect = source ?? rects.source;
    const lensRect = lens ?? rects.lens;
    // 1. the shared tween parameter — a document variable, default 0, on the
    //    current slide. All rig motion is a function of it (bind it to = time).
    let doc = keyframed(this.doc, this.slideIndex, ["vars", TELESCOPIC.TWEEN_VAR], 0);
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    const baseZ = (zs.length ? Math.max(...zs) : 0) + 1; // above all existing content
    const withDefaults = (overrides, z) => ({ ...this.registry.get(overrides.type).defaults, ...overrides, active: true, z });
    // 2. SOURCE marker (no refs) — created first so the lens/tangents can point
    //    back at it. z on TOP so the loupe never magnifies its own marker.
    const sourceOv = telescopicSourceOverrides({ shapeKind, source: sourceRect });
    let sourceId;
    [doc, sourceId] = withNewItem(doc, this.slideIndex, withDefaults(sourceOv, baseZ + 2));
    // 3. LENS (refs the source) — lowest of the three so it samples only the
    //    backdrop drawn below it.
    const lensOv = telescopicLensOverrides({ sourceId, shapeKind, source: sourceRect, lens: lensRect });
    let lensId;
    [doc, lensId] = withNewItem(doc, this.slideIndex, withDefaults(lensOv, baseZ));
    // 4. TANGENT lines (ref both) — between the lens and the marker in z.
    const tangentOv = telescopicTangentOverrides({ sourceId, lensId, shapeKind });
    [doc] = withNewItem(doc, this.slideIndex, withDefaults(tangentOv, baseZ + 1));
    this.commit(withNormalizedZ(doc));
    this.selection = lensId;
  }

  // ── Groups (manifest "GROUPS", rough draft — the armature-shaped parent) ────

  /**
   * Query. The itemIds that a Group Selection would make members: the current
   * selection, minus purgeable:false widgets (the camera never joins a group)
   * and minus items ALREADY in a group (no nested-group creation in the rough
   * draft — flagged). Order = selection order. Groups themselves are excluded
   * (grouping groups = nesting, out of scope).
   */
  #groupableSelection() {
    const membership = groupMembership(this.nodes());
    return this.selectedIds().filter((id) => {
      const type = this.state().items?.[id]?.type;
      if (!type) return false;
      const plugin = this.registry.get(type);
      if (plugin.capabilities.purgeable === false) return false; // camera
      if (type === "group") return false; // no group-of-groups (rough draft)
      if (membership.has(id)) return false; // already grouped
      return true;
    });
  }

  /** Query. Can the current selection be grouped? (≥2 groupable members — a
   * one-item group is inert, and PowerPoint requires two+ to group.) */
  canGroup() {
    return this.#groupableSelection().length >= 2;
  }

  /**
   * Command (one undo unit). "Group Selection" (manifest GROUPS): creates a
   * group widget whose bbox = the selection's collective world AABB and whose
   * `members` = the selected ids, capturing the group's creation transform as
   * its BIND POSE (bind = {x,y,rotation:0,scale:1} at the AABB origin — so the
   * group sits exactly at its bind pose the instant it is made and moves
   * nothing until the user transforms it; manifest "Bind state"). Members stay
   * STORED items (their deltas are untouched); the group's influence composes
   * onto their world transforms in the derivation stage. Selects the new group.
   * No-op (reported) with fewer than two groupable items.
   */
  groupSelection() {
    const members = this.#groupableSelection();
    if (members.length < 2) {
      console.warn("Group Selection: needs at least two groupable items (camera and already-grouped items are excluded) — nothing grouped.");
      return;
    }
    const boxes = this.selectedNodes()
      .filter((n) => members.includes(n.itemId))
      .map(rotatedBBoxAABB)
      .filter(Boolean);
    if (boxes.length === 0) {
      console.warn("Group Selection: selected items have no bounding box — nothing grouped.");
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    // The group's own transform IS its bind pose at creation: x/y = AABB origin,
    // rotation 0, scale 1. Storing bind = the same params makes influence the
    // identity until the user moves the group (re-pose invariance).
    const state = {
      ...this.registry.get("group").defaults,
      x: minX, y: minY, w: maxX - minX, h: maxY - minY,
      rotation: 0, scale: 1,
      members: [...members],
      bind: { x: minX, y: minY, rotation: 0, scale: 1 },
      active: true,
      z: (zs.length ? Math.max(...zs) : 0) + 1,
    };
    const [doc, id] = withNewItem(this.doc, this.slideIndex, state);
    this.commit(withNormalizedZ(doc));
    this.selection = id;
  }

  /**
   * Command (one undo unit). "Ungroup" (manifest UNGROUP spec + Round 17.3): for
   * every SELECTED group, BAKES each member's group-influenced DERIVED world back
   * into numeric x/y/rotation/scale keyframes AT EVERY SLIDE the member exists
   * (ungroupBakeSlides — the change points where the member's own transform OR
   * the group's influence keyframes), then PURGES the group. All in one undo unit.
   * No-op (reported) when no group is selected.
   *
   * WHY PER-SLIDE (17.3, user: "when deleting a group, the things inside should
   * not move … in every place"): a member keyframed across slides, or a group
   * keyframed across slides, has a DIFFERENT influenced world per slide. Baking
   * only the CURRENT slide (the pre-17.3 behavior) left every OTHER slide with the
   * un-influenced stored transform, so members JUMPED off-current-slide. The
   * invariant: after ungroup, each member's WORLD is byte-identical to before on
   * EVERY slide. Between two consecutive change points the influenced world is
   * constant, so a keyframe at each change point reproduces it everywhere.
   *
   * Baking math (per slide i): the member's derived node.world at slide i already
   * includes the group influence at slide i. worldTransform pivots a rotated box
   * about its center, so we back-solve the stored x/y via stateXYForCenterPivotWorld
   * and write rotation/scale straight from node.world — worldTransform(baked@i)
   * then reproduces node.world@i exactly. Non-bbox members (no w/h) get x/y/rot/
   * scale written directly (their world is un-pivoted). Worlds are computed from
   * the ORIGINAL doc (group still present) BEFORE any keyframe is written, so a
   * bake never reads its own already-baked (double-counted) value.
   *
   * FLAGGED ROUGH-DRAFT LIMITATION (unchanged from the single-slide bake): the
   * back-solve assumes the member uses the default CENTER rotation pivot (the
   * `self.anchors.center` equation every normally-created item carries — the SAME
   * assumption the rotated-resize commit relies on). A member with a CUSTOM
   * NUMERIC rotationAnchor bakes with a small position drift; deferred.
   */
  ungroupSelection() {
    const groups = this.selectedNodes().filter((n) => n.type === "group");
    if (groups.length === 0) {
      console.warn("Ungroup: no group is selected — nothing to ungroup.");
      return;
    }
    const origDoc = this.doc; // read every member world from the ORIGINAL (group-present) doc
    const freed = new Set();
    // 1. Compute the full bake (memberId → [{slide, x, y, rotation, scale}]) from
    //    the original doc, so no bake reads an already-written keyframe.
    const bakes = new Map();
    for (const g of groups) {
      for (const memberId of g.state.members ?? []) {
        if (bakes.has(memberId)) continue; // a member belongs to ONE group (no nested groups)
        const perSlide = [];
        for (const slide of ungroupBakeSlides(origDoc, memberId, g.itemId)) {
          const state = evaluateState(foldState(origDoc, slide, 1), this.registry).state;
          const m = deriveRenderTree(state, this.registry).find((n) => n.itemId === memberId);
          if (!m) continue; // member not active on this slide — nothing to bake there
          const world = m.world; // group-influenced (derivation stage) at THIS slide
          const w = m.state.w, h = m.state.h;
          const xy = (typeof w === "number" && typeof h === "number")
            ? stateXYForCenterPivotWorld(world, w, h) // undo the center-pivot re-parametrization
            : { x: world.x, y: world.y };
          perSlide.push({ slide, x: xy.x, y: xy.y, rotation: world.rotation, scale: world.scale });
        }
        bakes.set(memberId, perSlide);
        freed.add(memberId);
      }
    }
    // 2. Write every keyframe, then purge every group — one undo unit.
    let doc = origDoc;
    for (const [memberId, perSlide] of bakes)
      for (const { slide, x, y, rotation, scale } of perSlide) {
        doc = keyframed(doc, slide, ["items", memberId, "x"], x);
        doc = keyframed(doc, slide, ["items", memberId, "y"], y);
        doc = keyframed(doc, slide, ["items", memberId, "rotation"], rotation);
        doc = keyframed(doc, slide, ["items", memberId, "scale"], scale);
      }
    for (const g of groups) doc = withItemPurged(doc, g.itemId);
    this.commit(doc);
    // Select the freed members (the group is gone). Empty → deselect.
    this.selectMany([...freed]);
  }

  // ── Copy / paste / duplicate (manifest 14.10 AMENDED + 14.9) ────────────────
  // Whole-object by default; single properties via the palette submenu.
  // Clipboard payloads are tagged JSON: {powerrp_items: {sourceId: state}} or
  // {powerrp_props: {key: value}}.
  //
  // THE SELECTION IS THE UNIT (user: "i should be able to copy paste selections
  // of objects which right now I can't"). The payload carries EVERY selected
  // item's state KEYED BY ITS SOURCE ID, because the ids are what make a
  // SUBGRAPH clone possible: copying A and B where A references B must paste A'
  // referencing B', while a reference from A to some C that was NOT copied must
  // still point at C. core/document.js clonedItemStates is that boundary; the
  // source ids in this payload are its `idMap` key set. `powerrp_item`
  // (singular, one state, NO id) is the LEGACY payload shape and is still read —
  // see #readClipboardPayload.
  //
  // 14.10 AMENDED ARCHITECTURE (user verbatim: "u can copy it into the browser
  // cookie session thing in case i have two presentations open the server can
  // keep track of that. but my local clipboard, u can copy a rendered PNG of
  // that element ... pasting triggers the serverside clipboard"):
  //   COPY  → (1) the item JSON goes to the SERVER-SIDE clipboard, keyed by the
  //           browser session cookie (projectApi.setClipboard) — SHARED across
  //           two open presentations of the same browser; (2) a RENDERED PNG of
  //           the element at its pixel resolution goes to the OS clipboard.
  //   PASTE → reads the SERVER-SIDE clipboard (projectApi.getClipboard) and
  //           inserts the object. navigator.clipboard.readText is RETIRED for
  //           items — the whole permission saga (the old dead-paste bug: a
  //           silently-denied readText no-op'd the paste) is gone.
  // WHY the server, not the OS clipboard, for the item JSON: the OS clipboard
  // can't reliably carry an app's private JSON across tabs, and reading it needs
  // a permission browsers deny silently (the root cause of the paste-does-
  // nothing bug). The server keys the copy by session cookie, so a second open
  // presentation pastes it with zero permission prompts.
  //
  // DISAMBIGUATION (the canvas-clipboard round-trip): copying an element ALSO
  // puts a rendered PNG on the OS clipboard, so a plain Cmd+V's `paste` event
  // carries an image (OUR render). We store the SIGNATURE of that PNG
  // (imageSignature) as `png_sig` ALONGSIDE the item JSON on the SERVER — not in
  // a per-tab in-memory field — so a SECOND open presentation (different tab,
  // same session) can still recognize the render as ours: on paste we sign the
  // incoming image and compare to the server payload's png_sig. Match → paste
  // the ELEMENT; mismatch (or no internal copy) → paste the image as a new
  // widget. Storing the signature on the server (not the bytes in a tab-local
  // field) is what makes the cross-tab round-trip and the stale-copy either/or
  // both correct — see pasteFromClipboard.

  /**
   * Query. The itemIds a clone (copy or Duplicate) covers: the selection,
   * expanded TRANSITIVELY through group membership so a selected group travels
   * with everything it controls. Exactly the #zOrderBlock rule (manifest 15.7,
   * "when i move a group to front or back it should move all elements in it
   * too"), applied to cloning for the same reason: a group's members ARE its
   * content, so a group cloned WITHOUT them would be a second group steering the
   * ORIGINAL items. Multi-root and cycle-safe (`seen`), matching flipTargetIds.
   *
   * Membership is read from the RAW folded state, not from derived nodes, so a
   * member that is merely HIDDEN on this slide (active: false) still travels —
   * a member left behind is exactly the double-steering case above.
   *
   * @param {string[]} ids - the roots (an id absent from this slide is dropped)
   * @returns {string[]} roots first, then the members they pulled in
   */
  #cloneSet(ids) {
    const items = this.rawState().items ?? {};
    const set = new Set();
    const visit = (id) => {
      if (set.has(id) || !items[id]) return;
      set.add(id);
      if (items[id].type === "group" && Array.isArray(items[id].members))
        for (const m of items[id].members) visit(m);
    };
    for (const id of ids) visit(id);
    return [...set];
  }

  /** Query. {sourceId: rawItemState} for `ids` — the payload body every clone
   *  path (copy, Duplicate) ships. RAW state: equations copy as equations, not
   *  their evaluated snapshots. Ids with no state on this slide drop out. */
  #cloneStates(ids) {
    const items = this.rawState().items ?? {};
    return Object.fromEntries(ids.filter((id) => items[id]).map((id) => [id, items[id]]));
  }

  /** Command (async). COPY the SELECTION (the canvas-clipboard COPY half).
   *  Renders the selection PNG FIRST so its signature can travel WITH the item
   *  JSON: writes {powerrp_items: {sourceId: rawState}, png_sig} to the SERVER-
   *  SIDE session clipboard (equations stay equations, source ids ride along so
   *  paste can reroute internal references), then writes that same PNG to the OS
   *  clipboard for pasting into other apps. A server-write failure aborts
   *  loudly (nothing to paste back); an OS-write failure is reported but not
   *  fatal (the internal paste still works). */
  async copySelection() {
    const items = this.#cloneStates(this.#cloneSet(this.selectedIds()));
    if (Object.keys(items).length === 0) return;
    // Render the OS-clipboard PNG first so its signature rides WITH the payload
    // (a camera-only selection has no bbox → null png, and no png_sig).
    const png = await this.#renderSelectionPng();
    const payload = { powerrp_items: items };
    if (png) payload.png_sig = imageSignature(png);
    // 1. Item JSON (+ signature) → the server-side session clipboard.
    try {
      await projectApi.setClipboard(JSON.stringify(payload));
    } catch (e) {
      console.error("Copy: could not reach the server-side clipboard (paste will not work until the project server is up):", e.message);
      return; // no point writing a PNG the user can't paste back internally
    }
    // 2. Rendered PNG → the OS clipboard (for pasting into OTHER apps). Failure
    //    is reported, not fatal — the internal paste still works.
    if (png) await this.#writeImagePngToOs(png);
  }

  /** Command (async). Writes PNG `bytes` to the OS clipboard as image/png.
   *  Reports loudly (and no-ops) when the browser lacks the async image-write
   *  API (an insecure/older context) or when the write is denied — a copy must
   *  never fail silently, and there is no in-app fallback for a system image. */
  async #writeImagePngToOs(bytes) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      console.warn("Copy: this browser has no Clipboard image-write API — the item is on the server clipboard (paste works), but no PNG was placed on the OS clipboard.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
    } catch (e) {
      console.error("Copy: OS-clipboard image write was denied or failed (the item is still on the server clipboard — internal paste works):", e.message);
    }
  }

  async copyProperty(key) {
    if (!this.selection) return;
    const value = this.storedItemValue(this.selection, key.split(".")); // dotted keys = nested paths
    if (value === undefined) return;
    try {
      await projectApi.setClipboard(JSON.stringify({ powerrp_props: { [key]: value } }));
    } catch (e) {
      console.error("Copy Property: could not reach the server-side clipboard:", e.message);
    }
  }

  /** Query (async; reads the server). The parsed SERVER-SIDE clipboard payload
   *  ({powerrp_items[, png_sig]} or {powerrp_props}), or null when the clipboard
   *  is empty, unreachable, unparseable, or holds no PowerRP payload. Every
   *  failure is reported loudly; the null return distinguishes those cases for
   *  the caller (no OS-clipboard readText, no permission saga).
   *
   *  A LEGACY {powerrp_item: state} payload (one state, no source id — what a
   *  copy made before the selection became the unit, and what a session
   *  clipboard written by an older build still holds) is normalized to the
   *  current one-entry shape HERE, at the read boundary, so there is exactly ONE
   *  insert path below rather than a fork per payload era (the load-boundary
   *  migration pattern). Its synthetic key can never collide with a real
   *  reference: uuid() ids are 8 chars of hex/base36. */
  async #readClipboardPayload() {
    let raw;
    try {
      raw = await projectApi.getClipboard();
    } catch (e) {
      console.error("Paste: could not read the server-side clipboard (is the project server up?):", e.message);
      return null;
    }
    if (!raw) return null;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      console.error("Paste: the server clipboard held unparseable JSON:", e.message);
      return null;
    }
    if (payload?.powerrp_item && !payload.powerrp_items)
      payload = { ...payload, powerrp_items: { [LEGACY_CLIPBOARD_SOURCE_ID]: payload.powerrp_item } };
    if (!payload?.powerrp_items && !payload?.powerrp_props) {
      console.warn("Paste: the server clipboard holds no PowerRP item or property payload.");
      return null;
    }
    return payload;
  }

  /** Command (async). Paste the last-copied ELEMENT/property from the SERVER-
   *  SIDE session clipboard (the internal paste; no OS image involved). Empty
   *  clipboard is reported, never a silent no-op. Kept as its own command so
   *  the palette entry and runCommand("paste") route here directly. */
  async pasteClipboard() {
    const payload = await this.#readClipboardPayload();
    if (!payload) {
      console.warn("Paste: the server-side clipboard is empty for this browser session (nothing copied yet).");
      return;
    }
    this.#insertClipboardPayload(payload);
  }

  /**
   * Command (async). THE Ctrl+V authority (App.svelte onPaste routes here). The
   * either/or that makes the canvas clipboard bidirectional:
   *   • OS clipboard carries file(s): if one is an image whose signature equals
   *     the server payload's png_sig, this is OUR OWN element render → paste the
   *     ELEMENT (round-trip, cross-tab safe: the signature lives on the server).
   *     Otherwise the file(s) are EXTERNAL → upload + insert each as an image/
   *     video widget (pasteFiles).
   *   • No files on the OS clipboard → the internal element/property paste.
   * Exactly one of the two happens per paste — no double insert (the keydown
   * binding is nativeEvent, so it does not also fire).
   *
   * @param {File[]} files - the OS clipboard's files (App.svelte passes
   *   `[...clipboardData.files]`); empty for a plain internal paste.
   */
  async pasteFromClipboard(files) {
    const imageFile = files.find((f) => f.type.startsWith("image/"));
    if (imageFile) {
      const bytes = new Uint8Array(await imageFile.arrayBuffer());
      const payload = await this.#readClipboardPayload();
      // Signature match → the pasted image is our own element render; paste the
      // ELEMENT, not the flattened bitmap (behavior 3 + 4).
      if (payload?.png_sig && payload.png_sig === imageSignature(bytes)) {
        this.#insertClipboardPayload(payload);
        return;
      }
    }
    if (files.length) {
      await this.pasteFiles(files); // external image/video/file → new widget
      return;
    }
    await this.pasteClipboard(); // no OS files → internal element/property paste
  }

  /** Command (one undo unit). Inserts a tagged clipboard payload
   *  ({powerrp_items} or {powerrp_props}) into the current slide:
   *    - powerrp_items: routed to #cloneStatesIntoSlide (14.9's "one canonical
   *      clone home", shared with duplicateSelection).
   *    - powerrp_props: applies the property values to the current selection. */
  #insertClipboardPayload(payload) {
    if (payload.powerrp_items) {
      this.#cloneStatesIntoSlide(payload.powerrp_items);
    } else if (payload.powerrp_props && this.selection) {
      let doc = this.doc;
      for (const [key, value] of Object.entries(payload.powerrp_props))
        doc = keyframed(doc, this.slideIndex, ["items", this.selection, ...key.split(".")], value);
      this.commit(doc);
    }
  }

  /**
   * Command (ONE undo unit). THE CANONICAL CLONE HOME (14.9): drops a set of
   * {sourceId: rawItemState} into the current slide as NEW items and selects
   * them. Shared by paste and Duplicate — the difference between those two is
   * only WHERE the states came from (the server clipboard vs. the live selection),
   * never what cloning means.
   *
   * The rules, all of them pre-existing and now stated exactly once:
   *   • INTERNAL REFERENCES REROUTE, EXTERNAL ONES DO NOT (core/document.js
   *     clonedItemStates). The `states` KEY SET is the boundary, which is why the
   *     payload carries source ids at all.
   *   • ONE CAMERA PER DOCUMENT: a camera in the set keyframes its ASPECTS onto
   *     the existing camera instead of cloning (user spec). It never gets a new
   *     id, so it is not part of the reroute boundary — a reference to the camera
   *     stays a reference to THE camera, which is correct.
   *   • OFFSET one spacing step, the convention PowerPoint uses for paste-in-place
   *     collisions (precedent, not an invented constant). A uniform per-item bump
   *     IS a rigid translation, so relative positions survive. Equation-valued
   *     coordinates are left VERBATIM — offsetting a string would concatenate
   *     ("circle.x + 10" + 16); such a copy keeps its binding and lands wherever
   *     the equation says.
   *   • z stacked above the current max, preserving relative order; active: true
   *     on the creation slide (the visibility model — creation is where an item
   *     switches on).
   * A reference that leaves the set and names an item THIS DOCUMENT DOES NOT HAVE
   * is reported: that is a dangling reference (a purged item, or a cross-document
   * paste) and it must not land silently.
   *
   * @param {object} states - {sourceItemId: rawItemState}
   */
  #cloneStatesIntoSlide(states) {
    const OFFSET = 16;
    const bump = (v) => (typeof v === "number" ? v + OFFSET : v);
    // ONE camera per document: partitioned out BEFORE ids are minted.
    const existingCamera = this.nodes().find((n) => n.type === "camera") ?? null;
    const cloneable = {};
    const cameras = [];
    for (const [id, s] of Object.entries(states)) {
      if (s.type === "camera" && existingCamera) cameras.push(s);
      else cloneable[id] = s;
    }
    if (Object.keys(cloneable).length === 0 && cameras.length === 0) {
      console.warn("Clone: the payload held no item states — nothing to insert.");
      return;
    }
    const idMap = new Map(Object.keys(cloneable).map((id) => [id, uuid()]));
    const { states: clones, external } = clonedItemStates(cloneable, idMap, this.registry);
    this.#reportDanglingRefs(external);
    let nextZ = (this.nodes().map((n) => n.state.z ?? 0).reduce((a, b) => Math.max(a, b), 0)) + 1;
    let doc = this.doc;
    for (const [newId, clone] of Object.entries(clones))
      doc = keyframed(doc, this.slideIndex, ["items", newId], {
        ...clone, active: true, z: nextZ++, x: bump(clone.x ?? 0), y: bump(clone.y ?? 0),
      });
    for (const s of cameras)
      for (const key of ["x", "y", "w", "h"])
        doc = keyframed(doc, this.slideIndex, ["items", existingCamera.itemId, key], s[key]);
    // Normalize only when items were actually ADDED — a camera-aspect merge adds
    // no z, so renumbering the whole document there would be a mutation the
    // camera-paste rule never made.
    this.commit(Object.keys(clones).length ? withNormalizedZ(doc) : doc); // ONE commit = one undo unit
    this.selectMany([...Object.keys(clones), ...(cameras.length ? [existingCamera.itemId] : [])]);
  }

  /** Command (reports). Warns for every id a clone still references that this
   *  document does not contain — a DANGLING reference: the source item was
   *  purged, or this is a cross-document paste where the reference's target
   *  simply does not exist here. The clone keeps the reference verbatim (so the
   *  user can see and repair it, the storedToDisplay ruling) and the render-time
   *  affordances report it too; this makes the paste itself say so. Ids present
   *  in the document are legitimate external edges and stay silent. */
  #reportDanglingRefs(external) {
    const known = new Set(this.doc.slides.flatMap((s) => Object.keys(s.delta.items ?? {})));
    const dangling = external.filter((id) => !known.has(id));
    if (dangling.length)
      console.warn(`Paste: the pasted items reference ${dangling.length} item(s) that do not exist in this document — those references are kept verbatim so you can repair them: ${dangling.join(", ")}`);
  }

  // ── Duplicate (manifest 14.9: "duplicate object should be a thing") ──────────
  // Duplicate = the same clone as copy+paste, but WITHOUT the clipboard round-trip
  // (local, immediate) and as ONE undo unit for the whole selection. Both routes
  // run #cloneStatesIntoSlide — the ONE canonical clone home the manifest asks
  // for — rather than a second cloning path. Multi-select duplicates every
  // duplicable member.

  /** Query. The selected itemIds that Duplicate would clone: every selected item
   *  EXCEPT non-purgeable widgets (the camera is exactly one per document — it
   *  cannot be duplicated, mirroring the paste-a-camera-merges rule). Order =
   *  selectedIds() order. */
  #duplicableSelection() {
    return this.selectedIds().filter((id) => {
      const type = this.rawState().items?.[id]?.type;
      if (!type) return false;
      return this.registry.get(type).capabilities.purgeable !== false; // exclude the camera
    });
  }

  /** Query. Can the current selection be duplicated? (at least one duplicable
   *  item — a camera-only selection cannot). Drives the command's `when`. */
  canDuplicate() {
    return this.#duplicableSelection().length > 0;
  }

  /**
   * Command (ONE undo unit). Duplicates every duplicable selected item through
   * THE canonical clone home (#cloneStatesIntoSlide): each gets a NEW UUID, the
   * SAME raw state (equations verbatim) with references INTO the duplicated set
   * rerouted to the new copies, offset one spacing step, z stacked above the
   * current max. All the new items commit together (one snapshot = one undo) and
   * become the new selection. No-op (reported) when nothing duplicable is
   * selected.
   */
  duplicateSelection() {
    const ids = this.#cloneSet(this.#duplicableSelection());
    if (ids.length === 0) {
      console.warn("Duplicate: nothing duplicable is selected (the camera cannot be duplicated).");
      return;
    }
    this.#cloneStatesIntoSlide(this.#cloneStates(ids));
  }

  // ── Paste-to-upload (manifest 13.3): an EXTERNAL image/video/file on the OS
  // clipboard uploads through the SAME path as an OS-file drop (app.uploadAsset
  // → insertImageAsset/insertVideoAsset), landing at the camera-view center
  // (paste has no drop point, unlike a canvas drag-drop — the same "at=null"
  // fallback insertImageAsset already uses for the Asset Explorer's insert
  // button). pasteFromClipboard is the DECISION layer above this: it only calls
  // pasteFiles once it has ruled out "this image is our own copied element
  // render" (signature match), so pasteFiles no longer needs its own
  // self-render guard — by the time we get here the file is known-external.
  // Upload hash-dedup across DIFFERENT assets stays EXPLICITLY DEFERRED (13.3).

  /** Command. Uploads each File in `files` to the current project's assets
   *  (app.uploadAsset — the same upload endpoint the canvas OS-file drop and
   *  the Asset Explorer's file input use) and inserts the matching widget
   *  (image/video by MIME) at the camera-view center. Kinds with no canvas
   *  widget still upload (they land in the asset library) and are reported,
   *  never silently dropped. A failure in any step is REPORTED loudly
   *  (console.error) — a paste gesture must never fail silently. */
  async pasteFiles(files) {
    for (const file of files) {
      try {
        const up = await this.uploadAsset(file); // {ok, name, url}
        const kind = assetKindForFile(file);
        if (kind === "image") await this.insertImageAsset(up.url);
        else if (kind === "video") await this.insertVideoAsset(up.url);
        else console.warn(`Paste: uploaded "${up.name}" but no canvas widget exists for kind "${kind}" — it stays in the asset library.`);
      } catch (e) {
        console.error(`Paste-to-upload failed for "${file.name}":`, e);
      }
    }
  }

  /**
   * "Delete": keyframe active:false here — identity survives (symlink-safe).
   * Multi-select falls out naturally: deactivates EVERY selected item on this
   * slide in one undo unit. purgeable:false items (the camera) are skipped
   * (the command `when` already excludes a lone camera; in a mixed set the
   * camera stays put rather than erroring).
   *
   * KEEPS the selection (user ruling, round 11: "you shouldn't deselect
   * something when it's not visible anymore, that doesn't help anybody") —
   * a hidden item stays selected so the Inspector's visibility toggle can
   * flip it right back. Purge still deselects: a purged item no longer
   * exists to be selected.
   */
  deleteSelection() {
    const ids = this.selectedIds().filter((id) => this.registry.get(this.state().items?.[id]?.type)?.capabilities.purgeable !== false);
    if (ids.length === 0) return;
    // [ROUND 15.2] deactivate keeps the item OBJECT alive (just hidden), so
    // the edited item's in-progress text is worth keeping — commit it first
    // (one undo unit, same as Esc) rather than losing it to the deactivation
    // commit() below, which writes `this.doc` directly and does not know
    // about a live previewDelta (manifest: "item deletion while editing ...
    // must all commit ... never strand the overlay").
    this.dismissEdit();
    let doc = this.doc;
    for (const id of ids) doc = keyframed(doc, this.slideIndex, ["items", id, "active"], false);
    this.commit(doc);
  }

  /**
   * Command. The inverse of deleteSelection: keyframe active:true on this
   * slide for every selected item — the "Show all" set-action (user ruling:
   * BOTH explicit buttons, never a mixed-state guessing toggle). An item NOT
   * YET CREATED on this slide follows the ratified pre-creation semantics:
   * its FOLDED CREATION-SLIDE STATE is copied here + active:true, making
   * this slide the effective creation slide (it appears looking like
   * itself). One undo unit for the whole set. Keeps the selection.
   */
  showSelection() {
    const ids = this.selectedIds().filter((id) => this.registry.get(this.rawState().items?.[id]?.type ?? this.#creationState(id)?.type)?.capabilities.purgeable !== false);
    if (ids.length === 0) return;
    let doc = this.doc;
    for (const id of ids) {
      if (this.rawState().items?.[id]) {
        doc = keyframed(doc, this.slideIndex, ["items", id, "active"], true);
      } else {
        const creation = this.#creationState(id);
        if (!creation) {
          console.error(`Show all: item "${id}" has no creation state anywhere — skipped (loudly).`);
          continue;
        }
        // Leaf-wise keyframes (the commitPreview walk pattern) — nested
        // subtrees like rotationAnchor keyframe per-leaf, never as blobs.
        const walk = (tree, prefix) => {
          for (const [k, v] of Object.entries(tree)) {
            if (v !== null && typeof v === "object" && !Array.isArray(v)) walk(v, [...prefix, k]);
            else doc = keyframed(doc, this.slideIndex, [...prefix, k], v);
          }
        };
        walk({ ...creation, active: true }, ["items", id]);
      }
    }
    this.commit(doc);
  }

  /** Query. An item's folded state as of its ORIGINAL creation slide (the
   * first slide keying its type), or null if it is keyed nowhere. */
  #creationState(id) {
    const idx = keyframeIndices(this.doc, ["items", id, "type"])[0];
    return idx === undefined ? null : foldState(this.doc, idx, 1).items?.[id] ?? null;
  }

  /** True removal FROM EXISTENCE: every keyframe of each selected item on every
   * slide (multi-select falls out naturally). Skips purgeable:false (camera). */
  purgeSelection() {
    const ids = this.selectedIds().filter((id) => this.registry.get(this.state().items?.[id]?.type)?.capabilities.purgeable !== false);
    if (ids.length === 0) return;
    // [ROUND 15.2] purge is true removal, so if the edited item is IN the
    // purge set there is nothing left to commit — cancel (drop the pending
    // preview with no undo unit) rather than keyframing text onto an item
    // this very call is about to erase from every slide. An edit on some
    // OTHER item (not in `ids`) still gets the normal commit-before-mutate
    // (dismissTextEdit's existence check passes) so ITS in-progress text
    // survives an unrelated purge.
    const editId = this.editingItemId;
    if (editId !== null && ids.includes(editId)) { this.cancelTextEdit(); this.cancelLatexEdit(); }
    else this.dismissEdit();
    let doc = this.doc;
    for (const id of ids) doc = withItemPurged(doc, id);
    this.commit(doc);
    this.selection = null;
  }

  /**
   * Query. Which SELECTED items a keyframe freeze would actually change: the
   * ones carrying at least one keyframe past their creation slide that is not
   * `active` (per-slide visibility belongs to Delete / Show, never to this
   * tool — core/document.js's freeze block explains why). The command's
   * availability gate AND its target list, so a greyed-out control and a
   * silent no-op click cannot disagree.
   */
  freezeKeyframeTargets() {
    return this.selectedIds().filter((id) => itemAnimationKeyframes(this.doc, id).length > 0);
  }

  /**
   * Command (ONE undo unit, or no writes at all). FREEZE the selection's
   * animation: every selected item keeps only its state as of THIS slide,
   * written once at its creation slide, and stops changing across the deck
   * (core/document.js withKeyframesFrozen owns the rule and the reasoning).
   * Multi-select falls out naturally — one fold, one commit for the whole set.
   *
   * KEEPS the selection: the items still exist and still look the same here,
   * so deselecting them would only hide the result (deleteSelection's ruling).
   *
   * REPORTS, NEVER REFUSES. A skipped item says why, and every equation the
   * collapse replaces is named — an equation still IN FORCE here is written
   * back verbatim, so the common bound-to-camera case reports nothing.
   */
  freezeSelectionKeyframes() {
    const ids = this.freezeKeyframeTargets();
    if (ids.length === 0) return;
    // An in-progress text/LaTeX edit is a pending write on an item this call is
    // about to rewrite — commit it first (deleteSelection's rule, ROUND 15.2) so
    // it lands in the state being frozen instead of being lost to the commit
    // below, which writes `this.doc` directly and knows nothing about previewDelta.
    this.dismissEdit();
    const lost = ids.flatMap((id) =>
      lostEquationKeyframes(this.doc, this.slideIndex, id, this.registry).map((e) => ({ id, ...e })));
    const { doc, skipped } = withKeyframesFrozen(this.doc, this.slideIndex, ids);
    for (const { id, reason } of skipped)
      console.error(`PowerRP: Remove Animation Keyframes skipped item "${id}" — ${reason}.`);
    if (lost.length)
      console.error(`PowerRP: Remove Animation Keyframes dropped ${lost.length} equation keyframe(s) the frozen state does not keep: ${lost.map((e) => `items.${e.id}.${e.path.join(".")} on slide ${e.slideIndex} (${JSON.stringify(e.value)})`).join("; ")}. Undo restores them.`);
    this.commit(doc);
  }

  /**
   * Renames the selected item. Name is identity-flavored, so it's written on
   * the item's CREATION slide (first slide keying its `type`), not the
   * current one — a rename applies everywhere at once.
   */
  renameSelection(name) {
    if (!this.selection) return;
    const creation = keyframeIndices(this.doc, ["items", this.selection, "type"])[0] ?? this.slideIndex;
    this.commit(keyframed(this.doc, creation, ["items", this.selection, "name"], name));
  }

  // ── Z-order (bisect + normalize; a tweened in-between z is never STORED) ──

  zPairs() {
    return this.nodes().map((n) => [n.itemId, n.state.z ?? 0]);
  }

  /**
   * Query. The Z-ORDER BLOCK for the current selection (manifest 15.7: "when i
   * move a group to front or back it should move all elements in it too"): a
   * selected GROUP travels with EVERY member (and any members that are
   * themselves groups pull in their own members transitively) so the whole
   * cluster reorders as one; any other selection is just itself. The group's
   * members list is the derived-node membership map (present-on-this-slide
   * members only — a member absent from zPairs is simply not reassigned, per
   * blockZToExtreme). Returns the block itemIds (selection first).
   */
  #zOrderBlock() {
    if (!this.selection) return [];
    const nodes = this.nodes();
    const byId = new Map(nodes.map((n) => [n.itemId, n]));
    const block = new Set();
    const visit = (id) => {
      if (block.has(id)) return;
      block.add(id);
      const n = byId.get(id);
      if (n?.type === "group" && Array.isArray(n.state.members))
        for (const m of n.state.members) visit(m);
    };
    visit(this.selection);
    return [...block];
  }

  reorderSelection(direction) {
    if (!this.selection) return;
    const block = this.#zOrderBlock();
    // A GROUP steps as a BLOCK (front/back of everything else); a single item
    // bisects between its neighbors as before. "Forward/backward" on a block is
    // still a move to the extreme — a group has no single z to bisect around.
    if (block.length > 1) { this.#commitBlockZ(block, direction); return; }
    const z = bisectedZ(this.zPairs(), this.selection, direction);
    this.commit(withNormalizedZ(keyframed(this.doc, this.slideIndex, ["items", this.selection, "z"], z)));
  }

  /** "Put on Top"/"Put on Bottom": beyond the extremes of VISIBLE items on this
   *  slide. A GROUP sends its whole block (group + members) as one (manifest 15.7). */
  sendToExtreme(direction) {
    if (!this.selection) return;
    const block = this.#zOrderBlock();
    if (block.length > 1) { this.#commitBlockZ(block, direction); return; }
    const zs = this.zPairs().map(([, z]) => z);
    const z = direction > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    this.commit(withNormalizedZ(keyframed(this.doc, this.slideIndex, ["items", this.selection, "z"], z)));
  }

  /** Command (one undo unit). Reassigns every block id's z to the front/back
   *  extreme, preserving the block's internal relative order (blockZToExtreme),
   *  then normalizes document-wide — ONE commit. */
  #commitBlockZ(block, direction) {
    let doc = this.doc;
    for (const [id, z] of blockZToExtreme(this.zPairs(), block, direction))
      doc = keyframed(doc, this.slideIndex, ["items", id, "z"], z);
    this.commit(withNormalizedZ(doc));
  }

  // ── Keyframe panel operations ──────────────────────────────────────────────
  // Path-based versions serve BOTH item properties (["items", id, ...keyPath],
  // dotted inspector keys like "from.x" split into path segments) and
  // variables (["vars", name]) — the Variables Panel reuses the same
  // diamond/jump controls as the Property Panel.

  hasKeyPath(path) {
    return hasKeyframe(this.doc, this.slideIndex, path);
  }

  keyframePath(path, value) {
    this.commit(keyframed(this.doc, this.slideIndex, path, value));
  }

  /** Jump to the prev/next slide holding a keyframe for a full state path. */
  jumpKeyframePath(path, direction) {
    const idxs = keyframeIndices(this.doc, path);
    const next = direction > 0 ? idxs.find((i) => i > this.slideIndex) : [...idxs].reverse().find((i) => i < this.slideIndex);
    if (next !== undefined) this.slideIndex = next;
  }

  hasKey(key) {
    return this.selection ? this.hasKeyPath(["items", this.selection, ...key.split(".")]) : false;
  }

  removeKey(slideIndex, path) {
    this.commit(unkeyframed(this.doc, slideIndex, path));
  }

  /** Jump to the prev/next slide keyframing the selected item's (dotted) key. */
  jumpKeyframe(key, direction) {
    if (!this.selection) return;
    this.jumpKeyframePath(["items", this.selection, ...key.split(".")], direction);
  }

  // ── Variables (keyframable state.vars subtree — the Variables Panel) ──────

  /** RAW variables of the current slide: {name: number | equation string}. */
  varsState() {
    return this.rawState().vars ?? {};
  }

  /** Creates a variable (value 0, keyframed on the CURRENT slide, like item
   * creation). Loud on invalid names/duplicates; returns success. */
  addVariable(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      console.error(`PowerRP: "${name}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
      return false;
    }
    if (name in this.varsState()) {
      console.error(`PowerRP: a variable named "${name}" already exists`);
      return false;
    }
    this.commit(keyframed(this.doc, this.slideIndex, ["vars", name], 0));
    return true;
  }

  /** Removes a variable FROM EXISTENCE: every keyframe on every slide (the
   * variables' Purge — equations referencing it will error loudly). */
  deleteVariable(name) {
    let doc = this.doc;
    for (let i = 0; i < doc.slides.length; i++) doc = unkeyframed(doc, i, ["vars", name]);
    this.commit(doc);
  }

  /** Renames a variable document-wide, rewriting equation references (names
   * ARE variable identity — see core/expressions.js). Loud on conflicts. */
  renameVariable(oldName, newName) {
    if (newName === oldName) return true;
    try {
      this.commit(withVariableRenamed(this.doc, oldName, newName, this.registry));
      return true;
    } catch (e) {
      console.error(`PowerRP: rename variable failed: ${e.message}`);
      return false;
    }
  }

  // ── Slides ─────────────────────────────────────────────────────────────────

  addSlide() {
    const [doc, idx] = withNewSlide(this.doc, this.slideIndex);
    this.commit(doc);
    this.slideIndex = idx;
  }

  /**
   * Command. New FRESH slide (manifest Round 12): "everything that used to be
   * visible is no longer" — the new slide's delta keyframes active:false for
   * every item visible on the current slide (the camera is exempt: it is not
   * a visible object and must always frame the view). One undo unit.
   */
  addBlankSlide() {
    let [doc, idx] = withNewSlide(this.doc, this.slideIndex);
    for (const n of this.nodes())
      if (n.plugin.capabilities.purgeable !== false)
        doc = keyframed(doc, idx, ["items", n.itemId, "active"], false);
    this.commit(doc);
    this.slideIndex = idx;
  }

  deleteSlide() {
    // Deleting a CREATION slide orphans the items created there (their later
    // property keyframes fold into typeless items that crash evaluation) and
    // can even orphan THE camera — repair + re-ensure, loudly.
    this.commit(this.repaired(withSlideDeleted(this.doc, this.slideIndex)));
    this.slideIndex = Math.min(this.slideIndex, this.doc.slides.length - 1);
  }

  /**
   * Command (reports). The ONE load-boundary repair: orchestrated by
   * core/document.js's repairedDocument (orphans dropped → legacy renames →
   * meta.fps stripped → defaults filled → duration→transition → camera ensured
   * → bindings migrated, order-critical). This is a THIN wrapper — it runs the
   * pure pipeline and prints its report (silent repairs are forbidden; the CLI
   * hook in web/main.js consumes the SAME repairedDocument so the two can't
   * drift, which the cruft audit caught them doing). Bindings migration is now
   * INSIDE the pipeline — callers no longer wrap with withBindingsMigrated.
   */
  repaired(doc) {
    const { doc: out, reports } = repairedDocument(doc, this.registry);
    printRepairReports(reports);
    return out;
  }

  /** Toggles whether slide `index` (default: current) contributes its delta. */
  toggleSlide(index = this.slideIndex) {
    this.commit(withSlideToggled(this.doc, index));
  }

  moveSlide(offset) {
    this.commit(withSlideMoved(this.doc, this.slideIndex, offset));
    this.slideIndex = Math.max(0, Math.min(this.doc.slides.length - 1, this.slideIndex + offset));
  }

  // ── Local-disk DOCUMENT import/export ──────────────────────────────────────
  // These two move the DOCUMENT ONLY — the {meta, slides} JSON body — between
  // the editor and a file on the user's disk. They do NOT touch the server and
  // do NOT carry assets: an asset lives in the project folder and is referenced
  // from the document as a /asset/<project>/<file> backend URL (#resolvedSrc),
  // so a .powerrp.json alone is not self-contained. That is why the commands are
  // titled "Export/Import Document … (no assets)" and why the with-assets round
  // trip is Save Project to Server / Export Project as .zip instead.

  /** Command (browser download). Write the DOCUMENT (no assets) to a
   *  <name>.powerrp.json file on the user's disk. Surfaced as "Export Document
   *  as .powerrp.json (no assets)". */
  saveFile() {
    const blob = new Blob([serialize(this.doc)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this.projectName()}.powerrp.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Command. Read a DOCUMENT (no assets) from a .powerrp.json file the user
   *  picks, replacing the open document. Opens the OS file picker, hence the
   *  ellipsis on its title "Import Document from .powerrp.json…". */
  async loadFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    const file = await new Promise((res) => {
      input.onchange = () => res(input.files[0]);
      input.click();
    });
    if (!file) return;
    // Legacy .powerrp.json still LOADS (manifest Round 12: on-disk is now a
    // folder, but old single-file saves migrate through the same repair path).
    // repaired() runs the full pipeline (bindings migration included).
    this.commit(this.repaired(deserialize(await file.text())));
    this.slideIndex = 0;
    this.selection = null;
  }

  // ── Project server (projects are FOLDERS: doc.json + assets/) ────────────────
  // The server (server/server.py) owns project storage. These methods are the
  // app's seam to it (thin client = web/projectApi.js). doc.meta.name is the
  // project name. The localStorage autosave (commit → AUTOSAVE_KEY) stays as
  // crash-safety and is INDEPENDENT of project storage — a project must be
  // saved to the server explicitly (Save Project to Server). Errors surface
  // loudly. A PROJECT = document + assets/; a DOCUMENT = the JSON body alone
  // (the local-disk region above) — the two nouns are different payloads, and
  // every command title says which one it moves.

  /** Query. The current project name (doc.meta.name), defaulting to "Untitled".
   *  ALSO the filename stem of every export (document/.zip/PNG/PDF/SVG/MP4), so
   *  a downloaded file is named the same thing the toolbar title shows. Those
   *  call sites each used to inline a separate `|| "presentation"` fallback,
   *  which produced "presentation-slide1.png" for a project the UI was calling
   *  "Untitled" — two names for one unnamed project. */
  projectName() {
    return this.doc.meta.name || "Untitled";
  }

  /** Command (one undo unit). Rename the PROJECT — writes `doc.meta.name`,
   *  the SINGLE source of the project name (toolbar title, Save default, and the
   *  name Open sets). Trims; a blank or unchanged name is a no-op, so the title
   *  can never be emptied. Undoable like any document edit (goes through commit).
   *  Used by BOTH the toolbar title's double-click rename AND the Save-As path,
   *  so title / open / save always agree on one name. */
  renameProject(name) {
    const trimmed = (name ?? "").trim();
    if (!trimmed || trimmed === this.doc.meta.name) return;
    this.commit({ ...this.doc, meta: { ...this.doc.meta, name: trimmed } });
  }

  /** Query. Whether a project FOLDER named `name` already exists on the server —
   *  a case-sensitive exact match against the SAME list the Open modal renders
   *  (listProjects). The Save modal reads this to WARN before overwriting, so a
   *  save can never silently clobber a different project. Blank → false. */
  async projectExists(name) {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return false;
    return (await this.listProjects()).some((p) => p.name === trimmed);
  }

  /** Command. Save the current document to the server as a project FOLDER
   *  (doc.json under projects/<name>/). Creates the folder if new. Throws
   *  loudly on failure so the caller can surface it. */
  async saveToServer(name = this.projectName()) {
    await projectApi.saveProject(name, this.doc);
    return name;
  }

  /** Query. List saved projects on the server (newest first) — the data the
   *  Open modal renders. Exposed so the UI can be a lib Modal (built in
   *  parallel); no ad-hoc dialog is built here. */
  async listProjects() {
    return projectApi.listProjects();
  }

  /** Query. Fetch a project's raw {doc, assets} from the server WITHOUT loading
   *  it into the editor (loadProject mutates editor state — this does not). The
   *  Open modal's preview grid uses this to rasterize each project's slide 0
   *  off to the side. Throws loudly on a non-OK response (same as loadProject). */
  async fetchProjectDoc(name) {
    return projectApi.loadProject(name);
  }

  /** Command. Load a project from the server by name into the editor (same
   *  repair + binding migration as loadFile). UI resets mirror loadFile. A new
   *  project's font assets must re-register so a text run's `font` id resolves,
   *  so dynamic fonts are cleared (drop the prior project's) then re-synced. */
  async loadProject(name) {
    const { doc } = await projectApi.loadProject(name);
    clearDynamicFonts(); // drop the previous project's uploaded font families
    // OPENING SETS THE NAME: the server folder is authoritative, so the title,
    // any future Save, and a possibly-stale stored meta.name all agree on `name`
    // (keeps title / open / save consistent — the one-name-model invariant).
    const repaired = this.repaired(doc); // repaired() includes bindings migration
    this.commit({ ...repaired, meta: { ...repaired.meta, name } });
    this.slideIndex = 0;
    this.selection = null;
    this.syncFontAssets(name); // fire-and-forget: register + load this project's font assets
  }

  // ── Fonts as an ASSET (#26): a project-uploaded font file becomes a
  // SELECTABLE family. registerFontAssets makes each font-kind asset resolve
  // (render_gpu/fonts.js dynamic registry) AND loads it into the browser so it
  // actually renders. Called from the Asset Explorer's re-list (any project /
  // upload change) and after loadProject — one registration pathway. ──────────

  /** Command. Register every font-kind asset in `assetList` as a selectable
   *  family and load its face into the browser. Idempotent (re-registering a
   *  family overwrites; the loader skips an already-loaded face). An invalid
   *  font file surfaces LOUDLY (console.error) but never blocks the others or
   *  the asset list (#26 "loud on invalid font"). Returns the ids registered. */
  registerFontAssets(assetList) {
    const ids = [];
    for (const a of assetList ?? []) {
      if (a.kind !== "font") continue;
      const id = fontAssetId(a.name);
      const { cssFamily, url } = fontDescriptor(id).dynamic
        ? fontDescriptor(id)
        : registerFontFamily(id, { filename: a.name, url: projectApi.assetUrl(a.url), title: a.name });
      ids.push(id);
      loadDynamicFont(cssFamily, url ?? projectApi.assetUrl(a.url)).catch((e) => {
        console.error(`registerFontAssets: ${e.message}`);
      });
    }
    return ids;
  }

  /** Command. List the current project's assets and register its font assets
   *  (loadProject path). Fire-and-forget; errors surface loudly. */
  async syncFontAssets(name = this.projectName()) {
    try {
      this.registerFontAssets(await projectApi.listAssets(name));
    } catch (e) {
      console.error(`syncFontAssets: could not list assets for "${name}":`, e);
    }
  }

  /** Command (browser: rasterizes via pdfjs, persists via the server thumb
   *  cache). Ensure an asset has a cached {thumbnail, badge}. For a PDF with no
   *  server-cached thumbnail yet, rasterize page 1 client-side + POST it so it
   *  persists for next session. Returns {thumbnail, badge} for immediate tile
   *  display, or null when nothing to render (already cached / not a
   *  client-thumbnail kind). Rejects loudly on a rasterize/store failure so the
   *  caller shows the plain kind icon (never a silently-blank tile). */
  async ensureAssetThumbnail(asset, name = this.projectName()) {
    const pres = assetTilePresentation(asset);
    if (!pres.needsClientThumbnail) return null; // already cached, or a kind we don't rasterize
    const { renderPdfThumbnail } = await import("../render_gpu/gpu/asset_thumbnail.js");
    const { dataUrl, pageCount } = await renderPdfThumbnail(projectApi.assetUrl(asset.url));
    const badge = pageCountBadge(pageCount);
    // Persist for next session — BEST-EFFORT. The thumbnail is already rendered
    // (returned below); a disk-cache write failure must not lose it. If the backend
    // exposes no thumb route (e.g. a frontend-only harness / a backend hiccup), learn
    // it ONCE and stop retrying — thumbnails still render in-session. A failed
    // optional-cache write is non-fatal, so warn ONCE (not error, not per-asset).
    if (!this._thumbPersistUnavailable) {
      const png = await (await fetch(dataUrl)).blob();
      projectApi.storeThumb(name, asset.name, asset.mtime, badge, png).catch((e) => {
        this._thumbPersistUnavailable = true;
        console.warn(`ensureAssetThumbnail: thumbnail disk-cache unavailable (${e?.message ?? e}); rendering in-session only.`);
      });
    }
    return { thumbnail: dataUrl, badge };
  }

  /** Command. Export the whole project (document + assets) to a .zip file on the
   *  user's disk — the archive is built server-side from the project folder.
   *  SAVES TO THE SERVER FIRST so the .zip reflects the live document; that
   *  server write is stated in the command's title, since a title that only said
   *  "Download" would have hidden it. */
  async downloadZip(name = this.projectName()) {
    await this.saveToServer(name);
    await projectApi.downloadProjectZip(name);
  }

  // ── Assets: upload / delete / insert / filmstrip frames (one region) ────────

  /** Bumped on every asset add/remove, so asset consumers (the Asset Explorer
   *  pane) can re-list reactively — e.g. a canvas OS-file drop must show up in
   *  the pane without a manual Refresh. Monotonic, viewer-local, not undoable. */
  assetsVersion = $state(0);

  // ── Optimistic upload progress (this feature) ────────────────────────────
  // Every in-flight/failed upload as a reactive tile the Asset Explorer renders
  // BEFORE the real assets. Entry shape:
  //   { id, name, kind, loaded, total, status: "uploading"|"done"|"error", error }
  // The SINGLE source of upload progress: because every entry point (Asset
  // Explorer button, AssetField button, Finder drop onto either surface, canvas
  // drop, paste-to-upload) funnels through THIS uploadAsset, they all get the
  // optimistic tile for free. Viewer-local, not undoable.
  uploads = $state([]);
  #uploadSeq = 0;

  /** Command. Patch one upload entry by id (functional: a fresh array + object,
   *  so Svelte's keyed {#each} updates the tile without me relying on deep-proxy
   *  mutation of a nested $state object). No-op if the id is gone (dismissed). */
  #patchUpload(id, patch) {
    this.uploads = this.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u));
  }

  /** Command. Upload a File/Blob into the current project's assets/ folder (the
   *  source of truth for the asset library). Returns {ok, name, url}. Pushes an
   *  optimistic upload tile IMMEDIATELY (before any await, so it appears the
   *  instant the user clicks/drops), streams xhr.upload.onprogress into its
   *  loaded/total, marks it "done" on success (the Asset Explorer's re-list then
   *  swaps in the real tile via reconcileUploads) or "error" on ANY failure —
   *  a loud, visible error tile, AND the error is re-thrown so direct-gesture
   *  callers (AssetField) still surface their inline message (NO SILENT
   *  FALLBACK). Saves the project first so the folder exists server-side. */
  async uploadAsset(file, filename = file.name, name = this.projectName()) {
    const id = `upload_${++this.#uploadSeq}`;
    this.uploads = [
      ...this.uploads,
      { id, name: filename, kind: assetKindForFile(file), loaded: 0, total: file.size ?? 0, status: "uploading", error: null },
    ];
    try {
      await this.saveToServer(name);
      const res = await projectApi.uploadAsset(name, file, filename, (loaded, total) =>
        this.#patchUpload(id, total ? { loaded, total } : { loaded })
      );
      // Final de-collided basename + full bar; the done tile lingers only until
      // the Asset Explorer's assetsVersion re-list drops it (reconcileUploads).
      this.uploads = this.uploads.map((u) =>
        u.id === id ? { ...u, name: res.name, status: "done", loaded: u.total || u.loaded } : u
      );
      this.assetsVersion++;
      return res;
    } catch (e) {
      this.#patchUpload(id, { status: "error", error: String(e?.message ?? e) });
      console.error(`uploadAsset: upload of "${filename}" failed:`, e);
      throw e; // re-raise — the tile shows it AND the calling gesture surfaces it
    }
  }

  /** Command. Drop finished ("done") upload tiles whose real asset now appears
   *  in `assetList` — called by the Asset Explorer right after a successful
   *  re-list, so a pending tile is only removed once its REAL tile has arrived
   *  (no flicker gap where the new asset shows in neither). Error tiles are left
   *  standing (they persist, loudly, until the user dismisses them). */
  reconcileUploads(assetList) {
    const names = new Set((assetList ?? []).map((a) => a.name));
    this.uploads = this.uploads.filter((u) => !(u.status === "done" && names.has(u.name)));
  }

  /** Command. Remove one upload tile by id — the error tile's dismiss (×). */
  dismissUpload(id) {
    this.uploads = this.uploads.filter((u) => u.id !== id);
  }

  /** Query. List the current project's assets from the server (reflects the
   *  assets/ folder on disk — a manual drop appears after a refresh). This is
   *  the refresh-button data source for the future Asset Explorer pane. */
  async listProjectAssets(name = this.projectName()) {
    return projectApi.listAssets(name);
  }

  /** Command. Delete one asset from the current project (the server removes
   *  the file AND its cached filmstrip frames). Throws loudly on failure —
   *  the Asset Explorer's trash-can flow surfaces it. */
  async deleteProjectAsset(filename, name = this.projectName()) {
    await projectApi.deleteAsset(name, filename);
    this.assetsVersion++;
  }

  /** Query. World point at the center of the CURRENT camera view — the default
   *  placement for inserts that don't come from a canvas drop (the same
   *  cameraRect(evaluateState(foldState(…))) idiom exportPng uses). */
  #viewCenter() {
    const rect = cameraRect(evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state, this.doc.meta);
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  /** Command. addItem a media widget at native size `w`×`h`, CENTERED at world
   *  point `at` (or the camera-view center when null). addItem keyframes
   *  active:true on this slide and selects the new item. */
  #insertMediaAt(defaults, src, w, h, at) {
    const p = at ?? this.#viewCenter();
    this.addItem({ ...defaults, src, w, h, x: p.x - w / 2, y: p.y - h / 2 });
  }

  /** Query. A src string for the document: relative served paths ("/asset/…")
   *  resolve through the backend base (identity when same-origin/proxied);
   *  absolute URLs and data: URIs pass through untouched. */
  #resolvedSrc(url) {
    return url.startsWith("/") ? projectApi.assetUrl(url) : url;
  }

  /**
   * Command. Inserts an image asset (by URL) as a new image widget on the
   * current slide at NATIVE pixel size (manifest Round 12: "because we have
   * pixels to measure things"), CENTERED at world point `at` — a canvas drop
   * point (manifest Round 12C: asset→canvas drag inserts at the drop point) —
   * or at the current camera-view center when `at` is omitted (the Asset
   * Explorer's insert button).
   *
   * Async because the natural size is only known after decode. A decode
   * FAILURE rejects loudly (no silent fallback) so the caller surfaces it.
   */
  async insertImageAsset(url, at = null) {
    const src = this.#resolvedSrc(url);
    const { naturalWidth: w, naturalHeight: h } = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`insertImageAsset: could not load image "${src}"`));
      img.src = src;
    });
    this.#insertMediaAt(imagePlugin.defaults, src, w, h, at);
  }

  /**
   * Command. Inserts a video asset (by URL) as a new video PLAYER widget at
   * native pixel size, centered at `at` (canvas drop point) or the camera-view
   * center — the video twin of insertImageAsset (manifest Round 12 drag-drop:
   * "Same for videos"; autoplay/loop/muted defaults come from the plugin).
   * Loads METADATA only (no full decode) for the native size; a load failure
   * rejects loudly.
   */
  async insertVideoAsset(url, at = null) {
    const src = this.#resolvedSrc(url);
    const { videoWidth: w, videoHeight: h } = await new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve(v);
      v.onerror = () => reject(new Error(`insertVideoAsset: could not load video "${src}"`));
      v.src = src;
    });
    this.#insertMediaAt(videoPlugin.defaults, src, w, h, at);
  }

  /**
   * Command. Inserts a VIDEO SCRUBBER + a PROGRESS BAR, LINKED on creation: the
   * bar's `fraction` is bound by a `=` equation to the scrubber's `progress`
   * export (`= @<scrubberId>.progress`), so the bar fills to match how far along
   * the clip the scrubber's deterministic `scrubTime` is (once the scrubber's
   * `duration` is set — see plugins/video_scrub.js on why duration is a user
   * input). The bar is placed directly beneath the scrubber, matching its width.
   *
   * Both items are created with withNewItem (each spreads its plugin defaults, so
   * the scrubber's derived exports are materialized), keyframed active:true on the
   * current slide, layered above the existing content, and committed as ONE undo
   * unit. The bar is selected afterward (its fraction binding is the thing to
   * inspect). Uses the STORED `@<id>` reference form so the link survives renames.
   */
  insertVideoWithProgressBar() {
    const scrub = this.registry.get("video_scrub");
    const bar = this.registry.get("progress_bar");
    const vw = scrub.defaults.w, vh = scrub.defaults.h;
    const barW = vw, barH = bar.defaults.h;
    const GAP = 12; // world units between the scrubber and its bar
    const totalH = vh + GAP + barH;
    const c = this.#viewCenter();
    const left = c.x - vw / 2, top = c.y - totalH / 2;
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    const baseZ = zs.length ? Math.max(...zs) : 0;

    const [docWithScrub, scrubId] = withNewItem(this.doc, this.slideIndex, {
      ...scrub.defaults, active: true, z: baseZ + 1, x: left, y: top,
    });
    // The bar's fraction is bound to the scrubber's progress export on creation
    // (STORED `@<id>` form → survives renames). This IS the "linked on creation".
    const [doc, barId] = withNewItem(docWithScrub, this.slideIndex, {
      ...bar.defaults, active: true, z: baseZ + 2,
      x: left, y: top + vh + GAP, w: barW, h: barH,
      fraction: `= @${scrubId}.progress`,
    });
    this.commit(withNormalizedZ(doc));
    this.selection = barId; // the fraction binding is the thing to inspect
  }

  // Open-project UI seam: the Open command opens a project-picker MODAL, but
  // the Modal lib component is landing in PARALLEL (Sonnet1). The modal
  // integration sets `app.showOpenModal` to a function; until it lands the
  // command reports LOUDLY (no ad-hoc dialog is built here — the data/API
  // above — listProjects()/loadProject() — is the seam the modal consumes).
  showOpenModal = null;

  /** Command. Open the project-picker (delegates to the modal hook once wired). */
  openProject() {
    if (this.showOpenModal) return this.showOpenModal();
    console.error(
      "Open Project from Server: the project-picker modal is not wired yet " +
      "(Modal lib component pending). Use app.listProjects() / app.loadProject(name) " +
      "programmatically, or Import Document from .powerrp.json for a local file.",
    );
  }

  // Save + Rename UI seams (mirror showOpenModal): App.svelte sets these to
  // functions that open the respective Modal. Both operate on ONE name model —
  // doc.meta.name (renameProject) — so the title, Save, and Open never diverge.
  // Until App.svelte wires them, each command reports LOUDLY (no ad-hoc dialog).
  showSaveModal = null;
  showRenameModal = null;

  /** Command. Open the "Save Project to Server" modal: choose/confirm the name
   *  (default = meta.name) and, if that name already exists on the server, warn +
   *  require an explicit Overwrite (never a silent clobber). Delegates to the
   *  modal hook. The low-level push (saveToServer) is unchanged and still used
   *  non-interactively by asset upload / project .zip export. */
  saveProjectAs() {
    if (this.showSaveModal) return this.showSaveModal();
    console.error("Save Project to Server: the save modal is not wired yet (App.svelte hook missing). Use app.saveToServer(name).");
  }

  /** Command. Open the Rename modal for the PROJECT name (writes doc.meta.name
   *  via renameProject — the name the toolbar shows as the title). Delegates to
   *  the modal hook; also the target of the toolbar title's double-click (bug:
   *  the title was inert). NAME KEPT: the two Toolbar.svelte call sites (a file
   *  this agent does not own) call it, so renaming the METHOD to match the
   *  command's "Rename Project…" title is a separate, coordinated patch. */
  renamePresentation() {
    if (this.showRenameModal) return this.showRenameModal();
    console.error("Rename Project: the rename modal is not wired yet (App.svelte hook missing). Use app.renameProject(name).");
  }

  // Built-in asset browser UI seam (mirrors showOpenModal): App.svelte sets this
  // to a function that opens the "Built-in Assets" Modal. Built-in assets are
  // ship-with-the-app (cursors today) and live in a SEPARATE surface from the
  // project Asset Explorer — this is DISCOVERY only; widgets read built-ins
  // directly (web/builtinAssets.js is the catalog).
  showBuiltinAssets = null;

  /** Command. Open the built-in asset browser (delegates to the modal hook once
   *  wired by App.svelte). */
  browseBuiltinAssets() {
    if (this.showBuiltinAssets) return this.showBuiltinAssets();
    console.error("Browse Built-in Assets: the browser modal is not wired yet (App.svelte hook missing).");
  }

  // ── ARRANGE SELECTION INTO GRID (bento box) ─────────────────────────────────
  // Lays the selected widgets out as a BENTO GRID. This tool CONSUMES the bento
  // widget (type "bento", parallel lane #86: a grid-layout widget with props
  // {rows, cols, rowGap, colGap, padding} that emits per-cell anchors) — it does
  // NOT rebuild it. The pure grid math (core/grid.js) is independent of the
  // widget and fully tested; the create-and-place step below is guarded on the
  // "bento" plugin being registered so this lane is safe to merge before/after
  // #86. The UX is INTERACTIVE (palette commands take no args): the command opens
  // a grid-size picker (Office "Insert Table" sweep) via the showGridPicker seam;
  // the picker's confirm calls arrangeSelectionIntoGrid(rows, cols).

  /** The widget type this tool creates. Consumed from parallel lane #86. */
  static #BENTO_TYPE = "bento";

  // Grid-size-picker UI seam (mirrors showOpenModal / showBuiltinAssets):
  // App.svelte sets this to a function (itemCount) => void that opens the
  // GridSizePicker popover; its confirm handler calls arrangeSelectionIntoGrid.
  showGridPicker = null;

  /**
   * Query. The selected nodes that have a bounding box (own x/y/w/h), as
   * {node, box} pairs in selection order — the same basis align/mirror/
   * distribute use. Non-bbox items (arrows, endpoints) are excluded: placing a
   * widget's CENTER in a cell needs a width/height.
   */
  #selectedBboxNodes() {
    const ids = new Set(this.selectedIds());
    return this.nodes()
      .filter((n) => ids.has(n.itemId) && n.plugin.capabilities.bbox)
      .map((n) => ({ node: n, box: { x: n.state.x ?? 0, y: n.state.y ?? 0, w: n.state.w ?? 0, h: n.state.h ?? 0 } }));
  }

  /** Query. Is the "bento" widget (lane #86) registered yet? Guards the
   *  create-and-place step without tripping registry.get's loud throw. */
  #bentoAvailable() {
    return this.registry.all().some((p) => p.type === PowerRPApp.#BENTO_TYPE);
  }

  /** Command. "Arrange into Grid": opens the grid-size picker (delegates to the
   *  App.svelte hook). The picker's confirm calls arrangeSelectionIntoGrid.
   *  Gated to ≥2 bbox items by the command registration; this guard keeps a
   *  direct/test call safe. */
  arrangeIntoGrid() {
    const count = this.#selectedBboxNodes().length;
    if (count < 2) return;
    if (this.showGridPicker) return this.showGridPicker(count);
    console.error("Arrange into Grid: the grid-size picker UI is not wired yet (App.svelte hook missing).");
  }

  /**
   * Command (ONE undo unit). Realizes the current selection as a BENTO GRID:
   * creates ONE bento box sized to the selection's current union AABB (its
   * width/height taken from where the items already are), with the chosen
   * rows×cols, then moves each selected bbox item (row-major order) so its own
   * CENTER sits on its cell's center. Overflow (more items than rows*cols) grows
   * the row count to fit (effectiveRows). Selects the new bento. Placement is
   * absolute x/y keyframes on the current slide — the same mechanism as align/
   * distribute — so re-running the command re-flows.
   *
   * Gap defaults come from the bento plugin's OWN defaults (rowGap/colGap/
   * padding) so the tool never invents grid spacing. The bento is layered just
   * BEHIND the selected items (a container sits behind its contents) — a sensible
   * default; final layering is a bento-integration detail.
   *
   * INTEGRATION POINT (#86): if "bento" is not registered yet, this reports
   * LOUDLY and no-ops (the picker + pure math still work). FLAGGED for post-merge
   * finalization: (a) whether to bind item x/y to the bento's cell-center anchors
   * via `=` equations so editing rows/cols in the Inspector AUTO-reflows (needs
   * the finalized cell-anchor naming from #86) rather than only re-running;
   * (b) parenting items to the bento vs. absolute placement; (c) final z-order.
   */
  arrangeSelectionIntoGrid(rows, cols) {
    const items = this.#selectedBboxNodes();
    if (items.length < 2) return;
    if (!this.#bentoAvailable()) {
      console.error(
        `Arrange into Grid: the "${PowerRPApp.#BENTO_TYPE}" widget is not registered yet ` +
        "(parallel lane #86 pending). The grid-size picker and the pure grid math are wired; " +
        "the bento create-and-place step finalizes once that lane merges.",
      );
      return;
    }
    const bento = this.registry.get(PowerRPApp.#BENTO_TYPE);
    const bounds = unionRect(items.map((it) => it.box));
    const usedRows = effectiveRows(items.length, rows, cols);
    const gaps = {
      rowGap: bento.defaults.rowGap ?? 0,
      colGap: bento.defaults.colGap ?? 0,
      padding: bento.defaults.padding ?? 0,
    };
    // 1. Create the bento sized to the union AABB, at the chosen grid shape,
    //    layered behind the selection.
    const zs = this.nodes().map((n) => n.state.z ?? 0);
    const bentoState = {
      ...bento.defaults,
      x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h,
      rows: usedRows, cols,
      active: true,
      z: (zs.length ? Math.min(...zs) : 0) - 1,
    };
    let [doc, bentoId] = withNewItem(this.doc, this.slideIndex, bentoState);
    // 2. Place each item's CENTER on its cell center (row-major), as x/y
    //    keyframes on the current slide.
    const byCell = new Map(cellCenters(bounds, usedRows, cols, gaps).map((c) => [`${c.row},${c.col}`, c]));
    const assignments = gridAssign(items.length, usedRows, cols);
    items.forEach(({ node, box }, i) => {
      const cell = byCell.get(`${assignments[i].row},${assignments[i].col}`);
      doc = keyframed(doc, this.slideIndex, ["items", node.itemId, "x"], cell.x - box.w / 2);
      doc = keyframed(doc, this.slideIndex, ["items", node.itemId, "y"], cell.y - box.h / 2);
    });
    this.commit(withNormalizedZ(doc));
    this.selection = bentoId;
  }

  /**
   * Clears to a fresh document (round 11: "next to save and load I should be
   * able to clear the current thing"). Goes through commit() so it lands in
   * the UNDO log — undo restores everything, which is the safety net (no
   * confirm dialog by design). newDocument() guarantees THE camera exists.
   * UI resets mirror loadFile: slide 0, nothing selected.
   */
  clearDoc() {
    clearDynamicFonts(); // a fresh doc has no project → drop uploaded font families
    this.commit(newDocument());
    this.slideIndex = 0;
    this.selection = null;
  }

  loadAutosave() {
    const json = localStorage.getItem(AUTOSAVE_KEY);
    if (json) {
      // repaired() runs the full load-boundary pipeline: drops orphaned items
      // LOUDLY, ensures THE camera, and migrates legacy {item, anchor} arrow
      // bindings to equation pairs (THE UNIFICATION) — all inside
      // repairedDocument now, so no separate withBindingsMigrated wrap.
      this.doc = this.repaired(deserialize(json));
      this.undoLog = createUndo(this.snapshot(this.doc));
    }
  }

  runCommand(id) {
    const cmd = this.commands.get(id);
    // Disabled-command semantics: a failing `when` means "not runnable here"
    // (guards e.g. deleting the non-purgeable camera via the Delete key).
    if (cmd.when && !cmd.when(this)) return;
    // toggle-palette is excluded from MRU: keyboard-opening the palette IS a
    // command run, and tracking it made it permanently #1 — pure noise.
    if (id !== "toggle-palette") this.commands.markUsed(id);
    // Running a submenu child (e.g. a theme under "Color Theme →") also bumps
    // its parent: the child can't appear in the top-level list, so surfacing the
    // parent is what makes "recently used" visible there.
    const parent = this.commands.parentOf(id);
    if (parent) this.commands.markUsed(parent.id);
    localStorage.setItem("powerrp.mru", JSON.stringify(this.commands.usageList()));
    cmd.run(this);
  }

  loadMru() {
    const json = localStorage.getItem("powerrp.mru");
    if (json) this.commands.loadUsage(JSON.parse(json));
  }

  /**
   * Renders the current slide THROUGH THE CAMERA and downloads a PNG.
   * The camera determines the output size/aspect (manifest: THE CAMERA).
   */
  async exportPng() {
    // THE renderer via the shared pixel service; the camera determines the
    // output size/aspect (evaluated state — its properties may be equations).
    const rect = cameraRect(evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state, this.doc.meta);
    const canvas = await renderCameraFrame(this.doc, {
      slideIndex: this.slideIndex,
      alpha: 1,
      registry: this.registry,
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${this.projectName()}-slide${this.slideIndex + 1}.png`;
    a.click();
  }

  /**
   * Exports the current slide as a VECTOR PDF (manifest "PDF export, round
   * 11"): shapes/text stay vector (text selectable), blur regions embed as
   * raster per the hybrid rule. The camera rect IS the page (pt = world px).
   *
   * EMBEDDED PDFs STAY VECTOR: (a) before deriving the scene, every pdf_page
   * node's async VECTOR ingest is awaited (a one-shot export has no repaint loop
   * to pick up the fire-and-forget result), so a vector-safe page emits its real
   * `path` IR instead of the raster fallback; (b) a text/paper page — which the
   * classifier rasterizes — is instead copied LOSSLESSLY via pdf-lib embedPdf
   * (resolvePdfPageEmbed), keeping its real vectors, selectable text, and fonts.
   * A synthetic pdfpage:/latex: ref that must raster (cropped / translucent /
   * under an effect) is resolved to bytes through resolveImageBytes — the seam
   * that replaces the old fetch("pdfpage:…") crash.
   */
  async exportPdf() {
    const { irToPDF, parsePdfPageRef } = await import("../render_gpu/pdf_backend.js");
    const { sceneIR } = await import("../render_gpu/ports.js");
    const { fitRectView } = await import("../core/view.js");
    const { loadFontBytes, fontkit, measureTextAscent, measureText } = await import("./pdfFonts.js");
    const { getImage } = await import("../render_gpu/gpu/image_registry.js");
    const { ensurePdfPageVector } = await import("../render_gpu/gpu/pdf_page_vector.js");
    const { clampPage, pdfPageCount } = await import("../render_gpu/gpu/pdf_page_raster.js");
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
    const rect = cameraRect(state, this.doc.meta);

    // (a) WARM UP the vector ingest for every pdf_page node BEFORE deriving the
    // scene. emit() reads pdfPageVectorIRFor synchronously; a fresh export never
    // awaits the fire-and-forget ensurePdfPageVector, so without this the first
    // read is always null → raster fallback. Clamp exactly like emit() so the
    // warmed page is the one emit() will read.
    await Promise.all(Object.values(state.items ?? {})
      .filter((s) => s.type === "pdf_page" && typeof s.src === "string" && s.src.length > 0)
      .map((s) => {
        const requested = s.page ?? 1;
        let page = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
        const count = pdfPageCount(s.src);
        if (count != null) page = clampPage(requested, count).page;
        return ensurePdfPageVector(s.src, page);
      }));

    // The synthetic-ref → PNG-bytes resolver (pdfpage:/latex: rasters): read the
    // registry ImageBitmap and re-encode it (the exportSvg videoFrame pattern).
    // A ref with no ready bitmap (source still rasterizing) reports and draws
    // nothing rather than throwing — a reported skip, never a silent one.
    const resolveImageBytes = async (ref) => {
      const bitmap = getImage(ref);
      if (!bitmap) {
        console.warn(`exportPdf: synthetic ref "${ref.slice(0, 48)}…" has no rasterized bitmap yet — it exports blank. Re-export once the page/equation has finished rendering.`);
        return null;
      }
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    };
    // The LOSSLESS page-embed source for a full-frame opaque pdf_page: parse the
    // ref back to (src, page) and hand pdf-lib the raw source-PDF bytes to copy.
    // A non-pdf_page synthetic ref (latex:) returns null → the raster path above.
    const resolvePdfPageEmbed = async (ref) => {
      const parsed = parsePdfPageRef(ref);
      if (!parsed) return null;
      const res = await fetch(parsed.src); // fetch handles data:/blob:/http(s)/relative
      if (!res.ok) throw new Error(`exportPdf: failed to fetch PDF source "${parsed.src.slice(0, 48)}…" for a lossless page-embed — HTTP ${res.status} ${res.statusText}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), pageIndex: parsed.page - 1 };
    };

    // Embed the SAME committed fonts the glyph atlas rasterizes (manifest "Text
    // fonts" / embedFont seam): registerFontkit + loadFontBytes let pdf-lib
    // embed the TTFs; measureTextAscent gives per-font baseline parity with the
    // atlas. `system` text still uses standard-14 Helvetica (no committed file).
    // measureText is the RICH-TEXT layout seam (Round 13.4) — without it the PDF
    // backend degrades a multi-run text box to its first run (and outline/
    // highlight never emit); passing it makes exported rich text match the editor.
    const bytes = await irToPDF(sceneIR(deriveRenderTree(state, this.registry)), {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: rect.background,
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      measureText: measureText(),
      loadFontBytes,
      registerFontkit: await fontkit(),
      resolveImageBytes,
      resolvePdfPageEmbed,
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    a.download = `${this.projectName()}-slide${this.slideIndex + 1}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Exports the current slide as a standalone, SELF-CONTAINED VECTOR SVG
   * (manifest "SVG export", the PDF backend's sibling): shapes/text stay vector
   * (text SELECTABLE), fonts embed as @font-face data: URIs, images/video-frames
   * inline as data: URIs, and blur regions embed as raster per the HYBRID RULE.
   * The camera rect IS the viewBox. The output opens in any browser with NO
   * network (OFFLINE RULE) — every asset is inlined.
   *
   * Seams mirror exportPdf's, plus two SVG-specific inliners (the SVG must
   * embed every asset, unlike a PDF which could in principle fetch): a
   * resolveImageHref that fetches a URL image → data URI, and a videoFrame that
   * grabs the <video> element's CURRENT frame → PNG (the manifest video rule).
   */
  async exportSvg() {
    const { irToSVG } = await import("../render_gpu/svg_backend.js");
    const { loadFontBytes, measureTextAscent, measureText } = await import("./pdfFonts.js");
    const { getVideo } = await import("../render_gpu/gpu/video_registry.js");
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
    const rect = cameraRect(state, this.doc.meta);

    // Any image src that is a URL (asset-server case) must be inlined for a
    // self-contained SVG. A data-URI src is used as-is by the backend (no
    // resolver call); this only fires for URL refs. Loud on a failed fetch.
    const resolveImageHref = async (ref) => {
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`exportSvg: failed to fetch image "${ref}" for inlining — HTTP ${res.status} ${res.statusText}`);
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result); // a data: URI
        fr.onerror = () => reject(new Error(`exportSvg: could not read image "${ref}" as a data URI`));
        fr.readAsDataURL(blob);
      });
    };
    // Grab the video's CURRENT frame as a PNG (manifest: a video exports as its
    // current frame). The <video> element lives in the shared registry; if it
    // isn't decoded yet there is no drawable frame → return null (draw nothing,
    // loud is unnecessary — the compositor skips an undecoded video too).
    const videoFrame = async (ref) => {
      const el = getVideo(ref);
      if (!el || !el.videoWidth || !el.videoHeight) return null;
      const c = document.createElement("canvas");
      c.width = el.videoWidth;
      c.height = el.videoHeight;
      c.getContext("2d").drawImage(el, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      return { mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()) };
    };

    const svg = await irToSVG(sceneIR(deriveRenderTree(state, this.registry)), {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: rect.background,
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      measureText: measureText(), // RICH-TEXT layout seam (Round 13.4) — see exportPdf
      loadFontBytes,
      resolveImageHref,
      videoFrame,
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    a.download = `${this.projectName()}-slide${this.slideIndex + 1}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Command (async). Exports ALL SLIDES (the whole deck, or the modal's chosen
   * startIndex..endIndex range) as one playable .mp4 file on the user's disk,
   * DETERMINISTICALLY — surfaced as "Export All Slides as MP4…", the scope that
   * distinguishes it from the one-slide Export Slide as PNG/PDF/SVG commands.
   * The client renders every frame; the SERVER encodes the
   * H.264 MP4 (ffmpeg). MP4-specific orchestration over the GENERAL video-export
   * pipeline (web/videoExport.js): it builds the timeline PLAN (the presenter's
   * hold + transition-in model), defines the deterministic frame renderer, wires
   * the pluggable server encoder (web/serverMp4Encoder.js) and the controlled-time
   * seam, and runs exportVideo(). Returns the "video/mp4" Blob and, when
   * `download` (default), saves it. Dynamic imports keep the export lane out of
   * the initial bundle and out of node (the exportPdf/exportSvg pattern).
   *
   * WHY server-side: the browser's WebCodecs VideoEncoder is secure-context-only
   * (HTTPS / localhost). PowerRP runs on plain HTTP on a LAN IP, so in-browser
   * encoding is impossible there — the app's HTTPS-independence tenant demands the
   * encode happen on the server. The frame RENDER stays fully client-side and
   * deterministic; only the encode moves (serverMp4Encoder streams each PNG to the
   * backend, which runs libx264 and returns the file).
   *
   * FRAME RENDER: each (slide, alpha) is rendered through the SAME deterministic
   * path the presenter/CLI use (transitionRender.renderTransitionFrame — tween OR
   * fade), composited over the chosen letterbox background. At the default
   * (output size == camera size) the content fills the frame, so the result is
   * byte-for-byte the presenter/CLI render.
   *
   * MOTION BLUR (`samples` > 1): exportVideo renders N sub-frames per output
   * frame at evenly-subdivided sub-times and averages them (CLIENT-side, before a
   * frame is shipped). The controlled-time setter is
   * render_gpu/particle_clock.setParticleTimeOverride, so the ambient animation
   * clock (particle emitters, raycast-dither, any particleTime() consumer) samples
   * each sub-time too — time-driven effects blur alongside the tween. samples=1
   * (default) is one render per frame (no blur, no extra cost), but STILL drives
   * the clock so animated widgets animate over the video (like the presenter)
   * rather than freezing.
   *
   * LOUD when the server is unreachable or errors: createServerMp4Encoder /
   * finalize throw with the reason; the modal surfaces it. No client fallback.
   *
   * @param {object} o
   * @param {number} o.width Output width in px (even).
   * @param {number} o.height Output height in px (even).
   * @param {number} o.fps Frames per second.
   * @param {number} o.crf libx264 Constant Rate Factor (0..51, lower = higher quality).
   * @param {number} [o.samples] Temporal subsamples for motion blur (default 1).
   * @param {number} [o.startIndex] First slide index (default 0).
   * @param {number} [o.endIndex] Last slide index inclusive (default last).
   * @param {boolean} [o.includeTransitions] Animate transitions (default true).
   * @param {number} [o.holdSeconds] Per-slide dwell fallback (default from videoExport).
   * @param {string} [o.background] Letterbox fill CSS color (default black).
   * @param {(f:number)=>void} [o.onProgress] 0..1 after each encoded frame.
   * @param {AbortSignal} [o.signal] Cancels the encode.
   * @param {boolean} [o.download] Save the blob (default true).
   * @returns {Promise<Blob>}
   */
  async exportMp4({ width, height, fps, crf, samples = 1, startIndex = 0, endIndex = this.doc.slides.length - 1, includeTransitions = true, holdSeconds, background = "#000000", onProgress, signal, download = true }) {
    const { exportVideo, timelinePlan, DEFAULT_HOLD_SECONDS } = await import("./videoExport.js");
    const { createServerMp4Encoder } = await import("./serverMp4Encoder.js");
    const { createLetterboxFrameRenderer } = await import("./transitionRender.js");
    const { setParticleTimeOverride } = await import("../render_gpu/particle_clock.js");
    const plan = timelinePlan(this.doc, {
      startIndex, endIndex, includeTransitions,
      holdSeconds: holdSeconds ?? DEFAULT_HOLD_SECONDS,
    });
    // THE letterbox composite — shared with the client-backend job below and with
    // the server-side headless worker's page half (web/renderJobPage.js), so all
    // three produce the same pixels for the same frame.
    const renderFrame = createLetterboxFrameRenderer({ doc: this.doc, registry: this.registry, width, height, background });
    const encoder = await createServerMp4Encoder({ fps, crf });
    const blob = await exportVideo({
      plan, renderFrame, encoder, width, height, fps, samples,
      setTime: setParticleTimeOverride, // controlled time → ambient-clock effects blur too
      onProgress, signal,
    });
    if (download) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.projectName()}.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    return blob;
  }

  /**
   * Command (async; submits a job, and for the client backend renders into it).
   * SUBMIT A RENDER JOB — the one entry point both backends go through.
   *
   * WHY THIS REPLACED "export and hold a promise". exportMp4 above makes THIS PAGE
   * the owner of the render: its progress lives in a component, so closing the
   * dialog, refreshing, or an editor hot-reload destroyed the work with no way to
   * find it again. A job instead belongs to the SERVER — submit hands over a
   * SNAPSHOT of the document and returns immediately, and every later question
   * ("how far along?", "where is the file?") is answered by polling
   * listRenderJobs. Nothing the page holds is load-bearing.
   *
   * THE SNAPSHOT IS TAKEN SERVER-SIDE AT SUBMIT from the doc posted here, so
   * editing the deck a second later cannot splice two documents into one video.
   *
   * backend "server": the server spawns headless workers; the page's job is over.
   * backend "client": this page fills the SAME job's frame directory (the browser
   *   has a real GPU and renders media, which the headless path cannot yet), then
   *   asks for the SAME shared encode. It appears in the same list with the same
   *   progress bar — one job shape, two frame producers.
   *
   * @param {object} o
   * @param {string} o.name Job name; also the output filename stem.
   * @param {string} o.backend "server" | "client".
   * @param {object} o.params width/height/fps/crf/background/range/samples/…
   * @param {AbortSignal} [o.signal] Cancels a CLIENT-backend frame walk.
   * @returns {Promise<object>} the submitted job record (NOT the finished movie)
   */
  async submitRender({ name, backend, params, signal }) {
    const { timelinePlan, frameCount, DEFAULT_HOLD_SECONDS } = await import("./videoExport.js");
    const { submitRenderJob } = await import("./projectApi.js");
    const plan = timelinePlan(this.doc, {
      startIndex: params.startIndex,
      endIndex: params.endIndex,
      includeTransitions: params.includeTransitions,
      holdSeconds: params.holdSeconds ?? DEFAULT_HOLD_SECONDS,
    });
    // The denominator for the progress bar, computed from the SAME pure helpers
    // the headless worker uses on the same document — so both agree — and sent
    // only so the bar has a total before the first frame lands.
    const framesTotal = frameCount(plan.duration, params.fps);
    const job = await submitRenderJob(this.projectName(), {
      name, backend, framesTotal, params, doc: this.doc,
    });
    if (backend === "client") this.#fillClientRenderJob(job, params, plan, signal);
    return job;
  }

  /**
   * Command (async, fire-and-forget). Render a CLIENT-backend job's frames from
   * this page and ask for the shared encode.
   *
   * DELIBERATELY NOT AWAITED by the caller: the Render Center tracks this job by
   * POLLING the server like any other, so the modal can be closed while it runs
   * and a reopened modal picks it straight back up. A failure is reported to the
   * console AND lands on the job record (the server marks a job failed when its
   * finish call throws), so it is never a silent stall.
   */
  async #fillClientRenderJob(job, params, plan, signal) {
    const { exportVideo } = await import("./videoExport.js");
    const { createJobFrameEncoder } = await import("./serverMp4Encoder.js");
    const { createLetterboxFrameRenderer } = await import("./transitionRender.js");
    const { setParticleTimeOverride } = await import("../render_gpu/particle_clock.js");
    const { cancelRenderJob } = await import("./projectApi.js");
    const { width, height, fps, samples, background } = params;
    // THE letterbox composite (transitionRender) — the SAME function exportMp4 and
    // the server-side headless worker use, so a job's pixels do not depend on
    // which backend filled its frame directory.
    const renderFrame = createLetterboxFrameRenderer({ doc: this.doc, registry: this.registry, width, height, background });
    try {
      await exportVideo({
        plan, renderFrame, width, height, fps, samples,
        encoder: await createJobFrameEncoder({ project: job.project, jobId: job.id }),
        setTime: setParticleTimeOverride, // controlled time → ambient-clock effects animate + blur
        signal,
      });
    } catch (e) {
      console.error(`Client render job "${job.name}" failed:`, e);
      // Abort is a user action, not a failure — leave the job cancelled, not
      // "failed", so the list tells the truth about why it stopped.
      await cancelRenderJob(job.project, job.id).catch((err) =>
        console.error(`Could not mark render job ${job.id} cancelled:`, err));
    }
  }

  // ── Copy selection as PNG/PDF (manifest Round 12B "Palette / selection
  // commands"): render ONLY the selected items, cropped to their collective
  // world AABB, onto the SYSTEM clipboard. Distinct from exportPng/exportPdf
  // (which always render the FULL slide through THE CAMERA) — these two crop
  // to the selection instead, reusing the same GPU/PDF backends. ──────────────

  /**
   * Query. The selected nodes' collective WORLD AABB (union of each selected
   * bbox node's effectInclusiveAABB — rotatedBBoxAABB, the same conservative
   * rotation-aware bound the culling protocol uses, inflated by that node's
   * shadow/bloom reach so a copied/exported PNG contains the WHOLE rendered
   * element, halo and all — manifest 15.8 ADDITION), or null when nothing
   * selected or none of the selected items have a bbox (e.g. only the
   * camera, or a non-bbox widget alone — nothing to crop to).
   */
  selectionWorldAABB() {
    const boxes = this.selectedNodes().map(effectInclusiveAABB).filter(Boolean);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Query. The render job for the SELECTED ITEMS ONLY — `{rect, nodes}` where
   *  rect is their collective world AABB (selectionWorldAABB) and nodes are the
   *  derived render-tree nodes of exactly those items (not everything that
   *  merely intersects the box) — or null when there is nothing with a bbox to
   *  render (e.g. a camera-only selection). The ONE place copy-as-PNG,
   *  copy-as-PDF, and the copySelection OS render agree on WHAT to rasterize. */
  #selectionRenderJob() {
    const rect = this.selectionWorldAABB();
    if (!rect || rect.w <= 0 || rect.h <= 0) return null;
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
    const selected = new Set(this.selectedIds());
    const nodes = deriveRenderTree(state, this.registry).filter((n) => selected.has(n.itemId));
    return { rect, nodes };
  }

  /**
   * Command (async). Rasterizes the current selection to PNG bytes at its pixel
   * resolution (dpr-scaled), or null when there is no bbox to render. THE shared
   * selection-crop rasterize path (copySelection's OS write and copyAsPng both
   * call it). Reports loudly and returns null on a render failure.
   *
   * fitRectView's (w, h) args are WORLD units (rect.w/rect.h) — dpr is a
   * SEPARATE multiplier the compositor applies on top (view.zoom * view.dpr;
   * core/view.js fitRectView doctests). Passing the already-dpr-scaled device px
   * as (w, h) double-applies dpr (at dpr 2 it rasterizes 4x too big so only the
   * top-left quarter fills — the 15.8 bug); world units is what every other
   * rasterizeIrPng caller passes, with dpr flowing through the 4th arg only.
   *
   * @returns {Promise<Uint8Array|null>} PNG bytes, or null (nothing to render)
   */
  async #renderSelectionPng() {
    const job = this.#selectionRenderJob();
    if (!job) return null;
    const { rect, nodes } = job;
    const dpr = this.dpr();
    const width = Math.max(1, Math.round(rect.w * dpr));
    const height = Math.max(1, Math.round(rect.h * dpr));
    try {
      return await rasterizeIrPng(sceneIR(nodes), fitRectView(rect, rect.w, rect.h, dpr), width, height);
    } catch (e) {
      console.error("Render selection PNG failed:", e.message);
      return null;
    }
  }

  /**
   * Command (async). Renders the SELECTED ITEMS ONLY (not everything that
   * merely intersects their box — the spec's "whatever bounding box are the
   * things we currently select we copy that") at their collective world AABB
   * to PNG bytes, then writes those bytes to the SYSTEM clipboard as
   * image/png (navigator.clipboard.write + ClipboardItem). No camera
   * background rect is drawn first (unlike exportPng) — outside the selected
   * items' own fills, the PNG is transparent.
   *
   * Loud on failure: clipboard image writes need a permission browsers can
   * silently deny, and unlike copySelection's item-copy (which has an in-app
   * fallback) THERE IS NO IN-APP FALLBACK for a system-image copy — pasting
   * into another app is the entire point, so a denial is reported, not
   * swallowed. No-op (reported) with nothing selected.
   */
  async copyAsPng() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      console.error("Copy as PNG: this browser has no Clipboard image-write API (navigator.clipboard.write/ClipboardItem) — cannot copy an image to the system clipboard.");
      return;
    }
    // Same selection-crop rasterize as the copySelection OS render (#renderSelectionPng).
    const png = await this.#renderSelectionPng();
    if (!png) {
      console.error("Copy as PNG: nothing selected (or the selection has no bounding box) — nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
    } catch (e) {
      console.error("Copy as PNG: system clipboard write was denied or failed (permission?) — the in-app clipboard fallback does NOT apply to system-image copies:", e.message);
    }
  }

  /**
   * Command (async). Renders the SELECTED ITEMS ONLY at their collective
   * world AABB through the vector PDF backend (exportPdf's irToPDF path,
   * same hybrid-raster/text-embedding rules), then tries to put the PDF
   * bytes on the SYSTEM clipboard as application/pdf. Most browsers' Async
   * Clipboard API only allows a small clipboard-item type allowlist
   * (image/png, text/plain, text/html) and REJECTS application/pdf — when
   * that happens this falls back to DOWNLOADING the PDF file, with a loud
   * console.warn explaining why: a reported degradation, never a silent one.
   * No-op (reported) with nothing selected.
   */
  async copyAsPdf() {
    const job = this.#selectionRenderJob();
    if (!job) {
      console.error("Copy as PDF: nothing selected (or the selection has no bounding box) — nothing to copy.");
      return;
    }
    const { rect, nodes } = job;
    const { irToPDF } = await import("../render_gpu/pdf_backend.js");
    const { loadFontBytes, fontkit, measureTextAscent, measureText } = await import("./pdfFonts.js");
    const bytes = await irToPDF(sceneIR(nodes), {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: null, // no camera background — transparent outside the selected items
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      measureText: measureText(), // RICH-TEXT layout seam (Round 13.4) — see exportPdf
      loadFontBytes,
      registerFontkit: await fontkit(),
    });
    const blob = new Blob([bytes], { type: "application/pdf" });
    let wroteToClipboard = false;
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "application/pdf": blob })]);
        wroteToClipboard = true;
      } catch (e) {
        console.warn(`Copy as PDF: the browser's clipboard rejected application/pdf (${e.message}) — falling back to downloading the PDF file instead of a silent failure.`);
      }
    } else {
      console.warn("Copy as PDF: this browser has no Clipboard write API for application/pdf — falling back to downloading the PDF file instead of a silent failure.");
    }
    if (!wroteToClipboard) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.projectName()}-selection.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
}
