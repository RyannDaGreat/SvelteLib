/**
 * GitHub-project tests — plain node, no framework, no DOM, NO NETWORK.
 * Run: node src/demo_apps/PowerRP/tests/github_project_test.js
 *
 * WHAT IS UNDER TEST is the pure half of "a project stored as a GitHub repo":
 * parsing a repo slug, deciding the layout, planning each file's fetch, decoding
 * content, and translating failures into sentences a person can act on.
 *
 * THE API RESPONSES ARE REAL, recorded from api.github.com against the live demo
 * repo (tests/fixtures/github_contents_api.json) rather than hand-written. A
 * hand-written fixture only proves the code agrees with the author's memory of
 * the API; a recorded one catches the case below, which memory would have missed.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT is silent and total. GitHub's contents
 * API inlines a file's bytes as base64 ONLY up to 1 MB. Over that it still
 * answers 200 OK — with `encoding: "none"` and an EMPTY `content` string — and
 * expects you to use `download_url`. The demo repo's 1,229,177-byte video is
 * exactly that case (the fixture proves it). Code that read `content`
 * unconditionally would decode "" into zero bytes and import a video that is not
 * there, with no error at any layer: a green checkmark over a broken deck. So
 * `assetFetchPlan` must choose `download` for it, and `decodedFileContent` must
 * REFUSE it rather than return an empty buffer. Both directions are asserted.
 *
 * THE OTHER THING ASSERTED HARD IS TOKEN REDACTION. A Personal Access Token must
 * never reach a log, an error or a report. `redacted()` is the last line of that
 * defense, so it is tested against every GitHub token format including the
 * fine-grained one, and against a message that embeds a token mid-sentence.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSETS_SUBDIR,
  DOC_FILENAME,
  GITHUB_API,
  INLINE_CONTENT_LIMIT,
  PROJECT_REPO_URL,
  REPO_PARAM,
  TOKEN_STORAGE_WARNING,
  assetEntries,
  assetFetchPlan,
  base64FromBytes,
  commitFileBody,
  decodedFileContent,
  githubErrorMessage,
  githubHeaders,
  parseRepoSlug,
  projectLayout,
  redacted,
  repoWebUrl,
  shareLink,
} from "../web/githubProject.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(here, "fixtures/github_contents_api.json"), "utf8"));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** node has no atob/btoa in every version we support; Buffer is the twin. */
const decode = (b64) => Buffer.from(b64, "base64").toString("binary");
const encode = (binary) => Buffer.from(binary, "binary").toString("base64");

// ── the slug ─────────────────────────────────────────────────────────────────

test("parseRepoSlug reads owner/name, @ref, and the URL people actually paste", () => {
  assert.deepEqual(parseRepoSlug("RyannDaGreat/PowerRP-RobotSim-Demo"), {
    owner: "RyannDaGreat",
    repo: "PowerRP-RobotSim-Demo",
    ref: null,
  });
  assert.deepEqual(parseRepoSlug("owner/name@v2"), { owner: "owner", repo: "name", ref: "v2" });
  // A ref may contain "/" — split on "@" FIRST or this reads as three segments.
  assert.deepEqual(parseRepoSlug("owner/name@release/1.2"), { owner: "owner", repo: "name", ref: "release/1.2" });
  assert.deepEqual(parseRepoSlug("https://github.com/owner/name"), { owner: "owner", repo: "name", ref: null });
  assert.deepEqual(parseRepoSlug("https://github.com/owner/name.git"), { owner: "owner", repo: "name", ref: null });
  assert.deepEqual(parseRepoSlug("  owner/name/  "), { owner: "owner", repo: "name", ref: null });
});

test("parseRepoSlug REFUSES anything that is not a repository reference", () => {
  // Each of these must throw BEFORE any request is made — the slug is
  // attacker-reachable by construction (it arrives in a link someone clicked).
  for (const bad of ["", "owner", "a/b/c", "owner/na me", "own er/name", "owner/na$me"]) {
    assert.throws(() => parseRepoSlug(bad), /repository|Invalid|No repository/i, `should refuse ${JSON.stringify(bad)}`);
  }
  // A non-github host is a mistake worth NAMING, not silently treating as a slug.
  assert.throws(() => parseRepoSlug("https://gitlab.com/owner/name"), /Only github\.com/i);
  assert.throws(() => parseRepoSlug("owner/name@"), /Empty @ref/i);
});

test("shareLink and repoWebUrl are the ONE spelling of each link", () => {
  const target = { owner: "RyannDaGreat", repo: "PowerRP-RobotSim-Demo" };
  assert.equal(repoWebUrl(target), "https://github.com/RyannDaGreat/PowerRP-RobotSim-Demo");
  // The app URL's own query must be DISCARDED — sharing from a page already
  // opened via ?repo= must not produce a link carrying two of them.
  const link = shareLink(target, "https://ryanndagreat.github.io/SvelteLib/?repo=someone/else#x");
  assert.equal(link, "https://ryanndagreat.github.io/SvelteLib/?repo=RyannDaGreat%2FPowerRP-RobotSim-Demo");
  // And it must round-trip back through the parser.
  const parsed = parseRepoSlug(new URL(link).searchParams.get(REPO_PARAM));
  assert.deepEqual(parsed, { ...target, ref: null });
});

// ── the layout ───────────────────────────────────────────────────────────────

test("projectLayout: FLAT is the demo repo's real root listing", () => {
  assert.deepEqual(projectLayout(fixtures.root, () => false), { prefix: "" });
});

test("projectLayout: NESTED is what an unpacked zip export looks like", () => {
  const entries = [{ name: "My Talk", type: "dir" }, { name: "README.md", type: "file" }];
  assert.deepEqual(projectLayout(entries, (d) => d === "My Talk"), { prefix: "My Talk/" });
});

test("projectLayout REFUSES ambiguity and absence rather than guessing", () => {
  // Two projects in one repo: picking one would be a coin flip that looks like a
  // feature until it opens the wrong deck.
  assert.throws(
    () => projectLayout([{ name: "A", type: "dir" }, { name: "B", type: "dir" }], () => true),
    /more than one folder/i,
  );
  // No doc.json: the message must say WHERE we looked, not just "failed".
  assert.throws(() => projectLayout([{ name: "README.md", type: "file" }], () => false), /No doc\.json found/i);
  assert.throws(() => projectLayout([], () => false), /No doc\.json found/i);
});

test("assetEntries takes files only, non-recursively (caches are not content)", () => {
  assert.deepEqual(assetEntries(fixtures.assets_dir), [
    {
      name: "Video_20260726_224007_045.mp4",
      size: 1229177,
      downloadUrl: "https://raw.githubusercontent.com/RyannDaGreat/PowerRP-RobotSim-Demo/main/assets/Video_20260726_224007_045.mp4",
    },
  ]);
  // `.thumbs/` and `frames/` are REGENERABLE caches — importing them would
  // restore a stale thumbnail as if it were authored content.
  const mixed = [
    { name: "logo.png", type: "file", size: 10, download_url: "https://raw/logo.png" },
    { name: ".thumbs", type: "dir", size: 0, download_url: null },
    { name: "frames", type: "dir", size: 0, download_url: null },
  ];
  assert.deepEqual(assetEntries(mixed).map((a) => a.name), ["logo.png"]);
  assert.deepEqual(assetEntries(null), []);
});

// ── THE 1 MB CLIFF (the defect this file exists for) ─────────────────────────

test("assetFetchPlan: the demo's REAL 1.2 MB video is a DOWNLOAD, not an empty inline", () => {
  const video = fixtures.video_file;
  // Guard the fixture itself: if GitHub ever starts inlining this, the premise
  // of this test changed and we want to hear about it here, not in production.
  assert.equal(video.size, 1229177, "fixture video size");
  assert.ok(video.size > INLINE_CONTENT_LIMIT, "the fixture must be over the 1 MB inline limit");
  assert.equal(video.encoding, "none", "GitHub reports encoding 'none' over the limit");
  assert.ok(!video.content, "…and sends EMPTY content — the silent-zero-bytes trap");

  const plan = assetFetchPlan(video);
  assert.equal(plan.mode, "download");
  assert.match(plan.reason, /over 1 MB/);
  assert.ok(plan.downloadUrl.startsWith("https://raw.githubusercontent.com/"), "must fall back to download_url");
});

test("assetFetchPlan: a small inlined file is taken inline", () => {
  const plan = assetFetchPlan({ size: 900, encoding: "base64", content: "aGk=", download_url: "https://raw/x" });
  assert.equal(plan.mode, "inline");
});

test("assetFetchPlan: a LISTING entry states no encoding, so size decides", () => {
  // Listing entries carry no `encoding` at all (the fixture proves it), so the
  // plan must not require one.
  assert.equal(fixtures.assets_dir[0].encoding, null);
  assert.equal(assetFetchPlan(fixtures.assets_dir[0]).mode, "download");
  assert.equal(assetFetchPlan({ size: 10, download_url: "https://raw/small" }).mode, "download");
});

test("decodedFileContent REFUSES empty content instead of returning zero bytes", () => {
  // THE WHOLE POINT: this must throw, not return new Uint8Array(0). A zero-byte
  // asset that imports "successfully" is indistinguishable from a working one
  // until someone presents the deck.
  assert.throws(() => decodedFileContent(fixtures.video_file, decode), /no inline content|over 1 MB/i);
  assert.throws(() => decodedFileContent({ encoding: "none", content: "", name: "big.mp4" }, decode), /big\.mp4/);
});

test("decodedFileContent decodes base64, including GitHub's newline wrapping", () => {
  assert.deepEqual(Array.from(decodedFileContent({ content: "aGk=", encoding: "base64" }, decode)), [104, 105]);
  // GitHub wraps its base64 MIME-style; atob rejects newlines, so they must be
  // stripped. This is format handling, not error tolerance.
  assert.deepEqual(Array.from(decodedFileContent({ content: "aGk=\n", encoding: "base64" }, decode)), [104, 105]);
  const bytes = decodedFileContent({ content: Buffer.from("{}").toString("base64"), encoding: "base64" }, decode);
  assert.equal(new TextDecoder().decode(bytes), "{}");
});

test("base64FromBytes survives a multi-megabyte asset (no stack overflow)", () => {
  assert.equal(base64FromBytes(new Uint8Array([104, 105]), encode), "aGk=");
  // String.fromCharCode(...bytes) would blow the call stack here — the demo's
  // 1.2 MB video is exactly this size class, so the chunking is load-bearing.
  const big = new Uint8Array(INLINE_CONTENT_LIMIT + 5000).fill(65);
  const b64 = base64FromBytes(big, encode);
  assert.equal(Buffer.from(b64, "base64").length, big.length, "round-trips at full size");
});

test("a doc.json round-trips bytes → base64 → bytes unchanged", () => {
  const doc = { meta: { name: "RobotSim" }, slides: [{ id: "s1", delta: {} }] };
  const bytes = new TextEncoder().encode(JSON.stringify(doc, null, 2));
  const back = decodedFileContent({ encoding: "base64", content: base64FromBytes(bytes, encode) }, decode);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(back)), doc);
});

// ── THE TOKEN (never in a log, an error, or a report) ────────────────────────

test("redacted() removes every GitHub token format", () => {
  const tokens = [
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghu_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghr_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "github_pat_11ABCDEFG0abcdefghijkl_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zz",
    "a".repeat(40), // a classic 40-hex token
  ];
  for (const token of tokens) {
    // Embedded MID-SENTENCE, which is how a token would actually leak into an
    // error string — not as the whole message.
    const message = redacted(`Save failed while using ${token} against api.github.com`);
    assert.ok(!message.includes(token), `token must not survive redaction: ${token.slice(0, 8)}…`);
    assert.match(message, /«redacted»/);
  }
  assert.equal(redacted("nothing secret here"), "nothing secret here");
});

test("githubHeaders is the ONE place a token is attached", () => {
  assert.deepEqual(githubHeaders(null), {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  assert.equal(githubHeaders("ghp_x").Authorization, "Bearer ghp_x");
  // Anonymous headers must carry NO authorization at all — the read path is the
  // whole ?repo= share mechanism and must work with no credentials.
  assert.ok(!("Authorization" in githubHeaders("")));
});

test("no error message this module produces can carry a token", () => {
  const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const res = { status: 403, headers: { get: () => null } };
  const message = githubErrorMessage(res, { message: `Bad credentials for ${token}` }, { owner: "a", repo: "b" }, true);
  assert.ok(!message.includes(token), "githubErrorMessage must redact the API's own echo of a token");
});

// ── errors that say what to DO ───────────────────────────────────────────────

test("a rate-limited 403 says RATE LIMIT plainly, and never 'failed'", () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const headers = { get: (h) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })[h] ?? null };
  const message = githubErrorMessage({ status: 403, headers }, { message: "API rate limit exceeded for 1.2.3.4" });
  assert.match(message, /rate limit/i);
  assert.match(message, /60 per hour/, "must name the actual anonymous limit");
  assert.match(message, /not a problem with the repository/i, "must not send someone debugging their repo");
  assert.match(message, /resets at/i, "must say WHEN, so 'try later' is a decision not a shrug");
  assert.ok(!/failed/i.test(message), "a rate limit is an expected answer, not a failure");
});

test("404 while anonymous names BOTH meanings, because GitHub hides existence", () => {
  const anon = githubErrorMessage({ status: 404 }, {}, { owner: "a", repo: "b" }, false);
  assert.match(anon, /private/i, "private and missing are indistinguishable to an anonymous caller");
  assert.match(anon, /a\/b/);
  // With a token, "private" is no longer the likely explanation — scope is.
  const authed = githubErrorMessage({ status: 404 }, {}, { owner: "a", repo: "b" }, true);
  assert.match(authed, /token can see/i);
});

test("401 and a non-rate-limit 403 are distinguished from each other", () => {
  assert.match(githubErrorMessage({ status: 401, headers: { get: () => null } }, {}), /rejected the token/i);
  const forbidden = githubErrorMessage({ status: 403, headers: { get: () => "57" } }, { message: "Resource not accessible" });
  assert.match(forbidden, /repo.*scope/i);
  assert.ok(!/rate limit/i.test(forbidden), "a non-rate-limit 403 must not be reported as one");
});

// ── the save payload ─────────────────────────────────────────────────────────

test("commitFileBody includes sha ONLY when overwriting", () => {
  // The contents API REQUIRES sha to overwrite and REJECTS it when creating;
  // getting it wrong is a 422 with an unhelpful body.
  assert.deepEqual(commitFileBody({ message: "add doc", contentBase64: "aGk=" }), { message: "add doc", content: "aGk=" });
  assert.equal(commitFileBody({ message: "u", contentBase64: "aGk=", sha: "abc123" }).sha, "abc123");
  assert.equal(commitFileBody({ message: "u", contentBase64: "aGk=", branch: "main" }).branch, "main");
});

// ── constants that must not drift ────────────────────────────────────────────

test("the repo layout is the SAME vocabulary the zip uses", () => {
  // If these ever diverge from projectZip.js, a zip and a repo would be two
  // formats instead of one layout with the lid off.
  assert.equal(DOC_FILENAME, "doc.json");
  assert.equal(ASSETS_SUBDIR, "assets");
  assert.equal(GITHUB_API, "https://api.github.com");
  assert.equal(INLINE_CONTENT_LIMIT, 1024 * 1024);
});

test("PROJECT_REPO_URL is a single constant (the toolbar logo's destination)", () => {
  assert.equal(PROJECT_REPO_URL, "https://github.com/RyannDaGreat/SvelteLib");
});

test("the token-storage warning says plainly where the token goes", () => {
  // The user must be able to make an informed choice; a euphemism here would be
  // a lie about a secret. Assert the specifics rather than mere length.
  assert.match(TOKEN_STORAGE_WARNING, /this browser/i);
  assert.match(TOKEN_STORAGE_WARNING, /unencrypted/i);
  assert.match(TOKEN_STORAGE_WARNING, /shared computer/i);
});

console.log(`\n${passed} passed`);
