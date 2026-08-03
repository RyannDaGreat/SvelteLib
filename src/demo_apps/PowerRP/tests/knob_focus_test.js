/**
 * IN-CANVAS KNOBS — bare-node pins for the geometry, the press decision and the
 * write. Run: node src/demo_apps/PowerRP/tests/knob_focus_test.js
 *
 * ── WHAT IS WORTH PINNING HERE, AND WHAT IS NOT ─────────────────────────────
 * The BROWSER half (double-click enters, drag turns, one undo reverts, the
 * mirror gets a setParam) is tests/knob_focus_probe.js, because none of it is
 * expressible without a canvas. What lives HERE is everything that is a pure
 * function of a node's state, and it is the majority of the feature:
 *
 *   1. THE DIAL IS WHERE IT IS DRAWN. The painter, the hit test and the drag all
 *      read one layout; the assertion is that a press at a dial's own centre
 *      finds that dial. This is the law core/nodeflow.portLayout states for the
 *      beads, and the reason a knob cannot drift from its picture.
 *   2. THE PRESS ORDER: BEAD > DIAL > EXIT. A user ruling, not a preference —
 *      the founding message makes a bead drag-active "even if it's not
 *      selected", and wave 2 recorded the cost of an affordance that failed to
 *      cover one. Pinned in BOTH directions: a bead wins even with a dial in
 *      range, and a dial wins when no bead is.
 *   3. A KNOB NEVER LEAVES ITS OWN CARD. A dial painted past the rim is the
 *      defect the readout had before it was moved below the port rows.
 *   4. A BOUND KNOB IS REFUSED. Turning it would overwrite an `=` equation with
 *      the number it currently evaluates to, which is the destruction
 *      interiorNav already refuses.
 *   5. THE WRITE IS AN ORDINARY PROPERTY WRITE. One flat state key, at the path
 *      setPreview takes — which is what makes it keyframable, undoable and
 *      mirror-visible with no audio-specific code on the path.
 *   6. EVERY AUDIO PLUGIN CAN ACTUALLY BE TURNED. Swept over the real roster
 *      rather than a fixture, so a module added tomorrow is covered on the day
 *      it is registered.
 */

import assert from "node:assert/strict";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { knobAt, knobDragValue, knobLayout, knobReadout, knobSnap, KNOB_R } from "../core/node_knobs.js";
import { knobOps } from "../core/node_chrome.js";
import { knobPressKind, knobStateKey, knobTurnRefusal, knobWritePairs } from "../web/knobFocus.js";
import { KNOB_FOCUS_HANDLER } from "../web/knobFocus.js";

let passed = 0;
const test = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);

/** Every registered AUDIO node — derived from the registry, never listed, so the
 *  sweeps below cover a module added tomorrow. */
const AUDIO = registry.all().filter((p) => p.audioModule);

/** EVERY widget with dials, audio or not — which since BV includes the KNOB and
 *  SLIDER control nodes, whose leaves carry no `audio` prefix at all. The sweeps
 *  that check a dial writes to a real, declared, Inspector-visible leaf are about
 *  the KNOB CONTRACT rather than about audio, so they run over this. */
const KNOBBED = registry.all().filter((p) => typeof p.knobLayout === "function");

// ── 1. THE DIAL IS WHERE IT IS DRAWN ─────────────────────────────────────────

test("1. a press at a dial's own centre finds that dial — the painter and the hit test read one layout", () => {
  const bad = [];
  for (const plugin of AUDIO) {
    const state = { ...plugin.defaults };
    for (const k of plugin.knobLayout(state)) {
      const hit = knobAt(plugin.knobLayout(state), k.cx, k.cy, 0);
      if (hit?.key !== k.key) bad.push(`${plugin.type}.${k.key} -> ${hit?.key ?? "nothing"}`);
    }
  }
  assert.deepEqual(bad, [], `dials that cannot be grabbed where they are drawn:\n    ${bad.join("\n    ")}`);
});

test("1b. a press well away from every dial is NOT a knob — an ordinary body press", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults };
  // The card's top-left inside corner: header territory, no dial within reach.
  assert.equal(knobAt(filter.knobLayout(state), 4, 4, 0), null);
});

// ── 2. THE PRESS ORDER: BEAD > DIAL > EXIT ───────────────────────────────────

test("2. a port BEAD outranks a dial — the always-active wire layer wins inside knob focus", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults };
  const bead = filter.ports(state).inputs[0];
  // Press exactly on the first input bead (inputs run down the LEFT edge at x=0).
  const kind = knobPressKind(filter, state, 0, 34, 0);
  assert.equal(kind.kind, "bead", "a press on a bead must be released to the wire layer");
  assert.equal(kind.port.key, bead.key);
});

test("2b. …and it wins even when a DIAL is placed under the same point", () => {
  // Constructed rather than found: on a real card the two never overlap, and the
  // ruling has to hold for the squeezed card where they do.
  const fake = {
    ports: () => ({ inputs: [{ key: "in", type: "audio", label: "in" }], outputs: [] }),
    knobLayout: () => [{ key: "q", label: "Q", cx: 0, cy: 34, min: 0, max: 1, value: 0.5, fraction: 0.5, bound: false }],
  };
  assert.equal(knobPressKind(fake, { w: 150, h: 90 }, 0, 34, 0).kind, "bead");
});

test("2c. a press on a dial is a KNOB, and on the node's own body is an EXIT", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults };
  const dial = filter.knobLayout(state)[0];
  assert.equal(knobPressKind(filter, state, dial.cx, dial.cy, 0).kind, "knob");
  assert.equal(knobPressKind(filter, state, dial.cx, dial.cy, 0).knob.key, dial.key);
  // Just under the header, between the port columns: card, but nothing on it.
  assert.equal(knobPressKind(filter, state, (state.w ?? 0) / 2, 30, 0).kind, "exit");
});

// ── 3. A KNOB NEVER LEAVES ITS OWN CARD ──────────────────────────────────────

test("3. every dial of every audio node is inside its own default card, dial AND label", () => {
  const bad = [];
  for (const plugin of AUDIO) {
    const state = { ...plugin.defaults };
    for (const k of plugin.knobLayout(state)) {
      if (k.cx - KNOB_R < 0 || k.cx + KNOB_R > state.w) bad.push(`${plugin.type}.${k.key} x`);
      // The label sits below the dial, so the bottom the card must clear is the
      // dial's own bottom plus the label band — not merely the dial.
      if (k.cy - KNOB_R < 0 || k.cy + KNOB_R > state.h) bad.push(`${plugin.type}.${k.key} y (cy ${k.cy.toFixed(1)}, h ${state.h})`);
    }
  }
  assert.deepEqual(bad, [], `dials painted outside their own card:\n    ${bad.join("\n    ")}`);
});

test("3b. a node's default height GREW to hold its dials — the band is reserved, not borrowed", () => {
  // The pad has five continuous knobs and wraps to two rows; a card sized only to
  // its ports could not hold them, which is what readoutNodeHeight now adds for.
  const pad = registry.get("audio_pad");
  const rows = new Set(pad.knobLayout({ ...pad.defaults }).map((k) => k.cy));
  assert.ok(rows.size >= 2, `the pad's five dials should wrap to at least two rows, got ${rows.size}`);
});

test("3c. a DISCRETE knob gets no dial — a switch is not a knob", () => {
  // The noise module's colour is white/pink and is `construct: true`: a dial
  // landing between them is meaningless, and dragging across them would rebuild
  // the engine module on every pointermove.
  const noise = registry.get("audio_noise");
  const keys = noise.knobLayout({ ...noise.defaults }).map((k) => k.key);
  assert.ok(!keys.includes("color"), `a discrete knob must not get a dial; got ${keys.join(", ")}`);
  assert.ok(keys.includes("level"), "…but its continuous level knob must");
});

// ── 4. A BOUND KNOB IS REFUSED ───────────────────────────────────────────────

test("4. a knob holding an = equation is laid out, marked BOUND, and refused", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults, audioFrequency: "= 200 + 100 * ease(time)" };
  const dial = filter.knobLayout(state).find((k) => k.key === "frequency");
  assert.ok(dial, "a bound knob must still be laid out — the dial has to SHOW where the value sits");
  assert.equal(dial.bound, true);
  const refusal = knobTurnRefusal(dial, "Filter");
  assert.ok(refusal && refusal.includes("= equation"), `expected a refusal naming the equation, got ${refusal}`);
  // …and an ordinary numeric knob is not refused.
  const plain = filter.knobLayout({ ...filter.defaults }).find((k) => k.key === "frequency");
  assert.equal(plain.bound, false);
  assert.equal(knobTurnRefusal(plain, "Filter"), null);
});

// ── 5. THE WRITE IS AN ORDINARY PROPERTY WRITE ───────────────────────────────

test("5. a turn writes ONE flat state key at the setPreview path — no audio-specific route", () => {
  assert.deepEqual(knobWritePairs("n1", "audioCutoff", 820), [[["items", "n1", "audioCutoff"], 820]]);
  // THE KEY IS READ OFF THE RECORD, not guessed from the knob's name (BV,
  // 2026-08-03). The guess prefixed "audio" onto everything, which was right
  // while audio modules were the only widgets with dials — and would have written
  // `audioValue` into a Knob control node whose leaf is plain `value`, turning a
  // dial that changed nothing.
  assert.equal(knobStateKey({ key: "cutoff", stateKey: "audioCutoff" }), "audioCutoff");
  assert.equal(knobStateKey({ key: "value", stateKey: "value" }), "value");
});

test("5a. a record with NO stateKey is refused loudly rather than guessed at", () => {
  assert.throws(() => knobStateKey({ key: "cutoff" }), /declares no stateKey/);
});

test("5b. the key a turn writes IS the key the plugin declares as its Inspector row", () => {
  // The load-bearing join: the dial and the Inspector number field must edit the
  // SAME leaf, or turning a knob would create a second, shadow value.
  // Sweeps EVERY widget with dials, which since BV includes the control nodes.
  const bad = [];
  for (const plugin of KNOBBED) {
    const rowKeys = new Set(plugin.inspector.map((r) => r.key));
    for (const k of plugin.knobLayout({ ...plugin.defaults }))
      if (!rowKeys.has(knobStateKey(k))) bad.push(`${plugin.type}.${k.key} -> ${knobStateKey(k)}`);
  }
  assert.deepEqual(bad, [], `dials whose write key is not an Inspector row:\n    ${bad.join("\n    ")}`);
});

test("5c. …and it is a key the plugin's own DEFAULTS carry, so the write is a real leaf", () => {
  const bad = [];
  for (const plugin of KNOBBED)
    for (const k of plugin.knobLayout({ ...plugin.defaults }))
      if (!(knobStateKey(k) in plugin.defaults)) bad.push(`${plugin.type}.${k.key}`);
  assert.deepEqual(bad, [], `dials writing to a key the widget does not declare:\n    ${bad.join("\n    ")}`);
});

// ── 6. THE DRAG LAW ──────────────────────────────────────────────────────────

test("6. UP is more and down is less — the audio convention, since screen y grows down", () => {
  const knob = { min: 0, max: 100 };
  assert.ok(knobDragValue(knob, 50, -30, false) > 50, "an upward drag must increase");
  assert.ok(knobDragValue(knob, 50, 30, false) < 50, "a downward drag must decrease");
});

test("6b. the FINE modifier divides sensitivity, and both directions stay monotone", () => {
  const knob = { min: 0, max: 100 };
  const coarse = knobDragValue(knob, 0, -75, false);
  const fine = knobDragValue(knob, 0, -75, true);
  assert.ok(fine < coarse && fine > 0, `fine (${fine}) must move less than coarse (${coarse}) but still move`);
});

test("6c. the gesture is measured from the GRAB, so an end stop does not stick", () => {
  // The defect this states: an ACCUMULATING drag that clamps at maximum has to
  // unwind its whole overshoot before the knob moves again. Measured from the
  // grab, a small reversal from a huge overshoot comes straight back.
  const knob = { min: 0, max: 100 };
  assert.equal(knobDragValue(knob, 50, -10000, false), 100, "a huge upward drag pins at maximum");
  // …and the very next sample, half the span back down, is exactly half-scale
  // from the grab value rather than still pinned.
  assert.equal(knobDragValue(knob, 50, 75, false), 0);
  assert.equal(knobDragValue(knob, 50, 0, false), 50, "returning to the grab point restores the grab value");
});

test("6d. a step SNAPS and the range CLAMPS, with no float dust in the readout", () => {
  assert.equal(knobSnap(15.87, { step: 1, min: 1 }), 16);
  assert.equal(knobSnap(0.30000000000000004, { step: 0.1, min: 0 }), 0.3);
  assert.equal(knobDragValue({ min: 0, max: 16, step: 1 }, 8, -1e6, false), 16);
  assert.equal(knobDragValue({ min: 0, max: 16, step: 1 }, 8, 1e6, false), 0);
  assert.equal(knobReadout({ step: 1, unit: "" }, 16), "16");
});

// ── 7. THE PICTURE ───────────────────────────────────────────────────────────

test("7. emit() paints a dial for every laid-out knob, and the ops are pure display list", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults };
  const dials = filter.knobLayout(state);
  const ops = knobOps(dials, "#3d7a6e");
  // Four ops per dial with no transient UI: track arc, value arc, pointer, label.
  assert.equal(ops.length, dials.length * 4);
  assert.ok(ops.every((o) => typeof o.op === "string"), "every knob op must be a display-list command");
});

test("7b. the STATIC form carries no transient UI — an export cannot depend on the pointer", () => {
  // The determinism claim, stated as an assertion: emit()'s knob ops with no `ui`
  // argument are byte-identical to the ones a hovering pointer would NOT change.
  const filter = registry.get("audio_filter");
  const dials = filter.knobLayout({ ...filter.defaults });
  assert.equal(JSON.stringify(knobOps(dials, "#3d7a6e")), JSON.stringify(knobOps(dials, "#3d7a6e", {})));
  // …and a focused dial genuinely differs, so the split is doing something.
  assert.notEqual(
    JSON.stringify(knobOps(dials, "#3d7a6e")),
    JSON.stringify(knobOps(dials, "#3d7a6e", { focusKey: dials[0].key })),
  );
});

test("7c. a node's emit() is unchanged by which knob the pointer is on", () => {
  // The same claim one level up, through the real plugin: emit() takes no ui at
  // all, so there is no channel by which a hover could reach a pixel consumer.
  const filter = registry.get("audio_filter");
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const a = JSON.stringify(filter.emit({ ...filter.defaults }, null, world));
  const b = JSON.stringify(filter.emit({ ...filter.defaults }, null, world));
  assert.equal(a, b, "emit() must be a pure function of state");
});

// ── 8. THE HANDLER IS DECLARED, AND EVERY AUDIO NODE CLAIMS IT ───────────────

test("8. every audio plugin declares BOTH the trigger string and the content descriptor", () => {
  const bad = [];
  for (const plugin of AUDIO) {
    if (plugin.activate !== "knob_focus") bad.push(`${plugin.type}: activate is ${JSON.stringify(plugin.activate)}`);
    if (!KNOB_FOCUS_HANDLER.claims(plugin)) bad.push(`${plugin.type}: no knobLayout`);
  }
  assert.deepEqual(bad, [], `audio nodes that cannot be double-clicked into knob focus:\n    ${bad.join("\n    ")}`);
  assert.ok(AUDIO.length >= 23, `expected the whole audio roster, found ${AUDIO.length}`);
});

test("8b. a NON-node widget claims nothing — the mode is opt-in by declaration", () => {
  assert.equal(KNOB_FOCUS_HANDLER.claims(registry.get("rect")), false);
  assert.notEqual(registry.get("rect").activate, "knob_focus");
});

// ── 9. THE PRESS VERDICTS THE HOST ACTS ON ───────────────────────────────────

test("9. onPick returns 'release' for a bead, 'drag' for a dial, and exits elsewhere", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults };
  const dial = filter.knobLayout(state)[0];
  let exited = 0;
  const app = { displayName: () => "Filter", exitCanvasMode: () => { exited += 1; }, setPreview: () => {} };
  const ctx = { app, node: { itemId: "n1", state }, plugin: filter };
  const pick = (x, y) => ({ local: { x, y }, world: { x, y }, node: null });

  assert.equal(KNOB_FOCUS_HANDLER.mode.onPick(ctx, pick(0, 34)), "release", "a bead press falls through to the wire layer");
  assert.equal(exited, 0, "a bead press must NOT leave knob focus");
  assert.equal(KNOB_FOCUS_HANDLER.mode.onPick(ctx, pick(dial.cx, dial.cy)), "drag");
  assert.equal(KNOB_FOCUS_HANDLER.mode.onPick(ctx, pick(state.w / 2, 30)), undefined);
  assert.equal(exited, 1, "a press on the node's body leaves the mode");
});

test("9b. a turn stages exactly one property write, and a no-op move stages nothing", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults };
  const dial = filter.knobLayout(state).find((k) => k.key === "Q");
  const writes = [];
  const app = { displayName: () => "Filter", exitCanvasMode: () => {}, setPreview: (p) => writes.push(p) };
  const ctx = { app, node: { itemId: "n1", state }, plugin: filter };
  KNOB_FOCUS_HANDLER.mode.onPick(ctx, { local: { x: dial.cx, y: dial.cy }, world: {}, node: null });
  // A move that lands on the same value writes nothing — the per-pixel
  // invalidation the hover hook is careful to avoid, one gesture over.
  KNOB_FOCUS_HANDLER.mode.onPan(ctx, { localX: dial.cx, localY: dial.cy, fine: false });
  assert.equal(writes.length, 0, "a zero-travel move must not stage a preview");
  KNOB_FOCUS_HANDLER.mode.onPan(ctx, { localX: dial.cx, localY: dial.cy - 40, fine: false });
  assert.equal(writes.length, 1, "a real move stages exactly one preview");
  assert.deepEqual(writes[0][0][0], ["items", "n1", "audioQ"]);
  assert.ok(writes[0][0][1] > dial.value, "an upward drag increased the value");
});

test("9c. a BOUND knob's press is refused: no drag opens and nothing is written", () => {
  const filter = registry.get("audio_filter");
  const state = { ...filter.defaults, audioQ: "= ease(time)" };
  const dial = filter.knobLayout(state).find((k) => k.key === "Q");
  const writes = [];
  let exited = 0;
  const app = { displayName: () => "Filter", exitCanvasMode: () => { exited += 1; }, setPreview: (p) => writes.push(p) };
  const ctx = { app, node: { itemId: "n1", state }, plugin: filter };
  const verdict = KNOB_FOCUS_HANDLER.mode.onPick(ctx, { local: { x: dial.cx, y: dial.cy }, world: {}, node: null });
  assert.equal(verdict, undefined, "a refused knob must not open a drag");
  assert.equal(writes.length, 0, "a refused knob must not write");
  assert.equal(exited, 0, "…and must not silently leave the mode either");
});

console.log(`\nknob_focus_test: ${passed} passed`);
