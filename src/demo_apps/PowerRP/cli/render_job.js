/**
 * PowerRP headless RENDER-JOB worker — the frame producer for a DETACHED
 * server-side MP4 render (server/server.py's render-job supervisor spawns it).
 *
 * It boots THE REAL EDITOR in a headless browser and asks it for frames. There
 * are no pixels in this file: everything that decides what a frame looks like
 * lives in web/renderJobPage.js, running in the page, through the editor's own
 * modules. This file owns only the OUTSIDE of the render — the browser, the
 * shard, and the files.
 *
 * ── WHY A BROWSER (user ruling, 2026-07-28: "the renderer is one code path") ──
 * The first version of this worker rendered in BARE NODE on a software Skia
 * surface (cli/render.js → render_gpu/skia/node_render.js). That was a SECOND
 * renderer, and a second renderer silently loses whatever the first one has:
 * image / video / PDF / filmstrip drew NOTHING (no `createImageBitmap` in node),
 * LaTeX threw (MathJax needs a DOM), Mermaid died on a font load, motion blur was
 * refused (no canvas to average sub-frames on), and it could never use a GPU —
 * `CanvasKit.MakeSurface` never asks for a context, so it is CPU-only on any
 * hardware. Worse, it looked fine: a media/LaTeX/Mermaid deck rendered with holes
 * in it and reported success.
 *
 * A headless browser is not a new dependency — `puppeteer` is already in
 * package.json, dozens of test files boot it, and `npm install` fetches Chrome.
 * And it is not merely "also works": render_gpu/skia/browser_surface.js has NO
 * CPU branch. It always calls GetWebGLContext → MakeWebGLContext and throws
 * without WebGL2, so the app never chooses between CPU and GPU — ANGLE chooses
 * underneath, binding SwiftShader on a GPU-less box (measured here) and a real
 * driver where there is one. Sharing that module is the MECHANISM by which the
 * backend gets a GPU at all.
 *
 * ── WHAT IT WRITES ────────────────────────────────────────────────────────────
 * `frame_%06d.png` into the job's frames/ dir, one per output frame of its SHARD.
 * The file COUNT is the progress signal — no IPC, no heartbeat file, nothing to
 * lose. A supervisor (or any HTTP client) reads it by listing a directory.
 *
 * ── THE TIMELINE IS COMPUTED IN THE PAGE ──────────────────────────────────────
 * The page repairs the snapshot, builds the timeline plan and returns the frame
 * COUNT; this side shards that count. Deriving the timeline twice (once here in
 * node, once in the page) would be two answers to "how long is this video?" and
 * they would eventually disagree.
 *
 * ── SHARDING: WHY FRAME-RANGE PARALLELISM IS SOUND HERE ───────────────────────
 * `--shard k --shards n` renders frames k, k+n, k+2n, … STRIDED (not contiguous)
 * so that a deck whose slides differ wildly in cost still spreads evenly across
 * workers. This is only legitimate because no document state is AUTOREGRESSIVE:
 * every widget is either PROPERTY state (computable from [[slide, alpha]] alone)
 * or RECORDABLE state (needs an ambient `t`, but is a pure function of it —
 * particle_clock's own docstring says a particle's picture is "a pure function of
 * (params, t, seed)"). Frame N therefore never needs frame N-1, and a worker can
 * jump straight to its own frames. If a genuinely autoregressive widget is ever
 * added — a physics sim carrying velocity across frames — this striding becomes
 * silently WRONG and the supervisor must fall back to a single shard.
 *
 * ── THE PARALLEL SHAPE IS MEASURED, NOT ASSUMED ───────────────────────────────
 * `--workers N` runs N INDEPENDENT BROWSERS inside this ONE process, sharing ONE
 * Vite dev server, each browser taking a sub-stride. Three shapes were timed on
 * a light 1920x1080 deck (32 frames, .frenzy/browser_worker/probe_shape.js):
 *
 *   1 browser,  1 tab       69.1 ms/frame
 *   1 browser,  4 tabs      46.5 ms/frame   (1.5x from 4x the tabs)
 *   1 browser,  8 tabs      65.5 ms/frame   (WORSE than 4 — contention)
 *   4 browsers, 1 tab ea.   26.8 ms/frame   (2.6x)
 *   8 browsers, 1 tab ea.   20.0 ms/frame   (3.5x)
 *
 * TABS BARELY PARALLELISE: Chrome hosts same-origin tabs in ONE renderer process,
 * so their main threads are the same thread and the renders queue behind each
 * other. Separate browsers are separate OS processes and actually scale.
 *
 * AND ONE PROCESS IS NOT A PREFERENCE — CONCURRENT VITE SERVERS DO NOT WORK.
 * The first shape tried was N worker PROCESSES, each starting its own dev server.
 * They share `node_modules/.vite`, so they race the dependency optimizer and
 * 504 ("Outdated Optimize Dep") each other's module graph out from under them
 * mid-render. One dev server per JOB, N browsers against it, is what holds.
 *
 * `--shard/--shards` remain for splitting a job across MACHINES (each with its
 * own checkout and dev server); the two knobs compose into one flat stride.
 *
 * ── WHICH GL BACKEND: SELECTABLE, LOGGED, AND NOT YET CONFIRMED ON A GPU ──────
 * The default Chrome flags do NOT force a rasterizer; they only PERMIT one (see
 * CHROME_ARGS). ANGLE then binds the best thing present, and the backend it chose
 * is printed in this worker's summary line, so "did the render use the GPU?" is
 * answered by a log rather than by an assumption.
 *
 * On the GPU-less container this was built on, the only two things demonstrable
 * were SwiftShader and (with system EGL present) Mesa llvmpipe. THE GPU CASE IS
 * UNVERIFIED. To confirm it on real hardware:
 *
 *   1. Render anything and read the worker's line in the server log:
 *        node cli/render_job.js <jobDir> --workers 1
 *      It prints `GL: <renderer>`. On this container that reads
 *        ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …), SwiftShader driver)
 *      On a GPU box it must instead name the real driver, e.g.
 *        ANGLE (NVIDIA, NVIDIA GeForce RTX … , OpenGL 4.5) — or a Vulkan device
 *        that is NOT "SwiftShader Device".
 *      Seeing "SwiftShader" on a machine that HAS a GPU means Chrome fell back;
 *      that is the failure to chase, and it is visible rather than silent.
 *   2. If it falls back, add flags without touching code:
 *        POWERRP_RENDER_CHROME_ARGS="--use-angle=gl-egl"      # system EGL/GLES driver
 *        POWERRP_RENDER_CHROME_ARGS="--use-angle=vulkan"      # native Vulkan
 *      (`--use-angle=gl-egl` additionally needs the system GLES loader —
 *      `libgles2` on Debian/Ubuntu. It was MISSING on this container, which is
 *      why the Mesa path could not be reproduced here.)
 *   3. Cross-check the timing: `Fractals` slide 1 at 640x360 measures 0.67 s/frame
 *      on SwiftShader here. A real GPU should be far below that. A GPU that
 *      reports itself but does not speed anything up means ANGLE named a driver it
 *      is not actually rasterizing on.
 *
 * Usage (spawned by the server; runnable by hand for debugging):
 *   node cli/render_job.js <jobDir> [--workers N] [--shard K] [--shards N]
 * where <jobDir> holds job.json (the params) and doc.json (the SNAPSHOT).
 * Run it from the SvelteLib repo root — the page is served by a Vite dev server
 * this process starts, exactly as the editor's own test harnesses do.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { parseArgs } from "./args.js";

/** Zero-padding for frame filenames. MUST equal server.py's EXPORT_FRAME_PAD: the
 *  ffmpeg input pattern is `frame_%06d.png`, and the padding is what makes the
 *  names sort lexicographically == numerically. */
const FRAME_INDEX_PAD = 6;
/** The editor's Vite config, resolved from THIS file so the dump stays portable. */
const VITE_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "vite.config.js");
/** The page half of this worker, as the dev server serves it (Vite root is web/). */
const PAGE_MODULE_URL = "/renderJobPage.js";
/**
 * Chrome flags for a render worker. Every one of them PERMITS something; none
 * forces a rasterizer, because the whole point is to let ANGLE bind the best
 * backend the machine has (a real driver where there is one, SwiftShader where
 * there is not).
 *   --no-sandbox              the sandbox needs privileges a container rarely has
 *   --disable-dev-shm-usage   containers ship a tiny /dev/shm; Chrome crashes on it
 *   --ignore-gpu-blocklist    headless Chrome blocklists many real drivers by default
 *   --enable-unsafe-swiftshader  allows the SwiftShader FALLBACK to be used at all
 *                             (without it, a GPU-less box gets no WebGL2 and the
 *                             Skia surface throws)
 */
const CHROME_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
/** Env override: extra Chrome flags, space-separated (see the header). */
const CHROME_ARGS_ENV = "POWERRP_RENDER_CHROME_ARGS";
/**
 * How long the FIRST page load of a browser may take. This is a STARTUP deadline,
 * not a cap on rendering work: the load is where Vite pre-bundles the four lazy
 * dependencies its config names (pdfjs-dist, mathjax, mathlive, mermaid), and that
 * cold "Forced re-optimization of dependencies" pass on a contended machine blew
 * straight through puppeteer's 30 s default and failed a whole job. Measured warm it
 * is ~2.6 s, so this is roughly 70x the observed cost — generous enough that only a
 * genuine hang trips it, and a trip is still a LOUD failure.
 */
const PAGE_LOAD_TIMEOUT_MS = 180_000;

/**
 * Pure function. The output frame indices a shard owns — a STRIDE over the whole
 * range, so cost variation across the timeline spreads evenly rather than handing
 * one worker every expensive slide.
 *
 * @param {number} total Total output frames in the timeline.
 * @param {number} shard 0-based shard index.
 * @param {number} shards Number of shards (>= 1).
 * @returns {number[]} ascending frame indices
 *
 * @example shardFrames(10, 0, 3) // [0, 3, 6, 9]
 * @example shardFrames(10, 2, 3) // [2, 5, 8]
 * @example shardFrames(4, 0, 1) // [0, 1, 2, 3]
 */
export function shardFrames(total, shard, shards) {
  const frames = [];
  for (let i = shard; i < total; i += shards) frames.push(i);
  return frames;
}

/**
 * Pure function. The frame filename for an output index, zero-padded so a plain
 * lexicographic listing is numeric order (what ffmpeg's %06d pattern requires).
 *
 * @param {number} index 0-based output frame index.
 * @returns {string}
 *
 * @example frameFileName(0) // "frame_000000.png"
 * @example frameFileName(1234) // "frame_001234.png"
 */
export function frameFileName(index) {
  return `frame_${String(index).padStart(FRAME_INDEX_PAD, "0")}.png`;
}

/**
 * Pure function. This process's shard split N ways — the global (shard, shards)
 * pair for each of its concurrent browsers. Composing the two levels as
 * `worker * shards + shard` keeps the whole fleet one flat stride over the
 * timeline, so no frame is rendered twice and none is missed however the job is
 * divided between machines and browsers.
 *
 * @param {number} shard This process's 0-based shard index.
 * @param {number} shards How many processes/machines the job was split across.
 * @param {number} workers How many browsers this process runs.
 * @returns {{shard: number, shards: number}[]} one entry per browser
 *
 * @example workerShards(0, 1, 1) // [{shard: 0, shards: 1}]
 * @example workerShards(0, 1, 3) // [{shard: 0, shards: 3}, {shard: 1, shards: 3}, {shard: 2, shards: 3}]
 * @example workerShards(1, 2, 3) // [{shard: 1, shards: 6}, {shard: 3, shards: 6}, {shard: 5, shards: 6}]
 */
export function workerShards(shard, shards, workers) {
  const out = [];
  for (let worker = 0; worker < workers; worker++) out.push({ shard: worker * shards + shard, shards: shards * workers });
  return out;
}

/**
 * Pure function. The Chrome flag list for this run: the permissive defaults plus
 * whatever `POWERRP_RENDER_CHROME_ARGS` adds. Blank-separated, empties dropped,
 * so an unset or empty variable changes nothing.
 *
 * @param {string|undefined} extra The raw environment value.
 * @returns {string[]}
 *
 * @example chromeArgs(undefined).includes("--enable-unsafe-swiftshader") // true
 * @example chromeArgs("--use-angle=gl-egl").slice(-1) // ["--use-angle=gl-egl"]
 * @example chromeArgs("  ").length === chromeArgs(undefined).length // true
 */
export function chromeArgs(extra) {
  return [...CHROME_ARGS, ...(extra ?? "").split(/\s+/).filter(Boolean)];
}

/**
 * Command (starts a Vite dev server). Serves the editor for this job — ONE
 * server, however many browsers render against it (see the header: concurrent
 * dev servers on one checkout 504 each other out).
 *
 * It is the SAME dev server the editor and every browser test uses (its own
 * vite.config.js), which is what makes "the backend runs the frontend's code"
 * literally true — including its `/api` and `/asset` proxy, so a project's image
 * assets resolve in the worker exactly as they do in the editor. `BACKEND_URL`
 * (set by the spawning server) is what that proxy points at.
 *
 * Returns:
 *   Promise<{url, close}> — `url` is the served origin.
 */
async function startDevServer() {
  const server = await createServer({
    configFile: VITE_CONFIG,
    server: {
      // No `port`: Vite probes upward from the port in vite.config.js, so a worker
      // never steals the one a running editor is already on. 127.0.0.1 because
      // nothing outside this machine has any business reaching a render worker.
      open: false,
      host: "127.0.0.1",
      // HMR OFF, WATCHER OFF — this is a correctness requirement, not a tidy-up.
      // A job SNAPSHOTS its document precisely so an edit mid-render cannot splice
      // two documents into one video; the CODE deserves the same treatment. With HMR
      // on, someone saving any source file mid-render pushes an update to the render
      // page, and a change Vite cannot hot-patch triggers a FULL PAGE RELOAD, which
      // destroys the open session and aborts the in-flight evaluate. Observed exactly
      // that while another editor was being worked on: "[vite] (client) page reload
      // core/document.js" a few seconds before the worker died. (vite.config.js's own
      // optimizeDeps comment records the same hazard for puppeteer probes.)
      hmr: false,
      watch: null,
    },
  });
  await server.listen();

  // AND THE DEP OPTIMIZER, which is the third way this server could destroy its own
  // job and the one the two settings above do NOT cover. Vite discovers bare-module
  // imports at REQUEST time; when it finds one it has not pre-bundled, it re-bundles
  // and answers every in-flight module request with 504 "Outdated Optimize Dep". The
  // render page is fetched exactly once, as a dynamic import, so a single 504 is
  // fatal — measured, not theorised:
  //     504 (Outdated Optimize Dep) x3
  //     TypeError: Failed to fetch dynamically imported module: …/renderJobPage.js
  //     render worker exited 1  ->  job status: Failed
  // and the whole render pipeline was dead on both backends because of it.
  //
  // So SETTLE THE OPTIMIZER BEFORE CHROME EVER NAVIGATES: ask for the page module
  // ourselves, which triggers discovery of everything it transitively pulls in, then
  // wait for the resulting re-bundle to finish. After this the graph is warm and the
  // one request that matters cannot race a re-bundle. Deliberately NOT
  // `optimizeDeps.noDiscovery` — that does not pre-bundle, it just refuses to learn,
  // so an unlisted dep would fail later and less legibly.
  await server.warmupRequest(PAGE_MODULE_URL);
  await server.waitForRequestsIdle();

  return { url: `http://127.0.0.1:${server.httpServer.address().port}/`, close: () => server.close() };
}

/**
 * Command (launches Chrome). One independent browser for one render stride.
 *
 * `pipe: true` is load-bearing, not a style choice: it connects over Chrome's
 * stdio debugging pipe instead of a WebSocket, so when this worker is SIGKILLed
 * (which is exactly how the supervisor cancels a job) the pipe closes and Chrome
 * exits with it. Over a WebSocket the browser would survive as an orphan and keep
 * writing frames into a cancelled job's directory.
 */
function launchRenderBrowser() {
  return puppeteer.launch({
    headless: true,
    // `pipe: true` is load-bearing — see the docstring.
    pipe: true,
    // NO CDP CALL TIMEOUT. puppeteer defaults protocolTimeout to 180 s, and each
    // frame is ONE CDP call: a 4K material-laden frame can legitimately take longer
    // than that, and the default would abort a correct render as if it had hung. A
    // render must be bounded by the work it is asked to do, not by an arbitrary
    // clock. Genuine hangs still surface — the page's own raster stall detector
    // (web/renderJobPage.js) reports on no PROGRESS, which is the meaningful signal.
    protocolTimeout: 0,
    args: chromeArgs(process.env[CHROME_ARGS_ENV]),
  });
}

/**
 * Command (opens a page, loads the app). One render page, ready to be asked for
 * frames. `?cli=1` is the editor's existing headless mode: main.js skips mounting
 * the UI, so the page is the app's module graph and nothing else.
 *
 * Page errors are LOUD. An uncaught exception in the page is a rendering failure
 * and rejects the whole shard; a console.error is reported to this process's
 * stderr as it happens (the app's own loud-failure discipline writes real
 * problems there — a failed image decode, a refused offscreen surface) and the
 * supervisor surfaces the collected text on the job.
 *
 * Args:
 *   browser (Browser): the shared browser
 *   url (string): the served editor origin
 *   report (function): called with every page-console error line
 *
 * Returns:
 *   Promise<{page, failure: () => Error|null}> — `failure` is the first uncaught
 *   page error seen so far, checked between frames.
 */
async function openRenderPage(browser, url, report) {
  const page = await browser.newPage();
  let pageError = null;
  page.on("pageerror", (e) => {
    pageError ??= e;
    report(`pageerror: ${e.message}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") report(`console.error: ${m.text()}`);
  });
  await page.goto(`${url}?cli=1`, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
  // Import the page half INTO the loaded app so it shares the app's ONE module
  // graph (one CanvasKit, one image registry, one particle clock).
  await page.evaluate((mod) => import(mod), PAGE_MODULE_URL);
  return { page, failure: () => pageError };
}

/**
 * Command (renders and writes PNGs). Renders `frames` of an OPEN page into
 * `framesDir`, skipping any that already exist.
 *
 * RESUME: a frame already on disk is a FINISHED frame (writes are atomic — see
 * below), so a job re-queued after a server restart skips what it has and picks
 * up where it stopped instead of re-rendering hours of work.
 *
 * Returns:
 *   Promise<number> how many frames this call actually rendered
 */
async function renderFramesInto(session, framesDir, frames) {
  let rendered = 0;
  for (const frameIndex of frames) {
    const outPath = path.join(framesDir, frameFileName(frameIndex));
    if (existsSync(outPath)) continue;
    const base64 = await session.page.evaluate((i) => window.__powerrp_renderJobFrame(i), frameIndex);
    const failure = session.failure();
    if (failure) throw failure; // an uncaught page error during THIS frame — never write it
    // ATOMIC: write a temp file then rename. The server's progress signal is a
    // COUNT of frame_*.png files, and resume treats any such file as complete —
    // both would be wrong if a killed worker could leave a half-written PNG behind.
    //
    // The temp name carries THIS PROCESS'S pid, and that is not decoration. A
    // SIGKILLed server cannot reap its workers, so they keep rendering as orphans;
    // when the next server boots and resumes the job it spawns a fresh worker for
    // the same shard, and for a while TWO processes are writing the same frames.
    // With one shared ".part" name they raced and one lost its file mid-rename
    // (ENOENT) — a resumed job died on its own leftovers. Per-pid temp names make
    // the overlap merely wasteful instead of fatal: whichever finishes last renames
    // over the other, and since a frame is a pure function of (snapshot, index) the
    // two are byte-identical anyway.
    const tmpPath = `${outPath}.${process.pid}.${session.tag}.part`;
    await writeFile(tmpPath, Buffer.from(base64, "base64"));
    await rename(tmpPath, outPath);
    rendered += 1;
  }
  return rendered;
}

/**
 * Command (boots a browser, renders, writes PNGs). Renders this process's shard
 * of the job's timeline into `<jobDir>/frames/`.
 *
 * Args:
 *   jobDir (string): the job directory holding job.json + doc.json
 *   shard (number): this process's 0-based shard index
 *   shards (number): how many processes/machines the job was split across
 *   workers (number): how many independent browsers this process renders on
 *
 * Returns:
 *   Promise<{rendered: number, total: number, glRenderer: string, consoleErrors: string[]}>
 *
 * Untested as a unit (it needs a real job dir, a dev server and a browser); the
 * end-to-end server test tests/render_jobs_test.py exercises it.
 */
export async function runShard(jobDir, shard, shards, workers) {
  const job = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  const docJson = await readFile(path.join(jobDir, "doc.json"), "utf8");
  const framesDir = path.join(jobDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const consoleErrors = [];
  const report = (line) => {
    consoleErrors.push(line);
    console.error(`render_job: ${line}`);
  };

  const dev = await startDevServer();
  const browsers = [];
  try {
    const sessions = [];
    for (const [i, split] of workerShards(shard, shards, workers).entries()) {
      const browser = await launchRenderBrowser();
      browsers.push(browser);
      const opened = await openRenderPage(browser, dev.url, report);
      const info = await opened.page.evaluate(
        (json, params) => window.__powerrp_renderJobOpen(json, params), docJson, job.params);
      sessions.push({ ...opened, tag: `w${i}`, split, info });
    }
    // The page is the single source of truth for the timeline (see the header);
    // every browser repairs the same snapshot, so they must all agree.
    const totals = new Set(sessions.map((s) => s.info.frames));
    if (totals.size !== 1) throw new Error(`render_job: workers disagreed about the frame count (${[...totals].join(", ")}) — the timeline must be a pure function of the snapshot`);
    const total = sessions[0].info.frames;
    const counts = await Promise.all(sessions.map((s) =>
      renderFramesInto(s, framesDir, shardFrames(total, s.split.shard, s.split.shards))));
    for (const s of sessions) await s.page.evaluate(() => window.__powerrp_renderJobClose());
    return {
      rendered: counts.reduce((a, b) => a + b, 0),
      total,
      glRenderer: sessions[0].info.glRenderer,
      consoleErrors,
    };
  } finally {
    // Close the browsers before the server they are talking to, and never let one
    // failed close hide the others (or the real error propagating out of the try).
    for (const browser of browsers) await browser.close().catch((e) => console.error(`render_job: browser close failed — ${e.message}`));
    await dev.close();
  }
}

/** Command (the CLI entry). Renders one shard and prints a one-line summary. */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), new Set());
  if (positional.length !== 1) {
    console.error("Usage: node cli/render_job.js <jobDir> [--workers N] [--shard K] [--shards N]");
    process.exit(1);
  }
  const shards = Number.isFinite(flags.shards) ? flags.shards : 1;
  const shard = Number.isFinite(flags.shard) ? flags.shard : 0;
  const workers = Number.isFinite(flags.workers) ? flags.workers : 1;
  if (!(shards >= 1) || !(shard >= 0) || shard >= shards)
    throw new Error(`render_job: bad shard ${shard} of ${shards} (need 0 <= shard < shards, shards >= 1)`);
  if (!(workers >= 1))
    throw new Error(`render_job: bad worker count ${workers} (need >= 1)`);
  const started = performance.now();
  const { rendered, total, glRenderer } = await runShard(positional[0], shard, shards, workers);
  const seconds = (performance.now() - started) / 1000;
  // The GL backend is part of the summary because "did the render use the GPU?"
  // must be answerable from a log, not from an assumption.
  console.log(`shard ${shard}/${shards} (${workers} browser(s), GL: ${glRenderer}): rendered ${rendered} of ${total} frames in ${seconds.toFixed(1)}s (${(seconds / Math.max(1, rendered)).toFixed(2)}s/frame)`);
}

// Run only as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) await main();
