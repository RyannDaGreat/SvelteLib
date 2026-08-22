/**
 * ROUTING POINT — bare-node tests for the lone connector and the pass-through
 * protocol it introduced.
 * Run: node src/demo_apps/PowerRP/tests/route_node_test.js
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *   THE WIDGET: one input, one output, both of its own `portType` and colour; the
 *     ports on the disc's left and right edge (not the card column); ONE painted
 *     op (the dot, no beads); the rim on the disc.
 *   THE PASS-THROUGH: a value crosses a joint — and a CHAIN of joints — unchanged,
 *     so the evaluator needs to know nothing about them; and the three consumers
 *     that walk `inputs` themselves (the audio mirror, the live-control router,
 *     the clip router) resolve back THROUGH one, which is what stops a tidied
 *     audio patch from going silent and a button behind a joint from firing
 *     nowhere.
 *   THE GESTURE: which wire a world point lands on (measured on the DRAWN path,
 *     so a bezier is not confused with its chord), and what inserting a joint
 *     writes — including into a `multiple` input, where the joint takes the
 *     interrupted wire's PLACE and the other wires do not move.
 */

import assert from "node:assert/strict";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import {
  PORT_TYPES, declaredPorts, evaluateNodeGraph, inputRefs, portColor, portLayout, resolvedWireSource,
} from "../core/nodeflow.js";
import { deriveWires } from "../core/derive.js";
import { routeInsertPairs, wireAt } from "../core/wire_drag.js";
import { readAudioScene } from "../core/audio_mirror_diff.js";
import { triggerRoutes } from "../core/live_control.js";
import { clipPlaybackKind } from "../core/clip_playback.js";
import { routeState } from "../web/routeInsert.js";
import { placeRoutePorts, routePortType, routePorts } from "../plugins/route_node.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);
const plugin = registry.get("route_node");
const IDENT = { x: 0, y: 0, rotation: 0, scale: 1 };
/** A routing point state: the plugin's defaults with overrides. */
const rn = (over = {}) => ({ ...plugin.defaults, type: "route_node", ...over });

console.log("routing point: the widget");

check("it is a node widget: one input, one output, both its own type and colour", () => {
  const ports = declaredPorts(plugin, rn({ portType: "number", color: "#12ab34" }));
  assert.deepStrictEqual(ports.inputs.map((p) => p.key), ["in"]);
  assert.deepStrictEqual(ports.outputs.map((p) => p.key), ["out"]);
  for (const p of [...ports.inputs, ...ports.outputs]) {
    assert.strictEqual(p.type, "number");
    assert.strictEqual(p.color, "#12ab34");
    assert.strictEqual(p.label, "", "a 16-unit dot has no room for a label, and portBeads draws none for a blank one");
  }
  // A state naming no type, or one that no longer exists, falls back rather than
  // throwing at declaredPorts (which refuses an unknown port type).
  assert.strictEqual(routePortType({}), "visual");
  assert.strictEqual(routePortType({ portType: "nonsense" }), "visual");
  assert.strictEqual(routePorts({}).inputs[0].color, portColor("visual"));
  assert.ok(PORT_TYPES[plugin.defaults.portType], "the default type is a real one");
});

check("the ports sit on the disc's left and right edge, not in the card column", () => {
  const s = rn({ w: 16, h: 16 });
  assert.deepStrictEqual(portLayout(plugin, s).map((r) => [r.key, r.x, r.y]), [["in", 0, 8], ["out", 16, 8]]);
  // A FLIP is a reflection, not a negative box (the NEGATIVE EXTENTS contract).
  assert.deepStrictEqual(placeRoutePorts({ w: -16, h: -16 }, [{ key: "in", side: "input", x: 0, y: 34 }]),
    [{ key: "in", side: "input", x: 0, y: 8 }]);
});

check("it paints ONE op — the dot — and no port beads", () => {
  const ops = plugin.emit(rn({ color: "#ff8800" }), null, IDENT);
  assert.strictEqual(ops.length, 1, `the disc alone (got ${ops.map((o) => o.op).join(", ")})`);
  assert.strictEqual(ops[0].op, "ellipse");
  assert.deepStrictEqual(ops[0].fill.slice(0, 3).map((c) => Math.round(c * 255)), [0xff, 0x88, 0x00]);
});

check("the rim is the DISC's, so an arrow bound to a joint lands on the dot", () => {
  const s = rn({ w: 16, h: 16 });
  const p = plugin.closestAnchor(s, 100, 8, IDENT);
  assert.ok(Math.abs(Math.hypot(p.x - 8, p.y - 8) - 8) < 1e-9, `on the circle of radius 8 (got ${JSON.stringify(p)})`);
});

console.log("routing point: the pass-through");

check("a value crosses a joint — and a chain of them — unchanged", () => {
  const num = registry.get("node_number"), disp = registry.get("node_display");
  const items = {
    a: { ...num.defaults, type: "node_number", value: 7 },
    r1: rn({ portType: "number", inputs: { in: { item: "a", port: "out" } } }),
    r2: rn({ portType: "number", inputs: { in: { item: "r1", port: "out" } } }),
    d: { ...disp.defaults, type: "node_display", inputs: { in: { item: "r2", port: "out" } } },
  };
  assert.strictEqual(evaluateNodeGraph(items, registry).values.d.inputs.in, 7, "the display behind two joints reads what it would behind none");
  // The joint SPLITS by being a node: a second destination on the same output.
  items.d2 = { ...disp.defaults, type: "node_display", inputs: { in: { item: "r1", port: "out" } } };
  const ev = evaluateNodeGraph(items, registry);
  assert.strictEqual(ev.values.d2.inputs.in, 7);
  assert.strictEqual(ev.values.d.inputs.in, 7, "…and the first destination is untouched by the second");
});

check("resolvedWireSource walks back through joints, stops at an unwired one, and survives a hand-edited cycle", () => {
  const items = {
    a: { type: "node_number" },
    r1: rn({ inputs: { in: { item: "a", port: "out" } } }),
    r2: rn({ inputs: { in: { item: "r1", port: "out" } } }),
    bare: rn({}),
  };
  assert.deepStrictEqual(resolvedWireSource(items, registry, { item: "r2", port: "out" }), { item: "a", port: "out" });
  assert.deepStrictEqual(resolvedWireSource(items, registry, { item: "bare", port: "out" }), { item: "bare", port: "out" },
    "an unwired joint is its own source — nothing flows in, so nothing flows out");
  assert.deepStrictEqual(resolvedWireSource(items, registry, { item: "a", port: "out" }), { item: "a", port: "out" },
    "an ordinary source is its own answer, so a joint-free document is untouched");
  const cyc = { x: rn({ inputs: { in: { item: "y", port: "out" } } }), y: rn({ inputs: { in: { item: "x", port: "out" } } }) };
  assert.deepStrictEqual(resolvedWireSource(cyc, registry, { item: "x", port: "out" }), { item: "x", port: "out" },
    "a cycle the editor refuses but a hand edit can write must not hang the walk");
});

check("AN AUDIO PATCH TIDIED WITH A JOINT STILL MAKES THE ENGINE WIRE", () => {
  const osc = "audio_oscillator", out = "audio_output";
  const wired = {
    o: { ...registry.get(osc).defaults, type: osc },
    t: { ...registry.get(out).defaults, type: out, inputs: { in: { item: "o", port: "out" } } },
  };
  const direct = readAudioScene(wired, registry).connections;
  assert.strictEqual(direct.length, 1, "the control: a direct cable is one engine connection");
  const jointed = {
    o: wired.o,
    r: rn({ portType: "audio", inputs: { in: { item: "o", port: "out" } } }),
    t: { ...registry.get(out).defaults, type: out, inputs: { in: { item: "r", port: "out" } } },
  };
  const through = readAudioScene(jointed, registry).connections;
  assert.deepStrictEqual(through, direct, "the SAME engine connection — a joint is a layout decision, not a cut cable");
});

check("a live PRESS and a clip TRIGGER both see through a joint", () => {
  const ding = registry.get("audio_ding");
  const items = {
    b: { ...registry.get("node_button").defaults, type: "node_button" },
    r: rn({ portType: "trigger", inputs: { in: { item: "b", port: "out" } } }),
    d: { ...ding.defaults, type: "audio_ding", inputs: { gate: { item: "r", port: "out" } } },
  };
  const routes = triggerRoutes(items, registry, "b");
  assert.deepStrictEqual(routes.map((r) => [r.op, r.id, r.port]), [["trigger", "d", "gate"]],
    "the press reaches the module behind the joint");
  // …and the clip router's classification, which decides whether a deck EXPORTS
  // its sound, must not be fooled into calling a Button-driven clip "timeline".
  const clip = registry.get("node_midi_clip");
  const clipItems = {
    b: items.b,
    r: rn({ portType: "trigger", inputs: { in: { item: "b", port: "out" } } }),
    c: { ...clip.defaults, type: "node_midi_clip", inputs: { trigger: { item: "r", port: "out" } } },
  };
  assert.strictEqual(clipPlaybackKind(clipItems, registry, "c"), "live",
    "a Button behind a joint is still a Button — the export warning must not be lost with the cable's shape");
});

console.log("routing point: the gesture");

/** A source and a destination 400 apart, wired, as derived render nodes. */
const patch = (style) => {
  const num = registry.get("node_number"), disp = registry.get("node_display");
  const cam = registry.get("camera");
  return [
    { itemId: "cam", type: "camera", state: { ...cam.defaults, ...(style ? { wireStyle: style } : {}) }, plugin: cam, world: IDENT },
    { itemId: "a", type: "node_number", state: { ...num.defaults, type: "node_number" }, plugin: num, world: IDENT },
    { itemId: "b", type: "node_display", state: { ...disp.defaults, type: "node_display", inputs: { in: { item: "a", port: "out" } } }, plugin: disp, world: { ...IDENT, x: 400, y: 200 } },
  ];
};

check("wireAt measures the DRAWN path, so a bezier is not confused with its chord", () => {
  const wires = deriveWires(patch());
  assert.strictEqual(wires.length, 1);
  const { from, to } = wires[0];
  // The cubic wirePathD draws, sampled at t. AT t = 1/2 THE TWO COINCIDE and that
  // is not a coincidence: the control points are pushed out by the same reach from
  // each end, so they are symmetric about the chord's midpoint and the curve passes
  // through it. A test written at the midpoint would prove nothing about which of
  // the two this function measures — so it is written at t = 1/4, where a cable
  // that leaves its bead HORIZONTALLY has already departed the straight line.
  const reach = Math.min(160, (to.x - from.x) / 2);
  const at = (t) => {
    const [p0, c1, c2, p3] = [[from.x, from.y], [from.x + reach, from.y], [to.x - reach, to.y], [to.x, to.y]];
    const u = 1 - t;
    const w = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3];
    return { x: w[0] * p0[0] + w[1] * c1[0] + w[2] * c2[0] + w[3] * p3[0], y: w[0] * p0[1] + w[1] * c1[1] + w[2] * c2[1] + w[3] * p3[1] };
  };
  const T = 0.25;
  const onCurve = at(T);
  const onChord = { x: from.x + T * (to.x - from.x), y: from.y + T * (to.y - from.y) };
  assert.ok(Math.hypot(onCurve.x - onChord.x, onCurve.y - onChord.y) > 15, "the fixture really does separate the two");
  assert.ok(wireAt(wires, onCurve.x, onCurve.y, 3), "a point on the DRAWN cable is grabbed");
  assert.strictEqual(wireAt(wires, onChord.x, onChord.y, 3), null, "…and the same fraction along the CHORD is not");
  assert.strictEqual(wireAt(wires, onCurve.x, onCurve.y + 400, 3), null, "far off it, nothing is grabbed");
  assert.strictEqual(wireAt([], 0, 0, 10), null);
});

check("wireAt follows a STRAIGHT and an ELBOW deck too", () => {
  for (const style of ["straight", "elbow"]) {
    const wires = deriveWires(patch(style));
    assert.strictEqual(wires[0].style, style);
    const { from, to } = wires[0];
    const onIt = style === "straight"
      ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }   // the chord IS the cable
      : { x: (from.x + to.x) / 2, y: from.y };               // the elbow's first leg
    assert.ok(wireAt(wires, onIt.x, onIt.y, 3), `${style}: a point on the drawn cable is grabbed`);
  }
});

check("inserting writes the destination onto the joint — and into a `multiple` input, in the interrupted wire's PLACE", () => {
  const wire = { from: { item: "a", port: "o" }, to: { item: "b", port: "i" } };
  assert.deepStrictEqual(routeInsertPairs({ b: { inputs: { i: { item: "a", port: "o" } } } }, wire, "R"),
    [[["items", "b", "inputs", "i"], { item: "R", port: "out" }]]);
  const multi = { b: { inputs: { mix: [{ item: "z", port: "o" }, { item: "a", port: "o" }, { item: "c", port: "o" }] } } };
  const [[, slot]] = routeInsertPairs(multi, { from: { item: "a", port: "o" }, to: { item: "b", port: "mix" } }, "R");
  assert.deepStrictEqual(slot, [{ item: "z", port: "o" }, { item: "R", port: "out" }, { item: "c", port: "o" }],
    "the other two wires did not move");
  assert.deepStrictEqual(inputRefs({ inputs: { mix: slot } }, "mix").length, 3);
});

check("the joint inherits the cable: its type, its colour, and the incoming wire already plugged in", () => {
  const wires = deriveWires(patch());
  const s = routeState(wires[0], 200, 60, 5);
  assert.strictEqual(s.portType, "number");
  assert.strictEqual(s.color, portColor("number"), "no colour on the wire ⇒ the type's own");
  assert.deepStrictEqual(s.inputs, { in: { item: "a", port: "out" } });
  assert.strictEqual(s.z, 5);
  assert.strictEqual(s.x, 200 - plugin.defaults.w / 2, "the box is centred on the drop point");
  assert.strictEqual(s.y, 60 - plugin.defaults.h / 2);
  // A wire whose SOURCE port declared its own colour hands it to the joint, so the
  // dot disappears into the cable rather than announcing its type.
  assert.strictEqual(routeState({ ...wires[0], color: "#ff8800" }, 0, 0, 1).color, "#ff8800");
});

console.log(`\nrouting point: ${passed} checks passed`);
