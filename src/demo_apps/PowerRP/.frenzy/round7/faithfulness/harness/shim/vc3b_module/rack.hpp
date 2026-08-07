// A MINIMAL rack.hpp, ENOUGH TO COMPILE BOGAUDIO'S MODULE GLUE AND NOTHING MORE.
//
// THE SHIM RULE (harness/CONTRIBUTING.md): this file may fake what Rack
// RETURNS. It may not re-implement a DSP algorithm, because comparing our
// transcription against a second transcription of mine proves nothing.
//
// Everything below is either (a) a data holder whose semantics are exhausted by
// its getters — `Param` is a float, `Input::getVoltage` returns the float you
// set — or (b) a value Rack would supply from its environment, like the engine
// sample rate. There is no filter, no oscillator, no envelope, no trigger and
// no interpolation here. The DSP under test comes from
// /tmp/vcvsrc/bogaudio/src/dsp/, compiled from the pinned commit, and the
// MODULE GLUE comes from vco_base.cpp and VCO.cpp copied byte for byte.
//
// Two Rack behaviours that ARE semantics and so are reproduced exactly:
//   * `Input::isConnected()` is what Bogaudio branches on to decide whether a
//     jack contributes at all. Faking it as always-true would silently change
//     the algorithm, so it is a real per-port flag the driver sets.
//   * `getPolyVoltage(c)` returns channel 0 when the port carries one channel.
//     That is Rack's documented normalling and Bogaudio relies on it.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace rack {

static const int PORT_MAX_CHANNELS = 16;

/** Rack's own clamp, from include/math.hpp. Reproduced because it is a
 *  three-line total order, not an algorithm. */
inline float clamp(float x, float a = 0.f, float b = 1.f) { return std::max(std::min(x, b), a); }
inline float rescale(float x, float xMin, float xMax, float yMin, float yMax) {
	return yMin + (x - xMin) / (xMax - xMin) * (yMax - yMin);
}

namespace math {
using rack::clamp;
}

namespace engine {

/** A knob. In Rack this carries a display quantity too; the DSP only ever reads the value. */
struct Param {
	float value = 0.f;
	float getValue() const { return value; }
	void setValue(float v) { value = v; }
};

/** A jack. `channels` is 0 when nothing is patched, which is what isConnected() means. */
struct Port {
	float voltages[PORT_MAX_CHANNELS] = {};
	int channels = 0;
	bool isConnected() const { return channels > 0; }
	int getChannels() const { return channels; }
	void setChannels(int c) { if (channels != 0 || c != 0) channels = c; }
	float getVoltage(int c = 0) const { return voltages[c]; }
	void setVoltage(float v, int c = 0) { voltages[c] = v; }
	// Rack's documented normalling: a monophonic cable feeds every channel.
	float getPolyVoltage(int c) const { return channels == 1 ? voltages[0] : voltages[c]; }
	float getNormalVoltage(float normal, int c = 0) const { return isConnected() ? getVoltage(c) : normal; }
};
typedef Port Input;
typedef Port Output;

struct Light {
	float value = 0.f;
	void setBrightness(float b) { value = b; }
	void setSmoothBrightness(float b, float) { value = b; }
	float getBrightness() const { return value; }
};

struct Module {
	struct ProcessArgs {
		float sampleRate;
		float sampleTime;
		int64_t frame;
	};

	std::vector<Param> params;
	std::vector<Input> inputs;
	std::vector<Output> outputs;
	std::vector<Light> lights;

	virtual ~Module() {}
	void config(int nParams, int nInputs, int nOutputs, int nLights = 0) {
		params.resize(nParams);
		inputs.resize(nInputs);
		outputs.resize(nOutputs);
		lights.resize(nLights);
	}
	// Panel metadata. It has no effect on a sample, so it is a no-op — this is
	// the clearest case of "fake what Rack returns": Rack returns nothing.
	template <typename... A> void configParam(int, A...) {}
	template <typename Q, typename... A> void configParam(int, A...) {}
	template <typename... A> void configButton(int, A...) {}
	template <typename... A> void configSwitch(int, A...) {}
	// A braced initializer list has no type, so a variadic template cannot
	// deduce it — `configSwitch(id, lo, hi, dflt, "FM mode", {"Linear", "Exp"})`
	// needs this explicit overload. Labels are panel text; they reach no sample.
	void configSwitch(int, float, float, float, const char*, const std::vector<std::string>&) {}
	void configParam(int, float, float, float, const char*, const char* = "", float = 0.f, float = 1.f, float = 0.f) {}
	template <typename... A> void configInput(int, A...) {}
	template <typename... A> void configOutput(int, A...) {}
	template <typename... A> void configLight(int, A...) {}
	template <typename... A> void configBypass(A...) {}

	virtual void process(const ProcessArgs&) {}
	virtual void onReset() {}
	virtual void onRandomize() {}
	virtual void onRemove() {}
	virtual void onSampleRateChange() {}
};

/** The host engine. The harness fixes the sample rate for the whole run, which
 *  is exactly what Rack does between sample-rate changes. */
struct Engine {
	float sampleRate = 48000.f;
	float getSampleRate() const { return sampleRate; }
	float getSampleTime() const { return 1.f / sampleRate; }
};

} // namespace engine

using engine::Module;
using engine::Param;
using engine::Input;
using engine::Output;
using engine::Light;
using engine::Engine;

struct App {
	engine::Engine* engine;
};
extern App* APP;

struct Model {};
struct Plugin {};
struct Menu {};
struct MenuItem {};
struct Widget {};
struct ModuleWidget {};

/** Rack's ParamQuantity: a display-value adapter over a Param. The DSP never
 *  reads one; VCOBase only overrides its display formatting. */
struct ParamQuantity {
	Module* module = nullptr;
	int paramId = 0;
	float getValue() { return module ? module->params[paramId].getValue() : 0.f; }
	void setValue(float v) { if (module) module->params[paramId].setValue(v); }
	virtual float getDisplayValue() { return getValue(); }
	virtual void setDisplayValue(float v) { setValue(v); }
	virtual ~ParamQuantity() {}
};

namespace dsp {
/** Rack's own C4 constant, include/dsp/common.hpp. A number, not an algorithm. */
static const float FREQ_C4 = 261.6256f;
} // namespace dsp

namespace simd {
using rack::clamp;
} // namespace simd

} // namespace rack

// json_t appears in Bogaudio's save/load signatures. The harness never
// serialises, so an opaque forward declaration is the whole of what is needed;
// anything more would be inventing behaviour.
struct json_t;
inline json_t* json_object_get(json_t*, const char*) { return nullptr; }
inline void json_object_set_new(json_t*, const char*, json_t*) {}
inline json_t* json_integer(long long) { return nullptr; }
inline json_t* json_boolean(bool) { return nullptr; }
inline long long json_integer_value(json_t*) { return 0; }
inline bool json_boolean_value(json_t*) { return false; }
