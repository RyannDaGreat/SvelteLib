/**
 * Drag-kind geometry — the PURE math shared by CanvasView's per-kind drag
 * handlers (move/resize/multi-resize/scale-modal). Extracted from CanvasView
 * (manifest UNDEFERRAL SWEEP: "CanvasView drag-machine extraction") so the
 * >2000-line component stops accreting geometry every wave and the math has ONE
 * DOM-free, doctested, node-testable home.
 *
 * SCOPE (a PARTIAL extraction, by design): only the STATELESS geometry lives
 * here — the functions that take explicit args and return values, with no
 * closure over the component's reactive `$state` (drag/guides/app/…). The
 * per-kind HANDLERS themselves (moveDrag/resizeDrag/multiResizeDrag/applyModal)
 * stay in CanvasView because they read and mutate component `$state` + call
 * `app.setPreview`; relocating those needs a mutable-state contract that would
 * be invasive to introduce while other agents are concurrently editing the same
 * component (the agent-scoping/shoelace rule). Those handlers now CALL these
 * pure functions — the shared record contract is: a `member`
 * ({itemId, plugin, rawItem, startX, startY, startWorld, startW, startH}) and a
 * bbox `base` ([x0,y0,x1,y1]) — so a future session can lift the handlers here
 * without changing this math.
 *
 * DOM-free: imports only core/transform + core/derive (also DOM-free), so this
 * module runs in bare node and is covered by tests/dragkinds_test.js.
 *
 * ── THE ONE GEOMETRY-WRITE SEAM (R6-29) ──────────────────────────────────────
 * `geometryPairs` is the ONLY exported way to turn a desired geometry into item
 * writes, and every drag in the app goes through it: body drag, drag-all, nudge,
 * clone home, single resize, group resize, multi-resize, and all three modal
 * transforms. It does three things in a fixed order — PROJECT the desired record
 * onto what the constraint allows, keep only what actually CHANGED, then scope
 * the surviving keys to the item — and the first of those is THE HANDLE-CONSTRAINT
 * PROTOCOL (core/derive.js), the same `constrain(state, desired) → allowed` the
 * yellow-square modifier points have always declared.
 *
 * THE PROJECTION AND THE MINIMAL DELTA ARE THE SAME LAW, which is why they live
 * in one function rather than two. `diffState` drops a coordinate that HAPPENED
 * not to move, so its stored equation survives; `pinning` holds a coordinate at
 * its start value so it CANNOT move, and `diffState` then drops it for exactly
 * the same reason. Discovered stillness and imposed stillness are one mechanism.
 *
 * `itemGeometryPairs` is deliberately NOT exported. Enforcement by module
 * boundary is the difference between "we converted the call sites" and "a widget
 * cannot have its own dialect": a future call site physically cannot skip the
 * projection, rather than being trusted not to.
 */

import * as T from "../../core/transform.js";
import { stateXYForCenterPivotWorld, UNCONSTRAINED, pinning } from "../../core/derive.js";
import { diffState, getPath } from "../../core/deltas.js";
import { wholisticPairs } from "../../core/scaling.js"; // WHOLISTIC SCALE (the W toggle): which non-geometry properties a size gesture carries with it

/**
 * THE drag-kind vocabulary: every value CanvasView may assign to `app.dragKind`,
 * mapped to the HELD MODIFIERS that kind reads (semantic ids, worded once in
 * core/shortcut_entries.js DRAG_MODIFIER_HINTS).
 *
 * WHY IT IS A TABLE AND NOT A COMMENT. This list was maintained by hand in TWO
 * places that both drifted: the HintBar's modifier hints were scoped to
 * "resize" only, and App.svelte's reachability prober walked a list that
 * contained "endpoint" (which nothing assigned back then — the endpoint drag set
 * only a LOCAL record, so it was invisible to every dragKind guard, which is how
 * a mid-drag Escape deselected under it) and omitted "multiresize" (which
 * everything did). Result: a multi-selection resize read Shift and Cmd, changed
 * the outcome, and announced NOTHING — and the guard meant to catch exactly that
 * was structurally blind to it. Both consumers now derive from here:
 *   - app.svelte.js's `dragKind` setter THROWS on a value not in DRAG_KINDS, so a
 *     new kind cannot exist without being declared; and
 *   - the hint entries and the prober are GENERATED from this map, so declaring
 *     a kind gets it probed, and declaring a modifier gets it a chip.
 *
 * A kind with NO modifiers still belongs here — it is a real drag state the
 * prober must walk. "endpoint" and "modifier" — the two single-point handle
 * grabs — read none (a lone point has nothing to relate to) and own ESCAPE
 * instead: CanvasView cancels either from its capture-phase listener
 * (ESC_CANCELABLE_DRAG_KINDS there lists exactly these two).
 */
export const DRAG_KIND_MODIFIERS = Object.freeze({
  move: Object.freeze(["axisLock"]),
  resize: Object.freeze(["uniform", "symmetric"]),
  // A GROUP resize is its own kind because it reads ONE of resize's two
  // modifiers, not both. groupResizeState forces `uniform` on — a group's
  // influence is a single scalar `scale`, and a per-axis group resize would
  // SHEAR its members, which the similarity contract forbids — so Shift is
  // already the only behaviour and a "Uniform scale" chip beside it announces a
  // key that changes nothing. Cmd (scale about the group centre) is real and
  // keeps its chip. Announcing resize's pair here was a HintBar lie of exactly
  // the kind this table exists to prevent, and it is the same defect the
  // multiresize omission was, one axis over: a kind whose true modifier set
  // differs from the kind it borrowed its announcement from.
  groupresize: Object.freeze(["symmetric"]),
  multiresize: Object.freeze(["uniform", "symmetric"]),
  // THE TWO SINGLE-GESTURE PLACEMENT GRAMMARS ARE TWO KINDS, for the same reason
  // groupresize is one: their Shift means DIFFERENT THINGS, so one kind cannot
  // announce both truthfully. `place` runs creationRect, where Shift is resize's
  // uniform scale; `placesegment` runs creationEndpoint, where Shift AXIS-LOCKS
  // the free point (that function's own docstring says so, and says why: a single
  // point has no second dimension to relate a scale to). While there was one kind,
  // dragging out a line or an arrow put "Uniform scale" on the bar for a key that
  // axis-locks — the groupresize lie exactly, one gesture family over.
  //
  // THE CORRECT CHIP ALREADY EXISTED AND WAS ALREADY IN USE. web/polygonDraw.js
  // cites creationEndpoint BY NAME as the in-house axis-lock precedent and declares
  // `modifiers: ["axisLock"]` for its vertex step, so the SAME behaviour was
  // already announced correctly one flow over. This is not new vocabulary; it is
  // the existing answer applied where it was missed.
  place: Object.freeze(["uniform", "symmetric"]),
  placesegment: Object.freeze(["axisLock", "symmetric"]),
  band: Object.freeze(["bandAdd", "bandRemove", "bandInvert"]),
  endpoint: Object.freeze([]),
  modifier: Object.freeze([]),
  // THE WIRE GESTURE (core/nodeflow.js, core/wire_drag.js). NO modifiers, and the
  // empty list is a claim rather than a gap: a wire drop is decided entirely by
  // WHAT IS UNDER THE POINTER (a compatible bead, an incompatible one, or empty
  // space), so there is no key that could change its meaning, and offering one on
  // the HintBar would be the exact lie this table exists to prevent. Shift in
  // particular must stay silent here — a wire has no axis to lock and no scale to
  // make uniform.
  wire: Object.freeze([]),
  // THE LIVE-PLAY GESTURE (plugins/node_button.js, plugins/node_keyboard.js) —
  // pressing a Button's face or holding a Keyboard's key. NO modifiers, and as
  // with `wire` the empty list is a CLAIM rather than a gap: what a press does is
  // decided entirely by what is under the pointer (which key, or the button's
  // face), and there is no key on the keyboard that could change its meaning.
  //
  // Shift in particular must stay silent. It is knob focus's FINE modifier one
  // widget family over, and offering it here would announce a key that does
  // nothing — the exact lie this table exists to prevent. Fine control is a thing
  // you want on a continuous value; a note is not one.
  liveplay: Object.freeze([]),
  // THE KNOB TURN (WORKSTREAM BX) — an always-active dial drag, in or out of knob
  // focus. UNLIKE `wire` and `liveplay` this one DOES read a modifier: Shift is
  // fine control, which divides the drag sensitivity (core/node_knobs.
  // knobDragValue). It is declared here for exactly the reason the multiresize
  // omission is recorded above — a kind that reads a key and changes its outcome
  // without announcing it is the lie this table exists to prevent, and a
  // continuous value is the one thing fine control genuinely applies to (which is
  // why `liveplay`, one widget family over, correctly declares none).
  knob: Object.freeze(["fine"]),
});

/**
 * Every legal `app.dragKind` value (null aside — null means "no drag"), derived
 * from DRAG_KIND_MODIFIERS so the two can never disagree.
 *
 * @example DRAG_KINDS.includes("multiresize") // true
 * @example DRAG_KINDS.length // 12
 */
export const DRAG_KINDS = Object.freeze(Object.keys(DRAG_KIND_MODIFIERS));

/**
 * THE BLENDER-STYLE MODAL TRANSFORMS — every `app.modalXform.kind`, with the key
 * that starts it, the word the HintBar announces it with, whether an X/Y axis
 * constraint means anything for it, and the prompt shown before a number is typed.
 *
 * WHY IT IS A TABLE, and it is the DRAG_KIND_MODIFIERS lesson applied one gesture
 * family over. G and S were two hand-written registry entries, and the HintBar's
 * label came from a hand-written `kind === "scale" ? "Scale" : "Grab"` ternary in
 * App.svelte — a two-branch mirror that answers "Grab" for any third kind. Adding
 * R by editing both would have made the announcement wrong for the new mode while
 * looking finished. Both are now GENERATED from here, so declaring a kind gets it
 * a key, a chip, a label and a probe, and forgetting one is impossible.
 *
 * `axisConstrainable: false` ON ROTATE IS GEOMETRY, NOT AN UNBUILT FEATURE.
 * Blender's `R X` picks one of THREE rotation axes; the plane has exactly one (the
 * screen normal), so an X/Y constraint on a 2D turn has nothing to choose between.
 * The X and Y entries read this flag, so no chip offers a key that would do
 * nothing — which is the HintBar's own law, not a nicety.
 *
 * NUMERIC ENTRY applies to all three, but a grab needs an axis FIRST (a distance
 * has no meaning without a direction — the standing G-numeric-requires-axis
 * ruling), which is why its prompt asks for one and the other two do not.
 * A rotate's number is in DEGREES, converted through the same display transform
 * the Inspector's rotation dial uses (web/displayUnits.js).
 *
 * @example MODAL_TRANSFORM_KINDS.rotate.key // "R"
 * @example MODAL_TRANSFORM_KINDS.rotate.axisConstrainable // false
 * @example Object.keys(MODAL_TRANSFORM_KINDS) // ["grab", "scale", "rotate"]
 */
export const MODAL_TRANSFORM_KINDS = Object.freeze({
  grab: Object.freeze({ key: "G", label: "Grab", axisConstrainable: true, numericPrompt: "pick an axis (X/Y) to type a distance" }),
  scale: Object.freeze({ key: "S", label: "Scale", axisConstrainable: true, numericPrompt: "type a factor" }),
  rotate: Object.freeze({ key: "R", label: "Rotate", axisConstrainable: false, numericPrompt: "type an angle in degrees" }),
});

/**
 * THE MODAL TOGGLES — the keys that change WHAT a live modal transform means,
 * rather than starting or ending one. Two today (user, 2026-08-12: "in s and r,
 * the 'i' key should toggle 'individual' vs as a whole, and 'w' hsould toggle
 * 'wholistic'"), and a table for the same reason the two above it are: a toggle
 * needs a key, a chip, an announcement segment and a statement of WHICH kinds it
 * applies to, and hand-writing those in four files is how the `multiresize`
 * omission and the "Grab"-for-every-kind ternary both happened.
 *
 * `kinds` IS THE APPLICABILITY GATE and it is per-toggle rather than global,
 * because the two genuinely differ:
 *   individual — S and R. It relocates the PIVOT (each item about its own centre
 *     instead of the collective one), and grab has NO pivot to relocate: a
 *     translation moves every item by the same vector whatever you measure it
 *     from, so `G I` would be a key that changes nothing. That is the HintBar lie
 *     this table exists to prevent, and it is the same reasoning that withholds
 *     X/Y from rotate one table up.
 *   wholistic — S only. It scales the properties a size gesture ought to carry
 *     (stroke widths, font sizes, corner radii — core/scaling.js), and neither a
 *     grab nor a rotate has a factor for those properties to follow.
 *
 * `soloSuppressed` MARKS A TOGGLE THAT NEEDS A MULTI-SELECTION, and only
 * `individual` is one: "each item about its own centre" and "all items about the
 * collective centre" are THE SAME TRANSFORM when there is one item, because a lone
 * item's own centre IS the collective centre. So on a single selection the key is
 * withheld rather than offered as a no-op. Wholistic is NOT suppressed — scaling a
 * single widget's stroke with it is the feature's most ordinary use.
 *
 * @example MODAL_TOGGLES.individual.key // "I"
 * @example MODAL_TOGGLES.wholistic.kinds // ["scale"]
 * @example MODAL_TOGGLES.individual.soloSuppressed // true
 * @example Object.keys(MODAL_TOGGLES) // ["individual", "wholistic"]
 */
export const MODAL_TOGGLES = Object.freeze({
  individual: Object.freeze({
    key: "I",
    label: "Individual origins",
    mark: "Individual",
    kinds: Object.freeze(["scale", "rotate"]),
    soloSuppressed: true,
  }),
  wholistic: Object.freeze({
    key: "W",
    label: "Wholistic scale",
    mark: "Wholistic",
    kinds: Object.freeze(["scale"]),
    soloSuppressed: false,
  }),
});

/**
 * Every legal modal toggle id, derived from MODAL_TOGGLES so the two cannot
 * disagree — the MODAL_KINDS shape, for the same reason.
 *
 * @example MODAL_TOGGLE_IDS // ["individual", "wholistic"]
 */
export const MODAL_TOGGLE_IDS = Object.freeze(Object.keys(MODAL_TOGGLES));

/**
 * Pure function. Whether a toggle applies to a live modal — the ONE predicate the
 * shortcut gate, the announcement and the modal's own key handler all ask, so a
 * key that cannot be announced also cannot act (the `modalSetAxis` rotate-guard
 * rule, generalised).
 *
 * @param {string} id - a MODAL_TOGGLE_IDS member
 * @param {string} kind - the live modal's kind
 * @param {boolean} multi - whether the selection holds more than one item
 * @returns {boolean}
 *
 * @example modalToggleApplies("wholistic", "scale", false) // true (a lone widget's stroke still scales)
 * @example modalToggleApplies("wholistic", "rotate", true) // false (a turn has no factor)
 * @example modalToggleApplies("individual", "scale", true) // true
 * @example modalToggleApplies("individual", "scale", false) // false (one item's own centre IS the collective centre)
 * @example modalToggleApplies("individual", "grab", true) // false (a translation has no pivot)
 */
export function modalToggleApplies(id, kind, multi) {
  const t = MODAL_TOGGLES[id];
  if (!t) throw new Error(`Unknown modal toggle ${JSON.stringify(id)} — declare it in MODAL_TOGGLES (web/canvas/dragKinds.js). Legal: ${MODAL_TOGGLE_IDS.join(", ")}.`);
  return t.kinds.includes(kind) && (multi || !t.soloSuppressed);
}

/**
 * Every legal `app.modalXform.kind`, derived from MODAL_TRANSFORM_KINDS so the two
 * can never disagree — the DRAG_KINDS shape, for the same reason.
 *
 * @example MODAL_KINDS.includes("rotate") // true
 * @example MODAL_KINDS.length // 3
 */
export const MODAL_KINDS = Object.freeze(Object.keys(MODAL_TRANSFORM_KINDS));

/**
 * THE AXIS-SUPPRESSION TABLE: which stored coordinates each gesture axis owns.
 *
 * WHY IT IS A TABLE AND NOT A COMMENT — the same reason DRAG_KIND_MODIFIERS
 * above it is one. "The x axis touches x and w" used to be spelled as two
 * booleans in `scalePairs` and as a `touch` object in `scaleMemberPairs`, so the
 * fact lived in two places and in neither of them by name. Declaring it once
 * means a fourth constraint source (equation lock, chain-linked aspect ratio,
 * a group scaling its children) reads the mapping instead of restating it.
 *
 * MATCHING IS BY THE COORDINATE'S LAST PATH SEGMENT, which is what lets ONE
 * table cover both record shapes the seam sees: a bbox widget's flat `w` and an
 * arrow's nested `from.y` are both decided by their leaf. `scale` (a group's
 * similarity factor) appears under NO axis, and that is correct rather than an
 * omission — a scalar has no handedness and no axis, which is the same reason
 * groupResizeState clamps it non-negative instead of letting it reflect.
 *
 * `factor` is the same axis in the gesture's OWN parameterization: a modal scale
 * constrained to x is a scale of (factor, 1), which is that axis's factor pinned
 * to its identity. Both suppressions are one projection applied in two spaces —
 * see scalePairs for why the record-space one alone is not sufficient.
 */
export const AXIS_COORDINATES = Object.freeze({
  x: Object.freeze({ leaves: Object.freeze(["x", "w"]), factor: "kx" }),
  y: Object.freeze({ leaves: Object.freeze(["y", "h"]), factor: "ky" }),
});

/** The scale factors a gesture starts from — the identity, one per axis. Pinning
 *  an axis's factor HERE is what "this axis does not scale" means in factor
 *  space, exactly as pinning its coordinates means it in record space. */
const IDENTITY_FACTORS = Object.freeze({ kx: 1, ky: 1 });

/**
 * Pure function. The projection a gesture AXIS CONSTRAINT imposes: every
 * coordinate belonging to the OTHER axis is pinned, so only the constrained
 * axis's coordinates can be written. `null` (unconstrained) is UNCONSTRAINED
 * itself, the protocol's own default.
 *
 * This IS the old `doX`/`doY` pair, and the equality is exact rather than
 * approximate: "suppress this axis's writes" and "hold this axis's coordinates
 * at their start values" produce the same delta, because a coordinate held at
 * its start value is dropped by the same minimal-delta rule that drops one which
 * merely did not move. Expressing it as a projection is what lets it COMPOSE
 * with a per-item constraint the gesture knows nothing about.
 *
 * The pinned key set is read off the record it is handed, so a bbox record and
 * an arrow's endpoint record are both covered with no branch here.
 *
 * @param {("x"|"y"|null)} axis - the axis the gesture is constrained to
 * @returns {function} a `constrain(state, desired) → allowed`
 *
 * @example axisPinning("x")({y: 20, h: 50}, {x: 7, y: 8, w: 300, h: 999}) // {x: 7, y: 20, w: 300, h: 50}
 * @example axisPinning("y")({x: 1, w: 100}, {x: 9, y: 8, w: 300, h: 99}) // {x: 1, y: 8, w: 100, h: 99}
 * @example // a nested leaf obeys the same table — an arrow's y coordinates are its endpoints':
 * @example axisPinning("x")({"from.y": 6}, {"from.x": 5, "from.y": 99}) // {"from.x": 5, "from.y": 6}
 * @example axisPinning(null)({x: 1}, {x: 9}) // {x: 9} (unconstrained is the protocol's own identity)
 */
export function axisPinning(axis) {
  const off = axis === "x" ? "y" : axis === "y" ? "x" : null;
  if (!off) return UNCONSTRAINED;
  const owned = AXIS_COORDINATES[off].leaves;
  return (state, desired) =>
    pinning(Object.keys(desired).filter((k) => owned.includes(k.split(".").pop())))(state, desired);
}

/**
 * Pure function. Which coordinates of `desired` a projection REFUSES — the keys
 * whose allowed value differs from the one asked for. Empty exactly when the
 * gesture was already allowed.
 *
 * WHY A SEAM NEEDS THIS AND `constraintPull` DOES NOT ANSWER IT. `constraintPull`
 * (core/derive.js) measures HOW FAR the projection moved the record, as one
 * number, which is what a resisted-drag readout wants. Two consumers here need
 * WHICH coordinates instead: a coupled gesture has to re-run itself with the
 * refused axis suppressed (see deltaWithoutRefused), and the overlay has to grey
 * an affordance PER DEGREE OF FREEDOM rather than per handle — a corner with only
 * its height refused is not dead, it still resizes width, and drawing it disabled
 * would read as broken.
 *
 * EXACT COMPARISON IS CORRECT HERE, not a tolerance: a projection returns the
 * ASKED-FOR value byte-identically for every coordinate it does not restrict
 * (`pinning` spreads `desired` and overwrites only the pinned keys), so a
 * difference is a decision and never float noise. It is the same exactness
 * `diffState` relies on one step later.
 *
 * @param {function} constrain - a `constrain(state, desired) → allowed`
 * @param {object} start - the resolved start record
 * @param {object} desired - what the gesture asked for
 * @returns {string[]} the refused keys, in `desired`'s own key order
 *
 * @example refusedCoordinates(axisPinning("x"), {y: 5, w: 10}, {x: 1, y: 9, w: 99}) // ["y"]
 * @example refusedCoordinates(axisPinning("x"), {y: 9, w: 10}, {x: 1, y: 9, w: 99}) // [] (the gesture never moved y, so nothing was refused)
 * @example refusedCoordinates(UNCONSTRAINED, {x: 0}, {x: 7}) // []
 */
export function refusedCoordinates(constrain, start, desired) {
  const allowed = constrain(start, desired);
  return Object.keys(desired).filter((key) => allowed[key] !== desired[key]);
}

/**
 * Pure function. A local pointer delta with every GESTURE AXIS that owns a
 * refused coordinate zeroed — the projection applied one space EARLIER, in the
 * gesture's own parameterization.
 *
 * WHY A COUPLED GESTURE NEEDS BOTH SPACES, and this is scalePairs' "one
 * projection, two spaces" note one gesture family over. A resize computes its
 * stored `x` and `w` JOINTLY from the grabbed edges, so pinning one of them in
 * record space alone yields a box neither the user nor the constraint asked for:
 * with `w` held and the WEST edge grabbed, `x` still tracks the cursor, and the
 * widget SLIDES instead of refusing. Suppressing the gesture's own x delta is the
 * same projection expressed where the two coordinates are still one parameter, and
 * it produces the honest answer — the grabbed edge simply does not move.
 *
 * It is the identical trick moveDrag has always used for the Shift axis lock
 * (zero the suppressed component before writing), which
 * tests/universal_constraints_test.js already proves equal to `axisPinning` for
 * the uncoupled case. Record-space pinning still runs afterwards: it is
 * idempotent, so the second application changes nothing when the first sufficed,
 * and it is what catches a coordinate no gesture axis owns.
 *
 * @param {{x: number, y: number}} d - the gesture's pointer delta, local units
 * @param {string[]} refused - refusedCoordinates(...) for this gesture
 * @returns {{x: number, y: number}}
 *
 * @example deltaWithoutRefused({x: 30, y: -12}, ["h"]) // {x: 30, y: 0} (h belongs to the y axis)
 * @example deltaWithoutRefused({x: 30, y: -12}, ["x", "w"]) // {x: 0, y: -12}
 * @example deltaWithoutRefused({x: 30, y: -12}, []) // {x: 30, y: -12}
 */
export function deltaWithoutRefused(d, refused) {
  const dead = (axis) => refused.some((key) => AXIS_COORDINATES[axis].leaves.includes(key.split(".").pop()));
  return { x: dead("x") ? 0 : d.x, y: dead("y") ? 0 : d.y };
}

/**
 * Pure function. The projection that applies `first` and then `second` — the way
 * a gesture-level restriction and a per-ITEM one are combined into the single
 * `constrain` the seam takes.
 *
 * IT IS STILL THE NEAREST ALLOWED POINT *FOR THE PINNINGS THIS FILE COMPOSES*,
 * and that is a claim about `pinning` rather than about composition in general.
 * Two pinnings compose to the pinning of the UNION of their key sets (each holds
 * its own keys at `state`, and neither can move a key the other pinned), and
 * core/derive.pinning's docstring proves the union case nearest by coordinate-wise
 * separability. Composing two ARBITRARY projections is not nearest in general —
 * projecting onto A and then onto B lands on B, not on A∩B — so this helper is
 * deliberately NOT exported and deliberately not offered as a general combinator.
 * The day a non-pinning constraint needs composing, that case needs its own proof.
 *
 * @param {function} first - a `constrain(state, desired) → allowed`
 * @param {function} second - likewise
 * @returns {function} their composition
 *
 * @example // the modal's X-axis lock AND an item whose w is equation-bound:
 * @example bothConstraints(axisPinning("x"), pinning(["w"]))({y: 5, w: 10}, {x: 1, y: 9, w: 99}) // {x: 1, y: 5, w: 10}
 * @example bothConstraints(UNCONSTRAINED, UNCONSTRAINED)({x: 1}, {x: 9}) // {x: 9}
 */
function bothConstraints(first, second) {
  return (state, desired) => second(state, first(state, desired));
}

/**
 * Pure function. Turns a flat geometry delta {key: value, …} (as diffState
 * returns) into the item-scoped [path, value] preview pairs CanvasView commits
 * — the bridge from a MINIMAL delta to app.setPreview's pair list. A key is a
 * DOTTED PATH within the item, so "w" scopes to ["items", id, "w"] and "from.x"
 * to ["items", id, "from", "x"]; an EMPTY delta yields no pairs (nothing changed
 * → nothing to write, so no stored equation is disturbed).
 *
 * NOT EXPORTED, deliberately: geometryPairs is the only door, so a call site
 * cannot reach the writes without passing the projection. See THE ONE
 * GEOMETRY-WRITE SEAM in this file's header.
 *
 * @example // itemGeometryPairs("r", {x: 15, w: 120})
 * @example //   → [[["items","r","x"],15],[["items","r","w"],120]]
 * @example // itemGeometryPairs("a", {"from.x": 5}) → [[["items","a","from","x"],5]]
 */
function itemGeometryPairs(itemId, delta) {
  return Object.entries(delta).map(([k, v]) => [["items", itemId, ...k.split(".")], v]);
}

/**
 * Pure function. THE ONE GEOMETRY-WRITE SEAM: project a DESIRED stored geometry
 * onto what the constraint allows, keep only the coordinates that actually
 * changed, and scope those to the item. Every drag in the app ends here.
 *
 * `start` is the RESOLVED start pose (what the coordinate SHOWED at grab time),
 * `desired` is what the gesture asks for, and the keys compared are `desired`'s
 * own — a gesture that does not mention a coordinate cannot write it, which is
 * how a group resize touches {scale, x, y} and nothing else with no key list to
 * maintain.
 *
 * Args:
 *   itemId    (string): the item being written
 *   start     (object): resolved start values, keyed by dotted path within the item
 *   desired   (object): the gesture's requested values, same keys
 *   constrain (function): THE HANDLE-CONSTRAINT PROTOCOL projection
 *     (core/derive.js), defaulted to UNCONSTRAINED so an unrestricted gesture
 *     needs to say nothing — the same defaulting nodeModifierPoints does for
 *     the yellow squares.
 *
 * Returns:
 *   [path, value][]: the preview pairs app.setPreview takes
 *
 * @example // an east-only stretch writes w ALONE, so equations on x/y/h survive:
 * @example geometryPairs("r", {x: 10, y: 20, w: 100, h: 50}, {x: 10, y: 20, w: 120, h: 50}) // [[["items","r","w"],120]]
 * @example // the SAME drag constrained to the x axis writes w and refuses h:
 * @example geometryPairs("r", {y: 20, w: 100, h: 50}, {y: 99, w: 120, h: 999}, axisPinning("x")) // [[["items","r","w"],120]]
 * @example // a gesture that changed nothing writes nothing:
 * @example geometryPairs("r", {x: 10}, {x: 10}) // []
 */
export function geometryPairs(itemId, start, desired, constrain = UNCONSTRAINED) {
  const allowed = constrain(start, desired);
  return itemGeometryPairs(itemId, diffState(start, allowed, Object.keys(desired)));
}

/**
 * Pure function. The path/value preview pairs that translate one member by a
 * world delta (dx, dy) — the ONE translation rule shared by DRAG-ALL body drags,
 * the modal grab, arrow-key nudge AND the clone home (paste + Duplicate). A
 * moveBy widget (arrow) translates only its FREE numeric coordinates via its
 * plugin hook (bound endpoints stay anchored); a bbox/transform widget writes
 * plain numeric x/y, but ONLY on the axis that actually moved (diffState) — a
 * pure-horizontal drag (dy === 0) writes x alone and leaves any equation stored
 * on y untouched. Grabbing an axis that DID move replaces its equation with the
 * new literal (the established body-drag rule).
 *
 * ONLY A FREE NUMBER IS TRANSLATED, on both branches. A drag never sees anything
 * else (CanvasView resolves `n.state.x ?? 0` before building the member), but the
 * CLONE home hands over RAW stored state, where a coordinate can be an EQUATION
 * STRING or simply ABSENT — an arrow keeps its position in from/to and has no x
 * at all. Arithmetic on those answers `"circle.x + 10" + 16` (a concatenation)
 * and `undefined + 16` (NaN), so both are left exactly as they are and emit no
 * pair. This is the same `typeof v === "number"` gate core/endpoints.js
 * endpointMoveBy already applies on the other branch, which is what makes the two
 * one rule rather than two.
 *
 * `constrain` is THE HANDLE-CONSTRAINT PROTOCOL projection (geometryPairs), and
 * it is where a PER-MEMBER restriction enters. The gesture-level axis lock does
 * not need it — moveDrag zeroes the suppressed component before calling, which
 * is the identical projection applied one space earlier (translation is a
 * bijection between delta space and position space, so pinning the delta and
 * pinning the coordinate agree exactly; tests/universal_constraints_test.js pins
 * that equality). A per-member restriction cannot be expressed that way, because
 * a drag-all shares ONE delta across members that may be locked differently.
 *
 * @example // dragged on both axes → both written:
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 3) // [[["items","r","x"], 15], [["items","r","y"], 23]]
 * @example // pure-horizontal drag → only x (y OMITTED, its equation survives):
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 0) // [[["items","r","x"], 15]]
 * @example // the SAME two-axis drag with the y coordinate constrained away:
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 3, axisPinning("x")) // [[["items","r","x"], 15]]
 * @example // a widget with no x/y gains none — no phantom transform:
 * @example translationPairs({itemId: "a", plugin: {}, rawItem: {}}, 16, 16) // []
 */
export function translationPairs(member, dx, dy, constrain = UNCONSTRAINED) {
  const { start, desired } = translationRecord(member, dx, dy);
  return geometryPairs(member.itemId, start, desired, constrain);
}

/**
 * Pure function. WHAT A TRANSLATION ASKS FOR: the `{start, desired}` coordinate
 * records a move of (dx, dy) hands to the seam, before any projection. Both
 * branches of the rule above live here — a moveBy widget's plugin hook, and a
 * bbox widget's plain x/y — so there is one statement of "which coordinates a
 * drag mentions and what it wants them to be".
 *
 * TWO CALLERS, WHICH IS WHY IT IS SEPARATE, and it is exactly the split
 * `resizeStoredState` already documents for the resize family: the LIVE gesture
 * (translationPairs, immediately above) and the PROBE that asks what a candidate
 * drag WOULD write — web/CanvasView.svelte's `moveAffordance`, which runs a trial
 * translation through `refusedCoordinates` to grey a body drag per degree of
 * freedom (R6-28 / todo #240). Rebuilding the record at the probe would be a
 * mirror of this function and would rot against it the day a widget family
 * changes which coordinates a move mentions — ledger C-8, the same reasoning that
 * kept the resize affordance off a hand-written edge→coordinate table.
 *
 * @param {object} member - a translate member ({itemId, plugin, rawItem, startX, startY})
 * @param {number} dx - world x travel
 * @param {number} dy - world y travel
 * @returns {{start: object, desired: object}} keyed by dotted path within the item
 *
 * @example translationRecord({plugin: {}, startX: 10, startY: 20}, 5, 3) // {start: {x: 10, y: 20}, desired: {x: 15, y: 23}}
 * @example // an EQUATION coordinate is asked for VERBATIM, so diffState drops it and the binding survives:
 * @example translationRecord({plugin: {}, startX: "= a.x", startY: 20}, 5, 3) // {start: {x: "= a.x", y: 20}, desired: {x: "= a.x", y: 23}}
 * @example // a moveBy widget's record is its plugin's own write set, keyed by dotted path:
 * @example translationRecord({plugin: {moveBy: () => [[["from", "x"], 7]]}, rawItem: {from: {x: 2}}}, 5, 0) // {start: {"from.x": 2}, desired: {"from.x": 7}}
 */
export function translationRecord(member, dx, dy) {
  if (member.plugin.moveBy) {
    const start = {}, desired = {};
    for (const [path, value] of member.plugin.moveBy(member.rawItem, dx, dy)) {
      const key = path.join(".");
      start[key] = getPath(member.rawItem, path);
      desired[key] = value;
    }
    return { start, desired };
  }
  const start = { x: member.startX, y: member.startY };
  return {
    start,
    desired: {
      x: typeof start.x === "number" ? start.x + dx : start.x,
      y: typeof start.y === "number" ? start.y + dy : start.y,
    },
  };
}

/**
 * Pure function. The grabbed point and fixed (anchor) point of a handle resize,
 * in the box's local frame — ONE computation shared by the resize math
 * (resizedBox) and the uniform diagonal guide, so they never disagree.
 *
 * gx/gy is the grabbed corner (on an axis with no grabbed edge it holds the far
 * coordinate, unused there); fx/fy is the point the resize is anchored to — the
 * opposite corner/edge, or the box CENTER when `symmetric` (Cmd).
 *
 * @example resizeAnchors([0, 0, 100, 50], {east: true, south: true}, {}) // {gx: 100, gy: 50, fx: 0, fy: 0, cx: 50, cy: 25, xActive: true, yActive: true}
 * @example resizeAnchors([0, 0, 100, 50], {east: true}, {symmetric: true}).fx // 50
 */
export function resizeAnchors([x0, y0, x1, y1], edges, mods) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    gx: edges.west ? x0 : x1,
    gy: edges.north ? y0 : y1,
    fx: mods.symmetric ? cx : edges.west ? x1 : x0,
    fy: mods.symmetric ? cy : edges.north ? y1 : y0,
    cx, cy,
    xActive: !!(edges.east || edges.west),
    yActive: !!(edges.north || edges.south),
  };
}

/**
 * Pure function. The resized box for a handle drag with modifiers, in the box's
 * local frame (`base` = the box at the last modifier rebase). Also serves the
 * MULTI-resize collective box (which is world-axis-aligned, so its "local" frame
 * IS world — same math).
 *
 * Modifier semantics (manifest "Drag/resize modifiers — CONFIRMED mapping"):
 *   uniform (Shift)  — ONE scale factor K for both dimensions. A corner rides
 *     the diagonal through the anchor (the pointer projects onto it); an edge
 *     handle drives K from its own axis, and the passive axis scales about its
 *     center — the only symmetric-neutral choice for an axis with no grabbed
 *     edge (Figma's Shift+edge precedent).
 *   symmetric (Cmd)  — the anchor is the box CENTER, so both sides move
 *     (PowerPoint's Ctrl-resize precedent). Composes with uniform: the corner
 *     then rides the FULL diagonal, scaling about the center.
 *
 * SIZES INVERT — dragging a handle past the opposite edge FLIPS the widget, the
 * PowerPoint/Figma behaviour, and it costs nothing: the box simply keeps going and
 * comes out the other side with a negative extent, which is what a reflection IS
 * (core/geometry.js "THE FLIP"). Under `uniform` a negative K is a point reflection
 * through the anchor, so a corner dragged past it flips BOTH axes at once — again
 * the established behaviour.
 *
 * CORRECTING THE RECORD (this docstring previously said the opposite). It claimed
 * "Sizes never invert (MIN_SIZE = 0, the mathematical bound): K clamps at 0", and
 * the code clamped in two places to match. Zero is NOT a mathematical bound on a
 * dimension — a negative dimension is a well-defined reflection — so that was a
 * DESIGN DECISION wearing the costume of a law, which is the one thing a comment
 * must never do (a reader cannot argue with a law, so the clamp survived unexamined
 * through the pass that deleted the other arbitrary limits). The `MIN_SIZE = 0`
 * lineage is real but narrower than it read: the manifest records only that Claude
 * invented MIN_SIZE = 8 and the user replaced it with 0. Zero was the right value
 * for "the smallest size you can drag TO"; it was never a proof that you cannot
 * drag THROUGH.
 *
 * Args:
 *   base  (number[4]): [x0, y0, x1, y1] box at the last modifier rebase
 *   d     ({x, y}):    local pointer movement since that rebase
 *   edges (object):    {west, east, north, south} — edges the handle moves
 *   mods  (object):    {uniform, symmetric}
 *
 * Returns:
 *   number[4]: the new [x0, y0, x1, y1]
 *
 * @example resizedBox([0,0,100,50], {x:20,y:0}, {east:true}, {}) // [0, 0, 120, 50]
 * @example resizedBox([0,0,100,50], {x:20,y:0}, {east:true}, {symmetric:true}) // [-20, 0, 120, 50]
 * @example resizedBox([0,0,100,50], {x:100,y:0}, {east:true,south:true}, {uniform:true}) // [0, 0, 180, 90]
 * @example // dragging the east edge PAST the fixed west edge inverts the box — a flip:
 * @example resizedBox([0,0,100,50], {x:-200,y:0}, {east:true}, {}) // [0, 0, -100, 50]
 * @example // exactly ON the anchor is the degenerate zero-width box, not a flip:
 * @example resizedBox([0,0,100,50], {x:-100,y:0}, {east:true}, {}) // [0, 0, 0, 50]
 * @example // uniform corner past the anchor: K < 0 point-reflects, flipping BOTH axes:
 * @example resizedBox([0,0,100,50], {x:-200,y:-100}, {east:true,south:true}, {uniform:true}) // [0, 0, -100, -50]
 */
export function resizedBox(base, d, edges, mods) {
  const [bx0, by0, bx1, by1] = base;
  const { gx, gy, fx, fy, cx, cy, xActive, yActive } = resizeAnchors(base, edges, mods);

  if (mods.uniform) {
    // K is SIGNED — see the flip note in the docstring. A negative K reflects the
    // box through the anchor rather than clamping onto it. AN AXIS WITH NO GRABBED
    // EDGE CONTRIBUTES ZERO TO THE DRIVE VECTOR, which is how "an edge handle
    // drives K from its own axis" is said — the projection then reads that axis's
    // factor alone, with no branch. (The three-way conditional this replaced said
    // the same thing by enumerating cases.)
    const K = uniformFactorFor(
      { x: gx + d.x - fx, y: gy + d.y - fy },
      { x: xActive ? gx - fx : 0, y: yActive ? gy - fy : 0 },
    );
    if (K !== null) {
      const ax = xActive ? fx : cx, ay = yActive ? fy : cy;
      return [ax + K * (bx0 - ax), ay + K * (by0 - ay), ax + K * (bx1 - ax), ay + K * (by1 - ay)];
    }
    // Zero extent along the drive: no aspect to preserve — fall through.
  }

  let x0 = bx0, y0 = by0, x1 = bx1, y1 = by1;
  if (edges.east) x1 += d.x;
  if (edges.west) x0 += d.x;
  if (edges.south) y1 += d.y;
  if (edges.north) y0 += d.y;
  if (mods.symmetric) {
    // The opposite edge mirrors the moved one about the center.
    if (edges.east) x0 = 2 * cx - x1;
    if (edges.west) x1 = 2 * cx - x0;
    if (edges.south) y0 = 2 * cy - y1;
    if (edges.north) y1 = 2 * cy - y0;
  }
  // NO inversion clamp: an inverted [x0, y0, x1, y1] is a FLIPPED box and is
  // returned as-is (the pair of `x1 < x0` collapses that used to live here is what
  // the docstring's "CORRECTING THE RECORD" paragraph is about). The grabbed edge
  // keeps tracking the cursor straight through the anchor, so the negative extent
  // the caller stores is anchored exactly where the fixed edge was.
  return [x0, y0, x1, y1];
}

/**
 * Pure function. The stored {x, y, w, h} a resize BOX means, in the item's own
 * frame — the last step of every single-item handle resize, and the ONE mapping
 * from "where the eight handles put the box" to "what gets written".
 *
 * TWO CALLERS, WHICH IS WHY IT IS HERE RATHER THAN INLINE IN CanvasView: the live
 * resize, and the PROBE that asks what a candidate box WOULD write — used both by
 * the equation lock's gesture-space projection (deltaWithoutRefused) and by the
 * overlay, which greys a handle per DEGREE OF FREEDOM by running this on a
 * one-unit trial drag of that handle and seeing which coordinates come back
 * refused. Deriving the affordance from the real geometry is the ledger's
 * prescription (C-8): a hand-written "the west edge moves x and w" table would be
 * a mirror of this function and would rot against it.
 *
 * `rotated` picks between the two mappings, and it is a PARAMETER rather than a
 * test on `world.rotation` because the caller already knows: a rotated item takes
 * the centre-pivot back-solve (stateXYForCenterPivotWorld — the item keeps its
 * `self.anchors.center` rotation anchor, so the stored x/y must be the ones that
 * reproduce this world under a RE-CENTERED pivot), an unrotated one takes the
 * plain local-origin shift, and at rotation 0 the two agree.
 *
 * Args:
 *   box     (number[4]): [x0, y0, x1, y1] in the item's LOCAL frame
 *   world   (object):    the item's start world transform (pivot-folded)
 *   rotated (boolean):   whether the item carries a non-zero rotation
 *   start   ({x, y}):    the item's resolved stored position at grab time
 *
 * Returns:
 *   {x, y, w, h}: the stored geometry that box means
 *
 * @example // an unrotated item at (10, 20): the box's local origin shift is the state shift
 * @example resizeStoredState([0, 0, 120, 50], {x: 10, y: 20, rotation: 0, scale: 1}, false, {x: 10, y: 20}) // {x: 10, y: 20, w: 120, h: 50}
 * @example // dragging the WEST edge out by 30 moves x and grows w by the same amount:
 * @example resizeStoredState([-30, 0, 100, 50], {x: 10, y: 20, rotation: 0, scale: 1}, false, {x: 10, y: 20}) // {x: -20, y: 20, w: 130, h: 50}
 */
export function resizeStoredState(box, world, rotated, start) {
  const w = box[2] - box[0], h = box[3] - box[1];
  const topLeftWorld = T.apply(world, box[0], box[1]); // intended local(0,0) in world
  if (rotated) {
    const pinnedWorld = { x: topLeftWorld.x, y: topLeftWorld.y, rotation: world.rotation, scale: world.scale };
    const { x, y } = stateXYForCenterPivotWorld(pinnedWorld, w, h);
    return { x, y, w, h };
  }
  const o = T.apply(world, 0, 0);
  return { x: start.x + (topLeftWorld.x - o.x), y: start.y + (topLeftWorld.y - o.y), w, h };
}

/**
 * Pure function. The EXACT new stored {x, y, w, h} for a bbox member whose whole
 * shape is scaled by PER-AXIS world factors (kx, ky) about world point (ax, ay).
 * ROTATION-AWARE — THE shared core of both the S-modal scale (kx == ky about the
 * collective center) and multi-resize-by-handles (per-axis about the collective
 * box's fixed anchor).
 *
 * The math works in the member's FOLDED world frame (`member.startWorld`, which
 * already includes the rotation pivot), never the stored base-frame x/y (those
 * differ for rotated items — the old approximation bug): scale the box's LOCAL
 * w/h by (kx, ky), move its WORLD CENTER about (ax, ay) per axis, rebuild the
 * target world transform (same rotation & scale, new size, new center), then
 * back-solve the stored x/y with stateXYForCenterPivotWorld — the exact inverse
 * of worldTransform's self-center pivot, so the committed item paints the scaled
 * pose byte-for-byte and keeps its clean center-pivot equation.
 *
 * For an UNROTATED member this is the identity back-solve, so new w = kx·w, new
 * x = ax + kx·(x − ax) — the plain proportional scale. For a rotated member,
 * kx/ky scale its LOCAL width/height by the world-axis factors (the no-shear,
 * PPT-consistent reading — a true world-axis non-uniform scale would shear a
 * rotated box, which the similarity-transform model forbids). When kx == ky
 * (uniform / Shift) the result IS exact under any rotation.
 *
 * @example // a rotation-0, scale-1 box at (10,20) size 100x50 scaled x2 about (0,0):
 * @example scaledBoxAboutPoint({startWorld: {x:10, y:20, rotation:0, scale:1}, startW:100, startH:50}, 2, 2, 0, 0) // {x: 20, y: 40, w: 200, h: 100}
 */
export function scaledBoxAboutPoint(member, kx, ky, ax, ay) {
  const W = member.startWorld, w = member.startW, h = member.startH;
  const kw = kx * w, kh = ky * h;
  const oldCenter = T.apply(W, w / 2, h / 2); // world center (pivot-folded)
  const ncx = ax + kx * (oldCenter.x - ax);
  const ncy = ay + ky * (oldCenter.y - ay);
  // Target world transform: same rotation & scale, new size, center at (ncx,ncy).
  // Its world TRANSLATION (local (0,0)) = center − R·s·(kw/2, kh/2).
  const cs = Math.cos(W.rotation), sn = Math.sin(W.rotation), s = W.scale;
  const target = {
    x: ncx - s * (cs * (kw / 2) - sn * (kh / 2)),
    y: ncy - s * (sn * (kw / 2) + cs * (kh / 2)),
    rotation: W.rotation,
    scale: W.scale,
  };
  const { x, y } = stateXYForCenterPivotWorld(target, kw, kh);
  return { x, y, w: kw, h: kh };
}

/**
 * Pure function. Preview pairs that scale one member by PER-AXIS world factors
 * (kx, ky) about world point (ax, ay). A bbox/transform widget scales its w/h
 * AND repositions its x/y — EXACTLY, including rotated / non-unit-scale members
 * (scaledBoxAboutPoint). A moveBy widget (arrow) scales each FREE numeric
 * endpoint about (ax, ay) per axis; equation-bound endpoints stay put. THE ONE
 * scale rule shared by the S-modal and multi-resize-by-handles.
 *
 * `constrain` REPLACES the old `touch` ({x, y} booleans) parameter, which said
 * "these axes may be written" in a vocabulary only this file spoke. It is the
 * protocol's projection (geometryPairs), so a constrained modal passes
 * axisPinning(axis) and a per-item lock passes its own — and the axis case comes
 * out byte-identical, because a coordinate held at its start value is dropped by
 * the same minimal-delta rule that dropped an untouched one.
 *
 * @example // a rect member {itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50} scaled x2 about (0,0):
 * @example scaleMemberPairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50}, 2, 2, 0, 0) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","w"],200],[["items","r","h"],100]]
 * @example // the same member scaled in x only: y/h are pinned, so only x/w are written
 * @example scaleMemberPairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startX:10, startY:20, startW:100, startH:50}, 2, 1, 0, 0, axisPinning("x")) // [[["items","r","x"],20],[["items","r","w"],200]]
 */
export function scaleMemberPairs(member, kx, ky, ax, ay, constrain = UNCONSTRAINED) {
  // AN ARMATURE SCALES BY ITS SIMILARITY, NOT BY ITS BOX (see armatureScaledState).
  // Checked FIRST because it is the most specific branch and because getting it
  // wrong is SILENT: a group whose w/h grew while its members stood still shows a
  // bigger outline around unchanged contents, with no error anywhere.
  if (member.plugin.capabilities?.armature) {
    // AN EQUATION-BOUND `scale` PINS THE WHOLE GESTURE, not just its own key. On a
    // bbox widget x/y are driven independently of w/h, so a held w still lets the
    // item move; here x/y are pure COMPENSATION for the scale (the back-solve that
    // keeps the grabbed anchor fixed), so with the factor held there is nothing to
    // compensate for. K = 1 makes that fall out of the arithmetic rather than
    // needing a second branch, and diffState then drops all three keys.
    const held = typeof (member.rawItem ?? {}).scale !== "number";
    // AN EXPLICIT AXIS CONSTRAINT REFUSES THE GESTURE ENTIRELY, and this is the two
    // allowed sets COMPOSED rather than a special case: the armature's own set is
    // {kx === ky}, a uniform scale moves it on BOTH axes, so a projection that pins
    // either axis leaves the IDENTITY as the only common point. `S X` is a refusal
    // of the other axis, and answering it with a uniform scale would grow exactly
    // the dimension the user just excluded. Asked of the PROJECTION, not of the
    // gesture, so a per-item lock the gesture knows nothing about counts the same.
    // (A handle drag is NOT this: dragging one edge asks for a width, it does not
    // forbid a height — which is why groupResizeState answers an edge grab with a
    // uniform scale and has always been right to.)
    const free = constrain({ x: 0, y: 0 }, { x: 1, y: 1 });
    // FACTOR SPACE: the drive vector is the armature's own box, the target is the
    // box the gesture asked for. A ZERO-EXTENT armature (null) has no shape to
    // weight the two factors by, so it too lands on the identity — the same answer
    // for the same reason, that the similarity has nothing to express.
    const projected = uniformFactorFor(
      { x: kx * member.startW, y: ky * member.startH },
      { x: member.startW, y: member.startH },
    );
    const refused = held || free.x !== 1 || free.y !== 1 || projected === null;
    const K = refused ? 1 : projected;
    const g = { w: member.startW, h: member.startH, scale: member.startWorld.scale };
    const desired = armatureScaledState(g, member.startWorld, K, scaledOrigin(member.startWorld, K, ax, ay));
    const start = { scale: g.scale, x: member.startX, y: member.startY };
    return geometryPairs(member.itemId, start, desired, constrain);
  }
  if (member.plugin.moveBy) {
    const s = member.rawItem ?? {};
    const start = {}, desired = {};
    for (const end of ["from", "to"])
      for (const coord of ["x", "y"]) {
        const v = s[end]?.[coord];
        const k = coord === "x" ? kx : ky;
        const a = coord === "x" ? ax : ay;
        start[`${end}.${coord}`] = v;
        // NOT A FREE NUMBER ⇒ PINNED, by construction: an equation-bound endpoint
        // keeps its binding, which is the same "only a free number is
        // transformed" rule translationPairs states on its own branch.
        desired[`${end}.${coord}`] = typeof v === "number" ? a + k * (v - a) : v;
      }
    return geometryPairs(member.itemId, start, desired, constrain);
  }
  const rawItem = member.rawItem ?? {};
  const nb = scaledBoxAboutPoint(member, kx, ky, ax, ay);
  const start = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
  // A w/h the item does not STORE as a number is likewise pinned rather than
  // omitted from a key list — same rule, said once. (An item whose w is an
  // equation keeps it: scaling drives the equation's inputs, not its result.)
  const desired = {
    x: nb.x,
    y: nb.y,
    w: typeof rawItem.w === "number" ? nb.w : start.w,
    h: typeof rawItem.h === "number" ? nb.h : start.h,
  };
  return geometryPairs(member.itemId, start, desired, constrain);
}

/**
 * Pure function. Preview pairs that ROTATE one member by `angle` radians about
 * world point `c` — the R-modal's per-member write, and the exact sibling of
 * scalePairs. A bbox/transform widget adds `angle` to its own `rotation` AND
 * orbits its position about `c`; a moveBy widget (arrow) orbits each FREE
 * numeric endpoint, since it has no `rotation` of its own to turn.
 *
 * NO AXIS CONSTRAINT, and that is a fact about the plane rather than a missing
 * feature: Blender's `R X` picks one of three rotation axes, and in 2D there is
 * exactly one (the screen normal), so an X/Y constraint on rotate would have
 * nothing to choose between. Numeric entry does apply — an angle is a single
 * number — and it is entered in DEGREES, the unit every angle row in the app
 * shows (core/properties.js ROW_KINDS "angle"), converted at the one call site.
 *
 * AN ABSENT `rotation` IS WRITTEN, unlike an absent `w` in scaleMemberPairs, and
 * the asymmetry is real rather than an oversight: a widget with no `w` has no
 * width, so writing one would invent a property it does not have — but a widget
 * with no stored `rotation` is at rotation 0 (worldTransform reads `?? 0`), so
 * writing the turn is the only way to honour the gesture. An EQUATION-valued
 * rotation is still pinned, exactly as an equation-valued w is.
 *
 * Like scaledBoxAboutPoint it works in the member's FOLDED world frame and
 * back-solves the stored x/y with stateXYForCenterPivotWorld, so a rotated or
 * group-parented member lands exactly and keeps its clean center-pivot equation.
 *
 * @example // a 100x50 box at (10,20) turned a quarter turn about the origin:
 * @example rotationPairs({itemId: "r", plugin: {}, rawItem: {rotation: 0}, startWorld: {x: 10, y: 20, rotation: 0, scale: 1}, startW: 100, startH: 50, startRotation: 0}, Math.PI / 2, {x: 0, y: 0}).length // 3
 */
export function rotationPairs(member, angle, c, constrain = UNCONSTRAINED) {
  if (member.plugin.moveBy) {
    const s = member.rawItem ?? {};
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const start = {}, desired = {};
    for (const end of ["from", "to"]) {
      const px = s[end]?.x, py = s[end]?.y;
      const free = typeof px === "number" && typeof py === "number";
      // BOTH coordinates or NEITHER: a rotation mixes x and y, so turning a point
      // whose other half is anchored to an equation would move it off the circle.
      start[`${end}.x`] = px;
      start[`${end}.y`] = py;
      desired[`${end}.x`] = free ? c.x + cos * (px - c.x) - sin * (py - c.y) : px;
      desired[`${end}.y`] = free ? c.y + sin * (px - c.x) + cos * (py - c.y) : py;
    }
    return geometryPairs(member.itemId, start, desired, constrain);
  }
  const W = member.startWorld, w = member.startW, h = member.startH;
  const oldCenter = T.apply(W, w / 2, h / 2); // world center (pivot-folded)
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const k = W.scale;
  const ncx = c.x + cos * (oldCenter.x - c.x) - sin * (oldCenter.y - c.y);
  const ncy = c.y + sin * (oldCenter.x - c.x) + cos * (oldCenter.y - c.y);
  // THE STORED x/y FOR A BOX WHOSE WORLD CENTRE IS (ncx, ncy). This is
  // stateXYForCenterPivotWorld — the same documented inverse resize and scale use
  // — WITH ITS ROTATION TERMS CANCELLED, which they always do here:
  //   target.x = ncx − k·(cosθ·w/2 − sinθ·h/2)     (the world translation)
  //   x        = target.x − k·w/2 + k·(cosθ·w/2 − sinθ·h/2)   (the inverse)
  //            = ncx − k·w/2
  // i.e. under a CENTRE pivot the world centre is (x + k·w/2, y + k·h/2) whatever
  // the rotation, which is the whole content of that inverse for this case.
  //
  // IT IS COMPUTED THIS WAY FOR EXACTNESS, NOT BREVITY, and the difference is
  // load-bearing. Going through the two-step composition adds and subtracts the
  // same trigonometric term in two different associations, so it lands ~1e-13 off
  // — and `diffState` compares EXACTLY. A pure rotation about an item's OWN centre
  // moves nothing, so it must write `rotation` alone; through the composition it
  // also wrote an x that differed in the last bits, and that write would silently
  // replace a stored equation on x with a literal. Measured agreement with
  // stateXYForCenterPivotWorld over rotations, scales and box shapes: 2.3e-13.
  const xy = { x: ncx - (k * w) / 2, y: ncy - (k * h) / 2 };
  const rawItem = member.rawItem ?? {};
  const held = rawItem.rotation !== undefined && typeof rawItem.rotation !== "number";
  const start = { rotation: member.startRotation, x: member.startX, y: member.startY };
  const desired = {
    rotation: held ? start.rotation : member.startRotation + angle,
    x: xy.x,
    y: xy.y,
  };
  return geometryPairs(member.itemId, start, desired, constrain);
}

/**
 * Pure function. Preview pairs that scale one member by `factor` about world
 * center `c`, optionally constrained to one `axis` (the S modal's scale). Thin
 * adapter over scaleMemberPairs.
 *
 * THE AXIS CONSTRAINT IS ONE PROJECTION APPLIED IN TWO SPACES, and it has to be,
 * because the gesture and the stored record are different spaces that only
 * coincide when the member is unrotated:
 *   FACTOR SPACE — the constrained axis's factor is pinned to its IDENTITY (1),
 *     so the gesture asks for (factor, 1) rather than (factor, factor).
 *   RECORD SPACE — that axis's stored coordinates are pinned to their start
 *     values (axisPinning), so nothing on it is written.
 * On an unrotated member the second is implied by the first (the coordinates
 * simply do not change, and diffState drops them). On a ROTATED member it is
 * not: scaling the local width alone still moves the stored y, because the box's
 * origin swings, so without the record-space pin an x-constrained scale would
 * write a y. Both pins are `pinning` — the same function, once per space — which
 * is what makes "one mechanism" a fact about the code rather than a slogan.
 * This reproduces the old doX/doY pair exactly; the A/B grid in
 * tests/universal_constraints_test.js is the evidence.
 *
 * `constrain` IS THE THIRD SPACE-INDEPENDENT RESTRICTION — a per-ITEM projection
 * the gesture knows nothing about (R6-28's equation lock is the first), composed
 * with the axis pin rather than replacing it. It is a parameter here, and not
 * something the caller could pass through the `axis` argument, because the axis
 * lock is a fact about the GESTURE while an item lock is a fact about the
 * DOCUMENT, and a modal scale of a multi-selection has one of the former and one
 * of the latter PER MEMBER.
 *
 * @example scalePairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50}, 2, {x:0,y:0}) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","w"],200],[["items","r","h"],100]]
 * @example // constrained to x: the height and the y position are both refused
 * @example scalePairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startX:10, startY:20, startW:100, startH:50}, 2, {x:0,y:0}, "x") // [[["items","r","x"],20],[["items","r","w"],200]]
 * @example // the same unconstrained scale with the item's `w` equation-locked: w is held, so only x/y/h are written
 * @example scalePairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startX:10, startY:20, startW:100, startH:50}, 2, {x:0,y:0}, null, pinning(["w"])) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","h"],100]]
 */
export function scalePairs(member, factor, c, axis = null, constrain = UNCONSTRAINED) {
  const off = axis === "x" ? "y" : axis === "y" ? "x" : null;
  const k = pinning(off ? [AXIS_COORDINATES[off].factor] : [])(IDENTITY_FACTORS, { kx: factor, ky: factor });
  return scaleMemberPairs(member, k.kx, k.ky, c.x, c.y, bothConstraints(axisPinning(axis), constrain));
}

/**
 * Pure function. THE PIVOT A MEMBER TURNS OR SCALES ABOUT — the collective centre,
 * or the member's OWN centre under `individual` (Blender's I / individual-origins).
 *
 * WHY IT IS ONE FUNCTION AND NOT A BRANCH AT EACH CALL SITE: the S and R modals ask
 * the identical question, and answering it twice is how two gestures that must agree
 * come to disagree. It is also the whole of what `individual` MEANS — the toggle
 * changes the pivot and nothing else, so the entire feature is this one substitution
 * and the existing per-member math is reused untouched.
 *
 * THE MEMBER'S OWN CENTRE IS ITS FOLDED WORLD CENTRE, not its stored x/y: those
 * differ for a rotated, scaled or group-parented member, and using the stored pair
 * would put the pivot off the item — the same distinction scaledBoxAboutPoint
 * documents for its own math. A member with no box (an arrow, which carries no
 * startWorld box) falls back to the collective centre, because a widget whose
 * geometry is two free endpoints has no single centre to spin about; that is a
 * STATED limit, not a silent one — its endpoints still scale about the shared pivot
 * exactly as they do today.
 *
 * @param {object} member - a transform member
 * @param {{x: number, y: number}} collective - the selection's collective centre
 * @param {boolean} individual - whether the toggle is on
 * @returns {{x: number, y: number}} the pivot for this member
 *
 * @example // toggle off: everything turns about the shared centre
 * @example memberPivot({startWorld: {x: 0, y: 0, rotation: 0, scale: 1}, startW: 100, startH: 50}, {x: 500, y: 500}, false) // {x: 500, y: 500}
 * @example // toggle on: the member's own world centre (origin + half its box)
 * @example memberPivot({startWorld: {x: 0, y: 0, rotation: 0, scale: 1}, startW: 100, startH: 50}, {x: 500, y: 500}, true) // {x: 50, y: 25}
 * @example // a member with no box has no centre of its own — the shared pivot stands
 * @example memberPivot({plugin: {moveBy: () => []}}, {x: 500, y: 500}, true) // {x: 500, y: 500}
 */
export function memberPivot(member, collective, individual) {
  if (!individual || !member.startWorld || typeof member.startW !== "number" || typeof member.startH !== "number")
    return collective;
  return T.apply(member.startWorld, member.startW / 2, member.startH / 2);
}

/**
 * Pure function. THE WHOLISTIC WRITE for one member: the item-scoped preview pairs
 * that carry a scale of `factor` into the properties a size gesture ought to take
 * with it — stroke widths, font sizes, corner radii, blur radii, shadow offsets.
 * core/scaling.js owns WHICH properties and by how much; this is the adapter that
 * turns its answer into the pairs `app.setPreview` takes.
 *
 * IT IS ADDITIVE TO THE GEOMETRY, NEVER A REPLACEMENT FOR IT. The caller emits
 * `scalePairs(...)` AND these, in that order, so x/y/w/h come from the one geometry
 * seam exactly as they always have and this adds the rest. That is why the geometry
 * keys cannot collide: core/scaling.js's SHARED_SCALING deliberately holds no entry
 * for them (its header says why), so `wholisticPairs` never answers for x/y/w/h.
 *
 * A KEY WHOSE VALUE DOES NOT CHANGE EMITS NO PAIR — enforced inside
 * `wholisticPairs`, which is the minimal-delta law `diffState` applies to the
 * geometry half. At factor 1 this is [] exactly, so a zero-travel gesture with the
 * toggle ON writes nothing and disturbs no stored equation.
 *
 * NO `constrain` PARAMETER, and that is a claim rather than an omission. The
 * handle-constraint protocol projects a desired GEOMETRY onto what a widget's
 * modifier points allow; a stroke width is not geometry and no constraint in the app
 * speaks about one. An equation-valued property is still protected — `scaledValue`
 * passes non-numbers through untouched, which is the same "only a free number is
 * transformed" rule this file applies on every other branch.
 *
 * @param {object} member - a transform member ({itemId, plugin, rawItem})
 * @param {number} factor - the gesture's scale factor
 * @returns {Array<[string[], *]>} preview pairs
 *
 * @example // a stroked rect scaled x2 carries its stroke and corners with it:
 * @example wholisticMemberPairs({itemId: "r", plugin: {inspector: [{key: "strokeWidth", kind: "number"}]}, rawItem: {strokeWidth: 3}}, 2) // [[["items","r","strokeWidth"], 6]]
 * @example // the identity writes nothing:
 * @example wholisticMemberPairs({itemId: "r", plugin: {inspector: [{key: "strokeWidth", kind: "number"}]}, rawItem: {strokeWidth: 3}}, 1) // []
 * @example // a dotted key reads the NESTED value and scopes into the item as a geometry path does:
 * @example wholisticMemberPairs({itemId: "r", plugin: {inspector: [{key: "shadow.blur", kind: "number"}]}, rawItem: {shadow: {blur: 4}}}, 2) // [[["items","r","shadow","blur"], 8]]
 */
export function wholisticMemberPairs(member, factor) {
  return wholisticPairs(member.rawItem ?? {}, member.plugin ?? {}, factor)
    .map(([key, value]) => [["items", member.itemId, ...key.split(".")], value]);
}

/**
 * Pure function. THE UNIFORM FACTOR: the single scale K that best takes the
 * DRIVE vector `u` to the requested `target`, i.e. the scalar projection
 * (target·u)/(u·u). `null` when `u` has no length — there is then no direction
 * to measure a factor along, and each caller says what it does about that.
 *
 * IT IS A PROJECTION, NOT A COMPROMISE — the same "nearest allowed" law the
 * handle-constraint protocol enforces everywhere else (core/derive.js), applied
 * to the curve kx == ky instead of to an axis-aligned subspace. Minimising
 * |target − K·u|² over K gives exactly this quotient, so "the nearest uniform
 * scaling to what the gesture asked for" and "the projection onto the diagonal"
 * are one statement, not two that happen to agree.
 *
 * TWO CALLERS, ONE FUNCTION, AND THEY ARE THE SAME OBJECT SEEN IN TWO SPACES:
 *   - `resizedBox`'s `uniform` branch, in POSITION space: `u` is the vector from
 *     the fixed anchor to the grabbed corner, `target` is where the pointer put
 *     it. An axis with no grabbed edge contributes ZERO to `u`, which is how
 *     "an edge handle drives K from its own axis" is expressed — not as a branch.
 *   - `scaleMemberPairs`'s armature branch, in FACTOR space: `u` is the box
 *     (w, h) and `target` is (kx·w, ky·h), which expands to
 *     K = (kx·w² + ky·h²) / (w² + h²) — the box-weighted mean of the two
 *     requested factors. Substituting u = (w, h) into the quotient IS that
 *     formula; it is not a second derivation.
 * So a group dragged by its own handles and one caught in a multi-resize agree
 * by construction rather than by two authors reaching the same answer.
 *
 * AN ALREADY-UNIFORM REQUEST COMES BACK EXACT AT THE IDENTITY: target = u gives
 * (u·u)/(u·u) = 1 exactly, which matters because a gesture that moved nothing
 * must write nothing — a K one ulp off 1 would stamp a literal over a stored
 * `scale` equation. (A non-identity uniform request can land one ulp away; that
 * is invisible and cannot disturb an equation, because the coordinate is being
 * written either way.)
 *
 * @param {{x: number, y: number}} target - where the drive vector should end up
 * @param {{x: number, y: number}} u - the drive vector, from the anchor
 * @returns {number|null}
 *
 * @example uniformFactorFor({x: 200, y: 100}, {x: 100, y: 50}) // 2 (target is exactly 2u)
 * @example // an EDGE grab: the passive axis contributes nothing, so K is its own axis's factor
 * @example uniformFactorFor({x: 180, y: 999}, {x: 100, y: 0}) // 1.8
 * @example // FACTOR space — kx=3, ky=1 on a 200x100 box leans toward the wide axis:
 * @example uniformFactorFor({x: 3 * 200, y: 1 * 100}, {x: 200, y: 100}) // 2.6
 * @example uniformFactorFor({x: 5, y: 5}, {x: 0, y: 0}) // null (no drive direction)
 */
export function uniformFactorFor(target, u) {
  const len2 = u.x * u.x + u.y * u.y;
  return len2 > 0 ? (target.x * u.x + target.y * u.y) / len2 : null;
}

/**
 * Pure function. Where a transform's world ORIGIN (its local 0,0) lands when the
 * whole scene it sits in is scaled by K about world point (ax, ay). The one line
 * that turns "scale everything about this point" into the target an armature
 * back-solves its stored x/y from.
 *
 * WRITTEN AS origin + (1 − K)·(anchor − origin), NOT anchor + K·(origin − anchor),
 * because the two are algebraically equal and NOT equal in floating point at the
 * identity: the second form leaves a + (b − a), which need not be b, so a gesture
 * with K === 1 would write an x that differs in the last bits — and diffState
 * compares EXACTLY, so that write would silently replace a stored equation with a
 * literal. This is the same hazard rotationPairs documents at its own back-solve.
 *
 * @param {{x: number, y: number}} world - the transform whose origin is being moved
 * @param {number} k - the uniform scale factor
 * @param {number} ax - the world x the scale is about
 * @param {number} ay - the world y the scale is about
 * @returns {{x: number, y: number}}
 *
 * @example scaledOrigin({x: 100, y: 100}, 2, 0, 0) // {x: 200, y: 200}
 * @example scaledOrigin({x: 100, y: 100}, 2, 50, 50) // {x: 150, y: 150} (the anchor stays put)
 * @example scaledOrigin({x: 100, y: 100}, 1, 7, 9) // {x: 100, y: 100} (identity is EXACT)
 */
export function scaledOrigin(world, k, ax, ay) {
  return { x: world.x + (1 - k) * (ax - world.x), y: world.y + (1 - k) * (ay - world.y) };
}

/**
 * Pure function. THE ARMATURE SCALE: the stored {scale, x, y} that puts an
 * armature's world origin at `worldOrigin` with its similarity scaled by
 * `signedK`. Shared by BOTH ways an armature can be scaled — its own resize
 * handles (groupResizeState) and any gesture that scales it alongside other
 * items (scaleMemberPairs' armature branch) — so the two cannot disagree.
 *
 * AN ARMATURE SCALES BY ITS SIMILARITY, NEVER BY ITS w/h. Its members follow its
 * {x, y, rotation, scale} through core/derive.applyGroupParenting, and
 * `groupInfluence` is a pure delta-from-bind over exactly those four; w/h never
 * enters a transform. So growing w/h enlarges the outline and moves NOTHING
 * inside it — visible as contents that slide around inside a box that grew
 * without them.
 *
 * `signedK` IS CLAMPED NON-NEGATIVE HERE, AND ONLY HERE — a TECHNICAL bound with
 * a derivation, not an arbitrary limit. A single item resizes by its BOX, so a
 * negative extent there is a reflection (core/geometry.js "THE FLIP"). An
 * armature resizes by its similarity's SCALAR `scale`, and a scalar has no
 * handedness: negating it is a π-rotation, not a mirror, so it would silently
 * rotate the subtree instead of flipping it. Worse, `world.scale` is the
 * MAGNITUDE every length consumer multiplies by (blur sigma, stroke widths,
 * material half-extents — render_gpu/skia/paint_skia.js), and a negative one
 * puts negative lengths into the painter. To flip an armature's CONTENTS, flip
 * its members (flip-h/flip-v recurse into a group for exactly this reason).
 *
 * @param {{w: number, h: number, scale: number}} gState - the armature's start box + scale
 * @param {object} gWorld - its start world transform (rotation-pivoted)
 * @param {number} signedK - the requested uniform factor (may be negative)
 * @param {{x: number, y: number}} worldOrigin - where its local (0,0) must land
 * @returns {{scale: number, x: number, y: number}}
 *
 * @example // an unrotated 200x100 armature at (100,100) scale 1, doubled about its own top-left:
 * @example armatureScaledState({w: 200, h: 100, scale: 1}, {x: 100, y: 100, rotation: 0, scale: 1}, 2, {x: 100, y: 100}) // {scale: 2, x: 100, y: 100}
 * @example // the same armature doubled about the world origin: its own origin doubles away too
 * @example armatureScaledState({w: 200, h: 100, scale: 1}, {x: 100, y: 100, rotation: 0, scale: 1}, 2, {x: 200, y: 200}) // {scale: 2, x: 200, y: 200}
 * @example // a negative factor is a reflection a scalar cannot express — clamped to 0:
 * @example armatureScaledState({w: 200, h: 100, scale: 1}, {x: 0, y: 0, rotation: 0, scale: 1}, -2, {x: 0, y: 0}).scale // 0
 */
export function armatureScaledState(gState, gWorld, signedK, worldOrigin) {
  const newScale = (gState.scale ?? 1) * Math.max(0, signedK);
  const target = { x: worldOrigin.x, y: worldOrigin.y, rotation: gWorld.rotation, scale: newScale };
  const { x, y } = stateXYForCenterPivotWorld(target, gState.w, gState.h);
  return { scale: newScale, x, y };
}

/**
 * Pure function. The group's own {scale, x, y} for a handle resize (manifest
 * 15.7 GROUP RESIZE). A GROUP is an armature: its members follow its
 * {x, y, rotation, scale} SIMILARITY through core/derive.applyGroupParenting —
 * NOT its w/h (worldTransform never reads w/h into the transform; groupInfluence
 * is a pure {x,y,rotation,scale} delta-from-bind). So resizing a group must
 * drive the group's `scale` (which members inherit), never its w/h — writing
 * w/h alone is a no-op on members (the rough-draft bug this fixes).
 *
 * WHY UNIFORM-ONLY (the design fork, manifest-sanctioned "resize handles drive
 * group scale about the grab's opposite anchor"): the influence is a single
 * uniform `scale`. A per-axis (non-uniform) box resize has NO representation in
 * the similarity model — it would SHEAR members, which the transform contract
 * forbids (core/transform.js: "similarity ∘ similarity = similarity, never
 * shear"). So a group ALWAYS resizes uniformly; `resizedBox` is called with
 * `uniform` forced, so corner handles ride the diagonal and edge handles drive
 * one uniform K from their axis — the SAME resizedBox math single-item and
 * multi-resize already use, just with the modifier pinned on.
 *
 * The mapping (verified numerically — scratchpad group_resize_via_box/rot):
 *   K            = new local box width / old (uniform: equal on both axes)
 *   worldOrigin  = the resized box's local (0,0) mapped through the group's
 *                  START world transform — where the group's origin now sits
 *   scale        = startScale · K
 *   x, y         = back-solved (stateXYForCenterPivotWorld) so worldTransform
 *                  reproduces {worldOrigin, rotation, newScale} EXACTLY, keeping
 *                  the group's clean center-pivot equation (the SAME rotated-
 *                  resize inverse single-item resize uses at rotation != 0; at
 *                  rotation 0 it is the identity, so x/y = worldOrigin).
 * w/h are UNCHANGED — the visual hull is scale·w, so growing `scale` grows the
 * hull; touching w/h too would double-count K. Members scale about the grabbed
 * handle's FIXED opposite corner (resizeAnchors' fx/fy), which `resizedBox`
 * pins by construction — zero per-member writes, fully keyframable.
 *
 * Args:
 *   gState  — the group's start state ({x, y, w, h, rotation, scale, ...}).
 *   gWorld  — worldTransform(gState) (the rotation-pivoted start world).
 *   edges   — {west, east, north, south} the grabbed handle moves.
 *   mods    — {uniform, symmetric}; `uniform` is forced true internally, so
 *             only `symmetric` (Cmd — scale about the group CENTER) varies.
 *   dLocal  — pointer movement since the last modifier rebase, in the group's
 *             LOCAL frame (the same delta resizeDrag feeds resizedBox).
 *
 * Returns {scale, x, y} — the group's new own transform (w/h stay put).
 *
 * @example // BR corner grab, unrotated 200x100 group at (100,100) scale 1, drag +200/+100 local → scale 2 about the fixed top-left (100,100):
 * @example groupResizeState({x:100,y:100,w:200,h:100,rotation:0,scale:1}, {x:100,y:100,rotation:0,scale:1}, {east:true,south:true}, {}, {x:200,y:100}) // {scale: 2, x: 100, y: 100}
 */
export function groupResizeState(gState, gWorld, edges, mods, dLocal) {
  const box = resizedBox([0, 0, gState.w, gState.h], dLocal, edges, { ...mods, uniform: true });
  const signedK = gState.w > 1e-9 ? (box[2] - box[0]) / gState.w
    : gState.h > 1e-9 ? (box[3] - box[1]) / gState.h : 1;
  // The non-negative clamp, the scale multiply and the x/y back-solve all live in
  // armatureScaledState — this function's only remaining job is the HANDLE half
  // (which box the drag produced, and hence K and where local (0,0) lands). The
  // S-modal / multi-resize half of the same feature reaches the identical math
  // through scaleMemberPairs, so the two cannot drift.
  return armatureScaledState(gState, gWorld, signedK, T.apply(gWorld, box[0], box[1]));
}

/**
 * Pure function. The world-space [x0, y0, x1, y1] box for a CROSSHAIR
 * CREATION drag (manifest 13.2 "CREATION-DRAG MODIFIERS"), point-anchored at
 * the drag's start (sx, sy) — as opposed to resizedBox's box-anchored resize,
 * which grabs a HANDLE on an existing box with a real opposite edge/corner.
 * A creation drag has no such box: any quadrant is a valid drag direction, so
 * this reads the SAME modifier semantics resizedBox documents (manifest
 * "Drag/resize modifiers — CONFIRMED mapping") but re-derives them for a
 * degenerate (zero-extent) base, where resizedBox's own uniform branch can't
 * find a driving axis to lock aspect against (verified: gx/gy/fx/fy all
 * collapse to the same start point, so its (gx−fx, gy−fy) drive vector is
 * zero — this is the reason a separate function exists rather than a call
 * into resizedBox with a collapsed base box).
 *
 *   uniform (Shift)   — BOTH dimensions get the SAME magnitude (the larger of
 *     |dx|, |dy| drives it), each keeping its own sign — a square/1:1-aspect
 *     box growing from the start point along the cursor's general direction
 *     (resize's "corner rides the diagonal through the anchor" reading, with
 *     the start point AS the anchor).
 *   symmetric (Cmd)   — the start point becomes the box CENTER: both edges on
 *     each axis move together, magnitude |dx|/|dy| each way (PowerPoint's
 *     Ctrl-resize precedent, identical interpretation to resizedBox's
 *     symmetric branch — there the anchor is forced to the box center; here
 *     the anchor (start point) simply IS the center already).
 * Composes exactly like resize: uniform+symmetric locks aspect AND centers.
 *
 * Args:
 *   sx, sy (number): the drag's start point (world).
 *   wx, wy (number): the live pointer position (world).
 *   mods   (object): {uniform, symmetric} — same shape as resizedBox's mods.
 *
 * Returns:
 *   number[4]: [x0, y0, x1, y1]
 *
 * @example creationRect(100, 100, 300, 50, {}) // [100, 50, 300, 100]
 * @example creationRect(100, 100, 50, 40, {}) // [50, 40, 100, 100]
 * @example creationRect(100, 100, 300, 130, { uniform: true }) // [100, 100, 300, 300]
 * @example creationRect(100, 100, 300, 150, { symmetric: true }) // [-100, 50, 300, 150]
 */
export function creationRect(sx, sy, wx, wy, mods) {
  let dx = wx - sx, dy = wy - sy;
  if (mods.uniform) {
    const k = Math.max(Math.abs(dx), Math.abs(dy));
    // Math.sign(0) is 0, which would zero out a still axis under uniform —
    // fall back to +1 (an arbitrary but harmless tie-break: a zero-delta axis
    // has no direction of its own to preserve).
    dx = (Math.sign(dx) || 1) * k;
    dy = (Math.sign(dy) || 1) * k;
  }
  if (mods.symmetric) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    return [sx - ax, sy - ay, sx + ax, sy + ay];
  }
  return [Math.min(sx, sx + dx), Math.min(sy, sy + dy), Math.max(sx, sx + dx), Math.max(sy, sy + dy)];
}

/**
 * Pure function. The {x, y} endpoint for a CROSSHAIR CREATION drag of an
 * ENDPOINT-kind widget (the arrow family: `placement === "endpoints"` —
 * manifest 13.2), point-anchored at the drag's start exactly like
 * creationRect, but for a single free point rather than a box (no aspect to
 * preserve, so Shift is a plain AXIS LOCK — the same interpretation
 * moveDrag's shift-drag already uses for a moveBy widget with no bbox probe
 * features, snapping the point onto the horizontal/vertical through the
 * start) instead of resize's uniform-scale reading, which needs two
 * dimensions to relate.
 *
 *   uniform (Shift)   — axis-locks the live point to the horizontal or
 *     vertical THROUGH THE START (bigger |dx| vs |dy| decides — same
 *     dominant-axis rule as core/snap.js axisLock's first-frame case; no
 *     hysteresis here since the caller re-derives from raw pointer state on
 *     every move rather than tracking a "locked so far" axis).
 *   symmetric (Cmd)   — the start point becomes the segment's MIDPOINT: the
 *     other end mirrors the live point through it, so the shape grows both
 *     directions (PowerPoint's Ctrl-resize precedent, same interpretation as
 *     creationRect's symmetric branch).
 * Composes exactly like creationRect: uniform+symmetric axis-locks AND mirrors.
 *
 * Returns: {from: {x, y}, to: {x, y}} — the placed widget's two endpoints.
 *
 * @example creationEndpoint(100, 100, 300, 130, {}) // {from: {x: 100, y: 100}, to: {x: 300, y: 130}}
 * @example creationEndpoint(100, 100, 300, 130, { uniform: true }) // {from: {x: 100, y: 100}, to: {x: 300, y: 100}}
 * @example creationEndpoint(100, 100, 300, 130, { symmetric: true }) // {from: {x: -100, y: 70}, to: {x: 300, y: 130}}
 */
export function creationEndpoint(sx, sy, wx, wy, mods) {
  let dx = wx - sx, dy = wy - sy;
  if (mods.uniform) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
  }
  const to = { x: sx + dx, y: sy + dy };
  const from = mods.symmetric ? { x: sx - dx, y: sy - dy } : { x: sx, y: sy };
  return { from, to };
}

/**
 * The create-handler id (web/widget_handlers.js CREATE_HANDLERS) whose placement
 * runs the SEGMENT grammar. Named here rather than compared inline because
 * CanvasView used to test `plugin.placement === "endpoints"` in three separate
 * places — the arm-time preview seed, the live drag, and (by omission) the drag
 * kind it announced, which is how the announcement came to disagree with the
 * other two.
 *
 * NOT IMPORTED FROM web/widget_handlers.js, deliberately: this module is DOM-free
 * and node-testable (see the file header), and that registry reaches into overlay
 * components. Two modules must therefore AGREE about a string they cannot share,
 * which is the case the ledger says to GATE rather than trust — see
 * tests/placement_grammar_test.js, which resolves the id through `handlerFor` and
 * fails if the create phase stops declaring it.
 */
export const SEGMENT_CREATE_HANDLER = "endpoints";

/**
 * Pure function. Which drag kind a single-gesture crosshair placement runs under,
 * from the create handler the widget resolved to. THE one place the segment
 * grammar is recognised.
 *
 * Takes the RESOLVED handler id, not the raw `plugin.placement` field, so the
 * create phase's own fallback ("placement" absent → "bbox") is honoured where it
 * is declared instead of being restated here as a `?? "bbox"`.
 *
 * @param {string} createHandlerId - handlerFor("create", plugin).id
 * @returns {("place"|"placesegment")}
 *
 * @example placementDragKind("endpoints") // "placesegment"
 * @example placementDragKind("bbox") // "place"
 * @example placementDragKind("bbox_then_asset") // "place" (it places a box, then asks for a source)
 */
export function placementDragKind(createHandlerId) {
  return createHandlerId === SEGMENT_CREATE_HANDLER ? "placesegment" : "place";
}

/**
 * THE SINGLE-GESTURE PLACEMENT GRAMMARS, keyed by the drag kind each runs under.
 * A grammar owns the whole of what makes its placement different: the geometry a
 * live drag previews and commits, and — DERIVED from DRAG_KIND_MODIFIERS above, so
 * there is one source and not two — the held modifiers it reads.
 *
 * `gesture` RETURNS THE SHAPE `ctx.gesture` ALREADY CARRIES: exactly one of `rect`
 * ({x, y, w, h} world) or `endpoint` ({from, to} world), which is the union
 * web/widget_handlers.js's create handlers already destructure. So a grammar plugs
 * into the existing create contract rather than introducing a parallel one, and
 * CanvasView stashes whichever key came back with no branch of its own.
 *
 * THE MODIFIER ID AND THE PAYLOAD FLAG ARE DIFFERENT NAMES ON PURPOSE, and this is
 * the polygon precedent, not a mismatch: the mods record is `{uniform, symmetric}`
 * — the Shift/Cmd flags, worded for the grammar that named them first — while the
 * modifier ID is what the HintBar ANNOUNCES. `placesegment` reads `mods.uniform`
 * (Shift) and announces `axisLock`, exactly as web/polygonDraw.js's vertex step
 * reads `p.mods.uniform` and declares `modifiers: ["axisLock"]`. Renaming the flag
 * would touch every creation hook for no gain; announcing the flag's name would
 * put "Uniform scale" on a key that axis-locks, which is the defect this table
 * exists to close.
 *
 * @example Object.keys(PLACEMENT_GRAMMARS) // ["place", "placesegment"]
 * @example PLACEMENT_GRAMMARS.placesegment.modifiers // ["axisLock", "symmetric"]
 * @example PLACEMENT_GRAMMARS.place.gesture(100, 100, 300, 150, {}) // {rect: {x: 100, y: 100, w: 200, h: 50}}
 * @example // Shift on the box grammar squares the rect; on the segment grammar it axis-locks:
 * @example PLACEMENT_GRAMMARS.place.gesture(0, 0, 300, 100, {uniform: true}) // {rect: {x: 0, y: 0, w: 300, h: 300}}
 * @example PLACEMENT_GRAMMARS.placesegment.gesture(0, 0, 300, 100, {uniform: true}) // {endpoint: {from: {x: 0, y: 0}, to: {x: 300, y: 0}}}
 */
export const PLACEMENT_GRAMMARS = Object.freeze({
  place: Object.freeze({
    modifiers: DRAG_KIND_MODIFIERS.place,
    gesture: (sx, sy, wx, wy, mods) => {
      const [x0, y0, x1, y1] = creationRect(sx, sy, wx, wy, mods);
      return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    },
  }),
  placesegment: Object.freeze({
    modifiers: DRAG_KIND_MODIFIERS.placesegment,
    gesture: (sx, sy, wx, wy, mods) => ({ endpoint: creationEndpoint(sx, sy, wx, wy, mods) }),
  }),
});

/**
 * The drag kinds that are a single-gesture crosshair placement — what CanvasView's
 * pointer-move and pointer-up route on, so adding a grammar routes itself.
 *
 * @example PLACEMENT_DRAG_KINDS.includes("placesegment") // true
 * @example PLACEMENT_DRAG_KINDS.length // 2
 */
export const PLACEMENT_DRAG_KINDS = Object.freeze(Object.keys(PLACEMENT_GRAMMARS));
