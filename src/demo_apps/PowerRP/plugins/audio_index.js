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
  audioOscillatorPlugin, audioSupersawPlugin, audioNoisePlugin, audioSamplerPlugin, audioDingPlugin, audioPadPlugin,
  audioFilterPlugin, audioEq3Plugin, audioBitcrushPlugin, audioQuantizePlugin,
  audioDelayPlugin, audioReverbPlugin,
  audioLfoPlugin, audioAdsrPlugin, audioVcaPlugin, audioMixerPlugin, audioClockPlugin, audioSequencerPlugin, audioSampleHoldPlugin, audioTriggerPlugin,
  audioMeterPlugin, audioSpectrumPlugin,
  audioOutputPlugin,
];
