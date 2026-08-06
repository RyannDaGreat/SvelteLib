/**
 * EVERY MODULE TYPE IS CONSTRUCTED IN A REAL ENGINE. No stub, no shim.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/module_construct_probe.mjs
 *
 * ── THE GAP THIS FILLS, AND IT IS A STRUCTURAL ONE ──────────────────────────
 * `tests/audio_nodes_test.js` instantiates every factory against a STUB AudioContext and
 * asserts the ports and params it declares are real. That is the right test and it stays.
 * But **every ported module constructs `new AudioWorkletNode(...)` directly**, and there
 * is no such global in bare node — so all 34 Axoloti modules and every VCV module throw
 * `AudioWorkletNode is not defined` the moment that suite touches them. The stub cannot
 * reach the modules this round actually added. Roughly 90 of 112 module types have never
 * been constructed by any bare-node test, and nothing said so.
 *
 * ── WHAT IT CAUGHT, THE DAY IT WAS WRITTEN ──────────────────────────────────
 * The user hit "audio graph change failed — output.connect is not a function" and every
 * patch touching a step sequencer, a counter or an SVF died on its whole graph change.
 * A module with more than one output cannot expose output 2 as anything but
 * `{node, index}`, because Web Audio's `connect()` takes an index — and while the
 * engine's INPUT side handled that shape (`resolvePort` documents all three a port can
 * take), the OUTPUT guard loop called `.connect()` on the descriptor directly. The module
 * builders were right; the engine was the incomplete half.
 *
 * This probe named the eight failures in one run — axDivRem, axCounter, axDecode,
 * axStepsBool, axStepsValue, axStepsMulti, axSvf, axZdfSvf, i.e. exactly the multi-output
 * population — where the stub sweep had reported "every module output is connectable",
 * which was true of the modules it could build and worthless for the ones that mattered.
 *
 * ── WHY IT IS CHEAP DESPITE NEEDING A BROWSER ───────────────────────────────
 * One page, one OfflineAudioContext, one `init()`, then every module type added to the
 * same engine. No rendering, no audio, no screenshot — so it does not depend on the host
 * being able to capture, which is the thing that makes most browser probes fragile here.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const webRoot = resolve(app, "web");

/** A couple of quanta is enough — nothing is rendered, the context only has to exist. */
const RENDER_FRAMES = 4096;
const RENDER_RATE = 48000;

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
let result = { ok: 0, total: 0, failures: [] };

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !isWebGpuAbsenceNoise(m.text())) pageErrors.push(m.text()); });
  await page.goto(url, { waitUntil: "networkidle0" });

  result = await page.evaluate(async ({ appDir, frames, rate }) => {
    const [{ AUDIO_SPECS }, { createEngine }] = await Promise.all([
      import(`/@fs${appDir}/core/audio_specs.js`),
      import(`/@fs${appDir}/synth/engine.js`),
    ]);
    const ctx = new OfflineAudioContext(2, frames, rate);
    const engine = createEngine({ audioContext: ctx });
    await engine.init();

    const failures = [];
    let ok = 0;
    for (const spec of AUDIO_SPECS) {
      // Its OWN declared defaults, not an empty object: a module may legitimately refuse
      // a missing required param, and this probe is about construction, not validation.
      const params = {};
      for (const k of spec.knobs ?? []) params[k.key] = k.default;
      try {
        engine.addModule(spec.module, `probe_${spec.module}`, params);
        ok++;
      } catch (e) {
        failures.push({ type: spec.type, module: spec.module, message: e.message });
      }
    }
    return { ok, total: AUDIO_SPECS.length, failures };
  }, { appDir: app, frames: RENDER_FRAMES, rate: RENDER_RATE });

  if (pageErrors.length) console.log(`(${pageErrors.length} page message(s) — not assertions)`);
} finally {
  await browser.close();
  await server.close();
}

console.log(`MODULE CONSTRUCTION — ${result.ok}/${result.total} module types built in a real engine`);
for (const f of result.failures) console.log(`  XX  ${f.type.padEnd(34)} (module ${f.module}): ${f.message.slice(0, 120)}`);

if (result.failures.length) {
  console.error(`\nFAIL — ${result.failures.length} module type(s) cannot be constructed`);
  process.exit(1);
}
if (result.total === 0) {
  console.error("\nFAIL — AUDIO_SPECS was empty, so this probe proved nothing");
  process.exit(1);
}
console.log("\nPASS — every registered module constructs against a real AudioContext");
