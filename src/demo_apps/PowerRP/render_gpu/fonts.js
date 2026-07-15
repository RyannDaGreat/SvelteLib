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
};

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
  return FONTS[id] || FONTS[DEFAULT_FONT];
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
 */
export function fontOptions() {
  return Object.entries(FONTS).map(([value, d]) => ({ value, label: d.title }));
}

/**
 * Pure function. Every committed (id, bold, file) tuple — the set the web font
 * loader turns into @font-face rules and the PDF backend can pre-embed. Excludes
 * `system` (no file).
 *
 * @example committedFaces().length // 8 (4 families x regular/bold)
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
