/**
 * THE HTML2IMAGE PRESET LIBRARY probe — THE REAL PROOF, in the booted editor,
 * with a real headless-Chrome capture through the actual sandboxed-iframe +
 * foreignObject rasterization pipeline (web/html2image.js captureHtmlToAsset).
 *
 * WHY THIS PROBE HAS TO EXIST, AND WHY BARE NODE CANNOT REPLACE IT.
 * tests/html2image_presets_test.js proves the STRINGS are distinct, guard-clean
 * and shaped correctly — but this widget's whole design is "the browser IS the
 * renderer" (plugins/html2image.js's header): the pixels a preset actually
 * produces depend on real CSS layout, real flexbox, real gradient rasterization
 * and real font metrics that no bare-node suite can execute (cli/render.js's
 * own docs admit it has no DOM and cannot draw this widget's captured images
 * meaningfully without one). So "do the presets render distinctly" is
 * EXACTLY the question a bare-node test cannot answer for this widget — this
 * probe is the one honest gate for it, the case the task brief calls out
 * explicitly.
 *
 * SHAPE. Mirrors tests/asset_ux_probe.js for the throwaway backend + Vite
 * scaffolding (a REAL project server is required — captureHtmlToAsset calls
 * assetStoreFor() -> store.put(), which needs a live POST /api/assets/ target,
 * unlike tests/aperture_presets_probe.js's pure-preview presets which never
 * write an asset) and tests/aperture_presets_probe.js for the addItem /
 * runCommand / litSetDistance sweep pattern.
 *
 * PER PRESET: insert a fresh html2image widget, write the preset's `html` via
 * setPreview+commitPreview (the same seam app.applyPreset uses — see
 * core/registry.js "app.applyPreset writes exactly the keys in preset.props"),
 * select it, run the REAL "capture-html" command's own `run` function directly
 * (`app.commands.get("capture-html").run(app)`, NOT `app.runCommand(...)` —
 * see the note at the call site: runCommand is intentionally fire-and-forget,
 * so awaiting it resolves before the async capture lands), wait for the async
 * capture to land a non-empty `capture` ref, then screenshot the canvas region
 * the widget now renders into.
 *
 * ── THE OFF-VIEWPORT rAF STALL IS FIXED; THIS IS A REAL PIXEL GATE ─────────
 * This header used to say that every capture under this harness "reliably TIMES
 * OUT" on web/html2image.js's 15 s CAPTURE_TIMEOUT_MS, that the stall was a
 * Puppeteer/headless property, that "a real browser is not known to reproduce
 * this", and therefore that the failures below should be read as an honest
 * environment limitation rather than a defect. THAT DOCTRINE WAS OBSOLETE FIVE
 * MINUTES AFTER IT WAS WRITTEN and the last clause of it was never true.
 * e53112a6 fixed the CAUSE: the capture frame was positioned `left: -20000px`, and
 * an OFF-VIEWPORT frame receives exactly ONE requestAnimationFrame tick before the
 * compositor stops scheduling it, while captureDocument's report path needs TWO
 * (fonts.ready -> rAF -> rAF). The frame now sits at the origin under
 * `visibility: hidden; opacity: 0`, which ticks — measured 10/10 against 1/10 for
 * both `left:-20000px` and `clip-path: inset(100%)`. Offscreen-frame throttling is
 * ORDINARY compositor behaviour, so the old positioning was a latent defect in real
 * editors too; "not known to reproduce" was reasoning standing in for a measurement.
 * SO THE PAIRWISE PIXEL CHECKS BELOW ARE THE REAL GATE, and a capture that times out
 * here is a REGRESSION to be fixed, never this file's stated limitation.
 *
 * ── A BOOT THAT CRASHED IS NOT A PRESET FAILURE, AND THIS PROBE USED TO CONFLATE
 *    THEM. `window.__powerrp_app` exists well before the app works — it is set on the
 * store, not on a painted frame. On a COLD `node_modules/.vite`, one run had the dep
 * optimizer break a dynamic import ("Skia/WebGL init failed: Failed to fetch
 * dynamically imported module ... @pdf-lib_fontkit.js", painted IN the splash) and
 * this probe still scored "capture-html ran without throwing" and "capture wrote a
 * non-empty asset ref" as PASSES while all fourteen screenshots were byte-identical
 * (md5 acd42019...) — a dead host surfacing as thirteen pairwise-distinguishability
 * reds. So the sweep now starts behind the same gate tests/prod_boot_probe.js
 * states: `#boot-splash` is removed at the FIRST REAL CANVAS PAINT and `failed` is a
 * one-way latch, so the splash SURVIVING with crash text is a crash even if a frame
 * arrives later. A crashed boot throws the splash's own sentence instead of measuring
 * pixels that mean nothing.
 *
 * ISOLATION (the asset_ux_probe.js rule, the probe.jpg incident): a throwaway
 * project directory (mkdtemp), a throwaway backend on an ephemeral port, a
 * throwaway Vite instance proxied to it. Never touches the user's real
 * projects/ or port 3637/3638.
 *
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/html2image_presets_probe.js [shot_dir]
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer as createViteServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { freePort } from "./free_port.js";
import { readPng, litSetDistance, imageDistance } from "./imageDistinctness.js";
import { html2imagePlugin } from "../plugins/html2image.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const SVELTE_LIB = resolve(APP_DIR, "../../..");
// uv run, never a hardcoded interpreter path — the asset_ux_probe.js lesson
// (a pinned python3.10 path dies with ENOENT on any host but the author's Mac).
const PY = "uv";
const PY_ARGS = ["run", "server.py"];
const PROJECT = "html2image_presets_probe";
const shots = process.argv[2] ?? resolve(APP_DIR, ".claude_vlm_checks/html2image_presets");
mkdirSync(shots, { recursive: true });

const PRESETS = html2imagePlugin.presets;
// A big box, centred, so a captured 1280x720 PNG (DEFAULT_CAPTURE_W/H) is
// letterboxed rather than heavily downscaled in the canvas screenshot — the
// aperture probe's "measure distinctness, not the framing's insensitivity"
// reasoning, applied here.
const BOX = { x: 80, y: 60, w: 1280, h: 720 };
// Generous: a real sandboxed-iframe capture does a full font/layout settle
// (document.fonts.ready + 2 rAF) PLUS an SVG->canvas decode, per preset.
const CAPTURE_TIMEOUT_MS = 20000;
const SETTLE_MS = 300;
const BOOT_MS = 900;
const BOOT_TIMEOUT_MS = 60000;

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

const failures = [];
const errors = [];
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_html2image_presets_probe_"));
let pyServer, viteServer, browser;
try {
  // ── A real project the asset store can write into ──────────────────────────
  mkdirSync(join(projectsRoot, PROJECT, "assets"), { recursive: true });
  writeFileSync(
    join(projectsRoot, PROJECT, "doc.json"),
    JSON.stringify({ meta: { name: PROJECT }, slides: [{ id: "s0", name: "Slide 0", delta: {} }] }),
  );

  const backendPort = await freePort();
  pyServer = spawn(PY, [...PY_ARGS, "serve", `--port=${backendPort}`], {
    cwd: join(APP_DIR, "server"),
    env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
    stdio: ["ignore", "inherit", "inherit"],
  });
  pyServer.on("error", (e) => { throw e; });
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  viteServer = await createViteServer({
    configFile: resolve(APP_DIR, "web/vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  // Boot straight into the seeded project (autosave doc whose meta.name matches
  // the seeded directory — the asset_ux_probe.js precedent for making
  // app.projectName() and the backend's asset store agree).
  //
  // TOP-FRAME ONLY, AND THAT GUARD IS LOAD-BEARING HERE SPECIFICALLY.
  // evaluateOnNewDocument injects into EVERY frame of the page per CDP, which
  // ordinarily doesn't matter — but THIS probe's whole point is driving a REAL
  // capture-html run, and web/html2image.js deliberately gives the sandboxed
  // capture iframe an OPAQUE origin (sandbox="allow-scripts", no
  // allow-same-origin — see that file's header). Without `window === window.top`
  // this script re-runs inside that opaque-origin iframe too and
  // `localStorage.setItem` throws a SecurityError there, which surfaces as a
  // pageerror and (worse) can starve the capture's own message-based handshake.
  // Confirmed by removing the guard: every capture then failed with exactly
  // this SecurityError inside the sandboxed frame. This is a probe-harness
  // artifact, not anything a real user hits — a real page load never runs
  // Puppeteer's evaluateOnNewDocument at all.
  await page.evaluateOnNewDocument((name) => {
    if (window !== window.top) return;
    localStorage.setItem("powerrp.autosave", JSON.stringify({
      meta: { name }, slides: [{ id: "s0", name: "Slide 0", delta: {} }],
    }));
  }, PROJECT);
  await page.goto(`${pageBase}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  // THE BOOT-SUCCESS GATE — see this file's header. The splash is `position: fixed;
  // inset: 0` and is REMOVED at the first real canvas paint, so its absence is the
  // only honest "the app is up"; `data-failed="1"` is the one-way crash latch.
  // Resolving on EITHER means a crash is reported the moment it is decided rather
  // than after the full budget.
  const boot = await page.waitForFunction(
    () => {
      const s = document.getElementById("boot-splash");
      if (s === null) return { painted: true, text: "" };
      if (s.getAttribute("data-failed") === "1") return { painted: false, text: s.innerText || s.textContent || "" };
      return false;
    },
    { timeout: BOOT_TIMEOUT_MS, polling: 250 },
  ).then((h) => h.jsonValue()).catch(() => ({ painted: false, text: "the first frame never painted and the splash never reported a crash" }));
  // THROWN, not pushed onto `failures`: every check after this one would be measuring
  // a dead page, and thirteen meaningless reds is precisely the report this gate
  // exists to stop being produced.
  if (!boot.painted) throw new Error(`PowerRP did not boot — the pixel checks below would be meaningless. Splash said: ${JSON.stringify(boot.text.replace(/\s+/g, " ").slice(0, 400))}`);
  console.log("  ok   the boot splash lifted — the first frame painted");
  await new Promise((r) => setTimeout(r, BOOT_MS));
  const bootErrors = errors.length;
  if (bootErrors) console.log(`  (${bootErrors} console error(s) already present at boot — treated as baseline noise, not this probe's failure)`);

  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  // Dark, neutral camera backdrop so a preset with a transparent/near-white
  // area doesn't get swallowed by a default white canvas.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const camera = app.cameraState()?.id;
    if (camera) { app.setPreview([[["items", camera, "background"], "#20222b"]]); app.commitPreview(); }
  });

  /** Query. PNG of the canvas viewport region. */
  const canvasShot = async () => (await page.$(".canvas-wrap")).screenshot();

  const frames = [];
  for (let i = 0; i < PRESETS.length; i++) {
    const preset = PRESETS[i];

    // Insert a fresh html2image widget at the fixed box, write the preset's
    // html through the SAME setPreview->commitPreview seam app.applyPreset
    // uses, then run the REAL "capture-html" command.
    const outcome = await page.evaluate(async ({ type, box, html }) => {
      const app = window.__powerrp_app;
      app.addItem({ ...app.registry.get(type).defaults, type, ...box });
      const id = app.selectedNode()?.id;
      if (!id) return { ok: false, error: "addItem produced no selection" };
      app.setPreview([[["items", id, "html"], html]]);
      app.commitPreview();
      // NOT app.runCommand("capture-html") — that method is fire-and-forget by
      // design (web/app.svelte.js runCommand calls `cmd.run(this)` without
      // awaiting or returning it, since the palette never awaits a command
      // either), so awaiting IT resolves as soon as the synchronous prefix of
      // captureSelectedHtml returns, well before the asset write lands. This
      // calls the SAME command entry's `run` directly and awaits that promise —
      // still the real command the palette/Inspector button invoke, just
      // awaited correctly for a probe that needs to know when it finished.
      try {
        await app.commands.get("capture-html").run(app);
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
      const capture = app.selectedNode()?.state?.capture ?? "";
      return { ok: true, id, capture };
    }, { type: html2imagePlugin.type, box: BOX, html: preset.props.html });

    check(`${preset.name}: capture-html ran without throwing`, outcome.ok, outcome.error ?? "");
    if (!outcome.ok) continue;

    // Poll briefly — commitPreview lands synchronously but the async
    // captureHtmlToAsset promise the command awaits may still be settling one
    // microtask later on a slow host.
    let captureRef = outcome.capture;
    for (let tries = 0; !captureRef && tries < Math.ceil(CAPTURE_TIMEOUT_MS / 200); tries++) {
      await new Promise((r) => setTimeout(r, 200));
      captureRef = await page.evaluate((id) => window.__powerrp_app.selectedNode()?.state?.capture ?? "", outcome.id);
    }
    check(`${preset.name}: capture wrote a non-empty asset ref`, !!captureRef, JSON.stringify(captureRef));
    if (!captureRef) continue;

    await settle();
    const png = await canvasShot();
    const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    writeFileSync(`${shots}/${String(i + 1).padStart(2, "0")}_${slug}.png`, png);
    frames.push({ name: preset.name, png: readPng(png) });
  }

  check("every preset produced a comparable captured frame", frames.length === PRESETS.length,
    `${frames.length}/${PRESETS.length}`);

  // ── PAIRWISE DISTINCTNESS ON THE CAPTURED BITMAPS ───────────────────────────
  // The reference is a BLANK canvas shot (no widget), per the rect/codeblock
  // preset-probe precedent: comparing against the widget's own filled default
  // would undercount two presets that happen to share a backdrop tone.
  await page.evaluate((type) => {
    const app = window.__powerrp_app;
    const id = app.selectedNode()?.id;
    if (id != null) { app.setPreview([[["items", id, "active"], false]]); app.commitPreview(); }
  }, html2imagePlugin.type);
  await settle();
  const blank = readPng(await canvasShot());
  writeFileSync(`${shots}/00_reference_blank.png`, await canvasShot());

  let narrowest = null;
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const distance = litSetDistance(frames[i].png, frames[j].png, blank);
      const distinguishable = distance.maxAbs >= 1 && distance.coverage > 0;
      check(`"${frames[i].name}" vs "${frames[j].name}": pairwise distinguishable on captured pixels`,
        distinguishable, `meanAbs ${distance.meanAbs.toFixed(3)}, maxAbs ${distance.maxAbs}, lit coverage ${(distance.coverage * 100).toFixed(1)}%`);
      if (!narrowest || distance.meanAbs < narrowest.distance.meanAbs)
        narrowest = { a: frames[i].name, b: frames[j].name, distance };
    }
  }
  if (narrowest)
    console.log(`\n  narrowest pair: "${narrowest.a}" vs "${narrowest.b}" — meanAbs ${narrowest.distance.meanAbs.toFixed(3)}, maxAbs ${narrowest.distance.maxAbs}, ${(narrowest.distance.coverage * 100).toFixed(1)}% lit coverage`);

  const newErrors = errors.slice(bootErrors);
  check("no new console errors across the whole sweep", newErrors.length === 0, newErrors.slice(0, 5).join(" | "));
  console.log(`\n  ${frames.length}/${PRESETS.length} presets captured; shots in ${shots.replace(SVELTE_LIB, ".")}`);
} finally {
  if (browser) await browser.close();
  if (viteServer) await viteServer.close();
  if (pyServer) pyServer.kill();
  rmSync(projectsRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nhtml2image preset probe: all checks passed");
