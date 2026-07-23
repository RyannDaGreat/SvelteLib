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

/** Query. The hashed URL for a committed font basename (loud if missing — a
 * registry/file mismatch is a build error, never a silent fallback). */
function urlFor(basename) {
  const key = `../fonts/${basename}`;
  const url = FONT_URLS[key];
  if (!url) throw new Error(`fontLoader: committed font "${basename}" is in the registry but no file was found at ${key} — commit the .ttf or fix fonts.js`);
  return url;
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
      const face = new FontFace(cssFamily, `url("${urlFor(file)}")`, {
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
