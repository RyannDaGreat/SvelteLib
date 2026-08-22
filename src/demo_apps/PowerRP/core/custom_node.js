/**
 * THE CUSTOM LOGIC NODE'S COMPILER — an author-written JavaScript node, ports and
 * all, compiled in the SAME jail the project script uses.
 *
 * ── THE ASK (user, 2026-08-12, verbatim) ────────────────────────────────────
 * *"unlike unreal and more like axoloti we should be able to double click a special
 * kind of node - a custom node - to open a modal that edits a property in that custom
 * logic node widget, which is a javascript code spec for its inputs and outputs."*
 *
 * ── PORTS ARE DECLARED, NEVER INFERRED — AXOLOTI'S ANSWER, NOT gen~'s ───────
 * The two reference systems disagree and the disagreement matters. Max/MSP's `gen~`
 * INFERS ports from identifiers appearing in the code: typing `in2` creates that
 * port. Axoloti DECLARES them, in table editors beside the code. This takes
 * Axoloti's answer, for two reasons that are both structural here:
 *
 *   A TYPO MUST NOT SILENTLY DELETE A WIRE. Under inference, renaming `speed` to
 *   `sped` in the body removes a port — and with it the connection an author drew,
 *   with no error, because nothing was ever wrong. That is precisely the quiet
 *   wrongness this codebase legislates against everywhere else.
 *   `declaredPorts` MUST BE A PURE FUNCTION OF STATE. Bead layout, wire derivation,
 *   `connectionRefusal` and the hit test all call it, several of them per frame and
 *   some of them mid-drag. Deriving ports by EXECUTING the body on every call is not
 *   available; deriving them from a declaration the body assigns once is.
 *
 * So a spec assigns to a provided `ports` object, exactly as the project script
 * assigns to `exports`, and the compile is memoized per SOURCE STRING.
 *
 * ── THE JAIL IS THE PROJECT SCRIPT'S, NOT A SECOND ONE ─────────────────────
 * `core/project_script.scriptScope` IS the scope this compiles against: the
 * always-true `has` trap (no fall-through to real globals), `BLOCKED_GLOBALS`
 * (`Date`, `fetch`, `performance`, `setTimeout`, `Function`, `eval`…), `Math` as
 * SAFE_MATH, the SEEDED `random`, the ONE presentation clock as `time`, and
 * `SCRIPT_STDLIB`'s pure value-level built-ins. A custom node MUST NOT get a second,
 * laxer sandbox — one jail is the reason `RenderTree = pure(document, [[slide,
 * alpha]])` survives author-written code at all, and two would be two things to keep
 * correct.
 *
 * The one addition is the `ports` collector, served through the same scope for the
 * same measured reason `exports` is (project_script.js: `with(scope)` sits INSIDE the
 * compiled function, so its always-true `has` trap shadows every parameter name — an
 * `exports` ARGUMENT resolved to the proxy's `undefined` and the first assignment
 * threw). It is served BESIDE `exports`, so a spec may also declare private helpers
 * and export nothing.
 *
 * ── FAILURE IS TOTAL, AND THAT IS THE PROJECT SCRIPT'S RULE VERBATIM ────────
 * A spec that will not compile, declares a bad port, or throws while declaring
 * yields NO PORTS AND NO FUNCTIONS — never the half it managed before failing. *"A
 * partial library is worse than none"* (project_script.js), and `core/abc.js` states
 * the sharper version for a node: *"a tune with ANY error yields NO NOTES AT ALL"*,
 * because half a thing looks like it worked. A broken custom node is therefore a
 * node with no ports and a sentence, which is visible; a node with three of its four
 * ports is a wire that silently vanished.
 *
 * ── WHAT A SPEC LOOKS LIKE ─────────────────────────────────────────────────
 *     ports.inputs  = [{key: "a", type: "number", label: "a"},
 *                      {key: "run", type: "exec", label: "Run"}];
 *     ports.outputs = [{key: "out", type: "number", label: "out"}];
 *
 *     // PURE: called per read, no state. The node stays seekable.
 *     exports.compute = (inputs, self) => ({out: inputs.a * 2});
 *
 *     // OPTIONAL, and declaring it is declaring "I am SIMULATED":
 *     exports.step = (ctx) => ({state: …, fired: ["then"], outputs: {…}});
 *
 * `compute` AND `step` ARE SEPARATE, WHICH IS AXOLOTI'S `code.krate` / `code.srate`
 * RATE SPLIT ONE LEVEL UP. The object states its own rate structure DECLARATIVELY and
 * the host supplies the loop — which is what lets `core/document.documentIsSimulated`
 * answer "may this render be strided-sharded" by ASKING rather than by executing
 * anything. A custom node that declares only `compute` is visibly pure and pays none
 * of the simulated costs.
 *
 * ── WHAT IT DOES *NOT* GET: THE DOCUMENT ───────────────────────────────────
 * No `items`, no `vars`, no `self` in the spec's own top-level scope — the body runs
 * ONCE per compile, not once per frame, so a reference read there would be a snapshot
 * from whichever pass compiled first. The per-frame values arrive as ARGUMENTS to
 * `compute`/`step`. Reading `time` or `random` at the TOP LEVEL is refused by the
 * shared jail for the identical reason (the compile is memoized, so such a value
 * would freeze forever); read them inside the functions.
 *
 * DOM-free: core/ runs in bare node.
 */

import { compileProjectScript, isIdentifier } from "./project_script.js";
import { PORT_TYPE_NAMES } from "./nodeflow.js";

/** The result every blank spec shares — a stable identity, so a caller may use it as
 *  a cheap "nothing declared" test. */
const EMPTY_SPEC = Object.freeze({
  ports: Object.freeze({ inputs: Object.freeze([]), outputs: Object.freeze([]) }),
  compute: null,
  step: null,
  error: null,
});

/**
 * Pure function. WHY this port declaration is malformed, or null when it is sound.
 * The problem-string-or-null shape `core/nodeflow.nodeRefProblem` already uses.
 *
 * Every check here exists because the failure it prevents is INVISIBLE rather than
 * loud: an unknown `type` would make `portColor` and `portZero` answer undefined and
 * the bead would paint as nothing; a duplicate `key` would give two beads one
 * identity, so a wire drawn to the second lands on the first; a non-identifier key
 * cannot be spelled by an equation reading the output.
 *
 * @param {*} port - one entry of `ports.inputs` / `ports.outputs`
 * @param {string} side - "inputs" or "outputs", for the sentence
 * @param {Set<string>} seen - keys already declared on this side
 * @returns {string|null}
 *
 * @example customPortProblem({key: "a", type: "number"}, "inputs", new Set()) // null
 * @example customPortProblem({key: "a"}, "inputs", new Set()).includes("type") // true
 * @example customPortProblem({key: "2a", type: "number"}, "inputs", new Set()).includes("identifier") // true
 * @example customPortProblem({key: "a", type: "number"}, "inputs", new Set(["a"])).includes("twice") // true
 * @example customPortProblem({key: "a", type: "banana"}, "inputs", new Set()).includes("banana") // true
 */
export function customPortProblem(port, side, seen) {
  if (!port || typeof port !== "object")
    return `ports.${side} must be a list of {key, type} objects — found ${JSON.stringify(port)}`;
  if (typeof port.key !== "string" || !isIdentifier(port.key))
    return `ports.${side} entry has key ${JSON.stringify(port.key)}, which is not a legal identifier — a port key must match /^[A-Za-z_$][A-Za-z0-9_$]*$/ so an equation can reference it`;
  if (seen.has(port.key))
    return `ports.${side} declares "${port.key}" twice — two ports with one key would give two beads one identity, so a wire drawn to the second would land on the first`;
  if (!PORT_TYPE_NAMES.includes(port.type))
    return `ports.${side} entry "${port.key}" has type ${JSON.stringify(port.type)}, which is not a port type. The types are: ${PORT_TYPE_NAMES.join(", ")}`;
  return null;
}

/**
 * Pure function. One side's port list, validated and normalized, or a thrown Error
 * naming the first problem. Internal to the compile, which turns the throw into the
 * spec's `error` — the project script's own return-don't-throw contract.
 */
function checkedPorts(list, side) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`ports.${side} must be an array — found ${typeof list}`);
  const seen = new Set();
  const out = [];
  for (const port of list) {
    const problem = customPortProblem(port, side, seen);
    if (problem) throw new Error(problem);
    seen.add(port.key);
    // NORMALIZED to exactly the three fields the port machinery reads, so a spec
    // cannot smuggle a field (`feedbackSafe`, say) that changes evaluator behaviour
    // through a declaration meant to describe a bead.
    out.push(Object.freeze({ key: port.key, type: port.type, label: typeof port.label === "string" ? port.label : port.key }));
  }
  return Object.freeze(out);
}

// The compile cache: spec SOURCE → the compiled result. Keyed on the source string
// for core/project_script.js's stated reason — the result is a pure function of it,
// and `declaredPorts` is called several times per frame per node, so recompiling a
// spec per reactive pass would be the equation memo's problem all over again.
const specCache = new Map();

/**
 * Near-pure function (memoizes into a module cache; NEVER throws). Compiles a CUSTOM
 * NODE SPEC into `{ports, compute, step, error}`.
 *
 * `error` is null on success, else the human-readable sentence — a syntax error, a
 * throw while declaring, or a port problem. The CALLER reports it; this does not
 * touch the console, so the modal's footer and the report path get the same string
 * and cannot describe the failure differently (project_script.compileProjectScript's
 * contract verbatim, and the reason it returns rather than throws: this runs inside
 * the derivation pass, which must always produce a frame).
 *
 * Args:
 *   src (string): the spec source (the widget's `definition` property).
 *   host (object): {random, time} — the seeded PRNG and this pass's clock reader,
 *     threaded into the shared jail exactly as a project script's is.
 *
 * Returns:
 *   {ports: {inputs, outputs}, compute: Function|null, step: Function|null,
 *    error: string|null}
 *
 * @example // compileCustomNode("", host).ports.inputs // [] (a blank spec declares nothing)
 * @example // compileCustomNode("ports.outputs = [{key: 'out', type: 'number'}];", host).ports.outputs[0].label // "out"
 * @example // compileCustomNode("exports.compute = (i) => ({out: i.a * 2});", host).compute // a function
 * @example // compileCustomNode("ports.inputs = [{key: '2a', type: 'number'}];", host).error // "…not a legal identifier…"
 * @example // A BROKEN SPEC DECLARES NOTHING AT ALL — never half of it:
 * @example // compileCustomNode("ports.outputs = [{key: 'out', type: 'number'}]; throw new Error('x');", host).ports.outputs // []
 */
export function compileCustomNode(src, host) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return EMPTY_SPEC;
  const cached = specCache.get(source);
  if (cached) {
    // THE HOST IS RE-POINTED, NOT RE-COMPILED. The compiled functions read `time`
    // and `random` through the project script's own host CELL, so an exported
    // function called this frame reads THIS frame's clock even though the body ran
    // once. compileProjectScript does the re-pointing; calling it is what threads it.
    compileProjectScript(cached.scriptSource, host);
    return cached.result;
  }
  const result = computeCustomNode(source, host);
  specCache.set(source, result.entry);
  return result.entry.result;
}

/** Pure-core of compileCustomNode (see its docs); uncached, never throws. */
function computeCustomNode(source, host) {
  const failed = (error) => ({ entry: { scriptSource: source, result: { ...EMPTY_SPEC, error } } });
  // THE PORTS COLLECTOR RIDES IN ON THE SPEC'S OWN PROLOGUE, which is what lets this
  // reuse `compileProjectScript` UNCHANGED rather than forking its jail. The prologue
  // declares `ports` as an ordinary local of the spec body and re-exports it under a
  // reserved-looking name, so the whole spec compiles as ONE project-script body, in
  // ONE jail, under ONE memo.
  //
  // A SPEC THAT ASSIGNS `exports.__customNodePorts` ITSELF would clobber the
  // collector. It cannot do so usefully — the prologue's assignment runs LAST, after
  // the whole spec body, so the collector always wins — and the name is a
  // double-underscore internal that no author writes by accident. The failure if one
  // did is a spec whose ports are the ones it declared through `ports`, which is the
  // correct answer anyway.
  //
  // A SECOND COMPILER WAS THE ALTERNATIVE AND IT WAS REFUSED: it would have meant a
  // second `new Function`, a second scope object and a second set of blocked globals
  // to keep in step with core/expressions.js — the mirror-drift this codebase pays
  // for wherever it appears. One jail, reached one way.
  const scriptSource = `const ports = {inputs: undefined, outputs: undefined};\n${source}\n;exports.__customNodePorts = ports;`;
  const compiled = compileProjectScript(scriptSource, host);
  if (compiled.error) {
    // The wrapper's two extra lines shift the reported line number by one. Said
    // rather than silently corrected, because "correcting" it would mean parsing V8's
    // message text and re-emitting it — the same trade project_script.js measured and
    // declined for its own wrapper.
    return failed(compiled.error.replace(/^Project script/, "Custom node spec"));
  }
  const declared = compiled.exports.__customNodePorts;
  let ports;
  try {
    ports = Object.freeze({
      inputs: checkedPorts(declared?.inputs, "inputs"),
      outputs: checkedPorts(declared?.outputs, "outputs"),
    });
  } catch (e) {
    return failed(`Custom node spec: ${e.message}`);
  }
  const compute = typeof compiled.exports.compute === "function" ? compiled.exports.compute : null;
  const step = typeof compiled.exports.step === "function" ? compiled.exports.step : null;
  if (!compute && !step && (ports.inputs.length > 0 || ports.outputs.length > 0))
    return failed('Custom node spec declares ports but neither `exports.compute` nor `exports.step`, so the node would have beads and do nothing. Add `exports.compute = (inputs, self) => ({...})` for a pure node, or `exports.step = (ctx) => ({state, fired, outputs})` for one that carries state between frames.');
  return { entry: { scriptSource, result: { ports, compute, step, error: null } } };
}

/**
 * Query (reads the compile cache; NEVER compiles). Why `src` does not compile, or
 * null when it does — the UI's read, for the code modal's footer.
 *
 * IT DOES NOT COMPILE, for `project_script.projectScriptProblem`'s stated reason: a
 * UI-supplied host would overwrite the live cell this pass's compiled functions read
 * their clock through, and a status line has no business changing what the canvas
 * evaluates. A source the evaluator has not reached yet reads as null, and the next
 * derivation pass — which a commit always triggers — fills it in.
 *
 * @example // customNodeProblem("") // null (a blank spec always compiles)
 * @example // after a broken spec was evaluated: customNodeProblem(src) // "Custom node spec: …"
 */
export function customNodeProblem(src) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return null;
  return specCache.get(source)?.result.error ?? null;
}

/**
 * Query (compiles through the memo on first sight; pure thereafter). The PORTS `src`
 * declares — `{inputs: [], outputs: []}` for a blank source or one that failed.
 *
 * THIS IS WHAT `declaredPorts` CALLS, and the caching is why: port layout, wire
 * derivation, `connectionRefusal` and the bead hit test all ask, several times per
 * frame per node.
 *
 * ── IT COMPILES RATHER THAN ONLY READING THE CACHE, AND THAT WAS A REAL BUG ──
 * The first version was a pure cache read, matching `projectScriptProblem`'s
 * non-perturbing contract. MEASURED BY tests/execframe_probe.js: a FRESHLY INSERTED
 * custom node then had NO BEADS AT ALL, because nothing had compiled its spec yet —
 * `declaredPorts` must be a pure function of STATE, and a version that depends on
 * whether some other pass happened to run first is not one. The widget would grow its
 * ports later, when an unrelated evaluation compiled the spec, which is exactly the
 * kind of "it works if you wiggle something" behaviour this codebase legislates
 * against.
 *
 * COMPILING HERE IS SAFE WHERE `projectScriptProblem`'s WOULD NOT BE, and the
 * difference is the host. That one refuses to compile because it would have to invent
 * a host, and a UI-supplied one would overwrite the live cell this pass's exported
 * functions read their clock through. This needs no host at all: it reads only the
 * PORT DECLARATION, which the spec body assigns before any function it exports could
 * run. So the null host below can never reach an exported function — and if a spec
 * reads `time` at its TOP LEVEL, the shared jail refuses it loudly (that is the
 * memoized-compile rule, and the refusal is the right answer here too).
 *
 * @example // customNodePorts("") // {inputs: [], outputs: []}
 * @example // customNodePorts("ports.outputs=[{key:'o',type:'number'}]; exports.compute=()=>({o:1});").outputs[0].key // "o"
 */
export function customNodePorts(src) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return EMPTY_SPEC.ports;
  const cached = specCache.get(source);
  if (cached) return cached.result.ports;
  // NO HOST: see the docblock. A port declaration is assigned by the spec body, which
  // cannot legally read the clock at its top level anyway.
  return compileCustomNode(source, PORTLESS_HOST).ports;
}

/** The host handed to a compile that only wants the PORT DECLARATION. Its readers
 *  throw, which is correct: reaching one would mean a spec read `time` or `random` at
 *  its TOP LEVEL, and the shared jail already refuses that for the memoized-compile
 *  reason (a value read there would be frozen forever). */
const PORTLESS_HOST = Object.freeze({
  random: () => { throw new Error("`random` is unavailable at a custom node spec's top level — read it inside compute() or step(), which run per frame"); },
  time: () => { throw new Error("`time` is unavailable at a custom node spec's top level — read it inside compute() or step(), which run per frame"); },
  pointer: () => null,
});

/**
 * Query (reads the compile cache; NEVER compiles). Does `src` declare `exports.step`
 * — i.e. is a custom node running this spec SIMULATED?
 *
 * ── THIS IS THE ONE THAT DECIDES WHETHER A RENDER MAY BE SHARDED ───────────
 * `core/document.documentIsSimulated` asks the PLUGIN, and the custom node's plugin
 * asks this. It is a cache read rather than a compile on purpose, and that has a
 * consequence worth stating: a spec nothing has evaluated yet answers FALSE. That is
 * safe in the only place it matters — `cli/render_job.js` repairs and evaluates the
 * document before it shards — but a future caller that asks BEFORE any evaluation
 * must compile first, and this docblock is where it should find that out.
 *
 * @example // customNodeIsSimulated("") // false
 * @example // after a spec declaring exports.step was evaluated: customNodeIsSimulated(src) // true
 */
export function customNodeIsSimulated(src) {
  const source = typeof src === "string" ? src : "";
  if (source.trim() === "") return false;
  return !!specCache.get(source)?.result.step;
}
