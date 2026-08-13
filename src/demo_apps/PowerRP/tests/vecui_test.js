/**
 * COLOUR CHANNEL ROWS + THE FOLD SEAM + THE vec2 CONTROL (workstream VECUI_;
 * backburner CY, manifest R7-36 / R7-38 / R7-38a / R7-38b / R7-38c).
 *
 * Bare-node suite over the last slice of the vector work: the Inspector-facing
 * GENERATOR that gives a colour row R/G/B/A children, and the fold seam that
 * makes a channel keyframe a real, tweening value rather than a paint-destroying
 * merge. Four things here cannot be seen by any rendering test and are the
 * reason this file exists:
 *
 *   • THE GENERATOR IS DRIVEN BY THE NAMING TABLE, NOT BY LITERALS (R7-38c
 *     forbids arity/name hardcoding). Pinned by PLANTING A FIFTH CHANNEL on the
 *     live declaration and asserting a fifth row appears with no UI edit — the
 *     only way to prove "one generator, not 32 hand-written rows" rather than
 *     assert it.
 *   • THE FOLD RESOLVES, IT DOES NOT MERGE. `{fill: {color: {r: 255}}}` over a
 *     hex string must produce a hex string. Before the seam it produced
 *     `{"fill":{"color":{"r":255}}}` — an object that ir.js isGradientPaint reads
 *     as a stopless gradient, i.e. a throw on every frame. The regression is
 *     invisible to anything that only asks "did the pixels change".
 *   • THE HOT PATH IS UNTOUCHED FOR EVERY LEGACY DELTA. The guard fires only for
 *     a component wrapper; a gradient patch, a paint switch, a whole-colour
 *     write and a sparse list keyframe must all take the arms they always took,
 *     byte-identically.
 *   • REFUSALS NEVER CORRUPT. An off/material/crossfade paint under a channel
 *     delta must come back EXACTLY as it went in, with a sentence available —
 *     never a half-write, never a silent no-op that pretends it wrote.
 *
 * Run: node src/demo_apps/PowerRP/tests/vecui_test.js
 */

import assert from "node:assert/strict";
import {
  colorChannelRows, colorCompoundRow, withColorChannelRows, colorRowIsChannelBearing,
  ROW_KINDS, PROPS, UNIT_SPAN_SCRUB,
} from "../core/properties.js";
import {
  VECTOR_KINDS, COLOR_VECTOR_ADDRESS, COLOR_CHANNEL_MAX, COLOR_VECTOR_ARITY,
  VEC2_ROW_KIND, isVec2Value, colorAlphaAxis,
  componentDeltaIsColor, resolveColorComponentDelta, lerpedColorComponents,
  paintColorPath, paintColorRefusal,
} from "../core/vector_values.js";
import { applied, blendApplied } from "../core/deltas.js";
import { keyframed, foldState } from "../core/document.js";
import { JOINT_EDITABLE_KINDS, JOINT_UNEDITABLE_KINDS } from "../core/multiselect.js";
import { VAR_KINDS, VAR_KIND_ZEROS } from "../core/var_kinds.js";
import { sectionKeyPaths } from "../core/section_keyframes.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("vecui_test");

const FILL_ROW = { key: "fill", label: "Fill", kind: "color", paint: true, category: "fillMaterial" };
const SHADOW_ROW = { key: "shadow.color", label: "Shadow color", kind: "color", category: "effects" };

// ── THE GENERATOR ───────────────────────────────────────────────────────────

test("a colour row gains one child per DECLARED axis, at the real dotted path", () => {
  const rows = colorChannelRows(FILL_ROW);
  assert.deepEqual(rows.map((r) => r.key),
    ["fill.color.r", "fill.color.g", "fill.color.b", "fill.color.a"]);
  // THE KEY IS THE WRITE PATH AND THE EQUATION ADDRESS, the same string — that
  // identity is what makes a channel row an ordinary row rather than a special
  // case with its own plumbing.
  assert.equal(rows.length, COLOR_VECTOR_ARITY);
  for (const r of rows) assert.equal(r.kind, "number");
});

test("a plain colour row already ending in `color` does not say it twice", () => {
  assert.deepEqual(colorChannelRows(SHADOW_ROW).map((r) => r.key),
    ["shadow.color.r", "shadow.color.g", "shadow.color.b", "shadow.color.a"]);
  // …while a colour row NOT named `color` gets the address inserted, which is
  // exactly what core/expressions.js readVectorAddress resolves.
  assert.deepEqual(
    colorChannelRows({ key: "particleColor", label: "Color", kind: "color" }).map((r) => r.key),
    ["particleColor.color.r", "particleColor.color.g", "particleColor.color.b", "particleColor.color.a"]);
});

test("THE GENERALITY PIN: a planted 5th channel yields a 5th row, with NO UI edit", () => {
  // R7-38c: "nothing hardcoding arity 2/3/4 or rank 1". The only honest way to
  // test that is to CHANGE the arity and watch the generator follow.
  const axes = VECTOR_KINDS[COLOR_VECTOR_ADDRESS].axes;
  const before = [...axes];
  axes.push("w");
  try {
    const rows = colorChannelRows(FILL_ROW);
    assert.equal(rows.length, 5, "the generator reads the table, it does not know 4");
    assert.equal(rows[4].key, "fill.color.w");
    assert.equal(rows[4].label, "W");
    // AND THE ALPHA RULE FOLLOWS THE TABLE TOO: alpha is the LAST axis, asked
    // via colorAlphaAxis, never compared against the literal "a". So the new
    // last channel takes the fraction bounds and the old one becomes a byte.
    assert.equal(colorAlphaAxis(), "w");
    assert.equal(rows[4].max, 1, "the new last axis is the alpha");
    assert.equal(rows[3].max, COLOR_CHANNEL_MAX, "the former alpha is now an ordinary channel");
  } finally {
    axes.length = 0;
    axes.push(...before);
  }
  // restored, so the rest of the suite sees the real table
  assert.deepEqual(VECTOR_KINDS[COLOR_VECTOR_ADDRESS].axes, ["r", "g", "b", "a"]);
  assert.equal(colorAlphaAxis(), "a");
});

test("THE UNITS ARE THE ADDRESS'S UNITS: rgb are bytes, alpha is a fraction", () => {
  const rows = colorChannelRows(FILL_ROW);
  assert.deepEqual(rows.map((r) => r.max), [COLOR_CHANNEL_MAX, COLOR_CHANNEL_MAX, COLOR_CHANNEL_MAX, 1]);
  assert.deepEqual(rows.map((r) => r.min), [0, 0, 0, 0]);
  // The scrub coefficient follows the units, so one dragged pixel means a
  // comparable amount of colour on every channel.
  assert.deepEqual(rows.map((r) => r.scrub), [1, 1, 1, UNIT_SPAN_SCRUB]);
});

test("children inherit the parent's CATEGORY, so a compound never straddles sections", () => {
  for (const r of colorChannelRows(FILL_ROW)) assert.equal(r.category, "fillMaterial");
  for (const r of colorChannelRows(SHADOW_ROW)) assert.equal(r.category, "effects");
});

test("the PARENT keeps its own control — the picker still edits the whole colour", () => {
  const node = colorCompoundRow(FILL_ROW);
  assert.equal(node.compound, true);
  // `editor: "self"` is the whole of R7-36's "whole-colour editing stays the
  // parent row's control". A `pad2d` here would have replaced the swatch with a
  // decomposition of itself.
  assert.equal(node.editor, "self");
  assert.equal(node.kind, "color", "and it is still a colour row underneath");
  assert.equal(node.paint, true, "…and still a paint row, so PaintField still mounts");
});

test("a non-colour row is returned untouched, and gets no triangle", () => {
  assert.deepEqual(colorChannelRows({ key: "x", kind: "number" }), []);
  assert.equal(colorCompoundRow({ key: "x", kind: "number" }), null);
  assert.equal(colorRowIsChannelBearing({ key: "x", kind: "number" }), false);
  const rows = [{ key: "x", kind: "number" }, { key: "w", kind: "number" }];
  assert.deepEqual(withColorChannelRows(rows), rows);
});

test("withColorChannelRows PRESERVES order and count — it never adds or moves a row", () => {
  const rows = [{ key: "a", kind: "number" }, FILL_ROW, { key: "b", kind: "number" }];
  const out = withColorChannelRows(rows);
  assert.equal(out.length, rows.length);
  assert.deepEqual(out.map((r) => r.key), ["a", "fill", "b"]);
  assert.deepEqual(out.map((r) => r.compound === true), [false, true, false]);
});

test("EVERY REAL colour row in PROPS generates channels — the sweep, not a sample", () => {
  const colorKeys = Object.entries(PROPS).filter(([, d]) => d.kind === "color").map(([k]) => k);
  assert.ok(colorKeys.length >= 5, `expected several colour rows, found ${colorKeys.length}`);
  for (const key of colorKeys) {
    const rows = colorChannelRows({ key, ...PROPS[key] });
    assert.equal(rows.length, COLOR_VECTOR_ARITY, `${key} produced ${rows.length} channels`);
    // No generated key may collide with a REAL declared property — that would
    // make a channel row and a stored property fight over one path.
    for (const r of rows) assert.ok(!(r.key in PROPS), `generated ${r.key} collides with a declared property`);
  }
});

// ── THE TRI-STATE DIAMOND'S PATH SET ────────────────────────────────────────

test("the diamond speaks for the FOUR CHANNEL PATHS, not for the parent colour", () => {
  const node = colorCompoundRow(FILL_ROW);
  const paths = sectionKeyPaths(node.children, () => ["item1"], (r) => r.key);
  // THE DOT IS A PATH SEPARATOR — sectionKeyPaths splits it, so the diamond
  // keyframes the real nested slot `items.item1.fill.color.r` and NOT a literal
  // key spelled "fill.color.r" beside it. That distinction is the whole of this
  // file's own "THE DOT IS A PATH SEPARATOR" note in web/Inspector.svelte: the
  // unsplit form writes a phantom leaf no reader looks at.
  assert.deepEqual(paths, [
    ["items", "item1", "fill", "color", "r"],
    ["items", "item1", "fill", "color", "g"],
    ["items", "item1", "fill", "color", "b"],
    ["items", "item1", "fill", "color", "a"],
  ]);
  // THE PARENT'S OWN PATH IS NOT IN THE SET, which is what makes the tri-state
  // honest: "some" means some CHANNELS are keyed, and a whole-colour keyframe at
  // `fill` is a different statement that this diamond does not claim to make.
  assert.ok(!paths.some((p) => p.length === 3 && p[2] === "fill"));
});

// ── PER-PAINT-KIND ABSENCE (the disclosure is ABSENT, not disabled-and-lying) ─

test("paintColorPath answers per kind, and the refusals name the author's slot", () => {
  // The ROW always could have channels; whether THIS paint does is a question
  // about the value. These are the answers the Inspector gates the triangle on.
  assert.deepEqual(paintColorPath("#7aa2f7"), [], "a bare hex IS the colour");
  assert.deepEqual(paintColorPath({ type: "solid", solid: "#f00" }), ["solid"]);
  assert.deepEqual(paintColorPath({ type: "linearGradient", solid: "#f00" }), ["solid"],
    "a gradient's REMEMBERED solid is addressable — legal and inert");
  for (const kind of ["none", "material", "crossfade"]) {
    assert.equal(paintColorPath({ type: kind }), null, `${kind} has no addressable colour`);
    const sentence = paintColorRefusal({ type: kind }, "fill.color");
    assert.ok(sentence && sentence.includes("fill.color"), `${kind} must refuse with a sentence naming the slot`);
  }
});

// ── THE FOLD SEAM: RESOLUTION, NOT MERGING ──────────────────────────────────

test("THE REGRESSION THIS SEAM EXISTS FOR: a channel delta yields a COLOUR, not an object", () => {
  const out = applied({ fill: "#123456" }, { fill: { color: { r: 255 } } });
  assert.equal(typeof out.fill, "string", "a merge would leave an OBJECT here — the stopless-gradient bug");
  assert.equal(out.fill, "#ff3456");
  // The un-keyed channels come through byte-for-byte: 34 and 56 are the base's.
  assert.ok(out.fill.endsWith("3456"));
});

test("per paint kind, the write side MIRRORS the read side", () => {
  // solid, tagged
  assert.deepEqual(applied({ fill: { type: "solid", solid: "#123456" } }, { fill: { color: { r: 255 } } }),
    { fill: { type: "solid", solid: "#ff3456" } });
  // gradient: the remembered solid moves, and the gradient's own data survives
  const grad = applied(
    { fill: { type: "linearGradient", solid: "#123456", linear: { stops: [1, 2] } } },
    { fill: { color: { g: 255 } } });
  assert.equal(grad.fill.solid, "#12ff56");
  assert.deepEqual(grad.fill.linear, { stops: [1, 2] }, "stops and geometry are untouched");
  // alpha is a FRACTION and lands as the 8-digit spelling
  assert.equal(applied({ fill: "#ff0000" }, { fill: { color: { a: 0.5 } } }).fill, "#ff000080");
});

test("A REFUSING PAINT COMES BACK EXACTLY AS IT WENT IN — never corrupted, never half-written", () => {
  for (const paint of [{ type: "none" }, { type: "material", material: { id: "brass" } }, { type: "crossfade" }]) {
    const before = JSON.stringify(paint);
    const out = applied({ fill: structuredClone(paint) }, { fill: { color: { r: 255, g: 128 } } });
    assert.equal(JSON.stringify(out.fill), before, `${paint.type} must be untouched`);
    // and the sentence is available to whatever surface can speak
    const { refusal, paint: written } = resolveColorComponentDelta(paint, { r: 255 }, "fill");
    assert.ok(refusal, `${paint.type} must produce a sentence`);
    assert.equal(written, undefined, "a refusal writes NOTHING");
  }
});

test("THE TWEEN IS THE POINT: a keyed channel lerps, and the others do not move", () => {
  const base = { fill: "#123456" };
  const delta = { fill: { color: { r: 255 } } };
  const at = (a) => blendApplied(base, delta, a).fill;
  assert.equal(at(0), "#123456", "alpha 0 is the base, untouched");
  assert.equal(at(1), "#ff3456", "alpha 1 is the stored target exactly — the endpoint law");
  // LINEAR in the keyed channel: 0x12 = 18 -> 255, so half is 136.5 -> 0x89.
  assert.equal(at(0.5), "#893456");
  assert.equal(at(0.25), "#4d3456");
  assert.equal(at(0.75), "#c43456");
  // THE OTHER CHANNELS ARE FROZEN ACROSS EVERY FRAME. This is the honesty claim
  // made executable: "only R is keyframed here" must MEAN only R moves.
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(at(a).endsWith("3456"), `G and B moved at alpha ${a}: ${at(a)}`);
  }
});

test("a MULTI-channel keyframe lerps each channel independently", () => {
  const out = blendApplied({ fill: "#000000" }, { fill: { color: { r: 255, b: 128 } } }, 0.5);
  // r: 0 -> 255 half = 127.5 -> 0x80; b: 0 -> 128 half = 64 -> 0x40; g untouched.
  assert.equal(out.fill, "#800040");
});

test("PRECEDENCE is positional, and both directions are stated", () => {
  // whole-then-channel: the channel folds over the NEW base
  assert.equal(applied(applied({ fill: "#123456" }, { fill: "#00ff00" }), { fill: { color: { r: 255 } } }).fill,
    "#ffff00");
  // channel-then-whole: a whole colour is a complete value and wins outright
  assert.equal(applied(applied({ fill: "#123456" }, { fill: { color: { r: 255 } } }), { fill: "#00ff00" }).fill,
    "#00ff00");
});

test("AN ADDITION IS DECLINED — a channel over an absent slot invents no colour", () => {
  const out = applied({}, { fill: { color: { r: 255 } } });
  assert.equal(out.fill, undefined, "materializing #000000 to receive a channel would be a colour nobody wrote");
  assert.deepEqual(out, {});
});

// ── THE HOT-PATH GUARD: EVERY LEGACY DELTA TAKES THE OLD ARM ────────────────

test("THE GUARD IS FALSE FOR EVERY LEGACY DELTA SHAPE (the structural pin)", () => {
  const legacy = [
    { color: "#ff0000" },                       // a WHOLE-colour write
    { stops: [] },                              // a gradient patch
    { type: "material" },                       // a paint switch
    { color: { z: 1 } },                        // an unknown component name
    { color: {} },                              // an empty wrapper claims nothing
    { color: { r: 1 }, other: 2 },              // more than the one address
    { blur: 4, color: { r: 1 } },               // an effects bundle carrying a colour
    "#ff0000", 42, null, [1, 2, 3],             // non-objects
  ];
  for (const d of legacy) {
    assert.equal(componentDeltaIsColor(d), false, `guard fired on legacy shape ${JSON.stringify(d)}`);
  }
  // …and TRUE for exactly the wrapper the channel rows write.
  assert.equal(componentDeltaIsColor({ color: { r: 255 } }), true);
  assert.equal(componentDeltaIsColor({ color: { r: 255, g: 0, b: 0, a: 1 } }), true);
});

test("legacy fold results are BYTE-IDENTICAL — the arms below the guard are untouched", () => {
  assert.deepEqual(applied({ fill: "#123456" }, { fill: "#ff0000" }), { fill: "#ff0000" });
  assert.deepEqual(applied({ fill: "#123456" }, { fill: { type: "material", material: { id: "crt" } } }),
    { fill: { type: "material", material: { id: "crt" } } });
  assert.deepEqual(applied({ stops: [{ offset: 0 }, { offset: 1 }] }, { stops: { 1: { offset: 0.8 } } }),
    { stops: [{ offset: 0 }, { offset: 0.8 }] });
  assert.deepEqual(applied({ o: { x: 1, y: 2 } }, { o: { x: 5 } }), { o: { x: 5, y: 2 } });
  assert.deepEqual(applied({ shadow: { color: "#000", blur: 4 } }, { shadow: { blur: 9 } }),
    { shadow: { color: "#000", blur: 9 } });
  assert.deepEqual(applied({ fill: "#123456" }, { fill: null }), {});
});

test("lerpedColorComponents is exact at both endpoints", () => {
  assert.deepEqual(lerpedColorComponents("#123456", { r: 255 }, 0), { r: 18 });
  assert.deepEqual(lerpedColorComponents("#123456", { r: 255 }, 1), { r: 255 });
  // an unreadable base cannot be lerped FROM, so the target stands and the
  // caller's refusal path reports it rather than this silently inventing a start
  assert.deepEqual(lerpedColorComponents("nope", { r: 255 }, 0.5), { r: 255 });
});

// ── THE WHOLE CHAIN, THROUGH THE REAL DOCUMENT API ──────────────────────────

test("END TO END: the diamond's own path keyframes a channel that tweens in the fold", () => {
  // THIS IS THE TEST THAT PROVES THE PIECES MEET. Everything above checks one
  // half: the generator makes rows, the seam folds wrappers. The risk they do
  // not compose is real and specific — sectionKeyPaths SPLITS a dotted key into
  // segments, so the diamond writes ["fill","color","r"], and the delta that
  // lands is therefore `{fill: {color: {r}}}`. If the guard had been written
  // against a literal "fill.color.r" key it would pass every unit test above and
  // never fire in the app. So this drives the REAL path through the REAL
  // keyframed()/foldState() rather than a hand-built delta.
  const node = colorCompoundRow(FILL_ROW);
  const [rPath] = sectionKeyPaths([node.children[0]], () => ["w1"], (r) => r.key);
  assert.deepEqual(rPath, ["items", "w1", "fill", "color", "r"]);

  let doc = {
    meta: {},
    slides: [
      { id: "s0", name: "A", transition: { type: "none", seconds: 0 },
        delta: { items: { w1: { type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#123456" } } } },
      { id: "s1", name: "B", transition: { type: "fade", seconds: 1 }, delta: {} },
    ],
  };
  doc = keyframed(doc, 1, rPath, 255);
  // The delta the app really stores is the wrapper the guard recognizes.
  assert.deepEqual(doc.slides[1].delta, { items: { w1: { fill: { color: { r: 255 } } } } });
  assert.equal(componentDeltaIsColor(doc.slides[1].delta.items.w1.fill), true);

  assert.equal(foldState(doc, 1, 0).items.w1.fill, "#123456");
  assert.equal(foldState(doc, 1, 0.5).items.w1.fill, "#893456");
  assert.equal(foldState(doc, 1, 1).items.w1.fill, "#ff3456");
  // slide 0 is untouched — a later channel keyframe does not reach backwards
  assert.equal(foldState(doc, 0, 1).items.w1.fill, "#123456");
});

// ── THE vec2 CONTROL AND ITS VAR KIND ───────────────────────────────────────

test("vec2 is a REAL row kind, classified for joint editing WITH a reason", () => {
  assert.ok(ROW_KINDS.includes(VEC2_ROW_KIND));
  // The multiselect guard demands every kind be classified exactly once; this
  // pins WHICH side it landed on, because the reason is the interesting part —
  // an absolute pair is shareable across N items, an item-relative value is not.
  assert.ok(JOINT_EDITABLE_KINDS.includes(VEC2_ROW_KIND));
  assert.ok(!(VEC2_ROW_KIND in JOINT_UNEDITABLE_KINDS));
});

test("the vec2 VAR KIND ships with a control, and its zero is a PLAIN tuple", () => {
  assert.ok(VAR_KINDS.includes("vec2"));
  assert.deepEqual(VAR_KIND_ZEROS.vec2, [0, 0]);
  assert.ok(isVec2Value(VAR_KIND_ZEROS.vec2));
  // The `__vec` tag is a runtime wrapper the evaluator adds on READ; a stored
  // zero carrying one would write it into every new variable's first keyframe.
  assert.equal(JSON.stringify(VAR_KIND_ZEROS.vec2), "[0,0]");
});

test("isVec2Value accepts only a plain two-number tuple", () => {
  assert.equal(isVec2Value([10, 20]), true);
  assert.equal(isVec2Value("= origin"), false, "an equation is a legal SLOT value but not a vec2 VALUE");
  assert.equal(isVec2Value([10, 20, 30]), false);
  assert.equal(isVec2Value([10]), false);
  assert.equal(isVec2Value(null), false);
  assert.equal(isVec2Value({ x: 1, y: 2 }), false);
});

console.log(`\nvecui_test: ${passed} passed`);
