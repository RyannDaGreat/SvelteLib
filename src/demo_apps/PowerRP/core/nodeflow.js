/**
 * NODE-FLOW: the general typed-port graph layer. Pure, DOM-free, audio-free.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A NODE WIDGET is an ordinary PowerRP widget whose plugin declares PORTS. It is a
 * full citizen: a document item with slides, deltas, equations, keyframes, and it
 * renders in playback like any other widget. The ONLY new thing is that its plugin
 * answers `ports(state)`, and that its state may carry CONNECTIONS naming other
 * items' output ports.
 *
 * Audio is the FIRST client of this, not the only one (user, ADDENDUM 1: "This is
 * not the only thing we'll be doing nodes for... we'll also be doing nodes for
 * materials and shapes"). So NOTHING audio-specific may appear in this file. It
 * knows about types, coercions, connections and evaluation order — never about
 * oscillators, and never about pixels either.
 *
 * ── WIRES ARE NOT WIDGETS (user ruling, ADDENDA 7 + 9, verbatim) ─────────────
 * "wires don't count as widgets. They're just a consequence of rendering two
 * different [nodes]... I don't want to junk up my widget library of random wires."
 * and "Make no mistake though, wires are still rendered, they're just not widgets."
 *
 * So there is NO wire item, NO wire plugin, and no wire id. A wire is the DERIVED
 * rendering of a CONNECTION, and a connection is a leaf of ordinary widget state.
 * Everything the document format gains from this feature is one optional object on
 * a node widget's state:
 *
 *     state.inputs = { "<inPortKey>": { item: "<sourceItemId>", port: "<outPortKey>" } }
 *
 * ── WHY THE CONNECTION LIVES ON THE INPUT SIDE ──────────────────────────────
 * An input accepts AT MOST ONE source; an output fans out to as many inputs as
 * like. Storing the connection on the input makes fan-in-1 STRUCTURAL — a second
 * connection to the same input overwrites the first, because it is the same object
 * key — instead of an invariant something has to police. The alternative (a list of
 * targets on the output) would make "two sources drive one input" spellable, and
 * then every reader would have to decide what that means.
 *
 * It also makes connections KEYFRAMABLE FOR FREE, which is the property that keeps
 * the core invariant intact. `inputs.gain` is a state leaf like any other, so a
 * patch can differ per slide, be deleted on a slide, and be undone in one unit. It
 * tweens DISCRETELY (the delta rule for non-numbers: switch at alpha > 0), which is
 * the only sane reading — half a wire is not a graph.
 *
 * The declaration `itemRefs: [["inputs", "*", "item"]]` (see nodeItemRefs below)
 * is what makes duplicate/clone remap a patch instead of leaving copies wired to
 * the originals — the same mechanism plugins/group.js uses for its members.
 *
 * ── THE TYPE TABLE, AND WHY COLOR LIVES HERE ────────────────────────────────
 * User ruling (ADDENDUM 7): "we will probably need strictly typed ports... they
 * can be coercive ports though... And they may have different colors on each node
 * to indicate that type to make it easy for the user."
 *
 * So a port TYPE carries its color, and the table is here in core rather than in
 * the CSS, because the color is consumed by THREE surfaces that must agree: the
 * canvas overlay (SVG beads and ghost wire), the painted node chrome (plugin
 * emit(), which produces a device-independent display list with literal colors and
 * has no access to CSS), and the wire layer. A CSS token cannot reach emit(); a
 * core constant reaches all three. web/app.css mirrors these as --a-port-* tokens
 * for anything that IS styled in CSS, and portTypeCssVars() below generates that
 * block so the mirror cannot drift silently.
 *
 * ── COERCION IS AN EXPLICIT TABLE, NEVER A RULE ─────────────────────────────
 * Every allowed cross-type connection is one entry in COERCIONS with a function
 * and a sentence. An absent pair is INCOMPATIBLE and the drop is REFUSED with that
 * fact stated — never silently ignored, and never silently coerced by some
 * "reasonable" fallback. The reason it is a table and not, say, a subtype lattice:
 * coercion is a design judgement per pair (`trigger → number` is 0/1, but
 * `number → trigger` is a rising-edge DETECTION, which is a completely different
 * operation that happens to run in the same slot), and a lattice would silently
 * invent the pairs nobody thought about.
 *
 * ── CYCLES: REFUSED AT CONNECT TIME (decision + why) ────────────────────────
 * The blueprint left this open. THE RULING TAKEN HERE: a connection that would
 * close a directed cycle is REFUSED AT CONNECT TIME, by the same validation path
 * that refuses a type mismatch, with its own sentence.
 *
 * WHY refuse rather than resolve lazily:
 *   1. Value flow here is PULL-BASED and SYNCHRONOUS (evaluateNodeGraph below
 *      folds source values into inputs in one pass). A cycle in a pull evaluator
 *      is either an infinite loop or an arbitrary "use last frame's value" —
 *      and "last frame's value" is STATE CARRIED FROM FRAME N-1, which the
 *      determinism law in CLAUDE.md explicitly disqualifies: it breaks Δt = 0
 *      reproducibility and frame-range sharding at once. A lazily-resolved cycle
 *      would quietly introduce the one kind of state this app has none of.
 *   2. The refusal is CHEAP and LOCAL: `wouldCycle` is a walk from the proposed
 *      source back along existing connections, which is O(edges) on a graph whose
 *      size is a handful of widgets.
 *   3. It is HONEST AT THE GESTURE. The user finds out when they drop the wire,
 *      with the reason on screen, instead of discovering a frozen or flickering
 *      value later.
 *
 * WHAT THIS DOES NOT DECIDE: audio feedback loops. A delay line's feedback path is
 * a genuine cycle in the AUDIO domain, where it is meaningful because the audio
 * graph is PUSH-based with a one-block delay that is part of the sound. That is
 * NF-BIND's problem, and the escape hatch is already shaped: a port declaration may
 * carry `feedbackSafe: true`, and cycleRefusal() ignores edges entering such a
 * port. No audio port declares it yet, and nothing in this file interprets it
 * beyond skipping the check — the semantics belong to whoever adds the first one.
 *
 * ── HOW VALUES FLOW ─────────────────────────────────────────────────────────
 * `evaluateNodeGraph(items, registry)` returns, per item, the values on its input
 * ports and its output ports. A plugin declares `computeOutputs(state, inputs)`;
 * the pass topologically orders nodes, feeds each one's resolved inputs, and stores
 * what it returns. A node with no `computeOutputs` produces nothing, which is what
 * a pure SINK (a display) wants.
 *
 * This is PROPERTY STATE end to end: it is a pure function of the folded document
 * state, so it is identical under a shuffle of time, and it needs no history. That
 * is why the trio in plugins/node_*.js retweens across slides with no special
 * handling — the number a source emits is an ordinary keyframable leaf, so a
 * tweened source drives a tweened display for free.
 */

// ── PORT TYPES ───────────────────────────────────────────────────────────────

/**
 * THE PORT TYPE TABLE. One entry per type: its color (the user's ruling that the
 * bead color indicates the type), a human label, and a `zero` — the value an
 * UNCONNECTED input of that type reads.
 *
 * `zero` exists so an unconnected input is never `undefined`: a math node with one
 * wire plugged in still computes, and a display with nothing attached shows a
 * defined value rather than a hole. It is the type's additive identity where that
 * makes sense.
 *
 * The reserved-for-later types (image / material / shape, per the blueprint) are
 * NOT declared here. A type with no widget that produces it would be a color in a
 * legend for a wire nobody can draw; they get declared by whoever adds the first
 * producer, which is also who knows what its `zero` should be.
 */
export const PORT_TYPES = Object.freeze({
  number: Object.freeze({ label: "Number", color: "#7aa2f7", zero: 0 }),
  trigger: Object.freeze({ label: "Trigger", color: "#e0af68", zero: 0 }),
  audio: Object.freeze({ label: "Audio", color: "#9ece6a", zero: 0 }),
});

/** Every declared port type name, for validation messages and test sweeps. */
export const PORT_TYPE_NAMES = Object.freeze(Object.keys(PORT_TYPES));

/**
 * Pure function. The color for a port type — THE one lookup every surface uses
 * (SVG bead, ghost wire, painted chrome). Throws on an unknown type rather than
 * returning a default: a silent grey bead is how a typo in a plugin's port
 * declaration would ship unnoticed.
 *
 * @param {string} type - a PORT_TYPES key
 * @returns {string} a hex color
 *
 * @example portColor("number") // "#7aa2f7"
 * @example portColor("trigger") // "#e0af68"
 */
export function portColor(type) {
  const t = PORT_TYPES[type];
  if (!t) throw new Error(`nodeflow: unknown port type ${JSON.stringify(type)} — declare it in PORT_TYPES (have: ${PORT_TYPE_NAMES.join(", ")})`);
  return t.color;
}

/**
 * Pure function. The value an UNCONNECTED input of this type reads.
 *
 * @param {string} type - a PORT_TYPES key
 * @returns {*} the type's zero value
 *
 * @example portZero("number") // 0
 * @example portZero("trigger") // 0
 */
export function portZero(type) {
  const t = PORT_TYPES[type];
  if (!t) throw new Error(`nodeflow: unknown port type ${JSON.stringify(type)} — declare it in PORT_TYPES (have: ${PORT_TYPE_NAMES.join(", ")})`);
  return t.zero;
}

/**
 * Pure function. The `--a-port-<type>` CSS custom-property block mirroring
 * PORT_TYPES, so app.css can style DOM chrome in the same colors the painter uses
 * without a second list of hexes to keep in sync. tests/nodeflow_test.js asserts
 * app.css contains exactly this text, which is what makes the mirror non-silent.
 *
 * @returns {string} CSS declarations, one per type, newline separated
 *
 * @example portTypeCssVars().split("\n")[0] // "  --a-port-number: #7aa2f7;"
 */
export function portTypeCssVars() {
  return PORT_TYPE_NAMES.map((n) => `  --a-port-${n}: ${PORT_TYPES[n].color};`).join("\n");
}

// ── COERCION ─────────────────────────────────────────────────────────────────

/**
 * THE COERCION TABLE, exhaustive and explicit: `"<from>-><to>"` → {convert, why}.
 *
 * A pair absent from this table is INCOMPATIBLE (identity — same type on both ends
 * — is always allowed and is not listed; it is not a coercion). `why` is shown to
 * the user, so it is a sentence about the VALUE, not about the code.
 *
 * The pairs, and the judgement behind each:
 *   number → audio    a constant-valued signal. Meaningful: a knob feeding an
 *                     amplitude is exactly this.
 *   trigger → number  a trigger reads as 0 or 1, which is what makes a gate
 *                     usable as a multiplier.
 *   number → trigger  RISING-EDGE DETECTION, not a value cast. Listed anyway
 *                     because it is the connection the user described (Axoloti's
 *                     low-to-high firing), and the receiving node is what
 *                     implements the edge detection — the coercion's job here is
 *                     only to say the wire is legal and hand the number through.
 *   audio → number    the signal's CURRENT sample. Lossy and rate-mismatched, but
 *                     it is what a level meter or an envelope follower reads, and
 *                     refusing it would make those nodes unwireable.
 *   trigger → audio   a gate IS a signal — 1 while high, 0 while low. ADDED BY
 *                     NF-BIND, and found by a sweep rather than by reasoning: the
 *                     audio roster's Trigger module emits `trigger` and nine modules
 *                     accept `audio`, so this pair was REACHABLE at the bead and
 *                     refused at the drop, with nothing in the picture to say why.
 *                     It is meaningful in the engine too — a Schmitt trigger's output
 *                     is a real AudioNode carrying a pulse train, so patching it into
 *                     a VCA's input to chop a drone is an ordinary thing to want.
 *
 * ── AND THE ONE REACHABLE PAIR STILL REFUSED, ON PURPOSE ────────────────────
 * `audio → trigger` is absent and stays absent. It is not a value cast at all:
 * turning a continuous signal into discrete events requires deciding WHERE the
 * threshold is and how much hysteresis stops a signal wobbling around it from firing
 * dozens of times. That decision is a module — plugins/audio_trigger.js — and a
 * silent coercion here would make it pointless while producing worse timing. The
 * refusal sends the user to the module, which is the right answer.
 * tests/nodeflow_test.js pins BOTH halves: the pair is refused, and it is the ONLY
 * reachable pair that is, so a future gap shows up as a decision to make.
 */
export const COERCIONS = Object.freeze({
  "number->audio": Object.freeze({ convert: (v) => v, why: "a number drives an audio input as a constant signal" }),
  "trigger->number": Object.freeze({ convert: (v) => (v ? 1 : 0), why: "a trigger reads as 1 while high, 0 while low" }),
  "number->trigger": Object.freeze({ convert: (v) => v, why: "a number drives a trigger input by its rising edges (low to high)" }),
  "audio->number": Object.freeze({ convert: (v) => v, why: "an audio signal reads as its current sample value" }),
  "trigger->audio": Object.freeze({ convert: (v) => (v ? 1 : 0), why: "a trigger drives an audio input as a gate signal — 1 while high, 0 while low" }),
});

/**
 * Pure function. Is a wire from an output of `from` to an input of `to` allowed by
 * the type system? True for identical types (no conversion) and for any pair in
 * COERCIONS.
 *
 * @param {string} from - the SOURCE port's type
 * @param {string} to - the DESTINATION port's type
 * @returns {boolean}
 *
 * @example typesCompatible("number", "number") // true
 * @example typesCompatible("number", "audio") // true (an explicit coercion)
 * @example typesCompatible("audio", "trigger") // false (no such entry)
 */
export function typesCompatible(from, to) {
  return from === to || `${from}->${to}` in COERCIONS;
}

/**
 * Pure function. Applies the declared coercion from `from` to `to`. Identity when
 * the types match. THROWS on an incompatible pair rather than returning the value
 * unchanged — reaching this function with a pair validation already refused means
 * a caller skipped validation, and passing the value through would hide that.
 *
 * @param {*} value - the source port's value
 * @param {string} from - the SOURCE port's type
 * @param {string} to - the DESTINATION port's type
 * @returns {*} the value as the destination type reads it
 *
 * @example coerce(3, "number", "number") // 3
 * @example coerce(1, "trigger", "number") // 1
 * @example coerce(0, "trigger", "number") // 0
 * @example coerce(0.5, "number", "audio") // 0.5
 */
export function coerce(value, from, to) {
  if (from === to) return value;
  const c = COERCIONS[`${from}->${to}`];
  if (!c) throw new Error(`nodeflow: no coercion from ${from} to ${to} — this pair is incompatible and the connection should have been refused by connectionRefusal()`);
  return c.convert(value);
}

/**
 * Pure function. The sentence explaining why a `from`→`to` wire is allowed, or
 * null when the types are identical (nothing to explain). Used by the canvas to
 * tell the user what a cross-type drop is about to do BEFORE they release.
 *
 * @param {string} from - the SOURCE port's type
 * @param {string} to - the DESTINATION port's type
 * @returns {string|null} the coercion's sentence, or null for an identity wire
 *
 * @example coercionNote("trigger", "number") // "a trigger reads as 1 while high, 0 while low"
 * @example coercionNote("number", "number") // null
 */
export function coercionNote(from, to) {
  if (from === to) return null;
  return COERCIONS[`${from}->${to}`]?.why ?? null;
}

// ── PORT DECLARATIONS ────────────────────────────────────────────────────────

/**
 * Pure function. A plugin's declared ports for a state, normalized and VALIDATED.
 * A plugin declares:
 *
 *     ports(state) -> { inputs: [{key, type, label?}], outputs: [{key, type, label?}] }
 *
 * It is a FUNCTION OF STATE (blueprint §1) so a port list can vary with the
 * widget's own properties — a mixer grows inputs as its channel count rises, and
 * that must not require a new widget type per channel count.
 *
 * A plugin with no `ports` returns the empty declaration, so EVERY existing widget
 * is a valid argument here and answers "no ports". That is what keeps this an
 * additive protocol: nothing had to be changed to gain it.
 *
 * @param {object} plugin - a widget plugin (may lack `ports`)
 * @param {object} state - the folded item state
 * @returns {{inputs: object[], outputs: object[]}} normalized, label defaulted to key
 *
 * @example declaredPorts({}, {}) // {inputs: [], outputs: []}
 * @example declaredPorts({ports: () => ({outputs: [{key: "out", type: "number"}]})}, {}).outputs[0].label // "out"
 * @example declaredPorts({ports: (s) => ({inputs: Array.from({length: s.n}, (_, i) => ({key: `in${i}`, type: "number"}))})}, {n: 3}).inputs.length // 3
 */
export function declaredPorts(plugin, state) {
  const raw = plugin?.ports?.(state ?? {}) ?? {};
  const norm = (list, side) => (list ?? []).map((p) => {
    if (!p?.key) throw new Error(`nodeflow: a ${side} port declared by "${plugin?.type}" has no key`);
    if (!PORT_TYPES[p.type]) throw new Error(`nodeflow: ${side} port "${p.key}" on "${plugin?.type}" declares unknown type ${JSON.stringify(p.type)} (have: ${PORT_TYPE_NAMES.join(", ")})`);
    return { key: p.key, type: p.type, label: p.label ?? p.key, side, ...(p.feedbackSafe ? { feedbackSafe: true } : {}) };
  });
  return { inputs: norm(raw.inputs, "input"), outputs: norm(raw.outputs, "output") };
}

/**
 * Pure function. Does this plugin declare any ports at all — i.e. is it a NODE
 * widget? The capability test the canvas layer, the Inspector and the wire walk all
 * branch on, so nothing ever branches on a concrete widget TYPE (the registry law).
 *
 * Asked with `plugin.defaults` when no live state is at hand, because a plugin
 * whose port list is empty for EVERY state is not a node widget in any sense.
 *
 * @param {object} plugin - a widget plugin
 * @param {object} [state] - a state to ask about; defaults to the plugin's defaults
 * @returns {boolean}
 *
 * @example isNodeWidget({type: "rect"}) // false
 * @example isNodeWidget({type: "n", ports: () => ({outputs: [{key: "out", type: "number"}]})}) // true
 */
export function isNodeWidget(plugin, state) {
  const p = declaredPorts(plugin, state ?? plugin?.defaults ?? {});
  return p.inputs.length > 0 || p.outputs.length > 0;
}

/**
 * Pure function. One port's declaration on one item, or null. The single lookup
 * that answers "what type is the thing at the end of this wire" for both ends.
 *
 * @param {object} plugin - the item's plugin
 * @param {object} state - the item's folded state
 * @param {string} side - "input" | "output"
 * @param {string} key - the port key
 * @returns {object|null} the normalized port, or null if it does not exist
 *
 * @example findPort({ports: () => ({outputs: [{key: "out", type: "number"}]})}, {}, "output", "out").type // "number"
 * @example findPort({ports: () => ({outputs: []})}, {}, "output", "out") // null
 */
export function findPort(plugin, state, side, key) {
  const p = declaredPorts(plugin, state);
  return (side === "input" ? p.inputs : p.outputs).find((x) => x.key === key) ?? null;
}

/**
 * THE `itemRefs` DECLARATION every node plugin spreads, so duplicate / clone /
 * shatter remap a copied patch onto the copies instead of leaving them wired to the
 * originals (core/document.js reads `plugin.itemRefs`; plugins/group.js's `members`
 * is the precedent). `"*"` is the WILDCARD segment — every input key.
 *
 * Declared HERE rather than written out in each node plugin so the path cannot be
 * spelled three different ways by three widgets.
 */
export const NODE_ITEM_REFS = Object.freeze([Object.freeze(["inputs", "*", "item"])]);

// ── CONNECTIONS ──────────────────────────────────────────────────────────────

/**
 * Pure function. Every connection in a folded item map, flattened to a list of
 * edges. THE one reader of the `inputs` state shape — every consumer (validation,
 * evaluation, the wire-drawing layer, cycle detection) goes through this, so the
 * storage shape is stated exactly once.
 *
 * Connections naming a MISSING or INACTIVE source item are DROPPED here, silently
 * and deliberately: an item that is `active: false` on this slide is simply not
 * present on this slide (the universal Delete semantics), and a wire to something
 * that is not on the slide is not an error — it is a patch that differs per slide,
 * which is the whole point of connections being keyframable state. The connection
 * leaf survives in the document and the wire returns when the source does.
 *
 * @param {object} items - folded items, {id: state}
 * @returns {object[]} [{from: {item, port}, to: {item, port}}], deterministic order
 *
 * @example connectionsOf({a: {type: "s"}, b: {type: "m", inputs: {x: {item: "a", port: "out"}}}}) // [{from: {item: "a", port: "out"}, to: {item: "b", port: "x"}}]
 * @example connectionsOf({b: {inputs: {x: {item: "gone", port: "out"}}}}) // [] (source absent on this slide — not an error)
 * @example connectionsOf({a: {active: false}, b: {inputs: {x: {item: "a", port: "out"}}}}) // [] (source deleted on this slide)
 */
export function connectionsOf(items) {
  const out = [];
  for (const id of Object.keys(items ?? {}).sort()) {
    const state = items[id];
    if (!state || state.active === false) continue;
    const inputs = state.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const port of Object.keys(inputs).sort()) {
      const c = inputs[port];
      if (!c || typeof c !== "object" || typeof c.item !== "string" || typeof c.port !== "string") continue;
      const src = items[c.item];
      if (!src || src.active === false) continue;
      out.push({ from: { item: c.item, port: c.port }, to: { item: id, port } });
    }
  }
  return out;
}

/**
 * Pure function. Would connecting `from` (an output) to `to` (an input) close a
 * directed cycle in the graph the existing connections already form? Walks
 * BACKWARD from the proposed source: if the destination is reachable upstream of
 * the source, the new edge would close a loop.
 *
 * Self-connection (an item wired to itself) is a cycle of length 1 and is caught by
 * the same walk, with no special case.
 *
 * A port declared `feedbackSafe: true` is EXCLUDED from the walk (see the module
 * docblock): an edge entering such a port is not a constraint on evaluation order,
 * so it cannot make a cycle illegal. No port declares it yet.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry (.get(type))
 * @param {{item: string, port: string}} from - the proposed SOURCE (an output)
 * @param {{item: string, port: string}} to - the proposed DESTINATION (an input)
 * @returns {boolean} true if the connection would create a cycle
 *
 * @example wouldCycle({a: {}, b: {}}, {get: () => ({})}, {item: "a", port: "o"}, {item: "b", port: "i"}) // false
 * @example wouldCycle({a: {}}, {get: () => ({})}, {item: "a", port: "o"}, {item: "a", port: "i"}) // true (self-connection)
 * @example // a→b already exists, so b→a would close the loop:
 * @example wouldCycle({a: {}, b: {inputs: {i: {item: "a", port: "o"}}}}, {get: () => ({})}, {item: "b", port: "o"}, {item: "a", port: "i"}) // true
 */
export function wouldCycle(items, registry, from, to) {
  const edges = connectionsOf(items).filter((e) => !portIsFeedbackSafe(items, registry, e.to));
  const upstream = new Map(); // itemId → [source itemIds]
  for (const e of edges) {
    if (!upstream.has(e.to.item)) upstream.set(e.to.item, []);
    upstream.get(e.to.item).push(e.from.item);
  }
  // Walk back from the proposed SOURCE. Reaching the proposed DESTINATION means
  // the destination already feeds the source, so adding source→destination loops.
  const seen = new Set();
  const stack = [from.item];
  while (stack.length) {
    const id = stack.pop();
    if (id === to.item) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const up of upstream.get(id) ?? []) stack.push(up);
  }
  return false;
}

/**
 * Query-shaped pure helper. The plugin for an item, or null — NEVER a throw.
 *
 * THE REGISTRY THROWS ON AN UNKNOWN TYPE, and that is right for a render walk (a
 * document naming a widget nobody registered is a real defect there). It is WRONG
 * here, because this module runs over the WHOLE item map, including items
 * `deriveRenderTree` deliberately skips: an item whose creation slide is later in
 * the deck has NO `type` at all yet (imaginary-slide semantics, core/expressions.js),
 * and asking the registry about `undefined` threw and took the entire derive with
 * it. That is the exact bug tests/expressions_test.js caught: an ordinary document
 * with a not-yet-created item stopped rendering the moment this module existed.
 *
 * So the rule here MIRRORS derive's own: an item without a resolvable plugin is not
 * an error, it is simply not part of the graph this fold sees. A truly unknown TYPE
 * still reaches the registry's throw through the render walk, which is where that
 * complaint belongs — this function suppresses nothing that has a picture.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {string} id - the item id
 * @returns {object|null}
 */
function pluginFor(items, registry, id) {
  const type = items?.[id]?.type;
  if (typeof type !== "string") return null; // not created on this fold — not an error
  try {
    return registry?.get?.(type) ?? null;
  } catch {
    // A type the registry does not know. The RENDER walk will raise it (that is its
    // job and it names the item); the graph fold simply has no ports to read from a
    // widget that does not exist, and throwing twice for one defect helps nobody.
    return null;
  }
}

/**
 * Query-shaped pure helper. Is the input port an edge terminates at declared
 * `feedbackSafe`? Missing plugin / port answers false, because an edge we cannot
 * resolve must not be silently exempted from the cycle rule.
 */
function portIsFeedbackSafe(items, registry, to) {
  const state = items?.[to.item];
  const plugin = state ? pluginFor(items, registry, to.item) : null;
  if (!plugin) return false;
  return findPort(plugin, state, "input", to.port)?.feedbackSafe === true;
}

/**
 * Pure function. WHY a proposed connection is refused, or null when it is allowed.
 * THE single validation seam: the canvas asks it while dragging (to highlight
 * compatible targets and dim the rest) AND on drop (to refuse with a sentence), so
 * the highlight and the refusal cannot disagree about what is legal.
 *
 * The sentence completes "Cannot connect — …", so it states a fact about the
 * PORTS, not about the code.
 *
 * Order of checks is deliberate: existence first (a missing port makes every later
 * question meaningless), then direction, then type, then cycle. The cycle check is
 * LAST because it is the only one that walks the graph.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {{item: string, port: string}} from - proposed SOURCE, an output port
 * @param {{item: string, port: string}} to - proposed DESTINATION, an input port
 * @returns {string|null} the refusal sentence, or null when the connection is legal
 *
 * @example // legal number → number:
 * @example connectionRefusal({a: {type: "s"}, b: {type: "m"}}, {get: (t) => t === "s" ? {ports: () => ({outputs: [{key: "o", type: "number"}]})} : {ports: () => ({inputs: [{key: "i", type: "number"}]})}}, {item: "a", port: "o"}, {item: "b", port: "i"}) // null
 * @example // a missing source item:
 * @example connectionRefusal({}, {get: () => ({})}, {item: "ghost", port: "o"}, {item: "b", port: "i"}) // "the source widget is not on this slide"
 */
export function connectionRefusal(items, registry, from, to) {
  const srcState = items?.[from.item];
  const dstState = items?.[to.item];
  if (!srcState) return "the source widget is not on this slide";
  if (!dstState) return "the destination widget is not on this slide";
  const srcPlugin = pluginFor(items, registry, from.item);
  const dstPlugin = pluginFor(items, registry, to.item);
  const outPort = srcPlugin ? findPort(srcPlugin, srcState, "output", from.port) : null;
  const inPort = dstPlugin ? findPort(dstPlugin, dstState, "input", to.port) : null;
  if (!outPort) return `the source has no output named "${from.port}"`;
  if (!inPort) return `the destination has no input named "${to.port}"`;
  if (!typesCompatible(outPort.type, inPort.type))
    return `a ${PORT_TYPES[outPort.type].label} output cannot drive a ${PORT_TYPES[inPort.type].label} input — there is no conversion between them`;
  if (wouldCycle(items, registry, from, to))
    return "that would make a loop — this node already feeds the one you are dragging from, and a value cannot depend on itself";
  return null;
}

/**
 * Pure function. The state-path/value pairs that CONNECT an output to an input,
 * for app.setPreview → commitPreview (ONE undo unit, the universal edit path).
 * Returning pairs rather than mutating is what lets the canvas stage a connection
 * exactly like a drag: the same seam, the same undo granularity.
 *
 * @param {{item: string, port: string}} from - the SOURCE output
 * @param {{item: string, port: string}} to - the DESTINATION input
 * @returns {Array} [[path, value]] pairs
 *
 * @example connectPairs({item: "a", port: "out"}, {item: "b", port: "x"}) // [[["items", "b", "inputs", "x"], {item: "a", port: "out"}]]
 */
export function connectPairs(from, to) {
  return [[["items", to.item, "inputs", to.port], { item: from.item, port: from.port }]];
}

/**
 * Pure function. The state-path/value pairs that DISCONNECT an input — the user's
 * stated delete gesture ("you take one of the nodes you click and drag off into the
 * outer space and the wire disappears").
 *
 * The value is `null`, NOT a deleted key, and that is the whole subtlety: state is
 * FOLDED from slide deltas, so removing the key from this slide's delta would let
 * the connection be INHERITED from an earlier slide and the wire would come back.
 * `null` is a real value that overrides the inherited one, which is the same reason
 * every other "off" in this document format is a value rather than an absence.
 * connectionsOf() reads null as absent, so nothing downstream needs to know.
 *
 * @param {{item: string, port: string}} to - the input to clear
 * @returns {Array} [[path, value]] pairs
 *
 * @example disconnectPairs({item: "b", port: "x"}) // [[["items", "b", "inputs", "x"], null]]
 */
export function disconnectPairs(to) {
  return [[["items", to.item, "inputs", to.port], null]];
}

// ── EVALUATION ───────────────────────────────────────────────────────────────

/**
 * Pure function. A topological order of node item ids — sources before the nodes
 * they feed. Nodes not participating in any connection come first (they have no
 * constraints); order within a tier is by id, so the result is DETERMINISTIC and a
 * re-render cannot shuffle it.
 *
 * A cycle CANNOT normally exist (connectionRefusal refuses one at connect time),
 * but a hand-edited or externally-generated document could still carry one. Rather
 * than looping forever, the nodes still unresolved when no further progress is
 * possible are appended in id order and REPORTED by evaluateNodeGraph — a document
 * that got past validation is a fact worth surfacing, not one to paper over.
 *
 * @param {object} items - folded items
 * @returns {{order: string[], cyclic: string[]}} the order, plus any ids in a cycle
 *
 * @example topoOrder({a: {}, b: {inputs: {i: {item: "a", port: "o"}}}}) // {order: ["a", "b"], cyclic: []}
 * @example topoOrder({b: {inputs: {i: {item: "a", port: "o"}}}, a: {}}).order // ["a", "b"]
 * @example topoOrder({a: {}, b: {}}) // {order: ["a", "b"], cyclic: []} (unconnected: id order)
 */
export function topoOrder(items) {
  const ids = Object.keys(items ?? {}).sort();
  const deps = new Map(ids.map((id) => [id, new Set()]));
  for (const e of connectionsOf(items)) deps.get(e.to.item)?.add(e.from.item);
  const order = [];
  const done = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of ids) {
      if (done.has(id)) continue;
      const d = deps.get(id);
      if ([...d].every((x) => done.has(x) || !deps.has(x))) {
        order.push(id);
        done.add(id);
        progress = true;
      }
    }
  }
  const cyclic = ids.filter((id) => !done.has(id));
  return { order: [...order, ...cyclic], cyclic };
}

/**
 * Pure function. Evaluates the whole node graph for one folded state: for every
 * node item, the values arriving on its INPUT ports and the values leaving its
 * OUTPUT ports.
 *
 * The contract a node plugin opts into:
 *
 *     computeOutputs(state, inputs) -> { <outPortKey>: value }
 *
 * `inputs` is a plain `{portKey: value}` map with EVERY declared input present —
 * an unconnected one holds its type's zero (portZero), so a plugin never writes
 * `inputs.x ?? 0` and can never be surprised by a hole. A plugin with no
 * `computeOutputs` is a SINK (a display): it still receives inputs, it just
 * produces nothing.
 *
 * Values are COERCED at the wire, by the receiving port's type — so a plugin only
 * ever sees values of the type it declared, and the coercion table is applied at
 * exactly one place.
 *
 * PROPERTY STATE, fully: a pure function of the folded state, so it is identical
 * under a shuffle of time and needs no history. That is what lets the trio retween
 * across slides for free.
 *
 * @param {object} items - folded items, {id: state}
 * @param {object} registry - plugin registry (.get(type))
 * @returns {{values: object, cyclic: string[]}} values[itemId] = {inputs, outputs}
 *
 * @example // a source of 3 feeding a doubler:
 * @example const reg = {get: (t) => t === "src" ? {ports: () => ({outputs: [{key: "out", type: "number"}]}), computeOutputs: (s) => ({out: s.value})} : {ports: () => ({inputs: [{key: "in", type: "number"}], outputs: [{key: "out", type: "number"}]}), computeOutputs: (s, i) => ({out: i.in * 2})}};
 * @example evaluateNodeGraph({a: {type: "src", value: 3}, b: {type: "mul", inputs: {in: {item: "a", port: "out"}}}}, reg).values.b.outputs.out // 6
 * @example // an UNCONNECTED input reads its type's zero, never undefined:
 * @example evaluateNodeGraph({b: {type: "mul"}}, reg).values.b.inputs.in // 0
 */
export function evaluateNodeGraph(items, registry) {
  const { order, cyclic } = topoOrder(items);
  const values = {};
  for (const id of order) {
    const state = items[id];
    if (!state || state.active === false) continue;
    const plugin = pluginFor(items, registry, id);
    if (!plugin) continue;
    const ports = declaredPorts(plugin, state);
    if (ports.inputs.length === 0 && ports.outputs.length === 0) continue;
    // Resolve every declared input: a connected one takes its source's output
    // COERCED to this port's type; an unconnected one takes the type's zero.
    const inputs = {};
    for (const p of ports.inputs) {
      const c = state.inputs?.[p.key];
      const srcOut = c && typeof c === "object" ? values[c.item]?.outputs?.[c.port] : undefined;
      if (srcOut === undefined) {
        inputs[p.key] = portZero(p.type);
        continue;
      }
      const srcState = items[c.item];
      const srcPlugin = srcState ? pluginFor(items, registry, c.item) : null;
      const srcPort = srcPlugin ? findPort(srcPlugin, srcState, "output", c.port) : null;
      // A source port that vanished (its plugin's port list changed with state)
      // reads as the zero rather than throwing: the document is still valid, the
      // wire simply has nothing behind it this frame.
      inputs[p.key] = srcPort && typesCompatible(srcPort.type, p.type) ? coerce(srcOut, srcPort.type, p.type) : portZero(p.type);
    }
    const outputs = plugin.computeOutputs?.(state, inputs) ?? {};
    values[id] = { inputs, outputs };
  }
  return { values, cyclic };
}

// ── GEOMETRY ─────────────────────────────────────────────────────────────────

/**
 * THE BEAD RADIUS, in LOCAL widget units. One constant, three consumers: the
 * painted chrome (plugin emit), the SVG hit layer, and the hit test below. It is
 * deliberately a LOCAL length, so a scaled-down node's beads scale with it — the
 * bead is part of the picture, not a fixed-size piece of UI furniture.
 */
export const PORT_BEAD_R = 6;

/**
 * The vertical spacing between successive ports on one side of a node, and the
 * inset from the node's top edge to the FIRST port. LOCAL units. Shared by the
 * layout below and by the node plugins' chrome so a node's body height and its
 * port column cannot disagree.
 */
export const PORT_PITCH = 22;
export const PORT_TOP_INSET = 34; // clears the title bar

/**
 * Pure function. The LOCAL positions of every port on a node: inputs down the LEFT
 * edge, outputs down the RIGHT edge (the user's Reaktor left-to-right ruling,
 * ADDENDUM 1). Beads sit ON the edge — half in, half out — which is the Audulus
 * look and also makes the bead's grab area straddle the boundary so a slightly-off
 * grab still lands.
 *
 * THE ONE GEOMETRY. Derivation calls it to place world-space anchors for hit
 * testing and wire endpoints; each node plugin's emit() calls it to paint the beads.
 * That is what stops a bead from being drawn anywhere other than where it can be
 * grabbed.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} state - the folded state (its w/h size the body)
 * @returns {object[]} [{key, type, label, side, x, y}] in LOCAL coords
 *
 * @example portLayout({ports: () => ({inputs: [{key: "a", type: "number"}], outputs: [{key: "o", type: "number"}]})}, {w: 120, h: 80}).map((p) => [p.key, p.x, p.y]) // [["a", 0, 34], ["o", 120, 34]]
 * @example portLayout({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {w: 120, h: 80})[1].y // 56
 * @example portLayout({}, {w: 10, h: 10}) // []
 */
export function portLayout(plugin, state) {
  const { inputs, outputs } = declaredPorts(plugin, state);
  const w = state?.w ?? 0;
  const place = (list, x) => list.map((p, i) => ({ ...p, x, y: PORT_TOP_INSET + i * PORT_PITCH }));
  return [...place(inputs, 0), ...place(outputs, w)];
}

/**
 * Pure function. The minimum body HEIGHT a node needs to hold its port columns —
 * the taller of the two columns plus a bottom margin equal to the top inset. Node
 * plugins use it as their default `h` so a freshly-inserted node is never born with
 * beads hanging off its bottom edge.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} state - the folded state
 * @returns {number} minimum local height
 *
 * @example minimumNodeHeight({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {}) // 90
 * @example minimumNodeHeight({ports: () => ({outputs: [{key: "o", type: "number"}]})}, {}) // 68
 */
export function minimumNodeHeight(plugin, state) {
  const { inputs, outputs } = declaredPorts(plugin, state ?? {});
  const rows = Math.max(inputs.length, outputs.length);
  return PORT_TOP_INSET + Math.max(0, rows - 1) * PORT_PITCH + PORT_TOP_INSET;
}

/**
 * Pure function. Which port bead (if any) a LOCAL point grabs, or null. The bead
 * wins inside its radius and nowhere else — outside it, the press is an ordinary
 * body drag (blueprint §6: "bead drag = wire gesture, WINNING over body drag inside
 * the bead's radius").
 *
 * `tol` widens the grab for a coarse pointer or a zoomed-out view; the caller
 * converts screen slop to local units, since only it knows the zoom.
 *
 * Nearest-bead wins when two overlap (a node squeezed shorter than
 * minimumNodeHeight), so the answer is never ambiguous.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} state - the folded state
 * @param {number} lx - LOCAL x
 * @param {number} ly - LOCAL y
 * @param {number} [tol] - extra grab radius in LOCAL units
 * @returns {object|null} the port (with x/y), or null
 *
 * @example portAt({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80}, 0, 34, 0).key // "a"
 * @example portAt({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80}, 40, 34, 0) // null (well inside the body: an ordinary move drag)
 */
export function portAt(plugin, state, lx, ly, tol = 0) {
  const r = PORT_BEAD_R + tol;
  let best = null, bestD = Infinity;
  for (const p of portLayout(plugin, state)) {
    const d = Math.hypot(p.x - lx, p.y - ly);
    if (d <= r && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/**
 * The node card's corner radius, in LOCAL units — the ONE number the card's
 * painted silhouette and its rim projection both read.
 *
 * It is declared HERE rather than in core/node_chrome.js, which is where the rest
 * of the card's look lives, because core/node_chrome.js imports render_gpu/ir.js
 * (it builds display-list ops) and the geometry below must stay importable by
 * anything that reasons about a node's SHAPE without wanting a painter.
 * node_chrome re-exports it as NODE_RADIUS, so there is still one name at the
 * place a plugin author looks.
 */
export const NODE_CORNER_R = 10;

/**
 * Pure function. The closest point ON a node card's PAINTED RIM to a LOCAL query —
 * the rounded rectangle every node widget draws, arcs and all.
 *
 * ── WHY THIS EXISTS, AND WHAT IT REPLACES ───────────────────────────────────
 * Every node plugin used to answer `closestAnchor` with
 * `{x: clamp(0, w, lx), y: clamp(0, h, ly)}`. That reads like "project onto the
 * card" and is NOT one: a query already INSIDE the box is its own answer, so the
 * `closest_to_rim` equation aimed at an overlapping node landed in the node's
 * middle and an arrow bound to it stopped in empty space inside the card. It is
 * exactly the defect tests/anchor_ink_test.js section 7 states as a law ("a rim is
 * a projection, not a clamp"), which is what caught all 26 node widgets at once.
 *
 * A clamp is also wrong at the CORNERS in the other direction: the card is drawn
 * with NODE_CORNER_R arcs, so the square corner a clamp returns is a point the
 * card does not paint — the same Round 12 rounded-rect bug plugins/rect.js fixed
 * for itself and the ink rule then generalised.
 *
 * ── WHY THE BEADS ARE NOT PART OF THE RIM ───────────────────────────────────
 * A bead straddles the card edge and so pokes outside this rectangle (that halo
 * IS declared — see nodeInkBounds). It is deliberately not part of the rim map:
 * an anchor is where you ATTACH something, and attaching an arrow to a socket
 * would collide with the wire that socket exists to carry. The rim is the card.
 *
 * @param {object} state - the folded item state (w/h size the card)
 * @param {number} lx - LOCAL x of the query
 * @param {number} ly - LOCAL y of the query
 * @returns {{x: number, y: number}} the LOCAL rim point
 *
 * @example // an INTERIOR query is projected OUT to the nearest edge, never returned as-is
 * @example nodeCardRim({w: 200, h: 120}, 100, 60) // {x: 100, y: 0}
 * @example // a query off the left edge lands on that edge at its own height
 * @example nodeCardRim({w: 200, h: 120}, -50, 70) // {x: 0, y: 70}
 * @example // and a diagonal query lands on the CORNER ARC, not on the square corner
 * @example nodeCardRim({w: 200, h: 120}, 300, -300).x < 200 // true
 */
export function nodeCardRim(state, lx, ly) {
  const w = state?.w ?? 0, h = state?.h ?? 0;
  const rad = Math.max(0, Math.min(NODE_CORNER_R, Math.min(w, h) / 2));
  const ax = Math.max(rad, Math.min(lx, w - rad));
  const ay = Math.max(rad, Math.min(ly, h - rad));
  const dx = lx - ax, dy = ly - ay;
  const d = Math.hypot(dx, dy);
  if (d > 0) return { x: ax + (rad * dx) / d, y: ay + (rad * dy) / d };
  // Inside the arc-centre box: project to the nearest STRAIGHT edge. This is the
  // branch a clamp never had, and it is the whole difference.
  const dl = lx, dr = w - lx, dt = ly, db = h - ly;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: 0, y: ly };
  if (m === dr) return { x: w, y: ly };
  if (m === dt) return { x: lx, y: 0 };
  return { x: lx, y: h };
}

/**
 * Pure function. A node widget's INK rect (the BOUNDS protocol, core/registry.js):
 * its card PLUS the half-bead halo its ports paint outside the card's edges.
 *
 * A bead sits ON the edge — half in, half out (portLayout's stated geometry, the
 * Audulus look that also makes a slightly-off grab land). So a node's ink is
 * genuinely WIDER than its box by PORT_BEAD_R on each side that carries ports, and
 * the default `{0, 0, w, h}` a bbox widget gets is a rect that CROPS the picture.
 * The four consequences are the ones the registry docblock lists for plaintext's
 * overflow: culled early at the edge of the view, missed by band select, cropped
 * out of a copy/export capture, and — because hit testing takes the union of this
 * and the property box — a bead you can see and cannot press.
 *
 * The halo is applied only on sides that HAVE a bead, so a node with no inputs is
 * not padded on the left. The vertical extent is the card's: a bead's own vertical
 * extent is always inside it (PORT_TOP_INSET clears the title bar and
 * minimumNodeHeight reserves a matching bottom margin), and a node squeezed
 * shorter than that is showing a sizing problem, which the registry docblock says
 * to see rather than to hide.
 *
 * @param {object} plugin - the node's own plugin (for its port declaration)
 * @param {object} state - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}} the LOCAL ink rect
 *
 * @example // a node with ports on both sides: the card, widened by one bead radius each way
 * @example nodeInkBounds({ports: () => ({inputs: [{key: "a", type: "number"}], outputs: [{key: "o", type: "number"}]})}, {w: 150, h: 90}) // {x: -6, y: 0, w: 162, h: 90}
 * @example // an OUTPUT-ONLY node (a source) is not padded on its bare left edge
 * @example nodeInkBounds({ports: () => ({outputs: [{key: "o", type: "audio"}]})}, {w: 150, h: 90}) // {x: 0, y: 0, w: 156, h: 90}
 * @example // and a widget with no ports at all is exactly its box
 * @example nodeInkBounds({}, {w: 150, h: 90}) // {x: 0, y: 0, w: 150, h: 90}
 */
export function nodeInkBounds(plugin, state) {
  const w = state?.w ?? 0, h = state?.h ?? 0;
  const { inputs, outputs } = declaredPorts(plugin, state ?? {});
  const left = inputs.length ? PORT_BEAD_R : 0;
  const right = outputs.length ? PORT_BEAD_R : 0;
  return { x: -left, y: 0, w: w + left + right, h };
}
