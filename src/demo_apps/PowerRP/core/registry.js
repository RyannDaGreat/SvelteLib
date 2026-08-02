/**
 * Plugin registry — per-document-session, NOT a process global (BirdsEye
 * lesson: global singletons make multiple live documents impossible).
 *
 * A widget plugin is a declarative object:
 *   {
 *     type: "rect",                         // unique type string
 *     title: "Rectangle",                   // human name
 *     capabilities: {                       // tools/UI dispatch on these — NEVER on type
 *       bbox: true,        // state has x,y,w,h (w/h in LOCAL units, pre-transform)
 *       transform: true,   // state has x,y (+optional rotation, scale)
 *       resizable: true,   // resize handles allowed
 *       backdrop: false,   // emits backdrop ops (blur/magnify) — the renderer
 *                          // gives them the composite-so-far; never culled
 *     },
 *     defaults: { ... },                    // initial state for a new instance
 *     inspector: [{key, label, kind}],      // kind: one of core/properties.js ROW_KINDS
 *     emit(state) → commands                // THE render API: display-list IR in
 *                                           // LOCAL coords (render_gpu/ir.js);
 *                                           // sceneIR wraps in the world transform
 *     anchors(state) → [{id, x, y}]         // preset anchor points, LOCAL coords.
 *                                           // THE INK RULE (core/derive.js
 *                                           // withInkAnchors): registration
 *                                           // projects the eight standard RIM
 *                                           // anchors through this plugin's own
 *                                           // closestAnchor, so they land on the
 *                                           // silhouette rather than on the box
 *                                           // around it. `cm` (the centre) and
 *                                           // any plugin-specific id are left
 *                                           // exactly where declared. Idempotent,
 *                                           // so a box-shaped widget is
 *                                           // unchanged; declare `closestAnchor`
 *                                           // and a non-box silhouette follows
 *                                           // for free.
 *     closestAnchor?(state, wx, wy)         // computed anchor: closest point on
 *                                           // outline to a WORLD point (local out).
 *                                           // ALSO the rim the ink rule above
 *                                           // projects onto — one declaration, so
 *                                           // a named anchor and a live
 *                                           // closest_to_rim solve cannot
 *                                           // disagree about where the shape is
 *     snapFeatures?(state) → [...]          // extra snap features (LOCAL); bbox
 *                                           // widgets get standard ones for free
 *     localBounds?(state) → {x,y,w,h}       // BOUNDS protocol (core/view.js
 *                                           // localBoundsOf): the LOCAL rect this
 *                                           // widget's INK occupies. Absent →
 *                                           // {0,0,w,h} for a `bbox` widget, null
 *                                           // for anything else (= genuinely
 *                                           // unboundable; blur alone). Culling,
 *                                           // band select, the copy/export
 *                                           // capture rect, HIT TESTING and the
 *                                           // "Set Size to Ink Bounds" command all
 *                                           // read THIS, so a two-point widget
 *                                           // (line/arrow/...) declares its
 *                                           // endpoint hull here instead of being
 *                                           // treated as having no extent. NOT
 *                                           // `cullMargin` — that is the EFFECT
 *                                           // halo around the ink.
 *                                           //
 *                                           // A BBOX WIDGET DECLARES IT TOO when
 *                                           // its ink is not its box: text
 *                                           // OVERFLOWS (a stack taller than h
 *                                           // grows downward past it, an
 *                                           // unbreakable word runs off the side),
 *                                           // and until plugins/plaintext.js
 *                                           // declared this, overflowing type was
 *                                           // culled, un-band-selectable, cropped
 *                                           // out of exports and UNCLICKABLE — all
 *                                           // four from the one missing rect.
 *                                           //
 *                                           // HIT TESTING TAKES THE UNION of this
 *                                           // rect and the property box
 *                                           // (core/derive.clickableLocalRect), not
 *                                           // this rect alone: ink may be SMALLER
 *                                           // than the box (a half-empty text box),
 *                                           // and that empty area must stay
 *                                           // grabbable. Ink that reaches OUTSIDE
 *                                           // the box also draws a dashed INK-BOUNDS
 *                                           // ghost under Show Ghosts.
 *                                           //
 *                                           // MEASUREMENT THAT NEEDS A FONT goes
 *                                           // through core/ink_metrics.inkMeasure()
 *                                           // — an injectable seam the render side
 *                                           // fills, with a LOUD monospace fallback.
 *                                           // core/ is DOM-free, so a plugin must
 *                                           // never reach for CanvasKit or canvas2D
 *                                           // here directly.
 *     canSkip?(state, viewRectWorld) → bool // CULLING protocol: return true iff
 *                                           // this widget contributes nothing to
 *                                           // the given world-space view rect
 *                                           // {x,y,w,h} and may be skipped when
 *                                           // painting. Absent → the compositor's
 *                                           // default rule (localBounds AABB outside
 *                                           // the view → skip; UNBOUNDABLE never
 *                                           // skips).
 *                                           // Backdrop samplers are ALWAYS painted
 *                                           // regardless of this hook.
 *     effectBounds?(state, world)           // EFFECTS protocol: {bbox, world} —
 *                                           // where this widget's effect
 *                                           // substrate lives (see
 *                                           // render_gpu/effects.effectBoundsOf).
 *                                           // Absent → {0,0,w,h} in the node's
 *                                           // own world (the bbox default).
 *     cullMargin?(state) → local halo       // the reach this widget's EFFECTS
 *                                           // throw AROUND its ink, inflating the
 *                                           // cull/capture AABB (core/view.js).
 *                                           // Injected automatically for every
 *                                           // plugin the effects bundle reaches;
 *                                           // ORTHOGONAL to localBounds, which is
 *                                           // the ink itself.
 *     hitTest?(state, lx, ly, tol)          // is a LOCAL point on this widget's
 *                                           // SILHOUETTE? Absent → the whole bbox
 *                                           // counts (selection-grab parity with
 *                                           // every design tool). hitTestWorld?(
 *                                           // node, wx, wy, nodesById) instead for
 *                                           // a widget whose geometry lives in
 *                                           // WORLD space (the arrow family).
 *     modifierPoints?(state)                // the "PPT yellow squares": LOCAL
 *       → [{id, x, y, apply, constrain?,    // draggable handles that each write ONE
 *           shape?, stem?}]                 // parameter. Wrapped local→world by
 *                                           // core/derive.nodeModifierPoints — see
 *                                           // THE HANDLE-CONSTRAINT PROTOCOL below.
 *                                           // shape?: a glyph name the canvas layer
 *                                           // draws instead of the square (e.g.
 *                                           // "triangle"); absent → square. stem?:
 *                                           // an OPTIONAL local point the handle
 *                                           // tethers to, drawn as a dashed ghost
 *                                           // line (a bezier handle → its anchor).
 *                                           // Both optional & additive, so a widget
 *                                           // that omits them renders unchanged.
 *     handleToggles?: [{key, label, icon,   // the on/off states a LIST-ELEMENT
 *       isOn(el), set(el, on)}]             // handle offers (curve/break on a paint
 *                                           // path); the universal HandleToolbar and
 *                                           // point menu render them with no widget
 *                                           // knowledge, routed through
 *                                           // app.transformHandleSelectionElements.
 *     editPoints?(node, nodesById)          // the WORLD-space endpoint handles of a
 *                                           // two-point widget (core/endpoints.js).
 *     commands?: [{id, title, run(app)}]    // palette commands this plugin adds
 *     presets?: [{name, description, props}] // ONE preset family (see below)
 *     presetFamilies?: [{id, title, presets}] // N ORTHOGONAL preset families
 *     toolGroups?: [{id, title, rows}]      // this widget's OWN Tools sections
 *   }
 *
 * No plugin may import another plugin. Composition happens through
 * capabilities, shared core modules (e.g. core/endpoints.js), and document
 * state. (A BirdsEye-style convention test suite enforcing this mechanically
 * is planned — see the dump manifest — but does not exist yet.)
 *
 * ── NEGATIVE w / h: WHAT A HOOK IS GUARANTEED NOT TO SEE ─────────────────────
 *
 * A STORED w or h MAY BE NEGATIVE, and it means a REFLECTION. The pose is a
 * SIMILARITY ({x, y, rotation, scale}, no skew), which is orientation-preserving
 * and therefore structurally cannot carry one — so the flip lives in the BOX
 * instead: `x' = x + scale·w, w' = -w` (commit 76fd076; core/geometry.js
 * flippedBox). It is a first-class stored form, reachable by Flip Horizontal /
 * Vertical, by dragging a resize handle THROUGH the opposite edge, by typing a
 * negative number into the Inspector, and mid-tween on an animated flip.
 *
 * A PLUGIN HOOK NEVER SEES IT. Every hook above is handed a state whose x/y/w/h
 * have already passed through THE SEAM — core/geometry.js `unsignedState`, which
 * replaces a signed box with the positive box it denotes. Because the flip is an
 * INVOLUTION, unsigning a flipped box returns the original byte-for-byte, so all
 * four sign spellings of one footprint derive to the IDENTICAL state, world,
 * bounds, anchors, snap features, cull answer and IR. So a widget author writes
 * `halfW = s.w / 2` and `0 <= lx <= s.w` exactly as if flips did not exist, and
 * cannot get this wrong because there is no sign to get wrong. That is the whole
 * cost of the feature: the reflection survives ONLY as `node.mirror`, which just
 * two consumers read — the render walk (render_gpu/ports.js mirrorPush, which
 * realizes it as a SIGNED similarity at paint time, since mirroring text GLYPHS
 * needs a real matrix reflection) and hit testing (core/derive.js hitNode, which
 * reflects the probe point back through core/geometry.js unmirroredLocal).
 *
 * SO IS `node.state.w`, AND THAT MATTERS OUTSIDE CORE. A render node's `state` IS
 * the unsigned box and its `world` is built from that box, so app-shell code that
 * maps `T.apply(node.world, node.state.w / 2, ...)` is correct as written and must
 * NOT be "fixed" with render_gpu/ir.js signedApply. signedApply is required
 * exactly where a frame can carry signX/signY — an IR pushTransform inside a
 * backend that draws at the device root instead of riding the canvas CTM — and
 * `node.world` never can.
 *
 * TWO ENTRANCES TO THE SEAM, ONE MAP. Most hooks are reached from a derived node,
 * and `deriveRenderTree` unsigns there. But the EXPRESSION PASS runs BEFORE any
 * node exists, so it reads RAW item state, and it calls `anchors` and
 * `closestAnchor` itself; it therefore enters the same map explicitly (as
 * core/derive.js pointInNodeBox already did). This is not a stylistic detail — it
 * is where the contract had a hole. `@item.ml` was resolved against the raw box,
 * whose local origin is the RIGHT edge once w is negative, so the equation
 * returned the right edge while the `ml` GLYPH the user clicks to write that
 * equation was drawn at the left edge: a bound arrow jumped the full width of a
 * widget whose silhouette had not moved. Anchor ids are GEOMETRIC names and a flip
 * does not move the silhouette, so `ml` is the left edge on BOTH sides of the
 * feature or the feature is incoherent. tests/negative_size_test.js pins all of
 * this per widget, data-driven off this registry so a widget added later is
 * covered with no list to maintain.
 *
 * NO HOOK IS EXEMPT. A widget needing to KNOW it is reflected would be asking for
 * something the contract deliberately withholds; the one place handedness is
 * genuinely missing is a procedural material's PATTERN (see ports.js mirrorPush),
 * and closing that means adding a handedness uniform to the material contract, not
 * relaxing this one.
 *
 * ── THE HANDLE-CONSTRAINT PROTOCOL (`constrain(state, desired) → allowed`) ────
 *
 * A constrained handle answers TWO separable questions, and welding them together
 * is what kept modifier points DRAG-ONLY: `constrain(state, desired) → allowed`
 * (where may it go — a pure projection) and `apply(state, allowed) → partial
 * state` (how is that stored). Every constraint used to live imperatively inside
 * `apply`, clamping on its way to writing a parameter, so nothing could ASK where
 * a handle was allowed to be without also committing a write — and therefore only
 * a mouse could drive one. Declaring the projection makes any source of a desired
 * point a valid driver: a drag, an equation, or a binding to another anchor
 * (commit b967325 — this line used to cite 2a81b95, which is not an ancestor of
 * HEAD and whose live twin 169abe4 contains none of the protocol; the code landed
 * under a commit about selectable handles). Optional, defaulted to UNCONSTRAINED
 * (the identity) by core/derive.js nodeModifierPoints, so a widget with no
 * restricted handle needs nothing and every consumer may call it unconditionally.
 *
 * IT IS NO LONGER SCOPED TO `modifierPoints[]`, and this heading used to say it
 * was. The bbox MOVE / RESIZE handles are not modifier points — their semantics
 * are uniform across every bbox widget, so there was nothing per-plugin to
 * override — and they used to express their restrictions as a pair of booleans
 * (`doX`/`doY`) in web/canvas/dragKinds.js. That is the SAME mathematical object
 * written twice: "height is locked" IS "project the desired (w, h) onto the
 * nearest point of the line {(w, h₀)}". They now share this one projection
 * through core/derive.js `pinning`, so there is one answer to "where may this
 * handle go" instead of two, and a new constraint source (an equation lock, a
 * chain-linked aspect ratio, a group scaling its children) is wired ONCE.
 *
 * SO A WIDGET CANNOT HAVE ITS OWN DIALECT, and that is enforced rather than
 * asked for: web/canvas/dragKinds.js `geometryPairs` is the only exported way to
 * turn a desired geometry into item writes, and tests/universal_constraints_test.js
 * sweeps the whole registered roster to prove every draggable affordance a widget
 * exposes resolves through it.
 *
 * LOCAL units for the modifier-point family. Full reasoning — including that
 * "nearest allowed" is a LAW WITH DECLARED EXEMPTIONS (this line used to call it
 * an unenforced convention, which was already stale) — lives at THE
 * HANDLE-CONSTRAINT PROTOCOL in core/derive.js.
 *
 * THE UNIVERSAL EFFECTS BUNDLE is injected HERE (see withUniversalEffects): a
 * plugin does not opt in, it opts OUT by being ineligible. That is why the
 * user's "soft edges should be an option for everything that we can give it to"
 * cannot rot again — a new widget file gets shadow / bloom / blend / inner
 * shadow / soft edges the moment it is registered, with no line to forget.
 *
 * THE TOOL GROUPS are resolved HERE TOO (see withToolGroups / TOOL_POOL), by the
 * same doctrine and for the same reason: a widget does not list every tool
 * category and hope, it DECLARES what it owns and INHERITS the generic tools it
 * is structurally eligible for. web/ToolsPane.svelte then renders
 * `plugin.toolGroups` and knows nothing about which tools exist.
 */

import { BUNDLES, bundle, bundleNestedDefaults } from "./properties.js";
import { LIST_ROW_KIND } from "./lists.js";
import { EPHEMERAL, isEphemeralDecl } from "./ephemeral.js"; // the sixth required field — see register()
// The Shatter tool's applicability predicate, taken from the module that DEFINES
// what "shatterable" means rather than re-spelled here as a second copy of the
// same three conditions (core/shatter.js imports document/retype only, so this
// edge introduces no cycle).
import { shatterEligible } from "./shatter.js";
// THE INK RULE, applied at registration like the two wraps below it. It lives in
// core/derive.js beside standardBBoxAnchors and nodeAnchors — the whole anchor
// story reads in one place there — and derive.js imports nothing that reaches
// back here, so this edge introduces no cycle.
import { withInkAnchors } from "./derive.js";
// core/view.js already imports this module's cull-margin half (the established
// core → render_gpu/effects.js edge: effects.js is DOM-free bare-node JS, the
// same layer core is), so the fourth hand-copied line can be injected too.
import { effectsCullMargin, EFFECT_STATE_KEYS } from "../render_gpu/effects.js";

// IMPORT-TIME CONSISTENCY GATE (the render_settings.js precedent: a declared
// option with no implementation throws at import, never ships as a dead row).
// Every top-level state key the property bundle expands to must be an effect the
// render half (render_gpu/effects.js applyEffects) actually composes — so adding
// a SIXTH effect to BUNDLES.effects without its render composition fails at boot
// instead of putting an inert control in front of the user.
for (const key of Object.keys(bundleNestedDefaults("effects")))
  if (!EFFECT_STATE_KEYS.includes(key))
    throw new Error(`core/registry: BUNDLES.effects declares state key "${key}", which render_gpu/effects.js does not implement (implemented: ${EFFECT_STATE_KEYS.join(", ")}) — a row with no render half must not reach the Inspector`);

/**
 * Pure function. Does this plugin ALREADY carry the effects bundle's Inspector
 * rows? Presence of any one of them means the plugin composes the bundle
 * itself — property half AND the applyEffects call inside emit() — so the
 * injector must leave it completely alone (the 34 pre-universal call sites).
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example composesEffects({inspector: [{key: "x"}, {key: "softEdges"}]}) // true
 * @example composesEffects({inspector: [{key: "x"}, {key: "w"}]}) // false
 * @example composesEffects({}) // false (no inspector at all)
 */
export function composesEffects(plugin) {
  const keys = new Set(BUNDLES.effects);
  return (plugin.inspector ?? []).some((r) => keys.has(r.key));
}

/**
 * Pure function. May the registry INJECT the effects bundle into this plugin —
 * i.e. can render_gpu/ports.js apply the render half on the plugin's behalf? THE
 * honest boundary: a node kind that cannot honour an effect gets NO ROW, never a
 * fake one. Three deliberate exclusions, each on a DECLARED property (never on
 * type):
 *
 *   purgeable === false — THE CAMERA. The view/background definition, not a
 *     drawn widget; it has no silhouette of its own to shadow or feather.
 *   ghost without foldsSubtree — cropbox / anchor_point. No rendered volume: a
 *     crop box IS a clip region (its TARGET's effects ride into the crop
 *     content) and an anchor point is editor chrome. A GROUP is also a ghost but
 *     folds a composited member subtree, so it is eligible (and has always
 *     composed the bundle) — the carve-out is real, not a special case.
 *   no bbox and no effectBounds hook — the blur layer (a full-screen backdrop
 *     blur with no geometry at all) and corkboardYarn. Without a local render
 *     footprint there is nothing to bound the effect substrate with; declaring
 *     an `effectBounds(state, world)` hook (render_gpu/effects.effectBoundsOf)
 *     is all it takes to become eligible.
 *
 * BACKDROP SAMPLERS (glass / frosted / CRT / comic / metaball / magnify / rainy
 * window / glitch) ARE injectable: they write premultiplied zero outside their
 * own SDF, so their offscreen alpha IS their silhouette. The old "a backdrop
 * cannot be wrapped in an effectSubtree" claim was disproven by pixel probe.
 *
 * NOT INJECTABLE ≠ CANNOT HAVE EFFECTS. The ARROW FAMILY (arrow / line /
 * tangent_lines / fancy_arrow / elbow_arrow / curved_arrow) has no bbox and no
 * effectBounds hook, so this returns false for it — yet every one of them
 * supports all five effects, because each composes the bundle in its OWN emit()
 * and passes its OWN bounds (paddedPointsBBox of its drawn geometry). This
 * predicate answers "may the registry do it FOR the plugin", nothing more; a
 * plugin that already does it itself is never asked.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example effectsInjectable({capabilities: {bbox: true, transform: true}}) // true (an ordinary drawn widget)
 * @example effectsInjectable({capabilities: {bbox: true, backdrop: true}}) // true (a backdrop sampler: its SDF alpha is its silhouette)
 * @example effectsInjectable({capabilities: {bbox: true, purgeable: false}}) // false (THE camera)
 * @example effectsInjectable({capabilities: {bbox: true, ghost: true}}) // false (cropbox / anchor_point: no rendered volume)
 * @example effectsInjectable({capabilities: {bbox: true, ghost: true}, foldsSubtree: () => true}) // true (a group composites its member subtree)
 * @example effectsInjectable({capabilities: {backdrop: true}}) // false (the blur layer: no geometry to bound)
 */
export function effectsInjectable(plugin) {
  const caps = plugin.capabilities ?? {};
  if (caps.purgeable === false) return false;
  if (caps.ghost && !plugin.foldsSubtree) return false;
  if (!caps.bbox && !plugin.effectBounds) return false;
  return true;
}

/**
 * Pure function. A plugin with the UNIVERSAL EFFECTS BUNDLE injected — the
 * registered form of an eligible plugin that did not compose the bundle itself.
 * All four of the formerly hand-copied lines, in one place nothing can skip:
 *
 *   defaults   ...bundleNestedDefaults("effects")  — every effect OFF, so an
 *                untouched widget is byte-identical and an old document
 *                self-heals through core/document.missingDefaults (which reports
 *                every fill LOUDLY).
 *   inspector  ...bundle("effects")                — the rows land in the
 *                Inspector's existing "effects" category group; keyframing and
 *                `=` equations need nothing extra (both are registration-free).
 *   cullMargin effectsCullMargin                   — so a shadow/bloom halo is
 *                not culled away when the widget's box is just off-view.
 *   effectsInjected: true                          — the flag render_gpu/ports.js
 *                reads to decide that IT owns the render half for this plugin.
 *
 * A source plugin object is never mutated (two live documents share the same
 * plugin modules); the registry stores this augmented COPY. The plugin's own
 * values always win on collision, so a widget that already defines one of these
 * keys for its own reasons keeps it.
 *
 * @param {object} plugin - a widget plugin as authored
 * @returns {object} the plugin, or an augmented copy of it
 *
 * @example withUniversalEffects({type: "x", capabilities: {bbox: true}, defaults: {}, inspector: []}).effectsInjected // true
 * @example withUniversalEffects({type: "x", capabilities: {bbox: true}, defaults: {}, inspector: []}).defaults.softEdges // 0
 * @example withUniversalEffects({type: "camera", capabilities: {bbox: true, purgeable: false}, defaults: {}, inspector: []}).effectsInjected // undefined (ineligible — untouched)
 */
export function withUniversalEffects(plugin) {
  if (composesEffects(plugin) || !effectsInjectable(plugin)) return plugin;
  return {
    ...plugin,
    defaults: { ...bundleNestedDefaults("effects"), ...plugin.defaults },
    inspector: [...(plugin.inspector ?? []), ...bundle("effects")],
    cullMargin: plugin.cullMargin ?? effectsCullMargin,
    effectsInjected: true,
  };
}

// ── TOOL GROUPS (web/ToolsPane.svelte's entire input) ────────────────────────
//
// THE PROBLEM THIS SOLVES (the user's words): "why is Presets UNDER Formatting?
// A submenu under formatting? No, these should be TOP-LEVEL menus. And by the
// way, if there's nothing in a submenu, it doesn't need to show it. If there are
// no formatting tools, we don't need to see the formatting drop-down in Tools.
// ... Widgets should be able to OWN what type of tool submenus they have in
// Tools, and they can CATEGORIZE it. They might INHERIT or pull some tools from a
// TOOL POOL. But they should NOT be required to have every type of tool in every
// type of drop-down menu."
//
// Before this, the pane held a hand-written TOOLS array and pinned each tool to
// an Inspector CATEGORY, so EVERY widget rendered EVERY category: a rect showed a
// "Formatting" section whose only content was a disabled Presets toggle that then
// opened a second disclosure inside the first. The vocabulary was also mirrored
// from web/Inspector.svelte by hand, with a comment begging future authors to
// keep the two copies in sync.
//
// THE MODEL. A GROUP is one collapsible section of the Tools pane:
//     {id, title, rows: [row]}
// A ROW is one control in it, discriminated by `kind` (the Inspector's own row
// vocabulary, extended — same word, same shape, so the panes read as one system):
//     {kind: "command", command, help, requires}   — a command-registry surfacing
//     {kind: "preset", preset}                     — one preset card
// A plugin's resolved `toolGroups` is: its OWN groups (preset families, then any
// `toolGroups` it declares) followed by the POOL groups it is eligible for —
// plugin-owned first, inherited last, EXACTLY the order withUniversalEffects
// appends the universal property rows in.
//
// THE TWO AXES, and why one hides while the other explains:
//   APPLICABILITY is structural and per-WIDGET: `applies(plugin)`, evaluated once
//     HERE at registration. Not applicable → the row does not exist → a group
//     left with no rows is DROPPED, so "an empty group does not render" is not a
//     rule the pane remembers to apply, it is a shape the pane cannot receive.
//     This is what makes a Formatting section with nothing in it unrepresentable.
//   AVAILABILITY is transient and per-APP-STATE: the command's own `when(app)`.
//     Rendered DISABLED, never hidden, with `requires` as the tooltip's reason —
//     hiding it would make the tool unlearnable ("you could unbind, if something
//     were bound"), and this is the ONE thing in the pane the user's words admit
//     two readings of. FLAGGED — PENDING USER RATIFICATION.
// Because `applies` is a PREDICATE THE POOL DECLARES (never a per-entry `when`
// hand-written at each call site), an affordance that can never appear is
// mechanically detectable: tests/tool_groups_test.js sweeps every registered
// plugin × every pool row and fails on a row or group no widget can ever reach.

/**
 * The four properties that make a widget's FRAME — what "this widget has a
 * position and a size" means anywhere in the app. The camera-bind tools' whole
 * generality gate is "does the plugin DECLARE all four", never a type list.
 *
 * HANDBACK PENDING: web/App.svelte's `CAMERA_BIND_KEYS` is the same list, written
 * out again (that file is owned by another agent this round). The patch replaces
 * it with an import of this constant, after which there is one copy.
 */
export const FRAME_KEYS = ["x", "y", "w", "h"];

/**
 * Pure function. Does this plugin declare all four FRAME_KEYS in its defaults —
 * i.e. does it have a position and a size at all? A blur layer (z/blur/opacity
 * only) and the arrow family (from/to, not x/y/w/h) are the widgets this excludes.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example hasFrame({defaults: {x: 0, y: 0, w: 10, h: 10}}) // true
 * @example hasFrame({defaults: {x: 0, y: 0}}) // false (no w/h — an arrow endpoint pair)
 * @example hasFrame({}) // false (no defaults at all)
 */
export function hasFrame(plugin) {
  return FRAME_KEYS.every((key) => plugin.defaults?.[key] !== undefined);
}

/**
 * Pure function. May this plugin's frame be BOUND to another item's frame (the
 * "Bind Position & Size to Camera" / "Unbind Position & Size" pair)? It needs a
 * frame, and it must not be THE camera itself — binding the camera to its own
 * frame is a dependency cycle, and `purgeable: false` is how the mandatory
 * singleton is identified everywhere else in core (see effectsInjectable).
 *
 * BOTH COMMANDS NAME THEIR OBJECT (the user asked of the old pair: "you have bind
 * to camera, and then unbind. Unbind what?"). The object is the widget's FRAME,
 * and the words for it are not invented here: FRAME_KEYS above already defines a
 * frame as "a position and a size", which is what hasFrame's docstring calls it
 * and what the Inspector groups under Positioning. Neither title says "Unbind
 * from Camera" — the freeze half replaces an equation on x/y/w/h whatever that
 * equation references, which is what makes it the honest inverse.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example frameBindable({defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}}) // true
 * @example frameBindable({defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {purgeable: false}}) // false (THE camera)
 * @example frameBindable({defaults: {blur: 4}, capabilities: {}}) // false (no frame)
 */
export function frameBindable(plugin) {
  return hasFrame(plugin) && plugin.capabilities?.purgeable !== false;
}

/**
 * The camera-bind pair's HELP and REQUIRES sentences, beside `frameBindable` —
 * the predicate they explain. The command ENTRIES in web/App.svelte declare them,
 * and EVERY surfacing (Toolbar, palette, Tools pane) reads them from the entry.
 *
 * THEY NOW HAVE ONE CONSUMER, which is a change from why they were hoisted here:
 * the pool row below used to carry a second copy, and that copy is gone (see
 * TOOL_POOL). By ledger C-1 a shared home wants two consumers, so these belong
 * inline in App.svelte now — HANDBACK PENDING, deferred only because moving them
 * means editing that file's import line while another agent holds it.
 */
export const CAMERA_BIND_HELP = "Write x / y / w / h as equations reading THE camera's frame, so this widget covers the view and keeps tracking it when the camera moves, resizes or zooms.";
export const CAMERA_BIND_REQUIRES = "a selected widget with its own position and size (x / y / w / h) — the camera itself cannot be bound to its own frame";
export const CAMERA_FREEZE_HELP = "Replace equation-bound x / y / w / h with the plain numbers they currently evaluate to, so the widget stops following whatever it was bound to and stays put.";
export const CAMERA_FREEZE_REQUIRES = "at least one of x / y / w / h to actually hold an equation — nothing here is bound, they are all plain numbers already";

/**
 * The two properties that make a widget's LIGHT POSITION — the world-space point
 * a lit widget takes its illumination from (plugins/demo/lens_flare.js,
 * plugins/demo/god_rays.js). The FRAME_KEYS shape, one dimension over: a
 * structural key list, so the tool's gate is "does the plugin DECLARE both",
 * never a type list.
 *
 * WHY THESE ARE KEYS AND NOT A ROW ASPECT ANY MORE (manifest R6-4.5). They used
 * to be named by a `pinLight: {xKey, yKey}` field on the widget's Light X
 * inspector row, which put a MODE-ENTERING BUTTON in the property gutter — a tool
 * wearing a property's clothes. The pair is a property OF THE WIDGET, not of one
 * row, so it is declared where the widget's other structural facts are.
 */
export const LIGHT_KEYS = ["lightWorldX", "lightWorldY"];

/**
 * Pure function. May this plugin's light position be PINNED to another item's
 * center (the "Pin Light Position to an Object" tool)? It needs both LIGHT_KEYS,
 * and — exactly as `frameBindable` excludes THE camera from binding to its own
 * frame — nothing else: a lit widget with no frame of its own is still a fine
 * pinner, because the pin writes the LIGHT pair, not x/y/w/h.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example lightPinnable({defaults: {lightWorldX: 0, lightWorldY: 0}}) // true
 * @example lightPinnable({defaults: {lightWorldX: 0}}) // false (half a light position is not one)
 * @example lightPinnable({defaults: {x: 0, y: 0, w: 1, h: 1}}) // false (a frame is not a light)
 */
export function lightPinnable(plugin) {
  return LIGHT_KEYS.every((key) => plugin.defaults?.[key] !== undefined);
}

/**
 * The light-pin tool's HELP and REQUIRES sentences, beside `lightPinnable` for the
 * same reason the camera-bind pair's live beside `frameBindable` — and with the
 * same one-consumer handback now that the pool no longer carries a copy.
 *
 * The help says PICK, not "click the eyedropper", because the affordance is now a
 * tool in the Tools pane and naming a button that no longer exists is how the old
 * row's help text went stale.
 */
export const LIGHT_PIN_HELP = "Write this widget's light position as equations reading ANOTHER item's center, then keep them: pick the object and the light tracks it wherever it moves, instead of holding the coordinates it had when you picked.";
export const LIGHT_PIN_REQUIRES = "exactly one selected widget that HAS a light position (lens flare, god rays) — a light is pinned FROM one widget onto one object, so a multi-selection has no single widget to pin from";

/**
 * Pure function. Can this widget's state be keyframed at all — i.e. does it
 * declare any state for a slide delta to address? THE gate on the Keyframes
 * tools, and it is deliberately the WHOLE condition: animation is universal in
 * this document model (a keyframe is just a leaf of `items.<id>` in some slide's
 * delta — core/document.js), so a widget qualifies by having state, never by
 * being a particular kind of widget. Every registered plugin passes it today.
 *
 * THE CAMERA IS INCLUDED, unlike the frame-bind pair above. `purgeable: false`
 * means "this item may not be removed from existence"; freezing its animation
 * removes no item, and "stop the camera moving across the deck" is exactly the
 * operation someone with a drifting camera wants.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example keyframable({defaults: {x: 0, y: 0}}) // true
 * @example keyframable({defaults: {blur: 4}}) // true (no frame needed — any state will do)
 * @example keyframable({defaults: {}}) // false (nothing to key)
 */
export function keyframable(plugin) {
  return Object.keys(plugin.defaults ?? {}).length > 0;
}

/**
 * The Keyframes tools' HELP and REQUIRES sentences, beside `keyframable` for the
 * same reason the camera-bind pair's live beside `frameBindable` — and with the
 * same one-consumer handback now that the pool no longer carries a copy.
 *
 * THE PAIR DIFFERS BY SCOPE, NOT BY REVERSIBILITY (user: "remove animation
 * keyframes is not supposed to remove it on every slide, it's just supposed to
 * remove it on this slide … I think that one needs a different name"). So each
 * help sentence OPENS with its scope and NAMES the other tool — a user who found
 * the wrong one has to be told the right one exists, or the pair is a trap.
 * Both state the consequence in full, because "what exactly does this destroy" is
 * the question either of them has to answer before it is clicked.
 *
 * THEIR TITLES ALSO OPEN WITH DIFFERENT WORDS ("Make Static…" / "Remove
 * Keyframes…"), and that is a functional requirement rather than a stylistic one:
 * the palette is FUZZY-SEARCHED, so two titles beginning "Remove Keyframes…" would
 * both match one query and force the reader into the parentheticals to tell a local
 * edit from a sweeping one. "Make Static" also names the RESULT rather than the
 * plumbing, leaving the word "keyframes" to mean the tool that really is about them.
 */
export const MAKE_STATIC_HELP = "EVERY SLIDE FROM WHERE IT APPEARS UNTIL IT IS HIDDEN — not just this one. Deletes the widget's keyframes across that whole stretch and writes its state back once, at the slide the stretch begins on, using the values it holds on the slide you run this from: it looks the same here and stops changing for the rest of the stretch. A widget that is never hidden has one stretch, so that is the whole deck. Per-slide visibility is untouched (Delete and Show own that), and a later stretch that inherited its values from this one moves with it. To clear only the slide you are on, use Remove Keyframes on This Slide. Undo is the only way back: the replaced values are not kept.";
export const MAKE_STATIC_REQUIRES = "a selected widget that is VISIBLE on this slide and has keyframes past the start of the stretch it is visible on — everything selected here is either hidden here or already static across that stretch (keyframed visibility does not count, Delete and Show own that)";
export const SLIDE_KEYFRAMES_HELP = "THIS SLIDE ONLY: deletes everything this slide's delta says about the widget, so it stops changing here and INHERITS the previous slide's values instead — the animation passes THROUGH this slide rather than stopping at it, and any later keyframe now tweens from the inherited value. Unlike Make Static it DOES change what you see here, and a keyframed Visible goes with the rest, so a widget you Deleted on this slide reappears. Make Static from Current Slide is the one that flattens a whole stretch at once.";
export const SLIDE_KEYFRAMES_REQUIRES = "a selected widget that THIS slide actually keyframes and that is not created on it — nothing selected here writes anything on this slide, or this is the slide that brings it into existence (clearing that would delete the widget, which is what Purge Item is for)";

/**
 * Pure function. Applies to EVERY widget — the honest predicate for a tool with
 * no structural precondition at all, rather than a stand-in that happens to be
 * universal today (Copy is the case: every item, the camera included, can be put
 * on the clipboard; `clipboard.js` merges a pasted camera rather than refusing
 * one).
 *
 * IT IS A NAMED CLAIM, NOT AN OMISSION. The pool's import gate requires an
 * `applies` on every row so that a tool cannot silently claim universality by
 * leaving the field out; `grep everyWidget` then lists exactly which tools DO
 * claim it, which is the review question worth asking.
 *
 * @returns {boolean} always true
 *
 * @example everyWidget({type: "rect", defaults: {}}) // true
 * @example everyWidget({type: "camera", capabilities: {purgeable: false}}) // true
 */
export function everyWidget() {
  return true;
}

/**
 * Pure function. May this widget be removed, hidden, duplicated or grouped — i.e.
 * is it anything other than THE camera? `purgeable: false` is how the mandatory
 * singleton is identified everywhere else in core (see effectsInjectable and
 * frameBindable), and app.svelte.js's own duplicate/group selection filters
 * already read exactly this key to exclude it.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example purgeableWidget({capabilities: {}}) // true
 * @example purgeableWidget({capabilities: {purgeable: false}}) // false (THE camera)
 */
export function purgeableWidget(plugin) {
  return plugin.capabilities?.purgeable !== false;
}

/**
 * Pure function. Can this widget be MOVED by a translation the app applies for
 * you (the arrow-key nudges)? Either it carries the standard transform, or it
 * declares the `moveBy` protocol the endpoint widgets use because they have no
 * x/y to offset. Measured over the registered roster: 94 of 96 — the two that
 * are neither are the blur layer (no geometry) and tangent_lines (its position
 * is wholly derived from the circles it touches).
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example movable({capabilities: {transform: true}}) // true
 * @example movable({capabilities: {}, moveBy: () => ({})}) // true (an arrow: from/to, no x/y)
 * @example movable({capabilities: {backdrop: true}}) // false (the blur layer)
 */
export function movable(plugin) {
  return plugin.capabilities?.transform === true || typeof plugin.moveBy === "function";
}

/**
 * Pure function. Does this widget sit in the z stack — i.e. does it declare the
 * universal `z` property the reorder tools rewrite? Every registered plugin
 * passes it today, and it is still written as a structural read rather than
 * `everyWidget` for the reason `keyframable`'s docstring gives: the tool's real
 * precondition is the key, so a future widget without one drops the rows instead
 * of showing four that do nothing.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example stackable({defaults: {z: 0}}) // true
 * @example stackable({defaults: {blur: 4}}) // false (nothing to reorder)
 */
export function stackable(plugin) {
  return plugin.defaults?.z !== undefined;
}

/**
 * Pure function. IS this widget a group — the one thing Ungroup can act on?
 * Asked as "does it fold its member subtree", the capability groups are
 * identified by everywhere else in the codebase (core/shatter.js reads the same
 * field), never as `type === "group"`: the registry's rule is that tools dispatch
 * on capabilities, never on a type string.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example ungroupable({foldsSubtree: () => true}) // true
 * @example ungroupable({capabilities: {bbox: true}}) // false (an ordinary widget)
 */
export function ungroupable(plugin) {
  return typeof plugin.foldsSubtree === "function";
}

/**
 * Pure function. Does this widget have SOURCE TEXT a code editor can open
 * (codeblock, LaTeX, Mermaid, the two graph widgets)? The plugin declares the
 * editor itself, so the tool's gate is the presence of that declaration.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example codeEditable({codeEditor: {language: "latex"}}) // true
 * @example codeEditable({capabilities: {bbox: true}}) // false
 */
export function codeEditable(plugin) {
  return !!plugin.codeEditor;
}

/**
 * The ACTIVATION handler id (web/widget_handlers.js) that means "this widget's
 * content is edited as rich text, in place, with a caret". Declared as a plugin's
 * `activate`, and read here so the Edit Text tool's applicability is the same
 * declaration the double-click resolves through — plugins/text.js's own words:
 * "the gate reads the declaration, not the type name".
 *
 * HANDBACK, plugins/text.js + web/widget_handlers.js: this token is now spelled in
 * three places and should be exported from ONE. It is a literal here because
 * core/ may not import web/, and inventing a core home for a handler name while
 * two other agents hold those files would be a third spelling, not a second.
 */
export const RICH_TEXT_ACTIVATION = "rich_text_edit";

/**
 * Pure function. Is this widget's content edited as RICH TEXT in place — the
 * precondition for the Edit Text tool? A plaintext box is excluded on purpose: its
 * editor is the plain-string one, a different activation.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example richTextEditable({activate: "rich_text_edit"}) // true
 * @example richTextEditable({activate: "plaintext_edit"}) // false (a different editor)
 * @example richTextEditable({capabilities: {bbox: true}}) // false (nothing to edit)
 */
export function richTextEditable(plugin) {
  return plugin.activate === RICH_TEXT_ACTIVATION;
}

/**
 * Pure function. Are this widget's HANDLES the elements of a list property — the
 * precondition for hiding, showing and purging individual points? Both halves are
 * needed and neither alone is enough: `modifierPoints` alone is a rect's eight
 * resize grips (nothing to hide), and a list row alone is a filmstrip's frames or
 * a Mandelbrot's palette stops (no handle to select one with). Measured over the
 * registered roster the intersection is exactly polygon and paint_path, which is
 * the set those three commands were written for.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example pointListEditable({modifierPoints: () => [], inspector: [{key: "points", kind: "list"}]}) // true
 * @example pointListEditable({modifierPoints: () => [], inspector: [{key: "w", kind: "number"}]}) // false (resize grips)
 * @example pointListEditable({inspector: [{key: "frames", kind: "list"}]}) // false (a list with no handles)
 */
export function pointListEditable(plugin) {
  return typeof plugin.modifierPoints === "function"
    && (plugin.inspector ?? []).some((row) => row.kind === LIST_ROW_KIND);
}

/**
 * THE ADD-MENU a widget's insert command belongs in, declared BY THE WIDGET.
 * `"shape"` is the only value today (web/ShapePicker.svelte's grid and the
 * palette's "Add Shape" submenu); a plugin that declares nothing is inserted from
 * the top level, which is where most widgets belong.
 *
 * WHY IT IS A DECLARATION AND NOT A DERIVATION (CLAUDE-ORIGINATED; the user's
 * report was "New shapes that we add can go into the shape menu — Add Shape menu —
 * but I don't see them there"). The grid's membership rule USED to be "is this a
 * shapeshifter FAMILY" — read off `plugins/shapeshifter.js`'s FAMILIES table,
 * which is genuinely derived and was never a hand-kept list. The defect was one
 * level up: being a shapeshifter family is an IMPLEMENTATION detail, and it was
 * standing in for the user-facing category "is this a shape". So `aperture` and
 * `iris_blades` — standalone plugins that draw shapes — could never reach that
 * grid however diligently anyone maintained anything. A menu whose membership rule
 * describes how its members are built rather than what they are is the same defect
 * as a control that lies about what it is.
 *
 * Nothing structural distinguishes a shape from a QR code or a video: both are
 * bbox widgets that draw. So there is no honest derivation, and the choice is only
 * WHERE the declaration lives. It lives on the plugin, beside the widget's other
 * facts, so a new shape joins the menu in its own file and no central list has to
 * be remembered — the same reasoning that made `lightPinnable` a read of the
 * plugin's own defaults rather than a roster of lit widgets.
 */
export const INSERT_MENUS = ["shape"];

/**
 * Pure function. Does this plugin belong in the Add Shape menu — the grid AND the
 * palette submenu, which are two surfacings of this one answer?
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example shapeInsertable({type: "ss_heart", insertMenu: "shape"}) // true
 * @example shapeInsertable({type: "qrcode"}) // false (declares no menu — inserted from the top level)
 */
export function shapeInsertable(plugin) {
  return plugin.insertMenu === "shape";
}

/**
 * Pure function. Which ASSET KIND this plugin is the canvas DROP TARGET for —
 * the widget a dropped image / video / PDF turns into — or null for the great
 * majority of widgets, which are not made by dropping a file.
 *
 * WHY THIS IS DECLARED ON THE PLUGIN, which is the same argument INSERT_MENUS
 * makes three functions up: the answer cannot be derived. `assetKinds` on a
 * widget's `src` row says what that widget will ACCEPT once it exists, and three
 * separate widgets accept a PDF (`pdf_page`, `pdf_packet`, `paper_peacock`), so
 * acceptance cannot pick the one a bare drop should create. The choice is only
 * WHERE the declaration lives, and it lives beside the widget's other facts so a
 * new droppable kind arrives in its own file with no central list to remember.
 *
 * THE DEFECT THIS REPLACES was three hand-written copies of one pair. The drop
 * classifier tested `kind === "image" || kind === "video"`, the drop handler
 * ternaried between two insert methods, and the upload-then-insert path had the
 * same if/else again — so a PDF, whose widget has existed all along, hit the
 * "nothing on the canvas can show a pdf asset" refusal. That message was
 * accurate about the CLASSIFIER and false about the app.
 *
 * @param {object} plugin - a widget plugin
 * @returns {string|null} the asset kind it claims, or null
 *
 * @example assetDropKindOf({type: "image", assetDrop: "image"}) // "image"
 * @example assetDropKindOf({type: "pdf_page", assetDrop: "pdf"}) // "pdf"
 * @example assetDropKindOf({type: "pdf_packet"}) // null (accepts PDFs, is not what a bare drop creates)
 */
export function assetDropKindOf(plugin) {
  return plugin.assetDrop ?? null;
}

/**
 * Query. The plugin a dropped asset of `kind` should become, or null when no
 * widget claims that kind (a dropped `.wav` — it uploads to the library and the
 * drop is reported, which is correct, not a bug).
 *
 * Returns the FIRST claimant, but there can only ever be one: register() refuses
 * a second plugin claiming a kind, so the uniqueness is a registration-time fact
 * rather than a rule this query has to enforce on every drop.
 *
 * @param {{all: function}} registry - a widget registry
 * @param {string} kind - an asset kind ("image", "video", "pdf", …)
 * @returns {object|null} the claiming plugin
 *
 * A NULLISH KIND IS NULL, EXPLICITLY. Without this line the `find` compares
 * `undefined === undefined` and matches the FIRST plugin that declares no claim
 * at all — i.e. an asset payload with no `kind` would insert an arbitrary widget,
 * chosen by registration order. Caught by tests/asset_drop_test.js's empty-payload
 * case, which is why that case is in there.
 *
 * @example // widgetForAssetKind(registry, "pdf").type // "pdf_page"
 * @example // widgetForAssetKind(registry, "sound")    // null (no widget plays a bare sound file)
 * @example // widgetForAssetKind(registry, undefined)  // null (NOT the first unclaiming plugin)
 */
export function widgetForAssetKind(registry, kind) {
  if (!kind) return null;
  return registry.all().find((p) => p.assetDrop === kind) ?? null;
}

/**
 * THE TOOL POOL — the generic tools, declared ONCE, composed into every widget
 * that is structurally eligible. Ordered: a resolved plugin lists its own groups
 * first, then these in this order.
 *
 * A ROW IS TWO FACTS AND NOTHING ELSE: which command, and which widgets it makes
 * sense on. Everything a person READS — the title, the icon, the hover help, the
 * "Unavailable — requires …" clause — is the COMMAND ENTRY's, and every surfacing
 * reads it from there. It used to be copied into the row as well, which is how
 * this pool came to be a partial hand-written mirror of the command list; the
 * mirror is what let the pane offer FIVE of the app's ~40 widget-scoped commands
 * while the user could reach every one of them from the palette ("Why do I have to
 * open the command palette to find these things?"). Copying 40 more help
 * sentences in would have fixed today and guaranteed tomorrow (ledger C-8), so the
 * copies are gone instead and the mandate moved to where it can be checked against
 * the real registry: tests/tool_surfacing_probe.js asserts, on a live app, that
 * every command surfaced here declares a `requires`, AND — the direction nothing
 * checked before — that every command whose availability depends on the SELECTION
 * is surfaced here or in a plugin's own group.
 *
 * `applies(plugin)` is the STRUCTURAL half and is mandatory (the import gate below
 * throws otherwise): it is evaluated once, at registration, and decides whether the
 * row EXISTS on this widget at all. The command's own `when(app)` is the transient
 * half and only greys the row. A tool with genuinely no structural precondition
 * says so out loud with `everyWidget`.
 */
export const TOOL_POOL = [
  {
    id: "positioning",
    // Titled with the Inspector's own word for this category, so the widget's
    // x/y/w/h ROWS in the Property Panel and the tools that WRITE them read as
    // the same section of the same system.
    // HANDBACK PENDING: web/Inspector.svelte's CATEGORY_TITLES is the vocabulary
    // this literal belongs to; the patch moves that map to core/properties.js and
    // this becomes CATEGORY_TITLES.positioning. Until then
    // tests/tool_groups_test.js pins the two spellings together so they cannot
    // drift in the meantime.
    title: "Positioning",
    rows: [
      { kind: "command", command: "bind-to-camera", applies: frameBindable },
      { kind: "command", command: "unbind-from-camera", applies: frameBindable },
      // THE LIGHT PIN (manifest R6-4.5). Filed under Positioning with the
      // camera-bind pair because it is the same operation on a different pair of
      // coordinates: write one item's position keys as equations reading another
      // item's, so the first tracks the second. `lightPinnable` is narrower than
      // `frameBindable`, so the row simply does not appear on the 94 widgets with
      // no light — which is what a pool `applies` is for, and is why god_rays
      // inherits this with ZERO edits of its own.
      { kind: "command", command: "pin-light-to-object", applies: lightPinnable },
      // THE NUDGES are here rather than in Arrange because they write the same
      // x/y the camera-bind pair does — the Inspector files those rows under
      // Positioning, and a tool belongs beside the property it rewrites (this
      // group's own founding argument). They are keyboard-first and stay on the
      // arrow keys; a pointer-only user had no way to reach them at all.
      { kind: "command", command: "nudge-left", applies: movable },
      { kind: "command", command: "nudge-right", applies: movable },
      { kind: "command", command: "nudge-up", applies: movable },
      { kind: "command", command: "nudge-down", applies: movable },
    ],
  },
  {
    id: "arrange",
    // A TOOLS-ONLY group, and its vocabulary is not invented here: this app is
    // "PowerPoint-like" by charter, and Arrange is what PowerPoint (and Slides,
    // and Keynote) call the menu holding order, align, distribute and flip. Every
    // row below writes x / y / z, so the Inspector would file them all under
    // Positioning — which is exactly why they are NOT there: seventeen layout
    // rows would bury the three tools that section is about.
    title: "Arrange",
    // ORDER, then ALIGN, then DISTRIBUTE, then MIRROR/FLIP — coarsest first, and
    // the two easily-confused pairs are adjacent on purpose: "Mirror Layout
    // Horizontal" reflects a SET about its collective centre, "Flip Content
    // Horizontal" reflects ONE widget about its own, and reading the two titles
    // next to each other is the cheapest way to learn the difference.
    rows: [
      { kind: "command", command: "put-on-top", applies: stackable },
      { kind: "command", command: "bring-forward", applies: stackable },
      { kind: "command", command: "send-backward", applies: stackable },
      { kind: "command", command: "put-on-bottom", applies: stackable },
      { kind: "command", command: "align-left", applies: hasFrame },
      { kind: "command", command: "align-center-h", applies: hasFrame },
      { kind: "command", command: "align-right", applies: hasFrame },
      { kind: "command", command: "align-top", applies: hasFrame },
      { kind: "command", command: "align-center-v", applies: hasFrame },
      { kind: "command", command: "align-bottom", applies: hasFrame },
      { kind: "command", command: "distribute-h", applies: hasFrame },
      { kind: "command", command: "distribute-v", applies: hasFrame },
      { kind: "command", command: "arrange-grid", applies: hasFrame },
      { kind: "command", command: "mirror-h", applies: hasFrame },
      { kind: "command", command: "mirror-v", applies: hasFrame },
      { kind: "command", command: "flip-h", applies: hasFrame },
      { kind: "command", command: "flip-v", applies: hasFrame },
    ],
  },
  {
    id: "grouping",
    // A TOOLS-ONLY group. Shatter lives here and not under Edit because what it
    // PRODUCES is a group — "this widget becomes a group of its editable parts"
    // is its own title — so Group / Ungroup / Shatter are the three ways a group
    // comes into or goes out of existence, and a user who has found one has found
    // all three.
    title: "Grouping",
    rows: [
      { kind: "command", command: "group", applies: purgeableWidget },
      { kind: "command", command: "ungroup", applies: ungroupable },
      // SHATTER APPEARS ONLY ON WIDGETS THAT DECLARE A DECOMPOSITION — today that
      // is Mermaid alone, and it will be however many declare `shatter` tomorrow
      // with no edit here. This is the applicability axis doing its job: a Shatter
      // row on a rectangle is a control that can never work, which is the defect
      // `applies` exists to make unrepresentable.
      // THE ID IS `shatter`, AND "convert to widgets" IS ONE OF ITS ALIASES — the
      // user's own ruling ("why is the tool not called shatter? I asked for it to
      // be called shatter"), after an agent renamed it to Convert to Widgets on
      // PowerPoint-parity grounds. The synonym survives where a synonym belongs,
      // in the palette's search aliases.
      //
      // THIS LINE HAS NOW BEEN WRONG IN BOTH DIRECTIONS IN ONE DAY, which is why
      // it is commented at all. It named `shatter` while HEAD registered
      // `convert-to-widgets`, because the rename back was sitting UNCOMMITTED in
      // the shared working tree and `git grep` reads the working tree: the pool
      // shipped naming a command HEAD did not register, and the ghost gate in
      // tests/tool_groups_test.js caught it one commit later. Ask
      // `git show HEAD:web/App.svelte`, never the file on disk — and land a
      // registration and its consumer in the SAME commit, which is what this one
      // finally does.
      { kind: "command", command: "shatter", applies: shatterEligible },
    ],
  },
  {
    id: "edit",
    // A TOOLS-ONLY group: the operations on the ITEM ITSELF rather than on any of
    // its properties — put it on the clipboard, make another, stop it appearing,
    // remove it outright, open its source. The classic Edit menu, and the reason
    // it is not split into "Clipboard" and "Visibility" is that Duplicate belongs
    // to neither and the user asked for these by name in one breath ("if there's
    // anything that I can do — like duplicate or delete or something").
    title: "Edit",
    // NON-DESTRUCTIVE FIRST, PURGE LAST — the Keyframes group's rule, for the same
    // reason: the irreversible one must not be the first thing a hand reaches for.
    rows: [
      { kind: "command", command: "copy-item", applies: everyWidget },
      { kind: "command", command: "duplicate", applies: purgeableWidget },
      { kind: "command", command: "duplicate-in-place", applies: purgeableWidget },
      // The two capture-to-clipboard exports need something with a BOX to capture;
      // the blur layer has no bounds of its own, which is the same fact hasFrame
      // reads for the camera-bind pair.
      { kind: "command", command: "copy-as-png", applies: hasFrame },
      { kind: "command", command: "copy-as-pdf", applies: hasFrame },
      { kind: "command", command: "edit-code-source", applies: codeEditable },
      // ADDED BY THE GATE, NOT BY A PERSON. plugins/text.js published this command
      // hours after the pane was derived, and tests/tool_surfacing_probe.js failed
      // on the next run with "1 unreachable: edit-text-content" — which is the
      // whole point of writing the reverse direction down. Beside Edit Source
      // because they are the same act on different content.
      { kind: "command", command: "edit-text-content", applies: richTextEditable },
      // A PLUGIN's command in the pool, and it belongs here rather than in
      // plugins/elbow_arrow.js's own toolGroups: elbow_arrow DECLARES it, but its
      // gate reads the SELECTED box, so declaring it plugin-side would offer it
      // only when an elbow arrow is selected — precisely when it is useless. Which
      // module wrote a command has no bearing on which widget it acts upon.
      { kind: "command", command: "add-self-loop", applies: hasFrame },
      { kind: "command", command: "show-item", applies: purgeableWidget },
      { kind: "command", command: "delete-item", applies: purgeableWidget },
      { kind: "command", command: "purge-item", applies: purgeableWidget },
    ],
  },
  {
    id: "points",
    // A TOOLS-ONLY group, and the ONE group scoped to the INNER selection: its
    // rows act on the selected HANDLES, not on the item. Named for what they act
    // on, exactly as the commands themselves are ("Hide Points", "Purge Points").
    title: "Points",
    // Hide before Purge, again: the index-stable one first, the renumbering one
    // last (core/lists.js — purging shifts every later element's address, so an
    // equation bound to `points.4.x` comes to mean what was `points.5.x`).
    rows: [
      { kind: "command", command: "hide-points", applies: pointListEditable },
      { kind: "command", command: "show-points", applies: pointListEditable },
      { kind: "command", command: "purge-points", applies: pointListEditable },
    ],
  },
  {
    id: "keyframes",
    // A TOOLS-ONLY group: there is no "keyframes" Inspector CATEGORY, because a
    // keyframe is not a property — the Property Panel shows the ‹ ◆ › control
    // beside each row instead. So this title pins to nothing in
    // web/Inspector.svelte's CATEGORY_TITLES, which tests/tool_groups_test.js
    // allows for explicitly ("a tools-only group, no shared spelling to pin").
    title: "Keyframes",
    // NARROWEST SCOPE FIRST, so the destructive whole-deck one is not the first
    // thing a hand reaches for. Same reason the Inspector puts a widget's own rows
    // above the universal ones: the local edit is the common case.
    rows: [
      { kind: "command", command: "remove-slide-keyframes", applies: keyframable },
      { kind: "command", command: "make-static", applies: keyframable },
    ],
  },
];

// IMPORT-TIME CONSISTENCY GATE, the same doctrine as the effects gate above (and
// render_settings.js's precedent): a malformed tool must fail at boot, never ship
// as a mystery button.
//
// WHAT IT NO LONGER CHECKS, and where that check went. It used to demand a `help`
// and a `requires` STRING on every row. Both now live on the command entry, which
// is the only copy any surfacing reads — so demanding them here would be
// demanding a second copy, and a check that can only see the copy cannot tell you
// the original is missing. The mandate moved to tests/tool_surfacing_probe.js,
// which asks the LIVE registry, and which also checks the direction nothing ever
// checked: that a widget-scoped command reaches the pane at all.
{
  const groupIds = new Set();
  const commandIds = new Set();
  for (const group of TOOL_POOL) {
    if (!group.id || !group.title || !Array.isArray(group.rows) || group.rows.length === 0)
      throw new Error(`core/registry TOOL_POOL: malformed group (need id, title, non-empty rows): ${JSON.stringify(group).slice(0, 120)}`);
    if (groupIds.has(group.id)) throw new Error(`core/registry TOOL_POOL: duplicate group id "${group.id}"`);
    groupIds.add(group.id);
    for (const row of group.rows) {
      if (row.kind !== "command")
        throw new Error(`core/registry TOOL_POOL: group "${group.id}" row kind "${row.kind}" — the pool holds command tools only (preset rows come from a plugin's own families)`);
      if (typeof row.command !== "string" || !row.command)
        throw new Error(`core/registry TOOL_POOL: group "${group.id}" has a row with no command id — a tool row is a SURFACING of a registry entry and has nothing to render without one`);
      if (typeof row.applies !== "function")
        throw new Error(`core/registry TOOL_POOL: group "${group.id}" row "${row.command}" needs an applies(plugin) predicate — a row that quietly omits one is claiming universality without saying so; use everyWidget when that claim is genuinely true`);
      if (commandIds.has(row.command)) throw new Error(`core/registry TOOL_POOL: command "${row.command}" appears twice — a tool must be defined once`);
      commandIds.add(row.command);
    }
  }
}

/**
 * Pure function. A plugin's PRESET FAMILIES, normalized. A family is a set of
 * named property-sets over a DISJOINT slice of the widget's knobs, so families
 * COMPOSE rather than clobber: pick a Mandelbrot location, then independently a
 * palette, then a performance level, and each pick rewrites only its own keys
 * (app.applyPreset writes exactly the keys in `preset.props`).
 *
 * Two declaration forms, one resolved shape:
 *   presets: [{name, description, props}]        → ONE family, titled "Presets"
 *   presetFamilies: [{id, title, presets}]       → N families, each its own group
 * Declaring both is a contradiction about how many families the widget has, so
 * it throws rather than silently preferring one.
 *
 * @param {object} plugin - a widget plugin
 * @returns {Array<{id: string, title: string, presets: Array}>}
 *
 * @example presetFamiliesOf({presets: [{name: "Cinematic", props: {glow: 1}}]})
 * // [{id: "presets", title: "Presets", presets: [{name: "Cinematic", props: {glow: 1}}]}]
 * @example presetFamiliesOf({presetFamilies: [{id: "location", title: "Location", presets: []}]})
 * // [{id: "presets.location", title: "Location", presets: []}]
 * @example presetFamiliesOf({}) // [] (no presets — the widget shows no preset group at all)
 */
export function presetFamiliesOf(plugin) {
  const single = plugin.presets ?? null;
  const many = plugin.presetFamilies ?? null;
  if (single && many)
    throw new Error(`Plugin "${plugin.type}" declares BOTH presets and presetFamilies — use presetFamilies alone (one family is a family of one)`);
  if (single) return [{ id: "presets", title: "Presets", presets: single }];
  if (!many) return [];
  const seen = new Set();
  return many.map((fam) => {
    if (!fam.id || !fam.title || !Array.isArray(fam.presets))
      throw new Error(`Plugin "${plugin.type}" preset family is malformed (need id, title, presets): ${JSON.stringify(fam).slice(0, 120)}`);
    if (seen.has(fam.id)) throw new Error(`Plugin "${plugin.type}" declares preset family "${fam.id}" twice`);
    seen.add(fam.id);
    // NAMESPACED, so a family id can never collide with a pool group id and
    // merge preset cards into someone else's command section.
    return { id: `presets.${fam.id}`, title: fam.title, presets: fam.presets };
  });
}

/**
 * Pure function. The Tools-pane groups this plugin exposes: its own preset
 * families, then its own declared `toolGroups`, then every pool group it is
 * eligible for — each group carrying only the rows that APPLY, and any group
 * left with no rows dropped entirely.
 *
 * Merging is BY GROUP ID, so a widget that declares its own "positioning" tool
 * gets it beside the two frame-bind tools in ONE Positioning section rather than
 * a second section with the same heading. A plugin joining a POOL group may
 * therefore OMIT the title and inherit the pool's — re-spelling "Edit" in every
 * plugin that adds a row to it would be a heading free to disagree with itself,
 * and it is only a title a plugin needs when it is opening a section of its own.
 *
 * @param {object} plugin - a widget plugin
 * @returns {Array<{id: string, title: string, rows: Array}>}
 *
 * @example toolGroupsOf({type: "blur", defaults: {blur: 4}, capabilities: {}}).map((g) => g.id)
 * // ["grouping", "edit", "keyframes"]   (no frame → no Positioning, no Arrange;
 * //                                      but it can still be grouped, copied and keyed)
 * @example toolGroupsOf({type: "blur", defaults: {}, capabilities: {}}).map((g) => g.id)
 * // ["grouping", "edit"]   (nothing to key either — only the item-level tools survive)
 * @example toolGroupsOf({type: "rect", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}}).map((g) => g.title)
 * // ["Positioning", "Arrange", "Grouping", "Edit", "Keyframes"]
 * @example toolGroupsOf({type: "flare", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}, presets: [{name: "Cinematic", props: {}}]}).map((g) => g.id)
 * // ["presets", "positioning", "arrange", "grouping", "edit", "keyframes"]  (plugin-owned first, inherited last)
 */
export function toolGroupsOf(plugin) {
  const groups = [];
  /** Command (mutates groups). Appends rows under `id`, merging into an existing
   *  group of that id; a group with no rows is never created. */
  const add = (id, title, rows) => {
    if (rows.length === 0) return;
    const existing = groups.find((g) => g.id === id);
    if (existing) existing.rows = [...existing.rows, ...rows];
    else groups.push({ id, title, rows });
  };

  for (const fam of presetFamiliesOf(plugin))
    add(fam.id, fam.title, fam.presets.map((preset) => ({ kind: "preset", preset })));

  for (const group of plugin.toolGroups ?? []) {
    // A title is inherited when the group JOINS a pool section and mandatory when
    // it opens a new one — an unnamed section nobody else named has no heading.
    const title = group.title ?? TOOL_POOL.find((g) => g.id === group.id)?.title;
    if (!group.id || !title || !Array.isArray(group.rows))
      throw new Error(`Plugin "${plugin.type}" tool group is malformed (need id, rows, and a title unless it joins a pool group): ${JSON.stringify(group).slice(0, 120)}`);
    for (const row of group.rows) {
      if (row.kind !== "command")
        throw new Error(`Plugin "${plugin.type}" tool group "${group.id}" row kind "${row.kind}" — a plugin declares command rows; preset rows come from its preset families`);
      if (typeof row.command !== "string" || !row.command)
        throw new Error(`Plugin "${plugin.type}" tool group "${group.id}" has a row with no command id (see TOOL_POOL's gate for why)`);
    }
    add(group.id, title, group.rows.filter((row) => !row.applies || row.applies(plugin)));
  }

  for (const group of TOOL_POOL)
    add(group.id, group.title, group.rows.filter((row) => row.applies(plugin)));

  return groups;
}

/**
 * Pure function. A plugin with its resolved `toolGroups` attached — the
 * registered form web/ToolsPane.svelte reads. The source plugin object is never
 * mutated (two live documents share the same plugin modules), matching
 * withUniversalEffects.
 *
 * @param {object} plugin - a widget plugin as authored
 * @returns {object} an augmented copy of it
 *
 * @example withToolGroups({type: "rect", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}}).toolGroups[0].id // "positioning"
 * @example withToolGroups({type: "blur", defaults: {blur: 4}, capabilities: {}}).toolGroups.map((g) => g.id) // ["grouping", "edit", "keyframes"]
 */
export function withToolGroups(plugin) {
  return { ...plugin, toolGroups: toolGroupsOf(plugin) };
}

/**
 * The keys `register()` DERIVES onto a plugin, so the registered object is never
 * `===` (nor deep-equal) to the authored one.
 *
 * WHY THIS IS EXPORTED. The registry is now the place where plugin SHAPE grows —
 * withUniversalEffects added `effectsInjected` (+ augmented defaults/inspector/
 * cullMargin), withToolGroups added `toolGroups` — and each addition silently
 * invalidates any assertion comparing a registered plugin against its source.
 * tests/qrcode_test.js hit exactly that: `assert.equal(registry.get("qrcode"),
 * qrcodePlugin)` had been passing only because the QR widget composes the effects
 * bundle ITSELF, so the injector handed it back untouched and identity happened to
 * hold; for the 25 injected plugins it was already false. Naming the derived keys
 * HERE, beside the code that derives them, is what lets that test keep an exact
 * whole-object assertion instead of a loose one — and keep it through the next
 * trick the registry learns, with one line changed in one place.
 *
 * NOTE the asymmetry: for a plugin that composes the effects bundle itself, the
 * registered form is the authored form PLUS these keys and nothing else. For an
 * INJECTED plugin, `defaults` / `inspector` / `cullMargin` are additionally
 * AUGMENTED (that being the whole point), so removing these keys does not
 * reconstruct the authored object.
 */
export const REGISTRY_DERIVED_KEYS = ["effectsInjected", "toolGroups"];

/**
 * The authored keys `register()` REPLACES rather than adds — the third category
 * the note above already described without naming: an authored hook whose
 * registered form is a DERIVED wrapper around it.
 *
 * `anchors` is one because of THE INK RULE (core/derive.js withInkAnchors): the
 * registered hook calls the authored one and then projects the eight standard rim
 * anchors onto the widget's own silhouette. Note this holds even where the
 * projection is the IDENTITY — a plain box's anchor POSITIONS are unchanged, but
 * the function object is a different one, so an equality check against the
 * authored plugin sees a difference with no difference in behaviour. That is
 * exactly the false alarm this constant exists to let a test spell out
 * (tests/qrcode_test.js is the whole-object comparison in question).
 *
 * Kept SEPARATE from REGISTRY_DERIVED_KEYS because the two ask different
 * questions of a registered plugin — "what appeared?" versus "what was wrapped?" —
 * and a test that conflated them could not assert either one exactly.
 */
export const REGISTRY_REWRITTEN_KEYS = ["anchors"];

export function createRegistry() {
  const plugins = new Map();
  return {
    /** Command. Registers a plugin, resolved into its registered form: the
     *  universal effects bundle injected when it is eligible and did not compose
     *  it itself (withUniversalEffects), then its Tools-pane groups resolved from
     *  the tool pool + its own declarations (withToolGroups), and its standard
     *  rim anchors projected onto its own silhouette (withInkAnchors — THE INK
     *  RULE). Loud on collision or malformed plugin. */
    register(plugin) {
      for (const field of ["type", "title", "capabilities", "defaults", "emit", "ephemeral"])
        if (!(field in plugin)) throw new Error(`Plugin missing "${field}": ${plugin.type ?? "?"}`);
      // EPHEMERALITY IS THE SIXTH THING A WIDGET MUST SAY ABOUT ITSELF (user
      // ruling: "not just a convention but structurally part of the definition of
      // a widget"). It is in the required list rather than defaulted because a
      // default of NONE is exactly how the defect arrived: waiting was OPT-IN,
      // two families opted in, and every other async widget silently shipped a
      // hole into every export. A consumer cannot wait for what it has not heard
      // of, so the widget must speak. See core/ephemeral.js for what settling is
      // and why there are three answers.
      if (!isEphemeralDecl(plugin.ephemeral))
        throw new Error(
          `Plugin "${plugin.type}" has a malformed \`ephemeral\` declaration: ${JSON.stringify(plugin.ephemeral)}. ` +
          `Say "${EPHEMERAL.NONE}" (no cheap tier — correct on the first frame, which is every vector shape), ` +
          `{kind: "${EPHEMERAL.CONVERGES}", settled(state, ctx)} (a cheap tier or async source that reaches a fixed point — PDF, image, LaTeX, scene3d), ` +
          `or "${EPHEMERAL.NEVER}" (genuinely non-converging, like the video player's own clock). ` +
          `CONVERGES must carry settled(): declaring convergence without saying how a consumer knows is the opt-in failure this field replaces.`);
      if (plugins.has(plugin.type)) throw new Error(`Duplicate plugin type "${plugin.type}"`);
      // A MISSPELLED MENU IS A WIDGET NOBODY CAN INSERT, and it fails silently:
      // `insertMenu: "shapes"` reads as deliberate and puts the widget in no menu
      // at all. Refuse it at registration, the same doctrine as the tool pool's
      // import gate.
      if (plugin.insertMenu !== undefined && !INSERT_MENUS.includes(plugin.insertMenu))
        throw new Error(`Plugin "${plugin.type}" declares insertMenu "${plugin.insertMenu}" — the menus are: ${INSERT_MENUS.join(", ")}`);
      // TWO WIDGETS CLAIMING ONE DROPPED KIND IS AMBIGUOUS, and the ambiguity
      // would resolve itself SILENTLY by registration order — the loser simply
      // never receives a drop, with nothing said. Same doctrine as the menu gate
      // above: refuse it where it is written, not where it is felt. (The kind
      // STRING is not whitelisted here, because the vocabulary lives in the asset
      // classifier and a copy of it would be the very mirror this field removes;
      // tests/asset_drop_test.js gates the spelling against that classifier.)
      if (plugin.assetDrop !== undefined) {
        if (typeof plugin.assetDrop !== "string" || plugin.assetDrop === "")
          throw new Error(`Plugin "${plugin.type}" declares a malformed assetDrop: ${JSON.stringify(plugin.assetDrop)} — it must be an asset kind, e.g. "image"`);
        const taken = [...plugins.values()].find((p) => p.assetDrop === plugin.assetDrop);
        if (taken) throw new Error(`Plugin "${plugin.type}" claims dropped "${plugin.assetDrop}" assets, but "${taken.type}" already does — exactly one widget may be what a dropped ${plugin.assetDrop} becomes`);
      }
      plugins.set(plugin.type, withToolGroups(withUniversalEffects(withInkAnchors(plugin))));
    },
    /** Query. Plugin by type; loud when unknown. */
    get(type) {
      const p = plugins.get(type);
      if (!p) throw new Error(`Unknown widget type "${type}". Registered: ${[...plugins.keys()].join(", ")}`);
      return p;
    },
    /** Query. All plugins, registration order. */
    all() {
      return [...plugins.values()];
    },
  };
}
