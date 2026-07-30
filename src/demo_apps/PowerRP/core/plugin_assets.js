/**
 * PLUGIN ASSETS — a widget plugin that is a PROJECT ASSET, not a source file.
 *
 * ── THE PROBLEM (user ruling, verbatim) ──────────────────────────────────────
 * "could we have a subset of widgets that could be literally just assets,
 * plugins, and then refactor our code base so that a lot of them are actually
 * plugins as assets? That way, even if it is statically hosted, we could still
 * have Claude help vibe code things for it… a project somebody does on their
 * computer could be uploaded to the server, and even if their Claude decides to
 * make a custom widget plugin as an asset, they can use it. Some examples would
 * be new kinds of shapes that are parameterized in different ways, or new GLSL
 * materials."
 *
 * Until now, a new widget meant editing `plugins/index.js` — a SOURCE change, so
 * it needed a checkout, a build and a deploy. That closes the door on the two
 * cases the ruling names: a statically-hosted editor (no server to rebuild) and
 * a shared project (the recipient did not author, and cannot rebuild, the deck).
 * A PLUGIN ASSET moves the widget INTO the document's own asset folder: a file
 * named `*.plugin.js` that TRAVELS WITH THE PROJECT (the zip round-trip carries
 * assets/, so the widget rides along), and registers at load time.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────────
 * An asset's source is a JS *expression body* whose value is the DECLARATIVE
 * plugin object core/registry.js's docblock specifies — the SAME object a file in
 * plugins/ exports, with nothing added and nothing withheld:
 *
 *     const R = 8;                             // ordinary statements are fine
 *     return {
 *       type: "my_squircle", title: "Squircle",
 *       capabilities: {bbox: true, transform: true, resizable: true},
 *       defaults: {type: "my_squircle", x: 0, y: 0, w: 100, h: 100, ...},
 *       inspector: [...props("fill"), ...],
 *       emit(s) { return [path({d: ..., fill: s.fill})]; },
 *       anchors: standardBBoxAnchors,
 *     };
 *
 * So a plugin asset is not a second plugin format — it is the ONE format,
 * delivered by a different route. That is deliberate: a divergent "asset plugin
 * API" would rot the moment a protocol (BOUNDS, HANDLE CONSTRAINTS, the
 * universal effects bundle) grew, and the whole point of the ruling is that a
 * user's Claude can write one by reading the registry docblock it already reads.
 * A TEMPLATE with exhaustive comments — the file a user hands to their Claude —
 * lives at `assets/plugin_template.plugin.js` (committed under
 * `plugin_assets/plugin_template.plugin.js` and copied into a project's assets/).
 *
 * ── THE JAIL IS A SECURITY BOUNDARY, NOT A TIDINESS RULE ─────────────────────
 * A shared project's plugin runs IN THE VIEWER'S BROWSER, on the viewer's
 * origin, with the viewer's cookies. Someone who opens a deck a stranger mailed
 * them has consented to look at slides, NOT to run arbitrary code against their
 * session. So the source is evaluated in the SAME jail discipline
 * core/expressions.js already established for `=` equations, reusing its
 * mechanism rather than forking a second one that could drift out of agreement:
 *
 *   - `new Function("scope", "with(scope){ ... }")` — no lexical access to this
 *     module's or any importer's bindings.
 *   - a Proxy scope whose `has` trap returns TRUE FOR EVERY NAME, so every free
 *     identifier routes through `get` and NOTHING falls through to the real
 *     globals. This is the load-bearing half: without it, `with` would consult
 *     the global object for any name the proxy lacked.
 *   - core/expressions.js `BLOCKED_GLOBALS` (Date, window, globalThis, global,
 *     fetch, XMLHttpRequest, WebSocket, process, require, eval, Function,
 *     import, document, navigator, performance, setTimeout, setInterval,
 *     queueMicrotask, Reflect) resolve to `undefined`, so a member use throws
 *     LOUDLY instead of reaching the host. IMPORTED, never re-listed: one list,
 *     so a name added there for the equation evaluator protects this path too.
 *   - `Math` is core/expressions.js `SAFE_MATH` (Math WITHOUT random) and
 *     randomness is only available SEEDED, so a plugin asset is subject to the
 *     same determinism bargain every widget is (see CLAUDE.md's three kinds of
 *     state — a widget that reads a wall clock breaks frame-range sharding).
 *
 * A NAME BLOCKLIST ALONE WAS NOT ENOUGH, and this is the part worth reading
 * before touching any of it. Three routes bypassed the list entirely, all three
 * MEASURED as live breaches while this module was being written — each returned a
 * real host value from inside the jail, and each is now pinned by an escape
 * battery in tests/plugin_assets_test.js:
 *
 *   1. THE PROTOTYPE CHAIN. `(() => {}).constructor` IS `Function`, and every
 *      value in JS reaches it — `({}).constructor.constructor`, `""`, `[]`,
 *      `JSON`, an `Error`, `arguments.callee`. Hiding the NAME `Function`
 *      accomplished nothing at all. Closed by blockDynamicCompilation(), which
 *      makes `Function.prototype.constructor` THROW for the duration.
 *   2. FOUR CONSTRUCTORS, NOT ONE. The ASYNC and GENERATOR function constructors
 *      are separate intrinsics with their own `constructor` slots, so poisoning
 *      `Function.prototype` alone left `(async () => {}).constructor` open. They
 *      are unreachable BY NAME, which is exactly why they were missed.
 *   3. GRAMMAR, NOT IDENTIFIERS. `import(...)` is an operator, so `with(scope)`
 *      never sees a lookup to gate — it loaded `node:fs` from inside the jail
 *      while "import" sat in BLOCKED_GLOBALS. Closed by a pre-compile source
 *      check (FORBIDDEN_SYNTAX), the one place text scanning is used here.
 *
 * And a fourth, which is about WHEN rather than what: the DEFERRED escape. A
 * source that is innocent at load can put the escape inside `emit`, which runs
 * thousands of times per session after the load-time window has closed. That is
 * why the block travels with the plugin's hooks (jailedPluginHooks) instead of
 * wrapping evaluation only.
 *
 * WHAT THE JAIL DOES NOT CLAIM. This is a capability fence, not a VM: the plugin
 * runs on the main thread and can still spin the CPU, throw, or return nonsense.
 * It cannot NAME a host capability, which is what stops exfiltration and
 * persistence. Blocking denial-of-service would need a Worker, and a Worker
 * cannot return a live `emit` function — so that is a deliberate, documented
 * bound, not an oversight. `import`/`require` are blocked, so the API a plugin
 * may use is exactly what HOST_MODULES below hands it. The other known bound is
 * named at jailedPluginHooks: a NESTED callback (a `modifierPoints[].apply`)
 * stored at load and invoked later runs outside the block, because wrapping it
 * would mean deep-walking every hook's return value on every frame.
 *
 * ── VALIDATION IS LOUD, AND REFUSAL IS THE POINT ─────────────────────────────
 * A plugin asset that is wrong must fail with a message naming the file and the
 * problem, never register a half-widget that paints holes later. In particular a
 * type name that COLLIDES with a built-in is REFUSED rather than shadowing it:
 * silently replacing `rect` in a shared deck would let an asset repaint every
 * rectangle in a document its author never saw.
 *
 * DOM-free and bare-node testable (tests/plugin_assets_test.js), like the rest of
 * core/.
 */

import { BLOCKED_GLOBALS, SAFE_MATH } from "./expressions.js";
import { standardBBoxAnchors } from "./derive.js";
import * as properties from "./properties.js";
import * as shapes from "./shapes.js";
import * as transform from "./transform.js";
import * as geometry from "./geometry.js";
import * as ir from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** The asset-filename suffix that MAKES a file a plugin asset. Checked by the
 *  loader and by the server's asset-kind classifier (server.py PLUGIN_SUFFIX) —
 *  exported so no consumer re-spells it. */
export const PLUGIN_ASSET_SUFFIX = ".plugin.js";

/**
 * Pure function. Is this asset filename a plugin asset?
 *
 * @param {string} filename - an asset basename
 * @returns {boolean}
 *
 * @example isPluginAssetName("squircle.plugin.js") // true
 * @example isPluginAssetName("logo.png")           // false
 * @example isPluginAssetName("notes.js")           // false (a bare .js is NOT a plugin)
 */
export function isPluginAssetName(filename) {
  return typeof filename === "string" && filename.endsWith(PLUGIN_ASSET_SUFFIX);
}

/**
 * THE PLUGIN-ASSET API — every module binding a sandboxed plugin may name.
 *
 * A plugin asset cannot `import`, so this object IS its whole library, and its
 * membership is a deliberate decision rather than "whatever core exports": each
 * entry is DOM-free, side-effect-free at call time, and already part of the
 * declarative plugin vocabulary a file in plugins/ uses. Nothing here can reach
 * the document, the app shell, the network or the registry — a plugin DESCRIBES a
 * widget, it does not drive the editor. (That is also why `commands` on a plugin
 * asset is refused below: a command receives the live `app`.)
 *
 * Namespaced modules (`T`, `G`, `ir`, `shapes`) are exposed as whole objects
 * because that is how plugins/ files already spell them (`import * as T from
 * "../core/transform.js"`), so a template's code copies across unchanged.
 */
const HOST_MODULES = Object.freeze({
  // The shared PROPERTY REGISTRY — how an inspector row set is composed.
  props: properties.props,
  bundle: properties.bundle,
  bundleNestedDefaults: properties.bundleNestedDefaults,
  defaults: properties.defaults,
  customProps: properties.customProps,
  STROKE_TRIM_KEYS: properties.STROKE_TRIM_KEYS,
  // The display-list IR (the render API) + the universal effects bundle.
  ir,
  rect: ir.rect,
  ellipse: ir.ellipse,
  polygon: ir.polygon,
  polyline: ir.polyline,
  path: ir.path,
  text: ir.text,
  applyEffects,
  effectsCullMargin,
  // Geometry / anchors helpers a shape widget needs.
  standardBBoxAnchors,
  shapes,
  T: transform,
  G: geometry,
});

/**
 * Names a plugin asset may reference that are NOT host modules: the determinism
 * host (SAFE_MATH, a seeded random) plus the JS built-ins a declarative object
 * legitimately needs. `Function`/`eval`/`Reflect` are absent BY DESIGN (they are
 * in BLOCKED_GLOBALS) — a jailed source must not be able to compile a second,
 * unjailed one.
 */
const SAFE_BUILTINS = Object.freeze({
  Math: SAFE_MATH, // no random — determinism (see CLAUDE.md's three kinds of state)
  JSON, Array, String, Number, Boolean, Map, Set,
  isNaN, isFinite, parseFloat, parseInt, Error, TypeError, RangeError,
  NaN, Infinity, undefined: undefined,
  console: Object.freeze({ log: console.log, warn: console.warn, error: console.error }), // loud reporting, the one host effect a plugin may have
  // `Object` IS EXPOSED, but as a REDUCED facade rather than the real
  // constructor. THIS WAS A MEASURED BREACH, not a precaution: with the genuine
  // `Object` in scope, `Object.getPrototypeOf(() => {}).constructor` is
  // `Function`, so a plugin could compile unjailed code and read `process` —
  // proven by tests/plugin_assets_test.js's escape battery. Reflection over the
  // prototype chain (getPrototypeOf / setPrototypeOf / defineProperty /
  // getOwnPropertyDescriptor) is the whole route, and a declarative plugin has no
  // use for any of it, so the facade carries only the data helpers one needs.
  Object: Object.freeze({
    keys: Object.keys, values: Object.values, entries: Object.entries,
    assign: (...a) => Object.assign(...a), freeze: Object.freeze,
    fromEntries: Object.fromEntries,
    hasOwn: (o, k) => Object.prototype.hasOwnProperty.call(o, k),
  }),
  // `Symbol` is withheld for the same structural reason: Symbol.toPrimitive /
  // Symbol.iterator are how a plugin's returned object could hook host code that
  // later coerces it, and no declarative plugin needs to mint one.
});

/**
 * Pure function. A deterministic seeded PRNG (mulberry32) — the ONLY randomness a
 * plugin asset can reach, mirroring core/expressions.js's seeded `random`. Given
 * a seed the sequence is fixed, so a widget that scatters dots renders the same
 * pixels on every machine and every frame of a sharded export.
 *
 * @param {number} seed - any integer
 * @returns {function(): number} successive values in [0, 1)
 *
 * @example seededRandom(7)() === seededRandom(7)() // true (same seed ⇒ same first value)
 * @example seededRandom(1)() === seededRandom(2)() // false (a different seed diverges)
 * @example seededRandom(3)() >= 0 && seededRandom(3)() < 1 // true (values land in [0, 1))
 */
export function seededRandom(seed) {
  let a = (Number(seed) | 0) + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * SYNTAX the scope proxy structurally cannot gate, so it is refused BEFORE
 * compiling. A blocklist of NAMES only works on things that are identifier
 * lookups; these are grammar, and `with(scope)` never sees them:
 *
 *   `import(...)`   — dynamic import is an OPERATOR, not a reference to a binding
 *                     named "import". MEASURED BREACH: it loaded `node:fs` from
 *                     inside the jail while "import" sat in BLOCKED_GLOBALS.
 *   `import.meta`   — already a compile error inside `new Function` (not a
 *                     module), but rejected here too so the message names the
 *                     rule rather than leaking V8's phrasing.
 *
 * A SOURCE-TEXT CHECK IS A WEAK INSTRUMENT and this is the only place one is
 * used. It is applied to a COMMENT-STRIPPED copy of the source, which the
 * template forced: `plugin_template.plugin.js` documents the rule by naming
 * `import()` in its own header, so a raw-text scan refused the very file whose
 * job is to be copied. Stripping comments is also the strictly safer direction —
 * a comment cannot execute, so ignoring one can never admit a real escape, while
 * scanning one produces exactly this false refusal.
 *
 * STRING LITERALS ARE STILL SCANNED, deliberately: distinguishing a string from
 * code needs a real tokenizer, and a plugin that merely mentions the word inside
 * a string gets a loud, fixable refusal — the safe direction to err in.
 */
const FORBIDDEN_SYNTAX = [
  [/\bimport\s*[(.]/, "dynamic `import()` / `import.meta` — a plugin asset's whole API is what the host hands it (see HOST_MODULES); it may not load modules"],
];

/**
 * Pure function. The source with `//` and block comments blanked out, so a
 * FORBIDDEN_SYNTAX scan reads only code. Newlines are preserved so nothing else
 * about the text shifts.
 *
 * @param {string} source - JS text
 * @returns {string}
 *
 * @example strippedComments("a // import(x)\nb") // "a \nb"
 * @example strippedComments("x = 1; // note\ny = 2;") // "x = 1; \ny = 2;"
 */
export function strippedComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * Pure function. Why must this source be refused before it is even compiled?
 * Returns the reason, or null when it is clean.
 *
 * @param {string} source - the plugin asset's JS text
 * @returns {string|null}
 *
 * @example forbiddenSyntaxProblem("return {type: 'a'};") // null
 * @example forbiddenSyntaxProblem("return import('node:fs');").startsWith("uses dynamic") // true
 * @example forbiddenSyntaxProblem("// mentions import() in prose\nreturn 1;") // null
 */
export function forbiddenSyntaxProblem(source) {
  const code = strippedComments(source);
  for (const [pattern, why] of FORBIDDEN_SYNTAX)
    if (pattern.test(code)) return `uses ${why}`;
  return null;
}

/**
 * Command (mutates `Function.prototype.constructor`; returns its restorer).
 * THE SECOND HALF OF THE JAIL, and the one a name blocklist cannot provide.
 *
 * MEASURED BREACH, from every value the plugin can touch:
 *     (() => {}).constructor("return process")()
 *     ({}).constructor.constructor("return process")()
 *     "".constructor.constructor(...)   [].constructor.constructor(...)
 *     (function(){ return arguments.callee.constructor(...) })()
 * Every object in JS reaches `Function` through its prototype chain, so hiding
 * the NAME `Function` in BLOCKED_GLOBALS accomplishes nothing on its own — the
 * escape battery in tests/plugin_assets_test.js proved all of the above returned
 * live host values. The only fix reachable without a fresh realm (there is no
 * ShadowRealm, and a Worker cannot hand back a live `emit`) is to make
 * `Function.prototype.constructor` THROW while a plugin source runs.
 *
 * SCOPED TO THE EVALUATION AND RESTORED IN A `finally`. This mutates a global
 * prototype, so the window must be as narrow as it can be: plugin evaluation is
 * SYNCHRONOUS and happens at project-load time only. It must never wrap anything
 * that awaits — that would leave the app's own dynamic `import()` and any library
 * using the Function constructor broken for the duration. Nothing here awaits.
 *
 * @returns {function(): void} restores the original descriptor
 *
 * @example // const restore = blockDynamicCompilation();
 * //   try { ... } finally { restore(); }   ← the ONLY correct usage
 */
function blockDynamicCompilation() {
  const refuse = function () {
    throw new Error("a plugin asset may not compile code at runtime (Function constructor is blocked inside the plugin sandbox)");
  };
  // FOUR PROTOTYPES, NOT ONE. `Function.prototype` alone left two holes open,
  // both measured: `(async () => {}).constructor` and `(function* () {})
  // .constructor` are the ASYNC and GENERATOR function constructors, distinct
  // intrinsics with their own `constructor` slots, and each compiles source text
  // just as `Function` does. AsyncGeneratorFunction is the fourth. They are not
  // reachable by name (there is no global `AsyncFunction`), which is exactly why
  // they were missed — they are reached only through a value's prototype chain.
  const targets = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  const saved = targets.map((proto) => [proto, Object.getOwnPropertyDescriptor(proto, "constructor")]);
  for (const proto of targets)
    Object.defineProperty(proto, "constructor", { value: refuse, writable: true, configurable: true });
  return () => {
    for (const [proto, descriptor] of saved) Object.defineProperty(proto, "constructor", descriptor);
  };
}

/**
 * Pure function. Wraps every FUNCTION-valued hook of a loaded plugin so it runs
 * inside the compilation block too.
 *
 * WHY THIS EXISTS — the DEFERRED ESCAPE, which the load-time window cannot cover.
 * `emit` / `anchors` / `hitTest` are called thousands of times per session, long
 * after evaluation returned and the poison was restored. A plugin whose SOURCE is
 * innocent can therefore put the escape inside `emit` and reach `process` on the
 * first paint:
 *     return { emit() { return (() => {}).constructor("return process")(); } };
 * Measured: it worked. So the block has to travel with the plugin's hooks, not
 * just with its evaluation.
 *
 * ONLY TOP-LEVEL FUNCTION VALUES are wrapped, which is the whole hook surface the
 * registry protocols define (core/registry.js's docblock): emit, anchors,
 * localBounds, hitTest, closestAnchor, canSkip, cullMargin, snapFeatures,
 * modifierPoints, editPoints, effectBounds, interpolateState — plus anything a
 * later protocol adds, since this is keyed off `typeof === "function"` rather
 * than a list that would go stale. Nested functions (a `modifierPoints[].apply`)
 * are NOT wrapped here: they are returned BY a wrapped hook, so the value
 * crossing the boundary was produced under the block, and wrapping them would
 * mean deep-walking every hook's return value on every frame — a per-paint cost
 * for the same guarantee. FLAGGED as the known bound: a nested callback stored at
 * load and invoked later escapes the block. Closing it needs the hook results
 * walked, which is a measurable-cost decision, not a free one.
 *
 * @param {object} plugin - a validated plugin object from a sandboxed source
 * @returns {object} a copy whose function hooks are jailed
 *
 * @example jailedPluginHooks({type: "a", emit: () => [1]}).emit() // [1] (transparent when innocent)
 * @example typeof jailedPluginHooks({type: "a", emit: () => []}).emit // "function"
 * @example jailedPluginHooks({type: "a", title: "A"}).title // "A" (non-function values pass through)
 */
export function jailedPluginHooks(plugin) {
  const out = {};
  for (const [key, value] of Object.entries(plugin)) {
    if (typeof value !== "function") {
      out[key] = value;
      continue;
    }
    out[key] = function (...args) {
      const restore = blockDynamicCompilation();
      try {
        return value.apply(this, args);
      } finally {
        restore();
      }
    };
  }
  return out;
}

/** The scope resolver: the ONE gate every free identifier in a plugin-asset
 *  source passes through. Order matters — BLOCKED_GLOBALS is consulted before
 *  anything else so no later branch can hand back a host capability. */
function scopeGet(name) {
  if (BLOCKED_GLOBALS.has(name)) return undefined; // → member use throws loud
  if (name in SAFE_BUILTINS) return SAFE_BUILTINS[name];
  if (name in HOST_MODULES) return HOST_MODULES[name];
  if (name === "random") return seededRandom; // seeded factory, never a live PRNG
  return undefined; // an unknown name is undefined, exactly as in the equation jail
}

/**
 * Query (compiles and RUNS the given source; no I/O, no globals touched). The
 * jail: evaluate a plugin-asset source and return whatever it produced.
 *
 * The source is a FUNCTION BODY, so `return {…}` is how it yields its plugin;
 * `with(scope)` + a `has: () => true` proxy means every free identifier resolves
 * through scopeGet and NOTHING reaches the real globals (see this module's
 * docblock for why that is a security boundary and what it does not cover).
 *
 * @param {string} source - the plugin asset's JS text
 * @param {string} label - the asset name, for error messages
 * @returns {*} the source's return value (validated by the caller)
 *
 * @example evaluatePluginSource("return 1 + 1;", "x.plugin.js") // 2
 * @example evaluatePluginSource("return typeof window;", "x.plugin.js") // "undefined"
 * @example evaluatePluginSource("return typeof Math.random;", "x.plugin.js") // "undefined"
 */
export function evaluatePluginSource(source, label) {
  if (typeof source !== "string" || !source.trim())
    throw new Error(`plugin asset "${label}": source is empty`);
  const syntax = forbiddenSyntaxProblem(source);
  if (syntax) throw new Error(`plugin asset "${label}": ${syntax}`);
  const scope = new Proxy(Object.create(null), {
    // has: () => true is the load-bearing half — it blocks `with`'s fall-through
    // to the real global object for names the proxy does not define.
    has: () => true,
    get: (_t, prop) => (typeof prop === "symbol" ? undefined : scopeGet(prop)),
  });
  let fn;
  try {
    // SLOPPY MODE IS FORCED, not chosen: `with` is a syntax error under "use
    // strict", and `with` + `has: () => true` is the mechanism that blocks
    // global fall-through. core/expressions.js compiles its equations the same
    // way for the same reason. The cost is that an undeclared assignment inside
    // a plugin source writes onto the proxy scope (a no-op that goes nowhere)
    // rather than throwing — it cannot reach a real global either way, which is
    // the property that matters here.
    fn = new Function("scope", `with(scope){ ${source}\n}`);
  } catch (e) {
    throw new Error(`plugin asset "${label}": will not compile — ${e.message}`);
  }
  const restore = blockDynamicCompilation();
  try {
    return fn(scope);
  } catch (e) {
    throw new Error(`plugin asset "${label}": threw while evaluating — ${e.message}`);
  } finally {
    restore();
  }
}

/**
 * Pure function. Why is this value NOT a usable widget plugin? Returns a
 * human-readable reason, or null when it passes. Checked BEFORE the registry sees
 * it so the failure names the ASSET rather than surfacing as a mystery
 * "Plugin missing emit" from deep inside registration.
 *
 * `commands` is refused on purpose: a palette command's `run(app)` receives the
 * LIVE APP, which would hand a sandboxed plugin the whole document and the
 * network — the one capability the jail exists to withhold. A plugin asset
 * declares a widget; it does not drive the editor.
 *
 * @param {*} plugin - the value a plugin asset returned
 * @returns {string|null}
 *
 * @example pluginShapeProblem({type: "a", title: "A", capabilities: {}, defaults: {type: "a"}, emit: () => []}) // null
 * @example pluginShapeProblem(null) // "returned null, not a plugin object — a plugin asset's source must `return {type, title, capabilities, defaults, emit}`"
 * @example pluginShapeProblem({type: "a", title: "A", capabilities: {}, defaults: {type: "a"}}) // 'is missing "emit"'
 * @example pluginShapeProblem({type: "a", title: "A", capabilities: {}, defaults: {type: "b"}, emit: () => []}) // 'defaults.type is "b" but the plugin\'s type is "a" — a new item would be created with the wrong type'
 */
export function pluginShapeProblem(plugin) {
  if (plugin === null || typeof plugin !== "object" || Array.isArray(plugin))
    return `returned ${Array.isArray(plugin) ? "an array" : String(plugin)}, not a plugin object — a plugin asset's source must \`return {type, title, capabilities, defaults, emit}\``;
  for (const field of ["type", "title", "capabilities", "defaults", "emit"])
    if (!(field in plugin)) return `is missing "${field}"`;
  if (typeof plugin.type !== "string" || !/^[a-z][a-z0-9_]*$/.test(plugin.type))
    return `type ${JSON.stringify(plugin.type)} must be a lower_snake_case identifier`;
  if (typeof plugin.emit !== "function") return `emit is a ${typeof plugin.emit}, not a function`;
  if (typeof plugin.defaults !== "object" || plugin.defaults === null)
    return "defaults must be an object";
  if (plugin.defaults.type !== plugin.type)
    return `defaults.type is ${JSON.stringify(plugin.defaults.type)} but the plugin's type is ${JSON.stringify(plugin.type)} — a new item would be created with the wrong type`;
  if (plugin.commands)
    return "declares `commands`, which a plugin asset may not: a command's run(app) receives the live app, the exact capability the plugin sandbox withholds";
  return null;
}

/**
 * Query (evaluates the source). ONE plugin asset source → its validated plugin
 * object. Loud on every failure mode, each naming the asset:
 *   - the source will not compile, or throws
 *   - it returns something that is not a plugin (see pluginShapeProblem)
 *   - its `type` collides with an ALREADY-REGISTERED type (a built-in, or an
 *     earlier asset). REFUSED, never shadowed — silently replacing `rect` in a
 *     deck a stranger shared would repaint a document its author never saw.
 *
 * @param {string} source - the asset's JS text
 * @param {string} label - the asset name (error messages)
 * @param {Set<string>} takenTypes - type names already registered
 * @returns {object} the declarative plugin object
 *
 * @example loadPluginAsset("return {type:'gear', title:'Gear', capabilities:{bbox:true}, defaults:{type:'gear'}, emit:()=>[]};", "gear.plugin.js", new Set()).title // "Gear"
 * @example // loadPluginAsset("return {type:'rect', ...};", "evil.plugin.js", new Set(["rect"]))
 * //   → throws 'plugin asset "evil.plugin.js": type "rect" is already registered …'
 */
export function loadPluginAsset(source, label, takenTypes) {
  const plugin = evaluatePluginSource(source, label);
  const problem = pluginShapeProblem(plugin);
  if (problem) throw new Error(`plugin asset "${label}": ${problem}`);
  if (takenTypes.has(plugin.type))
    throw new Error(`plugin asset "${label}": type "${plugin.type}" is already registered — a plugin asset may not shadow a built-in widget or another asset (rename its type)`);
  return jailedPluginHooks(plugin); // the block travels with the hooks (deferred escape)
}

/**
 * Command (registers into `registry`; reports). Load every plugin asset in
 * `sources` and register it, returning a REPORT the caller prints — the repair
 * pipeline's contract (silent repairs, and silent refusals, are forbidden).
 *
 * PARTIAL SUCCESS IS THE DESIGNED BEHAVIOUR, and it is not a silent fallback:
 * one broken asset must not stop the other four from registering, because the
 * document may depend on them and dropping them all would cascade into a
 * document-wide orphan purge. Every failure is RETURNED as a report entry with
 * its reason; nothing is swallowed.
 *
 * @param {object} registry - a core/registry.js registry
 * @param {Array<{name: string, source: string}>} sources - the assets to load
 * @returns {{loaded: string[], reports: string[]}} registered types, and one
 *   message per refusal
 *
 * @example registerPluginAssets(createRegistry(), []) // {loaded: [], reports: []}
 * @example // registerPluginAssets(reg, [{name: "gear.plugin.js", source: "return {type:'gear',…};"}])
 * //   → {loaded: ["gear"], reports: []}   and reg.get("gear") now resolves
 * @example // a broken asset beside a good one:
 * //   → {loaded: ["gear"], reports: ['plugin asset "bad.plugin.js": is missing "emit"']}
 */
export function registerPluginAssets(registry, sources) {
  const taken = new Set(registry.all().map((p) => p.type));
  const loaded = [];
  const reports = [];
  for (const { name, source } of sources ?? []) {
    try {
      const plugin = loadPluginAsset(source, name, taken);
      registry.register(plugin);
      taken.add(plugin.type);
      loaded.push(plugin.type);
    } catch (e) {
      reports.push(e.message); // RETURNED, never swallowed — the caller prints it
    }
  }
  return { loaded, reports };
}
