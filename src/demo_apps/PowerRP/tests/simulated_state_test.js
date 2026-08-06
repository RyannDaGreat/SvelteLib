/**
 * SIMULATED STATE (manifest R7-9) — the `@` grammar, the `dt` step, and the laws
 * core/simulation_history.js is built to keep. Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/simulated_state_test.js
 *
 * WHAT IS PINNED HERE, and why each one is a LAW rather than a behaviour:
 *   - the four grammar passes agree (a round-trip that loses the marker corrupts a
 *     document silently, which is the whole reason `@` serializes to `@@`);
 *   - `rotation = @ + dt` rotates at ONE DEGREE PER SECOND at any framerate — the
 *     user's own example, measured rather than asserted;
 *   - Δt = 0 ⟹ BYTE-IDENTICAL, no matter how many times the frame is evaluated
 *     (web/CanvasView.svelte evaluates ~28 times per frame);
 *   - a DICTATED step (an export) is never clamped, so a render stays exactly
 *     reproducible while live playback is only approximately so;
 *   - a frozen consumer cannot write history (a thumbnail of another slide must not
 *     land in the editor's timeline);
 *   - a simulated document REFUSES strided sharding, loudly.
 */

import assert from "node:assert/strict";
import {
  tokenize, equationTokenSpans, displayToStored, storedToDisplay, resolveRef,
  evaluateState, withVariableRenamed, withItemRefsRemapped, sourceIsSimulated, cameraMaxTimestep,
} from "../core/expressions.js";
import {
  beginSimulationStep, resetSimulation, withSimulationFrozen, setSimulationTimestepOverride,
  simulationGeneration, clampedTimestep, simulationSnapshot, restoreSimulationSnapshot,
  hasSimulationValue, CAMERA_MAX_TIMESTEP_DEFAULT, CAMERA_MAX_TIMESTEP_KEY,
} from "../core/simulation_history.js";
import { createRegistry } from "../core/registry.js";
import {
  newDocument, withNewItem, keyframed, documentIsSimulated, stridedShardRefusal,
} from "../core/document.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

const registry = createRegistry();
registry.register(rectPlugin);
registry.register(cameraPlugin);
const BOX_STATE = { vars: {}, items: { a1: { ...rectPlugin.defaults, type: "rect", name: "Box" } } };

/**
 * Command (drives the ambient clock + the history). Evaluates `state` once at
 * presentation time `t`, and returns the evaluated state. THE ONLY WAY A STEP IS
 * TAKEN in these tests, so every one of them advances the simulation exactly as the
 * presenter does — through the clock, never by poking the table.
 */
function evaluateAt(state, t, script = "") {
  setParticleTimeOverride(t);
  return evaluateState(state, registry, script).state;
}

/** Command. A fresh simulation and a fresh clock — every test starts from the
 *  initial condition, so none of them can inherit another's trajectory. */
function freshRun() {
  setSimulationTimestepOverride(null);
  resetSimulation();
  setParticleTimeOverride(0);
}

/** Pure function. A folded state holding ONE rect whose `rotation` is `src`, with a
 *  distinct state OBJECT each call (evaluateState memoizes on state identity, so a
 *  reused object would serve a cached answer instead of stepping). */
function rotationState(src, extra = {}) {
  return { vars: {}, items: { a1: { ...rectPlugin.defaults, type: "rect", name: "Box", rotation: src, ...extra } } };
}

// ── The grammar: four passes must agree ──────────────────────────────────────

test("tokenize: the bare marker, the stored marker, and a marked reference are ONE ref token each", () => {
  assert.deepEqual(tokenize("@").map((t) => [t.kind, t.value]), [["ref", "@"]]);
  assert.deepEqual(tokenize("@@").map((t) => [t.kind, t.value]), [["ref", "@@"]]);
  assert.deepEqual(tokenize("@@a1.x + 1").map((t) => t.value), ["@@a1.x", "+", 1]);
  assert.deepEqual(tokenize("@ + dt").map((t) => t.value), ["@", "+", "dt"]);
  // Three sigils name nothing in either grammar, and stay a loud syntax error.
  assert.throws(() => tokenize("@@@x"), /Malformed reference/);
});

test("display ↔ stored: every marked form round-trips, and the item sigil is absorbed", () => {
  const cases = [
    ["@ + dt", "@@ + dt"],
    ["@self.rotation", "@@self.rotation"],
    ["@box.x", "@@a1.x"],
    ["@ * 0.9 + box.x * 0.1", "@@ * 0.9 + @a1.x * 0.1"], // marked and unmarked, one source
  ];
  for (const [display, stored] of cases) {
    assert.equal(displayToStored(display, BOX_STATE), stored, `display→stored: ${display}`);
    assert.equal(storedToDisplay(stored, BOX_STATE), display, `stored→display: ${stored}`);
  }
  // A variable inside the marker needs the variable to exist, exactly like a bare one.
  const withVar = { ...BOX_STATE, vars: { theta: 1 } };
  assert.equal(displayToStored("@theta + dt", withVar), "@@theta + dt");
  assert.equal(storedToDisplay("@@theta + dt", withVar), "@theta + dt");
  assert.throws(() => displayToStored("@ghost", withVar), /Unknown variable "ghost"/);
});

test("display ↔ stored: an ALREADY-STORED source is still idempotent (the one ambiguity, resolved by order)", () => {
  // A single "@" is the marker in display and the item sigil in stored. The display
  // reading wins; a token that is only readable as a stored ref falls back to it, so
  // callers that hand this function an already-stored source keep working.
  assert.equal(displayToStored("@a1.x + 10", BOX_STATE), "@a1.x + 10");
  assert.equal(displayToStored("@@a1.x + 10", BOX_STATE), "@@a1.x + 10");
});

test("the `=` marker survives the previous-value marker (both, at once)", () => {
  assert.equal(displayToStored("= @ + dt", BOX_STATE), "@@ + dt"); // displayToStored drops "=" by contract
  assert.equal(storedToDisplay("= @@a1.x", BOX_STATE), "= @box.x");
});

test("resolveRef: a stored marker resolves to {kind:'prev'} wrapping the reference inside", () => {
  const slugs = { toId: new Map([["box", "a1"]]), toSlug: new Map([["a1", "box"]]) };
  assert.deepEqual(resolveRef("@@", slugs), { kind: "prev", inner: null });
  assert.deepEqual(resolveRef("@@a1.x", slugs), { kind: "prev", inner: { kind: "prop", itemId: "a1", path: ["x"] } });
  assert.deepEqual(resolveRef("@@theta", slugs), { kind: "prev", inner: { kind: "var", name: "theta" } });
});

test("the highlighter paints a marked reference as what it references, never as an error", () => {
  const spans = equationTokenSpans("@ + dt", BOX_STATE);
  assert.deepEqual(spans.map((s) => s.cls), ["self", "op", "self"]); // both are grammar
  assert.deepEqual(equationTokenSpans("@box.x", BOX_STATE).map((s) => s.cls), ["prop"]);
  assert.deepEqual(equationTokenSpans("@speed", { ...BOX_STATE, vars: { speed: 1 } }).map((s) => s.cls), ["var"]);
  // A marked reference to nothing is still red — the marker does not launder a typo.
  assert.deepEqual(equationTokenSpans("@ghost", BOX_STATE).map((s) => s.cls), ["error"]);
});

test("the rewriters see THROUGH the marker (a rename that skipped it would dangle silently)", () => {
  let doc = newDocument();
  doc = keyframed(doc, 0, ["vars", "speed"], 5);
  doc = keyframed(doc, 0, ["vars", "damp"], "= @@speed * 0.5");
  const renamed = withVariableRenamed(doc, "speed", "velocity", registry);
  assert.equal(renamed.slides[0].delta.vars.damp, "= @@velocity * 0.5");
  // And a clone's item re-point, the other mapRefTokens rewriter.
  assert.deepEqual(withItemRefsRemapped("@@a.x + @a.y", new Map([["a", "z"]])), { src: "@@z.x + @z.y", external: [] });
  assert.deepEqual(withItemRefsRemapped("@@", new Map([["a", "z"]])), { src: "@@", external: [] });
});

test("sourceIsSimulated: static, conservative, and it is what a render job asks", () => {
  assert.equal(sourceIsSimulated("@@ + dt"), true);
  assert.equal(sourceIsSimulated("= @@a1.rotation * 0.99"), true);
  assert.equal(sourceIsSimulated("speed * dt"), true);
  assert.equal(sourceIsSimulated("self.w / 2"), false);
  assert.equal(sourceIsSimulated("dt(3)"), false); // a call NAME is not the keyword
  // An untokenizable full-JS source is probed textually rather than assumed innocent.
  assert.equal(sourceIsSimulated("(function () { return dt * 2; })()"), true);
  assert.equal(sourceIsSimulated("(function () { return 1; })()"), false);
});

// ── The user's own example, MEASURED ─────────────────────────────────────────

test("`rotation = @ + dt` rotates ONE DEGREE PER SECOND, and the rate is the same at 30 fps and 1000 fps", () => {
  const rateAt = (fps, seconds) => {
    freshRun();
    let last = 0;
    const frames = Math.round(fps * seconds);
    for (let i = 0; i <= frames; i++) last = evaluateAt(rotationState("= @@ + dt"), i / fps).items.a1.rotation;
    return last;
  };
  approx(rateAt(30, 2), 2, 1e-9);   // 60 steps of 1/30 s
  approx(rateAt(1000, 2), 2, 1e-9); // 2000 steps of 0.001 s — the SAME degree-per-second
  approx(rateAt(30, 5), 5, 1e-9);
});

test("the FIRST frame is the INITIAL CONDITION: dt is 0 before any time has passed", () => {
  freshRun();
  // rotation's plugin default is the initial condition when the slot holds its own
  // equation — there is nothing else the authored text at that path could be.
  assert.equal(evaluateAt(rotationState("= @@ + dt"), 0).items.a1.rotation, rectPlugin.defaults.rotation);
});

test("a cross-item `@` seeds from the AUTHORED value of the slot it names", () => {
  freshRun();
  const state = {
    vars: {},
    items: {
      a1: { ...rectPlugin.defaults, type: "rect", name: "Box", x: 40 },
      a2: { ...rectPlugin.defaults, type: "rect", name: "Trail", x: "= @@a1.x" },
    },
  };
  assert.equal(evaluateAt(state, 0).items.a2.x, 40); // the authored 40, not a default 0
});

// ── The Δt = 0 law, which is what keeps orthogonality alive ──────────────────

test("Δt = 0 ⟹ BYTE-IDENTICAL, however many times the frame is evaluated (the ~28-per-frame case)", () => {
  freshRun();
  // A dt-FREE simulated equation is the sharp case: with one history table it would
  // advance once per evaluation, so the answer would depend on how many times the
  // canvas happened to re-derive — and that count changes with mouse movement.
  const src = "= @@ + 1";
  evaluateAt(rotationState(src), 0);
  const stepped = evaluateAt(rotationState(src), 1).items.a1.rotation;
  for (let i = 0; i < 28; i++)
    assert.equal(evaluateAt(rotationState(src), 1).items.a1.rotation, stepped, `evaluation ${i + 2} at the same instant moved the simulation`);
});

test("Δt = 0 ⟹ the simulated contribution is unchanged while OTHER property state varies", () => {
  freshRun();
  evaluateAt(rotationState("= @@ + dt"), 0);
  const at1 = evaluateAt(rotationState("= @@ + dt"), 1).items.a1.rotation;
  // Same instant, a different `w` — the simulated value must not notice.
  assert.equal(evaluateAt(rotationState("= @@ + dt", { w: 999 }), 1).items.a1.rotation, at1);
});

// ── The reset rule ───────────────────────────────────────────────────────────

/** Pure function. rotationState plus THE camera with its clamp cleared to "none",
 *  for the tests that deliberately jump the clock further than one frame. */
function unclampedRotationState(src) {
  const state = rotationState(src);
  state.items.cam = { ...cameraPlugin.defaults, type: "camera", name: "Camera", [CAMERA_MAX_TIMESTEP_KEY]: null };
  return state;
}

test("time moving BACKWARDS resets to the initial condition — a negative step is never integrated", () => {
  freshRun();
  evaluateAt(unclampedRotationState("= @@ + dt"), 0);
  approx(evaluateAt(unclampedRotationState("= @@ + dt"), 3).items.a1.rotation, 3);
  // Scrub back: not "3 minus something", but the authored start again.
  assert.equal(evaluateAt(unclampedRotationState("= @@ + dt"), 1).items.a1.rotation, rectPlugin.defaults.rotation);
  // …and it integrates forward from there, from the new origin.
  approx(evaluateAt(unclampedRotationState("= @@ + dt"), 2).items.a1.rotation, 1);
});

test("a hand-written bare `@` in a stored document is the marker too (a lone sigil names no item)", () => {
  freshRun();
  evaluateAt(rotationState("= @ + dt"), 0);
  approx(evaluateAt(rotationState("= @ + dt"), 0.05).items.a1.rotation, 0.05);
});

test("resetSimulation bumps the generation, which is what invalidates the memo without the clock moving", () => {
  freshRun();
  const before = simulationGeneration();
  const state = rotationState("= @@ + dt");
  evaluateAt(state, 0);
  evaluateAt(state, 2); // a step: the generation must move
  assert.ok(simulationGeneration() > before, "a step did not bump the generation");
  const g = simulationGeneration();
  resetSimulation();
  assert.ok(simulationGeneration() > g, "a reset did not bump the generation");
  // The SAME state object, at the SAME clock, must not be served from the memo
  // across the reset — it would render the abandoned trajectory.
  setParticleTimeOverride(2);
  assert.equal(evaluateState(state, registry).state.items.a1.rotation, rectPlugin.defaults.rotation);
});

// ── Frozen ⟹ read-only (the scoping invariant) ───────────────────────────────

test("a FROZEN consumer renders the current step and records NOTHING", () => {
  freshRun();
  const src = "= @@ + 1";
  evaluateAt(rotationState(src), 0);
  const stepped = evaluateAt(rotationState(src), 1).items.a1.rotation;
  // A thumbnail of another slide, frozen: same answer, and no write.
  const frozen = withSimulationFrozen(() => evaluateAt(rotationState(src), 1).items.a1.rotation);
  assert.equal(frozen, stepped);
  // The next real step must continue from the LIVE consumer's value, not the frozen
  // one — that is the corruption the freeze exists to prevent.
  assert.equal(evaluateAt(rotationState(src), 2).items.a1.rotation, stepped + 1);
});

test("a frozen consumer cannot start a simulation either (nothing is recorded at all)", () => {
  freshRun();
  withSimulationFrozen(() => evaluateAt(rotationState("= @@ + dt"), 1));
  assert.equal(hasSimulationValue("items.a1.rotation"), false);
});

// ── The max timestep: measured is clamped, dictated is not ───────────────────

test("clampedTimestep: an ordinary frame passes, a hitch is cut, and `none` disables it", () => {
  approx(clampedTimestep(0.016, 0.1), 0.016);
  approx(clampedTimestep(3.4, 0.1), 0.1);
  approx(clampedTimestep(3.4, null), 3.4);
});

test("a MEASURED hitch is clamped, and the lost time is DISCARDED (never caught up)", () => {
  freshRun();
  const state = () => rotationState("= @@ + dt");
  evaluateAt(state(), 0);
  evaluateAt(state(), 5); // a five-second stall against the 0.1s default clamp
  approx(evaluateAt(state(), 5).items.a1.rotation, CAMERA_MAX_TIMESTEP_DEFAULT);
  // The next ordinary frame advances by its own elapsed time only — no catch-up.
  approx(evaluateAt(state(), 5.02).items.a1.rotation, CAMERA_MAX_TIMESTEP_DEFAULT + 0.02);
});

test("a DICTATED step (an export) is never clamped — a render stays exactly reproducible", () => {
  freshRun();
  const fps = 4; // 0.25 s per frame, well over the 0.1 s measured clamp
  setSimulationTimestepOverride(1 / fps);
  const state = () => rotationState("= @@ + dt");
  for (let i = 0; i <= 8; i++) evaluateAt(state(), i / fps);
  approx(evaluateAt(state(), 8 / fps).items.a1.rotation, 8 / fps); // 2 s of simulation, unclamped
  setSimulationTimestepOverride(null);
});

test("cameraMaxTimestep: absent takes the default, an explicit null is 'none', an equation is refused loudly", () => {
  assert.equal(cameraMaxTimestep({ items: {} }), CAMERA_MAX_TIMESTEP_DEFAULT);
  assert.equal(cameraMaxTimestep({ items: { c: { type: "camera" } } }), CAMERA_MAX_TIMESTEP_DEFAULT);
  assert.equal(cameraMaxTimestep({ items: { c: { type: "camera", [CAMERA_MAX_TIMESTEP_KEY]: 0.25 } } }), 0.25);
  assert.equal(cameraMaxTimestep({ items: { c: { type: "camera", [CAMERA_MAX_TIMESTEP_KEY]: null } } }), null);
  const said = [];
  const original = console.error;
  console.error = (...a) => said.push(a.join(" "));
  try {
    assert.equal(cameraMaxTimestep({ items: { c: { type: "camera", [CAMERA_MAX_TIMESTEP_KEY]: "= 1" } } }), CAMERA_MAX_TIMESTEP_DEFAULT);
  } finally {
    console.error = original;
  }
  assert.ok(said.some((s) => s.includes("maxTimestep")), "an equation-valued clamp fell back SILENTLY");
});

test("a fresh camera is born with the clamp, and the camera exposes a row for it (no JSON-only property)", () => {
  const doc = newDocument();
  const camera = Object.values(doc.slides[0].delta.items).find((i) => i.type === "camera");
  assert.equal(camera[CAMERA_MAX_TIMESTEP_KEY], CAMERA_MAX_TIMESTEP_DEFAULT);
  const row = cameraPlugin.inspector.find((r) => r.key === CAMERA_MAX_TIMESTEP_KEY);
  assert.ok(row, "the camera has no Inspector row for its max timestep");
  assert.equal(row.nullable, true, "the clamp must be clearable to 'none' through the nullable row convention");
});

// ── The cycle exemption ──────────────────────────────────────────────────────

test("`@` of one's own slot is NOT a cycle (the exemption is the absent edge, not a flag)", () => {
  freshRun();
  const { errors } = (setParticleTimeOverride(1), evaluateState(rotationState("= @@ + dt"), registry));
  assert.equal(errors.size, 0, `a self previous-value read reported: ${[...errors.values()].join("; ")}`);
  // The FORWARD direction still cycles loudly — the exemption is narrow.
  const cyclic = { vars: { a: "b", b: "a" }, items: {} };
  const original = console.error;
  console.error = () => {};
  try {
    assert.ok(evaluateState(cyclic, registry).errors.get("vars.a")?.includes("Cyclic"));
  } finally {
    console.error = original;
  }
});

test("an ANCHOR has no previous value, and says so instead of approximating one", () => {
  freshRun();
  const original = console.error;
  console.error = () => {};
  let errors;
  try {
    setParticleTimeOverride(1);
    errors = evaluateState(rotationState("= @@a1_tm.x"), registry).errors;
  } finally {
    console.error = original;
  }
  assert.match(errors.get("items.a1.rotation") ?? "", /anchor/);
});

// ── The integrator: symplectic vs explicit Euler is exactly one `@` ──────────

test("SYMPLECTIC Euler beats EXPLICIT Euler on a harmonic oscillator, and the difference is one `@`", () => {
  // x'' = -x, integrated as two coupled first-order equations in item VARIABLES.
  //   EXPLICIT (forward) Euler: x uses the OLD v            → `@ + dt * @v`
  //   SYMPLECTIC (semi-implicit): x uses the NEW v          → `@ + dt * v`
  // The two sources differ by exactly one "@", and the second conserves energy.
  const run = (xSrc) => {
    freshRun();
    const fps = 200, seconds = 20;
    let last = null;
    for (let i = 0; i <= fps * seconds; i++) {
      const state = {
        vars: {},
        items: {
          a1: {
            ...rectPlugin.defaults, type: "rect", name: "Osc",
            vars: { v: "= @@ - dt * @@self.vars.x", x: xSrc },
            rotation: "= self.vars.x",
          },
        },
      };
      last = evaluateAt(state, i / fps).items.a1;
    }
    // Energy of a unit oscillator, whose exact value is conserved: x² + v².
    return last.vars.x ** 2 + last.vars.v ** 2;
  };
  // Both start from x = 0, v = 0 (the slots' own defaults), which conserves
  // trivially — so kick x with a constant to give the oscillator energy.
  const explicit = run("= @@ + dt * @@self.vars.v + (dt * 0.5)");
  const symplectic = run("= @@ + dt * self.vars.v + (dt * 0.5)");
  assert.ok(explicit > symplectic,
    `explicit Euler (${explicit}) did not drift more than symplectic (${symplectic}) — check the integrator claim`);
  assert.ok(Number.isFinite(symplectic) && Number.isFinite(explicit));
});

// ── Seekability: the refusal a render job needs ──────────────────────────────

test("documentIsSimulated / stridedShardRefusal: an ordinary deck shards, a simulated one refuses LOUDLY", () => {
  const plain = newDocument();
  assert.equal(documentIsSimulated(plain, registry), false);
  assert.equal(stridedShardRefusal(plain, registry), null);

  const [withBox, id] = withNewItem(newDocument(), 0, { ...rectPlugin.defaults, type: "rect", name: "Box" });
  const doc = keyframed(withBox, 0, ["items", id, "rotation"], "= @@ + dt");
  assert.equal(documentIsSimulated(doc, registry), true);
  assert.match(stridedShardRefusal(doc, registry) ?? "", /CONTIGUOUS/);
});

// ── Checkpointing (the seam, not a cache) ────────────────────────────────────

test("a snapshot restores a trajectory exactly — the shape a contiguous shard would carry", () => {
  freshRun();
  const state = () => rotationState("= @@ + dt");
  evaluateAt(state(), 0);
  evaluateAt(state(), 1);
  const checkpoint = simulationSnapshot();
  const next = evaluateAt(state(), 2).items.a1.rotation;
  restoreSimulationSnapshot(checkpoint);
  setParticleTimeOverride(1); // the clock the checkpoint was taken at
  assert.equal(evaluateAt(state(), 2).items.a1.rotation, next);
});

test("beginSimulationStep: the raw step ladder (first frame 0, same instant reused, backwards resets)", () => {
  freshRun();
  approx(beginSimulationStep(0, 0.1), 0);
  approx(beginSimulationStep(0.5, 0.1), 0.1); // clamped
  approx(beginSimulationStep(0.5, 0.1), 0.1); // same instant: the SAME step, no second roll
  approx(beginSimulationStep(0.52, 0.1), 0.02);
  approx(beginSimulationStep(0.1, 0.1), 0); // backwards: reset, and the frame is the initial condition
});

setParticleTimeOverride(null);
setSimulationTimestepOverride(null);
resetSimulation();
console.log(`\n${passed} simulated-state tests passed`);
