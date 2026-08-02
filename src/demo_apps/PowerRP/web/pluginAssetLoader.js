/**
 * pluginAssetLoader.js — the APP-SIDE half of plugin assets: fetch a project's
 * `*.plugin.js` assets and register them into a live registry.
 *
 * The pure half (the sandbox, the validation, the collision refusal) is
 * core/plugin_assets.js, which is DOM-free and bare-node tested. This file is
 * only the I/O: it lists a project's assets, reads the plugin ones as text, and
 * hands the sources to that module. Nothing about the jail lives here.
 *
 * ── LOAD ORDER IS LOAD-BEARING ────────────────────────────────────────────────
 * These must be registered BEFORE core/document.js's repairedDocument runs on the
 * project's document. Repair's FIRST step drops orphaned items, and an item whose
 * `type` no registered plugin claims IS an orphan (core/document.js
 * orphanedItems). So a document using an asset-plugin type, repaired before the
 * asset registered, loses every one of those items — and, because the drop is a
 * document rewrite, the loss is what gets saved back. That is data loss, not a
 * cosmetic ordering nit, which is why app.svelte.js loadProject awaits this
 * before it calls this.repaired().
 *
 * ── ADAPTER-BLIND ─────────────────────────────────────────────────────────────
 * Assets are read through the asset STORE seam (web/storageMode.js assetStore),
 * not through projectApi directly, so a plugin asset loads identically from the
 * Python backend and from IndexedDB in static mode. That matters for the ruling's
 * own motivating case — "even if it is statically hosted" — where there is no
 * server to ask.
 *
 * ── DEREGISTRATION ────────────────────────────────────────────────────────────
 * A registry is per-document-session and has no `unregister` (core/registry.js:
 * a plugin map that could shrink under a live document is how a derive walk finds
 * a node whose plugin vanished mid-frame). So switching projects does not
 * deregister in place — it REBUILDS the registry from the built-in roster and
 * then loads the new project's assets. Same effect, no mutable-shrink hazard, and
 * one code path with the constructor's.
 */

import { registerPluginAssets, isPluginAssetName, PLUGIN_ASSET_SUFFIX } from "../core/plugin_assets.js";
import { widgetForAssetKind } from "../core/registry.js"; // assetDropKind asks the roster, not a copy of it

/**
 * Query. The plugin-asset entries in an asset listing, in a STABLE order.
 *
 * Sorted by name because registration order decides which of two assets
 * declaring the SAME type wins the collision refusal — and "whichever the
 * filesystem listed first" would make that answer differ between the server and
 * IndexedDB adapters. Sorted, the refusal message names the same file every time.
 *
 * @param {Array<{name: string}>} assetList - an asset store listing
 * @returns {Array<{name: string}>} only the plugin assets, name-sorted
 *
 * @example pluginAssetEntries([{name: "b.plugin.js"}, {name: "logo.png"}, {name: "a.plugin.js"}]).map((a) => a.name)
 * // ["a.plugin.js", "b.plugin.js"]
 * @example pluginAssetEntries([{name: "logo.png"}]) // []
 * @example pluginAssetEntries(null) // [] (a project with no listing yet)
 */
export function pluginAssetEntries(assetList) {
  return (assetList ?? [])
    .filter((a) => isPluginAssetName(a?.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Query (network / IndexedDB). Read one project's plugin-asset SOURCES through
 * the asset store: [{name, source}], ready for registerPluginAssets.
 *
 * A read failure on ONE asset is reported and skipped rather than failing the
 * project open, matching registerPluginAssets' partial-success contract — the
 * document may depend on the OTHER assets' types, and refusing them all would
 * cascade into a document-wide orphan purge. Nothing is swallowed: the reason
 * comes back in `reports`.
 *
 * @param {object} store - an asset store (web/storageMode.js assetStore())
 * @param {string} project - project name
 * @returns {Promise<{sources: Array<{name: string, source: string}>, reports: string[]}>}
 *
 * @example // await readPluginAssetSources(assetStore(), "Imitations")
 * //   → {sources: [{name: "gear.plugin.js", source: "…"}], reports: []}
 */
export async function readPluginAssetSources(store, project) {
  const entries = pluginAssetEntries(await store.list(project));
  const sources = [];
  const reports = [];
  for (const entry of entries) {
    try {
      const blob = await store.get(project, entry.name);
      sources.push({ name: entry.name, source: await blob.text() });
    } catch (e) {
      reports.push(`plugin asset "${entry.name}": could not be read — ${e.message}`);
    }
  }
  return { sources, reports };
}

/**
 * Command (registers into `registry`; reports). Load and register every plugin
 * asset of `project`. THE seam app.svelte.js loadProject awaits before repair.
 *
 * Returns `{loaded, reports}` exactly as core/plugin_assets.registerPluginAssets
 * does, with read failures folded into the same `reports` array — so the caller
 * has ONE list to print and cannot report the sandbox refusals while silently
 * dropping the I/O ones.
 *
 * @param {object} registry - a core/registry.js registry
 * @param {object} store - an asset store
 * @param {string} project - project name
 * `types` (asset name → widget type) is passed through from registerPluginAssets —
 * see its docblock for why the map is returned alongside `loaded`. The drop path
 * needs it: it has a FILENAME and must find that file's widget.
 *
 * @returns {Promise<{loaded: string[], types: Object<string, string>, reports: string[]}>}
 *
 * @example // await loadProjectPluginAssets(app.registry, assetStore(), "Imitations")
 * //   → {loaded: ["gear", "superellipse"],
 * //      types: {"gear.plugin.js": "gear", "superellipse.plugin.js": "superellipse"},
 * //      reports: []}
 */
export async function loadProjectPluginAssets(registry, store, project) {
  const { sources, reports: readReports } = await readPluginAssetSources(store, project);
  const { loaded, types, reports } = registerPluginAssets(registry, sources);
  return { loaded, types, reports: [...readReports, ...reports] };
}

/**
 * Command (console). Print a plugin-asset load result. Silent when a project has
 * no plugin assets and nothing went wrong; LOUD on every refusal, because a
 * widget that silently failed to register looks to the user exactly like a widget
 * that was deleted — and repair will then drop its items.
 *
 * @param {{loaded: string[], reports: string[]}} result - a load result
 * @param {string} project - project name, for the message
 * @returns {void}
 *
 * @example // printPluginAssetReports({loaded: ["gear"], reports: []}, "Imitations")
 * //   → console.log('Registered 1 plugin asset from "Imitations": gear')
 * @example // printPluginAssetReports({loaded: [], reports: ['plugin asset "x.plugin.js": is missing "emit"']}, "Deck")
 * //   → console.error(…) naming the file and the reason
 */
export function printPluginAssetReports({ loaded, reports }, project) {
  if (loaded.length)
    console.log(`Registered ${loaded.length} plugin asset${loaded.length === 1 ? "" : "s"} from "${project}": ${loaded.join(", ")}`);
  for (const report of reports)
    console.error(`Plugin asset REFUSED in "${project}" — ${report}`);
}

/**
 * Pure function. What should a canvas DROP of this asset do? Returns one of:
 *
 *   "widget"  — a `*.plugin.js` asset: ADD ITS WIDGET at the drop point (user
 *               ruling: "If I drag and drop a widget plugin onto the canvas, it
 *               should add the widget… from the asset library").
 *   "media"   — an image/video asset: the pre-existing insert-a-media-widget path.
 *   "none"    — nothing on the canvas can represent it; the caller REPORTS and the
 *               asset stays in the library. Never a silent no-op.
 *
 * WHY A CLASSIFIER RATHER THAN AN `if` IN THE HANDLER. The drop handler is in a
 * .svelte file and cannot be tested in bare node, and this decision is the part
 * worth pinning: a plugin asset dropped on the canvas used to fall through the
 * media branches into the "no canvas widget for a …" warning, which is a correct
 * message about the wrong classification. Naming the three outcomes here means the
 * node suite can assert all three, including the one that reports.
 *
 * THE KIND IS NOT TRUSTED OVER THE NAME. The `kind` field comes from whatever
 * produced the listing (server.py's classifier, or assetRef.assetKindForName), but
 * the SUFFIX is what makes a file a plugin asset (core/plugin_assets.js
 * PLUGIN_ASSET_SUFFIX is the one spelling of that rule). So the name is checked
 * first, and a listing whose `kind` disagrees with its own filename still routes by
 * the filename — the property the loader itself keys off.
 *
 * "MEDIA" IS ASKED OF THE REGISTRY, NOT OF A LIST HERE — and that is the fix for
 * the PDF the user could not drop. This function used to end in
 * `kind === "image" || kind === "video"`, one of THREE hand-written copies of the
 * same pair (the others: the drop handler's ternary, and the upload-then-insert
 * branch in app.svelte.js). `pdf_page` has existed the whole time, so the refusal
 * the user saw — "nothing on the canvas can show a 'pdf' asset" — was a true
 * statement about this line and a false one about the app. Widgets now DECLARE the
 * dropped kind they are (`assetDrop`, core/registry.js), so the answer comes from
 * the roster that actually knows and a new droppable widget needs no edit here.
 *
 * @param {{name?: string, kind?: string}} asset - a dropped asset payload
 * @param {{all: function}} registry - the widget registry (who claims which kind)
 * @returns {"widget"|"media"|"none"}
 *
 * @example assetDropKind({name: "gear.plugin.js", kind: "plugin"}, reg) // "widget"
 * @example assetDropKind({name: "donut.plugin.js", kind: "other"}, reg) // "widget"  (the SUFFIX decides, not the kind)
 * @example assetDropKind({name: "logo.png", kind: "image"}, reg)        // "media"
 * @example assetDropKind({name: "paper.pdf", kind: "pdf"}, reg)         // "media"  (pdf_page claims it)
 * @example assetDropKind({name: "ding.wav", kind: "sound"}, reg)        // "none"   (no widget plays a bare sound)
 * @example assetDropKind({}, reg)                                       // "none"
 */
export function assetDropKind(asset, registry) {
  if (isPluginAssetName(asset?.name)) return "widget";
  // REFUSED, NOT DEFAULTED. A caller that forgot the registry would otherwise get
  // "none" for every media asset — a silent, plausible answer that reads as "this
  // file has no widget" and would put the original bug back with no error to find
  // it by. (The plugin-asset branch above genuinely needs no registry, so it is
  // answered first and this only guards the branch that does.)
  if (!registry?.all) throw new Error("assetDropKind: a registry is required to say whether any widget claims this asset kind");
  return widgetForAssetKind(registry, asset?.kind) ? "media" : "none";
}

export { PLUGIN_ASSET_SUFFIX };
