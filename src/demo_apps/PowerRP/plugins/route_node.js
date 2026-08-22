/**
 * ROUTING POINT — a lone connector: one input, one output, no behaviour.
 *
 * ── THE ASK (user, 2026-08-22) ──────────────────────────────────────────────
 * "it would be nice if I could double click on a wire to add a routing point
 * widget....just kinda a lone connector...used to make the wires nicer" …
 * "a routing node is just a lone connector pretty much - it can let you split one
 * connector into multiple outputs later on down the connection, which is nice for
 * formatting" … "as you may have guessed - it is a widget too".
 *
 * So it is an ordinary widget (a document item with slides, deltas, keyframes)
 * that declares PORTS, and its whole job is to be a POINT A CABLE PASSES THROUGH.
 * Two things follow from that and nothing else does:
 *
 *   IT SPLITS BY BEING A NODE. The user's "split one connector into multiple
 *     outputs" needs no fan-out feature: an OUTPUT already fans out to as many
 *     inputs as you like (core/nodeflow.js's founding asymmetry). One wire in,
 *     N wires out of the same dot — which is exactly a splitter, drawn where the
 *     author put it rather than where the source happens to sit.
 *   IT PASSES ITS VALUE THROUGH UNCHANGED. `computeOutputs` returns the input,
 *     so a routing point is INVISIBLE to the value graph — a display behind three
 *     of them reads the same number it read behind none. And because a chain of
 *     them is still a chain of ordinary nodes, the evaluator, the wire layer, the
 *     exporters and the clone remap need to know nothing about them.
 *
 * ── IT IS ALSO PASS-THROUGH FOR THE CONSUMERS THAT ARE NOT THE EVALUATOR ────
 * The value evaluator handles a routing point for free (above). Three OTHER
 * readers walk `inputs` themselves and would have seen a routing point as a
 * stranger: the audio mirror (which asks "is my source an engine module?"), the
 * live-control router (a button press) and the clip router (a MIDI trigger). All
 * three now resolve a wire's source through `core/nodeflow.resolvedWireSource`,
 * which walks back across any plugin declaring `passThrough` — this one. So a
 * routing point tidying an AUDIO patch does not silence it, and a button behind
 * one still fires. That is the whole reason `passThrough` is a DECLARATION here
 * rather than a type check somewhere else: the next widget that is honestly a
 * cable joint gets the same treatment by saying so.
 *
 * ── ITS PORT TYPE IS A PROPERTY, BECAUSE A CABLE HAS A TYPE ─────────────────
 * A wire may carry a number, a trigger, MIDI, audio, a node reference or nothing
 * at all (the `visual` type), and a joint in that cable must carry the same thing
 * or the connection is refused at both ends. So `portType` is an ordinary select
 * leaf and `ports(state)` reads it — the port list is a function of state, which
 * is the protocol's own answer to a widget whose ports vary. Inserting a routing
 * point ON a wire (web/app.svelte.js insertRoutingPointAt) sets it from that
 * wire, so the common path never asks the author anything.
 *
 * ── WHY IT PAINTS ITS OWN DOT AND NOT THE SHARED BEADS ─────────────────────
 * Every other node paints `portBeads` — a coloured ring per port, on the card's
 * edge. A routing point IS its port: it is 16 units across, so two rings plus a
 * body would draw three circles where the author asked for one. It paints ONE
 * disc filling its box instead, and the ports sit on that disc's left and right
 * edges, under the ink. The editor still shows its two interaction beads in the
 * overlay (every node does), which is what tells you where to grab — and an
 * export, where no overlay exists, contains exactly the dot that was drawn.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import {
  NODE_ITEM_REFS, PORT_TYPES, PORT_TYPE_NAMES, nodeInkBounds, nodeInputRows, portColor,
} from "../core/nodeflow.js";
import { closestPointOnCircle } from "../core/outline.js";
import { ellipse } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "../core/transform.js";

/** A routing point's default diameter, in canvas units. Sized to a port bead's
 *  own footprint (core/nodeflow.PORT_BEAD_R is 6, so a bead is 12 across): a
 *  joint in a cable should read as the same order of thing as the socket it
 *  joins, and a dot much larger than that stops being a point. */
const ROUTE_SIZE = 16;

/** What a routing point carries until something says otherwise: the `visual`
 *  type, which carries nothing — the honest default for a widget inserted from
 *  the palette with no wire in sight. */
const DEFAULT_PORT_TYPE = "visual";

/** The Inspector category this widget's own two rows land in. */
const CAT = "formatting";

/**
 * Pure function. A routing point's PORT TYPE, defaulted for a state that names
 * none or names one that no longer exists.
 *
 * @param {object} s - the folded item state
 * @returns {string} a core/nodeflow.PORT_TYPES key
 *
 * @example routePortType({portType: "number"}) // "number"
 * @example routePortType({}) // "visual"
 * @example routePortType({portType: "nonsense"}) // "visual"
 */
export function routePortType(s) {
  return PORT_TYPES[s?.portType] ? s.portType : DEFAULT_PORT_TYPE;
}

/**
 * Pure function. THE PORT DECLARATION: one input, one output, both of the
 * widget's own `portType` and both wearing its own colour — so the cable that
 * arrives, the dot, and the cable that leaves are one colour by construction.
 *
 * @param {object} s - the folded item state
 * @returns {{inputs: object[], outputs: object[]}}
 *
 * @example routePorts({portType: "number", color: "#ff8800"}).inputs[0] // {key: "in", type: "number", label: "", color: "#ff8800"}
 * @example routePorts({}).outputs[0].type // "visual"
 * @example routePorts({}).outputs[0].key // "out"
 */
export function routePorts(s) {
  const type = routePortType(s);
  // A BLANK LABEL IS THE POINT: core/node_chrome.portBeads draws the jack alone
  // for one, and this widget draws no beads at all — a label on a 16-unit dot
  // would be chrome three times its size.
  const port = (key) => ({ key, type, label: "", color: typeof s?.color === "string" ? s.color : portColor(type) });
  return { inputs: [port("in")], outputs: [port("out")] };
}

/**
 * Pure function. THE `placePorts` HOOK (core/nodeflow.portLayout): the input on
 * the disc's left edge, the output on its right, both at its vertical centre —
 * the standard card column (a title bar and a stack of rows) means nothing on a
 * widget the size of one bead.
 *
 * @param {object} s - the folded item state
 * @param {object[]} rows - portLayout's card-column rows
 * @returns {object[]} the same rows, placed
 *
 * @example placeRoutePorts({w: 16, h: 16}, [{key: "in", side: "input", x: 0, y: 34}, {key: "out", side: "output", x: 16, y: 34}]).map((r) => [r.x, r.y]) // [[0, 8], [16, 8]]
 * @example // a FLIPPED routing point is a reflection, not a negative box
 * @example placeRoutePorts({w: -16, h: -16}, [{key: "in", side: "input", x: 0, y: 34}]) // [{key: "in", side: "input", x: 0, y: 8}]
 */
export function placeRoutePorts(s, rows) {
  const w = Math.abs(Number(s?.w) || 0);
  const h = Math.abs(Number(s?.h) || 0);
  return rows.map((r) => ({ ...r, x: r.side === "input" ? 0 : w, y: h / 2 }));
}

export const routeNodePlugin = {
  type: "route_node",
  ephemeral: EPHEMERAL.NONE,
  title: "Routing Point",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  // THE PASS-THROUGH DECLARATION (core/nodeflow.resolvedWireSource): "a wire that
  // reaches my `out` came from whatever reaches my `in`". Read by the three
  // consumers that walk `inputs` themselves rather than through the evaluator —
  // the audio mirror, the live-control router and the clip router. See the header.
  passThrough: { in: "in", out: "out" },
  defaults: {
    type: "route_node", x: 100, y: 100, w: ROUTE_SIZE, h: ROUTE_SIZE,
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    portType: DEFAULT_PORT_TYPE,
    color: portColor(DEFAULT_PORT_TYPE),
    // Empty at birth but PRESENT — NODE_ITEM_REFS names a wildcard path through
    // it, and a wildcard cannot expand over a slot that does not exist, so a
    // routing point without this key would stay wired to the original when it
    // was copied (core/audio_nodes.js measured what that costs).
    inputs: {},
    ...defaults("opacity"),
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    ...nodeInputRows({ ports: routePorts }),
    { key: "portType", label: "Carries", kind: "select", options: [...PORT_TYPE_NAMES], optionLabels: Object.fromEntries(PORT_TYPE_NAMES.map((t) => [t, PORT_TYPES[t].label])), category: CAT, help: "What kind of cable this point joins. It must match the wire it sits on, or neither end will connect. Inserting a routing point by double-clicking a wire sets this from that wire." },
    { key: "color", label: "Colour", kind: "color", category: CAT, help: "The dot's colour, and the colour of the wires into and out of it. Inserting on a wire copies that wire's colour, so the joint disappears into the cable." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  ports: routePorts,
  placePorts: placeRoutePorts,
  /**
   * Pure function. THE PASS-THROUGH: whatever arrived on `in` leaves on `out`,
   * unchanged and untyped-by-this-widget. That one line is what makes a routing
   * point invisible to everything downstream — a display behind three of them
   * reads what it would have read behind none.
   *
   * @param {object} _s - the folded item state (unused: a joint has no state of its own to publish)
   * @param {object} inputs - the resolved input values
   * @returns {{out: *}}
   *
   * @example routeNodePlugin.computeOutputs({}, {in: 7}) // {out: 7}
   * @example routeNodePlugin.computeOutputs({}, {in: null}) // {out: null}
   */
  computeOutputs(_s, inputs) {
    return { out: inputs.in };
  },
  /**
   * Pure function. ONE disc filling the box — see the header for why this widget
   * paints no port beads.
   *
   * @param {object} s - the folded item state
   * @param {*} _target - unused (bbox widget)
   * @param {object} world - the world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _target, world) {
    const w = Math.abs(Number(s.w) || 0), h = Math.abs(Number(s.h) || 0);
    const ops = [ellipse({
      cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2,
      fill: typeof s.color === "string" ? s.color : portColor(routePortType(s)),
      opacity: s.opacity ?? 1,
    })];
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  commands: [{
    id: "add-route-node",
    title: "Add Routing Point",
    icon: "mdi:circle-medium",
    run: (app) => app.armCrosshairPlacement(routeNodePlugin),
  }],
  cullMargin: effectsCullMargin,
  // THE BOUNDS PROTOCOL: the disc plus the half of each bead that sits outside
  // its edge — the shared node answer, which holds here because the ports sit on
  // the left and right edges exactly as a card's do.
  localBounds: (state) => nodeInkBounds(routeNodePlugin, state),
  anchors: standardBBoxAnchors,
  /** Pure function. The rim is the DISC's, so an arrow bound to a routing point
   *  lands on the dot rather than on the square around it (the ink rule). */
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const w = Math.abs(Number(state?.w) || 0), h = Math.abs(Number(state?.h) || 0);
    // A non-circular routing point (the author dragged a resize handle) projects
    // onto the circle of its MEAN radius: an exact ellipse rim would need an
    // iterative solve for a widget whose whole purpose is to be a dot.
    return closestPointOnCircle({ x: w / 2, y: h / 2 }, (w + h) / 4, local.x, local.y);
  },
};
