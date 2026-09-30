/** Multipoint GPU solver vs CPU solver, in a real browser, on shipped presets.
 * Proves (1) this host's browser realm actually takes the WebGL2 route (solver "gpu"),
 * both on the page and inside the real refinement worker; (2) the GPU field agrees with
 * the Float64 CPU field far below one 8-bit step. A host whose WebGL2 lacks float render
 * targets FAILS this probe with that sentence — it cannot silently test the CPU twice.
 * Run: node src/demo_apps/PowerRP/tests/multipoint_gpu_probe.js */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const PRESETS = ["neon-spiral", "warm-bokeh", "jupiter-globe"];
const SIZE = 256; // big enough for a 6-level hierarchy, quick on SwiftShader
// Measured 0.13–0.17/255 max, 0.02–0.03/255 mean (Metal and SwiftShader, 128²–2048²);
// the bounds leave ~3× headroom and stay far below one visible 8-bit step.
const MAX_DIFF_255 = 0.5, MEAN_DIFF_255 = 0.1;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const artifacts = resolve(root, ".scratchpad/multipoint/gpu");
await mkdir(artifacts, { recursive: true });
await writeFile(resolve(artifacts, "index.html"), '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Multipoint GPU probe</body></html>');
process.env.POWERRP_VITE_CACHE_DIR ??= resolve(artifacts, "vite-cache");
const server = await createServer({ configFile: resolve(here, "../web/vite.config.js"), server: { port: 0, host: "127.0.0.1", open: false, hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser();
try {
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.error(e); });
  page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); console.error(m.text()); } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs${artifacts}/index.html`);
  const result = await page.evaluate(async (app, ids, size) => {
    const { multipointGpuSolver } = await import(`${app}/render_gpu/multipoint_gpu.js`);
    const { solvedField } = await import(`${app}/render_gpu/skia/multipoint.js`);
    const { getMultipointPreset } = await import(`${app}/core/multipoint_presets.js`);
    const { parsePaint } = await import(`${app}/render_gpu/ir.js`);
    const gpu = multipointGpuSolver();
    if (!gpu) return { unavailable: true };
    /** Pure function. IEEE binary16 bits → number. @param {number} h - 16-bit pattern. @returns {number} */
    const fromHalf = (h) => {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
      return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
    };
    /** Pure function. Max and mean |a − b| of two F16 fields, in 8-bit steps. */
    const compare = (a, b) => {
      let max = 0, sum = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(fromHalf(a[i]) - fromHalf(b[i])) * 255; max = Math.max(max, d); sum += d; }
      return { max, mean: sum / a.length };
    };
    const rows = [];
    for (const id of ids) {
      const features = parsePaint(getMultipointPreset(id)).features;
      const auto = solvedField(features, size), cpu = solvedField(features, size, "cpu");
      rows.push({ id, autoSolver: auto.solver, cpuSolver: cpu.solver, ...compare(auto.half, cpu.half), gpuIterations: auto.iterations, cpuIterations: cpu.iterations });
    }
    // The real refinement worker must take the GPU route too (its own realm, own context).
    const features = parsePaint(getMultipointPreset(ids[0])).features;
    const worker = new Worker(new URL(`${app}/render_gpu/skia/multipoint_worker.js`, location.href), { type: "module" });
    const answer = await new Promise((done) => { worker.onmessage = ({ data }) => done(data); worker.onerror = (e) => done({ error: e.message }); worker.postMessage({ key: "probe", features, size }); });
    worker.terminate();
    const workerDiff = answer.field ? compare(answer.field.half, solvedField(features, size, "cpu").half) : null;
    return { renderer: gpu.renderer, software: gpu.software, rows, workerSolver: answer.field?.solver, workerError: answer.error, workerDiff };
  }, `/@fs${resolve(here, "..")}`, PRESETS, SIZE);
  assert.ok(!result.unavailable, "this host's browser has no WebGL2 with float render targets: the Multipoint GPU solver cannot run here, so this probe cannot test it");
  for (const row of result.rows) {
    assert.equal(row.autoSolver, "gpu", `${row.id}: the page realm must take the GPU route`);
    assert.equal(row.cpuSolver, "cpu");
    assert.ok(row.max <= MAX_DIFF_255, `${row.id}: GPU vs CPU max difference ${row.max}/255 exceeds ${MAX_DIFF_255}/255`);
    assert.ok(row.mean <= MEAN_DIFF_255, `${row.id}: GPU vs CPU mean difference ${row.mean}/255 exceeds ${MEAN_DIFF_255}/255`);
  }
  assert.equal(result.workerError, undefined, `refinement worker failed: ${result.workerError}`);
  assert.equal(result.workerSolver, "gpu", "the refinement worker must take the GPU route");
  assert.ok(result.workerDiff.max <= MAX_DIFF_255, `worker GPU vs CPU max difference ${result.workerDiff.max}/255`);
  assert.deepEqual(errors, []);
  console.log(`PASS Multipoint GPU solver on ${result.renderer}${result.software ? " (software GL)" : ""}:`, JSON.stringify(result.rows.map(({ id, max, mean, gpuIterations, cpuIterations }) => ({ id, max: +max.toFixed(3), mean: +mean.toFixed(4), gpuIterations, cpuIterations }))), "worker:", result.workerSolver);
} finally { await browser.close(); await server.close(); }
