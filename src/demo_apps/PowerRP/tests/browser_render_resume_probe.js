/**
 * CLOSE THE TAB MID-RENDER, OPEN A NEW ONE, RESUME, GET A COMPLETE CORRECT VIDEO.
 *
 * This is the claim the whole browser-render feature stands on, and it is the one
 * thing a unit test structurally cannot show. So this probe does the actual thing:
 * it starts a browser-backend render on a REAL plain-HTTP LAN origin, waits until
 * it is genuinely partway through, DESTROYS THE PAGE (its JS context, its worker,
 * its canvases, everything), opens a brand-new page that has never seen the job,
 * resumes it, and then makes ffmpeg decode the result.
 *
 * It runs the whole thing for BOTH browser encoders, because they resume at
 * different precisions and both promises must be kept:
 *   "wasm"    encodes in the page; its resume point is the last COMPLETED SEGMENT,
 *             so the frames of the segment that was mid-encode are re-rendered.
 *             The probe asserts the resume point is exactly a segment multiple.
 *   "upload"  ships PNGs to the server; its resume point is the EXACT frame count
 *             on disk, so nothing is redone.
 *
 * FOUR THINGS ARE PROVEN PER ENCODER, not asserted:
 *   1. RESUME HAPPENED. The second sitting starts at a frame > 0, and the probe
 *      prints where. A run that silently restarted at 0 would still produce a
 *      correct video, so this is checked separately from correctness.
 *   2. THE VIDEO IS COMPLETE AND REAL. ffmpeg decodes exactly framesTotal frames at
 *      the right size, and every decoded frame is DISTINCT — which also catches the
 *      frozen-sparkler regression, because the deck contains a PARTICLE EMITTER
 *      whose content only moves if presentation time is driven per frame.
 *   3. THE SNAPSHOT HELD. Between the two sittings the project's document is
 *      REWRITTEN with a different colour. The finished movie must show the ORIGINAL
 *      colour on both sides of the resume boundary — a render is
 *      pure(document, [slide, alpha]), so resuming against the edited deck would
 *      splice two documents into one video and report success.
 *   4. ONE JOB LIST. The finished browser job and a server job appear in the same
 *      per-project list with the same shape.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/browser_render_resume_probe.js
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootProbe, checker } from "./browser_render_harness.js";
import { PROBE_FPS, PROBE_WIDTH, PROBE_HEIGHT } from "./browser_render_fixture.js";
import { LEASE_STALE_MS } from "../web/browserJobStore.js";

/** Slack on top of LEASE_STALE_MS when waiting for a closed tab's lease to clear —
 *  one poll of the watcher plus scheduling jitter on a busy machine. */
const LEASE_CLEAR_MARGIN_MS = 1500;

/** Output size: an exact 2x of the camera, so there is NO letterbox and a camera
 *  pixel maps to a known output pixel (the colour checks depend on that). */
const SCALE = 2;
const WIDTH = PROBE_WIDTH * SCALE;
const HEIGHT = PROBE_HEIGHT * SCALE;
/** 2 slides x HOLD_SECONDS at PROBE_FPS. 80 frames is four full encode segments
 *  plus room, so a mid-render close lands inside a segment rather than on one. */
const HOLD_SECONDS = 4;
const FRAMES_TOTAL = 80;
/** Close the page once this many frames are done — past two segment boundaries. */
const CLOSE_AFTER_FRAMES = 41;
/** How often the probe asks the page how far it has got. */
const WATCH_POLL_MS = 25;
/** Seconds to wait for a sitting before declaring the render stuck. */
const SITTING_TIMEOUT_S = 300;
/** Every Nth pixel of a frame is examined by the colour checks — enough samples to
 *  find a 240x180 shape in a 640x480 frame many times over, cheap enough for 80
 *  frames of two movies. */
const COLOR_SAMPLE_STRIDE = 41;
/** How many SAMPLED pixels of a colour count as "this colour is in the frame". The
 *  shape covers ~14% of the frame, so a present shape scores ~1000 of the ~7500
 *  samples and an absent one scores single digits — the threshold is nowhere near
 *  either. */
const MIN_SHAPE_PIXELS = 100;
/** The fixture's shape colours, and the colour the deck is REWRITTEN to mid-render.
 *  A frame showing the rewrite is a spliced document. */
const SLIDE1_FILL = [0xe0, 0x5f, 0x2a];
const SLIDE2_FILL = [0x2a, 0x7f, 0xe0];
const REWRITE_FILL = [0x11, 0xff, 0x11];
/** H.264 at a moderate quantizer moves a flat colour a little; this is the most a
 *  channel may differ before the pixel is a DIFFERENT colour rather than a
 *  compressed one. The three colours above are far further apart than this. */
const CHANNEL_TOLERANCE = 40;
// Resolved from THIS FILE, never the shell's cwd, so the artifacts land in the same
// place whoever runs the probe from wherever (tests/probe_artifact_path_test.js).
const POWERRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(POWERRP, ".claude_vlm_checks");
const PROJECT = "ResumeProbe";

/**
 * Query. Every frame of a video as ONE raw RGB24 buffer, plus the frame count. One
 * ffmpeg decode serves both checks below.
 *
 * The pixel sample deliberately does NOT use ffmpeg's `crop` filter: this ffmpeg
 * build rejects a 1x1 crop with "Error reinitializing filters" on a perfectly valid
 * file (the same file decodes to exactly frames x W x H x 3 bytes here), so indexing
 * the raw buffer is both simpler and one decode cheaper.
 */
function decodeRaw(path) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 1 << 30, encoding: "buffer" });
  const perFrame = WIDTH * HEIGHT * 3;
  if (raw.length % perFrame !== 0)
    throw new Error(`decoded ${raw.length} bytes, not a whole number of ${WIDTH}x${HEIGHT} frames`);
  return { raw, perFrame, frames: raw.length / perFrame };
}

/**
 * Pure function. For every frame of a decoded buffer, how many SAMPLED pixels match
 * `rgb` within CHANNEL_TOLERANCE.
 *
 * A single fixed pixel would be the obvious way to test the shape's colour, and it
 * was — until the particle emitter's sparks flew across it. Particles reach the whole
 * frame (their speed times their lifetime exceeds the camera), so ANY chosen pixel is
 * occluded in some frames. Counting matches over a strided sample of the frame asks
 * the question that actually matters — "is the snapshot's shape in this frame, and is
 * the rewritten colour not?" — and is immune to whatever is flying past.
 *
 * @param {{raw: Buffer, perFrame: number, frames: number}} decoded From decodeRaw.
 * @param {number[]} rgb The colour to look for.
 * @returns {number[]} one count per frame
 *
 * @example // colorCounts(decodeRaw(path), [224, 95, 42])[0] // 1043
 */
function colorCounts({ raw, perFrame, frames }, rgb) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    let n = 0;
    const base = f * perFrame;
    for (let px = 0; px < WIDTH * HEIGHT; px += COLOR_SAMPLE_STRIDE) {
      const o = base + px * 3;
      if (Math.abs(raw[o] - rgb[0]) <= CHANNEL_TOLERANCE
        && Math.abs(raw[o + 1] - rgb[1]) <= CHANNEL_TOLERANCE
        && Math.abs(raw[o + 2] - rgb[2]) <= CHANNEL_TOLERANCE) n += 1;
    }
    out.push(n);
  }
  return out;
}

/** Pure function. How many DISTINCT frames a decoded buffer holds. The
 *  frozen-sparkler check: an undriven ambient clock makes every frame of a slide
 *  byte-identical, which a frame COUNT alone would never reveal.
 *  @example // distinctFrameCount(decodeRaw(path)) // 80 */
function distinctFrameCount({ raw, perFrame, frames }) {
  const seen = new Set();
  for (let f = 0; f < frames; f++) {
    // A cheap content hash — it only has to separate frames, not resist attack.
    let h = 0x811c9dc5;
    for (let i = f * perFrame; i < (f + 1) * perFrame; i += 97) h = ((h ^ raw[i]) * 0x01000193) >>> 0;
    seen.add(h);
  }
  return seen.size;
}

/** Query. ffprobe a video for the fields asserted on. */
function videoInfo(path) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames,avg_frame_rate",
    "-of", "json", path,
  ], { encoding: "utf8" });
  return JSON.parse(out).streams[0];
}

/** Pure function. The probe deck's params for a render job.
 *  @example jobParams().width // 640 */
function jobParams() {
  return {
    width: WIDTH, height: HEIGHT, fps: PROBE_FPS, crf: 28, samples: 1,
    startIndex: 0, endIndex: 1, includeTransitions: false,
    holdSeconds: HOLD_SECONDS, background: "#000000", quality: "full",
  };
}

/**
 * Command (async). Install the browser-render modules on a page's `window` under
 * `__probe`, plus a repaired fixture document and a plugin registry. Everything the
 * probe drives afterwards goes through these, i.e. through the app's real modules.
 */
async function installProbeApi(page, urls, withParticles) {
  await page.evaluate(async (u, particles) => {
    const { createRegistry } = await import(u.registry);
    const { createCommands } = await import(u.commands);
    const { registerAll } = await import(u.plugins);
    const { repairedDocument } = await import(u.document);
    const { loadFonts } = await import(u.fonts);
    const { probeDoc } = await import(u.fixture);
    const jobs = await import(u.browserRenderJobs);
    await loadFonts();
    const registry = createRegistry();
    registerAll(registry, createCommands());
    const { doc, reports } = repairedDocument(probeDoc(registry, { particles }), registry);
    if (reports.length) throw new Error(`probe fixture needed repairs: ${JSON.stringify(reports)}`);
    window.__probe = {
      registry, doc, jobs,
      /** Command. Start a browser render job; resolves with the server record. */
      submit: (project, name, params, encoder) =>
        jobs.submitBrowserRenderJob({ project, name, params, doc, registry, encoder }),
      /** Command. Resume one; the returned promise is stored, not awaited here. */
      resume: (jobId) => {
        window.__probe.resumed = jobs.resumeBrowserRenderJob(jobId, registry)
          .then((job) => ({ ok: true, job }))
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        return true;
      },
      /** Query. This tab's live progress for a job, or null. */
      progress: (jobId) => jobs.liveBrowserProgress()[jobId] ?? null,
      /** Query. This browser's status for every browser job of a project. */
      statuses: (project) => jobs.browserJobStatuses(project),
    };
  }, urls, withParticles);
}

/**
 * Command (async). Wait until the page reports at least `frames` done for `jobId`,
 * or throw. Polling, not sleeping: it returns the instant the threshold is crossed,
 * so there is no race with a fast render finishing first.
 */
async function waitForFrames(page, jobId, frames) {
  const deadline = Date.now() + SITTING_TIMEOUT_S * 1000;
  let seen = false;
  for (;;) {
    const p = await page.evaluate((id) => window.__probe.progress(id), jobId);
    if (p) seen = true;
    if (p && p.framesDone >= frames) return p;
    // A live entry that DISAPPEARS after having existed means the drive ended — the
    // render either finished or failed before the threshold, and either way the
    // probe's premise (closing it mid-render) is void.
    if (seen && p === null)
      throw new Error(`job ${jobId} stopped being driven before reaching ${frames} frames — it finished or failed early. Check the page errors.`);
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach ${frames} frames within ${SITTING_TIMEOUT_S}s (last: ${JSON.stringify(p)})`);
    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
  }
}

/**
 * Command (async). Wait until a fresh page sees `jobId` as PAUSED, i.e. until the
 * closed tab's advisory lease has cleared. Bounded by LEASE_STALE_MS plus a margin,
 * because that timeout — not the best-effort pagehide release — is the guarantee.
 * Returns the status entry.
 */
async function waitForPaused(page, jobId) {
  const deadline = Date.now() + LEASE_STALE_MS + LEASE_CLEAR_MARGIN_MS;
  let last = null;
  for (;;) {
    const statuses = await page.evaluate((p) => window.__probe.statuses(p), PROJECT);
    last = statuses[jobId] ?? null;
    if (last?.driver === "paused") return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
  }
}

/**
 * Command (async). Wait until the page reports a KNOWN frame count for `jobId` — the
 * drive publishes a "starting" placeholder with a null count while it works out
 * where to continue from, and reading that would misreport the resume point as 0.
 */
async function waitForKnownFrameCount(page, jobId) {
  const deadline = Date.now() + SITTING_TIMEOUT_S * 1000;
  for (;;) {
    const p = await page.evaluate((id) => window.__probe.progress(id), jobId);
    if (p && typeof p.framesDone === "number") return p;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never published a frame count (last: ${JSON.stringify(p)})`);
    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
  }
}

/** Command (async). Wait for the server to report `jobId` finished; returns the record. */
async function waitForServerDone(backendPort, project, jobId) {
  const deadline = Date.now() + SITTING_TIMEOUT_S * 1000;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/render-jobs/${project}/`);
    const { jobs } = await res.json();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`job ${jobId} vanished from the server's list`);
    if (!["queued", "rendering", "encoding"].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never finished (state ${job.state}, ${job.framesDone}/${job.framesTotal})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Command (async). Write the project's document (used to REWRITE it mid-render). */
async function putProjectDoc(backendPort, project, doc) {
  const res = await fetch(`http://127.0.0.1:${backendPort}/api/project/${project}/`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`could not write the project document: ${res.status}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const probe = await bootProbe();
const { check, fails } = checker();
const urls = {
  registry: probe.fsUrl("core/registry.js"),
  commands: probe.fsUrl("core/commands.js"),
  document: probe.fsUrl("core/document.js"),
  plugins: probe.fsUrl("plugins/index.js"),
  fonts: probe.fsUrl("web/fontLoader.js"),
  fixture: probe.fsUrl("tests/browser_render_fixture.js"),
  browserRenderJobs: probe.fsUrl("web/browserRenderJobs.js"),
};
console.log(`Probe origin: ${probe.baseUrl}  (isSecureContext = false, asserted)\n`);

try {
  await putProjectDoc(probe.backend.port, PROJECT, { meta: { name: PROJECT }, slides: [] });

  for (const encoder of ["wasm", "upload"]) {
    console.log(`\n════ ENCODER "${encoder}" ════`);

    // ── SITTING 1: submit, render partway, then DESTROY the page ──────────────
    const page1 = await probe.newPage();
    await installProbeApi(page1, urls, true); // WITH particles — recordable state
    const job = await page1.evaluate(
      (p, n, params, e) => window.__probe.submit(p, n, params, e).then((j) => ({ id: j.id, framesTotal: j.framesTotal, backend: j.backend })),
      PROJECT, `Resume ${encoder}`, jobParams(), encoder,
    );
    check(job.framesTotal === FRAMES_TOTAL, `submitted job has ${job.framesTotal} frames (expected ${FRAMES_TOTAL})`);
    check(job.backend === "client", `the job's backend field is "${job.backend}"`);

    const before = await waitForFrames(page1, job.id, CLOSE_AFTER_FRAMES);
    console.log(`  sitting 1 reached frame ${before.framesDone} of ${before.framesTotal}; closing the page`);
    await page1.close(); // the tab is GONE: context, worker, canvases, all of it

    // The deck is REWRITTEN while nothing is rendering. A resumed render that read
    // the live project instead of its snapshot would splice two documents.
    const rewritten = await probe.page.evaluate(async (u) => {
      const { createRegistry } = await import(u.registry);
      const { createCommands } = await import(u.commands);
      const { registerAll } = await import(u.plugins);
      const { probeDoc } = await import(u.fixture);
      const registry = createRegistry();
      registerAll(registry, createCommands());
      const doc = probeDoc(registry, { particles: true });
      doc.slides[0].delta.items.shp00001.fill = "#11ff11";
      doc.slides[1].delta.items.shp00001.fill = "#11ff11";
      return doc;
    }, urls);
    await putProjectDoc(probe.backend.port, PROJECT, rewritten);

    // ── SITTING 2: a BRAND-NEW page resumes it ───────────────────────────────
    const page2 = await probe.newPage();
    await installProbeApi(page2, urls, true);
    // The closed tab's LEASE must clear. It does so immediately if its `pagehide`
    // handler committed, and otherwise when it goes stale — the guarantee is the
    // staleness timeout, so the wait is bounded by it plus a margin rather than
    // assuming the fast path fired.
    const status = await waitForPaused(page2, job.id);
    check(Boolean(status), `the new page found the paused job in this browser's store`);
    check(status?.driver === "paused", `the new page sees the job as PAUSED, not rendering (driver=${status?.driver})`);
    check(status?.canResumeHere === true, "the new page can resume it");
    if (encoder === "wasm") {
      const segFrames = PROBE_FPS * 2; // SEGMENT_SECONDS * fps
      check(status.framesDone > 0 && status.framesDone % segFrames === 0,
        `the wasm resume point is a whole segment multiple: ${status.framesDone} frames (segment = ${segFrames})`);
      check(status.framesDone < before.framesDone,
        `the mid-segment frames are honestly discarded: persisted ${status.framesDone} < rendered ${before.framesDone}`);
    } else {
      check(status.framesDone === null || status.framesDone === undefined || status.framesDone >= 0, "the upload encoder's progress comes from the server, not the local store");
    }

    await page2.evaluate((id) => window.__probe.resume(id), job.id);
    // The resume point is only known once the encoder has been asked, so wait for a
    // real number rather than reading the "starting" placeholder.
    const resumeStart = await waitForKnownFrameCount(page2, job.id);
    // The RESUME POINT is what the paused status reported (the frames actually
    // written down); the first live count after resuming is already a few frames
    // past it, so it is a lower bound, not the point itself.
    console.log(`  sitting 2 resumed from frame ${status.framesDone ?? "(server count)"}; first live count ${resumeStart?.framesDone} of ${FRAMES_TOTAL}`);
    check((resumeStart?.framesDone ?? 0) > 0, `the resume STARTED PART-WAY (already at frame ${resumeStart?.framesDone}), it did not restart at 0`);
    if (encoder === "upload")
      check(resumeStart.framesDone >= CLOSE_AFTER_FRAMES - 1,
        `the upload encoder resumed at the exact frame on disk (${resumeStart.framesDone}, closed at ${before.framesDone})`);

    const finished = await waitForServerDone(probe.backend.port, PROJECT, job.id);
    const outcome = await page2.evaluate(() => window.__probe.resumed);
    check(outcome?.ok === true, `the resumed render completed without error${outcome?.ok ? "" : `: ${outcome?.error}`}`);
    check(finished.state === "done", `the shared job record reached "done" (${finished.state})`);
    check(Boolean(finished.output), `the movie landed in the project's renders/ folder as ${finished.output}`);

    // ── THE MOVIE ITSELF ─────────────────────────────────────────────────────
    const movie = await fetch(`http://127.0.0.1:${probe.backend.port}/render/${PROJECT}/${encodeURIComponent(finished.output)}`);
    check(movie.ok, `the finished movie is served back (HTTP ${movie.status})`);
    const path = join(OUT_DIR, `resume_${encoder}.mp4`);
    writeFileSync(path, Buffer.from(await movie.arrayBuffer()));
    const info = videoInfo(path);
    check(info.codec_name === "h264", `codec h264 (${info.codec_name})`);
    check(Number(info.width) === WIDTH && Number(info.height) === HEIGHT, `dimensions ${info.width}x${info.height}`);
    check(Number(info.nb_read_frames) === FRAMES_TOTAL, `ffmpeg DECODED ${info.nb_read_frames} frames (expected ${FRAMES_TOTAL})`);
    check(info.avg_frame_rate === `${PROBE_FPS}/1`, `frame rate ${info.avg_frame_rate}`);

    // FROZEN SPARKLER: the deck has a particle emitter, so if presentation time were
    // not driven per frame every frame of a slide would be identical.
    const decoded = decodeRaw(path);
    const distinct = distinctFrameCount(decoded);
    check(distinct === FRAMES_TOTAL, `all ${distinct} decoded frames are DISTINCT (expected ${FRAMES_TOTAL}) — the particle emitter animated`);

    // SNAPSHOT ISOLATION: the shape must be the ORIGINAL colour on both sides of
    // the resume boundary, never the colour the project was rewritten to.
    const half = FRAMES_TOTAL / 2;
    const slide1 = colorCounts(decoded, SLIDE1_FILL);
    const slide2 = colorCounts(decoded, SLIDE2_FILL);
    const rewrite = colorCounts(decoded, REWRITE_FILL);
    const firstHalf = slide1.slice(0, half);
    const secondHalf = slide2.slice(half);
    check(firstHalf.every((n) => n >= MIN_SHAPE_PIXELS),
      `every frame of slide 1 contains the SNAPSHOT's shape colour (min ${Math.min(...firstHalf)} sampled px, need ${MIN_SHAPE_PIXELS})`);
    check(secondHalf.every((n) => n >= MIN_SHAPE_PIXELS),
      `every frame of slide 2 contains the SNAPSHOT's shape colour (min ${Math.min(...secondHalf)} sampled px, need ${MIN_SHAPE_PIXELS})`);
    check(rewrite.every((n) => n < MIN_SHAPE_PIXELS),
      `NO frame contains the colour the project was rewritten to mid-render (max ${Math.max(...rewrite)} sampled px)`);
    // The shape does CHANGE colour at the slide boundary, so a movie that quietly
    // rendered slide 1 twice would otherwise pass everything above.
    check(slide2.slice(0, half).every((n) => n < MIN_SHAPE_PIXELS) && slide1.slice(half).every((n) => n < MIN_SHAPE_PIXELS),
      "the two halves are the two DIFFERENT slides, not the same one twice");

    // The local resume data must be gone once the movie exists — otherwise the UI
    // would offer to resume something that is finished.
    const after = await page2.evaluate((p) => window.__probe.statuses(p), PROJECT);
    check(after[job.id] === undefined, "the finished job's local resume data was dropped");
    await page2.close();
    console.log(`  movie: ${path}`);
  }

  // ── ONE JOB LIST, TWO BACKENDS ────────────────────────────────────────────
  console.log("\n════ ONE JOB LIST ════");
  const serverSubmit = await fetch(`http://127.0.0.1:${probe.backend.port}/api/render-jobs/${PROJECT}/`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ServerSide", backend: "server", framesTotal: 4, params: jobParams(), doc: rewrittenDocPlaceholder() }),
  });
  const submitted = await serverSubmit.json();
  check(serverSubmit.ok, `a server-backend job submits alongside the browser ones${serverSubmit.ok ? "" : `: ${submitted.error}`}`);
  const list = await (await fetch(`http://127.0.0.1:${probe.backend.port}/api/render-jobs/${PROJECT}/`)).json();
  const backends = new Set(list.jobs.map((j) => j.backend));
  check(backends.has("client") && backends.has("server"), `ONE list holds both backends: ${[...backends].join(" + ")}`);
  const browserRows = list.jobs.filter((j) => j.backend === "client");
  check(browserRows.length === 2, `both browser renders are in it (${browserRows.length})`);
  check(browserRows.every((j) => j.state === "done" && j.output && j.params && j.framesTotal === FRAMES_TOTAL),
    "every browser row carries the same fields a server row does (state/output/params/framesTotal)");

  if (probe.errors.length) {
    console.log("\nPAGE ERRORS");
    for (const e of probe.errors) console.log(`  ${e}`);
  }
  console.log(fails.length === 0 ? "\nALL CHECKS PASSED" : `\n${fails.length} CHECK(S) FAILED:\n  ${fails.map((f) => `- ${f}`).join("\n  ")}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
} finally {
  await probe.stop();
}

/** Pure function. A minimal one-slide document for the server-backend list check —
 *  it only has to be submittable; its pixels are not examined.
 *  @example rewrittenDocPlaceholder().slides.length // 1 */
function rewrittenDocPlaceholder() {
  return {
    meta: { name: PROJECT, slideW: PROBE_WIDTH, slideH: PROBE_HEIGHT },
    slides: [{
      id: "slide0001", name: "Slide 1",
      transition: { type: "tween", seconds: 0, curve: "smooth", sound: null },
      delta: { items: {} },
    }],
  };
}
