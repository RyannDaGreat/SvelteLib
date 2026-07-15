/**
 * Slide TRANSITIONS — model, migration, presenter wiring, and the pure fade
 * blend math (manifest Round 12 "Slides & TRANSITIONS"). Node assert, no
 * framework (matches the other suites).
 *
 *   node src/demo_apps/PowerRP/tests/transitions_test.js
 */

import assert from "node:assert/strict";
import {
  TRANSITION_BASE_DEFAULTS, TRANSITION_CURVES, DEFAULT_TRANSITION_TYPE,
  TRANSITION_TYPES, TRANSITION_BASE_INSPECTOR,
  defaultTransition, resolveTransition, retypedTransition, transitionType,
  transitionInspector, durationMigrations, withDurationMigrated,
} from "../core/transitions.js";
import { newDocument, withNewSlide } from "../core/document.js";
import { createPresenter } from "../core/presentation.js";
import { fadeStrength, isFadeFrame } from "../web/transitionRender.js";
import { ease } from "../core/interpolators.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── Type registry + defaults ──────────────────────────────────────────────

test("default type is tween; base defaults; curve smooth", () => {
  assert.equal(DEFAULT_TRANSITION_TYPE, "tween");
  assert.deepEqual(TRANSITION_BASE_DEFAULTS, { seconds: 0.5, curve: "smooth", sound: null });
  assert.deepEqual(TRANSITION_CURVES, ["linear", "smooth"]);
  assert.deepEqual(TRANSITION_TYPES.map((t) => t.type), ["tween", "fade"]);
});

test("defaultTransition merges superclass + type + type tag", () => {
  assert.deepEqual(defaultTransition("tween"), { seconds: 0.5, curve: "smooth", sound: null, type: "tween" });
  assert.deepEqual(defaultTransition("fade"), { seconds: 0.5, curve: "smooth", sound: null, type: "fade" });
  assert.equal(defaultTransition().type, "tween"); // omitted → default
});

test("transitionType is loud on unknown", () => {
  assert.equal(transitionType("fade").title, "Fade");
  assert.throws(() => transitionType("wipe"), /Unknown transition type "wipe"/);
});

test("resolveTransition folds a partial stored record to a full one", () => {
  const doc = { slides: [{}, { transition: { type: "fade" } }] };
  assert.deepEqual(resolveTransition(doc, 1), { seconds: 0.5, curve: "smooth", sound: null, type: "fade" });
  assert.equal(resolveTransition({ slides: [{}, {}] }, 1).type, "tween"); // unset → default tween
  assert.equal(resolveTransition({ slides: [{}, { transition: { type: "tween", seconds: 2, curve: "linear", sound: "ding" } }] }, 1).sound, "ding");
});

// ── retype (setTransitionType semantics) ───────────────────────────────────

test("retypedTransition preserves superclass, swaps class", () => {
  assert.deepEqual(
    retypedTransition({ type: "tween", seconds: 2, curve: "smooth", sound: "ding" }, "fade"),
    { seconds: 2, curve: "smooth", sound: "ding", type: "fade" },
  );
  // from undefined → full default of the new type
  assert.deepEqual(retypedTransition(undefined, "fade"), { seconds: 0.5, curve: "smooth", sound: null, type: "fade" });
});

// ── Inspector rows (Opus10 seam) ───────────────────────────────────────────

test("transitionInspector = base rows + type extras; base is superclass rows", () => {
  assert.deepEqual(TRANSITION_BASE_INSPECTOR.map((r) => r.key), ["seconds", "curve", "sound"]);
  assert.deepEqual(transitionInspector("tween").map((r) => r.key), ["seconds", "curve", "sound"]);
  assert.deepEqual(transitionInspector("fade").map((r) => r.key), ["seconds", "curve", "sound"]);
  // row shape matches plugin inspector rows (label/key/kind present)
  for (const r of transitionInspector("tween")) assert.ok(r.key && r.label && r.kind);
});

// ── duration → transition.seconds migration (lead ruling) ──────────────────

test("durationMigrations lists slides carrying legacy duration", () => {
  assert.deepEqual(
    durationMigrations({ slides: [{ id: "a", duration: 2, delta: {} }] }),
    [{ index: 0, slideId: "a", seconds: 2, stale: false }],
  );
  assert.deepEqual(durationMigrations({ slides: [{ id: "a", delta: {} }] }), []); // nothing to migrate
});

test("withDurationMigrated moves duration → transition.seconds, curve smooth, strips duration", () => {
  const { doc, migrated } = withDurationMigrated({ meta: {}, slides: [
    { id: "a", duration: 2, delta: {} },
    { id: "b", duration: 0.3, delta: {} },
  ] });
  assert.equal(migrated.length, 2);
  assert.deepEqual(doc.slides[0].transition, { type: "tween", seconds: 2, curve: "smooth", sound: null });
  assert.equal("duration" in doc.slides[0], false);
  assert.equal(doc.slides[1].transition.seconds, 0.3);
});

test("withDurationMigrated: a slide already carrying a transition keeps it (stale duration dropped)", () => {
  const { doc, migrated } = withDurationMigrated({ slides: [
    { id: "a", duration: 9, transition: { type: "fade", seconds: 1 }, delta: {} },
  ] });
  assert.equal(migrated[0].stale, true);
  assert.equal("duration" in doc.slides[0], false);
  assert.equal(doc.slides[0].transition.seconds, 1); // its own transition.seconds wins, not 9
  assert.equal(doc.slides[0].transition.type, "fade");
});

test("withDurationMigrated is idempotent", () => {
  const once = withDurationMigrated({ slides: [{ id: "a", duration: 2, delta: {} }] }).doc;
  assert.equal(withDurationMigrated(once).migrated.length, 0);
  assert.deepEqual(withDurationMigrated(once).doc, once);
});

// ── document.js: fresh slides carry a transition, never a duration ─────────

test("newDocument + withNewSlide carry a default tween transition, no duration", () => {
  const nd = newDocument();
  assert.equal("duration" in nd.slides[0], false);
  assert.deepEqual(nd.slides[0].transition, { type: "tween", seconds: 0.5, curve: "smooth", sound: null });
  const [nd2, idx] = withNewSlide(nd, 0);
  assert.equal("duration" in nd2.slides[idx], false);
  assert.equal(nd2.slides[idx].transition.type, "tween");
});

// ── presenter: honors curve/seconds, carries the transition to the surface ─

test("presenter emits {index, alpha, transition}; slide 0 has no transition", () => {
  const doc = { slides: [
    { id: "s0", transition: defaultTransition("tween"), delta: {} },
    { id: "s1", transition: { type: "fade", seconds: 0, curve: "linear" }, delta: {} },
  ] };
  const frames = [];
  const pres = createPresenter(() => doc, (f) => frames.push({ ...f }));
  pres.goTo(0);
  assert.equal(frames.at(-1).transition, null);
  pres.next(); // seconds 0 → instant jump to alpha 1, but transition still carried
  const last = frames.at(-1);
  assert.equal(last.index, 1);
  assert.equal(last.alpha, 1);
  assert.equal(last.transition.type, "fade");
});

test("presenter prev/goTo clear the in-flight transition (instant steps)", () => {
  const doc = { slides: [
    { id: "s0", transition: defaultTransition("tween"), delta: {} },
    { id: "s1", transition: { type: "fade", seconds: 0 }, delta: {} },
  ] };
  const frames = [];
  const pres = createPresenter(() => doc, (f) => frames.push({ ...f }));
  pres.next(); // → slide 1, transition set
  pres.prev(); // instant back → transition cleared
  assert.equal(frames.at(-1).index, 0);
  assert.equal(frames.at(-1).transition, null);
});

// ── pure fade blend math (transitionRender.js) ─────────────────────────────

test("fadeStrength: linear passes through, smooth eases, clamps", () => {
  assert.equal(fadeStrength(0.5, "linear"), 0.5);
  assert.equal(fadeStrength(0, "smooth"), 0);
  assert.equal(fadeStrength(1, "smooth"), 1);
  assert.equal(fadeStrength(0.5, "smooth"), ease("cubic")(0.5)); // cubic midpoint
  assert.equal(fadeStrength(-1, "linear"), 0); // clamp low
  assert.equal(fadeStrength(2, "linear"), 1); // clamp high
});

test("isFadeFrame: only mid-transition fades on slides > 0", () => {
  const fadeDoc = { slides: [{}, { transition: { type: "fade", seconds: 1 } }] };
  const tweenDoc = { slides: [{}, { transition: { type: "tween", seconds: 1 } }] };
  assert.equal(isFadeFrame(fadeDoc, 1, 0.5), true);
  assert.equal(isFadeFrame(fadeDoc, 1, 0), false); // endpoint = single completed slide
  assert.equal(isFadeFrame(fadeDoc, 1, 1), false); // endpoint
  assert.equal(isFadeFrame(fadeDoc, 0, 0.5), false); // slide 0 = no predecessor
  assert.equal(isFadeFrame(tweenDoc, 1, 0.5), false); // a tween is never a crossfade
});

console.log(`\n${passed} tests passed`);
