/**
 * PLACEHOLDER NODES for Axoloti — the drum machine and the Mutable stack.
 *
 * The companion to `core/audio_patches_axo_machine.js`: every node those patches name that
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
 * ── WHERE THE PORT NAMES CAME FROM ──────────────────────────────────────────
 * Each row's `source` is an Axoloti object file, and its `inputs`/`outputs` are that
 * file's own `<inlets>` / `<outlets>` element names — read out of the XML at
 * axoloti-factory `78cb74bd` and axoloti-contrib `1.0.12`, not from the survey's prose.
 * The one normalisation applied is the port-key rule (lowercase, non-alphanumerics to
 * `_`), which is why `releaseVelocity` is `releasevelocity` and `InGain` is `ingain`.
 *
 * PORT TYPES follow core/audio_specs.js's law — the type says what is TRUE, so the wire
 * refuses what the engine could not do. Applied to Axoloti's inlet types:
 * `frac32buffer` → `audio`, `frac32` (a k-rate control value) → `number`,
 * `bool32.rising` / `bool32.risingfalling` (an EDGE) → `trigger`, and every outlet is
 * `audio` because a module output is a signal (the same call core/audio_specs.js makes
 * about the sequencer's `pitch`). The one consequence worth knowing before you wire one
 * of these: an Axoloti gate is a `trigger` here, and there is NO audio→trigger coercion,
 * so a logic node's output reaches an envelope's gate through an `audio_trigger`. That is
 * deliberate (core/nodeflow.COERCIONS) and the patches do it explicitly.
 *
 * ── TYPE NAMES ARE DERIVED FROM `.frenzy/round7/NODE_REGISTRY.md`, NOT INVENTED ──
 * The registry is the published plan for WHICH nodes will exist and which block owes each
 * one, so a placeholder's type name is its registry row's own noun under the fixed
 * `audio_ax_<name>` prefix — the rule the shipped AX-1/2/3 specs already follow
 * (`math/op` → `audio_ax_math`, `sel/steps-bool` → `audio_ax_steps_bool`, `mux/mux` →
 * `audio_ax_mux`). Where one registry row covers several source objects, the split here
 * is decided by ONE mechanical question — can a single node express them?
 *
 *   A WIDTH FAMILY IS ONE NODE AT THE WIDEST WIDTH. `mix/mix 1 … 6` and their `g`
 *   variants differ in how many inlets they have and in whether the gain dial shows dB;
 *   `audio_ax_mix` therefore carries `mix 6`'s exact port list and a narrower member is
 *   that node with inputs left unwired. This is not a new call: AX-1 shipped `mux 8`
 *   covering `mux 2`/`mux 4` and `decode/int 8` on the same reasoning, in those nodes'
 *   own words ("the same switch at three widths, so this is the widest").
 *
 *   A MODE FAMILY IS SEVERAL NODES, BECAUSE A STUB CANNOT HOLD A MODE. `stubSpec` gives
 *   every knob the corpus's numeric range, so a discrete `shape: "adsr"` knob is not
 *   expressible here — it would be a string in a ±64 numeric row, which
 *   `tests/audio_patches_test.js`'s range sweep reads as NaN and fails. So the envelopes
 *   are one row per SHAPE (`adsr`, `ahd`, exponential decay, LINEAR decay), and
 *   `dist/soft` and `dist/inf` are two rows rather than one with a knob. When AX-4
 *   collapses them behind a `shape` knob these rows are deleted together.
 *
 *   A ` m` SUFFIX IS NOT A SHAPE — IT IS THE PARAM/INLET DUALITY, so it is NOT a second
 *   row. Axoloti ships ~70 duplicated ` m` objects whose only difference is that a param
 *   also has an inlet, and § R7-11 says our nodes collapse that pair (AX-1's `AX_MATH`
 *   states it: "a knob AND an input, per the param/inlet duality rule"). So `env/d` and
 *   `env/d m` are ONE `audio_ax_env_d` carrying the `d` inlet, and the member without it
 *   is that node with `d` unwired — which is exactly what A10's bass drum sweep is.
 *
 * ── AND ONE STRUCTURAL SUBSTITUTION, STATED HERE BECAUSE IT CHANGES A PORT LIST ──
 * `audio_ax_delay_sdram` is ONE node standing for the PAIR `delay/write sdram` +
 * `delay/read interp`. On hardware those are joined by an instance NAME, not by a wire
 * (`read`'s `delayname` attribute), and PowerRP has no name-binding between nodes: a
 * write-only node has no outlet at all, so it can never reach an output and
 * `tests/audio_patches_test.js` refuses it — correctly, since it would be a card that
 * cannot be heard. Both objects' ports are carried on the one node, plus a `feedback`
 * input neither has, for the reason recorded in the patch's `deviations`.
 *
 * ── WHAT IS *NOT* HERE, AND IS THE PATCHES' PROBLEM RATHER THAN THIS FILE'S ──
 * An Axoloti ATTRIBUTE is construct-time (a spinner or a combo), not a param, and
 * `stubSpec` has no `construct: true` — nor a range wide enough: `reverb/fdn4`'s four
 * delay lengths (397 / 567 / 447 / 897 samples) and `delay/write sdram`'s size (16384)
 * are all outside the ±64 an Axoloti dial rail allows. They are therefore NOT knobs
 * here; they are written down in the blueprint's `deviations` and belong on the real node
 * as `construct: true` rows, which is core/audio_specs.js's own vocabulary for a setting
 * that rebuilds the module.
 */

/** This set's placeholder declarations. Empty means every node its patches want exists. */
export const BLOCK_STUBS = [
  // ── AX-1 — the two MIDI sources the block has not shipped yet ─────────────
  // A10 needs neither; C11's voice is nothing but these two plus Braids.
  {
    type: "audio_ax_midi_keyb", title: "AX MIDI Keyboard", family: "source",
    source: "midi/in/keyb", block: "AX-1", corpus: "axoloti",
    inputs: [],
    // `note` is SEMITONES FROM E4, like every Axoloti pitch. That is why this row exists
    // instead of a `node_keyboard`: our keyboard widget's `pitch` output is in HERTZ
    // (plugins/node_keyboard.js `noteFrequency`), so wiring it to an Axoloti pitch port
    // would transpose every note by its own frequency in semitones. Reported to the lead.
    outputs: [["note", "audio"], ["gate", "trigger"], ["gate2", "trigger"], ["velocity", "audio"], ["releasevelocity", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_midi_bend", title: "AX MIDI Bend", family: "source",
    source: "midi/in/bend", block: "AX-1", corpus: "axoloti",
    inputs: [],
    outputs: [["bend", "audio"], ["trig", "trigger"]],
    knobs: [],
  },

  // ── AX-4 — envelopes, the mixer, the two shapers, the crossfader ──────────
  {
    type: "audio_ax_env_d", title: "AX Decay Envelope", family: "modulation",
    // `env/d` AND `env/d m` — the duality pair, one row. See the header.
    source: "env/d (+ env/d m)", block: "AX-4", corpus: "axoloti",
    inputs: [["trig", "trigger"], ["d", "number"]],
    outputs: [["env", "audio"]],
    knobs: [["d", -20.0]],
  },
  {
    type: "audio_ax_env_d_lin_m", title: "AX Decay Envelope (linear, modulated)", family: "modulation",
    source: "env/d lin m", block: "AX-4", corpus: "axoloti",
    inputs: [["trig", "trigger"], ["d", "number"]],
    outputs: [["env", "audio"]],
    knobs: [["d", -16.0]],
  },
  {
    type: "audio_ax_env_adsr", title: "AX ADSR Envelope", family: "modulation",
    source: "env/adsr", block: "AX-4", corpus: "axoloti",
    inputs: [["gate", "trigger"]],
    outputs: [["env", "audio"]],
    knobs: [["a", -59.0], ["d", 24.0], ["s", 0.0], ["r", -30.0]],
  },
  {
    type: "audio_ax_env_ahd", title: "AX Attack-Hold-Decay Envelope", family: "modulation",
    source: "env/ahd", block: "AX-4", corpus: "axoloti",
    inputs: [["gate", "trigger"]],
    outputs: [["env", "audio"]],
    knobs: [["a", -50.0], ["d", 36.0]],
  },
  {
    type: "audio_ax_mix", title: "AX Mixer", family: "modulation",
    // `mix 6`'s port list, covering the whole width family — see the header.
    // `bus_in` is the UNGAINED sum input every member has, which is how an Axoloti patch
    // adds a value to a scaled one in a single object (C11 sums the bend into the note
    // that way, and A10 adds the snare's dry signal to its reverb tail).
    source: "mix/mix 1 … mix/mix 6 (+ the `g` variants)", block: "AX-4", corpus: "axoloti",
    inputs: [["bus_in", "audio"], ["in1", "audio"], ["in2", "audio"], ["in3", "audio"], ["in4", "audio"], ["in5", "audio"], ["in6", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [["gain1", 1.0], ["gain2", 0.0], ["gain3", 0.0], ["gain4", 0.0], ["gain5", 0.0], ["gain6", 0.0]],
  },
  {
    type: "audio_ax_dist_soft", title: "AX Soft Clip", family: "effect",
    source: "dist/soft", block: "AX-4", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_dist_inf", title: "AX Infinite Clip", family: "effect",
    source: "dist/inf", block: "AX-4", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_xfade", title: "AX Crossfade", family: "modulation",
    source: "mix/xfade", block: "AX-4", corpus: "axoloti",
    inputs: [["i1", "audio"], ["i2", "audio"], ["c", "number"]],
    outputs: [["o", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_dp_soft_clip", title: "AX DP Soft Clip", family: "effect",
    source: "tiar/dist/DPSoftClip", block: "AX-4", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [["ingain", 25.0], ["outgain", 15.0]],
  },

  // ── AX-5 — the FDN and the SDRAM delay line ───────────────────────────────
  {
    type: "audio_ax_fdn4", title: "AX FDN Reverb", family: "effect",
    // The four delay lengths are ATTRIBUTES, not params — see the header. A10's are
    // 397 / 567 / 447 / 897 samples and are recorded in that patch's `deviations`.
    source: "reverb/fdn4", block: "AX-5", corpus: "axoloti",
    inputs: [["in1", "audio"], ["in2", "audio"], ["in3", "audio"], ["in4", "audio"]],
    outputs: [["out1", "audio"], ["out2", "audio"], ["out3", "audio"], ["out4", "audio"]],
    knobs: [["g", 0.0]],
  },
  {
    type: "audio_ax_delay_sdram", title: "AX SDRAM Delay", family: "effect",
    source: "delay/write sdram + delay/read interp", block: "AX-5", corpus: "axoloti",
    inputs: [["in", "audio"], ["time", "audio"], ["feedback", "number"]],
    outputs: [["out", "audio"]],
    knobs: [["time", 0.0]],
  },

  // ── AX-6 — the one Braids engine these patches use ────────────────────────
  {
    type: "audio_ax_brds_bowed", title: "AX Braids Bowed", family: "source",
    source: "osc/brds/bowed", block: "AX-6", corpus: "axoloti",
    inputs: [["pitch", "number"], ["timbre", "number"], ["color", "number"], ["strike", "trigger"]],
    outputs: [["wave", "audio"]],
    knobs: [["pitch", 0.0], ["timbre", 40.5], ["color", 40.0]],
  },

  // ── AX-7 — Elements' diffuser and reverb, Rings' chorus ───────────────────
  {
    type: "audio_ax_lmnts_diffuser", title: "AX Elements Diffuser", family: "effect",
    source: "fx/lmnts/diffuser", block: "AX-7", corpus: "axoloti",
    inputs: [["in", "audio"]],
    outputs: [["out", "audio"]],
    knobs: [],
  },
  {
    type: "audio_ax_lmnts_reverb", title: "AX Elements Reverb", family: "effect",
    source: "fx/lmnts/reverb", block: "AX-7", corpus: "axoloti",
    inputs: [["l", "audio"], ["r", "audio"], ["amount", "number"], ["time", "number"], ["diffusion", "number"], ["gain", "number"], ["lowpass", "number"]],
    outputs: [["l", "audio"], ["r", "audio"]],
    knobs: [["amount", 60.5], ["time", 56.0], ["diffusion", 50.0], ["gain", 18.0], ["lowpass", 46.0]],
  },
  {
    type: "audio_ax_rngs_chorus", title: "AX Rings Chorus", family: "effect",
    source: "fx/rngs/chorus", block: "AX-7", corpus: "axoloti",
    inputs: [["l", "audio"], ["r", "audio"]],
    outputs: [["l", "audio"], ["r", "audio"]],
    knobs: [["amount", 8.5], ["depth", 43.5]],
  },
];
