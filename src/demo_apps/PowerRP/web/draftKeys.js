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
 * `saveCommandFor`, `saveText`, `quickSaveBlocker` and `openNeedsConfirm` are the
 * decisions behind "which Save is available", "what does Cmd+S do", "what does
 * the Save button say and show" and "must this open ask first". Each is a pure
 * function of state a test can hand it, so the gate executes the RULE rather than
 * a browser's rendering of it — and the surfaces (command gate, keybinding,
 * button state mark, tooltip, guard) read one definition instead of five agreeing
 * copies.
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
 * Pure function. The SAVE BUTTON's hover sentence — what the working copy's
 * relationship to its stored copy is, in one truthful line.
 *
 * FOUR SENTENCES, NOT THREE, because "unsaved" was answering two different
 * questions with one string. "Unsaved changes" is a true statement about a
 * project that EXISTS in the library and has drifted from it; it is a misleading
 * one about a draft, which has no library copy at all — there are no "changes",
 * there is nothing there. The state MARK is the same in both cases (a ring), so
 * the sentence is the only place the difference can be told.
 *
 * IT USED TO BE THE DOT'S SENTENCE (user ruling: "the unsaved-changes dot is kind
 * of the same thing as the save button — the same state"), and moving it changed
 * nothing about the text, only its anchor. That is the point of the merge: one
 * control, one state, one sentence, instead of a readout beside a button both
 * describing the same fact.
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
 * two halves of one rule — see `quickSaveBlocker`, which now returns BOTH, so
 * they are not merely kept in sync but are literally the same call. The browser
 * probe asserts on the exact text.
 *
 * @example SAVE_NEEDS_SAVE_AS
 * 'a saved project — this one is not saved yet, so use Save As…'
 */
export const SAVE_NEEDS_SAVE_AS = "a saved project — this one is not saved yet, so use Save As…";

/**
 * WHY quick-Save is unavailable on a CLEAN working copy — worded as the same
 * "requires <this>" clause the other two are.
 *
 * @example SAVE_NEEDS_CHANGES
 * 'changes to save — this project already matches its saved copy'
 */
export const SAVE_NEEDS_CHANGES = "changes to save — this project already matches its saved copy";

/**
 * WHY quick-Save is unavailable while a save is IN FLIGHT. Named alongside the
 * other two rather than left inline: all three are the same kind of thing (a
 * clause a surfacing renders after "Unavailable — requires"), and one of them
 * hiding in a function body is how the set stops being reviewable as a set.
 *
 * @example SAVE_NEEDS_FLIGHT_DONE
 * 'the save in flight to finish'
 */
export const SAVE_NEEDS_FLIGHT_DONE = "the save in flight to finish";

/**
 * Pure function. WHY quick-Save cannot run right now, or `null` when it can —
 * the WHOLE gate for `save-project`, in one place.
 *
 * ====== THE SECOND GATE (user ruling) ======================================
 *
 * "Should the save button be enabled when there are no changes?" — NO. A Save
 * that is lit while there is nothing to save is a button that lies twice: it
 * invites a click that will do nothing, and it withholds the one fact the user
 * actually asked it for (am I safe?). So a CLEAN working copy disables it, and
 * the reason says so.
 *
 * ORDER MATTERS, and draft loses to clean deliberately. A draft is ALWAYS dirty
 * (`saveState()` reports "unsaved" for a never-written document, because nothing
 * of it is stored), so the two conditions can only collide in the direction where
 * the draft reason is the true one — but stating the order makes that an
 * intention rather than an accident of evaluation.
 *
 * A SAVE IN FLIGHT IS NOT CLEAN AND NOT AVAILABLE. "saving" means the outcome is
 * unknown, so neither answer is honest: the working copy may or may not match
 * what is being written. Re-issuing a save on top of an unresolved one is what a
 * lit button would invite, so it is blocked with its own reason rather than
 * folded into either of the others.
 *
 * @param {boolean} draft From isUnsavedDraft.
 * @param {"saving"|"saved"|"unsaved"} state From app.saveState().
 * @returns {string|null} The `requires` clause, or null when quick-Save may run.
 *
 * @example // the case the whole gate is for: dirty, saved project — Save works
 * quickSaveBlocker(false, "unsaved")
 * null
 * @example // THE RULING: nothing to save, so the button is not lit
 * quickSaveBlocker(false, "saved")
 * 'changes to save — this project already matches its saved copy'
 * @example // a draft has no library entry at all — Save As… first
 * quickSaveBlocker(true, "unsaved")
 * 'a saved project — this one is not saved yet, so use Save As…'
 * @example // an in-flight save has an unknown outcome — do not invite a second one
 * quickSaveBlocker(false, "saving")
 * 'the save in flight to finish'
 */
export function quickSaveBlocker(draft, state) {
  if (draft) return SAVE_NEEDS_SAVE_AS;
  if (state === "saving") return SAVE_NEEDS_FLIGHT_DONE;
  if (state === "saved") return SAVE_NEEDS_CHANGES;
  return null;
}

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

/**
 * Pure function. WHICH TRANSPORT a typed "open a project from…" string names —
 * the one grammar decision behind the single input field.
 *
 * ====== ONE INPUT, TWO GRAMMARS (user ruling) ==============================
 *
 * "Open Project from URL should have a github link example in it — literally the
 * one we have now — saying it can be a zip from anywhere or a github
 * repository/branch", and "it should support branches too".
 *
 * So the field accepts BOTH of the things a person actually has on their
 * clipboard, and decides between them rather than making the user pick a mode
 * first. A radio pair would be a question the app can answer itself: the two
 * grammars are not ambiguous with each other.
 *
 * THE RULE, and why it is this way round:
 *   · ANYTHING WITH A SCHEME IS A URL. `https://…/deck.zip` is a zip; and
 *     `https://github.com/owner/name` is ALSO routed to the repo loader, because
 *     parseRepoSlug accepts that form and it is what the repo page's address bar
 *     says. Scheme-first means a URL is never mistaken for a slug.
 *   · …EXCEPT THAT A .zip PATH OUTRANKS THE HOST (user ruling, 2026-08-03: "it
 *     should check if it's a zip file first"). github.com serves RAW FILE links
 *     too — `…/raw/refs/heads/main/Deck.zip` — and the host rule alone shoved
 *     those at parseRepoSlug, which refused a perfectly good zip with a sentence
 *     about owner/name. A path ending in .zip names a FILE; no repo home page
 *     ever ends that way, so nothing real is stolen from the repo path.
 *   · OTHERWISE, `owner/name` WITH EXACTLY ONE SLASH IS A REPO, optionally
 *     `@ref` for a branch, tag or commit. This shape cannot be a URL — it has no
 *     scheme and no host — so nothing is stolen from the zip path by claiming it.
 *   · EVERYTHING ELSE IS NEITHER, and says so. A bare word, three slashes, an
 *     empty string: the caller reports it rather than guessing, because guessing
 *     here means a confusing network error instead of a sentence about the input.
 *
 * RETURNS THE KIND ONLY, not a parsed value: the two loaders each do their own
 * strict parsing (`parseRepoSlug`, `validatedZipUrl`) and both refuse loudly.
 * Duplicating either one here would create a second, weaker validator whose
 * disagreements with the real one would be silent.
 *
 * @param {string} raw The text as typed into the field.
 * @returns {"repo"|"url"|"unknown"}
 *
 * @example // the demo repo, as the modal's hint shows it
 * projectSourceKind("RyannDaGreat/PowerRP-RobotSim-Demo")
 * 'repo'
 * @example // …and a non-default BRANCH of it
 * projectSourceKind("RyannDaGreat/PowerRP-RobotSim-Demo@main")
 * 'repo'
 * @example // a zip anywhere on the web
 * projectSourceKind("https://example.com/decks/RobotSim.zip")
 * 'url'
 * @example // a github WEB url is a repo, not a zip — parseRepoSlug reads this form
 * projectSourceKind("https://github.com/RyannDaGreat/PowerRP-RobotSim-Demo")
 * 'repo'
 * @example // …but a RAW FILE link on github.com is a zip — .zip outranks the host
 * projectSourceKind("https://github.com/owner/name/raw/refs/heads/main/Deck%20(3).zip")
 * 'url'
 * @example // …including with a branch in the github tree form
 * projectSourceKind("https://github.com/owner/name@release/1.2")
 * 'repo'
 * @example // neither grammar: refused with a sentence, never guessed at
 * projectSourceKind("robot sim deck")
 * 'unknown'
 * @example // a colon means a scheme was intended; an unsupported one is not a slug
 * projectSourceKind("data:text/html,x")
 * 'unknown'
 * @example projectSourceKind("")
 * 'unknown'
 */
export function projectSourceKind(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "unknown";
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    // .zip FIRST: github.com serves raw file links (`…/raw/refs/heads/main/x.zip`)
    // as well as repo pages, so a path ending in .zip names a FILE regardless of
    // host. Query/hash are stripped so `deck.zip?v=2` still counts.
    const rest = text.slice(scheme[0].length);
    if (/\.zip$/i.test(rest.split(/[?#]/)[0])) return "url";
    // A github.com URL is the repo grammar wearing its web address; anything
    // else with a scheme is a plain fetch, and validatedZipUrl judges the scheme.
    const host = rest.split("/")[0].toLowerCase();
    return host === "github.com" || host === "www.github.com" ? "repo" : "url";
  }
  // Scheme-less. Exactly one slash, and a non-empty side each way, is owner/name.
  // The @ref is stripped first because a ref may itself contain "/" (release/1.2),
  // exactly as parseRepoSlug does it — the two must agree about what a slug is.
  const at = text.indexOf("@");
  const path = at >= 0 ? text.slice(0, at) : text;
  // A COLON DISQUALIFIES IT, and this line is not decoration. `data:text/html,x`
  // has no "://" and exactly one slash, so without this it read as the repo
  // `data:text/html,x` — routed at parseRepoSlug, which refuses it (a colon is
  // not in GitHub's name grammar) but refuses it while TALKING ABOUT GITHUB
  // OWNER NAMES, which tells a user who pasted a data: URL nothing useful. A
  // colon means the author meant a scheme; if it is not one we take, saying so
  // here is the honest answer.
  if (path.includes(":")) return "unknown";
  const parts = path.split("/");
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) return "repo";
  return "unknown";
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
 * `repoSlug` is the REPO transport's half of the same fact `sourceUrl` carries
 * for the zip transport: the address the draft came from, and therefore what its
 * share link can be built out of. It is omitted from the returned object when
 * absent rather than set to "", so a zip draft and a repo draft are told apart
 * by the KEY's presence — which is exactly the test `shareLink()` makes.
 *
 * @param {string|null} rawJson The stored string, or null when unset.
 * @returns {{name: string, sourceUrl: string, repoSlug?: string}|null}
 *
 * @example draftStateFromJson('{"name":"RobotSim","sourceUrl":"https://x.dev/a.zip"}')
 * {name: 'RobotSim', sourceUrl: 'https://x.dev/a.zip'}
 * @example // a REPO draft survives a reload with the branch it was opened at:
 * draftStateFromJson('{"name":"RobotSim","sourceUrl":"","repoSlug":"o/n@main"}')
 * {name: 'RobotSim', sourceUrl: '', repoSlug: 'o/n@main'}
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
  const state = { name: parsed.name, sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : "" };
  if (typeof parsed.repoSlug === "string" && parsed.repoSlug) state.repoSlug = parsed.repoSlug;
  return state;
}
