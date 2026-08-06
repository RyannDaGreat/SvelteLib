/**
 * THE PLACEHOLDER PLUGINS — one wrapper per not-yet-ported node, DERIVED.
 *
 * The other block barrels (`audio_index_ax1.js` …) list their wrappers by hand, because
 * each of those specs is a hand-authored module with a hand-authored plugin file. A
 * placeholder has neither: it is generated from a declaration, so listing them here would
 * be a mirror of `core/audio_stub_nodes.STUB_SPECS` that drifts the first time a patch
 * agent adds a row. `.map` is the honest expression.
 *
 * THESE ARE NOT IN `AUDIO_SPECS`, and that is deliberate. `tests/audio_nodes_test.js`
 * sweeps that roster against the ENGINE — every spec's `module` must be a factory the
 * synth really has. A placeholder declares no module (see `core/audio_stub_nodes.js`:
 * that absence is what makes the mirror skip it), so putting one in AUDIO_SPECS would
 * either red that sweep or force an exemption in it. An exemption is how a sweep starts
 * lying. They reach the palette through this barrel and nothing else.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { STUB_SPECS } from "../core/audio_stub_nodes.js";

/** Every placeholder, as a registrable plugin. See the PORT-BLOCK CONTRACT's
 *  `BLOCK_PLUGINS` — same name, same role, derived rather than listed. */
export const BLOCK_PLUGINS = STUB_SPECS.map(audioNodePlugin);
