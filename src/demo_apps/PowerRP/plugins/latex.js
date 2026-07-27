/**
 * LaTeX EQUATION widget (manifest ROUND 14.5) — a `latex` source string
 * typesets to a rendered equation on the canvas ("where is the add latex
 * equatio thing btw?" — user). `latex` is a multi-line-friendly TEXT-KIND
 * property; a chosen `fontSize` sets the equation's rendered em size and the
 * widget's w/h follow the equation's NATURAL aspect ratio (like an image sizing
 * to its native pixels).
 *
 * ── BOX SHAPE IS A GENERIC TERM (standing manifest ruling) ────────────────────
 * A typeset equation is a BOX exactly like an image or a PDF page: it composes
 * the SAME shared bundles (core/properties.js) — positioning, the stroked-BORDER
 * slice (stroke/strokeWidth/cornerRadius — a framed equation), crop insets, and
 * effects (shadow/bloom/blend) — so it inherits every current AND future box
 * feature for free, with zero widget-specific decoration code. This file is
 * deliberately near-identical to plugins/pdf_page.js/image.js; the only new
 * concerns are `latex` + `fontSize` and the typeset→bitmap pipeline underneath.
 *
 * ── HOW IT REACHES THE RENDERER (reusing the image path, not a new IR op) ─────
 * A typeset equation is a bitmap (MathJax SVG → rasterized). emit() builds a
 * plain `image()` op whose `ref` is a SYNTHETIC key from
 * render_gpu/gpu/latex_raster.js (latexRef(latex, scale)) — the GPU compositor,
 * PDF backend, and SVG backend all already resolve an image ref uniformly, so
 * this widget needs ZERO new backend code. See latex_raster.js's header for the
 * full reasoning (the engine choice — MathJax 3 SVG over KaTeX HTML — and the
 * v1 hybrid-raster stance with a TRUE-VECTOR SVG re-embed flagged as future
 * work, exactly the pdf_page precedent).
 *
 * ── SIZING RULE (fontSize drives the em; w/h follow the natural aspect) ───────
 * An equation has a NATURAL aspect ratio once typeset (MathJax's viewBox), but
 * no inherent absolute size — its size is chosen by an em/font size, like text.
 * So `fontSize` (canvas units per em) is the primary size control, and the
 * widget's w/h are DERIVED from fontSize × the natural aspect (see sizeForLatex).
 * This differs from pdf_page (which sized a fixed-aspect page to whatever w/h
 * the user dragged) and matches TEXT (a font size, natural extent) — the right
 * model for an equation, which has no canonical pixel size. On resize the app
 * may write w/h directly; emit() still rasterizes at fontSize (the em is the
 * source of truth for glyph density) and draws into the w/h box, so a manual
 * resize scales the equation (w/h win for the drawn quad; fontSize sets raster
 * crispness). The initial w/h come from fontSize once the aspect is known
 * (the app's crosshair placement + a one-shot size-to-aspect on first typeset —
 * FLAGGED to the lead: the app-side "size widget to its natural aspect once
 * measured" wiring is the same seam image.js documents for native-size insert,
 * out of this plugin's fence; until then a fresh equation uses the default w/h
 * and rasters at fontSize, then the user can fit it).
 *
 * ── RASTERIZATION SCALE (render at the displayed pixel density) ───────────────
 * emit() is pure with no viewport/dpr context (every plugin emit() has only
 * state + the node's own local `world`). "Render at the displayed pixel
 * density" is approximated the pdf_page way: rasterize at LATEX_RASTER_DENSITY
 * device px per em at this widget's OWN world-space fontSize × world.scale. A
 * resize/zoom-driven scale change lands a new rounded bucket
 * (latex_raster's LATEX_SCALE_STEP) and re-typesets; within one bucket the
 * cached bitmap is reused.
 *
 * ── ERRORS REPORT LOUDLY IN-WIDGET (task requirement) ─────────────────────────
 * A LaTeX SYNTAX error is not silent and never a blank widget: MathJax renders
 * invalid input as its own red error box (so the raster ALREADY shows the
 * error), AND once typeset lands, latex_raster.latexErrorFor(latex) returns the
 * message, so emit() switches to a LOUD VECTOR error affordance (a red-bordered
 * box + the MathJax error message text) — unmissable, in-canvas, in every
 * backend. See errorAffordance below.
 *
 * ── CONDITIONAL GHOST (manifest 13.6) ─────────────────────────────────────────
 * An EMPTY latex string (absent or whitespace-only) renders nothing and is a
 * GHOST — isGhost(state) below returns true, granting the dashed-outline/
 * findable-when-Show-Ghosts affordance, exactly like empty text and an empty
 * filmstrip. The ONE canonical "no equation" predicate (latex_raster.latexIsEmpty)
 * drives BOTH the ghost hook and emit()'s short-circuit.
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to
 * image/pdf_page, so it composites under magnifiers/blur and culls for free.
 *
 * ── ASYNC (manifest F3 + the round-12 async rule) ─────────────────────────────
 * Typeset+rasterize are async; emit() is sync and PURE (same state → same image
 * op, always). The compositor draws NOTHING for a (latex, scale) whose bitmap
 * hasn't rasterized yet and repaints when it lands (image_registry.onImageLoad —
 * latex_raster registers into that SAME registry) — no silent placeholder, no
 * blocking. A typeset/raster INFRA failure is reported loudly by latex_raster
 * (console.error), never swallowed.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { image, latexVector, rect, text } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import {
  ensureLatexTypeset, latexRef, latexAspect, latexErrorFor, latexGlyphs, latexIsEmpty,
  LATEX_RASTER_DENSITY, LATEX_DEFAULT_INK,
} from "../render_gpu/gpu/latex_raster.js";

/** The default equation for a freshly added widget — the quadratic formula, a
 * canonical "this is a math equation" example (recognizable, exercises fraction/
 * root/sub-super-script layout so a fresh widget visibly demonstrates the
 * typesetting). Replaced the instant the user edits the `latex` field. */
export const DEFAULT_LATEX = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";

/** Default em size in canvas units. Matches the text widget's default `size`
 * (36) — an equation and a line of text at the same font size read at the same
 * visual scale, the least-surprising default (linked to text.js's size:36). */
export const DEFAULT_FONT_SIZE = 36;

/** Error-affordance colors — a LOUD, unmissable red treatment (the task's "not
 * silent, not a blank widget" requirement): a clearly red-tinted fill so the
 * whole box reads as an error zone at a glance, a saturated red border, and
 * dark-red message text legible against the fill. Kept literal because the
 * error box is EDITOR/EXPORT chrome drawn via DOM-free IR (emit can't read
 * app.css --a-* tokens, the same constraint codeblock's palettes document). */
const ERROR_BG = "#f6c9c4";     // saturated pink-red — unmistakably "error", not a subtle tint
const ERROR_BORDER = "#c0392b"; // saturated danger red (the app danger convention)
const ERROR_TEXT = "#7a1210";   // deep red, legible on the pink-red fill
/** Border thickness (canvas units) of the error box — thicker than a normal
 * widget's default hairline so the error frame is loud. */
const ERROR_BORDER_WIDTH = 3;
/** Inset (canvas units) of the error message from the affordance box edge, and
 * the error text size as a fraction of the box height — plain layout values a
 * reader understands from the expression (small padding; text ~1/4 the box). */
const ERROR_PADDING = 8;
const ERROR_TEXT_FRACTION = 0.22;

/**
 * Pure function. The widget's drawn w/h derived from a font size and the
 * equation's natural size in EX units (aspect.w/aspect.h — the MathJax SVG's
 * width/height attributes, parsed by latex_raster.parseExAttr). One em is ~2 ex
 * (EX_PER_EM = 0.5), so height in canvas units = fontSize × aspect.h × 0.5, and
 * width = height × the aspect ratio (aspect.w/aspect.h). Returns null when the
 * size is not measured yet (the caller keeps its current w/h until the first
 * typeset lands).
 *
 * Args:
 *   fontSize (number): em size in canvas units
 *   aspect ({w, h} | null): natural aspect in MathJax viewBox (ex) units
 *
 * Returns:
 *   {w, h} | null
 *
 * @example sizeForLatex(36, { w: 20, h: 4 }) // {w: 360, h: 72}
 * @example sizeForLatex(36, null) // null
 */
export function sizeForLatex(fontSize, aspect) {
  if (!aspect || !(aspect.h > 0) || !(aspect.w > 0)) return null;
  const EX_PER_EM = 0.5; // 1ex ≈ 0.5em (the CSS/typographic convention, shared with latex_raster)
  const h = fontSize * aspect.h * EX_PER_EM;
  const w = h * (aspect.w / aspect.h);
  return { w, h };
}

/**
 * Pure function. The loud in-widget ERROR affordance IR: a red-bordered filled
 * box across the widget's local bbox + the MathJax error message in red. Drawn
 * as VECTOR ops (rect + text) so it is crisp and shows identically in every
 * backend — never a blank widget, never console-only (the task requirement).
 *
 * Args:
 *   w, h (number): the widget's local box size
 *   message (string): the MathJax error message
 *
 * Returns:
 *   object[]: IR ops (a red rect + the message text)
 *
 * @example errorAffordance(200, 60, "Undefined control sequence").length // 2
 * @example errorAffordance(200, 60, "err")[0].op // "rect"
 */
export function errorAffordance(w, h, message) {
  const box = rect({ x: 0, y: 0, w, h, cornerRadius: 0, fill: ERROR_BG, stroke: ERROR_BORDER, strokeWidth: ERROR_BORDER_WIDTH });
  const size = Math.max(1, h * ERROR_TEXT_FRACTION);
  const label = text({
    text: `LaTeX error: ${message}`,
    x: ERROR_PADDING, y: ERROR_PADDING,
    size, color: ERROR_TEXT,
    boxW: Math.max(1, w - 2 * ERROR_PADDING), boxH: Math.max(1, h - 2 * ERROR_PADDING),
  });
  return [box, label];
}

export const latexPlugin = {
  type: "latex",
  title: "LaTeX Equation",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): the
  // WYSIWYG equation editor (a MathLive DOM overlay plus canvas suppression —
  // MathJax has no caret to self-draw, so unlike text this one is NOT Skia-owned).
  activate: "latex_edit",
  /**
   * Pure function. Is this equation currently a GHOST (manifest 13.6 CONDITIONAL
   * GHOSTS)? STATE-dependent — a latex widget is a ghost only while its source
   * is empty (latexIsEmpty is the canonical predicate, shared with emit()'s
   * short-circuit and latex_raster). core/derive.isGhostNode calls this hook to
   * grant the dashed-outline/findable-when-Show-Ghosts affordance exactly while
   * the widget would otherwise render nothing.
   *
   * @example latexPlugin.isGhost({ latex: "" })
   * true
   * @example latexPlugin.isGhost({ latex: "x^2" })
   * false
   */
  isGhost(state) {
    return latexIsEmpty(state.latex);
  },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY — positioning,
  // stroked BORDER (a framed equation, not a fill), crop insets, effects are all
  // inherited (manifest "BOX SHAPE IS A GENERIC TERM"). Only `latex` + `fontSize`
  // are widget-specific (declared inline below, exactly as codeblock declares
  // its own `code`/`language`/`theme` — widget-specific props do NOT belong in
  // the cross-widget core/properties.js registry).
  defaults: {
    type: "latex", x: 100, y: 100, w: 360, h: 72, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    latex: DEFAULT_LATEX,
    fontSize: DEFAULT_FONT_SIZE,
    // PRESERVE ASPECT (default ON, user directive): the equation UNIFORM-scales
    // to FIT the widget box (centered/letterboxed), never squashing to the box
    // aspect. OFF reverts to the legacy non-uniform box→box stretch (a resized
    // box then distorts the equation). Threaded into the latexVector op so the
    // live render AND the SVG/PDF vector exports all honor it identically.
    preserveAspect: true,
    // INK — the equation glyph color (Round 15.4 "why cant i choose the color
    // for latx"). Keyframable like any color property; default = the INK
    // convention every stroked shape / the text widget uses (LATEX_DEFAULT_INK
    // #000000), so a fresh equation reads the same color as default text. Drives
    // BOTH the raster (baked into the tinted bitmap, in the cache key) AND the
    // vector export (the SVG <path> / PDF fill color).
    ink: LATEX_DEFAULT_INK,
    // stroke COLOR default matches every other stroked shape (INK); paints only
    // once strokeWidth > 0 (0 by default → an undecorated equation is byte-
    // identical to the bare image op).
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    // THE latex source — a multi-line STRING. Uses the "text" row kind (a
    // single-line field that round-trips the whole string), the EXACT precedent
    // codeblock.js's `code` row set: a dedicated multi-line math editor control
    // (a textarea, or an interactive equation editor) is future work; the string
    // travels + typesets fully regardless of the editor control. FLAG: no new
    // shared row kind was added (the Inspector's default text input handles
    // "text"); a real multi-line editor is a shared UI follow-up, flagged to the
    // lead like codeblock's same flag.
    { key: "latex", label: "LaTeX", kind: "text", category: "text", help: "The equation source in LaTeX math syntax (e.g. \\frac{a}{b}, x^2, \\sqrt{n}). Invalid syntax shows a red error box on the canvas with the message." },
    // Font size (em) — the equation's rendered scale, like a text box's size.
    // The widget's natural w/h follow from this × the equation's aspect ratio.
    { key: "fontSize", label: "Font size", kind: "number", min: 1, category: "text", help: "The equation's rendered size in canvas units per em (like a text font size). Larger typesets the equation bigger; the box grows to fit." },
    // Aspect-preservation toggle (default ON). ON = uniform scale-to-fit,
    // centered in the box (no squash). OFF = stretch to fill the box aspect.
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the equation uniformly to fit the box (centered, no distortion). Turn off to stretch it to the box's exact width and height." },
    // INK — the glyph color (Round 15.4). A standard color row (kind "color",
    // like text's Color / rect's Fill), keyframable; drives the live raster tint
    // AND the SVG/PDF vector fill.
    { key: "ink", label: "Color", kind: "color", category: "formatting", help: "The color of the equation's glyphs. Applies live and in SVG/PDF vector export (where the equation is real vector paths)." },
    // The stroked-BORDER bundle (a framed equation) — no `fill` row: the
    // equation's own glyphs ARE its interior, like an image/pdf page.
    ...bundle("strokedBorder"),
    // EDGE-CROP INSETS — trim the rendered equation from each side.
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (kicks idempotent async typeset/raster as a side effect;
   * the RETURNED IR is a pure function of state — same state, same op, always).
   * State → display-list commands (local space).
   *
   * GHOST short-circuit (manifest 13.6): an empty latex draws NOTHING (returns
   * []) — matching isGhost above so editor-ghostness and render-exclusion agree
   * (the ghost model forbids a ghost having rendered volume in any backend).
   *
   * ERROR short-circuit (task requirement): once typeset, if the latex had a
   * syntax error (latexErrorFor non-null), draw the LOUD vector error affordance
   * instead of the (MathJax-error-box) raster — unmissable, in every backend.
   *
   * SCALE: LATEX_RASTER_DENSITY device px per em at this widget's fontSize ×
   * world.scale (the rasterScale precedent), rounded into a cache bucket by
   * latex_raster.
   */
  emit(s, _targetWorldIR, world) {
    const latex = s.latex;
    if (latexIsEmpty(latex)) return []; // GHOST — draws nothing (isGhost grants the editor affordance)
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw

    const worldScale = world?.scale ?? 1;
    const fontSize = s.fontSize ?? DEFAULT_FONT_SIZE;
    const scale = worldScale * fontSize; // px-per-em bucket the raster keys on (density applied inside latex_raster)
    const ink = s.ink ?? LATEX_DEFAULT_INK; // Round 15.4 — the glyph color (raster tint + vector fill)
    ensureLatexTypeset(latex, scale, ink); // idempotent; safe every emit()

    // ERROR AFFORDANCE: once the typeset resolved and reported a syntax error,
    // draw the loud red box+message (vector) rather than the raster. Before the
    // typeset lands latexErrorFor is null → we optimistically draw the raster
    // (which will BE the MathJax red box until the affordance takes over on the
    // repaint-on-load), so an error is NEVER shown as a blank widget.
    const errMsg = latexErrorFor(latex);
    if (errMsg) {
      const errStyle = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
      // errorAffordance emits local-space rect/text ops (own x/y); shift them by
      // the crop origin so the affordance aligns with where the equation draws.
      const shifted = errorAffordance(c.w, c.h, errMsg).map((op) =>
        op.op === "rect" || op.op === "text" ? { ...op, x: op.x + c.x, y: op.y + c.y } : op);
      return applyEffects(decorateStrokedBox(shifted, errStyle, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
    }

    const ref = latexRef(latex, scale, ink);
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    // TRUE VECTOR (Round 15.1): once the glyph geometry is flattened (browser-
    // side, async — null until the first typeset lands), emit a `latexVector` op
    // carrying BOTH the ink-tinted `glyphs` (SVG/PDF embed real vector paths, ink
    // as fill) AND the raster `ref` (the GPU live view + the HYBRID RULE raster
    // fallback draw the tinted bitmap — a latex under a blur rasterizes like
    // text). Before glyphs land, degrade to the plain raster `image` op (draws
    // the bitmap; a repaint re-emits the vector op once glyphs are cached) — the
    // async no-silent-placeholder contract, identical to how the raster itself
    // arrives. Glyph geometry is ink-independent; the fill is applied here.
    // A cropped equation (edge-crop insets shrink the source sub-rect below full
    // frame) stays RASTER: the vector glyph op draws all glyphs mapped into the
    // box, with no source-sub-rect clip, so it can't represent a partial crop —
    // rasterizing (which honors sx/sy/sw/sh) is the faithful, no-divergence
    // choice, exactly the hybrid rule's "what can't cleanly vectorize, rasterize".
    const cropped = c.sw < 1 || c.sh < 1 || c.sx > 0 || c.sy > 0;
    const geom = cropped ? null : latexGlyphs(latex);
    const quad = geom
      ? latexVector({
          ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1,
          sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh,
          viewBox: geom.viewBox,
          glyphs: geom.glyphs.map((g) => ({ d: g.d, fill: ink })),
          preserveAspect: s.preserveAspect !== false, // default ON (user directive)
        })
      : image({ ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });
    // Effects wrap OUTSIDE the border decoration (render_gpu/effects.js order
    // rule): the shadow/bloom silhouette the FRAMED equation, border included.
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  // The natural-aspect hook: the app can call this after a typeset lands to
  // fit the widget to the equation's aspect at its fontSize (the image.js
  // native-size-insert seam). Returns null until the aspect is measured.
  naturalSize(state) {
    return sizeForLatex(state.fontSize ?? DEFAULT_FONT_SIZE, latexAspect(state.latex));
  },
  commands: [
    { id: "add-latex", title: "Add LaTeX", icon: "mdi:function-variant", run: (app) => app.armCrosshairPlacement(latexPlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP), matching image/pdf_page's own add command
  ],
};
