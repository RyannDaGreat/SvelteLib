/**
 * THE `richtext` ROW, IN THE REAL EDITOR — the half tests/richtext_row_test.js
 * cannot reach. That gate reads web/Inspector.svelte as TEXT (no node test can
 * import a .svelte file); this one renders it and looks at what a user sees.
 *
 * WHAT IT GATES, and it is exactly one thing: THE DISPATCHER. A row declaring
 * kind:"richtext" must reach the richtext branch and not the catch-all text
 * input. The failure it exists to make impossible is specific and measurable —
 * the catch-all does `value={state[row.key]}` over a {runs, paras} OBJECT, so
 * the field reads the literal string "[object Object]" and the first keystroke
 * replaces the whole structured value with a bare string.
 *
 * WHY IT INJECTS ITS OWN ROW instead of waiting for plugins/text.js to declare
 * one. The row declaration and the renderer are owned by two agents and land in
 * two commits, and the SAFE order is renderer-first. A probe that needed the
 * declaration could therefore only be written after the thing it gates was
 * already shipped. Injecting the row makes this gate independent: it asks "does
 * a richtext row render correctly", which is answerable today. It deliberately
 * does NOT assert that plugins/text.js ships one — that is the other half's gate,
 * and asserting it here would make this file red for a reason it cannot fix.
 *
 * Spawns its own isolated Vite + headless Chromium. Frontend-only.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|no.*adapter|adapters/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  // waitForFunction, not a constant sleep: a peer saving a file forces Vite to
  // re-optimize and pushes first paint past any fixed budget (commit b09f40a).
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 180000 });
  await sleep(2500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A text item whose content carries TWO run styles, so a flatten is visible in
  // the document and not merely suspected.
  const STYLED = { runs: [{ text: "Big ", size: 48 }, { text: "small", size: 18 }], paras: [{}] };
  await page.evaluate((styled) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const txt = { ...def("text"), name: "Caption", x: 100, y: 100, w: 400, h: 120, z: 1, active: true, text: styled };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    app.commit(app.repaired({ meta: { name: "richtext-row", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items: { cam, t1: txt } } },
    ] }));
    app.slideIndex = 0;
    app.selection = "t1";

    // INJECT the row (see header): the declaration is another agent's commit.
    const plugin = app.registry.get("text");
    if (!plugin.inspector.some((r) => r.kind === "richtext"))
      plugin.inspector = [...plugin.inspector, { key: "text", label: "Probe Text", kind: "richtext", category: "custom" }];
  }, STYLED);
  await sleep(900);
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".cat-header[aria-expanded='false']")) h.click();
  });
  await sleep(500);

  /** Query. The richtext row's <input>, by its label. */
  const rowInput = () => page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")]
      .find((r) => r.querySelector(".label")?.textContent.trim() === "Probe Text");
    if (!row) return { found: false };
    const input = row.querySelector("input[type='text']");
    return { found: true, hasInput: !!input, value: input?.value ?? null, hasEqButton: !!row.querySelector(".eq-open") };
  });

  const before = await rowInput();
  assert(before.found, "the injected richtext row renders in the Inspector");
  assert(before.hasInput, "it renders a text input");
  // THE CENTRAL ASSERTION. This is what the catch-all would produce.
  assert(before.value !== "[object Object]",
    `the row shows the PLAIN TEXT, not the stringified object (saw ${JSON.stringify(before.value)})`);
  assert(before.value === "Big small", `it shows the rich value's plain projection (saw ${JSON.stringify(before.value)})`);
  assert(!before.hasEqButton, "no ƒ affordance — richtext is out of EQUATION_KINDS");

  const shot = resolve(SHOTS, "w5g-richtext-row.png");
  const panel = await page.$(".inspector");
  const clip = await page.evaluate(() => {
    const r = document.querySelector(".inspector").getBoundingClientRect();
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    return { x: r.left, y: top, width: r.width, height: bottom - top };
  });
  if (panel) await page.screenshot({ path: shot, clip, captureBeyondViewport: false });
  console.log(`  shot: ${shot}`);

  // TYPE INTO IT. `oninput` previews and `onchange` commits, so the probe sets
  // the value and dispatches both — the same pair a real keystroke + blur sends.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")]
      .find((r) => r.querySelector(".label")?.textContent.trim() === "Probe Text");
    const input = row.querySelector("input[type='text']");
    input.focus();
    input.value = "Big smaller";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  });
  await sleep(700);

  const stored = await page.evaluate(() => {
    const it = window.__powerrp_app.doc.slides[0].delta.items;
    return JSON.stringify(it.t1?.text ?? null);
  }).then(JSON.parse);

  assert(stored !== null && Array.isArray(stored.runs),
    `the committed value is still a {runs, paras} OBJECT, not a flattened string (saw ${JSON.stringify(stored)})`);
  if (stored && Array.isArray(stored.runs)) {
    const plain = stored.runs.map((r) => r.text ?? "").join("");
    assert(plain === "Big smaller", `the edit reached the document (saw ${JSON.stringify(plain)})`);
    assert(JSON.stringify(stored.runs.map((r) => r.size)) === JSON.stringify([48, 18]),
      `both run styles survived the edit — the write is a splice, not a flatten (saw sizes ${JSON.stringify(stored.runs.map((r) => r.size))})`);
  }

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
  if (fails.length) { console.error(`\n${fails.length} FAILED`); process.exit(1); }
  console.log("\nrichtext row probe: all checks passed");
} finally {
  await browser.close();
  await server.close();
}
