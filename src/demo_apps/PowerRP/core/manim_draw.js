/**
 * THE "MANIM" DRAW-IN — DrawBorderThenFill / Write, as a pure function of one
 * fractional visibility `v`.
 *
 * ── THE FEATURE (user request, 2026-08-02, verbatim, WORKSTREAM JJ) ───────────
 *   "Menom [Manim] actually has a really nice entry animation where the border
 *    is kind of drawn first and then the inside is filled and stuff like that…
 *    that should be an available visibility interpolation option. It can be
 *    called Menom [Manim] because it's such a classical Menom thing to do. When
 *    things enter in Menom, often they'll have little draw around animation."
 *
 * The user named the mode. This file is the ALGORITHM; core/interp_modes.js
 * registers the `manim` interp mode that mints the token, and render_gpu/ports.js
 * is the one seam that turns this module's answer into ops.
 *
 * The port contract is refs/manim_write_research.md (read at 2026-08-02 against
 * `ManimCommunity/manim@main` and `3b1b/manim@master`); every choice below cites
 * the section it came from, and the three places we deliberately DIVERGE are
 * argued at the point of divergence rather than in a list somewhere else.
 *
 * ── THE SHAPE OF THE ANSWER ──────────────────────────────────────────────────
 * ONE function, `manimDrawPlan(v, subpathCount)`, maps `v ∈ (0, 1)` to a plan:
 *
 *     {phase, trims: [t0, t1, …], fillAlpha, sketchWeight}
 *
 *   trims[i]      how much of subpath `i` is drawn, as a fraction of its own ARC
 *                 LENGTH (not its curve count — see below). 0 = not started,
 *                 1 = fully drawn.
 *   fillAlpha     the coverage the widget's REAL paint is drawn at (0 through
 *                 phase 0; ramping through phase 1).
 *   sketchWeight  how much of the SKETCH STROKE remains: 1 during the trace,
 *                 ramping to 0 as the real widget takes over. It is the same
 *                 lerp Manim's `interpolate_color` runs over stroke width and
 *                 colour together (research §2.2), expressed as ONE weight
 *                 because the consumer lerps both endpoints itself.
 *
 * The plan is GEOMETRY-FREE on purpose: it is a function of `v` and a COUNT.
 * Trimming the actual subpaths is `trimSubpathByLength` below, and pairing paint
 * is the caller's job (render_gpu/ports.js, which owns the paint seam already).
 * That split is what lets the whole phase/stagger law be tested in bare node
 * against three numbers, with no payload in hand.
 *
 * ── PHASE SPLIT: HARD 0.5, PORTED VERBATIM ───────────────────────────────────
 * `integer_interpolate(0, 2, v)` (research §1.1): v < 0.5 is phase 0 "trace the
 * border" with subalpha 2v; v ≥ 0.5 is phase 1 "fill it in" with subalpha 2v−1.
 * There is NO border/fill ratio knob anywhere in either Manim implementation
 * (§6), and inventing one here would be exceeding the thing we were asked to
 * port, not porting it. The phases do NOT overlap: the outline is FULLY traced
 * before any fill begins (§1.2).
 *
 * ── ARC LENGTH, NOT CURVE INDEX — THE ONE PLACE WE BEAT MANIM ────────────────
 * `pointwise_become_partial` parameterizes by CURVE INDEX over the whole flat
 * curve array (§3.1): a shape with one long straight edge and nine short curls
 * spends a tenth of the trace on the long edge, so the pen visibly races along
 * the straight and crawls around the curls. That is a real artifact of the
 * parameterization, named as a weakness in the research note itself.
 *
 * We have `curveLength` and `partialCubic` in core/morph_geometry.js — the arc
 * length machinery already exists, built for the morph engine's own
 * arc-length-over-chord-proxy argument — so the trim here is BY LENGTH and the
 * pen moves at a constant speed along the ink. tests/manim_mode_test.js pins
 * exactly this with a long-straight-plus-short-curl payload: at the halfway
 * trim the drawn ink is half the LENGTH, which a curve-index port gets visibly
 * wrong.
 *
 * ── THE STAGGER: ManimGL's `get_sub_alpha`, per SUBPATH ──────────────────────
 * Manim staggers FAMILY MEMBERS (§4.2) — for `Write(Text(…))` those happen to be
 * the glyphs. Our `morphPaths` payload is a flat subpath list with no family
 * tree, so each SUBPATH is one stagger unit. That is an ADAPTATION and is named
 * as one (§7.4 recommends exactly it); the formula itself is ported unchanged:
 *
 *     fullLength = (N − 1)·L + 1
 *     raw_i      = v·fullLength − i·L
 *     v_i        = clamp01(raw_i)
 *
 * WE TAKE ManimGL's FORM, NOT ManimCE's, in both halves of the formula, and both
 * picks are the research note's own recommendation rather than a coin flip:
 *
 *   - THE CLAMP. ManimGL clamps `raw_sub_alpha` explicitly; ManimCE relies on
 *     `integer_interpolate`'s downstream guards to do it (§4.1). Ours is
 *     unconditionally correct wherever the value flows, which matters here
 *     because the sub-v feeds a LENGTH fraction, not only a phase index — an
 *     unclamped 1.3 would ask `trimSubpathByLength` for 130% of a subpath.
 *   - THE DEFAULT LAG. ManimGL's `min(4/(N+1), 0.2)`, not ManimCE's
 *     `min(4/max(1,N), 0.2)` (§4.3). They disagree only for N ≥ 20 and by ≤5%,
 *     but ManimGL's has no discontinuous `max()` clause and is the simpler
 *     closed form. Naming which one, and that they differ, is the point.
 *
 * The 0.2 ceiling and the 4.0 numerator are MANIM'S OWN TUNED CONSTANTS, carried
 * across rather than re-derived — named below so a reader can see they are a
 * citation and not a local guess.
 *
 * ── THE RATE FUNCTION: `double_smooth`, AND WHY BOTH PHASES GET IT ───────────
 * `DrawBorderThenFill`'s default is `double_smooth` and `Write`'s is `linear`
 * (§1.2) — a deliberate upstream split, because Write's per-glyph stagger
 * already supplies the perceived easing and stacking a curve on top reads mushy.
 * We have ONE mode covering both cases, so the split is resolved the way the
 * geometry resolves it: `double_smooth` is applied to each SUBPATH'S OWN sub-v,
 * AFTER the stagger. A single-subpath widget therefore gets exactly
 * `DrawBorderThenFill`'s eased two-beat rhythm (N = 1 ⇒ the stagger is the
 * identity), and a many-subpath widget gets the stagger's cascade with each
 * piece eased inside its own window — which is §6's "the stagger supplies the
 * easing" in a form that does not need a mode-level flag distinguishing "text"
 * from "shape". The one thing this is NOT is Write's literal `linear`: a
 * per-piece ease inside a staggered cascade is strictly gentler than a global
 * ease, and no upstream default is contradicted by it.
 *
 * ── REVERSAL IS FREE, AND THAT IS A PROOF, NOT A HOPE (§8.3) ─────────────────
 * `manimDrawPlan` is a pure function of `v` with NO direction flag, no cached
 * "highest v seen" and no frame-to-frame carry. So `v` sweeping 1 → 0 runs the
 * identical formula backwards: the fill fades out first, and only once v drops
 * below 0.5 does the border un-trace (§8.2 — this is exactly what `Unwrite` and
 * `Uncreate` do, and they do it the same way: the SAME phase order, crossed in
 * the opposite direction, never a second code path). `double_smooth` is
 * SYMMETRIC — double_smooth(1−t) = 1 − double_smooth(t) — so a scrubbed exit is
 * an exact mirror of the entrance rather than a subtly-wrong fast-then-slow;
 * §8.3 names that symmetry as the precondition, and picking the symmetric rate
 * function is how it is met. tests/manim_mode_test.js pins the mirror identity
 * so a future rate-function change cannot break it quietly.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every function here is PURE: a function of its arguments alone, no clock, no
 * randomness, no ambient state, no memory of the previous frame. This mode is
 * PROPERTY STATE under CLAUDE.md's three-kinds law — reproducible under a
 * shuffle of time, computable from [[slide, alpha]] alone — which is what lets
 * cli/render_job.js shard a deck using it across machines by frame range.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { curveLength, curveTuple, partialCubic, subpathFromTuples } from "./morph_geometry.js";
// The shared fail-closed unit clamp. This file's own copy passed NaN through, and
// `trimSubpathByLength` is why that mattered: a NaN fraction is false for BOTH its
// `f <= 0` and `f >= 1` guards, so it fell into the trim math instead of returning
// the "draw nothing" / "draw whole" answers those guards exist to give.
import { clamp01Or0 as clamp01 } from "./unit_interval.js";

/**
 * THE PHASE BOUNDARY. Hard-coded at 0.5 in BOTH Manim implementations, across
 * every version the research note examined, with no constructor argument
 * anywhere that moves it (research §1.1, §6). Named rather than inlined so a
 * reader can see it is a citation and not a tuning knob we declined to expose.
 */
export const MANIM_PHASE_SPLIT = 0.5;

/**
 * Manim's `Write` lag numerator and its hard ceiling: `lag = min(4/(N+1), 0.2)`
 * (ManimGL `Write.compute_lag_ratio`, research §4.3). The ceiling stops a
 * one- or two-piece widget from staggering absurdly slowly; the 1/N falloff
 * keeps a hundred-piece widget finishing inside one transition. Both numbers are
 * upstream's, carried across unchanged.
 */
export const MANIM_LAG_NUMERATOR = 4.0;
export const MANIM_LAG_CEILING = 0.2;

/**
 * THE SKETCH STROKE'S WIDTH, in canvas units — Manim's literal `2`, translated.
 *
 * Manim's `2` is in camera-frame "Manim units", not pixels, and is deliberately
 * UNSCALED: a tiny icon and a full-screen shape sketch with the identical
 * nominal width (research §6). Our canvas unit is the same unit `strokeWidth`
 * already takes across every widget, and at the scale a slide's widgets actually
 * occupy, 2 canvas units reads as the thin sketch mark Manim's does — which is
 * the property being ported (a mark that looks hand-drawn), not the number.
 * The research note is explicit that copying the bare `2` without saying what
 * unit it landed in would be the mistake; this is that translation, stated.
 */
export const MANIM_SKETCH_STROKE_WIDTH = 2;

/**
 * Pure function. Manim's `smooth` rate function — the 3rd-order smoothstep
 * `3t² − 2t³`, zero derivative at both ends.
 *
 * @example smooth(0) // 0
 * @example smooth(1) // 1
 * @example smooth(0.5) // 0.5
 * @example smooth(0.25) // 0.15625
 */
export function smooth(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Pure function. Manim's `double_smooth`: `smooth` compressed into [0, 0.5] and
 * mirrored into [0.5, 1]. The curve eases in, eases to a STOP at the midpoint,
 * then eases in again — which is why the phase boundary is where the motion
 * visibly pauses (research §1.2, §6: "the detail that carries the feel").
 *
 * It is SYMMETRIC — `doubleSmooth(1 − t) === 1 − doubleSmooth(t)` — and that is
 * the property the reversal contract rests on (§8.3), not a coincidence.
 *
 * @example doubleSmooth(0) // 0
 * @example doubleSmooth(1) // 1
 * @example doubleSmooth(0.5) // 0.5 (the pause, exactly at the phase seam)
 * @example doubleSmooth(0.25) // 0.25 (half of smooth(0.5), which is 0.5)
 * @example [doubleSmooth(0.3) + doubleSmooth(0.7)] // [1] (the symmetry the exit needs)
 */
export function doubleSmooth(t) {
  const x = clamp01(t);
  return x < 0.5 ? 0.5 * smooth(2 * x) : 0.5 + 0.5 * smooth(2 * x - 1);
}

/**
 * Pure function. Manim's default `lag_ratio` for `N` stagger units — ManimGL's
 * closed form `min(4/(N+1), 0.2)` (research §4.3, whose recommendation this is).
 *
 * 0 would mean every subpath draws in lockstep; 1 would mean strictly one after
 * another. The default sits near the ceiling for a simple shape (so its few
 * contours overlap heavily and read as one gesture) and falls off as 1/N for a
 * many-contour icon or equation (so the whole thing still lands inside one
 * transition).
 *
 * @example manimLagRatio(1) // 0.2 (ceiling — a lone contour has nothing to lag against anyway)
 * @example manimLagRatio(5) // 0.2 (still at the ceiling: 4/6 = 0.667)
 * @example manimLagRatio(40) // 0.0975609756097561 (4/41 — the 1/N falloff has taken over)
 */
export function manimLagRatio(n) {
  return Math.min(MANIM_LAG_NUMERATOR / (n + 1), MANIM_LAG_CEILING);
}

/**
 * Pure function. ONE stagger unit's own progress — Manim's `get_sub_alpha`,
 * ManimGL form (explicit clamp, no `reverse_rate_function` branch: research
 * §4.1), with "family member index" read as "subpath index" per §7.4.
 *
 * Unit `i`'s window in overall-`v` terms is `[i·L/full, (i·L + 1)/full]`, so
 * raising the lag both DELAYS each unit and SHRINKS every unit's own window —
 * it is a window-length-plus-offset model, not a plain time shift.
 *
 * @param {number} v - overall progress in [0, 1]
 * @param {number} i - this unit's index, 0-based, in paint order
 * @param {number} n - how many units there are
 * @param {number} lag - the lag ratio (manimLagRatio(n) by default)
 * @returns {number} this unit's own progress, clamped to [0, 1]
 *
 * @example subUnitProgress(0.5, 0, 1, 0.2) // 0.5 (a lone unit is the identity)
 * @example subUnitProgress(0.5, 0, 3, 1) // 1 (fully sequential: unit 0 finished by v = 1/3)
 * @example subUnitProgress(0.5, 2, 3, 1) // 0 (and unit 2 has not started until v = 2/3)
 * @example subUnitProgress(0.5, 1, 3, 1) // 0.5 (the middle unit is exactly halfway at the midpoint)
 */
export function subUnitProgress(v, i, n, lag) {
  const fullLength = (n - 1) * lag + 1;
  return clamp01(v * fullLength - i * lag);
}

/**
 * Pure function. THE PLAN — `v ∈ [0, 1]` → what each subpath draws, how much
 * fill shows, and how much sketch stroke remains. This IS the mode, and it is
 * geometry-free: a function of a number and a count.
 *
 * The per-subpath progress runs through the stagger FIRST and `double_smooth`
 * SECOND (see the module docblock's rate-function note), then splits into the
 * two phases exactly as `integer_interpolate(0, 2, ·)` does.
 *
 * `fillAlpha` and `sketchWeight` are WIDGET-WIDE rather than per-subpath, and
 * that is Manim's own shape too: phase 1 is one `interpolate(outline, target)`
 * over the whole unit, with stroke width, stroke colour and fill ramping
 * TOGETHER over the same sub-alpha (§2.2). They are driven by the LAST subpath's
 * progress, because the widget is only truly filled once every contour has been
 * traced — taking the first subpath's would start filling while later contours
 * were still being drawn, which is the one thing "border THEN fill" says not to
 * do.
 *
 * Args:
 *   v (number): fractional visibility, [0, 1]
 *   subpathCount (number): how many subpaths the widget's outline has
 *   lag (number|undefined): stagger ratio; defaults to manimLagRatio(subpathCount)
 *
 * Returns:
 *   {phase, trims, fillAlpha, sketchWeight} — `phase` is 0 (tracing) or 1
 *   (filling), reported for callers and tests that want to name it
 *
 * @example manimDrawPlan(0, 1) // {phase: 0, trims: [0], fillAlpha: 0, sketchWeight: 1}
 * @example manimDrawPlan(1, 1) // {phase: 1, trims: [1], fillAlpha: 1, sketchWeight: 0}
 * @example manimDrawPlan(0.25, 1) // {phase: 0, trims: [0.5], fillAlpha: 0, sketchWeight: 1} (a quarter in, half the border drawn — double_smooth's own ramp)
 * @example manimDrawPlan(0.75, 1) // {phase: 1, trims: [1], fillAlpha: 0.5, sketchWeight: 0.5} (border complete, fill half up)
 * @example manimDrawPlan(0.5, 3, 1).trims // [1, 1, 0] (fully sequential: contour 0 done, contour 1 past its OWN border phase, contour 2 untouched)
 * @example manimDrawPlan(0.4, 3, 1).trims // [1, 0.352, 0] (contour 1 caught mid-trace, contour 2 not yet started)
 */
export function manimDrawPlan(v, subpathCount, lag = manimLagRatio(subpathCount)) {
  const n = Math.max(1, subpathCount);
  const trims = [];
  let lastEased = 0;
  for (let i = 0; i < n; i++) {
    const eased = doubleSmooth(subUnitProgress(clamp01(v), i, n, lag));
    // PHASE 0 OWNS [0, 0.5) AND ONLY PHASE 0 TRIMS. Past the boundary the border
    // is fully drawn and stays that way (§1.2's "no overlap"), so the trim
    // saturates at 1 rather than continuing to grow — `integer_interpolate`'s
    // own edge clamps, stated as arithmetic.
    trims.push(eased < MANIM_PHASE_SPLIT ? clamp01(eased / MANIM_PHASE_SPLIT) : 1);
    lastEased = eased;
  }
  // The widget fills on the LAST unit's clock — see the docblock. With no
  // stagger every unit shares one clock and this is the same number for all.
  const phase = lastEased < MANIM_PHASE_SPLIT ? 0 : 1;
  const fillAlpha = phase === 0 ? 0 : clamp01((lastEased - MANIM_PHASE_SPLIT) / (1 - MANIM_PHASE_SPLIT));
  return { phase, trims, fillAlpha, sketchWeight: 1 - fillAlpha };
}

/**
 * Pure function. THE SKETCH PAINT'S TIER LADDER, in order — Manim's
 * `get_stroke_color` (research §2.1) with its middle tier intact, as a LIST
 * rather than a chain of `??`.
 *
 * Precedence: (1) an explicit override, (2) the widget's OWN stroke when it has
 * a visible one, (3) its fill. The middle tier is the one a port loses by
 * accident, and losing it is visible: a widget with a red fill and a blue stroke
 * must sketch in BLUE, not red (§6 names exactly this).
 *
 * WHY A LIST AND NOT A VALUE (WORKSTREAM AO, user ruling 2026-08-02): "wouldn't
 * it make sense to use the material stroke if provided for the manum entry
 * effect instead of always using white? … if I select a red stroke, then the
 * manum effect should use that stroke, or a material stroke, then manum should
 * use that material stroke to draw." A tier's answer is now ANY paint — a
 * colour string, a gradient, a material — and not every paint can be STROKED
 * WITH (a fill-only material like `crt` has no stroke renderer at all). So a
 * tier can be REFUSED, and a refusal must fall through to the NEXT tier rather
 * than to nothing: that is a decision only the render side can make, because
 * only it holds the stroke-material roster. Returning the ladder lets the caller
 * walk it and stop at the first tier it can actually draw.
 *
 * The previous shape — return one value, caller drops it if it is not a string —
 * is exactly what the user was seeing: a material-inked widget's sketch was
 * dropped ENTIRELY, so nothing was drawn and the ink underneath read as the
 * whole animation.
 *
 * @param {object} paint - {fill, stroke, strokeWidth} as morph payloads carry it
 * @param {*} override - an explicit sketch paint, or null
 * @returns {Array} the candidate paints, best first; possibly empty
 *
 * @example sketchPaintTiers({fill: "#ff0000", stroke: "#0000ff", strokeWidth: 3}) // ['#0000ff', '#ff0000'] (an existing stroke leads, the fill backs it)
 * @example sketchPaintTiers({fill: "#ff0000", stroke: "#0000ff", strokeWidth: 0}) // ['#ff0000'] (a zero-width stroke draws nothing, so it is not a tier)
 * @example sketchPaintTiers({fill: "#ff0000"}) // ['#ff0000']
 * @example sketchPaintTiers({fill: "#ff0000"}, "#00ff00") // ['#00ff00', '#ff0000'] (the override leads; the fill still backs it up)
 * @example sketchPaintTiers({}) // []
 * @example // A MATERIAL STROKE IS A TIER, not something to drop — the ruling above:
 * @example sketchPaintTiers({fill: "#ff0000", stroke: {type: "material", material: {id: "wavy"}}, strokeWidth: 3}).length // 2
 */
export function sketchPaintTiers(paint, override = null) {
  const tiers = [];
  if (override) tiers.push(override);
  const stroke = paint?.stroke;
  if (stroke && (paint?.strokeWidth ?? 0) > 0) tiers.push(stroke);
  if (paint?.fill != null) tiers.push(paint.fill);
  return tiers;
}

/**
 * Pure function. THE FIRST TIER A CALLER CAN ACTUALLY DRAW — `sketchPaintTiers`
 * walked with the caller's own acceptance predicate.
 *
 * Split from the ladder itself so `core/` never has to know what a renderer can
 * paint (it may not import `render_gpu/` — the layering rule), while the WALK,
 * which is the part with an off-by-one in it, stays here where it is testable in
 * bare node against a predicate of your choosing.
 *
 * `null` when NO tier is drawable — the caller decides what a widget with
 * nothing paintable sketches with, because only it knows what else is in the op.
 *
 * @param {object} paint - {fill, stroke, strokeWidth}
 * @param {(p: *) => boolean} canPaint - is this paint strokeable by the caller?
 * @param {*} override - an explicit sketch paint, or null
 * @returns {*} the winning paint, or null
 *
 * @example sketchStrokePaint({fill: "#ff0000", stroke: "#0000ff", strokeWidth: 3}, (p) => true) // '#0000ff'
 * @example // A FILL-ONLY MATERIAL IS REFUSED AND THE LADDER CONTINUES — it does not
 * @example // fail, and it does not silently draw nothing (WORKSTREAM AO):
 * @example sketchStrokePaint({fill: "#ff0000", stroke: {type: "material", material: {id: "crt"}}, strokeWidth: 3}, (p) => typeof p === "string") // '#ff0000'
 * @example sketchStrokePaint({}, (p) => true) // null
 */
export function sketchStrokePaint(paint, canPaint, override = null) {
  for (const tier of sketchPaintTiers(paint, override)) if (canPaint(tier)) return tier;
  return null;
}

/**
 * Pure function. Each curve's arc length, plus the total — the measurement the
 * trim is defined against, split out so a caller trimming the same subpath at
 * many `v` values pays for it once.
 *
 * @param {object} sp - a Subpath (core/morph.js's payload vocabulary)
 * @returns {{lengths: number[], total: number}}
 *
 * @example subpathLengths({start: [0, 0], curves: [[1, 0, 2, 0, 3, 0]], closed: false}).total // 3
 * @example subpathLengths({start: [0, 0], curves: []}).total // 0 (a dot subpath has no length)
 */
export function subpathLengths(sp) {
  const lengths = sp.curves.map((_, i) => curveLength(curveTuple(sp, i)));
  return { lengths, total: lengths.reduce((a, b) => a + b, 0) };
}

/**
 * Pure function. THE ARC-LENGTH TRIM — the leading `fraction` of a subpath's own
 * LENGTH, as a subpath.
 *
 * This is the port's one deliberate improvement on Manim (module docblock):
 * `pointwise_become_partial` slices by curve INDEX, so a long straight edge and
 * a short curl each consume the same share of the trace and the pen's speed
 * jumps between them. Slicing by length makes the pen move at a constant rate
 * along the ink, which is what a hand drawing a shape actually does.
 *
 * A TRIMMED SUBPATH IS NEVER `closed`, whatever the source was: a partially
 * drawn ring has an open end, structurally, until the fraction reaches 1 — and
 * an SVG `Z` would both close the gap and join the stroke there, painting a seam
 * the trace has not reached yet.
 *
 * A ZERO-LENGTH subpath (a dot, a degenerate contour) is returned UNCHANGED at
 * any positive fraction and empty at zero: there is no "half" of a point, and
 * splitting the difference would make a dot flicker rather than appear.
 *
 * @param {object} sp - a Subpath
 * @param {number} fraction - [0, 1] of the subpath's arc length
 * @param {{lengths: number[], total: number}|undefined} measured - precomputed subpathLengths(sp)
 * @returns {object|null} a Subpath, or null when nothing is drawn yet
 *
 * @example trimSubpathByLength({start: [0, 0], curves: [[1, 0, 2, 0, 3, 0]], closed: false}, 0) // null
 * @example trimSubpathByLength({start: [0, 0], curves: [[1, 0, 2, 0, 3, 0]], closed: false}, 1).curves.length // 1
 * @example // HALF THE LENGTH, not half the curves: a long edge then a short one
 * @example trimSubpathByLength({start: [0, 0], curves: [[1, 0, 2, 0, 3, 0], [3.1, 0, 3.2, 0, 3.3, 0]], closed: false}, 0.5).curves.length // 1 (still inside the LONG first curve)
 * @example trimSubpathByLength({start: [0, 0], curves: [], closed: false}, 0.5).curves // [] (a dot draws whole or not at all)
 */
export function trimSubpathByLength(sp, fraction, measured = undefined) {
  const f = clamp01(fraction);
  if (f <= 0) return null;
  if (f >= 1) return sp;
  const { lengths, total } = measured ?? subpathLengths(sp);
  // A DOT / DEGENERATE CONTOUR has no length to divide, so there is no honest
  // partial state — it is either drawn or it is not, and it is drawn the moment
  // the trace reaches it.
  if (total <= 0) return sp;
  const target = f * total;
  const tuples = [];
  let cum = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (cum + lengths[i] <= target) {
      tuples.push(curveTuple(sp, i));
      cum += lengths[i];
      continue;
    }
    // THE STRADDLING CURVE. `localT` is a LENGTH fraction read as a Bézier
    // PARAMETER, which is an approximation — the two agree exactly only for a
    // constant-speed curve. It is the same approximation `curveLength`'s own
    // 8-sample estimate already makes and that the morph engine's ranking
    // already trusts, and it is bounded within ONE curve, so the error can never
    // accumulate along the path the way a curve-index parameterization's does.
    if (lengths[i] > 0) {
      const localT = (target - cum) / lengths[i];
      tuples.push(partialCubic(curveTuple(sp, i), 0, localT));
    }
    break;
  }
  if (!tuples.length) return null;
  return subpathFromTuples(tuples, { closed: false, paint: sp.paint });
}
