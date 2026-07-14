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
  withCameraEnsured,
} from "../core/document.js";
import { setPath, blendApplied } from "../core/deltas.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { paintScene, fitRectView } from "../render/compositor.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { createShortcuts } from "../core/shortcuts.js";
import { createUndo } from "../core/undo.js";
import { registerAll } from "../plugins/index.js";

const AUTOSAVE_KEY = "powerrp.autosave";
const THEME_KEY = "powerrp.theme";

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
  selection = $state(null); // itemId | null
  mode = $state("edit"); // "edit" | "present"
  anchorsVisible = $state(false);
  paletteOpen = $state(false);
  dragging = $state(false); // canvas sets this; drives HintBar context
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
  // BROWSER settings (viewer-local): editor-only Blender-style background grid
  // and top ruler strip. Both are "options" defaulting OFF (manifest: Grid +
  // Ruler). Persisted per-browser like the other viewer preferences above.
  gridEnabled = $state(localStorage.getItem("powerrp.grid") === "on");
  rulerEnabled = $state(localStorage.getItem("powerrp.ruler") === "on");
  // Reactive flag CanvasView raises while any snap correction is applied in the
  // current pointer-move; cleared on pointer-up. Drives the toolbar toggle
  // taking the guide color while a snap is actually engaged.
  snapEngaged = $state(false);

  toggleMinimap() {
    this.minimapVisible = !this.minimapVisible;
    localStorage.setItem("powerrp.minimap", this.minimapVisible ? "on" : "off");
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

  /** Query. The effective devicePixelRatio for all raster rendering. */
  dpr() {
    return this.retina ? window.devicePixelRatio || 1 : 1;
  }

  constructor() {
    this.registry = createRegistry();
    this.commands = createCommands();
    this.shortcuts = createShortcuts();
    this.undoLog = createUndo(this.snapshot(this.doc));
    this.canvasActions = null; // PanZoom actions, set by CanvasView
    registerAll(this.registry, this.commands);
  }

  // ── State queries ──────────────────────────────────────────────────────────

  /** Folded state of the current slide, with any live drag preview applied. */
  state() {
    const base = foldState(this.doc, this.slideIndex, 1);
    return this.previewDelta ? blendApplied(base, this.previewDelta, 1) : base;
  }

  nodes() {
    return deriveRenderTree(this.state(), this.registry);
  }

  selectedNode() {
    return this.nodes().find((n) => n.itemId === this.selection) ?? null;
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

  async copySelection() {
    const node = this.selectedNode();
    if (!node) return;
    await navigator.clipboard.writeText(JSON.stringify({ powerrp_item: node.state }));
  }

  async copyProperty(key) {
    const node = this.selectedNode();
    if (!node || !(key in node.state)) return;
    await navigator.clipboard.writeText(JSON.stringify({ powerrp_props: { [key]: node.state[key] } }));
  }

  async pasteClipboard() {
    let payload;
    try {
      payload = JSON.parse(await navigator.clipboard.readText());
    } catch (e) {
      console.warn("Paste: clipboard is not PowerRP JSON:", e.message);
      return;
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
      const OFFSET = 16;
      this.addItem({ ...s, x: (s.x ?? 0) + OFFSET, y: (s.y ?? 0) + OFFSET });
    } else if (payload.powerrp_props && this.selection) {
      let doc = this.doc;
      for (const [key, value] of Object.entries(payload.powerrp_props))
        doc = keyframed(doc, this.slideIndex, ["items", this.selection, key], value);
      this.commit(doc);
    }
  }

  /** "Delete": keyframe active:false here — identity survives (symlink-safe). */
  deleteSelection() {
    if (!this.selection) return;
    this.commit(keyframed(this.doc, this.slideIndex, ["items", this.selection, "active"], false));
    this.selection = null;
  }

  /** True removal FROM EXISTENCE: every keyframe of the item on every slide. */
  purgeSelection() {
    if (!this.selection) return;
    this.commit(withItemPurged(this.doc, this.selection));
    this.selection = null;
  }

  keyframeSelected(key, value) {
    if (!this.selection) return;
    this.commit(keyframed(this.doc, this.slideIndex, ["items", this.selection, key], value));
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

  hasKey(key) {
    return this.selection ? hasKeyframe(this.doc, this.slideIndex, ["items", this.selection, key]) : false;
  }

  removeKey(slideIndex, path) {
    this.commit(unkeyframed(this.doc, slideIndex, path));
  }

  /** Jump to the prev/next slide holding a keyframe for the selected item's key. */
  jumpKeyframe(key, direction) {
    if (!this.selection) return;
    const idxs = keyframeIndices(this.doc, ["items", this.selection, key]);
    const next = direction > 0 ? idxs.find((i) => i > this.slideIndex) : [...idxs].reverse().find((i) => i < this.slideIndex);
    if (next !== undefined) this.slideIndex = next;
  }

  // ── Slides ─────────────────────────────────────────────────────────────────

  addSlide() {
    const [doc, idx] = withNewSlide(this.doc, this.slideIndex);
    this.commit(doc);
    this.slideIndex = idx;
  }

  deleteSlide() {
    this.commit(withSlideDeleted(this.doc, this.slideIndex));
    this.slideIndex = Math.min(this.slideIndex, this.doc.slides.length - 1);
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
    this.commit(withCameraEnsured(deserialize(await file.text())));
    this.slideIndex = 0;
    this.selection = null;
  }

  loadAutosave() {
    const json = localStorage.getItem(AUTOSAVE_KEY);
    if (json) {
      // withCameraEnsured migrates pre-camera documents (they lack the
      // mandatory camera item; without it the picker shows no Camera).
      this.doc = withCameraEnsured(deserialize(json));
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
  exportPng() {
    const rect = cameraRect(foldState(this.doc, this.slideIndex, 1), this.doc.meta);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.w);
    canvas.height = Math.round(rect.h);
    paintScene(canvas.getContext("2d"), this.doc, {
      slideIndex: this.slideIndex,
      alpha: 1,
      registry: this.registry,
      view: fitRectView(rect, canvas.width, canvas.height, 1),
    });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${this.doc.meta.name || "presentation"}-slide${this.slideIndex + 1}.png`;
    a.click();
  }
}
