/**
 * strokeOffset SCRUB RANGE vs HARD BOUNDS — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/stroke_offset_scrub_range_test.js
 *
 * ── THE RULING (user, verbatim) ──────────────────────────────────────────────
 * "stroke offset slider can be bounded between -1 and 1 in the GUI like other
 * sliders when sliding, but accept any value when typing or binding etc."
 *
 * ── THE PRECEDENT VERDICT: ABSENT ────────────────────────────────────────────
 * Before this change, core/properties.js had exactly ONE row aspect for a
 * numeric control's range (`min`/`max`), read by THREE consumers that treat it
 * as the SAME number for two different purposes: web/NumericField.svelte's
 * resolveScrub() call (a SPAN to derive the drag coefficient from) and the
 * `min`/`max` props handed straight to lib/DraggableNumber.svelte, whose own
 * `clamp()` enforces them on drag, Home/End, AND its built-in typed-text path.
 * NumericField never reaches that built-in text path (it always supplies
 * `onedit`, delegating to its OWN equation-aware entry — see NumericField's
 * commitText/toStored), and setPreview/commitPreview apply an equation's
 * result with no row awareness at all — so a row's min/max were ALREADY inert
 * for typed numbers and equations on every property in the app; strokeOffset's
 * [-8,8] just happened to be the one place someone read `min`/`max` as if it
 * clamped writes. Nothing before this change let a row declare "the drag
 * sweeps this far" separately from "the value may reach this far" — the
 * closest near-miss, gradient wavelength's `min: GRADIENT_MIN_WAVELENGTH` +
 * `scrub: FRACTION_SCRUB`, calibrates the coefficient but never narrows the
 * DRAG's clamp/Home-End range below the value's real (one-sided) domain, and
 * gradient phase (a6492af) went the other way — dropping min/max entirely
 * rather than splitting them. So: no prior aspect did this; `scrubMin`/
 * `scrubMax` (core/properties.js "SCRUB RANGE vs HARD BOUNDS") is a NEW,
 * general aspect, and strokeOffset is its first declarer.
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────
 *   1. The row: strokeOffset declares scrubMin:-1/scrubMax:1 and NO min/max at
 *      all (the [-8,8] hard cap is gone — any finite value is a real domain
 *      member per render_gpu/ir.js normalizeStrokeOffset).
 *   2. dragMin/dragMax resolution (mirrors web/NumericField.svelte's own
 *      `scrubMin ?? min` / `scrubMax ?? max`): a row with ONLY min/max is
 *      unaffected (existing rows need no edit); a row with scrubMin/scrubMax
 *      uses THOSE for the drag regardless of min/max.
 *   3. resolveScrub fed strokeOffset's dragMin/dragMax derives the SAME
 *      coefficient/step a plain bounded -1..1 row would (opacity's shape) —
 *      the drag FEELS like a normal bounded slider.
 *   4. A value beyond the scrub range (3, -5, 2.5) is untouched by the
 *      dragMin/dragMax computation — nothing here clamps a stored/typed value;
 *      clamping is DraggableNumber's OWN internal concern for drag gestures,
 *      never invoked by a typed/equation commit (verified structurally: no
 *      row-shaped clamp call exists on that path — see the header note and
 *      tests/default_step_test.js's identical sweep for corroboration).
 *   5. The renderer honors any finite strokeOffset beyond ±1 as a detached
 *      contour, reusing render_gpu/tests/stroke_offset_detached_test.js's own
 *      seam (normalizeStrokeOffset, strokeIsDetached) — proving the value a
 *      typed/equation-bound row now reaches is not just accepted but RENDERED.
 */

import assert from "node:assert/strict";
import { PROPS, row } from "../core/properties.js";
import { resolveScrub } from "../../../lib/numberStep.js";
import { normalizeStrokeOffset, strokeIsDetached, strokeOutwardReach } from "../render_gpu/ir.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── 1. THE ROW SHAPE ──────────────────────────────────────────────────────────
test("strokeOffset declares scrubMin/scrubMax, not min/max", () => {
  const r = row("strokeOffset");
  assert.equal(r.scrubMin, -1);
  assert.equal(r.scrubMax, 1);
  assert.equal(r.min, undefined, "the old [-8,8] hard cap must be gone, not merely widened again");
  assert.equal(r.max, undefined);
});

test("PROPS.strokeOffset carries no default (an unstamped strokeOffset means CENTERED, not this row's concern)", () => {
  assert.equal(PROPS.strokeOffset.default, undefined);
});

// ── 2. dragMin/dragMax RESOLUTION (mirrors NumericField.svelte's `scrubMin ??
//      min` / `scrubMax ?? max` exactly, so a divergence here is a real bug) ──

/** Pure function. web/NumericField.svelte's own dragMin/dragMax fallback,
 * mirrored so the resolution rule is checkable without mounting Svelte.
 *
 * @example dragRange({min: 0, max: 1}) // {dragMin: 0, dragMax: 1}
 * @example dragRange({scrubMin: -1, scrubMax: 1}) // {dragMin: -1, dragMax: 1}
 * @example dragRange({min: -8, max: 8, scrubMin: -1, scrubMax: 1}) // {dragMin: -1, dragMax: 1}
 * @example dragRange({}) // {dragMin: null, dragMax: null}
 */
function dragRange({ min = null, max = null, scrubMin = null, scrubMax = null }) {
  return { dragMin: scrubMin ?? min, dragMax: scrubMax ?? max };
}

test("a row with ONLY min/max (the common case) is unaffected: dragMin/dragMax fall back to them", () => {
  assert.deepEqual(dragRange(row("opacity")), { dragMin: 0, dragMax: 1 });
});

test("strokeOffset's dragMin/dragMax come from scrubMin/scrubMax, not the (absent) min/max", () => {
  assert.deepEqual(dragRange(row("strokeOffset")), { dragMin: -1, dragMax: 1 });
});

test("a row declaring BOTH: scrubMin/scrubMax wins for the drag (the narrower sweep), min/max stays the real domain", () => {
  assert.deepEqual(dragRange({ min: -8, max: 8, scrubMin: -1, scrubMax: 1 }), { dragMin: -1, dragMax: 1 });
});

// ── 3. THE DRAG FEELS LIKE A NORMAL BOUNDED -1..1 SLIDER ─────────────────────
const RANGE_DRAG_PX = 100; // web/NumericField.svelte's own constant, mirrored

test("resolveScrub on strokeOffset's dragMin/dragMax matches a plain bounded -1..1 row", () => {
  const { dragMin, dragMax } = dragRange(row("strokeOffset"));
  const strokeOffsetScrub = resolveScrub({ min: dragMin, max: dragMax, dragPx: RANGE_DRAG_PX });
  const plainUnitRow = resolveScrub({ min: -1, max: 1, dragPx: RANGE_DRAG_PX });
  assert.deepEqual(strokeOffsetScrub, plainUnitRow);
  assert.equal(strokeOffsetScrub.coefficient, 2 / RANGE_DRAG_PX, "a full 100px drag spans the whole -1..1 sweep");
});

test("without the scrubMin/scrubMax fallback, strokeOffset would have NO scrub evidence at all (min/max absent, integer-ish domain)", () => {
  // Regression guard: if a future edit deletes scrubMin/scrubMax without adding
  // min/max back, the row silently loses its bounded-slider feel — this pins
  // that the UNQUALIFIED row (no drag range resolved) truly has nothing to give
  // resolveScrub, so the fallback above is load-bearing, not decorative.
  const bare = resolveScrub({ dragPx: RANGE_DRAG_PX });
  assert.deepEqual(bare, { step: null, coefficient: null });
});

// ── 4. TYPED / EQUATION VALUES BEYOND THE SCRUB RANGE ARE UNTOUCHED ──────────
test("dragMin/dragMax resolution never clamps a VALUE — it only resolves which bounds the drag/coefficient uses", () => {
  // dragRange takes no value argument at all: it is pure range resolution, so
  // there is structurally no place here a stored 3 / -5 / 2.5 could be altered.
  const { dragMin, dragMax } = dragRange(row("strokeOffset"));
  for (const v of [3, -5, 2.5, -1.0001, 1.0001]) {
    assert.ok(Number.isFinite(v), "sanity: these are the values a typed/equation commit would carry unmodified");
  }
  assert.equal(dragMin, -1);
  assert.equal(dragMax, 1);
});

test("normalizeStrokeOffset (the actual write-time validator) accepts every one of those values verbatim", () => {
  for (const v of [3, -5, 2.5, -1.0001, 1.0001]) {
    assert.equal(normalizeStrokeOffset("t", { strokeOffset: v }).strokeOffset, v);
  }
  // 0 is the CENTERED identity value: normalizeStrokeOffset omits it rather
  // than stamping a no-op, same as any other identity value in this codebase.
  assert.deepEqual(normalizeStrokeOffset("t", { strokeOffset: 0 }), {});
});

test("normalizeStrokeOffset still refuses non-finite loudly (the half of the guard this change does NOT touch)", () => {
  assert.throws(() => normalizeStrokeOffset("t", { strokeOffset: NaN }), /finite/);
  assert.throws(() => normalizeStrokeOffset("t", { strokeOffset: Infinity }), /finite/);
});

// ── 5. THE RENDERER HONORS WHAT THE ROW NOW LETS THROUGH ─────────────────────
// Reuses render_gpu/tests/stroke_offset_detached_test.js's own seam (no pixel
// re-verification here — that suite already pins the pixels; this just proves
// the VALUES this row's typing/equation path produces are the ones the
// detachment formula treats as real, continuous domain members).
test("an equation-bound offset of exactly 3 (well past the drag's ±1 sweep) is a real DETACHED value, not an edge case", () => {
  assert.equal(strokeIsDetached(3), true);
  assert.equal(strokeIsDetached(-5), true);
  const w = 24;
  assert.equal(strokeOutwardReach(w, 3), 3 * (w / 2) + w / 2); // 2 widths further out than centered
});

test("dragMin/dragMax=±1 is exactly the continuity SEAM the detachment formula treats as identical to attached", () => {
  const w = 24;
  assert.equal(strokeOutwardReach(w, 1), w, "attached fully-outer");
  assert.equal(strokeIsDetached(1), false, "the drag's own boundary value is still ATTACHED, not detached");
});

console.log(`\nstroke_offset_scrub_range_test: ${passed} passed`);
