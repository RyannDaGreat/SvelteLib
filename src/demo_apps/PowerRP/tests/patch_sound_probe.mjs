/**
 * PATCH SOUND — every demo patch is RENDERED and MEASURED, not listened to.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/patch_sound_probe.mjs
 *
 * ── THIS OVERTURNS A RECORDED RULING, AND THE REASON IT MAY ──────────────────
 * `tests/audio_mirror_probe.js`'s header says, in bold: *"IT DOES NOT ASSERT ON SOUND …
 * do not attempt audio-buffer assertions in probes"*, and gives three reasons — headless
 * Chrome has no output device, its AudioContext behaviour under autoplay policy varies by
 * flag set, and an assertion on sample values would be measuring the harness rather than
 * the app. **All three of those objections are about a REALTIME AudioContext, and an
 * OfflineAudioContext has none of them.** It renders into a buffer with no device, it is
 * not subject to autoplay policy because nothing is played, and it is deterministic:
 * `startRendering()` computes the same samples every time on every host. So the ruling
 * stands where it was aimed and does not reach here.
 *
 * The user asked for exactly this (2026-08-06): *"then launch a batch swarm to
 * implement/create those nodes, while validating + making sure the patches sound right
 * (are u able tot do that)"*. This is the honest answer to that question.
 *
 * ── WHAT IT CAN AND CANNOT TELL YOU. READ THIS BEFORE QUOTING A RESULT ──────
 * IT CAN catch the failures that actually happen to a patch library, all of which are
 * invisible to the structural tests and to a screenshot:
 *   - SILENCE. A patch that inserts perfectly and makes no sound is the single worst
 *     outcome for a feature whose purpose is to impress on first contact.
 *   - NaN / Infinity anywhere in the buffer — one bad recurrence poisons the whole mix
 *     and every downstream node, and nothing throws.
 *   - RUNAWAY FEEDBACK: a reverb or comb whose loop gain exceeds 1 grows without bound.
 *   - DC OFFSET, which wastes headroom and thumps on every gate.
 *   - CLIPPING, i.e. a patch whose levels were authored for a different gain staging.
 *   - A FILTER OR ENVELOPE THAT IS WRONG BY A POWER OF TWO — the exact failure R7-11
 *     names for the missing `qinv` (18 dB) and for hoisting the k-rate block (8x slow).
 *     Those show up in the spectral centroid and the RMS envelope, not in a wire check.
 *
 * IT CANNOT tell you whether a patch is GOOD. Nothing here is a judgement of timbre,
 * musicality or taste. It measures properties; ears do the rest. Do not report "the
 * patches sound right" on the strength of this file — report what it measured.
 *
 * ── TWO GATES THAT MAKE A RESULT MEAN SOMETHING ─────────────────────────────
 * 1. A PATCH CONTAINING A PLACEHOLDER IS NOT MEASURED AT ALL. `patchPlaceholders`
 *    (core/audio_stub_nodes.js) is the predicate, and this is the ONE consumer the whole
 *    placeholder design was gated for: a measured-good spectrum from a graph with a hole
 *    in it is a false negative waiting to be quoted as evidence that a port is fine.
 * 2. A PATCH DRIVEN BY THE TRANSPORT IS REPORTED UNMEASURED, NOT FAILED. The engine's
 *    scheduler (synth/engine.js `createScheduler`) drives `playStep` from a WALL clock
 *    looking ahead of `context.currentTime`; an OfflineAudioContext renders as fast as it
 *    can and its clock is not that clock, so a clock/sequencer patch produces its drone
 *    layers and none of its events. Calling that "silent" would be measuring the harness —
 *    precisely the mistake audio_mirror_probe warned about — so those patches are counted
 *    separately and named. Fixing it means an offline transport, which is real work and is
 *    not smuggled in here.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

/** How much of each patch to render. Long enough for a slow filter sweep to move and for
 *  a reverb tail to establish, short enough that 20+ patches finish in a coffee break. */
const RENDER_SECONDS = 4;
/** The rate every Axoloti port's arithmetic is derived at (see core/audio_specs_ax2.js),
 *  so rendering at anything else would measure a resampling artefact as a defect. */
const RENDER_RATE = 48000;
/** Below this RMS a patch is SILENT. -60 dBFS: quieter than any deliberate ambience bed
 *  and far above the -123 dBFS floor of the sine-table deviation AX-2 measured. */
const SILENCE_RMS = 1e-3;
/** Above this peak the render clipped. Slightly over unity because a mix summing to
 *  exactly 1.0 is not a defect — a signal half a dB into the rail is. */
const CLIP_PEAK = 1.06;
/** A DC offset larger than this wastes headroom and thumps on every gate. */
const MAX_DC = 0.02;

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const failures = [];
let measured = 0;

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !isWebGpuAbsenceNoise(m.text())) pageErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });

  const report = await page.evaluate(async ({ seconds, rate, app }) => {
    // `/@fs/<abs>` IS THE SPECIFIER, and the obvious ones do not work. Vite's root for
    // this app is `web/`, so a bare `/core/…` resolves under web/ and 404s, and `/../core/…`
    // escapes the root and is refused. `/@fs/` is Vite's documented door to a file outside
    // the root, and the app's own modules reach `core/` only because they are themselves
    // inside the graph and use relative paths. Measured both failures before this line.
    const [{ DEMO_PATCHES, buildPatchItems }, { patchPlaceholders }, { createRegistry }, { registerPlugins }, { readAudioScene }, { createEngine }] =
      await Promise.all([
        import(`/@fs${app}/core/audio_patches.js`),
        import(`/@fs${app}/core/audio_stub_nodes.js`),
        import(`/@fs${app}/core/registry.js`),
        import(`/@fs${app}/plugins/index.js`),
        import(`/@fs${app}/core/audio_mirror_diff.js`),
        import(`/@fs${app}/synth/engine.js`),
      ]);

    const registry = createRegistry();
    registerPlugins(registry);

    /**
     * Pure function. Magnitude spectrum of one real block, by naive DFT at the bin count
     * we need. A full FFT is not worth importing for a handful of summary statistics, and
     * a naive transform at 1024 bins over a 2048-sample window is milliseconds.
     */
    const spectrum = (samples, bins) => {
      const n = samples.length;
      const out = new Float64Array(bins);
      for (let k = 0; k < bins; k++) {
        let re = 0, im = 0;
        for (let i = 0; i < n; i++) {
          const a = (-2 * Math.PI * k * i) / n;
          re += samples[i] * Math.cos(a);
          im += samples[i] * Math.sin(a);
        }
        out[k] = Math.hypot(re, im) / n;
      }
      return out;
    };

    const results = [];
    for (const patch of DEMO_PATCHES) {
      const pending = patchPlaceholders(patch);
      if (pending.length) { results.push({ id: patch.id, skipped: "placeholder", pending }); continue; }

      const { states } = buildPatchItems(patch, registry, { x: 0, y: 0 }, (n) => `${patch.id}-${n}`);
      const scene = readAudioScene(states, registry);
      const ctx = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
      const engine = createEngine({ audioContext: ctx });
      let transportDriven = false;
      try {
        await engine.init();
        for (const [id, mod] of Object.entries(scene.modules)) engine.addModule(mod.module, id, mod.knobs);

        // ASK THE ENGINE WHICH MODULES NEED AN EVENT. `inspect()` reports `transport`
        // (the shared scheduler steps it) and `played` (it waits for a note), both
        // derived from the instance's own surface. A `method` connection is the third
        // form — a gate wire the mirror routes to `engine.trigger` rather than
        // connecting, so the patch is silent until something fires it.
        //
        // The first attempt indexed `inspect().modules` BY ID. It is an ARRAY, so every
        // lookup was `undefined` and every patch was reported autonomous — which is why
        // four event-driven patches came back as SILENT defects. Measured, then fixed
        // here and in the engine, which now answers the question instead of being guessed
        // at.
        //
        // AND THE BLUEPRINT IS ASKED TOO, because the scene alone cannot see the third
        // case. A CONTROL node (a button, a knob, a keyboard) has no `audioModule`, so
        // `readAudioScene` drops it AND drops every wire from it — correctly, it has no
        // engine counterpart — which means a patch driven by a button arrives at the
        // engine as an unconnected bell and looks exactly like a broken graph. Measured:
        // `button-ding` was the last false SILENT after the engine's own report went in.
        const inspected = engine.inspect().modules;
        const needsHand = patch.nodes.some((n) => {
          const p = registry.get(n.type);
          return typeof p.ports === "function" && !p.audioModule;
        });
        transportDriven = needsHand || inspected.some((m) => m.transport || m.played) || scene.connections.some((c) => c.method);
        // ── `await` IS LOAD-BEARING HERE, AND OMITTING IT RENDERS PURE SILENCE ──
        // Every output goes through a per-module GUARD GAIN, and `connect()` ramps that
        // guard to 0, applies the wiring, then ramps it back — the restore running inside
        // a `setTimeout`, i.e. on the WALL clock (synth/engine.js `underRampGuard`). An
        // OfflineAudioContext's clock is not the wall clock and `startRendering()` does
        // not wait for pending timers, so an unawaited connect leaves every guard parked
        // at zero for the entire render. Measured: all seven house patches came back at
        // exactly -inf dBFS, which is the signature of a harness fault rather than seven
        // independent bugs — no real defect is that uniform.
        for (const c of scene.connections) {
          if (c.method) continue; // a METHOD port is engine.trigger(), not a connection
          await engine.connect(c.sourceId, c.sourcePort, c.targetId, c.targetPort);
        }
        const buffer = await ctx.startRendering();

        const left = buffer.getChannelData(0);
        let peak = 0, sum = 0, sumsq = 0, bad = 0;
        for (let i = 0; i < left.length; i++) {
          const v = left[i];
          if (!Number.isFinite(v)) { bad++; continue; }
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sum += v;
          sumsq += v * v;
        }
        const rms = Math.sqrt(sumsq / left.length);
        const dc = sum / left.length;

        // Spectral centroid over a window taken AFTER the attack, so a patch is judged on
        // its body rather than on its click.
        const WINDOW = 2048;
        const start = Math.min(left.length - WINDOW, Math.round(rate * (seconds / 2)));
        const mags = spectrum(left.subarray(start, start + WINDOW), WINDOW / 2);
        let num = 0, den = 0;
        for (let k = 0; k < mags.length; k++) { num += (k * rate) / WINDOW * mags[k]; den += mags[k]; }

        // The RMS envelope in eighths, so a decaying tail, a swell and a steady drone are
        // distinguishable in the report without anyone reading a waveform.
        const SLICES = 8;
        const env = [];
        for (let s = 0; s < SLICES; s++) {
          const a = Math.floor((s * left.length) / SLICES), b = Math.floor(((s + 1) * left.length) / SLICES);
          let q = 0;
          for (let i = a; i < b; i++) q += left[i] * left[i];
          env.push(Math.sqrt(q / (b - a)));
        }
        results.push({ id: patch.id, nodes: patch.nodes.length, peak, rms, dc, bad, transportDriven, centroid: den ? num / den : 0, env });
      } catch (e) {
        results.push({ id: patch.id, error: e.message });
      } finally {
        await engine.dispose();
      }
    }
    return results;
  }, { seconds: RENDER_SECONDS, rate: RENDER_RATE, app: resolve(webRoot, "..") });

  const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
  console.log(`PATCH SOUND — ${RENDER_SECONDS}s per patch at ${RENDER_RATE} Hz, rendered offline\n`);
  for (const r of report) {
    if (r.skipped) { console.log(`  ..  ${r.id.padEnd(28)} not measured — waiting on ${r.pending.join(" ")}`); continue; }
    if (r.error) { console.log(`  XX  ${r.id.padEnd(28)} ${r.error}`); failures.push(`${r.id}: ${r.error}`); continue; }
    measured++;
    const flags = [];
    if (r.bad) flags.push(`${r.bad} NON-FINITE SAMPLES`);
    if (r.rms < SILENCE_RMS && !r.transportDriven) flags.push(`SILENT (rms ${db(r.rms)} dBFS)`);
    if (r.peak > CLIP_PEAK) flags.push(`CLIPPED (peak ${db(r.peak)} dBFS)`);
    if (Math.abs(r.dc) > MAX_DC) flags.push(`DC OFFSET ${r.dc.toFixed(4)}`);
    // A tail that is LOUDER at the end than in the middle, by a lot, is a loop whose gain
    // exceeds unity — the failure mode of every hand-built reverb and comb in this round.
    if (r.env[7] > r.env[3] * 4 && r.env[7] > SILENCE_RMS) flags.push(`GROWING (env ${db(r.env[3])} -> ${db(r.env[7])} dBFS)`);
    const mark = flags.length ? "XX" : r.transportDriven && r.rms < SILENCE_RMS ? ".." : "ok";
    const note = r.transportDriven ? " [event-driven: no transport or keypress offline]" : "";
    console.log(`  ${mark}  ${r.id.padEnd(28)} peak ${db(r.peak).padStart(6)}  rms ${db(r.rms).padStart(6)} dBFS  centroid ${Math.round(r.centroid).toString().padStart(5)} Hz  ${r.nodes} nodes${note}`);
    if (flags.length) { console.log(`      ${flags.join("; ")}`); failures.push(`${r.id}: ${flags.join("; ")}`); }
  }

  const skipped = report.filter((r) => r.skipped).length;
  console.log(`\n${measured} measured, ${skipped} waiting on placeholders, ${failures.length} with defects`);
  if (pageErrors.length) {
    console.log(`\nPAGE ERRORS (${pageErrors.length}):`);
    for (const e of pageErrors.slice(0, 10)) console.log(`  ${e}`);
    failures.push(...pageErrors);
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem${failures.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\nPASS — every measurable patch produced finite, audible, unclipped, non-diverging audio");
