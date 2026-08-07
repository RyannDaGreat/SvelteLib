/**
 * THE JS HALF OF THE WIRE. Mirror of `io.hpp` — same interleaved float32 files.
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Query. Read an interleaved float32 file as a Float32Array.
 *
 * @param {string} path
 * @returns {Float32Array}
 *
 * @example readF32("/tmp/in.f32").length // 96000
 */
export function readF32(path) {
  const buf = readFileSync(path);
  if (buf.byteLength % 4 !== 0) throw new Error(`readF32: ${path} is ${buf.byteLength} bytes, not a whole number of floats`);
  // A Node Buffer's underlying ArrayBuffer is pooled and may not be 4-aligned,
  // so a Float32Array view over it can throw. Copy.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * Command. Write a Float32Array (or array of numbers) as an interleaved float32 file.
 *
 * @param {string} path
 * @param {Float32Array|number[]} data
 * @returns {void}
 *
 * @example writeF32("/tmp/out.f32", [0.5, -0.5]) // writes 8 bytes
 */
export function writeF32(path, data) {
  const a = data instanceof Float32Array ? data : Float32Array.from(data);
  writeFileSync(path, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
}

/**
 * Pure function. De-interleave a flat frame buffer into per-channel Float64Arrays.
 *
 * @param {Float32Array} flat - length = frames * channels
 * @param {number} channels
 * @returns {Float64Array[]} one array per channel, each of length frames
 *
 * @example
 * >>> const c = deinterleave(Float32Array.from([1,10,2,20,3,30]), 2);
 * >>> [Array.from(c[0]), Array.from(c[1])] // [[1,2,3],[10,20,30]]
 */
export function deinterleave(flat, channels) {
  if (flat.length % channels !== 0) throw new Error(`deinterleave: ${flat.length} is not a multiple of ${channels}`);
  const frames = flat.length / channels;
  const out = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float64Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = flat[i * channels + c];
    out.push(ch);
  }
  return out;
}

/**
 * Pure function. Interleave per-channel arrays into one Float32Array.
 *
 * @param {Array<Float64Array|number[]>} channels
 * @returns {Float32Array}
 *
 * @example Array.from(interleave([[1,2],[10,20]])) // [1,10,2,20]
 */
export function interleave(channels) {
  const frames = channels[0].length;
  for (const c of channels) if (c.length !== frames) throw new Error("interleave: ragged channels");
  const out = new Float32Array(frames * channels.length);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) out[i * channels.length + c] = channels[c][i];
  }
  return out;
}
