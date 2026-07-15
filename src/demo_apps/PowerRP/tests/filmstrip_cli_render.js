/**
 * Filmstrip END-TO-END CLI proof (W2c): render a REAL filmstrip from the
 * fixture video through the FULL chain, headlessly, to a PNG.
 *
 *   1. Start the project server (server.py) on a free port.
 *   2. Seed a project with the deterministic fixture video (tiny_video.mp4).
 *   3. Hit GET /api/frames/<proj>/<video>/<N>/ — the server extracts N
 *      evenly-spread frames and returns their served URLs (ABSOLUTE-ised to the
 *      backend so the headless page can fetch them directly).
 *   4. Build a filmstrip document with those frameUrls in state.
 *   5. Render it through the SAME GpuCompositor the editor/CLI use (Vite +
 *      puppeteer), warming the frame images first (the async rule), → out.png.
 *
 * This exercises server extraction + the widget's state→URL mapping + emit() +
 * the GPU compositor together — the real filmstrip, from the real fixture.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/filmstrip_cli_render.js <out.png>
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// The Vite root is the REPO root (like the parity harness) so absolute
// /src/demo_apps/PowerRP/… module imports resolve in the headless page.
const REPO_ROOT = resolve(HERE, "../../../..");
const FIXTURE = join(HERE, "fixtures", "tiny_video.mp4");
// System Python 3.10 (has fire+rp+numpy per the repo convention). The server's
// `serve` command needs neither rp nor numpy (only `ports` imports rp), so this
// runs the server without the uv env — and sidesteps the uv env's missing-numpy
// issue in `ports` (FLAGGED to the lead: server PEP-723 deps omit numpy, which
// rp needs transitively, so `uv run server.py ports` currently fails).
const PY = "/opt/homebrew/opt/python@3.10/bin/python3.10";

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

const outPath = process.argv[2] || join(tmpdir(), "filmstrip_cli.png");
const N = 6; // the one control: frame count
const W = 900, H = 200;

/** Query. Poll a URL until it answers 200 (or throw after `tries`). */
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

// A throwaway projects root so the test never touches real projects.
const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_filmstrip_cli_"));
const proj = "cli_demo", video = "tiny_video.mp4";
mkdirSync(join(projectsRoot, proj, "assets"), { recursive: true });
copyFileSync(FIXTURE, join(projectsRoot, proj, "assets", video));

// Start the server (system python3.10 — `serve` needs no rp/numpy) with
// PROJECTS_DIR redirected to our throwaway root.
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

  // 3. Extract real frames from the fixture video via the endpoint.
  const framesRes = await (await fetch(`${base}/api/frames/${proj}/${video}/${N}/`)).json();
  if (!framesRes.frames || framesRes.frames.length !== N)
    throw new Error(`frames endpoint returned ${JSON.stringify(framesRes)}`);
  const frameUrls = framesRes.frames.map((u) => base + u); // absolute → page can fetch
  console.log(`extracted ${framesRes.count} frames:`, framesRes.frames.map((u) => u.split("/").pop()).join(" "));

  // 4. Build a filmstrip document. Slide 0 creates + activates the widget with
  //    the resolved frame URLs (the state→URL mapping the app effect fills).
  const doc = {
    meta: { name: "filmstrip-cli", cameraRect: { x: 0, y: 0, w: W, h: H } },
    slides: [{
      id: "s0", name: "Slide 0",
      delta: {
        items: {
          strip: {
            type: "filmstrip", active: true,
            x: 20, y: 20, w: W - 40, h: H - 40, z: 0, rotation: 0, scale: 1,
            src: video, frames: N, frameUrls, opacity: 1,
          },
          cam: { type: "camera", active: true, x: 0, y: 0, w: W, h: H, z: 100, background: "#202028" },
        },
      },
    }],
  };

  // 5. Render through the real GPU compositor (Vite + puppeteer), warming images.
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: join(REPO_ROOT, "vite.config.js"),
    root: REPO_ROOT,
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  const { default: puppeteer } = await import("puppeteer");
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  page.on("console", (m) => { if (m.type() === "error") console.log("[page.error]", m.text()); });
  await page.goto(`${pageBase}/index.html`, { waitUntil: "domcontentloaded" });

  const dataUrl = await page.evaluate(async (docObj, w, h) => {
    const M = {
      compositor: await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js"),
      imageRegistry: await import("/src/demo_apps/PowerRP/render_gpu/gpu/image_registry.js"),
      derive: await import("/src/demo_apps/PowerRP/core/derive.js"),
      expr: await import("/src/demo_apps/PowerRP/core/expressions.js"),
      viewMod: await import("/src/demo_apps/PowerRP/core/view.js"),
      ports: await import("/src/demo_apps/PowerRP/render_gpu/ports.js"),
      registry: await import("/src/demo_apps/PowerRP/core/registry.js"),
      commands: await import("/src/demo_apps/PowerRP/core/commands.js"),
      plugins: await import("/src/demo_apps/PowerRP/plugins/index.js"),
      doc: await import("/src/demo_apps/PowerRP/core/document.js"),
      ir: await import("/src/demo_apps/PowerRP/render_gpu/ir.js"),
    };
    const registry = M.registry.createRegistry();
    M.plugins.registerAll(registry, M.commands.createCommands());
    const full = M.doc.withCameraEnsured(docObj);
    const state = M.expr.evaluateState(M.doc.foldState(full, 0, 1), registry).state;

    // Warm every frame image BEFORE the sync render (the async rule: the
    // compositor draws nothing for an undecoded src).
    const refs = [...new Set(state.items.strip.frameUrls)];
    await Promise.all(refs.map((r) => M.imageRegistry.ensureImage(r)));

    const rect = M.derive.cameraRect(state, full.meta);
    const view = M.viewMod.fitRectView(rect, w, h, 1);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const gpu = await M.compositor.GpuCompositor.create(canvas);
    gpu.render(M.ports.sceneIR(M.derive.deriveRenderTree(state, registry)), view,
      { background: M.ir.parseColor(rect.background) });
    const px = await gpu.readPixels(0, 0, w, h);
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    out.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
    return out.toDataURL("image/png");
  }, doc, W, H);

  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, png);

  // Non-trivial output = frames actually drew (a blank strip would be tiny/uniform).
  if (png.length < 2000) throw new Error(`output PNG suspiciously small (${png.length}b) — frames may not have drawn`);
  console.log(`\nFILMSTRIP CLI RENDER OK -> ${outPath} (${png.length} bytes, ${W}x${H}, ${N} frames from ${video})`);
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
}
