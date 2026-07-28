/**
 * DOES THE RENDER CENTER EVER SAY "nothing is rendering" WHILE FRAMES LAND?
 *
 * The user saw this sentence in one tab, with no other tab open, and the number in
 * it climbing 184 -> 185 -> 186:
 *
 *     "Paused at 185 of 900 frames — nothing is rendering. Resume to continue."
 *
 * That is the browser-side twin of the server defect in 5b575b9, where a job read
 * "queued" while its frame count went 634 -> 650: a liveness question answered from
 * a RECORD instead of from the running work.
 *
 * WHAT THIS PROBE PROVED, and it is not what was expected. The lease was NOT expired.
 * The heartbeat in the store was 0-49 ms old at the moment the Render Center's own
 * query called the render paused. The fault was a CLOCK SKEW ACROSS A BLOCKED MAIN
 * THREAD: `browserJobStatuses` read the stored record, then took `Date.now()`, and
 * the frame walk holds the main thread for one whole output frame (measured 7.4 s for
 * a 4K frame at 16 temporal subsamples; 77 s for the first frame of a shader deck,
 * which compiles), so the record's callback was delivered on the far side of a block
 * whose length was then charged to the heartbeat's age. A perfectly healthy driver
 * therefore looked expired by exactly the cost of one frame — and the tab it looked
 * expired to was the tab making the frames, which knew better all along: `live` holds
 * that fact in memory and was already being used for the NUMBER in the same sentence.
 * One sentence, two sources, opposite answers.
 *
 * THE SECOND, WORSE CONSEQUENCE, also observed here: `canResumeHere` is
 * `driver === "paused"`, so the false verdict put a RESUME button on a render that
 * was running, and driveBrowserJob's guard only refused a second TAB. Clicking it
 * would have walked the same job twice and interleaved two passes into one movie.
 *
 * WHY THE SAMPLERS RUN IN THE PAGE. The defect is a scheduling artifact, so it only
 * exists for a reader sharing the frame walk's event loop. Sampling over CDP from
 * node would run in a different queue and could never see it.
 *
 * TWO TRACES, because they answer different questions:
 *   THE DISPLAY  RenderCenterModal.svelte's refresh() transcribed verbatim — two
 *                separate assignments, no re-entrancy guard — plus a synchronous
 *                recorder reading only what the markup reads. This is the sentence.
 *   THE QUERY    browserJobStatuses itself, with no HTTP awaited first, beside
 *                driverState's raw inputs. The modal happens to await a network round
 *                trip before it reads IndexedDB, and that round trip is usually long
 *                enough for the heartbeat's own pending write to commit — so the
 *                display escapes more often than the query does. A query with two
 *                answers depending on what its caller awaited first is broken
 *                whichever answer reaches the screen.
 *
 * SLOW FRAMES ARE THE POINT, NOT A CHEAT. 4K at 16 subsamples is a resolution the
 * dialog offers and the maximum motion blur it allows, and one such frame exceeds
 * LEASE_STALE_MS on this machine. That is the condition the user's heavy deck met.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/browser_lease_liveness_probe.js
 *   node src/demo_apps/PowerRP/tests/browser_lease_liveness_probe.js --encoder=wasm
 */

import { bootProbe, checker } from "./browser_render_harness.js";
import { probeParams } from "./browser_render_fixture.js";
import { LEASE_STALE_MS, LEASE_HEARTBEAT_MS } from "../web/browserJobStore.js";

/** The modal's poll cadence (web/RenderCenterModal.svelte POLL_MS). Mirrored, not
 *  imported, because a .svelte file cannot be loaded in bare node. */
const MODAL_POLL_MS = 1000;
/**
 * Output size and motion-blur subsamples: the dialog's 4K preset at its MAX_SAMPLES.
 * One output frame at this setting occupies the main thread for longer than
 * LEASE_STALE_MS on this machine, which is the whole precondition.
 */
const WIDTH = 3840;
const HEIGHT = 2160;
const SAMPLES = 16;
/** Hold per slide; the fixture has two slides at PROBE_FPS, so this sets the frame
 *  count. Six frames of the above is about two minutes — enough polls to land on the
 *  unlucky interleaving several times, and inside the runner's browser budget. */
const HOLD_SECONDS = 0.3;
/**
 * THE DECK. The fixture's hexagon plus a fractal panel covering the camera. The
 * fractal is not decoration: it makes a frame's cost realistic rather than a bare
 * readback, and its first frame compiles shaders, which is the longest single block
 * a real render produces. The knobs are the plugin's own, at values its help text
 * calls expensive — a view full of INTERIOR with the early interior certificate off,
 * which that help text measures at 4.3x the cost of leaving it on.
 */
const HEAVY_ITEM = {
  type: "demo_mandelbrot",
  zoomExponent: -0.2,      // the whole set: maximum interior in frame
  maxIterations: 2048,     // the plugin's own ceiling
  interiorTest: "off",     // no early exit — every interior pixel runs the full budget
};
/** How long the whole render may take before the probe declares it stuck. */
const RENDER_TIMEOUT_MS = 540_000;
/** How often node drains the page's buffers, so the trace survives a late failure. */
const DRAIN_MS = 1000;
/** A watchdog timer in the page records the gap between its own firings; a gap over
 *  this is a main-thread block worth counting. */
const BLOCK_WATCHDOG_MS = 100;
const PROJECT = "LeaseLivenessProbe";

const encoder = (process.argv.find((a) => a.startsWith("--encoder=")) ?? "--encoder=upload").split("=")[1];

/** Server job states that mean the job will not progress any further. */
const TERMINAL_STATES = ["done", "failed", "cancelled"];

/**
 * Query (async; HTTP). One render job's server state, or "missing".
 *
 * @param {number} port Backend port.
 * @param {string} jobId
 * @returns {Promise<string>}
 */
async function jobState(port, jobId) {
  const res = await fetch(`http://127.0.0.1:${port}/api/render-jobs/${PROJECT}/`);
  if (!res.ok) throw new Error(`probe: could not list render jobs: ${res.status}`);
  const { jobs } = await res.json();
  return jobs.find((j) => j.id === jobId)?.state ?? "missing";
}

/**
 * Pure function. The samples that CONTRADICT themselves: a sample claiming nothing
 * is rendering whose frame count is strictly greater than an earlier sample's.
 *
 * A single "paused" sample proves nothing on its own — a render really can be
 * paused. The lie is only demonstrable when the count MOVED while the words said it
 * had not, which is exactly what the user watched happen.
 *
 * @param {{framesShown: number|null, driver: string}[]} samples In time order.
 * @returns {{index: number, framesShown: number, previous: number}[]}
 *
 * @example
 * // The count moved under a "paused" line -> a contradiction at index 1:
 * contradictions([{framesShown: 184, driver: "paused"}, {framesShown: 185, driver: "paused"}])
 * // [{index: 1, framesShown: 185, previous: 184}]
 * @example
 * // A genuinely paused render holds still, so nothing is reported:
 * contradictions([{framesShown: 40, driver: "paused"}, {framesShown: 40, driver: "paused"}]) // []
 * @example
 * // Progress reported as progress is fine:
 * contradictions([{framesShown: 1, driver: "here"}, {framesShown: 2, driver: "here"}]) // []
 */
export function contradictions(samples) {
  const out = [];
  let high = null;
  for (const [index, s] of samples.entries()) {
    const n = s.framesShown;
    if (typeof n === "number" && s.driver === "paused" && high !== null && n > high)
      out.push({ index, framesShown: n, previous: high });
    if (typeof n === "number" && (high === null || n > high)) high = n;
  }
  return out;
}

const probe = await bootProbe();
const { check, fails } = checker();

try {
  const put = await fetch(`http://127.0.0.1:${probe.backend.port}/api/project/${PROJECT}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: { name: PROJECT }, slides: [] }),
  });
  if (!put.ok) throw new Error(`probe: could not create the project: ${put.status}`);

  const started = await probe.page.evaluate(async (u, params, project, kind, pollMs, watchdogMs, heavy) => {
    const { createRegistry } = await import(u.registry);
    const { createCommands } = await import(u.commands);
    const { registerAll } = await import(u.plugins);
    const { repairedDocument } = await import(u.document);
    const { loadFonts } = await import(u.fonts);
    const { probeDoc } = await import(u.fixture);
    const jobs = await import(u.browserRenderJobs);
    const store = await import(u.browserJobStore);
    const view = await import(u.browserJobView);
    const api = await import(u.projectApi);

    await loadFonts();
    const registry = createRegistry();
    registerAll(registry, createCommands());
    // Particles are in the deck for the same reason the resume probe includes them:
    // they are the recordable-state hazard, and they make every frame real work.
    const base = probeDoc(registry, { particles: true });
    // The fractal panel covers the camera exactly, so the whole output frame is its
    // cost. Built from the plugin's own defaults, like every item in the fixture.
    const cam = base.slides[0].delta.items.cam00001;
    base.slides[0].delta.items.mnd00001 = {
      ...registry.get(heavy.type).defaults, ...heavy,
      x: cam.x, y: cam.y, w: cam.w, h: cam.h, z: 1,
    };
    const { doc } = repairedDocument(base, registry);

    // ── The watchdog: how long does the frame walk hold the main thread? ──────
    const blocks = [];
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (gap > watchdogMs) blocks.push(Math.round(gap));
    }, watchdogMs / 2);

    // ── TRACE ONE: THE DISPLAY ────────────────────────────────────────────────
    // `refresh` is RenderCenterModal.svelte's refresh(), verbatim down to the two
    // separate assignments and the absence of a re-entrancy guard — both of which
    // were candidate causes, so modelling them away would model the bug away.
    let uiJobs = [];
    let uiStatus = {};
    let uiError = null;
    let refreshes = 0;
    let inFlight = 0;
    const refresh = async () => {
      refreshes += 1;
      inFlight += 1;
      try {
        uiJobs = await api.listRenderJobs(project);
        uiStatus = await jobs.browserJobStatuses(project);
        uiError = null;
      } catch (e) {
        uiError = String(e?.message ?? e);
      } finally {
        inFlight -= 1;
      }
    };
    setInterval(refresh, pollMs);

    // The recorder reads only what the modal's markup reads, synchronously, so a
    // sample is a snapshot of the DISPLAY rather than of a fetch: the sentence on
    // screen is derived at paint time from whatever those two variables last held.
    const samples = [];
    setInterval(() => {
      const at = Math.round(performance.now());
      for (const job of uiJobs) {
        if (job.backend !== "client") continue;
        const s = uiStatus[job.id] ?? null;
        samples.push({
          at,
          state: job.state,
          // What the sentence names — the number the user watched climb.
          framesShown: s?.framesDone ?? job.framesDone ?? null,
          driver: s?.driver ?? "no-local-record",
          hasLiveEntry: Boolean(jobs.liveBrowserProgress()[job.id]),
          refreshes,
          inFlight,
          uiError,
          line: view.browserJobStatusLine(job, s),
        });
      }
    }, pollMs);

    // ── TRACE TWO: THE QUERY, and driverState's raw inputs ────────────────────
    const leases = [];
    setInterval(async () => {
      const at = Math.round(performance.now());
      const status = await jobs.browserJobStatuses(project);
      const live = jobs.liveBrowserProgress();
      // The same inputs, read again in the SAFE order: `now` before the store read,
      // so a delayed read can only make the heartbeat look younger. Printing both
      // verdicts side by side is what attributes the fault to the skew rather than
      // to an expired lease — `replicated` says "here" in the very samples where
      // the query said "paused".
      const now = Date.now();
      const stored = await store.listBrowserJobs(project);
      for (const j of stored) {
        leases.push({
          at, id: j.id,
          driver: status[j.id]?.driver ?? "no-status",
          replicated: store.driverState(j, jobs.thisDriverId(), now, Boolean(live[j.id])),
          isThisTab: j.driverId === jobs.thisDriverId(),
          heartbeatAge: now - j.heartbeatAt,
          statusFramesDone: status[j.id]?.framesDone ?? null,
          liveFramesDone: live[j.id]?.framesDone ?? null,
          drivingHere: Boolean(live[j.id]),
          canResumeHere: status[j.id]?.canResumeHere ?? null,
        });
      }
    }, pollMs);

    const job = await jobs.submitBrowserRenderJob({
      project, name: `Lease ${kind}`, params, doc, registry, encoder: kind,
    });
    window.__leaseProbe = {
      jobId: job.id,
      drain: () => samples.splice(0, samples.length),
      drainLeases: () => leases.splice(0, leases.length),
      blocks: () => blocks.slice(),
    };
    return { jobId: job.id, framesTotal: job.framesTotal };
  }, {
    registry: probe.fsUrl("core/registry.js"),
    commands: probe.fsUrl("core/commands.js"),
    document: probe.fsUrl("core/document.js"),
    plugins: probe.fsUrl("plugins/index.js"),
    fonts: probe.fsUrl("web/fontLoader.js"),
    fixture: probe.fsUrl("tests/browser_render_fixture.js"),
    browserRenderJobs: probe.fsUrl("web/browserRenderJobs.js"),
    browserJobStore: probe.fsUrl("web/browserJobStore.js"),
    browserJobView: probe.fsUrl("web/browserJobView.js"),
    projectApi: probe.fsUrl("web/projectApi.js"),
  }, { ...probeParams({ width: WIDTH, height: HEIGHT, samples: SAMPLES }), holdSeconds: HOLD_SECONDS },
  PROJECT, encoder, MODAL_POLL_MS, BLOCK_WATCHDOG_MS, HEAVY_ITEM);

  console.log(`\nRendering ${started.framesTotal} frames at ${WIDTH}x${HEIGHT}, samples=${SAMPLES}, encoder=${encoder}`);
  console.log(`Lease: heartbeat every ${LEASE_HEARTBEAT_MS} ms, stale after ${LEASE_STALE_MS} ms. Modal poll ${MODAL_POLL_MS} ms.\n`);
  console.log("THE DISPLAY — what the Render Center's markup would have shown");
  console.log("   t(ms)  frames  driver     live  refr  fly  sentence");

  const all = [];
  const allLeases = [];
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  for (;;) {
    const batch = await probe.page.evaluate(() => window.__leaseProbe.drain());
    allLeases.push(...await probe.page.evaluate(() => window.__leaseProbe.drainLeases()));
    for (const s of batch) {
      all.push(s);
      console.log(
        `  ${String(s.at).padStart(6)}  ${String(s.framesShown ?? "—").padStart(6)}  ` +
        `${s.driver.padEnd(10)} ${(s.hasLiveEntry ? "yes" : "NO ").padEnd(5)} ` +
        `${String(s.refreshes).padStart(4)} ${String(s.inFlight).padStart(4)}  ` +
        `${s.uiError ? `[refresh error: ${s.uiError}] ` : ""}${s.line.slice(0, 74)}`,
      );
    }
    // TERMINAL means the SERVER says so. The page's live entry is not a stop
    // condition: it does not exist until the drive's first await has resolved, and a
    // probe that treated "no live entry" as done would exit before rendering began —
    // which is exactly what the first run of this probe did.
    const state = await jobState(probe.backend.port, started.jobId);
    if (TERMINAL_STATES.includes(state)) { console.log(`\nServer state: ${state}`); break; }
    if (Date.now() > deadline) throw new Error(`probe: the render did not finish within ${RENDER_TIMEOUT_MS} ms (server state ${state}).`);
    await new Promise((r) => setTimeout(r, DRAIN_MS));
  }

  const blocks = await probe.page.evaluate(() => window.__leaseProbe.blocks());
  const worst = blocks.length ? Math.max(...blocks) : 0;
  console.log(`\nMAIN-THREAD BLOCKS over ${BLOCK_WATCHDOG_MS} ms: ${blocks.length}, worst ${worst} ms. ` +
    `A block over ${LEASE_STALE_MS} ms is what the skew charged to the heartbeat.`);

  console.log("\nTHE QUERY — browserJobStatuses, beside driverState's inputs read in the safe order");
  console.log("   t(ms)  driver     safe-order  driving  liveF  statF  hbAge  ownLease  offersResume");
  for (const l of allLeases) {
    console.log(
      `  ${String(l.at).padStart(6)}  ${l.driver.padEnd(10)} ${l.replicated.padEnd(11)} ` +
      `${String(l.drivingHere).padEnd(8)} ${String(l.liveFramesDone ?? "—").padStart(5)}  ` +
      `${String(l.statusFramesDone ?? "—").padStart(5)}  ${String(l.heartbeatAge).padStart(5)}  ` +
      `${String(l.isThisTab).padEnd(8)}  ${l.canResumeHere}`,
    );
  }

  // THE DEFECT, as the one claim that cannot be true: the query said nothing was
  // driving a job whose frames this very tab was producing at that instant.
  const lies = allLeases.filter((l) => l.drivingHere && l.driver !== "here");
  console.log(`\nbrowserJobStatuses answers contradicting this tab's own live progress: ${lies.length}`);
  for (const l of lies)
    console.log(`  t=${l.at}: driver "${l.driver}" while this tab was on frame ${l.liveFramesDone} ` +
      `(own lease ${l.isThisTab}, heartbeat ${l.heartbeatAge} ms old, offers Resume: ${l.canResumeHere})`);

  const bad = contradictions(all);
  console.log(`\nDisplayed lines saying nothing is rendering while the count MOVED: ${bad.length}`);
  for (const c of bad) console.log(`  sample ${c.index}: ${c.previous} -> ${c.framesShown} frames, under "nothing is rendering"`);

  check(all.length > 0, "the modal's poll produced samples during the render");
  check(allLeases.length > 0, "browserJobStatuses was sampled during the render");
  check(blocks.some((b) => b > LEASE_STALE_MS),
    `at least one frame blocked the main thread longer than LEASE_STALE_MS (${LEASE_STALE_MS} ms) — the precondition this probe exists to exercise`);
  check(lies.length === 0, "browserJobStatuses never contradicts this tab's own live progress");
  check(!allLeases.some((l) => l.drivingHere && l.canResumeHere),
    "Resume is never offered for a render this tab is driving");
  check(bad.length === 0, "no displayed line claims nothing is rendering while the frame count climbs");
  check(!all.some((s) => s.uiError), "the modal's refresh never threw");

  if (probe.errors.length) {
    console.log("\nPAGE ERRORS");
    for (const e of probe.errors) console.log(`  ${e}`);
  }
  if (fails.length) {
    console.error(`\nFAILED: ${fails.length} check(s)\n  ${fails.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
} finally {
  await probe.stop();
}
