/**
 * PURE particle simulation — the sparkler's math heart.
 *
 * ── THE PROBLEM (manifest core invariant + 13.5 PARTICLE EFFECT WIDGET) ────────
 * The render tree is a PURE function of (document, [[slide, alpha]]). A particle
 * emitter is an ANIMATED widget: its picture at presentation time `t` differs
 * from its picture a moment later. If we simulated it the usual game-engine way —
 * a mutable pool advanced by `dt` each frame, spawning with Math.random — the
 * picture at time `t` would depend on the HISTORY of frames rendered (how many
 * ticks ran, at what dt), so a CLI render could never reproduce the editor, and
 * two renders of the same (doc, t) could differ. That is forbidden here.
 *
 * ── THE SOLUTION: a stateless, closed-form simulation ─────────────────────────
 * Every particle's ENTIRE trajectory is a closed-form function of three pure
 * inputs: the emitter parameters, the wall-clock time `t` (seconds), and an
 * integer `seed`. There is NO accumulating state, NO dt, NO Math.random (banned
 * by architecture, not just style). Concretely:
 *
 *   - Particle `i` is BORN at birthTime(i) = i / rate (a fixed schedule — the
 *     i-th particle is emitted 1/rate seconds after the 0-th). So at time `t`,
 *     the particles ALIVE are exactly those with birthTime in (t - lifetime, t]
 *     — a contiguous window of indices, computed directly (no spawn loop).
 *   - Each particle's random-but-DETERMINISTIC attributes (launch angle, speed,
 *     size, per-particle drift, initial phase) come from hash(seed, i): a pure
 *     integer hash → uniform floats. The SAME (seed, i) always yields the SAME
 *     particle, so the SAME (props, t, seed) always yields the SAME picture.
 *   - Position at age `a = t - birthTime(i)` is a closed-form ballistic path:
 *     p(a) = origin + v0·a + ½·g·a²  (constant launch velocity + gravity/drift
 *     acceleration). No integration — evaluated directly from `a`.
 *   - Fade/shrink are closed-form functions of the normalized age a/lifetime.
 *
 * This is EXACTLY the video-widget contract translated to math: `t` is an
 * AMBIENT presentation input (like a <video>'s currentTime), NOT document state,
 * and the simulation is pure of document state. `simulateParticles` never reads
 * a clock — the CALLER (plugins/particles.js emit()) supplies `t`; the editor
 * supplies a fixed FREEZE time, the presenter supplies its rAF wall clock, and
 * the CLI supplies a fixed time — so determinism is guaranteed by construction.
 *
 * ── BOUNDEDNESS ───────────────────────────────────────────────────────────────
 * The alive-index window has width `rate · lifetime` (Little's law), so the live
 * particle count is bounded by ceil(rate · lifetime) + 1 regardless of `t`.
 * maxParticleCount() exposes that bound; simulateParticles hard-caps the emitted
 * array at PARTICLE_HARD_CAP so a pathological (huge rate)·(huge lifetime) can
 * never allocate an unbounded array (loud-clamped, not silently — see below).
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/** The editor's paused freeze-frame time, in seconds (manifest 13.5: the editor
 * shows a "representative freeze-frame ... so the widget is visible and
 * selectable"). Chosen so the emitter has run long enough for the alive-window
 * to be FULL for any sane lifetime (a fresh emitter at t=0 shows a single
 * particle — not representative), while staying a small round number. Named so
 * the plugin and every test reference ONE constant. */
export const EDITOR_FREEZE_TIME = 2;

/** Hard ceiling on particles emitted in one call — a safety bound so a
 * pathological rate·lifetime can't allocate an unbounded array. Not a design
 * limit on normal use (a full-screen sparkler is ~hundreds): 4000 is well above
 * any hand-authored emitter and far below a memory hazard. simulateParticles
 * clamps to it LOUDLY (reportOnce), never silently. */
export const PARTICLE_HARD_CAP = 4000;

import { reportOnce } from "./report.js";

// ── deterministic hashing ─────────────────────────────────────────────────────

/**
 * Pure function. A 32-bit integer avalanche hash (Thomas Wang / Murmur-finalizer
 * style): mixes an unsigned 32-bit key into a well-distributed unsigned 32-bit
 * output. Used to derive per-particle randomness from (seed, particleIndex,
 * stream) with NO Math.random — the same inputs always give the same result, on
 * every machine, which is what makes the simulation reproducible.
 *
 * Args:
 *   key (int): any integer (coerced to unsigned 32-bit)
 *
 * Returns:
 *   int: a well-mixed unsigned 32-bit integer (0 .. 2^32-1)
 *
 * @example hashU32(0)
 * 3108667723
 * @example hashU32(1) === hashU32(1)
 * true
 * @example hashU32(1) === hashU32(2)
 * false
 */
export function hashU32(key) {
  // The +0x9e3779b9 (golden-ratio constant) breaks the zero fixed point: without
  // it, key=0 hashes to 0 (0^0=0, imul(0,k)=0), so a seed of 0 would degenerate.
  let h = (key + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/**
 * Pure function. A deterministic uniform float in [0, 1) for a given
 * (seed, particleIndex, stream). `stream` selects an INDEPENDENT random channel
 * for the same particle — so a particle's angle (stream 0), speed (stream 1),
 * size (stream 2)... are decorrelated draws that never move together. The three
 * ints are folded into one 32-bit key via multiply-mix before hashing, so
 * distinct (seed, i, stream) triples map to well-separated keys.
 *
 * Args:
 *   seed (int): the emitter's seed property
 *   i (int): particle index (its birth order)
 *   stream (int): which decorrelated random channel (0, 1, 2, ...)
 *
 * Returns:
 *   float: uniform in [0, 1)
 *
 * @example randUnit(7, 0, 0) >= 0 && randUnit(7, 0, 0) < 1
 * true
 * @example randUnit(7, 3, 0) === randUnit(7, 3, 0)
 * true
 * @example randUnit(7, 3, 0) === randUnit(7, 3, 1)
 * false
 * @example randUnit(7, 3, 0) === randUnit(8, 3, 0)
 * false
 */
export function randUnit(seed, i, stream) {
  // Fold (seed, i, stream) into one 32-bit key. imul keeps it in 32-bit lane;
  // the odd multipliers are large primes so the three axes don't alias.
  let key = (seed >>> 0);
  key = (Math.imul(key, 0x9e3779b1) + (i >>> 0)) >>> 0;
  key = (Math.imul(key, 0x85ebca77) + (stream >>> 0)) >>> 0;
  // 2^32 divisor → [0, 1). hashU32 is uniform, so this is uniform.
  return hashU32(key) / 4294967296;
}

/**
 * Pure function. Maps a unit float u∈[0,1) to [lo, hi] (linear). A tiny helper
 * so parameter ranges (speed min→max, size min→max, angle spread) all read the
 * same way. hi may be < lo (then it maps DOWNWARD — harmless, callers pass
 * lo<=hi).
 *
 * @example lerpRange(0, 10, 20)
 * 10
 * @example lerpRange(0.5, 10, 20)
 * 15
 * @example lerpRange(1, 10, 20)
 * 20
 */
export function lerpRange(u, lo, hi) {
  return lo + (hi - lo) * u;
}

// ── the emitter parameter contract ────────────────────────────────────────────

/**
 * The emitter parameters `simulateParticles` reads, with their meanings and
 * units. This is documentation of the pure-math input shape; the PLUGIN
 * (plugins/particles.js) owns the property registry rows/defaults and passes an
 * object of this shape (already numeric — equations evaluated upstream).
 *
 *   rate       particles per second emitted (> 0; 0 ⇒ no particles — a ghost)
 *   lifetime   seconds each particle lives before it disappears (> 0)
 *   originX    emission point X in the widget's LOCAL space (canvas units)
 *   originY    emission point Y in the widget's LOCAL space (canvas units)
 *   angle      central launch direction, DEGREES clockwise from +X (right = 0,
 *              down = 90 — matches the canvas Y-down convention)
 *   spread     angular spread in DEGREES; a particle's launch angle is
 *              angle ± spread/2 (spread 360 ⇒ a full radial burst)
 *   speedMin   minimum launch speed (canvas units per second)
 *   speedMax   maximum launch speed (canvas units per second)
 *   gravityX   constant acceleration X (canvas units per second²) — drift/wind
 *   gravityY   constant acceleration Y (canvas units per second²) — gravity is
 *              POSITIVE (down) in the Y-down canvas frame
 *   sizeMin    minimum particle radius (canvas units) at birth
 *   sizeMax    maximum particle radius (canvas units) at birth
 *   fade       0..1 — how much a particle fades over its life (1 = fades fully
 *              to transparent at death; 0 = stays opaque then vanishes)
 *   shrink     0..1 — how much a particle shrinks over its life (1 = shrinks to
 *              nothing at death; 0 = keeps its birth size)
 *   seed       integer — the whole system's randomness seed
 */

/**
 * Pure function. The bound on how many particles can be alive at once for an
 * emitter, independent of `t`. The alive window spans `rate · lifetime` indices
 * (Little's law: throughput · residence time = occupancy); +1 for the partial
 * particle at each end. Used by the plugin's cull-margin sizing and by tests
 * asserting the count is bounded.
 *
 * Args:
 *   rate (number): particles per second (>= 0)
 *   lifetime (number): seconds each lives (>= 0)
 *
 * Returns:
 *   int: max simultaneously-alive particle count (never below 0)
 *
 * @example maxParticleCount(10, 2)
 * 21
 * @example maxParticleCount(0, 2)
 * 0
 * @example maxParticleCount(100, 3)
 * 301
 */
export function maxParticleCount(rate, lifetime) {
  if (!(rate > 0) || !(lifetime > 0)) return 0;
  return Math.ceil(rate * lifetime) + 1;
}

/**
 * Pure function. The set of particle indices ALIVE at time `t` for a given
 * emission rate and lifetime. Particle `i` is born at i/rate and dies at
 * i/rate + lifetime, so it is alive at `t` iff (t - lifetime) < i/rate <= t,
 * i.e. i ∈ (rate·(t - lifetime), rate·t]. Returns {lo, hi} half-open-then-closed
 * bounds as integer indices [lo, hi] (inclusive), clamped to non-negative (no
 * particle exists before index 0 — the emitter starts at t=0). An empty window
 * (nothing alive) returns lo > hi.
 *
 * This is the closed-form replacement for a spawn loop: instead of stepping time
 * and appending particles, we compute directly WHICH indices are currently in
 * flight. O(1) to compute the bounds; O(count) to realize the particles.
 *
 * Args:
 *   t (number): wall-clock time in seconds (>= 0)
 *   rate (number): particles per second (> 0)
 *   lifetime (number): seconds each lives (> 0)
 *
 * Returns:
 *   {lo: int, hi: int}: inclusive index range of alive particles (lo>hi ⇒ none)
 *
 * @example aliveIndexRange(2, 10, 1)   // born (10,20] alive: (10·1, 10·2] = (10,20]
 * {lo: 11, hi: 20}
 * @example aliveIndexRange(0.5, 10, 1) // (10·-0.5, 10·0.5] clamped to [0, 5]
 * {lo: 0, hi: 5}
 * @example aliveIndexRange(0, 10, 1)   // nothing born yet at t=0 except index 0
 * {lo: 0, hi: 0}
 */
export function aliveIndexRange(t, rate, lifetime) {
  // Youngest alive index = floor(rate·t) (the most recently born, at or before t).
  // Oldest alive index = the first index whose birth is still within `lifetime`
  // of t: birth i/rate > t - lifetime ⇒ i > rate·(t - lifetime).
  const hi = Math.floor(rate * t);
  const lo = Math.max(0, Math.floor(rate * (t - lifetime)) + 1);
  return { lo, hi };
}

/**
 * Pure function. Realizes ONE particle's full visual state at time `t`. All
 * randomness is drawn deterministically from (seed, i); the trajectory is the
 * closed-form ballistic path from birth. Returns null if the particle is not
 * alive at `t` (age < 0 or age >= lifetime) — the caller filters these out, but
 * the guard keeps the function total.
 *
 * Coordinates are in the emitter's LOCAL space (canvas units), same frame as
 * originX/originY; the plugin's emit() wraps them in the node world transform.
 *
 * Args:
 *   p (object): emitter params (see the parameter contract above)
 *   i (int): particle index
 *   t (number): wall-clock time (seconds)
 *
 * Returns:
 *   {x, y, r, alpha, age} | null : the particle at `t`, or null if not alive.
 *     x, y  — LOCAL position (canvas units)
 *     r     — current radius (canvas units, after shrink)
 *     alpha — current opacity multiplier 0..1 (after fade)
 *     age   — seconds since birth (0..lifetime)
 *
 * @example particleAt({rate: 1, lifetime: 10, originX: 0, originY: 0, angle: 0, spread: 0, speedMin: 10, speedMax: 10, gravityX: 0, gravityY: 0, sizeMin: 2, sizeMax: 2, fade: 0, shrink: 0, seed: 1}, 0, 1).x
 * 10
 * @example particleAt({rate: 1, lifetime: 10, originX: 5, originY: 5, angle: 90, spread: 0, speedMin: 0, speedMax: 0, gravityX: 0, gravityY: 20, sizeMin: 2, sizeMax: 2, fade: 0, shrink: 0, seed: 1}, 0, 1).y
 * 15
 * @example particleAt({rate: 1, lifetime: 1, seed: 1}, 0, 5) // dead at t=5 (born 0, lifetime 1)
 * null
 */
export function particleAt(p, i, t) {
  const rate = p.rate, lifetime = p.lifetime;
  const birth = i / rate;
  const age = t - birth;
  if (age < 0 || age >= lifetime) return null;

  // Decorrelated random draws (independent streams per attribute).
  const uAngle = randUnit(p.seed, i, 0);
  const uSpeed = randUnit(p.seed, i, 1);
  const uSize = randUnit(p.seed, i, 2);

  // Launch direction: central angle ± spread/2, in radians.
  const DEG2RAD = Math.PI / 180;
  const spread = p.spread ?? 0;
  const angleDeg = (p.angle ?? 0) + lerpRange(uAngle, -spread / 2, spread / 2);
  const angle = angleDeg * DEG2RAD;
  const speed = lerpRange(uSpeed, p.speedMin ?? 0, p.speedMax ?? 0);
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;

  // Ballistic path: p = origin + v0·age + ½·g·age² (closed form, no integration).
  const gx = p.gravityX ?? 0, gy = p.gravityY ?? 0;
  const x = (p.originX ?? 0) + vx * age + 0.5 * gx * age * age;
  const y = (p.originY ?? 0) + vy * age + 0.5 * gy * age * age;

  // Birth radius, then shrink over normalized life.
  const frac = age / lifetime; // 0 at birth → 1 at death
  const r0 = lerpRange(uSize, p.sizeMin ?? 0, p.sizeMax ?? 0);
  const shrink = clamp01(p.shrink ?? 0);
  const r = r0 * (1 - shrink * frac);

  // Fade over normalized life.
  const fade = clamp01(p.fade ?? 0);
  const alpha = 1 - fade * frac;

  return { x, y, r, alpha, age };
}

/** Pure function. Clamps to [0, 1].
 * @example clamp01(-0.5) // 0
 * @example clamp01(0.5)  // 0.5
 * @example clamp01(2)    // 1
 */
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Pure function. THE emitter simulation: all particles alive at time `t`, as a
 * flat array of visual states (LOCAL coords). This is the whole closed-form
 * sim — a pure function of (params, t) with the seed inside params. Determinism:
 * identical (params, t) ⇒ identical array (same indices, same hashes, same
 * math); a different seed ⇒ a different (but equally deterministic) array. The
 * count is bounded by maxParticleCount(rate, lifetime), hard-capped at
 * PARTICLE_HARD_CAP (loudly, never silently).
 *
 * Returns [] when rate<=0 or lifetime<=0 (a dead emitter — the plugin treats
 * this as a ghost). Particles are ordered by index (oldest→youngest), a stable
 * z-within-emitter order so the render is deterministic frame to frame.
 *
 * Args:
 *   p (object): emitter params (the parameter contract above; numeric)
 *   t (number): wall-clock time in seconds (>= 0)
 *
 * Returns:
 *   Array<{x, y, r, alpha, age}>: alive particles in LOCAL space (canvas units)
 *
 * @example simulateParticles({rate: 0, lifetime: 2, seed: 1}, 5) // dead emitter
 * []
 * @example simulateParticles({rate: 10, lifetime: 2, originX: 0, originY: 0, angle: 0, spread: 0, speedMin: 0, speedMax: 0, gravityX: 0, gravityY: 0, sizeMin: 1, sizeMax: 1, fade: 0, shrink: 0, seed: 1}, 5).length
 * 20
 * @example simulateParticles({rate: 10, lifetime: 2, seed: 1, speedMin: 5, speedMax: 5, angle: 0, spread: 0, sizeMin: 1, sizeMax: 1, originX: 0, originY: 0, gravityX: 0, gravityY: 0, fade: 0, shrink: 0}, 3).length === simulateParticles({rate: 10, lifetime: 2, seed: 1, speedMin: 5, speedMax: 5, angle: 0, spread: 0, sizeMin: 1, sizeMax: 1, originX: 0, originY: 0, gravityX: 0, gravityY: 0, fade: 0, shrink: 0}, 3).length
 * true
 */
export function simulateParticles(p, t) {
  const rate = p.rate ?? 0, lifetime = p.lifetime ?? 0;
  if (!(rate > 0) || !(lifetime > 0)) return []; // dead emitter → no particles (ghost)
  const { lo, hi } = aliveIndexRange(t, rate, lifetime);
  const out = [];
  let capped = false;
  for (let i = lo; i <= hi; i++) {
    if (out.length >= PARTICLE_HARD_CAP) { capped = true; break; }
    const q = particleAt(p, i, t);
    // q can be null exactly at the window edges (floating-point boundary
    // particle whose age just crossed 0 or lifetime) — skip those; the range is
    // an integer over-approximation and particleAt is the precise life test.
    if (q && q.r > 0 && q.alpha > 0) out.push(q); // fully-shrunk / fully-faded particles are invisible → skip
  }
  if (capped)
    reportOnce(
      `PowerRP particles: emitter hit the ${PARTICLE_HARD_CAP}-particle hard cap ` +
      `(rate·lifetime = ${rate}·${lifetime} = ${(rate * lifetime).toFixed(0)}) — ` +
      `lower Rate or Lifetime. Rendering the first ${PARTICLE_HARD_CAP} particles.`,
    );
  return out;
}
