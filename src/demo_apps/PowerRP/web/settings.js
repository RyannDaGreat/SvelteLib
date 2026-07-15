/**
 * THE settings repo (manifest "SETTINGS TAXONOMY"): one home for BROWSER
 * settings — per-browser, localStorage-persisted viewer preferences (retina,
 * theme, minimap, grid, ...), NOT document state. Each boolean flag is stored
 * as the strings "on"/"off".
 *
 * Before this, every setting was hand-rolled FOUR ways (a key constant, a
 * `$state(localStorage.getItem(key) !== "off")` init, a toggle method, and a
 * localStorage.setItem in that toggle) — ~10 near-identical pairs that drifted
 * (cruft audit: "the manifest-mandated settings repo doesn't exist").
 * browserSetting() gives ONE home for the key + the read/write logic while
 * leaving the reactive $state field and the toggle method in PowerRPApp (runes
 * must live in the class) — so `app.minimapVisible` stays a plain boolean and
 * every read site is untouched. Each toggle collapses to a one-liner:
 *
 *   minimapVisible = $state(MINIMAP.initial);
 *   toggleMinimap() { this.minimapVisible = MINIMAP.persist(!this.minimapVisible); }
 */

/**
 * Query/Command factory (reads localStorage now for `.initial`; `.persist`
 * writes it). A single boolean BROWSER setting at `key`, defaulting to
 * `defaultOn` when unset.
 *
 * Returns `{key, initial, persist}`:
 *   key      — the localStorage key (exposed so callers can reference it).
 *   initial  — the boolean value at construction (default when unset). QUERY.
 *   persist  — persist(v) writes "on"/"off" and returns v (so a toggle reads
 *              `field = S.persist(!field)`). COMMAND.
 *
 * @param {string} key localStorage key (e.g. "powerrp.minimap").
 * @param {boolean} defaultOn Value when the key is unset.
 * @returns {{key: string, initial: boolean, persist: (v: boolean) => boolean}}
 *
 * @example // const S = browserSetting("powerrp.minimap", true);
 * @example // S.initial            // true when unset, else the stored value
 * @example // S.persist(false)     // false, and localStorage["powerrp.minimap"] === "off"
 */
export function browserSetting(key, defaultOn) {
  const stored = localStorage.getItem(key);
  return {
    key,
    initial: stored === null ? defaultOn : stored === "on",
    persist(v) {
      localStorage.setItem(key, v ? "on" : "off");
      return v;
    },
  };
}
