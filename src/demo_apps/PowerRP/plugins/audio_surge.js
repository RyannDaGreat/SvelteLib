/**
 * SURGE XT — the `surge` engine module as a PowerRP node widget.
 *
 * SOURCE family, like the poly pad it most resembles: it generates signal, but
 * nothing until something plays it. Wire a MIDI clip into `midi`, or a Keyboard
 * node's `pitch` and `gate`, and patch its output like any other source.
 *
 * A two-line file for the same reason every other audio node is one: the SHAPE
 * lives in core/audio_nodes.js and the DATA is SURGE_SPEC in
 * core/audio_specs_surge.js — which is also where the determinism ruling, the
 * remote-asset trade and the reason there are no macro knobs are written down.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { SURGE_SPEC } from "../core/audio_specs_surge.js";

export const audioSurgePlugin = audioNodePlugin(SURGE_SPEC);
