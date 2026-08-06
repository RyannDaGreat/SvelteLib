/**
 * AUDIO MIRROR browser probe: the document really reaches the ENGINE, driven through
 * the real editor.
 *
 * ── WHAT ONLY THIS CAN PROVE ────────────────────────────────────────────────
 * tests/audio_nodes_test.js pins the mirror's DECISIONS in bare node — given two
 * scenes, which engine calls happen. What it cannot reach is whether those decisions
 * are ever ASKED FOR: whether the app's derivation pass actually calls the mirror,
 * whether an AudioContext can be constructed at all in a real page, whether the
 * worklets load over the dev server's module graph, and whether the analysis
 * overlays mount on the nodes that declare them. Every one of those is a place where
 * a perfect core and a disconnected app look identical from node — which is exactly
 * the class of gap NF-CORE reported and NF-BIND found (a canvas that never called
 * the thing that was proven correct).
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * IT DOES NOT ASSERT ON SOUND. The brief is explicit: "Audio-audible correctness is
 * proven by synth/dev.html + your own listening via the editor — do not attempt
 * audio-buffer assertions in probes." Headless Chrome has no output device, its
 * AudioContext behaviour under autoplay policy varies by flag set, and an assertion
 * on sample values would be measuring the harness rather than the app. So this probe
 * checks STRUCTURE — that the engine holds the graph the document describes — and
 * leaves timbre to ears.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/audio_mirror_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const liveErrors = [];
  const bootErrors = [];
  const afterBoot = { on: false };
  page.on("pageerror", (e) => (afterBoot.on ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (isWebGpuAbsenceNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  // Same filter nodeflow_probe uses and for the same stated reason: run alone there
  // is no project backend, and reporting an absent dependency as a defect is what the
  // gate's own doctrine forbids.
  const realBootErrors = bootErrors.filter((e) => !/\/api\/projects|500 \(Internal Server Error\)/.test(e));
  ok(realBootErrors.length === 0, `no boot errors beyond the absent project backend (${JSON.stringify(realBootErrors)})`);
  afterBoot.on = true;

  ok(await page.evaluate(() => typeof window.__powerrp_audioScene === "function"),
    "the audio mirror test seam is present (web/main.js)");

  const settle = () => new Promise((r) => setTimeout(r, 600));
  const scene = () => page.evaluate(() => {
    const s = window.__powerrp_audioScene();
    return {
      modules: Object.fromEntries(Object.entries(s.modules).map(([id, m]) => [id, m.module])),
      wires: s.connections.map((c) => `${c.sourceId}.${c.sourcePort}->${c.targetId}.${c.targetPort}`),
    };
  });
  const audioStatus = () => page.evaluate(() => window.__powerrp_audioState());
  const addNode = (type, x, y) => page.evaluate((type, x, y) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, x, y });
    return app.selection;
  }, type, x, y);
  const wire = (src, sp, dst, dp) => page.evaluate((src, sp, dst, dp) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", dst, "inputs", dp], { item: src, port: sp }]]);
    app.commitPreview();
  }, src, sp, dst, dp);

  // ── NOTHING AUDIO ⇒ NOTHING MIRRORED, AND NO CONTEXT ──────────────────────
  // A deck with no audio widgets is the overwhelmingly common case and it must not
  // construct an AudioContext at all — Chrome logs a warning for every suspended one,
  // and an unused context is a real resource on a page that never asked for sound.
  ok(Object.keys((await scene()).modules).length === 0, "an empty deck mirrors NO modules");
  ok((await audioStatus()).status === "idle", "and the mirror reports `idle`, so the badge stays absent");

  // ── BUILD A PATCH THROUGH THE REAL EDITOR ─────────────────────────────────
  const noise = await addNode("audio_noise", 100, 120);
  const filter = await addNode("audio_filter", 340, 120);
  const meter = await addNode("audio_meter", 580, 120);
  const spectrum = await addNode("audio_spectrum", 760, 120);
  const out = await addNode("audio_output", 1000, 120);
  await settle();

  const built = await scene();
  ok(Object.keys(built.modules).length === 5, `all five modules reached the engine (${JSON.stringify(built.modules)})`);
  ok(built.modules[noise] === "noise" && built.modules[out] === "output",
    "and each carries the ENGINE module type its plugin declares, not its widget type");

  const status = await audioStatus();
  ok(status.status === "blocked", `with a patch present the mirror is BLOCKED on the autoplay gate (got ${status.status})`);
  ok(status.moduleCount === 5, `and it knows how many modules it is holding (${status.moduleCount})`);

  // ── AND IT ASKS NOBODY'S PERMISSION (R7-3) ────────────────────────────────
  // This probe used to assert the opposite three lines down: that a button reading
  // "audio off — click to enable" was rendered and visible. The user overruled that
  // control outright ("Never make me ask that again. Get rid of that stupid ass
  // button."), so the assertion is inverted rather than deleted — a prompt that
  // comes back must turn something red. The engine is still reachable: the mirror
  // harvests the next real pointerdown/keydown instead (proved end to end by
  // tests/audio_frame_seam_probe.js, which uses a genuine click).
  const prompt = await page.evaluate(() => {
    const b = document.querySelector(".nf-audio-badge");
    return b ? b.textContent.trim() : null;
  });
  ok(prompt === null, `NO permission prompt is rendered for a merely-blocked context (got ${JSON.stringify(prompt)})`);

  // ── WIRES ─────────────────────────────────────────────────────────────────
  await wire(noise, "out", filter, "in");
  await wire(filter, "out", meter, "in");
  await wire(meter, "out", spectrum, "in");
  await wire(spectrum, "out", out, "in");
  await settle();
  const wired = await scene();
  ok(wired.wires.length === 4, `every connection reached the engine (${JSON.stringify(wired.wires)})`);
  ok(wired.wires.includes(`${noise}.out->${filter}.in`), "the noise→filter wire specifically");

  // ── A KNOB EDIT MUST NOT REWIRE ANYTHING ──────────────────────────────────
  // The property the whole diff exists for: editing while it plays must not tear the
  // patch down. A mirror that rebuilt would show the same wires here, so the check
  // that matters is that the module IDENTITIES survive — a rebuilt module is a new
  // engine node, and a rebuild storm is what makes a patch stutter permanently.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "audioFrequency"], 2400]]);
    app.commitPreview();
  }, filter);
  await settle();
  const afterKnob = await scene();
  ok(JSON.stringify(afterKnob.modules) === JSON.stringify(wired.modules),
    "turning a knob left every module in place — no rebuild");
  ok(afterKnob.wires.length === 4, "and left every wire connected");

  // ── MOVING A NODE MUST NOT TOUCH THE ENGINE AT ALL ────────────────────────
  // The reason a patch can keep playing while it is edited: the derivation runs on
  // every pointermove of a drag, and geometry is not part of the audio scene.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "x"], 500], [["items", id, "y"], 400]]);
    app.commitPreview();
  }, noise);
  await settle();
  const afterMove = await scene();
  ok(JSON.stringify(afterMove) === JSON.stringify(afterKnob),
    "moving a node changed NOTHING in the engine — geometry is not audio");

  // ── DELETE (active:false) REMOVES THE MODULE, SO SILENCE FOLLOWS THE PICTURE ─
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.deleteSelection();
  }, noise);
  await settle();
  const afterDelete = await scene();
  ok(!(noise in afterDelete.modules), "deleting a widget removed its module from the engine");
  ok(!afterDelete.wires.some((w) => w.startsWith(`${noise}.`)),
    "and cut its wires — a module that kept playing after its widget vanished would be a sound with no source");

  // ── UNDO PUTS IT BACK ─────────────────────────────────────────────────────
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  const afterUndo = await scene();
  ok(noise in afterUndo.modules, "undo restored the module");
  ok(afterUndo.wires.includes(`${noise}.out->${filter}.in`), "and its wire");

  // ── THE ANALYSIS DISPLAY REACHES THE DISPLAY LIST, AND ONLY WHEN ASKED ────
  //
  // THIS CHECK USED TO COUNT DOM CANVASES (`.nf-audio-overlay`), and R7-5 deleted
  // the design it was pinning. The overlay drew the waterfall in SCREEN space on a
  // <canvas> whose PIXELS were the history, which is why the picture died on every
  // zoom; the display is now emitted by the node's own emit() from a ring buffer of
  // magnitude columns. The old assertion is not merely obsolete — it would now be
  // satisfied only by REGRESSING, so it is restated positively rather than deleted.
  //
  // Deleting it was the tempting move and the wrong one: it is the only browser-side
  // coverage of the feature, and "no canvases" alone is a vacuous check that a blank
  // display would also pass.
  // TWO THINGS THIS PROBE MEASURED THAT ARE WORTH KNOWING BEFORE READING THE
  // ASSERTIONS, because the first draft of them was wrong about both:
  //   1. THE RINGS ARE ALREADY FILLING, even though the context is BLOCKED. The
  //      engine's analyser poll runs on rAF from the moment a module is added, and
  //      a suspended context's `getByteFrequencyData` returns zeros — so an
  //      analysis node accumulates SILENT columns before any sound exists. That is
  //      correct (a silent spectrogram is what silence looks like) and it means
  //      "the ring is empty" is not a state this probe can observe.
  //   2. A METER'S RING IS CAPACITY 1 BY DESIGN. It draws one bar from the newest
  //      reading and has no time axis, so ANALYSIS_HISTORY_COLUMNS declares depth
  //      1 — pushing 24 columns leaves 1, which is the ring working, not failing.
  // The depths are therefore READ from the module that declares them rather than
  // written here; a hardcoded 128 would be a two-element mirror of exactly the kind
  // this round keeps finding.
  const analysisIr = await page.evaluate(async (registryUrl, displayUrl) => {
    const app = window.__powerrp_app;
    const { cameraFrameIR, evaluatedStateAt } = await import("/cameraFrame.js");
    const reg = await import(registryUrl);
    const { ANALYSIS_HISTORY_COLUMNS } = await import(displayUrl);
    const state = evaluatedStateAt(app.doc, app.slideIndex, 1, app.registry);
    const frame = (liveAnalysis) => cameraFrameIR(state, app.doc.meta, app.registry, { project: app.projectName(), liveAnalysis }).length;
    const analysisIds = Object.entries(state.items)
      .filter(([, it]) => app.registry.get(it.type)?.audioSpec?.overlay)
      .map(([id, it]) => [id, app.registry.get(it.type).audioSpec.overlay]);
    // FEED THE RINGS the way the engine's subscription does. Synthetic columns,
    // because headless Chrome has no output device and this probe does not assert
    // on sound — what is proven is the PATH: registry -> pre-pass -> emit() -> IR.
    // Enough frames to fill the deepest ring, so the counts below are the declared
    // capacities rather than however far the rAF poll happened to get.
    const deepest = Math.max(...Object.values(ANALYSIS_HISTORY_COLUMNS));
    for (const [id, kind] of analysisIds) {
      for (let f = 0; f < deepest; f++) {
        reg.pushAnalysisFrame(id, kind, kind === "meter" ? Float32Array.of(0.6) : Float32Array.from({ length: 32 }, (_, b) => (b % 5) / 5));
      }
    }
    const live = frame(true);
    const headless = frame(false);
    const liveAgain = frame(true);
    const columns = Object.fromEntries(analysisIds.map(([id, kind]) => [kind, reg.analysisColumnCount(id)]));
    const declared = Object.fromEntries(analysisIds.map(([, kind]) => [kind, ANALYSIS_HISTORY_COLUMNS[kind]]));
    return { kinds: analysisIds.map(([, k]) => k).sort(), headless, live, liveAgain, columns, declared };
  }, `/@fs${resolve(repo, "src/demo_apps/PowerRP/render_gpu/gpu/live_analysis_registry.js")}`,
     `/@fs${resolve(repo, "src/demo_apps/PowerRP/core/analysis_display.js")}`);

  ok(analysisIr.kinds.join(",") === "meter,spectrum",
    `exactly two nodes declare a live display, the meter and the spectrum (got ${JSON.stringify(analysisIr.kinds)})`);
  ok(analysisIr.live > analysisIr.headless,
    `the display reaches the DISPLAY LIST (${analysisIr.live} ops vs ${analysisIr.headless} static) — in the scene's own z-order, riding each node's world transform, which a screen-space canvas structurally could not do`);
  ok(analysisIr.headless < analysisIr.live && analysisIr.liveAgain > analysisIr.headless,
    `and a surface that does NOT opt in gets the static form even while audio is live (${analysisIr.headless} ops, between two live frames of ${analysisIr.live}/${analysisIr.liveAgain}) — the Δt = 0 law every exporter and cli/render.js depends on`);
  ok(JSON.stringify(analysisIr.columns) === JSON.stringify(analysisIr.declared),
    `each ring holds exactly its DECLARED depth (${JSON.stringify(analysisIr.columns)}) — rendering neither consumes nor resets it, which is why a zoom cannot erase the waterfall`);

  // AND THE DOM OVERLAY MUST NOT COME BACK. The class is gone from the app; if it
  // reappears, someone has rebuilt the layer whose pixels-as-history was the whole
  // defect (R7-5's four symptoms).
  ok(await page.evaluate(() => document.querySelectorAll(".nf-audio-overlay").length === 0),
    "no screen-space analysis canvas exists — the display is part of the scene, not a layer above it");

  // ── MULTIPLE OUTPUTS COEXIST (ADDENDUM 10) ────────────────────────────────
  const out2 = await addNode("audio_output", 1000, 400);
  await wire(spectrum, "out", out2, "in");
  await settle();
  const twoOuts = await scene();
  ok(Object.values(twoOuts.modules).filter((m) => m === "output").length === 2,
    "TWO output modules coexist in the engine — the user ruled they sum, never conflict");

  // ── A DEMO PATCH GOES THROUGH THE SAME PATH ───────────────────────────────
  await page.evaluate(() => window.__powerrp_app.insertDemoPatch("whoosh"));
  await settle();
  const withPatch = await scene();
  ok(Object.keys(withPatch.modules).length >= Object.keys(twoOuts.modules).length + 6,
    `inserting a demo patch added its modules to the engine (${Object.keys(withPatch.modules).length} total)`);

  ok(liveErrors.length === 0, `no unexpected console errors during the session (${JSON.stringify(liveErrors.slice(0, 4))})`);
} catch (e) {
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\naudio_mirror_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
