/**
 * CODE-MODAL probe (ROUND 2 #32/#33/#34/#35): boot the PowerRP editor headless,
 * add a Mermaid widget through the app seam, and exercise the reusable Monaco
 * code editor end-to-end — the seam every ?cli=1 render probe structurally cannot
 * reach (they never mount the app shell, let alone Monaco). Asserts:
 *   #32 double-clicking the diagram opens a ~90vw×90vh modal with a real Monaco
 *       editor showing the diagram source;
 *   #32 typing a new source and Saving commits ONE undo unit and closes the modal;
 *   #32 Escape closes WITHOUT committing;
 *   #35 the Inspector "</>" action row opens the SAME modal (edit-code-source);
 *   #34 a Demo preset applies (writes `definition`) as one undo unit, and the
 *       plugin exposes a "Demo presets" tool group of every documented example.
 * It ALSO writes vision-check PNGs: the open modal, and a contact sheet of 6
 * demo presets rendered on the canvas (mermaid_presets_*).
 *
 * Svelte-5 proxy TRAP (recorded to memory): NEVER return a doc/state object raw
 * from page.evaluate — JSON.stringify IN PAGE, parse node-side.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/code_modal_probe.js
 */
import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { mermaidPlugin, MERMAID_DEMO_PRESETS } from "../plugins/mermaid.js";
import { toolGroupsOf } from "../core/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
await mkdir(vlmDir, { recursive: true });

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Known demo-fixture + software-renderer boot noise (the colorfield/material probe
// allowlist) plus Monaco's worker/CSP chatter, which is not this suite's to own.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i, /monaco/i, /worker/i, /Could not create web worker/i,
  // The pie/quadrant demo presets contain elliptic arcs; mermaid_vector cannot
  // flatten an "A" arc to PDF-safe vector, so it rasterizes and REPORTS that
  // loudly (the documented hybrid-rule fallback — a real diagram still draws).
  /mermaid_vector.*could not be baked/i, /transformPathD.*unsupported/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// ── #34 node-side structure: the plugin exposes a "Demo presets" group of every
// documented example. Read off the registry so it grows with MERMAID_DEMO_PRESETS.
const groups = toolGroupsOf(mermaidPlugin);
const demoGroup = groups.find((g) => g.id === "presets.demos");
ok(demoGroup, "#34 mermaid exposes a 'presets.demos' tool group");
ok(demoGroup?.title === "Demo presets", "#34 the group is titled 'Demo presets'");
ok(demoGroup?.rows.length === MERMAID_DEMO_PRESETS.length && MERMAID_DEMO_PRESETS.length >= 10,
   `#34 the group carries all ${MERMAID_DEMO_PRESETS.length} demo presets (>=10)`);

// The 6 presets rendered for the vision contact sheet — the ones that render on
// the widget's htmlLabels:false native-SVG-text path.
const SHEET_PRESETS = ["Flowchart", "Sequence", "Class", "State", "Entity Relationship", "Pie"]
  .map((name) => MERMAID_DEMO_PRESETS.find((p) => p.name === name));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(700);
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here, ANY non-noise console error fails the probe

  // ── Add a Mermaid widget FILLING the camera, so a double-click at the overlay
  //    centre is guaranteed to land on it regardless of pan/zoom. ────────────────
  const added = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const cam = app.cameraState().state;
    const defs = app.registry.get("mermaid").defaults;
    app.addItem({ ...defs, x: cam.x, y: cam.y, w: cam.w, h: cam.h });
    const id = app.selection;
    return JSON.stringify({ id, def: app.state().items[id].definition });
  }));
  ok(added.id, "added a mermaid widget via the app seam");
  ok(added.def && added.def.startsWith("flowchart"), "the fresh mermaid carries the default flowchart definition");
  await sleep(300);

  // ── #32 DOUBLE-CLICK opens the modal ─────────────────────────────────────────
  await page.evaluate(() => {
    const svg = document.querySelector(".render-area svg"); // overlayEl (ondblclick)
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // A BARE dblclick — dispatching pointerdown first could start a canvas drag,
    // which onDblClick guards against (it early-returns mid-gesture).
    svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: cx, clientY: cy, view: window }));
  });
  await sleep(600);

  const opened = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    const panel = document.querySelector(".modal-panel:has(.code-modal-root)");
    const pr = panel?.getBoundingClientRect();
    return JSON.stringify({
      codeModal: app.codeModal ? { property: app.codeModal.property, language: app.codeModal.language } : null,
      hasPanel: !!panel,
      panelW: pr?.width ?? 0, panelH: pr?.height ?? 0, winW: window.innerWidth, winH: window.innerHeight,
      hasMonaco: !!document.querySelector(".code-modal-root .monaco-editor"),
      seamValue: window.__powerrp_codeModal?.getValue() ?? null,
    });
  }));
  ok(opened.codeModal?.property === "definition", "#32 double-click set app.codeModal on the definition property");
  ok(opened.codeModal?.language === "mermaid", "#32 the modal opened with the mermaid language");
  ok(opened.hasPanel && opened.hasMonaco, "#32 a Monaco editor is mounted inside the modal panel");
  ok(opened.panelW / opened.winW > 0.85 && opened.panelH / opened.winH > 0.85,
     `#32 the panel is ~90vw×90vh (got ${Math.round(opened.panelW)}×${Math.round(opened.panelH)} of ${opened.winW}×${opened.winH})`);
  ok(opened.seamValue === added.def, "#32 Monaco shows the diagram source");

  // VISION: the open modal.
  await page.screenshot({ path: resolve(vlmDir, "code_modal_open.png") });

  // ── #32 TYPE a change + SAVE → one undo unit, modal closes ───────────────────
  const NEW_DEF = "flowchart LR\n  X[Changed] --> Y[By probe]";
  const saved = JSON.parse(await page.evaluate((v) => {
    window.__powerrp_codeModal.setValue(v);
    window.__powerrp_codeModal.save();
    const app = window.__powerrp_app;
    const id = app.selection;
    return JSON.stringify({ closed: app.codeModal === null, def: app.state().items[id].definition, canUndo: app.undoLog.canUndo });
  }, NEW_DEF));
  ok(saved.closed, "#32 Save closed the modal");
  ok(saved.def === NEW_DEF, "#32 Save wrote the new definition to the document");

  const afterUndo = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.undo(); // ONE step must revert exactly the code edit
    return JSON.stringify({ def: app.state().items[app.selection].definition });
  }));
  ok(afterUndo.def === added.def, "#32 one undo reverts the edit exactly (Save was ONE undo unit)");
  await page.evaluate(() => window.__powerrp_app.redo()); // restore NEW_DEF for the next steps
  await sleep(150);

  // ── #35 the Inspector "</>" action row opens the SAME modal ──────────────────
  const btnOpened = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = app.selection; // ensure Inspector reflects the mermaid
    const btns = [...document.querySelectorAll(".inspector button")];
    const btn = btns.find((b) => /code editor/i.test(b.textContent || ""));
    if (btn) btn.click();
    return JSON.stringify({ hadButton: !!btn, open: app.codeModal?.property ?? null });
  }));
  ok(btnOpened.hadButton, "#35 the mermaid Inspector shows the 'Edit in code editor' button");
  ok(btnOpened.open === "definition", "#35 clicking the code button opens the modal on the definition");
  await sleep(400);

  // ── #32 ESCAPE closes WITHOUT committing ─────────────────────────────────────
  const escaped = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    const before = app.state().items[app.selection].definition;
    window.__powerrp_codeModal.setValue("flowchart TD\n  SHOULD --> NOT_COMMIT");
    const panel = document.querySelector(".modal-panel:has(.code-modal-root)");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return JSON.stringify({ closed: app.codeModal === null, def: app.state().items[app.selection].definition, before });
  }));
  ok(escaped.closed, "#32 Escape closed the modal");
  ok(escaped.def === escaped.before, "#32 Escape did NOT commit the typed change");

  // ── #34 a Demo preset applies as one undo unit ───────────────────────────────
  const presetApplied = JSON.parse(await page.evaluate((preset) => {
    const app = window.__powerrp_app;
    const before = app.state().items[app.selection].definition;
    app.applyPreset(app.selection, preset);
    const after = app.state().items[app.selection].definition;
    app.undo();
    const reverted = app.state().items[app.selection].definition;
    app.redo();
    return JSON.stringify({ before, after, reverted });
  }, MERMAID_DEMO_PRESETS.find((p) => p.name === "Sequence")));
  ok(presetApplied.after === MERMAID_DEMO_PRESETS.find((p) => p.name === "Sequence").props.definition,
     "#34 applying a demo preset writes its definition");
  ok(presetApplied.reverted === presetApplied.before, "#34 a demo preset apply is ONE undo unit");

  // ── #34 VISION: render 6 presets, screenshot each (contact sheet inputs) ──────
  for (const preset of SHEET_PRESETS) {
    await page.evaluate((p) => window.__powerrp_app.applyPreset(window.__powerrp_app.selection, p), preset);
    await sleep(1800); // let Mermaid lay out + raster + repaint
    const area = await page.$(".render-area");
    const safeName = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    await area.screenshot({ path: resolve(vlmDir, `mermaid_presets_${safeName}.png`) });
  }

  const realErrors = errors.filter((e) => !isBootNoise(e));
  if (realErrors.length) { console.error("CONSOLE/PAGE ERRORS:\n" + realErrors.join("\n")); }
  const failed = checks.filter(([c]) => !c);
  for (const [c, label] of checks) console.log(`  ${c ? "ok " : "FAIL"} ${label}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} code-modal checks passed`);
  if (failed.length || realErrors.length) process.exit(1);
} finally {
  await browser.close();
  await server.close();
}
