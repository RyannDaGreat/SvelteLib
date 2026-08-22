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
  PORT_TYPES, connectionRefusal, connectionsOf, declaredPorts, detachPairs, evaluateNodeGraph,
  findPort, inputRefs, inputWires, isNodeWidget, nodeInputRows, portAt, portColorOf, portLayout, portTypeCssVars, wirePairsFor,
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

check("the text box is INSIDE every silhouette, and a label's caption sits above it", () => {
  for (const shape of VISUAL_SHAPES) {
    const s = vn({ shape, w: 200, h: 120, label: "Lbl", inPorts: [port("a")], outPorts: [port("o")] });
    const box = visualNodeTextBox(s);
    const outline = visualNodeOutline(shape, 200, 120, 10, "round");
    for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]])
      assert.ok(pointInPolygon(outline, x, y) || shape === "card", `${shape}: text box corner (${x}, ${y}) is outside the shape`);
    const lb = visualLabelBox(s);
    if (shape === "card") assert.strictEqual(lb, null, "a card's label is its strip, not a caption");
    else assert.ok(lb && lb.y + lb.h <= box.y, `${shape}: the caption overlaps the text box`);
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
  const src = vn({ outPorts: [port("o", "#12ab34")] });
  const dst = vn({ inPorts: [port("i", "#000000")] , inputs: { in0: { item: "a", port: "out0" } } });
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

check("a malformed port colour is refused at the declaration, not at the painter", () => {
  assert.throws(() => declaredPorts(plugin, vn({ inPorts: [{ label: "a", color: "red" }] })), /hex literal/);
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

check("NO shipped non-visual port declares `multiple` or `color` — every existing document reads as before", () => {
  for (const p of registry.all()) {
    if (p.type === "visual_node" || typeof p.ports !== "function") continue;
    const ports = declaredPorts(p, p.defaults);
    for (const q of [...ports.inputs, ...ports.outputs]) {
      assert.ok(!q.multiple, `${p.type}.${q.key} declares multiple`);
      assert.ok(!("color" in q), `${p.type}.${q.key} declares a colour`);
    }
  }
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

console.log(`\nvisual node: ${passed} checks passed`);
