import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
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

export default defineConfig({
  root,
  plugins: [svelte()],
  server: {
    port: 3637,
    host: true,
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
