/**
 * THE THREE THINGS THE CORNER-CAP FIX RESTORED — plain node, no renderer.
 * Run: node src/demo_apps/PowerRP/tests/shapeshifter-paint_fix_test.js
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Each assertion here pins a defect that shipped green. None of them needed a
 * new renderer, a browser or a pixel: they are all statements about geometry and
 * about declared Inspector rows, which is exactly the shape of thing that rots
 * unwatched because the SUITES that could see it were asking a different
 * question. tests/shape_presets_test.js rendered every callout preset and asked
 * only "is this picture different from that one" — and twelve pictures that are
 * all wrong in the same way are all different from each other.
 *
 *  1. CORNER ROUNDING WAS CAPPED BY THE WHOLE POLYGON'S SHORTEST EDGE.
 *     core/outline.js roundedVerts took ONE global min(edge)/2, so a single short
 *     edge anywhere flattened EVERY corner. On the shipped ss_callout presets the
 *     tail base IS that edge — and it is ZERO-LENGTH whenever the tip is dragged
 *     off the box, because the base clamp then lands baseL on 0 (or baseR on w),
 *     coincident with a body corner. Measured at the widget's own 200x200 box: of
 *     the TEN presets asking for a radius, EIGHT drew less than they asked and
 *     THREE drew exactly 0.0px — Whisper Bubble asked 46.8px and drew four square
 *     corners, and the row described as "a fully rounded pill" drew 16.0px of a
 *     requested 78.0px.
 *  2. THE TAIL WAS NEAR-SHARP ONLY BY ACCIDENT. It was the same global cap doing
 *     it, so fixing (1) would have rounded the pointer into a lollipop. The tail's
 *     three vertices now ask for radius 0 explicitly.
 *  3. THE SCREEN-SPACE STROKE CHECKBOX WAS MISSING ON ALL 19 FAMILIES. The flag
 *     is stamped onto their ops at the ports seam, so the feature RENDERED
 *     correctly on every one of them and no Inspector offered it.
 *
 * ── WHAT IS STILL OPEN, stated here because this is where a reader lands ─────
 * STROKE_SPACE_KEYS_ABSENT below is the remaining half of that third defect:
 * seven more hand-splicing widgets carry the trim + join lists without the space
 * one. They were outside this fix's file lease. The list is asserted EXACTLY, so
 * it can only shrink: adding a widget to the drift fails, and repairing one fails
 * too, with the instruction to delete the line.
 */
import assert from "node:assert/strict";
import { roundedVerts, calloutOutline } from "../core/outline.js";
import { STROKE_TRIM_KEYS, STROKE_JOIN_KEYS, STROKE_SPACE_KEYS } from "../core/properties.js";
import { allPlugins } from "../plugins/index.js";
import { sceneIR } from "../render_gpu/ports.js";
import { FAMILIES, makeFamilyPlugin } from "../plugins/shapeshifter.js";

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/** Pure function. Float-tolerant equality for coordinates. */
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);
/** Pure function. Does the outline contain this exact vertex (a SHARP corner)? */
const hasVertex = (pts, x, y) => pts.some(([px, py]) => Math.abs(px - x) < 1e-9 && Math.abs(py - y) < 1e-9);

// ── (1) THE CAP IS PER CORNER ────────────────────────────────────────────────
test("roundedVerts: a short edge elsewhere in the polygon does not cap this corner", () => {
  // Five-gon whose ONLY short edge (10 long) is two vertices away from [0, 0],
  // whose own edges are 90 and 100 long. The global rule gave every corner 5.
  const out = roundedVerts([[0, 0], [100, 0], [100, 100], [0, 100], [0, 90]], 20);
  approx(out[0][0], 0); approx(out[0][1], 20);
});

test("roundedVerts: a corner IS capped by its own two half-edges", () => {
  // An unbounded request on a 20x20 square: each fillet reaches exactly the
  // midpoint of each incident edge, which is the tightest bound two adjacent
  // fillets can share without crossing.
  const out = roundedVerts([[0, 0], [20, 0], [20, 20], [0, 20]], 1e6);
  approx(out[0][0], 0); approx(out[0][1], 10);
  assert.equal(out.length, 36);
});

test("roundedVerts: a duplicate vertex is dropped, not left to flatten every fillet", () => {
  const clean = roundedVerts([[0, 0], [20, 0], [20, 20], [0, 20]], 5);
  const dup = roundedVerts([[0, 0], [20, 0], [20, 20], [20, 20], [0, 20]], 5);
  assert.deepEqual(dup, clean, "the coincident pair is one corner, and rounds like one");
});

test("roundedVerts: a per-vertex radius of 0 leaves THAT corner sharp and no other", () => {
  const out = roundedVerts([[0, 0], [20, 0], [20, 20], [0, 20]], [5, 0, 0, 0]);
  assert.equal(out.length, 12, "9 fillet samples + 3 bare vertices");
  assert.ok(hasVertex(out, 20, 0) && hasVertex(out, 20, 20) && hasVertex(out, 0, 20), "the three 0-radius corners survive verbatim");
  assert.ok(!hasVertex(out, 0, 0), "the rounded one does not");
});

// ── (2) THE CALLOUT FAMILY, at the box its presets were authored against ─────
const calloutFam = FAMILIES.find((f) => f.type === "ss_callout");
const callout = makeFamilyPlugin(calloutFam);
const calloutPresets = [{ name: "(DEFAULT)", props: {} }, ...calloutFam.presets.map((p) => ({ name: p.name, props: p.props }))];
/** Query. A preset folded over the plugin's own defaults — the 200x200 box every
 *  callout preset's absolute tailX/tailY was picked against. */
const calloutState = (props) => ({ ...callout.defaults, ...props });

test("ss_callout: EVERY preset with a corner radius rounds ALL FOUR body corners", () => {
  const sharp = [];
  for (const { name, props } of calloutPresets) {
    const s = calloutState(props);
    if (!(s.cornerRadius > 0)) continue;
    const pts = calloutFam.outline(s)[0];
    const bodyH = s.h * 0.78;
    for (const [cx, cy] of [[0, 0], [s.w, 0], [s.w, bodyH], [0, bodyH]])
      if (hasVertex(pts, cx, cy)) sharp.push(`${name} @ (${cx},${cy})`);
  }
  assert.deepEqual(sharp, [], "these body corners rendered SHARP with a non-zero corner radius");
});

test("ss_callout: Whisper Bubble gets the radius it asks for (the headline case)", () => {
  // tailX -60 is off the box, so the base clamp makes baseL exactly 0 — the
  // zero-length edge that used to render this row with four square corners.
  const s = calloutState(calloutFam.presets.find((p) => p.name === "Whisper Bubble").props);
  const requested = s.cornerRadius * Math.min(s.w, s.h * 0.78) / 2;
  const pts = calloutFam.outline(s)[0];
  // The top-left fillet starts `requested` down the left edge (which is long
  // enough to hold it), so that point IS the effective radius.
  const onLeftEdge = pts.filter(([x]) => Math.abs(x) < 1e-9).map(([, y]) => y);
  approx(Math.min(...onLeftEdge), requested, 1e-9);
  assert.ok(requested > 0, "the preset asks for a radius at all");
});

test("ss_callout: the tail TIP stays sharp at every radius, and the tail keeps its point", () => {
  for (const { name, props } of calloutPresets) {
    const s = calloutState(props);
    const tipX = s.tailX ?? s.w * 0.25, tipY = s.tailY ?? s.h;
    assert.ok(hasVertex(calloutFam.outline(s)[0], tipX, tipY), `${name}: the tail tip was rounded off`);
  }
});

test("calloutOutline: a flush tail base is ONE vertex, so the body corner it lands on can round", () => {
  // baseL clamps to exactly 0 here; the old list emitted [0, bodyH] twice.
  const pts = calloutOutline(100, 80, { cornerRadius: 1, tailX: -50, tailY: 100, tailWidth: 0.2 })[0];
  assert.ok(!hasVertex(pts, 0, 80 * 0.78), "the bottom-left body corner is rounded, not a duplicated sharp point");
  assert.ok(hasVertex(pts, -50, 100), "and the tip is still there");
});

// ── (3) THE UNIVERSAL STROKE ROWS TRAVEL TOGETHER ────────────────────────────
/** Query. The set of property keys a plugin's inspector declares. */
const rowKeys = (plugin) => new Set((plugin.inspector ?? []).map((r) => r.key));
const hasAll = (keys, list) => list.every((k) => keys.has(k));

/**
 * The widgets that STILL carry the trim rows without the screen-space row, each
 * one a plugin file outside the lease this fix was allowed to touch. To repair
 * one: splice `...STROKE_SPACE_KEYS` beside its `...STROKE_TRIM_KEYS` (the flag
 * modifies strokeWidth, so it goes FIRST of the three, as the two bundles and
 * makeFamilyPlugin's inspector array do) and DELETE it from this list, which the
 * assertion below will then demand.
 */
const STROKE_SPACE_KEYS_ABSENT = ["labeled_circle", "pptxPreset", "iris_blades", "graph_line", "graph_tick_marks", "graph_grid", "graph_bars"];

test("every shapeshifter family offers the screen-space row beside trim and join", () => {
  const missing = [];
  for (const fam of FAMILIES) {
    const keys = rowKeys(makeFamilyPlugin(fam));
    assert.ok(hasAll(keys, STROKE_TRIM_KEYS) && hasAll(keys, STROKE_JOIN_KEYS), `${fam.type} lost the trim/join rows`);
    if (!hasAll(keys, STROKE_SPACE_KEYS)) missing.push(fam.type);
  }
  assert.deepEqual(missing, [], "these families render the screen-space flag but offer no checkbox for it");
  assert.ok(FAMILIES.length >= 19, `the gate needs real subjects; found ${FAMILIES.length} families`);
});

/** Pure function. A node the ports seam will walk, in screen_space_test's shape. */
const strokeNode = (plugin, extra) => ({
  itemId: "i", type: plugin.type, plugin,
  world: { x: 0, y: 0, rotation: 0, scale: 1 },
  state: { ...plugin.defaults, x: 0, y: 0, w: 200, h: 150, rotation: 0, scale: 1, stroke: "#000000", strokeWidth: 4, ...extra },
});
/** Pure function. Every op in an IR tree that OWNS a stroke — the ones the
 *  applyStrokeSpace stamper is contracted to reach. */
function strokedOps(cmds, out = []) {
  for (const c of cmds ?? []) {
    if (c.stroke != null) out.push(c);
    strokedOps(c.children, out);
    strokedOps(c.commands, out);
  }
  return out;
}

test("the checkbox is HONOURED, not merely declared — the two halves joined", () => {
  // The lesson tests/screen_space_test.js records in its own header: asserting
  // that the row exists and that the IR builder accepts the key both passed for
  // the feature's whole broken life, because neither joins the halves. So drive
  // the real ports seam over each family and read the ops.
  for (const fam of FAMILIES) {
    const plugin = makeFamilyPlugin(fam);
    const on = strokedOps(sceneIR([strokeNode(plugin, { strokeScreenSpace: true })]));
    assert.ok(on.length > 0, `${fam.type}: emitted no stroked op to carry the flag`);
    assert.ok(on.every((o) => o.strokeScreenSpace === true), `${fam.type}: the checkbox is ON and its ops do not carry strokeScreenSpace`);
    // ABSENT-IS-LEGACY: with the box unchecked the ops must be byte-identical.
    for (const o of strokedOps(sceneIR([strokeNode(plugin, {})])))
      assert.ok(!("strokeScreenSpace" in o), `${fam.type}: an unchecked widget stamped the key anyway`);
  }
});

test("the roster-wide drift is EXACTLY the pinned list — it may only shrink", () => {
  const drifted = allPlugins
    .filter((p) => hasAll(rowKeys(p), STROKE_TRIM_KEYS) && !hasAll(rowKeys(p), STROKE_SPACE_KEYS))
    .map((p) => p.type);
  assert.deepEqual(drifted, STROKE_SPACE_KEYS_ABSENT,
    "a widget carries the trim rows without the screen-space row. If you FIXED one, delete it from STROKE_SPACE_KEYS_ABSENT; if you ADDED one, splice ...STROKE_SPACE_KEYS into it.");
});

console.log(`\nshapeshifter-paint_fix_test: ${passed} passed`);
