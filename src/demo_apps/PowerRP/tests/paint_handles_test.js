/**
 * GRADIENT HANDLE tests — the on-canvas beads that edit a linear/radial gradient's
 * geometry (core/paint_handles.js).
 *
 * The three laws under test, in the order the feature's bugs appeared:
 *
 *   1. ANGLE ON CANVAS. The direction bead is a FREE polar handle — heading sets
 *      the axis angle, distance sets the wavelength. A SIDEWAYS drag must turn the
 *      gradient. It used to ride a fixed ray, so `constrain` projected every
 *      sideways component away and the drag wrote nothing at all (user, 2026-08-02:
 *      "It doesn't seem to be changing any values").
 *
 *   2. PHASE SYNC. Both beads sit on what the RENDERER draws, not on the stored
 *      centre: the direction bead on the drawn ramp END, the centre bead on the
 *      drawn ramp MIDPOINT. render_gpu/ir.js linearGradientRender is the oracle
 *      here — the test asks IT where the ramp is rather than restating the math,
 *      so a change to the phase convention breaks this suite instead of silently
 *      desyncing the beads (user: "not always perfectly synchronized with the
 *      phase").
 *
 *   3. ROUND TRIP. A drag's landing point is where the bead reappears, and the
 *      bead's own displayed position is a FIXED POINT of apply. Exactness is
 *      bounded by `tidy()`'s deliberate 1e-6-degree quantization of the stored
 *      angle (core/properties.js), so a first apply lands sub-pixel; a SECOND
 *      apply at the bead's own position is exact, because the angle is already
 *      quantized by then.
 *
 * Bare-node, no DOM — core/ is DOM-free by contract.
 */

import { paintModifierPoints, activeGradient, linearAxisOf, linearPolarInverse, phaseShiftHalves, wrappedPhase } from "../core/paint_handles.js";
import { linearGradientRender } from "../render_gpu/ir.js";
import { angleToLinearEndpoints, GRADIENT_MIN_WAVELENGTH } from "../core/properties.js";

let failures = 0, checks = 0;

function check(label, cond, detail = "") {
  checks++;
  if (!cond) { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

function near(label, got, want, tol, detail = "") {
  check(label, Math.abs(got - want) <= tol, `${detail} got ${got}, want ${want} (±${tol})`);
}

const BOX_W = 200, BOX_H = 100;

/** The item state carrying a linear gradient fill built from sub-state `g`. */
function linearState(g, w = BOX_W, h = BOX_H) {
  return { w, h, fill: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], ...g } } };
}

/** The bead of `id` on a state's fill, {x, y, apply}. */
function bead(state, id) {
  return paintModifierPoints(state, "fill").find((m) => m.id === id);
}

/** Applies a bead drag to `target` and returns the resulting item state. */
function dragTo(state, id, target) {
  return { ...state, ...bead(state, id).apply(state, target) };
}

/** The gradient sub-state of an item state's fill. */
const sub = (state) => state.fill.linear;

// The gradient shapes every law is checked against: the default, several phases
// (including a negative and a whole-cycle one), off-centre, and both a sub-1 and
// a >1 wavelength.
const SHAPES = [
  { angle: 0, wavelength: 1 },
  { angle: 0, wavelength: 1, phase: 0.25 },
  { angle: 0, wavelength: 0.5, phase: 0.5 },
  { angle: 30, wavelength: 0.4, phase: 0.7 },
  { angle: 210, wavelength: 2.2, phase: -0.4 },
  { angle: 90, wavelength: 0.13, phase: 0.9 },
  { angle: 45, wavelength: 0.6, phase: 0.33, center: { x: 0.2, y: 0.8 } },
  { angle: 137, wavelength: 0.8, phase: 1 },
];

// ── 1. ANGLE ON CANVAS ───────────────────────────────────────────────────────
console.log("angle on canvas");
{
  // The bead has NO constrain: every point is allowed, which is the whole fix.
  check("direction bead declares no constraint", bead(linearState({ angle: 0, wavelength: 1 }), "fill-grad-dir").constrain === undefined);

  // A straight-up drag from a 0° (rightward) gradient must turn the axis to point
  // up. Screen y grows DOWNWARD, so up is 270°.
  const up = dragTo(linearState({ angle: 0, wavelength: 1 }), "fill-grad-dir", { x: BOX_W / 2, y: BOX_H / 2 - 30 });
  near("straight-up drag writes a 270° axis", sub(up).angle, 270, 1e-6);
  check("straight-up drag changed the angle at all", sub(up).angle !== 0);

  // THE REGRESSION THIS SUITE EXISTS FOR: a purely sideways nudge off the axis
  // used to write NOTHING. It must now move the angle.
  const before = linearState({ angle: 0, wavelength: 1 });
  const sideways = dragTo(before, "fill-grad-dir", { x: BOX_W, y: BOX_H / 2 - 20 });
  check("a sideways drag is no longer dead", sub(sideways).angle !== sub(before).angle,
    `angle stayed ${sub(sideways).angle}`);

  // Distance still sets the wavelength, and the two are independent: dragging
  // straight out along the existing axis must not turn it.
  const out = dragTo(linearState({ angle: 0, wavelength: 1 }), "fill-grad-dir", { x: BOX_W / 2 + 150, y: BOX_H / 2 });
  near("dragging out along the axis keeps the angle", out.fill.linear.angle, 0, 1e-6);
  near("dragging out lengthens the wavelength", sub(out).wavelength, 1.5, 1e-6);

  // The floor holds, and a drag onto the centre has no heading so the stored
  // angle survives rather than snapping to an arbitrary direction.
  const onCentre = dragTo(linearState({ angle: 137, wavelength: 1 }), "fill-grad-dir", { x: BOX_W / 2, y: BOX_H / 2 });
  near("a drag onto the centre keeps the stored angle", sub(onCentre).angle, 137, 1e-9);
  near("a drag onto the centre floors the wavelength", sub(onCentre).wavelength, GRADIENT_MIN_WAVELENGTH, 1e-12);

  // The BOX ASPECT must be divided out: on a 200×100 box a 45° BBOX heading is a
  // (2:1) screen direction, so a drag along the screen diagonal is NOT 45°.
  const diag = dragTo(linearState({ angle: 0, wavelength: 1 }), "fill-grad-dir", { x: BOX_W / 2 + 50, y: BOX_H / 2 + 50 });
  near("the heading is read in bbox space, not screen space", sub(diag).angle, 63.434949, 1e-4,
    "a 45° screen drag on a 2:1 box is a 63.4° bbox heading");
}

// ── 2. PHASE SYNC (oracle: linearGradientRender) ─────────────────────────────
console.log("phase sync against the renderer");
for (const g of SHAPES) {
  const state = linearState(g);
  const pts = paintModifierPoints(state, "fill");
  const dir = pts.find((p) => p.id === "fill-grad-dir");
  const ctr = pts.find((p) => p.id === "fill-grad-center");
  // Ask the RENDERER where it actually puts the ramp, and convert to local px.
  const r = linearGradientRender({
    ...angleToLinearEndpoints(g.angle),
    center: g.center ?? { x: 0.5, y: 0.5 },
    wavelength: g.wavelength,
    phase: g.phase,
  });
  const label = JSON.stringify(g);
  near(`dir bead is on the drawn ramp end x ${label}`, dir.x, r.to.x * BOX_W, 1e-9);
  near(`dir bead is on the drawn ramp end y ${label}`, dir.y, r.to.y * BOX_H, 1e-9);
  near(`centre bead is on the drawn ramp midpoint x ${label}`, ctr.x, ((r.from.x + r.to.x) / 2) * BOX_W, 1e-9);
  near(`centre bead is on the drawn ramp midpoint y ${label}`, ctr.y, ((r.from.y + r.to.y) / 2) * BOX_H, 1e-9);
  // The stem draws the axis the bead swings around, so it must land on the pivot
  // the centre bead marks — the two cannot disagree about where the centre is.
  near(`dir bead's stem is at the drawn centre x ${label}`, dir.stem.x, ctr.x, 1e-9);
  near(`dir bead's stem is at the drawn centre y ${label}`, dir.stem.y, ctr.y, 1e-9);
}
{
  // A whole cycle is the identity, so phase 1 must place the beads exactly where
  // phase 0 does — the same wrap the renderer takes.
  const at0 = bead(linearState({ angle: 20, wavelength: 0.7, phase: 0 }), "fill-grad-dir");
  const at1 = bead(linearState({ angle: 20, wavelength: 0.7, phase: 1 }), "fill-grad-dir");
  near("phase 1 places the bead where phase 0 does (x)", at1.x, at0.x, 1e-9);
  near("phase 1 places the bead where phase 0 does (y)", at1.y, at0.y, 1e-9);

  // A bead drag must NOT rewrite a keyframed phase.
  const dragged = dragTo(linearState({ angle: 0, wavelength: 1, phase: 0.4 }), "fill-grad-dir", { x: 30, y: 90 });
  near("a direction drag leaves the phase alone", sub(dragged).phase, 0.4, 0);
  const centred = dragTo(linearState({ angle: 0, wavelength: 1, phase: 0.4 }), "fill-grad-center", { x: 30, y: 90 });
  near("a centre drag leaves the phase alone", sub(centred).phase, 0.4, 0);
}

// ── 3. ROUND TRIP ────────────────────────────────────────────────────────────
console.log("round trip");
{
  // Targets chosen to sit comfortably outside the wavelength floor, so the drag
  // is honoured exactly rather than clamped.
  const TARGETS = [{ x: 150, y: 20 }, { x: 60, y: 80 }, { x: 260, y: 130 }, { x: -40, y: -10 }];
  // The angle is stored quantized to 1e-6 degrees (tidy), so a first landing is
  // sub-pixel rather than bit-exact; a second apply is a true fixed point.
  const FIRST_LANDING_TOL_PX = 0.01;
  for (const g of SHAPES) {
    for (const t of TARGETS) {
      const label = `${JSON.stringify(g)} @ ${JSON.stringify(t)}`;
      const after = dragTo(linearState(g), "fill-grad-dir", t);
      if (sub(after).wavelength <= GRADIENT_MIN_WAVELENGTH + 1e-12) continue; // floored on purpose
      const landed = bead(after, "fill-grad-dir");
      near(`drag lands the bead where it was dropped, x ${label}`, landed.x, t.x, FIRST_LANDING_TOL_PX);
      near(`drag lands the bead where it was dropped, y ${label}`, landed.y, t.y, FIRST_LANDING_TOL_PX);

      // FIXED POINT: re-applying at the bead's own displayed position moves nothing.
      const again = bead(dragTo(after, "fill-grad-dir", landed), "fill-grad-dir");
      near(`the bead is a fixed point of apply, x ${label}`, again.x, landed.x, 1e-9);
      near(`the bead is a fixed point of apply, y ${label}`, again.y, landed.y, 1e-9);
    }
    // The CENTRE bead round-trips exactly — no angle quantization is involved.
    const target = { x: 40, y: 70 };
    const moved = bead(dragTo(linearState(g), "fill-grad-center", target), "fill-grad-center");
    near(`centre bead round-trips exactly, x ${JSON.stringify(g)}`, moved.x, target.x, 1e-9);
    near(`centre bead round-trips exactly, y ${JSON.stringify(g)}`, moved.y, target.y, 1e-9);
  }
}

// ── The helpers, and the shapes that yield no handles ────────────────────────
console.log("helpers and non-gradient paints");
{
  check("a solid paint yields no handles", paintModifierPoints({ w: 10, h: 10, fill: "#f00" }, "fill").length === 0);
  check("an absent paint yields no handles", paintModifierPoints({ w: 10, h: 10 }, "fill").length === 0);
  check("a material yields no handles", paintModifierPoints({ w: 10, h: 10, fill: { type: "material", material: { id: "comic" } } }, "fill").length === 0);
  check("a radial gradient yields the centre bead alone",
    paintModifierPoints({ w: 10, h: 10, fill: { type: "radialGradient", radial: { stops: [], center: { x: 0.5, y: 0.5 }, r: 0.5 } } }, "fill").length === 1);

  // A LEGACY INLINE gradient (fields on the object, no .linear wrapper) must get
  // the same beads and be patched in place.
  const inline = { w: BOX_W, h: BOX_H, fill: { type: "linearGradient", stops: [], angle: 0, wavelength: 1 } };
  check("a legacy inline gradient still yields both beads", paintModifierPoints(inline, "fill").length === 2);
  const inlineDragged = dragTo(inline, "fill-grad-dir", { x: BOX_W / 2, y: BOX_H / 2 - 30 });
  near("a legacy inline gradient is patched in place", inlineDragged.fill.angle, 270, 1e-6);
  check("a legacy inline gradient gains no wrapper", inlineDragged.fill.linear === undefined);

  // A zero-extent box cannot yield a fraction, so the centre is kept rather than
  // producing NaN/Infinity.
  const flat = { w: 0, h: 0, fill: { type: "linearGradient", linear: { stops: [], angle: 0, wavelength: 1, center: { x: 0.3, y: 0.7 } } } };
  const flatDragged = dragTo(flat, "fill-grad-center", { x: 5, y: 5 });
  near("a zero-extent box keeps its centre x", flatDragged.fill.linear.center.x, 0.3, 0);
  near("a zero-extent box keeps its centre y", flatDragged.fill.linear.center.y, 0.7, 0);

  check("activeGradient sees through the wrapper", activeGradient({ type: "linearGradient", linear: { stops: [] } }).wrapped === true);
  check("activeGradient reports a legacy inline gradient", activeGradient({ type: "linearGradient", stops: [] }).wrapped === false);
  check("activeGradient refuses a solid", activeGradient("#f00") === null);

  near("wrappedPhase folds a whole cycle to zero", wrappedPhase({ phase: 1 }), 0, 0);
  near("wrappedPhase folds a negative phase forward", wrappedPhase({ phase: -0.25 }), 0.75, 1e-12);
  near("phaseShiftHalves of the default is zero", phaseShiftHalves({}), 0, 0);
  near("phaseShiftHalves counts quarter-periods", phaseShiftHalves({ phase: 0.25, wavelength: 1 }), 1, 1e-12);

  const inv = linearPolarInverse(100, 0, BOX_W, BOX_H, 0);
  near("linearPolarInverse recovers the 0° axis angle", inv.angle, 0, 1e-9);
  near("linearPolarInverse recovers its multiple", inv.multiple, 1, 1e-9);
  near("linearPolarInverse keeps the fallback angle at the origin", linearPolarInverse(0, 0, BOX_W, BOX_H, 45).angle, 45, 0);

  check("linearAxisOf prefers a stored angle", linearAxisOf({ angle: 90 }).to.y === 1);
  check("linearAxisOf falls back to stored endpoints", linearAxisOf({ from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }).to.x === 1);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
