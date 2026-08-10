/**
 * PPTX TRANSLATOR — bare-node tests against the COMMITTED fixture
 * (tests/fixtures/pptx/minimal.pptx, the same one tests/pptx_parse_test.js
 * uses for stage 1). Run: node src/demo_apps/PowerRP/tests/pptx_translate_test.js
 *
 * This is the fixture half of the gate. tests/pptx_dev/translate_real_deck.mjs
 * (NOT part of this gate — a dev smoke script) is the other half, run by hand
 * against the real 18-slide deck in .frenzy/r10/primary.pptx.
 *
 * NUMERIC-FIRST: every geometric/color/timing assertion is a hand-computed
 * number checked exactly (or the EMU/60000 math redone inline), never just
 * "the call didn't throw" — a translator that produces plausible-looking-
 * but-wrong numbers is a worse failure than one that visibly crashes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePptx } from "../core/pptx/deck.js";
import { parseXml } from "../core/pptx/xml.js";
import { installPresetDefs } from "../core/pptx/preset_geometry.js";
import { translateDeck, resolveSlideIndices, idMinter, applyClickStep } from "../core/pptx_translate/translate.js";
import { emuBoxToPx, composeGroupChildBox, rot60kToDegrees } from "../core/pptx_translate/units.js";
import { polarShadowOffsetPx, translateOuterShadow } from "../core/pptx_translate/effects.js";
import { resolveSlideChainKeys, flattenMatchable, matchSlidePair } from "../core/pptx_translate/morph_identity.js";
import { repairedDocument } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "pptx", "minimal.pptx");
const PRESET_DEFS_PATH = join(__dirname, "..", "core", "pptx", "preset_shape_defs.json");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

installPresetDefs(JSON.parse(readFileSync(PRESET_DEFS_PATH, "utf8")).shapes);
const fixtureBytes = new Uint8Array(readFileSync(FIXTURE_PATH));
const deckIR = parsePptx(fixtureBytes);

const registry = createRegistry();
registerAll(registry, createCommands());

// ── units.js — the EMU/px/rotation/flip/group-composition math in isolation ──

test("units.js: EMU->px is a bare /9525 division, exact on the fixture's slide size", () => {
  assert.equal(deckIR.slideSizeEmu.w / 9525, 1280);
  assert.equal(deckIR.slideSizeEmu.h / 9525, 720);
});

test("units.js: rot60k->degrees", () => {
  assert.equal(rot60kToDegrees(5400000), 90);
  assert.equal(rot60kToDegrees(0), 0);
});

test("units.js: emuBoxToPx applies the negative-extents flip contract (origin shifts to the far edge, size negates)", () => {
  const flipped = emuBoxToPx({ offEmu: { x: 0, y: 0 }, extEmu: { w: 9525, h: 19050 }, flipH: true, flipV: false });
  assert.deepEqual(flipped, { x: 1, y: 0, w: -1, h: 2 });
  const unflipped = emuBoxToPx({ offEmu: { x: 457200, y: 457200 }, extEmu: { w: 2743200, h: 1371600 }, flipH: false, flipV: false });
  assert.deepEqual(unflipped, { x: 48, y: 48, w: 288, h: 144 });
});

test("units.js: composeGroupChildBox — the off/ext ÷ chOff/chExt scale (deck 1 has no groups; math verified standalone per the task spec)", () => {
  // Group placed at slide (0,0), sized 100x100px (952500 EMU); its own
  // authored child-space is 50x50 units — every child coordinate is
  // therefore doubled when placed on the slide.
  const groupXfrm = { offEmu: { x: 0, y: 0 }, extEmu: { w: 952500, h: 952500 }, chOffEmu: { x: 0, y: 0 }, chExtEmu: { w: 50, h: 50 } };
  assert.deepEqual(composeGroupChildBox({ x: 10, y: 10 }, { w: 20, h: 20 }, groupXfrm), { x: 20, y: 20, w: 40, h: 40 });
  // A non-zero group offset translates every child too.
  const offsetGroup = { offEmu: { x: 95250, y: 0 }, extEmu: { w: 952500, h: 952500 }, chOffEmu: { x: 0, y: 0 }, chExtEmu: { w: 50, h: 50 } };
  assert.equal(composeGroupChildBox({ x: 10, y: 10 }, { w: 20, h: 20 }, offsetGroup).x, 30); // 10px group offset + 20px scaled child
});

// ── translateDeck — the full fixture, top to bottom ─────────────────────────

test("translateDeck: meta.slideW/H are the exact EMU/9525 conversion", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  assert.equal(doc.meta.slideW, 1280);
  assert.equal(doc.meta.slideH, 720);
  assert.equal(doc.meta.name, "Fixture");
  assert.equal(doc.meta.script, "");
});

test("translateDeck: THE MECHANISM — 3 PPT slides (slide2 has 2 click steps) -> 5 PowerRP slides", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  assert.equal(doc.slides.length, 5);
  assert.equal(doc.slides[0].name, "Slide 1");
  assert.equal(doc.slides[1].name, "Slide 2");
  assert.equal(doc.slides[2].name, "Slide 2 · click 1");
  assert.equal(doc.slides[3].name, "Slide 2 · click 2");
  assert.equal(doc.slides[4].name, "Slide 3");
});

test("translateDeck: the ONE camera is created on slide 0, frames the slide rect", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const cam = Object.values(doc.slides[0].delta.items).find((it) => it.type === "camera");
  assert.ok(cam, "camera item must exist on slide 0");
  assert.equal(cam.x, 0);
  assert.equal(cam.y, 0);
  assert.equal(cam.w, 1280);
  assert.equal(cam.h, 720);
  // Exactly one camera across the whole document.
  const cameraCount = doc.slides.flatMap((s) => Object.values(s.delta.items ?? {})).filter((it) => it.type === "camera").length;
  assert.equal(cameraCount, 1);
});

test("translateDeck slide 1: item positions in px, hand-computed from the fixture's EMU", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const items = doc.slides[0].delta.items;
  const rect1 = Object.values(items).find((it) => it.name === "Rect 1");
  assert.deepEqual({ x: rect1.x, y: rect1.y, w: rect1.w, h: rect1.h }, { x: 48, y: 48, w: 288, h: 144 }); // 457200/9525, 2743200/9525, 1371600/9525
  const textBox = Object.values(items).find((it) => it.name === "TextBox 2");
  assert.deepEqual({ x: textBox.x, y: textBox.y, w: textBox.w, h: textBox.h }, { x: 48, y: 240, w: 576, h: 96 }); // 457200/9525, 2286000/9525, 5486400/9525, 914400/9525
  const pic = Object.values(items).find((it) => it.name === "Picture 3");
  assert.deepEqual({ x: pic.x, y: pic.y, w: pic.w, h: pic.h }, { x: 672, y: 48, w: 96, h: 96 }); // 6400800/9525, 457200/9525, 914400/9525
});

test("translateDeck: rect maps to the DIRECT rect widget with the correct fill hex and stroke width", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const rect1 = Object.values(doc.slides[0].delta.items).find((it) => it.name === "Rect 1");
  assert.equal(rect1.type, "rect");
  assert.equal(rect1.fill, "#336699");
  assert.equal(rect1.stroke, "#000000");
  assert.equal(rect1.strokeWidth, 12700 / 9525);
});

test("translateDeck: absent fill/line (a plain textbox) maps to a no-fill PAINT_NONE sentinel object, never the delta-delete null", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const textBox = Object.values(doc.slides[0].delta.items).find((it) => it.name === "TextBox 2");
  assert.deepEqual(textBox.fill, { type: "none" });
  assert.notEqual(textBox.fill, null);
});

test("translateDeck: two-run text lands as correct flat runs with the right style keys", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const textBox = Object.values(doc.slides[0].delta.items).find((it) => it.name === "TextBox 2");
  assert.equal(textBox.text.runs.length, 2);
  assert.equal(textBox.text.runs[0].text, "Bold Red Run");
  assert.equal(textBox.text.runs[0].bold, true);
  assert.equal(textBox.text.runs[0].color, "#cc0000");
  assert.equal(textBox.text.runs[0].size, 32);
  assert.equal(textBox.text.runs[1].text, " and a plain italic run");
  assert.equal(textBox.text.runs[1].italic, true);
  assert.equal(textBox.text.runs[1].size, 18);
  assert.equal(textBox.text.paras.length, 1);
});

test("translateDeck: picture maps to the image widget with the correct project-scoped asset src", () => {
  const { doc, assets } = translateDeck(deckIR, { name: "Fixture" });
  const pic = Object.values(doc.slides[0].delta.items).find((it) => it.name === "Picture 3");
  assert.equal(pic.type, "image");
  assert.equal(pic.src, "/asset/Fixture/image1.png");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, "image1.png");
  assert.ok(assets[0].bytes.length > 0);
});

test("translateDeck: unresolved theme-scheme fills (accent1/accent2, no theme table in DeckIR v1) are reported, never crash, and use a visible placeholder color", () => {
  const { doc, report } = translateDeck(deckIR, { name: "Fixture" });
  const circle = Object.values(doc.slides[1].delta.items).find((it) => it.name === "Circle 1");
  const square = Object.values(doc.slides[1].delta.items).find((it) => it.name === "Square 1");
  assert.equal(typeof circle.fill, "string");
  assert.equal(typeof square.fill, "string");
  assert.ok(report.refusals.some((r) => r.includes("accent1")));
  assert.ok(report.refusals.some((r) => r.includes("accent2")));
});

test("translateDeck: ellipse preset maps to the DIRECT circle widget", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const circle = Object.values(doc.slides[1].delta.items).find((it) => it.name === "Circle 1");
  assert.equal(circle.type, "circle");
  assert.equal(circle.w, 1500000 / 9525);
  assert.equal(circle.h, 1500000 / 9525);
});

test("translateDeck: the morph slide's matched shapes yield the SAME item id across slides, transition type tween with correct seconds", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  // Slide 1's "Circle 1"/"Square 1" appear ONLY on slide index 1 (the morph
  // pair partner is a DIFFERENT deck, or here — since the fixture's morph
  // is slide2->? — actually deck 1's morph transition is INTO slide 2 from
  // slide 1, and slide 1 has no "Circle 1"/"Square 1" shapes at all, so
  // there is no cross-slide match for THIS fixture's morph boundary (its
  // matched-identity behavior is exercised by the unmatched-shapes path
  // instead — see the next test). The transition record itself is what
  // this test pins numerically.
  assert.equal(doc.slides[1].transition.type, "tween");
  assert.equal(doc.slides[1].transition.seconds, 1.5); // 1500ms morph dur
  assert.equal(doc.slides[1].transition.curve, "smooth");
});

test("translateDeck: an item introduced fresh at a morph boundary (no name match) still gets its OWN id, distinct from slide 1's items", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const slide1CreationIds = new Set(Object.entries(doc.slides[0].delta.items).filter(([, v]) => v.type).map(([id]) => id));
  const circleId = Object.keys(doc.slides[1].delta.items).find((id) => doc.slides[1].delta.items[id].name === "Circle 1");
  const squareId = Object.keys(doc.slides[1].delta.items).find((id) => doc.slides[1].delta.items[id].name === "Square 1");
  // "Circle 1"/"Square 1" are CREATED (full state, `type` included) on
  // slide 2 — their ids are new, never one of slide 1's creation ids.
  assert.equal(slide1CreationIds.has(circleId), false);
  assert.equal(slide1CreationIds.has(squareId), false);
});

test("translateDeck: unmatched shapes at a morph boundary crossfade — the fixture's morph has ZERO name matches (slide1's Rect/TextBox/Picture vs slide2's Circle/Square), so EVERY item on both sides crossfades", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const slide1CreationIds = Object.entries(doc.slides[0].delta.items).filter(([, v]) => v.type).map(([id]) => id);
  const slide2Items = doc.slides[1].delta.items;
  // Every slide-1 item (Rect 1/TextBox 2/Picture 3, plus the camera) gets a
  // fade-out entry on slide 2's delta EXCEPT the camera (never touched by
  // morph matching — it is not a DeckIR shape at all).
  const nonCameraSlide1Ids = slide1CreationIds.filter((id) => doc.slides[0].delta.items[id].type !== "camera");
  assert.equal(nonCameraSlide1Ids.length, 3); // Rect 1, TextBox 2, Picture 3
  for (const id of nonCameraSlide1Ids) {
    assert.equal(slide2Items[id].active, false);
    assert.equal(slide2Items[id]["active~interp"], "fade");
  }
  // Circle 1/Square 1 (new on slide 2) crossfade IN — created active:false,
  // fade mode, same as an ordinary entrance-later shape.
  const circleId = Object.keys(slide2Items).find((id) => slide2Items[id].name === "Circle 1");
  const squareId = Object.keys(slide2Items).find((id) => slide2Items[id].name === "Square 1");
  assert.equal(slide2Items[circleId].active, false);
  assert.equal(slide2Items[circleId]["active~interp"], "fade");
  assert.equal(slide2Items[squareId].active, false);
  assert.equal(slide2Items[squareId]["active~interp"], "fade");
});

test("resolveSlideChainKeys: a morph identity chain propagates across THREE OR MORE slides (regression: chain resolution must thread the PREDECESSOR's complete map, including its own freshly-minted keys, never an inherited-only partial one)", () => {
  let n = 0;
  const mint = () => `k${++n}`;
  const shapesA = [{ id: 1, name: "Circle", type: "sp" }];
  const shapesB = [{ id: 1, name: "Circle", type: "sp" }];
  const shapesC = [{ id: 1, name: "Circle", type: "sp" }];
  const flatA = flattenMatchable(shapesA);
  const flatB = flattenMatchable(shapesB);
  const flatC = flattenMatchable(shapesC);

  // Slide A: no predecessor, no boundary — every shape mints FRESH.
  const chainA = resolveSlideChainKeys(null, null, flatA, mint);
  // Slide B: morphs from A — must inherit A's key, not mint a new one.
  const chainB = resolveSlideChainKeys(chainA, matchSlidePair(shapesA, shapesB), flatB, mint);
  // Slide C: morphs from B — must inherit the SAME chain key all the way
  // from A, which requires B's map (not just A's) to have carried it.
  const chainC = resolveSlideChainKeys(chainB, matchSlidePair(shapesB, shapesC), flatC, mint);

  assert.equal(chainA.get(1), chainB.get(1));
  assert.equal(chainB.get(1), chainC.get(1)); // THE bug this pins: used to mint a NEW id here
  assert.equal(chainA.get(1), "k1"); // exactly one id minted across the whole 3-slide chain
});

test("translateDeck: click steps expand to the right number of slides with active flips, active~interp modes, and delay leaves", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const circleId = Object.keys(doc.slides[1].delta.items).find((id) => doc.slides[1].delta.items[id].name === "Circle 1");
  const squareId = Object.keys(doc.slides[1].delta.items).find((id) => doc.slides[1].delta.items[id].name === "Square 1");
  // Base slide: both shapes start hidden (entrance-later per THE MECHANISM
  // — ALSO already "fade" here, from the unmatched-at-morph-boundary
  // crossfade treatment, since this fixture's morph pairs zero shapes by
  // name; diffState therefore OMITS "active~interp" from click1's own delta
  // below, since it does not CHANGE there — it was already fade on the fold
  // this step inherits from).
  assert.equal(doc.slides[1].delta.items[circleId].active, false);
  assert.equal(doc.slides[1].delta.items[circleId]["active~interp"], "fade");
  assert.equal(doc.slides[1].delta.items[squareId].active, false);
  // Click 1: circle enters. Its OWN delta only carries what CHANGED —
  // active flips to true; active~interp stays omitted (unchanged: fade on
  // both sides of this diff), which is diffState's minimal-delta contract,
  // not a translator gap.
  const click1 = doc.slides[2].delta.items[circleId];
  assert.equal(click1.active, true);
  assert.equal("active~interp" in click1, false);
  assert.equal(doc.slides[2].transition.type, "tween");
  // 1ms, not the animEffect's 500ms fade duration: DeckIR's own
  // timing.js `collectEffectEntries` records only ONE behavior per
  // effect-bearing par (its FIRST child element in document order) — the
  // fixture's click-1 par lists <p:set> before <p:animEffect>, so DeckIR
  // itself reports dur=1 for this effect (measured directly against
  // parsePptx's own output). This is a stage-1 (committed, read-only)
  // parsing characteristic, not a stage-2 translation bug — pinned here
  // exactly so a future stage-1 change that starts capturing BOTH
  // behaviors is visible as a test change, not a silent regression.
  assert.equal(doc.slides[2].transition.seconds, 1 / 1000);
  // Click 2: square enters WITH a 750ms delay (the afterEffect emphasis stagger).
  const click2 = doc.slides[3].delta.items[squareId];
  assert.equal(click2.active, true);
  assert.equal(click2.delay, 0.75);
  assert.equal(doc.slides[3].transition.seconds, (750 + 300) / 1000);
});

test("applyClickStep: `delay` is a PER-STEP window, never sticky — an item delayed on one step must NOT carry that delay into a later step it isn't part of (regression: itemDelayAlpha's own window law, core/document.js)", () => {
  const chainKeyFor = (id) => `item${id}`;
  const step1 = { trigger: "click", effects: [{ shapeId: 1, presetClass: "entr", presetId: 10, delayMs: 750, durMs: 300 }] };
  const step2 = { trigger: "click", effects: [{ shapeId: 2, presetClass: "entr", presetId: 10, delayMs: 0, durMs: 300 }] };
  const base = new Map([["item1", { active: false }], ["item2", { active: false }]]);
  const { nextState: afterStep1 } = applyClickStep(base, step1, chainKeyFor, []);
  assert.equal(afterStep1.get("item1").delay, 0.75);
  assert.equal("delay" in afterStep1.get("item2"), false);
  const { nextState: afterStep2 } = applyClickStep(afterStep1, step2, chainKeyFor, []);
  // item1 is untouched by step2 — its stale 0.75s delay must be GONE, not
  // carried into step2's own (unrelated) transition.
  assert.equal("delay" in afterStep2.get("item1"), false);
  assert.equal("delay" in afterStep2.get("item2"), false); // step2's own delayMs is 0
  // The prior state's objects are never mutated in place (immutability law).
  assert.equal(afterStep1.get("item1").delay, 0.75);
});

test("translateDeck: repaired doc has ZERO repair reports (the fixture law)", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture" });
  const { reports } = repairedDocument(doc, registry);
  assert.deepEqual(reports, []);
});

test("translateDeck: font substitutions are reported for every unmatched family (Georgia, Verdana — not in the committed registry)", () => {
  const { report } = translateDeck(deckIR, { name: "Fixture" });
  assert.ok(report.fontSubstitutions.some((s) => s.wanted === "Georgia" && s.used === "system"));
  assert.ok(report.fontSubstitutions.some((s) => s.wanted === "Verdana" && s.used === "system"));
});

test("translateDeck: slideIndices filtering translates only the selected PPT slides", () => {
  const { doc } = translateDeck(deckIR, { name: "Fixture", slideIndices: [0] });
  assert.equal(doc.slides.length, 1);
  assert.equal(doc.slides[0].name, "Slide 1");
});

test("translateDeck: slideIndices filtering also filters the returned assets to only what the SELECTED slides reference (user ruling)", () => {
  const onlyPicSlide = translateDeck(deckIR, { name: "Fixture", slideIndices: [0] });
  assert.equal(onlyPicSlide.assets.length, 1);
  const noPicSlides = translateDeck(deckIR, { name: "Fixture", slideIndices: [1, 2] });
  assert.equal(noPicSlides.assets.length, 0);
});

test("resolveSlideIndices: defaults to every slide, sorts/dedupes explicit input, rejects out-of-range", () => {
  assert.deepEqual(resolveSlideIndices(3, undefined), [0, 1, 2]);
  assert.deepEqual(resolveSlideIndices(3, [2, 0, 0]), [0, 2]);
  assert.throws(() => resolveSlideIndices(3, [5]));
});

test("idMinter: deterministic, sequential, never uses Math.random/crypto (the pure-function determinism law)", () => {
  const mint = idMinter();
  assert.deepEqual([mint(), mint(), mint()], ["p1", "p2", "p3"]);
  const mint2 = idMinter();
  assert.equal(mint2(), "p1"); // a fresh minter always restarts at p1 — same DeckIR -> byte-identical ids
});

// ── effects.js — outerShdw polar->cartesian (deck 1's fixture has no
// shadowed shapes; the real deck's slide9/17 arrows do — this exercises the
// math standalone against a hand-built XML node, per the task spec's
// "numeric-first assertions before pixel comparison" rule) ─────────────────

test("effects.js: polarShadowOffsetPx converts EMU distance + 60000ths-of-a-degree direction to cartesian px", () => {
  assert.deepEqual(polarShadowOffsetPx(38100, 0), { dx: 4, dy: 0 }); // 38100 EMU = 4px, 0deg = pure +x
  const down = polarShadowOffsetPx(9525, 5400000); // 90 degrees = straight down
  assert.ok(Math.abs(down.dx) < 1e-9);
  assert.ok(Math.abs(down.dy - 1) < 1e-9);
});

test("effects.js: translateOuterShadow reads blurRad/dist/dir/color/alpha off the raw XML node into the shadow bundle shape", () => {
  const node = parseXml(
    '<a:outerShdw xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" blurRad="63500" dist="12700" dir="2700000">' +
      '<a:srgbClr val="112233"><a:alpha val="50000"/></a:srgbClr></a:outerShdw>',
  );
  const { shadow, refusal } = translateOuterShadow({ type: "outerShdw", node }, {}, {});
  assert.equal(shadow.blur, 63500 / 9525);
  assert.equal(shadow.color, "#112233");
  assert.equal(shadow.opacity, 0.5);
  const expected = polarShadowOffsetPx(12700, 2700000);
  assert.ok(Math.abs(shadow.dx - expected.dx) < 1e-9);
  assert.ok(Math.abs(shadow.dy - expected.dy) < 1e-9);
  assert.equal(refusal, null);
});

test("effects.js: a non-uniform shadow scale (sx/sy) is reported, never silently applied (PowerRP has no shadow-scale concept)", () => {
  const node = parseXml(
    '<a:outerShdw xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" blurRad="243814" sx="102000" sy="102000" algn="ctr" rotWithShape="0">' +
      '<a:schemeClr val="bg1"/></a:outerShdw>',
  );
  const { refusal } = translateOuterShadow({ type: "outerShdw", node }, {}, {});
  assert.ok(refusal.includes("non-uniform scale"));
  assert.ok(refusal.includes("rotWithShape"));
});

test("translateDeck: is deterministic — the same DeckIR translated twice produces byte-identical documents", () => {
  const a = translateDeck(deckIR, { name: "Fixture" });
  const b = translateDeck(deckIR, { name: "Fixture" });
  assert.deepEqual(a.doc, b.doc);
});

console.log(`\npptx_translate_test: ${passed} passed`);
