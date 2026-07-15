/**
 * PowerRPApp — the headless application state (Svelte 5 runes class, same
 * pattern as src/lib/player.svelte.js). Owns the document + undo log +
 * selection + registries, and is the `app` facade that ALL commands receive:
 * palette entries, keyboard shortcuts, toolbar buttons, and (future) context
 * menus are different surfacings of the ONE command registry.
 */

import {
  newDocument, foldState, keyframed, unkeyframed, hasKeyframe, keyframeIndices,
  withNewItem, withItemPurged, withNewSlide, withSlideDeleted, withSlideMoved,
  withSlideToggled, withNormalizedZ, bisectedZ, serialize, deserialize,
  withCameraEnsured, withOrphanedItemsDropped, withMissingDefaultsFilled,
  withLegacyKeysRenamed,
} from "../core/document.js";
import { setPath, getPath, blendApplied } from "../core/deltas.js";
import { withDurationMigrated, resolveTransition, retypedTransition } from "../core/transitions.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { evaluateState, withBindingsMigrated, withVariableRenamed, anchorRefName } from "../core/expressions.js";
import { rotatedBBoxAABB, fitRectView } from "../core/view.js";
import { sceneIR } from "../render_gpu/ports.js";
import { renderCameraFrame, rasterizeIrPng } from "./gpuService.js";
import * as projectApi from "./projectApi.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { createShortcuts } from "../core/shortcuts.js";
import { createUndo } from "../core/undo.js";
import { registerAll } from "../plugins/index.js";
import { imagePlugin } from "../plugins/image.js"; // insertImageAsset reuses its defaults
import { videoPlugin } from "../plugins/video.js"; // insertVideoAsset reuses its defaults

const AUTOSAVE_KEY = "powerrp.autosave";
const THEME_KEY = "powerrp.theme";
const BAND_MODE_KEY = "powerrp.bandMode";

/** Theme catalog — viewer preference (localStorage), NOT document state.
 * Each id matches a `:root[data-theme="…"]` block in app.css. */
export const THEMES = [
  { id: "graphite", title: "Graphite (dark)" },
  { id: "light", title: "Light" },
  { id: "black", title: "Pure Black" },
  { id: "warm", title: "Warm Gray (dark)" },
];

export class PowerRPApp {
  doc = $state(newDocument());
  slideIndex = $state(0);
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
    this.#selection = id;
    this.selectionSet = []; // single-select write drops the multi override
    if (id !== null) this.selectedTransition = null; // item and transition selection are mutually exclusive
  }
  // MULTI-select override: the FULL set of selected itemIds (band select /
  // future multi-click). Authoritative when non-empty; its FIRST element is
  // mirrored into `selection` (the primary) so single-item consumers still
  // work. Empty → selectedIds() falls back to [selection]. Populated only by
  // selectMany(); cleared by any single-select `selection` write (see above).
  selectionSet = $state([]);
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
  // Which drag gesture is live: null | "move" | "resize" — drives the
  // HintBar's per-gesture modifier hints (manifest "Drag/resize modifiers":
  // auto-announce while dragging). Endpoint drags leave it null (they have
  // no modifier behaviors to announce).
  dragKind = $state(null);
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
  theme = $state("graphite");
  minimapVisible = $state(localStorage.getItem("powerrp.minimap") !== "off");
  // BROWSER setting (viewer-local): optionally show each panel's canonical name
  // (Slide Navigator / Property Panel / Keyframe Panel) as a title bar at its
  // top. OFF by default (panels are not first-class — manifest Round 7).
  panelNames = $state(localStorage.getItem("powerrp.panelNames") === "on");
  // BROWSER setting (viewer-local, travels with the browser not the file):
  // render raster surfaces at devicePixelRatio. Default ON (manifest).
  retina = $state(localStorage.getItem("powerrp.retina") !== "off");
  // BROWSER settings (viewer-local, default ON): master snap toggle (gates ALL
  // snapping — move AND resize) and the snap-size / matching-dimension toggle.
  snapEnabled = $state(localStorage.getItem("powerrp.snap") !== "off");
  snapSizeEnabled = $state(localStorage.getItem("powerrp.snapSize") !== "off");
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
  // BROWSER settings (viewer-local): editor-only Blender-style background grid
  // and top ruler strip. Both are "options" defaulting OFF (manifest: Grid +
  // Ruler). Persisted per-browser like the other viewer preferences above.
  gridEnabled = $state(localStorage.getItem("powerrp.grid") === "on");
  rulerEnabled = $state(localStorage.getItem("powerrp.ruler") === "on");
  // BROWSER setting (viewer-local, default OFF — manifest ARCHITECTURE PLAN #2
  // GHOST capability): shows/hides GHOST outlines (empty text, groups) on the
  // CanvasView SVG overlay. Crop-box ghost outlines are NOT gated by this —
  // they show ALWAYS (core/derive.isGhostNode + the "always" rule: a crop box
  // is unclickable otherwise). Persisted like grid/ruler.
  showGhosts = $state(localStorage.getItem("powerrp.showGhosts") === "on");
  // BROWSER setting (viewer-local, default OFF): the bottom-left FPS counter
  // (shows in the editor AND present mode — user spec, round 11).
  fpsVisible = $state(localStorage.getItem("powerrp.fps") === "on");
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

  toggleMinimap() {
    this.minimapVisible = !this.minimapVisible;
    localStorage.setItem("powerrp.minimap", this.minimapVisible ? "on" : "off");
  }

  toggleFps() {
    this.fpsVisible = !this.fpsVisible;
    localStorage.setItem("powerrp.fps", this.fpsVisible ? "on" : "off");
  }

  toggleRetina() {
    this.retina = !this.retina;
    localStorage.setItem("powerrp.retina", this.retina ? "on" : "off");
  }

  togglePanelNames() {
    this.panelNames = !this.panelNames;
    localStorage.setItem("powerrp.panelNames", this.panelNames ? "on" : "off");
  }

  toggleSnap() {
    this.snapEnabled = !this.snapEnabled;
    localStorage.setItem("powerrp.snap", this.snapEnabled ? "on" : "off");
  }

  toggleSnapSize() {
    this.snapSizeEnabled = !this.snapSizeEnabled;
    localStorage.setItem("powerrp.snapSize", this.snapSizeEnabled ? "on" : "off");
  }

  toggleGrid() {
    this.gridEnabled = !this.gridEnabled;
    localStorage.setItem("powerrp.grid", this.gridEnabled ? "on" : "off");
  }

  toggleRuler() {
    this.rulerEnabled = !this.rulerEnabled;
    localStorage.setItem("powerrp.ruler", this.rulerEnabled ? "on" : "off");
  }

  toggleGhosts() {
    this.showGhosts = !this.showGhosts;
    localStorage.setItem("powerrp.showGhosts", this.showGhosts ? "on" : "off");
  }

  /** Query. The effective devicePixelRatio for all raster rendering. */
  dpr() {
    return this.retina ? window.devicePixelRatio || 1 : 1;
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
    if (ids.length === 0) {
      this.selection = null; // clears both (accessor path)
      return;
    }
    this.#selection = ids[0];
    this.selectionSet = [...ids];
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
   * type itself is the only per-plugin knowledge CanvasView needs. */
  armCrosshairPlacement(plugin) {
    this.crosshair = { kind: "place", plugin };
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

  /** Display name for an item: its `name` state, else "<Type> (id-prefix)". */
  displayName(itemId) {
    const s = this.state().items?.[itemId];
    if (!s) return itemId;
    if (s.name) return s.name;
    return `${this.registry.get(s.type).title} (${itemId.slice(0, 4)})`;
  }

  // ── Theme (viewer preference — not document state, not undoable) ──────────

  setTheme(id) {
    this.theme = id;
    document.documentElement.dataset.theme = id;
    localStorage.setItem(THEME_KEY, id);
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
    return { doc, selection: this.selection, slideIndex: this.slideIndex, viewport: this.lastViewport };
  }

  applySnapshot(snap) {
    this.doc = snap.doc;
    this.selection = snap.selection;
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
  }

  // ── Copy / paste ───────────────────────────────────────────────────────────
  // Whole-object by default; single properties via the palette submenu.
  // Clipboard payloads are tagged JSON: {powerrp_item: state} or
  // {powerrp_props: {key: value}}.

  // In-app clipboard (a JSON string snapshot). WHY: navigator.clipboard.readText
  // needs a permission browsers can deny silently-to-the-user — readText then
  // rejects and paste no-ops (the probe-confirmed "paste does not create new
  // objects" bug). Copy ALWAYS lands here; the system clipboard is written
  // best-effort on top (cross-tab paste). Stored as a string so later doc
  // mutations can never alias into the copied payload. Not $state — no UI reads.
  #clipboardFallback = null;

  /** Command. Snapshots `payload` to the in-app clipboard (always succeeds),
   * then best-effort mirrors it to the system clipboard — a write failure is
   * REPORTED but does not fail the copy (the in-app copy is already good). */
  async #writeClipboard(payload) {
    this.#clipboardFallback = JSON.stringify(payload);
    try {
      await navigator.clipboard.writeText(this.#clipboardFallback);
    } catch (e) {
      console.error("Copy: system clipboard write failed (in-app clipboard still set):", e.message);
    }
  }

  async copySelection() {
    if (!this.selection) return;
    // RAW state: equations copy as equations, not their evaluated snapshots.
    const state = this.rawState().items?.[this.selection];
    if (!state) return;
    await this.#writeClipboard({ powerrp_item: state });
  }

  async copyProperty(key) {
    if (!this.selection) return;
    const value = this.storedItemValue(this.selection, key.split(".")); // dotted keys = nested paths
    if (value === undefined) return;
    await this.#writeClipboard({ powerrp_props: { [key]: value } });
  }

  async pasteClipboard() {
    // System clipboard first (cross-tab paste, and it may hold a NEWER copy);
    // in-app fallback second. A read failure (permission denied — the common
    // real-world case) or foreign/non-PowerRP content falls back to the last
    // in-app copy: a PowerRP "Paste" action pasting the last PowerRP copy
    // beats silently doing nothing. Both outcomes are reported.
    let payload = null;
    try {
      payload = JSON.parse(await navigator.clipboard.readText());
    } catch (e) {
      console.warn("Paste: system clipboard unreadable or not JSON — trying the in-app clipboard:", e.message);
    }
    if (!payload?.powerrp_item && !payload?.powerrp_props) {
      if (!this.#clipboardFallback) {
        console.warn("Paste: nothing PowerRP-shaped on the system clipboard and no in-app copy yet.");
        return;
      }
      payload = JSON.parse(this.#clipboardFallback);
    }
    if (payload.powerrp_item) {
      const s = payload.powerrp_item;
      // ONE camera per document: pasting a camera keyframes its ASPECTS onto
      // the existing camera instead of duplicating it (user spec).
      const existingCamera = s.type === "camera"
        ? this.nodes().find((n) => n.type === "camera") : null;
      if (existingCamera) {
        let doc = this.doc;
        for (const key of ["x", "y", "w", "h"])
          doc = keyframed(doc, this.slideIndex, ["items", existingCamera.itemId, key], s[key]);
        this.commit(doc);
        this.selection = existingCamera.itemId;
        return;
      }
      // Paste offset: one spacing step, same convention PowerPoint uses for
      // paste-in-place collisions (precedent, not an invented constant).
      // Equation-valued coordinates are left VERBATIM — offsetting a string
      // would concatenate ("circle.x + 10" + 16); the pasted copy keeps its
      // binding and lands wherever the equation says.
      const OFFSET = 16;
      const bump = (v) => (typeof v === "number" ? v + OFFSET : v);
      this.addItem({ ...s, x: bump(s.x ?? 0), y: bump(s.y ?? 0) });
    } else if (payload.powerrp_props && this.selection) {
      let doc = this.doc;
      for (const [key, value] of Object.entries(payload.powerrp_props))
        doc = keyframed(doc, this.slideIndex, ["items", this.selection, ...key.split(".")], value);
      this.commit(doc);
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
    let doc = this.doc;
    for (const id of ids) doc = withItemPurged(doc, id);
    this.commit(doc);
    this.selection = null;
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

  // ── Z-order (bisect + normalize; tweened z stays ephemeral) ───────────────

  zPairs() {
    return this.nodes().map((n) => [n.itemId, n.state.z ?? 0]);
  }

  reorderSelection(direction) {
    if (!this.selection) return;
    const z = bisectedZ(this.zPairs(), this.selection, direction);
    this.commit(withNormalizedZ(keyframed(this.doc, this.slideIndex, ["items", this.selection, "z"], z)));
  }

  /** "Put on Top"/"Put on Bottom": beyond the extremes of VISIBLE items on this slide. */
  sendToExtreme(direction) {
    if (!this.selection) return;
    const zs = this.zPairs().map(([, z]) => z);
    const z = direction > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    this.commit(withNormalizedZ(keyframed(this.doc, this.slideIndex, ["items", this.selection, "z"], z)));
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
   * Command (reports). Drops orphaned items (typeless / unknown type) and
   * console.errors EVERY drop — a bad item must never brick the render loop,
   * and silent repairs are forbidden. Re-ensures THE camera afterward (the
   * camera itself can be orphaned by deleting its creation slide).
   */
  repaired(doc) {
    const known = new Set(this.registry.all().map((p) => p.type));
    const { doc: dropDoc, dropped } = withOrphanedItemsDropped(doc, known);
    for (const { id, reason } of dropped)
      console.error(`PowerRP repair: dropped item "${id}" — ${reason}`);
    // Legacy key renames MUST run BEFORE the defaults fill (regression-tested:
    // fill-first writes the new key's default and the rename then drops the
    // user's legacy value as stale — data loss). Values move verbatim across
    // every slide: numbers, equations, and null delete-sentinels alike.
    const { doc: renamedDoc, renamed } = withLegacyKeysRenamed(dropDoc, this.registry);
    for (const r of renamed)
      console.error(`PowerRP repair: item "${r.id}" slide ${r.slideIndex}: legacy "${r.from}" → "${r.to}"${r.stale ? " (stale copy dropped)" : ""}`);
    // Typed-but-partial items (e.g. a rect that never got a w anywhere) fold
    // into states the strict IR builders reject — fill from plugin defaults.
    let { doc: out, filled } = withMissingDefaultsFilled(renamedDoc, this.registry);
    for (const { id, missing } of filled)
      console.error(`PowerRP repair: item "${id}" was missing ${missing.map((m) => m.path.join(".")).join(", ")} — filled with plugin defaults`);
    // Frame caps no longer exist (round 11: "No more optional caps, just keep
    // the meter and no cap") — meta.fps is dead; strip it from legacy docs.
    if ("fps" in out.meta) {
      const meta = { ...out.meta };
      delete meta.fps;
      out = { ...out, meta };
      console.error("PowerRP repair: removed legacy meta.fps — presentations are always uncapped");
    }
    // TRANSITIONS (Round 12): transition.seconds SUPERSEDES the old per-slide
    // `duration` (lead ruling). Move duration → transition = {type: "tween",
    // seconds, curve: "smooth", sound: null} LOUDLY; curve "smooth" preserves
    // today's eased playback so behavior is unchanged. Same load-boundary
    // discipline as meta.fps / withLegacyKeysRenamed.
    const { doc: transDoc, migrated } = withDurationMigrated(out);
    for (const m of migrated)
      console.error(`PowerRP repair: slide ${m.index} legacy "duration" (${m.seconds}s) → transition.seconds${m.stale ? " (already had a transition — stale duration dropped)" : ""}`);
    out = transDoc;
    return withCameraEnsured(out);
  }

  /** Toggles whether slide `index` (default: current) contributes its delta. */
  toggleSlide(index = this.slideIndex) {
    this.commit(withSlideToggled(this.doc, index));
  }

  moveSlide(offset) {
    this.commit(withSlideMoved(this.doc, this.slideIndex, offset));
    this.slideIndex = Math.max(0, Math.min(this.doc.slides.length - 1, this.slideIndex + offset));
  }

  // ── Save / load ────────────────────────────────────────────────────────────

  saveFile() {
    const blob = new Blob([serialize(this.doc)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${this.doc.meta.name || "presentation"}.powerrp.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

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
    this.commit(withBindingsMigrated(this.repaired(deserialize(await file.text()))));
    this.slideIndex = 0;
    this.selection = null;
  }

  // ── Project server (projects are FOLDERS: doc.json + assets/) ────────────────
  // The server (server/server.py) owns project storage. These methods are the
  // app's seam to it (thin client = web/projectApi.js). doc.meta.name is the
  // project name. The localStorage autosave (commit → AUTOSAVE_KEY) stays as
  // crash-safety and is INDEPENDENT of project storage — a project must be
  // saved to the server explicitly (Save to Server). Errors surface loudly.

  /** Query. The current project name (doc.meta.name), defaulting to "Untitled". */
  projectName() {
    return this.doc.meta.name || "Untitled";
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

  /** Command. Load a project from the server by name into the editor (same
   *  repair + binding migration as loadFile). UI resets mirror loadFile. */
  async loadProject(name) {
    const { doc } = await projectApi.loadProject(name);
    this.commit(withBindingsMigrated(this.repaired(doc)));
    this.slideIndex = 0;
    this.selection = null;
  }

  /** Command. Download the current project as a .zip (server-built from the
   *  folder). Saves the doc first so the ZIP reflects the live document. */
  async downloadZip(name = this.projectName()) {
    await this.saveToServer(name);
    await projectApi.downloadProjectZip(name);
  }

  // ── Assets: upload / delete / insert / filmstrip frames (one region) ────────

  /** Bumped on every asset add/remove, so asset consumers (the Asset Explorer
   *  pane) can re-list reactively — e.g. a canvas OS-file drop must show up in
   *  the pane without a manual Refresh. Monotonic, viewer-local, not undoable. */
  assetsVersion = $state(0);

  /** Command. Upload a File/Blob into the current project's assets/ folder
   *  (the source of truth for the asset library). Returns {ok, name, url}.
   *  Saves the project first so the folder exists server-side. */
  async uploadAsset(file, filename = file.name, name = this.projectName()) {
    await this.saveToServer(name);
    const res = await projectApi.uploadAsset(name, file, filename);
    this.assetsVersion++;
    return res;
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

  // ── Filmstrip frames wiring (grep handles: fetchFrames / frameUrls). The
  // filmstrip plugin stores only (src, frames); frameUrls is server-derived
  // data this effect fills in (plugins/filmstrip.js documents the contract:
  // "an app-side effect requests them whenever src/frames changes"). ─────────

  /** (item|project|src|frames) combos already attempted this session — ONE
   *  fetch per combo, so a FAILURE (server down, bad video) is console.error'd
   *  once and cannot hot-loop the effect; editing src/frames retries naturally
   *  (new combo). A discarded stale fetch un-registers itself (see below).
   *  Not $state: nothing renders it. */
  #framesAttempted = new Set();

  /** Runs during field initialization — i.e. at construction, which happens in
   *  App.svelte's component init (the app's only construction site), so
   *  $effect has an owner. A field (not a constructor statement) keeps the
   *  whole asset region CONTIGUOUS. The effect body is scheduled by Svelte
   *  post-mount, after the constructor finishes (this.registry is set). */
  #filmstripWiring = this.#wireFilmstripFrames();

  #wireFilmstripFrames() {
    // Command (registers a reactive effect). Whenever the CURRENT slide's
    // folded state shows a filmstrip whose (src, frames) has no matching
    // frameUrls, fetch the frame URLs and keyframe them (ONE undo unit).
    // Cheap per run: one evaluated-state read (memoized) + a scan that only
    // inspects filmstrip items.
    $effect(() => {
      const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
      const project = this.projectName();
      for (const [id, s] of Object.entries(state.items ?? {})) {
        if (s.type !== "filmstrip" || typeof s.src !== "string" || !s.src || !(s.frames >= 1)) continue;
        const frames = Math.round(s.frames);
        // Staleness test: the stored URLs' DECODED cache path must name this
        // exact (project, src, frames). Decoding makes the test independent of
        // server-vs-JS percent-encoding differences.
        const want = `/asset/${project}/frames/${s.src}/${frames}/`;
        const urls = Array.isArray(s.frameUrls) ? s.frameUrls : [];
        if (urls.length > 0 && decodeURIComponent(urls[0]).includes(want)) continue; // resolved + current
        const key = `${id}|${want}`;
        if (this.#framesAttempted.has(key)) continue;
        this.#framesAttempted.add(key);
        this.#fillFilmstripFrames(id, s.src, frames, project, want, key);
      }
    });
  }

  /** Command (async). One filmstrip frames fetch → ONE undo-unit frameUrls
   *  keyframe. A result that no longer matches the widget (src/frames retyped,
   *  item purged, slide switched mid-fetch) is DISCARDED and its attempt key
   *  released so the effect can refetch when the combo shows again (the server
   *  cache makes that retry cheap). Fetch failures console.error loudly. */
  async #fillFilmstripFrames(id, src, frames, project, want, key) {
    try {
      const res = await projectApi.fetchFrames(project, src, frames);
      // Re-check against the FRESH doc before writing (no stale writes).
      const s = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state.items?.[id];
      if (!s || s.type !== "filmstrip" || `/asset/${project}/frames/${s.src}/${Math.round(s.frames)}/` !== want) {
        this.#framesAttempted.delete(key); // let the live combo refetch later
        console.warn(`PowerRP filmstrip: discarded a stale frames fetch for "${src}" × ${frames} (widget changed mid-fetch)`);
        return;
      }
      // Keyframe on the slide where the current src/frames combo was AUTHORED
      // (its last keyframe at or before the current slide) so every later
      // slide inherits the resolved strip from the same place the user set it.
      const authoredAt = Math.max(0, ...["src", "frames"].map((k) =>
        Math.max(-1, ...keyframeIndices(this.doc, ["items", id, k]).filter((i) => i <= this.slideIndex))));
      this.commit(keyframed(this.doc, authoredAt, ["items", id, "frameUrls"], res.frames));
    } catch (e) {
      console.error(`PowerRP filmstrip: frames fetch failed for "${src}" × ${frames}:`, e);
    }
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
      "Open Project: the project-picker modal is not wired yet " +
      "(Modal lib component pending). Use app.listProjects() / app.loadProject(name) " +
      "programmatically, or Load Presentation for a local file.",
    );
  }

  /**
   * Clears to a fresh document (round 11: "next to save and load I should be
   * able to clear the current thing"). Goes through commit() so it lands in
   * the UNDO log — undo restores everything, which is the safety net (no
   * confirm dialog by design). newDocument() guarantees THE camera exists.
   * UI resets mirror loadFile: slide 0, nothing selected.
   */
  clearDoc() {
    this.commit(newDocument());
    this.slideIndex = 0;
    this.selection = null;
  }

  loadAutosave() {
    const json = localStorage.getItem(AUTOSAVE_KEY);
    if (json) {
      // Load-time migrations: repaired() drops orphaned items LOUDLY and
      // ensures THE camera; withBindingsMigrated converts legacy
      // {item, anchor} arrow bindings to equation pairs (THE UNIFICATION).
      this.doc = withBindingsMigrated(this.repaired(deserialize(json)));
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
    a.download = `${this.doc.meta.name || "presentation"}-slide${this.slideIndex + 1}.png`;
    a.click();
  }

  /**
   * Exports the current slide as a VECTOR PDF (manifest "PDF export, round
   * 11"): shapes/text stay vector (text selectable), blur regions embed as
   * raster per the hybrid rule. The camera rect IS the page (pt = world px).
   */
  async exportPdf() {
    const { irToPDF } = await import("../render_gpu/pdf_backend.js");
    const { sceneIR } = await import("../render_gpu/ports.js");
    const { fitRectView } = await import("../core/view.js");
    const { loadFontBytes, fontkit, measureTextAscent } = await import("./pdfFonts.js");
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
    const rect = cameraRect(state, this.doc.meta);
    // Embed the SAME committed fonts the glyph atlas rasterizes (manifest "Text
    // fonts" / embedFont seam): registerFontkit + loadFontBytes let pdf-lib
    // embed the TTFs; measureTextAscent gives per-font baseline parity with the
    // atlas. `system` text still uses standard-14 Helvetica (no committed file).
    const bytes = await irToPDF(sceneIR(deriveRenderTree(state, this.registry)), {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: rect.background,
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
      loadFontBytes,
      registerFontkit: await fontkit(),
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    a.download = `${this.doc.meta.name || "presentation"}-slide${this.slideIndex + 1}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Copy selection as PNG/PDF (manifest Round 12B "Palette / selection
  // commands"): render ONLY the selected items, cropped to their collective
  // world AABB, onto the SYSTEM clipboard. Distinct from exportPng/exportPdf
  // (which always render the FULL slide through THE CAMERA) — these two crop
  // to the selection instead, reusing the same GPU/PDF backends. ──────────────

  /**
   * Query. The selected nodes' collective WORLD AABB (union of each selected
   * bbox node's rotatedBBoxAABB — the same conservative rotation-aware bound
   * the culling protocol uses), or null when nothing selected or none of the
   * selected items have a bbox (e.g. only the camera, or a non-bbox widget
   * alone — nothing to crop to).
   */
  selectionWorldAABB() {
    const boxes = this.selectedNodes().map(rotatedBBoxAABB).filter(Boolean);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
    const rect = this.selectionWorldAABB();
    if (!rect || rect.w <= 0 || rect.h <= 0) {
      console.error("Copy as PNG: nothing selected (or the selection has no bounding box) — nothing to copy.");
      return;
    }
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
    const selected = new Set(this.selectedIds());
    const nodes = deriveRenderTree(state, this.registry).filter((n) => selected.has(n.itemId));
    const dpr = this.dpr();
    const width = Math.max(1, Math.round(rect.w * dpr));
    const height = Math.max(1, Math.round(rect.h * dpr));
    const png = await rasterizeIrPng(sceneIR(nodes), fitRectView(rect, width, height, dpr), width, height);
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
    const rect = this.selectionWorldAABB();
    if (!rect || rect.w <= 0 || rect.h <= 0) {
      console.error("Copy as PDF: nothing selected (or the selection has no bounding box) — nothing to copy.");
      return;
    }
    const { irToPDF } = await import("../render_gpu/pdf_backend.js");
    const { loadFontBytes, fontkit, measureTextAscent } = await import("./pdfFonts.js");
    const state = evaluateState(foldState(this.doc, this.slideIndex, 1), this.registry).state;
    const selected = new Set(this.selectedIds());
    const nodes = deriveRenderTree(state, this.registry).filter((n) => selected.has(n.itemId));
    const bytes = await irToPDF(sceneIR(nodes), {
      width: rect.w,
      height: rect.h,
      view: fitRectView(rect, rect.w, rect.h, 1),
      background: null, // no camera background — transparent outside the selected items
      rasterize: rasterizeIrPng,
      textAscent: measureTextAscent(),
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
      a.download = `${this.doc.meta.name || "presentation"}-selection.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
}
