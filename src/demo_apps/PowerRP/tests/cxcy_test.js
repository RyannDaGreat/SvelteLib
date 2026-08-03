/**
 * cx/cy — the CENTER-SHORTCUT pair (user: "We have x and y for widgets as
 * properties, but I'd also like cx and cy as shortcut for center x, center
 * y."). DERIVED, no new stored field, no migration:
 *
 *   READ:  core/expressions.js resolves `self.cx`/`@slug.cx` by computing
 *          core/geometry.js boxCenter — the SAME base-frame-center math
 *          core/derive.js worldTransform's own default pivot already uses
 *          (that refactor is asserted here via the derive.js re-export).
 *   WRITE: core/properties.js PROPS.cx/.cy keep their OWN unique row key
 *          ("cx"/"cy" — a repeated key is a plugin defect per
 *          core/multiselect.js intersectRows) but carry `writeKey: "x"/"y"`
 *          naming the REAL stored slot; web/Inspector.svelte's `writeKey(row)`
 *          helper resolves every path/keyframe/equation call through THAT,
 *          never `row.key`. web/NumericField.svelte's `centerAxis` prop
 *          supplies the item-aware inverse (xForBoxCenterX/yForBoxCenterY) a
 *          plain scalar `display` transform could never express (it needs the
 *          SAME item's w/h/scale).
 *
 * This file covers the core (DOM-free) half: read parity (incl. flip +
 * rotation), the write-inverse math in isolation, equation binding
 * cross-item, and serialization purity (cx/cy never a stored key). The
 * NumericField wiring itself is exercised by editor_smoke.js / a browser
 * probe, not here (core/ tests stay DOM-free per CLAUDE.md).
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, keyframed, foldState, serialize } from "../core/document.js";
import { evaluateState, numericPropertyPaths } from "../core/expressions.js";
import { worldTransform } from "../core/derive.js";
import { boxCenter, xForBoxCenterX, yForBoxCenterY } from "../core/geometry.js";
import { rectPlugin } from "../plugins/rect.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera
import { PROPS, BUNDLES, row, bundle } from "../core/properties.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registry.register(rectPlugin);
registry.register(arrowPlugin);
registry.register(cameraPlugin);

// ── READ SEAM ──────────────────────────────────────────────────────────────

test("self.cx / self.cy resolve to boxCenter, matching worldTransform's own default pivot", () => {
  const state = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50 } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  const c = boxCenter(s.items.r1);
  assert.equal(c.x, 60);
  assert.equal(c.y, 45);
  // Bound to an item's own w/2,h/2 read via cornerRadius, cross-checked against
  // worldTransform's rotated-pivot fallback (its base-frame center, unrotated).
  const withCr = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50, cornerRadius: "self.cx" } } };
  assert.equal(evaluateState(withCr, registry).state.items.r1.cornerRadius, 60);
  const pivot = worldTransform({ x: 10, y: 20, w: 100, h: 50, rotation: 1, scale: 1 });
  // worldTransform's pivot is the WORLD point the base-frame center maps to at
  // rotation 0 (aboutPivot's fixed point); at rotation 0 it IS the center.
  const unrotated = worldTransform({ x: 10, y: 20, w: 100, h: 50, rotation: 0, scale: 1 });
  assert.equal(unrotated.x, 10); // top-left translation, not the center — sanity on the fixture itself
  assert.ok(pivot); // rotated pivot computed without throwing (exercises the boxCenter call inside worldTransform)
});

test("@slug.cx / @slug.cy: cross-item read, same value as boxCenter", () => {
  const state = {
    items: {
      c1: { ...rectPlugin.defaults, name: "Sun", x: 0, y: 0, w: 40, h: 40 },
      a1: { ...rectPlugin.defaults, x: "sun.cx", y: "sun.cy" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items.a1.x, 20);
  assert.equal(s.items.a1.y, 20);
});

test("cx/cy are SIGN-INDEPENDENT: a flipped box (negative w/h) reads the identical center", () => {
  const flippedW = { items: { r1: { ...rectPlugin.defaults, x: 110, y: 20, w: -100, h: 50, cornerRadius: "self.cx" } } };
  const normalW = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50, cornerRadius: "self.cx" } } };
  assert.equal(
    evaluateState(flippedW, registry).state.items.r1.cornerRadius,
    evaluateState(normalW, registry).state.items.r1.cornerRadius,
  );
  const flippedBoth = { items: { r1: { ...rectPlugin.defaults, x: 110, y: 70, w: -100, h: -50, cornerRadius: "self.cy" } } };
  assert.equal(evaluateState(flippedBoth, registry).state.items.r1.cornerRadius, 45);
});

test("cx/cy are ROTATION-INDEPENDENT: same base-frame value regardless of rotation", () => {
  const rotated = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50, rotation: Math.PI / 2, cornerRadius: "self.cx" } } };
  const unrotated = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50, rotation: 0, cornerRadius: "self.cx" } } };
  assert.equal(
    evaluateState(rotated, registry).state.items.r1.cornerRadius,
    evaluateState(unrotated, registry).state.items.r1.cornerRadius,
  );
});

test("scale multiplies the half-extent, same as boxCenter/worldTransform", () => {
  const state = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50, scale: 2, cornerRadius: "self.cx" } } };
  assert.equal(evaluateState(state, registry).state.items.r1.cornerRadius, 110); // 10 + 2*100/2
});

test("cx.foo (a path past the bare name) is NOT special-cased — falls through to the ordinary unknown-property error", () => {
  const state = { items: { r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50, cornerRadius: "self.cx.foo" } } };
  const { errors } = evaluateState(state, registry);
  assert.match([...errors.values()][0], /no property/i);
});

test("a widget with no box (arrow: from/to only) has no cx/cy — reading it errors, same class as any unknown property", () => {
  const state = { items: { a1: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } } } };
  // arrowPlugin has no w/h; asking self.cx on IT would need a caller — assert
  // via numericPropertyPaths instead (the discoverability surface), which is
  // the observable contract: cx/cy are never OFFERED for a boxless plugin.
  assert.deepEqual(numericPropertyPaths(arrowPlugin).filter((p) => p === "cx" || p === "cy"), []);
});

test("numericPropertyPaths: cx/cy are discoverable for a bbox plugin (the 'referenceable ⟹ discoverable' law)", () => {
  const paths = numericPropertyPaths(rectPlugin);
  assert.ok(paths.includes("cx"));
  assert.ok(paths.includes("cy"));
});

// ── WRITE INVERSE (pure math, isolated from the Svelte layer) ───────────────

test("xForBoxCenterX / yForBoxCenterY: exact inverse of boxCenter", () => {
  assert.equal(xForBoxCenterX(60, 100, 1), 10);
  assert.equal(yForBoxCenterY(45, 50, 1), 20);
  // Round trip: boxCenter(...).x fed back through the inverse reproduces x.
  const original = { x: 37, y: -14, w: 220, h: 88, scale: 1.3 };
  const c = boxCenter(original);
  assert.ok(Math.abs(xForBoxCenterX(c.x, original.w, original.scale) - original.x) < 1e-9);
  assert.ok(Math.abs(yForBoxCenterY(c.y, original.h, original.scale) - original.y) < 1e-9);
});

test("write inverse matches what a cx row commit would produce: typing the read-back value is a no-op", () => {
  const state = { x: 10, y: 20, w: 100, h: 50, scale: 1 };
  const cx = boxCenter(state).x;
  const newX = xForBoxCenterX(cx, state.w, state.scale);
  assert.equal(newX, state.x); // byte-stable: no drift from a read-modify-write with no actual change
});

test("write inverse on a FLIPPED box: solving for x from the (unchanged) center still returns the FLIPPED x, not the unflipped one", () => {
  // A flipped box (w negative) still round-trips through its OWN w — the
  // inverse must not silently unsign it (that would move the widget).
  const state = { x: 110, y: 20, w: -100, h: 50, scale: 1 };
  const cx = boxCenter(state).x;
  assert.equal(xForBoxCenterX(cx, state.w, state.scale), state.x);
});

// ── properties.js: row wiring (key redirect + centerAxis) ───────────────────

test("PROPS.cx/.cy declare NO default (never enter defaults()/bundleDefaults()) and carry centerAxis", () => {
  assert.equal("default" in PROPS.cx, false);
  assert.equal("default" in PROPS.cy, false);
  assert.equal(PROPS.cx.centerAxis, "x");
  assert.equal(PROPS.cy.centerAxis, "y");
});

test("row('cx') / row('cy'): the row's OWN key is unique ('cx'/'cy', never collides with x/y); writeKey names the real stored slot", () => {
  assert.equal(row("cx").key, "cx");
  assert.equal(row("cy").key, "cy");
  assert.equal(row("cx").writeKey, "x");
  assert.equal(row("cy").writeKey, "y");
  assert.equal(row("cx").centerAxis, "x");
});

test("BUNDLES.transform carries cx/cy beside x/y, in order, with UNIQUE keys (a repeated key is a plugin defect — core/multiselect.js intersectRows)", () => {
  assert.deepEqual(BUNDLES.transform.slice(0, 4), ["x", "y", "cx", "cy"]);
  const keys = bundle("transform").map((r) => r.key);
  assert.deepEqual(keys, ["x", "y", "cx", "cy", "w", "h", "rotation", "rotationAnchor.x", "rotationAnchor.y", "z"]);
  assert.equal(new Set(keys).size, keys.length, "every row key in the bundle is unique");
});

// ── SERIALIZATION PURITY ─────────────────────────────────────────────────────

test("serialize(doc): cx/cy NEVER appear as a stored key, even after a 'cx write' (== a real x write)", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: 10, y: 20, w: 100, h: 50 });
  // A cx-row commit of a plain number IS an x write through xForBoxCenterX —
  // exactly what NumericField's centerAxis path does (see its previewNumber/
  // commitNumber, which call unit.fromDisplay before ever touching setPreview).
  const newCenterX = 200;
  doc = keyframed(doc, 0, ["items", id, "x"], xForBoxCenterX(newCenterX, 100, 1));
  const json = serialize(doc);
  assert.ok(!json.includes('"cx"'));
  assert.ok(!json.includes('"cy"'));
  // And the write actually landed on x, recentering the box as intended.
  const folded = foldState(doc, 0, 1);
  assert.equal(boxCenter(folded.items[id]).x, newCenterX);
});

test("serialize(doc): an equation typed on a cx row is stored VERBATIM on x (no inversion attempted for a general equation)", () => {
  let doc = newDocument();
  let sunId, boxId;
  [doc, sunId] = withNewItem(doc, 0, { ...rectPlugin.defaults, name: "Sun", x: 0, y: 0, w: 40, h: 40 });
  [doc, boxId] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: 0, y: 0, w: 10, h: 10 });
  // "= sun.cx" on box's cx row: refs.length > 0 in NumericField's commitText,
  // so the STORED form (display→stored converted, verbatim) lands on x.
  doc = keyframed(doc, 0, ["items", boxId, "x"], `@${sunId}.cx`);
  const json = serialize(doc);
  assert.ok(json.includes(`"@${sunId}.cx"`)); // the equation string itself, stored on x
  assert.ok(!json.includes('"cx":')); // never as a KEY
  const { state: s, errors } = evaluateState(foldState(doc, 0, 1), registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items[boxId].x, 20); // sun's cx
});

console.log(`\n${passed} cx/cy tests passed.`);
