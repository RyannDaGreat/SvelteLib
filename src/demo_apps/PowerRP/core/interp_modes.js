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
 *   ctx    `{key, mode}` — the state key being blended and the resolved mode id.
 *          THIS IS THE EXTENSION POINT. A future mode that needs more (the whole
 *          owning state object for `morph`, the plugin registry for `blend`)
 *          gets it by adding a FIELD TO ctx at the ONE call site in
 *          core/deltas.mutBlendApply — the mode entries themselves, this
 *          module's exports, and every existing caller are untouched, because
 *          ctx is a bag and every mode ignores the fields it does not read.
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
 * Takes the LAST path segment, never a dotted path: the companion is a SIBLING
 * of the leaf, so `shadow.offsetX`'s mode lives at `shadow.offsetX~interp`
 * (i.e. inside `shadow`), which is what a path-joined caller gets for free.
 *
 * @example interpKeyFor("x") // "x~interp"
 * @example interpKeyFor("visible") // "visible~interp"
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
  if (MODES.has(entry.id))
    throw new Error(`registerInterpMode("${entry.id}"): that mode id is already registered — two modes cannot share a name`);
  MODES.set(entry.id, { help: "", ...entry });
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
 * @example interpModeIds() // ["tween", "step"]
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
export function blendUnderMode(a, b, alpha, ctx) {
  const entry = MODES.get(ctx.mode);
  if (!entry)
    throw new Error(
      `Unknown interpolation mode ${JSON.stringify(ctx.mode)} on "${ctx.key}${INTERP_KEY_SUFFIX}". Registered: ${interpModeIds().join(", ")}`,
    );
  return entry.blend(a, b, alpha, ctx);
}

// ── The two shipped modes ────────────────────────────────────────────────────

registerInterpMode({
  id: DEFAULT_INTERP_MODE,
  label: "Tween",
  help: "Interpolate smoothly across the transition — numbers lerp, colors blend per channel, same-shaped lists and records blend element-wise. Values with no blend law (strings, booleans, shape changes) still switch at the start. This is the default.",
  // Byte-identical to the pre-mode path: this IS core/interpolators.interpolate,
  // which is why an absent companion key folds to exactly the old bytes.
  blend: (a, b, alpha) => interpolate(a, b, alpha),
});

registerInterpMode({
  id: "step",
  label: "Step",
  help: "Jump to the new value the instant the transition begins, with no in-between — a step function. What a boolean or a text property already does, available for any property.",
  // The user's "the property x would just immediately move, just like a discrete
  // property". mutBlendApply only reaches a mode with alpha > 0, so this is the
  // discrete rule verbatim: past zero, you are already there.
  blend: (a, b) => b,
});
