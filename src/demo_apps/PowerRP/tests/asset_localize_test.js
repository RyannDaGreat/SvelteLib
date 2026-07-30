/**
 * Asset-localization tests — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/asset_localize_test.js
 *
 * WHAT IS UNDER TEST is the pure half of "make an export self-contained":
 * enumerating every asset reference in a document, deciding which are FOREIGN,
 * planning the copies, and rewriting the refs.
 *
 * THE DEFECT THAT MADE THIS FILE NECESSARY (user report, verbatim): "the
 * robotsim.zip references a video file, but that video file is not in that zip.
 * If I were to load that zip into the browser, it wouldn't know where the video
 * file was". RobotSim's doc.json referenced `/asset/Untitled/<video>` — a
 * CROSS-PROJECT reference, minted by Save-As (rename doc.meta.name, save to a new
 * folder, leave the assets behind) — while `zip_project_bytes` walked only
 * RobotSim's own folder. The archive was structurally valid and silently holed.
 *
 * So the assertions below care about three failure modes specifically, because
 * each of them is silent in production:
 *   1. A ref the walk MISSES is an asset that does not make it into the archive.
 *      Hence the nested / array / non-`src` / slide-transition cases.
 *   2. A non-ref the walk MATCHES corrupts a working document. Hence the equation
 *      and quoted-literal cases.
 *   3. A naming decision that differs between the server and the client makes the
 *      two archives non-interchangeable. Hence the plan is tested as DATA, with
 *      the de-collision scheme injected, so both halves can be checked against
 *      the same expected plan.
 */

import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { assetRef, uniqueAssetName } from "../web/assetRef.js";
import { adoptedArchiveRefs, documentAssetRefs, foreignAssetRefs, itemIdForPath, localizationPlan, relativizedOwnRefs, rewriteAssetRefs } from "../web/assetLocalize.js";
import { resolveAssetRef } from "../core/asset_ref.js";
import { buildProjectZip } from "../web/projectZip.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** An async test — buildProjectZip reads a store. Awaited inline (this file runs
 *  top to bottom), so a rejection still fails the process with a stack. */
async function testAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * A minimal in-memory asset store with the two methods buildProjectZip uses.
 * Stands in for BOTH real adapters (HTTP fetch and IndexedDB) — the export reads
 * them through one interface by design, and the point under test is the archive's
 * CONTENT, not either backing.
 *
 * @param {Record<string, Record<string, string>>} projects - {project: {file: text}}
 */
function fakeStore(projects) {
  return {
    list: async (project) => Object.keys(projects[project] ?? {}).map((name) => ({ name })),
    get: async (project, file) => {
      const text = projects[project]?.[file];
      // A missing asset THROWS, which is what both real adapters do (a non-OK
      // fetch, an absent IndexedDB record) and what the export's warning path
      // catches for a FOREIGN file.
      if (text === undefined) throw new Error(`no such asset: ${project}/${file}`);
      return new Blob([text]);
    },
  };
}

/** The archive as {members, doc} — the same inspection the python test does. */
function inspect(bytes) {
  const files = unzipSync(bytes);
  const docKey = Object.keys(files).find((k) => k.endsWith("/doc.json"));
  return { members: Object.keys(files).sort(), files, doc: JSON.parse(new TextDecoder().decode(files[docKey])) };
}

/** THE USER'S ACTUAL CASE, reduced: a project named RobotSim whose video src
 *  names the project it was saved-as FROM. Reused by several tests below. */
const robotSimDoc = {
  meta: { name: "RobotSim", script: "" },
  slides: [
    {
      id: "s1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", x: 0, w: 1280, h: 720 },
          vid: { type: "video", src: "/asset/Untitled/Video_20260726_224007_045.mp4", loop: true },
        },
      },
    },
  ],
};

// ── Enumeration: every ref, and nothing that is not one ─────────────────────

test("documentAssetRefs finds the user's cross-project video ref", () => {
  const refs = documentAssetRefs(robotSimDoc);
  assert.deepEqual(refs, [
    {
      path: "slides/0/delta/items/vid/src",
      itemId: "vid",
      ref: "/asset/Untitled/Video_20260726_224007_045.mp4",
      project: "Untitled",
      file: "Video_20260726_224007_045.mp4",
    },
  ]);
});

test("documentAssetRefs walks NESTED props, ARRAYS, and non-src keys", () => {
  // Every one of these is a real ref-bearing shape in the app: svgUrl (svg
  // widget), a filmstrip's frame list, a nested paint/effect sub-object, and a
  // SLIDE's transition sound (which is not inside an item state at all — that is
  // why itemId is nullable rather than always a string).
  const doc = {
    slides: [
      {
        transition: { sound: "/asset/Other/ding.wav" },
        delta: {
          items: {
            a: { svgUrl: "/asset/Other/logo.svg" },
            b: { frames: ["/asset/Other/f0.png", "/asset/Other/f1.png"] },
            c: { fill: { texture: { src: "/asset/Other/paper.jpg" } } },
          },
        },
      },
    ],
  };
  const refs = documentAssetRefs(doc);
  assert.deepEqual(
    refs.map((r) => [r.path, r.itemId, r.file]),
    [
      ["slides/0/transition/sound", null, "ding.wav"],
      ["slides/0/delta/items/a/svgUrl", "a", "logo.svg"],
      ["slides/0/delta/items/b/frames/0", "b", "f0.png"],
      ["slides/0/delta/items/b/frames/1", "b", "f1.png"],
      ["slides/0/delta/items/c/fill/texture/src", "c", "paper.jpg"],
    ],
  );
});

test("documentAssetRefs reports one entry PER OCCURRENCE, not per file", () => {
  // A rewrite has to touch both, and a report that said "1 asset" when two
  // leaves must change would be an incomplete instruction.
  const doc = {
    slides: [
      { delta: { items: { a: { src: "/asset/X/clip.mp4" } } } },
      { delta: { items: { b: { src: "/asset/X/clip.mp4" } } } },
    ],
  };
  assert.equal(documentAssetRefs(doc).length, 2);
});

test("documentAssetRefs does NOT match equation strings or non-asset URLs", () => {
  // Failure mode 2: matching a non-ref corrupts a working document. An equation
  // is an ordinary string leaf living right next to a real src.
  const doc = {
    slides: [
      {
        delta: {
          items: {
            t: {
              text: "= 1 + 2",
              x: "= self.anchors.center.x",
              // A ref-looking substring INSIDE a bigger expression is NOT a ref:
              // parseAssetRef is anchored at position 0 and consumes the whole
              // string, so a quoted literal in an equation is left alone.
              caption: '= "/asset/X/a.png" + name',
              // Neither are the other src forms a document legitimately holds.
              remote: "https://example.com/a.png",
              inline: "data:image/png;base64,iVBO",
              bare: "logo.png",
              builtin: "/builtin/gear.svg",
            },
          },
        },
      },
    ],
  };
  assert.deepEqual(documentAssetRefs(doc), []);
});

test("documentAssetRefs handles a document with no slides and odd leaves", () => {
  assert.deepEqual(documentAssetRefs({ meta: { name: "Empty" }, slides: [] }), []);
  // null / numbers / booleans are not strings and must not throw the walk.
  assert.deepEqual(documentAssetRefs({ slides: [{ delta: { items: { a: { x: 1, on: true, s: null } } } }] }), []);
});

test("itemIdForPath reads the segment after 'items', null outside an item", () => {
  assert.equal(itemIdForPath(["slides", "0", "delta", "items", "vid", "src"]), "vid");
  assert.equal(itemIdForPath(["slides", "0", "transition", "sound"]), null);
  assert.equal(itemIdForPath(["items"]), null); // "items" last: no id follows
});

// ── Foreign / local split ───────────────────────────────────────────────────

test("foreignAssetRefs keeps only refs naming another project, EXACTLY", () => {
  const refs = documentAssetRefs({
    slides: [
      {
        delta: {
          items: {
            own: { src: "/asset/RobotSim/a.png" },
            foreign: { src: "/asset/Untitled/clip.mp4" },
            // Case matters: a project folder name is case-sensitive, and
            // unique_project_name de-collides by exact match, so folding here
            // would call a genuinely different project local.
            cased: { src: "/asset/robotsim/b.png" },
          },
        },
      },
    ],
  });
  assert.deepEqual(
    foreignAssetRefs(refs, "RobotSim").map((r) => r.project),
    ["Untitled", "robotsim"],
  );
  assert.deepEqual(foreignAssetRefs(refs, "Nothing").length, 3);
});

test("a project with a SPACE round-trips through the percent-encoded grammar", () => {
  const doc = { slides: [{ delta: { items: { a: { src: assetRef("My Talk", "a b.png") } } } }] };
  const [ref] = documentAssetRefs(doc);
  assert.equal(ref.ref, "/asset/My%20Talk/a%20b.png");
  assert.deepEqual([ref.project, ref.file], ["My Talk", "a b.png"]);
  assert.deepEqual(foreignAssetRefs([ref], "My Talk"), []); // decoded, so it is LOCAL
});

// ── The plan ────────────────────────────────────────────────────────────────

test("localizationPlan copies each foreign file ONCE and maps its ref", () => {
  const refs = documentAssetRefs({
    slides: [
      { delta: { items: { a: { src: "/asset/Untitled/clip.mp4" } } } },
      { delta: { items: { b: { src: "/asset/Untitled/clip.mp4" } } } }, // same file again
    ],
  });
  const plan = localizationPlan(refs, "RobotSim", [], uniqueAssetName);
  // Each copy carries its OWN ref/to as well as the names, so a caller dropping
  // one copy (an unreadable source) removes exactly its mapping.
  // `to` is the RELATIVE form: a localized asset IS a file of the project the
  // document is becoming, so naming that project inside the ref adds nothing and
  // goes stale the moment the archive is imported under a de-collided name (the
  // user's static-site failure). See web/assetLocalize.js localizationPlan.
  assert.deepEqual(plan.copies, [
    { project: "Untitled", file: "clip.mp4", as: "clip.mp4", ref: "/asset/Untitled/clip.mp4", to: "clip.mp4" },
  ]);
  assert.deepEqual(plan.refMap, { "/asset/Untitled/clip.mp4": "clip.mp4" });
});

test("localizationPlan de-collides against local names AND its own copies", () => {
  const refs = documentAssetRefs({
    slides: [
      {
        delta: {
          items: {
            a: { src: "/asset/P1/logo.png" },
            b: { src: "/asset/P2/logo.png" }, // same basename, DIFFERENT project
          },
        },
      },
    ],
  });
  // "logo.png" is already taken locally, so both copies must land beside it —
  // and the second must not collide with the first, which is why `taken` grows
  // inside the plan rather than being read once.
  const plan = localizationPlan(refs, "Deck", ["logo.png"], uniqueAssetName);
  assert.deepEqual(
    plan.copies.map((c) => [c.project, c.as]),
    [
      ["P1", "logo 2.png"],
      ["P2", "logo 3.png"],
    ],
  );
  // RELATIVE, and therefore NOT percent-encoded: "logo 2.png" is a filename, not a
  // URL path. The absolute form had to encode the space; the relative form must not,
  // or the stored src would name a file called "logo%202.png" that does not exist.
  assert.deepEqual(plan.refMap, {
    "/asset/P1/logo.png": "logo 2.png",
    "/asset/P2/logo.png": "logo 3.png",
  });
});

test("localizationPlan flattens a NESTED foreign path and keys the ORIGINAL string", () => {
  // Both zip halves write a FLAT assets/ folder, so a ref naming a nested path
  // (a thumbnail-cache entry addresses through the same grammar) can only land
  // as its basename.
  //
  // THE REGRESSION THIS PINS, caught by this very test while it was being
  // written: the plan first keyed refMap by `assetRef(project, file)`, i.e. a
  // RE-MINTED ref. assetRef encodes the file as ONE segment, so a nested path
  // came back as "/asset/P/icons%2Flogo.svg" — which never equals the document's
  // own "/asset/P/icons/logo.svg". The rewrite matched nothing, the foreign ref
  // stayed, and the archive was holed again with every test still green. The key
  // must be the string the document actually holds.
  const doc = { slides: [{ delta: { items: { a: { src: "/asset/P/icons/logo.svg" } } } }] };
  const refs = documentAssetRefs(doc);
  const plan = localizationPlan(refs, "Deck", [], uniqueAssetName);
  assert.deepEqual(plan.copies, [
    { project: "P", file: "icons/logo.svg", as: "logo.svg", ref: "/asset/P/icons/logo.svg", to: "logo.svg" },
  ]);
  assert.deepEqual(plan.refMap, { "/asset/P/icons/logo.svg": "logo.svg" });
  // The end-to-end property: the rewrite actually LANDS, so nothing foreign remains.
  const out = rewriteAssetRefs(doc, (e) => plan.refMap[e.ref] ?? null);
  assert.equal(out.slides[0].delta.items.a.src, "logo.svg");
  assert.deepEqual(foreignAssetRefs(documentAssetRefs(out), "Deck"), []);
});

test("localizationPlan is EMPTY for an already self-contained document", () => {
  const refs = documentAssetRefs({ slides: [{ delta: { items: { a: { src: "/asset/Deck/a.png" } } } }] });
  const plan = localizationPlan(refs, "Deck", ["a.png"], uniqueAssetName);
  assert.deepEqual(plan.copies, []);
  assert.deepEqual(plan.refMap, {});
});

// ── The rewrite ─────────────────────────────────────────────────────────────

test("rewriteAssetRefs repoints the user's video and touches nothing else", () => {
  const plan = localizationPlan(documentAssetRefs(robotSimDoc), "RobotSim", [], uniqueAssetName);
  const out = rewriteAssetRefs(robotSimDoc, (e) => plan.refMap[e.ref] ?? null);
  assert.equal(out.slides[0].delta.items.vid.src, "Video_20260726_224007_045.mp4");
  // The rewritten document contains NO foreign ref — the property the archive needs.
  assert.deepEqual(foreignAssetRefs(documentAssetRefs(out), "RobotSim"), []);
  // Every other leaf survives byte-for-byte, including the untouched camera.
  assert.deepEqual(out.slides[0].delta.items.cam, robotSimDoc.slides[0].delta.items.cam);
  assert.deepEqual(out.meta, robotSimDoc.meta);
});

test("rewriteAssetRefs NEVER mutates its input (the on-disk doc stays authored)", () => {
  // The archive's doc.json is rewritten while the on-disk document is not — the
  // user ruling that the source project is untouched.
  const before = JSON.stringify(robotSimDoc);
  const out = rewriteAssetRefs(robotSimDoc, () => "/asset/Other/x.mp4");
  assert.equal(JSON.stringify(robotSimDoc), before);
  assert.notEqual(out, robotSimDoc);
  assert.equal(out.slides[0].delta.items.vid.src, "/asset/Other/x.mp4");
});

test("rewriteAssetRefs returning null/undefined leaves that ref alone", () => {
  const doc = {
    slides: [
      {
        delta: {
          items: {
            a: { src: "/asset/P1/a.png" },
            b: { src: "/asset/P2/b.png" },
          },
        },
      },
    ],
  };
  const out = rewriteAssetRefs(doc, (e) => (e.project === "P1" ? "/asset/Deck/a.png" : null));
  assert.equal(out.slides[0].delta.items.a.src, "/asset/Deck/a.png");
  assert.equal(out.slides[0].delta.items.b.src, "/asset/P2/b.png");
});

test("rewriteAssetRefs preserves arrays AS ARRAYS and non-string leaves", () => {
  // mapStrings rebuilds every container; an array that came back as an object
  // would be a valid-looking document that no widget could read.
  const doc = {
    slides: [{ delta: { items: { b: { frames: ["/asset/P/f0.png"], count: 1, on: true, s: null } } } }],
  };
  const out = rewriteAssetRefs(doc, () => "/asset/Deck/f0.png");
  assert.ok(Array.isArray(out.slides[0].delta.items.b.frames));
  assert.deepEqual(out.slides[0].delta.items.b, { frames: ["/asset/Deck/f0.png"], count: 1, on: true, s: null });
});

test("rewriteAssetRefs is a NO-OP shape-wise on a ref-free document", () => {
  const doc = { meta: { name: "D", script: "exports.f = () => 1;" }, slides: [{ delta: { items: { t: { text: "= 1 + 2" } } } }] };
  assert.deepEqual(rewriteAssetRefs(doc, () => "/asset/X/y.png"), doc);
});

// ── The CLIENT export, which must match the server's archive ────────────────
// The static-mode twin of server.py zip_project_bytes. Its layout is already
// covered by asset_store_test.js; what is tested HERE is localization, against the
// same fixtures tests/self_contained_zip_test.py drives through the server — so a
// divergence between the two halves shows up as one of these failing.

await testAsync("buildProjectZip carries the BORROWED asset and localizes the archived doc", async () => {
  // The user's case: RobotSim's assets are EMPTY and its only ref names Untitled.
  const store = fakeStore({ RobotSim: {}, Untitled: { "Video_20260726_224007_045.mp4": "VIDEO-BYTES" } });
  const { bytes, warnings } = await buildProjectZip("RobotSim", robotSimDoc, store);
  const { members, files, doc } = inspect(bytes);
  assert.deepEqual(warnings, []);
  assert.deepEqual(members, ["RobotSim/assets/Video_20260726_224007_045.mp4", "RobotSim/doc.json"].sort());
  assert.equal(new TextDecoder().decode(files["RobotSim/assets/Video_20260726_224007_045.mp4"]), "VIDEO-BYTES");
  assert.deepEqual(foreignAssetRefs(documentAssetRefs(doc), "RobotSim"), []);
});

await testAsync("buildProjectZip does NOT modify the document it was handed", async () => {
  // Only the archived copy is rewritten — the stored deck keeps saying what the
  // author wrote, matching the server's on-disk behavior.
  const before = JSON.stringify(robotSimDoc);
  await buildProjectZip("RobotSim", robotSimDoc, fakeStore({ RobotSim: {}, Untitled: { "clip.mp4": "V" } }));
  assert.equal(JSON.stringify(robotSimDoc), before);
});

await testAsync("buildProjectZip de-collides a borrowed basename against the local one", async () => {
  // The client's scheme is uniqueAssetName's "logo 2.png"; the server's is
  // "logo-2.png". They differ ON PURPOSE (each matches the rest of its own
  // storage's naming), which is why the ARCHIVE stays interchangeable while the
  // NAMES need not be identical — the ref and the member always agree.
  const doc = {
    meta: { name: "Deck" },
    slides: [{ delta: { items: { own: { src: "/asset/Deck/logo.png" }, borrowed: { src: "/asset/Lender/logo.png" } } } }],
  };
  const store = fakeStore({ Deck: { "logo.png": "LOCAL" }, Lender: { "logo.png": "FOREIGN" } });
  const { bytes, warnings } = await buildProjectZip("Deck", doc, store);
  const { files, doc: archived } = inspect(bytes);
  assert.deepEqual(warnings, []);
  // Asserted on the STORED SRCS, not on documentAssetRefs: that walk only recognizes
  // the ABSOLUTE form, so the localized ref — now relative — is invisible to it by
  // construction. Which is itself the property, asserted just below.
  const items = archived.slides[0].delta.items;
  assert.equal(items.own.src, "/asset/Deck/logo.png", "an already-local ref is left exactly as authored");
  assert.equal(items.borrowed.src, "logo 2.png", "the borrowed one localizes to the RELATIVE de-collided name");
  assert.deepEqual(documentAssetRefs(archived).map((r) => r.file), ["logo.png"],
    "only the authored absolute ref remains absolute; the localized one is relative");
  assert.equal(new TextDecoder().decode(files["Deck/assets/logo.png"]), "LOCAL", "the incumbent was overwritten");
  assert.equal(new TextDecoder().decode(files["Deck/assets/logo 2.png"]), "FOREIGN");
});

await testAsync("buildProjectZip WARNS on an unreadable foreign asset and keeps its ref", async () => {
  // Reported, never silent — and the ref is left as authored, because a findable
  // broken reference beats one pointing at a local file that does not exist. The
  // asymmetry with a missing LOCAL asset (which throws) is deliberate: a missing
  // local asset means this project's own storage is inconsistent.
  const doc = { meta: { name: "Broken" }, slides: [{ delta: { items: { v: { src: "/asset/Ghost/gone.mp4" } } } }] };
  const { bytes, warnings } = await buildProjectZip("Broken", doc, fakeStore({ Broken: {} }));
  const { members, doc: archived } = inspect(bytes);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("/asset/Ghost/gone.mp4"), warnings[0]);
  assert.deepEqual(members, ["Broken/doc.json"]);
  assert.equal(archived.slides[0].delta.items.v.src, "/asset/Ghost/gone.mp4");
});

await testAsync("buildProjectZip THROWS on a missing LOCAL asset (not a warning)", async () => {
  // The store lists it but cannot produce it: this project's own storage is
  // inconsistent, which is a bug, not an author's problem to see later.
  const store = {
    list: async () => [{ name: "ghost.png" }],
    get: async () => {
      throw new Error("no such asset");
    },
  };
  await assert.rejects(() => buildProjectZip("Deck", { meta: { name: "Deck" }, slides: [] }, store), /no such asset/);
});

await testAsync("buildProjectZip leaves a self-contained doc's archive alone", async () => {
  const doc = { meta: { name: "Solo" }, slides: [{ delta: { items: { i: { src: "/asset/Solo/a.png" } } } }] };
  const { bytes, warnings } = await buildProjectZip("Solo", doc, fakeStore({ Solo: { "a.png": "A" } }));
  const { members, doc: archived } = inspect(bytes);
  assert.deepEqual(warnings, []);
  assert.deepEqual(members, ["Solo/assets/a.png", "Solo/doc.json"]);
  assert.deepEqual(archived, doc); // no gratuitous rewrite
});

// ── relativizedOwnRefs: the pure half of RENAME = MOVE ──────────────────────
// THE DEFECT (user, verbatim): "as soon as I renamed the project, all the assets
// disappeared. That's cursed." Rename now MOVES the project folder. A RELATIVE
// ref survives that for free (it names no project); a LEGACY ABSOLUTE SELF-ref
// does not, so a rename relativizes its own absolute refs FIRST. These pin the
// three properties that make that safe: it is a no-op on the refs it must not
// touch, it is semantically identity at the instant it runs, and it is
// idempotent (so a retried or double-invoked rename cannot compound).

test("relativizedOwnRefs rewrites OWN absolute refs to their relative spelling", () => {
  const doc = { meta: { name: "Old" }, slides: [{ delta: { items: { v: { src: "/asset/Old/clip.mp4" } } } }] };
  assert.deepEqual(relativizedOwnRefs(doc, "Old"), {
    meta: { name: "Old" },
    slides: [{ delta: { items: { v: { src: "clip.mp4" } } } }],
  });
});

test("relativizedOwnRefs leaves FOREIGN refs absolute", () => {
  // "/asset/Shared/bg.png" means THAT project's file and keeps meaning it after
  // this project moves. Relativizing it would silently repoint it at a file this
  // project does not have — a hole, exactly like the one this module exists for.
  const doc = { slides: [{ delta: { items: { b: { src: "/asset/Shared/bg.png" } } } }] };
  assert.deepEqual(relativizedOwnRefs(doc, "Old"), doc);
});

test("relativizedOwnRefs is a no-op on already-relative refs and non-refs", () => {
  const doc = {
    slides: [{ delta: { items: {
      rel: { src: "clip.mp4" },
      remote: { src: "https://x.com/a.png" },
      data: { src: "data:image/png;base64,iVBO" },
      builtin: { src: "builtin:library/clock_analog.plugin.js" },
      text: { text: "= 1 + 2" },
    } } }],
  };
  assert.deepEqual(relativizedOwnRefs(doc, "Old"), doc);
});

test("relativizedOwnRefs handles percent-encoded names and NESTED paths", () => {
  // A nested path is a legal relative ref, and a space-bearing project name is
  // percent-encoded in the absolute spelling — both must survive the round trip,
  // because both are what the move relies on resolving afterwards.
  const doc = { slides: [{ delta: { items: {
    l: { src: "/asset/My%20Talk/icons/logo.svg" },
    s: { src: "/asset/My%20Talk/a%20b.png" },
  } } }] };
  assert.deepEqual(relativizedOwnRefs(doc, "My Talk"), {
    slides: [{ delta: { items: { l: { src: "icons/logo.svg" }, s: { src: "a b.png" } } } }],
  });
});

test("relativizedOwnRefs is IDEMPOTENT and never mutates its input", () => {
  const doc = { slides: [{ delta: { items: { v: { src: "/asset/Old/clip.mp4" } } } }] };
  const frozen = JSON.stringify(doc);
  const once = relativizedOwnRefs(doc, "Old");
  const twice = relativizedOwnRefs(once, "Old");
  assert.deepEqual(twice, once); // a second pass changes nothing
  assert.equal(JSON.stringify(doc), frozen); // the caller's document is untouched
  assert.notEqual(once, doc); // a copy, so `commit`/assignment sees a new object
});

test("relativizedOwnRefs is SEMANTICALLY IDENTITY at the instant it runs", () => {
  // The safety argument for relativizing BEFORE the move, made mechanical: while
  // the document still lives in "Old", resolving the rewritten refs against "Old"
  // reproduces the original document exactly. Only the LATER move changes what
  // "relative" means — by which time every self-ref is relative.
  const doc = { slides: [{ delta: { items: {
    v: { src: "/asset/Old/clip.mp4" },
    l: { src: "/asset/Old/icons/logo.svg" },
    b: { src: "/asset/Shared/bg.png" },
  } } }] };
  const relativized = relativizedOwnRefs(doc, "Old");
  // Resolve every `src` back against the SAME project, using the grammar's own
  // resolver (core/asset_ref.js) rather than a re-implementation here.
  const reresolved = JSON.parse(JSON.stringify(relativized), (k, v) =>
    (k === "src" ? resolveAssetRef(v, "Old") : v));
  assert.deepEqual(reresolved, doc);
});

test("adoptedArchiveRefs: an archive's own files heal ANY absolute ref at import (the user's legacy zips)", () => {
  // The live failure this pins (user, 2026-07-30): "RobotSim (7).zip" carried
  // assets/Video_….mp4 while its doc still said "/asset/Untitled/Video_….mp4" —
  // a pre-localization export (made by a server process older than the export
  // fixes). Imported on the static site, the resolver treated Untitled as a
  // FOREIGN project (by design) and the canvas showed nothing. The archive is
  // the authority for files it carries, whatever project name a stale ref bakes.
  const doc = { slides: [{ delta: { items: {
    v: { src: "/asset/Untitled/clip.mp4" },          // stale name, file IS in the archive → adopt
    n: { src: "/asset/Old/icons/logo.svg" },          // nested path, also carried → adopt
    b: { src: "/asset/Shared/bg.png" },               // NOT in the archive: a real borrow, untouched
    r: { src: "already-relative.mp4" },               // relative refs never rewritten
  } } }] };
  const healed = adoptedArchiveRefs(doc, ["clip.mp4", "icons/logo.svg", "already-relative.mp4"]);
  const items = healed.slides[0].delta.items;
  assert.equal(items.v.src, "clip.mp4");
  assert.equal(items.n.src, "icons/logo.svg");
  assert.equal(items.b.src, "/asset/Shared/bg.png");
  assert.equal(items.r.src, "already-relative.mp4");
  // Nothing adoptable → the SAME object back (import leaves a clean doc alone).
  const clean = { slides: [{ delta: { items: { b: { src: "/asset/Shared/bg.png" } } } }] };
  assert.equal(adoptedArchiveRefs(clean, ["clip.mp4"]), clean);
  assert.equal(adoptedArchiveRefs(clean, []), clean);
});

console.log(`\n${passed} asset-localization tests passed.`);
