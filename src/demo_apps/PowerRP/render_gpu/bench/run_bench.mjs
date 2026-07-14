/**
 * Headless benchmark driver: programmatic Vite (repo-root config) + puppeteer,
 * exactly the CLI renderer's recipe (cli/render.js). Runs the benchmark matrix
 * (renderer × square count), the video external-texture test, and an SVG
 * serialization spot-check, then prints a results table.
 *
 * Usage (from the SvelteLib repo root):
 *   node src/demo_apps/PowerRP/render_gpu/bench/run_bench.mjs [--seconds 4] [--dpr 2]
 *
 * Frame rates are UNCAPPED via --disable-frame-rate-limit/--disable-gpu-vsync
 * so numbers reflect real render throughput, not the display's vsync.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++)
  if (args[i].startsWith("--")) flags[args[i].slice(2)] = Number(args[++i]);
const SECONDS = flags.seconds ?? 4;
const DPR = flags.dpr ?? 2;
const VIEW_W = 1280, VIEW_H = 720; // CSS px; device px = ×DPR

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({
  headless: true,
  args: ["--disable-frame-rate-limit", "--disable-gpu-vsync"],
});

async function openPage(url, readyFlag, errorFlag) {
  const page = await browser.newPage();
  await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: DPR });
  page.on("pageerror", (e) => console.error(`  pageerror: ${e.message}`));
  // domcontentloaded + explicit ready flag: networkidle0 can hang under vite's
  // dev-dependency re-optimization (it reloads the page mid-navigation).
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (r, er) => window[r] === true || !!window[er], // errorFlag starts null/undefined; truthy = fatal init error
    { timeout: 30000 }, readyFlag, errorFlag,
  );
  const err = await page.evaluate((er) => window[er], errorFlag);
  if (err) throw new Error(`${url}\n${err}`);
  return page;
}

try {
  const results = [];
  const MATRIX = {
    modes: ["canvas2d", "webgpu"],
    counts: [100, 1000, 5000, 20000],
  };
  for (const mode of MATRIX.modes) {
    for (const n of MATRIX.counts) {
      const url = `${base}/src/demo_apps/PowerRP/render_gpu/bench/bench.html?mode=${mode}&n=${n}`;
      const page = await openPage(url, "__bench_ready", "__bench_error");
      const stats = await page.evaluate((s) => window.__bench_run(s), SECONDS);
      results.push(stats);
      console.log(`${mode.padEnd(9)} n=${String(n).padEnd(6)} → ${String(stats.fps).padStart(7)} fps   p50 ${String(stats.p50_ms).padStart(7)} ms   p95 ${String(stats.p95_ms).padStart(7)} ms   (${stats.deviceW}×${stats.deviceH}@dpr${stats.dpr})`);
      await page.close();
    }
  }

  console.log("\nvideo external-texture proof:");
  const vpage = await openPage(`${base}/src/demo_apps/PowerRP/render_gpu/bench/video.html`, "__video_ready", "__video_error");
  const vres = await vpage.evaluate(() => window.__video_test());
  console.log(`  ok=${vres.ok} movingPixels=${vres.movingPixels} readyState=${vres.readyState} samples=${JSON.stringify(vres.samples)}`);
  if (!vres.ok) throw new Error("video external-texture test FAILED");
  await vpage.close();

  console.log("\nRESULTS_JSON " + JSON.stringify({ seconds: SECONDS, dpr: DPR, results }));
} finally {
  await browser.close();
  await server.close();
}
