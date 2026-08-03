/**
 * CORKBOARD family — four DEMO WIDGETS (plugins/demo/, the showcase folder) that
 * introduce the FOREGROUND half of the MATERIAL FRAMEWORK: skeuomorphic, lightweight-
 * 3D cork, paper, pins and yarn drawn as SkSL height-field fills (design.md under
 * `.frenzy/corkboard/`). Three of them (board, note, thumbtack) emit ONE
 * `materialFill` op each, naming a `backdrop: false` material in
 * render_gpu/skia/corkboard_shader.js; the fourth (yarn) is an ordinary
 * two-endpoint connector emitting stroked `path` ops (the pseudo-3D lives only in
 * the shaded fills — a cord is just a curve).
 *
 * PSEUDO-3D, NO 3D: every solid object is a HEIGHT FIELD lit by ONE directional
 * light (uLightDir, upper-left) evaluated per pixel in the shader — domes bulge,
 * pins press in, paper curls and self-shadows, all as flat 2D draws that composite +
 * CLI-export through the exact path glass/CRT use. Contact/drop shadows are ordinary
 * blurred Skia shapes drawn beneath (the materialFill `shadow` descriptor / the yarn
 * shadow `path`); the note-curl SELF shadow is the one shadow that lives in-shader.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism): a literal, an expression, or a `= …` equation, with ZERO
 * engine changes (the framework carries params straight to the SkSL uniforms). The
 * flagship animations ALL fall out of the existing keyframe/equation machinery:
 * pressing a tack in (domeGain↓) flattens its dome AND shrinks its contact shadow
 * AND — because the yarn endpoints bind to tack anchors — MOVES the yarn; a note
 * curls (curlAmount 0→1) with its self shadow growing.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). Defined in
 * ONE file exporting an ARRAY (the shapeshifter.js / text_morph.js precedent) — the
 * three material widgets share a factory. No plugin imports another (composition is
 * via anchors + document state: the yarn references tack anchors by equation).
 * DOM-free / bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { morphPayloadFromConnector } from "../../core/morph_payload.js";
import { closestPointOnRoundedRect } from "../../core/outline.js";
import * as T from "../../core/transform.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialFill, path, parseColor, BLUR_SUPPORT_SIGMAS } from "../../render_gpu/ir.js";
// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (corkboard_shader.CORK_FILL_PARAMS /
// TACK_FILL_PARAMS — the fill-material framework's single-declaration rule: "custom
// properties become material properties"). Each widget spreads that SAME schema into
// its customProps and adds only its widget-side keys (the region cornerRadius). The
// family's shared light angle lives there too, beside the schema that defaults to it.
import { CORK_FILL_PARAMS, TACK_FILL_PARAMS, FAMILY_LIGHT_ANGLE } from "../../render_gpu/skia/corkboard_shader.js";
// paddedPointsBBox: the arrow family's effect-bounds helper (arrow.js /
// elbow_arrow.js / fancy_arrow.js import it the same way). corkboardYarn has no
// bbox — it is a sagging curve between two thumbtacks — so it declares
// effectBounds to say where its effect substrate lives.
import { paddedPointsBBox } from "../../render_gpu/effects.js";
import { endpointPairHooks, hitsShaft, ARROW_STROKE_WIDTH } from "../../core/endpoints.js";

// Corner selector for the note curl: each component ±1 picks a corner (y-down, so
// top = -1). corner = (dir.x·halfW, dir.y·halfH).
const CURL_CORNERS = { TL: [-1, -1], TR: [1, -1], BL: [-1, 1], BR: [1, 1] };
const CURL_CORNER_OPTIONS = ["TL", "TR", "BL", "BR"];
const CURL_CORNER_LABELS = { TL: "Top-left", TR: "Top-right", BL: "Bottom-left", BR: "Bottom-right" };

/**
 * Pure function. The SHADOW direction (unit screen vector) for a light angle — the
 * family's shadows fall OPPOSITE the light (design Part 3: SHADOW_DIR = −uLightDir).
 *
 * @param {number} lightAngle - radians, direction TO the light
 * @returns {[number, number]} unit vector pointing where shadows fall (down-right by default)
 *
 * @example shadowDir(0) // [-1, -0] (light to the right => shadow to the left)
 */
function shadowDir(lightAngle) {
  return [-Math.cos(lightAngle), -Math.sin(lightAngle)];
}

/**
 * Pure function. Lightens a CSS colour toward white and re-alphas it — used for the
 * yarn's cylindrical top-highlight sheen (a brighter, semi-transparent copy of the
 * cord colour). parseColor is the shared node-safe hex/rgb() parser.
 *
 * @param {string} color - any parseColor-able colour
 * @param {number} add - amount (0..1) added to each channel, clamped at 1
 * @param {number} alpha - the highlight's alpha (0..1)
 * @returns {string} an "rgba(r,g,b,a)" string
 *
 * @example lightenCss("#c81e1e", 0.27, 0.6) // "rgba(269->255,...)" a pale-red sheen
 */
function lightenCss(color, add, alpha) {
  const c = parseColor(color);
  const byte = (v) => Math.round(Math.min(1, v + add) * 255);
  return `rgba(${byte(c[0])},${byte(c[1])},${byte(c[2])},${alpha})`;
}

// ── shared factory for the three bbox MATERIAL widgets (board, note, tack) ──────
/**
 * Pure function (factory). Builds one bbox widget that emits a SINGLE materialFill
 * op. The three material widgets are the same skeleton (positioning + opacity +
 * their custom look knobs) differing only in: which registered material they name,
 * their knob set, how their params + optional soft shadow are computed, their
 * corner radius, and their anchors/hit test.
 *
 * @param {object} cfg
 * @param {string} cfg.type - widget type id (e.g. "corkboardNote")
 * @param {string} cfg.title - human title (Inspector + submenu)
 * @param {string} cfg.material - registered material id (corkboard_shader.js)
 * @param {object} cfg.positioning - default {x,y,w,h,z}
 * @param {object} cfg.custom - a customProps() result ({rows, defaults})
 * @param {(s: object) => object} cfg.toParams - state → the material's flat knob map
 * @param {(s: object) => number} cfg.cornerRadius - state → WORLD-px corner radius
 * @param {(s: object) => (object|null)} [cfg.toShadow] - state → materialFill shadow descriptor
 * @param {(s: object) => object[]} [cfg.anchors] - anchors fn (default standard bbox)
 * @param {boolean} [cfg.disk] - hit-test as a disk (the thumbtack) instead of the bbox
 * @returns {object} a plugin object
 */
function makeMaterialWidget(cfg) {
  return {
    type: cfg.type,
    title: cfg.title,
    // Declared in the FACTORY so all four corkboard widgets inherit it and a
    // fifth cannot be added without one. These are SkSL material fills evaluated
    // per pixel from their own knobs — no cheap tier, no async source.
    ephemeral: EPHEMERAL.NONE,
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    defaults: {
      type: cfg.type, ...cfg.positioning, rotation: 0, scale: 1,
      rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
      ...defaults("opacity"), // opacity:1
      ...cfg.custom.defaults, // the look knobs (self.*)
    },
    inspector: [
      ...bundle("transform"),
      ...props("opacity"),
      ...cfg.custom.rows, // the look knobs (Inspector "Custom" region)
    ],
    /**
     * Pure function. State → ONE materialFill op. The bbox (w, h) IS the region;
     * cx/cy/halfW/halfH are the local box (sceneIR wraps them in the node's world).
     */
    emit(s) {
      return [materialFill({
        material: cfg.material,
        cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
        cornerRadius: cfg.cornerRadius(s),
        params: cfg.toParams(s),
        shadow: cfg.toShadow ? cfg.toShadow(s) : null,
        opacity: s.opacity ?? 1,
      })];
    },
    hitTest(s, lx, ly) {
      if (cfg.disk) {
        const rx = s.w / 2, ry = s.h / 2, nx = (lx - rx) / rx, ny = (ly - ry) / ry;
        return nx * nx + ny * ny <= 1;
      }
      return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
    },
    snapFeatures(s) {
      return [{ kind: "point", x: s.w / 2, y: s.h / 2, id: "center" }];
    },
    // THE RIM OF WHAT emit() PAINTS — a disk's ellipse, or the ROUNDED region the
    // materialFill above draws with cfg.cornerRadius. Declaring it here gives all
    // three of this file's widgets a rim at once: `closest_to_rim` accepts them
    // for the first time, and THE INK RULE (core/derive.js withInkAnchors) slides
    // their bbox CORNER anchors onto the painted silhouette instead of leaving
    // them in the empty corners around a round thumbtack head — four of nine were
    // off the ink there.
    //
    // It reads cornerRadius where hitTest above does not, and that is deliberate,
    // not drift: an anchor's job is to be ON THE INK, and the ink has rounded
    // corners because emit() rounds them. (hitTest's square test at those corners
    // is a pre-existing looseness in the GRAB region, which is a different
    // question — a slightly generous grab is kind; a misplaced anchor is a lie.)
    // The disk case uses the ellipse convention circle.js documents: radial in the
    // normalized frame, exact when w === h.
    closestAnchor(s, wx, wy, world) {
      const local = T.apply(T.invert(world), wx, wy);
      const rx = (s.w ?? 0) / 2, ry = (s.h ?? 0) / 2;
      if (!cfg.disk) return closestPointOnRoundedRect(s.w ?? 0, s.h ?? 0, cfg.cornerRadius(s), local.x, local.y);
      const theta = Math.atan2((local.y - ry) / ry, (local.x - rx) / rx);
      return { x: rx + rx * Math.cos(theta), y: ry + ry * Math.sin(theta) };
    },
    anchors: cfg.anchors ?? standardBBoxAnchors,
    // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
  };
}

// ── CORKBOARD (the board) ───────────────────────────────────────────────────────
// The look knobs come from the shader entry (CORK_FILL_PARAMS); the widget adds only
// its region cornerRadius (GEOMETRY — kept widget-side, exactly as the comic exemplar
// keeps its cornerRadius). The fill-material path resolves that same schema itself.
const CORK_CUSTOM = customProps([
  ...CORK_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 30, min: 0, help: "Rounded-corner radius of the board (world px)." },
]);

const corkboardPlugin = makeMaterialWidget({
  type: "corkboard",
  title: "Corkboard",
  material: "corkboard",
  positioning: { x: 80, y: 80, w: 900, h: 640, z: 0 },
  custom: CORK_CUSTOM,
  cornerRadius: (s) => s.cornerRadius,
  toParams: (s) => ({
    seed: s.seed, grainScale: s.grainScale, mottleScale: s.mottleScale,
    mottleStrength: s.mottleStrength, pitStrength: s.pitStrength, fleckStrength: s.fleckStrength,
    baseColor: s.baseColor, vignette: s.vignette,
    frameWidth: s.frameWidth, frameColor: s.frameColor, lightAngle: s.lightAngle,
  }),
});

// ── CORKBOARD NOTE (sticky / loose-leaf paper) ──────────────────────────────────
const NOTE_SHADOW_CURL_GAIN = 0.6; // a curled note lifts, casting a larger/softer drop shadow (× this × curlAmount)
const NOTE_SHADOW_GROW = 0;        // the note's drop shadow matches its footprint (no growth)

const NOTE_CUSTOM = customProps([
  { name: "paperColor", kind: "color", default: "rgb(248,246,238)", help: "The paper's colour — warm white (loose-leaf) or canary yellow (a sticky note)." },
  { name: "ruleSpacing", kind: "number", default: 26, min: 0, help: "Distance (world px) between the ruled horizontal lines. 0 = unruled." },
  { name: "ruleStrength", kind: "number", default: 0.5, min: 0, max: 1, help: "Darkness of the ruled lines (their 'ink' opacity)." },
  { name: "ruleColor", kind: "color", default: "rgb(120,150,190)", help: "The ruled-line ink colour — pale blue-grey." },
  { name: "marginX", kind: "number", default: 34, help: "Distance (world px) from the left edge to the red vertical margin line. Negative = no margin." },
  { name: "marginColor", kind: "color", default: "rgb(200,90,90)", help: "The vertical margin line's colour — red." },
  { name: "holeRadius", kind: "number", default: 0, min: 0, help: "Radius (world px) of the loose-leaf punched holes along the top edge. 0 = no holes (the cork shows through the holes)." },
  { name: "holeSpacing", kind: "number", default: 60, min: 0, help: "Distance (world px) between punched-hole centres." },
  { name: "holeInset", kind: "number", default: 22, min: 0, help: "Distance (world px) from the top edge down to the hole-centre row." },
  { name: "ripStrength", kind: "number", default: 12, min: 0, help: "Amplitude (world px) of the ragged/ripped left edge (torn from a pad). 0 = a clean edge." },
  { name: "ripScale", kind: "number", default: 0.1, min: 0, help: "Frequency (cycles per world unit) of the ragged-edge noise. Higher = finer tears." },
  { name: "curlAmount", kind: "number", default: 0, min: 0, max: 1, help: "How far the corner has curled up, 0..1. ANIMATE this (keyframe 0→1) to peel the corner after pinning; its self-shadow grows with it." },
  { name: "curlSize", kind: "number", default: 150, min: 0, help: "Maximum diagonal reach (world px) of the curling corner region at curlAmount 1." },
  { name: "curlCorner", kind: "select", default: "TR", options: CURL_CORNER_OPTIONS, optionLabels: CURL_CORNER_LABELS, help: "Which corner curls up." },
  { name: "cornerRadius", kind: "number", default: 4, min: 0, help: "The paper's own (small) rounded-corner radius (world px)." },
  { name: "seed", kind: "number", default: 3, help: "Texture/rip seed — changes the fibre + ragged-edge pattern deterministically." },
  { name: "shadowStrength", kind: "number", default: 0.32, min: 0, max: 1, help: "Darkness of the soft drop shadow the note casts on the board." },
  { name: "shadowBlur", kind: "number", default: 16, min: 0, help: "Softness (world-px blur) of that drop shadow." },
  { name: "shadowOffset", kind: "number", default: 12, min: 0, help: "How far (world px) the drop shadow is offset from the note, opposite the light." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: FAMILY_LIGHT_ANGLE, help: "Direction TO the light (screen space). Shared with the family; drives ruling shade, curl lighting, and shadow direction." },
]);

const corkboardNotePlugin = makeMaterialWidget({
  type: "corkboardNote",
  title: "Corkboard Note",
  material: "corkboardNote",
  positioning: { x: 220, y: 200, w: 340, h: 420, z: 10 },
  custom: NOTE_CUSTOM,
  cornerRadius: (s) => s.cornerRadius,
  toParams: (s) => ({
    seed: s.seed, paperColor: s.paperColor, lightAngle: s.lightAngle,
    ruleSpacing: s.ruleSpacing, ruleStrength: s.ruleStrength, ruleColor: s.ruleColor,
    marginX: s.marginX, marginColor: s.marginColor,
    holeRadius: s.holeRadius, holeSpacing: s.holeSpacing, holeInset: s.holeInset,
    ripStrength: s.ripStrength, ripScale: s.ripScale,
    curlAmount: s.curlAmount, curlSize: s.curlSize,
    curlDir: CURL_CORNERS[s.curlCorner] ?? CURL_CORNERS.TR,
  }),
  toShadow: (s) => {
    const sdir = shadowDir(s.lightAngle);
    const lift = 1 + NOTE_SHADOW_CURL_GAIN * (s.curlAmount ?? 0); // a curled note lifts => a bigger, softer shadow
    const off = (s.shadowOffset ?? 0) * lift;
    return { dx: sdir[0] * off, dy: sdir[1] * off, blur: (s.shadowBlur ?? 0) * lift, alpha: s.shadowStrength ?? 0, grow: NOTE_SHADOW_GROW };
  },
});

// ── CORKBOARD THUMBTACK (a pin) ─────────────────────────────────────────────────
// The head fills the (square) bbox; resize handles resize the pin. Contact-shadow
// size/offset/darkness scale with domeGain (press-in DEPTH): a PROUD tack stands
// off the board and casts a larger, more-offset, darker shadow than a PRESSED-IN one.
const TACK_SHADOW_OFF_BASE = 0.10, TACK_SHADOW_OFF_GAIN = 0.55;  // offset as radius·(base + gain·proud)
const TACK_SHADOW_BLUR_BASE = 0.30, TACK_SHADOW_BLUR_GAIN = 0.40; // blur sigma as radius·(...)
const TACK_SHADOW_GROW_BASE = 0.05, TACK_SHADOW_GROW_GAIN = 0.14; // grow as radius·(...)
const TACK_SHADOW_A_BASE = 0.30, TACK_SHADOW_A_GAIN = 0.14;      // alpha = base + gain·proud

// The tack's four look knobs live in the shader entry (TACK_FILL_PARAMS — an identity
// fill schema). No widget-side geometry knob: the head is a DISK (cornerRadius is
// derived below), and the contact shadow is a widget-side descriptor, not a knob.
const TACK_CUSTOM = customProps(TACK_FILL_PARAMS);

const corkboardThumbtackPlugin = makeMaterialWidget({
  type: "corkboardThumbtack",
  title: "Corkboard Thumbtack",
  material: "corkboardThumbtack",
  positioning: { x: 380, y: 176, w: 44, h: 44, z: 30 },
  custom: TACK_CUSTOM,
  disk: true,
  cornerRadius: (s) => Math.min(s.w, s.h) / 2, // a disk (the round head)
  // The head centre is BOTH the standard center anchor and a named "head" anchor —
  // the yarn attach / contact point (design Part 4: `= tackA.anchors.head`).
  anchors: (s) => [...standardBBoxAnchors(s), { id: "head", x: (s.w ?? 0) / 2, y: (s.h ?? 0) / 2 }],
  toParams: (s) => ({ domeGain: s.domeGain, color: s.color, shininess: s.shininess, lightAngle: s.lightAngle }),
  toShadow: (s) => {
    const sdir = shadowDir(s.lightAngle);
    const proud = s.domeGain ?? 0;
    const radius = (s.w ?? 0) / 2; // world px
    const off = radius * (TACK_SHADOW_OFF_BASE + TACK_SHADOW_OFF_GAIN * proud);
    return {
      dx: sdir[0] * off, dy: sdir[1] * off,
      blur: radius * (TACK_SHADOW_BLUR_BASE + TACK_SHADOW_BLUR_GAIN * proud),
      alpha: TACK_SHADOW_A_BASE + TACK_SHADOW_A_GAIN * proud,
      grow: radius * (TACK_SHADOW_GROW_BASE + TACK_SHADOW_GROW_GAIN * proud),
    };
  },
});

// ── CORKBOARD YARN (connecting string) ──────────────────────────────────────────
// A two-endpoint connector (the arrow family's endpoint plumbing). Endpoints bind
// by equation to tack head anchors (`= @<tackId>_head.x/y`) so a moved/pressed tack
// drags the yarn. Renders as three strokes: a soft blurred cast SHADOW, the round
// CORD, and a thin top HIGHLIGHT (cylindrical sheen). Sags via a quadratic Bézier
// whose control point is pulled DOWN by gravity·span (design Part 5).
const YARN_SHADOW_ALPHA = 0.28;      // darkness of the yarn's soft cast shadow
const YARN_SHADOW_WIDTH_FRAC = 0.95; // shadow stroke width as a fraction of the cord width
const YARN_SHADOW_OFF_FRAC = 0.9;    // shadow offset (along the light-opposite dir) as × cord width
const YARN_SHADOW_DROP_FRAC = 0.45;  // extra straight-down shadow drop as × cord width
const YARN_SHADOW_BLUR_FRAC = 0.7;   // shadow blur sigma as × cord width
const YARN_HL_WIDTH_FRAC = 0.34;     // highlight stroke width as a fraction of the cord width
const YARN_HL_LIFT_FRAC = 0.28;      // highlight offset UP the cord (toward the viewer/light) as × cord width
const YARN_HL_LIGHTEN = 0.27;        // channel lift toward white for the highlight colour
const YARN_HL_ALPHA = 0.6;           // highlight alpha

/**
 * Pure function. The LOCAL rect the yarn's INK occupies: the AABB of its two
 * endpoints plus the sag control point (a quadratic never leaves the hull of its
 * three points), padded by the cord width and the widget's OWN shadow offset +
 * blur. World == identity for a connector, so this is also its world footprint.
 *
 * ONE ink rect, THREE consumers (the plugins/polygon.js polygonInkRect
 * precedent): `effectBounds` (where the universal effects substrate lives),
 * `localBounds` (core/view.js localBoundsOf — culling and rubber-band selection),
 * and nothing else needs to know how a sagging cord is shaped.
 *
 * The self-drawn shadow is part of this widget's INK, not an effect halo: the
 * cord paints its own drop shadow as a third path op, so its offset and blur
 * belong inside these bounds. The universal effects bundle's halo is separate and
 * rides on the injected `cullMargin` (core/registry.withUniversalEffects).
 *
 * @param {object} s - folded, equation-evaluated item state (from / to / gravity / width)
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example // a taut (gravity 0) 7-wide cord: the endpoint hull plus the shadow pad
 * @example yarnInkRect({from: {x: 0, y: 0}, to: {x: 100, y: 0}, gravity: 0, width: 7}) // {x: -31.15, y: -31.15, w: 162.3, h: 62.3}
 * @example // sag pulls the bottom edge down: gravity 0.2 over a 100 span sinks the control point 40
 * @example yarnInkRect({from: {x: 0, y: 0}, to: {x: 100, y: 0}, gravity: 0.2, width: 7}).h // 102.3
 */
function yarnInkRect(s) {
  const { from, to } = s;
  const width = s.width ?? ARROW_STROKE_WIDTH;
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const ctrl = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 2 * (s.gravity ?? 0) * span };
  const pad = width * (1 + YARN_SHADOW_OFF_FRAC + YARN_SHADOW_DROP_FRAC + BLUR_SUPPORT_SIGMAS * YARN_SHADOW_BLUR_FRAC);
  return paddedPointsBBox([from, to, ctrl], pad);
}

const corkboardYarnPlugin = {
  type: "corkboardYarn",
  // A LITERAL, not made by makeMaterialWidget — so it declares for itself. Sagging
  // yarn is a catenary drawn as vector strokes: no cheap tier, no async source.
  ephemeral: EPHEMERAL.NONE,
  title: "Corkboard Yarn",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "corkboardYarn", z: 20,
    from: { x: 400, y: 200 }, to: { x: 700, y: 320 },
    gravity: 0.14, color: "rgb(200,30,30)", width: 7,
    lightAngle: FAMILY_LIGHT_ANGLE, opacity: 1,
  },
  inspector: [
    ...bundle("endpoints"),
    ...props("opacity"),
    { key: "gravity", label: "Gravity", kind: "number", min: 0, category: "custom", help: "Sag coefficient: the string dips by gravity × span at its midpoint. 0 = taut/straight; higher = a deeper conspiracy-board droop." },
    { key: "color", label: "Cord color", kind: "color", category: "custom", help: "The yarn colour — classic conspiracy red." },
    { key: "width", label: "Cord width", kind: "number", min: 0, category: "custom", help: "Thickness (world px) of the cord." },
    { key: "lightAngle", label: "Light angle", kind: "angle", display: "degrees", category: "custom", help: "Direction TO the light. Places the cord's shadow and top sheen." },
  ],
  /**
   * Pure function. State → three stroked `path` ops (shadow, cord, highlight). The
   * cord is a quadratic from→to whose control point sinks the curve midpoint by
   * gravity·span (design Part 5: C = (mid, midY + 2·gravity·span)). The shadow is
   * the SAME curve offset opposite the light + down and mask-blurred (the new path
   * `blur` field); the highlight is a thinner, paler copy lifted toward the light.
   * World == identity (a connector), so these local commands ARE world coordinates.
   *
   * @param {object} s - folded, equation-evaluated item state
   * @returns {object[]} display-list path commands (shadow, cord, highlight)
   */
  emit(s) {
    const { from, to } = s;
    const width = s.width ?? ARROW_STROKE_WIDTH;
    const opacity = s.opacity ?? 1;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    // Quadratic control point: sink the CURVE midpoint by gravity·span. The quad
    // midpoint is ¼A + ½C + ¼B, so C_y = midY + 2·(gravity·span) drops it by that.
    const cx = mx, cy = my + 2 * (s.gravity ?? 0) * span;
    const d = (ox, oy) => `M ${from.x + ox} ${from.y + oy} Q ${cx + ox} ${cy + oy} ${to.x + ox} ${to.y + oy}`;
    const sdir = shadowDir(s.lightAngle ?? FAMILY_LIGHT_ANGLE);
    const shadowOx = sdir[0] * width * YARN_SHADOW_OFF_FRAC;
    const shadowOy = sdir[1] * width * YARN_SHADOW_OFF_FRAC + width * YARN_SHADOW_DROP_FRAC;
    return [
      path({ d: d(shadowOx, shadowOy), stroke: `rgba(0,0,0,${YARN_SHADOW_ALPHA})`, strokeWidth: width * YARN_SHADOW_WIDTH_FRAC, blur: width * YARN_SHADOW_BLUR_FRAC, opacity }),
      path({ d: d(0, 0), stroke: s.color ?? "rgb(200,30,30)", strokeWidth: width, opacity }),
      path({ d: d(0, -width * YARN_HL_LIFT_FRAC), stroke: lightenCss(s.color ?? "rgb(200,30,30)", YARN_HL_LIGHTEN, YARN_HL_ALPHA), strokeWidth: width * YARN_HL_WIDTH_FRAC, opacity }),
    ];
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the cord's CENTERLINE as ONE OPEN subpath, in its ink rect's frame — the
   * connector route (core/morph_payload.js `morphPayloadFromConnector`), because
   * this widget is boxless with ABSOLUTE endpoints exactly like the arrow family.
   *
   * THE CORD ONLY, not the shadow or the highlight. emit() draws three copies of
   * the SAME curve at three offsets — a blurred dark one behind and a paler thin
   * one lifted toward the light — and those two are LIGHTING, not shape: they
   * exist to make one cord read as round. Handing the aligner three near-identical
   * contours would pair a target's outline against a shadow, and the two extra
   * copies move with `lightAngle`, so the payload's structure would depend on a
   * lighting knob rather than on the widget's identity. The same argument
   * plugins/line.js makes for leaving its dashes out.
   *
   * ITS OWN QUADRATIC, not a resampling of it: the gravity curve is one `Q`, and
   * `pathDToSubpaths` elevates a quadratic to a cubic EXACTLY, so the payload is
   * the catenary the widget draws rather than an approximation of it.
   */
  morphPaths(s) {
    const { from, to } = s;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const cy = my + 2 * (s.gravity ?? 0) * span; // emit()'s own control point
    const width = s.width ?? ARROW_STROKE_WIDTH;
    return morphPayloadFromConnector(
      [{
        d: `M ${from.x} ${from.y} Q ${mx} ${cy} ${to.x} ${to.y}`,
        paint: { fill: null, stroke: s.color ?? "rgb(200,30,30)", strokeWidth: width, opacity: s.opacity ?? 1 },
      }],
      yarnInkRect(s),
    );
  },
  /** Pure function. Why this yarn cannot morph YET, or null — a zero-length cord
   * has no run between its endpoints, so there is nothing to pair. */
  morphNotReady(s) {
    return Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) > 0 ? null : "two distinct endpoints (this cord has zero length)";
  },
  // EFFECT BOUNDS (the hook core/registry.effectsInjectable looks for): the yarn
  // has no bbox, so without this the registry cannot give it the shared effects
  // bundle — it is the ONE widget still excluded purely for want of bounds. World
  // is identity for a connector, so it passes straight through.
  effectBounds(s, world) {
    return { bbox: yarnInkRect(s), world };
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): the same ink rect, so the
  // yarn band-selects and culls like any box widget despite having no w/h state
  // and no resize handles. cullMargin comes from the registry's effects injection.
  localBounds: yarnInkRect,
  hitTestWorld(node, wx, wy) {
    return hitsShaft(node.state, wx, wy, node.state.width ?? ARROW_STROKE_WIDTH);
  },
  // Endpoint plumbing (draggable handles, free-coordinate translation, closest-anchor
  // context) — the shared arrow-family capability (core/endpoints.js).
  ...endpointPairHooks(),
  placement: "endpoints",
  // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
};

/**
 * The corkboard family, in submenu order (back → front: board, note, tack, yarn).
 * Spread into plugins/index.js's allPlugins (the shapeshifter.js precedent).
 */
export const corkboardPlugins = [corkboardPlugin, corkboardNotePlugin, corkboardThumbtackPlugin, corkboardYarnPlugin];
