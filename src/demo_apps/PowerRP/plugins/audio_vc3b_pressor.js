/**
 * Bogaudio Pressor — the ported `Bogaudio-Pressor` as a PowerRP node widget.
 *
 * EFFECT family (violet header): it acts on time and dynamics rather than on spectrum.
 *
 * Bogaudio's compressor / limiter / noise gate — an RMS-over-50 ms detector, slew-limited attack and release, a chord-construction knee and a sidechain.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_PRESSOR_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_PRESSOR_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvPressorPlugin = audioNodePlugin(VCV_PRESSOR_SPEC);
