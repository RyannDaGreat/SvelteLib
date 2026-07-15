/**
 * core/particles.js + plugins/particles.js + render_gpu/particle_clock.js tests
 * (bare node, no framework — suite conventions).
 *
 * THE CONTRACT under test is the manifest's determinism requirement for 13.5:
 * the particle picture is a PURE closed-form function of (params, t, seed) —
 *   1. same (params, t, seed)  ⇒ byte-identical particle set (CLI reproduces
 *      the editor);
 *   2. different seed / different t ⇒ different set;
 *   3. the particle count is BOUNDED (no unbounded accumulation);
 * plus the plugin's ambient-clock sourcing, conditional-ghost predicate, and the
 * ellipse-op shape (free vector export).
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/particles_test.js
 */

import assert from "node:assert/strict";
import {
  hashU32, randUnit, lerpRange, clamp01,
  maxParticleCount, aliveIndexRange, particleAt, simulateParticles,
  EDITOR_FREEZE_TIME, PARTICLE_HARD_CAP,
} from "../core/particles.js";
import {
  particlesPlugin, emitterParams, particleOps, particleReach, particleDefaults,
} from "../plugins/particles.js";
import {
  particleTime, startParticleClock, stopParticleClock, isParticleClockLive,
  setParticleTimeOverride,
} from "../render_gpu/particle_clock.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

// A representative full-parameter emitter (every knob non-trivial), so the
// determinism tests exercise angle/spread/speed/gravity/size/fade/shrink jointly.
const P = {
  rate: 30, lifetime: 2.5, originX: 0, originY: 0,
  angle: 270, spread: 60, speedMin: 40, speedMax: 120,
  gravityX: 5, gravityY: 90, sizeMin: 2, sizeMax: 6,
  fade: 1, shrink: 0.4, seed: 7,
};

// ── hashing / random ────────────────────────────────────────────────────────

test("hashU32 is a pure deterministic 32-bit map (no zero fixed point)", () => {
  assert.equal(hashU32(0), 3108667723); // NOT 0 — the golden-ratio add breaks it
  assert.equal(hashU32(1), hashU32(1));
  assert.notEqual(hashU32(1), hashU32(2));
  // stays in the unsigned 32-bit range
  for (const k of [0, 1, 2, 100, -1, 1 << 30]) {
    const h = hashU32(k);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32, `hashU32(${k}) out of range: ${h}`);
  }
});

test("randUnit: uniform-ish in [0,1), decorrelated per (seed,i,stream)", () => {
  // range
  for (let i = 0; i < 50; i++) {
    const u = randUnit(3, i, 0);
    assert.ok(u >= 0 && u < 1, `randUnit out of [0,1): ${u}`);
  }
  // determinism + decorrelation
  assert.equal(randUnit(3, 5, 0), randUnit(3, 5, 0));
  assert.notEqual(randUnit(3, 5, 0), randUnit(3, 5, 1)); // stream differs
  assert.notEqual(randUnit(3, 5, 0), randUnit(4, 5, 0)); // seed differs
  assert.notEqual(randUnit(3, 5, 0), randUnit(3, 6, 0)); // index differs
  // rough uniformity: mean over a big sample near 0.5
  let sum = 0, n = 2000;
  for (let i = 0; i < n; i++) sum += randUnit(11, i, 0);
  assert.ok(Math.abs(sum / n - 0.5) < 0.03, `mean drifted: ${sum / n}`);
});

test("lerpRange / clamp01 helpers", () => {
  assert.equal(lerpRange(0, 10, 20), 10);
  assert.equal(lerpRange(0.5, 10, 20), 15);
  assert.equal(lerpRange(1, 10, 20), 20);
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(2), 1);
});

// ── the alive window (closed-form spawn schedule) ───────────────────────────

test("maxParticleCount = ceil(rate·lifetime)+1; 0 for a dead emitter", () => {
  assert.equal(maxParticleCount(10, 2), 21);
  assert.equal(maxParticleCount(100, 3), 301);
  assert.equal(maxParticleCount(0, 2), 0);
  assert.equal(maxParticleCount(10, 0), 0);
});

test("aliveIndexRange = the contiguous born-within-lifetime index window", () => {
  assert.deepEqual(aliveIndexRange(2, 10, 1), { lo: 11, hi: 20 });
  assert.deepEqual(aliveIndexRange(0.5, 10, 1), { lo: 0, hi: 5 }); // clamped to >=0
  assert.deepEqual(aliveIndexRange(0, 10, 1), { lo: 0, hi: 0 });
});

// ── closed-form trajectory ──────────────────────────────────────────────────

test("particleAt: ballistic path, no integration, null when not alive", () => {
  // pure horizontal launch: x = v·age, y unchanged
  const straight = { rate: 1, lifetime: 10, originX: 0, originY: 0, angle: 0, spread: 0, speedMin: 10, speedMax: 10, gravityX: 0, gravityY: 0, sizeMin: 2, sizeMax: 2, fade: 0, shrink: 0, seed: 1 };
  assert.equal(particleAt(straight, 0, 1).x, 10); // 10 units/s · 1 s
  assert.equal(particleAt(straight, 0, 1).y, 0);
  // gravity only: y = ½·g·age² (age 1 ⇒ ½·20·1 = 10) from origin 5
  const grav = { ...straight, angle: 90, speedMin: 0, speedMax: 0, gravityY: 20, originY: 5 };
  assert.equal(particleAt(grav, 0, 1).y, 15);
  // not alive: born 0, lifetime 1, queried at t=5
  assert.equal(particleAt({ rate: 1, lifetime: 1, seed: 1 }, 0, 5), null);
  // not born yet: index 3 born at 3/rate = 3s, queried at t=1
  assert.equal(particleAt({ ...straight, rate: 1 }, 3, 1), null);
});

test("particleAt: fade and shrink are closed-form over normalized age", () => {
  const base = { rate: 1, lifetime: 4, originX: 0, originY: 0, angle: 0, spread: 0, speedMin: 0, speedMax: 0, gravityX: 0, gravityY: 0, sizeMin: 10, sizeMax: 10, fade: 1, shrink: 1, seed: 1 };
  const birth = particleAt(base, 0, 0);   // age 0 → full size, full alpha
  const mid = particleAt(base, 0, 2);     // age 2 (half life) → half size, half alpha
  assert.ok(Math.abs(birth.r - 10) < 1e-9 && Math.abs(birth.alpha - 1) < 1e-9);
  assert.ok(Math.abs(mid.r - 5) < 1e-9, `mid radius ${mid.r}`);
  assert.ok(Math.abs(mid.alpha - 0.5) < 1e-9, `mid alpha ${mid.alpha}`);
});

// ── THE DETERMINISM CONTRACT ─────────────────────────────────────────────────

test("DETERMINISM: same (params, t, seed) ⇒ byte-identical particle set", () => {
  const a = simulateParticles(P, 3.2);
  const b = simulateParticles(P, 3.2);
  assert.deepEqual(a, b); // deep structural equality — every field of every particle
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("DIVERGENCE: a different seed ⇒ a different set", () => {
  const a = simulateParticles(P, 3.2);
  const b = simulateParticles({ ...P, seed: 8 }, 3.2);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.length, b.length); // same count (rate/lifetime unchanged) — only the pattern differs
});

test("DIVERGENCE: a different time ⇒ a different set", () => {
  const a = simulateParticles(P, 3.2);
  const b = simulateParticles(P, 3.6);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test("BOUNDED: count never exceeds maxParticleCount across all t", () => {
  const bound = maxParticleCount(P.rate, P.lifetime);
  let observed = 0;
  // sweep a full lifetime-plus at fine resolution — the window is always full
  for (let t = 0; t < P.lifetime * 3; t += 0.017) {
    observed = Math.max(observed, simulateParticles(P, t).length);
  }
  assert.ok(observed <= bound, `observed ${observed} > bound ${bound}`);
  assert.ok(observed > 0, "a live emitter must produce particles");
});

test("BOUNDED: a pathological rate·lifetime hard-caps (loudly, not silently)", () => {
  // rate·lifetime = 100000 ≫ PARTICLE_HARD_CAP; the array is capped, not unbounded.
  const huge = { ...P, rate: 100000, lifetime: 1 };
  const parts = simulateParticles(huge, 10);
  assert.ok(parts.length <= PARTICLE_HARD_CAP, `not capped: ${parts.length}`);
  assert.equal(parts.length, PARTICLE_HARD_CAP); // exactly the cap for a dense emitter
});

test("dead emitter (rate 0 or lifetime 0) ⇒ empty set", () => {
  assert.deepEqual(simulateParticles({ ...P, rate: 0 }, 5), []);
  assert.deepEqual(simulateParticles({ ...P, lifetime: 0 }, 5), []);
});

test("fully faded / fully shrunk particles are dropped (invisible)", () => {
  // a particle exactly AT death would have alpha 0 (fade 1) / r 0 (shrink 1);
  // simulateParticles drops r<=0 and alpha<=0, so none is emitted invisible.
  const parts = simulateParticles({ ...P, fade: 1, shrink: 1 }, 5);
  for (const p of parts) assert.ok(p.r > 0 && p.alpha > 0, `invisible particle leaked: ${JSON.stringify(p)}`);
});

// ── the plugin: params mapping, ops, ghost, defaults ─────────────────────────

test("emitterParams: origin = the widget's local center; seed floored", () => {
  const s = { ...particlesPlugin.defaults, w: 100, h: 40, particleSeed: 3.9 };
  const p = emitterParams(s);
  assert.equal(p.originX, 50);
  assert.equal(p.originY, 20);
  assert.equal(p.seed, 3); // floored so sub-unit tween wobble can't reshuffle
  assert.equal(p.rate, particlesPlugin.defaults.particleRate);
});

test("particleOps: one ellipse per particle; per-particle alpha × widget opacity", () => {
  const ops = particleOps([{ x: 10, y: 20, r: 3, alpha: 0.5 }], "#ffffff", 0.8);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "ellipse");
  assert.equal(ops[0].cx, 10);
  assert.equal(ops[0].rx, 3);
  assert.ok(Math.abs(ops[0].opacity - 0.4) < 1e-9); // 0.5 · 0.8
  assert.deepEqual(particleOps([], "#fff", 1), []);
});

test("plugin defaults: full param set + animated + effects, composed cleanly", () => {
  const d = particlesPlugin.defaults;
  assert.equal(d.type, "particles");
  assert.equal(d.particleRate, 40);
  assert.equal(d.particleColor, "#ffcc33");
  assert.equal(d.animated, true);       // an animated widget by default (like video)
  assert.equal(d.opacity, 1);
  assert.equal(d.blendMode, "normal");  // effects bundle, all off
  assert.deepEqual(particleDefaults(), {
    particleRate: 40, particleLifetime: 2, particleAngle: 270, particleSpread: 50,
    particleSpeedMin: 60, particleSpeedMax: 140, particleGravityX: 0, particleGravityY: 120,
    particleSizeMin: 2, particleSizeMax: 5, particleColor: "#ffcc33", particleFade: 1,
    particleShrink: 0, particleSeed: 1,
  });
});

test("CONDITIONAL GHOST (13.6): rate 0 or lifetime 0 ⇒ isGhost true", () => {
  assert.equal(particlesPlugin.isGhost({ particleRate: 0, particleLifetime: 2 }), true);
  assert.equal(particlesPlugin.isGhost({ particleRate: 40, particleLifetime: 0 }), true);
  assert.equal(particlesPlugin.isGhost({ particleRate: 40, particleLifetime: 2 }), false);
});

test("particleReach: conservative travel estimate for the effect footprint", () => {
  assert.equal(particleReach({ particleLifetime: 2, particleSpeedMax: 100, particleGravityX: 0, particleGravityY: 0, particleSizeMax: 5 }), 205);
  assert.equal(particleReach({ particleLifetime: 0, particleSpeedMax: 100 }), 0);
});

// ── the ambient clock ────────────────────────────────────────────────────────

test("particle_clock: PAUSED by default ⇒ the freeze constant", () => {
  assert.equal(isParticleClockLive(), false);
  assert.equal(particleTime(), EDITOR_FREEZE_TIME);
});

test("particle_clock: LIVE regime advances with the wall clock", () => {
  startParticleClock();
  assert.equal(isParticleClockLive(), true);
  const t0 = particleTime();
  // burn a little wall time
  const spin = Date.now() + 5; while (Date.now() < spin) { /* wait ~5ms */ }
  const t1 = particleTime();
  assert.ok(t1 >= t0, `time went backwards: ${t0} → ${t1}`);
  stopParticleClock();
  assert.equal(isParticleClockLive(), false);
  assert.equal(particleTime(), EDITOR_FREEZE_TIME); // back to paused freeze
});

test("particle_clock: override wins over both regimes (tests/CLI only)", () => {
  setParticleTimeOverride(3.5);
  assert.equal(particleTime(), 3.5);
  startParticleClock();
  assert.equal(particleTime(), 3.5); // override beats live
  stopParticleClock();
  setParticleTimeOverride(null);
  assert.equal(particleTime(), EDITOR_FREEZE_TIME);
});

test("plugin emit: deterministic at a fixed clock; empty for a dead emitter", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const s = { ...particlesPlugin.defaults, x: 0, y: 0 };
  setParticleTimeOverride(1.5);
  const a = JSON.stringify(particlesPlugin.emit(s, null, world));
  const b = JSON.stringify(particlesPlugin.emit(s, null, world));
  assert.equal(a, b);                              // same clock ⇒ identical
  setParticleTimeOverride(1.9);
  assert.notEqual(a, JSON.stringify(particlesPlugin.emit(s, null, world))); // diff clock ⇒ differs
  setParticleTimeOverride(null);
  assert.deepEqual(particlesPlugin.emit({ ...s, particleRate: 0 }, null, world), []); // ghost ⇒ nothing
});

console.log(`\n${passed} tests passed`);
