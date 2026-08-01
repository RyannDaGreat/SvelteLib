/**
 * storagePath.js — THE PATH GRAMMAR for the File Browser, and nothing else.
 *
 * DOM-free and pure, so it runs in bare node and every rule below is a doctest
 * rather than a claim. Split from web/storageTree.js (the I/O seam) exactly the
 * way web/assetRef.js is split from web/assetStore.js and web/draftKeys.js from
 * web/projectDraft.js: the grammar is the part worth pinning with a test, and the
 * part every surface must agree on.
 *
 * ── IT IS NOT A FILESYSTEM, AND THIS MODULE IS NOT A `vfs` ───────────────────
 * The user's own question about the front-end store was "well it's not a file
 * system, is it?" — and it is not. There are FIVE unrelated key-value stores
 * (IndexedDB `powerrp`, `powerrp-renderings`, `powerrp-browser-renders`,
 * localStorage, CacheStorage), plus a REAL directory tree behind HTTP. The only
 * path-like thing in the browser half is one deliberate single-level convention,
 * `"<project>/<file>"`, chosen so `IDBKeyRange.bound("P/", "P/￿")` can stand
 * in for a folder listing (web/localDb.js:19-22). Naming this module a virtual
 * filesystem would answer the user's question with the wrong word. It is a PATH
 * GRAMMAR FOR A TREE VIEW OVER STORAGE, and it says so.
 *
 * ── THE GRAMMAR ──────────────────────────────────────────────────────────────
 *
 *     <root>:/<keyspace>/<category>/<name>
 *
 * FOUR LEVELS, AND THE DEPTH IS FIXED — because that is how deep the honesty
 * goes (see LEVELS below for which levels are real enumerations and which one is
 * a presentation choice). A fifth level does not exist; a `/` inside <name> is
 * part of the name, not a folder, and `parsePath` says so by keeping it there.
 *
 * ── WHY PARSING IS A FUNCTION AND NEVER A BARE `.split("/")` ─────────────────
 * A KEYSPACE MAY CONTAIN A SLASH. `~draft/current` (web/draftKeys.js) contains one
 * ON PURPOSE: server.py's `_SAFE_NAME` forbids "/" in a project name, so a key
 * with one can never be mistaken for a library entry. This module generalises that
 * single existing idiom rather than inventing a second one — a keyspace beginning
 * with RESERVED_KEYSPACE_SIGIL spans TWO segments, which is what makes
 * `~storage/caches` collision-proof against a project a user really did name
 * "caches". Every other keyspace is exactly one segment.
 */

import { rpFuzzyRank } from "../core/fuzzy.js";

/** The three roots a path can name. `builtin` is NOT a new spelling: it is the
 *  scheme web/builtinAssets.js already mints for built-in urls
 *  (BUILTIN_URL_PREFIX = "builtin:"), so a built-in's storage path and its asset
 *  url agree on the word. */
export const STORAGE_ROOTS = Object.freeze(["local", "server", "builtin"]);

/** The character that marks a keyspace as RESERVED — i.e. one this app minted,
 *  not one a user named. A reserved keyspace spans TWO path segments (see the
 *  module docblock); `~draft/current` is the original and only pre-existing
 *  instance. A real project name can never begin with it AND contain a slash,
 *  which is what makes the two-segment rule unambiguous. */
export const RESERVED_KEYSPACE_SIGIL = "~";

/** The reserved keyspace holding this browser's NON-PROJECT storage: the
 *  service-worker caches and any stray IndexedDB database. It carries a slash for
 *  the same reason DRAFT_KEY does — `validProjectName` (web/draftKeys.js) rejects
 *  any name containing one, so no project can ever collide with it. */
export const STORAGE_KEYSPACE_PREFIX = `${RESERVED_KEYSPACE_SIGIL}storage/`;

/** The two members of that keyspace. Their leaf names are the SAME words
 *  web/debugStorage.js's STORAGE_GROUPS already uses ("caches", "other"), so the
 *  Debug console's Storage page and the File Browser name one thing once. */
export const CACHES_KEYSPACE = `${STORAGE_KEYSPACE_PREFIX}caches`;
export const OTHER_DB_KEYSPACE = `${STORAGE_KEYSPACE_PREFIX}other`;

/**
 * The four levels, in order, and WHICH OF THEM ARE HONEST — the one piece of
 * self-knowledge this whole module exists to carry. `real` is what the UI states
 * in a node's own detail line rather than hiding.
 *
 *   root      the store domain. Two or three exist at once, and in HTTP mode the
 *             tree genuinely HAS TWO ROOTS: documents and assets are server-side
 *             while renderings, caches and the draft keyspace are always
 *             browser-local (web/debugStorage.js:27-35).
 *   keyspace  REAL in both stores: `docs.getAllKeys()` browser-side,
 *             `os.listdir(PROJECTS_DIR)` server-side.
 *   category  REAL server-side (assets/ and renders/ are actual directories),
 *             an INVENTION browser-side (three separate databases wearing one
 *             parent's name). This is the one level that is a presentation
 *             choice, and the browser must say so.
 *   name      REAL: a bounded IndexedDB key range, or a real readdir.
 */
export const LEVELS = Object.freeze(["root", "keyspace", "category", "name"]);

/**
 * Pure function. Whether `keyspace` is one this app minted rather than one a user
 * named — the predicate behind the two-segment parse rule.
 *
 * @param {string} keyspace
 * @returns {boolean}
 *
 * @example isReservedKeyspace("~draft/current")
 * true
 * @example isReservedKeyspace("~storage/caches")
 * true
 * @example isReservedKeyspace("RobotSim")
 * false
 */
export function isReservedKeyspace(keyspace) {
  return String(keyspace ?? "").startsWith(RESERVED_KEYSPACE_SIGIL);
}

/**
 * Pure function. Build a canonical path from a root and its segments. The
 * inverse of parsePath, and `parsePath(joinPath(...))` round-trips for every
 * input this module accepts — including a name that itself contains slashes.
 *
 * @param {string} root - one of STORAGE_ROOTS
 * @param {...string} segments - keyspace, then category, then name (each optional)
 * @returns {string}
 *
 * @example joinPath("local")
 * 'local:/'
 * @example joinPath("server", "RobotSim", "assets", "arm.png")
 * 'server:/RobotSim/assets/arm.png'
 * @example // a reserved keyspace is passed WHOLE, slash included:
 * joinPath("local", "~draft/current", "assets")
 * 'local:/~draft/current/assets'
 */
export function joinPath(root, ...segments) {
  if (!STORAGE_ROOTS.includes(root)) throw new Error(`joinPath: "${root}" is not a storage root (${STORAGE_ROOTS.join(", ")})`);
  return `${root}:/${segments.filter((s) => s !== undefined && s !== null && s !== "").join("/")}`;
}

/**
 * Pure function. Split a canonical path into its parts. THROWS on anything it
 * cannot read — a malformed path is a caller bug, and answering with a root or a
 * null would send the browser somewhere the user did not ask for while looking
 * like it worked.
 *
 * `keyspace`/`category`/`name` are null when that level is not present, so a
 * caller reads the level it wants instead of counting segments. `name` KEEPS any
 * slashes it contains: in the browser store a slash inside the file half of a key
 * is just more characters (web/localDb.js), and in CacheStorage the "name" is a
 * whole URL.
 *
 * @param {string} path
 * @returns {{root: string, keyspace: ?string, category: ?string, name: ?string, level: string}}
 *
 * @example parsePath("local:/")
 * {root: 'local', keyspace: null, category: null, name: null, level: 'root'}
 * @example parsePath("server:/RobotSim/assets/arm.png")
 * {root: 'server', keyspace: 'RobotSim', category: 'assets', name: 'arm.png', level: 'name'}
 * @example // the draft keyspace spans two segments, so `category` is not "current":
 * parsePath("local:/~draft/current/assets")
 * {root: 'local', keyspace: '~draft/current', category: 'assets', name: null, level: 'category'}
 * @example // a cached response's "name" is a whole URL, slashes and all:
 * parsePath("local:/~storage/caches/powerrp-icons/https://x/y.png").name
 * 'https://x/y.png'
 */
export function parsePath(path) {
  const s = String(path ?? "");
  const cut = s.indexOf(":/");
  if (cut < 0) throw new Error(`parsePath("${s}"): not a storage path — expected "<root>:/<keyspace>/<category>/<name>"`);
  const root = s.slice(0, cut);
  if (!STORAGE_ROOTS.includes(root)) throw new Error(`parsePath("${s}"): "${root}" is not a storage root (${STORAGE_ROOTS.join(", ")})`);
  const rest = s.slice(cut + 2);
  const parts = rest === "" ? [] : rest.split("/");
  // A reserved keyspace spans two segments (see the module docblock). Consuming
  // it as a UNIT is the whole reason this is a function: a bare split would read
  // "current" as the category of a draft path and "caches" as a project.
  const keyspaceSpan = parts.length > 0 && isReservedKeyspace(parts[0]) ? 2 : 1;
  if (parts.length > 0 && parts.length < keyspaceSpan)
    throw new Error(`parsePath("${s}"): "${parts[0]}" is a reserved keyspace prefix and needs a second segment (e.g. "${DRAFT_KEY_EXAMPLE}")`);
  const keyspace = parts.length > 0 ? parts.slice(0, keyspaceSpan).join("/") : null;
  const after = parts.slice(keyspaceSpan);
  const category = after.length > 0 ? after[0] : null;
  const name = after.length > 1 ? after.slice(1).join("/") : null;
  const level = LEVELS[[keyspace, category, name].filter((p) => p !== null).length];
  return { root, keyspace, category, name, level };
}

/** Named only so the throw above can show a well-formed example without
 *  importing web/draftKeys.js (which would drag the save-state vocabulary into
 *  the path grammar for one error string). */
const DRAFT_KEY_EXAMPLE = "~draft/current";

/**
 * Pure function. The path one level UP, or null at a root (there is nothing
 * above a root — the File Browser's Up affordance is disabled there and says so).
 *
 * @param {string} path
 * @returns {?string}
 *
 * @example parentPath("server:/RobotSim/assets/arm.png")
 * 'server:/RobotSim/assets'
 * @example // up from a draft's assets is the draft keyspace, not "~draft":
 * parentPath("local:/~draft/current/assets")
 * 'local:/~draft/current'
 * @example parentPath("local:/")
 * null
 */
export function parentPath(path) {
  const { root, keyspace, category, name } = parsePath(path);
  if (name !== null) return joinPath(root, keyspace, category);
  if (category !== null) return joinPath(root, keyspace);
  if (keyspace !== null) return joinPath(root);
  return null;
}

/**
 * Pure function. The path one level DOWN. `segment` is appended whole, so a name
 * containing slashes stays one leaf rather than fabricating a fifth level.
 *
 * @param {string} path - the parent
 * @param {string} segment - the child's own label
 * @returns {string}
 *
 * @example childPath("local:/", "RobotSim")
 * 'local:/RobotSim'
 * @example childPath("server:/RobotSim/assets", "arm.png")
 * 'server:/RobotSim/assets/arm.png'
 */
export function childPath(path, segment) {
  const { root, keyspace, category, name } = parsePath(path);
  if (name !== null) throw new Error(`childPath("${path}", "${segment}"): a name is a leaf — this store has no fifth level (a slash inside a name is part of the name)`);
  return joinPath(root, ...[keyspace, category, segment].filter((p) => p !== null));
}

/**
 * Pure function. The breadcrumb trail for a path: one `{label, path}` per level,
 * ROOT FIRST, every one of them a jump target. The root's label is supplied by
 * the caller because only the tree knows what a root is called ("This browser" /
 * "Project server" / "Built-in library"); everything below it labels itself.
 *
 * @param {string} path
 * @param {string} rootLabel - the display name for the root crumb
 * @returns {{label: string, path: string}[]}
 *
 * @example breadcrumbs("server:/RobotSim/assets/arm.png", "Project server")
 * [{label: 'Project server', path: 'server:/'}, {label: 'RobotSim', path: 'server:/RobotSim'}, {label: 'assets', path: 'server:/RobotSim/assets'}, {label: 'arm.png', path: 'server:/RobotSim/assets/arm.png'}]
 * @example breadcrumbs("local:/", "This browser")
 * [{label: 'This browser', path: 'local:/'}]
 */
export function breadcrumbs(path, rootLabel) {
  const { root, keyspace, category, name } = parsePath(path);
  const trail = [{ label: rootLabel, path: joinPath(root) }];
  if (keyspace !== null) trail.push({ label: keyspace, path: joinPath(root, keyspace) });
  if (category !== null) trail.push({ label: category, path: joinPath(root, keyspace, category) });
  if (name !== null) trail.push({ label: name, path: joinPath(root, keyspace, category, name) });
  return trail;
}

/**
 * Pure function. Entries in DISPLAY ORDER: directories before files, then by name
 * within each group, case-insensitively. Directories first because a browser is
 * navigated before it is read; name order because that is what both stores
 * already sort by (server.py's list_assets and localAssetStore.list both
 * name-sort, so the grid's order does not change with the adapter).
 *
 * @param {{name: string, type: string}[]} entries
 * @returns {{name: string, type: string}[]} a NEW array
 *
 * @example
 * >>> sortEntries([{name: "b.png", type: "file"}, {name: "renders", type: "dir"}, {name: "A.png", type: "file"}]).map(e => e.name)
 * ['renders', 'A.png', 'b.png']
 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Pure function. Entries matching a fuzzy query, best match FIRST, matched
 * against the entry's PATH — the SAME rule and the SAME ranker the Asset Explorer
 * and the command palette use (core/fuzzy.js rpFuzzyRank, per the user ruling
 * "just fuzzy search by path. That's all."). Reused rather than reimplemented so
 * typing "vid" cannot rank differently in two places in one app.
 *
 * An EMPTY query returns the list unchanged, in its incoming order, so opening
 * the filter box does not reshuffle the view before a character is typed.
 *
 * @param {{path: string}[]} entries
 * @param {string} query
 * @returns {{path: string}[]}
 *
 * @example
 * >>> filterEntries([{path: "server:/D/assets/clip.mp4"}, {path: "server:/D/assets/logo.png"}], "cmp4").map(e => e.path)
 * ['server:/D/assets/clip.mp4']
 * @example // no match is an empty list, and the caller says "nothing matched" —
 * // never an empty pane indistinguishable from an empty folder:
 * >>> filterEntries([{path: "server:/D/assets/logo.png"}], "zzz")
 * []
 */
export function filterEntries(entries, query) {
  return rpFuzzyRank(entries ?? [], query, (e) => e.path);
}
