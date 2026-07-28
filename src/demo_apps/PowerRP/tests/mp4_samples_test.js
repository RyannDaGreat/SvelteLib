/**
 * MP4 SAMPLE READER + SEGMENT REMUX (bare node).
 *
 * web/mp4Samples.js is what makes a PAUSED browser render come out as ONE movie:
 * it lifts the H.264 samples out of each independently-encoded segment and writes
 * them into a single container. If it is wrong, the failure is not a crash — it is
 * a video that is silently short, out of order, or mis-timed. So this suite feeds
 * it REAL encoder output (the same wasm encoder the browser uses, via its node
 * build) and then makes ffmpeg DECODE the result and count frames.
 *
 * It runs in bare node with no browser: the parser is pure byte math and the
 * remuxer is pure JS, which is exactly why they live in their own module instead of
 * inside the worker.
 *
 * Run: node src/demo_apps/PowerRP/tests/mp4_samples_test.js
 */

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import HME from "h264-mp4-encoder";
import { readAvcTrack, remuxAvcSegments, sampleIsKeyframe, boxType, boxesIn, findBox, bytesEqual } from "../web/mp4Samples.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), "powerrp_mp4_samples_test");

/** Test geometry. Small and cheap: this suite tests the CONTAINER, not the codec. */
const W = 64, H = 48, FPS = 10;
/** Frames per segment, and therefore the keyframe period inside a segment. */
const SEG_FRAMES = 10;
/** Two full segments plus a short one — the shape a real paused render leaves. */
const SEGMENT_PLAN = [SEG_FRAMES, SEG_FRAMES, 5];

const fails = [];
function check(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails.push(label);
}

/** Pure function. A deterministic RGBA frame that CHANGES with `f`, so a decoder
 *  that silently repeats or drops a frame produces different pixels.
 *  @example makeFrame(0).length // 12288 */
function makeFrame(f) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4 + 0] = (i * 7 + f * 29) % 256;
    rgba[i * 4 + 1] = (f * 53) % 256;
    rgba[i * 4 + 2] = (i * 3) % 256;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Command (async; allocates wasm). Encode `frames` frames starting at `first`
 *  into one self-contained segment .mp4, exactly as the worker does. */
async function encodeSegment(first, frames) {
  const enc = await HME.createH264MP4Encoder();
  enc.width = W;
  enc.height = H;
  enc.frameRate = FPS;
  enc.quantizationParameter = 30;
  enc.speed = 5;
  enc.groupOfPictures = SEG_FRAMES;
  enc.outputFilename = `seg_${first}.mp4`;
  enc.initialize();
  for (let i = 0; i < frames; i++) enc.addFrameRgba(makeFrame(first + i));
  enc.finalize();
  const bytes = new Uint8Array(enc.FS.readFile(enc.outputFilename));
  enc.FS.unlink(enc.outputFilename);
  enc.delete();
  return bytes;
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

console.log("mp4Samples — box walking");
{
  // An 8-byte "free" box: the smallest legal box, and the base case of boxesIn.
  const free = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  check(boxType(free, 0) === "free", "boxType reads the 4cc");
  const boxes = boxesIn(free, 0, free.length);
  check(boxes.length === 1 && boxes[0].type === "free" && boxes[0].end === 8, "boxesIn walks one box");
  let threw = null;
  try { boxesIn(new Uint8Array([0, 0, 0, 99, 0x66, 0x72, 0x65, 0x65]), 0, 8); } catch (e) { threw = e; }
  check(threw !== null && /running past the end/.test(threw.message), "a box declaring a size past its container throws LOUDLY");
  threw = null;
  try { findBox(free, "moov/trak"); } catch (e) { threw = e; }
  check(threw !== null && /no "moov" box/.test(threw.message), "findBox names the missing box");
  check(sampleIsKeyframe(new Uint8Array([0, 0, 0, 1, 0x65]), 4) === true, "an IDR NAL (type 5) is a keyframe");
  check(sampleIsKeyframe(new Uint8Array([0, 0, 0, 1, 0x41]), 4) === false, "a non-IDR slice NAL (type 1) is not");
  check(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])) && !bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2])), "bytesEqual");
}

console.log("\nmp4Samples — reading a real encoder segment");
const segments = [];
let first = 0;
for (const n of SEGMENT_PLAN) {
  segments.push(await encodeSegment(first, n));
  first += n;
}
const TOTAL = SEGMENT_PLAN.reduce((a, b) => a + b, 0);
{
  const t = readAvcTrack(segments[0]);
  check(t.sampleCount === SEGMENT_PLAN[0], `sampleCount is ${t.sampleCount} for a ${SEGMENT_PLAN[0]}-frame segment`);
  check(t.samples.length === SEGMENT_PLAN[0], "the stsc/stco walk recovered every sample");
  check(t.samples[0].keyframe === true, "sample 0 of a segment is a keyframe (it is a fresh encoder → IDR)");
  check(t.samples.slice(1).every((s) => !s.keyframe), "no other sample in the segment is a keyframe (GOP == segment length)");
  check(t.nalLengthBytes === 4, `avcC declares ${t.nalLengthBytes}-byte NAL length prefixes`);
  check(t.avcC.length > 8, `avcC is ${t.avcC.length} bytes`);
  check(t.samples.every((s) => s.size > 0 && s.offset > 0), "every sample has a positive size and offset");
  // Sample ranges must not overlap and must stay inside the file.
  const ordered = t.samples.every((s, i) => i === 0 || s.offset >= t.samples[i - 1].offset + t.samples[i - 1].size);
  check(ordered, "samples are non-overlapping and in order");
  check(t.samples.at(-1).offset + t.samples.at(-1).size <= segments[0].length, "the last sample ends inside the file");
}

console.log("\nmp4Samples — remuxing segments into one movie");
{
  const one = remuxAvcSegments(segments, { width: W, height: H, fps: FPS, expectedFrames: TOTAL });
  const path = join(SCRATCH, "remuxed.mp4");
  writeFileSync(path, one);
  const info = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration",
    "-of", "json", path,
  ], { encoding: "utf8" }));
  const s = info.streams[0];
  check(s.codec_name === "h264", `remuxed codec is h264 (${s.codec_name})`);
  check(Number(s.width) === W && Number(s.height) === H, `remuxed dimensions ${s.width}x${s.height}`);
  check(Number(s.nb_read_frames) === TOTAL, `ffmpeg DECODED ${s.nb_read_frames} frames from the remux (expected ${TOTAL})`);
  check(s.avg_frame_rate === `${FPS}/1`, `remuxed frame rate ${s.avg_frame_rate}`);
  check(Math.abs(Number(info.format.duration) - TOTAL / FPS) < 0.05, `remuxed duration ${Number(info.format.duration).toFixed(3)}s (expected ${(TOTAL / FPS).toFixed(3)}s)`);

  // The remux must mark exactly the segment starts as sync samples — that is what
  // makes the finished movie seekable at the boundaries it was resumed at.
  const keyframes = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame",
    "-of", "csv=p=0", path,
  ], { encoding: "utf8" }).trim().split("\n").map((x) => x.replace(/,$/, ""));
  const keyIndices = keyframes.flatMap((v, i) => (v === "1" ? [i] : []));
  const expectedKeys = SEGMENT_PLAN.reduce((acc, n) => [...acc, (acc.at(-1) ?? 0) + (acc.length ? SEGMENT_PLAN[acc.length - 1] : 0)], []);
  check(JSON.stringify(keyIndices) === JSON.stringify(expectedKeys),
    `keyframes at frames [${keyIndices}] (segment starts are [${expectedKeys}])`);

  // Every decoded frame must be DIFFERENT — a remux that repeated a sample would
  // still decode to the right COUNT.
  const framesDir = join(SCRATCH, "frames");
  mkdirSync(framesDir, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "image2", join(framesDir, "f_%03d.png")]);
  const hashes = execFileSync("sh", ["-c", `md5sum ${framesDir}/*.png | awk '{print $1}' | sort -u | wc -l`], { encoding: "utf8" }).trim();
  check(Number(hashes) === TOTAL, `all ${hashes} decoded frames are distinct (expected ${TOTAL})`);
}

console.log("\nmp4Samples — refusing to write a wrong movie");
{
  let threw = null;
  try { remuxAvcSegments(segments, { width: W, height: H, fps: FPS, expectedFrames: TOTAL + 1 }); } catch (e) { threw = e; }
  check(threw !== null && /refusing to write a video of the wrong length/.test(threw.message), "a frame-count mismatch throws instead of writing a short video");
  threw = null;
  try { remuxAvcSegments([], { width: W, height: H, fps: FPS }); } catch (e) { threw = e; }
  check(threw !== null && /no segments/.test(threw.message), "no segments throws");
  // A segment encoded at a DIFFERENT size has a different SPS, so its avcC differs.
  threw = null;
  const other = await (async () => {
    const enc = await HME.createH264MP4Encoder();
    enc.width = W + 16; enc.height = H; enc.frameRate = FPS; enc.quantizationParameter = 30;
    enc.speed = 5; enc.groupOfPictures = SEG_FRAMES; enc.outputFilename = "other.mp4";
    enc.initialize();
    const rgba = new Uint8Array((W + 16) * H * 4).fill(200);
    for (let i = 0; i < 3; i++) enc.addFrameRgba(rgba);
    enc.finalize();
    const b = new Uint8Array(enc.FS.readFile("other.mp4"));
    enc.FS.unlink("other.mp4");
    enc.delete();
    return b;
  })();
  try { remuxAvcSegments([segments[0], other], { width: W, height: H, fps: FPS }); } catch (e) { threw = e; }
  check(threw !== null && /different H.264 configuration/.test(threw.message), "segments from different encoder settings are refused, not silently spliced");
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(fails.length === 0 ? "\nALL CHECKS PASSED" : `\n${fails.length} CHECK(S) FAILED:\n  ${fails.join("\n  ")}`);
process.exit(fails.length === 0 ? 0 : 1);
