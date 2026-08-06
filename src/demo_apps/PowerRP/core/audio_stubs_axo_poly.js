/**
 * PLACEHOLDER NODES for Axoloti — the polyphonic voices.
 *
 * The companion to `core/audio_patches_axo_poly.js`: every node those patches name that
 * the library does not yet implement. **Read `core/audio_stub_nodes.js`'s header before
 * adding a row** — it defines the declaration shape, why a placeholder carries the FINAL
 * type and port names, and the three ways a placeholder is made LOUD.
 *
 * OVERLAP WITH OTHER SETS IS EXPECTED AND IS A FEATURE. A module used by eight patches is
 * declared by every set that needs it, and `stubRegistry` THROWS if two declarations of
 * one type disagree about its ports — so two agents reading the same C++ port enum are
 * checked against each other. Do not "helpfully" omit a row because you think another set
 * already has it; that removes the check.
 *
 * DELETE A ROW THE DAY ITS REAL NODE LANDS. `tests/audio_stub_test.js` fails if a type is
 * both a placeholder and a real spec.
 *
 * ── PORT KEYS: THE AXOLOTI SPELLING, MECHANICALLY LOWERCASED ─────────────────
 * Axoloti has no `enum InputIds`; its inlets and outlets carry NAMES, and a name may
 * contain a space (`triphase_vlfo`'s outlets are literally `phi 0`, `phi 120`, `phi 240`;
 * `vcaST`'s are `o1`/`o2`). The rule R7-17-SEL fixes for VCV applies unchanged — lowercase,
 * non-alphanumerics to `_` — so `phi 120` is `phi_120` and `L` is `l`. Their own code
 * generator spells that outlet `phi_space_120`; that is an artefact of C identifier
 * escaping, not the port's name, and it is not reproduced. **snake_case is also forced**:
 * a port key is published as an output property and `core/expressions.js`'s
 * checkCanonicalPath cannot spell a camelCase one (AX-1's `chain_row` note records the
 * incident), which is why `releaseVelocity` is declared `release_velocity`.
 *
 * ── A `bool32` INLET IS `audio`; ONLY `bool32.rising` IS `trigger` ───────────
 * Read off the shipped block rather than invented: `audio_ax_logic`'s boolean operands are
 * `audio`, `audio_ax_steps_bool`'s step index is `audio`, and the only `trigger` inlets in
 * AX-1/2/3 are the ones whose sources are `bool32.rising` or `bool32.pulse`
 * (`axCounter.trig`, `axLfo.reset`, `axLfsrSeq.trig`, `axRand.trig`, `axLatch.trig`,
 * `axPulseDecay.trig`). So `env/adsr`'s and `env/ahd m`'s gate — `bool32.risingfalling`,
 * a LEVEL the envelope reads every tick to decide attack-vs-release — is `audio` here,
 * while `env/d`'s `bool32.rising` trig is `trigger`. Getting this backwards is not
 * cosmetic: `core/nodeflow.js` refuses `audio → trigger` on purpose, so a gate typed
 * `trigger` would force a Schmitt in front of every envelope and turn a held note into a
 * 5 ms plink.
 *
 * ── AND THE TWO ROWS THAT ARE A DESIGN DECISION, NOT A TRANSCRIPTION ─────────
 * `audio_ax_keyb` and `audio_ax_poly_voices` stand in for `midi/in/keyb` and
 * `patch/patcher poly=N`. Their ports are argued in `core/audio_patches_axo_poly.js`'s
 * POLYPHONY section, which is where the reasoning belongs because it is a property of the
 * patches, not of the declaration. Read it before changing either row.
 */

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [
  // ── AX-1 — the two nodes polyphony needs, and neither exists ──────────────
  {
    type: "audio_ax_keyb", title: "AX Keyboard", family: "modulation",
    source: "midi/in/keyb, midi/in/keyb zone lru", block: "AX-1", corpus: "axoloti",
    // pitch/gate IN is the ADAPTOR half: PowerRP has no MIDI, so an on-canvas Keyboard
    // node drives this, and this is where HERTZ becomes Axoloti's note units. See the
    // patch file's UNITS section — a Hz value landing on a semitone port is a silent
    // forty-octave transposition, which is why the conversion is given a home rather
    // than left to whoever wires it.
    inputs: [["pitch", "number"], ["gate", "trigger"]],
    outputs: [
      ["note", "number"], ["gate", "trigger"], ["gate2", "trigger"],
      ["velocity", "number"], ["release_velocity", "number"],
    ],
    // THE ZONE IS IN THE `note` OUTLET'S OWN UNITS — semitones from E4, i.e. MIDI - 64 —
    // not MIDI numbers. Two reasons and they agree: the outlet is documented "midi note
    // number (-64..63)", and a frac32 dial cannot hold 127 anyway (STUB_RANGES caps at
    // +/-64). So `keyb zone lru`'s 0..50 is -64..-14 and its 63..127 is -1..63.
    knobs: [["start_note", -64], ["end_note", 63]],
  },
  {
    type: "audio_ax_poly_voices", title: "AX Poly Voices", family: "modulation",
    source: "patch/patcher (attribute poly=N)", block: "AX-1", corpus: "axoloti",
    inputs: [
      ["note", "number"], ["gate", "trigger"], ["gate2", "trigger"],
      ["velocity", "number"], ["release_velocity", "number"],
    ],
    outputs: [
      ["note", "number"], ["gate", "trigger"], ["gate2", "trigger"],
      ["velocity", "number"], ["release_velocity", "number"],
    ],
    knobs: [["voices", 7]],
  },

  // ── AX-4 — envelopes and the stereo VCA ───────────────────────────────────
  // Their FOUR-segment and TWO-segment envelopes are separate objects with different
  // param sets, so they are separate placeholders even though AX-4's registry row
  // (`env/segments`) collapses all ten into one node with a mode. A stub knob is always
  // NUMERIC (stubSpec gives every knob the corpus range), so a `mode` selector is not
  // expressible here — one type per shape is the honest scaffold, and the real node
  // replaces all three at once.
  {
    type: "audio_ax_env_adsr", title: "AX ADSR", family: "modulation",
    source: "env/adsr", block: "AX-4", corpus: "axoloti",
    inputs: [["gate", "audio"]],
    outputs: [["env", "audio"]],
    knobs: [["a", 0], ["d", 0], ["s", 0], ["r", 0]],
  },
  {
    type: "audio_ax_env_ahd", title: "AX AHD Envelope", family: "modulation",
    source: "env/ahd m", block: "AX-4", corpus: "axoloti",
    inputs: [["a", "number"], ["d", "number"], ["gate", "audio"]],
    outputs: [["env", "audio"]],
    knobs: [["a", 30], ["d", 56]],
  },
  {
    type: "audio_ax_env_decay", title: "AX Decay Envelope", family: "modulation",
    source: "env/d", block: "AX-4", corpus: "axoloti",
    inputs: [["trig", "trigger"]],
    outputs: [["env", "audio"]],
    knobs: [["d", 0]],
  },
  {
    // `sss/gain/vcaST` is ONE gain over TWO channels — not two VCAs. That single control
    // is the point: it cannot drift between L and R, which is what keeps a stereo pair
    // in the middle. Tranquille uses two of them as its whole amplitude stage.
    type: "audio_ax_vca_stereo", title: "AX Stereo VCA", family: "modulation",
    source: "sss/gain/vcaST", block: "AX-4", corpus: "axoloti",
    inputs: [["a1", "audio"], ["a2", "audio"], ["v", "number"]],
    outputs: [["o1", "audio"], ["o2", "audio"]],
    knobs: [],
  },

  // ── AX-5 — the chorus, which is a SUBPATCH in the source ──────────────────
  {
    // `fx/chorus.axs` is an .axs (a subpatch), not an .axo: two `delay/read interp` taps
    // 180 degrees apart off one `delay/write`, an `lfo/sine` and two `conv/interp` ramps.
    // Its two promoted params are `depth` (a `ctrl/dial p`) and `speed` (the LFO's pitch,
    // in LFO dial units, so -33 is 0.79 Hz). Placeholdered rather than assembled from
    // primitives because the primitives are AX-5's too, and six placeholders in a trench
    // coat is not more honest than one.
    type: "audio_ax_chorus", title: "AX Chorus", family: "effect",
    source: "fx/chorus.axs", block: "AX-5", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["l", "audio"], ["r", "audio"]],
    knobs: [["depth", 3], ["speed", -33]],
  },

  // ── AX-8 — the tiar wf16 wavetable family ─────────────────────────────────
  // THE `wf16` PORT CARRIES A WAVETABLE, NOT AUDIO, and the patch's own author shouted
  // about it: "<— These are wf_16 waveforms, not audio !!!". On hardware both are a
  // `frac32buffer`; the buffer just holds 32 int16 harmonic amplitudes instead of 16
  // samples. `core/nodeflow.js`'s type table has no wavetable type and inventing one is
  // outside this file's ownership, so it is declared `audio` — the widest honest choice,
  // since it IS a buffer of numbers — and reported to the lead as the one place these
  // patches want a fifth port type. A wf16 port wired to a speaker would be noise.
  {
    type: "audio_ax_16steps_dp2", title: "AX Wavetable Osc", family: "source",
    source: "tiar/osc/wf16/16StepsDP2", block: "AX-8", corpus: "axoloti",
    inputs: [["pitch", "number"], ["wf16", "audio"], ["update", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [["pitch", 0]],
  },
  {
    type: "audio_ax_wf16_bank_spktra", title: "AX Spectral Wavetable Bank", family: "source",
    source: "tiar/osc/wf16/wf_16BankSpktra", block: "AX-8", corpus: "axoloti",
    inputs: [["select", "number"]],
    outputs: [["waveform", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_wf16_bank_pwr", title: "AX Power-Law Wavetable Bank", family: "source",
    source: "tiar/osc/wf16/wf_16BankPwr", block: "AX-8", corpus: "axoloti",
    inputs: [["select", "number"]],
    outputs: [["waveform", "audio"]],
    knobs: [],
  },

  // ── AX-9 — the tri-phase very-low-frequency LFO ───────────────────────────
  {
    // Three sines 120 degrees apart from ONE phase accumulator, so the three outputs
    // cannot drift relative to each other — that fixed relationship is what makes a
    // three-way crossfade sum to a constant, which is exactly what Tranquille uses it
    // for. `cycle` IS SECONDS: measured from the body, `dp = 5592*(2^31-1)/param_cycle`
    // with `p += dp>>2` at 3000 Hz gives a period of 1.0001 * dial seconds, so the dial
    // reads directly in seconds up to 64 (their own sDescription says so, and the
    // arithmetic agrees).
    type: "audio_ax_triphase_vlfo", title: "AX Tri-Phase LFO", family: "modulation",
    source: "tiar/lfo/triphase_vlfo", block: "AX-9", corpus: "axoloti",
    inputs: [],
    outputs: [["phi_0", "audio"], ["phi_120", "audio"], ["phi_240", "audio"]],
    knobs: [["cycle", 8]],
  },
];
