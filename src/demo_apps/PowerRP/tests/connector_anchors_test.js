/**
 * Connector ANCHORS (todo #233) — bare node, no framework (suite conventions:
 * core_test.js / endpoints_test.js).
 *
 * THE DEFECT THIS PINS. The five connectors — arrow, line, curved_arrow,
 * elbow_arrow, fancy_arrow — published NO anchors at all, so `@edge_mid.x` was
 * an error and a mid-edge label had literally nothing to bind to. Five of the
 * only seven registered plugins declaring none were these. The workaround in the
 * field was the chord midpoint `= (@e.from.x + @e.to.x) / 2`, which is exact for
 * a straight arrow and WRONG for both curved widgets — measured below, so the
 * regression this file guards against is not hypothetical.
 *
 * Two halves, matching the two ways an anchor is consumed:
 *   1. the plugin `anchors(state)` hook itself (geometry), and
 *   2. the EQUATION REFERENCE GRAMMAR round-trip (`@<slug>_<anchorId>.x`), which
 *      is what actually makes a label bindable and which imposes the
 *      no-underscore rule on every id.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { deriveRenderTree, nodeAnchors } from "../core/derive.js";
import { evaluateState, resolveRef, slugMap, displayToStored } from "../core/expressions.js";
import { rectPlugin } from "../plugins/rect.js";
import {
  CONNECTOR_PATH_ANCHORS, connectorPathAnchors, polylineLength, walkPolyline, pointAtPolylineFraction,
} from "../core/endpoints.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** Every widget whose geometry is a PATH between two endpoints. DERIVED from the
 *  roster (the plugins spreading the endpoint-pair hooks) rather than listed, so
 *  a widget added later is swept here on the day it is registered rather than
 *  when someone remembers — the hand-maintained-mirror defect this codebase keeps
 *  rediscovering. */
const ENDPOINT_PAIR = registry.all().filter((p) => p.editPoints && p.moveBy && p.closestToward);

/** The endpoint-pair widgets that deliberately publish NO path anchors, each with
 *  the reason. Kept as a ONE-ENTRY gate rather than dropped from the sweep: a new
 *  connector arriving without anchors must turn this file red so its author has
 *  to decide, instead of silently joining the five-of-seven-plugins-with-none
 *  population this task exists to shrink. */
const ANCHORLESS_BY_DESIGN = {
  corkboardYarn: "a sagging quadratic whose control point is its own; sampling it needs a generator this task did not touch (W4-G hand-back)",
};

const CONNECTORS = ENDPOINT_PAIR.filter((p) => !(p.type in ANCHORLESS_BY_DESIGN));

test("premise: every endpoint-pair widget either publishes path anchors or is declared anchorless", () => {
  // brace_curly / brace_square joined on 2026-08-02 — THREE-point connectors, so
  // they spread the same endpoint hooks with a three-key list and are swept here
  // by the derivation above, which is this gate working exactly as its docblock
  // promises. Both publish anchors (start / tip / end), so neither needs an
  // ANCHORLESS_BY_DESIGN entry.
  assert.deepEqual(CONNECTORS.map((p) => p.type).sort(),
    ["arrow", "brace_curly", "brace_square", "curved_arrow", "elbow_arrow", "fancy_arrow", "line"]);
  for (const p of ENDPOINT_PAIR)
    assert.equal(typeof p.anchors === "function", !(p.type in ANCHORLESS_BY_DESIGN),
      `${p.type}: an endpoint-pair widget must publish path anchors or be listed in ANCHORLESS_BY_DESIGN with a reason`);
  // A stale exception is as bad as a missing one.
  for (const type of Object.keys(ANCHORLESS_BY_DESIGN))
    assert.ok(ENDPOINT_PAIR.some((p) => p.type === type), `ANCHORLESS_BY_DESIGN names "${type}", which is not an endpoint-pair widget`);
});

// ── the arc-length primitives ───────────────────────────────────────────────

test("polylineLength / walkPolyline / pointAtPolylineFraction: one traversal, three readings", () => {
  const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.equal(polylineLength(L), 20);
  assert.deepEqual(walkPolyline(L, 15), { point: { x: 10, y: 5 }, index: 1 });
  assert.deepEqual(pointAtPolylineFraction(L, 0.5), { x: 10, y: 0 });
  // Clamping, not running off the end — an over-long trim collapses.
  assert.deepEqual(walkPolyline(L, 999).point, { x: 10, y: 10 });
});

test("pointAtPolylineFraction: a degenerate zero-length path answers, it does not divide by zero", () => {
  assert.deepEqual(pointAtPolylineFraction([{ x: 4, y: 7 }, { x: 4, y: 7 }], 0.5), { x: 4, y: 7 });
});

// ── every connector publishes the three, on its own ink ─────────────────────

test("every connector publishes exactly the three path anchors", () => {
  for (const p of CONNECTORS)
    assert.deepEqual(p.anchors(p.defaults).map((a) => a.id), CONNECTOR_PATH_ANCHORS.map((a) => a.id), p.type);
});

test("no connector anchor id contains an underscore (the equation grammar splits on one)", () => {
  // plugins/bento.js's docblock: the ref head splits on its LAST "_", so an id
  // carrying one is unreferenceable. Silent if unenforced — the id simply never
  // resolves — which is why it is a gate and not a comment.
  for (const p of CONNECTORS)
    for (const a of p.anchors(p.defaults))
      assert.equal(a.id.includes("_"), false, `${p.type}: "${a.id}"`);
});

test("start and end sit ON the endpoints, for every connector", () => {
  // Tolerant, deliberately: the curved arrow's path is a SAMPLED bezier, so its
  // t=1 sample reaches `to` through the bezier polynomial and lands a few ulps
  // away. An exact comparison here would pin float noise, not the contract.
  const near = (a, b, what) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  for (const p of CONNECTORS) {
    const s = { ...p.defaults, from: { x: 30, y: 40 }, to: { x: 230, y: 140 } };
    const by = Object.fromEntries(p.anchors(s).map((a) => [a.id, a]));
    near(by.start, s.from, `${p.type} start`);
    near(by.end, s.to, `${p.type} end`);
  }
});

test("MID IS BY ARC LENGTH, and for a curve that is not the chord midpoint", () => {
  // THE MEASUREMENT that motivates the whole feature. The chord midpoint is the
  // workaround this replaces; for a bend of 0.5 over a 200-span it misses the
  // drawn curve by bend*span/2 = 50 world px along the normal.
  const curved = registry.get("curved_arrow");
  const s = { ...curved.defaults, from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, bend: 0.5 };
  const mid = curved.anchors(s).find((a) => a.id === "mid");
  const chordMid = { x: (s.from.x + s.to.x) / 2, y: (s.from.y + s.to.y) / 2 };
  assert.ok(Math.abs(mid.x - chordMid.x) < 1e-6, "the error is purely along the normal");
  assert.ok(Math.abs(mid.y - 50) < 1, `expected ~50px off the chord, got ${mid.y}`);
  // And a STRAIGHT curved arrow agrees with the chord exactly, so the anchor is a
  // generalization of the workaround rather than a different answer.
  const straight = curved.anchors({ ...s, bend: 0 }).find((a) => a.id === "mid");
  assert.ok(Math.abs(straight.x - 100) < 1e-9 && Math.abs(straight.y) < 1e-9);
});

test("an elbow route's MID lands on the MIDDLE leg, not in the bounding box's empty centre", () => {
  // An H-V-H route hugs two sides of its own AABB, so the box centre is a point
  // the connector never passes through. This is why these are path anchors and
  // not the standard nine over an ink rect.
  const elbow = registry.get("elbow_arrow");
  const s = { ...elbow.defaults, from: { x: 0, y: 0 }, to: { x: 200, y: 100 }, elbow: 0.5, orient: "hvh", bulge: 0 };
  const mid = elbow.anchors(s).find((a) => a.id === "mid");
  assert.deepEqual([mid.x, mid.y], [100, 50], "the midpoint of the vertical middle leg");
});

test("the anchors track the geometry: moving an endpoint moves mid", () => {
  const arrow = registry.get("arrow");
  const a = arrow.anchors({ ...arrow.defaults, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } });
  const b = arrow.anchors({ ...arrow.defaults, from: { x: 0, y: 0 }, to: { x: 300, y: 0 } });
  assert.equal(a.find((x) => x.id === "mid").x, 50);
  assert.equal(b.find((x) => x.id === "mid").x, 150);
});

test("connectorPathAnchors is pure and shared — the five hooks are one function, not five copies", () => {
  const straight = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const expected = connectorPathAnchors(straight);
  for (const type of ["arrow", "line", "fancy_arrow"]) {
    const p = registry.get(type);
    assert.deepEqual(p.anchors({ ...p.defaults, from: straight[0], to: straight[1] }), expected, type);
  }
});

// ── the end-to-end win: a label BINDS to a connector's midpoint ─────────────

test("THE FEATURE: a label's x/y bind to an arrow's mid through the equation grammar", () => {
  const arrow = registry.get("arrow");
  const edge = { ...arrow.defaults, from: { x: 0, y: 0 }, to: { x: 200, y: 100 }, active: true };
  const state0 = { items: { ab12cd34: edge } };
  const slugs = slugMap(state0);
  const slug = slugs.toSlug.get("ab12cd34");
  assert.deepEqual(resolveRef(`${slug}_mid.x`, slugs), { kind: "anchor", itemId: "ab12cd34", anchorId: "mid", coord: "x" });

  const state = { items: {
    ab12cd34: edge,
    lbl: { ...rectPlugin.defaults, x: displayToStored(`${slug}_mid.x`, state0), y: displayToStored(`${slug}_mid.y`, state0), w: 20, h: 20, z: 1, active: true },
  } };
  const ev = evaluateState(state, registry);
  assert.equal(ev.errors.size, 0, [...ev.errors.values()].join("; "));
  assert.equal(ev.state.items.lbl.x, 100);
  assert.equal(ev.state.items.lbl.y, 50);

  // nodeAnchors (the WORLD-space reading the canvas overlay draws) agrees with
  // the equation's answer — the two entrances to the anchor map cannot disagree.
  const node = deriveRenderTree(ev.state, registry).find((n) => n.id === "ab12cd34");
  const world = nodeAnchors(node).find((a) => a.id === "mid");
  assert.deepEqual([world.x, world.y], [100, 50]);
});

test("THE FEATURE, curved: the bound label follows the CURVE, not the chord", () => {
  const curved = registry.get("curved_arrow");
  const edge = { ...curved.defaults, from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, bend: 0.5, active: true };
  const state0 = { items: { cc11dd22: edge } };
  const slug = slugMap(state0).toSlug.get("cc11dd22");
  const state = { items: {
    cc11dd22: edge,
    lbl: { ...rectPlugin.defaults, y: displayToStored(`${slug}_mid.y`, state0), x: 0, w: 20, h: 20, z: 1, active: true },
  } };
  const ev = evaluateState(state, registry);
  assert.equal(ev.errors.size, 0, [...ev.errors.values()].join("; "));
  assert.ok(Math.abs(ev.state.items.lbl.y - 50) < 1, `the label rides the arc, got y=${ev.state.items.lbl.y}`);
});

// ── the self loop: a primitive we had and could not reach (todo #233) ───────

test("add-self-loop: gated on a box selection, and it says why", () => {
  const cmd = registry.get("elbow_arrow").commands.find((c) => c.id === "add-self-loop");
  assert.ok(cmd, "the command must exist");
  assert.equal(cmd.when({ selectedNode: () => ({ plugin: registry.get("rect") }) }), true);
  assert.equal(cmd.when({ selectedNode: () => ({ plugin: registry.get("arrow") }) }), false, "a connector is not a box to loop around");
  assert.equal(cmd.when({ selectedNode: () => null }), false);
  assert.equal(typeof cmd.requires, "string", "a selection-gated command must say what it needs");
});

test("add-self-loop: every field is an EQUATION, so the loop tracks the box", () => {
  const cmd = registry.get("elbow_arrow").commands.find((c) => c.id === "add-self-loop");
  let added = null;
  cmd.run({ selectedNode: () => ({ itemId: "box1" }), addItem: (state) => { added = state; } });
  for (const v of [added.from.x, added.from.y, added.to.x, added.to.y, added.bulge])
    assert.equal(typeof v, "string", "a literal here would freeze the loop where the box happened to be");

  // It EVALUATES, against a real box, to mermaid's own self-loop depth.
  const box = { ...rectPlugin.defaults, x: 0, y: 0, w: 100, h: 60, active: true };
  const ev = evaluateState({ items: { box1: box, loop: { ...added, z: 2, active: true } } }, registry);
  assert.equal(ev.errors.size, 0, [...ev.errors.values()].join("; "));
  const loop = ev.state.items.loop;
  assert.equal(loop.bulge, 27, "clamp(min(w, h) * 0.45, 24, 48) — mermaid's depth formula, verbatim");
  assert.deepEqual([loop.from.x, loop.from.y], [100, 0], "the box's tr corner");
  assert.deepEqual([loop.to.x, loop.to.y], [100, 60], "the box's br corner — the whole right edge");

  // And it is a REAL loop: out one side, along, and back into the same side.
  const anchors = registry.get("elbow_arrow").anchors(loop);
  assert.ok(anchors.find((a) => a.id === "mid").x > 100, "the mid of the route bulges clear of the box");

  // The clamp bites at both ends rather than scaling forever.
  const tiny = evaluateState({ items: { box1: { ...box, w: 10, h: 10 }, loop: { ...added, z: 2, active: true } } }, registry);
  assert.equal(tiny.state.items.loop.bulge, 24, "below the floor a loop reads as a kink");
  const huge = evaluateState({ items: { box1: { ...box, w: 900, h: 900 }, loop: { ...added, z: 2, active: true } } }, registry);
  assert.equal(huge.state.items.loop.bulge, 48, "above the ceiling it dwarfs its own box");
});

console.log(`\n${passed} connector-anchor tests passed`);
