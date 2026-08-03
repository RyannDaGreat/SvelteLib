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
  isSlideField, slideFieldKeys,
} from "../core/transitions.js";
import { newDocument, withNewSlide } from "../core/document.js";
import { createPresenter } from "../core/presentation.js";
import { fadeStrength, isFadeFrame } from "../web/transitionRender.js";
import { timelinePlan, DEFAULT_HOLD_SECONDS } from "../web/videoExport.js";
import { ease } from "../core/interpolators.js";
import { SECONDS_SCRUB, PROPS, NULLABLE_ROW_KINDS, customProps } from "../core/properties.js";

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
  // `autoAdvance` (the LINGER) is here even though it stores on the SLIDE — see
  // slideFieldKeys' header. The rows list is the PANEL, not the record shape.
  const base = ["seconds", "curve", "sound", "autoAdvance"];
  assert.deepEqual(TRANSITION_BASE_INSPECTOR.map((r) => r.key), base);
  assert.deepEqual(transitionInspector("tween").map((r) => r.key), base);
  assert.deepEqual(transitionInspector("fade").map((r) => r.key), base);
  // row shape matches plugin inspector rows (label/key/kind present)
  for (const r of transitionInspector("tween")) assert.ok(r.key && r.label && r.kind);
});

// ── THE LINGER: a slideField row, and the nullable number aspect ──────────────

test("autoAdvance is a slideField row; the transition RECORD is untouched by it", () => {
  // The row renders on the transition panel...
  const linger = TRANSITION_BASE_INSPECTOR.find((r) => r.key === "autoAdvance");
  assert.equal(linger.slideField, true);
  assert.equal(linger.label, "Linger");
  assert.equal(isSlideField("autoAdvance"), true);
  assert.deepEqual(slideFieldKeys(), ["autoAdvance"]);
  // ...and every OTHER row is NOT a slide field, so the routing cannot over-fire.
  for (const key of ["seconds", "curve", "sound"]) assert.equal(isSlideField(key), false);
  // BYTE-IDENTICAL LEGACY: the serialized transition shape gained nothing. A
  // slide with no autoAdvance resolves to exactly the four keys it always had.
  assert.deepEqual(Object.keys(resolveTransition({ slides: [{}, {}] }, 1)).sort(), ["curve", "seconds", "sound", "type"]);
  assert.deepEqual(defaultTransition("tween"), { seconds: 0.5, curve: "smooth", sound: null, type: "tween" });
  // A LINGER set on the slide does not leak into the record either.
  assert.equal("autoAdvance" in resolveTransition({ slides: [{}, { autoAdvance: 3 }] }, 1), false);
});

test("autoAdvance shares the SECONDS unit-kind and declares the nullable aspect", () => {
  const linger = TRANSITION_BASE_INSPECTOR.find((r) => r.key === "autoAdvance");
  // Same scrub rate as the seconds row beside it — two time rows on one panel
  // that moved at different speeds would be a bug the user feels immediately.
  assert.equal(linger.scrub, SECONDS_SCRUB);
  assert.equal(linger.min, 0);
  assert.equal(linger.category, "transition");
  // NULL IS NOT ZERO — the whole reason the aspect exists (0 = advance at once,
  // absent = never). Both consumers read `typeof x === "number"`.
  assert.equal(linger.nullable, true);
  assert.ok(NULLABLE_ROW_KINDS.includes(linger.kind), "a nullable row's kind must have an unset display");
  // The help text names BOTH consumers and says what CLEARED means.
  for (const phrase of ["presenter", "export", "never"]) assert.ok(linger.help.includes(phrase), `help must mention "${phrase}"`);
});

test("the `nullable` aspect is loud where it would do nothing", () => {
  // A kind with no unset display must not silently accept the aspect.
  assert.throws(
    () => customProps([{ name: "flagged", kind: "boolean", label: "Flagged", nullable: true, default: false }]),
    /nullable.*"boolean"/s,
  );
  // A non-boolean value is a typo, not a declaration.
  assert.throws(
    () => customProps([{ name: "dwell", kind: "number", label: "Dwell", nullable: "yes", default: 0 }]),
    /boolean aspect/,
  );
  // The legitimate declaration passes and flows through to the row.
  assert.equal(customProps([{ name: "dwell", kind: "number", label: "Dwell", nullable: true, default: 0 }]).rows[0].nullable, true);
});

// ── 14.6: the seconds row inherits the LOW registry scrub (unit-kind fix) ──────
test("seconds transition row carries the registry SECONDS_SCRUB (14.6 unit-kind)", () => {
  const secondsRow = TRANSITION_BASE_INSPECTOR.find((r) => r.key === "seconds");
  // It comes from the shared property registry (row("seconds")) — NOT a
  // hand-written scrub — so the coefficient is single-sourced. Was 0.1 (Round 12,
  // still ~10× too coarse); SECONDS_SCRUB (0.01) makes a full 100px drag ≈ 1s.
  assert.equal(secondsRow.scrub, SECONDS_SCRUB);
  assert.equal(PROPS.seconds.scrub, SECONDS_SCRUB); // the registry is the home
  assert.ok(SECONDS_SCRUB <= 0.02, "SECONDS_SCRUB must be within the ratified ~0.01-0.02 s/px target");
  assert.equal(secondsRow.min, 0); // a duration is non-negative
  assert.equal(secondsRow.category, "transition");
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

// ── 14.7 ROOT CAUSE: a fade with seconds 0 CUTS (one alpha-1 frame, no ramp) ───
// This documents WHY the user sees "fade just flicks from slide to slide": the
// fade RENDERER is fine (fade_presenter_probe.js / fade_livemode_probe.js prove
// a real on-screen crossfade at seconds>0), but a seconds=0 transition takes the
// presenter's instant path (duration<=0 → emit one alpha-1 frame). A user only
// reaches seconds=0 because the slider was oversensitive — the 14.6 bug — so the
// two reports are one root cause. seconds=0 cutting is CORRECT (an instant
// transition IS a cut); the fix is making seconds settable (14.6), not the fade.
test("14.7: seconds-0 fade emits a single alpha-1 frame (instant cut, no crossfade)", () => {
  const doc = { slides: [
    { id: "s0", transition: defaultTransition("tween"), delta: {} },
    { id: "s1", transition: { type: "fade", seconds: 0, curve: "linear" }, delta: {} },
  ] };
  const frames = [];
  const pres = createPresenter(() => doc, (f) => frames.push({ index: f.index, alpha: f.alpha, type: f.transition?.type ?? null }));
  pres.goTo(0);
  const before = frames.length;
  pres.next();
  const stepFrames = frames.slice(before).filter((f) => f.index === 1);
  // exactly ONE frame into slide 1, and it is fully applied (alpha 1) — a cut.
  assert.equal(stepFrames.length, 1);
  assert.equal(stepFrames[0].alpha, 1);
  assert.equal(stepFrames[0].type, "fade"); // the type is still carried (it's a fade that happened to be instant)
  // NO intermediate alpha was emitted (that is what a crossfade would need).
  assert.equal(stepFrames.filter((f) => f.alpha > 0 && f.alpha < 1).length, 0);
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

// ── Round 18 audit F5: presenter is bare-node runnable (scheduler injected) ──
// core/presentation.js must import + run in BARE NODE (manifest: "core runs in
// bare node"). requestAnimationFrame is a HOST concern (browser only), so the
// frame scheduler is INJECTED — the instant path needs none; the animated path
// takes one or fails loudly. These tests run under node with no rAF global.

function twoSlideDoc(seconds) {
  return { slides: [
    { id: "s0", transition: defaultTransition("tween"), delta: {} },
    { id: "s1", transition: { type: "tween", seconds, curve: "linear" }, delta: {} },
  ] };
}

test("bare-node: instant playback runs with NO scheduler injected (no rAF in node)", () => {
  const doc = twoSlideDoc(0); // seconds 0 → instant path never touches the scheduler
  const frames = [];
  const pres = createPresenter(() => doc, (f) => frames.push({ ...f })); // defaults; no scheduler args
  pres.goTo(0);
  pres.next(); // instant jump to slide 1
  pres.prev(); // instant back
  assert.equal(frames.at(-1).index, 0);
  assert.equal(frames.at(-1).alpha, 1);
});

test("bare-node: an injected scheduler is NOT called on the instant path", () => {
  const doc = twoSlideDoc(0);
  let scheduleCalls = 0;
  const pres = createPresenter(() => doc, () => {}, () => {}, (cb) => { scheduleCalls += 1; return 1; }, () => {});
  pres.goTo(0);
  pres.next(); // instant → no frame scheduled
  assert.equal(scheduleCalls, 0);
});

test("bare-node: an ANIMATED transition runs to completion with an injected synchronous scheduler", () => {
  const doc = twoSlideDoc(0.5); // nonzero → the rAF ramp path
  const frames = [];
  // A synchronous bare-node clock: invoke the tick with a timestamp past the
  // transition so the ramp completes deterministically in one tick — no rAF.
  const requestFrame = (cb) => { cb(performance.now() + 10_000); return 1; };
  const pres = createPresenter(() => doc, (f) => frames.push({ ...f }), () => {}, requestFrame, () => {});
  pres.goTo(0);
  pres.next(); // drives requestFrame synchronously up to alpha 1
  const last = frames.at(-1);
  assert.equal(last.index, 1);
  assert.equal(last.alpha, 1); // reached the completed state
  assert.ok(frames.some((f) => f.index === 1 && f.alpha === 0)); // the ramp emitted its start frame
});

test("bare-node: an ANIMATED transition with NO scheduler fails LOUDLY (no silent rAF fallback)", () => {
  const doc = twoSlideDoc(0.5);
  const pres = createPresenter(() => doc, () => {}); // animated path, but no scheduler injected
  pres.goTo(0);
  assert.throws(() => pres.next(), /frame scheduler/);
});

// ── THE LINGER IN PLAYBACK: null ≠ 0, measured at the presenter ───────────────

/** The presenter arms its linger with the GLOBAL setTimeout (core stays
 *  scheduler-agnostic for FRAMES, but a linger is a plain timeout). Swapping it
 *  for a recorder is how a bare-node test reads the arming decision AND the
 *  delay without waiting real seconds. Command: restores the real one. */
function withRecordedTimeouts(fn) {
  const realSetTimeout = globalThis.setTimeout;
  const armed = [];
  globalThis.setTimeout = (cb, ms) => { armed.push({ cb, ms }); return armed.length; };
  try { fn(armed); } finally { globalThis.setTimeout = realSetTimeout; }
}

test("PLAYBACK: an absent linger arms NOTHING; 0 arms an IMMEDIATE advance", () => {
  // The two meanings the `nullable` aspect exists to keep apart, measured at the
  // consumer rather than asserted about the row.
  withRecordedTimeouts((armed) => {
    const noLinger = twoSlideDoc(0);
    const pres = createPresenter(() => noLinger, () => {});
    pres.goTo(0);
    assert.equal(armed.length, 0, "no autoAdvance ⇒ the presenter waits for a click");
  });
  withRecordedTimeouts((armed) => {
    const zero = twoSlideDoc(0);
    zero.slides[0].autoAdvance = 0; // "advance the instant this slide arrives"
    const pres = createPresenter(() => zero, () => {});
    pres.goTo(0);
    assert.equal(armed.length, 1);
    assert.equal(armed[0].ms, 0);
  });
  withRecordedTimeouts((armed) => {
    const lingering = twoSlideDoc(0);
    lingering.slides[0].autoAdvance = 3;
    const pres = createPresenter(() => lingering, () => {});
    pres.goTo(0);
    assert.equal(armed[0].ms, 3000); // seconds → ms
  });
  // A CLEARED linger is null, not undefined (the Inspector's × writes literal
  // null) — the presenter must read that as absent too, or clearing would arm a
  // 0ms advance, which is the opposite instruction.
  withRecordedTimeouts((armed) => {
    const cleared = twoSlideDoc(0);
    cleared.slides[0].autoAdvance = null;
    const pres = createPresenter(() => cleared, () => {});
    pres.goTo(0);
    assert.equal(armed.length, 0, "a CLEARED linger (null) must behave exactly like an absent one");
  });
});

test("EXPORT: the linger is the slide's dwell; cleared falls back to holdSeconds", () => {
  // The SECOND consumer named in the row's help. Same document, four lingers.
  const holdOf = (autoAdvance) => {
    const doc = twoSlideDoc(0);
    if (autoAdvance !== undefined) doc.slides[0].autoAdvance = autoAdvance;
    return timelinePlan(doc, { endIndex: 0 }).segments[0].seconds;
  };
  assert.equal(holdOf(undefined), DEFAULT_HOLD_SECONDS); // never set
  assert.equal(holdOf(null), DEFAULT_HOLD_SECONDS);      // CLEARED — same as never set
  assert.equal(holdOf(0), 0);                            // "advance immediately" is honored, not defaulted
  assert.equal(holdOf(4), 4);
});

console.log(`\n${passed} tests passed`);
