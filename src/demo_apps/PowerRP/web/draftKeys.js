/**
 * draftKeys.js — the DOM-FREE half of the working-copy model.
 *
 * WHY IT IS SPLIT FROM web/projectDraft.js (the same reason web/assetRef.js is
 * split from web/assetStore.js): projectDraft.js reaches the IndexedDB asset
 * store to STAGE bytes, which drags in `location` at module scope and cannot
 * load in bare node. These functions are pure — key naming, name validation,
 * the share-URL shape, the persisted-marker parse — and they are exactly the
 * parts a test should be able to execute with no browser at all.
 *
 * READ web/projectDraft.js FIRST for the invariant these implement. The one
 * clause that lives HERE, as executable code rather than prose, is that the
 * draft key is UNUSABLE as a project name: `validProjectName(DRAFT_KEY)` is
 * false, and a test pins it so that loosening the server's name rule fails
 * loudly instead of silently making a draft saveable.
 *
 * IT ALSO OWNS THE SAVE-GESTURE RULES, for the same reason: `isUnsavedDraft`,
 * `saveCommandFor`, `saveText` and `openNeedsConfirm` are the four decisions
 * behind "which Save is available", "what does Cmd+S do", "what does the dot
 * say" and "must this open ask first". Each is a pure function of state a test
 * can hand it, so the gate executes the RULE rather than a browser's rendering
 * of it — and the four surfaces (command gate, keybinding, indicator, guard)
 * read one definition instead of four agreeing copies.
 */

/**
 * The reserved keyspace prefix for staged draft assets. Contains "/", which the
 * server's `_SAFE_NAME` forbids in a project name — see invariant clause 3.
 * Exported so the tests assert against the SAME constant the app stages under.
 */
export const DRAFT_KEY_PREFIX = "~draft/";

/**
 * THE draft key. One draft at a time, like every editor's working copy: opening
 * a new zip overwrites the previous staging rather than accumulating keyspaces
 * nobody can see or clean up.
 */
export const DRAFT_KEY = `${DRAFT_KEY_PREFIX}current`;

/** localStorage key remembering the open draft's `{name, sourceUrl}` across a
 *  reload. The DOCUMENT itself rides the existing `powerrp.autosave`; this holds
 *  only the two facts autosave cannot carry — that the restored doc is a draft
 *  at all, and where it came from (which gates the share link). */
export const DRAFT_STATE_KEY = "powerrp.draft";

/**
 * Pure function. Whether `name` is a draft keyspace key rather than a real
 * project name.
 *
 * The one predicate every "is this in the library?" question routes through, so
 * that the answer cannot drift between the Save path, the listing filter and the
 * tests.
 *
 * @param {string} name A project name or storage key.
 * @returns {boolean}
 *
 * @example isDraftKey("~draft/current")
 * true
 * @example isDraftKey("RobotSim")
 * false
 * @example // a real name can never look like one — the server forbids "/" in names:
 * isDraftKey("My Talk")
 * false
 */
export function isDraftKey(name) {
  return String(name ?? "").startsWith(DRAFT_KEY_PREFIX);
}

/**
 * Pure function. Whether `name` could be a real project name under the server's
 * rule (`_SAFE_NAME` in server.py: no "/", no "\", no NUL, not "." or "..").
 *
 * THIS IS THE PROOF OBLIGATION BEHIND THE DRAFT KEY, written as code so a test
 * can execute it: `validProjectName(DRAFT_KEY)` must be false forever. If
 * someone ever loosens the server rule to permit slashes, that test fails and
 * names the problem, instead of a draft silently becoming a saveable project.
 *
 * @param {string} name Candidate project name.
 * @returns {boolean}
 *
 * @example validProjectName("My Talk")
 * true
 * @example validProjectName("~draft/current")
 * false
 * @example validProjectName("..")
 * false
 * @example validProjectName("")
 * false
 */
export function validProjectName(name) {
  const s = String(name ?? "");
  if (!s || s === "." || s === "..") return false;
  return !/[/\\\0]/.test(s);
}

/**
 * The display name a document carries when it has never been named. Repair mints
 * it and `projectDisplayName()` falls back to it, so the placeholder has ONE
 * spelling across the app.
 *
 * IT IS A DISPLAY DEFAULT, NOT A STATE. It deliberately does NOT appear in
 * `isUnsavedDraft` — see the ruling recorded there. A document is a draft because
 * it is not in the library, never because of what it happens to be called.
 */
export const UNTITLED_NAME = "Untitled";

/**
 * Pure function. IS THE OPEN WORKING COPY AN UNSAVED DRAFT — i.e. is it NOT in
 * the project library?
 *
 * ====== THE UNIFICATION (user ruling) ======================================
 *
 * "When we are renaming the Untitled project, that should be the same as saving
 * a new project. Untitled is a special project — I shouldn't be allowed to just
 * save it; it needs to Save-As-New, just like every other editor."
 *
 * The working-copy model shipped with ONE way to be outside the library: an
 * IMPORTED draft (`draftMode` set — a dropped .zip or a share link). But a FRESH
 * document is outside it for exactly the same reason and was silently treated as
 * a saved project called "Untitled" — so Save wrote a library entry named
 * "Untitled" with no ceremony, and Rename tried to MOVE a folder that was never
 * there. Both are the same state, so this predicate answers for both:
 *
 *   1. `draftMode` — an import. Already the model's answer; unchanged.
 *   2. `everSaved` IS FALSE — a fresh document. Nothing has ever passed through
 *      the library seam for this working copy, so there is no entry to write to.
 *
 * ====== THE NAME IS NOT PART OF THIS, AND THAT IS THE FIX =================
 *
 * An earlier draft of this function ALSO required the name to be the placeholder
 * ("Untitled" or blank) before it would call a never-saved document a draft. That
 * is WRONG, and the ruling above is what makes it wrong: renaming an unsaved
 * document IS naming it at save time, so it cannot be the act that promotes it
 * into the library. Under the name clause, a user who typed "Draft ideas" into
 * the title before ever saving would silently acquire a quick-Save that wrote a
 * library entry with no naming ceremony and no collision check — exactly the
 * "I shouldn't be allowed to just save it" case, re-created one keystroke later.
 * So: `everSaved === false` ALONE defines a draft, and the doctest below pins
 * that renamed-never-saved case forever.
 *
 * WHY `everSaved` IS THE HONEST SIGNAL. It is set by the two gestures that put a
 * working copy in correspondence with a library entry, and by nothing else:
 * `loadProject` (opened FROM the library) and a successful save INTO it. Opening
 * "RobotSim" therefore reads as saved even before the first write, which is
 * correct — the entry exists and Save updates it. And a document genuinely NAMED
 * "Untitled" in the library is saved too, because it was loaded or written.
 *
 * @param {{name: string, sourceUrl: string}|null} draftMode The imported-draft marker, or null.
 * @param {boolean} everSaved Whether this working copy has ever been read from, or written to, the library.
 * @returns {boolean}
 *
 * @example // a fresh document: nothing in the library to save into
 * isUnsavedDraft(null, false)
 * true
 * @example // THE RULING: renaming a never-saved document does NOT save it
 * isUnsavedDraft(null, false) // meta.name is now "Draft ideas" — still a draft
 * true
 * @example // an imported .zip: the draft marker answers on its own
 * isUnsavedDraft({name: "RobotSim", sourceUrl: ""}, false)
 * true
 * @example // an ordinary open library project — Save writes it in place
 * isUnsavedDraft(null, true)
 * false
 * @example // a library project genuinely NAMED "Untitled" is saved like any other
 * isUnsavedDraft(null, true)
 * false
 */
export function isUnsavedDraft(draftMode, everSaved) {
  return Boolean(draftMode) || !everSaved;
}

/**
 * Pure function. WHICH SAVE GESTURE Cmd+S means right now — the one dispatch
 * rule, written where a bare-node test can execute it.
 *
 * Cmd+S is the universal editor binding and it means "save", never "open a
 * dialog" — EXCEPT when there is nothing to save TO. So it resolves to the quick
 * save for a library project and to the naming flow for a draft, which is exactly
 * what every other editor does and what makes the key safe to press blind.
 *
 * @param {boolean} draft From isUnsavedDraft.
 * @returns {"save-project"|"save-project-as"} The command id to run.
 *
 * @example saveCommandFor(false)
 * 'save-project'
 * @example // a draft has no library entry to write into, so Cmd+S must name it first
 * saveCommandFor(true)
 * 'save-project-as'
 */
export function saveCommandFor(draft) {
  return draft ? "save-project-as" : "save-project";
}

/**
 * Pure function. The save indicator's hover sentence.
 *
 * FOUR SENTENCES, NOT THREE, because "unsaved" was answering two different
 * questions with one string. "Unsaved changes" is a true statement about a
 * project that EXISTS in the library and has drifted from it; it is a misleading
 * one about a draft, which has no library copy at all — there are no "changes",
 * there is nothing there. The dot is the same in both cases (a ring), so the
 * sentence is the only place the difference can be told.
 *
 * @param {"saving"|"saved"|"unsaved"} state From app.saveState().
 * @param {number|null} at Epoch ms of the last successful save, or null.
 * @param {boolean} draft From isUnsavedDraft.
 * @param {string} noun The STORAGE_NOUN — "server" or "browser".
 * @returns {string}
 *
 * @example saveText("saving", null, false, "server")
 * 'Saving…'
 * @example // a DRAFT: nothing of it is in the library, so it has no "changes" to be unsaved
 * saveText("unsaved", null, true, "server")
 * 'Not saved yet — this draft is not on the server. Use Save As… to name it.'
 * @example // a saved project that has drifted from its stored copy
 * saveText("unsaved", null, false, "browser")
 * 'Unsaved changes — not yet saved to the browser'
 * @example saveText("saved", null, false, "server")
 * 'Saved to server'
 * @example // saved, with a time — e.g. "Saved to server at 14:32:05"
 * saveText("saved", 1750000000000, false, "server").startsWith("Saved to server at ")
 * true
 */
export function saveText(state, at, draft, noun) {
  if (state === "saving") return "Saving…";
  if (state === "unsaved") {
    if (draft) return `Not saved yet — this draft is not ${noun === "browser" ? "in this browser's library" : "on the server"}. Use Save As… to name it.`;
    return `Unsaved changes — not yet saved to the ${noun}`;
  }
  return at ? `Saved to ${noun} at ${new Date(at).toLocaleTimeString()}` : `Saved to ${noun}`;
}

/**
 * WHY quick-Save is unavailable on a draft — the command entry's `requires`
 * string, which the palette, the Tools pane and the Toolbar all render as
 * "Unavailable — requires <this>".
 *
 * IT LIVES HERE, NOT IN THE COMMAND ENTRY, because the gate and the reason are
 * two halves of one rule: `when: (a) => !a.isDraft()` and this sentence must
 * never drift apart, and the browser probe asserts on the exact text.
 *
 * @example SAVE_NEEDS_SAVE_AS
 * 'a saved project — this one is not saved yet, so use Save As…'
 */
export const SAVE_NEEDS_SAVE_AS = "a saved project — this one is not saved yet, so use Save As…";

/**
 * Pure function. Does an OPEN — one that REPLACES the working copy — need to ask
 * the user first?
 *
 * THE RULING (user, verbatim): "if I've been working on something and then
 * suddenly I open a new URL, what happens? Can opening a link break my project?"
 * and "perhaps it should ask me — would you like to save this current
 * presentation before opening a new one? Same thing if I drag a zip into it."
 *
 * TWO WAYS TO HAVE WORK AT RISK, and both must prompt, because the loss is the
 * same size either way:
 *   · AN UNSAVED DRAFT — nothing of it is in the library, so replacing it loses
 *     ALL of it.
 *   · A SAVED PROJECT WITH UNSAVED CHANGES — the library holds an older copy, so
 *     replacing it loses the edits since.
 * A saved-and-clean working copy is fully recoverable by reopening it, so it
 * opens with no ceremony. That exemption is what keeps the prompt meaningful:
 * a dialog that appears every time is one nobody reads.
 *
 * A SAVE IN FLIGHT counts as dirty. `saveState()` reports "saving" while the
 * request is out, and its outcome is not known yet — treating an unresolved save
 * as clean would let an open race a write.
 *
 * @param {boolean} draft From isUnsavedDraft.
 * @param {"saving"|"saved"|"unsaved"} state From app.saveState().
 * @returns {boolean}
 *
 * @example // a fresh or imported draft always has everything to lose
 * openNeedsConfirm(true, "unsaved")
 * true
 * @example // a saved project that has drifted from its stored copy
 * openNeedsConfirm(false, "unsaved")
 * true
 * @example // saved and clean: reopening it restores it, so no ceremony
 * openNeedsConfirm(false, "saved")
 * false
 * @example // an in-flight save has an unknown outcome — never treat it as clean
 * openNeedsConfirm(false, "saving")
 * true
 */
export function openNeedsConfirm(draft, state) {
  return draft || state !== "saved";
}

/** Filenames that name a FORMAT rather than a deck. A URL ending in "/deck.zip"
 *  or "/download.zip" carries no information the archive's own root does not
 *  carry better, so these lose to it — see draftDisplayName. Lowercase; the
 *  comparison is case-insensitive. */
const GENERIC_ZIP_NAMES = ["deck", "download", "project", "archive", "export", "presentation", "file", "tmp", "temp"];

/**
 * Pure function. The human project name a draft should DISPLAY, given the name
 * derived from the file/URL and the archive's own root folder.
 *
 * THE RULE IS "MOST INFORMATIVE WINS", not "file always wins", and the
 * difference is a real defect caught by tests/zip_url_boot_probe.js: a share
 * link ending in `/deck.zip` was titling every shared deck "deck", throwing away
 * the archive root that said "SharedDeck". So:
 *
 *   1. A SPECIFIC file name wins. Dropping "Robot Sim.zip" titles the deck
 *      "Robot Sim" even when its archive root says "Untitled" — which every
 *      pre-localization export says (commit 7f52bae), so the file is genuinely
 *      the better source there.
 *   2. A GENERIC file name LOSES to a real archive root. "deck.zip",
 *      "download.zip" and friends describe the transport, not the deck.
 *   3. Failing both, a last resort keeps the title from going blank.
 *
 * @param {string} requested Name derived from the file/URL, may be "".
 * @param {string} root The archive's root folder name, may be "".
 * @returns {string}
 *
 * @example draftDisplayName("Robot Sim", "Untitled")
 * 'Robot Sim'
 * @example // a URL ending in /deck.zip must not out-vote the archive's own name:
 * draftDisplayName("deck", "SharedDeck")
 * 'SharedDeck'
 * @example // …but with nothing better, even a generic name beats going blank:
 * draftDisplayName("deck", "")
 * 'deck'
 * @example draftDisplayName("", "My Talk")
 * 'My Talk'
 * @example draftDisplayName("", "")
 * 'Imported Project'
 */
export function draftDisplayName(requested, root) {
  const file = String(requested ?? "").trim();
  const archive = String(root ?? "").trim();
  if (file && !GENERIC_ZIP_NAMES.includes(file.toLowerCase())) return file;
  return archive || file || "Imported Project";
}

/**
 * Pure function. The share URL for a draft that came from `sourceUrl`.
 *
 * ORIGIN + PATH ONLY — any existing query is DROPPED rather than merged. A share
 * link must reproduce the deck and nothing else: carrying `?static=1` or a
 * `?backend=` from whoever generated it would hand the recipient someone else's
 * storage mode, and carrying a stale `?zip=` would double the parameter.
 *
 * @param {string} pageUrl The current page URL (location.href).
 * @param {string} sourceUrl The URL the draft's zip was fetched from.
 * @returns {string}
 *
 * The source URL is FORM-encoded (URLSearchParams), so a space becomes "+" and
 * its own "?"/"&"/"=" are escaped — a shared deck whose URL carries a query
 * cannot smuggle extra parameters into the share link. What is guaranteed is the
 * ROUND TRIP: the recipient's `?zip=` reads back byte-identical.
 *
 * @example shareUrl("https://host.dev/SvelteLib/?static=1", "https://cdn.dev/deck.zip")
 * 'https://host.dev/SvelteLib/?zip=https%3A%2F%2Fcdn.dev%2Fdeck.zip'
 * @example shareUrl("https://host.dev/app/index.html", "https://x.dev/a b.zip")
 * 'https://host.dev/app/index.html?zip=https%3A%2F%2Fx.dev%2Fa+b.zip'
 */
export function shareUrl(pageUrl, sourceUrl) {
  const page = new URL(pageUrl);
  return `${page.origin}${page.pathname}?${new URLSearchParams({ zip: sourceUrl })}`;
}

/**
 * Pure function. Read the persisted draft state back out of its stored string.
 *
 * Tolerant of ABSENCE and GARBAGE for the same reason the autosave path is: a
 * hand-edited or half-written localStorage value must cost at most the share
 * link, never a boot. It is the ONLY forgiving parse in this file.
 *
 * @param {string|null} rawJson The stored string, or null when unset.
 * @returns {{name: string, sourceUrl: string}|null}
 *
 * @example draftStateFromJson('{"name":"RobotSim","sourceUrl":"https://x.dev/a.zip"}')
 * {name: 'RobotSim', sourceUrl: 'https://x.dev/a.zip'}
 * @example draftStateFromJson(null)
 * null
 * @example draftStateFromJson("{{ not json")
 * null
 */
export function draftStateFromJson(rawJson) {
  if (!rawJson) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null; // a corrupt marker costs the share link, never the boot
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string" || !parsed.name) return null;
  return { name: parsed.name, sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : "" };
}
