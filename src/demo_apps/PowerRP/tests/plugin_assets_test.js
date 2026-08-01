/**
 * PLUGIN ASSET tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/plugin_assets_test.js
 *
 * A plugin asset is a widget delivered as a project asset (`*.plugin.js`),
 * evaluated in a sandbox (core/plugin_assets.js) rather than imported. Five
 * things are under test, in the order they matter:
 *
 *   (1) THE ESCAPE BATTERY. The jail is a SECURITY BOUNDARY — a shared project's
 *       plugin runs in the viewer's browser — so every escape route this round
 *       actually MEASURED is pinned here as a regression test. Three of them were
 *       live breaches during development, not hypotheticals:
 *         · `(() => {}).constructor("…")()` and its ({}/[]/""/Error/JSON)
 *           variants — every value reaches `Function` through its prototype
 *           chain, so hiding the NAME `Function` accomplished nothing.
 *         · the ASYNC and GENERATOR function constructors, which are separate
 *           intrinsics with their own `constructor` slots and survived the first
 *           fix that poisoned `Function.prototype` alone.
 *         · dynamic `import()`, which is grammar rather than an identifier, so no
 *           blocklist could ever see it — it loaded `node:fs` from inside the jail.
 *       Plus the DEFERRED form of each: an innocent-looking source that puts the
 *       escape inside `emit`, which runs long after load. That one is why the
 *       block travels with the plugin's hooks.
 *   (2) LOUD REFUSAL, including the type-COLLISION refusal — the rule that stops
 *       a stranger's deck from repainting every `rect` in a document.
 *   (3) LOAD ORDER vs REPAIR. The order is load-bearing: repairedDocument drops
 *       items whose type nothing claims, so a document using an asset type,
 *       repaired before the asset registers, LOSES those items. Both directions
 *       are pinned.
 *   (4) THE PROOF SHAPES, against analytic geometry rather than a golden string:
 *       the superellipse's area at n = 1/2/4 (diamond / exact ellipse / squircle)
 *       and the gear's per-tooth hit test.
 *   (5) MIGRATION PARITY. plugins/demo/showcase.js ported to an asset must emit
 *       byte-identical IR across a state matrix. This is the dogfood test: it is
 *       the only one that can show the interface is INCOMPLETE, because the widget
 *       predates the interface.
 *
 * The plugin-asset SOURCES read here are the committed ones in plugin_assets/ —
 * the same files plugin_assets/seed_into_project.sh copies into a project — so
 * this suite tests what actually ships, not an inline fixture that could drift.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluatePluginSource, loadPluginAsset, registerPluginAssets, pluginShapeProblem,
  isPluginAssetName, forbiddenSyntaxProblem, strippedComments, seededRandom,
  jailedPluginHooks, PLUGIN_ASSET_SUFFIX,
} from "../core/plugin_assets.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll, registerPlugins } from "../plugins/index.js";
import { repairedDocument, newDocument } from "../core/document.js";
import { evaluateState, isEquationValue, numericPropertyPaths } from "../core/expressions.js";
import { demoShowcasePlugin } from "../plugins/demo/showcase.js";
import { pluginAssetEntries } from "../web/pluginAssetLoader.js";

const here = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = resolve(here, "../plugin_assets");
const assetSource = (name) => readFileSync(resolve(ASSET_DIR, name), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** A minimal VALID plugin source, for tests about everything except the plugin. */
const okSource = (type = "t_widget") =>
  `return {type: "${type}", title: "T", capabilities: {bbox: true}, defaults: {type: "${type}", x: 0, y: 0, w: 10, h: 10}, emit: () => []};`;

/** A registry with the whole built-in roster — what a real load faces. */
function builtinRegistry() {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  return registry;
}

// ── (1) THE ESCAPE BATTERY ───────────────────────────────────────────────────

test("jail: the host globals are unreachable by name", () => {
  for (const name of ["window", "document", "globalThis", "process", "fetch", "Date", "navigator", "performance", "setTimeout", "XMLHttpRequest", "require", "eval", "Function", "Reflect"])
    assert.equal(evaluatePluginSource(`return typeof ${name};`, "t"), "undefined", `${name} must not resolve`);
});

test("jail: Math.random is excised, and `random` is a SEEDED factory", () => {
  assert.equal(evaluatePluginSource("return typeof Math.random;", "t"), "undefined");
  assert.equal(evaluatePluginSource("return typeof Math.sin;", "t"), "function");
  // The seeded generator IS available, and is deterministic — the bargain that
  // lets a scattering widget render identically on every machine and every shard.
  assert.equal(evaluatePluginSource("return random(7)() === random(7)();", "t"), true);
  assert.equal(seededRandom(7)(), seededRandom(7)());
  assert.notEqual(seededRandom(1)(), seededRandom(2)());
});

test("jail: the Function-constructor escape is BLOCKED from every value's prototype chain", () => {
  // Each of these returned a live host value before the fix. `.constructor` is
  // reachable from every value in the language, so this is the route that made a
  // name-only blocklist insufficient.
  const routes = [
    "(() => {}).constructor",
    "({}).constructor.constructor",
    "[].constructor.constructor",
    "''.constructor.constructor",
    "(new Error()).constructor.constructor",
    "JSON.constructor.constructor",
    "(function () { return arguments.callee.constructor; })()",
  ];
  for (const route of routes)
    assert.throws(
      () => evaluatePluginSource(`return ${route}("return typeof process")();`, "t"),
      /may not compile code at runtime|is not a function|undefined/,
      `escape route must be blocked: ${route}`,
    );
});

test("jail: the ASYNC and GENERATOR function constructors are blocked too", () => {
  // These are DISTINCT intrinsics from Function, with their own `constructor`
  // slots, and they survived the first fix (which poisoned Function.prototype
  // alone). They are unreachable by name, which is exactly why they were missed.
  for (const route of ["(async () => {}).constructor", "(function* () {}).constructor", "(async function* () {}).constructor"])
    assert.throws(
      () => evaluatePluginSource(`return ${route}("return 1")();`, "t"),
      /may not compile code at runtime/,
      `escape route must be blocked: ${route}`,
    );
});

test("jail: dynamic import() is refused BEFORE compiling (grammar, not a name)", () => {
  // `import(...)` is an operator, so `with(scope)` never sees a lookup to gate.
  // It loaded node:fs from inside the jail before this refusal existed.
  assert.throws(() => evaluatePluginSource("return import('node:fs');", "t"), /may not load modules/);
  assert.throws(() => evaluatePluginSource("return import.meta;", "t"), /may not load modules/);
  assert.equal(forbiddenSyntaxProblem("return 1;"), null);
  // A COMMENT mentioning it is fine — the scan reads comment-stripped code, which
  // the template forced (it documents the rule by naming the syntax).
  assert.equal(forbiddenSyntaxProblem("// do not use import() here\nreturn 1;"), null);
  assert.match(strippedComments("a // import(x)\nb"), /^a\s*\nb$/);
});

test("jail: prototype reflection is unavailable (Object is a reduced facade)", () => {
  // With the real `Object` in scope, Object.getPrototypeOf(() => {}).constructor
  // IS Function — a measured breach. The facade keeps the data helpers only.
  assert.equal(evaluatePluginSource("return typeof Object.getPrototypeOf;", "t"), "undefined");
  assert.equal(evaluatePluginSource("return typeof Object.defineProperty;", "t"), "undefined");
  assert.equal(evaluatePluginSource("return typeof Object.setPrototypeOf;", "t"), "undefined");
  assert.equal(evaluatePluginSource("return typeof Symbol;", "t"), "undefined");
  // …while what a declarative plugin actually needs still works.
  assert.deepEqual(evaluatePluginSource("return Object.keys({a: 1, b: 2});", "t"), ["a", "b"]);
  assert.deepEqual(evaluatePluginSource("return Object.assign({}, {a: 1});", "t"), { a: 1 });
});

test("jail: the DEFERRED escape (inside emit, called after load) is blocked", () => {
  // The load-time window cannot cover this: emit runs thousands of times per
  // session, long after evaluation returned. A source that looks innocent puts
  // the escape in a hook. Measured: it worked, until the block travelled with the
  // hooks (jailedPluginHooks).
  for (const route of ["(() => {}).constructor", "(async () => {}).constructor"]) {
    const plugin = loadPluginAsset(
      `return {type: "d_w", title: "D", capabilities: {bbox: true}, defaults: {type: "d_w"}, emit() { return ${route}("return typeof process")(); }};`,
      "deferred.plugin.js", new Set(),
    );
    // The block still fires — but emit is the RENDER path, so the jail degrades
    // it to the loud in-widget error box instead of killing the frame for every
    // other widget (the donut-degeneracy lesson). The escape must not succeed:
    // the ops carry the block's message, never the probed `typeof process`.
    const ops = plugin.emit({ w: 200, h: 100 });
    assert.equal(ops[0].op, "rect", "emit degrades to the error-box ops");
    assert.match(ops[1].text, /may not compile code at runtime/);
    assert.doesNotMatch(ops[1].text, /object|string/, "the escape's own result must never appear");
  }
});

test("jail: the host's OWN intrinsics are restored after evaluation (and after a throw)", () => {
  // The block mutates a global prototype, so a leak would break the app's own
  // dynamic imports and any library using the Function constructor.
  const before = Function.prototype.constructor;
  evaluatePluginSource("return 1;", "t");
  assert.equal(Function.prototype.constructor, before);
  assert.throws(() => evaluatePluginSource("throw new Error('boom');", "t"));
  assert.equal(Function.prototype.constructor, before, "must restore even when the source throws");
  assert.equal(Object.getPrototypeOf(async () => {}).constructor.name, "AsyncFunction");
  // And through a jailed HOOK that throws. A throwing emit returns error-box
  // ops (it must not kill the render), but the restore must STILL have run.
  const plugin = jailedPluginHooks({ type: "x", emit() { throw new Error("nope"); } });
  assert.match(plugin.emit()[1].text, /nope/);
  assert.equal(Function.prototype.constructor, before);
  // A NON-emit hook keeps throwing — callers handle those individually.
  const hooks = jailedPluginHooks({ type: "x", anchors() { throw new Error("still throws"); } });
  assert.throws(() => hooks.anchors(), /still throws/);
  assert.equal(Function.prototype.constructor, before);
});

test("jail: the plugin API is present (props/ir/anchors), and nothing else is", () => {
  for (const name of ["props", "bundle", "defaults", "customProps", "rect", "path", "ellipse", "applyEffects", "standardBBoxAnchors", "effectsCullMargin", "T", "G", "shapes", "ir"])
    assert.notEqual(evaluatePluginSource(`return typeof ${name};`, "t"), "undefined", `${name} must be available`);
  // An unknown name is undefined rather than a ReferenceError — the equation
  // jail's own behavior, kept identical so the two read as one system.
  assert.equal(evaluatePluginSource("return typeof somethingNobodyDefined;", "t"), "undefined");
});

// ── (2) LOUD REFUSAL ─────────────────────────────────────────────────────────

test("refusal: a type COLLISION with a built-in is refused, never shadowed", () => {
  const registry = builtinRegistry();
  const { loaded, reports } = registerPluginAssets(registry, [{
    name: "evil.plugin.js",
    source: `return {type: "rect", title: "Not A Rect", capabilities: {bbox: true}, defaults: {type: "rect"}, emit: () => []};`,
  }]);
  assert.deepEqual(loaded, []);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /already registered/);
  assert.match(reports[0], /evil\.plugin\.js/, "the report must name the offending file");
  // The built-in is UNTOUCHED — this is the property that matters.
  assert.equal(registry.get("rect").title, "Rectangle");
});

test("refusal: two assets declaring the SAME type — the second is refused", () => {
  const registry = builtinRegistry();
  const { loaded, reports } = registerPluginAssets(registry, [
    { name: "a.plugin.js", source: okSource("twin") },
    { name: "b.plugin.js", source: okSource("twin") },
  ]);
  assert.deepEqual(loaded, ["twin"]);
  assert.match(reports[0], /b\.plugin\.js/);
});

test("refusal: malformed plugins each fail with a reason naming the problem", () => {
  const cases = [
    ["return 42;", /not a plugin object/],
    ["return null;", /not a plugin object/],
    ["return [];", /an array/],
    [`return {type: "a", title: "A", capabilities: {}, defaults: {type: "a"}};`, /missing "emit"/],
    [`return {type: "a", title: "A", capabilities: {}, defaults: {type: "a"}, emit: 5};`, /emit is a number/],
    [`return {type: "A Bad Name", title: "A", capabilities: {}, defaults: {}, emit: () => []};`, /lower_snake_case/],
    [`return {type: "a", title: "A", capabilities: {}, defaults: {type: "b"}, emit: () => []};`, /would be created with the wrong type/],
    ["", /source is empty/],
    ["return {", /will not compile/],
    ["throw new Error('kaboom');", /threw while evaluating/],
  ];
  for (const [source, pattern] of cases)
    assert.throws(() => loadPluginAsset(source, "bad.plugin.js", new Set()), pattern, `source must be refused: ${source.slice(0, 40)}`);
});

test("refusal: `commands` is refused — a command's run(app) gets the live editor", () => {
  // The one capability the sandbox exists to withhold. A plugin DESCRIBES a
  // widget; it does not drive the app.
  const problem = pluginShapeProblem({
    type: "a", title: "A", capabilities: {}, defaults: { type: "a" }, emit: () => [],
    commands: [{ id: "x", title: "X", run: () => {} }],
  });
  assert.match(problem, /may not/);
  assert.match(problem, /live app/);
});

test("refusal: ONE broken asset does not stop the others (partial success, nothing swallowed)", () => {
  // Refusing them all would cascade: the document may depend on the good ones'
  // types, and repair would then purge those items too.
  const registry = builtinRegistry();
  const { loaded, reports } = registerPluginAssets(registry, [
    { name: "good1.plugin.js", source: okSource("good_one") },
    { name: "broken.plugin.js", source: "return {oops: true};" },
    { name: "good2.plugin.js", source: okSource("good_two") },
  ]);
  assert.deepEqual(loaded, ["good_one", "good_two"]);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /broken\.plugin\.js/);
});

test("naming: only the compound *.plugin.js suffix marks a plugin asset", () => {
  assert.equal(PLUGIN_ASSET_SUFFIX, ".plugin.js");
  assert.equal(isPluginAssetName("gear.plugin.js"), true);
  assert.equal(isPluginAssetName("helper.js"), false, "a plain .js asset is NOT a widget");
  assert.equal(isPluginAssetName("logo.png"), false);
  assert.equal(isPluginAssetName(null), false);
  // The app-side filter is name-SORTED, so which of two colliding assets is
  // refused does not depend on the storage adapter's listing order.
  assert.deepEqual(
    pluginAssetEntries([{ name: "b.plugin.js" }, { name: "logo.png" }, { name: "a.plugin.js" }]).map((a) => a.name),
    ["a.plugin.js", "b.plugin.js"],
  );
  assert.deepEqual(pluginAssetEntries(null), []);
});

test("lifecycle: rebuilding the plugin registry must NOT re-add palette commands", () => {
  // A MEASURED BUG, found in the browser: reloadPluginAssets rebuilt the registry
  // with registerAll(registry, commands), which re-adds every plugin's palette
  // commands — and core/commands.js refuses a duplicate id. The SECOND project
  // open threw `Duplicate command id "add-rect"` and left the editor unopenable.
  // The two registries have different lifetimes: plugin TYPES are per-project,
  // palette COMMANDS are process-lifetime. registerPlugins is the types-only path.
  const commands = createCommands();
  const first = createRegistry();
  registerAll(first, commands);
  // A project switch: rebuild the TYPES against the SAME long-lived commands.
  const second = createRegistry();
  assert.doesNotThrow(() => registerPlugins(second), "a rebuild must not touch commands");
  assert.equal(second.all().length, first.all().length);
  assert.equal(second.get("rect").title, "Rectangle");
  // And the old mistake still throws, so this test is testing something.
  assert.throws(() => registerAll(createRegistry(), commands), /Duplicate command id/);
});

// ── (3) LOAD ORDER vs REPAIR ─────────────────────────────────────────────────

/** A document with one item of `type` on slide 0 — the shape repair inspects. */
function docUsing(type) {
  const doc = newDocument();
  doc.slides[0] = {
    ...doc.slides[0],
    delta: { ...doc.slides[0].delta, items: { ...doc.slides[0].delta.items, w1: { type, x: 10, y: 10, w: 50, h: 50 } } },
  };
  return doc;
}

test("load order: repairing BEFORE the asset registers DROPS the item (the hazard)", () => {
  // This is the failure the ordering exists to prevent, pinned so nobody
  // "simplifies" the await away: an unknown type is an orphan, and repair's drop
  // is a document rewrite that then gets saved back. Data loss.
  const registry = builtinRegistry();
  const { doc, reports } = repairedDocument(docUsing("superellipse"), registry);
  assert.equal(doc.slides[0].delta.items.w1, undefined, "an unregistered type is purged as an orphan");
  assert.ok(reports.some((r) => /unknown type|orphan/i.test(String(r.summary ?? r))), "the drop must be reported");
});

test("load order: registering the asset FIRST keeps the item (the fix)", () => {
  const registry = builtinRegistry();
  const { loaded } = registerPluginAssets(registry, [{ name: "superellipse.plugin.js", source: assetSource("superellipse.plugin.js") }]);
  assert.deepEqual(loaded, ["superellipse"]);
  const { doc } = repairedDocument(docUsing("superellipse"), registry);
  assert.ok(doc.slides[0].delta.items.w1, "the item survives repair once its plugin is registered");
  assert.equal(doc.slides[0].delta.items.w1.type, "superellipse");
});

// ── (4) THE PROOF SHAPES ─────────────────────────────────────────────────────

/** Pure function. Polygon area from an SVG path of M/L commands (shoelace). */
function pathArea(d) {
  const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

test("superellipse: area matches the analytic Lamé curve at n = 1, 2, 4", () => {
  const plugin = loadPluginAsset(assetSource("superellipse.plugin.js"), "superellipse.plugin.js", new Set());
  const W = 200, H = 200, a = W / 2, b = H / 2;
  // n = 1 is a diamond: exactly 2ab, and exact for a polygon sampler.
  const diamond = pathArea(plugin.emit({ ...plugin.defaults, w: W, h: H, exponent: 1 })[0].d);
  assert.ok(Math.abs(diamond - 2 * a * b) < 1, `n=1 must be the 2ab diamond, got ${diamond}`);
  // n = 2 is an exact ellipse: pi*a*b. The sampler is a 96-gon, so allow 0.2%.
  const ellipseArea = pathArea(plugin.emit({ ...plugin.defaults, w: W, h: H, exponent: 2 })[0].d);
  assert.ok(Math.abs(ellipseArea - Math.PI * a * b) / (Math.PI * a * b) < 0.002, `n=2 must be the ellipse, got ${ellipseArea}`);
  // n = 4 (the squircle) must sit strictly between the ellipse and the full box —
  // the whole reason this widget is not expressible as a rect or a circle.
  const squircle = pathArea(plugin.emit({ ...plugin.defaults, w: W, h: H, exponent: 4 })[0].d);
  assert.ok(squircle > Math.PI * a * b && squircle < W * H, `n=4 must lie between ellipse and box, got ${squircle}`);
});

test("superellipse: the silhouette touches all four edge midpoints for EVERY exponent", () => {
  // This is what makes localBounds honestly the box: changing the exponent must
  // not change the extent, or culling and band-select would read a stale rect.
  const plugin = loadPluginAsset(assetSource("superellipse.plugin.js"), "s", new Set());
  for (const exponent of [0.2, 1, 2, 4, 20, 1e6, NaN]) {
    const state = { ...plugin.defaults, w: 200, h: 120, exponent };
    const pts = [...plugin.emit(state)[0].d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    assert.ok(Math.min(...xs) < 0.01 && Math.max(...xs) > 199.99, `exponent ${exponent}: x extent`);
    assert.ok(Math.min(...ys) < 0.01 && Math.max(...ys) > 119.99, `exponent ${exponent}: y extent`);
    assert.deepEqual(plugin.localBounds(state), { x: 0, y: 0, w: 200, h: 120 });
  }
});

test("superellipse: the exponent HANDLE round-trips through constrain + apply", () => {
  // THE HANDLE-CONSTRAINT PROTOCOL: `constrain` is a pure projection declared
  // separately from `apply`, so an equation or a binding can drive the handle.
  const plugin = loadPluginAsset(assetSource("superellipse.plugin.js"), "s", new Set());
  const state = { ...plugin.defaults, w: 200, h: 200, exponent: 4 };
  const [handle] = plugin.modifierPoints(state);
  assert.equal(handle.id, "exponent");
  assert.equal(handle.shape, "triangle", "a parameter handle must not look like a resize square");
  // The handle sits where the curve crosses the 45-degree diagonal.
  const frac = Math.pow(0.5, 1 / 4);
  assert.ok(Math.abs(handle.x - (100 + 100 * frac)) < 0.01);
  // A drag far outside the box projects back INSIDE it (the constraint), and the
  // resulting exponent is monotone in the handle's diagonal distance.
  const near = handle.apply(state, handle.constrain(state, { x: 130, y: 130 }));
  const far = handle.apply(state, handle.constrain(state, { x: 195, y: 195 }));
  assert.ok(far.exponent > near.exponent, "pushing the handle outward must raise the exponent");
  for (const desired of [{ x: -500, y: -500 }, { x: 9999, y: 9999 }]) {
    const allowed = handle.constrain(state, desired);
    assert.ok(allowed.x >= 100 && allowed.x <= 200, `constrain must stay in the box: ${JSON.stringify(allowed)}`);
    assert.ok(Number.isFinite(handle.apply(state, allowed).exponent), "apply must stay finite at the extremes");
  }
});

test("superellipse: hitTest follows the CURVE, not the box", () => {
  const plugin = loadPluginAsset(assetSource("superellipse.plugin.js"), "s", new Set());
  // A diamond (n=1) must reject its box corners; the centre always hits.
  const diamond = { ...plugin.defaults, w: 200, h: 200, exponent: 1 };
  assert.equal(plugin.hitTest(diamond, 100, 100), true);
  assert.equal(plugin.hitTest(diamond, 5, 5), false, "a diamond's empty corner must not select it");
  // A near-rectangle (large n) accepts the same corner — the knob really changes
  // the silhouette, which is the point of the widget.
  assert.equal(plugin.hitTest({ ...diamond, exponent: 20 }, 5, 5), true);
  // Degenerate box: no ink, no hit (a division guard, not a bound).
  assert.equal(plugin.hitTest({ ...diamond, w: 0 }, 0, 0), false);
});

test("gear: tooth COUNT is a clamped whole number that drives the outline", () => {
  const plugin = loadPluginAsset(assetSource("gear.plugin.js"), "gear.plugin.js", new Set());
  const cmds = (teeth) => (plugin.emit({ ...plugin.defaults, w: 180, h: 180, teeth })[0].d.match(/[ML]/g) ?? []).length;
  assert.ok(cmds(24) > cmds(12) && cmds(12) > cmds(3), "more teeth must mean more outline");
  assert.equal(cmds(1000), cmds(60), "an absurd count clamps to the maximum, it does not explode");
  assert.equal(cmds(0), cmds(3), "below the minimum clamps up");
  assert.equal(cmds(11.6), cmds(12), "a fractional equation result is ROUNDED to whole teeth");
  assert.equal(cmds(NaN), cmds(12), "a NaN equation result falls back, it does not emit a broken path");
});

test("gear: hitTest is exact PER TOOTH, and the hub hole is a hole", () => {
  const plugin = loadPluginAsset(assetSource("gear.plugin.js"), "g", new Set());
  const state = { ...plugin.defaults, w: 180, h: 180, teeth: 12, toothDepth: 0.22, hub: 0.3 };
  const cx = 90, cy = 90, rTip = 90, rRoot = rTip * 0.78;
  const period = (Math.PI * 2) / 12;
  const at = (angle, r) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  const mid = (rRoot + rTip) / 2;
  // The SAME radius hits on a tooth and misses in the gap between two teeth.
  assert.equal(plugin.hitTest(state, ...at(period / 2, mid)), true, "mid-tooth must hit");
  assert.equal(plugin.hitTest(state, ...at(0.001, mid)), false, "the gap between teeth must not hit");
  assert.equal(plugin.hitTest(state, ...at(0.001, rRoot * 0.8)), true, "the gear body must hit");
  assert.equal(plugin.hitTest(state, cx + 5, cy), false, "the hub HOLE must not hit");
  assert.equal(plugin.hitTest(state, ...at(period / 2, rTip + 3)), false, "outside the tip circle must not hit");
  // The hole is drawn as a second subpath under evenodd — not a fill-coloured disc,
  // so whatever is behind the gear shows through it.
  assert.equal(plugin.emit(state)[0].fillRule, "evenodd");
  assert.equal((plugin.emit(state)[0].d.match(/M/g) ?? []).length, 2, "outline + hub subpath");
  assert.equal((plugin.emit({ ...state, hub: 0 })[0].d.match(/M/g) ?? []).length, 1, "hub 0 closes the hole");
});

test("gear: both handles round-trip and stay inside their declared ranges", () => {
  const plugin = loadPluginAsset(assetSource("gear.plugin.js"), "g", new Set());
  const state = { ...plugin.defaults, w: 180, h: 180 };
  const handles = plugin.modifierPoints(state);
  assert.deepEqual(handles.map((h) => h.id), ["toothDepth", "hub"]);
  for (const handle of handles)
    for (const desired of [{ x: -1e4, y: 0 }, { x: 1e4, y: 0 }, { x: 95, y: 95 }]) {
      const written = handle.apply(state, handle.constrain(state, desired));
      const [key, value] = Object.entries(written)[0];
      assert.ok(Number.isFinite(value), `${handle.id} must write a finite ${key}`);
      // Re-emitting with the written value must not throw (the real safety property).
      assert.doesNotThrow(() => plugin.emit({ ...state, ...written }));
    }
  // A degenerate box writes a usable value rather than dividing by zero.
  assert.doesNotThrow(() => handles[0].apply({ ...state, w: 0, h: 0 }, { x: 0, y: 0 }));
});

test("proof shapes: both register into a full built-in registry and inherit the universal bundles", () => {
  // The registry treats an asset plugin exactly like a source plugin: the
  // universal effects bundle is INJECTED (five effect rows + a cull margin the
  // author never wrote) and the Tools groups resolve. That inheritance is the
  // reason the asset format cannot rot as protocols grow.
  const registry = builtinRegistry();
  const { loaded, reports } = registerPluginAssets(registry, [
    { name: "gear.plugin.js", source: assetSource("gear.plugin.js") },
    { name: "superellipse.plugin.js", source: assetSource("superellipse.plugin.js") },
    { name: "plugin_template.plugin.js", source: assetSource("plugin_template.plugin.js") },
  ]);
  assert.deepEqual(reports, [], "the shipped assets must load with no refusals");
  assert.deepEqual(loaded, ["gear", "superellipse", "my_star"]);
  for (const type of ["gear", "superellipse"]) {
    const plugin = registry.get(type);
    assert.equal(plugin.effectsInjected, true, `${type} must inherit the universal effects bundle`);
    assert.equal(typeof plugin.defaults.softEdges, "number");
    assert.equal(typeof plugin.cullMargin, "function");
    // The claim is PARITY WITH A BUILT-IN, derived from one — not a transcription
    // of today's pool, which would have to be re-typed every time a generic tool
    // is added and says nothing about asset plugins when it is.
    assert.deepEqual(plugin.toolGroups.map((g) => g.id), registry.get("rect").toolGroups.map((g) => g.id),
      `${type}: an asset plugin must inherit exactly the tool groups a native bbox widget does`);
    assert.equal(plugin.anchors(plugin.defaults).length, 9, "the nine standard anchors");
  }
  // The TEMPLATE composes the effects bundle itself (it declares the rows and
  // calls applyEffects), so the injector correctly leaves it alone.
  assert.equal(registry.get("my_star").effectsInjected, undefined);
});

test("first-class: an asset plugin's knobs are equation-bindable through the SAME engine", () => {
  // The claim that a plugin asset is not a second-class widget has to be checked,
  // not asserted. Nothing was added to core/expressions.js for these: a knob
  // declared by a sandboxed plugin is ordinary number state, so `= self.w / 10`,
  // a bare arithmetic equation, and a document VARIABLE all resolve on it exactly
  // as they do for a built-in.
  const registry = builtinRegistry();
  registerPluginAssets(registry, [{ name: "gear.plugin.js", source: assetSource("gear.plugin.js") }]);
  const gear = registry.get("gear");
  const evaluated = (item, vars = {}) => evaluateState({ items: { g1: { ...gear.defaults, id: "g1", ...item } }, vars }, registry).state.items.g1;
  assert.equal(evaluated({ w: 200, h: 200, teeth: "= self.w / 10" }).teeth, 20, "a self.* reference must resolve");
  assert.equal(evaluated({ teeth: "= 6 * 2" }).teeth, 12, "a bare arithmetic equation must resolve");
  assert.equal(evaluated({ teeth: "= n_teeth" }, { n_teeth: 18 }).teeth, 18, "a document variable must drive it");
  // And the generic gates SEE the knob, which is what makes the Inspector offer
  // keyframing and equation editing on it with no per-widget registration.
  assert.equal(isEquationValue(gear, ["teeth"], "= self.w / 10"), true);
  assert.ok(numericPropertyPaths(gear).includes("teeth"), "the custom knob must be a numeric slot");
});

// ── (5) MIGRATION PARITY (the dogfood test) ──────────────────────────────────

test("migration: the ported showcase widget is IR-IDENTICAL to the built-in", () => {
  // The only test here that can fail honestly: showcase.js predates the asset
  // interface, so if the interface were missing something, this is where it shows.
  const ported = loadPluginAsset(assetSource("demo_showcase_asset.plugin.js"), "demo_showcase_asset.plugin.js", new Set());
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const normalized = (o) => { const c = { ...o }; delete c.type; return c; };
  assert.deepEqual(normalized(ported.defaults), normalized(demoShowcasePlugin.defaults), "defaults must match (type aside)");
  assert.deepEqual(ported.inspector, demoShowcasePlugin.inspector, "the composed inspector rows must match");
  let compared = 0;
  for (const inset of [0, 5, 18, 80, 200])
    for (const w of [240, 40])
      for (const strokeWidth of [0, 2])
        for (const cornerRadius of [0, 12]) {
          const base = { ...demoShowcasePlugin.defaults, w, h: 160, inset, strokeWidth, cornerRadius };
          assert.deepEqual(
            ported.emit({ ...base, type: "demo_showcase_asset" }, null, world),
            demoShowcasePlugin.emit({ ...base, type: "demo_showcase" }, null, world),
            `IR must match at ${JSON.stringify({ inset, w, strokeWidth, cornerRadius })}`,
          );
          compared++;
        }
  assert.equal(compared, 40);
  // With an effect ON, exercising the applyEffects wrap the asset performs itself.
  const shadowed = { ...demoShowcasePlugin.defaults, shadow: { blur: 8, dx: 2, dy: 2, color: "#000000", opacity: 0.5 } };
  assert.deepEqual(
    ported.emit({ ...shadowed, type: "demo_showcase_asset" }, null, world),
    demoShowcasePlugin.emit({ ...shadowed, type: "demo_showcase" }, null, world),
  );
  assert.deepEqual(ported.cullMargin(ported.defaults), demoShowcasePlugin.cullMargin(demoShowcasePlugin.defaults));
  assert.deepEqual(ported.anchors(ported.defaults), demoShowcasePlugin.anchors(demoShowcasePlugin.defaults));
});

test("migration: the port and the built-in coexist, and neither shadows the other", () => {
  // A port cannot reuse the original's type (the collision refusal is a feature),
  // which is also what lets the parity assertion above exist at all.
  const registry = builtinRegistry();
  const { loaded, reports } = registerPluginAssets(registry, [{ name: "demo_showcase_asset.plugin.js", source: assetSource("demo_showcase_asset.plugin.js") }]);
  assert.deepEqual(reports, []);
  assert.deepEqual(loaded, ["demo_showcase_asset"]);
  assert.equal(registry.get("demo_showcase").title, "Demo Showcase");
  assert.equal(registry.get("demo_showcase_asset").title, "Demo Showcase (asset)");
});

console.log(`\n${passed} tests passed`);
