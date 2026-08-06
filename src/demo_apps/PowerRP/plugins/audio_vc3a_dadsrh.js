/**
 * DADSR(H) — the `vcvDadsrh` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * A DELAY-attack-decay-sustain-release envelope with a HOLD timer and per-stage shapes. Its two ideas: the delay lets one trigger fire several of these at staggered times, and the HOLD ends the note by itself — so in TRIGGERED mode the envelope is fire-and-forget, and with LOOP on it becomes an LFO with a shape you drew.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_DADSRH_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_DADSRH_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvDadsrhPlugin = audioNodePlugin(VCV_DADSRH_SPEC);
