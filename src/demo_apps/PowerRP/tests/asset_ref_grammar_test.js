/**
 * ASSET-REF GRAMMAR tests — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/asset_ref_grammar_test.js
 *
 * WHAT IS UNDER TEST: the two-form ref grammar (core/asset_ref.js) and THE
 * RESOLUTION SEAM that applies it (core/derive.js deriveRenderTree's third
 * argument).
 *
 * THE DEFECT (user report, verbatim intent): "If we give a source inside the JSON
 * and it's just a relative path, it should be relative to the current project. And
 * if it's an absolute path, it could be /asset/<project>/... so that if we wanted
 * to, it could be global."
 *
 * The failure that earned it: they dragged a RobotSim zip onto the STATIC GitHub
 * Pages site. The slides loaded and the asset imported into browser storage, and
 * the video still did not render — the document said
 * "/asset/Untitled/Video_….mp4" and no project called "Untitled" existed in that
 * browser. An ABSOLUTE ref bakes a project name that nothing keeps true: Save-As
 * mints the divergence, and a de-collided import mints it again. A RELATIVE ref has
 * no name to be wrong about.
 *
 * THE FAILURE MODES THESE ASSERTIONS EXIST FOR, each silent in production:
 *   1. A relative ref that does NOT get resolved is a blank widget — no error, no
 *      picture. Hence the seam tests, and specifically the ones covering the
 *      registries fed from INSIDE emit() (svgUrl), which an op-level rewrite would
 *      have missed.
 *   2. A NON-ref that DOES get resolved corrupts a working document — an http URL
 *      or a data: URI turned into "/asset/P/https://…". Hence the pass-through cases.
 *   3. An ABSOLUTE ref quietly rewritten breaks deliberate cross-project borrowing,
 *      and would silently migrate every existing document. Hence the identity cases.
 *   4. A resolution that allocates a new state object per frame would defeat both
 *      the evaluation memo and derive's own identity contract. Hence the
 *      same-object assertions, which are about performance but fail loudly.
 */

import assert from "node:assert/strict";
import {
  assetRef,
  assetRefPath,
  isRelativeAssetRef,
  parseAssetRef,
  pluginAssetRefProps,
  relativeAssetRef,
  resolveAssetRef,
  resolveStateAssetRefs,
} from "../core/asset_ref.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { deriveRenderTree } from "../core/derive.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** A folded+evaluated state holding ONE item — the shape deriveRenderTree takes. */
const stateWith = (item) => ({ vars: {}, items: { it: { active: true, x: 0, y: 0, rotation: 0, scale: 1, ...item } } });

/** The derived node for a one-item state, resolved against `project`. */
const nodeFor = (item, project) => deriveRenderTree(stateWith(item), registry, project).find((n) => n.itemId === "it");

// ── THE GRAMMAR: telling the two forms apart ────────────────────────────────

test("isRelativeAssetRef accepts a bare path and rejects every other src shape", () => {
  for (const relative of ["clip.mp4", "icons/logo.svg", "a b.png", "deep/nested/x.svg"])
    assert.equal(isRelativeAssetRef(relative), true, relative);
  // Absolute refs, remote URLs, inline payloads, object URLs and the built-in
  // library's scheme are all NOT relative refs — resolution must pass them through.
  for (const other of [
    "/asset/Deck/clip.mp4",
    "/anything/else",
    "https://example.com/a.png",
    "HTTPS://EXAMPLE.COM/a.png", // scheme match is case-insensitive
    "http://example.com/a.png",
    "//cdn.example.com/a.png",
    "data:image/png;base64,iVBO",
    "blob:https://x/9f0c",
    "builtin:library/clock_analog.plugin.js",
    "", // nothing authored yet — the GHOST state, not a ref
  ])
    assert.equal(isRelativeAssetRef(other), false, other);
  // Nullish is not a ref either (a widget whose property was never set).
  assert.equal(isRelativeAssetRef(null), false);
  assert.equal(isRelativeAssetRef(undefined), false);
});

test("parseAssetRef reads ONLY the absolute form (a relative ref has no project)", () => {
  assert.deepEqual(parseAssetRef("/asset/Imitations/logo.png"), { project: "Imitations", file: "logo.png" });
  assert.deepEqual(parseAssetRef("/asset/My%20Talk/a%20b.png"), { project: "My Talk", file: "a b.png" });
  // A nested path keeps its slashes as separators — that is how the server's
  // .thumbs/ paths stay addressable through the same grammar.
  assert.deepEqual(parseAssetRef("/asset/Deck/icons/logo.svg"), { project: "Deck", file: "icons/logo.svg" });
  assert.equal(parseAssetRef("clip.mp4"), null, "a relative ref names no project, so there is nothing to parse");
  assert.equal(parseAssetRef("https://example.com/a.png"), null);
});

test("assetRefPath encodes each SEGMENT, assetRef encodes the file WHOLE", () => {
  // The distinction is load-bearing, not stylistic. assetRef takes a BASENAME from
  // a listing; assetRefPath takes a relative ref an author wrote, where a "/" means
  // a folder. Collapsing the two yields "icons%2Flogo.svg" — one segment naming a
  // file that does not exist — which is the exact silent-miss class the localization
  // plan's refMap docblock records from the other direction.
  assert.equal(assetRefPath("Deck", "icons/logo.svg"), "/asset/Deck/icons/logo.svg");
  assert.equal(assetRef("Deck", "icons/logo.svg"), "/asset/Deck/icons%2Flogo.svg");
  // Both still encode WITHIN a segment.
  assert.equal(assetRefPath("My Talk", "a b.png"), "/asset/My%20Talk/a%20b.png");
});

// ── RESOLUTION: relative → absolute, everything else untouched ──────────────

test("resolveAssetRef turns a relative ref into the owning project's absolute ref", () => {
  assert.equal(resolveAssetRef("clip.mp4", "RobotSim"), "/asset/RobotSim/clip.mp4");
  assert.equal(resolveAssetRef("icons/logo.svg", "My Talk"), "/asset/My%20Talk/icons/logo.svg");
  // The round trip is exact, INCLUDING a name that needs encoding on both sides.
  assert.deepEqual(parseAssetRef(resolveAssetRef("a b.png", "My Talk")), { project: "My Talk", file: "a b.png" });
});

test("resolveAssetRef leaves an ABSOLUTE ref alone — cross-project borrowing stands", () => {
  // This is what makes the change a non-migration: every document written before
  // the grammar keeps working, byte-identically, and a deliberately foreign ref
  // keeps meaning what it says.
  assert.equal(resolveAssetRef("/asset/Shared/bg.png", "RobotSim"), "/asset/Shared/bg.png");
  assert.equal(resolveAssetRef("/asset/RobotSim/clip.mp4", "RobotSim"), "/asset/RobotSim/clip.mp4");
});

test("resolveAssetRef is IDEMPOTENT (the seam may be reached twice)", () => {
  const once = resolveAssetRef("clip.mp4", "RobotSim");
  assert.equal(resolveAssetRef(once, "RobotSim"), once);
  assert.equal(resolveAssetRef(resolveAssetRef(once, "RobotSim"), "Other"), once);
});

test("resolveAssetRef passes NON-REFS through byte-identically", () => {
  for (const src of ["https://example.com/a.png", "data:image/png;base64,iVBO", "blob:https://x/9f0c", "builtin:library/x.plugin.js", ""])
    assert.equal(resolveAssetRef(src, "RobotSim"), src, src);
});

test("resolveAssetRef is LOUD when a relative ref has no owning project", () => {
  // A relative ref is MEANINGLESS without one. The failure this whole change exists
  // to kill is a silently blank video, so the absent-project case must throw naming
  // the ref rather than resolve to something plausible that loads nothing.
  assert.throws(() => resolveAssetRef("clip.mp4", ""), /clip\.mp4.*relative asset ref/s);
  assert.throws(() => resolveAssetRef("clip.mp4", undefined), /no owning project/);
  // But a NON-ref with no project is fine — there is nothing to resolve.
  assert.equal(resolveAssetRef("https://example.com/a.png", ""), "https://example.com/a.png");
  assert.equal(resolveAssetRef("/asset/P/a.png", ""), "/asset/P/a.png");
});

// ── THE WRITER'S DIRECTION: absolute → relative ─────────────────────────────

test("relativeAssetRef strips the project ONLY for an own-project ref", () => {
  assert.equal(relativeAssetRef("/asset/RobotSim/clip.mp4", "RobotSim"), "clip.mp4");
  assert.equal(relativeAssetRef("/asset/My%20Talk/a%20b.png", "My Talk"), "a b.png");
  assert.equal(relativeAssetRef("/asset/Deck/icons/logo.svg", "Deck"), "icons/logo.svg");
  // A FOREIGN ref keeps its absolute spelling — naming the other project is the
  // entire content of that reference.
  assert.equal(relativeAssetRef("/asset/Shared/bg.png", "RobotSim"), "/asset/Shared/bg.png");
  // Already-relative and non-refs are untouched.
  assert.equal(relativeAssetRef("clip.mp4", "RobotSim"), "clip.mp4");
  assert.equal(relativeAssetRef("https://x.com/a.png", "RobotSim"), "https://x.com/a.png");
});

test("relativeAssetRef and resolveAssetRef ROUND-TRIP for an own-project ref", () => {
  // The property that makes writers safe: what a writer stores, the seam resolves
  // back to exactly what the writer was given.
  for (const [project, file] of [["RobotSim", "clip.mp4"], ["My Talk", "a b.png"], ["Deck", "icons/logo.svg"]]) {
    const absolute = assetRefPath(project, file);
    assert.equal(resolveAssetRef(relativeAssetRef(absolute, project), project), absolute, `${project}/${file}`);
  }
});

// ── WHICH PROPERTIES HOLD REFS (asked of the plugin, never of a key list) ───

test("pluginAssetRefProps reads a plugin's kind:\"asset\" inspector rows", () => {
  // The real registry, not a fixture: this is the contract the seam depends on, and
  // a widget that renamed its ref property must break this test rather than render
  // blank.
  assert.deepEqual(pluginAssetRefProps(registry.get("image")), ["src"]);
  // video carries TWO refs since the poster feature (R7-32): the clip and its
  // optional thumbnail image — both must resolve or a shared deck renders a
  // broken poster.
  assert.deepEqual(pluginAssetRefProps(registry.get("video")), ["src", "thumbnail"]);
  assert.deepEqual(pluginAssetRefProps(registry.get("filmstrip")), ["src"]);
  assert.deepEqual(pluginAssetRefProps(registry.get("svg")), ["svgUrl"], "svg's ref does NOT live in `src`");
  // A widget with no asset row costs nothing and returns the shared empty array.
  assert.deepEqual(pluginAssetRefProps(registry.get("rect")), []);
  assert.equal(pluginAssetRefProps(registry.get("rect")), pluginAssetRefProps(registry.get("text")));
  // The explicit declaration wins, for a widget whose ref is not behind an
  // inspector row.
  assert.deepEqual(pluginAssetRefProps({ assetRefProps: ["frames"], inspector: [{ key: "src", kind: "asset" }] }), ["frames"]);
  assert.deepEqual(pluginAssetRefProps({}), []);
});

// ── resolveStateAssetRefs: the per-item map, and its identity contract ──────

test("resolveStateAssetRefs resolves the named props and NOTHING else", () => {
  const out = resolveStateAssetRefs({ type: "video", src: "clip.mp4", caption: "notes.txt" }, ["src"], "RobotSim");
  assert.equal(out.src, "/asset/RobotSim/clip.mp4");
  // `caption` looks exactly like a relative ref and is NOT one — it is not a
  // declared ref property, so it is a LABEL and must survive verbatim. Guessing
  // here would rewrite a user's text.
  assert.equal(out.caption, "notes.txt");
});

test("resolveStateAssetRefs returns the SAME OBJECT when nothing needed resolving", () => {
  // Not a micro-optimization: derive uses object identity to mean "unchanged" (as
  // unsignedState does for the flip) and the evaluation memo is keyed on state
  // identity, so a fresh copy per frame for the all-absolute common case would
  // defeat both.
  const absolute = { type: "video", src: "/asset/Shared/clip.mp4" };
  assert.equal(resolveStateAssetRefs(absolute, ["src"], "RobotSim"), absolute);
  const refless = { type: "rect", w: 10 };
  assert.equal(resolveStateAssetRefs(refless, [], "RobotSim"), refless);
  const nonRef = { type: "image", src: "data:image/png;base64,iVBO" };
  assert.equal(resolveStateAssetRefs(nonRef, ["src"], "RobotSim"), nonRef);
});

test("resolveStateAssetRefs NEVER mutates its input", () => {
  const input = { type: "video", src: "clip.mp4" };
  const before = JSON.stringify(input);
  const out = resolveStateAssetRefs(input, ["src"], "RobotSim");
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(out, input);
});

// ── THE SEAM: deriveRenderTree resolves before emit() ever runs ─────────────

test("deriveRenderTree resolves a RELATIVE src against the owning project", () => {
  // The user's case, at the seam: a video whose src is the bare filename renders
  // against whatever project the document currently belongs to.
  assert.equal(nodeFor({ type: "video", src: "clip.mp4", w: 320, h: 180 }, "RobotSim").state.src,
    "/asset/RobotSim/clip.mp4");
  // And under a DIFFERENT name — a de-collided import, which is exactly what the
  // static site did to the user's archive — the SAME document resolves correctly.
  // That is the whole point of the relative form.
  assert.equal(nodeFor({ type: "video", src: "clip.mp4", w: 320, h: 180 }, "RobotSim 2").state.src,
    "/asset/RobotSim%202/clip.mp4");
});

test("deriveRenderTree resolves svgUrl too — the property behind an in-emit registry", () => {
  // THIS is why the seam is at derive and not at the op level. plugins/svg.js calls
  // ensureSvgSource(s.svgUrl) INSIDE emit(), so a rewrite applied to emit's OUTPUT
  // would resolve the image/video ops and leave this registry fetching the raw
  // relative string — a blank widget with no error. Resolving the node's STATE fixes
  // every consumer at once.
  const node = nodeFor({ type: "svg", svgSource: "url", svgUrl: "icons/logo.svg", w: 64, h: 64 }, "Deck");
  assert.equal(node.state.svgUrl, "/asset/Deck/icons/logo.svg");
});

test("deriveRenderTree leaves ABSOLUTE and NON-REF srcs exactly as authored", () => {
  // No mass migration, and no corruption of a remote/inline source.
  assert.equal(nodeFor({ type: "video", src: "/asset/Untitled/clip.mp4", w: 1, h: 1 }, "RobotSim").state.src,
    "/asset/Untitled/clip.mp4");
  assert.equal(nodeFor({ type: "image", src: "https://example.com/a.png", w: 1, h: 1 }, "RobotSim").state.src,
    "https://example.com/a.png");
  assert.equal(nodeFor({ type: "image", src: "data:image/png;base64,iVBO", w: 1, h: 1 }, "RobotSim").state.src,
    "data:image/png;base64,iVBO");
});

test("deriveRenderTree with NO project is byte-identical for an all-absolute document", () => {
  // Every document written before this grammar — and every one of the ~60 test call
  // sites that predate the third argument — must derive exactly as it did before.
  const state = stateWith({ type: "video", src: "/asset/Untitled/clip.mp4", w: 320, h: 180 });
  const withoutProject = deriveRenderTree(state, registry);
  const withProject = deriveRenderTree(state, registry, "RobotSim");
  assert.deepEqual(JSON.parse(JSON.stringify(withoutProject)), JSON.parse(JSON.stringify(withProject)));
  // The node's state is the very same object the fold produced — no copy was made.
  assert.equal(withoutProject[0].state, state.items.it);
});

test("deriveRenderTree is LOUD when a relative ref has no project to resolve against", () => {
  // A blank video is the failure this replaces. Naming the ref is what makes the
  // error actionable.
  assert.throws(
    () => deriveRenderTree(stateWith({ type: "video", src: "clip.mp4", w: 1, h: 1 }), registry),
    /clip\.mp4/,
  );
});

test("deriveRenderTree resolution survives the FLIP seam (a negative extent)", () => {
  // The flip splits a negative w/h into a positive box + node.mirror. Resolution
  // composes with it rather than being dropped by it — a mirrored video still finds
  // its file, and still reports the mirror.
  const node = nodeFor({ type: "video", src: "clip.mp4", w: -320, h: 180 }, "RobotSim");
  assert.equal(node.state.src, "/asset/RobotSim/clip.mp4");
  assert.equal(node.state.w, 320, "the sign is resolved away for every downstream reader");
  assert.deepEqual(node.mirror, { x: true, y: false });
});

console.log(`\n${passed} asset-ref grammar tests passed.`);
