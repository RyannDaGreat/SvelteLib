/**
 * HANDOFF — intended destination: src/demo_apps/PowerRP/tests/angle_dial_test.js
 * (this agent does not own tests/, so it is parked here for the tests/ owner to
 * move verbatim; it passes as-is today.)
 *
 * THE MULTI-TURN INVARIANT guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/angle_dial_test.js
 *
 * WHY THIS EXISTS. Every real heading in the app is now a `kind: "angle"` row
 * edited by the rotary dial (web/AngleField.svelte). A dial reads an ABSOLUTE
 * pointer heading, which is only ever known modulo a full turn, so the obvious
 * implementation — write the pointer's heading — folds every value into
 * [0, 360). That silently DESTROYS DATA: the manifest requires the transform's
 * rotation to be "an unwrapped angle (deltas can spin 720°)", so a rotation
 * keyframed 0 → 720° must tween through TWO WHOLE SPINS; folding collapses it to
 * 0 → 0, an animation reduced to no rotation at all, with nothing to see in the
 * document but a plausible number.
 *
 * The dial therefore DRAWS wrapDegrees(v) but INTEGRATES shortestTurn() from the
 * previous value to decide what to WRITE. These tests pin that contract:
 *   (1) shortestTurn is a shortest-arc, congruent-mod-360 integrator;
 *   (2) replaying the dial's own press/move rule over a two-turn sweep commits
 *       720, not 0;
 *   (3) a 0 → 720° keyframe pair folds to a monotone rise past 360;
 *   (4) `rotation` still STORES RADIANS (the switch to kind "angle" migrated
 *       nothing) and every `angle` row's equation result still types as "number".
 */

import assert from "node:assert/strict";
import { shortestTurn, wrapDegrees, FULL_TURN_DEG, HALF_TURN_DEG, PROPS } from "../core/properties.js";
import { newDocument, keyframed, foldState, withNewItem, withNewSlide } from "../core/document.js";
import { evaluateState, resultKindForSlot } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster, registerPlugins } from "../plugins/index.js";

const roster = builtinRoster();

const registry = createRegistry();
registerPlugins(registry); // BOTH halves of the roster: source modules + the built-in plugin-asset library

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Degrees ↔ radians, local to the test (core stores rotation in radians).
const DEG_PER_RAD = 180 / Math.PI;
const toDegrees = (rad) => rad * DEG_PER_RAD;
const toRadians = (deg) => deg / DEG_PER_RAD;

/**
 * Pure function. Replays the dial's integrator (web/AngleField.svelte
 * integrateDrag): each step advances the value by the SHORTEST turn from the
 * pointer heading last seen. The press seeds `pointer` at the current value, so
 * one rule covers both the press (snap) and every move (sweep).
 *
 * @example replayDrag(0, [90]) // 90        (a press snaps to the pointer)
 * @example replayDrag(0, [180, 359]) // -1  (shortest arc, so it goes backwards)
 * @example replayDrag(350, [10]) // 370     (past the top KEEPS COUNTING)
 */
function replayDrag(startValue, pointerHeadings) {
  let value = startValue;
  let pointer = startValue;
  for (const heading of pointerHeadings) {
    value += shortestTurn(heading - pointer);
    pointer = heading;
  }
  return value;
}

// ── (1) the integrator itself ────────────────────────────────────────────────
test("shortestTurn returns the SHORTEST signed arc", () => {
  assert.equal(shortestTurn(10), 10);
  assert.equal(shortestTurn(350), -10, "advancing 350° IS retreating 10°");
  assert.equal(shortestTurn(-350), 10);
  assert.equal(shortestTurn(730), 10, "two whole turns are no turn");
  assert.equal(shortestTurn(0), 0);
  assert.equal(HALF_TURN_DEG, FULL_TURN_DEG / 2);
});

test("shortestTurn lands in [-180, 180) and stays congruent mod 360", () => {
  for (let d = -1000; d <= 1000; d += 7) {
    const t = shortestTurn(d);
    assert.ok(t >= -HALF_TURN_DEG && t < HALF_TURN_DEG, `shortestTurn(${d}) = ${t} is outside [-180, 180)`);
    assert.ok(Math.abs(wrapDegrees(d - t)) < 1e-9, `shortestTurn(${d}) is not congruent to ${d} mod 360`);
  }
});

// ── (2) the dial's own gesture ───────────────────────────────────────────────
test("dragging the dial TWICE round commits 720, not 0", () => {
  const sweep = [];
  for (let a = 30; a <= 720; a += 30) sweep.push(a);
  assert.equal(replayDrag(0, sweep), 720, "turn count was lost — the dial folded the heading");
  assert.equal(replayDrag(0, sweep.map((a) => -a)), -720, "a counter-clockwise sweep must go NEGATIVE");
  // The failure mode this guards against, stated explicitly:
  assert.equal(wrapDegrees(720), 0, "writing the pointer heading would have stored 0");
});

test("dragging past the top does not jump the ±360 seam", () => {
  assert.equal(replayDrag(350, [355, 359, 3, 7]), 367, "crossing 0 must continue, not snap back");
});

// ── (3) the keyframe tween — the whole point ─────────────────────────────────
test("rotation keyframed 0 → 720° tweens through TWO WHOLE SPINS", () => {
  let doc = newDocument();
  let itemId;
  [doc, itemId] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: 0 });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 0, ["items", itemId, "rotation"], 0);
  doc = keyframed(doc, 1, ["items", itemId, "rotation"], toRadians(720));
  // linear curve: this test is about the SPIN COUNT surviving the tween, not
  // about transition easing — foldState now applies the curve (THE ALPHA
  // REFACTOR), and the default "smooth" cubic would make the plain quarter-turn
  // sample points below wrong (cubic(0.25) !== 0.25).
  doc.slides[1] = { ...doc.slides[1], transition: { ...doc.slides[1].transition, curve: "linear" } };

  const degreesAt = (alpha) => toDegrees(foldState(doc, 1, alpha).items[itemId].rotation);
  const samples = [0, 0.25, 0.5, 0.75, 1].map(degreesAt);
  assert.deepEqual(samples.map(Math.round), [0, 180, 360, 540, 720]);
  for (let i = 1; i < samples.length; i++)
    assert.ok(samples[i] > samples[i - 1], `the tween must RISE: ${samples[i - 1]} → ${samples[i]}`);
  assert.ok(samples.some((d) => d > FULL_TURN_DEG), "the tween never passed a full turn — it wrapped");
});

// ── (4) storage and equations are untouched by the kind switch ───────────────
test("rotation is a dial row that still STORES RADIANS", () => {
  assert.equal(PROPS.rotation.kind, "angle", "the universal rotation row must use the dial");
  assert.equal(PROPS.rotation.display, "degrees", "...and bridge its radian storage to the degrees it shows");
  let doc = newDocument();
  let itemId;
  [doc, itemId] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: Math.PI });
  assert.equal(foldState(doc, 0, 1).items[itemId].rotation, Math.PI, "a stored π must stay π (180°), never be migrated");
});

test('every "angle" row accepts an "=" equation and types as a number', () => {
  const rows = roster.flatMap((p) => (p.inspector ?? []).filter((r) => r.kind === "angle").map((r) => ({ p, key: r.key })));
  assert.ok(rows.length > 0, "no angle rows found — the sweep would pass vacuously");
  for (const { p, key } of rows) {
    let doc = newDocument();
    let itemId;
    [doc, itemId] = withNewItem(doc, 0, { ...p.defaults, type: p.type });
    doc = { ...doc, slides: doc.slides.map((s, i) => (i === 0 ? { ...s, delta: { ...s.delta, vars: { tilt: 0.5 } } } : s)) };
    const path = key.split(".");
    doc = keyframed(doc, 0, ["items", itemId, ...path], "=tilt * 2");
    const folded = foldState(doc, 0, 1);
    assert.equal(resultKindForSlot(p, path, folded.items[itemId]), "number", `${p.type}.${key} does not type as a number`);
    const { state, errors } = evaluateState(folded, registry);
    assert.equal(errors.get(["items", itemId, ...path].join(".")), undefined, `${p.type}.${key} rejected an equation`);
    let value = state.items[itemId];
    for (const k of path) value = value[k];
    assert.equal(value, 1, `${p.type}.${key}: "=tilt * 2" evaluated to ${value}, expected 1`);
  }
});

console.log(`\n${passed} angle-dial tests passed`);
