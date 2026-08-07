// UPSTREAM DRIVER — Bogaudio's oscillator primitives, compiled from their own
// src/dsp sources at the commit core/audio_specs_vc3b.js pins.
//
// These structs are the arithmetic our BogSineOscillator / BogSquare /
// BogBandLimitedSquare / bogBandLimitedSawForPhase / bogTriangleForPhase claim
// to reproduce. Nothing here is re-derived: the harness only sets a frequency
// and pulls samples, exactly as VCOBase::Engine does.
//
// argv: <in.f32> <out.f32> <frames> <sampleRate> <which> <freqHz> [pulseWidth]
//   which: 0 sine (SineOscillator, the state-variable one)
//          1 saw  (BandLimitedSawOscillator, quality 12 — VCOBase's setting)
//          2 square (BandLimitedSquareOscillator, quality 12, dc correction on)
//          3 triangle (TriangleOscillator)
//          4 naive square (SquareOscillator)
//          5 sine table (SineTableOscillator — VCO's actual sine output)
// The input file is unused for this case (the oscillators are free-running);
// it is still read so every case obeys the same wire.

#include "io.hpp"
#include "dsp/oscillator.hpp"

using namespace bogaudio::dsp;

// VCOBase::Engine sets quality 12 on both band-limited oscillators; the default
// is 5, so testing at the default would not be testing what the VCO uses.
static const int VCO_BLEP_QUALITY = 12;

// THE CONSTRUCTOR ARGUMENT IS A TRAP AND THE FIRST RUN OF THIS HARNESS FELL IN
// IT. `BandLimitedSawOscillator(sr, f, 12)` initialises `_quality` to 12 in the
// member list and then calls `setQuality(12)`, whose first line is
// `if (_quality != quality) return`-shaped — so `_update()` never runs, `_qd`
// stays 0, and the oscillator emits a NAIVE saw with no BLEP correction at all.
// (Phasor's own constructor does call `_update()`, but during base-class
// construction, where the vtable is still Phasor's.)
//
// VCOBase::Engine never hits this because it default-constructs (quality 5) and
// then calls setQuality(12), which is a real change. Mirror Engine, not the
// convenience constructor: `mirrorEngineSetup` is exactly Engine()'s
// setQuality + Engine::sampleRateChange's setSampleRate + Engine::setFrequency's
// setFrequency, in that order.
template <typename Osc>
static void mirrorEngineSetup(Osc& o, float sampleRate, float freq) {
	o.setQuality(VCO_BLEP_QUALITY);
	o.setSampleRate(sampleRate);
	o.setFrequency(freq);
}

int main(int argc, char** argv) {
	if (argc < 7) { fprintf(stderr, "usage: %s in out frames sampleRate which freqHz [pw]\n", argv[0]); return 2; }
	ab::readF32(argv[1]);
	const std::string outPath = argv[2];
	const int frames = (int)ab::argD(argc, argv, 3, "frames");
	const float sampleRate = (float)ab::argD(argc, argv, 4, "sampleRate");
	const int which = (int)ab::argD(argc, argv, 5, "which");
	const float freq = (float)ab::argD(argc, argv, 6, "freqHz");
	const float pw = argc > 7 ? (float)ab::argD(argc, argv, 7, "pw") : 0.5f;

	std::vector<float> out((size_t)frames);

	if (which == 0) {
		SineOscillator o(sampleRate, freq);
		for (int i = 0; i < frames; i++) out[i] = o.next();
	}
	else if (which == 1) {
		BandLimitedSawOscillator o;
		mirrorEngineSetup(o, sampleRate, freq);
		for (int i = 0; i < frames; i++) out[i] = o.next();
	}
	else if (which == 2) {
		BandLimitedSquareOscillator o;
		mirrorEngineSetup(o, sampleRate, freq);
		o.setPulseWidth(pw, true);
		for (int i = 0; i < frames; i++) out[i] = o.next();
	}
	else if (which == 3) {
		TriangleOscillator o(sampleRate, freq);
		for (int i = 0; i < frames; i++) out[i] = o.next();
	}
	else if (which == 4) {
		SquareOscillator o(sampleRate, freq);
		o.setPulseWidth(pw);
		for (int i = 0; i < frames; i++) out[i] = o.next();
	}
	else if (which == 5) {
		SineTableOscillator o(sampleRate, freq);
		for (int i = 0; i < frames; i++) out[i] = o.next();
	}
	else { fprintf(stderr, "unknown which=%d\n", which); return 2; }

	ab::writeF32(outPath, out);
	return 0;
}
