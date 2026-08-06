/**
 * MIX4 — the `vcvMix4` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Four channels with fader, mute/solo, pan and level CV into a master fader and a SATURATOR — so pushing it does not clip, it compresses. Faders are decibel curves through Bogaudio's own level table, and the pan is constant-power off the sine table. Five of these carry the Incanta patch's bus.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_MIX4_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_MIX4_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvMix4Plugin = audioNodePlugin(VCV_MIX4_SPEC);
