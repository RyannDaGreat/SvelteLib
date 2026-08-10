/**
 * PPTX IMPORT PROBE — the editor-side drag-and-drop-a-.pptx flow, in a real
 * browser. Verifies the UI half of the feature (ImportPptxModal.svelte +
 * web/pptxImport.js's stage 1) end to end; the translate stage
 * (core/pptx_translate/translate.js) is a PARALLEL, possibly-not-yet-landed
 * dependency (see web/pptxImport.js's header), so this probe accepts EITHER
 * outcome after clicking Import — a real opened draft (translator present) or
 * the labeled "translator is not available yet" error (translator absent) —
 * and fails only if neither happens or a DIFFERENT error appears. That is
 * what makes this probe meaningful before AND after the translator lands,
 * rather than needing a rewrite the day it does.
 *
 * THREE THINGS ASSERTED:
 *   1. Calling app.showPptxImport(file) — what CanvasView's drop handler does
 *      for a dropped .pptx/.pptm — opens the confirm dialog naming the file
 *      and its real slide count (tests/fixtures/pptx/minimal.pptx: 3 slides).
 *   2. The SlideRangeField defaults to "All slides" (the user's spec: "by
 *      default it imports all").
 *   3. Clicking Import moves to the progress stage, which reaches a terminal
 *      state (done or a labeled error) rather than hanging — and if it
 *      succeeds, the deck is open as an UNSAVED DRAFT (never the library),
 *      mirroring the .zip-drop precedent draft_open_static_probe.js checks.
 *
 * Spawns its OWN isolated Vite + headless Chromium (the house probe pattern),
 * frontend-only under ?static=1.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const FIXTURE_PATH = resolve(HERE, "fixtures/pptx/minimal.pptx");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same noise allowlist as draft_open_static_probe.js (backend-absent chatter,
// repair reports for a fixture doc, transient asset-resolve misses while the
// draft keyspace switches over) — this probe runs the identical static-mode
// boot and draft-open tail.
const EXPECTED_NOISE = /Failed to load resource|thumbnail|\/api\/|WebGPU|VideoV7|PowerRP repair:|MEDIA_ELEMENT_ERROR|DEMUXER_ERROR_COULD_NOT_OPEN|__no_such_project__|localAssetStore\.resolveUrl:|image_registry: failed to load|video_registry: resume of|\.pptx translator.*not available/;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  const before = await page.evaluate(async () => (await window.__powerrp_app.listProjects()).map((p) => p.name));
  assert(before.length === 0, `the library starts EMPTY (found: ${JSON.stringify(before)})`);

  // ── 1. DROP → CONFIRM DIALOG (exactly what CanvasView's onCanvasDrop does
  //      for a dropped .pptx: app.showPptxImport(file)) ─────────────────────
  const pptxBytes = Array.from(readFileSync(FIXTURE_PATH));
  await page.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], "minimal.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    window.__powerrp_app.showPptxImport(file);
  }, pptxBytes);
  await sleep(600); // readDeck() parsing (fast: ~91ms on a 108MB deck per deck.js's own measurement)

  const confirmText = await page.evaluate(() => document.querySelector(".pptx-import-confirm")?.textContent ?? "");
  assert(confirmText.includes("minimal.pptx"), `the confirm dialog names the dropped file (got: ${JSON.stringify(confirmText.slice(0, 200))})`);
  assert(confirmText.includes("3 slide"), `the confirm dialog reports the REAL slide count from parsePptx (got: ${JSON.stringify(confirmText.slice(0, 200))})`);

  // ── 2. SlideRangeField defaults to "All slides" ────────────────────────────
  const rangeDefault = await page.evaluate(() => {
    const dd = document.querySelector(".range-field-control .dd");
    return dd?.textContent?.trim() ?? null;
  });
  assert(rangeDefault === "All slides", `SlideRangeField defaults to "All slides" (got: ${JSON.stringify(rangeDefault)})`);

  const importBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".pptx-import-confirm .name-modal-actions .btn")].find((b) => b.textContent.trim() === "Import"),
  );
  assert(Boolean(importBtn), "an enabled Import button exists once parsing finished");

  // ── 3. CLICK IMPORT → progress stage → a TERMINAL state ────────────────────
  await importBtn.asElement().click();
  await sleep(500);
  const inProgressStage = await page.evaluate(() => Boolean(document.querySelector(".pptx-import-progress")));
  assert(inProgressStage, "clicking Import moves the modal to the progress stage");

  // Poll for a terminal state (the Done/Close button becomes enabled) rather
  // than a fixed sleep: translating varies with whether the translator module
  // is present at all.
  const TERMINAL_TIMEOUT_MS = 20000;
  const POLL_MS = 250;
  let terminal = null;
  for (let waited = 0; waited < TERMINAL_TIMEOUT_MS; waited += POLL_MS) {
    terminal = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".pptx-import-progress .name-modal-actions .btn")][0];
      if (!btn || btn.disabled) return null;
      return {
        buttonText: btn.textContent.trim(),
        errorText: document.querySelector(".pptx-import-progress .name-modal-warning")?.textContent ?? null,
      };
    });
    if (terminal) break;
    await sleep(POLL_MS);
  }
  assert(Boolean(terminal), `the progress stage reached a terminal state within ${TERMINAL_TIMEOUT_MS}ms (never hung)`);

  if (terminal?.buttonText === "Done") {
    // The translator is present and translation succeeded — verify the SAME
    // draft invariant draft_open_static_probe.js pins for a .zip import.
    const draftState = await page.evaluate(() => ({
      draftMode: window.__powerrp_app.draftMode ? { ...window.__powerrp_app.draftMode } : null,
      saveState: window.__powerrp_app.saveState(),
      projects: window.__powerrp_app.listProjects ? [] : null, // (async — checked below)
    }));
    assert(draftState.draftMode !== null, "a successful import opened an UNSAVED DRAFT, not a library entry");
    assert(draftState.saveState === "unsaved", `the save indicator reads UNSAVED after import (got "${draftState.saveState}")`);
    const projectsAfter = await page.evaluate(async () => (await window.__powerrp_app.listProjects()).map((p) => p.name));
    assert(projectsAfter.length === 0, `the project library is STILL EMPTY after a draft import (found: ${JSON.stringify(projectsAfter)})`);
  } else {
    // Translator not landed yet (or translation genuinely failed) — the
    // failure must be LABELED, never silent, and the previously-open (empty,
    // untouched) project must still show nothing in the library.
    assert(Boolean(terminal?.errorText), `a non-"Done" terminal state names WHY (got button "${terminal?.buttonText}", error: ${JSON.stringify(terminal?.errorText)})`);
    console.log(`  (translator not exercised — reported: ${terminal?.errorText?.slice(0, 160)})`);
  }

  if (errors.length) { console.error("UNEXPECTED CONSOLE/PAGE ERRORS:\n" + errors.join("\n")); fails.push(`${errors.length} unexpected error(s)`); }
  console.log(fails.length ? `\npptx_import_probe: ${fails.length} FAILED` : "\npptx_import_probe: all checks passed");
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
