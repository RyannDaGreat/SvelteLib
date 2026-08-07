/**
 * THE UPSTREAM SOURCE REGISTRY — which repo, pinned at which commit, and what a
 * case must compile and include to use its DSP.
 *
 * The commits here are NOT chosen by this harness. Every one is copied from the
 * `_SOURCE` constant or derivation record in the spec that claims the port, so
 * a mismatch between this table and the specs is itself a finding. `verify.mjs`
 * greps the specs and fails if any commit here is not the one they name.
 *
 * Checkouts live OUTSIDE the repo, under UPSTREAM_ROOT, and are never committed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where `setup_upstream.sh` puts the clones. Outside the dump, deliberately. */
export const UPSTREAM_ROOT = "/tmp/vcvsrc";

/**
 * The repos, their pinned commits, and the include/compile recipe a case needs.
 *
 * `sources` are glob-free explicit relative paths (a glob would silently drop a
 * file that upstream renamed); `includes` are added with -I in order.
 */
export const REPOS = Object.freeze({
  bogaudio: {
    url: "https://github.com/bogaudio/BogaudioModules",
    commit: "656eaae458e045602dc974bae82e15a11e104958",
    citedBy: "core/audio_specs_vc3b.js BOGAUDIO_SOURCE",
    // Their own Makefile's `-Isrc -Isrc/dsp -Ilib`; `lib` is the vendored ffft
    // that dsp/analyzer.hpp includes, and table.cpp reaches analyzer.hpp for
    // its Hamming window.
    includes: ["src", "src/dsp", "lib"],
    sources: [
      "src/dsp/math.cpp", "src/dsp/table.cpp", "src/dsp/noise.cpp",
      "src/dsp/oscillator.cpp", "src/dsp/signal.cpp", "src/dsp/envelope.cpp",
      "src/dsp/analyzer.cpp",
      "src/dsp/filters/filter.cpp", "src/dsp/filters/multimode.cpp",
      "src/dsp/filters/equalizer.cpp", "src/dsp/filters/utility.cpp",
      "src/dsp/filters/resample.cpp", "src/dsp/filters/experiments.cpp",
    ],
  },
  countmodula: {
    url: "https://github.com/countmodula/VCVRackPlugins",
    commit: "30b3c6c46fc0589f5e0ece7ad79abbe0293e70fd",
    citedBy: "core/audio_specs_vc7a.js COUNTMODULA_SOURCE",
    // Their DSP headers live in src/inc and pull in rack::dsp; the shim supplies it.
    includes: ["src", "src/inc", "SHIM"],
    sources: [],
  },
  impromptu: {
    url: "https://github.com/MarcBoule/ImpromptuModular",
    commit: "cf87c918875e502043cabe3deaa2e52adda7cecd",
    citedBy: "core/audio_specs_vc7a.js IMPROMPTU_SOURCE",
    includes: ["src", "SHIM"],
    sources: [],
  },
  squinky: {
    url: "https://github.com/squinkylabs/SquinkyVCV-main",
    commit: "8b0411e2d1b5a11ffa11280cca00253813212dc7",
    citedBy: "core/audio_specs_vc10.js SQUINKY_SOURCE",
    includes: ["dsp/generators", "dsp/utils", "dsp/filters", "dsp/third-party/falco", "dsp/fft", "SHIM"],
    sources: [],
  },
  mutable: {
    // Mutable's own firmware source. AudibleInstruments is a thin Rack wrapper
    // around exactly this code, so the DSP under test is here and it is
    // Rack-free by construction (it runs on an STM32).
    url: "https://github.com/pichenettes/eurorack",
    commit: "HEAD",
    citedBy: "synth/vc1_kernels.js (github.com/VCVRack/pichenettes-eurorack)",
    includes: [".", "SHIM"],
    sources: [],
  },
  audible: {
    url: "https://github.com/VCVRack/AudibleInstruments",
    commit: "HEAD",
    citedBy: "core/audio_specs_vc1.js (Audible Instruments wrappers)",
    includes: ["src", "SHIM"],
    sources: [],
  },
  befaco: {
    url: "https://github.com/VCVRack/Befaco",
    commit: "HEAD",
    citedBy: "not pinned by any spec",
    includes: ["src", "SHIM"],
    sources: [],
  },
  fundamental: {
    url: "https://github.com/VCVRack/Fundamental",
    commit: "10dd0160c664770910e5584b7b00498cc48d9ddd",
    citedBy: "core/audio_specs_vc2.js",
    includes: ["src", "SHIM"],
    sources: [],
  },
  rack: {
    // NOT a plugin — the Rack SDK itself, whose dsp/ headers several plugins'
    // kernels lean on (MinBlepGenerator, the SchmittTrigger, the filters).
    // Included as a repo so a case can compile against the REAL helper rather
    // than a shim of it, wherever the header stands alone.
    url: "https://github.com/VCVRack/Rack",
    commit: "061ccf63c1758599396ac1bb10d47345d9d34076",
    citedBy: "synth/vc2_kernels.js",
    includes: ["include", "SHIM"],
    sources: [],
  },
  valley: {
    url: "https://github.com/ValleyAudio/ValleyRackFree",
    commit: "HEAD",
    citedBy: "core/audio_specs_vc5.js (behaviour-derived, NOT source-derived)",
    includes: ["src", "SHIM"],
    sources: [],
  },
  // ── THE AXOLOTI TRIO ──────────────────────────────────────────────────────
  // Not VCV at all. The AX-* blocks are ported from Axoloti objects, which are
  // XML files carrying LITERAL C in <code.declaration>/<code.init>/<code.krate>/
  // <code.srate>. Extracting those blocks and compiling them is a stronger test
  // than anything in the VCV half of this harness, because Axoloti's DSP is
  // FIXED POINT: an int32 recurrence either reproduces bit for bit or it does
  // not, with no float round-off to hide behind.
  axofactory: {
    url: "https://github.com/axoloti/axoloti-factory",
    commit: "78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    citedBy: "core/audio_specs_ax1.js FACTORY",
    includes: ["objects", "SHIM"],
    sources: [],
  },
  axocontrib: {
    url: "https://github.com/axoloti/axoloti-contrib",
    commit: "798166f0ce29f4b6a39099b3bde6ef2e7755a7c4",
    citedBy: "core/audio_specs_ax1.js CONTRIB (tag 1.0.12)",
    includes: ["objects", "SHIM"],
    sources: [],
  },
  axoloti: {
    // The runtime the code blocks are written against: axoloti_math.h's
    // fixed-point helpers, the pitch/parameter tables, BUFSIZE.
    url: "https://github.com/axoloti/axoloti",
    commit: "46f6e4b383ce182da9dcca25b9d4b544fe20f990",
    citedBy: "core/audio_specs_ax1.js (the codegen and firmware reference)",
    includes: ["api", "firmware", "SHIM"],
    sources: [],
  },
});

/**
 * Query. Absolute path to a cloned repo, throwing if `setup_upstream.sh` has
 * not been run — an absent checkout must not be reported as a failing node.
 *
 * @param {string} key - a key of REPOS
 * @returns {string}
 *
 * @example repoPath("bogaudio") // "/tmp/vcvsrc/bogaudio"
 */
export function repoPath(key) {
  if (!REPOS[key]) throw new Error(`repoPath: unknown upstream repo ${JSON.stringify(key)}`);
  const p = join(UPSTREAM_ROOT, key);
  if (!existsSync(p)) throw new Error(`repoPath: ${p} is missing — run harness/setup_upstream.sh`);
  return p;
}
