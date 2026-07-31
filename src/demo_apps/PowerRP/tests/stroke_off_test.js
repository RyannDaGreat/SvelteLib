/**
 * STROKE MATERIAL OFF: NOTHING AT ANY WIDTH, and the width/trim rows HIDE
 * while it is off — bare-node guards.
 * Run: node src/demo_apps/PowerRP/tests/stroke_off_test.js
 *
 * ── RULING 1 — THE BUG ────────────────────────────────────────────────────────
 * User (verbatim intent): "When stroke material is off, you should have
 * nothing — even if stroke width is non-zero. But instead I see a boundary
 * around the iconify icon when stroke is off and the width is not zero."
 *
 * MECHANISM. render_gpu/decorate.js's isUndecorated computed
 * `hasBorder = strokeWidth > 0 && stroke != null`. Every `paint: true` row
 * (stroke included) can be set to the tagged OFF paint {type:"none"}
 * (render_gpu/ir.js PAINT_NONE_TYPE/isPaintOff) — and that tag IS a non-null
 * object, so `stroke != null` was TRUE for an explicitly-off stroke. A nonzero
 * strokeWidth then kept `hasBorder` true and decorateStrokedBox kept emitting
 * the cropSubtree border ring, exactly the reported bug. The fix
 * (strokeIsVisible, mirroring fillIsVisible for the fill slot) treats the OFF
 * tag as invisible, same as fillIsVisible already does for fill's OFF tag.
 *
 * ── RULING 2 — THE ROW-VISIBILITY ASPECT ─────────────────────────────────────
 * User (verbatim intent): "I still have stroke width options even when stroke
 * material is off, which is kind of dumb." core/properties.js's new
 * `visibleWhen(state)` row aspect (read by web/Inspector.svelte's groupRows) —
 * strokeWidth/strokeOffset/strokeStart/strokeEnd/strokePhase/strokeCapStart/
 * strokeCapEnd all declare `visibleWhen: strokeMaterialIsOn`, so the whole
 * stroke-only knob set disappears the moment `stroke` is set Off. `stroke`
 * itself and `cornerRadius` do NOT hide — stroke is the control that turns
 * itself back on, and cornerRadius shapes fill/clip too, not just the border.
 *
 * This suite pins the CORE logic (decorate.js + properties.js) plus the widget
 * wiring (svg/iconify/rect/image/video all funnel through decorateStrokedBox,
 * so the fix reaches every stroked-box widget at once, not just the two named
 * in the bug report).
 */
import assert from "assert";
import { isUndecorated, strokeIsVisible, decorateStrokedBox } from "../render_gpu/decorate.js";
import { PROPS, strokeMaterialIsOn, BUNDLES } from "../core/properties.js";
import { svgPlugin } from "../plugins/svg.js";
import { iconifyPlugin } from "../plugins/iconify.js";
import { rectPlugin } from "../plugins/rect.js";
import { imagePlugin } from "../plugins/image.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const OFF = { type: "none" };
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

// ── (1) strokeIsVisible / isUndecorated ──────────────────────────────────────

test("strokeIsVisible: null/undefined (unauthored) is NOT visible, matching the pre-OFF behaviour", () => {
  assert.equal(strokeIsVisible(null), false);
  assert.equal(strokeIsVisible(undefined), false);
});

test("strokeIsVisible: the OFF tag is NOT visible — THE BUG'S EXACT SHAPE", () => {
  assert.equal(strokeIsVisible(OFF), false, "{type:'none'} must read as no stroke");
  assert.equal(strokeIsVisible({ type: "none", solid: "#ff0000" }), false, "multi-sub-state OFF stays off");
});

test("strokeIsVisible: an ordinary color/gradient/material paint IS visible", () => {
  assert.equal(strokeIsVisible("#000000"), true);
  assert.equal(strokeIsVisible({ type: "linearGradient", stops: [] }), true);
  assert.equal(strokeIsVisible({ type: "material", material: { id: "comic" } }), true);
});

test("REGRESSION: isUndecorated({strokeWidth: N, stroke: OFF}) is true for EVERY width — the pinned bug", () => {
  for (const w of [0, 1, 5, 100, 0.001])
    assert.equal(isUndecorated({ strokeWidth: w, stroke: OFF }), true, `width ${w}: OFF must mean undecorated`);
  // The control: the SAME widths with a live color are NOT undecorated (so the
  // fix did not just always return true).
  for (const w of [1, 5, 100])
    assert.equal(isUndecorated({ strokeWidth: w, stroke: "#000000" }), false, `width ${w}: a live stroke still decorates`);
});

test("isUndecorated: a rounded/filled box with OFF stroke still decorates (for the rounding/fill), but drops the border", () => {
  const style = { strokeWidth: 5, stroke: OFF, cornerRadius: 8 };
  assert.equal(isUndecorated(style), false, "cornerRadius alone still needs the crop path");
  const ops = decorateStrokedBox([{ op: "image" }], { ...style, w: 10, h: 10 }, IDENTITY_WORLD);
  assert.equal(ops[0].op, "cropSubtree");
  assert.equal(ops[0].stroke, null, "the OFF tag itself must never reach the op as `stroke` — null, not {type:'none'}");
  assert.equal(ops[0].cornerRadius, 8, "the rounding is untouched");
});

test("decorateStrokedBox: OFF stroke + nonzero width + no rounding/fill is a pure pass-through (no cropSubtree at all)", () => {
  const content = [{ op: "image" }];
  const ops = decorateStrokedBox(content, { w: 10, h: 10, stroke: OFF, strokeWidth: 5 }, IDENTITY_WORLD);
  assert.equal(ops, content, "byte-identical pass-through, same array reference");
});

// ── (2) THE svg/iconify WIDGETS actually go through the fixed check ─────────

test("svg widget emit: OFF stroke + width 5 renders IDENTICAL to OFF stroke + width 0", () => {
  const base = { ...svgPlugin.defaults, x: 0, y: 0, w: 64, h: 64, stroke: OFF };
  const width0 = svgPlugin.emit({ ...base, strokeWidth: 0 }, null, IDENTITY_WORLD);
  const width5 = svgPlugin.emit({ ...base, strokeWidth: 5 }, null, IDENTITY_WORLD);
  assert.deepEqual(width5, width0, "the reported bug, on the actual widget: width must not matter once stroke is Off");
});

test("iconify widget emit: OFF stroke + width 5 renders IDENTICAL to OFF stroke + width 0", () => {
  // Bare node cannot fetch the Iconify API, so both draw the same error
  // affordance — which is exactly the point: the BORDER around it must agree.
  const base = { ...iconifyPlugin.defaults, x: 0, y: 0, w: 64, h: 64, stroke: OFF };
  const width0 = iconifyPlugin.emit({ ...base, strokeWidth: 0 }, null, IDENTITY_WORLD);
  const width5 = iconifyPlugin.emit({ ...base, strokeWidth: 5 }, null, IDENTITY_WORLD);
  assert.deepEqual(width5, width0);
});

test("rect/image widgets ALSO benefit — the fix is general, not svg/iconify-special-cased", () => {
  const rectBase = { ...rectPlugin.defaults, x: 0, y: 0, w: 40, h: 20, stroke: OFF };
  const rectOps = rectPlugin.emit({ ...rectBase, strokeWidth: 8 }, null, IDENTITY_WORLD);
  for (const op of rectOps) if ("stroke" in op) assert.equal(op.stroke, null, "rect: OFF stroke paints nothing regardless of width");

  const imgBase = { ...imagePlugin.defaults, x: 0, y: 0, w: 40, h: 20, stroke: OFF, ref: null };
  const imgOff0 = imagePlugin.emit({ ...imgBase, strokeWidth: 0 }, null, IDENTITY_WORLD);
  const imgOff8 = imagePlugin.emit({ ...imgBase, strokeWidth: 8 }, null, IDENTITY_WORLD);
  assert.deepEqual(imgOff8, imgOff0, "image: same OFF-at-any-width identity");
});

// ── (3) THE ROW-VISIBILITY ASPECT ────────────────────────────────────────────

test("strokeMaterialIsOn: the visibleWhen predicate the stroke-only rows share", () => {
  assert.equal(strokeMaterialIsOn({ stroke: "#000000" }), true);
  assert.equal(strokeMaterialIsOn({ stroke: OFF }), false);
  assert.equal(strokeMaterialIsOn({}), true, "absent stroke (pre-row document) must not hide the rows by default");
  assert.equal(strokeMaterialIsOn({ stroke: null }), true, "an unauthored/null stroke is not the same as OFF");
});

test("every stroke-ONLY row declares visibleWhen: strokeMaterialIsOn — stroke and cornerRadius do NOT", () => {
  const strokeOnlyKeys = ["strokeWidth", "strokeOffset", "strokeStart", "strokeEnd", "strokePhase", "strokeCapStart", "strokeCapEnd"];
  for (const key of strokeOnlyKeys)
    assert.equal(PROPS[key].visibleWhen, strokeMaterialIsOn, `${key}: must hide with the material`);
  assert.equal(PROPS.stroke.visibleWhen, undefined, "the stroke row itself must stay visible — it is what turns itself back on");
  assert.equal(PROPS.cornerRadius.visibleWhen, undefined, "cornerRadius shapes fill/clip too, not stroke-only");
});

test("BUNDLES.strokedBorder / strokedBox still carry exactly the same KEYS as before — visibleWhen is a per-row flag, not a bundle-shape change", () => {
  assert.deepEqual(BUNDLES.strokedBorder, ["stroke", "strokeWidth", "strokeOffset", "cornerRadius", "strokeStart", "strokeEnd", "strokePhase", "strokeCapStart", "strokeCapEnd"]);
  assert.deepEqual(BUNDLES.strokedBox, ["fill", "stroke", "strokeWidth", "strokeOffset", "cornerRadius", "strokeStart", "strokeEnd", "strokePhase", "strokeCapStart", "strokeCapEnd"]);
});

/** The Inspector's groupRows filter, reproduced verbatim (bare node cannot
 * import a .svelte file) — pins the CONTRACT groupRows(rows, state) must
 * satisfy, independent of the Svelte compiler. web/Inspector.svelte's own copy
 * is what the browser actually runs; this is the row-visibility probe's
 * companion assertion for the part reachable from bare node. */
function groupRowsFilter(rows, state) {
  return rows.filter((row) => !(state && typeof row.visibleWhen === "function" && !row.visibleWhen(state)));
}

test("row-visibility CONTRACT: the width row is ABSENT while Off, PRESENT once a material is chosen", () => {
  const rows = [PROPS.stroke, { ...PROPS.strokeWidth, key: "strokeWidth" }, { ...PROPS.cornerRadius, key: "cornerRadius" }];
  const whileOff = groupRowsFilter(rows, { stroke: OFF });
  assert.deepEqual(whileOff.map((r) => r.key ?? "stroke"), ["stroke", "cornerRadius"], "strokeWidth is dropped entirely, not just disabled");
  const whileOn = groupRowsFilter(rows, { stroke: "#7aa2f7" });
  assert.equal(whileOn.length, 3, "picking a material brings every stroke-only row back");
});

console.log(`\n${passed} stroke-off + row-visibility tests passed.`);
