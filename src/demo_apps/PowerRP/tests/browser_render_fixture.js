/**
 * THE PROBE DECK — one document fixture shared by every browser-render probe, so
 * a measurement, a resume test and a particle test all describe the same movie.
 *
 * It is built from the PLUGIN REGISTRY's own defaults rather than hand-written
 * item literals, because a hand-written item drifts the moment a plugin gains a
 * property and then `repairedDocument` starts reporting repairs — which the
 * house rule says a fixture must never do. `makeProbeDoc` therefore runs IN THE
 * PAGE (it needs the registry) and is exported as a source STRING that the probe
 * injects, keeping this file free of browser imports so it stays node-readable.
 *
 * The deck: two slides, a camera, one flat shape whose colour changes on slide 2
 * (so a wrong-slide frame is visibly wrong, not merely unequal) and — optionally
 * — a particle emitter, which is the RECORDABLE-STATE hazard: it reads the
 * ambient clock, so a render that does not drive presentation time produces a
 * frozen sparkler with no error at all.
 */

/** Frame geometry of the probe deck. Small on purpose: these probes measure the
 *  PIPELINE, and a 1080p fixture would spend all its time in SwiftShader. */
export const PROBE_WIDTH = 320;
export const PROBE_HEIGHT = 240;
/** Two slides × HOLD seconds at PROBE_FPS, no transitions → PROBE_FRAMES frames. */
export const PROBE_FPS = 10;
export const PROBE_HOLD_SECONDS = 1;
export const PROBE_FRAMES = 20;

/**
 * Pure function. The probe deck as a plain document object, given a plugin
 * registry (needed for each widget type's defaults).
 *
 * @param {object} registry Plugin registry (core/registry.js createRegistry).
 * @param {object} [o]
 * @param {boolean} [o.particles] Include a particle emitter (recordable state).
 * @returns {object} a PowerRP document
 *
 * @example
 * // probeDoc(registry).slides.length // 2
 * @example
 * // Object.keys(probeDoc(registry, {particles: true}).slides[0].delta.items).length // 3
 */
export function probeDoc(registry, { particles = false } = {}) {
  const item = (type, overrides) => ({ ...registry.get(type).defaults, ...overrides });
  const items = {
    cam00001: item("camera", {
      x: 0, y: 0, w: PROBE_WIDTH, h: PROBE_HEIGHT, z: 1000, background: "#101828",
    }),
    shp00001: item("shape", {
      x: 40, y: 40, w: 120, h: 90, z: 3, fill: "#e05f2a", shape: "hexagon",
    }),
  };
  if (particles) {
    items.par00001 = item("particles", {
      x: 150, y: 60, w: 100, h: 100, z: 5,
      // A dense, fast, long-lived stream: every frame must differ, and a slow
      // emitter could coincidentally look identical between adjacent frames.
      particleRate: 300, particleLifetime: 3, particleSpeedMin: 60, particleSpeedMax: 160,
      particleSpread: 360, particleSizeMin: 3, particleSizeMax: 7,
    });
  }
  const slide = (id, name, delta) => ({
    id, name, delta,
    transition: { type: "tween", seconds: 0, curve: "smooth", sound: null },
  });
  return {
    meta: { name: "BrowserRenderProbe", slideW: PROBE_WIDTH, slideH: PROBE_HEIGHT },
    slides: [
      slide("slide0001", "Slide 1", { items }),
      slide("slide0002", "Slide 2", { items: { shp00001: { fill: "#2a7fe0" } } }),
    ],
  };
}

/**
 * Pure function. The render-job params for the probe deck at `width`×`height`.
 * One place so the measurement and the resume probe submit identical jobs.
 *
 * @example probeParams().fps // 10
 * @example probeParams({width: 64, height: 48}).width // 64
 */
export function probeParams({ width = PROBE_WIDTH, height = PROBE_HEIGHT, samples = 1, crf = 28 } = {}) {
  return {
    width, height, fps: PROBE_FPS, crf, samples,
    startIndex: 0, endIndex: 1, includeTransitions: false,
    holdSeconds: PROBE_HOLD_SECONDS, background: "#000000", quality: "full",
  };
}
