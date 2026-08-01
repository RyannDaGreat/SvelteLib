/**
 * THE VIDEO-SAMPLING CONTRACT — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/video_sampling_test.js
 *
 * ── WHAT THIS GATES, AND WHY IT IS A GATE AND NOT A COMMENT ──────────────────
 * The user's requirement for the IMAGE STACK, verbatim:
 *
 *   "very similar to filmstrip except slightly different — it should have the same
 *    properties to specify video as filmstrip, so that if I go from one element to
 *    the other, it's easy to fall between them."
 *
 * "Fall between them" is RETYPING (core/retype.js), and a retype carries a stored
 * value across ONLY when both types declare the key AND their inspector rows agree
 * on kind. So the requirement is a LOSSLESS ROUND TRIP, and this file PROVES the
 * round trip rather than asserting the resemblance:
 *
 *   (1) both widgets declare the SAME rows for the shared keys, compared with
 *       core/multiselect.js sameRowContract — the codebase's own definition of
 *       "the same row", denylisting only label/help/category and friends;
 *   (2) core/retype.js reports NO COERCION for any shared key, in EITHER
 *       direction — which is what the retype menu shows the user;
 *   (3) a real document round trip, filmstrip → image_stack → filmstrip, through
 *       retypedItem + foldState, returns every shared value BYTE-IDENTICAL,
 *       including a hidden frame, a hand-typed frame time and a wrap mode;
 *   (4) the shared declaration has REAL CONSUMERS — the anti-vacuity floor. A gate
 *       over an empty set passes forever, and this one's whole subject is "the two
 *       widgets agree", which is trivially true of zero widgets.
 *
 * ── WHY THE EXPECTATION IS DERIVED, NEVER RESTATED ───────────────────────────
 * Nothing here writes down what the shared rows ARE. The consuming plugins are
 * discovered by scanning the live roster for the shared declaration's keys, and the
 * expected contract is read off core/video_sampling.js. A test that retyped the row
 * list in its own words would be a THIRD copy of the thing it is policing, and would
 * go green while all three drifted together in different directions.
 *
 * (5) A SEPARATE, SMALLER GATE rides along: `preserveAspect` is declared inline by
 *     SIX plugins (latex, svg, mermaid, iconify, demo/cursor, plus this pair through
 *     core/video_sampling.preserveAspectRow). Only two of them share a home. The
 *     other four are out of this change's scope, but ledger C-7 says deferring the
 *     FIX never defers the GATE — so every declaration of that key, wherever it
 *     lives, must carry an identical contract, and a seventh copy that drifts fails
 *     here instead of silently splitting the property in two.
 */

import assert from "node:assert/strict";
import { registerPlugins } from "../plugins/index.js";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, foldState } from "../core/document.js";
import { retypedItem, coercionPreview, retypeEligible, rowsByKey } from "../core/retype.js";
import { sameRowContract, contractDifferences } from "../core/multiselect.js";
import {
  VIDEO_SAMPLING_KEYS, VIDEO_SAMPLING_ROWS, defaultFrameList, emptySpanReport,
  frameTimeEquation, preserveAspectRow, spanIsEmpty, videoSamplingDefaults, visibleFrames,
} from "../core/video_sampling.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The REGISTERED objects, not the source modules: a sweep must see exactly what the
// editor registered (plugins/index.js builtinRoster's docstring — jailed library
// widgets included, universal-effects injection applied).
const registry = createRegistry();
registerPlugins(registry);
const roster = registry.all();

/** Query (reads the live roster). Every registered plugin that declares EVERY shared
 *  key — i.e. every real consumer of the shared declaration, found rather than
 *  listed, so a third widget joining the family is covered with nothing to edit. */
function samplingPlugins() {
  return roster.filter((p) => {
    const keys = new Set((p.inspector ?? []).map((r) => r.key));
    return VIDEO_SAMPLING_KEYS.every((k) => keys.has(k));
  });
}

// ── (4) THE ANTI-VACUITY FLOOR, first: everything below is about agreement ────

test("the shared declaration has at least TWO real consumers on the live roster", () => {
  const consumers = samplingPlugins();
  assert.ok(
    consumers.length >= 2,
    `core/video_sampling.js is meant to be SHARED, but ${consumers.length} registered plugin(s) declare its keys — ` +
    "every assertion in this file is vacuous below two",
  );
  const types = consumers.map((p) => p.type);
  for (const required of ["filmstrip", "image_stack"])
    assert.ok(types.includes(required), `${required} must compose the shared video-sampling rows (found: ${types.join(", ")})`);
  console.log(`      (video-sampling consumers: ${types.join(", ")})`);
});

// ── (1) THE ROWS ARE THE SAME ROWS ────────────────────────────────────────────

test("every consumer's shared rows have the SAME CONTRACT as core/video_sampling.js's", () => {
  const expected = new Map(VIDEO_SAMPLING_ROWS.map((r) => [r.key, r]));
  const offenders = [];
  for (const plugin of samplingPlugins()) {
    const rows = rowsByKey(plugin);
    for (const [key, want] of expected) {
      const got = rows.get(key);
      if (!sameRowContract(want, got)) offenders.push(`${plugin.type}.${key} differs on ${contractDifferences(want, got).join("/")}`);
    }
  }
  assert.deepEqual(offenders, [], `spread VIDEO_SAMPLING_ROWS instead of re-declaring these rows: ${offenders.join("; ")}`);
});

test("the shared rows are ONE object identity, not two equal copies", () => {
  // The strongest available statement that these are the same rows: both plugins
  // spread the SAME resolved row objects (the GRADIENT_STOPS_LIST / RAMP_STOP_ELEMENT
  // precedent in core/properties.js, whose identity tests/ramps_test.js also asserts).
  for (const plugin of samplingPlugins())
    for (const want of VIDEO_SAMPLING_ROWS)
      assert.ok(
        (plugin.inspector ?? []).includes(want),
        `${plugin.type} declares its own "${want.key}" row object — spread VIDEO_SAMPLING_ROWS so there is one declaration`,
      );
});

test("the src row is narrowed to VIDEO assets, which is a CONTRACT aspect", () => {
  // assetKinds is not decoration: core/multiselect.js's own doctest names it as the
  // axis on which an image `src` and a video `src` are DIFFERENT properties. If this
  // ever regressed to ["image"] the two widgets would stop being jointly editable and
  // the asset picker would offer the wrong files.
  const src = VIDEO_SAMPLING_ROWS.find((r) => r.key === "src");
  assert.deepEqual(src.assetKinds, ["video"]);
  assert.equal(src.kind, "asset");
});

// ── (2) THE RETYPE MENU PROMISES NO LOSS, IN BOTH DIRECTIONS ─────────────────

const SOURCED = {
  src: "/asset/demo/clip.mp4",
  videoStart: 1.25,
  videoEnd: 9.5,
  frames: [[1.25], ["self.video_start + 1 / 3 * (self.video_end - self.video_start)"], [7]],
  framesActive: [true, false, true],
  scrubWrap: "loop",
  preserveAspect: false,
};

/** The keys a retype between the two widgets must preserve — the shared declaration
 *  plus the list's visibility companion, which is not a ROW but is part of the same
 *  stored property (core/lists.js activeKey). */
const CARRIED_KEYS = [...VIDEO_SAMPLING_KEYS, "preserveAspect", "framesActive"];

test("neither direction COERCES any shared key — the retype menu warns about none of them", () => {
  const strip = registry.get("filmstrip");
  const stack = registry.get("image_stack");
  const folded = { type: "filmstrip", ...strip.defaults, ...SOURCED };
  for (const [from, to] of [[strip, stack], [stack, strip]]) {
    const state = { ...folded, type: from.type };
    const lost = coercionPreview(state, from, to).filter((c) => CARRIED_KEYS.includes(c.key));
    assert.deepEqual(lost, [], `${from.type} → ${to.type} would DISCARD ${lost.map((c) => c.key).join(", ")}`);
  }
});

test("both widgets are retype-ELIGIBLE, or the menu never offers the trip at all", () => {
  assert.equal(retypeEligible(registry.get("filmstrip")), true);
  assert.equal(retypeEligible(registry.get("image_stack")), true);
});

// ── (3) THE REAL ROUND TRIP, through a document ──────────────────────────────

test("filmstrip → image_stack → filmstrip returns every source value UNTOUCHED", () => {
  const strip = registry.get("filmstrip");
  const [doc, id] = withNewItem(newDocument(), 0, { ...strip.defaults, ...SOURCED, active: true });

  const before = foldState(doc, 0).items[id];
  for (const k of CARRIED_KEYS)
    assert.deepEqual(before[k], SOURCED[k], `the fixture itself must hold "${k}" before anything is retyped`);

  const asStack = retypedItem(doc, 0, id, "image_stack", before, registry);
  const mid = foldState(asStack, 0).items[id];
  assert.equal(mid.type, "image_stack");
  for (const k of CARRIED_KEYS)
    assert.deepEqual(mid[k], SOURCED[k], `"${k}" did not survive filmstrip → image_stack`);
  // The stack's OWN keys were filled like an insert (core/retype.js rule 1), so it is
  // a complete widget rather than one meeting `undefined` where it declared a number.
  const stack = registry.get("image_stack");
  for (const k of ["shiftX", "shiftY", "alphaExponent", "cardRadius", "shadowOpacity"])
    assert.equal(mid[k], stack.defaults[k], `the retyped stack should hold its own default for "${k}"`);

  const backToStrip = retypedItem(asStack, 0, id, "filmstrip", mid, registry);
  const after = foldState(backToStrip, 0).items[id];
  assert.equal(after.type, "filmstrip");
  for (const k of CARRIED_KEYS)
    assert.deepEqual(after[k], SOURCED[k], `"${k}" did not survive the return trip to filmstrip`);
  // The strip's own film keys came home at their defaults (they were never touched —
  // rule 3 leaves the stack's surplus keys dormant, and rule 1 refills the strip's).
  assert.equal(after.perfFamily, strip.defaults.perfFamily);
  // And the ID SURVIVED, which is the entire point of retyping instead of deleting and
  // recreating: every equation and arrow binding that names this item still names it.
  // (A fresh document already holds the camera, so the widget is one of two items.)
  assert.deepEqual(Object.keys(foldState(backToStrip, 0).items).sort(), Object.keys(foldState(doc, 0).items).sort());
  assert.ok(Object.keys(foldState(backToStrip, 0).items).includes(id));
});

test("a retyped stack still reads its frames the same way the strip did", () => {
  // The two widgets do not merely STORE the same list, they INTERPRET it identically:
  // one shared reader, so a hidden element is absent from both and the stored indices
  // (what a per-frame anchor id is keyed on) are the same numbers.
  assert.deepEqual(visibleFrames(SOURCED), [{ index: 0, time: 1.25 }, { index: 2, time: 7 }]);
});

// ── THE SHARED HELPERS' OWN BEHAVIOUR ────────────────────────────────────────

test("the default frame equations span videoStart→videoEnd at i/N, frame 0 AT the start", () => {
  assert.equal(frameTimeEquation(0, 6), "self.video_start");
  assert.equal(frameTimeEquation(3, 6), "self.video_start + 3 / 6 * (self.video_end - self.video_start)");
  // n = 1 degenerates to the start rather than dividing by zero (the i/(N-1) trap).
  assert.deepEqual(defaultFrameList(1), [["self.video_start"]]);
  assert.equal(defaultFrameList(6).length, 6);
  // No element asks for EXACTLY videoEnd — seeking to a clip's duration is undefined.
  assert.ok(!defaultFrameList(6).some(([eq]) => eq.includes("6 / 6")));
});

test("videoSamplingDefaults gives a widget the WHOLE source half and nothing else", () => {
  const d = videoSamplingDefaults(4);
  assert.deepEqual(
    Object.keys(d).sort(),
    ["frames", "preserveAspect", "scrubWrap", "src", "videoEnd", "videoStart"],
    "a key added here lands in two widgets at once — it must be one both of them want",
  );
  assert.equal(d.src, "", "an empty src is what makes a fresh widget a GHOST");
  assert.equal(d.videoEnd, 0, "0 is an honest 'the clip length has not been supplied'");
  assert.equal(d.frames.length, 4);
  assert.equal(spanIsEmpty(d), true, "so a fresh widget's span IS empty, and it says so");
});

test("both widgets spread videoSamplingDefaults rather than writing their own", () => {
  for (const plugin of samplingPlugins()) {
    const shared = videoSamplingDefaults(plugin.defaults.frames.length);
    for (const [k, v] of Object.entries(shared))
      assert.deepEqual(plugin.defaults[k], v, `${plugin.type}.defaults.${k} disagrees with videoSamplingDefaults`);
  }
});

test("the empty-span notice is ONE sentence with the widget's own name in it", () => {
  // One condition, one voice (the connectivity.offlineMessage precedent). Both widgets
  // report through this, so the wording cannot fork.
  const a = emptySpanReport("Filmstrip", { videoStart: 0, videoEnd: 0 });
  const b = emptySpanReport("Image Stack", { videoStart: 0, videoEnd: 0 });
  assert.notEqual(a.key, b.key, "the dedup keys must differ or one widget silences the other");
  assert.equal(a.message.replace("Filmstrip", "X"), b.message.replace("Image Stack", "X"));
  assert.ok(a.message.includes('"Video end (s)"'), "the notice must name the Inspector row that fixes it");
});

// ── (5) THE RIDE-ALONG GATE: preserveAspect has ONE contract app-wide ─────────

test("every plugin's `preserveAspect` row has the SAME contract, wherever it is declared", () => {
  const canonical = preserveAspectRow("");
  const declarers = [];
  const offenders = [];
  for (const plugin of roster) {
    const row = (plugin.inspector ?? []).find((r) => r.key === "preserveAspect");
    if (!row) continue;
    declarers.push(plugin.type);
    if (!sameRowContract(canonical, row)) offenders.push(`${plugin.type} differs on ${contractDifferences(canonical, row).join("/")}`);
  }
  assert.ok(declarers.length >= 5, `expected preserveAspect on several widgets, found ${declarers.length} — this gate has no subjects`);
  assert.deepEqual(offenders, [],
    "preserveAspect is declared inline by several widgets and there is no shared home for it yet; until there is, " +
    `the contract must stay identical: ${offenders.join("; ")}`);
  console.log(`      (preserveAspect declared by: ${declarers.join(", ")})`);
});

console.log(`\n${passed} tests passed`);
