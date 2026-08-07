// UPSTREAM DRIVER — Bogaudio's VCO, THE WHOLE MODULE, not just its oscillators.
//
// `bogaudio_osc` proved the waveform primitives agree. This proves the GLUE:
// the knob-to-hertz mapping, the ±5 V pitch clamp, the slow-mode offset, the
// linear/exponential FM branch, the 8x oversample crossfade around 0.06·fs, the
// pulse-width slew, and the 100-sample `modulate()` cadence. That glue is where
// a tuning bug lives, and no primitive test can see it.
//
// The module code compiled here is `vco_base.{hpp,cpp}` and `VCO.{hpp,cpp}`,
// COPIED UNMODIFIED from /tmp/vcvsrc/bogaudio/src by the case's `prep` step.
// They are copied rather than compiled in place because their
// `#include "bogaudio.hpp"` resolves to the includer's own directory, so no -I
// could put the shim in front of the real panel-layer header. Nothing in the
// four files is edited; `prep` asserts that by copying bytes.
//
// argv: <in.f32> <out.f32> <frames> <sampleRate> <freqKnob> <fineKnob> <pwKnob>
//       <fmDepth> <slow> <linear> <fmType> <pitchWired> <fmWired> <pwWired>
// Input file: 3 interleaved channels — pitch V, fm V, pw CV V.
// Output file: 4 interleaved channels — square, saw, triangle, sine, in volts.

#include "io.hpp"
#include "VCO.hpp"

// The shim's global engine, which is what `APP->engine->getSampleRate()` reads.
static rack::engine::Engine g_engine;
static rack::App g_app{&g_engine};
namespace rack { App* APP = &g_app; }
Plugin* pluginInstance = nullptr;

/** VCO's four outputs, in the order VCO.hpp's OutputsIds declares them. */
static const int VCO_OUTPUT_COUNT = 4;
/** The three CV inlets the harness drives, interleaved in the input file. */
static const int VCO_INPUT_COUNT = 3;

int main(int argc, char** argv) {
	if (argc < 15) { fprintf(stderr, "usage: %s in out frames sr freq fine pw fmDepth slow linear fmType pitchWired fmWired pwWired\n", argv[0]); return 2; }
	const std::vector<float> in = ab::readF32(argv[1]);
	const std::string outPath = argv[2];
	const int frames = (int)ab::argD(argc, argv, 3, "frames");
	const float sampleRate = (float)ab::argD(argc, argv, 4, "sampleRate");
	if ((int)in.size() != frames * VCO_INPUT_COUNT) { fprintf(stderr, "input has %zu floats, expected %d\n", in.size(), frames * VCO_INPUT_COUNT); return 2; }
	g_engine.sampleRate = sampleRate;

	bogaudio::VCO vco;
	vco.params[bogaudio::VCO::FREQUENCY_PARAM].setValue((float)ab::argD(argc, argv, 5, "freq"));
	vco.params[bogaudio::VCO::FINE_PARAM].setValue((float)ab::argD(argc, argv, 6, "fine"));
	vco.params[bogaudio::VCO::PW_PARAM].setValue((float)ab::argD(argc, argv, 7, "pw"));
	vco.params[bogaudio::VCO::FM_PARAM].setValue((float)ab::argD(argc, argv, 8, "fmDepth"));
	vco.params[bogaudio::VCO::SLOW_PARAM].setValue((float)ab::argD(argc, argv, 9, "slow"));
	vco.params[bogaudio::VCO::LINEAR_PARAM].setValue((float)ab::argD(argc, argv, 10, "linear"));
	vco.params[bogaudio::VCO::FM_TYPE_PARAM].setValue((float)ab::argD(argc, argv, 11, "fmType"));

	// A jack's channel count IS its connectedness, and `VCO::modulateChannel`
	// branches on `isConnected()` for pitch, pw and fm. The harness must be able
	// to express "unpatched", so wiring is an explicit argument rather than
	// implied by whether the input file happens to be non-zero.
	const bool pitchWired = ab::argD(argc, argv, 12, "pitchWired") != 0;
	const bool fmWired = ab::argD(argc, argv, 13, "fmWired") != 0;
	const bool pwWired = ab::argD(argc, argv, 14, "pwWired") != 0;
	vco.inputs[bogaudio::VCO::PITCH_INPUT].channels = pitchWired ? 1 : 0;
	vco.inputs[bogaudio::VCO::FM_INPUT].channels = fmWired ? 1 : 0;
	vco.inputs[bogaudio::VCO::PW_INPUT].channels = pwWired ? 1 : 0;
	// SYNC unpatched: `processChannel` reads it with getPolyVoltage, which on an
	// unpatched port is 0 V, and a PositiveZeroCrossing never fires on a
	// constant. Leaving it disconnected is what an unpatched module does.
	vco.inputs[bogaudio::VCO::SYNC_INPUT].channels = 0;
	// `VCO::active()` is false unless an output is patched, and an inactive
	// BGModule skips processChannel entirely. All four are read here.
	for (int i = 0; i < VCO_OUTPUT_COUNT; i++) vco.outputs[i].channels = 1;

	rack::Module::ProcessArgs args{sampleRate, 1.0f / sampleRate, 0};
	std::vector<float> out((size_t)frames * VCO_OUTPUT_COUNT);
	for (int i = 0; i < frames; i++) {
		vco.inputs[bogaudio::VCO::PITCH_INPUT].setVoltage(in[i * VCO_INPUT_COUNT + 0], 0);
		vco.inputs[bogaudio::VCO::FM_INPUT].setVoltage(in[i * VCO_INPUT_COUNT + 1], 0);
		vco.inputs[bogaudio::VCO::PW_INPUT].setVoltage(in[i * VCO_INPUT_COUNT + 2], 0);
		args.frame = i;
		vco.process(args);
		out[i * VCO_OUTPUT_COUNT + 0] = vco.outputs[bogaudio::VCO::SQUARE_OUTPUT].getVoltage(0);
		out[i * VCO_OUTPUT_COUNT + 1] = vco.outputs[bogaudio::VCO::SAW_OUTPUT].getVoltage(0);
		out[i * VCO_OUTPUT_COUNT + 2] = vco.outputs[bogaudio::VCO::TRIANGLE_OUTPUT].getVoltage(0);
		out[i * VCO_OUTPUT_COUNT + 3] = vco.outputs[bogaudio::VCO::SINE_OUTPUT].getVoltage(0);
	}
	ab::writeF32(outPath, out);
	return 0;
}
