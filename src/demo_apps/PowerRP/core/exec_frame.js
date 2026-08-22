/**
 * THE FRAME DOMAIN — per-frame triggers, and the SECOND evaluation domain beside
 * core/exec_flow.js's slide-boundary one.
 *
 * ── THE ASK (user, 2026-08-12, verbatim — this is the authority) ─────────────
 * *"I'd like to have some basic nodes. Like, ones with triggers - where a trigger is
 * a per-frame thing that happens, and has control flows - EXACTLY like unreal
 * blueprints control flows. ... so we can have something like a schmitt trigger
 * reading from a boolean node that on transition to high might trigger a thing."*
 *
 * ── IT IS A SECOND DOMAIN, NOT A LOOSENING OF THE FIRST ─────────────────────
 * `core/exec_flow.js`'s first restriction is *"EXEC SOURCES ARE FUNCTIONS OF
 * POSITION. An event may fire only at a SLIDE BOUNDARY … No wall clock, no pointer,
 * no frame counter, no state from frame N-1."* "A trigger is a per-frame thing that
 * happens" violates that BY DEFINITION, so the question is not "can exec_flow be
 * relaxed" — it is "what saves the core invariant on the FRAME axis". The answer was
 * already written a round later: R7-9's SIMULATED state.
 *
 * THE HONEST ONE-SENTENCE STATEMENT: **a per-frame trigger is SIMULATED STATE
 * WEARING AN EXEC PIN.** It is legal for the reason `= @ + dt` is legal, it costs
 * exactly what `= @ + dt` costs, and every one of those costs is already built:
 * `core/document.stridedShardRefusal`, `withSimulationFrozen()`, the `prev`/`cur`
 * two-table roll, and the camera's `maxTimestep` clamp.
 *
 * ── WHAT A FRAME NODE DECLARES ──────────────────────────────────────────────
 *     frameStep(ctx) -> {state?, fired?, outputs?}
 *
 * `ctx` is `{self, inputs, prev, dt, firstStep, id}`:
 *   self       the folded item state (its knobs)
 *   inputs     every declared input port, unconnected ones already zeroed
 *   prev       THIS NODE'S OWN state at the previous step, or `undefined` on the first
 *   dt         the seconds this step covers — the ONE clock, never a wall clock
 *   firstStep  true exactly while `prev` is absent (the `first_step` seam, per node)
 *
 * and the return is:
 *   state      what `prev` will be next step. Anything JSON-ish; compared by value
 *              is never needed, it is simply carried.
 *   fired      which EXEC OUT pins pulsed THIS frame — `true` for "the only one",
 *              or an array of port keys. This is what lights the wire (see
 *              `firedWireKeys`) and what the chain walk follows.
 *   outputs    this node's DATA outputs for the frame, merged over `computeOutputs`.
 *
 * DECLARING `frameStep` IS DECLARING "I AM SIMULATED", and that is deliberately the
 * ONLY way to say it. `frameNodeIsSimulated` reads the declaration, so
 * `core/document.documentIsSimulated` can answer without executing anything and
 * WITHOUT a hand-kept type list — the `isTriggerableMidiSource` precedent
 * (CLAUDE.md: *"WHICH WIDGETS ARE COVERED IS ASKED OF THE PORTS … never of a clip
 * declaration"*). A type list would have gone stale the day someone added the eighth
 * frame node, and the failure would be a silently strided render.
 *
 * ── Δt = 0 ⟹ BYTE-IDENTICAL, AND THIS IS WHERE THE WHOLE DESIGN LIVES ───────
 * `web/CanvasView.svelte` evaluates ONE frame several times — 2 on a pan, 3 on a
 * hover, measured. A latch advanced inside `computeOutputs` would therefore fire a
 * GESTURE-DEPENDENT number of times per frame: a schmitt trigger would double-fire
 * on a hover repaint, which is Unreal's macro-in-a-function bug arrived at from the
 * opposite direction (the research doc §3.5 works both through).
 *
 * SO NOTHING HERE OWNS A TABLE. Frame state rides `core/simulation_history.js` — the
 * same `prev`/`cur` roll `@` uses, under the slot key `frameSlotKey(id)` — which
 * means all three properties come for free rather than being re-derived:
 *   · the roll happens ONLY when the clock moves, so N evaluations at one instant
 *     read the identical `prev` and write the identical `cur`;
 *   · `withSimulationFrozen()` makes `recordSimulationValue` a no-op, so a
 *     thumbnail, the minimap or a PNG export is STRUCTURALLY unable to advance
 *     anyone's latch — not "unlikely to", unable;
 *   · a reset (document load, jump-to-start, presentation start, time moving
 *     backwards) drops every latch back to its `firstStep` initial condition, with
 *     no reset rule of its own to drift from `@`'s.
 * DO NOT GIVE THIS MODULE ITS OWN TABLE. A second one would need its own roll, its
 * own freeze and its own reset, and the three would be a mirror of the first three
 * that could only drift.
 *
 * ── THE CHAIN IS WALKED, AND IT HAS ITS OWN BUDGET ──────────────────────────
 * A frame node's `fired` pins are followed through the SAME exec edges the slide
 * domain uses (`execEdgesOf`), depth-first pre-order, honouring `FRAME_STEP_BUDGET`
 * (which is stated here rather than imported — see that constant for the cycle it
 * would otherwise close). The frame domain needs a budget MORE than the slide domain
 * does: a runaway walk at 60 fps is a hang, where the slide domain's runaway costs
 * one navigation.
 *
 * ── WHAT IS STILL REFUSED, STATED SO IT IS NOT DISCOVERED ───────────────────
 * `dt` COMES FROM THE ONE CLOCK. Never `performance.now()`, never `Date`. The jail
 * makes the direct spelling impossible inside an EQUATION; a PLUGIN reading a clock
 * in JS is not policed by anything, which is why it is written here as a law.
 * A CHAIN ROOTED AT A LIVE CONTROL (a Button) still renders inert in an export —
 * `core/live_control.js` and `plugins/node_button.js` already rule on that, and the
 * frame domain changes nothing about it.
 *
 * DOM-free and engine-free: core/ runs in bare node.
 */

import { EXEC_TYPE, declaredPorts, execEdgesOf, isNodeWidget, resolveNode, topoOrder } from "./nodeflow.js";
import { hasSimulationValue, recordSimulationValue, simulationValue } from "./simulation_history.js";
import { reportOnce } from "./report.js";

/**
 * How many PULSES one frame's chains may deliver before the walk gives up.
 *
 * ── IT COUNTS FOLLOWS, NOT VISITS, AND THE DIFFERENCE WAS A MEASURED WRONG
 *    REPORT ────────────────────────────────────────────────────────────────
 * It used to be charged at the top of `step`, which the two phase sweeps call once
 * per id in `topoOrder(items).order` — and that is EVERY item in the folded state,
 * rects included, not just the nodes. So the ceiling was spent by the DECK'S SIZE
 * rather than by chain work: 600 rects beside a two-node chain reported *"look for a
 * cycle in its exec wires"* on a document with no cycle, and past 2× the budget the
 * sweeps consumed it before either frame node was reached, so the chain silently
 * never stepped at all. It is now charged only where a pulse is actually FOLLOWED
 * down an exec wire, which is the only place a document's own shape can run away.
 *
 * ── WHY IT IS STATED HERE RATHER THAN IMPORTED FROM core/exec_flow.js ───────
 * It is the same number and the same discipline as `EXEC_STEP_BUDGET` there, and
 * importing it would have been the obvious move — but `core/document.js` must ask
 * this module `frameNodeIsSimulated` (the strided-shard landmine), and exec_flow
 * imports document, so that import would close a `document → exec_frame → exec_flow
 * → document` CYCLE around a predicate whose whole job is to be answerable early and
 * cheaply. `core/nodeflow.js` — the one module both domains already lean on — has NO
 * core-relative imports at all, deliberately, and putting a control-flow budget in
 * the port-and-wire module would be the wrong home for it.
 *
 * The two are independent budgets for two independent walks, which is also the
 * honest reading: the frame domain needs one MORE than the slide domain does (a
 * runaway at 60 fps is a hang; a runaway at a slide boundary costs one navigation),
 * so a future tuning of one should not silently retune the other.
 */
export const FRAME_STEP_BUDGET = 1000;

/**
 * Pure function. THE SLOT KEY one frame node's state lives under in the simulation
 * history — deliberately in the SAME namespace `@` uses (`items.<id>.<path>`), with
 * a path no property can take.
 *
 * `__frame` cannot collide with a real property: a leading double underscore is not
 * a legal display slug and no plugin declares one, so an author cannot write an
 * equation that reads or writes this slot. That is the point — the state is the
 * NODE's, not the document's, and it is not saved.
 *
 * @param {string} id - the item id
 * @returns {string} the history slot key
 *
 * @example frameSlotKey("a1") // "items.a1.__frame"
 */
export function frameSlotKey(id) {
  return `items.${id}.__frame`;
}

/**
 * Pure function. THE SLOT KEY one frame node's PUBLISHED OUTPUTS live under — the
 * companion of `frameSlotKey`, in the same namespace and with the same
 * cannot-be-spelled guarantee (a leading double underscore is not a legal slug).
 *
 * ── WHY THE OUTPUTS ARE CARRIED AND NOT ONLY THE STATE ─────────────────────
 * A chain-driven node (Set Var, Increment) is resolved only when the chain REACHES
 * it, so on a frame its trigger did not fire it is still unresolved while phase 1's
 * data-ordered sources run — and a reader downstream of it by a DATA wire then read
 * nothing and fell through to `portZero`. A latch that was not pulsed HOLDS, and
 * holding is a value its readers must see; this slot is where the held answer waits.
 * See `stepFrameDomain`'s seeding loop for the measured failure.
 *
 * IT IS A SECOND SLOT RATHER THAN A WIDER PAYLOAD IN THE FIRST because `prev` is a
 * contract with the PLUGIN (`frameStep`'s `ctx.prev` is exactly what it returned as
 * `state`), and packing a host-owned field beside it would make every plugin's own
 * record something it has to step around.
 *
 * @param {string} id - the item id
 * @returns {string} the history slot key
 *
 * @example frameOutputsSlotKey("a1") // "items.a1.__frameOut"
 */
export function frameOutputsSlotKey(id) {
  return `items.${id}.__frameOut`;
}

/**
 * Pure function. A frame node's carried state, SERIALIZED — what actually goes into
 * the history table.
 *
 * ── IT IS A STRING BECAUSE THE TABLE'S SAFETY NET COMPARES WITH `!==` ───────
 * `core/simulation_history.recordSimulationValue` reports when two passes at one tick
 * write DIFFERENT values to one slot, which is how the two-timelines corruption is
 * caught. Its contract says *"Same value from both is the ordinary case (the same
 * slot evaluated twice) and says nothing"* — and that is true of the SCALARS `@`
 * records, where `!==` is value equality.
 *
 * A frame node's state is a small RECORD, and a fresh object every step, so identity
 * comparison would answer "different" on every ordinary second evaluation of one
 * frame. MEASURED: three evaluations of one frame (a hover repaint) produced three
 * false alarms naming `{"armed":true}` and `{"armed":true}` as a disagreement.
 *
 * The wrong fix is to weaken the check to a deep compare — it is the detector for the
 * one corruption this table exists to prevent, and every scalar consumer relies on it
 * being cheap. The right fix is for THIS module to record something the check can
 * compare, which is what it does: one JSON string per node per frame. Two evaluations
 * of one frame produce the same string, so the net stays armed for the case it is
 * actually for (two consumers at different slides, whose states genuinely differ).
 *
 * IT ALSO CARRIES THE PUBLISHED OUTPUTS (`frameOutputsSlotKey`), for the identical
 * reason — an output map is a fresh object every step too — which is why this pair is
 * named for the round trip it performs rather than for one of its two payloads.
 *
 * @param {*} state - whatever the node's frameStep returned as `state`
 * @returns {string} a stable serialization
 *
 * @example frameStateBytes({armed: true}) // '{"armed":true}'
 * @example frameStateBytes(undefined) // "null" (a node that carries nothing still records)
 */
export function frameStateBytes(state) {
  return JSON.stringify(state ?? null);
}

/**
 * Pure function. The inverse of `frameStateBytes` — what a node's `prev` is handed.
 *
 * @param {string|undefined} bytes - what the history table holds
 * @returns {*} the carried state, or undefined when there is none
 *
 * @example frameStateFrom('{"armed":true}') // {armed: true}
 * @example frameStateFrom("null") // undefined
 * @example frameStateFrom(undefined) // undefined
 */
export function frameStateFrom(bytes) {
  if (typeof bytes !== "string") return undefined;
  return JSON.parse(bytes) ?? undefined;
}

/**
 * Pure function. Does this plugin participate in the FRAME DOMAIN — i.e. does it
 * carry per-frame state between steps?
 *
 * ASKED OF THE DECLARATION, NEVER OF A TYPE LIST. This is the predicate
 * `core/document.documentIsSimulated` consults, and it is the whole reason a
 * stateful node cannot silently be strided-sharded: a Schmitt latch has no `@`
 * anywhere in the document, so the equation-source scan answers `false` and would
 * hand a render job a green light to start cold in the middle of a trajectory.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example frameNodeIsSimulated({type: "rect"}) // false
 * @example frameNodeIsSimulated({type: "node_schmitt", frameStep: () => ({})}) // true
 * @example frameNodeIsSimulated(null) // false
 */
export function frameNodeIsSimulated(plugin) {
  return typeof plugin?.frameStep === "function";
}

/**
 * Query. Does any item in this FOLDED state belong to the frame domain? The cheap
 * structural question every driver asks first, so a deck without one pays nothing.
 *
 * @param {object} items - folded items ({id: state})
 * @param {object} registry - plugin registry
 * @returns {boolean}
 *
 * @example // stateUsesFrameDomain({a: {type: "rect"}}, registry) // false
 * @example // stateUsesFrameDomain({s: {type: "node_schmitt"}}, registry) // true
 */
export function stateUsesFrameDomain(items, registry) {
  for (const state of Object.values(items ?? {})) {
    if (typeof state?.type !== "string" || state.active === false) continue;
    if (frameNodeIsSimulated(pluginOf(registry, state.type))) return true;
  }
  return false;
}

/**
 * Query. Does this item declare an exec INPUT — i.e. is it something the chain
 * FIRES rather than something that fires?
 *
 * The question that separates `stepFrameDomain`'s two phases, and it is asked of the
 * PORT DECLARATION for the reason `core/exec_flow.nodeExecKind` gives about the same
 * question on the slide axis: *"the roster cannot drift from a hand-kept list"*. A
 * widget that grows an exec input becomes chain-driven the day it declares one, with
 * nothing else to remember.
 *
 * @param {object} items - folded items
 * @param {object} registry - plugin registry
 * @param {string} id - the item to ask about
 * @returns {boolean}
 */
function hasExecInput(items, registry, id) {
  const state = items?.[id];
  const plugin = pluginOf(registry, state?.type);
  if (!plugin) return false;
  return declaredPorts(plugin, state).inputs.some((p) => p.type === EXEC_TYPE);
}

/** Query-shaped helper. The plugin for a type, or null — never a throw, for the
 *  reason core/exec_flow.registryPlugin gives: this walk runs over items the render
 *  tree deliberately skips, and an unregistered item is simply not in the program. */
function pluginOf(registry, type) {
  if (typeof type !== "string") return null;
  try {
    return registry?.get?.(type) ?? null;
  } catch {
    // A type the registry does not know. The RENDER walk raises it and names the
    // item, which is where that complaint belongs; raising it twice helps nobody.
    return null;
  }
}

// ── THE SCHMITT TRIGGER ──────────────────────────────────────────────────────

/**
 * The default thresholds, Eurorack's ~0.1 V / ~1–2 V convention against a 0–10 V
 * range, normalized.
 *
 * ── WHY THESE TWO CONSTANTS EXIST TWICE IN THIS REPO, AND WHY THAT IS LAWFUL ──
 * `synth/dsp.js` has `SCHMITT_LOW`, `SCHMITT_HIGH` and `schmittStep` with these
 * exact semantics. This is a DELIBERATE second statement of them, not an oversight,
 * and the alternative was measured against the codebase's own rules:
 *
 *   `core/` MUST NOT IMPORT `synth/**`. That is standing (core/live_control.js:234-236
 *   keeps `PITCH_PARAM_KEYS` "in sync with synth/engine.js's" by hand for exactly this
 *   reason: "core cannot import synth/**, so the pair is a restatement rather than a
 *   shared constant"). `synth/` is a SEPARATE LIBRARY with zero PowerRP imports, so
 *   the edge is refused in both directions — synth may not import core either, which
 *   is why "move it down to core and re-export from synth" is not available: it would
 *   make the standalone synth library depend on PowerRP.
 *
 * So the duplication is across a LIBRARY BOUNDARY that both sides deliberately keep
 * closed, which is a different thing from two copies inside one codebase. What keeps
 * it honest is that the function is four lines of pure comparison with no tuning and
 * no hidden policy: if `synth/dsp.js` ever changes its semantics, that is a change to
 * a DSP module's behaviour, and this one — a document-domain node with author-set
 * thresholds — should not follow it silently anyway. The doctests below cross-
 * reference the original so a reader lands on both.
 */
export const SCHMITT_LOW = 0.1;
export const SCHMITT_HIGH = 0.5;

/**
 * Pure function. ONE STEP of a Schmitt trigger: a comparator with TWO thresholds and
 * a LATCH. Mirrors `synth/dsp.js schmittStep` (see SCHMITT_LOW for why the function
 * is stated twice rather than imported).
 *
 * THE LATCH IS THE WHOLE POINT. A naive "trigger on rising edge" built by comparing
 * against ONE threshold machine-guns on any signal that wobbles across the line;
 * two separate thresholds mean the output goes high when the input rises past `high`
 * and only re-arms when it falls back past `low`. The caller OWNS the storage — the
 * latch goes in and comes back out — which is what lets this stay pure while the
 * history table carries it between frames.
 *
 * @param {number} value - the input this step
 * @param {boolean} armed - the latch: is the trigger currently HIGH (fired and not
 *   yet re-armed)?
 * @param {number} [low] - the falling threshold
 * @param {number} [high] - the rising threshold
 * @returns {{fired: boolean, armed: boolean, released: boolean}} `fired` on the
 *   low→high transition, `released` on the high→low one, and the new latch
 *
 * @example // rising past the high threshold fires ONCE and latches
 * @example schmittStep(0.9, false) // {fired: true, armed: true, released: false}
 * @example // staying high does NOT fire again — the machine-gun this exists to stop
 * @example schmittStep(0.9, true) // {fired: false, armed: true, released: false}
 * @example // wobbling back into the BAND does not re-arm it either
 * @example schmittStep(0.3, true) // {fired: false, armed: true, released: false}
 * @example // only falling past the LOW threshold re-arms, and that is the falling edge
 * @example schmittStep(0.05, true) // {fired: false, armed: false, released: true}
 * @example // custom thresholds: a 0..1 boolean signal with the band at 0.5
 * @example schmittStep(1, false, 0.5, 0.5) // {fired: true, armed: true, released: false}
 */
export function schmittStep(value, armed, low = SCHMITT_LOW, high = SCHMITT_HIGH) {
  if (!armed && value >= high) return { fired: true, armed: true, released: false };
  if (armed && value <= low) return { fired: false, armed: false, released: true };
  return { fired: false, armed, released: false };
}

/**
 * Pure function. WHY these two thresholds are unusable, or null when they are fine.
 * The problem-string-or-null shape `core/nodeflow.nodeRefProblem` and
 * `core/commands.commandUnavailableReason` already use.
 *
 * `low > high` is refused rather than silently swapped: a swapped band is a control
 * that quietly means the opposite of what it says. `low === high` is ALLOWED and is
 * a real configuration — it is the degenerate zero-hysteresis comparator, which is
 * exactly what a 0/1 boolean signal wants (there is no noise to debounce between two
 * exact integers), and refusing it would make the user's own demo unspellable.
 *
 * @param {number} low - the falling threshold
 * @param {number} high - the rising threshold
 * @returns {string|null}
 *
 * @example schmittBandProblem(0.1, 0.5) // null
 * @example schmittBandProblem(0.5, 0.5) // null (a zero-width band is a plain comparator)
 * @example schmittBandProblem(0.9, 0.2).includes("below") // true
 * @example schmittBandProblem(NaN, 0.5).includes("numbers") // true
 */
export function schmittBandProblem(low, high) {
  if (!Number.isFinite(low) || !Number.isFinite(high))
    return "a Schmitt trigger's Low and High thresholds must both be numbers";
  if (low > high)
    return `a Schmitt trigger's Low threshold (${low}) must be at or below its High threshold (${high}) — the band is the range the input may wobble in without re-firing, so an inverted one would fire on every sample`;
  return null;
}

// ── THE STEP DRIVER ──────────────────────────────────────────────────────────

/**
 * Pure function. Which exec OUT keys a `frameStep` result says pulsed — normalizing
 * the three spellings `fired` accepts into one list.
 *
 * `true` means "the node's declared exec outputs, all of them", which is the same
 * default `core/exec_flow.execNextPorts` gives a node with no `execNext`: declaring
 * N exec outputs IS the sequence. A node that BRANCHES returns the keys it chose.
 *
 * @param {*} fired - a frameStep result's `fired`
 * @param {object[]} execOuts - the node's declared exec output ports
 * @returns {string[]} exec output keys, in firing order
 *
 * @example firedPortKeys(false, [{key: "then"}]) // []
 * @example firedPortKeys(true, [{key: "then"}, {key: "else"}]) // ["then", "else"]
 * @example firedPortKeys(["else"], [{key: "then"}, {key: "else"}]) // ["else"]
 * @example firedPortKeys(undefined, [{key: "then"}]) // []
 */
export function firedPortKeys(fired, execOuts) {
  if (fired === true) return execOuts.map((p) => p.key);
  if (Array.isArray(fired)) return fired.filter((k) => execOuts.some((p) => p.key === k));
  return [];
}

/**
 * Command (ADVANCES the simulation history — see the scoping invariant below).
 * Runs ONE FRAME of the frame domain over a folded item map: every frame node steps
 * once, in topological order, and each one's fired exec pins are followed through
 * the exec graph.
 *
 * ── EXACTLY ONE STEP PER RENDERED FRAME, AND THE TABLE ENFORCES IT ──────────
 * This does NOT decide when a step happens; `core/simulation_history.js` already
 * did. It reads `prev` (which only rolls when the clock moves) and writes `cur`
 * (which a frozen pass discards), so calling it twice at one clock instant produces
 * the identical answer and leaves the identical table — the Δt = 0 law, structural
 * rather than remembered. `web/CanvasView.svelte` evaluating one frame three times
 * on a hover is therefore not something a caller has to think about.
 *
 * ── WHY IT RETURNS A REPORT RATHER THAN MUTATING THE DOCUMENT ───────────────
 * The frame domain writes NOTHING to the document. Its state is the history table
 * (not saved, reset with the simulation) and its published values are ordinary node
 * OUTPUTS, which flow through the existing wire evaluator. A per-frame document
 * write would make an authored deck's saved bytes depend on how long it was played,
 * which is the reading `refs/blueprints_control_flow_research.md` §6.2 rejected and
 * the reason the counter owns its own accumulator.
 *
 * ── EACH NODE STEPS EXACTLY ONCE, AT THE MOMENT IT IS REACHED ───────────────
 * This is the one piece of ordering that had to be got right, and TWO obvious
 * shapes are both wrong. It is worth writing down which, because each produces a
 * plausible picture and a silently wrong count.
 *
 *   "STEP EVERYBODY, THEN WALK THE CHAIN" — a node downstream of a trigger has then
 *   already stepped before it could know it was pulsed, so a counter advances a
 *   FRAME LATE. Nothing looks broken; the number is just always one behind.
 *   "WALK IN TOPOLOGICAL ORDER AND LET THE CHAIN STEP WHOEVER IT REACHES" —
 *   MEASURED, and it is why this paragraph exists. `topoOrder` sorts by the DATA
 *   graph, which knows nothing about exec edges: on the user's own demo it returns
 *   the counter BEFORE the Schmitt trigger that fires it (they share no data wire,
 *   so the order is alphabetical). The counter therefore steps first, is marked
 *   done, and the pulse that arrives moments later finds it already stepped. The
 *   counter NEVER ADVANCES — a dead demo, from an ordering nobody would think to
 *   suspect.
 *
 * So the two kinds of node are separated by a question the port declaration already
 * answers — DOES IT HAVE AN EXEC INPUT? — and stepped in two phases:
 *
 *   1. SOURCES (no exec input) step in TOPOLOGICAL order of the data graph, so what
 *      a wire carries into one is settled before it reads it (time → mod → compare →
 *      schmitt resolves in a single pass) — EXCEPT where the wire comes from a
 *      chain-driven node, which by construction has not stepped yet. That one reads
 *      its LAST PUBLISHED value (`frameOutputsSlotKey`), which is what a latch is
 *      holding and is the number the canvas draws on the same wire. It used to read
 *      the port's ZERO, so one Set Var fed a display 5 and a Schmitt trigger 0 in the
 *      same frame. Each one's fired pins are followed
 *      IMMEDIATELY, depth-first, in declaration order — the SAME order the slide
 *      domain walks (core/exec_flow.js's ORDER section), so a chain does not mean
 *      two things depending on which domain fired it. A node reached this way steps
 *      THERE, with `entered` naming the pin that reached it.
 *   2. WHATEVER THE CHAIN NEVER REACHED steps last, in topological order, with
 *      `entered` undefined — because "I was not pulsed this frame" is a thing a latch
 *      has to OBSERVE (a Schmitt trigger holding its arm, a counter holding its
 *      tally), and a node that simply did not run would freeze instead of holding.
 *
 * A node is stepped ONCE per frame no matter how many pulses converge on it: two
 * triggers into one counter is one advance. A frame covers `dt` seconds rather than
 * being instantaneous, so the alternative would make a tally depend on how many
 * upstream branches happened to converge — a graph-shape fact, not a timing one.
 * (The slide domain answers differently, through `ctx.runIndex`, because a BOUNDARY
 * is instantaneous and two events there genuinely both happened.)
 *
 * @param {object} items - folded items ({id: state})
 * @param {object} registry - plugin registry
 * @param {number} dt - the seconds this step covers (core/simulation_history.js)
 * @returns {{outputs: object, fired: object, pulses: number}} `outputs[id]` is the
 *   node's frame-domain data outputs, `fired[id]` is the array of its exec out keys
 *   that pulsed, and `pulses` counts every pin fired this frame (0 for a deck with
 *   no frame nodes, which is how a caller cheaply knows nothing happened).
 */
export function stepFrameDomain(items, registry, dt) {
  const outputs = {};
  const fired = {};
  let pulses = 0;
  if (!stateUsesFrameDomain(items, registry)) return { outputs, fired, pulses };

  // THE DATA GRAPH RESOLVES AS IT GOES, through the SAME `resolveNode` derive uses —
  // so what a wire carries INTO a frame node is by construction the number the canvas
  // draws on that wire, and a node stepped by the chain walk sees its upstream
  // neighbours' THIS-FRAME outputs rather than last frame's.
  const resolved = {};
  const outputsOf = (id) => resolved[id]?.outputs;
  const edges = new Map(); // "item.port" → {item, port}
  for (const e of execEdgesOf(items)) edges.set(`${e.from.item}.${e.from.port}`, e.to);
  const stepped = new Set();
  const steps = { n: 0, blown: false };

  /** Command. Steps ONE node (if it has not stepped this frame) and follows whatever
   *  it fired. `entered` is the exec INPUT key that reached it, or undefined. */
  const step = (id, entered) => {
    if (stepped.has(id)) return;
    const state = items[id];
    if (!state || state.active === false) return;
    const plugin = pluginOf(registry, state.type);
    if (!plugin) return;
    const node = resolveNode(items, registry, id, outputsOf);
    if (!node) return;
    stepped.add(id);
    resolved[id] = node;
    if (!frameNodeIsSimulated(plugin)) return; // a pure node: its outputs are all it has

    const key = frameSlotKey(id);
    const firstStep = !hasSimulationValue(key);
    const prev = firstStep ? undefined : frameStateFrom(simulationValue(key));
    let result;
    try {
      result = plugin.frameStep({ id, self: state, inputs: node.inputs, prev, dt, firstStep, entered }) ?? {};
    } catch (e) {
      // REPORTED, NOT THROWN, for the reason core/expressions.js gives about the
      // project script's compile error: the pass must still produce a frame, and one
      // broken node must not blank a slide. The node then contributes nothing, which
      // is the loud-and-visible failure (its readout stops moving) rather than a
      // plausible wrong number.
      reportOnce(`exec_frame:step:${state.type}`, `exec_frame: "${state.type}" threw in frameStep — ${e.message}. The node produced nothing this frame.`);
      return;
    }
    // RECORDED EVEN WHEN THE NODE RETURNED NO `state`: `undefined` is a legal carried
    // value, and recording it is what makes `firstStep` answer false next step. A
    // node that skipped the write would read `firstStep` true forever and pin itself
    // at its initial condition — the exact self-cancelling bug core/expressions.js's
    // `readFirstStep` docblock records for the ternary short-circuit.
    recordSimulationValue(key, frameStateBytes(result.state));
    // THE FRAME OUTPUTS ARE MERGED OVER `computeOutputs`, not instead of it: a node
    // may publish some ports statically and some per-step, and a reader downstream
    // should not have to know which is which.
    if (result.outputs && typeof result.outputs === "object") {
      outputs[id] = result.outputs;
      resolved[id] = { inputs: node.inputs, outputs: { ...node.outputs, ...result.outputs } };
    }
    // AND WHAT IT PUBLISHED IS CARRIED TO THE NEXT FRAME, so a reader that runs
    // BEFORE this node steps sees the value it is holding rather than a zero — see
    // the seeding loop below for the failure that costs.
    recordSimulationValue(frameOutputsSlotKey(id), frameStateBytes(resolved[id].outputs));
    const execOuts = declaredPorts(plugin, state).outputs.filter((p) => p.type === EXEC_TYPE);
    const keys = firedPortKeys(result.fired, execOuts);
    if (keys.length === 0) return;
    fired[id] = keys;
    pulses += keys.length;
    for (const port of keys) {
      const target = edges.get(`${id}.${port}`);
      if (!target) continue;
      // THE ONE PLACE THE BUDGET IS CHARGED — see FRAME_STEP_BUDGET for why it is
      // here and not at the top of `step`. Following a pulse is the only work whose
      // amount the document's WIRING decides; the phase sweeps below step each node
      // at most once by construction (they call `step` twice on a source, and the
      // second call returns at the `stepped` gate), so charging them made the ceiling
      // a function of how many rects were on the slide.
      if (steps.n++ >= FRAME_STEP_BUDGET) { steps.blown = true; return; }
      step(target.item, target.port);
    }
  };

  // ONLY NODE WIDGETS ARE IN THE PROGRAM. `topoOrder` sorts EVERY item in the folded
  // state — its own docblock: *"Nodes not participating in any connection come first"*
  // — so an unfiltered sweep hands `step` two calls per rect, each of which resolves
  // to nothing twice over (a portless item never reaches `stepped`, so phase 2 redoes
  // phase 1's work on it). The filter is what keeps both phases proportional to the
  // PATCH rather than to the slide.
  const order = topoOrder(items).order.filter((id) => isNodeWidget(pluginOf(registry, items[id]?.type), items[id]));
  // ── WHAT A NOT-YET-STEPPED NODE CARRIES INTO A READER: ITS HELD VALUE ──────
  // Phase 1 walks the DATA topological order but SKIPS anything with an exec input,
  // so a latch is still unresolved when a SOURCE downstream of it by a data wire
  // reads it — and `resolved` is a fresh per-frame map, so that read fell through to
  // `portZero`. MEASURED: one Set Var holding 5 fed a display (which showed 5) and a
  // Schmitt trigger (which read 0) IN THE SAME FRAME, so the trigger released and
  // fired on a wire whose value had not moved. The same wire carried two numbers.
  // Seeding each frame node with what it last PUBLISHED makes the held value the
  // answer, and a node the chain does reach overwrites the seed when it steps — so a
  // pulsed value still propagates within the frame it happened.
  // A DELETED NODE HOLDS NOTHING — the seed obeys `resolveNode`'s own rule about
  // which items are live ("absent, inactive, unregistered, or declaring no ports").
  // The history table outlives `active: false`, so without this clause a node the
  // author DELETED went on feeding its last value to a frame-domain reader while the
  // node graph — which skips an inactive item outright, so its wire reads the port's
  // zero — fed the canvas 0. MEASURED: a Set Var holding 5, deleted on frame 3, kept a
  // watching Schmitt HIGH forever. That is the same wire carrying two numbers this
  // seeding exists to end, so it must not be re-introduced from the other side.
  for (const id of order) {
    const state = items[id];
    if (!state || state.active === false) continue;
    if (!frameNodeIsSimulated(pluginOf(registry, state.type))) continue;
    const held = frameOutputsSlotKey(id);
    if (hasSimulationValue(held)) resolved[id] = { inputs: {}, outputs: frameStateFrom(simulationValue(held)) ?? {} };
  }
  // PHASE 1 — THE SOURCES, in topological order of the data graph. A node with an
  // exec INPUT is deliberately skipped here: it is something the chain fires, and
  // stepping it now would consume its one step per frame before the pulse arrives
  // (see the docblock's second measured wrong shape). Each source's fired pins are
  // followed depth-first inside `step`.
  for (const id of order) if (!hasExecInput(items, registry, id)) step(id, undefined);
  // PHASE 2 — WHOEVER THE CHAIN NEVER REACHED, so a latch that was not pulsed this
  // frame still observes the frame and holds, rather than freezing at whatever it
  // last saw.
  for (const id of order) step(id, undefined);

  if (steps.blown)
    // A CHAIN CANNOT LOOP — `stepped` admits each node once per frame, so a cycle
    // costs one pass round it and stops — which is why this sentence no longer sends
    // the reader hunting for one. What it takes to get here is a patch delivering
    // more than the budget's worth of pulses in a SINGLE frame.
    reportOnce("exec_frame:budget", `exec_frame: one frame's exec chains delivered more than ${FRAME_STEP_BUDGET} pulses and the walk was stopped, so some nodes did not step. This is a size limit, not a cycle (a node steps at most once per frame): the patch has more exec wires firing at once than one frame may follow.`);

  return { outputs, fired, pulses };
}

/**
 * Pure function. THE WIRE FLASH SET — which exec wires carried a pulse this frame,
 * as `"<fromItem>.<fromPort>"` keys.
 *
 * > *"On frames where triggers fire, the wires connecting them should change color
 * > to show that something happened."* (user, 2026-08-12)
 *
 * DERIVED, NEVER STORED. `plugins/node_display.js` states the rule for the analogous
 * case ("The displayed number is NEVER written back into the document"), and
 * `plugins/node_button.js` states the sharper version: *"There is no leaf whose
 * value means 'pressed just now' — a moment is not a value"*. A `fired: true` leaf
 * would be ephemeral state written to disk.
 *
 * AND IT SURVIVES AN EXPORT, which is the interesting half: whether a trigger fired
 * on frame N is a function of the same inputs frame N itself is a function of, so a
 * simulated node's fire state is SIMULATED — not ephemeral — and a rendered video
 * shows the same flashes the presenter saw.
 *
 * @param {object} fired - a stepFrameDomain result's `fired` map
 * @returns {Set<string>} "<item>.<port>" for every pin that pulsed
 *
 * @example firedWireKeys({}) // Set {}
 * @example [...firedWireKeys({s1: ["then"]})] // ["s1.then"]
 * @example [...firedWireKeys({s1: ["then", "else"]})] // ["s1.then", "s1.else"]
 */
export function firedWireKeys(fired) {
  const keys = new Set();
  for (const [id, ports] of Object.entries(fired ?? {}))
    for (const port of ports) keys.add(`${id}.${port}`);
  return keys;
}
