/**
 * recentColors.js — THE MOST-RECENTLY-USED COLOR LIST, one per browser.
 *
 * USER, 2026-08-08: *"The color palettes' should have a Most-Recently-used color
 * column on the right of the color thing too"*.
 *
 * IT IS APP-WIDE, NOT PER-FIELD, and that is the feature rather than an
 * implementation shortcut. "Recently used" means the colors YOU have been working
 * in — pick a brand blue in a fill and it must be one keystroke away in the next
 * widget's stroke. A list owned by each ColorField would give every field a private
 * history, which is the opposite of what the words mean and would leave the column
 * empty exactly when it is most wanted (the second widget). So there is ONE list,
 * this module owns it, and `src/lib/ColorPicker.svelte` takes it as a plain prop and
 * stores nothing — the shared library stays stateless (root CLAUDE.md: "src/lib/
 * stays clean").
 *
 * STORAGE FOLLOWS THE COMMAND MRU'S PRECEDENT EXACTLY (`web/app.svelte.js` writes
 * `localStorage["powerrp.mru"]` after every command run). Same store, adjacent key,
 * same "write on use, tolerate absence" shape — a second persistence mechanism for
 * the same kind of fact is how two sources of truth get born.
 *
 * IT IS NOT DOCUMENT STATE. Nothing here reaches a render tree: the list is about
 * the EDITOR's history, not about what a slide looks like, so it never enters the
 * fold, never serializes into `doc.json`, and cannot make two viewers of one deck
 * disagree. That is why localStorage is the right home and `meta` is not.
 *
 * DOM-touching (localStorage) — a web-only module, never imported by the DOM-free
 * core.
 */

/** The localStorage key. Namespaced like `powerrp.mru` so the two read as siblings. */
const STORAGE_KEY = "powerrp.recentColors";

/**
 * How many swatches the column holds. Twelve because the column is capped at the
 * picker's square height (`--cp-square-size`, 160px) and a 12px swatch + 4px gap
 * fits ten there — two more scroll, which is a hint that the list continues rather
 * than a wall. Small on purpose: an MRU that remembers everything is a palette, and
 * a palette is a different feature with different affordances (naming, reordering).
 */
export const RECENT_COLORS_MAX = 12;

/** In-memory mirror, so a read per keystroke does not hit localStorage. */
let cache = null;

/**
 * Pure function. Is `v` one of the hex forms the app stores? Mirrors
 * ColorPicker.isHex rather than importing it, because this module must not depend
 * on a Svelte component — restated in one place, and the ONLY consumer of the
 * answer is the filter below.
 *
 * @param {*} v
 * @returns {boolean}
 *
 * @example isStorableColor("#ff0080ff") // true
 * @example isStorableColor("#f08") // true
 * @example isStorableColor("= self.fill") // false (an equation is not a color)
 * @example isStorableColor(null) // false
 */
export function isStorableColor(v) {
  return typeof v === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
}

/**
 * Pure function. `list` with `color` moved to the front, de-duplicated
 * CASE-INSENSITIVELY, and truncated to `max`.
 *
 * DE-DUPLICATION IS THE WHOLE POINT OF A SEPARATE FUNCTION. Without it, nudging one
 * slider fills the column with twelve near-identical swatches of the same color and
 * the feature is useless within one gesture. Case-insensitively because the picker
 * emits lowercase but a hand-typed `#FF0080FF` is the same color, and a column
 * showing both would be lying about having two.
 *
 * MOVE-TO-FRONT, NOT "SKIP IF PRESENT": re-picking an old color makes it recent
 * again, which is what "recently used" means.
 *
 * @param {string[]} list - the current list, newest first
 * @param {string} color - the color just used
 * @param {number} [max] - cap
 * @returns {string[]} a NEW array
 *
 * @example withColorUsed([], "#ff0000ff") // ["#ff0000ff"]
 * @example withColorUsed(["#00ff00ff"], "#ff0000ff") // ["#ff0000ff", "#00ff00ff"]
 * @example withColorUsed(["#a", "#ff0000ff", "#b"], "#FF0000FF") // ["#FF0000FF", "#a", "#b"]
 * @example withColorUsed(["#111111ff", "#222222ff"], "#111111ff") // ["#111111ff", "#222222ff"]
 */
export function withColorUsed(list, color, max = RECENT_COLORS_MAX) {
  const key = color.toLowerCase();
  return [color, ...list.filter((c) => c.toLowerCase() !== key)].slice(0, max);
}

/**
 * Query (reads localStorage once, then a module cache). The recent colors, newest
 * first. Never throws: a corrupt or absent entry is an EMPTY list, because an
 * unreadable history is not an error condition the user can act on and a thrown
 * exception here would take the whole Inspector down with it.
 *
 * @returns {string[]}
 *
 * @example recentColors() // ["#ff0080ff", …] or []
 */
export function recentColors() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isStorableColor).slice(0, RECENT_COLORS_MAX) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * Command (mutates the cache + localStorage). Record that `color` was used and
 * return the new list.
 *
 * CALL IT ON COMMIT, NOT ON PREVIEW. A drag across the saturation square fires
 * `oninput` continuously; recording each one would push a dozen shades of the same
 * hue through the column per gesture and evict everything genuinely older. The
 * settle event (`onchange`) is the one that means "the user chose this".
 *
 * A non-color (an equation-bound field, an unparseable draft) is IGNORED rather than
 * stored — silently, because it is not a failure: those fields legitimately hold
 * things that are not colors.
 *
 * A localStorage write that fails (private mode, quota) leaves the in-memory list
 * updated and is swallowed: the column still works for this session, and nagging
 * about a history that will not persist is noise the user cannot act on.
 *
 * @param {string} color - "#rrggbbaa" (or any accepted hex)
 * @returns {string[]} the new list, newest first
 *
 * @example // markColorUsed("#ff0080ff") -> ["#ff0080ff", …]
 */
export function markColorUsed(color) {
  if (!isStorableColor(color)) return recentColors();
  cache = withColorUsed(recentColors(), color);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // persistence is best-effort; the session's list is already correct
  }
  return cache;
}

/**
 * Command. Drops the list (tests, and a future "clear history" affordance).
 *
 * @example // clearRecentColors(); recentColors() // []
 */
export function clearRecentColors() {
  cache = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // see markColorUsed
  }
}
