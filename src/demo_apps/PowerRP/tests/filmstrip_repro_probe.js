/**
 * 14.4 REPRO PROBE (throwaway project — never touches real projects).
 *
 * Reproduces the user's bug: "i changed frames to 18 and nothing is happening.
 * is something going on in the backend? no clue. no feedback."
 *
 * Boots the real project server (server.py) on an ephemeral port + the real app
 * (Vite + puppeteer) pointed at it via ?backend=, seeds a project with the
 * fixture video, then drives the app's OWN methods (window.__powerrp_app):
 *   1. add a filmstrip
 *   2. set its src to the fixture video (bare filename, like AssetField writes)
 *   3. observe whether frameUrls populate at the initial `frames`
 *   4. change frames -> 18 and observe whether frameUrls re-populate
 * At each step it dumps the filmstrip state + any console errors, so we can SEE
 * exactly which of the three candidate causes fires (empty src skip / url-vs-
 * filename / slow-no-feedback).
 *
 * Run: node src/demo_apps/PowerRP/tests/filmstrip_repro_probe.js
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, copyFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const WEB_ROOT = join(APP_DIR, "web");
const FIXTURE = join(HERE, "fixtures", "tiny_video.mp4");
const PY = "/opt/homebrew/opt/python@3.10/bin/python3.10";

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never ready at ${url}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_repro_"));
const proj = "ReproProj", video = "tiny_video.mp4";
mkdirSync(join(projectsRoot, proj, "assets"), { recursive: true });
copyFileSync(FIXTURE, join(projectsRoot, proj, "assets", video));

const backendPort = await freePort();
const server = spawn(PY, ["server.py", "serve", `--port=${backendPort}`], {
  cwd: join(APP_DIR, "server"),
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
try {
  const base = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${base}/api/projects/`);

  const { createServer } = await import("vite");
  viteServer = await createServer({ configFile: join(WEB_ROOT, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  const { default: puppeteer } = await import("puppeteer");
  browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`${m.type()}: ${m.text()}`); });

  // Point the app at our throwaway backend AND name the doc the throwaway project.
  await page.goto(`${pageBase}/?backend=${encodeURIComponent(base)}`, { waitUntil: "networkidle0" });
  await sleep(500);

  const dumpState = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const s = window.__probe_state?.();
    return { id: window.__probe_id, state: s };
  });

  // Step 0: name the doc = our project, add a filmstrip, capture its id.
  await page.evaluate((projName) => {
    const app = window.__powerrp_app;
    app.doc = { ...app.doc, meta: { ...app.doc.meta, name: projName } };
    // Add filmstrip via the plugin command path (addItem sets selection = id).
    app.addItem({ type: "filmstrip", x: 100, y: 100, w: 480, h: 90, z: 0, rotation: 0, scale: 1,
      src: "", frames: 6, frameUrls: [] });
    window.__probe_id = app.selection;
    window.__probe_state = () => {
      const items = window.__powerrp_app.doc.slides[0].delta.items;
      const it = items[window.__probe_id];
      return it ? { src: it.src, frames: it.frames,
        frameUrlsCount: Array.isArray(it.frameUrls) ? it.frameUrls.length : `NOT-ARRAY(${typeof it.frameUrls})`,
        firstUrl: Array.isArray(it.frameUrls) && it.frameUrls[0] ? it.frameUrls[0].slice(0, 80) : null } : null;
    };
  }, proj);
  await sleep(400);
  console.log("STEP 0 (added filmstrip, empty src):", JSON.stringify(await dumpState()));

  // Step 1: set src to the bare filename (exactly what AssetField assetForm:"filename" writes).
  await page.evaluate((v) => {
    const app = window.__powerrp_app;
    const id = window.__probe_id;
    app.setPreview([[["items", id, "src"], v]]);
    app.commitPreview();
  }, video);
  await sleep(2500); // give the fetch + ffmpeg extraction time
  console.log("STEP 1 (set src=bare filename, waited 2.5s):", JSON.stringify(await dumpState()));

  // Step 2: change frames -> 18 (the user's exact action).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const id = window.__probe_id;
    app.setPreview([[["items", id, "frames"], 18]]);
    app.commitPreview();
  });
  await sleep(3000);
  console.log("STEP 2 (frames->18, waited 3s):", JSON.stringify(await dumpState()));

  // Also try the URL form of src (candidate cause b): full served path.
  await page.evaluate((v, projName) => {
    const app = window.__powerrp_app;
    const id = window.__probe_id;
    app.setPreview([[["items", id, "src"], `/asset/${projName}/${v}`]]);
    app.commitPreview();
  }, video, proj);
  await sleep(2500);
  console.log("STEP 3 (src=URL form '/asset/Proj/file', waited 2.5s):", JSON.stringify(await dumpState()));

  console.log("\n--- CONSOLE ERRORS/WARNINGS SEEN ---");
  console.log(consoleErrors.length ? consoleErrors.join("\n") : "(none)");

  // Direct endpoint sanity: does the server actually extract for this project?
  const direct = await (await fetch(`${base}/api/frames/${proj}/${video}/18/`)).json();
  console.log("\nDIRECT ENDPOINT /api/frames/.../18/ ->", JSON.stringify(direct).slice(0, 200));
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
}
