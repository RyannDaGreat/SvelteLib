/**
 * VISUAL NODE — the geometry behind plugins/visual_node.js: a node widget that
 * DOES NOTHING and exists to be DRAWN.
 *
 * ── THE ASK (user, 2026-08-21, verbatim where it matters) ───────────────────
 * "I just want one so that I can do visuals … customize the name of the node, the
 * color, the shape of the node, does it have pointy edges, is it a circle kind of
 * thing, and I need to be able to customize the list of inputs and outputs it has,
 * and the colors of those inputs and outputs as well … the nodes won't actually do
 * anything, but it should share the same structure, the same data type as the
 * audio ones." Shapes named: the card "we have right now, which is like the top
 * area for the label"; a flowchart kind "where I double click it and it has text
 * built into it"; diamond, circle/oval, square with "variable amounts of rounded
 * edges", chamfered edges, triangle. "Sometimes we'll have only text in the middle
 * of it. Sometimes we'll have labeled nodes, sometimes the nodes might be
 * unlabeled."
 *
 * ── WHAT IS SHARED AND WHAT IS NEW ──────────────────────────────────────────
 * SHARED, by construction: the port protocol (core/nodeflow.js — beads, ghost
 * wire, `inputs.<port>` leaf, clone remap, wire layer), the node chrome's bead
 * painter and text metrics (core/node_chrome.js), the text box convention of
 * plugins/plaintext.js (one `text()` op with boxW/boxH + align/valign, edited in
 * place by the same controller), the paint registry (`fill` may be a gradient or
 * a material), and the universal effects bundle. This file adds exactly the three
 * things a do-nothing node needs and nothing else has:
 *
 *   1. A SILHOUETTE FAMILY (`visualNodePathD`): card, rect, ellipse, diamond,
 *      triangle, with one `cornerRadius` and one `cornerStyle` (round | chamfer)
 *      for the polygonal ones. All PATH ops (lines + beziers, never arcs — the
 *      backend contract in core/shapes.js), so every exporter draws them.
 *   2. PORTS FROM TWO LIST PROPERTIES (`visualNodePorts`): `inPorts`/`outPorts`
 *      are ordinary core/lists.js lists (label, colour, and for inputs the
 *      `multiple` permission), so a port is keyframable, equation-bindable,
 *      hideable-without-renumbering and purgeable like a gradient stop.
 *   3. PORTS ON THE INK (`placeVisualPorts`): a card keeps the standard column,
 *      but a diamond's beads sit on its slanted edges and an ellipse's on its
 *      curve — otherwise a bead at x=0 floats in the empty bbox corner beside
 *      the shape. This is the `placePorts` hook core/nodeflow.portLayout offers.
 *
 * ── THE PORT KEY IS THE ELEMENT'S INDEX, AND THAT IS A STATED TRADE ─────────
 * `inPorts[2]` is the port `in2`, always. Connections are stored BY KEY
 * (`inputs.in2 = {item, port}`), so a key that followed the label would dangle
 * every wire the moment the label was edited — the same reason core/expressions.js
 * stores item references by id and displays slugs. The index is stable under HIDE
 * (core/lists.js: "HIDE NEVER RENUMBERS"), which is the operation that takes a
 * port out of the picture without losing it; PURGE and INSERT renumber, exactly as
 * they renumber a polygon's vertices, and a wire on a renumbered port is the same
 * hazard a per-element equation is — the list module's own documented cost, not a
 * new one.
 *
 * ── WHY THE LABEL IS OPTIONAL AND WHERE IT GOES ─────────────────────────────
 * "If I just have a zero null string for the label" is the user's own spelling of
 * an unlabeled node. On the CARD shape the label is the title strip, and a blank
 * label removes the strip entirely (the shape alone, text in the middle). On every
 * other shape the strip would fight the silhouette — a title bar on a diamond is
 * a rectangle stuck to a rhombus — so the label is a small bold caption at the TOP
 * of the shape's inscribed text box, and the body text sits beneath it. One
 * property, one meaning ("the node's name, drawn"), two placements that each suit
 * the silhouette they land on.
 *
 * DOM-free, painter-free: everything here is pure geometry over folded state, so
 * tests/visual_node_test.js runs it in bare node.
 */

import { NODE_HEADER_H, NODE_PAD, NODE_TITLE_SIZE, nodeBodyTop, nodeBox, textLineH } from "./node_chrome.js";
import { NODE_CORNER_R, PORT_BEAD_R } from "./nodeflow.js";

/** How far a bead reaches INSIDE the edge it straddles — its radius (portLayout's
 *  "half in, half out"). A rect's text box clears this on the sides that carry
 *  ports so a long line never runs under a socket. */
const NODE_BEAD_CLEARANCE = PORT_BEAD_R;
import { CORNER_STYLES, ellipsePathD, polygonPathD, roundedPolygonPathD } from "./shapes.js";
import { closestPointOnOutlines, pathDPolylines } from "./outline.js";
import { elementActive } from "./lists.js";

/** The silhouettes, in picker order. `card` is the node-chrome look every other
 *  node wears (title strip, standard port column); the rest are the flowchart
 *  vocabulary the user listed. */
export const VISUAL_SHAPES = Object.freeze(["card", "rect", "ellipse", "diamond", "triangle"]);

/** Human labels for the shape select, single-sourced beside the names. */
export const VISUAL_SHAPE_LABELS = Object.freeze({
  card: "Card", rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", triangle: "Triangle",
});

/** THE port type every visual port declares (core/nodeflow.PORT_TYPES.visual).
 *  Spelled once so no reader compares against the literal. */
export const VISUAL_PORT_TYPE = "visual";

/** The two port list properties' state keys — the input list and the output
 *  list (core/properties.js PROPS declares their element shapes). */
export const IN_PORTS_KEY = "inPorts";
export const OUT_PORTS_KEY = "outPorts";

/** The inscribed-rectangle fraction of an ellipse: a box of side 1/√2 of each
 *  axis fits inside it exactly (the square inscribed in the unit circle). */
const ELLIPSE_INSCRIBED = Math.SQRT1_2;

/**
 * Pure function. The polygon a polygonal visual shape is built from, in bbox-local
 * space (0..w, 0..h, y-down), corners in drawing order.
 *
 * The triangle is the ISOSCELES one filling the box — apex top-centre, base along
 * the bottom — rather than core/shapes.js's regular (circle-inscribed) triangle,
 * whose base sits at 0.75·h and leaves a quarter of the box empty. A flowchart
 * triangle is a box-filling shape whose text box (visualNodeTextBox) is derived
 * from exactly these three points.
 *
 * @param {string} shape - a VISUAL_SHAPES entry other than "ellipse"
 * @param {number} w - box width
 * @param {number} h - box height
 * @returns {number[][]} [[x, y], …]
 *
 * @example visualShapePoints("rect", 100, 50) // [[0, 0], [100, 0], [100, 50], [0, 50]]
 * @example visualShapePoints("card", 100, 50) // [[0, 0], [100, 0], [100, 50], [0, 50]]
 * @example visualShapePoints("diamond", 100, 50) // [[50, 0], [100, 25], [50, 50], [0, 25]]
 * @example visualShapePoints("triangle", 100, 50) // [[50, 0], [100, 50], [0, 50]]
 * @example // visualShapePoints("ellipse", 100, 50) // throws — an ellipse has no corners
 */
export function visualShapePoints(shape, w, h) {
  switch (shape) {
    case "card": case "rect": return [[0, 0], [w, 0], [w, h], [0, h]];
    case "diamond": return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
    case "triangle": return [[w / 2, 0], [w, h], [0, h]];
    default: throw new Error(`visual_node: "${shape}" has no polygon (shapes with corners: card, rect, diamond, triangle)`);
  }
}

/**
 * Pure function. A visual shape's outline as SVG path data in bbox-local space.
 * Polygonal shapes take the corner treatment (`cornerRadius` in local units, cut
 * `round` or `chamfer` — core/shapes.roundedPolygonPathD); the ellipse ignores it,
 * having no corners. An unknown shape THROWS rather than drawing something else.
 *
 * @param {string} shape - a VISUAL_SHAPES entry
 * @param {number} w - box width
 * @param {number} h - box height
 * @param {number} [cornerRadius] - corner cut-back, local units (0 = sharp)
 * @param {string} [cornerStyle] - "round" | "chamfer"
 * @returns {string} SVG path data
 *
 * @example visualNodePathD("diamond", 100, 50) // "M50 0 L100 25 L50 50 L0 25 Z"
 * @example visualNodePathD("rect", 40, 40, 10).startsWith("M0 10 Q0 0 10 0") // true (round corner)
 * @example visualNodePathD("rect", 40, 40, 10, "chamfer").startsWith("M0 10 L10 0") // true (cut corner)
 * @example (visualNodePathD("ellipse", 100, 60).match(/C/g) || []).length // 4
 * @example // visualNodePathD("blob", 10, 10) // throws
 */
export function visualNodePathD(shape, w, h, cornerRadius = 0, cornerStyle = "round") {
  if (!VISUAL_SHAPES.includes(shape)) throw new Error(`visual_node: unknown shape ${JSON.stringify(shape)} (known: ${VISUAL_SHAPES.join(", ")})`);
  if (shape === "ellipse") return ellipsePathD(w, h);
  return roundedPolygonPathD(visualShapePoints(shape, w, h), Math.max(0, Number(cornerRadius) || 0), cornerStyle);
}

/**
 * Pure function. A visual shape's outline SAMPLED to one closed polyline — the
 * form the rim projection and the port placement query. Curves are sampled by
 * core/outline.pathDPolylines at its standard density, which at node corner radii
 * is indistinguishable from the painted curve.
 *
 * @param {string} shape - a VISUAL_SHAPES entry
 * @param {number} w - box width
 * @param {number} h - box height
 * @param {number} [cornerRadius] - as visualNodePathD
 * @param {string} [cornerStyle] - as visualNodePathD
 * @returns {number[][]} [[x, y], …], closed implicitly
 *
 * @example visualNodeOutline("diamond", 100, 50) // [[50, 0], [100, 25], [50, 50], [0, 25]]
 * @example visualNodeOutline("ellipse", 100, 100).length > 16 // true (a sampled curve)
 */
export function visualNodeOutline(shape, w, h, cornerRadius = 0, cornerStyle = "round") {
  return pathDPolylines(visualNodePathD(shape, w, h, cornerRadius, cornerStyle))[0] ?? [];
}

/**
 * Pure function. Where a closed polyline CROSSES the horizontal line `y` — its
 * leftmost crossing for an "input" side, its rightmost for an "output" side — or
 * null when the line misses the shape entirely. THE edge query that puts a port
 * bead on the ink of a non-rectangular silhouette.
 *
 * Horizontal edges are skipped (they lie ON the line, and their endpoints are
 * reached through the edges that meet them), so a query exactly at a flat top or
 * bottom still answers with the shape's extent there.
 *
 * @param {number[][]} outline - a closed polyline [[x, y], …]
 * @param {number} y - the scanline
 * @param {string} side - "input" (leftmost) | "output" (rightmost)
 * @returns {number|null} the x of the crossing
 *
 * @example outlineEdgeX([[50, 0], [100, 25], [50, 50], [0, 25]], 25, "input") // 0
 * @example outlineEdgeX([[50, 0], [100, 25], [50, 50], [0, 25]], 12.5, "input") // 25
 * @example outlineEdgeX([[50, 0], [100, 25], [50, 50], [0, 25]], 12.5, "output") // 75
 * @example outlineEdgeX([[0, 0], [100, 0], [100, 50], [0, 50]], 0, "output") // 100 (a flat top still has an extent)
 * @example outlineEdgeX([[50, 0], [100, 25], [50, 50], [0, 25]], 80, "input") // null (below the shape)
 */
export function outlineEdgeX(outline, y, side) {
  let best = null;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % n];
    if (ay === by) continue;
    if (y < Math.min(ay, by) || y > Math.max(ay, by)) continue;
    const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
    if (best === null || (side === "input" ? x < best : x > best)) best = x;
  }
  return best;
}

/**
 * Pure function. A visual node's RESOLVED corner treatment off its state: the
 * radius (never negative) and the style, defaulted for an old document.
 *
 * @param {object} s - the folded item state
 * @returns {{cornerRadius: number, cornerStyle: string}}
 *
 * @example visualCorners({cornerRadius: 12, cornerStyle: "chamfer"}) // {cornerRadius: 12, cornerStyle: "chamfer"}
 * @example visualCorners({}) // {cornerRadius: 0, cornerStyle: "round"}
 * @example visualCorners({cornerRadius: -4}) // {cornerRadius: 0, cornerStyle: "round"}
 */
export function visualCorners(s) {
  const style = s?.cornerStyle;
  return {
    cornerRadius: Math.max(0, Number(s?.cornerRadius) || 0),
    cornerStyle: CORNER_STYLES.includes(style) ? style : CORNER_STYLES[0],
  };
}

/** Pure function. The state's shape name, defaulted for a state that says none.
 *  @example visualShapeOf({shape: "diamond"}) // "diamond"
 *  @example visualShapeOf({}) // "card" */
export function visualShapeOf(s) {
  return VISUAL_SHAPES.includes(s?.shape) ? s.shape : "card";
}

/**
 * Pure function. THE PORT DECLARATION a visual node answers `ports(state)` with,
 * read off its two list properties. Element `i` of `inPorts` is the input `in<i>`
 * and element `i` of `outPorts` the output `out<i>` — HIDDEN elements are absent
 * (their keys are skipped, never reassigned, so the numbering holds), a blank
 * label is a blank label (core/node_chrome.portBeads draws the jack alone), and
 * an input element's `multiple` flag becomes the port's `multiple` permission.
 *
 * Every port is VISUAL_PORT_TYPE: "there would be no types". The element's
 * `color` rides along as the port's own colour, which is what makes the bead and
 * the wire leaving it wear the author's choice rather than the type's.
 *
 * @param {object} s - the folded item state
 * @returns {{inputs: object[], outputs: object[]}}
 *
 * @example visualNodePorts({inPorts: [{label: "a", color: "#ff0000"}], outPorts: [{label: "", color: "#00ff00"}]}).inputs // [{key: "in0", type: "visual", label: "a", color: "#ff0000"}]
 * @example visualNodePorts({inPorts: [{label: "a", color: "#ff0000"}], outPorts: [{label: "", color: "#00ff00"}]}).outputs[0].key // "out0"
 * @example // a hidden element keeps its neighbours' numbering
 * @example visualNodePorts({inPorts: [{label: "a", color: "#ff0000"}, {label: "b", color: "#ff0000"}, {label: "c", color: "#ff0000"}], inPortsActive: [true, false, true]}).inputs.map((p) => p.key) // ["in0", "in2"]
 * @example // an input may accept several wires
 * @example visualNodePorts({inPorts: [{label: "mix", color: "#ff0000", multiple: true}]}).inputs[0].multiple // true
 * @example visualNodePorts({}) // {inputs: [], outputs: []}
 */
export function visualNodePorts(s) {
  const side = (key, prefix, withMultiple) => {
    const list = Array.isArray(s?.[key]) ? s[key] : [];
    const active = s?.[`${key}Active`];
    return list.flatMap((el, i) => {
      if (!elementActive(active, i)) return [];
      return [{
        key: `${prefix}${i}`,
        type: VISUAL_PORT_TYPE,
        label: String(el?.label ?? ""),
        color: el?.color,
        ...(withMultiple && el?.multiple ? { multiple: true } : {}),
      }];
    });
  };
  return { inputs: side(IN_PORTS_KEY, "in", true), outputs: side(OUT_PORTS_KEY, "out", false) };
}

/** The minimal "plugin" the geometry below hands to core/nodeflow's layout
 *  functions: the port declaration and the placement hook, nothing else. Declared
 *  here so visualNodeTextBox can ask where the port column ends without holding
 *  the real plugin object (which is built in plugins/ from these parts). */
const PORT_PLUGIN = Object.freeze({ ports: visualNodePorts, placePorts: placeVisualPorts });

/**
 * Pure function. THE `placePorts` HOOK (core/nodeflow.portLayout): the standard
 * port column, re-placed onto this node's silhouette.
 *
 * A CARD keeps the column untouched — beads astride the box edges from under the
 * title strip, the geometry every other node has. Every other shape CENTRES the
 * column vertically (there is no title strip to clear, and a diamond's widest
 * point is its middle) and then moves each bead horizontally onto the outline at
 * its own height (outlineEdgeX), so the bead straddles the ink rather than the
 * bounding box. A row the scanline misses (a very short shape) keeps the box edge,
 * which is the visible overflow the registry docblock asks for rather than a bead
 * that vanishes.
 *
 * @param {object} s - the folded item state
 * @param {object[]} rows - portLayout's card-column rows
 * @returns {object[]} the same rows, placed
 *
 * @example placeVisualPorts({shape: "card", w: 100, h: 80}, [{key: "in0", side: "input", x: 0, y: 34}]) // [{key: "in0", side: "input", x: 0, y: 34}]
 * @example // a diamond's lone input sits at its left corner, vertically centred
 * @example placeVisualPorts({shape: "diamond", w: 100, h: 80}, [{key: "in0", side: "input", x: 0, y: 34}]) // [{key: "in0", side: "input", x: 0, y: 40}]
 * @example // two outputs on a diamond land on its right-hand slopes, not in the box corner
 * @example placeVisualPorts({shape: "diamond", w: 100, h: 80}, [{key: "out0", side: "output", x: 100, y: 34}, {key: "out1", side: "output", x: 100, y: 56}]).map((r) => [r.x, r.y]) // [[86.25, 29], [86.25, 51]]
 */
export function placeVisualPorts(s, rows) {
  const shape = visualShapeOf(s);
  const { w, h } = nodeBox(s);
  if (shape === "card" || h === undefined) return rows;
  const { cornerRadius, cornerStyle } = visualCorners(s);
  const outline = visualNodeOutline(shape, w, h, cornerRadius, cornerStyle);
  const place = (side) => {
    const list = rows.filter((r) => r.side === side);
    if (list.length === 0) return [];
    const ys = list.map((r) => r.y);
    const shift = h / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
    return list.map((r) => {
      const y = r.y + shift;
      return { ...r, y, x: outlineEdgeX(outline, y, side) ?? (side === "input" ? 0 : w) };
    });
  };
  return [...place("input"), ...place("output")];
}

/**
 * Pure function. The closest point ON a visual node's painted outline to a LOCAL
 * query — the `closestAnchor` projection the ink rule registers the eight rim
 * anchors through, so an arrow bound to a diamond lands on the diamond. A
 * projection, not a clamp: an interior query is pushed out to the nearest edge
 * (core/nodeflow.nodeCardRim states the defect a clamp had).
 *
 * @param {object} s - the folded item state
 * @param {number} lx - LOCAL x
 * @param {number} ly - LOCAL y
 * @returns {{x: number, y: number}}
 *
 * @example visualNodeRim({shape: "diamond", w: 100, h: 100}, 30, 40) // {x: 20, y: 30} (an interior point lands on the nearest slope)
 * @example visualNodeRim({shape: "rect", w: 100, h: 60}, -30, 30) // {x: 0, y: 30}
 * @example visualNodeRim({shape: "ellipse", w: 100, h: 100}, 200, 50).x // 100 (the ellipse's right extreme)
 */
export function visualNodeRim(s, lx, ly) {
  const { w, h } = nodeBox(s);
  const { cornerRadius, cornerStyle } = visualCorners(s);
  const outline = visualNodeOutline(visualShapeOf(s), w, h ?? 0, cornerRadius, cornerStyle);
  return closestPointOnOutlines([outline], lx, ly, { x: lx, y: ly });
}

/** Pure function. Is the node's label blank — i.e. is this an UNLABELED node?
 *  @example visualLabelIsEmpty({label: ""}) // true
 *  @example visualLabelIsEmpty({label: "  "}) // true
 *  @example visualLabelIsEmpty({label: "Start"}) // false
 *  @example visualLabelIsEmpty({}) // true */
export function visualLabelIsEmpty(s) {
  return String(s?.label ?? "").trim() === "";
}

/**
 * Pure function. Does this node draw the CARD TITLE STRIP? Only the card shape,
 * and only with a label to put in it — a blank label removes the strip, which is
 * the user's "zero null string" unlabeled node.
 *
 * @param {object} s - the folded item state
 * @returns {boolean}
 *
 * @example visualHasHeader({shape: "card", label: "Osc"}) // true
 * @example visualHasHeader({shape: "card", label: ""}) // false
 * @example visualHasHeader({shape: "diamond", label: "Osc"}) // false (a caption, not a strip)
 */
export function visualHasHeader(s) {
  return visualShapeOf(s) === "card" && !visualLabelIsEmpty(s);
}

/**
 * Pure function. The card's title strip as a closed polygon: the shape's own
 * outline CLIPPED to the band above `bandH` — so the strip's top corners are the
 * body's corners (round or chamfered, at whatever radius) and its bottom edge is
 * flat. Exact for any corner treatment, which is why it is a clip and not a
 * second rounded rect whose radius would have to agree with the body's.
 *
 * Sutherland–Hodgman against the one edge y ≤ bandH.
 *
 * @param {number[][]} outline - the shape outline (visualNodeOutline)
 * @param {number} bandH - the strip's height
 * @returns {number[][]} the strip polygon, or [] when the outline is empty
 *
 * @example visualHeaderOutline([[0, 0], [100, 0], [100, 80], [0, 80]], 24) // [[0, 0], [100, 0], [100, 24], [0, 24]]
 * @example // a sharp diamond clipped at its top third is a triangle
 * @example visualHeaderOutline([[50, 0], [100, 50], [50, 100], [0, 50]], 25) // [[50, 0], [75, 25], [25, 25]]
 */
export function visualHeaderOutline(outline, bandH) {
  const out = [];
  const n = outline.length;
  const inside = (p) => p[1] <= bandH;
  const cross = (a, b) => [a[0] + ((bandH - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), bandH];
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    if (inside(a)) {
      out.push(a);
      if (!inside(b)) out.push(cross(a, b));
    } else if (inside(b)) {
      out.push(cross(a, b));
    }
  }
  return out;
}

/**
 * Pure function. The card's title strip as path data, for the painter.
 *
 * @param {object} s - the folded item state
 * @returns {string} SVG path data of the strip
 *
 * @example visualHeaderPathD({shape: "card", w: 100, h: 80, cornerRadius: 0}) // "M0 0 L100 0 L100 24 L0 24 Z"
 */
export function visualHeaderPathD(s) {
  const { w, h } = nodeBox(s);
  const { cornerRadius, cornerStyle } = visualCorners(s);
  return polygonPathD(visualHeaderOutline(visualNodeOutline("card", w, h ?? 0, cornerRadius, cornerStyle), NODE_HEADER_H));
}

/**
 * Pure function. The LOCAL rect a shape's content may occupy — the largest
 * comfortable rectangle inside the silhouette, inset from the ink by the node
 * padding, and on the card cleared of the port column the way every node's own
 * face is (core/node_chrome.nodeBodyTop). This is the box the label caption and
 * the body text are laid out in, BEFORE the caption takes its share.
 *
 *   card      the width inside the padding, from under the port column (or the
 *             header, when there are no ports) to the bottom padding
 *   rect      the box inside the padding, further cleared of the beads on the
 *             sides that carry ports (a bead sits half inside the edge)
 *   ellipse   the inscribed rectangle (each side 1/√2 of the axis), inset
 *   diamond   the inscribed rectangle (half of each axis)
 *   triangle  the largest rectangle under an apex-up isosceles: the lower half
 *             of the height at half the width
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}} LOCAL, never negative
 *
 * @example visualContentBox({shape: "diamond", w: 200, h: 100}) // {x: 50, y: 25, w: 100, h: 50}
 * @example visualContentBox({shape: "triangle", w: 200, h: 100}) // {x: 50, y: 50, w: 100, h: 40}
 * @example visualContentBox({shape: "ellipse", w: 100, h: 100}).w // 70.71067811865476
 * @example // a card with one input row: the text starts under the bead, not under the strip
 * @example visualContentBox({shape: "card", w: 180, h: 110, inPorts: [{label: "in"}]}) // {x: 10, y: 48, w: 160, h: 52}
 */
export function visualContentBox(s) {
  const shape = visualShapeOf(s);
  const { w, h: hh } = nodeBox(s);
  const h = hh ?? 0;
  const rect = (x, y, bw, bh) => ({ x, y, w: Math.max(0, bw), h: Math.max(0, bh) });
  switch (shape) {
    case "card": {
      const top = nodeBodyTop(PORT_PLUGIN, s);
      return rect(NODE_PAD, top, w - 2 * NODE_PAD, h - top - NODE_PAD);
    }
    case "rect": {
      const ports = visualNodePorts(s);
      const left = NODE_PAD + (ports.inputs.length ? NODE_BEAD_CLEARANCE : 0);
      const right = NODE_PAD + (ports.outputs.length ? NODE_BEAD_CLEARANCE : 0);
      return rect(left, NODE_PAD, w - left - right, h - 2 * NODE_PAD);
    }
    case "ellipse": {
      const bw = w * ELLIPSE_INSCRIBED, bh = h * ELLIPSE_INSCRIBED;
      return rect((w - bw) / 2, (h - bh) / 2, bw, bh);
    }
    case "diamond": return rect(w / 4, h / 4, w / 2, h / 2);
    case "triangle": return rect(w / 4, h / 2, w / 2, h / 2 - NODE_PAD);
    default: throw new Error(`visual_node: no content box for shape ${JSON.stringify(shape)}`);
  }
}

/**
 * Pure function. Where a NON-CARD label is drawn: one caption line across the top
 * of the content box. Null when the node has no label, or when the label is the
 * card's title strip (drawn from visualHeaderPathD instead).
 *
 * THE CAPTION DOES NOT PUSH THE TEXT DOWN (user, 2026-08-21, on a labelled
 * chamfered block: "the text is not vertically centered"). The first version
 * carved the caption's line off the top of the text box, so a middle-aligned
 * text centred in what was LEFT — visibly below the shape's centre. The text box
 * is the whole content box, the caption sits at its top edge, and the two only
 * meet when the text is tall enough to fill the box — which is the honest overlap
 * of two things the author put in one shape, not a layout rule hiding one of them.
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}|null}
 *
 * @example visualLabelBox({shape: "diamond", w: 200, h: 100, label: "Decide"}) // {x: 50, y: 25, w: 100, h: 14.399999999999999}
 * @example visualLabelBox({shape: "diamond", w: 200, h: 100, label: ""}) // null
 * @example visualLabelBox({shape: "card", w: 200, h: 100, label: "Osc"}) // null (the strip)
 */
export function visualLabelBox(s) {
  if (visualLabelIsEmpty(s) || visualShapeOf(s) === "card") return null;
  const box = visualContentBox(s);
  return { x: box.x, y: box.y, w: box.w, h: textLineH(NODE_TITLE_SIZE) };
}

/**
 * Pure function. THE TEXT BOX — where the body text is laid out, and therefore
 * where the in-place editor edits it (the plugin's `inlineTextEdit.box`). It IS
 * the content box, whether or not a caption sits at its top (see visualLabelBox
 * for why the caption takes nothing off it), so `valign: middle` centres the text
 * on the SHAPE.
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}} LOCAL
 *
 * @example visualNodeTextBox({shape: "diamond", w: 200, h: 100}) // {x: 50, y: 25, w: 100, h: 50}
 * @example // a labeled diamond's text is still centred on the diamond
 * @example visualNodeTextBox({shape: "diamond", w: 200, h: 100, label: "Decide"}).y // 25
 * @example visualNodeTextBox({shape: "card", w: 180, h: 110, label: "Osc"}) // {x: 10, y: 38, w: 160, h: 62}
 */
export function visualNodeTextBox(s) {
  return visualContentBox(s);
}

/** Pure function. Is the body text blank — nothing to draw?
 *  @example visualTextIsEmpty({text: ""}) // true
 *  @example visualTextIsEmpty({text: 0}) // false (a bound number renders as "0")
 *  @example visualTextIsEmpty({}) // true */
export function visualTextIsEmpty(s) {
  const t = s?.text;
  return t === null || t === undefined || String(t).trim() === "";
}

// Re-exported so the plugin and the tests read the sampled bead halo from one
// place when they reason about how far a bead reaches past the outline.
export { NODE_CORNER_R, PORT_BEAD_R };
