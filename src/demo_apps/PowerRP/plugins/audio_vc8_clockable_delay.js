/**
 * VCV ClockableDelay — the `vcvClockableDelay` engine module as a PowerRP node widget.
 *
 * EFFECT family: signal in, signal out, changed.
 *
 * A stereo looping delay after the Make Noise DLD, with hold, reverse and two send/return breaks inside the loop.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA, and
 * that data is VCV_CLOCKABLE_DELAY_SPEC in core/audio_specs_vc8.js.
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
import { VCV_CLOCKABLE_DELAY_SPEC } from "../core/audio_specs_vc8.js";

export const audioVcvClockableDelayPlugin = audioNodePlugin(VCV_CLOCKABLE_DELAY_SPEC);
