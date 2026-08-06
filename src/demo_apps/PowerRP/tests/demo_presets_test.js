/**
 * THE DEMO PRESETS (manifest R7-16 double pendulum, R7-20 three-body, R7-25 mouse
 * cursor) — the laws plugins/demo_presets.js is built to keep. Plain node.
 * Run: node src/demo_apps/PowerRP/tests/demo_presets_test.js
 *
 * WHAT IS PINNED HERE, and why each one is a LAW rather than a behaviour:
 *   - NO NEW WIDGET TYPE. The user ruled these are *"normal basic ass vanilla
 *     widgets … with pre-filled equations"*, so a `pendulum` plugin appearing is the
 *     one failure that makes the whole feature the wrong thing.
 *   - THE FALLBACK TRAP. A simulated slot's `@` reads its DECLARED DEFAULT on step
 *     one, so an equation sitting in a PLUGIN DEFAULT would string-concatenate
 *     silently. Every equation here must therefore be INSERTED state.
 *   - THE INITIAL CONDITION SURVIVES STEP ONE. A double pendulum released from 0 is
 *     hanging straight down and never moves, so `theta == theta0` on the inserted
 *     frame is the difference between a demo and a picture of two still rectangles.
 *   - SYMPLECTIC, spelled with exactly one `@` fewer than explicit Euler.
 *   - THE PHYSICS IS RIGHT, checked by ENERGY rather than by eye.
 *   - THE THREE BODIES STAY ON THE SLIDE — softening is what buys that, and its
 *     absence is the single most likely way a first attempt looks broken.
 *   - A SELECT ROW ACCEPTS AN EQUATION (R7-25 asked for this to be verified).
 *   - A STAMPED DOCUMENT NEEDS NO REPAIR, and refuses strided sharding because it
 *     contains simulated state.
 */

import assert from "node:assert/strict";
import { evaluateState } from "../core/expressions.js";
import { compileProjectScript } from "../core/project_script.js";
import {
  resetSimulation, setSimulationTimestepOverride,
  CAMERA_MAX_TIMESTEP_KEY, CAMERA_MAX_TIMESTEP_DEFAULT,
} from "../core/simulation_history.js";
import { setPointerInputOverride } from "../core/pointer_input.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins, builtinRoster } from "../plugins/index.js";
import { keyframed, newDocument, repairedDocument, stridedShardRefusal, uuid, withNormalizedZ } from "../core/document.js";
import { cameraPlugin } from "../plugins/camera.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import {
  DEMO_PRESETS, DOUBLE_PENDULUM, THREE_BODY, MOUSE_CURSOR,
  buildPresetItems, withPresetScript, hotspotFraction, cursorFollowEquation,
} from "../plugins/demo_presets.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerPlugins(registry);

/** The frame rate the presets are TUNED at — every trajectory assertion below is
 *  stated at it, because a first-order step's accuracy is a function of it. */
const TEST_FPS = 60;

/** Where a preset is stamped in these tests — the centre of the default 1280x720
 *  slide, which is where the insert command puts it (the view centre). */
const RIG_CENTRE = { x: 640, y: 360 };

/**
 * Command (mints ids; no document). Stamps a preset into a bare `{vars, items}`
 * state — everything the insert command does except the document write, so the
 * physics can be driven with no app.
 */
function stamp(preset, centre = RIG_CENTRE) {
  const minted = new Map();
  const idFor = (name) => {
    if (!minted.has(name)) minted.set(name, uuid());
    return minted.get(name);
  };
  const { states, order } = buildPresetItems(preset, registry, centre, idFor);
  return { items: states, order, ids: minted, script: withPresetScript("", preset.script) };
}

/** Command (drives the ambient clock and the equation pass — the presenter's own
 *  sequence). Returns the evaluated pass at frame `n`. */
function stepTo(rig, frames) {
  resetSimulation();
  setSimulationTimestepOverride(1 / TEST_FPS);
  let pass = null;
  for (let n = 0; n <= frames; n++) {
    setParticleTimeOverride(n / TEST_FPS);
    // A DISTINCT state object per pass: evaluateState memoizes on state IDENTITY, so
    // a reused object would serve a cached answer instead of stepping.
    pass = evaluateState({ vars: {}, items: { ...rig.items } }, registry, rig.script);
  }
  return pass;
}

/** Command. A fresh clock and simulation, so no test inherits another's trajectory. */
function freshRun() {
  setSimulationTimestepOverride(null);
  setPointerInputOverride(null);
  resetSimulation();
  setParticleTimeOverride(0);
}

// ── The ruling: these are ordinary widgets ───────────────────────────────────

test("NO new widget type — every preset item is a type the app already shipped", () => {
  const shipped = new Set(builtinRoster().map((p) => p.type));
  for (const preset of DEMO_PRESETS) {
    const rig = stamp(preset);
    for (const id of rig.order) {
      const type = rig.items[id].type;
      assert.ok(shipped.has(type), `preset "${preset.id}" uses type "${type}", which is not a shipped widget`);
    }
  }
  // …and the roster gained no physics widget wearing a preset's name.
  for (const banned of ["pendulum", "double_pendulum", "three_body", "cursor_demo"])
    assert.ok(!shipped.has(banned), `a "${banned}" plugin exists — R7-16's first hard constraint is that it must not`);
});

test("the pendulum is two rects and a trail; the three-body is three circles and three trails", () => {
  const kinds = (preset) => {
    const rig = stamp(preset);
    return rig.order.map((id) => rig.items[id].type);
  };
  assert.deepEqual(kinds(DOUBLE_PENDULUM), ["trail", "rect", "rect"]);
  assert.deepEqual(kinds(THREE_BODY), ["trail", "trail", "trail", "circle", "circle", "circle"]);
  assert.deepEqual(kinds(MOUSE_CURSOR), ["trail", "cursor"]);
});

// ── The fallback trap ────────────────────────────────────────────────────────

test("every equation is INSERTED state — no plugin default at any of these paths holds one", () => {
  // core/expressions.js fallbackFor answers `@` on step one with the plugin default,
  // so an equation living THERE would make step one evaluate `"= @@ + dt" + 0`.
  for (const preset of DEMO_PRESETS) {
    const rig = stamp(preset);
    for (const id of rig.order) {
      const state = rig.items[id];
      const defaults = registry.get(state.type).defaults;
      for (const [key, value] of Object.entries(state)) {
        if (typeof value !== "string" || !value.startsWith("=")) continue;
        assert.ok(
          typeof defaults[key] !== "string" || !defaults[key].startsWith("="),
          `${state.type}.defaults.${key} is itself an equation — a simulated slot's default is its INITIAL CONDITION and must be a value`
        );
      }
      // A plugin declares no `vars` at all, which is what makes an item variable's
      // step-one fallback 0 — the correct start for an ACCUMULATOR, and the reason
      // the initial condition is composed onto it instead.
      assert.equal(defaults.vars, undefined, `${state.type} declares plugin-default vars — the presets' composition assumes none`);
    }
  }
});

// ── The double pendulum ──────────────────────────────────────────────────────

test("the pendulum is RELEASED FROM ITS STATED ANGLE — theta == theta0 on the inserted frame", () => {
  freshRun();
  const rig = stamp(DOUBLE_PENDULUM);
  const pass = stepTo(rig, 0);
  assert.deepEqual([...pass.errors], []);
  const [rod1, rod2] = [rig.ids.get("rod1"), rig.ids.get("rod2")];
  for (const id of [rod1, rod2]) {
    const item = pass.state.items[id];
    assert.equal(item.vars.theta, item.vars.theta0, "theta must start AT theta0, not at the accumulator's zero");
    assert.equal(item.rotation, item.vars.theta0, "rotation READS theta — that is what keeps the rod an ordinary rect");
  }
  // …and neither start is a fixed point of the dynamics, where the rig would sit
  // perfectly still and look broken.
  assert.notEqual(pass.state.items[rod1].vars.theta0 % Math.PI, 0);
  assert.notEqual(pass.state.items[rod2].vars.theta0 % Math.PI, 0);
});

test("the integration is SYMPLECTIC — the position reads the NEW velocity (one `@` fewer)", () => {
  const rig = stamp(DOUBLE_PENDULUM);
  const rod = rig.items[rig.ids.get("rod1")];
  assert.equal(rod.vars.swing, "= @@ + dt * self.vars.omega");
  assert.ok(!rod.vars.swing.includes("@@self.vars.omega"), "an `@` here is EXPLICIT Euler, whose energy climbs monotonically");
  assert.match(rod.vars.omega, /^= @@ \+ dt \* pendulumAlpha1\(/);
});

test("the rods are COUPLED — each reads the other's previous angle AND angular velocity", () => {
  const rig = stamp(DOUBLE_PENDULUM);
  const [rod1, rod2] = [rig.ids.get("rod1"), rig.ids.get("rod2")];
  assert.ok(rig.items[rod1].vars.omega.includes(`@@${rod2}.vars.theta`));
  assert.ok(rig.items[rod1].vars.omega.includes(`@@${rod2}.vars.omega`));
  assert.ok(rig.items[rod2].vars.omega.includes(`@@${rod1}.vars.theta`));
  assert.ok(rig.items[rod2].vars.omega.includes(`@@${rod1}.vars.omega`));
  // PHYSICAL connection, which is a SEPARATE requirement from dynamical coupling:
  // rod 2's box tracks rod 1's free end through the ordinary ink-anchor grammar.
  assert.equal(rig.items[rod2].x, `= @${rod1}_bm.x - self.w / 2`);
  assert.equal(rig.items[rod2].y, `= @${rod1}_bm.y`);
});

test("rod 2's pivot SITS ON rod 1's free end, at a rotation neither rod is upright at", () => {
  freshRun();
  const rig = stamp(DOUBLE_PENDULUM);
  const pass = stepTo(rig, 30);
  const rod1 = pass.state.items[rig.ids.get("rod1")];
  const rod2 = pass.state.items[rig.ids.get("rod2")];
  // rod 1's pivot is its top-middle; its free end is L along (-sin, cos) from there.
  const pivot = { x: rod1.x + rod1.w / 2, y: rod1.y };
  const tip = { x: pivot.x - rod1.h * Math.sin(rod1.rotation), y: pivot.y + rod1.h * Math.cos(rod1.rotation) };
  const rod2Pivot = { x: rod2.x + rod2.w / 2, y: rod2.y };
  assert.ok(Math.abs(rod2Pivot.x - tip.x) < 1e-6 && Math.abs(rod2Pivot.y - tip.y) < 1e-6,
    `rod 2 pivots at (${rod2Pivot.x}, ${rod2Pivot.y}) but rod 1's free end is at (${tip.x}, ${tip.y}) — it is swinging correctly while floating in the wrong place`);
  assert.notEqual(rod1.rotation, rod1.vars.theta0, "half a second in, the rig must actually have MOVED");
});

test("THE EQUATIONS OF MOTION ARE THE RIGHT ONES — checked by energy, not by eye", () => {
  freshRun();
  const rig = stamp(DOUBLE_PENDULUM);
  const [rod1, rod2] = [rig.ids.get("rod1"), rig.ids.get("rod2")];
  // Total mechanical energy of two point masses on massless rods, in the SCREEN
  // frame (y down, theta from hanging): the transcription-independent check. A wrong
  // alpha does not conserve it — the explicit integrator's does not either, which is
  // why the bound below is a BAND rather than a point.
  const energy = (s) => {
    const a = s.items[rod1], b = s.items[rod2];
    const [t1, t2] = [a.vars.theta, b.vars.theta];
    const [w1, w2] = [a.vars.omega, b.vars.omega];
    const [m1, m2, L1, L2, g] = [a.vars.mass, b.vars.mass, a.h, b.h, 196.2];
    return 0.5 * m1 * L1 * L1 * w1 * w1
      + 0.5 * m2 * (L1 * L1 * w1 * w1 + L2 * L2 * w2 * w2 + 2 * L1 * L2 * w1 * w2 * Math.cos(t1 - t2))
      - (m1 + m2) * g * L1 * Math.cos(t1) - m2 * g * L2 * Math.cos(t2);
  };
  resetSimulation();
  setSimulationTimestepOverride(1 / TEST_FPS);
  setParticleTimeOverride(0);
  let pass = evaluateState({ vars: {}, items: { ...rig.items } }, registry, rig.script);
  const e0 = energy(pass.state);
  // Measured against the motion's own SPAN (all-up to all-down), so a near-zero E0
  // cannot inflate the ratio.
  const span = 2 * ((1 + 1) * 196.2 * 170 + 1 * 196.2 * 170);
  let worst = 0;
  const seconds = 10;
  for (let n = 1; n <= seconds * TEST_FPS; n++) {
    setParticleTimeOverride(n / TEST_FPS);
    pass = evaluateState({ vars: {}, items: { ...rig.items } }, registry, rig.script);
    worst = Math.max(worst, Math.abs(energy(pass.state) - e0) / span);
  }
  assert.deepEqual([...pass.errors], []);
  // 5% over ten seconds at 60 fps. The measured figure is 3.3% (and 0.3% at 1000 fps,
  // which is what says the residual is the STEP and not the formula). The headroom is
  // for the last digits of a chaotic trajectory, not for a different set of equations.
  // For scale: the EXPLICIT integrator, with these same accelerations, is already at
  // 6.1% here and climbs monotonically to 190% by three minutes.
  assert.ok(worst < 0.05, `the double pendulum's energy moved ${(worst * 100).toFixed(1)}% of its span in ${seconds}s — the accelerations are not the published ones`);
  // …and it genuinely went chaotic rather than sitting still.
  assert.ok(Math.abs(pass.state.items[rod2].vars.theta - pass.state.items[rod2].vars.theta0) > 1);
});

test("THE COUPLING IS MEASURED, NOT MERELY WRITTEN — and 1e-6 amplifies by four orders", () => {
  // The test above this one reads the coupling off the EQUATION SOURCE, which proves
  // the reference was written. This one proves it is LOAD-BEARING: perturb rod 2's
  // release angle ALONE and rod 1 — whose own equation is untouched — must take a
  // different path. Two independently swinging rods would be a convincing-looking fake
  // that passes every source check, and this is the assertion that fails on one.
  const trace = (nudgeRod2, frames) => {
    freshRun();
    const rig = stamp(DOUBLE_PENDULUM);
    const [rod1, rod2] = [rig.ids.get("rod1"), rig.ids.get("rod2")];
    rig.items[rod2] = { ...rig.items[rod2], vars: { ...rig.items[rod2].vars, theta0: rig.items[rod2].vars.theta0 + nudgeRod2 } };
    const pass = stepTo(rig, frames);
    return { theta1: pass.state.items[rod1].vars.theta, theta2: pass.state.items[rod2].vars.theta };
  };
  // A tenth of a second is already enough to see rod 1 respond, which is the point:
  // the dependence is immediate, not an artefact accumulated over a long run.
  const PERTURBATION = 1e-6;
  const early = Math.abs(trace(0, TEST_FPS / 10).theta1 - trace(PERTURBATION, TEST_FPS / 10).theta1);
  assert.ok(early > 0, "rod 1 ignored a change to rod 2 entirely — the rods are not coupled");
  // MEASURED: 1.13e-9 after 0.1 s. The bound is loose because the last digits of a
  // chaotic trajectory are not a contract; ZERO is what would mean "uncoupled".
  assert.ok(early > 1e-12, `rod 1 moved by only ${early} — that is rounding, not coupling`);
  // …and by twenty seconds the perturbation has grown four orders of magnitude, which
  // is what "chaotic" means operationally. MEASURED: 1e-6 → 2.8e-2 in rod 2's angle.
  const late = Math.abs(trace(0, 20 * TEST_FPS).theta2 - trace(PERTURBATION, 20 * TEST_FPS).theta2);
  assert.ok(late > 100 * PERTURBATION, `a 1e-6 nudge grew only to ${late} in 20 s — the rig is not chaotic`);
});

test("A LAG SPIKE IS CLAMPED BY THE CAMERA, and without the clamp the same stall kicks the rig", () => {
  // MEASURED time, not a dictated step: the clamp exists to correct an OBSERVATION,
  // and an export's dictated `dt` deliberately never reaches it (R7-9), so a run under
  // setSimulationTimestepOverride cannot exercise this at all.
  const stalled = (maxTimestep) => {
    freshRun();
    const rig = stamp(DOUBLE_PENDULUM);
    const rod1 = rig.ids.get("rod1");
    // THE CLAMP IS READ OFF THE CAMERA, so the state driven here must contain one —
    // cameraMaxTimestep answers null for a document with no camera, which is "none".
    const items = { ...rig.items, cam: { ...cameraPlugin.defaults, type: "camera", name: "Camera", [CAMERA_MAX_TIMESTEP_KEY]: maxTimestep } };
    const at = (t) => { setParticleTimeOverride(t); return evaluateState({ vars: {}, items: { ...items } }, registry, rig.script).state; };
    const NORMAL_FRAMES = TEST_FPS / 2; // half a second of ordinary frames first
    let last = at(0);
    for (let n = 1; n <= NORMAL_FRAMES; n++) last = at(n / TEST_FPS);
    const before = last.items[rod1].vars.omega;
    const STALL_SECONDS = 3; // a tab switch, a GC pause, a breakpoint
    const after = at(NORMAL_FRAMES / TEST_FPS + STALL_SECONDS).items[rod1].vars.omega;
    return Math.abs(after - before);
  };
  const clamped = stalled(CAMERA_MAX_TIMESTEP_DEFAULT);
  const unclamped = stalled(null);
  // MEASURED: 0.110 rad/s clamped, 3.29 rad/s with the clamp cleared — a factor of 30.
  // The clamped step is ONE 0.1 s step's worth of acceleration and the lost time is
  // DISCARDED rather than caught up, which is the documented failure mode.
  assert.ok(clamped < unclamped / 10, `a 3 s stall moved omega by ${clamped} with the clamp and ${unclamped} without — the camera's ${CAMERA_MAX_TIMESTEP_KEY} is not reaching the pendulum`);
  assert.ok(clamped < 1, `even clamped, the stall kicked omega by ${clamped} rad/s — the clamp is not bounding the step`);
});

// ── The three-body problem ───────────────────────────────────────────────────

test("SOFTENING IS PRESENT AND AUTHORABLE — without it a close pass throws a body off the slide", () => {
  const rig = stamp(THREE_BODY);
  for (let i = 0; i < 3; i++) {
    const body = rig.items[rig.ids.get(`body${i}`)];
    assert.equal(typeof body.vars.eps, "number");
    assert.ok(body.vars.eps > 0);
    assert.ok(body.vars.dvx.includes("self.vars.eps"), "the acceleration must be handed the softening radius");
  }
  assert.match(THREE_BODY.script, /eps \* eps/, "the script must actually USE eps in the denominator");
});

test("the bodies STAY ON THE SLIDE, and their positions live in x/y", () => {
  freshRun();
  const rig = stamp(THREE_BODY, RIG_CENTRE);
  const ids = [0, 1, 2].map((i) => rig.ids.get(`body${i}`));
  for (const id of ids) {
    assert.equal(rig.items[id].x, "= self.vars.x0 + self.vars.dx", "position is the CIRCLE's own x — R7-20 forbids a second spelling of it");
    assert.ok(rig.items[id].vars.px === undefined && rig.items[id].vars.py === undefined);
  }
  const centre = RIG_CENTRE;
  resetSimulation();
  setSimulationTimestepOverride(1 / TEST_FPS);
  let pass = null, worst = 0, moved = 0;
  const seconds = 60;
  for (let n = 0; n <= seconds * TEST_FPS; n++) {
    setParticleTimeOverride(n / TEST_FPS);
    pass = evaluateState({ vars: {}, items: { ...rig.items } }, registry, rig.script);
    for (const id of ids) {
      const b = pass.state.items[id];
      worst = Math.max(worst, Math.hypot(b.x + b.w / 2 - centre.x, b.y + b.h / 2 - centre.y));
    }
  }
  for (const id of ids) {
    const b = pass.state.items[id];
    moved = Math.max(moved, Math.hypot(b.vars.dx, b.vars.dy));
  }
  assert.deepEqual([...pass.errors], []);
  // Measured over ten minutes the worst excursion is 411 units and it is stable at
  // 24, 60 and 144 fps; 500 is the band this configuration was SELECTED for, and a
  // detonation blows past it by orders of magnitude rather than by a few units.
  assert.ok(worst < 500, `a body reached ${worst.toFixed(0)} units from the barycentre in ${seconds}s — the configuration is not bounded`);
  assert.ok(moved > 100, "the bodies must actually orbit, not sit where they were stamped");
});

test("the masses are UNEQUAL and each body reads BOTH others' previous positions", () => {
  const rig = stamp(THREE_BODY);
  const ids = [0, 1, 2].map((i) => rig.ids.get(`body${i}`));
  const masses = ids.map((id) => rig.items[id].vars.mass);
  assert.equal(new Set(masses).size, 3, 'the user asked for "variable masses"');
  for (const id of ids)
    for (const other of ids.filter((o) => o !== id))
      assert.ok(rig.items[id].vars.dvx.includes(`@@${other}.`), `body ${id} does not read ${other}'s previous state — that is two bodies, not three`);
});

// ── The mouse cursor ─────────────────────────────────────────────────────────

test("A SELECT ROW ACCEPTS AN EQUATION — the open/closed hand is a shape equation (R7-25 asked to verify)", () => {
  freshRun();
  const rig = stamp(MOUSE_CURSOR);
  const cursorId = rig.ids.get("cursor");
  assert.equal(registry.get("cursor").inspector.find((r) => r.key === "cursorKind").kind, "select");
  for (const left of [false, true]) {
    setPointerInputOverride({ x: 300, y: 200, left });
    const pass = evaluateState({ vars: {}, items: { ...rig.items } }, registry, rig.script);
    assert.deepEqual([...pass.errors], []);
    assert.equal(pass.state.items[cursorId].cursorKind, left ? "handgrabbing" : "handpointing");
  }
  setPointerInputOverride(null);
});

test("the cursor's TIP lands on the pointer, in both hands", () => {
  freshRun();
  const rig = stamp(MOUSE_CURSOR);
  const cursorId = rig.ids.get("cursor");
  for (const left of [false, true]) {
    setPointerInputOverride({ x: 512, y: 333, left });
    const pass = evaluateState({ vars: {}, items: { ...rig.items } }, registry, rig.script);
    const c = pass.state.items[cursorId];
    const kind = left ? "handgrabbing" : "handpointing";
    assert.ok(Math.abs(c.x + c.w * hotspotFraction(kind, "x") - 512) < 1e-9);
    assert.ok(Math.abs(c.y + c.h * hotspotFraction(kind, "y") - 333) < 1e-9);
    // …and the two hands genuinely point from different places, which is why the
    // offset switches with the button rather than being one constant.
    assert.notEqual(hotspotFraction("handgrabbing", "y"), hotspotFraction("handpointing", "y"));
  }
  setPointerInputOverride(null);
  assert.equal(cursorFollowEquation("x"), "= mouse_x - self.w * (mouse_left ? 0.46875 : 0.40625)");
});

test("the cursor is RECORDABLE, not simulated — nothing in it reads @ or dt", () => {
  const rig = stamp(MOUSE_CURSOR);
  const cursor = rig.items[rig.ids.get("cursor")];
  for (const value of Object.values(cursor))
    if (typeof value === "string") assert.ok(!/@|\bdt\b/.test(value), `the cursor widget reads simulated state in "${value}" — it must not; its determinism comes from the pointer SEAM`);
});

// ── The rig as a document ────────────────────────────────────────────────────

test("a stamped document needs NO REPAIR, and REFUSES strided sharding", () => {
  for (const preset of DEMO_PRESETS) {
    const rig = stamp(preset);
    let doc = { ...newDocument(), meta: { ...newDocument().meta, script: rig.script } };
    let z = 1;
    for (const id of rig.order) doc = keyframed(doc, 0, ["items", id], { ...rig.items[id], active: true, z: z++ });
    const repair = repairedDocument(withNormalizedZ(doc), registry);
    assert.deepEqual(repair.reports, [], `preset "${preset.id}" needs repair on load: ${repair.reports.join(" | ")}`);
    // Every preset carries a trail, and a trail's clock is `= @ + dt`, so every rig
    // gives up seekability — with nothing taught to detect it.
    assert.match(stridedShardRefusal(repair.doc, registry), /SIMULATED STATE/);
  }
});

test("each preset's script COMPILES in the equation jail, exporting what its equations call", () => {
  const host = { random: () => 0.5, time: () => 0, pointer: () => ({ x: 0, y: 0, left: false }) };
  for (const preset of DEMO_PRESETS) {
    if (!preset.script) continue;
    const compiled = compileProjectScript(preset.script, host);
    assert.equal(compiled.error, null, `preset "${preset.id}" script: ${compiled.error}`);
    const rig = stamp(preset);
    const called = new Set();
    for (const id of rig.order)
      for (const value of Object.values(rig.items[id].vars ?? {}))
        if (typeof value === "string") for (const m of value.matchAll(/([A-Za-z_$][\w$]*)\(/g)) called.add(m[1]);
    for (const name of called)
      assert.ok(name in compiled.exports, `the equations call "${name}" but the preset's script does not export it`);
  }
});

test("withPresetScript APPENDS and is idempotent — a preset must never destroy the author's library", () => {
  assert.equal(withPresetScript("", "exports.f = () => 1;\n"), "exports.f = () => 1;\n");
  assert.equal(withPresetScript("exports.a = 1;", ""), "exports.a = 1;");
  assert.equal(withPresetScript("exports.a = 1;", "exports.b = 2;"), "exports.a = 1;\n\nexports.b = 2;");
  assert.equal(withPresetScript("exports.b = 2;", "exports.b = 2;"), "exports.b = 2;", "a second insert must not leave two copies of one helper");
  // …and the author's own code is still there, byte for byte, after a stamp.
  const mine = "exports.ease = (t) => t * t;\n";
  assert.ok(withPresetScript(mine, DOUBLE_PENDULUM.script).startsWith(mine.trimEnd()));
});

test("every preset is REACHABLE — one palette entry per blueprint record, generated not written", async () => {
  // R7-18 folded web/demoPresetInsert.js into web/demoInsert.js, the ONE insertable-
  // template path shared with the demo audio patches; the preset entries are that
  // file's "preset" SECTION. The assertion is unchanged — this is still the check
  // that the entries are generated from the roster rather than written out.
  const { demoSectionChildren } = await import("../web/demoInsert.js");
  const commands = demoSectionChildren("preset");
  assert.deepEqual(
    commands.map((c) => c.id),
    DEMO_PRESETS.map((p) => `demo-preset-${p.id}`),
    "the entries are generated from the roster, so these lists cannot disagree unless the generation was replaced by a hand-written list"
  );
  for (const cmd of commands) assert.ok(cmd.help && cmd.icon);
});

freshRun();
console.log(`\n${passed} demo preset tests passed`);
