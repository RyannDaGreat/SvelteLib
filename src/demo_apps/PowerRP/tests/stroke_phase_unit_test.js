/**
 * STROKE PHASE UNIT test — plain node, no framework. Pins the exact mechanism of
 * the "have to go through thousands of degrees before it loops" bug: strokePhase
 * declared `display: "degrees"`, which web/displayUnits.js defines as "the stored
 * value is RADIANS" (the rotation convention — AngleField divides a typed value by
 * 180/pi before storing). render_gpu/ir.js applyStrokeTrim expects the stored value
 * to be PLAIN DEGREES and divides by 360 at the state->op seam, so a UI-typed 90
 * degrees was silently stored as ~1.571 (radians) and then read as 1.571 degrees of
 * loop by that seam — a full loop needed a typed value in the tens of thousands.
 *
 * The fix is that strokePhase carries NO display unit (identity: shown === stored,
 * exactly like the `angle`/`particleAngle` gradient rows AngleField's own docstring
 * names as the precedent) so applyStrokeTrim's plain-degrees assumption is true.
 * This file guards the DECLARATION (the row's `display` key) rather than duplicating
 * the pixel-level proof already in tests/stroke_trim_probe.js (which writes stored
 * state directly and so cannot see a UI display-unit bug at all).
 *
 * Run: node src/demo_apps/PowerRP/tests/stroke_phase_unit_test.js
 */
import assert from "node:assert/strict";
import { PROPS } from "../core/properties.js";
import { displayUnit } from "../web/displayUnits.js";
import { applyStrokeTrim } from "../render_gpu/ir.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

test("strokePhase declares NO display unit (identity: the dial shows exactly what is stored)", () => {
  assert.equal(PROPS.strokePhase.kind, "angle");
  assert.equal(PROPS.strokePhase.display, undefined,
    "strokePhase must not name a display unit — applyStrokeTrim already expects PLAIN DEGREES in storage; " +
    "naming \"degrees\" here means \"stored=radians\" (the rotation convention) and reintroduces the bug");
});

test("displayUnit(undefined) is the identity transform: a typed 90 stores as 90, not radians", () => {
  const unit = displayUnit(PROPS.strokePhase.display);
  assert.equal(unit.fromDisplay(90), 90, "typed 90 degrees must store as plain 90, not 90/(180/pi)");
  assert.equal(unit.toDisplay(90), 90, "a stored 90 must display as plain 90");
});

test("contrast: rotation DOES declare display:\"degrees\", because IT stores radians", () => {
  assert.equal(PROPS.rotation.display, "degrees");
  const unit = displayUnit(PROPS.rotation.display);
  assert.ok(Math.abs(unit.fromDisplay(90) - Math.PI / 2) < 1e-9, "rotation's 90 degrees must store as pi/2 radians");
});

test("end-to-end: a UI-typed 90 (stored as plain 90 via identity) shifts the loop by exactly a quarter turn", () => {
  const typed = 90;
  const stored = displayUnit(PROPS.strokePhase.display).fromDisplay(typed);
  assert.equal(stored, 90);
  const [op] = applyStrokeTrim({ strokePhase: stored }, [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }]);
  assert.equal(op.strokePhase, 0.25, "90 stored degrees / 360 = a quarter-turn phase, not a tiny fraction of one");
});

test("end-to-end: a UI-typed 360 is BYTE-VALUE identical in loop terms to a UI-typed 0 (mod1 wrap)", () => {
  const storedFull = displayUnit(PROPS.strokePhase.display).fromDisplay(360);
  const storedZero = displayUnit(PROPS.strokePhase.display).fromDisplay(0);
  assert.equal(storedFull, 360);
  assert.equal(storedZero, 0);
  const [full] = applyStrokeTrim({ strokePhase: storedFull }, [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }]);
  const [zero] = applyStrokeTrim({ strokePhase: storedZero }, [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }]);
  assert.equal(full.strokePhase, 1, "360 stored degrees / 360 = exactly one whole turn");
  assert.equal(zero.strokePhase, undefined, "0 is the identity phase — dropped, absent-is-legacy");
  // 1 turn and 0 turns are different STORED op values but identical after mod1 at
  // the trim-segment seam (render_gpu/ir.js trimSegments / mod1) — that identity is
  // pixel-proven end to end in tests/stroke_trim_probe.js's dash360 assertion.
});

test("REGRESSION GUARD: the old buggy typed-90 (interpreted as radians) needed thousands to loop", () => {
  // Simulates what the BUGGY display:"degrees" declaration used to do, to document
  // the magnitude of the old symptom (never assert this — it is the bug, not the fix).
  const buggyUnit = displayUnit("degrees"); // the rotation convention, wrongly applied
  const buggyStoredFor90Typed = buggyUnit.fromDisplay(90); // ~1.5708 (radians)
  const [buggyOp] = applyStrokeTrim({ strokePhase: buggyStoredFor90Typed }, [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }]);
  assert.ok(buggyOp.strokePhase < 0.01, "documents the bug: 90 typed degrees only moved the loop by ~0.4%");
  // the typed value needed to reach one full stored turn (360) under the bug:
  const neededTypedForFullLoop = buggyUnit.toDisplay(360);
  assert.ok(neededTypedForFullLoop > 20000, `documents the bug: a full loop needed typing ${Math.round(neededTypedForFullLoop)} degrees`);
});

console.log(`\nPASS — ${passed} stroke phase unit tests`);
