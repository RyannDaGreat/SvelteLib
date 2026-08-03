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

  // THE BADGE IS THE HONEST SURFACE, and it must actually be in the DOM — a status
  // field nothing renders is the same silence it exists to replace.
  const badge = await page.evaluate(() => {
    const b = document.querySelector(".nf-audio-badge");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent.trim(), tag: b.tagName, visible: r.width > 0 && r.height > 0 };
  });
  ok(badge && badge.visible, `the autoplay badge is rendered and visible (${JSON.stringify(badge)})`);
  ok(badge?.tag === "BUTTON", "and it is a real BUTTON — the browser requires a genuine gesture, and it must be keyboard-reachable");
  ok(/click to enable/i.test(badge?.text ?? ""), `it says what to do (${JSON.stringify(badge?.text)})`);

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

  // ── THE ANALYSIS OVERLAYS MOUNT ON EXACTLY THE NODES THAT DECLARE THEM ────
  // The live meter/spectrogram layer. Its DATA cannot be checked without sound, but
  // its PRESENCE can: one canvas per analysis node and none for anything else.
  const overlays = await page.evaluate(() => document.querySelectorAll(".nf-audio-overlay").length);
  ok(overlays === 2, `exactly two live-analysis canvases, for the meter and the spectrum (got ${overlays})`);
  ok(await page.evaluate(() => [...document.querySelectorAll(".nf-audio-overlay")].every((c) => getComputedStyle(c).pointerEvents === "none")),
    "and they are pointer-events:none — an analysis node stays grabbable and wirable THROUGH its own live picture");

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
