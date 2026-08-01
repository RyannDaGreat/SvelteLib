/**
 * ANALOG CLOCK PLUGIN ASSET — bare-node tests.
 *
 * WHAT THIS GUARDS, in the order the properties matter.
 *
 * 1. THE BYTE-IDENTICAL GATE, and it is the reason this file exists. The clock
 *    grew a PRESET MODEL: every style row now defaults to an INHERIT sentinel and
 *    emit() resolves preset → value on each render. That is a rewrite of the path
 *    every pixel takes, so the one property that proves it did not change the
 *    PICTURE is that emit() at all-defaults deep-equals what it produced before
 *    any of it existed. The expected op list is FROZEN below as data, not
 *    recomputed from the plugin — a gate that regenerates its own baseline
 *    guards nothing.
 *
 *    This already caught a real regression while being written. A tick's inner
 *    fraction used to be a literal (0.86 / 0.92) and became `outer - length`;
 *    0.97 - 0.05 is 0.9199999999999999, not 0.92, so every minor tick moved by
 *    ~1e-14. Invisible, and a `toFixed(3)` comparison would have passed it — which
 *    is exactly why this asserts EXACT equality on the whole op list.
 *
 * 2. WINDING, the user-visible behaviour the handles exist for: "when I drag the
 *    second hand around 360, the minute hand should advance by one; around again,
 *    by two — exactly like the rotation property." That is a statement about
 *    ACCUMULATION, so it is tested by driving the handle through MANY small steps
 *    the way a pointer actually moves, and asserting the TOTAL. A test that jumped
 *    straight to the target angle would pass even with the old teleporting code.
 *    Backwards unwinding and the no-snap-at-wrap property are asserted the same
 *    way.
 *
 *    The handle is driven through core/derive.js `modifierWrite`
 *    (constrain-then-apply) — the same protocol CanvasView drives it with — and
 *    the returned write is FED BACK into the state before the next step, which is
 *    what reproduces the stateless-gesture-memory the widget relies on (the
 *    hand's own angle IS the memory; see the plugin's docblock).
 *
 * 3. The new style rows and numeral kinds actually reach the display list: roman
 *    numerals use the clockmaker's IIII, "none" emits NO text ops at all (not
 *    empty ones), minor ticks disappear on toggle, and taper/bezel promote a hand
 *    from a polyline to convex polygons.
 *
 * Bare node, no DOM, no GPU: the clock is property state throughout (CLAUDE.md's
 * three kinds of state), which is what lets it be tested this way.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginAsset } from "../core/plugin_assets.js";
import { modifierWrite } from "../core/derive.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../assets/builtin/library/clock_analog.plugin.js"), "utf8");

let passed = 0;
/**
 * Runs one check. AWAITS the body, which is load-bearing rather than tidy: a
 * synchronous `fn()` would DISCARD the promise of an async test, so its assertions
 * would reject unobserved and the test would print "ok" having verified nothing.
 * (The parity check below is async — it dynamically imports the retired module.)
 * Every call site is awaited in turn, so the log order still matches the file.
 */
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The loaded plugin, through the real jail — the same path a project load takes. */
const clock = loadPluginAsset(SOURCE, "clock_analog.plugin.js", new Set());
/** Identity world: applyEffects needs one, and with every effect off it is pass-through. */
const WORLD = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A default clock at time `t`. */
const at = (t, extra = {}) => ({ ...clock.defaults, time: t, ...extra });
const emit = (s) => clock.emit(s, null, WORLD);
const opsOf = (s) => emit(s).map((o) => o.op);

// ── 1. THE BYTE-IDENTICAL GATE ───────────────────────────────────────────────

await test("all-defaults emit is the frozen op SHAPE (77 ops: face + 60 ticks + 12 numerals + 3 hands + hub)", () => {
  const ops = opsOf(at(0));
  assert.equal(ops.length, 77);
  assert.equal(ops[0], "ellipse");                                   // face
  assert.deepEqual(ops.slice(1, 61), Array(60).fill("polyline"));    // 60 ticks
  assert.deepEqual(ops.slice(61, 73), Array(12).fill("text"));       // 12 numerals
  assert.deepEqual(ops.slice(73, 76), Array(3).fill("polyline"));    // 3 hands, NOT polygons
  assert.equal(ops[76], "ellipse");                                  // hub
});

await test("all-defaults emit is BYTE-IDENTICAL to the frozen pre-preset geometry", () => {
  // Frozen samples, captured from the widget BEFORE the preset model existed.
  // Exact equality, no rounding: the ~1e-14 tick drift this caught was invisible
  // to any tolerance a reasonable person would have picked.
  const ops = emit(at(0));

  // The face.
  assert.deepEqual(
    { cx: ops[0].cx, cy: ops[0].cy, rx: ops[0].rx, ry: ops[0].ry, strokeWidth: ops[0].strokeWidth },
    { cx: 110, cy: 110, rx: 110, ry: 110, strokeWidth: 3 },
  );

  // Tick 0 (major, straight up) — outer 0.97R to inner 0.86R, width 3.
  assert.deepEqual(ops[1].points, [[110, 110 - 110 * 0.97], [110, 110 - 110 * 0.86]]);
  assert.equal(ops[1].width, 3);

  // The MINOR tick inner fraction must be EXACTLY 0.92. This is the value the
  // float regression moved: computed as 0.97 - 0.05 it is 0.9199999999999999.
  // Recovered as a ratio against the same tick's OUTER point, so the shared trig
  // factor divides out and what remains is the fraction itself — no tolerance,
  // and no dependence on which angle the sampled tick happens to sit at.
  assert.equal(ops[2].width, 1.5);
  const minorTick = ops[2];                       // index 1 → 6°, a minor tick
  const outerY = minorTick.points[0][1] - 110;
  const innerY = minorTick.points[1][1] - 110;
  assert.equal((innerY / outerY) * 0.97, 0.92);

  // Numerals: arabic, on the 0.78R ring, "12" last in the 1..12 order.
  assert.equal(ops[61].text, "1");
  assert.equal(ops[72].text, "12");
  assert.equal(ops[72].size, 20);

  // Hands at t=0 all point straight up, from the center, at the frozen widths.
  assert.deepEqual(ops[73].points, [[110, 110], [110, 110 - 110 * 0.5]]);   // hour
  assert.equal(ops[73].width, 7);
  assert.deepEqual(ops[74].points, [[110, 110], [110, 110 - 110 * 0.72]]);  // minute
  assert.equal(ops[74].width, 5);
  assert.deepEqual(ops[75].points, [[110, 110], [110, 110 - 110 * 0.85]]);  // second
  assert.equal(ops[75].width, 2);

  // The hub.
  assert.deepEqual({ rx: ops[76].rx, ry: ops[76].ry }, { rx: 6, ry: 6 });
});

await test("the INHERIT sentinel and an explicit override that EQUALS the preset agree exactly", () => {
  // Pinning a row to the value it was already inheriting must not perturb one bit
  // — otherwise "touch a row, put it back" would silently alter the render.
  const inherited = emit(at(1234));
  const pinned = emit(at(1234, {
    majorTickWidth: 3, majorTickLength: 0.11, minorTickWidth: 1.5, minorTickLength: 0.05,
    showMinorTicks: true, numerals: "arabic", numeralInset: 0.19,
    secondHandTaper: 0, handBezel: 0,
    hourHandWidth: 7, minuteHandWidth: 5, secondHandWidth: 2,
  }));
  assert.deepEqual(pinned, inherited);
});

await test("a preset is DERIVED, not written: switching preset changes the render, state keeps its sentinels", () => {
  const roman = at(0, { preset: "roman" });
  // The item still holds INHERIT for every style row — nothing was splatted in.
  assert.equal(roman.numerals, "");
  assert.equal(roman.majorTickWidth, "");
  // …yet the picture is the roman dial.
  assert.ok(emit(roman).some((o) => o.op === "text" && o.text === "IIII"));
});

// ── 2. WINDING ───────────────────────────────────────────────────────────────

/**
 * Drives the SECOND-hand tip handle through `steps` evenly-spaced pointer
 * positions sweeping `totalDeg` from the hand's current angle, exactly as a
 * pointer drag would, feeding each write back into the state.
 *
 * @returns {object} the final state
 */
function dragSecondHand(state, totalDeg, steps) {
  const R = Math.min(state.w, state.h) / 2;
  const cx = state.w / 2, cy = state.h / 2;
  const startDeg = (state.time / 60) * 360;
  let s = { ...state };
  for (let i = 1; i <= steps; i++) {
    const deg = startDeg + (totalDeg * i) / steps;
    const rad = (deg * Math.PI) / 180;
    // The pointer, in LOCAL space, at the hand's own radius.
    const target = { x: cx + R * 0.85 * Math.sin(rad), y: cy - R * 0.85 * Math.cos(rad) };
    const point = clock.modifierPoints(s).find((p) => p.id === "secondTip");
    s = { ...s, ...modifierWrite(point, s, target) };
  }
  return s;
}

await test("ONE full sweep of the second hand advances the MINUTE hand by exactly one", () => {
  const end = dragSecondHand(at(0), 360, 36); // 10° per step, like a real drag
  assert.ok(Math.abs(end.time - 60) < 1e-9, `expected 60 s, got ${end.time}`);
  // The user's actual sentence: the minute hand moved one minute.
  const minutesBefore = (0 / 3600) * 60;
  const minutesAfter = (end.time / 3600) * 60;
  assert.ok(Math.abs((minutesAfter - minutesBefore) - 1) < 1e-9);
});

await test("TWO full sweeps advance the minute hand by exactly two (accumulation, not modulo)", () => {
  const end = dragSecondHand(at(0), 720, 72);
  assert.ok(Math.abs(end.time - 120) < 1e-9, `expected 120 s, got ${end.time}`);
});

await test("sweeping BACKWARDS unwinds — and can carry the time negative", () => {
  const end = dragSecondHand(at(120), -360, 36);
  assert.ok(Math.abs(end.time - 60) < 1e-9, `expected 60 s, got ${end.time}`);
  const past = dragSecondHand(at(0), -360, 36);
  assert.ok(Math.abs(past.time + 60) < 1e-9, `expected -60 s, got ${past.time}`);
});

await test("NO SNAP at the wrap: crossing 12 is monotonic, one step at a time", () => {
  // The old band-preserving code made :59 → :01 REWIND the minute. Here every
  // step must move time forward, with no discontinuity anywhere near the wrap.
  let s = at(55);
  let previous = s.time;
  for (let i = 0; i < 20; i++) {
    s = dragSecondHand(s, 30, 1); // 30° = 5 s per step, straight through 12
    assert.ok(s.time > previous, `time went BACKWARDS across the wrap: ${previous} → ${s.time}`);
    assert.ok(s.time - previous < 10, `discontinuous jump at the wrap: ${previous} → ${s.time}`);
    previous = s.time;
  }
  assert.ok(s.time > 60, "the sweep should have carried past a whole minute");
});

await test("a hand drag also writes its own LENGTH (the two-degree-of-freedom handle)", () => {
  const s = at(0);
  const point = clock.modifierPoints(s).find((p) => p.id === "minuteTip");
  // Drag the minute tip to 3 o'clock at HALF the face radius.
  const out = modifierWrite(point, s, { x: 110 + 55, y: 110 });
  assert.ok(Math.abs(out.minuteHandLength - 0.5) < 1e-9, `length ${out.minuteHandLength}`);
  assert.ok(Math.abs(out.time - 900) < 1e-9, `time ${out.time}`); // quarter hour
});

await test("the hour hand winds on its own 12-hour period", () => {
  const s = at(0);
  const point = clock.modifierPoints(s).find((p) => p.id === "hourTip");
  const out = modifierWrite(point, s, { x: 110 + 55, y: 110 }); // 3 o'clock
  assert.ok(Math.abs(out.time - 10800) < 1e-9, `expected 3 h, got ${out.time}`);
});

await test("the second-hand handle is absent when the second hand is hidden", () => {
  const ids = clock.modifierPoints(at(0, { showSecondHand: false })).map((p) => p.id);
  assert.deepEqual(ids, ["hourTip", "minuteTip"]);
});

// ── 3. THE NEW STYLE ROWS REACH THE DISPLAY LIST ─────────────────────────────

await test("roman numerals draw IIII (the clockmaker's four), never IV", () => {
  const texts = emit(at(0, { numerals: "roman" })).filter((o) => o.op === "text").map((o) => o.text);
  assert.deepEqual(texts, ["I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]);
  assert.ok(!texts.includes("IV"));
});

await test('numerals "none" emits NO text ops at all (not empty ones)', () => {
  assert.equal(emit(at(0, { numerals: "none" })).filter((o) => o.op === "text").length, 0);
});

await test("hiding minor ticks leaves exactly the 12 hour ticks", () => {
  const s = at(0, { showMinorTicks: false, numerals: "none" });
  assert.equal(emit(s).filter((o) => o.op === "polyline").length, 12 + 3); // ticks + 3 hands
});

await test("tick thickness and length rows reach the ops", () => {
  const ops = emit(at(0, { majorTickWidth: 9, majorTickLength: 0.4, showMinorTicks: false }));
  const tick = ops.filter((o) => o.op === "polyline")[0];
  assert.equal(tick.width, 9);
  const outer = Math.hypot(tick.points[0][0] - 110, tick.points[0][1] - 110);
  const inner = Math.hypot(tick.points[1][0] - 110, tick.points[1][1] - 110);
  assert.ok(Math.abs((outer - inner) - 110 * 0.4) < 1e-9, "tick length should be 0.4R");
});

await test("numeral inset moves the numeral ring inward", () => {
  const near = emit(at(0, { numeralInset: 0.05 })).filter((o) => o.op === "text")[11]; // "12", straight up
  const far = emit(at(0, { numeralInset: 0.45 })).filter((o) => o.op === "text")[11];
  assert.ok(far.y > near.y, "a larger inset should pull the numeral toward the center");
});

await test("taper promotes the second hand from a polyline to a convex polygon", () => {
  const ops = emit(at(0, { secondHandTaper: 1, numerals: "none", showTicks: false }));
  const polys = ops.filter((o) => o.op === "polygon");
  assert.equal(polys.length, 1, "only the second hand should taper");
  assert.equal(polys[0].points.length, 4);
  // A full taper brings both tip corners to the same point.
  assert.deepEqual(polys[0].points[1], polys[0].points[2]);
});

await test("bezel adds a highlight polygon over each of the hour and minute hands", () => {
  const ops = emit(at(0, { handBezel: 0.5, numerals: "none", showTicks: false }));
  // hour body + hour bezel + minute body + minute bezel = 4 polygons; the second
  // hand keeps its polyline (bezel is the hour/minute chamfer).
  assert.equal(ops.filter((o) => o.op === "polygon").length, 4);
  assert.equal(ops.filter((o) => o.op === "polyline").length, 1);
});

await test("every preset loads, emits, and is a complete style vector", () => {
  const keys = ["majorTickWidth", "majorTickLength", "minorTickWidth", "minorTickLength",
    "showMinorTicks", "numerals", "numeralInset", "secondHandTaper", "handBezel",
    "hourHandWidth", "minuteHandWidth", "secondHandWidth"];
  for (const preset of clock.presets) {
    const id = preset.props.preset;
    const ops = emit(at(1234, { preset: id }));
    assert.ok(ops.length > 0, `preset ${id} emitted nothing`);
    // NOTHING in the display list may be undefined or NaN. A style key missing
    // from a preset resolves to `undefined` and would reach a paint op as a
    // width, a coordinate or a color — which is how a preset ships a hole.
    // boxW/boxH are EXEMPT: render_gpu/ir.js text() defaults both to Infinity,
    // which is its documented "no wrap width / no height limit" sentinel, not a
    // hole. Everything else must be a real number.
    const INFINITY_IS_LEGAL = new Set(["boxW", "boxH"]);
    for (const op of ops) {
      for (const [field, value] of Object.entries(op)) {
        assert.ok(value !== undefined, `preset ${id}: op ${op.op} has undefined ${field}`);
        if (typeof value === "number" && !INFINITY_IS_LEGAL.has(field))
          assert.ok(Number.isFinite(value), `preset ${id}: op ${op.op} has non-finite ${field}`);
      }
      for (const [x, y] of op.points ?? [])
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `preset ${id}: non-finite point in ${op.op}`);
    }
    // …and the preset must actually SUPPLY every style key it is asked for, so a
    // key added to the model later cannot be silently absent from one preset.
    for (const key of keys)
      assert.ok(emit(at(0, { preset: id, [key]: undefined })).length > 0, `preset ${id} incomplete at ${key}`);
  }
  // THE PANE ORDER, pinned. Not a list of WHICH presets exist (the loop above
  // already covers every one the plugin declares, whatever they are) but of the
  // order they are OFFERED in, which is content: `classic` must stay first because
  // it is DEFAULT_PRESET and the byte-frozen baseline, and the rest run by viewing
  // distance from a concourse board down to a wrist, ending on three dress and
  // graphic dials. A re-sort is a defect, so it fails here.
  assert.deepEqual(clock.presets.map((p) => p.props.preset), [
    "classic", "terminalBoard", "stationPlatform", "schoolhouse", "flieger",
    "fieldWatch", "diver", "sweepTimer", "thin", "bulkhead", "roman", "deco", "minimal",
  ]);
});

await test("no preset crowds its numerals against the ticks more tightly than classic already does", () => {
  // Prompted by LOOKING at the roman dial, where the numerals read as crowding
  // their hour ticks. Investigating turned the eyeball impression into a measured
  // quantity — and partly disconfirmed it (see the calibration note below).
  //
  // Stated mechanically as a DISTANCE BETWEEN A BOX AND A SEGMENT, which is the
  // only formulation that actually reproduces what the eye saw. An earlier
  // version of this test compared the numeral's radial REACH against the ticks'
  // inner RADIUS and passed the colliding dial — because a tick is a thin spoke
  // at one angle, not a ring: a label overlaps it by sharing its ANGLE, and a
  // purely radial test cannot see that. Recorded here because the wrong version
  // was convincing.
  const DIGIT_ADVANCE_RATIO = 0.55;
  // THE THRESHOLD IS CALIBRATED AGAINST CLASSIC, NOT PICKED — and the honest
  // record of getting here matters more than the number, because two earlier
  // versions of this assertion were confidently wrong:
  //
  //   1. A strict overlap test (gap > 0) passed everything. "Does not intersect"
  //      is not "does not look crowded": DIGIT_ADVANCE_RATIO is an ESTIMATE of
  //      glyph advance that under-reports wide runs like "II", so the painted
  //      box this test reconstructs is narrower than the real one.
  //   2. A hand-picked floor of 10 then failed CLASSIC — the byte-frozen default
  //      this whole file exists to protect. A threshold that condemns the shipped
  //      baseline is measuring the author's taste, not a defect.
  //
  // MEASURED WORST GAPS on a 500px dial: classic 4.82 ("10"), roman@0.26 4.39
  // ("VIII"), roman@0.34 24.05, thin 22.44, minimal n/a (no numerals). Note what
  // that says: the roman dial the screenshot flagged was only marginally tighter
  // than the shipped classic, so most of what looked like a collision was the
  // width estimate, not geometry. Widening roman's inset to 0.34 is still a real
  // improvement (4.39 → 24.05) and it is kept — but this gate does NOT claim to
  // have caught a collision, only to hold the line at the accepted baseline.
  //
  // So: no preset may be TIGHTER THAN CLASSIC ALREADY IS. That is a real
  // regression gate (a future preset that crowds its numerals fails) without
  // pretending to a precision the glyph-width estimate cannot support.
  const CLASSIC_WORST_GAP = 4.82;                          // measured, the shipped baseline
  const MIN_NUMERAL_TICK_GAP = CLASSIC_WORST_GAP - 0.01;   // classic itself must pass

  /** Pure function. Distance from point p to segment ab. */
  const pointSegDist = (p, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = p[0] - a[0], wy = p[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  };

  for (const preset of clock.presets) {
    const id = preset.props.preset;
    const s = at(0, { preset: id, w: 500, h: 500 });
    const ops = emit(s);
    const texts = ops.filter((o) => o.op === "text");
    if (texts.length === 0) continue; // "none" — nothing to collide
    // THE TICK SPOKES, DERIVED FROM POSITION — and the count-based version this
    // replaces was WRONG IN TWO WAYS AT ONCE, both reproduced before the fix.
    //
    // It read `ops.filter(polyline).slice(0, 60 - 3)`, i.e. "take 57 of the
    // polylines". emit() lays ops down in a fixed order: face, TICKS, NUMERALS,
    // hands, pivot — so the ticks are exactly the polylines BEFORE the first
    // numeral, and this loop already skips any dial with no numerals.
    //
    //   1. With `showMinorTicks: false` there are only 12 tick polylines, so the
    //      slice runs on into the HANDS and measures a numeral against a hand as
    //      if it were a tick. MEASURED on a roman dial with no minute track and
    //      taper/bezel at 0: worst gap -2.75 against "XII", failing a gate about
    //      TICK clearance because the second hand happened to pass under the
    //      twelve. Derived correctly the same dial scores 63.74 — the roomiest in
    //      the set. The shipped `roman` preset escaped only by coincidence: its
    //      taper and bezel are both nonzero, which promotes all three hands to
    //      POLYGONS and takes them out of the filter.
    //   2. On a full 60-tick dial it took 57 of the 60 and silently dropped
    //      three, so the gate was always checking less than it claimed. (Classic's
    //      worst gap is unchanged at 4.820508…, so CLASSIC_WORST_GAP above stays
    //      exactly calibrated — the three it dropped were not the worst.)
    //
    // The count was never derivable anyway: 60 - 3 encodes "all the ticks minus
    // the hands", which is not what a prefix of a filtered list means.
    const firstNumeral = ops.findIndex((o) => o.op === "text");
    const ticks = ops.slice(0, firstNumeral).filter((o) => o.op === "polyline");
    for (const t of texts) {
      const w = t.text.length * t.size * DIGIT_ADVANCE_RATIO;
      const h = t.size;
      // The label's painted box, sampled on its perimeter (corners + edge mids)
      // — enough to catch an overlap without a full polygon intersection.
      const box = [
        [t.x, t.y], [t.x + w, t.y], [t.x, t.y + h], [t.x + w, t.y + h],
        [t.x + w / 2, t.y], [t.x + w / 2, t.y + h], [t.x, t.y + h / 2], [t.x + w, t.y + h / 2],
      ];
      for (const tick of ticks) {
        const pad = (tick.width ?? 0) / 2;
        const nearest = Math.min(...box.map((p) => pointSegDist(p, tick.points[0], tick.points[1])));
        assert.ok(
          nearest - pad > MIN_NUMERAL_TICK_GAP,
          `preset ${id}: numeral "${t.text}" clears a tick by only ${(nearest - pad).toFixed(2)} (want > ${MIN_NUMERAL_TICK_GAP}) — too tight to read`,
        );
      }
    }
  }
});

await test("PICTURE PARITY with the RETIRED plugins/clock_analog.js module", async () => {
  // This assertion USED TO LIVE in builtin_asset_library_test.js's PARITY list, and
  // it moved here rather than being dropped. That file pins two things at once: the
  // PICTURE (emit equality) and the INTERFACE (default + inspector KEYS). The user
  // request deliberately grew the interface — new style rows, the preset model, the
  // hand handles — so the interface half necessarily fails there and the clock had
  // to leave that list under the rule the file states for progress_bar.
  //
  // The picture half is NOT obsolete, though, and dropping it silently would have
  // been the real loss: it is the only check tying this widget to an INDEPENDENT
  // implementation rather than to a baseline this file wrote itself. So it is
  // restated here, driven from the RETIRED module's own defaults, which isolates
  // the drawing routine from the data exactly as the original did.
  const { clockAnalogPlugin: before } = await import("../plugins/clock_analog.js");
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  for (const overrides of [{}, { w: 300, h: 40 }, { w: 120, h: 120, rotation: 30, scale: 1.5 }, { time: 1234 }]) {
    const state = { ...before.defaults, ...overrides };
    assert.deepEqual(clock.emit(state, null, world), before.emit(state, null, world),
      `the asset's emit() differs from the retired module's on ${JSON.stringify(overrides)}`);
  }
});

await test("the RETIRED showNumerals:false still hides the numerals (legacy migration)", () => {
  // Found by diffing this widget's defaults against git HEAD, not by a failing
  // test: HEAD had a `showNumerals` boolean row that the richer `numerals` select
  // replaced. A document saved by the old widget stores showNumerals:false and no
  // `numerals` key, so without the migration it would resolve to the preset's
  // "arabic" and hand the author back twelve numbers they had switched OFF.
  assert.equal(emit(at(0, { showNumerals: false })).filter((o) => o.op === "text").length, 0);
  // …but an explicitly chosen kind WINS over the legacy flag, so the migration
  // cannot strand an author who has since picked one.
  const roman = emit(at(0, { showNumerals: false, numerals: "roman" })).filter((o) => o.op === "text");
  assert.equal(roman.length, 12);
  assert.equal(roman[3].text, "IIII");
  // And the legacy TRUE is a pure no-op: it agreed with the default already, so
  // it must not perturb one bit of the frozen baseline.
  assert.deepEqual(emit(at(1234, { showNumerals: true })), emit(at(1234)));
});

await test("an unknown preset falls back to classic rather than emitting undefined", () => {
  assert.deepEqual(emit(at(0, { preset: "nonsense" })), emit(at(0, { preset: "classic" })));
});

await test("hand tip anchors still track the hands (the symlink/anchor contract)", () => {
  const a = clock.anchors(at(10800)); // 3:00
  const hourTip = a.find((p) => p.id === "hourTip");
  assert.ok(Math.abs(hourTip.x - 165) < 1e-9 && Math.abs(hourTip.y - 110) < 1e-9);
});

console.log(`clock_analog_test: ${passed} checks passed`);
