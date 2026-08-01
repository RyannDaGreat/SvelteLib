/**
 * THE ANCHOR-SNAP RELEASE PATH — plain node, no framework (suite convention).
 * Run: node src/demo_apps/PowerRP/tests/anchor_snap_release_test.js
 *
 * WHY THIS EXISTS: A SHIPPED, USER-FACING CRASH THAT EVERY GATE MISSED.
 * Holding `A` through the release of a snapped move or resize is meant to rewrite
 * the snapped coordinate as an EQUATION bound to the anchor it snapped to — a live
 * binding rather than a one-time correction (manifest ARCHITECTURE PLAN #4). It
 * threw instead. `core/snap.js:108` provenanceAnchorId(sourceAnchorId, anchorIds)
 * REQUIRES its second argument and THROWS a TypeError without it — a deliberate
 * loud refusal added when a hardcoded 15-name anchor whitelist was replaced by
 * asking the plugin. Both real callers, `web/CanvasView.svelte` writeMoveAnchorSnap
 * and writeResizeAnchorSnap, were never updated and passed ONE argument. So the
 * whole feature died with a TypeError out of the pointerup handler.
 *
 * AND HERE IS THE PART WORTH LEARNING FROM. A test did exist —
 * tests/silent_promises_test.js exercises provenanceAnchorId, and it was GREEN
 * throughout, because it calls the pure function with two arguments of its own
 * making. It tested a correct-by-construction IMITATION of a call path that was
 * wrong. That is this round's worst recurring shape: a hand-written mirror that
 * agrees with nothing. So this file asserts against THE CALL SITES THEMSELVES and
 * against the REAL composition they perform, not against a convenient stand-in.
 *
 * WHAT IT PROVES:
 *   (1) EVERY call site in the app passes both arguments. Read off the source, so
 *       a new caller that forgets is a red test rather than a crash in the field.
 *   (2) The loud refusal is still loud — one argument still throws. (1) is only
 *       meaningful while this holds; if the default came back, (1) would be
 *       policing a rule that no longer exists.
 *   (3) THE REAL COMPOSITION, end to end on a REAL document: derive a two-item
 *       scene through the actual pipeline, snap one to the other with the actual
 *       solver, and take the provenance the solver actually produced through
 *       nodeAnchors → provenanceAnchorId → anchorSnapEquation. This is the exact
 *       chain CanvasView runs, with nothing invented in between.
 *   (4) A source plugin's OWN anchors are what decide bindability — the reason
 *       the second argument exists at all.
 *   (5) An item purged mid-drag publishes no anchors, which reads as "not
 *       bindable" and leaves a plain number. That is the callers' documented
 *       partial-equation outcome, and it must not be a throw either.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE: that the pointerup handler is wired to the
 * `A` key. That is pointer plumbing and belongs to a browser probe.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { provenanceAnchorId, solveSnap, anchorSnapEquation } from "../core/snap.js";
import { deriveRenderTree, nodeAnchors, nodeFeatures } from "../core/derive.js";
import { newDocument, foldState, withNewItem } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/** Where a call site could live. `core/` and `web/` are the app's two hand-written
 *  layers; the pure function is in core and every consumer is in one of them. */
const CALL_SITE_DIRS = ["core", "web", "web/canvas"];

/**
 * Pure function. The argument text of every `provenanceAnchorId(...)` CALL in
 * `src`, by balanced-paren extraction. A regex cannot do this — an argument may
 * itself contain parentheses, which is exactly the shape of the fix
 * (`publishedAnchorIds(p.sourceItemId)`) — and a line-based scan would miss a
 * call split across lines.
 *
 * @param {string} src - file text
 * @returns {string[]} one entry per call, the raw text between the parentheses
 *
 * @example callArguments("x = provenanceAnchorId(a, ids(b));", "provenanceAnchorId") // ["a, ids(b)"]
 * @example callArguments("export function provenanceAnchorId(a, b) {}", "provenanceAnchorId") // ["a, b"]
 */
function callArguments(src, name) {
  const out = [];
  for (let i = src.indexOf(`${name}(`); i !== -1; i = src.indexOf(`${name}(`, i + 1)) {
    let depth = 0, j = i + name.length;
    const start = j + 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth += 1;
      else if (src[j] === ")") { depth -= 1; if (depth === 0) break; }
    }
    out.push(src.slice(start, j));
  }
  return out;
}

/** Pure function. Does this argument text hold TWO top-level arguments? Commas
 *  nested inside parens, brackets or braces do not separate arguments.
 *  @example topLevelArgumentCount("a, f(b, c)") // 2
 *  @example topLevelArgumentCount("a") // 1 */
function topLevelArgumentCount(text) {
  if (text.trim() === "") return 0;
  let depth = 0, count = 1;
  for (const ch of text) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return count;
}

test("(1) every provenanceAnchorId CALL passes both arguments", () => {
  const failures = [];
  let calls = 0;
  for (const dir of CALL_SITE_DIRS)
    for (const name of readdirSync(resolve(appRoot, dir))) {
      if (!/\.(js|svelte)$/.test(name)) continue;
      const rel = `${dir}/${name}`;
      const src = readFileSync(resolve(appRoot, rel), "utf8");
      for (const args of callArguments(src, "provenanceAnchorId")) {
        // The DEFINITION's parameter list is the one place a two-name list is not
        // a call; it is also the only place the word is preceded by `function`.
        if (src.includes(`function provenanceAnchorId(${args})`)) continue;
        calls += 1;
        const n = topLevelArgumentCount(args);
        if (n !== 2)
          failures.push(`${rel}: provenanceAnchorId(${args.trim()}) passes ${n} argument(s) — it THROWS on one, so this call is a crash on every anchor-snap release`);
      }
    }
  assert.ok(calls >= 2, `expected to find the real call sites, found ${calls} — did the scan lose them?`);
  assert.equal(failures.length, 0, `\n    ${failures.join("\n    ")}`);
  // The count includes the docstring @example calls in core/snap.js, deliberately:
  // an example that shows the wrong arity teaches the next caller the wrong thing,
  // which is how this defect propagates.
  console.log(`  note  ${calls} provenanceAnchorId call(s) checked across ${CALL_SITE_DIRS.join(", ")} (real call sites + documented examples)`);
});

test("(2) the loud refusal is still loud — one argument throws", () => {
  assert.throws(() => provenanceAnchorId("tm"), TypeError,
    "the required second argument became optional again, which silently declines every anchor — and would make check (1) police a rule that no longer exists");
});

// ── A real two-item scene, built through the real pipeline ───────────────────
const registry = createRegistry();
registerPlugins(registry);

/** Query (builds a document). Two rects, the second offset so a small nudge snaps
 *  its left edge onto the first's — the ordinary align-to-edge case. */
function scene() {
  let doc = newDocument(), a, b;
  [doc, a] = withNewItem(doc, 0, { ...registry.get("rect").defaults, type: "rect", active: true, x: 100, y: 100, w: 200, h: 120 });
  [doc, b] = withNewItem(doc, 0, { ...registry.get("rect").defaults, type: "rect", active: true, x: 103, y: 400, w: 80, h: 60 });
  const state = evaluateState(foldState(doc, 0, 1), registry).state;
  const nodes = deriveRenderTree(state, registry);
  return { nodes, a, b };
}

test("(3) the REAL composition: solver provenance → published anchors → equation", () => {
  const { nodes, a, b } = scene();
  const dragged = nodes.find((n) => n.itemId === b);
  const others = nodes.filter((n) => n.itemId !== b);
  const probes = nodeFeatures(dragged).filter((f) => f.kind === "point");
  const snap = solveSnap(probes, others.flatMap(nodeFeatures), 8);
  assert.ok(snap.provenance.length > 0, "the fixture must actually snap, or this test proves nothing");
  const p = snap.provenance[0];
  // THE EXACT CHAIN web/CanvasView.svelte runs, in the same order, with the same
  // inputs — no stand-in for the anchor list.
  const source = nodes.find((n) => n.itemId === p.sourceItemId);
  const publishedIds = nodeAnchors(source).map((x) => x.id);
  const anchorId = provenanceAnchorId(p.sourceAnchorId, publishedIds);
  assert.ok(anchorId, `the solver produced provenance "${p.sourceAnchorId}" that resolves to no published anchor — the release would silently leave a plain number`);
  assert.ok(publishedIds.includes(anchorId), "the resolved anchor must be one the plugin really publishes");
  const anchorValue = nodeAnchors(source).find((x) => x.id === anchorId).x ?? 0;
  const eq = anchorSnapEquation(p.sourceItemId, anchorId, "x", anchorValue, anchorValue);
  assert.equal(eq, `@${p.sourceItemId}_${anchorId}.x`, "a zero offset must produce the bare reference");
  const offsetEq = anchorSnapEquation(p.sourceItemId, anchorId, "x", anchorValue + 12, anchorValue);
  assert.equal(offsetEq, `@${p.sourceItemId}_${anchorId}.x + 12`);
});

test("(4) bindability is the SOURCE PLUGIN's answer, not a table's", () => {
  const { nodes, a } = scene();
  const source = nodes.find((n) => n.itemId === a);
  const published = nodeAnchors(source).map((x) => x.id);
  assert.ok(published.length > 0, "a rect must publish anchors");
  // A line feature binds to the point ON it that the plugin publishes…
  assert.ok(provenanceAnchorId("left", published), "an edge line must resolve to a published point");
  // …and a feature the plugin does NOT publish is honestly not bindable.
  assert.equal(provenanceAnchorId("v0", published), null);
  assert.equal(provenanceAnchorId(published[0], []), null, "publishing nothing means binding to nothing");
});

test("(5) an item purged mid-drag is not bindable, and is not a throw either", () => {
  // web/CanvasView.svelte publishedAnchorIds returns [] for a missing node, which
  // is the callers' documented partial-equation outcome (leave the plain number).
  assert.equal(provenanceAnchorId("tm", []), null);
});

console.log(`\nanchor_snap_release_test: ${passed} tests passed`);
