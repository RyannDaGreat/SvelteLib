/**
 * web/githubProject.js — A PROJECT STORED AS A GITHUB REPO, not as a zip.
 *
 * THE USER'S ASK, verbatim intent: "I should be able to save a project as a
 * GITHUB REPO too instead of bundling the whole thing into a zip — and give the
 * github repo link. That way it's more editable."
 *
 * That last clause is the whole design rationale. A zip is ONE OPAQUE BLOB: to
 * change one number in a deck you download it, unzip it, edit, re-zip, re-upload,
 * and every share link you handed out now points at the old bytes. A repo is the
 * SAME FILES, addressable and diffable — `doc.json` is reviewable in a pull
 * request, an asset is replaced by dropping a file in, and the share link keeps
 * pointing at whatever `main` says today. So the repo is not a second archive
 * format; it is the zip's layout with the lid off:
 *
 *      doc.json          the document
 *      assets/<file>     what it references, by RELATIVE name
 *
 * BOTH LAYOUTS LOAD (see `projectLayout`), because our own zip export roots
 * everything under a single `<project>/` folder — so an unpacked-and-pushed
 * export lands nested, while a hand-made repo lands flat. Refusing the nested
 * form would reject the archives we ourselves produce, which is the layout most
 * likely to be pushed. Deeper nesting is REFUSED rather than searched for: a
 * recursive hunt for any doc.json would turn "you pushed it to the wrong place"
 * into a mystery, and could pick the wrong document in a repo holding several.
 *
 * WHAT THIS FILE IS NOT: a second importer. It produces `{doc, assets}` and hands
 * that to the EXISTING healed import path, the same one the zip and `?zip=` share
 * (`repairedDocument` at the boundary, never-overwrite naming, archive adoption).
 * A repo is a TRANSPORT, exactly as a URL is — everything downstream of "we have
 * the bytes" already existed and is deliberately untouched.
 *
 * FIVE THINGS THAT ARE ONLY TRUE HERE:
 *
 *  1. THE 1 MB CLIFF IS REAL AND IT IS SILENT. GitHub's contents API returns a
 *     file's bytes inline as base64 — but ONLY up to 1 MB. Above that it still
 *     answers 200 OK, with `encoding: "none"` and an EMPTY `content` string, and
 *     hands you a `download_url` instead. Verified against the demo repo: its
 *     1,229,177-byte video returns exactly that. A loader that read `content`
 *     unconditionally would decode "" to zero bytes and import a VIDEO THAT IS
 *     NOT THERE, with no error anywhere — a green checkmark over a broken deck.
 *     `assetFetchPlan` is that fork, made explicit and unit-tested, and
 *     `decodedFileContent` REFUSES an empty-content inline file rather than
 *     returning an empty buffer.
 *
 *  2. CORS IS A NON-ISSUE HERE, unlike `?zip=`. Both hosts we touch send
 *     `Access-Control-Allow-Origin: *` (verified empirically against
 *     api.github.com and raw.githubusercontent.com), so `?repo=` works from the
 *     static GitHub Pages site with NO server and NO proxy. That is why this is
 *     the better share mechanism for the static build and why nothing in this
 *     file has a proxy fallback.
 *
 *  3. RATE LIMITING IS A DISTINCT, EXPECTED ANSWER — not a failure. Anonymous
 *     GitHub allows 60 requests/hour/IP. That is plenty for opening shared decks
 *     but a person on a shared or office IP WILL meet it, and the API reports it
 *     as a 403 whose body is about rate limits rather than permissions. Reporting
 *     that as "failed to load" would send someone hunting a bug in their repo
 *     that does not exist, so `githubErrorMessage` separates the three 403/404
 *     meanings and, for the rate limit, says WHEN it resets.
 *
 *  4. THE TOKEN IS THE USER'S AND IT IS RADIOACTIVE. Save-to-GitHub takes a
 *     Personal Access Token the user pastes. It goes to api.github.com and
 *     NOWHERE else; it is NOT persisted unless the user opts in; and it must
 *     never reach a log, an error message, a thrown Error or a console line —
 *     an error string is the likeliest place a secret leaks, because errors get
 *     pasted into bug reports. `redacted()` is applied to every message this
 *     module produces, and a test asserts a token cannot survive it.
 *
 *  5. THE REPO IS CONTENT, NEVER A COMMAND. Nothing fetched here is evaluated.
 *     `doc.json` is parsed as JSON and repaired by the normal load boundary;
 *     assets are bytes. A repo slug is validated against GitHub's own name
 *     grammar BEFORE any request, so a crafted `?repo=` cannot address anything
 *     but a repository.
 *
 * ====== THE GITHUB EXEMPTION FROM THE SAVE / SAVE-AS RULING ================
 *
 * THE RULING (user, verbatim): "GitHub is different — there you can just push and
 * change." Everywhere ELSE in the app a working copy that is not in the library
 * must go through Save As… before it can be saved (draftKeys.isUnsavedDraft gates
 * the quick Save, and web/App.svelte's `save-project` command declares that gate).
 * SAVE-TO-GITHUB IS EXEMPT, and `saveProjectToRepo` below already implements the
 * exempt shape — this note exists so a later author wiring it to a button does not
 * "fix" it into consistency with the local rule:
 *
 *   · A COMMIT IS A QUICK SAVE. Pushing to a repo you already have a target for
 *     needs no naming ceremony, because git's own model supplies what Save-As
 *     supplies locally: the destination is already named, the previous state is
 *     not destroyed (it is a parent commit), and a mistake is recoverable from
 *     the history. The local library has none of those properties, which is
 *     exactly why it needs the ceremony and this does not.
 *   · THE REPO NAME IS ASKED FOR ONCE — when there is no target repo yet. That is
 *     the `name` argument, and the create-if-absent branch below is where "no
 *     target yet" is discovered. With a target in hand, every later push is
 *     `PUT` + sha, no prompt.
 *   · SO: a repo-name modal belongs on the FIRST push and must NOT reappear on
 *     subsequent ones, and the local isDraft() gate must NOT be applied to a
 *     Save-to-GitHub command. An unsaved local draft is perfectly pushable — that
 *     is the point of "you can just push and change".
 *
 * VERIFIED, not assumed: as of this writing `saveProjectToRepo` is a LIBRARY
 * FUNCTION WITH NO UI CONSUMER (grep: only main.js's ?repo= LOAD path imports from
 * this module). There is therefore no redundant prompt to remove today, and
 * nothing was adjusted. The obligation lands on whoever wires the button.
 */

/** GitHub's REST host. The ONE origin this module talks to for metadata, named
 *  once so an audit of "where can a token go" is a single grep. */
export const GITHUB_API = "https://api.github.com";

/** THIS DEPLOYMENT's own repository — what the toolbar's GitHub logo opens.
 *  One constant, never sprinkled: the logo, the README and any future "report an
 *  issue" affordance must agree about where the source lives. */
export const PROJECT_REPO_URL = "https://github.com/RyannDaGreat/SvelteLib";

/** The share-link query parameter: `?repo=owner/name` (optionally `@ref`).
 *  Exported so the boot path, the tests and the docs cannot drift apart. */
export const REPO_PARAM = "repo";

/** The document's filename in the repo — the same DOC_FILENAME the zip uses. */
export const DOC_FILENAME = "doc.json";

/** The assets subfolder in the repo — the same ASSETS_SUBDIR the zip uses. */
export const ASSETS_SUBDIR = "assets";

/** The size at which GitHub's contents API STOPS inlining base64 and returns a
 *  `download_url` instead (1 MiB). Not a tuning knob — it is GitHub's documented
 *  boundary, named because the silent-empty-file bug in note 1 lives exactly
 *  here. `assetFetchPlan` treats the API's own `encoding` as authoritative and
 *  uses this only to explain and to predict. */
export const INLINE_CONTENT_LIMIT = 1024 * 1024;

/** localStorage key for the OPT-IN remembered token (note 4). Distinct from any
 *  session state so "forget my token" is one key to delete. */
export const TOKEN_KEY = "powerrp.githubToken";

// ── the slug ─────────────────────────────────────────────────────────────────

/**
 * Pure function. Parse `owner/name`, `owner/name@ref` or a full GitHub URL into
 * `{owner, repo, ref}`.
 *
 * ACCEPTING THE URL FORM is not a convenience flourish: the thing a person has
 * on their clipboard is `https://github.com/owner/name`, because that is what the
 * repo page's address bar says and what the "Code" button copies. Requiring them
 * to retype it as a slug would be a papercut with no upside, and the two forms
 * carry identical information.
 *
 * `ref` is a branch, tag or commit SHA, and `null` means "whatever the repo's
 * default branch is" — resolved by the API, never guessed here, because assuming
 * `main` breaks every repo still on `master`.
 *
 * VALIDATION IS A REFUSAL, NOT A FILTER, and it happens before any network call:
 * owner and repo are checked against GitHub's own name grammar (alphanumerics,
 * `-`, `_`, `.`), so a crafted `?repo=` value cannot steer a request at another
 * path or another host.
 *
 * @param {string} raw The slug as typed or as read from the query string.
 * @returns {{owner: string, repo: string, ref: string|null}}
 * @throws {Error} Loudly, naming what was wrong, on anything unparseable.
 *
 * @example parseRepoSlug("RyannDaGreat/PowerRP-RobotSim-Demo")
 * {owner: 'RyannDaGreat', repo: 'PowerRP-RobotSim-Demo', ref: null}
 * @example parseRepoSlug("owner/name@v2")
 * {owner: 'owner', repo: 'name', ref: 'v2'}
 * @example parseRepoSlug("https://github.com/owner/name")
 * {owner: 'owner', repo: 'name', ref: null}
 * @example // a trailing .git, as "Code → clone" hands it over, is stripped:
 * parseRepoSlug("https://github.com/owner/name.git")
 * {owner: 'owner', repo: 'name', ref: null}
 * @example // refuses anything that is not a repository reference:
 * // parseRepoSlug("owner")  → throws "expected owner/name"
 */
export function parseRepoSlug(raw) {
  let text = String(raw ?? "").trim();
  if (!text) throw new Error("No repository given — expected owner/name.");
  // The URL form, reduced to the slug form. Only github.com: a URL on any other
  // host is a mistake worth naming, not something to silently treat as a slug.
  const url = text.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (url) {
    const [, host, path] = url;
    if (host.toLowerCase() !== "github.com" && host.toLowerCase() !== "www.github.com") {
      throw new Error(`Only github.com repositories are supported — got ${host} in ${text}`);
    }
    text = path;
  }
  text = text.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  // `@ref` is split off FIRST: a ref may itself contain "/" (release/1.2), so
  // splitting on "/" first would misread the ref as extra path segments.
  let ref = null;
  const at = text.indexOf("@");
  if (at >= 0) {
    ref = text.slice(at + 1).trim();
    text = text.slice(0, at);
    if (!ref) throw new Error(`Empty @ref in ${JSON.stringify(raw)} — write owner/name@branch, or omit the @.`);
  }
  const parts = text.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Not a repository — expected owner/name, got ${JSON.stringify(raw)}`);
  }
  const [owner, repo] = parts;
  const NAME = /^[A-Za-z0-9._-]+$/;
  if (!NAME.test(owner)) throw new Error(`Invalid GitHub owner name: ${JSON.stringify(owner)}`);
  if (!NAME.test(repo)) throw new Error(`Invalid GitHub repository name: ${JSON.stringify(repo)}`);
  return { owner, repo, ref };
}

/**
 * Pure function. The canonical `?repo=` SHARE LINK for a repo, given the page it
 * should open in.
 *
 * Exists so the save flow's "copy this link" and the README's worked example are
 * generated by one rule rather than concatenated by hand in two places.
 *
 * THE REF IS CARRIED WHEN THERE IS ONE (user ruling: "it should support branches
 * too"). This used to build `owner/name` from a target that had a `ref` sitting
 * right there on it, so sharing a deck you opened from a branch handed the
 * recipient the DEFAULT branch instead — a different document, silently, under a
 * link that looked correct. A ref of `null` still produces the bare slug, which
 * is right: "whatever the default branch says today" is a real and useful thing
 * to share, and pinning it to the branch name that happens to be default now
 * would freeze it.
 *
 * @param {{owner: string, repo: string, ref?: string|null}} target
 * @param {string} appUrl The editor's URL (query and hash are discarded).
 * @returns {string}
 *
 * @example shareLink({owner: "RyannDaGreat", repo: "PowerRP-RobotSim-Demo"}, "https://ryanndagreat.github.io/SvelteLib/")
 * 'https://ryanndagreat.github.io/SvelteLib/?repo=RyannDaGreat%2FPowerRP-RobotSim-Demo'
 * @example // a BRANCH survives the round trip — parseRepoSlug reads back what this writes:
 * shareLink({owner: "RyannDaGreat", repo: "PowerRP-RobotSim-Demo", ref: "branch-fixture"}, "https://x.dev/app/")
 * 'https://x.dev/app/?repo=RyannDaGreat%2FPowerRP-RobotSim-Demo%40branch-fixture'
 */
export function shareLink({ owner, repo, ref = null }, appUrl) {
  const base = new URL(appUrl);
  base.search = "";
  base.hash = "";
  const slug = ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
  return `${base.href}?${new URLSearchParams({ [REPO_PARAM]: slug })}`;
}

/** The repo's human-facing page — what we SHOW on a successful save, and what
 *  the toolbar logo opens for this deployment.
 *
 *  @example repoWebUrl({owner: "a", repo: "b"})
 *  'https://github.com/a/b'
 */
export function repoWebUrl({ owner, repo }) {
  return `https://github.com/${owner}/${repo}`;
}

// ── the layout ───────────────────────────────────────────────────────────────

/**
 * Pure function. Decide WHERE in the repo the project lives, from a root
 * directory listing — flat (`doc.json` at the root) or nested under exactly one
 * folder (what an unpacked zip export looks like).
 *
 * See the header on why both and why not a recursive search. The nested case
 * requires a SINGLE candidate directory: two folders each holding a doc.json is
 * genuinely ambiguous, and picking one would be a coin flip that looks like a
 * feature until it opens the wrong deck.
 *
 * This takes the ROOT listing plus a `hasDoc` predicate rather than doing I/O, so
 * the decision is testable in bare node against recorded API responses.
 *
 * @param {Array<{name: string, type: string}>} rootEntries The contents API's root array.
 * @param {(dir: string) => boolean} hasDoc Whether that subdirectory holds a doc.json.
 * @returns {{prefix: string}} `prefix` is "" for flat, or "<folder>/".
 * @throws {Error} Loudly when no doc.json is reachable, or the choice is ambiguous.
 *
 * @example // flat — a hand-made repo, and the layout the demo uses:
 * projectLayout([{name: "doc.json", type: "file"}, {name: "assets", type: "dir"}], () => false)
 * {prefix: ''}
 * @example // nested — an unpacked zip export, rooted at the project's name:
 * projectLayout([{name: "My Talk", type: "dir"}], (d) => d === "My Talk")
 * {prefix: 'My Talk/'}
 * @example // no doc.json anywhere reachable → a loud refusal, not a guess:
 * // projectLayout([{name: "README.md", type: "file"}], () => false)  → throws
 */
export function projectLayout(rootEntries, hasDoc) {
  const entries = Array.isArray(rootEntries) ? rootEntries : [];
  if (entries.some((e) => e.type === "file" && e.name === DOC_FILENAME)) return { prefix: "" };
  const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
  const holding = dirs.filter((d) => hasDoc(d));
  if (holding.length === 1) return { prefix: `${holding[0]}/` };
  if (holding.length > 1) {
    throw new Error(
      `This repository has ${DOC_FILENAME} in more than one folder (${holding.join(", ")}) — ` +
        `it is not clear which project to open. Point the link at one of them, or keep a single project per repository.`,
    );
  }
  throw new Error(
    `No ${DOC_FILENAME} found in this repository. A PowerRP project repo has ${DOC_FILENAME} at its root ` +
      `(with an ${ASSETS_SUBDIR}/ folder beside it), or inside a single top-level folder.`,
  );
}

/**
 * Pure function. Which entries of an `assets/` listing are ASSETS.
 *
 * Files only, and only those DIRECTLY in the folder — the same non-recursive rule
 * `parseProjectZip` and the server's `list_assets` apply, for the same reason:
 * `assets/frames/` and `assets/.thumbs/` are regenerable CACHES, and importing
 * them would restore a stale thumbnail as if it were authored content.
 *
 * @param {Array<{name: string, type: string, size: number, download_url: string}>} entries
 * @returns {Array<{name: string, size: number, downloadUrl: string}>}
 *
 * @example assetEntries([
 * ...   {name: "clip.mp4", type: "file", size: 12, download_url: "https://raw/clip.mp4"},
 * ...   {name: ".thumbs", type: "dir", size: 0, download_url: null},
 * ... ])
 * [{name: 'clip.mp4', size: 12, downloadUrl: 'https://raw/clip.mp4'}]
 */
export function assetEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e.type === "file")
    .map((e) => ({ name: e.name, size: e.size ?? 0, downloadUrl: e.download_url ?? null }));
}

/**
 * Pure function. HOW to fetch one asset: inline base64, or a separate download.
 *
 * THIS IS NOTE 1's FORK, isolated so it is unit-testable without a network. The
 * API's own `encoding` is authoritative when present — trusting the reported
 * `size` against `INLINE_CONTENT_LIMIT` alone would be a second opinion about a
 * fact the response already states, and the two can disagree at the boundary.
 * Size is the fallback for a listing entry (which carries no `encoding` at all).
 *
 * @param {{size: number, encoding?: string, content?: string, downloadUrl?: string, download_url?: string}} entry
 * @returns {{mode: "inline"|"download", reason: string, downloadUrl: string|null}}
 *
 * @example // a small file the API inlined:
 * assetFetchPlan({size: 900, encoding: "base64", content: "AAA="}).mode
 * 'inline'
 * @example // the demo's 1.2 MB video: 200 OK, encoding "none", EMPTY content:
 * assetFetchPlan({size: 1229177, encoding: "none", content: "", download_url: "https://raw/v.mp4"})
 * {mode: 'download', reason: 'GitHub does not inline files over 1 MB', downloadUrl: 'https://raw/v.mp4'}
 * @example // a listing entry, which states no encoding — size decides:
 * assetFetchPlan({size: 2000000, download_url: "https://raw/big.bin"}).mode
 * 'download'
 */
export function assetFetchPlan(entry) {
  const downloadUrl = entry.downloadUrl ?? entry.download_url ?? null;
  const inlineable = entry.encoding === "base64" && typeof entry.content === "string" && entry.content.length > 0;
  if (inlineable) return { mode: "inline", reason: "inlined by the contents API", downloadUrl };
  const overLimit = (entry.size ?? 0) > INLINE_CONTENT_LIMIT;
  return {
    mode: "download",
    reason: overLimit ? "GitHub does not inline files over 1 MB" : "the contents API did not inline this file",
    downloadUrl,
  };
}

/**
 * Pure function. Decode a base64 `content` field into bytes.
 *
 * REFUSES AN EMPTY CONTENT rather than returning an empty buffer, which is the
 * whole defense against note 1: a zero-byte asset that imports "successfully" is
 * indistinguishable from a working one until someone presents the deck. If we
 * ever reach here for a file GitHub declined to inline, we say so.
 *
 * GitHub wraps its base64 in newlines (MIME-style); `atob` rejects those, so they
 * are stripped. That is format handling, not error tolerance.
 *
 * @param {{content: string, encoding: string, name?: string}} file A contents-API file object.
 * @param {(b64: string) => string} [decode] Base64→binary-string (defaults to `atob`).
 * @returns {Uint8Array}
 * @throws {Error} on a non-base64 encoding or empty content.
 *
 * @example Array.from(decodedFileContent({content: "aGk=", encoding: "base64"}))
 * [104, 105]
 * @example // newline-wrapped, as GitHub actually sends it:
 * Array.from(decodedFileContent({content: "aGk=\n", encoding: "base64"}))
 * [104, 105]
 * @example // the silent-empty-file case is a LOUD refusal:
 * // decodedFileContent({content: "", encoding: "none", name: "big.mp4"})  → throws
 */
export function decodedFileContent(file, decode = undefined) {
  const name = file?.name ? ` (${file.name})` : "";
  if (file?.encoding !== "base64" || typeof file?.content !== "string" || file.content.length === 0) {
    throw new Error(
      `GitHub returned no inline content for this file${name} — encoding was ${JSON.stringify(file?.encoding ?? null)}. ` +
        `Files over 1 MB must be fetched from their download_url instead.`,
    );
  }
  const b64 = file.content.replace(/\s+/g, "");
  const toBinary = decode ?? (typeof atob === "function" ? atob : null);
  if (!toBinary) throw new Error("No base64 decoder available in this environment.");
  const binary = toBinary(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── errors, and the token ────────────────────────────────────────────────────

/**
 * Pure function. Strip anything token-shaped out of a string.
 *
 * NOTE 4's ENFORCEMENT. Every message this module emits passes through here, and
 * a test asserts a token cannot survive it. The patterns are GitHub's documented
 * token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and the fine-grained
 * `github_pat_`), plus a bare 40-hex classic token.
 *
 * This is a LAST LINE, not the strategy: the strategy is never putting a token in
 * a message at all. It exists because an error string is the likeliest place a
 * secret leaks — errors get pasted into bug reports — and a defense that depends
 * on every future author remembering is not a defense.
 *
 * @param {unknown} text
 * @returns {string}
 *
 * @example redacted("failed for ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
 * 'failed for «redacted»'
 * @example redacted("github_pat_11ABCDEFG0abcdefghijkl_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zz")
 * '«redacted»'
 * @example redacted("nothing secret here")
 * 'nothing secret here'
 */
export function redacted(text) {
  return String(text ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "«redacted»")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "«redacted»")
    .replace(/\b[0-9a-f]{40}\b/g, "«redacted»");
}

/**
 * Pure function. Turn a GitHub API failure into a sentence that says what to DO.
 *
 * THE THREE MEANINGS OF 403/404 (note 3) are the reason this is not a one-liner:
 *   • 403 + rate-limit body → you asked too often; here is when it resets. NOT a
 *     bug in the repo, and saying "failed" would send someone debugging nothing.
 *   • 403 otherwise         → the token lacks the scope, or cannot touch this repo.
 *   • 404 while anonymous   → PRIVATE and MISSING are indistinguishable by design
 *     (GitHub hides existence from those who cannot see it), so the message must
 *     name both possibilities instead of asserting the wrong one.
 *
 * @param {{status: number, headers?: {get: (h: string) => string|null}}} res
 * @param {{message?: string}} [body] The parsed JSON error body, when there was one.
 * @param {{owner: string, repo: string}} [target]
 * @param {boolean} [authed] Whether a token was sent.
 * @returns {string} A redacted, actionable sentence.
 *
 * @example // the rate limit says so plainly, and never says "failed":
 * githubErrorMessage({status: 403, headers: {get: (h) => (h === "x-ratelimit-remaining" ? "0" : null)}},
 * ...                {message: "API rate limit exceeded"}).includes("rate limit")
 * true
 * @example githubErrorMessage({status: 404}, {}, {owner: "a", repo: "b"}, false).includes("private")
 * true
 */
export function githubErrorMessage(res, body = {}, target = null, authed = false) {
  const where = target ? ` for ${target.owner}/${target.repo}` : "";
  const detail = redacted(body?.message ?? "");
  const remaining = res.headers?.get?.("x-ratelimit-remaining");
  const rateLimited = res.status === 403 && (remaining === "0" || /rate limit/i.test(detail));
  if (rateLimited) {
    const reset = Number(res.headers?.get?.("x-ratelimit-reset") ?? 0);
    // Say WHEN, not just "later" — the reset is an hour at most, so a real time
    // turns "try again sometime" into a decision the reader can make.
    const when = reset ? ` It resets at ${new Date(reset * 1000).toLocaleTimeString()}.` : "";
    return (
      `GitHub's rate limit is used up${where}.${when} ` +
      `Anonymous requests are capped at 60 per hour per IP address — this is not a problem with the repository. ` +
      `Wait for the reset, or sign in with a token to raise the limit.`
    );
  }
  if (res.status === 404) {
    return authed
      ? `Not found${where} — check the owner/name spelling, and that your token can see this repository.`
      : `Not found${where} — either it does not exist, or it is private. Private repositories need a token; check the spelling first.`;
  }
  if (res.status === 401) return `GitHub rejected the token${where}. Check that it is correct and has not expired.`;
  if (res.status === 403) return `GitHub refused this request${where}${detail ? `: ${detail}` : ""}. A token needs the "repo" scope to write.`;
  if (res.status === 422) return `GitHub rejected this as invalid${where}${detail ? `: ${detail}` : ""}.`;
  return `GitHub returned ${res.status}${where}${detail ? `: ${detail}` : ""}.`;
}

/**
 * Pure function. The request headers for a GitHub API call.
 *
 * The token is placed here and ONLY here — one construction site, so "what can
 * carry a token" is a single grep. Omitting the token yields a valid anonymous
 * request, which is the whole `?repo=` read path.
 *
 * @param {string|null} token
 * @returns {Record<string, string>}
 *
 * @example githubHeaders(null)
 * {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
 * @example Object.keys(githubHeaders("ghp_secret")).includes("Authorization")
 * true
 */
export function githubHeaders(token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Command (reads/writes localStorage). The remembered token, or "".
 *
 * OPT-IN ONLY (note 4). Nothing calls `rememberToken` unless the user ticked the
 * box, and the modal states in plain words what ticking it means. `forgetToken`
 * exists so withdrawing consent is one action rather than a trip through devtools.
 *
 * @param {Storage} [store]
 * @returns {string}
 *
 * @example // rememberToken(t, store); storedToken(store) === t
 */
export function storedToken(store = undefined) {
  const s = store ?? (typeof localStorage !== "undefined" ? localStorage : null);
  return s?.getItem(TOKEN_KEY) ?? "";
}

/** Command (writes localStorage). Remember a token in THIS browser. Only ever
 *  called on an explicit opt-in — see storedToken. */
export function rememberToken(token, store = undefined) {
  const s = store ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (s) s.setItem(TOKEN_KEY, token);
}

/** Command (writes localStorage). Forget any remembered token. */
export function forgetToken(store = undefined) {
  const s = store ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (s) s.removeItem(TOKEN_KEY);
}

/** The plain-words warning shown beside the "remember" checkbox. A constant so
 *  the wording is reviewable in one place rather than buried in markup, and so a
 *  test can assert we never ship a euphemism for "stored in this browser". */
export const TOKEN_STORAGE_WARNING =
  "Stored in this browser's local storage, unencrypted. Anyone with access to this browser profile can read it, " +
  "and any script running on this page could too. Leave this off on a shared computer — you can paste the token again next time.";

// ── the network ──────────────────────────────────────────────────────────────

/**
 * Query (network). One GitHub API call, with our error vocabulary.
 *
 * Every request in this file goes through here so that error translation,
 * redaction and header construction cannot drift between call sites.
 *
 * @param {string} path API path beginning with "/".
 * @param {{token?: string|null, target?: object, method?: string, body?: object}} [opts]
 * @returns {Promise<any>} The parsed JSON body.
 * @throws {Error} A redacted, actionable message (githubErrorMessage).
 */
async function githubApi(path, { token = null, target = null, method = "GET", body = null } = {}) {
  const init = { method, headers: githubHeaders(token) };
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${GITHUB_API}${path}`, init);
  } catch (e) {
    // A network-level failure carries no token, but it may carry a URL; redact
    // anyway rather than reasoning about which failures are safe.
    throw new Error(redacted(`Could not reach GitHub (${e?.message ?? e}). Check your network connection.`));
  }
  if (!res.ok) {
    let parsed = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {}; // a non-JSON error body is normal; the status still carries the meaning
    }
    throw new Error(githubErrorMessage(res, parsed, target, Boolean(token)));
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Query (network). Fetch bytes from a `download_url` with REAL byte progress.
 *
 * Progress is honest in the same sense bootProgress.js documents: Content-Length
 * when the server sends one, bytes-so-far when it does not, NEVER a synthetic
 * percentage. `raw.githubusercontent.com` does send a length, so the 1.2 MB video
 * that motivated this path reports a true fraction.
 *
 * @param {string} url
 * @param {(p: {loaded: number, total: number}) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
async function fetchBytesWithProgress(url, onProgress = () => {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(redacted(`HTTP ${res.status} ${res.statusText} while downloading ${url}`));
  const header = res.headers.get("content-length");
  const total = header ? Number(header) : 0;
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress({ loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  onProgress({ loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Query (network). A repository's contents at `path` (a file object, or an array
 *  for a directory). `ref` null = the repo's default branch, resolved by GitHub. */
async function repoContents(target, path, { token = null } = {}) {
  const query = target.ref ? `?${new URLSearchParams({ ref: target.ref })}` : "";
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return githubApi(`/repos/${target.owner}/${target.repo}/contents/${encoded}${query}`, { token, target });
}

/**
 * Query (network). THE LOAD PATH: fetch a project repo and return `{doc, assets}`
 * ready for the existing healed import.
 *
 * The shape is deliberately `parseProjectZip`'s — `{root, doc, assets}` with
 * assets as `{name, bytes}` — so the draft-open pipeline treats a repo and a zip
 * identically and neither grows a special case.
 *
 * PROGRESS IS REAL BYTES where obtainable (note: assets are sized by the listing
 * before any download, so the total is known up front rather than discovered).
 * Assets are fetched ONE AT A TIME, not Promise.all: a repo of large videos would
 * otherwise open N connections and hold N buffers, and the 60/hour anonymous rate
 * limit is friendlier to a serial walk.
 *
 * @param {string} slug `owner/name`, `owner/name@ref`, or a GitHub URL.
 * @param {{token?: string|null, onProgress?: Function}} [opts]
 * @returns {Promise<{root: string, doc: object, assets: Array<{name: string, bytes: Uint8Array}>, target: object}>}
 *
 * @example
 * >>> const {doc, assets} = await fetchProjectFromRepo("RyannDaGreat/PowerRP-RobotSim-Demo");
 * >>> assets.map((a) => a.name)
 * ['Video_20260726_224007_045.mp4']
 */
export async function fetchProjectFromRepo(slug, { token = null, onProgress = () => {} } = {}) {
  const target = parseRepoSlug(slug);
  onProgress({ stage: "layout", message: `Reading ${target.owner}/${target.repo}…`, loaded: 0, total: 0 });

  const rootEntries = await repoContents(target, "", { token });
  // `hasDoc` needs a per-directory answer, and the root listing cannot give one —
  // so probe the candidate directories FIRST (there are usually zero or one) and
  // let the pure decision function read the results.
  const dirs = (Array.isArray(rootEntries) ? rootEntries : []).filter((e) => e.type === "dir").map((e) => e.name);
  const docHolders = new Set();
  for (const dir of dirs) {
    let listing;
    try {
      listing = await repoContents(target, dir, { token });
    } catch {
      continue; // an unreadable subdirectory simply is not a candidate
    }
    if (Array.isArray(listing) && listing.some((e) => e.type === "file" && e.name === DOC_FILENAME)) docHolders.add(dir);
  }
  const { prefix } = projectLayout(rootEntries, (d) => docHolders.has(d));

  onProgress({ stage: "document", message: `Reading ${DOC_FILENAME}…`, loaded: 0, total: 0 });
  const docFile = await repoContents(target, `${prefix}${DOC_FILENAME}`, { token });
  const docPlan = assetFetchPlan(docFile);
  // A doc.json over 1 MB is unusual but entirely legal — a deck with many slides
  // reaches it — so the document takes the same two-mode path an asset does.
  const docBytes =
    docPlan.mode === "inline" ? decodedFileContent(docFile) : await fetchBytesWithProgress(docPlan.downloadUrl, () => {});
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(docBytes));
  } catch (e) {
    throw new Error(`${DOC_FILENAME} in ${target.owner}/${target.repo} is not valid JSON: ${redacted(e?.message ?? e)}`);
  }

  // The assets folder is OPTIONAL: a deck of pure vector slides references no
  // files at all, and a 404 here means exactly that, not a broken repo.
  let listing = [];
  try {
    listing = await repoContents(target, `${prefix}${ASSETS_SUBDIR}`, { token });
  } catch (e) {
    if (!/not found/i.test(e?.message ?? "")) throw e;
  }
  const wanted = assetEntries(listing);
  const totalBytes = wanted.reduce((sum, a) => sum + a.size, 0);
  let done = 0;
  const assets = [];
  for (const entry of wanted) {
    const report = (within) =>
      onProgress({ stage: "assets", message: `Downloading ${entry.name}…`, loaded: done + within, total: totalBytes });
    report(0);
    const plan = assetFetchPlan(entry);
    let bytes;
    if (plan.mode === "download" && plan.downloadUrl) {
      bytes = await fetchBytesWithProgress(plan.downloadUrl, (p) => report(p.loaded));
    } else {
      // No download_url in the listing (or it was inlineable): ask for the file
      // object, which carries content or a URL. This is the small-file path.
      const file = await repoContents(target, `${prefix}${ASSETS_SUBDIR}/${entry.name}`, { token });
      const filePlan = assetFetchPlan(file);
      bytes =
        filePlan.mode === "inline"
          ? decodedFileContent(file)
          : await fetchBytesWithProgress(filePlan.downloadUrl, (p) => report(p.loaded));
    }
    // The listing's size is GitHub's own claim about the file. If what arrived
    // disagrees, something truncated it — say so rather than importing a partial
    // asset, which is note 1's failure mode arriving by a different road.
    if (entry.size && bytes.byteLength !== entry.size) {
      throw new Error(
        `${entry.name} downloaded as ${bytes.byteLength} bytes but GitHub says it is ${entry.size} — the download was incomplete.`,
      );
    }
    assets.push({ name: entry.name, bytes });
    done += entry.size || bytes.byteLength;
    report(0);
  }

  onProgress({ stage: "done", message: "Opening…", loaded: totalBytes, total: totalBytes });
  // `root` mirrors parseProjectZip: the folder that names the project, or the
  // repo name when the layout is flat and there is no folder to read it from.
  return { root: prefix ? prefix.replace(/\/$/, "") : target.repo, doc, assets, target };
}

// ── the save path ────────────────────────────────────────────────────────────

/**
 * Pure function. The commit payload for one file in the contents API.
 *
 * `sha` is REQUIRED to overwrite an existing file and REJECTED when creating one,
 * so the caller looks up the current sha and passes it (or null). Getting this
 * wrong is a 422 with an unhelpful body, which is why the shape is built in one
 * tested place rather than inline at the call site.
 *
 * @param {{message: string, contentBase64: string, sha?: string|null, branch?: string|null}} spec
 * @returns {object} The request body.
 *
 * @example commitFileBody({message: "add doc", contentBase64: "aGk="})
 * {message: 'add doc', content: 'aGk='}
 * @example commitFileBody({message: "update", contentBase64: "aGk=", sha: "abc123"}).sha
 * 'abc123'
 */
export function commitFileBody({ message, contentBase64, sha = null, branch = null }) {
  const body = { message, content: contentBase64 };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;
  return body;
}

/**
 * Pure function. Base64-encode bytes for the contents API.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a multi-megabyte array
 * overflows the call stack — the 1.2 MB demo video would crash it. The chunk size
 * is well under every engine's argument limit.
 *
 * @param {Uint8Array} bytes
 * @param {(binary: string) => string} [encode] Binary-string→base64 (defaults to `btoa`).
 * @returns {string}
 *
 * @example base64FromBytes(new Uint8Array([104, 105]))
 * 'aGk='
 */
export function base64FromBytes(bytes, encode = undefined) {
  const toBase64 = encode ?? (typeof btoa === "function" ? btoa : null);
  if (!toBase64) throw new Error("No base64 encoder available in this environment.");
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return toBase64(binary);
}

/**
 * Command (network; creates and writes a GitHub repository). SAVE TO GITHUB, in
 * the BASIC FORM the user asked for: a PAT, one repo, per-file commits.
 *
 * DELIBERATELY NOT A GIT CLIENT. The contents API commits ONE FILE PER REQUEST,
 * which is O(files) round trips and cannot be atomic — a 30-asset deck is 31
 * commits. The tree/blob API would make it one commit, and OAuth would remove the
 * token paste. Both were declined for V1 on the user's "in its basic form"
 * ruling: this path is for publishing a deck occasionally, and the simple version
 * is auditable in one screen. The cost is stated here so the next author knows it
 * was a CHOICE and what to build when decks get big.
 *
 * THE TOKEN (note 4) is passed in, used for these requests, and never stored by
 * this function — persistence is the caller's opt-in, through `rememberToken`.
 *
 * @param {{doc: object, assets: Array<{name: string, bytes: Uint8Array}>}} project
 * @param {{name: string, owner?: string|null, token: string, private?: boolean, onProgress?: Function}} opts
 * @returns {Promise<{owner: string, repo: string, url: string, share: string, created: boolean, files: number}>}
 */
export async function saveProjectToRepo(project, { name, owner = null, token, private: isPrivate = false, onProgress = () => {} }) {
  if (!token) throw new Error("A GitHub token is required to save. Paste a Personal Access Token with the \"repo\" scope.");
  const repoName = String(name ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(repoName)) {
    throw new Error(`Invalid repository name ${JSON.stringify(repoName)} — use letters, numbers, dots, dashes and underscores.`);
  }

  const me = await githubApi("/user", { token });
  const targetOwner = owner || me.login;
  const target = { owner: targetOwner, repo: repoName, ref: null };

  // CREATE IF ABSENT. A 404 here is the ordinary "not yet" case, not an error —
  // but any OTHER failure must not be swallowed into "so let's create it".
  let created = false;
  onProgress({ stage: "repo", message: `Checking ${targetOwner}/${repoName}…` });
  let exists = true;
  try {
    await githubApi(`/repos/${targetOwner}/${repoName}`, { token, target });
  } catch (e) {
    if (!/not found/i.test(e?.message ?? "")) throw e;
    exists = false;
  }
  if (!exists) {
    onProgress({ stage: "repo", message: `Creating ${targetOwner}/${repoName}…` });
    // `auto_init` gives the repo a first commit; without one, the contents API
    // has no branch to write against and every file PUT fails with a 404.
    await githubApi("/user/repos", {
      token,
      target,
      method: "POST",
      body: { name: repoName, private: isPrivate, auto_init: true, description: `A PowerRP project. Open it with ?${REPO_PARAM}=${targetOwner}/${repoName}` },
    });
    created = true;
  }

  const files = [
    { path: DOC_FILENAME, bytes: new TextEncoder().encode(JSON.stringify(project.doc, null, 2)) },
    ...project.assets.map((a) => ({ path: `${ASSETS_SUBDIR}/${a.name}`, bytes: a.bytes })),
  ];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress({ stage: "files", message: `Uploading ${file.path}…`, loaded: i, total: files.length });
    // An existing file needs its sha to be overwritten (see commitFileBody).
    let sha = null;
    try {
      const current = await repoContents(target, file.path, { token });
      sha = current?.sha ?? null;
    } catch (e) {
      if (!/not found/i.test(e?.message ?? "")) throw e;
    }
    const encoded = file.path.split("/").map(encodeURIComponent).join("/");
    await githubApi(`/repos/${targetOwner}/${repoName}/contents/${encoded}`, {
      token,
      target,
      method: "PUT",
      body: commitFileBody({
        message: `${sha ? "Update" : "Add"} ${file.path} (PowerRP)`,
        contentBase64: base64FromBytes(file.bytes),
        sha,
      }),
    });
  }
  onProgress({ stage: "done", message: "Saved.", loaded: files.length, total: files.length });

  const appUrl = typeof location !== "undefined" ? location.href : PROJECT_REPO_URL;
  return {
    owner: targetOwner,
    repo: repoName,
    url: repoWebUrl(target),
    share: shareLink(target, appUrl),
    created,
    files: files.length,
  };
}
