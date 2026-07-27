/**
 * THE `sky*` ARCHETYPE — a family of DEMO WIDGETS (plugins/demo/) that render a
 * physically-based sky AND INTERACT with one another. Four members, all GENERATIVE
 * foreground materials (materialFill; render_gpu/skia/sky_*_shader.js), each a bbox
 * widget with equation-capable self.* knobs:
 *
 *   sky        — the atmospheric dome: analytic Rayleigh+Mie scattering driven by
 *                the scene's suns, a horizon/ground, and (at night) a procedural
 *                star field + Milky Way. READS the suns/moons.
 *   skySun     — a sun disc + Mie aureole. Its POSITION + COLOUR feed the sky
 *                (and clouds). MULTIPLE allowed.
 *   skyMoon    — a phased moon (correct curved terminator, waxing/waning). READS
 *                the suns to point its lit limb at the nearest one.
 *   skyClouds  — fbm clouds lit by the sun(s), catching warm sunset colour. READS
 *                the suns.
 *
 * ── THE CROSS-WIDGET INTERACTION (the archetype's crux) ──────────────────────
 * A widget reading its siblings is otherwise impossible (emit sees only its own
 * state). core/derive.resolveSkyScene attaches a WORLD-space {suns, moons} summary
 * (collectSkyScene) to every `skyReader` node's derived state. Each reader's emit()
 * receives its own `world` transform (the arg-3 seam, render_gpu/ports.js) and maps
 * every sibling's world CENTRE into its OWN local box frame [-1,1] via
 * `mapToBoxFrame` — so the mapping stays correct under move/rotate/scale of the
 * reader box. The result rides the op's `params` (arrays pass the materialFill
 * finite-number gate untouched) and the SkSL packs them into fixed uniform arrays.
 * Everything is a pure function of the folded state ⇒ RenderTree stays pure and the
 * CLI reproduces the editor byte-for-byte.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-free
 * / bare-node-safe at import.
 */

import * as T from "../../core/transform.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialFill } from "../../render_gpu/ir.js";
import { particleTime } from "../../render_gpu/particle_clock.js";

const EMPTY_SCENE = { suns: [], moons: [] };
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };

/**
 * Pure function. Maps a WORLD point into a reader box's LOCAL [-1,1] frame — the
 * exact frame the shaders use (fuv = pl/uHalfSize, box centre = 0, edges = ±1). The
 * box's stored geometry is a local [0..w]×[0..h] rect centred at (w/2, h/2), so a
 * world point is inverted through `world`, re-centred, and normalized by the half
 * extent. Rotation/scale of the box are handled by the world inverse, so the sun
 * lands where it visually sits regardless of how the sky box is posed.
 *
 * @param {object} world - the reader node's local→world similarity {x,y,rotation,scale}
 * @param {number} w - box width (local units)
 * @param {number} h - box height (local units)
 * @param {number} wx - world x of the sibling
 * @param {number} wy - world y of the sibling
 * @returns {{sx: number, sy: number}} box-frame coords (fuv space; sy is y-DOWN)
 *
 * @example mapToBoxFrame({x: 0, y: 0, rotation: 0, scale: 1}, 200, 100, 100, 50) // {sx: 0, sy: 0} (centre)
 * @example mapToBoxFrame({x: 0, y: 0, rotation: 0, scale: 1}, 200, 100, 200, 50) // {sx: 1, sy: 0} (right edge)
 * @example mapToBoxFrame({x: 0, y: 0, rotation: 0, scale: 1}, 200, 100, 100, 0) // {sx: 0, sy: -1} (top edge)
 */
export function mapToBoxFrame(world, w, h, wx, wy) {
  const local = T.apply(T.invert(world), wx, wy);
  return { sx: (local.x - w / 2) / (w / 2), sy: (local.y - h / 2) / (h / 2) };
}

/** Pure. The queried suns mapped into a reader box's frame, ready for the packer. */
function mappedSuns(scene, world, w, h) {
  return (scene.suns ?? []).map((s) => {
    const { sx, sy } = mapToBoxFrame(world, w, h, s.x, s.y);
    return { sx, sy, color: s.color, intensity: s.intensity };
  });
}

/**
 * Pure function. A moon's illuminated fraction for its phase, f = (1 − cos ε)/2 with
 * elongation ε = 2π·phase (0 new → 0, 0.5 full → 1). Used to lift the sky's night
 * ambient by how much moonlight the moon(s) provide.
 *
 * @param {number} phase - 0..1
 * @returns {number} 0..1
 *
 * @example illuminatedFraction(0)    // 0   (new moon)
 * @example illuminatedFraction(0.5)  // 1   (full moon)
 * @example illuminatedFraction(0.25) // 0.5 (first quarter)
 */
export function illuminatedFraction(phase) {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

// The sky's night-ambient lift per fully-lit moon (a dim silvery wash, not daylight).
const MOONLIGHT_GAIN = 0.28;

/**
 * SCRUB SENSITIVITY for the rows below that no longer carry a min AND a max.
 *
 * WHY: web/NumericField.svelte only range-scales a row that has BOTH bounds — it spans
 * the full range across RANGE_DRAG_PX of drag — so a half-open or fully open row falls
 * back to DraggableNumber's 1 unit per drag-pixel. A 1 px twitch would then throw the
 * horizon from the floor to the ceiling, or spin the star sphere a whole turn. Every row
 * this file frees therefore carries an explicit `scrub` = (the span it used to have) /
 * RANGE_DRAG_PX, which reproduces EXACTLY the feel it had while it was bounded. Same
 * rule and same derivation as core/properties.js SECONDS_SCRUB and UNIT_SPAN_SCRUB.
 *
 * The ONE-UNIT case is UNIT_SPAN_SCRUB, imported from core/properties.js: the 0..1
 * fractions (moon phase, earthshine, maria, cloud coverage/softness, the discs' size —
 * the two size rows spanned 0.99 and 0.95, one unit to within a few percent) and the
 * 0..1 star-sphere turn. The two spans below are this file's own and stay local.
 */
const RANGE_DRAG_PX = 100; // web/NumericField.svelte's own constant (px of drag per full range)
/**
 * Rows that span TWO units: the [−1, +1] BOX FRAME the sky shaders work in (the horizon
 * row, whose bounded feel this preserves exactly) and the Milky-Way strength, whose old
 * 0..2 range happens to have the same span.
 */
const BOX_SPAN_SCRUB = 2 / RANGE_DRAG_PX;
/** Turbidity's old 1..12 haze range (span 11). */
const HAZE_SPAN_SCRUB = 11 / RANGE_DRAG_PX;

// BOUNDS POLICY for every row in this file (manifest "no arbitrary constraints invented
// by Claude"; the same audit plugins/demo/lens_flare.js carries). A knob whose only limit
// was taste carries none — a value the shader renders is a value the user may ask for.
// Every min/max that SURVIVES is GEOMETRIC or TECHNICAL and says why on its row, and the
// reason is always one of three MEASURED things: (a) the shader's own `max(·, EPS)` guard
// would SILENTLY SWALLOW anything past that point (a silent clamp discards the user's
// value — the same disease as a UX cap), (b) the maths breaks past it (a divisor through
// zero, or a smoothstep whose edges cross — undefined in the shading language), or (c) the
// value is provably unreachable past it (nothing downstream can respond). Every claim below
// was measured by rendering the material at the value and hashing the pixels.

// ── sky ───────────────────────────────────────────────────────────────────────
const SKY_CUSTOM = customProps([
  // NO FLOOR (the old min:−1 was ARBITRARY — a position in the box frame capped at the
  // box's own edges, which blocked the legitimate all-sky framing). Pushing the horizon
  // below the bottom edge only GROWS the mapping's denominator (1 − horizon), so the
  // dome stays smooth and simply compresses toward the zenith: −2 and −4 render clean,
  // distinct, sun-lit skies with no ground band. The CEILING OF +1 IS TECHNICAL and
  // stays: render_gpu/skia/sky_shader.js maps box height to elevation with
  // `(up − uHorizon) / max(1 − uHorizon, EPS)`, whose denominator is exactly 0 at +1 and
  // NEGATIVE (a sign flip of the whole dome) above it. Its `max(·, EPS)` divide guard
  // already SILENTLY swallows anything past +1 — measured: horizon 1.5 and horizon 4
  // render byte-identically — and a silent clamp discards the user's value, which is
  // the same disease as a UX cap. +1 is not a taste line either: it already IS the
  // all-ground framing (the whole box is below the horizon), so nothing is lost.
  { name: "horizon", kind: "number", default: -0.15, max: 1, scrub: BOX_SPAN_SCRUB, help: "Horizon height in the box frame (−1 bottom … +1 top). Below it is ground, above it is sky. Lower = more sky, and NO lower bound — push it past −1 for an all-sky framing with no ground at all (the dome just compresses toward the zenith). +1 is the top edge: the whole box becomes ground, which is as far as the horizon can go." },
  // NO CEILING (the old max:12 was ARBITRARY — 40, 500 and 10000 render distinct,
  // progressively thicker smogs). THE FLOOR OF 0 IS TECHNICAL and 0 itself is a real,
  // useful sky (pure Rayleigh — the deepest blue there is). Turbidity scales the MIE
  // coefficient, and the dome's closed-form scatter divides by the TOTAL extinction
  // betaTot = uAtmosphere·(BETA_R + BETA_M·uTurbidity/3): a NEGATIVE turbidity walks each
  // colour channel's divisor through its own zero (red at −8.286, green at −19.3, blue at
  // −47.3) and flips that channel's transmittance exp(−betaTot·airmass) into exponential
  // GROWTH. Measured: −4 punches a black hole around the sun, −20 is neon yellow/magenta
  // channel-clipping bands, and everything at or below −1000 collapses to ONE flat white
  // frame (−1000 and −100000 are byte-identical — a silent swallow). A scattering
  // coefficient cannot be negative; this floor is where the model stops being a model.
  { name: "turbidity", kind: "number", default: 3, min: 0, scrub: HAZE_SPAN_SCRUB, help: "Atmospheric haze: scales Mie scattering. 0 = pure Rayleigh (the deepest, cleanest blue), ~2 = very clear, ~8 = hazy/washed-out with a broad sun glow, and NO upper cap — hundreds give a thick warm smog. 0 is a REAL floor, not taste: turbidity scales a scattering coefficient, and a negative one drives the sky's own divisor through zero." },
  // FLOOR NOW 0 (the old min:0.1 was ARBITRARY — 0.001, 0.02 and 0.1 render distinct,
  // ever-thinner skies). 0 ITSELF IS TECHNICAL AND IS NOW LEGAL: betaTot is the divisor of
  // the closed-form single scatter and vanishes with uAtmosphere, so 0 used to be an
  // UNGUARDED 0/0 — measured, the whole dome came out flat white (a NaN rendering as
  // backend-defined garbage). render_gpu/skia/sky_shader.js now floors that divisor with
  // BETA_FLOOR, which makes 0 the exact physical limit (no scattering ⇒ a black airless
  // sky with only the ground band) and leaves every positive value byte-identical.
  { name: "atmosphere", kind: "number", default: 1, min: 0, help: "Overall atmosphere thickness — scales all scattering. Higher = denser/brighter sky (past ~100 the dome saturates into its own haze); 0 is the airless limit, a black sky with only the ground showing. 0 is a REAL floor: this is the divisor of the scattering integral." },
  // NO BOUNDS (the old min:0.05 was ARBITRARY). 0 is a black day sky and NEGATIVE values
  // are honoured, not swallowed: the tone map 1 − exp(−exposure·daySky) turns them into
  // SUBTRACTED light — measured, −1, −2 and −5 each render a distinct twilight (mean luma
  // 9.450 / 9.460 / 9.580) before −50 and below bottom out at one solid black frame.
  { name: "exposure", kind: "number", default: 1.1, help: "HDR tone-map exposure. Higher = brighter overall (past ~20 the day sky blows out to white); 0 leaves a black day sky, and there is no floor — a negative exposure SUBTRACTS light, crushing the dome through twilight to black." },
  // FLOOR NOW 0 (the old min:1 was ARBITRARY: densities 0, 0.5, 1 and 1.4 render DISTINCT
  // skies — at a star-sphere rotation where the coarse grid actually lands a star, e.g.
  // timeOfDay 0.37 or 0.61). 0 IS THE TECHNICAL FLOOR: the SkSL passes
  // max(uStarDensity, EPS) into starField, so anything below silently becomes EPS —
  // measured, −46 and −100 are byte-identical to 0. Same shape as lens_flare's
  // SPIKE_BASE_EPS floor: the guard is what makes 0 itself legal and deterministic.
  { name: "starDensity", kind: "number", default: 46, min: 0, help: "Star-field grid resolution — more = more stars (visible at night); no upper cap. Below ~1 the grid is coarser than the whole sky, so stars thin out to none. 0 is the floor because the shader's own guard would silently swallow anything under it." },
  // NO BOUNDS (both were ARBITRARY). Past the old max:2 the band keeps brightening —
  // 8 and 100 are distinct, ever more blazing galaxies — and NEGATIVE values are honoured
  // too (−1 and −5 render distinct night skies, mean luma 9.46 vs 8.05): the band is
  // SUBTRACTED, carving a dark dust lane out of the night. Neither end swallows.
  { name: "milkyWay", kind: "number", default: 1, scrub: BOX_SPAN_SCRUB, help: "Milky-Way band strength (0 = off). Only visible at night. Unbounded both ways: past 2 the band keeps brightening until its core saturates white, and a negative value subtracts it, carving the band out of the sky as a dark dust lane." },
  // NO BOUNDS: the rotation is PERIODIC — the SkSL does rot2(g, uTimeOfDay·TWO_PI) — so the
  // old 0..1 cap was ARBITRARY and it blocked the one thing a periodic angle is for:
  // keyframing a multi-turn spin (0 → 3). Measured byte-identical: 0 ≡ 1 ≡ 3, and
  // 0.25 ≡ 1.25 ≡ 12.25 ≡ 100.25 ≡ 10000.25 (the float32 argument survives 10 000 turns),
  // 0.5 ≡ 2.5 ≡ −0.5. Same reasoning as lens_flare.js's deliberately uncapped
  // starburstRotation — the older precedent for an unbounded periodic angle.
  { name: "timeOfDay", kind: "number", default: 0.2, scrub: UNIT_SPAN_SCRUB, help: "Rotates the star sphere + Milky Way: 0..1 is ONE full turn, and it is unbounded because the rotation is periodic — keyframe 0 → 3 to spin the night sky three whole turns (2.5 renders exactly like 0.5, as a turn should), or go negative to wheel the other way. The day/night look itself is driven by the SUN widgets' elevation, not this." },
  { name: "zenith", kind: "color", default: "#ffffff", help: "Zenith colour multiplier applied to the scattered day sky. White = pure physics; tint to warm/cool the whole dome." },
  { name: "ground", kind: "color", default: "#0d1017", help: "Ground/foreground colour below the horizon (darkens at night)." },
  { name: "night", kind: "color", default: "#04060e", help: "Deep night-sky colour the dome fades to once every sun is below the horizon." },
  { name: "galaxyTint", kind: "color", default: "#46567c", help: "Milky-Way glow tint (a cool dusty blue; the bright core adds warm highlights)." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the sky region (world px). Floor 0 is GEOMETRIC — a radius is a length, and render_gpu/ir.js materialFill clamps it there too." },
]);

export const skyPlugin = {
  type: "sky",
  title: "Sky",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyReader: true },
  defaults: {
    type: "sky", x: 60, y: 60, w: 1000, h: 620, z: 1, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("animated", "opacity"),
    ...SKY_CUSTOM.defaults,
  },
  inspector: [...bundle("positioning"), ...props("animated", "opacity"), ...SKY_CUSTOM.rows],
  /**
   * Near-pure function (reads the ambient particle clock). State → ONE materialFill
   * op naming the "sky" material. Reads the sibling query (s.skyScene) — maps the
   * suns into this box's local frame and folds the moons into a moonlight lift.
   */
  emit(s, _sub, world) {
    const scene = s.skyScene ?? EMPTY_SCENE;
    const w = world ?? IDENTITY;
    const moonlight = MOONLIGHT_GAIN * (scene.moons ?? []).reduce((a, m) => a + illuminatedFraction(m.phase), 0);
    return [materialFill({
      material: "sky",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2, cornerRadius: s.cornerRadius,
      params: {
        time: particleTime(),
        horizon: s.horizon, turbidity: s.turbidity, atmosphere: s.atmosphere, exposure: s.exposure,
        starDensity: s.starDensity, milkyWay: s.milkyWay, timeOfDay: s.timeOfDay, moonlight,
        zenith: s.zenith, ground: s.ground, night: s.night, galaxyTint: s.galaxyTint,
        suns: mappedSuns(scene, w, s.w, s.h),
      },
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest: bboxHit,
  snapFeatures: centerSnap,
  anchors: standardBBoxAnchors,
};

// ── skySun ──────────────────────────────────────────────────────────────────
const SUN_CUSTOM = customProps([
  { name: "color", kind: "color", default: "#fff4d6", help: "The sun's light colour. Drives the disc AND the sky's scattering + the clouds' sunlit colour — set it warm/orange for a sunset that spreads to the whole scene." },
  // NO FLOOR (the old min:0 was ARBITRARY and it blocked a real look: a NEGATIVE radiance
  // tone-maps the disc to black while the aureole still burns around it — a total ECLIPSE.
  // Measured distinct at −1, −3 and −5; the image is in .claude_vlm_checks.)
  { name: "intensity", kind: "number", default: 3, help: "Sun disc radiance (how bright/blown-out the core reads). Also the weight the sky/clouds give this sun. No bounds — a negative radiance blacks the disc out behind its own corona, i.e. a total eclipse." },
  // NO CEILING (the old max:1 was ARBITRARY — it forbade a sun bigger than its own box,
  // and 1.5 renders a distinct sun overflowing the frame; past the box DIAGONAL the disc
  // simply covers everything, which is why 3 and 30 are byte-identical — a swallow point
  // that depends on the box's aspect, so no fixed number could sit there). FLOOR NOW 0
  // (the old min:0.01 was ARBITRARY: 0, 0.005 and 0.01 render distinct — 0 is a pure
  // point-source glow with no disc). 0 IS TECHNICAL: the disc is
  // 1 − smoothstep(uSize, 1.12·uSize + EDGE_AA/minHalf, r), whose two edges CROSS once
  // uSize drops below −EDGE_AA/(0.12·minHalf) — a smoothstep with edge0 > edge1 is
  // undefined in the shading language, and that threshold is in DEVICE px, so it moves
  // with zoom: the appearance would become a function of camera state, which the core
  // invariant forbids. Measured: size −0.5 fills the whole box white.
  { name: "size", kind: "number", default: 0.26, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Sun disc radius as a fraction of the box's shorter half-extent. No cap — past 1 the disc spills out of its box, and past the box diagonal it covers the whole box. 0 is the floor: it leaves a pure point-source glow with no disc, and below it the disc's own edge test would invert." },
  // NO FLOOR (the old min:0 was ARBITRARY — −0.5 and −1 render distinct suns with the halo
  // subtracted away; only around −5 does the aureole eat the widget's own alpha and the
  // sun vanish entirely, and that point moves with the disc size, so no fixed number sits
  // there).
  { name: "glow", kind: "number", default: 0.9, help: "Aureole strength — the Mie forward-scatter halo bleeding out around the disc. No bounds: negative values subtract the halo, and far enough negative they cancel the sun away entirely." },
  // FLOOR NOW 0 (the old min:0.02 was ARBITRARY — 0.002 and 0.02 render distinct, ever
  // tighter aureoles). 0 IS THE TECHNICAL FLOOR: the SkSL divides by max(uGlowRadius, EPS),
  // so everything at or below EPS = 1e-3 is the SAME frame — measured, 0, 0.0009, 0.001,
  // −0.5 and −5 are byte-identical, i.e. the guard silently swallows them. As with
  // lens_flare's SPIKE_BASE_EPS, the guard is what makes 0 itself legal.
  { name: "glowRadius", kind: "number", default: 0.18, min: 0, help: "Tight-aureole falloff (fraction of the shorter half-extent) hugging the disc. The broad halo has compact support to the box edge; this controls the bright inner ring. No cap. 0 collapses the inner ring into the disc, and is the floor because the shader's own divide guard would silently swallow anything under it." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px). Floor 0 is GEOMETRIC — a radius is a length, and render_gpu/ir.js materialFill clamps it there too." },
]);

export const skySunPlugin = {
  type: "skySun",
  title: "Sky Sun",
  // skyLight:"sun" marks it a LIGHT SOURCE the sky/clouds read (core/derive.collectSkyScene).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyLight: "sun" },
  defaults: {
    type: "skySun", x: 200, y: 140, w: 200, h: 200, z: 6, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("opacity"),
    ...SUN_CUSTOM.defaults,
  },
  inspector: [...bundle("positioning"), ...props("opacity"), ...SUN_CUSTOM.rows],
  /** Pure function. State → ONE materialFill op naming the "skySun" material. */
  emit(s) {
    return [materialFill({
      material: "skySun",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2, cornerRadius: s.cornerRadius,
      params: { time: particleTime(), color: s.color, intensity: s.intensity, size: s.size, glow: s.glow, glowRadius: s.glowRadius },
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest: bboxHit,
  snapFeatures: centerSnap,
  anchors: standardBBoxAnchors,
};

// ── skyMoon ─────────────────────────────────────────────────────────────────
const MOON_CUSTOM = customProps([
  // NO BOUNDS: the phase is PERIODIC — the SkSL builds the sun direction from
  // eps = TWO_PI·uPhase — so the old 0..1 cap was ARBITRARY and blocked animating more
  // than a single lunation. Measured byte-identical: 0 ≡ 1 ≡ 3, 0.25 ≡ 1.25 ≡ −0.75,
  // 0.5 ≡ 2.5. Keyframe 0 → 3 for three lunar cycles.
  { name: "phase", kind: "number", default: 0.72, scrub: UNIT_SPAN_SCRUB, help: "Lunar phase: 0 new, 0.25 first quarter (right-lit, waxing), 0.5 full, 0.75 last quarter (left-lit, waning). The curved terminator is exact. Unbounded because the phase is periodic — keyframe 0 → 3 to run three whole lunations (2.5 renders exactly like 0.5), or go negative to run them backwards." },
  { name: "limbAngle", kind: "angle", display: "degrees", default: 0, help: "Terminator tilt. Added on top of auto-orientation toward the nearest sun; the sole control when no sun is present." },
  { name: "color", kind: "color", default: "#e8e6de", help: "Moon albedo tint (a warm off-white)." },
  // NO BOUNDS on either row (both pairs were ARBITRARY, and both ends are honoured, not
  // swallowed — measured distinct at earthshine 0/0.5/1/4/40 and −1/−5, and at maria
  // 0/0.6/1/3/40 and −1/−5). Above 1 earthshine lifts the dark side toward the lit one
  // and maria crushes the seas to black; below 0 both invert — earthshine eats into the
  // terminator, maria turns the seas into bright highlands.
  { name: "earthshine", kind: "number", default: 0.5, scrub: UNIT_SPAN_SCRUB, help: "Faint glow on the unlit side (sunlight reflected off Earth). 0 = fully black dark side, past 1 the dark side keeps lifting toward full daylight, and a negative value subtracts instead, biting darkness back into the terminator." },
  { name: "maria", kind: "number", default: 0.6, scrub: UNIT_SPAN_SCRUB, help: "Contrast of the dark maria (the 'seas' — procedural patches). Past 1 the seas crush to black for a high-contrast graphic moon; a negative value inverts them into bright highlands." },
  // NO CEILING (the old max:1 was ARBITRARY: 2.5 and 40 render distinct — the disc grows
  // past its box and you fly into the surface, terminator and maria scaling with it).
  // FLOOR NOW 0, and it is TECHNICAL: the SkSL divides the disc coordinates by
  // max(uSize, EPS), so everything at or below EPS = 1e-3 is the SAME (empty) frame —
  // measured, 0, 0.0009, 0.001, −0.5 and −5 are byte-identical.
  { name: "size", kind: "number", default: 0.74, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Moon disc radius as a fraction of the box's shorter half-extent. No cap — past 1 the disc overflows its box and keeps magnifying the surface. 0 (an invisible moon) is the floor because the shader's own divide guard would silently swallow anything under it." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px). Floor 0 is GEOMETRIC — a radius is a length, and render_gpu/ir.js materialFill clamps it there too." },
]);

export const skyMoonPlugin = {
  type: "skyMoon",
  title: "Sky Moon",
  // BOTH a moon LIGHT SOURCE (sky reads it) AND a reader (it reads suns for the limb).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyLight: "moon", skyReader: true },
  defaults: {
    type: "skyMoon", x: 640, y: 120, w: 240, h: 240, z: 5, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("opacity"),
    ...MOON_CUSTOM.defaults,
  },
  inspector: [...bundle("positioning"), ...props("opacity"), ...MOON_CUSTOM.rows],
  /**
   * Pure function. State → ONE materialFill op naming the "skyMoon" material. Reads
   * the sibling suns to point the lit limb at the nearest one (physically, the moon's
   * bright side always faces the sun); the `limbAngle` prop is an additive offset and
   * the sole control when no sun exists.
   */
  emit(s, _sub, world) {
    const scene = s.skyScene ?? EMPTY_SCENE;
    const w = world ?? IDENTITY;
    const limbAngle = s.limbAngle + autoLimbAngle(scene, w, s.w, s.h);
    return [materialFill({
      material: "skyMoon",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2, cornerRadius: s.cornerRadius,
      params: { time: particleTime(), color: s.color, phase: s.phase, limbAngle, earthshine: s.earthshine, maria: s.maria, size: s.size },
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest: bboxHit,
  snapFeatures: centerSnap,
  anchors: standardBBoxAnchors,
};

/**
 * Pure function. The angle (radians, in the moon box's local y-down frame) that
 * points the lit limb at the NEAREST queried sun — the direction from the moon's
 * box centre to that sun, in local frame. Returns 0 when there is no sun (the
 * `limbAngle` prop then stands alone). The shader rotates the phase's base lit
 * direction (+x) by this angle, so the crescent/gibbous opens toward the sun.
 *
 * @param {{suns: object[]}} scene - the sibling query result (world coords)
 * @param {object} world - the moon node's local→world transform
 * @param {number} w - box width
 * @param {number} h - box height
 * @returns {number} radians (0 when no sun)
 *
 * @example autoLimbAngle({suns: []}, {x: 0, y: 0, rotation: 0, scale: 1}, 100, 100) // 0
 * @example // a sun to the local right of the moon centre → angle 0 (lit limb already points +x)
 * @example autoLimbAngle({suns: [{x: 200, y: 50}]}, {x: 0, y: 0, rotation: 0, scale: 1}, 100, 100) // 0
 */
export function autoLimbAngle(scene, world, w, h) {
  const suns = scene.suns ?? [];
  if (suns.length === 0) return 0;
  const inv = T.invert(world);
  const centerLocal = { x: w / 2, y: h / 2 };
  let best = null, bestD2 = Infinity;
  for (const s of suns) {
    const l = T.apply(inv, s.x, s.y);
    const dx = l.x - centerLocal.x, dy = l.y - centerLocal.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = { dx, dy }; }
  }
  return Math.atan2(best.dy, best.dx);
}

// ── skyClouds ─────────────────────────────────────────────────────────────────
const CLOUDS_CUSTOM = customProps([
  // NO FLOOR (the old min:0 was ARBITRARY: with a wide ramp, coverage −0.3, −1 and −4 each
  // render a distinctly thicker overcast — they only looked swallowed at the default
  // softness, where the narrow ramp is already saturated by 0). THE CEILING OF 1 IS
  // TECHNICAL, and it is the (c) case: a cloud needs den > uCoverage, and den is a
  // 5-octave fbm with gain 0.5, so it can never exceed 1/2+1/4+1/8+1/16+1/32 = 0.96875.
  // Nothing above that threshold can ever draw a pixel at ANY softness — measured, 0.9,
  // 0.96875, 1, 2 and (softness 8) 1, 2 are all the same byte-identical EMPTY frame. 1 is
  // simply the round number just above the supremum; the cap discards nothing.
  { name: "coverage", kind: "number", default: 0.46, max: 1, scrub: UNIT_SPAN_SCRUB, help: "Cloud coverage threshold. LOWER = more cloud (fills the box), and there is no floor — go negative for a solid overcast, especially with a wide softness. Higher = sparse wisps; 1 is a REAL ceiling, because the cloud noise itself never exceeds ~0.97, so above that the sky is simply empty." },
  // NO CEILING (the old max:1 was ARBITRARY — 4 renders a distinct, far fainter haze; only
  // past ~20 does the ramp get so wide the clouds fade below one 8-bit alpha step, which is
  // a quantization limit that moves with coverage, not a wall). FLOOR NOW 0, TECHNICAL: the
  // SkSL uses max(uSoftness, EPS) as the ramp width, so 0, 0.0005, 0.0009, 0.001 and −0.5
  // are byte-identical — the guard silently swallows them, and it is what makes 0 (a hard,
  // aliased cloud edge) legal.
  { name: "softness", kind: "number", default: 0.32, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Edge softness of the cloud coverage. Bigger = fluffier, feathered edges, with no cap — a few units in, the ramp is so wide the clouds thin into an invisible haze. 0 gives a hard cut-out edge, and is the floor because the shader's own guard would silently swallow anything under it." },
  // NO FLOOR (the old min:0.2 was ARBITRARY — 0.05, 0 and −2.4 all render distinct fields:
  // 0 freezes the noise into one flat wash and a negative scale mirrors it).
  { name: "cloudScale", kind: "number", default: 2.4, help: "Spatial frequency of the cloud noise — bigger = smaller, more numerous puffs; no bounds. 0 collapses the field to a single flat wash, and a negative scale mirrors the noise." },
  // NO FLOOR (the old min:0 was ARBITRARY — the SkSL offsets the field by uTime·uSpeed·0.03,
  // so a negative speed simply drifts the other way; −1 and −8 render distinct frames).
  { name: "speed", kind: "number", default: 1, help: "Drift speed (animated). 0 = a frozen still; negative drifts the clouds the other way; no cap." },
  { name: "ambient", kind: "color", default: "#8fa6c8", help: "Cool sky ambient lighting the shadowed sides/undersides of the clouds fall back to." },
  { name: "base", kind: "color", default: "#eef1f6", help: "Cloud base tint (lit sides go toward white·this, dense cores darken)." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px). Floor 0 is GEOMETRIC — a radius is a length, and render_gpu/ir.js materialFill clamps it there too." },
]);

export const skyCloudsPlugin = {
  type: "skyClouds",
  title: "Sky Clouds",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyReader: true },
  defaults: {
    type: "skyClouds", x: 120, y: 150, w: 880, h: 380, z: 7, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("animated", "opacity"),
    ...CLOUDS_CUSTOM.defaults,
  },
  inspector: [...bundle("positioning"), ...props("animated", "opacity"), ...CLOUDS_CUSTOM.rows],
  /**
   * Near-pure function (reads the ambient particle clock). State → ONE materialFill
   * op naming the "skyClouds" material. Reads the sibling suns (mapped into this
   * box's local frame) so the clouds are lit from the sun's side and catch its
   * (sunset-warm) colour.
   */
  emit(s, _sub, world) {
    const scene = s.skyScene ?? EMPTY_SCENE;
    const w = world ?? IDENTITY;
    return [materialFill({
      material: "skyClouds",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2, cornerRadius: s.cornerRadius,
      params: {
        time: particleTime(), coverage: s.coverage, softness: s.softness, cloudScale: s.cloudScale,
        speed: s.speed, ambient: s.ambient, base: s.base,
        suns: mappedSuns(scene, w, s.w, s.h),
      },
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest: bboxHit,
  snapFeatures: centerSnap,
  anchors: standardBBoxAnchors,
};

// ── shared bbox helpers (the four members share the plain-box hit/snap) ───────
/** Pure function. Standard bbox hit test (inside the local [0..w]×[0..h] rect). */
function bboxHit(s, lx, ly) { return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h; }
/** Pure function. A single centre snap point. */
function centerSnap(s) { return [{ kind: "point", x: s.w / 2, y: s.h / 2, id: "center" }]; }

/** The `sky*` family, registered together (plugins/index.js). */
export const skyPlugins = [skyPlugin, skySunPlugin, skyMoonPlugin, skyCloudsPlugin];
