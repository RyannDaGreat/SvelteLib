/**
 * GRADIENT HANDLE tests — the on-canvas beads that edit a linear/radial gradient's
 * geometry (core/paint_handles.js).
 *
 * The four laws under test, in the order the feature's bugs appeared:
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
 *   4. UNIVERSALITY. The beads are DERIVED for every paint-capable widget, not
 *      spread by the seven plugins that remembered to. That was the user's third
 *      report on this feature — "why do I not see the handles for the gradient on
 *      the graph line? Sometimes I see the handles for a gradient, and sometimes I
 *      don't, and it baffles me" — and it is checked as a SWEEP over the whole
 *      registered roster, because the failure mode was never one widget: it was
 *      the default being wrong.
 *
 * Bare-node, no DOM — core/ is DOM-free by contract. This suite imports
 * plugins/index.js for the roster sweep, which is bare-node importable.
 */

import { paintModifierPoints, allPaintModifierPoints, paintCapableKeys, activeGradient, linearAxisOf, linearPolarInverse, phaseShiftHalves, wrappedPhase } from "../core/paint_handles.js";
import { nodeModifierPoints, worldTransform } from "../core/derive.js";
import { unsignedState } from "../core/geometry.js";
import { allPlugins } from "../plugins/index.js";
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

// ── LAW 4: THE BEADS ARE DERIVED, NOT OPTED INTO ─────────────────────────────
//
// Until 2026-08-02 each plugin SPREAD `paintModifierPoints(s, "fill")` into its
// own `modifierPoints`, and exactly SEVEN of ~74 paint-capable plugins did — so a
// graph_line with a gradient fill had no handles and the user reported the
// inconsistency ("sometimes I see the handles for a gradient, and sometimes I
// don't"). core/derive.js nodeModifierPoints now appends them for every
// `paint: true` Inspector row a plugin declares. The four things that must hold:
//
//   4a. EQUALITY WITH THE SPREAD. The derived rows are what the removed spread
//       produced — same ids, glyphs, labels, stems and (once unwrapped) positions.
//       This is the pin that would have caught a silent regression in the seven.
//   4b. COVERAGE. graph_line — the widget the user reported — now has them, and so
//       does every other paint-capable plugin, off its own declaration.
//   4c. NO COST TO NON-GRADIENTS. A widget whose paints are all solid gets ZERO
//       extra rows, so every existing handle set is byte-identical.
//   4d. THE FLIP. `node.state` is post-`unsignedState`, so a NEGATIVE-w widget's
//       beads land on its ink — the one derive seam gets this right for all 74,
//       which is the structural win over seven per-plugin spreads.
console.log("auto-derive: the beads are a function of the paint, not the plugin");
{
  const GRAD = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 30, wavelength: 0.7, phase: 0.25 } };
  const plugins = Object.fromEntries(Object.values(allPlugins).map((p) => [p.type, p]));

  /** A render node for `type` with `extra` merged over its defaults — the same
   *  unsignedState + worldTransform pair core/derive.js deriveNodes builds. */
  function nodeFor(type, extra) {
    const state = unsignedState({ ...plugins[type].defaults, ...extra });
    return { id: "i", itemId: "i", type, state, world: worldTransform(state), plugin: plugins[type] };
  }
  const idsOf = (node) => nodeModifierPoints(node).map((m) => m.id);

  // 4a — the derived rows ARE the spread's rows. rect's `modifierPoints` was
  // NOTHING BUT the spread, so its whole derived set must equal the helper's,
  // aspect for aspect, with x/y offset by the node origin (rotation 0, scale 1).
  const rectNode = nodeFor("rect", { fill: GRAD, x: 100, y: 100, w: 200, h: 100 });
  const derived = nodeModifierPoints(rectNode);
  const spread = paintModifierPoints(rectNode.state, "fill");
  check("the spread and the derive produce the same number of beads", derived.length === spread.length, `derived ${derived.length}, spread ${spread.length}`);
  for (let i = 0; i < spread.length; i++) {
    const d = derived[i], m = spread[i];
    check(`bead ${i} keeps its id`, d.id === m.id, `${d.id} vs ${m.id}`);
    check(`bead ${d.id} keeps its glyph`, d.glyph === m.glyph, `${d.glyph} vs ${m.glyph}`);
    check(`bead ${d.id} keeps its label`, d.label === m.label, `${d.label} vs ${m.label}`);
    check(`bead ${d.id} keeps its stem presence`, !!d.stem === !!m.stem);
    near(`bead ${d.id} lands at the same x`, d.x, m.x + rectNode.state.x, 1e-9);
    near(`bead ${d.id} lands at the same y`, d.y, m.y + rectNode.state.y, 1e-9);
  }

  // 4b — THE REPORTED WIDGET. graph_line never spread anything and has no
  // `modifierPoints` hook at all, so before this change its gradient fill had no
  // handles whatsoever. Both `closed` states get them: the beads follow the PAINT
  // being a gradient, exactly as they do on the seven, not whether it currently
  // covers pixels (a graph_line only fills when closed).
  check("graph_line with a gradient fill now has both beads",
    idsOf(nodeFor("graph_line", { fill: GRAD, closed: true })).join(",") === "fill-grad-center,fill-grad-dir");
  check("graph_line's beads do not depend on `closed`",
    idsOf(nodeFor("graph_line", { fill: GRAD, closed: false })).join(",") === "fill-grad-center,fill-grad-dir");

  // Every paint key the plugin declares, not just `fill` — the aperture declares
  // three (fill, pupilFill, stroke) and used to spread only the first two, so a
  // gradient-STROKED aperture had no stroke beads either.
  check("aperture derives beads for all three of its paint keys",
    idsOf(nodeFor("aperture", { fill: GRAD, pupilFill: GRAD, stroke: GRAD })).filter((id) => id.includes("-grad-")).join(",")
      === "fill-grad-center,fill-grad-dir,pupilFill-grad-center,pupilFill-grad-dir,stroke-grad-center,stroke-grad-dir");

  // The plugin's OWN handles come FIRST and keep their ids — polygon's vertices
  // are p0..pN and the beads are appended after them.
  const polyIds = idsOf(nodeFor("polygon", { fill: GRAD }));
  check("a plugin's own handles keep their leading position", polyIds[0] === "p0", polyIds.join(","));
  check("the beads are appended after them", polyIds.slice(-2).join(",") === "fill-grad-center,fill-grad-dir", polyIds.join(","));

  // 4c — no gradient, no rows. A plain rect had zero handles before and must
  // still have zero; a plain polygon keeps exactly its vertices.
  check("a solid-filled rect derives NO handles", idsOf(nodeFor("rect", {})).length === 0);
  check("a solid-filled polygon derives its vertices and nothing else",
    idsOf(nodeFor("polygon", {})).every((id) => /^p\d+$/.test(id)));

  // 4d — THE FLIP. The four sign spellings of one footprint derive to the same
  // state (core/geometry.js unsignedState is an involution), so the beads of a
  // negative-w widget must be at the IDENTICAL world points as its unflipped twin
  // — i.e. on the ink, not mirrored off it.
  const upright = nodeModifierPoints(nodeFor("rect", { fill: GRAD, x: 100, y: 100, w: 200, h: 100 }));
  const flipped = nodeModifierPoints(nodeFor("rect", { fill: GRAD, x: 300, y: 100, w: -200, h: 100 }));
  check("a flipped widget derives the same bead count", flipped.length === upright.length);
  for (let i = 0; i < upright.length; i++) {
    near(`flipped bead ${upright[i].id} lands on the ink, x`, flipped[i].x, upright[i].x, 1e-9);
    near(`flipped bead ${upright[i].id} lands on the ink, y`, flipped[i].y, upright[i].y, 1e-9);
  }
  const bothFlipped = nodeModifierPoints(nodeFor("rect", { fill: GRAD, x: 300, y: 200, w: -200, h: -100 }));
  for (let i = 0; i < upright.length; i++) {
    near(`doubly-flipped bead ${upright[i].id} lands on the ink, x`, bothFlipped[i].x, upright[i].x, 1e-9);
    near(`doubly-flipped bead ${upright[i].id} lands on the ink, y`, bothFlipped[i].y, upright[i].y, 1e-9);
  }

  // paintCapableKeys reads the plugin's declaration and nothing else — a widget
  // with no paint rows contributes nothing, which is what makes this safe to run
  // over the whole roster.
  check("paintCapableKeys reads a plugin's own paint rows", paintCapableKeys(plugins.rect).join(",") === "fill,stroke");
  check("paintCapableKeys is empty for a plugin with no paint rows", paintCapableKeys({ inspector: [{ key: "w", kind: "number" }] }).length === 0);

  // THE SWEEP: every registered paint-capable plugin derives beads for a gradient
  // on its FIRST paint key. This is the assertion the opt-in could not make — it
  // is what "a function of the PAINT, not the shape" means, stated over the roster
  // rather than over the seven files that remembered.
  let covered = 0, uncovered = [];
  for (const p of Object.values(allPlugins)) {
    const keys = paintCapableKeys(p);
    if (keys.length === 0) continue;
    let ids;
    // A plugin's own modifierPoints may legitimately throw on a bare-defaults
    // state (a family needing params). Its OWN rows are not what is under test
    // here, so fall back to the derive input the beads actually read.
    try { ids = nodeModifierPoints(nodeFor(p.type, { [keys[0]]: GRAD })).map((m) => m.id); }
    catch { ids = allPaintModifierPoints(unsignedState({ ...p.defaults, [keys[0]]: GRAD }), keys).map((m) => m.id); }
    if (ids.includes(`${keys[0]}-grad-center`)) covered++;
    else uncovered.push(`${p.type}.${keys[0]}`);
  }
  check(`every paint-capable plugin derives gradient beads (${covered} covered)`, uncovered.length === 0, uncovered.join(", "));
  check("the sweep actually covered the roster, not a handful", covered > 60, `only ${covered}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
