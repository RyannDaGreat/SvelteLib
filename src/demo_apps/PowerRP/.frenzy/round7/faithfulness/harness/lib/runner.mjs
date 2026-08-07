/**
 * THE A/B RUNNER. For each case: build the upstream C++ driver, generate ONE
 * input file, run both implementations over it, and measure the difference.
 *
 * The upstream binary and our JS kernel never see different inputs — the input
 * file is written once and both read it. That is the whole reason a difference
 * reported here can be attributed to the DSP rather than to the harness.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readF32, writeF32, deinterleave } from "./io.mjs";
import { REPOS, repoPath } from "./upstream.mjs";
import {
  maxAbsError, rms, crossCorrelation, estimateF0, semitonesBetween,
  harmonicProfile, harmonicsDbString, impulseResponseDb, lowpassCorner,
} from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(HERE, "..");
const BUILD = join(HARNESS_ROOT, "build");
const SHIM = join(HARNESS_ROOT, "shim");

/** g++ flags shared by every case. -O2 because upstream ships -O3 and a debug
 *  build of a denormal-heavy filter behaves differently; -ffast-math is NOT
 *  used, since it would let the compiler reassociate the very arithmetic we
 *  are trying to compare. */
const CXXFLAGS = ["-std=c++17", "-O2", "-Wno-unused-variable", "-Wno-sign-compare", "-Wno-reorder"];

/**
 * Query. Resolve a repo's include flags, mapping the pseudo-entry "SHIM" to the
 * harness's own minimal Rack header directory.
 *
 * @param {string} key - a REPOS key
 * @returns {string[]} g++ -I arguments
 *
 * @example includeFlags("bogaudio") // ["-I","/tmp/vcvsrc/bogaudio/src","-I","/tmp/vcvsrc/bogaudio/src/dsp"]
 */
export function includeFlags(key) {
  const root = repoPath(key);
  const out = [];
  for (const inc of REPOS[key].includes) out.push("-I", inc === "SHIM" ? SHIM : join(root, inc));
  return out;
}

/**
 * Command. Build (and cache) a repo's DSP objects as a static archive.
 * Returns the archive path, or null when the repo declares no sources.
 *
 * @param {string} key - a REPOS key
 * @returns {string|null}
 */
function buildRepoArchive(key) {
  const spec = REPOS[key];
  if (!spec.sources.length) return null;
  const root = repoPath(key);
  const objDir = join(BUILD, `lib_${key}`);
  mkdirSync(objDir, { recursive: true });
  const archive = join(objDir, `lib${key}.a`);
  const objs = [];
  let stale = !existsSync(archive);
  for (const src of spec.sources) {
    const abs = join(root, src);
    const obj = join(objDir, src.replace(/[\/]/g, "_").replace(/\.cpp$/, ".o"));
    objs.push(obj);
    if (!existsSync(obj) || statSync(obj).mtimeMs < statSync(abs).mtimeMs) {
      execFileSync("g++", [...CXXFLAGS, ...includeFlags(key), "-c", abs, "-o", obj], { stdio: "pipe" });
      stale = true;
    }
  }
  if (stale) execFileSync("ar", ["rcs", archive, ...objs], { stdio: "pipe" });
  return archive;
}

/**
 * Command. Compile one case's C++ driver. Returns the executable path.
 *
 * @param {object} c - the CASE object
 * @returns {string}
 */
function buildCase(c) {
  mkdirSync(BUILD, { recursive: true });
  const exe = join(BUILD, c.name.replace(/[^\w.-]/g, "_"));
  const cpp = join(HARNESS_ROOT, "cases", c.cpp);
  if (!existsSync(cpp)) throw new Error(`buildCase: ${c.name} names a missing driver ${cpp}`);
  const archive = buildRepoArchive(c.upstream);
  const extra = (c.extraSources ?? []).map((s) => join(repoPath(c.upstream), s));
  // THE PER-CASE ESCAPE HATCHES exist so a new family can be added by writing
  // ONE pair of files. `extraIncludes` and `extraSources` are relative to the
  // case's own upstream repo; `otherRepoIncludes` reaches a second checkout
  // (a plugin that needs the Rack SDK's headers, say). Without these, every
  // new family would have to edit upstream.mjs, and several contributors
  // adding families at once would collide there for no reason.
  const extraInc = (c.extraIncludes ?? []).flatMap((d) => ["-I", join(repoPath(c.upstream), d)]);
  const otherInc = (c.otherRepoIncludes ?? []).flatMap(([repo, d]) => ["-I", join(repoPath(repo), d)]);
  // A RACK SHIM IS PER FAMILY, NOT GLOBAL. Every plugin that is not Rack-free
  // needs a different slice of rack.hpp faked, and the fakes disagree — one
  // family wants `dsp::MinBlepGenerator`, another wants only `Module`'s port
  // arrays. Sharing one shim would make each family's additions a hazard to
  // the others', so each lives in `shim/<family>/` and is named by the case.
  const shimInc = (c.shimDirs ?? []).flatMap((d) => ["-I", join(SHIM, d)]);
  const args = [
    ...CXXFLAGS, ...(c.cxxflags ?? []),
    "-I", join(HARNESS_ROOT, "lib"), ...shimInc, "-I", SHIM, ...includeFlags(c.upstream), ...extraInc, ...otherInc,
    cpp, ...extra,
    ...(archive ? [archive] : []),
    "-lm", "-o", exe,
  ];
  execFileSync("g++", args, { stdio: "pipe" });
  return exe;
}

/**
 * Pure function. One channel's comparison row.
 *
 * @param {Float64Array} ours
 * @param {Float64Array} theirs
 * @param {object} analysis - `{kind, name, expectedHz}`; kind is wave|tone|impulse
 * @param {number} sampleRate
 * @param {number} skip - leading frames to drop (a filter's settling time)
 * @returns {object} the measurements for this channel
 */
function compareChannel(ours, theirs, analysis, sampleRate, skip) {
  const a = ours.subarray(skip);
  const b = theirs.subarray(skip);
  const row = {
    channel: analysis.name,
    kind: analysis.kind,
    maxAbsError: maxAbsError(a, b),
    rmsOurs: rms(a),
    rmsTheirs: rms(b),
    ncc: crossCorrelation(a, b),
  };
  if (analysis.kind === "tone") {
    // The FFT wants a power of two; take the largest that fits.
    let n = 1;
    while (n * 2 <= a.length) n *= 2;
    n = Math.min(n, 32768);
    row.f0Ours = estimateF0(a, sampleRate, n);
    row.f0Theirs = estimateF0(b, sampleRate, n);
    row.semitoneError = semitonesBetween(row.f0Ours, row.f0Theirs);
    if (analysis.expectedHz) row.semitonesFromExpected = semitonesBetween(row.f0Theirs, analysis.expectedHz);
    // BOTH harmonic profiles are measured against THEIR f0, so a mis-tuned
    // port's harmonics are still compared like-for-like instead of each side
    // being measured against its own (different) fundamental, which would
    // hide a wrong waveform behind a right-looking ratio table.
    const f = row.f0Theirs > 0 ? row.f0Theirs : row.f0Ours;
    row.harmonicsOurs = harmonicProfile(a, sampleRate, f, 8, n);
    row.harmonicsTheirs = harmonicProfile(b, sampleRate, f, 8, n);
    row.harmonicMaxDbError = harmonicDbGap(row.harmonicsOurs, row.harmonicsTheirs);
  }
  if (analysis.kind === "impulse") {
    const ro = lowpassCorner(impulseResponseDb(a, sampleRate));
    const rt = lowpassCorner(impulseResponseDb(b, sampleRate));
    row.cornerOurs = ro.cornerHz;
    row.cornerTheirs = rt.cornerHz;
    row.peakDbOurs = ro.peakDb;
    row.peakDbTheirs = rt.peakDb;
  }
  return row;
}

/**
 * Pure function. Largest per-harmonic level disagreement, in dB, over the
 * harmonics where EITHER side has audible energy.
 *
 * A harmonic both sides bury below -80 dB relative to the fundamental is not a
 * disagreement worth reporting; comparing those directly would produce huge dB
 * gaps between two inaudible numbers and drown the real ones.
 *
 * @param {number[]} ours - energy ratios
 * @param {number[]} theirs - energy ratios
 * @returns {number} dB; 0 when nothing is audible on either side
 *
 * @example harmonicDbGap([1, 0.25], [1, 0.25]) // 0
 * @example Math.round(harmonicDbGap([1, 0.25], [1, 0.0625])) // 6
 */
export function harmonicDbGap(ours, theirs) {
  const AUDIBLE_ENERGY = 1e-8; // -80 dB in energy terms
  let worst = 0;
  for (let i = 0; i < ours.length; i++) {
    if (ours[i] < AUDIBLE_ENERGY && theirs[i] < AUDIBLE_ENERGY) continue;
    const a = 10 * Math.log10(Math.max(ours[i], AUDIBLE_ENERGY));
    const b = 10 * Math.log10(Math.max(theirs[i], AUDIBLE_ENERGY));
    worst = Math.max(worst, Math.abs(a - b));
  }
  return worst;
}

/**
 * Command. Run one case end to end. Returns its result record; THROWS on a
 * harness failure (build error, missing checkout) so a broken harness can never
 * be mistaken for a failing node.
 *
 * @param {object} c - the CASE object
 * @returns {object} `{name, upstream, ours, channels: [...]}`
 */
export async function runCase(c) {
  mkdirSync(BUILD, { recursive: true });
  const stem = c.name.replace(/[^\w.-]/g, "_");
  const inPath = join(BUILD, `${stem}.in.f32`);
  const oursPath = join(BUILD, `${stem}.ours.f32`);
  const theirsPath = join(BUILD, `${stem}.theirs.f32`);
  const sampleRate = c.sampleRate ?? 48000;
  const frames = c.frames ?? sampleRate;

  const input = c.makeInput ? c.makeInput(frames, sampleRate) : new Float32Array(0);
  writeF32(inPath, input);

  const exe = buildCase(c);
  const argv = [inPath, theirsPath, String(frames), String(sampleRate), ...(c.args ?? []).map(String)];
  execFileSync(exe, argv, { stdio: ["ignore", "inherit", "inherit"] });

  const oursFlat = c.render(input, frames, sampleRate, c.args ?? []);
  writeF32(oursPath, oursFlat);

  const nCh = c.analysis.length;
  const theirsFlat = readF32(theirsPath);
  if (theirsFlat.length !== frames * nCh) {
    throw new Error(`${c.name}: upstream wrote ${theirsFlat.length} floats, expected ${frames * nCh}`);
  }
  if (oursFlat.length !== frames * nCh) {
    throw new Error(`${c.name}: our render returned ${oursFlat.length} floats, expected ${frames * nCh}`);
  }
  const ours = deinterleave(oursFlat, nCh);
  const theirs = deinterleave(theirsFlat, nCh);
  const skip = c.skipFrames ?? 0;
  return {
    name: c.name,
    upstream: `${c.upstream}@${REPOS[c.upstream].commit.slice(0, 7)}`,
    upstreamFiles: c.upstreamFiles ?? [],
    ours: c.oursRef,
    note: c.note ?? "",
    sampleRate,
    frames,
    channels: c.analysis.map((a, i) => compareChannel(ours[i], theirs[i], a, sampleRate, skip)),
  };
}

/**
 * Query. Load every case module in `cases/`, sorted by name.
 *
 * @param {string} [filter] - substring; only matching case names are loaded
 * @returns {Promise<object[]>}
 */
export async function loadCases(filter) {
  const dir = join(HARNESS_ROOT, "cases");
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".mjs")) continue;
    const mod = await import(pathToFileURL(join(dir, f)).href);
    for (const c of mod.CASES ?? (mod.CASE ? [mod.CASE] : [])) {
      if (filter && !c.name.includes(filter)) continue;
      out.push(c);
    }
  }
  return out;
}
