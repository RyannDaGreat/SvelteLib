/**
 * THE settings repo (manifest "SETTINGS TAXONOMY"): one home for BROWSER
 * settings — per-browser, localStorage-persisted viewer preferences (retina,
 * theme, minimap, grid, ...), NOT document state. Each boolean flag is stored
 * as the strings "on"/"off"; each numeric setting as its decimal text.
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

/**
 * Query/Command factory — browserSetting()'s NUMERIC sibling, same three-field
 * shape so a numeric preference needs no second idiom (the Property Panel's
 * label/value divider fraction is the first: a continuous drag, not a toggle).
 *
 * The value is CLAMPED on both read and write, so a hand-edited or
 * stale-from-an-older-build localStorage entry can never wedge a panel at an
 * unusable split — and a non-numeric entry falls back to `fallback` rather than
 * poisoning layout with NaN. `reset` is exposed because a continuous setting
 * needs a way back to the default that a boolean's toggle gets for free (the
 * divider's double-click).
 *
 * Returns `{key, min, max, initial, persist, reset}`:
 *   key      — the localStorage key.
 *   min/max  — the clamp bounds (exposed so a drag can clamp with the same
 *              numbers rather than restating them).
 *   initial  — the clamped stored value, or `fallback` when unset/unparseable. QUERY.
 *   persist  — persist(v) clamps, writes, and returns the CLAMPED value. COMMAND.
 *   reset    — reset() clears the key and returns `fallback`. COMMAND.
 *
 * @param {string} key localStorage key (e.g. "powerrp.labelFrac").
 * @param {number} fallback Value when the key is unset or unparseable.
 * @param {number} min Lower clamp bound.
 * @param {number} max Upper clamp bound.
 * @returns {{key: string, min: number, max: number, initial: number, persist: (v: number) => number, reset: () => number}}
 *
 * @example // const S = browserNumberSetting("powerrp.labelFrac", 0.34, 0.15, 0.6);
 * @example // S.initial       // 0.34 when unset, else the clamped stored value
 * @example // S.persist(0.9)  // 0.6 (clamped), and localStorage holds "0.6"
 * @example // S.reset()       // 0.34, and the key is gone
 */
export function browserNumberSetting(key, fallback, min, max) {
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const stored = Number(localStorage.getItem(key));
  return {
    key,
    min,
    max,
    initial: Number.isFinite(stored) && localStorage.getItem(key) !== null ? clamp(stored) : fallback,
    persist(v) {
      const c = clamp(v);
      localStorage.setItem(key, String(c));
      return c;
    },
    reset() {
      localStorage.removeItem(key);
      return fallback;
    },
  };
}
