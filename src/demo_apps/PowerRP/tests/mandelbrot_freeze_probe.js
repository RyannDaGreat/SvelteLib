/**
 * MANDELBROT FREEZE probe — the user-visible half of todo #206, in the real editor.
 *
 * ── THE TWO FAILURES, WHICH ARE NOT THE SAME FAILURE ─────────────────────────
 * The todo is titled "fine-slot overflow crash freezes the editor", and by the time
 * it was measured that sentence named two different things, only one of which was
 * still true.
 *
 *   THE CRASH is a THROW out of emit() (mandelbrot_shader.scaledDecimal's magnitude
 *   guard). It used to tear down the Svelte reactive root. It no longer can: the
 *   emit-time containment boundary (render_gpu/ports.js emitNode, 50a50bc) turns it
 *   into a red box on that one item. Contained is not the same as absent, so this
 *   probe still checks that the box appears, the sibling still paints, and the
 *   render loop keeps ticking.
 *
 *   THE FREEZE that is left is the opposite: emit() that does not finish.
 *   `zoomExponent` is an ordinary keyframable number with a floor and NO ceiling,
 *   and the reference orbit's BigInt width was derived straight from it — measured
 *   in bare node at HEAD, ONE emit() at zoomExponent 1e6 took 8.95 s. A try/catch
 *   cannot interrupt a running loop, so containment is powerless against this one;
 *   only a bound fixes it (mandelbrot_shader.orbitBitsFor). THAT is what the
 *   response-time check below is for, and it is the reason this probe is in the
 *   browser at all: the cost is paid synchronously inside CanvasView's render
 *   $effect, so the failure is not a slow frame, it is a dead tab.
 *
 * WHY A ROUND-TRIP TIME AND NOT A FRAME COUNT: while the main thread is inside that
 * loop, `page.evaluate` cannot answer either — a frozen editor freezes the probe's
 * own instrument. Timing an evaluate that runs AFTER the commit measures exactly the
 * thing a user feels.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/mandelbrot_freeze_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { mandelbrotPlugin } from "../plugins/demo/mandelbrot.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shots = process.argv[2] ?? resolve(HERE, "../.claude_vlm_checks/mandelbrot_freeze");
await mkdir(shots, { recursive: true });

const BOOT_MS = 2600;          // Skia wasm + fonts + the first painted frame
const SETTLE_MS = 700;         // one reactive pass + a Skia frame of the heaviest shader
/** A single editor interaction must answer inside this. Measured at HEAD, one emit()
 *  of an unbounded zoom took 8.95 s in bare node, so the two regimes are three orders
 *  of magnitude apart and the exact value is not delicate. */
const RESPONSE_BUDGET_MS = 4000;
/** The claimed zoom. 1e6 is not a stress value picked for effect: it is what an `=`
 *  equation, a paste into the Zoom field or a runaway keyframe can put in a row that
 *  declares a floor and no ceiling. */
const ABSURD_ZOOM = 1e6;
/** A fine-slot value past the exact-decimal formatter's wall (scaledDecimal rejects
 *  |v| >= 1e21). Reachable today: `Centre X fine` is a plain number row with NO max. */
const OVERFLOW_FINE = 1e21;

const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = 1280, H = 720;
const doc = {
  meta: { name: "mandelbrot-freeze", slideW: W, slideH: H },
  slides: [{
    id: "s0", name: "Slide 1", transition: { type: "cut", seconds: 0, curve: "linear", sound: "" },
    delta: {
      items: {
        cam: { type: "camera", x: 0, y: 0, w: W, h: H, z: 0, rotation: 0, scale: 1, active: true },
        // THE SIBLING. Containment is a claim about BLAST RADIUS, so the probe needs
        // something that must survive — a healthy item whose ops have to still be there.
        sib: { type: "rect", x: 900, y: 80, w: 240, h: 160, z: 5, rotation: 0, scale: 1, active: true, fill: "#7aa2f7" },
        mand: { ...mandelbrotPlugin.defaults, x: 80, y: 80, w: 560, h: 420, z: 10, active: true },
      },
    },
  }],
};

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();

// Boot/runtime noise from other lanes. The patterns this probe is ABOUT (the emit
// containment line, and the widget's own reports) are deliberately not ignored.
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/,
  /Failed to load resource/, /failed to load/, /net::ERR/, /listAssets/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !isNoise(m.text())) consoleErrors.push(m.text()); });

  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(doc));
  // domcontentloaded, NOT networkidle0: the app keeps fetching fonts and wasm well
  // past first paint, so idling the network is a slower and less reliable signal than
  // the canvas the probe actually needs.
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await sleep(BOOT_MS);

  const id = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return Object.entries(app.state().items).find(([, s]) => s.type === "demo_mandelbrot")?.[0] ?? null;
  });
  ok(id, "the mandelbrot widget is in the open document");
  await page.screenshot({ path: resolve(shots, "01_boot.png") });

  /** Command. Writes one property through the app's OWN preview/commit seam — the
   *  same pair every Inspector field uses — so this is an editor edit, not a
   *  hand-rolled document mutation. */
  const setProp = async (key, value) => page.evaluate((itemId, k, v) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", itemId, k], v]]);
    app.commitPreview();
  }, id, key, value);

  // ── 1. THE FREEZE: an unbounded zoom must not stop the editor answering ────
  const t0 = Date.now();
  await setProp("zoomExponent", ABSURD_ZOOM);
  await sleep(SETTLE_MS);
  const alive = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { frames: app.renderFrameCount, zoom: app.state().items && true };
  });
  const elapsed = Date.now() - t0;
  ok(elapsed < RESPONSE_BUDGET_MS, `zoomExponent ${ABSURD_ZOOM}: the editor answered in ${elapsed} ms (budget ${RESPONSE_BUDGET_MS})`);
  ok(alive.frames > 0, "the render loop is still running after the absurd zoom");
  await page.screenshot({ path: resolve(shots, "02_absurd_zoom.png") });

  // Frames must keep ADVANCING, not merely have advanced once before the edit.
  const before = alive.frames;
  await sleep(SETTLE_MS);
  const after = await page.evaluate(() => window.__powerrp_app.renderFrameCount);
  ok(after >= before, `frames still advance (${before} -> ${after})`);

  // ── 2. THE CRASH: an overflowed fine slot costs ITSELF, not the scene ──────
  await setProp("zoomExponent", 2.9416);
  await setProp("fineExponent", 16);
  const t1 = Date.now();
  await setProp("centerFineX", OVERFLOW_FINE);
  await sleep(SETTLE_MS);
  const contained = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { frames: app.renderFrameCount, items: Object.keys(app.state().items).length };
  });
  ok(Date.now() - t1 < RESPONSE_BUDGET_MS, "the overflow did not stall the editor either");
  ok(contained.frames > after, `the render loop survived the overflow (${after} -> ${contained.frames})`);
  ok(contained.items >= 3, "every item is still in the document — nothing was rewritten to escape the throw");
  ok(consoleErrors.some((l) => /failed to EMIT/.test(l)), `the failure was REPORTED, not swallowed: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
  ok(pageErrors.length === 0, `no UNCAUGHT error escaped to the page: ${JSON.stringify(pageErrors.slice(0, 3))}`);
  await page.screenshot({ path: resolve(shots, "03_overflow_contained.png") });

  // ── 3. AND IT IS RECOVERABLE — the editor is still an editor afterwards ────
  await setProp("centerFineX", 0);
  await sleep(SETTLE_MS);
  const recovered = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { frames: app.renderFrameCount, fine: Object.values(app.state().items).find((s) => s.type === "demo_mandelbrot").centerFineX };
  });
  ok(recovered.frames > contained.frames, "frames advance again once the bad value is cleared");
  ok(recovered.fine === 0, "the property took the new value — the widget is still editable");
  await page.screenshot({ path: resolve(shots, "04_recovered.png") });
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"}  ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} failing:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length} passed`);
