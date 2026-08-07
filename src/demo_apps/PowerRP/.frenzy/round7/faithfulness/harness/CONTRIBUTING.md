# Adding a family to the A/B harness

Read `cases/bogaudio_osc.cpp` + `cases/bogaudio_osc.mjs` first. They are the
worked example and they are short.

## The contract

A case is a PAIR of files in `cases/`:

- `<family>.cpp` — the UPSTREAM driver. Compiled against the real cloned C++.
  argv is `<in.f32> <out.f32> <frames> <sampleRate> [case args...]`.
  Reads the interleaved float32 input file, writes an interleaved float32
  output file with one channel per entry in the case's `analysis` array.
- `<family>.mjs` — exports `CASES` (an array) or `CASE`. Each entry:

```js
{
  name: "bogaudio.BandLimitedSaw@261.6256Hz", // unique; becomes the table row
  upstream: "bogaudio",          // a key of REPOS in lib/upstream.mjs
  upstreamFiles: ["src/dsp/oscillator.cpp"],  // for the report
  oursRef: "synth/vc3b_kernels.js",
  cpp: "bogaudio_osc.cpp",
  sampleRate: 48000,
  frames: 48000,
  skipFrames: 256,               // leading frames dropped before measuring
  args: [1, 261.6256, 0.5],      // appended to BOTH sides' argv
  makeInput: (frames, sr) => Float32Array,   // optional; shared by both sides
  render: (input, frames, sr, args) => Float32Array,  // OUR side, interleaved
  analysis: [{ kind: "tone", name: "saw", expectedHz: 261.6256 }],
}
```

`analysis[i].kind` is one of:

- `wave` — max abs error, RMS, zero-lag NCC. Use for anything not pitched.
- `tone` — adds f0 for both sides, the semitone gap, and 8 harmonic levels.
- `impulse` — adds the −3 dB corner and the resonant peak. **LTI ONLY**: the
  driver must hold every filter parameter fixed and feed a unit impulse.

Escape hatches so you never have to edit a shared file:

- `extraSources: ["src/foo.cpp"]` — extra upstream .cpp compiled into the case
- `extraIncludes: ["src/dsp"]` — extra `-I` inside your upstream repo
- `otherRepoIncludes: [["rack", "include"]]` — `-I` into a second checkout
- `shimDirs: ["countmodula"]` — `-I harness/shim/countmodula`, YOUR OWN shim
- `cxxflags: ["-DFOO"]`

## Run it

```
bash harness/setup_upstream.sh              # once; clones into /tmp/vcvsrc
node harness/run.mjs --filter=<yourFamily>  # iterate
node harness/diagnose.mjs "<case name>"     # when a case disagrees
```

## The two rules that matter

**1. A DIFFERENCE IS A HARNESS BUG UNTIL YOU HAVE RULED THAT OUT.** The very
first run of this harness reported five FAILs on Bogaudio's band-limited
oscillators. All five were mine: `BandLimitedSawOscillator(sr, f, 12)`
initialises `_quality` to 12 and then calls `setQuality(12)`, which early-returns
because the value did not change — so `_update()` never ran, `_qd` stayed 0, and
I was comparing our BLEP saw against an uncorrected ramp. Drive the upstream
class the way the MODULE drives it, not the way its constructor invites you to.
`diagnose.mjs` prints the worst samples and tests for a whole-sample shift,
which is the other common false alarm.

**2. A SHIM MAY NOT INVENT BEHAVIOUR.** Faking `APP->engine->getSampleRate()`
as a constant is fine — that is what it returns. Faking a `dsp::` helper by
writing your own version of its algorithm is NOT: you would be comparing our
transcription against your transcription, and a match would mean nothing. If a
kernel drags in a Rack helper you cannot compile, either compile the real
header from the `rack` checkout or SKIP THE CASE and say why in your report.
