/**
 * "Natural zoom" — THE COUPLING'S OWN SWITCH (WORKSTREAM BI). Plain node, no
 * framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/natural_zoom_test.js
 *
 * User ruling, 2026-08-02 night, verbatim, answering WORKSTREAM BG's flagged
 * judgment call: "It is important that we follow the Mandelbrot zoom pan type,
 * but it has to be smoothly carried over into the interface, however it works. If
 * we have to make a tool for it to make sure that several settings are set
 * simultaneously, so be it, by default it will be on for camera."
 *
 * BG shipped the coupled zoom-pan law with NO control and no mention of itself:
 * plugins/camera.js interpolateCameraState silently replaced the pan while the
 * four per-axis interp dropdowns went on naming a mode that was not what rendered.
 * This suite pins the interface that makes it a stated setting.
 *
 * WHAT THIS PINS, and why each matters:
 *
 *   (1) DEFAULT ON, in the plugin literal AND in a fresh document — the ruling's
 *       literal ask ("by default it will be on for camera"), asserted in both
 *       places because they are two different literals that have drifted before
 *       (core/document.js's docblock records the cruft audit that reconciled them).
 *   (2) ABSENT MEANS ON. Every document written before this switch existed
 *       rendered under the coupling, so a missing key MUST read as ON. Reading it
 *       as OFF would silently re-cut every deck that moves its camera — which is
 *       the whole class of bug the switch was added to make visible, inverted.
 *   (3) OFF RESTORES INDEPENDENT PER-AXIS BEHAVIOUR, asserted as a MEASUREMENT
 *       (the divergence between coupled and per-leaf reappears) rather than as a
 *       spot value, because "the four dropdowns govern alone" is a claim about
 *       behaviour and not about one number.
 *   (4) ENDPOINTS ARE BYTE-IDENTICAL IN BOTH STATES. The fold calls blend at
 *       alpha 1 on every slide, so a switch that moved an endpoint would rewrite
 *       the document's own stored frames in every cached state and every export.
 *       This is the single most important assertion here: it is what makes the
 *       switch safe to flip on an existing deck.
 *   (5) THE DROPDOWNS DO NOT LIE — and the honest form was MEASURED, not assumed.
 *       `w` is byte-identical to what its own dropdown claims at EVERY alpha, and
 *       `h` is too whenever the aspect is preserved; only x/y are overridden. So
 *       only x/y carry the note, and the pins assert BOTH directions (present on
 *       the liars, absent on the honest rows) — a note on `w` would be as wrong
 *       as no note on `x`.
 *   (6) THE COMMAND IS THE SAME STATE IN A SECOND SURFACING. It toggles the same
 *       leaf the checkbox writes, and its gate answers with a DIFFERENT sentence
 *       for each of its two disqualifying conditions (core/registry.js's rule for
 *       a function `requires`).
 *   (7) A STORED EXPLICIT COMPANION IS UNTOUCHED BY ANY OF THIS. The switch
 *       governs whether the coupling runs; it never rewrites an author's modes.
 *
 * DOM-free (core/ + one plugin's pure hook + one pure row builder), so it runs in
 * bare node — which is also what proves the CLI and both exporters see the same
 * law, since all three reach it through the same pure interpolateCameraState.
 */

import assert from "node:assert/strict";
import { newDocument, defaultCameraState } from "../core/document.js";
import { interpRowFor } from "../core/properties.js";
import { expLerp, interpKeyFor, EXP_TWEEN_MODE } from "../core/interp_modes.js";
import {
  cameraPlugin, interpolateCameraState, naturalZoomOn,
  NATURAL_ZOOM_KEY, NATURAL_ZOOM_DEFAULT, COUPLED_PAN_KEYS,
} from "../plugins/camera.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// THE FIXTURE the whole suite measures against: a deep zoom onto an off-centre
// point — 1280 → 4 (a 320× zoom) toward x = 9000. This is BG's own measurement
// pair, reused deliberately so the two suites are talking about one picture.
const FROM = { x: 0, y: 0, w: 1280, h: 720 };
const TO_ON = { x: 9000, y: 0, w: 4, h: 2.25 };
const TO_OFF = { ...TO_ON, [NATURAL_ZOOM_KEY]: false };
const FRAME_KEYS = ["x", "y", "w", "h"];

/** The per-leaf answer the four dropdowns describe on their own — Exp Tween where
 *  it has a geometric path, its documented linear fallback where it does not
 *  (x starts at 0, which is a zero endpoint). This is what OFF must produce. */
function perLeafFrame(from, to, alpha) {
  const out = {};
  for (const k of FRAME_KEYS) {
    const a = from[k], b = to[k];
    const geometric = a !== 0 && b !== 0 && Math.sign(a) === Math.sign(b);
    out[k] = geometric ? expLerp(a, b, alpha) : a + (b - a) * alpha;
  }
  return out;
}

// ── (1) DEFAULT ON ────────────────────────────────────────────────────────────

test('the camera literal is born with the switch ON (the ruling\'s "by default")', () => {
  assert.equal(defaultCameraState()[NATURAL_ZOOM_KEY], true);
  assert.equal(NATURAL_ZOOM_DEFAULT, true);
});

test("a FRESH DOCUMENT's camera carries it too (not just the plugin default)", () => {
  const cam = Object.values(newDocument().slides[0].delta.items)[0];
  assert.equal(cam.type, "camera");
  assert.equal(cam[NATURAL_ZOOM_KEY], true);
});

test("the plugin's own `defaults` agree — the two literals have drifted before", () => {
  assert.equal(cameraPlugin.defaults[NATURAL_ZOOM_KEY], true);
});

// ── (2) ABSENT MEANS ON — the pre-BI compatibility law ───────────────────────

test("ABSENT reads as ON, so every pre-BI document renders unchanged", () => {
  assert.equal(naturalZoomOn({}), true);
  assert.equal(naturalZoomOn(undefined), true);
  // and it is not merely the predicate: the LAW must actually run.
  const noKey = { x: 9000, y: 0, w: 4, h: 2.25 };
  const explicit = { ...noKey, [NATURAL_ZOOM_KEY]: true };
  assert.deepEqual(interpolateCameraState(FROM, noKey, 0.25),
    interpolateCameraState(FROM, explicit, 0.25));
});

test("ONLY an explicit `false` turns it off (a stray string is not an off switch)", () => {
  assert.equal(naturalZoomOn({ [NATURAL_ZOOM_KEY]: false }), false);
  assert.equal(naturalZoomOn({ [NATURAL_ZOOM_KEY]: true }), true);
  // A hand-edited document with an equation string in the slot reads as ON — the
  // safe reading of a malformed switch is the one every other document gets.
  assert.equal(naturalZoomOn({ [NATURAL_ZOOM_KEY]: "= 1" }), true);
});

// ── (3) OFF RESTORES THE PER-AXIS LAW, measured ──────────────────────────────

test("OFF: the hook stands down entirely, so the four dropdowns govern alone", () => {
  for (const a of [0.1, 0.25, 0.5, 0.75, 0.9])
    assert.deepEqual(interpolateCameraState(FROM, TO_OFF, a), {},
      `alpha ${a}: an uncoupled camera must return NO overrides at all`);
});

test("THE ACCEPTANCE, both directions: the divergence REAPPEARS when it is off", () => {
  // ON, the coupled pan is far from the per-leaf one — that IS the coupling.
  // OFF, the rendered frame must BE the per-leaf one, to the bit.
  const ALPHA = 0.25;
  const perLeaf = perLeafFrame(FROM, TO_ON, ALPHA);
  const coupled = interpolateCameraState(FROM, TO_ON, ALPHA);
  assert.ok(Math.abs(coupled.x - perLeaf.x) > 1000,
    `ON: the coupled pan must differ from the per-leaf one (got ${coupled.x} vs ${perLeaf.x})`);
  // OFF returns {}, so the frame the fold renders IS perLeaf by construction.
  assert.deepEqual(interpolateCameraState(FROM, TO_OFF, ALPHA), {});
});

test("THE PICTURE: on-screen while coupled, off-screen while not — the user's ask", () => {
  // The zoom target's distance from the frame centre, in half-widths. |d| ≤ 1 is
  // on screen. This is BG's own acceptance measurement, now asserted for BOTH
  // switch states — which is what makes the switch's meaning observable.
  const targetX = TO_ON.x + TO_ON.w / 2;
  const offsets = { on: [], off: [] };
  for (const a of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const on = interpolateCameraState(FROM, TO_ON, a);
    offsets.on.push(Math.abs(targetX - (on.x + on.w / 2)) / (on.w / 2));
    const off = perLeafFrame(FROM, TO_ON, a);
    offsets.off.push(Math.abs(targetX - (off.x + off.w / 2)) / (off.w / 2));
  }
  // Coupled: monotonically approaching, never swinging away.
  for (let i = 1; i < offsets.on.length; i++)
    assert.ok(offsets.on[i] < offsets.on[i - 1],
      `coupled offsets must decrease monotonically, got ${JSON.stringify(offsets.on)}`);
  // Uncoupled: it swings HUNDREDS of half-widths away mid-transition. That is the
  // "it curved around and it was weird" the coupling exists to kill, and turning
  // the switch off is now the documented way to get it back.
  assert.ok(Math.max(...offsets.off) > 100,
    `uncoupled must swing far off screen, peaked at ${Math.max(...offsets.off)}`);
});

// ── (4) ENDPOINTS ARE BYTE-IDENTICAL IN BOTH STATES ─────────────────────────

test("ENDPOINTS EXACT with the switch ON and OFF alike (the fold folds through this)", () => {
  for (const [label, to] of [["ON", TO_ON], ["OFF", TO_OFF]]) {
    for (const [alpha, want] of [[0, FROM], [1, to]]) {
      const got = interpolateCameraState(FROM, to, alpha);
      // `{}` (defer to the exact stored leaves) and an explicit exact answer are
      // both correct; what is forbidden is a DIFFERENT number.
      for (const k of FRAME_KEYS)
        if (k in got)
          assert.equal(got[k], want[k], `${label} alpha ${alpha}: ${k} moved off its stored value`);
    }
  }
});

test("flipping the switch changes NO endpoint — safe to toggle on an existing deck", () => {
  for (const alpha of [0, 1]) {
    const on = interpolateCameraState(FROM, TO_ON, alpha);
    const off = interpolateCameraState(FROM, TO_OFF, alpha);
    for (const k of FRAME_KEYS) {
      const onV = k in on ? on[k] : (alpha === 0 ? FROM : TO_ON)[k];
      const offV = k in off ? off[k] : (alpha === 0 ? FROM : TO_OFF)[k];
      assert.equal(onV, offV, `alpha ${alpha}: ${k} differs between the two switch states`);
    }
  }
});

// ── (5) THE DROPDOWNS DO NOT LIE, and the measurement says which ones could ──

test("MEASURED: the coupled `w` IS what its own dropdown claims, at every alpha", () => {
  // This is why `w` carries no note. Swept finely, over a proportional pair and a
  // non-proportional one alike: the coupling's width term literally IS expLerp.
  for (const to of [TO_ON, { x: 9000, y: 0, w: 4, h: 400 }])
    for (let a = 0.005; a < 1; a += 0.005) {
      const c = interpolateCameraState(FROM, to, a);
      assert.equal(c.w, expLerp(FROM.w, to.w, a),
        `w must equal Exp Tween exactly at alpha ${a}`);
    }
});

test("MEASURED: `h` agrees too while the aspect holds, and diverges when it changes", () => {
  // Proportional — honest, exactly.
  for (let a = 0.005; a < 1; a += 0.005)
    assert.ok(Math.abs(interpolateCameraState(FROM, TO_ON, a).h - expLerp(FROM.h, TO_ON.h, a)) < 1e-9);
  // Aspect CHANGES — `h` rides `w`'s lam so the frame is one motion, which is a
  // real divergence from its dropdown. Pinned as a fact, not as a target: if a
  // future change makes `h` independent, this test is the thing that says the
  // note-carrying row set must be revisited.
  const skew = { x: 9000, y: 0, w: 4, h: 400 };
  let worst = 0;
  for (let a = 0.005; a < 1; a += 0.005) {
    const want = expLerp(FROM.h, skew.h, a);
    worst = Math.max(worst, Math.abs(interpolateCameraState(FROM, skew, a).h - want) / want);
  }
  assert.ok(worst > 0.1, `a changed aspect must visibly diverge, got ${(worst * 100).toFixed(1)}%`);
});

test("ONLY the two overridden axes carry the interp note — both directions", () => {
  assert.deepEqual(COUPLED_PAN_KEYS, ["x", "y"]);
  for (const key of FRAME_KEYS) {
    const row = cameraPlugin.inspector.find((r) => r.key === key);
    const shouldNote = COUPLED_PAN_KEYS.includes(key);
    assert.equal(!!row.interpNote, shouldNote,
      `${key}: ${shouldNote ? "must" : "must NOT"} carry the note — a note on an honest row is as wrong as none on a liar`);
  }
});

test("the note REACHES the dropdown's help, and names what outranks the mode", () => {
  const xRow = cameraPlugin.inspector.find((r) => r.key === "x");
  const help = interpRowFor(xRow, 0, "camera").help;
  assert.ok(help.includes("Exp Tween"), "it must still describe the mode it names");
  assert.ok(help.includes("NATURAL ZOOM OVERRIDES THIS"), "and say what outranks it");
  // The honest rows' help is untouched — no other row in the app gains a word.
  const wHelp = interpRowFor(cameraPlugin.inspector.find((r) => r.key === "w"), 1280, "camera").help;
  assert.ok(!wHelp.includes("NATURAL ZOOM OVERRIDES"));
  assert.equal(interpRowFor({ key: "x", label: "X" }, 5).help.includes("NATURAL ZOOM"), false,
    "a row that declares no interpNote is unchanged by a character");
});

test("the switch is a ROW: boolean, in Transform, above the frame it governs", () => {
  const rows = cameraPlugin.inspector;
  const i = rows.findIndex((r) => r.key === NATURAL_ZOOM_KEY);
  assert.ok(i >= 0, "the camera must declare the row");
  assert.equal(rows[i].kind, "boolean");
  assert.equal(rows[i].category, "transform");
  assert.equal(rows[i].default, true);
  assert.ok(rows[i].help.length > 80, "a switch nobody can explain is the defect this fixes");
  // ABOVE x/y/w/h — a reader meets the qualifier before the rows it qualifies.
  assert.ok(i < rows.findIndex((r) => r.key === "x"));
});

// ── (6) THE COMMAND: the same state in a second surfacing ───────────────────

test("the palette command exists, is gated on THE camera, and says why when it is not", () => {
  const cmd = cameraPlugin.commands.find((c) => c.id === "toggle-natural-zoom");
  assert.ok(cmd, "the command registry is the single action layer — it must be there");
  assert.equal(cmd.when({ selectedNode: () => ({ state: { type: "camera" } }) }), true);
  assert.equal(cmd.when({ selectedNode: () => ({ state: { type: "rect" } }) }), false);
  assert.equal(cmd.when({ selectedNode: () => null }), false);
  // A FUNCTION `requires` per core/registry.js's rule: two disqualifying
  // conditions, two different true sentences. A fixed string would be a
  // confident wrong answer for whichever case did not apply.
  assert.equal(typeof cmd.requires, "function");
  const noSel = cmd.requires({ selection: null });
  const wrongSel = cmd.requires({ selection: "some-id" });
  assert.notEqual(noSel, wrongSel, "the two gates must not answer with one sentence");
  assert.ok(noSel.includes("selection"));
  assert.ok(wrongSel.includes("camera"));
});

test("the command TOGGLES the same leaf the checkbox writes, as ONE undo unit", () => {
  const cmd = cameraPlugin.commands.find((c) => c.id === "toggle-natural-zoom");
  // A minimal app double: the two calls the write seam is made of.
  function appWith(state) {
    const calls = [];
    return {
      calls,
      selection: "cam",
      selectedNode: () => ({ id: "cam", state }),
      setPreview: (pairs) => calls.push(["setPreview", pairs]),
      commitPreview: () => calls.push(["commitPreview"]),
    };
  }
  for (const [state, want] of [[{}, false], [{ [NATURAL_ZOOM_KEY]: true }, false], [{ [NATURAL_ZOOM_KEY]: false }, true]]) {
    const app = appWith(state);
    cmd.run(app);
    assert.deepEqual(app.calls[0], ["setPreview", [[["items", "cam", NATURAL_ZOOM_KEY], want]]],
      `from ${JSON.stringify(state)} the command must write ${want}`);
    assert.deepEqual(app.calls[1], ["commitPreview"], "exactly one commit = one undo unit");
    assert.equal(app.calls.length, 2);
  }
});

// ── (7) STORED EXPLICIT COMPANIONS ARE NEVER REWRITTEN ──────────────────────

test("the switch never touches an author's stored interp modes, in either state", () => {
  // An author who set x to plain Tween keeps it, coupled or not: the switch says
  // whether the coupling RUNS, and has no opinion about the dropdowns' values.
  const authored = { ...TO_ON, [interpKeyFor("x")]: "tween", [interpKeyFor("w")]: "step" };
  for (const nz of [true, false]) {
    const to = { ...authored, [NATURAL_ZOOM_KEY]: nz };
    interpolateCameraState(FROM, to, 0.5);
    assert.equal(to[interpKeyFor("x")], "tween");
    assert.equal(to[interpKeyFor("w")], "step");
  }
  // And the born-with defaults are still the ruling's, untouched by BI.
  for (const k of FRAME_KEYS)
    assert.equal(defaultCameraState()[interpKeyFor(k)], EXP_TWEEN_MODE);
});

test("an explicitly-stored companion + the switch OFF is the fully manual camera", () => {
  // The stated OFF contract: nothing overrides, so what renders is exactly the
  // per-leaf law each dropdown names. Asserted through the hook's silence, which
  // is the only way the fold can hear it.
  const manual = { ...TO_ON, [NATURAL_ZOOM_KEY]: false, [interpKeyFor("x")]: "tween" };
  for (const a of [0.1, 0.5, 0.9])
    assert.deepEqual(interpolateCameraState(FROM, manual, a), {});
});

// ── The degenerate cases the coupling already refused keep refusing ─────────

test("OFF does not resurrect any case the coupling already declined", () => {
  const cases = [
    ["no zoom", { x: 0, y: 0, w: 100, h: 100 }, { x: 9, y: 0, w: 100, h: 100 }],
    ["equation-bound", { x: "= 1 + 1", y: 0, w: 100, h: 50 }, { x: 9, y: 0, w: 1, h: 0.5 }],
    ["zero width", { x: 0, y: 0, w: 0, h: 50 }, { x: 9, y: 0, w: 1, h: 0.5 }],
  ];
  for (const [label, from, to] of cases) {
    assert.deepEqual(interpolateCameraState(from, to, 0.5), {}, `${label}: ON`);
    assert.deepEqual(interpolateCameraState(from, { ...to, [NATURAL_ZOOM_KEY]: false }, 0.5), {}, `${label}: OFF`);
  }
});

test("NEVER NaN, over a sweep crossing both switch states and every degenerate pair", () => {
  const vals = [-100, -1, 0, 1, 100, 9000];
  for (const nz of [true, false, undefined])
    for (const wa of vals) for (const wb of vals) for (const xa of vals) for (const xb of vals) {
      const to = { x: xb, y: 0, w: wb, h: Math.abs(wb) || 1 };
      if (nz !== undefined) to[NATURAL_ZOOM_KEY] = nz;
      const out = interpolateCameraState({ x: xa, y: 0, w: wa, h: Math.abs(wa) || 1 }, to, 0.5);
      for (const [k, v] of Object.entries(out))
        assert.ok(Number.isFinite(v), `NaN/Infinity in ${k} for nz=${nz} w ${wa}→${wb} x ${xa}→${xb}`);
    }
});

// ── ONE LAW, EVERY RENDER PATH ──────────────────────────────────────────────

test("the switch reaches EVERY renderer, because they share one fold", () => {
  // Not an integration test — a STRUCTURAL one, and that is the stronger claim.
  // The editor, cli/render.js, gpuService (thumbnails / minimap / PNG export) and
  // the video path all derive pixels through web/cameraFrame.js, which folds with
  // core/document.tweenedState, which is the ONLY caller of a plugin's
  // interpolateState. So a switch honoured in the hook is honoured in all of
  // them by construction, and the way to break that is to add a SECOND fold —
  // which is what this asserts against.
  assert.equal(typeof cameraPlugin.interpolateState, "function");
  assert.equal(cameraPlugin.interpolateState, interpolateCameraState,
    "the camera's declared hook must BE the function this suite measured; a "
    + "second entry point is how a headless render would drift from the editor");
});

console.log(`\n${passed} Natural zoom tests passed`);
