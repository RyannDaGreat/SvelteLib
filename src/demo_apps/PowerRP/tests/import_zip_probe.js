/**
 * OPEN A .ZIP — the drag-and-drop half of the project import, end to end in a
 * real browser.
 *
 * The user's question was "I can export a zip — can I OPEN one? If I drag and
 * drop a zip file into the app, will it open it as a presentation with the name
 * and everything?". import_zip_test.py pins the SERVER half (the unpack, the
 * collision rule, the traversal guards). This probe pins the half that test
 * cannot see: that a FILE DROPPED ON THE CANVAS reaches it at all, that what
 * comes back is opened in the editor under the right name, and that a rename or
 * a refusal is SAID OUT LOUD instead of silently changing what the user has.
 *
 * The drop is a real DragEvent carrying a real DataTransfer File — the app's own
 * ondrop runs, exactly as it would from Finder. Calling app.importProjectZip()
 * directly would prove the import and skip the actual question.
 *
 * THE WORKING-COPY MODEL (9f386e9, 31d5a8d) is what scenarios 2-4 assert, and it
 * REPLACED what they used to assert. A dropped .zip no longer becomes a library
 * entry at all: it opens an UNSAVED DRAFT, staged under the draft key, and the
 * library is not written until the user saves ("It shouldn't have to save until
 * the user decides to save - that goes for uploading zips too"). The old
 * "<Name> 2" de-collision therefore has nothing left to de-collide, and its
 * disappearance is the feature — so the checks below prove the library stays
 * EMPTY of new entries where they once proved a renamed one appeared.
 *
 * WHAT IS PROVEN, in order:
 *   1. EXPORT     — GET /api/download/<seed>/ yields a real archive.
 *   2. DRAFT      — dropping it back opens an unsaved draft under the dropped
 *                   deck's own name; the library still lists ONLY the seed.
 *   3. ASSETS     — the archive's asset is staged under the draft key and reads
 *                   back byte-identical: a .zip carries assets, not just doc.json.
 *   4. REPLACE    — a second drop swaps the working copy and STILL writes
 *                   nothing to the library.
 *   5. REFUSAL    — a junk .zip shows the failure, leaves the open working copy
 *                   alone, and creates no folder.
 *
 * ISOLATION: a throwaway POWERRP_PROJECTS_DIR and an ephemeral backend + Vite on
 * free ports (the asset_ux_probe.js precedent) — never the live dev setup, and
 * never a real project. The seed deck is built here, so this probe does not
 * depend on any checked-in project existing.
 *
 * Run:
 *   node src/demo_apps/PowerRP/tests/import_zip_probe.js
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// `uv run`, never a hardcoded interpreter: the asset_ux_probe.js rule (a pinned
// /opt/homebrew path made that probe permanently red on Linux).
const PY = "uv";
const PY_ARGS = ["run", "server.py"];
const SEED = "zip_probe_deck";
// The 1x1 red PNG the other probes use — it decodes cleanly through
// gpu/image_registry.js. Its only job here is to be an ASSET that must survive
// the zip round trip byte for byte.
const PROBE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A drop is an upload + an unpack + a project load + a repaint. Generous, because
// a too-short wait here reports a slow machine as a broken feature.
const IMPORT_SETTLE_MS = 6000;

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server never became ready at ${url}`);
}

/** Command (drives the page). Drops `bytes` on the canvas as an OS file drag of
 *  `filename`, via a real DataTransfer — so the app's own drop handler runs, the
 *  same one a Finder drag reaches. The in-page function is deliberately
 *  SYNCHRONOUS: returning a promise to puppeteer here lets a GC collect it
 *  mid-import ("Promise was collected"); the caller's settle wait is the join. */
async function dropZip(page, filename, bytes) {
  await page.evaluate((name, b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([buf], name, { type: "application/zip" }));
    const target = document.querySelector(".overlay") ?? document.querySelector("canvas");
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: dt,
                   clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
  }, filename, Buffer.from(bytes).toString("base64"));
}

const failures = [];
const check = (ok, label) => { console.log(`${ok ? "[ok]" : "[FAIL]"} ${label}`); if (!ok) failures.push(label); };

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_import_zip_probe_"));
let pyServer, viteServer, browser;
try {
  // ── Seed a project with a real asset (built here — no checked-in dependency) ─
  mkdirSync(join(projectsRoot, SEED, "assets"), { recursive: true });
  writeFileSync(join(projectsRoot, SEED, "assets", "seed.png"), Buffer.from(PROBE_PNG_B64, "base64"));
  writeFileSync(join(projectsRoot, SEED, "doc.json"), JSON.stringify({
    meta: { name: SEED },
    slides: [{ id: "s0", name: "Slide 0", delta: {} }, { id: "s1", name: "Slide 1", delta: {} }],
  }));

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
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  // ── 1. EXPORT through the real endpoint ───────────────────────────────────
  const dl = await fetch(`${backendBase}/api/download/${encodeURIComponent(SEED)}/`);
  const zipBytes = Buffer.from(await dl.arrayBuffer());
  check(dl.ok && zipBytes.subarray(0, 2).toString() === "PK", `exported .zip is a real archive (${zipBytes.length} bytes)`);

  browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  // WebGPU/VideoV7 are absent on a GPU-less box and REPORT their fallback (the
  // fontpicker_probe.js clause). The last two entries are step 5's OWN loud
  // refusal — the thing that step exists to produce, so it is expected output.
  const IGNORE_CONSOLE = /WebGPU|VideoV7|importProjectZip\(Broken\)|400 \(Bad Request\)/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE_CONSOLE.test(m.text())) pageErrors.push(`console.error: ${m.text()}`); });

  await page.goto(pageBase, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
  await page.evaluate((p) => { window.__powerrp_app.loadProject(p); }, SEED);
  await sleep(2500);
  check(await page.evaluate(() => window.__powerrp_app.projectName()) === SEED, "booted into the source project");

  // ── 2. A DROPPED .ZIP OPENS AN UNSAVED DRAFT — the library is NOT touched ──
  // REWRITTEN FOR THE WORKING-COPY MODEL (9f386e9 + 31d5a8d). This scenario used
  // to assert the de-collision: dropping a zip whose name was already taken
  // opened "<seed> 2" and said so in a modal. That behavior is GONE, and its
  // absence is the model working rather than a regression — app.svelte.js's own
  // docblock states it: "a draft has no name in the library to collide with, and
  // the name shown is simply what the user dropped". The user's ruling was "It
  // shouldn't have to save until the user decides to save - that goes for
  // uploading zips too".
  //
  // So the assertion INVERTS. What used to be proven (a second library entry
  // appears, renamed) is now exactly what must NOT happen; what must happen is a
  // draft: `projectName()` returns the DRAFT KEY (the storage keyspace),
  // `projectDisplayName()` returns the dropped deck's human name, `draftMode` is
  // set, and `/api/projects/` still lists precisely one project.
  await dropZip(page, `${SEED}.zip`, zipBytes);
  await sleep(IMPORT_SETTLE_MS);
  const drafted = await page.evaluate(() => ({
    key: window.__powerrp_app.projectName(),
    display: window.__powerrp_app.projectDisplayName(),
    draftMode: window.__powerrp_app.draftMode,
    everSaved: window.__powerrp_app.everSaved,
    slides: window.__powerrp_app.doc.slides.length,
  }));
  check(drafted.key.startsWith("~draft/"), `the drop staged into the DRAFT keyspace (projectName()=${JSON.stringify(drafted.key)})`);
  check(drafted.display === SEED, `the draft carries the dropped deck's own name (projectDisplayName()=${JSON.stringify(drafted.display)}, want ${JSON.stringify(SEED)})`);
  check(!!drafted.draftMode, `draftMode is set, so the app knows this is a working copy (${JSON.stringify(drafted.draftMode)})`);
  check(drafted.everSaved === false, "an imported draft is NOT in correspondence with the library (everSaved=false)");
  check(drafted.slides === 2, `the imported deck carries its slides (${drafted.slides})`);
  // THE LOAD-BEARING HALF: nothing was written to the library. Before the draft
  // model this listed two projects (the seed and its "<seed> 2" de-collision).
  const afterDrop = (await (await fetch(`${backendBase}/api/projects/`)).json()).map((p) => p.name);
  check(afterDrop.length === 1 && afterDrop[0] === SEED,
    `the library is UNTOUCHED by a drop — still exactly the seed (${JSON.stringify(afterDrop)})`);
  const stillThere = await (await fetch(`${backendBase}/api/project/${encodeURIComponent(SEED)}/`)).json();
  check(stillThere.doc?.meta?.name === SEED, "the ORIGINAL project survived the import");

  // ── 3. ASSETS came with it, staged under the draft key ────────────────────
  // Also rewritten: with no library entry there is no `/api/assets/<name>/` to
  // GET. A draft ALWAYS stages locally (IndexedDB) in both storage modes, so the
  // asset is read back through the app's own store seam instead of over HTTP —
  // which is the more faithful check anyway, because that seam is what the
  // canvas, thumbnails and exports actually resolve through.
  const stagedAssets = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const list = await app.listProjectAssets(); // defaults to projectName() = the draft key
    const blob = list.length ? await window.__powerrp_storage.assetStore().get(app.projectName(), list[0].name) : null;
    const bytes = blob ? [...new Uint8Array(await blob.arrayBuffer())] : null;
    return { names: list.map((a) => a.name), bytes };
  });
  check(stagedAssets.names.length === 1 && stagedAssets.names[0] === "seed.png",
    `the .zip carried its asset library into the draft staging (${stagedAssets.names.join(", ") || "nothing"})`);
  check(stagedAssets.bytes !== null && Buffer.from(stagedAssets.bytes).equals(Buffer.from(PROBE_PNG_B64, "base64")),
    "the staged asset is byte-identical to what the archive carried");

  // ── 4. A SECOND DROP replaces the working copy, still writing nothing ──────
  // The old scenario proved a "free" name opened under the dropped file's name
  // and showed no modal. Under the draft model there is no free-vs-taken
  // distinction at all, so what is worth proving is that dropping a SECOND zip
  // swaps the working copy cleanly (rather than accumulating drafts or, worse,
  // finally writing one to the library).
  await dropZip(page, "Zip Probe Copy.zip", zipBytes);
  await sleep(IMPORT_SETTLE_MS);
  const second = await page.evaluate(() => ({
    key: window.__powerrp_app.projectName(),
    display: window.__powerrp_app.projectDisplayName(),
    draftMode: !!window.__powerrp_app.draftMode,
  }));
  check(second.display === "Zip Probe Copy", `the second drop is now the working copy ("${second.display}")`);
  check(second.key.startsWith("~draft/") && second.draftMode, "still an unsaved draft, not a library entry");
  const afterSecond = (await (await fetch(`${backendBase}/api/projects/`)).json()).map((p) => p.name);
  check(afterSecond.length === 1 && afterSecond[0] === SEED,
    `two drops later the library is STILL just the seed (${JSON.stringify(afterSecond)})`);

  // ── 5. REFUSAL — loud, and it changes nothing ─────────────────────────────
  await dropZip(page, "Broken.zip", Buffer.from("this is definitely not a zip archive"));
  await sleep(3000);
  const junk = await page.evaluate(() => ({
    display: window.__powerrp_app.projectDisplayName(),
    modal: document.querySelector(".name-modal")?.innerText ?? null,
  }));
  check(junk.display === "Zip Probe Copy", "a refused import leaves the open working copy untouched");
  check(!!junk.modal && /not imported/i.test(junk.modal), "the refusal is REPORTED in a modal");
  const listed = (await (await fetch(`${backendBase}/api/projects/`)).json()).map((p) => p.name);
  check(!listed.includes("Broken"), "a refused import created no project folder");

  if (pageErrors.length) { console.log("PAGE ERRORS:\n" + pageErrors.join("\n")); failures.push(`${pageErrors.length} page errors`); }
} finally {
  browser && (await browser.close());
  viteServer && (await viteServer.close());
  pyServer && pyServer.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}

console.log(failures.length ? `\nFAILURES (${failures.length}):\n- ${failures.join("\n- ")}` : "\nALL IMPORT-ZIP PROBE CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
