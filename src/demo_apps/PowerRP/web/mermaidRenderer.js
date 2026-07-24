/**
 * Mermaid ENGINE bootstrap (BROWSER-ONLY module) — the single place that
 * lazy-loads + configures Mermaid offline and turns a diagram DEFINITION into a
 * self-contained SVG string. It is the mermaid analog of web/latexEditor.js
 * (which bootstraps the MathLive editor element): all Vite-only specifiers
 * (`import "mermaid"`, `../fonts/*.ttf?url`) and all Mermaid config live HERE,
 * so render_gpu/gpu/mermaid_raster.js (which must stay bare-node importable for
 * the node test suites) never statically references a Vite-only module — it
 * reaches this one only through a LAZY `await import(...)` on the browser render
 * path. This mirrors how latex_raster keeps its `mathjax/...?url` import inside
 * a lazy loader.
 *
 * ── WHY htmlLabels:false (the pivotal config) ─────────────────────────────────
 * By default Mermaid renders node/edge labels as HTML inside <foreignObject>.
 * A serialized SVG containing <foreignObject> CANNOT be rasterized through the
 * SVG→<img>→canvas path (the browser taints/blanks the canvas — the security
 * restriction the flag exists to sidestep). Forcing htmlLabels:false makes
 * Mermaid emit NATIVE SVG <text>, which rasterizes cleanly (the whole reason the
 * raster widget is tractable). Coverage is flowchart-solid; some diagram types
 * still emit foreignObject regardless — those raster poorly and are called out
 * loudly in the widget docs, not silently shipped broken.
 *
 * ── OFFLINE + PINNED (the manifest OFFLINE RULE) ──────────────────────────────
 * `mermaid` is pinned to an EXACT version in package.json (like `mathjax`:
 * 3.2.2) — Mermaid's config API drifts across minors (the htmlLabels history is
 * one example), so a floating caret could silently change output. The label
 * font is a BUNDLED, committed TTF (../fonts/Inter-*.ttf) embedded as base64 in
 * the raster SVG (see mermaidFontFaceCss) so text metrics are correct in the
 * isolated <img> raster context WITHOUT any network font fetch — the same
 * zero-network stance as the MathJax static render + MathLive's bundled fonts.
 *
 * ── FONT PINNING (raster fidelity) ────────────────────────────────────────────
 * Mermaid measures label text via the live DOM during layout, then the raster
 * step renders that layout in an isolated <img> context that does NOT inherit
 * the page's fonts. If the two contexts disagree on the label font, node boxes
 * are sized for one metric and the text drawn in another (overflow/clipping). So
 * we pin Mermaid's fontFamily to "PowerRP Inter" — the SAME committed face
 * web/fontLoader.js loads into document.fonts at boot (used for measurement) AND
 * the face mermaidFontFaceCss embeds in the raster SVG — so measurement and
 * raster agree.
 */
import mermaid from "mermaid";
import InterRegularUrl from "../fonts/Inter-Regular.ttf?url";
import InterBoldUrl from "../fonts/Inter-Bold.ttf?url";

/** The label font family Mermaid is pinned to. MUST equal a family both loaded
 * into document.fonts for measurement (web/fontLoader.js registers "PowerRP
 * Inter" from the committed Inter TTF) AND embedded in the raster SVG
 * (mermaidFontFaceCss) — so the layout-measure font and the raster-draw font are
 * the same face, or node boxes mis-size against their text. */
export const MERMAID_FONT_FAMILY = "PowerRP Inter";

let initialized = false;
/** Command (idempotent). Configures Mermaid ONCE for offline, static,
 * native-SVG-text rendering. Safe to call before every render. */
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,       // we convert strings via render(), never scan the page
    securityLevel: "strict",  // DOMPurify-sanitized output; no script/foreignObject injection
    htmlLabels: false,        // NATIVE SVG <text> (the raster-critical flag; see header)
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    fontFamily: `"${MERMAID_FONT_FAMILY}", system-ui, sans-serif`,
    themeVariables: { fontFamily: `"${MERMAID_FONT_FAMILY}", system-ui, sans-serif` },
  });
}

let renderSeq = 0;

/**
 * Query (browser only — Mermaid lays out via the DOM). Renders a diagram
 * definition to a self-contained SVG string at the given Mermaid theme. Each
 * call uses a unique element id (Mermaid removes any prior element with the same
 * id, so a stable id would let concurrent renders clobber each other). The theme
 * is applied via a per-diagram `%%{init}%%` directive rather than a global
 * mutation, so concurrent renders of different themes never race on global
 * config. Throws on a DOM-less environment or a Mermaid failure (never a silent
 * empty SVG).
 *
 * Args:
 *   def (string): the Mermaid diagram source
 *   theme (string): a Mermaid theme id (see MERMAID_THEMES)
 *
 * Returns:
 *   Promise<string>: the rendered SVG markup
 *
 * @example // await renderMermaidSvg("flowchart TD\n A-->B", "default") // "<svg ...>...</svg>"
 */
export async function renderMermaidSvg(def, theme) {
  if (typeof document === "undefined")
    throw new Error("mermaidRenderer: Mermaid needs a DOM (document); this module is browser-facing, not bare node");
  ensureInitialized();
  const id = `powerrp-mermaid-${renderSeq++}`;
  // TRIM before anything reaches Mermaid: its diagram-type detection requires the
  // keyword (`flowchart`, `sequenceDiagram`, …) at the VERY START of the text, so
  // a LEADING newline/whitespace makes a perfectly valid diagram report "No
  // diagram type detected" — a false failure that must render, not error. The
  // init directive is prepended AFTER the trim so detection sees the keyword
  // first. (A directive alone does not rescue a leading newline in `def`: Mermaid
  // strips the directive, then still sees the leading blank line.)
  const clean = String(def ?? "").trim();
  // Per-diagram theme via an init directive (merged for THIS render only, no
  // global config mutation → concurrent renders of different themes are safe).
  const directive = `%%{init: ${JSON.stringify({ theme })}}%%\n`;
  const { svg } = await mermaid.render(id, directive + clean);
  return svg;
}

/**
 * Query (browser only). Validates a diagram definition via Mermaid's own parser.
 * Resolves when valid; REJECTS with the Mermaid syntax error otherwise (the loud
 * error hook the widget turns into an in-canvas red affordance). Kept separate
 * from render so a parse failure yields a clean message before any DOM work.
 *
 * @example // await parseMermaidDef("flowchart TD\n A-->B") // resolves
 * @example // await parseMermaidDef("not a diagram")        // rejects (syntax error)
 */
export async function parseMermaidDef(def) {
  if (typeof document === "undefined")
    throw new Error("mermaidRenderer: Mermaid needs a DOM (document); this module is browser-facing, not bare node");
  ensureInitialized();
  // TRIM to match renderMermaidSvg: a leading newline breaks Mermaid's
  // diagram-type detection, so an untrimmed valid diagram would falsely "fail"
  // parse and trip the widget's error affordance (the reported bug).
  await mermaid.parse(String(def ?? "").trim()); // throws on invalid syntax (suppressErrors defaults false)
}

/** Pure function. Base64-encodes an ArrayBuffer in fixed-size chunks (a single
 * String.fromCharCode(...bytes) overflows the call stack for an ~80 KB font).
 *
 * @example // arrayBufferToBase64(new Uint8Array([104,105]).buffer) // "aGk="
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32 KiB per String.fromCharCode call — safely under the arg-count limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

let fontCssPromise = null;
/**
 * Query (browser only — fetches the bundled font assets, memoized). Builds the
 * @font-face CSS embedding the committed Inter TTFs (regular + bold) as base64
 * data URIs under MERMAID_FONT_FAMILY. mermaid_raster injects this into the SVG
 * <style> before rasterizing so the isolated <img> context draws the SAME face
 * Mermaid measured against (no network). Memoized — the bytes never change.
 *
 * @example // await mermaidFontFaceCss() // "@font-face{font-family:\"PowerRP Inter\";...}"
 */
export function mermaidFontFaceCss() {
  if (fontCssPromise) return fontCssPromise;
  fontCssPromise = (async () => {
    const [regular, bold] = await Promise.all([
      fetch(InterRegularUrl).then((r) => r.arrayBuffer()),
      fetch(InterBoldUrl).then((r) => r.arrayBuffer()),
    ]);
    const face = (b64, weight) =>
      `@font-face{font-family:"${MERMAID_FONT_FAMILY}";font-style:normal;font-weight:${weight};src:url(data:font/ttf;base64,${b64}) format("truetype");}`;
    return face(arrayBufferToBase64(regular), 400) + face(arrayBufferToBase64(bold), 700);
  })();
  return fontCssPromise;
}
