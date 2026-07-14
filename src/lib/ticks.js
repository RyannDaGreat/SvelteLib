/**
 * ticks.js — generic multi-level tick math for infinite grids and rulers.
 *
 * ONE abstraction serves two consumers: a Blender-style background grid (many
 * levels drawn at once, each faded by zoom so the composite reads as a single
 * continuous grid at ANY zoom) and a linear ruler (one level's ticks enumerated
 * across a world range, with labels). Both reduce to: "at this zoom, which
 * decade levels are visible, how opaque is each, and where do their ticks fall?"
 *
 * A "level" k has world spacing base * ratio^k with base=10, ratio=10 by
 * default: 10, 100, 1000, ... (also 1, 0.1, ... for negative k). Everything is
 * pure — no DOM, no globals — so it runs in bare node and is unit-testable.
 *
 * THE FADE, and why it is what it is
 * ----------------------------------
 * A level with world spacing s appears on screen at s*zoom pixels apart. We fade
 * each level by its APPARENT (screen) spacing so density stays constant: a level
 * peaks in opacity when its ticks sit at a target pixel spacing, and fades to
 * nothing as they crowd together (zoomed out) or spread apart (zoomed in).
 *
 * The fade is defined in log10 of screen spacing. Let u = log10(screenSpacing /
 * targetPx) — the level's distance, in DECADES, from its ideal. Each level's
 * opacity is a symmetric BUMP that peaks at u=0 and reaches 0 at u=±1:
 *
 *     opacity(level) = smoothstep(1 - |u|)
 *
 * THE KEY DERIVATION — why the bump half-width is exactly 1 decade (not a tuned
 * constant): adjacent levels differ by exactly ratio=10, i.e. 1 decade = 1 unit
 * in log10 space. So a level's neighbors sit at u±1 — precisely this bump's zero
 * crossings. Two adjacent decades straddle the target at any zoom, and their
 * bumps form a PARTITION OF UNITY: smoothstep(t)+smoothstep(1-t) = 1 for all t,
 * so the composite opacity is exactly 1 at EVERY zoom (uniform apparent density,
 * the Blender "one continuous grid" property). Every level is born and dies at
 * opacity 0 as zoom sweeps — no pops — and the whole thing is pinned to
 * log10(ratio), never an invented number. smoothstep gives C1 continuity so
 * there is no visible kink either.
 */

const BASE = 10; // decade grid: levels at 10, 100, 1000, ... (manifest: "10 / 100 / 1000 px")
const RATIO = 10; // each level is ×10 the previous — this ratio IS the fade-window width in decades
const LOG_RATIO = Math.log10(RATIO); // = 1.0 decade; the fade window spans exactly this (derivation above)

// Default target screen spacing (px) at which a level sits fully opaque. This is
// a rendering preference, not a mathematical constant, so it is a parameter with
// a sensible default everywhere; callers may override per surface.
const DEFAULT_TARGET_PX = 40;

/**
 * Pure function, general. Smoothstep ramp: 0 for x<=0, 1 for x>=1, an
 * S-curve (3x²-2x³) with zero slope at both ends between. C1-continuous, so a
 * value sweeping through it produces no visible kink.
 *
 * @example smoothstep(-1) // 0
 * @example smoothstep(0) // 0
 * @example smoothstep(0.5) // 0.5
 * @example smoothstep(1) // 1
 * @example smoothstep(2) // 1
 */
export function smoothstep(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/**
 * Pure function. World spacing of decade level k (k may be negative).
 *
 * @param {number} k - level index; 0 = base spacing
 * @param {number} [base=10] - spacing of level 0
 * @param {number} [ratio=10] - multiplier between adjacent levels
 * @returns {number} world-space distance between adjacent ticks of level k
 *
 * @example levelSpacing(0) // 10
 * @example levelSpacing(1) // 100
 * @example levelSpacing(2) // 1000
 * @example levelSpacing(-1) // 1
 */
export function levelSpacing(k, base = BASE, ratio = RATIO) {
  return base * ratio ** k;
}

/**
 * Pure function. Opacity of a decade level given how its screen spacing compares
 * to the target. A symmetric bump: peaks at 1 when screenSpacing == targetPx and
 * falls to 0 one decade away in EITHER direction (targetPx/ratio when too dense,
 * targetPx*ratio when too sparse). Because the half-width is exactly one decade
 * (log10(ratio) units) — the spacing between adjacent levels — neighboring levels'
 * bumps form a partition of unity, so their opacities always sum to 1: the grid
 * reads as one continuous density and every level is born/dies at 0 (no pops).
 * That decade half-width is the derivation, not a tuned magic number.
 *
 * @param {number} screenSpacing - apparent (pixel) spacing of this level's ticks
 * @param {number} [targetPx=40] - pixel spacing at which the level peaks (opacity 1)
 * @param {number} [ratio=10] - level ratio (fixes the bump half-width to one decade)
 * @returns {number} opacity in [0, 1]
 *
 * @example levelOpacity(40) // 1     (at target -> peak)
 * @example levelOpacity(4) // 0      (a decade too dense -> gone)
 * @example levelOpacity(400) // 0    (a decade too sparse -> gone)
 * @example levelOpacity(Math.sqrt(40 * 400)) // 0.5  (geometric midpoint toward sparse)
 */
export function levelOpacity(screenSpacing, targetPx = DEFAULT_TARGET_PX, ratio = RATIO) {
  const logRatio = Math.log10(ratio); // bump half-width in decades (=1 for ratio 10)
  const u = (Math.log10(screenSpacing) - Math.log10(targetPx)) / logRatio; // decades from target
  return smoothstep(1 - Math.abs(u));
}

/**
 * Pure function. The visible decade levels at a given zoom, each with its world
 * spacing, screen spacing, and bump opacity. With the partition-of-unity fade,
 * exactly the two decades straddling the target spacing are nonzero (their
 * opacities sum to 1); every other level is either too dense or too sparse and
 * contributes nothing, so drawing them would waste fills. The composite opacity
 * is a constant 1 across all zoom — the Blender "one continuous grid" property.
 *
 * @param {number} zoom - world->screen scale (px per world unit); must be > 0
 * @param {number} [targetPx=40] - pixel spacing at which a level peaks
 * @param {number} [base=10] - spacing of level 0
 * @param {number} [ratio=10] - multiplier between adjacent levels
 * @returns {{k:number, spacing:number, screenSpacing:number, opacity:number}[]}
 *   ordered fine->coarse; only levels with opacity > 0 are included
 *
 * @example
 * // At zoom 1 the two straddling decades are 10px world (screen 10 -> below
 * // target, fading) and 100px world (screen 100 -> above target, fading):
 * // visibleLevels(1).map(l => l.spacing) -> [10, 100]
 * // visibleLevels(1).reduce((s,l)=>s+l.opacity,0) -> 1   (partition of unity)
 * @example
 * // At zoom 4 the base 10px level lands exactly at target (10*4 = 40px) -> peak;
 * // both neighbors are a full decade away -> 0, so only the peak level remains:
 * // visibleLevels(4).map(l => [l.spacing, l.opacity]) -> [[10, 1]]
 */
export function visibleLevels(zoom, targetPx = DEFAULT_TARGET_PX, base = BASE, ratio = RATIO) {
  if (!(zoom > 0)) throw new Error(`visibleLevels: zoom must be > 0, got ${zoom}`);
  const logRatio = Math.log10(ratio);
  // Nonzero window is |u| < 1, i.e. targetPx/ratio < screenSpacing < targetPx*ratio.
  // kLo = the finest level with screenSpacing >= targetPx (u <= 0, the "denser
  // half" of the straddle): base*ratio^k*zoom >= targetPx  =>
  //   k >= log_ratio( targetPx / (base*zoom) ).
  const kLo = Math.ceil((Math.log10(targetPx) - Math.log10(base * zoom)) / logRatio);
  const out = [];
  // Scan the one-decade-either-side window: the level below kLo (u in (-1,0)) and
  // kLo itself (u in [0,1)) are the two that can be nonzero. A tiny guard range
  // makes the boundary case (screenSpacing exactly == targetPx) robust.
  for (let k = kLo - 1; k <= kLo + 1; k++) {
    const spacing = levelSpacing(k, base, ratio);
    const screenSpacing = spacing * zoom;
    const opacity = levelOpacity(screenSpacing, targetPx, ratio);
    if (opacity > 0) out.push({ k, spacing, screenSpacing, opacity });
  }
  return out;
}

/**
 * Pure function, general. Every multiple of `spacing` within [lo, hi] inclusive,
 * ascending. Used for ruler labels and grid line positions along one axis.
 * Returns tick WORLD positions; the caller maps them to screen.
 *
 * @param {number} lo - range start (world units)
 * @param {number} hi - range end (world units); may be < lo (auto-ordered)
 * @param {number} spacing - tick spacing (world units); must be > 0
 * @returns {number[]} sorted world positions that are integer multiples of spacing
 *
 * @example ticksInRange(0, 25, 10) // [0, 10, 20]
 * @example ticksInRange(-15, 15, 10) // [-10, 0, 10]
 * @example ticksInRange(23, -3, 10) // [0, 10, 20]  (range auto-ordered)
 */
export function ticksInRange(lo, hi, spacing) {
  if (!(spacing > 0)) throw new Error(`ticksInRange: spacing must be > 0, got ${spacing}`);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const first = Math.ceil(a / spacing);
  const last = Math.floor(b / spacing);
  const out = [];
  // `i * spacing || 0` normalizes -0 (from ceil of a small negative) to +0 so
  // the zero tick is a plain 0.
  for (let i = first; i <= last; i++) out.push(i * spacing || 0);
  return out;
}

/**
 * Pure function. The single best decade level for a RULER at a given zoom: the
 * coarsest level whose ticks are still at least targetPx apart, so labels never
 * collide. (A ruler shows one labelled level, unlike the grid's blended stack.)
 *
 * @param {number} zoom - world->screen scale (px per world unit); must be > 0
 * @param {number} [targetPx=40] - minimum pixel spacing between labelled ticks
 * @param {number} [base=10] - spacing of level 0
 * @param {number} [ratio=10] - multiplier between adjacent levels
 * @returns {{k:number, spacing:number, screenSpacing:number}} the chosen level
 *
 * @example rulerLevel(1).spacing // 100   (10px world would be 10px on screen — too tight)
 * @example rulerLevel(10).spacing // 10   (zoomed in: 10px world is 100px on screen)
 */
export function rulerLevel(zoom, targetPx = DEFAULT_TARGET_PX, base = BASE, ratio = RATIO) {
  if (!(zoom > 0)) throw new Error(`rulerLevel: zoom must be > 0, got ${zoom}`);
  const logRatio = Math.log10(ratio);
  // Smallest k with base*ratio^k*zoom >= targetPx  =>  k >= log_ratio(targetPx/(base*zoom))
  const k = Math.ceil((Math.log10(targetPx) - Math.log10(base * zoom)) / logRatio);
  const spacing = levelSpacing(k, base, ratio);
  return { k, spacing, screenSpacing: spacing * zoom };
}
