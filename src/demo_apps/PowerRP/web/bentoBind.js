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
 * @example bindRefusal({itemId: "w1", plugin: {defaults: {x: 0, y: 0}}}, new Map(), "Box") // null
 * @example // bindRefusal({itemId: "a1", plugin: {type: "arrow", defaults: {from: {}}}}, new Map(), "Arrow")
 * @example //   → 'Arrow has no x / y to bind — this widget is positioned by its endpoints…'
 * @example // bindRefusal({itemId: "w1", plugin: {defaults: {x: 0, y: 0}}}, new Map([["w1", "g1"]]), "Box")
 * @example //   → 'Box is a member of a group…'
 */
export function bindRefusal(node, membership, name) {
  const missing = ["x", "y"].filter((key) => node.plugin.defaults[key] === undefined);
  if (missing.length > 0)
    return `${name} has no ${missing.join(" / ")} to bind — this widget is positioned by its own endpoints or has no frame at all, so there is no coordinate a cell could drive.`;
  if (membership.has(node.itemId))
    return `${name} is a member of a group, and a grouped widget's x / y are read in its GROUP's frame while a cell anchor evaluates in world — the widget would land off by the group's influence. Ungroup it (or move the whole group) first.`;
  return null;
}

/**
 * Pure function. The overlay for the live aim: the aimed cell's outline as a
 * CLOSED WORLD-space ring, plus a HOT dot on its centre and each of its 4 corners,
 * in the host's `{chains, rects, dots}` shape.
 *
 * A ring of mapped corners rather than a `rects` entry because a rect entry is
 * drawn axis-aligned and the grid may be rotated — the widget's own
 * `cellGrid.corners` exists for exactly this.
 *
 * THE HOT DOTS ARE NOT DECORATION. The ring alone is `.place-rect`, whose stroke
 * is the same faint ghost tone as the bento's OWN cell guides, so on a grid it was
 * measured invisible — the aim was in the DOM and unreadable on screen. `hot: true`
 * takes `.place-dot-hot`'s guide accent, which web/app.css defines as "this click
 * will engage something" — precisely what an aimed cell announces — so the
 * affordance reuses an existing declared meaning instead of inventing a style.
 *
 * The dots are the cell CENTRE first, then its 4 corners. The centre leads because
 * it is not a summary of the cell but THE POINT ITSELF: it is the anchor the
 * equation targets and where the widget's own centre will land. It also cannot be
 * mistaken for a selection handle, which the corners can — the bento is selected
 * whenever this mode runs, and two of its resize handles sit on a cell corner
 * whenever that cell is on the widget's edge (observed in the probe screenshot).
 *
 * @param {object|null} world - the grid widget's world similarity transform, or null
 * @param {object|null} cell - the aimed cell, or null
 * @param {(cell: object) => [number, number][]} corners - the widget's cellGrid.corners
 * @returns {{chains: object[], rects: object[], dots: object[]}}
 *
 * @example aimOverlay(null, null, () => []) // {chains: [], rects: [], dots: []}
 * @example // with RECT = (c) => [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]]:
 * @example // aimOverlay({x: 5, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 20}, RECT).chains[0].points[1] === [15, 0]
 * @example // aimOverlay({x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 20}, RECT).dots[0] === {x: 5, y: 10, hot: true} (the CENTRE — the anchor being bound)
 * @example // …and .dots.length === 5 (the centre plus 4 corners)
 */
export function aimOverlay(world, cell, corners) {
  if (!world || !cell) return { chains: [], rects: [], dots: [] };
  const toWorld = ([x, y]) => {
    const p = T.apply(world, x, y);
    return [p.x, p.y];
  };
  const points = corners(cell).map(toWorld);
  const centre = toWorld([cell.x + cell.w / 2, cell.y + cell.h / 2]);
  return {
    chains: [{ points, closed: true }],
    rects: [],
    dots: [centre, ...points].map(([x, y]) => ({ x, y, hot: true })),
  };
}

/** Query. The live aim record (the tests' window onto the module scratch).
 * @example // currentAim() → null before any entry, {bentoId, cell} inside a session */
export function currentAim() {
  return aim;
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
    /** Query (reads the module aim). The aimed cell's outline in world space
     * (aimOverlay), which the host re-asks for after every press.
     * @example // overlay({node}) → {chains: [], rects: [], dots: []} with nothing aimed */
    overlay(ctx) {
      return aimOverlay(ctx.node.world, aim?.cell ?? null, ctx.plugin.cellGrid.corners);
    },
    /**
     * Command. ONE press inside the mode. Step 0 AIMS at the cell nearest the
     * press (read in the bento's own frame — see the file docstring on why this
     * is not a hit-test); step 1 BINDS the picked widget into the aimed cell as
     * ONE undo unit and returns to step 0, so several cells can be filled in one
     * session. A step-1 press on the bento itself or on nothing RE-AIMS.
     *
     * The write goes through setPreview → commitPreview, the Inspector-row commit
     * path, so both equations land as ONE undo unit keyframed on the current
     * slide like any other property edit.
     */
    onPick(ctx, pick) {
      const { app, node } = ctx;
      const reAim = () => {
        aim = { bentoId: node.itemId, cell: node.plugin.cellGrid.at(node.state, pick.local.x, pick.local.y) };
        app.setCanvasModeStep(BIND_STEP); // the bar now narrates "click the widget"
      };
      if (!aim?.cell || !pick.node || pick.node.itemId === node.itemId) return reAim();
      const refusal = bindRefusal(pick.node, groupMembership(app.nodes()), app.displayName(pick.node.itemId));
      if (refusal) {
        reportOnce(`bento-bind-refused:${pick.node.itemId}`, `PowerRP: Bind to grid cell refused — ${refusal} Nothing was changed.`);
        return;
      }
      const anchorId = node.plugin.cellGrid.anchorId(aim.cell, BIND_CELL_SUFFIX);
      app.setPreview(centreOnAnchorPairs(pick.node.itemId, pick.node.plugin, node.itemId, anchorId));
      app.commitPreview();
      aim = { bentoId: node.itemId, cell: null };
      app.setCanvasModeStep(AIM_STEP);
    },
  },
};
