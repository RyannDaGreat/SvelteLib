/**
 * EXEC FLOW — what an exec wire MEANS. The execution model behind R7-8's triggers.
 *
 * User, verbatim: *"another property we're going to have to have is a trigger
 * property, just like blueprints. It will make life simpler if we can have triggers.
 * Research how blueprints work. An output property, followed by a trigger property,
 * should trigger events."* and *"Trigger upon events from widgets - like on reveal,
 * on hide, etc."*
 *
 * core/nodeflow.js owns the WIRE (its shape, its legality, its editing). This module
 * owns the PROGRAM: which events fire, in what order, and what their effects do to
 * the document. Nothing here knows about pixels, the DOM or audio.
 *
 * ── THE FOUR NODE KINDS ARE DERIVED, NEVER DECLARED ─────────────────────────
 *
 *     event   no exec IN, ≥1 exec OUT   an entry point; the schedule fires it
 *     impure  ≥1 exec IN                runs once per pulse; may write
 *     pure    no exec pins at all       every other widget in the app
 *     latent  an impure that declares `execLatent`: it SCHEDULES a continuation
 *             for a later boundary and returns immediately
 *
 * `nodeExecKind` reads the port declaration, so the roster cannot drift from a
 * hand-kept list — the failure the manifest calls "no Tower of Babel". A pure node
 * IS NOT A NODE IN THE EMITTED PROGRAM AT ALL: it is our ordinary property equation,
 * re-evaluated per read, which is Blueprint's own semantics arrived at from the
 * other direction.
 *
 * ── THE ONE RULE THAT SAVES THE CORE INVARIANT ──────────────────────────────
 * `RenderTree = pure(document, [[slide, alpha]])` is the law this app is built on,
 * and an execution model is exactly the kind of feature that breaks it. Two
 * restrictions buy it back, and neither is optional:
 *
 *   1. EXEC SOURCES ARE FUNCTIONS OF POSITION. An event may fire only at a SLIDE
 *      BOUNDARY, and only because of what the document says at boundaries j−1 and j.
 *      No wall clock, no pointer, no frame counter, no state from frame N−1.
 *   2. THE ONLY EFFECT IS `set <path> to <value>`. There is no `add`, no `toggle`,
 *      no read-modify-write — not "discouraged", ABSENT. `execEffect` is handed the
 *      state and returns `[[path, value]]` pairs; it is never handed a writer, so an
 *      accumulating effect is INEXPRESSIBLE rather than refused. (That shape is
 *      deliberate: the round's own lesson from the audio mute placed downstream of
 *      the capture tap — a stated rule that becomes an impossible mistake.)
 *
 * Together these make the whole pass a pure function of `(document, slideIndex)`.
 * Not of alpha: SEE THE NEXT SECTION, because that is the property that makes it
 * affordable.
 *
 * ── THE FIRING SCHEDULE IS THE SLIDE GRID, AND THAT IS WHY REPLAY IS CHEAP ──
 * The manifest's rule says replaying from slide 0 must be cheap. It is cheap for one
 * structural reason: THE SET OF FIRING POSITIONS IS FINITE AND ENUMERABLE FROM THE
 * DOCUMENT ALONE. Slide boundaries are that set. A mid-tween firing position would
 * not be — alpha is a continuum, so "the value crossed 0.5 somewhere in the
 * transition" cannot be enumerated, only sampled, and a sampled schedule depends on
 * the frame rate, which is the exact defect `Event Tick` has and which we refuse.
 *
 * So `execOverlayAt(doc, k)` walks j = 0…k, and the answer does NOT depend on alpha.
 * One overlay per slide, memoized per document, reused by every frame of that
 * slide's tween. A 30-slide deck costs 31 evaluations ONCE, not per frame — and a
 * deck with no exec wires costs a single structural scan (`documentUsesExec`).
 *
 * ── DOUBLE BUFFERING, AND WHY IT MAKES THE PASS IDEMPOTENT ──────────────────
 * At boundary j the pass evaluates
 *
 *     base_j = evaluate( fold(doc, j) ⊕ overlay_{j−1} )
 *
 * and every event predicate and every effect VALUE at j is computed from `base_j`
 * and `base_{j−1}` — never from the writes j is in the middle of making. Then
 * `overlay_j = overlay_{j−1} ⊕ writes_j`. This is one step of a synchronous circuit,
 * and it buys three things at once:
 *   · APPLYING THE PASS TWICE AT ONE BOUNDARY IS A NO-OP, because both runs read the
 *     same fixed input and produce the same `set` list. That is idempotence as a
 *     THEOREM about the pass, not a rule authors must remember.
 *   · EVENTS AT ONE BOUNDARY ARE ORDER-INDEPENDENT as far as their predicates go —
 *     none of them can see another's writes — so the only thing ordering decides is
 *     which write survives a collision, and that is stated below.
 *   · REPLAY IS DETERMINISTIC: the recurrence is well-founded on j, so
 *     `execOverlayAt(doc, k)` is the same value however many times it is computed.
 *
 * ── ORDER IS `topoOrder`, NEVER "whatever the map iterates" ─────────────────
 * Unreal does not guarantee its multicast order and the manifest says not to inherit
 * that. Within one boundary: events fire in `topoOrder` of the DATA graph (id order
 * for the unconnected, which is most of them); within one event, the chain is a
 * DEPTH-FIRST PRE-ORDER walk of the exec edges, following each node's exec outputs
 * in DECLARATION order. Last write wins on a collision, which is what makes the
 * order observable and therefore worth pinning.
 *
 * THE DEFAULT `execNext` IS "every declared exec output, in order", which means a
 * SEQUENCE node needs no code at all — declaring N exec outputs IS the sequence. A
 * node that BRANCHES overrides it to return the one pin it chose. Branching and zero
 * occurrences are the two things dataflow structurally cannot express, and they are
 * the reason exec exists.
 *
 * ── THE STEP BUDGET ─────────────────────────────────────────────────────────
 * `connectionRefusal` refuses an exec loop at connect time, so one can only reach
 * this from a hand-edited or externally generated document. Rather than hanging the
 * renderer, the walk stops at EXEC_STEP_BUDGET and REPORTS — the same treatment
 * `topoOrder` gives a data cycle, and for the same reason: a document that got past
 * validation is a fact worth surfacing, not one to paper over.
 *
 * ── THE HONEST BOUNDARY, STATED RATHER THAN DISCOVERED ──────────────────────
 * An effect's VALUE may be any property of the node, including an equation. An
 * equation that reads the effect's own TARGET (`set a.x to "= a.x + 1"`) therefore
 * accumulates ONE step per slide boundary. That is NOT a determinism defect — it is
 * still a pure function of `(doc, slideIndex)`, still identical on replay, still
 * independent of alpha and of the frame rate, so every law in CLAUDE.md's taxonomy
 * holds. It is simply a document whose meaning depends on how many boundaries were
 * crossed, which is what an author who writes that is asking for. What is structural
 * is that the EFFECT VOCABULARY offers no way to spell it: you must go out to an
 * equation and name the target explicitly.
 */

import { blendApplied, copiedDeep, setPath } from "./deltas.js";
import { foldState } from "./document.js";
import { reportOnce } from "./report.js";
import { EXEC_KEY, EXEC_TYPE, declaredPorts, evaluateNodeGraph, execEdgesOf, topoOrder } from "./nodeflow.js";

/** THE NODE KINDS, as a frozen roster so a test can sweep them and a caller cannot
 *  invent a fifth by typo. Ordered as the module docblock introduces them. */
export const EXEC_KINDS = Object.freeze(["pure", "event", "impure", "latent"]);

/**
 * How many nodes ONE event's chain may run before the walk gives up. Sized as "far
 * more than any hand-built chain, far less than a hang": at 60 fps a runaway walk
 * must not be able to cost a visible frame, and the deepest plausible authored chain
 * (a Sequence of ten, each firing a short chain) is two orders of magnitude below
 * this.
 */
export const EXEC_STEP_BUDGET = 1000;

/**
 * Pure function. WHICH OF THE FOUR KINDS this plugin is, derived from its declared
 * exec ports. Every widget in the app that declares none is `pure`, which is what
 * makes this an additive protocol: nothing had to change to gain it.
 *
 * @param {object} plugin - a widget plugin (may declare no ports at all)
 * @param {object} [state] - a state to ask for ports; defaults to the plugin's defaults
 * @returns {string} one of EXEC_KINDS
 *
 * @example nodeExecKind({type: "rect"}) // "pure"
 * @example // a number source has data ports but no exec pins — still pure:
 * @example nodeExecKind({type: "n", ports: () => ({outputs: [{key: "out", type: "number"}]})}) // "pure"
 * @example // no exec IN, one exec OUT: an entry point
 * @example nodeExecKind({type: "e", ports: () => ({outputs: [{key: "then", type: "exec"}]})}) // "event"
 * @example // an exec IN makes it impure — it runs when something fires it
 * @example nodeExecKind({type: "s", ports: () => ({inputs: [{key: "run", type: "exec"}], outputs: [{key: "then", type: "exec"}]})}) // "impure"
 * @example // …and declaring execLatent makes that same shape latent
 * @example nodeExecKind({type: "d", execLatent: () => 1, ports: () => ({inputs: [{key: "run", type: "exec"}], outputs: [{key: "then", type: "exec"}]})}) // "latent"
 */
export function nodeExecKind(plugin, state) {
  const ports = declaredPorts(plugin, state ?? plugin?.defaults ?? {});
  const hasIn = ports.inputs.some((p) => p.type === EXEC_TYPE);
  const hasOut = ports.outputs.some((p) => p.type === EXEC_TYPE);
  if (!hasIn && !hasOut) return "pure";
  if (!hasIn) return "event";
  return typeof plugin?.execLatent === "function" ? "latent" : "impure";
}

/**
 * Pure function. WHY this plugin's exec declaration is malformed, or null when it is
 * sound. The loud import-time gate the registry sweep runs, in the spirit of
 * `declaredPorts` refusing an unknown port type: an exec declaration that does not
 * match its behaviour is a plugin-authoring mistake that must not be discoverable
 * only as a chain that silently stops.
 *
 * The three ways to get it wrong, each with its own fix:
 *   an EVENT with no `execEvent`   — nothing would ever fire it
 *   an `execEvent` with no exec out — it could fire, and nothing could hear it
 *   an IMPURE that neither writes nor forwards — it is a dead link in every chain
 *
 * @param {object} plugin - a widget plugin
 * @param {object} [state] - a state to ask for ports
 * @returns {string|null} the problem sentence, or null
 *
 * @example execKindProblem({type: "rect"}) // null (a pure widget declares nothing)
 * @example execKindProblem({type: "e", ports: () => ({outputs: [{key: "then", type: "exec"}]})})
 * @example // 'exec_flow: "e" declares an exec output but no `execEvent` predicate — nothing would ever fire it.'
 * @example execKindProblem({type: "e", execEvent: () => true, ports: () => ({outputs: [{key: "then", type: "exec"}]})}) // null
 */
export function execKindProblem(plugin, state) {
  const kind = nodeExecKind(plugin, state);
  const hasPredicate = typeof plugin?.execEvent === "function";
  if (kind === "pure")
    return hasPredicate ? `exec_flow: "${plugin?.type}" declares an \`execEvent\` predicate but no exec output port — it could fire and nothing could hear it. Declare an exec output in ports().` : null;
  if (kind === "event")
    return hasPredicate ? null : `exec_flow: "${plugin?.type}" declares an exec output but no \`execEvent\` predicate — nothing would ever fire it. Add execEvent(ctx) -> boolean, or give it an exec INPUT so something else can.`;
  if (typeof plugin?.execEffect !== "function" && declaredPorts(plugin, state ?? plugin?.defaults ?? {}).outputs.every((p) => p.type !== EXEC_TYPE))
    return `exec_flow: "${plugin?.type}" has an exec input but neither an \`execEffect\` nor an exec output — running it would do nothing and stop the chain. Give it one or the other.`;
  return null;
}

/**
 * Pure function. Does this document use exec wires AT ALL — a structural scan of the
 * slide deltas, with no fold and no evaluation.
 *
 * THIS IS THE WHOLE COST OF THIS FEATURE FOR EVERY DECK THAT DOES NOT USE IT, and
 * that is why it exists as a separate cheap question rather than falling out of the
 * replay. `execOverlayAt` is O(slides) EVALUATIONS; asking it about a deck with no
 * events would make an eventless deck pay for events.
 *
 * It reads the RAW deltas rather than a fold because a wire is written as a delta
 * leaf `items.<id>.exec.<port>` on whatever slide authored it, so any occurrence
 * anywhere in the deck is enough to say "maybe" — and a false "maybe" costs only the
 * replay, never a wrong picture.
 *
 * @param {object} doc - a PowerRP document
 * @returns {boolean}
 *
 * @example documentUsesExec({slides: [{delta: {items: {a: {x: 1}}}}]}) // false
 * @example documentUsesExec({slides: [{delta: {items: {a: {exec: {then: {item: "b", port: "run"}}}}}}]}) // true
 * @example documentUsesExec({}) // false
 */
export function documentUsesExec(doc) {
  for (const slide of doc?.slides ?? []) {
    const items = slide?.delta?.items;
    if (!items || typeof items !== "object") continue;
    for (const id of Object.keys(items)) {
      const wires = items[id]?.[EXEC_KEY];
      if (wires && typeof wires === "object" && Object.keys(wires).length > 0) return true;
    }
  }
  return false;
}

/**
 * Pure function. THE WRITES ONE SLIDE BOUNDARY PRODUCES: every event whose predicate
 * fired, walked depth-first through the exec edges, flattened to `set` pairs in the
 * order they were produced.
 *
 * `pending` is the LATENT QUEUE and this function MUTATES it — that is the whole of
 * a latent node's mechanism, and it is why this one function is a Command rather
 * than pure. A latent node does not suspend the walk (there is nothing to suspend, a
 * boundary is instantaneous); it pushes `{atSlide, item, port}` and returns, and the
 * boundary that far ahead starts a chain from that entry. Blueprint's own model:
 * "latency is expressed as a node that owns its own resumption, not as a suspended
 * graph".
 *
 * @param {object} base - the EVALUATED state at this boundary ({items, vars})
 * @param {object|null} prev - the evaluated state at the PREVIOUS boundary, or null at slide 0
 * @param {object} registry - plugin registry
 * @param {number} slideIndex - this boundary
 * @param {object[]} pending - the latent queue, READ and APPENDED TO
 * @returns {Array} [[path, value]] pairs, in execution order
 */
function boundaryWrites(base, prev, registry, slideIndex, pending) {
  const items = base?.items ?? {};
  const writes = [];
  const edges = new Map(); // "item.port" → {item, port}
  for (const e of execEdgesOf(items)) edges.set(`${e.from.item}.${e.from.port}`, e.to);
  // THE DATA GRAPH IS RESOLVED ONCE PER BOUNDARY, through the SAME evaluator derive
  // uses — so what a `value` wire carries into an effect is by construction the
  // number the canvas draws on that wire. Its topological sweep is what makes a
  // CHAIN of data nodes (knob → math → effect) resolve; asking each node for its
  // sources one level deep would have read the middle of that chain as its zero.
  const graph = evaluateNodeGraph(items, registry).values;
  // THE PREVIOUS BOUNDARY'S GRAPH, so an event can compare a WIRE's value across the
  // two. Without it the "output property, followed by a trigger property" the user
  // asked for is unspellable: a threshold node can see what its input reads NOW but
  // has no way to know it was below the line a moment ago, and edge detection needs
  // both samples. It is a second sweep of a graph of a handful of nodes, once per
  // boundary — not per frame (see execOverlayAt).
  const prevGraph = prev ? evaluateNodeGraph(prev.items ?? {}, registry).values : {};
  const steps = { n: 0, blown: false };

  const run = (id, port) => {
    if (steps.n++ >= EXEC_STEP_BUDGET) { steps.blown = true; return; }
    const state = items[id];
    if (!state || state.active === false) return;
    const plugin = registryPlugin(registry, state.type);
    if (!plugin) return;
    const ctx = { id, self: state, inputs: graph[id]?.inputs ?? {}, prevInputs: prevGraph[id]?.inputs ?? {}, prevSelf: prev?.items?.[id] ?? null, state: base, prev, slideIndex, firedPort: port };
    if (typeof plugin.execLatent === "function") {
      const wait = Math.max(1, Math.round(Number(plugin.execLatent(ctx)) || 0));
      for (const p of declaredPorts(plugin, state).outputs) {
        if (p.type === EXEC_TYPE) pending.push({ atSlide: slideIndex + wait, item: id, port: p.key });
      }
      return;
    }
    for (const pair of plugin.execEffect?.(ctx) ?? []) {
      if (validEffectPair(plugin, base, pair)) writes.push(pair);
    }
    for (const key of execNextPorts(plugin, state, ctx)) {
      const target = edges.get(`${id}.${key}`);
      if (target) run(target.item, target.port);
    }
  };

  // EVENTS FIRST, in topoOrder of the DATA graph (id order for the unconnected).
  for (const id of topoOrder(items).order) {
    const state = items[id];
    if (!state || state.active === false) continue;
    const plugin = registryPlugin(registry, state.type);
    if (!plugin || nodeExecKind(plugin, state) !== "event") continue;
    const ctx = { id, self: state, inputs: graph[id]?.inputs ?? {}, prevInputs: prevGraph[id]?.inputs ?? {}, prevSelf: prev?.items?.[id] ?? null, state: base, prev, slideIndex };
    if (!plugin.execEvent(ctx)) continue;
    for (const p of declaredPorts(plugin, state).outputs) {
      if (p.type !== EXEC_TYPE) continue;
      const target = edges.get(`${id}.${p.key}`);
      if (target) run(target.item, target.port);
    }
  }
  // THEN the latent continuations due at this boundary, after the events, so a delay
  // that lands on the same slide as a fresh event is the LATER writer. Their own
  // order is the order they were scheduled in, which is the order they fired in.
  for (const entry of pending) {
    if (entry.atSlide !== slideIndex) continue;
    const target = edges.get(`${entry.item}.${entry.port}`);
    if (target) run(target.item, target.port);
  }

  if (steps.blown)
    reportOnce(`exec_flow:budget:${slideIndex}`, `exec_flow: an event chain on slide ${slideIndex + 1} ran past ${EXEC_STEP_BUDGET} steps and was stopped. connectionRefusal refuses an exec loop at connect time, so this document was hand-edited or generated — look for a cycle in its exec wires.`);
  return writes;
}

/** Query-shaped helper. The plugin for a type, or null — never a throw, for the
 *  reason core/nodeflow.js's own `pluginFor` gives: this walk runs over items the
 *  render tree deliberately skips, and an item with no resolvable plugin is simply
 *  not part of the program. */
function registryPlugin(registry, type) {
  if (typeof type !== "string") return null;
  try {
    return registry?.get?.(type) ?? null;
  } catch {
    // A type the registry does not know. The RENDER walk raises it and names the
    // item, which is where that complaint belongs; raising it twice helps nobody.
    return null;
  }
}

/**
 * Pure function. Which exec output pins this node fires, in order.
 *
 * THE DEFAULT IS EVERY DECLARED EXEC OUTPUT, IN DECLARATION ORDER, and that is the
 * design's best economy: a SEQUENCE node is then just a node that declares N exec
 * outputs, with no code. A node that BRANCHES declares `execNext(ctx) -> string[]`
 * and returns the single pin it chose — which is also how "zero occurrences" is
 * spelled (return []).
 *
 * @param {object} plugin - the node's plugin
 * @param {object} state - its folded state
 * @param {object} ctx - the run context handed to execNext
 * @returns {string[]} exec output keys, in firing order
 */
function execNextPorts(plugin, state, ctx) {
  if (typeof plugin.execNext === "function") return plugin.execNext(ctx) ?? [];
  return declaredPorts(plugin, state).outputs.filter((p) => p.type === EXEC_TYPE).map((p) => p.key);
}

/**
 * Query (reports). Is this effect pair writable, or is it a plugin mistake? Refused
 * LOUDLY rather than written, because both failures produce a document leaf nothing
 * reads — the silent-wrongness class R7-1 spent a round on.
 *
 * @param {object} plugin - the effect's plugin (named in the report)
 * @param {object} base - the evaluated state, to prove the target exists
 * @param {*} pair - a candidate [path, value]
 * @returns {boolean}
 */
function validEffectPair(plugin, base, pair) {
  const path = pair?.[0];
  if (!Array.isArray(path) || path.length < 3 || path[0] !== "items") {
    reportOnce(`exec_flow:path:${plugin?.type}`, `exec_flow: "${plugin?.type}" returned an effect path ${JSON.stringify(path)} — an effect writes an item property, so the path must be ["items", <id>, …]. The write was dropped.`);
    return false;
  }
  // A target that is not on this slide is NOT an error and is NOT reported: an
  // effect aimed at a widget that is deleted here is the same per-slide patch a wire
  // to an absent source is (core/nodeflow.connectionsOf states that rule). Writing
  // anyway would conjure a partial item into the fold.
  return !!base?.items?.[path[1]];
}

/**
 * Query (memoized per document; runs the supplied evaluator O(slideIndex) times).
 * THE EXEC OVERLAY for a slide: the document DELTA every event firing at boundaries
 * 0…slideIndex has written, or null when the deck has no exec wires at all.
 *
 * ── IT DOES NOT TAKE ALPHA, AND THAT IS THE PERFORMANCE STORY ───────────────
 * See the module docblock: the schedule is the slide grid, so one overlay serves
 * every frame of a slide's tween. Callers blend it into the FOLD before evaluating,
 * which is what makes an event's effect an ordinary property value downstream —
 * keyframe-shaped, equation-readable, and invisible to every consumer that did not
 * ask about events.
 *
 * ── WHY THE EVALUATOR IS AN ARGUMENT ────────────────────────────────────────
 * Evaluation needs the project script and the intrinsic content sizes, and neither
 * is in the fold — `web/cameraFrame.js` is the one place that holds both. Taking the
 * evaluator lets this module stay in core, run in bare node, and be unit-tested with
 * a trivial one, while the real binding is spelled exactly once at that seam.
 *
 * @param {object} doc - a PowerRP document
 * @param {number} slideIndex - the boundary to replay up to and including
 * @param {object} registry - plugin registry
 * @param {function} evaluate - (foldedState) => evaluatedState
 * @returns {object|null} a delta tree ({items: {...}}), or null when nothing applies
 *
 * @example // a deck with no exec wires answers null without evaluating anything:
 * @example execOverlayAt({slides: [{delta: {items: {}}}]}, 0, {get: () => null}, (s) => s) // null
 */
export function execOverlayAt(doc, slideIndex, registry, evaluate) {
  if (!doc || !documentUsesExec(doc)) return null;
  const k = Math.max(0, Math.min(Number(slideIndex) || 0, (doc.slides?.length ?? 1) - 1));
  const perDoc = overlayMemo.get(doc) ?? new Map();
  if (!overlayMemo.has(doc)) overlayMemo.set(doc, perDoc);
  if (perDoc.has(k)) return perDoc.get(k);

  let overlay = null;
  let prev = null;
  const pending = [];
  for (let j = 0; j <= k; j++) {
    const folded = foldState(doc, j, 1);
    const base = evaluate(overlay ? blendApplied(folded, overlay, 1) : folded);
    const writes = boundaryWrites(base, prev, registry, j, pending);
    if (writes.length) {
      const next = overlay ? copiedDeep(overlay) : {};
      for (const [path, value] of writes) setPath(next, path, value);
      overlay = next;
    }
    prev = base;
    // MEMOIZE EVERY BOUNDARY ON THE WAY, not just the one asked for. The recurrence
    // already computed them, and a presentation asks for 0, 1, 2 … in turn — so
    // caching the whole prefix turns the deck's total cost from O(n²) into O(n).
    perDoc.set(j, overlay);
  }
  return overlay;
}

/**
 * The overlay cache: document identity → slideIndex → overlay. A WeakMap because the
 * document object is REPLACED on every edit (immutable updates), so a new identity
 * IS the invalidation and a stale entry cannot be reached.
 *
 * THE ONE THING IT DOES NOT KEY ON, disclosed rather than discovered: the evaluator's
 * hidden inputs. The project script rides in `doc.meta` so it is covered, but the
 * intrinsic CONTENT SIZES are not in the document — an image finishing its decode
 * changes what a content-bound equation evaluates to without changing `doc`. That
 * would matter only to an effect whose VALUE reads a content size, and the next edit
 * re-keys everything. It is the same pragmatic trade `evaluateState` makes memoizing
 * on state identity.
 */
const overlayMemo = new WeakMap();

/**
 * Pure function. THE evaluated-fold entrance for a consumer: `folded` with the exec
 * overlay applied, or `folded` unchanged when there is none.
 *
 * One line, and it exists so the two call sites (web/cameraFrame.js's `evaluationAt`
 * and web/app.svelte.js's `rawState`) cannot spell the blend differently — a delta
 * applied at alpha 0.5 by one of them would half-apply every event's effect, which
 * is the "half a wire is not a graph" failure one layer up.
 *
 * @param {object} folded - the folded state ({items, vars})
 * @param {object|null} overlay - an execOverlayAt result
 * @returns {object} the folded state to evaluate
 *
 * @example withExecOverlay({items: {a: {x: 1}}}, null).items.a.x // 1
 * @example withExecOverlay({items: {a: {x: 1}}}, {items: {a: {x: 9}}}).items.a.x // 9
 */
export function withExecOverlay(folded, overlay) {
  return overlay ? blendApplied(folded, overlay, 1) : folded;
}
