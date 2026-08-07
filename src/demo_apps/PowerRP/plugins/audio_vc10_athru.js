/**
 * INSTRUO ATHRU — the `vcvAthru` engine module as a PowerRP node widget.
 *
 * EFFECT FAMILY (effect family): it transforms a signal it is given.
 *
 * FIDELITY TIER: BEHAVIOUR ONLY. What that means for this node — which source it was
 * read from, at which commit, and which of its parts are transcribed rather
 * than modelled — is `VCV_ATHRU_SPEC`'s `derivation` and its `help`.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is `VCV_ATHRU_SPEC` in core/audio_specs_vc10.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT, so there is a third place: the arithmetic is
 * `synth/vc10_kernels.js`, whose docblocks carry the derivation record — source
 * commit, which file and function, the recurrence in float, and every deliberate
 * divergence by name. Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_ATHRU_SPEC } from "../core/audio_specs_vc10.js";

export const audioVcvAthruPlugin = audioNodePlugin(VCV_ATHRU_SPEC);
