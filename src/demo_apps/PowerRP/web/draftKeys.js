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
