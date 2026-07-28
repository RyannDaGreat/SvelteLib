/**
 * RENDER CENTER SETTINGS — the pure vocabulary of the New-render form: its
 * bounds, its codec constants, the mapping from a finished JOB back into form
 * settings ("use these settings"), and the sanitizer that makes persisted
 * settings trustworthy across schema drift.
 *
 * Pure and DOM-free so every function doctests from bare node. Storage itself
 * (localStorage) is passed IN by the caller — load/save here are thin and take
 * the Storage object as an argument, which is also what lets the doctests use a
 * plain Map-backed fake.
 *
 * WHY A SANITIZER RATHER THAN A VERSION FIELD: persisted settings outlive the
 * form's schema (a renamed option, a removed field, a hand-edited localStorage).
 * Versioning would throw the whole object away on every schema change;
 * sanitizing keeps every field that still makes sense and falls back to the
 * default for each one that does not — per FIELD, loudly never, silently never
 * wrong (an out-of-range number is clamped, an unknown enum falls back).
 */

// ── Codec constants (moved here from serverMp4Encoder.js, which re-exports
// them: they are pure facts about libx264, and this module is the one place in
// the import chain that bare node can reach — serverMp4Encoder pulls in
// projectApi, which reads `location` at module level). ─────────────────────────
/** The codec CRF each one-word quality choice means (libx264; lower = better). */
export const QUALITY_CRF = { low: 28, medium: 23, high: 18 };
/** libx264 CRF bounds: 0 = lossless (huge), 51 = worst. */
export const CRF_MIN = 0;
export const CRF_MAX = 51;
/** Default CRF when quality is unspecified (x264's own default == "medium"). */
export const DEFAULT_CRF = QUALITY_CRF.medium;

// ── Form bounds (moved here from RenderCenterModal.svelte so the sanitizer and
// the form clamp with the SAME numbers). ──────────────────────────────────────
export const MIN_DIM = 16;
export const MAX_DIM = 7680; // 8K wide — beyond that, encoding gets impractical
export const MIN_FPS = 1;
export const MAX_FPS = 120;
export const MAX_HOLD_SECONDS = 60;
export const MIN_SAMPLES = 1;
export const MAX_SAMPLES = 16; // temporal subsamples per frame (motion blur); >16 rarely worth the cost

/** The fixed resolution presets (the form adds "camera" and "custom" around
 *  these — camera needs the live camera size, which only the form knows). */
export const STANDARD_RESOLUTIONS = [
  { value: "2160", label: "4K — 3840×2160", w: 3840, h: 2160 },
  { value: "1440", label: "QHD — 2560×1440", w: 2560, h: 1440 },
  { value: "1080", label: "1080p — 1920×1080", w: 1920, h: 1080 },
  { value: "720", label: "720p — 1280×720", w: 1280, h: 720 },
  { value: "480", label: "480p — 854×480", w: 854, h: 480 },
];

/** The one localStorage key. Global, not per-project: fps/resolution/quality are
 *  authoring preferences, not document facts. */
export const SETTINGS_KEY = "powerrp.renderCenterSettings";

/**
 * Pure function. Largest even integer ≤ v, clamped to [MIN_DIM, MAX_DIM] —
 * H.264 4:2:0 needs even dimensions. (Moved from RenderCenterModal.svelte.)
 *
 * @param {number} v - Desired dimension in px
 * @returns {number}
 *
 * @example evenDim(721)  // 720
 * @example evenDim(3)    // 16
 * @example evenDim(1e9)  // 7680
 */
export function evenDim(v) {
  const n = Math.round(v);
  return Math.max(MIN_DIM, Math.min(MAX_DIM, n - (n % 2)));
}

/**
 * Pure function. The form's `resolution` choice that reproduces width×height:
 * "camera" when it matches the live camera size (checked FIRST — the camera is
 * the default and follows the deck, so a job rendered at camera size stays
 * camera-relative), else the matching standard preset, else "custom".
 *
 * @param {number} width - Output width in px
 * @param {number} height - Output height in px
 * @param {number} camW - The live camera width in px
 * @param {number} camH - The live camera height in px
 * @returns {string} A resolution choice value
 *
 * @example matchResolution(1280, 720, 1280, 720) // "camera"
 * @example matchResolution(1280, 720, 1920, 1080) // "720"
 * @example matchResolution(1234, 720, 1920, 1080) // "custom"
 */
export function matchResolution(width, height, camW, camH) {
  if (width === camW && height === camH) return "camera";
  const preset = STANDARD_RESOLUTIONS.find((r) => r.w === width && r.h === height);
  return preset ? preset.value : "custom";
}

/**
 * Pure function. The form's `codecQuality` choice that reproduces a CRF: the
 * matching one-word preset, else "custom".
 *
 * @param {number} crf - libx264 CRF
 * @returns {string} A codec-quality choice value
 *
 * @example matchCodecQuality(23) // "medium"
 * @example matchCodecQuality(17) // "custom"
 */
export function matchCodecQuality(crf) {
  const entry = Object.entries(QUALITY_CRF).find(([, v]) => v === crf);
  return entry ? entry[0] : "custom";
}

/**
 * Pure function. A job record's settings, as a form-settings patch — the "use
 * these settings" mapping. Wire words map back to form words ("client" →
 * "browser"); width/height and CRF collapse back into their presets when they
 * match (matchResolution/matchCodecQuality); the slide range clamps into the
 * CURRENT deck and becomes "all" when it spans it. customW/H and customCrf are
 * always set from the job so switching to Custom afterwards starts from the
 * copied values. `browserEncoder` is absent deliberately: the server does not
 * record which encoder a browser job used.
 *
 * @param {object} job - A job record ({name, backend, params}) as server.py's job_view returns it
 * @param {number} slideCount - The CURRENT deck's slide count
 * @param {number} camW - The live camera width in px
 * @param {number} camH - The live camera height in px
 * @returns {object} A partial settings object (see sanitizeSettings for the full shape)
 *
 * @example settingsFromJob({name: "Fig1", backend: "client", params: {width: 1280, height: 720, fps: 30, crf: 23, samples: 2, startIndex: 0, endIndex: 6, includeTransitions: true, holdSeconds: 2, background: "#000000"}}, 7, 1920, 1080).backend // "browser"
 * @example settingsFromJob({name: "Fig1", backend: "server", params: {width: 1280, height: 720, fps: 30, crf: 23, samples: 1, startIndex: 0, endIndex: 6, includeTransitions: true, holdSeconds: 2, background: "#000000"}}, 7, 1920, 1080).resolution // "720"
 * @example settingsFromJob({name: "Fig1", backend: "server", params: {width: 1280, height: 720, fps: 30, crf: 17, samples: 1, startIndex: 0, endIndex: 6, includeTransitions: true, holdSeconds: 2, background: "#000000"}}, 7, 1920, 1080).codecQuality // "custom"
 * @example settingsFromJob({name: "Fig1", backend: "server", params: {width: 1280, height: 720, fps: 30, crf: 23, samples: 1, startIndex: 0, endIndex: 6, includeTransitions: true, holdSeconds: 2, background: "#000000"}}, 7, 1920, 1080).rangeMode // "all"
 * @example settingsFromJob({name: "Fig1", backend: "server", params: {width: 1280, height: 720, fps: 30, crf: 23, samples: 1, startIndex: 2, endIndex: 4, includeTransitions: true, holdSeconds: 2, background: "#000000"}}, 7, 1920, 1080).rangeFrom // 3
 */
export function settingsFromJob(job, slideCount, camW, camH) {
  const p = job.params;
  const from = Math.max(1, Math.min(slideCount, p.startIndex + 1));
  const to = Math.max(from, Math.min(slideCount, p.endIndex + 1));
  return {
    name: job.name,
    backend: job.backend === "client" ? "browser" : "server",
    resolution: matchResolution(p.width, p.height, camW, camH),
    customW: evenDim(p.width),
    customH: evenDim(p.height),
    fps: p.fps,
    codecQuality: matchCodecQuality(p.crf),
    customCrf: p.crf,
    rangeMode: from === 1 && to === slideCount ? "all" : "custom",
    rangeFrom: from,
    rangeTo: to,
    includeTransitions: p.includeTransitions,
    holdSeconds: p.holdSeconds,
    background: p.background,
    samples: p.samples,
  };
}

/** Per-field validators: each returns the value to KEEP, falling back to the
 *  provided default. Enum fields fall back on any unknown value; numeric fields
 *  clamp; the deck-relative range clamps against slideCount at LOAD time (the
 *  deck may have shrunk since the settings were saved). */
const FIELD_RULES = {
  backend: (v, d) => (["server", "browser"].includes(v) ? v : d),
  resolution: (v, d) =>
    (v === "camera" || v === "custom" || STANDARD_RESOLUTIONS.some((r) => r.value === v) ? v : d),
  customW: (v, d) => (Number.isFinite(v) ? evenDim(v) : d),
  customH: (v, d) => (Number.isFinite(v) ? evenDim(v) : d),
  fps: (v, d) => (Number.isFinite(v) ? Math.max(MIN_FPS, Math.min(MAX_FPS, Math.round(v))) : d),
  codecQuality: (v, d) => (v === "custom" || QUALITY_CRF[v] !== undefined ? v : d),
  customCrf: (v, d) => (Number.isFinite(v) ? Math.max(CRF_MIN, Math.min(CRF_MAX, Math.round(v))) : d),
  rangeMode: (v, d) => (["all", "custom"].includes(v) ? v : d),
  rangeFrom: (v, d, slideCount) => (Number.isFinite(v) ? Math.max(1, Math.min(slideCount, Math.round(v))) : d),
  rangeTo: (v, d, slideCount) => (Number.isFinite(v) ? Math.max(1, Math.min(slideCount, Math.round(v))) : d),
  includeTransitions: (v, d) => (typeof v === "boolean" ? v : d),
  holdSeconds: (v, d) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_HOLD_SECONDS, v)) : d),
  background: (v, d) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d),
  samples: (v, d) => (Number.isFinite(v) ? Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(v))) : d),
  browserEncoder: (v, d, _slideCount, encoders) => (encoders.includes(v) ? v : d),
};

/**
 * Pure function. A COMPLETE, trustworthy settings object from anything: every
 * key in `defaults` passes its field rule (unknown enum → default, out-of-range
 * number → clamped, wrong type → default), keys the schema does not know are
 * dropped, keys the input lacks come from `defaults`. `raw` may be null.
 *
 * Args:
 *   raw (object|null): parsed persisted settings, or a settingsFromJob patch
 *   defaults (object): the form's default settings — also the SCHEMA (its keys
 *     decide which fields exist; a key of defaults with no FIELD_RULE is kept
 *     as the default, so a new form field fails safe until a rule is written)
 *   slideCount (number): current deck's slide count (bounds the range fields)
 *   encoders (string[]): valid browserEncoder values (browserJobView's list —
 *     passed in, not imported, to keep this module leaf-pure)
 *
 * Returns:
 *   object — same keys as `defaults`
 *
 * @example sanitizeSettings(null, {fps: 30}, 5, []) // {fps: 30}
 * @example sanitizeSettings({fps: 9999, junk: 1}, {fps: 30}, 5, []) // {fps: 120}
 * @example sanitizeSettings({backend: "cloud"}, {backend: "server"}, 5, []) // {backend: "server"}
 * @example sanitizeSettings({rangeTo: 99}, {rangeTo: 5}, 5, []) // {rangeTo: 5}
 * @example sanitizeSettings({name: 7}, {name: "Render", fps: 30}, 5, []) // {name: "Render", fps: 30}
 */
export function sanitizeSettings(raw, defaults, slideCount, encoders) {
  const out = {};
  for (const [key, dflt] of Object.entries(defaults)) {
    const rule = FIELD_RULES[key];
    const value = raw?.[key];
    if (key === "name") {
      out[key] = typeof value === "string" && value.trim() ? value : dflt;
    } else if (rule) {
      out[key] = value === undefined ? dflt : rule(value, dflt, slideCount, encoders);
    } else {
      out[key] = dflt; // unknown-to-the-sanitizer field: fail safe to the default
    }
  }
  return out;
}

/**
 * Query (reads the given Storage). The persisted settings, sanitized against
 * `defaults` — or plain defaults when nothing (or garbage) is stored. Garbage
 * is REPORTED (console.error) and replaced, never silently obeyed or thrown.
 *
 * @param {Storage} storage - localStorage (or a {getItem} fake in tests)
 * @param {object} defaults - see sanitizeSettings
 * @param {number} slideCount - see sanitizeSettings
 * @param {string[]} encoders - see sanitizeSettings
 * @returns {object} A complete settings object
 *
 * @example loadSettings({getItem: () => null}, {fps: 30}, 5, []) // {fps: 30}
 * @example loadSettings({getItem: () => '{"fps": 24}'}, {fps: 30}, 5, []) // {fps: 24}
 */
export function loadSettings(storage, defaults, slideCount, encoders) {
  const text = storage.getItem(SETTINGS_KEY);
  if (text === null) return sanitizeSettings(null, defaults, slideCount, encoders);
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error(`Render Center: persisted settings are not JSON (${e.message}) — using defaults.`);
  }
  return sanitizeSettings(raw, defaults, slideCount, encoders);
}

/**
 * Command (writes the given Storage). Persist a settings object.
 *
 * @param {Storage} storage - localStorage (or a {setItem} fake in tests)
 * @param {object} settings - a complete settings object
 *
 * @example // saveSettings(localStorage, settings); localStorage.getItem(SETTINGS_KEY) // JSON of settings
 */
export function saveSettings(storage, settings) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Command (writes the given Storage). Forget the persisted settings — the
 * "Reset to defaults" storage half (the form resets its own state).
 *
 * @param {Storage} storage - localStorage (or a {removeItem} fake in tests)
 *
 * @example // clearSettings(localStorage); localStorage.getItem(SETTINGS_KEY) // null
 */
export function clearSettings(storage) {
  storage.removeItem(SETTINGS_KEY);
}
