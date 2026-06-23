import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Dev server for the annotator frontend (HMR + visible errors — this is a
// personal tool, never a production build). Vite serves the app and proxies the
// API/media routes to the Python backend, so it's one URL with live reload.
const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, "../../../.."); // components live in <repo>/src/lib
const BACKEND = process.env.BACKEND_URL || "http://localhost:3636";

// Vite is the app on :3635 (HMR, exposed to the LAN). It proxies the API/media
// routes to the Python backend on :3636. So one URL — http://<host>:3635 —
// serves the live app from any device on the network. (Odd ports: less likely
// to collide.)
export default defineConfig({
  root,
  plugins: [svelte()],
  server: {
    port: 3635,
    host: true, // listen on 0.0.0.0 → reachable over the LAN
    open: !process.env.NO_OPEN, // auto-open browser (suppress for headless tests)
    fs: { allow: [repoRoot] }, // allow importing ../../../lib outside this root
    // NOTE the trailing slashes: the app's own module is /api.js — without the
    // slash, "/api" would proxy that file to the backend (→ MIME error). Every
    // real API call uses the "/api/…", "/video/…", etc. form, so this is safe.
    proxy: Object.fromEntries(
      ["/api/", "/video/", "/lowres/", "/frame/"].map((p) => [p, BACKEND]),
    ),
  },
});
