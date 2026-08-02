/**
 * GRADIENT HANDLES — the on-canvas yellow squares that edit a fill's gradient
 * GEOMETRY directly, the shared half of the gradient-handle feature (the other
 * half is the storage/render in render_gpu/ir.js + skia/gradient.js).
 *
 * WHY IT LIVES HERE, ONCE: every shape widget (rect, circle, polygon, the
 * shapeshifter families) can carry a gradient fill, and the handles for that
 * gradient are IDENTICAL across all of them — a function of the PAINT, not the
 * shape. So a single pure helper produces the modifier-point rows and each plugin
 * SPREADS them into its own `modifierPoints` (additively — its shape handles are
 * untouched). No plugin re-derives gradient geometry, and the constraint math is
 * written down exactly once.
 *
 * THE HANDLES (all in LOCAL widget px, over the [0,w]×[0,h] box, exactly like
 * every other modifier point — core/derive.js nodeModifierPoints wraps them
 * local→world for display and inverts back before apply):
 *
 *   RADIAL — one CENTER bead at the gradient center (objectBoundingBox center ×
 *     box), free (drag anywhere). The radius is a NumericField in the Inspector,
 *     not a bead.
 *
 *   LINEAR — a CENTER bead (same as radial), PLUS a DIRECTION bead that is a FREE
 *     POLAR handle: its HEADING from the center sets the axis ANGLE and its
 *     DISTANCE sets the WAVELENGTH, both in one drag. It has NO `constrain` — every
 *     point in the plane is allowed, which is why a sideways drag now turns the
 *     gradient instead of doing nothing (it used to ride a FIXED ray along the
 *     axis, so `constrain` projected every sideways component away and the drag
 *     read as dead; the user reported exactly that, 2026-08-02).
 *
 *     THE MAPPING, and why the heading is NOT simply atan2 of the local offset.
 *     The axis half-vector in local px is half = ((to − from)/2)·(w_box, h_box),
 *     where from/to are the objectBoundingBox endpoints the angle derives
 *     (core/properties.angleToLinearEndpoints). TWO non-uniform scalings sit
 *     between a stored angle and a screen direction: the BOX ASPECT (bbox → px
 *     multiplies x by W and y by H) and the CHORD EXTENT (the angle's half-length
 *     inside the unit square is 0.5/max(|dx|,|dy|), the nearer wall — so the axis
 *     is longer on the diagonals). The extent is a pure SCALE along the heading,
 *     so it cannot change a direction; the aspect can. Hence the angle is read in
 *     BBOX space — deg = atan2(oy/H, ox/W) for a local-px offset (ox, oy) — and the
 *     wavelength is then the projection of that offset onto the half-vector THAT
 *     ANGLE produces. That pair is an exact inverse of the placement formula, which
 *     is what makes the round-trip law hold: apply puts the bead back where the
 *     drag left it, to floating-point dust.
 *
 *     Dragging OUT lengthens the ramp (wavelength up, fewer tiles); dragging IN
 *     shortens it (wavelength down, more mirror-tiling), floored at
 *     GRADIENT_MIN_WAVELENGTH. A drag landing exactly ON the center has no heading,
 *     so the stored angle is KEPT and only the floored wavelength is written.
 *
 *   PHASE (both beads). The beads are placed on what the RENDERER actually draws,
 *     not on the stored center. render_gpu/ir.js linearGradientRender shifts the
 *     center along the axis by phase of the MIRROR PERIOD, which is 4·wavelength·half
 *     (there-and-back over one wavelength each way), taking `phase mod 1` first:
 *
 *       shift = 4·p·wavelength·half,   p = ((phase % 1) + 1) % 1
 *       drawn center = center + shift
 *       drawn ramp end = center + shift + wavelength·half = center + (4p+1)·wavelength·half
 *
 *     So the CENTER bead is displayed at `center + shift` and the DIRECTION bead at
 *     the drawn ramp end — both are real, visible ramp landmarks at ANY phase.
 *     Before this, placement ignored phase entirely and the beads floated off the
 *     ramp boundaries whenever phase ≠ 0 (the user's "not always perfectly
 *     synchronized with the phase"). Each `apply` SUBTRACTS the same shift back out
 *     before storing, so the beads still write only `center` / `angle` /
 *     `wavelength` and `phase` is left alone — dragging a bead never silently
 *     rewrites the phase an author keyframed.
 *
 * IDENTITY (both beads). Each declares `glyph: "boxedO"` and a `label` — the
 * handle-identity protocol (core/registry.js, bank in core/handle_glyphs.js).
 * These beads are drawn ON TOP of the widget's own vertex/resize handles and were
 * previously the SAME yellow square, so the user's question "does it belong to
 * the shape or belong to the gradient?" (2026-08-02) had no answer short of
 * dragging one. The boxed-O keeps the square footprint (unchanged grab target)
 * and adds a ring plus the accent colour; the labels then say which bead is which
 * on hover.
 *
 * The `apply` of each bead returns `{[key]: <the whole rebuilt paint object>}`
 * because a modifier drag writes each apply-partial's top-level key straight to
 * the item (web/CanvasView.modifierDrag), and the gradient lives NESTED inside the
 * paint — so the write target is the paint field itself. The multi-sub-state
 * wrapper (or a legacy inline gradient) is rebuilt immutably, changing only the
 * one edited field.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { angleToLinearEndpoints, linearEndpointsToAngle, GRADIENT_DEFAULT_ANGLE, GRADIENT_DEFAULT_CENTER, GRADIENT_DEFAULT_PHASE, GRADIENT_DEFAULT_WAVELENGTH, GRADIENT_MIN_WAVELENGTH } from "./properties.js";

/**
 * Pure function. The ACTIVE gradient sub-state of a paint value, or null if the
 * paint is not a gradient (a solid string/array, a material, an equation, null).
 * Handles BOTH stored shapes the paint union uses: the multi-sub-state WRAPPER the
 * PaintField writes ({type, linear:{...}, radial:{...}}) and a LEGACY INLINE
 * gradient whose fields sit on the object itself ({type, stops, from/to|center/r}).
 * `wrapped` records which, so a writer patches the right place.
 *
 * @param {*} paint - any paint value
 * @returns {{type: string, subKey: string, g: object, wrapped: boolean}|null}
 *
 * @example activeGradient("#f00") // null
 * @example activeGradient(null) // null
 * @example activeGradient({type: "solid", solid: "#f00"}) // null
 * @example activeGradient({type: "linearGradient", linear: {stops: []}}).subKey // "linear"
 * @example activeGradient({type: "linearGradient", linear: {stops: []}}).wrapped // true
 * @example activeGradient({type: "linearGradient", stops: []}).wrapped // false (legacy inline)
 * @example activeGradient({type: "radialGradient", radial: {stops: [], center: {x: 0.5, y: 0.5}, r: 0.5}}).subKey // "radial"
 */
export function activeGradient(paint) {
  if (!paint || typeof paint !== "object" || Array.isArray(paint)) return null;
  if (paint.type === "linearGradient") {
    const wrapped = paint.linear != null;
    return { type: "linearGradient", subKey: "linear", g: wrapped ? paint.linear : paint, wrapped };
  }
  if (paint.type === "radialGradient") {
    const wrapped = paint.radial != null;
    return { type: "radialGradient", subKey: "radial", g: wrapped ? paint.radial : paint, wrapped };
  }
  return null;
}

/**
 * Pure function. A linear sub-state's objectBoundingBox axis {from, to}. The
 * stored `angle` (degrees) is authoritative (a keyframed angle tweens as a
 * rotating axis); a stored from/to is the legacy fallback, then the 0° default.
 * This mirrors render_gpu/ir.js linearAxis — duplicated (3 lines) rather than
 * imported to keep core/ from depending UP on render_gpu/.
 *
 * @param {object} g - the linear sub-state ({angle?, from?, to?})
 * @returns {{from: {x, y}, to: {x, y}}}
 *
 * @example linearAxisOf({angle: 0}) // {from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}}
 * @example linearAxisOf({angle: 90}) // {from: {x: 0.5, y: 0}, to: {x: 0.5, y: 1}}
 * @example linearAxisOf({from: {x: 0, y: 0}, to: {x: 1, y: 0}}) // {from: {x: 0, y: 0}, to: {x: 1, y: 0}} (legacy fallback)
 */
export function linearAxisOf(g) {
  if (g.angle != null && Number.isFinite(g.angle)) return angleToLinearEndpoints(g.angle);
  if (g.from != null && g.to != null) return { from: g.from, to: g.to };
  return angleToLinearEndpoints(GRADIENT_DEFAULT_ANGLE);
}

/** Pure function. Rebuilds a paint with `patch` merged onto its active gradient
 *  sub-state (into the .linear/.radial wrapper, or onto the object itself for a
 *  legacy inline gradient) — immutable, everything else preserved. */
function withGradientPatch(paint, ag, patch) {
  if (ag.wrapped) return { ...paint, [ag.subKey]: { ...paint[ag.subKey], ...patch } };
  return { ...paint, ...patch };
}

/**
 * Pure function. The PHASE SHIFT a linear gradient's drawn ramp carries, as a
 * MULTIPLE of the axis half-vector: `4·p·wavelength`, where p = phase mod 1. This
 * is the ONE number that keeps the beads on the picture — render_gpu/ir.js
 * linearGradientRender shifts the center by exactly `4·p·w·half` because the
 * mirror period is there-and-back over one wavelength each way. Duplicated here
 * (2 lines) rather than imported for the same reason linearAxisOf is: core/ does
 * not depend UP on render_gpu/.
 *
 * @example phaseShiftHalves({}) // 0 (no phase: the identity)
 * @example phaseShiftHalves({phase: 0.25, wavelength: 1}) // 1 (a quarter period is one half-vector)
 * @example phaseShiftHalves({phase: 0.5, wavelength: 0.5}) // 1
 * @example phaseShiftHalves({phase: 1, wavelength: 0.3}) // 0 (a whole cycle is identity, at any wavelength)
 * @example phaseShiftHalves({phase: -0.25, wavelength: 1}) // 3 (negative phase wraps to 0.75)
 */
export function phaseShiftHalves(g) {
  return 4 * wrappedPhase(g) * Math.max(GRADIENT_MIN_WAVELENGTH, g.wavelength ?? GRADIENT_DEFAULT_WAVELENGTH);
}

/**
 * Pure function. A gradient's phase folded into [0, 1) — the SAME wrap
 * render_gpu/ir.js linearGradientRender takes before shifting, so the beads and
 * the picture agree about which cycle they are on. JS `%` keeps the sign of its
 * left operand, hence the +1/%1 fixup for a negative phase.
 *
 * @example wrappedPhase({}) // 0
 * @example wrappedPhase({phase: 0.25}) // 0.25
 * @example wrappedPhase({phase: 1}) // 0
 * @example wrappedPhase({phase: -0.25}) // 0.75
 */
export function wrappedPhase(g) {
  const raw = g.phase ?? GRADIENT_DEFAULT_PHASE;
  return ((raw % 1) + 1) % 1;
}

/**
 * Pure function. The linear gradient's local-px frame: the STORED center
 * (`origin`, center × box), the axis HALF vector (axis half-vector × box), and
 * the phase `shift` vector the renderer adds to the center. The DRAWN center is
 * origin + shift and the DRAWN ramp end is origin + shift + wavelength·half —
 * where the two beads sit. The box scale (W, H) is carried so the polar inverse
 * can read a heading in objectBoundingBox space.
 */
function linearFrame(state, ag) {
  const W = state.w ?? 0, H = state.h ?? 0;
  const c = ag.g.center ?? GRADIENT_DEFAULT_CENTER;
  const { from, to } = linearAxisOf(ag.g);
  const half = { x: ((to.x - from.x) / 2) * W, y: ((to.y - from.y) / 2) * H };
  const k = phaseShiftHalves(ag.g);
  return { W, H, origin: { x: c.x * W, y: c.y * H }, half, shift: { x: k * half.x, y: k * half.y } };
}

/**
 * Pure function. THE POLAR INVERSE of the direction bead's placement: given the
 * bead's local-px offset from the STORED center, the {angle, multiple} such that
 * the offset IS `multiple · half(angle)` in local px.
 *
 * WHY THE OFFSET IS FROM THE STORED CENTRE AND THE ANSWER IS A BARE MULTIPLE
 * rather than a wavelength: the bead's placement is
 * `origin + (4p + 1)·wavelength·half(angle)`, so the phase shift and the ramp
 * length are BOTH proportional to `wavelength·half`. They cannot be inverted in
 * two steps — subtracting a phase shift computed from the OLD wavelength/angle
 * and then solving for a new one lands the bead somewhere else entirely (the
 * shift moved underneath the answer). Inverting the WHOLE map at once collapses
 * the two into the single multiplier `m = (4p + 1)·wavelength`, which the caller
 * divides by the (drag-invariant) `4p + 1` to recover the wavelength.
 *
 * THE HEADING IS TAKEN IN objectBoundingBox SPACE — deg = atan2(oy/H, ox/W) —
 * because the box aspect is a NON-UNIFORM scaling and would otherwise skew it.
 * The chord extent (0.5/max(|dx|,|dy|)) is a pure scale ALONG the heading, so it
 * only affects the length, which the projection then recovers.
 *
 * ROUND-TRIP EXACTNESS, measured rather than assumed. The projection is taken
 * against the half-vector `angleToLinearEndpoints` ACTUALLY returns (its `tidy()`
 * rounding included), so the length is recovered exactly for whatever angle got
 * stored. The ANGLE itself is quantized to 1e-6 degrees by that same `tidy()` —
 * deliberate, it is what lands the cardinal angles on exact 0/0.5/1 bbox
 * coordinates — so a drag's FIRST landing is off by the arc that quantization
 * subtends: under 3e-4 px over the shapes tests/paint_handles_test.js fuzzes,
 * i.e. sub-pixel, not bit-exact. A SECOND apply at the bead's own displayed
 * position IS bit-exact (measured 6e-14 px), because the angle is already
 * quantized by then — so the displayed bead is a true fixed point, which is the
 * property the handle protocol actually requires.
 *
 * A zero offset (or a degenerate box/axis) has no heading: `fallbackAngle` — the
 * gradient's currently stored angle — is kept, so a drag onto the center does not
 * spin the gradient to an arbitrary direction.
 *
 * Args:
 *   ox, oy (number): the bead's offset from the STORED center, LOCAL px
 *   W, H (number): the widget box extents, local px
 *   fallbackAngle (number): the angle to keep when the offset has no direction
 *
 * Returns:
 *   {angle: number, multiple: number} — `multiple` is unfloored and may be ≤ 0
 *   only in the degenerate cases (a real heading always projects positive)
 *
 * @example linearPolarInverse(100, 0, 200, 100, 0) // {angle: 0, multiple: 1} (the 0° whole-box axis, one half-vector out)
 * @example linearPolarInverse(0, -30, 200, 100, 0) // {angle: 270, multiple: 0.6} (straight up: a 270° axis, 0.6 of its half)
 * @example linearPolarInverse(-50, 25, 200, 100, 0) // {angle: 135, multiple: 0.5} (down-left in bbox space)
 * @example linearPolarInverse(0, 0, 200, 100, 45) // {angle: 45, multiple: 0} (no heading: the stored angle is kept)
 */
export function linearPolarInverse(ox, oy, W, H, fallbackAngle) {
  const bx = W === 0 ? 0 : ox / W, by = H === 0 ? 0 : oy / H;
  const angle = bx === 0 && by === 0 ? fallbackAngle : linearEndpointsToAngle({ x: 0, y: 0 }, { x: bx, y: by });
  const { from, to } = angleToLinearEndpoints(angle);
  const hx = ((to.x - from.x) / 2) * W, hy = ((to.y - from.y) / 2) * H;
  const denom = hx * hx + hy * hy;
  return { angle, multiple: denom === 0 ? 0 : (ox * hx + oy * hy) / denom };
}

/**
 * Pure function. THE gradient modifier points for a shape's paint field — spread
 * into a plugin's `modifierPoints(state)`. Returns [] when `state[key]` is not a
 * gradient (a solid/material/equation/absent fill contributes NO handles, so a
 * non-gradient widget is byte-identical to before this feature). A RADIAL gradient
 * yields one center bead; a LINEAR gradient yields a center bead plus a FREE polar
 * direction bead whose heading is the axis ANGLE and whose distance is the
 * WAVELENGTH (see the module docstring for the mapping and the phase placement).
 * Each point is {id, x, y, apply} in LOCAL px, the modifier-point contract —
 * NEITHER bead declares `constrain`, so both allow every point and
 * nodeModifierPoints defaults them to UNCONSTRAINED.
 *
 * @param {object} state - the folded item state (reads state[key], state.w, state.h)
 * @param {string} [key="fill"] - which paint field ("fill" or "stroke")
 * @returns {object[]} modifier-point rows
 *
 * @example paintModifierPoints({w: 100, h: 100, fill: "#f00"}, "fill") // [] (solid: no handles)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "material", material: {id: "comic"}}}, "fill") // [] (material: no handles)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0}}}, "fill").map((m) => m.id) // ["fill-grad-center", "fill-grad-dir"]
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0}}}, "fill")[0].y // 50 (center bead at box center)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0}}}, "fill")[1].x // 100 (direction bead at the ramp end: center + 1·half)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "linearGradient", linear: {stops: [], angle: 0, wavelength: 0.5}}}, "fill")[1].x // 75 (half-wavelength: center + 0.5·half)
 * @example paintModifierPoints({w: 100, h: 100, fill: {type: "radialGradient", radial: {stops: [], center: {x: 0.5, y: 0.5}, r: 0.5}}}, "fill").map((m) => m.id) // ["fill-grad-center"]
 */
export function paintModifierPoints(state, key = "fill") {
  const ag = activeGradient(state[key]);
  if (!ag) return [];
  const W = state.w ?? 0, H = state.h ?? 0;
  const c = ag.g.center ?? GRADIENT_DEFAULT_CENTER;
  // A radial gradient has no axis, so no phase shift applies to its center; a
  // linear one is displayed at the center the RENDERER draws (stored + phase).
  const shift = ag.type === "linearGradient" ? linearFrame(state, ag).shift : { x: 0, y: 0 };

  // CENTER bead (both kinds) — free. apply subtracts the phase shift back out and
  // writes the center in objectBoundingBox (local ÷ box); a zero-extent axis keeps
  // its coordinate (no fraction is derivable), the lens_flare division guard.
  const centerBead = {
    id: `${key}-grad-center`,
    x: c.x * W + shift.x, y: c.y * H + shift.y,
    // HANDLE IDENTITY (core/registry.js, core/handle_glyphs.js). These beads sit on
    // top of the widget's OWN vertex handles and used to be the same yellow square,
    // so "does this belong to the shape or to the gradient?" had no answer short of
    // dragging it. `boxedO` is the PAINT family's look — same square footprint, so
    // the grab target is unchanged, plus a ring and the accent colour.
    glyph: "boxedO",
    // The label names the SUBSYSTEM first ("Gradient…") because that is the
    // question; `key` disambiguates a shape carrying gradients on BOTH fill and
    // stroke, where two centre beads would otherwise read identically.
    label: `Gradient centre (${key})`,
    apply(st, allowed) {
      const a = activeGradient(st[key]);
      if (!a) return {};
      const cw = st.w ?? 0, ch = st.h ?? 0;
      const cur = a.g.center ?? GRADIENT_DEFAULT_CENTER;
      const sh = a.type === "linearGradient" ? linearFrame(st, a).shift : { x: 0, y: 0 };
      const sx = allowed.x - sh.x, sy = allowed.y - sh.y;
      return { [key]: withGradientPatch(st[key], a, { center: { x: cw === 0 ? cur.x : sx / cw, y: ch === 0 ? cur.y : sy / ch } }) };
    },
  };
  if (ag.type === "radialGradient") return [centerBead];

  // DIRECTION bead (linear only) — a FREE polar handle: heading sets the axis
  // ANGLE, distance sets the WAVELENGTH. No `constrain`: every point is allowed,
  // so a sideways drag turns the gradient. Displayed at the DRAWN ramp end
  // (center + phase shift + wavelength·half), which linearPolarInverse maps back
  // to exactly this {angle, wavelength} — so the bead is its own fixed point.
  const { origin, half } = linearFrame(state, ag);
  const wl = Math.max(GRADIENT_MIN_WAVELENGTH, ag.g.wavelength ?? GRADIENT_DEFAULT_WAVELENGTH);
  // `(4p + 1)·wavelength` — the phase shift and the ramp length in ONE multiplier
  // of the half-vector, which is the quantity apply inverts (see linearPolarInverse).
  const beadMultiple = (4 * wrappedPhase(ag.g) + 1) * wl;
  const directionBead = {
    id: `${key}-grad-dir`,
    x: origin.x + beadMultiple * half.x, y: origin.y + beadMultiple * half.y,
    // Same PAINT-family glyph as the centre bead: the two beads are one subsystem
    // and should read as a pair against the widget's vertex handles. Telling THEM
    // apart is the stem's job (it points from one to the other) and the label's.
    glyph: "boxedO",
    // The label states BOTH parameters this one bead writes, because that is the
    // non-obvious part after 6a4249e made it a free polar handle: heading → angle,
    // distance → wavelength, in a single drag.
    label: `Gradient angle + wavelength (${key})`,
    // A STEM back to the drawn centre — the standard cue for a polar handle. It
    // draws the axis the bead swings around, so the pivot and the radius (the two
    // things this one bead edits) are both visible before the drag starts.
    stem: { x: origin.x + shift.x, y: origin.y + shift.y },
    apply(st, allowed) {
      const a = activeGradient(st[key]);
      if (!a || a.type !== "linearGradient") return {};
      const f = linearFrame(st, a);
      const { angle, multiple } = linearPolarInverse(
        allowed.x - f.origin.x, allowed.y - f.origin.y, f.W, f.H,
        a.g.angle != null && Number.isFinite(a.g.angle) ? a.g.angle : GRADIENT_DEFAULT_ANGLE,
      );
      // `phase` is NOT rewritten by a bead drag, so 4p+1 is invariant across the
      // gesture and dividing it out recovers the wavelength the drag asked for.
      const wavelength = Math.max(GRADIENT_MIN_WAVELENGTH, multiple / (4 * wrappedPhase(a.g) + 1));
      return { [key]: withGradientPatch(st[key], a, { angle, wavelength }) };
    },
  };
  return [centerBead, directionBead];
}
