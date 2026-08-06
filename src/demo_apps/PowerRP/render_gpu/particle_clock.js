/**
 * The ambient PARTICLE ANIMATION CLOCK — the render-time `t` a particle emitter
 * reads at emit(), and the TWIN of gpu/video_registry.js's playback clock.
 *
 * ── WHY THIS EXISTS (the determinism / purity contract) ───────────────────────
 * A particle emitter's picture is a pure function of (params, t, seed) — but `t`
 * (presentation time in seconds) is NOT document state. It is an AMBIENT
 * presentation input, exactly like a <video> element's currentTime: the render
 * TREE stays a pure function of (document, [[slide, alpha]]) (the manifest core
 * invariant), and `t` rides alongside it the same way the video's live frame
 * does. So this module is the one place that answers "what animation time is it
 * right now?", and every emitter reads it through particleTime().
 *
 * ── THE TWO REGIMES ───────────────────────────────────────────────────────────
 *   PAUSED (default): particleTime() returns a FIXED freeze time
 *     (EDITOR_FREEZE_TIME). This is the editor viewport, the CLI renderer, the
 *     thumbnails/minimap/export pixel service — everything that renders a still.
 *     A still is DETERMINISTIC by construction: the same (doc, slide, alpha)
 *     always yields the same freeze `t`, so it yields byte-identical pixels
 *     (the CLI-reproduces-the-editor requirement). The editor thus shows a
 *     representative freeze-frame so the widget is visible and selectable
 *     (manifest 13.5) — with NO editor-side clock plumbing.
 *
 *   LIVE (presenter only): startParticleClock() switches particleTime() to a
 *     WALL CLOCK — seconds elapsed since the loop started (performance.now()
 *     minus a captured epoch). The presenter already runs a per-frame rAF loop
 *     for any visible animated widget (web/PresentMode.svelte's restingAnimated
 *     / idleTick, and its tween rAF); those repaints simply read the advancing
 *     `t` and the sparkler animates. stopParticleClock() returns to PAUSED.
 *
 * A TEST/CLI OVERRIDE lets a probe request an exact time (setParticleTimeOverride)
 * so a deterministic render at t1 vs t2 can be compared — never used by the app.
 *
 * ── WHY NOT PASS `t` THROUGH sceneIR/emit ARGS ────────────────────────────────
 * emit(state, targetWorldIR, world) is called from ONE production seam (sceneIR)
 * that four consumers share (editor, presenter, CLI, pixel service), NONE of
 * which currently thread time — and three of them (editor/CLI/pixel) must render
 * the freeze frame. Threading a `t` argument would touch every one of those
 * consumers (CanvasView is off-limits per the widget's fence) to pass a value
 * that is CONSTANT for all but the presenter. An ambient clock keeps the change
 * surgical (the presenter opts INTO live mode; everyone else inherits the freeze
 * default for free) and mirrors the already-accepted video-registry pattern.
 *
 * DOM note: performance.now() exists in browsers AND in node (global), so this
 * module is bare-node runnable — but it lives under render_gpu/ (with the video
 * registry) rather than DOM-free core/ because it is a MUTABLE ambient service (a
 * Query/Command with module state), not pure like core/particles.js. The pure
 * math takes `t` explicitly and never imports this module.
 */

import { EDITOR_FREEZE_TIME } from "../core/particles.js";

/** null = PAUSED (freeze). A number = the performance.now() epoch (ms) the live
 * clock started from — particleTime() returns (now - epoch)/1000 while set. */
let liveEpochMs = null;

/** A test/CLI override time in seconds. When non-null it wins over BOTH regimes
 * (used only by determinism probes to render an exact frame). null in the app. */
let overrideSeconds = null;

/**
 * Query. The current particle animation time in SECONDS. Precedence:
 *   1. an explicit override (setParticleTimeOverride) — tests/CLI only;
 *   2. the live wall clock if running (presenter);
 *   3. EDITOR_FREEZE_TIME (the paused freeze frame) otherwise.
 *
 * Near-pure (reads module state + performance.now() in the live regime); PURE
 * and constant in the paused regime (the app's default), which is what makes
 * every still render deterministic.
 *
 * @example // paused (default): particleTime() === EDITOR_FREEZE_TIME
 * @example // after startParticleClock(): particleTime() advances with wall time
 */
export function particleTime() {
  if (overrideSeconds !== null) return overrideSeconds;
  if (liveEpochMs !== null) return (performance.now() - liveEpochMs) / 1000;
  return EDITOR_FREEZE_TIME;
}

/**
 * Command. Switches particleTime() to the LIVE wall clock, starting from `t0`
 * seconds (default 0). Idempotent-ish: calling it re-bases the epoch so the
 * clock restarts from `t0` (present mode entry starts a fresh timeline). The
 * presenter calls this on mount.
 *
 * @example // startParticleClock(); particleTime() ≈ 0, then grows each frame
 */
export function startParticleClock(t0 = 0) {
  liveEpochMs = performance.now() - t0 * 1000;
}

/** Command. Returns particleTime() to the PAUSED freeze regime (presenter exit).
 * @example // stopParticleClock(); particleTime() === EDITOR_FREEZE_TIME again */
export function stopParticleClock() {
  liveEpochMs = null;
}

/** Query. Is the live clock currently running? (Presenter-state introspection;
 * tests.)
 * @example // isParticleClockLive() === false by default */
export function isParticleClockLive() {
  return liveEpochMs !== null;
}

/**
 * Query. Is the clock in the PAUSED regime — neither live nor overridden, so
 * particleTime() is the fixed EDITOR_FREEZE_TIME and CANNOT advance?
 *
 * THE HEADER'S "TWO REGIMES" MADE READABLE. Every consumer that needs it used to
 * infer it, and the two available inferences are both wrong: `isParticleClockLive()`
 * misses the override (a test or an exporter is not paused), and comparing
 * particleTime() to EDITOR_FREEZE_TIME misfires on an override that happens to equal
 * it. The distinction matters to anything that measures an INTERVAL between two clock
 * readings — core/simulation_history.js is the first — because in this regime there
 * is no interval to measure and any number it computes is a leftover: measured
 * 2026-08-06, exiting a presentation shorter than the freeze time is a FORWARD jump,
 * and the clamped interval it produced was then reported forever, since the paused
 * clock never moved again to displace it.
 *
 * @example // isParticleClockPaused() === true by default (the editor)
 * @example // after startParticleClock() or setParticleTimeOverride(2) → false
 */
export function isParticleClockPaused() {
  return overrideSeconds === null && liveEpochMs === null;
}

/**
 * Command. Forces particleTime() to return exactly `seconds` (overriding both
 * regimes), or clears the override when passed null. TESTS / CLI determinism
 * probes ONLY — the app never calls this. Lets a probe render the same doc at an
 * exact t1 and t2 to prove same-t byte-identity and different-t divergence.
 *
 * @example // setParticleTimeOverride(3); particleTime() === 3
 * @example // setParticleTimeOverride(null); particleTime() back to its regime
 */
export function setParticleTimeOverride(seconds) {
  overrideSeconds = seconds;
}
