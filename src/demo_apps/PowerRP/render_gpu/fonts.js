/**
 * THE FONT REGISTRY — the single hardcoded home for PowerRP's committed fonts
 * (manifest "Text fonts"). Font FILES live in ../fonts/ and are committed into
 * the repo; this module names them and maps a font id → CSS family + files, so
 * BOTH renderers agree on the same faces:
 *   - the WebGPU glyph atlas rasterizes via canvas2D using `cssFamily`
 *     (loaded from the local files by @font-face — see web/fontLoader.js);
 *   - the PDF backend embeds the SAME committed TTF (see pdf_backend.js
 *     ensureFonts), so raster text and vector text share metrics.
 *
 * DOM-free (importable in bare node — the pdf tests import it). Byte-loading of
 * the actual TTFs is environment-specific (Vite ?url in the browser,
 * readFileSync in node), so it is NOT here: callers resolve a file name to
 * bytes through their own seam. This module is pure data + pure helpers.
 *
 * BACK-COMPAT: `system` is the default. It has NO committed file — it is the OS
 * `system-ui, sans-serif` stack the app used before the fonts task, so an old
 * document with no `font` property renders byte-identically (no migration).
 * The PDF backend falls back to standard-14 Helvetica for `system`.
 *
 * FUTURE (do not corner): rich text will carry a `font` per RUN, not just per
 * widget — that is why the IR text op's `font` field and the atlas key are
 * per-run-shaped already. Adding a family = one entry here + committing its
 * two TTFs + citing its license in ../fonts/README.md.
 */

/**
 * The default font id. `system` = the OS UI stack, no committed file — the
 * pre-fonts-task behavior, kept as the default so existing docs are unchanged
 * (manifest: "defaulting to the current system stack for backward compat").
 */
export const DEFAULT_FONT = "system";

/** The system stack — the ONE place the old hardcoded string lives now. */
const SYSTEM_STACK = "system-ui, sans-serif";

/**
 * Registry: font id → descriptor. `file` maps weight → committed TTF basename
 * (relative to ../fonts/); `null` file (system) = no embeddable face.
 * `cssFamily` is what canvas2D / CSS name the face; for committed fonts it is a
 * UNIQUE name (the id) so a local @font-face can never collide with a same-named
 * OS font. `fallback` chains to a generic family for any glyph the subset lacks.
 */
export const FONTS = {
  system: {
    title: "System UI",
    kind: "sans",
    cssFamily: SYSTEM_STACK, // already a full stack — used verbatim
    fallback: "",            // it IS the fallback
    files: { regular: null, bold: null },
  },
  inter: {
    title: "Inter",
    kind: "sans",
    cssFamily: "PowerRP Inter",
    fallback: "sans-serif",
    files: { regular: "Inter-Regular.ttf", bold: "Inter-Bold.ttf" },
  },
  "source-serif": {
    title: "Source Serif",
    kind: "serif",
    cssFamily: "PowerRP Source Serif",
    fallback: "serif",
    files: { regular: "SourceSerif4-Regular.ttf", bold: "SourceSerif4-Bold.ttf" },
  },
  lora: {
    title: "Lora",
    kind: "serif",
    cssFamily: "PowerRP Lora",
    fallback: "serif",
    files: { regular: "Lora-Regular.ttf", bold: "Lora-Bold.ttf" },
  },
  "jetbrains-mono": {
    title: "JetBrains Mono",
    kind: "mono",
    cssFamily: "PowerRP JetBrains Mono",
    fallback: "monospace",
    files: { regular: "JetBrainsMono-Regular.ttf", bold: "JetBrainsMono-Bold.ttf" },
  },
  // ── Round 26 batch: well-known display/body families (OFL/Apache; see
  // ../fonts/README.md). Each ships Regular + Bold static instances, so they
  // flow through EVERY seam automatically (committedFaces → fontLoader +
  // Skia providers + PDF/SVG embed), exactly like the originals above. ──
  roboto: {
    title: "Roboto",
    kind: "sans",
    cssFamily: "PowerRP Roboto",
    fallback: "sans-serif",
    files: { regular: "Roboto-Regular.ttf", bold: "Roboto-Bold.ttf" },
  },
  poppins: {
    title: "Poppins",
    kind: "sans",
    cssFamily: "PowerRP Poppins",
    fallback: "sans-serif",
    files: { regular: "Poppins-Regular.ttf", bold: "Poppins-Bold.ttf" },
  },
  montserrat: {
    title: "Montserrat",
    kind: "sans",
    cssFamily: "PowerRP Montserrat",
    fallback: "sans-serif",
    files: { regular: "Montserrat-Regular.ttf", bold: "Montserrat-Bold.ttf" },
  },
  oswald: {
    title: "Oswald",
    kind: "sans", // condensed display sans
    cssFamily: "PowerRP Oswald",
    fallback: "sans-serif",
    files: { regular: "Oswald-Regular.ttf", bold: "Oswald-Bold.ttf" },
  },
  merriweather: {
    title: "Merriweather",
    kind: "serif",
    cssFamily: "PowerRP Merriweather",
    fallback: "serif",
    files: { regular: "Merriweather-Regular.ttf", bold: "Merriweather-Bold.ttf" },
  },
  "playfair-display": {
    title: "Playfair Display",
    kind: "serif", // high-contrast display serif
    cssFamily: "PowerRP Playfair Display",
    fallback: "serif",
    files: { regular: "PlayfairDisplay-Regular.ttf", bold: "PlayfairDisplay-Bold.ttf" },
  },
  // Futura — proper Futura is proprietary (not OFL, not on Google Fonts), so
  // this bundles JOST, the OFL geometric-sans Futura revival on Google Fonts
  // (see ../fonts/README.md). Labeled honestly as "Futura (Jost)"; ships Regular
  // + Bold static instances so it flows through every seam like the others.
  futura: {
    title: "Futura (Jost)",
    kind: "sans", // geometric sans
    cssFamily: "PowerRP Futura",
    fallback: "sans-serif",
    files: { regular: "Jost-Regular.ttf", bold: "Jost-Bold.ttf" },
  },
};

/**
 * DYNAMIC (project-uploaded) font registry — the "font as an ASSET" seam
 * (manifest #26). A user uploads a font FILE; it becomes a project asset of
 * kind "font" and is registered HERE at runtime so it resolves through the
 * SAME pure functions the committed families use (fontDescriptor →
 * cssFamilyFor/fontFamilyChain/fontOptions). This keeps ONE resolution point:
 * glyph_atlas/text_layout/pdf/svg need NO change to render an uploaded family.
 *
 * A dynamic descriptor mirrors a committed one but carries `url` (the served
 * asset path — its bytes live in the project's assets/, NOT ../fonts/) and
 * `dynamic: true`, and its `files` are null (there is no bundled basename).
 * The browser FontFace loader (web/fontLoader.js) and the Skia provider seam
 * consume `dynamicFontFaces()` to actually LOAD the bytes from `url`.
 *
 * Keyed by font id (asset id, e.g. "font-asset:MyFace.ttf"). Module-level and
 * viewer-local: cleared on project switch (clearDynamicFonts) so one project's
 * uploaded fonts never leak into another.
 */
const DYNAMIC_FONTS = {};

/** The font-id prefix marking a project-uploaded font asset (vs a committed id). */
export const FONT_ASSET_PREFIX = "font-asset:";

/**
 * Pure function. The stable font id for an uploaded font asset filename — a
 * prefixed, collision-free id a text run stores in its `font` property.
 *
 * @example fontAssetId("Handwriting.ttf") // "font-asset:Handwriting.ttf"
 * @example fontAssetId("My Font.otf") // "font-asset:My Font.otf"
 */
export function fontAssetId(filename) {
  return `${FONT_ASSET_PREFIX}${filename}`;
}

/**
 * Pure function. The unique CSS/Skia family name for an uploaded font asset —
 * prefixed so a local face can never collide with a committed or OS font.
 *
 * @example fontAssetCssFamily("Handwriting.ttf") // "PowerRP Font Handwriting.ttf"
 */
export function fontAssetCssFamily(filename) {
  return `PowerRP Font ${filename}`;
}

/**
 * Command (mutates the module-level DYNAMIC_FONTS map). Register an uploaded
 * font asset as a SELECTABLE family. Idempotent: re-registering the same id
 * (e.g. a project re-list) overwrites its descriptor. `kind` picks the generic
 * fallback (serif/mono → serif/monospace, else sans-serif). Loud on a missing
 * id/url (a caller bug — never a silent no-op).
 *
 * @param {string} id - the font id (fontAssetId(filename))
 * @param {object} spec - {filename, url, kind?, title?}
 * @returns {object} the stored descriptor
 */
export function registerFontFamily(id, spec) {
  if (!id || !spec || !spec.url) {
    throw new Error(`registerFontFamily: need a font id and a {url} — got id=${JSON.stringify(id)}, spec=${JSON.stringify(spec)}`);
  }
  const kind = spec.kind === "serif" || spec.kind === "mono" ? spec.kind : "sans";
  const fallback = kind === "serif" ? "serif" : kind === "mono" ? "monospace" : "sans-serif";
  const descriptor = {
    title: spec.title || spec.filename || id,
    kind,
    cssFamily: fontAssetCssFamily(spec.filename ?? id),
    fallback,
    files: { regular: null, bold: null }, // bytes come from `url`, not ../fonts/
    dynamic: true,
    url: spec.url,
  };
  DYNAMIC_FONTS[id] = descriptor;
  return descriptor;
}

/**
 * Command (mutates DYNAMIC_FONTS). Drop every registered dynamic font — the
 * project-switch reset (a new project's font assets re-register on load).
 *
 * @example // clearDynamicFonts(); fontOptions().every((o) => !o.value.startsWith("font-asset:")) // true
 */
export function clearDynamicFonts() {
  for (const k of Object.keys(DYNAMIC_FONTS)) delete DYNAMIC_FONTS[k];
}

/**
 * Query. The registered dynamic faces to LOAD at runtime: {id, cssFamily, url}
 * per uploaded font asset. web/fontLoader.js turns these into FontFaces and the
 * Skia provider seam registers them so an uploaded family renders (no tofu).
 *
 * @example // after registerFontFamily("font-asset:X.ttf", {filename:"X.ttf", url:"/asset/P/X.ttf"}):
 * // dynamicFontFaces() // [{id:"font-asset:X.ttf", cssFamily:"PowerRP Font X.ttf", url:"/asset/P/X.ttf"}]
 */
export function dynamicFontFaces() {
  return Object.entries(DYNAMIC_FONTS).map(([id, d]) => ({ id, cssFamily: d.cssFamily, url: d.url }));
}

/**
 * Pure function. The descriptor for a font id, falling back to DEFAULT_FONT for
 * an unknown/absent id (old docs, a removed family) — a missing font must never
 * throw in the render path; it degrades to system.
 *
 * @example fontDescriptor("inter").title // "Inter"
 * @example fontDescriptor(undefined).cssFamily // "system-ui, sans-serif"
 * @example fontDescriptor("no-such-font").kind // "sans" (degrades to system)
 */
export function fontDescriptor(id) {
  return DYNAMIC_FONTS[id] || FONTS[id] || FONTS[DEFAULT_FONT];
}

/**
 * Pure function. The CSS `font-family` value for a font id — the committed
 * face's unique family plus its generic fallback, or the raw system stack.
 *
 * @example cssFamilyFor("inter") // "\"PowerRP Inter\", sans-serif"
 * @example cssFamilyFor("system") // "system-ui, sans-serif"
 * @example cssFamilyFor("jetbrains-mono") // "\"PowerRP JetBrains Mono\", monospace"
 */
export function cssFamilyFor(id) {
  const d = fontDescriptor(id);
  if (!d.fallback) return d.cssFamily; // system stack — already complete
  return `"${d.cssFamily}", ${d.fallback}`;
}

/**
 * Pure function. The committed TTF basename for (id, bold), or null when the
 * font has no embeddable file (system). Callers resolve the basename to bytes
 * through their own environment seam (../fonts/<basename>).
 *
 * @example fontFileFor("inter", false) // "Inter-Regular.ttf"
 * @example fontFileFor("inter", true) // "Inter-Bold.ttf"
 * @example fontFileFor("system", false) // null
 */
export function fontFileFor(id, bold) {
  const d = fontDescriptor(id);
  return bold ? d.files.bold : d.files.regular;
}

/**
 * Pure function. Does this font id have committed files to embed? (false for
 * `system` — the PDF backend uses standard-14 Helvetica there.)
 *
 * @example hasEmbeddableFile("inter") // true
 * @example hasEmbeddableFile("system") // false
 */
export function hasEmbeddableFile(id) {
  return fontFileFor(id, false) != null;
}

/**
 * Pure function. The dropdown option list for the text widget's font row —
 * `{value, label}` per registered font, system first (the default).
 *
 * @example fontOptions()[0] // {value: "system", label: "System UI"}
 * @example fontOptions().some((o) => o.value === "jetbrains-mono") // true
 * @example fontOptions().some((o) => o.value === "roboto") // true (Round 26 batch)
 */
export function fontOptions() {
  const committed = Object.entries(FONTS).map(([value, d]) => ({ value, label: d.title }));
  const dynamic = Object.entries(DYNAMIC_FONTS).map(([value, d]) => ({ value, label: d.title }));
  return [...committed, ...dynamic];
}

/**
 * Pure function. Every committed (id, bold, file) tuple — the set the web font
 * loader turns into @font-face rules and the PDF backend can pre-embed. Excludes
 * `system` (no file).
 *
 * @example committedFaces().length // 22 (11 families x regular/bold)
 * @example committedFaces()[0].file.endsWith(".ttf") // true
 */
export function committedFaces() {
  const out = [];
  for (const [id, d] of Object.entries(FONTS)) {
    if (d.files.regular) out.push({ id, bold: false, cssFamily: d.cssFamily, file: d.files.regular });
    if (d.files.bold) out.push({ id, bold: true, cssFamily: d.cssFamily, file: d.files.bold });
  }
  return out;
}

// ── SKIA TEXT-RENDER FALLBACK CHAIN (per-codepoint fallback + COLOR EMOJI) ─────
// The Skia (CanvasKit) screen renderer lays text out with the Paragraph API and a
// FontCollection. Behind every SELECTABLE family it appends this fallback chain so
// codepoints the primary font lacks — Greek/Cyrillic beyond Inter's coverage,
// Arabic, and COLOR EMOJI — resolve to real glyphs instead of ☐ tofu. These faces
// are NOT in the font dropdown; they exist only to catch missing glyphs.
//
// SCOPE: these feed ONLY the Skia render. SVG/PDF vector export still layouts via
// core/richtext.js + the committed selectable families (fonts/README.md documents
// the screen-vs-export parity follow-up). Coverage is deliberately BROAD (manifest
// rule: bundle size is irrelevant — NO script should render as ☐ tofu): CJK
// (Japanese / Simplified Chinese / Korean), Hebrew, Thai, and the major Indic +
// Southeast-Asian + Caucasus + Ethiopic scripts are all committed and registered
// here. Each is a static Regular instance (fonts/README.md rebuild recipe); only
// `Noto Sans` (Latin/Greek/Cyrillic) carries a bold face too. COLOR EMOJI is last.

/**
 * The fallback FAMILY names, in priority order, appended after the primary. Emoji
 * is LAST on purpose: text scripts get first claim on any shared codepoint so a
 * symbol with both a text and an emoji form renders as text; the color-emoji face
 * only catches codepoints nothing else covers. Han (CJK) order — JP, SC, KR — sets
 * which regional glyph shape wins for the ideographs the three share; every order
 * is tofu-free, this one just favors Japanese shapes for unlabeled runs.
 */
export const FALLBACK_FAMILIES = [
  "Noto Sans", // Latin / Greek / Cyrillic
  "Noto Sans Arabic",
  "Noto Sans Hebrew",
  "Noto Sans Thai",
  "Noto Sans Devanagari",
  "Noto Sans Bengali",
  "Noto Sans Tamil",
  "Noto Sans Telugu",
  "Noto Sans Kannada",
  "Noto Sans Malayalam",
  "Noto Sans Gujarati",
  "Noto Sans Gurmukhi",
  "Noto Sans Georgian",
  "Noto Sans Armenian",
  "Noto Sans Khmer",
  "Noto Sans Sinhala",
  "Noto Sans Lao",
  "Noto Sans Myanmar",
  "Noto Sans Ethiopic",
  "Noto Sans JP", // CJK — kana + Han (Japanese shapes)
  "Noto Sans SC", // CJK — Simplified Chinese Han
  "Noto Sans KR", // CJK — Hangul + Han
  "Noto Color Emoji", // COLOR emoji — LAST (catch-all for emoji-only codepoints)
];

/**
 * The (family, bold, file) tuples the CanvasKit loaders register into the shared
 * TypefaceFontProvider. `Noto Sans` carries both weights under ONE family (Skia
 * matches the weight via the run's fontStyle); every other fallback family is a
 * single static Regular face (Skia synthesizes bold if a run needs it). `Noto
 * Color Emoji` is the CBDT/CBLC COLOR build (never tinted). The loaders register
 * ALL of these and call enableFontFallback(), so a glyph missing from the run's
 * families resolves to whichever registered face has it — no ☐ tofu.
 */
export const FALLBACK_FACES = [
  { family: "Noto Sans", bold: false, file: "NotoSans-Regular.ttf" },
  { family: "Noto Sans", bold: true, file: "NotoSans-Bold.ttf" },
  { family: "Noto Sans Arabic", bold: false, file: "NotoSansArabic-Regular.ttf" },
  { family: "Noto Sans Hebrew", bold: false, file: "NotoSansHebrew-Regular.ttf" },
  { family: "Noto Sans Thai", bold: false, file: "NotoSansThai-Regular.ttf" },
  { family: "Noto Sans Devanagari", bold: false, file: "NotoSansDevanagari-Regular.ttf" },
  { family: "Noto Sans Bengali", bold: false, file: "NotoSansBengali-Regular.ttf" },
  { family: "Noto Sans Tamil", bold: false, file: "NotoSansTamil-Regular.ttf" },
  { family: "Noto Sans Telugu", bold: false, file: "NotoSansTelugu-Regular.ttf" },
  { family: "Noto Sans Kannada", bold: false, file: "NotoSansKannada-Regular.ttf" },
  { family: "Noto Sans Malayalam", bold: false, file: "NotoSansMalayalam-Regular.ttf" },
  { family: "Noto Sans Gujarati", bold: false, file: "NotoSansGujarati-Regular.ttf" },
  { family: "Noto Sans Gurmukhi", bold: false, file: "NotoSansGurmukhi-Regular.ttf" },
  { family: "Noto Sans Georgian", bold: false, file: "NotoSansGeorgian-Regular.ttf" },
  { family: "Noto Sans Armenian", bold: false, file: "NotoSansArmenian-Regular.ttf" },
  { family: "Noto Sans Khmer", bold: false, file: "NotoSansKhmer-Regular.ttf" },
  { family: "Noto Sans Sinhala", bold: false, file: "NotoSansSinhala-Regular.ttf" },
  { family: "Noto Sans Lao", bold: false, file: "NotoSansLao-Regular.ttf" },
  { family: "Noto Sans Myanmar", bold: false, file: "NotoSansMyanmar-Regular.ttf" },
  { family: "Noto Sans Ethiopic", bold: false, file: "NotoSansEthiopic-Regular.ttf" },
  { family: "Noto Sans JP", bold: false, file: "NotoSansJP-Regular.ttf" },
  { family: "Noto Sans SC", bold: false, file: "NotoSansSC-Regular.ttf" },
  { family: "Noto Sans KR", bold: false, file: "NotoSansKR-Regular.ttf" },
  { family: "Noto Color Emoji", bold: false, file: "NotoColorEmoji.ttf" },
];

/**
 * Pure function. The ordered CanvasKit `fontFamilies` chain for a font id: the
 * id's own committed family first, then the broad fallback families. `system`
 * (no committed file) resolves to Inter — the same stand-in the render path has
 * always used for the OS default — so old docs render unchanged, just now with
 * emoji/unicode fallback behind them.
 *
 * @example fontFamilyChain("inter")[0] // "PowerRP Inter"
 * @example fontFamilyChain("system")[0] // "PowerRP Inter" (system → Inter stand-in)
 * @example fontFamilyChain("jetbrains-mono").slice(0, 2) // ["PowerRP JetBrains Mono", "Noto Sans"]
 * @example fontFamilyChain("inter").at(-1) // "Noto Color Emoji" (emoji catch-all is always last)
 */
export function fontFamilyChain(id) {
  const d = fontDescriptor(id);
  // A face with a generic `fallback` has its OWN primary family (committed
  // families + dynamic uploads); only `system` (empty fallback, no bundled
  // file) stands in with Inter. So this is behavior-identical for every
  // committed font AND lets an uploaded family lead its own chain.
  const primary = d.fallback ? d.cssFamily : FONTS.inter.cssFamily;
  return [primary, ...FALLBACK_FAMILIES];
}
