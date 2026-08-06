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
 * port. Nothing in this file interprets it beyond skipping the check; the semantics
 * live with whoever declares it, and EXACTLY ONE port does — `audio_delay.in`, whose
 * spec states the bar a second one must clear. (This sentence read "No audio port
 * declares it yet" long after DELAY_SPEC declared it. `tests/audio_nodes_test.js`
 * pins the population at one, so that list cannot go stale the same way twice.)
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
 *
 * ── THE NODE-REFERENCE TYPE: AN INPUT MAY BE COMPUTED ───────────────────────
 * USER RULING, 2026-08-03 (verbatim): "The wires are drawn by the receiver node,
 * based on the equation given for where its source output is. That's the way it
 * should work, because if we don't do that we can't keyframe them. Objects should
 * be referenceable as equations and should be nodes. It's a different type than
 * just float and what other things, right? It's a node type."
 *
 * So `inputs.<port>` accepts TWO spellings of the same thing:
 *
 *     inputs.gain = {item: "ab12cd34", port: "out"}   // drag-authored LITERAL
 *     inputs.gain = "= osc1.out"                      // an EQUATION
 *
 * THE GRAMMAR IS THE BARE SLUG, and it needed no new constructor. `= osc1` is a
 * lone item reference — exactly the shape `closest_to_rim(box, …)` already takes
 * as a widget argument, read off the lazy ref proxy's REF_SEGS. `= osc1.out`
 * names the port as a second segment; with the port omitted, the source's FIRST
 * declared output is used, because a source with one output (the common case) has
 * only one thing the author could have meant.
 *
 * WHY NOT `ref("osc1", "out")`, which was the brief's other candidate: it puts an
 * item NAME inside a STRING literal, and no rename walk rewrites string contents.
 * Renaming the oscillator would silently dangle every such equation. A slug cannot
 * have that bug BY CONSTRUCTION — references are STORED by itemId and DISPLAYED as
 * slugs (see core/expressions.js's header: "renames then need NO document
 * rewrites"), so the rename is a display-time re-derivation, not a rewrite.
 *
 * ── RESOLUTION IS DETERMINISTIC, AND HAPPENS BEFORE ANY WIRE IS DRAWN ───────
 * `evaluateState` runs BEFORE `deriveRenderTree` (web/cameraFrame.js is the one
 * seam that threads it). So by the time `connectionsOf` and `core/derive.deriveWires`
 * read `state.inputs`, an equation-driven input is ALREADY a plain `{item, port}`
 * literal — indistinguishable from a drag-authored one.
 *
 * THAT IS WHY THE WIRE DRAWS IDENTICALLY, and it required no change to BN's wire
 * derivation at all. The user's ruling is satisfied by the pipeline's existing
 * ORDER rather than by a special case: there is exactly one wire-drawing path
 * because downstream there is exactly one input shape.
 *
 * ── DANGLING IS LOUD, THROUGH THE ORDINARY EQUATION-ERROR PATH ──────────────
 * `nodeRefProblem` states what is wrong (unknown item, item is not a node, no such
 * output port) and the evaluator raises it exactly as it raises "evaluates to NaN"
 * — the error lands in `evaluateState`'s error map, the Inspector row shows it, and
 * the slot falls back to its default (null = unwired). It is NEVER silently
 * dropped: a wire that vanished with no explanation is the defect this app's
 * house rules forbid, and a mistyped slug must not read as a deliberate disconnect.
 *
 * ── CLONE SEMANTICS: THE HONEST BOUNDARY, MEASURED ──────────────────────────
 * `NODE_ITEM_REFS` remaps `["inputs", "*", "item"]` on duplicate/clone, so a copied
 * patch rewires onto its copies. THAT MECHANISM CANNOT REACH INSIDE AN EQUATION,
 * and pretending otherwise would be the silent-wrongness this file avoids:
 *
 *   LITERAL  `{item: "ab12", port: "out"}`  → REMAPPED. `inputs.gain.item` is a
 *            leaf holding an itemId, which is precisely what the wildcard names.
 *   EQUATION `"= osc1.out"`                 → NOT remapped by itemRefs, and it
 *            does not need to be. It is stored with the SLUG resolved at read
 *            time, so a clone of the whole patch — which copies the names too —
 *            has its own `osc1`… but only if the copy's slug still resolves to
 *            the COPY rather than the original. Slugs are unique per document
 *            (slugMap disambiguates with `_2`), so a duplicated `osc1` becomes
 *            `osc1_2`, and the clone's equation still reads `osc1` — THE ORIGINAL.
 *
 * SO THE BOUNDARY IS: copying a patch remaps its DRAG-AUTHORED wires and leaves
 * its EQUATION-DRIVEN ones pointing where they were written to point. That is not
 * a bug to fix later, it is what an equation MEANS — `= osc1.out` says "whatever
 * the document calls osc1", and the copy did not become that. An author who wants
 * the copy to follow the copy writes `= self`-relative or re-picks in the row;
 * an author who wants every copy to read one shared source (a master clock, an
 * LFO fanned across a deck) gets that for free, which is the more common intent
 * and the reason not to "fix" it. `core/expressions.clonedItemStates` is where a
 * future slug-rewriting clone mode would go; it is deliberately not done here,
 * because rewriting equation TEXT on copy is the class of magic that makes an
 * author unable to predict what their document says.
 * tests/nodeflow_test.js pins BOTH halves of this boundary so it stays a decision.
 */

// ── PORT TYPES ───────────────────────────────────────────────────────────────

/**
 * THE PORT TYPE TABLE. One entry per type: its color (the user's ruling that the
 * bead color indicates the type), a human label, a `zero` — the value an
 * UNCONNECTED input of that type reads — and `readable`, whether the DOCUMENT can
 * see a value of this type at all.
 *
 * `zero` exists so an unconnected input is never `undefined`: a math node with one
 * wire plugged in still computes, and a display with nothing attached shows a
 * defined value rather than a hole. It is the type's additive identity where that
 * makes sense.
 *
 * ── `readable` IS THE TIER BOUNDARY (manifest R7-7 BOUNDARY) ────────────────
 * Every output port is REFERENCEABLE — that is tier 1, and it is what makes a
 * patch wireable at all. Only SOME outputs additionally expose a value an equation
 * can read (tier 2), and which ones follows from the TYPE rather than from a second
 * hand-maintained list — which is why this is a column on this table.
 *
 * `audio: readable = false` is the one false entry, and it is a fact about the
 * type, not a gap. An `audio` port is an AudioNode on the browser's audio thread
 * (core/audio_specs.js's own words: "control SIGNALS on AudioNodes, not numbers the
 * document can read"); sampling its instantaneous amplitude into the document would
 * make the value frame-rate dependent, ephemeral and non-reproducible — three
 * refusals at once. So `= lfo1.out` is REFUSED WITH A SENTENCE (see
 * core/output_properties.js), never answered with 0 and never with a stale sample.
 *
 * `readable: true` does NOT promise a value exists — it says the type is one the
 * document could hold. Whether a given port HAS one is decided by whether the
 * plugin's `computeOutputs` produced it, which is the honest answer for the audio
 * roster's `trigger` output (audio_specs TRIGGER_SPEC): typed readable, but its
 * pulse train lives in the engine, so it produces nothing and reading it says so.
 *
 * The reserved-for-later types (image / material / shape, per the blueprint) are
 * NOT declared here. A type with no widget that produces it would be a color in a
 * legend for a wire nobody can draw; they get declared by whoever adds the first
 * producer, which is also who knows what its `zero` should be.
 */
export const PORT_TYPES = Object.freeze({
  number: Object.freeze({ label: "Number", color: "#7aa2f7", zero: 0, readable: true }),
  trigger: Object.freeze({ label: "Trigger", color: "#e0af68", zero: 0, readable: true }),
  audio: Object.freeze({ label: "Audio", color: "#9ece6a", zero: 0, readable: false }),
  // THE NODE TYPE (user ruling, 2026-08-03: "Objects should be referenceable as
  // equations and should be nodes. It's a different type than just float ... It's
  // a node type."). A `node` value is a REFERENCE to another item's output port —
  // `{item, port}`, the very shape a drag-authored connection stores.
  //
  // ITS `zero` IS null, NOT 0, and that is the whole difference from the three
  // above. Their zeros are additive identities: an unconnected number reads 0 and
  // the arithmetic still works. There is no "identity item" — a reference to
  // nothing is nothing — so the zero is the absence itself, and every reader
  // already treats a null `inputs.<port>` as unwired (connectionsOf, disconnectPairs).
  // Using 0 would have made an unwired node port claim to point at an item.
  // `readable: true` because a reference IS document state — it is exactly what
  // `inputs.<port>` already stores and keyframes. Reading one yields the
  // `{item, port}` record, not a number, which is the tier-1 property TYPE the
  // R7-7 boundary names (core/expressions.js NODEREF_KIND validates it).
  node: Object.freeze({ label: "Node", color: "#bb9af7", zero: null, readable: true }),
  // THE EXEC TYPE (manifest R7-8). An exec pin carries NO VALUE AT ALL — it carries
  // CONTROL: "when this happens, do that next". Everything about it is the mirror
  // image of a data port, and the mirror is the point (see EXEC WIRES below):
  //
  //   data OUT fans out to many │ data IN accepts at most one
  //   exec OUT fires at most one│ exec IN may be fired by many
  //
  // `zero: null` for the reason `node` has one: there is no additive identity for
  // "nothing happened". `readable: false` because there is no value to read — but
  // note this is a DIFFERENT falsity from `audio`'s. An audio signal HAS a value the
  // document may not see; an exec pulse has no value in any domain. That is why
  // core/output_properties.js excludes exec ports from the outputs section outright
  // rather than listing them with the audio refusal sentence, which would be a true
  // statement about the wrong thing.
  //
  // THE COLOUR IS DELIBERATELY UNSATURATED. The other four types are hues that say
  // "this is a KIND of value"; exec is not one of them, and Unreal reached the same
  // answer (its exec pins are white among coloured data pins). A fifth hue would put
  // control flow in the same visual vocabulary as the values it sequences.
  exec: Object.freeze({ label: "Exec", color: "#c0caf5", zero: null, readable: false }),
});

/** Every declared port type name, for validation messages and test sweeps. */
export const PORT_TYPE_NAMES = Object.freeze(Object.keys(PORT_TYPES));

/** THE exec port type's name. Spelled once so no reader compares against the
 *  string literal `"exec"` — the mistake the R7 brief calls "grep the constant, not
 *  the string it holds". */
export const EXEC_TYPE = "exec";

/** THE state key an EXEC wire is stored under, mirroring `inputs` for data wires:
 *  `state.exec = {"<execOutKey>": {item, port}}`. See EXEC WIRES below for why it
 *  lives on the FIRING node rather than the fired one. */
export const EXEC_KEY = "exec";

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
 * Pure function. Can the DOCUMENT hold a value of this port type — i.e. may an
 * equation read it (tier 2), or is the port referenceable only (tier 1)? See the
 * PORT_TYPES docblock for why `audio` is the false one.
 *
 * @param {string} type - a PORT_TYPES key
 * @returns {boolean}
 *
 * @example portReadable("number") // true
 * @example portReadable("audio") // false (a signal on the audio thread; the document never sees it)
 */
export function portReadable(type) {
  const t = PORT_TYPES[type];
  if (!t) throw new Error(`nodeflow: unknown port type ${JSON.stringify(type)} — declare it in PORT_TYPES (have: ${PORT_TYPE_NAMES.join(", ")})`);
  return t.readable;
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
 *
 * ── `node` HAS NO COERCIONS IN EITHER DIRECTION, AND THAT IS A TYPE FACT ────
 * Not an omission awaiting a producer. The other four types all carry a VALUE
 * that flows down a wire; `node` carries an IDENTITY — WHICH item, not what it
 * currently reads. Every candidate pair is a category error:
 *   node → number    would have to mean "the item's current output", which is a
 *                    DEREFERENCE, not a cast. The wire that dereferences already
 *                    exists: connect that output directly. A coercion here would
 *                    silently duplicate the graph's own edge with worse timing.
 *   number → node    there is no item whose identity is 3.
 * So a `node` port connects only to a `node` port, and `typesCompatible` says so
 * with no entry needed (identity is always allowed). The honest-only rule the
 * table states is what keeps this a decision rather than a gap.
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

/** The Inspector category a node's input rows file under. One category, so a
 *  patch's wiring is one collapsible group rather than rows scattered among the
 *  transform and the knobs. */
export const INPUTS_CAT = "inputs";

/**
 * Pure function. THE INSPECTOR ROWS FOR A NODE'S INPUT PORTS — one row per
 * declared input, at the state path the wire is stored in.
 *
 * ── WHY THIS EXISTS (user ruling, 2026-08-03, verbatim) ─────────────────────
 * "It is a bit weird that Filter, for example, as one audio node that I see here,
 * doesn't record, actually none of these nodes seem to record any of their inputs
 * as properties. Their inputs should all be properties."
 *
 * The connections WERE already properties — keyframeable state leaves at
 * `inputs.<port>`, which is what makes a patch differ per slide. What was missing
 * was that the Inspector never SHOWED them, so the panel asserted by omission that
 * a node had no wiring to speak of. This is the group-members "invisible by
 * omission" pattern: state that exists, is editable, and is undiscoverable.
 *
 * ── EVERY ROW IS AN ORDINARY ROW, WHICH IS THE WHOLE POINT ──────────────────
 * The row's `key` is the ORDINARY state path `inputs.<port>`, so it keyframes,
 * undoes, multi-selects and takes an `=` equation through the same machinery every
 * other property uses. Nothing in web/Inspector.svelte needs to know what a node
 * is; it needs to know how to draw ONE new control kind (NODE_INPUT_ROW_KIND).
 * That is the same trade core/audio_nodes.audioKnobRows makes for knobs, and for
 * the same stated reason: a declarative row is keyframable for free.
 *
 * `portType` rides on the row because the picker must offer only outputs this
 * input can legally accept — the SAME question connectionRefusal answers at the
 * bead, so a wire the drag would refuse cannot be spelled in the dropdown either.
 *
 * @param {object} plugin - the node's plugin (its `ports(state)` declaration)
 * @param {object} [state] - the folded state to ask for ports (a port list may vary with state)
 * @returns {object[]} Inspector row descriptors, one per declared input port
 *
 * @example // a filter's audio input becomes one row at the path its wire is stored in
 * @example nodeInputRows({ports: () => ({inputs: [{key: "in", type: "audio", label: "In"}]})})[0].key // "inputs.in"
 * @example nodeInputRows({ports: () => ({inputs: [{key: "in", type: "audio", label: "In"}]})})[0].kind // "nodeinput"
 * @example nodeInputRows({ports: () => ({inputs: [{key: "in", type: "audio", label: "In"}]})})[0].portType // "audio"
 * @example // the LABEL is the port's own, so the row reads the way the bead is labelled
 * @example nodeInputRows({ports: () => ({inputs: [{key: "fm", type: "number", label: "FM depth"}]})})[0].label // "FM depth"
 * @example // a widget with no inputs contributes no rows at all
 * @example nodeInputRows({}) // []
 * @example // an EXEC input has no row, because it stores nothing — the wire into it
 * @example // lives on the FIRING node's side (see EXEC WIRES below)
 * @example nodeInputRows({ports: () => ({inputs: [{key: "run", type: "exec"}]})}) // []
 */
export function nodeInputRows(plugin, state) {
  // EXEC INPUTS ARE EXCLUDED, and it is a storage fact rather than a presentation
  // choice: `inputs.<port>` is where a DATA wire is stored, and an exec wire is not
  // stored there — it is stored at `exec.<port>` on the node that FIRES it. A row
  // here would edit a leaf nothing reads, which is exactly the defect R7-1 fixed.
  return declaredPorts(plugin, state ?? plugin?.defaults ?? {}).inputs.filter((p) => p.type !== EXEC_TYPE).map((p) => ({
    key: `inputs.${p.key}`,
    label: p.label,
    kind: NODE_INPUT_ROW_KIND,
    portType: p.type,
    category: INPUTS_CAT,
    help: `Which node output feeds this ${PORT_TYPES[p.type].label} input. Pick any compatible output on this slide, or clear it to disconnect. It is ordinary keyframable state, so a patch can be rewired from one slide to the next — and you can bind it with "=" to compute the source (e.g. "= osc1").`,
  }));
}

/**
 * THE `itemRefs` DECLARATION every node plugin spreads, so duplicate / clone /
 * shatter remap a copied patch onto the copies instead of leaving them wired to the
 * originals (core/document.js reads `plugin.itemRefs`; plugins/group.js's `members`
 * is the precedent). `"*"` is the WILDCARD segment — every input key.
 *
 * Declared HERE rather than written out in each node plugin so the path cannot be
 * spelled three different ways by three widgets.
 *
 * THE EXEC MAP IS A SEPARATE CONSTANT, AND THAT WAS MEASURED RATHER THAN CHOSEN.
 * The first attempt put `exec.*.item` in THIS array, reasoning that a widget without
 * the map pays nothing because a wildcard over an absent slot expands to no paths.
 * `tests/multipaste_test.js` refused it, correctly: *"plugin \"node_number\" declares
 * itemRefs path [\"exec\",\"*\",\"item\"] but its defaults have no such key"*. A
 * declared ref path is a PROMISE that the slot exists — the same promise `inputs: {}`
 * is present-but-empty to keep — so naming a map a widget does not have is a
 * declaration that can never be honoured. Widgets with exec pins spread
 * EXEC_ITEM_REFS as well, and `execKindProblem` makes forgetting it LOUD rather than
 * leaving a duplicated event firing at the original.
 */
export const NODE_ITEM_REFS = Object.freeze([Object.freeze(["inputs", "*", "item"])]);

/** The itemRefs declaration a widget with EXEC PINS spreads IN ADDITION to
 *  NODE_ITEM_REFS, so a copied trigger fires at the copy. Separate from that
 *  constant because a declared ref path promises the slot exists — see above. */
export const EXEC_ITEM_REFS = Object.freeze([Object.freeze([EXEC_KEY, "*", "item"])]);

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
 * THE INSPECTOR ROW KIND for a node input port (core/properties.js ROW_KINDS).
 *
 * Declared HERE, beside the `{item, port}` shape it edits, for the reason
 * core/lists.js declares LIST_ROW_KIND: the module that owns a mechanism owns the
 * name of the control that edits it, so a row kind cannot be spelled one way in
 * the vocabulary and another way in the plugin that emits it.
 */
export const NODE_INPUT_ROW_KIND = "nodeinput";

/**
 * Pure function. Is `v` a well-formed node REFERENCE — the `{item, port}` record an
 * input slot holds when it is wired? THE one shape test; every reader that has to
 * distinguish "wired" from "unwired" asks this rather than re-spelling the check,
 * which is what stops `null`, `undefined` and a half-written `{item}` being read
 * three different ways in three places.
 *
 * @param {*} v - a candidate
 * @returns {boolean}
 *
 * @example isNodeRef({item: "ab12", port: "out"}) // true
 * @example isNodeRef(null) // false (an unwired input — the `node` type's zero)
 * @example isNodeRef({item: "ab12"}) // false (a port is not optional in STORAGE)
 * @example isNodeRef("= osc1") // false (an equation is not yet a reference — it evaluates to one)
 */
export function isNodeRef(v) {
  return !!v && typeof v === "object" && typeof v.item === "string" && typeof v.port === "string";
}

/**
 * Pure function. WHY a node reference does not name a real output port, or null
 * when it does. THE dangling check — the sentence the equation-error path reports.
 *
 * It completes "… — <sentence>", so it states a fact about the DOCUMENT (a name
 * that is not there, an item that is not a node), never about the code. The three
 * failures are kept distinct because they have three different fixes: a typo, a
 * wire aimed at a plain widget, and a port that was renamed out from under it.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {*} ref - the candidate reference
 * @returns {string|null} the problem sentence, or null when the reference resolves
 *
 * @example nodeRefProblem({}, {get: () => ({})}, {item: "ghost", port: "out"}) // 'no item "ghost" is on this slide'
 * @example // a real node with that output resolves cleanly:
 * @example nodeRefProblem({a: {type: "s"}}, {get: () => ({ports: () => ({outputs: [{key: "out", type: "audio"}]})})}, {item: "a", port: "out"}) // null
 * @example // …and naming a port it does not declare says so, with what it DOES have:
 * @example nodeRefProblem({a: {type: "s"}}, {get: () => ({ports: () => ({outputs: [{key: "out", type: "audio"}]})})}, {item: "a", port: "nope"}) // '"a" has no output named "nope" (it has: out)'
 */
export function nodeRefProblem(items, registry, ref) {
  if (!isNodeRef(ref)) return "is not a node reference";
  const state = items?.[ref.item];
  if (!state || state.active === false) return `no item ${JSON.stringify(ref.item)} is on this slide`;
  const plugin = pluginFor(items, registry, ref.item);
  const outputs = plugin ? declaredPorts(plugin, state).outputs : [];
  if (outputs.length === 0) return `${JSON.stringify(ref.item)} is not a node — it has no output ports`;
  if (!outputs.some((p) => p.key === ref.port))
    return `${JSON.stringify(ref.item)} has no output named ${JSON.stringify(ref.port)} (it has: ${outputs.map((p) => p.key).join(", ")})`;
  return null;
}

/**
 * Pure function. The output port an equation-produced reference MEANS when it names
 * no port — the source's FIRST declared output, or null when it declares none.
 *
 * WHY A DEFAULT AT ALL: `= osc1` is what an author writes, and a source with one
 * output has exactly one thing they could have meant. Requiring `= osc1.out`
 * universally would be ceremony for the common case. WHY THE FIRST rather than
 * "the only one": a plugin's port ORDER is already meaningful (it is the top-to-
 * bottom bead layout the author sees), so the first output is the one at the top of
 * the card — a rule that reads off the picture instead of a rule that fails as soon
 * as a module grows a second output.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {string} itemId - the source item
 * @returns {string|null} the default output port key
 *
 * @example defaultOutputPort({a: {type: "s"}}, {get: () => ({ports: () => ({outputs: [{key: "out", type: "audio"}, {key: "aux", type: "audio"}]})})}, "a") // "out"
 * @example defaultOutputPort({a: {type: "s"}}, {get: () => ({ports: () => ({outputs: []})})}, "a") // null
 */
export function defaultOutputPort(items, registry, itemId) {
  const state = items?.[itemId];
  const plugin = state ? pluginFor(items, registry, itemId) : null;
  return (plugin ? declaredPorts(plugin, state).outputs[0]?.key : null) ?? null;
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
  // ── THE PROPOSED EDGE IS EXEMPT TOO, AND OMITTING IT WAS A REAL DEFECT ────
  // The filter below excludes EXISTING edges entering a feedbackSafe port, but the edge
  // being PROPOSED was never exempted — so the one port in the library designed to permit
  // feedback could not receive the wire that CLOSES the loop.
  //
  // MEASURED, on the shipped registry:
  //   loop with ONE  audio_delay  — proposing filter.out -> delay.in   REFUSED  (wrong)
  //   loop with TWO  audio_delays — proposing d2.out    -> d1.in       allowed
  //   loop with NO   safe port    — proposing b.out     -> a.in        REFUSED  (right)
  // One is refused and two are fine, which is exactly backwards from what the declaration
  // means. `audio_delay.in` is the only feedbackSafe port we ship, so in practice EVERY
  // single-delay feedback loop was inexpressible.
  //
  // IT COST REAL FIDELITY BEFORE ANYONE NAMED IT. Three patch agents hit it independently
  // and worked around it three different ways: the Axoloti reverb set drew every FDN leg
  // as TWO delay segments summing to the authored length (adding a stated 6 ms detune to
  // two legs); P1's `Marbles[Y] -> Marbles[T jitter]` self-patch — the module modulating
  // its own clock jitter, which the survey calls the patch's signature — was dropped; and
  // P2's burst generator, P9's Rampage self-timing and P22's pitch feedback were all cut.
  //
  // WHY IT IS SAFE: a feedbackSafe port is a declared CUT in the graph. An edge entering
  // one cannot create a cycle that the evaluator must resolve, which is the entire claim
  // the declaration makes — so the walk below has nothing to look for. The blast radius is
  // unchanged: `tests/audio_nodes_test.js` pins that `audio_delay.in` is still the ONLY
  // port allowed to declare it, so this widens nothing beyond that one deliberate hatch.
  if (portIsFeedbackSafe(items, registry, to)) return false;
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
 * @example // an exec out into an exec in is legal, and its loop check is the EXEC walk
 * @example const ereg = {get: () => ({ports: () => ({inputs: [{key: "run", type: "exec"}], outputs: [{key: "then", type: "exec"}]})})};
 * @example connectionRefusal({a: {type: "e"}, b: {type: "e"}}, ereg, {item: "a", port: "then"}, {item: "b", port: "run"}) // null
 * @example // …and exec never crosses into a data pin, in either direction
 * @example connectionRefusal({a: {type: "e"}, b: {type: "n"}}, {get: (t) => t === "e" ? {ports: () => ({outputs: [{key: "then", type: "exec"}]})} : {ports: () => ({inputs: [{key: "i", type: "number"}]})}}, {item: "a", port: "then"}, {item: "b", port: "i"}) // "an Exec output cannot drive a Number input — an exec pin carries control, not a value: it says WHEN something happens, and there is no number in that"
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
  if (!typesCompatible(outPort.type, inPort.type)) {
    // AN EXEC MISMATCH GETS ITS OWN SENTENCE, because "there is no conversion
    // between them" would be a true statement that teaches the wrong thing: a
    // reader would go looking for the missing coercion. There is no conversion
    // because there is no VALUE — the two pin families answer different questions.
    if (outPort.type === EXEC_TYPE || inPort.type === EXEC_TYPE)
      return `an ${PORT_TYPES[outPort.type].label} output cannot drive a ${PORT_TYPES[inPort.type].label} input — an exec pin carries control, not a value: it says WHEN something happens, and there is no number in that`;
    return `a ${PORT_TYPES[outPort.type].label} output cannot drive a ${PORT_TYPES[inPort.type].label} input — there is no conversion between them`;
  }
  // THE TWO GRAPHS HAVE TWO LOOP RULES because they are two graphs (see
  // execWouldCycle). Dispatching on the port type rather than checking both is what
  // keeps an ordinary read-then-fire patch (data a→b, exec b→a) legal.
  if (outPort.type === EXEC_TYPE) {
    if (execWouldCycle(items, from, to))
      return "that would make a loop — running this would eventually run it again, and an event cannot be its own cause";
    return null;
  }
  if (wouldCycle(items, registry, from, to))
    return "that would make a loop — this node already feeds the one you are dragging from, and a value cannot depend on itself";
  return null;
}

/**
 * Pure function. HOW A WIRED INPUT ROW READS — "<source name> › <port>", or the
 * empty string when the input is unwired.
 *
 * IT NAMES AN INSTANCE, NOT A CLASS, AND THAT IS WHY IT TAKES A NAME RATHER THAN
 * THE ITEM MAP (ROUND 7 R7-1). It used to look the name up itself and fall back to
 * `state.type`, but `app.addItem` sets NO default `name` ("NO WIDGET TYPE IS NAMED
 * HERE, deliberately", web/app.svelte.js) — so every freshly added node fell
 * through to its TYPE and two keyboards both rendered the identical string
 * "node_keyboard › pitch". The user, on that list: *"This drop-down lists a bunch
 * of things that aren't connected to any one specific node."* They were connected
 * to specific nodes; they were LABELLED with a class name.
 *
 * The caller therefore supplies the app's ONE display name (`app.displayName` →
 * the item's `name`, else core/document.js `itemFallbackName(title, id)` →
 * "Keyboard (ab12)"), which is what the item picker, the item-valued select row,
 * the outline and the keyframe panel all already show. Deriving a second
 * per-instance name here would be a second naming scheme for one concept — and it
 * CANNOT be the same one by import: `core/nodeflow.js` has no imports on purpose,
 * and pulling `itemFallbackName` in from core/document.js is a measured hard crash,
 * not a style question (document.js → derive.js → nodeflow.js is a cycle, and
 * core/properties.js:750 reads this module's NODE_INPUT_ROW_KIND at evaluation
 * time: "ReferenceError: Cannot access 'NODE_INPUT_ROW_KIND' before initialization").
 *
 * THE NAME IS RE-DERIVED EVERY TIME, never stored. That is what makes a rename cost
 * nothing: the reference holds an itemId, and the label is a display-time lookup
 * (the identical decision core/expressions.js makes for slugs — "renames then need
 * NO document rewrites"). A row that stored its label would go stale the moment the
 * source was renamed, and would then disagree with the wire drawn on the canvas.
 *
 * A reference whose item is NOT on this slide still renders — `app.displayName`
 * returns the raw id for an item that is not on the fold — and does NOT throw: the
 * connection leaf legitimately survives a slide where its source is inactive
 * (connectionsOf states that rule), so a row that blew up there would report a
 * per-slide patch as a defect. `nodeRefProblem` is what says a reference is
 * genuinely broken; this function only formats.
 *
 * @param {string} displayName - the SOURCE item's display name (app.displayName)
 * @param {*} ref - the input's value ({item, port} or null)
 * @returns {string} the label, or "" when unwired
 *
 * @example nodeInputLabel("Osc 1", {item: "a", port: "out"}) // "Osc 1 › out"
 * @example // unnamed? app.displayName's fallback distinguishes two of a kind:
 * @example nodeInputLabel("Keyboard (7f3c)", {item: "7f3c…", port: "pitch"}) // "Keyboard (7f3c) › pitch"
 * @example nodeInputLabel("Keyboard (b104)", {item: "b104…", port: "pitch"}) // "Keyboard (b104) › pitch"
 * @example nodeInputLabel("", null) // "" (unwired)
 * @example // a source that is off THIS slide is shown by id, not treated as an error
 * @example nodeInputLabel("ab12", {item: "ab12", port: "out"}) // "ab12 › out"
 */
export function nodeInputLabel(displayName, ref) {
  if (!isNodeRef(ref)) return "";
  return `${displayName || ref.item} › ${ref.port}`;
}

/**
 * Pure function. EVERY OUTPUT PORT ON THIS SLIDE THAT MAY LEGALLY DRIVE `to` —
 * the option list behind an input row's picker.
 *
 * IT ROUTES THROUGH `connectionRefusal`, deliberately, rather than re-deciding
 * legality from the type table. The dropdown and the wire drag then cannot
 * disagree about what is connectable: a source the canvas would refuse (wrong
 * type, or one that would close a cycle) is not offered here either. Re-spelling
 * the rule would give the two surfaces two chances to drift, and the one that
 * drifted would silently author a document the other calls invalid.
 *
 * Each option carries the coercion sentence when the wire is cross-type, so the
 * picker can say what a legal-but-converting choice will do — the same sentence
 * the drag shows before the drop.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {{item: string, port: string}} to - the input being wired
 * @returns {object[]} [{item, port, type, label, note}] in deterministic order
 *
 * @example // a noise source's audio out is offered to a filter's audio in:
 * @example const reg = {get: (t) => t === "s" ? {ports: () => ({outputs: [{key: "out", type: "audio"}]})} : {ports: () => ({inputs: [{key: "in", type: "audio"}]})}};
 * @example compatibleSources({a: {type: "s"}, b: {type: "f"}}, reg, {item: "b", port: "in"}).map((o) => `${o.item}.${o.port}`) // ["a.out"]
 * @example // and a node never offers its own output to its own input (that is a cycle)
 * @example compatibleSources({b: {type: "f"}}, {get: () => ({ports: () => ({inputs: [{key: "in", type: "audio"}], outputs: [{key: "out", type: "audio"}]})})}, {item: "b", port: "in"}) // []
 */
export function compatibleSources(items, registry, to) {
  const out = [];
  for (const id of Object.keys(items ?? {}).sort()) {
    const state = items[id];
    if (!state || state.active === false) continue;
    const plugin = pluginFor(items, registry, id);
    if (!plugin) continue;
    for (const p of declaredPorts(plugin, state).outputs) {
      const from = { item: id, port: p.key };
      if (connectionRefusal(items, registry, from, to) !== null) continue;
      const inPort = findPort(pluginFor(items, registry, to.item), items[to.item], "input", to.port);
      out.push({ item: id, port: p.key, type: p.type, label: p.label, note: inPort ? coercionNote(p.type, inPort.type) : null });
    }
  }
  return out;
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

// ── EXEC WIRES ───────────────────────────────────────────────────────────────
//
// THE CARDINALITIES ARE EXACT MIRRORS, AND THAT SYMMETRY IS THE STRUCTURAL FACT
// (manifest R7-8 DESIGN, verified against Unreal Blueprint in
// .frenzy/round7/patchers_blueprints_report.md §B1):
//
//     exec OUT ≤ 1 wire      exec IN  many
//     data OUT   many        data IN  ≤ 1
//
// A DATA wire is stored on the INPUT side (`state.inputs[port]`) because that makes
// fan-in-1 structural — a second wire to the same input is the same object key and
// overwrites the first. THE EXEC WIRE IS STORED ON THE OUTPUT SIDE
// (`state.exec[port]`) FOR EXACTLY THAT REASON, MIRRORED: an exec out fires at most
// one thing, so a second wire from the same exec out overwrites the first, and
// "two continuations from one pin" is not spellable. That is the manifest's
// "cardinality is enforced by honouring the new wire and silently dropping the old,
// not by refusing" — and here it is not even enforcement, it is arithmetic.
//
// WHY EXEC IS A SEPARATE WIRE KIND AT ALL, in one sentence: side effects need a
// TOTAL order and pure values need only a partial one. Dataflow cannot express "do A
// then B when neither reads the other", cannot express zero occurrences, and cannot
// branch. The execution model that reads these edges is core/exec_flow.js; this
// section is only the WIRE — its shape, its legality and its editing.
//
// EVERYTHING ELSE IS SHARED ON PURPOSE. An exec port is an ordinary entry in
// PORT_TYPES, so it is declared by the ordinary `ports(state)`, laid out by the
// ordinary portLayout, drawn as an ordinary bead in the ordinary type colour, and
// hit-tested by the ordinary portAt. A parallel "execPorts" declaration would have
// duplicated all of that, which is the Tower of Babel this file exists to avoid.

/** The Inspector category an exec-out row files under — its own group, directly
 *  after Inputs, because a patch reads values IN and control OUT and the two are
 *  different questions about the same node. */
export const EXEC_CAT = "exec";

/**
 * Pure function. Every EXEC edge in a folded item map — the mirror of
 * `connectionsOf`, and THE one reader of the `state.exec` shape.
 *
 * The absent-source rule is mirrored too, and points the other way: a DATA edge is
 * dropped when its SOURCE is off the slide; an exec edge is dropped when its TARGET
 * is, because the edge is stored on the source. Both say the same thing — an edge
 * with an end that is not on this slide is a per-slide patch, not an error.
 *
 * @param {object} items - folded items, {id: state}
 * @returns {object[]} [{from: {item, port}, to: {item, port}}], deterministic order
 *
 * @example execEdgesOf({a: {exec: {then: {item: "b", port: "run"}}}, b: {}}) // [{from: {item: "a", port: "then"}, to: {item: "b", port: "run"}}]
 * @example execEdgesOf({a: {exec: {then: {item: "gone", port: "run"}}}}) // [] (target absent on this slide — not an error)
 * @example execEdgesOf({a: {exec: {then: null}}, b: {}}) // [] (null is the stored "disconnected")
 */
export function execEdgesOf(items) {
  const out = [];
  for (const id of Object.keys(items ?? {}).sort()) {
    const state = items[id];
    if (!state || state.active === false) continue;
    const wires = state[EXEC_KEY];
    if (!wires || typeof wires !== "object") continue;
    for (const port of Object.keys(wires).sort()) {
      const c = wires[port];
      if (!isNodeRef(c)) continue;
      const dst = items[c.item];
      if (!dst || dst.active === false) continue;
      out.push({ from: { item: id, port }, to: { item: c.item, port: c.port } });
    }
  }
  return out;
}

/**
 * Pure function. Would firing `from` (an exec out) into `to` (an exec in) close a
 * loop in the execution graph? The mirror of `wouldCycle`, over exec edges.
 *
 * IT IS A SEPARATE WALK, NOT A SHARED ONE, and that is a semantic fact rather than
 * an implementation detail: the two graphs are independent. A data edge a→b and an
 * exec edge b→a is a perfectly ordinary patch — b reads a's number and then, when it
 * runs, tells a to do something. Walking one combined graph would refuse it.
 *
 * @param {object} items - folded items
 * @param {{item: string, port: string}} from - the proposed SOURCE (an exec out)
 * @param {{item: string, port: string}} to - the proposed DESTINATION (an exec in)
 * @returns {boolean}
 *
 * @example execWouldCycle({a: {}, b: {}}, {item: "a", port: "then"}, {item: "b", port: "run"}) // false
 * @example execWouldCycle({a: {}}, {item: "a", port: "then"}, {item: "a", port: "run"}) // true (a node cannot fire itself)
 * @example // a fires b already, so b firing a would loop:
 * @example execWouldCycle({a: {exec: {then: {item: "b", port: "run"}}}, b: {}}, {item: "b", port: "then"}, {item: "a", port: "run"}) // true
 */
export function execWouldCycle(items, from, to) {
  const downstream = new Map(); // itemId → [target itemIds]
  for (const e of execEdgesOf(items)) {
    if (!downstream.has(e.from.item)) downstream.set(e.from.item, []);
    downstream.get(e.from.item).push(e.to.item);
  }
  // Walk FORWARD from the proposed destination: reaching the proposed source means
  // the destination already fires the source, so source→destination closes the loop.
  const seen = new Set();
  const stack = [to.item];
  while (stack.length) {
    const id = stack.pop();
    if (id === from.item) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const down of downstream.get(id) ?? []) stack.push(down);
  }
  return false;
}

/**
 * Pure function. The state-path/value pairs that wire an EXEC OUT to an EXEC IN —
 * the mirror of `connectPairs`, writing on the SOURCE side.
 *
 * @param {{item: string, port: string}} from - the SOURCE exec out
 * @param {{item: string, port: string}} to - the DESTINATION exec in
 * @returns {Array} [[path, value]] pairs
 *
 * @example execConnectPairs({item: "a", port: "then"}, {item: "b", port: "run"}) // [[["items", "a", "exec", "then"], {item: "b", port: "run"}]]
 */
export function execConnectPairs(from, to) {
  return [[["items", from.item, EXEC_KEY, from.port], { item: to.item, port: to.port }]];
}

/**
 * Pure function. The pairs that CLEAR an exec out. `null`, not a deleted key, for
 * the reason `disconnectPairs` states: a removed key would be re-inherited from an
 * earlier slide's delta and the wire would come back on its own.
 *
 * @param {{item: string, port: string}} from - the exec out to clear
 * @returns {Array} [[path, value]] pairs
 *
 * @example execDisconnectPairs({item: "a", port: "then"}) // [[["items", "a", "exec", "then"], null]]
 */
export function execDisconnectPairs(from) {
  return [[["items", from.item, EXEC_KEY, from.port], null]];
}

/**
 * Pure function. Is this an EXEC wire — i.e. does the SOURCE port declare the exec
 * type? THE one dispatcher every caller that must pick a side asks, so "which map
 * does this wire live in" is decided in one place from the declaration rather than
 * re-derived at each call site.
 *
 * A source port that cannot be resolved answers false: an unresolvable wire is not
 * an exec wire, and treating it as one would write into the wrong map.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {{item: string, port: string}} from - the SOURCE output port
 * @returns {boolean}
 *
 * @example const reg = {get: () => ({ports: () => ({outputs: [{key: "then", type: "exec"}]})})};
 * @example isExecWire({a: {type: "e"}}, reg, {item: "a", port: "then"}) // true
 * @example isExecWire({a: {type: "e"}}, reg, {item: "a", port: "nope"}) // false
 */
export function isExecWire(items, registry, from) {
  const state = items?.[from?.item];
  const plugin = state ? pluginFor(items, registry, from.item) : null;
  return (plugin ? findPort(plugin, state, "output", from.port)?.type : null) === EXEC_TYPE;
}

/**
 * Pure function. THE pairs that make a wire, whichever kind it is — the one seam a
 * drop gesture and a dropdown both go through, so neither has to know that exec
 * wires are stored on the other side. `wirePairsFor` is to storage what
 * `connectionRefusal` is to legality.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {{item: string, port: string}} from - the SOURCE output
 * @param {{item: string, port: string}} to - the DESTINATION input
 * @returns {Array} [[path, value]] pairs
 *
 * @example const reg = {get: () => ({ports: () => ({outputs: [{key: "o", type: "number"}]})})};
 * @example wirePairsFor({a: {type: "n"}}, reg, {item: "a", port: "o"}, {item: "b", port: "i"}) // [[["items", "b", "inputs", "i"], {item: "a", port: "o"}]]
 * @example const ereg = {get: () => ({ports: () => ({outputs: [{key: "then", type: "exec"}]})})};
 * @example wirePairsFor({a: {type: "e"}}, ereg, {item: "a", port: "then"}, {item: "b", port: "run"}) // [[["items", "a", "exec", "then"], {item: "b", port: "run"}]]
 */
export function wirePairsFor(items, registry, from, to) {
  return isExecWire(items, registry, from) ? execConnectPairs(from, to) : connectPairs(from, to);
}

/**
 * Pure function. EVERY EXEC INPUT ON THIS SLIDE THIS EXEC OUT MAY LEGALLY FIRE —
 * the option list behind an exec-out row's picker, and the mirror of
 * `compatibleSources`.
 *
 * It routes through `connectionRefusal` for the reason that function's own docblock
 * gives: the dropdown and the wire drag must not get two chances to disagree.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {{item: string, port: string}} from - the exec output being wired
 * @returns {object[]} [{item, port, type, label}] in deterministic order
 *
 * @example // an event's `then` is offered every exec input on the slide:
 * @example const reg = {get: (t) => t === "e" ? {ports: () => ({outputs: [{key: "then", type: "exec"}]})} : {ports: () => ({inputs: [{key: "run", type: "exec"}]})}};
 * @example compatibleExecTargets({a: {type: "e"}, b: {type: "s"}}, reg, {item: "a", port: "then"}).map((o) => `${o.item}.${o.port}`) // ["b.run"]
 * @example // …and never its own, which would be a loop
 * @example compatibleExecTargets({a: {type: "x"}}, {get: () => ({ports: () => ({inputs: [{key: "run", type: "exec"}], outputs: [{key: "then", type: "exec"}]})})}, {item: "a", port: "then"}) // []
 */
export function compatibleExecTargets(items, registry, from) {
  const out = [];
  for (const id of Object.keys(items ?? {}).sort()) {
    const state = items[id];
    if (!state || state.active === false) continue;
    const plugin = pluginFor(items, registry, id);
    if (!plugin) continue;
    for (const p of declaredPorts(plugin, state).inputs) {
      if (p.type !== EXEC_TYPE) continue;
      const to = { item: id, port: p.key };
      if (connectionRefusal(items, registry, from, to) !== null) continue;
      out.push({ item: id, port: p.key, type: p.type, label: p.label });
    }
  }
  return out;
}

/**
 * Pure function. THE INSPECTOR ROWS FOR A NODE'S EXEC OUTPUTS — one row per declared
 * exec output, at the state path the wire is stored in (`exec.<port>`).
 *
 * ── WHY EXEC OUTS GET ROWS AND EXEC INS DO NOT ──────────────────────────────
 * Not a presentation judgement: an exec OUT is where the wire is STORED, so it is a
 * property, and NO JSON-ONLY PROPERTIES means it must have a row. An exec IN stores
 * nothing at all — there is no leaf to edit — so a row there would be a control over
 * a value that does not exist. The bead on the canvas is its whole surface, and that
 * is the same answer `nodeInputRows` gives an output port.
 *
 * ── IT IS THE SAME CONTROL AS A DATA INPUT ROW, ON PURPOSE ──────────────────
 * `kind` is NODE_INPUT_ROW_KIND, because both rows edit THE SAME THING: a
 * `{item, port}` reference, picked from a list, cleared to null. `execOut: true` is
 * what tells web/Inspector.svelte to fill the list from `compatibleExecTargets`
 * instead of `compatibleSources`. A second row kind would have been a second control
 * with the same behaviour, which is the duplication ROW_KINDS exists to bound.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} [state] - the folded state (a port list may vary with it)
 * @returns {object[]} Inspector row descriptors, one per declared exec output
 *
 * @example execOutputRows({ports: () => ({outputs: [{key: "then", type: "exec", label: "Then"}]})})[0].key // "exec.then"
 * @example execOutputRows({ports: () => ({outputs: [{key: "then", type: "exec", label: "Then"}]})})[0].kind // "nodeinput"
 * @example execOutputRows({ports: () => ({outputs: [{key: "then", type: "exec", label: "Then"}]})})[0].execOut // true
 * @example // a DATA output is not one of these — it publishes a value, it does not fire
 * @example execOutputRows({ports: () => ({outputs: [{key: "out", type: "number"}]})}) // []
 * @example execOutputRows({}) // []
 */
export function execOutputRows(plugin, state) {
  return declaredPorts(plugin, state ?? plugin?.defaults ?? {}).outputs.filter((p) => p.type === EXEC_TYPE).map((p) => ({
    key: `${EXEC_KEY}.${p.key}`,
    label: p.label,
    kind: NODE_INPUT_ROW_KIND,
    execOut: true,
    portType: p.type,
    category: EXEC_CAT,
    help: `What runs when this fires. Pick any node on this slide that has an exec input, or clear it to stop the chain here. One exec output fires exactly one thing — use a Sequence node to fire several in order. It is ordinary keyframable state, so a deck can rewire what an event does from one slide to the next.`,
  }));
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
    const resolved = resolveNode(items, registry, id, (srcId) => values[srcId]?.outputs);
    if (resolved) values[id] = resolved;
  }
  return { values, cyclic };
}

/**
 * Pure function. ONE node's `{inputs, outputs}`, given a way to read its SOURCES'
 * outputs. Extracted so the two drivers below cannot disagree about what a wire
 * carries: `evaluateNodeGraph` walks the whole graph in topological order, and
 * `nodeOutputResolver` pulls one node on demand from inside the equation pass.
 * Coercion, the unconnected zero and the vanished-port rule are therefore stated
 * exactly once.
 *
 * Returns null for an item that is not a live node (absent, inactive, unregistered,
 * or declaring no ports) — the same items both drivers skip.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {string} id - the node to resolve
 * @param {function} outputsOf - (sourceItemId) => that node's outputs map, or undefined
 * @returns {{inputs: object, outputs: object}|null}
 *
 * @example // a doubler reading a source that already answered 3:
 * @example const reg = {get: () => ({ports: () => ({inputs: [{key: "in", type: "number"}], outputs: [{key: "out", type: "number"}]}), computeOutputs: (s, i) => ({out: i.in * 2})})};
 * @example resolveNode({b: {type: "mul", inputs: {in: {item: "a", port: "out"}}}}, reg, "b", () => ({out: 3})).outputs.out // 6
 * @example // an unconnected input reads its type's zero, never undefined:
 * @example resolveNode({b: {type: "mul"}}, reg, "b", () => undefined).inputs.in // 0
 * @example resolveNode({}, reg, "gone", () => undefined) // null
 */
export function resolveNode(items, registry, id, outputsOf) {
  const state = items?.[id];
  if (!state || state.active === false) return null;
  const plugin = pluginFor(items, registry, id);
  if (!plugin) return null;
  const ports = declaredPorts(plugin, state);
  if (ports.inputs.length === 0 && ports.outputs.length === 0) return null;
  // Resolve every declared input: a connected one takes its source's output
  // COERCED to this port's type; an unconnected one takes the type's zero.
  const inputs = {};
  for (const p of ports.inputs) {
    const c = state.inputs?.[p.key];
    const srcOut = c && typeof c === "object" ? outputsOf(c.item)?.[c.port] : undefined;
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
  return { inputs, outputs: plugin.computeOutputs?.(state, inputs) ?? {} };
}

/**
 * Near-pure function (returns a closure that memoizes into its own per-call table).
 * A LAZY, PULL-BASED node-graph evaluator: `resolver(itemId)` returns that node's
 * `{inputs, outputs}`, computing its sources first and remembering every answer.
 *
 * ── WHY A SECOND DRIVER EXISTS, AND WHY IT IS NOT A SECOND EVALUATOR ────────
 * `evaluateNodeGraph` runs at DERIVE time, over a state whose every equation has
 * already settled, so a topological sweep is exactly right there. The equation pass
 * cannot work that way: it settles slots LAZILY, on demand, and a node's own
 * properties may be equations that are not settled yet when something reads its
 * output. So the equation pass pulls, and hands in an `items` VIEW that settles a
 * key's equation on read (core/expressions.js). Both drivers call `resolveNode`, so
 * what a wire CARRIES is defined once.
 *
 * ── CYCLES ARE LOUD HERE, unlike at derive ─────────────────────────────────
 * `connectionRefusal` refuses a cycle at connect time, so one can only reach this
 * from a hand-edited document. `evaluateNodeGraph` tolerates that (it reports
 * `cyclic` and zeroes the back edge) because a frame must still be drawn. A PULL
 * cannot: there is no answer to give the equation that asked. So re-entry throws,
 * naming the chain, and the reading equation fails through the ordinary
 * equation-error path — the same treatment a cyclic equation gets.
 *
 * @param {object} items - folded items, or a view of them that settles on read
 * @param {object} registry - plugin registry
 * @returns {function} (itemId) => {inputs, outputs} | null
 *
 * @example const reg = {get: () => ({ports: () => ({outputs: [{key: "out", type: "number"}]}), computeOutputs: (s) => ({out: s.value})})};
 * @example nodeOutputResolver({a: {type: "src", value: 7}}, reg)("a").outputs.out // 7
 * @example nodeOutputResolver({}, reg)("nobody") // null
 */
export function nodeOutputResolver(items, registry) {
  const done = new Map(); // itemId → {inputs, outputs} | null
  const pulling = []; // the pull stack, in order, so the cycle sentence names the chain
  const resolve = (id) => {
    if (done.has(id)) return done.get(id);
    const at = pulling.indexOf(id);
    if (at >= 0) {
      const chain = [...pulling.slice(at), id];
      throw new Error(`Cyclic node outputs: ${chain.join(" → ")} — a node cannot read an output that depends on its own`);
    }
    pulling.push(id);
    try {
      const resolved = resolveNode(items, registry, id, (srcId) => resolve(srcId)?.outputs);
      done.set(id, resolved);
      return resolved;
    } finally {
      pulling.pop();
    }
  };
  return resolve;
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
 * The tightest the port column may be squeezed, as a fraction of PORT_PITCH.
 *
 * At this factor successive beads on one side are PORT_PITCH·PORT_MIN_PITCH_SCALE
 * apart. The floor is set by the beads themselves: they are drawn and grabbed at a
 * radius, so a pitch that closes below roughly a bead diameter stops being a
 * column of separable targets and becomes one smear that eats presses — the same
 * judgement KNOB_BAND_MIN_SCALE makes for dials, and `portAt`'s nearest-bead-wins
 * rule is what keeps the answer unambiguous while they are merely close.
 */
export const PORT_MIN_PITCH_SCALE = 1 / 2;

/** The bezier's horizontal control reach, in WORLD units. The minimum keeps a
 *  vertical wire an S-curve instead of a straight line through both cards; the
 *  maximum stops a long wire bowing into an arc that leaves the slide. */
export const WIRE_MIN_REACH = 40;
export const WIRE_MAX_REACH = 160;

/**
 * Pure function. The cubic BEZIER for a wire between two world points, as an SVG
 * path `d`. Control points are pushed HORIZONTALLY out of each end — out of the
 * source's right, into the destination's left — which is what gives a node editor
 * its characteristic left-to-right flow (the user's Reaktor reference) and what
 * makes two wires crossing readable rather than a tangle.
 *
 * The horizontal reach grows with the horizontal gap but is CLAMPED, so a wire
 * across the whole slide does not bow into a giant arc, and two nodes stacked
 * vertically (dx ≈ 0) still get a visible S rather than a straight line through
 * both cards. That minimum is the whole reason this is a function and not a lerp.
 *
 * IT LIVES IN THIS MODULE BECAUSE BOTH HALVES OF THE FEATURE READ IT and they
 * live on opposite sides of the DOM boundary: the editor's SVG ghost wire (which
 * passes SCREEN points, having converted them itself) and the SCENE emission
 * core/node_chrome.wireOps builds for every backend (which passes WORLD points).
 * The function is unit-agnostic — it is a curve between two points — so one
 * definition serves both, and the ghost cannot land on a different curve from the
 * committed wire that replaces it.
 *
 * @param {{x: number, y: number}} from - the source end
 * @param {{x: number, y: number}} to - the destination end
 * @returns {string} an SVG path `d`
 *
 * @example wireBezierPath({x: 0, y: 0}, {x: 200, y: 0}) // "M 0 0 C 100 0 100 0 200 0"
 * @example wireBezierPath({x: 0, y: 0}, {x: 0, y: 100}) // "M 0 0 C 40 0 -40 100 0 100"
 */
export function wireBezierPath(from, to) {
  const dx = to.x - from.x;
  const reach = Math.min(WIRE_MAX_REACH, Math.max(WIRE_MIN_REACH, Math.abs(dx) / 2));
  return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y} ${to.x - reach} ${to.y} ${to.x} ${to.y}`;
}

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
 * @example // a card with room places its rows a full PORT_PITCH apart
 * @example portLayout({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {w: 120, h: 120})[1].y // 56
 * @example // …and a SHORT one closes the gap so the bead stays inside the rim
 * @example // (h 80 leaves 80-34-34 = 12 for a 22-unit gap, so the pitch becomes 12)
 * @example portLayout({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {w: 120, h: 80})[1].y // 46
 * @example portLayout({}, {w: 10, h: 10}) // []
 */
export function portLayout(plugin, state) {
  const { inputs, outputs } = declaredPorts(plugin, state);
  const w = state?.w ?? 0;
  const pitch = portPitchFor(Math.max(inputs.length, outputs.length), unsignedH(state));
  const place = (list, x) => list.map((p, i) => ({ ...p, x, y: PORT_TOP_INSET + i * pitch }));
  return [...place(inputs, 0), ...place(outputs, w)];
}

/**
 * Pure function. A node's RESOLVED height, or undefined when it did not state one.
 *
 * A stored `h` MAY BE NEGATIVE — that is a flip, and the registry's contract is
 * that plugins never see the sign (the two entrances are geometry.normalizedBox
 * and unsignedState). Port layout is one of the pre-derivation readers, so it
 * resolves the sign itself; without this a vertically-flipped node would compute
 * a negative room and reflow to the floor for no reason the author could see.
 */
function unsignedH(state) {
  const h = state?.h;
  return Number.isFinite(h) ? Math.abs(h) : undefined;
}

/**
 * Pure function. THE PORT-ROW RESIZE SEAM — the vertical pitch a node's port
 * column is laid out at so its beads stay inside the RESOLVED BOX, and PORT_PITCH
 * when they already do.
 *
 * ── WHY THIS EXISTS (workstream CH, extending CD's seam) ────────────────────
 * CD taught the KNOB BAND to reflow against the resolved height, and recorded in
 * tests/node_resize_chrome_test.js that port rows still did not: "A node's PORT
 * ROWS are placed from its top edge by fixed constants in core/nodeflow.portLayout
 * — they are not part of this workstream's seam and they do not reflow — so a
 * Mixer shorter than ~235 has already spent its whole body on beads and has no
 * band to give." That is this function's brief. MEASURED before the change: the
 * Mixer's eight input rows end at y=188 at EVERY height, so at h=150 its lowest
 * three beads hang below the bottom rim — detached wire anchors, which is the
 * same escape the user photographed for the dials.
 *
 * ── CHEAPEST LOSS FIRST, the CD ordering ────────────────────────────────────
 * 1. FLOOR — a card with room lays out at the full PORT_PITCH and nothing moves.
 * 2. UNIFORM SCALE — a short card closes the pitch, keeping the column's rhythm.
 * 3. VISIBLE CLIP — past PORT_MIN_PITCH_SCALE the squeeze stops and the overflow
 *    SHOWS, per the registry docblock's rule, because a card too short for
 *    separable beads must look too short rather than quietly hide its ports.
 *
 * ── WHAT IS SCALED, AND WHAT DELIBERATELY IS NOT ───────────────────────────
 * ONLY THE PITCH. A knob band scales as a whole because a dial is a picture whose
 * INTERNAL proportions carry its reading. A bead is not: it is a fixed-radius
 * GRAB TARGET sitting astride the node's edge, and shrinking it would shrink the
 * hit region and thin the wire's landing point exactly when the card is smallest
 * and hardest to hit. So the beads keep their size and only the gaps between them
 * close — the column compresses, the targets do not.
 *
 * PORT_TOP_INSET is likewise NOT scaled: it clears the TITLE BAR, whose height is
 * a constant, so scaling it would slide the first bead up under the title rather
 * than buy any room. Only the space BELOW the first bead is negotiable, which is
 * why the room here is measured from PORT_TOP_INSET down.
 *
 * ── AN ABSENT HEIGHT IS "UNCONSTRAINED", NOT "ZERO ROOM" ───────────────────
 * The same ruling knobBandScale makes, for the same reason: several pure-geometry
 * callers ask for a column's SHAPE with no box in hand, and reading that silence
 * as a zero-height card would collapse every one of them to the floor.
 *
 * @param {number} rows - ports on the taller side
 * @param {number} [boxH] - the node's RESOLVED height; absent/non-finite = unconstrained
 * @returns {number} a pitch in [PORT_PITCH·PORT_MIN_PITCH_SCALE, PORT_PITCH]
 *
 * @example // a card with room to spare places its ports at the full pitch
 * @example portPitchFor(4, 300) // 22
 * @example // exactly enough room is still full pitch (4 rows need 34 + 3·22 + 34 = 134)
 * @example portPitchFor(4, 134) // 22
 * @example // a short card CLOSES the gaps instead of letting beads escape
 * @example portPitchFor(4, 101) // 11
 * @example // …and the squeeze stops at the floor, where the overflow becomes visible
 * @example portPitchFor(4, 40) // 11
 * @example // fewer than two rows has no gap to negotiate
 * @example portPitchFor(1, 10) // 22
 * @example // no height stated is no statement about the card
 * @example portPitchFor(8, undefined) // 22
 */
export function portPitchFor(rows, boxH) {
  const gaps = Math.max(0, (rows ?? 0) - 1);
  if (gaps === 0) return PORT_PITCH;
  if (!Number.isFinite(boxH)) return PORT_PITCH;
  // The bottom margin mirrors the top inset, exactly as minimumNodeHeight reserves
  // it — the column is centred between title bar and bottom rim, not flush to it.
  const room = boxH - PORT_TOP_INSET - PORT_TOP_INSET;
  const need = gaps * PORT_PITCH;
  if (room >= need) return PORT_PITCH;
  return Math.max(PORT_PITCH * PORT_MIN_PITCH_SCALE, room / gaps);
}

/**
 * Pure function. The NATURAL body height a node's port columns want — the taller
 * of the two columns at the FULL PORT_PITCH, plus a bottom margin equal to the top
 * inset. Node plugins use it as their default `h` so a freshly-inserted node is
 * never born with beads hanging off its bottom edge.
 *
 * SINCE CH THIS IS A PREFERENCE, NOT A LIMIT, and the distinction matters. It is
 * the height at which nothing has to give; a card shorter than this is no longer
 * broken, it reflows (portPitchFor closes the gaps). The true floor — below which
 * the pitch has bottomed out and the ports genuinely clip — is this same figure
 * with the gaps taken at PORT_MIN_PITCH_SCALE, which is what
 * `portsOnlyFloorHeight` reports. Reading THIS number as the clipping point is
 * how a resize test would come to assert a limit the layout no longer has.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} state - the folded state
 * @returns {number} natural local height
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
 * Pure function. THE PORTS-ONLY FLOOR — the height below which a node's port
 * column has spent every gap it has and its beads begin to clip.
 *
 * This is the number tests/node_resize_chrome_test.js used to carry as the literal
 * 235, with a note that port rows "do not reflow" and so a Mixer shorter than that
 * had "no band to give". Both halves of that changed at once: the column now
 * reflows, so the floor moved DOWN, and it is now derived from the layout's own
 * constants instead of being a measured constant that a later pitch change would
 * silently invalidate. DERIVING it is the point — a floor written as a literal is
 * a claim about geometry that stops being true the moment the geometry moves.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} state - the folded state
 * @returns {number} the local height at which the port column bottoms out
 *
 * @example // two rows: 34 + 1·11 + 34
 * @example portsOnlyFloorHeight({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {}) // 79
 * @example // one row has no gap, so its floor IS its natural height
 * @example portsOnlyFloorHeight({ports: () => ({outputs: [{key: "o", type: "number"}]})}, {}) // 68
 */
export function portsOnlyFloorHeight(plugin, state) {
  const { inputs, outputs } = declaredPorts(plugin, state ?? {});
  const gaps = Math.max(0, Math.max(inputs.length, outputs.length) - 1);
  return PORT_TOP_INSET + gaps * PORT_PITCH * PORT_MIN_PITCH_SCALE + PORT_TOP_INSET;
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
