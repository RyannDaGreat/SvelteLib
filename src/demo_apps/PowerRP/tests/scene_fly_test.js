/**
 * THE 3D VIEWPORT'S WASDQE FLY — #270's "rollerball + WASD camera".
 *
 * The rollerball half (mouse-look, wheel dolly, Ctrl+wheel FOV) already shipped
 * in web/sceneNav.js. This is the keyboard half, and the interesting assertions
 * are about WHICH AXES a fly uses: forward follows the full 3-D view direction so
 * looking down and pressing W descends, while strafe and rise are deliberately
 * HORIZONTAL and WORLD-VERTICAL — that asymmetry is the conventional one, and
 * getting it wrong rolls the world sideways under the author.
 *
 * Run: node src/demo_apps/PowerRP/tests/scene_fly_test.js
 */
import assert from "node:assert/strict";
import { flownPose, SCENE_FLY_KEYS } from "../web/sceneNav.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const ORIGIN = { targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 10 };

test("FORWARD moves along the view direction", () => {
  const p = flownPose(ORIGIN, { forward: 1 });
  assert.ok(near(p.targetZ, -1), `yaw 0 looks down -Z, so forward is -Z (got ${p.targetZ})`);
  assert.ok(near(p.targetX, 0) && near(p.targetY, 0), "and nothing else moves");
});

test("BACK is exactly forward negated", () => {
  const f = flownPose(ORIGIN, { forward: 1 }), b = flownPose(ORIGIN, { forward: -1 });
  assert.ok(near(f.targetZ, -b.targetZ) && near(f.targetX, -b.targetX));
});

test("YAW STEERS the fly — turned 90 degrees, forward is a different axis", () => {
  const p = flownPose({ ...ORIGIN, yaw: Math.PI / 2 }, { forward: 1 });
  assert.ok(near(p.targetX, -1), `got ${p.targetX}`);
  assert.ok(near(p.targetZ, 0, 1e-9), "…and no longer along Z");
});

test("PITCH IS INCLUDED IN FORWARD — look down, fly forward, descend", () => {
  // The behaviour every flying camera has. A forward that ignored pitch would
  // make it impossible to fly into or out of a scene by looking where you go.
  const down = flownPose({ ...ORIGIN, pitch: -Math.PI / 2 }, { forward: 1 });
  assert.ok(down.targetY < -0.9, `pitched fully down, forward should descend (got ${down.targetY})`);
});

test("STRAFE IS HORIZONTAL even when pitched — it does not roll the world", () => {
  const p = flownPose({ ...ORIGIN, pitch: -1 }, { right: 1 });
  assert.ok(near(p.targetY, 0), `strafing must not change height (got ${p.targetY})`);
  assert.ok(near(p.targetX, 1), "and it moves fully sideways");
});

test("RISE / DESCEND are WORLD-vertical, for the same reason", () => {
  assert.ok(near(flownPose({ ...ORIGIN, pitch: -1 }, { up: 1 }).targetY, 1));
  assert.ok(near(flownPose({ ...ORIGIN, pitch: -1 }, { up: -1 }).targetY, -1));
});

test("THE STEP IS PROPORTIONAL TO DISTANCE, so a room and a coin both feel right", () => {
  // A fixed step would crawl in a room-scale capture and teleport through a
  // tabletop one; a tenth of where you already stand behaves the same in both.
  const far = flownPose({ ...ORIGIN, distance: 100 }, { forward: 1 });
  const near_ = flownPose({ ...ORIGIN, distance: 1 }, { forward: 1 });
  assert.ok(near(far.targetZ, -10) && near(near_.targetZ, -0.1), `${far.targetZ} vs ${near_.targetZ}`);
});

test("A FLY MOVES THE TARGET AND NOTHING ELSE — it is not a disguised turn", () => {
  const p = flownPose(ORIGIN, { forward: 1, right: 1, up: 1 });
  assert.equal(p.yaw, ORIGIN.yaw);
  assert.equal(p.pitch, ORIGIN.pitch);
  assert.equal(p.distance, ORIGIN.distance, "the orbit radius is untouched — you moved, you did not zoom");
});

test("an empty step is a no-op, so a dispatch with nothing to do cannot drift the camera", () => {
  const p = flownPose(ORIGIN, {});
  assert.deepEqual([p.targetX, p.targetY, p.targetZ], [0, 0, 0]);
  assert.deepEqual(flownPose(ORIGIN), ORIGIN, "…and no argument at all is the same");
});

test("a ZERO distance cannot divide by zero or produce NaN", () => {
  const p = flownPose({ ...ORIGIN, distance: 0 }, { forward: 1 });
  for (const v of [p.targetX, p.targetY, p.targetZ]) assert.ok(Number.isFinite(v), `got ${v}`);
});

test("SIX KEYS, each with a label the HintBar can show", () => {
  assert.deepEqual(SCENE_FLY_KEYS.map((k) => k.keys[0]), ["W", "S", "A", "D", "E", "Q"]);
  for (const k of SCENE_FLY_KEYS) {
    assert.ok(k.label && k.label.length > 0, `${k.keys[0]} needs a label — an unlabelled chip is a blank in the bar`);
    assert.ok(k.verb && typeof k.verb === "object", `${k.keys[0]} needs a verb`);
  }
});

test("every key's verb actually MOVES the camera — no inert chip", () => {
  // A key registered with a verb that does nothing would advertise itself in the
  // HintBar and then do nothing, which is the inert-control defect this app keeps
  // finding.
  for (const k of SCENE_FLY_KEYS) {
    const p = flownPose(ORIGIN, k.verb);
    const moved = !near(p.targetX, 0) || !near(p.targetY, 0) || !near(p.targetZ, 0);
    assert.ok(moved, `${k.keys[0]} ("${k.label}") moved nothing`);
  }
});

test("opposite keys cancel exactly, in all three axes", () => {
  for (const [a, b] of [["W", "S"], ["A", "D"], ["E", "Q"]]) {
    const va = SCENE_FLY_KEYS.find((k) => k.keys[0] === a).verb;
    const vb = SCENE_FLY_KEYS.find((k) => k.keys[0] === b).verb;
    const pa = flownPose(ORIGIN, va), pb = flownPose(ORIGIN, vb);
    assert.ok(near(pa.targetX, -pb.targetX) && near(pa.targetY, -pb.targetY) && near(pa.targetZ, -pb.targetZ),
      `${a} and ${b} must be exact opposites`);
  }
});

console.log(`\n${passed} scene-fly tests passed`);
