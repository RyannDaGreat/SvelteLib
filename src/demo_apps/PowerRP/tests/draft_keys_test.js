/**
 * Draft-keyspace tests — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/draft_keys_test.js
 *
 * WHAT IS UNDER TEST is the pure half of the WORKING-COPY MODEL: opening a .zip
 * or a share link creates a DRAFT that is not in the project library until the
 * user saves (user ruling: "It shouldn't have to save until the user decides to
 * save — that goes for uploading zips too").
 *
 * THE LOAD-BEARING ASSERTION IS THE FIRST ONE, and it is a proof obligation
 * rather than a behavior check: THE DRAFT KEY MUST BE UNUSABLE AS A PROJECT
 * NAME. The whole model rests on `app.projectName()` returning that key while a
 * draft is open, which is only safe because no real project can ever be called
 * that. The server's rule (`_SAFE_NAME` in server.py: no "/", "\" or NUL) is
 * mirrored here as `validProjectName`, so if someone ever loosens it to permit
 * slashes THIS TEST FAILS AND SAYS WHY — instead of a draft silently becoming a
 * saveable project that collides with the staging area it was living in.
 *
 * The rest cover the three things that are easy to get subtly wrong and silent
 * in production: the share URL must DROP the current query (or it would hand a
 * recipient someone else's `?static=1`/`?backend=`), the persisted draft marker
 * must survive garbage without breaking a boot, and the display name must prefer
 * the file the user actually dropped over whatever the archive's root says.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DRAFT_KEY, DRAFT_KEY_PREFIX, DRAFT_STATE_KEY, draftDisplayName, draftStateFromJson, isDraftKey, shareUrl, validProjectName } from "../web/draftKeys.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── The invariant: a draft key can never be a project name ──────────────────

test("THE INVARIANT: the draft key is NOT a valid project name", () => {
  assert.equal(validProjectName(DRAFT_KEY), false, "DRAFT_KEY must be unusable as a project name — the whole draft model depends on it");
  assert.equal(validProjectName(DRAFT_KEY_PREFIX), false);
  assert.ok(DRAFT_KEY.includes("/"), "the exclusion must come from the SERVER'S OWN rule (no '/' in a name), not from a convention this file invented");
});

test("the draft key's impossibility matches server.py's _SAFE_NAME, character for character", () => {
  // Read the REGEX OUT OF THE SERVER rather than restating it: this test exists
  // to fail if that rule ever loosens, so it must not carry its own copy.
  const here = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(here, "..", "server", "server.py"), "utf8");
  const m = serverSrc.match(/_SAFE_NAME = re\.compile\(r"(.+?)"\)/);
  assert.ok(m, "server.py must still define _SAFE_NAME — the draft key's safety is derived from it");
  // Python's r"^[^/\\\x00]+$" is the same class in JS once \x00 is spelled \0.
  const serverRule = new RegExp(m[1].replace(/\\x00/g, "\\0"));
  assert.equal(serverRule.test(DRAFT_KEY), false, `server.py's own name rule must REJECT ${DRAFT_KEY}`);
  assert.equal(serverRule.test("My Talk"), true, "sanity: the rule still accepts an ordinary name");
});

test("validProjectName: ordinary names pass, traversal and separators do not", () => {
  assert.equal(validProjectName("My Talk"), true);
  assert.equal(validProjectName("RobotSim (7)"), true);
  assert.equal(validProjectName("~draft"), true, "a leading ~ alone is legal — it is the SLASH that makes the key impossible");
  assert.equal(validProjectName(""), false);
  assert.equal(validProjectName("."), false);
  assert.equal(validProjectName(".."), false);
  assert.equal(validProjectName("a/b"), false);
  assert.equal(validProjectName("a\\b"), false);
  assert.equal(validProjectName("a\0b"), false);
});

test("isDraftKey separates staged drafts from library names", () => {
  assert.equal(isDraftKey(DRAFT_KEY), true);
  assert.equal(isDraftKey("RobotSim"), false);
  assert.equal(isDraftKey(""), false);
  assert.equal(isDraftKey(null), false);
  assert.equal(isDraftKey(undefined), false);
});

// ── The share link ──────────────────────────────────────────────────────────

test("shareUrl keeps origin+path and DROPS the current query", () => {
  // A share link must reproduce the DECK and nothing else. Carrying ?static=1
  // would hand the recipient a storage mode they did not choose; carrying an old
  // ?zip= would double the parameter.
  assert.equal(
    shareUrl("https://host.dev/SvelteLib/?static=1&backend=http://box:3638", "https://cdn.dev/deck.zip"),
    "https://host.dev/SvelteLib/?zip=https%3A%2F%2Fcdn.dev%2Fdeck.zip",
  );
});

test("shareUrl encodes the source URL so its own query separators survive the round trip", () => {
  const link = shareUrl("https://host.dev/app/", "https://x.dev/decks/a b.zip?v=2&t=1");
  // Form encoding (URLSearchParams) spells a space "+" and escapes ?/&/=, so the
  // source URL's own query cannot be mistaken for the share link's parameters.
  assert.ok(!link.includes(" "), "a raw space would truncate the link when pasted into chat or a terminal");
  assert.ok(!link.includes("&t=1"), "the source URL's own & must NOT become a second parameter of the share link");
  // THE ROUND TRIP IS THE REAL CONTRACT: whatever the spelling, the recipient's
  // ?zip= must read back as the byte-identical URL that was shared.
  assert.equal(new URL(link).searchParams.get("zip"), "https://x.dev/decks/a b.zip?v=2&t=1");
});

test("shareUrl keeps a non-root path (a Pages deploy lives under /SvelteLib/)", () => {
  assert.equal(shareUrl("https://u.github.io/SvelteLib/index.html", "https://x.dev/a.zip"), "https://u.github.io/SvelteLib/index.html?zip=https%3A%2F%2Fx.dev%2Fa.zip");
});

// ── The persisted draft marker ──────────────────────────────────────────────

test("draftStateFromJson reads a well-formed marker", () => {
  assert.deepEqual(draftStateFromJson('{"name":"RobotSim","sourceUrl":"https://x.dev/a.zip"}'), { name: "RobotSim", sourceUrl: "https://x.dev/a.zip" });
});

test("draftStateFromJson tolerates absence and garbage — a corrupt marker must not break a boot", () => {
  assert.equal(draftStateFromJson(null), null);
  assert.equal(draftStateFromJson(""), null);
  assert.equal(draftStateFromJson("{{ not json"), null);
  assert.equal(draftStateFromJson("[1,2,3]"), null, "an array is not a marker");
  assert.equal(draftStateFromJson('{"sourceUrl":"https://x.dev/a.zip"}'), null, "a marker with no name names no draft");
});

test("a local-file draft has an empty sourceUrl, which is what gates the share link", () => {
  // Dropping a zip is a legitimate draft with NOTHING to share: there is no URL a
  // recipient could fetch. The marker records that honestly rather than inventing
  // an address, and app.shareLink() returns null for it.
  assert.deepEqual(draftStateFromJson('{"name":"Dropped Deck"}'), { name: "Dropped Deck", sourceUrl: "" });
});

test("DRAFT_STATE_KEY is namespaced like the app's other localStorage keys", () => {
  assert.ok(DRAFT_STATE_KEY.startsWith("powerrp."), "it shares an origin with every other app; an un-namespaced key is a collision waiting to happen");
});

// ── The display name ────────────────────────────────────────────────────────

test("draftDisplayName prefers the dropped FILE's name over the archive root", () => {
  // Dropping "Robot Sim.zip" must title the deck "Robot Sim" even when the
  // archive inside was exported as "Untitled" — which every pre-localization
  // export was (see commit 7f52bae).
  assert.equal(draftDisplayName("Robot Sim", "Untitled"), "Robot Sim");
});

test("draftDisplayName: a GENERIC file name loses to a real archive root", () => {
  // The defect this encodes, caught by zip_url_boot_probe.js: a share link ending
  // in "/deck.zip" titled every shared deck "deck", discarding the archive root
  // that actually named it. The filename describes the TRANSPORT there, not the
  // deck, so the archive wins.
  assert.equal(draftDisplayName("deck", "SharedDeck"), "SharedDeck");
  assert.equal(draftDisplayName("download", "Q3 Review"), "Q3 Review");
  assert.equal(draftDisplayName("DECK", "SharedDeck"), "SharedDeck", "the generic list is case-insensitive");
  // …but a generic name still beats a blank title when there is nothing better.
  assert.equal(draftDisplayName("deck", ""), "deck");
});

test("draftDisplayName falls back to the archive root, then to a last resort", () => {
  assert.equal(draftDisplayName("", "My Talk"), "My Talk");
  assert.equal(draftDisplayName("   ", "My Talk"), "My Talk", "whitespace is not a name");
  assert.equal(draftDisplayName("", ""), "Imported Project", "the title must never go blank");
});

console.log(`\ndraft_keys_test: ${passed} passed`);
