/**
 * CUSTOM LOGIC NODE — the Axoloti half of the per-frame ask: a node whose PORTS and
 * BEHAVIOUR are both written by the author, in JavaScript, edited by double-clicking
 * the card.
 *
 * > *"unlike unreal and more like axoloti we should be able to double click a special
 * > kind of node - a custom node - to open a modal that edits a property in that
 * > custom logic node widget, which is a javascript code spec for its inputs and
 * > outputs."* (user, 2026-08-12)
 *
 * ── EVERY PIECE OF THIS ALREADY EXISTED; THE WORK WAS COMPOSITION ───────────
 *   double-click → modal      `activate: "code_modal"`, ONE string resolved through
 *                             web/widget_handlers.js's ACTIVATE registry
 *   the modal                 the reusable full-screen Monaco, declared with
 *                             `codeEditor: {property, language, title}`; save commits
 *                             ONE undo unit through app.commitCodeModal
 *   the code as document state a plain string property, exactly like `doc.meta.script`
 *                             and every other codeEditor widget's
 *   the sandbox               core/custom_node.js compiles it in the PROJECT SCRIPT'S
 *                             OWN JAIL — not a second, laxer one
 *   ports as a function of state `core/nodeflow.declaredPorts` already contracts this.
 *                             It is the hinge that makes a self-describing node
 *                             possible at all.
 *
 * ── IT IS ALWAYS "EMBEDDED", IN AXOLOTI'S SENSE, AND THAT IS THE RIGHT DEFAULT ─
 * Axoloti distinguishes EMBEDDED objects (definition cloned into the patch file) from
 * LIBRARY ones (a shared `.axo` every patch references, so editing it changes every
 * patch at once). A PowerRP custom node's code is a string property on a document
 * item, so it is always embedded: per-item, travelling with the document, saved with
 * it, undone with it. The LIBRARY half already exists as `doc.meta.script` — one
 * definition shared by the whole deck — and a custom node's body can CALL its
 * exports, because both compile in the same jail with the same scope. So the app has
 * Axoloti's two-level model with the line drawn where it already was.
 *
 * ── WHAT IT DOES *NOT* COPY FROM AXOLOTI: THE RECOMPILE CEREMONY ───────────
 * Axoloti pays a leave-live-mode → regenerate → cross-compile → re-upload → restart
 * cycle for any port edit, and loses all runtime state doing it, because its target
 * is an STM32 and its code is C. Ours is `new Function` in the equation jail: the
 * compile is memoized per source string and costs microseconds, so a port-list edit
 * is an ordinary document edit that goes through undo like any other. The one thing
 * worth carrying over is WHY Axoloti loses state — a redefined object is not the same
 * object — which here is `resetSimulation()`'s existing job.
 *
 * ── SIMULATED IFF THE SPEC SAYS SO ─────────────────────────────────────────
 * A spec declaring only `exports.compute` is PURE: no state, seekable, strided shards
 * still legal. A spec declaring `exports.step` carries state between frames and is
 * SIMULATED, with all the standard costs. `frameNodeIsSimulated` reads this plugin's
 * `frameStep`, which is always present — so this widget answers the sharding question
 * conservatively (a deck containing ANY custom node is treated as simulated). That is
 * the safe direction and it is deliberate: the alternative is compiling every spec in
 * the document before a render job may shard, and a WRONGLY-PERMITTED strided shard
 * renders a plausible wrong video on a green exit code, while a wrongly-refused one
 * costs some parallelism.
 *
 * ── THE ONE LIMITATION, STATED RATHER THAN DISCOVERED ──────────────────────
 * A CUSTOM NODE'S DATA INPUTS GET NO INSPECTOR KNOB ROW. Every other node widget's
 * `inputs.<port>` rows are baked into a plugin-level `inspector` ARRAY, and that
 * array is static at every consumer (web/Inspector.svelte reads
 * `sel.plugin.inspector`); only OUTPUT properties currently get a per-state path
 * (`outputPropertyRows(plugin, state)`). This widget's ports are not known until a
 * spec compiles, so there is no static set to bake.
 *
 * So its inputs are WIREABLE and READABLE but not typeable: an unwired one arrives
 * as its port type's zero, and a spec that wants an authored constant should read a
 * `params`-style value from `self` or default it in `compute`. `tests/exec_flow_test.js`
 * exempts `authoredPorts` widgets from the every-data-input-has-a-row sweep and
 * carries the same note. Lifting this means making `inspector` state-aware for EVERY
 * widget, which is a change to a contract twenty files read — not something to
 * special-case here.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { compileCustomNode, customNodePorts } from "../core/custom_node.js";
import { particleTime } from "../render_gpu/particle_clock.js";
import { reportOnce } from "../core/report.js";

/** The property the Monaco modal edits, named once so the plugin, the modal
 *  declaration and every reader agree. */
const SPEC_KEY = "definition";

/**
 * THE STARTER SPEC a fresh custom node is born with. It is a WORKING node rather
 * than an empty file or a comment block, for the reason every demo preset in this
 * app is: a card with no ports looks broken, and an author's first question is "what
 * am I allowed to write here", which a runnable example answers faster than prose.
 *
 * It deliberately shows the PURE shape (`compute` only), because that is the one
 * with no costs — an author who needs state will find `step` in the help text, and
 * one who does not should never be nudged into declaring it.
 */
export const CUSTOM_NODE_STARTER = `// Ports are DECLARED, not guessed from the code below — so renaming a variable
// can never silently delete a wire. Types: number, trigger, exec, midi, audio, node.
ports.inputs = [{key: "a", type: "number", label: "a"},
                {key: "b", type: "number", label: "b"}];
ports.outputs = [{key: "out", type: "number", label: "out"}];

// PURE: called whenever something reads this node. \`inputs\` has every declared
// input (unwired ones are 0); \`self\` is this widget's own folded state.
exports.compute = (inputs, self) => ({out: Math.hypot(inputs.a, inputs.b)});

// To carry state BETWEEN FRAMES, declare \`step\` instead of (or beside) \`compute\`:
//   exports.step = ({inputs, prev, dt, firstStep, entered}) => ({
//     state:   {total: (prev?.total ?? 0) + inputs.a * dt},
//     outputs: {out: (prev?.total ?? 0)},
//     fired:   [],          // exec output keys that pulse THIS frame
//   });
// A custom node is SIMULATED whether or not you declare \`step\`: its state is not
// saved, it resets when the presentation restarts, and the deck must render in
// contiguous frame ranges rather than strided ones. This comment used to say
// declaring \`step\` was what made it so, which read as "a compute-only spec is
// free" — it is not. The widget answers the simulated question unconditionally,
// because the answer would otherwise depend on COMPILING every spec in the
// document before a render job could shard, and a wrong "not simulated" is a
// strided shard that renders the wrong frames (core/custom_node.js states the
// whole argument, and the dead predicate that once claimed otherwise is gone).
// What \`step\` adds is state that survives from one frame to the next.
`;

/**
 * Pure function. THE PORTS this node declares, read from its compiled spec.
 *
 * A spec nothing has compiled yet — or one that failed — declares NOTHING, which is
 * the loud-and-visible failure: a card with no beads, beside the error in the modal's
 * footer. Half a port list would be worse (see core/custom_node.js's failure-is-total
 * rule), because a wire whose bead vanished looks like a wire that was never drawn.
 *
 * @param {object} state - the folded item state (its `definition`)
 * @returns {{inputs: object[], outputs: object[]}}
 *
 * @example customPorts({}) // {inputs: [], outputs: []}
 * @example customPorts({definition: ""}) // {inputs: [], outputs: []}
 */
export function customPorts(state) {
  return customNodePorts(state?.[SPEC_KEY]);
}

export const nodeCustomPlugin = execNodePlugin({
  type: "node_custom",
  title: "Custom Node",
  icon: "mdi:code-braces-box",
  // A PORT LIST AS A FUNCTION OF STATE — the contract core/nodeflow.declaredPorts
  // already states, and the one that makes this whole widget possible.
  ports: (state) => customPorts(state),
  own: { [SPEC_KEY]: CUSTOM_NODE_STARTER, label: "" },
  rows: [
    { key: "label", label: "Label", kind: "text", category: EXEC_NODE_CAT, help: "What the card prints under its title. Name what this node DOES — the code is behind a double-click, so the card is the only thing a reader of the slide sees." },
  ],
  // THE DOUBLE-CLICK. One string, resolved through web/widget_handlers.js's ACTIVATE
  // registry — and it reaches the plugin only because core/exec_nodes.js now passes
  // `activate` and `extra` through. It did not before this landed, so a trigger node
  // COULD NOT declare a handler at all and the failure was silence; that passthrough
  // and this line are in the same commit, per the missing-named-import rule.
  activate: "code_modal",
  extra: {
    // THE DECLARATION THAT THIS WIDGET'S PORTS ARE THE AUTHOR'S, NOT THE PLUGIN'S.
    // `core/exec_flow.execKindProblem` reads it and stands down: every sentence that
    // gate can produce is about a FIXED port list, and this widget has none to check
    // (its defaults carry whatever CUSTOM_NODE_STARTER declares, and a real instance
    // carries whatever was typed). The checks the gate would have made are covered
    // elsewhere and more precisely — a firing hook is always present (`frameStep`),
    // the wire storage always is (`execNodeDefaults`), and the ports themselves are
    // validated at COMPILE by core/custom_node.js, which refuses a bad one by name.
    authoredPorts: true,
    // WHICH string the modal edits. IN `extra` BECAUSE THE FACTORY IS A WHITELIST —
    // plugins/node_abc.js's header records what a top-level declaration cost on the
    // control-node side (a dead double-click on a green build that nothing in the
    // suite caught). `language: "javascript"` is honest here where node_abc's `null`
    // was: Monaco ships a JavaScript grammar, so the colouring is real.
    codeEditor: { property: SPEC_KEY, language: "javascript", title: "Edit Custom Node" },
  },
  readout: (s) => (typeof s.label === "string" && s.label !== "" ? s.label : "{ }"),
  /**
   * Query (compiles the spec through the memoized jail; reports a broken one).
   * The node protocol's compute step, delegated to the author's `exports.compute`.
   *
   * ── A THROW IN AUTHOR CODE IS REPORTED, NOT PROPAGATED ─────────────────────
   * The same treatment core/expressions.js gives a project script that throws: the
   * pass must still produce a frame, and one broken node must not blank a slide. The
   * node then publishes nothing, so every downstream reader gets its port's ZERO and
   * fails visibly rather than plausibly.
   *
   * THE HOST IS THE ONE THIS PASS WOULD GIVE AN EQUATION — a seeded `random` and the
   * one presentation clock — so a custom node reading `time` sees exactly what
   * `= time` sees. It is threaded per call rather than captured, because the compile
   * is memoized per source while the clock advances every frame.
   *
   * @param {object} s - the folded item state
   * @param {object} inputs - every declared input, unconnected ones already zeroed
   * @returns {object} the author's output map, or {} when there is none
   *
   * @example nodeCustomPlugin.computeOutputs({}, {}) // {} (a blank spec computes nothing)
   */
  computeOutputs(s, inputs) {
    const spec = compileCustomNode(s?.[SPEC_KEY], customHost());
    if (spec.error) {
      reportOnce(`node_custom:${s?.[SPEC_KEY]}`, `node_custom: ${spec.error}`);
      return {};
    }
    if (!spec.compute) return {};
    try {
      return spec.compute(inputs, s) ?? {};
    } catch (e) {
      reportOnce(`node_custom:compute:${s?.[SPEC_KEY]}`, `node_custom: this node's compute() threw — ${e.message}. It published nothing this frame.`);
      return {};
    }
  },
  /**
   * ONE FRAME of the author's node — core/exec_frame.js's frame-domain contract,
   * delegated to `exports.step`.
   *
   * DECLARED UNCONDITIONALLY even though most specs will not use it, and that is the
   * conservative direction on purpose (see the header): `frameNodeIsSimulated` reads
   * the PLUGIN, so every deck containing a custom node is treated as simulated and
   * renders in contiguous shards. A wrongly-permitted strided shard is a plausible
   * WRONG video on a green exit code; a wrongly-refused one costs parallelism.
   *
   * A spec with no `step` returns nothing, which the driver records as its carried
   * state — so `firstStep` still flips correctly and a spec that GAINS a `step` later
   * starts cleanly.
   *
   * @param {object} ctx - {self, inputs, prev, dt, firstStep, entered}
   * @returns {object} the author's {state, fired, outputs}, or {} when there is none
   *
   * @example nodeCustomPlugin.frameStep({self: {}, inputs: {}}) // {}
   */
  frameStep(ctx) {
    const spec = compileCustomNode(ctx.self?.[SPEC_KEY], customHost());
    if (spec.error || !spec.step) return {};
    try {
      return spec.step(ctx) ?? {};
    } catch (e) {
      reportOnce(`node_custom:step:${ctx.self?.[SPEC_KEY]}`, `node_custom: this node's step() threw — ${e.message}. It produced nothing this frame.`);
      return {};
    }
  },
});

/**
 * Query (reads the ONE presentation clock). The deterministic host a custom node's
 * spec compiles against.
 *
 * ── THE SEED IS THE SPEC ITSELF, NOT THE DOCUMENT, AND THAT IS A REAL CHOICE ─
 * `core/expressions.js` seeds its PRNG from the document's slot keys, so every
 * equation in one deck draws from one stream. A custom node cannot reach that seed
 * from here (it is per-evaluation-pass, and this is called from `computeOutputs`),
 * and inventing a per-call seed would make `random` a different number on every read
 * — which is not randomness, it is noise, and it would break Δt = 0 outright.
 *
 * So the stream is FIXED and per-process: the same custom node returns the same
 * sequence on every machine and in every render, which is what determinism requires.
 * What it is NOT is independent per node instance — two copies of one custom node
 * draw the same numbers. That is a real limitation, stated rather than hidden; a spec
 * that needs per-instance variation should hash something it can see (an input, a
 * position) rather than expect `random` to differ.
 */
function customHost() {
  return { random: customRandom, time: particleTime, pointer: () => null };
}

/** A fixed-seed mulberry32, so a custom node's `random` is the same sequence in the
 *  editor, in an export and on every machine. See customHost for what this trades. */
let customSeed = 0x9e3779b9;
function customRandom() {
  customSeed = (customSeed + 0x6d2b79f5) | 0;
  let t = Math.imul(customSeed ^ (customSeed >>> 15), 1 | customSeed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
