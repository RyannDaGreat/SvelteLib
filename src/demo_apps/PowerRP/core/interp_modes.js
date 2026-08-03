/**
 * PER-PROPERTY INTERPOLATION MODES — the plumbing layer.
 *
 * ── THE FEATURE (user request, 2026-08-02, verbatim) ──────────────────────────
 *   "it should be possible that we can control how any property interpolates by
 *    having a second property on it that doesn't interpolate… let's say the x
 *    property. We have another property that says, like, xinterp property that,
 *    by default, is just linear or tween… I might have another option, which
 *    would be, like, wiggle or step, which would just, in that case, then the
 *    property x would just immediately move, just like a discrete property,
 *    because the xinterp property told it to. And the xinterp property flicked
 *    immediately at the beginning, which means that it determined how x
 *    interpolates. Even visible could have options for interpolate… by default,
 *    right now, would just be step, like a step function."
 *
 * So: every keyframeable property gets an OPTIONAL sibling saying HOW it blends
 * across a transition. Absent = exactly today's behavior.
 *
 * ── SUPERSEDES A PAST-CLAUDE OPINION ─────────────────────────────────────────
 * core/interpolators.js used to end its discrete rule with "if you want a fade,
 * author one with opacity". That was past-Claude editorializing AGAINST this
 * feature, not a user ruling: it is the reason a `visible` boolean has only ever
 * had ONE blend law. The sentence is gone; a property picks its own law now, and
 * the fade/blend/morph modes ride the registry below rather than being refused.
 *
 * ── STORAGE: A SIBLING COMPANION KEY, `"<key>~interp"` ────────────────────────
 * The mode for state key `x` lives at state key `x~interp`, IN THE SAME OBJECT.
 * It is a PLAIN PROPERTY — no special case anywhere. It rides the existing delta
 * machinery, keyframes on a slide, undoes, folds, copies and serializes exactly
 * like `x` does, because as far as every one of those layers is concerned it IS
 * just another leaf. That is the whole point of the storage choice: the feature
 * costs deltas/undo/keyframes ZERO new concepts.
 *
 * WHY THE `~` SUFFIX RATHER THAN `xInterp` OR `x@interp`, measured against the
 * four namespaces the key has to survive:
 *
 *   1. DELTA PATHS (core/deltas.js setPath/getPath/leaves) join segments with
 *      "." and treat a dot as DESCENT. So the marker must not be a dot —
 *      `x.interp` would make the mode a CHILD of x, i.e. turn the leaf `x` into
 *      a tree and break every reader of it. `~` is inert to path splitting.
 *   2. EQUATIONS (core/expressions.js REF_RE = /^@?[A-Za-z0-9_]+(...)/) can only
 *      tokenize identifier characters. `~` is NOT one, so `x~interp` is
 *      STRUCTURALLY UNREACHABLE from any equation — nobody can bind a mode to a
 *      formula, and no mode key can shadow or be shadowed by a real property
 *      slug. That is a FEATURE, not an accident: a mode must be a stepped
 *      literal for the mode-steps-at-start rule (below) to mean anything, and
 *      making it unreferenceable enforces that in the grammar instead of in a
 *      runtime check. `x@interp` fails this test differently — `@` is already
 *      the STORED ITEM REF prefix, so it reads as a cross-item reference to
 *      anyone who knows the language.
 *   3. THE PROPERTY NAMESPACE. `xInterp` is a legal author-facing property name
 *      that a plugin could genuinely want ("interp" as a widget's own knob), and
 *      camelToSnake would render it `x_interp` in the equation UI — i.e. it
 *      LOOKS like an ordinary property and collides with one. `~` cannot appear
 *      in a plugin-declared key (they are all identifiers), so the namespace is
 *      provably disjoint.
 *   4. REPO PRECEDENT. `~` already marks the machine namespace here:
 *      web/draftKeys.js `~draft/` and web/storagePath.js `~storage/` exist for
 *      exactly this reason — a sigil no user-authored string can contain. This
 *      is the same argument one level down, on state keys instead of storage
 *      keys.
 *
 * ── ABSENT = TODAY, BYTE-IDENTICAL ───────────────────────────────────────────
 * No migration, no defaults-fill, no repair report. A document written before
 * this module has no `~interp` key anywhere and folds to the same bytes it
 * always did, because DEFAULT_MODE's blend IS `interpolate` unchanged. Same
 * absent-is-legacy precedent as the gradient center/wavelength/phase keys.
 *
 * ── THE MODE ITSELF STEPS AT TRANSITION START (user ruling) ───────────────────
 * "the xinterp property flicked immediately at the beginning, which means that
 * it determined how x interpolates." So the mode is resolved ONCE, at the top of
 * the transition, to the TARGET mode: as soon as alpha > 0 the incoming slide's
 * mode governs the whole blend of `x`. That falls out of the storage choice for
 * free — a string leaf is already discrete under `interpolate`, so the delta's
 * mode value simply wins from the first frame. `modeForBlend` below makes it
 * explicit rather than relying on that coincidence, because a future mode name
 * that is not a string must behave the same way.
 *
 * ── THE REGISTRY SEAM (how fade/blend/morph land WITHOUT touching deltas) ─────
 * An entry is `{id, label, help, blend}`:
 *
 *     blend(a, b, alpha, ctx) -> value
 *
 *   a      the CURRENT folded value (lazy start capture — the value the property
 *          actually shows at the start of this transition, never a baked
 *          keyframe). May be `undefined` for an ADDITION (the key is not in the
 *          state yet).
 *   b      the delta's target value.
 *   alpha  transition strength, strictly in (0, 1). A mode is NEVER consulted at
 *          the endpoints: at alpha 0 the answer is `a` and at alpha 1 it is `b`,
 *          by definition of the fold — `applied()` IS `blendApplied(…, 1)`, and
 *          core/document.js slideState folds every slide through it, so a mode
 *          that disagreed at 1 would rewrite the document's own stored values in
 *          every cached slide state and every export. That is enforced at the
 *          ONE call site in core/deltas.mutBlendApply, not trusted to each mode,
 *          so a wave cannot break the fold by writing a careless `blend`.
 *   ctx    `{key, mode, params}` — the state key being blended, the resolved mode
 *          id, and the mode's own PARAMETER values (see MODE PARAMETERS below;
 *          `{}` for the modes that declare none, which is all but `blurFade`).
 *          THIS IS THE EXTENSION POINT, and `params` is the first thing to have
 *          used it. A future mode that needs more (the whole owning state object
 *          for `morph`, the plugin registry for `blend`) gets it by adding a
 *          FIELD TO ctx at the ONE call site in core/deltas.mutBlendApply — the
 *          mode entries themselves, this module's exports, and every existing
 *          caller are untouched, because ctx is a bag and every mode ignores the
 *          fields it does not read.
 *
 * A `blend` MUST BE PURE and a function of (a, b, alpha, ctx) alone — no clocks,
 * no randomness, no ambient state. The determinism law is not weakened by this
 * feature: a mode lookup reads document state and nothing else.
 *
 * REGISTERING A MODE is `registerInterpMode(entry)`, and the follow-up waves are
 * expected to call it from their OWN files (fade from the visibility wave, blend
 * from the materials wave, morph from the retype wave) — that is why this module
 * exports a mutator instead of a frozen literal. Registration is idempotent-free
 * on purpose: re-registering an id THROWS, so two waves cannot silently claim
 * the same name.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { interpolate } from "./interpolators.js";

/**
 * The sigil joining a property key to its interpolation-mode companion.
 * See the module docblock for why it is `~` and not `.`/`@`/camelCase.
 */
export const INTERP_KEY_SUFFIX = "~interp";

/** The mode a property has when it declares none — today's behavior, exactly. */
export const DEFAULT_INTERP_MODE = "tween";

/**
 * Pure function. The companion state key holding `key`'s interpolation mode.
 *
 * A DOTTED key works without a special case, and that is the second reason the
 * suffix is not a dot: appending to `rotationAnchor.x` gives
 * `rotationAnchor.x~interp`, which splits on "." into
 * `["rotationAnchor", "x~interp"]` — the SIBLING of `x` INSIDE `rotationAnchor`,
 * which is exactly where mutBlendApply's per-level recursion looks for it.
 *
 * @example interpKeyFor("x") // "x~interp"
 * @example interpKeyFor("visible") // "visible~interp"
 * @example interpKeyFor("rotationAnchor.x") // "rotationAnchor.x~interp" (splits to ["rotationAnchor", "x~interp"])
 */
export function interpKeyFor(key) {
  return `${key}${INTERP_KEY_SUFFIX}`;
}

/**
 * Pure function. True for a companion mode key (so a reader that walks a state
 * object can tell the plumbing apart from the properties).
 *
 * @example isInterpKey("x~interp") // true
 * @example isInterpKey("x") // false
 */
export function isInterpKey(key) {
  return typeof key === "string" && key.endsWith(INTERP_KEY_SUFFIX);
}

/**
 * Pure function. The property a companion mode key belongs to, or null.
 *
 * @example propertyOfInterpKey("cornerRadius~interp") // "cornerRadius"
 * @example propertyOfInterpKey("cornerRadius") // null
 */
export function propertyOfInterpKey(key) {
  return isInterpKey(key) ? key.slice(0, -INTERP_KEY_SUFFIX.length) : null;
}

// ── MODE PARAMETERS: `"<key>~interp~<param>"` (WORKSTREAM AP) ─────────────────
//
// User request, 2026-08-02, verbatim: "BlurFade should have suboptions, by the
// way. For BlurFade, I should be able to choose how blurry was it, right? What
// is the difference in blur? BlurFade is too subtle for me right now, so I can't
// adjust it. It would be nice to be able to adjust it…"
//
// A mode was previously a bare id and nothing else, so every number a mode's
// picture depended on had to be a Claude-chosen module constant. That is exactly
// what the user overruled: BLUR_FADE_MAX_RADIUS was one, and "too subtle for me"
// is a sentence a constant cannot answer. So a mode may now DECLARE PARAMETERS,
// and an author sets them per keyframe like any other property.
//
// ── THE KEY SHAPE, AND WHY IT EXTENDS THE SAME FAMILY ────────────────────────
// The parameter `p` of the mode on state key `x` lives at state key
// `x~interp~p`, IN THE SAME OBJECT — one more `~` segment on the companion key
// this module already owns. Every argument in the module docblock's four-way
// namespace test carries over UNCHANGED, because the sigil is the same one:
//
//   1. DELTA PATHS still split on "." only, so `x~interp~blur` is one leaf and
//      a dotted property's parameter (`rotationAnchor.x~interp~p`) still splits
//      to the SIBLING inside `rotationAnchor` — the same free win `~interp` got.
//   2. EQUATIONS still cannot tokenize `~` (REF_RE is identifier characters), so
//      a parameter is STRUCTURALLY UNREACHABLE from a formula. That is the same
//      feature it is for the mode itself: a parameter must be a stepped literal
//      for the mode-steps-at-start rule to mean anything on it too.
//   3. THE PROPERTY NAMESPACE stays provably disjoint (no plugin key contains
//      `~`), and a parameter cannot collide with a mode key either: `isInterpKey`
//      is a SUFFIX test, so `x~interp~blur` does not answer it and the two
//      grammars never confuse a reader walking a state bag.
//   4. It is still one plain leaf — deltas, keyframes, undo, copy and serialize
//      cost ZERO new concepts, which is the whole reason `~interp` was stored
//      this way in the first place.
//
// WHY NOT A NESTED OBJECT (`x~interp: {mode, blur}`). Because the mode leaf is
// already a STRING in every shipped document, and a mode that grew an object
// value would need a migration, a repair report and a shape check at every read.
// A sibling key needs none of that: ABSENT = THE MODE'S OWN DEFAULT, so every
// document written before this exists folds byte-identically and no repair runs.
// It also keeps ONE parameter keyframable independently of the mode, which is
// what an author actually wants ("adjust it" is a scrub, not a re-pick).
//
// ── HOW A PARAMETER REACHES THE PICTURE ──────────────────────────────────────
// core/deltas.mutBlendApply gathers the declared parameters beside the mode and
// hands them to `blend` in `ctx.params`; a visibility mode folds them into its
// `~visibleFx` token as SCALARS (the token's standing rule), and the render seam
// reads them there. So a parameter travels exactly the road the mode id travels,
// and nothing between the fold and the paint learns a new shape.

/** The sigil segment joining an interp companion key to one of its parameters. */
export const INTERP_PARAM_SEPARATOR = "~";

/**
 * Pure function. The state key holding parameter `param` of the interp mode on
 * property `key`.
 *
 * @example interpParamKeyFor("active", "blur") // "active~interp~blur"
 * @example interpParamKeyFor("rotationAnchor.x", "p") // "rotationAnchor.x~interp~p" (splits to ["rotationAnchor", "x~interp~p"] — the sibling, same as the mode key)
 */
export function interpParamKeyFor(key, param) {
  return `${key}${INTERP_KEY_SUFFIX}${INTERP_PARAM_SEPARATOR}${param}`;
}

/**
 * Pure function. True for an interp PARAMETER key — deliberately disjoint from
 * `isInterpKey`, which is a suffix test on `~interp` and so answers false here.
 *
 * @example isInterpParamKey("active~interp~blur") // true
 * @example isInterpParamKey("active~interp") // false (that is the MODE key)
 * @example isInterpParamKey("active") // false
 */
export function isInterpParamKey(key) {
  return typeof key === "string" && key.includes(INTERP_KEY_SUFFIX + INTERP_PARAM_SEPARATOR);
}

/**
 * Query (reads the registry). THE PARAMETER DECLARATIONS a mode publishes, as
 * inspector-row descriptors — `[]` for every mode that declares none.
 *
 * This is the seam that makes parameters GENERAL rather than a blurFade special
 * case: the Inspector renders whatever this returns, so a FUTURE mode declares
 * its own knobs and gets its rows with no Inspector code at all.
 *
 * @example modeParams("blurFade")[0].param // "blur"
 * @example modeParams("tween") // [] (no parameters — the overwhelming majority)
 * @example modeParams("nope") // [] (an unknown id has nothing to declare)
 */
export function modeParams(id) {
  return MODES.get(id)?.params ?? [];
}

/**
 * Pure function. A mode's parameter values read out of a state bag, with every
 * ABSENT one filled by the mode's own declared default.
 *
 * THE DEFAULT LIVES IN THE DECLARATION, NOT AT THE READ SITE, which is what
 * makes "absent = the new default" a byte-identical migration rather than a
 * promise: an old document stores nothing, this fills the same number the
 * renderer would have used, and no repair pass ever has to write one in.
 *
 * THE BAGS ARE READ IN PRECEDENCE ORDER, not merged: the FIRST one holding a
 * finite number for a parameter wins. Callers pass (delta, outgoing), which is
 * `modeForBlend`'s "the target wins from frame 1, else the standing value
 * carries" applied per parameter — and reading them in order rather than
 * spreading them together is what keeps this allocation-free for the modes that
 * declare nothing, which is every leaf of every existing document.
 *
 * A NON-NUMERIC STORED VALUE FALLS TO THE DEFAULT rather than throwing. These
 * keys are unreachable from an equation by grammar, so the only way to hold a
 * non-number here is a hand-damaged document, and the honest response to one
 * damaged cosmetic knob is the mode's own default rather than refusing to render
 * the slide.
 *
 * Args:
 *   id (string): the resolved mode id
 *   key (string): the property the mode is on
 *   ...bags (object): state/delta objects to read the parameter keys from, most
 *     authoritative first
 *
 * Returns:
 *   object: {paramName: value} over the mode's declared parameters
 *
 * @example modeParamsFrom("blurFade", "active", {}) // {blur: 64} (absent = the declared default)
 * @example modeParamsFrom("blurFade", "active", {"active~interp~blur": 10}) // {blur: 10}
 * @example modeParamsFrom("blurFade", "active", {}, {"active~interp~blur": 10}) // {blur: 10} (the standing value carries when the delta is silent)
 * @example modeParamsFrom("blurFade", "active", {"active~interp~blur": 3}, {"active~interp~blur": 10}) // {blur: 3} (the target wins)
 * @example modeParamsFrom("tween", "x", {}) // {} (a mode with no parameters reads nothing)
 */
export function modeParamsFrom(id, key, ...bags) {
  const decls = modeParams(id);
  if (decls.length === 0) return EMPTY_PARAMS;
  const out = {};
  for (const decl of decls) {
    const paramKey = interpParamKeyFor(key, decl.param);
    let value = decl.default;
    for (const bag of bags) {
      const stored = bag?.[paramKey];
      if (typeof stored === "number" && Number.isFinite(stored)) { value = stored; break; }
    }
    out[decl.param] = value;
  }
  return out;
}

/** Shared for the no-parameter case, so the hot path allocates nothing. */
const EMPTY_PARAMS = Object.freeze({});

// ── The registry ─────────────────────────────────────────────────────────────

const MODES = new Map();

/**
 * Command (mutates the module-level registry). Registers an interpolation mode.
 * Throws on a duplicate id or a malformed entry — a wave that collides with
 * another wave's mode name must find out at import time, not by silently
 * replacing its blend law.
 *
 * @param {object} entry - {id, label, help?, blend}
 *
 * @example // a follow-up wave's registration, from its own file:
 * @example // registerInterpMode({id: "fade", label: "Fade",
 * @example //   blend: (a, b, alpha) => (alpha < 1 ? crossFade(a, b, alpha) : b)});
 */
export function registerInterpMode(entry) {
  if (!entry || typeof entry.id !== "string" || !entry.id)
    throw new Error("registerInterpMode: an entry needs a non-empty string `id`");
  if (typeof entry.blend !== "function")
    throw new Error(`registerInterpMode("${entry.id}"): an entry needs a \`blend(a, b, alpha, ctx)\` function`);
  if (entry.appliesTo !== undefined && typeof entry.appliesTo !== "function")
    throw new Error(`registerInterpMode("${entry.id}"): \`appliesTo\` must be a function ({key, value, type}) → boolean, or absent`);
  if (MODES.has(entry.id))
    throw new Error(`registerInterpMode("${entry.id}"): that mode id is already registered — two modes cannot share a name`);
  // A PARAMETER DECLARATION IS CHECKED AT IMPORT TIME (WORKSTREAM AP), for the
  // same reason a duplicate id is: the Inspector renders these descriptors
  // verbatim, so a malformed one produces a broken row rather than an error, and
  // it would do so only when an author happened to select that mode. Every field
  // is required because every one is load-bearing — `param` names the state key,
  // `default` IS the absent-value migration, and `label` is the row.
  for (const p of entry.params ?? []) {
    if (!p || typeof p.param !== "string" || !p.param)
      throw new Error(`registerInterpMode("${entry.id}"): every entry in \`params\` needs a non-empty string \`param\``);
    if (typeof p.default !== "number" || !Number.isFinite(p.default))
      throw new Error(`registerInterpMode("${entry.id}"): param "${p.param}" needs a finite numeric \`default\` — it IS the byte-identical migration for documents that store nothing`);
    if (typeof p.label !== "string" || !p.label)
      throw new Error(`registerInterpMode("${entry.id}"): param "${p.param}" needs a \`label\` — it is rendered as an Inspector row`);
  }
  // `appliesTo` ABSENT MEANS EVERYWHERE, and that is the deliberate default: a
  // mode that does not declare a domain is offered on every row, which is exactly
  // what every mode did before this field existed. So adding the field changed no
  // existing behavior; each shipped mode then narrowed itself on purpose, with an
  // argument at its own registration.
  MODES.set(entry.id, { help: "", appliesTo: () => true, ...entry });
}

/**
 * Query (reads the registry). THE APPLICABILITY FILTER: the mode ids worth
 * OFFERING for one property — what the Inspector's interp select renders.
 *
 * ── WHY THIS EXISTS (user ruling, 2026-08-02, verbatim) ──────────────────────
 *   "Tween doesn't really make sense in terms of widget type interpolation…
 *    blend and tween, those don't really make any sense"
 *
 * — said about the TYPE row, which was offering all five modes. Three of them
 * could not do anything there: there is no value halfway between "rect" and
 * "circle" for `tween` to compute, no pair of paints for `blend` to composite,
 * and no coverage for `fade` to ramp. Each rendered as a plain discrete switch,
 * so the select was offering three different names for the same behavior and one
 * real choice, with nothing to tell them apart.
 *
 * That is worse than a shorter list: a select is where an author goes to ask what
 * a property CAN do, so an option that silently degrades is a confident wrong
 * answer. This function is the one place that question is answered, and each mode
 * answers for itself (`appliesTo`) rather than a central table listing which rows
 * get which modes — the same plugin-owned-knowledge argument `morphPairPolicy`
 * makes one layer down.
 *
 * THERE IS NO `auto` OPTION IN THIS LIST, and that is not an omission. "Auto" is
 * already how the select behaves: an ABSENT companion key renders
 * `interpRowFor`'s `absentValue`, which is `displayedDefaultModeFor` — the very
 * mode the renderer will use. So the untouched state ALREADY shows its real
 * answer by name ("Blend" on a material row, "Morph" on a type row), which is
 * strictly more informative than the word "Auto", and adding a separate option
 * would give one state two spellings. The type row's `auto` in this feature's
 * design notes IS that absent state, not a fifth id.
 *
 * Args:
 *   key (string): the state key the select is for
 *   value (*): its folded value on the slide being shown (a SHAPE hint — see
 *     displayedDefaultModeFor for why one value rather than a pair)
 *   type (string|undefined): the owning widget's type, when the caller knows it
 *
 * Returns:
 *   string[]: applicable mode ids, in registration order
 *
 * @example modesForKey("type", "rect") // ["tween", "step"] (morph RETIRED here — it is a universal property now)
 * @example modesForKey("x", 0) // ["tween", "step", "expTween"] (a SCALAR row also offers the geometric law)
 * @example modesForKey("active", false) // ["tween", "step", "fade", "blurFade", "manim", "grow"]
 * @example modesForKey("fill", {type: "material", material: {id: "crt"}}) // ["tween", "step", "blend"]
 * @example modesForKey("latex", "x^2", "latex") // ["tween", "step"] (a content leaf morphs through the universal row)
 */
export function modesForKey(key, value, type) {
  const ctx = { key, value, type };
  const ids = [...MODES].filter(([, entry]) => entry.appliesTo(ctx)).map(([id]) => id);
  // THE DISPLAYED DEFAULT IS ALWAYS OFFERED, even where its own `appliesTo` says
  // no. The select renders `absentValue` — the mode the renderer really uses when
  // nothing is stored — as the CURRENT value, and a select whose current value is
  // not among its options renders blank in every browser. That would turn the one
  // row this feature exists to explain into an empty box. This cannot fire for
  // any shipped mode (each default is applicable where it is the default) and is
  // here so a future default cannot silently produce that blank.
  const shown = displayedDefaultModeFor(value, key);
  return ids.includes(shown) ? ids : [shown, ...ids];
}

/**
 * Query (reads the registry). The mode entry for `id`, or undefined.
 *
 * @example interpMode("step").label // "Step"
 * @example interpMode("nope") // undefined
 */
export function interpMode(id) {
  return MODES.get(id);
}

/**
 * Query (reads the registry). Every registered mode id, in registration order —
 * the option list an Inspector select renders.
 *
 * @example interpModeIds() // ["tween", "step", "fade", "blend", "expTween", "morph", "blurFade", "manim", "grow"]
 */
export function interpModeIds() {
  return [...MODES.keys()];
}

/**
 * Query (reads the registry). id → label map, for a select row's optionLabels.
 *
 * @example interpModeLabels().step // "Step"
 */
export function interpModeLabels() {
  const out = {};
  for (const [id, entry] of MODES) out[id] = entry.label;
  return out;
}

/**
 * Pure function. THE MODE-STEPS-AT-START RULE, in one place.
 *
 * Given the mode stored on the OUTGOING state (`from`) and the one the incoming
 * delta sets (`to`, `undefined` when the delta says nothing about it), returns
 * the mode that governs this whole transition. The TARGET wins the moment the
 * transition begins — the user's "flicked immediately at the beginning" — so a
 * slide that switches x to `step` steps x for that transition, not for the next
 * one. When the delta is silent, the standing mode carries; when neither exists,
 * it is the default.
 *
 * Note this is deliberately NOT alpha-dependent: mutBlendApply only calls it
 * with alpha > 0 (at alpha 0 nothing blends at all), so "steps at the start"
 * IS "the target, always" at every point this can be reached.
 *
 * @example modeForBlend(undefined, undefined) // "tween" (absent = today)
 * @example modeForBlend("step", undefined) // "step" (standing mode carries)
 * @example modeForBlend(undefined, "step") // "step" (target wins from frame 1)
 * @example modeForBlend("step", "tween") // "tween" (target wins, both ways)
 */
export function modeForBlend(from, to) {
  return to ?? from ?? DEFAULT_INTERP_MODE;
}

/**
 * Pure function. Blends one leaf under a named mode — the ONE function
 * core/deltas.mutBlendApply calls, and the only place a mode id becomes a value.
 *
 * An UNKNOWN mode id is a LOUD throw, not a silent fall back to tween: a
 * document naming a mode this build does not have is either from a newer build
 * or hand-damaged, and quietly tweening it would render a wrong picture while
 * exiting 0 — the exact failure this codebase's no-silent-fallback rule exists
 * to prevent.
 *
 * @param {*} a - current folded value (lazy start capture)
 * @param {*} b - the delta's target value
 * @param {number} alpha - strictly in (0, 1)
 * @param {object} ctx - {key, mode}; extensible, see the module docblock
 *
 * @example blendUnderMode(0, 10, 0.5, {key: "x", mode: "tween"}) // 5
 * @example blendUnderMode(0, 10, 0.5, {key: "x", mode: "step"}) // 10 (discrete)
 * @example blendUnderMode(0, 10, 0.01, {key: "x", mode: "step"}) // 10 (snaps at once)
 */
/**
 * Query (reads the registry). Does this mode take a WHOLE OBJECT-SHAPED value as
 * one leaf, rather than letting core/deltas recurse into it key by key?
 *
 * WHY THIS EXISTS: a paint IS a plain object. `{type: "material", material: {…}}`
 * and `{type: "linearGradient", stops: […]}` both look exactly like the nested
 * delta tree that a SPARSE keyframe patch uses, and core/deltas.mutBlendApply
 * cannot tell "patch these two fields of the existing paint" from "switch to a
 * different paint entirely" by shape alone. A mode CAN: `blend` only ever means
 * the second. So a claiming mode is consulted BEFORE the tree recursion and gets
 * the subtree as one value; a non-claiming mode leaves the recursion exactly as
 * it was, which is what keeps every existing sparse-patch document byte-identical.
 *
 * An UNKNOWN id answers false rather than throwing: the throw belongs to
 * blendUnderMode (which the caller reaches immediately after), and duplicating it
 * here would only move the same error one line earlier with a worse message.
 *
 * @example modeClaimsTrees("blend") // true
 * @example modeClaimsTrees("tween") // false
 * @example modeClaimsTrees("step") // false (a stepped subtree still recurses — see below)
 * @example modeClaimsTrees("nope") // false
 */
export function modeClaimsTrees(id) {
  return MODES.get(id)?.claimsTrees === true;
}

export function blendUnderMode(a, b, alpha, ctx) {
  const entry = MODES.get(ctx.mode);
  if (!entry)
    throw new Error(
      `Unknown interpolation mode ${JSON.stringify(ctx.mode)} on "${ctx.key}${INTERP_KEY_SUFFIX}". Registered: ${interpModeIds().join(", ")}`,
    );
  return entry.blend(a, b, alpha, ctx);
}

// ── The shipped modes ────────────────────────────────────────────────────────

registerInterpMode({
  id: DEFAULT_INTERP_MODE,
  label: "Tween",
  help: "Interpolate smoothly across the transition — numbers lerp, colours blend per channel, same-shaped lists and records blend element-wise. Values with no blend law (strings, booleans, shape changes) still switch at the start. This is the default.",
  // EVERYWHERE EXCEPT THE TYPE ROW. `tween` is the default law and a real answer
  // for nearly every leaf — but a widget TYPE is a name, and there is nothing
  // halfway between "rect" and "circle" to compute. Offering it there was the
  // user's "tween… doesn't really make any sense": it rendered as a plain
  // discrete switch, i.e. a second name for `step` with nothing to tell them
  // apart. Note it stays offered on a CONTENT key: "a^2" → "b^2" also has no
  // midpoint, but the row's other option is `morph`, so keeping the honest
  // no-blend-law answer available is what lets an author turn a morph OFF
  // without reaching for a mode that means something different.
  appliesTo: ({ key }) => key !== TYPE_KEY,
  // Byte-identical to the pre-mode path: this IS core/interpolators.interpolate,
  // which is why an absent companion key folds to exactly the old bytes.
  blend: (a, b, alpha) => interpolate(a, b, alpha),
});

registerInterpMode({
  id: "step",
  label: "Step",
  help: "Snap to the new value the instant the transition begins, with no in-between — a step function. What a boolean or a text property already does, available for any property.",
  // NO `appliesTo`: `step` is the one mode that means the same thing on every
  // leaf in the app, because "there is no in-between" is a true and useful answer
  // for a coordinate, a colour, a boolean, a type and a string alike. It is the
  // universal opt-out, and a row that offered no way to turn an animation off
  // would be the worse failure.
  // The user's "the property x would just immediately move, just like a discrete
  // property". mutBlendApply only reaches a mode with alpha > 0, so this is the
  // discrete rule verbatim: past zero, you are already there.
  blend: (a, b) => b,
});

// ── `fade`: a BOOLEAN that dissolves instead of blinking ──────────────────────
//
// User request, 2026-08-02, verbatim: "Even visible could have options for
// interpolate. We could have a fade interpolate option for visible… The default
// interpolation for toggling visibility is just step. But we would want to have
// an option called fade or opacity or something that would bring it in and out
// between 0 to 100 opacity."
//
// THE MECHANISM, stated once because it is the whole design: a `fade`-moded
// boolean leaf becomes a FRACTIONAL NUMBER mid-transition. `active: false → true`
// at alpha 0.3 folds to `active: 0.3`. That is the entire feature at this layer;
// the render side (render_gpu/ports.js activeFadeOpacity) reads a fractional
// `active` as a multiplier on every op's opacity, and core/derive.js's
// "is this item drawn at all" test already asks `active !== false`, which a
// number passes.
//
// WHY A FRACTIONAL BOOLEAN AND NOT A SEPARATE `opacity` KEYFRAME. Three reasons,
// in order of weight:
//   1. IT IS THE PROPERTY THE USER NAMED. Writing a second key would mean a mode
//      on `active` silently authoring `opacity` — a blend that mutates a
//      DIFFERENT leaf than the one it was asked about breaks mutBlendApply's
//      whole contract (one leaf in, one value out) and would clobber whatever
//      the author had put in `opacity`.
//   2. THE ENDPOINTS STAY EXACT BOOLEANS FOR FREE. The call site enforces alpha 1
//      = the stored target, so a folded slide state never holds a fraction; and
//      at alpha → 0 the fold returns `a` untouched. Only the strictly-interior
//      frames of a transition are fractional, which is exactly the window a fade
//      occupies. Nothing serializes, nothing repairs, nothing migrates.
//   3. MULTIPLICATION IS THE HONEST COMPOSITION. A widget at opacity 0.5 fading
//      in reaches 0.25 halfway, not 0.5 — the fade is a coverage factor over
//      whatever the widget's own opacity already was.
//
// DIRECTION IS FREE. true → false gives 1 − alpha and false → true gives alpha,
// because the law below is a plain lerp over the numeric reading of the two
// booleans. So Delete-with-fade dissolves out and un-Delete dissolves in, with
// one rule and no branch.
//
// NON-BOOLEAN ENDPOINTS FALL BACK TO `interpolate`, not to a throw: `fade` is
// selectable on ANY row (rowSupportsInterp says every keyframeable row qualifies),
// and a user who picks it on `x` should get x's ordinary tween rather than an
// error box — there is no fading a coordinate. Numbers already lerp, which IS the
// fade for anything with a magnitude, so this fallback is the right answer and
// not a swallow.

/**
 * Pure function. A boolean read as its opacity contribution — the numeric
 * reading `fade` lerps between. `undefined` (an ADDITION: the key was not in
 * the state) reads as ABSENT-MEANS-VISIBLE, matching core/derive.js's
 * `s.active !== false` test, so a mode can never disagree with the gate.
 *
 * @example fadeLevel(true) // 1
 * @example fadeLevel(false) // 0
 * @example fadeLevel(0.25) // 0.25 (already fractional — an in-flight fade)
 * @example fadeLevel(undefined) // 1 (absent means visible)
 */
export function fadeLevel(v) {
  if (typeof v === "number") return v;
  if (v === false) return 0;
  return 1;
}

registerInterpMode({
  id: "fade",
  label: "Fade",
  help: "Ramp the item's opacity from 0% to 100% across the transition instead of blinking on (and back out again when it is hidden). This is the mode for Visible. Distinct from Blend, which draws BOTH values at once and cross-dissolves them.",
  // BOOLEAN-VALUED ROWS ONLY — `visible`/`active` and anything else that is a
  // true/false. A fade is a COVERAGE ramp, and coverage is what a boolean has:
  // "shown" is 100% and "hidden" is 0%, so the in-between is meaningful. A
  // coordinate has no coverage to ramp — `fade` on `x` fell through to the
  // ordinary tween, which is a correct answer to a question nobody meant to ask,
  // and offering it there put a second name for `tween` in the list.
  //
  // The value SHAPE decides, not the key name, so a plugin that invents its own
  // boolean gets the mode for free — the same shape-driven argument
  // `defaultModeFor` makes for paints, and for the same reason: this must be
  // answerable with no registry in hand.
  appliesTo: ({ value }) => typeof value === "boolean",
  blend: (a, b, alpha) => {
    const bothBoolish = (v) => typeof v === "boolean" || typeof v === "number" || v === undefined;
    // A boolean pair (or a fraction already in flight) fades; anything else has
    // no coverage meaning, so it takes the default law. See the note above.
    if (!bothBoolish(a) || typeof b !== "boolean") return interpolate(a, b, alpha);
    return lerpFade(fadeLevel(a), fadeLevel(b), alpha);
  },
});

/**
 * Pure function. The fade ramp: a plain lerp, CLAMPED to [0, 1] so a coverage
 * factor can never leave the range the renderer multiplies by.
 *
 * @example lerpFade(0, 1, 0.25) // 0.25 (fading in)
 * @example lerpFade(1, 0, 0.25) // 0.75 (fading out — same rule, no branch)
 * @example lerpFade(0.5, 1, 0.5) // 0.75 (from a fraction already in flight)
 */
function lerpFade(a, b, alpha) {
  return Math.max(0, Math.min(1, a + (b - a) * alpha));
}

// ── `blend`: two PAINTS alpha-composited over the transition ──────────────────
//
// User request, 2026-08-02, verbatim: "Different fill materials could just
// linearly blend between each other. We could just, like, say, blend as an
// interpolation between, like, a linear gradient and an arbitrary material. You
// could just do alpha blending between the two, like, render both materials in
// the in-between and just, like, alpha blend the results. Even CRT could do
// that… So if I switch between any of those material options, it should be blend
// by default."
//
// THE VALUE SHAPE: mid-transition the leaf becomes
//
//     {type: "crossfade", from, to, t}
//
// with `t` the transition alpha, and `from`/`to` the two ORIGINAL paint values,
// carried through untouched. It is a PAINT like any other as far as this layer is
// concerned — the renderers are what know how to draw it (render_gpu/ir.js
// isCrossfadePaint / parsePaint, which recurses into both sides so each half is
// already painter-ready; render_gpu/skia/paint_skia.js paints the op TWICE, once
// per side, at complementary alpha).
//
// WHY A VALUE AND NOT A NEW OP. A crossfade has to work for `fill`, for `stroke`,
// and for every one of the ~74 plugins' emit() bodies without any of them
// knowing. Making it a PAINT means it rides the slot the paint already occupies:
// no plugin changes, no emit() signature changes, and both vector exporters catch
// it with one predicate in the OR-chain they already use to decide "this op has
// no vector form — rasterize it".
//
// WHY IT IS NOT A PRE-BLENDED SINGLE PAINT. Two solid colors could be averaged
// channel-wise (that is what `tween` already does), but a MATERIAL is an SkSL
// shader and a GRADIENT is a stop list — there is no value halfway between a CRT
// shader and a linear gradient. The user's own answer is the right one: render
// both and composite. So the mode's job is to PRESERVE both operands, not to
// reduce them.
//
// NESTING IS FLATTENED. If `a` is already a crossfade (a transition beginning
// before the previous one's fold settled — possible under a partial fold), the
// blend re-anchors on its `to` side rather than nesting crossfades N deep, which
// would multiply the paint cost by 2^N. The visual cost is that the older,
// mostly-faded-out operand is dropped a frame early; the alternative is an
// unbounded shader chain.

/** The paint-value tag a mid-transition `blend` produces. */
export const CROSSFADE_PAINT_TYPE = "crossfade";

/**
 * Pure function. True for the crossfade paint value `blend` produces —
 * the shape check the renderers route on, defined HERE (in DOM-free core)
 * because core is where the value is minted. render_gpu/ir.js re-exports the
 * predicate for the render side rather than defining a second, driftable copy.
 *
 * @example isCrossfadeValue({type: "crossfade", from: "#f00", to: "#00f", t: 0.5}) // true
 * @example isCrossfadeValue("#ff0000") // false
 * @example isCrossfadeValue(null) // false
 */
export function isCrossfadeValue(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && v.type === CROSSFADE_PAINT_TYPE);
}

registerInterpMode({
  id: "blend",
  label: "Blend",
  help: "Draw BOTH fills during the transition and alpha-composite them, so any paint can dissolve into any other — a solid into a gradient, a gradient into a material, one material into another. Distinct from Fade, which ramps ONE thing's opacity rather than drawing two. The default when a fill or material changes.",
  // PAINT-VALUED ROWS ONLY. `blend` PRESERVES TWO OPERANDS so the renderer can
  // draw the op twice — that is its whole mechanism, and it needs two things to
  // draw. A number has one value and no second draw, so `blend` on `x` fell
  // through to the ordinary tween: a third name for `tween` in the list. On the
  // TYPE row it was worse than useless — a whole ITEM BAG is object-shaped, and
  // claiming it mid-transition is the exact bug PAINT_TYPE_TAGS was closed to
  // prevent (read that docblock; it was live, not hypothetical).
  //
  // Colour STRINGS are excluded on purpose: `#f00` → `#00f` has a true numeric
  // midpoint that `tween` already computes per channel, and computing it is
  // cheaper than drawing the op twice. So this is the same isPaintShaped test the
  // default-mode seam keys off, and the two cannot drift.
  appliesTo: ({ value }) => isPaintShaped(value),
  // A PAINT IS A TREE — see modeClaimsTrees. Without this flag the delta walker
  // would recurse into the two paints and merge them key-wise, producing a
  // chimera that is neither.
  claimsTrees: true,
  blend: (a, b, alpha, ctx) => {
    // An ADDITION (no `a`) or a REMOVAL has only one operand — there is nothing
    // to composite against, so the ordinary discrete/tween law applies.
    if (a === undefined || a === null || b === undefined || b === null) return interpolate(a, b, alpha);
    // Two plain numbers under `blend` mean the author picked it on a numeric row;
    // a number has no second operand to draw, so lerp (see `fade`'s same note).
    if (typeof a === "number" && typeof b === "number") return interpolate(a, b, alpha);
    // NESTING FLATTENED — see the note above.
    const from = isCrossfadeValue(a) ? a.to : a;
    if (deepSame(from, b)) return b; // identical paints: no reason to draw twice
    return { type: CROSSFADE_PAINT_TYPE, from, to: b, t: alpha, key: ctx?.key };
  },
});

/**
 * Pure function. Structural equality for paint values — the "these two paints
 * are the same, do not pay to draw both" test. Local to this module (rather than
 * imported from core/deltas.deepEqual) only because deltas.js imports THIS file;
 * the semantics are identical.
 *
 * @example deepSame("#ff0000", "#ff0000") // true
 * @example deepSame({type: "material", material: {id: "crt"}}, {type: "material", material: {id: "crt"}}) // true
 * @example deepSame({type: "material", material: {id: "crt"}}, {type: "material", material: {id: "comic"}}) // false
 */
function deepSame(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepSame(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepSame(a[k], b[k]));
  }
  return false;
}

// ── `expTween`: a scalar that moves GEOMETRICALLY, not linearly ───────────────
//
// User ruling, 2026-08-02 night, verbatim (three messages, WORKSTREAM BG): "When
// the camera moves, by the way, its scale should interpolate exponentially… that
// should be the default for height and width for the camera and well and X and Y
// too. It's the Mandelbrot. Look at the Mandelbrot interpolation logic. It took a
// while to get it right… Because when a camera zooms in, just like in Mendelbrot,
// it's gotta look natural… should we have this as a scale option under it so like
// tween or step if we do exponential it's really just oh right yes tween i guess
// we'll do exponential tween yeah that's how we'll do it", then "Exp Tween", then
// "\"Exp Tween\"". The label is quoted twice, so it is EXACTLY "Exp Tween".
//
// ── THE LAW ──────────────────────────────────────────────────────────────────
//
//     v(t) = a·(b/a)^t        equivalently exp(lerp(ln a, ln b, t))
//
// i.e. a lerp in LOG space: the value's RATIO per unit time is constant, where
// `tween`'s DIFFERENCE per unit time is constant. That is what "constant-rate
// zoom" means and why it looks natural — the eye reads magnification
// logarithmically, so a linearly-tweened width crawls at the wide end and then
// rushes at the tight end, which is the "it curved around and it was weird" the
// Mandelbrot work was chasing.
//
// ── WHY THIS IS THE REFERENCE'S LAW, AND WHICH HALF OF IT ─────────────────────
// The reference the user named is plugins/demo/mandelbrot.js:479 `zoomTweenLam`.
// Its account of a natural zoom has TWO halves, and only ONE of them is a scalar
// law that can live in this registry:
//
//   1. THE SCALE moves exponentially. The Mandelbrot spells that by tweening a
//      LOG (`zoomExponent`) linearly, since its half-width is 10^(-z) — see that
//      file's "TO ANIMATE A ZOOM, TWEEN zoomExponent — linearly, for a
//      constant-rate zoom". A PowerRP camera stores w/h as the magnitude itself,
//      not as a log, so the identical picture is this mode: exponentiating the
//      lerp is the same curve as lerping the exponent. THIS is `expTween`.
//   2. THE CENTRE is linear in the resulting HALF-WIDTH, NOT in alpha and NOT
//      per-axis exponential. That half is a COUPLING between two leaves and is
//      structurally unreachable from here — a `blend` sees one leaf's two values
//      and cannot know what the width is doing. It lives where the Mandelbrot
//      puts it, in the `interpolateState` hook (see plugins/camera.js).
//
// MEASURED, because the task asked whether naive per-axis exp on x/y reproduces
// the reference's feel. It does not — it is WORSE than the linear pan it would
// replace. Target-point offset from frame centre, in half-widths (|offset| ≤ 1 is
// on screen), for w 1280 → 4 with the centre travelling 640 → 9000:
//
//     alpha                    0     0.1    0.25     0.5    0.75     0.9      1
//     linear pan           13.06   20.93   41.44  116.83  247.07  234.78      0
//     per-axis expTween    13.06   22.72   51.29  184.48  514.53  587.14      0
//     reference (in w)     13.06   13.03   12.93   12.37   10.01    5.74      0
//
// Only the reference's law is monotone; both others swing the target hundreds of
// frame-widths away and snap it back. So `expTween` is the SCALE law, and the
// camera's x/y get the reference's coupling rather than this mode applied twice.
//
// ── DEGENERATE ENDPOINTS: LINEAR, DELIBERATELY, NEVER NaN ────────────────────
// `(b/a)^t` is real-valued only when a and b are nonzero and share a sign. The
// three failures are not exotic — a camera at x = 0 is the ordinary case, and a
// pan across the origin is a sign flip — so each falls back to the ORDINARY LERP
// rather than throwing or producing NaN:
//
//   - EITHER ENDPOINT ZERO. A geometric path cannot leave or reach zero: it needs
//     infinite time in log space, so a·(b/a)^t with a = 0 is 0 for every t and
//     then jumps at the end. Linear is the only law that both moves and lands.
//   - OPPOSITE SIGNS. There is no real geometric path across the origin at all
//     ((b/a) < 0 raised to a fraction is NaN), and the pair is telling us the
//     value passes THROUGH zero, which is case one at the crossing.
//   - EITHER END NON-FINITE OR NON-NUMERIC. Not a scalar; `expTween` is a scalar
//     law and has nothing to say, so the leaf takes whatever `interpolate`
//     already does with it (strings/booleans switch discretely, as always).
//
// This is a documented fallback, not a silent swallow: the fallback is the
// CORRECT limit of the law in each case (a degenerate geometric path IS the
// linear one, in the only sense available), the picture stays continuous and
// monotone, and no value is ever NaN. BOTH-NEGATIVE endpoints are NOT degenerate
// and are handled exactly — the ratio is positive, so the geometric path runs
// entirely below zero, which is what a camera with a negative width (a FLIP —
// see the NEGATIVE EXTENTS contract) needs.

/**
 * Pure function. THE GEOMETRIC (log-space) SCALAR LAW: v = a·(b/a)^t.
 *
 * Exact at both endpoints by construction, and MONOTONE between them. Falls back
 * to the ordinary lerp for the degenerate pairs a geometric path cannot express
 * (a zero endpoint, a sign flip) — see the section header for why each fallback
 * is the law's own limit rather than a swallow.
 *
 * Args:
 *   a (number): the start value (the CURRENT folded value — lazy start capture)
 *   b (number): the target value
 *   t (number): tween strength in [0, 1]
 *
 * Returns:
 *   number
 *
 * @example expLerp(1, 100, 0.5) // 10 (the GEOMETRIC mean, not the arithmetic 50.5)
 * @example expLerp(1, 100, 0) // 1
 * @example expLerp(1, 100, 1) // 100
 * @example expLerp(1280, 4, 0.5) // 71.55417527999327 (a camera halfway through a 320x zoom)
 * @example expLerp(-1, -100, 0.5) // -10 (both negative: the ratio is positive, so the law holds exactly)
 * @example expLerp(0, 100, 0.5) // 50 (zero endpoint: no geometric path leaves zero, so linear)
 * @example expLerp(-10, 10, 0.5) // 0 (sign flip: no real path across the origin, so linear)
 */
export function expLerp(a, b, t) {
  if (!expTweenApplies(a, b)) return a + (b - a) * t;
  return a * Math.pow(b / a, t);
}

/**
 * Pure function. Can the geometric law run on this pair — i.e. are both endpoints
 * finite, nonzero numbers of the SAME sign? False means `expLerp` takes its
 * documented linear fallback.
 *
 * @example expTweenApplies(1, 100) // true
 * @example expTweenApplies(-1, -100) // true (same sign: the ratio is positive)
 * @example expTweenApplies(0, 100) // false (a zero endpoint)
 * @example expTweenApplies(-10, 10) // false (a sign flip)
 * @example expTweenApplies("a", 10) // false (not a scalar pair)
 */
export function expTweenApplies(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a !== 0 && b !== 0 && Math.sign(a) === Math.sign(b);
}

/** The mode id behind the "Exp Tween" label. The LABEL is the user's exact
 *  string; the id is the ordinary camelCase this registry uses for every other
 *  mode, and is what a document stores. */
export const EXP_TWEEN_MODE = "expTween";

registerInterpMode({
  id: EXP_TWEEN_MODE,
  label: "Exp Tween",
  help: "Interpolate GEOMETRICALLY — the value's ratio changes at a constant rate instead of its difference, so a 1 → 100 scale reads 10 halfway rather than 50.5. This is what makes a zoom look natural, and it is the camera's default for X/Y/W/H. Endpoints with a zero or a sign change have no geometric path, so those fall back to an ordinary tween.",
  // NUMERIC ROWS ONLY. The whole law is a ratio, and only a scalar has one: on a
  // boolean, a string, a type or a paint it would fall through to `interpolate`
  // and become yet another name for `tween` in the select — exactly the "doesn't
  // really make any sense" the user objected to on the type row. The value SHAPE
  // decides (not the key name), so any plugin's own numeric knob gets the mode
  // for free — the same shape-driven argument `fade` and `blend` make.
  appliesTo: ({ value }) => typeof value === "number",
  blend: (a, b, alpha) => {
    // A non-scalar pair reaching here means the author picked the mode on a row
    // it cannot describe (or the leaf is an ADDITION with no `a`). Defer to the
    // ordinary law rather than inventing one — the `fade`-on-`x` precedent.
    if (typeof a !== "number" || typeof b !== "number") return interpolate(a, b, alpha);
    return expLerp(a, b, alpha);
  },
});

// ── The DEFAULT-MODE seam ─────────────────────────────────────────────────────
//
// User ruling, 2026-08-02, verbatim: "if I switch between any of those material
// options, it should be blend by default."
//
// So a mode is not merely "stored, else tween": a leaf whose VALUE SHAPE is a
// paint defaults to `blend` with nothing stored at all. That is a real behavior
// change for existing documents — a material or gradient switch that used to
// snap discretely at the start of a transition now cross-fades across it — and it
// is deliberate, because it is exactly what was asked for. THE ENDPOINTS ARE
// UNCHANGED: alpha 0 and alpha 1 are enforced at mutBlendApply's call site, so no
// folded slide state, no saved document and no still export moves a byte. Only
// the strictly-interior frames of a transition differ.
//
// WHY THE MAPPING LIVES HERE AND NOT IN core/properties.js. The obvious home is
// the property registry — it already knows every row's `kind`. But the default
// has to be resolvable at the ONE point a leaf blends (core/deltas.mutBlendApply),
// which sees a KEY and two VALUES and has no plugin, no row and no registry in
// hand. Keying off the VALUE SHAPE is what makes that possible, and it has a
// second virtue: a plugin that invents a new paint-valued property gets the
// default for free, with no registry entry to remember. (It also keeps this
// feature out of properties.js entirely, which is a file another wave owns.)
//
// THE SHAPE TEST IS PAINT-OBJECTS ONLY, NOT COLOR STRINGS. A `#rrggbb` pair
// already tweens per-channel under `tween`, which is a true blend and cheaper
// than drawing the op twice — so a plain color keeps today's law. It is the
// OBJECT paints (material / gradient / solid-wrapper / none) that have no
// halfway value and need the composite.

// ── `morph`: one widget's OUTLINE flowing into another's ──────────────────────
//
// User request, 2026-08-02, verbatim: "the widget type could also have an
// interpolation option… different widgets might want to interpolate pairs with
// each other in different ways. So maybe we'd have auto as the default… This
// information between the relations between the plugins is not stored globally.
// It has to be stored in the plugins… Two shapes that interpolate can use
// Mannum's three blue one browns interpolation algorithm. And that also includes
// anything vector graphics… Morph is the default interpolation type for a widget
// like that."
//
// THE PROPERTY THIS RIDES IS `type`. Retyping a widget is already an ordinary
// delta write (core/retype.js: "`type` is an ordinary delta-written field"), and
// folding already treats it as a discrete string leaf — a rect keyframed to a
// circle SNAPS to a circle the instant alpha > 0. This mode is what makes that
// same keyframe CONTINUOUS instead: the outline flows.
//
// THE VALUE SHAPE: mid-transition the leaf becomes
//
//     {type: "~morph", fromType, toType, t}
//
// and everything about that shape is chosen so nothing else can mistake it for a
// widget type. The `~` prefix is THIS FILE'S OWN SIGIL, one level down: `~interp`
// marks a machine-namespace state KEY, and `~morph` marks a machine-namespace
// state VALUE, for the identical reason — no plugin type string can contain it
// (they are all identifiers), so the namespace is provably disjoint from every
// real `type`. A reader that has never heard of morphing sees a value it cannot
// confuse with "rect".
//
// WHY A TOKEN AND NOT A PRE-MORPHED PAYLOAD IN THE LEAF. This is the crossfade
// precedent (e90f6d3) applied one layer up, and the argument is the same in
// shape: the fold runs at ARBITRARY [[slide, alpha]] on any machine, and baking
// geometry into a folded state would put a whole path list into every cached
// slide state, every undo entry and every serialized form the fold touches. The
// token carries the two TYPE NAMES and the alpha — three scalars — and the
// render seam (render_gpu/ports.js) asks the two plugins for their outlines at
// paint time, where the answer is already needed and already memoized
// (core/morph.js alignedPair, keyed on content).
//
// WHY IT IS NOT THE DEFAULT FOR EVERY TYPE PAIR. `auto` is (see defaultModeFor
// below), and auto resolves to morph ONLY when both endpoint plugins actually
// declare the capability and both report ready. A rect→video "morph" has no
// second outline to flow into, so it must remain the discrete switch it is
// today. The capability-present-on-both test is v1; a per-PAIR override table
// (the user's "different widgets might want to interpolate pairs with each other
// in different ways") is a documented seam, not shipped — see
// `morphPairPolicy` below.

/** The `type`-leaf token a mid-transition `morph` produces. The `~` prefix is
 * the machine-namespace sigil this module already uses for keys, applied to a
 * value: no plugin type string can contain it. */
export const MORPH_TYPE_TOKEN = "~morph";

/**
 * Pure function. True for the mid-morph `type` token — the shape core/derive.js
 * and render_gpu/ports.js route on. Defined HERE, in DOM-free core, because this
 * is where the value is minted; the render side imports the predicate rather
 * than defining a second, driftable copy (the isCrossfadeValue precedent).
 *
 * @example isMorphToken({type: "~morph", fromType: "rect", toType: "circle", t: 0.5}) // true
 * @example isMorphToken("rect") // false
 * @example isMorphToken(null) // false
 */
export function isMorphToken(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && v.type === MORPH_TYPE_TOKEN);
}

/**
 * Pure function. THE PAIR POLICY SEAM, and v1's answer to it.
 *
 * The user's ruling is that pair knowledge "is not stored globally. It has to be
 * stored in the plugins", and this function is the shape of that: it asks the
 * two PLUGINS, never a central table. v1's question is the simplest honest one —
 * do BOTH declare `morphPaths`, and does either report `morphNotReady`? — and it
 * returns the REASON when the answer is no, so the fallback can be explained
 * rather than merely taken.
 *
 * THE PER-PAIR OVERRIDE IS DELIBERATELY NOT SHIPPED. A plugin that wants a
 * different law against a SPECIFIC counterpart would declare it on itself (e.g.
 * a `morphPairs: {latex: "…"}` map read here, still plugin-owned, still no
 * global table) — the seam is this function and nothing else has to move. It is
 * left out because no widget yet has a second law to ask for, and a knob with
 * one implementation is a guess about the second.
 *
 * Args:
 *   fromPlugin (object|undefined): the outgoing type's plugin
 *   toPlugin (object|undefined): the incoming type's plugin
 *   fromState (object): the item's folded state on the outgoing side
 *   toState (object): the item's state as the incoming type
 *
 * Returns:
 *   {ok: boolean, reason: string|null} — `reason` is a clause completing
 *   "cannot morph because …", null when ok
 *
 * @example morphPairPolicy({morphPaths: () => ({})}, {morphPaths: () => ({})}, {}, {}) // {ok: true, reason: null}
 * @example morphPairPolicy({}, {morphPaths: () => ({})}, {}, {}).ok // false
 * @example morphPairPolicy({}, {morphPaths: () => ({})}, {}, {}).reason // 'the outgoing widget has no outline to morph from'
 * @example morphPairPolicy({morphPaths: () => ({}), morphNotReady: () => "its icon to finish loading"}, {morphPaths: () => ({})}, {}, {}).reason // 'the outgoing widget is waiting for its icon to finish loading'
 */
export function morphPairPolicy(fromPlugin, toPlugin, fromState, toState) {
  if (typeof fromPlugin?.morphPaths !== "function")
    return { ok: false, reason: "the outgoing widget has no outline to morph from" };
  if (typeof toPlugin?.morphPaths !== "function")
    return { ok: false, reason: "the incoming widget has no outline to morph into" };
  const fromWait = fromPlugin.morphNotReady?.(fromState);
  if (fromWait) return { ok: false, reason: `the outgoing widget is waiting for ${fromWait}` };
  const toWait = toPlugin.morphNotReady?.(toState);
  if (toWait) return { ok: false, reason: `the incoming widget is waiting for ${toWait}` };
  return { ok: true, reason: null };
}

// ── `morph` ON A CONTENT KEY: the SAME widget, different CONTENT ──────────────
//
// User ruling, 2026-08-02, verbatim: "LaTeX to LaTeX should morph… I just edit
// the equation between slides", and "It should be universal".
//
// THIS IS THE CASE THE TYPE-MORPH STRUCTURALLY CANNOT REACH, and noticing that is
// the whole reason this section exists. Editing an equation's source or a text
// box's string does NOT change `type` — the widget is a `latex` on both slides —
// so the token above is never minted and the edit snaps discretely no matter what
// interp the author picks on the type row. The morph the user actually asked for
// ("I just edit the equation between slides") lives on a DIFFERENT leaf.
//
// THE VALUE SHAPE, the exact sibling of `~morph` one key over:
//
//     {type: "~morphContent", key, from, to, t}
//
// `from` and `to` are the two SOURCE STRINGS, and that is what makes this
// affordable: the crossfade/`~morph` argument is that a token carries SCALARS
// while a payload would put geometry into every cached slide state, undo entry
// and serialized form the fold touches. Two equation sources are a few dozen
// bytes; two glyph-outline payloads are thousands of control points. The render
// seam asks the ONE plugin for both outlines at paint time, where the answer is
// needed anyway and is already memoized on content (core/morph.js alignedPair).
//
// `key` RIDES IN THE TOKEN because the resolver needs it and cannot recover it.
// core/derive.js meets a folded state bag and must know WHICH leaf is mid-morph
// to build the two states from; scanning every leaf for a token would be a walk
// over every property of every item on every frame. The mode is told the key
// (ctx.key) and simply passes it along.
//
// WHY NOT A SECOND MODE ID ("morphContent"). It is the same question the author
// is asking — "reshape this into that" — and the same answer the engine gives.
// A second id would put two spellings of one idea in the select and force every
// author to know which leaf a morph is "really" about. One `morph`, two token
// shapes, resolved by the key it was asked about.

/** The CONTENT-leaf token a mid-transition `morph` produces when the property is
 * a widget's content rather than its type. Same `~` machine-namespace sigil as
 * MORPH_TYPE_TOKEN, and disjoint from it so a reader (and a resolver) can tell a
 * retype from a re-edit at a glance. */
export const CONTENT_MORPH_TOKEN = "~morphContent";

/**
 * Pure function. True for the mid-morph CONTENT token — the shape core/derive.js
 * routes on, defined here beside the value that mints it (the isMorphToken /
 * isCrossfadeValue precedent).
 *
 * @example isContentMorphToken({type: "~morphContent", key: "latex", from: "a", to: "b", t: 0.5}) // true
 * @example isContentMorphToken({type: "~morph", fromType: "rect", toType: "circle", t: 0.5}) // false (that is the TYPE token)
 * @example isContentMorphToken("x^2") // false
 */
export function isContentMorphToken(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && v.type === CONTENT_MORPH_TOKEN);
}

/**
 * The CONTENT-DEFINING leaf of each widget that has one: the property whose value
 * IS the ink, rather than describing where the ink goes.
 *
 * A CLOSED TABLE, and deliberately not a plugin capability, for one reason: this
 * is consulted by the INSPECTOR (to decide whether to offer `morph` on a row) and
 * by the mode's own `blend`, which runs inside core/deltas with no registry in
 * hand. A plugin-declared `contentKey` would be the better home the moment a
 * third widget wants one, and moving it there is a two-line change — the seam is
 * `contentMorphKeyFor` and nothing else reads this object.
 *
 * IT IS NOT "any string property". A widget has many string leaves that are not
 * content: a font id, an alignment, a blend mode, a material name. Morphing
 * between two of those means nothing, and offering it would be the same confident
 * wrong answer the applicability filter below exists to stop.
 */
const CONTENT_KEYS = {
  latex: "latex",       // the equation source — the user's "I just edit the equation between slides"
  plaintext: "text",    // the text box's string
};

/**
 * Pure function. The content-defining state key for a widget type, or null.
 *
 * @example contentMorphKeyFor("latex") // "latex"
 * @example contentMorphKeyFor("plaintext") // "text"
 * @example contentMorphKeyFor("rect") // null (a shape's outline IS its geometry — the TYPE morph covers it)
 * @example contentMorphKeyFor(undefined) // null
 */
export function contentMorphKeyFor(type) {
  return CONTENT_KEYS[type] ?? null;
}

/**
 * Pure function. Is this state key some widget's content leaf? The key-side test,
 * for the callers (the mode's `blend`, the Inspector row filter) that hold a KEY
 * but not a widget type.
 *
 * A key-only test is deliberately COARSER than the pair: `text` is plaintext's
 * content, so a different widget with a `text` property would also be offered
 * morph on it. That is the honest trade at this seam — `blend` is called from
 * core/deltas, which has no registry and therefore no type — and it is safe
 * because the mode is only ever a token mint: core/derive.js re-asks the real
 * plugin before a pixel is drawn, and a widget with no outline for that leaf
 * falls back to the discrete switch with its reason reported.
 *
 * @example isContentMorphKey("latex") // true
 * @example isContentMorphKey("text") // true
 * @example isContentMorphKey("font") // false (a font id is not content)
 * @example isContentMorphKey("x") // false
 */
export function isContentMorphKey(key) {
  return Object.values(CONTENT_KEYS).includes(key);
}

registerInterpMode({
  id: "morph",
  label: "Morph",
  help: "Reshape the outlines: one form flows into the other across the transition, contour by contour — a rectangle becoming a circle, an icon becoming a logo, one equation becoming the next. Available when both sides are vector outlines; anything else switches at the start instead.",
  // A mid-morph `type` leaf is a plain string on both endpoints, so this mode
  // does NOT claim trees — there is no subtree to protect, unlike a paint.
  //
  // IT IS OFFERED ON NO ROW AT ALL ANY MORE, and that is the surfacing half of
  // the universal-property ruling (2026-08-02 night, verbatim): "Maybe that
  // widget type doesn't have an interpolation option, so when I mouse over it, I
  // don't get that. And it would just be under a universal option."
  //
  // Both rows it used to appear on are covered by the universal Morph property
  // (core/morph_property.js), which asks the SAME question about the whole widget
  // rather than about whichever leaf happened to change. Leaving the per-row
  // option would give one question two controls that can DISAGREE — an author
  // could set the type row to Morph and the universal row to Snap, and only one
  // of them can be obeyed. So the row is retired rather than kept as a synonym.
  //
  // THE MODE ITSELF STAYS REGISTERED. Documents written before tonight may store
  // `type~interp: "morph"` or a content-key mode, and an UNKNOWN mode id is a
  // LOUD throw by design (blendUnderMode). Keeping the entry is what makes those
  // documents keep folding; it simply is no longer OFFERED. See the migration
  // note in core/morph_property.js.
  appliesTo: () => false,
  blend: (a, b, alpha, ctx) => {
    // TWO REAL STRINGS OR NOTHING. An ADDITION (the item is being created on this
    // slide, so there is no outgoing value) and a REMOVAL have only one side, and
    // there is no morphing from nothing — those take the ordinary discrete law,
    // exactly as `blend` does for a one-operand paint.
    if (typeof a !== "string" || typeof b !== "string") return interpolate(a, b, alpha);
    if (a === b) return b; // nothing changed: no morph to run, and a token would make the render work for no picture
    // THE CONTENT ARM. Same mode, same question, different leaf — see the section
    // note above for why this is not a second mode id.
    if (ctx?.key !== undefined && ctx.key !== TYPE_KEY)
      return { type: CONTENT_MORPH_TOKEN, key: ctx.key, from: a, to: b, t: alpha };
    // THE CAPABILITY GATE. `ctx.morphable` is the render-independent answer to
    // "can these two actually morph", supplied by the ONE call site
    // (core/deltas.mutBlendApply) which is where a registry can be reached. When
    // the caller supplies nothing — every bare fold in a test, a tool, or any
    // consumer that has no registry in hand — the answer is a TOKEN anyway: the
    // token is inert to anything that does not understand it, and the render
    // seam re-asks the plugins for real before drawing a single pixel. Refusing
    // here instead would make the fold's answer depend on WHO folded it, which
    // the property-state law forbids.
    if (ctx?.morphable === false) return b;
    return { type: MORPH_TYPE_TOKEN, fromType: a, toType: b, t: alpha };
  },
});

/**
 * The paint `type` tags this seam recognizes — the CLOSED roster
 * render_gpu/ir.js `parsePaint` itself dispatches on (solid / material / the two
 * gradients / the explicit off), plus the crossfade this module mints.
 *
 * A CLOSED LIST AND NOT "any object with a string type", AND THE DIFFERENCE WAS
 * A LIVE BUG. The open test was true of a POWERRP ITEM BAG — `{type: "rect", w,
 * h, fill, …}` is an object with a string `type` — so a keyframe that RETYPED a
 * widget made `defaultModeFor(itemBag, itemBag, itemId)` answer "blend", and
 * because `blend` claims trees the whole item was replaced mid-transition by
 * `{type: "crossfade", from: …, to: …}`. Measured on the pre-morph tree: a
 * rect→circle keyframe folded at alpha 0.5 to a crossfade wrapper with NO w, NO
 * h and NO fill, so derive then met a "crossfade" widget type and threw
 * `Unknown widget type "crossfade"`. Retyping is a shipped feature
 * (core/retype.js), so this was reachable without the morph mode existing at all
 * — the morph wave only made it the FIRST thing anyone tried.
 *
 * The lesson generalizes past this one fix: a shape test keyed on the PRESENCE of
 * a field is a claim about every object that happens to have it. `type` is the
 * most-used discriminator in this codebase, so it is exactly the wrong field to
 * key an open test on.
 */
export const PAINT_TYPE_TAGS = ["solid", "material", "linearGradient", "radialGradient", "none", CROSSFADE_PAINT_TYPE];

/**
 * Pure function. Is this value an OBJECT-shaped paint — a material, a gradient,
 * a solid wrapper or an explicit "none"? The shape test the paint default keys
 * off. Hex strings and rgba arrays are NOT included: they have a true numeric
 * midpoint, which `tween` already computes; and an ITEM BAG is not included
 * either, however much it looks like one (see PAINT_TYPE_TAGS).
 *
 * @example isPaintShaped({type: "material", material: {id: "crt"}}) // true
 * @example isPaintShaped({type: "linearGradient", stops: []}) // true
 * @example isPaintShaped({type: "none"}) // true (an explicit OFF paint is a paint)
 * @example isPaintShaped({type: "rect", w: 100, h: 50, fill: "#f00"}) // false (an ITEM BAG is not a paint)
 * @example isPaintShaped("#ff0000") // false (a color tweens per channel)
 * @example isPaintShaped([1, 0, 0, 1]) // false (a parsed rgba array)
 * @example isPaintShaped(5) // false
 */
export function isPaintShaped(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && PAINT_TYPE_TAGS.includes(v.type));
}

/**
 * Pure function. THE DEFAULT-MODE SEAM: the mode a leaf takes when the document
 * stores no `<key>~interp` for it. Consulted at the ONE call site in
 * core/deltas.mutBlendApply, AFTER a stored mode has had its say — an explicit
 * mode always wins, so an author who wants a material to snap can still pick
 * `step` and this never overrides them.
 *
 * The rule is one line and deliberately shape-driven, not key-driven: a pair of
 * OBJECT-shaped paints (material ↔ gradient ↔ solid-wrapper, in any combination)
 * defaults to `blend`; everything else defaults to `tween`, byte-identically to
 * before this function existed.
 *
 * Args:
 *   a (*): the current folded value
 *   b (*): the delta's target value
 *   key (string): the state key (carried for future key-specific defaults and
 *     for the error text; the rule below does not read it)
 *
 * Returns:
 *   string: a registered mode id
 *
 * THE SECOND DEFAULT IS `type` → `morph`, and it is the user's "Morph is the
 * default interpolation type for a widget like that" plus their "auto as the
 * default". AUTO IS NOT A THIRD MODE ID — it is this function: a `type` pair
 * defaults to `morph`, and `morph`'s own blend is what falls back to the
 * discrete switch when the two plugins cannot actually morph (see
 * `morphPairPolicy` and the gate in the mode's `blend`). Making "auto" a
 * registered id instead would put a mode in the Inspector's list that is not a
 * blend law but a question about two other laws, and every consumer would have
 * to special-case it. One default + one gate says the same thing with no new
 * concept, and an author who wants the old snap still picks `step`.
 *
 * @example defaultModeFor({type: "material", material: {id: "crt"}}, {type: "linearGradient", stops: []}, "fill") // "blend"
 * @example defaultModeFor({type: "material", material: {id: "crt"}}, {type: "material", material: {id: "comic"}}, "fill") // "blend"
 * @example defaultModeFor("#ff0000", "#0000ff", "fill") // "tween" (colors already blend per channel)
 * @example defaultModeFor("rect", "circle", "type") // "tween" (the UNIVERSAL morph property carries a retype now)
 * @example defaultModeFor("rect", "video", "type") // "tween" (same: `type` is an ordinary discrete leaf again)
 * @example defaultModeFor("bold", "italic", "fontStyle") // "tween" (a string that is not the type key)
 * @example defaultModeFor(0, 10, "x") // "tween"
 * @example defaultModeFor(false, true, "active") // "tween" (fade stays OPT-IN — the user asked for step-by-default on Visible)
 */
export function defaultModeFor(a, b, key) {
  if (isPaintShaped(a) && isPaintShaped(b)) return "blend";
  // THE `type` → `morph` DEFAULT IS GONE, and its removal is the migration
  // (user ruling, 2026-08-02 night — see core/morph_property.js's header). Morph
  // is now a UNIVERSAL PROPERTY that asks about the widget's OUTLINE rather than
  // about any one leaf, and it engages a retype through the same door it engages
  // an icon swap, an equation edit or a tooth-count change. Leaving this default
  // in place would mint a SECOND, mid-tween-derived token for the same
  // transition — the very re-derivation the endpoint law exists to stop.
  //
  // A `type` pair therefore takes the ordinary discrete law here, exactly as it
  // did before morphing existed. The picture does not regress: core/deltas mints
  // the universal token for the same transition, and core/derive prefers it.
  return DEFAULT_INTERP_MODE;
}

/** The state key holding a widget's plugin type — the leaf `morph` rides. Named
 * rather than spelled inline because two functions here test against it and a
 * bare "type" string reads like any other property name at both sites. */
export const TYPE_KEY = "type";

/**
 * Pure function. THE DISPLAY SIDE of defaultModeFor: which mode the Inspector's
 * interp select SHOWS for a property whose companion key is absent.
 *
 * WHY IT EXISTS. The select used to display a hardcoded DEFAULT_INTERP_MODE for
 * every absent companion, which made it LIE on exactly the rows the default-mode
 * seam was added for: a paint row with nothing stored blends at render time
 * (defaultModeFor above) while the control read "Tween". A select that names a
 * mode the renderer is not using is worse than no select — it is the one place
 * an author goes to ask what a property does.
 *
 * WHY ONE VALUE AND NOT TWO. defaultModeFor answers about a TRANSITION and takes
 * the pair (a → b); the Inspector is showing ONE slide's folded value and has no
 * second one — the next keyframe may not exist yet, and on the last slide never
 * will. So this asks the question the display can actually answer: is this
 * property PAINT-SHAPED right now? Feeding the value in as both sides is not a
 * shortcut but the precise claim — `blend` is reachable iff BOTH ends are paint,
 * so a paint-valued property is exactly one whose OTHER end decides it, and a
 * non-paint value cannot reach `blend` no matter what it moves to. The residual
 * imprecision is one-directional and small: a paint that switches to a bare hex
 * colour mid-deck displays "Blend" and tweens. Naming a REAL default the author
 * will usually get beats naming one they get only when nothing is a material.
 *
 * Args:
 *   value (*): the property's folded value on the slide being shown
 *   key (string): the state key (carried for parity with defaultModeFor)
 *
 * Returns:
 *   string: a registered mode id — what the select displays when nothing is stored
 *
 * @example displayedDefaultModeFor({type: "material", material: {id: "crt"}}, "fill") // "blend"
 * @example displayedDefaultModeFor({type: "linearGradient", stops: []}, "fill") // "blend"
 * @example displayedDefaultModeFor("#ff0000", "fill") // "tween" (a colour tweens per channel)
 * @example displayedDefaultModeFor(0, "x") // "tween"
 * @example displayedDefaultModeFor(undefined, "x") // "tween" (nothing folded here yet)
 */
export function displayedDefaultModeFor(value, key) {
  return defaultModeFor(value, value, key);
}

// ── THE VISIBILITY-EFFECT TOKEN: how a `visible` mode reaches the renderer ────
//
// `fade` above answers with a BARE NUMBER, and that was right for one mode: the
// number IS the coverage, and render_gpu/ports.js applyActiveFade multiplies it
// into every op. But two more modes (WORKSTREAMS FF2 and JJ) also produce a
// fractional visibility, and they draw DIFFERENT PICTURES from the same fraction
// — a blurred one, a half-traced one. A bare number cannot say which, so the
// render walk would have to guess, and there is no honest guess available.
//
// So a mode that needs to be NAMED downstream mints a token instead:
//
//     {type: "~visibleFx", mode, v}
//
// exactly the `~morph` / `~morphContent` / `~morphUniversal` precedent, one key
// over, and for the identical reasons:
//
//   1. THE `~` SIGIL. A machine-namespace state VALUE, unreachable from an
//      equation and impossible for a plugin type string to collide with — this
//      module's own argument for `~interp` keys, applied to a value.
//   2. IT CARRIES SCALARS, NOT A PICTURE. A mode id and a number. The fold runs
//      at arbitrary [[slide, alpha]] on any machine and its result lands in every
//      cached slide state and every undo entry, so baking geometry (a trimmed
//      outline!) into the leaf is exactly what the token exists to avoid. The
//      render seam re-derives from `v` where the answer is already needed.
//   3. EVERY EXISTING `active` READER STILL WORKS. The gate is `active !== false`
//      (core/derive.js, core/document.js), and a token is an object — truthy, not
//      `false` — so a mid-transition item is correctly still derived. That is the
//      same test a fractional `fade` already passes.
//
// `fade` DELIBERATELY DOES NOT MINT ONE. Its bare number is byte-identical to
// what it has always folded to, and every consumer of that number — the render
// seam, its tests, any tool reading a folded state — keeps working untouched. A
// token there would be churn with no question to answer: there is only one way
// to draw a plain fade.

/** The `active`-leaf token a mid-transition NAMED visibility mode produces. */
export const VISIBLE_FX_TOKEN = "~visibleFx";

/**
 * Pure function. True for the visibility-effect token — the shape check the
 * render side routes on, defined beside the value that mints it (the isMorphToken
 * / isCrossfadeValue precedent).
 *
 * @example isVisibleFxToken({type: "~visibleFx", mode: "blurFade", v: 0.5}) // true
 * @example isVisibleFxToken(0.5) // false (a plain `fade` fraction)
 * @example isVisibleFxToken(true) // false
 * @example isVisibleFxToken(null) // false
 */
export function isVisibleFxToken(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && v.type === VISIBLE_FX_TOKEN);
}

/**
 * Pure function. The COVERAGE any `active` value contributes, token included —
 * `fadeLevel` widened to the one shape it does not know about. Every reader that
 * only wants "how visible is this" asks here and never has to know a token
 * exists.
 *
 * @example visibleLevel(true) // 1
 * @example visibleLevel(false) // 0
 * @example visibleLevel(0.25) // 0.25 (a plain fade in flight)
 * @example visibleLevel({type: "~visibleFx", mode: "blurFade", v: 0.4}) // 0.4
 * @example visibleLevel(undefined) // 1 (absent means visible)
 */
export function visibleLevel(v) {
  return isVisibleFxToken(v) ? fadeLevel(v.v) : fadeLevel(v);
}

/**
 * Pure function. The blend law both NAMED visibility modes share: read both ends
 * as coverage, lerp, and mint a token carrying the mode's own name.
 *
 * The endpoint law is the call site's (core/deltas.mutBlendApply fixes alpha 0
 * and 1 to the stored booleans), so this is only ever reached strictly inside a
 * transition and a token never reaches a folded slide state, a save or an export.
 *
 * NON-BOOLEAN ENDPOINTS take the ordinary law, exactly as `fade` does: these
 * modes are boolean-only by `appliesTo`, and a document that stored one on some
 * other row should get that row's honest tween rather than an error box.
 *
 * MODE PARAMETERS RIDE THE TOKEN AS SCALARS (WORKSTREAM AP), spread in beside
 * `v`. That is the token's standing rule — "it carries scalars, not a picture" —
 * and it is why a parameter needed no new plumbing between here and the paint:
 * the render seam already receives this object and reads fields off it.
 *
 * @example namedVisibleBlend("manim", true, false, 0.25) // {type: "~visibleFx", mode: "manim", v: 0.75} (out is in, reversed — one rule, no branch)
 * @example namedVisibleBlend("blurFade", false, true, 0.25, {blur: 64}) // {type: "~visibleFx", mode: "blurFade", v: 0.25, blur: 64}
 * @example namedVisibleBlend("blurFade", 3, 7, 0.5) // 5 (a numeric row falls through to the ordinary tween)
 */
function namedVisibleBlend(mode, a, b, alpha, params) {
  const boolish = (v) => typeof v === "boolean" || typeof v === "number" || v === undefined || isVisibleFxToken(v);
  if (!boolish(a) || typeof b !== "boolean") return interpolate(a, b, alpha);
  const v = lerpFade(visibleLevel(a), visibleLevel(b), alpha);
  return { type: VISIBLE_FX_TOKEN, mode, v, ...params };
}

// ── `blurFade`: INTO AND OUT OF FOCUS ────────────────────────────────────────
//
// User request, 2026-08-02, verbatim (WORKSTREAM FF2, two messages): "There
// should be another option for making visible by the way, which could be blur
// fade. To blur+fade into / out of focus..." then "BUT for that blur fade thing
// we first need to have a 'blur' effect (accessible in the effects area of all
// the widgets)".
//
// The second message is the design: this mode does not invent a blur, it RIDES
// the universal `gaussianBlur` effect that landed for it (eb78727). So the whole
// mode at this layer is the fade's coverage number plus a name, and the render
// seam composes BOTH consequences — opacity through the same multiplication
// `fade` uses, radius through the effects bundle the author can already reach.
//
// WHY IT IS NOT TWO MODES STACKED. An author cannot put two interp modes on one
// leaf, and writing a `gaussianBlur` keyframe from a mode on `active` would
// break mutBlendApply's one-leaf-in-one-value-out contract and clobber whatever
// blur the author had already set. The token says "this item is 40% visible IN
// THE blurFade SENSE" and the render seam is where that sentence becomes two
// numbers — which is also the only place that knows what blur the widget already
// carries, so the two can COMPOSE rather than one overwriting the other.
//
// ── THE AMOUNT IS THE AUTHOR'S, NOT A CONSTANT (WORKSTREAM AP) ───────────────
// User, 2026-08-02, verbatim: "BlurFade is too subtle for me right now, so I
// can't adjust it. It would be nice to be able to adjust it and also by default
// have it blurrier for the BlurFade entry effect." The mode's defocus WAS a
// Claude-chosen module constant (BLUR_FADE_MAX_RADIUS = 24) with no way to
// reach it; it is now the declared parameter below, and the constant survives
// only as that parameter's default.
//
// THE SENSE OF THE NUMBER — this is what makes the user's other sentence true.
// "the blur fade should be animating from big blur to whatever blur is in the
// target" (2026-08-02). `blur` is the EXTRA defocus at the start, ADDED to the
// widget's own settled `gaussianBlur`, so the entry runs
//     target + blur   →   target
// and the end is the widget's own look BY CONSTRUCTION for every value of the
// knob. It is a DIFFERENCE and not an absolute start radius on purpose: the
// user's own words for what they want to choose are "what is the difference in
// blur?", and an absolute start would make a widget with a 40-unit target blur
// SHARPEN on the way in whenever the knob was set below 40.
//
// THE DEFAULT IS 64, RAISED FROM 24, AND THE ARGUMENT IS A MEASUREMENT — CLI
// stills at a sweep of amounts and coverages, not a calculation. The obvious
// sizing argument (BLUR_SUPPORT_SIGMAS·σ = 3σ must exceed the widget's own width,
// so σ = 64 smears ±192 units across a 200-500-unit widget) turns out NOT to be
// what decides this, and saying so is the point of this paragraph: the stills
// showed σ = 24 ALREADY destroying a 110pt glyph completely at v = 0.5. If
// legibility at the midpoint were the test, 24 would have passed it and the
// user's "too subtle" would be inexplicable.
//
// WHAT ACTUALLY DECIDES IT IS WHERE THE BLUR LIVES RELATIVE TO THE OPACITY. Both
// ramp linearly in v, so the defocus is largest exactly when the widget is most
// TRANSPARENT — i.e. when nothing can be seen at all — and by the time coverage
// is high enough to perceive anything, the radius has nearly collapsed. Measured
// at v = 0.85 (opacity 85%, the first frames where the widget really reads):
// amount 24 gives σ = 3.6 and the still is CRISP with a faint softness, which is
// the "too subtle" exactly; amount 64 gives σ = 9.6 and the still is an
// unmistakable defocus still resolving into sharpness. The whole gesture happens
// in the last fifth of the transition, so the amount has to be large enough that
// a FIFTH of it is still a real blur.
//
// (A slower-than-linear decay — σ ∝ amount·√(1−v) — would put the blur in the
// visible range directly and is probably the better curve. It is NOT shipped
// here: the user asked for a knob and a blurrier default, and changing the decay
// law as well would be a second, unrequested change to how the mode reads. The
// measurement is recorded so that work has a starting point.)

registerInterpMode({
  id: "blurFade",
  label: "Blur Fade",
  help: "Bring the item into focus as it appears: it starts transparent and heavily blurred, then sharpens and solidifies together (and defocuses back out again when it is hidden). Rides the same Blur effect the Effects rows expose, added on top of whatever blur the item already has — so it always lands on the item's own settled look. Set Blur Amount to choose how far out of focus it starts.",
  // BOOLEAN-VALUED ROWS ONLY — the same domain, and the same argument, as `fade`:
  // this ramps COVERAGE, and coverage is what a boolean has. The user asked for
  // it as an option "for making visible", which is this row.
  appliesTo: ({ value }) => typeof value === "boolean",
  // THE ONE DECLARED PARAMETER, and the first in the app. `min: 0` is a real
  // boundary rather than a taste limit — a negative extra defocus would mean the
  // item enters SHARPER than it settles, which is not this mode. Zero is legal
  // and meaningful: it degrades blurFade to exactly `fade`, which is an honest
  // answer for an author dialing the effect off without re-picking the mode.
  params: [{
    param: "blur",
    label: "Blur Amount",
    default: 64,
    min: 0,
    help: "How much EXTRA blur the item starts with, in canvas units, on top of whatever blur it settles at. The entry runs from (its own blur + this) down to its own blur, so it always ends on the item's real look. Larger is more dramatically out of focus; 0 makes this a plain fade.",
  }],
  blend: (a, b, alpha, ctx) => namedVisibleBlend("blurFade", a, b, alpha, ctx?.params),
});

// ── `manim`: THE BORDER DRAWS ITSELF, THEN THE FILL ARRIVES ──────────────────
//
// User request, 2026-08-02, verbatim (WORKSTREAM JJ): "Menom [Manim] actually
// has a really nice entry animation where the border is kind of drawn first and
// then the inside is filled and stuff like that... that should be an available
// visibility interpolation option. It can be called Menom [Manim] because it's
// such a classical Menom thing to do."
//
// THE USER NAMED THE MODE, so the label is "Manim" and not a description of it.
//
// The ALGORITHM is core/manim_draw.js (DrawBorderThenFill/Write, ported per
// refs/manim_write_research.md); the RENDER is render_gpu/ports.js. This
// registration is only the third of the three: what the leaf folds to. It mints
// the same token `blurFade` does, with a different name in it — which is the
// whole reason the token carries a mode id rather than the render side inferring
// one from the number.
//
// A WIDGET WITH NO OUTLINE (a photo, a video) CANNOT TRACE A BORDER, and the
// fallback is a plain fade — decided at the render seam, not here, for the same
// reason the morph mode's capability gate lives there: this function has no
// registry and no plugin in hand, and an answer that depended on WHO folded the
// state would break the property-state law. The seam reports the degradation.

registerInterpMode({
  id: "manim",
  label: "Manim",
  help: "Draw the item on the way Manim does: its outline traces itself in first, contour by contour, then the fill rises underneath. Reverses to match when it is hidden — the fill fades out, then the border un-draws. Items with no outline (photos, video) simply fade.",
  appliesTo: ({ value }) => typeof value === "boolean",
  blend: (a, b, alpha) => namedVisibleBlend("manim", a, b, alpha),
});

// ── `grow`: THE WIDGET SCALES UP FROM NOTHING, AND BACK DOWN ─────────────────
//
// User request, 2026-08-03, verbatim (WORKSTREAM BS): "Another intro... sorry,
// visible interp should be growing from nothing or shrinking back to nothing."
//
// So: appearing = scale 0 → the widget's authored size; disappearing = the same
// ramp read backwards. Like every mode in this family it is a VISIBILITY effect,
// so it rides `active` and mints the same `~visibleFx` token blurFade and manim
// do, with its own name in it. That is the whole of this layer: the RENDER half
// (render_gpu/ports.js growScaledWorld) is what turns the coverage into a scale.
//
// ── IT IS NOT A FADE, AND IT DELIBERATELY DOES NOT STACK ONE ────────────────
// The other two named modes both ALSO fade, because both are ways of resolving
// INTO focus and opacity is half of that gesture. Growing is not: a widget that
// scales up from a point is already unmistakably arriving, and multiplying a
// fade on top would make the first half of the entry a barely-visible speck
// instead of a small solid widget. `applyActiveFade`'s token branch is therefore
// the one place this mode differs from its siblings — see growOpacityLevel
// there for why that exception lives at the render seam rather than here.
//
// ── NO PARAMETER, DELIBERATELY (the AP machinery is available and declined) ──
// The obvious knob is an overshoot/back-ease ("grow to 110% then settle"), and
// AP's params machinery would carry it in three lines. It is NOT shipped: the
// founding block asks for a default that is "natural and restrained", an
// overshoot is a taste that reads as a bounce rather than an arrival, and a
// parameter whose default is 0 would put a control in the Inspector that does
// nothing until an author goes looking for it. The ramp is linear in coverage
// for the same reason the blur half of blurFade is: the scale and the
// transition's own curve then read as ONE gesture, and an author who wants an
// ease already has the transition curve to spend on it.

registerInterpMode({
  id: "grow",
  label: "Grow",
  help: "Scale the item up from nothing to its full size as it appears, and shrink it back down to nothing when it is hidden. It grows about its own centre (its rotation anchor), so it expands in place rather than sliding out of a corner, and a rotated item keeps its angle the whole way. Unlike Fade it stays fully opaque while it grows — the arrival is the size change, not a dissolve.",
  // BOOLEAN-VALUED ROWS ONLY — the same domain and the same argument as `fade`
  // and `blurFade`: this ramps COVERAGE, and coverage is what a boolean has.
  appliesTo: ({ value }) => typeof value === "boolean",
  blend: (a, b, alpha) => namedVisibleBlend("grow", a, b, alpha),
});
