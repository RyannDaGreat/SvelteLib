/**
 * PowerRP headless CLI renderer.
 *
 * Renders any slide (at any tween alpha) of a .powerrp.json presentation to
 * a PNG at any resolution, through the EXACT same compositor the editor
 * uses: a programmatic Vite dev server hosts the app, headless Chromium
 * (puppeteer, already a SvelteLib devDependency) calls the page's
 * window.__powerrp_render hook, and the PNG comes back as a data URL.
 *
 * Usage (from the SvelteLib repo root):
 *   node src/demo_apps/PowerRP/cli/render.js doc.powerrp.json out.png \
 *     [--slide 2] [--alpha 1] [--width 1920] [--height 1080]
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) flags[args[i].slice(2)] = Number(args[++i]);
  else positional.push(args[i]);
}
if (positional.length !== 2) {
  console.error("Usage: node render.js <doc.powerrp.json> <out.png> [--slide N] [--alpha A] [--width W] [--height H]");
  process.exit(1);
}
const [docPath, outPath] = positional;
const opts = {
  slide: flags.slide ?? 0,
  alpha: flags.alpha ?? 1,
  width: flags.width ?? 1280,
  height: flags.height ?? 720,
};

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const docJson = await readFile(docPath, "utf8");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/?cli=1`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.goto(url, { waitUntil: "networkidle0" });
  const dataUrl = await page.evaluate(
    (json, o) => window.__powerrp_render(json, o),
    docJson,
    opts,
  );
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await writeFile(outPath, Buffer.from(base64, "base64"));
  console.log(`Rendered slide ${opts.slide} (alpha ${opts.alpha}) at ${opts.width}x${opts.height} -> ${outPath}`);
} finally {
  await browser.close();
  await server.close();
}
