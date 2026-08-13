/**
 * THE PER-FRAME TRIGGER PROBE — the frame domain (core/exec_frame.js) in the REAL
 * editor, and the one place its whole chain is visible at once.
 *
 * ── WHY A BROWSER PROBE AT ALL, WHEN 31 NODE CHECKS ALREADY PASS ───────────
 * Because the two things it asserts are invisible to a node test BY CONSTRUCTION:
 *
 *   THE DOUBLE-CLICK CHAIN. `plugins/node_custom.js` declares `activate:
 *   "code_modal"` and a `codeEditor` descriptor, and BOTH have to survive
 *   `core/exec_nodes.execNodePlugin`, which is a WHITELIST. A dropped spec key here
 *   is SILENT: the build is green, the declaration is right there in the source, and
 *   double-clicking the widget simply does nothing. That is not hypothetical — it is
 *   exactly what `plugins/node_abc.js`'s header records costing a browser probe on
 *   the `controlNodePlugin` side, where `activation_migration_test` could not catch
 *   it (that test reports widgets declaring NO handler; this one declared one) and
 *   the handler's own `claims` is migrationPlan-only, so its answer is never
 *   consulted. A node test can assert the plugin object has the fields; only a real
 *   double-click proves the modal opens.
 *
 *   THE DECK ACTUALLY TICKS. The node suite drives `stepFrameDomain` directly with a
 *   dictated timestep. This drives the EDITOR: it presents the deck, lets the real
 *   clock run, and reads the display node's own readout — so it covers the seam
 *   between the frame domain and everything that has to call it.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/execframe_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const shots = process.argv[2] ?? "/tmp/execframe_probe";
await mkdir(shots, { recursive: true });

/** One reactive paint plus a Skia frame — the same settle every canvas probe uses. */
const SETTLE_MS = 300;

// HMR + the file watcher are OFF: a dozen agents edit this tree concurrently, and a
// stray HMR full-reload mid-probe drops window.__powerrp_app and fails the run for
// reasons that have nothing to do with what is being tested.
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Documented boot/runtime noise from OTHER lanes, the same treatment
// tests/activation_probe.js gives it.
// Documented boot/runtime noise from OTHER lanes. The last two are NOT this probe's
// business and are ignored deliberately rather than left to fail it: a backend 500 on
// the project list is an environment fact (the gate's own backend may not have the
// user's projects), and an UNSATISFIABLE-shortcut complaint belongs to whichever lane
// owns that entry. A probe that fails on another agent's warning is a probe nobody
// can read — the whole point of this one is that a red here means the frame domain.
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/, /preserveAspect/,
  /Failed to load resource/, /UNSATISFIABLE `when` predicate/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  const liveErrors = [];
  const phase = { live: false };
  page.on("pageerror", (e) => (phase.live ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || isNoise(m.text())) return;
    (phase.live ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });

  // THE APP ROOT, handed to the page so a dynamic import inside `evaluate` can reach
  // a CORE module. Vite's dev root is `web/`, so a bare "/core/document.js" 404s;
  // `/@fs<abs>` is the spelling tests/static_render_probe.js already uses, and it is
  // resolved from THIS FILE rather than from process.cwd() so the probe runs
  // correctly from any directory.
  const appRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  await page.evaluateOnNewDocument((root) => { window.__powerrp_probeRoot = root; }, appRoot);

  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);
  ok(bootErrors.length === 0, `no boot errors (${JSON.stringify(bootErrors)})`);
  phase.live = true;

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  // ── THE CUSTOM NODE'S DOUBLE-CLICK, END TO END ────────────────────────────
  const custom = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const plugin = app.registry.get("node_custom");
    const id = app.addItem({ ...plugin.defaults, x: 120, y: 120 });
    return {
      id: id ?? app.selection,
      activate: plugin.activate ?? null,
      editorProperty: plugin.codeEditor?.property ?? null,
      // The port list is the AUTHOR's, read from the compiled starter spec — so a
      // fresh node having beads at all proves the compile ran through the jail.
      outputs: plugin.ports(plugin.defaults).outputs.map((p) => p.key),
      inputs: plugin.ports(plugin.defaults).inputs.map((p) => p.key),
    };
  });
  await sleep(SETTLE_MS);
  ok(custom.activate === "code_modal", `the custom node declares its handler through the factory whitelist (got ${custom.activate})`);
  ok(custom.editorProperty === "definition", `…and its codeEditor descriptor survives too (got ${custom.editorProperty})`);
  ok(custom.inputs.join(",") === "a,b", `the STARTER SPEC's declared inputs reached declaredPorts (got ${JSON.stringify(custom.inputs)})`);
  ok(custom.outputs.join(",") === "out", `…and its outputs (got ${JSON.stringify(custom.outputs)})`);

  const p = await worldToPage(200, 180);
  await page.mouse.click(p.x, p.y, { clickCount: 2 });
  await sleep(600);
  const modal = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return app.codeModal ? { itemId: app.codeModal.itemId, property: app.codeModal.property, language: app.codeModal.language } : null;
  });
  ok(modal !== null, "DOUBLE-CLICKING A CUSTOM NODE OPENS THE MONACO MODAL — the whole chain the whitelist could silently break");
  ok(modal?.property === "definition", `…on its own spec property (got ${modal?.property})`);
  ok(modal?.language === "javascript", `…in JavaScript, a grammar Monaco actually ships (got ${modal?.language})`);
  await page.screenshot({ path: `${shots}/01-custom-node-modal.png` });
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);

  // ── THE DEMO PRESET TICKS IN THE REAL EDITOR ──────────────────────────────
  // Inserted through the app's OWN template path, so this covers the palette entry
  // as well as the preset data — a preset that exists in the array and not in the
  // menu is a feature nobody can find (plugins/demo_presets.js's own rule).
  const inserted = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const mod = await import("/demoInsert.js");
    mod.insertDemoTemplate(app, "demo-preset-trigger-chain");
    // Read the DERIVED tree rather than a raw state bag: `app.nodes()` is what the
    // canvas itself draws, so anything visible here is genuinely on the slide.
    return app.nodes()
      .filter((n) => typeof n.state?.type === "string" && n.state.type.startsWith("node_"))
      .map((n) => ({ id: n.itemId, type: n.state.type }));
  });
  await sleep(SETTLE_MS);
  // The custom node spawned above is also a `node_` type and is still on the slide,
  // so the preset's own eight are counted as "at least", by TYPE rather than by a
  // total that another section of this probe can shift.
  const PRESET_TYPES = ["node_time", "node_number", "node_math", "node_compare", "node_schmitt", "node_increment", "node_set_var", "node_display"];
  for (const type of PRESET_TYPES)
    ok(inserted.some((n) => n.type === type), `the preset inserted its ${type} through the app's own template path`);

  // A deck containing a stateful node must refuse a strided shard — asked of the
  // REAL registry in the REAL app, which is where the landmine would actually bite.
  const refusal = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const doc = await import(/* @vite-ignore */ "/@fs" + window.__powerrp_probeRoot + "/core/document.js");
    return doc.stridedShardRefusal(app.doc, app.registry);
  });
  ok(typeof refusal === "string" && /SIMULATED STATE/.test(refusal),
    `a deck with a per-frame trigger refuses strided sharding IN THE APP (got ${JSON.stringify(refusal)})`);

  // Present it and let the real clock run: the display must climb.
  const displayId = inserted.find((n) => n.type === "node_display")?.id;
  ok(!!displayId, "the preset carries a display node to read the tally off");
  const readTally = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const state = app.nodes?.().find((n) => n.itemId === id)?.state;
    return state?.nodePorts?.inputs?.in ?? null;
  }, displayId);

  // THE CLOCK IS STARTED DIRECTLY, not through the presentation UI, and that is the
  // honest unit for what this asserts. `startParticleClock()` is exactly what
  // web/PresentMode.svelte calls on mount — it IS the live regime — so this drives
  // the same clock a presentation does without also dragging in the whole present-mode
  // component. (An earlier draft called `app.startPresentation?.()`, which does not
  // exist: the optional chaining swallowed it, the clock never started, and the deck
  // "failed to tick" for a reason that had nothing to do with the frame domain.)
  await page.evaluate(async (root) => {
    const clock = await import(/* @vite-ignore */ "/@fs" + root + "/render_gpu/particle_clock.js");
    clock.startParticleClock(0);
  }, appRoot);
  // Each derive is one simulation step, so the tally needs the canvas to keep
  // repainting. `app.nodes()` is an un-memoized full derive, so ASKING is stepping —
  // which is what the readTally poll below does, once every ~120 ms.
  const pump = async (ms) => {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) { last = await readTally(); await sleep(120); }
    return last;
  };
  await sleep(400);
  const early = await readTally();
  await page.screenshot({ path: `${shots}/02-presenting.png` });
  // Two full periods of the preset's two-second cycle, plus slack for a slow
  // headless first frame.
  const later = await pump(4800);
  await page.screenshot({ path: `${shots}/03-after-two-cycles.png` });
  ok(typeof early === "number" && typeof later === "number",
    `the display reads a number at both instants (got ${JSON.stringify([early, later])})`);
  ok(later > early, `THE DECK TICKS: the tally climbed while presenting (${early} → ${later})`);
  // Two seconds per tick, ~4.6 s of presentation: two or three ticks. A frame-counted
  // implementation would run away here, which is the failure this bound catches.
  ok(later - early <= 4, `…at the authored cadence rather than per frame (${early} → ${later})`);

  ok(liveErrors.length === 0, `no runtime errors while presenting (${JSON.stringify(liveErrors.slice(0, 3))})`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`${pass ? "  ok  " : "FAIL  "}${label}`);
if (failed.length > 0) {
  console.error(`\nexecframe_probe: ${failed.length} of ${checks.length} checks FAILED`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`\nexecframe_probe: ${checks.length} checks passed — shots in ${shots}`);
