/**
 * INTERSECTION ⇄ UNION, in a real editor — that the toggle EXISTS at the top of
 * the multi-selection panel, that it changes what the panel is made of, and that
 * a union row carries who it applies to.
 *
 * The pure half is tests/multiselect_union_test.js. This is the half it cannot
 * see: real plugins with real row sets (a rect and a text widget genuinely differ),
 * the app's mode field, and the two buttons actually rendering.
 *
 * No screenshots — every assertion is a state or DOM read, so this is immune to
 * the host Chrome capture hang (CLAUDE.md's preflight note).
 *
 * Run: node src/demo_apps/PowerRP/tests/multiselect_union_probe.js
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: path.resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await server.listen();
  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
    const errors = [];
    const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU/i;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 900));

    const r = await page.evaluate(() => {
      const app = window.__powerrp_app;
      // A rect and a TEXT widget — chosen because their row sets genuinely differ,
      // so union has something real to add rather than a contrived fixture.
      app.addItem(app.registry.get("rect").defaults); const a = app.selection;
      app.addItem(app.registry.get("text").defaults); const b = app.selection;
      app.selectMany([a, b]);
      const inter = app.multiSelectPanel();
      app.setMultiSelectMode("union");
      const uni = app.multiSelectPanel();
      app.setMultiSelectMode("intersection");
      const back = app.multiSelectPanel();
      let threw = null;
      try { app.setMultiSelectMode("nonsense"); } catch (e) { threw = e.message; }
      const docBefore = JSON.stringify(app.doc);
      app.setMultiSelectMode("union");
      return {
        interCount: inter.rows.length,
        uniCount: uni.rows.length,
        backCount: back.rows.length,
        interMode: inter.mode, uniMode: uni.mode,
        superset: inter.rows.every((x) => uni.rows.some((u) => u.row.key === x.row.key)),
        everyRowHasAppliesTo: uni.rows.every((x) => Array.isArray(x.appliesTo) && x.appliesTo.length > 0),
        partial: uni.rows.filter((x) => x.appliesTo.length < 2).length,
        threw,
        docUnchanged: JSON.stringify(app.doc) === docBefore,
      };
    });
    const btns = await page.evaluate(() => [...document.querySelectorAll(".multi-mode .btn")].map((b) => b.textContent.trim()));
    const icons = await page.evaluate(() => [...document.querySelectorAll(".multi-mode iconify-icon")].map((i) => i.getAttribute("icon")));
    const pressed = await page.evaluate(() => [...document.querySelectorAll(".multi-mode .btn")].map((b) => b.getAttribute("aria-pressed")));

    ok(btns.length === 2, `the toggle renders two buttons (${JSON.stringify(btns)})`);
    ok(icons.join() === "mdi:set-center,mdi:set-all", `they carry the two Venn glyphs (${JSON.stringify(icons)})`);
    ok(pressed.filter((p) => p === "true").length === 1, `exactly one is aria-pressed (${JSON.stringify(pressed)})`);
    ok(r.interMode === "intersection" && r.uniMode === "union", "the panel reports which mode built it");
    ok(r.uniCount > r.interCount, `UNION SHOWS MORE: ${r.interCount} shared rows → ${r.uniCount} union rows on rect + text`);
    ok(r.superset, "and it is a strict SUPERSET — union never loses a shared row");
    ok(r.partial > 0, `${r.partial} of them apply to only ONE of the two items — the rows union exists to surface`);
    ok(r.everyRowHasAppliesTo, "every union row carries a non-empty appliesTo, so no write can leak to a non-participant");
    ok(r.backCount === r.interCount, `toggling back restores the intersection exactly (${r.backCount})`);
    ok(/unknown mode/.test(r.threw ?? ""), `an invalid mode throws LOUDLY rather than silently doing nothing (got "${r.threw}")`);
    ok(r.docUnchanged, "switching modes writes NOTHING to the document — it is view state, not deck state");
    ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} multiselect-union probe checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error("multiselect_union_probe ERROR:", e); process.exit(1); });
