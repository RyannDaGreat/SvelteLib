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
 * NO PRESET CARRIES `lightWorldX`/`lightWorldY`. A preset describes how the light
 * SCATTERS, not where the light IS — and clobbering a position the author placed (or
 * bound to a sun with an equation) would be destructive in a way no other knob is.
 */
const PRESETS = [
  {
    name: "Subtle Morning",
    description: "Early low sun through a window: short, soft, barely-there shafts that read as atmosphere rather than as an effect. Low exposure, quick decay, a warm-white tint.",
    props: {
      samples: 48, density: 0.55, decay: 0.955, weight: 0.05, exposure: 0.05,
      threshold: 0.68, maskSoftness: 0.22, maskStrength: 1, dither: 1, tint: "#fff3df",
    },
  },
  {
    name: "Cinematic Beams",
    description: "The full anamorphic-trailer look: long beams carrying right across the frame, hot enough to bloom, keyed tightly so only the sun and the sky nearest it feed them. The default answer to 'make it look cinematic'.",
    props: {
      samples: 96, density: 0.95, decay: 0.982, weight: 0.13, exposure: 0.13,
      threshold: 0.6, maskSoftness: 0.16, maskStrength: 1, dither: 1, tint: "#ffffff",
    },
  },
  {
    name: "Dusty Window",
    description: "Hard shafts through a dusty interior: a high threshold so ONLY the window opening itself is a source, slow decay so the beams stay parallel and solid, and a slightly warm cast from the dust.",
    props: {
      samples: 80, density: 0.85, decay: 0.978, weight: 0.14, exposure: 0.11,
      threshold: 0.76, maskSoftness: 0.08, maskStrength: 1, dither: 1, tint: "#ffe6bd",
    },
  },
  {
    name: "Underwater Caustics",
    description: "Light shafts falling through water: cool blue-green, quite long, and a LOW threshold so the whole bright upper water column contributes rather than a single disc. Pair with a blue-tinted sky.",
    props: {
      samples: 88, density: 0.9, decay: 0.972, weight: 0.10, exposure: 0.12,
      threshold: 0.44, maskSoftness: 0.3, maskStrength: 1, dither: 1, tint: "#b6ecff",
    },
  },
  {
    name: "Storm Break",
    description: "The one hole in a heavy overcast: very high threshold and a tight knee, so only the blown-out gap in the cloud is a source and everything else is an occluder — which is exactly what makes a single dramatic shaft instead of a general glow.",
    props: {
      samples: 96, density: 1, decay: 0.986, weight: 0.16, exposure: 0.12,
      threshold: 0.82, maskSoftness: 0.06, maskStrength: 1, dither: 1, tint: "#f4f8ff",
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
      help: "The light's X in DOCUMENT coordinates — not a position inside this box. Bind it to a sun widget with an equation (e.g. = sun.anchors.center.x) and the beams follow it anywhere, including off the edge of the slide." },
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
