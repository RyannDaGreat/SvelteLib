/**
 * BENTO CELL BINDING — the bento's double-click activation (web/widget_handlers.js,
 * phase "activate"). Aim a CELL, then click a WIDGET: that widget is bound to the
 * cell and follows the grid from then on.
 *
 * ── THE DIRECTION OF THE WRITE (the whole point, and the easy thing to get
 *    backwards) ───────────────────────────────────────────────────────────────
 * The bento is NOT edited. Nothing is written to it, ever — not a cell occupant
 * list, not a membership set, not a parent pointer. The WIDGET is edited: its
 * `x` and `y` become equations reading the cell's CENTRE anchor, so the bento
 * stays exactly what it always was (a passive coordinate source whose product is
 * a named anchor set) and the binding is an ordinary property equation like any
 * other. The user stated it in those terms and then corrected himself into them:
 * "it wouldn't actually edit the bento box at all, but what it would do is bind
 * whatever object I select to that part of the bento box so that it would always
 * follow the bento box."
 *
 * CONSEQUENCE — THERE IS NO NEW STATE CONCEPT. A binding is two strings in the
 * bound widget's own state. It survives save/load, undo, copy/paste, the CLI
 * renderer and the tween with no new code, because equations already do. It is
 * also why the INVERSE already exists and needed nothing built: the registry's
 * "Unbind Position & Size (freeze x/y/w/h to numbers)" freezes an equation on
 * x/y/w/h WHATEVER it references (App.svelte cameraFreezeWrite is deliberately
 * not camera-specific), so it is the discoverable way out of a cell binding too.
 *
 * ── WHICH POINT LANDS WHERE: the widget's CENTRE on the cell's CENTRE ─────────
 * `x`/`y` are the widget's rotation-ZERO base translation of its box's TOP-LEFT
 * (core/properties.js PROPS; commit 76fd076), so binding `x` straight to a cell
 * centre would put the widget's CORNER there — a widget hanging out of the cell
 * to the lower-right, which is not what "in that cell" means. The pairing is
 * CENTRE-to-CENTRE, and it is not invented here: web/app.svelte.js's
 * `arrangeSelectionIntoGrid` (the bento's other tool) already places each
 * widget's own CENTER on its cell's center, and its docstring flags THIS task as
 * its own follow-up — "whether to bind item x/y to the bento's cell-center
 * anchors via `=` equations so editing rows/cols in the Inspector AUTO-reflows
 * … rather than only re-running". So the centre pairing is the recorded intent
 * and this is the equation form of the same placement.
 *
 * The offset is `w · scale / 2`, not `w / 2`: with the standard self-centre
 * rotation pivot the widget's world centre is (x + scale·w/2, y + scale·h/2) and
 * that point is INVARIANT under rotation (core/derive.stateXYForCenterPivotWorld
 * derives exactly this), so one subtraction lands the centre on the cell for a
 * widget at ANY rotation and ANY scale — verified at rotation 36° with scale 2.5.
 * `scale` is referenced only when the widget actually declares it (one registered
 * widget, the magnifier, does not) — the `plugin.defaults[key] !== undefined`
 * generality gate App.svelte's cameraBindTargets uses, rather than a type list or
 * a reference that would throw for that one widget.
 *
 * ── CLOBBERING IS INTENDED HERE, AND THE FLIP PRECEDENT DOES NOT APPLY ────────
 * The flip commands REFUSE when the write would land on an equation, because a
 * flip TRANSFORMS the current value (x' = x + scale·w) and an equation makes that
 * transformation meaningless — the user's binding would be silently replaced by a
 * literal. A bind REPLACES the value outright: that is the entire request, and
 * "bind it to this cell instead" (re-aiming after a mis-click) is the common
 * case, which a refusal would make impossible. `bind-to-camera` — the closest
 * precedent, one-click and also writing equations onto x/y — likewise overwrites
 * with no refusal, and `arrangeSelectionIntoGrid` keyframes x/y over whatever was
 * there. So: OVERWRITE, and the honest reason is that nothing is lost that the
 * gesture did not just ask to replace. Undo is one step.
 *
 * ── WHAT IS REFUSED (loudly, and atomically — nothing is half-written) ────────
 *   A GROUP MEMBER. A member's `x`/`y` live in its group's frame while an anchor
 *   reference evaluates in WORLD (core/expressions.anchorValue composes the group
 *   influence; core/derive.applyGroupParenting does the same for the render), so
 *   the binding would place the widget off by the group's influence — measured:
 *   a member of a group translated +60 landed 60px past its cell. Refused rather
 *   than shipped wrong. (The same latent gap exists in `bind-to-camera`; it is
 *   not introduced here and not fixed here.)
 *   A WIDGET WITH NO POSITION. Arrows and their family carry `from`/`to`, not
 *   `x`/`y`, so there is nothing to bind; the gate is the plugin's own
 *   declaration, never a type list.
 *   THE CAMERA — and this one is FLAGGED, PENDING USER RATIFICATION. It has x/y and
 *   the write would WORK (no cycle: the view would simply centre on the cell), so
 *   this is a judgement, not a law. Two facts drove it: a "Camera" row would appear
 *   first in this list on every bind in every deck forever, and the camera is the one
 *   item the document model ALREADY marks structural rather than content
 *   (`purgeable: false` — the same gate Delete and Purge use, so the distinction is
 *   read off an existing declaration and not invented here). Per the palette's
 *   ruling it is GREYED WITH THE REASON and never hidden, so the position is stated
 *   on screen and reversible by deleting one clause. Binding a camera to a cell by
 *   hand in the Inspector remains possible and untouched.
 *
 * ── THE CURSOR NAMES THE QUESTION, AND IT IS DIFFERENT PER STEP ──────────────
 * The house position is already "the cursor states the affordance" (web/app.css
 * uses `grab`, `col-resize`, `not-allowed`, `help`, `text`, each naming the
 * gesture available), so a mode this modal must say so under the pointer.
 *
 * IT IS NOT AN EYEDROPPER, AND THAT IS THE CORRECTION. An eyedropper would be a
 * NEW asset: the 39-cursor built-in library (assets/builtin/cursors) has none,
 * `mdi:eyedropper` only reaches the DOM through the `iconify-icon` runtime web
 * component so it cannot appear in a CSS `url()`, and a `cursor: url(<data uri>)`
 * additionally needs a hand-tuned hotspot. CSS already ships the two words this
 * mode actually means:
 *
 *   step 0 AIM  → `cell`   — CSS's own "select a cell of a table/grid". Step 0
 *                            selects a cell of a grid. There is no closer word.
 *   step 1 BIND → `alias`  — CSS's own "the action creates a LINK/alias". A
 *                            binding IS a live link from the widget to the cell.
 *
 * So the cursor differs PER STEP, and the usual objection ("two custom cursors
 * are more noise than signal") does not apply, because neither is custom: both
 * are standard keywords, and both glyphs already exist by name in this app's own
 * cursor library (`cell.svg`, `makealias.svg`) — the vocabulary is house-
 * sanctioned, it costs no asset, and each names its own step's question exactly.
 *
 * REVERTING IS STRUCTURAL, not imperative: the class is DERIVED from
 * `app.canvasMode` (CanvasView), so Escape, a slide switch, entering the
 * presenter and finalize's selection write all drop it by construction. There is
 * no cursor state anywhere that could get stuck.
 *
 * ── HOVER PREVIEWS THE CLICK; THE COMMITTED AIM IS PINK ──────────────────────
 * Task #165 made hover-preview "the default trope for all pickers", and the aim
 * used to be visible only AFTER the press that set it. One rule covers both
 * halves and needs no new style token:
 *
 *   GHOST (`.place-dot`, --a-ghost)     = what THIS click would do   (hover)
 *   HOT   (`.place-dot-hot`, --a-guide) = what is already committed   (aim)
 *
 * That is the polygon's own `hot` semantics ("this click will engage something",
 * web/app.css) read one level up, so the two states are distinguishable by
 * construction rather than by a colour invented here.
 *
 * STEP 1 GETS HOVER TOO, because a step-1 press does two different things and the
 * preview must match whichever one it would be: over the grid it RE-AIMS (so it
 * previews the cell, exactly as step 0 does), and over a widget it BINDS (so it
 * previews a ghost leader from that widget's centre to the aimed cell's centre —
 * the two points the click is about to make coincide).
 *
 * IT IS FREE. `cellGrid.at` is pure arithmetic over rows/cols and touches no
 * document; the widget lookup reuses the ONE `app.nodes()` the host already
 * derived for this event; and `onHover` returns FALSE when the preview is
 * unchanged so the overlay is not reassigned on every mousemove. That last part
 * is deliberate: a hover that invalidates per pixel is the defect behind the
 * minimap drag spike and the idle-callback stalls.
 *
 * ── STEP 1 HAS TWO INPUT PATHS, AND ONE WRITE ────────────────────────────────
 * A canvas-only picker fails exactly when it is needed: the widget you want is
 * occluded by something on top, or tiny, or off-screen, or sitting under the very
 * grid you are binding into. That is the SAME problem step 0 already accounts for
 * (it reads the press as a point in the grid's frame rather than a hit-test,
 * precisely because a widget is usually already on the grid), one step later. So
 * step 1 also accepts a pick from a LIST of the slide's widgets
 * (web/BentoTargetList.svelte, fed by `bindableTargets` below).
 *
 * BOTH PATHS REACH `bindPickedWidget`, the one write, so they cannot produce
 * different bindings or different undo granularity — and both stage their hover
 * through the one `hover` record, so a row's TARGET highlight IS the canvas
 * highlight, not a second thing that resembles it.
 *
 * THE REFUSALS ARE SHOWN, GREYED, WITH THEIR REASON — never filtered out. The
 * palette established this ("Rendered DISABLED, never hidden"): APPLICABILITY
 * hides, AVAILABILITY greys with a reason, because hiding makes the tool
 * unlearnable. A group member silently absent from the list would leave the user
 * hunting for a widget that is right there on the canvas.
 *
 * ── THE GESTURE, AND WHY THE STEP DECIDES HOW A PRESS IS READ ────────────────
 * Step 0 AIM: the press is read as a POINT IN THE BENTO'S OWN FRAME and picks the
 * cell nearest it — deliberately NOT "the widget you hit", because in the case
 * this feature is for there is already something sitting on the grid, so a
 * hit-test would hand back that widget and the cell could never be named. Step 1
 * BIND: the press is read as the WIDGET under it. A step-1 press that lands on
 * the bento itself, or on nothing, RE-AIMS instead of binding, which is what
 * makes "no, the other cell" work and leaves no press without an effect.
 *
 * DOM-free at import (pure functions + one descriptor), so tests/bento_bind_test.js
 * covers the whole write in bare node.
 */

import { groupMembership } from "../core/derive.js";
import { reportOnce } from "../core/report.js";
import * as T from "../core/transform.js";

// The two coordinates a cell binding writes, each paired with the SIZE property
// whose half-extent centres the widget on the cell. Not a bare pair of literals
// because the x↔w / y↔h correspondence IS the content of the centre offset, and
// naming it here is what keeps the two coordinates from drifting apart.
const BIND_AXES = [{ key: "x", sizeKey: "w", coord: "x" }, { key: "y", sizeKey: "h", coord: "y" }];

// The cell anchor a binding targets. The CENTRE, per the docstring — a named
// constant because it is the one place a future "bind to the cell's top-left"
// variant would branch, and because the widget's own cellGrid.anchorId validates
// it (only the 9 standard bbox suffixes are real cell anchors).
const BIND_CELL_SUFFIX = "cm";

// The two steps' indices into `mode.steps`. `app.canvasMode.step` is what
// core/shortcut_entries.js scopes each step's mouse_left chip by (inCanvasStep),
// so these name the positions the declaration below reads at rather than leaving
// two bare 0/1 to be matched up by eye.
const AIM_STEP = 0;
const BIND_STEP = 1;

/**
 * THE LIVE AIM — which cell the next widget-press binds into, or null when
 * nothing is aimed yet. Module-scoped scratch, exactly like CanvasView's own
 * `creation.session` for a creation mode: at most ONE can exist (there is at most
 * one `app.canvasMode`), it is re-initialised by `run` on every entry so a
 * previous session's aim can never leak into a new one, and nothing paints from
 * it directly — the host asks `overlay()` for what to draw and re-asks whenever
 * `app.canvasMode` is reassigned (setCanvasModeStep), which is what makes a
 * non-reactive record safe to hold here.
 */
let aim = null; // {bentoId, cell} | null

/**
 * THE LIVE HOVER — what the NEXT press would do, or null when the pointer is not
 * over anything the mode acts on. Same module-scratch reasoning as `aim`, and
 * likewise never written to the document: a hover is a question, not an edit.
 *
 *   {kind: "cell", cell}                  the press would aim (or re-aim) here
 *   {kind: "widget", itemId, centre}      the press would bind that widget
 */
let hover = null;

/**
 * Pure function. The centre-offset expression for one axis: the cell anchor
 * reference MINUS the widget's own half-extent, in the STORED reference form
 * (`@<itemId>_<anchorId>.x|y` — ids, never slugs, so a rename can never break a
 * binding; core/expressions.js's rule, and what bind-to-camera stores). No "="
 * marker: `x`/`y` are legacy NUMERIC slots, where a bare string already IS an
 * equation (core/expressions.isEquationValue), which is also what the Inspector's
 * own numeric field commits.
 *
 * `self.scale` is included only when the widget declares a `scale` — see the file
 * docstring. Anchor-agnostic on purpose: it centres a widget on ANY anchor of any
 * item, which is the shape a general widget-reference eyedropper would want.
 *
 * @param {string} targetId - the item that OWNS the anchor (the bento)
 * @param {string} anchorId - that item's anchor id (a bento cell centre)
 * @param {object} axis - a BIND_AXES entry ({key, sizeKey, coord})
 * @param {object} plugin - the BOUND widget's plugin (read for `scale`)
 * @returns {string} the stored equation
 *
 * @example centreOnAnchorExpr("b1", "c1x2cm", {key: "x", sizeKey: "w", coord: "x"}, {defaults: {scale: 1}}) // "@b1_c1x2cm.x - self.w * self.scale / 2"
 * @example centreOnAnchorExpr("b1", "c0x0cm", {key: "y", sizeKey: "h", coord: "y"}, {defaults: {}}) // "@b1_c0x0cm.y - self.h / 2"
 */
export function centreOnAnchorExpr(targetId, anchorId, axis, plugin) {
  const half = plugin.defaults.scale === undefined
    ? `self.${axis.sizeKey} / 2`
    : `self.${axis.sizeKey} * self.scale / 2`;
  return `@${targetId}_${anchorId}.${axis.coord} - ${half}`;
}

/**
 * Pure function. The setPreview path/value pairs that bind `itemId`'s box centre
 * onto `targetId`'s `anchorId` — BOTH coordinates, which is why they are produced
 * together: half a binding is a widget pinned on one axis and loose on the other.
 * Anchor-agnostic (a cell centre is just the anchor this feature passes in), which
 * is the shape a general widget-reference eyedropper would reuse.
 *
 * @param {string} itemId - the widget being bound
 * @param {object} plugin - that widget's plugin
 * @param {string} targetId - the item owning the anchor
 * @param {string} anchorId - that item's anchor id
 * @returns {[string[], string][]} setPreview pairs
 *
 * @example centreOnAnchorPairs("w1", {defaults: {scale: 1}}, "b1", "c0x1cm")
 * // [[["items", "w1", "x"], "@b1_c0x1cm.x - self.w * self.scale / 2"],
 * //  [["items", "w1", "y"], "@b1_c0x1cm.y - self.h * self.scale / 2"]]
 */
export function centreOnAnchorPairs(itemId, plugin, targetId, anchorId) {
  return BIND_AXES.map((axis) => [["items", itemId, axis.key], centreOnAnchorExpr(targetId, anchorId, axis, plugin)]);
}

/**
 * Pure function. Why `node` cannot be bound to a cell, as a sentence naming the
 * widget and the way out — or null when it can. Split out from the write so the
 * refusal is testable in bare node and reads as one list of reasons rather than
 * being scattered through the command.
 *
 * @param {object} node - the picked render node ({itemId, plugin, ...})
 * @param {Map} membership - core/derive.groupMembership(nodes): memberId → groupId
 * @param {string} name - the widget's display name (for the message)
 * @returns {string|null}
 *
 * @example bindRefusal({itemId: "w1", plugin: {defaults: {x: 0, y: 0}, capabilities: {}}}, new Map(), "Box") // null
 * @example bindRefusal({itemId: "a1", plugin: {defaults: {from: {}}, capabilities: {}}}, new Map(), "Arrow").startsWith("Arrow has no x / y to bind") // true
 * @example bindRefusal({itemId: "w1", plugin: {defaults: {x: 0, y: 0}, capabilities: {}}}, new Map([["w1", "g1"]]), "Box").startsWith("Box is a group member") // true
 * @example bindRefusal({itemId: "c1", plugin: {defaults: {x: 0, y: 0}, capabilities: {purgeable: false}}}, new Map(), "Camera").startsWith("Camera is the view") // true
 */
export function bindRefusal(node, membership, name) {
  const missing = ["x", "y"].filter((key) => node.plugin.defaults[key] === undefined);
  if (missing.length > 0)
    return `${name} has no ${missing.join(" / ")} to bind — it is positioned by its own endpoints or has no frame at all, so there is no coordinate a cell could drive.`;
  if (membership.has(node.itemId))
    return `${name} is a group member — a grouped widget's x / y are read in its group's frame, while a cell anchor evaluates in world, so it would land off by the group's influence. Ungroup it first.`;
  if (node.plugin.capabilities.purgeable === false)
    return `${name} is the view, not content — binding it would move the viewport onto the cell rather than put anything in it.`;
  return null;
}

/**
 * Pure function. One cell as a CLOSED WORLD ring plus a dot on its centre and each
 * of its 4 corners, in the host's `{chains, rects, dots}` shape. `hot` decides the
 * READING: hot (--a-guide) = already committed, plain (--a-ghost) = what this
 * click would do. See the file docstring — that one flag is the whole
 * hover-vs-aim distinction, and it is the polygon's own declared `hot` semantics.
 *
 * A ring of mapped corners rather than a `rects` entry because a rect entry is
 * drawn axis-aligned and the grid may be rotated — the widget's own
 * `cellGrid.corners` exists for exactly this.
 *
 * The dots lead with the CENTRE because it is not a summary of the cell but THE
 * POINT ITSELF: the anchor the equation targets and where the widget's own centre
 * will land. It also cannot be mistaken for a selection handle, which the corners
 * can — the grid is selected whenever this mode runs, and two of its resize
 * handles sit on a cell corner whenever that cell is on the widget's edge.
 *
 * @param {object} world - the grid widget's world similarity transform
 * @param {object} cell - the cell to draw
 * @param {(cell: object) => [number, number][]} corners - the widget's cellGrid.corners
 * @param {boolean} hot - committed (true) vs a hover candidate (false)
 * @returns {{chains: object[], rects: object[], dots: object[]}}
 *
 * @example // with RECT = (c) => [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]]:
 * @example // cellMarks({x: 5, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 20}, RECT, true).chains[0].points[1] === [15, 0]
 * @example // cellMarks(IDENTITY, {x: 0, y: 0, w: 10, h: 20}, RECT, true).dots[0] === {x: 5, y: 10, hot: true} (the CENTRE)
 * @example // …and .dots.length === 5 (the centre plus 4 corners), every one carrying the same `hot`
 */
export function cellMarks(world, cell, corners, hot) {
  const toWorld = ([x, y]) => {
    const p = T.apply(world, x, y);
    return [p.x, p.y];
  };
  const points = corners(cell).map(toWorld);
  const centre = toWorld([cell.x + cell.w / 2, cell.y + cell.h / 2]);
  return {
    chains: [{ points, closed: true }],
    rects: [],
    dots: [centre, ...points].map(([x, y]) => ({ x, y, hot })),
  };
}

/**
 * Pure function. Concatenates `{chains, rects, dots}` overlays into one, so the
 * committed aim and the live hover can be drawn together without either knowing
 * about the other.
 *
 * @param {{chains: object[], rects: object[], dots: object[]}[]} parts
 * @returns {{chains: object[], rects: object[], dots: object[]}}
 *
 * @example mergedOverlay([]) // {chains: [], rects: [], dots: []}
 * @example mergedOverlay([{chains: [1], rects: [], dots: []}, {chains: [2], rects: [], dots: [3]}]) // {chains: [1, 2], rects: [], dots: [3]}
 */
export function mergedOverlay(parts) {
  return {
    chains: parts.flatMap((p) => p.chains),
    rects: parts.flatMap((p) => p.rects),
    dots: parts.flatMap((p) => p.dots),
  };
}

/**
 * Pure function. A ghost LEADER from a hovered widget's centre to the aimed cell's
 * centre — the two points a bind press is about to make coincide, stated as the
 * open 2-point chain the host already knows how to draw. Both ends get a plain
 * (non-hot) dot, because the whole thing is a hover candidate.
 *
 * @param {{x: number, y: number}} from - the hovered widget's world box centre
 * @param {[number, number]} to - the aimed cell's world centre
 * @returns {{chains: object[], rects: object[], dots: object[]}}
 *
 * @example bindLeader({x: 0, y: 0}, [10, 20]).chains // [{points: [[0, 0], [10, 20]], closed: false}]
 * @example bindLeader({x: 0, y: 0}, [10, 20]).dots // [{x: 0, y: 0, hot: false}, {x: 10, y: 20, hot: false}]
 */
export function bindLeader(from, to) {
  return {
    chains: [{ points: [[from.x, from.y], to], closed: false }],
    rects: [],
    dots: [{ x: from.x, y: from.y, hot: false }, { x: to[0], y: to[1], hot: false }],
  };
}

/**
 * Pure function. A render node's WORLD box centre — the point a cell binding moves
 * onto the cell centre, read through the node's own world transform so a rotated
 * or scaled widget reports the centre the equation will actually place.
 *
 * @param {object} node - a render node ({state, world})
 * @returns {{x: number, y: number}}
 *
 * @example nodeCentre({state: {w: 10, h: 20}, world: {x: 0, y: 0, rotation: 0, scale: 1}}) // {x: 5, y: 10}
 * @example nodeCentre({state: {w: 10, h: 20}, world: {x: 0, y: 0, rotation: 0, scale: 2}}) // {x: 10, y: 20}
 */
export function nodeCentre(node) {
  return T.apply(node.world, (node.state.w ?? 0) / 2, (node.state.h ?? 0) / 2);
}

/**
 * Pure function. Are two hover candidates the same? Identity of the THING being
 * previewed, not of the record — `cellGrid.at` returns a fresh object per call, so
 * an object comparison would report a change on every mousemove and defeat the
 * whole guard.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 *
 * @example sameHover(null, null) // true
 * @example sameHover({kind: "cell", cell: {r: 0, c: 1}}, {kind: "cell", cell: {r: 0, c: 1}}) // true (a fresh but equal cell)
 * @example sameHover({kind: "cell", cell: {r: 0, c: 1}}, {kind: "cell", cell: {r: 1, c: 1}}) // false
 * @example sameHover({kind: "widget", itemId: "w1"}, {kind: "cell", cell: {r: 0, c: 0}}) // false
 */
export function sameHover(a, b) {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "cell") return a.cell.r === b.cell.r && a.cell.c === b.cell.c;
  return a.itemId === b.itemId;
}

/**
 * Command (writes nothing to the document). Aims `cell` of the grid `node` and
 * moves the bar to the BIND step. Named because BOTH presses can reach it: step 0
 * always, and a step-1 press that landed on the grid instead of a widget ("no, the
 * other cell").
 *
 * @param {object} app - the app store
 * @param {object} node - the grid widget's render node
 * @param {object} cell - the cell to aim
 */
export function aimCell(app, node, cell) {
  aim = { bentoId: node.itemId, cell };
  app.setCanvasModeStep(BIND_STEP);
}

/**
 * Command (ONE undo unit, or NOTHING). THE BIND — the single write both input paths
 * reach: a canvas click on the widget (mode.onPick) and a pick from the widget LIST
 * (bindableTargets → this). Deliberately ONE function rather than two call sites
 * that happen to agree, because two paths that must produce the identical binding
 * are exactly the pair that silently drift.
 *
 * REFUSES loudly and atomically (bindRefusal) and clears the hover either way, so a
 * stale candidate never outlives the press that resolved it. On success the aim is
 * spent and the bar returns to AIM, ready for the next cell.
 *
 * @param {object} app - the app store
 * @param {object} gridNode - the grid widget's render node (owns the cell anchor)
 * @param {object} targetNode - the render node being bound
 * @returns {boolean} whether it wrote
 */
export function bindPickedWidget(app, gridNode, targetNode) {
  hover = null;
  if (!aim?.cell) return false; // nothing aimed — there is no cell to bind into
  const refusal = bindRefusal(targetNode, groupMembership(app.nodes()), app.displayName(targetNode.itemId));
  if (refusal) {
    reportOnce(`bento-bind-refused:${targetNode.itemId}`, `PowerRP: Bind to grid cell refused — ${refusal} Nothing was changed.`);
    return false;
  }
  const anchorId = gridNode.plugin.cellGrid.anchorId(aim.cell, BIND_CELL_SUFFIX);
  app.setPreview(centreOnAnchorPairs(targetNode.itemId, targetNode.plugin, gridNode.itemId, anchorId));
  app.commitPreview();
  aim = { bentoId: gridNode.itemId, cell: null };
  app.setCanvasModeStep(AIM_STEP);
  return true;
}

/**
 * Command (mutates the module hover; writes NOTHING). Stages a WIDGET as the hover
 * candidate from OUTSIDE the canvas — what a list row's hover means. The list and
 * the canvas therefore feed the SAME record and the SAME overlay, which is what
 * makes the two paths' feedback identical rather than merely similar. `node` null
 * clears it (pointer left the row).
 *
 * @param {object|null} node - the render node being hovered, or null to clear
 * @returns {boolean} whether the candidate changed (callers skip a no-op repaint)
 */
export function hoverWidget(node) {
  const next = node ? { kind: "widget", itemId: node.itemId, centre: nodeCentre(node) } : null;
  if (sameHover(hover, next)) return false;
  hover = next;
  return true;
}

/**
 * Query. Every widget on the slide that step 1's LIST offers, as
 * `[{itemId, name, refusal, node}]` in the tree's z-order — each row carrying its
 * own refusal SENTENCE (or null), so the list can grey it and say why.
 *
 * WHO IS EXCLUDED, and it is a short list on purpose:
 *   - THE GRID ITSELF. Binding a widget to a cell of its own grid is a dependency
 *     cycle (its x would read an anchor derived from its x), so it is not a greyed
 *     row with a reason but a thing that cannot be named at all — APPLICABILITY,
 *     which hides.
 *   - Nothing else. OTHER bentos DO appear: a grid is an ordinary bbox widget, and
 *     nesting one grid's frame in another's cell is a real layout (a sub-grid in a
 *     panel). Excluding them would be an invented restriction.
 * Non-bindable widgets (arrows, group members) are PRESENT and greyed — see the
 * file docstring.
 *
 * `name` is the app's own display name (app.displayName → the item's `name`, else
 * the shared "<Type> (id-prefix)" fallback), never a raw uuid.
 *
 * @param {object} app - the app store
 * @param {object} gridNode - the grid widget's render node
 * @returns {{itemId: string, name: string, refusal: string|null, node: object}[]}
 */
export function bindableTargets(app, gridNode) {
  const nodes = app.nodes();
  const membership = groupMembership(nodes);
  return nodes
    .filter((n) => n.itemId !== gridNode.itemId)
    .map((n) => {
      const name = app.displayName(n.itemId);
      return { itemId: n.itemId, name, refusal: bindRefusal(n, membership, name), node: n };
    });
}

/** Query. The live aim record (the tests' window onto the module scratch).
 * @example // currentAim() → null before any entry, {bentoId, cell} inside a session */
export function currentAim() {
  return aim;
}

/** Query. The live hover candidate — what a press right now would do. Read by the
 * widget LIST (to mark the row it is previewing) and by the tests.
 * @example // currentHover() → null with the pointer off the canvas */
export function currentHover() {
  return hover;
}

export const BENTO_BIND_HANDLER = {
  id: "bento_bind_cell",
  phase: "activate",
  label: "Bind widgets to grid cells",
  /** Pure function. `cellGrid` is this handler's CONTENT descriptor — it is what
   * turns a press into an addressable cell — so a widget declaring one wants this
   * trigger, and a SECOND grid widget would need no edit here. Read ONLY by
   * widget_handlers.migrationPlan. migrationPlan-only.
   * @example // claims({cellGrid: {at: () => null}}) → true
   * @example // claims({type: "rect"}) → false */
  claims: (plugin) => !!plugin.cellGrid,
  /** Command. Selects the bento, clears any stale aim, and takes canvas input. */
  run(ctx) {
    ctx.app.selection = ctx.node.itemId;
    aim = { bentoId: ctx.node.itemId, cell: null };
    hover = null;
    ctx.enterMode();
  },
  mode: {
    label: "Bind widgets to grid cells",
    // Registered inputs. Both are DISPLAY-ONLY (CanvasView's pointer code
    // delivers the press); the per-STEP mouse_left chips below carry the actual
    // narration, and this mode-wide entry says what the wheel still does so the
    // canvas does not go silently unavailable.
    hints: [
      { keys: ["mouse_scroll"], label: "Pan" },
      { keys: ["Ctrl", "mouse_scroll"], label: "Zoom" },
    ],
    // THE TWO STEPS. `gesture: "point"` and a `hint` per step are the same
    // declaration a multi-step CREATION makes (web/creationSteps.js), which is
    // what generates a mouse_left chip scoped to the current step — so the bar
    // narrates the aim and the bind separately instead of showing one blurred
    // sentence. `clickSize` is a "box" step's field and is absent here for the
    // same reason it is absent from a polygon vertex: a point step has no extent.
    steps: [
      { gesture: "point", hint: "Click a cell to aim at it" },
      { gesture: "point", hint: "Click the widget that should sit in that cell (or another cell to re-aim)" },
    ],
    // THE CURSOR, ONE PER STEP — the two questions this mode asks, in CSS's own
    // words. Clamped like a step index (currentStepIndex), so a mode may declare
    // fewer cursors than steps. See the file docstring for why these are keywords
    // and not an eyedropper asset.
    cursors: ["cell", "alias"],
    /** Query (reads the module aim + hover). What the overlay draws: the COMMITTED
     * aim in the hot accent, plus the live HOVER candidate in the ghost tone. The
     * host re-asks after every press and every preview-changing hover.
     * @example // overlay({node, plugin}) → all-empty with nothing aimed or hovered */
    overlay(ctx) {
      const { world } = ctx.node;
      const corners = ctx.plugin.cellGrid.corners;
      const parts = [];
      if (aim?.cell) parts.push(cellMarks(world, aim.cell, corners, true));
      if (hover?.kind === "cell") parts.push(cellMarks(world, hover.cell, corners, false));
      if (hover?.kind === "widget" && aim?.cell) {
        const c = cellMarks(world, aim.cell, corners, true).dots[0]; // the aimed centre
        parts.push(bindLeader(hover.centre, [c.x, c.y]));
      }
      return mergedOverlay(parts);
    },
    /**
     * Query→command (mutates the module hover; writes NOTHING to the document).
     * The pointer moved: work out what a press HERE would do and stage it as the
     * hover candidate. Returns TRUE only when the candidate actually CHANGED, so
     * the host reassigns the overlay on a cell/widget crossing rather than on every
     * mousemove — see the file docstring on why that guard is not optional.
     *
     * Reads exactly what `onPick` reads, from the same payload, so the preview and
     * the action cannot disagree: over the grid (or with nothing aimed yet) the
     * press would AIM, so the hovered CELL is the candidate; with a cell aimed and
     * another widget under the pointer the press would BIND, so that WIDGET is.
     */
    onHover(ctx, pick) {
      const { node } = ctx;
      const overWidget = aim?.cell && pick.node && pick.node.itemId !== node.itemId;
      const next = overWidget
        ? { kind: "widget", itemId: pick.node.itemId, centre: nodeCentre(pick.node) }
        : { kind: "cell", cell: node.plugin.cellGrid.at(node.state, pick.local.x, pick.local.y) };
      if (sameHover(hover, next)) return false;
      hover = next;
      return true;
    },
    /** Command (mutates the module hover). The pointer left the canvas — drop the
     * candidate, so no preview outlives the pointer that asked for it. Returns
     * whether anything changed (the host skips the overlay write when not). */
    onHoverLeave() {
      if (hover === null) return false;
      hover = null;
      return true;
    },
    /**
     * Query→command factory. THE PICK LIST the host mounts while a cell is aimed:
     * `{label, pick, hover}`, or NULL at step 0 — with no cell aimed there is
     * nothing to bind into, so the surface is absent rather than present and inert.
     *
     * `pick` and `hover` are the SAME two functions the canvas path uses
     * (bindPickedWidget, hoverWidget), handed over rather than reimplemented: that
     * is what makes a list pick and a canvas click produce the identical binding,
     * the identical undo granularity and the identical highlight.
     *
     * `label` names the aimed cell by its REFERENCEABLE anchor id (`c1x2cm`) rather
     * than "row 2, column 3", because that exact string is what the user will read
     * in the Inspector's equation afterwards — the anchor hover-tip shows the
     * referencable name for the same reason.
     */
    list(ctx) {
      if (!aim?.cell) return null;
      const { app, node } = ctx;
      return {
        label: node.plugin.cellGrid.anchorId(aim.cell, BIND_CELL_SUFFIX),
        /** Command (ONE undo unit). The list's pick — the canvas click's own write. */
        pick: (target) => bindPickedWidget(app, node, target),
        /** Command. The list's row hover — the canvas hover's own record. */
        hover: hoverWidget,
      };
    },
    /**
     * Command. ONE press inside the mode. Step 0 AIMS at the cell nearest the
     * press (read in the bento's own frame — see the file docstring on why this
     * is not a hit-test); step 1 BINDS the picked widget into the aimed cell as
     * ONE undo unit and returns to step 0, so several cells can be filled in one
     * session. A step-1 press on the bento itself or on nothing RE-AIMS.
     */
    onPick(ctx, pick) {
      const { app, node } = ctx;
      if (!aim?.cell || !pick.node || pick.node.itemId === node.itemId) {
        aimCell(app, node, node.plugin.cellGrid.at(node.state, pick.local.x, pick.local.y));
        return;
      }
      bindPickedWidget(app, node, pick.node);
    },
  },
};
