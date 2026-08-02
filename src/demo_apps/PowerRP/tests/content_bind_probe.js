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

    const r = await page.evaluate(async (w, h) => {
      const app = window.__powerrp_app;
      // A real decodable image at a known, deliberately non-square aspect.
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#c33"; ctx.fillRect(0, 0, w, h);
      const uri = c.toDataURL("image/png");

      await app.insertImageAsset(uri, { x: 400, y: 300 });
      const id = app.selection;
      // rawState = what is STORED; state() = folded + EVALUATED (equations resolved).
      const out = { insertedW: app.rawState().items[id].w, insertedH: app.rawState().items[id].h };

      // Wait for the decode to reach the registry (the measurement is a PULL, so
      // it appears as soon as the bitmap does).
      for (let i = 0; i < 60 && !app.contentSizes().has(id); i++) await new Promise((res) => setTimeout(res, 50));
      out.measured = app.contentSizes().get(id) ?? null;

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

      // And the escape hatch: a typed number replaces the binding.
      app.setPreview([[["items", id, "h"], 123]]);
      app.commitPreview();
      out.overriddenH = app.state().items[id].h;
      return out;
    }, IMG_W, IMG_H);

    ok(r.insertedW === IMG_W && r.insertedH === IMG_H, `setup: the image inserted at its native ${IMG_W}x${IMG_H} (got ${r.insertedW}x${r.insertedH})`);
    ok(r.measured !== null, `THE PRODUCER RAN: the intrinsic size reached the table (${JSON.stringify(r.measured)})`);
    ok(r.measured?.w === IMG_W && r.measured?.h === IMG_H, "…and it is the real decoded size, not the widget's box");
    ok(r.present, "the bind command is registered");
    ok(r.gate === true, "it is available once the content is measured");
    ok(typeof r.storedH === "string" && r.storedH.startsWith("="), `it stores an EQUATION, not a number (got ${JSON.stringify(r.storedH)})`);
    ok(r.evaluatedH === 800 / (IMG_W / IMG_H), `THE FEATURE: at width 800 a 4:1 image gives height ${800 / (IMG_W / IMG_H)} (got ${r.evaluatedH})`);
    ok(r.trackedH === 400 / (IMG_W / IMG_H), `IT KEEPS TRACKING: width 400 re-derives height ${400 / (IMG_W / IMG_H)} with no second command (got ${r.trackedH})`);
    ok(r.overriddenH === 123, `THE ESCAPE HATCH: typing a plain height replaces the binding (got ${r.overriddenH})`);
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
