/**
 * FILE BROWSER PROBE — the browser half of R6-19 (tests/storage_path_test.js
 * covers the pure path grammar in bare node; web/storageTree.js cannot be tested
 * there at all, because web/projectApi.js reads `location` at module scope).
 *
 * FIRST-USE STANDARD (CLAUDE.md): fresh static boot -> palette -> "File
 * Browser" -> the modal opens AT THE PROJECT DIRECTORY with real rows. This
 * probe drives exactly that path, then the assertions that make the surface
 * worth having:
 *
 *   1. the command exists, is reachable from the palette, and TOGGLES
 *   2. Home is the DRAFT keyspace when a draft is open — in every storage mode
 *   3. the draft keyspace is LABELED "(unsaved draft)", never a bare key
 *   4. descending into assets/ lists the seeded files, with real byte sizes
 *   5. Up climbs exactly one level; at a root it is aria-disabled and SAYS WHY
 *   6. breadcrumbs are jump targets that actually navigate
 *   7. A FAILING ROOT REPORTS INSTEAD OF READING AS EMPTY — the single most
 *      important behavioural rule in the design. Driven for real by asking the
 *      SERVER root to list in static mode, where there is no backend.
 *   8. every unavailable operation renders its SENTENCE, not a missing button
 *   9. the download button produces the right bytes, through the one shared
 *      download definition (web/fileDownload.js)
 *
 * Spawns its own isolated Vite + headless Chromium (the house probe pattern),
 * `?static=1` so no backend is needed.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = resolve(HERE, "../.frenzy/round6/W4-E-shots");
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

// Console noise this probe ignores, each for a stated reason:
//  · backend-absent chatter: this Vite is frontend-only on purpose (?static=1).
//  · WebGPU fallback: measured harmless boot-time notice on every headless run.
//  · storageTree.listPath: assertion 7 DELIBERATELY drives a failing listing and
//    the seam reports it on the console as well as in the returned errors[].
//    Silencing that report would be the very defect this probe exists to prevent.
//  · "PowerRP repair:": the fixture deck below is deliberately MINIMAL (one camera,
//    the fields the invariant needs and nothing else), so repairedDocument fills the
//    plugin defaults and says so. That sentence is the repair pipeline working
//    loudly, which is the contract; enumerating every plugin default in the fixture
//    would make this probe fail every time a widget gains a property.
const EXPECTED_NOISE = /Failed to load resource|\/api\/|WebGPU|no WebGPU adapter|storageTree\.listPath|PowerRP repair:/;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  // WAITS FOR THE APP HOOK, NOT `networkidle0` — and that is a correction, not a
  // shortcut. `networkidle0` was MEASURED to time out at its 30 s default on this
  // host whenever another Vite server is running, because concurrent servers share
  // `node_modules/.vite` and force a dependency re-optimization that takes longer
  // than the window (the same contention the manifest already records as the reason
  // a render job uses ONE dev server and N browsers). It also asks a weaker
  // question: "no requests for 500 ms" is a proxy for "the app is up", while
  // `window.__powerrp_app` IS the app being up.
  const BOOT_TIMEOUT_MS = 120000;
  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "domcontentloaded", timeout: BOOT_TIMEOUT_MS });
  await page.waitForFunction(() => window.__powerrp_app !== undefined, { timeout: BOOT_TIMEOUT_MS });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) {
    console.error("BOOT ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }

  // ── SEED: import a .zip so the working copy is a genuine DRAFT ──────────────
  // A brand-new "Untitled" document is NOT under the ~draft/ keyspace — that
  // only happens for an IMPORTED working copy (web/app.svelte.js projectName()).
  // Same fixture shape as tests/debug_storage_probe.js, for the same reason.
  const { zipSync } = await import("fflate");
  const enc = new TextEncoder();
  const doc = {
    meta: { name: "FileBrowserProbeDeck", slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: { items: { cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" } } },
    }],
  };
  const zipBytes = zipSync({ "FileBrowserProbeDeck/doc.json": enc.encode(JSON.stringify(doc)) }, { level: 6 });

  const NOTES = "hello from the file browser probe\n";
  const seeded = await page.evaluate(async (zipBytesArr, notes) => {
    const app = window.__powerrp_app;
    await app.importProjectZip(new File([new Uint8Array(zipBytesArr)], "FileBrowserProbeDeck.zip", { type: "application/zip" }));
    const png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(png_b64), (c) => c.charCodeAt(0));
    const img = await app.uploadAsset(new File([bytes], "fb-probe-logo.png", { type: "image/png" }));
    const txt = await app.uploadAsset(new File([notes], "fb-probe-notes.txt", { type: "text/plain" }));
    return { project: app.projectName(), imgName: img.name, imgBytes: bytes.length, txtName: txt.name };
  }, Array.from(zipBytes), NOTES);
  assert(seeded.project.startsWith("~draft/"), `seeded into the draft keyspace after import (project="${seeded.project}")`);

  // ── 1. THE COMMAND EXISTS AND IS REACHABLE FROM THE PALETTE ────────────────
  const cmd = await page.evaluate(() => {
    const c = window.__powerrp_app.commands.get("file-browser");
    return c ? { id: c.id, title: c.title, icon: c.icon, hasRun: typeof c.run === "function", hasHelp: typeof c.help === "string" && c.help.length > 0 } : null;
  });
  assert(cmd !== null, "the registry has a 'file-browser' entry");
  assert(cmd?.hasRun && cmd?.hasHelp, `the entry runs and carries help text (title="${cmd?.title}")`);

  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await sleep(300);
  await page.keyboard.type("File Browser", { delay: 20 });
  await sleep(250);
  await page.keyboard.press("Enter");
  await sleep(800);

  const opened = await page.evaluate(() => document.querySelector(".file-browser") !== null);
  assert(opened, "running the palette entry opened the File Browser modal");
  await page.waitForFunction(() => document.querySelectorAll(".file-browser-row").length > 0, { timeout: 15000 }).catch(() => {});
  await sleep(400);
  await page.screenshot({ path: resolve(shotDir, "01-home.png") });

  // ── 2 + 3. HOME IS THE DRAFT, AND THE DRAFT IS LABELED ─────────────────────
  const crumbsAtHome = await page.evaluate(() => [...document.querySelectorAll(".file-browser-crumb")].map((b) => b.textContent.trim()));
  assert(crumbsAtHome[0] === "This browser", `Home's root crumb is the LOCAL root even though this is a draft (got ${JSON.stringify(crumbsAtHome)})`);
  assert(crumbsAtHome.some((c) => c.includes("~draft/current")), `Home is the draft keyspace (crumbs: ${JSON.stringify(crumbsAtHome)})`);

  // The keyspace ROW (at the local root) must be labeled, not shown bare — the
  // same rule and the same function the Debug Storage page uses (rowLabel).
  await page.evaluate(() => document.querySelectorAll(".file-browser-crumb")[0].click());
  await sleep(600);
  const rootRows = await page.evaluate(() => [...document.querySelectorAll(".file-browser-name")].map((el) => el.textContent.trim()));
  const draftRow = rootRows.find((t) => t.includes("~draft/"));
  assert(!!draftRow, `the local root lists the draft keyspace (rows: ${JSON.stringify(rootRows)})`);
  assert(!!draftRow && draftRow.includes("unsaved draft"), `the draft keyspace is LABELED "(unsaved draft)", never a bare key (got "${draftRow}")`);
  assert(rootRows.includes("caches") && rootRows.includes("other"), `the local root also lists this browser's non-project storage (rows: ${JSON.stringify(rootRows)})`);
  await page.screenshot({ path: resolve(shotDir, "02-local-root.png") });

  // ── 5. UP AT A ROOT IS aria-disabled AND SAYS WHY ──────────────────────────
  const upAtRoot = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Up one level"]');
    return { disabled: btn?.getAttribute("aria-disabled"), native: btn?.hasAttribute("disabled") };
  });
  assert(upAtRoot.disabled === "true", "at a root, Up is aria-disabled (there is nothing above a root)");
  assert(upAtRoot.native === false, "Up uses aria-disabled + a handler guard, NOT the native attribute — a natively-disabled button is not focusable, so the keyboard could never reach its explanation");

  // ── 4. DESCEND: keyspace -> assets -> the seeded files with real sizes ─────
  const descended = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll(".file-browser-row")];
    const draft = rows.find((r) => r.querySelector(".file-browser-name")?.textContent.includes("~draft/"));
    draft?.click();
    await new Promise((r) => setTimeout(r, 500));
    const cats = [...document.querySelectorAll(".file-browser-row")];
    const assetsRow = cats.find((r) => r.querySelector(".file-browser-name")?.textContent.trim() === "assets");
    assetsRow?.click();
    await new Promise((r) => setTimeout(r, 500));
    return [...document.querySelectorAll(".file-browser-row")].map((r) => ({
      name: r.querySelector(".file-browser-name")?.textContent.trim(),
      detail: r.querySelector(".file-browser-detail")?.textContent.trim() ?? null,
    }));
  });
  const names = descended.map((d) => d.name);
  assert(names.includes("fb-probe-logo.png"), `descending twice reaches the seeded PNG (rows: ${JSON.stringify(names)})`);
  assert(names.includes("fb-probe-notes.txt"), "descending twice reaches the seeded text file");
  const notesRow = descended.find((d) => d.name === "fb-probe-notes.txt");
  assert(!!notesRow?.detail && !notesRow.detail.includes("size unknown"), `a stored file reports a REAL size, not "size unknown" (detail: "${notesRow?.detail}")`);
  await page.screenshot({ path: resolve(shotDir, "03-draft-assets.png") });

  // ── 5b. UP CLIMBS EXACTLY ONE LEVEL ────────────────────────────────────────
  const afterUp = await page.evaluate(async () => {
    document.querySelector('button[aria-label="Up one level"]').click();
    await new Promise((r) => setTimeout(r, 500));
    return [...document.querySelectorAll(".file-browser-crumb")].map((b) => b.textContent.trim());
  });
  assert(afterUp.length === 2 && afterUp[1].includes("~draft/current"), `Up from the draft's assets/ lands on the draft keyspace, not the root (crumbs: ${JSON.stringify(afterUp)})`);

  // ── 6. A BREADCRUMB IS A JUMP TARGET ───────────────────────────────────────
  const afterCrumb = await page.evaluate(async () => {
    document.querySelectorAll(".file-browser-crumb")[0].click();
    await new Promise((r) => setTimeout(r, 500));
    return [...document.querySelectorAll(".file-browser-crumb")].map((b) => b.textContent.trim());
  });
  assert(afterCrumb.length === 1, `clicking the root crumb navigates to the root (crumbs: ${JSON.stringify(afterCrumb)})`);

  // ── 7. A FAILING LISTING REPORTS — IT DOES NOT READ AS EMPTY ───────────────
  // Driven for real, not simulated: naming a cache this origin does not have makes
  // the CacheStorage lister throw, and the contract is that listPath returns
  // {entries: [], errors: [{path, message}]} rather than swallowing into a bare [].
  //
  // AN EARLIER VERSION OF THIS ASSERTION POINTED AT `server:/` IN STATIC MODE, on
  // the reasoning that there is no backend there. It was WRONG and it measured as
  // wrong: this repo's Vite config PROXIES /api, so whenever anyone on the host has
  // a project server up, the "absent" backend answers and the assertion passes for
  // the wrong reason (measured: 10 entries, 0 errors). A gate whose verdict depends
  // on whether a peer left a server running is not a gate. This one cannot be
  // rescued by the environment.
  const failing = await page.evaluate(async () => {
    const { listPath } = await import("/storageTree.js");
    const res = await listPath("local:/~storage/caches/definitely-not-a-cache");
    return { entries: res.entries.length, errors: res.errors.length, message: res.errors[0]?.message ?? null, path: res.errors[0]?.path ?? null };
  });
  assert(failing.errors === 1 && failing.entries === 0, `a listing that cannot be read reports an error rather than an empty folder (errors=${failing.errors}, entries=${failing.entries})`);
  assert(failing.path === "local:/~storage/caches/definitely-not-a-cache", `the reported error names the PATH it belongs to (got ${JSON.stringify(failing.path)})`);
  assert(/definitely-not-a-cache/.test(failing.message ?? ""), `the reported error carries a sentence naming what was missing (got ${JSON.stringify(failing.message)})`);

  // ── 8. UNAVAILABLE OPERATIONS CARRY THEIR SENTENCE ─────────────────────────
  const caps = await page.evaluate(async () => {
    const { activeRoots, UNAVAILABLE_HERE, refuseOperation } = await import("/storageTree.js");
    const roots = activeRoots();
    let refusalSaid = null;
    try { refuseOperation("rename"); } catch (e) { refusalSaid = e.message; }
    return {
      rootIds: roots.map((r) => r.id),
      everyUnavailableIsASentence: roots.every((r) => Object.values(r.capabilities.unavailable).every((s) => typeof s === "string" && s.trim().length > 20)),
      removeSentence: UNAVAILABLE_HERE.remove,
      refusalSaid,
    };
  });
  assert(!caps.rootIds.includes("server"), `in static mode the SERVER root is absent rather than shown empty (roots: ${JSON.stringify(caps.rootIds)})`);
  assert(caps.everyUnavailableIsASentence, "every declared-unavailable operation carries a real sentence, on every active root");
  assert(/Asset Explorer/.test(caps.removeSentence), `the 'remove' sentence names WHAT TO USE INSTEAD (got "${caps.removeSentence}")`);
  assert(caps.refusalSaid === (await page.evaluate(async () => (await import("/storageTree.js")).UNAVAILABLE_HERE.rename)), "refuseOperation throws the table's own sentence — one wording, not a second one at the throw site");

  // The pane renders those sentences as DISABLED affordances (never absent).
  const shownSentences = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll(".file-browser-row")];
    rows.find((r) => r.querySelector(".file-browser-name")?.textContent.includes("~draft/"))?.click();
    await new Promise((r) => setTimeout(r, 400));
    const cats = [...document.querySelectorAll(".file-browser-row")];
    cats.find((r) => r.querySelector(".file-browser-name")?.textContent.trim() === "assets")?.click();
    await new Promise((r) => setTimeout(r, 500));
    const files = [...document.querySelectorAll(".file-browser-row")];
    files.find((r) => r.querySelector(".file-browser-name")?.textContent.trim() === "fb-probe-notes.txt")?.click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      note: document.querySelector(".file-browser-detail-note")?.textContent.trim() ?? null,
      limits: [...document.querySelectorAll(".file-browser-limits-list li")].map((b) => b.textContent.trim()),
      // The anti-affordance rule: "a control that looks clickable but only
      // reports is a lie". A refusal must not be dressed as a disabled button.
      fakeButtons: document.querySelectorAll('.file-browser-limits button').length,
    };
  });
  assert(typeof shownSentences.note === "string" && shownSentences.note.length > 20, `the selected node states WHAT BACKS IT (note: "${shownSentences.note}")`);
  assert(shownSentences.limits.length > 0, `the operations this root refuses are STATED, not silently absent (got ${shownSentences.limits.length} sentences)`);
  assert(shownSentences.limits.every((s) => s.length > 20), `each refusal is a real sentence, not an operation key (got ${JSON.stringify(shownSentences.limits.map((s) => s.slice(0, 40)))})`);
  assert(shownSentences.fakeButtons === 0, "a refusal is never dressed as a disabled button — a control that looks clickable but only reports is a lie");
  await page.screenshot({ path: resolve(shotDir, "04-selected-file.png") });

  // ── 9. DOWNLOAD PRODUCES THE RIGHT BYTES ───────────────────────────────────
  // Captured by intercepting URL.createObjectURL — the technique this suite
  // already uses to inspect a download without touching the OS filesystem.
  const downloadCheck = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll(".file-browser-detail-actions button")].find((b) => b.textContent.includes("Download"));
    if (!btn) return { ok: false, why: "no download button" };
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return realCreate.call(URL, blob); };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    URL.createObjectURL = realCreate;
    if (!captured) return { ok: false, why: "no blob captured" };
    return { ok: true, text: await captured.text() };
  });
  assert(downloadCheck.ok, `the Download button produced a blob (${downloadCheck.why ?? ""})`);
  assert(downloadCheck.text === NOTES, `the downloaded bytes are exactly what was uploaded (got ${JSON.stringify(downloadCheck.text)})`);

  // ── 1b. THE COMMAND TOGGLES ────────────────────────────────────────────────
  const toggled = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.commands.get("file-browser").run(app);
    await new Promise((r) => setTimeout(r, 400));
    const closed = document.querySelector(".file-browser") === null;
    app.commands.get("file-browser").run(app);
    await new Promise((r) => setTimeout(r, 400));
    return { closed, reopened: document.querySelector(".file-browser") !== null };
  });
  assert(toggled.closed, "running the command again CLOSES the browser (it toggles, like render-center)");
  assert(toggled.reopened, "and running it once more reopens it");

  if (errors.length) {
    console.error("UNEXPECTED CONSOLE/PAGE ERRORS:\n" + errors.join("\n"));
    fails.push(`${errors.length} unexpected console/page error(s)`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nFILE BROWSER PROBE FAILED (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nFILE BROWSER PROBE PASSED — palette -> File Browser opens at the project directory, navigates up/down/home, labels the draft, reports a failing root instead of showing it empty, and downloads real bytes. Shots: ${shotDir}`);
