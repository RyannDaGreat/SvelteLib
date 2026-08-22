/**
 * BIND HEIGHT TO CONTENT, end to end in a real editor — the half core/content_size.js
 * cannot reach on its own: that something actually MEASURES, that the table
 * reaches the evaluator through the one seam, and that the command writes an
 * equation which keeps tracking.
 *
 * The bare-node suite (tests/content_size_test.js) proves the evaluator half by
 * handing it a table directly. Nothing there proves a table is ever produced.
 *
 * No screenshots — every assertion is a state read, so this is immune to the host
 * Chrome capture hang (CLAUDE.md's preflight note).
 *
 * Run: node src/demo_apps/PowerRP/tests/content_bind_probe.js
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

/** A 4:1 PNG (40x10), so the expected aspect is unmistakable in the numbers. */
const IMG_W = 40, IMG_H = 10;

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: path.resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await server.listen();
  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU/i;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 800));

    // ── WHY THIS IS THREE CALLS AND NOT ONE ──────────────────────────────────
    // It was ONE `page.evaluate(async …)` containing a 60x50ms polling loop until
    // 2026-08-22. That leaves a CDP `Runtime.callFunctionOn` promise pending for
    // ~3s, and V8 COLLECTS it under memory pressure: the probe then dies with
    // `ProtocolError: Protocol error (Runtime.callFunctionOn): Promise was
    // collected` before reaching a single assertion — a puppeteer stack with no
    // assertion text, which reads exactly like a product regression and is not
    // one. MEASURED on a loaded host (105 concurrent Chromes): 1 of 3 runs
    // survived as one call, 4 of 4 split like this. No page navigation was
    // involved, so it is not the dep-optimizer reload CLAUDE.md warns about.
    // The waiting moves to `page.waitForFunction`, which is polled by the browser
    // and holds no pending promise. NO ASSERTION CHANGED — the same eight values
    // are gathered in the same order and checked by the same `ok()` calls below.
    const id = await page.evaluate(async (w, h) => {
      const app = window.__powerrp_app;
      // A real decodable image at a known, deliberately non-square aspect.
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#c33"; ctx.fillRect(0, 0, w, h);
      await app.insertImageAsset(c.toDataURL("image/png"), { x: 400, y: 300 });
      return app.selection;
    }, IMG_W, IMG_H);

    // rawState = what is STORED; state() = folded + EVALUATED (equations resolved).
    const r = await page.evaluate((id) => ({
      insertedW: window.__powerrp_app.rawState().items[id].w,
      insertedH: window.__powerrp_app.rawState().items[id].h,
    }), id);

    // Wait for the decode to reach the registry (the measurement is a PULL, so it
    // appears as soon as the bitmap does). A TIMEOUT IS NOT A THROW: it leaves
    // `measured` null so the `THE PRODUCER RAN` check below reports it as the
    // failed requirement it is, rather than as a puppeteer TimeoutError.
    await page.waitForFunction((id) => window.__powerrp_app.contentSizes().has(id), { timeout: 15000, polling: 50 }, id)
      .catch(() => {});

    Object.assign(r, await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const out = { measured: app.contentSizes().get(id) ?? null };

      const cmd = app.commands.get("bind-height-to-content");
      out.present = !!cmd;
      out.gate = cmd.when(app);

      // Set a width that is NOT the natural one, so a correct bind is visibly
      // different from "it kept the size it was inserted at".
      app.setPreview([[["items", id, "w"], 800]]);
      app.commitPreview();

      cmd.run(app);
      out.storedH = app.rawState().items[id].h;
      out.evaluatedH = app.state().items[id].h;

      // IT KEEPS TRACKING: change the width, the height must follow with no
      // further command.
      app.setPreview([[["items", id, "w"], 400]]);
      app.commitPreview();
      out.trackedH = app.state().items[id].h;
      return out;
    }, id));

    // ── A WINDOW IN WHICH THE BINDING IS ACTUALLY LIVE ───────────────────────
    // The escape-hatch commit below REPLACES the equation with a plain number, so
    // until 2026-08-22 the binding existed only inside one synchronous evaluate
    // and no asynchronous consequence of it was ever observable: the app's
    // reactive tool-gate pass ran after the equation had already been removed.
    // Measured — with the override still inline, four consecutive runs reported
    // "no page errors" while the bound state was demonstrably logging one.
    // Settling HERE, outside the evaluate, is what lets the console gate below
    // see the bound document. It is done between two short calls rather than as
    // an `await` inside one, for the pending-promise reason documented above.
    await new Promise((res) => setTimeout(res, 600));

    // And the escape hatch: a typed number replaces the binding.
    Object.assign(r, await page.evaluate((id) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "h"], 123]]);
      app.commitPreview();
      return { overriddenH: app.state().items[id].h };
    }, id));

    ok(r.insertedW === IMG_W && r.insertedH === IMG_H, `setup: the image inserted at its native ${IMG_W}x${IMG_H} (got ${r.insertedW}x${r.insertedH})`);
    ok(r.measured !== null, `THE PRODUCER RAN: the intrinsic size reached the table (${JSON.stringify(r.measured)})`);
    ok(r.measured?.w === IMG_W && r.measured?.h === IMG_H, "…and it is the real decoded size, not the widget's box");
    ok(r.present, "the bind command is registered");
    ok(r.gate === true, "it is available once the content is measured");
    ok(typeof r.storedH === "string" && r.storedH.startsWith("="), `it stores an EQUATION, not a number (got ${JSON.stringify(r.storedH)})`);
    ok(r.evaluatedH === 800 / (IMG_W / IMG_H), `THE FEATURE: at width 800 a 4:1 image gives height ${800 / (IMG_W / IMG_H)} (got ${r.evaluatedH})`);
    ok(r.trackedH === 400 / (IMG_W / IMG_H), `IT KEEPS TRACKING: width 400 re-derives height ${400 / (IMG_W / IMG_H)} with no second command (got ${r.trackedH})`);
    ok(r.overriddenH === 123, `THE ESCAPE HATCH: typing a plain height replaces the binding (got ${r.overriddenH})`);
    // Let the last commit's reactive work land before judging the console.
    await new Promise((res) => setTimeout(res, 300));

    // THIS CHECK IS RED ON A CLEAN TREE AND THE ERROR IS REAL — do NOT add it to
    // IGNORE, and do not "fix" it by deleting the live-binding settle above.
    // Measured 2026-08-22: while the bind equation is live the app logs
    //   PowerRP expression error at items.<id>.h: Item "<name>" has no property "content.aspect"
    // The equation itself is CORRECT — evaluatedH and trackedH above are exact,
    // because app.state() threads the content-size table. The emitter is
    // `documentState()` at web/App.svelte:1069, the hypothetical tool-gate
    // evaluation, which passes `null` for evaluateState's `contentSizes` argument
    // while carefully threading `a.projectScript()` and `a.varKindsForEval()`. The
    // comment directly above that line makes precisely this argument for the other
    // two ambient inputs and stops one short of the third. Stack captured in the
    // page through core/report.js reportOnce -> expressions.js fail/evalSlot,
    // under the withSimulationFrozen(withPointerFrozen(...)) pair that is unique
    // to that function. Fix: `a.contentSizes()` in place of that `null` —
    // core/content_size.js documents the table as an evaluation INPUT that every
    // consumer must thread, exactly as the project script is.
    ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} content-bind probe checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error("content_bind_probe ERROR:", e); process.exit(1); });
