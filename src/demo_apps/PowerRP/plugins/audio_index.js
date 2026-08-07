import { BLOCK_PLUGINS as AX1_PLUGINS } from "./audio_index_ax1.js";
import { BLOCK_PLUGINS as AX2_PLUGINS } from "./audio_index_ax2.js";
import { BLOCK_PLUGINS as AX3_PLUGINS } from "./audio_index_ax3.js";
import { BLOCK_PLUGINS as VC1_PLUGINS } from "./audio_index_vc1.js";
import { BLOCK_PLUGINS as VC2_PLUGINS } from "./audio_index_vc2.js";
import { BLOCK_PLUGINS as VC3A_PLUGINS } from "./audio_index_vc3a.js";
import { BLOCK_PLUGINS as VC3B_PLUGINS } from "./audio_index_vc3b.js";
import { BLOCK_PLUGINS as AX4_PLUGINS } from "./audio_index_ax4.js";
import { BLOCK_PLUGINS as VC7A_PLUGINS } from "./audio_index_vc7a.js";
import { BLOCK_PLUGINS as VC8_PLUGINS } from "./audio_index_vc8.js";
import { BLOCK_PLUGINS as VC10_PLUGINS } from "./audio_index_vc10.js";
import { BLOCK_PLUGINS as VC5_PLUGINS } from "./audio_index_vc5.js";
import { BLOCK_PLUGINS as STUB_PLUGINS } from "./audio_index_stub.js";
/**
 * THE AUDIO NODE ROSTER — every plugins/audio_*.js, in one array.
 *
 * A BARREL, and it exists so that plugins/index.js gains ONE import and ONE spread
 * instead of twenty-three of each. That matters beyond tidiness: index.js is the
 * file every widget workstream edits, and twenty-three lines added to its import
 * block is twenty-three lines of conflict surface for whoever lands next.
 *
 * ── WHY A HAND-WRITTEN LIST AND NOT A GLOB ──────────────────────────────────
 * Vite can glob a directory, but core/ and cli/ must run in BARE NODE where
 * `import.meta.glob` does not exist — and the roster is swept by
 * tests/audio_nodes_test.js, which runs there. A literal list also makes
 * "registered" a thing you can read rather than a thing you have to execute, and
 * the failure mode of forgetting a line here is LOUD: the spec sweep asserts this
 * array covers AUDIO_SPECS exactly, so a module that exists in one and not the
 * other reds the suite instead of quietly not appearing in the palette.
 */

import { audioOscillatorPlugin } from "./audio_oscillator.js";
import { audioSupersawPlugin } from "./audio_supersaw.js";
import { audioNoisePlugin } from "./audio_noise.js";
import { audioSamplerPlugin } from "./audio_sampler.js";
import { audioDingPlugin } from "./audio_ding.js";
import { audioPadPlugin } from "./audio_pad.js";
import { audioPolyPadPlugin } from "./audio_poly_pad.js";
import { audioFilterPlugin } from "./audio_filter.js";
import { audioEq3Plugin } from "./audio_eq3.js";
import { audioBitcrushPlugin } from "./audio_bitcrush.js";
import { audioQuantizePlugin } from "./audio_quantize.js";
import { audioDelayPlugin } from "./audio_delay.js";
import { audioReverbPlugin } from "./audio_reverb.js";
import { audioLfoPlugin } from "./audio_lfo.js";
import { audioAdsrPlugin } from "./audio_adsr.js";
import { audioVcaPlugin } from "./audio_vca.js";
import { audioMixerPlugin } from "./audio_mixer.js";
import { audioClockPlugin } from "./audio_clock.js";
import { audioSequencerPlugin } from "./audio_sequencer.js";
import { audioSampleHoldPlugin } from "./audio_sample_hold.js";
import { audioTriggerPlugin } from "./audio_trigger.js";
import { audioMeterPlugin } from "./audio_meter.js";
import { audioSpectrumPlugin } from "./audio_spectrum.js";
import { audioOutputPlugin } from "./audio_output.js";

/** Every audio node plugin, in core/audio_specs.AUDIO_SPECS order (sources →
 *  shapers → analysis → out), which is also the order they appear in the palette. */
export const audioPlugins = [
  audioOscillatorPlugin, audioSupersawPlugin, audioNoisePlugin, audioSamplerPlugin, audioDingPlugin, audioPadPlugin, audioPolyPadPlugin,
  audioFilterPlugin, audioEq3Plugin, audioBitcrushPlugin, audioQuantizePlugin,
  audioDelayPlugin, audioReverbPlugin,
  audioLfoPlugin, audioAdsrPlugin, audioVcaPlugin, audioMixerPlugin, audioClockPlugin, audioSequencerPlugin, audioSampleHoldPlugin, audioTriggerPlugin,
  audioMeterPlugin, audioSpectrumPlugin,
  audioOutputPlugin,
  // The PORTED BLOCKS (R7-17) — one entry per block, never a per-node list here.
  ...AX1_PLUGINS, ...AX2_PLUGINS, ...AX3_PLUGINS, ...VC1_PLUGINS, ...VC2_PLUGINS, ...VC3A_PLUGINS, ...VC3B_PLUGINS, ...AX4_PLUGINS, ...VC7A_PLUGINS, ...VC8_PLUGINS, ...VC10_PLUGINS, ...VC5_PLUGINS,
  // The PLACEHOLDERS (R7-17-SEL) — nodes the 20 patches wire but no block has ported
  // yet. LAST, so that if a real block and a placeholder ever claimed one type the real
  // one would already be in the array when the duplicate is found; `tests/audio_stub_test.js`
  // makes that collision red rather than letting registration order decide it.
  ...STUB_PLUGINS,
];
