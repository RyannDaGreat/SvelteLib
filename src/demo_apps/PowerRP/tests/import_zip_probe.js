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
 * WHAT IS PROVEN, in order:
 *   1. EXPORT     — GET /api/download/<seed>/ yields a real archive.
 *   2. COLLISION  — dropping it back (its name is taken) opens "<seed> 2", the
 *                   ORIGINAL survives untouched, and a modal states the rename.
 *   3. ASSETS     — the imported project's asset is listed AND served with the
 *                   same bytes: a .zip carries the assets, not just doc.json.
 *   4. FREE NAME  — a differently-named drop opens under the dropped file's own
 *                   name with NO modal (nothing surprising happened to report).
 *   5. REFUSAL    — a junk .zip shows the failure, leaves the open project alone,
 *                   and creates no folder.
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

  // ── 2. COLLISION — the dropped name is taken, so it lands as "<seed> 2" ────
  await dropZip(page, `${SEED}.zip`, zipBytes);
  await sleep(IMPORT_SETTLE_MS);
  const collide = await page.evaluate(() => ({
    name: window.__powerrp_app.projectName(),
    slides: window.__powerrp_app.doc.slides.length,
    modal: document.querySelector(".name-modal")?.innerText ?? null,
  }));
  check(collide.name === `${SEED} 2`, `dropped .zip opened as "${SEED} 2" (renamed, never an overwrite)`);
  check(!!collide.modal && collide.modal.includes(`${SEED} 2`), "the collision rename is REPORTED in a modal, not silent");
  check(collide.slides === 2, `the imported deck carries its slides (${collide.slides})`);
  const stillThere = await (await fetch(`${backendBase}/api/project/${encodeURIComponent(SEED)}/`)).json();
  check(stillThere.doc?.meta?.name === SEED, "the ORIGINAL project of that name survived the import");
  await page.evaluate(() => [...document.querySelectorAll(".name-modal-actions .btn")].find((b) => b.innerText.trim() === "OK")?.click());
  await sleep(500);

  // ── 3. ASSETS came with it, and are really served ─────────────────────────
  const assets = await (await fetch(`${backendBase}/api/assets/${encodeURIComponent(`${SEED} 2`)}/`)).json();
  check(assets.length === 1 && assets[0].name === "seed.png", `the .zip carried the asset library (${assets.map((a) => a.name).join(", ") || "nothing"})`);
  const served = Buffer.from(await (await fetch(`${backendBase}${assets[0].url}`)).arrayBuffer());
  check(served.equals(Buffer.from(PROBE_PNG_B64, "base64")), "the imported asset is served byte-identical");

  // ── 4. FREE NAME — opens quietly under the dropped file's own name ─────────
  await dropZip(page, "Zip Probe Copy.zip", zipBytes);
  await sleep(IMPORT_SETTLE_MS);
  const free = await page.evaluate(() => ({
    name: window.__powerrp_app.projectName(),
    modalOpen: !!document.querySelector(".name-modal"),
  }));
  check(free.name === "Zip Probe Copy", 'a free name opens under the dropped file\'s own name ("Zip Probe Copy")');
  check(!free.modalOpen, "no modal when nothing surprising happened");

  // ── 5. REFUSAL — loud, and it changes nothing ─────────────────────────────
  await dropZip(page, "Broken.zip", Buffer.from("this is definitely not a zip archive"));
  await sleep(3000);
  const junk = await page.evaluate(() => ({
    name: window.__powerrp_app.projectName(),
    modal: document.querySelector(".name-modal")?.innerText ?? null,
  }));
  check(junk.name === "Zip Probe Copy", "a refused import leaves the open project untouched");
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
