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

import { reportOnce } from "./report.js";
// THE ONE ERROR AFFORDANCE, shared with the two render_gpu containment seams (the
// emit-time non-finite guard and the paint-time boundary) so a broken widget
// looks the same however it broke — see that module's docblock for the doctrine.
import { errorAffordanceIR, errorBoxExtent, throwMessage } from "./paint_containment.js";
import { BLOCKED_GLOBALS, SAFE_MATH } from "./expressions.js";
import { standardBBoxAnchors } from "./derive.js";
import * as properties from "./properties.js";
import * as shapes from "./shapes.js";
import * as transform from "./transform.js";
import * as geometry from "./geometry.js";
import * as outline from "./outline.js";
import { morphPayloadFromPaths, statePaint } from "./morph_payload.js";
import * as ir from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { DEFAULT_FONT, FONTS, fontOptions } from "../render_gpu/fonts.js";
import { ensureTextAsset, getTextAsset, textAssetStatus, textAssetError } from "../render_gpu/gpu/text_asset_registry.js";

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
 * Pure function. A plugin-asset filename that is not in `existing`, de-collided by
 * appending " 2", " 3", … to the STEM — i.e. the part before `.plugin.js`.
 *
 * WHY THIS EXISTS INSTEAD OF assetRef.uniqueAssetName, which already de-collides
 * asset names: that one splits at the LAST dot, so "clock_digital.plugin.js"
 * becomes "clock_digital.plugin 2.js" — which `isPluginAssetName` REJECTS. The copy
 * would be stored, listed and thumbnailed as an ordinary .js file and would silently
 * stop being a widget: the loader skips it, its type never registers, and any item
 * using that type becomes an orphan that repair DROPS. A two-dot suffix needs a
 * suffix-aware de-collide, so the rule lives here beside the suffix it protects.
 *
 * @param {string} filename - a plugin-asset basename (must end in PLUGIN_ASSET_SUFFIX)
 * @param {Iterable<string>} existing - names already taken
 * @returns {string} a free name, still ending in PLUGIN_ASSET_SUFFIX
 *
 * @example
 * // Free already ⇒ unchanged.
 * uniquePluginAssetName("gear.plugin.js", [])
 * // => "gear.plugin.js"
 * @example
 * // Taken ⇒ the STEM is numbered, and the double suffix survives intact
 * // (contrast uniqueAssetName, which would say "clock_digital.plugin 2.js").
 * uniquePluginAssetName("clock_digital.plugin.js", ["clock_digital.plugin.js"])
 * // => "clock_digital 2.plugin.js"
 * @example
 * // Counts past every taken variant.
 * uniquePluginAssetName("donut.plugin.js", ["donut.plugin.js", "donut 2.plugin.js"])
 * // => "donut 3.plugin.js"
 */
export function uniquePluginAssetName(filename, existing) {
  if (!isPluginAssetName(filename))
    throw new Error(`uniquePluginAssetName: "${filename}" is not a plugin asset (expected a name ending in "${PLUGIN_ASSET_SUFFIX}")`);
  const taken = new Set(existing);
  if (!taken.has(filename)) return filename;
  const stem = filename.slice(0, -PLUGIN_ASSET_SUFFIX.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${PLUGIN_ASSET_SUFFIX}`;
    if (!taken.has(candidate)) return candidate;
  }
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
  // The two lists travel TOGETHER — a plugin asset that splices the trim rows
  // splices these too, exactly as the nine in-repo plugins do
  // (tests/stroke_join_keys_test.js gates that pairing rather than trusting it).
  STROKE_JOIN_KEYS: properties.STROKE_JOIN_KEYS,
  // ANGLE arithmetic, shared with the Inspector's angle dial so a widget that
  // wraps a heading wraps it the SAME way the dial draws it (core/properties.js
  // is the one home for that convention — a plugin asset restating `((d%360)+360)%360`
  // would be a second definition of it).
  wrapDegrees: properties.wrapDegrees,
  FULL_TURN_DEG: properties.FULL_TURN_DEG,
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
  // `paddedPointsBBox` (points + a halo pad → an AABB) is the EFFECT-REGION
  // helper a widget with no w/h needs: a two-point / N-point widget declaring
  // localBounds has to state its own ink rect, and this is the pure function
  // plugins/tangent_lines.js already used for exactly that. Exposed rather than
  // reimplemented in the asset, so the substrate/cull rect a plugin asset reports
  // cannot drift from the one a source plugin reports.
  paddedPointsBBox,
  // Geometry / anchors helpers a shape widget needs.
  standardBBoxAnchors,
  shapes,
  T: transform,
  G: geometry,
  // PARAMETRIC OUTLINE GEOMETRY (core/outline.js): the generator + solver library
  // the shape family is built on — donutOutline / triangulated / pointInPolygon /
  // closestPointOnSegment / closestPointInAnnulus and the rest. This is the module
  // that makes a RING, a SECTOR or a bespoke silhouette expressible as a plugin
  // asset at all: a concave or holed shape is `outline` + `shapes.polygonPathD` +
  // the IR's `path` op, and reimplementing either half inside a sandboxed source
  // would be both large and a parity hazard (the same outline must produce the
  // same `d` string in the Skia, PDF and SVG backends). `triangulated` remains for
  // the callers that still want a triangle list; it is NOT the route a concave
  // shape has to take any more — the polygon op's convex-only limit belonged to
  // the retired mesh renderer, and routing a shape through it is what made the
  // donut crack (R6-11).
  outline,
  // THE MORPH PROVIDER HELPERS (core/morph_payload.js), so a plugin asset can
  // declare `morphPaths` at all. WITHOUT THESE THE JAIL IS A COVERAGE HOLE, and
  // it was one: `donut` is a fully vector widget that emits ONE `path` op, and it
  // could not join the morph roster for the sole reason that the ONE converter
  // every provider is required to use (core/registry.js: "NO WIDGET SHOULD
  // HAND-WRITE SEXTUPLES") was unreachable from inside the sandbox. The
  // alternative — an asset building cubic sextuples by hand — is precisely the
  // second spelling of the ink that the payload protocol exists to forbid, so the
  // absence did not make assets safe, it made them wrong or absent.
  //
  // Both are pure and DOM-free, take only plain data, and reach nothing: they
  // turn `d` strings into a payload record. `morphPayloadFromOps` and
  // `morphPayloadFromConnector` are deliberately NOT here — the first takes an SVG
  // flatten's op list (no asset can produce one) and the second needs an ink rect
  // from a boxless widget, a shape no asset declares yet. Add them when an asset
  // has that shape, not before.
  morphPayloadFromPaths,
  statePaint,
  // FONT SELECTION, for a text-bearing widget. Data + pure lookups only: the id
  // table, the default id, and the Inspector's option list. NOTHING that loads or
  // rasterizes a face — a plugin asset names a font, it never touches the font
  // pipeline (which is DOM/GPU-side and outside the jail by construction).
  DEFAULT_FONT,
  FONTS,
  fontOptions,
  // THE DATA SEAM — read a TEXTUAL project asset (a CSV, a JSON table) by url.
  assetText,
});

/**
 * Query (reads the text-asset cache; kicks an idempotent load). THE ONE WAY a
 * plugin asset may read data from outside its own state: the text of a project
 * asset, by its served url. Returns `{text, status, error}` — never a bare string,
 * because the three cases a data widget MUST distinguish are exactly the three a
 * bare string cannot express:
 *
 *   status "ready"   → `text` is the file's content; draw the chart.
 *   status "loading" → draw NOTHING this frame. A repaint follows the load
 *                      (web/CanvasView.svelte subscribes to onTextAssetLoad), and
 *                      the headless video worker refuses to write the frame while
 *                      anything is still pending (web/renderJobPage.js
 *                      pendingRasters).
 *   status "error"   → draw a LOUD error affordance naming `error`. A typo'd
 *                      filename must not look like an empty data set.
 *
 * WHY THIS IS NOT A HOLE IN THE JAIL. `fetch` stays blocked: a plugin cannot name
 * a url this does not resolve. What it reaches is the SAME text the app already
 * served the browser for an asset OF THE PROJECT THE VIEWER OPENED — bytes the
 * viewer already has, through a cache that only ever holds asset urls
 * (render_gpu/gpu/text_asset_registry.js, whose bare-node reader resolves
 * `/asset/<Project>/<file>` off disk and refuses anything else). It is READ-ONLY
 * and one-way: there is no POST, and nothing here can send what it read anywhere.
 *
 * WHY IT IS DETERMINISTIC (the property that lets a widget use it at all). A
 * project asset travels WITH the document (the zip round-trip carries assets/), so
 * its bytes are document state, not host state. Δt = 0 leaves this byte-identical,
 * and so does re-rendering on another machine — which is what keeps frame-range
 * sharding and CLI stills correct. See CLAUDE.md's three kinds of state.
 *
 * @param {string} url - a served asset url, e.g. "/asset/MyDeck/sales.csv"
 * @returns {{text: string|null, status: string, error: string|null}}
 *
 * @example assetText("").status // "error"  (a blank url is reported, not thrown)
 * @example assetText(null).error // 'assetText: url must be a non-empty string, got null'
 * @example // in the browser, the frame that first asks for it:
 * //   assetText("/asset/Deck/sales.csv") // {text: null, status: "loading", error: null}
 * @example // once it lands (or immediately, via bare node's synchronous disk read):
 * //   assetText("/asset/Deck/sales.csv") // {text: "region,units\nNorth,12\n", status: "ready", error: null}
 */
function assetText(url) {
  // A BAD URL IS REPORTED, NOT THROWN. This runs inside emit(), which paints every
  // frame: a throw here would take down the whole render over one widget's typo.
  // The caller gets status "error" and draws its loud affordance instead — the same
  // loudness, in the place the author is actually looking.
  if (typeof url !== "string" || !url)
    return { text: null, status: "error", error: `assetText: url must be a non-empty string, got ${url === undefined ? "undefined" : JSON.stringify(url)}` };
  const ready = getTextAsset(url);
  if (ready !== null) return { text: ready, status: "ready", error: null };
  ensureTextAsset(url); // idempotent kick; in bare node this resolves synchronously
  const settled = getTextAsset(url);
  if (settled !== null) return { text: settled, status: "ready", error: null };
  const status = textAssetStatus(url);
  return { text: null, status, error: status === "error" ? textAssetError(url) : null };
}

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
  // `RegExp` IS EXPOSED, but as a constructor FACADE: the real global also
  // carries the legacy static match slots (RegExp.$1, RegExp.input, …), which
  // every regex exec ANYWHERE in the realm updates — reading one would let a
  // plugin observe host activity, a nondeterminism seam. The facade constructs
  // real (deterministic) regex objects and nothing else; `x instanceof RegExp`
  // inside a plugin is the one idiom it cannot support. Found by
  // tests/plugin_asset_doctest_test.js: the migrated number widget's
  // thousands-grouping called `new RegExp` and red-boxed the moment
  // `group: true` was enabled.
  RegExp: Object.freeze(function (pattern, flags) { return new NATIVE_REGEXP(pattern, flags); }),
});
const NATIVE_REGEXP = RegExp;

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
      } catch (e) {
        // emit() is the render path: a throw there must degrade to the LOUD
        // in-widget error box, not kill the frame for every other widget.
        // Every other hook keeps throwing — callers handle those individually.
        if (key !== "emit") throw e;
        const msg = throwMessage(e);
        reportOnce(`plugin_assets:emit:${plugin.type}:${msg}`, `PowerRP plugin "${plugin.type}": emit threw — ${msg}`);
        const s = args[0] ?? {};
        return errorAffordanceIR(errorBoxExtent(s.w), errorBoxExtent(s.h), `plugin error: ${msg}`);
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

// ── TYPED PLUGIN KINDS ────────────────────────────────────────────────────────
// A plugin asset declares WHAT KIND OF THING it is with a `kind` field, and the
// loader dispatches on it. Until now every asset was a widget by construction;
// `kind` names that assumption so a second kind can exist beside it.
//
// THE USER RULING THAT FORCED THIS (verbatim): "Are material plugins possible?
// Should we distinguish widget plugins from material plugins and open the door to
// possibly future new types of plugins? It would be really cool if we could
// refactor liquid glass as a plugin, and the other materials as plugins — then the
// user could actually edit the shader inside the UI, and copy that built-in plugin
// into a new one."
//
// DEFAULTING TO "widget" IS THE COMPATIBILITY CONTRACT, and it is load-bearing
// rather than a convenience. Every plugin asset already written — the five built-in
// library widgets, the project assets in shipped decks, the template a user's Claude
// copies — declares no `kind`, and each must keep loading BYTE-IDENTICALLY: same
// validation, same jail, same registry. So absence means "widget", and
// tests/plugin_kind_test.js pins that a kind-less source and an explicit
// `kind: "widget"` source produce the same registration.
//
// THE TABLE IS THE POINT. A future kind (a TRANSITION, an EASING curve, a slide
// TEMPLATE) is ONE entry here — a validator and a register — not a new branch
// threaded through loadPluginAsset, registerPluginAssets, the built-in library and
// the app seam. Each entry answers exactly three questions: what shape is valid
// (`problem`), what NAME does it claim in its own registry (`nameOf`, the thing a
// collision is refused on), and how does it get registered (`register`). Nothing
// else in this module needs to know a kind exists.
export const DEFAULT_PLUGIN_KIND = "widget";

/**
 * THE KIND DISPATCH TABLE — kind → {noun, problem, nameOf, register}.
 *
 *   noun     — the word error messages use ("widget", "material").
 *   nameField— the FIELD an author renames on a collision ("type" / "id"). Kept
 *              distinct from `noun` so the widget refusal message is byte-identical
 *              to the one that shipped before kinds existed.
 *   problem  — (value) → a human-readable reason it is not a usable plugin of this
 *              kind, or null. The kind's whole shape contract.
 *   nameOf   — (plugin) → the id it claims (`type` for a widget, `id` for a
 *              material). The key a collision is refused on, and the key
 *              registerPluginAssets reports in `types`.
 *   register — (registry, plugin) → void. Where it lands. A widget goes to the
 *              core/registry.js widget registry passed in; a material goes to the
 *              MATERIAL registry (render_gpu/skia/materials.js), which is a module
 *              singleton and therefore ignores the `registry` argument.
 *
 * `material` is populated by core/material_plugins.js, which OWNS the material
 * contract and calls definePluginKind below. It is not defined here because
 * core/plugin_assets.js must stay importable with no knowledge of SkSL — the same
 * layering that keeps this module DOM-free.
 */
const PLUGIN_KINDS = {
  [DEFAULT_PLUGIN_KIND]: {
    noun: "widget",
    nameField: "type",
    problem: pluginShapeProblem,
    nameOf: (p) => p.type,
    // EPHEMERALITY IS SUPPLIED, NOT DEMANDED, AND THAT IS A FACT ABOUT THE JAIL
    // RATHER THAN A CONVENIENCE. core/registry.js requires every widget to declare
    // it (see core/ephemeral.js for why a default would defeat the whole point) —
    // but a plugin ASSET is evaluated inside this file's sandbox, where
    // BLOCKED_GLOBALS makes `fetch`, `XMLHttpRequest`, `WebSocket`, `Date`,
    // `setTimeout` and `queueMicrotask` all unreachable. It is therefore
    // STRUCTURALLY INCAPABLE of a cheap tier or an async source: there is no
    // mechanism by which its output could differ between two frames at the same
    // state. NONE is not assumed here, it is the only reachable answer, which is
    // why supplying it does not reintroduce the silent-default hazard.
    //
    // An author's OWN declaration wins if they write one, so the day the sandbox
    // gains an async capability the vocabulary is already there to describe it.
    register: (registry, p) => registry.register({ ephemeral: "none", ...p }),
  },
};

/**
 * Command (mutates the kind table). Registers a plugin KIND — the one extension
 * point of the dispatch above. Called at module-init time by the module that owns
 * the kind's contract (core/material_plugins.js for "material"), so this file never
 * has to import a renderer.
 *
 * A duplicate kind is refused LOUDLY: two definitions of what "material" means
 * would make which one applies depend on import order.
 *
 * @param {string} kind - the kind name, as an asset's `kind` field spells it
 * @param {{noun: string, nameField: string, problem: Function, nameOf: Function, register: Function}} entry
 * @returns {void}
 *
 * @example // definePluginKind("material", {noun: "material", problem: materialShapeProblem, …})
 * //   → knownPluginKinds() now includes "material"
 */
export function definePluginKind(kind, entry) {
  if (Object.prototype.hasOwnProperty.call(PLUGIN_KINDS, kind))
    throw new Error(`definePluginKind: kind "${kind}" is already defined — a kind has exactly one contract`);
  for (const field of ["noun", "nameField", "problem", "nameOf", "register"])
    if (!(field in entry)) throw new Error(`definePluginKind("${kind}"): entry is missing "${field}"`);
  PLUGIN_KINDS[kind] = entry;
}

/**
 * Query (reads the kind table). The kinds a plugin asset may declare, sorted — the
 * "known set" an unknown-kind refusal names, and the discoverability seam tests and
 * docs read instead of restating a list.
 *
 * @returns {string[]}
 *
 * @example knownPluginKinds().includes("widget") // true
 */
export function knownPluginKinds() {
  return Object.keys(PLUGIN_KINDS).sort();
}

/**
 * Pure function. The KIND a loaded plugin object declares, defaulted. A missing
 * `kind` is "widget" — the compatibility contract every asset written before kinds
 * existed relies on (see the block comment above).
 *
 * @param {*} plugin - the value a plugin asset returned
 * @returns {string}
 *
 * @example pluginKind({type: "gear"}) // "widget"   (absent ⇒ the default)
 * @example pluginKind({kind: "material", id: "plasma"}) // "material"
 * @example pluginKind(null) // "widget"   (a non-object is refused later, by shape)
 */
export function pluginKind(plugin) {
  if (plugin === null || typeof plugin !== "object") return DEFAULT_PLUGIN_KIND;
  return plugin.kind ?? DEFAULT_PLUGIN_KIND;
}

/**
 * Query (reads the kind table). The dispatch entry for a loaded plugin, or a LOUD
 * refusal naming the kind AND the known set — never a silent fall-back to "widget",
 * which would validate a material as a widget and report a baffling `missing "emit"`
 * for a typo'd kind.
 *
 * @param {*} plugin - the value a plugin asset returned
 * @returns {{noun: string, nameField: string, problem: Function, nameOf: Function, register: Function}}
 *
 * @example pluginKindEntry({type: "gear"}).noun // "widget"
 * @example // pluginKindEntry({kind: "transition"})
 * //   → throws 'declares kind "transition", which is not a known plugin kind (known: material, widget)'
 */
export function pluginKindEntry(plugin) {
  const kind = pluginKind(plugin);
  const entry = PLUGIN_KINDS[kind];
  if (!entry)
    throw new Error(`declares kind ${JSON.stringify(kind)}, which is not a known plugin kind (known: ${knownPluginKinds().join(", ")})`);
  return entry;
}

/**
 * Query (evaluates the source). ONE plugin asset source → its validated plugin
 * object, DISPATCHED BY KIND. Loud on every failure mode, each naming the asset:
 *   - the source will not compile, or throws
 *   - it declares an unknown `kind` (named, alongside the known set)
 *   - it returns something that is not a plugin OF THAT KIND (the kind's own
 *     `problem`: pluginShapeProblem for a widget, materialShapeProblem for a
 *     material)
 *   - its claimed NAME collides with an ALREADY-REGISTERED one (a built-in, or an
 *     earlier asset). REFUSED, never shadowed — silently replacing `rect`, or
 *     `glass`, in a deck a stranger shared would repaint a document its author
 *     never saw.
 *
 * `takenTypes` is the taken-name set FOR THAT KIND: widget types for a widget,
 * material ids for a material. The two namespaces are separate on purpose — a
 * material called `donut` does not collide with the donut widget, because nothing
 * ever looks one up in the other's registry.
 *
 * @param {string} source - the asset's JS text
 * @param {string} label - the asset name (error messages)
 * @param {Set<string>} takenTypes - names already registered IN THAT KIND'S registry
 * @returns {object} the declarative plugin object (a widget's hooks are jailed)
 *
 * @example loadPluginAsset("return {type:'gear', title:'Gear', capabilities:{bbox:true}, defaults:{type:'gear'}, emit:()=>[]};", "gear.plugin.js", new Set()).title // "Gear"
 * @example loadPluginAsset("return {type:'gear', title:'G', capabilities:{}, defaults:{type:'gear'}, emit:()=>[]};", "g.plugin.js", new Set()).kind // undefined (kind-less: byte-identical to before)
 * @example // loadPluginAsset("return {type:'rect', ...};", "evil.plugin.js", new Set(["rect"]))
 * //   → throws 'plugin asset "evil.plugin.js": type "rect" is already registered …'
 */
export function loadPluginAsset(source, label, takenTypes) {
  const plugin = evaluatePluginSource(source, label);
  let entry;
  try {
    entry = pluginKindEntry(plugin);
  } catch (e) {
    throw new Error(`plugin asset "${label}": ${e.message}`);
  }
  const problem = entry.problem(plugin);
  if (problem) throw new Error(`plugin asset "${label}": ${problem}`);
  const name = entry.nameOf(plugin);
  // The message names the FIELD the author must rename (`type` for a widget, `id`
  // for a material) — that is what `nameField` is for, and it keeps the widget
  // refusal byte-identical to the one that shipped before kinds existed.
  if (takenTypes.has(name))
    throw new Error(`plugin asset "${label}": ${entry.nameField} "${name}" is already registered — a plugin asset may not shadow a built-in ${entry.noun} or another asset (rename its ${entry.nameField})`);
  // The compilation block travels with the hooks (the DEFERRED escape). A material
  // has no hooks by contract — it is data plus a shader STRING — so this is a no-op
  // copy for that kind, which is exactly the property that keeps jailed JS off the
  // render path.
  return jailedPluginHooks(plugin);
}

/**
 * Pure function. A plugin-asset source REWRITTEN to declare `newType`, by wrapping
 * the original body and overriding `type` + `defaults.type` on whatever it returned.
 *
 * WHY WRAP INSTEAD OF EDITING THE TEXT. The obvious approach — find `type: "x"` and
 * substitute — has to parse JavaScript with a regex to be correct: `type:` occurs at
 * least TWICE in every library source (the plugin's own and `defaults.type`, which
 * pluginShapeProblem REQUIRES to match), and also appears inside comments, inside
 * nested props, and in any string. A substitution that is right for the five files
 * shipping today would be wrong for the first widget whose docstring says the word.
 * Wrapping touches none of the author's text: the original body runs UNCHANGED as a
 * nested function and only its RESULT is adjusted, so the two required occurrences
 * are updated together by construction and nothing else can be hit.
 *
 * The result is still a plugin-asset source (a function body ending in a `return`),
 * so it goes through loadPluginAsset and the jail exactly like any other — this
 * grants no new capability, and a caller must still validate the output.
 *
 * WHO NEEDS THIS: copying a BUILT-IN widget into a project. A verbatim copy declares
 * the built-in's type, which loadPluginAsset refuses ("may not shadow a built-in") —
 * so the copy would be stored and silently never register. Retyping it is what makes
 * "start from the shipped widget" produce a widget instead of a dead file.
 *
 * @param {string} source - a plugin-asset source (function body ending in `return`)
 * @param {string} newType - the type the copy should declare (lower_snake_case)
 * @returns {string} a new plugin-asset source declaring `newType`
 *
 * @example
 * // The copy declares the new type in BOTH required places:
 * const copy = retypedPluginSource("return {type:'gear', title:'G', capabilities:{}, defaults:{type:'gear', w:10}, emit:()=>[]};", "gear_2");
 * const p = loadPluginAsset(copy, "gear 2.plugin.js", new Set(["gear"]));
 * [p.type, p.defaults.type, p.defaults.w]
 * // => ["gear_2", "gear_2", 10]
 * @example
 * // Everything else on the plugin survives untouched — it is the SAME object,
 * // so hooks, capabilities and titles come across as-is.
 * loadPluginAsset(retypedPluginSource("return {type:'a', title:'Kept', capabilities:{bbox:true}, defaults:{type:'a'}, emit:()=>[]};", "b"), "b.plugin.js", new Set()).title
 * // => "Kept"
 * @example
 * // A MATERIAL names itself with `id`, and has no `defaults` — so the copy rewrites
 * // that field instead, and gains no spurious empty defaults object.
 * const mat = loadPluginAsset(
 *   retypedPluginSource(`return {kind:"material", id:"glass", title:"G", params:[], uniforms:[{name:"u",size:1}], sksl:"x"};`, "glass_2"),
 *   "copy.plugin.js", new Set(["glass"]));
 * [mat.id, mat.kind, "defaults" in mat]
 * // => ["glass_2", "material", false]
 */
export function retypedPluginSource(source, newType) {
  // The original body becomes a nested function so its own `return` belongs to it,
  // not to the wrapper. JSON.stringify on the type keeps an odd-but-valid identifier
  // from breaking out of the literal.
  //
  // KIND-AWARE, at RUNTIME rather than here. Which field carries the name depends on
  // the plugin's kind — `type` + `defaults.type` for a widget, `id` for a material —
  // and the kind is only knowable by evaluating the source. So the wrapper branches
  // on the value it just produced rather than this function guessing: one wrapper,
  // correct for both kinds, and correct for a future kind that also names itself `id`.
  // A material has no `defaults`, so spreading one would invent an empty object; the
  // branch avoids that too.
  const name = JSON.stringify(newType);
  return `const __original = (() => {\n${source}\n})();\nreturn __original && __original.kind && __original.kind !== "widget"\n  ? { ...__original, id: ${name} }\n  : { ...__original, type: ${name}, defaults: { ...__original.defaults, type: ${name} } };`;
}

/**
 * Pure function. A widget type derived from `base` that is not in `taken`, by
 * appending `_2`, `_3`, … — the type-level twin of uniquePluginAssetName, and kept
 * beside it because both exist to keep a COPY of an asset from colliding with its
 * original. Stays lower_snake_case, which pluginShapeProblem requires.
 *
 * @param {string} base - the type being copied, e.g. "clock_digital"
 * @param {Iterable<string>} taken - type names already registered
 * @returns {string} a free type name
 *
 * @example
 * uniquePluginType("gear", [])
 * // => "gear"
 * @example
 * // The built-in is registered, so a copy of it gets the next free suffix.
 * uniquePluginType("clock_digital", ["clock_digital"])
 * // => "clock_digital_2"
 * @example
 * uniquePluginType("donut", ["donut", "donut_2"])
 * // => "donut_3"
 */
export function uniquePluginType(base, taken) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
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
 * `types` IS THE FILE→TYPE MAP, and it is returned as well as `loaded` because the
 * two answer different questions and only one of them is derivable from the other.
 * `loaded` is "what got registered just now", which is what a boot log prints.
 * `types` is "which widget does THIS FILE declare", which is what a caller needs to
 * act on one asset — the drop-to-instantiate path has a filename in hand and must
 * find its widget. That mapping only exists here, inside the load: a type name is in
 * the SOURCE, not in the listing, so a caller that has only `loaded` can do no better
 * than guess (and guessing "the last one" is wrong the moment two assets load).
 *
 * @param {object} registry - a core/registry.js registry
 * @param {Array<{name: string, source: string}>} sources - the assets to load
 * @returns {{loaded: string[], types: Object<string, string>, reports: string[]}}
 *   registered types, the asset-name → type map, and one message per refusal
 *
 * @example registerPluginAssets(createRegistry(), []) // {loaded: [], types: {}, reports: []}
 * @example // registerPluginAssets(reg, [{name: "gear.plugin.js", source: "return {type:'gear',…};"}])
 * //   → {loaded: ["gear"], types: {"gear.plugin.js": "gear"}, reports: []}
 * @example // a broken asset beside a good one — the good one still maps:
 * //   → {loaded: ["gear"], types: {"gear.plugin.js": "gear"},
 * //      reports: ['plugin asset "bad.plugin.js": is missing "emit"']}
 */
export function registerPluginAssets(registry, sources) {
  // ONE TAKEN-NAME SET PER KIND. The namespaces are separate: a material called
  // `donut` does not collide with the donut widget, because nothing ever looks one
  // up in the other's registry. Seeded lazily — the widget set from the registry
  // passed in, a material's from the material registry — so a kind that has not
  // appeared costs nothing and this function still needs no import from a renderer.
  const takenByKind = { [DEFAULT_PLUGIN_KIND]: new Set(registry.all().map((p) => p.type)) };
  const loaded = [];
  const types = {};
  const reports = [];
  for (const { name, source } of sources ?? []) {
    try {
      // The kind is read BEFORE the load so the right taken-set is passed in; a bad
      // kind surfaces from loadPluginAsset with the asset named, as every other
      // refusal does.
      const kind = peekPluginKind(source, name);
      const taken = (takenByKind[kind] ??= new Set(takenNamesForKind(kind)));
      const plugin = loadPluginAsset(source, name, taken);
      const entry = pluginKindEntry(plugin);
      entry.register(registry, plugin);
      const claimed = entry.nameOf(plugin);
      taken.add(claimed);
      loaded.push(claimed);
      types[name] = claimed;
    } catch (e) {
      reports.push(e.message); // RETURNED, never swallowed — the caller prints it
    }
  }
  return { loaded, types, reports };
}

/**
 * Query (evaluates the source — see the caveat). The KIND a source declares,
 * WITHOUT committing to loading it, so registerPluginAssets can pick the right
 * taken-name set before validation.
 *
 * It evaluates the source once here and once inside loadPluginAsset. That double
 * evaluation is deliberate and cheap: a plugin source is a declarative object
 * literal, evaluated at project load only, and the alternative — threading the
 * evaluated value through loadPluginAsset — would mean a second public entry point
 * that takes an already-evaluated plugin, i.e. one that skips the jail. Keeping the
 * jail on the ONLY path into a plugin object is worth evaluating a literal twice.
 *
 * A source that will not evaluate returns the default kind; the real error surfaces
 * from loadPluginAsset a moment later, with its full message.
 *
 * @param {string} source - the asset's JS text
 * @param {string} label - the asset name
 * @returns {string}
 *
 * @example peekPluginKind("return {type: 'gear'};", "gear.plugin.js") // "widget"
 * @example peekPluginKind("return {kind: 'material', id: 'plasma'};", "p.plugin.js") // "material"
 * @example peekPluginKind("this is not javascript", "broken.plugin.js") // "widget" (the real error comes from the load)
 */
function peekPluginKind(source, label) {
  try {
    return pluginKind(evaluatePluginSource(source, label));
  } catch {
    return DEFAULT_PLUGIN_KIND; // loadPluginAsset reports the real reason, loudly
  }
}

/**
 * The per-kind TAKEN-NAME source. A kind may declare `takenNames()` — the names
 * already registered in ITS registry — so a collision with a built-in is refused.
 * Widgets do not need one (registerPluginAssets seeds theirs from the registry it
 * was handed); materials do, because their registry is a module singleton.
 */
function takenNamesForKind(kind) {
  const entry = PLUGIN_KINDS[kind];
  return entry?.takenNames ? entry.takenNames() : [];
}
