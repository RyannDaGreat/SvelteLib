/**
 * LIGHT-POSITION EYEDROPPER (web/lightPositionPin.js) — the write, in BARE NODE.
 *
 * THE FEATURE IS ONE SENTENCE: pin a lens flare's / god rays' light to another
 * item's center, MOVE (or drag) that item, and the light followed — because the
 * write is two live equations, not a coordinate snapshot. Everything else here is
 * the boundary conditions: self-pick refusal, a no-box target refusal, the camera
 * being ALLOWED (no special case), ONE undo unit, and the mode's registration
 * (so the HintBar/Escape wiring the brief requires exists).
 *
 * Runs with `node tests/light_pin_test.js` — no browser, no Vite.
 */

import assert from "node:assert";
import * as T from "../core/transform.js";
import { createRegistry } from "../core/registry.js";
import { builtinRoster, registerPlugins } from "../plugins/index.js";
import { newDocument, withNewItem, keyframed, foldState, itemFallbackName } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import {
  centerPinExpr, centerPinPairs, currentHoverId, lightPinRefusal, mergedOverlay,
  nodeBoxMarks, LIGHT_PIN_PAIR, LIGHT_POSITION_PIN_HANDLER,
} from "../web/lightPositionPin.js";
import { LIGHT_KEYS, lightPinnable } from "../core/registry.js";
import { canvasModes, handlerIds } from "../web/widget_handlers.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

const registry = createRegistry();
registerPlugins(registry); // both halves of the roster
const flarePlugin = registry.get("demo_lens_flare");
const godRaysPlugin = registry.get("demo_god_rays");
const cameraPlugin = registry.get("camera");

/** Query. A fresh document holding a flare and a "sun" rect. */
function docWithFlareAndSun() {
  let doc = newDocument();
  let flareId, sunId;
  [doc, flareId] = withNewItem(doc, 0, { ...flarePlugin.defaults, x: 0, y: 0, w: 200, h: 200, active: true });
  [doc, sunId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, x: 500, y: 300, w: 40, h: 20, active: true });
  return { doc, flareId, sunId };
}

/** Query. Live derived nodes for slide 0 (what app.nodes() returns). */
function liveNodes(doc) {
  return deriveRenderTree(evaluateState(foldState(doc, 0, 1), registry).state, registry);
}

/** Command. A minimal app stand-in recording what the handler asked for — the
 *  bento_bind_test.js fakeApp precedent, extended with exitCanvasMode. */
function fakeApp(nodes) {
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  return {
    nodes: () => nodes, previews: [], commits: 0, exits: 0,
    displayName(id) {
      const n = byId.get(id);
      if (!n) return id;
      return n.state.name ?? itemFallbackName(registry.get(n.state.type).title, id);
    },
    setPreview(pairs) { this.previews.push(pairs); },
    commitPreview() { this.commits++; },
    exitCanvasMode() { this.exits++; },
  };
}

// ── the pure write ────────────────────────────────────────────────────────────

test("centerPinExpr: the @id.cx / @id.cy reference form, not a slug string", () => {
  assert.equal(centerPinExpr("ab12cd34", "cx"), "@ab12cd34.cx");
  assert.equal(centerPinExpr("ab12cd34", "cy"), "@ab12cd34.cy");
});

test("centerPinPairs: BOTH axes, by item id, in one array (one undo unit)", () => {
  assert.deepEqual(
    centerPinPairs("flare1", { xKey: "lightWorldX", yKey: "lightWorldY" }, "sun1"),
    [
      [["items", "flare1", "lightWorldX"], "@sun1.cx"],
      [["items", "flare1", "lightWorldY"], "@sun1.cy"],
    ],
  );
});

test("the pairs land on NUMERIC slots, so the bare string IS the equation (no leading '=' needed)", () => {
  // lightWorldX/Y default to "self.anchors...." — a legacy numeric slot per
  // core/expressions.js isNumericSlot, same as x/y and bind-to-camera's writes.
  for (const plugin of [flarePlugin, godRaysPlugin]) {
    assert.equal(typeof plugin.defaults.lightWorldX, "string");
    assert.ok(plugin.defaults.lightWorldX.startsWith("self."));
  }
});

test("lightPinnable gates on the DEFAULTS, so both widgets qualify and a rect does not", () => {
  // Manifest R6-4.5: the tool is offered by core/registry.js's structural
  // predicate over LIGHT_KEYS, NOT by a `pinLight` aspect a plugin had to
  // declare on one of its rows. Neither plugin says anything about the pin now.
  assert.ok(lightPinnable(flarePlugin));
  assert.ok(lightPinnable(godRaysPlugin));
  assert.equal(lightPinnable(registry.get("rect")), false);
  for (const plugin of [flarePlugin, godRaysPlugin])
    assert.ok(!(plugin.inspector ?? []).some((row) => row.pinLight),
      `${plugin.type} still declares a pinLight row aspect — the tool reads defaults now, and a leftover aspect is a second, silent declaration`);
});

test("the keys the tool is OFFERED for are the keys it WRITES (no second list)", () => {
  assert.deepEqual([LIGHT_PIN_PAIR.xKey, LIGHT_PIN_PAIR.yKey], LIGHT_KEYS);
});

test("the tool REACHES the Tools pane, on the two lit widgets and nowhere else", () => {
  // toolGroupsOf is ToolsPane's entire input, so this is where "the tool is
  // offered" is decided. It rides the EXISTING `transform` group rather than
  // opening a group of its own — a widget with one light tool and no camera-bind
  // pair would be a section of one, and the pool's whole point is that a tool that
  // writes coordinates lives beside the other tools that write coordinates.
  // `registry.get()` returns the REGISTERED form, which already carries its
  // resolved `toolGroups` — re-running toolGroupsOf on it would re-resolve an
  // already-resolved plugin and trip the pool's own malformed-row gate on the
  // preset groups it has since gained.
  const commandsIn = (type) =>
    (registry.get(type).toolGroups.find((g) => g.id === "transform")?.rows ?? []).map((r) => r.command);
  for (const type of ["demo_lens_flare", "demo_god_rays"]) {
    // MEMBERSHIP, not the whole array. This used to pin the section's exact
    // contents, which made it fail the next time ANY tool joined Transform —
    // a gate that reports an unrelated addition as a light-pin regression costs
    // more than it protects. Both halves of the real claim are still here: the
    // pin is offered on a lit widget, and it is withheld from one with no light.
    assert.ok(commandsIn(type).includes("pin-light-to-object"), `${type}: not offered the light pin`);
    assert.ok(commandsIn(type).includes("bind-to-camera"),
      `${type}: no camera-bind row — the section would be vacuous and this test would pass for the wrong reason`);
  }
  assert.ok(!commandsIn("rect").includes("pin-light-to-object"),
    "a rect has no light position, so the pool's applies() must withhold the tool entirely");
  assert.ok(commandsIn("rect").includes("bind-to-camera"), "a rect DOES have a Transform section to withhold it from");
});

// ── refusals ──────────────────────────────────────────────────────────────────

test("REFUSED: the widget cannot pin its own light to itself", () => {
  const node = { itemId: "f1", plugin: { defaults: {} } };
  const refusal = lightPinRefusal(node, "f1", "Lens Flare");
  assert.ok(refusal && /cannot pin its own light to itself/.test(refusal), refusal);
});

test("REFUSED: a target with no box (no w/h) has no center to pin to", () => {
  const arrow = { itemId: "a1", plugin: { type: "arrow", title: "Arrow", defaults: { from: {}, to: {} } } };
  const refusal = lightPinRefusal(arrow, "f1", "Lens Flare");
  assert.ok(refusal && /has no box/.test(refusal), refusal);
});

test("ALLOWED: an ordinary bbox item, and the CAMERA — no special case, it just has w/h", () => {
  assert.equal(lightPinRefusal({ itemId: "sun1", plugin: { defaults: { x: 0, y: 0, w: 10, h: 10 } } }, "f1", "Lens Flare"), null);
  assert.equal(cameraPlugin.capabilities.purgeable, false, "the camera IS structural...");
  assert.equal(typeof cameraPlugin.defaults.w, "number", "...but it has a box, which is the ONLY gate this feature reads");
  assert.equal(lightPinRefusal({ itemId: "camera1", plugin: cameraPlugin }, "f1", "Lens Flare"), null);
});

// ── THE FEATURE: pinned, the flare's light equals the target's WORLD center ──

test("THE FEATURE: pinned, evaluateState resolves the light to the target's box center", () => {
  const { doc, flareId, sunId } = docWithFlareAndSun();
  let out = doc;
  for (const [path, value] of centerPinPairs(flareId, LIGHT_PIN_PAIR, sunId))
    out = keyframed(out, 0, path, value);
  const { state, errors } = evaluateState(foldState(out, 0, 1), registry);
  assert.equal(errors.size, 0, `expression errors: ${[...errors.values()].join("; ")}`);
  // sun at (500, 300), 40x20 → center (520, 310).
  assert.equal(state.items[flareId].lightWorldX, 520);
  assert.equal(state.items[flareId].lightWorldY, 310);
});

test("THE LIVE-PIN PROOF: dragging the target moves the resolved light with it", () => {
  const { doc, flareId, sunId } = docWithFlareAndSun();
  let pinned = doc;
  for (const [path, value] of centerPinPairs(flareId, LIGHT_PIN_PAIR, sunId))
    pinned = keyframed(pinned, 0, path, value);
  const before = evaluateState(foldState(pinned, 0, 1), registry).state;
  assert.equal(before.items[flareId].lightWorldX, 520);

  // "Drag" the sun: keyframe a new x/y on the SAME slide (what a canvas drag commits).
  const dragged = keyframed(keyframed(pinned, 0, ["items", sunId, "x"], 700), 0, ["items", sunId, "y"], 300);
  const after = evaluateState(foldState(dragged, 0, 1), registry).state;
  assert.equal(after.items[flareId].lightWorldX, 720, "the light tracked the drag");
  assert.equal(after.items[flareId].lightWorldY, 310);
});

test("clearing the equation un-pins that axis (an ordinary literal write)", () => {
  const { doc, flareId, sunId } = docWithFlareAndSun();
  let pinned = doc;
  for (const [path, value] of centerPinPairs(flareId, LIGHT_PIN_PAIR, sunId))
    pinned = keyframed(pinned, 0, path, value);
  const unpinnedX = keyframed(pinned, 0, ["items", flareId, "lightWorldX"], 42);
  const state = evaluateState(foldState(unpinnedX, 0, 1), registry).state;
  assert.equal(state.items[flareId].lightWorldX, 42, "X is a plain number again");
  assert.equal(state.items[flareId].lightWorldY, 310, "Y is still pinned");
});

// ── the mode: registration, hover, and the pick gesture ──────────────────────

test("the mode is REGISTERED (activate phase) — the standing rule: unregistered means it does not exist", () => {
  assert.ok(handlerIds("activate").includes("pin_light_position"));
  const mode = canvasModes().find((m) => m.handlerId === "pin_light_position");
  assert.ok(mode, "pin_light_position must appear in canvasModes() for the HintBar/Escape wiring");
  assert.equal(mode.phase, "activate");
  assert.deepEqual(mode.steps, [], "a one-shot pick is not a step sequence");
  assert.ok(mode.hints.some((h) => /click/i.test(h.label)), "the click gesture is narrated");
});

test("mergedOverlay / nodeBoxMarks: a plain (unrotated, unscaled) box's world outline", () => {
  const identity = (x, y) => ({ x, y });
  const marks = nodeBoxMarks(identity, { w: 10, h: 20 }, true);
  assert.deepEqual(marks.chains, [{ points: [[0, 0], [10, 0], [10, 20], [0, 20]], closed: true }]);
  assert.deepEqual(mergedOverlay([marks, marks]).chains.length, 2);
});

test("nodeBoxMarks is rotation-safe: a 90° rotation swaps which axis grows", () => {
  const rotated = { x: 0, y: 0, rotation: Math.PI / 2, scale: 1 };
  const marks = nodeBoxMarks((x, y) => T.apply(rotated, x, y), { w: 10, h: 20 }, true);
  // Local (10, 0) — the box's own +x corner — rotates to world (0, 10).
  const [, corner10x0] = marks.chains[0].points;
  assert.ok(Math.abs(corner10x0[0] - 0) < 1e-9 && Math.abs(corner10x0[1] - 10) < 1e-9, corner10x0);
});

test("THE GESTURE: hover stages a candidate, pick writes ONE undo unit and exits", () => {
  const { doc, flareId, sunId } = docWithFlareAndSun();
  const nodes = liveNodes(doc);
  const flareNode = nodes.find((n) => n.itemId === flareId);
  const sunNode = nodes.find((n) => n.itemId === sunId);
  const app = fakeApp(nodes);
  const ctx = { app, node: flareNode, plugin: flarePlugin };
  const { onHover, onHoverLeave, onPick, overlay } = LIGHT_POSITION_PIN_HANDLER.mode;

  // HOVER over the sun stages it; hovering the flare itself (or nothing) does not.
  assert.equal(onHover(ctx, { node: sunNode }), true, "candidate changed");
  assert.equal(currentHoverId(), sunId);
  assert.equal(onHover(ctx, { node: sunNode }), false, "same candidate — no repaint needed");
  assert.equal(onHover(ctx, { node: flareNode }), true);
  assert.equal(currentHoverId(), null, "the pinner itself is never a candidate");
  assert.equal(onHoverLeave(), false, "already null");

  onHover(ctx, { node: sunNode });
  assert.equal(overlay(ctx).chains.length, 2, "the flare's own box plus the hovered target's");

  // PICK the sun: writes both equations as ONE setPreview, commits once, exits the mode.
  onPick(ctx, { node: sunNode });
  assert.equal(app.previews.length, 1, "ONE setPreview → ONE undo unit");
  assert.equal(app.commits, 1);
  assert.equal(app.exits, 1, "the mode always exits after a completed pick");
  assert.deepEqual(app.previews[0], centerPinPairs(flareId, LIGHT_PIN_PAIR, sunId));
  assert.equal(currentHoverId(), null, "the hover candidate is spent");
});

test("PICK EMPTY CANVAS: cancels quietly — no write, one exit", () => {
  const { doc, flareId } = docWithFlareAndSun();
  const nodes = liveNodes(doc);
  const flareNode = nodes.find((n) => n.itemId === flareId);
  const app = fakeApp(nodes);
  const ctx = { app, node: flareNode, plugin: flarePlugin };
  LIGHT_POSITION_PIN_HANDLER.mode.onPick(ctx, { node: null });
  assert.deepEqual(app.previews, []);
  assert.equal(app.commits, 0);
  assert.equal(app.exits, 1);
});

test("PICK SELF: refused — no write, one exit, nothing left aimed", () => {
  const { doc, flareId } = docWithFlareAndSun();
  const nodes = liveNodes(doc);
  const flareNode = nodes.find((n) => n.itemId === flareId);
  const app = fakeApp(nodes);
  const ctx = { app, node: flareNode, plugin: flarePlugin };
  LIGHT_POSITION_PIN_HANDLER.mode.onPick(ctx, { node: flareNode });
  assert.deepEqual(app.previews, []);
  assert.equal(app.commits, 0);
  assert.equal(app.exits, 1);
});

test("PICK NO-BOX TARGET (arrow): refused — no write", () => {
  let doc = newDocument();
  let flareId, arrowId;
  [doc, flareId] = withNewItem(doc, 0, { ...flarePlugin.defaults, x: 0, y: 0, w: 200, h: 200, active: true });
  [doc, arrowId] = withNewItem(doc, 0, { ...registry.get("arrow").defaults, from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, active: true });
  const nodes = liveNodes(doc);
  const flareNode = nodes.find((n) => n.itemId === flareId);
  const arrowNode = nodes.find((n) => n.itemId === arrowId);
  const app = fakeApp(nodes);
  const ctx = { app, node: flareNode, plugin: flarePlugin };
  LIGHT_POSITION_PIN_HANDLER.mode.onPick(ctx, { node: arrowNode });
  assert.deepEqual(app.previews, []);
  assert.equal(app.exits, 1);
});

test("god_rays gets the identical write shape as lens_flare (same property family)", () => {
  let doc = newDocument();
  let godRaysId, sunId;
  [doc, godRaysId] = withNewItem(doc, 0, { ...godRaysPlugin.defaults, x: 0, y: 0, w: 200, h: 200, active: true });
  [doc, sunId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, x: 500, y: 300, w: 40, h: 20, active: true });
  const nodes = liveNodes(doc);
  const godRaysNode = nodes.find((n) => n.itemId === godRaysId);
  const sunNode = nodes.find((n) => n.itemId === sunId);
  const app = fakeApp(nodes);
  const ctx = { app, node: godRaysNode, plugin: godRaysPlugin };
  LIGHT_POSITION_PIN_HANDLER.mode.onPick(ctx, { node: sunNode });
  assert.deepEqual(app.previews[0], [
    [["items", godRaysId, "lightWorldX"], `@${sunId}.cx`],
    [["items", godRaysId, "lightWorldY"], `@${sunId}.cy`],
  ]);
});

console.log(`\n${passed} tests passed`);
