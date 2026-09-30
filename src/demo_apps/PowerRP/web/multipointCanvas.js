/**
 * IN-CANVAS MULTIPOINT EDITING — the app-level half: the commands the island,
 * the palette and the `C` key share, the double-click route, and the two canvas
 * modes (click-to-place a source, click-to-split a path). The manifest section "In-canvas
 * Multipoint editing — the island" states the design and every WHY; the pure rules
 * (hits, colour targets, writes, refusals) live in core/multipoint_edit.js.
 *
 * Every edit here is ONE undo unit (`setPreview → commitPreview`). Writes are built
 * from the COMMITTED fold (`foldState(doc, slide, 1)`), never from a preview, so a
 * command can never bake a half-finished gesture.
 *
 * DOM-free at import (like web/lightPositionPin.js): the node suites import the
 * widget-handler registry, which imports the mode handlers from here.
 */
import { foldState } from "../core/document.js";
import { getPath } from "../core/deltas.js";
import { reportAction } from "../core/report.js";
import * as T from "../core/transform.js";
import { multipointFeatureAt, newSourceColor, reverseFeature, featurePolyline } from "../core/multipoint.js";
import { paintCapableKeys, multipointFeaturesPath, multipointHandleId, parseMultipointHandleId, isMultipointColorHandleId } from "../core/paint_handles.js";
import {
  multipointEditKey, multipointPathHit, splitAtHit, handleColorTargets, colorWritePairs, targetColor,
  selectedPathFeatures, featureEditRefusal, reversedHandleIds, visibleNodeIndices,
} from "../core/multipoint_edit.js";
import { elementActive } from "../core/lists.js";

/** The source kinds the island can place, in button order. */
export const MULTIPOINT_SOURCE_KINDS = Object.freeze(["point", "line", "curve"]);
/**
 * Pure function. Mode handler id for placing one source kind.
 * @example placeHandlerId("line") // "multipoint_place_line"
 */
export const placeHandlerId = (kind) => `multipoint_place_${kind}`;
export const SPLIT_HANDLER_ID = "multipoint_split";
/** Which canvas mode each arming command enters — read by the commands AND by the
 *  island's pressed state, so a button cannot show armed for a mode it did not start. */
export const MULTIPOINT_MODE_COMMANDS = Object.freeze({
  ...Object.fromEntries(MULTIPOINT_SOURCE_KINDS.map((kind) => [`multipoint-add-${kind}`, placeHandlerId(kind)])),
  "multipoint-split-path": SPLIT_HANDLER_ID,
});

// ── QUERIES ──────────────────────────────────────────────────────────────────

/**
 * Query. The widget the island edits: the ONE selected node, the Multipoint paint key
 * it edits (core/multipoint_edit.js multipointEditKey), and that item's COMMITTED raw
 * state — or null. Cheap: selection reads plus a memoized fold, so command gates may
 * call it (core/commands.js: `when` must be O(cheap)).
 * @param {object} app - The app store.
 * @returns {{node: object, key: string, itemId: string, raw: object}|null}
 */
export function multipointTarget(app) {
  if (app.selectedIds().length !== 1) return null;
  const node = app.selectedNode();
  if (!node) return null;
  const key = multipointEditKey(node.state, paintCapableKeys(node.plugin), app.handleSelection);
  if (!key) return null;
  return { node, key, itemId: node.itemId, raw: foldState(app.doc, app.slideIndex, 1).items?.[node.itemId] ?? {} };
}

/**
 * Query. Why sources cannot be added to the target's paint right now, or null.
 * @param {{key: string, raw: object}} target - From multipointTarget.
 * @returns {string|null} A `requires`-style clause.
 */
function sourceListRefusal(target) {
  const paint = target.raw[target.key];
  const path = multipointFeaturesPath(paint, target.key);
  const active = getPath(target.raw, [...path.slice(0, -1), "featuresActive"]);
  if (!Array.isArray(getPath(target.raw, path)) || typeof active === "string")
    return `a Multipoint source list that is stored data — this ${target.key}'s sources (or their visibility) are an equation; edit it in the Inspector`;
  return null;
}

/** Query. The selected path sources (for Two sides / Closed / Reverse), or []. */
function selectedPaths(app) {
  const target = multipointTarget(app);
  return target ? selectedPathFeatures(target.raw, app.handleSelection) : [];
}

/**
 * Query. The island's pressed states: is every selected path source two-sided /
 * closed? False with no path selected, so a toggle never shows "on" for nothing.
 * @param {object} app - The app store.
 * @returns {{twoSided: boolean, closed: boolean}}
 */
export function selectedPathFlags(app) {
  const paths = selectedPaths(app);
  const all = (flag) => paths.length > 0 && paths.every((p) => p.feature[flag] === true);
  return { twoSided: all("twoSided"), closed: all("closed") };
}

// ── COMMANDS (each ONE undo unit) ───────────────────────────────────────────

/**
 * Command. Appends a `kind` source centred on the LOCAL point (the widget's own
 * unsigned frame), selects its colour handle and opens that colour's picker —
 * placing a source and choosing its colour is one flow.
 * @param {object} app - The app store.
 * @param {"point"|"line"|"curve"} kind - Initial geometry.
 * @param {{x: number, y: number}} local - Local px inside the widget box.
 * @returns {void}
 */
export function addMultipointSource(app, kind, local) {
  const target = multipointTarget(app);
  if (!target) throw new Error("addMultipointSource: no single selected widget with a Multipoint paint");
  const refusal = sourceListRefusal(target);
  if (refusal) return reportAction(`PowerRP: cannot add a Multipoint ${kind} — requires ${refusal}.`);
  const { w, h } = target.node.state;
  if (!w || !h) return reportAction(`PowerRP: cannot add a Multipoint ${kind} — the widget has no area to place it in.`);
  const path = multipointFeaturesPath(target.raw[target.key], target.key);
  const features = getPath(target.raw, path);
  const feature = multipointFeatureAt(kind, newSourceColor(features.length), local.x / w, local.y / h);
  app.setPreview([[["items", target.itemId, ...path], [...features, feature]]]);
  app.commitPreview();
  const colourHandle = kind === "point"
    ? { key: target.key, feature: features.length, role: "anchor", index: 0 }
    : { key: target.key, feature: features.length, role: "stop", index: 0, side: "color" };
  app.selectHandle(multipointHandleId(colourHandle));
  app.handleColorOpen = true;
}

/**
 * Command. Splits the Multipoint path nearest `local` (within `slop` local px) at
 * exactly that place, and selects the new node. Returns whether a path was there.
 * A refused split (equation-driven geometry, or a click on an existing node) is
 * reported and still counts as handled — the click WAS on a path.
 * @param {object} app - The app store.
 * @param {{x: number, y: number}} local - Local px.
 * @param {number} slop - Hit tolerance, local px.
 * @returns {boolean}
 */
export function splitMultipointAt(app, local, slop) {
  const target = multipointTarget(app);
  if (!target) return false;
  const hit = multipointPathHit(target.node.state, paintCapableKeys(target.node.plugin), local, slop);
  if (!hit) return false;
  const stored = getPath(target.raw, hit.featurePath);
  const split = splitAtHit(stored, hit);
  if (split.refusal) {
    reportAction(`PowerRP: Multipoint split refused on source ${hit.feature + 1} — ${split.refusal}`);
    return true;
  }
  const pairs = [[["items", target.itemId, ...hit.featurePath, "nodes"], split.feature.nodes]];
  if (split.feature.nodesActive) pairs.push([["items", target.itemId, ...hit.featurePath, "nodesActive"], split.feature.nodesActive]);
  app.setPreview(pairs);
  app.commitPreview();
  app.selectHandle(multipointHandleId({ key: hit.key, feature: hit.feature, role: "anchor", index: split.node }));
  return true;
}

/**
 * Command. THE DOUBLE-CLICK ROUTE, run by CanvasView.onDblClick before any widget
 * activation: on a Multipoint colour handle it opens that handle's colour (keeping a
 * multi-selection the handle belongs to, so one double-click recolours the set); on a
 * Bézier control it does nothing further; on a Multipoint path it splits there.
 * Returns whether it consumed the double-click.
 * @param {object} app - The app store.
 * @param {string|null} handleId - The modifier handle under the pointer, if any.
 * @param {{x: number, y: number}} world - The double-click, world coords.
 * @param {number} worldSlop - Hit tolerance in world units (the canvas's SNAP_PX / zoom).
 * @returns {boolean}
 */
export function multipointDoubleClick(app, handleId, world, worldSlop) {
  const target = multipointTarget(app);
  if (!target) return false;
  const h = handleId ? parseMultipointHandleId(handleId) : null;
  if (h) {
    if (!isMultipointColorHandleId(handleId)) return true;
    if (!app.handleSelection.includes(handleId)) app.selectHandle(handleId);
    app.handleColorOpen = true;
    return true;
  }
  const local = T.apply(T.invert(target.node.world), world.x, world.y);
  return splitMultipointAt(app, local, worldSlop / target.node.world.scale);
}

/**
 * Command. Flips `twoSided` or `closed` on every selected path source (on unless
 * every one is already on) — one undo unit.
 * @param {object} app - The app store.
 * @param {"twoSided"|"closed"} flag - Which feature flag.
 * @returns {void}
 */
export function toggleMultipointFlag(app, flag) {
  const target = multipointTarget(app);
  const paths = target ? selectedPathFeatures(target.raw, app.handleSelection) : [];
  const refused = paths.find((p) => featureEditRefusal(p.feature, flag));
  if (refused) return reportAction(`PowerRP: cannot toggle Multipoint source ${refused.index + 1} — ${featureEditRefusal(refused.feature, flag)}.`);
  if (!paths.length) return;
  const on = !paths.every((p) => p.feature[flag] === true);
  app.setPreview(paths.map((p) => [["items", target.itemId, ...p.featurePath, flag], on]));
  app.commitPreview();
}

/**
 * Command. Reverses every selected path source (geometry + colours, physical sides
 * kept) as one undo unit, and remaps the handle selection so it keeps pointing at
 * the same physical nodes and beads.
 * @param {object} app - The app store.
 * @returns {void}
 */
export function reverseMultipointPaths(app) {
  const target = multipointTarget(app);
  const paths = target ? selectedPathFeatures(target.raw, app.handleSelection) : [];
  const refused = paths.find((p) => featureEditRefusal(p.feature, "reverse"));
  if (refused) return reportAction(`PowerRP: cannot reverse Multipoint source ${refused.index + 1} — ${featureEditRefusal(refused.feature, "reverse")}.`);
  if (!paths.length) return;
  app.setPreview(paths.map((p) => [["items", target.itemId, ...p.featurePath], reverseFeature(p.feature)]));
  app.commitPreview();
  app.handleSelection = paths.reduce((ids, p) => reversedHandleIds(ids, p.key, p.index, p.feature), [...app.handleSelection]);
}

/**
 * Command. Arms (or, when already armed, disarms) a click-to-place/split mode on the
 * selected widget — a toggle, so the island's pressed button is also its off switch.
 * @param {object} app - The app store.
 * @param {string} handlerId - placeHandlerId(kind) or SPLIT_HANDLER_ID.
 * @returns {void}
 */
export function toggleMultipointMode(app, handlerId) {
  if (app.canvasMode?.handlerId === handlerId) return app.exitCanvasMode();
  const target = multipointTarget(app);
  if (!target) throw new Error(`toggleMultipointMode: no single selected widget with a Multipoint paint for ${handlerId}`);
  app.enterCanvasMode(handlerId, target.itemId);
}

// ── THE ISLAND'S COLOUR FIELDS ──────────────────────────────────────────────

/**
 * Query. One colour field per colour SIDE the selected handles reach: its label, the
 * value it shows (live, preview included) and the write hook ColorField calls with
 * each picked colour. The writes are built from the committed fold captured HERE,
 * consistently with the targets — see colorWritePairs for why never the preview.
 * @param {object} app - The app store.
 * @returns {{fields: {side: string, label: string, value: *, path: Array, pairsFor: function}[], skipped: string[]}}
 */
export function islandColorFields(app) {
  const target = multipointTarget(app);
  if (!target) return { fields: [], skipped: [] };
  const { targets, skipped } = handleColorTargets(target.raw, app.handleSelection);
  const live = app.rawState().items?.[target.itemId] ?? {};
  const sides = ["color", "rightColor"].filter((side) => targets.some((t) => t.side === side));
  const fields = sides.map((side) => {
    const mine = targets.filter((t) => t.side === side);
    const count = mine.length > 1 ? ` (${mine.length})` : "";
    const label = (sides.length === 2 ? (side === "color" ? "Left colour" : "Right colour") : side === "color" ? "Colour" : "Right colour") + count;
    const first = mine[0];
    return {
      side, label,
      value: targetColor(live, first),
      path: ["items", target.itemId, ...(first.path ?? [...first.featurePath, "stops"])],
      /** Pure function. The setPreview pairs for picking `hex` on this side. */
      pairsFor: (hex) => colorWritePairs(target.raw, mine, hex).map(([p, v]) => [["items", target.itemId, ...p], v]),
    };
  });
  return { fields, skipped };
}

// ── COMMAND REGISTRY ENTRIES ────────────────────────────────────────────────

const REQUIRES_MULTIPOINT = "exactly one selected widget whose fill, stroke or other paint is a Multipoint gradient";

/** Query. The add/split gate's clause: the most specific unmet condition. */
function addRequires(app) {
  const target = multipointTarget(app);
  return target ? sourceListRefusal(target) ?? REQUIRES_MULTIPOINT : REQUIRES_MULTIPOINT;
}

/** Query. Does the target have a visible PATH source (≥ 2 visible nodes) to split? */
function hasPath(app) {
  const target = multipointTarget(app);
  if (!target) return false;
  const paint = target.node.state[target.key], source = paint.multipoint ?? paint;
  return source.features.some((f, i) => elementActive(source.featuresActive, i) && visibleNodeIndices(f).length > 1);
}

/** Query. The path-flag gate's clause for `op`. */
function pathRequires(app, op) {
  const paths = selectedPaths(app);
  const refused = paths.find((p) => featureEditRefusal(p.feature, op));
  if (refused) return `Multipoint path sources whose ${op === "reverse" ? "geometry and colours are" : "flag is"} stored data — source ${refused.index + 1}: ${featureEditRefusal(refused.feature, op)}`;
  return "a selected handle on a Multipoint LINE or CURVE source (a point has no path to change) — double-click or click one of its nodes or colour beads";
}

/** Query. Is a path-flag command runnable (selected path sources, none refused)? */
function pathsEditable(app, op) {
  const paths = selectedPaths(app);
  return paths.length > 0 && paths.every((p) => !featureEditRefusal(p.feature, op));
}

/**
 * Query. What the island's RAMP LIBRARY acts on: the document path of the target's
 * {features, …} sub-state (gradient map) and, when exactly ONE path source is selected,
 * that source's path and Two sides flag (ramp along path). Nulls where unavailable.
 * @param {object} app - The app store.
 * @returns {{fill: Array|null, path: {featurePath: Array, twoSided: boolean}|null}}
 */
export function islandRampTargets(app) {
  const target = multipointTarget(app);
  if (!target || sourceListRefusal(target)) return { fill: null, path: null };
  const featuresPath = multipointFeaturesPath(target.raw[target.key], target.key);
  const paths = selectedPathFeatures(target.raw, app.handleSelection);
  const one = paths.length === 1 && !featureEditRefusal(paths[0].feature, "ramp") ? paths[0] : null;
  return {
    fill: ["items", target.itemId, ...featuresPath.slice(0, -1)],
    path: one ? { featurePath: ["items", target.itemId, ...one.featurePath], twoSided: one.feature.twoSided === true } : null,
  };
}

/** Query. The ramp-along-path gate's clause: the most specific unmet condition. */
function rampRequires(app) {
  const paths = selectedPaths(app);
  if (paths.length === 1 && featureEditRefusal(paths[0].feature, "ramp"))
    return `a path source whose colours are stored data — source ${paths[0].index + 1}: ${featureEditRefusal(paths[0].feature, "ramp")}`;
  return "exactly one selected Multipoint LINE or CURVE source — click one of its nodes or colour beads";
}

/**
 * Query. The Multipoint command-registry entries (web/App.svelte registers them with
 * the core commands). The island, the palette and the `C` key are surfacings of
 * THESE — no second action path exists.
 * @returns {object[]}
 */
export function multipointCommands() {
  const KIND_TITLES = { point: "Point", line: "Line", curve: "Curve" };
  return [
    ...MULTIPOINT_SOURCE_KINDS.map((kind) => ({
      id: `multipoint-add-${kind}`,
      title: `Add Multipoint ${KIND_TITLES[kind]} Source (click to place)`,
      icon: { point: "mdi:record-circle-outline", line: "mdi:vector-line", curve: "mdi:vector-curve" }[kind],
      aliases: [`add ${kind}`, `new gradient ${kind}`, `multipoint ${kind}`],
      when: (a) => { const t = multipointTarget(a); return !!t && !sourceListRefusal(t); },
      requires: addRequires,
      help: `Arms a one-shot click: the next click inside the widget places a new ${kind} colour source there and opens its colour picker. Click the button again (or Escape) to cancel.`,
      run: (a) => toggleMultipointMode(a, MULTIPOINT_MODE_COMMANDS[`multipoint-add-${kind}`]),
    })),
    {
      id: "multipoint-split-path",
      title: "Split Multipoint Path (click the path)",
      icon: "mdi:vector-point-plus",
      aliases: ["split segment", "add node", "insert multipoint node"],
      when: hasPath,
      requires: (a) => (multipointTarget(a) ? "a Multipoint LINE or CURVE source to split — this paint has only points" : REQUIRES_MULTIPOINT),
      help: "Arms a one-shot click: click a Multipoint path to add a shaping node exactly there. The curve and its colours do not move. Double-clicking a path does the same without arming.",
      run: (a) => toggleMultipointMode(a, MULTIPOINT_MODE_COMMANDS["multipoint-split-path"]),
    },
    {
      id: "multipoint-edit-color",
      title: "Edit Multipoint Colour",
      icon: "mdi:palette-outline",
      aliases: ["edit multipoint color", "point color", "set gradient point colour"],
      when: (a) => !!multipointTarget(a) && a.handleSelection.some(isMultipointColorHandleId),
      requires: "a selected Multipoint point, node or colour bead — click one first (Bézier handles carry no colour)",
      help: "Opens the colour picker for every selected Multipoint colour at once. On a path node it edits the colour AT that node; the first pick adds a colour stop there if none exists.",
      run: (a) => { a.handleColorOpen = true; },
    },
    {
      id: "multipoint-toggle-two-sided",
      title: "Toggle Two-Sided Colours on Multipoint Paths",
      icon: "mdi:arrow-split-vertical",
      aliases: ["two sides", "two sided", "left right colours"],
      when: (a) => pathsEditable(a, "twoSided"),
      requires: (a) => pathRequires(a, "twoSided"),
      help: "Gives each selected path independent left and right colours (the right colours were kept while sides were linked).",
      run: (a) => toggleMultipointFlag(a, "twoSided"),
    },
    {
      id: "multipoint-toggle-closed",
      title: "Toggle Closed Multipoint Paths",
      icon: "mdi:vector-polygon",
      aliases: ["close path", "open path", "closed loop"],
      when: (a) => pathsEditable(a, "closed"),
      requires: (a) => pathRequires(a, "closed"),
      help: "Connects each selected path's last node back to its first, or opens it again.",
      run: (a) => toggleMultipointFlag(a, "closed"),
    },
    {
      id: "multipoint-reverse",
      title: "Reverse Multipoint Paths",
      icon: "mdi:swap-horizontal",
      aliases: ["reverse path", "flip path direction"],
      when: (a) => pathsEditable(a, "reverse"),
      requires: (a) => pathRequires(a, "reverse"),
      help: "Reverses each selected path's direction and colour order while keeping every colour on the same physical side, so the picture does not change.",
      run: (a) => reverseMultipointPaths(a),
    },
    {
      id: "multipoint-gradient-map",
      title: "Recolour Multipoint Fill from a Gradient",
      icon: "mdi:palette-swatch-variant",
      aliases: ["gradient map", "recolor multipoint", "brainstorm colours", "palette swap", "try colours"],
      when: (a) => { const t = multipointTarget(a); return !!t && !sourceListRefusal(t); },
      requires: addRequires,
      help: "Opens the gradient library on the canvas: hover a gradient to see the WHOLE fill recoloured by lightness (dark colours take its start, light ones its end) with every shape where it was; click to keep it. Press again (or Shift+G) to close.",
      run: (a) => { a.multipointRampOpen = a.multipointRampOpen === "fill" ? null : "fill"; },
    },
    {
      id: "multipoint-apply-ramp",
      title: "Lay a Gradient Along the Multipoint Path",
      icon: "mdi:gradient-horizontal",
      aliases: ["ramp along path", "path gradient", "apply ramp", "gradient on curve"],
      when: (a) => { const p = selectedPaths(a); return p.length === 1 && !featureEditRefusal(p[0].feature, "ramp"); },
      requires: rampRequires,
      help: "Opens the gradient library for the selected path: hover a gradient to lay it along the path (Both / Left / Right side on a two-sided path); click to keep it. Replaces that path's colour stops only.",
      run: (a) => { a.multipointRampOpen = a.multipointRampOpen === "path" ? null : "path"; },
    },
  ];
}

/**
 * Query. Is the arming command `id` currently ARMED (its canvas mode live)?
 * @param {object} app - The app store.
 * @param {string} id - A key of MULTIPOINT_MODE_COMMANDS.
 * @returns {boolean}
 */
export function multipointModeArmed(app, id) {
  return app.canvasMode?.handlerId === MULTIPOINT_MODE_COMMANDS[id];
}

// ── THE CANVAS MODES (web/widget_handlers.js registers them; commands enter them) ──

/** THE LIVE HOVER — local point (place) or path hit (split) the next click would use.
 *  Module scratch like web/lightPositionPin.js's: one mode lives at a time. */
let hover = null;

/** Pure function. A local point → world, through the mode item's transform. */
function toWorld(node, x, y) {
  const p = T.apply(node.world, x, y);
  return { x: p.x, y: p.y };
}

/**
 * Pure function. Is a local point inside the node's box (with `slop` local px)?
 * @example insideBox({w: 10, h: 10}, {x: 11, y: 5}, 2) // true
 */
function insideBox(state, p, slop) {
  return p.x >= -slop && p.y >= -slop && p.x <= (state.w ?? 0) + slop && p.y <= (state.h ?? 0) + slop;
}

/**
 * Pure function. A mode handler that places one `kind` of source.
 * @param {"point"|"line"|"curve"} kind - Source kind.
 * @returns {object} Activate-phase handler descriptor (entered only by its command).
 */
function placeHandler(kind) {
  return {
    id: placeHandlerId(kind),
    phase: "activate",
    label: `Place a Multipoint ${kind}`,
    // No `claims`: never a widget's double-click — the multipoint-add-* commands
    // enter it (the pin_light_position precedent).
    mode: {
      label: `Place Multipoint ${kind}`,
      hints: [{ keys: ["mouse_left"], label: `Click inside the widget to place the ${kind}` }],
      cursors: ["cell"],
      /** Command (module hover). Tracks the would-be placement; always changed. */
      onHover(ctx, pick) {
        hover = pick.local;
        return true;
      },
      /** Command (module hover). Pointer left the canvas. */
      onHoverLeave() {
        const had = hover !== null;
        hover = null;
        return had;
      },
      /** Query. The new source's geometry at the pointer, drawn before the click. */
      overlay(ctx) {
        const { node } = ctx;
        if (!hover || !insideBox(node.state, hover, ctx.slop / node.world.scale)) return { chains: [], rects: [], dots: [] };
        const f = multipointFeatureAt(kind, "#000000", hover.x / node.state.w, hover.y / node.state.h);
        const unitToWorld = ([x, y]) => { const p = toWorld(node, x * node.state.w, y * node.state.h); return [p.x, p.y]; };
        const chains = f.nodes.length > 1 ? [{ points: featurePolyline(f.nodes).map(unitToWorld), closed: false }] : [];
        return { chains, rects: [], dots: f.nodes.map((n) => { const [x, y] = unitToWorld(n); return { x, y, hot: true }; }) };
      },
      /** Command (ONE undo unit or nothing; always exits). */
      onPick(ctx, pick) {
        const { app, node } = ctx;
        hover = null;
        if (!insideBox(node.state, pick.local, ctx.slop / node.world.scale)) {
          reportAction(`PowerRP: Place Multipoint ${kind} cancelled — the click was outside ${app.displayName(node.itemId)}. Nothing was added.`);
          app.exitCanvasMode();
          return;
        }
        app.exitCanvasMode();
        addMultipointSource(app, kind, pick.local);
      },
    },
  };
}

export const MULTIPOINT_PLACE_HANDLERS = MULTIPOINT_SOURCE_KINDS.map(placeHandler);

export const MULTIPOINT_SPLIT_HANDLER = {
  id: SPLIT_HANDLER_ID,
  phase: "activate",
  label: "Split a Multipoint path",
  mode: {
    label: "Split Multipoint path",
    hints: [{ keys: ["mouse_left"], label: "Click a Multipoint path to split it there" }],
    cursors: ["cell"],
    /** Command (module hover). The path point a click would split at; changed only
     *  when that point moves or appears/disappears. */
    onHover(ctx, pick) {
      const hit = multipointPathHit(ctx.node.state, paintCapableKeys(ctx.node.plugin), pick.local, ctx.slop / ctx.node.world.scale);
      const next = hit ? { x: hit.x, y: hit.y } : null;
      const changed = (next === null) !== (hover === null) || (next && (next.x !== hover.x || next.y !== hover.y));
      hover = next;
      return !!changed;
    },
    /** Command (module hover). Pointer left the canvas. */
    onHoverLeave() {
      const had = hover !== null;
      hover = null;
      return had;
    },
    /** Query. A hot dot exactly where the new node would land. */
    overlay(ctx) {
      if (!hover) return { chains: [], rects: [], dots: [] };
      return { chains: [], rects: [], dots: [{ ...toWorld(ctx.node, hover.x, hover.y), hot: true }] };
    },
    /** Command (ONE undo unit or nothing; always exits). */
    onPick(ctx, pick) {
      const { app, node } = ctx;
      hover = null;
      app.exitCanvasMode();
      if (!splitMultipointAt(app, pick.local, ctx.slop / node.world.scale))
        reportAction(`PowerRP: Split Multipoint path cancelled — the click was not on a Multipoint path of ${app.displayName(node.itemId)}. Nothing changed.`);
    },
  },
};
