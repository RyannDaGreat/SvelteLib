/**
 * MathLive bootstrap (BROWSER-ONLY side-effect module). Importing it:
 *   1. Registers the `<math-field>` custom element (the WYSIWYG equation editor
 *      LatexEditController mounts) — MathLive's default export side-effect.
 *   2. Bundles MathLive's KaTeX webfonts OFFLINE via `mathlive/fonts.css`. That
 *      stylesheet's @font-face rules use relative `url(fonts/*.woff2)`, which
 *      Vite resolves + fingerprints at build (no network), AND it sets
 *      `:root{--ML__static-fonts:true}` — the flag MathLive reads to SKIP its
 *      dynamic (network) font loader. Same zero-network stance as the MathJax
 *      static render.
 *   3. Disables the key-click sounds (an editor, not a toy) so MathLive never
 *      requests a sounds directory (which would 404).
 *
 * IMPORT SITE: web/CanvasView.svelte (a browser module) imports this STATICALLY,
 * so the bundle + fonts load at app boot — PRE-WARMED, so the user's first
 * double-click doesn't pay the load latency. It is never reached from core/
 * (bare-node tests) — `MathfieldElement` and its font loading are browser-only,
 * exactly like the render_gpu GPU modules.
 */
import "mathlive/fonts.css";
import { MathfieldElement } from "mathlive";

// No audio feedback (and no sounds-directory fetch). Set once, module-global —
// MathfieldElement config is static across all fields (MathLive's design).
MathfieldElement.soundsDirectory = null;

export { MathfieldElement };
