/**
 * ADD AXIS — the equation binding that puts a grid + axis BEHIND a graph line and
 * keeps the two agreeing forever.
 *
 * User request (2026-08-02): "for that widget perhaps a Add Axis tool would be
 * nice, to create and bind height/width/x/y of some grid + axis directly behind
 * it." ("that widget" = the graph line.)
 *
 * ── WHY THIS IS A CORE MODULE AND NOT A PLUGIN EXPORT ─────────────────────────
 * The binding mints TWO items of two DIFFERENT types — a `graph_grid` and a
 * `graph_tick_marks` — from one target's id. Either plugin owning it would have to
 * name the other, and NO PLUGIN MAY IMPORT ANOTHER (CLAUDE.md: "composition happens
 * through capabilities and document state"). So the knowledge that these two types
 * compose into "grid + axis" lives here, in DOM-free core, where the app layer and
 * the tests can both reach it. It deliberately does NOT live in core/graph_scale.js
 * despite the family affinity: that module is the pure scale/tick foundation the
 * bare-node CLI loads through four plugins, and it has exactly one import (`ease`).
 * Pulling core/expressions.js — which transitively drags derive, properties and the
 * Skia material registries — into it to write two string literals would tax every
 * CLI render for a helper only the editor's command layer calls.
 *
 * ── WHY TWO ITEMS AND NOT ONE ─────────────────────────────────────────────────
 * The user asked for "grid + axis", and in this codebase those are genuinely two
 * widgets with disjoint jobs. `graph_grid` draws ONLY the ruled lines: its
 * `gridAxis` prop selects vertical/horizontal/both, and it carries no axis line,
 * no ticks and no numeric labels anywhere in its defaults or inspector. The axis
 * proper — `showAxisLine`, `axisColor`, `axisWidth`, the `spine` choice between the
 * centered math-textbook look and a boxed plot, the Manim arrow `includeTip`, the
 * major/minor tick marks and the tick LABELS — is entirely `graph_tick_marks`.
 * There is therefore no single item that satisfies "grid + axis"; picking one would
 * mean silently dropping half of what was asked for. So the pair is inserted, and
 * both are bound to the same target by the same equations, which is what keeps them
 * registered with each other as well as with the curve.
 *
 * ── THE BINDING ───────────────────────────────────────────────────────────────
 * Per inserted item, six equations against the graph line's STORED id:
 *
 *   x: = @<id>.x   w: = @<id>.w   xRange: = @<id>.xRange
 *   y: = @<id>.y   h: = @<id>.h   yRange: = @<id>.yRange
 *
 * GEOMETRY covers the target exactly (the Add Center Text precedent, 45355b0), so
 * the grid tracks a MOVE and a RESIZE alike.
 *
 * RANGE is the half that makes this a graph tool rather than a rectangle tool, and
 * it is what the user meant by "bind". The graph family's shared convention is a
 * `[min, max, step]` 3-tuple STRING (`xRange: "[-6.2832, 6.2832, 1.5708]"`), and all
 * three plugins parse it with the same `parseRange`. Binding it means the grid's
 * data window IS the curve's: retune the curve's window and the ruling behind it
 * re-spaces to match, with no second quantity for the author to keep in sync.
 *
 * A STRING-VALUED EQUATION IS LEGAL HERE, and that was worth checking rather than
 * assuming. core/expressions.js types an `=` slot by its inspector row kind through
 * KIND_RESULT; `xRange`/`yRange` are `kind: "text"`, which maps to the result type
 * "string", and `resultMatchesKind(v, "string")` is a plain `typeof v === "string"`.
 * A bare `= @<id>.xRange` is a REFERENCE expression, so it returns the referent's
 * value unchanged — the tuple string arrives verbatim, and `parseRange` sees exactly
 * what it would have seen had the author typed it. Measured on the real evaluator
 * before this module was written: zero errors, `xRange` "[-6.2832, 6.2832, 1.5708]"
 * read straight through onto the grid. tests/add_axis_test.js pins that.
 */

import { storedItemRef } from "./expressions.js";

/**
 * Pure function. The six equation overrides binding ONE new graph-family item to a
 * graph line's box AND data window. Shared by both inserted items, because "the
 * grid agrees with the curve" and "the axis agrees with the curve" are the same
 * four-plus-two equations against the same id.
 *
 * Throws (via storedItemRef) on an id that violates the stored-id invariant — an id
 * containing "_" would read back as a DIFFERENT item, silently.
 *
 * Args:
 *   targetId (string): the itemId of the graph line to bind to
 *
 * Returns:
 *   object: property overrides — four geometry equations + two range equations
 *
 * @example graphAxisBindingOverrides("ab12cd34").x // "= @ab12cd34.x"
 * @example graphAxisBindingOverrides("ab12cd34").h // "= @ab12cd34.h"
 * @example graphAxisBindingOverrides("ab12cd34").xRange // "= @ab12cd34.xRange"
 * @example // the whole dict — the box and the data window, re-evaluating together:
 * @example // {x: "= @ab12cd34.x", y: "= @ab12cd34.y", w: "= @ab12cd34.w", h: "= @ab12cd34.h", xRange: "= @ab12cd34.xRange", yRange: "= @ab12cd34.yRange"}
 * @example // graphAxisBindingOverrides("Do_it") throws — a "_" in an id resolves to a different item
 */
export function graphAxisBindingOverrides(targetId) {
  return {
    x: `= ${storedItemRef(targetId, ".x")}`,
    y: `= ${storedItemRef(targetId, ".y")}`,
    w: `= ${storedItemRef(targetId, ".w")}`,
    h: `= ${storedItemRef(targetId, ".h")}`,
    xRange: `= ${storedItemRef(targetId, ".xRange")}`,
    yRange: `= ${storedItemRef(targetId, ".yRange")}`,
  };
}

/**
 * Pure function. The GRID half's overrides: the shared binding plus the type.
 *
 * Nothing about the grid's LOOK is overridden — its defaults are the tuned
 * NumberPlane palette, and `growth` already defaults to 1 so the grid is fully
 * drawn rather than mid-snake-in. The author retunes from a complete, visible grid.
 *
 * @param {string} targetId - the graph line's itemId
 * @returns {object} overrides for a graph_grid item
 *
 * @example axisGridOverrides("ab12cd34").type // "graph_grid"
 * @example axisGridOverrides("ab12cd34").w // "= @ab12cd34.w"
 * @example axisGridOverrides("ab12cd34").yRange // "= @ab12cd34.yRange"
 */
export function axisGridOverrides(targetId) {
  return { type: "graph_grid", ...graphAxisBindingOverrides(targetId) };
}

/**
 * Pure function. The AXIS half's overrides: the shared binding plus the type.
 *
 * Like the grid, the axis keeps its own defaults — `showAxisLine` true, `spine`
 * "zero" (the centered math-textbook axis, which is the one that reads as "an axis
 * behind a curve"), ticks and labels on. The user asked for an axis; they get a
 * drawn one.
 *
 * @param {string} targetId - the graph line's itemId
 * @returns {object} overrides for a graph_tick_marks item
 *
 * @example axisTicksOverrides("ab12cd34").type // "graph_tick_marks"
 * @example axisTicksOverrides("ab12cd34").x // "= @ab12cd34.x"
 * @example axisTicksOverrides("ab12cd34").xRange // "= @ab12cd34.xRange"
 */
export function axisTicksOverrides(targetId) {
  return { type: "graph_tick_marks", ...graphAxisBindingOverrides(targetId) };
}
