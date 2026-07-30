/**
 * THE SILENT-PROMISE SUITE — bare node. One theme: the app OFFERS something and then
 * does NOTHING, without a word. The user's standing rule makes that a first-class bug
 * ("Silent failures are FORBIDDEN. If it fails, it must fail loudly"), and every case
 * below was a MEASURED defect, not a hypothetical:
 *
 *   (1) ANCHOR SNAP declined every plugin-published anchor. core/snap.provenanceAnchorId
 *       was a hardcoded 15-name whitelist (the 9 standard bbox points + the 6 snap-only
 *       line names), so a bento grid's 54 CELL anchors — which resolve cleanly through
 *       the equation grammar — all answered `null`, and the release path's
 *       `if (!anchorId) continue;` dropped them with no equation, no console line and no
 *       throw, WHILE the HintBar was already offering "A — Anchor snap". A whitelist
 *       cannot see a plugin's own anchors(); the plugin can.
 *   (2) A USER-ACTION refusal went silent from the second click on. core/report.reportOnce
 *       dedupes forever, which is right for per-frame code and wrong for a click.
 *   (3) tangent_lines published NINE anchors that all collapsed onto world (0, 0),
 *       because it declared `standardBBoxAnchors` while having no w/h at all — the
 *       helper's `state.w ?? 0` made the lie silent (zero errors).
 *   (4) THREE SkSL uniforms were declared, packed, and never read, two of them with an
 *       Inspector row promising a visible effect (skySun/skyMoon cornerRadius,
 *       corkboardThumbtack seed) — lying knobs.
 *
 * Run: node src/demo_apps/PowerRP/tests/silent_promises_test.js
 */

import assert from "node:assert/strict";
import * as T from "../core/transform.js";
import { createRegistry } from "../core/registry.js";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster, registerPlugins } from "../plugins/index.js";

const roster = builtinRoster();
import { newDocument, withNewItem, keyframed, foldState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree, nodeAnchors, nodeFeatures, standardBBoxAnchors } from "../core/derive.js";
import { provenanceAnchorId, snapProvenance, solveSnap, anchorSnapEquation } from "../core/snap.js";
import { reportOnce, reportAction } from "../core/report.js";
import { tangentLinesAnchors, tangentLinesInkRect } from "../plugins/tangent_lines.js";
import { materialIds, getMaterial } from "../render_gpu/skia/materials.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

const registry = createRegistry();
registerPlugins(registry); // BOTH halves of the roster: source modules + the built-in plugin-asset library

/** The nine ids a bbox plugin publishes — DERIVED, never re-listed (bento.js's rule). */
const STANDARD_NINE = standardBBoxAnchors({ w: 0, h: 0 }).map((a) => a.id);

// A 300x200 2x3 bento at (100, 100), no gaps, no padding: cell centres are round
// numbers, so the expectations below are written out rather than recomputed by the
// code under test (the tests/bento_bind_test.js fixture, verbatim).
const BENTO = { ...registry.get("bento").defaults, x: 100, y: 100, w: 300, h: 200, rows: 2, cols: 3, rowGap: 0, colGap: 0, padding: 0, active: true };

// ── (1) provenanceAnchorId ASKS THE SOURCE PLUGIN ────────────────────────────

test("(1a) a bento CELL anchor binds — the whitelist declined it, the plugin publishes it", () => {
  const cellIds = registry.get("bento").anchors(BENTO).map((a) => a.id).filter((id) => /^c\d+x\d+/.test(id));
  assert.ok(cellIds.length >= 18, `expected the 6 cells' 9 anchors, got ${cellIds.length}`);
  const published = registry.get("bento").anchors(BENTO).map((a) => a.id);
  for (const id of cellIds)
    assert.equal(provenanceAnchorId(id, published), id, `${id} is published by the plugin and must bind`);
  // THE DEFECT, encoded so it cannot come back: consulting only the standard nine
  // (which is all the old whitelist knew) declines every one of them.
  for (const id of cellIds)
    assert.equal(provenanceAnchorId(id, STANDARD_NINE), null);
});

test("(1b) the nine standard points pass through when the plugin publishes them", () => {
  for (const id of STANDARD_NINE) assert.equal(provenanceAnchorId(id, STANDARD_NINE), id);
});

test("(1c) the six snap-only LINE names bind to a point on the same line", () => {
  const want = { top: "tm", bottom: "bm", left: "ml", right: "mr", hcenter: "cm", vcenter: "cm" };
  for (const [line, point] of Object.entries(want))
    assert.equal(provenanceAnchorId(line, STANDARD_NINE), point);
  // ...and NOT when the plugin does not publish that point: no anchor is invented.
  for (const line of Object.keys(want))
    assert.equal(provenanceAnchorId(line, ["some_other_anchor"]), null);
});

test("(1d) a TRANSIENT snap feature still declines — a polygon vertex is not an anchor", () => {
  const polygon = registry.get("polygon");
  const vertexIds = polygon.snapFeatures(polygon.defaults).map((f) => f.id);
  const anchorIds = polygon.anchors(polygon.defaults).map((a) => a.id);
  assert.ok(vertexIds.includes("v0"), "polygon must publish its vertices as snap features");
  assert.ok(!anchorIds.includes("v0"), "polygon must NOT publish a vertex as an anchor");
  assert.equal(provenanceAnchorId("v0", anchorIds), null);
});

test("(1e) omitting anchorIds THROWS — defaulting it would decline everything, silently", () => {
  assert.throws(() => provenanceAnchorId("cm"), /anchorIds/);
});

// ── (2) END TO END: an anchor snap onto a bento CELL lands a LIVE equation ────

test("(2) a cell-anchor snap writes an equation the evaluator resolves to that cell", () => {
  let doc = newDocument();
  let bentoId, rectId;
  [doc, bentoId] = withNewItem(doc, 0, { ...BENTO });
  [doc, rectId] = withNewItem(doc, 0, { ...registry.get("rect").defaults, x: 0, y: 0, w: 40, h: 20, active: true });

  const nodesOf = (d) => {
    const { state, errors } = evaluateState(foldState(d, 0, 1), registry);
    assert.equal(errors.size, 0, `expression errors: ${[...errors.values()].join("; ")}`);
    return deriveRenderTree(state, registry);
  };
  const nodes = nodesOf(doc);
  const bentoNode = nodes.find((n) => n.itemId === bentoId);

  // The centre of cell (1, 2): x = 100 + 2*100 + 50 = 350, y = 100 + 100 + 50 = 250.
  const CELL_CM = "c1x2cm";
  const target = nodeFeatures(bentoNode).find((f) => f.id === `${bentoNode.id}:${CELL_CM}`);
  assert.ok(target, "the bento must publish its cell centres as SNAP features");
  assert.deepEqual([target.x, target.y], [350, 250]);

  // A drag that lands the rect's top-left 3 world units short of that cell centre:
  // inside any sane tolerance, so the solver corrects onto the anchor exactly.
  const TOL = 8, NEAR = 3;
  const probes = [{ kind: "point", x: target.x - NEAR, y: target.y - NEAR, id: "tl" }];
  const snap = solveSnap(probes, nodeFeatures(bentoNode), TOL);
  assert.deepEqual([snap.dx, snap.dy], [NEAR, NEAR]);
  assert.equal(snap.provenance.length, 1);
  const prov = snap.provenance[0];
  assert.deepEqual(prov, { sourceItemId: bentoNode.id, sourceAnchorId: CELL_CM, axis: "both" });

  // What the release path does: ask the SOURCE PLUGIN, then write the equation.
  const sourceAnchors = nodeAnchors(nodes.find((n) => n.itemId === prov.sourceItemId));
  const anchorId = provenanceAnchorId(prov.sourceAnchorId, sourceAnchors.map((a) => a.id));
  assert.equal(anchorId, CELL_CM, "the plugin publishes this anchor, so the release must bind it");

  for (const coord of ["x", "y"]) {
    const anchorValue = sourceAnchors.find((a) => a.id === anchorId)[coord];
    const eq = anchorSnapEquation(prov.sourceItemId, anchorId, coord, anchorValue, anchorValue);
    assert.equal(eq, `@${bentoId}_${CELL_CM}.${coord}`, "an exact-point snap writes the BARE reference");
    doc = keyframed(doc, 0, ["items", rectId, coord], eq);
  }

  // THE PROOF: the stored equations resolve, with no errors, to the cell centre —
  // and they are LIVE, so moving the bento moves the rect (the point of binding).
  const rectAt = (d) => {
    const n = nodesOf(d).find((q) => q.itemId === rectId);
    return T.apply(n.world, 0, 0);
  };
  assert.deepEqual(rectAt(doc), { x: 350, y: 250 });
  const moved = keyframed(keyframed(doc, 0, ["items", bentoId, "x"], 160), 0, ["items", bentoId, "y"], 130);
  assert.deepEqual(rectAt(moved), { x: 410, y: 280 }, "the equation must TRACK the cell, not freeze its value");
});

// ── (3) tangent_lines publishes anchors ON ITS INK ───────────────────────────

const TWO_CIRCLES = {
  a: { x: 0, y: 0, halfW: 10, halfH: 10, rotation: 0 },
  b: { x: 100, y: 0, halfW: 10, halfH: 10, rotation: 0 },
  shapeKind: "circle", strokeWidth: 2,
};

test("(3a) tangent_lines anchors span its INK RECT, not the world origin", () => {
  const rect = tangentLinesInkRect(TWO_CIRCLES);
  const anchors = tangentLinesAnchors(TWO_CIRCLES);
  assert.equal(anchors.length, 9);
  assert.deepEqual(anchors.map((a) => a.id), STANDARD_NINE, "same ids, same order, as every bbox widget");
  const byId = Object.fromEntries(anchors.map((a) => [a.id, a]));
  assert.deepEqual([byId.tl.x, byId.tl.y], [rect.x, rect.y]);
  assert.deepEqual([byId.br.x, byId.br.y], [rect.x + rect.w, rect.y + rect.h]);
  assert.deepEqual([byId.cm.x, byId.cm.y], [rect.x + rect.w / 2, rect.y + rect.h / 2]);
  // The defect: nine anchors at (0, 0) for a widget whose ink is at x ~ 50.
  assert.ok(anchors.some((a) => a.x !== 0 || a.y !== 0), "anchors must not all collapse onto the origin");
  assert.equal(registry.get("tangent_lines").anchors, tangentLinesAnchors, "the plugin must declare THIS hook");
});

test("(3b) NO plugin publishes coincident-at-origin anchors while its ink is elsewhere", () => {
  // The general form of (3a): `standardBBoxAnchors` reads `state.w ?? 0`, so any
  // widget declaring it without w/h gets nine anchors on top of each other. That is
  // only honest when the widget really is a 0x0 box at its origin — which a declared
  // `localBounds` can contradict, and did.
  for (const plugin of roster) {
    if (!plugin.anchors || !plugin.localBounds) continue;
    const anchors = plugin.anchors(plugin.defaults);
    if (anchors.length < 2 || anchors.some((a) => a.x !== anchors[0].x || a.y !== anchors[0].y)) continue;
    const b = plugin.localBounds(plugin.defaults);
    assert.deepEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: anchors[0].x, y: anchors[0].y, w: 0, h: 0 },
      `${plugin.type}: every anchor sits at (${anchors[0].x}, ${anchors[0].y}) but its ink rect is ${JSON.stringify(b)} — the anchors describe a box this widget does not have`);
  }
});

// ── (4) reportOnce dedupes; reportAction never does ──────────────────────────

/** Pure function. A display list flattened through the ops that CARRY children
 *  (skySun wraps its fill in the effects bundle), so a nested material op is found.
 *  @example flattenOps([{op: "effectSubtree", content: [{op: "materialFill"}]}]).map((o) => o.op) // ["effectSubtree", "materialFill"] */
function flattenOps(ops) {
  return ops.flatMap((op) => [op, ...(Array.isArray(op.content) ? flattenOps(op.content) : [])]);
}

/** Query (restores console.error before returning). The lines `fn` printed. */
function captureErrors(fn) {
  const lines = [];
  const real = console.error;
  console.error = (line) => lines.push(line);
  try { fn(); } finally { console.error = real; }
  return lines;
}

test("(4) a repeated USER-ACTION refusal is heard every time; a per-frame one is not", () => {
  const key = `silent-promises-probe-${Math.random()}`;
  const framey = captureErrors(() => { reportOnce(key); reportOnce(key); reportOnce(key); });
  assert.deepEqual(framey, [key], "reportOnce is for code a frame loop runs — one line per key");

  const clicky = captureErrors(() => { reportAction("refused"); reportAction("refused"); });
  assert.deepEqual(clicky, ["refused", "refused"],
    "reportAction must answer EVERY act — a second identical click that prints nothing is the silent failure");
});

// ── (5) no material declares a uniform its shader never reads ────────────────

// Uniforms that ARE declared-and-unread on purpose, with the reason. This table may
// only SHRINK: it is a floor under the three lying knobs deleted above, not a licence.
// `blurredBackdrop`/`sharpBackdrop` are THE STANDARD BACKDROP CHILD PAIR — the material
// contract (render_gpu/skia/materials.js) fixes both names and their ORDER, so a
// material that needs only one still declares both. uScale/uTime are framework-supplied
// geometry-prefix floats that no Inspector row promises; unlike the deleted three, no UI
// offers the user a control over them (they are reported in the run below, not tolerated
// in silence).
const TOLERATED_UNREAD = {
  frosted: ["sharpBackdrop"],
  comic: ["blurredBackdrop"],
  brightness_contrast: ["blurredBackdrop"],
  metalStamp: ["blurredBackdrop"], // the stamp RE-LIGHTS the sharp backdrop only; declares usesBlurredBackdrop:false (its own import-time guard cross-checks the claim)
  sky: ["uScale"],
  skyClouds: ["uScale"],
  skySun: ["uScale", "uTime"],
  skyMoon: ["uScale", "uTime"],
};

const UNIFORM_DECL = /uniform\s+[A-Za-z0-9_]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\[\s*\d+\s*\])?\s*;/g;

/** Pure function. SkSL with its comments removed, so a name mentioned only in prose
 *  does not read as a use.
 *  @example strippedSksl("uniform float a; // a is nice\\nhalf4 main() { return half4(a); }").includes("nice") // false */
function strippedSksl(sksl) {
  return sksl.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Pure function. The uniform names `sksl` declares (comments excluded, so a name
 *  merely NAMED in a comment is not a declaration).
 *  @example declaredUniforms("uniform float uA; uniform float2 uB[3]; half4 main() { return half4(uA); }") // ["uA", "uB"] */
export function declaredUniforms(sksl) {
  return [...strippedSksl(sksl).matchAll(UNIFORM_DECL)].map((m) => m[1]);
}

/** Pure function. The uniform names `sksl` DECLARES but its body never mentions.
 *  @example unreadUniforms("uniform float uA; uniform float uB; half4 main() { return half4(uA); }") // ["uB"] */
export function unreadUniforms(sksl) {
  const body = strippedSksl(sksl).replace(UNIFORM_DECL, " ");
  return declaredUniforms(sksl).filter((n) => !new RegExp(`\\b${n}\\b`).test(body));
}

test("(5) every SkSL uniform is read, or is tolerated WITH A REASON", () => {
  for (const id of materialIds()) {
    const material = getMaterial(id);
    if (!material.sksl) continue; // the SAMPLER material (magnify) carries no shader
    const unread = unreadUniforms(material.sksl);
    const tolerated = TOLERATED_UNREAD[id] ?? [];
    const surprising = unread.filter((n) => !tolerated.includes(n));
    assert.deepEqual(surprising, [],
      `material "${id}" declares ${surprising.join(", ")} and never reads it — a uniform nothing reads is a knob that lies`);
    const cleaned = tolerated.filter((n) => !unread.includes(n));
    if (cleaned.length) console.log(`  note  ${id}: ${cleaned.join(", ")} is read now — drop it from TOLERATED_UNREAD`);
  }
});

test("(5b) the three deleted knobs stay deleted, in the shader AND in the Inspector", () => {
  for (const [id, dead] of [["skySun", "uCornerRadius"], ["skyMoon", "uCornerRadius"], ["corkboardThumbtack", "uSeed"]])
    assert.ok(!declaredUniforms(getMaterial(id).sksl).includes(dead), `${id} must not re-declare ${dead}`);
  for (const [type, prop] of [["skySun", "cornerRadius"], ["skyMoon", "cornerRadius"], ["corkboardThumbtack", "seed"]]) {
    const plugin = registry.get(type);
    assert.ok(!(prop in plugin.defaults), `${type} must not carry a "${prop}" property its shader cannot see`);
    assert.ok(!(plugin.inspector ?? []).some((r) => r.key === prop), `${type} must not offer a "${prop}" row`);
  }
});

// A removed uniform must be removed from the PACKER's slot list too, or the block and
// the bytes disagree and every pixel is wrong. Driven through the REAL pipeline (fold →
// evaluate → derive → emit), so the knobs come from the plugin rather than a hand-listed
// mirror of its params — the packer's own length assertion then does the checking.
// Scoped to the three widget types whose uniform block this suite changed; a sweep over
// every plugin is not equivalent (several emit only from an evaluated sibling scene).
test("(5c) the three changed widgets pack through the real pipeline", () => {
  const TYPES = ["skySun", "skyMoon", "corkboardThumbtack"];
  let doc = newDocument();
  const ids = {};
  for (const type of TYPES) {
    let id;
    [doc, id] = withNewItem(doc, 0, { ...registry.get(type).defaults, active: true });
    ids[type] = id;
  }
  const { state, errors } = evaluateState(foldState(doc, 0, 1), registry);
  assert.equal(errors.size, 0, `expression errors: ${[...errors.values()].join("; ")}`);
  const nodes = deriveRenderTree(state, registry);
  const GEOM = { cx: 0, cy: 0, halfW: 80, halfH: 60, cornerRadius: 4, angle: 0, scale: 1 };
  let packed = 0;
  for (const type of TYPES) {
    const node = nodes.find((n) => n.itemId === ids[type]);
    for (const op of flattenOps(node.plugin.emit(node.state, null, node.world))) {
      if (op.op !== "materialFill" && op.op !== "materialBackdrop") continue;
      const material = getMaterial(op.material);
      assert.equal(material.pack({ ...GEOM, ...op.params }).length, material.uniformFloats,
        `${type} -> material "${op.material}" packs a different length than its block declares`);
      packed++;
    }
  }
  assert.equal(packed, TYPES.length, "every one of the three must have produced a material op");
});

console.log(`\nsilent_promises_test: ${passed} passed`);
