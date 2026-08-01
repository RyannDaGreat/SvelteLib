/**
 * Rotation-fix-wave quantified repro probe (Opus17, W2d). Reproduces the
 * .claude_reports/2026-07-15_rotation_audit.md registry numbers using ONLY the
 * DOM-free core (no browser) so before/after deltas are measured exactly.
 *
 * Run: node tests/rotation_probe.js
 *
 * Each section prints the measured error px at 30/45/54/90/180°. The registry
 * expects ~0px after the fixes; at HEAD (pre-fix) it prints the large drifts.
 *
 * IT IS BOTH A TABLE AND A GATE. The tables are the diagnostic value and every
 * one is kept; but the fixes HAVE landed (all five sections measure 0.00px), so
 * printing without asserting would leave a probe in the canonical gate that
 * cannot fail — which manufactures confidence rather than supplying it. So every
 * printed number is also accumulated into `worst`, and ONE assertion at the
 * bottom fails the run if any of them drifts.
 */

import assert from "node:assert/strict";
import * as T from "../core/transform.js";
import { worldTransform, nodeAnchors, standardBBoxAnchors, stateXYForCenterPivotWorld } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { arrowPlugin } from "../plugins/arrow.js";

const registry = createRegistry();
for (const p of [rectPlugin, circlePlugin, arrowPlugin]) registry.register(p);

const DEG = (d) => (d * Math.PI) / 180;
const ANGLES = [30, 45, 54, 90, 180];

// Every number this probe accumulates is the distance between two float64
// computations of the SAME point, on 100-600px magnitudes: accumulated rounding
// is ~1e-12px. A real regression is >= 0.01px — the pre-fix drifts printed under
// [#1] are 10-40px. So 1e-6 is six orders of magnitude clear of the noise floor
// and still catches everything. It is also the house's existing geometric
// tolerance, under this exact name: tests/align_mirror_probe.js:31 and
// tests/crosshair_probe.js:57, both 2026-07-15.
const EPS = 1e-6;

const worst = { label: "(nothing measured)", off: -1 };
const failures = [];

/**
 * Command (mutates the module-level `worst`). Feeds one measured offset to the
 * end-of-run assertion and returns it unchanged, so a print site reads
 * `measured(label, off).toFixed(2)` without losing its table row.
 *
 * @param {string} label - What was measured, named well enough to fix it
 * @param {number} off - Measured offset in px
 * @returns {number} off
 */
function measured(label, off) {
  if (!Number.isFinite(off)) failures.push(`${label}: measured a non-finite offset (${off})`);
  else if (off > worst.off) { worst.label = label; worst.off = off; }
  return off;
}

// ── #2 helper: the painted world position of a rotated item's preset anchor,
//    vs the position the anchor EQUATION currently evaluates to. ────────────────
function anchorReport(makeItem, anchorId) {
  console.log(`\n[#2] preset anchor "${anchorId}" — evaluated ref vs painted rim (px off):`);
  for (const deg of ANGLES) {
    const item = makeItem(DEG(deg));
    // Painted position: derive.nodeAnchors uses node.world = worldTransform(item).
    const node = { world: worldTransform(item), state: item, plugin: registry.get(item.type) };
    const painted = nodeAnchors(node).find((a) => a.id === anchorId);
    // Evaluated ref position: an arrow endpoint bound to <slug>.anchors.<id>.
    const state = {
      items: {
        tgt: { ...item, name: "Tgt" },
        ar: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: `@tgt_${anchorId}.x`, y: `@tgt_${anchorId}.y` } },
      },
    };
    const { state: ev, errors } = evaluateState(state, registry);
    if (errors.size) {
      console.log(`  ${deg}°: ERROR ${[...errors.values()][0]}`);
      failures.push(`[#2] anchor "${anchorId}" @${deg}°: ${[...errors.values()][0]}`);
      continue;
    }
    const off = Math.hypot(ev.items.ar.to.x - painted.x, ev.items.ar.to.y - painted.y);
    console.log(`  ${deg}°: ${measured(`[#2] preset anchor "${anchorId}" @${deg}°`, off).toFixed(2)}px`);
  }
}

// #2a: preset tr anchor on a rotated rect.
anchorReport(
  (rot) => ({ ...rectPlugin.defaults, x: 100, y: 100, w: 200, h: 120, rotation: rot }),
  "tr",
);

// ── #2b: closest-rim ref to a rotated circle. ────────────────────────────────
console.log(`\n[#2] closest-rim to rotated CIRCLE — evaluated attach vs painted rim (px off):`);
for (const deg of ANGLES) {
  const circle = { ...circlePlugin.defaults, x: 100, y: 100, w: 120, h: 120, rotation: DEG(deg), name: "C" };
  const state = {
    items: {
      c1: circle,
      ar: { ...arrowPlugin.defaults, from: { x: 400, y: 160 }, to: { x: "@c1_closest.x", y: "@c1_closest.y" } },
    },
  };
  const { state: ev, errors } = evaluateState(state, registry);
  if (errors.size) {
    console.log(`  ${deg}°: ERROR ${[...errors.values()][0]}`);
    failures.push(`[#2] circle closest-rim @${deg}°: ${[...errors.values()][0]}`);
    continue;
  }
  // Painted rim closest point (using worldTransform, the paint truth): the
  // circle's closestAnchor evaluated with the PAINTED world.
  const world = worldTransform(circle);
  const local = circlePlugin.closestAnchor(circle, ev.items.ar.from.x, ev.items.ar.from.y, world);
  const painted = T.apply(world, local.x, local.y);
  const off = Math.hypot(ev.items.ar.to.x - painted.x, ev.items.ar.to.y - painted.y);
  console.log(`  ${deg}°: ${measured(`[#2] circle closest-rim @${deg}°`, off).toFixed(2)}px`);
}

// ── #2c: closest-rim to a rotated ELLIPSE. ───────────────────────────────────
console.log(`\n[#2] closest-rim to rotated ELLIPSE (200x80) — evaluated vs painted (px off):`);
for (const deg of ANGLES) {
  const ell = { ...circlePlugin.defaults, x: 100, y: 100, w: 200, h: 80, rotation: DEG(deg), name: "E" };
  const state = {
    items: {
      e1: ell,
      ar: { ...arrowPlugin.defaults, from: { x: 500, y: 300 }, to: { x: "@e1_closest.x", y: "@e1_closest.y" } },
    },
  };
  const { state: ev, errors } = evaluateState(state, registry);
  if (errors.size) {
    console.log(`  ${deg}°: ERROR ${[...errors.values()][0]}`);
    failures.push(`[#2] ellipse closest-rim @${deg}°: ${[...errors.values()][0]}`);
    continue;
  }
  const world = worldTransform(ell);
  const local = circlePlugin.closestAnchor(ell, ev.items.ar.from.x, ev.items.ar.from.y, world);
  const painted = T.apply(world, local.x, local.y);
  const off = Math.hypot(ev.items.ar.to.x - painted.x, ev.items.ar.to.y - painted.y);
  console.log(`  ${deg}°: ${measured(`[#2] ellipse closest-rim @${deg}°`, off).toFixed(2)}px`);
}

// ── #1: rotated-resize opposite-edge drift (registry #1, PPT opposite-handle).
//    Two paths compared:
//      NAIVE: grow w, keep the self.anchors.center pivot → derivation re-centers
//        → the "fixed" WEST edge drifts (10-40px, the pre-fix behavior).
//      FIXED: the CanvasView resizeDrag back-solve — lay the box out against the
//        PINNED (drag-time) pivot, then back-solve x/y so the re-centered center
//        pivot reproduces the identical world (stateXYForCenterPivotWorld) →
//        WEST edge stays put, and the stored pivot remains the center equation.
console.log(`\n[#1] rotated EAST-edge resize (+40 local px) — WEST-edge world drift (px):`);
{
  const dxLocal = 40;
  for (const deg of ANGLES) {
    const base = { ...rectPlugin.defaults, x: 100, y: 100, w: 200, h: 120, rotation: DEG(deg), name: "R" };
    const stBefore = evaluateState({ items: { r: base } }, registry).state.items.r;
    const dragWorld = worldTransform(stBefore); // = drag.world captured at startResize
    const westBefore = T.apply(dragWorld, 0, base.h / 2); // PPT-fixed point

    // NAIVE path (the bug): east handle grows w, x/y unchanged, center pivot.
    const naive = evaluateState({ items: { r: { ...base, w: base.w + dxLocal } } }, registry).state.items.r;
    const westNaive = T.apply(worldTransform(naive), 0, base.h / 2);
    const driftNaive = Math.hypot(westNaive.x - westBefore.x, westNaive.y - westBefore.y);

    // FIXED path: resizeDrag lays local(0,0) out via drag.world (east handle:
    // box top-left = local(0,0), unchanged), then back-solves x/y.
    const ww = base.w + dxLocal, hh = base.h;
    const topLeftWorld = T.apply(dragWorld, 0, 0);
    const pinnedWorld = { x: topLeftWorld.x, y: topLeftWorld.y, rotation: dragWorld.rotation, scale: dragWorld.scale };
    const solved = stateXYForCenterPivotWorld(pinnedWorld, ww, hh);
    const fixedState = evaluateState({ items: { r: { ...base, x: solved.x, y: solved.y, w: ww, h: hh } } }, registry).state.items.r;
    const westFixed = T.apply(worldTransform(fixedState), 0, base.h / 2);
    const driftFixed = Math.hypot(westFixed.x - westBefore.x, westFixed.y - westBefore.y);
    // The grabbed EAST edge must move exactly dxLocal (world) from its start.
    const eastBefore = T.apply(dragWorld, base.w, base.h / 2);
    const eastFixed = T.apply(worldTransform(fixedState), ww, base.h / 2);
    const eastMove = Math.hypot(eastFixed.x - eastBefore.x, eastFixed.y - eastBefore.y);
    const expectedEast = dxLocal * dragWorld.scale;
    // The NAIVE drift is not noise, it is a closed form: keeping x/y and growing
    // w by dx moves the centre pivot dx/2 along local x, so the west edge swings
    // through the chord 2·(dx/2)·sin(θ/2) = dx·sin(θ/2) (40° → 40·sin(90°) = 40).
    // Pinning it keeps this probe an INSTRUMENT: if the naive path ever stopped
    // drifting, "FIXED = 0" would prove nothing, and the section would silently
    // become a comparison of two zeroes.
    const expectedNaive = dxLocal * Math.sin(DEG(deg) / 2) * dragWorld.scale;
    measured(`[#1] naive west drift @${deg}° vs its closed form dx·sin(θ/2)`, Math.abs(driftNaive - expectedNaive));
    measured(`[#1] fixed west drift @${deg}°`, driftFixed);
    measured(`[#1] dragged east edge travel @${deg}°`, Math.abs(eastMove - expectedEast));
    console.log(`  ${deg}°: NAIVE WEST drift=${driftNaive.toFixed(2)}px → FIXED WEST drift=${driftFixed.toFixed(2)}px; EAST moved=${eastMove.toFixed(2)}px (expect ${expectedEast.toFixed(2)})`);
  }
}

// ── #3: scale:0 world transform finiteness. ──────────────────────────────────
console.log(`\n[#3] scale:0 rotated transform finiteness (aboutPivot / invert):`);
{
  const item = { ...rectPlugin.defaults, x: 100, y: 100, w: 200, h: 120, rotation: DEG(45), scale: 0 };
  let msg;
  try {
    const w = worldTransform(item);
    const finite = Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.scale);
    const inv = T.invert(w);
    const invFinite = Number.isFinite(inv.x) && Number.isFinite(inv.y);
    msg = `worldTransform finite=${finite} (x=${w.x}, y=${w.y}); invert finite=${invFinite}`;
    if (!finite) failures.push(`[#3] worldTransform of a scale:0 rotated item is not finite: ${JSON.stringify(w)}`);
    if (!invFinite) failures.push(`[#3] invert() of a scale:0 rotated world is not finite: ${JSON.stringify(inv)}`);
  } catch (e) {
    msg = `THREW: ${e.message}`;
    failures.push(`[#3] scale:0 rotated transform threw: ${e.message}`);
  }
  console.log(`  ${msg}`);
}

// ── #4: rounded-rect anchors on the rounded rim, not the square bbox corner. ──
console.log(`\n[#4] rounded-rect corner anchor — distance from the ROUNDED rim (px):`);
{
  const r = 30; // corner radius
  const item = { ...rectPlugin.defaults, x: 0, y: 0, w: 200, h: 120, cornerRadius: r, rotation: 0 };
  // The rect plugin's OWN anchors() (the fixed path). tr should be on the arc.
  const tr = rectPlugin.anchors(item).find((a) => a.id === "tr");
  // The true 45° rim point of the TR corner arc (center (w-r, r)).
  const cx = item.w - r, cy = r;
  const rimX = cx + r / Math.SQRT2, rimY = cy - r / Math.SQRT2;
  const off = Math.hypot(tr.x - rimX, tr.y - rimY);
  // Distance the tr anchor is INSIDE the square corner (should be ~r*(√2−1)).
  const fromSquare = Math.hypot(tr.x - item.w, tr.y - 0);
  measured("[#4] rounded-rect tr anchor off the rounded rim", off);
  measured("[#4] rounded-rect tr anchor inset vs r·(√2−1)", Math.abs(fromSquare - r * (Math.SQRT2 - 1)));
  console.log(`  tr anchor now at (${tr.x.toFixed(2)}, ${tr.y.toFixed(2)}); on-rim off=${off.toFixed(2)}px (~0 after fix); pulled ${fromSquare.toFixed(2)}px in from the square corner (≈ ${(r * (Math.SQRT2 - 1)).toFixed(2)})`);
  // Edge midpoint tm must NOT move.
  const tm = rectPlugin.anchors(item).find((a) => a.id === "tm");
  const tmUnmoved = tm.x === item.w / 2 && tm.y === 0;
  if (!tmUnmoved) failures.push(`[#4] corner rounding moved the tm edge midpoint to (${tm.x}, ${tm.y}), want (${item.w / 2}, 0)`);
  console.log(`  tm (edge midpoint) at (${tm.x}, ${tm.y}) — unchanged by rounding: ${tmUnmoved}`);
}

// ── #4 combined: rounded + ROTATED rect, arrow's closest-rim ref meets the
//    visible rounded rim exactly (the user's ORIGINAL complaint). ─────────────
console.log(`\n[#4+#2] closest-rim to a ROUNDED + ROTATED rect — evaluated vs painted rounded rim (px off):`);
for (const deg of ANGLES) {
  const rr = { ...rectPlugin.defaults, x: 100, y: 100, w: 200, h: 120, cornerRadius: 30, rotation: DEG(deg), name: "RR" };
  const state = {
    items: {
      rr,
      ar: { ...arrowPlugin.defaults, from: { x: 600, y: 400 }, to: { x: "@rr_closest.x", y: "@rr_closest.y" } },
    },
  };
  const { state: ev, errors } = evaluateState(state, registry);
  if (errors.size) {
    console.log(`  ${deg}°: ERROR ${[...errors.values()][0]}`);
    failures.push(`[#4+#2] rounded+rotated closest-rim @${deg}°: ${[...errors.values()][0]}`);
    continue;
  }
  const world = worldTransform(rr);
  const local = rectPlugin.closestAnchor(rr, ev.items.ar.from.x, ev.items.ar.from.y, world);
  const painted = T.apply(world, local.x, local.y);
  const off = Math.hypot(ev.items.ar.to.x - painted.x, ev.items.ar.to.y - painted.y);
  console.log(`  ${deg}°: ${measured(`[#4+#2] rounded+rotated closest-rim @${deg}°`, off).toFixed(2)}px`);
}

// ── THE GATE. One assertion over everything printed above. ───────────────────
if (worst.off < 0) failures.push("the probe measured no offset at all — every section errored or was skipped");
else if (worst.off > EPS) failures.push(`worst offset is ${worst.label} at ${worst.off.toExponential(3)}px, over the ${EPS}px bar`);
console.log(`\nworst measured offset: ${worst.label} = ${worst.off.toExponential(3)}px (bar ${EPS}px)`);
assert.ok(failures.length === 0,
  `rotation invariants regressed (${failures.length}):\n  · ${failures.join("\n  · ")}`);

console.log("(rotation_probe done — every table above is also asserted)");
