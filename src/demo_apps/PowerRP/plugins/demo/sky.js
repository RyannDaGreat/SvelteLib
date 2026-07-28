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
 * ── PRESETS: FOUR FLAT LISTS THAT PAIR BY NAME ───────────────────────────────
 * All four members ship `presets: [{name, description, props}]` — the reusable
 * mechanism plugins/demo/lens_flare.js established, surfaced by the generic Presets
 * pane (web/ToolsPane.svelte): hovering previews with the document UNCHANGED
 * (app.setPreview), a click writes `props` as keyframed values on the current frame
 * in ONE undo unit. See PRESET DOCTRINE below for why they are flat, how they pair
 * across widgets, and where every number comes from.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-free
 * / bare-node-safe at import.
 */

/**
 * ── PRESET DOCTRINE FOR THIS FAMILY (read before adding a preset) ─────────────
 *
 * FLAT LISTS, NOT `presetFamilies`, AND THE KEY SETS SAY WHY. core/registry.js will
 * give a widget several named families and requires them to write DISJOINT key sets
 * so that picking one from each COMPOSES (tests/tool_groups_test.js enforces it over
 * every plugin). Two candidate splits were checked mechanically, not by eye
 * (.frenzy/sky_presets/families_check.js):
 *   BY SCENE ("Golden Hour" / "City Haze" / …) — these are alternative WHOLE
 *     atmospheres over the SAME ten look knobs, so ANY split overlaps on all ten and
 *     the second pick silently erases the first. Mechanically ILLEGAL, the same
 *     verdict the lens flare's twelve looks got.
 *   BY SHADER BRANCH ({turbidity, atmosphere, exposure, zenith} = the day dome /
 *     {starDensity, milkyWay, timeOfDay, night, galaxyTint} = the night dome /
 *     {ground} = the land) — genuinely disjoint, and it PASSES the disjointness
 *     check, so families here are LEGAL where the flare's were not.
 * It is rejected anyway, on the multi-widget cost: a sky look already spans up to
 * FOUR widgets, so splitting one of them into three would make one look SIX picks,
 * and a name-matched pairing (below) is impossible once "Golden Hour" can only live
 * in one of three lists. Flat keeps one pick per widget and one shared vocabulary.
 *
 * EVERY PRESET SETS EVERY LOOK KNOB of its widget — the lens flare's rule, for its
 * reason: app.applyPreset writes exactly the keys in `props` as an OVERLAY, so a knob
 * a preset omits keeps whatever the PREVIOUSLY hovered preset left there, and
 * comparing looks by running down the list is the whole point of the pane.
 *
 * TWO KNOBS ARE DELIBERATELY ABSENT FROM EVERY PRESET, by the lens flare's
 * composition-vs-look test (it excludes lightX/lightY/flareScale for the same
 * reason): `horizon` says how the dome FITS its box — someone who framed an all-sky
 * view (horizon −2, a documented framing) would lose it on every pick — and
 * `cornerRadius` is geometry. Nothing is lost: every look below holds at any horizon,
 * because the dome mapping only compresses.
 *
 * ── THE MULTI-WIDGET ANSWER: PAIR BY NAME, AND SAY SO IN THE DESCRIPTION ──────
 * A preset applies to ONE item, but a sky look is inherently multi-widget: `sky`
 * reads its sibling `sky*` items through core/derive.collectSkyScene, so the sun's
 * colour and intensity ARE part of the atmosphere. The preset mechanism cannot reach
 * siblings and is not extended to (a cross-item preset would have to invent an
 * ownership rule for items it does not own, and would break the ONE-undo-unit
 * contract app.applyPreset holds). So instead:
 *   `sky` and `skySun` SHARE A NAME SET — "Clear Blue Noon", "High Mountain Air",
 *     "Golden Hour", "City Haze", "Dust Haze" appear in BOTH lists, tuned as pairs.
 *     Picking the same name on both is the whole look.
 *   `skyClouds` does NOT need era names: it READS the suns, so its warmth and its lit
 *     side are DERIVED, not authored. Its presets are cloud TYPES, and any type is
 *     correct at any time of day for free.
 *   `skyMoon` does not either: it contributes only a scalar moonlight lift, so its
 *     presets are the lunar PHASE ladder.
 * Every description names its companions and the ONE thing no preset can do — put
 * the sun where the look needs it. THE SUN'S POSITION IS THE TIME OF DAY (the day↔
 * night ramp is `smoothstep(-0.10, 0.12, maxSunUp)` on the highest sun's ELEVATION,
 * not any sky knob), so a preset can supply the atmosphere for golden hour but only
 * the user can drop the sun onto the horizon.
 *
 * ── WHERE THE NUMBERS COME FROM (sourced, not nudged) ─────────────────────────
 * TURBIDITY — Preetham, Shirley & Smits, "A Practical Analytic Model for Daylight",
 *   SIGGRAPH 99, Figure 3 (meteorological range vs turbidity, computed from
 *   McCartney): T = 1 pure air, ~2 very clear, ~4 clear, ~8 light haze, ~16 haze,
 *   ~32 thin fog. The paper's own figures use T = 2 for a clear morning/evening,
 *   T = 6 "a half hour before sunset", and T = 10 for overcast, and those three
 *   values are used verbatim below. DEVIATION, stated: Preetham's T is a RATIO that
 *   includes the molecular atmosphere (so T = 1 is its floor), while this shader's
 *   knob SCALES the Mie term alone (betaM = BETA_M · atmosphere · T/3), so T = 0 here
 *   is pure Rayleigh — one step past the paper's floor. The named conditions still
 *   land where the paper puts them, which is what the knob's own help promises.
 * ATMOSPHERE — the air column, so the US Standard Atmosphere pressure ratio:
 *   701.1 hPa / 1013.25 hPa = 0.69 at 3000 m, the one non-unit value used below.
 * STAR DENSITY — the knob is a GRID RESOLUTION and the star count goes as its
 *   SQUARE (the shader lays 2·d² cells over the visible hemisphere and
 *   STAR_THRESHOLD leaves ~14% of them occupied), while the number of stars brighter
 *   than magnitude m goes as 10^(0.4m). So density ∝ 10^(0.2m), and anchoring the
 *   EXISTING default 46 to a suburban Bortle 5 sky (naked-eye limiting magnitude
 *   5.6–6.0, midpoint 5.8) fixes the whole ladder:
 *       density(m) = 46 · 10^(0.2·(m − 5.8))
 *   Bortle 8 city (NELM 4.3) → 23; Bortle 5 suburban (5.8) → 46; Bortle 3 rural
 *   (6.8) → 73; Bortle 1 excellent dark site (7.8) → 116; nautical twilight
 *   (NELM ≈ 3.75) → 18. Measured on 640×360 renders, bright local maxima came out
 *   34 / 140 / 233 / 337 for 23 / 46 / 73 / 116 — the d² law at the sparse end
 *   (46²/23² = 4.0 vs the counted 4.1) and an undercount at the dense end, where
 *   cells fall below one pixel and neighbouring stars merge.
 * MILKY WAY — the Bortle scale's own text: "nearly or totally invisible" from class
 *   7 up, so the city presets carry 0; visible and structured at class 1–3.
 * SUN COLOUR — colour temperature through the HOUSE Kelvin fit (the KELVIN_TABLE in
 *   render_gpu/skia/lens_flare_shader.js, so a sun and a flare of the same
 *   temperature agree). Evaluated at author time and written as hex here — NO import,
 *   because no plugin may depend on another plugin's shader: 5778 K #fff6ed (the
 *   solar effective temperature), 5500 K #fff2e6 (midday), 5000 K #ffebd4, 4000 K
 *   #ffd8ad, 2600 K #ffad6a (deep golden hour), 2000 K #ff9447 (the horizon).
 * EXPOSURE — chosen by MEASUREMENT, not taste: the day dome must not CLIP, because a
 *   clipped patch is where the sun disc lives and a sun cannot add light to white.
 *   The pairs below were swept (.frenzy/sky_presets/domains2.js) and every day preset
 *   sits at 0.00% clipped pixels. This is also why the widget DEFAULTS look flat: at
 *   the shipped exposure 1.1 with sun intensity 3, 4.10% of the frame is clipped,
 *   all of it around the sun.
 * MOON — the perigee/apogee apparent-diameter ratio 33.5′/29.4′ = 1.139 sets the
 *   supermoon's size against an apogee moon; the maria are ~half the highlands'
 *   albedo (0.07 vs 0.11–0.13), which is what `maria` near 1 renders; earthshine is
 *   the Da Vinci glow, and it is authored HIGH only on the thin crescent, which is
 *   the only phase it is ever seen on.
 *
 * DROPPED AFTER RENDERING (the mandelbrot/lens-flare bar — a preset that does not
 * read as its name is not shipped):
 *   "Dark-Sky Milky Way" → renamed "Dark-Sky Star Field" and its band pulled back to
 *     0.6. Swept over ten timeOfDay rotations, the band never reads as a band in a
 *     16:9 box: the great-circle mask (galAxis at σ = 0.24 in sin-galactic-latitude)
 *     cuts the 94.5°-wide window as a large hard-edged dome that reads as a mountain
 *     silhouette or a cloud, and there is a visible seam at the atan branch cut.
 *     That is a shader limitation, not a preset one; the star field is what this
 *     widget genuinely does well at a dark site.
 *   "New Moon" → dropped. At any earthshine that makes it visible at all the disc is
 *     a flat olive-grey ball, and at any lower value it is an invisible hole in the
 *     star field. The earthshine look belongs to the crescent, where it is real.
 *   "Blue Hour" → renamed "Twilight Blue". The sky's night branch is a FLAT colour
 *     with no horizon gradient, so it cannot deliver blue hour's bright horizon; what
 *     it does deliver is a deep even blue with the brightest stars out, and that is
 *     what the name now says.
 */

import * as T from "../../core/transform.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, bundleNestedDefaults, customProps, defaults, props } from "../../core/properties.js";
import { materialFill } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
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
/**
 * The SUN DISC's RADIANCE span: 0 to where its tone map freezes. This one is NOT a
 * remembered range — the row never had bounds — it is MEASURED, and the measurement
 * is written out on the `intensity` row that declares it.
 */
const RADIANCE_SPAN_SCRUB = 8 / RANGE_DRAG_PX;

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
  // SCRUB, measured against `exposure` below — the same knob CLASS in the same
  // widget: a half-open unit-nominal multiplier with a saturation point far above 1.
  // `exposure` scrubs at 0.011/px, and it gets that for FREE only because its default
  // happens to be written 1.1: numberStep.js infers |default|/RANGE_DRAG_PX from a
  // fractional default. `atmosphere`'s default is the integer 1, which is no proof of
  // fractionality, so inference correctly declines and the row fell back to 1 unit/px
  // — a 1px twitch DOUBLED the air. It is fractional in use (the shader takes it as a
  // plain linear scale, betaR = BETA_R * uAtmosphere, and its own header notes 0.001
  // already renders the airless frame), so it declares the shared constant, which
  // matches its twin's 0.011 to within 10%.
  { name: "atmosphere", kind: "number", default: 1, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Overall atmosphere thickness — scales all scattering. Higher = denser/brighter sky (past ~100 the dome saturates into its own haze); 0 is the airless limit, a black sky with only the ground showing. 0 is a REAL floor: this is the divisor of the scattering integral." },
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

/**
 * THE `sky` ATMOSPHERES. Ten look knobs each (turbidity, atmosphere, exposure,
 * starDensity, milkyWay, timeOfDay, zenith, ground, night, galaxyTint); `horizon` and
 * `cornerRadius` are deliberately absent — see PRESET DOCTRINE at the head of this
 * file for both rules, every source, and the three candidates that were dropped.
 *
 * ORDERED BY AEROSOL LOAD, then by darkness: the five DAY atmospheres run up
 * Preetham's turbidity ladder (1 pure air → 2 very clear → 6 → 10 haze → 32 thin
 * fog), then the three NIGHT skies run down the Bortle scale (twilight → class 8 city
 * → class 1 dark site). The order is content: reading down the first five IS the
 * aerosol progression, which is why they are not sorted by time of day.
 *
 * EVERY DAY PRESET ALSO NAMES A NIGHT, and every night preset a day. Nothing here is
 * inert filler: the day↔night ramp is driven by the SUN's elevation, so keyframing a
 * sun down through the horizon crosses from one branch to the other inside a single
 * preset — the night a "Golden Hour" sky falls into is the one this table chose.
 */
const SKY_PRESETS = [
  {
    name: "High Mountain Air",
    description: "A 3000 m sky: pure-air turbidity with a third of the air column removed, so the deepest, most saturated blue this model makes — and, at night, a Bortle 1 dark-site star field. Pair with the Sky Sun 'High Mountain Air' preset and put the sun high.",
    props: {
      turbidity: 1, atmosphere: 0.69, exposure: 2.8, zenith: "#ffffff",
      starDensity: 116, milkyWay: 0.6, timeOfDay: 0.95, night: "#02040a", galaxyTint: "#46567c",
      ground: "#232a2e",
    },
  },
  {
    name: "Clear Blue Noon",
    description: "Preetham's 'very clear' sky at sea level, exposed so nothing clips: a clean blue zenith fading to a pale horizon. Pair with the Sky Sun 'Clear Blue Noon' preset, put the sun high, and add Sky Clouds 'Fair-Weather Cumulus'.",
    props: {
      turbidity: 2, atmosphere: 1, exposure: 2.0, zenith: "#ffffff",
      starDensity: 46, milkyWay: 0.5, timeOfDay: 0.7, night: "#080e1c", galaxyTint: "#46567c",
      ground: "#1c2a22",
    },
  },
  {
    name: "Golden Hour",
    description: "The atmosphere of the paper's own 'half hour before sunset' figure — turbidity 6, so the long horizon airmass strips the blue out of the sunlight and spreads amber across the whole dome. Pair with the Sky Sun 'Golden Hour' preset and DRAG THE SUN DOWN onto the horizon line; that placement is the time of day and no preset can set it.",
    props: {
      turbidity: 6, atmosphere: 1, exposure: 1.2, zenith: "#ffffff",
      starDensity: 46, milkyWay: 0.4, timeOfDay: 0.7, night: "#0e1526", galaxyTint: "#46567c",
      ground: "#241a10",
    },
  },
  {
    name: "City Haze",
    description: "Urban aerosol at the turbidity the paper uses for overcast: the blue is scattered away into a flat grey-white wash with a broad soft sun. Its night is a sodium-lit Bortle 8 sky. Pair with the Sky Sun 'City Haze' preset and Sky Clouds 'Overcast Stratus' for a real cloud deck — this dome has no clouds of its own.",
    props: {
      turbidity: 10, atmosphere: 1, exposure: 1.2, zenith: "#ffffff",
      starDensity: 23, milkyWay: 0, timeOfDay: 0.7, night: "#2a2114", galaxyTint: "#46567c",
      ground: "#1a1a18",
    },
  },
  {
    name: "Dust Haze",
    description: "The thin-fog end of the turbidity ladder — the aerosol load of a dust storm. Mie scattering dominates completely, so the sky is one warm orange field and the sun is a soft blown disc in it. Pair with the Sky Sun 'Dust Haze' preset and keep the sun low.",
    props: {
      turbidity: 32, atmosphere: 1, exposure: 1.1, zenith: "#ffffff",
      starDensity: 23, milkyWay: 0, timeOfDay: 0.7, night: "#1c1610", galaxyTint: "#46567c",
      ground: "#2a1e12",
    },
  },
  {
    name: "Twilight Blue",
    description: "Nautical twilight: an even deep blue with only the brightest stars out (naked-eye limit ~3.75). Use it with NO sun above the horizon — the sky's night branch is a flat colour, so this is the blue, not a bright horizon glow. Its day half is a clear sea-level sky, so keyframing a sun up through the horizon lands on one.",
    props: {
      turbidity: 3, atmosphere: 1, exposure: 1.4, zenith: "#ffffff",
      starDensity: 18, milkyWay: 0, timeOfDay: 0.7, night: "#1d3050", galaxyTint: "#46567c",
      ground: "#101826",
    },
  },
  {
    name: "Inner-City Night",
    description: "A Bortle 8 city sky: sodium skyglow, a quarter of the suburban star count, and no Milky Way at all — the scale's own text calls it invisible from class 7 up. Add a Sky Moon preset if you want anything else in it.",
    props: {
      turbidity: 8, atmosphere: 1, exposure: 1.2, zenith: "#ffffff",
      starDensity: 23, milkyWay: 0, timeOfDay: 0.7, night: "#2a2114", galaxyTint: "#46567c",
      ground: "#14100c",
    },
  },
  {
    name: "Dark-Sky Star Field",
    description: "A Bortle 1 site: two and a half times the suburban star count on a near-black sky, with the galaxy pulled back to a faint glow (the band does not read as a band in a wide box — see this file's dropped-presets note). Pair with the Sky Moon 'Earthshine Crescent' preset; a full moon washes the faint stars out.",
    props: {
      turbidity: 1, atmosphere: 1, exposure: 2.4, zenith: "#ffffff",
      starDensity: 116, milkyWay: 0.6, timeOfDay: 0.95, night: "#02040a", galaxyTint: "#46567c",
      ground: "#05070c",
    },
  },
];

export const skyPlugin = {
  type: "sky",
  title: "Sky",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyReader: true },
  presets: SKY_PRESETS,
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
  // SCRUB, and this row is why the constant above exists. It was one of the rows left
  // scrubbing at 1 unit/px because nothing in it proved a span: fully open (a negative
  // radiance is a documented look), an INTEGER default, and no fractional twin — so
  // numberStep.js correctly declined to infer, and one drag-pixel TRIPLED the sun at
  // the default. The span is now MEASURED rather than guessed, and the measurement
  // had to choose between the row's TWO consumers:
  //   its OWN DISC tone-maps as 1 − exp(−colour·intensity), so it freezes: the centre
  //     pixel of a default-coloured disc goes 226 → 244 → 251 → 254 → 255 over
  //     intensity 1 → 2 → 3 → 4 → 6 and is BYTE-IDENTICAL from 7.5 to 40. The
  //     analytic freeze is intensity = ln(510)/0.839 = 7.43 for this colour's dimmest
  //     channel; measured 7.5.
  //   the SKY's scattering weight keeps responding much further — the dome is
  //     byte-identical only at 80 and above, and its mean luma stops moving past 30.
  // The DISC's span wins because it is the consumer that always exists: the sky's is
  // conditional on a sibling `sky` widget being present, and a scrub must feel the
  // same for a sun standing alone. 8 is the round number just above the measured
  // freeze, so ONE drag run crosses the entire range in which the disc changes at all
  // and the sky's remaining 8..80 is five more runs away.
  { name: "intensity", kind: "number", default: 3, scrub: RADIANCE_SPAN_SCRUB, help: "Sun disc radiance (how bright/blown-out the core reads). Also the weight the sky/clouds give this sun. Past ~7.5 the disc itself is already pure white and stops changing, though the sky's own glow keeps growing to ~80. No bounds — a negative radiance blacks the disc out behind its own corona, i.e. a total eclipse." },
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
  // NO `cornerRadius` ROW, unlike `sky`/`skyClouds`. This widget's silhouette is its own
  // DISC, not its region, so there is no corner to round: the row shipped for two
  // releases against a uniform the shader never read (measured byte-identical at 0 vs
  // 140, every disc size), i.e. a knob that promised and did nothing. Making it real by
  // clipping to an sdRoundRect was measured and rejected — it also clips the disc at the
  // box and so retires `size`'s documented spill-out. See sky_sun_shader.js's header.
]);

/**
 * THE `skySun` LOOKS. Six knobs each — colour, radiance, disc size, aureole strength
 * and aureole tightness, plus `blendMode`, which is here for the same reason the lens
 * flare puts it in all twelve of its maps: it is the one shared key that decides
 * whether this widget adds light or occludes it, so a preset that left it out could
 * inherit a stale "normal" and bring the dark halo back.
 *
 * THE FIRST FIVE NAMES ARE THE `sky` PRESETS' NAMES, tuned as PAIRS — the sun's
 * colour and intensity feed the dome through core/derive.collectSkyScene, so a sky
 * atmosphere and its sun are one look wearing two names. Every intensity below was
 * chosen against its partner's exposure so the day dome clips NO pixels (measured),
 * which is what lets the disc read at all: a sun cannot add light to a white sky.
 * The AUREOLE follows the aerosol load — the solar aureole is a couple of degrees
 * wide in clear mountain air and tens of degrees in haze — so `glowRadius` climbs
 * with the partner's turbidity, from 0.07 to 0.60.
 *
 * COLOURS are the house Kelvin fit's output for the sun's colour temperature at that
 * airmass (see PRESET DOCTRINE for the numbers and why they are hex here).
 */
const SUN_PRESETS = [
  {
    name: "High Mountain Air",
    description: "The sun at its own effective temperature through the thinnest air: a small hard white disc with the tightest aureole in the set, because there is almost no aerosol to forward-scatter. Pair with the Sky 'High Mountain Air' preset and put the sun high.",
    props: { blendMode: "screen", color: "#fff6ed", intensity: 0.9, size: 0.14, glow: 0.5, glowRadius: 0.07 },
  },
  {
    name: "Clear Blue Noon",
    description: "Midday sun at 5500 K over a clear sea-level sky: a small white disc and a compact aureole. Pair with the Sky 'Clear Blue Noon' preset and put the sun high.",
    props: { blendMode: "screen", color: "#fff2e6", intensity: 1.0, size: 0.16, glow: 0.7, glowRadius: 0.10 },
  },
  {
    name: "Golden Hour",
    description: "A 2600 K sun — the colour a few degrees of elevation leaves after the airmass has stripped the blue — with a broad warm aureole. Pair with the Sky 'Golden Hour' preset and drag this sun down onto the horizon line.",
    props: { blendMode: "screen", color: "#ffad6a", intensity: 1.6, size: 0.24, glow: 1.1, glowRadius: 0.22 },
  },
  {
    name: "Horizon Sunset",
    description: "The sun ON the horizon at 2000 K: the deepest orange of the set, on a small disc drowning in its own aureole. Pair with the Sky 'Golden Hour' or 'Dust Haze' preset and sit this sun right on the horizon line.",
    props: { blendMode: "screen", color: "#ff9447", intensity: 1.6, size: 0.18, glow: 1.2, glowRadius: 0.30 },
  },
  {
    name: "City Haze",
    description: "A hazy urban sun: near-neutral 5000 K, but the disc is twice the clear-air size and the aureole four times as wide — the aerosol is doing the spreading, not the sun. Pair with the Sky 'City Haze' preset.",
    props: { blendMode: "screen", color: "#ffebd4", intensity: 1.1, size: 0.30, glow: 1.5, glowRadius: 0.45 },
  },
  {
    name: "Dust Haze",
    description: "A sun seen through a dust load: the aureole is so wide it has swallowed the disc, which is what a sun in a dust storm actually looks like. Pair with the Sky 'Dust Haze' preset and keep the sun low.",
    props: { blendMode: "screen", color: "#ffd8ad", intensity: 0.9, size: 0.28, glow: 1.9, glowRadius: 0.60 },
  },
  {
    name: "Total Eclipse",
    description: "Totality: a NEGATIVE radiance tone-maps the disc to black while the aureole still burns around it, so you get the corona with the photosphere occulted. It also drives the sky's own scattering negative, which darkens the whole dome by itself — so this one look needs no companion sky preset.",
    // THE ONE PRESET THAT LEAVES "screen", and the reason is the same physics that put
    // every other one on it: this sun is not EMITTING at its disc, something is
    // BLOCKING it, and an occluder wants source-over. Rendered both ways — over the
    // black sky the preset makes for itself they are indistinguishable, but over any
    // other backdrop "screen" turns the disc into a TRANSPARENT hole (premultiplied
    // zero adds nothing) while "normal" keeps it black, which is the thing an eclipse
    // is. Same shape of exception as lens_flare's "Stage Followspot", the one look in
    // that set that swaps the blend its eleven siblings share.
    props: { blendMode: "normal", color: "#fff6ed", intensity: -3, size: 0.20, glow: 1.6, glowRadius: 0.50 },
  },
];

export const skySunPlugin = {
  type: "skySun",
  title: "Sky Sun",
  // skyLight:"sun" marks it a LIGHT SOURCE the sky/clouds read (core/derive.collectSkyScene).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyLight: "sun" },
  presets: SUN_PRESETS,
  defaults: {
    type: "skySun", x: 200, y: 140, w: 200, h: 200, z: 6, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("opacity"),
    // THE EFFECTS BUNDLE, COMPOSED HERE rather than injected, for the one reason
    // core/registry.js grants that right: this widget DELIBERATELY DEFAULTS ONE
    // EFFECT ON, and tests/universal_effects_test.js (3) requires every INJECTED
    // plugin's effects to be OFF (that is what keeps injection byte-identical). Its
    // own comment names the precedent — "a SELF-composing plugin may deliberately
    // default one ON for its own look (demo_lens_flare ships blendMode 'screen' — a
    // flare is additive by nature)". So this file follows plugins/demo/lens_flare.js
    // exactly: bundleNestedDefaults here, bundle("effects") in the inspector,
    // applyEffects inside emit(), cullMargin below. The other three sky members stay
    // INJECTED (they change nothing, so they must not hand-copy four lines).
    ...bundleNestedDefaults("effects"),
    // THE ONE MEMBER OF THIS FAMILY THAT ADDS LIGHT, so the ONE that leaves "normal".
    // This is the user's reported "why does the sun have a dark shadow behind it?".
    //
    // WHY: render_gpu/skia/sky_sun_shader.js's ALPHA IS AN EMISSION AMOUNT, not a
    // coverage mask — a = disc + glow·uGlow — and its colour is the tone-mapped
    // radiance of that SAME glow term, so out in the aureole the premultiplied
    // output is ~a² while the source-over composite still removes (1 − a) of the sky
    // behind it. The aureole therefore SUBTRACTS light wherever the sky is brighter
    // than a: a grey ring around the disc. MEASURED at these very defaults, and
    // tests/sky_family_test.js (7) reproduces the measurement: the annulus 0.25–0.55
    // of the sun's half-box comes out ~46 luma DARKER under source-over than the same
    // sky with the sun's disc withheld, and no setting of exposure, turbidity or
    // intensity makes that band non-negative — the ring is structural, not tuning.
    // Under "screen" it is never darker than the sky at all, and the sun ADDS its
    // aureole, which is what a sun does.
    //
    // Exactly the reasoning and exactly the default lens_flare carries, for the same
    // physical reason: light added to a scene composites additively. Its shader
    // states the shared convention outright — "alpha = the flare's own intensity so
    // it composites additively under blend:'screen'".
    //
    // NOT APPLIED TO THE OTHER THREE, and each was rendered rather than assumed.
    // `sky` (a = box coverage), `skyClouds` (a = cloud coverage) and `skyMoon`
    // (a = disc) all carry a COVERAGE alpha with a colour that does NOT scale with
    // it, so source-over already lerps the backdrop toward a bright albedo and
    // nothing darkens. They are lit MATTER, and for the moon "screen" is actively
    // WRONG: it makes the unlit limb TRANSPARENT — measured, the darkest pixel
    // inside a gibbous disc went 10.9 → 78.0 luma and the star field showed THROUGH
    // the rock.
    blendMode: "screen",
    ...SUN_CUSTOM.defaults,
  },
  inspector: [...bundle("positioning"), ...props("opacity"), ...SUN_CUSTOM.rows, ...bundle("effects")],
  /**
   * Pure function. State → ONE materialFill op naming the "skySun" material,
   * WRAPPED in the effects bundle (render_gpu/effects.js applyEffects) so the
   * default blendMode "screen" composites the sun's light additively over the sky.
   * `world` (emit's 3rd arg) is what applyEffects needs for the substrate.
   */
  emit(s, _sub, world) {
    const op = materialFill({
      material: "skySun",
      // No cornerRadius: the skySun material has no such uniform and this widget has no
      // such property (see the custom-props note above).
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      params: { time: particleTime(), color: s.color, intensity: s.intensity, size: s.size, glow: s.glow, glowRadius: s.glowRadius },
      opacity: s.opacity ?? 1,
    });
    return applyEffects([op], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  cullMargin: effectsCullMargin,
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
  // NO `cornerRadius` ROW — the skySun reasoning verbatim (a disc has no region corner;
  // the uniform was declared and never read; the sdRoundRect fix would clip the
  // documented `size` overflow). sky_sun_shader.js's header carries the measurements.
]);

/**
 * THE `skyMoon` PHASE LADDER. Six knobs each (phase, limbAngle, colour, earthshine,
 * maria, size).
 *
 * NOT ERA NAMES, unlike `sky`/`skySun`, and that is an architectural fact rather than
 * a shortcut: the moon does not participate in the atmosphere's coupling. A sun's
 * colour and intensity are READ by the dome and the clouds, so a sun look and a sky
 * look must agree; a moon contributes only a scalar moonlight lift to the night
 * ambient (MOONLIGHT_GAIN × its illuminated fraction), so any phase is correct in any
 * of the night skies. The one pairing that matters is brightness, and each description
 * says it: a full moon washes a dark-sky star field out, a crescent does not.
 *
 * ORDERED AS THE MONTH RUNS — crescent → first quarter → gibbous → full → last
 * quarter — then the three FULL-MOON VARIANTS that are about something other than
 * phase (size at perigee, colour near the horizon, colour in eclipse).
 *
 * `earthshine` is authored HIGH only on the crescent, because that is the only phase
 * the Da Vinci glow is ever seen on, and it falls to 0 by full (there is no dark side
 * left to glow). `maria` runs the other way: it is contrast on the seas, whose albedo
 * is about half the highlands', so the fuller the phase the more of that contrast is
 * visible and worth having. `limbAngle` is 0 throughout ON PURPOSE — it is an ADDITIVE
 * offset on top of the automatic orientation toward the nearest sun (autoLimbAngle
 * below), so 0 means "let the physics point the lit limb" and a preset that carried a
 * tilt would fight it.
 */
const MOON_PRESETS = [
  {
    name: "Earthshine Crescent",
    description: "A thin waxing crescent with the dark side lifted by earthshine — 'the old moon in the new moon's arms', the glow Leonardo explained as sunlight bounced off the Earth. The only phase earthshine is really seen on, and the only one faint enough to leave a dark-sky star field intact.",
    props: { phase: 0.10, limbAngle: 0, color: "#e8e6de", earthshine: 1.2, maria: 0.5, size: 0.74 },
  },
  {
    name: "First Quarter",
    description: "Half lit on the right, waxing: the terminator is a straight line down the disc because the elongation is exactly 90°. A trace of earthshine, and the maria on the lit half already reading.",
    props: { phase: 0.25, limbAngle: 0, color: "#e8e6de", earthshine: 0.35, maria: 0.7, size: 0.74 },
  },
  {
    name: "Waxing Gibbous",
    description: "Past half and filling: the terminator has curved into the ellipse the shader computes exactly, and most of the near side's maria are in sunlight.",
    props: { phase: 0.40, limbAngle: 0, color: "#e8e6de", earthshine: 0.2, maria: 0.8, size: 0.74 },
  },
  {
    name: "Full Moon",
    description: "Fully lit at the mean apparent diameter, with the maria at their strongest — the 'man in the moon'. Bright enough that the sky's moonlight lift visibly blues the night, so expect the faintest stars to go: pair it with the Sky 'Inner-City Night' or 'Twilight Blue' rather than a dark-sky field.",
    props: { phase: 0.5, limbAngle: 0, color: "#eceae2", earthshine: 0, maria: 0.9, size: 0.745 },
  },
  {
    name: "Last Quarter",
    description: "Half lit on the LEFT, waning — the mirror of first quarter, and the pair that shows the terminator is genuinely handed rather than a flipped texture.",
    props: { phase: 0.75, limbAngle: 0, color: "#e8e6de", earthshine: 0.35, maria: 0.7, size: 0.74 },
  },
  {
    name: "Supermoon at Perigee",
    description: "A full moon at perigee: 33.5 arcminutes across against an apogee moon's 29.4, so this disc is 14% wider than the smallest full moon of the year — the whole of what a supermoon is.",
    props: { phase: 0.5, limbAngle: 0, color: "#f2efe4", earthshine: 0, maria: 0.9, size: 0.797 },
  },
  {
    name: "Harvest Moon",
    description: "A full moon low over the horizon, reddened by the same long airmass that reddens a sunset — the amber that makes a rising moon look enormous. Sit it just above the horizon line.",
    props: { phase: 0.5, limbAngle: 0, color: "#e8a25e", earthshine: 0, maria: 0.8, size: 0.78 },
  },
  {
    name: "Blood Moon",
    description: "A total lunar eclipse: inside the Earth's umbra the only light reaching the surface has been Rayleigh-refracted through the whole atmosphere, so the disc goes deep copper and the maria contrast nearly vanishes with it.",
    props: { phase: 0.5, limbAngle: 0, color: "#a8442a", earthshine: 0.1, maria: 0.35, size: 0.745 },
  },
];

export const skyMoonPlugin = {
  type: "skyMoon",
  title: "Sky Moon",
  // BOTH a moon LIGHT SOURCE (sky reads it) AND a reader (it reads suns for the limb).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyLight: "moon", skyReader: true },
  presets: MOON_PRESETS,
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
      // No cornerRadius: the skyMoon material has no such uniform and this widget has no
      // such property (see the custom-props note above).
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
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
  // SCRUB: a unit-nominal RATE multiplier — 1 = the authored drift, 0 = frozen. Fully
  // open, and its default is the integer 1, so nothing in the row proved it fractional
  // and it fell back to 1 unit/px: dragging one pixel DOUBLED the speed, and 1.5x was
  // unreachable by dragging at all. Every other row of this widget sits at 0.01/px
  // (coverage by its 0..1 range, softness by declaring this same constant), so the
  // shared unit-span constant both fixes the row and matches its siblings.
  { name: "speed", kind: "number", default: 1, scrub: UNIT_SPAN_SCRUB, help: "Drift speed (animated). 0 = a frozen still; negative drifts the clouds the other way; no cap." },
  { name: "ambient", kind: "color", default: "#8fa6c8", help: "Cool sky ambient lighting the shadowed sides/undersides of the clouds fall back to." },
  { name: "base", kind: "color", default: "#eef1f6", help: "Cloud base tint (lit sides go toward white·this, dense cores darken)." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px). Floor 0 is GEOMETRIC — a radius is a length, and render_gpu/ir.js materialFill clamps it there too." },
]);

/**
 * THE `skyClouds` TYPES. Six knobs each (coverage, softness, cloudScale, speed,
 * ambient, base).
 *
 * CLOUD TYPES, NOT ERA NAMES, and this is the cleanest case in the family for it: the
 * clouds READ the suns, so their warmth, the side they are lit from, and the sunset
 * red on their edges are all DERIVED at render time from whatever sun is in the scene
 * (see emit below, and the shader's `low` term, which warm-shifts the light as the sun
 * gets low). A "Golden Hour Cumulus" preset would be a duplicate of "Fair-Weather
 * Cumulus" with nothing changed, because the golden hour comes free. So any type below
 * is correct with any Sky/Sky Sun pair.
 *
 * THE FIRST FIVE ARE ORDERED BY CLOUD COVER, in oktas — the WMO's own unit, eighths of
 * the sky. Note that `coverage` is a THRESHOLD on the noise and therefore runs
 * BACKWARDS: lower admits more cloud. So those five descend 0.62 → 0.06 as the cover
 * climbs 1 okta → 8, and the sixth sits outside that order deliberately: a
 * cumulonimbus is about DEPTH, not cover.
 *
 * `cloudScale` is the second axis and it follows cloud HEIGHT the way a real sky does:
 * high cirrus are fine-grained streaks at scale 6, mid-level altocumulus a mackerel
 * pattern at 4.2, cumulus discrete puffs at 2.6, and a stratus deck one near-uniform
 * sheet at 1.4. `softness` is the edge: a cumulus has a hard convective boundary, a
 * cirrus is all feather, a stratus is featureless.
 *
 * THE BASE TINTS ARE COOL ON PURPOSE, and it is a correction, not taste. The shader
 * builds its albedo as mix(float3(1.0, 0.96, 0.9)·uBase, uBase·0.35, den), so a WHITE
 * base comes out visibly PINK-BROWN at every thin edge — rendered, a "fair-weather"
 * deck read as dust. A base a few percent blue cancels that factor and the cloud reads
 * neutral white, which is what the name promises.
 */
const CLOUD_PRESETS = [
  {
    name: "Cirrus Wisps",
    description: "One or two oktas of high ice cloud: fine feathered streaks with nothing solid in them, at the finest grain in the set. Barely dims the sky, and picks up sunset colour long before anything lower does.",
    props: { coverage: 0.62, softness: 0.50, cloudScale: 6.0, speed: 0.4, ambient: "#dfe8f6", base: "#eef3ff" },
  },
  {
    name: "Fair-Weather Cumulus",
    description: "The classic three-okta summer sky: discrete puffs with hard convective edges, bright tops and shaded bases. The default pairing for Sky 'Clear Blue Noon'.",
    props: { coverage: 0.52, softness: 0.18, cloudScale: 2.6, speed: 1.0, ambient: "#e4ecf8", base: "#e6eeff" },
  },
  {
    name: "Scattered Altocumulus",
    description: "Four oktas of mid-level cloud in the regular mackerel pattern that name describes — smaller, flatter and more evenly spaced than cumulus, with grey shaded undersides.",
    props: { coverage: 0.46, softness: 0.24, cloudScale: 4.2, speed: 0.8, ambient: "#d2dff1", base: "#eaf0ff" },
  },
  {
    name: "Broken Stratocumulus",
    description: "Five to seven oktas: a lumpy layer with holes in it, moving faster and greyer than fair-weather cumulus — the most common sky over an ocean.",
    props: { coverage: 0.36, softness: 0.30, cloudScale: 2.0, speed: 1.2, ambient: "#b4c4dc", base: "#e2e8f2" },
  },
  {
    name: "Overcast Stratus",
    description: "Eight oktas — total cover: a featureless grey sheet at the coarsest grain and the softest edge, so no individual cloud is visible at all. This is the widget that makes an overcast day; the sky dome alone cannot. Pair with Sky 'City Haze'.",
    props: { coverage: 0.06, softness: 0.90, cloudScale: 1.4, speed: 0.5, ambient: "#96a2b0", base: "#d5dae1" },
  },
  {
    name: "Storm Anvil",
    description: "Deep convective cloud: hard-edged, fast, and dark enough that the dense cores crush toward black while the sunlit shoulders stay bright — the contrast a cumulonimbus gets from being kilometres thick. It keeps holes in it on purpose; a solid deck at this hardness shows the widget's own box edge.",
    props: { coverage: 0.34, softness: 0.26, cloudScale: 3.4, speed: 1.6, ambient: "#4b5666", base: "#96a0ad" },
  },
];

export const skyCloudsPlugin = {
  type: "skyClouds",
  title: "Sky Clouds",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, skyReader: true },
  presets: CLOUD_PRESETS,
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
