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
 * @example interpModeIds() // ["tween", "step", "fade", "blend", "morph"]
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
  help: "Dissolve between the two values instead of switching. On Visible this is a cross-fade from 0% to 100% opacity across the transition (and back out again when the item is hidden); on a numeric property it is the ordinary tween.",
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
  help: "Cross-fade the two paints: both are drawn during the transition and alpha-composited, so any fill can dissolve into any other — a solid into a gradient, a gradient into a material, one material into another. The default when a fill or material changes.",
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

registerInterpMode({
  id: "morph",
  label: "Morph",
  help: "Flow one widget's outline into the other's across the transition, contour by contour — a rectangle becoming a circle, an icon becoming a logo. Available when both widgets are vector shapes; anything else switches at the start instead.",
  // A mid-morph `type` leaf is a plain string on both endpoints, so this mode
  // does NOT claim trees — there is no subtree to protect, unlike a paint.
  blend: (a, b, alpha, ctx) => {
    // TWO REAL TYPE NAMES OR NOTHING. An ADDITION (the item is being created on
    // this slide, so there is no outgoing type) and a REMOVAL have only one
    // outline, and there is no morphing from nothing — those take the ordinary
    // discrete law, exactly as `blend` does for a one-operand paint.
    if (typeof a !== "string" || typeof b !== "string") return interpolate(a, b, alpha);
    if (a === b) return b; // the type did not change: no morph to run
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
 * Pure function. Is this value an OBJECT-shaped paint — a material, a gradient,
 * a solid wrapper or an explicit "none"? The shape test the paint default keys
 * off. Hex strings and rgba arrays are NOT included: they have a true numeric
 * midpoint, which `tween` already computes.
 *
 * @example isPaintShaped({type: "material", material: {id: "crt"}}) // true
 * @example isPaintShaped({type: "linearGradient", stops: []}) // true
 * @example isPaintShaped("#ff0000") // false (a color tweens per channel)
 * @example isPaintShaped([1, 0, 0, 1]) // false (a parsed rgba array)
 * @example isPaintShaped(5) // false
 */
export function isPaintShaped(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string");
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
 * @example defaultModeFor("rect", "circle", "type") // "morph" (auto: the pair gate decides whether it really morphs)
 * @example defaultModeFor("rect", "video", "type") // "morph" (still auto — morph's own blend falls back for an unmorphable pair)
 * @example defaultModeFor("bold", "italic", "fontStyle") // "tween" (a string that is not the type key)
 * @example defaultModeFor(0, 10, "x") // "tween"
 * @example defaultModeFor(false, true, "active") // "tween" (fade stays OPT-IN — the user asked for step-by-default on Visible)
 */
export function defaultModeFor(a, b, key) {
  if (isPaintShaped(a) && isPaintShaped(b)) return "blend";
  if (key === TYPE_KEY && typeof a === "string" && typeof b === "string") return "morph";
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
