/**
 * INSPECTOR ACTION-ROW probe — the one ROW_KIND that is not a value slot.
 *
 * core/properties.js declares `action` ("a command trigger, not a value slot") and
 * plugins/group.js is its only user ("Ungroup"). The Inspector's valueControl
 * dispatcher had NO branch for it, so the row fell through to the catch-all text
 * <input>: an empty editable field with no sign it was a button, carrying a keyframe
 * diamond and a copy-equation-path affordance for a property that does not exist —
 * and typing in it keyframed a junk `__ungroup` string onto the group. It was the
 * most misleading hover surface in the Inspector: you could not tell what a click
 * would do because a click did nothing at all.
 *
 * Asserts, on the REAL editor:
 *   1. the row renders a labelled BUTTON, and no text <input>
 *   2. it carries NO keyframe diamond and NO copy-path chrome (it owns no state)
 *   3. hovering it EXPLAINS what the click does — and is not the banned label echo
 *   4. hovering it leaves the document byte-identical
 *   5. clicking it actually RUNS the command
 *
 * Frontend-only Vite on an EPHEMERAL port (never 3637/3638), swiftshader GL.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/inspector_action_row_probe.js
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

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const assert = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails.push(m); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("PAGEERROR " + e.message));
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  // Two rects, grouped — the only way to make a `group` item, whose rows carry the
  // one kind:"action" row in the whole registry. addItem + selectMany + groupSelection
  // in ONE block is the group_resize_snap_probe idiom (app.selection reads back the
  // id addItem just selected); assigning app.selection an array directly does NOT
  // register a multi-selection.
  const grouped = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.clearDoc();
    app.addItem({ type: "rect", x: 200, y: 200, w: 60, h: 60, rotation: 0, scale: 1, fill: "#e33", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
    const idA = app.selection;
    app.addItem({ type: "rect", x: 360, y: 320, w: 60, h: 60, rotation: 0, scale: 1, fill: "#3e3", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
    const idB = app.selection;
    app.selectMany([idA, idB]);
    app.groupSelection();
    const gid = app.selection;
    return { gid: typeof gid === "string" ? gid : null, isGroup: app.nodes().some((n) => n.itemId === gid && n.type === "group") };
  });
  assert(grouped.gid != null && grouped.isGroup, `a group was created and selected (gid=${grouped.gid})`);
  await sleep(800);

  // Expand every collapsed Inspector category so the group category's rows render.
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".inspector .cat-header"))
      if (h.getAttribute("aria-expanded") === "false") h.click();
  });
  await sleep(500);

  const row = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const r = rows.find((el) => el.querySelector(".label")?.textContent.trim() === "Ungroup");
    if (!r) return { found: false, labels: rows.map((el) => el.querySelector(".label")?.textContent.trim()).filter(Boolean) };
    const btn = r.querySelector("button.btn");
    // The Inspector pane SCROLLS: a rect read while the row sits below the fold
    // gives coordinates the pointer cannot reach, so bring it into view first.
    btn?.scrollIntoView({ block: "center" });
    const rect = btn?.getBoundingClientRect();
    return {
      found: true,
      hasButton: !!btn,
      buttonText: btn?.textContent.trim() ?? null,
      hasTextInput: !!r.querySelector('input[type="text"]'),
      hasKeyframeDiamond: !!r.querySelector(".keybtn"),
      hasCopyPath: !!r.querySelector(".copy-path-btn"),
      at: rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null,
    };
  });
  assert(row.found, `the group's Ungroup row is rendered${row.found ? "" : " — labels seen: " + JSON.stringify(row.labels)}`);
  assert(row.hasButton, "the action row renders a BUTTON");
  assert(!row.hasTextInput, "the action row renders NO text <input> (the old catch-all fallthrough is gone)");
  assert((row.buttonText ?? "").includes("Ungroup"), `the button is labelled (text=${JSON.stringify(row.buttonText)})`);
  assert(!row.hasKeyframeDiamond, "the action row has NO keyframe diamond (it owns no property to key)");
  assert(!row.hasCopyPath, "the action row has NO copy-equation-path chrome (it has no equation path)");

  const docBefore = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  await page.mouse.move(20, 950);
  await sleep(150);
  await page.mouse.move(row.at.x, row.at.y);
  await page.mouse.move(row.at.x + 1, row.at.y);
  await sleep(400);
  const tip = await page.evaluate(() => document.querySelector(".tt-tip")?.textContent.trim().replace(/\s+/g, " ") ?? null);
  assert(tip != null, `hovering the action row shows an EXPLANATION tooltip -> ${JSON.stringify(tip)}`);
  assert(tip !== "Ungroup", "the tip is NOT the banned label echo (it says what the click DOES, not the button's own label)");
  assert((tip ?? "").length > 30, `the tip is a real explanatory sentence (${(tip ?? "").length} chars)`);
  assert((await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc))) === docBefore, "hovering the action row leaves the document byte-identical");

  await page.mouse.down();
  await page.mouse.up();
  await sleep(600);
  const stillGrouped = await page.evaluate((gid) => window.__powerrp_app.nodes().some((n) => n.itemId === gid && n.type === "group"), grouped.gid);
  assert(!stillGrouped, "clicking the action row RAN the command — the group is gone (Ungroup actually ungrouped)");

  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nPASS — Inspector action row");
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
