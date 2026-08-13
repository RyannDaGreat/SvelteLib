/**
 * Particle-emitter widget — the "sparkler" (manifest 13.5 PARTICLE EFFECT
 * WIDGET). An ANIMATED widget that emits a stream of particles: sparks, snow,
 * confetti, embers. The emitter's parameters (rate, lifetime, launch angle/
 * spread, speed range, gravity/drift, size range, color, fade, shrink, seed) are
 * NORMAL equation-capable properties from the shared registry (core/properties.js
 * `particles` bundle), so they tween and drive like every other property.
 *
 * ── DETERMINISM (the core invariant) ──────────────────────────────────────────
 * The render tree stays a PURE function of (document, [[slide, alpha]]). The
 * particle picture additionally depends on presentation TIME `t` — but `t` is an
 * AMBIENT presentation input (like a video's currentTime), NOT document state.
 * So emit() is a pure function of (evaluated state, ambient t): it reads `t` from
 * the ambient clock (render_gpu/particle_clock.js) and hands it, with the
 * emitter params, to the PURE closed-form simulation (core/particles.simulate
 * Particles) — a stateless function of (params, t, seed) with NO mutable pool,
 * NO dt accumulation, and NO Math.random (banned by architecture). Identical
 * (params, t, seed) ⇒ identical particles ⇒ identical pixels, so a CLI render
 * byte-reproduces the editor.
 *
 * ── THE TWO TIME REGIMES ──────────────────────────────────────────────────────
 *   EDITOR / CLI / thumbnails / export (PAUSED): the clock returns a FIXED
 *     freeze time (EDITOR_FREEZE_TIME), so the widget shows a REPRESENTATIVE
 *     still — visible and selectable (manifest 13.5) — and every still render is
 *     deterministic.
 *   PRESENTER (LIVE): the presenter starts the ambient clock (a wall clock) on
 *     entry and its existing per-frame rAF loop (which already runs for any
 *     visible `animated` widget) repaints; each repaint reads the advancing `t`
 *     and the sparkler animates. The `animated` toggle (below) gates this exactly
 *     like a video: off ⇒ the presenter renders the freeze still once and idles.
 *
 * ── RENDERING = ORDINARY IR OPS (free vector export, free GPU path) ───────────
 * Each live particle emits as an existing `ellipse` op (a filled disc). No new
 * IR op, no new GPU shader path: the WebGPU compositor already instances ellipses
 * (SDF discs), and the SVG/PDF backends already serialize ellipses — so the
 * sparkler exports to vector as real vector circles at the freeze time with ZERO
 * backend changes (the manifest's "particles at freeze-time as vector circles if
 * trivial via existing ops" path — it is trivial). Effects (shadow/bloom/blend)
 * compose via the shared bundle like every drawn widget.
 *
 * ── CONDITIONAL GHOST (manifest 13.6) ─────────────────────────────────────────
 * An emitter with rate 0 (or lifetime 0) emits NOTHING — like an empty filmstrip
 * it is invisible, so it declares the DYNAMIC isGhost(state) predicate: while it
 * would render nothing it gets the dashed-outline / findable-when-Show-Ghosts
 * affordance so it is never silently lost (filmstrip's exact precedent).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable — an ordinary placeable/draggable/resizable box.
 * The emission ORIGIN is the widget's LOCAL center (w/2, h/2), so moving/resizing
 * the box moves the fountain; particles fly from there in local space and sceneIR
 * wraps them in the node world transform (rotation/scale ride for free).
 * backdrop:false — like every non-sampler, particles paint in z-order and a
 * magnifier/blur above samples the composited canvas (they magnify correctly).
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { ellipse } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { simulateParticles } from "../core/particles.js";
import { particleTime } from "../render_gpu/particle_clock.js";

/**
 * Pure function. Maps a widget's flat state (particleRate, particleAngle, …) to
 * the compact param shape core/particles.simulateParticles reads (rate, angle,
 * …), injecting the emission ORIGIN as the widget's LOCAL center. Kept pure and
 * separate from emit() so tests can drive the simulation from a widget state at
 * an EXPLICIT `t` without the ambient clock (the determinism probe / render_gpu
 * tests do exactly this).
 *
 * Args:
 *   s (object): evaluated widget state (all particle* keys are numbers)
 *
 * Returns:
 *   object: the simulateParticles param object (origin at the bbox center)
 *
 * @example emitterParams({particleRate: 10, particleLifetime: 2, w: 100, h: 40, particleSeed: 3}).originX
 * 50
 * @example emitterParams({particleRate: 10, particleLifetime: 2, w: 100, h: 40, particleSeed: 3}).originY
 * 20
 * @example emitterParams({particleRate: 10, particleLifetime: 2, particleSeed: 3}).seed
 * 3
 */
export function emitterParams(s) {
  return {
    rate: s.particleRate ?? 0,
    lifetime: s.particleLifetime ?? 0,
    originX: (s.w ?? 0) / 2, // emission point = the widget's local center
    originY: (s.h ?? 0) / 2,
    angle: s.particleAngle ?? 0,
    spread: s.particleSpread ?? 0,
    speedMin: s.particleSpeedMin ?? 0,
    speedMax: s.particleSpeedMax ?? 0,
    gravityX: s.particleGravityX ?? 0,
    gravityY: s.particleGravityY ?? 0,
    sizeMin: s.particleSizeMin ?? 0,
    sizeMax: s.particleSizeMax ?? 0,
    fade: s.particleFade ?? 0,
    shrink: s.particleShrink ?? 0,
    // seed is coerced to an integer — equations/tweens can hand it a float; the
    // hash keys on an integer, so floor keeps the pattern stable across sub-unit
    // tween wobble (a fractional seed would flicker the whole system per frame).
    seed: Math.floor(s.particleSeed ?? 0),
  };
}

/**
 * Pure function. The IR ops for a set of simulated particles (LOCAL space):
 * one filled `ellipse` per particle, its radius and per-particle fade folded
 * into the op. `color` is the emitter's single particle color; a particle's own
 * alpha multiplies the widget opacity so a faded particle dims correctly on both
 * the GPU and vector backends (the ellipse op's `opacity` is the render-wide
 * opacity contract). Separated from emit() (pure, no clock) so render_gpu tests
 * assert the op shape directly.
 *
 * Args:
 *   particles (Array<{x,y,r,alpha}>): simulateParticles output (LOCAL coords)
 *   color (string|number[]): the particle color (passed to ir.ellipse)
 *   opacity (number): the widget's overall opacity (0..1)
 *
 * Returns:
 *   object[]: ellipse ops (one per particle)
 *
 * @example particleOps([{x: 10, y: 20, r: 3, alpha: 1}], "#fff", 1)[0].op
 * "ellipse"
 * @example particleOps([{x: 10, y: 20, r: 3, alpha: 0.5}], "#fff", 0.8)[0].opacity
 * 0.4
 * @example particleOps([], "#fff", 1)
 * []
 */
export function particleOps(particles, color, opacity) {
  return particles.map((p) =>
    ellipse({
      cx: p.x, cy: p.y, rx: p.r, ry: p.r,
      fill: color,
      strokeWidth: 0,
      opacity: opacity * p.alpha,
    }));
}

/**
 * THE PARTICLE PRESETS — twelve REAL PHYSICAL PHENOMENA (the metaballs.js
 * precedent: "each is a named REAL FLUID whose knobs follow its physics"), here
 * applied to ballistic emission instead of a fused surface. Every knob traces to
 * how the named thing actually moves: embers and bubbles carry NEGATIVE gravityY
 * because buoyancy overcomes weight; a fountain's positive gravity is what turns
 * its launch into an arc; rain and rocket exhaust are narrow and fast because
 * they are jets, snow and fireflies are wide and slow because they are not.
 *
 * EVERY PRESET SETS ALL 14 PARTICLE KNOBS (the sky.js:73-82 rule, restated for
 * this single-purpose family: with one bundle instead of several, "every knob of
 * its own family" IS every particle* row). applyPreset overlays `props` onto the
 * current frame, so a knob one preset omitted would keep whatever the
 * PREVIOUSLY HOVERED preset left there — running down the list to compare looks
 * is the whole point of the pane, and a partial preset would make that order-
 * dependent.
 *
 * NO PRESET SHIPS rate 0 OR lifetime 0 — either makes the emitter a ghost
 * (particlesPlugin.isGhost), i.e. a preset that would draw nothing.
 *
 * SEED IS NEVER THE DIFFERENTIATOR. Every preset below differs from every other
 * in rate, lifetime, angle, spread, speed, gravity, size, color, fade or shrink
 * — the actual physics — and particleSeed is set (to a small varied integer,
 * so two presets never look coincidentally hand-synced) but never carries the
 * distinction by itself; tests/particles_presets_test.js's distinctness gate
 * renders real pixels at a fixed particleTime, which a seed-only change could
 * pass without the presets differing in any way that matters.
 *
 * ORDER: upward-drifting phenomena (sparkler, embers, bubbles, steam, magic,
 * fireflies) first, then the ballistic/gravity-dominated ones (fountain, rocket
 * exhaust, confetti, rain), then the slow ambient ones (snowfall, dust motes).
 */
const PRESETS = [
  {
    name: "Sparkler",
    description: "A handheld firework: a tight, fast jet of hot gold sparks fighting real gravity, burning out to nothing well before they'd fall far.",
    props: {
      particleRate: 120, particleLifetime: 0.5,
      particleAngle: 270, particleSpread: 90, particleSpeedMin: 80, particleSpeedMax: 220,
      particleGravityX: 0, particleGravityY: 150,
      particleSizeMin: 1, particleSizeMax: 2.5,
      particleColor: "#ffb400", particleFade: 1, particleShrink: 0.6, particleSeed: 3,
    },
  },
  {
    name: "Campfire Embers",
    description: "Glowing ash lofted by the fire's own updraft: gravityY is NEGATIVE, because hot embers are lighter than the air around them and rise until they cool and wink out.",
    props: {
      particleRate: 18, particleLifetime: 3.5,
      particleAngle: 270, particleSpread: 70, particleSpeedMin: 15, particleSpeedMax: 45,
      particleGravityX: 8, particleGravityY: -35,
      particleSizeMin: 1.5, particleSizeMax: 3.5,
      particleColor: "#ff7a1a", particleFade: 1, particleShrink: 0.5, particleSeed: 11,
    },
  },
  {
    name: "Rising Bubbles",
    description: "Air escaping underwater: buoyancy again wins over weight, so gravityY is negative and steady, and the bubbles wobble sideways on the way up rather than flying outward.",
    props: {
      particleRate: 8, particleLifetime: 4,
      particleAngle: 270, particleSpread: 30, particleSpeedMin: 20, particleSpeedMax: 35,
      particleGravityX: 0, particleGravityY: -22,
      particleSizeMin: 3, particleSizeMax: 7,
      particleColor: "#1ec8ffcc", particleFade: 0.4, particleShrink: 0, particleSeed: 22,
    },
  },
  {
    name: "Steam",
    description: "Vapor off a hot cup: a soft upward billow that spreads wide as it rises and vanishes fast, a light drift standing in for the negative buoyancy that lifts it.",
    props: {
      particleRate: 30, particleLifetime: 1.8,
      particleAngle: 270, particleSpread: 110, particleSpeedMin: 10, particleSpeedMax: 30,
      particleGravityX: 0, particleGravityY: -12,
      particleSizeMin: 4, particleSizeMax: 9,
      particleColor: "#c9d6dd70", particleFade: 1, particleShrink: 0.1, particleSeed: 6,
    },
  },
  {
    name: "Magic Sparkle",
    description: "A small radial shimmer with no gravity of its own — an enchantment, not a physical object — each mote flaring out, fading and shrinking to nothing.",
    props: {
      particleRate: 40, particleLifetime: 1.2,
      particleAngle: 270, particleSpread: 360, particleSpeedMin: 20, particleSpeedMax: 70,
      particleGravityX: 0, particleGravityY: -6,
      particleSizeMin: 1, particleSizeMax: 3,
      particleColor: "#c02bff", particleFade: 1, particleShrink: 0.8, particleSeed: 44,
    },
  },
  {
    name: "Fireflies",
    description: "A summer-evening drift: very few, very slow, almost weightless motes wandering in every direction, glowing steadily for seconds at a time rather than streaking or falling.",
    props: {
      particleRate: 3, particleLifetime: 6,
      particleAngle: 270, particleSpread: 360, particleSpeedMin: 4, particleSpeedMax: 14,
      particleGravityX: 0, particleGravityY: -2,
      particleSizeMin: 2, particleSizeMax: 4,
      particleColor: "#d4ff5c", particleFade: 0.3, particleShrink: 0, particleSeed: 57,
    },
  },
  {
    name: "Fountain",
    description: "A jet aimed straight up under real gravity: launch speed and downward acceleration are both large, so the water arcs over visibly instead of just drifting — the ballistic parabola gravity alone can draw.",
    props: {
      particleRate: 90, particleLifetime: 1.6,
      particleAngle: 270, particleSpread: 18, particleSpeedMin: 180, particleSpeedMax: 260,
      particleGravityX: 0, particleGravityY: 320,
      particleSizeMin: 1.5, particleSizeMax: 3,
      particleColor: "#bfe0ff", particleFade: 0.6, particleShrink: 0, particleSeed: 2,
    },
  },
  {
    name: "Rocket Exhaust",
    description: "Hot gas blasted downward from a climbing rocket: high speed, a narrow cone, and a burn so fast the flame is gone (faded and shrunk to nothing) well before gravity could bend its path.",
    props: {
      particleRate: 200, particleLifetime: 0.35,
      particleAngle: 90, particleSpread: 25, particleSpeedMin: 250, particleSpeedMax: 400,
      particleGravityX: 0, particleGravityY: 60,
      particleSizeMin: 2, particleSizeMax: 5,
      particleColor: "#ffb347", particleFade: 1, particleShrink: 0.7, particleSeed: 8,
    },
  },
  {
    name: "Confetti Burst",
    description: "A full radial pop under strong gravity: every particle launches at once in every direction, then arcs back down like the paper scraps it is, without fading or shrinking on the way.",
    props: {
      particleRate: 260, particleLifetime: 1.5,
      particleAngle: 270, particleSpread: 360, particleSpeedMin: 120, particleSpeedMax: 320,
      particleGravityX: 0, particleGravityY: 260,
      particleSizeMin: 2, particleSizeMax: 4,
      particleColor: "#ff3d7f", particleFade: 0, particleShrink: 0, particleSeed: 19,
    },
  },
  {
    name: "Rain",
    description: "A downpour: a tight near-vertical jet, fast and heavy, with neither fade nor shrink — a raindrop looks the same the instant before it lands as it did leaving the cloud.",
    props: {
      particleRate: 260, particleLifetime: 1.1,
      particleAngle: 95, particleSpread: 6, particleSpeedMin: 340, particleSpeedMax: 420,
      particleGravityX: 20, particleGravityY: 260,
      particleSizeMin: 0.6, particleSizeMax: 1.2,
      particleColor: "#9db8cc", particleFade: 0, particleShrink: 0, particleSeed: 33,
    },
  },
  {
    name: "Snowfall",
    description: "A gentle drift down: wide spread, low speed and weak gravity so flakes drift and settle rather than fall in straight lines, living long enough to cross the whole frame.",
    props: {
      particleRate: 80, particleLifetime: 6,
      particleAngle: 90, particleSpread: 150, particleSpeedMin: 8, particleSpeedMax: 20,
      particleGravityX: 4, particleGravityY: 14,
      particleSizeMin: 2, particleSizeMax: 5,
      particleColor: "#ffffff", particleFade: 0.1, particleShrink: 0, particleSeed: 5,
    },
  },
  {
    name: "Dust Motes",
    description: "Particles hanging in a sunbeam: barely moving, barely falling, just enough drift and gravity to keep them turning over instead of frozen, visible for a long, slow life.",
    props: {
      particleRate: 1.5, particleLifetime: 8,
      particleAngle: 270, particleSpread: 360, particleSpeedMin: 2, particleSpeedMax: 8,
      particleGravityX: 1, particleGravityY: 4,
      particleSizeMin: 0.5, particleSizeMax: 1,
      particleColor: "#6b5a3a55", particleFade: 0.5, particleShrink: 0, particleSeed: 71,
    },
  },
];

export const particlesPlugin = {
  type: "particles",
  ephemeral: EPHEMERAL.NONE,
  title: "Particles",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  presets: PRESETS,
  defaults: {
    type: "particles", x: 200, y: 200, w: 80, h: 80, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // The emitter parameters — ALL from the shared registry `particles` bundle
    // (single-sourced defaults + help + bounds). See core/properties.js.
    ...particleDefaults(),
    // `animated` (manifest ANIMATED WIDGET): keeps the presenter rendering every
    // frame while the emitter is visible so the stream flows. Default true (its
    // content moves on its own, like a video). opacity:1.
    ...defaults("animated", "opacity"),
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  inspector: [
    ...bundle("transform"),
    // The emitter parameters (rate/lifetime/launch/gravity/size/appearance/seed).
    ...bundle("particles"),
    // The animated toggle + opacity, then the shared effects bundle.
    ...props("animated", "opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (reads the AMBIENT particle clock; pure w.r.t. document
   * state). State → display-list commands (LOCAL space): the particles alive at
   * the current ambient time `t`, each an `ellipse` op, wrapped by the shared
   * effects bundle. Reads `t` from render_gpu/particle_clock.js — the freeze
   * constant in the editor/CLI (deterministic still), the wall clock in the
   * presenter (animated). The MATH is the pure simulateParticles(params, t):
   * this function only sources `t` and shapes ops.
   *
   * A dead emitter (rate 0 / lifetime 0 → no particles) returns [] (a ghost —
   * see isGhost). Effects wrap the whole burst (all-off = pass-through); the
   * effect bbox is the widget's own bbox INFLATED by the particles' reach so a
   * shadow/bloom of the spray isn't clipped (particleReach).
   */
  emit(s, _targetWorldIR, world) {
    const t = particleTime();
    const parts = simulateParticles(emitterParams(s), t);
    if (parts.length === 0) return []; // dead emitter → nothing (ghost)
    const ops = particleOps(parts, s.particleColor ?? "#ffffff", s.opacity ?? 1);
    // Effect footprint = the emitter bbox grown by how far particles travel, so
    // a shadow/bloom of the spray is captured (not just the tiny origin box).
    const reach = particleReach(s);
    const bbox = { x: -reach, y: -reach, w: (s.w ?? 0) + 2 * reach, h: (s.h ?? 0) + 2 * reach };
    return applyEffects(ops, s, world, bbox);
  },
  /**
   * Pure function. Is this emitter currently a GHOST (manifest 13.6 CONDITIONAL
   * GHOSTS: "same with text ... a widget whose current state renders nothing")?
   * True exactly when it emits no particles — rate 0 or lifetime 0 — mirroring
   * emit()'s own empty condition (one source of truth for "empty"), so a
   * rate-0 sparkler gets the dashed-outline / findable-when-Show-Ghosts
   * affordance instead of vanishing. Filmstrip's isGhost is the precedent.
   *
   * @example particlesPlugin.isGhost({ particleRate: 0, particleLifetime: 2 })
   * true
   * @example particlesPlugin.isGhost({ particleRate: 40, particleLifetime: 2 })
   * false
   */
  isGhost(state) {
    return !((state.particleRate ?? 0) > 0 && (state.particleLifetime ?? 0) > 0);
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook),
  // measured from the emitter's OWN state — the same effects margin every drawn
  // widget uses. (The particle reach itself is not a cull concern here: culling
  // is a conservative bbox test and the emitter's own bbox suffices for
  // visibility — a fully off-screen emitter whose sparks reach on-screen is an
  // acceptable edge the default bbox cull may skip, matching how a widget just
  // off-screen with a long shadow is handled by effectsCullMargin.)
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    // The clickable target is the emitter BOX (the origin region). The sparks
    // themselves are RECORDABLE state — a pure function of (params, t, seed)
    // with no stored per-spark geometry — so there is nothing to hit-test
    // against, exactly like a video's frame.
    return lx >= 0 && ly >= 0 && lx <= (s.w ?? 0) && ly <= (s.h ?? 0);
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    // Crosshair bbox placement (manifest UNDEFERRAL SWEEP: crosshair placement
    // for ALL Add buttons). CanvasView drives the gesture generically off the
    // plugin (type + .defaults) — no per-plugin CanvasView code.
    { id: "add-particles", title: "Add Particles", icon: "mdi:shimmer", run: (app) => app.armCrosshairPlacement(particlesPlugin) },
  ],
};

/**
 * Pure function. The particle-parameter DEFAULTS fragment — every particle*
 * key's registry default, flattened for the plugin `defaults`. Uses the same
 * defaults() machinery every bundle uses (bundleDefaults would work too; this
 * spells the keys so a reader sees the emitter's full default parameter set in
 * one place and it stays in lockstep with the bundle order).
 *
 * @example particleDefaults().particleRate
 * 40
 * @example particleDefaults().particleColor
 * "#ffcc33"
 */
export function particleDefaults() {
  return defaults(
    "particleRate", "particleLifetime",
    "particleAngle", "particleSpread", "particleSpeedMin", "particleSpeedMax",
    "particleGravityX", "particleGravityY",
    "particleSizeMin", "particleSizeMax",
    "particleColor", "particleFade", "particleShrink", "particleSeed",
  );
}

/**
 * Pure function. A conservative estimate of how far (canvas units) particles
 * travel from the emitter origin over a full lifetime — max launch distance plus
 * the ballistic gravity displacement plus the largest birth radius. Used to size
 * the effect footprint (so a shadow/bloom of the spray isn't clipped). An
 * over-estimate only grows an offscreen effect texture slightly; it never clips.
 *
 * Args:
 *   s (object): evaluated widget state (particle* params)
 *
 * Returns:
 *   number: reach in canvas units (>= 0)
 *
 * @example particleReach({particleLifetime: 2, particleSpeedMax: 100, particleGravityX: 0, particleGravityY: 0, particleSizeMax: 5})
 * 205
 * @example particleReach({particleLifetime: 0, particleSpeedMax: 100})
 * 0
 */
export function particleReach(s) {
  const life = s.particleLifetime ?? 0;
  if (!(life > 0)) return 0;
  const vmax = s.particleSpeedMax ?? 0;
  const g = Math.hypot(s.particleGravityX ?? 0, s.particleGravityY ?? 0);
  // max |position| ≈ v·life + ½·g·life² (straight-line worst case) + birth size.
  return vmax * life + 0.5 * g * life * life + (s.particleSizeMax ?? 0);
}
