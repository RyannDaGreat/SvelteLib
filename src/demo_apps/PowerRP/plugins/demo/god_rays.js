/**
 * GOD RAYS — a DEMO WIDGET (plugins/demo/, the showcase folder) on the reusable
 * MATERIAL FRAMEWORK. A rectangular region over which screen-space volumetric light
 * scattering is accumulated: every pixel marches toward a light position through the
 * content ALREADY DRAWN BENEATH IT and adds up the bright part of what it finds, so
 * the scene itself is simultaneously the light source and the occluder. See
 * render_gpu/skia/god_rays_shader.js for the full technique, the research it adopts
 * and rejects (GPU Gems 3 ch. 13, Mitchell), and the mask reasoning; this file is
 * the plugin surface: the light's world position, the knob set, the one
 * `materialBackdrop` op, the presets, and the light handle.
 *
 * ── WHY A BACKDROP MATERIAL (capabilities.backdrop) ───────────────────────────
 * This is the magnifier/glass/CRT family, NOT the lens-flare family, and the
 * distinction is the entire feature. A lens flare SYNTHESIZES its look from
 * uniforms and samples nothing, so it rides `materialFill`. God rays cannot: the
 * user's requirement is that "if there's a square in front that blocks the Sun, it
 * would block all the god rays", which means the effect must READ what is beneath
 * it. `capabilities.backdrop` + the `materialBackdrop` op give exactly that — the
 * framework re-renders the below-z-order content and binds it as the shader's
 * `sharpBackdrop` child.
 *
 * That is also why game engines' occlusion PRE-PASS is unnecessary here. An engine
 * renders a second, special buffer (emitters bright, geometry black) because its
 * real frame is a lit scene where a wall might be brighter than the sky. In this
 * document model the backdrop is ALREADY nearly that buffer — a sky/sun widget is
 * genuinely the brightest thing on the slide and an opaque widget over it is
 * genuinely dark — so the shader recovers the emitter/occluder split with a
 * luminance key instead of a whole extra render. Zero per-object logic, and it
 * works for occluders the effect has never heard of.
 *
 * ── THE LIGHT IS A WORLD POINT, NOT A FRACTION OF THIS BOX ────────────────────
 * `lightWorldX`/`lightWorldY` are absolute document coordinates (the same design
 * the lens flare uses), for one decisive reason: it is what makes
 * `= sun.x` work. The user asked for rays "compatible with the sky sun", and
 * coupling them means binding this widget's light to the SUN WIDGET'S position —
 * which is a world coordinate belonging to a different item with its own box. A
 * fraction-of-this-box light could not express that: it would silently mean a
 * different world point every time EITHER widget moved or resized. Being ordinary
 * equation-bindable state, the binding costs no engine change, and keyframing the
 * sun across a slide drags the beams with it for free.
 *
 * Because a light OUTSIDE the region is the normal case (a sun above the frame,
 * or one that sets during a transition), nothing clamps it — the shader fades the
 * rays out instead as the light travels away (see the off-screen caveat in the
 * shader header).
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────────
 * Pure PROPERTY state (CLAUDE.md's taxonomy): no clock, no RNG, no seed. The
 * shader's anti-banding dither is a positional hash, so Δt = 0 renders
 * byte-identically and an export is reproducible. Nothing here reads
 * `particleTime()` — unlike the sky sun, these rays do not animate on their own;
 * they move when the document says they move.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { standardBBoxAnchors, worldTransform } from "../../core/derive.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { GOD_RAYS_FILL_PARAMS, godRaysUniformParams } from "../../render_gpu/skia/god_rays_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";
import { effectsCullMargin, finiteGuardedParams } from "../../render_gpu/effects.js";

// The look knobs live in the SHADER entry (the fill-material framework's
// single-declaration rule — comic.js/crt.js are the exemplars). The light position
// is NOT among them: it is world state on this widget, declared below.
const CUSTOM = customProps(GOD_RAYS_FILL_PARAMS);

/**
 * Pure function. The light in this widget's LOCAL px frame: the stored WORLD point
 * brought back through the INVERSE of the item's own local→world similarity
 * transform. This is the same map every other local-space hook here lives in
 * (anchors, snapFeatures, modifierPoints), which is what keeps the draggable handle
 * and the rendered beams from ever disagreeing. NOT clamped: a light outside the
 * box is the ordinary case (an off-frame sun).
 *
 * The `?? 0` guards a hand-built state missing the properties entirely (a test
 * fixture); a document loaded through the normal fold always carries them, because
 * `defaults` below seeds them with equations.
 *
 * @param {object} s - evaluated item state ({lightWorldX?, lightWorldY?, x, y, w, h, rotation?, scale?, rotationAnchor?})
 * @returns {{x: number, y: number}} local px
 *
 * @example // Widget at the origin, unrotated, unit scale: world == local.
 * lightLocal({lightWorldX: 640, lightWorldY: 200, x: 0, y: 0, w: 1280, h: 720}) // {x: 640, y: 200}
 * @example // The SAME world light, widget moved 200px right: local shifts left to compensate.
 * lightLocal({lightWorldX: 640, lightWorldY: 200, x: 200, y: 0, w: 1280, h: 720}) // {x: 440, y: 200}
 * @example // A sun ABOVE the frame — a negative local y, which is legal and expected.
 * lightLocal({lightWorldX: 500, lightWorldY: -180, x: 0, y: 0, w: 1000, h: 600}) // {x: 500, y: -180}
 */
export function lightLocal(s) {
  const inv = T.invert(worldTransform(s));
  return T.apply(inv, s.lightWorldX ?? 0, s.lightWorldY ?? 0);
}

/**
 * Pure function. The light as an OFFSET FROM THE REGION CENTRE, in local units —
 * the form the op carries and the shader's packer turns into device px
 * (god_rays_shader.godRaysLightDevice). Centre-relative rather than absolute-local
 * because the packer's only fixed point is the centre: the framework resolves
 * `cx/cy` to device for it, so an offset from there needs nothing but a length
 * scale and the region's rotation, both of which the packer already holds.
 *
 * @param {object} s - evaluated item state
 * @returns {{x: number, y: number}} local-unit offset from the region centre
 *
 * @example // A light dead centre of a 1000x600 box at the origin.
 * godRaysLightOffset({lightWorldX: 500, lightWorldY: 300, x: 0, y: 0, w: 1000, h: 600}) // {x: 0, y: 0}
 * @example // A sun in the upper right of the same box.
 * godRaysLightOffset({lightWorldX: 800, lightWorldY: 120, x: 0, y: 0, w: 1000, h: 600}) // {x: 300, y: -180}
 */
export function godRaysLightOffset(s) {
  const l = lightLocal(s);
  return { x: l.x - (s.w ?? 0) / 2, y: l.y - (s.h ?? 0) / 2 };
}

/**
 * THE PRESETS: `{name, description, props}`, applied in one undo unit by the Presets
 * pane. Each is a coherent point in the (density, decay, weight, exposure, threshold)
 * space rather than an arbitrary dial spin — the four march knobs trade against each
 * other, so they are tuned as a set.
 *
 * ── THE GAIN LAW, AND THE REASON EVERY ROW WRITES weight === exposure ─────────
 * The march accumulates `sourceKey(tap) · decay^i · weight` and then scales the sum by
 * `exposure`, so the PEAK possible ray value is
 *
 *     G = weight · exposure · S,     S = (1 − decay^samples) / (1 − decay)
 *
 * and the shader clamps to 1. weight and exposure therefore appear ONLY as a product:
 * two presets that trade one against the other at a fixed G are PIXEL-IDENTICAL, which
 * is a dead row wearing two names. Every map below writes them EQUAL so the pair reads
 * as one brightness dial and that mistake is unavailable.
 *
 * MEASURED CLIP KNEE: G ≈ 0.45 on the CPU-Skia occlusion fixture — flat-white coverage
 * jumps 5× between G = 0.417 and G = 0.481. Every G below is under it, and the loudest
 * (Cinematic Beams, 0.380) is deliberately the ceiling of the set. This is not a
 * hypothetical bound: the defaults were once 0.34/0.42 (G = 4.58, 95% of the frame flat
 * white) and three of the first five presets shipped past the knee, up to G = 1.017 —
 * past the shader's own clamp, so guaranteed white before any scene is considered.
 * REMEMBER THE RAYS ARE ADDITIVE: the real clip point is G + backdrop, so a preset that
 * is clean over a dim interior can still blow out over a bright sky.
 *
 * ── THE ORDER IS THE MEDIUM, THEN THE SUN'S OWN DAY ───────────────────────────
 * Between runs: clear air → water droplets → mineral dust and interiors → the water
 * column → manufactured media → beyond the atmosphere. Particle size decides whether the
 * medium tints the beam (above ~1 µm it is Mie, so it does NOT — the tint below is the
 * SOURCE's colour or the medium's body colour, never a scattering colour); optical depth
 * decides how far the beam carries; absorption decides whether it reddens or just dims.
 * Within run 1, the sun's own day, matching sky.js's preset order. Within run 3, the
 * APERTURE, because the aperture and not the dust sets the edge: penumbra ≈ d/108 from
 * the sun's 0.53° disc, so a 9 m oculus 43 m up is only 4.4% soft while a 0.2 m hole past
 * 21.6 m is entirely penumbral. Those two facts are maskSoftness 0.03 and 0.34 below.
 *
 * NO PRESET CARRIES `lightWorldX`/`lightWorldY`. A preset describes how the light
 * SCATTERS, not where the light IS — and clobbering a position the author placed (or
 * bound to a sun with an equation) would be destructive in a way no other knob is.
 * Nor does any preset name a knob outside GOD_RAYS_FILL_PARAMS: tests/god_rays_test.js
 * checks every key against that schema, so an `opacity` or a `blendMode` here (which the
 * lens flare's presets DO carry) takes the suite red.
 */
const PRESETS = [
  // ── RUN 1: CLEAR AIR AND CLOUD — sub-micron aerosol, kilometres of path ─────
  {
    name: "Cinematic Beams",
    description: "The full anamorphic-trailer look: long beams carrying right across the frame, keyed tightly so only the sun and the sky nearest it feed them. The brightest set here and the default answer to 'make it look cinematic'.",
    props: {
      samples: 96, density: 0.95, decay: 0.982, weight: 0.091, exposure: 0.091,
      threshold: 0.62, maskSoftness: 0.16, maskStrength: 1, dither: 1, tint: "#ffffff",
    },
  },
  {
    name: "Storm Break",
    description: "The one hole in a heavy overcast — the highest threshold and one of the tightest knees in the set, so only the blown-out gap is a source and the whole deck is an occluder: one dramatic shaft instead of a general glow, on a real 300-to-1000-fold illuminance step.",
    props: {
      samples: 128, density: 1, decay: 0.99, weight: 0.06, exposure: 0.06,
      threshold: 0.86, maskSoftness: 0.05, maskStrength: 1, dither: 1, tint: "#f2f7ff",
    },
  },
  {
    name: "Subtle Morning",
    description: "Early low sun through a hazy window: short, soft, barely-there shafts that read as atmosphere rather than as an effect — the shortest march in the set, a quick decay, and a threshold low enough that the lit morning air feeds the beams rather than the disc alone.",
    props: {
      samples: 48, density: 0.55, decay: 0.955, weight: 0.08, exposure: 0.08,
      threshold: 0.6, maskSoftness: 0.22, maskStrength: 1, dither: 1, tint: "#ffe3c2",
    },
  },
  {
    name: "Sunset Cloud Break",
    description: "Crepuscular rays proper, with the sun about five degrees up: ten airmasses of slant path leave the beam roughly six times richer in red than in blue, and the shafts are near-parallel — only perspective makes them fan out from the sun.",
    props: {
      samples: 96, density: 1, decay: 0.982, weight: 0.084, exposure: 0.084,
      threshold: 0.8, maskSoftness: 0.07, maskStrength: 1, dither: 1, tint: "#ffad6a",
    },
  },
  {
    name: "Moonlight Through Cloud",
    description: "Full moonlight at about a millionth of sunlight — the faintest preset here by a factor of two, long and cool. The cool cast is the PERCEPT, not the spectrum: moonlight is sunlight off a 13.6%-albedo grey body and is fractionally REDDER than daylight, and the silver is the Purkinje shift in a dark-adapted eye.",
    props: {
      samples: 96, density: 1, decay: 0.986, weight: 0.03, exposure: 0.03,
      threshold: 0.78, maskSoftness: 0.18, maskStrength: 1, dither: 1, tint: "#e6eeff",
    },
  },
  // ── RUN 2: WATER DROPLETS — 1-40 µm, achromatic, and the density decides the reach ─
  {
    name: "Forest Canopy Mist",
    description: "Sunflecks through a broadleaf canopy at dawn: many small gaps rather than one, in radiation fog dense enough that the whole lit air glows and not just the sun — hence the lowest threshold but one. Deliberately NOT green: the beam is unfiltered sunlight through a hole, and the green belongs to the diffuse light that came through leaves.",
    props: {
      samples: 80, density: 0.95, decay: 0.978, weight: 0.075, exposure: 0.075,
      threshold: 0.54, maskSoftness: 0.28, maskStrength: 1, dither: 1, tint: "#ffe3c2",
    },
  },
  {
    name: "Harbour Searchlight",
    description: "A carbon-arc beam in heavy sea fog: ten-micrometre droplets at 130 m visibility kill it inside about two hundred metres however many candela go in, so this is the shortest, hardest-ended beam in the library — warm, because an arc's light comes from its glowing anode crater.",
    props: {
      samples: 48, density: 0.5, decay: 0.94, weight: 0.13, exposure: 0.13,
      threshold: 0.82, maskSoftness: 0.1, maskStrength: 1, dither: 1, tint: "#ffd2a1",
    },
  },
  // ── RUN 3: MINERAL DUST AND INTERIORS — the APERTURE sets the edge, not the dust ──
  {
    name: "Cathedral Dust Shaft",
    description: "A clerestory lancet raking across a dim stone nave: a very high threshold so only the opening is a source, and the faintest interior shaft here on purpose — a real one measures around a twenty-thousandth of the sunlit patch it lands on, so it needs a dark room to exist at all.",
    props: {
      samples: 96, density: 1, decay: 0.988, weight: 0.044, exposure: 0.044,
      threshold: 0.86, maskSoftness: 0.16, maskStrength: 1, dither: 1, tint: "#ffebd4",
    },
  },
  {
    name: "Pantheon Oculus",
    description: "A nine-metre round opening forty metres overhead: the crispest edge in the whole library, because an aperture that large leaves the sun's own half-degree disc only about four percent of the patch to feather. One vertical column, daylight-neutral, against a near-black interior.",
    props: {
      samples: 128, density: 1, decay: 0.984, weight: 0.066, exposure: 0.066,
      threshold: 0.84, maskSoftness: 0.03, maskStrength: 1, dither: 1, tint: "#fff2e6",
    },
  },
  {
    name: "Ruin Skylight",
    description: "Small ragged holes in a dust-choked roof: past the pinhole crossover, so every shaft is entirely penumbra with no hard core at all — the softest edge in the set, twenty times a working church's particulate, and no warm stone bounce to lift the shadows.",
    props: {
      samples: 96, density: 0.9, decay: 0.98, weight: 0.092, exposure: 0.092,
      threshold: 0.68, maskSoftness: 0.34, maskStrength: 1, dither: 1, tint: "#f7f4ee",
    },
  },
  {
    name: "Dusty Window",
    description: "A low sun through one glazed opening into a warm interior: a short march, a hard-keyed edge from the small aperture, and the amber of golden-hour light warmed further by a timber bounce.",
    props: {
      samples: 80, density: 0.7, decay: 0.972, weight: 0.087, exposure: 0.087,
      threshold: 0.78, maskSoftness: 0.09, maskStrength: 1, dither: 1, tint: "#ffcb94",
    },
  },
  {
    name: "Harmattan Dust",
    description: "A whole sky of Saharan mineral dust — the ONE preset that lets mid-tones scatter, because at that optical depth everything really does smear toward the sun. Ochre rather than orange: dust extinction is almost wavelength-flat, so it greys and dims the light instead of reddening it.",
    props: {
      samples: 64, density: 0.9, decay: 0.972, weight: 0.048, exposure: 0.048,
      threshold: 0.36, maskSoftness: 0.4, maskStrength: 0.55, dither: 1, tint: "#f0d2a8",
    },
  },
  {
    name: "Wildfire Smoke Sun",
    description: "The sun through thick wildfire smoke: an ABSORBING medium, so the beams come out short and stubby rather than long, and deep orange from the forward-scattered disc.",
    props: {
      samples: 48, density: 0.6, decay: 0.955, weight: 0.105, exposure: 0.105,
      threshold: 0.72, maskSoftness: 0.2, maskStrength: 1, dither: 1, tint: "#ff9043",
    },
  },
  {
    name: "Blue Sun",
    description: "The Alberta muskeg fires of September 1950, when a narrow population of one-micrometre droplets scattered the RED out of sunlight and left an indigo sun over half the northern hemisphere — the one cold beam in the dust run, and a dated event rather than a colour pick.",
    props: {
      samples: 64, density: 0.8, decay: 0.968, weight: 0.076, exposure: 0.076,
      threshold: 0.56, maskSoftness: 0.26, maskStrength: 1, dither: 1, tint: "#9db8e8",
    },
  },
  // ── RUN 4: THE WATER COLUMN — absorption, not scattering, picks the colour ───
  {
    name: "Sunlit Shallows",
    description: "Sunbeams in five metres of clear ocean — the SHAFTS, not the caustics: at that depth red is already down to a fifth and deep red to a twentieth, so the columns go cyan. The bright net on the seabed is a refraction pattern and no radial effect can draw it; supply that in the artwork underneath.",
    props: {
      samples: 88, density: 0.9, decay: 0.972, weight: 0.086, exposure: 0.086,
      threshold: 0.62, maskSoftness: 0.3, maskStrength: 1, dither: 1, tint: "#a8e8ff",
    },
  },
  {
    name: "Deep Water Column",
    description: "Fifteen metres down, where red has fallen under one percent and green is halved: the softest, bluest columns in the set, dimmer than the shallows and reaching further because there is nothing left to absorb the blue.",
    props: {
      samples: 96, density: 1, decay: 0.982, weight: 0.049, exposure: 0.049,
      threshold: 0.56, maskSoftness: 0.42, maskStrength: 1, dither: 1, tint: "#37bdff",
    },
  },
  // ── RUN 5: MANUFACTURED MEDIA — engineered uniformity, saturated sources ─────
  {
    name: "Stage Haze Beam",
    description: "A profile spot through concert haze: sub-micrometre droplets hanging for hours give a beam of even brightness along its whole throw, the fixture's imaged gate gives the hardest edge in the set, and the colour is a deep gel that blocks more than 99% of the light yet still reads vividly in the air.",
    props: {
      samples: 128, density: 1, decay: 0.994, weight: 0.062, exposure: 0.062,
      threshold: 0.84, maskSoftness: 0.03, maskStrength: 1, dither: 1, tint: "#2a1aff",
    },
  },
  {
    name: "Projector Beam",
    description: "A xenon beam in a dark auditorium: barely any medium at all, so the shaft is faint, short and granular — a bounded wedge from lamp to screen rather than a column reaching the frame edge, and the ONE preset with the dither off, because a beam you see by individual drifting motes is genuinely stepped rather than smooth.",
    props: {
      samples: 40, density: 0.55, decay: 0.945, weight: 0.111, exposure: 0.111,
      threshold: 0.88, maskSoftness: 0.06, maskStrength: 1, dither: 0, tint: "#fffcfa",
    },
  },
  {
    name: "Sodium Street Fog",
    description: "A low-pressure sodium lamp in fog: its two yellow emission lines are about nine tenths of the output, so the halo is one pure amber with no colour variation anywhere across it — the most monochromatic light in the library, and short, because fog ends a beam quickly.",
    props: {
      samples: 48, density: 0.45, decay: 0.94, weight: 0.107, exposure: 0.107,
      threshold: 0.7, maskSoftness: 0.32, maskStrength: 1, dither: 1, tint: "#ff8000",
    },
  },
  // ── RUN 6: BEYOND THE ATMOSPHERE — the one truly radial case ────────────────
  {
    name: "Nebula Shroud",
    description: "Starlight escaping through gaps in a dust shroud around a dying star: the only entry here whose beams really do diverge from the source rather than merely appearing to, because the star is a genuine point inside a genuine dust volume — the longest, most parallel march in the library and the highest threshold.",
    props: {
      samples: 128, density: 1, decay: 0.992, weight: 0.048, exposure: 0.048,
      threshold: 0.9, maskSoftness: 0.06, maskStrength: 1, dither: 1, tint: "#d9e6ff",
    },
  },
];

export const godRaysPlugin = {
  type: "demo_god_rays",
  title: "God Rays",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  presets: PRESETS,
  defaults: {
    // A 16:9-ish region sized to cover a slide's sky area; an author usually
    // stretches it over the whole frame.
    type: "demo_god_rays", x: 60, y: 60, w: 1000, h: 620, z: 200, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // THE LIGHT, in WORLD coordinates. The defaults are EQUATIONS in the widget's
    // own frame, so a freshly inserted widget has its light in the upper-middle of
    // its own box (where a sun usually is) while the STORED form is already the
    // absolute, equation-bindable one the sun coupling needs — retarget it with
    // `= sun.x` and nothing else changes.
    //
    // BARE "self."-prefixed form (NO leading "="), matching the flare's own default
    // two properties down its file: isNumericSlot's self.-prefix branch is what makes
    // the evaluator expect a NUMBER result here. A leading "=" is the UNIVERSAL
    // any-type marker (core/expressions.js EQ_PREFIX_RE) and sends resultKindForSlot
    // past isNumericSlot entirely — it then inspects THIS DEFAULT STRING's own shape
    // (not a hex color, so "string") instead of ever seeing that the string is itself
    // a self.-prefixed computed default, and validates the equation's numeric result
    // against kind "string". That rejects every insert: the shipped bug had this
    // exact leading "=", so a freshly-inserted god-rays widget failed its OWN
    // light-position equations on the very first evaluation, fell back to
    // fallbackFor(path) — which returns the plugin's default AT THAT PATH, i.e. this
    // string ITSELF, unresolved — and state.lightWorldX became the literal text
    // "= self.x + 0.5 * self.w" flowing as a string into arithmetic. Proven (not
    // guessed): resultKindForSlot(godRaysPlugin, ["lightWorldX"], defaultString) fired
    // "string" for the old leading-"=" form.
    //
    // BUILT FROM self.anchors.tl/br, NOT self.x/self.w/self.h DIRECTLY — the flare's
    // OWN precedent two files over, and not optional: a raw self.w/self.h PROP read
    // (core/expressions.js refValue) hands back the STORED, possibly NEGATIVE extent
    // (a Flip) with no unsigning, while an ANCHOR read (core/expressions.js
    // anchorValue) enters THE FLIP SEAM (unsignedState) first. The first attempt at
    // this fix used self.x + 0.5*self.w directly and passed every hand-built fixture
    // test (which never flips a box) while FAILING tests/negative_size_test.js's
    // sweep: a -w+h god-rays widget derived a DIFFERENT lightWorldX than the +w+h
    // spelling of the identical footprint, because self.w carried the sign straight
    // into the default equation. tl/br span the box corner-to-corner in WORLD units
    // and are already unsigned, so (br - tl) is the unsigned w/h and tl is the
    // unsigned origin — this default is flip-safe by construction, like
    // rotationAnchor's own self.anchors.center default just above it.
    lightWorldX: "self.anchors.tl.x + 0.5 * (self.anchors.br.x - self.anchors.tl.x)",
    lightWorldY: "self.anchors.tl.y + 0.18 * (self.anchors.br.y - self.anchors.tl.y)",
    cornerRadius: 0,
    // No rim by default: rays are light, and a box drawn around light looks like a
    // mistake. The knob stays for anyone framing a deliberate "window".
    stroke: "rgba(255,255,255,0.18)", strokeWidth: 0,
    ...defaults("opacity"), // opacity:1
    // The rays are ADDITIVE light, so the effects bundle defaults to "screen" — the
    // lens flare's precedent, and the composite the shader's premultiplied-additive
    // output is shaped for.
    ...bundleNestedDefaults("effects"),
    blendMode: "screen",
    ...CUSTOM.defaults, // the march/mask/look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    // THE LIGHT — world coordinates, so an equation can bind them to a sun widget.
    { key: "lightWorldX", label: "Light X", kind: "number", category: "positioning",
      // NOTHING IS DECLARED HERE FOR THE PIN, and that is the point of manifest
      // R6-4.5: this row used to repeat lens_flare's `pinLight` aspect verbatim to
      // get the same eyedropper. The pin is now a Tools-pane tool whose gate reads
      // core/registry.js's LIGHT_KEYS off `defaults`, so this widget inherits it
      // from having a light position at all.
      help: "The light's X in DOCUMENT coordinates — not a position inside this box. Bind it to a sun widget with an equation (e.g. = sun.anchors.center.x), or use the Tools pane's Pin Light Position to an Object and pick the sun, and the beams follow it anywhere, including off the edge of the slide." },
    { key: "lightWorldY", label: "Light Y", kind: "number", category: "positioning",
      help: "The light's Y in DOCUMENT coordinates. A value above the region (a smaller Y than the box's top) is the normal case for a high sun; the rays fade out as the light travels well past the region." },
    ...props("cornerRadius", "stroke", "strokeWidth", "opacity", {
      cornerRadius: { label: "Corner radius" },
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...bundle("effects"),
    ...CUSTOM.rows, // the grouped look knobs (march / mask / look)
  ],
  /**
   * Pure function (see finiteGuardedParams — logs on a genuinely broken input,
   * never on an ordinary one; the fixture-deck suite and every hand-built test
   * pass a well-formed state and log nothing). State → display-list: ONE
   * `materialBackdrop` op naming the "god_rays" material. The bbox (w, h) IS the
   * region the rays render over (local space; sceneIR wraps it in the node's
   * world). The light rides as a CENTRE-RELATIVE LOCAL OFFSET (godRaysLightOffset)
   * which the material's packer converts to device px — see the seam note there
   * for why the conversion happens at the packer and not here (emit() cannot see
   * the camera).
   *
   * THE LANDING BAR: every numeric param is finite-guarded (finiteGuardedParams)
   * before it reaches materialBackdrop's own strict validator (render_gpu/ir.js —
   * that check stays a THROW, on purpose: it is the last line of defense for
   * every material, not just this one, and weakening it would let a genuinely
   * broken OTHER widget through silently). This widget's job is to never hand it
   * a bad value in the first place: an unresolvable light degrades to the box's
   * own centre (offset 0,0) and a broken look-knob degrades to that knob's own
   * plugin default, each logged once by name so the cause is findable instead of
   * a red box with no history. This is what makes a STALE item (missing the
   * light keys outright — repairedDocument now fills them, see core/document.js
   * missingDefaults) render something sane even in the one frame before a
   * reload/repair pass has run.
   *
   * `blurRadius: 0` is deliberate and not a default left unset: the material
   * declares `usesBlurredBackdrop: false`, so no blurred child is built at all, and
   * a nonzero radius here would only be a misleading number in a serialized op.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    const off = godRaysLightOffset(s);
    const rawParams = { lightOffsetX: off.x, lightOffsetY: off.y, ...godRaysUniformParams(s) };
    const fallback = { lightOffsetX: 0, lightOffsetY: 0, ...godRaysUniformParams(godRaysPlugin.defaults) };
    const params = finiteGuardedParams(rawParams, fallback, `demo_god_rays ${s.id ?? "?"}`);
    return [materialBackdrop({
      material: "god_rays",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius ?? 0,
      blurRadius: 0,
      params,
      stroke: strokeW > 0 ? s.stroke : null,
      strokeWidth: strokeW,
      opacity: s.opacity ?? 1,
    })];
  },
  // The effects bundle's shadow/bloom halo reaches outside the box, so the cull test
  // must inflate by it or a rays widget at the view edge would pop out early. The
  // RAYS themselves need no margin — they are drawn strictly inside the region's own
  // SDF, so the box IS their ink.
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  /**
   * Pure function. Standard bbox anchors PLUS a live "light" anchor at the light
   * source, so another widget can bind TO the rays' light as easily as the rays can
   * bind to a sun.
   */
  anchors(state) {
    const l = lightLocal(state);
    return [...standardBBoxAnchors(state), { id: "light", x: l.x, y: l.y }];
  },
  snapFeatures(s) {
    const l = lightLocal(s);
    return [
      { kind: "point", x: s.w / 2, y: s.h / 2, id: "center" },
      { kind: "point", x: l.x, y: l.y, id: "light" },
    ];
  },
  /**
   * The draggable LIGHT handle. Reads through lightLocal (so it sits exactly where
   * the beams emanate from, at any widget rotation/scale) and writes back the WORLD
   * point, which is the stored form — dragging therefore produces the same kind of
   * value an equation would, and a light that WAS equation-bound is overridden by a
   * literal rather than silently fighting the equation.
   */
  modifierPoints(state) {
    const l = lightLocal(state);
    return [{
      id: "light",
      x: l.x, y: l.y,
      /**
       * Command (returns a state patch). CanvasView drags in WORLD space and inverts
       * through node.world before calling `apply` (THE HANDLE-CONSTRAINT PROTOCOL,
       * core/derive.js), so this receives a LOCAL point; it maps that BACK to world
       * through the item's own worldTransform — the exact inverse of lightLocal, so a
       * drag round-trips. UNCLAMPED, and no `constrain`: the whole plane is allowed,
       * because dragging the sun off the frame is a thing an author does on purpose.
       */
      apply(itemState, localPoint) {
        const w = T.apply(worldTransform(itemState), localPoint.x, localPoint.y);
        return { lightWorldX: w.x, lightWorldY: w.y };
      },
    }];
  },
  // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
};
