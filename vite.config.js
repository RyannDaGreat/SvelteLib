import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { resolve } from "path";
import { readdirSync } from "fs";

/* Auto-discover demo pages: each src/demos/<Name>/demo.html becomes an entry */
function discoverDemos() {
  const demosDir = resolve(__dirname, "src/demos");
  const entries = {};
  try {
    for (const name of readdirSync(demosDir)) {
      const html = resolve(demosDir, name, "demo.html");
      entries[`demos/${name}`] = html;
    }
  } catch {
    /* No demos dir yet — that's fine */
  }
  return entries;
}

export default defineConfig({
  plugins: [svelte()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        ...discoverDemos(),
      },
    },
  },
});
