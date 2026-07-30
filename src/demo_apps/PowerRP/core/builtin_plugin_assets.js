/**
 * builtin_plugin_assets.js — THE BUILT-IN PLUGIN-ASSET LIBRARY: widgets that ship
 * with the app but are delivered as `*.plugin.js` ASSETS through the jail loader
 * (core/plugin_assets.js), not as source files on the plugins/index.js roster.
 *
 * ── THE PROBLEM THIS SOLVES (user rulings, verbatim) ─────────────────────────
 * "how many plugins can be turned into built-in assets?" — and, on where they
 * appear, "maybe the asset explorer could have a toggle for built-in assets. By
 * default it's turned off".
 *
 * A project plugin asset (core/plugin_assets.js) already proved the format: a
 * widget can be a file the document carries. But every widget the APP itself
 * ships still had to be a source module, which meant the plugin-asset path was
 * only ever exercised by the three proof assets in `plugin_assets/`. That is the
 * wrong way round: if the format is good enough to hand a user's Claude, it is
 * good enough for the app's own tier-1 vector widgets — and putting real,
 * shipped widgets on that path is the only way the format stays honest. A
 * regression in the jail's API surface now breaks the Progress Bar, not just a
 * demo, so the gate catches it.
 *
 * ── WHAT "TIER-1" MEANS, AND WHY EXACTLY THESE FIVE ──────────────────────────
 * A widget can move here when everything it needs is already in the sandbox's
 * provided API (HOST_MODULES in core/plugin_assets.js): pure geometry, the IR
 * ops, the shared property registry, the effects bundle. In practice that means
 * PURE-VECTOR widgets — no media decode, no shader, no DOM, no live app.
 * Batch 1 is progress_bar, donut, number, clock_digital, clock_analog.
 *
 * WHY `number` AND NOT `tangent_lines`, which the brief listed as a candidate:
 * tangent_lines was attempted and REJECTED on a specific, recorded blocker, not
 * on taste. tests/silent_promises_test.js:170 asserts
 * `registry.get("tangent_lines").anchors === tangentLinesAnchors` — a FUNCTION
 * IDENTITY check against the module's own export. A plugin asset structurally
 * cannot satisfy that: jailedPluginHooks WRAPS every function hook (that wrapper
 * is what closes the deferred-escape hole), so the registered `anchors` is a new
 * function by construction. Migrating it would have meant weakening a security
 * test's assertion to accommodate a refactor, which is the wrong trade. Its
 * module ALSO exports the telescopic-magnifier rig builder that web/app.svelte.js,
 * web/telescopicRig.js and three probes import, so the file has to stay regardless
 * and the migration would have split one widget across two homes. `number` cost
 * nothing by comparison: nothing imports its plugin object, it declares no
 * `commands`, and its add-command already resolved the type lazily.
 *
 * WHAT IS DELIBERATELY NOT HERE, so the boundary is legible rather than folkloric:
 *   · anything sampling a texture (image/video/pdf/filmstrip) — needs the media
 *     registries, which are GPU-side.
 *   · anything with a shader (the material family) — needs SkSL + the backdrop
 *     compositor.
 *   · anything that must drive the editor (camera, group, cropbox) — the jail
 *     withholds the live app on purpose, so `commands` is refused outright.
 *   · latex / mermaid / qrcode — each pulls a third-party module the jail cannot
 *     `import`.
 *
 * ── THE ONE API ADDITION THIS BATCH FORCED, AND WHY IT WAS EXPOSED ───────────
 * Four of the five needed host bindings the sandbox did not yet hand out:
 * `outline` (core/outline.js — donut's ring, clock_analog's annulus solver),
 * `paddedPointsBBox` (tangent_lines' ink rect), the font TABLE + `fontOptions`
 * (both clocks' font row), and `wrapDegrees`/`FULL_TURN_DEG` (clock_analog's
 * angle wrap). Per the brief's rule, the PURE HELPER was exposed rather than the
 * widget skipped — each is DOM-free, side-effect-free and already part of the
 * declarative plugin vocabulary. Reimplementing any of them inside a sandboxed
 * source would have been the worse outcome: `triangulated` in particular is the
 * reason the Skia, PDF and SVG backends draw a ring with the SAME triangles, and
 * a second ear-clipper would be a parity hazard, not a convenience.
 *
 * ── ADD-COMMANDS DO NOT COME ALONG, AND THAT IS NOT A LOSS ────────────────────
 * `pluginShapeProblem` REFUSES a plugin asset that declares `commands` (a
 * command's run(app) receives the live app — the exact capability the jail
 * exists to withhold). Three of the five carried one. Their palette entries now
 * live in plugins/builtin_asset_commands.js, which resolves the type LAZILY from
 * the registry — the pattern App.svelte already used for `add-number`,
 * `add-line` and every demo insert. So `add-donut`, `add-clock-digital` and
 * `add-clock_analog` keep working, with the same ids the browser probes assert.
 *
 * ── EVERY MODE, INCLUDING BARE NODE ──────────────────────────────────────────
 * These widgets are on the built-in roster, so they must register wherever the
 * roster does: the editor, the render-job page, the node test suites AND
 * cli/render.js. There is no asset store in bare node, so the sources are read
 * the way render_gpu/gpu/svg_raster.js reads the built-in cursors — the
 * `cursorsFromDisk` precedent: `import.meta.glob` (eager `?raw`) in the browser
 * bundle, `fs.readdirSync` off disk in node, discriminated by the runtime rather
 * than by a build flag. Both loaders key by FILE NAME and the enumeration is
 * checked against BUILTIN_PLUGIN_ASSET_NAMES, so a file added to the directory
 * without being listed (or listed without being added) is reported LOUDLY
 * instead of silently vanishing from the roster.
 *
 * Synchronous by contract: registerPlugins() is synchronous and callers rely on
 * that (a document is repaired immediately after, and an unregistered type is an
 * ORPHAN that repair DROPS — the data-loss ordering hazard
 * web/pluginAssetLoader.js documents). So both loaders are synchronous and
 * memoized; the browser one costs nothing at runtime because Vite inlines the
 * sources into the bundle.
 */

import { registerPluginAssets } from "./plugin_assets.js";

/** The committed built-in plugin-asset directory, relative to THIS module — the
 *  literal Vite's `import.meta.glob` pattern below must also spell (a glob
 *  pattern is a build-time macro and cannot read a variable). */
const LIBRARY_DIR = "../assets/builtin/library/";

/** The suffix a built-in library file must carry to be a widget. Same compound
 *  suffix as a project plugin asset (core/plugin_assets.PLUGIN_ASSET_SUFFIX) —
 *  restated as a local only because the glob pattern below hard-codes it too. */
const LIBRARY_SUFFIX = ".plugin.js";

/**
 * THE ENUMERATION — the built-in library's contents, as a static list.
 *
 * WHY A LIST AT ALL when both loaders enumerate the directory: the same reason
 * svg_raster.js keeps CURSOR_NAMES. A glob is resolved at BUILD time and a
 * readdir at RUN time, so the two can disagree — a file added to the repo but
 * missing from a stale bundle, or a file renamed with no rebuild. Without a
 * declared expectation that disagreement is invisible: the widget simply is not
 * registered, its items become orphans, and repair DELETES them. With one, the
 * mismatch is a loud report naming both sides.
 *
 * ORDER IS REGISTRATION ORDER, and registration order decides which of two
 * assets declaring the same type wins the collision refusal — so it is sorted,
 * matching web/pluginAssetLoader.pluginAssetEntries' reason for sorting.
 */
export const BUILTIN_PLUGIN_ASSET_NAMES = Object.freeze([
  "clock_analog.plugin.js",
  "clock_digital.plugin.js",
  "donut.plugin.js",
  "number.plugin.js",
  "progress_bar.plugin.js",
]);

/**
 * True in bare Node (cli/render.js + every node suite), false in the browser
 * bundle — THE discriminator between the two loaders below.
 *
 * Copied in spirit from render_gpu/gpu/svg_raster.js's IS_NODE, and for its
 * reason: `import.meta.glob` is a Vite TRANSFORM of the CALL expression, so
 * `typeof import.meta.glob` reads "undefined" in the browser too and cannot be
 * tested. Node's own presence is the honest signal.
 */
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/** Memoized sources (name → JS text). Built once on first call. */
let sourceCache = null;

/**
 * Query (browser: reads the bundle; node: reads disk. Memoized). The built-in
 * plugin-asset SOURCES as `{name, source}` in BUILTIN_PLUGIN_ASSET_NAMES order,
 * ready for core/plugin_assets.registerPluginAssets.
 *
 * A file present on disk/in the bundle but ABSENT from the enumeration — or the
 * reverse — is a DRIFT report, not a silent omission (see the enumeration's
 * docblock). Reports are returned, never printed here, so the caller owns the
 * channel (the repair-pipeline convention).
 *
 * @returns {{sources: Array<{name: string, source: string}>, reports: string[]}}
 *
 * @example
 * // builtinPluginAssetSources().sources.map((s) => s.name)
 * // ["clock_analog.plugin.js", "clock_digital.plugin.js", "donut.plugin.js",
 * //  "progress_bar.plugin.js", "tangent_lines.plugin.js"]
 * @example
 * // A source is the plugin-asset FUNCTION BODY, so it ends in a `return`:
 * // builtinPluginAssetSources().sources[0].source.includes("return {") // true
 * @example
 * // Clean library ⇒ no reports:
 * // builtinPluginAssetSources().reports // []
 */
export function builtinPluginAssetSources() {
  if (!sourceCache) sourceCache = IS_NODE ? libraryFromDisk() : libraryFromBundle();
  const reports = [];
  const found = Object.keys(sourceCache).sort();
  const expected = [...BUILTIN_PLUGIN_ASSET_NAMES].sort();
  if (found.join(",") !== expected.join(","))
    reports.push(`built-in plugin-asset library drift: found ${JSON.stringify(found)} but BUILTIN_PLUGIN_ASSET_NAMES lists ${JSON.stringify(expected)} — update core/builtin_plugin_assets.js`);
  const sources = [];
  for (const name of BUILTIN_PLUGIN_ASSET_NAMES) {
    const source = sourceCache[name];
    if (source === undefined) continue; // named in the drift report above, not swallowed
    sources.push({ name, source });
  }
  return { sources, reports };
}

/** Query (browser — the Vite glob macro). The library sources the BUNDLER
 *  inlined (eager `?raw`, so the text ships with the app: no network fetch, and
 *  a statically-hosted editor gets its built-in widgets with no server). The
 *  literal pattern must match LIBRARY_DIR + LIBRARY_SUFFIX (see them). */
function libraryFromBundle() {
  const modules = import.meta.glob("../assets/builtin/library/*.plugin.js", { eager: true, query: "?raw", import: "default" });
  const map = {};
  for (const [path, source] of Object.entries(modules)) map[path.split("/").pop()] = source;
  return map;
}

/** Query (bare node — reads the committed library files). Resolved RELATIVE to
 *  this module (portable: no absolute path, no node:path import — `fs` takes
 *  file: URLs). A missing/renamed directory throws loudly out of readdirSync,
 *  never a silently empty roster. */
function libraryFromDisk() {
  if (typeof process.getBuiltinModule !== "function")
    throw new Error("builtin_plugin_assets: node >= 22.3 needed to read the built-in plugin library from disk (process.getBuiltinModule)");
  const fs = process.getBuiltinModule("node:fs");
  const dir = new URL(LIBRARY_DIR, import.meta.url);
  const map = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(LIBRARY_SUFFIX)) continue;
    map[file] = fs.readFileSync(new URL(file, dir), "utf8");
  }
  return map;
}

/**
 * Command (registers into `registry`; returns a report). Register every built-in
 * plugin asset. Called by plugins/index.js registerPlugins, so it runs in EVERY
 * mode the built-in roster runs in — editor, render-job page, node suites,
 * cli/render.js.
 *
 * Returns `{loaded, reports}` exactly as registerPluginAssets does, with the
 * library-drift reports folded into the same array, so the caller has ONE list
 * to print and cannot report a sandbox refusal while dropping a drift.
 *
 * PARTIAL SUCCESS, as in registerPluginAssets: one broken library file must not
 * cost the other four their registration. Nothing is swallowed — every failure
 * comes back in `reports`, and a widget that failed to register is a widget
 * whose items repair will drop, which is why the caller must be loud.
 *
 * @param {object} registry - a core/registry.js registry
 * @returns {{loaded: string[], reports: string[]}}
 *
 * @example
 * // registerBuiltinPluginAssets(createRegistry()).loaded
 * // ["clock_analog", "clock_digital", "donut", "progress_bar", "tangent_lines"]
 * @example
 * // A registry that already has one of these types refuses the duplicate LOUDLY
 * // rather than shadowing it (the plugin-asset collision rule):
 * // registerBuiltinPluginAssets(regWithDonutAlready).reports[0]
 * // 'plugin asset "donut.plugin.js": type "donut" is already registered …'
 */
export function registerBuiltinPluginAssets(registry) {
  const { sources, reports: driftReports } = builtinPluginAssetSources();
  const { loaded, reports } = registerPluginAssets(registry, sources);
  return { loaded, reports: [...driftReports, ...reports] };
}
