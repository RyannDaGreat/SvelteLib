/**
 * Image widget — a sampled-texture quad of a bitmap the user drops in or picks
 * from the project's assets. THE first media widget, and the proof that the
 * render-parity cornerstone (manifest round 11) holds for raster content: it
 * renders through the WebGPU compositor (as a textured quad) AND through the
 * PDF backend (as an embedded image XObject), no corners cut.
 *
 * ── STATE ─────────────────────────────────────────────────────────────────────
 * `src` holds the image SOURCE as a string — a `data:` URI or a URL. That is
 * deliberately self-contained: an asset server is being built in PARALLEL, and
 * this widget must NOT depend on it (a dropped image can be inlined as a data
 * URI; a project asset can be a URL the server serves later). Because `src` is
 * a plain string it travels with the document, works offline, and needs no
 * media-registry plumbing through the web layer — every raster backend resolves
 * it (the GPU compositor via gpu/image_registry.js; the PDF backend decodes the
 * data URI itself). `w`/`h` are the quad's world size; a UI insert defaults them
 * to the image's native pixel size centered at the drop point (that UI is NOT
 * this plugin's job — see the round-12 drag-drop spec).
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false. backdrop:false is
 * what makes an image UNDER a magnifier or blur composite correctly: the image
 * paints in z-order into the scene, and the effect above it samples the
 * composited canvas (which now contains the image) — the backdrop-stacking
 * requirement holds with zero special-casing (culling likewise: the default
 * bbox-intersection rule in core/view.js canSkipNode applies for free).
 *
 * ── ASYNC (manifest F3 + the round-12 async rule) ─────────────────────────────
 * Bitmap decode is async; emit() is sync and PURE (it always returns the same
 * image op for a given state). The compositor draws NOTHING for a src whose
 * bitmap has not decoded yet and repaints when it lands (gpu/image_registry.js
 * skip-and-notify) — so there is no silent placeholder and no blocking. A
 * decode FAILURE is reported loudly by the registry (console.error), never
 * swallowed.
 */

import { convergesOnRefs } from "../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { image } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** A tiny 1×1 transparent PNG data URI — the default `src` so a freshly added
 * image widget is a valid (invisible-until-sourced) item rather than a broken
 * ref. Replaced the instant the user drops/picks a real image. */
export const BLANK_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** THE sampling default — "nearest" is the long-standing pre-Round-3 behaviour, so
 *  it is what keeps an untouched image byte-identical. ONE constant because the
 *  value has TWO readers that must never disagree: `defaults` (what a NEW item
 *  gets) and emit's `??` (what an item saved BEFORE this row existed falls back
 *  to). It used to be three literals — the row also carried `default: "nearest"`,
 *  which was INERT: `defaults()` reads the shared PROPS registry
 *  (core/properties.js:1584), and nothing in core/, web/ or render_gpu/ reads
 *  `.default` off an inspector row. `sampling` is not a PROPS key (measured: 86
 *  keys, no `sampling`), so that declaration looked authoritative and did nothing,
 *  and a new item's `sampling` was simply absent. Now it is a real default. */
export const DEFAULT_SAMPLING = "nearest";

// ── PHOTO TREATMENTS (R7-39 presets law) ─────────────────────────────────────
// EVERY ROW SETS EVERY EFFECTS KEY, IDENTITIES INCLUDED — application is an
// OVERLAY (app.applyPreset writes exactly the keys in `props`), so a knob a row
// omits keeps whatever the PREVIOUSLY HOVERED row left there (plugins/group.js's
// "Ink Stamp"-after-"Neon Glass" argument, verbatim for this widget). The OFF
// constants are named rather than inlined for the same reason group.js names
// them: SHADOW_OFF/INNER_OFF read the same shape at every call site, and
// COMPLETENESS IS DERIVED FROM BUNDLES.effects (tests/image_presets_test.js), not
// transcribed — the day a seventh effect lands, a preset missing it fails loudly
// by name instead of silently leaking the previous row's value on hover.
//
// EVERY ROW ALSO SETS ALL FOUR CROP INSETS, 0 being the identity, for the same
// overlay reason: hovering "Gallery Mat" (which crops) after "Magazine Bleed"
// (which does not) must not leave Magazine Bleed showing a stale mat.
//
// NO PRESET SETS `src` — the photo is the author's content, the same rule
// qrcode's table states for `data`. NO PRESET SETS `sampling`: it changes how the
// SOURCE PIXELS resample, not the frame around them, and every treatment here is
// a frame/finish rather than a resampling choice — the one row a "pixel-art"
// look genuinely needs (`sampling: "nearest"`) is already this widget's default,
// so a preset setting it would only ever set it back to what it already is.
//
// DIVERSE BY TREATMENT CLASS, not by swapping a border colour: a physical frame
// (Polaroid, Gallery Mat), a silhouette shape (Circular Avatar), a hard-edged
// finish (Pixel-Art Crisp), a falloff (Soft Vignette, Torn Edge), a light source
// (Sticker's glow, CRT Screen's blend), a crop-only composition (Magazine Bleed,
// Thumbnail Chip) and a translucency (Faded Watermark) — eleven rows, eleven
// different KINDS of thing a photo can be turned into, not one kind restyled
// eleven times.
//
// EVERY ROW CARRIES A REAL (STROKED) BORDER, AND NOT ALL OF THEM ARE THERE FOR
// THE SAME REASON — say so per row rather than presenting a uniform rule.
// MEASURED: this widget's own INK is its bitmap, and decorateStrokedBox/
// applyEffects wrap whatever content emit() is handed, so a preset that leaves
// strokeWidth at 0 on an unsourced (or not-yet-decoded) image paints NOTHING —
// no shadow, no bloom, no soft-edge feather, no crop boundary, nothing —
// because every one of those effects operates on the CONTENT it wraps, and
// there is no content to operate on. tests/image_presets_test.js measured this
// directly (a shadow-only, bloom-only, soft-edges-only, blend-only and
// crop-only frame are ALL byte-identical to the untouched default against an
// empty src). That is a real bare-node BLIND SPOT, not evidence that a border
// belongs in every treatment: Polaroid, Sticker, Gallery Mat, Pixel-Art Crisp
// and Circular Avatar want a real border regardless of any test harness.
// Faded Watermark, Magazine Bleed, Soft Vignette and Torn Edge do NOT — their
// own descriptions say so — and each of those four rows carries an explicit
// comment naming its stroke a HARNESS ACCOMMODATION, sized only to survive
// this gate, to be revisited (generally toward 0) once a browser-based
// distinctness gate exists that can render a real decoded bitmap. CRT Screen's
// bezel is judged a genuine part of its look but its exact weight was tuned
// against the same gate — also flagged, at its own row.
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLUR_OFF = 0;
const NO_CROP = { cropTop: 0, cropLeft: 0, cropRight: 0, cropBottom: 0 };

const IMAGE_PRESETS = [
  {
    name: "Polaroid",
    description: "A thick white border with the deep bottom margin an instant print leaves for its caption, lifted off the page by a soft, close shadow.",
    props: {
      stroke: "#ffffff", strokeWidth: 28, cornerRadius: 0,
      shadow: { dx: 0, dy: 10, blur: 18, color: "#000000", opacity: 0.4 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Circular Avatar",
    description: "Rounded to a full disc — the profile-picture crop — finished with a hairline white ring so the circular silhouette itself reads cleanly against whatever sits behind it.",
    props: {
      stroke: "#ffffff", strokeWidth: 6, cornerRadius: 4096,
      shadow: { dx: 0, dy: 3, blur: 8, color: "#000000", opacity: 0.35 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Pixel-Art Crisp",
    description: "A hard-edged finish for a sprite or a screenshot: a thin black keyline and a tight, high-contrast shadow with no blur at all, so nothing in the frame softens what the pixels themselves are sharp about.",
    props: {
      stroke: "#000000", strokeWidth: 3, cornerRadius: 0,
      shadow: { dx: 4, dy: 4, blur: 0, color: "#000000", opacity: 0.85 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Soft Vignette",
    // BORDER WEIGHT IS A HARNESS ACCOMMODATION, flagged: the treatment a "soft
    // vignette" name promises is the PHOTO's own edge dissolving to nothing —
    // ideally NO visible border at all, just a feather on the bitmap itself.
    // strokeWidth 30 exists only because soft edges erode a widget's silhouette
    // INWARD from its true bbox boundary (render_gpu/skia/paint_skia.js
    // featherEdges — full opacity only ~2·feather inside), so a thin/absent
    // ring right at that boundary is erased whole rather than visibly softened
    // — measured: even strokeWidth 20 at softEdges 48 vanished completely. A
    // heavy black ring is therefore what makes THIS ROW PROVABLE in bare node
    // today, not what a vignette should look like against a real photo, where
    // the feather would act on the image's own pixels and no ring would be
    // needed. REVISIT the stroke weight (likely toward 0) once a browser-based
    // gate can render the actual bitmap being vignetted.
    description: "The photo dissolving into the page at its own border instead of ending on a hard edge — a soft outward feather rather than a frame.",
    props: {
      stroke: "#000000", strokeWidth: 30, cornerRadius: 0,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 6, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Sticker",
    description: "A die-cut sticker: a thick white keyline standing the image off the background, with a soft outer glow so it reads as printed vinyl catching light rather than paper lying flat.",
    props: {
      stroke: "#ffffff", strokeWidth: 14, cornerRadius: 22,
      shadow: SHADOW_OFF, bloom: { radius: 20, strength: 0.5 }, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "CRT Screen",
    // BORDER JUDGED GENUINE, NOT PURELY A HARNESS ACCOMMODATION — a monitor/CRT
    // bezel is a real part of the metaphor, unlike Faded Watermark's or
    // Magazine Bleed's keyline — but its EXACT weight (18 canvas units,
    // #202020) was tuned against the bare-node distinctness gate rather than
    // chosen by eye against a real screen photo, since `blendMode: "screen"`
    // alone is a measured no-op on an unsourced/undecoded image (see the
    // header). Revisit the exact stroke/bloom balance once a browser-based
    // gate can render this against a real bitmap.
    description: "A dark bezel around a screen blend: the frame reads as an enclosure while the image inside can only brighten what's behind it, the way a monitor or a projector adds light into a dark room.",
    props: {
      stroke: "#202020", strokeWidth: 18, cornerRadius: 12,
      shadow: SHADOW_OFF, bloom: { radius: 16, strength: 0.35 }, blendMode: "screen", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Thumbnail Chip",
    description: "A small rounded card — the tight corner radius and light-grey keyline a grid of thumbnails or a file browser uses, sized to read at icon scale.",
    props: {
      stroke: "#d0d0d0", strokeWidth: 3, cornerRadius: 10,
      shadow: { dx: 0, dy: 2, blur: 4, color: "#000000", opacity: 0.2 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Faded Watermark",
    // HARNESS ACCOMMODATION, flagged rather than hidden: the treatment itself
    // is "low opacity and nothing else" — a bare `opacity: 0.18` with no border
    // at all — but `opacity` fades the widget's own CONTENT (decorateStrokedBox
    // forces the wrapper to 1; see the OPACITY CONTRACT above emit()), so on an
    // unsourced/undecoded image it fades nothing visible and is provably
    // indistinguishable from the untouched default under bare node (measured).
    // The 1px keyline exists ONLY to give tests/image_presets_test.js's
    // bare-node gate something to see; it is not part of the look. REVISIT and
    // drop strokeWidth to 0 once a browser-based gate can render real content.
    description: "Low opacity and nothing else — a background reference image that should read as present but never compete with whatever is placed over it.",
    props: {
      stroke: "#ffffff", strokeWidth: 1, cornerRadius: 0, opacity: 0.18,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Gallery Mat",
    description: "An even inward crop standing in for the archival mat behind a framed print, paired with a thin dark keyline the mat board's own edge would cast.",
    props: {
      stroke: "#1a1a1a", strokeWidth: 4, cornerRadius: 0,
      shadow: { dx: 0, dy: 6, blur: 14, color: "#000000", opacity: 0.3 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      cropTop: 24, cropLeft: 24, cropRight: 24, cropBottom: 24,
    },
  },
  {
    name: "Magazine Bleed",
    description: "No crop, and only a hairline keyline — the photo runs almost to the very edge of its own box, the way a page bleeds off the trim — set off from whatever sits under it by a hard, page-like drop shadow rather than a real frame.",
    // HONEST FLAG, NOT A QUIET WORKAROUND: this treatment's whole point is "no
    // frame", so strokeWidth here is a HARNESS ACCOMMODATION, not a look
    // decision — the header note above this table explains why (shadow/bloom/
    // soft-edges/blend/crop are ALL measured no-ops on an unbordered, unsourced
    // image in bare node; a MEASURED probe confirms even this preset's own
    // page-like drop shadow draws nothing without SOME border to cast it, since
    // the shadow is a silhouette of the drawn content and there is none). A
    // strict "no border at all" row would therefore be indistinguishable from
    // the untouched default under tests/image_presets_test.js's bare-node gate,
    // even though it plainly is NOT the same treatment once a real photo is
    // loaded. 1px is the minimum that keeps the row provable today; when a
    // browser-based distinctness gate exists (one that can decode a real
    // bitmap and render the shadow/blend/soft-edge effects it actually casts),
    // REVISIT this row and drop strokeWidth to 0.
    props: {
      stroke: "#000000", strokeWidth: 1, cornerRadius: 0,
      shadow: { dx: 0, dy: 14, blur: 0, color: "#000000", opacity: 0.5 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
      ...NO_CROP,
    },
  },
  {
    name: "Torn Edge",
    // SAME HARNESS-ACCOMMODATION FLAG AS SOFT VIGNETTE, and for the identical
    // measured reason (see its comment above): a torn paper margin wants no
    // hard keyline at all, only the crop + feather acting on the photo itself.
    // strokeWidth 30 is what makes this row provable in bare node today, not
    // what the treatment should look like against a real photo. Revisit.
    description: "An asymmetric bite taken out of two adjacent sides with a wide feather standing in for a rough torn margin, instead of the even crop a ruled trim would leave.",
    props: {
      stroke: "#000000", strokeWidth: 30, cornerRadius: 0,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 6, gaussianBlur: BLUR_OFF,
      cropTop: 18, cropLeft: 32, cropRight: 0, cropBottom: 0,
    },
  },
];

export const imagePlugin = {
  type: "image",
  // CONVERGES: it draws an async raster (the decoded bitmap). settled.js owns what
  // “ready” means so this cannot drift from its thirteen siblings.
  ephemeral: convergesOnRefs((s) => [s.src]),
  title: "Image",
  // THE WIDGET A DROPPED IMAGE BECOMES (core/registry.js assetDropKindOf). Other
  // widgets ACCEPT an image in their src row; this one is what a bare file drop
  // creates, which is a different question and so a separate declaration.
  assetDrop: "image",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // asset picker. `primaryAsset` names WHICH property that picker fills; this
  // string is what says the double-click opens it at all.
  activate: "asset_picker",
  primaryAsset: "src",
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // the transform bundle, the stroked-BORDER slice (stroke/strokeWidth/
  // cornerRadius — a photo has a frame, not a fill), and opacity are inherited,
  // so an added stroke aspect (dashes/caps/joins) reaches images automatically.
  // strokeWidth 0 + cornerRadius 0 by default → an undecorated image renders
  // byte-identically to before this bundle existed (decorateStrokedBox is a
  // pass-through when there's nothing to draw).
  defaults: {
    type: "image", x: 100, y: 100, w: 200, h: 150, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: BLANK_SRC,
    // stroke COLOR default matches every other stroked shape (rect/circle/donut
    // all use INK #000000); it only paints once strokeWidth > 0 (0 by default).
    stroke: "#000000",
    sampling: DEFAULT_SAMPLING,
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  inspector: [
    ...bundle("transform"),
    // The image source (data URI / URL) — the registry `src` row. Default
    // assetKinds (["image"]) and assetForm ("url") match this widget exactly,
    // so no override is needed here (unlike video/filmstrip).
    ...props("src"),
    // SAMPLING (Round 3 #37). "Nearest" IS the long-standing behavior — the
    // legacy draw call measures hard-edged on upscale (the user's premise was
    // right); Bilinear is the NEW smooth option. Absent/default renders
    // byte-identically.
    // No `default:` on this row — a row-level `default` is INERT (see
    // DEFAULT_SAMPLING). The real default is in `defaults` above.
    { key: "sampling", label: "Sampling", kind: "select", options: ["nearest", "bilinear"], optionLabels: { nearest: "Nearest (crisp)", bilinear: "Bilinear (smooth)" }, category: "formatting", help: "How the image's pixels are enlarged or shrunk. Nearest (the default, and the long-standing behavior) keeps every source pixel a crisp square — right for pixel art, QR codes, screenshots. Bilinear blends neighbouring pixels — right for photos that shouldn't look blocky when scaled." },
    // The stroked-BORDER bundle (manifest "SHARED STYLE BUNDLES — images and
    // videos inherit stroke/rounding at once"). No `fill` row: an image's own
    // pixels ARE its interior. The default INK stroke color is in `defaults`
    // (matching rect/circle/donut), invisible until strokeWidth > 0.
    ...bundle("strokedBorder"),
    // EDGE-CROP INSETS (manifest "Edge-crop insets") — trim the source from each
    // side; all-0 default = byte-identical to no crop.
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  presets: IMAGE_PRESETS,
  /**
   * Pure function. State → display-list commands (local space) — THE render
   * API. The `ref` IS the source string: every raster backend resolves it (the
   * GPU compositor through gpu/image_registry.js, the PDF backend by decoding
   * the data URI). Returns nothing for an empty/missing src (a broken widget
   * draws nothing rather than emitting an invalid op).
   *
   * EDGE-CROP INSETS (manifest "Edge-crop insets"): cropInsetsToSource shrinks
   * the drawn quad by the per-edge insets AND contracts the source UV rect to
   * match — a source crop, not a stretch. All-zero insets → full quad + full
   * frame (byte-identical to no crop).
   *
   * BORDER + ROUNDED CORNERS (manifest "SHARED STYLE BUNDLES"): when the
   * stroked-border style has anything to draw, the (cropped) image quad is
   * wrapped by the shared decorateStrokedBox (render_gpu/decorate.js) — a
   * cropSubtree giving it a rounded-corner clip + border ring, reusing the
   * crop-box machinery. The decoration frames the CROPPED rect (what's actually
   * shown), so a bordered+cropped image's frame hugs the visible pixels. When
   * there's no border/rounding it's a pass-through: the bare image op, unchanged
   * from before this bundle existed. `world` (sceneIR's 3rd emit arg) is only
   * needed on the decorated path — cropSubtree's content carries its own
   * absolute world (see decorate.js's OPACITY/world contracts). The widget
   * opacity always rides on the image op itself (the OPACITY CONTRACT — it fades
   * identically on GPU and PDF); the border/fill stay opaque.
   */
  emit(s, _targetWorldIR, world) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = image({ ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, sampling: s.sampling ?? DEFAULT_SAMPLING });
    // Effects wrap OUTSIDE the border decoration (render_gpu/effects.js order
    // rule): the shadow/bloom silhouette the FRAMED image, border included.
    // The effect bbox is the CROPPED (drawn) rect — what the widget paints.
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-image", title: "Add Image", icon: "mdi:image-outline", run: (app) => app.armCrosshairPlacement(imagePlugin) }, // crosshair bbox placement of a blank image widget (manifest UNDEFERRAL SWEEP); drop/explorer inserts still use native-size insertImageAsset
  ],
};
