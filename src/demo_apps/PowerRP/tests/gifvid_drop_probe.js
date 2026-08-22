/**
 * ANIMATED GIFs ARE VIDEOS — the END-TO-END gesture (workstream GIFVID_).
 *
 * The user asked "how does our powerrp handle gifs? as videos hopefully?" and the
 * measured answer was no: `.gif` is an IMAGE everywhere, the image paint path is one
 * `createImageBitmap`, so an animated GIF sat on the canvas FROZEN AT FRAME ONE with
 * nothing said about it. server.py now transcodes an animated GIF to mp4 during the
 * upload and web/gifVideo.js decides what to insert from that reply.
 *
 * Those two halves are pinned separately (tests/gifvid_server_test.py,
 * tests/gifvid_kind_test.js). THIS probe pins the thing neither can see: that
 * DROPPING AN ANIMATED GIF ON THE CANVAS, in the real app, through the real drop
 * handler, against a real backend, produces a VIDEO WIDGET playing the mp4. The
 * chain has five links (drop handler → uploadAsset → HTTP → ffmpeg → insert), and a
 * break in any one of them looks identical to the user: a still picture.
 *
 *   1. ANIMATED GIF → VIDEO WIDGET. The dropped item's `type` is the video widget
 *      and its `src` names the .mp4 — NOT the .gif.
 *   2. THE .gif IS STILL IN THE LIBRARY. The transcode ADDS an asset, it does not
 *      replace the user's file; the listing holds both.
 *   3. SINGLE-FRAME GIF → IMAGE WIDGET, unchanged. The same gesture with a
 *      one-frame GIF must still make an image, or this feature broke still GIFs.
 *
 * ISOLATION (the probe.jpg incident rule): its own mkdtemp projects root, its own
 * Python backend on an ephemeral port, its own Vite proxied to it. Never the live
 * dev setup, never the user's projects/ folder.
 *
 * Run (exit-code gated, from the SvelteLib repo root):
 *   node src/demo_apps/PowerRP/tests/gifvid_drop_probe.js
 */
import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// `uv run`, never a hardcoded interpreter: the dump must work on a wiped container.
const PY = "uv";
const PY_ARGS = ["run", "server.py"];
const PROJECT = "gifvid_probe";

// The SAME committed fixtures the python test uses — 11x7 (odd on both axes), 4
// frames and 1 frame, under 1KB each. Shared deliberately: if the two halves of
// this feature ever disagree about what "animated" means, they must disagree about
// the same file.
const ANIMATED_GIF = join(HERE, "fixtures", "gifvid_animated.gif");
const STILL_GIF = join(HERE, "fixtures", "gifvid_still.gif");

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

/** Query. Poll `read` until it answers non-null, up to ~6s. */
async function settle(read, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

const errors = [];
const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_gifvid_probe_"));
let pyServer, viteServer, browser;
try {
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

  // vite.config.js reads BACKEND_URL at CONFIG-EVAL time, so it is set BEFORE
  // createServer imports the config (the paste_upload_probe.js precedent).
  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  viteServer = await createViteServer({
    configFile: join(APP_DIR, "web", "vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // WebGPU/VideoV7 report-and-fall-back on a GPU-less box — a working fallback, not
  // a failure of this probe (the fontpicker_probe.js clause).
  const IGNORE_CONSOLE = /WebGPU|VideoV7/i;
  // A BOOT ERROR THIS PROBE DID NOT CAUSE IS REPORTED, NOT FATAL — and this split is
  // the whole reason it is written down rather than folded into IGNORE_CONSOLE.
  // PowerRP is developed by many agents in one tree, so at any moment the app may
  // carry someone else's in-flight defect (measured, repeatedly: a shortcut with an
  // unsatisfiable `when`, a `plugins/index.js` importing a file its own commit
  // deleted). A probe that dies on ANY console error then reports a RED that says
  // nothing about GIFs — the exact "a red that says nothing about what this probe
  // tests" failure tests/asset_ux_probe.js's freePort comment records. So boot noise
  // is PRINTED (never swallowed — a suppressed error is how a real regression hides)
  // and the run continues; only errors naming THIS feature's own modules are fatal,
  // because those are the ones this probe is the right place to catch.
  const MINE = /gif|transcode|video|upload|asset/i;
  const bootNoise = [];
  const record = (text) => (MINE.test(text) ? errors : bootNoise).push(text);
  page.on("pageerror", (e) => record(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE_CONSOLE.test(m.text())) record(`console.error: ${m.text()}`); });

  await page.evaluateOnNewDocument((name) => {
    localStorage.setItem("powerrp.autosave", JSON.stringify({
      meta: { name }, slides: [{ id: "s0", name: "Slide 0", delta: {} }],
    }));
  }, PROJECT);
  await page.goto(`${pageBase}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  if (errors.length) throw new Error("PAGE ERRORS AT BOOT (naming this feature's own modules):\n" + errors.join("\n"));
  if (bootNoise.length) {
    console.log(`NOTE: ${bootNoise.length} unrelated boot error(s) from other work in this tree — reported, not fatal:`);
    for (const n of bootNoise) console.log(`   ${n.slice(0, 160)}`);
  }

  /** Command. Drop one GIF (given as base64) on the canvas as a native OS file
   *  drag — a real DragEvent carrying a real File, dispatched at the canvas, which
   *  is the exact path onCanvasDrop serves. Returns the item added, if any. */
  const dropGif = async (b64, filename) => {
    const before = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items ?? {}));
    await page.evaluate(async (data, fname) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const file = new File([bytes], fname, { type: "image/gif" });
      const dt = new DataTransfer();
      dt.items.add(file);
      // THE DROP TARGET IS THE SVG `.overlay`, NOT THE `<canvas>`. CanvasView binds
      // ondragover/ondrop on the overlay that sits ABOVE the Skia canvas (it is the
      // element that owns every pointer gesture), so a DragEvent dispatched at the
      // canvas hits a node with no handler and is silently ignored — which reads in
      // the results as "the drop added no item", i.e. exactly like a broken feature.
      const el = document.querySelector(".overlay") ?? document.querySelector("canvas");
      const r = el.getBoundingClientRect();
      const at = { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
      for (const type of ["dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
      }
    }, b64, filename);
    return settle(async () => page.evaluate((prior) => {
      const items = window.__powerrp_app.doc.slides[0].delta.items ?? {};
      const id = Object.keys(items).find((k) => !prior.includes(k));
      return id ? { id, ...items[id] } : null;
    }, before));
  };

  // ── CHECK 1: AN ANIMATED GIF BECOMES A VIDEO WIDGET ────────────────────────
  const animatedB64 = readFileSync(ANIMATED_GIF).toString("base64");
  const item = await dropGif(animatedB64, "spinner.gif");
  if (!item) {
    errors.push("[1] dropping an animated GIF on the canvas added NO item at all");
  } else {
    const src = String(item.src ?? "");
    if (!/video/i.test(String(item.type)))
      errors.push(`[1] FROZEN GIF: an animated GIF inserted a "${item.type}" widget, not a video one — this is the defect the feature exists to fix`);
    else if (!src.endsWith(".mp4"))
      errors.push(`[1] the video widget points at ${JSON.stringify(src)} — expected the transcoded .mp4 sibling`);
    else console.log(`[1] ANIMATED → VIDEO ok: dropping spinner.gif inserted a "${item.type}" widget with src=${src}`);
  }

  // ── CHECK 2: THE ORIGINAL .gif IS STILL IN THE LIBRARY ─────────────────────
  const listing = await (await fetch(`${backendBase}/api/assets/${PROJECT}/`)).json();
  const names = listing.map((a) => a.name);
  if (!names.includes("spinner.gif"))
    errors.push(`[2] the uploaded .gif is GONE from the library — the transcode must ADD an asset, not replace the user's file (listing: ${names.join(", ")})`);
  else if (!names.includes("spinner.mp4"))
    errors.push(`[2] no spinner.mp4 sibling in the library (listing: ${names.join(", ")})`);
  else console.log(`[2] LIBRARY ok: both spinner.gif and spinner.mp4 are listed (${names.join(", ")})`);

  // ── CHECK 3: A SINGLE-FRAME GIF IS STILL AN IMAGE ──────────────────────────
  const stillB64 = readFileSync(STILL_GIF).toString("base64");
  const stillItem = await dropGif(stillB64, "logo.gif");
  if (!stillItem) {
    errors.push("[3] dropping a single-frame GIF added NO item at all");
  } else if (!/image/i.test(String(stillItem.type))) {
    errors.push(`[3] a SINGLE-FRAME GIF inserted a "${stillItem.type}" widget — a still GIF must still be an image`);
  } else if (!String(stillItem.src ?? "").endsWith(".gif")) {
    errors.push(`[3] the still GIF's image widget points at ${JSON.stringify(stillItem.src)} — expected the .gif itself`);
  } else {
    const after = (await (await fetch(`${backendBase}/api/assets/${PROJECT}/`)).json()).map((a) => a.name);
    if (after.includes("logo.mp4"))
      errors.push("[3] a single-frame GIF was transcoded anyway — it must be left alone");
    else console.log(`[3] STILL GIF ok: logo.gif inserted a "${stillItem.type}" widget with src=${stillItem.src}, no mp4 written`);
  }

  if (errors.length) {
    console.error("\nGIF-VIDEO DROP PROBE FAILURES:\n" + errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("\nALL GIF-VIDEO DROP CHECKS PASSED");
  }
} finally {
  browser && (await browser.close());
  viteServer && (await viteServer.close());
  pyServer && pyServer.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
