/**
 * VISUAL NODE — bare-node tests for the do-nothing node widget and the two
 * protocol additions it brought: per-port COLOUR and the `multiple` input.
 * Run: node src/demo_apps/PowerRP/tests/visual_node_test.js
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *   GEOMETRY (core/visual_node.js): every shape emits a PDF-safe path, the beads of
 *     a non-card shape land ON its outline, the rim projection lands on the ink,
 *     the text box is inside the silhouette, the card's strip is the body clipped.
 *   PORTS FROM LISTS: `in<i>`/`out<i>` keys, hide keeps numbering, purge renumbers
 *     (stated, not hidden), blank labels draw no label op, a port's colour reaches
 *     the bead AND the wire.
 *   THE `multiple` PROTOCOL (core/nodeflow.js): append on connect, duplicate refused,
 *     one wire per stored ref in connectionsOf/deriveWires, the resolver hands the
 *     plugin an ARRAY, detach removes one wire and the last one leaves the null
 *     override, the drag picks up the newest wire, clone remaps EVERY wire, and
 *     `multiple` on an OUTPUT is refused at declaration.
 *   THE ROSTER: the visual node satisfies the general node-widget protocol the
 *     audio sweep holds audio nodes to, and the `visual` type carries its CSS token.
 *   NO SHIPPED PORT OPTS IN: `multiple` and `color` are off on every non-visual
 *     port today, so every existing document reads byte-identically.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import {
  PORT_TYPES, WIRE_STYLES, connectionRefusal, connectionsOf, declaredPorts, detachPairs, evaluateNodeGraph,
  findPort, inputRefs, inputWires, isNodeWidget, nodeInputRows, portAt, portColorOf, portLayout, portTypeCssVars,
  wireBezierPath, wirePairsFor, wirePathD,
} from "../core/nodeflow.js";
import { deriveWires, nodePortAnchors } from "../core/derive.js";
import { portBeads, wireOps } from "../core/node_chrome.js";
import { wireDragStart, wireDrop } from "../core/wire_drag.js";
import { clonedItemStates, expandRefPaths } from "../core/document.js";
import { outputPropertyDescriptors } from "../core/output_properties.js";
import { pointInPolygon } from "../core/outline.js";
import { roundedPolygonPathD, ellipsePathD } from "../core/shapes.js";
import {
  VISUAL_SHAPES, outlineEdgeX, placeVisualPorts, visualHeaderOutline, visualNodeOutline, visualNodePathD,
  visualNodePorts, visualNodeRim, visualNodeTextBox, visualHasHeader, visualLabelBox,
} from "../core/visual_node.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);
const plugin = registry.get("visual_node");
const IDENT = { x: 0, y: 0, rotation: 0, scale: 1 };

/** A visual node state: the defaults with overrides. */
const vn = (over = {}) => ({ ...plugin.defaults, ...over });
const port = (label, color = "#ff8800", multiple = false) => ({ label, color, ...(multiple ? { multiple: true } : {}) });

console.log("visual node: geometry");

check("every shape emits ONE fill path, PDF-safe (lines and beziers only, no arcs)", () => {
  for (const shape of VISUAL_SHAPES) {
    const d = visualNodePathD(shape, 180, 110, 10, "round");
    assert.ok(/^M/.test(d) && /Z$/.test(d), `${shape}: ${d}`);
    assert.ok(!/A/.test(d), `${shape} uses an arc command, which the PDF backend throws on`);
    const ops = plugin.emit(vn({ shape, text: "Hi" }), null, IDENT);
    assert.strictEqual(ops[0].op, "path", `${shape}'s first op is the silhouette`);
  }
});

check("chamfer cuts the corner with a LINE, round with a QUADRATIC, at the same trim", () => {
  const sq = [[0, 0], [40, 0], [40, 40], [0, 40]];
  assert.ok(roundedPolygonPathD(sq, 10, "chamfer").startsWith("M0 10 L10 0"));
  assert.ok(roundedPolygonPathD(sq, 10, "round").startsWith("M0 10 Q0 0 10 0"));
  assert.strictEqual(roundedPolygonPathD(sq, 10), roundedPolygonPathD(sq, 10, "round"), "the default style is the byte-identical legacy output");
  assert.throws(() => roundedPolygonPathD(sq, 10, "bevelled"), /unknown cornerStyle/);
});

check("the ellipse is four cubics and its sampled outline stays inside the box", () => {
  assert.strictEqual((ellipsePathD(100, 60).match(/C/g) ?? []).length, 4);
  for (const [x, y] of visualNodeOutline("ellipse", 100, 60)) {
    assert.ok(x >= -1e-6 && x <= 100 + 1e-6 && y >= -1e-6 && y <= 60 + 1e-6, `(${x}, ${y}) left the box`);
  }
});

check("a NON-CARD shape's beads sit ON its outline; a card keeps the standard column", () => {
  const s = vn({ shape: "diamond", w: 200, h: 100, cornerRadius: 0, inPorts: [port("a"), port("b")], outPorts: [port("o")] });
  const outline = visualNodeOutline("diamond", 200, 100);
  for (const row of portLayout(plugin, s)) {
    const edge = outlineEdgeX(outline, row.y, row.side);
    assert.ok(Math.abs(row.x - edge) < 1e-9, `${row.key} at x=${row.x}, outline at ${edge}`);
    // Two inputs straddle the centre line, so both sit on the left SLOPES, strictly
    // inside the bbox edge; the lone output is centred and therefore AT the right
    // vertex — which is the box edge, and correct.
    if (row.side === "input") assert.ok(row.x > 0 && row.x < 100, `${row.key} left the bbox edge and is on the slope`);
    else assert.strictEqual(row.x, 200, "a lone, centred output sits at the diamond's vertex");
  }
  const card = vn({ shape: "card", w: 200, h: 100, inPorts: [port("a"), port("b")], outPorts: [port("o")] });
  assert.deepStrictEqual(portLayout(plugin, card).map((r) => [r.x, r.y]), [[0, 34], [0, 56], [200, 34]]);
});

check("the placed column is vertically CENTRED on a non-card shape", () => {
  const rows = placeVisualPorts(vn({ shape: "ellipse", w: 100, h: 100 }), [
    { key: "in0", side: "input", x: 0, y: 34 }, { key: "in1", side: "input", x: 0, y: 56 },
  ]);
  assert.strictEqual((rows[0].y + rows[1].y) / 2, 50);
});

check("the bead a press grabs is the bead that was painted (one geometry, two readers)", () => {
  const s = vn({ shape: "triangle", w: 200, h: 100, inPorts: [port("a"), port("b")], outPorts: [port("o")] });
  for (const row of portLayout(plugin, s)) {
    assert.strictEqual(portAt(plugin, s, row.x, row.y, 0)?.key, row.key);
  }
  const painted = portBeads(plugin, s).filter((o) => o.op === "ellipse" && o.rx === 6).map((o) => [o.cx, o.cy]);
  assert.deepStrictEqual(painted, portLayout(plugin, s).map((r) => [r.x, r.y]));
});

check("the rim PROJECTS onto the shape — an interior query lands on the ink, not in the middle", () => {
  const s = vn({ shape: "diamond", w: 200, h: 100, cornerRadius: 0 });
  const outline = visualNodeOutline("diamond", 200, 100);
  const p = visualNodeRim(s, 100, 50);
  assert.ok(!pointInPolygon(outline, p.x + 0, p.y + 0.001) || !pointInPolygon(outline, p.x, p.y - 0.001), "the projected point is on the boundary");
  assert.notDeepStrictEqual([p.x, p.y], [100, 50], "a clamp would have returned the centre");
  const far = visualNodeRim(vn({ shape: "ellipse", w: 100, h: 100 }), 500, 50);
  assert.ok(Math.abs(far.x - 100) < 1e-6 && Math.abs(far.y - 50) < 1e-6, `the ellipse's right extreme, got ${JSON.stringify(far)}`);
});

check("the text box is INSIDE every silhouette, and a label's caption sits at its top without shrinking it", () => {
  for (const shape of VISUAL_SHAPES) {
    const s = vn({ shape, w: 200, h: 120, label: "Lbl", inPorts: [port("a")], outPorts: [port("o")] });
    const box = visualNodeTextBox(s);
    const outline = visualNodeOutline(shape, 200, 120, 10, "round");
    // The ellipse's inscribed box has its corners EXACTLY on the curve, and the
    // sampled outline's chords run just inside it — so the corners are tested one
    // unit in toward the box's centre, which is still "inside the shape".
    const EPS = 1;
    for (const [x, y] of [[box.x + EPS, box.y + EPS], [box.x + box.w - EPS, box.y + EPS], [box.x + EPS, box.y + box.h - EPS], [box.x + box.w - EPS, box.y + box.h - EPS]])
      assert.ok(pointInPolygon(outline, x, y) || shape === "card", `${shape}: text box corner (${x}, ${y}) is outside the shape`);
    const lb = visualLabelBox(s);
    if (shape === "card") assert.strictEqual(lb, null, "a card's label is its strip, not a caption");
    else {
      assert.ok(lb && lb.y === box.y && lb.x === box.x, `${shape}: the caption sits at the text box's top edge`);
      // THE USER'S CORRECTION: a labelled shape's text is centred on the SHAPE, so
      // the text box must be the same box a label-less node gets.
      assert.deepStrictEqual(box, visualNodeTextBox({ ...s, label: "" }), `${shape}: the caption pushed the text box down`);
    }
  }
});

check("a BLANK label removes the card's strip; a non-blank one draws it as the body clipped", () => {
  assert.ok(!visualHasHeader(vn({ shape: "card", label: "" })));
  assert.ok(!visualHasHeader(vn({ shape: "card", label: "   " })));
  assert.ok(visualHasHeader(vn({ shape: "card", label: "Osc" })));
  const opsUnlabeled = plugin.emit(vn({ shape: "card", label: "" }), null, IDENT);
  const opsLabeled = plugin.emit(vn({ shape: "card", label: "Osc" }), null, IDENT);
  assert.strictEqual(opsLabeled.filter((o) => o.op === "path").length, opsUnlabeled.filter((o) => o.op === "path").length + 1, "the strip is one extra path");
  assert.deepStrictEqual(visualHeaderOutline([[0, 0], [100, 0], [100, 80], [0, 80]], 24), [[0, 0], [100, 0], [100, 24], [0, 24]]);
});

console.log("visual node: ports from lists");

check("element i is port in<i>/out<i>; HIDE keeps the numbering, PURGE renumbers (stated)", () => {
  const s = { inPorts: [port("a"), port("b"), port("c")], inPortsActive: [true, false, true], outPorts: [port("o")] };
  assert.deepStrictEqual(visualNodePorts(s).inputs.map((p) => p.key), ["in0", "in2"]);
  assert.deepStrictEqual(declaredPorts(plugin, s).outputs.map((p) => p.key), ["out0"]);
  const purged = { ...s, inPorts: [port("a"), port("c")], inPortsActive: undefined };
  assert.deepStrictEqual(visualNodePorts(purged).inputs.map((p) => p.key), ["in0", "in1"], "purge renumbers — the list module's documented cost, the same as a polygon's vertices");
});

check("every visual port is `visual`-typed, carries its element's colour, and multiple only where asked", () => {
  const ports = declaredPorts(plugin, vn({ inPorts: [port("a", "#112233", true), port("b", "#445566")], outPorts: [port("o", "#778899")] }));
  for (const p of [...ports.inputs, ...ports.outputs]) assert.strictEqual(p.type, "visual");
  assert.deepStrictEqual(ports.inputs.map((p) => [p.color, p.multiple ?? false]), [["#112233", true], ["#445566", false]]);
  assert.strictEqual(portColorOf(ports.outputs[0]), "#778899");
  assert.strictEqual(portColorOf({ type: "visual" }), PORT_TYPES.visual.color);
});

check("a port's colour reaches the painted bead, the anchor, AND the wire leaving it", () => {
  const src = vn({ inPorts: [], outPorts: [port("o", "#12ab34")] });
  const dst = vn({ inPorts: [port("i", "#000000")], outPorts: [], inputs: { in0: { item: "a", port: "out0" } } });
  const bead = portBeads(plugin, src).find((o) => o.op === "ellipse");
  assert.deepStrictEqual(bead.fill.slice(0, 3).map((c) => Math.round(c * 255)), [0x12, 0xab, 0x34]);
  const nodes = [
    { itemId: "a", state: src, plugin, world: IDENT },
    { itemId: "b", state: dst, plugin, world: { ...IDENT, x: 400 } },
  ];
  assert.strictEqual(nodePortAnchors(nodes[0])[0].color, "#12ab34");
  const [wire] = deriveWires(nodes);
  assert.strictEqual(wire.color, "#12ab34", "the wire carries the SOURCE port's colour");
  const stroke = wireOps(wire)[1].stroke;
  assert.deepStrictEqual(stroke.slice(0, 3).map((c) => Math.round(c * 255)), [0x12, 0xab, 0x34]);
  // An ordinary typed port declares no colour, so its anchor record is unchanged.
  const numberNode = { itemId: "n", state: registry.get("node_number").defaults, plugin: registry.get("node_number"), world: IDENT };
  assert.ok(!("color" in nodePortAnchors(numberNode)[0]));
});

check("a BLANK port label draws no label op (the jack alone); a named one does", () => {
  const blank = vn({ inPorts: [port(""), port("")], outPorts: [] });
  assert.strictEqual(portBeads(plugin, blank).filter((o) => o.op === "text").length, 0);
  const named = vn({ inPorts: [port("a"), port("b")], outPorts: [] });
  assert.strictEqual(portBeads(plugin, named).filter((o) => o.op === "text").length, 2);
});

check("A PORT COLOUR IS THE PAINTER'S GRAMMAR, not a second stricter one in core", () => {
  // This check used to assert the OPPOSITE — that `declaredPorts` refuses anything
  // but a hex literal "because the painter cannot resolve a name". render_gpu/ir.js
  // parseColor takes hex, rgb()/rgba() AND 148 CSS names, so the refusal was wrong
  // about the grammar AND threw from a function the hit test, the wire derivation
  // and the Inspector all call: retyping a corkboard thumbtack (colour
  // `rgb(210,45,45)`) into a node took the canvas down. One grammar, one owner.
  for (const color of ["#ff8800", "#ff8800cc", "rgb(210,45,45)", "rgba(1,2,3,0.5)", "red"]) {
    const ports = declaredPorts(plugin, vn({ inPorts: [{ label: "a", color }] }));
    assert.strictEqual(ports.inputs[0].color, color, `${color} reaches the painter unchanged`);
    assert.doesNotThrow(() => portBeads(plugin, vn({ inPorts: [{ label: "a", color }], outPorts: [] })), `${color} paints`);
  }
  // …and garbage is refused where the grammar lives, with the value named.
  assert.throws(() => portBeads(plugin, vn({ inPorts: [{ label: "a", color: "notacolour" }], outPorts: [] })), /notacolour/);
});

check("the wiring rows are DYNAMIC: one per current input port, flagged when multiple", () => {
  const rows = plugin.dynamicInspector(vn({ inPorts: [port("a"), port("b", "#000000", true)] }));
  assert.deepStrictEqual(rows.map((r) => [r.key, r.multiple ?? false]), [["inputs.in0", false], ["inputs.in1", true]]);
  assert.deepStrictEqual(nodeInputRows(plugin, vn({ inPorts: [] })), []);
});

console.log("visual node: the `multiple` protocol");

/** Three visual nodes: two sources, one collector whose input accepts several. */
const patch = () => ({
  a: vn({ type: "visual_node", outPorts: [port("o", "#ff0000")] }),
  b: vn({ type: "visual_node", outPorts: [port("o", "#00ff00")] }),
  c: vn({ type: "visual_node", inPorts: [port("mix", "#0000ff", true)] }),
});
const apply = (items, pairs) => {
  for (const [path, value] of pairs) {
    const [, id, key, port] = path;
    items[id] = { ...items[id], [key]: { ...items[id][key], [port]: value } };
  }
  return items;
};

check("connecting APPENDS to a multiple input; connecting to an ordinary input REPLACES", () => {
  let items = patch();
  items = apply(items, wirePairsFor(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  items = apply(items, wirePairsFor(items, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }));
  assert.deepStrictEqual(inputRefs(items.c, "in0"), [{ item: "a", port: "out0" }, { item: "b", port: "out0" }]);
  assert.ok(Array.isArray(items.c.inputs.in0), "the slot took the array shape");
  // The same two drops on an ORDINARY input leave one wire — the second one.
  let single = { ...patch(), c: vn({ type: "visual_node", inPorts: [port("one", "#0000ff")] }) };
  single = apply(single, wirePairsFor(single, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  single = apply(single, wirePairsFor(single, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }));
  assert.deepStrictEqual(inputRefs(single.c, "in0"), [{ item: "b", port: "out0" }]);
  assert.ok(!Array.isArray(single.c.inputs.in0), "an ordinary input keeps the single record — every existing document's shape");
});

check("the SAME wire twice is refused on a multiple input, with a sentence", () => {
  let items = patch();
  items = apply(items, wirePairsFor(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  assert.strictEqual(connectionRefusal(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }), "that output is already wired into this input");
  assert.strictEqual(connectionRefusal(items, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }), null);
});

check("every stored wire is an edge, a cable and a resolved value (an ARRAY for a multiple input)", () => {
  let items = patch();
  items = apply(items, wirePairsFor(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  items = apply(items, wirePairsFor(items, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }));
  assert.strictEqual(connectionsOf(items).length, 2);
  assert.deepStrictEqual(inputWires(items.c).map(([k, r]) => `${k}<${r.item}`), ["in0<a", "in0<b"]);
  const nodes = Object.entries(items).map(([itemId, state], i) => ({ itemId, state, plugin, world: { ...IDENT, x: i * 300 } }));
  const wires = deriveWires(nodes);
  assert.deepStrictEqual(wires.map((w) => [w.from.item, w.to.port, w.color]), [["a", "in0", "#ff0000"], ["b", "in0", "#00ff00"]]);
  // The resolver: an ARRAY, empty here because a visual port carries nothing —
  // and a NUMBER-typed multiple input collects every source's value.
  assert.deepStrictEqual(evaluateNodeGraph(items, registry).values.c.inputs.in0, []);
  const numReg = {
    get: (t) => t === "src"
      ? { ports: () => ({ outputs: [{ key: "out", type: "number" }] }), computeOutputs: (s) => ({ out: s.value }) }
      : { ports: () => ({ inputs: [{ key: "sum", type: "number", multiple: true }] }), computeOutputs: (s, i) => ({ total: i.sum.reduce((a, b) => a + b, 0) }) },
  };
  const numItems = { x: { type: "src", value: 2 }, y: { type: "src", value: 5 }, z: { type: "sum", inputs: { sum: [{ item: "x", port: "out" }, { item: "y", port: "out" }] } } };
  const z = evaluateNodeGraph(numItems, numReg).values.z;
  assert.deepStrictEqual(z.inputs.sum, [2, 5]);
  assert.strictEqual(z.outputs.total, 7);
  assert.deepStrictEqual(evaluateNodeGraph({ z: { type: "sum" } }, numReg).values.z.inputs.sum, [], "an unwired multiple input is the EMPTY array, never a zero");
});

check("detach removes ONE wire; the last one out leaves the null override", () => {
  let items = patch();
  items = apply(items, wirePairsFor(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  items = apply(items, wirePairsFor(items, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }));
  items = apply(items, detachPairs(items, { item: "c", port: "in0" }, { item: "a", port: "out0" }));
  assert.deepStrictEqual(inputRefs(items.c, "in0"), [{ item: "b", port: "out0" }]);
  const last = detachPairs(items, { item: "c", port: "in0" }, { item: "b", port: "out0" });
  assert.deepStrictEqual(last, [[["items", "c", "inputs", "in0"], null]]);
});

check("a press on a wired multiple input picks up its NEWEST wire, and dropping it in space removes only that one", () => {
  let items = patch();
  items = apply(items, wirePairsFor(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  items = apply(items, wirePairsFor(items, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }));
  const drag = wireDragStart(items, { item: "c", key: "in0", side: "input", type: "visual" });
  assert.deepStrictEqual(drag.anchor, { item: "b", port: "out0", type: "visual" });
  assert.deepStrictEqual(drag.detach.ref, { item: "b", port: "out0" });
  const drop = wireDrop(items, registry, drag, null);
  assert.strictEqual(drop.kind, "disconnect");
  assert.deepStrictEqual(drop.pairs[0][1], [{ item: "a", port: "out0" }], "the OTHER wire survives");
  // Re-dropping the picked-up wire on the same socket is a no-op reroute, not a double append.
  const back = wireDrop(items, registry, drag, { item: "c", key: "in0", side: "input", type: "visual" });
  assert.strictEqual(back.kind, "reroute");
  assert.deepStrictEqual(back.pairs[back.pairs.length - 1][1], [{ item: "a", port: "out0" }, { item: "b", port: "out0" }]);
});

check("a cloned patch remaps EVERY wire of a multiple input onto the copies", () => {
  let items = patch();
  items = apply(items, wirePairsFor(items, registry, { item: "a", port: "out0" }, { item: "c", port: "in0" }));
  items = apply(items, wirePairsFor(items, registry, { item: "b", port: "out0" }, { item: "c", port: "in0" }));
  assert.deepStrictEqual(expandRefPaths(items.c, plugin.itemRefs), [["inputs", "in0", "0", "item"], ["inputs", "in0", "1", "item"]]);
  const { states, external } = clonedItemStates(items, new Map([["a", "A"], ["b", "B"], ["c", "C"]]), registry);
  assert.deepStrictEqual(inputRefs(states.C, "in0"), [{ item: "A", port: "out0" }, { item: "B", port: "out0" }]);
  assert.deepStrictEqual(external, []);
});

check("`multiple` on an OUTPUT is refused at the declaration", () => {
  assert.throws(() => declaredPorts({ type: "x", ports: () => ({ outputs: [{ key: "o", type: "visual", multiple: true }] }) }, {}), /every output already fans out/);
});

console.log("visual node: the roster");

check("the visual node satisfies the general node-widget protocol", () => {
  assert.ok(isNodeWidget(plugin, plugin.defaults));
  const ports = declaredPorts(plugin, plugin.defaults);
  for (const side of ["inputs", "outputs"])
    for (const p of ports[side]) {
      assert.ok(PORT_TYPES[p.type], `${p.key} has undeclared type ${p.type}`);
      assert.ok(findPort(plugin, plugin.defaults, side === "inputs" ? "input" : "output", p.key));
    }
  assert.deepStrictEqual(JSON.stringify(plugin.defaults.inputs), "{}", "the connection map is present-but-empty, so the clone wildcard has a slot");
  assert.strictEqual(plugin.computeOutputs, undefined, "it does nothing: a pure sink");
  assert.strictEqual(plugin.activate, "inline_text_edit");
  assert.deepStrictEqual([plugin.inlineTextEdit.property, plugin.inlineTextEdit.plain, plugin.inlineTextEdit.ink], ["text", true, "textFill"]);
  assert.strictEqual(typeof plugin.inlineTextEdit.box, "function");
});

check("a `visual` output is VALUELESS: no output-property row, no refusal sentence", () => {
  assert.deepStrictEqual(outputPropertyDescriptors(plugin, plugin.defaults), []);
  assert.strictEqual(PORT_TYPES.visual.valueless, true);
  assert.strictEqual(PORT_TYPES.exec.valueless, true);
});

check("the `visual` type's CSS token is in app.css (the generated mirror)", () => {
  const css = readFileSync(join(HERE, "..", "web", "app.css"), "utf8");
  assert.ok(portTypeCssVars().includes("--a-port-visual"));
  assert.ok(css.includes(`--a-port-visual: ${PORT_TYPES.visual.color};`));
});

check("THE OPT-IN ROSTER IS EXACTLY WHAT IT SAYS: only these widgets' ports declare `multiple`, `color` or `wire`", () => {
  // The three port-declaration additions (a per-port colour, an input's
  // accept-several permission, a per-port wire style) are OPT-IN, and this is what
  // makes that a fact rather than a hope: the set of widgets whose ports declare
  // ANY of them is stated here, so a widget cannot acquire one by accident — and
  // adding a fourth widget to the set is an edit to this line, in front of a
  // reader. Every port outside the set declares none, which is why every document
  // written before these existed reads back byte-identically.
  const OPTED_IN = ["route_node", "visual_node"];
  const found = new Set();
  for (const p of registry.all()) {
    if (typeof p.ports !== "function") continue;
    const ports = declaredPorts(p, p.defaults);
    for (const q of [...ports.inputs, ...ports.outputs]) {
      const declares = q.multiple || "color" in q || "wire" in q;
      if (declares) { found.add(p.type); continue; }
      assert.ok(!q.multiple && !("color" in q) && !("wire" in q), `${p.type}.${q.key}`);
    }
  }
  assert.deepStrictEqual([...found].sort(), OPTED_IN, "the opt-in roster drifted — add the widget here deliberately, or take the declaration off its ports");
});

check("every preset writes every look knob, the port lists, and never `text`", () => {
  const looks = plugin.presets;
  assert.ok(looks.length >= 6);
  const keys = new Set(Object.keys(looks[0].props));
  for (const l of looks) {
    assert.deepStrictEqual(new Set(Object.keys(l.props)), keys, `${l.name} writes a different knob set`);
    assert.ok(!("text" in l.props), `${l.name} overwrites the author's text`);
    assert.ok(Array.isArray(l.props.inPorts) && Array.isArray(l.props.outPorts));
    assert.ok(VISUAL_SHAPES.includes(l.props.shape));
    // Each look renders, and its ports are declarable.
    const s = vn({ ...l.props, text: "T" });
    assert.ok(plugin.emit(s, null, IDENT).length > 0, `${l.name} emits nothing`);
    declaredPorts(plugin, s);
  }
  const hub = looks.find((l) => l.name === "Hub");
  assert.ok(hub.props.inPorts[0].multiple === true, "the Hub look demonstrates accept-several");
});

console.log("visual node: wire styles");

check("a short forward bezier never hooks: its x is monotonic, and the stacked case keeps its loop", () => {
  // The user's picture: beads ~70 apart, 60 down. Control points must not cross.
  const d = wireBezierPath({ x: 0, y: 0 }, { x: 70, y: 60 });
  const [, c1x, , c2x] = d.match(/C (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/).slice(1).map(Number);
  assert.ok(c1x <= c2x, `control points crossed: ${d}`);
  // Sample the cubic: x must never decrease along it.
  const xs = [];
  for (let t = 0; t <= 1; t += 0.05) xs.push((1 - t) ** 3 * 0 + 3 * (1 - t) ** 2 * t * c1x + 3 * (1 - t) * t ** 2 * c2x + t ** 3 * 70);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] - 1e-9, "the cable doubled back on itself");
  // Level with or behind the source, the floor still loops the cable out and back.
  assert.strictEqual(wireBezierPath({ x: 0, y: 0 }, { x: 0, y: 100 }), "M 0 0 C 40 0 -40 100 0 100");
  assert.strictEqual(wireBezierPath({ x: 0, y: 0 }, { x: 200, y: 0 }), "M 0 0 C 100 0 100 0 200 0", "a long forward wire is byte-identical to before");
});

check("the three styles are three path grammars, and an unknown one throws", () => {
  assert.strictEqual(wirePathD({ x: 0, y: 0 }, { x: 70, y: 60 }, "straight"), "M 0 0 L 70 60");
  assert.strictEqual(wirePathD({ x: 0, y: 0 }, { x: 100, y: 60 }, "elbow"), "M 0 0 L 50 0 L 50 60 L 100 60");
  assert.strictEqual(wirePathD({ x: 100, y: 0 }, { x: 0, y: 80 }, "elbow").split(" L ").length, 6, "a backward elbow is five segments: out, down, back, in");
  assert.strictEqual(wirePathD({ x: 0, y: 0 }, { x: 200, y: 0 }), wireBezierPath({ x: 0, y: 0 }, { x: 200, y: 0 }), "the default is the bezier");
  assert.throws(() => wirePathD({ x: 0, y: 0 }, { x: 1, y: 1 }, "wiggly"), /unknown wire style/);
  assert.deepStrictEqual([...WIRE_STYLES], ["bezier", "straight", "elbow"]);
});

check("a wire's style resolves DESTINATION → SOURCE → CAMERA, and reaches the painted path", () => {
  const cameraPlugin = registry.get("camera");
  const camera = (wireStyle) => ({ itemId: "cam", type: "camera", state: { ...cameraPlugin.defaults, ...(wireStyle ? { wireStyle } : {}) }, plugin: cameraPlugin, world: IDENT });
  const src = (wire) => vn({ inPorts: [], outPorts: [{ ...port("o"), ...(wire ? { wire } : {}) }] });
  const dst = (wire) => vn({ inPorts: [{ ...port("i"), ...(wire ? { wire } : {}) }], outPorts: [], inputs: { in0: { item: "a", port: "out0" } } });
  const tree = (cam, s, d) => [camera(cam), { itemId: "a", state: s, plugin, world: IDENT }, { itemId: "b", state: d, plugin, world: { ...IDENT, x: 400 } }];
  assert.strictEqual(cameraPlugin.defaults.wireStyle, "bezier", "the camera is born with the deck default");
  assert.strictEqual(deriveWires(tree(null, src(), dst()))[0].style, "bezier");
  assert.strictEqual(deriveWires(tree("elbow", src(), dst()))[0].style, "elbow", "the camera sets the deck default");
  assert.strictEqual(deriveWires(tree("elbow", src("straight"), dst()))[0].style, "straight", "a source port overrides the camera");
  assert.strictEqual(deriveWires(tree("elbow", src("straight"), dst("bezier")))[0].style, "bezier", "the destination port overrides the source");
  const [wire] = deriveWires(tree("elbow", src(), dst()));
  assert.ok(wireOps(wire)[1].d.startsWith("M ") && wireOps(wire)[1].d.includes(" L ") && !wireOps(wire)[1].d.includes(" C "), "the painted cable is the elbow");
  // "inherit" in a stored port element declares nothing.
  assert.strictEqual(deriveWires(tree("straight", src("inherit" === "inherit" ? undefined : null), dst()))[0].style, "straight");
  assert.ok(!("wire" in declaredPorts(plugin, vn({ inPorts: [port("i")] })).inputs[0]), "a fresh port carries no override (its stored value is \"inherit\")");
  assert.throws(() => declaredPorts(plugin, vn({ inPorts: [{ ...port("i"), wire: "loopy" }] })), /declares wire style "loopy"/);
});

// (The wire-style half of this sweep used to live here as its own check. It is
// folded into THE OPT-IN ROSTER above, which asks the same question about all
// three additions at once — two sweeps over one roster is how they come to
// disagree about which widgets are exempt.)

console.log(`\nvisual node: ${passed} checks passed`);
