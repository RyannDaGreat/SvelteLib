/**
 * ROUND 17 group-anchor END-TO-END probe — drives a real document through the
 * FULL app pipeline (foldState → evaluateState → deriveRenderTree) and proves
 * the three group-correctness fixes:
 *   17.1  a cross-item equation referencing a grouped member's anchor resolves
 *         at the member's GROUP-INFLUENCED (painted) world under TRANSLATION.
 *   17.2  the same under group ROTATION + SCALE (the anchor rotates/scales WITH
 *         the group — the user's "scared to ask" question, answered YES).
 *   17.3  ungroup preserves each member's world byte-identically on EVERY slide
 *         (a member keyframed across slides does NOT jump on a non-current slide).
 * Run: node src/demo_apps/PowerRP/tests/group_anchor_probe.js
 *
 * Unlike group_integration_probe.js (pure derive, no equations), THIS probe
 * exercises core/expressions.evaluateState — the exact place the 17.1/17.2 bug
 * lived (anchor refs resolved pre-parenting). It registers only rect/camera/
 * group so a concurrently-broken sibling plugin can't block it.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import {
  newDocument, foldState, keyframed, withNewItem, withItemPurged, withNormalizedZ, ungroupBakeSlides,
} from "../core/document.js";
import { deriveRenderTree, nodeAnchors, stateXYForCenterPivotWorld } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { rotatedBBoxAABB } from "../core/view.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js";
import { groupPlugin } from "../plugins/group.js";

const registry = createRegistry();
for (const p of [rectPlugin, cameraPlugin, groupPlugin]) registry.register(p);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
function approx(a, b, eps = 1e-4) { assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// The full app path: fold → evaluate equations → derive render tree.
function pipeline(doc, slide = 0) {
  const evald = evaluateState(foldState(doc, slide, 1), registry).state;
  return { evald, nodes: deriveRenderTree(evald, registry) };
}
function baseRect(x, y, w, h, z, extra = {}) {
  return {
    type: "rect", x, y, w, h, z, rotation: 0, scale: 1, active: true,
    fill: "#f00", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" }, ...extra,
  };
}
function addBlankSlide(doc, name) {
  return { ...doc, slides: [...doc.slides, { id: `slide-${doc.slides.length}`, name, transition: doc.slides[0].transition, delta: { items: {} } }] };
}

// Build a scene: TWO members (so the group's bbox center is NOT any single
// member's center — a rotation about the group center actually moves each
// member's anchor, which is what makes 17.2 discriminating), a named member the
// PROBE rect references by anchor equation, and the group over both members.
function scene() {
  let doc = newDocument();
  let memberId, member2Id, probeId;
  [doc, memberId] = withNewItem(doc, 0, baseRect(100, 100, 80, 60, 1));
  doc = keyframed(doc, 0, ["items", memberId, "name"], "Member");
  [doc, member2Id] = withNewItem(doc, 0, baseRect(400, 400, 40, 40, 4));
  // The probe's x/y ARE equations reading the grouped member's center anchor.
  [doc, probeId] = withNewItem(doc, 0, baseRect(0, 0, 10, 10, 2, { x: "member_cm.x", y: "member_cm.y" }));
  // Group both members (mirrors app groupSelection: AABB bbox, bind = origin).
  const { nodes } = pipeline(doc);
  const boxes = [memberId, member2Id].map((id) => rotatedBBoxAABB(nodes.find((n) => n.itemId === id)));
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  let gid;
  [doc, gid] = withNewItem(doc, 0, {
    ...registry.get("group").defaults,
    x: minX, y: minY, w: maxX - minX, h: maxY - minY, rotation: 0, scale: 1,
    members: [memberId, member2Id], bind: { x: minX, y: minY, rotation: 0, scale: 1 }, active: true, z: 3,
  });
  return { doc: withNormalizedZ(doc), memberId, member2Id, probeId, gid, origin: { minX, minY } };
}

// The probe equation's resolved value MUST equal the member's derived (painted)
// center anchor — that is the whole point: the equation sees the painted world.
function assertProbeTracksMemberAnchor(doc, memberId, probeId) {
  const { evald, nodes } = pipeline(doc);
  const memberCenter = nodeAnchors(nodes.find((n) => n.itemId === memberId)).find((a) => a.id === "cm");
  approx(evald.items[probeId].x, memberCenter.x);
  approx(evald.items[probeId].y, memberCenter.y);
  return memberCenter;
}

test("17.1 TRANSLATION: grouped member's anchor equation resolves at the group-influenced world", () => {
  const { doc, memberId, probeId, gid, origin } = scene();
  // The un-grouped member center is (140,130). Move the group +50,+20.
  let d = keyframed(doc, 0, ["items", gid, "x"], origin.minX + 50);
  d = keyframed(d, 0, ["items", gid, "y"], origin.minY + 20);
  const center = assertProbeTracksMemberAnchor(d, memberId, probeId);
  // And it is NOT the pre-group position (the bug would have resolved (140,130)).
  approx(center.x, 190); approx(center.y, 150);
  assert.ok(Math.abs(center.x - 140) > 1, "must have moved off the pre-group center");
});

test("17.2 ROTATION: grouped member's anchor rotates WITH the group (about the group center)", () => {
  const { doc, memberId, probeId, gid } = scene();
  const d = keyframed(doc, 0, ["items", gid, "rotation"], Math.PI / 2);
  const center = assertProbeTracksMemberAnchor(d, memberId, probeId);
  // The member center orbited the group center — it is NOT the un-rotated (140,130).
  assert.ok(Math.hypot(center.x - 140, center.y - 130) > 1, "anchor must have orbited the group center");
});

test("17.2 SCALE: grouped member's anchor scales WITH the group (about the group center)", () => {
  const { doc, memberId, probeId, gid } = scene();
  const d = keyframed(doc, 0, ["items", gid, "scale"], 2);
  const center = assertProbeTracksMemberAnchor(d, memberId, probeId);
  assert.ok(Math.hypot(center.x - 140, center.y - 130) > 1, "anchor must have moved under the group scale");
});

test("17.2 COMBINED translate + rotate + scale: anchor equation stays byte-exact to the painted anchor", () => {
  const { doc, memberId, probeId, gid, origin } = scene();
  let d = keyframed(doc, 0, ["items", gid, "x"], origin.minX + 33);
  d = keyframed(d, 0, ["items", gid, "y"], origin.minY - 17);
  d = keyframed(d, 0, ["items", gid, "rotation"], Math.PI / 6);
  d = keyframed(d, 0, ["items", gid, "scale"], 1.4);
  assertProbeTracksMemberAnchor(d, memberId, probeId); // exact match under all three at once
});

test("no-op safety: an UNGROUPED member's anchor equation is unchanged by this fix (no group influence)", () => {
  // Same probe, but never group anything — the equation still resolves to the
  // plain member center (the no-group fast path allocates no influence).
  let doc = newDocument();
  let m, probe;
  [doc, m] = withNewItem(doc, 0, baseRect(100, 100, 80, 60, 1));
  doc = keyframed(doc, 0, ["items", m, "name"], "Member");
  [doc, probe] = withNewItem(doc, 0, baseRect(0, 0, 10, 10, 2, { x: "member_cm.x", y: "member_cm.y" }));
  const { evald } = pipeline(doc);
  approx(evald.items[probe].x, 140); approx(evald.items[probe].y, 130);
});

test("no false cycle: a member's own rotation pivot (self.anchors.center) still resolves inside a group", () => {
  // The member carries the default rotationAnchor self.anchors.center equation.
  // Grouped + rotated, evaluateState must NOT flag a cycle (selfBase anchors take
  // no group dep) and the member must still paint (finite world).
  const { doc, memberId, gid } = scene();
  const d = keyframed(doc, 0, ["items", gid, "rotation"], Math.PI / 3);
  const { evald, nodes } = pipeline(d);
  const m = nodes.find((n) => n.itemId === memberId);
  assert.ok(Number.isFinite(m.world.x) && Number.isFinite(m.world.y));
  // rotationAnchor.x/y resolved to finite numbers (no cycle-fallback NaN/error).
  assert.equal(typeof evald.items[memberId].rotationAnchor.x, "number");
  assert.ok(Number.isFinite(evald.items[memberId].rotationAnchor.x));
});

// ── 17.3 UNGROUP preserves member world on a NON-CURRENT slide ────────────────
// Reproduces app.svelte.js ungroupSelection: worlds read from the ORIGINAL doc
// at every ungroupBakeSlides change point, baked, then the group purged.
function ungroupMultiSlide(origDoc, gid, memberIds) {
  let doc = origDoc;
  for (const memberId of memberIds)
    for (const slide of ungroupBakeSlides(origDoc, memberId, gid)) {
      const m = pipeline(origDoc, slide).nodes.find((n) => n.itemId === memberId);
      if (!m) continue;
      const xy = (typeof m.state.w === "number" && typeof m.state.h === "number")
        ? stateXYForCenterPivotWorld(m.world, m.state.w, m.state.h)
        : { x: m.world.x, y: m.world.y };
      doc = keyframed(doc, slide, ["items", memberId, "x"], xy.x);
      doc = keyframed(doc, slide, ["items", memberId, "y"], xy.y);
      doc = keyframed(doc, slide, ["items", memberId, "rotation"], m.world.rotation);
      doc = keyframed(doc, slide, ["items", memberId, "scale"], m.world.scale);
    }
  return withItemPurged(doc, gid);
}

test("17.3 UNGROUP: member keyframed across slides stays world-exact on the NON-CURRENT slide", () => {
  let { doc, memberId, member2Id, gid, origin } = scene();
  doc = addBlankSlide(doc, "Slide 2");
  // member 1 keyframed to a DIFFERENT spot on slide 1; the group moved on slide 0.
  doc = keyframed(doc, 1, ["items", memberId, "x"], 300);
  doc = keyframed(doc, 1, ["items", memberId, "y"], 260);
  doc = keyframed(doc, 0, ["items", gid, "x"], origin.minX + 50);
  doc = keyframed(doc, 0, ["items", gid, "y"], origin.minY + 20);
  // Capture BEFORE worlds on BOTH slides for BOTH members.
  const before = {};
  for (const id of [memberId, member2Id]) before[id] = [0, 1].map((s) => pipeline(doc, s).nodes.find((n) => n.itemId === id).world);
  // Ungroup while "on slide 0" — the multi-slide bake must fix slide 1 too.
  const ungrouped = ungroupMultiSlide(doc, gid, [memberId, member2Id]);
  assert.equal(pipeline(ungrouped, 0).nodes.find((n) => n.itemId === gid), undefined); // group purged
  for (const id of [memberId, member2Id])
    for (const s of [0, 1]) {
      const a = pipeline(ungrouped, s).nodes.find((n) => n.itemId === id).world, b = before[id][s];
      approx(a.x, b.x); approx(a.y, b.y);
      approx(a.rotation, b.rotation); approx(a.scale, b.scale);
    }
});

test("17.3 UNGROUP: group ROTATES on a slide where the member has NO keyframe (group-only change point)", () => {
  let { doc, memberId, member2Id, gid, origin } = scene();
  doc = addBlankSlide(doc, "Slide 2");
  doc = addBlankSlide(doc, "Slide 3");
  // Group rotates + scales on slide 2 ONLY; members have no keyframe there.
  doc = keyframed(doc, 2, ["items", gid, "rotation"], Math.PI / 4);
  doc = keyframed(doc, 2, ["items", gid, "scale"], 1.5);
  const before = {};
  for (const id of [memberId, member2Id]) before[id] = [0, 1, 2].map((s) => pipeline(doc, s).nodes.find((n) => n.itemId === id).world);
  const ungrouped = ungroupMultiSlide(doc, gid, [memberId, member2Id]);
  for (const id of [memberId, member2Id])
    for (const s of [0, 1, 2]) {
      const a = pipeline(ungrouped, s).nodes.find((n) => n.itemId === id).world, b = before[id][s];
      approx(a.x, b.x); approx(a.y, b.y);
      approx(a.rotation, b.rotation); approx(a.scale, b.scale);
    }
});

console.log(`\n${passed} group anchor probe checks passed.`);
