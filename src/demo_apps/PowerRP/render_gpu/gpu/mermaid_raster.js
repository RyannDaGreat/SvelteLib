/**
 * The shared MERMAID render+raster registry — one Mermaid diagram DEFINITION
 * rendered to a self-contained SVG (native SVG text, htmlLabels:false) and
 * rasterized to a bitmap cached under a synthetic image-registry ref, keyed by
 * (definition, theme, scale-bucket). The TWIN of gpu/latex_raster.js (its direct
 * template — read that module's header for the shared reasoning): it is how a
 * rendered diagram reaches the GPU compositor's media map WITHOUT the compositor
 * knowing Mermaid exists — the rasterized diagram is just an ImageBitmap under a
 * ref string, so getImage/ensureImage (image_registry.js) resolve it exactly
 * like a still image. The plugin (plugins/mermaid.js) emits a plain `image()` op
 * whose `ref` is this module's synthetic key, so ZERO new IR op / backend code.
 *
 * ── ENGINE LIVES IN web/mermaidRenderer.js (the bare-node-safety split) ───────
 * All Vite-only specifiers (`import "mermaid"`, `../fonts/*.ttf?url`) and all
 * Mermaid config live in web/mermaidRenderer.js. THIS module is reached from
 * plugins/index.js's static import chain, so it MUST stay bare-node importable
 * (the node test suites import the plugin roster) — therefore it references the
 * renderer only through a LAZY `await import("../../web/mermaidRenderer.js")` on
 * the async render path, never statically. Same discipline latex_raster uses to
 * keep its `mathjax/...?url` import inside a lazy loader; only the pure helpers
 * below (mermaidRef/roundMermaidScale/mermaidIsEmpty) are import-time safe, and
 * calling ensureMermaidRendered outside a browser (no `document`) throws loudly
 * at CALL time (correct — this module is browser/CLI-facing).
 *
 * ── WHY RASTER, NOT VECTOR (v1 scope) ─────────────────────────────────────────
 * With htmlLabels:false a Mermaid SVG is structurally flatten-able (like a
 * MathJax tree), but a true-vector flatten (bake getScreenCTM + getComputedStyle
 * into path/rect/text IR) is a multi-day project with a hard text sub-problem —
 * explicitly DEFERRED (the latex Round-15.1 vector work is the precedent for a
 * later pass). v1 rasterizes the self-contained SVG the SAME way latex_raster
 * does (SVG→<img>→canvas→createImageBitmap), so it looks right in the editor and
 * in every BROWSER export (PNG/SVG/PDF via a real DOM). The pure-node CLI cannot
 * render it (no DOM), exactly like latex — a stated bound, not a silent gap.
 *
 * ── SUPERSAMPLE FOR BEAUTY ────────────────────────────────────────────────────
 * A diagram is static line-art whose crispness matters, so it rasterizes at
 * MERMAID_SUPERSAMPLE× the diagram's natural layout px (times the item's world
 * scale bucket), capped at MERMAID_MAX_RASTER_PX so a huge diagram never mints
 * an unallocatable canvas. Embedding the committed Inter face in the SVG (see
 * mermaidRenderer.mermaidFontFaceCss) keeps label metrics faithful.
 *
 * ── ASYNC + LOUD FAILURE (mirrors latex_raster / image_registry) ──────────────
 * Render+raster is async; the render path is sync-shaped:
 *   - ensureMermaidRendered(def, theme, scale) kicks an idempotent render; a
 *     no-op if that exact key is already loading/ready/errored.
 *   - mermaidRef(def, theme, scale) is the SYNC key the plugin's emit() builds
 *     its image() op ref from.
 *   - getImage(ref) returns null until the raster lands (draws nothing that
 *     frame — the no-silent-placeholder rule), then onImageLoad wakes a repaint.
 * A SYNTAX error is not an infra failure: Mermaid's parser rejects it, we record
 * the message (mermaidErrorFor) so the plugin draws a loud in-canvas red
 * affordance, and we register a 1×1 transparent bitmap at the ref SOLELY to wake
 * the repaint that lets emit() switch to the affordance (no bitmap would leave
 * the error invisible until an unrelated repaint). A genuine infra failure (the
 * bundle fails to load, rasterization throws) is reported ONCE via console.error
 * and the key latches "error" (never retried silently).
 */

import { reserveImageSlot, registerRasterizedBitmap } from "./image_registry.js";
import { reportOnce, truncate } from "../../core/report.js";
import { flattenMermaidSvg } from "./mermaid_vector.js";

/** Supersample factor: raster at this many device px per diagram layout px (at
 * scale 1). Higher than the 2× latex/PDF SUPERSAMPLE_DENSITY because a diagram
 * is static line-art where edge crispness is the whole point ("as beautifully as
 * possible") and it renders once, not per animation frame — 3× is a clear
 * quality win at an acceptable one-time raster cost. */
export const MERMAID_SUPERSAMPLE = 3;

/** Scale is rounded to this step before entering the cache key so a continuous
 * resize/zoom drag reuses one raster instead of re-rendering every pixel.
 * COARSER than latex's 0.1 (a full Mermaid layout+raster is heavier than a
 * MathJax typeset), so fewer buckets = fewer re-renders. */
export const MERMAID_SCALE_STEP = 0.25;

/** Hard cap on either raster dimension (device px). A large diagram at high
 * supersample could otherwise mint a multi-thousand-px canvas that fails to
 * allocate; beyond this the raster scales down uniformly (aspect preserved). */
export const MERMAID_MAX_RASTER_PX = 4096;

/** The default diagram theme (Mermaid's own "default"). Kept here (not imported
 * from web/) so the pure ref/key helpers stay bare-node importable. */
export const DEFAULT_MERMAID_THEME = "default";

/** The Mermaid built-in themes exposed as the widget's `theme` select options
 * (Mermaid's own theme ids, verified in mermaid@11). Lives HERE (not in the
 * Vite-only web/mermaidRenderer.js) so plugins/mermaid.js — reached by the
 * bare-node test suites — can import the list without pulling in `mermaid`. */
export const MERMAID_THEMES = ["default", "neutral", "dark", "forest", "base"];

/** "<def>|<theme>|<roundedScale>" → {status, ref, error}. */
const renders = new Map();
/** "<def>|<theme>" → {w, h} natural diagram size in layout px, once measured —
 * the "how big is this diagram" the plugin needs to letterbox it into its box.
 * Theme can nudge padding, so it is part of the key. */
const aspects = new Map();
/** def → Mermaid syntax-error message when the definition failed to parse, else
 * absent. Read by mermaidErrorFor (theme-independent: syntax is syntax). */
const parseErrors = new Map();
/** "<def>|<theme>" → { paths, texts, viewBox } — the FLATTENED TRUE-VECTOR
 * geometry (viewBox space) once a render lands and could be vectorized, else
 * absent (an unflattenable diagram stays raster). Theme is part of the key
 * because it drives the resolved colors. The plugin reads it via
 * mermaidVectorGeom to emit the crisp mermaidVector op; null until the flatten
 * lands, so emit() falls back to the raster image op meanwhile (the async
 * contract, exactly like latex_raster.latexGlyphs). */
const vectorGeoms = new Map();

/**
 * Pure function. Rounds a raster scale to the MERMAID_SCALE_STEP grid (never
 * below the step — a zero/negative scale would rasterize nothing).
 *
 * @example roundMermaidScale(1.2) // 1.25
 * @example roundMermaidScale(0.03) // 0.25
 * @example roundMermaidScale(2) // 2
 */
export function roundMermaidScale(scale) {
  const rounded = Math.round(scale / MERMAID_SCALE_STEP) * MERMAID_SCALE_STEP;
  return Math.max(MERMAID_SCALE_STEP, Number(rounded.toFixed(4)));
}

/**
 * Pure function. True iff a Mermaid definition is empty (absent, or only
 * whitespace) — the CONDITIONAL-GHOST predicate: an empty diagram renders
 * nothing and is a ghost, exactly like empty latex/text. The ONE canonical "no
 * diagram" test, shared by the plugin's isGhost hook and its emit()
 * short-circuit.
 *
 * @example mermaidIsEmpty("") // true
 * @example mermaidIsEmpty("   ") // true
 * @example mermaidIsEmpty(undefined) // true
 * @example mermaidIsEmpty("flowchart TD\n A-->B") // false
 */
export function mermaidIsEmpty(def) {
  return typeof def !== "string" || def.trim().length === 0;
}

/**
 * Pure function. The synthetic image-registry ref key for a rendered diagram.
 * NOT a real data: URI — a plain cache key the image registry stores an
 * ImageBitmap under directly (registerRasterizedBitmap). Rounds scale via
 * roundMermaidScale so the key is stable across a continuous resize/zoom drag.
 * Theme is part of the key (two themes of one diagram are two rasters).
 *
 * @example mermaidRef("flowchart TD\n A-->B", "default", 1) // "mermaid:default:1:flowchart TD\n A-->B"
 * @example mermaidRef("graph LR\n X-->Y", "dark", 1.3, ) // "mermaid:dark:1.25:graph LR\n X-->Y"
 */
export function mermaidRef(def, theme = DEFAULT_MERMAID_THEME, scale = 1) {
  return `mermaid:${theme}:${roundMermaidScale(scale)}:${def}`;
}

/**
 * Query. The render status of a (def, theme, scale) key: "unloaded", "loading",
 * "ready", or "error".
 *
 * @example mermaidStatus("nope", "default", 1) // "unloaded"
 */
export function mermaidStatus(def, theme = DEFAULT_MERMAID_THEME, scale = 1) {
  return renders.get(`${def}|${theme}|${roundMermaidScale(scale)}`)?.status ?? "unloaded";
}

/**
 * Query. The natural pixel size {w, h} of a rendered diagram (Mermaid's layout
 * px), or null if not measured yet — the "how big is this diagram" the plugin
 * uses to letterbox it into its box under preserveAspect. Not synchronously
 * derivable from the definition (Mermaid must lay it out), so cached here.
 *
 * @example mermaidAspect("nope", "default") // null
 */
export function mermaidAspect(def, theme = DEFAULT_MERMAID_THEME) {
  return aspects.get(`${def}|${theme}`) ?? null;
}

/**
 * Query. The FLATTENED TRUE-VECTOR geometry of a rendered diagram —
 * `{ paths, texts, viewBox }` in the root viewBox frame — or null if not landed
 * yet OR the diagram could not be vectorized (foreignObject; the plugin then
 * rasterizes and a loud warning has already fired). The mermaid analog of
 * latex_raster.latexGlyphs: the plugin's emit() builds the mermaidVector op from
 * it, falling back to the raster image op while this is null (the async
 * no-silent-placeholder contract). Theme-keyed (theme drives resolved colors).
 *
 * @example mermaidVectorGeom("nope", "default") // null
 */
export function mermaidVectorGeom(def, theme = DEFAULT_MERMAID_THEME) {
  return vectorGeoms.get(`${def}|${theme}`) ?? null;
}

/**
 * Query. The Mermaid syntax-error MESSAGE for a definition that failed to parse,
 * or null if it parsed cleanly (or hasn't been rendered yet). The PLUGIN reads
 * this to render a loud in-widget error affordance. An empty definition never
 * errors (mermaidIsEmpty → the plugin ghosts it, never renders).
 *
 * @example mermaidErrorFor("flowchart TD\n A-->B") // null (valid, once rendered)
 */
export function mermaidErrorFor(def) {
  return parseErrors.get(def) ?? null;
}

/**
 * Pure function. The diagram's natural {w, h} in layout px from a rendered SVG
 * element — prefers the viewBox (the reliable aspect source; Mermaid sets
 * width/height to percentages or a capped max-width), falling back to the
 * width/height attributes, then a 1:1 square so a degenerate SVG still rasters.
 *
 * Args:
 *   svg (SVGSVGElement): a rendered Mermaid SVG root
 *
 * Returns:
 *   {w, h} in layout px (both >= 1)
 *
 * @example // svgNaturalSize(svgWithViewBox_0_0_200_120) // {w: 200, h: 120}
 */
export function svgNaturalSize(svg) {
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const wAttr = parseFloat(svg.getAttribute("width") || "");
  const hAttr = parseFloat(svg.getAttribute("height") || "");
  if (wAttr > 0 && hAttr > 0) return { w: wAttr, h: hAttr };
  return { w: 1, h: 1 };
}

/** Pure function. Condenses a Mermaid parse-error into a single readable line
 * for the in-widget affordance (Mermaid errors are often multi-line with a
 * caret diagram).
 *
 * @example cleanMermaidError({ message: "Parse error on line 2:\n...\nExpecting X" }) // "Parse error on line 2: Expecting X"
 * @example cleanMermaidError("boom") // "boom"
 */
export function cleanMermaidError(e) {
  const raw = String(e?.message ?? e ?? "Mermaid syntax error");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = lines[0] ?? "Mermaid syntax error";
  const expecting = lines.find((l) => /^Expecting/i.test(l));
  const msg = expecting && expecting !== head ? `${head} ${expecting}` : head;
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
}

/**
 * Command (near-pure: idempotent). Ensures a specific (def, theme, scale) is
 * rendered to an SVG, rasterized to a bitmap, and registered into the image
 * registry under mermaidRef(...), AND the natural aspect (aspects) is captured.
 * A no-op if that exact key is already loading/ready/errored — safe to call
 * every frame from a sync emit(). Fire-and-forget: the render path never awaits;
 * it reads mermaidRef(...) through the normal image_registry getImage/onImageLoad
 * path. Mirrors latex_raster.ensureLatexTypeset end to end, including the
 * reserveImageSlot-before-await race guard.
 *
 * @example // ensureMermaidRendered("flowchart TD\n A-->B", "default", 1); ...later... getImage(mermaidRef(...)) → ImageBitmap
 */
export function ensureMermaidRendered(def, theme = DEFAULT_MERMAID_THEME, scale = 1) {
  if (mermaidIsEmpty(def)) throw new Error("ensureMermaidRendered: def must be a non-empty string (the caller ghosts an empty diagram before calling)");
  const roundedScale = roundMermaidScale(scale);
  const key = `${def}|${theme}|${roundedScale}`;
  if (renders.has(key)) return renders.get(key).promise;

  const ref = mermaidRef(def, theme, scale);
  // Reserve the image-registry slot SYNCHRONOUSLY before any await (the race
  // guard latex_raster/pdf_page document): a compositor frame between "render
  // started" and "bitmap ready" must not ensureImage(ref) + fetch() the fake
  // "mermaid:…" ref and permanently latch it to error.
  reserveImageSlot(ref);
  const entry = { status: "loading", ref, error: null, promise: null };
  entry.promise = (async () => {
    const { renderMermaidSvg, parseMermaidDef, mermaidFontFaceCss } = await import("../../web/mermaidRenderer.js");

    // VALIDATE first — a syntax error is recorded (not thrown as infra) so the
    // plugin draws the loud affordance; a 1×1 transparent bitmap is registered
    // ONLY to wake the repaint that lets emit() switch to it.
    try {
      await parseMermaidDef(def);
      parseErrors.delete(def);
    } catch (e) {
      parseErrors.set(def, cleanMermaidError(e));
      entry.status = "error";
      registerRasterizedBitmap(ref, await transparentBitmap());
      return null;
    }

    const svgText = await renderMermaidSvg(def, theme);
    // ATTACH offscreen: the TRUE-VECTOR flatten below reads getScreenCTM /
    // getBBox / getComputedStyle, which return null/garbage on a detached node
    // (the resolveLatexGlyphs discipline). Removed in the finally.
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden";
    holder.innerHTML = svgText; // HTML parser handles inline SVG
    document.body.appendChild(holder);
    try {
      const svg = holder.querySelector("svg");
      if (!svg) throw new Error("mermaid_raster: renderMermaidSvg produced no <svg> element");

      const nat = svgNaturalSize(svg);
      aspects.set(`${def}|${theme}`, nat);

      // TRUE VECTOR (the crisp-at-any-zoom path, mirroring latex_raster's glyph
      // flatten): resolve the CSS-styled, transform-composed Mermaid tree to
      // viewBox-space vector paths + text on the PRISTINE svg (before the raster
      // width/height mutations below). A diagram that can't be vectorized
      // (foreignObject) leaves vectorGeoms unset → the plugin rasterizes AND we
      // warn LOUDLY (the task's no-silent-fallback rule); per-element punts are
      // reported once too. The raster still lands regardless (the async ref + the
      // HYBRID fallback for a diagram under a blur).
      const geom = flattenMermaidSvg(svg);
      for (const w of geom.warnings) reportOnce(`mermaid_vector:${w}`, `PowerRP mermaid_vector: ${w}`);
      if (geom.unflattenable) {
        reportOnce(`mermaid_vector:unflattenable:${key}`, `PowerRP mermaid_vector: cannot vectorize "${truncate(def)}" [${theme}] — ${geom.reason}; falling back to RASTER (pixelates on zoom)`);
      } else {
        vectorGeoms.set(`${def}|${theme}`, { paths: geom.paths, texts: geom.texts, viewBox: geom.viewBox });
      }

      // Supersampled pixel size at the item's world-scale bucket, capped uniformly.
      const density = MERMAID_SUPERSAMPLE * roundedScale;
      let pxW = Math.max(1, Math.round(nat.w * density));
      let pxH = Math.max(1, Math.round(nat.h * density));
      const over = Math.max(pxW, pxH) / MERMAID_MAX_RASTER_PX;
      if (over > 1) { pxW = Math.max(1, Math.round(pxW / over)); pxH = Math.max(1, Math.round(pxH / over)); }

      // Embed the bundled label face so the isolated <img> raster context draws
      // the SAME font Mermaid measured against (no network, faithful metrics).
      const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
      styleEl.textContent = await mermaidFontFaceCss();
      svg.insertBefore(styleEl, svg.firstChild);
      // Explicit intrinsic px for the <img>; drop any max-width cap Mermaid set.
      svg.setAttribute("width", `${pxW}`);
      svg.setAttribute("height", `${pxH}`);
      svg.style.maxWidth = "none";

      // Serialize + base64 (more robust than percent-encoding for an <img> SVG
      // data URI) → decode via <img> → draw to a 2D canvas → createImageBitmap
      // (the latex_raster raster step verbatim: canvas-drawImage is far more
      // reliable across browsers than createImageBitmap(svgImg) directly).
      const svgOut = new XMLSerializer().serializeToString(svg);
      const dataUri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgOut)))}`;
      const img = new Image();
      img.width = pxW;
      img.height = pxH;
      img.src = dataUri;
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
    } finally {
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    }
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    reportOnce(`mermaid_raster:render:${key}`, `PowerRP mermaid_raster: failed to render "${truncate(def)}" [${theme}] @${roundedScale}x — ${entry.error.message}`);
    return null;
  });
  renders.set(key, entry);
  return entry.promise;
}

/** Command. A 1×1 fully-transparent ImageBitmap (see ensureMermaidRendered: it
 * is registered on a parse error solely to wake the repaint-on-load, never
 * drawn — the plugin emits the error affordance instead of the image op). */
async function transparentBitmap() {
  return createImageBitmap(new ImageData(1, 1));
}

/**
 * Command. Drops all cached renders, aspects, and parse errors. For tests that
 * need a clean registry; the invalidation hook mirroring resetLatexRaster.
 */
export function resetMermaidRaster() {
  renders.clear();
  aspects.clear();
  parseErrors.clear();
  vectorGeoms.clear();
}
