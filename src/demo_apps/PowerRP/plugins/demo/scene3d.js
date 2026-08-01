/**
 * THE 3D VIEWPORT FAMILY (R6-1 + R6-23) — a Gaussian-splat scene, and a mesh
 * scene beside it, as ordinary widgets you position, rotate, group, keyframe and
 * export. ONE file, ONE factory, an ARRAY export: the shapeshifter.js precedent
 * (2026-07-23, the oldest of the four family mechanisms in this repo, and the one
 * plugins/demo/corkboard.js:26 names as its own lineage). No plugin imports
 * another; the members share this file's factory and the render-side substrate in
 * render_gpu/gpu/scene3d_raster.js, which is the only legal sharing seam.
 *
 * ── WHY plugins/demo/ AND NOT plugins/ — A RECORDED DECISION, NOT A DRIFT ─────
 * The accepted design (manifest R6-23 DESIGN, from .frenzy/round6/W1-O.md §1.6)
 * puts this family at `plugins/scene3d.js`, arguing from R6-1.1's "an insertable
 * widget … like any other". It also wrote the escape clause this file is taking:
 * "If the lead prefers to prove it in demo/ first, that is defensible, but it
 * should be a recorded decision, not a drift." This is that record. The reasons
 * to prove it here first are concrete and temporary:
 *   1. it carries a ~1.9 MB lazily-imported third-party engine, the largest
 *      dependency in the app, and nothing else here does;
 *   2. its "live" resolution mode is not finished — see THE RESOLUTION CONTRACT
 *      below — so it does not yet meet the whole cardinal law a first-class
 *      widget is held to;
 *   3. the mesh member is declared but its glTF loader is not wired, so half the
 *      family is a stub.
 * When (2) and (3) land, this file MOVES to `plugins/` unchanged; the type ids
 * are already spelled the way it will need them (snake_case with a family
 * prefix — `pdf_page`, `graph_line`, `video_scrub`, and shapeshifter's own `ss_`
 * device). Do NOT let this become the second `magnifier.js` / `demo/magnify.js`.
 *
 * ── THE CAMERA IS PROPERTY STATE. THAT IS THE WHOLE DESIGN (R6-1.3) ──────────
 * `camTargetX/Y/Z`, `camYaw`, `camPitch`, `camRoll`, `camDistance` and `camFov`
 * are ORDINARY KEYFRAMABLE PROPERTIES — not a viewer-local camera object. The
 * consequences are the feature, and they are the same ones plugins/demo/globe_map
 * .js:16 spells out for the map:
 *   · a slide-to-slide fly-through ANIMATES, because the numbers tween like any
 *     others. Two keyframes IS a camera move;
 *   · a pose is `=`-BINDABLE: `camYaw: "= 2 * pi * progress"` is a turntable, and
 *     it costs this file nothing because an equation does not know these numbers
 *     mean a camera;
 *   · A RELOAD, A CLI RENDER AND A VIDEO EXPORT ALL AGREE WITH THE SCREEN.
 * Double-click mouse-look (web/sceneNav.js) is therefore an EDIT GESTURE that
 * writes these properties through app.setPreview / commitPreview, exactly like
 * dragging a handle — it is not a live 3D app embedded in a slide. The
 * distinction is not stylistic: a viewer-local camera would make the render a
 * function of UI state and neither exporter could reproduce it.
 *
 * WHY EULER-PLUS-TARGET AND NOT A QUATERNION: a quaternion is four coupled
 * numbers that do not tween componentwise into anything meaningful, and the
 * interpolator vocabulary (core/interpolators.js) is scalar. This is the same
 * decision the app already made one dimension down, where an item's pose is a
 * SIMILARITY `{x, y, rotation, scale}` with `rotation` a scalar angle rather than
 * a matrix.
 *
 * ANGLES ARE STORED IN RADIANS and shown in degrees by the row's
 * `display: "degrees"`. That is a presentation choice, never a storage one —
 * plugins/shapeshifter.js:76 records the bug that shipped when the two were
 * confused (a -90 degree start angle rendering as "-5156.6 degrees").
 *
 * ── WHICH KIND OF STATE ──────────────────────────────────────────────────────
 * PROPERTY STATE, entirely. No clock, no `Math.random`, no frame-to-frame
 * accumulation anywhere on this path, so Delta-t = 0 leaves the picture identical
 * trivially. The one way this widget could have become EPHEMERAL is an async
 * splat sort read before it converged; render_gpu/gpu/scene3d_raster.js closes
 * that with `await spark.update()` and its header records the byte-identical
 * measurement that proves it.
 *
 * ── THE RESOLUTION CONTRACT (R6-1.6/.7/.8) — WHAT IS DONE AND WHAT IS NOT ─────
 * DONE: the raster is content-addressed over (source, pose, look, size), so an
 * unchanged scene at an unchanged view hits render_gpu/gpu/image_registry.js and
 * the engine never runs — R6-1.7 by construction. And `renderMode: "raster"` with
 * `rasterWidth`/`rasterHeight`/`rasterDPI` renders once at a chosen size whatever
 * the widget's on-canvas size, which is R6-1.8 verbatim (the vocabulary is
 * plugins/pdf_page.js:205's, deliberately: two widgets with the same control must
 * not have two names for it).
 *
 * NOT DONE, AND SAY SO PLAINLY: `renderMode: "live"` here means "resolution
 * follows the widget's OWN world scale", which is the latex/mermaid rasterization
 * rule — NOT pdf_page's live mode, which re-renders the on-screen visible CROP at
 * the CANVAS zoom. That needs a render PRE-PASS (the third, after
 * render_gpu/pdf_display.js and render_gpu/map_display.js), and a pre-pass has to
 * be threaded through render_gpu/ports.js, web/cameraFrame.js and
 * web/CanvasView.svelte. Those three edits are a HAND-BACK, not an omission that
 * was overlooked. Until they land, zooming the canvas into a 3D viewport
 * magnifies its raster instead of re-rendering it denser.
 *
 * ── HOW THE PIXELS REACH THE SCENE: THE `image` OP, NOT A NEW ONE ────────────
 * emit() draws ONE ordinary `image` op naming a ref in the shared image registry
 * — the fourth consumer of the reserveImageSlot / registerRasterizedBitmap seam
 * after pdf_page, latex and mermaid. Being the fourth buys, with no new code: the
 * async no-placeholder contract, `pendingImageRefs()` export gating (which is what
 * stops the headless render-job worker shipping a frame with a scene still
 * loading), missing-media refusal, the CLI's media-omission count, and PDF/SVG
 * embedding. A bespoke op would have re-earned all five.
 *
 * ── FORMATS, MEASURED ON THIS HOST (R6-1.10's honest answer) ─────────────────
 * Against @sparkjsdev/spark 2.1.0, headless: `.ply` (the INRIA format every
 * trainer writes) LOADS, PlayCanvas's compressed `.ply` LOADS, `.splat` LOADS,
 * and `.spz` LOADS ONLY AT VERSION 3 — a v4 `.spz` is refused with "Unsupported
 * SPZ version: 4", and an UNCOMPRESSED `.spz` (one that starts `NGSP` rather than
 * a gzip header) is refused with "Invalid gzip header". A `.sog` bundle does not
 * load at all. Those are the reader's real bounds, not a guess, and the `src`
 * row's help says so, because a user who exports a v4 `.spz` from a modern tool
 * and gets an empty box deserves to be told which version to ask for.
 *
 * DOM-free / bare-node-safe at import: only core modules, the IR builders, and
 * render_gpu/gpu/scene3d_raster.js — whose engine import is LAZY, so nothing here
 * pulls three.js into the node test lane or into the main bundle.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../../core/properties.js";
import { image, rect, text } from "../../render_gpu/ir.js";
import { cropInsetsToSource, decorateStrokedBox } from "../../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
import {
  SCENE3D_RASTER_DENSITY, ensureScene3dRasterized, roundScene3dScale, scene3dErrorFor,
} from "../../render_gpu/gpu/scene3d_raster.js";

/** Degrees per radian, for the few places a literal angle is easier to read in
 *  degrees than as a fraction of pi (the defaults table below). */
const DEG = Math.PI / 180;

/** The camera's default framing of a freshly inserted scene: a three-quarter view
 *  from slightly above, which is how every 3D tool in existence first shows you a
 *  model — head-on hides depth and straight-down hides the subject. */
const DEFAULT_YAW = 30 * DEG;
const DEFAULT_PITCH = 15 * DEG;

/** Default vertical field of view. 50 degrees is the long-standing "normal lens"
 *  choice (a 43 mm equivalent on 35 mm film): wide enough to hold a whole object,
 *  narrow enough not to bow straight edges. */
const DEFAULT_FOV = 50 * DEG;

/** Default orbit radius, in scene units. Splat captures and glTF models are both
 *  conventionally authored around unit scale, so 3 puts a unit-sized subject
 *  comfortably inside a 50 degree frame. */
const DEFAULT_DISTANCE = 3;

/** How far past the target the camera can see, as a multiple of the orbit
 *  distance, and how close. A perspective depth buffer's precision is governed by
 *  the far/near RATIO, so these are expressed relative to the pose rather than
 *  pinned to absolute scene units — a scene authored in millimetres and one
 *  authored in metres both get a usable frustum. */
const NEAR_FRACTION = 0.01;
const FAR_MULTIPLE = 100;

/** Pitch is clamped just short of straight up/down. AT exactly +/-90 degrees the
 *  view direction is parallel to the up vector and `lookAt` has no unique
 *  solution — the camera flips. Every orbit control in existence stops just short
 *  for this reason. */
export const MAX_PITCH = 89.9 * DEG;

/** The colours of the "no scene here" affordance. Kept literal because this is
 *  canvas chrome drawn through DOM-free IR: emit() cannot read app.css's --a-*
 *  tokens, the same constraint plugins/latex.js's error box documents. */
const EMPTY_BG = "#15171c";     // near-black panel, so a placed-but-empty viewport reads as a deliberate hole
const EMPTY_INK = "#8a93a6";    // muted grey text — informative, not alarming: an empty viewport is not an error
const ERROR_BG = "#f6c9c4";     // the app's loud-error pink-red (latex.js's ERROR_BG)
const ERROR_BORDER = "#c0392b";
const ERROR_INK = "#7a1210";
/** Border thickness and text inset of those affordances, in canvas units — plain
 *  layout values whose expression is its own explanation. */
const AFFORDANCE_BORDER = 3;
const AFFORDANCE_PAD = 12;
/** The affordance message height as a fraction of the box height, capped so a
 *  huge viewport does not get absurd type. */
const AFFORDANCE_TEXT_FRACTION = 0.07;
const AFFORDANCE_TEXT_MAX = 18;

/** What `src` row help says about getting a splat in here — R6-1.10's "there
 *  needs to be instructions on the widget somewhere". The shape is
 *  plugins/iconify.js:544's: grammar, example, gesture, source, caveat. The
 *  capture advice names Scaniverse specifically because it is the only free route
 *  that actually EXPORTS a radiance field: Polycam's free tier exports glTF only,
 *  and Postshot's free tier cannot export one at all. */
const SPLAT_SRC_HELP =
  "A Gaussian-splat scene file: a cloud of coloured, oriented ellipsoids captured from photos or video, not a mesh. " +
  "READS: .ply (the standard INRIA training output, and the safest choice), PlayCanvas compressed .ply, .splat, and .spz VERSION 3. " +
  "REFUSES: .spz version 4 and uncompressed .spz (the loader says so in the console), and .sog bundles. " +
  "TO MAKE ONE: capture with Scaniverse on a phone (the only free app that exports a radiance field — Polycam's free tier exports glTF only, and Postshot's cannot export one), or train your own with the INRIA gaussian-splatting code from a photo set. " +
  "TO GET IT IN HERE: drop the file on this row, or use Browse / Upload like any other asset. " +
  "Files are large — a room-scale capture is tens of megabytes — so expect a pause on first load.";

const MODEL_SRC_HELP =
  "A 3D model file (.glb / .gltf). NOT WIRED YET: the mesh member of this family is declared so its properties, camera and presets can be designed and tested, but its loader is not implemented — a model set here renders the 'no loader' affordance and reports loudly. Use the Gaussian Splat member for now.";

/**
 * Pure function. The family's data table. Everything that differs between
 * members lives HERE and nowhere else; `makeScene3dPlugin` below turns a row into
 * a complete plugin. Adding a third member (a point cloud, a NeRF, a CAD file) is
 * a row in this table.
 */
const MEMBERS = [
  {
    kind: "splat",
    type: "scene3d_splat",
    title: "Gaussian Splat",
    srcHelp: SPLAT_SRC_HELP,
    // NO LIGHT ROWS. 3DGS radiance is BAKED into the splats, so a light control
    // would be inert. core/registry.js's effectsInjectable states the house
    // doctrine for exactly this: a node kind that cannot honour a control gets NO
    // ROW, never a fake one.
    lit: false,
  },
  {
    kind: "model",
    type: "scene3d_model",
    title: "3D Model",
    srcHelp: MODEL_SRC_HELP,
    lit: true,
  },
];

/**
 * Pure function. A member's camera POSE, read out of folded item state — the
 * `sceneCamera` contract's first question (web/sceneNav.js). Pure and total: a
 * state missing a key reads that key's default, so a document written before a
 * property existed still poses correctly.
 *
 * @param {object} s folded, evaluated item state
 * @returns {{targetX:number,targetY:number,targetZ:number,yaw:number,pitch:number,roll:number,distance:number,fov:number}}
 *
 * @example scene3dPose({camDistance: 5, camYaw: 1}) // {targetX: 0, targetY: 0, targetZ: 0, yaw: 1, pitch: 0.2617993877991494, roll: 0, distance: 5, fov: 0.8726646259971648}
 * @example scene3dPose({}).distance // 3
 */
export function scene3dPose(s) {
  return {
    targetX: s.camTargetX ?? 0,
    targetY: s.camTargetY ?? 0,
    targetZ: s.camTargetZ ?? 0,
    yaw: s.camYaw ?? DEFAULT_YAW,
    pitch: s.camPitch ?? DEFAULT_PITCH,
    roll: s.camRoll ?? 0,
    distance: s.camDistance ?? DEFAULT_DISTANCE,
    fov: s.camFov ?? DEFAULT_FOV,
  };
}

/**
 * Pure function. A pose → the item-state writes that store it — the
 * `sceneCamera` contract's second question. Every key is a keyframable leaf, so
 * the handler commits them exactly like an Inspector row edit and a fly-through
 * keyframes on the current slide for free.
 *
 * PITCH IS CLAMPED HERE rather than in the handler, because the clamp is a
 * property of what the STORE can represent (a pose at exactly straight-up has no
 * unique up vector), not of the gesture that produced it — so an `=` equation
 * that evaluates past the pole is clamped identically to a mouse drag.
 *
 * @param {object} _s folded state (unused: this member stores the whole pose directly)
 * @param {object} pose the new pose
 * @returns {object} {stateKey: value}
 *
 * @example scene3dWrites({}, {targetX: 1, targetY: 2, targetZ: 3, yaw: 0.5, pitch: 0.2, roll: 0, distance: 4, fov: 0.9})
 * // {camTargetX: 1, camTargetY: 2, camTargetZ: 3, camYaw: 0.5, camPitch: 0.2, camRoll: 0, camDistance: 4, camFov: 0.9}
 * @example scene3dWrites({}, {targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 3, roll: 0, distance: 1, fov: 1}).camPitch
 * // 1.5690509975429023
 */
export function scene3dWrites(_s, pose) {
  return {
    camTargetX: pose.targetX,
    camTargetY: pose.targetY,
    camTargetZ: pose.targetZ,
    camYaw: pose.yaw,
    camPitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pose.pitch)),
    camRoll: pose.roll,
    camDistance: Math.max(0, pose.distance),
    camFov: pose.fov,
  };
}

/**
 * Pure function. The DEVICE SIZE one member should render at, given its folded
 * state and its own world scale. Two modes, and the mode is a property:
 *
 *   "live"   — follow the widget's own world scale at SCENE3D_RASTER_DENSITY
 *              device px per canvas unit, quantized onto the raster-scale grid so
 *              a resize drag reuses one raster across small changes. This is the
 *              latex/mermaid rule. It is NOT pdf_page's live mode (see the file
 *              header): the canvas ZOOM does not reach emit(), by design.
 *   "raster" — a FIXED size whatever the widget's on-canvas size, from
 *              rasterWidth/rasterHeight/rasterDPI. R6-1.8's "720x840 regardless".
 *              A non-positive width or height means "derive that axis from the
 *              box", exactly as pdf_display.rasterModeScale reads the same props.
 *
 * @param {object} s folded state (reads w, h, renderMode, raster*)
 * @param {number} worldScale the node's own absolute world scale
 * @returns {{w: number, h: number}} device pixels, both at least 1
 *
 * @example scene3dRasterSize({w: 200, h: 100}, 1) // {w: 400, h: 200}
 * @example scene3dRasterSize({w: 200, h: 100}, 2) // {w: 800, h: 400}
 * @example scene3dRasterSize({w: 200, h: 100, renderMode: "raster", rasterWidth: 720, rasterHeight: 840, rasterDPI: 96}, 8) // {w: 720, h: 840}
 * @example scene3dRasterSize({w: 200, h: 100, renderMode: "raster", rasterWidth: 0, rasterHeight: 0, rasterDPI: 192}, 1) // {w: 800, h: 400} (a 0 axis derives from the box at the shared supersample, and rasterDPI then doubles it)
 */
export function scene3dRasterSize(s, worldScale) {
  const boxW = Math.max(1, s.w ?? 1), boxH = Math.max(1, s.h ?? 1);
  if ((s.renderMode ?? RENDER_MODE_DEFAULT) === "raster") {
    const dpiFactor = (s.rasterDPI > 0 ? s.rasterDPI : RASTER_DEFAULT_DPI) / CSS_REFERENCE_DPI;
    return {
      w: Math.max(1, Math.round((s.rasterWidth > 0 ? s.rasterWidth : boxW * SCENE3D_RASTER_DENSITY) * dpiFactor)),
      h: Math.max(1, Math.round((s.rasterHeight > 0 ? s.rasterHeight : boxH * SCENE3D_RASTER_DENSITY) * dpiFactor)),
    };
  }
  const scale = roundScene3dScale((worldScale || 1) * SCENE3D_RASTER_DENSITY);
  return { w: Math.max(1, Math.round(boxW * scale)), h: Math.max(1, Math.round(boxH * scale)) };
}

/** The two render modes, spelled exactly as plugins/pdf_page.js spells them so a
 *  reader who knows one widget's control knows the other's. */
const RENDER_MODES = ["live", "raster"];
const RENDER_MODE_DEFAULT = "live";
/** Fixed mode's default density. 96 is the CSS reference pixel density (1 CSS px
 *  = 1/96"), the same default pdf_display.PDF_RASTER_DEFAULT_DPI picks and for the
 *  same reason: a scene rasters at roughly screen resolution unless asked
 *  otherwise. */
const RASTER_DEFAULT_DPI = 96;
const CSS_REFERENCE_DPI = 96;

/**
 * Pure function. The LOOK digest — every property that changes the pixels but is
 * not the pose or the size, joined into one string for the cache key. Kept as a
 * named function so that ADDING a look property is one edit here rather than a
 * silent cache-collision bug where two different-looking scenes share a ref.
 *
 * @param {object} s folded state
 * @returns {string}
 *
 * @example scene3dLook({exposure: 1.2, background: "#000"}) // "exposure=1.2|background=#000"
 * @example scene3dLook({}) // "exposure=1|background=transparent"
 */
export function scene3dLook(s) {
  return `exposure=${s.exposure ?? 1}|background=${s.background ?? "transparent"}`;
}

/**
 * Pure function. Is this viewport EMPTY (no source chosen)? The one canonical
 * predicate, driving BOTH the ghost hook and emit()'s short-circuit so
 * editor-ghostness and render-exclusion can never disagree.
 *
 * @param {object} s folded state
 * @returns {boolean}
 *
 * @example scene3dIsEmpty({}) // true
 * @example scene3dIsEmpty({src: "   "}) // true
 * @example scene3dIsEmpty({src: "scene.ply"}) // false
 */
export function scene3dIsEmpty(s) {
  return typeof s.src !== "string" || s.src.trim().length === 0;
}

/**
 * Pure function. The in-canvas message affordance: a filled, bordered panel with
 * one line of text. Used for BOTH "no scene chosen" (muted) and "this file would
 * not load" (loud red) — an absent picture and a failed picture must not look the
 * same, and neither may look like a blank widget.
 *
 * @param {number} w box width in canvas units
 * @param {number} h box height in canvas units
 * @param {string} message the line to show
 * @param {{bg: string, ink: string, border: string|null}} palette
 * @returns {object[]} local-space IR ops
 *
 * @example messageAffordance(200, 100, "No scene", {bg: "#111", ink: "#888", border: null}).length // 2
 * @example messageAffordance(200, 100, "Failed", {bg: "#f6c9c4", ink: "#7a1210", border: "#c0392b"})[0].op // "rect"
 * @example messageAffordance(200, 100, "No scene", {bg: "#111", ink: "#888", border: null})[0].strokeWidth // 0
 */
export function messageAffordance(w, h, message, palette) {
  const size = Math.max(1, Math.min(AFFORDANCE_TEXT_MAX, h * AFFORDANCE_TEXT_FRACTION));
  return [
    rect({
      x: 0, y: 0, w, h, fill: palette.bg,
      stroke: palette.border, strokeWidth: palette.border ? AFFORDANCE_BORDER : 0,
    }),
    text({
      text: message, x: AFFORDANCE_PAD, y: AFFORDANCE_PAD, size, color: palette.ink,
      boxW: Math.max(1, w - 2 * AFFORDANCE_PAD), boxH: Math.max(1, h - 2 * AFFORDANCE_PAD),
    }),
  ];
}

/**
 * Pure function. The camera rows every member shares. Declared INLINE here rather
 * than as a `core/properties.js` BUNDLE, which is the donut.js precedent
 * plugins/shapeshifter.js cites for exactly this situation: "rows declared in the
 * plugin, NOT in core/properties.js, so this whole family system needs zero edit
 * to the shared registry". That matters more than usual right now — the shared
 * registry is a file many agents touch, and a family that can be added without
 * editing it is a family that cannot conflict with one.
 *
 * @returns {object[]} inspector rows
 *
 * @example cameraRows()[0].key // "camYaw"
 * @example cameraRows().every((r) => r.category === "camera") // true
 */
export function cameraRows() {
  const angle = (key, label, help) => ({ key, label, kind: "angle", display: "degrees", category: "camera", help });
  const number = (key, label, help, extra = {}) => ({ key, label, kind: "number", category: "camera", help, ...extra });
  return [
    angle("camYaw", "Yaw", "Heading of the camera about the scene's up axis. Keyframe this across two slides and the shot orbits; bind it to \"= 2 * pi * progress\" for a full turntable."),
    angle("camPitch", "Pitch", "How far above (positive) or below (negative) the horizon the camera sits. Clamped just short of straight up or down, where a camera has no unique up direction and would flip."),
    angle("camRoll", "Roll", "Rotation of the camera about its own view direction — a canted, Dutch-angle shot. 0 keeps the horizon level."),
    number("camDistance", "Distance", "How far the camera sits from the point it looks at, in scene units. Tween it for a dolly in or out. 0 puts the camera AT the target, which is a first-person view.", { min: 0 }),
    angle("camFov", "Field of view", "The vertical angle the camera sees. Small is a telephoto (flat, compressed); large is a wide angle (deep, distorted). Changing this while holding Distance is the dolly-zoom shot."),
    number("camTargetX", "Target X", "The point the camera looks at and orbits around, in scene units. Move all three to fly the whole shot somewhere else."),
    number("camTargetY", "Target Y", "The point the camera looks at and orbits around, in scene units."),
    number("camTargetZ", "Target Z", "The point the camera looks at and orbits around, in scene units."),
  ];
}

/**
 * Pure function. The resolution rows every member shares — the vocabulary
 * plugins/pdf_page.js already uses for the identical control.
 *
 * @returns {object[]} inspector rows
 *
 * @example resolutionRows()[0].key // "renderMode"
 * @example resolutionRows()[0].options // ["live", "raster"]
 */
export function resolutionRows() {
  return [
    {
      key: "renderMode", label: "Resolution", kind: "select", options: RENDER_MODES,
      optionLabels: { live: "Follow widget size", raster: "Fixed" }, category: "rendering",
      help: "Follow widget size: the scene renders at this widget's own scale, so making the widget bigger renders it bigger. Fixed: render once at the exact pixel size below whatever the widget's size, then scale that one image — use it when a scene is slow and you want its cost pinned. KNOWN BOUND: zooming the CANVAS in does not yet re-render either mode at a higher density; that needs the render pre-pass this widget has not been wired to.",
    },
    { key: "rasterWidth", label: "Fixed width", kind: "number", min: 0, category: "rendering", help: "Fixed mode only: the render width in pixels. 0 derives it from the widget's box. NOTE: this bounds the PIXEL cost, which is the small half — most of a splat frame's time is the sort, which is resolution-independent, so halving this will not halve the render time." },
    { key: "rasterHeight", label: "Fixed height", kind: "number", min: 0, category: "rendering", help: "Fixed mode only: the render height in pixels. 0 derives it from the widget's box." },
    { key: "rasterDPI", label: "Fixed density", kind: "number", min: 1, category: "rendering", help: "Fixed mode only: multiplies the fixed width and height. 96 renders at roughly screen resolution; 192 is the crisp-on-a-retina-display choice." },
  ];
}

/** WHERE A PRESET'S SCENE COMES FROM, and the rule every entry below obeys.
 *
 * The user's ruling: "Even if the assets don't exist in our shipped Git
 * repository, surely there are some that we can just reference by URL online.
 * For the Gaussian splat files, I'd like to see several examples of both that
 * and meshes." So a preset may name a REMOTE scene — and every one of them
 * therefore carries its SOURCE and its LICENCE in its own description, because
 * we are pointing authors at other people's work and an author who exports a
 * deck has to know what they are allowed to do with it.
 *
 * EVERY URL BELOW WAS MEASURED, not assumed: HTTP status, byte length and
 * `access-control-allow-origin` were read with `curl -I` on 2026-08-01, and each
 * one answers 200 with `ACAO: *` (a browser cannot fetch a scene without that
 * header, so an asset host that omits it is unusable however good its licence).
 * The byte figures in the descriptions are those measured Content-Lengths.
 *
 * WHAT WAS REJECTED, so nobody re-proposes it:
 *   · `sparkjs.dev/assets/splats/*.spz` — 30-odd small, ideal, perfectly
 *     compatible scenes, hosted by the engine we already depend on, and its own
 *     README hot-links `butterfly.spz` in its quickstart. REJECTED ANYWAY: the
 *     repository LICENSE is a plain MIT covering "the Software", the assets are
 *     NOT in the repository, and there is no ASSETS.md, no attribution file and
 *     no licence statement anywhere for them. An implied licence is not a cited
 *     one. This is the single biggest loss in this list and it would take one
 *     sentence from the Spark maintainers to reverse.
 *   · `huggingface.co/cakewalk/splat-data` (train / nike / plush) and
 *     `huggingface.co/datasets/dylanebert/3dgs` (bonsai) — the splats every 3DGS
 *     web demo uses. Both cards declare NO licence (checked via the HF API:
 *     `cardData.license` is null on both). The Mip-NeRF 360 and Tanks & Temples
 *     scenes they derive from are additionally covered by INRIA's
 *     research-only Gaussian-Splatting licence, so even a declared card would
 *     need checking upstream. REJECTED.
 *   · Objaverse — answered in the negative by this round's own research and not
 *     re-litigated here: no search API, an index with no licence field, 0.4% CC0,
 *     and an open unresolved legal complaint against the dataset.
 *
 * THE HONEST CONSEQUENCE: there are only TWO cleanly-licensed remote splat
 * scenes in this list against ten meshes. That asymmetry is real and it is a
 * property of the world, not of the effort — permissively-licensed photographic
 * splat captures barely exist yet, while Khronos has curated a CC0 mesh library
 * for a decade. A short list that will still resolve in a year beats a long one
 * where half of it 404s.
 */

/** Khronos glTF-Sample-Assets, `main` branch. Every model below was confirmed
 *  CC0 by reading its own `Models/<Name>/README.md`, not by trusting the
 *  repository. Pinned to `main` rather than a commit DELIBERATELY: a preset is a
 *  starting point an author replaces, and a moved-but-current asset is better
 *  than a pinned one that a repo reorganization turns into a 404. */
const KHRONOS = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models";
const khronos = (name) => `${KHRONOS}/${name}/glTF-Binary/${name}.glb`;

/** Niantic's SPZ reference repository — the format author's own sample captures,
 *  MIT by the repository LICENSE, which is the strongest splat provenance found
 *  anywhere in this round's survey. */
const SPZ_SAMPLES = "https://raw.githubusercontent.com/nianticlabs/spz/main/samples";

/** The ONE scene that travels with the app, so the widget is not useless offline
 *  or on a first run behind a corporate proxy. `new URL(..., import.meta.url)` is
 *  Vite's own static-asset idiom: in dev it resolves to the served file, in a
 *  build the bytes are emitted and the URL is rewritten to the hashed asset. That
 *  is why the file can live outside the Vite root without any loader machinery —
 *  and why this is one line rather than a builtinClipart-style registry, which
 *  would be the right shape only once there are several. */
const LOCAL_SAMPLE = new URL("../../assets/builtin/splats/spz-test-scene.ply", import.meta.url).href;
/** The mesh member's shipped subject, for the same offline reason. */
const LOCAL_MODEL = new URL("../../assets/builtin/models/clearcoat-car-paint.glb", import.meta.url).href;

/**
 * Pure function. The camera SHOTS every member offers — presets that change the
 * view and nothing else, so they compose with whatever scene is loaded.
 *
 * @returns {object[]} presets
 *
 * @example shotPresets().length // 5
 * @example shotPresets()[0].name // "Three-quarter"
 */
export function shotPresets() {
  const shot = (name, description, props) => ({ name, description, props });
  return [
    shot("Three-quarter",
      "The default establishing view: off-axis and slightly above, so depth reads and no face of the subject is hidden. Start here.",
      { camYaw: DEFAULT_YAW, camPitch: DEFAULT_PITCH, camDistance: DEFAULT_DISTANCE, camFov: DEFAULT_FOV, camRoll: 0 }),
    shot("Front elevation",
      "Dead-on and level, at a long lens so the subject is nearly orthographic. The drawing-board view — right for comparing two things, wrong for showing volume.",
      { camYaw: 0, camPitch: 0, camDistance: DEFAULT_DISTANCE * 3, camFov: 18 * DEG, camRoll: 0 }),
    shot("Top-down",
      "Looking straight down at the plan. Uses the pitch clamp, so it is as vertical as a camera with a defined up direction can be.",
      { camYaw: 0, camPitch: MAX_PITCH, camDistance: DEFAULT_DISTANCE, camFov: DEFAULT_FOV, camRoll: 0 }),
    shot("Hero, low and wide",
      "Below the horizon on a wide lens, the angle every product shot and film poster uses to make a subject loom. Canted slightly so it does not read as an accident.",
      { camYaw: -40 * DEG, camPitch: -18 * DEG, camDistance: DEFAULT_DISTANCE * 0.7, camFov: 75 * DEG, camRoll: -4 * DEG }),
    shot("Inside, wide",
      "The camera pushed in close on a wide lens — the walk-through look for a room-scale capture. Keyframe Yaw from here for a look-around.",
      { camYaw: DEFAULT_YAW, camPitch: 0, camDistance: DEFAULT_DISTANCE / 6, camFov: 90 * DEG, camRoll: 0 }),
  ];
}

/**
 * Pure function. The SCENE presets — one per referenced asset. Each writes `src`
 * and a pose chosen for that subject, and each states its source and licence.
 *
 * @param {object} member a MEMBERS row
 * @returns {object[]} presets
 *
 * @example scenePresets({kind: "splat"}).length // 3
 * @example scenePresets({kind: "model"}).length // 10
 * @example scenePresets({kind: "splat"})[0].props.camFov // 0.8726646259971648
 * @example scenePresets({kind: "model"})[1].props.src.endsWith("MetalRoughSpheresNoTextures.glb") // true
 */
export function scenePresets(member) {
  const framed = (src, extra = {}) => ({
    src, camYaw: DEFAULT_YAW, camPitch: DEFAULT_PITCH, camRoll: 0,
    camDistance: DEFAULT_DISTANCE, camFov: DEFAULT_FOV,
    camTargetX: 0, camTargetY: 0, camTargetZ: 0, ...extra,
  });
  const scene = (name, description, src, extra) => ({ name, description, props: framed(src, extra) });
  if (member.kind === "splat")
    return [
      scene("SPZ format sample (shipped, offline)",
        "The one splat scene that travels WITH this app, so the widget has something to show with no network at all: 1,566 Gaussians in the standard INRIA .ply layout, 144,648 bytes. Source: nianticlabs/spz test data, MIT. It is a format fixture rather than a photograph — use it to check the widget works, then load one of the captures below.",
        LOCAL_SAMPLE),
      scene("Horned lizard (capture)",
        "A real photographic capture: 786,233 Gaussians, 18,143,098 bytes over the network, so expect a few seconds on a first load. Source: nianticlabs/spz samples, MIT — the SPZ format author's own repository, which is the cleanest splat provenance this survey found.",
        `${SPZ_SAMPLES}/hornedlizard.spz`, { camDistance: DEFAULT_DISTANCE * 0.8 }),
      scene("Racoon family (capture)",
        "A larger multi-subject capture: 24,202,962 bytes, the biggest scene referenced here — good for judging how the resolution controls behave on something heavy. Source: nianticlabs/spz samples, MIT.",
        `${SPZ_SAMPLES}/racoonfamily.spz`, { camDistance: DEFAULT_DISTANCE, camFov: 60 * DEG }),
    ];
  return [
    scene("Car paint (shipped, offline)",
      "The one model that travels WITH this app, so the viewer has a subject with no network at all: a flake-and-clearcoat automotive finish over metal in 116,948 bytes — small, but it exercises the loader, the three-point light rig and the tone mapping. Source: Khronos glTF-Sample-Assets ClearCoatCarPaint, CC0 1.0 (© 2023 Public; Eric Chadwick).",
      LOCAL_MODEL),
    scene("Metal spheres (no textures)",
      "A grid of 1,040,409 triangles of pure metal and roughness with ZERO image textures, 291,316 bytes. The lighting rig on its own: change the shot and watch the highlights move, with nothing painted on to confuse what you are seeing. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("MetalRoughSpheresNoTextures")),
    scene("Suzanne",
      "Blender's monkey, the most recognisable test mesh in computer graphics, here in its iridescent-material variant because that is the only single-file .glb Khronos ships of her. 507,608 bytes. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("IridescenceSuzanne")),
    scene("Boom box",
      "A full PBR material set on one object — base colour, normal, occlusion/roughness/metallic and emissive — so every channel of the shading model is doing something. 10,614,184 bytes. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("BoomBox")),
    scene("Water bottle",
      "Brushed metal against a matte label: the classic product-shot pairing, and the easiest way to see what the Hero shot's low wide angle does. 8,966,700 bytes. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("WaterBottle")),
    scene("Avocado",
      "682 triangles carrying 8,110,040 bytes of 4K texture — the clearest demonstration in this list that a model's cost is almost never its geometry. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("Avocado")),
    scene("Lantern",
      "A three-part prop with worn metal and glass, at 9,564,264 bytes. The most scene-like of the small models: it has an inside and an outside. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("Lantern")),
    scene("Toy car",
      "5,422,412 bytes and unusually GEOMETRY-dominated rather than texture-dominated, with clearcoat paint over metal. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("ToyCar")),
    scene("Glass vase and flowers",
      "Transmission, refraction and thin-walled glass — the hardest thing in the shading model to get right and the most obviously wrong when it is not. 1,819,824 bytes. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("GlassVaseFlowers")),
    scene("Anisotropy disc",
      "Brushed-metal anisotropy laid out as a test chart, 242,128 bytes: the highlight stretches along the brush direction and rotates as you orbit. Source: Khronos glTF-Sample-Assets, CC0.",
      khronos("AnisotropyDiscTest")),
  ];
}

/**
 * Pure function. A member's preset FAMILIES — the shots, and the scenes.
 *
 * TWO FAMILIES, not one flat list, and the reason is the disjointness rule
 * tests/tool_groups_test.js enforces: a family's presets must write DISJOINT key
 * sets from its siblings' so picking from one never undoes a pick from another.
 * These two deliberately OVERLAP on the camera keys — a scene preset frames its
 * own subject — so they cannot be two families. They are therefore ONE family of
 * scenes plus one of shots… which is a contradiction, and it is resolved the way
 * the gate requires: a SINGLE flat list, so `presetFamiliesOf` wraps it as one
 * "Presets" group and nothing can clobber anything.
 *
 * @param {object} member a MEMBERS row
 * @returns {object[]} presets
 *
 * @example scene3dPresets({kind: "splat"}).length // 8
 * @example scene3dPresets({kind: "model"}).length // 15
 */
export function scene3dPresets(member) {
  return [...scenePresets(member), ...shotPresets()];
}

/**
 * Pure function. Builds ONE complete plugin from a MEMBERS row. Everything below
 * is shared by the whole family; everything member-specific came from the row.
 *
 * @param {object} member a MEMBERS row
 * @returns {object} a registrable plugin
 *
 * @example makeScene3dPlugin(MEMBERS[0]).type // "scene3d_splat"
 * @example makeScene3dPlugin(MEMBERS[0]).activate // "navigate_scene"
 */
function makeScene3dPlugin(member) {
  return {
    type: member.type,
    title: member.title,
    capabilities: { bbox: true, transform: true, resizable: true },

    // CREATION: drag a box, then choose the source (web/widget_handlers.js's
    // "bbox_then_asset"). A viewport's size is a composition decision and its
    // source is a content decision, and the create phase is where both belong —
    // which is also what frees the DOUBLE-CLICK for flying, since a widget names
    // exactly one activate handler.
    placement: "bbox_then_asset",
    primaryAsset: "src",

    // ACTIVATION: double-click enters mouse-look (R6-1.2). The whole opt-in is
    // this string plus the `sceneCamera` descriptor below — web/sceneNav.js knows
    // nothing about splats, exactly as web/interiorNav.js knows nothing about
    // fractals.
    activate: "navigate_scene",
    /** THE CAMERA CONTRACT — web/sceneNav.js asks a member exactly two pure
     *  questions, in the shape web/interiorNav.js established. */
    sceneCamera: {
      pose: scene3dPose,
      writes: scene3dWrites,
    },

    /**
     * Pure function. THE FLOATING BAR explore mode mounts above the widget — the
     * visible indication the mode is live, and the readout of where the camera
     * is. Same `fields` spec web/CanvasToolbar.svelte renders for the map, and
     * the same `fieldWrites` commit path, so a typed number and a dragged one are
     * indistinguishable to the document.
     *
     * @param {object} s folded state
     * @returns {object} the CanvasToolbar spec
     */
    floatingToolbar(s) {
      const p = scene3dPose(s);
      const deg = (rad) => String(Math.round((rad * 180) / Math.PI));
      return {
        label: "Camera",
        fields: [
          { id: "yaw", label: "Yaw", value: deg(p.yaw), keys: ["camYaw"], size: "narrow", help: "Heading, in degrees. Type a number to jump the camera there." },
          { id: "pitch", label: "Pitch", value: deg(p.pitch), keys: ["camPitch"], size: "narrow", help: "Elevation above the horizon, in degrees." },
          { id: "distance", label: "Dist", value: String(Number(p.distance.toFixed(3))), keys: ["camDistance"], size: "narrow", help: "Distance from the point the camera orbits, in scene units." },
          { id: "fov", label: "FOV", value: deg(p.fov), keys: ["camFov"], size: "narrow", help: "Vertical field of view, in degrees." },
        ],
      };
    },

    /**
     * Pure function. A bar field's typed text → the property writes that store
     * it, or null when the text is not a number this field accepts (the host then
     * leaves the field alone rather than committing a guess — globe_map's LOUD
     * REFUSAL convention).
     *
     * @param {object} _s folded state
     * @param {string} id the field id
     * @param {string} typed the raw text
     * @returns {object|null}
     *
     * @example makeScene3dPlugin(MEMBERS[0]).fieldWrites({}, "yaw", "90").camYaw // 1.5707963267948966
     * @example makeScene3dPlugin(MEMBERS[0]).fieldWrites({}, "distance", "4") // {camDistance: 4}
     * @example makeScene3dPlugin(MEMBERS[0]).fieldWrites({}, "yaw", "banana") // null
     */
    fieldWrites(_s, id, typed) {
      const n = Number(String(typed).trim());
      if (String(typed).trim() === "" || !Number.isFinite(n)) return null;
      if (id === "yaw") return { camYaw: n * DEG };
      if (id === "pitch") return { camPitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, n * DEG)) };
      if (id === "fov") return { camFov: n * DEG };
      if (id === "distance") return { camDistance: Math.max(0, n) };
      throw new Error(`${member.type} fieldWrites: unknown field "${id}" (declared: yaw, pitch, distance, fov)`);
    },

    /**
     * Pure function. An EMPTY viewport (no source) is a GHOST — it draws nothing
     * of its own beyond the affordance, so it gets the dashed-outline /
     * findable-when-Show-Ghosts treatment every other empty media widget gets.
     *
     * @param {object} s folded state
     * @returns {boolean}
     *
     * @example makeScene3dPlugin(MEMBERS[0]).isGhost({}) // true
     * @example makeScene3dPlugin(MEMBERS[0]).isGhost({src: "a.ply"}) // false
     */
    isGhost(s) {
      return scene3dIsEmpty(s);
    },

    defaults: {
      type: member.type, x: 120, y: 120, w: 480, h: 360, z: 0, rotation: 0, scale: 1,
      rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
      src: "",
      camTargetX: 0, camTargetY: 0, camTargetZ: 0,
      camYaw: DEFAULT_YAW, camPitch: DEFAULT_PITCH, camRoll: 0,
      camDistance: DEFAULT_DISTANCE, camFov: DEFAULT_FOV,
      renderMode: RENDER_MODE_DEFAULT, rasterWidth: 0, rasterHeight: 0, rasterDPI: RASTER_DEFAULT_DPI,
      exposure: 1,
      // TRANSPARENT by default, so a scene composites over the slide rather than
      // punching a black hole in it — the same choice every other media box makes.
      background: "transparent",
      stroke: "#000000",
      ...defaults("strokeWidth", "cornerRadius", "opacity"),
      ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"),
      ...bundleNestedDefaults("effects"),
    },

    inspector: [
      ...bundle("positioning"),
      { key: "src", label: "Source", kind: "asset", category: "content", help: member.srcHelp },
      ...cameraRows(),
      { key: "exposure", label: "Exposure", kind: "number", min: 0, category: "rendering", help: "Multiplies the scene's brightness before it is drawn. A capture made in shade lifts with this; one made in sun comes down." },
      { key: "background", label: "Background", kind: "color", category: "rendering", help: "Fills the viewport behind the scene. Transparent lets the slide show through, which is usually what you want for an object; a solid colour suits a room-scale capture whose edges are ragged." },
      ...resolutionRows(),
      ...bundle("strokedBorder"),
      ...bundle("cropInsets"),
      ...props("opacity"),
      ...bundle("effects"),
    ],

    presets: scene3dPresets(member),

    /** Pure function. The standard eight bbox anchors — a viewport is a box, so
     *  arrows and equations bind to it like any other box. */
    anchors: standardBBoxAnchors,

    /** The EFFECT halo around the ink (the shared rule: distinct from
     *  localBounds, which is the ink itself). */
    cullMargin: effectsCullMargin,

    /**
     * Near-pure function (idempotently kicks an async render; the RETURNED IR is
     * a pure function of state and world — same inputs, same op, always).
     * State → display list.
     *
     * THREE OUTCOMES, and none of them is a blank box:
     *   1. no source        → the muted "choose a scene" panel (and isGhost above);
     *   2. source that failed to load → the LOUD red panel naming the reason, so a
     *      .spz version 4 says so instead of looking like an empty viewport;
     *   3. otherwise        → ONE `image` op at the raster's ref. Before the first
     *      render lands the ref resolves to nothing and the compositor draws
     *      nothing for it, repainting when image_registry's onImageLoad fires —
     *      the async contract, no placeholder, no blocking.
     *
     * @param {object} s folded, evaluated item state
     * @param {object} _subtree unused (a viewport has no subtree)
     * @param {object} world the node's own absolute world transform
     * @returns {object[]} display-list commands in local space
     */
    emit(s, _subtree, world) {
      const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
      if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
      const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
      const framed = (ops) => applyEffects(decorateStrokedBox(ops, style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
      const shifted = (ops) => ops.map((op) => ({ ...op, x: op.x + c.x, y: op.y + c.y }));

      if (scene3dIsEmpty(s))
        return framed(shifted(messageAffordance(c.w, c.h, `Double-click to choose a ${member.title.toLowerCase()} file`, { bg: EMPTY_BG, ink: EMPTY_INK, border: null })));

      const failure = scene3dErrorFor(s.src);
      if (failure)
        return framed(shifted(messageAffordance(c.w, c.h, `Could not load this scene — ${failure}`, { bg: ERROR_BG, ink: ERROR_INK, border: ERROR_BORDER })));

      const size = scene3dRasterSize(s, world?.scale ?? 1);
      const pose = scene3dPose(s);
      const ref = ensureScene3dRasterized({
        kind: member.kind, src: s.src, pose, look: scene3dLook(s),
        lit: member.lit, exposure: s.exposure ?? 1,
        w: size.w, h: size.h,
        near: Math.max(pose.distance * NEAR_FRACTION, Number.EPSILON),
        far: Math.max(pose.distance * FAR_MULTIPLE, 1),
      });
      const quad = image({
        ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1,
        sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, sampling: "bilinear",
      });
      return framed([quad]);
    },
  };
}

/**
 * THE FAMILY, as an array — the shapeshifter.js / text_morph.js / corkboard.js
 * export shape. plugins/index.js spreads it into the roster with one line.
 */
export const scene3dPlugins = MEMBERS.map(makeScene3dPlugin);
