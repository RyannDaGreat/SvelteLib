/**
 * FILE BROWSER — PREVIEW AND REVEAL (R6-19.3 / .5 / .6).
 *
 * tests/file_browser_probe.js covers navigation, honesty and download. This is
 * the OTHER half of R6-19 — the four things that shipped unfinished with it, each
 * of which is invisible to that probe because each is about what a row SHOWS or
 * where another pane can SEND you:
 *
 *   1. R6-19.3 — A ROW DRAWS THE FILE. `entryPresentation` was imported and only
 *      its `.icon` read; that field is null for exactly the two kinds that HAVE a
 *      picture, so an image and a video were the only rows rendered as a generic
 *      `mdi:file-outline`. Asserted by finding a real <img> in the seeded PNG's row.
 *
 *   2. THE CSV DEFECT — a `data` preview used to be `previewOfBlob`'s 4096-byte
 *      peek handed straight to CsvTable. A cut at a byte boundary lands MID-LINE,
 *      so the last row was mangled and an appended "…" became a phantom row, with
 *      nothing on screen saying either was an artefact. Seeded with a CSV LARGER
 *      than the peek so the old behaviour is reachable; asserted on the LAST row's
 *      cells, which is the only place the corruption showed.
 *
 *   3. TRUNCATION IS STATED. A big NON-data text file still gets a peek — the
 *      right call — and must SAY it is a peek rather than smuggle an ellipsis into
 *      the text. Asserted on the sentence, and on the text NOT ending in "…".
 *
 *   4. R6-19.6 — "Open in file browser" from the ASSET PANEL and from RENDERINGS.
 *      `app.openFileBrowser(path)` shipped with zero callers, so the affordance the
 *      requirement names did not exist anywhere. Asserted by clicking each button
 *      and reading the breadcrumbs it landed on.
 *
 * Spawns its own isolated Vite + headless Chromium (the house probe pattern),
 * `?static=1` so no backend is needed.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = resolve(HERE, "../.frenzy/round6/W5-H-shots");
mkdirSync(shotDir, { recursive: true });

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
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

/** Command (drives the page). Close the File Browser and WAIT until it is gone
 *  from the DOM. The command TOGGLES, so it is only run when the modal is
 *  actually open — calling it blind would reopen an already-closed browser and
 *  every assertion after it would be measuring the wrong state. */
const closeFileBrowser = async () => {
  await page.evaluate(() => {
    if (document.querySelector(".file-browser")) window.__powerrp_app.commands.get("file-browser").run(window.__powerrp_app);
  });
  await page.waitForFunction(() => document.querySelector(".file-browser") === null, { timeout: 15000 });
};

// Same expected noise as tests/file_browser_probe.js, for the same stated reasons
// (frontend-only Vite, headless WebGPU notice, the repair pipeline reporting the
// defaults it filled into a deliberately minimal fixture deck).
const EXPECTED_NOISE = /Failed to load resource|\/api\/|WebGPU|no WebGPU adapter|PowerRP repair:/;

// The seeded CSV must be BIGGER than storageTree's PREVIEW_TEXT_BYTES, or the old
// truncating code path would have returned the whole file anyway and this probe
// would pass against the defect it exists to catch. Read from the module rather
// than restated: a test that hardcodes the number it is calibrated against stops
// being a gate the moment the number moves.
const CSV_HEADER = "row,label,value\n";
const CSV_LAST_LABEL = "final-row-marker";

let page;
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  const BOOT_TIMEOUT_MS = 120000;
  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "domcontentloaded", timeout: BOOT_TIMEOUT_MS });
  await page.waitForFunction(() => window.__powerrp_app !== undefined, { timeout: BOOT_TIMEOUT_MS });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) {
    console.error("BOOT ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }

  // ── SEED ────────────────────────────────────────────────────────────────────
  // A draft (imported .zip, per file_browser_probe's note that a fresh "Untitled"
  // is not under ~draft/), plus three assets chosen one per assertion: a PNG (does
  // a row draw the file), an over-budget CSV (is the table the whole file), and an
  // over-budget .txt (is a peek admitted as a peek).
  const { zipSync } = await import("fflate");
  const enc = new TextEncoder();
  const doc = {
    meta: { name: "FileBrowserRevealDeck", slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: { items: { cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" } } },
    }],
  };
  const zipBytes = zipSync({ "FileBrowserRevealDeck/doc.json": enc.encode(JSON.stringify(doc)) }, { level: 6 });

  const seeded = await page.evaluate(async (zipBytesArr, csvHeader, csvLastLabel) => {
    const app = window.__powerrp_app;
    await app.importProjectZip(new File([new Uint8Array(zipBytesArr)], "FileBrowserRevealDeck.zip", { type: "application/zip" }));
    const { PREVIEW_TEXT_BYTES } = await import("/storageTree.js");

    // A 2x2 red PNG — the smallest thing that still produces a real <img>.
    const png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";
    const pngBytes = Uint8Array.from(atob(png_b64), (c) => c.charCodeAt(0));
    await app.uploadAsset(new File([pngBytes], "reveal-probe-logo.png", { type: "image/png" }));

    // Rows until the file is comfortably past the peek budget, then ONE marked
    // last row. The marker is what proves the table reached the end of the file.
    let csv = csvHeader;
    let i = 0;
    while (csv.length < PREVIEW_TEXT_BYTES * 2) {
      csv += `${i},filler-row-${i},${i * 7}\n`;
      i += 1;
    }
    csv += `${i},${csvLastLabel},999\n`;
    await app.uploadAsset(new File([csv], "reveal-probe-table.csv", { type: "text/csv" }));

    // A NON-data text file over the same budget: this one SHOULD stay a peek.
    const txt = "peek me\n".repeat(Math.ceil((PREVIEW_TEXT_BYTES * 2) / "peek me\n".length));
    await app.uploadAsset(new File([txt], "reveal-probe-long.txt", { type: "text/plain" }));

    return { project: app.projectName(), peekBytes: PREVIEW_TEXT_BYTES, csvBytes: csv.length, csvRows: i + 1, txtBytes: txt.length };
  }, Array.from(zipBytes), CSV_HEADER, CSV_LAST_LABEL);

  assert(seeded.project.startsWith("~draft/"), `seeded into the draft keyspace (project="${seeded.project}")`);
  assert(seeded.csvBytes > seeded.peekBytes, `the seeded CSV is BIGGER than the peek budget, so the truncating path is reachable (${seeded.csvBytes} > ${seeded.peekBytes})`);
  assert(seeded.txtBytes > seeded.peekBytes, `the seeded .txt is BIGGER than the peek budget too (${seeded.txtBytes} > ${seeded.peekBytes})`);

  // ── REACH THE ASSETS FOLDER BY THE ROUTE THAT ALREADY EXISTED ───────────────
  // Deliberately NOT via the new reveal button, even though that is one row
  // below. Assertions 1-3 are about what a row DRAWS and what a preview SHOWS;
  // if they could only be reached through an affordance this same commit adds,
  // then at HEAD they would all fail for the reveal button's absence and none of
  // them would be testing its own defect. Navigating the way the shipped surface
  // already navigates keeps each red attributable.
  await page.evaluate(() => window.__powerrp_app.commands.get("file-browser").run(window.__powerrp_app));
  await sleep(900);
  await page.evaluate(async () => {
    const descend = async (match) => {
      const row = [...document.querySelectorAll(".file-browser-row")].find((r) => match(r.querySelector(".file-browser-name")?.textContent.trim() ?? ""));
      row?.click();
      await new Promise((r) => setTimeout(r, 700));
    };
    await descend((t) => t === "assets");
  });
  await page.waitForFunction(() => document.querySelectorAll(".file-browser-row").length > 0, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  const atAssets = await page.evaluate(() => [...document.querySelectorAll(".file-browser-crumb")].map((b) => b.textContent.trim()));
  assert(atAssets.at(-1) === "assets", `navigated to the draft's assets folder to run the preview assertions (crumbs: ${JSON.stringify(atAssets)})`);
  await page.screenshot({ path: resolve(shotDir, "01-assets-rows.png") });

  // OPEN ONE FILE'S PREVIEW, BY WHICHEVER GESTURE THIS BUILD OFFERS. Clicking a
  // file row opens its preview here; before this commit a click only SELECTED and
  // the detail pane's "Preview" button did the reading. The probe does both, in
  // that order, ON PURPOSE — otherwise the truncation assertions below would go
  // red at HEAD for "nothing was previewed at all", which proves the gesture
  // changed and says nothing about whether the preview was CORRUPT. With the
  // fallback, HEAD renders a preview and the assertions judge its CONTENT, which
  // is the defect being gated.
  await page.evaluate(() => {
    window.__fbOpenPreview = async (name) => {
      const row = [...document.querySelectorAll(".file-browser-row")].find((r) => r.querySelector(".file-browser-name")?.textContent.trim() === name);
      row?.click();
      await new Promise((r) => setTimeout(r, 1000));
      if (!document.querySelector(".file-browser-preview")) {
        [...document.querySelectorAll(".file-browser-detail-actions button")].find((b) => b.textContent.includes("Preview"))?.click();
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
  });

  // ── 1. A ROW DRAWS THE FILE (R6-19.3) ───────────────────────────────────────
  const rowMedia = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".file-browser-row")];
    const read = (name) => {
      const row = rows.find((r) => r.querySelector(".file-browser-name")?.textContent.trim() === name);
      if (!row) return null;
      const thumb = row.querySelector(".file-browser-thumb");
      return {
        hasImg: thumb?.querySelector("img") !== null && thumb?.querySelector("img") !== undefined,
        icons: [...(thumb?.querySelectorAll("iconify-icon") ?? [])].map((i) => i.getAttribute("icon")),
      };
    };
    return { png: read("reveal-probe-logo.png"), csv: read("reveal-probe-table.csv") };
  });
  assert(rowMedia.png?.hasImg === true, `an IMAGE row shows the image itself, not a glyph (icons found instead: ${JSON.stringify(rowMedia.png?.icons)})`);
  assert(
    Array.isArray(rowMedia.csv?.icons) && rowMedia.csv.icons.length > 0 && !rowMedia.csv.icons.includes("mdi:file-outline"),
    `a non-media row shows its KIND glyph, never the anonymous file page (got ${JSON.stringify(rowMedia.csv?.icons)})`,
  );

  // ── 2. THE CSV PREVIEW IS THE WHOLE FILE ────────────────────────────────────
  // Clicking a file row is what opens a preview (a folder row descends).
  const csvPreview = await page.evaluate(async (lastLabel) => {
    await window.__fbOpenPreview("reveal-probe-table.csv");
    const table = document.querySelector(".file-browser-preview table");
    if (!table) return { ok: false, why: "no table rendered in the preview" };
    // CsvTable is a VIRTUAL scroller, so the DOM holds a window, not every row.
    // Scroll it to the bottom and read what the last mounted row says.
    const scroller = document.querySelector(".file-browser-preview .csv-scroll") ?? table.parentElement;
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 500));
    const bodyRows = [...document.querySelectorAll(".file-browser-preview tbody tr")];
    const cellsOf = (tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
    const lastWithText = [...bodyRows].reverse().find((tr) => cellsOf(tr).some((c) => c.length > 0));
    return {
      ok: true,
      lastCells: lastWithText ? cellsOf(lastWithText) : null,
      sawMarker: (lastWithText ? cellsOf(lastWithText) : []).includes(lastLabel),
      anyEllipsisRow: bodyRows.some((tr) => cellsOf(tr).join("") === "…"),
    };
  }, CSV_LAST_LABEL);
  assert(csvPreview.ok, `clicking a CSV row renders the table preview (${csvPreview.why ?? ""})`);
  assert(
    csvPreview.sawMarker,
    `the table reaches the file's REAL last row — a 4KB peek would have stopped thousands of rows earlier, mid-line (last row read: ${JSON.stringify(csvPreview.lastCells)})`,
  );
  assert(csvPreview.ok && csvPreview.anyEllipsisRow === false, "and no phantom '…' row appears in the data — a truncation marker must never be a table row");
  await page.screenshot({ path: resolve(shotDir, "02-csv-preview.png") });

  // ── 3. A PEEK ADMITS IT IS A PEEK ───────────────────────────────────────────
  const txtPreview = await page.evaluate(async () => {
    await window.__fbOpenPreview("reveal-probe-long.txt");
    const pre = document.querySelector(".file-browser-preview-text");
    return {
      text: pre?.textContent ?? null,
      note: document.querySelector(".file-browser-preview-note")?.textContent.trim() ?? null,
    };
  });
  assert(typeof txtPreview.text === "string" && txtPreview.text.length > 0, "a long text file previews as text");
  assert(
    typeof txtPreview.note === "string" && /first/i.test(txtPreview.note),
    `a truncated preview SAYS it is truncated, in its own sentence (got ${JSON.stringify(txtPreview.note)})`,
  );
  assert(
    !txtPreview.text.trimEnd().endsWith("…"),
    "and the marker is NOT written into the previewed text — an appended '…' is indistinguishable from one the file contained",
  );
  await page.screenshot({ path: resolve(shotDir, "03-truncated-text.png") });

  // ── 4a. REVEAL FROM THE ASSET PANEL ─────────────────────────────────────────
  // Clicked as a USER would, from the Asset Explorer's own toolbar — not by
  // calling app.openFileBrowser, which would prove the plumbing and not the
  // affordance. The affordance is the thing that was missing.
  // CLOSED IS WAITED FOR, NOT SLEPT THROUGH. Measured: one run in roughly six read
  // the crumbs of a File Browser that had not finished unmounting, and reported the
  // reveal as landing on the project directory — a false red about the feature,
  // caused by the setup step. A `waitForFunction` turns that into an explicit
  // timeout naming the precondition instead.
  await closeFileBrowser();
  await page.screenshot({ path: resolve(shotDir, "04a-asset-panel-toolbar.png"), clip: { x: 0, y: 500, width: 300, height: 400 } });
  const revealBtnPresent = await page.evaluate(() => document.querySelector('.asset-explorer button[aria-label="Open assets in the File Browser"]') !== null);
  assert(revealBtnPresent, "the Asset Explorer's toolbar carries an 'Open assets in the File Browser' button (R6-19.6)");

  await page.evaluate(() => document.querySelector('.asset-explorer button[aria-label="Open assets in the File Browser"]')?.click());
  await sleep(900);
  const fromAssets = await page.evaluate(() => ({
    open: document.querySelector(".file-browser") !== null,
    crumbs: [...document.querySelectorAll(".file-browser-crumb")].map((b) => b.textContent.trim()),
  }));
  assert(fromAssets.open, "clicking it opens the File Browser");
  assert(
    fromAssets.crumbs.at(-1) === "assets" && fromAssets.crumbs.some((c) => c.includes("~draft/current")),
    `and it lands ON THIS PROJECT'S assets folder, not at Home (crumbs: ${JSON.stringify(fromAssets.crumbs)})`,
  );
  await sleep(600);
  await page.screenshot({ path: resolve(shotDir, "04-revealed-assets.png") });

  // ── 4b. REVEAL FROM RENDERINGS ──────────────────────────────────────────────
  await closeFileBrowser();
  const fromRenders = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.toggleRenderCenter();
    await new Promise((r) => setTimeout(r, 900));
    const btn = document.querySelector('button[aria-label="Open renders in the File Browser"]');
    if (!btn) return { present: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      present: true,
      browserOpen: document.querySelector(".file-browser") !== null,
      renderCenterStillOpen: document.querySelector(".render-center") !== null,
      crumbs: [...document.querySelectorAll(".file-browser-crumb")].map((b) => b.textContent.trim()),
    };
  });
  assert(fromRenders.present, "the Render Center's Renderings heading carries an 'Open renders in the File Browser' button (R6-19.6)");
  assert(fromRenders.browserOpen, "clicking it opens the File Browser");
  assert(
    fromRenders.crumbs?.at(-1) === "renders",
    `and it lands on this project's renders folder (crumbs: ${JSON.stringify(fromRenders.crumbs)})`,
  );
  assert(
    fromRenders.renderCenterStillOpen === false,
    "and it CLOSES the Render Center on the way — two large modals stacked leaves a dialog the user cannot see behind one they did not open",
  );
  await page.screenshot({ path: resolve(shotDir, "05-revealed-renders.png") });

  if (errors.length) {
    console.error("UNEXPECTED CONSOLE/PAGE ERRORS:\n" + errors.join("\n"));
    fails.push(`${errors.length} unexpected console/page error(s)`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nFILE BROWSER REVEAL PROBE FAILED (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nFILE BROWSER REVEAL PROBE PASSED — rows draw their files, a CSV preview is the whole CSV, a peek says it is a peek, and both panes can open the browser at their own folder. Shots: ${shotDir}`);
