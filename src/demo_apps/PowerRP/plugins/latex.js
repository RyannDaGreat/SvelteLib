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
 * the SAME shared bundles (core/properties.js) — transform, the stroked-BORDER
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

import { convergesOnRefPrefixes } from "../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { morphPayloadFromViewBox } from "../core/morph_payload.js";
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

/**
 * The ink an equation is TYPESET at when its real ink is a shader (a gradient or
 * a material). The raster then serves as a pure ALPHA MASK: white is the neutral
 * multiplicand, so the shader's own colour survives the mask composite unchanged
 * (`shader × 1`), where any tinted mask would multiply a cast into it. It is also
 * ONE cache key for every shader ink, so switching material or dragging a gradient
 * stop re-keys nothing and re-typesets nothing — only the paint on top changes.
 */
const LATEX_MASK_INK = "#ffffff";

/**
 * Pure function. Is this stored ink a SHADER paint (a gradient or a material)
 * rather than a plain colour? A shader ink is the one that CANNOT be baked into
 * the raster: it has no colour to typeset at and no string to key the cache on,
 * so it diverts the equation onto the neutral-mask path and is painted through
 * the glyph coverage instead.
 *
 * ── CLASSIFY BY PAINT KIND, NOT BY `typeof` (WORKSTREAM AB) ──────────────────
 * This predicate used to read "is an object", which was a true description of
 * the paints that EXISTED when it was written and a false statement of the
 * question it is actually asking. The PaintField stores a SOLID as the wrapper
 * `{type:"solid", solid:"#rrggbb", linear?, radial?}` — multi-sub-state, so
 * switching mode never forgets the other modes — and that wrapper is an object
 * whose type is neither "none" nor a gradient. So every solid an author set
 * through the Fill row was classified as a shader, typeset at the white mask,
 * and handed to `drawLatexShaderInk`, where `parsePaint` correctly resolved it
 * to an [r,g,b,a] COLOUR and `skShaderForPaint` then refused it by name:
 * "expected a gradient Paint (solid paints use setColor, not a shader)". The
 * node run boundary turned that throw into the "failed to paint" error box.
 *
 * That is exactly why the reported matrix was everything-but-the-simplest-case
 * (user, 2026-08-02: "Why does solid result in unknown item failed to paint, but
 * linear is fine, radial is fine, off is fine, and even arbitrary materials are
 * fine on LaTeX?"). Gradients and materials are genuinely shaders; OFF was
 * special-cased out by tag; a LEGACY bare-string solid was excluded by `typeof`.
 * A wrapped solid was the one shape that satisfied the object test while not
 * being a shader — the simplest case, and the only broken one.
 *
 * A solid is a COLOUR in every form it is stored in, so both forms take the
 * legacy raster-tint path and render byte-identically to each other.
 *
 * @param {*} ink - the item's stored `ink`
 * @returns {boolean}
 *
 * @example isShaderInk("#000000") // false (legacy bare-string solid)
 * @example isShaderInk(undefined) // false (absent ⇒ the default solid)
 * @example isShaderInk({type: "solid", solid: "#c0392b"}) // false (the PaintField wrapper is still a solid)
 * @example isShaderInk({type: "material", material: {id: "metal"}}) // true
 * @example isShaderInk({type: "linearGradient", linear: {stops: []}}) // true
 * @example isShaderInk({type: "none"}) // false (OFF paints nothing; not a shader)
 */
export function isShaderInk(ink) {
  if (!ink || typeof ink !== "object" || Array.isArray(ink)) return false;
  return ink.type !== "none" && ink.type !== "solid";
}

/**
 * Pure function. THE STORED INK AS A COLOUR STRING — the one place the two solid
 * forms become one value, so nothing downstream has to know there are two.
 *
 * A solid reaches this widget in either of two shapes: the LEGACY bare string
 * every document written before the Fill row became PAINT-capable stores, and
 * the PaintField's multi-sub-state wrapper `{type:"solid", solid:"#rrggbb"}`.
 * Both mean the same colour. This matters here and not merely in the painter
 * because a latex ink is not only drawn, it is BAKED AND KEYED: latex_raster
 * interpolates it into the raster cache key and sets it as the typeset SVG's
 * `color`. Handing the wrapper to either would key every equation under the
 * literal string "[object Object]" — one cache slot shared by every colour — and
 * set an invalid CSS colour, so the glyphs would typeset at the browser's
 * default black no matter what the author picked.
 *
 * Returns the fallback for anything that is not a solid (a shader ink, OFF, or
 * an absent ink), because each of those has its own path and only ever wants a
 * neutral colour from this function.
 *
 * @param {*} ink - the item's stored `ink`
 * @param {string} fallback - the colour to use when `ink` is not a solid
 * @returns {string} a CSS colour string
 *
 * @example inkColor("#c0392b", "#111111") // '#c0392b'  (legacy bare string)
 * @example inkColor({type: "solid", solid: "#c0392b"}, "#111111") // '#c0392b'  (the wrapper unwraps to the same colour)
 * @example inkColor(undefined, "#111111") // '#111111'  (absent ⇒ the widget default)
 * @example inkColor({type: "linearGradient", linear: {stops: []}}, "#ffffff") // '#ffffff'  (a shader typesets at the neutral mask)
 */
export function inkColor(ink, fallback) {
  if (typeof ink === "string") return ink;
  if (ink && typeof ink === "object" && ink.type === "solid" && typeof ink.solid === "string") return ink.solid;
  return fallback;
}

/**
 * Pure function. How many viewBox units one BOX unit is worth for this equation —
 * the factor that turns an author's canvas-unit glyph-outline width into the
 * viewBox-unit width the painter must stroke with.
 *
 * ── WHY THIS CONVERSION HAS TO EXIST ─────────────────────────────────────────
 * The two spaces are genuinely different and both are load-bearing. A MathJax
 * equation's glyph `d` strings live in the typeset viewBox (thousands of units per
 * em); the painter draws them under a viewBox→box CTM established by
 * drawLatexVector. Meanwhile the author types "2" into an Outline width row that
 * means canvas units on every other widget in the app. Handing that 2 straight to
 * the painter would multiply it by the CTM, so the same "2" would draw a hairline
 * on a small equation and a slab on a large one — a width row that silently means
 * something different per box size. Dividing it out here makes the number mean what
 * the row says it means.
 *
 * It is the RECIPROCAL of the mapping drawLatexVector applies, derived from the
 * same two branches so the pair cannot drift: preserveAspect uses fitBox's single
 * uniform scale, and the stretch path uses the box→box x/y scales — which are
 * unequal, so a stroke on a squashed equation is anisotropic and no single number
 * is exactly right. The GEOMETRIC MEAN is used there: it is the factor that
 * preserves stroke AREA under the anisotropic map, so the outline reads at the
 * intended visual weight instead of matching one axis and being wrong on the other.
 *
 * Args:
 *   viewBox ({minX, minY, w, h}): the typeset equation's viewBox
 *   boxW (number): the widget's drawn width in canvas units
 *   boxH (number): the widget's drawn height in canvas units
 *   preserveAspect (boolean): the widget's own aspect setting
 *
 * Returns:
 *   number: viewBox units per box unit (multiply a canvas-unit width by this)
 *
 * @example // a 1000x500 viewBox fit into a 100x50 box: 10 viewBox units per box unit
 * @example latexBoxToViewBoxScale({minX: 0, minY: 0, w: 1000, h: 500}, 100, 50, true) // 10
 * @example // the box is TALLER than the aspect wants, so fitBox is limited by WIDTH:
 * @example latexBoxToViewBoxScale({minX: 0, minY: 0, w: 1000, h: 500}, 100, 200, true) // 10
 * @example // stretched into a squashed box — the geometric mean of 10 and 5:
 * @example latexBoxToViewBoxScale({minX: 0, minY: 0, w: 1000, h: 500}, 100, 100, false) // 7.0710678118654755
 */
export function latexBoxToViewBoxScale(viewBox, boxW, boxH, preserveAspect) {
  if (preserveAspect) {
    // fitBox's scale is box-per-viewBox; this function answers the other way round.
    const fit = Math.min(boxW / viewBox.w, boxH / viewBox.h);
    return fit > 0 ? 1 / fit : 0;
  }
  return Math.sqrt((viewBox.w / boxW) * (viewBox.h / boxH));
}

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

/**
 * EQUATION LIBRARY — the LaTeX source IS the whole payload, the way mermaid's demo
 * presets write `definition`. A content preset is legitimate exactly where the
 * content is FORMAL PUBLIC VOCABULARY the author would otherwise have to look up,
 * and illegitimate where it is their own writing: nobody remembers the LaTeX for
 * the Dirac equation, and that is the whole difference between this table and the
 * sibling text widgets, none of which get a content preset.
 *
 * A TITLED FAMILY rather than the flat form, for mermaid's stated reason: the group
 * heading is the ONLY signal a user gets that these presets REPLACE what is in the
 * field. Hovering shows the replacement live before any commit, and a click is one
 * undo — but nothing in the preset descriptor marks a family as destructive, so the
 * name of the group is doing that work.
 *
 * ORDERED BY DISCIPLINE, elementary to specialised: identities and geometry,
 * calculus, linear algebra, probability and information, then physics. That is the
 * order the material is taught in, and it keeps the one genuinely tall four-line
 * block among the physics rows instead of stranded mid-list. The comment on each
 * row is its MEASURED aspect ratio, which matters because a preset cannot resize
 * the box and an author picking by SHAPE needs it.
 *
 * THREE MACRO CLASSES ARE UNUSABLE HERE AND NONE APPEARS BELOW:
 *   AUTOLOAD-ONLY macros (\boldsymbol, \color, \cancel, \braket, \bm, and the whole
 *     `physics` package) make MathJax throw from the SYNCHRONOUS tex2svg call this
 *     widget makes, and latex_raster latches that key as an error and never
 *     retries — so such a preset is permanently broken, not intermittently.
 *   UNDEFINED macros are worse, because they are SILENT. \oiint does not exist, so
 *     the textbook form of the divergence theorem is unreachable; MathJax emits the
 *     macro's own name as ordinary glyphs inside a perfectly well-formed,
 *     correctly-sized SVG and produces NO merror node, so latexErrorFor returns
 *     null and the loud red affordance never fires. Measured in the booted editor:
 *     it renders as the literal text "\oiint" — and in the widget's OWN ink, since
 *     the tint is applied to every glyph, so even MathJax's red is painted over.
 *     Every source below was rendered and LOOKED AT for that reason, and
 *     tests/latex_presets_probe.js re-checks all of them through the page's own
 *     MathJax on every run.
 *   \tag{} makes MathJax emit width="100%" instead of an ex value, which breaks
 *     parseExAttr and therefore the widget's aspect. Nothing here is numbered,
 *     which also matches the style guidance: AMS and IEEE disagree on where an
 *     equation number even goes, so it is a cross-reference device rather than a
 *     legibility one, and a slide figure has nothing to cross-reference.
 * `\\` does nothing outside an environment — MathJax 3 has no automatic line
 * breaker — so every multi-line entry below uses `aligned`.
 *
 * THE QUADRATIC FORMULA IS ABSENT ON PURPOSE: it is already DEFAULT_LATEX, so a
 * preset for it would be byte-identical to the un-hovered baseline — a dead row by
 * the distinctness rule's own definition.
 *
 * FIVE FAMOUS EQUATIONS WERE CUT ON SHAPE ALONE, not on interest: the Drake
 * equation, Hardy-Weinberg, the covariance definition, the Big-O definition and the
 * one-line Standard Model Lagrangian all measure between 13:1 and 23:1, and at
 * those proportions they are ribbons that need the full slide width. Several have
 * `aligned` variants that would fit; those are a second pass.
 */
const LATEX_EQUATIONS = [
  { name: "Euler's Identity", description: "The five constants in one relation — e, i, pi, one and zero — and the most quoted equation in mathematics.",
    props: { latex: "e^{i\\pi} + 1 = 0" } }, // 4.9:1
  { name: "The Pythagorean Theorem", description: "The right triangle, in fifteen characters: the oldest equation most audiences can read without being told what it is.",
    props: { latex: "a^2 + b^2 = c^2" } }, // 5.4:1
  { name: "The Golden Ratio", description: "Phi as the positive root of x squared minus x minus one — a radical over a fraction, and a good demonstration that the typesetting stacks.",
    props: { latex: "\\varphi = \\frac{1 + \\sqrt{5}}{2} \\approx 1.618" } }, // 3.9:1
  { name: "The Definition Of The Derivative", description: "The limit of the difference quotient — the first real definition in calculus, and the one slide that explains what a derivative IS.",
    props: { latex: "f'(x) = \\lim_{h \\to 0}\\frac{f(x+h) - f(x)}{h}" } }, // 5.6:1
  { name: "The Gaussian Integral", description: "The Euler-Poisson integral: the bell curve's total area is the square root of pi, which is why pi appears in the normal distribution at all.",
    props: { latex: "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}" } }, // 3.4:1
  { name: "The Basel Problem", description: "The sum of the reciprocal squares equals pi squared over six — Euler's 1734 result, and a compact, nearly square block.",
    props: { latex: "\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}} = \\frac{\\pi^{2}}{6}" } }, // 2.1:1
  { name: "A Three-By-Three Matrix", description: "A general square matrix with subscripted entries — the structural preset, for when the slide is about the SHAPE rather than a particular result.",
    props: { latex: "A = \\begin{pmatrix} a_{11} & a_{12} & a_{13} \\\\ a_{21} & a_{22} & a_{23} \\\\ a_{31} & a_{32} & a_{33} \\end{pmatrix}" } }, // 2.6:1
  { name: "A Piecewise Definition", description: "The absolute value written as two cases — the brace-and-cases layout every piecewise function on a slide needs.",
    props: { latex: "|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}" } }, // 3.3:1
  { name: "The Normal Distribution", description: "The Gaussian density in full: the normalising constant, the squared standardised deviation, and every piece of notation a statistics talk needs on one line.",
    props: { latex: "f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}}\\, e^{-\\frac{1}{2}\\left(\\frac{x-\\mu}{\\sigma}\\right)^{2}}" } }, // 4.3:1
  { name: "Bayes' Theorem", description: "How a belief updates on evidence — the likelihood times the prior over the marginal, in the conditional-bar notation.",
    props: { latex: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}" } }, // 4.9:1
  { name: "Shannon Entropy", description: "The average information content of a source, in bits — the equation information theory is built on.",
    props: { latex: "H(X) = -\\sum_{i=1}^{n} p(x_i)\\log_2 p(x_i)" } }, // 4.6:1
  { name: "The Fourier Transform", description: "The ordinary-frequency, unitary form: a signal decomposed into complex exponentials. The angular-frequency convention differs by a factor of two pi.",
    props: { latex: "\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\,e^{-2\\pi i x\\xi}\\,dx" } }, // 4.8:1
  { name: "Scaled Dot-Product Attention", description: "The transformer's attention operation — queries against keys, scaled by the square root of the key dimension, softmaxed onto values.",
    props: { latex: "\\operatorname{Attention}(Q,K,V) = \\operatorname{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V" } }, // 7.2:1
  { name: "Mass-Energy Equivalence", description: "Ten characters, and the most recognisable equation in physics. Its short, wide shape makes it the best row for checking how a box reads before you commit to a layout.",
    props: { latex: "E = mc^{2}" } }, // 4.0:1
  { name: "The Lorentz Factor", description: "The relativistic stretch factor — a nested fraction inside a radical, and the TALLEST single-line equation here, so it is the one that tests a short box.",
    props: { latex: "\\gamma = \\frac{1}{\\sqrt{1 - \\dfrac{v^{2}}{c^{2}}}}" } }, // 1.7:1
  { name: "The Schrodinger Equation", description: "The time-dependent form in operator notation: how a quantum state evolves, with the reduced Planck constant out front.",
    props: { latex: "i\\hbar\\frac{\\partial}{\\partial t}\\Psi(\\mathbf{r},t) = \\hat{H}\\Psi(\\mathbf{r},t)" } }, // 4.8:1
  { name: "The Dirac Equation", description: "Relativistic quantum mechanics in one line, gamma matrices and all — the equation that predicted antimatter.",
    props: { latex: "\\left(i\\hbar\\gamma^{\\mu}\\partial_{\\mu} - mc\\right)\\psi = 0" } }, // 8.4:1
  { name: "Maxwell's Equations", description: "All four in differential form, in metric units — the only genuinely TALL preset here, so give it a box that is nearly as high as it is wide.",
    props: { latex: "\\begin{aligned} \\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\ \\nabla \\cdot \\mathbf{B} &= 0 \\\\ \\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\ \\nabla \\times \\mathbf{B} &= \\mu_0\\left(\\mathbf{J} + \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}\\right) \\end{aligned}" } }, // 1.4:1
];

/**
 * EQUATION TREATMENT — how the typeset equation is PRESENTED, independent of what
 * it says. Key-disjoint from LATEX_EQUATIONS above, so a formula and a treatment
 * compose in either order.
 *
 * `fontSize` IS NOT IN THIS TABLE, AND THAT IS THE MOST IMPORTANT THING ON THIS
 * PAGE, because the obvious design writes it and would be writing a knob that
 * CANNOT MOVE A PIXEL. Read off emit() below: the quad is placed at the WIDGET BOX
 * (c.w x c.h) and drawn with preserveAspect, so the glyph paths are fit to the box;
 * fontSize reaches only the raster density bucket the bitmap is cached under, and
 * `naturalSize` — the hook that WOULD grow the box from it — has no caller anywhere
 * in web/ or core/. Measured in the booted editor at a fixed 900x420 box, one
 * equation, fontSize 22 against 200: maxAbs 0, BYTE-IDENTICAL, while the ink
 * control over the same pair of frames moved 175. So a size-ordered treatment
 * library would have been ordered by an axis nothing can see, and every "at display
 * scale" / "sized to be read only if you go looking" clause would have been a
 * confident false claim. Recorded as a product defect in its own right: the Font
 * size row's own help text promises "the box grows to fit", and it does not.
 *
 * TEN, AND THAT IS THE HONEST NUMBER once size is gone. What is left is the ink,
 * the frame (colour, width, corner), the opacity and the effects — and ten
 * recognisable presentations is what those axes hold. Padding past it would only
 * add rows separated by a hex value.
 *
 * ORDERED FROM THE LEAST INTERVENTION TO THE MOST: the unframed inks first, from
 * the scholarly baseline outward through the quiet aside, the correction and the
 * two light-ground treatments; then the three framed ones; then the row that takes
 * the equation out of the reading order entirely.
 *
 * NO BLOOM ANYWHERE, and it is written off in every row rather than omitted. An
 * equation is TYPESET MATHEMATICS, not an instrument and not a sign: it has no
 * emission to model, and neither AMS nor IEEE style has anything resembling a
 * glowing equation, so a glowing row would be decoration with no referent. `shadow`
 * earns its one appearance on a different ground — it is the caption-legibility
 * device, which is a real thing an equation over footage needs. The remaining
 * effects are written off for the overlay reason, not because they are ornamental.
 *
 * THE LIGHT-INK ROWS ASSUME A DARK SLIDE and say so, because this widget has no
 * fill of its own — it composes the stroked BORDER slice, not the box — so a pale
 * ink is simply invisible on a pale ground and nothing can check it.
 */
const LATEX_TREATMENT = [
  {
    name: "Printed Black",
    description: "The default scholarly setting: a true printing black, unframed, fully opaque. The baseline every other row here is measured against.",
    props: {
      ink: "#111111", stroke: "#000000", strokeWidth: 0, cornerRadius: 0, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Quiet Aside",
    description: "A muted grey with no frame — for the inline identity or the unit check that has to be present without competing with the result it supports.",
    props: {
      ink: "#4b5563", stroke: "#000000", strokeWidth: 0, cornerRadius: 0, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Red Correction",
    description: "Marked in red, unframed — the derivation step being challenged, or the term the talk is about to fix.",
    props: {
      ink: "#c0392b", stroke: "#000000", strokeWidth: 0, cornerRadius: 0, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Board Chalk",
    description: "Warm off-white at just under full opacity, unframed, the way an equation is written on a board. FOR A DARK SLIDE — this widget has no background of its own, so a pale ink vanishes on a pale ground.",
    props: {
      ink: "#f2ede4", stroke: "#000000", strokeWidth: 0, cornerRadius: 0, opacity: 0.95,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Projected White",
    description: "White with a tight solid shade all round and no frame — the subtitle treatment applied to mathematics, so the equation survives whatever photograph or footage is behind it.",
    props: {
      ink: "#ffffff", stroke: "#000000", strokeWidth: 0, cornerRadius: 0, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 5, color: "#000000", opacity: 1 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Boxed Theorem",
    description: "A ruled box around the result, square-cornered and in the same ink as the mathematics — the way a textbook fences off a statement worth remembering.",
    props: {
      ink: "#111111", stroke: "#111111", strokeWidth: 2, cornerRadius: 0, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Rounded Callout",
    description: "A navy ink inside a soft blue rounded frame — a note pulled out of the flow rather than a theorem stated.",
    props: {
      ink: "#1a3a6b", stroke: "#9fb8dd", strokeWidth: 2, cornerRadius: 12, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Blueprint Line",
    description: "A cold near-white equation in a thin steel-blue rule, square-cornered. FOR A DARK OR CYANOTYPE GROUND.",
    props: {
      ink: "#e8f1ff", stroke: "#7fa8d8", strokeWidth: 1, cornerRadius: 0, opacity: 0.95,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Gold Frame",
    description: "An old-gold equation inside a matching three-unit frame with a small corner — the presentation an award or a title plate would give a formula. FOR A DARK SLIDE.",
    props: {
      ink: "#c9a227", stroke: "#c9a227", strokeWidth: 3, cornerRadius: 4, opacity: 1,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
  {
    name: "Ghost Equation",
    description: "Eight percent black, unframed — the formula sitting behind the content as texture rather than as something anyone is asked to read.",
    props: {
      ink: "#000000", stroke: "#000000", strokeWidth: 0, cornerRadius: 0, opacity: 0.08,
      blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      gaussianBlur: 0,
    },
  },
];

export const latexPlugin = {
  type: "latex",
  // CONVERGES: it draws an async raster (the MathJax raster). BY NAMESPACE, not by
  // exact ref: latexRef(latex, scale, ink) folds in a `scale` emit() derives from
  // the live camera, which a settled(state) predicate never sees — see
  // convergesOnRefPrefixes for the measured defect this replaces (`s.__latexRef`
  // was never assigned by anything, so this widget declared itself permanently
  // settled).
  ephemeral: convergesOnRefPrefixes(["latex:"]),
  title: "LaTeX Equation",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // TWO key-DISJOINT families: the source and its presentation compose in either
  // order. The equation family is TITLED (the mermaid form) because that heading is
  // the only signal a user gets that picking one REPLACES the source they typed.
  presetFamilies: [
    { id: "equations", title: "Equation library", presets: LATEX_EQUATIONS },
    { id: "treatment", title: "Equation treatment", presets: LATEX_TREATMENT },
  ],
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): the
  // WYSIWYG equation editor (a MathLive DOM overlay plus canvas suppression —
  // MathJax has no caret to self-draw, so unlike text this one is NOT Skia-owned).
  // Double-click keeps opening the WYSIWYG equation editor; the Monaco code editor
  // is offered as the `{}` button ON THE LaTeX ROW ITSELF (the `code` row aspect
  // below) for editing the raw LaTeX SOURCE, which is the "lots of code" surface
  // the reusable modal targets.
  activate: "latex_edit",
  // THE code-editor descriptor (ROUND 2 #33): the `edit-code-source` command reads
  // this to open the reusable Monaco modal on the `latex` source with LaTeX syntax
  // highlighting. Distinct from the WYSIWYG `activate` editor — same widget, two
  // ways in (structural math field vs. raw source), the user's choice.
  codeEditor: { property: "latex", language: "latex", title: "Edit LaTeX Source" },
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
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY — transform,
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
    ...bundle("transform"),
    // THE latex source — a multi-line STRING. Uses the "text" row kind (a
    // single-line field that round-trips the whole string), the EXACT precedent
    // codeblock.js's `code` row set: a dedicated multi-line math editor control
    // (a textarea, or an interactive equation editor) is future work; the string
    // travels + typesets fully regardless of the editor control. FLAG: no new
    // shared row kind was added (the Inspector's default text input handles
    // "text"); a real multi-line editor is a shared UI follow-up, flagged to the
    // lead like codeblock's same flag.
    // THE CODE BUTTON, now A ROW ASPECT rather than a row of its own — the LAST
    // of the five full-width "Edit in code editor…" action rows to migrate (the
    // other four went in f1af0e3). `code: {language}` puts a `{}` button at the
    // END OF THIS ROW, where that action row used to sit underneath it. Same ask
    // (ROUND 2 #33), same editor, same `latex` property; only the shape changed.
    // See core/properties.js's THE `code` ROW ASPECT.
    { key: "latex", label: "LaTeX", kind: "text", category: "text", code: { language: "latex" }, help: "The equation source in LaTeX math syntax (e.g. \\frac{a}{b}, x^2, \\sqrt{n}). Edit inline here, in the full-screen code editor behind the {} button at the end of this row, or in the WYSIWYG editor by double-clicking the equation. Invalid syntax shows a red error box on the canvas with the message." },
    // Font size (em) — the equation's rendered scale, like a text box's size.
    // The widget's natural w/h follow from this × the equation's aspect ratio.
    { key: "fontSize", label: "Font size", kind: "number", min: 1, category: "text", help: "The equation's rendered size in canvas units per em (like a text font size). Larger typesets the equation bigger; the box grows to fit." },
    // Aspect-preservation toggle (default ON). ON = uniform scale-to-fit,
    // centered in the box (no squash). OFF = stretch to fill the box aspect.
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Scale the equation uniformly to fit the box (centered, no distortion). Turn off to stretch it to the box's exact width and height." },
    // INK — the glyph paint (Round 15.4; PAINT-capable since N1). `paint: true` is
    // the whole declaration that makes a colour row a PaintField instead of a plain
    // ColorField, so the equation's ink now offers the same Off/Solid/Linear/Radial/
    // Mat/=Eq strip every shape fill does — a material equation is exactly a
    // material shape fill, masked by the glyph outlines rather than a rectangle.
    //
    // ABSENT-IS-LEGACY: a stored ink is a STRING for every document written before
    // this, and a string still takes the raster-tint path byte-identically (the
    // material branch is entered only by an object paint), so nothing re-renders.
    // IT USED TO SAY "Color" HERE TOO, and the user named the same gap for both
    // widgets in one breath (2026-08-02): "LaTeX should have both stroke and fill
    // material… what if I wanted to have, let's say, like a glassy version of text
    // or glassy version of LaTeX". The row is the equation's FILL — the same slot a
    // shape spends on `fill` — so it now says so, in the shared "Fill Material"
    // group rather than under generic formatting. The KEY stays `ink` (renaming it
    // would migrate every document that ever set an equation colour).
    { key: "ink", label: "Fill", kind: "color", paint: true, category: "fillMaterial", offMeans: "the equation's glyphs are not painted, so nothing of it shows", help: "How the equation's glyphs are painted: a solid color, a linear/radial gradient, or a MATERIAL (brass, glass, comic halftone…). A solid color also applies in SVG/PDF vector export (where the equation is real vector paths); a gradient or material rasterizes there." },
    // THE GLYPH OUTLINE — around the LETTERFORMS, which is emphatically not the
    // `stroke` row below it. That one frames the BOX; this one traces the
    // mathematics. Both exist on this widget at once, which is exactly why the
    // glyph pair could not reuse the `stroke`/`strokeWidth` keys and is named
    // `glyphStroke` here and on plugins/plaintext.js alike (one word, one concept,
    // two widgets). Default OFF, absent-is-legacy — no default is declared, so a
    // pre-N2 equation has neither key and emits no stroke at all.
    { key: "glyphStroke", label: "Glyph outline", kind: "color", paint: true, category: "strokeMaterial", help: "The color, gradient or material of an outline traced around the equation's glyphs themselves. Distinct from the Stroke row below, which frames the whole box. Only visible once the outline width is above zero." },
    { key: "glyphStrokeWidth", label: "Glyph outline width", kind: "number", min: 0, category: "strokeMaterial", help: "Thickness of the outline around the equation's glyphs, in canvas units. Zero (the default) means no outline." },
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
    // THE INK SPLITS IN TWO, and the split is what lets a SHADER ink exist at all.
    //
    // A typeset equation is MathJax SVG with the ink baked in BEFORE rasterization
    // (latex_raster sets the root's `color`, which the glyph paths inherit through
    // currentColor) and the ink is part of the raster CACHE KEY. A gradient or a
    // material has no colour to bake and no string to key on, so it cannot be the
    // tint. Instead the raster is typeset at a NEUTRAL ink and the real paint is
    // carried on the op, to be applied THROUGH the glyph coverage at paint time.
    //
    // `inkTint` is therefore always a plain colour (what gets baked + keyed), and
    // `inkPaint` is the shader paint when there is one. A string ink puts itself in
    // inkTint and leaves inkPaint null — byte-identical to every render before this.
    const inkPaint = isShaderInk(s.ink) ? s.ink : null;
    // inkColor, not `s.ink` raw: a solid arrives EITHER as a bare string or as the
    // PaintField's {type:"solid", solid} wrapper, and this value is both baked into
    // the typeset SVG's `color` and interpolated into the raster CACHE KEY, neither
    // of which can take an object. See inkColor.
    const ink = inkPaint ? LATEX_MASK_INK : inkColor(s.ink, LATEX_DEFAULT_INK); // raster tint + vector fill
    ensureLatexTypeset(latex, scale, ink); // idempotent; safe every emit()
    // A shader ink ALSO needs the legacy-solid raster, because the pre-glyph
    // fallback below draws it (the mask raster is white and would flash blank).
    // Both are idempotent and cached; typesetting two inks costs one extra raster
    // per equation, once.
    if (inkPaint) ensureLatexTypeset(latex, scale, LATEX_DEFAULT_INK);

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
    // A SHADER ink rides as `fill` on the op, NOT as each glyph's `fill`. The
    // per-glyph fill must stay a plain colour because that is what the SVG/PDF
    // exporters write into a `<path fill>` and what drawLatexVector's parseColor
    // reads; the shader is ONE paint over the whole equation, so it belongs on the
    // op. Painters that see `fill` composite it through the glyph coverage; those
    // that cannot say so out loud rather than dropping it (svg/pdf below).
    //
    // Naming it `fill` is deliberate: that is the slot ports.js
    // resolveMaterialFillPaints already resolves, so a material ink gets its
    // resolvedParams with no new resolution site — the thing that docblock warns
    // against adding.
    const inkFill = inkPaint ? { fill: inkPaint } : {};
    const quad = geom
      ? latexVector({
          ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1,
          sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh,
          viewBox: geom.viewBox,
          glyphs: geom.glyphs.map((g) => ({ d: g.d, fill: ink })),
          preserveAspect: s.preserveAspect !== false, // default ON (user directive)
          ...inkFill,
          // THE GLYPH OUTLINE, CONVERTED INTO viewBox UNITS — the one arithmetic
          // this widget owes the painter, and the reason it is done HERE.
          //
          // An author states the width in CANVAS units, because that is what every
          // other width row on every widget means and a number that changes meaning
          // per widget is a trap. But the glyph `d`s are in MathJax viewBox units
          // and the painter strokes them under the viewBox→box CTM, so a width
          // handed over raw would be scaled by the fit factor — an outline that
          // silently thickens as the box grows, which is not what "2 units" says.
          // This is the ONE place that knows the factor (latexBoxToViewBoxScale
          // derives it from the same fitBox/stretch split drawLatexVector applies),
          // so the conversion belongs here rather than being re-derived per backend.
          glyphStroke: s.glyphStroke ?? null,
          glyphStrokeWidth: (s.glyphStrokeWidth ?? 0) > 0
            ? s.glyphStrokeWidth * latexBoxToViewBoxScale(geom.viewBox, c.w, c.h, s.preserveAspect !== false)
            : 0,
        })
      // The pre-glyph RASTER fallback carries NO shader ink, deliberately. It is
      // the transient state before the async glyph flatten lands (and the cropped
      // case, which has no vector form at all), and its raster is the white MASK —
      // painting that raw would flash a WHITE equation. So it draws at the
      // legacy-solid ink instead: a plain, readable equation for the frame or two
      // before the real paint takes over, rather than a white-on-white blank.
      // A cropped material equation stays at that solid ink permanently, which is
      // the same bound the crop already has against the vector exporters.
      : image({ ref: latexRef(latex, scale, LATEX_DEFAULT_INK), x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });
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
  /**
   * Query (reads the typeset glyph cache). Why this equation cannot morph YET, or
   * null — the `morphNotReady` half of the morph protocol (core/registry.js).
   *
   * THE WAIT IS REAL AND IT IS THE WHOLE REASON THE HOOK EXISTS. A typeset is
   * ASYNCHRONOUS and browser-only: `latexGlyphs` returns null until MathJax has
   * laid the equation out and `resolveLatexGlyphs` has flattened its <use> tree.
   * So an equation asked to morph on the frame it first appears has NO outline,
   * and a morph that proceeded anyway would blend against an empty payload —
   * every contour collapsing to a point, which reads as the equation imploding
   * rather than as "not ready". This is the shatterNotReady/iconify precedent
   * (plugins/iconify.js morphNotReady), and the reason `morphPairPolicy` asks at
   * all: derive reports the wait once and falls back to the discrete switch.
   *
   * THREE DISTINCT WAITS, each named, because "it didn't morph" is useless to an
   * author who cannot tell an empty box from a syntax error from a cold cache.
   * A SYNTAX ERROR is permanent rather than a wait, and it is reported as such:
   * the widget draws its loud red affordance at both endpoints, and morphing INTO
   * an error box is not a morph anybody asked for.
   *
   * @example latexPlugin.morphNotReady({latex: ""}) // 'an equation (this widget has none)'
   * @example // once MathJax has typeset it, this is null and the pair morphs
   * @example // latexPlugin.morphNotReady({latex: "x^2"}) // null
   */
  morphNotReady(s) {
    if (latexIsEmpty(s.latex)) return "an equation (this widget has none)";
    const err = latexErrorFor(s.latex);
    if (err) return `an equation that typesets (this one has a LaTeX error: ${err})`;
    return latexGlyphs(s.latex) === null
      ? "MathJax to finish typesetting this equation (it is still in flight)"
      : null;
  },
  /**
   * Query (reads the typeset glyph cache). THE MORPH OUTLINE (core/registry.js's
   * `morphPaths` protocol): the equation's GENUINE GLYPH CONTOURS, from the SAME
   * flattened MathJax geometry the `latexVector` op draws with.
   *
   * ── WHY THIS WIDGET CAN MORPH AT ALL, WHEN TEXT NEEDED A NEW SEAM ────────────
   * An equation's outlines ALREADY EXIST as vector data in this app:
   * render_gpu/gpu/latex_raster.js `resolveLatexGlyphs` resolves MathJax's
   * <use>/<defs> indirection into flat absolute `d` strings in the root viewBox
   * frame, because the SVG and PDF exporters need exactly that to embed a real
   * vector equation. So the morph provider is a REUSE, not a second derivation —
   * which is the point core/morph_payload.js's header makes about every provider:
   * the payload comes from the ink, so a change to how the equation is flattened
   * changes its morph for free and cannot be forgotten.
   *
   * ── THE FRAME ────────────────────────────────────────────────────────────────
   * Those `d` strings are in MathJax's ROOT VIEWBOX (whose minY is negative — the
   * ascender space above the baseline), not the widget box, so they are baked
   * through `morphPayloadFromViewBox` with the widget's own `preserveAspect`. That
   * is the identical mapping the PDF and SVG backends apply to the same glyphs; a
   * fourth spelling is how the morph's first frame would jump away from the pixels
   * the widget was showing at alpha 0.
   *
   * A CROPPED equation is deliberately NOT special-cased here: emit() rasterizes a
   * crop (a vector glyph list cannot express a source sub-rect), and a morph of a
   * cropped equation would likewise show the UNCROPPED outline. The crop insets
   * are ordinary tweened property state, so the endpoints are still exact; only
   * the interior of a transition ignores the crop, which is the same bound the
   * crop already has against the vector exporters.
   *
   * ALL GLYPHS SHARE THE WIDGET'S INK, one paint for the whole equation — which is
   * what emit() does too (it maps every glyph to a single `fill: ink`). A SHADER
   * ink has no colour to hand the engine, so it degrades to the default solid for
   * the morph's interior frames; the endpoints draw the real shader through
   * emit().
   */
  morphPaths(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const geom = latexGlyphs(s.latex);
    const ink = isShaderInk(s.ink) ? LATEX_DEFAULT_INK : (s.ink ?? LATEX_DEFAULT_INK);
    // Glyphs are FILLED contours, never stroked: `strokeWidth: 0` here is about
    // the letterforms, and is unrelated to the widget's own `strokeWidth`, which
    // draws the BORDER around the equation (decorateStrokedBox) rather than
    // outlining the type.
    const paint = { fill: ink, stroke: null, strokeWidth: 0, opacity: s.opacity ?? 1 };
    return morphPayloadFromViewBox(
      geom.glyphs.map((g) => ({ d: g.d, paint })),
      geom.viewBox,
      { w, h },
      s.preserveAspect !== false,
    );
  },
  commands: [
    { id: "add-latex", title: "Add LaTeX", icon: "mdi:function-variant", run: (app) => app.armCrosshairPlacement(latexPlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP), matching image/pdf_page's own add command
  ],
};
