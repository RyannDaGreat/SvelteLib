/**
 * DIAGNOSTIC READ-OUT for one case's stored buffers, so a difference can be
 * attributed before it is reported. Run `run.mjs --filter=...` first (it leaves
 * `build/<case>.ours.f32` and `.theirs.f32` behind), then:
 *
 *   node harness/diagnose.mjs <caseName> [count]
 *
 * Prints where the largest disagreements are and what the two sides held there.
 * A max |Δ| of 1.0 on a ±1 waveform is either a real amplitude error or a
 * one-sample edge offset, and only the sample indices tell you which.
 */

import { join } from "node:path";
import { readF32 } from "./lib/io.mjs";
import { HARNESS_ROOT } from "./lib/runner.mjs";

const name = process.argv[2];
const count = Number(process.argv[3] ?? 12);
if (!name) throw new Error("usage: diagnose.mjs <caseName> [count]");
const stem = name.replace(/[^\w.-]/g, "_");
const ours = readF32(join(HARNESS_ROOT, "build", `${stem}.ours.f32`));
const theirs = readF32(join(HARNESS_ROOT, "build", `${stem}.theirs.f32`));

const diffs = [];
for (let i = 0; i < ours.length; i++) diffs.push([Math.abs(ours[i] - theirs[i]), i]);
diffs.sort((a, b) => b[0] - a[0]);

process.stdout.write(`${name}: ${ours.length} samples\n`);
process.stdout.write("worst disagreements (index, ours, theirs, delta), with the neighbours:\n");
for (const [d, i] of diffs.slice(0, count)) {
  const ctx = [];
  for (let k = Math.max(0, i - 1); k <= Math.min(ours.length - 1, i + 1); k++) {
    ctx.push(`${k}:[${ours[k].toFixed(6)} | ${theirs[k].toFixed(6)}]`);
  }
  process.stdout.write(`  Δ=${d.toExponential(3)} @ ${i}  ${ctx.join("  ")}\n`);
}

// A ONE-SAMPLE SHIFT is the most common false alarm: it makes max |Δ| the full
// waveform swing while the sound is identical. Test it explicitly rather than
// eyeballing the indices.
for (const shift of [-2, -1, 1, 2]) {
  let worst = 0;
  const lo = Math.max(0, -shift);
  const hi = Math.min(ours.length, ours.length - shift);
  for (let i = lo; i < hi; i++) worst = Math.max(worst, Math.abs(ours[i + shift] - theirs[i]));
  process.stdout.write(`  max |Δ| with ours shifted by ${shift}: ${worst.toExponential(3)}\n`);
}
let unshifted = 0;
for (let i = 0; i < ours.length; i++) unshifted = Math.max(unshifted, Math.abs(ours[i] - theirs[i]));
process.stdout.write(`  max |Δ| unshifted: ${unshifted.toExponential(3)}\n`);
const big = diffs.filter(([d]) => d > 0.01).length;
process.stdout.write(`  samples disagreeing by more than 0.01: ${big} of ${ours.length}\n`);
