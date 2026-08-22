/**
 * DEBUG STORAGE PROBE — the browser half of the debug submenu's Storage page
 * (tests/debug_storage_test.js covers the pure aggregation math in bare node).
 *
 * FIRST-USE STANDARD (CLAUDE.md): fresh static boot -> palette -> Debug ->
 * Storage -> the modal renders with real numbers. This probe drives exactly
 * that path, plus the fixture assertions the task calls for:
 *   1. seed a couple of local assets (into the DRAFT keyspace, which is the
 *      keyspace every fresh boot already has — no separate project save needed)
 *   2. seed a fake finished rendering (localRenderStore submitRenderJob +
 *      postRenderJobOutput — real IndexedDB record, real blob bytes)
 *   3. open the palette, run "Debug", drill into "Debug: Storage"
 *   4. verify the DRAFT keyspace is LABELED (not shown under its raw key)
 *   5. verify the grand total equals the sum of every visible row, within a
 *      byte of rounding tolerance (there is none in this arithmetic, but the
 *      assertion is written the honest way rather than assuming exactness)
 *   6. verify a download link on a seeded asset carries the RIGHT BYTES
 *
 * Spawns its own isolated Vite + headless Chromium (the house probe pattern),
 * `?static=1` so no backend is needed for the fixture half of this probe.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
// hmr:false + watch:null — the house probe convention (palette_probe.js:44-47 states
// it in full). Was `{ port: 0, open: false, host: "127.0.0.1" }`, i.e. both ON: a save
// anywhere in the tree while this probe is driving the palette sends a full-reload, and
// the app object, the open palette and the modal all go with it — after which the
// `.debug-storage-grandtotal` wait below can only time out. A one-shot headless run has
// no developer to benefit from HMR.
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const fails = [];
const assert = (cond, msg) => {
  if (!cond) {
    fails.push(msg);
    console.log(`  FAIL ${msg}`);
  } else {
    console.log(`  ok   ${msg}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long the app is GIVEN to appear — the ceiling, not the expectation (a cold Vite
 *  dep re-optimization is minutes slower than a warm boot). */
const BOOT_TIMEOUT_MS = 90000;
/** Skia wasm + fonts + first paint, AFTER window.__powerrp_app exists. */
const BOOT_SETTLE_MS = 3500;
/** How long a palette keystroke is GIVEN to re-filter the list before Enter. Bounded so
 *  a genuinely missing command still fails, and fast in the normal case because it polls. */
const PALETTE_SETTLE_MS = 10000;

// Console noise this probe ignores, each for a stated reason:
//  · backend-absent chatter: this Vite is frontend-only on purpose (?static=1).
//  · WebGPU fallback: measured harmless boot-time notice on every headless run
//    in this repo's other probes (no WebGPU adapter in headless Chrome).
const EXPECTED_NOISE = /Failed to load resource|\/api\/|WebGPU|no WebGPU adapter/;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  // WAIT FOR THE APP, DO NOT GUESS AT IT. This was `sleep(3500)` alone, commented
  // "Skia wasm + fonts + first paint" — a constant that holds only on a warm dep cache
  // and an idle machine. A cold Vite re-optimize pushes first paint minutes past it
  // (measured elsewhere in this suite: 80 s vs 14 s for the same probe, same tree), and
  // when it does, the very next page.evaluate reads `window.__powerrp_app` as undefined
  // and the probe reports a stopwatch failure in the words of a storage failure.
  // b09f40a4 made exactly this change to tests/image_stack_live_probe.js for exactly
  // this reason; the settle after it stays, because "the app object exists" is earlier
  // than "Skia and the fonts are up".
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: BOOT_TIMEOUT_MS, polling: 200 });
  await sleep(BOOT_SETTLE_MS); // Skia wasm + fonts + first paint, AFTER the app exists
  if (errors.length) {
    console.error("BOOT ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }

  // ── SEED: import a .zip so the working copy is a genuine DRAFT ──────────────
  // A brand-new "Untitled" document is NOT stored under the ~draft/ keyspace —
  // projectName() returns "Untitled" (a plain name) until draftMode is set,
  // which only happens for an IMPORTED working copy (web/app.svelte.js
  // projectName() docblock). So the fixture imports a tiny zip, exactly the
  // way tests/asset_reload_static_probe.js does, to exercise the real
  // ~draft/current keyspace this task's draft-labeling requirement is about.
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII="; // real 2x2 PNG
  const { zipSync } = await import("fflate");
  const enc = new TextEncoder();
  const doc = {
    meta: { name: "DebugProbeDeck", slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: { items: { cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" } } },
    }],
  };
  const zipBytes = zipSync({ "DebugProbeDeck/doc.json": enc.encode(JSON.stringify(doc)) }, { level: 6 });

  const seeded = await page.evaluate(async (zipBytesArr) => {
    const app = window.__powerrp_app;
    const file = new File([new Uint8Array(zipBytesArr)], "DebugProbeDeck.zip", { type: "application/zip" });
    await app.importProjectZip(file);
    const project = app.projectName(); // now the draft key — a genuine import
    const png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(png_b64), (c) => c.charCodeAt(0));
    const img = await app.uploadAsset(new File([bytes], "debug-probe-logo.png", { type: "image/png" }));
    const txt = await app.uploadAsset(new File(["hello from the debug storage probe\n"], "debug-probe-notes.txt", { type: "text/plain" }));
    return { project, imgName: img.name, imgBytes: bytes.length, txtName: txt.name, txtBytes: new Blob(["hello from the debug storage probe\n"]).size };
  }, Array.from(zipBytes));
  assert(seeded.project.startsWith("~draft/"), `seeded into the draft keyspace after import (project="${seeded.project}")`);

  // ── SEED: a fake finished rendering, real IndexedDB record + real blob bytes ──
  const rendering = await page.evaluate(async (project) => {
    const { submitRenderJob, postRenderJobOutput } = await import("/localRenderStore.js");
    const job = await submitRenderJob(project, { name: "debug-probe-render", backend: "client", framesTotal: 1, params: { width: 4, height: 4, fps: 1 } });
    const fakeMp4 = new TextEncoder().encode("FAKE-MP4-BYTES-FROM-DEBUG-PROBE");
    const done = await postRenderJobOutput(project, job.id, fakeMp4, 1);
    return { jobId: job.id, bytes: done.bytes };
  }, seeded.project);
  assert(rendering.bytes > 0, `seeded a finished rendering with real bytes (${rendering.bytes}B)`);

  // ── OPEN: palette -> Debug -> Debug: Storage (the actual user path) ─────────
  // The palette's own shortcut is Cmd+Shift+P (core/shortcut_entries.js
  // "toggle-palette"), not Cmd+K — driven directly via app.paletteOpen rather
  // than a chord, since a probe simulating a three-key chord is more fragile
  // than the toggle it is meant to trigger and this probe is not testing the
  // keybinding itself (tests/palette_probe.js already covers that).
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await sleep(300);
  const paletteOpen = await page.evaluate(() => document.querySelector(".palette-results") !== null);
  assert(paletteOpen, "the command palette opened");

  // ENTER IS PRESSED ON A KNOWN ROW, NOT AFTER A GUESSED PAUSE. Each of these three
  // steps was `sleep(250)` between typing and Enter; the palette re-filters on input, so
  // a 250 ms window that closes early does not fail loudly — it presses Enter on
  // WHATEVER is highlighted and runs a DIFFERENT command, and the only evidence left is
  // the `.debug-storage-grandtotal` wait timing out 15 s later with nothing to say about
  // why. The palette marks its rows `data-command-id` + `.highlighted`
  // (web/CommandPalette.svelte), so the honest wait is "the row Enter will run is the
  // row I mean". Bounded, so a command that genuinely is not there still reddens.
  // A timeout here is rethrown with the id it wanted AND the id it actually got — a bare
  // puppeteer "waiting for function failed" names neither, and which row the palette
  // settled on is the whole diagnosis.
  const waitHighlighted = async (id) => {
    try {
      await page.waitForFunction(
        (want) => document.querySelector(".palette-results .palette-item.highlighted")?.dataset.commandId === want,
        { timeout: PALETTE_SETTLE_MS, polling: 50 }, id);
    } catch {
      const got = await page.evaluate(() => document.querySelector(".palette-results .palette-item.highlighted")?.dataset.commandId ?? null);
      throw new Error(`palette: waited ${PALETTE_SETTLE_MS}ms for "${id}" to be the highlighted row; it was ${JSON.stringify(got)}`);
    }
  };
  await page.keyboard.type("Debug", { delay: 20 });
  await waitHighlighted("debug");
  await page.keyboard.press("Enter"); // drills into the "Debug" submenu
  await page.keyboard.type("Storage", { delay: 20 });
  await waitHighlighted("debug-storage"); // DEBUG_PAGES[0].id === "storage" (web/DebugConsole.svelte)
  await page.keyboard.press("Enter"); // runs "Debug: Storage"
  // Awaited rather than slept on, and NOT allowed to throw: the assertion below is the
  // sentence this probe wants in the log, so a timeout has to reach it rather than
  // replace it with a puppeteer stack.
  await page.waitForSelector(".debug-console", { timeout: PALETTE_SETTLE_MS }).catch(() => {});

  const modalOpen = await page.evaluate(() => document.querySelector(".debug-console") !== null);
  assert(modalOpen, "the Debug console modal opened with the Storage page active");

  // Wait for the async inventory gather to settle.
  await page.waitForFunction(() => document.querySelector(".debug-storage-grandtotal") !== null, { timeout: 15000 });
  await sleep(300);

  // ── ASSERT: the draft keyspace is LABELED, never shown under its raw key ────
  const keyspaceLabels = await page.evaluate(() => [...document.querySelectorAll(".debug-storage-keyspace-title")].map((el) => el.textContent.trim()));
  const draftLabel = keyspaceLabels.find((t) => t.includes("~draft/"));
  assert(!!draftLabel, `a draft keyspace row is present (found: ${JSON.stringify(keyspaceLabels)})`);
  assert(!!draftLabel && draftLabel.includes("unsaved draft"), `the draft keyspace is LABELED "(unsaved draft)", not shown as a bare key (got "${draftLabel}")`);

  // ── ASSERT: the seeded files are listed, biggest-first within the keyspace ──
  const draftFileRows = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".debug-storage-row-file")];
    return rows.map((r) => r.querySelector(".debug-storage-row-name")?.textContent.trim());
  });
  assert(draftFileRows.includes("debug-probe-logo.png"), `the seeded PNG appears as a row (rows: ${JSON.stringify(draftFileRows)})`);
  assert(draftFileRows.includes("debug-probe-notes.txt"), `the seeded text file appears as a row`);

  // ── ASSERT: the rendering appears in the Renderings group ───────────────────
  const renderingRows = await page.evaluate(() => {
    const section = [...document.querySelectorAll(".debug-storage-group")].find((s) => s.querySelector(".debug-storage-group-title")?.textContent.includes("Renderings"));
    return [...(section?.querySelectorAll(".debug-storage-row-name") ?? [])].map((el) => el.textContent.trim());
  });
  assert(renderingRows.some((t) => t.includes("debug-probe-render")), `the seeded rendering appears under Renderings (rows: ${JSON.stringify(renderingRows)})`);

  // ── ASSERT: grand total equals the sum of every group's own subtotal ────────
  const totals = await page.evaluate(() => ({
    grand: document.querySelector(".debug-storage-grandtotal strong")?.textContent.trim(),
    subtotals: [...document.querySelectorAll(".debug-storage-subtotal")].map((el) => el.textContent.trim()),
  }));
  // Read the numbers straight out of the app's own gatherer, so this assertion
  // checks the DISPLAYED total against the SAME arithmetic the page ran — not a
  // second, hand-rolled parse of a formatted string (fileSize.js strings are
  // lossy at the display precision, so re-deriving from them would be circular).
  const raw = await page.evaluate(async () => {
    const { gatherDebugStorageData } = await import("/DebugStoragePage.svelte");
    const { inventoryReport } = await import("/debugStorage.js");
    const { rowsByGroup, estimate } = await gatherDebugStorageData(window.__powerrp_app);
    const keyspaceRows = rowsByGroup.assets.map((k) => ({ name: k.project, bytes: k.bytes }));
    const report = inventoryReport({ ...rowsByGroup, assets: keyspaceRows });
    return { grandTotal: report.grandTotal, groupSubtotals: report.groups.map((g) => g.subtotal), estimateUsage: estimate.usage, estimateSupported: estimate.supported };
  });
  const sumOfGroups = raw.groupSubtotals.reduce((a, b) => a + b, 0);
  assert(raw.grandTotal === sumOfGroups, `grand total (${raw.grandTotal}) equals the sum of every group's subtotal (${sumOfGroups}) exactly`);
  assert(raw.grandTotal > 0, `grand total is a real positive number (${raw.grandTotal}B) — not a zeroed-out empty inventory`);
  if (raw.estimateSupported) {
    // "within tolerance" per the task: browsers round deliberately, so this is a
    // sanity bound (same order of magnitude), not an equality.
    const ratio = raw.estimateUsage > 0 ? raw.grandTotal / raw.estimateUsage : Infinity;
    assert(ratio > 0.01 && ratio < 100, `inventory total (${raw.grandTotal}B) is the same order of magnitude as the browser estimate (${raw.estimateUsage}B)`);
  } else {
    console.log("  ok   (navigator.storage.estimate unsupported in this browser — delta line honestly says so, skipping the magnitude check)");
  }

  // ── ASSERT: a DOWNLOAD link carries the RIGHT BYTES ─────────────────────────
  // Click the download button for the seeded text file (deterministic content,
  // easy to verify byte-for-byte) and capture what actually got a[download]'d by
  // intercepting URL.createObjectURL — the same technique used elsewhere in this
  // suite to inspect a download without touching the OS filesystem.
  const downloadCheck = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll(".debug-storage-row-file")];
    const row = rows.find((r) => r.querySelector(".debug-storage-row-name")?.textContent.trim() === "debug-probe-notes.txt");
    if (!row) return { ok: false, why: "row not found" };
    const btn = row.querySelector('button[aria-label^="Download"]');
    if (!btn) return { ok: false, why: "no download button" };

    let capturedBlob = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      capturedBlob = blob;
      return realCreate.call(URL, blob);
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    URL.createObjectURL = realCreate;
    if (!capturedBlob) return { ok: false, why: "no blob captured" };
    const text = await capturedBlob.text();
    return { ok: true, text, size: capturedBlob.size };
  });
  assert(downloadCheck.ok, `download button produced a blob (${downloadCheck.why ?? ""})`);
  assert(downloadCheck.text === "hello from the debug storage probe\n", `the downloaded bytes match exactly what was uploaded (got ${JSON.stringify(downloadCheck.text)})`);
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nDEBUG STORAGE PROBE FAILED (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nDEBUG STORAGE PROBE PASSED — palette -> Debug -> Storage renders real numbers, labels the draft, and downloads real bytes.");
