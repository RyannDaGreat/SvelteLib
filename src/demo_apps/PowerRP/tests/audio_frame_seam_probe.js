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
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 30000 });

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
      window.__setParamLog.push({ id, key, value });
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
