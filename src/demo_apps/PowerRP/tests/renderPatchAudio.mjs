/**
 * RENDER EVERY DEMO PATCH TO A .WAV YOU CAN ACTUALLY PLAY.
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/renderPatchAudio.mjs [outDir] [seconds]
 *
 * ── WHY THIS EXISTS: A MEASUREMENT IS NOT A LISTEN ──────────────────────────
 * USER, 2026-08-07: *"don't theorize about sound. we acrually need to HEAR it."*
 *
 * `tests/patch_sound_probe.mjs` renders the same audio and reports peak, RMS, spectral
 * centroid and an envelope. Every one of those numbers can be perfectly healthy while the
 * patch sounds wrong — a filter an octave off, an envelope with the wrong shape, a
 * sequence in the wrong key, a reverb that is technically decaying and musically awful.
 * That probe's own header says it "CANNOT tell you whether a patch is GOOD", and reading
 * its numbers back as if they settled the question is exactly the mistake the ruling names.
 *
 * So this writes FILES. It is not a test, it makes no assertions and it is deliberately
 * NOT named `*_probe` so the gate never collects it. Its entire job is to hand a human
 * something to put in their ears.
 *
 * ── IT RENDERS THE SAME GRAPH THE APP PLAYS ─────────────────────────────────
 * Same path as the sound probe: the real blueprint through `buildPatchItems`, the real
 * `readAudioScene`, the real engine, in an OfflineAudioContext in headless Chrome. Not a
 * re-implementation — if what you hear is wrong, the app is wrong the same way.
 *
 * ── TWO LIMITS, STATED SO A SILENT FILE IS NOT MISREAD ──────────────────────
 * 1. A patch with PLACEHOLDER nodes renders whatever survives, which is often nothing. The
 *    filename says so (`.PENDING-n.wav`) rather than leaving you guessing whether the
 *    silence is a bug or an unbuilt node.
 * 2. A patch driven by the shared TRANSPORT (a clock, a sequencer) produces its drones and
 *    none of its events, because the scheduler's look-ahead runs on a wall clock and an
 *    OfflineAudioContext's does not. Marked `.NOEVENTS` in the filename for the same reason.
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const webRoot = resolve(app, "web");

const outDir = resolve(process.argv[2] ?? join(app, ".claude_audio_checks"));
const SECONDS = Number(process.argv[3] ?? 6);
const RATE = 48000;

/**
 * Pure function. A 16-bit stereo WAV file, as bytes.
 *
 * Written here rather than pulled in because it is forty lines and a dependency for a
 * listening aid is a poor trade. 16-bit because every player opens it and the extra
 * fidelity of float32 would be inaudible against the defects we are listening for.
 *
 * @param {Float32Array} left - left channel, -1..1
 * @param {Float32Array} right - right channel, same length
 * @param {number} rate - sample rate in Hz
 * @returns {Buffer}
 *
 * @example wavBytes(new Float32Array(4), new Float32Array(4), 48000).length // 60
 * @example wavBytes(new Float32Array(4), new Float32Array(4), 48000).toString("ascii", 0, 4) // "RIFF"
 */
export function wavBytes(left, right, rate) {
  const frames = left.length;
  const dataBytes = frames * 4; // 2 channels x 16 bit
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);          // PCM chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(2, 22);           // stereo
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);    // byte rate
  buf.writeUInt16LE(4, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of [left, right]) {
      // Clamp before scaling: a patch that overshoots should sound clipped, which is
      // TRUE, rather than wrap around into noise, which would be a lie about the defect.
      const v = Math.max(-1, Math.min(1, ch[i] || 0));
      buf.writeInt16LE(Math.round(v * 32767), at);
      at += 2;
    }
  }
  return buf;
}

mkdirSync(outDir, { recursive: true });

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle0" });

  const rendered = await page.evaluate(async ({ appDir, seconds, rate }) => {
    const [{ DEMO_PATCHES, buildPatchItems }, { patchPlaceholders }, { createRegistry }, { registerPlugins }, { readAudioScene }, { createEngine }] =
      await Promise.all([
        import(`/@fs${appDir}/core/audio_patches.js`),
        import(`/@fs${appDir}/core/audio_stub_nodes.js`),
        import(`/@fs${appDir}/core/registry.js`),
        import(`/@fs${appDir}/plugins/index.js`),
        import(`/@fs${appDir}/core/audio_mirror_diff.js`),
        import(`/@fs${appDir}/synth/engine.js`),
      ]);
    const registry = createRegistry();
    registerPlugins(registry);

    const out = [];
    for (const patch of DEMO_PATCHES) {
      const pending = patchPlaceholders(patch);
      // EVERY patch is attempted independently. `buildPatchItems` throws LOUDLY on a
      // blueprint whose knob names no longer match a shipped spec — which is correct, and
      // which would otherwise stop the whole run at the first unreconciled patch and cost
      // you the twenty-six you could have listened to. A listening aid renders what it
      // can and NAMES what it cannot.
      let states, scene, ctx, engine;
      let noEvents = false;
      try {
        ({ states } = buildPatchItems(patch, registry, { x: 0, y: 0 }, (n) => `${patch.id}-${n}`));
        scene = readAudioScene(states, registry);
        ctx = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
        engine = createEngine({ audioContext: ctx });
        await engine.init();
        for (const [id, mod] of Object.entries(scene.modules)) engine.addModule(mod.module, id, mod.knobs);
        const inspected = engine.inspect().modules;
        noEvents = inspected.some((m) => m.transport || m.played) || scene.connections.some((c) => c.method);
        // `await` is load-bearing — the rewire guard restores on a wall-clock timer, so an
        // unawaited connect leaves every guard at zero and renders pure silence.
        for (const c of scene.connections) {
          if (c.method) continue;
          await engine.connect(c.sourceId, c.sourcePort, c.targetId, c.targetPort);
        }
        const buf = await ctx.startRendering();
        let peak = 0;
        const L = Array.from(buf.getChannelData(0));
        const R = Array.from(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
        for (const v of L) peak = Math.max(peak, Math.abs(v));
        out.push({ id: patch.id, pending: pending.length, noEvents, peak, L, R });
      } catch (e) {
        out.push({ id: patch.id, pending: pending.length, error: e.message });
      } finally {
        if (engine) await engine.dispose();
      }
    }
    return out;
  }, { appDir: app, seconds: SECONDS, rate: RATE });

  console.log(`Rendering ${SECONDS}s per patch into ${outDir}\n`);
  let wrote = 0, silent = 0;
  for (const r of rendered) {
    if (r.error) { console.log(`  XX  ${r.id} — ${r.error.slice(0, 90)}`); continue; }
    const tags = [r.pending ? `PENDING-${r.pending}` : null, r.noEvents ? "NOEVENTS" : null].filter(Boolean);
    const name = `${r.id}${tags.length ? "." + tags.join(".") : ""}.wav`;
    writeFileSync(join(outDir, name), wavBytes(Float32Array.from(r.L), Float32Array.from(r.R), RATE));
    wrote++;
    const db = r.peak > 0 ? `${(20 * Math.log10(r.peak)).toFixed(1)} dBFS peak` : "SILENT";
    if (r.peak <= 0) silent++;
    console.log(`  ${r.peak > 0 ? "♪" : " "}  ${name.padEnd(52)} ${db}`);
  }
  console.log(`\n${wrote} file(s) written, ${silent} silent.`);
  console.log(`Listen: ${outDir}`);
  console.log("PENDING-n = n placeholder node types in that patch. NOEVENTS = clock/keyboard driven; offline renders its drones only.");
} finally {
  await browser.close();
  await server.close();
}
