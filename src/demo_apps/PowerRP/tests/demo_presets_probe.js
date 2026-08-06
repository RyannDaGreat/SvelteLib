/**
 * DEMO PRESETS — FIRST-USE PROBE on the real editor (manifest R7-16 / R7-20 / R7-25).
 *
 * WHY A BROWSER PROBE EXISTS FOR THIS AT ALL, given tests/demo_presets_test.js
 * already drives the physics in bare node: that suite proves the BLUEPRINTS and the
 * equations. It cannot prove the SURFACING — that the palette entry is registered,
 * that `insertDemoPreset` names members the live app actually has, and that the
 * document it commits boots a canvas rather than a wall of equation errors. Every
 * one of those is a runtime name lookup that a green build does not check: a missing
 * named import here is bound to `undefined` and shipped (PowerRP CLAUDE.md), so
 * "it compiles" says nothing.
 *
 * IT DRIVES THE COMMAND REGISTRY, NOT THE DOM — `app.commands.get(id).run(app)` —
 * for the same reason god_rays_insert_probe.js drives the app object: the registry
 * IS the single action layer, and every surfacing (palette, keyboard, toolbar) funnels
 * through the same entry, so exercising it IS exercising the menu without depending on
 * the menu's DOM shape.
 *
 * Run: node src/demo_apps/PowerRP/tests/demo_presets_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { DEMO_PRESETS, DOUBLE_PENDULUM, buildPresetItems } from "../plugins/demo_presets.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1280, height: 800 };
const BOOT_SETTLE_MS = 1200;
const PAINT_SETTLE_MS = 800;

// Boot noise unrelated to this probe (god_rays_insert_probe.js's list, same reasons:
// no GPU backend, no project server listening for a frontend-only Vite boot).
const KNOWN_BOOT_NOISE = [/no WebGPU adapter/, /WebGPU init failed/, /Failed to load resource.*500/, /\/api\/(projects|assets)/];

/** Pure function. Splits page errors into ones this probe must fail on vs known noise.
 *  @example partitionErrors(["console.error: no WebGPU adapter"]).relevant // [] */
function partitionErrors(all) {
  const ignored = all.filter((e) => KNOWN_BOOT_NOISE.some((re) => re.test(e)));
  return { relevant: all.filter((e) => !ignored.includes(e)), ignored };
}

function assertNoErrors(all, where) {
  const { relevant, ignored } = partitionErrors(all);
  for (const e of ignored) console.log(`  (ignored, known-unrelated) ${e}`);
  all.length = 0;
  if (relevant.length) throw new Error(`PAGE ERRORS ${where}:\n${relevant.map((e) => JSON.stringify(e)).join("\n")}`);
}

// The blueprint's OWN item count, built the same way the app builds it — so the
// expectation below is derived from the data rather than a number typed twice.
const nodeRegistry = createRegistry();
registerPlugins(nodeRegistry);
const declaredItemCount = (preset) => buildPresetItems(preset, nodeRegistry, { x: 0, y: 0 }, (n) => n).order.length;

/** How long to let the editor's animation clock run before reading the angle again.
 *  The pendulum's own swing period is about 3 s, so a third of a second is plainly
 *  visible motion and still a short test. */
const ANIMATION_RUN_MS = 350;

/**
 * Query (drives the page). Rod 1's `theta` in the live app's evaluated state.
 *
 * READ THROUGH `evalInfo()`, the same seam every pixel consumer reads, so this
 * measures what the CANVAS is drawing rather than what the document stores — the
 * distinction that matters here, because the document never changes at all.
 */
const rodAngle = (page) => page.evaluate(() => {
  const state = window.__powerrp_app.evalInfo().state;
  const rod = Object.values(state.items).find((i) => i.name === "Pendulum rod 1");
  if (!rod) throw new Error("no 'Pendulum rod 1' in the evaluated state");
  return { theta: rod.vars.theta, theta0: rod.vars.theta0 };
});

/**
 * Command (drives the page; asserts). THE EDITOR ANIMATION CONTRACT, on the rig it
 * was built for — web/editorAnimation.svelte.js.
 *
 * WHY IT IS PINNED IN A BROWSER AND NOT IN NODE. The whole defect was that nothing
 * ADVANCED the clock in the editor: bare node drives the clock itself, so a node test
 * cannot tell a working editor from a frozen one — it never asks the editor anything.
 * The user's report was exactly this ("it didnn't animate"), and the shape of it is
 * why it went unnoticed: a frozen simulation and a broken one look identical, and
 * every bare-node suite passed throughout.
 *
 * @param {object} page - the puppeteer page, with the pendulum already inserted
 * @returns {number} how many checks were made (added to the probe's tally)
 */
async function checkEditorAnimation(page) {
  const gate = await page.evaluate(() => {
    const cmd = window.__powerrp_app.commands.get("toggle-editor-animation");
    return { when: cmd.when(window.__powerrp_app), requires: typeof cmd.requires };
  });
  if (!gate.when) throw new Error("toggle-editor-animation is unavailable in the EDITOR, which is the only place it does anything");
  if (gate.requires !== "string") throw new Error("a `when` gate with no `requires` is a grey control that will not say why");

  const before = await rodAngle(page);
  await new Promise((r) => setTimeout(r, ANIMATION_RUN_MS));
  const stillFrozen = await rodAngle(page);
  if (stillFrozen.theta !== before.theta)
    throw new Error(`the editor moved with the toggle OFF (${before.theta} → ${stillFrozen.theta}) — a still must be byte-reproducible`);
  if (before.theta !== before.theta0)
    throw new Error(`the frozen editor shows theta ${before.theta}, not the released angle ${before.theta0}`);

  await page.evaluate(() => window.__powerrp_app.commands.get("toggle-editor-animation").run(window.__powerrp_app));
  await new Promise((r) => setTimeout(r, ANIMATION_RUN_MS));
  const running = await rodAngle(page);
  if (running.theta === before.theta)
    throw new Error(`the pendulum did not move with the editor clock running — theta is still ${running.theta}`);

  await page.evaluate(() => window.__powerrp_app.commands.get("toggle-editor-animation").run(window.__powerrp_app));
  await new Promise((r) => setTimeout(r, ANIMATION_RUN_MS));
  const stopped = await rodAngle(page);
  // TURNING IT OFF RESETS TO THE INITIAL CONDITION, which is the documented reset
  // rule (core/simulation_history.js) and not merely a stop: leaving the trajectory
  // parked mid-swing would make the editor's "still" depend on how long the author
  // had left the clock running, i.e. not a still at all.
  if (stopped.theta !== stopped.theta0)
    throw new Error(`after the toggle went off theta is ${stopped.theta}, not the released angle ${stopped.theta0} — the simulation did not reset`);
  console.log(`  ok  editor animation: frozen at ${before.theta}, ran to ${running.theta.toFixed(4)}, reset to ${stopped.theta}`);
  return 1;
}

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: CHROME_ARGS });
const errors = [];
let checks = 0;
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  for (const preset of DEMO_PRESETS) {
    // ONE PAGE LOAD PER PRESET. The working copy's autosave RECOVERS the previous
    // insert on reload, deliberately, so the document accumulates — which is why the
    // check below is on the DELTA in item count, and why three presets coexisting on
    // one slide with no equation errors is itself worth knowing (their ids and their
    // script fragments must not collide).
    await page.goto(`${url}?fresh=${preset.id}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
    await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
    assertNoErrors(errors, `AT BOOT (before inserting "${preset.id}")`);

    const before = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items ?? {}).length);
    const result = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      // `commands.get` throws on an unknown id, so this line alone proves the entry
      // is registered — which a hand-written menu could have omitted.
      app.commands.get(`demo-preset-${id}`).run(app);
      const { state, errors } = app.evalInfo();
      return {
        items: Object.keys(app.doc.slides[0].delta.items ?? {}).length,
        selection: app.selection,
        script: (app.doc.meta.script ?? "").length,
        exprErrors: [...errors].map(([k, v]) => `${k}: ${v}`),
        types: Object.values(state.items).map((i) => i.type).sort(),
      };
    }, preset.id);
    await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
    assertNoErrors(errors, `AFTER INSERTING "${preset.id}"`);

    const expected = declaredItemCount(preset);
    if (result.items - before !== expected)
      throw new Error(`"${preset.id}": inserted ${result.items - before} item(s), blueprint declares ${expected}`);
    if (!result.selection) throw new Error(`"${preset.id}": nothing selected after the insert`);
    if (result.exprErrors.length)
      throw new Error(`"${preset.id}": the stamped equations do not evaluate in the live app:\n${result.exprErrors.join("\n")}`);
    if (preset.script && result.script < preset.script.length)
      throw new Error(`"${preset.id}": the project-script fragment did not reach doc.meta.script`);
    console.log(`  ok  ${preset.id}: ${expected} item(s) [${result.types.join(", ")}], no equation errors, script ${result.script} chars`);
    checks++;
    // THE PENDULUM IS THE RIG THE EDITOR CLOCK WAS BUILT FOR, and this page already
    // has one inserted — so the contract is checked here rather than in a probe of its
    // own, which would cost a second Vite server and a second Chrome for one boolean.
    if (preset.id === DOUBLE_PENDULUM.id) checks += await checkEditorAnimation(page);
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${checks} demo preset insert checks passed`);
