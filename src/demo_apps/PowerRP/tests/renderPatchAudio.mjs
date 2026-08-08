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
 * 3. A patch played from a CONTROL WIDGET (a keyboard, a button) is rendered with nobody
 *    at the keys. `readAudioScene` only wires nodes that HAVE an `audioModule`, so every
 *    cable out of a keyboard is dropped — and where those cables carry a VCA's gain, every
 *    voice sits at zero. Marked `.UNPLAYED`.
 *
 *    THIS TAG WAS ADDED AFTER IT BIT: `vcv-fm-pad` rendered at −67.7 dBFS and got read as a
 *    level bug worth chasing. It is not. All four of its VCAs take their gain from
 *    `keys.gate`, so what that file contains is leakage past four closed VCAs. Without the
 *    tag the filename said only `PENDING-1`, which reads as "should work, doesn't" — the
 *    exact misreading these tags exist to prevent, in a file whose whole job is to stop
 *    people theorising about sound.
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { ensureSurgeFixtures, installSurgeInterception } from "./surgeFixtures.js";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const webRoot = resolve(app, "web");

const outDir = resolve(process.argv[2] ?? join(app, ".claude_audio_checks"));
const SECONDS = Number(process.argv[3] ?? 6);
const RATE = 48000;
/** How long a RIG renders. Longer than a demo patch's default because the phrase is
 *  3.5 beats (1.75 s at 120 BPM) and the whole reason to render the reverb chain is
 *  to hear what happens AFTER the triad releases — a tail cut off at the file's end
 *  would make the reverb sound like a gate. */
const RIG_SECONDS = 6;

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
  // THE RIG PASS NEEDS SURGE'S BINARIES; the demo-patch pass does not touch them.
  // Interception passes every other request through unchanged, so the twenty-odd
  // demo patches render exactly as they did before this was added.
  const surge = await ensureSurgeFixtures((m) => console.log(m));
  if (surge.ok) await installSurgeInterception(page, surge.files);
  else console.log(`  !! SURGE RIGS SKIPPED — ${surge.reason}\n     The demo patches below still render; no Surge WAV was written.`);
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

    /**
     * The nodes whose outgoing cables `readAudioScene` will DROP because they carry no
     * `audioModule`, minus the placeholders (already counted separately). What is left is
     * the CONTROL widgets — a keyboard or a button that nobody is touching offline.
     */
    const unplayedSources = (patch, placeholderTypes) => {
      const typeOf = new Map(patch.nodes.map((n) => [n.id, n.type]));
      const dropped = new Set();
      for (const w of patch.wires ?? []) {
        const type = typeOf.get(w.from);
        if (placeholderTypes.has(type)) continue;
        if (!registry.get(type)?.audioModule) dropped.add(w.from);
      }
      return dropped.size;
    };

    const out = [];
    for (const patch of DEMO_PATCHES) {
      const pending = patchPlaceholders(patch);
      const unplayed = unplayedSources(patch, new Set(pending)); // patchPlaceholders returns type strings
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
        out.push({ id: patch.id, pending: pending.length, unplayed, noEvents, peak, L, R });
      } catch (e) {
        out.push({ id: patch.id, pending: pending.length, unplayed, error: e.message });
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
    const tags = [
      r.pending ? `PENDING-${r.pending}` : null,
      r.unplayed ? "UNPLAYED" : null,
      r.noEvents ? "NOEVENTS" : null,
    ].filter(Boolean);
    const name = `${r.id}${tags.length ? "." + tags.join(".") : ""}.wav`;
    writeFileSync(join(outDir, name), wavBytes(Float32Array.from(r.L), Float32Array.from(r.R), RATE));
    wrote++;
    const db = r.peak > 0 ? `${(20 * Math.log10(r.peak)).toFixed(1)} dBFS peak` : "SILENT";
    if (r.peak <= 0) silent++;
    console.log(`  ${r.peak > 0 ? "♪" : " "}  ${name.padEnd(52)} ${db}`);
  }
  // ── THE RIGS (user, 2026-08-08: "THESE ARE NECESSARY TESTS") ──────────────
  // The three Surge chains, PLAYED — with a real phrase scheduled on the audio
  // clock rather than one sustained chord, because the question a listener is
  // answering is "are these the right notes, in tune, in the right order", which a
  // held chord cannot answer and a dBFS figure cannot answer at all.
  if (surge.ok) {
    const rigs = await page.evaluate(async ({ appDir, seconds, rate }) => {
      const [{ createRegistry }, { registerPlugins }, { readAudioScene }, { createEngine }, { clipEvents, clipNotes, timeAtBeat }] =
        await Promise.all([
          import(`/@fs${appDir}/core/registry.js`),
          import(`/@fs${appDir}/plugins/index.js`),
          import(`/@fs${appDir}/core/audio_mirror_diff.js`),
          import(`/@fs${appDir}/synth/engine.js`),
          import(`/@fs${appDir}/core/midi_clip.js`),
        ]);
      const registry = createRegistry();
      registerPlugins(registry);
      const D = (t) => ({ ...registry.get(t).defaults });

      // A REAL PHRASE: a rising arpeggio into a held triad. Chosen so a listener can
      // hear PITCH (is it in tune), ORDER (does it rise), RHYTHM (are the eighths
      // even) and the reverb's TAIL after the triad releases — none of which a
      // sustained chord or an RMS number exposes.
      const TEMPO = 120;
      const PHRASE = [
        [0, 0.5, 60, 100], [0.5, 0.5, 64, 100], [1, 0.5, 67, 100], [1.5, 0.5, 72, 110],
        [2, 1.5, 64, 90], [2, 1.5, 67, 90], [2, 1.5, 72, 90],
      ];

      /** Command. Render one rig, scheduling `PHRASE` on the AUDIO clock. */
      async function renderRig(id, items, label) {
        const scene = readAudioScene(items, registry);
        const ctx = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
        const engine = createEngine({ audioContext: ctx });
        try {
          await engine.init();
          for (const [mid, mod] of Object.entries(scene.modules)) engine.addModule(mod.module, mid, mod.knobs);
          for (const c of scene.connections) {
            if (c.method) continue;
            await engine.connect(c.sourceId, c.sourcePort, c.targetId, c.targetPort);
          }
          const ready = await Promise.race([
            engine.moduleControl(id + "-surge").whenReady(),
            new Promise((r) => setTimeout(() => r("timeout"), 90000)),
          ]);
          if (ready !== true) return { id, label, error: `surge never became ready (${ready})` };

          // ── SCHEDULED, NOT SUSTAINED ────────────────────────────────────────
          // `synth/modules_surge.noteOn` IGNORES its `time` argument (the worklet
          // protocol has no scheduled-note message), so `engine.noteOn(…, time)`
          // cannot place a note in the future. An earlier pass concluded from that
          // that offline rhythm was impossible. IT IS NOT: `OfflineAudioContext`
          // renders in CHUNKS on demand, so suspending AT each event's time, posting
          // there, and resuming puts every note exactly where it belongs — measured
          // (three notes landed at 0.000, 0.800 and 1.600 on the audio clock).
          const notes = clipNotes({ clip: PHRASE });
          const events = clipEvents(notes).map((e) => ({ ...e, at: timeAtBeat(e.beat, TEMPO) }));
          // STRAIGHT AT THE INSTRUMENT, not through the engine's voice POOL. The
          // pool allocates a SLOT per note and Surge tracks one held note per slot;
          // an arpeggio that releases and re-allocates the same slot within a few
          // milliseconds made notes drop and sustain past their release (MEASURED:
          // the second eighth came back 13 dB down and the dry chains droned after
          // the triad). Surge does its OWN voice allocation internally — it is a
          // 16-voice polysynth — so the pool is a second allocator fighting the
          // first.  is the module's own note door, which is exactly
          // what the GUI's piano plays through.
          const surgeCtl = engine.moduleControl(id + "-surge");
          const fire = (e) => {
            if (e.type === "noteOn") surgeCtl.noteOn(e.pitch, e.velocity ?? 100);
            else surgeCtl.noteOff(e.pitch);
          };
          for (const e of events.filter((e) => e.at <= 0)) fire(e);
          const later = [...new Set(events.filter((e) => e.at > 0).map((e) => e.at))].sort((a, b) => a - b);
          for (const at of later) {
            if (at >= seconds) continue; // a suspension past the render's end never resolves
            ctx.suspend(at).then(() => {
              for (const e of events.filter((e) => e.at === at)) fire(e);
              ctx.resume();
            });
          }
          await new Promise((r) => setTimeout(r, 250));
          const buf = await ctx.startRendering();
          const L = Array.from(buf.getChannelData(0));
          const R = Array.from(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
          let peak = 0;
          for (const v of L) peak = Math.max(peak, Math.abs(v));
          return { id, label, peak, L, R };
        } catch (e) {
          return { id, label, error: e.message };
        } finally {
          await engine.dispose();
        }
      }

      const out = [];
      // 1. keys -> surge -> out. The PRE-WIRED RIG's own topology; the notes are
      //    injected because nobody is at the keys offline (the UNPLAYED trap).
      out.push(await renderRig("keys", {
        "keys-keys": D("node_keyboard"),
        "keys-surge": { ...D("audio_surge"), inputs: { gate: { item: "keys-keys", port: "gate" }, pitch: { item: "keys-keys", port: "pitch" } } },
        "keys-out": { ...D("audio_output"), inputs: { in: { item: "keys-surge", port: "out" } } },
      }, "keys -> surge -> out"));
      // 2. clip -> surge -> out. The same phrase down a `midi` cable.
      out.push(await renderRig("clip", {
        "clip-clip": { ...D("node_midi_clip"), tempo: TEMPO, clip: PHRASE },
        "clip-surge": { ...D("audio_surge"), inputs: { notes: { item: "clip-clip", port: "midi" } } },
        "clip-out": { ...D("audio_output"), inputs: { in: { item: "clip-surge", port: "out" } } },
      }, "clip -> surge -> out"));
      // 3. ...through a reverb, fully wet so the tail after the triad is unmissable.
      out.push(await renderRig("clipverb", {
        "clipverb-clip": { ...D("node_midi_clip"), tempo: TEMPO, clip: PHRASE },
        "clipverb-surge": { ...D("audio_surge"), inputs: { notes: { item: "clipverb-clip", port: "midi" } } },
        "clipverb-verb": { ...D("audio_reverb"), audioWet: 1, audioDry: 0.5, inputs: { in: { item: "clipverb-surge", port: "out" } } },
        "clipverb-out": { ...D("audio_output"), inputs: { in: { item: "clipverb-verb", port: "out" } } },
      }, "clip -> surge -> reverb -> out"));
      return out;
    }, { appDir: app, seconds: RIG_SECONDS, rate: RATE });

    console.log("");
    for (const r of rigs) {
      if (r.error) { console.log(`  XX  ${r.id} — ${r.error.slice(0, 90)}`); continue; }
      // NO `UNPLAYED` TAG, and that is the point: these rigs have their notes
      // INJECTED, so a silent file here is a real defect rather than the documented
      // "nobody at the keys" artefact. `PLAYED` says so positively.
      const name = `rig-${r.id}.PLAYED.wav`;
      writeFileSync(join(outDir, name), wavBytes(Float32Array.from(r.L), Float32Array.from(r.R), RATE));
      wrote++;
      const db = r.peak > 0 ? `${(20 * Math.log10(r.peak)).toFixed(1)} dBFS peak` : "SILENT";
      if (r.peak <= 0) silent++;
      console.log(`  ${r.peak > 0 ? "♪" : " "}  ${name.padEnd(52)} ${db}   ${r.label}`);
    }
  }

  console.log(`\n${wrote} file(s) written, ${silent} silent.`);
  console.log(`Listen: ${outDir}`);
  console.log("PENDING-n = n placeholder node types in that patch (their wires are dropped too).");
  console.log("UNPLAYED  = played from a keyboard/button; nobody is at the keys offline, so gated voices sit at zero.");
  console.log("NOEVENTS  = transport-driven; the scheduler needs a wall clock, so you hear the drones and no events.");
  console.log("PLAYED    = a rig whose notes were INJECTED and SCHEDULED, so silence here is a real defect.");
} finally {
  await browser.close();
  await server.close();
}
