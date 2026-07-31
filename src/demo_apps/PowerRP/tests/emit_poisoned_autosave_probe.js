/**
 * THE EMIT-POISONED AUTOSAVE PROBE — tests/poisoned_autosave_probe.js's exact
 * pattern, extended one seam EARLIER: the poison here throws INSIDE A PLUGIN'S
 * OWN emit(), before paintFlat's per-node boundary (render_gpu/skia/paint_skia.js
 * paintNodeRun) ever gets a chance to run, so it exercises render_gpu/ports.js
 * emitNode's containment instead.
 *
 * ── THE POISON ────────────────────────────────────────────────────────────
 * demo_god_rays with `lightWorldY: "not-a-number"` — a plain STRING in a
 * numeric slot, stored directly (no `=` equation), so it survives JSON
 * round-tripping through localStorage unchanged and the separate expression-
 * layer NaN guard in core/expressions.js (which only intercepts EQUATION
 * results) never sees it. plugins/demo/god_rays.js lightLocal does arithmetic
 * on it (`T.apply(inv, s.lightWorldX, s.lightWorldY)`), which JS silently turns
 * into NaN, and materialBackdrop's own validator throws: 'materialBackdrop:
 * param "lightOffsetX" is a non-finite number' — the SAME failure class as the
 * live report, reproduced independently of whatever preset numbers are
 * mid-edit in that file. The widget's own w/h/scale stay ordinary (1), so its
 * red-box affordance is a normal, visible, on-screen size — unlike a
 * scale-poisoned node, whose OWN render box collapses to nothing regardless of
 * containment (a zero-scale healthy widget would be equally invisible).
 *
 * ── WHAT IS ASSERTED (mirrors poisoned_autosave_probe.js's five sections) ───
 *   1. BOOT to an interactive app with a poisoned autosave already in place.
 *   2. THE REST OF THE SCENE PAINTS (the healthy widget's own pixels + a red
 *      box for the poisoned one, not a hole).
 *   3. THE POISON IS NAMED, reported ONCE ("failed to EMIT", not "to PAINT" —
 *      proof this is the ports.js seam, not paint_skia's).
 *   4. THE RENDER LOOP LIVES after the failure.
 *   5. RECOVERY: purge the poisoned item through the app's own command seam,
 *      and the NEXT BOOT from the healed autosave is clean.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/emit_poisoned_autosave_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shots = process.argv[2] ?? resolve(HERE, "../.claude_vlm_checks/emit_poisoned_autosave");
await mkdir(shots, { recursive: true });

const BOOT_MS = 2000;
const SETTLE_MS = 500;
const FRAME_SAMPLE_MS = 700;

/** The deck: one healthy rect, one demo_god_rays widget poisoned by scale:0. */
function poisonedDoc() {
  return {
    meta: { name: "EmitPoisonedDeck", slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s0", name: "Slide 1", transition: { type: "none", seconds: 0, curve: "linear", sound: "" },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 1280, h: 720, z: 0, rotation: 0, scale: 1, active: true, background: "#101418" },
          healthy: { type: "rect", name: "Healthy Box", x: 120, y: 140, w: 300, h: 200, z: 1, rotation: 0, scale: 1, active: true, fill: "#22aa55" },
          poison: {
            type: "demo_god_rays", name: "Poisoned Rays", x: 620, y: 140, w: 300, h: 200, z: 2, rotation: 0,
            scale: 1, active: true,
            // A string in a numeric slot: emit()'s own arithmetic (T.apply) turns
            // this into NaN, which materialBackdrop's validator rejects. The
            // widget's OWN w/h/scale stay healthy, so the box is a normal visible
            // size on screen (see this file's docblock for why that matters).
            lightWorldX: 770, lightWorldY: "not-a-number",
          },
        },
      },
    }],
  };
}

const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();

const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/,
  /Failed to load resource/, /failed to load/, /net::ERR/, /listAssets/, /favicon/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));

/** THE EMIT BOUNDARY's own report line — distinct from paint_skia's "failed to
 *  PAINT", which proves this probe exercises ports.js emitNode, not paintFlat. */
const EMIT_FAILURE = /failed to EMIT/;
const PAINT_FAILURE = /failed to PAINT/;

try {
  // ══ BOOT 1: the emit-poisoned autosave ══════════════════════════════════════
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !isNoise(m.text())) consoleErrors.push(m.text()); });

  await page.evaluateOnNewDocument(
    (json) => localStorage.setItem("powerrp.autosave", json),
    JSON.stringify(poisonedDoc()),
  );
  await page.goto(base, { waitUntil: "networkidle0" });

  // ── 1. THE APP REACHES AN INTERACTIVE STATE ───────────────────────────────
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await sleep(BOOT_MS);
  await page.screenshot({ path: resolve(shots, "01_booted_with_poison.png") });

  const booted = await page.evaluate(() => {
    const app = window.__powerrp_app;
    if (!app) return { alive: false };
    const st = app.state();
    return {
      alive: true,
      items: Object.keys(st.items).length,
      hasPoison: !!st.items.poison,
      poisonType: st.items.poison?.type ?? null,
      poisonLightY: st.items.poison?.lightWorldY ?? null,
    };
  });
  ok(booted.alive, "the app object exists after booting an EMIT-poisoned autosave");
  ok(booted.items >= 3, `the poisoned deck opened with its items intact (${booted.items})`);
  ok(booted.hasPoison && booted.poisonType === "demo_god_rays" && booted.poisonLightY === "not-a-number", `the poison is really in the document (type ${booted.poisonType}, lightWorldY ${JSON.stringify(booted.poisonLightY)})`);

  const toolbar = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null && !b.disabled);
    return { count: btns.length };
  });
  ok(toolbar.count >= 5, `the toolbar is present and clickable (${toolbar.count} enabled buttons)`);

  const commandsAnswer = await page.evaluate(() => {
    const app = window.__powerrp_app;
    try {
      const ids = app.commands ? app.commands.all().map((c) => c.id) : [];
      return { n: ids.length };
    } catch (e) { return { n: 0, error: String(e) }; }
  });
  ok(commandsAnswer.n > 0, `the command registry answers (${commandsAnswer.n} commands) — the app is driveable`);

  // ── 2. THE REST OF THE SCENE PAINTS ───────────────────────────────────────
  const scene = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const nodes = app.nodes();
    return { ids: nodes.map((n) => n.itemId) };
  });
  ok(scene.ids.includes("healthy"), "the HEALTHY item is still in the render tree — it did not pay for its neighbour's emit() throw");

  const shot = await page.$("canvas.scene");
  const png = await shot.screenshot({ encoding: "base64" });
  const painted = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const off = document.createElement("canvas");
    off.width = bmp.width; off.height = bmp.height;
    const g = off.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, off.width, off.height).data;
    const seen = new Set();
    let greenish = 0, reddish = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
      seen.add(`${r >> 4},${gg >> 4},${b >> 4}`);
      if (gg > 120 && gg > r + 40 && gg > b + 40) greenish++;
      if (r > 180 && r > gg + 30 && r > b + 30) reddish++;
    }
    return { distinctColors: seen.size, greenish, reddish };
  }, png);
  ok(painted.distinctColors >= 3, `the canvas really painted a scene (${painted.distinctColors} distinct quantised colours)`);
  ok(painted.greenish > 500, `the HEALTHY widget's own pixels are on screen (${painted.greenish} green px)`);
  ok(painted.reddish > 500, `the POISONED widget shows the RED ERROR BOX, not a hole (${painted.reddish} red px)`);

  // ── 3. THE POISON IS NAMED, ONCE, AND THROUGH THE EMIT SEAM ───────────────
  const emitFailures = consoleErrors.filter((s) => EMIT_FAILURE.test(s));
  const paintFailures = consoleErrors.filter((s) => PAINT_FAILURE.test(s));
  ok(emitFailures.length >= 1, `the EMIT failure was reported (${emitFailures.length} line(s)): ${JSON.stringify(consoleErrors.slice(0, 5))}`);
  ok(
    emitFailures.some((s) => /Poisoned Rays|poison/.test(s)),
    `the report NAMES the item: ${JSON.stringify(emitFailures[0] ?? "(none)")}`,
  );
  ok(paintFailures.length === 0, `this is the EMIT seam, not the PAINT seam — no 'failed to PAINT' line expected (got ${paintFailures.length})`);

  // ── 4. THE RENDER LOOP LIVES ───────────────────────────────────────────────
  const frames = await page.evaluate((ms) => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
  }), FRAME_SAMPLE_MS);
  ok(frames > 10, `the render loop is still advancing AFTER the failure (${frames} frames in ${FRAME_SAMPLE_MS}ms)`);
  ok(emitFailures.length < 10, `the failure is deduped, not screamed every frame (${emitFailures.length} lines across ${frames}+ frames)`);

  const uncaught = pageErrors.filter((s) => !isNoise(s));
  ok(uncaught.length === 0, `NO uncaught page error: ${JSON.stringify(uncaught.slice(0, 2))}`);

  // ── 5. RECOVERY: purge the poisoned item, and the next boot is clean ──────
  const deleted = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = "poison";
    const purgeId = "purge-item";
    const known = app.commands.all().map((c) => c.id).includes(purgeId);
    if (known) app.runCommand(purgeId);
    return { purgeId: known ? purgeId : null, remaining: Object.keys(app.state().items) };
  });
  await sleep(SETTLE_MS);
  ok(deleted.purgeId, `a delete/purge command exists and ran (${deleted.purgeId})`);
  ok(!deleted.remaining.includes("poison"), `the poisoned item is GONE from the document (${deleted.remaining.join(", ")})`);
  await page.screenshot({ path: resolve(shots, "02_after_delete.png") });

  const savedAfter = await page.evaluate(() => localStorage.getItem("powerrp.autosave"));
  ok(savedAfter && !savedAfter.includes("demo_god_rays"), "the AUTOSAVE no longer carries the poison");
  await page.close();

  // ══ BOOT 2: reload from the healed autosave ═════════════════════════════════
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1440, height: 900 });
  const errors2 = [];
  const pageErrors2 = [];
  page2.on("pageerror", (e) => pageErrors2.push(`pageerror: ${e.message}`));
  page2.on("console", (m) => { if (m.type() === "error" && !isNoise(m.text())) errors2.push(m.text()); });
  await page2.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), savedAfter);
  await page2.goto(base, { waitUntil: "networkidle0" });
  await page2.waitForSelector("canvas.scene", { timeout: 20000 });
  await sleep(BOOT_MS);
  await page2.screenshot({ path: resolve(shots, "03_clean_reboot.png") });

  const reboot = await page2.evaluate(() => {
    const app = window.__powerrp_app;
    return { alive: !!app, items: Object.keys(app.state().items) };
  });
  ok(reboot.alive, "the healed document boots");
  ok(!reboot.items.includes("poison"), "the healed document has no poisoned item");
  ok(reboot.items.includes("healthy"), "the healthy item survived the whole ordeal");
  ok(errors2.filter((s) => EMIT_FAILURE.test(s)).length === 0, `the reboot is CLEAN — no emit-failure report: ${JSON.stringify(errors2.filter((s) => EMIT_FAILURE.test(s)))}`);
  ok(pageErrors2.filter((s) => !isNoise(s)).length === 0, "the reboot has no uncaught error");
  await page2.close();
} finally {
  await browser.close();
  await server.close();
}

for (const [good, label] of checks) console.log(`  ${good ? "ok " : "FAIL"}  ${label}`);
console.log(`\n${checks.filter(([g]) => g).length}/${checks.length} checks passed`);
console.log(`screenshots: ${shots}`);
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
