/**
 * Web font loader — turns the committed TTF FILES (../fonts/) into loaded
 * browser faces so the WebGPU glyph atlas (canvas2D rasterization) draws the
 * REAL font instead of silently substituting.
 *
 * WHY a JS module and not a plain app.css @font-face block: the atlas
 * rasterizes through canvas2D, and canvas2D uses a font ONLY once it is loaded
 * — a bare @font-face declares the face but does NOT load it until something
 * paints DOM text in it, which the canvas never does. So we must (1) register
 * each committed face with the exact family name fonts.js uses, and (2)
 * actually trigger the load and AWAIT it before the first atlas rasterization,
 * or the editor shows the wrong glyphs with no invalidation. The bytes come
 * from Vite `?url` asset imports (hashed, bundled, served locally — the OFFLINE
 * rule holds: no network, the files are in the repo).
 *
 * main.js imports and awaits this once at boot; the CanvasView/compositor path
 * only rasterizes after mount, by which point the promise is settled. Command
 * (registers global FontFaces + triggers loads).
 */

import { committedFaces } from "../render_gpu/fonts.js";

/**
 * The committed TTF url map: basename → hashed asset URL. Vite inlines every
 * match at BUILD time (eager), so this is a static, offline-safe table — no
 * dynamic fetch, no network. The glob is relative to THIS file (web/).
 */
const FONT_URLS = import.meta.glob("../fonts/*.ttf", { query: "?url", import: "default", eager: true });

/** Query. The hashed URL for a committed font basename, or null if no bundled
 * file matches — a registry/file mismatch, or (common in dev) a font added
 * AFTER the running dev server last globbed ../fonts/*.ttf. Callers must skip a
 * null face LOUDLY; a single missing font must never brick the editor. */
function urlFor(basename) {
  return FONT_URLS[`../fonts/${basename}`] ?? null;
}

let loadPromise = null;

/**
 * Command (idempotent; registers FontFaces on document.fonts, triggers loads).
 * Returns a promise that resolves when every committed face is ready to
 * rasterize. Safe to call more than once (memoized). A face that fails to load
 * is reported LOUDLY and the promise still resolves for the rest — one bad
 * font must not black-hole the whole editor (and the atlas degrades to the CSS
 * fallback for that one, which is visible, not silent).
 */
export function loadFonts() {
  if (loadPromise) return loadPromise;
  if (typeof document === "undefined" || !document.fonts) {
    // No FontFace API (bare node / SSR) — nothing to load; the atlas will use
    // whatever the environment's canvas provides. Not an error here.
    loadPromise = Promise.resolve([]);
    return loadPromise;
  }
  loadPromise = Promise.all(
    committedFaces().map(async ({ cssFamily, bold, file }) => {
      const url = urlFor(file);
      if (!url) {
        // Missing bundled file — most often a font added AFTER the running dev
        // server last globbed ../fonts/*.ttf (restart it to re-glob), or a
        // fonts.js/file mismatch. Report LOUDLY and SKIP just this face: one
        // missing font must NOT brick the whole editor (this module's contract).
        // Its text falls back to the CSS generic — visible, not silent.
        console.error(`fontLoader: committed font "${file}" (${cssFamily} ${bold ? "Bold" : "Regular"}) has no bundled file at ../fonts/${file} — SKIPPING (falls back to CSS generic). If you just added it, restart the dev server to re-glob.`);
        return { cssFamily, bold, ok: false };
      }
      const face = new FontFace(cssFamily, `url("${url}")`, {
        weight: bold ? "700" : "400",
        style: "normal",
        display: "swap",
      });
      try {
        await face.load();
        document.fonts.add(face);
        return { cssFamily, bold, ok: true };
      } catch (e) {
        console.error(`fontLoader: failed to load ${cssFamily} ${bold ? "Bold" : "Regular"} (${file}) — text in this font falls back to the CSS generic. ${e.message}`);
        return { cssFamily, bold, ok: false };
      }
    }),
  );
  return loadPromise;
}

// Which dynamic (uploaded) families are already loaded into document.fonts, so
// re-listing a project's assets never re-fetches an already-registered face.
const loadedDynamicFamilies = new Set();

/**
 * Command (registers ONE uploaded font-asset face on document.fonts; awaits its
 * load). The browser twin of the committed-font loader for the "font as an
 * ASSET" seam (#26): a project-uploaded family (render_gpu/fonts.js dynamic
 * registry) becomes a real canvas2D/CSS face loaded from its SERVED asset URL
 * (not the ../fonts/ glob — the bytes live in the project). Idempotent per
 * cssFamily. Loud + REJECTS on an invalid font file (a corrupt upload must fail
 * visibly, per the #26 "loud on invalid font" rule) — but returns early (no
 * throw) for an already-loaded family or a non-DOM environment.
 *
 * @param {string} cssFamily unique family name (fonts.js fontAssetCssFamily)
 * @param {string} url served asset URL of the font file
 */
export async function loadDynamicFont(cssFamily, url) {
  if (typeof document === "undefined" || !document.fonts) return; // bare node / SSR — nothing to load
  if (loadedDynamicFamilies.has(cssFamily)) return;
  const face = new FontFace(cssFamily, `url("${url}")`, { style: "normal", display: "swap" });
  try {
    await face.load();
  } catch (e) {
    // An invalid/corrupt font file: report LOUDLY and re-raise so the upload
    // gesture surfaces "not a valid font" (no silent accept of broken bytes).
    throw new Error(`loadDynamicFont: "${cssFamily}" (${url}) is not a valid font file — ${e.message}`);
  }
  document.fonts.add(face);
  loadedDynamicFamilies.add(cssFamily);
}
