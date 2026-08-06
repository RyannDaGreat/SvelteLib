/**
 * OUTPUT PROPERTIES — the values a widget PUBLISHES rather than stores.
 *
 * User, 2026-08-06: node outputs should be properties, and *"other nodes can then
 * read these properties"*. Today they cannot: `evaluateNodeGraph` runs inside
 * `deriveRenderTree`, strictly AFTER `evaluateState`, so an output reaches `emit()`
 * and nothing else. This module is the declaration side of the fix; the ORDERING
 * half lives in core/expressions.js, which pulls these lazily during the equation
 * pass (see `nodeOutputResolver` in core/nodeflow.js).
 *
 * ── EVALUATED, NEVER STORED (manifest R7-7 ruling) ──────────────────────────
 * An output property is computed onto the EVALUATED item state and never written to
 * the document. It follows core/content_size.js exactly — injected onto the
 * evaluated item, read through the ORDINARY `{kind:"prop"}` resolver, so
 * `= knob1.out` and `= self.node_height` need no new grammar, no new stored bytes
 * and no migration.
 *
 * The two rejected precedents, named so nobody re-picks them:
 *   plugins/video_scrub.js's `self.…` equation-string DEFAULTS work and are
 *   discoverable, but they ARE stored state — keyframable (meaningless for a
 *   read-only value) and backfilled into every old document on load.
 *   `cx`/`cy` is a hardcoded branch in refValue plus a hand-appended autocomplete
 *   entry — one concept spelled twice, which is the Tower of Babel this project
 *   keeps paying for.
 * A READ-ONLY VALUE THAT CAN BE KEYFRAMED IS A LIE ABOUT ITS OWN AFFORDANCE, by the
 * same reasoning that keeps the save dot from being a button.
 *
 * ── THE TWO TIERS (manifest R7-7 BOUNDARY) ──────────────────────────────────
 * TIER 1 — EVERY output port is declared and REFERENCEABLE. A reference is ordinary
 * keyframable property state: `inputs.frequency = {item, port}`. Audio outputs
 * absolutely appear here — if they were not referenceable no patch could be wired at
 * all.
 * TIER 2 — SOME outputs additionally expose an equation-readable VALUE. A knob's is
 * document state, so `= knob1.out` is a number. An audio-rate signal has none:
 * sampling an LFO's instantaneous amplitude would make it frame-rate dependent,
 * ephemeral and non-reproducible. Reading one is REFUSED WITH A SENTENCE — never 0,
 * never a stale sample.
 * The tier follows from the port's declared TYPE (`PORT_TYPES[t].readable`), so it
 * is DERIVED rather than a second hand-maintained list.
 *
 * ── TWO PRODUCERS, ONE SURFACE ──────────────────────────────────────────────
 *   1. NODE PORTS. Every output port declared by `plugin.ports(state)`. Its value
 *      is what `plugin.computeOutputs` produced for that key.
 *   2. `plugin.outputProps` — a STATIC map `{name: {label, kind, help, value}}` of
 *      derived facts that are not ports, where `value` is a pure `(state) => v`.
 *      This is what a node's natural size (manifest R7-21:
 *      `w = "= self.node_width"`) is built on.
 * Both land in one namespace, get one Inspector section, and are read the same way.
 *
 * ── WHY THAT MAP IS STATIC AND ITS VALUES ARE PER-NAME THUNKS ───────────────
 * Not a style choice — an eager `outputProps(state) -> [{name, value}]` produced a
 * FALSE CYCLE on the first real consumer, and the shape is what fixes it. R7-21
 * defaults a node's `w` to "= self.node_width" and its `h` to "= self.node_height",
 * and a node's natural HEIGHT legitimately depends on the resolved WIDTH (a knob
 * band wraps). Answering `node_width` by computing every descriptor would run
 * `node_height`'s producer too, which reads `w` — the slot currently evaluating —
 * and the equation pass would report a legitimate DAG as a cycle. With a per-name
 * thunk, asking for one output computes exactly one. A REAL cycle still lands in
 * requireSlot and is still loud.
 *
 * ── THE NAME GATE, AND WHY IT IS LOUD ───────────────────────────────────────
 * Output properties live at the TOP LEVEL of the evaluated item state (`self.out`,
 * `self.node_width`) rather than under a namespace object, because that is the
 * spelling the manifest fixes for both consumers. So a name that collides with a
 * key the plugin actually STORES would silently shadow real document state. That is
 * refused LOUDLY, here, the first time anything asks — the same treatment
 * `declaredPorts` gives an unknown port type, and for the same reason: it is a
 * plugin-authoring mistake that must not be discoverable only as a wrong picture.
 *
 * Against a stored key the plugin does NOT declare — a DORMANT key left behind by
 * core/retype.js Rule 3 — the output property WINS. The gate above proves such a
 * key is not part of the current type's schema, so resurrecting it would be reading
 * a previous widget's data.
 */

import { declaredPorts, EXEC_TYPE, PORT_TYPES, portReadable } from "./nodeflow.js";

/** The Inspector category an item's output rows file under — the read-only mirror
 *  of nodeflow's INPUTS_CAT, so a patch's two halves sit in two adjacent groups. */
export const OUTPUTS_CAT = "outputs";

/**
 * Pure function. THE DECLARATION of every output property an item exposes, in a
 * stable order: its declared node output PORTS first (declaration order), then
 * whatever `plugin.outputProps` adds. NO VALUES ARE COMPUTED — see the header for
 * why asking for one must not compute the others.
 *
 * A descriptor is `{name, label, kind, readable, source, portType, help}`:
 *   readable  can the DOCUMENT hold this value at all (tier 2)? A tier-1 signal
 *             port is `false` and reading it is refused with a sentence.
 *   source    "port" | "prop" — which producer declared it (the Inspector shows a
 *             port's type; a derived fact has none).
 *
 * THROWS on an unusable name (see checkNames).
 *
 * @param {object} plugin - the item's plugin
 * @param {object} state - the item's evaluated state (a port list may vary with it)
 * @returns {object[]} descriptors, deterministic order
 *
 * @example // a knob's single number output:
 * @example const knob = {type: "k", defaults: {value: 0.5}, ports: () => ({outputs: [{key: "out", type: "number", label: "out"}]})};
 * @example outputPropertyDescriptors(knob, {})[0].name // "out"
 * @example outputPropertyDescriptors(knob, {})[0].readable // true
 * @example // an audio output is declared and referenceable, but carries no value:
 * @example const lfo = {type: "l", defaults: {}, ports: () => ({outputs: [{key: "out", type: "audio", label: "out"}]})};
 * @example outputPropertyDescriptors(lfo, {})[0].readable // false
 * @example // a widget with no outputs at all contributes nothing:
 * @example outputPropertyDescriptors({type: "rect", defaults: {}}, {}) // []
 * @example // AN EXEC OUTPUT IS NOT AN OUTPUT PROPERTY — see the filter's comment:
 * @example const ev = {type: "e", defaults: {}, ports: () => ({outputs: [{key: "then", type: "exec"}]})};
 * @example outputPropertyDescriptors(ev, {}) // []
 */
export function outputPropertyDescriptors(plugin, state) {
  const s = state ?? {};
  // AN EXEC OUTPUT IS EXCLUDED OUTRIGHT, and the distinction from `audio` is the
  // whole reason this is a filter rather than a third tier. An audio output HAS a
  // value the document may not read, so listing it with a refusal sentence is
  // informative. An exec output has no value in any domain — it is control flow —
  // so a row saying "this has no value the document can read" would be a true
  // sentence pointing at the wrong problem, and its `= ev.then` would look like a
  // read that merely failed rather than a category error. Exec outputs get their
  // OWN editable row instead (core/nodeflow.execOutputRows), which is where the
  // author actually wants to be.
  const fromPorts = declaredPorts(plugin, s).outputs.filter((p) => p.type !== EXEC_TYPE).map((p) => ({
    name: p.key,
    label: p.label,
    kind: PORT_KIND[p.type] ?? "text",
    readable: portReadable(p.type),
    source: "port",
    portType: p.type,
    help: portReadable(p.type)
      ? `This node's ${PORT_TYPES[p.type].label} output. Wire it to another node's input, or read its value from any equation as "= <name>.${p.key}". It is computed, not stored, so it cannot be typed into or keyframed.`
      : `This node's ${PORT_TYPES[p.type].label} output. Wire it to another node's ${PORT_TYPES[p.type].label} input. ${SIGNAL_REASON}`,
  }));
  const fromProps = Object.entries(plugin?.outputProps ?? {}).map(([name, d]) => ({
    name,
    label: d.label ?? name,
    kind: d.kind ?? "number",
    readable: true,
    source: "prop",
    portType: null,
    help: d.help ?? `A value this widget computes from its own state. Read it from any equation as "= self.${name}". It is computed, not stored, so it cannot be typed into or keyframed.`,
  }));
  const all = [...fromPorts, ...fromProps];
  checkNames(plugin, all);
  return all;
}

/**
 * Query→value (a port descriptor reads the supplied outputs map; a derived one runs
 * the plugin's producer, which may read state the caller settles on demand). THE
 * value of ONE output property, or `undefined` when its producer made none.
 *
 * UNDEFINED IS NOT ZERO: an audio module's `trigger` output is typed readable but
 * its pulse train lives in the engine, so it produces nothing, and saying so is the
 * honest answer (outputValueProblem turns it into a sentence).
 *
 * @param {object} plugin - the item's plugin
 * @param {object} state - the item's evaluated state
 * @param {object} descriptor - one from outputPropertyDescriptors
 * @param {object|null} [outputs] - the port values `computeOutputs` produced, if known
 * @returns {*} the value, or undefined
 *
 * @example const knob = {type: "k", defaults: {value: 0.5}, ports: () => ({outputs: [{key: "out", type: "number"}]})};
 * @example outputPropertyValue(knob, {}, outputPropertyDescriptors(knob, {})[0], {out: 0.25}) // 0.25
 * @example outputPropertyValue(knob, {}, outputPropertyDescriptors(knob, {})[0], null) // undefined (nothing computed it)
 * @example // a derived fact runs its own producer against the item's state:
 * @example const node = {type: "n", defaults: {w: 80}, outputProps: {node_width: {value: (s) => s.w * 2}}};
 * @example outputPropertyValue(node, {w: 80}, outputPropertyDescriptors(node, {})[0]) // 160
 */
export function outputPropertyValue(plugin, state, descriptor, outputs = null) {
  if (!descriptor.readable) return undefined;
  if (descriptor.source === "port") return outputs?.[descriptor.name];
  return plugin.outputProps[descriptor.name].value(state ?? {});
}

/** Row kind per port type, so an output row renders in the vocabulary every other
 *  row uses (core/properties.js ROW_KINDS) rather than inventing a display type.
 *  A `node`-typed output publishes a REFERENCE, which is exactly what the node-input
 *  row kind already renders — the tier-1 property TYPE, reused rather than remade. */
const PORT_KIND = Object.freeze({ number: "number", trigger: "number", audio: "text", node: "nodeinput" });

/** The sentence a tier-1 read is refused with. One string, because the Inspector's
 *  help and the equation error must say the same thing — a reader who saw one and
 *  then hit the other must not have to reconcile two explanations. */
export const SIGNAL_REASON =
  "An audio signal lives on the browser's audio thread and the document never sees its value; sampling it per frame would make the picture depend on the frame rate. Read a knob or a Number node instead.";

/**
 * Query (throws). The two ways an output property's NAME can be unusable, refused
 * loudly the first time anything asks — the treatment `declaredPorts` gives an
 * unknown port type, because both are plugin-authoring mistakes that must not be
 * discoverable only as a wrong picture.
 *
 *   1. It collides with a key the plugin STORES (see the header).
 *   2. It is not canonical DISPLAY spelling. `checkCanonicalPath`
 *      (core/expressions.js) REFUSES a camelCase segment typed into an equation, so
 *      an output named `nodeWidth` could never be read by the thing it exists for.
 *      Snake_case is not a style preference here; it is reachability.
 */
function checkNames(plugin, descriptors) {
  const defaults = plugin?.defaults ?? {};
  for (const d of descriptors) {
    if (Object.prototype.hasOwnProperty.call(defaults, d.name))
      throw new Error(`output_properties: "${plugin?.type}" publishes an output named ${JSON.stringify(d.name)}, but it also STORES a property of that name — the output would silently shadow the stored value. Rename one of them.`);
    if (!CANONICAL_NAME_RE.test(d.name))
      throw new Error(`output_properties: "${plugin?.type}" publishes an output named ${JSON.stringify(d.name)}, which is not canonical snake_case — an equation cannot spell it (core/expressions.js checkCanonicalPath refuses a camelCase segment).`);
  }
}

/** Canonical display spelling for a referenceable name: lower-case, digits and
 *  underscores, starting with a letter — the same shape a variable name and an item
 *  slug must have. */
const CANONICAL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Pure function. The output-property descriptor a path names, or null. Only a
 * ONE-SEGMENT path can be one: an output property is a leaf published at the top
 * level of the evaluated item, so `self.out.x` is not an output property and falls
 * through to the ordinary "has no property" report.
 *
 * @param {object} plugin - the item's plugin
 * @param {object} state - the item's evaluated state
 * @param {string[]} rel - the path BELOW the item (e.g. ["out"])
 * @returns {object|null} the descriptor, or null
 *
 * @example const knob = {type: "k", defaults: {value: 0.5}, ports: () => ({outputs: [{key: "out", type: "number"}]})};
 * @example outputPropertyAt(knob, {}, ["out"]).source // "port"
 * @example outputPropertyAt(knob, {}, ["value"]) // null (a STORED property, not an output)
 * @example outputPropertyAt(knob, {}, ["out", "x"]) // null (an output property is a leaf)
 */
export function outputPropertyAt(plugin, state, rel) {
  if (!plugin || rel.length !== 1) return null;
  return outputPropertyDescriptors(plugin, state).find((d) => d.name === rel[0]) ?? null;
}

/**
 * Pure function. WHY this output property has no value an equation can read, or
 * null when it has one. THE one refusal sentence, so the equation error and the
 * Inspector's help cannot drift.
 *
 * It completes "… — <sentence>", stating a fact about the DOCUMENT rather than about
 * the code, exactly as `nodeRefProblem` does.
 *
 * @param {object} descriptor - one from outputPropertyDescriptors
 * @param {*} value - what outputPropertyValue answered for it
 * @returns {string|null}
 *
 * @example outputValueProblem({name: "out", readable: true}, 3) // null
 * @example outputValueProblem({name: "out", readable: false, portType: "audio", source: "port"}, undefined)
 * @example // '"out" is an Audio output, which has no value the document can read — An audio signal lives on…'
 * @example outputValueProblem({name: "out", readable: true, source: "port"}, undefined)
 * @example // '"out" is an output port this widget publishes no value on — its value is produced outside the document (the audio engine), so only a wire can carry it'
 */
export function outputValueProblem(descriptor, value) {
  if (!descriptor.readable)
    return `${JSON.stringify(descriptor.name)} is an ${PORT_TYPES[descriptor.portType].label} output, which has no value the document can read — ${SIGNAL_REASON}`;
  if (value === undefined)
    return `${JSON.stringify(descriptor.name)} is an output port this widget publishes no value on — its value is produced outside the document (the audio engine), so only a wire can carry it`;
  return null;
}

/**
 * Query→value (runs each derived producer against `state`). The `{name: value}` map
 * to inject onto an EVALUATED item state — only the outputs that actually have a
 * value. AN OUTPUT WITH NO VALUE INJECTS NOTHING rather than a zero, which is the
 * core/content_size.js rule and for the same reason: an absent key fails loudly
 * through the normal "has no property" path, while a 0 is a plausible wrong number
 * that no one ever notices.
 *
 * @param {object} plugin - the item's plugin
 * @param {object} state - the item's evaluated state
 * @param {object|null} [outputs] - the port values `computeOutputs` produced, if known
 * @returns {object} the injectable map (empty when nothing is readable)
 *
 * @example const knob = {type: "k", defaults: {value: 0.5}, ports: () => ({outputs: [{key: "out", type: "number"}]})};
 * @example outputPropertyInjection(knob, {}, {out: 3}) // {out: 3}
 * @example outputPropertyInjection(knob, {}, null) // {} (nothing computed it — absent, never 0)
 * @example const lfo = {type: "l", defaults: {}, ports: () => ({outputs: [{key: "out", type: "audio"}]})};
 * @example outputPropertyInjection(lfo, {}, {out: 1}) // {} (a signal injects nothing, never 0)
 */
export function outputPropertyInjection(plugin, state, outputs = null) {
  const out = {};
  for (const d of outputPropertyDescriptors(plugin, state)) {
    const v = outputPropertyValue(plugin, state, d, outputs);
    if (v !== undefined) out[d.name] = v;
  }
  return out;
}

/**
 * Pure function. THE INSPECTOR ROWS for an item's output properties — one per
 * descriptor, all `readOnly`.
 *
 * ── AN OUTPUT ROW IS A REPORT, NOT A CONTROL ────────────────────────────────
 * `readOnly: true` is what makes it one, and the Inspector renders such a row as a
 * value with no editor, no `=` affordance and no keyframe diamonds. That is the
 * save-dot ruling applied to a row: a field the author can click into but that
 * discards what they type would be a lie about its own affordance. A tier-1 signal
 * row still appears — it names a port the author can WIRE — and carries the refusal
 * sentence in its help, so the panel never asserts by omission that a node has no
 * outputs.
 *
 * ── WHAT MULTI-SELECTION DOES AND DOES NOT DO WITH THESE ────────────────────
 * These rows are appended at the SINGLE-selection seam (web/Inspector.svelte's
 * itemCategories), so they do not enter the multi-selection intersection today —
 * the outputs section is a per-item report, and N items have N different values.
 * Two things make that a boundary rather than a hole:
 *   `readOnly` is deliberately NOT added to core/multiselect.js's
 *   PRESENTATIONAL_ROW_ASPECTS. That denylist treats every unnamed aspect as
 *   CONTRACT, so two widgets whose same-key row disagreed about being read-only
 *   would surface as a NAMED conflict rather than a silent unification.
 *   And `jointEditProblem` refuses a read-only row outright, ahead of the kind
 *   table — necessary because the kind here is an ordinary "number", which that
 *   table would classify as jointly editable.
 *
 * THE VALUE IS READ OFF THE STATE, NOT RECOMPUTED. `state` is the EVALUATED item,
 * onto which core/expressions.js has already injected every readable output — so the
 * panel shows exactly the number the equations saw, rather than a second answer from
 * a second evaluation that could differ by a frame.
 *
 * @param {object} plugin - the item's plugin
 * @param {object} state - the item's EVALUATED state (outputs already injected)
 * @returns {object[]} Inspector row descriptors
 *
 * @example const knob = {type: "k", defaults: {value: 0.5}, ports: () => ({outputs: [{key: "out", type: "number", label: "out"}]})};
 * @example outputPropertyRows(knob, {out: 0.5})[0].key // "out"
 * @example outputPropertyRows(knob, {out: 0.5})[0].readOnly // true
 * @example outputPropertyRows(knob, {out: 0.5})[0].category // "outputs"
 * @example outputPropertyRows(knob, {out: 0.5})[0].keyframes // false
 * @example outputPropertyRows(knob, {out: 0.5})[0].unreadable // null (there is a value to show)
 * @example // an audio output still gets a row — it names a port the author can WIRE:
 * @example const lfo = {type: "l", defaults: {}, ports: () => ({outputs: [{key: "out", type: "audio", label: "out"}]})};
 * @example typeof outputPropertyRows(lfo, {})[0].unreadable // "string" (the reason, never a blank)
 * @example outputPropertyRows({type: "rect", defaults: {}}, {}) // []
 */
export function outputPropertyRows(plugin, state) {
  const s = state ?? {};
  return outputPropertyDescriptors(plugin, s).map((d) => ({
    key: d.name,
    label: d.label,
    kind: d.kind,
    category: OUTPUTS_CAT,
    readOnly: true,
    // A computed value has no keyframe: there is no stored leaf to write one to.
    // Stated as well as implied by readOnly, because core/section_keyframes.js reads
    // this aspect directly when it collects a whole section's paths.
    keyframes: false,
    portType: d.portType,
    help: d.help,
    // The sentence for a row with nothing to show. Null when the value is there —
    // so the Inspector renders EITHER a value OR a reason, and never a blank.
    unreadable: outputValueProblem(d, s[d.name]),
  }));
}
