/**
 * MP4 SAMPLE READER + SEGMENT REMUX — the piece that lets an in-browser render be
 * PAUSED AND RESUMED and still come out as ONE movie.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 * The in-page H.264 encoder (web/mp4Encoder.js) is a WASM library that produces a
 * COMPLETE .mp4 when it is finalized — it has no "give me the bitstream so far"
 * API. A render that must survive the page closing therefore cannot be one long
 * encode: it is a SEQUENCE OF SEGMENTS, each a self-contained little .mp4 covering
 * a fixed number of frames and starting on its own IDR (keyframe), persisted the
 * moment it is finished. Reopening the page continues with a NEW segment.
 *
 * That makes the last thing to happen a REMUX: take the H.264 samples out of every
 * segment and write them into one container with one continuous timeline. No
 * re-encoding happens here — the compressed samples are copied byte-for-byte — so
 * a resumed render is pixel-identical to an uninterrupted one.
 *
 * Concatenating H.264 this way is legitimate precisely because every segment
 * begins with an IDR and they all come from the SAME encoder configuration, so
 * one SPS/PPS (the `avcC` record) describes the whole stream. That is not assumed:
 * remuxAvcSegments COMPARES each segment's avcC and throws if they differ.
 *
 * ── WHY A HAND-WRITTEN READER ─────────────────────────────────────────────────
 * Only one thing is needed from each segment — the list of (offset, size,
 * keyframe) samples plus the avcC record — and the boxes that carry it (stsd/
 * avcC/stsz/stsc/stco/co64) are a fixed, well-specified walk. A general MP4
 * demuxer would be a large dependency for that. Everything here is a PURE
 * function of bytes, so the whole file runs and doctests in bare node.
 *
 * ── LOUD, NOT LENIENT ─────────────────────────────────────────────────────────
 * Every structural surprise throws: a missing box, a sample-table walk that does
 * not recover exactly `stsz` samples, an avcC mismatch between segments, a
 * segment whose sample count disagrees with the frame count it claims. A silently
 * short or mis-timed video is the failure mode this module exists to make
 * impossible, so nothing here is best-effort.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/** Bytes of box header before a box's payload: size(4) + type(4). */
const BOX_HEADER_BYTES = 8;
/** A `size` field of 1 means the real size is a 64-bit `largesize` that follows. */
const BOX_SIZE_IS_64 = 1;
const LARGESIZE_BYTES = 8;
/** Box types that contain only child boxes, with no payload of their own. */
const PURE_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "mvex", "moof", "traf", "udta"]);
/** `stsd` is a FullBox (version+flags) plus an entry_count before its children. */
const STSD_CHILD_OFFSET = 8;
/**
 * A VisualSampleEntry (`avc1`) carries a fixed 78-byte preamble before its child
 * boxes: SampleEntry's 6 reserved bytes + 2-byte data_reference_index (8), then
 * pre_defined(2) reserved(2) pre_defined[3](12) width(2) height(2)
 * horizresolution(4) vertresolution(4) reserved(4) frame_count(2)
 * compressorname(32) depth(2) pre_defined(2) = 70.
 */
const VISUAL_SAMPLE_ENTRY_PREAMBLE_BYTES = 78;
/** H.264 nal_unit_type for a coded slice of an IDR picture (ISO/IEC 14496-10 7.4.1). */
const NAL_TYPE_IDR = 5;
/** Bit mask selecting nal_unit_type out of a NAL header byte. */
const NAL_TYPE_MASK = 0x1f;
/** Offset of `lengthSizeMinusOne` inside an AVCDecoderConfigurationRecord:
 *  configurationVersion(1) profile(1) compat(1) level(1) → byte 4. */
const AVCC_LENGTH_SIZE_OFFSET = 4;
/** Microseconds per second — mp4-muxer's raw-chunk timestamps are in µs. */
const MICROSECONDS_PER_SECOND = 1e6;

/**
 * Pure function. The four-character type of the box starting at `offset`.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset Start of the box (its size field).
 * @returns {string}
 *
 * @example boxType(new Uint8Array([0,0,0,8,0x66,0x74,0x79,0x70]), 0) // "ftyp"
 */
export function boxType(bytes, offset) {
  return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

/**
 * Pure function. The immediate child boxes of the byte range [start, end) as
 * `{type, start, payload, end}` — `payload` is where the box's own content begins
 * (after any type-specific preamble), `end` is one past its last byte.
 *
 * A box whose declared size runs past `end`, or is smaller than its header,
 * throws: a truncated MP4 must be a reported error, not a short list.
 *
 * @param {Uint8Array} bytes Whole file.
 * @param {number} start Inclusive start of the range.
 * @param {number} end Exclusive end of the range.
 * @returns {{type:string, start:number, payload:number, end:number}[]}
 *
 * @example
 * // An 8-byte empty "free" box is its own whole range.
 * boxesIn(new Uint8Array([0,0,0,8,0x66,0x72,0x65,0x65]), 0, 8)
 * // [{type: "free", start: 0, payload: 8, end: 8}]
 */
export function boxesIn(bytes, start, end) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = start;
  while (p + BOX_HEADER_BYTES <= end) {
    let size = dv.getUint32(p);
    let payload = p + BOX_HEADER_BYTES;
    if (size === BOX_SIZE_IS_64) {
      const big = dv.getBigUint64(p + BOX_HEADER_BYTES);
      if (big > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`mp4Samples: box at ${p} declares a 64-bit size of ${big}, which exceeds Number.MAX_SAFE_INTEGER`);
      size = Number(big);
      payload += LARGESIZE_BYTES;
    }
    const type = boxType(bytes, p);
    if (size < payload - p)
      throw new Error(`mp4Samples: box "${type}" at ${p} declares size ${size}, smaller than its own ${payload - p}-byte header`);
    if (p + size > end)
      throw new Error(`mp4Samples: box "${type}" at ${p} declares size ${size}, running past the end of its container (${end})`);
    if (type === "stsd") payload += STSD_CHILD_OFFSET;
    if (type === "avc1") payload += VISUAL_SAMPLE_ENTRY_PREAMBLE_BYTES;
    out.push({ type, start: p, payload, end: p + size });
    p += size;
  }
  return out;
}

/**
 * Pure function. The box at a `/`-separated `path` of four-character types (e.g.
 * "moov/trak/mdia/minf/stbl/stsz"), searching children of children. Returns
 * `{type, start, payload, end}`.
 *
 * Throws naming the missing step, so a structural surprise says WHICH box is
 * absent rather than yielding undefined.
 *
 * @param {Uint8Array} bytes Whole MP4 file.
 * @param {string} path Slash-separated box types from the file root.
 * @returns {{type:string, start:number, payload:number, end:number}}
 *
 * @example
 * // findBox(mp4Bytes, "moov/trak/mdia/minf/stbl/stsz").type // "stsz"
 */
export function findBox(bytes, path) {
  const steps = path.split("/");
  let start = 0;
  let end = bytes.length;
  let found = null;
  for (const [i, step] of steps.entries()) {
    const children = boxesIn(bytes, start, end);
    found = children.find((b) => b.type === step);
    if (!found)
      throw new Error(`mp4Samples: no "${step}" box in ${steps.slice(0, i).join("/") || "the file root"} (found: ${children.map((b) => b.type).join(", ") || "nothing"})`);
    start = found.payload;
    end = found.end;
    // Containers whose children live directly at `payload` need no adjustment;
    // the per-type preambles are already applied by boxesIn. A non-container in
    // mid-path is a malformed path, which the next iteration reports as missing.
    if (i < steps.length - 1 && !PURE_CONTAINERS.has(found.type) && found.type !== "stsd" && found.type !== "avc1")
      throw new Error(`mp4Samples: "${found.type}" is not a container, so "${path}" cannot continue through it`);
  }
  return found;
}

/**
 * Pure function. `true` when an AVCC-framed sample (4-byte-length-prefixed NAL
 * units, per `nalLengthBytes`) contains a coded IDR slice — i.e. it is a
 * keyframe. Derived from the bitstream rather than from the `stss` box because
 * some muxers omit `stss` entirely, which nominally declares EVERY sample a sync
 * sample and would make a resumed render seek to the wrong picture.
 *
 * @param {Uint8Array} sample One sample's bytes (length-prefixed NAL units).
 * @param {number} nalLengthBytes Bytes of length prefix per NAL (1, 2 or 4).
 * @returns {boolean}
 *
 * @example
 * // One 1-byte NAL of type 5 (IDR), 4-byte length prefix.
 * sampleIsKeyframe(new Uint8Array([0, 0, 0, 1, 0x65]), 4) // true
 * @example
 * // One 1-byte NAL of type 1 (non-IDR slice).
 * sampleIsKeyframe(new Uint8Array([0, 0, 0, 1, 0x41]), 4) // false
 */
export function sampleIsKeyframe(sample, nalLengthBytes) {
  let p = 0;
  while (p + nalLengthBytes < sample.length) {
    let len = 0;
    for (let i = 0; i < nalLengthBytes; i++) len = len * 256 + sample[p + i];
    if ((sample[p + nalLengthBytes] & NAL_TYPE_MASK) === NAL_TYPE_IDR) return true;
    p += nalLengthBytes + len;
  }
  return false;
}

/** Pure. The Uint32 entries of a FullBox table: `count` at `payload+4`, then the
 *  entries. Returns a plain array of numbers, `stride` words per entry. */
function readTable(bytes, box, stride) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(box.payload + 4);
  const words = [];
  for (let i = 0; i < count * stride; i++) words.push(dv.getUint32(box.payload + 8 + i * 4));
  return { count, words };
}

/**
 * Pure function. Everything needed to copy one MP4's H.264 track into another
 * container: the decoder configuration and every sample's location, size and
 * keyframe flag.
 *
 * The sample-table walk is `stsc` (samples per chunk) over `stco`/`co64` (chunk
 * file offsets) with `stsz` sizes, which is the general form — the encoder used
 * here writes several chunks, so a "one chunk" shortcut would silently drop
 * samples. The walk MUST recover exactly `stsz`'s sample count or it throws.
 *
 * @param {Uint8Array} bytes A complete .mp4 file.
 * @returns {{avcC: Uint8Array, nalLengthBytes: number, sampleCount: number,
 *            samples: {offset:number, size:number, keyframe:boolean}[]}}
 *
 * @example
 * // For a 25-frame GOP-10 segment from web/mp4Encoder.js:
 * // readAvcTrack(segmentBytes).sampleCount // 25
 * // readAvcTrack(segmentBytes).samples[0].keyframe // true
 * // readAvcTrack(segmentBytes).samples[1].keyframe // false
 */
export function readAvcTrack(bytes) {
  const STBL = "moov/trak/mdia/minf/stbl";
  const avcCBox = findBox(bytes, `${STBL}/stsd/avc1/avcC`);
  const avcC = bytes.slice(avcCBox.payload, avcCBox.end);
  const nalLengthBytes = (avcC[AVCC_LENGTH_SIZE_OFFSET] & 0x03) + 1;

  const stsz = findBox(bytes, `${STBL}/stsz`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uniformSize = dv.getUint32(stsz.payload + 4);
  const sampleCount = dv.getUint32(stsz.payload + 8);
  const sizeOf = (i) => (uniformSize !== 0 ? uniformSize : dv.getUint32(stsz.payload + 12 + i * 4));

  const stsc = readTable(bytes, findBox(bytes, `${STBL}/stsc`), 3);
  const chunkOffsets = [];
  const children = boxesIn(bytes, findBox(bytes, STBL).payload, findBox(bytes, STBL).end);
  const stco = children.find((b) => b.type === "stco");
  const co64 = children.find((b) => b.type === "co64");
  if (stco) {
    const t = readTable(bytes, stco, 1);
    chunkOffsets.push(...t.words);
  } else if (co64) {
    const count = dv.getUint32(co64.payload + 4);
    for (let i = 0; i < count; i++) {
      const big = dv.getBigUint64(co64.payload + 8 + i * 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`mp4Samples: co64 chunk offset ${big} exceeds Number.MAX_SAFE_INTEGER`);
      chunkOffsets.push(Number(big));
    }
  } else {
    throw new Error(`mp4Samples: no "stco" or "co64" chunk-offset box in ${STBL}`);
  }

  const samples = [];
  for (let e = 0; e < stsc.count; e++) {
    const firstChunk = stsc.words[e * 3];
    const samplesPerChunk = stsc.words[e * 3 + 1];
    const lastChunk = e + 1 < stsc.count ? stsc.words[(e + 1) * 3] - 1 : chunkOffsets.length;
    for (let c = firstChunk; c <= lastChunk; c++) {
      let offset = chunkOffsets[c - 1];
      for (let s = 0; s < samplesPerChunk && samples.length < sampleCount; s++) {
        const size = sizeOf(samples.length);
        samples.push({ offset, size, keyframe: sampleIsKeyframe(bytes.subarray(offset, offset + size), nalLengthBytes) });
        offset += size;
      }
    }
  }
  if (samples.length !== sampleCount)
    throw new Error(`mp4Samples: the stsc/stco walk recovered ${samples.length} samples but stsz declares ${sampleCount} — this file's sample table is inconsistent and copying it would produce a short video`);
  return { avcC, nalLengthBytes, sampleCount, samples };
}

/**
 * Pure function. `true` when two byte arrays are equal.
 *
 * @example bytesEqual(new Uint8Array([1,2]), new Uint8Array([1,2])) // true
 * @example bytesEqual(new Uint8Array([1,2]), new Uint8Array([1,3])) // false
 */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Near-pure function (the container embeds the current wall-clock creation time,
 * so the bytes are not reproducible to the bit; the VIDEO SAMPLES are copied
 * verbatim and are). Concatenates `segments` — complete .mp4 files, in
 * presentation order, each starting on an IDR — into ONE .mp4 with a single
 * continuous timeline at `fps`.
 *
 * Timestamps are derived from the GLOBAL frame index, not from each segment's
 * `stts`. They would be identical, and deriving them from the index means a lost
 * or duplicated sample shows up as a LOUD count mismatch below rather than as a
 * silently short movie.
 *
 * @param {Uint8Array[]} segments Complete .mp4 segment files, in order.
 * @param {object} o
 * @param {number} o.width Frame width in px (must match the encode).
 * @param {number} o.height Frame height in px.
 * @param {number} o.fps Frames per second of the output timeline.
 * @param {number} [o.expectedFrames] Total frames the caller believes it encoded;
 *   a mismatch throws rather than writing a video of the wrong length.
 * @returns {Uint8Array} the finished .mp4 bytes
 *
 * @example
 * // Two 10-frame segments at 10 fps become one 20-frame, 2-second movie:
 * // remuxAvcSegments([segA, segB], {width: 64, height: 48, fps: 10, expectedFrames: 20})
 */
export function remuxAvcSegments(segments, { width, height, fps, expectedFrames = null }) {
  if (segments.length === 0)
    throw new Error("mp4Samples: remuxAvcSegments was given no segments — there is nothing to write.");
  const tracks = segments.map((bytes) => ({ bytes, track: readAvcTrack(bytes) }));
  const first = tracks[0].track;
  for (const [i, { track }] of tracks.entries()) {
    if (!bytesEqual(track.avcC, first.avcC))
      throw new Error(`mp4Samples: segment ${i} was encoded with a different H.264 configuration than segment 0 (its avcC differs), so the segments cannot share one track. This means the encoder settings changed mid-job.`);
    if (!track.samples[0]?.keyframe)
      throw new Error(`mp4Samples: segment ${i} does not start on a keyframe, so it cannot be concatenated — every segment must begin with its own IDR.`);
  }
  const total = tracks.reduce((n, { track }) => n + track.sampleCount, 0);
  if (expectedFrames !== null && total !== expectedFrames)
    throw new Error(`mp4Samples: the segments hold ${total} frames but ${expectedFrames} were expected — refusing to write a video of the wrong length.`);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: fps },
    fastStart: "in-memory", // moov FIRST: the movie is seekable the instant it is written
  });
  const usPerFrame = MICROSECONDS_PER_SECOND / fps;
  let frame = 0;
  for (const { bytes, track } of tracks) {
    for (const s of track.samples) {
      muxer.addVideoChunkRaw(
        bytes.subarray(s.offset, s.offset + s.size),
        s.keyframe ? "key" : "delta",
        Math.round(frame * usPerFrame),
        Math.round(usPerFrame),
        // The decoder configuration rides on the first chunk, exactly as a
        // VideoEncoder would supply it.
        frame === 0 ? { decoderConfig: { codec: "avc1", description: track.avcC } } : undefined,
      );
      frame += 1;
    }
  }
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
