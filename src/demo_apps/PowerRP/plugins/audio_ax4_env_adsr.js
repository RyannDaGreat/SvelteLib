/**
 * AX ADSR — the `axEnvAdsr` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it shapes or routes other nodes rather than being heard on its own.
 *
 * `env/adsr`, the envelope Axoloti's factory patches are built on: a LINEAR attack that ends when the ramp reaches full scale, then exponential decay and release.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_ENV_ADSR_SPEC in core/audio_specs_ax4.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax4_kernels.js`, and the R7-17 derivation record — source
 * object and commit, which `code.krate`/`code.srate` block, the recurrence in
 * float, and every deliberate divergence by name — is the spec's own
 * `derivation` field. Read both before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_ENV_ADSR_SPEC } from "../core/audio_specs_ax4.js";

export const audioAxEnvAdsrPlugin = audioNodePlugin(AX_ENV_ADSR_SPEC);
