/**
 * THE VECTOR-COVERAGE CLOSEOUT — workstream TT.
 * Run: node src/demo_apps/PowerRP/tests/morph_vector_coverage_test.js
 *
 * tests/morph_test.js pins the ENGINE, morph_mode_test.js the wiring,
 * morph_universal_test.js the universal property, morph_connector_test.js the
 * stroke family. This suite pins the widgets TT added, and — more importantly —
 * the ONE LAW that makes a new declaration safe rather than merely present.
 *
 * ── THE ENDPOINT LAW, AND WHY IT IS THE LAW WORTH PINNING ────────────────────
 * core/morph.js short-circuits at alpha 0 and 1 to the ORIGINAL payloads, so a
 * morph's endpoints are whatever the two providers hand over. If a provider's
 * geometry does not match what its own emit() DRAWS, the transition is right in
 * the middle and wrong at the ends: the widget FLICKS from the morphed outline to
 * its real ink on the final frame. That is the exact failure workstream LL chased
 * through the SVG providers (a dropped viewBox transform: correct at both
 * endpoints, a tiny blob everywhere between — the mirror image of this one), and
 * it is invisible to any test that only checks that a payload exists.
 *
 * So each newly-declared widget is checked by SAMPLING both sides in the same
 * frame — the payload's contours, and the `d` strings its emit() actually
 * produces — and comparing their extents. Extents rather than point-for-point
 * because a provider is allowed to omit ink it argues is not shape (a bar chart's
 * labels, an aperture's pupil, a yarn's shadow); what it may NOT do is describe
 * that shape in the wrong PLACE or at the wrong SIZE, which is what a flick is.
 *
 * The other three sections are cheap and catch the mistakes that are easy to make
 * once and never notice: a payload that is not well-formed (the LOUD gate
 * ports.js runs per frame), a payload whose space is zero (the connector trap —
 * scales every coordinate to 0 and paints an invisible widget with NO error), and
 * a `morphNotReady` that disagrees with its own emit() about whether there is ink.
 *
 * PLUGIN ASSETS ARE HERE TOO (donut, progress_bar), and they are the reason
 * core/plugin_assets.js gained the morph_payload helpers: they are jailed, so
 * they are registered through the sandbox rather than imported, and the sweep
 * below takes them from a real registry for exactly that reason.
 */

import assert from "node:assert/strict";
import { assertMorphPaths, morphPaths, payloadToPathD } from "../core/morph.js";
import { matIdentity, transformPathD } from "../core/svg_paths.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";

const registry = createRegistry();
registerPlugins(registry);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

/** A box big enough that a rounding error is not mistaken for a placement error. */
const BOX = { w: 300, h: 300 };

/**
 * THE WIDGETS TT DECLARED, with the state each is exercised at.
 *
 * `state` overrides the plugin's own defaults. Where a widget is only interesting
 * away from its defaults (a part-grown grid, a mid-progress bar) that is what it
 * is driven at, because a provider that quietly ignores a parameter still matches
 * at the default value of it.
 */
/**
 * A widget may EXCLUDE ink from its payload, and where it does, the exclusion is
 * named here as an op-index filter over emit()'s output plus the reason.
 *
 * THIS LIST IS THE POINT OF THE EXERCISE, not a way around it. Every provider TT
 * wrote had to decide what its SHAPE is, and three of them decided some of their
 * ink is not it — a QR's light background, an aperture's pupil, a yarn's shadow
 * and highlight. Those arguments live in the providers' docblocks; what this table
 * does is make each one CHECKABLE, so an exclusion is a stated decision rather
 * than a silent shortfall, and so the endpoint law still applies with full force
 * to everything that remains. A widget missing from this table is asserting that
 * its payload covers ALL of its ink.
 */
const INK_EXCLUSIONS = {
  // The light background is a BACKDROP, not the code: it is by far the largest
  // contour, so including it would pair a circle with the background and collapse
  // the grid. It is `rect` op 0 whenever the light colour is not transparent.
  qrcode: { drop: (op) => op.op === "rect", why: "the light background rect is a backdrop, not the code" },
  // emit() draws the pupil fill, then the blade body, then the sunstar rays. Only
  // the BODY is the mechanism's own shape; the other two are the light through it.
  aperture: { drop: (op, i) => i !== 1, why: "the pupil and the sunstar are light through the hole, not the iris" },
  // Leaf ops only — op 0 is the pupil fill, for the aperture's reason exactly.
  iris_blades: { drop: (op, i) => i === 0, why: "the pupil is light through the opening, not a leaf" },
  // Three copies of one curve: shadow, cord, highlight. Two of them are lighting.
  corkboardYarn: { drop: (op, i) => i !== 1, why: "the shadow and highlight are lighting, not a second and third cord" },
};

const DECLARED = [
  ["qrcode", {}],
  ["donut", {}],
  ["progress_bar", { w: 300, h: 60, fraction: 0.4 }],
  ["labeled_circle", {}],
  ["aperture", {}],
  ["iris_blades", {}],
  ["graph_line", {}],
  ["graph_grid", { growth: 0.6 }],
  ["graph_tick_marks", { includeTip: true, showMinorTicks: true }],
  ["graph_bars", { reveal: 0.7 }],
  ["corkboardYarn", { from: { x: 100, y: 100 }, to: { x: 400, y: 160 }, gravity: 0.2 }],
];

/** Query. A declared widget's state, at the size this suite exercises it. */
function stateFor(type, over) {
  const p = registry.get(type);
  // A CONNECTOR HAS NO BOX, and forcing w/h onto one would be meaningless rather
  // than merely useless — its geometry is its two absolute endpoints.
  const boxed = p.capabilities?.bbox === false ? {} : BOX;
  return { ...p.defaults, ...boxed, ...over };
}

/** How many points each cubic is sampled at. 8 resolves a sag to well under the
 *  1% of span this suite compares at, and the whole roster is a few hundred
 *  curves, so there is nothing to save by being cleverer. */
const CURVE_SAMPLES = 8;

/**
 * Pure helper. Points ON a `d` string's curves, not its CONTROL POLYGON.
 *
 * THE SECOND FALSE RED THIS SUITE PRODUCED, and it is worth stating because the
 * two sides of the comparison are legitimately different SPELLINGS of one curve.
 * `pathPoints` returns anchors AND handles; a handle is not a point the ink
 * reaches. For a straight-edged widget that costs nothing, but the yarn's sag is
 * one quadratic whose control sits ~30px BELOW the cord — and the payload's
 * exactly-elevated cubic has two different handles again — so comparing control
 * polygons compared two hulls, neither of which is the drawn curve.
 *
 * `pathDToSubpaths` (core/morph_payload.js) is not reused here on purpose: it is
 * half of what this suite is testing, and measuring the thing under test with
 * itself would make a whole class of provider error invisible. So the grammar is
 * absolute-ized with the shared normalizer and the cubics are evaluated here.
 */
function inkPoints(d) {
  const toks = String(transformPathD(d, matIdentity())).match(/[MLCQZmlcqz]|-?[\d.]+(?:e-?\d+)?/g) ?? [];
  const pts = [];
  let pen = [0, 0], i = 0;
  const at = (p0, c1, c2, p1, t) => {
    const u = 1 - t;
    return {
      x: u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      y: u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    };
  };
  while (i < toks.length) {
    const cmd = toks[i++];
    const n = () => Number(toks[i++]);
    if (cmd === "M" || cmd === "L") { pen = [n(), n()]; pts.push({ x: pen[0], y: pen[1] }); }
    else if (cmd === "C") {
      const c1 = [n(), n()], c2 = [n(), n()], p1 = [n(), n()];
      for (let k = 0; k <= CURVE_SAMPLES; k++) pts.push(at(pen, c1, c2, p1, k / CURVE_SAMPLES));
      pen = p1;
    } else if (cmd === "Q") {
      // Elevated to a cubic EXACTLY, the same standard elevation the payload
      // converter uses — so a Q and its elevated C sample to the same points.
      const q = [n(), n()], p1 = [n(), n()];
      const c1 = [pen[0] + (2 * (q[0] - pen[0])) / 3, pen[1] + (2 * (q[1] - pen[1])) / 3];
      const c2 = [p1[0] + (2 * (q[0] - p1[0])) / 3, p1[1] + (2 * (q[1] - p1[1])) / 3];
      for (let k = 0; k <= CURVE_SAMPLES; k++) pts.push(at(pen, c1, c2, p1, k / CURVE_SAMPLES));
      pen = p1;
    } else if (cmd !== "Z") {
      throw new Error(`inkPoints: unexpected command "${cmd}" after absolute normalization`);
    }
  }
  return pts;
}

/** Pure helper. The axis-aligned extent of a list of {x, y} points. */
function extentOfPoints(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Pure helper. A MorphPaths' extent, sampled through the same path sampler the
 *  emit side is measured with, so the two numbers are commensurable. */
function payloadExtent(payload) {
  const d = payloadToPathD(payload);
  return extentOfPoints(inkPoints(d));
}

/**
 * Query. The extent of every `path` op a widget's emit() produces, in LOCAL
 * space. `rect` and `ellipse` ops are converted rather than skipped — three of
 * the declared widgets draw their ink as those (bars, the progress track, the
 * disc), and skipping them would make this law vacuous for exactly the widgets
 * whose providers had to convert.
 */
function emitExtent(type, state) {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const all = registry.get(type).emit(state, null, world);
  const excl = INK_EXCLUSIONS[type];
  // TEXT OPS ARE DROPPED FOR EVERY WIDGET, not per-widget: no provider carries
  // letterforms, because text morphs through the glyph-outline seam and not by a
  // plugin inventing them. That is one rule for the whole roster, so it is stated
  // once here rather than repeated as four identical exclusions.
  const ops = all.filter((op, i) => op.op !== "text" && !(excl && excl.drop(op, i)));
  const pts = [];
  for (const op of ops) {
    if (op.op === "path" && typeof op.d === "string") pts.push(...inkPoints(op.d));
    else if (op.op === "rect") pts.push({ x: op.x, y: op.y }, { x: op.x + op.w, y: op.y + op.h });
    else if (op.op === "ellipse") pts.push({ x: op.cx - op.rx, y: op.cy - op.ry }, { x: op.cx + op.rx, y: op.cy + op.ry });
    else if (op.op === "polyline" && Array.isArray(op.points)) pts.push(...op.points.map(([x, y]) => ({ x, y })));
  }
  return pts.length ? extentOfPoints(pts) : null;
}

console.log("\nthe vector-coverage closeout — TT\n");

// ── (1) EVERY DECLARATION IS STRUCTURALLY SOUND ──────────────────────────────

console.log("WELL-FORMEDNESS — the gate ports.js runs per frame");

test("every widget TT declared HAS the hook, on the REGISTERED plugin", () => {
  // Registered, not imported: two of these are plugin ASSETS evaluated in the
  // jail, and a hook that exists in the source but is lost on the way through
  // would be invisible to an import-side check. That is not hypothetical — the
  // jail could not express morphPaths at all until core/plugin_assets.js gained
  // the payload helpers, and this assertion is what proves it can now.
  for (const [type] of DECLARED)
    assert.equal(typeof registry.get(type).morphPaths, "function",
      `${type} must declare morphPaths to be morphable at all`);
});

test("every payload passes assertMorphPaths", () => {
  for (const [type, over] of DECLARED)
    assertMorphPaths(registry.get(type).morphPaths(stateFor(type, over)), type);
});

test("NO PAYLOAD HAS A ZERO SPACE — the trap that paints nothing and says nothing", () => {
  // render_gpu/ports.js morphIR scales the engine's unit output by the space, so
  // a zero extent scales every coordinate to 0: an INVISIBLE widget for the whole
  // interior of its own transition, with no error anywhere. assertMorphPaths does
  // not catch it (zero is non-negative and every coordinate is finite).
  for (const [type, over] of DECLARED) {
    const { space } = registry.get(type).morphPaths(stateFor(type, over));
    assert.ok(space.w > 0 && space.h > 0,
      `${type} reported space ${JSON.stringify(space)} — every coordinate would scale to 0`);
  }
});

// ── (2) THE ENDPOINT LAW ─────────────────────────────────────────────────────

console.log("\nTHE ENDPOINT LAW — the payload is where the ink is");

test("EVERY DECLARED PAYLOAD SITS WHERE ITS OWN emit() DRAWS", () => {
  // THE FLICK TEST. A payload measured in the wrong frame is right in the middle
  // of a transition and wrong at its ends, so the widget snaps on the final
  // frame. Extents, not points: a provider may omit ink it argues is not shape
  // (labels, a pupil, a shadow), but it may not put the shape in the wrong place.
  //
  // The tolerance is 2% of the box. It is not tighter because several providers
  // legitimately describe a SUBSET of the drawn ink — a ruler's tips overshoot
  // its axes, a labelled disc's numeral does not extend past its rim — so what
  // this pins is "the same figure at the same size", which is what a flick
  // violates by a factor, never by a percent.
  const TOLERANCE = 0.02;
  for (const [type, over] of DECLARED) {
    const state = stateFor(type, over);
    const payload = registry.get(type).morphPaths(state);
    const ink = emitExtent(type, state);
    if (!ink) throw new Error(`${type}: emit() produced no measurable ink at this state — the fixture is wrong, not the widget`);
    const pay = payloadExtent(payload);
    // A connector's payload is measured from its ink rect's ORIGIN, and the rect
    // travels with it (`origin`), so put it back before comparing against emit()'s
    // absolute coordinates. render_gpu/ports.js morphBox does exactly this.
    const ox = payload.origin?.x ?? 0, oy = payload.origin?.y ?? 0;
    const span = Math.max(ink.x1 - ink.x0, ink.y1 - ink.y0);
    const slack = span * TOLERANCE;
    for (const [k, v] of [["x0", pay.x0 + ox], ["y0", pay.y0 + oy], ["x1", pay.x1 + ox], ["y1", pay.y1 + oy]])
      assert.ok(Math.abs(v - ink[k]) <= slack,
        `${type}: the payload's ${k} is ${v.toFixed(2)} but the ink's is ${ink[k].toFixed(2)} ` +
        `(tolerance ${slack.toFixed(2)}) — the morph would FLICK to the real ink at the endpoint`);
  }
});

test("A MORPH BETWEEN ANY TWO OF THEM IS FINITE AT MID-ALPHA", () => {
  // A morph that emits NaN paints nothing and reports nothing. Every declared
  // widget is paired against the FIRST one so the check is linear rather than
  // quadratic, and against a rich payload (the QR's 165 subpaths) so degenerate
  // pairings are exercised in both directions.
  const anchorState = stateFor(DECLARED[0][0], DECLARED[0][1]);
  const anchor = registry.get(DECLARED[0][0]).morphPaths(anchorState);
  for (const [type, over] of DECLARED.slice(1)) {
    const other = registry.get(type).morphPaths(stateFor(type, over));
    for (const [a, b] of [[anchor, other], [other, anchor]]) {
      const d = payloadToPathD(morphPaths(a, b, 0.5));
      assert.ok(!/NaN|Infinity/.test(d), `${type}: a mid-morph produced non-finite geometry`);
    }
  }
});

// ── (3) THE REFUSAL AGREES WITH THE INK ──────────────────────────────────────

console.log("\nmorphNotReady — the gate cannot disagree with emit()");

test("A WIDGET THAT DRAWS INK DOES NOT REFUSE", () => {
  for (const [type, over] of DECLARED) {
    const p = registry.get(type);
    if (!p.morphNotReady) continue;
    const state = stateFor(type, over);
    assert.equal(p.morphNotReady(state), null,
      `${type} refuses to morph at a state where its own emit() draws ink`);
  }
});

test("AN EMPTY QR REFUSES, AND SAYS WHY IN A CLAUSE", () => {
  // The ghost state is the one every widget with async or optional content has,
  // and the refusal has to complete "the widget is waiting for …" so the report
  // reads as a sentence. The QR is checked directly because it is the workstream's
  // originating case.
  const reason = registry.get("qrcode").morphNotReady({ ...registry.get("qrcode").defaults, data: "" });
  assert.ok(typeof reason === "string" && reason.length > 0, "an empty QR must refuse");
  assert.ok(!/^[A-Z]/.test(reason), `a refusal is a CLAUSE, not a sentence: got ${JSON.stringify(reason)}`);
});

// ── (4) THE QR ITSELF — the user's case, and its cost ────────────────────────

console.log("\nTHE QR — hundreds of squares, and what they cost");

test("A QR'S PAYLOAD IS ONE SUBPATH PER MERGED MODULE RUN", () => {
  // The claim that makes a QR→circle morph read as "hundreds of squares
  // collapsing into a ring" rather than as one blob: the modules stay SEPARATE
  // contours. Merging them, or handing over the widget's box, would give the
  // aligner one shape to distribute.
  const qr = registry.get("qrcode");
  const payload = qr.morphPaths(stateFor("qrcode", {}));
  assert.ok(payload.subpaths.length > 50,
    `a real QR merges to well over 50 runs, got ${payload.subpaths.length} — is the background rect being handed over instead?`);
  for (const sp of payload.subpaths)
    assert.equal(sp.closed, true, "every module run is a closed rectangle");
});

test("THE BACKGROUND RECT IS NOT IN THE PAYLOAD", () => {
  // It is a backdrop, not ink, and it is by far the largest contour — including it
  // would make a QR→circle pair the circle with the BACKGROUND and collapse the
  // grid into the middle. Checked structurally: no subpath spans the whole box.
  const qr = registry.get("qrcode");
  const state = stateFor("qrcode", {});
  const payload = qr.morphPaths(state);
  const e = payloadExtent(payload);
  assert.ok(e.x1 - e.x0 < state.w, "no contour spans the full box width (that would be the background rect)");
  assert.ok(e.x0 > 0, "the quiet zone means the ink starts INSIDE the box — the payload carries that offset");
});

test("THE QUIET ZONE OFFSET RIDES ALONG — the LL lesson", () => {
  // qrMatrixToPathD centers the grid and insets it by the quiet zone, so the
  // modules occupy a sub-rect of the box. A payload reporting the box alone would
  // jump on the morph's first frame. Doubling the quiet zone must visibly shrink
  // the ink, which is only true if the offset is really in the coordinates.
  const qr = registry.get("qrcode");
  const tight = payloadExtent(qr.morphPaths(stateFor("qrcode", { quietModules: 1 })));
  const wide = payloadExtent(qr.morphPaths(stateFor("qrcode", { quietModules: 8 })));
  assert.ok(wide.x0 > tight.x0, `a wider quiet zone must push the ink inward: ${tight.x0} -> ${wide.x0}`);
  assert.ok(wide.x1 < tight.x1, `and pull its far edge back: ${tight.x1} -> ${wide.x1}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
