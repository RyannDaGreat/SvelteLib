import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
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
  plugins: [svelte()],
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
  optimizeDeps: { include: ["pdfjs-dist", "mathjax", "mathlive", "mermaid"] },
  server: {
    port: 3637,
    host: true,
    https: HTTPS,
    hmr: HMR,
    open: !process.env.NO_OPEN,
    fs: { allow: [repoRoot] },
    // NOTE the trailing slashes: the app's own modules are e.g. /main.js and
    // /projectApi.js — without the slash, "/api" (or "/asset") could shadow a
    // real file and proxy it to the backend (→ MIME error). Every server call
    // uses the "/api/…", "/asset/…" form, so trailing-slash prefixes are safe.
    // (This is the documented annotator trailing-slash bug, avoided here too.)
    proxy: Object.fromEntries(
      ["/api/", "/asset/"].map((p) => [p, BACKEND]),
    ),
  },
});
