/**
 * THE MORPH ENGINE — one widget's outline becoming another's, continuously.
 *
 * This is the 3Blue1Brown/Manim shape morph: a circle becoming a square, an
 * iconify glyph becoming an SVG logo, one LaTeX expression becoming the next,
 * with every contour flowing into its counterpart rather than crossfading. The
 * algorithm is Manim's, ported per refs/manim_morph_research.md; the three
 * places we deliberately beat it (winding reconciliation, cyclic start-point
 * search, structure-aware fast-out) are argued in core/morph_align.js's header.
 *
 * ── PHASE 1 OF 2 ─────────────────────────────────────────────────────────────
 * THIS FILE IS THE ENGINE ONLY. Nothing here is wired into the app yet: no
 * plugin produces a MorphPaths, no interp mode calls `morphPaths`, and no
 * renderer consumes its output. Phase 2 does that wiring — it registers a
 * `morph` interp mode whose `blend(a, b, alpha, ctx)` (core/interp_modes.js)
 * calls into this module, and it teaches shape/svg/iconify (and later latex,
 * and later text via CanvasKit glyph outlines) to emit the payload. The API
 * below is shaped for exactly that call: a PURE function of
 * (fromPayload, toPayload, alpha), with no animation object, no item id and no
 * slide index anywhere in it.
 *
 * ── THE MORPHPATHS CURRENCY (the payload phase 2's plugins will produce) ─────
 * ONE type flows through this engine, and it is the only thing a morph may ask a
 * widget for:
 *
 *     MorphPaths = {
 *       space:    {w, h},            // the box-local space these coords live in
 *       subpaths: [Subpath],         // in PAINT ORDER (first painted first)
 *       fillRule: "nonzero" | "evenodd",
 *     }
 *
 *     Subpath = {
 *       start:   [x, y],                         // the M point, box-local, y-DOWN
 *       curves:  [[c1x,c1y,c2x,c2y,ex,ey], …],   // CUBICS ONLY, start implied
 *       closed:  boolean,                        // the trailing Z
 *       winding: 1 | -1,                         // +1 = CLOCKWISE ON SCREEN
 *       paint?:  {fill, stroke, strokeWidth, opacity},
 *     }
 *
 * Every field earns its place, and each one is a class of bug this codebase has
 * already been bitten by at least once:
 *
 *   - CUBICS ONLY, with L/H/V/Q/A pre-elevated by the provider. Every backend
 *     already requires it (core/shapes.js's header: "only lines + beziers, never
 *     arcs"; the PDF backend rejects `A`), and it collapses the alignment code to
 *     ONE case instead of seven. A line elevates to a cubic with handles at the
 *     1/3 and 2/3 points; a quadratic elevates EXACTLY via
 *     c1 = p0 + 2/3(q - p0), c2 = p2 + 2/3(q - p2). Neither is an approximation.
 *
 *   - START + IMPLIED-START CURVES, not ManimCE's flat [a1,h1,h2,a2] array. That
 *     packing stores each shared anchor TWICE and relies on the two copies
 *     staying numerically equal through the lerp. Storing it once removes the
 *     invariant, and it is already the shape core/svg_paths.js `arcToCubics`
 *     returns and `transformPathD` emits.
 *
 *   - `closed` EXPLICIT, never re-derived from coincident endpoints. In SVG a
 *     `Z` is not "a line back to the start" — it also JOINS the stroke there,
 *     which changes the painted seam. Manim has no closed flag at all and
 *     therefore cannot even express, let alone decide, a closed↔open morph.
 *
 *   - `winding` COMPUTED BY THE PROVIDER, in SCREEN space (+1 = clockwise, since
 *     this frame is y-DOWN). Asking the provider means the engine never guesses a
 *     frame convention. It is nonetheless RE-DERIVED here (morph_align
 *     `normalizePayload`) so a provider that computed it in Manim's y-UP sense
 *     cannot silently invert every pairing decision — the field is advisory.
 *
 *   - `space`, NOT raw coordinates. The two widgets have different boxes, and
 *     those boxes ALREADY tween as ordinary property state through
 *     core/interpolators.js. Interpolating raw box-local coordinates while the
 *     boxes also tween would count the box change twice, so this engine works in
 *     a shared UNIT box and hands back unit-space output for the consumer to map
 *     out through the (separately tweened) box.
 *
 *   - `paint` PER SUBPATH, not per widget: an SVG icon's subpaths genuinely have
 *     different fills, and core/svg_paths.js `flattenSvgTree` already returns
 *     per-path paint. Paint is NOT blended here — phase 2 hands it to
 *     core/interpolators.js, which already lerps hex colors including the alpha
 *     channel and already snaps unlike values discretely. Hand-rolling a color
 *     lerp is how the two diverge.
 *
 * ── THE GEOMETRY LAW ─────────────────────────────────────────────────────────
 * Payloads arrive ALREADY unsignedState-normalized. A stored w/h may be NEGATIVE
 * in this app — that is a REFLECTION, and it is how Flip is stored — and it is
 * resolved at core/geometry.js `normalizedBox`/`unsignedState` BEFORE any plugin
 * or engine sees it (the NEGATIVE EXTENTS protocol's "one map with two
 * entrances"). This engine does NOT handle signs; `assertMorphPaths` REFUSES a
 * negative space loudly. Morphing a flipped shape against an unflipped one sends
 * every point across the box, and that exact bug lived in core/expressions.js
 * until 0570dff — it is precedent, not paranoia.
 *
 * ── DETERMINISM (the three-kinds-of-state law) ───────────────────────────────
 * A morph is PROPERTY STATE: reproducible under a shuffle of time, computable
 * from [[slide, alpha]] alone. Everything in this module family is a pure
 * function of its arguments — no Date, no performance, no Math.random, no
 * ambient clock, no frame-to-frame carry. Every tie-break is stated explicitly
 * (lowest index wins) rather than left to a sort's stability, because two
 * renderers disagreeing on a tie would draw two different frames for one
 * document, and cli/render_job.js shards a render across machines by frame range.
 *
 * ── THE CACHE IS AN OPTIMIZATION, NOT A SEMANTIC ─────────────────────────────
 * Manim computes alignment ONCE in `Transform.begin()` and lerps per frame; it
 * can, because it has a Transform object with a lifetime. We have no such thing —
 * `evaluateState` is called at arbitrary [[slide, alpha]], in any order, on any
 * machine. So alignment here is a PURE FUNCTION OF THE TWO PAYLOADS, memoized on
 * their CONTENT and on nothing else. Keying it on an item id or a slide index
 * would make the result depend on where in the document you are, which is exactly
 * what the property-state law forbids. `morphPaths` with a cold cache and
 * `morphPaths` with a warm one return identical arrays, and clearing the cache
 * mid-render is a performance event and never a visual one — `clearMorphCache`
 * exists so a test can prove that.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { alignPayloads, normalizePayload, structureSignature } from "./morph_align.js";
import { subpathToPathD } from "./morph_geometry.js";
import { matchSubpaths, travelledSubpath } from "./morph_match.js";
import { midMorphFillRule } from "./morph_fill.js";

export { alignPayloads, structureSignature, assertMorphPaths } from "./morph_align.js";
export { subpathToPathD, sampleSubpath } from "./morph_geometry.js";
export { matchSubpaths, shapeKey, travelledSubpath } from "./morph_match.js";
export { hasSameWindingOverlap, midMorphFillRule } from "./morph_fill.js";

/**
 * The alignment memo. Keyed on a CONTENT hash of the two payloads (see the
 * module header) — never on an item, a slide or a time. Bounded, because a
 * scrubbing session over a deck with many morphing pairs would otherwise grow it
 * without limit and nothing else would ever evict it.
 */
const alignCache = new Map();

/** Distinct (from, to) content pairs held before the oldest is evicted. A morph
 * transition touches ONE pair per frame, so even a deck where every slide morphs
 * a different pair re-uses its entry across every frame of its own transition;
 * 256 is far more pairs than a single document has, and the eviction exists to
 * bound a long session rather than to be hit in practice. */
const ALIGN_CACHE_LIMIT = 256;

/**
 * Pure function. A stable content key for one MorphPaths — the same payload
 * always produces the same string, and two payloads that would align identically
 * produce the same string. Coordinates go in at full precision: rounding here
 * would collide two genuinely different shapes, and the cost of a long key is a
 * string compare, not a render.
 *
 * @example
 * >>> const p = {space: {w: 2, h: 2}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], curves: [[0, 0, 1, 1, 2, 2]], closed: true, winding: 1}]};
 * >>> payloadKey(p) === payloadKey(p)
 * true
 * >>> payloadKey(p)
 * '2x2|nonzero|0,0;0,0,1,1,2,2|1'
 */
export function payloadKey(payload) {
  const parts = payload.subpaths.map(
    (sp) => `${sp.start[0]},${sp.start[1]};${sp.curves.map((c) => c.join(",")).join(";")}|${sp.closed ? 1 : 0}`);
  return `${payload.space.w}x${payload.space.h}|${payload.fillRule}|${parts.join("/")}`;
}

/**
 * Query (reads and writes the module-level memo; the RESULT is a pure function
 * of the arguments). The aligned pair for two payloads — `alignPayloads`, with
 * the answer remembered by content.
 *
 * Returns the SAME object on a cache hit, so callers must treat the result as
 * READ-ONLY. `morphAt` only reads it.
 *
 * @example
 * >>> const p = {space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], closed: true, winding: 1, curves: [[0,0,0,0,1,0],[0,0,0,0,0,0]]}]};
 * >>> alignedPair(p, p) === alignedPair(p, p)   // second call is the memo
 * true
 */
export function alignedPair(fromPayload, toPayload) {
  const key = payloadKey(fromPayload) + "»" + payloadKey(toPayload);
  const hit = alignCache.get(key);
  if (hit) return hit;
  const aligned = alignPayloads(fromPayload, toPayload);
  if (alignCache.size >= ALIGN_CACHE_LIMIT) alignCache.delete(alignCache.keys().next().value);
  alignCache.set(key, aligned);
  return aligned;
}

/**
 * Query (reads and writes the module-level memo; the RESULT is a pure function of
 * the arguments). THE MATCHED-PIECE PLAN for two payloads — which subpaths are
 * congruent and therefore TRAVEL, and the aligned pair for everything left over.
 *
 * Memoized on the SAME content key `alignedPair` uses, plus a marker, so a
 * content morph costs ONE matching pass per transition rather than one per frame
 * — the property core/morph_property.js's endpoint law already guarantees by
 * fixing both endpoints for the whole transition.
 *
 * Returns `{matched, from, to}`: `matched` is a list of `{a, b}` unit-space
 * subpath pairs to travel, and `from`/`to` are the structurally-aligned leftovers
 * (possibly empty). Treat the result as READ-ONLY — it is shared across frames.
 *
 * @example
 * >>> // two payloads with nothing congruent: everything falls to the alignment
 * >>> const p = (x) => ({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [x, 0], closed: false, winding: 1, curves: [[0,0,0,0,x+0.5,0.5]]}]});
 * >>> matchedPlan(p(0), p(0.2)).matched.length
 * 0
 */
export function matchedPlan(fromPayload, toPayload) {
  const key = "match»" + payloadKey(fromPayload) + "»" + payloadKey(toPayload);
  const hit = alignCache.get(key);
  if (hit) return hit;

  // Matching runs in UNIT SPACE, for the reason core/morph_align.js normalizes
  // before pairing: the two widgets have different boxes, and a hash computed in
  // raw box coordinates would call the same glyph two different shapes.
  const A = normalizePayload(fromPayload), B = normalizePayload(toPayload);
  const pairs = matchSubpaths(A.subpaths, B.subpaths);
  const matchedFrom = new Set(pairs.map((p) => p[0]));
  const matchedTo = new Set(pairs.map((p) => p[1]));
  const restFrom = A.subpaths.filter((_, i) => !matchedFrom.has(i));
  const restTo = B.subpaths.filter((_, i) => !matchedTo.has(i));

  // The leftovers are aligned as an ordinary pair. Both sides are ALREADY in unit
  // space, so this re-normalization is the identity — `alignPayloads` is called
  // with unit spaces rather than the originals precisely so the matched pieces
  // and the morphed ones end up in ONE coordinate system.
  const rest = (restFrom.length || restTo.length)
    ? alignPayloads(
        { space: { w: 1, h: 1 }, subpaths: restFrom, fillRule: A.fillRule },
        { space: { w: 1, h: 1 }, subpaths: restTo, fillRule: B.fillRule })
    : { from: { space: { w: 1, h: 1 }, subpaths: [], fillRule: A.fillRule },
        to: { space: { w: 1, h: 1 }, subpaths: [], fillRule: B.fillRule } };

  const plan = {
    matched: pairs.map(([fi, ti]) => ({ a: A.subpaths[fi], b: B.subpaths[ti] })),
    from: rest.from,
    to: rest.to,
  };
  if (alignCache.size >= ALIGN_CACHE_LIMIT) alignCache.delete(alignCache.keys().next().value);
  alignCache.set(key, plan);
  return plan;
}

/**
 * Command (clears the module-level memo). Drops every cached alignment. This is
 * a PERFORMANCE event and never a visual one — a test calls it to prove that
 * `morphPaths` returns identical output cold and warm, and a long-running editor
 * could call it to reclaim memory. Nothing about a rendered frame changes.
 *
 * @example
 * >>> clearMorphCache()   // returns nothing; the next morph re-aligns
 * undefined
 */
export function clearMorphCache() {
  alignCache.clear();
}

/**
 * Pure function. THE MORPH. Two MorphPaths payloads and an alpha in [0, 1] →
 * the intermediate MorphPaths.
 *
 * This is the function phase 2 calls, and it is the whole public contract: no
 * animation object, no item, no time. Given the same two payloads and the same
 * alpha it returns the same numbers on every machine, which is what lets
 * cli/render_job.js render frame 200 without having rendered frame 199.
 *
 * The interpolation itself is Manim's `straight_path`: a plain elementwise lerp
 * of the aligned control arrays. HANDLES ARE LERPED AS ORDINARY POINTS — there
 * is no tangent- or curvature-aware blending, in Manim or here, and that is
 * correct rather than lazy: a lerp of control points is AFFINE, so two curves
 * that are both exactly straight stay exactly straight at every intermediate
 * alpha, and a subpath whose ends coincide at both endpoints has them coincide
 * throughout. (Manim gets closedness preservation for free from this fact alone.)
 *
 * ENDPOINTS ARE EXACT, and by SHORT-CIRCUIT rather than by trusting float
 * arithmetic: at alpha ≤ 0 the `from` payload is returned unchanged and at
 * alpha ≥ 1 the `to` payload is, byte-for-byte, with no alignment run at all.
 * That is both a correctness guarantee (the endpoint law) and the promise that a
 * deck which never scrubs is untouched by this feature — the same
 * identity-preservation core/svg_paths.js `degenerateCapSplit` makes when nothing
 * in a path was degenerate.
 *
 * DISCRETE FIELDS follow this codebase's own rule, not a new one:
 * core/interpolators.js snaps unlike-shaped values "as soon as alpha > 0", so
 * `closed` and `fillRule` take the TARGET's value for the whole open interval.
 * There is no half-`Z` — a `Z` joins the stroke, and a join cannot appear
 * gradually. See core/morph_align.js's header for the full argument.
 *
 * MATCHED PIECES (`options.matchPieces`, default OFF) is the one behavioural
 * switch this function has, and it is off by default on purpose: every existing
 * caller and every law in tests/morph_test.js describes the whole-shape morph, so
 * the flag cannot change any picture the app draws today. Turned on — which
 * core/derive.js does for a SAME-TYPE content morph — congruent subpaths TRAVEL
 * instead of morphing (core/morph_match.js). A type morph (rect → gear) leaves it
 * off, because matching is meaningless when the two shapes share no pieces.
 *
 * @param {object} fromPayload - MorphPaths, already unsignedState-normalized
 * @param {object} toPayload - MorphPaths, already unsignedState-normalized
 * @param {number} alpha - transition progress in [0, 1]
 * @param {object} [options] - `{matchPieces: boolean}`; absent means whole-shape
 * @returns {object} the intermediate MorphPaths, in UNIT space (the caller maps
 *   it back out through the separately-tweened box — see the header's `space` note)
 *
 * @example
 * >>> const line = (ex, ey) => ({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], closed: false, winding: 1, curves: [[0, 0, 0, 0, ex, ey]]}]});
 * >>> morphPaths(line(1, 0), line(1, 1), 0.5).subpaths[0].curves[0]
 * [0, 0, 0, 0, 1, 0.5]
 * >>> // the endpoint law: alpha 0 IS the from payload, byte-for-byte
 * >>> morphPaths(line(1, 0), line(1, 1), 0) === line(1, 0)
 * false
 * >>> morphPaths(line(1, 0), line(1, 1), 0).subpaths[0].curves[0]
 * [0, 0, 0, 0, 1, 0]
 */
export function morphPaths(fromPayload, toPayload, alpha, options = null) {
  if (!(alpha > 0)) return fromPayload;
  if (alpha >= 1) return toPayload;

  // THE MATCHED-PIECE ARM. The endpoint short-circuits above run FIRST and are
  // untouched by it, so the endpoint law holds identically in both arms.
  if (options && options.matchPieces) {
    const plan = matchedPlan(fromPayload, toPayload);
    const travelled = plan.matched.map(({ a, b }) => travelledSubpath(a, b, alpha));
    const morphed = plan.from.subpaths.map((a, i) => lerpSubpath(a, plan.to.subpaths[i], alpha));
    // Matched pieces first, then the morphing leftovers. Paint order within a
    // morph is not meaningful to preserve — the two endpoints disagree about it
    // by construction — and a stated order beats an emergent one.
    return withMidMorphFillRule({ space: { w: 1, h: 1 }, subpaths: [...travelled, ...morphed], fillRule: plan.to.fillRule });
  }

  const { from, to } = alignedPair(fromPayload, toPayload);
  const subpaths = from.subpaths.map((a, i) => lerpSubpath(a, to.subpaths[i], alpha));
  return withMidMorphFillRule({ space: { w: 1, h: 1 }, subpaths, fillRule: to.fillRule });
}

/**
 * Pure helper. A mid-morph payload with its PAINTED fill rule decided — the
 * counter-fill fix (core/morph_fill.js, workstream XX-1).
 *
 * Applied at the two interior return sites and NOWHERE ELSE, which is what keeps
 * it invisible outside the open interval: `morphPaths` short-circuits to the
 * ORIGINAL payloads at alpha ≤ 0 and alpha ≥ 1 before either site is reached, so
 * no stored `fillRule` is ever rewritten and the endpoint law is untouched.
 *
 * @example
 * >>> // one contour cannot have a nested counter, so nothing changes:
 * >>> withMidMorphFillRule({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], closed: true, winding: 1, curves: [[0,0,0,0,1,1]]}]}).fillRule
 * 'nonzero'
 */
function withMidMorphFillRule(payload) {
  const fillRule = midMorphFillRule(payload);
  return fillRule === payload.fillRule ? payload : { ...payload, fillRule };
}

/**
 * Pure helper. One ALIGNED pair of subpaths lerped elementwise — Manim's
 * `straight_path` on a single slot. Both arms of `morphPaths` call it, so the
 * whole-shape morph and the matched-piece arm's leftovers cannot drift apart in
 * how they treat `closed`, `winding` or `paint`.
 *
 * The two subpaths MUST already be structurally identical (same curve count);
 * that is exactly what alignment guarantees, and it is why this is private.
 *
 * @example
 * >>> // a straight cubic sliding its end point from (1,0) to (1,1), halfway:
 * >>> lerpSubpath({start: [0, 0], closed: false, winding: 1, curves: [[0,0,0,0,1,0]]},
 * ...             {start: [0, 0], closed: false, winding: 1, curves: [[0,0,0,0,1,1]]}, 0.5).curves[0]
 * [0, 0, 0, 0, 1, 0.5]
 */
function lerpSubpath(a, b, alpha) {
  const sp = {
    start: [lerp(a.start[0], b.start[0], alpha), lerp(a.start[1], b.start[1], alpha)],
    curves: a.curves.map((c, j) => c.map((v, k) => lerp(v, b.curves[j][k], alpha))),
    // DISCRETE, at alpha > 0, to the target — this codebase's unlike-value rule.
    closed: !!b.closed,
    winding: b.winding,
  };
  if (b.paint) sp.paint = b.paint;
  else if (a.paint) sp.paint = a.paint;
  return sp;
}

/** Pure helper. Linear interpolation, local so this module has no import cycle
 * with core/interpolators.js (which phase 2's interp mode imports the other way
 * round). Identical semantics to interpolators.lerp — deliberately NOT its
 * integer-rounding `interpolate`, since coordinates must stay continuous.
 *
 * @example
 * >>> lerp(0, 10, 0.25)
 * 2.5
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pure function. A MorphPaths → the SVG path `d` string it draws — every subpath
 * concatenated, each as one `M` plus a `C` per curve plus a `Z` when closed.
 *
 * NO NEW IR OP IS NEEDED, and that is the point: this is exactly the input
 * render_gpu/ir.js's `path({d, fill, stroke, strokeWidth, fillRule, opacity})`
 * already takes — the op core/svg_paths.js's header calls "the ONE op behind …
 * any future arbitrary-path widget". Phase 2's renderer wiring is therefore a
 * `d` string handed to an existing op, not a new painter.
 *
 * @example
 * >>> payloadToPathD({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], closed: true, winding: 1, curves: [[0, 0, 1, 1, 2, 2]]}]})
 * 'M0 0C0 0 1 1 2 2Z'
 * >>> payloadToPathD({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: []})
 * ''
 */
export function payloadToPathD(payload) {
  return payload.subpaths.map(subpathToPathD).join("");
}
