/**
 * LENS FLARE — a DEMO WIDGET (plugins/demo/, the showcase folder): a physically-
 * motivated, motion-picture lens flare synthesized entirely in SkSL from a single
 * light-source position. Ghost chain + anamorphic streak + halo ring + starburst
 * spikes + chromatic fringing + bloom/veiling glare + procedural dirt — see
 * render_gpu/skia/lens_flare_shader.js for the technique/citations.
 *
 * ── HOW IT COMPOSITES (additive, via the shared effects bundle) ───────────────
 * Like raycast_dither / corkboard it is a FOREGROUND (backdrop:false) GENERATIVE
 * material: it samples NOTHING beneath it and emits ONE `materialFill` op naming
 * the "lens_flare" material (NO new IR op, NO backdrop re-render). It synthesizes on
 * a TRANSPARENT field, so to add LIGHT to the scene it composes the shared EFFECTS
 * BUNDLE (core/properties.js) with blendMode defaulted to "screen": emit() wraps the
 * materialFill in render_gpu/effects.js applyEffects, which — because the blend is
 * non-normal — builds ONE effectSubtree the backend composites additively over the
 * scene. Adjustable overall gain is the `brightness` knob; the user can switch the
 * blend to "add" (or "normal") in the Inspector's Effects region.
 *
 * ── TWO ON-CANVAS HANDLES: WHERE the light is, and HOW BIG its features are ───
 * Every size knob here is normalized to the widget's own height, which is what makes
 * a look hold at any zoom — but it also means the BOX SIZE alone decides how big the
 * rings are. Scale the widget up and the flare scales with it, with no way to say
 * otherwise. `flareScale` is the knob that decouples them: a master multiplier on
 * every feature SIZE (see render_gpu/skia/lens_flare_shader.js "THE FEATURE SCALE"
 * for exactly what is scaled and what is deliberately not). So the box sets the
 * flare's REACH and the scale sets its ring size, independently — a full-frame flare
 * with small tight rings is now just two drags. It gets the SECOND yellow modifier
 * point, radial about the optical centre, alongside the light's.
 *
 * ── PRESETS (the reusable PRESETS mechanism) ──────────────────────────────────
 * `presets: [{name, description?, props}]` is a plugin-declared list of built-in
 * property-sets. The generic Presets pane (web/ToolsPane.svelte) lists them for
 * any selected widget that declares them and, hovering, previews one with the
 * document UNCHANGED (app.setPreview) and, on click, writes `props` onto the item as
 * keyframed values on the CURRENT frame in ONE undo unit (app.applyPreset). This
 * ships TWELVE looks, ONE FLAT family, in a deliberate order — see the PRESETS table
 * below for both the order's meaning and why it is not split into families.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps): a
 * literal, an expression, or a `= …` equation, with ZERO evaluation-engine changes —
 * so e.g. a keyframed `starburstRotation` or `lightX = self.w/1000` is free.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, bundleNestedDefaults, customProps, defaults, props } from "../../core/properties.js";
import { materialFill } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
import { MAX_GHOSTS } from "../../render_gpu/skia/lens_flare_shader.js";

// UNIT_SPAN_SCRUB (core/properties.js, beside SECONDS_SCRUB) is the scrub
// sensitivity for the UNBOUNDED normalized knobs below — the light position, the
// dirt mix, the feature scale. It used to be declared here; three plugins had
// hand-written the same constant, so it moved to the registry.

/**
 * The reference radius the FEATURE-SCALE handle rides, in the shader's HEIGHT-
 * normalized frame (render_gpu/skia/lens_flare_shader.js normalizes by the half-
 * height, so a normalized radius R is R·h/2 LOCAL px). At flareScale 1 the handle
 * therefore sits exactly on the DEFAULT halo ring (haloRadius 0.45) — so on a
 * default flare the yellow square lands ON a ring it scales, and dragging it
 * literally resizes that ring.
 *
 * It is a CONSTANT, deliberately NOT a live read of `haloRadius`: a handle whose
 * arm came from another knob would collapse onto the widget centre — and its
 * inverse divide would go degenerate — the moment the user set that knob to 0
 * (a legal, documented "halo off" value). A handle must not stop working because
 * an unrelated knob is switched off.
 */
const SCALE_HANDLE_REF_RADIUS = 0.45;

/**
 * Pure function. The light source in the widget's LOCAL px frame: the lightX/lightY
 * fractions scaled by the box extent (w, h). Shared by the light anchor, the snap
 * feature, and the draggable modifier point so they never drift. The fractions are
 * NOT clamped to [0,1] — a light outside the box is the whole point of an off-frame
 * sun, so this returns local px outside [0,w]×[0,h] just as happily.
 *
 * @param {{lightX?: number, lightY?: number, w?: number, h?: number}} s - evaluated item state
 * @returns {{x: number, y: number}} local px
 *
 * @example lightLocal({lightX: 0.5, lightY: 0.5, w: 1280, h: 720}) // {x: 640, y: 360}
 * @example lightLocal({lightX: 0.72, lightY: 0.3, w: 1000, h: 500}) // {x: 720, y: 150}
 * @example lightLocal({lightX: -0.4, lightY: 1.8, w: 1000, h: 500}) // {x: -400, y: 900} (off-box sun)
 */
function lightLocal(s) {
  return { x: (s.lightX ?? 0.5) * (s.w ?? 0), y: (s.lightY ?? 0.5) * (s.h ?? 0) };
}

/**
 * Pure function. The FEATURE-SCALE handle's arm in the widget's LOCAL px frame: the
 * reference radius above, de-normalized by the widget's HALF-HEIGHT (the shader's own
 * normalization). This is the distance the handle sits from the widget centre when
 * flareScale is 1, so the forward map (where the handle goes) and its inverse (what a
 * drag means) both read it and can never drift.
 *
 * @param {{h?: number}} s - evaluated item state
 * @returns {number} local px per unit of flareScale
 *
 * @example scaleHandleArm({h: 720}) // 162 (0.45 × 360)
 * @example scaleHandleArm({h: 0}) // 0 (degenerate box — the caller guards)
 */
function scaleHandleArm(s) {
  return SCALE_HANDLE_REF_RADIUS * (s.h ?? 0) / 2;
}

// The look knobs, all self.* custom properties. Dimensionless field knobs are
// normalized to the widget's own extent, so the look holds at any zoom/size; light
// position is expressed as a fraction of the widget (0.5,0.5 = centre) but is NOT
// confined to it. The defaults are a tasteful warm cinematic flare (the Presets pane
// offers twelve further looks).
//
// BOUNDS POLICY (manifest "no arbitrary constraints invented by Claude"): every
// remaining min/max here is GEOMETRIC or TECHNICAL and says so. A knob whose only
// limit was taste carries none — a value the shader renders is a value the user may
// ask for. Where a floor of 0 survives, it is because the shader's own guard would
// SILENTLY swallow the negative (a silent clamp discards the user's value, which is
// the same disease as a UX cap) — see each row's note.
const CUSTOM = customProps([
  { name: "lightX", kind: "number", default: 0.72, scrub: UNIT_SPAN_SCRUB, help: "Light-source horizontal position as a fraction of the widget: 0 = left edge, 0.5 = centre, 1 = right edge. UNBOUNDED — negative or above 1 puts the light off the box entirely (the off-frame sun), and the ghost chain still marches from there through the widget centre and sweeps across the frame." },
  { name: "lightY", kind: "number", default: 0.3, scrub: UNIT_SPAN_SCRUB, help: "Light-source vertical position as a fraction of the widget: 0 = top, 0.5 = centre, 1 = bottom. UNBOUNDED, exactly like the horizontal position — a sun above or below the frame is a normal thing to want." },
  { name: "brightness", kind: "number", default: 1.2, min: 0, help: "Overall gain on the whole flare — the adjustable master intensity of the additive light added to the scene. Floor 0 (off): the shader clamps the assembled flare to [0,1] before premultiplying, so a negative gain would be silently swallowed rather than subtract light." },
  // THE FEATURE SCALE — the master SIZE knob, paired here with the master GAIN above.
  // Every other size knob below is normalized to the widget's own height, so the box
  // size is otherwise the ONLY thing that sets how big the rings are; this decouples
  // the two. Set it by dragging the second yellow handle (see modifierPoints), or by
  // keyframing/binding it like any other property.
  { name: "flareScale", kind: "number", default: 1, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Master size of every flare FEATURE — the ghosts, the halo ring, the streak, the glow and the starburst spikes all scale together, about their own centres. 1 = the sizes the knobs below name literally; 0.5 = a flare half the size in a box of the same size; 0 = every feature collapses (off). This is how a full-frame flare can still carry small rings: resize the box for the flare's REACH, then drag the second yellow handle to set the ring size independently. No upper cap — a big value simply grows the features past the box. Floor 0 because a size cannot be negative; below it the shader's own guard would silently swallow the value (and the bloom core's exponential would invert to infinity)." },
  // `step: 1` because this is a COUNT, not a magnitude. Being bounded, it would
  // otherwise derive its grid from the range (numberStep.js resolveScrub: a
  // 0..MAX_GHOSTS span across one drag run gives a 0.01 grid), and a fractional
  // count means nothing to the shader — an explicit step is the only thing
  // inference is not allowed to guess, by that module's own doctrine. Same
  // treatment as the other integer-valued knobs that declare it
  // (demo_mandelbrot's fineExponent and maxIterations).
  { name: "ghostCount", kind: "number", default: 6, min: 0, max: MAX_GHOSTS, step: 1, help: `Number of aperture "ghosts" (iris reflections) marching along the axis through the centre. 0 = none; up to ${MAX_GHOSTS} — that ceiling is the shader's FIXED loop bound (SkSL cannot loop a uniform number of times), not a matter of taste.` },
  { name: "ghostSpacing", kind: "number", default: 0.33, help: "How far apart the ghosts are spaced along the axis: ghost i sits at light·(1 − spacing·i), so ~0.3 puts one near the centre. Higher = more spread out; 0 stacks them all on the light; a negative value marches the chain outward AWAY from the centre instead." },
  { name: "ghostSize", kind: "number", default: 0.11, min: 0, help: "Base radius of the ghost discs (normalized to widget height). Ghosts grow along the chain from this base. Floor 0 because a radius cannot be negative; 0 itself is a valid vanishing point (the shader guards the divide)." },
  { name: "ghostIntensity", kind: "number", default: 0.4, min: 0, help: "Brightness of the ghost chain. Floor 0 (off) for the same reason as the master gain — negative light is clamped away, not subtracted." },
  { name: "anamorphic", kind: "number", default: 0.5, min: 0, help: "Intensity of the horizontal anamorphic streak (the blue JJ-Abrams light bar). 0 = off; floor 0 as above." },
  { name: "streakLength", kind: "number", default: 0.4, min: 0, help: "Horizontal length (σx) of the anamorphic streak, in normalized units. Longer = a wider light bar. Floor 0 because a gaussian σ cannot be negative; 0 itself collapses the streak (the shader guards the divide)." },
  { name: "streakColor", kind: "color", default: "#6fa8ff", help: "Colour of the anamorphic streak — classically a coating blue." },
  { name: "halo", kind: "number", default: 0.45, min: 0, help: "Intensity of the halo ring around the optical centre. 0 = off; floor 0 as above." },
  { name: "haloRadius", kind: "number", default: 0.45, min: 0, help: "Radius of the halo ring (normalized to widget height, measured from the centre). No upper cap — a huge ring simply passes outside the box. Floor 0 because a radius cannot be negative." },
  { name: "starburst", kind: "number", default: 0.4, min: 0, help: "Intensity of the diffraction starburst (the radial spikes from the aperture blades). 0 = off; floor 0 as above." },
  { name: "blades", kind: "number", default: 8, min: 3, help: "Aperture blade count. Diffraction physics: an EVEN count gives that many spikes; an ODD count gives twice as many (e.g. 9 blades → 18 spikes). Also shapes the ghost iris polygon. Floor 3 is geometric (an iris polygon needs three sides) and matches the shader's own MIN_BLADES — below it the shader would silently clamp." },
  // THE OLD FLOOR OF 1 WAS ARBITRARY AND IS GONE. Exponents in (0,1) render perfectly
  // well and give exactly the "soft, fat rays" this help promises, so blocking them was
  // taste. The floor that REMAINS at 0 is TECHNICAL: the profile is pow(|cos θ|, sharp)
  // and |cos θ| is exactly 0 perpendicular to every spike, where pow(0, e ≤ 0) is
  // UNDEFINED in the shading language. render_gpu/skia/lens_flare_shader.js now floors
  // that BASE with SPIKE_BASE_EPS (the same `max(x, EPS)` it already applies to the
  // ghost size, halo thickness and streak sigma), which is what makes 0 itself legal
  // and deterministic. Below 0 the pow INVERTS — it diverges as the cosine goes to
  // zero, so the peak is pinned by SPIKE_BASE_EPS and the final [0,1] clamp rather than
  // by this knob, i.e. the value stops being a sharpness at all.
  { name: "starburstSharp", kind: "number", default: 18, min: 0, help: "Spike thinness (exponent). Higher = razor-thin spikes; lower = soft, fat rays; 0 = no spikes at all, just an even radial glow. No upper cap — a huge exponent is simply a hairline star." },
  { name: "starburstRotation", kind: "angle", display: "degrees", default: 0.2, help: "Rotation of the starburst spikes — keyframe it (or bind an equation) to make the spikes swim as a camera turns. Uncapped: past 360° keeps counting, so a keyframed 720° spins twice." },
  { name: "chromatic", kind: "number", default: 0.02, help: "Chromatic dispersion amount: how far the red/blue channels split at each iris/halo edge (spectral fringing). Tiny is realistic; a negative value disperses the other way (blue outside instead of red)." },
  // Named "glow" (NOT "bloom") deliberately: the effects bundle already owns a
  // nested `bloom` object (bloom.radius/strength, a vector-glow substrate), so a
  // scalar self.bloom would collide with it. This is the flare's OWN in-shader glow.
  { name: "glow", kind: "number", default: 1.0, min: 0, help: "Bloom / veiling glare intensity — the tight hot core at the light plus a broad soft haze that washes the frame. Floor 0 (off) as above." },
  { name: "dirt", kind: "number", default: 0.18, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Procedural lens-dirt/grunge modulation: 0 = clean glass; 1 = the whole flare is broken up by a dusty grime field (all procedural — no texture asset). No upper cap — past 1 the grime mix extrapolates, crushing the dirtiest patches all the way to black for a harsher, higher-contrast grime. Floor 0 (clean) as above." },
  { name: "colorTemp", kind: "number", default: 5200, min: 1000, max: 12000, help: "Colour temperature in Kelvin of the light's cast on the flare: ~3200 K = warm amber, 6500 K = neutral white, ~9000 K+ = cool blue. The range is the domain of the Kelvin→RGB fit the shader uses (render_gpu/skia/lens_flare_shader.js KELVIN_TABLE); outside it the fit is undefined and the packer would silently pin the value." },
  { name: "tint", kind: "color", default: "#fff2e6", help: "Explicit colour multiply over the whole flare, on top of the temperature cast." },
]);

/**
 * A PRESET: `{name, description?, props}`. `props` is a flat map of item-state keys
 * (the self.* look knobs above + the shared `blendMode`) applied to the current
 * frame in one undo unit by the Presets pane. `description` is the row's hover tip,
 * which makes it the one place a look can say WHICH GLASS it is imitating.
 *
 * EVERY PRESET SETS EVERY LOOK KNOB. app.applyPreset writes exactly the keys in
 * `props`, as an OVERLAY on the current state, so a knob a preset omits keeps
 * whatever the PREVIOUSLY hovered preset left there — presets that disagree about
 * which knobs they mention are order-dependent, and comparing looks by running down
 * the list is the entire point of the pane. So all 19 look knobs are spelled out in
 * all twelve maps below, including where a value is inert (streakColor while
 * `anamorphic` is 0; blades while `starburst` is 0).
 *
 * ONE FLAT FAMILY, NOT `presetFamilies`. core/registry.js will give a widget several
 * named preset families, and it requires them to write DISJOINT key sets so that
 * picking one from each COMPOSES rather than clobbers (the Mandelbrot
 * location/colour/performance split; enforced over every plugin by
 * tests/tool_groups_test.js). These twelve are alternative WHOLE looks over the same
 * 19 knobs, so ANY split of them overlaps on all 19 and the second pick would
 * silently erase the first — precisely what that rule exists to forbid. The ORDER
 * below is also information a split would destroy: see the coating-era run at its head.
 *
 * NO PRESET CARRIES `lightX`/`lightY` (user request, complained about directly): a
 * preset changes the LOOK, it never teleports a light the user already positioned.
 * The light position is COMPOSITION — it is placed on the canvas by dragging the
 * yellow handle, or keyframed, or driven by an equation — while the ~20 other knobs
 * are all look. Nothing is lost by leaving it out: the shader is aspect-correct and
 * every knob here is normalized to the widget, so each look holds identically at any
 * light position, on-box or off. (Before this, applying a preset to a flare whose sun
 * had been dragged off-frame yanked it back inside the box.)
 *
 * NO PRESET CARRIES `flareScale` EITHER, by exactly that same test: it is the OTHER
 * knob a user sets by dragging a yellow handle, and it says how the flare FITS its
 * box, not what the flare looks like. Someone who sized a full-frame box and then
 * dialled the rings back down would lose that fit the instant they tried a preset —
 * the same complaint as the teleported sun. Nothing is lost: every size a preset
 * names below is relative, so each look holds identically at any feature scale.
 */
const PRESETS = [
  // ── THE COATING ERA (the first five, IN ORDER) ──────────────────────────────
  // The order IS the content: modern multicoated → many-group zoom → seventies fast
  // prime → single-layer coating → uncoated glass. Three knobs move with that
  // progression, which is what makes these five differ by cause rather than by taste:
  //   tint  = the COATING's residual reflection colour (multi-layer ≈ a faint green,
  //     single-layer = purple, uncoated = broadband white). A DIFFERENT physical cause
  //     from colorTemp, which carries the LIGHT SOURCE's temperature — one knob each,
  //     and conflating them double-warms a look (the defect that turned an earlier
  //     "Sodium Street Lamp" into a dark orange smudge).
  //   glow = veiling glare, on the measured flare-factor ladder ~4 : ~2 : ~1 for
  //     uncoated : single-coated : top multicoated.
  //   ghostIntensity = the same three eras in ORDER ONLY. The true ghost-brightness
  //     ratio is a factor of ~25 per coating step, which would sink the coated ghosts
  //     below the display's noise floor; this knob is a display gain, not a
  //     reflectance, so the ladder is compressed deliberately.
  // ghostCount is independent of ghost BRIGHTNESS and follows the SURFACE-PAIR count:
  // n air-glass surfaces admit n(n−1)/2 two-surface reflection paths and n = 2 × the
  // group count. That is why the many-group zoom shows the longest chain in the set
  // while each of its ghosts is far fainter than an uncoated prime's.
  {
    name: "Modern Prime",
    description: "Modern multicoated cine prime — the cleanest era: faint veiling glare, a short tight ghost chain, and the crisp 18-point star of a nine-leaf iris.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.28, ghostSize: 0.075, ghostIntensity: 0.2,
      anamorphic: 0, streakLength: 0.4, streakColor: "#8fb0ff",
      halo: 0.2, haloRadius: 0.34,
      starburst: 0.26, blades: 9, starburstSharp: 26, starburstRotation: 0,
      chromatic: 0.006, glow: 0.45, dirt: 0.05, colorTemp: 5600, tint: "#f2f7f2",
    },
  },
  {
    name: "Zoom Ghost Chain",
    description: "A many-group zoom: twice a prime's air-glass surfaces, so the longest ghost chain in the set — each ghost closer, fainter and sitting in more veiling haze.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 8, ghostSpacing: 0.15, ghostSize: 0.075, ghostIntensity: 0.36,
      anamorphic: 0, streakLength: 0.4, streakColor: "#8fb0ff",
      halo: 0.1, haloRadius: 0.55,
      starburst: 0.22, blades: 9, starburstSharp: 28, starburstRotation: 0,
      chromatic: 0.02, glow: 0.6, dirt: 0.12, colorTemp: 5600, tint: "#f0f6f1",
    },
  },
  {
    name: "Seventies Fast Prime",
    description: "A fast seventies prime on a six-blade iris: the hard six-point star of that era, fat close ghosts, and the milkier glare of pre-modern coatings.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.3, ghostSize: 0.14, ghostIntensity: 0.3,
      anamorphic: 0, streakLength: 0.4, streakColor: "#f0f6f2",
      halo: 0.22, haloRadius: 0.45,
      starburst: 0.45, blades: 6, starburstSharp: 35, starburstRotation: 0,
      chromatic: 0.025, glow: 0.9, dirt: 0.2, colorTemp: 5600, tint: "#f0f6f2",
    },
  },
  {
    name: "Single-Coated Classic",
    description: "Single-layer coating: the purple residual reflection that era is known for, over roughly twice a modern lens's veiling glare. The only violet-cast look in the set.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.3, ghostSize: 0.12, ghostIntensity: 0.26,
      anamorphic: 0, streakLength: 0.4, streakColor: "#e2cdee",
      halo: 0.3, haloRadius: 0.5,
      starburst: 0.2, blades: 13, starburstSharp: 8, starburstRotation: 0,
      chromatic: 0.035, glow: 1.1, dirt: 0.25, colorTemp: 5600, tint: "#e2cdee",
    },
  },
  {
    name: "Uncoated Vintage",
    description: "Uncoated glass on a tungsten source: a broadband white residual, the biggest and brightest ghosts here, and about four times a modern lens's glare washing the frame.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 3, ghostSpacing: 0.26, ghostSize: 0.2, ghostIntensity: 0.38,
      anamorphic: 0, streakLength: 0.4, streakColor: "#ffffff",
      halo: 0.4, haloRadius: 0.62,
      starburst: 0.16, blades: 15, starburstSharp: 5, starburstRotation: 0,
      chromatic: 0.07, glow: 2.2, dirt: 0.4, colorTemp: 3200, tint: "#ffffff",
    },
  },
  // ── THE ANAMORPHIC PAIR ─────────────────────────────────────────────────────
  // Both hold `starburst` near ZERO, and that value is right for TWO INDEPENDENT
  // reasons: a real anamorphic iris is round and high-blade-count, so it barely stars
  // at all; AND our starburst is angularly ISOTROPIC, so a desqueezed star would be
  // rendered wrong if they did star (render_gpu/skia/lens_flare_shader.js, "KNOWN
  // BOUND: THE STARBURST IS ANGULARLY ISOTROPIC"). Whichever reason a future editor
  // discards, the other still holds the value down.
  {
    name: "Anamorphic Blue",
    description: "The signature blue horizontal bar of a front anamorphic: a long cool streak over a round high-blade-count iris that barely stars at all.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.3, ghostSize: 0.07, ghostIntensity: 0.2,
      anamorphic: 1.2, streakLength: 1.2, streakColor: "#3d6cff",
      halo: 0.12, haloRadius: 0.3,
      starburst: 0.05, blades: 14, starburstSharp: 24, starburstRotation: 0,
      chromatic: 0.01, glow: 0.6, dirt: 0.18, colorTemp: 6500, tint: "#eef2f8",
    },
  },
  {
    name: "Anamorphic Gold",
    description: "The warm-streak rehousing look: the same bar in gold, with larger ghosts and more haze than the blue — older, dirtier anamorphic glass.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.28, ghostSize: 0.1, ghostIntensity: 0.26,
      anamorphic: 1.2, streakLength: 1.1, streakColor: "#ff9e3d",
      halo: 0.2, haloRadius: 0.5,
      starburst: 0.1, blades: 14, starburstSharp: 14, starburstRotation: 0,
      chromatic: 0.03, glow: 0.9, dirt: 0.28, colorTemp: 5600, tint: "#ffe9c8",
    },
  },
  // ── SOURCES AND FRONT-ELEMENT STATES (the rest) ─────────────────────────────
  // Past the anamorphic pair the ordering axis changes: these five vary the LIGHT
  // (its temperature, its aperture) and the state of the FRONT ELEMENT, not the
  // coating, so they carry no ladder and no order of their own.
  {
    name: "Sodium Street Lamp",
    description: "A low-pressure sodium street lamp: a near-monochromatic ~1800 K source, so a deep amber flare with no dispersion at all to split at the iris edges.",
    props: {
      brightness: 0.9, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.2, ghostSize: 0.065, ghostIntensity: 0.3,
      anamorphic: 0, streakLength: 0.4, streakColor: "#fff3e6",
      halo: 0.14, haloRadius: 0.22,
      starburst: 0.4, blades: 7, starburstSharp: 20, starburstRotation: 0,
      chromatic: 0, glow: 0.85, dirt: 0.3, colorTemp: 1800, tint: "#fdf6ee",
    },
  },
  {
    name: "Stopped-Down Sunstar",
    description: "The sun stopped well down: a hairline ten-point star takes over the frame while the ghosts, halo and glare all pull back.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.34, ghostSize: 0.07, ghostIntensity: 0.14,
      anamorphic: 0, streakLength: 0.4, streakColor: "#f7f9f5",
      halo: 0.06, haloRadius: 0.28,
      starburst: 0.7, blades: 10, starburstSharp: 80, starburstRotation: 0,
      chromatic: 0.01, glow: 0.4, dirt: 0.1, colorTemp: 5600, tint: "#f7f9f5",
    },
  },
  {
    name: "Sun Through Windshield",
    description: "Sun through a dirty windshield: grime breaking up a wide soft veil, and fat unfocused rays instead of spikes — scatter off the glass, not diffraction at the iris.",
    props: {
      brightness: 1.1, blendMode: "screen",
      ghostCount: 3, ghostSpacing: 0.3, ghostSize: 0.13, ghostIntensity: 0.25,
      anamorphic: 0, streakLength: 0.4, streakColor: "#eef6ea",
      halo: 0.35, haloRadius: 0.8,
      starburst: 0.4, blades: 8, starburstSharp: 1.5, starburstRotation: 0,
      chromatic: 0.04, glow: 2.4, dirt: 1.0, colorTemp: 5600, tint: "#eef6ea",
    },
  },
  {
    name: "Stage Followspot",
    description: "A tungsten followspot, additively blended: a hot punchy source with a tight halo and a clean eight-point star.",
    props: {
      brightness: 1.1, blendMode: "add",
      ghostCount: 3, ghostSpacing: 0.24, ghostSize: 0.06, ghostIntensity: 0.2,
      anamorphic: 0, streakLength: 0.4, streakColor: "#f4f8f4",
      halo: 0.16, haloRadius: 0.3,
      starburst: 0.55, blades: 8, starburstSharp: 30, starburstRotation: 0,
      chromatic: 0.015, glow: 1.1, dirt: 0.15, colorTemp: 3200, tint: "#f4f8f4",
    },
  },
  {
    name: "Security IR Camera",
    description: "A small-sensor security camera: no star at all, a large soft halo, grubby glass and a cool cast — the look of footage nobody cleaned the lens for.",
    props: {
      brightness: 1.1, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.22, ghostSize: 0.09, ghostIntensity: 0.34,
      anamorphic: 0, streakLength: 0.4, streakColor: "#dfe8e2",
      halo: 0.3, haloRadius: 0.45,
      starburst: 0, blades: 8, starburstSharp: 18, starburstRotation: 0,
      chromatic: 0, glow: 1.1, dirt: 0.5, colorTemp: 6500, tint: "#dfe8e2",
    },
  },
];

export const lensFlarePlugin = {
  type: "demo_lens_flare",
  title: "Lens Flare",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  presets: PRESETS,
  defaults: {
    // DEFAULT SIZE BOUND TO THE CAMERA: a freshly-inserted flare FILLS the view.
    // THE CAMERA is the singleton purgeable:false item named "Camera" ⇒ stable slug
    // "camera" (slugMap), so these `=` equations resolve to its rect through the
    // ordinary prop-reference path AND track it if the camera later moves/zooms. A
    // wide box never squishes the flare — the shader is aspect-correct (isotropic).
    // (Inserted via app.addItem, NOT crosshair placement: the click-places-default
    // path does arithmetic on defaults.w, which is an equation here — App.svelte.)
    type: "demo_lens_flare",
    x: "= camera.x", y: "= camera.y", w: "= camera.w", h: "= camera.h",
    z: 200, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("opacity"), // opacity:1
    // The EFFECTS BUNDLE gives the additive composite: default blendMode "screen"
    // (overrides the registry's "normal") so the flare adds light to the scene; the
    // rest of the bundle stays effect-off (shadow/bloom/innerShadow) — that bloom is
    // a vector-glow substrate, distinct from this flare's own in-shader bloom knob.
    ...bundleNestedDefaults("effects"),
    blendMode: "screen",
    ...CUSTOM.defaults, // the look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("opacity"),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
    ...bundle("effects"), // blend mode + (unused-by-default) shadow/bloom/inner-shadow
  ],
  /**
   * Pure function. State → display-list: ONE materialFill op naming the "lens_flare"
   * material, WRAPPED in the effects bundle (render_gpu/effects.js applyEffects) so
   * the default blendMode "screen" composites the flare additively over the scene.
   * The bbox (w, h) IS the region (local space; sceneIR wraps it in the node's
   * world). The look knobs pass through as the op's `params`; the SkSL packer
   * clamps/parses them. `world` (emit's 3rd arg) is required by applyEffects.
   */
  emit(s, _targetWorldIR, world) {
    const op = materialFill({
      material: "lens_flare",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: 0,
      params: {
        lightX: s.lightX, lightY: s.lightY, brightness: s.brightness, flareScale: s.flareScale,
        ghostCount: s.ghostCount, ghostSpacing: s.ghostSpacing, ghostSize: s.ghostSize, ghostIntensity: s.ghostIntensity,
        anamorphic: s.anamorphic, streakLength: s.streakLength, streakColor: s.streakColor,
        halo: s.halo, haloRadius: s.haloRadius,
        starburst: s.starburst, blades: s.blades, starburstSharp: s.starburstSharp, starburstRotation: s.starburstRotation,
        chromatic: s.chromatic, bloom: s.glow, dirt: s.dirt,
        colorTemp: s.colorTemp, tint: s.tint,
      },
      opacity: s.opacity ?? 1,
    });
    return applyEffects([op], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  snapFeatures(s) {
    return [
      { kind: "point", x: s.w / 2, y: s.h / 2, id: "center" },
      { kind: "point", x: lightLocal(s).x, y: lightLocal(s).y, id: "light" },
    ];
  },
  /**
   * Pure function. Standard bbox anchors PLUS a live "light" anchor at the light
   * source (lightX/lightY → local px). The id is underscore-free so the reference
   * grammar (`@item_anchor.x`, split at the LAST underscore) parses it — other
   * widgets can bind to where the flare's light is via `@<slug>_light.x/.y`.
   */
  anchors(state) {
    const l = lightLocal(state);
    return [...standardBBoxAnchors(state), { id: "light", x: l.x, y: l.y }];
  },
  /**
   * Pure function. TWO yellow-square MODIFIER POINTS (the "PPT yellow squares",
   * core/derive.js nodeModifierPoints) — the flare's two on-canvas gestures, one for
   * WHERE the light is and one for HOW BIG its features are.
   *
   * "light" — at the light source. Dragging it writes lightX/lightY = the drag's
   * LOCAL point ÷ the box extent, UNCLAMPED: the handle follows the cursor anywhere,
   * including far outside the widget, because an off-box light source is the entire
   * point of an off-frame sun. (It used to clamp the fractions to [0,1], which pinned
   * the handle to the border and silently discarded the drag.) It mirrors the analog
   * clock's hand-tip handles.
   *
   * "scale" — the FEATURE SCALE, a RADIAL control on the optical centre (the widget
   * centre, which is what every scaled feature is measured from). It sits at 3
   * o'clock, `scaleHandleArm × flareScale` local px out — the DONUT's inner-rim
   * convention exactly, matching the east resize handle — and its DISTANCE from the
   * centre IS the value, so at flareScale 1 it lands on the default halo ring and
   * dragging it literally resizes the rings. `apply` projects onto that one
   * horizontal axis (the y-component is ignored BY DESIGN: "a modifier point's
   * trajectory is intentionally restricted"), so the handle tracks the cursor's x
   * exactly, like the donut's.
   *
   * The scale handle is listed SECOND so the overlay draws it ON TOP: the two only
   * coincide at flareScale 0 with the light dead-centre, and there the one that must
   * stay grabbable is the scale (otherwise a collapsed flare could never be dragged
   * back open on canvas, while the light is always still reachable in the Inspector).
   *
   * The `w/h > 0` guards are TECHNICAL (division by the box extent / by the handle's
   * arm), not a bound on any value: a zero-extent box has no fraction to compute, so
   * each `apply` keeps the existing value rather than returning NaN. `Math.max(0, …)`
   * on the scale is the SAME technical floor its row declares (a size cannot be
   * negative, and the shader's own guard would silently swallow a negative one).
   * CanvasView draws/hit-tests both in world space and inverts the drag back through
   * node.world, so rotation is handled for us.
   */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const l = lightLocal(s);
    return [{
      id: "light",
      x: l.x, y: l.y,
      apply(state, localPoint) {
        const ww = state.w ?? 0, hh = state.h ?? 0;
        return {
          lightX: ww > 0 ? localPoint.x / ww : (state.lightX ?? 0.5),
          lightY: hh > 0 ? localPoint.y / hh : (state.lightY ?? 0.5),
        };
      },
    }, {
      id: "scale",
      x: w / 2 + scaleHandleArm(s) * (s.flareScale ?? 1),
      y: h / 2,
      apply(state, localPoint) {
        const arm = scaleHandleArm(state);
        if (arm <= 0) return { flareScale: state.flareScale ?? 1 };
        return { flareScale: Math.max(0, (localPoint.x - (state.w ?? 0) / 2) / arm) };
      },
    }];
  },
  // NO top-level `commands`: reached ONLY via the "Insert Demo Widget" submenu.
};
