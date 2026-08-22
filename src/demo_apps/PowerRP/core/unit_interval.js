/**
 * THE UNIT-INTERVAL CLAMPS — confining a number to [0, 1], which this app does
 * everywhere: an alpha, a reveal fraction, a gradient stop offset, a tween
 * parameter, an opacity attribute.
 *
 * ── WHY TWO FUNCTIONS AND NOT ONE ────────────────────────────────────────────
 * There were NINE hand-written copies of `clamp01` across core/, plugins/ and
 * render_gpu/, and they did not agree. On a good number every one of them returns
 * the same thing; they differ only on a DEGENERATE input (NaN, undefined, null, a
 * numeric string), and there they split into contracts that are not merely
 * different but OPPOSITE. Measured:
 *
 *              0.5   -3    2     NaN         undefined    null    "0.7"
 *   Or0        0.5   0     1     0           0            0       0
 *   Or1        0.5   0     1     1           1            1       1
 *
 * `core/brace.js` clamped NaN to 0 ("does not poison the geometry"); the
 * SVG-attribute reader in `core/svg_paths.js` clamped it to 1. Both are correct
 * for their own caller and both were named `clamp01`, so the name told a reader
 * nothing about which one they had — and any future consolidation onto "the"
 * clamp01 would have silently flipped one set of call sites to the other's
 * behaviour. THE NAME NOW STATES THE CONTRACT, which is the whole point of
 * splitting rather than unifying: a caller has to say which failure it wants.
 *
 * ── WHY THERE IS NO THIRD, NaN-PROPAGATING VARIANT ───────────────────────────
 * Five of the nine copies were written as a bare comparison chain
 * (`v < 0 ? 0 : v > 1 ? 1 : v`), which passes NaN, undefined, null and numeric
 * strings straight THROUGH — every comparison against NaN is false, so the value
 * falls out of the bottom untouched. That looks like a third contract. It is not
 * one: it is an accident of how the expression is written, and it was measured at
 * the call sites before being removed.
 *
 * At the sites where a degenerate value can actually arrive (an absent
 * `p.midpoint`, a `fraction` argument omitted, `d / L` with a zero-length
 * contour) NaN never produced an error — it produced silently wrong pictures. It
 * became a gradient stop offset of NaN, which makes the sort comparator
 * inconsistent so the middle colour lands wherever the sort happens to leave it;
 * a width-profile knot that serializes to `null`; and a trim fraction that slips
 * past BOTH the `f <= 0` and `f >= 1` guards (each is false for NaN) into the trim
 * math below them. Nothing depended on any of that, so those callers take `Or0` —
 * the behaviour `brace.js` had already reasoned its way to.
 *
 * Neither function coerces: they are clamps, not parsers. A caller holding a
 * STRING should parse it (`parseFloat`) and decide what an unparseable one means,
 * rather than having a clamp quietly pick 0 or 1 on its behalf.
 *
 * ── THE ONE INPUT WHERE THIS IS NOT BYTE-IDENTICAL: +Infinity ────────────────
 * Adopting `Or0` is behaviour-preserving on every input the replaced copies could
 * actually receive, with a single exception worth stating rather than burying:
 * `+Infinity` clamped UP to 1 under the comparison-chain and nullish-coalescing
 * copies, and lands on 0 here (it is not finite). It is unreachable in practice —
 * `core/expressions.js` THROWS on a non-finite equation result before it can reach
 * a property (`evaluates to Infinity`), so a widget knob cannot hold one — and
 * `core/brace.js` had already shipped exactly this contract for its own geometry.
 * 0 is also the better answer of the two: an infinite "amount" is a broken input,
 * and reading it as full strength is the loudest possible way to be wrong.
 */

/**
 * Pure function. Clamps a number into [0, 1]; anything not finite becomes 0.
 *
 * THE FAIL-CLOSED CLAMP, and the default choice. Use it wherever 0 is the safe
 * reading of "no value": an alpha (invisible), a reveal or progress fraction
 * (nothing revealed), a tween parameter (the start), a strength or amount knob
 * (the effect off). A missing input then renders as an absence rather than as a
 * full-strength something nobody asked for.
 *
 * @param {number} v - any value
 * @returns {number} v confined to [0, 1], or 0 if v is not a finite number
 *
 * @example clamp01Or0(0.25) // 0.25
 * @example clamp01Or0(1.5) // 1
 * @example clamp01Or0(-3) // 0
 * @example clamp01Or0(NaN) // 0 (a non-finite value does not poison the geometry)
 * @example clamp01Or0(undefined) // 0 (an absent knob reads as "off")
 * @example clamp01Or0(Infinity) // 0 (not finite — NOT clamped up to 1)
 */
export function clamp01Or0(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Pure function. Clamps a number into [0, 1]; anything not finite becomes 1.
 *
 * THE FAIL-OPEN CLAMP, and it exists for one reason: an SVG/CSS OPACITY DEFAULT.
 * In SVG an absent or unparseable `opacity` / `fill-opacity` / `stroke-opacity`
 * attribute means FULLY OPAQUE, so 1 is what the format specifies and clamping an
 * unreadable attribute to 0 would silently erase artwork the file says to draw.
 * That is a real load-bearing behaviour, not a stylistic preference — which is why
 * it survives as its own named function instead of being unified away.
 *
 * Do not reach for this for a general alpha or amount: outside a
 * default-is-opaque attribute, failing OPEN means a broken input renders at full
 * strength, which is the loudest possible wrong answer.
 *
 * @param {number} v - any value
 * @returns {number} v confined to [0, 1], or 1 if v is not a finite number
 *
 * @example clamp01Or1(0.25) // 0.25
 * @example clamp01Or1(1.5) // 1
 * @example clamp01Or1(-3) // 0
 * @example clamp01Or1(NaN) // 1 (an unparseable opacity attribute means OPAQUE)
 * @example clamp01Or1(undefined) // 1 (an absent opacity attribute means OPAQUE)
 */
export function clamp01Or1(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}
