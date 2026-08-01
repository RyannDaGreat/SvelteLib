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
 *     anchors(state) → [{id, x, y}]         // preset anchor points, LOCAL coords
 *     closestAnchor?(state, wx, wy)         // computed anchor: closest point on
 *                                           // outline to a WORLD point (local out)
 *     snapFeatures?(state) → [...]          // extra snap features (LOCAL); bbox
 *                                           // widgets get standard ones for free
 *     localBounds?(state) → {x,y,w,h}       // BOUNDS protocol (core/view.js
 *                                           // localBoundsOf): the LOCAL rect this
 *                                           // widget's INK occupies. Absent →
 *                                           // {0,0,w,h} for a `bbox` widget, null
 *                                           // for anything else (= genuinely
 *                                           // unboundable; blur alone). Culling,
 *                                           // band select and the copy/export
 *                                           // capture rect all read THIS, so a
 *                                           // two-point widget (line/arrow/...)
 *                                           // declares its endpoint hull here
 *                                           // instead of being treated as having
 *                                           // no extent. NOT `cullMargin` — that
 *                                           // is the EFFECT halo around the ink.
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
 * the predicate they explain — because two surfacings need the same words. The
 * pool row below renders them in the Tools pane; the command ENTRIES in
 * web/App.svelte declare them too, so the Toolbar and the command palette's help
 * section get the same sentence without transcribing it. One string, one meaning,
 * however many places show it.
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
 * same reason the camera-bind pair's live beside `frameBindable`: the pool row
 * below and the command ENTRY in web/App.svelte both need the same words.
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
 * same reason the camera-bind pair's live beside `frameBindable`: the pool rows
 * below and the command ENTRIES in web/App.svelte both need the same words, and a
 * sentence transcribed twice is a sentence that can drift.
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
 * THE TOOL POOL — the generic tools, declared ONCE, composed into every widget
 * that is structurally eligible. Ordered: a resolved plugin lists its own groups
 * first, then these in this order.
 *
 * `help` is the hover tip and `requires` is the reason shown when the command's
 * `when` gate says no. Both are MANDATORY (the import gate below throws
 * otherwise): a tool nobody can explain, or a disabled tool that will not say
 * why, is the defect this round exists to remove — so it is not possible to add
 * one here. `requires` completes the sentence "Unavailable — requires …".
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
      {
        kind: "command",
        command: "bind-to-camera",
        applies: frameBindable,
        help: CAMERA_BIND_HELP,
        requires: CAMERA_BIND_REQUIRES,
      },
      {
        kind: "command",
        command: "unbind-from-camera",
        applies: frameBindable,
        help: CAMERA_FREEZE_HELP,
        requires: CAMERA_FREEZE_REQUIRES,
      },
      {
        // THE LIGHT PIN (manifest R6-4.5). Filed under Positioning with the
        // camera-bind pair because it is the same operation on a different pair
        // of coordinates: write one item's position keys as equations reading
        // another item's, so the first tracks the second. `lightPinnable` is
        // narrower than `frameBindable`, so the row simply does not appear on the
        // 94 widgets with no light — which is what a pool `applies` is for, and
        // is why god_rays inherits this with ZERO edits of its own.
        kind: "command",
        command: "pin-light-to-object",
        applies: lightPinnable,
        help: LIGHT_PIN_HELP,
        requires: LIGHT_PIN_REQUIRES,
      },
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
      {
        kind: "command",
        command: "remove-slide-keyframes",
        applies: keyframable,
        help: SLIDE_KEYFRAMES_HELP,
        requires: SLIDE_KEYFRAMES_REQUIRES,
      },
      {
        kind: "command",
        command: "make-static",
        applies: keyframable,
        help: MAKE_STATIC_HELP,
        requires: MAKE_STATIC_REQUIRES,
      },
    ],
  },
];

// IMPORT-TIME CONSISTENCY GATE, the same doctrine as the effects gate above (and
// render_settings.js's precedent): a tool that cannot explain itself must fail at
// boot, never ship as a mystery button. This is what makes rule 5 —
// "a disabled control explains itself" — structurally impossible to forget.
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
      for (const field of ["command", "help", "requires"])
        if (typeof row[field] !== "string" || !row[field])
          throw new Error(`core/registry TOOL_POOL: group "${group.id}" row "${row.command ?? "?"}" is missing the mandatory "${field}" string — a tool with no help, or a gated tool that will not say what it requires, must not reach the user`);
      if (typeof row.applies !== "function")
        throw new Error(`core/registry TOOL_POOL: group "${group.id}" row "${row.command}" needs an applies(plugin) predicate — a pool tool that applies to everything would put dead controls on widgets that cannot use it`);
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
 * a second section with the same heading.
 *
 * @param {object} plugin - a widget plugin
 * @returns {Array<{id: string, title: string, rows: Array}>}
 *
 * @example toolGroupsOf({type: "blur", defaults: {blur: 4}, capabilities: {}}).map((g) => g.id)
 * // ["keyframes"] (no frame → no camera-bind rows → Positioning drops; ANY state is keyframable)
 * @example toolGroupsOf({type: "blur", defaults: {}, capabilities: {}})
 * // [] (no frame AND no state: every pool group loses all its rows and none is created)
 * @example toolGroupsOf({type: "rect", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}}).map((g) => g.title)
 * // ["Positioning", "Keyframes"]
 * @example toolGroupsOf({type: "flare", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}, presets: [{name: "Cinematic", props: {}}]}).map((g) => g.id)
 * // ["presets", "positioning", "keyframes"]   (plugin-owned first, inherited last)
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
    if (!group.id || !group.title || !Array.isArray(group.rows))
      throw new Error(`Plugin "${plugin.type}" tool group is malformed (need id, title, rows): ${JSON.stringify(group).slice(0, 120)}`);
    for (const row of group.rows) {
      if (row.kind !== "command")
        throw new Error(`Plugin "${plugin.type}" tool group "${group.id}" row kind "${row.kind}" — a plugin declares command rows; preset rows come from its preset families`);
      for (const field of ["command", "help", "requires"])
        if (typeof row[field] !== "string" || !row[field])
          throw new Error(`Plugin "${plugin.type}" tool group "${group.id}" row "${row.command ?? "?"}" is missing the mandatory "${field}" string (see TOOL_POOL's gate for why)`);
    }
    add(group.id, group.title, group.rows.filter((row) => !row.applies || row.applies(plugin)));
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
 * @example withToolGroups({type: "blur", defaults: {blur: 4}, capabilities: {}}).toolGroups.map((g) => g.id) // ["keyframes"]
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

export function createRegistry() {
  const plugins = new Map();
  return {
    /** Command. Registers a plugin, resolved into its registered form: the
     *  universal effects bundle injected when it is eligible and did not compose
     *  it itself (withUniversalEffects), then its Tools-pane groups resolved from
     *  the tool pool + its own declarations (withToolGroups). Loud on collision
     *  or malformed plugin. */
    register(plugin) {
      for (const field of ["type", "title", "capabilities", "defaults", "emit"])
        if (!(field in plugin)) throw new Error(`Plugin missing "${field}": ${plugin.type ?? "?"}`);
      if (plugins.has(plugin.type)) throw new Error(`Duplicate plugin type "${plugin.type}"`);
      plugins.set(plugin.type, withToolGroups(withUniversalEffects(plugin)));
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
