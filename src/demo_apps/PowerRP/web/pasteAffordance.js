/**
 * pasteAffordance.js — WHAT THE PASTE BUTTON SAYS IT WILL DO, as pure functions.
 *
 * DOM-free, like web/draftKeys.js and for the same reason: these are RULES about
 * what a gesture means, and a test should execute the rule rather than a
 * browser's rendering of it. Toolbar.svelte is a renderer over `pasteAffordance`
 * and holds none of the decisions below.
 *
 * ── WHAT THE USER ASKED FOR (2026-08-02, verbatim) ───────────────────────────
 * "the paste button tool tip should... and also the paste icon should change
 *  depending on what will happen. There's different modes of pasting... The
 *  paste icon should have a little badge on it, on maybe the bottom right or top
 *  right or something that says if it's an abnormal kind of paste and I'm not
 *  just pasting a widget, what am I pasting? Teeny little badge and of course
 *  the hover tool tip should say too."
 *
 * Two deliverables, one source: a BADGE that appears only when the paste is NOT
 * an ordinary widget paste and says WHICH abnormal kind it is, and a TOOLTIP
 * that states what pressing the button would DO right now.
 *
 * ── THE BADGE APPEARS ONLY FOR AN ABNORMAL PASTE ─────────────────────────────
 * "if it's an abnormal kind of paste and I'm not just pasting a widget" is the
 * gate, and it is a real one rather than a decoration: a badge on every paste is
 * a badge that says nothing, because it no longer distinguishes. So the ordinary
 * widget paste — the overwhelmingly common case — carries NO badge, and the
 * badge's presence is itself the signal that something unusual is on the
 * clipboard. `pasteBadge` returns null there, deliberately and by test.
 *
 * ── THE TOOLTIP IS A SENTENCE ABOUT THIS MOMENT, NOT A DESCRIPTION ───────────
 * The registry `title` says what the command IS ("Paste"); this says what it
 * would DO, which depends on the clipboard's kind AND the selection — the two
 * inputs the WORKSTREAM UU dispatch reads. "Apply copied Position to the 2
 * selected widgets" and "Paste properties onto their original widgets (nothing
 * selected)" are the SAME command with the same clipboard, told apart only by
 * whether something is selected, and that difference is exactly what the user
 * cannot see without being told.
 *
 * It follows the function-valued `requires` precedent (core/commands.js — a gate
 * with several disqualifying conditions has several true sentences, and a fixed
 * string would be a confident wrong answer for all but one). The same reasoning
 * applies here for the same reason: a static "Pastes the last copied element or
 * property" is a true sentence about the command and a useless one about the
 * click.
 *
 * ── THE CLIPBOARD KIND IS READ SYNCHRONOUSLY, AND THAT IS A REAL BOUND ───────
 * A tooltip and a badge render during a synchronous pass, and the AUTHORITATIVE
 * clipboard is the server-side session store behind an async fetch. So these
 * read the SAME in-browser mirror `app.canPasteProperties` documents itself
 * reading, and inherit its exact conservatism, stated rather than hidden:
 *
 *   • Copy-then-paste in THIS tab: exact. Every copy writes the mirror.
 *   • CROSS-TAB: the badge under-reports. A payload copied in another tab shows
 *     no badge and the neutral tip until this tab copies something — yet Ctrl+V
 *     and the button still paste it, because the ACTION reads the server through
 *     the async path. Under-promising on a hint beats a hint that claims a
 *     properties paste and delivers a widget one.
 *   • An OS-CLIPBOARD IMAGE cannot be seen at all from here: `navigator.clipboard.read()`
 *     is async AND permission-gated, and the `paste` ClipboardEvent — the only
 *     synchronous view of the OS clipboard a browser gives — exists only DURING
 *     a paste. So the image badge is driven by the LAST OBSERVED external paste
 *     (`osImageSeen`, which App.svelte's onPaste sets), never by a guess. When
 *     nothing has been observed, there is no image badge; the button does not
 *     claim knowledge it has no way to have.
 *
 * That last bullet is the honest version of "an image glyph for an external
 * image paste". The alternative — badging an image whenever our own clipboard is
 * empty, on the theory that an external paste is what is left — would show an
 * image badge for a genuinely empty clipboard, which is a confident wrong answer
 * about the one case the user is most likely to hit by accident.
 */

/**
 * The paste kinds a badge distinguishes, and what each one's badge MEANS. The
 * `id` is what a probe asserts on (`data-paste-badge`), the `icon` is the glyph,
 * and `label` is the badge's accessible name.
 *
 * WHY THESE FOUR AND NOT MORE. The badge is teeny — the user's word — so its
 * glyph must be legible at roughly a third of an 18px icon. Four distinguishable
 * silhouettes is what that size honestly supports; a fifth would be two badges
 * nobody can tell apart, which is worse than one badge that groups them.
 *
 * THE SUBSETS DO GET THEIR OWN GLYPHS, and that was a legibility judgement made
 * by looking rather than by wishing: `mdi:axis-arrow` (Copy Position's own icon)
 * and `mdi:ruler-square` (Copy Dimensions') are a CROSS and a SQUARE — two
 * shapes that survive being shrunk, because neither depends on interior detail.
 * `mdi:vector-square` (Copy Box) is a square with corner marks and reads as
 * "square" at size, which is a legitimate confusion with Dimensions — so Box is
 * NOT given its own badge and rides the general properties glyph, with the
 * tooltip naming it exactly. A badge that is ambiguous about which of two
 * subsets is on the clipboard is worse than one that says "properties" and
 * defers the detail to the sentence a hover already shows.
 *
 * @example PASTE_BADGES.properties.icon
 * // 'mdi:text-box-multiple-outline'
 * @example PASTE_BADGES.position.label
 * // 'copied position'
 * @example Object.keys(PASTE_BADGES).sort()
 * // ["dimensions", "image", "position", "properties"]
 */
export const PASTE_BADGES = {
  properties: { icon: "mdi:text-box-multiple-outline", label: "copied properties" },
  position: { icon: "mdi:axis-arrow", label: "copied position" },
  dimensions: { icon: "mdi:ruler-square", label: "copied dimensions" },
  image: { icon: "mdi:image-outline", label: "image from the system clipboard" },
};

/**
 * The property key sets the subset copy verbs produce, as SORTED joined strings —
 * the lookup `propertySubsetKind` matches a payload against.
 *
 * SORTED AND JOINED so the match is on the SET rather than on capture order:
 * `itemPropertiesPayload` preserves the order its `keys` argument was given in,
 * and a future caller passing ["y", "x"] means the same thing.
 *
 * These mirror web/App.svelte's copy-position / copy-dimensions / copy-box
 * entries. THAT IS A DUPLICATION AND IT IS GATED: tests/paste_affordance_test.js
 * reads the command entries' `run` source and asserts the key lists agree, so
 * adding a fourth subset verb without a badge fails loudly instead of showing the
 * generic properties glyph forever.
 *
 * @example SUBSET_KEY_SETS["x,y"]
 * // 'position'
 * @example SUBSET_KEY_SETS["h,w"]
 * // 'dimensions'
 * @example SUBSET_KEY_SETS["h,w,x,y"]
 * // 'box'
 */
export const SUBSET_KEY_SETS = {
  "x,y": "position",
  "h,w": "dimensions",
  "h,w,x,y": "box",
};

/**
 * Pure function. Which SUBSET verb produced this properties payload — "position",
 * "dimensions", "box", or null for a whole-state Copy Properties.
 *
 * The payload's items must AGREE on their key set, and they do by construction
 * (one `keys` argument captures every item); a payload whose items disagree is
 * not a subset copy this can name, so it reads as the general case rather than
 * guessing from the first item.
 *
 * @param {object} payload - a `powerrp_item_props` payload
 * @returns {"position"|"dimensions"|"box"|null}
 *
 * @example propertySubsetKind({powerrp_item_props: {a: {x: 1, y: 2}}})
 * // 'position'
 * @example propertySubsetKind({powerrp_item_props: {a: {w: 8, h: 4}, b: {w: 1, h: 1}}})
 * // 'dimensions'
 * @example propertySubsetKind({powerrp_item_props: {a: {x: 1, y: 2, w: 8, h: 4}}})
 * // 'box'
 * @example propertySubsetKind({powerrp_item_props: {a: {x: 1, y: 2, fill: "#f00"}}})
 * // null   (a whole-state copy — no subset names it)
 * @example propertySubsetKind({powerrp_item_props: {a: {x: 1, y: 2}, b: {w: 8, h: 4}}})
 * // null   (items disagree — not a subset copy)
 */
export function propertySubsetKind(payload) {
  const states = Object.values(payload?.powerrp_item_props ?? {});
  if (!states.length) return null;
  const signature = (s) => Object.keys(s).sort().join(",");
  const first = signature(states[0]);
  if (!states.every((s) => signature(s) === first)) return null;
  return SUBSET_KEY_SETS[first] ?? null;
}

/**
 * Pure function. THE CLIPBOARD'S KIND, as the one word every affordance below
 * branches on — a normalization of the mirror payload plus the observed-image
 * flag, so nothing downstream re-derives it.
 *
 * `osImageSeen` is the LAST OBSERVED external image paste (see the header's
 * third bullet: there is no synchronous way to look at the OS clipboard, so this
 * is a memory of one, not a reading of one). It is the WEAKEST evidence here and
 * ranks last accordingly: an internal payload always wins, because our own copy
 * also writes a PNG to the OS clipboard, so an image alone is never proof the
 * user meant the image (the same precedence `app.#isForeignFilePaste` settles at
 * paste time, and this must not contradict it).
 *
 * @param {object|null} payload - the mirror's parsed payload, or null when empty/unreadable
 * @param {boolean} [osImageSeen] - has an external image paste been observed in this session?
 * @returns {"items"|"properties"|"image"|"empty"}
 *
 * @example clipboardKind({powerrp_items: {a: {type: "rect"}}})
 * // 'items'
 * @example clipboardKind({powerrp_item_props: {a: {x: 1}}})
 * // 'properties'
 * @example clipboardKind(null, true)
 * // 'image'
 * @example clipboardKind({powerrp_items: {a: {}}}, true)
 * // 'items'   (ours wins — our own copy also writes a PNG, so an image is not proof)
 * @example clipboardKind(null)
 * // 'empty'
 */
export function clipboardKind(payload, osImageSeen = false) {
  if (payload?.powerrp_items) return "items";
  if (payload?.powerrp_item_props) return "properties";
  if (osImageSeen) return "image";
  return "empty";
}

/**
 * Pure function. THE BADGE, or null when the paste is an ordinary widget paste —
 * the header's gate, and the reason a badge means something when it appears.
 *
 * `empty` gets no badge either: there is nothing abnormal about an empty
 * clipboard, and a badge there would be an error indicator the user cannot act
 * on. The tooltip says it instead, which is where a "nothing will happen"
 * belongs.
 *
 * @param {"items"|"properties"|"image"|"empty"} kind - clipboardKind's answer
 * @param {"position"|"dimensions"|"box"|null} [subset] - propertySubsetKind's answer
 * @returns {{id: string, icon: string, label: string}|null}
 *
 * @example pasteBadge("items")
 * // null   (an ordinary widget paste is not abnormal — no badge)
 * @example pasteBadge("empty")
 * // null
 * @example pasteBadge("properties").id
 * // 'properties'
 * @example pasteBadge("properties", "position").icon
 * // 'mdi:axis-arrow'
 * @example pasteBadge("properties", "box").id
 * // 'properties'   (box's glyph is not legible against dimensions' — the tip names it)
 * @example pasteBadge("image").icon
 * // 'mdi:image-outline'
 */
export function pasteBadge(kind, subset = null) {
  if (kind === "image") return { id: "image", ...PASTE_BADGES.image };
  if (kind !== "properties") return null;
  const id = subset === "position" || subset === "dimensions" ? subset : "properties";
  return { id, ...PASTE_BADGES[id] };
}

/**
 * Pure function. What a properties payload's contents are CALLED in a sentence —
 * "Position", "Dimensions", "Box" or the general "properties".
 *
 * Capitalized for the three named subsets because they are the COMMAND names the
 * user pressed (Copy Position); lowercase for the general case because
 * "properties" is a common noun there, not a verb's name.
 *
 * @param {"position"|"dimensions"|"box"|null} subset - propertySubsetKind's answer
 * @returns {string}
 *
 * @example subsetNoun("position")
 * // 'Position'
 * @example subsetNoun(null)
 * // 'properties'
 */
export function subsetNoun(subset) {
  if (subset === "position") return "Position";
  if (subset === "dimensions") return "Dimensions";
  if (subset === "box") return "Box";
  return "properties";
}

/**
 * Pure function. THE SENTENCE the paste button's tooltip shows — what pressing it
 * would do RIGHT NOW, given what is on the clipboard and what is selected.
 *
 * The cases, and why each is worth its own sentence rather than a shared one:
 *   • WIDGETS → a count, because "Paste" gives no hint how many things are about
 *     to appear, and pasting 12 widgets by accident is a real event.
 *   • PROPERTIES + a selection → the WORKSTREAM UU retarget, named with both the
 *     thing being applied and how many targets it lands on. This is the sentence
 *     that exists because the same command does two different things.
 *   • PROPERTIES + no selection → the per-id transport, and it says "(nothing
 *     selected)" out loud. Without that clause the two properties sentences read
 *     as unrelated behaviours rather than as the one dispatch the user ruled on;
 *     with it, the tooltip TEACHES the rule instead of merely obeying it.
 *   • PROPERTIES, several copied, with a selection → the refusal, up front. It is
 *     the one case where pressing the button does nothing, and finding that out
 *     from a console warning after the click is strictly worse than reading it
 *     before.
 *   • IMAGE → names the source, since an image paste creates a widget from
 *     something that was never in this app.
 *   • EMPTY → says nothing will happen, which is the honest tip for a button that
 *     is about to report an empty clipboard.
 *
 * @param {object} facts - the clipboard and selection facts
 * @param {"items"|"properties"|"image"|"empty"} facts.kind - clipboardKind's answer
 * @param {number} [facts.itemCount] - how many widgets/items the payload carries
 * @param {"position"|"dimensions"|"box"|null} [facts.subset] - propertySubsetKind's answer
 * @param {number} [facts.selectedCount] - how many widgets are selected right now
 * @returns {string} one sentence, no trailing period (tooltip house style)
 *
 * @example pasteIntent({kind: "items", itemCount: 3})
 * // 'Paste 3 copied widgets'
 * @example pasteIntent({kind: "items", itemCount: 1})
 * // 'Paste 1 copied widget'
 * @example pasteIntent({kind: "properties", itemCount: 1, subset: "position", selectedCount: 2})
 * // 'Apply the copied Position to the 2 selected widgets'
 * @example pasteIntent({kind: "properties", itemCount: 1, subset: null, selectedCount: 1})
 * // 'Apply the copied properties to the 1 selected widget'
 * @example pasteIntent({kind: "properties", itemCount: 2, subset: null, selectedCount: 0})
 * // 'Paste properties onto their original widgets (nothing selected)'
 * @example pasteIntent({kind: "properties", itemCount: 3, subset: null, selectedCount: 2})
 * // 'Nothing will happen: 3 widgets were copied and 2 are selected, and there is no way to tell which belongs to which — deselect to paste each onto its own widget'
 * @example pasteIntent({kind: "image"})
 * // 'Paste the image from your system clipboard as a new widget'
 * @example pasteIntent({kind: "empty"})
 * // 'Nothing has been copied yet — this will report an empty clipboard'
 */
export function pasteIntent({ kind, itemCount = 0, subset = null, selectedCount = 0 }) {
  const widgets = (n) => `${n} ${n === 1 ? "widget" : "widgets"}`;
  if (kind === "items") return `Paste ${itemCount} copied ${itemCount === 1 ? "widget" : "widgets"}`;
  if (kind === "image") return "Paste the image from your system clipboard as a new widget";
  if (kind === "empty") return "Nothing has been copied yet — this will report an empty clipboard";
  // PROPERTIES — the WORKSTREAM UU dispatch, said out loud.
  const noun = subsetNoun(subset);
  const what = noun === "properties" ? "properties" : `the copied ${noun}`;
  if (selectedCount === 0)
    return `Paste ${what} onto ${itemCount === 1 ? "its original widget" : "their original widgets"} (nothing selected)`;
  if (itemCount > 1)
    return `Nothing will happen: ${widgets(itemCount)} were copied and ${selectedCount} ${selectedCount === 1 ? "is" : "are"} selected, ` +
      "and there is no way to tell which belongs to which — deselect to paste each onto its own widget";
  return `Apply the copied ${noun} to the ${selectedCount} selected ${selectedCount === 1 ? "widget" : "widgets"}`;
}
