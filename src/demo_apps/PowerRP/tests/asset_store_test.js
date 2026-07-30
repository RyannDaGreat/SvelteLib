/**
 * Storage-seam tests — plain node, no framework, no DOM, no IndexedDB.
 * Run: node src/demo_apps/PowerRP/tests/asset_store_test.js
 *
 * WHAT IS UNDER TEST is the PURE half of the storage seam: the asset-reference
 * grammar, the de-collision rules, the zip layout, and the quota formatting. Each
 * of those is a place where the LOCAL adapter must agree EXACTLY with what the
 * Python server does, and a disagreement is silent — a mismatched zip layout
 * still produces a valid .zip, it just cannot be imported by the other half.
 * So the assertions below are written against the server's documented behavior
 * (server/server.py zip_root_name / zip_relative_path / unique_project_name /
 * asset_kind), not merely against the client's own output.
 *
 * The adapters themselves are NOT tested here: they need IndexedDB and Blob, so
 * they are covered by the browser rehearsal instead. This file deliberately
 * imports only DOM-free modules, and by doing so ENFORCES that the grammar and
 * the zip layout stay DOM-free — importing web/assetStore.js here would drag in
 * projectApi.js, which reads `location` at module scope.
 */

import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";
import { ASSET_REF_PREFIX, assetKindForName, assetRef, parseAssetRef, plainDoc, quotaLine, quotaPercent, uniqueAssetName, uniqueProjectName } from "../web/assetRef.js";
import { humanReadableFileSize } from "../web/fileSize.js";
import { DOC_FILENAME, ASSETS_SUBDIR, mimeForAsset, parseProjectZip, zipEntries, zipRelativePath, zipRootName } from "../web/projectZip.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── The asset-reference grammar ─────────────────────────────────────────────

test("assetRef builds the server's /asset/<project>/<file> form", () => {
  assert.equal(assetRef("Imitations", "logo.png"), "/asset/Imitations/logo.png");
  // Percent-encoded per segment, exactly as server.py's urllib.parse.quote does.
  assert.equal(assetRef("My Talk", "a b.png"), "/asset/My%20Talk/a%20b.png");
  assert.ok(assetRef("P", "f").startsWith(ASSET_REF_PREFIX));
});

test("parseAssetRef round-trips assetRef, including spaces", () => {
  for (const [project, file] of [["Imitations", "logo.png"], ["My Talk", "a b.png"], ["100% Real", "π.png"]]) {
    assert.deepEqual(parseAssetRef(assetRef(project, file)), { project, file });
  }
});

test("parseAssetRef returns null for anything that is NOT an asset ref", () => {
  // The resolution seam asks this of EVERY src, so a non-asset must be an
  // ordinary null answer rather than a throw.
  for (const s of ["https://example.com/a.png", "data:image/png;base64,iVBO", "blob:http://x/y", "logo.png", "", null, undefined, "/asset/", "/asset/OnlyProject"]) {
    assert.equal(parseAssetRef(s), null, `expected null for ${JSON.stringify(s)}`);
  }
});

test("parseAssetRef keeps a nested thumbnail path in `file`", () => {
  // The server's cached thumbs live at /asset/<p>/.thumbs/<file>/<thumb>, and
  // they must stay addressable through the same grammar.
  assert.deepEqual(parseAssetRef("/asset/Deck/.thumbs/p.pdf/t.png"), { project: "Deck", file: ".thumbs/p.pdf/t.png" });
});

test("assetKindForName matches the server's asset_kind classes", () => {
  // Cases lifted from server.py asset_kind's own doctests.
  assert.equal(assetKindForName("logo.PNG"), "image"); // case-insensitive
  assert.equal(assetKindForName("clip.mp4"), "video");
  assert.equal(assetKindForName("ding.wav"), "sound");
  assert.equal(assetKindForName("paper.pdf"), "pdf");
  assert.equal(assetKindForName("Handwriting.ttf"), "font");
  assert.equal(assetKindForName("notes.txt"), "other");
  assert.equal(assetKindForName("noextension"), "other");
});

// ── De-collision: an import must NEVER overwrite ────────────────────────────

test("uniqueAssetName numbers before the extension", () => {
  assert.equal(uniqueAssetName("logo.png", []), "logo.png");
  assert.equal(uniqueAssetName("logo.png", ["logo.png"]), "logo 2.png");
  assert.equal(uniqueAssetName("logo.png", ["logo.png", "logo 2.png"]), "logo 3.png");
  assert.equal(uniqueAssetName("README", ["README"]), "README 2"); // no extension
  // A dotfile has no stem before the dot, so the whole name is the stem.
  assert.equal(uniqueAssetName(".gitignore", [".gitignore"]), ".gitignore 2");
});

test("uniqueProjectName uses the server's space-numbered prose scheme", () => {
  assert.equal(uniqueProjectName("Imitations", []), "Imitations");
  assert.equal(uniqueProjectName("Imitations", ["Imitations"]), "Imitations 2");
  assert.equal(uniqueProjectName("Talk", ["Talk", "Talk 2", "Talk 3"]), "Talk 4");
});

// ── The ZIP layout: the client must mirror zip_project_bytes EXACTLY ────────

test("zipEntries roots everything at <project>/ like zip_project_bytes", () => {
  const entries = zipEntries("My Talk", { slides: [] }, [{ name: "logo.png", bytes: new Uint8Array([1, 2, 3]) }]);
  assert.deepEqual(Object.keys(entries).sort(), ["My Talk/assets/logo.png", "My Talk/doc.json"]);
  // The subpaths are the server's constants, not re-spelled literals.
  assert.ok(`My Talk/${DOC_FILENAME}` in entries);
  assert.ok(`My Talk/${ASSETS_SUBDIR}/logo.png` in entries);
});

test("zipRootName matches the server's doctests", () => {
  assert.equal(zipRootName(["My Talk/doc.json", "My Talk/assets/a.png"]), "My Talk");
  assert.equal(zipRootName(["doc.json", "assets/a.png"]), null); // flat: no root
  assert.equal(zipRootName(["A/doc.json", "B/doc.json"]), null); // two roots
});

test("zipRelativePath strips the root, skips dirs, and REFUSES escapes", () => {
  assert.equal(zipRelativePath("My Talk/assets/a.png", "My Talk"), "assets/a.png");
  assert.equal(zipRelativePath("My Talk/", "My Talk"), null); // the root dir entry
  assert.equal(zipRelativePath("doc.json", null), "doc.json");
  assert.equal(zipRelativePath("__MACOSX/._doc.json", null), null); // Finder sidecar
  // A crafted archive must fail LOUDLY rather than write outside the project.
  assert.throws(() => zipRelativePath("../escape.json", null), /traversal/);
  assert.throws(() => zipRelativePath("/etc/passwd", null), /absolute path/);
  assert.throws(() => zipRelativePath("C:/Windows/x", null), /absolute path/);
  assert.throws(() => zipRelativePath("Other/doc.json", "My Talk"), /outside the archive root/);
});

test("parseProjectZip round-trips a client-built archive", () => {
  const doc = { meta: { name: "My Talk" }, slides: [{ id: "s1" }] };
  const bytes = zipSync(zipEntries("My Talk", doc, [{ name: "logo.png", bytes: new Uint8Array([9, 8, 7]) }]));
  const parsed = parseProjectZip(bytes);
  assert.equal(parsed.root, "My Talk");
  assert.deepEqual(parsed.doc, doc);
  assert.deepEqual(parsed.assets.map((a) => a.name), ["logo.png"]);
  assert.deepEqual([...parsed.assets[0].bytes], [9, 8, 7]);
});

test("parseProjectZip reads a SERVER-shaped archive (frames/.thumbs caches skipped)", () => {
  // zip_project_bytes includes the regenerable caches; importing them would
  // restore a stale thumbnail as if it were content, so only files DIRECTLY in
  // assets/ count — the same non-recursive rule list_assets uses.
  const bytes = zipSync({
    "Deck/doc.json": new TextEncoder().encode(JSON.stringify({ slides: [] })),
    "Deck/assets/a.png": new Uint8Array([1]),
    "Deck/assets/frames/clip.mp4/3/frame_000.png": new Uint8Array([2]),
    "Deck/assets/.thumbs/p.pdf/thumb.png": new Uint8Array([3]),
  });
  assert.deepEqual(parseProjectZip(bytes).assets.map((a) => a.name), ["a.png"]);
});

test("parseProjectZip refuses a non-zip, a doc-less archive, and bad JSON", () => {
  assert.throws(() => parseProjectZip(new Uint8Array([1, 2, 3, 4])), /not a \.zip archive/);
  assert.throws(() => parseProjectZip(zipSync({ "Deck/assets/a.png": new Uint8Array([1]) })), /no doc\.json/);
  assert.throws(() => parseProjectZip(zipSync({ "Deck/doc.json": new TextEncoder().encode("{not json") })), /not valid JSON/);
});

test("a client-built archive unzips to the paths the SERVER importer expects", () => {
  // The end-to-end interchange claim: server-side import_project_zip computes
  // zip_root_name then zip_relative_path per member, and requires doc.json among
  // the results. Reproduced here over the real archive bytes.
  const bytes = zipSync(zipEntries("Deck", { slides: [] }, [{ name: "a.png", bytes: new Uint8Array([1]) }]));
  const names = Object.keys(unzipSync(bytes));
  const root = zipRootName(names);
  const rel = names.map((n) => zipRelativePath(n, root)).filter((p) => p !== null);
  assert.equal(root, "Deck");
  assert.ok(rel.includes(DOC_FILENAME), "the server importer requires doc.json at the archive root");
  assert.ok(rel.includes(`${ASSETS_SUBDIR}/a.png`));
});

test("mimeForAsset restores a type for a blob rebuilt from raw zip bytes", () => {
  // A Blob built from zip bytes has an EMPTY type, which breaks <img>/<video>
  // and every `type.startsWith("image/")` check — so the type comes back from
  // the extension, with the server's octet-stream fallback.
  assert.equal(mimeForAsset("logo.PNG"), "image/png");
  assert.equal(mimeForAsset("clip.mp4"), "video/mp4");
  assert.equal(mimeForAsset("Handwriting.ttf"), "font/ttf");
  assert.equal(mimeForAsset("notes.txt"), "application/octet-stream");
});

// ── The quota readout (user ruling: say how close they are to filling up) ───

test("quotaLine renders '<used> of <quota> used' when supported", () => {
  assert.equal(quotaLine({ supported: true, usage: 4823129, quota: 2147483648 }, humanReadableFileSize), "4.6MB of 2GB used");
  assert.equal(quotaLine({ supported: true, usage: 0, quota: 1073741824 }, humanReadableFileSize), "0B of 1GB used");
});

test("quotaLine renders NOTHING in HTTP mode, but REPORTS a refused estimate", () => {
  // The user ruling: "in HTTP mode show nothing — the server has no quota".
  // A supported:false with no error is that case, and must be null (no row).
  assert.equal(quotaLine({ supported: false, reason: "server-backed storage has no per-browser quota" }, humanReadableFileSize), null);
  assert.equal(quotaLine(null, humanReadableFileSize), null);
  // A browser that CANNOT estimate is a different case: it is reported, not hidden.
  assert.equal(quotaLine({ supported: false, error: "navigator.storage.estimate is unavailable" }, humanReadableFileSize), "storage estimate unavailable");
});

test("quotaPercent is one-decimal, and null rather than dividing by zero", () => {
  assert.equal(quotaPercent({ supported: true, usage: 1073741824, quota: 2147483648 }), 50);
  assert.equal(quotaPercent({ supported: true, usage: 4823129, quota: 2147483648 }), 0.2);
  assert.equal(quotaPercent({ supported: true, usage: 100, quota: 0 }), null);
  assert.equal(quotaPercent({ supported: false }), null);
  assert.equal(quotaPercent(null), null);
});

test("plainDoc strips a reactive PROXY so IndexedDB can structured-clone it", () => {
  // The defect this exists for: app.doc is a Svelte $state proxy, and
  // structured clone REFUSES a Proxy — the first local save died with
  // DataCloneError. JSON.stringify walks a proxy fine, which is why the HTTP
  // adapter never saw it. Simulated here with a real Proxy, since bare node has
  // no Svelte runtime.
  const doc = { meta: { name: "Deck" }, slides: [{ id: "s1" }] };
  const proxied = new Proxy(doc, { get: (t, k) => t[k] });
  const plain = plainDoc(proxied);
  assert.deepEqual(plain, doc);
  assert.equal(structuredClone(plain).meta.name, "Deck"); // the operation that used to throw
  assert.throws(() => structuredClone(proxied), /could not be cloned|DataCloneError/);
});

console.log(`\n${passed} storage-seam tests passed.`);
