/**
 * THE UNIVERSAL MORPH PROPERTY — one per-widget row that decides how a widget's
 * SHAPE crosses a transition, whatever changed to make the shape different.
 *
 * ── THE USER RULING THIS IMPLEMENTS (2026-08-02, night, verbatim) ─────────────
 *   "you made a great point that I didn't realize, which is, yeah, it's not
 *    changing the type so it won't morph. Then this means that it shouldn't just
 *    be a subset of a widget type, right? Maybe that widget type doesn't have an
 *    interpolation option, so when I mouse over it, I don't get that. And it
 *    would just be under a universal option. Same thing for maybe visible in
 *    Terp. Actually, no visible interp can stay like that for now, but the other
 *    one, maybe it should just be a morph universal property."
 *
 * ── WHAT WAS WRONG WITH THE PER-KEY DESIGN, WHICH IS THE WHOLE ARGUMENT ───────
 * Morphing used to be a `~interp` MODE on whichever leaf happened to change: on
 * `type` for a retype, on `latex`/`text` for a re-edit. That put ONE question —
 * "should this widget's shape flow or switch?" — behind N different controls, and
 * the author had to know WHICH leaf a given visual change lived on before they
 * could ask it. The user's catch is exactly that: an equation edit does not touch
 * `type`, so the type row's morph mode could not reach it, and no amount of
 * setting that row would ever make an equation morph.
 *
 * Worse, the roster of leaves that change a widget's outline is OPEN. A gear's
 * `teeth`, an icon's `icon`, a shapeshifter's family, an equation's source, a
 * text box's string, a widget's whole `type` — and every widget added later. A
 * per-key mode needs a new registration for each; a universal property needs
 * none, because it does not ask WHAT changed at all. It asks whether the two
 * ENDPOINT OUTLINES differ, which is the question the author actually means.
 *
 * ── THE PROPERTY ─────────────────────────────────────────────────────────────
 * State key `morph`, a plain keyframeable universal property (core/properties.js
 * declares the row; it is injected for every widget exactly as `active` is). Four
 * values, and the DEFAULT IS ABSENT — an untouched document stores nothing and
 * reads SNAP:
 *
 *   snap      (default) The discrete switch, and the behavior every widget had
 *             before morphing existed. USER RULING, 2026-08-07: "the default
 *             transition should be [snap] not auto for most things make that the
 *             true default we morph only if we want." Morphing is the special
 *             effect, so it is the thing you ASK for; a shape that reflows because
 *             an equation was edited is a surprise the author did not order.
 *             Mints no token and does no render work.
 *   auto      Morph whenever both ENDPOINT outlines exist and DIFFER, whatever
 *             caused the difference. Crossfade when either side cannot produce an
 *             outline. This was the default until the ruling above.
 *   morph     FORCE. Morph even where auto would decline to; if the outlines are
 *             genuinely unavailable, fall to CROSSFADE and REPORT the reason
 *             (never silently switch — the author asked for something specific).
 *   crossfade Always cross-render: draw BOTH endpoint states and composite them
 *             at (1-t)/t opacity. The honest answer for a pair with no outlines.
 *
 * IT IS A PLAIN PROPERTY, and that is load-bearing rather than incidental: it
 * rides deltas, keyframes, undo, copy and serialization with zero new concepts,
 * and it STEPS AT TRANSITION START like every `~interp` value — the incoming
 * slide's mode governs the whole blend, per the user's "flicked immediately at
 * the beginning". A string leaf is already discrete under `interpolate`, so that
 * falls out of the storage choice for free; `morphModeForBlend` states it
 * explicitly rather than relying on the coincidence.
 *
 * ── THE ENDPOINT LAW, WHICH IS ALSO THE JIGGLE FIX (workstream II) ────────────
 * USER BUG, verbatim: a gear→square morph "jiggle[s] and spazz[es]" when SIZE
 * tweens at the same time.
 *
 * DIAGNOSIS, and it is a design defect rather than a numerical one: the old token
 * carried only `{fromType, toType, t}`, so core/derive.js rebuilt BOTH morph
 * payloads from the MID-TWEEN folded state on every frame. Alignment is not a
 * continuous function of its inputs — it makes DISCRETE decisions (which contour
 * pairs with which, which cyclic start point, which winding) — so re-deriving it
 * from a state that is itself moving lets those decisions FLIP between adjacent
 * frames. A flip re-labels the sampled points, every point jumps to its new
 * counterpart, and the eye reads it as a jiggle. Nothing was numerically wrong;
 * the alignment was simply being re-decided 60 times a second against a moving
 * target.
 *
 * THE LAW: the morph decision AND the alignment derive from the TWO ENDPOINT
 * STATES — the transition's from-fold (the deltas' lazy-start snapshot, which is
 * the `a` the blend seam already receives) and the to-state — and NEVER from the
 * mid-tween state. Both endpoints are FIXED for the whole transition, so the
 * aligned pair is fixed too: core/morph.js's content-keyed memo then holds ONE
 * alignment for the entire transition BY CONSTRUCTION, not by luck. Per frame the
 * only work left is the proven-linear part — lerp the fixed aligned pair, then map
 * it through the CURRENT tweened box.
 *
 * That split is why size may tween freely underneath a morph: the box change is
 * carried by the box (ports.js scales unit output by the node's current w/h) and
 * the shape change by the aligned pair, and neither is allowed to re-decide the
 * other. It is also what makes the memo assertion in the tests meaningful — a
 * hit-rate below 1 alignment per transition would mean an endpoint is leaking a
 * mid-tween value.
 *
 * ── GEOMETRY STAYS OUT OF THE FOLD ───────────────────────────────────────────
 * The token below carries SCALARS, STRINGS and STATE REFS only — never geometry.
 * This is the `~morph`/crossfade precedent and the argument is unchanged: the
 * fold runs at arbitrary [[slide, alpha]] on any machine, and baking a path list
 * into a folded state would put it into every cached slide state, every undo
 * entry and every serialized form the fold touches. Two endpoint STATE BAGS are
 * the same objects the fold already holds; two outline payloads would be
 * thousands of control points. The render seam asks the plugins for outlines at
 * paint time, where the answer is needed anyway and is already memoized.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/**
 * The universal state key. A plain identifier — unlike the `~interp` companions
 * this is an ORDINARY author-facing property with a row of its own, so it lives
 * in the normal namespace and an equation could read it like any other leaf.
 */
export const MORPH_KEY = "morph";

/** The AUTO mode's id. Named separately from the DEFAULT below because the two
 * used to be the same value and are no longer — see MORPH_DEFAULT. */
export const MORPH_AUTO = "auto";

/** The SNAP mode's id — the discrete switch. */
export const MORPH_SNAP = "snap";

/**
 * THE MODE A WIDGET HAS WHEN IT STORES NOTHING. User ruling, 2026-08-07: snap is
 * "the true default we morph only if we want".
 *
 * Read this, never MORPH_AUTO, wherever you mean "the absent value" — the two
 * were one constant until that ruling, so every `absentValue: MORPH_AUTO` in the
 * tree was a place that meant DEFAULT and said AUTO. Keeping one name for each
 * meaning is what stops the next change from having to find them all again.
 */
export const MORPH_DEFAULT = MORPH_SNAP;

/** The four values the universal row offers, in the order it offers them —
 * DEFAULT FIRST, the TRANSITION_TYPES convention. */
export const MORPH_MODES = [MORPH_SNAP, MORPH_AUTO, "morph", "crossfade"];

/** id → label, for the row's optionLabels. */
export const MORPH_MODE_LABELS = {
  auto: "Auto",
  morph: "Morph",
  crossfade: "Crossfade",
  snap: "Snap",
};

/** id → the sentence the row's help gives for each option. Written as a
 * consequence the author can see, not as a mechanism. */
export const MORPH_MODE_HELP = {
  auto: "Reshape the outline whenever it actually changes — a retype, a new icon, an edited equation, a different tooth count — and cross-dissolve when a widget has no outline to flow (a video, a photo).",
  morph: "Always reshape, even where Auto would decline. If an outline genuinely cannot be produced, it cross-dissolves instead and says why.",
  crossfade: "Draw BOTH the old and the new widget across the transition and dissolve one into the other. The honest answer when the two have nothing in common to flow.",
  snap: "Switch at the instant the transition begins, with no in-between — the behavior every widget had before morphing existed. This is the default and needs no setting: reshaping is the effect you ask for, not the one you get by accident.",
};

/**
 * The mid-transition token the universal property mints. Same `~` machine-
 * namespace sigil the rest of this family uses, so no author-authored string can
 * collide with it.
 *
 * SHAPE: `{type: "~morphUniversal", mode, from, to, t}` where `from`/`to` are the
 * two ENDPOINT ITEM STATES (state refs — see the header's geometry note) and
 * `mode` is the RESOLVED universal mode this transition runs under.
 *
 * IT SITS ON THE `morph` LEAF, not on `type` and not on a content key. That is
 * the whole point of the universal design: one leaf, one token, one place for
 * derive to look, regardless of which property's change made the outlines differ.
 */
export const UNIVERSAL_MORPH_TOKEN = "~morphUniversal";

/**
 * Pure function. True for the universal morph token — the shape core/derive.js
 * routes on. Defined beside the value that mints it, the isMorphToken /
 * isCrossfadeValue precedent.
 *
 * @example isUniversalMorphToken({type: "~morphUniversal", mode: "auto", from: {}, to: {}, t: 0.5})
 * true
 * @example isUniversalMorphToken("auto")
 * false
 * @example isUniversalMorphToken(null)
 * false
 */
export function isUniversalMorphToken(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && v.type === UNIVERSAL_MORPH_TOKEN);
}

/**
 * Pure function. THE MODE-STEPS-AT-START RULE for the universal property — the
 * exact sibling of core/interp_modes.modeForBlend, and separate from it only
 * because this property's absent value is `auto` rather than `tween`.
 *
 * The TARGET wins the moment the transition begins (the user's "flicked
 * immediately at the beginning"), the standing value carries when the delta is
 * silent, and absent is the DEFAULT — snap, since 2026-08-07.
 *
 * @example morphModeForBlend(undefined, undefined)
 * 'snap'
 * @example morphModeForBlend("auto", undefined)
 * 'auto'
 * @example morphModeForBlend(undefined, "crossfade")
 * 'crossfade'
 * @example morphModeForBlend("auto", "snap")
 * 'snap'
 */
export function morphModeForBlend(from, to) {
  return to ?? from ?? MORPH_DEFAULT;
}

/**
 * Pure function. Does this universal mode want the render seam to do ANY
 * cross-endpoint work at all? `snap` does not — it is the discrete switch, so a
 * token would make derive and ports do work for a picture identical to the one
 * they already draw.
 *
 * @example morphModeIsActive("auto")
 * true
 * @example morphModeIsActive("snap")
 * false
 */
export function morphModeIsActive(mode) {
  return mode !== "snap";
}

/**
 * Pure function. THE ENDPOINT-STATE TOKEN MINT. Two endpoint item states and a
 * resolved mode → the token that rides the `morph` leaf mid-transition, or the
 * plain mode string when this transition has no cross-endpoint work to do.
 *
 * WHY IT TAKES WHOLE STATE BAGS. The endpoint outlines are a function of the
 * whole widget, not of any one leaf — a gear's outline depends on `teeth`,
 * `innerRatio` and `toothWidth`; an icon's on `icon`; an equation's on `latex`.
 * Naming the responsible leaf was the old design and it is exactly what the user
 * overruled. The two bags are the fold's OWN objects, carried by reference, so
 * this allocates one small wrapper and copies nothing.
 *
 * Args:
 *   mode (string): the resolved universal mode (already stepped to the target)
 *   fromState (object): the item's folded state at the transition's START
 *   toState (object): the item's state at the transition's END
 *   t (number): transition alpha, strictly in (0, 1)
 *
 * Returns:
 *   object|string: the token, or `mode` itself when the mode is inert (`snap`)
 *
 * Examples:
 *     >>> const tok = universalMorphToken("auto", {type: "rect", w: 10}, {type: "circle", w: 20}, 0.5);
 *     >>> tok.type
 *     '~morphUniversal'
 *     >>> tok.from.type
 *     'rect'
 *     >>> tok.to.type
 *     'circle'
 *     >>> // `snap` asks for nothing, so no token is minted at all
 *     >>> universalMorphToken("snap", {type: "rect"}, {type: "circle"}, 0.5)
 *     'snap'
 */
export function universalMorphToken(mode, fromState, toState, t) {
  if (!morphModeIsActive(mode)) return mode;
  return { type: UNIVERSAL_MORPH_TOKEN, mode, from: fromState, to: toState, t };
}
