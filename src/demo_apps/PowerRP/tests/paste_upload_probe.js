/**
 * Paste-to-upload probe (manifest 13.3 PASTE-TO-UPLOAD): synthesizes a native
 * `paste` window event carrying an image Blob (as DataTransfer.files, the
 * same shape the OS clipboard gives a real Cmd+V) and asserts (a) an upload
 * request actually reaches the project server's /api/upload/ endpoint and
 * (b) a new "image" widget lands in the document afterward.
 *
 * Follows the filmstrip_cli_render.js precedent exactly for isolation: an
 * EPHEMERAL project server (POWERRP_PROJECTS_DIR = a mkdtemp throwaway root,
 * a free port — never 3637/the real backend) + an ephemeral Vite dev server
 * (free port, BACKEND_URL pointed at the throwaway server) + puppeteer. The
 * throwaway projects root is removed on exit either way (rmSync in finally).
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/paste_upload_probe.js
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(HERE, "../../../..");
// The project server runs through uv (server.py carries PEP 723 inline deps) —
// the same portable launcher start_server.sh uses, so there is no hardcoded
// interpreter path. Override with POWERRP_UV if uv is not on PATH.
const UV = process.env.POWERRP_UV || "uv";

/** Query. A free TCP port (bind :0, read the assigned port, release). */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/** Query. Poll a URL until it answers 200 (or throw after `tries`). */
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

// A throwaway projects root — this probe must NEVER write into the user's
// real projects/ folder (manifest rule 13.7, the probe.jpg incident).
const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_paste_upload_"));

const backendPort = await freePort();
const server = spawn(UV, ["run", "server.py", "serve", `--port=${backendPort}`], {
  cwd: join(APP_DIR, "server"),
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
const errors = [];
try {
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  // Ephemeral app server, proxying /api + /asset to the ephemeral backend
  // (vite.config.js reads BACKEND_URL at config-eval time).
  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: resolve(APP_DIR, "web/vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageUrl = `http://127.0.0.1:${viteServer.httpServer.address().port}/`;

  const { default: puppeteer } = await import("puppeteer");
  // SwiftShader flags so the WebGPU compositor inits headless (the editor renders
  // through it, and copySelection rasterizes its PNG through it); --no-sandbox is
  // required to launch as root (the container's default user). Same flag set the
  // repo's other WebGPU probes use (skia_browser_qa.js, boot_probe.js).
  browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // EXPECTED headless noise: the per-widget VideoV7 overlay tries to acquire a
  // WebGPU device and, finding no adapter in headless SwiftShader, LOUDLY reports
  // its 2D-drawImage fallback (web/VideoV7Overlay.svelte). That is the correct
  // reported-fallback behavior, not a defect, and is orthogonal to the clipboard
  // path (the Skia scene + copySelection's PNG rasterize headless without WebGPU).
  const EXPECTED_NOISE = [/VideoV7: WebGPU init failed/];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  page.on("pageerror", (e) => {
    if (!isExpectedNoise(e.message)) errors.push(`pageerror: ${e.message}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) errors.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") console.log(`[page.warn] ${m.text()}`);
  });

  // Watch network for the upload POST landing (assertion (a)).
  let uploadSeen = false;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/upload/")) uploadSeen = true;
  });

  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  if (errors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + errors.join("\n"));

  // Name the project (so uploadAsset's default projectName() targets a real,
  // throwaway-root folder rather than "Untitled" — either works server-side,
  // but naming it makes the probe's intent explicit).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.doc.meta.name = "paste_probe";
  });

  const itemCountBefore = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return Object.keys(app.doc.slides[0].delta.items).length;
  });

  // Synthesize a native `paste` window event carrying an image Blob as
  // DataTransfer.files — the same shape a real OS clipboard image paste
  // gives `e.clipboardData.files`. DataTransfer is constructible in Chromium;
  // ClipboardEvent accepts it as clipboardData directly.
  const pasteResult = await page.evaluate(async () => {
    // 1x1 red PNG (smallest valid PNG, base64).
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "probe_paste.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    const defaultPrevented = !window.dispatchEvent(evt); // dispatchEvent returns false if preventDefault() was called
    return { defaultPrevented };
  });
  if (!pasteResult.defaultPrevented)
    errors.push("onPaste did not preventDefault() — the file-paste branch may not have run");

  // pasteFiles is async (upload → insert); poll for the new item + the upload
  // network request rather than a fixed sleep.
  let itemCountAfter = itemCountBefore;
  for (let i = 0; i < 60; i++) {
    itemCountAfter = await page.evaluate(() => {
      const app = window.__powerrp_app;
      return Object.keys(app.doc.slides[0].delta.items).length;
    });
    if (itemCountAfter > itemCountBefore && uploadSeen) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!uploadSeen) errors.push("No POST to /api/upload/ observed — paste did not upload the pasted file");
  if (itemCountAfter <= itemCountBefore) errors.push(`No new widget inserted (items ${itemCountBefore} -> ${itemCountAfter})`);

  // Read PRIMITIVES only (not the $state-proxied item object itself) — Svelte
  // 5's deep $state proxies don't survive puppeteer's structured-clone
  // serialization (documented gotcha, concerns.md 2026-07-15).
  const newImageNode = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const imgId = Object.keys(items).find((id) => items[id].type === "image" && items[id].src?.includes("probe_paste"));
    if (!imgId) return null;
    const it = items[imgId];
    return { src: it.src, w: it.w, h: it.h, x: it.x, y: it.y };
  });
  if (!newImageNode) errors.push("No image-type widget with src matching the pasted file was found in the document");
  else console.log(`inserted image widget: src=${newImageNode.src} w=${newImageNode.w} h=${newImageNode.h} x=${newImageNode.x} y=${newImageNode.y}`);

  // Confirm the upload actually landed a file server-side in the throwaway
  // project (not the user's real projects/ folder) — belt-and-suspenders on
  // top of the network-request assertion.
  const assetsListing = await (await fetch(`${backendBase}/api/assets/paste_probe/`)).json();
  if (!assetsListing.some((a) => a.name.includes("probe_paste")))
    errors.push(`Uploaded asset not found via /api/assets/: ${JSON.stringify(assetsListing)}`);
  else console.log(`asset on server: ${JSON.stringify(assetsListing.find((a) => a.name.includes("probe_paste")))}`);

  // Internal element paste still works: a files-less paste must fall through to
  // the SERVER-clipboard element paste, not upload anything. Select the pasted
  // image, copy it (server clipboard + OS render), then reproduce a Cmd/Ctrl+V
  // gesture. Under the single-authority model the native `paste` event is what
  // pastes (the keydown binding is nativeEvent, so it no longer dispatches);
  // we fire both a real keydown AND a files-less `paste` event, and the
  // files-less event routes app.pasteFromClipboard([]) → pasteClipboard().
  // Assert the element paste runs (item count increases) and no upload fires.
  let uploadCountAfterCompose = 0;
  page.removeAllListeners("request");
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/upload/")) uploadCountAfterCompose++;
  });
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const imgId = Object.keys(items).find((id) => items[id].type === "image");
    app.selection = imgId;
    await app.copySelection();
  });
  const composeBefore = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.keyboard.down("Meta"); // Cmd on Chromium/macOS maps to metaKey
  await page.keyboard.press("KeyV");
  await page.keyboard.up("Meta");
  await page.evaluate(() => {
    const evt = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  });
  await new Promise((r) => setTimeout(r, 400));
  const composeAfter = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  if (composeAfter <= composeBefore)
    errors.push(`Internal widget-paste path regressed: item count ${composeBefore} -> ${composeAfter} after a files-less paste`);
  if (uploadCountAfterCompose > 0)
    errors.push("A files-less paste (internal widget JSON) triggered an upload request — should not happen");
  else console.log("compose check ok: files-less paste used the pre-existing internal-copy path, no upload fired");

  if (errors.length) {
    // Throw (not process.exit) so the `finally` below still runs — exit()
    // terminates synchronously and would skip cleanup, leaking the throwaway
    // server/project dir on every failing run (caught in review: three
    // leaked temp project dirs from earlier iterations of this exact probe).
    throw new Error("PROBE FAILURES:\n" + errors.join("\n"));
  }
  console.log("\nPASTE-TO-UPLOAD PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
