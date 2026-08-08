/**
 * DOES SURGE ACTUALLY MAKE A SOUND — the two chains, measured in dBFS.
 * Run: node src/demo_apps/PowerRP/tests/surge_audio_probe.mjs
 *
 * ── THE RULING THIS EXISTS FOR (user, 2026-08-07, and again 2026-08-08) ────
 * "don't theorize about sound. we acrually need to HEAR it." … and, when told that
 * nobody had yet measured whether the Surge chains were audible: **"THESE ARE
 * NECESSARY TESTS."**
 *
 * `tests/renderPatchAudio.mjs` is the LISTEN half and makes no assertions on
 * purpose. THIS is the ASSERTING half: it REDs the gate when a chain goes silent,
 * which is what stops the regression. Neither replaces the other — that file's own
 * header is explicit that "every one of those numbers can be perfectly healthy
 * while the patch sounds wrong".
 *
 * ── WHAT IS PROVEN ─────────────────────────────────────────────────────────
 *   1. `keys → surge → out`            — the pre-wired rig, the off-the-shelf case.
 *   2. `clip → surge → out`            — a MIDI clip really does drive the synth.
 *   3. `clip → surge → reverb → out`   — and the reverb audibly changes it.
 * Each is asserted LOUD (RMS above a silence floor) and UNCLIPPED.
 *
 * ── THE TRAP THIS IS BUILT AROUND, AND IT IS ALREADY DOCUMENTED ────────────
 * `renderPatchAudio.mjs` marks a keyboard-driven patch **`UNPLAYED`**: "nobody is
 * at the keys offline, so gated voices sit at zero". The Surge rig IS
 * keyboard-driven, so a naive offline render of it is silent AND THAT SILENCE
 * MEANS NOTHING. Its header records the cost of misreading exactly this once
 * already — `vcv-fm-pad` at −67.7 dBFS was read as a level bug when it was leakage
 * past four closed VCAs.
 *
 * **SO THIS PROBE INJECTS NOTE-ONS** rather than hoping something plays. That is the
 * same seam the live scheduler uses (`engine.noteOn`), which is why the scheduler
 * and this test were built as one piece of work: each is the other's proof.
 *
 * ── A MEASURED LIMITATION, STATED SO A FUTURE READER DOES NOT RE-DISCOVER IT ─
 * `synth/modules_surge.js noteOn(slot, frequency, _time)` **IGNORES its time
 * argument** — it posts a message to the worklet immediately, because a worklet
 * message has no scheduling slot. `engine.noteOn`'s `time` parameter therefore does
 * nothing for Surge specifically. CONSEQUENCE: a timed phrase cannot be rendered
 * offline; every injected note lands at the start of the render. So these chains are
 * measured as SUSTAINED notes, which answers "is this chain audible" completely and
 * does not answer "is the rhythm right" at all. The rhythm is covered where it can
 * be — `tests/midi_clip_test.js` pins the event stream and its ordering in bare node.
 *
 * ── THE 35 MB DOWNLOAD ─────────────────────────────────────────────────────
 * Surge's engine wasm and patch archive are fetched from an upstream host at
 * runtime (`synth/surge_remote.js` states that ruling and its three costs). Rather
 * than download them per run, this CACHES them once into a gitignored fixture
 * directory and serves them to the page by request interception. First run pays;
 * every run after is local.
 *
 * IF THEY CANNOT BE OBTAINED THIS FAILS LOUDLY (exit 1) rather than skipping,
 * because a silently skipped audio test reads as coverage and is worse than no test
 * at all. `POWERRP_SURGE_OFFLINE=skip` downgrades that to a loud SKIPPED banner and
 * exit 0, for a machine that genuinely has no network — the skip is never quiet.
 */

import { createServer } from "vite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";
import { SURGE_DATA_BIN_URL, SURGE_ENGINE_WASM_URL, SURGE_REMOTE_BASE } from "../synth/surge_remote.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const webRoot = resolve(APP, "web");
const CACHE_DIR = join(HERE, "fixtures", "surge");

/** Below this RMS a chain is SILENT. −60 dBFS, the same floor
 *  tests/patch_sound_probe.mjs uses and far above any real noise floor. */
const SILENCE_RMS = 1e-3;
/** Above this peak the render clipped. */
const CLIP_PEAK = 1.05;
/**
 * How different a REVERBED render must be from the dry one, after both are
 * normalised to the same RMS, for the reverb to count as audibly doing something.
 *
 * NORMALISED FIRST, and that is the whole point of the measurement: a reverb also
 * changes the LEVEL, so a raw difference would be large even for a bypassed reverb
 * with a gain trim on it. Comparing at equal RMS asks the sharper question — "is
 * this a different SOUND", not "is it a different volume". 0.15 is well above the
 * ~0 a bypassed effect scores and well below the ~1 of two unrelated signals.
 */
const REVERB_MIN_DIFFERENCE = 0.15;

const RENDER_SECONDS = 2.0;
const RATE = 48000;

const log = (...a) => console.log(...a);
const failures = [];
const ok = (cond, label) => { log(`  ${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures.push(label); };

/**
 * Command. Make sure the two big Surge binaries are on disk, downloading them once.
 * Returns `{ok, reason, files}`.
 */
async function ensureSurgeFixtures() {
  const wanted = [
    { url: SURGE_ENGINE_WASM_URL, name: "surge-engine.wasm" },
    { url: SURGE_DATA_BIN_URL, name: "surge-data.bin" },
  ];
  await mkdir(CACHE_DIR, { recursive: true });
  const files = new Map();
  for (const w of wanted) {
    const path = join(CACHE_DIR, w.name);
    const have = await stat(path).then((s) => s.size > 0).catch(() => false);
    if (!have) {
      log(`  … caching ${w.name} from ${w.url} (first run only)`);
      let res;
      try {
        res = await fetch(w.url);
      } catch (e) {
        return { ok: false, reason: `could not reach ${w.url}: ${e.message}` };
      }
      if (!res.ok) return { ok: false, reason: `${w.url} answered HTTP ${res.status}` };
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
    }
    const buf = await readFile(path);
    files.set(w.url, buf);
    log(`  … ${w.name}: ${(buf.length / 1e6).toFixed(1)} MB cached`);
  }
  return { ok: true, files };
}

const fixtures = await ensureSurgeFixtures();
if (!fixtures.ok) {
  const skip = process.env.POWERRP_SURGE_OFFLINE === "skip";
  log("");
  log("========================================================================");
  log("  SURGE AUDIO PROBE " + (skip ? "SKIPPED" : "FAILED") + " — the engine binaries could not be obtained.");
  log(`  REASON: ${fixtures.reason}`);
  log("  Nothing about the audio chains was measured. This is NOT a pass.");
  if (!skip) log("  Set POWERRP_SURGE_OFFLINE=skip to downgrade this to a warning.");
  log("========================================================================");
  process.exit(skip ? 0 : 1);
}

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  // The surge module reports a load failure via console.error and nothing else, so
  // a probe that only watched `pageerror` would report "not ready" with no reason.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // WebGPU absence is host noise every probe filters — this page mounts the whole
    // editor, and VideoV7 reports its 2D fallback on a machine with no adapter.
    if (isWebGpuAbsenceNoise(m.text())) return;
    pageErrors.push(`console.error: ${m.text()}`);
  });

  // ── SERVE THE CACHED BINARIES ────────────────────────────────────────────
  // The app fetches absolute upstream URLs; intercepting them keeps the module
  // under test completely unmodified — it does not know it is being tested, which
  // is the property that makes this measure the real path.
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const hit = fixtures.files.get(req.url());
    // `access-control-allow-origin` IS REQUIRED, not decoration. These are
    // CROSS-ORIGIN fetches (the page is 127.0.0.1, the URL is github.io), and the
    // real host answers `*` — synth/surge_remote.js measured that and depends on it.
    // A fulfilled response without the header is blocked by CORS exactly as a
    // hostile one would be, which surfaced here as "surge never became ready".
    if (hit) {
      return req.respond({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "access-control-allow-origin": "*" },
        body: Buffer.from(hit),
      });
    }
    if (req.url().startsWith(SURGE_REMOTE_BASE)) {
      // Anything else upstream (the GUI wasm) is not needed for an AUDIO render, and
      // letting it through would download 19 MB per run for nothing.
      return req.abort();
    }
    return req.continue();
  });

  await page.goto(url, { waitUntil: "networkidle0" });

  const report = await page.evaluate(async ({ app, seconds, rate }) => {
    // `/@fs/<abs>` is Vite's door to a file outside the app root — see
    // tests/patch_sound_probe.mjs, which measured the two obvious alternatives failing.
    const [{ createRegistry }, { registerPlugins }, { readAudioScene }, { createEngine }] =
      await Promise.all([
        import(`/@fs${app}/core/registry.js`),
        import(`/@fs${app}/plugins/index.js`),
        import(`/@fs${app}/core/audio_mirror_diff.js`),
        import(`/@fs${app}/synth/engine.js`),
      ]);
    const registry = createRegistry();
    registerPlugins(registry);

    /** Command. Build a scene, connect it, inject notes, render, and measure. */
    async function render(items, notes) {
      const scene = readAudioScene(items, registry);
      const ctx = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
      const engine = createEngine({ audioContext: ctx });
      await engine.init();
      for (const [id, mod] of Object.entries(scene.modules)) engine.addModule(mod.module, id, mod.knobs);
      // `await` IS LOAD-BEARING: every output goes through a guard gain that connect()
      // ramps to 0 and restores on a WALL-clock timeout. An OfflineAudioContext does not
      // wait for timers, so an unawaited connect parks every guard at zero and the whole
      // render is -inf dBFS (tests/patch_sound_probe.mjs measured exactly this).
      for (const c of scene.connections) {
        if (c.method) continue;
        await engine.connect(c.sourceId, c.sourcePort, c.targetId, c.targetPort);
      }
      // ── WAIT FOR SURGE TO ACTUALLY EXIST ─────────────────────────────────
      // An OfflineAudioContext renders as fast as it can and waits for NOTHING, so
      // firing startRendering() while the 5.4 MB wasm is still compiling produced
      // EXACTLY -inf dBFS on all three chains — the signature of a harness fault,
      // not three bugs. `whenReady()` is the module's own signal (added for this);
      // a timeout guard turns a hung load into a NAMED failure rather than a hang.
      // Only when the chain HAS a Surge in it; the reverb A/B deliberately does not.
      if (scene.modules.surge) {
        const control = engine.moduleControl("surge");
        if (!control?.whenReady) return { error: "the surge module exposes no whenReady() — cannot render deterministically" };
        const ready = await Promise.race([
          control.whenReady(),
          new Promise((r) => setTimeout(() => r("timeout"), 60000)),
        ]);
        if (ready !== true) return { error: `surge never became ready (${ready === "timeout" ? "timed out after 60 s" : "load failed"})` };
      }

      // ── THE INJECTION ────────────────────────────────────────────────────
      // Nobody is at the keys offline. Surge's noteOn posts to the worklet
      // immediately (its `_time` is unused), so these all land at render start and
      // sustain — see the file header.
      const built = new Set(engine.inspect().modules.map((m) => m.id));
      for (const n of notes) {
        if (!built.has(n.id)) return { error: `module ${n.id} was never built` };
        engine.noteOn(n.id, n.note, n.frequency);
      }
      // Let the worklet's message queue drain before the render begins: a message
      // posted in the same task as startRendering() may not be handled first.
      await new Promise((r) => setTimeout(r, 300));
      const buffer = await ctx.startRendering();
      const left = buffer.getChannelData(0);
      let peak = 0, sumsq = 0, bad = 0;
      for (let i = 0; i < left.length; i++) {
        const v = left[i];
        if (!Number.isFinite(v)) { bad++; continue; }
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sumsq += v * v;
      }
      return { peak, rms: Math.sqrt(sumsq / left.length), bad, samples: Array.from(left.slice(0, rate)) };
    }

    const D = (t) => ({ ...registry.get(t).defaults });
    const out = {};

    // ── 1. keys → surge → out (the pre-wired rig) ────────────────────────
    {
      const items = {
        keys: D("node_keyboard"),
        surge: D("audio_surge"),
        out: { ...D("audio_output"), inputs: { in: { item: "surge", port: "out" } } },
      };
      items.surge.inputs = { gate: { item: "keys", port: "gate" }, pitch: { item: "keys", port: "pitch" } };
      out.keys = await render(items, [{ id: "surge", note: 60, frequency: 261.63 }]);
    }

    // ── 2 & 3. clip → surge → [reverb] → out ────────────────────────────
    // The SAME clip and the SAME injected notes both times, so the only difference
    // between the two renders is the reverb.
    const clipNotes = [{ id: "surge", note: 60, frequency: 261.63 }, { id: "surge", note: 67, frequency: 392.0 }];
    {
      const items = {
        clip: { ...D("node_midi_clip"), clip: [[0, 2, 60, 100], [0, 2, 67, 100]] },
        surge: D("audio_surge"),
        out: { ...D("audio_output"), inputs: { in: { item: "surge", port: "out" } } },
      };
      items.surge.inputs = { notes: { item: "clip", port: "midi" } };
      out.clipDry = await render(items, clipNotes);
    }
    {
      const items = {
        clip: { ...D("node_midi_clip"), clip: [[0, 2, 60, 100], [0, 2, 67, 100]] },
        surge: D("audio_surge"),
        verb: { ...D("audio_reverb"), inputs: { in: { item: "surge", port: "out" } } },
        out: { ...D("audio_output"), inputs: { in: { item: "verb", port: "out" } } },
      };
      items.surge.inputs = { notes: { item: "clip", port: "midi" } };
      out.clipWet = await render(items, clipNotes);
    }

    // ── IS SURGE EVEN REPRODUCIBLE BETWEEN TWO RENDERS? ──────────────────────
    // Asked rather than assumed, because the answer decides whether a Surge-based
    // A/B can mean anything at all. Rendering the SAME chain twice and comparing is
    // the only honest way to find out.
    {
      const items = {
        clip: { ...D("node_midi_clip"), clip: [[0, 2, 60, 100]] },
        surge: D("audio_surge"),
        out: { ...D("audio_output"), inputs: { in: { item: "surge", port: "out" } } },
      };
      items.surge.inputs = { notes: { item: "clip", port: "midi" } };
      out.surgeRepeatA = await render(items, [{ id: "surge", note: 60, frequency: 261.63 }]);
      out.surgeRepeatB = await render(items, [{ id: "surge", note: 60, frequency: 261.63 }]);
    }

    // ── THE REVERB A/B, ON A DETERMINISTIC SOURCE ───────────────────────────
    // A plain oscillator, NOT Surge — see the REVERB section below for the measured
    // reason. Same graph both times except for the reverb in the middle.
    {
      const dry = {
        osc: { ...D("audio_oscillator") },
        out: { ...D("audio_output"), inputs: { in: { item: "osc", port: "out" } } },
      };
      out.oscDry = await render(dry, []);
      const wet = {
        osc: { ...D("audio_oscillator") },
        // MIXED FULLY WET, on purpose. The default is `wet 0.4 / dry 0.8`, i.e.
        // mostly the original signal — a real setting, and a subtle one: it scored
        // 0.145 against a 0.15 threshold. Loosening the threshold to fit that would
        // be fitting the test to its result. Asking the reverb to be AUDIBLE with
        // the dry path down is the question the test actually means, and it leaves
        // the threshold meaning something.
        verb: { ...D("audio_reverb"), audioWet: 1, audioDry: 0, inputs: { in: { item: "osc", port: "out" } } },
        out: { ...D("audio_output"), inputs: { in: { item: "verb", port: "out" } } },
      };
      out.oscWet = await render(wet, []);
    }
    return out;
  }, { app: APP, seconds: RENDER_SECONDS, rate: RATE });

  const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");

  log("");
  log("  CHAIN                             peak dBFS   rms dBFS");
  for (const [name, r] of Object.entries(report)) {
    if (r?.error) { log(`  ${name.padEnd(30)}  ERROR: ${r.error}`); continue; }
    log(`  ${name.padEnd(30)}  ${db(r.peak).padStart(8)}   ${db(r.rms).padStart(8)}`);
  }
  log("");

  for (const [name, label] of [["keys", "keys → surge → out"], ["clipDry", "clip → surge → out"], ["clipWet", "clip → surge → reverb → out"]]) {
    const r = report[name];
    ok(r && !r.error, `${label}: rendered`);
    if (!r || r.error) continue;
    ok(r.bad === 0, `${label}: no NaN/Inf samples (${r.bad})`);
    ok(r.rms > SILENCE_RMS, `${label}: AUDIBLE — rms ${db(r.rms)} dBFS, above the ${db(SILENCE_RMS)} dBFS silence floor`);
    ok(r.peak <= CLIP_PEAK, `${label}: not clipped (peak ${db(r.peak)} dBFS)`);
  }

  // ── THE REVERB IS AUDIBLY DOING SOMETHING ───────────────────────────────
  //
  // MEASURED AGAINST A PLAIN OSCILLATOR, NOT AGAINST SURGE, AND THE REASON IS A
  // FAILED TEST RATHER THAN A PREFERENCE. The first version of this A/B rendered
  // `clip → surge → out` against `clip → surge → reverb → out` and scored 0.92,
  // comfortably over the threshold — and then BYPASSING THE REVERB ENTIRELY STILL
  // SCORED 1.02 AND STILL PASSED. What it was measuring was SURGE'S OWN RUN-TO-RUN
  // NONDETERMINISM (free-running LFOs and an internal phase that does not reset),
  // not the reverb. A number that healthy while the thing under test is switched off
  // is exactly the trap renderPatchAudio.mjs's header warns about.
  //
  // `surgeRepeat` below pins that diagnosis rather than leaving it as a story: two
  // renders of the IDENTICAL Surge chain are compared, and they differ. The reverb
  // is therefore measured on a source that IS reproducible, where a bypass reds.
  const normDiff = (a, b) => {
    const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length) || 1e-12;
    const ra = rms(a), rb = rms(b);
    let d2 = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { const d = a[i] / ra - b[i] / rb; d2 += d * d; }
    return Math.sqrt(d2 / n) / Math.SQRT2;
  };

  if (report.surgeRepeatA?.samples && report.surgeRepeatB?.samples) {
    const repeat = normDiff(report.surgeRepeatA.samples, report.surgeRepeatB.samples);
    log(`  surge repeatability (two identical renders): ${repeat.toFixed(3)} — NONZERO means Surge is not bit-reproducible`);
    ok(repeat > REVERB_MIN_DIFFERENCE,
      `Surge is measurably NON-reproducible between renders (${repeat.toFixed(3)}), which is WHY the reverb A/B uses an oscillator`);
  }

  if (report.oscDry?.samples && report.oscWet?.samples) {
    ok(report.oscDry.rms > SILENCE_RMS, `oscillator → out is audible (rms ${db(report.oscDry.rms)} dBFS) — the A/B has a signal to compare`);
    const relative = normDiff(report.oscDry.samples, report.oscWet.samples);
    log(`  reverb difference on a DETERMINISTIC source: ${relative.toFixed(3)} (threshold ${REVERB_MIN_DIFFERENCE})`);
    ok(relative > REVERB_MIN_DIFFERENCE,
      `the reverb AUDIBLY changes the sound (normalised difference ${relative.toFixed(3)} > ${REVERB_MIN_DIFFERENCE})`);
  } else {
    ok(false, "the reverb comparison had two renders to compare");
  }

  ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(" | ")})`);
} catch (e) {
  failures.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) log(`  ${f}`);
}
log(`\nsurge_audio_probe: ${failures.length ? "FAILED" : "PASSED"}`);
process.exit(failures.length ? 1 : 0);
