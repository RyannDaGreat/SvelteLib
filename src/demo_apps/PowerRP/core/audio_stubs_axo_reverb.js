/**
 * PLACEHOLDER NODES for Axoloti — the hand-built reverbs and the flagship pads.
 *
 * The companion to `core/audio_patches_axo_reverb.js`: every node those patches name that
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
 * ── PORT KEYS ARE THE AXOLOTI OBJECT'S OWN INLET/OUTLET NAMES ───────────────
 * Read out of the `.axo` XML at the two refs `.frenzy/round7/survey_axoloti.md` § 0.1
 * pins (contrib @ 1.0.12 `798166f`, factory @ `78cb74b`), lowercased, with multi-word
 * names in snake_case — `fbMod` → `fb_mod`, `releaseVelocity` → `release_velocity`,
 * `phi 0` → `phi_0`. Snake rather than camel because the shipped AX specs already spell a
 * multi-word port that way (`chain_row` on `audio_ax_steps_multi`).
 *
 * ── AN AXOLOTI **ATTRIBUTE** IS NOT DECLARED AS A KNOB, AND THAT IS FORCED ──
 * `tiar/fx/pitchX3`'s window (8192 samples), `tiar/delay/over1tap`'s buffer (16384) and
 * `delay/write sdram`'s size (32768) are `<attribs>` — construct-time combo boxes, not
 * dials. They are also far outside `STUB_RANGES.axoloti` (±64), so declaring one as a
 * knob would make `tests/audio_patches_test.js`'s range sweep red. The harvested values
 * are therefore recorded in the using patch's `deviations` and, where a window length is
 * load-bearing, spent as a real `audio_delay` time — see the FEEDBACK note in
 * `core/audio_patches_axo_reverb.js`.
 */

/**
 * A generated `[key, "audio"]` port list — `in0…inN` / `out0…outN` for the two FDN
 * matrices, whose only difference is their order.
 *
 * Pure function.
 *
 * @param {string} prefix - the port name's stem, e.g. "in"
 * @param {number} count - how many ports
 * @returns {Array<[string, string]>} declaration pairs in port order
 *
 * @example matrixPorts("in", 2) // [["in0", "audio"], ["in1", "audio"]]
 * @example matrixPorts("out", 4).map(([k]) => k) // ["out0", "out1", "out2", "out3"]
 */
const matrixPorts = (prefix, count) =>
  Array.from({ length: count }, (unused, i) => [`${prefix}${i}`, "audio"]);

/** The three phases every `tiar/lfo/triphase_*` publishes, 120° apart. */
const TRIPHASE_OUTPUTS = [["phi_0", "audio"], ["phi_120", "audio"], ["phi_240", "audio"]];

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [
  // ── AX-1 — the MIDI note surface and the voice allocator ──────────────────
  // WHY THE KEYBOARD IS A PLACEHOLDER AND NOT `node_keyboard`: the two are different
  // things. `node_keyboard` is a LIVE control widget (core/control_nodes.js: a press has
  // no representation in [[slide, alpha]], so it is silent in a render). `midi/in/keyb`
  // is the note surface a VOICE reads — inside a poly patcher it reports the note that
  // voice was assigned. A patch that used the widget would be a patch you can only play
  // by hand, which is not what these three decks are.
  //
  // ⚠ THE PORT LIST OF THIS ROW AND THE NEXT IS **YIELDED**, NOT CHOSEN. Both were first
  // declared by the `axo_poly` set for A1/A9/C4 (aggregation order puts it before this
  // one), and BRIEF.md's precedence rule is that where two patterns compete and the
  // manifest is silent, the OLDER wins. So this set matches theirs exactly rather than
  // leaving `tests/audio_stub_test.js`'s port-agreement law red over a difference this
  // set can absorb.
  //
  // WHAT IT COSTS, AND WHAT THE LEAD SHOULD DECIDE: neither list carries `touch`, and
  // `midi/in/keyb touch` — the object C3 and C7 actually use — HAS a `touch` outlet, as
  // does an MPE voice inside a poly patcher. `.frenzy/round7/NODE_REGISTRY.md`'s
  // `midi/keyb` row absorbs BOTH objects, so the correct FINAL surface is this list plus
  // `["touch", "audio"]`, and AX-1 should build it that way. Until it does, C3 and C7 take
  // their pressure from `audio_ax_midi_touch` (channel pressure) instead of per-note
  // touch, recorded in both patches' `deviations`.
  {
    type: "audio_ax_keyb",
    title: "AX MIDI Keyboard", family: "modulation",
    source: "midi/in/keyb, midi/in/keyb touch", block: "AX-1", corpus: "axoloti",
    inputs: [["pitch", "number"], ["gate", "trigger"]],
    outputs: [
      ["note", "number"], ["gate", "trigger"], ["gate2", "trigger"],
      ["velocity", "number"], ["release_velocity", "number"],
    ],
    knobs: [],
  },
  // THE VOICE ALLOCATOR. `patch/patcher poly=N` instantiates a subpatch N times and
  // hands each instance one held note; PowerRP has no subgraph-instantiation construct,
  // so this node is the ALLOCATION half of it and the voice graph is drawn ONCE beside
  // it as the template. See the POLYPHONY note in core/audio_patches_axo_reverb.js for
  // the full ruling and what it costs.
  {
    type: "audio_ax_poly_voices",
    title: "AX Poly Voices", family: "modulation",
    source: "patch/patcher (poly=N)", block: "AX-1", corpus: "axoloti",
    inputs: [
      ["note", "number"], ["gate", "trigger"], ["gate2", "trigger"],
      ["velocity", "number"], ["release_velocity", "number"],
    ],
    outputs: [
      ["note", "number"], ["gate", "trigger"], ["gate2", "trigger"],
      ["velocity", "number"], ["release_velocity", "number"],
    ],
    knobs: [["voices", 5]],
  },
  {
    type: "audio_ax_midi_touch",
    title: "AX Channel Pressure", family: "modulation",
    source: "midi/in/touch", block: "AX-1", corpus: "axoloti",
    inputs: [],
    outputs: [["o", "audio"], ["trig", "trigger"]],
    knobs: [],
  },

  // ── AX-4 — the crossfader and the two phase-distortion clippers ───────────
  {
    type: "audio_ax_xfade",
    title: "AX Crossfade", family: "modulation",
    source: "mix/xfade", block: "AX-4", corpus: "axoloti",
    // `c` IS `number`, YIELDED to the `axo_machine` set's reading of the same object rather
    // than left as a red port disagreement. Both are defensible — his `mix/xfade` has a
    // frac32 and a frac32buffer overload, resolved by connected type — and `number` is the
    // more idiomatic of the two here (a control beside two audio signals, as `audio_delay`
    // spells `time`). C7 drives it from `math/sat` at audio rate, which the audio->number
    // coercion accepts, so nothing about this patch changes.
    inputs: [["i1", "audio"], ["i2", "audio"], ["c", "number"]],
    outputs: [["o", "audio"]],
    knobs: [],
  },
  // TWO TYPES, NOT ONE WITH A MODE KNOB. `.frenzy/round7/NODE_REGISTRY.md`'s `dist/dp-clip`
  // row collapses both into one node, and that is right for the real port — but a
  // placeholder's knobs are NUMBERS on the corpus rail (`stubSpec` gives every knob
  // `STUB_RANGES[corpus]`), so a discrete soft/hard row is not expressible here. Two rows
  // keep C3's soft clipper and C7's hard clipper distinguishable today, and collapse into
  // one type plus a mode knob when AX-4 lands.
  {
    type: "audio_ax_dpsoftclip",
    title: "AX DP Soft Clip", family: "effect",
    source: "tiar/dist/DPSoftClip", block: "AX-4", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [["ingain", 64], ["outgain", 32]],
  },
  {
    type: "audio_ax_dphardclip",
    title: "AX DP Hard Clip", family: "effect",
    source: "tiar/dist/DPHardClip", block: "AX-4", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [["ingain", 11], ["outgain", 28]],
  },

  // ── AX-5 — the stereo chorus (a factory SUBPATCH, `fx/chorus.axs`) ────────
  // Its two outlets are the same delay line read 180° apart, which is why it is a
  // chorus rather than a vibrato and why both must survive as separate ports.
  {
    type: "audio_ax_chorus",
    title: "AX Chorus", family: "effect",
    source: "fx/chorus", block: "AX-5", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["l", "audio"], ["r", "audio"]],
    knobs: [["depth", 6.5], ["speed", -64]],
  },

  // ── AX-8 — the tiar phase-distortion / segment oscillators ────────────────
  {
    type: "audio_ax_selfpm",
    title: "AX Self Phase Mod", family: "source",
    source: "tiar/osc/PM/SelfPM", block: "AX-8", corpus: "axoloti",
    inputs: [["pitch", "number"], ["fb_mod", "audio"]],
    outputs: [["wave", "audio"]],
    knobs: [["pitch", 0], ["fb1", 50], ["fb0", 15]],
  },
  // SIX SEGMENT LEVELS AND THREE RESONANCES, every one of them an INLET as well as being
  // derivable — which is the whole reason C3 can make its waveform a moving target.
  {
    type: "audio_ax_6coseg",
    title: "AX 6-Cosine Segment Osc", family: "source",
    source: "tiar/osc/6coseg m", block: "AX-8", corpus: "axoloti",
    inputs: [
      ["pitch", "number"], ["r0", "audio"], ["r1", "audio"], ["r2", "audio"],
      ["l0", "audio"], ["l1", "audio"], ["l2", "audio"],
      ["l3", "audio"], ["l4", "audio"], ["l5", "audio"],
    ],
    outputs: [["wave", "audio"]],
    knobs: [["pitch", 0]],
  },
  {
    type: "audio_ax_dp2saw",
    title: "AX DP2 Saw", family: "source",
    source: "tiar/osc/DP2Saw", block: "AX-8", corpus: "axoloti",
    inputs: [["pitch", "number"]],
    outputs: [["wave", "audio"]],
    knobs: [["pitch", 0]],
  },

  // ── AX-9 — the FDN matrices, the pitch shifters, the tri-phase LFO ────────
  // D6 AND H4 ARE PURE MATRICES. Both are a single `code.srate` block with NO state and
  // NO delay line (measured: `objects/tiar/FDN/D6.axo` is eighteen adds and six
  // multiplies by 1/sqrt(5)). Every delay in a Shimmer tank is therefore in the LEG, not
  // in the matrix — which is exactly why that patch needs the feedback treatment its
  // blueprint documents.
  {
    type: "audio_ax_fdn_d6",
    title: "AX FDN Matrix D6", family: "effect",
    source: "tiar/FDN/D6", block: "AX-9", corpus: "axoloti",
    inputs: matrixPorts("in", 6),
    outputs: matrixPorts("out", 6),
    knobs: [],
  },
  {
    type: "audio_ax_fdn_h4",
    title: "AX FDN Matrix H4", family: "effect",
    source: "tiar/FDN/H4", block: "AX-9", corpus: "axoloti",
    inputs: matrixPorts("in", 4),
    outputs: matrixPorts("out", 4),
    knobs: [],
  },
  // THE TWO SHIFTERS HAVE NO PARAMETERS AT ALL — their ratio is baked in (x3 and one
  // octave) and their only setting is the `size` ATTRIBUTE, which is not a knob. So a
  // placeholder for either is one input and one output, and that is the whole surface.
  {
    type: "audio_ax_pitchx3",
    title: "AX Pitch x3", family: "effect",
    source: "tiar/fx/pitchX3", block: "AX-9", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_pitchoct",
    title: "AX Pitch Octave", family: "effect",
    source: "tiar/fx/pitchoct", block: "AX-9", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [],
  },
  // ONE NODE FOR ALL THREE `triphase_*` OBJECTS, and `cycle` (seconds) is the rate control
  // rather than a pitch dial. `triphase_vlfo` already spells its rate that way; the
  // `_lfou` variant spells the same rate as an `lfopitch` dial, and the two are one
  // conversion apart (`.frenzy/round7/survey_axoloti.md` § 0.5). Seconds is the honest
  // unit for a modulator whose whole purpose is a sixteen-second rotation — a dial of
  // −52.4 tells a reader nothing.
  {
    type: "audio_ax_triphase_lfo",
    title: "AX Tri-Phase LFO", family: "modulation",
    source: "tiar/lfo/triphase_lfou, tiar/lfo/triphase_vlfo", block: "AX-9", corpus: "axoloti",
    inputs: [],
    outputs: TRIPHASE_OUTPUTS,
    knobs: [["cycle", 16]],
  },
  // THE ALLPASS NOODLE. `x` in, `y` out, and the `u`/`v` pair is an EXTERNAL loop the
  // patch closes through its own delay line and diffusers — which is what makes it a
  // reverb kernel rather than an effect.
  {
    type: "audio_ax_apnoodle",
    title: "AX Allpass Noodle", family: "effect",
    source: "tiar/fx/APNoodle", block: "AX-9", corpus: "axoloti",
    inputs: [["x", "audio"], ["v", "audio"]],
    // `y_out`, NOT `y` — an output PUBLISHES a property of its own name, and every item
    // already stores `y`: its position. `tests/output_properties_test.js` catches the
    // shadow. VC-1 hit the identical defect on Marbles' Y_OUTPUT and settled on this
    // spelling, which keeps the source enum's letter while the card's label still reads
    // "y"; matching it here rather than inventing a second disambiguation.
    outputs: [["y_out", "audio"], ["u", "audio"]],
    knobs: [["g", 41.68]],
  },
];
