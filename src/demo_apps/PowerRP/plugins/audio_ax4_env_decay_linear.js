/**
 * AX DECAY ENVELOPE (LINEAR) — the `axEnvDecayLinear` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it shapes or routes other nodes rather than being heard on its own.
 *
 * `env/d lin m`: the same trigger-and-fall, but the fall is a straight line that stops dead at zero — the one to drive a PITCH with.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_ENV_DECAY_LINEAR_SPEC in core/audio_specs_ax4.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax4_kernels.js`, and the R7-17 derivation record — source
 * object and commit, which `code.krate`/`code.srate` block, the recurrence in
 * float, and every deliberate divergence by name — is the spec's own
 * `derivation` field. Read both before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_ENV_DECAY_LINEAR_SPEC } from "../core/audio_specs_ax4.js";

export const audioAxEnvDecayLinearPlugin = audioNodePlugin(AX_ENV_DECAY_LINEAR_SPEC);
