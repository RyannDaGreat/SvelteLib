import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// PowerRP is pure frontend (no backend); its own dev server per the
// demo_apps convention. Odd port to avoid collisions (annotator uses 3635).
const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, "../../../.."); // src/lib + src/styles live here

export default defineConfig({
  root,
  plugins: [svelte()],
  server: {
    port: 3637,
    host: true,
    open: !process.env.NO_OPEN,
    fs: { allow: [repoRoot] },
  },
});
