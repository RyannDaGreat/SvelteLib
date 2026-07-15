/**
 * Slide TRANSITIONS — the small vertical slice between two slide rows in the
 * Slide Navigator, a first-class SELECTABLE thing whose properties show in the
 * Property Panel (manifest Round 12 "Slides & TRANSITIONS").
 *
 * A transition is stored on the INCOMING slide: `slide.transition = {type,
 * seconds, curve, sound}`. It describes how the presenter animates INTO that
 * slide from its predecessor. Slide 0 has no predecessor, so its transition
 * (if any) is inert.
 *
 * TRANSITIONS ARE TYPED LIKE WIDGETS (user ruling): tween and fade are two
 * CLASSES sharing a COMMON SUPERCLASS. The superclass owns the shared
 * properties every transition has; each type adds its own extras. This module
 * is the small type REGISTRY (shaped like the plugin registry: superclass
 * defaults + per-type extras) so a third type slots in with one entry — no
 * type special-casing anywhere else.
 *
 *   TWEEN — the DEFAULT. The existing delta tween (core/deltas.blendApplied):
 *     properties interpolate from the previous folded state toward this slide's
 *     delta over `seconds`. seconds 0 = instant.
 *   FADE  — crossfade between the previous slide's COMPLETED state (snapshot A,
 *     slide index-1 at alpha 1) and this slide's COMPLETED state (snapshot B,
 *     slide index at alpha 1). Two snapshots, blended by alpha — NOT a delta
 *     tween. Rendered as a pure function of alpha so the CLI can render mid-fade
 *     (render_gpu-side; see web/transitionRender.js).
 *
 * SUPERCLASS properties:
 *   seconds  — transition duration in seconds (0 = instant). SUPERSEDES the
 *              old per-slide `duration` (lead ruling, Round 12): the load-time
 *              migration moves slide.duration → transition.seconds LOUDLY.
 *   curve    — "linear" (raw alpha) | "smooth" (the existing eased alpha).
 *              DEFAULT "smooth": it matches today's eased-alpha playback feel,
 *              so the duration→seconds migration changes NO playback behavior.
 *   sound    — asset reference string, nullable. Round 12B: "a transition can
 *              PLAY A SOUND". The PROPERTY exists and round-trips NOW; actual
 *              audio playback is a later wave (the assets server is parallel
 *              work) — the presenter STUBS playback with a loud TODO.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 *
 * Design note (multi-select): the manifest ratifies that shift-selecting
 * multiple transitions edits the INTERSECTION of their properties EXACTLY like
 * multi-selected objects ("it's all the same thing... unified"). That
 * intersection Property Panel is a SEPARATE milestone; this module only SHAPES
 * the model for it (transitions carry a `type` + a flat property bag, exactly
 * like items carry a `type` + state), it does not build the intersection UI.
 */

/** The default transition duration for a fresh slide, in seconds. Was
 * `slide.duration`'s new-slide value (core/document.js) before seconds
 * superseded it (lead ruling) — same number, so new decks feel identical. */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** The shared superclass defaults every transition type inherits. `curve`
 * defaults to "smooth" (lead ruling — matches today's eased playback, so the
 * duration→seconds migration is behavior-preserving). `sound` is nullable (no
 * sound by default) — the slot exists so it round-trips now. */
export const TRANSITION_BASE_DEFAULTS = { seconds: DEFAULT_TRANSITION_SECONDS, curve: "smooth", sound: null };

/** Valid `curve` values: linear = raw alpha; smooth = the existing eased alpha
 * (interpolators.ease("cubic")). Kept as a named list so the Inspector row, the
 * presenter, and the migration validation share one source of truth. */
export const TRANSITION_CURVES = ["linear", "smooth"];

/**
 * The SUPERCLASS inspector rows — shared by EVERY transition type (prepended to
 * each type's own rows). Row format is IDENTICAL to plugin inspector rows
 * (label, key, kind, min/max/options/category) so Opus10's generic row
 * machinery renders them unchanged — but transitions render these WITHOUT
 * keyframe diamonds (a transition is per-boundary config, not keyframable
 * state; the Inspector suppresses diamonds for kind:"transition" targets).
 *
 * `curve` uses kind "select" with an `options` list — a NEW control kind
 * (enum dropdown). FLAGGED FOR OPUS10: the generic row machinery needs a
 * "select" renderer (SvelteLib Dropdown over `options`); until it lands, curve
 * still round-trips via setTransitionProp. `sound` is kind "asset" (nullable
 * asset-ref string) — ALSO a new kind; the asset picker is a later wave (the
 * assets server is parallel work), so a plain nullable text/asset field is the
 * placeholder. Both are flagged, not silently invented.
 */
export const TRANSITION_BASE_INSPECTOR = [
  { key: "seconds", label: "Seconds", kind: "number", min: 0, scrub: 0.1, category: "transition" },
  { key: "curve", label: "Curve", kind: "select", options: TRANSITION_CURVES, category: "transition" },
  { key: "sound", label: "Sound", kind: "asset", assetKind: "sound", nullable: true, category: "transition" },
];

/**
 * The transition TYPE registry — shaped like the plugin registry (a `type`
 * string, a human `title`, and `defaults` = the type's extra properties beyond
 * the superclass). A third type ("wipe", "push", ...) is one entry here plus a
 * render clause; nothing else in the app enumerates transition types.
 *
 * `tween` MUST be first: it is the DEFAULT type (manifest) and
 * DEFAULT_TRANSITION_TYPE reads TRANSITION_TYPES[0].
 */
export const TRANSITION_TYPES = [
  {
    type: "tween",
    title: "Tween",
    // No extras beyond the superclass: the tween IS the base delta-blend
    // behavior parameterized by seconds + curve.
    defaults: {},
    inspector: [], // superclass rows only
  },
  {
    type: "fade",
    title: "Fade",
    // No extra numeric params in V1 (crossfade is fully described by seconds +
    // curve). Kept as its own class so future fade-only options (e.g. a fade
    // color) land here without touching tween.
    defaults: {},
    inspector: [], // superclass rows only
  },
];

/** The default transition type — the existing delta tween (manifest: "TWEEN
 * (the default)"). */
export const DEFAULT_TRANSITION_TYPE = TRANSITION_TYPES[0].type;

const BY_TYPE = new Map(TRANSITION_TYPES.map((t) => [t.type, t]));

/**
 * Pure function. The transition type descriptor for a type string; loud when
 * unknown (never a silent fallback — an unknown type is a bug or a corrupt
 * document, and the migration path repairs corrupt documents LOUDLY upstream).
 *
 * @example transitionType("fade").title // "Fade"
 * @example transitionType("tween").defaults // {}
 */
export function transitionType(type) {
  const t = BY_TYPE.get(type);
  if (!t) throw new Error(`Unknown transition type "${type}". Registered: ${[...BY_TYPE.keys()].join(", ")}`);
  return t;
}

/**
 * Pure function. The complete default transition record for a type: the
 * superclass defaults merged with that type's extras. This is the canonical
 * shape a fresh transition takes.
 *
 * @example defaultTransition("tween") // {seconds: 0.5, curve: "linear", sound: null, type: "tween"}
 * @example defaultTransition("fade").type // "fade"
 */
export function defaultTransition(type = DEFAULT_TRANSITION_TYPE) {
  return { ...TRANSITION_BASE_DEFAULTS, ...transitionType(type).defaults, type };
}

/**
 * Pure function. The EFFECTIVE transition record for slide `index` of `doc`:
 * the stored `slide.transition` completed with the superclass + type defaults,
 * or the full default TWEEN when the slide stores none. Every consumer (the
 * presenter, the navigator slice, the Inspector) reads THIS so a partially
 * written transition (e.g. an old document, or one where only `type` was set)
 * always has every property present.
 *
 * Slide 0 has no predecessor; callers that animate a transition (the presenter)
 * skip index 0 — this function still returns a record for it (inert), because
 * the navigator/inspector may still address the slice above slide 1 etc.
 *
 * @example resolveTransition({slides: [{}, {transition: {type: "fade"}}]}, 1) // {seconds: 0.5, curve: "linear", sound: null, type: "fade"}
 * @example resolveTransition({slides: [{}, {}]}, 1).type // "tween" (default when unset)
 * @example resolveTransition({slides: [{}, {transition: {type: "tween", seconds: 2, curve: "smooth"}}]}, 1).seconds // 2
 */
export function resolveTransition(doc, index) {
  const stored = doc.slides[index]?.transition;
  const type = stored?.type ?? DEFAULT_TRANSITION_TYPE;
  return { ...defaultTransition(type), ...stored, type };
}

/**
 * Pure function. The full inspector row list for a transition type: the shared
 * superclass rows (seconds/curve/sound) followed by that type's extras. Opus10's
 * generic row machinery renders these (no keyframe diamonds — transitions are
 * config, not keyframable state).
 *
 * @example transitionInspector("tween").map((r) => r.key) // ["seconds", "curve", "sound"]
 * @example transitionInspector("fade").length // 3 (superclass only, in V1)
 */
export function transitionInspector(type) {
  return [...TRANSITION_BASE_INSPECTOR, ...transitionType(type).inspector];
}

/**
 * Pure function. A transition record whose `type` is changed to `newType` while
 * PRESERVING the superclass properties (seconds/curve/sound survive) and
 * DROPPING the old type's extras in favor of the new type's defaults (lead
 * ruling: switchTransitionType preserves the base, swaps the class). The
 * incoming `transition` is completed with defaults first so a partial record
 * still yields a full one.
 *
 * @example retypedTransition({type: "tween", seconds: 2, curve: "smooth", sound: "ding"}, "fade") // {seconds: 2, curve: "smooth", sound: "ding", type: "fade"}
 * @example retypedTransition(undefined, "fade").type // "fade"
 */
export function retypedTransition(transition, newType) {
  const cur = { ...TRANSITION_BASE_DEFAULTS, ...transition };
  // Keep only the superclass keys from the current record; re-seed the type's
  // own extras from the NEW type's defaults (no stale extras from the old type).
  const base = {};
  for (const k of Object.keys(TRANSITION_BASE_DEFAULTS)) base[k] = cur[k];
  return { ...base, ...transitionType(newType).defaults, type: newType };
}

/**
 * Pure function. Slides whose legacy `duration` must migrate to a
 * `transition.seconds` (lead ruling, Round 12: transition.seconds SUPERSEDES
 * slide.duration). Each such slide becomes `transition = {type: "tween",
 * seconds: <duration>, curve: "smooth", sound: null}` and `duration` is
 * stripped. curve "smooth" preserves today's eased-alpha playback exactly, so
 * the migration changes NO playback behavior. A slide that ALREADY has a
 * `transition` keeps it (its seconds is authoritative); its stale `duration`
 * is only dropped. REPORTING IS THE CALLER'S JOB (console.error per slide at
 * the load boundary — silent repairs are forbidden, the withLegacyKeysRenamed
 * / meta.fps-strip precedents).
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {index, slideId, seconds, stale}[] — one entry per slide carrying a legacy
 *   `duration`. `stale: true` means the slide already had a transition, so
 *   only the duplicate `duration` was dropped (its transition.seconds wins).
 *
 * @example durationMigrations({slides: [{id: "a", duration: 2, delta: {}}]}) // [{index: 0, slideId: "a", seconds: 2, stale: false}]
 * @example durationMigrations({slides: [{id: "a", delta: {}}]}) // [] (nothing to migrate)
 */
export function durationMigrations(doc) {
  const out = [];
  doc.slides.forEach((s, index) => {
    if ("duration" in s)
      out.push({ index, slideId: s.id, seconds: s.duration, stale: !!s.transition });
  });
  return out;
}

/**
 * Pure function. Document with every legacy `slide.duration` moved to
 * `slide.transition.seconds` (see durationMigrations) and `duration` stripped.
 * Idempotent: a migrated document reports nothing and comes back unchanged.
 *
 * @example withDurationMigrated({slides: [{id: "a", duration: 2, delta: {}}]}).doc.slides[0].transition // {type: "tween", seconds: 2, curve: "smooth", sound: null}
 * @example withDurationMigrated({slides: [{id: "a", duration: 2, delta: {}}]}).doc.slides[0].duration // undefined (stripped)
 */
export function withDurationMigrated(doc) {
  const migrated = durationMigrations(doc);
  if (migrated.length === 0) return { doc, migrated };
  const byIndex = new Map(migrated.map((m) => [m.index, m]));
  const slides = doc.slides.map((s, index) => {
    if (!byIndex.has(index)) return s;
    const { duration, ...rest } = s; // strip the legacy key
    // Only synthesize a transition when the slide doesn't already carry one
    // (stale: its own transition.seconds is authoritative). The synthesized
    // record is a full default tween with seconds taken from the old duration.
    return byIndex.get(index).stale
      ? rest
      : { ...rest, transition: { ...defaultTransition("tween"), seconds: duration } };
  });
  return { doc: { ...doc, slides }, migrated };
}
