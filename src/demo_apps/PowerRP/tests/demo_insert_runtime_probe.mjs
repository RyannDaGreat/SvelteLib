/**
 * EVERY DEMO TEMPLATE IS INSERTED INTO A RUNNING EDITOR, AND THE CONSOLE MUST STAY CLEAN.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/demo_insert_runtime_probe.mjs
 *
 * ── WHY THIS EXISTS: THREE USER-REPORTED ERRORS THE GATE COULD NOT SEE ──────
 * The user hit three runtime failures in a row and the 325-suite bare-node gate was green
 * through all of them, because every one only exists when the editor is RUNNING WITH
 * CONTENT IN IT:
 *
 *   1. `each_key_duplicate` — a bead identity was `${item}.${key}` with no SIDE, so a
 *      stereo effect's `l` in and `l` out collided in a keyed `{#each}`. Pure data in
 *      bare node; a thrown Svelte error on the canvas.
 *   2. "Cyclic node outputs", once PER FRAME — a feedback patch the drag gesture now
 *      allows, pulled through by a resolver that had not been taught what a legal loop is.
 *   3. "simulated slot was advanced twice in one step" — two evaluation consumers
 *      stepping the simulation from different states.
 *
 * ── WHY THE EXISTING PROBE MISSED THEM, WHICH IS THE DESIGN LESSON ──────────
 * `tests/demo_submenu_probe.js` inserts THREE templates — one per section — as a
 * smoke test of the MENU. Its patch is `demo-patch-whoosh`, a house patch that predates
 * this round. So a suite that "covers demo insertion" covered none of the 27 patches and
 * 3 presets the round added. **A sampled smoke test is not coverage of a growing roster**,
 * and the roster is exactly the thing this round grew.
 *
 * So this one is driven BY THE ROSTER: it asks the app for every registered demo template
 * and inserts each in turn. A template added tomorrow is tested tomorrow, with no edit
 * here — the same derivation rule the rest of the round has been applying to lists.
 *
 * ── WHAT COUNTS AS A FAILURE, AND WHAT DELIBERATELY DOES NOT ────────────────
 * FAIL: any `pageerror`, and any `console.error` raised while a template is being
 * inserted or in the settle window after it. That is the whole point — all three defects
 * above announced themselves in the console and nothing was listening.
 *
 * NOT A FAILURE: WebGPU-absence noise (this host has no adapter and says so on every
 * boot — `webgpu_absence_noise.js` is the shared filter), and anything raised BEFORE the
 * first insert, which is boot noise this probe is not about and which
 * `boot_crash_surface_probe.js` owns. Both are reported separately so a real boot
 * regression is visible rather than swallowed.
 *
 * NOT JUDGED AT ALL: a template whose command the app GATES OFF (`when` returns
 * false) — see the roster comment below. It is named in the output with its
 * `requires` sentence, so the roster can shrink only out loud.
 *
 * ── A STANDING RED THIS PROBE CATCHES, WHICH IS NOT ITS OWN FAULT ───────────
 * `demo-insert-video-v6` raises two console.errors the instant it is placed, with
 * its SHIPPED defaults and no user input:
 *   Video V6: failed to load source data:image/png;base64,… [object MediaError]
 *   Video V6: play() rejected for data:image/png;base64,… NotSupportedError
 * `plugins/demo/video_v6.js:45` defaults `src` to BLANK_SRC, a 1x1 PNG, and
 * `web/videoV6Registry.js:44-51` hands it straight to a <video>, which refuses it
 * (MediaError code 4) and then rejects the play(). The sibling widget already
 * guards this exact case — `plugins/demo/video_v7.js:29-31`: "the overlay
 * recognizes `data:image/…` as 'not yet sourced' … handing an image URI to a
 * <video> would error" — and `render_gpu/gpu/video_registry.js:725` records the
 * same hazard for the scrub path. Only V6 is missing the guard, and its own
 * docblock (`plugins/demo/video_v6.js:40-44`) asserts the opposite, which is what
 * hid it. The defect is in product code, not here; do not filter these two lines.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

/** Long enough for a patch's items, wires, equations and script fragment to settle and
 *  for one animation frame to paint — the cycle flood only appeared on a repaint. */
const SETTLE_MS = 420;
/** Boot is slow on a cold dep cache; this is the ceiling, not the expectation. */
const BOOT_TIMEOUT_MS = 60000;

// HMR + watch OFF. Was `{ port: 0, open: false, host: "127.0.0.1" }`, i.e. both ON:
// a file saved by anyone while this probe is mid-roster sends a full-reload, the page
// throws its app away, and the very next `page.evaluate` reads `window.__powerrp_app`
// as undefined. That is not a hypothesis — one gate run reported
// `demo-preset-double-pendulum: threw while inserting: Cannot read properties of
// undefined (reading 'commands')`, which no preset can cause and a vanished app object
// explains exactly. tests/image_stack_live_probe.js and tests/filmstrip_live_probe.js
// already carry this pair for the same stated reason ("a sibling agent's edit must not
// reload the page mid-probe"); this probe is longer-running than either, so it is the
// most exposed, and it was the one still missing them.
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inserted = 0;
let withheldIds = [];   // ids the app gates OFF; named in the summary, never dropped in silence
const dirty = [];      // [{id, errors}]
const bootNoise = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  let bucket = bootNoise;
  const note = (text) => { if (!isWebGpuAbsenceNoise(text)) bucket.push(text); };
  page.on("pageerror", (e) => note(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") note(`console.error: ${m.text()}`); });

  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  await sleep(1200);

  // THE ROSTER, ASKED FOR RATHER THAN LISTED. Templates that arm the crosshair need a
  // canvas click to complete; the app knows which, so it is asked rather than guessed.
  //
  // AND IT IS ASKED WHETHER THE COMMAND MAY RUN, not only whether it exists. The
  // filter was `/^demo-(patch|preset|insert)-/.test(c.id) && typeof c.run === "function"`
  // — id and callability only — so it reached past every `when` gate in web/App.svelte
  // and invoked entries the app deliberately refuses to offer a user. Concretely:
  // `demo-insert-globe-map` is QUARANTINED (`when: () => false` + a `requires`
  // sentence — the mechanism tests/map_quarantine_test.js pins, chosen so the palette
  // can say WHY rather than hiding the row), and running it reproduced the very defect
  // the quarantine withholds ("no map tiles are available to this renderer … NOT what
  // the editor shows"). A probe that reports a withheld widget's known defect as an
  // insertion failure is measuring something no user can reach.
  //
  // The gate is `core/commands.commandUnavailable`'s rule — `!!cmd.when && !cmd.when(app)`
  // — applied in the page, and `requires` is RESOLVED through the same rule
  // `commandUnavailableReason` uses (it MAY BE A FUNCTION of the app; reading the field
  // raw renders a function's source text). Withheld entries are NAMED below, never
  // silently dropped: a roster that shrinks without saying so is how "covers every
  // template" stops being true.
  const roster = await page.evaluate(() => {
    const a = window.__powerrp_app;
    const reason = (c) => (typeof c.requires === "function" ? c.requires(a) : c.requires) ?? null;
    const all = a.commands.all()
      .filter((c) => /^demo-(patch|preset|insert)-/.test(c.id) && typeof c.run === "function");
    const withheld = all.filter((c) => !!c.when && !c.when(a));
    return {
      templates: all.filter((c) => !withheld.includes(c)).map((c) => ({ id: c.id, title: c.title })),
      withheld: withheld.map((c) => ({ id: c.id, requires: reason(c) })),
    };
  });
  const { templates } = roster;
  console.log(`DEMO INSERT RUNTIME — ${templates.length} templates, each into a live editor\n`);
  for (const w of roster.withheld)
    console.log(`  --  ${w.id.padEnd(42)} WITHHELD by the app — requires ${w.requires ?? "(no reason declared)"}`);
  if (roster.withheld.length) console.log("");
  if (bootNoise.length) console.log(`  (${bootNoise.length} pre-insert boot message(s), reported at the end)\n`);

  for (const t of templates) {
    const errors = [];
    bucket = errors;
    try {
      await page.evaluate((id) => { const a = window.__powerrp_app; a.commands.get(id).run(a); }, t.id);
      await sleep(SETTLE_MS);
      // A crosshair-armed template needs a click to land; harmless for the others.
      await page.mouse.click(700, 460);
      await sleep(SETTLE_MS);
      inserted++;
    } catch (e) {
      errors.push(`threw while inserting: ${e.message}`);
    }
    // Undo back to a clean slide so each template is judged on its own, not on the pile.
    try { await page.evaluate(() => { const a = window.__powerrp_app; a.undo(); a.undo(); }); } catch { /* nothing to undo */ }
    await sleep(120);

    const unique = [...new Set(errors)];
    if (unique.length) {
      dirty.push({ id: t.id, errors: unique });
      console.log(`  XX  ${t.id.padEnd(42)} ${unique.length} error kind(s)`);
      for (const e of unique.slice(0, 2)) console.log(`        ${e.slice(0, 150)}`);
    } else {
      console.log(`  ok  ${t.id}`);
    }
  }
  withheldIds = roster.withheld.map((w) => w.id);
  bucket = bootNoise;
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${inserted} template(s) inserted, ${dirty.length} with console errors${withheldIds.length ? `, ${withheldIds.length} withheld by the app (${withheldIds.join(", ")})` : ""}`);
if (bootNoise.length) {
  console.log(`\nBOOT-TIME messages (not this probe's subject, reported so they are not invisible):`);
  for (const b of [...new Set(bootNoise)].slice(0, 5)) console.log(`  ${b.slice(0, 160)}`);
}
if (dirty.length) {
  console.error(`\nFAIL — ${dirty.length} template(s) raise errors in a running editor: ${dirty.map((d) => d.id).join(", ")}`);
  process.exit(1);
}
console.log("\nPASS — every demo template inserts into a live editor with a clean console");
