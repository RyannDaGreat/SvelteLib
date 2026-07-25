/**
 * Open Project preview-GRID probe. Verifies the upgraded "Open Project…" command
 * (App.svelte): the modal is a GRID of cards, one per saved server project, each
 * showing a first-slide thumbnail rendered CLIENT-side (gpuService), plus that
 * clicking a card loads THAT project (meta.name matches).
 *
 * Isolation mirrors paste_upload_probe.js: an EPHEMERAL project server
 * (POWERRP_PROJECTS_DIR = a mkdtemp throwaway root, a free port — never the real
 * backend) + an ephemeral Vite (free port, BACKEND_URL → the throwaway server) +
 * puppeteer. The throwaway root is removed on exit. Three distinct projects are
 * seeded via the save API (each a different camera background + rectangle so the
 * previews are visibly different). A screenshot of the grid lands in
 * .claude_vlm_checks/ for a VLM sanity read.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/open_project_grid_probe.js
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { newDocument } from "../core/document.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const VLM_DIR = join(APP_DIR, ".claude_vlm_checks");
const SETTLE_MS = 4000; // Skia wasm + fonts + first paint before we drive the app
const THUMB_TIMEOUT_MS = 30000; // budget for all previews to rasterize + stream in

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
async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

/** Query. A distinct seed doc: a colored camera background + a contrasting
 *  rectangle on slide 0, an optional trailing empty slide (to vary slideCount).
 *  Camera id is the sole item newDocument() creates. */
function seedDoc(name, background, rectFill, extraSlides = 0) {
  const doc = newDocument();
  doc.meta = { ...doc.meta, name };
  const slide0 = doc.slides[0];
  const items = { ...slide0.delta.items };
  const camId = Object.keys(items)[0];
  items[camId] = { ...items[camId], background };
  items[`rect_${name.replace(/\W/g, "")}`] = {
    type: "rect", x: 320, y: 170, w: 640, h: 380, z: 1, rotation: 0, scale: 1,
    active: true, fill: rectFill, stroke: "#101014", strokeWidth: 8, opacity: 1,
  };
  const slides = [{ ...slide0, delta: { ...slide0.delta, items } }];
  for (let i = 0; i < extraSlides; i++) {
    slides.push({ id: `s${i}_${name}`, name: `Slide ${i + 2}`, transition: slide0.transition, delta: {} });
  }
  return { ...doc, slides };
}

const SEEDS = [
  { name: "Sunrise Deck", background: "#f7768e", rectFill: "#ffd27a", extraSlides: 2 },
  { name: "Ocean Notes", background: "#1f6feb", rectFill: "#7dcfff", extraSlides: 0 },
  { name: "Forest Plan", background: "#2ea043", rectFill: "#d7ffb0", extraSlides: 1 },
];

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_open_grid_"));
const backendPort = await freePort();
const server = spawn("uv", ["run", "server.py", "serve", `--port=${backendPort}`], {
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

  // Seed the three projects through the save API (the SAME endpoint Save-to-Server hits).
  for (const s of SEEDS) {
    const res = await fetch(`${backendBase}/api/project/${encodeURIComponent(s.name)}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seedDoc(s.name, s.background, s.rectFill, s.extraSlides)),
    });
    if (!res.ok) throw new Error(`seed PUT ${s.name} → ${res.status}`);
  }
  const listed = await (await fetch(`${backendBase}/api/projects/`)).json();
  if (listed.length !== SEEDS.length) throw new Error(`expected ${SEEDS.length} projects, server lists ${listed.length}`);

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
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /preview render failed/.test(m.text())) errors.push(`preview failure: ${m.text()}`);
  });

  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  if (!(await page.evaluate(() => !!window.__powerrp_app))) throw new Error("app never initialized (__powerrp_app absent)");

  // Open the modal via the SAME command the palette/toolbar run.
  await page.evaluate(() => window.__powerrp_app.openProject());
  await page.waitForSelector(".open-project-grid .open-project-card", { timeout: 8000 });

  const cardCount = await page.$$eval(".open-project-card", (cards) => cards.length);
  if (cardCount !== SEEDS.length) throw new Error(`grid shows ${cardCount} cards, expected ${SEEDS.length}`);

  // Poll until every card's thumbnail is a real (non-empty) data URL.
  const deadline = Date.now() + THUMB_TIMEOUT_MS;
  let states = [];
  while (Date.now() < deadline) {
    states = await page.$$eval(".open-project-card", (cards) =>
      cards.map((c) => {
        const img = c.querySelector("img");
        const src = img?.getAttribute("src") || "";
        return {
          name: c.querySelector(".open-project-card-name")?.textContent ?? "",
          meta: c.querySelector(".open-project-card-meta")?.textContent ?? "",
          isData: src.startsWith("data:image/"),
          bytes: src.length,
        };
      }));
    if (states.every((s) => s.isData && s.bytes > 1000)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const notReady = states.filter((s) => !(s.isData && s.bytes > 1000));
  if (notReady.length) throw new Error(`thumbnails never rendered: ${notReady.map((s) => s.name).join(", ")}`);
  console.log("Cards + thumbnails:", JSON.stringify(states, null, 2));

  // Screenshot the grid for a VLM read.
  mkdirSync(VLM_DIR, { recursive: true });
  const shotPath = join(VLM_DIR, "open_project_grid.png");
  const panel = await page.$(".modal-panel");
  await (panel ?? page).screenshot({ path: shotPath });
  console.log("Screenshot:", shotPath);

  // Click a specific card → it must load THAT project (meta.name matches) and close the modal.
  const target = "Ocean Notes";
  await page.evaluate((name) => {
    const card = [...document.querySelectorAll(".open-project-card")]
      .find((c) => c.querySelector(".open-project-card-name")?.textContent === name);
    card.click();
  }, target);
  await new Promise((r) => setTimeout(r, 1500));
  const loadedName = await page.evaluate(() => window.__powerrp_app.projectName());
  const modalGone = await page.evaluate(() => !document.querySelector(".open-project-grid"));
  if (loadedName !== target) throw new Error(`clicked "${target}" but loaded project is "${loadedName}"`);
  if (!modalGone) throw new Error("modal did not close after clicking a card");

  if (errors.length) throw new Error("captured errors:\n" + errors.join("\n"));
  console.log(`OPEN-GRID OK — ${cardCount} preview cards rendered, click loaded "${loadedName}", modal closed.`);
} catch (e) {
  console.error("OPEN-GRID FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (viteServer) await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
