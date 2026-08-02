/**
 * CONTENT INTRINSIC SIZE, readable from equations without breaking determinism.
 *
 * User, 2026-08-01: content intrinsic size must be readable FROM EQUATIONS
 * (PDF / image / video), plus a "bind aspect ratio to content" option.
 *
 * The interesting assertions here are the NEGATIVE ones — that an unmeasured
 * item exposes nothing rather than a plausible wrong number, and that the
 * evaluator stays pure and memoized. A feature that made `evaluateState` impure
 * would break the app's central law and nothing else in the suite would notice.
 *
 * Run: node src/demo_apps/PowerRP/tests/content_size_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { evaluateState } from "../core/expressions.js";
import { contentFacts, withContentSizes, BIND_HEIGHT_TO_CONTENT, BIND_WIDTH_TO_CONTENT } from "../core/content_size.js";

const registry = createRegistry();
registerAll(registry, createCommands());

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

/** A one-image document; `h` may be given as an equation. */
const doc = (h) => ({
  items: { img: { type: "image", x: 0, y: 0, w: 400, h, src: "logo.png", z: 0 } },
  vars: {},
});
const sizes = (w, h) => new Map([["img", { w, h }]]);

// ── THE FACTS ───────────────────────────────────────────────────────────────

test("contentFacts turns a measurement into the three numbers an author wants", () => {
  assert.deepEqual(contentFacts({ w: 1920, h: 1080 }), { width: 1920, height: 1080, aspect: 1920 / 1080 });
});

test("AN UNUSABLE MEASUREMENT IS REFUSED, never turned into a zero aspect", () => {
  for (const bad of [null, undefined, { w: 0, h: 100 }, { w: 100, h: 0 }, { w: -5, h: 5 }, { w: NaN, h: 1 }])
    assert.equal(contentFacts(bad), null, `${JSON.stringify(bad)} must not produce facts`);
});

// ── INJECTION ───────────────────────────────────────────────────────────────

test("a measured item gains `content`; an unmeasured one gains NOTHING", () => {
  const withIt = withContentSizes(doc(200), sizes(200, 100));
  assert.deepEqual(withIt.items.img.content, { width: 200, height: 100, aspect: 2 });
  assert.equal(withContentSizes(doc(200), new Map()).items.img.content, undefined,
    "no measurement means no `content` — not an empty one, which would read undefined and go NaN downstream");
});

test("AN EMPTY TABLE RETURNS THE INPUT BY IDENTITY, so the evaluator's memo is unaffected", () => {
  const d = doc(200);
  assert.equal(withContentSizes(d, null), d);
  assert.equal(withContentSizes(d, new Map()), d);
});

test("injection does not touch the stored state it was given", () => {
  const d = doc(200);
  withContentSizes(d, sizes(200, 100));
  assert.equal(d.items.img.content, undefined, "the caller's object is not mutated");
});

// ── THE WHOLE POINT: AN EQUATION CAN READ IT ────────────────────────────────

test("THE FEATURE: `= abs(self.w) / self.content.aspect` evaluates to a content-shaped height", () => {
  const out = evaluateState(doc(BIND_HEIGHT_TO_CONTENT), registry, "", sizes(1600, 900));
  // 400 wide at 16:9 → 225 tall.
  assert.equal(out.state.items.img.h, 225);
  assert.equal(out.errors.size, 0, "and it is not an equation error");
});

test("A FLIPPED WIDGET STAYS A MIRROR — the sign does not cross from w into h", () => {
  // NEGATIVE EXTENTS (core/registry.js): a stored w may be negative, and that IS
  // the flip. `self.w` reads it SIGNED, so the binding's first form propagated the
  // sign and a horizontal flip silently flipped the widget VERTICALLY as well —
  // a mirror quietly became a 180-degree rotation. Measured: w = -120 gave h = -60.
  const flipped = { items: { img: { type: "image", x: 0, y: 0, w: -400, h: BIND_HEIGHT_TO_CONTENT, src: "a.png", z: 0 } }, vars: {} };
  const out = evaluateState(flipped, registry, "", sizes(1600, 900));
  assert.equal(out.state.items.img.h, 225, "height is the MAGNITUDE's shape, not the sign's");
  assert.equal(out.state.items.img.w, -400, "and the horizontal flip itself is untouched");
  assert.equal(out.errors.size, 0);

  // The mirror image of the rule, so neither direction can regress alone.
  const flippedV = { items: { img: { type: "image", x: 0, y: 0, w: BIND_WIDTH_TO_CONTENT, h: -300, src: "a.png", z: 0 } }, vars: {} };
  const outV = evaluateState(flippedV, registry, "", sizes(1600, 900));
  assert.equal(outV.state.items.img.w, 300 * (1600 / 900), "a vertical flip does not flip horizontally");
});

test("the OTHER direction works too", () => {
  const d = { items: { img: { type: "image", x: 0, y: 0, w: BIND_WIDTH_TO_CONTENT, h: 300, src: "a.png", z: 0 } }, vars: {} };
  assert.equal(evaluateState(d, registry, "", sizes(1600, 900)).state.items.img.w, 300 * (1600 / 900));
});

test("IT KEEPS TRACKING: a new width re-derives the height, which is why it is an EQUATION", () => {
  const wide = { items: { img: { ...doc(BIND_HEIGHT_TO_CONTENT).items.img, w: 800 } }, vars: {} };
  assert.equal(evaluateState(wide, registry, "", sizes(1600, 900)).state.items.img.h, 450);
});

test("A DIFFERENT CONTENT SHAPE gives a different height from the SAME document", () => {
  const d = doc(BIND_HEIGHT_TO_CONTENT);
  assert.equal(evaluateState(d, registry, "", sizes(1600, 900)).state.items.img.h, 225, "16:9");
  assert.equal(evaluateState(d, registry, "", sizes(1000, 1000)).state.items.img.h, 400, "square");
});

test("UNMEASURED FAILS LOUDLY — it does not silently fall back to the current size", () => {
  // Falling back to the widget's own h would return exactly the number the author
  // was trying to derive, so the box would LOOK right and never track anything.
  const out = evaluateState(doc(BIND_HEIGHT_TO_CONTENT), registry, "");
  assert.ok(out.errors.size > 0, "the equation reports an error rather than a plausible number");
  const msg = [...out.errors.values()][0];
  assert.match(String(msg), /content/, `the message names the missing thing — got "${msg}"`);
});

// ── DETERMINISM: THE LAW THIS FEATURE COULD HAVE BROKEN ─────────────────────

test("PURE IN ITS INPUTS: same document + same table ⇒ identical output, repeatedly", () => {
  const d = doc(BIND_HEIGHT_TO_CONTENT);
  const t = sizes(1600, 900);
  const a = evaluateState(d, registry, "", t);
  const b = evaluateState(d, registry, "", t);
  assert.equal(a, b, "memoized — the same result object, so drag latency is unchanged");
  assert.equal(JSON.stringify(a.state.items), JSON.stringify(evaluateState(d, registry, "", sizes(1600, 900)).state.items),
    "and an equal table gives an equal answer");
});

test("THE TABLE IS IN THE MEMO KEY — a measurement arriving LATE is not served a stale answer", () => {
  // The bug this prevents: first evaluation happens before the decode, caches the
  // error, and the box then never starts tracking however long you wait.
  const d = doc(BIND_HEIGHT_TO_CONTENT);
  const before = evaluateState(d, registry, "");
  assert.ok(before.errors.size > 0, "unmeasured: an error");
  const after = evaluateState(d, registry, "", sizes(1600, 900));
  assert.equal(after.state.items.img.h, 225, "measured: the real height, NOT the cached error");
});

test("A DOCUMENT WITH NO CONTENT SIZES EVALUATES EXACTLY AS BEFORE", () => {
  // The feature must be invisible to every widget that has no measurable content.
  const plain = { items: { r: { type: "rect", x: 0, y: 0, w: 10, h: 20, z: 0 } }, vars: {} };
  const a = evaluateState(plain, registry, "");
  const b = evaluateState(plain, registry, "", null);
  assert.equal(a, b, "null table takes the identical memoized path");
});

console.log(`\n${passed} content-size tests passed`);
