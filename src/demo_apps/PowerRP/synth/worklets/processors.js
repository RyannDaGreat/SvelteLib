/**
 * THE AUDIOWORKLET PROCESSORS — everything native AudioNodes cannot do.
 *
 * ── THE IMPLEMENTATION LAW (blueprint, THE SYNTH ENGINE 2) ───────────────────
 * Native AudioNodes FIRST: they are C++ under the hood and honestly satisfy the
 * user's "no slow JavaScript shit". This file is the documented exception list —
 * the five things with no native equivalent:
 *
 *   1. bitcrush   — sample-rate and bit-depth reduction (WaveShaper can fake
 *                   quantization but cannot hold-and-decimate in time)
 *   2. quantize   — snap a control signal to a musical scale
 *   3. adsr       — an envelope with RETRIGGER. Native AudioParam automation can
 *                   draw an envelope, but cancelling and restarting it mid-flight
 *                   from a live trigger is exactly where Firefox's envelope
 *                   handling is documented-broken (research [01]), so we own it.
 *   4. sampleHold — latch the input on each rising edge
 *   5. trigger    — Schmitt-hysteresis rising-edge detector (the Axoloti ruling)
 *
 * ── REAL-TIME SAFETY (research [02]'s checklist, followed literally) ──────────
 * `process()` runs on the audio thread every 128 samples (~2.7 ms at 48 kHz).
 * A garbage-collection pause there is an audible click, so in the hot path:
 *   - ZERO allocations. Every buffer is pre-allocated in the constructor.
 *   - No `new`, no array literals, no closures, no string building.
 *   - Always `return true`, so the node is never collected while its graph lives.
 * Anything violating that belongs on the main thread, not here.
 *
 * ── THE WASM SEAM (blueprint: "build the seam, not the WASM") ────────────────
 * Each processor's DSP is a single `tick()`-shaped inner loop over one block.
 * If one of these ever MEASURES too slow, the swap is: compile the same loop to
 * WASM, instantiate it in the constructor, and call it in place of the loop
 * body. Nothing outside this file changes, because the engine only ever sees an
 * AudioWorkletNode with named AudioParams. We have not written any WASM: no
 * processor here has been measured too slow, and speculative WASM would be cost
 * with no evidence behind it.
 *
 * This file is loaded by `audioWorklet.addModule()` and runs in the AudioWorklet
 * global scope — `sampleRate`, `currentTime`, `AudioWorkletProcessor` and
 * `registerProcessor` are ambient there. It is NOT an ES module in the normal
 * sense and must not import anything, which is why the few constants it shares
 * with dsp.js (the Schmitt thresholds) are restated here with a pointer rather
 * than imported. That duplication is deliberate and is pinned by a test.
 */

/** Restated from dsp.js SCHMITT_LOW / SCHMITT_HIGH — the worklet scope cannot
 * import. tests/synth_engine_test.js asserts these two files agree, so the
 * duplication cannot silently drift. */
const SCHMITT_LOW = 0.1;
const SCHMITT_HIGH = 0.5;

/** Below this level an envelope is treated as finished and its voice may be
 * reclaimed. -80 dB: far below audibility, high enough to avoid denormals. */
const ENVELOPE_SILENCE = 0.0001;

/**
 * BITCRUSH — decimation (sample-rate reduction) + quantization (bit-depth
 * reduction), the two halves of the classic lo-fi effect.
 *
 * Decimation holds each sample for `sampleRate/targetRate` samples, producing
 * the aliasing "grit"; quantization snaps amplitude to 2^bits levels, producing
 * the "crunch". Both are deliberately un-antialiased: the aliasing IS the
 * effect. Params are k-rate because they are knob settings, not signals.
 */
class BitcrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "bits", defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      { name: "reduction", defaultValue: 4, minValue: 1, maxValue: 64, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.holdValue = 0;
    this.holdCounter = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const bits = parameters.bits[0];
    const reduction = Math.max(1, Math.floor(parameters.reduction[0]));
    const levels = Math.pow(2, bits);

    for (let channel = 0; channel < output.length; channel++) {
      const inputChannel = input[channel] || input[0];
      const outputChannel = output[channel];
      for (let i = 0; i < outputChannel.length; i++) {
        if (this.holdCounter <= 0) {
          // Quantize on capture, so held samples share one quantized value.
          this.holdValue = Math.round(inputChannel[i] * levels) / levels;
          this.holdCounter = reduction;
        }
        this.holdCounter--;
        outputChannel[i] = this.holdValue;
      }
    }
    return true;
  }
}

/**
 * QUANTIZE — snap a 0..1 control signal to the nearest degree of a musical
 * scale, expressed in semitones. This is what turns a smooth LFO or random
 * voltage into something that plays IN KEY, and it is the single node that
 * makes generative sequences sound intentional rather than arbitrary.
 *
 * The scale table is set by message (an array of semitone offsets within an
 * octave); `range` is how many semitones the full 0..1 input spans.
 */
class QuantizeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "range", defaultValue: 24, minValue: 1, maxValue: 96, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    // Chromatic until told otherwise — pre-allocated, replaced only by message.
    this.scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    this.port.onmessage = (event) => {
      if (event.data && Array.isArray(event.data.scale) && event.data.scale.length > 0) {
        this.scale = event.data.scale;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const range = parameters.range[0];
    const scale = this.scale;
    const scaleLength = scale.length;

    for (let channel = 0; channel < output.length; channel++) {
      const inputChannel = input[channel] || input[0];
      const outputChannel = output[channel];
      for (let i = 0; i < outputChannel.length; i++) {
        const semitones = inputChannel[i] * range;
        const octave = Math.floor(semitones / 12);
        const withinOctave = semitones - octave * 12;

        // Nearest scale degree, by linear scan — scaleLength is <= 12, so this
        // is cheaper than any structure that would need allocation.
        let best = scale[0];
        let bestDistance = Math.abs(withinOctave - scale[0]);
        for (let s = 1; s < scaleLength; s++) {
          const distance = Math.abs(withinOctave - scale[s]);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = scale[s];
          }
        }
        outputChannel[i] = (octave * 12 + best) / range;
      }
    }
    return true;
  }
}

/**
 * ADSR ENVELOPE WITH RETRIGGER — an attack/decay/sustain/release envelope
 * driven by a GATE input, emitting a 0..1 control signal.
 *
 * WHY A WORKLET AND NOT AudioParam AUTOMATION: automation can draw this shape,
 * but a live retrigger has to CANCEL a scheduled ramp and start a new one from
 * wherever the envelope currently is — and reading an AudioParam's instantaneous
 * value from the main thread is precisely what the API does not offer. Firefox's
 * envelope handling is separately documented-broken (research [01]). Owning the
 * state machine makes retrigger exact and portable.
 *
 * RETRIGGER (research [04], an explicitly named behavior): a new rising edge
 * while the gate is already open restarts from ATTACK — but from the CURRENT
 * level, not from zero, so a fast repeated hit swells rather than clicking.
 * `retrigger` = 0 makes a new edge during an open gate do nothing instead.
 */
class ADSRProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "attack", defaultValue: 0.01, minValue: 0.0005, maxValue: 10, automationRate: "k-rate" },
      { name: "decay", defaultValue: 0.2, minValue: 0.0005, maxValue: 10, automationRate: "k-rate" },
      { name: "sustain", defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.8, minValue: 0.0005, maxValue: 20, automationRate: "k-rate" },
      { name: "retrigger", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.stage = "idle"; // idle | attack | decay | sustain | release
    this.level = 0;
    this.armed = false;
    // A trigger() call from the main thread is equivalent to a gate rising
    // edge; queued as a flag rather than allocating an event object.
    this.pendingTrigger = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "trigger") this.pendingTrigger = true;
      if (event.data && event.data.type === "release") this.armed = false;
    };
  }

  process(inputs, outputs, parameters) {
    const gateInput = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outputChannel = output[0];

    const attack = parameters.attack[0];
    const decay = parameters.decay[0];
    const sustain = parameters.sustain[0];
    const release = parameters.release[0];
    const retriggerAllowed = parameters.retrigger[0] > 0.5;

    // Per-sample increments. Linear attack (a linear attack is perceived as
    // punchier than exponential); exponential-approach decay and release,
    // which is how analog envelopes actually behave.
    const attackStep = 1 / (attack * sampleRate);
    const decayCoefficient = Math.exp(-1 / (decay * sampleRate));
    const releaseCoefficient = Math.exp(-1 / (release * sampleRate));

    const gateChannel = gateInput && gateInput.length > 0 ? gateInput[0] : null;

    for (let i = 0; i < outputChannel.length; i++) {
      const gateValue = gateChannel ? gateChannel[i] : 0;

      // Schmitt edge detection on the gate — same hysteresis law as the
      // trigger processor, for the same noise-rejection reason.
      let rising = false;
      if (!this.armed && gateValue >= SCHMITT_HIGH) {
        this.armed = true;
        rising = true;
      } else if (this.armed && gateValue <= SCHMITT_LOW) {
        this.armed = false;
        this.stage = "release";
      }
      if (this.pendingTrigger) {
        rising = true;
        this.pendingTrigger = false;
      }

      if (rising && (retriggerAllowed || this.stage === "idle" || this.stage === "release")) {
        this.stage = "attack";
      }

      switch (this.stage) {
        case "attack":
          this.level += attackStep;
          if (this.level >= 1) {
            this.level = 1;
            this.stage = "decay";
          }
          break;
        case "decay":
          this.level = sustain + (this.level - sustain) * decayCoefficient;
          if (this.level - sustain < ENVELOPE_SILENCE) {
            this.level = sustain;
            this.stage = "sustain";
          }
          break;
        case "sustain":
          this.level = sustain;
          break;
        case "release":
          this.level *= releaseCoefficient;
          if (this.level < ENVELOPE_SILENCE) {
            this.level = 0;
            this.stage = "idle";
          }
          break;
        default:
          this.level = 0;
      }
      outputChannel[i] = this.level;
    }
    return true;
  }
}

/**
 * SAMPLE & HOLD — latch input[0] whenever the trigger input (input[1]) has a
 * rising edge, and output that held value until the next edge.
 *
 * The classic source of stepped random modulation: noise into the signal input,
 * a clock into the trigger, and the output is a new random level per clock.
 */
class SampleHoldProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.held = 0;
    this.armed = false;
  }

  process(inputs, outputs) {
    const signalInput = inputs[0];
    const triggerInput = inputs[1];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outputChannel = output[0];
    const signalChannel = signalInput && signalInput.length > 0 ? signalInput[0] : null;
    const triggerChannel = triggerInput && triggerInput.length > 0 ? triggerInput[0] : null;

    for (let i = 0; i < outputChannel.length; i++) {
      const triggerValue = triggerChannel ? triggerChannel[i] : 0;
      if (!this.armed && triggerValue >= SCHMITT_HIGH) {
        this.armed = true;
        this.held = signalChannel ? signalChannel[i] : 0;
      } else if (this.armed && triggerValue <= SCHMITT_LOW) {
        this.armed = false;
      }
      outputChannel[i] = this.held;
    }
    return true;
  }
}

/**
 * RISING-EDGE TRIGGER with Schmitt hysteresis — THE AXOLOTI RULING made real.
 *
 * Emits a short unit pulse on every low-to-high transition of the input, and
 * posts a message to the main thread so the engine can drive UI (a blinking
 * light) and fire scheduled events.
 *
 * The hysteresis is the whole point: with a single threshold, a slowly-rising
 * signal carrying any noise crosses that threshold dozens of times and the node
 * machine-guns. Requiring the signal to climb past SCHMITT_HIGH to fire and
 * fall back below SCHMITT_LOW before it can fire again rejects that entirely.
 * The dead band between them is the noise-rejection margin.
 *
 * The output is a PULSE, not a gate: it goes high for `pulseSamples` and
 * returns low regardless of how long the input stays high — the receiver
 * decides whether it wants trigger or gate semantics ("triggers and gates are
 * in the eye of the receiver", research [04]).
 */
class TriggerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "pulseMs", defaultValue: 2, minValue: 0.1, maxValue: 100, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.armed = false;
    this.pulseRemaining = 0;
    this.blockCount = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outputChannel = output[0];
    const inputChannel = input && input.length > 0 ? input[0] : null;
    const pulseSamples = Math.max(1, Math.floor((parameters.pulseMs[0] / 1000) * sampleRate));
    let firedThisBlock = false;

    for (let i = 0; i < outputChannel.length; i++) {
      const value = inputChannel ? inputChannel[i] : 0;

      // The pure state machine from dsp.js schmittStep(), inlined — the worklet
      // scope cannot import, and a function call per sample is avoidable cost.
      if (!this.armed && value >= SCHMITT_HIGH) {
        this.armed = true;
        this.pulseRemaining = pulseSamples;
        firedThisBlock = true;
      } else if (this.armed && value <= SCHMITT_LOW) {
        this.armed = false;
      }

      if (this.pulseRemaining > 0) {
        outputChannel[i] = 1;
        this.pulseRemaining--;
      } else {
        outputChannel[i] = 0;
      }
    }

    // Notify the main thread at most once per block: this drives UI only, and
    // a message per sample would flood the port and stall the audio thread.
    if (firedThisBlock) this.port.postMessage(TRIGGER_FIRED_MESSAGE);
    return true;
  }
}

/** Pre-allocated so the notification path allocates nothing. */
const TRIGGER_FIRED_MESSAGE = { type: "fired" };

registerProcessor("bitcrush-processor", BitcrushProcessor);
registerProcessor("quantize-processor", QuantizeProcessor);
registerProcessor("adsr-processor", ADSRProcessor);
registerProcessor("sample-hold-processor", SampleHoldProcessor);
registerProcessor("trigger-processor", TriggerProcessor);
