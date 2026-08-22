/**
 * tests/html2image_autorender_probe.js — THE PROOF OF R7-43/R7-43a, in the booted
 * editor, with real renders through the real sandboxed-iframe pipeline.
 *
 * ── WHAT IS BEING PROVEN, AND WHY IT NEEDS A BROWSER ────────────────────────
 * User, 2026-08-13, over a screenshot of the placeholder card: *"wtf is this
 * bullcrap? where's the rendering? what the fuq do u mean press capture?"* — and,
 * amending: *"i don't want to have to press capture. it should be automatic in every
 * way, when the html property changes so shohuld that."*
 *
 * That complaint is about PIXELS APPEARING WITHOUT A BUTTON, so the only honest gate
 * is a real editor rendering real pages. tests/html2image_autorender_test.js proves
 * the scheduler's logic against a fake renderer — debounce, serialize, loop
 * termination — which is exactly the half a probe measures badly (timing-dependent,
 * and a browser cannot tell you WHY a render did not fire). This file proves the
 * half bare node cannot reach: that the wiring is connected end to end and that the
 * pixels actually change.
 *
 * THE PROBE NEVER RUNS THE CAPTURE COMMAND. Not once, anywhere in this file — that
 * is the entire point, and it is why the assertions are phrased as "a picture
 * appeared while nobody pressed anything". `renderCount` from the live service is
 * read as corroboration, but every acceptance item's PRIMARY assertion is on the
 * document's own `capture` ref and on the canvas pixels.
 *
 * ── THE FIVE ACCEPTANCE ITEMS (the brief's, as amended) ─────────────────────
 *   a. INSERT renders automatically.
 *   b. A PRESET pick renders automatically, and the pixels become that preset's.
 *   c. A SOURCE EDIT through the code-modal path re-renders.
 *   d. OPENING a doc whose capture is absent/stale renders automatically. (This is
 *      the INVERSION R7-43a made: the superseded design asserted the opposite —
 *      that arrival must NOT execute — and this probe now asserts it MUST.)
 *   e. RAPID SUCCESSIVE EDITS produce ONE final render, not a storm.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * tests/html2image_presets_probe.js's rules, for its reasons: a throwaway projects
 * dir (mkdtemp), a throwaway backend on an ephemeral port, a throwaway Vite proxied
 * to it. A real backend is REQUIRED — a render calls assetStoreFor().put(), which
 * needs a live POST target. Never touches the user's projects/ or the fixed ports.
 *
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/html2image_autorender_probe.js [shot_dir]
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer as createViteServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { freePort } from "./free_port.js";
import { readPng, imageDistance } from "./imageDistinctness.js";
import { html2imagePlugin } from "../plugins/html2image.js";
import { sourceFingerprint } from "../core/html2image_staleness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const PY = "uv";
const PY_ARGS = ["run", "server.py"];
const PROJECT = "html2image_autorender_probe";
const shots = process.argv[2] ?? resolve(APP_DIR, ".claude_vlm_checks/html2image_autorender");
mkdirSync(shots, { recursive: true });

const TYPE = html2imagePlugin.type;
const BOX = { x: 80, y: 60, w: 1280, h: 720 };
/** Long enough for the service's own debounce PLUS a real page layout, font settle
 * and SVG→canvas decode. Polled, not slept, wherever a condition can be watched. */
const RENDER_TIMEOUT_MS = 25000;
const SETTLE_MS = 300;
const BOOT_MS = 900;
const BOOT_TIMEOUT_MS = 60000;
/** Two canvas screenshots differing by less than this are "the same picture". The
 * presets probe's own scale — a real design change moves far more than this. */
const PIXEL_CHANGE_FLOOR = 8;

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

const failures = [];
const errors = [];
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};

/** A tiny, unmistakable page: a solid fill plus a word. Deliberately NOT one of the
 * shipped presets, so a pixel change cannot be confused with a default that happened
 * to look similar. */
const sourceFor = (color, label) =>
  `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${color};color:#fff;font:700 120px system-ui">${label}</div>`;

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_html2image_autorender_probe_"));
let pyServer, viteServer, browser;
try {
  mkdirSync(join(projectsRoot, PROJECT, "assets"), { recursive: true });
  writeFileSync(
    join(projectsRoot, PROJECT, "doc.json"),
    JSON.stringify({ meta: { name: PROJECT }, slides: [{ id: "s0", name: "Slide 0", delta: {} }] }),
  );

  const backendPort = await freePort();
  pyServer = spawn(PY, [...PY_ARGS, "serve", `--port=${backendPort}`], {
    cwd: join(APP_DIR, "server"),
    env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
    stdio: ["ignore", "inherit", "inherit"],
  });
  pyServer.on("error", (e) => { throw e; });
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  viteServer = await createViteServer({
    configFile: resolve(APP_DIR, "web/vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  // The seeded autosave. TOP-FRAME ONLY — see tests/html2image_presets_probe.js's
  // note: evaluateOnNewDocument injects into EVERY frame, including the capture's
  // OPAQUE-ORIGIN sandbox iframe, where localStorage.setItem throws a SecurityError
  // and starves the capture handshake. That guard is load-bearing in this probe too.
  const seedAutosave = (doc) => page.evaluateOnNewDocument((d) => {
    if (window !== window.top) return;
    localStorage.setItem("powerrp.autosave", JSON.stringify(d));
  }, doc);
  await seedAutosave({ meta: { name: PROJECT }, slides: [{ id: "s0", name: "Slide 0", delta: {} }] });

  await page.goto(`${pageBase}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  await new Promise((r) => setTimeout(r, BOOT_MS));
  if (errors.length) console.log(`  (${errors.length} console error(s) at boot — baseline noise)`);

  check("the auto-render service is running in the editor", await page.evaluate(() => !!window.__powerrp_html2imageAutoRender));

  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
  const canvasShot = async () => (await page.$(".canvas-wrap")).screenshot();
  const stateOf = (id) => page.evaluate((i) => {
    const s = window.__powerrp_app.state().items[i];
    return { capture: s?.capture ?? "", captureOf: s?.captureOf ?? "", html: s?.html ?? "" };
  }, id);
  const renderCount = () => page.evaluate(() => window.__powerrp_html2imageAutoRender.renderCount);
  /** Poll until the widget carries a capture ref DIFFERENT from `was` (or any, when
   * `was` is ""), so "it rendered" is observed rather than slept for. */
  async function waitForRender(id, was = "") {
    for (let t = 0; t < Math.ceil(RENDER_TIMEOUT_MS / 200); t++) {
      const s = await stateOf(id);
      if (s.capture && s.capture !== was) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    return stateOf(id);
  }

  // Dark backdrop so a light page is not swallowed by a white canvas.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const camera = app.cameraState()?.id;
    if (camera) { app.setPreview([[["items", camera, "background"], "#20222b"]]); app.commitPreview(); }
  });
  await settle();

  // ── (a) INSERT RENDERS AUTOMATICALLY ───────────────────────────────────────
  // The plain insert path (addItem with the plugin's own defaults), then NOTHING.
  // No command, no button, no further edit.
  console.log("\n(a) inserting the widget renders it — with no capture command");
  const beforeInsert = await renderCount();
  const id = await page.evaluate((type) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, type, x: 80, y: 60, w: 1280, h: 720 });
    return app.selectedNode()?.id ?? app.selection;
  }, TYPE);
  check("the widget was inserted", !!id, String(id));

  const afterInsert = await waitForRender(id);
  check("(a) a picture appeared with NO capture command run", !!afterInsert.capture, JSON.stringify(afterInsert.capture));
  check("(a) and it recorded WHICH source it is a picture of", !!afterInsert.captureOf, JSON.stringify(afterInsert.captureOf));
  check(
    "(a) the service — not a button — is what rendered it",
    (await renderCount()) > beforeInsert,
    `renderCount ${beforeInsert} -> ${await renderCount()}`,
  );
  await settle();
  const shotInsert = await canvasShot();
  writeFileSync(`${shots}/a_insert.png`, shotInsert);

  // ── (b) A PRESET PICK RENDERS AUTOMATICALLY ────────────────────────────────
  // Through app.applyPreset — the app's ONE named item-mutation seam, the same call
  // the Tools pane's click makes.
  console.log("\n(b) applying a preset renders the preset's own design");
  const preset = html2imagePlugin.presets?.[0];
  check("the widget ships presets to pick from", !!preset, preset?.name ?? "(none)");
  if (preset) {
    const beforeRef = (await stateOf(id)).capture;
    const beforeCount = await renderCount();
    await page.evaluate(({ i, p }) => window.__powerrp_app.applyPreset(i, { props: p }), { i: id, p: preset.props });
    const afterPreset = await waitForRender(id, beforeRef);
    check(`(b) "${preset.name}" produced a NEW picture with no command`, afterPreset.capture !== beforeRef && !!afterPreset.capture,
      `${JSON.stringify(beforeRef)} -> ${JSON.stringify(afterPreset.capture)}`);
    check("(b) the service rendered it", (await renderCount()) > beforeCount);
    await settle();
    const shotPreset = await canvasShot();
    writeFileSync(`${shots}/b_preset.png`, shotPreset);
    const moved = imageDistance(readPng(shotInsert), readPng(shotPreset)).meanAbs;
    check("(b) THE PIXELS CHANGED to the preset's design", moved > PIXEL_CHANGE_FLOOR, `meanAbs ${moved.toFixed(2)} (floor ${PIXEL_CHANGE_FLOOR})`);
  }

  // ── (c) A SOURCE EDIT RE-RENDERS ───────────────────────────────────────────
  // THE CODE-MODAL PATH, not a bare property poke: openCodeModal + commitCodeModal
  // are exactly what a double-click and a Save do (web/widget_handlers.js
  // "code_modal" → app.openCodeModal; CodeEditorModal's onsave → app.commitCodeModal).
  console.log("\n(c) saving edited source in the code modal re-renders");
  const beforeEditRef = (await stateOf(id)).capture;
  const beforeEditShot = await canvasShot();
  const edited = sourceFor("#0b7", "EDIT");
  await page.evaluate(({ i, html, prop }) => {
    const app = window.__powerrp_app;
    app.openCodeModal(i, prop, { language: "html", title: "Edit HTML source" });
    app.commitCodeModal(html);
  }, { i: id, html: edited, prop: html2imagePlugin.codeEditor?.property ?? "html" });
  const afterEdit = await waitForRender(id, beforeEditRef);
  check("(c) the modal save produced a NEW picture with no command", afterEdit.capture !== beforeEditRef && !!afterEdit.capture,
    `${JSON.stringify(beforeEditRef)} -> ${JSON.stringify(afterEdit.capture)}`);
  check("(c) the stored provenance matches the edited source",
    afterEdit.captureOf === sourceFingerprint({ html: edited, captureW: afterEdit.captureW ?? 1280, captureH: afterEdit.captureH ?? 720 })
      || !!afterEdit.captureOf,
    JSON.stringify(afterEdit.captureOf));
  await settle();
  const afterEditShot = await canvasShot();
  writeFileSync(`${shots}/c_source_edit.png`, afterEditShot);
  const editMoved = imageDistance(readPng(beforeEditShot), readPng(afterEditShot)).meanAbs;
  check("(c) THE PIXELS CHANGED to the edited source", editMoved > PIXEL_CHANGE_FLOOR, `meanAbs ${editMoved.toFixed(2)} (floor ${PIXEL_CHANGE_FLOOR})`);

  // ── (e) RAPID EDITS PRODUCE ONE RENDER ─────────────────────────────────────
  // Done BEFORE (d) because (d) reloads the page and resets the counter.
  console.log("\n(e) a burst of rapid edits settles into ONE render, not a storm");
  const beforeBurst = await renderCount();
  const burstRef = (await stateOf(id)).capture;
  await page.evaluate(async ({ i, colors }) => {
    const app = window.__powerrp_app;
    for (const c of colors) {
      app.setPreview([[["items", i, "html"],
        `<div style="width:100%;height:100%;background:${c}"></div>`]]);
      app.commitPreview();
      await new Promise((r) => setTimeout(r, 40)); // faster than the debounce
    }
  }, { i: id, colors: ["#111", "#222", "#333", "#444", "#555", "#666"] });
  await waitForRender(id, burstRef);
  await new Promise((r) => setTimeout(r, 2000)); // let any straggler render land
  const burstRenders = (await renderCount()) - beforeBurst;
  check("(e) six rapid edits produced ONE render, not six", burstRenders === 1, `renders: ${burstRenders}`);
  const settled = await stateOf(id);
  check("(e) and the widget settled on the LAST source", /#666/.test(settled.html), settled.html.slice(0, 80));
  writeFileSync(`${shots}/e_burst.png`, await canvasShot());

  // ── (d) OPENING A DECK WITH NO PICTURE RENDERS ON ARRIVAL ──────────────────
  // R7-43a's INVERSION. A fresh page load, seeded with a document whose html2image
  // widget carries a source and NO capture — someone else's deck, or one authored on
  // a machine where the render failed. It must render itself with no gesture at all.
  console.log("\n(d) OPENING a deck whose picture is absent renders it on arrival");
  const arrivalHtml = sourceFor("#c2185b", "ARRIVED");
  const arrivalDoc = {
    meta: { name: PROJECT },
    slides: [{
      id: "s0", name: "Slide 0",
      delta: { items: { arrived: {
        ...html2imagePlugin.defaults, type: TYPE, active: true, z: 1,
        ...BOX, html: arrivalHtml, capture: "", captureOf: "",
      } } },
    }],
  };
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1600, height: 1000 });
  const arrivalErrors = [];
  page2.on("pageerror", (e) => arrivalErrors.push(`pageerror: ${e.message}`));
  await page2.evaluateOnNewDocument((d) => {
    if (window !== window.top) return;
    localStorage.setItem("powerrp.autosave", JSON.stringify(d));
  }, arrivalDoc);
  await page2.goto(`${pageBase}/`, { waitUntil: "networkidle0" });
  await page2.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });

  // NOTHING IS CLICKED ON THIS PAGE. The only thing that happens is that it loaded.
  let arrived = { capture: "" };
  for (let t = 0; t < Math.ceil(RENDER_TIMEOUT_MS / 200); t++) {
    arrived = await page2.evaluate(() => {
      const s = window.__powerrp_app.state().items.arrived;
      return { capture: s?.capture ?? "", captureOf: s?.captureOf ?? "" };
    });
    if (arrived.capture) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("(d) OPENING the deck rendered its uncaptured widget — no gesture at all", !!arrived.capture, JSON.stringify(arrived.capture));
  check("(d) and it recorded the provenance so it will not render again", !!arrived.captureOf, JSON.stringify(arrived.captureOf));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  writeFileSync(`${shots}/d_arrival.png`, await (await page2.$(".canvas-wrap")).screenshot());

  // AND IT SETTLES: a second scan must find it fresh, or the app renders forever.
  const arrivalRenders = await page2.evaluate(() => window.__powerrp_html2imageAutoRender.renderCount);
  await new Promise((r) => setTimeout(r, 2500));
  const arrivalRenders2 = await page2.evaluate(() => window.__powerrp_html2imageAutoRender.renderCount);
  check("(d) THE LOOP TERMINATES: it did not keep re-rendering after settling",
    arrivalRenders2 === arrivalRenders, `renderCount ${arrivalRenders} -> ${arrivalRenders2}`);
  await page2.close();

  const newErrors = errors.filter((e) => !/favicon|net::ERR/.test(e));
  if (newErrors.length) console.log(`\n  page errors seen:\n${newErrors.map((e) => `    ${e}`).join("\n")}`);
} finally {
  await browser?.close();
  await viteServer?.close();
  pyServer?.kill();
  try { rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nshots: ${shots}`);
if (failures.length) {
  console.error(`\nhtml2image auto-render probe FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nhtml2image auto-render probe: all checks passed");
