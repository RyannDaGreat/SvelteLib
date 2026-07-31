/**
 * Tests for THE EMIT-TIME CONTAINMENT BOUNDARY (render_gpu/ports.js emitNode) —
 * paint_containment's per-node paint boundary, one seam EARLIER.
 * Plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/emit_containment_test.js
 *
 * ── THE HOLE THIS PINS ───────────────────────────────────────────────────────
 * The paint boundary (render_gpu/skia/paint_skia.js paintNodeRun) wraps the
 * PAINTER; it cannot catch a throw that happens earlier, inside a plugin's own
 * emit(). Observed live: demo_god_rays's emit() calls materialBackdrop() with a
 * NaN lightOffsetX param, and the BUILDER throws ("materialBackdrop: param
 * \"lightOffsetX\" is a non-finite number") — inside sceneIR, before paint_skia
 * ever runs. That throw used to escape emitNode -> sceneIR -> every consumer
 * (CanvasView's paint effect, gpuService thumbnails, cli/render_job, the PDF/SVG
 * exporters), killing the WHOLE canvas over one widget's bad number, every frame,
 * exactly the disease paint_containment.js was built to end.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 *   1. A poisoned node's emit() failure is contained: sceneIR does not throw,
 *      the node becomes a red-box affordance, and the NEXT node's ops are intact.
 *   2. CONFIGURATION errors (a plugin with no emit() at all — broken wiring, not
 *      document poison) still ESCAPE, exactly like the paint boundary's rule.
 *   3. The failure is reported ONCE per node+message (reportOnce), not once per
 *      frame — three sceneIR calls over the same poisoned node log one line.
 *   4. A FLIPPED poisoned node's affordance still carries the mirror reflection
 *      (the box's own geometry is not the poison; only mirrorPush is safe to
 *      keep running inside the catch, unlike node.world which the sibling
 *      non-finite-transform branch must draw at identity).
 *   5. A GROUP's folded member poisons only itself — the group and its other
 *      members still render, because emitNode recurses per member and each
 *      recursive call gets its OWN boundary.
 */

import assert from "node:assert/strict";
import { pushTransform, popTransform, rect, isReflected } from "../render_gpu/ir.js";
import { sceneIR } from "../render_gpu/ports.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument, foldState, withNewItem, withNormalizedZ } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * A registry with one extra widget type, "poison_emit", whose emit() throws
 * whenever its state carries `shouldThrow: true` — the shape of the live
 * defect (a plugin calling a validating IR builder with a bad number) without
 * pinning this suite to god_rays' own params. `throwsConfig: true` instead
 * throws a plugin-with-no-emit()-shaped configuration error, so the "broken
 * engine" half of the rule is exercised through the SAME registry.
 */
function registryWithPoisonPlugin() {
  const registry = createRegistry();
  registerPlugins(registry);
  registry.register({
    type: "poison_emit",
    title: "Poison (test-only)",
    capabilities: { bbox: true, transform: true, resizable: true },
    defaults: { type: "poison_emit", x: 0, y: 0, w: 80, h: 60, z: 0, rotation: 0, scale: 1, shouldThrow: false },
    inspector: [],
    emit(state) {
      if (state.shouldThrow) throw new Error(`poison_emit: param "level" is a non-finite number (NaN)`);
      return [rect({ x: 0, y: 0, w: state.w, h: state.h, fill: "#22aa55" })];
    },
  });
  return registry;
}

const CAM = { type: "camera", x: 0, y: 0, w: 1280, h: 720, z: 0, rotation: 0, scale: 1, active: true };

/** A document with THE camera plus the given items (repair guarantees a camera). */
function docWith(registry, items) {
  const rep = repairedDocument({
    meta: { name: "emit-containment", slideW: 1280, slideH: 720 },
    slides: [{ id: "s0", name: "Slide 1", delta: { items } }],
  }, registry);
  return rep.doc ?? rep;
}

/** Query. The evaluated + derived + emitted IR — the exact chain every pixel
 *  consumer runs, so a test here is a test of what the app really paints. */
function irOf(registry, doc) {
  return sceneIR(deriveRenderTree(
    evaluateState(foldState(withNormalizedZ(doc), 0, 1), registry, "").state,
    registry, "emit-containment",
  ));
}

// ── 1. THE POISON IS CONTAINED, THE SIBLING SURVIVES ────────────────────────

test("sceneIR: an emit() throw does not escape — the item becomes a red box", () => {
  const registry = registryWithPoisonPlugin();
  const doc = docWith(registry, {
    cam: CAM,
    poison: { type: "poison_emit", x: 100, y: 100, w: 80, h: 60, z: 1, rotation: 0, scale: 1, active: true, shouldThrow: true },
  });
  let ir;
  assert.doesNotThrow(() => { ir = irOf(registry, doc); }, "a poisoned emit() must not throw out of sceneIR");
  assert.ok(ir.some((o) => o.op === "text" && /poison_emit: param/.test(String(o.text))), "the affordance must carry the real error message");
  assert.ok(ir.some((o) => o.op === "rect" && o.stroke), "a red-bordered box must be drawn");
});

test("sceneIR: the HEALTHY sibling's ops survive its neighbour's poison", () => {
  const registry = registryWithPoisonPlugin();
  const healthyOnly = irOf(registry, docWith(registry, {
    cam: CAM,
    good: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true, fill: "#7aa2f7" },
  }));
  const withPoison = irOf(registry, docWith(registry, {
    cam: CAM,
    good: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true, fill: "#7aa2f7" },
    poison: { type: "poison_emit", x: 300, y: 100, w: 80, h: 60, z: 2, rotation: 0, scale: 1, active: true, shouldThrow: true },
  }));
  for (const op of healthyOnly) assert.ok(withPoison.some((o) => JSON.stringify(o) === JSON.stringify(op)), `lost a healthy op: ${JSON.stringify(op).slice(0, 80)}`);
});

test("sceneIR: the owner tag on the red box names the failed item", () => {
  const registry = registryWithPoisonPlugin();
  const ir = irOf(registry, docWith(registry, {
    cam: CAM,
    poison: { type: "poison_emit", name: "Broken Widget", x: 0, y: 0, w: 80, h: 60, z: 1, rotation: 0, scale: 1, active: true, shouldThrow: true },
  }));
  const push = ir.find((o) => o.op === "pushTransform" && o.owner?.itemId);
  assert.ok(push, "the contained run must still carry an owner tag");
  assert.equal(push.owner.type, "poison_emit");
});

// ── 2. CONFIGURATION ERRORS ESCAPE, EXACTLY LIKE THE PAINT BOUNDARY ─────────

test("sceneIR: a plugin with NO emit() is a CONFIGURATION error, and still throws", () => {
  assert.throws(
    () => sceneIR([{ itemId: "x", type: "hologram", plugin: {}, state: {}, world: { x: 0, y: 0, rotation: 0, scale: 1 } }]),
    /no emit/,
    "a broken registry entry is the caller's wiring, not document poison — it must stay loud",
  );
});

// ── 3. ONCE-PER-NODE LOGGING, NOT ONCE-PER-FRAME ────────────────────────────

test("emit containment: the failure is reported ONCE per node+message across repeated frames", () => {
  const registry = registryWithPoisonPlugin();
  // A fresh itemId (repairedDocument assigns one per item key) keeps this test's
  // reportOnce key from colliding with an earlier test's "poison" node in the
  // SAME process-wide dedup set (core/report.js's `reported` Set never resets).
  const doc = docWith(registry, {
    cam: CAM,
    onceProbe: { type: "poison_emit", x: 0, y: 0, w: 80, h: 60, z: 1, rotation: 0, scale: 1, active: true, shouldThrow: true },
  });
  const originalError = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    irOf(registry, doc); // frame 1
    irOf(registry, doc); // frame 2 — same node, same message
    irOf(registry, doc); // frame 3
  } finally {
    console.error = originalError;
  }
  const failureLines = lines.filter((l) => /failed to EMIT/.test(l));
  assert.equal(failureLines.length, 1, `expected exactly one report across 3 frames, got ${failureLines.length}: ${JSON.stringify(lines)}`);
});

// ── 4. THE MIRROR STILL APPLIES TO A FLIPPED POISONED NODE ──────────────────

test("emit containment: a FLIPPED poisoned node's red box still carries the reflection", () => {
  const registry = registryWithPoisonPlugin();
  const doc = docWith(registry, {
    cam: CAM,
    // w < 0 is the flip spelling (core/geometry.normalizedBox / derive.js).
    poison: { type: "poison_emit", x: 100, y: 100, w: -80, h: 60, z: 1, rotation: 0, scale: 1, active: true, shouldThrow: true },
  });
  const ir = irOf(registry, doc);
  assert.ok(ir.some((o) => o.op === "text" && /poison_emit: param/.test(String(o.text))), "still contained");
  assert.ok(ir.some((o) => o.op === "pushTransform" && isReflected(o)), "a flipped widget's error box must still reflect — the sign is not the poison");
});

test("emit containment: an UNFLIPPED poisoned node's red box carries NO reflection", () => {
  const registry = registryWithPoisonPlugin();
  const ir = irOf(registry, docWith(registry, {
    cam: CAM,
    poison: { type: "poison_emit", x: 100, y: 100, w: 80, h: 60, z: 1, rotation: 0, scale: 1, active: true, shouldThrow: true },
  }));
  assert.ok(!ir.some((o) => o.op === "pushTransform" && isReflected(o)), "no spurious reflection on a plain box");
});

// ── 5. A GROUP MEMBER'S POISON COSTS ITSELF, NOT THE GROUP ──────────────────

test("emit containment: a poisoned GROUP MEMBER shows its own red box; the group's other member survives", () => {
  const registry = registryWithPoisonPlugin();
  const doc = docWith(registry, {
    cam: CAM,
    grp: { type: "group", x: 0, y: 0, w: 400, h: 300, z: 1, rotation: 0, scale: 1, active: true, members: ["good", "poison"] },
    good: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 0, rotation: 0, scale: 1, active: true, fill: "#7aa2f7", parent: "grp" },
    poison: { type: "poison_emit", x: 200, y: 20, w: 80, h: 60, z: 0, rotation: 0, scale: 1, active: true, shouldThrow: true, parent: "grp" },
  });
  let ir;
  assert.doesNotThrow(() => { ir = irOf(registry, doc); }, "a poisoned group member must not take the group or the scene down");
  assert.ok(ir.some((o) => o.op === "rect" && o.fill && Array.isArray(o.fill)), "the group's healthy member must still paint");
  assert.ok(ir.some((o) => o.op === "text" && /poison_emit: param/.test(String(o.text))), "the poisoned member must show its own red box");
});

console.log(`\n${passed} passed`);
