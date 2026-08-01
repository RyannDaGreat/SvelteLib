/**
 * LABELED CIRCLE node test — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/labeled_circle_test.js
 *
 * The widget reproduces refs/Figures/labeled_circle/labeled_circle.py, so what is
 * pinned is the translation of that function's parameters: the disc fills the box,
 * the label centres in the same box, and the reference's NEGATIVE `rim_width` is
 * spelled as PowerRP's existing `strokeOffset: -1` rather than as a second, signed
 * width. An empty label emits no text op at all.
 */

import assert from "node:assert/strict";
import { labeledCirclePlugin, DEFAULT_LABEL_SIZE, REFERENCE } from "../plugins/labeled_circle.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 }; // identity; effects-off emit ignores it
/** The state emit() actually sees: the equation default for `size` has already been
 *  resolved to a number by the derive/evaluate pass. */
const RESOLVED = { ...labeledCirclePlugin.defaults, size: REFERENCE.diameter * REFERENCE.fontSizeFraction };

test("the disc fills the box and the label centres in the SAME box", () => {
  const [disc, label] = labeledCirclePlugin.emit(RESOLVED, null, WORLD);
  assert.equal(disc.op, "ellipse");
  assert.equal(disc.cx, REFERENCE.diameter / 2);
  assert.equal(disc.rx, REFERENCE.diameter / 2);
  assert.equal(disc.ry, REFERENCE.diameter / 2);
  assert.equal(label.op, "text");
  assert.equal(label.text, REFERENCE.text);
  // The box IS the disc, so a box-centred label is a disc-centred one — no glyph
  // measuring in emit(), which could not happen there anyway (emit is DOM-free).
  assert.deepEqual(label.boxStyle, { align: "center", valign: "middle" });
  assert.equal(label.boxW, REFERENCE.diameter);
  assert.equal(label.boxH, REFERENCE.diameter);
  assert.equal(label.x, 0);
  assert.equal(label.y, 0);
});

test("the reference's NEGATIVE rim_width is strokeOffset -1, not a signed width", () => {
  assert.equal(labeledCirclePlugin.defaults.strokeWidth, REFERENCE.rimWidth, "a MAGNITUDE, never negative");
  assert.ok(labeledCirclePlugin.defaults.strokeWidth > 0);
  assert.equal(labeledCirclePlugin.defaults.strokeOffset, -1, "-1 = the rim drawn entirely INSIDE the disc");
  // The row must be OFFERED, or the knob the widget's whole rim story depends on is
  // unreachable from the Inspector (plugins/circle.js's omission, not repeated here).
  assert.ok(labeledCirclePlugin.inspector.some((r) => r.key === "strokeOffset"));
  const [disc] = labeledCirclePlugin.emit(RESOLVED, null, WORLD);
  assert.equal(disc.strokeOffset, -1, "and it must reach the op — ports.js stamps it from there");
  assert.equal(disc.strokeWidth, REFERENCE.rimWidth);
});

test("the label size DEFAULT is the reference's diameter*.65, as a LITERAL", () => {
  assert.equal(labeledCirclePlugin.defaults.size, DEFAULT_LABEL_SIZE);
  assert.equal(DEFAULT_LABEL_SIZE, REFERENCE.diameter * REFERENCE.fontSizeFraction);
  // A LITERAL, not a computed default, and both halves of that matter — see
  // DEFAULT_LABEL_SIZE's docblock. A number cannot go negative when the disc is
  // flipped (tests/negative_size_test.js), and it cannot fall foul of the rule that a
  // computed default must BEGIN with "self." (tests/computed_default_test.js).
  assert.equal(typeof labeledCirclePlugin.defaults.size, "number");
  assert.ok(Number.isFinite(labeledCirclePlugin.defaults.size));
  // A number typed over it still works, as does an equation the user writes.
  const [, label] = labeledCirclePlugin.emit({ ...RESOLVED, size: 40 }, null, WORLD);
  assert.equal(label.size, 40);
});

test("an EMPTY label emits no text op — the disc alone is a legitimate widget", () => {
  assert.equal(labeledCirclePlugin.emit({ ...RESOLVED, text: "" }, null, WORLD).length, 1);
  assert.equal(labeledCirclePlugin.emit({ ...RESOLVED, text: undefined }, null, WORLD).length, 1);
  assert.equal(labeledCirclePlugin.emit(RESOLVED, null, WORLD).length, 2);
});

test("a strokeWidth of 0 draws NO rim at all (the shared stroked-shape idiom)", () => {
  const [disc] = labeledCirclePlugin.emit({ ...RESOLVED, strokeWidth: 0 }, null, WORLD);
  assert.equal(disc.stroke, null);
});

test("the disc's silhouette is the hit target, not its bounding box", () => {
  const s = { w: 100, h: 100 };
  assert.equal(labeledCirclePlugin.hitTest(s, 50, 50), true, "the centre is on the disc");
  assert.equal(labeledCirclePlugin.hitTest(s, 2, 2), false, "the box's corner is not");
});

test("`text` is spelled the way plaintext spells it, so a retype carries the string", () => {
  const row = labeledCirclePlugin.inspector.find((r) => r.key === "text");
  assert.equal(row.kind, "text");
  // The disc's own colour is `fill`; the LABEL's ink needs its own key, and
  // `labelColor` is the spelling plugins/graph_tick_marks.js already uses.
  assert.ok(labeledCirclePlugin.inspector.some((r) => r.key === "labelColor" && r.kind === "color"));
  assert.ok(labeledCirclePlugin.inspector.some((r) => r.key === "fill"));
});

console.log(`\n${passed} tests passed`);
