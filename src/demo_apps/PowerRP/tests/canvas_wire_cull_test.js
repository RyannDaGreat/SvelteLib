/**
 * THE EDITOR MUST HAND sceneIR THE PRE-CULL TREE — a source pin.
 * Run: node src/demo_apps/PowerRP/tests/canvas_wire_cull_test.js
 *
 * ── WHAT THIS CATCHES THAT NOTHING ELSE DOES ────────────────────────────────
 * `render_gpu/ports.js` implements the user's rule — "wires should only be culled
 * if BOTH nodes are outside view" — by taking the PRE-CULL tree as `ctx.wireNodes`
 * and treating membership in the culled list as "is this end on view". That rule is
 * thoroughly pinned at the ports.js level by tests/nodeflow_test.js.
 *
 * What was NOT pinned is whether each CALLER passes it. `web/cameraFrame.js` has
 * since WORKSTREAM BN; `web/CanvasView.svelte` — which does not go through
 * cameraFrame, it hand-assembles its own IR — did not. So the EDITOR alone derived
 * its wires from the culled list and dropped a cable the instant either endpoint
 * left the viewport, in the one surface where an author actually wires a patch.
 * ports.js names that as one of "the two wrong answers, both of which shipped at
 * some point"; it was still shipped here, and a green ports.js suite said nothing.
 *
 * ── WHY A SOURCE ASSERTION AND NOT A BEHAVIOURAL ONE ────────────────────────
 * The defect is a MISSING ARGUMENT at one call site inside a Svelte component. It
 * cannot be reached from bare node (the component needs Vite and a DOM), and from a
 * browser probe the editor's IR is not exposed — only its pixels, where a one-pixel
 * wire is the least reliable thing to assert on. The same technique, for the same
 * reason, as tests/toolbar_surfacing_test.js: pin the source when the source is
 * where the contract lives. It is deliberately narrow — it checks that the argument
 * is passed, not what it computes; ports.js's own suite owns the rule itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canvasView = readFileSync(resolve(powerRP, "web/CanvasView.svelte"), "utf8");
const cameraFrame = readFileSync(resolve(powerRP, "web/cameraFrame.js"), "utf8");

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL ${name}\n     ${e.message}`); }
};

test("EVERY sceneIR caller passes the pre-cull tree as wireNodes", () => {
  // Both halves in one test, because the point is that they AGREE: two surfaces
  // drawing the same slide must not disagree about which cables exist.
  for (const [label, src] of [["web/CanvasView.svelte", canvasView], ["web/cameraFrame.js", cameraFrame]]) {
    const calls = src.match(/sceneIR\(/g) ?? [];
    assert.ok(calls.length > 0, `${label} no longer calls sceneIR — this pin is now looking at the wrong file`);
    assert.match(src, /wireNodes:\s*allNodes/,
      `${label} calls sceneIR without \`wireNodes: allNodes\` — its wires are derived from the CULLED list, so a cable vanishes the moment either endpoint leaves the view`);
  }
});

test("the editor's culled list is a FILTER of the tree it passes as wireNodes", () => {
  // The argument only means anything if the two lists are the pre-cull and
  // post-cull halves of ONE derivation. A future edit that re-derives a second
  // tree for `allNodes` would satisfy the check above and still be wrong (two
  // derivations of one frame, and node identity no longer shared), so pin the
  // shape: allNodes comes from app.nodes(), and nodes is allNodes filtered.
  assert.match(canvasView, /const allNodes = app\.nodes\(\);/,
    "the editor's pre-cull tree is no longer app.nodes() — it must be the shared memoized derivation, not a private second one");
  assert.match(canvasView, /const nodes = allNodes\s*\n?\s*\.filter\(\(n\) => !canSkipNode\(n, viewRect\)/,
    "the editor's culled list is no longer `allNodes` filtered by canSkipNode — wireNodes and nodes must be the two halves of one derivation");
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall checks passed");
