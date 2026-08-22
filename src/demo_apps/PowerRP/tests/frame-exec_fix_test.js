/**
 * THE FRAME DOMAIN'S REGRESSION PINS — three defects that all shared one shape: the
 * frame walk asked a question of the WHOLE ITEM ROSTER that it meant to ask of the
 * PATCH, and the wrong answer was a plausible picture rather than an error.
 *
 * Separate from tests/execframe_test.js on purpose — that file pins the LAWS
 * (Δt = 0, framerate independence, the strided-shard landmine), and these pin the
 * three measured failures those laws did not catch. Each check below FAILED before
 * the fix it names and states what the wrong answer looked like, because none of
 * them looked like a failure at the time: a false cycle report, a silently dead
 * chain, one wire carrying two numbers, and a sound plugin refused at import.
 *
 * Bare node, no browser: everything here is core.
 */

import assert from "node:assert";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { FRAME_STEP_BUDGET, frameOutputsSlotKey, stepFrameDomain } from "../core/exec_frame.js";
import { execKindProblem } from "../core/exec_flow.js";
import { beginSimulationStep, resetSimulation, setSimulationTimestepOverride } from "../core/simulation_history.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";

const registry = createRegistry();
registerPlugins(registry);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Frames per second the walks below run at — one ordinary display rate, since
 *  nothing here is testing the cadence (tests/execframe_test.js pins that). */
const FPS = 60;

/**
 * Command (advances the ambient simulation history). Walks `frames` frames of the
 * frame domain over `items`, exactly as an exporter does — a DICTATED timestep and a
 * per-frame clock override — calling `before(items, f)` at the top of each frame so a
 * test can drive an input, and returning every frame's `stepFrameDomain` result.
 */
function walk(items, frames, before) {
  resetSimulation();
  setSimulationTimestepOverride(1 / FPS);
  const results = [];
  for (let f = 0; f < frames; f++) {
    setParticleTimeOverride(f / FPS);
    const dt = beginSimulationStep(f / FPS, 0.1);
    before?.(items, f);
    results.push(stepFrameDomain(items, registry, dt));
  }
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
  return results;
}

/** Query (installs and removes console traps). Runs `fn` with console.warn/error
 *  captured, and returns what it wrote. `reportOnce` is the surface under test and it
 *  writes to the console; a check that could not read it could not tell a correct
 *  silence from a report nobody looked at. */
function reportsDuring(fn) {
  const lines = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = console.error = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines;
}

/** A Schmitt trigger firing an Increment, plus `n` plain rects that are in the
 *  document and in NO patch — the shape the budget used to be spent by. `level` is
 *  the trigger's watched number, driven from the walk. */
function chainBesideRects(n) {
  const items = {};
  // Zero-padded and alphabetically BEFORE the two nodes, because `topoOrder` sorts
  // unconnected items by id: the rects must sweep first or they cannot exhaust
  // anything before the chain runs.
  for (let i = 0; i < n; i++) items[`r${String(i).padStart(5, "0")}`] = { type: "rect", x: 0, y: 0, w: 10, h: 10 };
  items.zs = { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 0, inputs: {}, exec: { then: { item: "zi", port: "run" } } };
  items.zi = { type: "node_increment", start: 0, step: 1, inputs: {}, exec: {} };
  return items;
}

console.log("exec_frame: THE BUDGET COUNTS PULSES, NOT ITEMS");

check("a deck with more items than the budget still runs its chain, silently", () => {
  // THE MEASURED FAILURE, in two stages, both on a document with NO exec cycle:
  //   ~500 items — the sweep spent the budget partway through, so the chain still
  //     fired but `reportOnce` accused the author of a cycle in their exec wires.
  //   >2× the budget — the sweep spent it BEFORE either node was reached, so the
  //     Schmitt never latched and the counter never advanced. No error, no picture,
  //     nothing to look at: a dead patch on a deck whose only crime was being large.
  for (const n of [FRAME_STEP_BUDGET - 400, FRAME_STEP_BUDGET + 100, FRAME_STEP_BUDGET * 2 + 100]) {
    const items = chainBesideRects(n);
    let out;
    const lines = reportsDuring(() => {
      out = walk(items, 3, (it, f) => { it.zs.level = f >= 1 ? 1 : 0; });
    });
    assert.deepEqual(out[1].fired.zs, ["then"], `${n} rects: the trigger must still fire`);
    assert.equal(out[2].outputs.zi?.out, 1, `${n} rects: the counter must have advanced exactly once`);
    assert.deepEqual(lines, [], `${n} rects: a deck with no exec cycle must produce no report`);
  }
});

check("the budget is still a real ceiling on a runaway fan-out", () => {
  // The other direction, and it matters as much: a budget that can no longer be
  // reached is not a ceiling, it is a dead constant. A chain of Set Vars each firing
  // the next is one pulse per link, so a chain longer than the budget must be cut off
  // and REPORTED — and the report must not blame a cycle, because a node steps at
  // most once per frame and therefore cannot loop.
  const items = {
    src: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 0, inputs: {}, exec: { then: { item: "n00000", port: "run" } } },
  };
  const links = FRAME_STEP_BUDGET + 50;
  for (let i = 0; i < links; i++) {
    const id = `n${String(i).padStart(5, "0")}`;
    const next = i + 1 < links ? { then: { item: `n${String(i + 1).padStart(5, "0")}`, port: "run" } } : {};
    items[id] = { type: "node_set_var", initial: 0, value: i, inputs: {}, exec: next };
  }
  let out;
  // The trigger's first step ADOPTS the side of the band its input is already on
  // (plugins/node_schmitt.js), so the pulse has to be a rise on the second frame.
  const lines = reportsDuring(() => { out = walk(items, 2, (it, f) => { it.src.level = f >= 1 ? 1 : 0; }); });
  assert.deepEqual(out[1].fired.src, ["then"], "the trigger fired, so the walk really ran");
  assert.equal(out[1].outputs.n00000?.out, 0, "and the head of the chain latched");
  assert.equal(lines.length, 1, `a chain of ${links} pulses must be reported once`);
  assert.match(lines[0], /size limit, not a cycle/, "and the sentence must not send the reader hunting for a cycle");
});

console.log("exec_frame: A LATCH THAT WAS NOT PULSED HOLDS, FOR EVERY READER");

check("a frame SOURCE reads a chain-driven node's HELD value, not its port zero", () => {
  // ONE WIRE CARRIED TWO NUMBERS. Phase 1 steps only nodes WITHOUT an exec input, so
  // a Set Var the chain did not reach this frame was still unresolved when a Schmitt
  // trigger downstream of it read it — and an unresolved read falls through to
  // `portZero`. MEASURED: the display beside it showed the latched 5 while the
  // trigger saw 0, RELEASED, and fired on a frame nothing had changed.
  const items = {
    a: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 0, inputs: {}, exec: { then: { item: "p", port: "run" } } },
    p: { type: "node_set_var", initial: 0, value: 5, inputs: {}, exec: {} },
    b: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "both", level: 0, inputs: { in: { item: "p", port: "out" } }, exec: {} },
  };
  // `a` fires on frame 1 only; from frame 2 on, `p` is holding and nothing moves.
  const out = walk(items, 4, (it, f) => { it.a.level = f === 1 ? 1 : 0; });
  assert.equal(out[1].outputs.p.out, 5, "the pulse latched the knob");
  assert.deepEqual(out[1].fired.b, ["then"], "and the watching trigger saw the 0 → 5 rise on the frame it happened");
  for (const f of [2, 3]) {
    assert.equal(out[f].outputs.p.out, 5, `frame ${f}: the unpulsed Set Var still holds 5`);
    assert.equal(out[f].outputs.b.state, 1, `frame ${f}: so the trigger watching it must stay HIGH`);
    assert.equal(out[f].fired.b, undefined, `frame ${f}: and must not fire on a wire whose value did not move`);
  }
});

check("the held value is the PREVIOUS frame's, so Δt = 0 cannot advance it", () => {
  // The seed reads `prev`, which rolls only when the clock moves — so the three
  // evaluations web/CanvasView.svelte performs on a hover must produce one answer.
  // A seed read from `cur` would let each pass see the last one's publication.
  const items = {
    a: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 1, inputs: {}, exec: { then: { item: "p", port: "run" } } },
    p: { type: "node_set_var", initial: 0, value: 7, inputs: {}, exec: {} },
    b: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "both", level: 0, inputs: { in: { item: "p", port: "out" } }, exec: {} },
  };
  resetSimulation();
  setSimulationTimestepOverride(1 / FPS);
  setParticleTimeOverride(0);
  stepFrameDomain(items, registry, beginSimulationStep(0, 0.1));
  setParticleTimeOverride(1 / FPS);
  const dt = beginSimulationStep(1 / FPS, 0.1);
  const three = [0, 1, 2].map(() => stepFrameDomain(items, registry, dt));
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
  assert.deepEqual(three[1], three[0], "the second evaluation of one frame must equal the first");
  assert.deepEqual(three[2], three[0], "and so must the third");
});

check("a DELETED node holds nothing — its reader falls back to the port's zero", () => {
  // The other side of the same rule, and the seeding got it wrong at first: the
  // history table outlives `active: false`, so a node the author deleted went on
  // feeding its last value to a frame-domain reader while `evaluateNodeGraph` —
  // which skips an inactive item outright — fed the canvas the port's zero. One wire,
  // two numbers again, arrived at from the opposite direction.
  const items = {
    a: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 0, inputs: {}, exec: { then: { item: "p", port: "run" } } },
    p: { type: "node_set_var", initial: 0, value: 5, inputs: {}, exec: {} },
    b: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "both", level: 0, inputs: { in: { item: "p", port: "out" } }, exec: {} },
  };
  const DELETED_ON = 3;
  const out = walk(items, 5, (it, f) => {
    it.a.level = f === 1 ? 1 : 0;
    if (f === DELETED_ON) it.p.active = false;
  });
  assert.equal(out[2].outputs.b.state, 1, "while it is alive the latch holds the trigger HIGH");
  assert.equal(out[DELETED_ON].outputs.p, undefined, "a deleted node publishes nothing");
  assert.equal(out[DELETED_ON].outputs.b.state, 0, "so its reader sees the port's zero, exactly as the node graph does");
});

check("the held-outputs slot cannot be spelled by an author's equation", () => {
  // Same guarantee `frameSlotKey` carries and for the same reason: a leading double
  // underscore is not a legal display slug, so no equation can read or write it.
  assert.equal(frameOutputsSlotKey("a1"), "items.a1.__frameOut");
  assert.notEqual(frameOutputsSlotKey("a1"), frameOutputsSlotKey("a2"));
});

console.log("exec_flow: A STATEFUL NODE NEED NOT HAVE EXEC PINS");

check("a frameStep node with no exec ports is sound, not refused for a hook it lacks", () => {
  // `frameStep` returns `{state?, fired?, outputs?}` with every field optional, so an
  // integrator that carries state and publishes one DATA output is a legal frame
  // node. The gate counted `frameStep` as an `execEvent`-shaped predicate and refused
  // it — with a sentence naming an `execEvent` it does not declare, which points at
  // the wrong fix. tests/exec_flow_test.js sweeps every REGISTERED plugin through
  // this gate and could not catch it: today's roster happens to have no such widget.
  const integrator = {
    type: "integrator",
    defaults: {},
    ports: () => ({ inputs: [{ key: "in", type: "number" }], outputs: [{ key: "out", type: "number" }] }),
    frameStep: () => ({}),
  };
  assert.equal(execKindProblem(integrator), null);
  // …and the refusal the sentence is actually FOR still fires: `execEvent`'s whole
  // contract is "return true and my exec output fires", so declaring it with no exec
  // output really is a predicate nothing can hear.
  const deaf = { type: "deaf", defaults: {}, ports: () => ({ outputs: [{ key: "out", type: "number" }] }), execEvent: () => true };
  assert.match(execKindProblem(deaf), /no exec output port/);
});

console.log(`\nframe-exec fixes: ${passed} checks passed`);
