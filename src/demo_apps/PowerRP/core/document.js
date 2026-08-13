/**
 * The PowerRP document model.
 *
 * A document is ONLY:
 *   { meta: {name, slideW, slideH, script}, slides: [{id, name, transition, delta}] }
 *
 * `meta.script` is THE PROJECT SCRIPT — one per-document JavaScript function
 * library, compiled in the equation jail, whose exports every property equation
 * can call (core/project_script.js). It is a first-class meta field defaulted to
 * "", never absent: repairedDocument fills it in on any document written before it
 * existed, so no consumer needs an undefined branch.
 *
 * `slide.transition` = {type, seconds, curve, sound} describes how the
 * presenter animates INTO this slide from its predecessor (core/transitions.js;
 * a first-class SELECTABLE thing — the navigator's between-rows slice). It
 * SUPERSEDES the old per-slide `duration` (lead ruling, Round 12); legacy
 * documents migrate LOUDLY at load (withDurationMigrated).
 *
 * There is no separate items table — EVERYTHING is deltas (slide 0's delta
 * creates the initial items). Slide N's full state = fold of deltas 0..N over
 * the empty state. An item appearing in multiple slides IS the "symlink":
 * same UUID, same object, until a delta deletes it. Slides have permanent
 * UUIDs; slide NUMBERS are display-only (indices shift on insert).
 *
 * State shape produced by folding:
 *   { items: { <itemId>: {type, x, y, z, ...plugin state} } }
 *
 * Documents are treated as IMMUTABLE — every edit returns a new document.
 * That makes the undo snapshot log and the per-document fold cache trivial
 * (WeakMap keyed on document identity).
 *
 * There is no meta.fps: presentations are always UNCAPPED (round 11 ruling —
 * frame caps don't exist; one frame per rAF tick). Legacy docs that still
 * carry meta.fps get it stripped loudly by repairedDocument().
 */

import { blendApplied, copied, copiedDeep, deepEqual, getPath, isTree, setPath, deletePath, leaves } from "./deltas.js";
import { defaultTransition, withDurationMigrated, resolveTransition } from "./transitions.js";
import { interpKeyFor, EXP_TWEEN_MODE } from "./interp_modes.js";
import { ease } from "./interpolators.js";
import {
  withBindingsMigrated, withItemRefsRemapped, declaredListLeaves, isEquationValue, evaluateState,
  sourceIsSimulated,
} from "./expressions.js";
// THE FRAME DOMAIN'S "am I simulated" predicate (documentIsSimulated reads it — see
// the strided-shard landmine in its docblock). core/exec_frame.js imports only
// nodeflow, simulation_history and report, NONE of which import this file, so this
// edge closes no cycle; that is also why its step budget is declared there rather
// than imported from core/exec_flow.js, which DOES import this file.
import { frameNodeIsSimulated } from "./exec_frame.js";
import { withRichTextMigrated } from "./richtext.js";
import { headModeSplit } from "./endpoints.js";
import { withPaletteRampMigrated, rampMigrationReports } from "./ramp_migration.js";
// GLOBAL VARIABLE KINDS (core/var_kinds.js) — meta.varKinds is normalized here for
// meta.script's exact reasons; that module owns the rules and this file only
// reports what it dropped.
import { repairedVarKinds } from "./var_kinds.js";
// The plugin ROW INDEX — the one place that knows how to look a declared row up by
// key. Read here for the `nullable` aspect (see missingDefaults); imported rather
// than re-derived, since a second `inspector`-to-map walk is the mirror this
// codebase keeps paying for. No cycle: that module imports only slide_reorder,
// deltas and multiselect, none of which import this file.
import { rowsByKey } from "./item_properties_clipboard.js";
import { bundleDefaults, linearEndpointsToAngle } from "./properties.js";
// SIMULATED STATE (manifest R7-9): the camera carries the max simulation timestep,
// and this module is where THE camera literal lives. The key/default are declared in
// simulation_history.js because core/expressions.js reads them and cannot import this
// file — the document→expressions edge is one-way.
import { CAMERA_MAX_TIMESTEP_KEY, CAMERA_MAX_TIMESTEP_DEFAULT } from "./simulation_history.js";
import { worldTransform } from "./derive.js";
import * as T from "./transform.js";

/** Query (reads crypto). Random 8-char id — short but collision-safe at presentation scale. */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.floor(Math.random() * 2 ** 48).toString(36);
}

// Default slide dimensions when no meta is supplied — the historical camera
// literal (1280×720, 16:9). Named so the ONE place that defines it can't drift.
const DEFAULT_SLIDE_W = 1280;
const DEFAULT_SLIDE_H = 720;

/** The camera's frame leaves — the four the user ruled interpolate exponentially
 *  (WORKSTREAM BG). Exported so the camera plugin's coupling hook and the tests
 *  name the same set rather than repeating a literal list.
 *
 *  SAME FOUR NAMES AS core/registry.js FRAME_KEYS, deliberately NOT imported: that
 *  module imports this one (registry → document), so taking the constant from it
 *  would close a cycle. The lists are also asking different questions — FRAME_KEYS
 *  asks "does a plugin have a position and a size", this asks "which of THE
 *  camera's leaves the zoom ruling covers" — and they would not necessarily move
 *  together. A handback to one constant is available if the cycle is ever broken. */
export const CAMERA_EXP_TWEEN_KEYS = ["x", "y", "w", "h"];

/** The camera leaf holding THE ZOOM COUPLING'S SWITCH (WORKSTREAM BI), and its
 *  born-with value. Declared HERE rather than in plugins/camera.js — which is
 *  where the law and every reader of it live — for one mechanical reason: that
 *  module already imports `defaultCameraState` from this one, so the constant has
 *  to travel plugin-ward or the cycle closes. plugins/camera.js re-exports both
 *  under its own names and owns the SEMANTICS (naturalZoomOn, and the header
 *  recording what was measured); this pair is just the spelling, kept beside the
 *  interp-companion list it sits next to in the literal below. */
export const CAMERA_NATURAL_ZOOM_KEY = "naturalZoom";
export const CAMERA_NATURAL_ZOOM_DEFAULT = true;

/**
 * Pure function. THE canonical initial state of THE camera item — the ONE
 * source of truth reconciling the three literals that used to disagree
 * (newDocument, withCameraEnsured, and the camera plugin's `defaults`; the
 * plugin ones lacked name/active and hardcoded 1280×720 — cruft audit). The
 * camera is a bbox covering the slide rect; `meta` (default {slideW, slideH})
 * sizes it. `active:true` so it frames from slide 0; white background per the
 * user spec. `name` lets the picker/inspector label it.
 *
 * ── WHY THE FRAME LEAVES DECLARE "Exp Tween" (WORKSTREAM BG) ─────────────────
 * User ruling, 2026-08-02 night, verbatim: "its scale should interpolate
 * exponentially… that should be the default for height and width for the camera
 * and well and X and Y too… because when a camera zooms in, just like in
 * Mendelbrot, it's gotta look natural."
 *
 * So x/y/w/h are BORN with an explicit `~interp` companion rather than getting
 * the default through core/interp_modes.defaultModeFor. That seam sees two VALUES
 * and a KEY and has no widget type in hand, and `x`/`w` are universal keys — a
 * shape-driven default there would make EVERY numeric leaf of EVERY widget
 * exponential, which is not what was ruled and would silently rewrite every deck.
 * Writing the companion into the camera's own state is what scopes the ruling to
 * the camera, and it is an ordinary keyframable leaf, so an author retains the
 * dropdown on every one of the four rows.
 *
 * NOTE the four leaves are the camera's own SCALE story only. The natural zoom
 * the ruling is asking for also needs its PAN coupled to its scale, and that is
 * not expressible per-leaf — it lives in plugins/camera.js `interpolateState`
 * (read its header for the measurement).
 *
 * ── AND WHY THE CAMERA IS BORN WITH `naturalZoom: true` (WORKSTREAM BI) ──────
 * User ruling, 2026-08-02 night, verbatim: "If we have to make a tool for it to
 * make sure that several settings are set simultaneously, so be it, by default it
 * will be on for camera."
 *
 * That coupling shipped (BG) with no control at all, so the four dropdowns above
 * were the only account of a law they do not fully describe. `naturalZoom` is the
 * switch that makes it a stated setting — see plugins/camera.js's NATURAL ZOOM
 * header for what was measured to lie (x/y) and what never did (w, and h at a
 * fixed aspect).
 *
 * WRITTEN EXPLICITLY, not left to the ABSENT-IS-ON reading. Both render the same
 * frame — plugins/camera.naturalZoomOn treats a missing key as ON precisely so
 * that every pre-BI document is byte-identical — but a fresh camera that stores
 * the value shows the author a checkbox reflecting real state rather than an
 * inferred one, and it keeps `withMissingDefaultsFilled` from reporting a repair
 * on every load (the pre-camera-lane regression the rendering bundle below fixed
 * the same way).
 *
 * A PLAIN NON-KEYFRAMED PROPERTY IN V1, and that is a decision rather than an
 * omission. Nothing STOPS it keyframing — it is an ordinary delta leaf and the
 * boolean row grows the usual diamonds — but the coupling is read off the TARGET
 * state, so a per-slide value already means exactly "this transition is coupled
 * or it is not", which is the only question a keyframe on it could ask. There is
 * no in-between value for a tween to find, and `naturalZoom` is a statement about
 * HOW a transition moves rather than about what any slide LOOKS like, so nothing
 * here mints a keyframe and no default mode is declared for it.
 *
 * @example defaultCameraState().w // 1280
 * @example defaultCameraState()["w~interp"] // "expTween" (the camera zooms geometrically)
 * @example defaultCameraState()["x~interp"] // "expTween"
 * @example defaultCameraState().naturalZoom // true (the ruling's "by default it will be on for camera")
 * @example defaultCameraState({slideW: 800, slideH: 600}).w // 800
 */
export function defaultCameraState(meta = {}) {
  return {
    type: "camera", name: "Camera",
    x: 0, y: 0, w: meta.slideW ?? DEFAULT_SLIDE_W, h: meta.slideH ?? DEFAULT_SLIDE_H,
    // THE FRAME LEAVES INTERPOLATE GEOMETRICALLY — see the docblock. Spelled with
    // interpKeyFor rather than as literal "x~interp" strings so the companion-key
    // grammar has exactly one speller (core/interp_modes.js owns the sigil).
    ...Object.fromEntries(CAMERA_EXP_TWEEN_KEYS.map((k) => [interpKeyFor(k), EXP_TWEEN_MODE])),
    // THE COUPLING'S SWITCH, born ON per the ruling — see the docblock for why it
    // is written rather than inferred, and why it does not keyframe in v1.
    [CAMERA_NATURAL_ZOOM_KEY]: CAMERA_NATURAL_ZOOM_DEFAULT,
    // THE MAX SIMULATION TIMESTEP (SIMULATED STATE — user: "We can set a max timestep
    // in the camera, under some settings, which can be none or .1 seconds etc to
    // prevent extreme lag spikes from driving it crazy"). Written rather than
    // inferred, for the same reason the switch above is: an author reading the row
    // sees real state. `null` in the row means NO clamp; the semantics and the
    // measured-vs-dictated rule live in core/simulation_history.js.
    [CAMERA_MAX_TIMESTEP_KEY]: CAMERA_MAX_TIMESTEP_DEFAULT,
    z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff",
    // Rendering bundle (AA / retina / dither) is DECLARED on the camera plugin;
    // spread its defaults so a fresh camera is born complete — otherwise
    // missingDefaults flags them every load and the repair pipeline re-injects
    // them (the pre-camera-lane regression this fixes). Spread (not literals) so
    // any future rendering prop is included automatically, never drifting.
    ...bundleDefaults("rendering"),
  };
}

/**
 * Pure function (modulo uuid randomness). A fresh single-slide document.
 *
 * @example // newDocument().slides.length === 1; newDocument().meta.slideW === 1280
 */
export function newDocument() {
  // Every document is born with THE camera (one per document, manifest spec):
  // a bbox item covering the meta slide rect, tweenable like any other item.
  const cameraId = uuid();
  // `script` is THE PROJECT SCRIPT (core/project_script.js): one JavaScript
  // function library per document, reusable from every property equation. It is
  // born EMPTY and FIRST-CLASS rather than absent-until-written, so there is no
  // undefined-vs-"" ambiguity anywhere downstream — the equation evaluator, the
  // Monaco modal and the save format all read one always-present string.
  const meta = { name: "Untitled", slideW: DEFAULT_SLIDE_W, slideH: DEFAULT_SLIDE_H, script: "" };
  return {
    // No meta.fps: presentations are always UNCAPPED (round 11 ruling —
    // frame caps don't exist; one frame per rAF tick at any display rate).
    meta,
    slides: [{
      id: uuid(),
      name: "Slide 1",
      // Slide 0 has no predecessor, so its transition is inert, but every slide
      // carries the default tween for a uniform shape (the navigator addresses
      // the slice above each row; slide 0's is simply never animated).
      transition: defaultTransition("tween"),
      delta: {
        items: { [cameraId]: defaultCameraState(meta) },
      },
    }],
  };
}

// ── Folding (with per-document cache) ────────────────────────────────────────

const foldCache = new WeakMap(); // doc → Array<state at slide i, fully applied>

/**
 * Query (memoized on document identity). Full state at slide `index` with all
 * deltas 0..index applied at alpha 1.
 */
export function slideState(doc, index) {
  let states = foldCache.get(doc);
  if (!states) foldCache.set(doc, (states = []));
  if (states.length > index) return states[index];
  let cur = states.length ? states[states.length - 1] : {};
  for (let i = states.length; i <= index; i++) {
    // A disabled slide's delta is skipped entirely — "slides are just deltas,
    // so toggling a slide off toggles its delta out of the fold".
    cur = doc.slides[i].enabled === false ? cur : blendApplied(cur, doc.slides[i].delta, 1);
    states.push(cur);
  }
  return states[index];
}

/**
 * Pure function. The EASED per-item alpha for a `delay`-carrying item mid
 * transition — the fold half of THE `delay` UNIVERSAL PROPERTY (manifest). `u`
 * is the transition's LINEAR progress, `T` its total seconds, `d` the item's
 * destination-slide `delay` (seconds), `easeFn` the transition's own curve
 * (already resolved — this function does not know about curve NAMES).
 *
 * The item's tween occupies the window [d, T] of the transition: it is pinned
 * to its start value while `u·T < d`, then re-parameterizes the REMAINING
 * span (T − d) into a fresh 0..1 and eases THAT. d ≥ T shrinks the window to
 * nothing — the limit is a STEP exactly at the transition's end (u = 1), not an
 * error and not floored. d ≤ 0 (including the absent-is-0 default) must
 * reproduce `easeFn(u)` exactly — the whole-transition window is the identity
 * case this property must stay invisible under.
 *
 * @param {number} u - linear transition progress, 0..1
 * @param {number} T - transition length in seconds
 * @param {number} d - this item's delay in seconds (0 = no delay)
 * @param {(t:number)=>number} easeFn - the transition's resolved curve
 * @returns {number} eased alpha for this item, 0..1
 *
 * @example itemDelayAlpha(0.5, 1, 0, ease("linear")) // 0.5 (d=0 is the identity)
 * @example itemDelayAlpha(0.25, 1, 0.5, ease("linear")) // 0 (still inside the hold: 0.25 < 0.5)
 * @example itemDelayAlpha(0.75, 1, 0.5, ease("linear")) // 0.5 ((0.75-0.5)/(1-0.5))
 * @example itemDelayAlpha(0.9, 1, 2, ease("linear")) // 0 (d ≥ T: held until the very end)
 * @example itemDelayAlpha(1, 1, 2, ease("linear")) // 1 (d ≥ T: steps exactly at u=1)
 */
export function itemDelayAlpha(u, T, d, easeFn) {
  if (!(d > 0)) return easeFn(u); // no delay (incl. absent/0): identical to the plain fold
  if (d >= T) return u >= 1 ? 1 : 0; // degenerate window: a step at the very end
  const itemU = Math.max(0, Math.min(1, (u * T - d) / (T - d)));
  return easeFn(itemU);
}

/**
 * Query (reads a slide's destination fold; not itself memoized beyond
 * `slideState`'s own cache). The itemIds on slide `index`'s DESTINATION fold
 * that carry a nonzero `delay` — empty for the overwhelming majority of
 * documents, which is what lets `foldState` take its ONE-ALPHA fast path.
 *
 * @param {object} doc - PowerRP document
 * @param {number} index - destination slide index
 * @returns {string[]} itemIds with delay > 0, or [] (byte-identical fast path)
 *
 * @example delayedItemIds({slides: [{delta: {items: {a: {x: 0}}}}]}, 0) // []
 * @example delayedItemIds({slides: [{delta: {items: {a: {x: 0, delay: 0.5}}}}]}, 0) // ["a"]
 */
function delayedItemIds(doc, index) {
  const items = slideState(doc, index).items ?? {};
  const out = [];
  for (const [id, state] of Object.entries(items)) if (state.delay > 0) out.push(id);
  return out;
}

/**
 * Query. The resolved transition seconds/curve/easeFn for the tween INTO slide
 * `index`, bundled once so `foldState` and `tweenedState` cannot resolve the
 * curve two different ways.
 *
 * @example transitionEasing({slides:[{},{transition:{type:"tween",seconds:1,curve:"linear"}}]}, 1).T // 1
 */
function transitionEasing(doc, index) {
  const { seconds: T, curve } = resolveTransition(doc, index);
  return { T, curve, easeFn: ease(curve === "linear" ? "linear" : "cubic") };
}

/**
 * Query (uses memoized folds). The EFFECTIVE eased alpha item `id` tweens at,
 * mid-transition INTO slide `index` at linear progress `u` — `easeFn(u)`
 * itself unless the item's DESTINATION fold carries a `delay`, in which case
 * itemDelayAlpha's windowed alpha. The one seam `foldState` and `tweenedState`
 * share so an item's blend and its plugin coupling hook never disagree about
 * what alpha it is AT.
 *
 * @example itemEffectiveAlpha({slides:[{delta:{items:{a:{x:0}}}},{delta:{items:{a:{x:10}}}}]}, 1, "a", 0.5) // 0.5 (no delay)
 */
function itemEffectiveAlpha(doc, index, id, u) {
  const { T, easeFn } = transitionEasing(doc, index);
  const d = slideState(doc, index).items?.[id]?.delay;
  return d > 0 ? itemDelayAlpha(u, T, d, easeFn) : easeFn(u);
}

/**
 * Pure function (uses memoized fold). State mid-transition INTO slide `index`
 * at LINEAR transition progress `u` (0 = previous slide exactly, 1 = slide
 * `index`). This is the single evaluation point for editor, presenter, and CLI
 * renderer — every caller passes RAW linear progress; the transition's `curve`
 * (core/transitions.resolveTransition) is applied HERE, once, per THE ALPHA
 * REFACTOR (manifest "THE `delay` UNIVERSAL PROPERTY — DESIGN"). A delay-free
 * document is BYTE-IDENTICAL to the pre-refactor picture: easing `u` at this
 * one seam reproduces exactly the pre-eased alpha every caller used to compute
 * for itself (core/presentation.js's tick, web/videoExport.js's segmentSample).
 *
 * `delay` (a universal item leaf, read from the DESTINATION slide's own alpha-1
 * fold — constant for the whole transition, so its own interpolation can never
 * matter) shrinks an item's tween into the window [delay, seconds] of the
 * transition — see itemDelayAlpha. THE FAST PATH: when no destination item
 * carries a delay, this is exactly the old one-`blendApplied`-call fold at the
 * eased alpha. Only when at least one item declares a delay does the delta
 * split per item, each blended at its OWN eased alpha; non-item leaves (vars)
 * always blend at the plain eased alpha — delay is an ITEM property.
 *
 * @example // foldState(doc, 2, 0.5) — halfway (linear) between slide 1 and slide 2
 */
export function foldState(doc, index, u = 1) {
  // Slide 0 has no predecessor to tween from — it is always fully applied.
  if (index === 0 || u >= 1) return slideState(doc, index);
  if (doc.slides[index].enabled === false) return slideState(doc, index - 1);
  const prev = slideState(doc, index - 1);
  const delta = doc.slides[index].delta;
  const { T, easeFn } = transitionEasing(doc, index);
  const delayed = delayedItemIds(doc, index);
  if (delayed.length === 0) return blendApplied(prev, delta, easeFn(u));
  // SLOW PATH: at least one destination item has a delay. Blend every
  // NON-item leaf (vars, etc.) at the plain eased alpha; blend each item's OWN
  // subtree at ITS OWN eased alpha (itemDelayAlpha), via the same generic
  // blendApplied a plain fold uses — delay changes WHEN an item's blend
  // starts, never HOW it blends.
  const { items: itemDeltas, ...restDelta } = delta;
  let out = blendApplied(prev, restDelta, easeFn(u));
  if (itemDeltas) {
    const dest = slideState(doc, index).items;
    out = { ...out, items: { ...out.items } };
    for (const [id, itemDelta] of Object.entries(itemDeltas)) {
      const d = delayed.includes(id) ? dest[id].delay : 0;
      const itemAlpha = itemDelayAlpha(u, T, d, easeFn);
      out.items[id] = blendApplied(prev.items?.[id] ?? {}, itemDelta, itemAlpha);
    }
  }
  return out;
}

/**
 * Pure function (uses memoized folds). THE TWEEN: `foldState` plus each widget's
 * OWN declared state interpolation. This is what every (doc, slide, alpha)
 * consumer should call — the editor's pixel consumers, the presenter, the
 * exporters and the CLI all reach it through web/cameraFrame.evaluatedStateAt.
 *
 * ── WHY A PLUGIN GETS A SAY IN THE TWEEN ─────────────────────────────────────
 * `foldState` tweens LEAF BY LEAF (core/deltas.blendApplied → interpolate), which
 * is right whenever a widget's properties are independent. Some are not. The
 * deep-zoom Mandelbrot's centre and zoom are COUPLED: its `zoomExponent` is a
 * logarithm, so the frame it names shrinks EXPONENTIALLY while a linearly-tweened
 * centre walks a straight line — and the point being zoomed into then swings
 * thousands of frame-widths off screen mid-transition and snaps back at the end
 * (measured: 4170 half-widths for a whole-set → seahorse-tail pair). No
 * reparameterization of the STORED leaves can fix that under a leaf-wise lerp: the
 * correct centre path is c(a) = A + B·10^(-z(a)) with A and B determined by BOTH
 * endpoints jointly, and requiring a pointwise map to reproduce it for every
 * endpoint pair forces A constant — i.e. no anchor at all. So the law needs the
 * two endpoint STATES, which is exactly what this function has and a leaf does not.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 *   plugin.interpolateState(from, to, alpha) → {stateKey: value}
 * PURE, and a function of (from, to, alpha) ONLY — so RenderTree stays
 * pure(document, [[slide, alpha]]). `from` is the folded state on the previous
 * slide, `to` is this slide's state at alpha 1 (both already memoized by
 * slideState, so declaring a hook costs no extra folding). The returned keys
 * REPLACE the leaf-wise result for that item; `{}` means "the generic lerp is
 * already right". Keys must be keyframable leaves of the item's own state.
 *
 * A hook is consulted ONLY strictly between the endpoints: at alpha 0 and 1 the
 * answer IS a stored state, so this is the identity there by construction, and
 * `foldState` alone remains the exact fold it has always been. For a DELAYED
 * item those endpoints are the item's OWN — still inside its hold window (its
 * effective alpha is 0) or already complete (1) — never `u` directly, per
 * itemEffectiveAlpha; a hook sees exactly the alpha the item was actually
 * blended at, so it can never "correct" a coupling the fold has not moved yet.
 *
 * @param {object} doc - PowerRP document
 * @param {number} index - slide index being tweened INTO
 * @param {number} u - linear transition progress, 0..1
 * @param {object} registry - plugin registry (resolves each item's type → plugin)
 * @returns {object} the folded state, with every declared coupling applied
 *
 * @example // tweenedState(doc, 1, 0.5, registry) — halfway (linear), coupled properties honored
 */
export function tweenedState(doc, index, u, registry) {
  const blended = foldState(doc, index, u);
  if (index === 0 || u <= 0 || u >= 1) return blended;
  if (doc.slides[index].enabled === false) return blended;
  const from = slideState(doc, index - 1), to = slideState(doc, index);
  let out = blended;
  for (const [id, state] of Object.entries(blended.items ?? {})) {
    // An item created or purged BY this delta has no pair of endpoint states, so
    // there is no coupling to speak of — its appearance/disappearance is the
    // generic discrete rule's business.
    const a = from.items?.[id], b = to.items?.[id];
    if (!a || !b) continue;
    // The SAME gate deriveRenderTree applies before its own `registry.get`: an
    // item that will not be rendered has no tween to correct, and a typeless one
    // (a raw pre-repair document) has no plugin to ask.
    if (state.active === false || typeof state.type !== "string") continue;
    const hook = registry.get(state.type).interpolateState;
    if (!hook) continue;
    // THE ITEM'S OWN alpha (itemEffectiveAlpha), not `u` — a delayed item's
    // window may still read 0 or 1 while `u` itself is strictly interior, and
    // the hook's endpoint-identity contract is stated in terms of the alpha it
    // was actually blended AT.
    const itemAlpha = itemEffectiveAlpha(doc, index, id, u);
    if (itemAlpha <= 0 || itemAlpha >= 1) continue;
    const over = hook(a, b, itemAlpha);
    if (Object.keys(over).length === 0) continue;
    // Copy-on-write: `blended` may be a CACHED fold (slideState's array) at the
    // endpoints, and even mid-tween it is shared with nothing that expects it to
    // change under it. One new object per corrected item, nothing else touched.
    if (out === blended) out = { ...blended, items: { ...blended.items } };
    out.items[id] = { ...state, ...over };
  }
  return out;
}

// ── Keyframe edits (all pure: return a new document) ─────────────────────────

/** Pure function. Sets a keyframe leaf in slide `index`'s delta. */
export function keyframed(doc, index, path, value) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, delta: setPath(s.delta, path, value) } : s);
  return { ...doc, slides };
}

/** Pure function. Removes a keyframe leaf from slide `index`'s delta. */
export function unkeyframed(doc, index, path) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, delta: deletePath(s.delta, path) } : s);
  return { ...doc, slides };
}

/** Pure function. True if slide `index`'s delta keys this exact path. */
export function hasKeyframe(doc, index, path) {
  return getPath(doc.slides[index].delta, path) !== undefined;
}

/**
 * Pure function. Slide indices whose delta keys `path`, ascending. Powers the
 * inspector's prev/next-keyframe jumps.
 *
 * @example // keyframeIndices(doc, ["items","ab12","x"]) → [0, 3, 7]
 */
export function keyframeIndices(doc, path) {
  const out = [];
  doc.slides.forEach((s, i) => {
    if (getPath(s.delta, path) !== undefined) out.push(i);
  });
  return out;
}

// The item-subtree leaf paths (relative to items.<id>) that can change an
// item's DERIVED world, plus a group's own INFLUENCE (Round 17 ungroup bake).
// A keyframe on any of these at slide i is a "change point" where the member's
// group-influenced world may differ from slide i−1, so ungroup must re-bake
// there. (fill/opacity/etc. don't move geometry, so they're excluded — no
// redundant transform keyframes.) `members`/`bind.*` are group-only but listing
// them for the member subtree too is harmless (members never key them).
const WORLD_AFFECTING_LEAVES = [
  ["x"], ["y"], ["rotation"], ["scale"], ["w"], ["h"],
  ["rotationAnchor", "x"], ["rotationAnchor", "y"], ["active"],
  ["members"], ["bind", "x"], ["bind", "y"], ["bind", "rotation"], ["bind", "scale"],
];

/**
 * Pure function. The ascending slide indices at which ungroup must BAKE a
 * member's transform (Round 17.3): every slide where the MEMBER or its GROUP has
 * a world-affecting keyframe (WORLD_AFFECTING_LEAVES), from the member's
 * creation slide onward. Between two such slides the member's group-influenced
 * world is constant (neither the member's own transform nor the group's
 * influence changed), so a keyframe baked at each change point reproduces the
 * pre-ungroup world on EVERY slide the member exists — that is the invariant
 * "removing the group changes nothing visible, anywhere". The member's creation
 * slide (where its full initial transform is keyed) is always included; slides
 * before it are excluded (the member does not exist yet).
 *
 * @example // member created slide 0 (x/y keyed), group moved on slide 2:
 * @example ungroupBakeSlides({slides: [{delta: {items: {m: {type: "rect", x: 1, y: 1}}}}, {delta: {items: {}}}, {delta: {items: {g: {x: 5}}}}]}, "m", "g") // [0, 2]
 * @example ungroupBakeSlides({slides: [{delta: {items: {m: {type: "rect", x: 1}}}}]}, "m", "g") // [0]
 */
export function ungroupBakeSlides(doc, memberId, groupId) {
  const creation = keyframeIndices(doc, ["items", memberId, "type"])[0] ?? 0;
  const touches = (id, delta) =>
    WORLD_AFFECTING_LEAVES.some((leaf) => getPath(delta, ["items", id, ...leaf]) !== undefined);
  const out = [];
  doc.slides.forEach((s, i) => {
    if (i < creation) return;
    if (i === creation || touches(memberId, s.delta) || touches(groupId, s.delta)) out.push(i);
  });
  return out;
}

/**
 * Pure function. THE fallback display name for an unnamed item: its plugin
 * `title` plus a 4-char id prefix — "Rect (ab12)". The ONE home for this format
 * (app.displayName and the Inspector item picker both built it by hand; cruft
 * audit "displayName fallback format in two homes"). Callers pass the item's
 * own `name` first and only fall back to this when it is absent.
 *
 * @example itemFallbackName("Rect", "ab12cd34") // "Rect (ab12)"
 * @example itemFallbackName("Camera", "ff00") // "Camera (ff00)"
 */
export function itemFallbackName(title, id) {
  return `${title} (${id.slice(0, 4)})`;
}

// ── Item edits ───────────────────────────────────────────────────────────────

/** Pure function. Creates an item (full initial state) in slide `index`'s delta. Returns [doc, itemId]. */
export function withNewItem(doc, index, state) {
  const id = uuid();
  return [keyframed(doc, index, ["items", id], copied(state)), id];
}

/**
 * Pure function. Clones a SET of item states under NEW ids, rerouting every
 * reference that points INSIDE the set and leaving every reference that points
 * OUTSIDE it verbatim. THE subgraph clone — the one place copy/paste and
 * Duplicate agree on what cloning a selection means.
 *
 * ── THE INTERNAL/EXTERNAL BOUNDARY (the whole difficulty) ─────────────────────
 * Cloning {A, B} where A references B must yield A' referencing B' — otherwise
 * the pasted copy is a puppet of the original. But a reference from A to some C
 * that is NOT in the set must still point at C — otherwise pasting an arrow
 * bound to a circle you did not copy would break the arrow. `idMap`'s KEY SET is
 * therefore the definition of "inside": mapped ⇒ reroute, unmapped ⇒ verbatim.
 *
 * ── THE TWO REFERENCE SHAPES ─────────────────────────────────────────────────
 *   1. EQUATION references — `@<id>.<prop>`, `@<id>_<anchor>.x`, and bare
 *      widget arguments `f(@<id>)` — living in any EQUATION slot (isEquationValue)
 *      of the item state, INCLUDING per-element slots of a declared list (a
 *      polygon vertex bound to another widget's anchor). Rewritten TOKEN-
 *      STRUCTURALLY by expressions.withItemRefsRemapped, never by string
 *      replacement (which would also hit "@id" inside a string literal and match
 *      a PREFIX of a longer id).
 *   2. ID-VALUED slots — a plain itemId (crop box `target`) or an array of them
 *      (group `members`), which are not equations at all and so are invisible to
 *      the token rewriter. Discovered from the plugin's own `itemRefs`
 *      declaration (the `legacyKeys` seam: a declarative path list, so core
 *      hard-codes no widget type); a string value maps as one id, an array maps
 *      element-wise.
 *
 * `external` is every itemId a clone still points at from OUTSIDE the set —
 * legitimate for a document-internal edge, and the caller's cue to REPORT the
 * ones its own document does not contain (a purged item, or a cross-document
 * paste): a dangling reference must never become a silent failure.
 *
 * Args:
 *   states (object): {sourceItemId: rawItemState} — the states being cloned
 *   idMap (Map): sourceItemId → the clone's NEW itemId (the caller mints them,
 *     which is what lets A' name B' before B' has been written anywhere)
 *   registry (object): plugin registry (.get(type) → plugin with .itemRefs?)
 *
 * Returns:
 *   {states: {newItemId: clonedState}, external: string[]}
 *
 * @example clonedItemStates({a: {type: "rect", x: "@b.x"}, b: {type: "rect", x: 5}}, new Map([["a", "A"], ["b", "B"]]), reg).states.A.x // "@B.x"
 * @example clonedItemStates({a: {type: "rect", x: "@c.x"}}, new Map([["a", "A"]]), reg) // {states: {A: {type: "rect", x: "@c.x"}}, external: ["c"]}
 * @example clonedItemStates({g: {type: "group", members: ["m"]}, m: {type: "rect"}}, new Map([["g", "G"], ["m", "M"]]), reg).states.G.members // ["M"]
 */
/**
 * THE WILDCARD SEGMENT in an `itemRefs` path. A plugin whose id-valued slots live
 * under DYNAMIC KEYS — a map whose keys are not knowable when the plugin is
 * written — declares `"*"` where the key would go.
 *
 * WHY THIS EXISTS: the node-flow protocol (core/nodeflow.js) stores a widget's
 * connections as `inputs: {<portKey>: {item, port}}`, and the port keys are the
 * plugin's own business — a mixer's are `in0..inN` and vary with its channel count.
 * A literal path cannot name them, so before this a copied PATCH kept its wires
 * pointing at the ORIGINAL nodes: the copy looked right and was silently reading
 * someone else's values, which is the exact failure `itemRefs` exists to prevent.
 *
 * It is deliberately ONE level and ONE meaning ("every key of the object at this
 * point"), not a glob language. Anything richer would be a query engine in a file
 * that is supposed to state where ids live.
 */
export const REF_PATH_WILDCARD = "*";

/**
 * Pure function. Expands `itemRefs` declarations against ONE state: every path
 * with no wildcard passes through unchanged, and a path containing
 * REF_PATH_WILDCARD becomes one concrete path per key actually present at that
 * point. A wildcard over a missing or non-object slot expands to NOTHING, which is
 * the right answer — there are no ids there to remap.
 *
 * @param {object} state - one item's state
 * @param {Array<string[]>} refPaths - the plugin's `itemRefs`
 * @returns {Array<string[]>} concrete paths, wildcards resolved
 *
 * @example expandRefPaths({target: "x"}, [["target"]]) // [["target"]]
 * @example expandRefPaths({inputs: {a: {item: "s"}, b: {item: "t"}}}, [["inputs", "*", "item"]]) // [["inputs", "a", "item"], ["inputs", "b", "item"]]
 * @example expandRefPaths({}, [["inputs", "*", "item"]]) // [] (nothing wired: nothing to remap)
 */
export function expandRefPaths(state, refPaths) {
  const out = [];
  for (const path of refPaths) {
    const at = path.indexOf(REF_PATH_WILDCARD);
    if (at === -1) { out.push(path); continue; }
    const container = getPath(state, path.slice(0, at));
    if (!container || typeof container !== "object") continue;
    for (const key of Object.keys(container)) out.push([...path.slice(0, at), key, ...path.slice(at + 1)]);
  }
  return out;
}

export function clonedItemStates(states, idMap, registry) {
  const out = {};
  const external = new Set();
  const mapId = (id) => {
    if (typeof id !== "string") return id;
    if (idMap.has(id)) return idMap.get(id);
    external.add(id);
    return id;
  };
  for (const [sourceId, state] of Object.entries(states)) {
    const newId = idMap.get(sourceId);
    if (!newId) throw new Error(`clonedItemStates: idMap has no new id for "${sourceId}" — every cloned state needs one (a clone's own references depend on it)`);
    const plugin = registry.get(state.type);
    // copiedDeep, not copied(): the id-valued rewrite below REPLACES a `members`
    // array, and copied() shares arrays with the source state (the fold cache's
    // fast path), so a shallower clone would mutate the document being cloned.
    const clone = copiedDeep(state);
    // 1. EQUATION references — the canonical "every equation slot of one item"
    //    walk (the evaluateState / withVariableRenamed idiom: leaves() keeps
    //    arrays opaque, so declared LIST elements are walked separately).
    for (const [path, value] of [...leaves(clone), ...declaredListLeaves(clone)])
      if (isEquationValue(plugin, path, value)) {
        const remapped = withItemRefsRemapped(value, idMap);
        for (const id of remapped.external) external.add(id);
        if (remapped.src !== value) setLeaf(clone, path, remapped.src);
      }
    // 2. ID-VALUED slots (plugin.itemRefs) — a plain id, an array of ids, or a
    //    WILDCARD path over a map of them (expandRefPaths).
    for (const path of expandRefPaths(clone, plugin.itemRefs ?? [])) {
      const value = getPath(clone, path);
      if (Array.isArray(value)) setLeaf(clone, path, value.map(mapId));
      else if (typeof value === "string") setLeaf(clone, path, mapId(value));
    }
    out[newId] = clone;
  }
  return { states: out, external: [...external] };
}

/**
 * Command (mutates `tree`). Writes `value` at `path` inside an ALREADY-CLONED
 * state tree. Every container along the way exists (the path came from walking
 * this very tree), so this only has to descend — the array-aware create-as-you-go
 * machinery deltas.setPath needs does not apply, and descending an array here is
 * safe because clonedItemStates deep-copied it.
 */
function setLeaf(tree, path, value) {
  let cur = tree;
  for (const key of path.slice(0, -1)) cur = cur[key];
  cur[path[path.length - 1]] = value;
}

/** Pure function. Removes an item FROM EXISTENCE: every keyframe of it on every slide. */
export function withItemPurged(doc, itemId) {
  let out = doc;
  for (let i = 0; i < doc.slides.length; i++) out = unkeyframed(out, i, ["items", itemId]);
  return out;
}

// ── GROUP LIFECYCLE CASCADES (WORKSTREAM BR) ─────────────────────────────────
// User, 2026-08-03: "When a group is purged, all of its children should be purged
// too. Same with... deletion." A group's members ARE its content (the same premise
// the clone set already runs on: "a group cloned WITHOUT them would be a second
// group steering the ORIGINAL items"), so a lifecycle verb applied to the group
// applies to what it owns.
//
// THE EXPANSION IS SHARED, THE WRITE IS NOT, and that split is the whole design.
// Purge and Delete disagree about SCOPE by definition — Purge is the document-wide
// remover, Delete is a per-slide `active` keyframe — but they agree exactly about
// WHICH ITEMS the verb reaches. Computing that set once means the two verbs cannot
// drift into disagreeing about what a group contains.
//
// NOT FOLDED INTO withItemPurged, deliberately: that primitive has callers for whom
// a cascade would be WRONG. `withOrphanedItemsDropped` purges a typeless item (a
// group with no `type` is not a group and owns nothing that survived either);
// `withCameraEnsured` purges surplus cameras; `ungroupSelection` purges the group
// AFTER baking its members' worlds — and cascading there would delete the very
// items ungroup exists to free. So the cascade is a NAMED verb the lifecycle
// commands opt into, not a behavior change under every existing caller.

/**
 * Pure function. A group's itemIds plus every member it owns, transitively through
 * nested groups — the set a group-lifecycle verb (Purge, Delete) reaches.
 *
 * Membership is read from the RAW folded state so a member merely HIDDEN on this
 * slide still travels, matching the clone set's rule for the same reason: a member
 * left behind by a group's removal is an orphan nothing steers.
 *
 * Cycle-safe (`seen`), multi-root, and roots-first in the returned order. A root
 * that is not a group returns just itself, so a mixed selection needs no branching
 * at the call site.
 *
 * @param {object} items - folded state's `items` map
 * @param {string[]} roots - the itemIds the verb was invoked on
 * @returns {string[]} roots first, then the members they pulled in
 *
 * @example groupCascadeIds({g: {type: "group", members: ["a"]}, a: {type: "rect"}}, ["g"]) // ["g", "a"]
 * @example groupCascadeIds({r: {type: "rect"}}, ["r"]) // ["r"] (a non-group reaches only itself)
 * @example // transitive through nesting: purging the outer group reaches the inner group's members
 * @example groupCascadeIds({o: {type: "group", members: ["g"]}, g: {type: "group", members: ["a"]}, a: {type: "rect"}}, ["o"]) // ["o", "g", "a"]
 */
export function groupCascadeIds(items, roots) {
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || !items[id]) return;
    seen.add(id);
    const s = items[id];
    if (s.type === "group" && Array.isArray(s.members)) for (const m of s.members) visit(m);
  };
  for (const id of roots) visit(id);
  return [...seen];
}

// ── MAKE STATIC FROM CURRENT SLIDE ───────────────────────────────────────────
//
// THE REQUEST (user): "another tool to remove all keyframes … for a given
// selection or object". Taken literally that is unbuildable: there is no separate
// items table, so slide 0's delta CREATES every item — deleting every delta entry
// for an object deletes the OBJECT. The buildable operation is a COLLAPSE: the
// item keeps exactly ONE full keyframe and stops changing. That is the same shape
// as the frame-freeze half of the camera-bind pair (core/registry.js
// CAMERA_FREEZE_HELP: "replace equation-bound x / y / w / h with the plain numbers
// they currently evaluate to … so the widget … stays put").
//
// It is NOT called "remove keyframes", because that name is the SIBLING's
// (withSlideKeyframesRemoved below, which clears one slide) and the user reported
// exactly that confusion: "remove animation keyframes is not supposed to remove it
// on every slide … I think that one needs a different name". The two tools differ
// by SCOPE, so their names must differ in their FIRST words — the palette is
// fuzzy-searched, and two titles opening "Remove Keyframes…" would both match one
// query and force the reader into the parentheticals to tell them apart.
//
// WHICH VALUE SURVIVES: the item's state on the slide the tool was invoked FROM.
// Current-slide values because every comparable house operation preserves what the
// user is looking at — ungroup BAKES the current group-influenced world so that
// "removing the group changes nothing visible, anywhere" (ungroupBakeSlides), and
// the frame freeze writes the numbers a property currently evaluates to.
//
// ── WHERE IT LANDS, AND HOW FAR IT REACHES: THE VISIBLE RUN ───────────────────
// The write point is the START OF THE CONTIGUOUS RUN OF SLIDES THE ITEM IS VISIBLE
// ON that contains the invoking slide (visibleRun), and the CLEARING COVERS EXACTLY
// THAT RUN. User: "that would set the state to the very very first slide of the
// current slide — or actually the first slide where it's visible, or the previous
// contiguous one where it's visible rather."
//
// He ruled on the write point; the reach FOLLOWS FROM IT, it is not a second
// preference. Take an item visible on 2-5, hidden on 6-7, visible again on 8-10,
// invoked from slide 4:
//   - A deck-wide clear plus a write at the run start (2) would be fine here, but
//     put the run later — invoke from 9, run start 8 — and clearing slides 2-5
//     strips the item's `type` from its creation slide, so it no longer EXISTS on
//     the earlier run. The item's earlier appearance is destroyed.
//   - Writing at the CREATION slide as well, to keep it alive, makes the run-start
//     write pure decoration: one full state anywhere at or before everything
//     already renders identically on every slide, so the write point would have NO
//     observable consequence and the user's refinement would mean nothing. Worse,
//     the two copies then disagree the moment either is edited.
//   - Clearing exactly the run needs no second write, cannot touch the creation
//     slide unless the run starts there, and is the ONLY reading under which
//     "where the state is set" is observable at all.
// So the run is the unit. For the ordinary item — one that is never hidden — the
// run IS creation-slide-to-end-of-deck, so this is byte-identical to a deck-wide
// collapse; the distinction only bites on an item with a gap, where it is the
// difference between refining and destroying.
//
// A CONSEQUENCE WORTH STATING: a LATER run that INHERITED its values from this one
// moves with it (slides 8-10 above, if they key nothing of their own, now inherit
// the static value). That is inheritance, not a special case — it is what a delta
// document does — and the run's own slides are the only ones this rewrites.
//
// `active` IS NEVER TOUCHED, on any slide. It is not animation, it is EXISTENCE:
// "`active: false` is how items exist on some slides and not others — Delete
// keyframes it; Purge actually removes" (core/properties.js PROPS.active).
// Collapsing it would silently perform a Delete-everywhere or a Show-everywhere —
// operations that already have their own named commands — and invoking the tool
// from a slide where the item is HIDDEN would collapse `active: false` onto every
// slide of the run, i.e. the object would disappear while still passing a "looks
// identical on the slide you invoked from" check. Exempting it is also what makes
// the run definable at all: the runs are read OFF `active`, so an operation that
// rewrote it could not say which slides it was allowed to touch.
// `type` needs no exemption: it is part of the state written back, and an item
// whose type is set nowhere is an orphan (orphanedItems drops it at load).
//
// HIDDEN HERE ⇒ REFUSED. With no visible run containing the invoking slide there
// is no answer to "static from where, over what", so it reports and changes
// nothing rather than guessing.
//
// EQUATIONS SURVIVE WHERE THEY ARE IN FORCE, because the state written back is the
// RAW fold (equation strings intact), never the evaluated one — so a widget bound
// to THE camera is still bound afterwards. An equation stored on ANOTHER slide OF
// THE RUN is destroyed, because it is a keyframe and destroying keyframes is the
// declared purpose; lostEquationKeyframes names every one so it is never silent.

/** The one item leaf neither keyframe tool's collapse touches — EXISTENCE, not
 *  animation. (The per-slide REMOVE does clear it; see its own block for why.) */
const EXISTENCE_LEAF = "active";

/**
 * Pure function. True for the leaf path the collapse must leave alone — the item's
 * OWN `active`, not a same-named leaf nested inside some sub-state.
 *
 * @example isExistenceLeaf(["active"]) // true
 * @example isExistenceLeaf(["x"]) // false
 * @example isExistenceLeaf(["pointsActive"]) // false (a LIST's visibility companion is ordinary state)
 */
function isExistenceLeaf(path) {
  return path.length === 1 && path[0] === EXISTENCE_LEAF;
}

/**
 * Pure function. Is `itemId` VISIBLE in the fold at slide `i` — created (some
 * slide has written a `type`) and not switched off? Exactly the gate
 * deriveRenderTree applies before painting, so "visible" here means the same
 * thing it means on screen.
 *
 * @example // an item created on slide 0 and deleted on slide 2:
 * @example visibleAt({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {}}, {delta: {items: {a: {active: false}}}}]}, "a", 1) // true
 * @example visibleAt({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {}}, {delta: {items: {a: {active: false}}}}]}, "a", 2) // false
 */
function visibleAt(doc, itemId, i) {
  const s = foldState(doc, i, 1).items?.[itemId];
  return !!s && typeof s.type === "string" && s.active !== false;
}

/**
 * Pure function. The CONTIGUOUS RUN of slides on which `itemId` is visible that
 * CONTAINS `slideIndex`, as {start, end} inclusive — or null when the item is not
 * visible there (hidden, not yet created, or never typed), in which case there is
 * no run and Make Static has nothing to be static over.
 *
 * THE RUN START IS ALWAYS AN ENABLED SLIDE, and that is a theorem rather than a
 * case to handle: a DISABLED slide's delta is skipped entirely, so its folded state
 * IS its predecessor's — an item visible on a disabled slide is therefore visible
 * on the slide before it too, so a disabled slide can never be where a run begins.
 * (At index 0 a disabled slide folds to the empty state, so nothing is visible
 * there either.) withItemsMadeStatic asserts it rather than trusting this comment.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide the run must contain
 *   itemId (string): the item
 *
 * Returns:
 *   {start: number, end: number} | null
 *
 * @example // visible on 0-1, hidden from 2:
 * @example visibleRun({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {}}, {delta: {items: {a: {active: false}}}}]}, 1, "a") // {start: 0, end: 1}
 * @example visibleRun({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {}}, {delta: {items: {a: {active: false}}}}]}, 2, "a") // null (hidden there)
 * @example // shown again on slide 3 → a SECOND run, found from inside it:
 * @example visibleRun({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {items: {a: {active: false}}}}, {delta: {}}, {delta: {items: {a: {active: true}}}}]}, 3, "a") // {start: 3, end: 3}
 */
export function visibleRun(doc, slideIndex, itemId) {
  if (!visibleAt(doc, itemId, slideIndex)) return null;
  let start = slideIndex;
  while (start > 0 && visibleAt(doc, itemId, start - 1)) start--;
  let end = slideIndex;
  while (end < doc.slides.length - 1 && visibleAt(doc, itemId, end + 1)) end++;
  return { start, end };
}

/**
 * Pure function. The slide that BRINGS `itemId` INTO EXISTENCE for the fold: the
 * first slide that sets its `type` AND actually participates in the fold, or null
 * when there is none. The house's creation-slide rule (renameSelection,
 * ungroupBakeSlides and app.#creationState all take the first slide keying `type`)
 * plus the ENABLED check that rule can normally take for granted — a DISABLED
 * slide's delta is skipped entirely (slideState), so that slide creates nothing.
 *
 * The per-slide REMOVE REFUSES here — clearing this slide's entries would take the
 * item out of the document, which is Purge Item's job and not a keyframe edit's.
 * (Make Static writes at its VISIBLE RUN's start instead, which coincides with this
 * slide for any item that is never hidden; see visibleRun for why that is right.)
 *
 * @example itemCreationSlide({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {items: {a: {x: 1}}}}]}, "a") // 0
 * @example itemCreationSlide({slides: [{enabled: false, delta: {items: {a: {type: "rect"}}}}, {delta: {items: {a: {type: "rect"}}}}]}, "a") // 1 (slide 0 is out of the fold)
 * @example itemCreationSlide({slides: [{delta: {items: {a: {x: 1}}}}]}, "a") // null (no slide sets its type)
 */
export function itemCreationSlide(doc, itemId) {
  for (const i of keyframeIndices(doc, ["items", itemId, "type"]))
    if (doc.slides[i].enabled !== false) return i;
  return null;
}

/**
 * Pure function. The keyframes Make Static would DESTROY for `itemId` when run
 * from `slideIndex`: every leaf of its subtree on the slides of its VISIBLE RUN
 * (visibleRun) EXCEPT the run's first slide — whose full state is rewritten rather
 * than removed — and EXCEPT `active` (see the block comment). Empty means the item
 * is already static across that run and the tool has nothing to do, which is
 * exactly the command's availability gate, so a greyed-out control and a no-op
 * click cannot disagree. Not visible here ⇒ no run ⇒ empty.
 *
 * A whole-item delta that is not a tree (the `null` delete sentinel) counts as
 * ONE leaf at the empty path, so it is removed too rather than silently surviving
 * a collapse and deleting the item from the fold on that slide.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide the tool is invoked from
 *   itemId (string): the item
 *
 * Returns:
 *   {slideIndex, path, value}[] — `path` is relative to the item's own state
 *
 * @example itemAnimationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, "a") // [{slideIndex: 1, path: ["x"], value: 9}]
 * @example itemAnimationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {active: false}}}}]}, 0, "a") // [] (visibility is not animation, and the run is slide 0 alone)
 * @example itemAnimationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}]}, 0, "a") // [] (already static)
 */
export function itemAnimationKeyframes(doc, slideIndex, itemId) {
  const run = visibleRun(doc, slideIndex, itemId);
  if (!run) return [];
  const out = [];
  for (let i = run.start + 1; i <= run.end; i++) {
    const item = getPath(doc.slides[i].delta, ["items", itemId]);
    if (item === undefined) continue;
    if (!isTree(item)) {
      out.push({ slideIndex: i, path: [], value: item });
      continue;
    }
    for (const [path, value] of leaves(item))
      if (!isExistenceLeaf(path)) out.push({ slideIndex: i, path, value });
  }
  return out;
}

/**
 * Pure function. Every EQUATION Make Static from slide `slideIndex` would destroy
 * for `itemId`: an equation-valued leaf stored on a slide OF THE VISIBLE RUN whose
 * value is not the one the static state keeps at that same path.
 *
 * TWO NARROWINGS, each removing a class of false alarm:
 *   THE RUN — slides outside it are not rewritten at all, so an equation there
 *     survives untouched and naming it would be a lie.
 *   THE COMPARISON — the state written back is the RAW fold, so an equation IN
 *     FORCE on the invoking slide is written back verbatim and loses nothing. The
 *     common case (a widget bound to THE camera on its creation slide, or a
 *     `self.`-computed rotationAnchor) reports nothing at all.
 *
 * REPORTING IS THE CALLER'S JOB (the repair pipeline's rule): this only builds
 * the list. Unlike the flip's equation REFUSAL, this proceeds — the flip's write
 * was incidental to a geometric request and had "unbind first" as an escape,
 * whereas here destroying keyframes IS the request and refusing would make the
 * tool unusable on exactly the decks that need it.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide the tool is invoked from
 *   itemId (string): the item
 *   registry (object): plugin registry (.get(type) → plugin; decides equation slots)
 *
 * Returns:
 *   {slideIndex, path, value}[] (empty when nothing is lost)
 *
 * @example // x is "=100" on slide 0 and a literal 9 on slide 1; running from slide 1 drops the equation:
 * @example lostEquationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: "=100"}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, "a", reg) // [{slideIndex: 0, path: ["x"], value: "=100"}]
 * @example // the same equation still in force on the invoking slide is written back, so nothing is lost:
 * @example lostEquationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: "=100"}}}}, {delta: {items: {a: {y: 9}}}}]}, 1, "a", reg) // []
 */
export function lostEquationKeyframes(doc, slideIndex, itemId, registry) {
  const run = visibleRun(doc, slideIndex, itemId);
  if (!run) return [];
  const frozen = foldState(doc, slideIndex, 1).items[itemId];
  const plugin = registry.get(frozen.type);
  const out = [];
  for (let i = run.start; i <= run.end; i++) {
    const item = getPath(doc.slides[i].delta, ["items", itemId]);
    if (!isTree(item)) continue;
    for (const [path, value] of leaves(item)) {
      if (isExistenceLeaf(path)) continue;
      if (!isEquationValue(plugin, path, value)) continue;
      if (deepEqual(getPath(frozen, path), value)) continue;
      out.push({ slideIndex: i, path, value });
    }
  }
  return out;
}

/**
 * Pure function. Document with every item in `itemIds` MADE STATIC at its state on
 * slide `slideIndex`: across the slides of the item's VISIBLE RUN its whole subtree
 * is cleared (`active` excepted) and its raw folded state is written back once, at
 * the run's FIRST slide. Its appearance on `slideIndex` is unchanged by
 * construction; on every other slide of that run it now shows the same thing, and
 * no slide outside the run is rewritten. See the block comment above for why the
 * run is the unit and why `active` is exempt.
 *
 * ONE FOLD FOR THE WHOLE SET (not a per-item loop over a shrinking document):
 * an item's folded state depends only on its own leaves, so making one static
 * cannot move another, and folding once keeps a multi-selection linear rather than
 * re-folding the deck per item.
 *
 * SKIPS, NEVER THROWS, on the two ways an item can have nothing to make static —
 * and hands the reasons back, because REPORTING IS THE CALLER'S JOB (the repair
 * pipeline's rule; the app console.errors each one). A mixed selection therefore
 * does what it can instead of failing whole. It DOES throw on the one thing that is
 * structurally impossible (a run beginning on a slide out of the fold), because a
 * silent write into a skipped delta would delete the item from the document.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide whose values survive
 *   itemIds (string[]): the items to make static
 *
 * Returns:
 *   {doc, madeStatic: string[], skipped: {id, reason}[]}
 *
 * @example withItemsMadeStatic({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, ["a"]).doc.slides[0].delta.items.a.x // 9
 * @example withItemsMadeStatic({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, ["a"]).doc.slides[1].delta.items // undefined (the animation keyframe is gone)
 * @example // hidden HERE → refused: "static from where, over what" has no answer
 * @example withItemsMadeStatic({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9, active: false}}}}]}, 1, ["a"]).madeStatic // []
 * @example withItemsMadeStatic({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}]}, 0, ["a"]).skipped // [{id: "a", reason: "it has no keyframes past the start of the stretch it is visible on — it is already static there"}]
 */
export function withItemsMadeStatic(doc, slideIndex, itemIds) {
  const state = foldState(doc, slideIndex, 1);
  const madeStatic = [];
  const skipped = [];
  let out = doc;
  for (const id of itemIds) {
    const run = visibleRun(doc, slideIndex, id);
    if (!run) {
      skipped.push({ id, reason: `it is not visible on slide ${slideIndex} (hidden there, created later, or never given a type), so there is no visible stretch to make static` });
      continue;
    }
    if (itemAnimationKeyframes(doc, slideIndex, id).length === 0) {
      skipped.push({ id, reason: "it has no keyframes past the start of the stretch it is visible on — it is already static there" });
      continue;
    }
    // visibleRun's theorem, asserted rather than trusted: a DISABLED slide folds to
    // its predecessor's state, so it can never BEGIN a visible run. If that ever
    // stopped holding, the write below would land in a delta the fold skips and the
    // item would disappear from the document — far too quiet a way to lose work.
    if (doc.slides[run.start].enabled === false)
      throw new Error(`withItemsMadeStatic: the visible run of "${id}" begins on slide ${run.start}, which is DISABLED — a disabled slide's delta is skipped by the fold, so it cannot begin a run (see visibleRun) and writing there would remove the item`);
    // 1. Clear the item's whole subtree across the RUN, the run's own first slide
    //    included, so step 2 is the ONLY thing that decides its state there.
    //    Leaving the first slide's leaves in place would resurrect any key a later
    //    `null` delete sentinel had removed from the fold — the static state would
    //    then not be what step 2 wrote. `active` is exempt (see the block comment).
    for (let i = run.start; i <= run.end; i++) {
      const item = getPath(doc.slides[i].delta, ["items", id]);
      if (item === undefined) continue;
      if (!isTree(item)) {
        out = unkeyframed(out, i, ["items", id]);
        continue;
      }
      for (const [path] of leaves(item))
        if (!isExistenceLeaf(path)) out = unkeyframed(out, i, ["items", id, ...path]);
    }
    // 2. Write the static state back ONCE, leaf-wise — the showSelection walk's
    //    shape (nested subtrees keyframe per leaf, arrays are whole leaf values),
    //    so a `rotationAnchor` lands as two number keyframes and a `points` list
    //    as one.
    for (const [path, leafValue] of leaves(state.items[id]))
      if (!isExistenceLeaf(path)) out = keyframed(out, run.start, ["items", id, ...path], leafValue);
    madeStatic.push(id);
  }
  return { doc: out, madeStatic, skipped };
}

// ── Clearing ONE slide's keyframes for an item ────────────────────────────────
//
// THE REQUEST (user, correcting the scope of Make Static above): "remove keyframes,
// to just remove the keyframes at the current slide for the currently selected
// object. That is it." So the two keyframe tools differ by SCOPE, not by
// reversibility: Make Static flattens a whole VISIBLE STRETCH, this clears ONE SLIDE.
//
// WHAT THE USER SEES: the item stops CHANGING here and INHERITS the previous
// slide's folded values instead — the animation passes THROUGH this slide rather
// than stopping at it, and any later keyframe now tweens from the inherited value.
// So unlike Make Static, this is NOT appearance-preserving on the slide it is run
// from: that is the point of it.
//
// `active` GOES TOO, unlike Make Static — and the reasoning does not carry over,
// because what made the deck-wide case dangerous was the COLLAPSE, not the leaf.
// There, one `active` value would be imposed on a whole run at once, so running it
// from a slide where the item was hidden would erase the item over that run. Here the
// edit is confined to one slide's delta and the result is INHERITANCE, not
// imposition: the previous slide's visibility flows through exactly as every other
// property does. The item cannot be destroyed either, because the refusal below
// protects its creation slide. And the inverse is one click of Delete or Show on
// this slide, so nothing is lost that the user cannot put back BY HAND — not merely
// by undo. Carving `active` out would instead leave a filled ◆ on the Visible row
// of the very slide the user just asked to clear, i.e. the tool would be lying.
//
// THE REFUSAL: an item's CREATION slide (itemCreationSlide). Its delta is what
// brings the item into existence, so clearing it there deletes the item — a
// keyframe edit must never do Purge Item's job. Reported, per item, never silent.

/**
 * Pure function. What "Remove Keyframes on This Slide" would delete for `itemId`:
 * every leaf of its subtree in slide `slideIndex`'s OWN delta. Empty means this
 * slide says nothing about the item, so there is nothing to remove — the
 * command's availability gate, which is deliberately DIFFERENT from Make Static's
 * (an item can be animated elsewhere and keyed nowhere here, and vice versa).
 *
 * A whole-item delta that is not a tree (the `null` delete sentinel) counts as ONE
 * leaf at the empty path, matching itemAnimationKeyframes.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide to clear
 *   itemId (string): the item
 *
 * Returns:
 *   {path, value}[] — `path` is relative to the item's own state
 *
 * @example itemSlideKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, "a") // [{path: ["x"], value: 9}]
 * @example itemSlideKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 0, "a").length // 2 (the creation slide keys type and x)
 * @example itemSlideKeyframes({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {}}]}, 1, "a") // [] (this slide says nothing about it)
 */
export function itemSlideKeyframes(doc, slideIndex, itemId) {
  const item = getPath(doc.slides[slideIndex].delta, ["items", itemId]);
  if (item === undefined) return [];
  if (!isTree(item)) return [{ path: [], value: item }];
  return leaves(item).map(([path, value]) => ({ path, value }));
}

/**
 * Pure function. Which of slide `slideIndex`'s keyframes for `itemId` hold an
 * EQUATION — the ones a per-slide removal destroys outright (there is no rewrite
 * here, so unlike Make Static's lostEquationKeyframes there is nothing to compare
 * against: every equation on this slide goes).
 *
 * WHY REPORT AT ALL, when the Inspector's own ◆ button already drops a single
 * keyframe silently: this drops the item's WHOLE slide entry in one click, so an
 * equation the user cannot see from the row they were looking at can go with it.
 * The keyframe-removal ruling stands — destroying keyframes is the request, so it
 * proceeds; it just never does so quietly. REPORTING IS THE CALLER'S JOB.
 *
 * The item's plugin comes from its folded type on this slide, falling back to the
 * type its creation slide writes — an item can be keyed here while not yet
 * existing here (a pre-creation leftover), and it still deserves the report.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide to clear
 *   itemId (string): the item
 *   registry (object): plugin registry (.get(type) → plugin; decides equation slots)
 *
 * Returns:
 *   {path, value}[] (empty when this slide keys no equation for the item)
 *
 * @example slideEquationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: "=50"}}}}]}, 1, "a", reg) // [{path: ["x"], value: "=50"}]
 * @example slideEquationKeyframes({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, "a", reg) // [] (a plain number is not an equation)
 */
export function slideEquationKeyframes(doc, slideIndex, itemId, registry) {
  const type = foldState(doc, slideIndex, 1).items?.[itemId]?.type
    ?? getPath(doc.slides[itemCreationSlide(doc, itemId) ?? slideIndex].delta, ["items", itemId, "type"]);
  if (typeof type !== "string") return [];
  const plugin = registry.get(type);
  return itemSlideKeyframes(doc, slideIndex, itemId)
    .filter(({ path, value }) => isEquationValue(plugin, path, value));
}

/**
 * Pure function. Document with slide `slideIndex`'s ENTIRE delta entry removed for
 * every item in `itemIds` — so each one stops changing there and inherits the
 * previous slide's values (see the block comment above for what the user sees and
 * why `active` is included here but exempt from Make Static).
 *
 * TWO OUTCOMES BESIDES SUCCESS, and only one of them is worth a word:
 *   REFUSED — this is the item's creation slide, so clearing it would delete the
 *     item from the document. Handed back with a reason; the caller reports it.
 *   nothing to do — the slide simply keys nothing for that item. NOT a refusal and
 *     NOT reported: "there was nothing there" is not a failure, and saying so for
 *     every unrelated item in a multi-selection would be noise.
 *
 * Args:
 *   doc (object): document
 *   slideIndex (number): the slide to clear
 *   itemIds (string[]): the items to clear on it
 *
 * Returns:
 *   {doc, cleared: string[], refused: {id, reason}[]}
 *
 * @example withSlideKeyframesRemoved({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, ["a"]).doc.slides[1].delta.items // undefined (pruned away)
 * @example withSlideKeyframesRemoved({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}, {delta: {items: {a: {x: 9}}}}]}, 1, ["a"]).cleared // ["a"]
 * @example withSlideKeyframesRemoved({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}], }, 0, ["a"]).refused.length // 1 (slide 0 CREATES it)
 * @example withSlideKeyframesRemoved({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {}}]}, 1, ["a"]).cleared // [] (nothing there — not a refusal)
 */
export function withSlideKeyframesRemoved(doc, slideIndex, itemIds) {
  const cleared = [];
  const refused = [];
  let out = doc;
  for (const id of itemIds) {
    if (slideIndex === itemCreationSlide(doc, id)) {
      refused.push({ id, reason: `slide ${slideIndex} is the slide that CREATES it, and its delta there IS the item — clearing it would remove the widget from the document (Purge Item is the tool for that)` });
      continue;
    }
    if (itemSlideKeyframes(doc, slideIndex, id).length === 0) continue;
    // ONE unkeyframe of the whole subtree: deletePath prunes the emptied `items`
    // entry (and `items` itself) for free, so the slide's delta is left exactly as
    // it would have been had the item never been touched here.
    out = unkeyframed(out, slideIndex, ["items", id]);
    cleared.push(id);
  }
  return { doc: out, cleared, refused };
}

/**
 * Pure function. Item ids that can never render: ids referenced by any
 * slide's delta whose `type` is never set to one of `knownTypes` in ANY
 * slide's delta (enabled or disabled — a disabled creation slide is a
 * transient view state, not an orphan). The known producer: deleting an
 * item's CREATION slide leaves its later property keyframes orphaned, and
 * the fold then materializes a typeless item that crashes evaluation.
 *
 * Args:
 *   doc (object): document
 *   knownTypes (Set<string>): registered plugin type names
 *
 * Returns:
 *   {id, reason}[] (empty when the document is clean)
 *
 * @example orphanedItems({slides: [{delta: {items: {a: {x: 99}}}}]}, new Set(["rect"])) // [{id: "a", reason: "no type is ever set (orphaned keyframes)"}]
 * @example orphanedItems({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}]}, new Set(["rect"])) // []
 */
export function orphanedItems(doc, knownTypes) {
  const typeOf = new Map();
  const seen = new Set();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      seen.add(id);
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
    }
  const out = [];
  for (const id of seen) {
    if (!typeOf.has(id)) out.push({ id, reason: "no type is ever set (orphaned keyframes)" });
    else if (!knownTypes.has(typeOf.get(id))) out.push({ id, reason: `unknown type "${typeOf.get(id)}"` });
  }
  return out;
}

/**
 * Pure function. Document with every orphaned item's subtree purged from
 * every slide delta, plus the report of exactly what was removed and why.
 * REPORTING IS THE CALLER'S JOB — the repair never hides anything, it hands
 * back the drop list (the app console.errors each entry; silence forbidden).
 * Idempotent; a clean document comes back unchanged with dropped = [].
 *
 * @example withOrphanedItemsDropped({slides: [{delta: {items: {a: {x: 99}}}}]}, new Set(["rect"])).dropped.length // 1
 * @example // withOrphanedItemsDropped(cleanDoc, types) → {doc: cleanDoc-equivalent, dropped: []}
 */
export function withOrphanedItemsDropped(doc, knownTypes) {
  const dropped = orphanedItems(doc, knownTypes);
  let out = doc;
  for (const { id } of dropped) out = withItemPurged(out, id);
  return { doc: out, dropped };
}

/**
 * Pure function. Default-valued leaf paths a TYPED item never writes (non-null)
 * in ANY slide delta. Such partial items fold into states missing required
 * geometry ("w: undefined"); the canvas2D painter silently drew nothing for
 * them, but the strict IR builders throw and brick the app — so they must be
 * repaired at the load boundary.
 *
 * WHEN THIS FIRES: routinely, on VERSION SKEW — whenever PowerRP's plugin
 * defaults GROW (e.g. rotationAnchor was added in round 11), every document
 * saved by an older version is missing the new keys and gets them filled on
 * load; this is how edits are preserved across versions. Exceptionally, on
 * DAMAGED or HAND-WRITTEN documents (hand-authored save files are legal) and
 * on explicit null deletes of required keys. A doc created and edited purely
 * by the current version reports nothing.
 *
 * `type` itself is exempt (that's the orphan case — see orphanedItems); a
 * null (delete-sentinel) write does NOT count as coverage, since it folds to
 * the same missing key — EXCEPT where the plugin's own default IS null (see
 * the null-default note in the body: nothing else can cover such a key, so
 * without the exception the report repeats on every load forever).
 *
 * EACH MISSING LEAF CARRIES ITS CAUSE as `deleted` — true when some slide wrote
 * an explicit `null` at that path (a DELETE SENTINEL: the author's value existed
 * and is gone, so substituting a default changes meaning), false when the key is
 * simply absent everywhere (VERSION SKEW: legal legacy state, filled at the
 * plugin's own default, byte-identical render). repairedDocument reports only
 * the first — see the note in the body for why conflating them broke the loud
 * channel.
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (.get(type) → plugin with .defaults)
 *
 * Returns:
 *   {id, slideIndex, missing: {path: string[], value, deleted: boolean}[]}[]
 *
 * @example missingDefaults({slides: [{delta: {items: {a: {type: "rect", x: 1, y: 2}}}}]}, reg)[0].missing.some((m) => m.path.join(".") === "w") // true
 * @example // version skew — a pre-blur item's gaussianBlur comes back {path: ["gaussianBlur"], value: 0, deleted: false}
 * @example // damage — after keyframing items.a.w to null, that leaf comes back deleted: true
 * @example // a fully-written item (normal creation) reports nothing
 */
export function missingDefaults(doc, registry) {
  const typeSlide = new Map(); // id → first slide index with a known type
  const written = new Map(); // id → Set of non-null leaf path strings
  const nulled = new Map(); // id → Set of leaf paths written as NULL (delete sentinel)
  for (let i = 0; i < doc.slides.length; i++)
    for (const [id, item] of Object.entries(doc.slides[i].delta.items ?? {})) {
      if (!(item && typeof item === "object")) continue;
      if (typeof item.type === "string" && !typeSlide.has(id)) typeSlide.set(id, i);
      if (!written.has(id)) { written.set(id, new Set()); nulled.set(id, new Set()); }
      const set = written.get(id);
      const nulls = nulled.get(id);
      for (const [path, value] of leaves(item)) (value === null ? nulls : set).add(path.join("."));
    }
  const out = [];
  for (const [id, slideIndex] of typeSlide) {
    let plugin;
    try {
      plugin = registry.get(doc.slides[slideIndex].delta.items[id].type);
    } catch {
      continue; // unknown type = the orphan case, repaired by orphanedItems
    }
    const set = written.get(id);
    const nulls = nulled.get(id);
    // THE KEYS WHOSE `null` IS AN AUTHORED VALUE, not a delete sentinel — the rows
    // declaring `nullable: true` (core/properties.js "THE `nullable` ROW ASPECT":
    // "a nullable row's stored ABSENCE may be `undefined` (never written) or `null`
    // (cleared); both display as unset"). Derived from the plugin's own rows through
    // the existing row index, so a widget that adds a nullable row is covered the
    // day it declares one and nothing here has to be remembered.
    const nullableKeys = new Set([...rowsByKey(plugin)].filter(([, row]) => row.nullable === true).map(([key]) => key));
    const missing = [];
    for (const [path, value] of leaves(plugin.defaults)) {
      // COMPUTED defaults (self.-equations) are skipped here ONLY for the two
      // keys that have a genuine DERIVATION-STAGE fallback reproducing the same
      // equation's own value when the key is absent — rotationAnchor.{x,y}
      // (core/derive.js worldTransform falls back to boxCenter(itemState), the
      // literal `self.anchors.center` computation) and magnifier's origin.{x,y}
      // (plugins/magnifier.js originLocal falls back to the lens centre, same
      // reasoning). For those, injecting the equation would rewrite every
      // pre-round-11 document on load for no behavioural gain (Opus1 review
      // finding #1) — the fallback already produces byte-identical output.
      //
      // god_rays/lens_flare's lightWorldX/Y are self.-prefixed too but do NOT
      // qualify: nothing outside evaluateState knows what "the light position"
      // should be if the key is absent, so lightLocal's `?? 0` is a bare
      // technical null-guard (world ORIGIN), not a semantic reconstruction of
      // the widget's own default. An item created during the leading-"="
      // window (the shipped bug this file's fix accompanies) is missing these
      // keys entirely and must have them FILLED, or it stays broken forever —
      // the general string-shape test used to skip them by accident, which is
      // why that test is now an explicit allowlist instead of a shape guess.
      const DERIVATION_BACKED_SELF_KEYS = new Set(["rotationAnchor.x", "rotationAnchor.y", "origin.x", "origin.y"]);
      if (typeof value === "string" && value.startsWith("self.") && DERIVATION_BACKED_SELF_KEYS.has(path.join(".")))
        continue;
      // A scalar default key is ALSO covered when the item wrote a nested OBJECT
      // there (e.g. default `background: "#fff"` but the item holds a gradient
      // PAINT object → the written set has `background.type`/`background.stops…`
      // but not bare `background`). Without this, the scalar default would be
      // keyframed OVER the gradient on load — silently wiping every gradient
      // paint (background/fill/stroke) on repair. Treat "any written descendant"
      // as coverage so paint objects survive a load/repair round-trip.
      const key = path.join(".");
      const coveredByNested = set.has(key) || [...set].some((w) => w.startsWith(key + "."));
      // A default that IS null (cropbox.target — the "no target chosen" picker;
      // the only null default in the roster, and the gate below is written so a
      // second one needs no further change) cannot be covered by the non-null
      // `written` set at all: keyframing null writes the DELETE sentinel, which
      // folds back to "key absent", so the fill can never satisfy its own
      // coverage test. That made this the REVERSE of a silent repair — the
      // report was emitted on every load forever while the document never
      // changed, which is worse than silence because it is the one channel the
      // no-silent-repairs doctrine relies on, and it falsified
      // repairedDocument's "idempotent, reports = []" contract for every
      // document containing a crop box. For a null default a null write is
      // EXACTLY the state being asked for, so it counts as coverage; every
      // other key's delete-sentinel handling is untouched (a `w: null` still
      // reports and still gets the real default filled in).
      //
      // A NULLABLE ROW'S `null` IS THE SECOND CASE THAT GATE WAS WRITTEN FOR, and
      // the paragraph above promised it would need no further change; it needed one
      // clause. `cropbox.target` qualifies because its DEFAULT is null. A nullable
      // row qualifies because its null is what the author WROTE with the Inspector's
      // clear affordance — "(none)" — which is a different value from its default,
      // not the absence of one. MEASURED before this line, on the first nullable ITEM
      // row the codebase has ever had (`camera.maxTimestep`; the other two nullable
      // rows live on a SLIDE, so this fill had never met one): clearing it came back
      // from one load as 0.1, with a loud repair line calling the author's deliberate
      // choice a deletion. The author's "none" was destroyed by the machinery meant to
      // protect required keys, on every load, forever.
      const coveredByNull = nulls.has(key) && (value === null || nullableKeys.has(key));
      // WHY EACH FILL CARRIES ITS OWN CAUSE. This function's docblock has always
      // named TWO populations, and they are not the same event:
      //   VERSION SKEW — the key is absent from every slide delta because the
      //     PROPERTY DID NOT EXIST when the document was written. That is LEGAL
      //     LEGACY STATE, not damage; the fill writes the plugin's own default,
      //     which for a new effect is its identity, so the render is
      //     byte-identical and nothing about the document's MEANING changed.
      //   DELETE SENTINEL — some slide explicitly wrote `null` at this path,
      //     removing a key the plugin requires. That is a damaged or hand-edited
      //     document: the author's stored value is gone and the fill substitutes
      //     a default for it, which IS a change of meaning.
      // Only the second is news. Reporting both in one voice is what made every
      // pre-blur deck print a console error per item on load the night
      // `gaussianBlur` joined the effects bundle — the loud channel crying wolf
      // about the routine case, which is precisely how it stops being trusted for
      // the real one. The caller decides what to say; this only records which.
      const deleted = nulls.has(key);
      if (path[0] !== "type" && !coveredByNested && !coveredByNull) missing.push({ path, value, deleted });
    }
    if (missing.length) out.push({ id, slideIndex, missing });
  }
  return out;
}

/**
 * Pure function. Document with every missing default keyframed into the
 * item's CREATION slide (where its type is written), plus the fill report.
 * REPORTING IS THE CALLER'S JOB, and it is SELECTIVE: repairedDocument speaks
 * only for the `deleted` leaves (see missingDefaults). The fill ITSELF is
 * unconditional — a version-skew key is still written, because the strict IR
 * builders must never see an undefined leaf; what changes is that writing the
 * plugin's own default over a key that was never authored is not news.
 * Idempotent: a filled document reports nothing.
 *
 * @example withMissingDefaultsFilled({slides: [{delta: {items: {a: {type: "rect", x: 1}}}}]}, reg).filled.length // 1
 */
export function withMissingDefaultsFilled(doc, registry) {
  const filled = missingDefaults(doc, registry);
  let out = doc;
  for (const { id, slideIndex, missing } of filled)
    for (const { path, value } of missing)
      out = keyframed(out, slideIndex, ["items", id, ...path], value);
  return { doc: out, filled };
}

// ── RETIRED: the dormant-shadow migration (ac98586 → deleted) ────────────────
//
// `dormantShadows` / `withDormantShadowsNeutralized` used to sit here and zero
// any stored shadow with `blur <= 0 && opacity > 0`, on the theory that such a
// shadow could only be a pre-14.8 artifact (the old defaults spread
// {dx:3, dy:3, blur:0, opacity:0.5} onto every item, invisible under the old
// `blur > 0 && opacity > 0` gate, resurrected by the 14.8 opacity-only gate).
//
// IT WAS DELETED BECAUSE IT WAS A MIGRATION THAT NEVER STOPPED MIGRATING. It ran
// on every load, and `blur 0, opacity > 0` is not a legacy shape at all — manifest
// 14.8 makes it the CANONICAL crisp hard-edged shadow ("blur should be allowed to
// be 0 and still visible — but shadow opacity = 0 gates whether we render it"),
// and `shadow.blur`'s default IS 0, so merely raising Shadow opacity authors
// exactly the shape this destroyed. Measured: an authored
// {dx:0, dy:0, blur:0, opacity:0.5} came back from one save/load as opacity 0.
//
// NARROWING IT WAS NOT AVAILABLE. The legacy artifact and a shadow authored today
// are byte-identical objects, so no predicate can separate them — the shape is
// what the current editor writes, unlike every OTHER migration in
// repairedDocument (legacy keys, string text, meta.fps, `duration`, filmstrip
// frame counts, gradient direction, boolean antialias), each of which detects a
// shape the current editor CANNOT produce. That property is exactly what makes
// the others safe to re-run forever, and its absence here was the defect.
//
// A one-shot document version marker was rejected too: `meta` is {name, slideW,
// slideH} with no version concept, none of the seven sibling migrations is
// version-gated, and it would have bought nothing measurable — no document in
// `projects/` (10) or `examples/` (1) carries a dormant shadow, so the migration
// set is empty. The demo fixture was already patched THROUGH the migration at
// ac98586 and is committed in its migrated form.
//
// THE COST OF DELETION, stated plainly: a document saved before 2026-07-15 that
// still carried the old default shadow would show those shadows. That is visible,
// on-canvas, and undone by setting Shadow opacity to 0. Keeping the migration
// cost the user's authored value — data loss. Data loss loses.

/**
 * Pure function. id → the item's CREATION type: the FIRST `type` any slide
 * delta writes for it, in slide order. THE one place the migrations below learn
 * what a partial delta belongs to — a property keyframed on a LATER slide
 * carries no `type`, so a migration that reads `item.type` alone either misses
 * those keyframes or (worse) treats a same-named property on a foreign widget
 * as its own. Every WIDGET-SPECIFIC migration in this file gates on this map.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   Map<string, string> (ids whose type is never written anywhere are ABSENT —
 *   that is the orphan case, repaired by orphanedItems before any migration)
 *
 * @example itemCreationTypes({slides: [{delta: {items: {a: {type: "rect"}}}}, {delta: {items: {a: {x: 5}}}}]}).get("a") // "rect"
 * @example itemCreationTypes({slides: [{delta: {items: {a: {x: 5}}}}]}).has("a") // false (typeless orphan)
 */
export function itemCreationTypes(doc) {
  const typeOf = new Map();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
  return typeOf;
}

/**
 * Pure function. Legacy key renames the document needs: every slide-delta
 * write at items.<id>.<oldKey> where the item's plugin declares
 * `legacyKeys: {oldKey: newKey}` (a top-level-state-key rename map — the
 * declarative, no-type-special-casing seam for schema renames; first user:
 * the arrow's headSize → headLength, manifest Round 11). Runs at the load
 * boundary BEFORE withMissingDefaultsFilled — the fill would otherwise write
 * the new key's default at the creation slide and the user's legacy value
 * would then read as a stale duplicate.
 *
 * `stale: true` marks a slide where BOTH keys are written — there the new
 * key is authoritative and the legacy write is only dropped.
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (.get(type) → plugin with .legacyKeys?)
 *
 * Returns:
 *   {id, slideIndex, from, to, stale}[] (empty when nothing needs renaming)
 *
 * @example legacyKeyRenames({slides: [{delta: {items: {a: {type: "arrow", headSize: 20}}}}]}, reg) // [{id: "a", slideIndex: 0, from: "headSize", to: "headLength", stale: false}]
 * @example legacyKeyRenames({slides: [{delta: {items: {a: {type: "arrow", headLength: 20}}}}]}, reg) // [] (already current)
 */
export function legacyKeyRenames(doc, registry) {
  const typeOf = itemCreationTypes(doc);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object") || !typeOf.has(id)) continue;
      let plugin;
      try {
        plugin = registry.get(typeOf.get(id));
      } catch {
        continue; // unknown type = the orphan case, repaired by orphanedItems
      }
      for (const [from, to] of Object.entries(plugin.legacyKeys ?? {}))
        if (from in item) out.push({ id, slideIndex, from, to, stale: to in item });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy key MOVED to its current name in
 * place (same slide, same item, value verbatim — numbers, equation strings,
 * and null delete-sentinels all survive, so keyframed ANIMATIONS of a renamed
 * property survive too). Where the new key already exists on that slide the
 * legacy write is dropped (the new one is authoritative). REPORTING IS THE
 * CALLER'S JOB (console.error per entry at the load boundary — silent
 * repairs are forbidden). Idempotent: a migrated document reports nothing.
 *
 * @example withLegacyKeysRenamed({slides: [{delta: {items: {a: {type: "arrow", headSize: 20}}}}]}, reg).doc.slides[0].delta.items.a.headLength // 20
 * @example // withLegacyKeysRenamed(currentDoc, reg) → {doc: currentDoc, renamed: []}
 */
export function withLegacyKeysRenamed(doc, registry) {
  const renamed = legacyKeyRenames(doc, registry);
  let out = doc;
  for (const { id, slideIndex, from, to, stale } of renamed) {
    const value = getPath(out.slides[slideIndex].delta, ["items", id, from]);
    out = unkeyframed(out, slideIndex, ["items", id, from]);
    if (!stale) out = keyframed(out, slideIndex, ["items", id, to], value);
  }
  return { doc: out, renamed };
}

/**
 * Pure function. Fancy-arrow fill/stroke value migrations the document needs
 * (manifest Round 17.4, "fancy arrow should have both fill AND stroke"):
 * every fancy_arrow slide-delta write of `stroke` that predates the real
 * `fill` property. Historically `stroke` WAS the tapered polygon's fill color
 * (see plugins/fancy_arrow.js's header) — this is a VALUE migration, not a
 * key rename (both the old and new schema use the key name "stroke", just
 * with a different meaning), so it can't reuse the generic legacyKeys
 * mechanism (which only moves a value from one key name to another). It runs
 * AFTER withLegacyKeysRenamed (so a truly ancient `color`-keyed doc has
 * already converged on `stroke` by the time this reads it) and BEFORE
 * withMissingDefaultsFilled (so the fill-in-progress fancy_arrow items still
 * look "missing fill" to that step and get NOTHING clobbered here — the fill
 * step then supplies the untouched-old-doc's `strokeWidth` default of 0,
 * which is exactly the "no outline until the user adds one" requirement).
 *
 * THE CANDIDATE GATE IS PER-ITEM, NOT PER-SLIDE. An item is a candidate iff it
 * writes `fill` on NO slide — because `fill` did not EXIST on this widget before
 * 17.4 (pre-17.4 defaults: type/z/from/to/tipLength/tipWidth/tipDimple/
 * startWidth/endWidth/stroke/opacity + effects, verified at 11b742a^), so a
 * `fill` written ANYWHERE proves the whole item is already on the new schema.
 * Every slide of such an item is then left alone, and only then is this
 * migration safe to re-run forever (the RETIRED block's criterion: a migration
 * must detect a shape the current editor CANNOT produce).
 *
 * PER-SLIDE WAS DATA LOSS (measured, this defect's whole point). A fancy arrow
 * inserted TODAY writes fill AND stroke on its creation slide; changing Outline
 * on slide 2 commits that ONE leaf, so slide 2's delta is `{stroke: …}` — byte
 * identical to a legacy pre-17.4 write. The per-slide gate rewrote that
 * keyframe to `{fill: …}` on the very next load: the authored outline animation
 * became a BODY animation, permanently, three clicks from a fresh insert
 * (equations included — `{stroke: "= hue(t)"}` moved just as silently).
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (unused — the creation type comes from
 *     the document itself; kept for signature parity with its sibling
 *     migrations and its caller in repairedDocument)
 *
 * Returns:
 *   {id, slideIndex, value}[] (empty when nothing needs migrating)
 *
 * @example fancyArrowFillMigrations({slides: [{delta: {items: {a: {type: "fancy_arrow", stroke: "#ff0000"}}}}]}, reg) // [{id: "a", slideIndex: 0, value: "#ff0000"}]
 * @example fancyArrowFillMigrations({slides: [{delta: {items: {a: {type: "fancy_arrow", fill: "#ff0000", stroke: "#000000"}}}}]}, reg) // [] (already on the new schema)
 * @example // an item whose fill lives on the CREATION slide is exempt on EVERY slide:
 * @example fancyArrowFillMigrations({slides: [{delta: {items: {a: {type: "fancy_arrow", fill: "#f00", stroke: "#000"}}}}, {delta: {items: {a: {stroke: "#0f0"}}}}]}, reg) // []
 */
export function fancyArrowFillMigrations(doc, registry) {
  const typeOf = itemCreationTypes(doc);
  const onNewSchema = new Set(); // ids writing `fill` on ANY slide → post-17.4
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && typeof item === "object" && "fill" in item) onNewSchema.add(id);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object") || typeOf.get(id) !== "fancy_arrow") continue;
      if (!("stroke" in item) || onNewSchema.has(id)) continue;
      out.push({ id, slideIndex, value: item.stroke });
    }
  });
  return out;
}

/**
 * Pure function. Document with every fancy-arrow fill/stroke migration
 * (fancyArrowFillMigrations) applied: the old `stroke` value is COPIED to
 * `fill` on the same slide (preserving the exact appearance — old renders
 * were that color), and the old `stroke` write is deleted (falling back to
 * the plugin's new outline-color default; strokeWidth stays whatever the doc
 * already had, or the missing-defaults fill supplies 0 next — so an
 * un-migrated doc that never set strokeWidth draws NO outline, byte-identical
 * to before). REPORTING IS THE CALLER'S JOB. Idempotent (a migrated item now
 * writes `fill`, and the candidate gate is ITEM-wide, so no slide of it is ever
 * selected again — including the later `stroke`-the-outline keyframes the user
 * adds afterwards).
 *
 * @example withFancyArrowFillMigrated({slides: [{delta: {items: {a: {type: "fancy_arrow", stroke: "#ff0000"}}}}]}, reg).doc.slides[0].delta.items.a.fill // "#ff0000"
 * @example withFancyArrowFillMigrated({slides: [{delta: {items: {a: {type: "fancy_arrow", stroke: "#ff0000"}}}}]}, reg).doc.slides[0].delta.items.a.stroke // undefined (falls back to the plugin default)
 */
export function withFancyArrowFillMigrated(doc, registry) {
  const migrated = fancyArrowFillMigrations(doc, registry);
  let out = doc;
  for (const { id, slideIndex, value } of migrated) {
    out = keyframed(out, slideIndex, ["items", id, "fill"], value);
    out = unkeyframed(out, slideIndex, ["items", id, "stroke"]);
  }
  return { doc: out, migrated };
}

/**
 * Pure function. The lens-flare light-position WORLD point a legacy RELATIVE
 * pair (rel·w, rel·h fractions of the box) corresponds to, given the item's
 * fully-evaluated numeric geometry at the moment of conversion (manifest
 * "world = item transform applied to rel·w, rel·h — mind anchor and
 * rotation"). Reuses core/derive.worldTransform (the SAME local→world map
 * lens_flare.js's own lightLocal/modifierPoints use) rather than
 * reimplementing rotation/anchor math — the house rule against re-deriving a
 * similarity transform by hand.
 *
 * Args:
 *   relX, relY (number): the OLD lightX/lightY fractions
 *   geom (object): evaluated numeric item state {x, y, w, h, rotation?, scale?, rotationAnchor?}
 *
 * Returns:
 *   {x, y}: world coordinates
 *
 * @example // Unrotated 1280x720 box at the origin: world == local fraction*extent.
 * @example flareLightRelativeToWorld(0.72, 0.3, {x: 0, y: 0, w: 1280, h: 720}) // {x: 921.6, y: 216}
 * @example // The SAME box moved to (100, 50): the world point shifts with it — this is
 * @example // the exact reason a per-slide box move needs a per-slide conversion.
 * @example flareLightRelativeToWorld(0.72, 0.3, {x: 100, y: 50, w: 1280, h: 720}) // {x: 1021.6, y: 266}
 */
export function flareLightRelativeToWorld(relX, relY, geom) {
  const w = geom.w ?? 0, h = geom.h ?? 0;
  return T.apply(worldTransform(geom), relX * w, relY * h);
}

/**
 * Pure function. Lens-flare light-position migrations the document needs: the
 * widget's light source used to be stored as lightX/lightY, a [0,1] FRACTION of
 * the widget's own box (relative coordinates); it is now lightWorldX/lightWorldY,
 * an ABSOLUTE point in world/document space (user ruling: "we should just have
 * absolute values... in global coordinate space... if we want to bind those
 * positions to some other object, that's the only way we can really do this
 * easily" — a relative fraction cannot be equation-bound to another item's
 * position). RENAMED, not reinterpreted in place (the fancyArrowFillMigrations
 * precedent: a stored 0.5 meaning "half the box" must never be silently reread
 * as 0.5 world units), so old and new fields never collide and a half-migrated
 * document cannot exist.
 *
 * EVERY CANDIDATE IS A SLIDE-DELTA KEYFRAME, not an item — unlike the fancy-arrow
 * migration's per-ITEM gate, a per-slide conversion is CORRECT here (not data
 * loss) because this is a genuine VALUE migration at each point in time: the
 * widget's box may differ slide to slide (it can move, rotate, resize — even
 * animate via `= camera.*` equations that track a moving camera), so "the world
 * point this fraction names" is itself a function of the slide. Converting once
 * from creation-slide geometry, the fancy-arrow way, would be WRONG the moment a
 * later slide also wrote lightX/lightY against a since-moved box.
 *
 * AN EQUATION ON THE OLD FIELD CANNOT BE UNIT-CONVERTED (manifest requirement):
 * `"= self.w/1000"` names a FORMULA in box-fraction units with no general inverse
 * into world units, so such a keyframe is reported but left ON THE OLD FIELD
 * NAME as-is, renamed nowhere — the field itself no longer exists on the plugin
 * post-migration, so the author sees their equation immediately (an unknown-key
 * report, or simply a look that stopped moving) and fixes it knowingly, rather
 * than the migration guessing and silently producing the wrong light position.
 * isEquationValue(plugin, path, value) is the SAME predicate every other
 * equation-aware migration in this file uses.
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (looks up demo_lens_flare's own plugin
 *     object, needed by evaluateState/isEquationValue, and to fold the item's
 *     equations at each candidate slide)
 *
 * Returns:
 *   {plain: {id, slideIndex, worldX, worldY}[], equation: {id, slideIndex, key, value}[]}
 *   (both empty when nothing needs migrating)
 *
 * @example // A plain relative keyframe at rotation 0: converts to the box's absolute point.
 * @example // Stub registry: a bbox plugin with no lightX/lightY default (today's schema).
 * @example flareLightMigrations({slides: [{delta: {items: {a: {type: "demo_lens_flare", x: 0, y: 0, w: 1000, h: 500, lightX: 0.72, lightY: 0.3}}}}]}, {all: () => [{type: "demo_lens_flare", defaults: {}}], get: () => ({type: "demo_lens_flare", defaults: {}})}).plain
 * [{"id":"a","slideIndex":0,"worldX":720,"worldY":150}]
 * @example // An equation on the old field is reported, not converted.
 * @example flareLightMigrations({slides: [{delta: {items: {a: {type: "demo_lens_flare", x: 0, y: 0, w: 1000, h: 500, lightX: "= self.w/1000"}}}}]}, {all: () => [{type: "demo_lens_flare", defaults: {}}], get: () => ({type: "demo_lens_flare", defaults: {}})}).equation
 * [{"id":"a","slideIndex":0,"key":"lightX","value":"= self.w/1000"}]
 */
export function flareLightMigrations(doc, registry) {
  const typeOf = itemCreationTypes(doc);
  // registry.get() THROWS on an unknown type (a loud guard for a real lookup);
  // a registry without the lens-flare plugin is legitimate here (a focused test
  // registers a handful of plugins, a document with no flare needs no schema
  // check), same "ask the roster" idiom the filmstrip migration above uses.
  const plugin = registry.all().find((p) => p.type === "demo_lens_flare") ?? null;
  const plain = [], equation = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object") || typeOf.get(id) !== "demo_lens_flare") continue;
      if (!plugin) continue; // no lens-flare plugin registered: nothing to migrate against
      const hasX = "lightX" in item, hasY = "lightY" in item;
      if (!hasX && !hasY) continue;
      // An EQUATION on the field THIS SLIDE WRITES cannot be unit-converted (a
      // formula in box-fraction units has no general inverse into world units)
      // — report it and leave that one field's write out of the plain
      // conversion below entirely, per field, not per slide: a slide writing a
      // plain lightX alongside an equation lightY still converts the X half
      // using the OTHER half's current folded value (both cases exercised by
      // the migration fixtures).
      const xIsEq = hasX && isEquationValue(plugin, ["lightX"], item.lightX);
      const yIsEq = hasY && isEquationValue(plugin, ["lightY"], item.lightY);
      if (xIsEq) equation.push({ id, slideIndex, key: "lightX", value: item.lightX });
      if (yIsEq) equation.push({ id, slideIndex, key: "lightY", value: item.lightY });
      // Nothing left to convert this slide: every field it wrote is an equation.
      if ((hasX ? xIsEq : true) && (hasY ? yIsEq : true)) continue;
      // A slide that keyframes only one plain half still needs the OTHER
      // half's CURRENT value to know the full relative point — read from the
      // FOLD (evaluateState over slideState), not the delta alone, exactly
      // like the fancy-arrow migration reads the item's whole state rather
      // than one leaf. If that other half is itself governed by an equation
      // (written on an earlier, un-migrated slide), evaluateState resolves it
      // to the number that equation names AT THIS SLIDE — the correct rel
      // value for this conversion's moment in time, not a case this rule's
      // "no automatic unit conversion" applies to (only a keyframe writing an
      // equation ON THE FIELD BEING MIGRATED is exempted).
      const folded = evaluateState(slideState(doc, slideIndex), registry, doc.meta?.script ?? "").state;
      const geom = folded.items?.[id];
      if (!geom || typeof geom.lightX !== "number" || typeof geom.lightY !== "number") continue;
      const world = flareLightRelativeToWorld(geom.lightX, geom.lightY, geom);
      plain.push({
        id, slideIndex,
        worldX: xIsEq ? undefined : world.x,
        worldY: yIsEq ? undefined : world.y,
      });
    }
  });
  return { plain, equation };
}

/**
 * Pure function. Document with every flareLightMigrations plain conversion
 * applied: each candidate slide gets lightWorldX/lightWorldY keyframed to the
 * converted world point, and lightX/lightY removed from that slide's delta —
 * INCLUDING an equation-carrying field's slide (the equation stays reachable
 * only through the caller's report; the migrated document can no longer write
 * a field the plugin no longer declares). REPORTING IS THE CALLER'S JOB, same
 * convention as withFancyArrowFillMigrated.
 *
 * @example withFlareLightMigrated({slides: [{delta: {items: {a: {type: "demo_lens_flare", x: 0, y: 0, w: 1000, h: 500, lightX: 0.72, lightY: 0.3}}}}]}, {all: () => [{type: "demo_lens_flare", defaults: {}}], get: () => ({type: "demo_lens_flare", defaults: {}})}).doc.slides[0].delta.items.a.lightWorldX
 * 720
 * @example withFlareLightMigrated({slides: [{delta: {items: {a: {type: "demo_lens_flare", x: 0, y: 0, w: 1000, h: 500, lightX: 0.72, lightY: 0.3}}}}]}, {all: () => [{type: "demo_lens_flare", defaults: {}}], get: () => ({type: "demo_lens_flare", defaults: {}})}).doc.slides[0].delta.items.a.lightX
 * undefined
 */
export function withFlareLightMigrated(doc, registry) {
  const { plain, equation } = flareLightMigrations(doc, registry);
  let out = doc;
  for (const { id, slideIndex, worldX, worldY } of plain) {
    // worldX/worldY is `undefined` for the HALF of the pair that was an equation
    // this slide (flareLightMigrations) — that half is handled entirely by the
    // `equation` loop below (dropped, reported), so writing `undefined` here
    // would plant a literal undefined value on the new field instead of leaving
    // it unwritten.
    if (worldX !== undefined) out = keyframed(out, slideIndex, ["items", id, "lightWorldX"], worldX);
    if (worldY !== undefined) out = keyframed(out, slideIndex, ["items", id, "lightWorldY"], worldY);
    out = unkeyframed(out, slideIndex, ["items", id, "lightX"]);
    out = unkeyframed(out, slideIndex, ["items", id, "lightY"]);
  }
  for (const { id, slideIndex, key } of equation) {
    // The equation stays reported forever otherwise (the plugin no longer
    // declares lightX/lightY, so a left-behind equation would silently become
    // an inert, unknown key) — drop it too, LOUDLY, via the caller's report;
    // this only removes the KEY, never converts or invents a replacement value.
    out = unkeyframed(out, slideIndex, ["items", id, key]);
  }
  return { doc: out, plain, equation };
}

/** Pure function. True iff `p` is an objectBoundingBox point {x, y} (finite
 * numbers) — the shape a linear gradient's from/to endpoints have. */
function isBBoxPoint(p) {
  return !!p && typeof p === "object" && typeof p.x === "number" && typeof p.y === "number"
    && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Near-pure helper (mutates the passed `out` accumulator — its whole purpose).
 * Recursively finds every LINEAR-GRADIENT sub-state inside a slide-delta item
 * that still lacks an `angle`. A linear gradient is precisely an object with a
 * `stops` ARRAY and both `from`/`to` POINTS — that gate excludes arrow endpoints
 * (`from`/`to` with NO `stops` sibling) and radial gradients (`center`/`r`, no
 * from/to). Records {relPath, from, to} where relPath locates the gradient
 * object within the item. Recurses into plain-object children only (never into
 * the `stops` array or the {x,y} points), so nested paints (fill.linear,
 * legacy-inline fill, camera background) are all caught. */
function collectLinearGradientsMissingAngle(node, relPath, out) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (Array.isArray(node.stops) && isBBoxPoint(node.from) && isBBoxPoint(node.to) && !("angle" in node))
    out.push({ relPath, from: node.from, to: node.to });
  for (const [k, v] of Object.entries(node))
    if (v && typeof v === "object" && !Array.isArray(v)) collectLinearGradientsMissingAngle(v, [...relPath, k], out);
}

/**
 * Pure function. Linear-gradient DIRECTION migrations the document needs: the
 * gradient direction used to be four discrete presets that stored only
 * objectBoundingBox `from`/`to`; it is now an `angle` in DEGREES (the "angle"
 * property kind — core/properties.js). Every legacy linear gradient (a paint's
 * `linear` sub-state, a legacy-inline linearGradient, or a camera background
 * gradient) that carries from/to but no `angle` is a candidate; the angle is
 * `linearEndpointsToAngle(from, to)`. from/to are LEFT UNTOUCHED (the renderer's
 * parsePaint still reads them), so a migrated document renders byte-identically —
 * the four presets map to exact angles (→ 0°, ↓ 90°, ↘ 45°, ↗ 315°).
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, relPath, angle}[] (empty when nothing needs migrating).
 *   `relPath` is the path to the gradient object WITHIN the item (e.g.
 *   ["fill", "linear"] or ["fill"] for a legacy-inline gradient).
 *
 * @example linearGradientAngleMigrations({slides: [{delta: {items: {a: {type: "rect", fill: {type: "linearGradient", linear: {stops: [{offset:0,color:"#000"},{offset:1,color:"#fff"}], from: {x:0,y:0}, to: {x:1,y:1}}}}}}}]}) // [{id: "a", slideIndex: 0, relPath: ["fill", "linear"], angle: 45}]
 * @example linearGradientAngleMigrations({slides: [{delta: {items: {a: {type: "arrow", from: {x:0,y:0}, to: {x:1,y:1}}}}}]}) // [] (arrow endpoints have no stops — not a gradient)
 */
export function linearGradientAngleMigrations(doc) {
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object") continue;
      const found = [];
      collectLinearGradientsMissingAngle(item, [], found);
      for (const g of found) out.push({ id, slideIndex, relPath: g.relPath, angle: linearEndpointsToAngle(g.from, g.to) });
    }
  });
  return out;
}

/**
 * Pure function. Document with an `angle` (degrees) added beside every legacy
 * linear gradient's from/to (linearGradientAngleMigrations). from/to are kept —
 * the render is byte-identical; the `angle` becomes the authoritative direction
 * the AngleField dial edits going forward. REPORTING IS THE CALLER'S JOB.
 * Idempotent (a gradient that already has `angle` is skipped).
 *
 * @example withLinearGradientAngleMigrated({slides: [{delta: {items: {a: {type: "rect", fill: {type: "linearGradient", linear: {stops: [{offset:0,color:"#000"},{offset:1,color:"#fff"}], from: {x:0,y:0}, to: {x:0,y:1}}}}}}}]}).doc.slides[0].delta.items.a.fill.linear.angle // 90
 * @example withLinearGradientAngleMigrated({slides: [{delta: {items: {a: {type: "rect", fill: {type: "linearGradient", linear: {stops: [{offset:0,color:"#000"},{offset:1,color:"#fff"}], from: {x:0,y:0}, to: {x:1,y:0}, angle: 0}}}}}}]}).migrated.length // 0 (already migrated)
 */
export function withLinearGradientAngleMigrated(doc) {
  const migrated = linearGradientAngleMigrations(doc);
  let out = doc;
  for (const { id, slideIndex, relPath, angle } of migrated)
    out = keyframed(out, slideIndex, ["items", id, ...relPath, "angle"], angle);
  return { doc: out, migrated };
}

/**
 * Pure function. Anti-aliasing BOOLEAN → SELECT migrations the document needs.
 * THE camera's `antialias` used to be a boolean (true = smooth, false = crisp
 * edges); it is now a quality/algorithm SELECT (core/properties.ANTIALIAS_MODES:
 * "off" | "standard"). Every slide-delta item that stores `antialias` as a
 * BOOLEAN is a candidate: true → "standard" (today's coverage-AA look), false →
 * "off" (crisp). A value already a string (migrated / fresh) is skipped.
 *
 * GATED ON THE CAMERA (itemCreationTypes), so an `antialias` keyframed on a
 * non-creation slide is still caught while a same-named property on any FUTURE
 * widget is not. The gate used to be the boolean TYPE alone, on the reasoning
 * that "only the camera carries this property" — true of today's roster, and not
 * a property of the document format at all: a plugin declaring a boolean
 * `antialias` would have had every stored `false` rewritten to the string "off"
 * on load, which is this file's fancy-arrow defect (a per-shape gate standing in
 * for a per-widget one) with a different key name.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, from, to}[] (empty when nothing needs migrating)
 *
 * @example antialiasSelectMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: true}}}}]}) // [{id: "c", slideIndex: 0, from: true, to: "standard"}]
 * @example antialiasSelectMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: false}}}}]}) // [{id: "c", slideIndex: 0, from: false, to: "off"}]
 * @example antialiasSelectMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: "off"}}}}]}) // [] (already a select value)
 * @example antialiasSelectMigrations({slides: [{delta: {items: {r: {type: "rect", antialias: false}}}}]}) // [] (not the camera — not this migration's property)
 */
export function antialiasSelectMigrations(doc) {
  const typeOf = itemCreationTypes(doc);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object" || typeOf.get(id) !== "camera") continue;
      if (typeof item.antialias === "boolean") out.push({ id, slideIndex, from: item.antialias, to: item.antialias ? "standard" : "off" });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy boolean `antialias` rewritten to its
 * SELECT id (antialiasSelectMigrations): true → "standard", false → "off". This
 * preserves each document's intent exactly — a doc that had AA off stays off,
 * one that had it on becomes today's "standard". REPORTING IS THE CALLER'S JOB.
 * Idempotent (a string value is left untouched).
 *
 * @example withAntialiasSelectMigrated({slides: [{delta: {items: {c: {type: "camera", antialias: false}}}}]}).doc.slides[0].delta.items.c.antialias // "off"
 * @example withAntialiasSelectMigrated({slides: [{delta: {items: {c: {type: "camera", antialias: "standard"}}}}]}).migrated.length // 0
 */
export function withAntialiasSelectMigrated(doc) {
  const migrated = antialiasSelectMigrations(doc);
  let out = doc;
  for (const { id, slideIndex, to } of migrated)
    out = keyframed(out, slideIndex, ["items", id, "antialias"], to);
  return { doc: out, migrated };
}

/** The camera render props the dither uprooting retired. Named so the finder, the
 *  dropper and the report all read one list and cannot drift. */
const RETIRED_CAMERA_DITHER_KEYS = ["ditherMode", "ditherEmphasis"];

/**
 * Pure function. Every write of a RETIRED camera dither prop a document still
 * carries: `{id, slideIndex, keys, values}` per slide-delta that has any of them.
 *
 * WHY THIS EXISTS AT ALL, WHEN NO OTHER RETIRED PROPERTY GETS A MIGRATION. The
 * whole-frame camera dither was uprooted (user ruling, 2026-08-07) and its two
 * property rows are gone from core/properties.js. A stale leaf on an item is
 * normally harmless — `withMissingDefaultsFilled` only ADDS, and nothing reads an
 * unknown key — so the tempting answer is to leave them. That is wrong here for a
 * reason specific to this removal: THE DOCUMENTS THAT CARRY THESE KEYS ARE THE
 * DOCUMENTS WHOSE AUTHOR DELIBERATELY TURNED DITHER ON. Leaving `ditherMode:
 * "bayer"` sitting on the camera of a deck that now renders undithered is a stored
 * value that describes a picture the app no longer draws — the author would reopen
 * the deck, see the leaf survive a round-trip through save, and have no way to
 * learn that the control was retired or where it went. Dropping them LOUDLY is the
 * only version that tells them.
 *
 * PER-SLIDE, NOT PER-ITEM, AND THAT IS THE `headMode` CASE RATHER THAN THE
 * FANCY-ARROW ONE. The fancy-arrow migration had to gate per ITEM because the
 * current editor still writes its trigger key, so a keyframe authored today was
 * indistinguishable from a legacy write. These keys are RETIRED: nothing in the
 * editor can produce them any more, so every occurrence on any slide is legacy by
 * construction and each is reported where it sits.
 *
 * IT STILL GATES ON THE CAMERA TYPE, for the reason antialiasSelectMigrations
 * spells out: "only the camera carries this property" is true of today's roster
 * and is not a property of the document format. A future widget with its own
 * `ditherMode` must not have it silently deleted on load.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, keys, values}[] (empty when nothing needs migrating)
 *
 * @example cameraDitherMigrations({slides: [{delta: {items: {c: {type: "camera", ditherMode: "bayer", ditherEmphasis: 15.64}}}}]}) // [{id: "c", slideIndex: 0, keys: ["ditherMode", "ditherEmphasis"], values: {ditherMode: "bayer", ditherEmphasis: 15.64}}]
 * @example cameraDitherMigrations({slides: [{delta: {items: {c: {type: "camera", antialias: "standard"}}}}]}) // [] (nothing to drop)
 * @example cameraDitherMigrations({slides: [{delta: {items: {r: {type: "rect", ditherMode: "bayer"}}}}]}) // [] (not the camera — not this migration's property)
 */
export function cameraDitherMigrations(doc) {
  const typeOf = itemCreationTypes(doc);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object" || typeOf.get(id) !== "camera") continue;
      const keys = RETIRED_CAMERA_DITHER_KEYS.filter((k) => k in item);
      if (keys.length) out.push({ id, slideIndex, keys, values: Object.fromEntries(keys.map((k) => [k, item[k]])) });
    }
  });
  return out;
}

/**
 * Pure function. Document with every retired camera dither leaf REMOVED from the
 * slide deltas that write it (cameraDitherMigrations). REPORTING IS THE CALLER'S
 * JOB. Idempotent — a document with none comes back as the SAME object, which is
 * what keeps `repairedDocument` on a current-schema document reporting zero.
 *
 * DELETES rather than keyframes-to-null: a null would be a DELETED-key write, and
 * withMissingDefaultsFilled reports those loudly as destroyed authored values on
 * every subsequent load. The key must simply cease to exist.
 *
 * @example withCameraDitherDropped({slides: [{delta: {items: {c: {type: "camera", ditherMode: "bayer", x: 1}}}}]}).doc.slides[0].delta.items.c // {type: "camera", x: 1}
 * @example withCameraDitherDropped({slides: [{delta: {items: {c: {type: "camera", x: 1}}}}]}).migrated.length // 0
 */
export function withCameraDitherDropped(doc) {
  const migrated = cameraDitherMigrations(doc);
  if (!migrated.length) return { doc, migrated };
  const bySlide = new Map();
  for (const m of migrated) bySlide.set(`${m.slideIndex} ${m.id}`, m.keys);
  const slides = doc.slides.map((s, slideIndex) => {
    const items = s.delta.items ?? {};
    let touched = false;
    const nextItems = Object.fromEntries(Object.entries(items).map(([id, item]) => {
      const keys = bySlide.get(`${slideIndex} ${id}`);
      if (!keys) return [id, item];
      touched = true;
      const next = { ...item };
      for (const k of keys) delete next[k];
      return [id, next];
    }));
    return touched ? { ...s, delta: { ...s.delta, items: nextItems } } : s;
  });
  return { doc: { ...doc, slides }, migrated };
}

/**
 * Pure function. The `headMode` → `headStart`/`headEnd` migrations a document
 * needs (core/endpoints.js headModeSplit explains WHY the property was split).
 *
 * PER-SLIDE IS CORRECT HERE, and it is worth saying why, because the fancy-arrow
 * migration two hundred lines up learned the opposite lesson the hard way. That
 * one had to gate PER ITEM because the current editor still writes its trigger
 * key (`stroke`), so a keyframe authored today was indistinguishable from a
 * legacy write. `headMode` is RETIRED: nothing in the editor can produce it, so
 * every occurrence is legacy by construction and each one is a genuine value at
 * its own point in time — exactly the flare-light situation, where a per-slide
 * conversion preserves an ANIMATED head rather than destroying it.
 *
 * The eligible types are DERIVED from the registry (the plugins whose defaults
 * carry `headEnd`) rather than listed here, so a fourth head-bearing connector is
 * covered with no list to update — and, more to the point, a future widget that
 * happens to call something `headMode` is not silently rewritten.
 *
 * A value that is not one of the four enum strings — realistically an equation —
 * CANNOT be split, and is reported by the caller and dropped rather than guessed
 * at. `to` is null in that case.
 *
 * Args:
 *   doc (object): document
 *   registry (object): plugin registry (.all() → plugins with .defaults)
 *
 * Returns:
 *   {id, slideIndex, from, to}[] — `to` is {headStart, headEnd} or null
 *
 * @example headModeMigrations({slides: [{delta: {items: {a: {type: "arrow", headMode: "both"}}}}]}, {all: () => [{type: "arrow", defaults: {headEnd: "triangle"}}]}) // [{id: "a", slideIndex: 0, from: "both", to: {headStart: "triangle", headEnd: "triangle"}}]
 * @example headModeMigrations({slides: [{delta: {items: {a: {type: "arrow", headStart: "none", headEnd: "dart"}}}}]}, {all: () => [{type: "arrow", defaults: {headEnd: "triangle"}}]}) // [] (already split — idempotent)
 * @example headModeMigrations({slides: [{delta: {items: {r: {type: "rect", headMode: "end"}}}}]}, {all: () => [{type: "arrow", defaults: {headEnd: "triangle"}}]}) // [] (not a head-bearing connector)
 */
export function headModeMigrations(doc, registry) {
  const typeOf = itemCreationTypes(doc);
  const headBearing = new Set(registry.all().filter((p) => "headEnd" in (p.defaults ?? {})).map((p) => p.type));
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object" || !headBearing.has(typeOf.get(id))) continue;
      if (!("headMode" in item)) continue;
      out.push({ id, slideIndex, from: item.headMode, to: headModeSplit(item.headMode) });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy `headMode` rewritten to the
 * `headStart`/`headEnd` pair that draws the same picture, and the retired key
 * deleted. A value with no split (an equation) drops the key too — the caller
 * reports it, and the pair then falls back to the plugin default, which is a
 * VISIBLE, explained change rather than a formula that silently stopped working.
 * REPORTING IS THE CALLER'S JOB. Idempotent (the key is gone afterwards, and the
 * current editor cannot write it back).
 *
 * @example withHeadModeSplit({slides: [{delta: {items: {a: {type: "arrow", headMode: "both"}}}}]}, {all: () => [{type: "arrow", defaults: {headEnd: "triangle"}}]}).doc.slides[0].delta.items.a.headEnd // "triangle"
 * @example withHeadModeSplit({slides: [{delta: {items: {a: {type: "arrow", headMode: "both"}}}}]}, {all: () => [{type: "arrow", defaults: {headEnd: "triangle"}}]}).doc.slides[0].delta.items.a.headMode // undefined
 */
export function withHeadModeSplit(doc, registry) {
  const migrated = headModeMigrations(doc, registry);
  let out = doc;
  for (const { id, slideIndex, to } of migrated) {
    if (to) {
      out = keyframed(out, slideIndex, ["items", id, "headStart"], to.headStart);
      out = keyframed(out, slideIndex, ["items", id, "headEnd"], to.headEnd);
    }
    out = unkeyframed(out, slideIndex, ["items", id, "headMode"]);
  }
  return { doc: out, migrated };
}

/** The filmstrip state keys that existed ONLY to serve the removed server frame-
 *  extraction endpoint: the fetched still URLs, and the per-frame extraction
 *  resolution that keyed its cache. Nothing reads them now. */
const DEAD_FILMSTRIP_KEYS = ["frameUrls", "frameH", "frameW"];

/**
 * Pure function. The filmstrip FRAMES migrations a document needs. `frames` used to
 * be a COUNT (a number) that a server endpoint turned into N extracted stills; it is
 * now the frames THEMSELVES — a LIST whose one field per element is a TIME in the clip
 * (core/properties.js PROPS.frames, core/lists.js). A numeric `frames` is therefore a
 * legacy value that must become a list of that same LENGTH, so a migrated strip keeps
 * showing the number of frames its author chose.
 *
 * `buildList(n)` is injected rather than imported so this stays in core/ without
 * reaching into a plugin (the default-equation text is the FILMSTRIP's declaration —
 * plugins/filmstrip.defaultFrameList — and repairedDocument passes it through the
 * registry). A filmstrip with no such plugin registered yields no migration rather
 * than an invented list.
 *
 * Also reports the DEAD server-era keys (frameUrls / frameH / frameW) present on the
 * item, so their removal is LOUD rather than a silently ignored leftover.
 *
 * GATED ON THE FILMSTRIP (itemCreationTypes) — `frames` and the dead keys are ITS
 * property names, not the document format's. Ungated, this rewrote ANY widget's
 * numeric `frames` into a 7-element list of video-time equations and deleted any
 * widget's `frameW`/`frameH`/`frameUrls`; the gate is the difference between "a
 * shape the current editor cannot produce" and "a key name nobody has claimed yet".
 *
 * Args:
 *   doc (object): document
 *   buildList (fn): (n) → the n-element default frame list
 *
 * Returns:
 *   {id, slideIndex, count, list, dead}[] (empty when nothing needs migrating)
 *
 * @example filmstripFramesMigrations({slides: [{delta: {items: {f: {type: "filmstrip", frames: 3}}}}]}, (n) => [[n]]) // [{id: "f", slideIndex: 0, count: 3, list: [[3]], dead: []}]
 * @example filmstripFramesMigrations({slides: [{delta: {items: {f: {type: "filmstrip", frames: [[0]]}}}}]}, (n) => [[n]]) // [] (already a list)
 * @example filmstripFramesMigrations({slides: [{delta: {items: {f: {type: "filmstrip", frames: 2, frameUrls: ["a"]}}}}]}, (n) => [[n]])[0].dead // ["frameUrls"]
 * @example filmstripFramesMigrations({slides: [{delta: {items: {r: {type: "rect", frames: 3}}}}]}, (n) => [[n]]) // [] (not a filmstrip — not this migration's property)
 */
export function filmstripFramesMigrations(doc, buildList) {
  const typeOf = itemCreationTypes(doc);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object" || typeOf.get(id) !== "filmstrip") continue;
      const dead = DEAD_FILMSTRIP_KEYS.filter((k) => k in item);
      if (typeof item.frames !== "number") {
        // A slide that only carries dead keys still deserves the report.
        if (dead.length) out.push({ id, slideIndex, count: null, list: null, dead });
        continue;
      }
      const count = Math.max(1, Math.round(item.frames));
      out.push({ id, slideIndex, count, list: buildList(count), dead });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy NUMERIC filmstrip `frames` rewritten to
 * the equivalent-length frame LIST (filmstripFramesMigrations), and the dead
 * server-era keys (frameUrls / frameH / frameW) DELETED from each slide delta.
 * REPORTING IS THE CALLER'S JOB. Idempotent (a list value is left untouched).
 *
 * The dead keys are removed rather than left in place because they are not merely
 * unread: `frameUrls` was the widget's old "do I have frames" signal, so a stale copy
 * riding along in a saved document is a trap for anyone reading it later.
 *
 * @example withFilmstripFramesMigrated({slides: [{delta: {items: {f: {type: "filmstrip", frames: 2}}}}]}, (n) => [[n]]).doc.slides[0].delta.items.f.frames // [[2]]
 * @example withFilmstripFramesMigrated({slides: [{delta: {items: {f: {type: "filmstrip", frames: 2, frameW: 320}}}}]}, (n) => [[n]]).doc.slides[0].delta.items.f.frameW // undefined
 * @example withFilmstripFramesMigrated({slides: [{delta: {items: {f: {type: "filmstrip", frames: [[0]]}}}}]}, (n) => [[n]]).migrated.length // 0
 */
export function withFilmstripFramesMigrated(doc, buildList) {
  const migrated = filmstripFramesMigrations(doc, buildList);
  if (migrated.length === 0) return { doc, migrated };
  let out = doc;
  for (const { id, slideIndex, list } of migrated)
    if (list) out = keyframed(out, slideIndex, ["items", id, "frames"], list);
  // The dead keys are DELETED, which keyframed() cannot express (it writes values),
  // so this rebuilds the affected slide deltas without them.
  const byId = new Map(migrated.filter((m) => m.dead.length).map((m) => [`${m.slideIndex}|${m.id}`, m.dead]));
  if (byId.size === 0) return { doc: out, migrated };
  out = {
    ...out,
    slides: out.slides.map((s, slideIndex) => {
      const items = s.delta?.items;
      if (!items) return s;
      let touched = false;
      const next = {};
      for (const [id, item] of Object.entries(items)) {
        const dead = byId.get(`${slideIndex}|${id}`);
        if (!dead) { next[id] = item; continue; }
        touched = true;
        next[id] = Object.fromEntries(Object.entries(item).filter(([k]) => !dead.includes(k)));
      }
      return touched ? { ...s, delta: { ...s.delta, items: next } } : s;
    }),
  };
  return { doc: out, migrated };
}

/**
 * Pure function. The legacy {item, anchor} endpoint bindings a document still
 * carries — the REPORT half of the binding migration, whose rewriting half is
 * core/expressions.withBindingsMigrated (THE UNIFICATION: a bound endpoint is
 * an equation pair `@<id>_<anchor>.x` / `.y`, not a special stored shape).
 *
 * WHY THIS LIVES HERE AND NOT THERE: that function returns only the document,
 * so it was the ONE step of repairedDocument's order-critical sequence that
 * rewrote the document and pushed NO report — the exact silent repair
 * printRepairReports exists to prevent. This enumerates the same candidates so
 * the step can speak, and repairedDocument CROSS-CHECKS the two against each
 * other (a count here with no rewrite there, or the reverse, throws) so the
 * duplicated predicate cannot drift silently. The tree test is the SAME
 * `isTree` from core/deltas.js that withBindingsMigrated uses.
 *
 * Only an item's TOP-LEVEL keys are bindings (`from`/`to` today), matching the
 * migration's own single-level walk.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, slideIndex, key, target, anchor}[] (empty for a current document)
 *
 * @example legacyBindings({slides: [{delta: {items: {A: {type: "arrow", from: {item: "c1", anchor: "tm"}}}}}]}) // [{id: "A", slideIndex: 0, key: "from", target: "c1", anchor: "tm"}]
 * @example legacyBindings({slides: [{delta: {items: {A: {type: "arrow", from: {x: "@c1_tm.x", y: "@c1_tm.y"}}}}}]}) // [] (already an equation pair)
 * @example legacyBindings({slides: [{delta: {items: {A: {type: "arrow", from: {x: 5, y: 5}}}}}]}) // [] (a free endpoint stays free)
 */
export function legacyBindings(doc) {
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!isTree(item)) continue;
      for (const [key, value] of Object.entries(item))
        if (isTree(value) && typeof value.item === "string" && typeof value.anchor === "string")
          out.push({ id, slideIndex, key, target: value.item, anchor: value.anchor });
    }
  });
  return out;
}

/**
 * RETIRED WIDGET TYPES and the type each becomes on load: `<old> → <new>`.
 *
 * `anchor_point` → `empty` (user, 2026-08-13: "Empties. Replace the anchor
 * widget. I want empties. Full transform, blender-style."). The empty is a strict
 * SUPERSET: it keeps `anchor_point`'s geometry keys (x/y/z/w/h/rotation/scale/
 * rotationAnchor/opacity — the defaults are the same values), keeps its `pt`
 * CENTRE anchor id, and adds the rotation/scale inspector rows and the axis-tip
 * anchors it lacked. So the migration rewrites the TYPE STRING and nothing else,
 * and every stored equation naming the retired widget — `@<itemId>_pt.x`, or
 * `<slug>.pt.y` through the item's name — keeps resolving: the ITEM ID is
 * untouched (it is the delta key, not a value) and the ANCHOR ID is unchanged.
 *
 * A TABLE rather than a special case because a retired type is a shape this
 * codebase will meet again, and the finder/rewriter/report below all read this
 * one map so they cannot drift about which types are retired.
 */
export const RETIRED_ITEM_TYPES = Object.freeze({ anchor_point: "empty" });

/**
 * Pure function. Every write of a RETIRED item type a document still carries:
 * `{id, slideIndex, from, to}` per slide-delta that names one.
 *
 * PER SLIDE, NOT PER ITEM, for cameraDitherMigrations' reason: nothing in the
 * editor can produce a retired type any more, so every occurrence on any slide is
 * legacy by construction. A `type` may legitimately be written on more than one
 * slide (the creation slide plus any that re-state it), so each write is reported
 * where it sits and each is rewritten.
 *
 * @example itemTypeMigrations({slides: [{delta: {items: {a: {type: "anchor_point", x: 5}}}}]}) // [{id: "a", slideIndex: 0, from: "anchor_point", to: "empty"}]
 * @example itemTypeMigrations({slides: [{delta: {items: {a: {type: "empty"}}}}]}) // [] (already current)
 * @example itemTypeMigrations({slides: [{delta: {items: {a: {x: 5}}}}]}) // [] (a keyframe with no type write)
 */
export function itemTypeMigrations(doc) {
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!item || typeof item !== "object") continue;
      const to = RETIRED_ITEM_TYPES[item.type];
      if (to) out.push({ id, slideIndex, from: item.type, to });
    }
  });
  return out;
}

/**
 * Pure function. Document with every retired item type rewritten to its
 * replacement (itemTypeMigrations). REPORTING IS THE CALLER'S JOB. Idempotent — a
 * document with none comes back as the SAME object.
 *
 * It rewrites ONLY the `type` leaf. The retired widget's other keys are the
 * replacement's keys by construction (see RETIRED_ITEM_TYPES); any key the
 * replacement added and the old document lacks is version skew, which
 * withMissingDefaultsFilled already fills at the plugin's own default — the
 * ordinary path, not a special case for this migration.
 *
 * @example withItemTypesMigrated({slides: [{delta: {items: {a: {type: "anchor_point", x: 5}}}}]}).doc.slides[0].delta.items.a // {type: "empty", x: 5}
 * @example withItemTypesMigrated({slides: [{delta: {items: {a: {type: "empty"}}}}]}).migrated.length // 0
 */
export function withItemTypesMigrated(doc) {
  const migrated = itemTypeMigrations(doc);
  if (!migrated.length) return { doc, migrated };
  const slides = doc.slides.map((s, slideIndex) => {
    const items = s.delta.items ?? {};
    let touched = false;
    const nextItems = Object.fromEntries(Object.entries(items).map(([id, item]) => {
      const to = item && typeof item === "object" ? RETIRED_ITEM_TYPES[item.type] : undefined;
      if (!to) return [id, item];
      touched = true;
      return [id, { ...item, type: to }];
    }));
    return touched ? { ...s, delta: { ...s.delta, items: nextItems } } : s;
  });
  return { doc: { ...doc, slides }, migrated };
}

// ── The load-boundary repair pipeline (ONE home) ─────────────────────────────
// Both consumers of load-time repair — the editor (app.repaired via loadFile /
// loadAutosave / loadProject / deleteSlide) and the CLI render hook
// (web/main.js) — went through hand-copied chains that DRIFTED (the editor
// stripped legacy meta.fps, the CLI did not — cruft audit 2a). This is the
// single orchestrator; both callers consume {doc, reports} and print with
// printRepairReports so the console.error FORMAT strings live in exactly one
// place. Every step is a pure repair function already covered by repair_test.js;
// this composes them in the ORDER-CRITICAL sequence and collects the report.

/**
 * Pure function. The full load-boundary repair of `doc` against the plugin
 * `registry`, plus the human-readable report of everything it changed
 * (REPORTING IS THE CALLER'S JOB — this never touches console; printRepairReports
 * does). Returns {doc, reports: string[]}. Idempotent: a current document comes
 * back unchanged with reports = [].
 *
 * ORDER (every step is order-critical — do not reshuffle):
 *   0. retired item types renamed — MUST precede the orphan drop: a retired type
 *      is absent from the registry, so the orphan step would PURGE the item and
 *      every equation bound to it (withItemTypesMigrated).
 *   1. orphaned items dropped   — a typeless/unknown item must go before any
 *      later step reads its (missing) type; keeps the fold renderable.
 *   2. legacy key renames       — MUST precede defaults-fill: filling first
 *      writes the new key's default at the creation slide and the rename then
 *      drops the user's legacy value as stale (data loss — repair_test.js
 *      "legacy rename ORDER").
 *  2b. fancy-arrow fill migrated — MUST run AFTER legacy key renames (a
 *      `color`-keyed ancient doc needs to have already converged on `stroke`)
 *      and BEFORE defaults-fill (same hazard class as rich text below: fill
 *      first and the old `stroke`-as-fill value would already be gone,
 *      replaced by the fill default, before this step could read it).
 *  2c. antialias boolean→select — the camera's `antialias` boolean became a
 *      quality SELECT (true→"standard", false→"off"). A VALUE migration; the key
 *      is present either way so its order vs defaults-fill is not load-bearing.
 * 2c1. retired camera dither DROPPED — the whole-frame camera dither was uprooted
 *      (2026-08-07) and its `ditherMode`/`ditherEmphasis` leaves are removed from
 *      any camera delta still carrying them, LOUDLY. A pure removal with no
 *      ordering hazard either way (it reads nothing the fill writes and writes
 *      nothing the fill reads); grouped with its value-migration peers.
 * 2c2. lens-flare light RELATIVE→WORLD — lightX/lightY (a [0,1] fraction of the
 *      widget's box) renamed AND reinterpreted as lightWorldX/lightWorldY (an
 *      absolute world/document point), converted per-slide through the item's
 *      OWN transform at that slide (core/derive.worldTransform) so a moved,
 *      rotated, or per-slide-resized flare converts correctly at every
 *      keyframe. MUST precede defaults-fill (below) for the filmstrip step's
 *      exact reason: filling first would inject the new fields' equation
 *      default before this step could read the user's old fraction. An old
 *      field carrying an EQUATION cannot be unit-converted and is reported,
 *      not rewritten.
 *  2d. meta.script normalized  — THE PROJECT SCRIPT is filled to "" when absent
 *      (quietly — an old deck has no library and an empty one means the same) and
 *      DISCARDED loudly when it is not a string. meta-only, order-free.
 * 2d2. meta.varKinds normalized — THE GLOBAL VARIABLE KINDS map (core/var_kinds.js)
 *      is filled to {} when absent (quietly, meta.script's rule: every deck written
 *      before kinds existed has all-number variables and an empty map means exactly
 *      that) and its BAD ENTRIES are dropped LOUDLY — an unknown kind changes how a
 *      variable is EDITED, so it can never vanish in silence. No variable's VALUE is
 *      touched either way, which is what the report says. meta-only, order-free.
 *   3. meta.fps stripped        — frame caps are dead (round 11); meta-only, so
 *      its position among the item/slide steps is free — placed here to match
 *      the editor's long-tested sequence.
 *   4. missing defaults filled  — typed-but-partial items get plugin defaults so
 *      the strict IR builders never see w: undefined. FILLED ALWAYS, REPORTED
 *      ONLY WHEN DELETED: a key absent because it postdates the document is
 *      version skew (legal legacy state, filled at the plugin's identity value,
 *      byte-identical render) and stays QUIET, the meta.script precedent; a key
 *      a slide explicitly NULLED destroyed an authored value and is LOUD.
 *   5. duration → transition    — legacy per-slide `duration` becomes
 *      transition.seconds (round 12).
 *   6. camera ensured + deduped — a doc predating the camera (or one whose
 *      camera was orphaned away in step 1) gets THE camera injected; then any
 *      EXTRA cameras (hand-authored/damaged docs) are loud-dropped so exactly
 *      one survives (the camera invariant is exactly one — THE CAMERA).
 *  6b. gradient direction → angle — legacy linear gradients (4-preset from/to)
 *      get an `angle` (degrees) added beside their from/to; from/to untouched
 *      (byte-identical render). AFTER camera dedup so a camera-background
 *      gradient on the surviving camera is migrated too.
 *   7. bindings migrated        — legacy {item, anchor} arrow bindings become
 *      equation pairs (THE UNIFICATION); runs LAST, on the now-clean doc. Its
 *      rewriter (core/expressions.js) reports nothing on its own, so the
 *      candidates are enumerated HERE (legacyBindings) and cross-checked
 *      against it — this step used to be the one silent rewrite in the chain.
 *
 * @example // repairedDocument(newDocument(), registry) → {doc: <equivalent>, reports: []}
 * @example // a doc with meta.fps → reports includes "PowerRP repair: removed legacy meta.fps — presentations are always uncapped"
 */
export function repairedDocument(doc, registry) {
  const reports = [];
  const known = new Set(registry.all().map((p) => p.type));

  // RETIRED TYPES FIRST, BEFORE THE ORPHAN DROP, AND THAT ORDER IS THE WHOLE
  // MIGRATION. A retired type is by definition not in the registry, so the orphan
  // step would classify every one of them as `unknown type "anchor_point"` and
  // PURGE the item — silently destroying a widget the user still has, along with
  // every equation bound to it, while reporting only that something unknown was
  // dropped. Renaming first means the orphan step meets a type it knows.
  const { doc: typedDoc, migrated: typeMigrated } = withItemTypesMigrated(doc);
  for (const m of typeMigrated)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: retired type "${m.from}" → "${m.to}" — the anchor point is now an EMPTY (a full blender-style transform: rotation and scale on top of the position it had). Its "${m.id}_pt" anchor id is unchanged, so every equation bound to it still resolves`);

  const { doc: droppedDoc, dropped } = withOrphanedItemsDropped(typedDoc, known);
  for (const { id, reason } of dropped)
    reports.push(`PowerRP repair: dropped item "${id}" — ${reason}`);

  const { doc: renamedDoc, renamed } = withLegacyKeysRenamed(droppedDoc, registry);
  for (const r of renamed)
    reports.push(`PowerRP repair: item "${r.id}" slide ${r.slideIndex}: legacy "${r.from}" → "${r.to}"${r.stale ? " (stale copy dropped)" : ""}`);

  // Fancy-arrow fill migration (Round 17.4): `stroke` was misused as the fill
  // color — move its value to the new `fill` property so old arrows keep
  // their EXACT appearance; the new `stroke` falls back to the plugin's
  // outline-color default with strokeWidth 0 (no outline) via the fill step
  // below, so an un-migrated doc renders byte-identical.
  const { doc: fillMigratedDoc, migrated: fancyArrowFilled } = withFancyArrowFillMigrated(renamedDoc, registry);
  for (const m of fancyArrowFilled)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy fancy-arrow "stroke" (fill color) → "fill"; "stroke" now means outline`);

  // Anti-aliasing BOOLEAN → SELECT: the camera's `antialias` used to be a boolean
  // (true = smooth, false = crisp) and is now a quality SELECT (ANTIALIAS_MODES).
  // true → "standard", false → "off", preserving each document's exact intent.
  // A VALUE migration (like fancy-arrow fill above), so it runs here with the
  // other value migrations — the key is present either way, so its order vs the
  // defaults-fill below is not load-bearing; grouped with its peers for clarity.
  const { doc: aaMigratedDoc, migrated: antialiasMigrated } = withAntialiasSelectMigrated(fillMigratedDoc);
  for (const m of antialiasMigrated)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy boolean antialias (${m.from}) → "${m.to}"`);

  // RETIRED camera dither leaves DROPPED (user ruling, 2026-08-07: the whole-frame
  // camera dither is uprooted; dithering is a PAINT property now). A pure REMOVAL,
  // so it has no ordering hazard against the defaults-fill below in either
  // direction: it neither reads a value the fill would overwrite nor writes one the
  // fill would read. Placed with the other value migrations so the whole legacy
  // chain stays in one readable run.
  const { doc: ditherDroppedDoc, migrated: cameraDitherDropped } = withCameraDitherDropped(aaMigratedDoc);
  for (const m of cameraDitherDropped)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: dropped retired camera dither ${m.keys.map((k) => `${k}=${JSON.stringify(m.values[k])}`).join(", ")} — the whole-frame camera dither was removed; dithering is now a PAINT property, set per gradient in the Inspector's Fill/Stroke editor`);

  // Arrow `headMode` (one enum over BOTH ends) SPLIT into the per-end head SHAPE
  // pair headStart/headEnd. A VALUE migration with a 1→2 split, so it cannot use
  // the declarative legacyKeys seam (that only moves a value between key names),
  // and it sits with its value-migration peers. It MUST precede the defaults-fill
  // below for the filmstrip step's exact reason: filling first would write the
  // new pair's DEFAULT over the slide before this step could read the old enum,
  // silently resetting every migrated arrow to one plain triangle.
  const { doc: headDoc, migrated: headModeMigrated } = withHeadModeSplit(ditherDroppedDoc, registry);
  for (const m of headModeMigrated)
    reports.push(m.to
      ? `PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy headMode "${m.from}" → headStart "${m.to.headStart}" + headEnd "${m.to.headEnd}"; each end now picks its own head SHAPE`
      : `PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy headMode carries ${JSON.stringify(m.from)}, which is not one of none/start/end/both — cannot split a formula across two ends, so it is DROPPED and both ends fall back to the plugin default; set headStart/headEnd by hand`);

  // Lens-flare light position RELATIVE → WORLD (user ruling: absolute-only, so
  // an equation can bind it to another item's position). A VALUE migration with
  // a RENAME (lightX/lightY → lightWorldX/lightWorldY — never reinterpreted in
  // place, the fancyArrowFillMigrations precedent), so it belongs with its value-
  // migration peers here; MUST precede defaults-fill below for the identical
  // reason the filmstrip step does — filling first would inject the new fields'
  // equation DEFAULT before this step could read the user's old fraction.
  const { doc: flareDoc, plain: flareMigrated, equation: flareEquations } = withFlareLightMigrated(headDoc, registry);
  for (const m of flareMigrated)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy relative lens-flare light position → lightWorldX/lightWorldY (${m.worldX}, ${m.worldY})`);
  for (const m of flareEquations)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy lens-flare "${m.key}" carries an EQUATION (${JSON.stringify(m.value)}) — cannot auto-convert a formula's units; fix it by hand, it no longer has an effect`);

  // Filmstrip `frames` COUNT → the frame LIST (same length), and the dead server-era
  // keys dropped. A VALUE migration, so it sits with its peers above — but it MUST
  // precede the defaults-fill below for the rich-text hazard's exact reason: filling
  // first would write the LIST default over the user's numeric count before this step
  // could read it, silently resetting every migrated strip to the default frame count.
  // The default-equation text belongs to the FILMSTRIP's own declaration, so it comes
  // from the plugin through the registry rather than being restated in core/.
  // registry.get() THROWS on an unknown type (a loud guard for a real lookup), and a
  // registry without the filmstrip is legitimate here — a focused test registers three
  // plugins, and a document with no filmstrip needs no builder — so this asks the
  // roster instead of catching.
  const framesListOf = registry.all().find((p) => p.type === "filmstrip")?.defaultFrameList ?? null;
  const { doc: framesDoc, migrated: framesMigrated } = framesListOf
    ? withFilmstripFramesMigrated(flareDoc, framesListOf)
    : { doc: flareDoc, migrated: [] };
  for (const m of framesMigrated) {
    if (m.count !== null)
      reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy filmstrip frame COUNT (${m.count}) → a ${m.count}-element frame list, each frame's time an equation across Video start → Video end`);
    if (m.dead.length)
      reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: dropped dead filmstrip key(s) ${m.dead.join(", ")} — frames are decoded in the browser now, not fetched from the server frames endpoint`);
  }

  // Mandelbrot palette -> the shared colour RAMP (core/ramps.js): the `palette`
  // select plus the `paletteStops` text override collapse into one `rampStops` list.
  // A VALUE migration with a TYPE change, so it cannot use the declarative
  // legacyKeys seam — that only moves a value between key names, which is why the
  // sibling rename `paletteOffset` -> `rampPhase` DOES go through it.
  //
  // POSITION IS LOAD-BEARING, for the same reason the filmstrip step above is: it
  // must run BEFORE withMissingDefaultsFilled, so a document whose only palette
  // write is on a later slide gets its creation-slide default ramp from the fill
  // rather than from here.
  //
  // AND IT MUST FOLD, which projects/Fractals proved: slide 1 sets a stops
  // override, slide 2 sets `palette: "ember"` — which the still-folded override
  // SHADOWS, so slide 2 was never ember. A per-slide conversion gets that wrong.
  const { doc: rampDoc, migrated: rampsMigrated } = withPaletteRampMigrated(framesDoc);
  for (const line of rampMigrationReports(rampsMigrated)) reports.push(line);

  let out = rampDoc;

  // THE PROJECT SCRIPT's meta field (core/project_script.js). Normalized here so
  // every consumer downstream reads a plain string and none needs an undefined
  // branch. TWO cases, deliberately reported DIFFERENTLY:
  //
  //   ABSENT → filled with "" and NOT reported. Every document written before the
  //     project script existed lacks the key, so reporting it would print a line
  //     for every old deck on every load while describing no change to the render
  //     and no data lost — the "silent repairs are forbidden" rule exists to
  //     surface CHANGES TO MEANING, and an empty library means exactly what no
  //     library meant. (An absent key is also the ONE case here that is expected,
  //     which is the bar for staying quiet.)
  //   WRONG TYPE → the value is DISCARDED, and that is loud: a non-string script is
  //     a damaged or hand-edited document, the discard destroys whatever was there,
  //     and it must never look like the author's code simply stopped working.
  if (typeof out.meta.script !== "string") {
    if ("script" in out.meta)
      reports.push(`PowerRP repair: meta.script was ${typeof out.meta.script}, not a string — discarded; the project script is one JavaScript source string`);
    out = { ...out, meta: { ...out.meta, script: "" } };
  }

  // THE GLOBAL VARIABLE KINDS map (core/var_kinds.js). Same two-case shape as
  // meta.script above and for the same reasons: ABSENT is filled quietly (an old
  // deck's variables are all numbers, and an empty map says precisely that), a
  // DAMAGED entry is dropped loudly. The rules live in var_kinds.js so the panel
  // and the repair cannot disagree about what a legal kind is.
  {
    const { varKinds, dropped } = repairedVarKinds(out.meta.varKinds);
    for (const d of dropped)
      reports.push(d.name == null
        ? `PowerRP repair: ${d.reason} — discarded; every variable falls back to Number (no variable's VALUE was touched)`
        : `PowerRP repair: variable "${d.name}" declared kind ${JSON.stringify(d.kind)}, ${d.reason} — dropped; it edits as a Number now (its VALUE is unchanged)`);
    if (dropped.length || !out.meta.varKinds) out = { ...out, meta: { ...out.meta, varKinds } };
  }

  if ("fps" in out.meta) {
    const meta = { ...out.meta };
    delete meta.fps;
    out = { ...out, meta };
    reports.push("PowerRP repair: removed legacy meta.fps — presentations are always uncapped");
  }

  // Rich text BEFORE defaults-fill (order-critical, Opus21's proven hazard:
  // filling first clobbers an old string-`text` to the rich DEFAULT "Text" —
  // the string must become runs while it is still the user's string).
  const { doc: richDoc, migrated: richMigrated } = withRichTextMigrated(out, (t) => registry.get(t)?.richText === true || t === "text");
  for (const m of richMigrated)
    reports.push(`PowerRP repair: item "${m.id}" slide ${m.slideIndex}: legacy string text → rich runs`);

  // THE FILL IS UNCONDITIONAL; THE REPORT IS NOT. Every missing leaf is written
  // (the strict IR builders must never meet an undefined), but only the DELETED
  // ones — a slide's explicit `null` at a required key — are announced. A leaf
  // that is merely ABSENT is version skew: the property did not exist when the
  // document was written, absence is legal legacy state under this codebase's
  // absent-is-legacy discipline, and the fill writes the plugin's own default,
  // which for every effect in the bundle is its IDENTITY value — the render is
  // byte-identical and no authored value was touched. This is the meta.script
  // precedent applied to items ("filled with '' when absent, quietly — an old
  // deck has no library and an empty one means the same"), and the ABSENCE of it
  // here is what made the night `gaussianBlur` joined the effects bundle print a
  // console error PER ITEM for every deck ever saved. That is not the loud
  // channel doing its job; it is the loud channel drowning itself, and it reds
  // the probes whose console gates exist to catch genuine repair noise.
  //
  // MALFORMED VALUES ARE UNAFFECTED and stay loud: this step is about a key that
  // is not there, not about one carrying garbage. A non-number `gaussianBlur` is
  // WRITTEN, so it is never "missing" — it flows on to the expression/validation
  // seam that reports bad values by name.
  const { doc: filledDoc, filled } = withMissingDefaultsFilled(richDoc, registry);
  for (const { id, missing } of filled) {
    const deleted = missing.filter((m) => m.deleted);
    if (deleted.length)
      reports.push(`PowerRP repair: item "${id}" had ${deleted.map((m) => m.path.join(".")).join(", ")} DELETED (written as null) — a required key, restored to the plugin default`);
  }

  // NO SHADOW STEP HERE. The dormant-shadow migration that used to sit between
  // the fill and the duration migration was deleted — see the RETIRED block above
  // withMissingDefaultsFilled for why (it destroyed authored crisp shadows).

  const { doc: migratedDoc, migrated } = withDurationMigrated(filledDoc);
  for (const m of migrated)
    reports.push(`PowerRP repair: slide ${m.index} legacy "duration" (${m.seconds}s) → transition.seconds${m.stale ? " (already had a transition — stale duration dropped)" : ""}`);

  // Camera invariant (THE CAMERA): ensure at least one, then drop any extras
  // loudly so exactly one survives (withCameraEnsured only ever ADDS — it never
  // dedupes a doc that already has several cameras).
  const { doc: cameraDeduped, dropped: extraCameras } = withExtraCamerasDropped(withCameraEnsured(migratedDoc));
  for (const id of extraCameras)
    reports.push(`PowerRP repair: dropped extra camera "${id}" — a document has exactly one camera (THE CAMERA); kept the first by id`);

  // Linear-gradient direction (4 presets) → an `angle` (degrees). from/to are
  // kept, so the render is byte-identical; the angle becomes the value the new
  // rotary dial edits (core/properties.js angle math; web/AngleField.svelte).
  const { doc: gradientDoc, migrated: gradientAngles } = withLinearGradientAngleMigrated(cameraDeduped);
  for (const { id, slideIndex, relPath, angle } of gradientAngles)
    reports.push(`PowerRP repair: item "${id}" slide ${slideIndex}: legacy linear-gradient direction (${relPath.join(".")}) → angle ${angle}°`);

  // Legacy {item, anchor} bindings → equation pairs (THE UNIFICATION). The
  // rewrite lives in core/expressions.js and returns the document ALONE, so the
  // candidates are enumerated here (legacyBindings) to give this step the report
  // every other step has. The two are cross-checked rather than trusted: they
  // are separate copies of one predicate, so a drift between them must be LOUD
  // (this step's whole defect was changing a document with nothing to show for
  // it — a wrong report is not an acceptable replacement for a missing one).
  const bindings = legacyBindings(gradientDoc);
  const boundDoc = withBindingsMigrated(gradientDoc);
  const rewrote = boundDoc !== gradientDoc; // withBindingsMigrated returns the SAME object when it changes nothing
  if (rewrote !== (bindings.length > 0))
    throw new Error(`Binding migration disagreement: legacyBindings found ${bindings.length} candidate(s) but withBindingsMigrated ${rewrote ? "did" : "did NOT"} rewrite the document — core/document.legacyBindings and core/expressions.withBindingsMigrated have drifted apart`);
  for (const b of bindings)
    reports.push(`PowerRP repair: item "${b.id}" slide ${b.slideIndex}: legacy "${b.key}" binding {item: "${b.target}", anchor: "${b.anchor}"} → equation pair @${b.target}_${b.anchor}.x / .y`);

  return { doc: boundDoc, reports };
}

/**
 * Command (console side effect). console.errors each repair report line. The
 * ONE printer both repair consumers call — silent repairs are forbidden, and
 * the format strings live in repairedDocument, so this stays trivial.
 *
 * @example // printRepairReports(["PowerRP repair: dropped item \"a\" — …"]) → console.errors the one line
 */
export function printRepairReports(reports) {
  for (const line of reports) console.error(line);
}

// ── Slide edits ──────────────────────────────────────────────────────────────

/** Pure function. Inserts an empty slide after `index`. Returns [doc, newIndex].
 * The new slide gets the default tween transition (seconds = the old default
 * duration, curve "smooth") — new decks feel identical to the pre-transitions
 * era (lead ruling, Round 12). */
export function withNewSlide(doc, index) {
  const slide = { id: uuid(), name: `Slide ${doc.slides.length + 1}`, transition: defaultTransition("tween"), delta: {} };
  const slides = [...doc.slides];
  slides.splice(index + 1, 0, slide);
  return [{ ...doc, slides }, index + 1];
}

/** Pure function. Removes slide `index` (refuses to remove the last slide). */
export function withSlideDeleted(doc, index) {
  if (doc.slides.length <= 1) throw new Error("Cannot delete the only slide");
  const slides = doc.slides.filter((_, i) => i !== index);
  return { ...doc, slides };
}

/**
 * Pure function. Renames slide `index`. A blank/whitespace name restores the
 * positional default ("Slide N") rather than storing emptiness — clearing the
 * field is how the user says "back to the default", and a stored "" would
 * render an unlabelled row. Throws on an out-of-range index (loud, never a
 * silent no-op on a bad caller).
 *
 * @param {object} doc - the document
 * @param {number} index - slide index to rename
 * @param {string} name - the new display name
 * @returns {object} a new document
 *
 * @example withSlideRenamed({slides: [{name: "Slide 1"}]}, 0, "Intro").slides[0].name // "Intro"
 * @example withSlideRenamed({slides: [{name: "Old"}, {name: "B"}]}, 0, "   ").slides[0].name // "Slide 1"
 */
export function withSlideRenamed(doc, index, name) {
  if (!(index >= 0 && index < doc.slides.length))
    throw new Error(`withSlideRenamed: slide index ${index} out of range (0..${doc.slides.length - 1})`);
  const trimmed = String(name).trim();
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, name: trimmed || `Slide ${index + 1}` } : s);
  return { ...doc, slides };
}

/** Pure function. Toggles a slide's enabled flag (default true → false). */
export function withSlideToggled(doc, index) {
  const slides = doc.slides.map((s, i) =>
    i === index ? { ...s, enabled: s.enabled === false } : s);
  return { ...doc, slides };
}

/**
 * Pure function. Moves slide `index` by `offset` (clamped) — THE RAW SPLICE,
 * which moves the slide's DELTA and therefore CHANGES WHAT THE DECK LOOKS LIKE.
 *
 * **NOT THE UI's MOVE, and must never be wired back to one.** A slide stores a
 * difference from the slide before it, so relocating that difference makes it
 * say something else in its new position — the user-reported defect "when I move
 * slide up and move slide down, it does like change way more than I bargained
 * for" (2026-08-02). `core/slide_reorder.js movedSlidePreservingLook` is what
 * `app.moveSlide` calls: it folds first, permutes the folded sequence, and
 * re-derives every delta so only the ORDER changes.
 *
 * KEPT because the raw splice is exactly the right tool for building a document
 * whose deltas are deliberately out of order — `tests/expressions_test.js`
 * splices a creation slide BELOW its own keyframes to pin the imaginary-slide
 * semantics (a typeless item is skipped, not an error), and an
 * appearance-preserving move cannot produce that document by construction.
 *
 * @example withSlideMoved({slides: [{id: "a"}, {id: "b"}]}, 0, 1).slides[0].id // "b"
 * @example withSlideMoved({slides: [{id: "a"}]}, 0, -1).slides[0].id // "a" (clamped: no-op)
 */
export function withSlideMoved(doc, index, offset) {
  const to = Math.max(0, Math.min(doc.slides.length - 1, index + offset));
  if (to === index) return doc;
  const slides = [...doc.slides];
  const [s] = slides.splice(index, 1);
  slides.splice(to, 0, s);
  return { ...doc, slides };
}

/**
 * Pure function. Ensures the document has THE camera (docs saved before the
 * camera existed lack one — loading such a doc injects the default camera
 * into slide 0's delta, sized to the meta slide rect).
 *
 * @example // withCameraEnsured(preCameraDoc).slides[0].delta.items now has a camera
 */
export function withCameraEnsured(doc) {
  for (const s of doc.slides)
    for (const item of Object.values(s.delta.items ?? {}))
      if (item && item.type === "camera") return doc;
  const cameraId = uuid();
  return keyframed(doc, 0, ["items", cameraId], defaultCameraState(doc.meta));
}

/**
 * Pure function. Enforces the AT-MOST-ONE half of the camera invariant (THE
 * CAMERA — manifest: "exactly one, purgeable:false"). withCameraEnsured
 * guarantees at least one camera; this keeps the FIRST camera item (by id,
 * matching cameraRect's deterministic pick) and purges every other camera from
 * every slide, returning the deduped doc + the ids it dropped. REPORTING IS
 * THE CALLER'S JOB — the repair never hides anything (mirrors
 * withOrphanedItemsDropped). Idempotent; a normal single-camera doc comes back
 * byte-identical with dropped = [].
 *
 * An id counts as a camera if ANY slide delta sets its type to "camera" (the
 * creation keyframe on slide 0 for a well-formed doc; a hand-authored or
 * damaged doc may carry several).
 *
 * @example withExtraCamerasDropped({slides: [{delta: {items: {a: {type: "camera"}, b: {type: "camera"}}}}]}).dropped // ["b"]
 * @example // withExtraCamerasDropped(singleCameraDoc) → {doc: <unchanged>, dropped: []}
 */
export function withExtraCamerasDropped(doc) {
  const cameraIds = new Set();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && item.type === "camera") cameraIds.add(id);
  const dropped = [...cameraIds].sort((a, b) => (a < b ? -1 : 1)).slice(1);
  let out = doc;
  for (const id of dropped) out = withItemPurged(out, id);
  return { doc: out, dropped };
}

// ── Z-order maintenance ──────────────────────────────────────────────────────
// UI reorder ops set z to the midpoint between neighbors (bisect), then this
// renormalizes every KEYFRAMED z document-wide to 1, 2, 3... (order-preserving
// over the set of distinct stored values) so bisection never runs out of
// precision. A tweened in-between z is DERIVED, never written to the document,
// so it is never normalized (this is the "not persisted" sense of transient —
// nothing to do with the four kinds of state in CLAUDE.md).

/** Pure function. Document with all stored z keyframes renormalized to 1..N. */
export function withNormalizedZ(doc) {
  const zs = new Set();
  for (const s of doc.slides)
    for (const [path, value] of leaves(s.delta))
      if (path[path.length - 1] === "z" && typeof value === "number") zs.add(value);
  const sorted = [...zs].sort((a, b) => a - b);
  const map = new Map(sorted.map((z, i) => [z, i + 1]));
  const slides = doc.slides.map((s) => {
    let delta = s.delta;
    for (const [path, value] of leaves(s.delta))
      if (path[path.length - 1] === "z" && map.has(value)) delta = setPath(delta, path, map.get(value));
    return { ...s, delta };
  });
  return { ...doc, slides };
}

/**
 * Pure function. New z for an item moved one step forward/backward among the
 * given z-ascending [itemId, z] pairs — midpoint with the far neighbor
 * (bisect), or ±1 past the end.
 *
 * @example bisectedZ([["a",1],["b",2],["c",3]], "a", +1) // 2.5 (between b and c)
 * @example bisectedZ([["a",1],["b",2]], "b", +1) // 3 (already frontmost: past end)
 * @example bisectedZ([["a",1],["b",2],["c",3]], "c", -1) // 1.5
 */
export function bisectedZ(pairs, itemId, direction) {
  const i = pairs.findIndex(([id]) => id === itemId);
  if (i === -1) throw new Error(`bisectedZ: unknown item ${itemId}`);
  const j = i + direction;
  if (j < 0) return pairs[0][1] - 1;
  if (j >= pairs.length) return pairs[pairs.length - 1][1] + 1;
  const k = j + direction;
  if (k < 0) return pairs[0][1] - 1;
  if (k >= pairs.length) return pairs[pairs.length - 1][1] + 1;
  return (pairs[j][1] + pairs[k][1]) / 2;
}

/**
 * Pure function. New z values for a BLOCK of items moved together to the front
 * (direction +1) or back (−1) of everything else, PRESERVING the block's
 * internal relative order (manifest 15.7: "when i move a group to front or back
 * it should move all elements in it to front or back too" — a group and its
 * members travel as ONE block; members keep their relative z within it, the
 * block lands above/below every non-block item).
 *
 * The block members are ordered by their CURRENT z (ascending) so their
 * relative stacking survives the move; they are then assigned consecutive z
 * values placed entirely beyond the extreme of the NON-block items (max+1,
 * max+2, … for front; min−1, min−2, … in reverse for back, so the block's
 * TOP stays on top). withNormalizedZ re-packs the whole document to integers
 * afterward, so the fractional/large intermediate spacing is safe. Returns
 * [[itemId, newZ]] only for the block ids (unknown block ids are skipped, not
 * an error — a member absent on this slide simply isn't reassigned). An empty
 * scene (no non-block items) still returns a valid ascending block.
 *
 * @example blockZToExtreme([["g",3],["a",1],["b",2],["x",5]], ["g","a","b"], +1) // [["a",6],["b",7],["g",8]] (block ordered by z, all above x's 5)
 * @example blockZToExtreme([["g",3],["a",1],["b",2],["x",5]], ["g","a","b"], -1) // [["a",2],["b",3],["g",4]] (block all below x's 5, relative order a<b<g kept)
 */
export function blockZToExtreme(pairs, blockIds, direction) {
  const inBlock = new Set(blockIds);
  const blockPairs = pairs.filter(([id]) => inBlock.has(id));
  const otherZs = pairs.filter(([id]) => !inBlock.has(id)).map(([, z]) => z);
  // Order the block by current z so its internal stacking is preserved.
  const ordered = [...blockPairs].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (direction > 0) {
    const base = otherZs.length ? Math.max(...otherZs) : 0;
    // Ascending: the block's own bottom→top lands just above everything else.
    return ordered.map((id, i) => [id, base + 1 + i]);
  }
  const base = otherZs.length ? Math.min(...otherZs) : 0;
  // Descending: the block's top→bottom lands just below everything else, so the
  // block's own top item stays nearest the rest (its internal order preserved).
  return ordered.map((id, i) => [id, base - 1 - (ordered.length - 1 - i)]);
}

// ── (De)serialization ────────────────────────────────────────────────────────

/** Pure function. Document → pretty JSON (the .powerrp.json save format). */
export function serialize(doc) {
  return JSON.stringify(doc, null, 2);
}

/** Pure function. JSON → document; validates the basic shape loudly. */
export function deserialize(json) {
  const doc = JSON.parse(json);
  if (!doc.meta || !Array.isArray(doc.slides) || doc.slides.length === 0)
    throw new Error("Invalid PowerRP document: expected {meta, slides[≥1]}");
  for (const s of doc.slides)
    if (typeof s.id !== "string" || typeof s.delta !== "object")
      throw new Error(`Invalid slide: ${JSON.stringify(s).slice(0, 80)}`);
  return doc;
}

/**
 * Pure function. All keyframe leaf entries across slides, chronological —
 * the keyframe panel's data: [{slideIndex, slideId, path, value}].
 */
export function allKeyframes(doc) {
  return doc.slides.flatMap((s, slideIndex) =>
    leaves(s.delta).map(([path, value]) => ({ slideIndex, slideId: s.id, path, value })));
}

/**
 * Pure function. Every item the DOCUMENT ever keys (union across all slide
 * deltas, enabled or disabled), in first-appearance (creation) order. `type`
 * and `name` are the FIRST values any slide writes for them — creation-slide
 * semantics (names are written on the creation slide; the load-time orphan
 * repair guarantees every id has a type). Powers the item picker's "ALL
 * objects on ALL slides" listing: items with no state on the current slide
 * (not yet created / active:false) still need an identity to list.
 *
 * Args:
 *   doc (object): document
 *
 * Returns:
 *   {id, type, name}[] (name undefined when the item was never named)
 *
 * @example allDocumentItems({slides: [{delta: {items: {a: {type: "rect", name: "Box"}}}}, {delta: {items: {b: {type: "circle"}, a: {x: 5}}}}]}) // [{id: "a", type: "rect", name: "Box"}, {id: "b", type: "circle", name: undefined}]
 * @example allDocumentItems({slides: [{delta: {}}]}) // []
 */
export function allDocumentItems(doc) {
  const out = new Map(); // id → {id, type, name}; first write of each field wins
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object")) continue;
      const cur = out.get(id) ?? { id, type: undefined, name: undefined };
      if (cur.type === undefined && typeof item.type === "string") cur.type = item.type;
      if (cur.name === undefined && typeof item.name === "string") cur.name = item.name;
      out.set(id, cur);
    }
  return [...out.values()];
}

// ── Simulated state: is this document one? (manifest R7-9) ───────────────────

/**
 * Query (reads the fold cache). Does any equation in `doc` read SIMULATED STATE —
 * a previous value (`@`) or the timestep (`dt`)?
 *
 * WHY A DOCUMENT-LEVEL PREDICATE EXISTS AT ALL. Simulated state deliberately gives
 * up the SEEKABILITY recordable state has: frame N is a function of frames 0..N-1,
 * so a renderer cannot start cold at frame 200. `cli/render_job.js` shards a render
 * by STRIDED frame range, and a strided shard is exactly a cold start in the middle
 * of a trajectory. This answers the question a render job has to ask BEFORE it
 * renders anything, which is why it is static (core/expressions.sourceIsSimulated)
 * rather than a flag off an evaluation that has not happened yet.
 *
 * THE SAME WALK THE EVALUATOR USES, deliberately: the folded state of every slide,
 * every string variable, and every leaf `isEquationValue` accepts. Asking a
 * different question than the evaluator would be a mirror that can drift, and the
 * direction it would drift in is the wrong one (a source the evaluator treats as an
 * equation and this does not is a silent strided shard).
 *
 * ── IT ASKS THE REGISTRY TOO, AND SCANNING TEXT ALONE WAS A REAL BUG ────────
 * A SIMULATED NODE CARRIES NO `@` ANYWHERE IN THE DOCUMENT. The frame domain
 * (core/exec_frame.js) holds a Schmitt latch, a counter's tally and a countdown in
 * the simulation table with no equation to scan — so an equation-source-only scan
 * answered `false` for a deck whose entire behaviour is simulated,
 * `stridedShardRefusal` returned `null`, and `cli/render_job.js` would shard it by
 * STRIDED frame range. The result is precisely what that refusal's own sentence
 * warns about: *"a strided shard would start cold in the middle of a trajectory and
 * render a plausible WRONG video"* — on a green exit code, with no error, and no
 * existing test could catch it because every simulated deck until now reached the
 * table through an equation.
 *
 * THE QUESTION IS ASKED OF THE PLUGIN'S DECLARATION, NEVER OF A TYPE LIST
 * (`core/exec_frame.frameNodeIsSimulated`, which is `typeof plugin.frameStep ===
 * "function"`). This is the `isTriggerableMidiSource` precedent verbatim: a hand-kept
 * roster of "the simulated types" would be correct only until the next frame node
 * lands, and the failure of a stale one is silent and unrenderable-after-the-fact.
 *
 * @param {object} doc - a repaired document
 * @param {object} registry - the plugin registry
 * @returns {boolean}
 *
 * @example // documentIsSimulated(newDocument(), registry) === false — a fresh deck simulates nothing
 * @example // a deck with items.a1.rotation = "= @@ + dt" → true
 * @example // a deck whose ONLY simulation is a Schmitt trigger node → true (no `@` in it)
 */
export function documentIsSimulated(doc, registry) {
  for (let index = 0; index < doc.slides.length; index++) {
    const state = slideState(doc, index);
    for (const value of Object.values(state.vars ?? {}))
      if (typeof value === "string" && sourceIsSimulated(value)) return true;
    for (const item of Object.values(state.items ?? {})) {
      if (typeof item?.type !== "string") continue;
      const plugin = registry.get(item.type);
      // THE FRAME DOMAIN, asked of the declaration — see the docblock. Checked
      // BEFORE the leaf walk because it is one property read against a walk of every
      // leaf of every item, and because a frame node's answer cannot be overturned
      // by anything the walk finds.
      if (frameNodeIsSimulated(plugin)) return true;
      for (const value of Object.values(item.vars ?? {}))
        if (typeof value === "string" && sourceIsSimulated(value)) return true;
      for (const [path, value] of [...leaves(item), ...declaredListLeaves(item)])
        if (path[0] !== "vars" && isEquationValue(plugin, path, value, item) && sourceIsSimulated(value))
          return true;
    }
  }
  return false;
}

/**
 * Query. The sentence explaining why `doc` may NOT be sharded by STRIDED frame
 * range, or `null` when it may — the problem-string-or-null shape
 * core/nodeflow.nodeRefProblem and core/commands.commandUnavailableReason already
 * use, so a caller reads it the same way it reads every other refusal here.
 *
 * A SIMULATED DOCUMENT MUST NEVER BE STRIDED-SHARDED SILENTLY. Each worker is its
 * own process with its own history table, so a strided worker would integrate its
 * frames from the wrong prefix and produce a plausible, wrong video with a green
 * exit code — the exact failure this project forbids. Contiguous ranges are always
 * safe (each worker walks its own prefix in order).
 *
 * @param {object} doc - a repaired document
 * @param {object} registry - the plugin registry
 * @returns {string|null} the refusal, or null when strided sharding is safe
 *
 * @example // stridedShardRefusal(newDocument(), registry) === null
 * @example // a simulated deck → "…contains SIMULATED STATE… shard by CONTIGUOUS frame ranges instead"
 */
export function stridedShardRefusal(doc, registry) {
  if (!documentIsSimulated(doc, registry)) return null;
  return "this document contains SIMULATED STATE (an equation reading `@` or `dt`, or a per-frame trigger node that carries state between frames), so frame N is a function of frames 0..N-1 — a strided shard would start cold in the middle of a trajectory and render a plausible WRONG video; shard by CONTIGUOUS frame ranges instead, one prefix per worker";
}
