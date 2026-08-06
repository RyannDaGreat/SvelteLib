/**
 * OUTPUT PROPERTIES in the REAL editor — the Inspector surface, and the equation
 * read, driven through the running app.
 *
 * WHY A BROWSER PROBE AT ALL when tests/output_properties_test.js already pins the
 * core: NO JSON-ONLY PROPERTIES is a claim about the PANEL, and a pure test cannot
 * make it. The core suite proves `= knob1.out` resolves; this one proves an author
 * can SEE the output that makes that spelling discoverable, that the row reports
 * rather than invites an edit, and that a tier-1 signal says why it has no value
 * instead of showing a blank or a zero.
 *
 * What it asserts:
 *   1. Selecting a Knob shows an OUTPUTS section with an `out` row carrying 0.25.
 *   2. That row has NO editor, NO `=` toggle and NO keyframe diamonds — a report.
 *   3. Turning the knob (a stored write) moves the OUTPUT row: it is live, not a
 *      snapshot baked at selection time.
 *   4. Selecting an audio Oscillator shows an `out` row too — declared and
 *      wireable — reporting "Audio signal" with the refusal sentence, never 0.
 *   5. An equation elsewhere in the document reads the knob's output and repaints.
 *
 * Frontend-only Vite on an EPHEMERAL port, the shared puppeteer launcher.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/output_properties_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const assert = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails.push(m); };

// The knob's two settings. Both FRACTIONAL and neither 0: a 0 would be
// indistinguishable from the un-injected hole this feature refuses to produce.
const KNOB_VALUE = 0.25;
const KNOB_TURNED = 0.8;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  /** Every rendered row's label + what its value cell shows, for the OUTPUTS
   *  category only — read from the DOM, so it is the panel's own answer. */
  const outputsSection = () => page.evaluate(() => {
    const headers = [...document.querySelectorAll(".inspector .cat-header")];
    const header = headers.find((h) => h.textContent.trim().startsWith("Outputs"));
    if (!header) return { present: false };
    const cells = [...document.querySelectorAll(".inspector .output-val")];
    return {
      present: true,
      rows: cells.map((c) => ({
        text: c.textContent.trim(),
        focusable: c.getAttribute("tabindex") === "0",
        role: c.getAttribute("role"),
        // The row this cell sits in: does it also carry an editor or diamonds?
        label: c.closest(".row")?.querySelector(".label")?.textContent.trim() ?? null,
        editors: c.closest(".row")?.querySelectorAll("input, select, button.eq-open, .numfield").length ?? -1,
        diamonds: c.closest(".row")?.querySelectorAll(".kf-controls button").length ?? -1,
      })),
    };
  });

  const expand = async () => {
    await page.evaluate(() => {
      for (const h of document.querySelectorAll(".inspector .cat-header"))
        if (h.getAttribute("aria-expanded") === "false") h.click();
    });
    await sleep(400);
  };

  // ── The deck: a knob, an oscillator, and a rect bound to the knob's OUTPUT ──
  const ids = await page.evaluate((v) => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    const add = (type, over) => {
      app.addItem({ ...app.registry.get(type).defaults, type, ...over });
      return app.selection;
    };
    const knob = add("node_knob", { x: 60, y: 60, name: "Knob1", value: v, min: 0, max: 1 });
    const osc = add("audio_oscillator", { x: 300, y: 60, name: "Osc1" });
    const box = add("rect", { x: 600, y: 300, w: 80, h: 60, rotation: "= knob1.out * 100" });
    app.selection = knob;
    return { knob, osc, box };
  }, KNOB_VALUE);
  await sleep(900);
  await expand();

  // ── 1 + 2. THE SECTION EXISTS, AND ITS ROW IS A REPORT ─────────────────────
  const knobPanel = await outputsSection();
  assert(knobPanel.present, "a Knob's Inspector has an OUTPUTS section");
  const outRow = knobPanel.rows?.find((r) => r.label === "out");
  assert(!!outRow, `…with an "out" row (${JSON.stringify(knobPanel.rows?.map((r) => r.label))})`);
  assert(outRow?.text === String(KNOB_VALUE), `…showing the value the equations read (${JSON.stringify(outRow?.text)})`);
  assert(outRow?.editors === 0, `…and NO editor of any kind — it reports, it does not invite (${outRow?.editors} found)`);
  assert(outRow?.diamonds === 0, `…and NO keyframe diamonds: a computed value has no stored leaf (${outRow?.diamonds})`);
  assert(outRow?.focusable && outRow?.role === "status",
    "…focusable and role=status, so its tooltip is not pointer-only (the save-dot rule)");

  // ── 3. IT IS LIVE ──────────────────────────────────────────────────────────
  await page.evaluate((args) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", args.id, "value"], args.v]]);
    app.commitPreview();
  }, { id: ids.knob, v: KNOB_TURNED });
  await sleep(700);
  const turned = await outputsSection();
  assert(turned.rows?.find((r) => r.label === "out")?.text === String(KNOB_TURNED),
    `turning the knob moved the OUTPUT row — live, not a snapshot (${JSON.stringify(turned.rows?.find((r) => r.label === "out")?.text)})`);

  // ── 5. AND THE EQUATION THAT READS IT MOVED TOO ────────────────────────────
  const rotation = await page.evaluate((id) => window.__powerrp_app.state().items?.[id]?.rotation ?? null, ids.box);
  assert(Math.abs(rotation - KNOB_TURNED * 100) < 1e-9,
    `an equation elsewhere in the document read the output through the app's own evaluation (${rotation})`);

  // ── 4. TIER 1: DECLARED, WIREABLE, AND HONEST ABOUT HAVING NO VALUE ────────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, ids.osc);
  await sleep(700);
  await expand();
  const oscPanel = await outputsSection();
  assert(oscPanel.present, "an audio Oscillator's Inspector ALSO has an OUTPUTS section — tier 1 outputs are still outputs");
  const signalRow = oscPanel.rows?.find((r) => r.label === "out");
  assert(!!signalRow, `…with its "out" row (${JSON.stringify(oscPanel.rows?.map((r) => r.label))})`);
  assert(signalRow?.text === "Audio signal",
    `…reporting what it is rather than a fabricated number (${JSON.stringify(signalRow?.text)})`);
  assert(signalRow?.text !== "0" && signalRow?.text !== "",
    "…and specifically NOT 0 and not blank — the two answers the ruling forbids");

  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nPASS — output properties in the Inspector");
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
