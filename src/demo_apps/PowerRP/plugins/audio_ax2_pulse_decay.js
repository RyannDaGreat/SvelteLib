/**
 * AX DECAY — the `axPulseDecay` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * `pulse/d`: an exponential decay from full scale on every trigger, computed at AUDIO rate — so unlike a control-rate envelope it can be short enough to be a click's shape rather than its amplitude. Wire it into a VCA gain, or into a pitch for a drum's blip.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_PULSE_DECAY_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_PULSE_DECAY_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxPulseDecayPlugin = audioNodePlugin(AX_PULSE_DECAY_SPEC);
