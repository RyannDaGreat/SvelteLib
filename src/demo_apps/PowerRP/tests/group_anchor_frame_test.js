/**
 * THE ANCHOR-READ FRAME 2x2 — which frame does a cross-item anchor reference
 * land in when the READER is itself a group member?
 * Run: node src/demo_apps/PowerRP/tests/group_anchor_frame_test.js
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS A 2x2 ────────────────────────────────
 * Two independent mechanisms bind one widget's geometry to another's:
 *
 *   NAMED ANCHOR   `= @box_tl.x`      core/expressions.js anchorValue
 *   CLOSEST RIM    `= @box_closest.x` core/expressions.js closestSugar
 *
 * and each of them is read by a widget that is either INSIDE the group owning
 * the target or OUTSIDE it. That is four cases, and measurement (W3-P,
 * 2026-08-01) found they were NOT uniform: the two mechanisms were broken in
 * exactly complementary cells.
 *
 *   ref kind      reader OUTSIDE group   reader INSIDE group
 *   named anchor  correct                influence applied TWICE
 *   closest rim   influence NEVER applied correct
 *
 * The in-group named-anchor cell is FIXED (core/expressions.js inReaderFrame);
 * this file is its gate. The outside-reader closest-rim cell is a KNOWN OPEN
 * DEFECT, filed as todo #227, and it is REPORTED here rather than asserted —
 * see the closing block for why an assertion would be the wrong instrument.
 *
 * ── WHY THE EXISTING GATE MISSED IT ──────────────────────────────────────────
 * tests/group_anchor_probe.js built this exact scenario for Round 17 and its
 * probe rect is deliberately NOT in `members` (its scene() lists only the two
 * member rects). So it pinned the one cell that works. A 2x2 with two cells
 * tested reads as a tested 2x2 — which is the general lesson, and the reason
 * this file states all four cases explicitly even though only three assert.
 *
 * ── WHAT "CORRECT" MEANS HERE, STATED AS GEOMETRY ────────────────────────────
 * A widget bound to another's anchor is CORRECT iff its painted position equals
 * the target's painted anchor. Not "iff the stored number is X" — the stored
 * number is frame-dependent and is exactly what was wrong. So every assertion
 * below compares two DERIVED worlds, which is the only frame both sides share.
 */

import assert from "node:assert/strict";
import * as T from "../core/transform.js";
import { createRegistry } from "../core/registry.js";
import { evaluateState, inReaderFrame } from "../core/expressions.js";
import { deriveRenderTree, nodeAnchors } from "../core/derive.js";
import { rectPlugin } from "../plugins/rect.js";
import { plaintextPlugin } from "../plugins/plaintext.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { groupPlugin } from "../plugins/group.js";

const registry = createRegistry();
for (const p of [rectPlugin, plaintextPlugin, arrowPlugin, groupPlugin]) registry.register(p);

let passed = 0;
let reported = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
/** Command. Records a KNOWN-DEFECT cell: named, counted, and never asserted. */
function known(todo, name, detail) {
  reported++;
  console.log(`  !!  KNOWN DEFECT (todo ${todo}) ${name}\n        ${detail}`);
}
function approx(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// ── The scene ────────────────────────────────────────────────────────────────
// boxA's top-left deliberately does NOT sit on the group's bind origin. A box at
// the bind origin is the FIXED POINT of a pure scale, so a scale-frame bug is
// invisible there — the first draft of this scene had them coincide and the
// SCALED row passed while broken.
const boxA = { ...rectPlugin.defaults, x: 150, y: 130, w: 200, h: 100, z: 1, active: true };
const boxB = { ...rectPlugin.defaults, x: 500, y: 100, w: 200, h: 100, z: 1, active: true };
const BIND = { x: 150, y: 100, rotation: 0, scale: 1 };

/** Pure function. A group over `members`, posed by `pose` relative to its bind. */
function group(members, pose) {
  return { ...groupPlugin.defaults, members, bind: BIND, x: BIND.x, y: BIND.y, w: 550, h: 130, z: 9, active: true, ...pose };
}
/** Pure function. A label whose whole BOX is the box's box — the shape a
 * diagram-conversion emits, and the reason the in-group cell matters. */
function label() {
  return {
    ...plaintextPlugin.defaults, text: "L", align: "center", valign: "middle",
    x: "= @a_tl.x", y: "= @a_tl.y", w: "= @a.w", h: "= @a.h", z: 2, active: true,
  };
}
/** Pure function. An arrow whose endpoints are CLOSEST-RIM refs on both boxes. */
function edge() {
  return {
    ...arrowPlugin.defaults,
    from: { x: "= @a_closest.x", y: "= @a_closest.y" },
    to: { x: "= @b_closest.x", y: "= @b_closest.y" },
    z: 3, active: true,
  };
}

/** Query. The app path: evaluate equations, then derive worlds. */
function pipeline(items) {
  const { state, errors } = evaluateState({ items }, registry, "");
  assert.equal(errors?.size ?? 0, 0, `unexpected equation errors: ${JSON.stringify([...(errors ?? [])])}`);
  return { state, nodes: deriveRenderTree(state, registry) };
}
const nodeOf = (nodes, id) => nodes.find((n) => n.itemId === id);
const anchorOf = (nodes, id, aid) => nodeAnchors(nodeOf(nodes, id)).find((a) => a.id === aid);

/**
 * Pure function. Distance from a LOCAL point to the border of [0,0,w,h] — 0
 * exactly on it. A rim reference promises the endpoint sits ON the border, so
 * this is the metric for "is the arrow still touching the box", which is the
 * user-visible claim. Comparing to one named anchor instead would be wrong: the
 * rim solve legitimately picks any point on the border.
 *
 * @example distToRectBorder(200, 50, 200, 100) // 0 (on the right edge)
 * @example distToRectBorder(230, 50, 200, 100) // 30 (30 units outside)
 * @example distToRectBorder(100, 50, 200, 100) // 50 (dead centre: 50 from the nearest edge)
 */
export function distToRectBorder(px, py, w, h) {
  const dx = Math.max(0 - px, px - w, 0), dy = Math.max(0 - py, py - h, 0);
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(px, w - px, py, h - py);
}

/** Query. How far the label's painted origin is from box a's painted top-left. */
function labelGap(items) {
  const { nodes } = pipeline(items);
  const want = anchorOf(nodes, "a", "tl");
  const got = nodeOf(nodes, "label").world;
  return Math.hypot(got.x - want.x, got.y - want.y);
}
/** Query. How far the arrow's painted tail is off box a's painted border. */
function edgeGap(items) {
  const { state, nodes } = pipeline(items);
  const n = nodeOf(nodes, "edge");
  const painted = T.apply(n.world, state.items.edge.from.x, state.items.edge.from.y);
  const a = nodeOf(nodes, "a");
  const local = T.apply(T.invert(a.world), painted.x, painted.y);
  return distToRectBorder(local.x, local.y, a.state.w, a.state.h);
}

// Four poses. BIND POSE alone proves nothing (influence is the identity there),
// which is why the defect survived: it is invisible until the group is moved.
const POSES = [
  ["bind pose", {}],
  ["translated", { x: 200, y: 120 }],
  ["scaled", { scale: 2 }],
  ["translated + scaled + rotated", { x: 200, y: 120, scale: 1.5, rotation: Math.PI / 7 }],
];

// ── inReaderFrame doctests ───────────────────────────────────────────────────

test("inReaderFrame: an ungrouped reader is byte-identical (the no-op that keeps Round 17 green)", () => {
  const p = { x: 200, y: 150 };
  assert.equal(inReaderFrame(p, null), p); // same object: literally untouched
});

test("inReaderFrame: a translated influence is subtracted (doctest)", () => {
  const r = inReaderFrame({ x: 200, y: 150 }, { x: 50, y: 20, rotation: 0, scale: 1 });
  approx(r.x, 150); approx(r.y, 130);
});

test("inReaderFrame: a scaling influence is divided out (doctest)", () => {
  const r = inReaderFrame({ x: 300, y: 200 }, { x: 0, y: 0, rotation: 0, scale: 2 });
  approx(r.x, 150); approx(r.y, 100);
});

test("inReaderFrame: it inverts EXACTLY — apply then un-apply is the identity", () => {
  const inf = { x: 37, y: -12, rotation: Math.PI / 5, scale: 1.7 };
  const p = { x: 411, y: -63 };
  const round = inReaderFrame(T.apply(inf, p.x, p.y), inf);
  approx(round.x, p.x); approx(round.y, p.y);
});

// ── CELL 1: named anchor, reader OUTSIDE the group ───────────────────────────
// Round 17's case. It must not move — that invariance is what makes the fix a
// correction rather than a behaviour change.

test("named anchor / reader OUTSIDE group: label tracks the box's PAINTED anchor, every pose", () => {
  for (const [poseName, pose] of POSES)
    approx(labelGap({ a: boxA, label: label(), g: group(["a"], pose) }), 0, 1e-6, `pose: ${poseName}`);
});

// ── CELL 2: named anchor, reader INSIDE the group — THE FIXED DEFECT ─────────

test("named anchor / reader INSIDE group: the influence lands ONCE, not twice", () => {
  for (const [poseName, pose] of POSES) {
    const gap = labelGap({ a: boxA, label: label(), g: group(["a", "label"], pose) });
    assert.ok(gap < 1e-6, `${poseName}: label tore ${gap.toFixed(2)} units off its box (influence applied twice?)`);
  }
});

test("named anchor / reader INSIDE group: the pre-fix poses really did tear (the gate can fail)", () => {
  // Reproduces the OLD arithmetic — anchor read WITHOUT the reader-frame map —
  // and asserts it is wrong, so this file cannot silently become a tautology if
  // inReaderFrame is ever neutered. The numbers are the measured regressions.
  const { nodes } = pipeline({ a: boxA, label: label(), g: group(["a", "label"], { x: 200, y: 120 }) });
  const influence = { x: 50, y: 20, rotation: 0, scale: 1 }; // group moved (50, 20) off bind
  const painted = anchorOf(nodes, "a", "tl");
  const preFix = T.apply(influence, painted.x, painted.y); // what the old code stored, re-influenced
  assert.ok(Math.hypot(preFix.x - painted.x, preFix.y - painted.y) > 50,
    "the pre-fix arithmetic must be visibly wrong, or this gate proves nothing");
});

// ── CELL 3: closest rim, reader INSIDE the group ─────────────────────────────

test("closest rim / reader INSIDE group: the arrow tail stays ON the box's painted border", () => {
  for (const [poseName, pose] of POSES) {
    const gap = edgeGap({ a: boxA, b: boxB, edge: edge(), g: group(["a", "b", "edge"], pose) });
    assert.ok(gap < 1e-6, `${poseName}: arrow tail ${gap.toFixed(2)} units off the box border`);
  }
});

// ── CELL 4: closest rim, reader OUTSIDE the group — KNOWN OPEN DEFECT ────────
//
// NOT ASSERTED, DELIBERATELY, and the reasoning is worth keeping next to the
// code it governs. Three instruments were available:
//   (a) assert the CORRECT value → a permanently red suite for a defect nobody
//       is fixing today. tests/connectivity_seam_test.js's own header states the
//       rule that rules this out: a gate that reports code we do not own teaches
//       the next reader to ignore reds.
//   (b) assert TODAY'S WRONG value → ratifies the bug, and goes red on the
//       eventual correct fix, whose likely response is to "fix" the test back.
//   (c) MEASURE and REPORT it, named and counted → no assertion to ratify, the
//       suite stays honest, and the cell cannot fade because it prints on every
//       run. Chosen.
// closestSugar never composes the target's group influence into the rim solve,
// so an UNGROUPED arrow bound to a GROUPED box does not follow it.

{
  const gaps = POSES.map(([poseName, pose]) =>
    [poseName, edgeGap({ a: boxA, b: boxB, edge: edge(), g: group(["a", "b"], pose) })]);
  const worst = gaps.reduce((m, g) => (g[1] > m[1] ? g : m));
  known("#227", "closest rim / reader OUTSIDE group: the arrow does NOT follow a transformed group",
    `worst pose "${worst[0]}": tail ${worst[1].toFixed(2)} units off the box border ` +
    `(core/expressions.js closestSugar omits the target's group influence). ` +
    `Cells measured: ${gaps.map(([n, g]) => `${n}=${g.toFixed(2)}`).join(", ")}`);
}

console.log(`\n${passed} passed, ${reported} known-defect cell reported (todo #227)`);
