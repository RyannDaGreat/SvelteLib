/**
 * OPTICS — the facts about an IRIS DIAPHRAGM that more than one module holds.
 *
 * ── WHY THIS MODULE EXISTS, AND WHY IT IS THIS SMALL ─────────────────────────
 * Two places in this app describe the same physical object: `plugins/aperture.js`
 * draws the diaphragm, and the lens flare draws the star that diaphragm produces
 * (`render_gpu/skia/lens_flare_shader.js`). R6-3.11 requires them to AGREE about
 * blade count, and no plugin may import another plugin (core/registry.js), so a
 * fact both need lives in core. It holds exactly the facts with TWO REAL
 * CONSUMERS — speculative generality is its own Tower of Babel, so nothing is
 * parked here "for later".
 *
 * ── THE SUNSTAR PARITY LAW ───────────────────────────────────────────────────
 * THERE IS NO SUCH THING AS AN ODD-NUMBERED SUNSTAR. An aperture is a REAL
 * (not complex) transmission function, so its Fourier transform is HERMITIAN and
 * its intensity |F|² is CENTROSYMMETRIC: every diffraction ray has an equal,
 * opposite twin, for ANY aperture shape. A blade edge throws its spike along the
 * edge NORMAL, so the ray set is
 *
 *     {θ_0 + 2πk/N} ∪ {θ_0 + π + 2πk/N},   k = 0 … N−1
 *
 * and the parity result is what that union's SIZE happens to be — N when N is
 * even (the opposite of every normal is already a normal), 2N when N is odd.
 * BOTH OUTCOMES ARE EVEN. `starburstRayAngles` below builds that union and
 * `starburstRayCount` reads its length, so the law is a CONSEQUENCE of the
 * construction rather than a conditional written out a second time. Any preset,
 * label or help string promising a "seven-point star" describes something
 * physically impossible and must be rejected rather than tuned.
 *
 * THE SkSL COPY, AND THE GATE ON IT. The flare applies the same doubling on the
 * GPU (`lens_flare_shader.js`, the `spikeCount` line), which is a language this
 * module cannot reach — so it IS a mirror, and mirrors rot. `tests/aperture_test.js`
 * extracts that shader's own arithmetic FROM ITS SOURCE TEXT and evaluates it
 * against `starburstRayCount` for every count in range; if the shader's formula
 * changes, the gate goes red instead of the two widgets silently disagreeing.
 */

/**
 * The fewest blades that can enclose a POLYGON, and therefore the fewest that
 * give an aperture a corner at all. Geometric, not a taste bound.
 *
 * SHARED, BECAUSE THE TWO WIDGETS MUST NOT DISAGREE ABOUT WHAT A BLADE COUNT
 * MEANS (R6-3.11): it is the floor of the flare's `blades` row
 * (render_gpu/skia/lens_flare_shader.js) AND the count at and above which
 * `plugins/aperture.js` has a polygon to round, a vertex to place a handle on,
 * and a `sec(π/N)` that is finite and positive. Below it an aperture still draws
 * — one or two blades cut a real circular segment out of the bore — but there is
 * no polygon, so blade CURVATURE has nothing to curve.
 */
export const MIN_POLYGON_BLADES = 3;

/**
 * The blade count that means THE LENS HAS NO IRIS — a mirror (catadioptric)
 * telephoto, a phone camera module, a pinhole. Not a degenerate value to guard
 * against: it is a real, sourced state of a real lens, and the opening is then
 * the bare entrance pupil.
 */
export const NO_IRIS_BLADES = 0;

/**
 * Pure function. The angles (radians) of the diffraction rays an N-blade
 * aperture throws, as the union described in this module's header: one ray along
 * each blade edge's NORMAL, plus each of their OPPOSITES. Duplicates are removed
 * on an EXACT integer index (every ray is `rotation + π·m/N` for an integer m in
 * [0, 2N)), so no angular tolerance is involved and the even/odd parity falls out
 * of the set's size rather than being asserted.
 *
 * Sorted by increasing offset from `rotation`. A count below one has no edges and
 * therefore no rays: the empty list, which is the honest answer for a lens with
 * no iris.
 *
 * Args:
 *   blades (number): blade count; rounded, negatives read as none
 *   rotation (number): the first blade normal's heading, radians
 *
 * Returns:
 *   number[]: ray headings in radians, length N (N even) or 2N (N odd)
 *
 * @example starburstRayAngles(4).map((a) => Math.round((a * 180) / Math.PI)) // [0, 90, 180, 270]
 * @example starburstRayAngles(3).map((a) => Math.round((a * 180) / Math.PI)) // [0, 60, 120, 180, 240, 300]
 * @example starburstRayAngles(6).length // 6
 * @example starburstRayAngles(0) // []
 * @example starburstRayAngles(2, Math.PI / 2).map((a) => Math.round((a * 180) / Math.PI)) // [90, 270]
 */
export function starburstRayAngles(blades, rotation = 0) {
  const n = Math.max(0, Math.round(blades ?? 0));
  if (n < 1) return [];
  const indices = new Set();
  for (let k = 0; k < n; k++) {
    indices.add((2 * k) % (2 * n)); // blade k's edge normal
    indices.add((2 * k + n) % (2 * n)); // its opposite — the centrosymmetry
  }
  return [...indices].sort((a, b) => a - b).map((m) => rotation + (Math.PI * m) / n);
}

/**
 * Pure function. How many diffraction rays an N-blade aperture throws: N when N
 * is even, 2N when N is odd, 0 when there is no iris. Never odd — see the parity
 * law in this module's header.
 *
 * Args:
 *   blades (number): blade count; rounded, negatives read as none
 *
 * Returns:
 *   number: the ray count, always even
 *
 * @example starburstRayCount(8) // 8
 * @example starburstRayCount(9) // 18
 * @example starburstRayCount(13) // 26
 * @example starburstRayCount(6) // 6
 * @example starburstRayCount(0) // 0 (no iris — no edges to diffract at)
 */
export function starburstRayCount(blades) {
  return starburstRayAngles(blades).length;
}
