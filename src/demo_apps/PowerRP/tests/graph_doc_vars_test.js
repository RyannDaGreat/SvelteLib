/**
 * DOC-VARS-REACH-THE-GRAPH-SANDBOX test (the zoo's λ-morph crash: "lambda is
 * not defined" on 4 of 14 slides). Bare-node. A graph equation sampled inside
 * emit() must see the DOCUMENT's folded variables — emit only receives item
 * state, so deriveRenderTree injects `docVars` onto nodes whose plugin
 * capabilities declare `docVars: true`, and the graph plugins spread item
 * vars OVER them (per-widget shadowing, digest 09). Pins: injection happens,
 * shadowing order, undeclared plugins keep the identical state object, and a
 * genuinely-undefined variable still fails LOUDLY (the red box, never a
 * silent blank).
 *
 * Run: node tests/graph_doc_vars_test.js
 */
import { deriveRenderTree } from "../core/derive.js";
import { registerAll } from "../plugins/index.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";

const registry = createRegistry();
registerAll(registry, createCommands());
let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const lineDefaults = registry.get("graph_line").defaults;
const emitOps = (item, vars) => {
  const state = { vars, items: { g: item } };
  const g = deriveRenderTree(state, registry).find((n) => n.id === "g");
  return g.plugin.emit(g.state, null, g.world);
};
const line = (source, vars, extra = {}) =>
  emitOps({ ...lineDefaults, mode: "parametric", source, tStart: 0, tEnd: 1, numPoints: 8, ...extra }, vars);

// The zoo crash, pinned: a source referencing a DOCUMENT var must sample.
const morphed = line("[t * lambda, t]", { lambda: 0.5 });
ok(morphed.length === 1 && morphed[0].op === "path", `document var reaches the sandbox — λ-morph emits a path (got ${morphed.map((o) => o.op).join(",")})`);

// Loudness preserved: a truly-undefined name is still the red error box.
const broken = line("[t * lambda, t]", {});
ok(broken[0]?.op === "rect" && /lambda is not defined/.test(broken[1]?.text ?? ""), "an undefined var still fails LOUDLY (red box names the variable)");

// Shadowing: the item's OWN vars win over the document's (digest-09 law).
const shadowNode = (() => {
  const state = { vars: { k: 100 }, items: { g: { ...lineDefaults, mode: "parametric", source: "[t, t]", vars: { k: 7 } } } };
  return deriveRenderTree(state, registry).find((n) => n.id === "g");
})();
ok(shadowNode.state.docVars?.k === 100, "docVars carries the DOCUMENT value (item vars shadow at the merge in the plugin, not here)");

// Injection is capability-gated: an undeclared plugin's state is IDENTICAL.
const rectState = { active: true, type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0 };
const rectNode = deriveRenderTree({ vars: { lambda: 1 }, items: { r: rectState } }, registry).find((n) => n.id === "r");
ok(rectNode.state === rectState && !("docVars" in rectNode.state), "a non-docVars plugin keeps the very same state object (byte-identity)");

// graph_bars sees doc vars too (its valueEquation is sampled the same way).
const barsDefaults = registry.get("graph_bars").defaults;
const bars = emitOps({ ...barsDefaults, valueEquation: "amp * (i + 1)", barCount: 3 }, { amp: 2 });
ok(bars.some((o) => o.op === "rect" || o.op === "path") && !bars.some((o) => /amp is not defined/.test(o.text ?? "")), "graph_bars valueEquation sees document vars");

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS — document vars reach graph equations (capability-gated docVars injection)");
