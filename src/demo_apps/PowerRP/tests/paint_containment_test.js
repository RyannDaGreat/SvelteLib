/**
 * Tests for THE PER-NODE PAINT BOUNDARY — the generalization of three
 * piecemeal containments into one rule.
 * Plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/paint_containment_test.js
 *
 * ── THE INCIDENT THIS PINS ───────────────────────────────────────────────────
 * User, verbatim: "Oh no, I put it into a crash permaloop — now every time the
 * page loads it crashes."
 *
 * Picking the fill material "crt" (a FILL-ONLY material) on an iconify icon
 * pushed "crt" into a STROKE slot. getStrokeMaterial threw — UNCAUGHT, inside
 * the render loop, on every frame. Autosave then faithfully restored the
 * poisoned document on every boot, so the app was BRICKED across reloads until
 * localStorage was cleared by hand. The source bug is fixed separately; THIS is
 * the armor, and it matters because the same failure class had already shipped
 * twice before under different names:
 *
 *   50a50bc  plugin emit() throws                → red box (emit-time)
 *   ba25b39  non-finite world transform          → red box (emit-time)
 *   d545ddc  unknown material in a stroke slot   → threw in the PAINTER
 *
 * The third proved the first two were too narrow: they guarded EMIT, and this
 * one threw downstream of emit, in paint. So the boundary now sits at the seam
 * where one derived node's ops are PAINTED, which subsumes all three and covers
 * whatever comes fourth.
 *
 * ── WHAT IS ASSERTED, AND WHY EACH ITEM IS NOT OPTIONAL ─────────────────────
 *   1. The owner tag survives flattening (the boundary cannot name an item
 *      without it, and a report that cannot name the item is nearly useless —
 *      the user has to find the poison to delete it).
 *   2. Runs are the right unit: one node's ops group together, and a group's
 *      folded members are attributed to the GROUP (what the user can select).
 *   3. BYTE-IDENTICAL: a healthy scene's IR is unchanged apart from the tag,
 *      and the tag is on push ops only — never on a drawable. Containment that
 *      perturbed a working render would be worse than the bug it fixes.
 *   4. Poison is contained; CONFIGURATION errors still throw. This is the line
 *      that keeps the boundary from becoming the silent-failure machine it
 *      exists to prevent.
 *   5. The exporters degrade the same way (an export of a poisoned deck yields
 *      the deck with a red box, not a thrown export).
 */

import assert from "node:assert/strict";
import { flattenIR, pushTransform, popTransform, rect } from "../render_gpu/ir.js";
import { sceneIR, ownerTag } from "../render_gpu/ports.js";
import {
  ownerRunEnd, containmentBoxSize, errorAffordanceArgs, errorAffordanceIR, errorBoxExtent,
  errorMessage, describeOwner, throwMessage, configurationError, isConfigurationError,
  ERROR_FALLBACK_SIZE, ERROR_BG, ERROR_BORDER, ERROR_TEXT,
} from "../core/paint_containment.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument, foldState, withNormalizedZ } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
async function atest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerPlugins(registry);

/** A document with THE camera plus the given items (repair guarantees a camera). */
function docWith(items) {
  const rep = repairedDocument({
    meta: { name: "containment", slideW: 1280, slideH: 720 },
    slides: [{ id: "s0", name: "Slide 1", delta: { items } }],
  }, registry);
  return rep.doc ?? rep;
}

/** Query. The evaluated + derived + emitted IR — the exact chain every pixel
 *  consumer runs, so a test here is a test of what the app really paints. */
function irOf(doc) {
  return sceneIR(deriveRenderTree(
    evaluateState(foldState(withNormalizedZ(doc), 0, 1), registry, "").state,
    registry, "containment",
  ));
}

const CAM = { type: "camera", x: 0, y: 0, w: 1280, h: 720, z: 0, rotation: 0, scale: 1, active: true };

// ── 1. THE OWNER TAG ────────────────────────────────────────────────────────

test("ownerTag: the minimal identity a paint-time report needs", () => {
  assert.deepEqual(ownerTag({ itemId: "a1", type: "text", state: { name: "Title" } }), { itemId: "a1", type: "text", name: "Title" });
  // NOT the whole node: the tag is copied onto the flattened op stream, and
  // holding a render node there would pin its evaluated state for the life of
  // the display list.
  assert.deepEqual(Object.keys(ownerTag({ itemId: "b", type: "rect", state: {} })).sort(), ["itemId", "name", "type"]);
});

test("flattenIR: the owner tag reaches every op the node emitted", () => {
  const owner = { itemId: "a1", type: "text", name: "Title" };
  const flat = flattenIR([
    { ...pushTransform({ x: 10 }), owner },
    rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" }),
    rect({ x: 0, y: 0, w: 6, h: 6, fill: "#000" }),
    popTransform(),
  ]);
  assert.equal(flat.length, 2);
  for (const f of flat) assert.deepEqual(f.owner, owner, "every op in the run carries its node's identity");
});

test("flattenIR: an INNER push INHERITS the owner (a mirror, a plugin's own frame)", () => {
  const owner = { itemId: "a1", type: "image", name: undefined };
  const flat = flattenIR([
    { ...pushTransform({}), owner },
    pushTransform({ x: 3 }), // the flip's reflection push — no owner of its own
    rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" }),
    popTransform(),
    popTransform(),
  ]);
  assert.deepEqual(flat[0].owner, owner, "a nested frame does not orphan the node's ops");
});

test("flattenIR: an op outside any owned push is honestly UNOWNED, not misattributed", () => {
  // The camera background rect is hand-assembled outside sceneIR. Blaming it on
  // whichever node happened to be adjacent would send the user to delete an
  // innocent item.
  const flat = flattenIR([rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" })]);
  assert.equal(flat[0].owner, null);
});

test("THE REAL PIPELINE: every drawable in a real scene names its item", () => {
  const doc = docWith({
    cam: CAM,
    r1: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true },
    r2: { type: "rect", x: 300, y: 40, w: 80, h: 80, z: 2, rotation: 0, scale: 1, active: true },
  });
  const flat = flattenIR(irOf(doc));
  assert.ok(flat.length >= 2, `expected a painted scene, got ${flat.length} drawables`);
  for (const f of flat) assert.ok(f.owner?.itemId, `an unowned drawable would be unattributable: ${JSON.stringify(f.cmd).slice(0, 60)}`);
  const ids = new Set(flat.map((f) => f.owner.itemId));
  assert.ok(ids.has("r1") && ids.has("r2"), `both items must be represented, got ${[...ids]}`);
});

// ── 2. THE RUN IS THE UNIT ──────────────────────────────────────────────────

test("ownerRunEnd: one node's ops are ONE contiguous run", () => {
  const f = [{ owner: { itemId: "a" } }, { owner: { itemId: "a" } }, { owner: { itemId: "b" } }];
  assert.equal(ownerRunEnd(f, 0), 2);
  assert.equal(ownerRunEnd(f, 2), 3);
  // A run always advances — a non-advancing run would spin the boundary forever.
  for (let i = 0; i < f.length; i++) assert.ok(ownerRunEnd(f, i) > i);
});

test("ownerRunEnd: untagged ops form a run of their own", () => {
  assert.equal(ownerRunEnd([{ owner: null }, { owner: null }, { owner: { itemId: "a" } }], 0), 2);
});

test("RUNS PARTITION the whole list — no op can be skipped or painted twice", () => {
  const doc = docWith({
    cam: CAM,
    r1: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true },
    t1: { type: "text", x: 40, y: 60, w: 200, h: 40, z: 2, rotation: 0, scale: 1, active: true, text: "hi" },
  });
  const flat = flattenIR(irOf(doc));
  let i = 0;
  const covered = [];
  while (i < flat.length) {
    const end = ownerRunEnd(flat, i);
    for (let k = i; k < end; k++) covered.push(k);
    i = end;
  }
  assert.deepEqual(covered, flat.map((_, k) => k), "the runs must tile the list exactly once");
});

test("containmentBoxSize: takes the run's own extent, or a VISIBLE fallback", () => {
  assert.deepEqual(containmentBoxSize([{ cmd: { op: "rect", w: 300, h: 120 } }], 0, 1), { w: 300, h: 120 });
  assert.deepEqual(containmentBoxSize([{ cmd: { op: "path", d: "M0 0" } }], 0, 1), { w: ERROR_FALLBACK_SIZE, h: ERROR_FALLBACK_SIZE });
  // A POISONED extent is refused exactly as a missing one is — otherwise the
  // affordance would inherit the very numbers that broke the node.
  assert.deepEqual(containmentBoxSize([{ cmd: { op: "rect", w: NaN, h: 40 } }], 0, 1), { w: ERROR_FALLBACK_SIZE, h: ERROR_FALLBACK_SIZE });
  assert.deepEqual(containmentBoxSize([{ cmd: { op: "rect", w: -5, h: 40 } }], 0, 1), { w: ERROR_FALLBACK_SIZE, h: ERROR_FALLBACK_SIZE });
});

// ── 3. BYTE-IDENTICAL — containment must not perturb a working render ───────

test("BYTE-IDENTICAL: the tag rides PUSH ops only, never a drawable", () => {
  const doc = docWith({
    cam: CAM,
    r1: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true },
  });
  const ir = irOf(doc);
  for (const cmd of ir) {
    if (cmd.op === "pushTransform") continue;
    assert.ok(!("owner" in cmd), `a drawable gained a field: ${JSON.stringify(cmd).slice(0, 80)}`);
  }
  // and the push ops keep their exact similarity shape besides the tag
  for (const cmd of ir.filter((c) => c.op === "pushTransform")) {
    for (const k of ["x", "y", "rotation", "scale"]) assert.equal(typeof cmd[k], "number");
  }
});

test("BYTE-IDENTICAL: a healthy scene's DRAWABLES are unchanged, and it really painted", () => {
  const doc = docWith({
    cam: CAM,
    r1: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true },
  });
  const a = irOf(doc), b = irOf(doc);
  assert.deepEqual(a, b, "determinism first: the same document must emit the same IR");
  const drawables = flattenIR(a);
  assert.ok(drawables.some((f) => f.cmd.op === "rect"), "not a vacuous comparison — the rect is really there");
  // no affordance anywhere in a healthy scene
  assert.ok(!drawables.some((f) => f.cmd.op === "text" && /failed to (paint|export)/.test(String(f.cmd.text))));
});

test("BYTE-IDENTICAL: the flattened WORLD of every op is untouched by the tag", () => {
  // The tag rides the push OBJECT; if it leaked into the composed transform, a
  // rotation or scale could change. Compose two levels and check the math.
  const flat = flattenIR([
    { ...pushTransform({ x: 10, y: 5, rotation: 0.25, scale: 2 }), owner: { itemId: "a" } },
    pushTransform({ x: 3, y: 0 }),
    rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" }),
    popTransform(), popTransform(),
  ]);
  const bare = flattenIR([
    pushTransform({ x: 10, y: 5, rotation: 0.25, scale: 2 }),
    pushTransform({ x: 3, y: 0 }),
    rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" }),
    popTransform(), popTransform(),
  ]);
  assert.deepEqual(flat[0].world, bare[0].world, "the owner tag must be invisible to the transform math");
});

// ── 4. THE AFFORDANCE, shared by all three backends ─────────────────────────

test("errorAffordanceIR: a red box that NAMES the failure", () => {
  const ops = errorAffordanceIR(200, 100, errorMessage("Title", "failed to paint"));
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, "rect");
  assert.equal(ops[1].op, "text");
  assert.match(ops[1].text, /Title/, "the box must name the item — the user has to find it to delete it");
  assert.match(ops[1].text, /failed to paint/);
  // finite geometry: an affordance that is itself unpaintable would re-enter the
  // very catch that produced it.
  for (const op of ops) for (const k of ["x", "y"]) assert.ok(Number.isFinite(op[k]));
  assert.ok(ops[0].w > 0 && ops[0].h > 0);
});

await atest("THE PALETTE IS PARSED, and agrees with parseColor exactly", async () => {
  // THE BUG THIS PINS, caught by the export parity suite during development: the
  // affordance was first written with HEX strings. parsePaint accepts hex, but an
  // op that reaches a backend WITHOUT going through parsePaint draws NOTHING —
  // the PDF and SVG writers index a colour array. The contained item VANISHED
  // instead of turning red: the containment mechanism failing in exactly the
  // silent way it exists to prevent.
  //
  // core/ may not import render_gpu, so the palette is stored pre-parsed. That is
  // a duplication with a drift risk, and this is the pin that makes the drift
  // LOUD: if either the hex source or parseColor changes, this fails.
  const { parseColor } = await import("../render_gpu/ir.js");
  assert.deepEqual(ERROR_BG, parseColor("#f6c9c4"));
  assert.deepEqual(ERROR_BORDER, parseColor("#c0392b"));
  assert.deepEqual(ERROR_TEXT, parseColor("#7a1210"));
  // and the ops really carry the ARRAY form, not a string
  const [box, label] = errorAffordanceIR(100, 50, "boom");
  for (const paint of [box.fill, box.stroke, label.color])
    assert.ok(Array.isArray(paint), `a hex string here draws an INVISIBLE box: ${JSON.stringify(paint)}`);
});

test("errorAffordanceArgs: the render_gpu form is the SAME shape, for the IR builders", () => {
  const a = errorAffordanceArgs(200, 100, "boom");
  assert.deepEqual(a.rect.fill, ERROR_BG);
  assert.deepEqual(a.rect.stroke, ERROR_BORDER);
  assert.deepEqual(a.text.color, ERROR_TEXT);
  assert.equal(a.text.text, "boom");
  // the label always fits inside its own box
  assert.ok(a.text.boxW < a.rect.w && a.text.boxH < a.rect.h);
});

test("errorBoxExtent: never 0-sized (an invisible affordance is a silent failure)", () => {
  assert.equal(errorBoxExtent(240), 240);
  for (const bad of [NaN, 0, -3, undefined, null, "240"]) assert.equal(errorBoxExtent(bad), ERROR_FALLBACK_SIZE, `${bad} must fall back`);
});

test("describeOwner / throwMessage: always produce SOMETHING to blame", () => {
  assert.equal(describeOwner({ itemId: "cf17", type: "text", state: { name: "Title" } }), "Title");
  assert.equal(describeOwner({ itemId: "cf17", type: "text" }), "text cf17");
  assert.equal(describeOwner(null), "unknown item");
  assert.equal(throwMessage(new Error('unknown material "crt"')), 'unknown material "crt"');
  assert.equal(throwMessage("plain string throw"), "plain string throw");
  // a nameless throw must not produce an empty red box that explains nothing
  for (const bad of [null, undefined, ""]) assert.equal(throwMessage(bad), "unknown error");
});

// ── 5. THE LINE: poison is contained, CONFIGURATION still throws ────────────

test("configurationError: the caller's wiring is marked, and only that", () => {
  assert.equal(isConfigurationError(configurationError(new Error("no rasterize callback"))), true);
  assert.equal(isConfigurationError(new Error('unknown material "crt"')), false);
  assert.equal(isConfigurationError("a bare string throw"), false);
  assert.equal(isConfigurationError(null), false);
  // it returns the SAME object, so `throw configurationError(new Error(...))` reads naturally
  const e = new Error("x");
  assert.equal(configurationError(e), e);
});

// ── 6. THE POISON, through the real painter contract ────────────────────────

/** A minimal CanvasKit-shaped stub: enough for paintFlat's save/restore
 *  bookkeeping and leaf dispatch, with a POISONED op that throws like
 *  getStrokeMaterial did. Bare node has no CanvasKit, and the point here is the
 *  BOUNDARY's control flow, which is backend-independent. */
function stubCanvas() {
  let saves = 0;
  return {
    drawn: [],
    getSaveCount: () => saves,
    save() { saves++; },
    restore() { saves--; },
    translate() {}, rotate() {}, scale() {}, clear() {},
  };
}

test("THE USER'S SEQUENCE, in miniature: a throwing run costs ITSELF, not the scene", () => {
  // The control flow paintNodeRun implements, exercised directly: run A paints,
  // run B throws mid-save (like a material handler that saved then failed), run
  // C must still paint AND must see a clean save stack.
  const canvas = stubCanvas();
  const flat = [
    { cmd: { op: "rect", id: "A", w: 10, h: 10 }, world: {}, owner: { itemId: "A", type: "rect" } },
    { cmd: { op: "rect", id: "B", w: 10, h: 10 }, world: {}, owner: { itemId: "B", type: "rect" } },
    { cmd: { op: "rect", id: "C", w: 10, h: 10 }, world: {}, owner: { itemId: "C", type: "rect" } },
  ];
  const painted = [];
  let i = 0;
  while (i < flat.length) {
    const end = ownerRunEnd(flat, i);
    const saveCount = canvas.getSaveCount();
    try {
      for (let k = i; k < end; k++) {
        if (flat[k].cmd.id === "B") { canvas.save(); throw new Error('unknown stroke material "crt"'); }
        painted.push(flat[k].cmd.id);
      }
    } catch (e) {
      while (canvas.getSaveCount() > saveCount) canvas.restore();
      painted.push(`[${describeOwner(flat[i].owner)}: ${throwMessage(e)}]`);
    }
    i = end;
  }
  assert.deepEqual(painted, ["A", "[rect B: unknown stroke material \"crt\"]", "C"]);
  assert.equal(canvas.getSaveCount(), 0, "a failed run must not leave the canvas half-saved — the next node would inherit a corrupt CTM");
});

test("A GROUP's folded members are attributed to the GROUP (what the user can delete)", () => {
  // The report exists so the user can act on it. Naming a folded member sends
  // them looking for something the outliner does not show at top level.
  const owner = { itemId: "g1", type: "group", name: "Group" };
  const flat = flattenIR([
    { ...pushTransform({}), owner },
    pushTransform({ x: 5 }), // a member's own world, emitted inside the group's run
    rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" }),
    popTransform(),
    popTransform(),
  ]);
  assert.equal(flat[0].owner.itemId, "g1");
  assert.equal(ownerRunEnd(flat, 0), flat.length, "the whole subtree is ONE run");
});

await atest("NESTED: a subtree's content carries its OWN owner runs (the boundary nests)", async () => {
  // An effectSubtree / cropSubtree's `content` is flattened INDEPENDENTLY by a
  // nested paintFlat call, so the boundary has to work at every level: an inner
  // failure must be named for the INNER item, while a failure of the subtree op
  // itself is caught by the outer run and named for the group. Without owner tags
  // surviving into `content`, every nested failure would be blamed on the wrapper.
  const { effectSubtree } = await import("../render_gpu/ir.js");
  const content = [
    { ...pushTransform({}), owner: { itemId: "inner", type: "rect", name: undefined } },
    rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" }),
    popTransform(),
  ];
  const sub = effectSubtree({
    x: 0, y: 0, w: 10, h: 10, content,
    shadow: { dx: 2, dy: 2, blur: 3, color: "#000", opacity: 0.5 },
    bloom: null, blend: "normal", innerShadow: null, softEdges: 0,
  });
  const outer = flattenIR([{ ...pushTransform({}), owner: { itemId: "outerGroup", type: "group", name: undefined } }, sub, popTransform()]);
  assert.equal(outer[0].owner.itemId, "outerGroup", "the subtree op belongs to its wrapper");
  const inner = flattenIR(outer[0].cmd.content);
  assert.equal(inner[0].owner.itemId, "inner", "the nested walk gets the INNER item's identity, not the wrapper's");
});

console.log(`\n${passed} passed`);
