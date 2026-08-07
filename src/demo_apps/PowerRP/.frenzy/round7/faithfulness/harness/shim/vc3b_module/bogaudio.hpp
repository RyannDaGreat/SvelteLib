// A STAND-IN FOR BOGAUDIO'S OWN UMBRELLA HEADER, so their module glue compiles.
//
// Their real `src/bogaudio.hpp` pulls in `menu.hpp`, `widgets.hpp`, `skins.hpp`
// and `rack_overrides.hpp` — the whole panel layer, which needs nanovg and the
// Rack UI. None of it touches a sample. This file provides only what
// `vco_base.{hpp,cpp}` and `VCO.{hpp,cpp}` actually reference.
//
// WHY THIS FILE CAN EXIST AT ALL: `#include "bogaudio.hpp"` resolves to the
// INCLUDER's directory first, so no -I can put a shim in front of the real one
// while the sources sit in `src/`. The case therefore copies the four glue
// files BYTE FOR BYTE into the build directory and compiles them beside this
// header. Nothing in those four files is edited — see bogaudio_vco.mjs's `prep`.
//
// THE ONE PIECE OF REAL LOGIC HERE is `BGModule::process`'s dispatch order,
// transcribed from `src/module.cpp:49-100`. It is SCHEDULING, not DSP: which
// virtual runs, in what order, and how often (`_modulationSteps` = 100, so
// `modulate()` runs once per 100 samples and `processChannel` every sample).
// That cadence is part of what the port must reproduce — our VcoKernel splits
// the same work into `control()` and `sample()` — so it is stated here where it
// can be audited against their line numbers rather than hidden.
#pragma once

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "rack.hpp"

using namespace rack;

namespace bogaudio {

struct SkinChangeListener {
	virtual void skinChanged(const std::string& skin) = 0;
};

struct BGModule : Module {
	int _modulationSteps = 100; // src/module.hpp:17
	int _steps = -1;
	bool _initialized = false;

	static constexpr int maxChannels = PORT_MAX_CHANNELS;
	int _channels = 0;
	float _inverseChannels = 0.0f;

	bool _skinnable = true;
	std::string _skin = "default";

	BGModule() {}
	virtual ~BGModule() {}

	virtual void reset() {}
	virtual void sampleRateChange() {}
	virtual json_t* saveToJson(json_t* root) { return root; }
	virtual void loadFromJson(json_t* root) {}
	virtual bool active() { return true; }
	virtual int channels() { return 1; }
	virtual void channelsChanged(int before, int after) {}
	virtual void addChannel(int c) {}
	virtual void removeChannel(int c) {}
	virtual void modulateAlways() {}
	virtual void processAlways(const ProcessArgs& args) {}
	virtual void modulate() {}
	virtual void modulateChannel(int c) {}
	virtual void processAll(const ProcessArgs& args) {}
	virtual void processChannel(const ProcessArgs& args, int c) {}
	virtual void postProcess(const ProcessArgs& args) {}
	virtual void postProcessAlways(const ProcessArgs& args) {}

	void onReset() override { reset(); }
	void onSampleRateChange() override { sampleRateChange(); }

	/** Command. `src/module.cpp:49` — the dispatch, transcribed. */
	void process(const ProcessArgs& args) override {
		if (!_initialized) {
			_initialized = true;
			onReset();
			onSampleRateChange();
		}

		bool modulateNow = false;
		++_steps;
		if (_steps >= _modulationSteps) {
			_steps = 0;
			modulateNow = true;
			modulateAlways();
		}

		processAlways(args);
		if (active()) {
			if (modulateNow) {
				int channelsBefore = _channels;
				int channelsNow = std::max(1, channels());
				if (channelsBefore != channelsNow) {
					_channels = channelsNow;
					_inverseChannels = 1.0f / (float)_channels;
					channelsChanged(channelsBefore, channelsNow);
					if (channelsBefore < channelsNow) {
						while (channelsBefore < channelsNow) {
							addChannel(channelsBefore);
							++channelsBefore;
						}
					} else {
						while (channelsNow < channelsBefore) {
							removeChannel(channelsBefore - 1);
							--channelsBefore;
						}
					}
				}
				modulate();
				for (int i = 0; i < _channels; ++i) modulateChannel(i);
			}
			processAll(args);
			for (int i = 0; i < _channels; ++i) processChannel(args, i);
			postProcess(args);
		}
		postProcessAlways(args);
	}
};

/** VCOBase derives its display quantity from this. Display only — no sample
 *  passes through it — so the base is Rack's plain ParamQuantity. */
struct FrequencyParamQuantity : ParamQuantity {
	virtual float offset() { return 0.0f; }
	float getDisplayValue() override { return getValue(); }
	void setDisplayValue(float v) override { setValue(v); }
};

/** `vco_base.hpp` derives its own `VCOBaseModuleWidget` from this, so only the
 *  BASE may be declared here — declaring the derived one too is a redefinition. */
struct BGModuleWidget : ModuleWidget {
	Module* module = nullptr;
	virtual void contextMenu(Menu* menu) {}
	virtual ~BGModuleWidget() {}
};
struct BoolOptionMenuItem { template <typename... A> BoolOptionMenuItem(A...) {} };

} // namespace bogaudio

using namespace bogaudio;

extern Plugin* pluginInstance;
