/**
 * THE IN-PAGE WASM ENCODER, ON A PLAIN-HTTP LAN ORIGIN — does it work, and is it
 * actually FASTER than the PNG-per-frame upload it is meant to replace?
 *
 * tests/browser_encode_measure.mjs measured the old path. This one measures
 * the new one on the same deck at the same sizes, and produces a real .mp4 that
 * node then DECODES (ffprobe/ffmpeg) rather than merely weighing. Three claims are
 * on trial:
 *
 *   1. The encoder runs at all on an INSECURE origin — that is the whole point;
 *      the previous in-page encoder (WebCodecs) did not exist here.
 *   2. It SEGMENTS: several self-contained segments are emitted and remuxed into
 *      one continuous movie whose frame count and dimensions are exactly right.
 *   3. Its per-frame cost, honestly measured, against PNG+POST. Getting RGBA out
 *      of a canvas is the new path's extra cost, so it is measured BOTH ways —
 *      with a default 2D context and with `willReadFrequently` — because a GPU
 *      readback and a memcpy differ by an order of magnitude and the choice
 *      decides whether the whole idea is a win.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/wasm_encoder_probe.js
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootProbe, checker } from "./browser_render_harness.js";
import { PROBE_FPS } from "./browser_render_fixture.js";

/** Output sizes, matching the old-path measurement so the two tables compare. */
const SIZES = [
  { width: 320, height: 240, label: "320x240" },
  { width: 1280, height: 720, label: "1280x720" },
  { width: 1920, height: 1080, label: "1920x1080" },
];
/** Frames encoded per size. At PROBE_FPS this spans more than two segments, so
 *  segmentation and the remux are exercised rather than assumed. */
const FRAMES = 45;
/** getImageData repetitions when timing the readback both ways. */
const READ_REPS = 6;
/** Where the produced movies land for ffprobe. Disposable. Resolved from THIS FILE,
 *  never the shell's cwd (tests/probe_artifact_path_test.js). */
const POWERRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(POWERRP, ".claude_vlm_checks");

/** Pure function. Median of `xs`.
 *  @example median([1, 5, 3]) // 3 */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Query. ffprobe a video file for the fields this probe asserts on. */
function probeVideo(path) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames,avg_frame_rate,profile",
    "-of", "json", path,
  ], { encoding: "utf8" });
  return JSON.parse(out).streams[0];
}

mkdirSync(OUT_DIR, { recursive: true });
const probe = await bootProbe();
const { check, fails } = checker();
console.log(`Probe origin: ${probe.baseUrl}  (isSecureContext = false, asserted)\n`);

try {
  const rows = [];
  for (const size of SIZES) {
    const out = await probe.page.evaluate(async (u, size, frames, reps, fps) => {
      const { createRegistry } = await import(u.registry);
      const { createCommands } = await import(u.commands);
      const { registerAll } = await import(u.plugins);
      const { repairedDocument } = await import(u.document);
      const { loadFonts } = await import(u.fonts);
      const { probeDoc } = await import(u.fixture);
      const { createLetterboxFrameRenderer } = await import(u.transitionRender);
      const { createWasmMp4Encoder, segmentFrames } = await import(u.mp4Encoder);
      const { timelinePlan, exportVideo } = await import(u.videoExport);
      const { setParticleTimeOverride } = await import(u.particleClock);

      await loadFonts();
      const registry = createRegistry();
      registerAll(registry, createCommands());
      const { doc, reports } = repairedDocument(probeDoc(registry), registry);
      if (reports.length) throw new Error(`probe fixture needed repairs: ${JSON.stringify(reports)}`);

      const renderFrame = createLetterboxFrameRenderer({
        doc, registry, width: size.width, height: size.height, background: "#000000",
      });
      const canvas = await renderFrame(0, 1);

      // ── The readback, both ways ─────────────────────────────────────────────
      const timeReads = (ctx) => {
        const ms = [];
        for (let i = 0; i < reps; i++) {
          const t = performance.now();
          ctx.getImageData(0, 0, size.width, size.height);
          ms.push(performance.now() - t);
        }
        return ms;
      };
      const plainCanvas = document.createElement("canvas");
      plainCanvas.width = size.width; plainCanvas.height = size.height;
      const plainCtx = plainCanvas.getContext("2d");
      plainCtx.drawImage(canvas, 0, 0);
      const plainReads = timeReads(plainCtx);

      const wrfCanvas = document.createElement("canvas");
      wrfCanvas.width = size.width; wrfCanvas.height = size.height;
      const wrfCtx = wrfCanvas.getContext("2d", { willReadFrequently: true });
      wrfCtx.drawImage(canvas, 0, 0);
      const wrfReads = timeReads(wrfCtx);

      // ── The full encode, through the real pipeline ───────────────────────────
      const plan = timelinePlan(doc, { startIndex: 0, endIndex: 1, includeTransitions: false, holdSeconds: frames / 2 / fps });
      const segmentsSeen = [];
      const encoder = await createWasmMp4Encoder({
        width: size.width, height: size.height, fps, quality: "medium",
        onSegment: (s) => { segmentsSeen.push({ index: s.index, firstFrame: s.firstFrame, frames: s.frames, bytes: s.bytes.length }); },
      });
      const addMs = [];
      let encoded = 0;
      const wrapped = {
        async addFrame(source, meta) {
          const t = performance.now();
          await encoder.addFrame(source, meta);
          addMs.push(performance.now() - t);
          encoded += 1;
        },
        finalize: () => encoder.finalize(),
      };
      const t0 = performance.now();
      const result = await exportVideo({
        plan, renderFrame, encoder: wrapped,
        width: size.width, height: size.height, fps, samples: 1,
        setTime: setParticleTimeOverride,
      });
      const wallMs = performance.now() - t0;

      // Base64 out (a CDP evaluate returns JSON, so bytes travel as text).
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < result.bytes.length; i += CHUNK)
        bin += String.fromCharCode.apply(null, result.bytes.subarray(i, i + CHUNK));
      return {
        plainReads, wrfReads, addMs, wallMs, encoded,
        segmentsSeen, segmentFrames: segmentFrames(fps),
        frames: result.frames, segments: result.segments,
        base64: btoa(bin), byteLength: result.bytes.length,
      };
    }, {
      registry: probe.fsUrl("core/registry.js"),
      commands: probe.fsUrl("core/commands.js"),
      document: probe.fsUrl("core/document.js"),
      plugins: probe.fsUrl("plugins/index.js"),
      fonts: probe.fsUrl("web/fontLoader.js"),
      fixture: probe.fsUrl("tests/browser_render_fixture.js"),
      transitionRender: probe.fsUrl("web/transitionRender.js"),
      mp4Encoder: probe.fsUrl("web/mp4Encoder.js"),
      videoExport: probe.fsUrl("web/videoExport.js"),
      particleClock: probe.fsUrl("render_gpu/particle_clock.js"),
    }, size, FRAMES, READ_REPS, PROBE_FPS);

    const path = join(OUT_DIR, `wasm_encoder_${size.label}.mp4`);
    writeFileSync(path, Buffer.from(out.base64, "base64"));
    const info = probeVideo(path);

    console.log(`── ${size.label} ──`);
    check(out.segments >= 2, `${size.label}: the encode produced ${out.segments} segments (segmentation exercised)`);
    check(out.segmentsSeen.every((s) => s.frames === out.segmentFrames) || out.segmentsSeen.length === out.segments - 0,
      `${size.label}: onSegment fired ${out.segmentsSeen.length} time(s), frames per closed segment ${[...new Set(out.segmentsSeen.map((s) => s.frames))].join("/")}`);
    check(info.codec_name === "h264", `${size.label}: codec is h264 (got ${info.codec_name})`);
    check(Number(info.width) === size.width && Number(info.height) === size.height,
      `${size.label}: dimensions ${info.width}x${info.height}`);
    check(Number(info.nb_read_frames) === out.frames,
      `${size.label}: ffmpeg DECODED ${info.nb_read_frames} frames, encoder reported ${out.frames}`);
    check(info.avg_frame_rate === `${PROBE_FPS}/1`, `${size.label}: frame rate ${info.avg_frame_rate}`);

    rows.push({ size, out, info, path });
  }

  console.log("\nREADBACK: getting RGBA out of the frame canvas (median ms)");
  console.log("  size           default ctx   willReadFrequently");
  for (const { size, out } of rows)
    console.log(`  ${size.label.padEnd(14)} ${median(out.plainReads).toFixed(2).padEnd(13)} ${median(out.wrfReads).toFixed(2)}`);

  console.log("\nWASM ENCODE, per frame (ms)");
  console.log("  size           addFrame median   addFrame max   whole-export ms/frame   file KiB");
  for (const { size, out } of rows)
    console.log(`  ${size.label.padEnd(14)} ${median(out.addMs).toFixed(2).padEnd(17)} ${Math.max(...out.addMs).toFixed(2).padEnd(14)} ${(out.wallMs / out.encoded).toFixed(2).padEnd(23)} ${(out.byteLength / 1024).toFixed(0)}`);

  console.log("\nMovies written for inspection:");
  for (const { path } of rows) console.log(`  ${path}`);

  if (probe.errors.length) {
    console.log("\nPAGE ERRORS");
    for (const e of probe.errors) console.log(`  ${e}`);
  }
  console.log(fails.length === 0 ? "\nALL CHECKS PASSED" : `\n${fails.length} CHECK(S) FAILED`);
  process.exitCode = fails.length === 0 ? 0 : 1;
} finally {
  await probe.stop();
}
