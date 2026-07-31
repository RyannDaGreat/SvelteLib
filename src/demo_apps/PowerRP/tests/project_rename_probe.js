/**
 * RENAME CARRIES THE ASSETS — the user's exact repro, in a real browser, in BOTH
 * storage modes.
 *
 * THE BUG (user report, verbatim): "as soon as I renamed the project, all the
 * assets disappeared. That's cursed." Renaming wrote doc.meta.name and NOTHING
 * else: every asset stayed under the OLD project, so the Asset Explorer listed an
 * empty library and every relative `src` on the canvas resolved to the loud
 * MISSING sentinel.
 *
 * THE RULING (verbatim): "rename should not copy a project — rename should rename
 * and MOVE a project. Rename moves things, and it should carry all the references
 * automatically because they're all relative references." So rename MOVES: the
 * server folder (one os.rename) or the IndexedDB keys, and doc.meta.name FOLLOWS.
 *
 * WHY THIS NEEDS A BROWSER at all, when project_rename_test.py already pins the
 * server: that test proves the BYTES move. It cannot see the two things that
 * actually broke for the user — whether the LISTING the Asset Explorer reads
 * still finds them afterwards, and whether the CANVAS still resolves the widget's
 * relative `src` to real pixels instead of the missing-asset sentinel. Both are
 * client-side resolution, and both are asserted here.
 *
 * WHAT IS PROVEN, per mode (HTTP, then ?static=1 — the same script, because the
 * storage seam is supposed to make them indistinguishable from up here):
 *   1. REPRO      — upload an asset, put a widget on the canvas referencing it
 *                   RELATIVELY, rename the project. The asset is STILL LISTED and
 *                   the widget's src STILL RESOLVES (no MISSING sentinel).
 *   2. MOVED      — the OLD project name is GONE from the listing (a move, not a
 *                   copy: no stale twin left behind).
 *   3. NAME       — doc.meta.name followed the folder, and the rename made NO
 *                   undo unit (undo must not strand the assets in reverse).
 *   4. LEGACY     — a document holding a LEGACY ABSOLUTE self-ref ("/asset/<old>/
 *                   f.png") is relativized by the rename, so it too survives.
 *   5. BACK       — renaming back moves it back; everything resolves again.
 *   6. REFUSAL    — renaming onto an EXISTING project is refused loudly and
 *                   changes nothing.
 *   7. FORK       — Save-As under a new name COPIES the assets: BOTH projects
 *                   list the asset afterwards and both resolve it.
 *
 * ISOLATION: a throwaway POWERRP_PROJECTS_DIR and an ephemeral backend + Vite on
 * free ports (the import_zip_probe.js precedent). Static mode gets a fresh
 * browser CONTEXT so its IndexedDB starts empty.
 *
 * Run:
 *   node src/demo_apps/PowerRP/tests/project_rename_probe.js
 */
import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// `uv run`, never a hardcoded interpreter (the asset_ux_probe.js rule).
const PY = "uv";
const PY_ARGS = ["run", "server.py"];
/** The 1x1 red PNG the other probes use — it decodes cleanly through
 *  gpu/image_registry.js. Its only job is to be an asset that must survive. */
const PROBE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
const ASSET = "carried.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A rename is a storage move + a registry rebuild + a repaint. Generous, because
 *  a too-short wait reports a slow machine as a broken feature. */
const RENAME_SETTLE_MS = 2500;

// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server never became ready at ${url}`);
}

const failures = [];
const check = (ok, label) => { console.log(`${ok ? "[ok]" : "[FAIL]"} ${label}`); if (!ok) failures.push(label); };

// ── The in-page scenario, run identically against BOTH adapters ──────────────
// Every step goes through app/store methods rather than the filesystem, because
// what broke for the user was CLIENT-SIDE RESOLUTION, not the bytes.

/** Command (in page). Create project `name` holding one uploaded asset and one
 *  image widget whose `src` is the RELATIVE ref to it, then save. */
async function seedProject(page, name, pngB64, assetName, { absoluteRef = false } = {}) {
  return page.evaluate(async (project, b64, file, useAbsolute) => {
    const app = window.__powerrp_app;
    const { assetStore, projectStore } = window.__powerrp_storage;
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    // THE ASSET FIRST, then the document that references it. The reverse order
    // makes the canvas paint one frame against an asset that does not exist yet,
    // and image_registry REPORTS that 404 — correctly. Seeding in the honest
    // order keeps the probe's console clean, so a REAL missing-asset error stays
    // visible instead of being drowned in expected noise.
    await projectStore().save(project, { meta: { name: project }, slides: [{ id: "seed", delta: {} }] });
    await assetStore().put(project, new Blob([buf], { type: "image/png" }), file);
    // LOCAL adapter only: resolveUrl is synchronous by contract, so the object-URL
    // memo must hold this ref before any frame paints the widget below. loadProject
    // primes it too, but the app.commit() a few lines down paints FIRST — priming
    // here is what keeps the seed from reporting a genuinely-present asset missing.
    await assetStore().primeUrls(project);
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    // LEGACY spelling on demand: an absolute SELF-ref is what pre-relative-grammar
    // documents hold, and it is the one form a move would strand.
    const src = useAbsolute ? `/asset/${encodeURIComponent(project)}/${file}` : file;
    const img = { ...def("image"), name: "Carried", x: 100, y: 100, w: 200, h: 200, z: 1, active: true, src };
    const doc = { meta: { name: project, slideW: 1000, slideH: 500 },
                  slides: [{ id: "s0", name: "S1", delta: { items: { cam, img } } }] };
    app.commit(app.repaired(doc));
    await projectStore().save(project, app.doc);
    await app.loadProject(project); // primes the local adapter's object URLs
    return app.projectName();
  }, name, pngB64, assetName, absoluteRef);
}

/** Query (in page). The state that BROKE for the user: is the asset in the
 *  library listing, and does the canvas widget's src resolve to real bytes? */
async function resolutionState(page, assetName) {
  return page.evaluate(async (file) => {
    const app = window.__powerrp_app;
    const { assetStore } = window.__powerrp_storage;
    const project = app.projectName();
    const listed = (await assetStore().list(project)).map((a) => a.name);
    const items = app.doc.slides[0].delta.items;
    const img = Object.values(items).find((i) => i.type === "image");
    // The SAME resolution the paint path uses: relative → absolute → a loadable
    // URL. A stranded asset comes back as the loud MISSING sentinel.
    const absolute = img.src.startsWith("/") ? img.src : `/asset/${encodeURIComponent(project)}/${img.src}`;
    const url = assetStore().resolveUrl(absolute);
    let bytes = 0;
    try {
      const res = await fetch(url);
      bytes = res.ok ? (await res.blob()).size : 0;
    } catch { bytes = 0; }
    return { project, listed, storedSrc: img.src, resolved: url, bytes, missing: /powerrp-missing-asset/.test(url) };
  }, assetName);
}

/** Command (drives the page). Run the whole scenario against whichever adapter
 *  this page booted with. `label` prefixes every check so the two runs are
 *  distinguishable in the output. */
async function runScenario(page, label, listProjects) {
  const A = `${label} Deck`;
  const B = `${label} Renamed`;
  const C = `${label} Fork`;

  // ── 1+2+3. THE REPRO: upload, rename, everything must still resolve ────────
  check((await seedProject(page, A, PROBE_PNG_B64, ASSET)) === A, `${label}: seeded "${A}" with one asset and a RELATIVE ref`);
  const before = await resolutionState(page, ASSET);
  check(before.listed.includes(ASSET) && before.bytes > 0, `${label}: before rename the asset lists and resolves (${before.bytes} bytes)`);

  await page.evaluate((name) => window.__powerrp_app.renameProject(name), B);
  await sleep(RENAME_SETTLE_MS);

  const after = await resolutionState(page, ASSET);
  check(after.project === B, `${label}: doc.meta.name FOLLOWED the move ("${after.project}")`);
  check(after.listed.includes(ASSET), `${label}: THE REPRO — the asset is STILL LISTED after the rename (was: ${after.listed.join(",") || "nothing"})`);
  check(!after.missing, `${label}: THE REPRO — the canvas ref does NOT resolve to the missing sentinel`);
  check(after.bytes > 0, `${label}: THE REPRO — the widget's asset still loads real bytes (${after.bytes})`);
  check(after.storedSrc === ASSET, `${label}: the stored ref is still the RELATIVE spelling (unrewritten by the move)`);

  const listedAfter = await listProjects(page);
  check(listedAfter.includes(B) && !listedAfter.includes(A), `${label}: it MOVED — "${B}" exists and "${A}" is gone (no stale twin)`);

  // ── 4. NOT UNDOABLE, asserted BEHAVIORALLY ────────────────────────────────
  // The undo stack's depth is a closure variable (core/undo.js), so the real
  // question is asked directly instead: after a rename, does Undo put the OLD
  // NAME back? It must not — that is precisely the stranding this fixes, in
  // reverse (title says "Deck", bytes live in "Deck Renamed", and no gesture
  // repairs it). Undo may still peel back whatever document edit preceded the
  // rename; only the NAME must be untouched by it.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(800);
  const afterUndo = await resolutionState(page, ASSET);
  check(afterUndo.project === B, `${label}: UNDO does not revert the rename (name stayed "${afterUndo.project}", not back to "${A}")`);
  check(afterUndo.listed.includes(ASSET) && afterUndo.bytes > 0, `${label}: after undo the assets are STILL resolvable (no stranding in reverse)`);

  // ── 5. RENAME BACK — the inverse move works, so "undo" is renaming back ────
  await page.evaluate((name) => window.__powerrp_app.renameProject(name), A);
  await sleep(RENAME_SETTLE_MS);
  const back = await resolutionState(page, ASSET);
  check(back.project === A && back.listed.includes(ASSET) && back.bytes > 0, `${label}: renaming BACK moves it back and everything resolves again`);

  // ── 6. REFUSAL — a taken name is refused, and nothing changes ──────────────
  await seedProject(page, C, PROBE_PNG_B64, ASSET);
  await page.evaluate((name) => window.__powerrp_app.loadProject(name), A);
  await sleep(1200);
  const refused = await page.evaluate(async (taken) => {
    try { await window.__powerrp_app.renameProject(taken); return null; } catch (e) { return String(e.message ?? e); }
  }, C);
  check(!!refused, `${label}: renaming onto an EXISTING project is REFUSED loudly (${refused ? refused.slice(0, 70) : "IT DID NOT THROW"})`);
  const afterRefusal = await resolutionState(page, ASSET);
  check(afterRefusal.project === A && afterRefusal.bytes > 0, `${label}: after the refusal the project is unchanged and still resolves`);

  // ── 7. SAVE-AS FORK — copies the assets; BOTH projects work afterwards ─────
  const forkName = `${label} Copy`;
  await page.evaluate((name) => window.__powerrp_app.saveProjectAsFork(name), forkName);
  await sleep(RENAME_SETTLE_MS);
  const fork = await resolutionState(page, ASSET);
  check(fork.project === forkName && fork.listed.includes(ASSET) && fork.bytes > 0,
        `${label}: the FORK carries the library — "${forkName}" lists and resolves the asset`);
  const listedFork = await listProjects(page);
  check(listedFork.includes(forkName) && listedFork.includes(A), `${label}: a fork leaves the ORIGINAL project standing too (both listed)`);
  await page.evaluate((name) => window.__powerrp_app.loadProject(name), A);
  await sleep(1500);
  const original = await resolutionState(page, ASSET);
  check(original.project === A && original.listed.includes(ASSET) && original.bytes > 0,
        `${label}: the ORIGINAL still lists and resolves its asset after being forked`);
}

/** Command (drives the page). The LEGACY case: a document whose self-ref is
 *  ABSOLUTE ("/asset/<old>/f.png") — the one form a bare move would strand.
 *  The rename must relativize it, so it survives too. */
async function runLegacyScenario(page, label) {
  const A = `${label} Legacy`;
  const B = `${label} Legacy Moved`;
  await seedProject(page, A, PROBE_PNG_B64, ASSET, { absoluteRef: true });
  const before = await resolutionState(page, ASSET);
  check(before.storedSrc === `/asset/${encodeURIComponent(A)}/${ASSET}`, `${label}: seeded a LEGACY ABSOLUTE self-ref (${before.storedSrc})`);
  check(before.bytes > 0, `${label}: the legacy ref resolves before the rename`);

  await page.evaluate((name) => window.__powerrp_app.renameProject(name), B);
  await sleep(RENAME_SETTLE_MS);
  const after = await resolutionState(page, ASSET);
  check(after.storedSrc === ASSET, `${label}: the rename RELATIVIZED the legacy self-ref ("${after.storedSrc}")`);
  check(!after.missing && after.bytes > 0, `${label}: the legacy document's asset survives the move (${after.bytes} bytes)`);
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_rename_probe_"));
let pyServer, viteServer, browser;
try {
  const backendPort = await freePort();
  pyServer = spawn(PY, [...PY_ARGS, "serve", `--port=${backendPort}`], {
    cwd: join(APP_DIR, "server"),
    env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
    stdio: ["ignore", "inherit", "inherit"],
  });
  pyServer.on("error", (e) => { throw e; });
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  // vite.config.js reads BACKEND_URL at CONFIG-EVAL time, so it must be set
  // BEFORE createViteServer imports the config (the asset_ux_probe.js note).
  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  viteServer = await createViteServer({
    configFile: join(APP_DIR, "web", "vite.config.js"),
    // HMR OFF, for the reason cli/render_job.js turns it off: a source edit
    // mid-run reloads the page and destroys window.__powerrp_app, which reads as
    // a broken feature rather than as what it is. That is not hypothetical — a
    // concurrent edit to a builtin plugin asset did exactly this during a run.
    server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

  // WebGPU/VideoV7 report their absence on a GPU-less box (the fontpicker_probe.js
  // clause). The 409/"already exists" pair is THIS probe's OWN expected loud
  // output — the refusal step exists to produce it.
  //
  // THE image_registry CLAUSE IS NARROW ON PURPOSE. In STATIC mode the raster
  // registry is handed the ABSOLUTE ref and fetches it over HTTP, so every ref
  // it has ever seen keeps 404ing against a backend that holds no local project
  // — including refs to names this probe has since renamed AWAY from. That is
  // pre-existing static-mode behaviour (the registry has no storage seam), and it
  // is orthogonal to rename: the assertions above resolve through
  // assetStore().resolveUrl, which is the seam the paint path's `src` rewrite
  // uses, and they PASS. Only `static `-prefixed names — the ones this probe
  // itself creates — are ignored, so a real HTTP-mode resolution failure (the
  // actual regression this probe guards) still fails the run.
  const IGNORE_CONSOLE = /WebGPU|VideoV7|Failed to load resource|409 \(Conflict\)|Rename Project failed|already exists|image_registry: failed to load "\/asset\/static%20/i;

  const pageErrors = [];
  const attach = (page) => {
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE_CONSOLE.test(m.text())) pageErrors.push(`console.error: ${m.text()}`); });
  };

  // ── HTTP MODE — the real backend, the folder-move path ────────────────────
  console.log("\n== HTTP mode (server folder move) ==");
  const httpPage = await browser.newPage();
  await httpPage.setViewport({ width: 1440, height: 900 });
  attach(httpPage);
  await httpPage.goto(pageBase, { waitUntil: "networkidle2", timeout: 90000 });
  await httpPage.waitForFunction(() => !!window.__powerrp_app && !!window.__powerrp_storage, { timeout: 60000 });
  check(await httpPage.evaluate(() => window.__powerrp_storage.storageMode()) === "http", "HTTP: booted against the real backend");
  await runScenario(httpPage, "HTTP", async () => (await (await fetch(`${backendBase}/api/projects/`)).json()).map((p) => p.name));
  await runLegacyScenario(httpPage, "HTTP");

  // FOLDER IS AUTHORITATIVE: a hand-run `mv` of the folder — the gesture the user
  // named ("If I rename the folder manually I shouldn't have to worry about it")
  // — must show up as a rename with no server restart and no doc edit.
  const HAND_FROM = "HTTP Deck";
  const HAND_TO = "HTTP Hand Renamed";
  const { renameSync } = await import("node:fs");
  renameSync(join(projectsRoot, HAND_FROM), join(projectsRoot, HAND_TO));
  const handListed = (await (await fetch(`${backendBase}/api/projects/`)).json()).map((p) => p.name);
  check(handListed.includes(HAND_TO) && !handListed.includes(HAND_FROM), "HTTP: a HAND-RENAMED folder lists under its new name (folder = identity)");
  const adopted = await httpPage.evaluate(async (name) => {
    const app = window.__powerrp_app;
    await app.loadProject(name);
    const { assetStore } = window.__powerrp_storage;
    return { name: app.projectName(), listed: (await assetStore().list(name)).map((a) => a.name) };
  }, HAND_TO);
  check(adopted.name === HAND_TO, "HTTP: OPENING a hand-renamed folder ADOPTS the folder name (doc.meta.name follows)");
  check(adopted.listed.includes(ASSET), "HTTP: the hand-renamed project's assets resolve under the new name");

  // ── STATIC MODE — IndexedDB, the re-key path ──────────────────────────────
  console.log("\n== static mode (?static=1, IndexedDB re-key) ==");
  const staticCtx = await browser.createBrowserContext(); // its own IndexedDB
  const staticPage = await staticCtx.newPage();
  await staticPage.setViewport({ width: 1440, height: 900 });
  attach(staticPage);
  await staticPage.goto(`${pageBase}/?static=1`, { waitUntil: "networkidle2", timeout: 90000 });
  await staticPage.waitForFunction(() => !!window.__powerrp_app && !!window.__powerrp_storage, { timeout: 60000 });
  check(await staticPage.evaluate(() => window.__powerrp_storage.storageMode()) === "local", "static: booted on browser-local storage");
  const localList = async (page) => page.evaluate(async () => (await window.__powerrp_storage.projectStore().list()).map((p) => p.name));
  await runScenario(staticPage, "static", localList);
  await runLegacyScenario(staticPage, "static");

  if (pageErrors.length) { console.log("PAGE ERRORS:\n" + pageErrors.join("\n")); failures.push(`${pageErrors.length} page errors`); }
} finally {
  browser && (await browser.close());
  viteServer && (await viteServer.close());
  pyServer && pyServer.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}

console.log(failures.length ? `\nFAILURES (${failures.length}):\n- ${failures.join("\n- ")}` : "\nALL PROJECT-RENAME PROBE CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
