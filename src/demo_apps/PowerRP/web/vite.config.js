import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { powerrpServiceWorker, powerrpManifestDev } from "./swBuildPlugin.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// PowerRP's own dev server per the demo_apps convention (odd port to avoid
// collisions — the annotator uses 3635). Vite serves the app and proxies the
// project-server routes (/api, /asset) to the Python backend, so it's ONE URL
// with live reload (start_server.sh wires BACKEND_URL to the chosen backend
// port). Without the backend running (plain `npx vite`), the proxy targets
// nothing and the server-backed commands just report a fetch error loudly —
// local file save/load + localStorage autosave keep working.
const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, "../../../.."); // src/lib + src/styles live here
const BACKEND = process.env.BACKEND_URL || "http://localhost:3638";
// STATIC BUILD BASE PATH. GitHub Pages serves a project site under
// "https://<user>.github.io/<repo>/", so every emitted asset URL must be
// prefixed with that subpath or the bundle 404s on its own modules. Vite bakes
// `base` into the built HTML/JS at BUILD time (it cannot be discovered at
// runtime), which is why this is an env var the workflow sets rather than a
// constant: the same config serves `npm run dev` (base "/"), a local
// `vite preview --base /SvelteLib/` rehearsal, and the Pages deploy.
//
// It MUST end in a slash — Vite joins it to asset paths by concatenation, so
// "/SvelteLib" would emit "/SvelteLibassets/…". Normalized here rather than
// trusted, because the failure is silent in the build and total at runtime.
const rawBase = process.env.POWERRP_BASE || "/";
const BASE = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
const TLS_CERT = process.env.POWERRP_TLS_CERT;
const TLS_KEY = process.env.POWERRP_TLS_KEY;
const PUBLIC_HOST = process.env.POWERRP_PUBLIC_HOST;
const APP_PORT = Number(process.env.POWERRP_APP_PORT || 0);
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY))
  throw new Error("POWERRP_TLS_CERT and POWERRP_TLS_KEY must be set together");
if (PUBLIC_HOST && !APP_PORT)
  throw new Error("POWERRP_APP_PORT is required with POWERRP_PUBLIC_HOST");
const HTTPS = TLS_CERT
  ? { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }
  : undefined;
const HMR = PUBLIC_HOST
  ? { host: PUBLIC_HOST, protocol: HTTPS ? "wss" : "ws", clientPort: APP_PORT }
  : undefined;

export default defineConfig({
  root,
  base: BASE,
  // powerrpServiceWorker is `apply: "build"`, so the dev server never emits a
  // worker at all — the static-mode-only rule is a build-graph fact here, not a
  // runtime check that could be wrong (see web/sw.js and registerServiceWorker.js).
  plugins: [svelte(), powerrpServiceWorker(), powerrpManifestDev()],
  build: {
    // Emitted at the REPO ROOT (next to the existing dist/), not inside the app
    // folder: a build must never land in the source tree it was built from, and
    // the Pages workflow uploads exactly this directory. `repoRoot` is already
    // computed above for fs.allow, so the path cannot drift from it.
    outDir: resolve(repoRoot, "dist-powerrp"),
    emptyOutDir: true,
    // canvaskit.wasm is ~7 MB and every font is a few hundred kB; the default
    // 500 kB warning would fire on assets whose size is inherent, so the
    // threshold is raised to keep real regressions visible instead of drowned.
    chunkSizeWarningLimit: 4000,
  },
  // pdfjs-dist is only ever reached through pdf_page_raster's LAZY
  // `await import(...)` (a bare-node-safety requirement), so vite would
  // otherwise discover it mid-session on first serve, re-optimize deps, and
  // force a full page reload — which aborts any puppeteer probe mid-evaluate.
  // Pre-bundling it at server start makes boot deterministic. `mathjax` (the
  // tex-svg bundle for the latex widget, Round 14.5) is the SAME lazy-dep flake
  // class — reached only through latex_raster's lazy `?url` script injection —
  // so it is pre-bundled here too (append, per the same reasoning). `mathlive`
  // (the WYSIWYG equation EDITOR, imported eagerly at boot by CanvasView to
  // pre-warm the <math-field> element + its bundled fonts) is likewise pre-
  // bundled so its dep-discovery re-optimize never mid-session reloads the page.
  // `mermaid` (the diagram widget's render engine, reached only through
  // web/mermaidRenderer.js's lazy `import "mermaid"`) is the SAME lazy-dep flake
  // class as pdfjs/mathjax — pre-bundle it so its dep-discovery re-optimize
  // never mid-session reloads the page (which aborts a puppeteer probe).
  // `mp4-muxer` (the container writer the in-page video encoder finalizes through,
  // reached only via the lazy import chain app.svelte.js → browserRenderJobs →
  // mp4Encoder → mp4Samples) is the SAME lazy-dep flake class, and here it is worse
  // than a flake: the discovery happens the first time a user SUBMITS a browser
  // render, and the resulting full page reload would kill the render that triggered
  // it. Pre-bundled so that cannot happen. (The wasm encoder itself is imported as
  // `?url` and never parsed, so it needs no entry here.)
  // `monaco-editor` (the VS-Code editor core the reusable CodeEditorModal hosts,
  // ROUND 2 #32/#33) is a large ESM package with a deep internal module graph;
  // reached through web/CodeEditorModal.svelte's static import, discovering it
  // mid-serve would re-optimize and reload the page (the same flake class as the
  // lazy deps above — worse here because the reload would kill a probe or render).
  // Pre-bundle the exact editor.api entry the modal imports so first use is
  // deterministic. (The `?worker` chunk in web/monacoSetup.js is built by Vite's
  // worker plugin, not optimizeDeps, so it needs no entry here.)
  optimizeDeps: { include: ["pdfjs-dist", "mathjax", "mathlive", "mermaid", "mp4-muxer", "monaco-editor/esm/vs/editor/editor.api"] },
  server: {
    port: 3637,
    host: true,
    https: HTTPS,
    hmr: HMR,
    // NEVER let Vite open the browser (user ruling 2026-07-30: it launched
    // Chrome for a Vivaldi user). Vite's macOS opener runs an AppleScript that
    // REUSES a tab in whichever Chromium is already running, trying "Google
    // Chrome" BEFORE "Vivaldi" in a hardcoded list — and some Chrome process is
    // almost always alive, so the system default never got a say. The launcher
    // (server/start_server.sh) opens the URL itself via `open`/xdg-open, which
    // IS the default browser; NO_OPEN there still suppresses it (Electron).
    open: false,
    fs: { allow: [repoRoot] },
    // NOTE the trailing slashes: the app's own modules are e.g. /main.js and
    // /projectApi.js — without the slash, "/api" (or "/asset") could shadow a
    // real file and proxy it to the backend (→ MIME error). Every server call
    // uses the "/api/…", "/asset/…" form, so trailing-slash prefixes are safe.
    // (This is the documented annotator trailing-slash bug, avoided here too.)
    //
    // "/render/" is the FINISHED MOVIES route (server.py _serve_render, Range
    // supported so the Render Center's <video> can seek). It was missing here, so
    // through the dev server every finished render's inline player and Download
    // link resolved to Vite's own 404 instead of the file — the job said "done" and
    // the movie appeared to be nowhere.
    proxy: Object.fromEntries(
      ["/api/", "/asset/", "/render/"].map((p) => [p, BACKEND]),
    ),
  },
});
