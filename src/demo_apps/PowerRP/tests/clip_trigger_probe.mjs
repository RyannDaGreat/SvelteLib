/**
 * DOES THE FIRE BUTTON ACTUALLY PLAY THE CLIP — in the real app, end to end.
 * Run: node src/demo_apps/PowerRP/tests/clip_trigger_probe.mjs
 *
 * ── WHY THIS EXISTS (user, 2026-08-08) ─────────────────────────────────────
 * "why trigger do nothing i hear no sound … pressing fire does nothing" — asked
 * twice, because the first answer was a diagnosis rather than a fix.
 *
 * `tests/surge_audio_probe.mjs` proves the AUDIO CHAINS are audible by injecting
 * notes directly into the engine. That deliberately bypasses the question the user
 * is actually asking, which is about the LIVE PATH: a pointer goes down on a Button
 * widget, and somewhere at the other end `engine.noteOn` is called. Between those
 * two points sit the canvas gesture, `fireLiveTrigger`, `clipTriggerTargets`, the
 * live-start scratch map, `mirrorAudioFrame`, `syncClipNotes`, `soundingClips`,
 * `midiRoutes` and `playClipNote` — NINE seams, none of which the audio probe
 * touches and any one of which leaves the button silent.
 *
 * So this drives the REAL app in a REAL browser and asserts on what reached the
 * engine. It watches `engine.noteOn` rather than the speaker, because a headless
 * page has no output device — the engine call IS the boundary between "PowerRP did
 * its job" and "the synth makes a sound", and the synth's half is what the audio
 * probe measures. Between them the chain is covered end to end.
 */

import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();

const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (isWebGpuAbsenceNoise(t) || /\/api\/projects|500 \(Internal Server Error\)/.test(t)) return;
    // Surge's big binaries are not served here (no interception): its LOAD failure is
    // expected and irrelevant — this probe asserts on engine CALLS, not on sound.
    if (/Surge|WebSurge|surge-engine|surge-data/i.test(t)) return;
    pageErrors.push(`console.error: ${t}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });
  await sleep(600);

  // ── THE PATCH THE USER DREW: fire → clip → surge → out ───────────────────
  const ids = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const add = (type, x, y, extra = {}) => {
      app.addItem({ ...app.registry.get(type).defaults, x, y, ...extra });
      return app.selection;
    };
    const wire = (src, sp, dst, dp) => {
      app.setPreview([[["items", dst, "inputs", dp], { item: src, port: sp }]]);
      app.commitPreview();
    };
    const fire = add("node_button", 60, 80);
    // Three notes, so "did anything play" and "did the RIGHT thing play" differ.
    const clip = add("node_midi_clip", 300, 80, { tempo: 120, clip: [[0, 4, 60, 100], [0, 4, 64, 100], [0, 4, 67, 100]] });
    const surge = add("audio_surge", 620, 80);
    const out = add("audio_output", 900, 80);
    wire(fire, "out", clip, "trigger");
    wire(clip, "midi", surge, "notes");
    wire(surge, "out", out, "in");
    app.selection = null;
    return { fire, clip, surge, out };
  });
  await sleep(400);
  ok(!!ids.clip && !!ids.surge, "the patch builds: button → clip → surge → out");

  // ── AUDIO ON (harvested from an ordinary click, never asked for) ─────────
  const empty = await page.evaluate(() => {
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + r.width - 30, y: r.top + r.height - 30 };
  });
  await page.mouse.click(empty.x, empty.y);
  // WAIT FOR "running", NOT merely "not blocked": `starting` is a real state (the
  // context is resuming and the worklets are loading), and instrumenting the engine
  // during it finds no engine at all.
  await page.waitForFunction(() => window.__powerrp_audioState().status === "running", { timeout: 40000 }).catch(() => {});
  const status = await page.evaluate(() => window.__powerrp_audioState());
  ok(status.status === "running", `audio is running (${status.status}${status.reason ? ": " + status.reason : ""})`);

  // ── INSTRUMENT engine.noteOn ────────────────────────────────────────────
  // The boundary that matters: PowerRP's job ends at this call, and
  // tests/surge_audio_probe.mjs measures what the synth does with it.
  await page.evaluate(() => {
    // THE APP'S OWN engine, via web/main.js's accessor. Importing the mirror here
    // instead would get a SECOND module instance whose engine is null (measured).
    const eng = window.__powerrp_audioEngine();
    if (!eng) throw new Error("no audio engine after status went running");
    window.__noteLog = [];
    const realOn = eng.noteOn.bind(eng);
    const realOff = eng.noteOff.bind(eng);
    eng.noteOn = (id, note, freq, t) => { window.__noteLog.push({ op: "on", id, note }); return realOn(id, note, freq, t); };
    eng.noteOff = (id, note, t) => { window.__noteLog.push({ op: "off", id, note }); return realOff(id, note, t); };
  });

  // ── BEFORE THE PRESS: nothing should be playing ─────────────────────────
  await sleep(500);
  const before = await page.evaluate(() => window.__noteLog.length);
  ok(before === 0, `a live-triggered clip is SILENT until pressed (${before} calls before the press)`);

  // ── THE PRESS ───────────────────────────────────────────────────────────
  const onFire = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const s = app.canvasActions.worldToScreen(n.state.x + n.state.w / 2, n.state.y + n.state.h / 2);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, ids.fire);
  await page.mouse.move(onFire.x, onFire.y);
  await page.mouse.down();
  await sleep(120);
  await page.mouse.up();
  await sleep(900);

  const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.__noteLog)));
  const ons = after.filter((e) => e.op === "on");
  ok(ons.length > 0, `PRESSING FIRE PLAYS THE CLIP — ${ons.length} noteOn call(s) reached the engine`);
  ok(ons.every((e) => e.id === ids.surge), `…and they reached the SURGE node (${[...new Set(ons.map((e) => e.id))].join(", ")})`);
  ok(new Set(ons.map((e) => e.note)).size === 3 && [60, 64, 67].every((n) => ons.some((e) => e.note === n)),
    `…playing the three notes the clip holds (${[...new Set(ons.map((e) => e.note))].sort((a, b) => a - b).join(", ")})`);

  // ── THE NOTES END WHEN THE CLIP DOES ────────────────────────────────────
  // 4 beats at 120 BPM = 2 s. A scheduler that only ever turns notes ON would pass
  // every check above and leave a drone sounding forever.
  await sleep(2200);
  const offs = (await page.evaluate(() => JSON.parse(JSON.stringify(window.__noteLog)))).filter((e) => e.op === "off");
  ok(offs.length >= 3, `the notes are RELEASED when the clip ends (${offs.length} noteOff calls) — not a drone`);

  ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(" | ")})`);
} catch (e) {
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "  ok  " : "  FAIL"} ${label}`);
if (errors.length) { console.log(`\nFAILURES (${errors.length}):`); for (const e of errors) console.log(`  ${e}`); }
console.log(`\nclip_trigger_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
process.exit(errors.length ? 1 : 0);
