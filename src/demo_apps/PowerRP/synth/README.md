# PowerRP Synth Engine

A browser modular-synth engine. **Separate library: ZERO PowerRP imports.**
PowerRP controls the synth; the synth never reaches back. (Blueprint ENGINE law;
pinned by a test in `tests/synth_engine_test.js`.)

## Running the proof page

`dev.html` needs a static server — ES modules will not load over `file://`.
From this directory:

```bash
python3 -m http.server 8712
# then open http://localhost:8712/dev.html
```

Press **Start Audio** first: browsers refuse to start an AudioContext without a
user gesture, so the page opens suspended and says so rather than looking broken.

Then:
- **Pad Drone / Sequenced Dings / Whoosh** — the three demo patches. Selecting
  one disposes the previous.
- **Instantiate All** — builds and disposes every module type against the real
  AudioContext. This is the smoke test.
- **Measure Rewire** — reports the true cost of a glitch-free rewire on this
  machine (call time vs. settle time).

No build step, no framework, no Vite, no PowerRP.

## Tests

```bash
node ../tests/synth_engine_test.js
```

Covers the pure parts only — IR generation, scheduler arithmetic, param
clamping, FM ratios, the Schmitt state machine, and the architectural rules
(no PowerRP imports, worklet/dsp constant agreement). AudioContext behavior is
proven by `dev.html` and a browser probe in wave 2.

## Files

| File | What it is |
|---|---|
| `engine.js` | The API surface. Graph, glitch-free rewiring, meters, transport. |
| `dsp.js` | Pure math, DOM-free, bare-node testable. |
| `modules.js` | 23 module factories (18 native AudioNodes, 5 AudioWorklet). |
| `scheduler.js` | Two-clock lookahead scheduler (25 ms timer / 100 ms window). |
| `patches.js` | The three demo patches, built only from the public API. |
| `worklets/processors.js` | The 5 AudioWorklet processors. Runs on the audio thread. |
| `dev.html` | Standalone proof page and perf harness. |

## The API

```js
const engine = createEngine();
await engine.init();                       // loads the worklets
engine.addModule("pad", "pad1", { frequency: 82.4 });
engine.addModule("output", "out");
engine.connect("pad1", "out", "out", "in");
await engine.resume();                     // must be from a user gesture
```

- `addModule(type, id, params)` / `removeModule(id)`
- `connect(srcId, srcPort, dstId, dstPort)` / `disconnect(...)` — both return a
  promise resolving when the wire ACTUALLY switches (~33 ms).
- `setParam(id, key, value, { rampSeconds })` — knob moves.
- `paramNode(id, key)` — the raw AudioParam, for scheduled ENVELOPES. `setParam`
  structurally cannot express one: successive calls land at the same
  `currentTime` and collide.
- `trigger(id, port, time, options)` — strike a bell, open an envelope.
- `subscribeMeter(id, cb)` / `subscribeSpectrum(id, cb)` — return unsubscribers.
- `suspend()` / `resume()` / `dispose()`, `isRunning()`, `inspect()`, `scheduler`.

## Why rewiring does not click

`connect`/`disconnect` on a live graph is a step discontinuity in the waveform,
and a step is broadband — you hear it as a click. Every topology change here is
sandwiched: the affected output's private **guard gain** ramps to zero
(`setTargetAtTime`, 8 ms), the wire is switched once that has settled, then the
gain ramps back. Guards are per **output port**, not per module, so rewiring one
output never ducks another — and the sequencer's `pitch` and `gate` stay
separate signals.
