/**
 * PER-ITEM VARIABLES test (manifest item 67). Bare-node.
 *
 * A widget carries its own `vars: {name: number | equation}` dict — the exact
 * structural mirror of top-level `state.vars`, one level deeper
 * (`items.<id>.vars.<name>`). This pins the load-bearing seam: SLOT COLLECTION
 * (computeEvaluatedState must walk each item's `vars` as numeric equation slots,
 * or a bare-string var sits unevaluated), plus the read grammar
 * (`self.vars.<name>`), the delta-fold tween, disjoint global/per-item
 * namespaces, the graph docVars merge, and copy/paste ref-remap survival.
 *
 * Run: node tests/item_vars_test.js
 */
import { evaluateState } from "../core/expressions.js";
import { isEquationValue, withItemVariableRenamed } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { clonedItemStates } from "../core/document.js";
import { tweenedState } from "../core/document.js";
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

const rect = (extra) => ({ active: true, type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0, ...extra });
const evalItems = (state) => evaluateState(state, registry).state.items;

// ── 1. Slot collection: an EQUATION-string per-item var is evaluated ─────────
// "=0.25*2" is a numeric equation by fiat; without the dedicated vars slot loop
// it would sit in state as the raw string and break everything reading it.
{
  const items = evalItems({ items: { a: rect({ vars: { lambda: "=0.25*2" } }) } });
  ok(items.a.vars.lambda === 0.5, `"=0.25*2" per-item var evaluates to 0.5 (got ${JSON.stringify(items.a.vars.lambda)})`);
}

// ── 2. Slot collection: a BARE-string per-item var (the panel's storage form) ─
// The global vars fiat: any string under vars is a numeric equation, no "="
// required. Mirrors it one level down.
{
  const items = evalItems({ items: { a: rect({ vars: { lambda: "0.5 + 0.25" } }) } });
  ok(items.a.vars.lambda === 0.75, `bare-string per-item var "0.5 + 0.25" evaluates to 0.75 (got ${JSON.stringify(items.a.vars.lambda)})`);
}

// ── 3. self.vars.<name> reads the item's own var (parseSelfRef prop path) ─────
{
  const items = evalItems({ items: { a: rect({ vars: { lambda: "=3" }, x: "self.vars.lambda * 10" }) } });
  ok(items.a.x === 30, `self.vars.lambda drives a property (x = lambda*10 = 30, got ${JSON.stringify(items.a.x)})`);
}

// ── 4. A per-item var may itself reference a GLOBAL var ───────────────────────
{
  const items = evalItems({ vars: { speed: 4 }, items: { a: rect({ vars: { lambda: "speed * 2" }, x: "self.vars.lambda" }) } });
  ok(items.a.x === 8, `per-item var reads a global var (speed*2 → lambda → x = 8, got ${JSON.stringify(items.a.x)})`);
}

// ── 5. DISJOINT NAMESPACES: bare `lambda` stays GLOBAL, never the per-item one ─
// The global and per-item `lambda` differ; a bare reference resolves to global.
{
  const items = evalItems({ vars: { lambda: 100 }, items: { a: rect({ vars: { lambda: "=1" }, x: "lambda", y: "self.vars.lambda" }) } });
  ok(items.a.x === 100, `bare "lambda" is the GLOBAL var (100, got ${JSON.stringify(items.a.x)})`);
  ok(items.a.y === 1, `"self.vars.lambda" is the PER-ITEM var (1, got ${JSON.stringify(items.a.y)}) — same name, no collision`);
}

// ── 6. TWEEN: a NUMBER-valued per-item var lerps across two slides ────────────
// Slide 0 creates the item with lambda=0.25; slide 1 keyframes lambda=0.75. The
// generic nested-leaf delta fold lerps it — no special-casing of `vars`.
{
  const doc = { meta: {}, slides: [
    { id: "s0", delta: { items: { a: rect({ vars: { lambda: 0.25 }, x: "self.vars.lambda * 100" }) } } },
    { id: "s1", delta: { items: { a: { vars: { lambda: 0.75 } } } } },
  ] };
  const mid = evaluateState(tweenedState(doc, 1, 0.5, registry), registry).state.items.a;
  ok(Math.abs(mid.vars.lambda - 0.5) < 1e-9, `per-item var tweens 0.25→0.75 to 0.5 at alpha 0.5 (got ${JSON.stringify(mid.vars.lambda)})`);
  ok(Math.abs(mid.x - 50) < 1e-9, `a property bound to self.vars.lambda follows the tween (x = 50, got ${JSON.stringify(mid.x)})`);
  const end = evaluateState(tweenedState(doc, 1, 1, registry), registry).state.items.a;
  ok(end.vars.lambda === 0.75 && end.x === 75, `at alpha 1 the var is the slide-1 value (0.75 → x 75, got ${JSON.stringify([end.vars.lambda, end.x])})`);
}

// ── 7. GRAPH SYNERGY: evaluated per-item vars reach the docVars merge ─────────
// The task's exact check: a graph_line whose vars hold "=0.25*2" must sample
// with lambda=0.5. Evaluated (not raw) vars must reach {...docVars, ...state.vars}.
{
  const lineDefaults = registry.get("graph_line").defaults;
  const g = { ...lineDefaults, mode: "parametric", source: "[t * lambda, t]", tStart: 0, tEnd: 1, numPoints: 8, vars: { lambda: "=0.25*2" } };
  const state = evaluateState({ items: { g } }, registry).state;
  ok(state.items.g.vars.lambda === 0.5, `graph's per-item var evaluates before derive (0.5, got ${JSON.stringify(state.items.g.vars.lambda)})`);
  const node = deriveRenderTree(state, registry).find((n) => n.id === "g");
  const ops = node.plugin.emit(node.state, null, node.world);
  ok(ops.length === 1 && ops[0].op === "path", `graph samples with the evaluated λ=0.5 (emits a path, not a red error box; got ${ops.map((o) => o.op).join(",")})`);
  // The merge itself: node.state.vars.lambda is the evaluated number the plugin spreads over docVars.
  ok(node.state.vars.lambda === 0.5, `node.state carries the evaluated per-item var to the {...docVars, ...state.vars} merge (0.5, got ${JSON.stringify(node.state.vars.lambda)})`);
}

// ── 8. isEquationValue honors the vars fiat (the paste/rename walk predicate) ──
{
  const plug = registry.get("rect");
  ok(isEquationValue(plug, ["vars", "lambda"], "@b.x") === true, `a bare cross-item ref in a per-item var IS an equation (paste-remap can see it)`);
  ok(isEquationValue(plug, ["vars", "lambda"], "0.5") === true, `a bare numeric per-item var IS an equation slot`);
  ok(isEquationValue(plug, ["name"], "Box") === false, `a plain non-vars string is still NOT an equation (fiat is scoped to vars)`);
}

// ── 9. COPY/PASTE ref-remap: per-item vars survive item duplication ──────────
// clonedItemStates walks each item's equation slots (isEquationValue gate) and
// re-points @id refs. A self.vars ref is identity-stable (no @id) → untouched;
// a cross-item ref stored INSIDE a per-item var must re-point to the clone.
{
  const states = {
    a: rect({ vars: { lambda: "=0.5" }, x: "self.vars.lambda", y: "@b.x" }),
    b: rect({ vars: { k: "@a.x" }, x: 5 }),
  };
  const idMap = new Map([["a", "A"], ["b", "B"]]);
  const { states: cloned, external } = clonedItemStates(states, idMap, registry);
  ok(cloned.A.x === "self.vars.lambda", `a cloned self.vars reference is IDENTITY-STABLE (untouched: ${JSON.stringify(cloned.A.x)})`);
  ok(cloned.A.y === "@B.x", `a normal cross-item property ref re-points to the clone (@b→@B: ${JSON.stringify(cloned.A.y)})`);
  ok(cloned.B.vars.k === "@A.x", `a cross-item ref stored INSIDE a per-item var re-points to the clone (@a→@A: ${JSON.stringify(cloned.B.vars.k)}) — this is the fiat-in-isEquationValue payoff`);
  ok(external.length === 0, `both refs were internal to the copied set (no dangling external: ${JSON.stringify(external)})`);
}

// ── 10. BACK-COMPAT: an item with NO vars key evaluates byte-identically ──────
{
  const before = rect({ x: "=2+3" });
  const items = evalItems({ items: { a: before } });
  ok(items.a.x === 5 && !("vars" in items.a), `an item without a vars dict is untouched (no vars key materialized: ${"vars" in items.a})`);
}

// ── 11. ITEM-SCOPED RENAME: dict key + self refs + cross-item refs move ──────
// The owning item's own var, a global var, and ANOTHER item's like-named var
// must be disambiguated: renaming a1's `lambda` touches ONLY a1's dotted refs.
{
  const doc = { meta: {}, slides: [{ id: "s0", delta: { items: {
    a1: rect({ vars: { lambda: 0.5 }, x: "self.vars.lambda * 2" }),
    b2: rect({ vars: { lambda: 9 }, x: "@a1.vars.lambda + self.vars.lambda", y: "lambda" }),
  }, vars: { lambda: 100 } } }] };
  const out = withItemVariableRenamed(doc, "a1", "lambda", "mu", registry);
  const d = out.slides[0].delta;
  ok(d.items.a1.vars.mu === 0.5 && !("lambda" in d.items.a1.vars), `a1's dict key lambda→mu (${JSON.stringify(d.items.a1.vars)})`);
  ok(d.items.a1.x === "self.vars.mu * 2", `a1's own self.vars.lambda → self.vars.mu (${JSON.stringify(d.items.a1.x)})`);
  ok(d.items.b2.x === "@a1.vars.mu + self.vars.lambda", `b2's CROSS ref @a1.vars.lambda→@a1.vars.mu, but b2's OWN self.vars.lambda untouched (${JSON.stringify(d.items.b2.x)})`);
  ok(d.items.b2.vars.lambda === 9, `b2's own like-named var "lambda" is UNTOUCHED (${JSON.stringify(d.items.b2.vars)})`);
  ok(d.items.b2.y === "lambda" && d.vars.lambda === 100, `the GLOBAL var "lambda" and its bare reference are UNTOUCHED (${JSON.stringify([d.items.b2.y, d.vars.lambda])})`);
  // The rename is still SEMANTICALLY valid: a1.x samples the renamed var.
  const x = evaluateState(out.slides[0].delta.items ? { items: out.slides[0].delta.items, vars: out.slides[0].delta.vars } : {}, registry).state.items.a1.x;
  ok(x === 1, `after rename a1.x still resolves (mu=0.5 → x=1, got ${JSON.stringify(x)})`);
}

// ── 12. RENAME loudness: a duplicate name throws ─────────────────────────────
{
  const doc = { meta: {}, slides: [{ id: "s0", delta: { items: { a1: rect({ vars: { lambda: 1, mu: 2 } }) } } }] };
  let threw = false;
  try { withItemVariableRenamed(doc, "a1", "lambda", "mu", registry); } catch { threw = true; }
  ok(threw, "renaming a per-item var onto an existing name of the SAME item throws (loud)");
}

console.log(failures ? `\nitem_vars: ${failures} FAILED` : "\nitem_vars: all passed");
process.exit(failures ? 1 : 0);
