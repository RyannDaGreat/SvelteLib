/**
 * VCV RIPPLES — the `vcvRipples` engine module as a PowerRP node widget.
 *
 * FILTER family (violet header): it shapes a signal's spectrum.
 *
 * Mutable Instruments' analog filter as a circuit-level model — four integrator cells, two
 * nonlinearities and midpoint Runge-Kutta at 3x oversampling.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat equation-slot
 * keys, `inputs: {}` so copies remap, a height sized from its own ports — lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA, and that data is VCV_RIPPLES_SPEC in
 * core/audio_specs_vc1.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * `synth/vc1_kernels.js` carries the derivation record. Ripples' is unusual in this block:
 * there is NO Mutable DSP to port, because the real module is analog. The Rack
 * implementation is an original circuit simulation and is therefore the primary source.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_RIPPLES_SPEC } from "../core/audio_specs_vc1.js";

export const audioVcvRipplesPlugin = audioNodePlugin(VCV_RIPPLES_SPEC);
