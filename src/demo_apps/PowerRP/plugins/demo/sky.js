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
import { bundle, customProps, defaults, props } from "../../core/properties.js";
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

// ── sky ───────────────────────────────────────────────────────────────────────
const SKY_CUSTOM = customProps([
  { name: "horizon", kind: "number", default: -0.15, min: -1, max: 1, help: "Horizon height in the box frame (−1 bottom … +1 top). Below it is ground, above it is sky. Lower = more sky." },
  { name: "turbidity", kind: "number", default: 3, min: 1, max: 12, help: "Atmospheric haze: scales Mie scattering. ~2 = very clear (deep blue), ~8 = hazy/washed-out with a broader sun glow." },
  { name: "atmosphere", kind: "number", default: 1, min: 0.1, help: "Overall atmosphere thickness — scales all scattering. Higher = denser/brighter sky." },
  { name: "exposure", kind: "number", default: 1.1, min: 0.05, help: "HDR tone-map exposure. Higher = brighter overall." },
  { name: "starDensity", kind: "number", default: 46, min: 1, help: "Star-field grid resolution — more = more stars (visible at night)." },
  { name: "milkyWay", kind: "number", default: 1, min: 0, max: 2, help: "Milky-Way band strength (0 = off). Only visible at night." },
  { name: "timeOfDay", kind: "number", default: 0.2, min: 0, max: 1, help: "Rotates the star sphere + Milky Way (0..1 = one full turn). The day/night look itself is driven by the SUN widgets' elevation, not this." },
  { name: "zenith", kind: "color", default: "#ffffff", help: "Zenith colour multiplier applied to the scattered day sky. White = pure physics; tint to warm/cool the whole dome." },
  { name: "ground", kind: "color", default: "#0d1017", help: "Ground/foreground colour below the horizon (darkens at night)." },
  { name: "night", kind: "color", default: "#04060e", help: "Deep night-sky colour the dome fades to once every sun is below the horizon." },
  { name: "galaxyTint", kind: "color", default: "#46567c", help: "Milky-Way glow tint (a cool dusty blue; the bright core adds warm highlights)." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the sky region (world px)." },
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
  { name: "intensity", kind: "number", default: 3, min: 0, help: "Sun disc radiance (how bright/blown-out the core reads). Also the weight the sky/clouds give this sun." },
  { name: "size", kind: "number", default: 0.26, min: 0.01, max: 1, help: "Sun disc radius as a fraction of the box's shorter half-extent." },
  { name: "glow", kind: "number", default: 0.9, min: 0, help: "Aureole strength — the Mie forward-scatter halo bleeding out around the disc." },
  { name: "glowRadius", kind: "number", default: 0.18, min: 0.02, help: "Tight-aureole falloff (fraction of the shorter half-extent) hugging the disc. The broad halo has compact support to the box edge; this controls the bright inner ring." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px)." },
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
  { name: "phase", kind: "number", default: 0.72, min: 0, max: 1, help: "Lunar phase: 0 new, 0.25 first quarter (right-lit, waxing), 0.5 full, 0.75 last quarter (left-lit, waning). The curved terminator is exact." },
  { name: "limbAngle", kind: "number", default: 0, help: "Terminator tilt (radians). Added on top of auto-orientation toward the nearest sun; the sole control when no sun is present." },
  { name: "color", kind: "color", default: "#e8e6de", help: "Moon albedo tint (a warm off-white)." },
  { name: "earthshine", kind: "number", default: 0.5, min: 0, max: 1, help: "Faint glow on the unlit side (sunlight reflected off Earth). 0 = fully black dark side." },
  { name: "maria", kind: "number", default: 0.6, min: 0, max: 1, help: "Contrast of the dark maria (the 'seas' — procedural patches)." },
  { name: "size", kind: "number", default: 0.74, min: 0.05, max: 1, help: "Moon disc radius as a fraction of the box's shorter half-extent." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px)." },
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
  { name: "coverage", kind: "number", default: 0.46, min: 0, max: 1, help: "Cloud coverage threshold. LOWER = more cloud (fills the box); higher = sparse wisps." },
  { name: "softness", kind: "number", default: 0.32, min: 0.01, max: 1, help: "Edge softness of the cloud coverage. Bigger = fluffier, feathered edges." },
  { name: "cloudScale", kind: "number", default: 2.4, min: 0.2, help: "Spatial frequency of the cloud noise — bigger = smaller, more numerous puffs." },
  { name: "speed", kind: "number", default: 1, min: 0, help: "Drift speed (animated). 0 = a frozen still." },
  { name: "ambient", kind: "color", default: "#8fa6c8", help: "Cool sky ambient lighting the shadowed sides/undersides of the clouds fall back to." },
  { name: "base", kind: "color", default: "#eef1f6", help: "Cloud base tint (lit sides go toward white·this, dense cores darken)." },
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the region (world px)." },
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
