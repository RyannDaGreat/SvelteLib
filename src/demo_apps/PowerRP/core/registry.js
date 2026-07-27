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
        help: "Write x / y / w / h as equations reading THE camera's frame, so this widget covers the view and keeps tracking it when the camera moves, resizes or zooms.",
        requires: "a selected widget with its own position and size (x / y / w / h) — the camera itself cannot be bound to its own frame",
      },
      {
        kind: "command",
        command: "unbind-from-camera",
        applies: frameBindable,
        help: "Replace equation-bound x / y / w / h with the plain numbers they currently evaluate to, so the widget stops following whatever it was bound to and stays put.",
        requires: "at least one of x / y / w / h to actually hold an equation — nothing here is bound, they are all plain numbers already",
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
 * @example toolGroupsOf({type: "blur", defaults: {blur: 4}, capabilities: {}})
 * // [] (no frame → no camera-bind rows → the Positioning group is dropped)
 * @example toolGroupsOf({type: "rect", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}}).map((g) => g.title)
 * // ["Positioning"]
 * @example toolGroupsOf({type: "flare", defaults: {x: 0, y: 0, w: 1, h: 1}, capabilities: {}, presets: [{name: "Cinematic", props: {}}]}).map((g) => g.id)
 * // ["presets", "positioning"]   (plugin-owned first, inherited last)
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
 * @example withToolGroups({type: "blur", defaults: {blur: 4}, capabilities: {}}).toolGroups // []
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
