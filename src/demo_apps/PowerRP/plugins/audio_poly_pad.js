/**
 * POLY PAD — the `polyPad` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing — but
 * unlike its mono sibling it generates NOTHING until something plays it. Wire a
 * Keyboard node's `pitch` and `gate` into it.
 *
 * A two-line file for the same reason every other audio node is one: the SHAPE
 * lives in core/audio_nodes.js and the DATA is POLY_PAD_SPEC in
 * core/audio_specs.js. What makes this module different from the Ambience Pad —
 * a pitch input instead of a frequency knob, a method gate, a voice count — is
 * entirely in that spec, which is where to go to change it.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { POLY_PAD_SPEC } from "../core/audio_specs.js";

export const audioPolyPadPlugin = audioNodePlugin(POLY_PAD_SPEC);
