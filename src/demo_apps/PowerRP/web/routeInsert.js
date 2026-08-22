/**
 * INSERTING A ROUTING POINT INTO A WIRE — the app-layer half of the gesture the
 * user asked for: "it would be nice if I could double click on a wire to add a
 * routing point widget....just kinda a lone connector...used to make the wires
 * nicer" (2026-08-22).
 *
 * The DECISIONS are pure and live in core (`core/wire_drag.wireAt` picks the wire
 * under the pointer, `routeInsertPairs` says what the destination input becomes);
 * this module is the one place they meet the live document. It is a module rather
 * than a method on the app object for the reason web/knobFocus.js is one: a
 * gesture that touches the document needs `app`, not to BE part of it.
 *
 * ── ONE UNDO UNIT, AND IT HAS TO BE ────────────────────────────────────────
 * The insertion is TWO writes — a new item, and the destination's input moved onto
 * it — and a Cmd+Z that undid only one of them would leave either an orphan dot or
 * a wire pointing at an item that no longer exists. So the document is threaded
 * through `withNewItem` and `keyframed` and committed ONCE, which is the same
 * shape every rig builder in web/app.svelte.js uses for the same reason.
 *
 * ── THE JOINT INHERITS THE CABLE ───────────────────────────────────────────
 * Its `portType` is the wire's type and its colour is the wire's colour, so the
 * dot disappears into the cable it joins and no dialog asks the author anything.
 * Both are ordinary properties they can change afterwards.
 *
 * ── AN EXEC WIRE IS REFUSED, WITH THE REASON ───────────────────────────────
 * An exec pin fires AT MOST ONE continuation (core/nodeflow.js's cardinality
 * mirror: `exec OUT ≤ 1`, `data IN ≤ 1`), so the one thing a routing point is FOR
 * — "split one connector into multiple outputs" — is inexpressible on it, and an
 * exec wire is stored on the OTHER side of the connection besides. Rather than
 * insert a joint that silently cannot fan out, the gesture declines and says why.
 */

import { keyframed, withNewItem, withNormalizedZ } from "../core/document.js";
import { deriveWires } from "../core/derive.js";
import { EXEC_TYPE, portColor } from "../core/nodeflow.js";
import { reportAction } from "../core/report.js";
import { routeInsertPairs, wireAt } from "../core/wire_drag.js";
import { routeNodePlugin } from "../plugins/route_node.js";

/**
 * Pure function. The CREATION STATE of a routing point dropped into `wire`,
 * centred on a world point: the plugin's defaults, the cable's type and colour,
 * the box centred on where the author double-clicked, and the incoming wire
 * already plugged into its input.
 *
 * @param {object} wire - one core/derive.deriveWires record
 * @param {number} wx - world x of the drop
 * @param {number} wy - world y of the drop
 * @param {number} z - the z the item is created at
 * @returns {object} an item state
 *
 * @example routeState({from: {item: "a", port: "o"}, to: {item: "b", port: "i"}, type: "number"}, 100, 50, 3).portType // "number"
 * @example routeState({from: {item: "a", port: "o"}, to: {item: "b", port: "i"}, type: "number"}, 100, 50, 3).inputs // {in: {item: "a", port: "o"}}
 * @example // the box is CENTRED on the point, so the dot lands under the pointer
 * @example routeState({from: {item: "a", port: "o"}, to: {item: "b", port: "i"}, type: "visual"}, 100, 50, 1).x // 92
 * @example // the cable's own colour wins over the type's, so the joint vanishes into it
 * @example routeState({from: {item: "a", port: "o"}, to: {item: "b", port: "i"}, type: "visual", color: "#ff8800"}, 0, 0, 1).color // "#ff8800"
 */
export function routeState(wire, wx, wy, z) {
  const d = routeNodePlugin.defaults;
  return {
    ...d,
    x: wx - d.w / 2,
    y: wy - d.h / 2,
    z,
    portType: wire.type,
    color: wire.color ?? portColor(wire.type),
    inputs: { in: { item: wire.from.item, port: wire.from.port } },
  };
}

/**
 * Command (commits one undo unit; reports a refusal). Inserts a routing point
 * into whatever wire lies under a WORLD point, and returns whether it did.
 *
 * Returns false — writing nothing and saying nothing — when no wire is there: a
 * double-click on empty canvas is not an error, it is a miss.
 *
 * @param {object} app - the live app
 * @param {number} wx - world x
 * @param {number} wy - world y
 * @param {number} tol - grab radius in WORLD units (the caller converts from screen)
 * @returns {boolean} whether the gesture was consumed
 */
export function insertRoutingPointAt(app, wx, wy, tol) {
  const nodes = app.nodes();
  const wire = wireAt(deriveWires(nodes), wx, wy, tol);
  if (!wire) return false;
  if (wire.type === EXEC_TYPE) {
    reportAction("PowerRP: an event wire cannot take a routing point — an exec pin fires exactly one continuation, so there is nothing for a joint to split.");
    return true; // the double-click WAS on a wire; it is refused, not missed
  }
  // Above everything, like every freshly added item (web/app.svelte.js addItem's
  // rule), so a joint dropped over a crowded patch is visible and grabbable.
  const zs = nodes.map((n) => n.state.z ?? 0);
  const [withItem, id] = withNewItem(app.doc, app.slideIndex, {
    ...routeState(wire, wx, wy, (zs.length ? Math.max(...zs) : 0) + 1),
    // active:true is keyframed ON the creation slide — the visibility model every
    // other insertion follows (addItem states it).
    active: true,
  });
  let doc = withItem;
  for (const [path, value] of routeInsertPairs(app.state().items ?? {}, wire, id))
    doc = keyframed(doc, app.slideIndex, path, value);
  app.commit(withNormalizedZ(doc));
  app.selection = id;
  return true;
}
