/**
 * THE RENDER PIPELINE, END TO END, THROUGH THE REAL UI, FOR BOTH BACKENDS.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Server-side rendering was DEAD — every job died at frame 0 with
 *     504 (Outdated Optimize Dep) x3
 *     TypeError: Failed to fetch dynamically imported module: …/renderJobPage.js
 *     render worker exited 1  ->  job state: Failed
 * (fixed in 86faf47 by settling Vite's dep optimizer before Chrome navigates) —
 * and 99 browser probes passed anyway, because not one of them submits a render
 * job through the app.
 *
 * The gap was NOT "nothing renders a job": tests/render_jobs_test.py submits a
 * server job over HTTP, waits for `done` and ffprobes the movie. What no test did
 * was go through the FRONT END. That test posts hand-written JSON straight at
 * `/api/render-jobs/…`, so the editor, the toolbar button, the Render Center, the
 * "Rendered by" dropdown, `app.submitRender`'s backend-word translation and
 * `projectApi` are all bypassed — and so is the entire BROWSER backend as a user
 * reaches it (tests/browser_render_resume_probe.js drives that one by calling
 * `submitBrowserRenderJob` directly). This probe closes exactly that: it clicks
 * the real button in the real dialog and then refuses to believe anything the UI
 * says about the result.
 *
 * ── WHAT IT REFUSES TO ACCEPT AS SUCCESS ─────────────────────────────────────
 * The outage printed a plausible progress line and then died, so a status string
 * proves nothing. Every claim below is checked against something outside the app:
 *   1. TERMINAL STATE, and it must be `done`. A job that reaches failed/cancelled
 *      fails this probe with the job's own `error` text (plus the browser's local
 *      error, which for a client job is the only place a worker-side reason lands).
 *      A job still "rendering" at the deadline is a failure, never a pass.
 *   2. THE FILE. Fetched over HTTP from /render/… AND stat'd on disk at the
 *      absolute path the job record reports, with the two byte counts agreeing.
 *   3. THE PICTURE. ffprobe decodes it: codec, dimensions, frame count and frame
 *      rate must match WHAT THE DIALOG PROMISED (its summary line is parsed, so a
 *      summary that lies about the output is itself a failure).
 *   4. NOT BLANK, with a LIVE CONTROL. The deck's shape changes colour on slide 2,
 *      so the probe asserts slide 1's colour appears in the FIRST half and NOT the
 *      second, and vice versa. An all-black movie fails both halves; a movie that
 *      rendered slide 1 twice fails the second. And the two backends are compared
 *      to each other by mean absolute difference, with the SAME movie's first and
 *      last frames as the control that a MAD near zero is a real agreement and not
 *      two identically empty buffers.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 * Deliberately tiny: 320x240, 6 fps, 0.5 s per slide → SIX frames per job. The
 * measured wall clock is in the run log this file's task recorded; the shape of it
 * is one Vite server + one Chrome for the probe, and (for the server backend) one
 * more of each inside the worker. The picture is what is being tested, not the
 * throughput, so nothing here is allowed to grow.
 *
 * BROWSER BACKEND FIRST, ON PURPOSE. The server worker starts a SECOND Vite dev
 * server on this same checkout, and concurrent dev servers share
 * node_modules/.vite and can 504 each other's module graph (cli/render_job.js's
 * header documents that exact failure). Running the browser job first means the
 * probe's own Vite has already pulled in every dependency the render path needs
 * before the worker's Vite exists, so the two do not race the optimizer.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/render_pipeline_probe.js
 */

import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootProbe, checker } from "./browser_render_harness.js";
import { PROBE_WIDTH, PROBE_HEIGHT } from "./browser_render_fixture.js";

// ── The job this probe asks for, and what that must produce ──────────────────
/** The project the deck is saved under. The editor OPENS it, so this is also the
 *  name the Render Center reports and the folder the movie lands in. */
const PROJECT = "RenderPipelineProbe";
/** Frame rate and per-slide dwell TYPED INTO THE DIALOG. Both differ from the
 *  app's defaults (30 fps, 2 s) precisely so the probe proves the typed values
 *  reached the renderer rather than coinciding with them. */
const JOB_FPS = 6;
const JOB_HOLD_SECONDS = 0.5;
/** The fixture has two slides, and transitions are switched OFF in the dialog, so
 *  the timeline is 2 x JOB_HOLD_SECONDS and the frame count follows. Switching
 *  them off is not cosmetic: it makes this number independent of whatever
 *  transition length the shared fixture carries. */
const SLIDE_COUNT = 2;
const EXPECTED_FRAMES = SLIDE_COUNT * JOB_HOLD_SECONDS * JOB_FPS;

/** Job states that mean "still working" — anything else is terminal. Mirrors
 *  server.py's JOB_ACTIVE_STATES; a state this list does not know is treated as
 *  terminal, so a new state cannot make the probe poll forever. */
const ACTIVE_STATES = ["queued", "rendering", "encoding"];
/**
 * How long one job may take before the probe declares it stuck. The server
 * backend's cost is dominated by STARTUP, not by six frames: it boots a Vite dev
 * server, pre-bundles the four lazy dependencies the config names, and launches
 * Chrome. cli/render_job.js allows 180 s for that page load alone, so this is that
 * plus room for the queue, the encode and a contended machine.
 */
const JOB_TIMEOUT_MS = 300_000;
/** How often the job list is re-read. The list is a directory listing server-side. */
const JOB_POLL_MS = 250;
/** One frame of the UI, for a click's effect to render. Svelte 5 flushes on a
 *  microtask, so this is generous rather than tuned. */
const SETTLE_MS = 150;
/** How long a UI element gets to appear after the click that should create it. */
const UI_TIMEOUT_MS = 15_000;

// ── What the pixels must show ───────────────────────────────────────────────
/**
 * The shared fixture's two shape colours and its camera background. Duplicated
 * here as the EXPECTED values rather than imported, because the point of the
 * pixel checks is to compare the movie against an independently stated
 * expectation; importing the fixture's own constants would let a fixture edit
 * silently move the target. tests/browser_render_fixture.js is the source, and a
 * drift shows up here as a loud failure rather than a quiet pass.
 */
const SLIDE1_FILL = [0xe0, 0x5f, 0x2a];
const SLIDE2_FILL = [0x2a, 0x7f, 0xe0];
const CAMERA_BACKGROUND = [0x10, 0x18, 0x28];
/** How far a channel may drift before a pixel is a DIFFERENT colour rather than a
 *  compressed one. H.264 at CRF 23 moves a flat fill a little; the three colours
 *  above are separated by 100+ per channel, far more than this. */
const CHANNEL_TOLERANCE = 40;
/** Every Nth pixel is examined by the colour checks. Prime, so the stride cannot
 *  land on a row multiple and sample one column forever: 320*240/37 ≈ 2076
 *  samples per frame. */
const COLOR_SAMPLE_STRIDE = 37;
/** How many SAMPLED pixels of a colour mean "this colour is in this frame". The
 *  shape is 120x90 of a 320x240 frame = 14%, so a present shape scores ~290 of
 *  the ~2076 samples and an absent one scores ~0. The threshold sits well below
 *  the first and well above the second. */
const MIN_SHAPE_SAMPLES = 100;
/**
 * Bytes below which a "movie" is a container header with no picture in it. A
 * 6-frame 320x240 CRF-23 clip of this deck measures in the low kilobytes; an MP4
 * holding no coded picture at all is a few hundred bytes of moov/ftyp. This is a
 * coarse existence gate — the pixel checks below are what actually prove content.
 */
const MIN_MOVIE_BYTES = 1024;
/**
 * THE LIVE CONTROL, in mean-absolute-difference over a whole frame (0..255 channel
 * units): how much frame 0 (slide 1's orange shape) must differ from the last frame
 * (slide 2's blue shape). DERIVED, not guessed: the shape is a hexagon in a 120x90
 * box, so ~0.75*120*90 = 8100 of the frame's 76800 pixels (10.5%), and the two fills
 * differ by (182+32+182)/3 = 132 per channel, predicting ~13.9. Measured 11.39
 * (antialiased edges and CRF-23 smoothing take the rest). This floor is ~2x below
 * the measured value and enormously above the ~0 that two blank frames score.
 */
const CONTROL_MAD_MIN = 5;
/**
 * How far the two backends' frame 0 may differ. They rasterize the SAME deck
 * through the same display list, the same paint_skia and — with the default
 * "upload" browser encoder, which ships PNGs to the server — the same libx264, so
 * they must agree. Not byte-identically: the probe's Chrome and the worker's Chrome
 * are separate ANGLE/SwiftShader instances, so antialiased edges may land a shade
 * apart. It MUST stay well under CONTROL_MAD_MIN, or "they agree" would be
 * satisfiable by two blank movies — which is precisely what the control rules out.
 */
const CROSS_BACKEND_MAD_MAX = CONTROL_MAD_MIN / 2;

/** Where the two movies are kept for inspection. Resolved from THIS FILE so the
 *  artifacts land in the same place whoever runs the probe from wherever. */
const POWERRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(POWERRP, ".claude_vlm_checks");

/**
 * Console text this probe tolerates during boot, NARROWLY. Each entry names one
 * legitimate environmental diagnostic and nothing else:
 *   - "no WebGPU adapter" — this container has no GPU. The literal, not a pattern
 *     with an `|adapters` branch that would swallow unrelated errors.
 *   - "PowerRP repair:" — a load-boundary repair report, which is the app being
 *     loud on purpose.
 *   - "was missing font" — the font loader naming a face it substituted.
 *   - "Failed to load resource" — Chrome's own line for a 404 (favicon).
 * Same set and same spelling as tests/boolean_uniformity_probe.js. Anything else
 * is a real error and is reported.
 */
const ALLOWED_CONSOLE = [/no WebGPU adapter/, /PowerRP repair:/, /was missing font/, /Failed to load resource/];

/**
 * How much of a job's error text is quoted in a check label. THE CANONICAL RUNNER
 * KEEPS ONLY THE LAST THREE LINES of a failing child's output, so a raw multi-line
 * stack trace pushes the actual verdict off the top and the gate reports `}` —
 * observed. One line, this long, is what stays readable there.
 */
const ERROR_EXCERPT_CHARS = 280;

/**
 * Pure function. Collapse text to ONE line and truncate it, for quoting inside a
 * check label. Null/undefined comes back as an empty string so callers can
 * concatenate without a guard.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 *
 * @example oneLine("render worker exited 1:\n  at foo\n  at bar") // "render worker exited 1: at foo at bar"
 * @example oneLine(null) // ""
 */
function oneLine(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > ERROR_EXCERPT_CHARS ? `${flat.slice(0, ERROR_EXCERPT_CHARS)}…` : flat;
}

/**
 * Pure function. Whether a console/page error line is one of the allowed boot
 * diagnostics above.
 *
 * @param {string} line The error text.
 * @returns {boolean}
 *
 * @example isAllowedConsole("no WebGPU adapter; falling back") // true
 * @example isAllowedConsole("Uncaught TypeError: x is not a function") // false
 */
function isAllowedConsole(line) {
  return ALLOWED_CONSOLE.some((re) => re.test(line));
}

/**
 * Pure function. The Render Center's summary line, parsed back into the numbers it
 * promises. That line is the dialog's own statement of what it is about to render,
 * so parsing it (rather than assuming the defaults) makes a summary that disagrees
 * with the output a failure in its own right.
 *
 * @param {string} text The textContent of .render-center-summary.
 * @returns {{width: number, height: number, fps: number, crf: number}}
 *
 * @example
 * summaryPromise("Output: 320×240 · 6 fps · CRF 23 (lower = higher quality)")
 * // {width: 320, height: 240, fps: 6, crf: 23}
 */
function summaryPromise(text) {
  const m = /Output:\s*(\d+)\D+(\d+)\s*·\s*([\d.]+)\s*fps\s*·\s*CRF\s*(\d+)/.exec(text);
  if (!m) throw new Error(`render_pipeline_probe: could not read the dialog's output summary from ${JSON.stringify(text)}`);
  return { width: Number(m[1]), height: Number(m[2]), fps: Number(m[3]), crf: Number(m[4]) };
}

/**
 * Query (runs ffmpeg). Every frame of a video as ONE raw RGB24 buffer. Indexing
 * the buffer is both simpler and one decode cheaper than ffmpeg's crop filter, and
 * a byte count that is not a whole number of frames is a decode this probe refuses
 * to reason about.
 *
 * @param {string} path The movie.
 * @param {number} width Expected frame width.
 * @param {number} height Expected frame height.
 * @returns {{raw: Buffer, perFrame: number, frames: number, width: number, height: number}}
 */
function decodeFrames(path, width, height) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 1 << 30,
    encoding: "buffer",
  });
  const perFrame = width * height * 3;
  if (raw.length === 0 || raw.length % perFrame !== 0)
    throw new Error(`render_pipeline_probe: ${path} decoded to ${raw.length} bytes, which is not a whole number of ${width}x${height} RGB frames`);
  return { raw, perFrame, frames: raw.length / perFrame, width, height };
}

/**
 * Query (runs ffprobe). A movie's first video stream, as the fields asserted on.
 * `-count_frames` DECODES rather than trusting the container's header, which is the
 * difference between "the file claims six frames" and "six frames come out of it".
 *
 * @param {string} path The movie.
 * @returns {{codec_name: string, width: number, height: number, nb_read_frames: string, avg_frame_rate: string}}
 */
function videoInfo(path) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames,avg_frame_rate",
    "-of", "json", path,
  ], { encoding: "utf8" });
  return JSON.parse(out).streams[0];
}

/**
 * Pure function. For each frame of a decoded buffer, how many SAMPLED pixels match
 * `rgb` within CHANNEL_TOLERANCE. A count per frame rather than one probe pixel,
 * so the answer does not depend on choosing a pixel the shape happens to cover.
 *
 * @param {{raw: Buffer, perFrame: number, frames: number, width: number, height: number}} decoded From decodeFrames.
 * @param {number[]} rgb The colour to look for, as [r, g, b].
 * @returns {number[]} one count per frame
 *
 * @example
 * // Six frames of this probe's deck, looking for slide 1's orange:
 * // colorCounts(decodeFrames(path, 320, 240), [0xe0, 0x5f, 0x2a])
 * // [291, 291, 291, 0, 0, 0]   — present in slide 1's frames, absent in slide 2's
 */
function colorCounts({ raw, perFrame, frames, width, height }, rgb) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    const base = f * perFrame;
    let n = 0;
    for (let px = 0; px < width * height; px += COLOR_SAMPLE_STRIDE) {
      const o = base + px * 3;
      if (Math.abs(raw[o] - rgb[0]) <= CHANNEL_TOLERANCE
        && Math.abs(raw[o + 1] - rgb[1]) <= CHANNEL_TOLERANCE
        && Math.abs(raw[o + 2] - rgb[2]) <= CHANNEL_TOLERANCE) n += 1;
    }
    out.push(n);
  }
  return out;
}

/**
 * Pure function. One frame of a decoded buffer, as its own view. No copy — the
 * callers only read.
 *
 * @param {{raw: Buffer, perFrame: number}} decoded From decodeFrames.
 * @param {number} index 0-based frame index.
 * @returns {Buffer}
 *
 * @example
 * // frameAt(decodeFrames(path, 320, 240), 0).length // 230400  (320*240*3)
 */
function frameAt({ raw, perFrame }, index) {
  return raw.subarray(index * perFrame, (index + 1) * perFrame);
}

/**
 * Pure function. Mean absolute difference between two equal-length byte buffers,
 * in 0..255 channel units. Throws on a length mismatch rather than comparing a
 * prefix, because two different-sized frames are not a small difference.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {number}
 *
 * @example meanAbsDiff(Buffer.from([0, 10]), Buffer.from([0, 20])) // 5
 * @example meanAbsDiff(Buffer.from([7]), Buffer.from([7])) // 0
 */
function meanAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error(`meanAbsDiff: ${a.length} bytes against ${b.length}`);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** Command (async). Sleep `ms`. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Command (async). Wait until the EDITOR HAS MOUTED — `window.__powerrp_app` plus a
 * rendered toolbar. The harness navigates with `waitUntil: "domcontentloaded"` and
 * web/main.js mounts only after its font load resolves, so at that point there is
 * no app and no toolbar yet.
 *
 * This is also what keeps the setup below off a live wire: waiting until boot is
 * COMPLETE means Vite has finished discovering and pre-bundling the editor's
 * dependencies, so a probe-side dynamic import cannot race a re-optimize. Doing it
 * at domcontentloaded instead produced exactly the outage's signature —
 * "Failed to fetch dynamically imported module: …/plugins/index.js" — from a
 * perfectly healthy tree, intermittently.
 *
 * @param {object} page Puppeteer page.
 */
async function waitForEditor(page) {
  await page.waitForFunction(() => Boolean(window.__powerrp_app), { timeout: UI_TIMEOUT_MS });
  await page.waitForSelector(".toolbar button", { timeout: UI_TIMEOUT_MS });
  await sleep(SETTLE_MS);
}

// ── Backend HTTP, from node (never through the page) ────────────────────────

/** Query (async). This project's render jobs, newest-first as the server lists them. */
async function listJobs(backendUrl, project) {
  const res = await fetch(`${backendUrl}/api/render-jobs/${encodeURIComponent(project)}/`);
  if (!res.ok) throw new Error(`render_pipeline_probe: listing render jobs failed with HTTP ${res.status}`);
  return (await res.json()).jobs;
}

/** Command (async). Write the project's document, creating the project. */
async function putProjectDoc(backendUrl, project, doc) {
  const res = await fetch(`${backendUrl}/api/project/${encodeURIComponent(project)}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`render_pipeline_probe: saving the probe deck failed with HTTP ${res.status}`);
}

/**
 * Command (async; polls). Wait until `jobId` leaves the active states, and return
 * the record. A job that is STILL ACTIVE at the deadline returns its last record
 * with `state` unchanged, so the caller's "must be done" check fails naming the
 * state it was stuck in — the probe never passes on a render that never ended.
 *
 * @returns {Promise<object>} the last job record seen
 */
async function waitForTerminal(backendUrl, project, jobId) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let last = null;
  for (;;) {
    const job = (await listJobs(backendUrl, project)).find((j) => j.id === jobId);
    if (!job) throw new Error(`render_pipeline_probe: job ${jobId} vanished from the server's list`);
    last = job;
    if (!ACTIVE_STATES.includes(job.state)) return job;
    if (Date.now() > deadline) return last;
    await sleep(JOB_POLL_MS);
  }
}

// ── The REAL UI ─────────────────────────────────────────────────────────────

/** The toolbar button that opens the Render Center. Its aria-label is the command's
 *  title, with an "— N active or unseen" suffix once a badge appears, so only the
 *  prefix is stable. */
const RENDER_CENTER_BUTTON = '.toolbar button[aria-label^="Render Center (Video)"]';

/**
 * Command (async; clicks the real toolbar button). Open the Render Center the way a
 * user does. Waits for the dialog's own root to exist, so a button that opened
 * nothing is a timeout here rather than a confusing failure three steps later.
 *
 * The button TOGGLES, so an already-open dialog would be CLOSED by clicking it.
 * That is refused loudly rather than handled: the caller is expected to close the
 * dialog when it is finished with it, and a probe that silently coped with either
 * state would stop noticing if the toggle broke.
 *
 * @param {object} page Puppeteer page.
 */
async function openRenderCenter(page) {
  if (await page.$(".render-center"))
    throw new Error("render_pipeline_probe: the Render Center is already open — the toolbar button TOGGLES, so clicking it now would close it");
  await page.click(RENDER_CENTER_BUTTON);
  await page.waitForSelector(".render-center .render-center-submit", { timeout: UI_TIMEOUT_MS });
  await sleep(SETTLE_MS);
}

/** Command (async; clicks the real toolbar button again). Close the Render Center,
 *  and require that it actually went away. */
async function closeRenderCenter(page) {
  await page.click(RENDER_CENTER_BUTTON);
  await page.waitForFunction(() => !document.querySelector(".render-center"), { timeout: UI_TIMEOUT_MS });
  await sleep(SETTLE_MS);
}

/**
 * Query (async; reads the page). The dialog row whose label is `label`, as a
 * puppeteer element handle. Throws naming the labels it DID find, because "row not
 * found" without them is the least useful failure available.
 *
 * @param {object} page Puppeteer page.
 * @param {string} label The visible text of the row's .render-center-label.
 */
async function rowByLabel(page, label) {
  const handle = await page.evaluateHandle((want) => {
    const rows = [...document.querySelectorAll(".render-center .render-center-row")];
    return rows.find((r) => r.querySelector(".render-center-label")?.textContent.trim() === want) ?? null;
  }, label);
  if (!(await handle.evaluate((el) => Boolean(el)))) {
    const found = await page.evaluate(() => [...document.querySelectorAll(".render-center .render-center-label")].map((el) => el.textContent.trim()));
    throw new Error(`render_pipeline_probe: no Render Center row labelled ${JSON.stringify(label)} — the dialog shows ${JSON.stringify(found)}`);
  }
  return handle.asElement();
}

/**
 * Command (async; drives a real dropdown). Open the row's dropdown and click the
 * option whose label starts with `optionPrefix`. Returns the trigger's text after
 * the choice, so the caller can assert the UI committed to it.
 *
 * The option is clicked in-page rather than through the mouse because the menu is
 * transient and matched by TEXT, not position; it is still a real click event
 * reaching the component's real handler (the tests/registry_ui_probe.js idiom).
 *
 * @param {object} page Puppeteer page.
 * @param {string} label The row's label, e.g. "Rendered by".
 * @param {string} optionPrefix The start of the option's visible text, e.g. "Server".
 * @returns {Promise<string>} the trigger's text after the selection
 */
async function chooseDropdown(page, label, optionPrefix) {
  const row = await rowByLabel(page, label);
  await row.$eval(".dd-trigger", (el) => el.click());
  await page.waitForFunction((r) => r.querySelector('.dd-menu [role="option"]'), { timeout: UI_TIMEOUT_MS }, row);
  const clicked = await row.evaluate((el, prefix) => {
    const option = [...el.querySelectorAll('.dd-menu [role="option"]')].find((o) => o.textContent.trim().startsWith(prefix));
    if (!option) return [...el.querySelectorAll('.dd-menu [role="option"]')].map((o) => o.textContent.trim());
    option.click();
    return true;
  }, optionPrefix);
  if (clicked !== true)
    throw new Error(`render_pipeline_probe: the ${JSON.stringify(label)} dropdown has no option starting with ${JSON.stringify(optionPrefix)} — it offers ${JSON.stringify(clicked)}`);
  await sleep(SETTLE_MS);
  return row.$eval(".dd-trigger", (el) => el.textContent.trim());
}

/**
 * Command (async; types into a real DraggableNumber). Set a numeric row by
 * CLICKING it (a click without a drag opens lib/DraggableNumber's inline text
 * entry, pre-selected), typing, and pressing Enter. Returns the value the control
 * publishes afterwards, so the caller asserts what the component accepted rather
 * than what was typed.
 *
 * @param {object} page Puppeteer page.
 * @param {string} ariaLabel The control's aria-label (DraggableNumber's `label`).
 * @param {number} value The value to type.
 * @returns {Promise<number>} the control's aria-valuenow afterwards
 */
async function setNumber(page, ariaLabel, value) {
  const control = `.render-center [role="spinbutton"][aria-label="${ariaLabel}"]`;
  await page.waitForSelector(control, { timeout: UI_TIMEOUT_MS });
  await page.click(control);
  await page.waitForSelector(`${control} input.dn-input`, { timeout: UI_TIMEOUT_MS });
  // The inline editor opens focused with its text selected, so typing replaces it.
  await page.keyboard.type(String(value));
  await page.keyboard.press("Enter");
  await sleep(SETTLE_MS);
  return page.$eval(control, (el) => Number(el.getAttribute("aria-valuenow")));
}

/**
 * Command (async; clicks a real boolean row). Drive the app's boolean control to
 * `on`. A no-op when it is already there, and it reads the state back off
 * aria-pressed rather than assuming the click landed.
 *
 * @param {object} page Puppeteer page.
 * @param {string} ariaLabel The button's aria-label.
 * @param {boolean} on Desired state.
 * @returns {Promise<boolean>} the state afterwards
 */
async function setBoolean(page, ariaLabel, on) {
  const control = `.render-center .boolbtn[aria-label="${ariaLabel}"]`;
  await page.waitForSelector(control, { timeout: UI_TIMEOUT_MS });
  const before = await page.$eval(control, (el) => el.getAttribute("aria-pressed") === "true");
  if (before !== on) {
    await page.click(control);
    await sleep(SETTLE_MS);
  }
  return page.$eval(control, (el) => el.getAttribute("aria-pressed") === "true");
}

/**
 * Command (async; types into the real Name field). Replace the dialog's job name.
 * The triple click selects the name already there — the field is pre-filled with
 * the project's, and typing without selecting would concatenate the two.
 *
 * @param {object} page Puppeteer page.
 * @param {string} name The job name to type. It is also the movie's filename stem.
 * @returns {Promise<string>} the field's value afterwards
 */
async function setJobName(page, name) {
  const field = '.render-center input[aria-label="Render name"]';
  await page.waitForSelector(field, { timeout: UI_TIMEOUT_MS });
  await page.click(field, { clickCount: 3 }); // select the existing name
  await page.keyboard.type(name);
  await sleep(SETTLE_MS);
  return page.$eval(field, (el) => el.value);
}

/** Query (async). The dialog's own output summary, parsed. */
async function readSummary(page) {
  const text = await page.$eval(".render-center .render-center-summary", (el) => el.textContent);
  return summaryPromise(text);
}

/** Query (async). The submit pane's error text, or null when there is none. */
async function submitErrorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".render-center-submit .render-center-error");
    return el ? el.textContent.trim() : null;
  });
}

/**
 * Command (async; clicks the real Submit button). Press "Submit Render Job" and
 * return the job the SERVER now lists that was not there before — identifying it
 * by id difference rather than by trusting a value the page hands back, which is
 * the whole point of going through the UI.
 *
 * @param {object} page Puppeteer page.
 * @param {string} backendUrl The project backend.
 * @param {string[]} knownIds Job ids that existed before the click.
 * @returns {Promise<object>} the new job record
 */
async function clickSubmit(page, backendUrl, knownIds) {
  const button = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".render-center-actions button")].find((b) => b.textContent.includes("Submit Render Job")) ?? null);
  const element = button.asElement();
  if (!element) throw new Error("render_pipeline_probe: the Render Center has no \"Submit Render Job\" button");
  await element.click();
  const deadline = Date.now() + UI_TIMEOUT_MS;
  for (;;) {
    const fresh = (await listJobs(backendUrl, PROJECT)).filter((j) => !knownIds.includes(j.id));
    if (fresh.length === 1) return fresh[0];
    if (fresh.length > 1) throw new Error(`render_pipeline_probe: one click produced ${fresh.length} jobs`);
    if (Date.now() > deadline) {
      const shown = await submitErrorText(page);
      throw new Error(`render_pipeline_probe: clicking "Submit Render Job" created no job within ${UI_TIMEOUT_MS}ms${shown ? ` — the dialog says: ${oneLine(shown)}` : " and the dialog reported no error"}`);
    }
    await sleep(JOB_POLL_MS);
  }
}

/**
 * Query (async; reads the page). What the Render Center's own list says about a
 * job, so the round trip back into the UI is checked and not assumed.
 *
 * @returns {Promise<{state: string, text: string}|null>}
 */
async function uiJobRow(page, jobName) {
  return page.evaluate((name) => {
    const row = [...document.querySelectorAll(".render-center-job")]
      .find((r) => r.querySelector(".render-center-job-name")?.textContent.trim() === name);
    if (!row) return null;
    return {
      backend: row.querySelector(".render-center-job-backend")?.textContent.trim() ?? "",
      text: row.querySelector(".render-center-job-status")?.textContent.trim() ?? "",
    };
  }, jobName);
}

// ── The run ─────────────────────────────────────────────────────────────────

// A backend the GATE started would otherwise be inherited by the backend THIS
// probe starts, because server.py's serve() does os.environ.setdefault on
// BACKEND_URL — so its render workers would proxy /api and /asset to the gate's
// project store instead of ours. Clearing it first makes this probe's backend
// publish its own origin. (bootProbe sets the variable again afterwards, for its
// own Vite proxy.)
delete process.env.BACKEND_URL;
// ONE render browser per job. The default is cpu/2 capped at 8, which is right for
// a real 1080p render and absurd for six 320x240 frames — eight Chromes would cost
// more to start than the render costs to run.
process.env.POWERRP_RENDER_WORKERS = "1";

mkdirSync(OUT_DIR, { recursive: true });
const probe = await bootProbe();
const { check, fails } = checker();
/** Page errors this probe judges by its OWN narrow allowlist (the harness keeps a
 *  broader one for its own purposes). */
const errors = [];
probe.page.on("pageerror", (e) => { if (!isAllowedConsole(e.message)) errors.push(`pageerror: ${e.message}`); });
probe.page.on("console", (m) => { if (m.type() === "error" && !isAllowedConsole(m.text())) errors.push(`console.error: ${m.text()}`); });

console.log(`Probe origin: ${probe.baseUrl}   backend: http://127.0.0.1:${probe.backend.port}\n`);
const backendUrl = `http://127.0.0.1:${probe.backend.port}`;
/** Per-backend decoded movies, for the cross-backend comparison at the end. */
const decoded = {};

try {
  await waitForEditor(probe.page);

  // ── SETUP (not the thing under test): put the shared probe deck on the server
  // and OPEN it in the editor. Building the deck needs the plugin registry, so it
  // is built in the page from the registry's own defaults — a hand-written literal
  // would start reporting repairs the moment a plugin gains a property. The
  // registry is the RUNNING EDITOR'S, not a second one built here: fewer modules
  // fetched, and the deck is composed against the same plugin set that will render
  // it. A fixture needing repairs is a failure, not a fixup.
  const deck = await probe.page.evaluate(async (u) => {
    const { repairedDocument } = await import(u.document);
    const { probeDoc } = await import(u.fixture);
    const registry = window.__powerrp_app.registry;
    const { doc, reports } = repairedDocument(probeDoc(registry), registry);
    if (reports.length) throw new Error(`the probe fixture needed repairs: ${JSON.stringify(reports)}`);
    return doc;
  }, {
    document: probe.fsUrl("core/document.js"),
    fixture: probe.fsUrl("tests/browser_render_fixture.js"),
  });
  await putProjectDoc(backendUrl, PROJECT, deck);
  await probe.page.evaluate((name) => window.__powerrp_app.loadProject(name), PROJECT);
  await sleep(SETTLE_MS);
  const openProject = await probe.page.evaluate(() => window.__powerrp_app.projectName());
  check(openProject === PROJECT, `the editor has the probe deck open as project "${openProject}"`);

  // BROWSER FIRST — see the header (the server worker's Vite must not race ours
  // for the dependency optimizer).
  for (const { ui, wire, jobName } of [
    { ui: "Browser", wire: "client", jobName: "BrowserRun" },
    { ui: "Server", wire: "server", jobName: "ServerRun" },
  ]) {
    console.log(`\n════ "${ui}" BACKEND (wire word "${wire}") ════`);
    const before = (await listJobs(backendUrl, PROJECT)).map((j) => j.id);

    // ── SUBMIT, entirely through the dialog ─────────────────────────────────
    await openRenderCenter(probe.page);
    check(true, "the real toolbar button opened the Render Center");
    const trigger = await chooseDropdown(probe.page, "Rendered by", ui);
    check(trigger.startsWith(ui), `the "Rendered by" dropdown committed to ${ui} (trigger reads "${trigger}")`);
    check(await setJobName(probe.page, jobName) === jobName, `the Name field holds "${jobName}"`);
    const fps = await setNumber(probe.page, "Frames per second", JOB_FPS);
    check(fps === JOB_FPS, `the Frame rate control accepted ${JOB_FPS} (reads ${fps})`);
    const hold = await setNumber(probe.page, "Seconds each slide is held", JOB_HOLD_SECONDS);
    check(hold === JOB_HOLD_SECONDS, `the Hold-per-slide control accepted ${JOB_HOLD_SECONDS} (reads ${hold})`);
    const transitions = await setBoolean(probe.page, "Animate transitions between slides", false);
    check(transitions === false, "Transitions is switched OFF, so the frame count is the two holds alone");
    const promised = await readSummary(probe.page);
    check(promised.width === PROBE_WIDTH && promised.height === PROBE_HEIGHT && promised.fps === JOB_FPS,
      `the dialog promises ${promised.width}x${promised.height} at ${promised.fps} fps, CRF ${promised.crf}`);

    const job = await clickSubmit(probe.page, backendUrl, before);
    const shownError = await submitErrorText(probe.page);
    check(shownError === null, `the dialog reported no submit error${shownError ? `, but it says: ${oneLine(shownError)}` : ""}`);
    check(job.backend === wire, `the submitted job's backend field is the wire word "${job.backend}"`);
    check(job.framesTotal === EXPECTED_FRAMES, `the job asks for ${job.framesTotal} frames (expected ${EXPECTED_FRAMES})`);
    check(job.params.width === promised.width && job.params.height === promised.height && job.params.fps === promised.fps,
      "the job's params are what the dialog's summary promised");

    // ── THE JOB MUST END, AND END DONE ──────────────────────────────────────
    // A client job renders IN THIS PAGE, so the tab stays open until it finishes;
    // a server job no longer needs the page at all. Either way the verdict comes
    // from the server's record, over HTTP, from node.
    const final = await waitForTerminal(backendUrl, PROJECT, job.id);
    // For a client job the only place a local failure reason lands is the
    // browser's own store — the server would only ever learn "cancelled".
    const localError = wire !== "client" ? null : await probe.page.evaluate(async (u, id) => {
      const jobs = await import(u);
      return (await jobs.browserJobStatuses("RenderPipelineProbe"))[id]?.error ?? null;
    }, probe.fsUrl("web/browserRenderJobs.js"), job.id);
    check(final.state === "done",
      `the job reached a TERMINAL state and it is "done" (got "${final.state}"${final.error ? `, error: ${oneLine(final.error)}` : ""}${localError ? `, local error: ${oneLine(localError)}` : ""})`);
    if (final.state !== "done") {
      // Nothing below can mean anything, but the dialog must still be closed —
      // the toolbar button toggles, so leaving it open breaks the next backend.
      await closeRenderCenter(probe.page);
      continue;
    }
    check(final.framesDone === EXPECTED_FRAMES, `the server counted ${final.framesDone} of ${EXPECTED_FRAMES} frames`);

    // ── THE FILE EXISTS, TWICE OVER: over HTTP and on disk ──────────────────
    check(Boolean(final.output), `the movie is named ${final.output}`);
    const served = await fetch(`${backendUrl}/render/${encodeURIComponent(PROJECT)}/${encodeURIComponent(final.output)}`);
    check(served.ok, `the finished movie is served back over HTTP (${served.status})`);
    const bytes = Buffer.from(await served.arrayBuffer());
    check(bytes.length >= MIN_MOVIE_BYTES, `it is ${bytes.length} B, above the ${MIN_MOVIE_BYTES} B floor for a movie with a picture in it`);
    const onDisk = statSync(final.outputPath).size;
    check(onDisk === bytes.length, `the file on disk at ${final.outputPath} is the same ${onDisk} B`);
    const path = join(OUT_DIR, `render_pipeline_${wire}.mp4`);
    writeFileSync(path, bytes);

    // ── IT DECODES AS THE MOVIE THAT WAS ASKED FOR ──────────────────────────
    const info = videoInfo(path);
    check(info.codec_name === "h264", `codec h264 (${info.codec_name})`);
    check(Number(info.width) === promised.width && Number(info.height) === promised.height,
      `dimensions ${info.width}x${info.height} match the dialog's promise`);
    check(Number(info.nb_read_frames) === EXPECTED_FRAMES, `ffmpeg DECODED ${info.nb_read_frames} frames (expected ${EXPECTED_FRAMES})`);
    check(info.avg_frame_rate === `${promised.fps}/1`, `frame rate ${info.avg_frame_rate} matches the dialog's promise`);

    // ── THE PIXELS, WITH A LIVE CONTROL ─────────────────────────────────────
    const movie = decodeFrames(path, promised.width, promised.height);
    decoded[wire] = movie;
    const background = colorCounts(movie, CAMERA_BACKGROUND);
    const slide1 = colorCounts(movie, SLIDE1_FILL);
    const slide2 = colorCounts(movie, SLIDE2_FILL);
    const half = EXPECTED_FRAMES / 2;
    check(background.every((n) => n >= MIN_SHAPE_SAMPLES),
      `every frame shows the camera's background colour (min ${Math.min(...background)} sampled px, need ${MIN_SHAPE_SAMPLES})`);
    check(slide1.slice(0, half).every((n) => n >= MIN_SHAPE_SAMPLES) && slide1.slice(half).every((n) => n < MIN_SHAPE_SAMPLES),
      `slide 1's shape colour is in the FIRST half only (${slide1.join(",")})`);
    check(slide2.slice(half).every((n) => n >= MIN_SHAPE_SAMPLES) && slide2.slice(0, half).every((n) => n < MIN_SHAPE_SAMPLES),
      `slide 2's shape colour is in the SECOND half only (${slide2.join(",")})`);
    const controlMad = meanAbsDiff(frameAt(movie, 0), frameAt(movie, movie.frames - 1));
    check(controlMad >= CONTROL_MAD_MIN,
      `CONTROL: frame 0 and frame ${movie.frames - 1} differ by MAD ${controlMad.toFixed(2)} (need >= ${CONTROL_MAD_MIN}) — a blank movie cannot pass this`);

    // ── AND THE UI SAYS SO TOO ──────────────────────────────────────────────
    await sleep(SETTLE_MS);
    const row = await uiJobRow(probe.page, jobName);
    check(Boolean(row), `the Render Center's own list shows a row for "${jobName}"`);
    check(row?.backend === (wire === "client" ? "browser" : "server"), `that row says it was rendered by "${row?.backend}"`);
    console.log(`  movie: ${path}`);
    await closeRenderCenter(probe.page);
  }

  // ── THE TWO BACKENDS AGREE, AND THE CONTROL SAYS THAT MEANS SOMETHING ─────
  console.log("\n════ CROSS-BACKEND PARITY ════");
  if (decoded.client && decoded.server) {
    const mad = meanAbsDiff(frameAt(decoded.client, 0), frameAt(decoded.server, 0));
    check(mad <= CROSS_BACKEND_MAD_MAX,
      `the two backends' frame 0 agree to MAD ${mad.toFixed(2)} (allowed ${CROSS_BACKEND_MAD_MAX})`);
    const control = meanAbsDiff(frameAt(decoded.client, 0), frameAt(decoded.server, decoded.server.frames - 1));
    check(control >= CONTROL_MAD_MIN,
      `CONTROL: the same two movies' known-DIFFERENT frames score MAD ${control.toFixed(2)} (need >= ${CONTROL_MAD_MIN}), so ${mad.toFixed(2)} is real agreement and not two empty frames`);
  } else {
    check(false, `cross-backend parity could not be measured — only ${Object.keys(decoded).join(", ") || "no"} backend(s) produced a movie`);
  }

  if (errors.length) {
    console.log("\nPAGE ERRORS");
    for (const e of errors) console.log(`  ${e}`);
  }
  check(errors.length === 0, `the page logged no unexpected errors (${errors.length})`);
  console.log(fails.length === 0 ? "\nALL CHECKS PASSED" : `\n${fails.length} CHECK(S) FAILED:\n  ${fails.map((f) => `- ${f}`).join("\n  ")}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
} finally {
  await probe.stop();
}
