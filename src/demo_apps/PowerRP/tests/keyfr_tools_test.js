/**
 * WORKSTREAM KEYFR — the two keyframe-tool additions, in bare node.
 * Run: node src/demo_apps/PowerRP/tests/keyfr_tools_test.js
 *
 * TWO USER ASKS, BOTH ABOUT THE SAME SILENT GAP — the app knowing something and
 * declining to act on it:
 *
 *   [AW] "The buttons for previous keyframe and next keyframe should be disabled
 *        if there is no previous or next keyframe to go to."
 *   [AV] "A 'Keyframe Everything In Slide' tool"
 *
 * WHAT IS PINNED HERE AND WHAT IS DELIBERATELY NOT. This file tests the pure
 * DERIVATION for both — which slide an arrow would land on and what sentence that
 * produces (AW), and which state paths a bake writes (AV) — against the REAL
 * plugin registry, so the path sets are proved on the widgets a user really
 * selects rather than on stubs that could agree with a wrong implementation
 * (tests/multiselect_test.js's own two-halves rule).
 *
 * The UI assertions are minimal ON PURPOSE (the brief's instruction, and the
 * house budget): what a Svelte component renders is a browser probe's business,
 * so the only markup claim here is a STRUCTURAL grep — that the arrows carry
 * `aria-disabled` and NOT the native `disabled` attribute. That one is worth a
 * bare-node line because it is the standing ruling most likely to be "fixed" back
 * by a later contributor who does not know why: a natively disabled button is not
 * focusable, so the keyboard could never reach the sentence saying why it is dead.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { universalRows } from "../core/multiselect.js";
import { repairedDocument, foldState, keyframed, hasKeyframe } from "../core/document.js";
import { getPath } from "../core/deltas.js";
import {
  sectionJumpTarget,
  sectionJumpTip,
  itemBakePaths,
  keyframeEverythingHelp,
} from "../core/section_keyframes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

// ── [AW] THE ARROWS KNOW WHEN THEY CANNOT GO ─────────────────────────────────

test("AW: availability IS sectionJumpTarget — null exactly at the ends of the walk", () => {
  // x keys on slides 0 and 5, opacity on slide 2 — the union the arrows walk.
  const indices = [[0, 5], [2]];
  // Interior: both directions have somewhere to go.
  assert.equal(sectionJumpTarget(indices, 1, -1), 0);
  assert.equal(sectionJumpTarget(indices, 1, +1), 2);
  // The FIRST keyframed slide has no previous, the LAST has no next. These two
  // nulls ARE the user's ask; everything else in AW is how they are surfaced.
  assert.equal(sectionJumpTarget(indices, 0, -1), null);
  assert.equal(sectionJumpTarget(indices, 5, +1), null);
  // Standing ON a keyframe does not count as a target in either direction (the
  // comparison is strict), so slide 2 still walks outward both ways.
  assert.equal(sectionJumpTarget(indices, 2, -1), 0);
  assert.equal(sectionJumpTarget(indices, 2, +1), 5);
});

test("AW: a path set with NO keyframes at all is unavailable in both directions", () => {
  // The degenerate case the old silent no-op hid best: a row that has never been
  // keyed anywhere shows two live-looking arrows and neither can ever move.
  assert.equal(sectionJumpTarget([[]], 3, -1), null);
  assert.equal(sectionJumpTarget([[]], 3, +1), null);
  assert.equal(sectionJumpTarget([], 3, +1), null);
});

test("AW: the tooltip states the DIRECTION and the fact, and never goes blank", () => {
  assert.equal(sectionJumpTip(3, -1), "Previous keyframe");
  assert.equal(sectionJumpTip(7, +1), "Next keyframe");
  // A disabled arrow SAYS WHY. The sentence is the only place the reason is
  // written down, which is exactly why the button must stay focusable.
  assert.match(sectionJumpTip(null, -1), /No earlier slide/);
  assert.match(sectionJumpTip(null, +1), /No later slide/);
  // Both refusals name a direction, so the two arrows can never show one sentence.
  assert.notEqual(sectionJumpTip(null, -1), sectionJumpTip(null, +1));
  for (const [target, dir] of [[0, -1], [0, +1], [null, -1], [null, +1]])
    assert.ok(sectionJumpTip(target, dir).length > 0, `empty tip for ${target}/${dir}`);
  // SLIDE 0 IS A TARGET, NOT AN ABSENCE. `if (target)` instead of
  // `target !== null` would call a jump to the first slide "unavailable" — the
  // falsy-zero bug this line exists to catch.
  assert.equal(sectionJumpTip(0, -1), "Previous keyframe");
});

test("AW: the arrows are aria-disabled and NEVER natively disabled (house ruling)", () => {
  const src = readFileSync(join(APP, "web/KeyframeControls.svelte"), "utf8");
  assert.match(src, /aria-disabled=\{prevTarget === null\}/, "the ‹ arrow must report its own state");
  assert.match(src, /aria-disabled=\{nextTarget === null\}/, "the › arrow must report its own state");
  // THE BAN. A natively disabled button drops out of the tab order, and the
  // tooltip is the only place the reason lives — so `disabled=` here would delete
  // the sentence for every keyboard user while looking like a tidy-up.
  assert.doesNotMatch(src, /\sdisabled=\{/, "native `disabled` is banned on these buttons");
  // The guard is what actually refuses the click; aria-disabled only says so.
  assert.match(src, /if \(target === null\) return;/, "the handler must guard, not just the attribute");
});

// ── [AV] THE SLIDE-WIDE BAKE ─────────────────────────────────────────────────

test("AV: itemBakePaths is the section bubble's rule — writeKey resolved, keyframes:false dropped", () => {
  assert.deepEqual(
    itemBakePaths("a", [{ key: "x" }, { key: "cx", writeKey: "x" }, { key: "y" }]),
    [["items", "a", "x"], ["items", "a", "y"]],
    "cx writes THROUGH x, so the pair contributes one path, not two",
  );
  assert.deepEqual(
    itemBakePaths("a", [{ key: "name", keyframes: false }, { key: "type", keyframes: false }, { key: "x" }]),
    [["items", "a", "x"]],
    "a bake must not advertise a write the document refuses",
  );
  // A dotted row keys the NESTED leaf, exactly as its own diamond does.
  assert.deepEqual(itemBakePaths("a", [{ key: "rotationAnchor.x" }]), [["items", "a", "rotationAnchor", "x"]]);
});

/** Test helper. The rows web/app.svelte.js `bakePathsFor` bakes one item with —
 * its plugin's declared rows plus the universal ones, MINUS `type`.
 *
 * The `type` filter is stated in BOTH places on purpose, and the duplication is
 * the thing being tested rather than an accident: `universalRows` returns row
 * CONTRACTS and carries no `keyframes` aspect, so `keyframes: false` on `type` is
 * added by each consumer (web/Inspector.svelte does it too). That flag is a
 * statement about a missing retype-at-current-slide command, not about the
 * property — see the app method's docstring. If `universalRows` ever carries the
 * flag itself, this filter becomes a no-op and nothing here breaks. */
function bakeRowsFor(plugin) {
  return [...(plugin.inspector ?? []), ...universalRows([{ plugin }]).filter((r) => r.key !== "type")];
}

test("AV: against the REAL registry, a rect's bake covers its declared rows", () => {
  const plugin = registry.get("rect");
  const paths = itemBakePaths("r1", bakeRowsFor(plugin));
  const leaves = new Set(paths.map((p) => p.slice(2).join(".")));
  // The properties an author would expect a bake to pin, spanning every shape of
  // row: plain, dotted, and universal.
  for (const key of ["x", "y", "w", "h", "rotation", "opacity", "fill", "rotationAnchor.x", "shadow.blur", "active"])
    assert.ok(leaves.has(key), `the bake misses ${key} (leaves: ${[...leaves].slice(0, 8).join(", ")}…)`);
  // NOT keyframeable, and both are STORED leaves — which is exactly why reading
  // the stored fold instead of the declared rows would have baked them. `name` is
  // not a universal row at all; `type` is one and is filtered, because a bare type
  // write would leave the item holding its old plugin's state bag (core/retype.js).
  for (const key of ["name", "type"]) assert.ok(!leaves.has(key), `the bake must not key ${key}`);
  // THE FILTER IS REAL AND THE APP DOES IT: `universalRows` carries no `keyframes`
  // aspect, so an unfiltered bake WOULD key `type`. This is the measured failure
  // the first version of the method shipped, pinned in both directions.
  assert.ok(universalRows([{ plugin }]).some((r) => r.key === "type" && r.keyframes !== false),
    "universalRows now carries the flag itself — the app's filter can be simplified, and this test with it");
  assert.ok(
    itemBakePaths("r1", [...(plugin.inspector ?? []), ...universalRows([{ plugin }])])
      .some((p) => p[2] === "type"),
    "…and without the filter the bake really would key it",
  );
  // Every path is well-formed and rooted at this item.
  for (const p of paths) {
    assert.equal(p[0], "items");
    assert.equal(p[1], "r1");
    assert.ok(p.length >= 3);
  }
  // Deduplicated: cx/cy both write through x/y, so a naive concat would repeat.
  assert.equal(new Set(paths.map((p) => p.join(" "))).size, paths.length, "paths must be unique");
});

test("AV: THE CAMERA GETS NO `active` PATH — a bake cannot key what cannot be hidden", () => {
  // purgeable:false is the mandatory singleton; universalRows already withholds
  // the Visible row for it, and the bake inherits that rather than restating it.
  const cam = registry.get("camera");
  const camLeaves = new Set(itemBakePaths("cam", bakeRowsFor(cam)).map((p) => p.slice(2).join(".")));
  assert.ok(!camLeaves.has("active"), "the camera cannot be hidden, so its bake must not key `active`");
  assert.ok(camLeaves.has("background"), "…but its own rows are baked normally");
});

test("AV: EVERY registered widget produces a usable bake (no plugin is left out)", () => {
  // The sweep that makes the two claims above statements rather than samples: a
  // plugin whose rows are malformed would produce a path that is not a path, and
  // a plugin with no keyframeable row at all would silently bake nothing.
  let widgets = 0;
  for (const plugin of registry.all()) {
    const paths = itemBakePaths("x1", bakeRowsFor(plugin));
    for (const p of paths) {
      assert.ok(Array.isArray(p) && p.every((s) => typeof s === "string" && s.length > 0),
        `${plugin.type} produced a malformed path ${JSON.stringify(p)}`);
      assert.ok(!p.some((s) => s.includes(".")), `${plugin.type}: a dotted key must be SPLIT, not stored whole (${p.join("/")})`);
    }
    if (paths.length > 0) widgets++;
  }
  assert.ok(widgets > 20, `only ${widgets} widgets bake anything — the registry sweep found almost nothing`);
});

test("AV: the help OWNS the word BAKE and states the sparse-delta cost", () => {
  // The Aug-4 review's boundary: a bake is fine as an EXPLICIT action and a bug as
  // implicit behaviour. The explicitness has nowhere to live but this sentence, so
  // the word and the cost are both pinned.
  assert.match(keyframeEverythingHelp, /^BAKES this slide/);
  assert.match(keyframeEverythingHelp, /sparse/, "the cost must be stated, not implied");
  assert.match(keyframeEverythingHelp, /Select some widgets first/, "both scopes must be named");
  assert.match(keyframeEverythingHelp, /undo/i, "a destructive-looking bulk edit must say it is reversible");
  // A PLAIN STRING, not a function: core/commands.js rules `help` is rendered
  // directly by every surfacing, so a function would print its own source.
  assert.equal(typeof keyframeEverythingHelp, "string");
});

test("AV: the command entry is registered, gated, and reachable by the words users type", () => {
  const src = readFileSync(join(APP, "web/App.svelte"), "utf8");
  const line = src.split("\n").find((l) => l.includes('id: "keyframe-everything-in-slide"'));
  assert.ok(line, "the registry has no `keyframe-everything-in-slide` entry");
  // The title is the USER'S OWN WORDS, verbatim.
  assert.ok(line.includes('title: "Keyframe Everything In Slide"'), line.slice(0, 200));
  assert.ok(line.includes("when:") && line.includes("requires:"), "a gate without a reason is the defect the palette probe fails on");
  assert.ok(line.includes("help: keyframeEverythingHelp"), "the help must come from core, not a second copy here");
  assert.ok(line.includes("a.keyframeEverythingInSlide()"), "the entry must run the app's bake");
  // ALIASES ARE SUPERSTRINGS, not synonyms (the lesson `remove-slide-keyframes`
  // records): rpFuzzyScore needs the query's letters as a SUBSEQUENCE of the
  // target, so the phrasings a user actually types must APPEAR inside an alias.
  const aliases = JSON.parse(line.slice(line.indexOf("aliases: [") + 9, line.indexOf("]", line.indexOf("aliases: [")) + 1));
  for (const query of ["bake slide", "keyframe all", "keyframe everything", "bake this slide"])
    assert.ok(aliases.some((a) => a.includes(query)), `no alias contains "${query}" — the fuzzy match would miss it`);
});

test("AV: THE BAKE IS REAL — on a live document the fold does not move and every written path is keyed", () => {
  // THE END-TO-END INVARIANT, and the reason it is worth a document rather than a
  // stub: a bake writes ~161 leaves across five real widgets, and the ONE thing it
  // must not do is change the picture. Folding before and after must be identical.
  const raw = JSON.parse(readFileSync(join(APP, "examples/demo.powerrp.json"), "utf8"));
  const { doc: base } = repairedDocument(raw, registry);
  const slideIndex = 1;
  const fold = foldState(base, slideIndex, 1);
  const ids = Object.keys(fold.items).filter((id) => fold.items[id].active !== false && typeof fold.items[id].type === "string");
  assert.ok(ids.length >= 3, `the fixture must carry several widgets on slide ${slideIndex} (got ${ids.length})`);

  const paths = ids.flatMap((id) => itemBakePaths(id, bakeRowsFor(registry.get(fold.items[id].type))));
  // THE SKIP RULE, MEASURED. A property absent from the fold AND from the widget's
  // defaults holds nothing to pin. Writing `undefined` anyway does NOT keyframe —
  // it leaves an empty {} item in the delta that `hasKeyframe` reads as absent and
  // JSON.stringify drops — so the tool would claim EVERYTHING while doing most.
  const written = paths.filter((p) => getPath(fold, p) !== undefined);
  assert.ok(written.length < paths.length, "the fixture must exercise the skip branch, or this test proves nothing");
  assert.ok(written.length > paths.length / 2, "…but most paths must really carry values");

  let baked = base;
  for (const p of written) baked = keyframed(baked, slideIndex, p, getPath(fold, p));

  // 1. THE PICTURE DOES NOT CHANGE. This is the whole promise of a bake.
  assert.deepEqual(foldState(baked, slideIndex, 1), fold, "a bake must not move the fold it baked");
  // 2. EVERY WRITTEN PATH IS ACTUALLY KEYED HERE — no silent partial success.
  const missing = written.filter((p) => !hasKeyframe(baked, slideIndex, p));
  assert.deepEqual(missing, [], `${missing.length} written paths did not land as keyframes`);
  // 3. NO EMPTY ITEM OBJECTS. The junk an unfiltered undefined-write leaves behind.
  for (const [id, st] of Object.entries(baked.slides[slideIndex].delta.items ?? {}))
    assert.ok(Object.keys(st).length > 0, `the bake left an empty delta entry for ${id}`);
  // 4. THE SPARSE-DELTA COST IS REAL, which is exactly what the help warns about.
  const before = JSON.stringify(base.slides[slideIndex].delta).length;
  const after = JSON.stringify(baked.slides[slideIndex].delta).length;
  assert.ok(after > before * 2, `the delta barely grew (${before} → ${after}) — did the bake write anything?`);
});

test("AV: the run REPORTS its skips rather than quietly meaning `most`", () => {
  const src = readFileSync(join(APP, "web/app.svelte.js"), "utf8");
  const body = src.slice(src.indexOf("  keyframeEverythingInSlide() {"), src.indexOf("  bakePathsFor(ids) {"));
  assert.match(body, /storedValueAtPath\(p\) !== undefined/, "the bake must filter valueless paths, not write undefined");
  assert.match(body, /console\.warn|console\.error/, "a partial bake must say so — silent partial success is forbidden");
  assert.match(body, /SKIPPED/, "the report must name what was skipped");
  // And the help carries the same clause, so the user reads it BEFORE clicking too.
  assert.match(keyframeEverythingHelp, /holds no value at all is skipped/);
});

test("AV: the app's bake methods exist and read the DECLARED rows, not the stored fold", () => {
  const src = readFileSync(join(APP, "web/app.svelte.js"), "utf8");
  for (const name of ["bakeSlideTargets()", "keyframeEverythingInSlide()", "bakePathsFor(ids)"])
    assert.ok(src.includes(`  ${name} {`), `web/app.svelte.js is missing ${name}`);
  const body = src.slice(src.indexOf("  keyframeEverythingInSlide() {"), src.indexOf("  bakePathsFor(ids) {"));
  // ONE commit over a folded local — a per-leaf commit would make a slide-wide
  // bake take thousands of presses of Cmd+Z to take back.
  assert.equal((body.match(/this\.commit\(/g) ?? []).length, 1, "the bake must be ONE undo unit");
  assert.match(body, /storedValueAtPath/, "a bake copies each path's OWN stored value (equations stay equations)");
  // The rows come from the plugin declaration + universal rows, never from the fold.
  const paths = src.slice(src.indexOf("  bakePathsFor(ids) {"));
  assert.match(paths, /plugin\.inspector/);
  assert.match(paths, /universalRows/);
});

test("KEYFR: jumpSectionKeyframes and the arrows share ONE computation", () => {
  // The save-dot/save-button shape: the greying and the click must not be two
  // walks that could answer differently. `jumpSectionKeyframes` calls the same
  // query the component reads.
  const src = readFileSync(join(APP, "web/app.svelte.js"), "utf8");
  const jump = src.slice(src.indexOf("  jumpSectionKeyframes(paths, direction) {"), src.indexOf("  sectionJumpTargetFor(paths, direction) {"));
  assert.match(jump, /this\.sectionJumpTargetFor\(paths, direction\)/,
    "jumpSectionKeyframes must read the same query the buttons do, not its own copy");
  const ui = readFileSync(join(APP, "web/KeyframeControls.svelte"), "utf8");
  assert.match(ui, /app\.sectionJumpTargetFor\(keyPaths, -1\)/);
  assert.match(ui, /app\.sectionJumpTargetFor\(keyPaths, \+1\)/);
});

console.log(`\n${passed} keyfr tool tests passed`);
