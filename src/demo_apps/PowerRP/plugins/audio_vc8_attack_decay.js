/**
 * Attack Decay — the `vcvAttackDecay` engine module as a PowerRP node widget.
 *
 * MODULATION family: it produces control, not sound.
 *
 * A Buchla 281-flavoured attack/decay envelope with a linear-to-exponential curve, an inverting scale and a loop switch.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA, and
 * that data is VCV_ATTACK_DECAY_SPEC in core/audio_specs_vc8.js.
 *
 * ── AND WHERE THE SOUND IS, AND WHAT IT IS NOT ──────────────────────────────
 * **NYSTHI SHIPS NO SOURCE AT ANY REF**, so this node is not a port — it is an
 * approximation built from the plugin's own CHANGELOG, one published DSP paper
 * and the demo patches' cables. `synth/vc8_kernels.js` carries the full
 * derivation record: which document, read on which date, what fixed the PORT
 * LAYOUT separately from the behaviour, the recurrence in float, and every
 * deviation and GUESS by number. Read that before changing what this SOUNDS like,
 * and do not describe it as a port.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_ATTACK_DECAY_SPEC } from "../core/audio_specs_vc8.js";

export const audioVcvAttackDecayPlugin = audioNodePlugin(VCV_ATTACK_DECAY_SPEC);
