/**
 * THE AUDIO FRAME SEAM browser probe (R7-2, R7-3, R7-4).
 *
 * ── WHAT ONLY THIS CAN PROVE ────────────────────────────────────────────────
 * tests/audio_mirror_probe.js proves the DOCUMENT reaches the engine. What it
 * cannot reach is the four things the user actually complained about, every one of
 * which is about WHICH FRAME reaches it and WHEN:
 *
 *   1. A cutoff animated from slide to slide must SWEEP, not step. That needs a
 *      mid-transition alpha to arrive at engine.setParam, which nothing on the
 *      audio path carried before this round ("I didn't hear any whoosh").
 *   2. A slide change DURING A PRESENTATION must reach the engine. It did not: the
 *      mirror hung off a $effect in web/CanvasView.svelte whose dependencies do not
 *      change while presenting, so the graph froze at the editor's slide for the
 *      whole show ("the presentation audio seems to behave differently").
 *   3. Sound must start WITHOUT a permission prompt ("Never make me ask that
 *      again"), while the browser's gesture rule is still obeyed.
 *   4. The shared transport must actually run. `setTransportLive` had zero callers
 *      and `engine.scheduler.start()` was never reached from app code, so the
 *      Sequencer node had never emitted a step in either mode.
 *
 * ── HOW IT MEASURES, AND WHY NOT BY EAR ─────────────────────────────────────
 * It does NOT assert on sound (headless has no output device; audio-buffer
 * assertions measure the harness). It WRAPS `engine.setParam` and records the
 * arguments, which is the last hop before the AudioParam and the exact call the
 * user's whoosh is made of. The engine object is reached by importing the app's own
 * module through the dev server, so the probe observes the SAME singleton the app
 * is driving rather than a second one it built.
 *
 * THE GESTURE IS A REAL ONE: page.mouse.click dispatches a trusted event, so the
 * browser's autoplay policy is genuinely satisfied rather than flagged away. No
 * `--autoplay-policy` flag is passed, deliberately — with one, check 3 would prove
 * nothing.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/audio_frame_seam_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
/** Vite's root is `web/`, so a module OUTSIDE it has no plain `/path` URL — it is
 *  served at `/@fs/<absolute path>`, which is the same URL the app's own
 *  `../render_gpu/…` import resolves to and therefore the same module instance.
 *  (Not that identity is taken on trust here: the dictated-interval assertion can
 *  only pass if the override reached the clock the mirror reads.) */
const PARTICLE_CLOCK_URL = `/@fs${resolve(repo, "src/demo_apps/PowerRP/render_gpu/particle_clock.js")}`;

/** Long enough that a puppeteer round-trip lands comfortably inside the tween, so
 *  the mid-flight sample is a real mid-flight sample and not a race. */
const TRANSITION_SECONDS = 2;
/** The cutoff at each end of the animation. Two octaves and a bit apart, so a step
 *  and a sweep are impossible to confuse. */
const CUTOFF_LOW = 400;
const CUTOFF_HIGH = 8000;
/** The Clock node's tempo. Deliberately NOT the scheduler's own factory 90, so
 *  "the transport took the document's tempo" is distinguishable from "the transport
 *  happens to be at its default". */
const DECK_BPM = 150;

/** A deliberately SLOW cadence — 20 fps, the heavy-slide case where a fixed 0.02 s
 *  time constant covers only the first fifth of each frame. Well clear of the
 *  0.02 s floor and of the 0.1 s ceiling, so the measurement lands in the region
 *  where the ramp genuinely tracks the interval. */
const SLOW_FRAME_MS = 50;
const SLOW_FRAMES = 6;
/** ramp ÷ gap. 1.0 is "the ramp exactly spans the gap"; the shortfall allowed here
 *  is for CADENCE JITTER only — the ramp is set from the PREVIOUS gap, so it can
 *  only ever be a predictor of the next one, and a setTimeout cadence is not exact. */
const MIN_RAMP_COVERAGE = 0.75;
/** The camera's DEFAULT maxTimestep, which is also the ramp's default ceiling.
 *  Restated here rather than imported because a probe that imported the value it is
 *  checking would pass whatever the module happened to say. */
const RAMP_CEILING_SECONDS = 0.1;
/** A raised ceiling for the author-honours test — well clear of the 0.1 default, so
 *  "the setting reached the ramp" cannot be confused with "the default did". */
const AUTHOR_CEILING_SECONDS = 0.3;
/** core/audio_mirror_diff.KNOB_RAMP_MIN_SECONDS, restated for the same reason as the
 *  ceiling above. "none" removes the ceiling; nothing removes this. */
const RAMP_FLOOR_SECONDS = 0.02;
/** Longer than every ceiling under test, so each case is genuinely clamped (or, for
 *  "none", genuinely not). */
const IDLE_GAP_MS = 700;
/** A dictated render rate whose frame (1/15 s ≈ 66.7 ms) is far longer than the
 *  wall time the probe actually spends between pushes, so "dictated beat measured"
 *  is unambiguous — and still under the ceiling, so the clamp does not mask it. */
const EXPORT_FPS = 15;
const EXPORT_FRAMES = 4;
const EXPORT_WALL_GAP_MS = 30;

// HMR IS OFF, for the reason cli/render_job.js turns it off: a source edit landing
// mid-run reloads the page and destroys the session this probe is measuring — and
// in a worktree with other agents editing, that is not hypothetical (measured
// 2026-08-06: an unrelated core/node_knobs.js save reloaded the page mid-probe).
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const liveErrors = [];
  page.on("pageerror", (e) => liveErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (isWebGpuAbsenceNoise(m.text())) return;
    if (/\/api\/projects|500 \(Internal Server Error\)/.test(m.text())) return; // no project backend when run alone
    liveErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  // THE SPLASH MUST LIFT BEFORE ANY SYNTHETIC CLICK (tests/puppeteerLaunch.js):
  // it is fixed, inset 0, z-index 9999 until the first real painted frame, so a
  // tap before then lands on the splash and the check flakes 1-in-3.
  // 120 s, matching tests/present_reachable_probe.js and for the reason recorded
  // there: with several agents' Vite servers on one host the dep optimizer keeps the
  // network busy well past the app being interactive, and a tighter timeout reports
  // a loaded HOST as a broken app. Measured here — this threw at 30 s while the same
  // commit booted clean under tests/audio_mirror_probe.js moments later.
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });

  // ── BUILD A THREE-SLIDE DECK WITH AN ANIMATED CUTOFF ──────────────────────
  const ids = await page.evaluate((low, high, bpm, seconds) => {
    const app = window.__powerrp_app;
    const add = (type, x, y) => { app.addItem({ ...app.registry.get(type).defaults, x, y }); return app.selection; };
    const wire = (src, sp, dst, dp) => {
      app.setPreview([[["items", dst, "inputs", dp], { item: src, port: sp }]]);
      app.commitPreview();
    };
    const set = (id, key, value) => { app.setPreview([[["items", id, key], value]]); app.commitPreview(); };

    const noise = add("audio_noise", 100, 120);
    const filter = add("audio_filter", 340, 120);
    const out = add("audio_output", 600, 120);
    const clock = add("audio_clock", 100, 400);
    const sequencer = add("audio_sequencer", 340, 400);
    wire(noise, "out", filter, "in");
    wire(filter, "out", out, "in");
    set(filter, "audioFrequency", low);
    set(clock, "audioBpm", bpm);

    // Slide 1: the SAME filter, keyframed to the other end of the sweep.
    app.addSlide();
    set(filter, "audioFrequency", high);
    // Slide 2: the noise source is DELETED (a keyframed active:false), which is
    // the "declared not visible" half of the culling complaint.
    app.addSlide();
    app.selection = noise;
    app.deleteSelection();

    // A long transition into every slide, so a mid-flight sample is reachable.
    app.commit(app.repaired({
      ...app.doc,
      slides: app.doc.slides.map((s) => ({ ...s, transition: { ...(s.transition ?? {}), type: s.transition?.type ?? "tween", seconds } })),
    }));
    app.slideIndex = 0;
    return { noise, filter, out, clock, sequencer };
  }, CUTOFF_LOW, CUTOFF_HIGH, DECK_BPM, TRANSITION_SECONDS);
  await sleep(600);

  const mirrorKnob = (id, key) => page.evaluate((id, key) => window.__powerrp_audioScene()?.modules?.[id]?.knobs?.[key] ?? null, id, key);
  const audioStatus = () => page.evaluate(() => window.__powerrp_audioState());

  ok(await mirrorKnob(ids.filter, "frequency") === CUTOFF_LOW,
    `slide 0's cutoff reached the engine (${await mirrorKnob(ids.filter, "frequency")})`);

  // ── 3. AUDIO STARTS FROM A GESTURE THE USER WAS MAKING ANYWAY ─────────────
  const before = await audioStatus();
  ok(before.status === "blocked", `before any gesture the context is suspended (${before.status})`);
  const promptText = await page.evaluate(() => document.querySelector(".nf-audio-badge")?.textContent?.trim() ?? null);
  ok(promptText === null, `and NOTHING asks permission to want sound (${JSON.stringify(promptText)})`);

  // A plain click on empty canvas — the gesture a user makes without being told to.
  const canvasBox = await page.evaluate(() => {
    const c = document.querySelector("canvas.scene") ?? document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height - 40 };
  });
  await page.mouse.click(canvasBox.x, canvasBox.y);
  await page.waitForFunction(() => window.__powerrp_audioState().status !== "blocked", { timeout: 10000 })
    .catch(() => {});
  const after = await audioStatus();
  ok(after.status === "running", `ONE ordinary click started audio, with no badge and no prompt (${after.status}: ${after.reason})`);

  // ── INSTRUMENT setParam: the last hop before the AudioParam ───────────────
  // THE IMPORT MUST YIELD THE APP'S OWN MODULE, not a second copy of it — a probe
  // that wrapped a different singleton's setParam would record nothing and read as
  // a regression. `audioState` is the module's one piece of reactive state and
  // web/main.js re-exports the app's copy of it, so comparing the two identities is
  // the cheapest honest check that this is the same module object.
  const sameModule = await page.evaluate(async () => {
    const mirror = await import("/audioMirror.svelte.js");
    const engine = mirror.audioEngine();
    if (!engine) return { shared: false, why: `audioEngine() is null while the app reports ${window.__powerrp_audioState().status}` };
    window.__setParamLog = [];
    const original = engine.setParam.bind(engine);
    engine.setParam = (id, key, value, options) => {
      // `when` is the AUDIO clock, which is the clock the ramp is scheduled against
      // (synth/engine.js reads context.currentTime), so a gap computed from two of
      // these is the gap the hardware really sees between two pushes.
      window.__setParamLog.push({ id, key, value, rampSeconds: options?.rampSeconds ?? 0, when: engine.context.currentTime });
      return original(id, key, value, options);
    };
    return { shared: mirror.audioState.status === window.__powerrp_audioState().status, why: mirror.audioState.status };
  });
  ok(sameModule.shared, `the probe reached the APP's audio module, not a second copy of it (${sameModule.why})`);

  // ── 1. A MID-TRANSITION ALPHA REACHES setParam ────────────────────────────
  // Driven straight through the seam at known alphas, because that is the claim:
  // the mirror takes an evaluated [[slide, alpha]] frame, exactly as cameraFrameIR
  // does. The waits between alphas are not padding — queueApply COLLAPSES batches
  // while one is applying (deliberately: a drag must not queue a frame of lag), so
  // without them the intermediate scenes would be skipped rather than sent.
  const alphas = [0, 0.25, 0.5, 0.75, 1];
  for (const alpha of alphas) {
    await page.evaluate(async (alpha) => {
      const [mirror, camera] = await Promise.all([import("/audioMirror.svelte.js"), import("/cameraFrame.js")]);
      const app = window.__powerrp_app;
      mirror.mirrorAudioFrame(camera.evaluatedStateAt(app.doc, 1, alpha, app.registry), app.registry);
    }, alpha);
    await sleep(150);
  }
  const swept = await page.evaluate((id) => window.__setParamLog.filter((c) => c.id === id && c.key === "frequency").map((c) => c.value), ids.filter);
  console.log(`  note  cutoff values that reached engine.setParam across alpha ${JSON.stringify(alphas)}: ${JSON.stringify(swept)}`);
  ok(swept.length >= 4, `every alpha put a cutoff on the wire (${swept.length} setParam calls: ${JSON.stringify(swept)})`);
  ok(swept.every((v, i) => i === 0 || v > swept[i - 1]), `and they are strictly MONOTONIC — a sweep, not a step (${JSON.stringify(swept)})`);
  ok(swept.some((v) => v > CUTOFF_LOW && v < CUTOFF_HIGH),
    `with genuinely intermediate values between ${CUTOFF_LOW} and ${CUTOFF_HIGH} (${JSON.stringify(swept)})`);
  ok(Math.abs(swept[swept.length - 1] - CUTOFF_HIGH) < 1e-6, `and it lands exactly on the keyframe at alpha 1 (${swept[swept.length - 1]})`);

  // ── 5. THE RAMP SPANS THE FRAME IT BRIDGES, NOT A FIXED 20 ms ─────────────
  // A fixed 0.02 s time constant covers only the first fifth of a 20 fps frame, so
  // the parameter lunges 92% of the way and then all but stops for 30 ms — a
  // staircase, every frame, on any heavy slide. What is measured here is the thing
  // that decides it: ramp ÷ the gap the hardware actually saw. Below 1 the segment
  // has gone quiet before the next target lands (piecewise-constant); at 1 it is
  // still in motion when retargeted (continuous).
  await page.evaluate(() => { window.__setParamLog.length = 0; });
  for (let i = 0; i < SLOW_FRAMES; i++) {
    await page.evaluate(async (alpha) => {
      const [mirror, camera] = await Promise.all([import("/audioMirror.svelte.js"), import("/cameraFrame.js")]);
      const app = window.__powerrp_app;
      mirror.mirrorAudioFrame(camera.evaluatedStateAt(app.doc, 1, alpha, app.registry), app.registry);
    }, i / (SLOW_FRAMES - 1));
    await sleep(SLOW_FRAME_MS);
  }
  const slow = await page.evaluate((id) => window.__setParamLog.filter((c) => c.id === id && c.key === "frequency"), ids.filter);
  const coverage = slow.slice(1).map((c, i) => c.rampSeconds / (c.when - slow[i].when));
  const oldCoverage = slow.slice(1).map((c, i) => 0.02 / (c.when - slow[i].when));
  console.log(`  note  at a ~${SLOW_FRAME_MS} ms cadence: ramps ${JSON.stringify(slow.map((c) => +c.rampSeconds.toFixed(4)))}`);
  console.log(`  note  ramp÷gap now ${JSON.stringify(coverage.map((c) => +c.toFixed(2)))} — with the old fixed 0.02 it would have been ${JSON.stringify(oldCoverage.map((c) => +c.toFixed(2)))}`);
  ok(coverage.length >= 3, `enough slow frames to compare (${coverage.length})`);
  ok(coverage.every((c) => c >= MIN_RAMP_COVERAGE),
    `EVERY ramp still spans its gap — the parameter is continuous across frame boundaries (${JSON.stringify(coverage.map((c) => +c.toFixed(2)))})`);
  ok(oldCoverage.every((c) => c < MIN_RAMP_COVERAGE),
    `and the fixed 0.02 would have failed that on every one of these frames (${JSON.stringify(oldCoverage.map((c) => +c.toFixed(2)))})`);
  ok(slow.every((c) => c.rampSeconds <= RAMP_CEILING_SECONDS + 1e-9),
    `no ramp exceeds the ceiling — a stall may not smear a parameter across it (${JSON.stringify(slow.map((c) => +c.rampSeconds.toFixed(4)))})`);

  // ── 6. THE AUTHOR'S CAMERA CLAMP REACHES THE RAMP ─────────────────────────
  // The ceiling is the camera's `maxTimestep`, not a constant, so the setting that
  // protects the simulation from a lag spike protects the audio ramp too. A constant
  // would have made that value HALF-APPLY — obeyed by the simulation and quietly
  // ignored by the audio, which is the inert-control lie the manifest forbids.
  //
  // THIS RUNS BEFORE THE EXPORT SECTION, AND THE ORDER IS LOAD-BEARING. Measured the
  // hard way: with it after, all three cases returned 0.1 and looked like a broken
  // integration. `setParticleTimeOverride` leaves the observed clock instant at the
  // last override (~0.2 s); clearing it returns particleTime() to the constant
  // EDITOR_FREEZE_TIME (2), which is a FORWARD jump, so observeClock computes one
  // final dt, clamps it, and — because the paused clock never moves again — hands
  // back that same memoized number for the rest of the page's life. Presented time
  // then always "moved", the audio-clock fallback was never reached, and the ramp sat
  // pinned at the clamp. Nothing here perturbs the clock, so the fallback measures the
  // real idle.
  //
  // The gap comes from the engine's OWN timestamps on the two pushes bracketing the
  // idle, so a stray mirror pass between them shows up as a shrunken gap rather than
  // silently weakening the assertion.
  let rampAlpha = 0.1;
  /** Drive one mirror pass, optionally overriding the camera's clamp ON THE STATE. */
  const drivePass = async (clampOverride) => {
    rampAlpha += 0.07;
    await page.evaluate(async (alpha, override, applyOverride) => {
      const [mirror, camera] = await Promise.all([import("/audioMirror.svelte.js"), import("/cameraFrame.js")]);
      const app = window.__powerrp_app;
      const state = camera.evaluatedStateAt(app.doc, 1, alpha, app.registry);
      if (applyOverride) {
        const camId = Object.entries(state.items).find(([, it]) => it?.type === "camera")[0];
        state.items = { ...state.items, [camId]: { ...state.items[camId], maxTimestep: override } };
      }
      mirror.mirrorAudioFrame(state, app.registry);
    }, rampAlpha, clampOverride ?? null, clampOverride !== undefined);
  };
  const rampAfterIdle = async (clampOverride) => {
    await page.evaluate(() => { window.__setParamLog.length = 0; });
    await drivePass(clampOverride);
    await sleep(IDLE_GAP_MS);
    await drivePass(clampOverride);
    return page.evaluate((id) => {
      const l = window.__setParamLog.filter((c) => c.id === id && c.key === "frequency");
      return l.length < 2 ? null : { ramp: l[l.length - 1].rampSeconds, gap: l[l.length - 1].when - l[l.length - 2].when };
    }, ids.filter);
  };
  const setCameraClamp = (value) => page.evaluate((v) => {
    const app = window.__powerrp_app;
    const camId = Object.entries(app.state().items).find(([, it]) => it?.type === "camera")[0];
    app.setPreview([[["items", camId, "maxTimestep"], v]]);
    app.commitPreview();
  }, value);

  // ABSENT (the deck as built) → the default ceiling.
  const defaultCeiling = await rampAfterIdle(undefined);
  // RAISED, written as an ordinary keyframed leaf on the camera, exactly as an
  // Inspector row would write it.
  await setCameraClamp(AUTHOR_CEILING_SECONDS);
  await sleep(250);
  const raisedCeiling = await rampAfterIdle(undefined);
  // "NONE" IS SUPPLIED ON THE STATE, NOT WRITTEN TO THE DOCUMENT, and that is a
  // reported gap rather than a shortcut: a `null` does not survive
  // app.commitPreview (measured — the leaf comes back ABSENT, which reads as the
  // default), and `maxTimestep` has no Inspector row to write it with in the first
  // place. What this still proves end to end is the half that is mine: when the
  // evaluated state says "none", the ramp honours it all the way to engine.setParam.
  const noCeiling = await rampAfterIdle(null);
  console.log(`  note  after a ~${IDLE_GAP_MS} ms idle — absent ${JSON.stringify(defaultCeiling)}, raised ${JSON.stringify(raisedCeiling)}, none ${JSON.stringify(noCeiling)}`);
  ok(defaultCeiling && Math.abs(defaultCeiling.ramp - RAMP_CEILING_SECONDS) < 1e-9,
    `an ABSENT clamp caps the ramp at the ${RAMP_CEILING_SECONDS}s default (got ${defaultCeiling?.ramp})`);
  ok(raisedCeiling && Math.abs(raisedCeiling.ramp - AUTHOR_CEILING_SECONDS) < 1e-9,
    `the author RAISING it to ${AUTHOR_CEILING_SECONDS}s raises the ramp to ${AUTHOR_CEILING_SECONDS}s — the value is not half-applied (got ${raisedCeiling?.ramp})`);
  ok(noCeiling && noCeiling.ramp > AUTHOR_CEILING_SECONDS && Math.abs(noCeiling.ramp - noCeiling.gap) / noCeiling.gap < 0.15,
    `"none" removes the ceiling entirely — the ramp is the whole ${noCeiling?.gap?.toFixed(3)}s gap (got ${noCeiling?.ramp?.toFixed(3)})`);

  // AND THE FLOOR STILL HOLDS UNDER "none" — it removes the CEILING, not the floor.
  await page.evaluate(() => { window.__setParamLog.length = 0; });
  for (let i = 0; i < 3; i++) { await drivePass(null); await sleep(5); }
  const fastRamps = await page.evaluate((id) => window.__setParamLog.filter((c) => c.id === id && c.key === "frequency").map((c) => c.rampSeconds), ids.filter);
  ok(fastRamps.length >= 2 && fastRamps.slice(1).every((r) => Math.abs(r - RAMP_FLOOR_SECONDS) < 1e-9),
    `with no ceiling at all, a fast cadence still sits exactly on the ${RAMP_FLOOR_SECONDS}s anti-zipper floor (${JSON.stringify(fastRamps.map((r) => +r.toFixed(4)))})`);

  // Back to the default, so the sections after this measure the deck as described.
  await setCameraClamp(RAMP_CEILING_SECONDS);
  await sleep(250);

  // ── 7. IN AN EXPORT THE INTERVAL IS DICTATED, NOT MEASURED ────────────────
  // An exporter overrides presentation time per frame (1/fps), so presented time
  // moves 1/15 s while WALL time between these calls is ~30 ms. The dictated value
  // must win, exactly as core/simulation_history.beginSimulationStep prefers a
  // dictated timestep over a measured one.
  await page.evaluate(() => { window.__setParamLog.length = 0; });
  const dictated = await page.evaluate(async (fps, frames, gapMs, clockUrl) => {
    const [mirror, camera, clock] = await Promise.all([
      import("/audioMirror.svelte.js"), import("/cameraFrame.js"), import(clockUrl),
    ]);
    const app = window.__powerrp_app;
    try {
      for (let i = 0; i < frames; i++) {
        clock.setParticleTimeOverride(i / fps);
        // Alphas chosen so every frame is a real knob change; a zero-op diff would
        // issue no setParam and there would be nothing to measure.
        mirror.mirrorAudioFrame(camera.evaluatedStateAt(app.doc, 1, (i + 1) / (frames + 1), app.registry), app.registry);
        await new Promise((r) => setTimeout(r, gapMs));
      }
    } finally {
      clock.setParticleTimeOverride(null); // never leave the app's one clock overridden
    }
    return window.__setParamLog.filter((c) => c.key === "frequency").map((c) => c.rampSeconds);
  }, EXPORT_FPS, EXPORT_FRAMES, EXPORT_WALL_GAP_MS, PARTICLE_CLOCK_URL);
  console.log(`  note  ramps under a dictated ${EXPORT_FPS} fps (wall gap only ${EXPORT_WALL_GAP_MS} ms): ${JSON.stringify(dictated.map((r) => +r.toFixed(4)))}`);
  ok(dictated.length >= 2, `the dictated pass pushed parameters (${dictated.length})`);
  ok(dictated.slice(1).every((r) => Math.abs(r - 1 / EXPORT_FPS) < 1e-6),
    `a ${EXPORT_FPS} fps render ramps over exactly 1/${EXPORT_FPS} s, not over the ${EXPORT_WALL_GAP_MS} ms of wall time it happened to take (${JSON.stringify(dictated.map((r) => +r.toFixed(4)))})`);

  // ── 4. THE TRANSPORT IS ALIVE, AND IT IS THE DOCUMENT'S ───────────────────
  const transport = await page.evaluate(async () => {
    const mirror = await import("/audioMirror.svelte.js");
    const engine = mirror.audioEngine();
    return { running: engine.scheduler.isRunning(), ...engine.scheduler.transport() };
  });
  ok(transport.running, "the shared transport is RUNNING — it had never been started from app code at all");
  ok(transport.bpm === DECK_BPM, `and it runs at the CLOCK NODE's tempo, not the scheduler's factory default (${transport.bpm}, want ${DECK_BPM})`);

  // Steps are counted at the engine's own subscription point, which is what the
  // sequencer module's playStep is wired to (synth/engine.js addModule).
  const steps = await page.evaluate(async () => {
    const mirror = await import("/audioMirror.svelte.js");
    const engine = mirror.audioEngine();
    let count = 0;
    const off = engine.scheduler.onStep(() => { count += 1; });
    await new Promise((r) => setTimeout(r, 1200));
    off();
    return count;
  });
  ok(steps > 0, `the transport EMITTED STEPS (${steps} in 1.2 s at ${DECK_BPM} BPM) — the Sequencer had never emitted one`);

  // ── 2. A SLIDE CHANGE DURING A PRESENTATION REACHES THE ENGINE ────────────
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; window.__powerrp_app.mode = "present"; });
  await sleep(1200);
  ok(await page.evaluate(() => window.__powerrp_app.mode === "present"), "present mode is up");
  ok(await mirrorKnob(ids.filter, "frequency") === CUTOFF_LOW,
    `the presenter's first frame is slide 0's cutoff (${await mirrorKnob(ids.filter, "frequency")})`);

  await page.keyboard.press("ArrowRight");
  await sleep(TRANSITION_SECONDS * 1000 * 0.45); // mid-flight
  const midFlight = await mirrorKnob(ids.filter, "frequency");
  await sleep(TRANSITION_SECONDS * 1000);
  const settled = await mirrorKnob(ids.filter, "frequency");
  console.log(`  note  presented cutoff: mid-transition ${midFlight}, settled ${settled}`);
  ok(midFlight !== null && midFlight > CUTOFF_LOW && midFlight < CUTOFF_HIGH,
    `MID-PRESENTATION the engine holds an intermediate cutoff — the whoosh (${midFlight})`);
  ok(Math.abs(settled - CUTOFF_HIGH) < 1e-6,
    `and the presented slide change reached the engine at all (${settled}, want ${CUTOFF_HIGH}) — it used to stay frozen at ${CUTOFF_LOW}`);

  // active:false ON A PRESENTED SLIDE really silences its module.
  await page.keyboard.press("ArrowRight");
  await sleep(TRANSITION_SECONDS * 1000 + 800);
  const noiseGone = await page.evaluate((id) => !(id in (window.__powerrp_audioScene()?.modules ?? {})), ids.noise);
  ok(noiseGone, "a widget DELETED on the presented slide left the engine — 'declared not visible' now means silent during a show");

  await page.keyboard.press("Escape");
  await sleep(600);
  ok(await page.evaluate(() => window.__powerrp_app.mode === "edit"), "and the presenter exits cleanly");

  ok(liveErrors.length === 0, `no unexpected console errors during the session (${JSON.stringify(liveErrors.slice(0, 4))})`);
} catch (e) {
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\naudio_frame_seam_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
