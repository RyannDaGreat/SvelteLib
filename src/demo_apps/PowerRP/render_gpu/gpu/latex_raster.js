/**
 * The shared LATEX typeset+raster registry — one LaTeX equation typeset to an
 * SVG (via MathJax 3's self-contained tex-svg bundle) and rasterized to a
 * bitmap cached under a synthetic image-registry ref, keyed by (latex,
 * size-bucket). The TWIN of gpu/pdf_page_raster.js (its DIRECT template — read
 * that module's header for the shared reasoning): it is how a typeset equation
 * reaches the GPU compositor's media map WITHOUT the compositor knowing LaTeX
 * exists — the rasterized equation is just an ImageBitmap under a ref string,
 * so `getImage`/`ensureImage` (image_registry.js) resolve it exactly like a
 * still image. The plugin (plugins/latex.js) never reaches into any
 * compositor, and the compositor never imports MathJax.
 *
 * ── ENGINE CHOICE: MathJax 3 (tex-svg), NOT KaTeX — the WHY ───────────────────
 * The render architecture (manifest RENDER MODES DECISION: WebGPU raster +
 * VECTOR export) resolves ALL visual content through the IR, and the pdf_page
 * precedent proves the cleanest path for "externally typeset content" is:
 * produce a SELF-CONTAINED visual artifact → rasterize to a bitmap → register
 * under a synthetic image ref → the GPU compositor, the PDF backend, AND the
 * SVG backend all resolve it for free (image_registry getImage; the backends'
 * generic string-ref image loaders). To rasterize an equation to a bitmap you
 * need a self-contained visual artifact, and this is where the two engines
 * diverge:
 *   - KaTeX's `renderToString` produces HTML+CSS spans that REQUIRE katex.css +
 *     web fonts + a full CSS layout engine to paint. You cannot rasterize a
 *     KaTeX result to a bitmap without mounting it in a live styled DOM subtree
 *     and screenshotting — fragile, and impossible to do cleanly headless. It
 *     also has NO vector output at all, so the future TRUE-VECTOR SVG-export
 *     path (inline the equation SVG) is closed.
 *   - MathJax 3's `tex2svg` produces a SELF-CONTAINED <svg> whose glyphs are
 *     vector <path> elements sharing a <defs> of reusable glyph paths — NO
 *     external font/CSS dependency. It rasterizes to a bitmap trivially (the
 *     pdf_page pattern: SVG data-URI → <img>.decode() → createImageBitmap), AND
 *     it opens a clean future path to embedding the equation SVG DIRECTLY in
 *     the SVG backend (true vector) and a hybrid raster region in PDF.
 * MathJax's larger bundle (~2.1 MB for es5/tex-svg.js) is the cost, but it is
 * LAZY-imported (never in the bare-node chain) and pre-bundled in optimizeDeps
 * — it costs nothing until first use, exactly how the equally-large pdfjs-dist
 * is handled (pdf_page_raster's precedent).
 *
 * ── WHY MathJax 3 SPECIFICALLY (not 4) — THE OFFLINE RULE ─────────────────────
 * MathJax 3's `es5/tex-svg.js` bundles the whole `mathjax-tex` font as ONE data
 * file INSIDE the bundle — fully self-contained, ZERO network fetch. MathJax 4
 * split fonts into separate packages that DYNAMICALLY LOAD glyph ranges from a
 * CDN on demand (docs.mathjax.org v4 fonts) — that would (a) violate the
 * manifest OFFLINE RULE (the SVG backend's "no external ref" contract; a v4
 * equation SVG could reference CDN-loaded glyphs), and (b) break the puppeteer
 * parity/probe harness (no network in the sandboxed page). So package.json
 * pins `mathjax` to EXACTLY 3.2.2 — the self-contained-fonts guarantee is
 * version-specific; a caret range that floated to 4.x would silently break both.
 *
 * ── HOW IT REACHES THE RENDERER (reusing the image path, not a new IR op) ─────
 * A rasterized equation IS a bitmap. Rather than a new IR op + three backend
 * cases, plugins/latex.js emit() builds a plain `image()` op whose `ref` is
 * this module's synthetic cache key (latexRef(latex, scale)). Identical
 * reasoning to pdf_page_raster.js (read its "WHY A SYNTHETIC data: REF" header):
 * the GPU compositor, PDF backend, and SVG backend already resolve an image ref
 * uniformly, so ZERO new backend code. VECTOR SVG re-embed (inline the equation
 * <svg> in the SVG export instead of a raster region) is FLAGGED FUTURE WORK in
 * this module's footer, not built here — the same v1 hybrid-raster stance the
 * pdf_page widget took.
 *
 * ── THE LOAD PATTERN (a UMD global-installer, not a clean ES module) ──────────
 * `es5/tex-svg.js` is a webpack UMD bundle that READS a pre-existing global
 * `MathJax` config object and then INSTALLS `window.MathJax` with the
 * conversion methods (tex2svg / startup.promise). It is not a clean ES module
 * whose default export you use — it is a side-effecting script. So it is loaded
 * by INJECTING A <script> tag pointing at Vite's `?url` for the bundle (the
 * SAME `?url` mechanism pdf_page_raster uses for the pdfjs worker; done inside
 * the lazy loader so a bare-node static import never parses the Vite-only `?url`
 * specifier — the bare-node-safety requirement below). The config object
 * (window.MathJax) is set BEFORE the tag so the bundle picks it up: SVG output,
 * startup.typeset:false (we convert strings, not scan the page).
 *
 * ── BARE-NODE SAFETY (the pdfjs lazy-import lesson, verbatim) ─────────────────
 * MathJax is loaded LAZILY (inside loadMathJax() below), NEVER as a static
 * top-level import, and the `?url` specifier is evaluated only inside that lazy
 * path. WHY: `import "mathjax/es5/tex-svg.js?url"` is a Vite-only specifier a
 * bare-node `import` cannot parse — and core/ + the render_gpu/ node suites MUST
 * stay bare-node importable (PowerRP CLAUDE.md invariant). Because
 * plugins/latex.js is reached via plugins/index.js's static import chain, ANY
 * static top-level Vite-only import here would break every bare-node suite the
 * moment latex is registered — the EXACT pdfjs mistake caught mid-flight in
 * Round 13 (concerns.md). A bare-node caller that never triggers typesetting
 * (ensureLatexTypeset isn't called) never touches this module's guts; only the
 * pure functions below (latexRef/roundLatexScale/latexIsEmpty) are import-time
 * safe, and invoking the async ones outside a browser (no `document`) throws
 * loudly at CALL time, which is correct (this module is browser/CLI-facing,
 * like image_registry.js/pdf_page_raster.js).
 *
 * ── ASYNC CONTRACT (mirrors image_registry.js / pdf_page_raster.js) ───────────
 * Typeset+rasterize is async. The render path is SYNC-shaped, so:
 *   - `ensureLatexTypeset(latex, scale)` kicks an idempotent typeset; a no-op if
 *     that exact key is already loading/ready/errored.
 *   - `latexRef(latex, scale)` is the SYNC key the plugin's emit() builds its
 *     `image()` op ref from — emit() never awaits.
 *   - the compositor's normal image_registry getImage(ref) returns null until
 *     the raster lands (draws nothing that frame — the "no silent placeholder"
 *     rule), then onImageLoad wakes a repaint.
 *
 * ── LOUD FAILURE DISCIPLINE + IN-WIDGET ERRORS (no silent fallbacks) ──────────
 * A LaTeX SYNTAX error is NOT a load failure — MathJax renders invalid input as
 * an `merror` node (a visible error box in the SVG). We DETECT that node and
 * expose it as `latexErrorFor(latex)` (the MathJax error message) so the PLUGIN
 * can render a loud IN-WIDGET error affordance (a red error treatment on the
 * canvas — never console-only, never a blank widget). The equation is STILL
 * rasterized (MathJax's own red error box), so even without the plugin's
 * affordance the canvas shows the error, not nothing. A genuine INFRA failure
 * (the bundle fails to load, or rasterization throws) is reported ONCE via
 * console.error (reportOnce) and the key latches "error" (never retried
 * silently). See plugins/latex.js for the error affordance render.
 */

import { reserveImageSlot, registerRasterizedBitmap } from "./image_registry.js";
import { reportOnce } from "../../core/report.js";
import { SUPERSAMPLE_DENSITY } from "../ir.js";

/**
 * Device px per world unit at the equation's rendered em size — the shared
 * ir.js SUPERSAMPLE_DENSITY (2, "the retina-dpr 2× supersample precedent"): the
 * SAME supersample factor every hybrid raster region in this codebase uses (PDF
 * pages, blur, bloom, SVG raster regions), so a LaTeX raster region compares
 * against GPU pixels at the same density.
 */
export const LATEX_RASTER_DENSITY = SUPERSAMPLE_DENSITY;

/**
 * Scale is rounded to this step before entering the cache key so a continuous
 * resize/font-size drag reuses one raster instead of re-typesetting every
 * pixel. LINKED PRECEDENT: identical to pdf_page_raster.js PDF_SCALE_STEP (0.1)
 * — the SAME "bucket the raster scale so continuous drags don't mint a fresh
 * render per pixel" mechanism, same reasoning (the glyph-atlas bucketed-zoom
 * lesson, concerns.md). FLAGGED PENDING USER RATIFICATION with PDF_SCALE_STEP
 * (the codebase convention is to flag such constants; this one inherits
 * pdf_page's flag by construction — same value, same role).
 */
export const LATEX_SCALE_STEP = 0.1;

/** "<latex>|<ink>|<roundedScale>" → {status, ref, error, mathError, aspect}. The
 * INK color is IN the key (Round 15.4 "why cant i choose the color for latx"):
 * a color change re-rasterizes (the GPU draws the tinted bitmap), the same
 * bucketing discipline as scale. */
const typesets = new Map();
/** latex → {w, h} natural aspect (px at scale 1) once measured — the "how big
 * is this equation" the plugin needs to size its bbox from a font size. Ink-
 * INDEPENDENT (geometry only), so keyed by latex alone. */
const aspects = new Map();
/** latex → { glyphs: [{d}], viewBox: {minX,minY,w,h} } — the FLATTENED MathJax
 * glyph geometry (Round 15.1 TRUE VECTOR EXPORT), in the SVG root viewBox
 * coordinate frame, <use>/<defs> resolved to plain absolute-coord `d` strings.
 * INK-INDEPENDENT (geometry only — the fill color is applied by the plugin at
 * op-build time), so keyed by latex alone; the vector backends stroke it in the
 * widget's ink. Populated alongside the raster in ensureLatexTypeset. */
const glyphGeom = new Map();
/** latex → the MathJax error message string when the LaTeX had a syntax error
 * (an merror node was produced), else absent. Read by latexErrorFor. */
const mathErrors = new Map();

/** The default ink color for a typeset equation — the INK convention every
 * stroked shape / the text widget uses (#1a1a2e), so an equation and a line of
 * text read at the same color by default. Used when a caller omits an ink
 * override (keeps the pre-Round-15.4 pixel output byte-identical). */
export const LATEX_DEFAULT_INK = "#1a1a2e";

// The MathJax UMD bundle is loaded LAZILY (a <script> tag pointing at Vite's
// `?url`, done INSIDE this dynamic path so bare node never parses the Vite-only
// `?url` specifier). See the module header's BARE-NODE SAFETY note.
let mathjaxPromise = null;
/** Command (near-pure: memoized). Sets the global MathJax config, injects the
 * self-contained tex-svg bundle via a <script> tag (Vite `?url`), and resolves
 * once MathJax.startup.promise is ready. Exactly once per process. */
function loadMathJax() {
  if (!mathjaxPromise) {
    mathjaxPromise = (async () => {
      if (typeof document === "undefined")
        throw new Error("latex_raster: MathJax needs a DOM (document); this module is browser/CLI-facing, not bare node");
      // The bundle READS this global config object before it initializes.
      // startup.typeset:false — we convert strings via tex2svg, never scan the
      // page. svg.fontCache:"local" — glyph <defs> are LOCAL to each SVG (a
      // self-contained artifact with no cross-SVG id references, which is what
      // rasterizing an isolated data-URI SVG requires; the default "global"
      // caches glyphs in a shared <defs> outside the returned node → broken
      // rasterization of a standalone SVG).
      globalThis.MathJax = {
        startup: { typeset: false },
        svg: { fontCache: "local" },
      };
      // Vite's `?url` gives the UMD bundle a served URL without bundling it into
      // this module's chunk (the pdfjs-worker precedent). Nested in this dynamic
      // import so a bare-node static import graph never evaluates it.
      const { default: mathjaxUrl } = await import("mathjax/es5/tex-svg.js?url");
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = mathjaxUrl;
        script.addEventListener("load", resolve);
        script.addEventListener("error", () => reject(new Error(`failed to load MathJax bundle from ${mathjaxUrl}`)));
        document.head.appendChild(script);
      });
      // The bundle installs globalThis.MathJax with startup.promise + tex2svg.
      await globalThis.MathJax.startup.promise;
      return globalThis.MathJax;
    })();
  }
  return mathjaxPromise;
}

/**
 * Pure function. Parses a MathJax SVG length attribute in `ex` units (e.g.
 * "8.037ex") to its numeric ex value. Returns 0 for a missing/malformed value
 * (the caller falls back to a 1:1 aspect so a degenerate SVG still rasterizes
 * as a small square rather than throwing).
 *
 * @example parseExAttr("8.037ex") // 8.037
 * @example parseExAttr("4.674ex") // 4.674
 * @example parseExAttr(null) // 0
 * @example parseExAttr("nonsense") // 0
 */
export function parseExAttr(attr) {
  if (typeof attr !== "string") return 0;
  const m = attr.match(/^\s*([0-9.]+)\s*ex\s*$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pure function. Applies a 2D affine matrix {a,b,c,d,e,f} (the SVG/DOMMatrix
 * convention: x' = a·x + c·y + e, y' = b·x + d·y + f) to an SVG path `d` string,
 * returning a new ABSOLUTE-coordinate `d`. Used to BAKE a MathJax <use>'s CTM
 * into its referenced glyph path so the flattened glyph carries no transform
 * (Round 15.1). Handles the MathJax tex-svg command set (absolute M L H V Q T Z);
 * because a general matrix rotates axes, H/V become L and the path is emitted as
 * M/L/Q/Z with transformed points (a curve's control point transforms like any
 * point — an affine map preserves the Bézier). Unsupported commands throw (no
 * silent geometry drop).
 *
 * Args:
 *   d (string): an absolute-coord SVG path (M L H V Q T Z)
 *   m ({a,b,c,d,e,f}): the affine matrix to bake in
 *
 * Returns:
 *   string: the transformed absolute-coord `d`
 *
 * @example transformSvgPathD("M0 0L10 0", {a: 2, b: 0, c: 0, d: 2, e: 5, f: 5}) // "M5 5L25 5"
 * @example transformSvgPathD("M0 0H10", {a: 1, b: 0, c: 0, d: -1, e: 0, f: 100}) // "M0 100L10 100" (y-flip: H stays horizontal, becomes L)
 * @example transformSvgPathD("M0 0Q5 10 10 0", {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}) // "M0 0Q5 10 10 0" (identity)
 */
export function transformSvgPathD(d, m) {
  const num = (v) => String(+v.toFixed(3));
  const px = (x, y) => m.a * x + m.c * y + m.e;
  const py = (x, y) => m.b * x + m.d * y + m.f;
  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;      // current point + subpath start
  let qpx = null, qpy = null;               // previous quad control (for T)
  const re = /([MLHVQTZ])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let match, cur = null;
  const toks = [];
  while ((match = re.exec(d)) !== null) {
    if (match[1] !== undefined) { cur = [match[1]]; toks.push(cur); }
    else { if (!cur) throw new Error(`transformSvgPathD: number before command in "${d.slice(0, 40)}"`); cur.push(Number(match[2])); }
  }
  const P = (x, y) => `${num(px(x, y))} ${num(py(x, y))}`;
  for (const tok of toks) {
    const cmd = tok[0], a = tok.slice(1);
    if (cmd === "M") { cx = a[0]; cy = a[1]; sx = cx; sy = cy; qpx = qpy = null; out.push(`M${P(cx, cy)}`); }
    else if (cmd === "L") { cx = a[0]; cy = a[1]; qpx = qpy = null; out.push(`L${P(cx, cy)}`); }
    else if (cmd === "H") { cx = a[0]; qpx = qpy = null; out.push(`L${P(cx, cy)}`); }
    else if (cmd === "V") { cy = a[0]; qpx = qpy = null; out.push(`L${P(cx, cy)}`); }
    else if (cmd === "Q") { const qx = a[0], qy = a[1]; cx = a[2]; cy = a[3]; qpx = qx; qpy = qy; out.push(`Q${P(qx, qy)} ${P(cx, cy)}`); }
    else if (cmd === "T") { const qx = qpx === null ? cx : 2 * cx - qpx, qy = qpy === null ? cy : 2 * cy - qpy; cx = a[0]; cy = a[1]; qpx = qx; qpy = qy; out.push(`Q${P(qx, qy)} ${P(cx, cy)}`); }
    else if (cmd === "Z") { out.push("Z"); cx = sx; cy = sy; qpx = qpy = null; }
    else throw new Error(`transformSvgPathD: unsupported command "${cmd}"`);
  }
  return out.join("");
}

/**
 * Pure function. Rounds a raster scale to the LATEX_SCALE_STEP grid (never below
 * the step — a zero/negative scale would rasterize nothing). Identical shape to
 * pdf_page_raster.roundPdfScale.
 *
 * @example roundLatexScale(1.234) // 1.2
 * @example roundLatexScale(0.03) // 0.1
 */
export function roundLatexScale(scale) {
  const rounded = Math.round(scale / LATEX_SCALE_STEP) * LATEX_SCALE_STEP;
  return Math.max(LATEX_SCALE_STEP, Number(rounded.toFixed(1)));
}

/**
 * Pure function. True iff a latex source string is empty (absent, or only
 * whitespace) — the CONDITIONAL-GHOST predicate (manifest 13.6): an empty
 * equation renders nothing and is a ghost, exactly like empty text
 * (richTextIsEmpty) and an empty filmstrip. The ONE canonical "no equation"
 * test, shared by the plugin's isGhost hook and its emit() short-circuit.
 *
 * @example latexIsEmpty("") // true
 * @example latexIsEmpty("   ") // true
 * @example latexIsEmpty(undefined) // true
 * @example latexIsEmpty("x^2 + 1") // false
 */
export function latexIsEmpty(latex) {
  return typeof latex !== "string" || latex.trim().length === 0;
}

/**
 * Pure function. The synthetic image-registry ref key for a typeset equation.
 * NOT a real data: URI — a plain cache key the image registry stores an
 * ImageBitmap under directly (registerRasterizedBitmap). Rounds scale via
 * roundLatexScale so the key is stable across a continuous resize/font-size
 * drag. The INK color is part of the key (Round 15.4): two colors of the same
 * equation are two distinct rasters. Omitting ink → LATEX_DEFAULT_INK, so an
 * un-colored equation's ref is stable and its pixels are byte-identical to the
 * pre-ink output. Mirrors pdf_page_raster.pdfPageRef.
 *
 * @example latexRef("x^2", 1) // "latex:x^2:#1a1a2e:1"
 * @example latexRef("\\frac{a}{b}", 2.34, "#ff0000") // "latex:\\frac{a}{b}:#ff0000:2.3"
 */
export function latexRef(latex, scale, ink = LATEX_DEFAULT_INK) {
  return `latex:${latex}:${ink}:${roundLatexScale(scale)}`;
}

/**
 * Query. The typeset status of an (latex, ink, scale) key: "unloaded",
 * "loading", "ready", or "error".
 *
 * @example latexStatus("nope", 1) // "unloaded"
 */
export function latexStatus(latex, scale, ink = LATEX_DEFAULT_INK) {
  return typesets.get(`${latex}|${ink}|${roundLatexScale(scale)}`)?.status ?? "unloaded";
}

/**
 * Query. The FLATTENED vector glyph geometry of a typeset equation (Round 15.1),
 * or null if not measured yet. `{ glyphs: [{d}], viewBox: {minX,minY,w,h} }` —
 * the MathJax <use>/<defs> resolved to plain absolute-coord SVG `d` strings in
 * the root viewBox coordinate frame, INK-INDEPENDENT (the plugin applies the ink
 * fill). The vector backends (SVG/PDF) consume this to draw TRUE VECTOR glyphs;
 * the plugin's emit() builds a latexVector op from it. Populated by
 * ensureLatexTypeset (browser only); null until the first typeset lands, so
 * emit() falls back to the raster image op meanwhile (the async contract).
 *
 * @example latexGlyphs("nope") // null
 */
export function latexGlyphs(latex) {
  return glyphGeom.get(latex) ?? null;
}

/**
 * Query. The natural pixel aspect {w, h} of a typeset equation (at MathJax's
 * scale-1 output), or null if not measured yet. The "how big is this equation"
 * conversion the plugin needs to size its bbox from a chosen font size — the
 * role a photo's naturalWidth/naturalHeight plays for an image widget. Not
 * synchronously derivable from the latex string (MathJax must lay it out), so
 * it is cached here (populated by ensureLatexTypeset).
 *
 * @example latexAspect("nope") // null
 */
export function latexAspect(latex) {
  return aspects.get(latex) ?? null;
}

/**
 * Query. The MathJax error MESSAGE for a latex string whose typeset produced an
 * merror node (a SYNTAX error), or null if it typeset cleanly (or hasn't been
 * typeset yet). The PLUGIN reads this to render a loud in-widget error
 * affordance. An empty string never errors (latexIsEmpty → the plugin ghosts
 * it, never typesets).
 *
 * @example latexErrorFor("x^2") // null  (valid, once typeset)
 */
export function latexErrorFor(latex) {
  return mathErrors.get(latex) ?? null;
}

/**
 * Query (browser only — reads SVG geometry via the DOM). FLATTENS a MathJax
 * tex-svg tree into a plain list of absolute-coord glyph `{d}` paths + the root
 * viewBox (Round 15.1 TRUE VECTOR EXPORT). MathJax emits glyphs as
 * `<use xlink:href="#id">` referencing `<path id>` in `<defs>`, nested under
 * `<g transform>` groups (including a top-level y-flip). To embed them as
 * SELF-CONTAINED plain `<path>`s (SVG backend) / PDF path operators (no <use>,
 * no id refs, no nested <svg> — avoiding the "1000-per-em internal grid" scaling
 * bug), each <use> is resolved: its referenced path's `d` is baked through the
 * CTM from the SVG root to that <use> (getCTM — the browser computes the
 * accumulated transform, including the y-flip), producing a `d` already in the
 * root's viewBox coordinate frame. The whole tree therefore collapses to a flat,
 * y-DOWN (as-drawn) `d` list a plain box→box scale maps onto the widget box.
 *
 * REQUIRES the SVG to be attached to the document (getCTM returns null on a
 * detached node), so the caller appends it offscreen first.
 *
 * Args:
 *   svg (SVGSVGElement): a MathJax tex-svg root, attached to the document
 *
 * Returns:
 *   { glyphs: [{d}], viewBox: {minX,minY,w,h} }
 *
 * @example // resolveLatexGlyphs(mathJaxSvg) → { glyphs: [{d: "M413 655..."}, ...], viewBox: {minX: 0, minY: -883, w: 3552, h: 1738} }
 */
function resolveLatexGlyphs(svg) {
  const vbAttr = (svg.getAttribute("viewBox") || "0 0 1 1").trim().split(/\s+/).map(Number);
  const viewBox = { minX: vbAttr[0], minY: vbAttr[1], w: vbAttr[2], h: vbAttr[3] };
  const rootCTM = svg.getScreenCTM();
  if (!rootCTM) throw new Error("resolveLatexGlyphs: SVG has no screen CTM (must be attached to the document)");
  const rootInv = rootCTM.inverse(); // screen → root viewBox space
  const defs = new Map();
  for (const p of svg.querySelectorAll("defs path, defs [id]")) {
    if (p.tagName.toLowerCase() === "path" && p.id) defs.set(p.id, p.getAttribute("d") || "");
  }
  const glyphs = [];
  for (const use of svg.querySelectorAll("use")) {
    const href = use.getAttribute("xlink:href") || use.getAttribute("href") || "";
    const id = href.replace(/^#/, "");
    const d = defs.get(id);
    if (!d) continue; // a <use> pointing at a non-path def (rare) — skip, don't fake geometry
    // CTM of this <use> relative to the root viewBox frame: rootInv · useScreenCTM.
    const useCTM = use.getScreenCTM();
    if (!useCTM) continue;
    const m = rootInv.multiply(useCTM); // screen-cancel → root viewBox coords
    glyphs.push({ d: transformSvgPathD(d, m) });
  }
  // MathJax draws RULES (fraction bars, √ vinculums, \overline, matrix/array
  // lines) as filled `<rect>`s — NOT <use> glyphs — so a use-only flattener drops
  // every bar (invisible fraction/root in the vector render, while the raster +
  // MathLive editor show them → the "editing looks right, static is missing bars"
  // bug). Convert each rule <rect> to a filled-rect `d`, baked through its OWN CTM
  // exactly like a glyph, into the SAME list (the plugin fills them with `ink`).
  // Skip <defs> rects (clip/template geometry, not drawn) and zero-area rects.
  for (const r of svg.querySelectorAll("rect")) {
    if (r.closest("defs")) continue;
    const x = parseFloat(r.getAttribute("x") || "0");
    const y = parseFloat(r.getAttribute("y") || "0");
    const w = parseFloat(r.getAttribute("width") || "0");
    const h = parseFloat(r.getAttribute("height") || "0");
    if (!(w > 0) || !(h > 0)) continue;
    const rectCTM = r.getScreenCTM();
    if (!rectCTM) continue;
    const m = rootInv.multiply(rectCTM); // screen-cancel → root viewBox coords
    // Explicit closed quad (H/V are transform-safe in transformSvgPathD, but the
    // full path is unambiguous under any CTM including the root y-flip).
    const d = `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
    glyphs.push({ d: transformSvgPathD(d, m) });
  }
  return { glyphs, viewBox };
}

/**
 * Command (near-pure: idempotent). Ensures a specific (latex, ink, scale) is
 * typeset to an SVG, rasterized to a bitmap (tinted `ink`), and registered into
 * the image registry under latexRef(...), AND the ink-independent vector glyph
 * geometry (glyphGeom) is captured. A no-op if that exact key is already
 * loading/ready/errored — safe to call every frame from a sync emit(). Fire-and-
 * forget: the render path never awaits; it reads latexRef(...) through the normal
 * image_registry getImage/onImageLoad path (a not-yet-typeset equation draws
 * nothing this frame, exactly like an undecoded image — the manifest async
 * rule). Mirrors pdf_page_raster.ensurePdfPageRasterized end to end, including
 * the reserveImageSlot-before-await race guard.
 *
 * @example // ensureLatexTypeset("x^2", 1, "#f00"); ...later... getImage(latexRef("x^2", 1, "#f00")) → ImageBitmap
 */
export function ensureLatexTypeset(latex, scale, ink = LATEX_DEFAULT_INK) {
  if (latexIsEmpty(latex)) throw new Error("ensureLatexTypeset: latex must be a non-empty string (the caller ghosts an empty equation before calling)");
  const roundedScale = roundLatexScale(scale);
  const key = `${latex}|${ink}|${roundedScale}`;
  if (typesets.has(key)) return typesets.get(key).promise;

  const ref = latexRef(latex, scale, ink);
  // RESERVE THE IMAGE-REGISTRY SLOT SYNCHRONOUSLY, before any await below —
  // the SAME race guard pdf_page_raster documents (read reserveImageSlot's doc
  // in image_registry.js): without it, a compositor frame between "typeset
  // started" and "bitmap ready" would see no entry, call ensureImage(ref), and
  // fetch() the fake "latex:…" string → permanently latch the ref to "error".
  reserveImageSlot(ref);
  const entry = { status: "loading", ref, error: null, promise: null };
  entry.promise = (async () => {
    const MathJax = await loadMathJax();
    // tex2svg → a container node wrapping the <svg>. display:true = block/
    // centered math (the natural presentation for a standalone equation widget,
    // not inline-in-a-line). MathJax is synchronous here (v3 tex2svg), but the
    // startup.promise (above) already resolved.
    const container = MathJax.tex2svg(latex, { display: true });
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("MathJax produced no <svg> element");
    // SYNTAX ERROR DETECTION: MathJax renders invalid LaTeX as an merror node
    // (a visible red error box) rather than throwing. Surface its message so the
    // plugin can render a loud in-widget error affordance — but STILL rasterize
    // (MathJax's own red box), so even the bare canvas shows the error, never a
    // blank widget.
    const merror = svg.querySelector('[data-mml-node="merror"]');
    if (merror) {
      // MathJax tags the merror node with the specific reason in
      // data-mjx-error (e.g. "Missing close brace"); fall back to the <title>
      // then a generic label. This is the message the plugin's in-widget
      // affordance shows the author.
      const title = svg.querySelector("title");
      mathErrors.set(latex, merror.getAttribute("data-mjx-error") || title?.textContent || "LaTeX syntax error");
    } else {
      mathErrors.delete(latex);
    }
    // NATURAL ASPECT: MathJax puts the equation's rendered size in the SVG's
    // width/height ATTRIBUTES, expressed in `ex` units (e.g. "8.037ex" ×
    // "4.674ex"). (The viewBox is in MathJax's INTERNAL ~1000-per-em grid —
    // 3552×2066 — which is NOT ex and must NOT be used as a pixel size: doing
    // so mints a 90k-px canvas that fails to allocate. The bug this comment
    // guards against, caught in verification.) So parse the ex width/height:
    // their ratio is the true aspect, and each is a real physical extent once
    // ex→px is applied. Aspect is stored in ex (the plugin's sizeForLatex uses
    // the same EX_PER_EM factor to turn fontSize into a box size).
    const exW = parseExAttr(svg.getAttribute("width"));
    const exH = parseExAttr(svg.getAttribute("height"));
    const aspectW = exW > 0 ? exW : 1;
    const aspectH = exH > 0 ? exH : 1;
    aspects.set(latex, { w: aspectW, h: aspectH });
    // VECTOR GLYPH EXTRACTION (Round 15.1): flatten <use>/<defs> to plain
    // absolute-coord `d`s in the root viewBox frame. getScreenCTM (inside
    // resolveLatexGlyphs) needs the SVG attached to the document, so mount it in
    // a 0-size offscreen host, extract, then remove — geometry only, INK-
    // independent (cached by latex alone; the plugin applies the ink fill). Only
    // extracted once per latex (skip if already cached, e.g. a scale/ink change).
    if (!glyphGeom.has(latex) && !merror) {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden";
      // Clone so the offscreen-measure copy keeps MathJax's ORIGINAL viewBox
      // width/height/transform intact (below we overwrite the real svg's
      // width/height/color for rasterization — that must not corrupt the glyph
      // coordinate frame the CTMs are measured in).
      const measureSvg = svg.cloneNode(true);
      host.appendChild(measureSvg);
      document.body.appendChild(host);
      try {
        glyphGeom.set(latex, resolveLatexGlyphs(measureSvg));
      } finally {
        host.remove();
      }
    }
    // RASTERIZE: pixel size = the ex extent × the em pixel size × EX_PER_EM,
    // then draw the SVG onto a 2D canvas and createImageBitmap(canvas) — the
    // pdf_page canvas-render pattern. Drawing an SVG <img> to a canvas is far
    // more reliable across browsers than createImageBitmap(svgImg) directly
    // (which fails "ImageBitmap could not be allocated" for many SVGs); the
    // canvas is the same intermediary pdf_page_raster uses for a rasterized page.
    const emPx = LATEX_RASTER_DENSITY * roundedScale;
    // ex is ~half an em; the ex extent × emPx × EX_PER_EM gives pixels that
    // render the glyphs at emPx per em. EX_PER_EM 0.5 is the CSS/typographic
    // convention (1ex ≈ 0.5em for most faces) — a display constant, not magic.
    const EX_PER_EM = 0.5;
    const pxH = Math.max(1, Math.round(aspectH * emPx * EX_PER_EM));
    const pxW = Math.max(1, Math.round(aspectW * emPx * EX_PER_EM));
    // MathJax glyph paths fill with `currentColor` (inherited CSS color); a
    // detached/canvas-drawn SVG has no CSS context, so pin the widget's INK on
    // the root so the ink renders (Round 15.4: the user chooses the color; ink
    // is in the cache key so a color change re-rasterizes). width/height in px
    // give the <img> intrinsic dimensions createImageBitmap needs.
    svg.setAttribute("width", `${pxW}`);
    svg.setAttribute("height", `${pxH}`);
    svg.setAttribute("color", ink); // currentColor for the glyph paths — the widget's chosen ink
    // Serialize + base64-encode the self-contained SVG (base64 is more robust
    // than percent-encoding for an <img src> SVG data URI — avoids the
    // encodeURIComponent edge cases that broke the direct-createImageBitmap path).
    const svgText = new XMLSerializer().serializeToString(svg);
    const svgDataUri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`;
    const img = new Image();
    img.width = pxW;
    img.height = pxH;
    img.src = svgDataUri;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, pxW, pxH);
    const bitmap = await createImageBitmap(canvas);
    entry.status = "ready";
    registerRasterizedBitmap(ref, bitmap); // wakes image_registry.onImageLoad subscribers
    return bitmap;
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    reportOnce(`latex_raster:typeset:${key}`, `PowerRP latex_raster: failed to typeset "${truncate(latex)}" @${roundedScale}x — ${entry.error.message}`);
    return null;
  });
  typesets.set(key, entry);
  return entry.promise;
}

/** Pure function. Shortens a latex source for log messages.
 * @example truncate("x".repeat(200)) // "xxxxxxxxxxxxxxxxxxxxxxxx…(200 chars)"
 */
function truncate(latex) {
  return latex.length > 48 ? `${latex.slice(0, 24)}…(${latex.length} chars)` : latex;
}

/**
 * Command. Drops all cached typeset equations, aspects, glyph geometry, and
 * errors. For tests that need a clean registry; the invalidation hook mirroring
 * resetPdfPageRaster/resetImageRegistry.
 */
export function resetLatexRaster() {
  typesets.clear();
  aspects.clear();
  glyphGeom.clear();
  mathErrors.clear();
}

// ── VECTOR SVG/PDF re-embed: BUILT (Round 15.1 — "do latex properly") ────────
// The former FUTURE-WORK stance (raster PNG region in every backend) is retired.
// MathJax's self-contained vector <svg> is now FLATTENED (resolveLatexGlyphs:
// <use>/<defs> baked to plain absolute-coord `d`s via each <use>'s CTM) into the
// ink-independent glyphGeom cache. plugins/latex.js emit() builds a `latexVector`
// IR op carrying BOTH the raster ref (GPU live view + the HYBRID RULE's raster
// fallback — a latex under a blur still rasterizes, like text) AND this glyph
// geometry (the SVG backend embeds inline <path>s; the PDF backend emits m/l/c
// operators filled NONZERO for correct glyph counters). True vector, crisp at
// any zoom, in every export. See render_gpu/ir.js latexVector + the SVG/PDF
// backends' latexVector cases.
