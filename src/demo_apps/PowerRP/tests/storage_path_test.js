/**
 * storage_path_test.js — plain node, no DOM. THE FILE BROWSER'S PATH GRAMMAR
 * (web/storagePath.js): parse, join, parent, child, breadcrumbs, sort, filter.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING, in one sentence: that nobody ever
 * "simplifies" the parser back into a bare `path.split("/")`. Two real keys in
 * this app contain slashes that are NOT separators — the draft keyspace
 * `~draft/current` (which carries one deliberately, because server.py's
 * `_SAFE_NAME` forbids a slash in a project name, so a key with one can never be
 * mistaken for a library entry) and a CacheStorage entry, whose "name" is a whole
 * URL. A naive split reads "current" as a folder inside "~draft" and turns
 * "https://host/a.png" into four levels of fiction. Both cases are pinned below.
 *
 * The I/O half (web/storageTree.js) needs a browser — web/projectApi.js reads
 * `location` at module scope — and is covered by tests/file_browser_probe.js.
 *
 * Run: node src/demo_apps/PowerRP/tests/storage_path_test.js
 */

import assert from "node:assert/strict";
import {
  breadcrumbs,
  CACHES_KEYSPACE,
  childPath,
  filterEntries,
  isReservedKeyspace,
  joinPath,
  LEVELS,
  parentPath,
  parsePath,
  sortEntries,
  STORAGE_ROOTS,
} from "../web/storagePath.js";
import { DRAFT_KEY } from "../web/draftKeys.js";
import { validProjectName } from "../web/draftKeys.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── The roots ────────────────────────────────────────────────────────────────

test("there are exactly three roots, and 'builtin' reuses the scheme builtinAssets already mints", () => {
  assert.deepEqual([...STORAGE_ROOTS], ["local", "server", "builtin"]);
});

test("joinPath refuses an unknown root loudly rather than inventing one", () => {
  assert.throws(() => joinPath("cloud", "X"), /not a storage root/);
});

test("parsePath refuses a string that is not a storage path", () => {
  assert.throws(() => parsePath("/asset/RobotSim/arm.png"), /not a storage path/);
  assert.throws(() => parsePath(""), /not a storage path/);
});

// ── The four levels ──────────────────────────────────────────────────────────

test("a bare root parses as level 'root' with every part null", () => {
  assert.deepEqual(parsePath("local:/"), { root: "local", keyspace: null, category: null, name: null, level: "root" });
});

test("a full path parses into all four levels", () => {
  assert.deepEqual(parsePath("server:/RobotSim/assets/arm.png"), {
    root: "server", keyspace: "RobotSim", category: "assets", name: "arm.png", level: "name",
  });
});

test("the level names are the four the module documents, in order", () => {
  assert.deepEqual([...LEVELS], ["root", "keyspace", "category", "name"]);
});

// ── THE SLASH CASES — the whole reason this is a function ────────────────────

test("THE DRAFT KEY spans two segments: 'current' is part of the keyspace, not a category", () => {
  const p = parsePath(`local:/${DRAFT_KEY}/assets`);
  assert.equal(p.keyspace, DRAFT_KEY);
  assert.equal(p.category, "assets");
  assert.equal(p.name, null);
});

test("the draft key's two-segment span is not a special case but a rule about reserved keyspaces", () => {
  assert.ok(isReservedKeyspace(DRAFT_KEY));
  assert.ok(isReservedKeyspace(CACHES_KEYSPACE));
  assert.ok(!isReservedKeyspace("RobotSim"));
});

test("a RESERVED keyspace can never collide with a project, because a project name cannot contain '/'", () => {
  // This is the proof obligation behind the whole scheme, executed rather than
  // asserted in prose — the same discipline draftKeys.js applies to DRAFT_KEY.
  assert.ok(!validProjectName(DRAFT_KEY));
  assert.ok(!validProjectName(CACHES_KEYSPACE));
});

test("a reserved prefix with no second segment is REFUSED, not silently half-parsed", () => {
  assert.throws(() => parsePath("local:/~draft"), /reserved keyspace prefix/);
});

test("A CACHE ENTRY'S NAME IS A WHOLE URL — its slashes stay in the name, not made into levels", () => {
  const p = parsePath(`local:/${CACHES_KEYSPACE}/powerrp-icons/https://host/icons/a.png`);
  assert.equal(p.keyspace, CACHES_KEYSPACE);
  assert.equal(p.category, "powerrp-icons");
  assert.equal(p.name, "https://host/icons/a.png");
  assert.equal(p.level, "name");
});

test("an asset name containing a slash is a LEAF, not a fifth level", () => {
  // In the browser store a slash inside the file half of a key is just more
  // characters — IndexedDB has no folders (web/localDb.js).
  assert.equal(parsePath("local:/RobotSim/assets/sub/dir/thing.png").name, "sub/dir/thing.png");
});

// ── Round-tripping ───────────────────────────────────────────────────────────

test("parsePath(joinPath(...)) round-trips every shape, slashes included", () => {
  const cases = [
    ["local"],
    ["server", "RobotSim"],
    ["local", DRAFT_KEY, "assets"],
    ["server", "RobotSim", "assets", "arm.png"],
    ["local", CACHES_KEYSPACE, "powerrp-icons", "https://host/a.png"],
  ];
  for (const parts of cases) {
    const path = joinPath(...parts);
    const p = parsePath(path);
    const back = joinPath(p.root, ...[p.keyspace, p.category, p.name].filter((x) => x !== null));
    assert.equal(back, path, `round trip of ${path}`);
  }
});

// ── Up and down ──────────────────────────────────────────────────────────────

test("parentPath climbs exactly one level at a time", () => {
  assert.equal(parentPath("server:/RobotSim/assets/arm.png"), "server:/RobotSim/assets");
  assert.equal(parentPath("server:/RobotSim/assets"), "server:/RobotSim");
  assert.equal(parentPath("server:/RobotSim"), "server:/");
});

test("parentPath of a DRAFT category is the draft keyspace, never a phantom '~draft'", () => {
  assert.equal(parentPath(`local:/${DRAFT_KEY}/assets`), `local:/${DRAFT_KEY}`);
  assert.equal(parentPath(`local:/${DRAFT_KEY}`), "local:/");
});

test("there is NOTHING above a root — Up must be able to say so", () => {
  assert.equal(parentPath("local:/"), null);
  assert.equal(parentPath("builtin:/"), null);
});

test("childPath descends one level and keeps a slashed name whole", () => {
  assert.equal(childPath("local:/", "RobotSim"), "local:/RobotSim");
  assert.equal(childPath("server:/RobotSim/assets", "sub/dir/a.png"), "server:/RobotSim/assets/sub/dir/a.png");
});

test("childPath REFUSES to descend below a leaf rather than fabricating a fifth level", () => {
  assert.throws(() => childPath("server:/RobotSim/assets/arm.png", "deeper"), /no fifth level/);
});

// ── Breadcrumbs ──────────────────────────────────────────────────────────────

test("breadcrumbs give one jump target per level, root first", () => {
  assert.deepEqual(breadcrumbs("server:/RobotSim/assets/arm.png", "Project server"), [
    { label: "Project server", path: "server:/" },
    { label: "RobotSim", path: "server:/RobotSim" },
    { label: "assets", path: "server:/RobotSim/assets" },
    { label: "arm.png", path: "server:/RobotSim/assets/arm.png" },
  ]);
});

test("a root's breadcrumb trail is one crumb, and it is the root's own label", () => {
  assert.deepEqual(breadcrumbs("local:/", "This browser"), [{ label: "This browser", path: "local:/" }]);
});

test("every breadcrumb path re-parses — a crumb that cannot be navigated to is a dead link", () => {
  for (const crumb of breadcrumbs(`local:/${DRAFT_KEY}/renders/abc123`, "This browser")) {
    assert.doesNotThrow(() => parsePath(crumb.path), `crumb ${crumb.path}`);
  }
});

// ── Ordering and filtering ───────────────────────────────────────────────────

test("sortEntries puts directories first, then names case-insensitively", () => {
  const entries = [
    { name: "b.png", type: "file" }, { name: "renders", type: "dir" },
    { name: "A.png", type: "file" }, { name: "assets", type: "dir" },
  ];
  assert.deepEqual(sortEntries(entries).map((e) => e.name), ["assets", "renders", "A.png", "b.png"]);
});

test("sortEntries does not mutate its input", () => {
  const entries = [{ name: "b", type: "file" }, { name: "a", type: "file" }];
  const sorted = sortEntries(entries);
  assert.notEqual(sorted, entries);
  assert.equal(entries[0].name, "b");
});

test("filterEntries is FUZZY and matches on the PATH, not just the basename", () => {
  const entries = [
    { path: "server:/Deck/assets/clip.mp4" },
    { path: "server:/Deck/assets/logo.png" },
  ];
  assert.deepEqual(filterEntries(entries, "cmp4").map((e) => e.path), ["server:/Deck/assets/clip.mp4"]);
  // The path is what a widget's src holds, so searching for a string you pasted
  // somewhere finds it — the Asset Explorer's ruling, applied to entries.
  assert.equal(filterEntries(entries, "Deck").length, 2);
});

test("an empty filter is NOT a filter — same list, same order", () => {
  const entries = [{ path: "z" }, { path: "a" }];
  assert.deepEqual(filterEntries(entries, "   ").map((e) => e.path), ["z", "a"]);
});

test("a filter matching nothing returns [] so the caller can say 'nothing matched'", () => {
  assert.deepEqual(filterEntries([{ path: "server:/D/assets/logo.png" }], "zzzz"), []);
});

console.log(`\nstorage_path_test: ${passed} passed`);
