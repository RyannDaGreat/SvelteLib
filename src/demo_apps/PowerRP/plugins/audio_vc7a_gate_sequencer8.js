/**
 * VCV Gate Sequencer 8 — the ported CountModula/ImpromptuModular module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA, and
 * that data is VCV_GATE_SEQUENCER_8_SPEC in core/audio_specs_vc7a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT, so there is a third place: the arithmetic is
 * synth/vc7a_kernels.js, whose docblocks carry the DERIVATION RECORD — the source
 * project and commit, the C++ file and function, the recurrence in float, and every
 * deliberate deviation by name. Read that before changing what this does.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_GATE_SEQUENCER_8_SPEC } from "../core/audio_specs_vc7a.js";

export const audioVcvGateSequencer8Plugin = audioNodePlugin(VCV_GATE_SEQUENCER_8_SPEC);
