/**
 * THE STROKE FAMILY'S MORPH PAYLOADS — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/morph_connector_test.js
 *
 * tests/morph_test.js pins the ENGINE and tests/morph_mode_test.js pins the
 * WIRING. This suite pins the PROVIDERS the arrow/line/brace/paint-path family
 * declares, and it exists because that family broke an assumption every earlier
 * provider was allowed to make.
 *
 *   THE ZERO-SPACE TRAP — the reason this file exists at all. Every phase-2
 *     provider was a BBOX widget, so `space: {w: s.w, h: s.h}` was true and free.
 *     This whole family is `capabilities: {bbox: false}` with NO w/h state and
 *     ABSOLUTE endpoint coordinates, so that same line yields space {w: 0, h: 0}
 *     — and render_gpu/ports.js morphIR then scales by zero and paints
 *     "M0 0C0 0 0 0 0 0…", an INVISIBLE widget for the whole interior of its own
 *     transition. Nothing catches it: assertMorphPaths accepts a zero space (it
 *     is non-negative) and every coordinate is finite. So the law pinned here is
 *     that each connector reports a POSITIVE space — its ink rect — and the trap
 *     is pinned directly, as a payload that would have shipped.
 *   WELL-FORMEDNESS — every provider's payload passes assertMorphPaths, on its
 *     own defaults. Cheap, and it is the LOUD gate ports.js runs per frame.
 *   CENTERLINE ENDPOINTS — a line's payload is ONE OPEN subpath whose ends are
 *     its two endpoints, expressed in the ink rect's frame. This is the claim
 *     "the centerline is the honest payload for stroked ink" made checkable.
 *   THROUGH THE ENGINE — arrow → rect at alpha 0.5 produces FINITE geometry.
 *     A morph that emits NaN paints nothing and reports nothing.
 *   SILHOUETTE FIDELITY — fancy_arrow is the family's one FILLED widget, so its
 *     payload must match the hull its own emit() draws, to tolerance. That is
 *     the "derive the payload from the ink" rule made mechanical for the one
 *     member where a silhouette exists to disagree with.
 *
 * Geometry is read from the real plugins on purpose: a failure should name a
 * rule, not a fixture.
 */

import assert from "node:assert/strict";
import { assertMorphPaths, morphPaths, payloadToPathD } from "../core/morph.js";
import { morphIR } from "../render_gpu/ports.js";
import { morphPayloadFromConnector, polylinePathD } from "../core/morph_payload.js";
import { pathPoints } from "../core/svg_paths.js";
import { linePlugin } from "../plugins/line.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { elbowArrowPlugin } from "../plugins/elbow_arrow.js";
import { curvedArrowPlugin } from "../plugins/curved_arrow.js";
import { fancyArrowPlugin, fancyArrowInkRect } from "../plugins/fancy_arrow.js";
import { paintPathPlugin } from "../plugins/paint_path.js";
import { tangentLinesPlugin } from "../plugins/tangent_lines.js";
import { braceCurlyPlugin, braceSquarePlugin } from "../plugins/brace.js";
import { rectPlugin } from "../plugins/rect.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

/** Every provider this wave declared, by the name a failure should print. */
const PROVIDERS = [
  ["line", linePlugin],
  ["arrow", arrowPlugin],
  ["elbow_arrow", elbowArrowPlugin],
  ["curved_arrow", curvedArrowPlugin],
  ["fancy_arrow", fancyArrowPlugin],
  ["paint_path", paintPathPlugin],
  ["tangent_lines", tangentLinesPlugin],
  ["brace_curly", braceCurlyPlugin],
  ["brace_square", braceSquarePlugin],
];

console.log("\nmorph payloads — the stroke family\n");

test("every stroke-family plugin DECLARES morphPaths", () => {
  for (const [name, plugin] of PROVIDERS)
    assert.equal(typeof plugin.morphPaths, "function", `${name} must declare morphPaths to be morphable at all`);
});

test("every payload is WELL-FORMED (the gate ports.js runs per frame)", () => {
  for (const [name, plugin] of PROVIDERS)
    assertMorphPaths(plugin.morphPaths({ ...plugin.defaults }), name);
});

test("THE ZERO-SPACE TRAP: a boxless connector reports a POSITIVE space", () => {
  // The bug this whole seam was designed around. These widgets have no w/h, so a
  // provider written like a bbox widget's reports {w: 0, h: 0} — which passes
  // assertMorphPaths and then renders as nothing.
  for (const [name, plugin] of PROVIDERS) {
    const { space } = plugin.morphPaths({ ...plugin.defaults });
    assert.ok(space.w > 0 && space.h > 0,
      `${name} reported space ${JSON.stringify(space)} — a zero extent scales every coordinate to 0 in ` +
      `ports.morphIR and paints an INVISIBLE widget with no error`);
  }
});

test("the trap is REAL: a zero space collapses the geometry AT THE RENDER SEAM", () => {
  // Pinned by RUNNING the real seam rather than by describing it, and located
  // precisely — the first two guesses at where this breaks were both wrong, which
  // is the argument for pinning it at all.
  //
  // It is NOT the aligner: core/morph_align.js normalizeSubpath guards with
  // `space.w > 0 ? space.w : 1`, so a zero space passes ABSOLUTE coordinates
  // through un-normalized and the blend still looks plausible. The collapse is in
  // render_gpu/ports.js morphIR, which scales by `node.w / blended.space.w` — and
  // for a boxless connector the node's w/h are undefined too, so it is 0/1 × 0.
  const naive = { space: { w: 0, h: 0 }, fillRule: "nonzero", subpaths: [
    { start: [200, 300], curves: [[273, 300, 346, 300, 420, 300]], closed: false, winding: 1 }] };
  assert.doesNotThrow(() => assertMorphPaths(naive, "naive"),
    "a zero space is NOT refused by the engine's own gate — which is exactly why this test exists");

  const spreadOf = (ops) => {
    const xs = ops.flatMap((o) => pathPoints(o.d).map((p) => p.x));
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  };
  const nodeFor = (plugin, state) => ({
    type: "line", state, // a boxless connector node: NO w/h, exactly as derive builds it
    morph: { fromPlugin: plugin, toPlugin: rectPlugin, fromState: state,
      toState: { w: 100, h: 60, fill: "#ff0000", strokeWidth: 0 }, t: 0.5 },
  });

  const collapsed = spreadOf(morphIR(nodeFor({ morphPaths: () => naive }, {})));
  assert.ok(collapsed < 1e-9,
    `the naive payload must render as a degenerate point (got a spread of ${collapsed}) — an invisible widget, no error`);

  // The SAME line through the connector provider, at the same alpha, on a node
  // carrying its ink rect as the box: real extent where the naive one had none.
  const s = { ...linePlugin.defaults };
  const rect = linePlugin.localBounds(s);
  const honest = spreadOf(morphIR(nodeFor(linePlugin, { ...s, w: rect.w, h: rect.h })));
  assert.ok(honest > 1,
    `the ink-rect frame must preserve real extent where the naive one destroyed it (got ${honest})`);
});

test("A LINE IS ONE OPEN SUBPATH, with its endpoints in the ink rect's frame", () => {
  const s = { ...linePlugin.defaults, from: { x: 200, y: 300 }, to: { x: 420, y: 300 }, strokeWidth: 6 };
  const payload = linePlugin.morphPaths(s);
  assert.equal(payload.subpaths.length, 1, "a line draws one run of ink");
  const [sp] = payload.subpaths;
  assert.equal(sp.closed, false, "a stroked centerline is OPEN — a line has no interior");
  // The ink rect pads by the full stroke width on every side (lineInkRect), so the
  // rect origin is (200 - 6, 300 - 6) and the endpoints sit 6 in from each corner.
  const rect = linePlugin.localBounds(s);
  assert.deepEqual(sp.start, [s.from.x - rect.x, s.from.y - rect.y], "the M point IS the `from` endpoint, rect-relative");
  const end = sp.curves.at(-1).slice(4);
  assert.deepEqual(end, [s.to.x - rect.x, s.to.y - rect.y], "the last curve ends AT the `to` endpoint, rect-relative");
  assert.deepEqual(payload.space, { w: rect.w, h: rect.h }, "the space IS the ink rect's extent");
});

test("A HEADED ARROW carries its head as a CLOSED contour beside the open shaft", () => {
  // The head is what makes an arrow an arrow; a shaft-only payload would morph
  // the widget's identity away one frame into the transition.
  const payload = arrowPlugin.morphPaths({ ...arrowPlugin.defaults });
  assert.ok(payload.subpaths.length >= 2, "shaft + at least one head glyph");
  assert.equal(payload.subpaths[0].closed, false, "the shaft centerline is open");
  assert.ok(payload.subpaths.slice(1).some((sp) => sp.closed), "a head glyph is a closed region of ink");
});

test("ARROW → RECT through the engine is FINITE at every alpha", () => {
  const from = arrowPlugin.morphPaths({ ...arrowPlugin.defaults });
  const to = rectPlugin.morphPaths({ w: 100, h: 60, fill: "#ff0000", strokeWidth: 0 });
  for (const alpha of [0.001, 0.25, 0.5, 0.75, 0.999]) {
    const mid = morphPaths(from, to, alpha);
    assertMorphPaths(mid, `arrow→rect @${alpha}`);
    for (const sp of mid.subpaths) {
      assert.ok(sp.start.every(Number.isFinite), `NaN start at alpha ${alpha}`);
      for (const c of sp.curves)
        assert.ok(c.every(Number.isFinite), `NaN control point at alpha ${alpha} — a NaN d paints nothing and says nothing`);
    }
    assert.ok(payloadToPathD(mid).length > 0, `alpha ${alpha} drew no path at all`);
  }
});

test("FANCY ARROW's payload MATCHES the silhouette its own emit() draws", () => {
  // The family's one FILLED widget, so the "derive the payload from the ink" rule
  // is mechanically checkable here: the payload's anchors must be the emitted
  // outline's vertices, in the ink rect's frame.
  const s = { ...fancyArrowPlugin.defaults };
  const payload = fancyArrowPlugin.morphPaths(s);
  assert.equal(payload.subpaths.length, 1, "the outline is ONE fused contour (head into shaft)");
  assert.equal(payload.subpaths[0].closed, true, "a filled silhouette is CLOSED — unlike its stroked siblings");

  const drawn = fancyArrowPlugin.emit(s, null, { x: 0, y: 0, rotation: 0, scale: 1 }).find((o) => o.op === "path");
  const rect = fancyArrowInkRect(s);
  const emitted = pathPoints(drawn.d).map((p) => [p.x - rect.x, p.y - rect.y]);
  // Anchors only: the payload elevates each edge to a cubic, so the control points
  // are interpolated and only the segment ENDS correspond to outline vertices.
  const anchors = [payload.subpaths[0].start, ...payload.subpaths[0].curves.map((c) => c.slice(4))];
  for (const [ex, ey] of emitted) {
    const near = anchors.some(([ax, ay]) => Math.hypot(ax - ex, ay - ey) < 1e-6);
    assert.ok(near, `emitted vertex (${ex}, ${ey}) is absent from the morph payload — the payload and the ink disagree`);
  }
});

test("morphNotReady SHARES its predicate with the widget's own nothing-to-draw guard", () => {
  // A zero-length fancy arrow draws nothing, so it must REFUSE to morph rather
  // than hand over an empty payload for the aligner to pair against a real shape.
  const collapsed = { ...fancyArrowPlugin.defaults, from: { x: 100, y: 100 }, to: { x: 100, y: 100 } };
  assert.equal(fancyArrowPlugin.emit(collapsed, null, { x: 0, y: 0, rotation: 0, scale: 1 }).length, 0);
  assert.ok(fancyArrowPlugin.morphNotReady(collapsed), "a widget that draws nothing must report why it cannot morph");
  assert.equal(fancyArrowPlugin.morphNotReady({ ...fancyArrowPlugin.defaults }), null, "a drawable arrow is ready");
});

test("polylinePathD is the ONE spelling of a joined run of points", () => {
  assert.equal(polylinePathD([{ x: 0, y: 0 }, { x: 10, y: 0 }]), "M0 0L10 0");
  assert.equal(polylinePathD([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }]), "M0 0L5 0L5 4");
  assert.equal(polylinePathD([{ x: 3, y: 4 }]), "", "a single point is not ink");
  assert.equal(polylinePathD([]), "");
});

test("morphPayloadFromConnector TRANSLATES into the rect's frame and keeps the extent", () => {
  const payload = morphPayloadFromConnector([{ d: "M200 300L420 300" }], { x: 197, y: 297, w: 226, h: 6 });
  assert.deepEqual(payload.space, { w: 226, h: 6 });
  assert.deepEqual(payload.subpaths[0].start, [3, 3], "the origin is subtracted from every coordinate");
  assert.deepEqual(payload.subpaths[0].curves.at(-1).slice(4), [223, 3]);
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
