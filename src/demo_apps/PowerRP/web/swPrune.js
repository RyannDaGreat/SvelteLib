/**
 * swPrune.js — the pure decision at the center of the SW install-time cache
 * prune (see `sw.js`'s UPDATES docblock for the bug this exists to fix).
 *
 * A SEPARATE ES MODULE, not a function living directly in `sw.js`, because
 * `sw.js` is registered as a CLASSIC script (no `type: "module"` at
 * `navigator.serviceWorker.register` — see `registerServiceWorker.js`), so a
 * real `export` there would be a syntax error in the browser. `swBuildPlugin.js`
 * inlines this file's source into the emitted `sw.js` at build time (the same
 * treatment the precache preamble already gets), so the shipped worker sees one
 * plain function declaration with no module syntax, while this file stays a
 * normal, `import`-able, bare-node-testable module the rest of the time.
 */

/**
 * Pure function. Decides which `powerrp-shell-*` cache names to delete.
 *
 * Never deletes `installingVersion` (the generation this call is protecting —
 * it was either just precached, or is the one currently serving live pages)
 * nor `activeVersion` (the OTHER generation a live page may be pinned to, if
 * different from `installingVersion`; `null`/`undefined` when no record exists
 * yet, e.g. the very first install on a fresh browser). Every other shell name
 * is a generation no open tab can be relying on, so it is always safe to drop:
 * its worker has either already handed off (the active record moved past it)
 * or never activated at all.
 *
 * @param {string[]} cacheNames - every cache name currently in Cache Storage
 * @param {string} installingVersion - the shell cache name to always keep
 * @param {?string} activeVersion - the shell cache name recorded as live, or
 *   null/undefined if no worker has recorded one yet
 * @returns {string[]} cache names to delete, in no particular order
 *
 * @example three generations on disk, v3 just finished installing, v1 is live:
 * pruneShellCacheNames(
 *   ["powerrp-shell-v1", "powerrp-shell-v2", "powerrp-shell-v3", "powerrp-icons"],
 *   "powerrp-shell-v3",
 *   "powerrp-shell-v1",
 * )
 * // => ["powerrp-shell-v2"]  (v2's worker never activated; v1 is live; v3 is new)
 *
 * @example fresh browser, no active record yet — nothing is provably safe to drop:
 * pruneShellCacheNames(["powerrp-shell-v1"], "powerrp-shell-v1", null)
 * // => []
 */
export function pruneShellCacheNames(cacheNames, installingVersion, activeVersion) {
  const keep = new Set([installingVersion, activeVersion]);
  return cacheNames.filter((n) => n.startsWith("powerrp-shell-") && !keep.has(n));
}
