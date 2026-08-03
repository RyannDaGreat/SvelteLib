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
 * Query/Command factory — browserSetting()'s ENUMERATED sibling, for a preference
 * that is one of N NAMED layouts rather than on/off. The slide navigator's and the
 * Asset Explorer's list-vs-grid view are the first two (user, 2026-08-02: "It would
 * be nice if there was a second option for viewing slides… you would have the view
 * option, which would be, you know, list view or tile view").
 *
 * WHY NOT browserSetting(). A boolean would store `gridView: true|false`, which
 * reads as "grid is the special case" and cannot grow a third layout without a
 * migration; and the persisted text ("on"/"off") would say nothing about what is
 * on screen when a human opens localStorage. Storing the MODE NAME keeps the
 * stored value and the code's vocabulary the same word.
 *
 * A stored value outside `modes` falls back to `modes[0]` rather than being
 * honoured: a hand-edited or older-build entry must not wedge a panel into a
 * layout this build has no CSS for. Same defensive posture as
 * browserNumberSetting's clamp, for the same reason.
 *
 * Returns `{key, modes, initial, persist, next}`:
 *   key      — the localStorage key.
 *   modes    — the allowed values, in cycle order (exposed so a toggle need not restate them).
 *   initial  — the stored mode, or `modes[0]` when unset/unrecognized. QUERY.
 *   persist  — persist(m) writes and returns m (throws on an unknown mode). COMMAND.
 *   next     — next(m) is the mode after m in cycle order, wrapping. PURE.
 *
 * @param {string} key localStorage key (e.g. "powerrp.slideNavView").
 * @param {string[]} modes Allowed modes, first one being the default.
 * @returns {{key: string, modes: string[], initial: string, persist: (m: string) => string, next: (m: string) => string}}
 *
 * @example // const S = browserModeSetting("powerrp.slideNavView", ["list", "grid"]);
 * @example // S.initial          // "list" when unset, else the stored mode
 * @example // S.next("list")     // "grid"
 * @example // S.next("grid")     // "list"  (cycles)
 * @example // S.persist("grid")  // "grid", and localStorage["powerrp.slideNavView"] === "grid"
 */
export function browserModeSetting(key, modes) {
  const stored = localStorage.getItem(key);
  return {
    key,
    modes,
    initial: modes.includes(stored) ? stored : modes[0],
    persist(m) {
      if (!modes.includes(m)) throw new Error(`browserModeSetting(${key}): unknown mode ${JSON.stringify(m)} — expected one of ${modes.join(", ")}`);
      localStorage.setItem(key, m);
      return m;
    },
    next(m) {
      const i = modes.indexOf(m);
      return modes[(i + 1) % modes.length];
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
