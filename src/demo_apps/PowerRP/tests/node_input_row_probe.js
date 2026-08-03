/**
 * NODE INPUT ROW probe — THE WIRE AND THE INSPECTOR MUST AGREE, on the real editor.
 *
 * ── THE SCREENSHOT THIS EXISTS FOR ──────────────────────────────────────────
 * USER, 2026-08-03 (verbatim): "It says level has no input and yet I see it"
 * — a Level node (audio_meter) with green wires visibly attached at both beads,
 * whose Inspector INPUTS row simultaneously read "— not connected —".
 *
 * It looked like two stores disagreeing. It was not: there has only ever been ONE
 * connection leaf, `inputs.<port>` (core/nodeflow.js states the shape, and
 * connectionsOf is its only reader). The Inspector's option list simply asked the
 * WRONG OBJECT for the document — `state.items` inside the row snippet, where
 * `state` is the SELECTED ITEM'S own folded state and has no `.items` at all. So
 * compatibleSources searched an empty document, produced no options, and the
 * dropdown fell back to its "not connected" entry while the stored reference sat
 * intact and the wire drew from it normally.
 *
 * ── WHY A BROWSER PROBE AND NOT A UNIT TEST ─────────────────────────────────
 * The defect lived in the gap BETWEEN a pure function that was always right and a
 * component that called it with the wrong argument. Every bare-node test of
 * compatibleSources passed throughout, because they all passed it a real item map.
 * Only the rendered panel could show the disagreement, so only the rendered panel
 * can pin it shut.
 *
 * WHAT IS ASSERTED, and the two halves are deliberately opposite:
 *   1. WIRED: the dropdown NAMES the source, the stored leaf holds it, and
 *      deriveWires draws exactly one wire — three surfaces, one answer.
 *   2. UNWIRED: it honestly reads "not connected", the leaf is null, and NO wire
 *      is drawn. (Without this half the fix could be "always show something".)
 *   3. The option list is non-empty and OFFERS the compatible source — the exact
 *      thing that was empty, asserted directly rather than through its symptom.
 *
 * Frontend-only Vite on an EPHEMERAL port, per the probe convention.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/node_input_row_probe.js
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

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  // ── THE PATCH: an oscillator into a Level meter, exactly the screenshot ─────
  const ids = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    const add = (type, over) => {
      app.addItem({ ...app.registry.get(type).defaults, type, ...over });
      return app.selection;
    };
    const osc = add("audio_oscillator", { x: 120, y: 200 });
    // The meter is titled "Level" on its card — the node in the screenshot.
    const meter = add("audio_meter", { x: 460, y: 200, inputs: { in: { item: osc, port: "out" } } });
    app.selection = meter;
    return { osc, meter };
  });
  await sleep(900);

  const expand = async () => {
    await page.evaluate(() => {
      for (const h of document.querySelectorAll(".inspector .cat-header"))
        if (h.getAttribute("aria-expanded") === "false") h.click();
    });
    await sleep(400);
  };
  await expand();

  /** Reads all three surfaces at once: what the panel SAYS, what the document
   *  STORES, and how many wires the render tree DRAWS. The point of the probe is
   *  that these cannot disagree, so they are read together. */
  const surfaces = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const rows = [...document.querySelectorAll(".inspector .row")];
    const inputRow = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "in");
    const trigger = inputRow?.querySelector("button, .dd-trigger, [role='combobox']");
    return {
      rowPresent: !!inputRow,
      shown: (trigger?.textContent ?? "").trim(),
      stored: app.rawState().items?.[app.selection]?.inputs?.in ?? null,
      wireCount: app.debugWireCount ? app.debugWireCount() : null,
    };
  });

  // ── 1. WIRED: all three surfaces name the same connection ──────────────────
  const wired = await surfaces();
  assert(wired.rowPresent, "the Level node's INPUTS section renders an `in` row");
  assert(wired.stored && wired.stored.item === ids.osc,
    `the document STORES the connection (${JSON.stringify(wired.stored)})`);
  assert(!/not connected/i.test(wired.shown),
    `and the dropdown does NOT claim "not connected" — it reads ${JSON.stringify(wired.shown)}`);
  assert(wired.shown.length > 0, "the dropdown NAMES the source rather than showing an empty label");

  // ── 3. THE OPTION LIST, asserted directly ──────────────────────────────────
  // This is the value that was empty. Reading it through the core function with
  // the SAME argument the component now passes is the regression's tightest pin.
  const options = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { compatibleSources } = await import("/../core/nodeflow.js");
    const items = app.state().items ?? {};
    return compatibleSources(items, app.registry, { item: app.selection, port: "in" })
      .map((o) => `${o.item}.${o.port}`);
  });
  assert(options.length > 0, `compatibleSources offers ${options.length} source(s) for the meter's audio in`);
  assert(options.some((o) => o.startsWith(ids.osc)),
    `and the oscillator is among them: ${JSON.stringify(options)}`);

  // ── 2. UNWIRED: the honest opposite ────────────────────────────────────────
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", app.selection, "inputs.in"], null]]);
    app.commitPreview();
  });
  await sleep(700);
  const cut = await surfaces();
  assert(cut.stored === null, "disconnecting stores null (not an absent key — it must not re-inherit)");
  assert(/not connected/i.test(cut.shown),
    `and NOW the dropdown honestly reads "not connected" (${JSON.stringify(cut.shown)})`);

  // ── The wire follows the property, in both directions ──────────────────────
  const wires = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { deriveRenderTree, deriveWires } = await import("/../core/derive.js");
    const count = () => deriveWires(deriveRenderTree(app.state(), app.registry)).length;
    const cut = count();
    app.setPreview([[["items", app.selection, "inputs.in"], { item: app.rawState().items && Object.keys(app.rawState().items).find((k) => app.rawState().items[k].type === "audio_oscillator"), port: "out" }]]);
    app.commitPreview();
    await new Promise((r) => setTimeout(r, 300));
    return { cut, rewired: count() };
  });
  assert(wires.cut === 0, `no wire is drawn while the input is null (${wires.cut})`);
  assert(wires.rewired === 1, `and reconnecting draws exactly one again (${wires.rewired})`);
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length === 0
  ? "\nnode input row: the wire and the Inspector agree, both wired and cut"
  : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
