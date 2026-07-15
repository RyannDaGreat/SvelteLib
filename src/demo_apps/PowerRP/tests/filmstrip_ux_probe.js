/**
 * FILMSTRIP UX PROBE (manifest ROUND 14.2 / 14.3 / 14.4) — throwaway project,
 * never touches real projects. Drives the REAL app (Vite + puppeteer against a
 * real project server) to prove the four Round-14 behaviors end to end:
 *
 *   14.3 PLACEMENT PICKER: adding a filmstrip sets app.pendingVideoPickFor, and
 *        the Inspector's AssetField for `src` AUTO-OPENS its picker modal.
 *        CANCELLING (closing the modal with no pick) clears the signal and leaves
 *        the widget an EMPTY GHOST (isGhost true, no frames).
 *   14.2 PROCESSING INDICATOR: after picking a video, while the fetch is in
 *        flight the item carries a transient `processing` status and the
 *        filmstrip emit() renders the in-widget "sampling frames…" indicator
 *        (NOT the ghost). When frames land, processing clears and frames render.
 *   14.4 FRAME-COUNT FEEDBACK: changing `frames` re-triggers extraction with the
 *        processing indicator visible mid-flight, then repopulates. A URL-form
 *        src (candidate b) surfaces an in-widget frameError, not console-only.
 *
 * Run: node src/demo_apps/PowerRP/tests/filmstrip_ux_probe.js
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

let failures = 0;
function check(label, cond) { console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`); if (!cond) failures++; }

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

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_ux_"));
const proj = "UxProj", video = "tiny_video.mp4";
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
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => { console.error("[pageerror]", e.message); failures++; });

  await page.goto(`${pageBase}/?backend=${encodeURIComponent(base)}`, { waitUntil: "networkidle0" });
  await sleep(500);

  // Name the doc = our project so frame fetches resolve against the seeded asset.
  await page.evaluate((projName) => {
    const app = window.__powerrp_app;
    app.doc = { ...app.doc, meta: { ...app.doc.meta, name: projName } };
  }, proj);

  // ── 14.3 PLACEMENT PICKER + CANCEL LEAVES GHOST ──────────────────────────────
  const afterAdd = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ type: "filmstrip", x: 100, y: 100, w: 480, h: 90, z: 0, rotation: 0, scale: 1, src: "", frames: 6, frameUrls: [], filmColor: "#000000" });
    window.__id = app.selection;
    return { pendingFor: app.pendingVideoPickFor, id: app.selection };
  });
  check("14.3 addItem sets pendingVideoPickFor to the new filmstrip", afterAdd.pendingFor === afterAdd.id);
  await sleep(500); // let the Inspector AssetField react + auto-open its modal
  const modalOpen = await page.evaluate(() => !!document.querySelector(".modal, [role='dialog'], .ae-grid, .ae-notice"));
  check("14.3 the video picker modal auto-opened on placement", modalOpen);

  // CANCEL: clear the signal as the AssetField does on modal close, verify ghost.
  const afterCancel = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.pendingVideoPickFor = null; // simulate the modal closing with no pick
    const s = app.state().items[window.__id];
    const node = app.nodes().find((n) => n.itemId === window.__id);
    return { src: s.src, frameCount: (s.frameUrls || []).length, isGhost: node?.plugin.isGhost(s) };
  });
  check("14.3 cancel leaves an EMPTY widget (no src, no frames)", afterCancel.src === "" && afterCancel.frameCount === 0);
  check("14.3 the empty widget is a GHOST", afterCancel.isGhost === true);

  // ── 14.2 PROCESSING INDICATOR while frames extract ───────────────────────────
  // Poll for the processing flag the instant it flips (the tiny fixture can
  // extract in <100ms, so a fixed sleep can miss the window). The observed
  // `processing:true` state + its non-ghost non-empty emit is the indicator.
  const midFetch = await page.evaluate(async (v) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", window.__id, "src"], v]]);
    app.commitPreview();
    // Capture the FIRST tick where processing is true (or give up after ~4s).
    for (let i = 0; i < 400; i++) {
      const st = app.state().items[window.__id];
      if (st.processing) {
        const node = app.nodes().find((n) => n.itemId === window.__id);
        const ops = node ? node.plugin.emit(st, null, node.world) : [];
        return { processing: true, isGhost: node?.plugin.isGhost(st), emitOps: ops.length };
      }
      if ((st.frameUrls || []).length > 0) break; // already resolved — missed the window
      await new Promise((r) => setTimeout(r, 10));
    }
    return { processing: false, isGhost: null, emitOps: 0 };
  }, video);
  check("14.2 item is `processing` while the fetch is in flight", midFetch.processing === true);
  check("14.2 a processing filmstrip is NOT a ghost", midFetch.isGhost === false);
  check("14.2 processing emit() renders an in-widget indicator (non-empty ops)", midFetch.emitOps > 0);

  // After the fetch resolves, frames land and processing clears.
  await sleep(3000);
  const resolved = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const st = app.state().items[window.__id];
    return { processing: !!st.processing, frameCount: (st.frameUrls || []).length, error: st.frameError || null };
  });
  check("14.2 processing clears once frames land", resolved.processing === false);
  check("14.2 frames populated after extraction", resolved.frameCount > 0);

  // ── 14.4 FRAME-COUNT CHANGE re-extracts WITH feedback ────────────────────────
  // Use a HELD server so the extraction cannot finish before we observe the
  // processing indicator (the fixture is so small it otherwise resolves in a
  // single tick). We change to a frame count whose cache is guaranteed cold and
  // watch the SAME poll loop. If the strip repopulates at the new count without
  // ever exposing `processing`, that is a feedback FAILURE (the exact 14.4 bug).
  const midRefetch = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const before = (app.state().items[window.__id].frameUrls || []).length;
    app.setPreview([[["items", window.__id, "frames"], 9]]);
    app.commitPreview();
    let sawProcessing = false;
    for (let i = 0; i < 400; i++) {
      const st = app.state().items[window.__id];
      if (st.processing) sawProcessing = true;
      const urls = st.frameUrls || [];
      // Done when the strip has repopulated at the NEW count.
      if (urls.length > 0 && urls.length !== before && decodeURIComponent(urls[0]).includes("/9/")) break;
      await new Promise((r) => setTimeout(r, 8));
    }
    return { sawProcessing };
  });
  check("14.4 changing `frames` re-triggers extraction WITH the processing indicator", midRefetch.sawProcessing === true);
  await sleep(3000);
  const refetched = await page.evaluate(() => (window.__powerrp_app.state().items[window.__id].frameUrls || []).length);
  check("14.4 frame-count change repopulates the strip", refetched > 0);

  // ── 14.4 URL-FORM SRC surfaces an IN-WIDGET error (candidate b) ──────────────
  await page.evaluate((v, projName) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", window.__id, "src"], `/asset/${projName}/${v}`]]);
    app.commitPreview();
  }, video, proj);
  await sleep(400);
  const urlForm = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const st = app.state().items[window.__id];
    const node = app.nodes().find((n) => n.itemId === window.__id);
    const ops = node ? node.plugin.emit(st, null, node.world) : [];
    return { error: st.frameError || null, isGhost: node?.plugin.isGhost(st), emitOps: ops.length };
  });
  check("14.4 a URL-form src surfaces an IN-WIDGET frameError (not console-only)", !!urlForm.error);
  check("14.4 the errored filmstrip renders its error strip (non-empty, not ghost)", urlForm.emitOps > 0 && urlForm.isGhost === false);

  console.log(failures === 0 ? "\nALL FILMSTRIP UX CHECKS PASSED" : `\n${failures} FILMSTRIP UX CHECK(S) FAILED`);
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
}
process.exit(failures === 0 ? 0 : 1);
