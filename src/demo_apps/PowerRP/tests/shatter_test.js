/**
 * SHATTER core tests — the pure decisions, in bare node, with no browser.
 * Run: node src/demo_apps/PowerRP/tests/shatter_test.js
 *
 * tests/shatter_probe.js proves the FEATURE end to end in a real browser. This
 * file exists for the two things a probe is the wrong instrument for:
 *
 * 1. THE MIRROR GATE. plugins/mermaid.js MERMAID_MARKER_HEADS maps mermaid's
 *    marker vocabulary onto core/endpoints.js HEAD_SHAPES, and it CANNOT be
 *    derived — only a human knows that UML `extension` means a hollow triangle.
 *    A non-derivable mirror is owed a gate that fails when the two drift
 *    (ledger C-7/C-8), and this is it. Without one, renaming a head shape would
 *    leave the shatter writing a value no connector understands, and the only
 *    symptom would be an arrowhead quietly not drawing.
 *
 *    The gate lives HERE and not at import scope on purpose (ledger C-19): a
 *    module that refuses to load takes every suite transitively reaching
 *    paint_skia down with it, for a defect in one table.
 *
 * 2. THE REFUSALS. A part key that cannot tokenize, a plan whose parts reference
 *    a key nobody supplied — both must throw, and a browser probe can only reach
 *    them by breaking the feature.
 */

import assert from "node:assert/strict";
import { HEAD_SHAPES } from "../core/endpoints.js";
import {
  partKey, partRef, vectorRecovery, countedTitle, shatterEligible,
  shatterNotReadyReason, shatterDisclosure, SHATTER_NAME_SEPARATOR,
} from "../core/shatter.js";
import {
  MERMAID_MARKER_HEADS, markerBaseName, shatterHeadShape, pathPoints,
  pathsBounds, mermaidViewToWorld, pathsToSvgSrc, authorIdOf, edgeEndpoints, partKeyFor,
} from "../plugins/mermaid.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── 1. THE MIRROR GATE ───────────────────────────────────────────────────────

test("every head shape the mermaid map names is a REAL head shape", () => {
  const shapes = new Set(HEAD_SHAPES);
  const stray = Object.entries(MERMAID_MARKER_HEADS).filter(([, v]) => !shapes.has(v));
  assert.deepEqual(stray, [],
    `these mermaid markers map to head shapes core/endpoints.js does not define: ${JSON.stringify(stray)}. ` +
    "Either the shape was renamed (update this map in the SAME commit) or the map has a typo — " +
    "an unknown value writes a head no connector draws, and nothing else would notice.");
});

test("the gate can fail — a bogus mapping is caught", () => {
  // Proves the assertion above is not vacuous: if HEAD_SHAPES ever came back
  // empty or the lookup silently succeeded, this would go green and so would it.
  assert.ok(HEAD_SHAPES.length > 5, `HEAD_SHAPES looks empty (${HEAD_SHAPES.length}) — the gate above would pass vacuously`);
  assert.ok(!new Set(HEAD_SHAPES).has("definitelyNotAHeadShape"));
});

test("the map covers the marker families mermaid actually emits", () => {
  // A FLOOR, not a full list: mermaid may add markers, and a new one is handled
  // (shatterHeadShape returns null and the disclosure names it). These are the
  // ones whose ABSENCE would mean a diagram family lost its meaning entirely.
  for (const base of ["point", "extension", "composition", "aggregation", "cross", "onlyOne", "zeroOrMore"])
    assert.ok(MERMAID_MARKER_HEADS[base], `no head mapped for mermaid's "${base}" marker`);
});

// ── 2. MARKER ID → SHAPE ─────────────────────────────────────────────────────

test("markerBaseName strips mermaid's diagram prefix and Start/End suffix", () => {
  assert.equal(markerBaseName("flowchart-pointEnd"), "point");
  assert.equal(markerBaseName("classDiagram-extensionStart"), "extension");
  assert.equal(markerBaseName("erDiagram-zeroOrMoreEnd"), "zeroOrMore");
  assert.equal(markerBaseName("requirementDiagram-requirement_containsStart"), "requirement_contains");
  assert.equal(markerBaseName(""), "");
});

test("an UNKNOWN marker returns null, never a plausible wrong glyph", () => {
  assert.equal(shatterHeadShape("flowchart-pointEnd"), "triangle");
  assert.equal(shatterHeadShape("classDiagram-aggregationStart"), "diamondOpen");
  // The load-bearing case. Defaulting this to "triangle" would draw a UML
  // aggregation as a plain arrow: correct-looking, wrong meaning, silent.
  assert.equal(shatterHeadShape("flowchart-somethingNewEnd"), null);
  assert.equal(shatterHeadShape(undefined), null);
  assert.equal(shatterHeadShape(""), null);
});

test("UML's three relation heads stay DISTINCT — the whole reason the vocabulary grew", () => {
  const uml = ["extension", "composition", "aggregation"].map((b) => MERMAID_MARKER_HEADS[b]);
  assert.equal(new Set(uml).size, 3, `inheritance/composition/aggregation collapsed onto ${JSON.stringify(uml)}`);
});

// ── 3. PART KEYS — the tokenizing rule, earned twice ─────────────────────────

test("partKey yields a legal reference token with NO underscore", () => {
  assert.equal(partKey("Do it"), "DoIt");
  assert.equal(partKey("Start"), "Start");
  assert.equal(partKey("Is it valid?"), "IsItValid");
  assert.equal(partKey("2nd stage"), "P2ndStage");
  assert.equal(partKey(""), "part");
  // THE INVARIANT, stated as a property rather than as five examples: core/
  // document.js withItemRefsRemapped splits an underscored reference at its
  // FIRST underscore, so `@Do_it_tl.x` resolves to `Do`. Measured, not assumed.
  for (const messy of ["Do it", "a_b", "  ", "!!!", "Node #3", "café au lait", "2"])
    assert.match(partKey(messy), /^[A-Za-z][A-Za-z0-9]*$/, `partKey(${JSON.stringify(messy)}) = ${partKey(messy)}`);
});

test("partKeyFor de-collides WITHOUT an underscore", () => {
  const taken = new Set();
  assert.equal(partKeyFor("Start", "x-flowchart-A-0", taken), "Start");
  assert.equal(partKeyFor("Start", "x-flowchart-B-1", taken), "Start2");
  assert.equal(partKeyFor("Start", "x-flowchart-C-2", taken), "Start3");
  assert.equal(partKeyFor("Do it", "x-flowchart-D-3", taken), "DoIt");
});

test("partRef writes the document's own stored @id form", () => {
  assert.equal(partRef("nodeA"), "@nodeA");
  assert.equal(`= ${partRef("Start")}_mid.x + 12`, "= @Start_mid.x + 12");
});

// ── 4. MERMAID ID RECOVERY ───────────────────────────────────────────────────

test("authorIdOf recovers the id the AUTHOR wrote, not the first segment", () => {
  // The regression that made every edge fall back to an unanchored path: a lazy
  // quantifier matched the FIRST `-word-` and returned "0-flowchart-A".
  assert.equal(authorIdOf("powerrp-mermaid-0-flowchart-A-0"), "A");
  assert.equal(authorIdOf("powerrp-mermaid-2-classId-Animal-0"), "Animal");
  assert.equal(authorIdOf("powerrp-mermaid-3-state-root_start-0"), "root_start");
  assert.equal(authorIdOf("Alice"), null);
});

test("edgeEndpoints refuses an AMBIGUOUS split rather than guessing", () => {
  assert.deepEqual(edgeEndpoints("L_A_B_0", new Set(["A", "B"])), { from: "A", to: "B" });
  assert.deepEqual(edgeEndpoints("id_Animal_Dog_1", new Set(["Animal", "Dog", "Cat"])), { from: "Animal", to: "Dog" });
  // Underscored author ids make the split ambiguous; only the reading whose two
  // halves are BOTH real ids counts.
  assert.deepEqual(edgeEndpoints("L_my_node_a_my_node_b_0", new Set(["my_node_a", "my_node_b"])), { from: "my_node_a", to: "my_node_b" });
  // stateDiagram numbers its edges and says nothing else — null, and the caller
  // keeps the exact path instead of inventing endpoints.
  assert.equal(edgeEndpoints("edge0", new Set(["Idle"])), null);
});

// ── 5. GEOMETRY ──────────────────────────────────────────────────────────────

test("pathPoints reads every coordinate pair", () => {
  assert.deepEqual(pathPoints("M10 20L30 60"), [{ x: 10, y: 20 }, { x: 30, y: 60 }]);
  assert.equal(pathPoints("M0,0 L10,0 L10,10").length, 3);
  assert.deepEqual(pathPoints(""), []);
});

test("pathsBounds contains the ink and never under-estimates", () => {
  assert.deepEqual(pathsBounds([{ d: "M10 20L30 60" }]), { x: 10, y: 20, w: 20, h: 40 });
  assert.deepEqual(pathsBounds([{ d: "M0 0L10 0" }, { d: "M-5 3L2 9" }]), { x: -5, y: 0, w: 15, h: 9 });
  assert.equal(pathsBounds([]), null);
});

test("mermaidViewToWorld reproduces the widget's OWN letterbox", () => {
  assert.deepEqual(mermaidViewToWorld({ minX: 0, minY: 0, w: 100, h: 100 }, { x: 10, y: 20, w: 200, h: 200 }, true),
    { sx: 2, sy: 2, ox: 10, oy: 20 });
  assert.deepEqual(mermaidViewToWorld({ minX: 0, minY: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 100 }, true),
    { sx: 1, sy: 1, ox: 0, oy: 25 });
  assert.deepEqual(mermaidViewToWorld({ minX: 0, minY: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 100 }, false),
    { sx: 1, sy: 2, ox: 0, oy: 0 });
});

test("pathsToSvgSrc keeps the `d` VERBATIM — that is why the ink is identical", () => {
  const d = "M12.3456789 4L99.999 1e-3";
  assert.ok(pathsToSvgSrc([{ d, stroke: "#333", strokeWidth: 2, fill: null }], { x: 0, y: 0, w: 100, h: 10 }).includes(d),
    "a rounded or re-emitted `d` would move the ink");
});

// ── 6. THE SEAM'S OWN RULES ──────────────────────────────────────────────────

test("shatterEligible is a predicate over DECLARATIONS, not a list", () => {
  assert.equal(shatterEligible({ type: "mermaid", shatter: () => ({ parts: [] }) }), true);
  assert.equal(shatterEligible({ type: "rect" }), false);
  assert.equal(shatterEligible({ type: "group", shatter: () => ({ parts: [] }), foldsSubtree: () => true }), false);
  assert.equal(shatterEligible(undefined), false);
});

test("readiness is OPTIONAL and its sentence comes from the WIDGET", () => {
  assert.equal(shatterNotReadyReason({ shatter: () => ({ parts: [] }) }, {}), null);
  assert.equal(shatterNotReadyReason({ shatter: () => ({}), shatterNotReady: () => "a rendered diagram" }, {}), "a rendered diagram");
});

test("vectorRecovery counts, and an empty plan recovered everything it had", () => {
  assert.equal(vectorRecovery([{}, {}, {}]), 1);
  assert.equal(vectorRecovery([{}, { raster: true }, {}, {}]), 0.75);
  assert.equal(vectorRecovery([]), 1);
});

test("the disclosure names WHAT, in counts an author can act on", () => {
  const registry = { get: (t) => ({ rect: { title: "Rectangle" }, arrow: { title: "Arrow" } }[t]) };
  const parts = [{ state: { type: "rect" } }, { state: { type: "rect" } }, { state: { type: "arrow" } }];
  const text = shatterDisclosure(parts, registry, ["3 edges are straight."]);
  assert.match(text, /2 Rectangles/);
  assert.match(text, /1 Arrow\b/);
  assert.match(text, /3 edges are straight\./);
  assert.equal(shatterDisclosure([], registry), "Nothing to shatter — this widget draws no recoverable parts.");
  assert.equal(countedTitle("Rectangle", 3), "3 Rectangles");
  assert.equal(countedTitle("Arrow", 1), "1 Arrow");
});

test("a raster fallback is DISCLOSED, never folded into the vector count", () => {
  const registry = { get: (t) => ({ rect: { title: "Rectangle" }, image: { title: "Image" } }[t]) };
  const text = shatterDisclosure([{ state: { type: "rect" } }, { state: { type: "image" }, raster: true }], registry);
  assert.match(text, /1 Rectangle as editable widgets/);
  assert.match(text, /1 Image kept as raster/);
});

test("the child-name separator survives as one slug segment", () => {
  // The display glyph was the only open choice: slugify collapses any
  // non-alphanumeric run to one "_", so the equation slug lands on the app's
  // existing <parent>_<child> parentage form whatever separator is picked.
  assert.match(SHATTER_NAME_SEPARATOR, /^\s*\S+\s*$/);
  assert.equal(`Flowchart${SHATTER_NAME_SEPARATOR}Start`.replace(/[^a-z0-9]+/gi, "_").toLowerCase(), "flowchart_start");
});

console.log(`\n${passed} shatter core tests passed`);
