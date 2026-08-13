/**
 * Conditional ghosts — integration probe (manifest 13.6 CONDITIONAL GHOSTS).
 * Run: node src/demo_apps/PowerRP/tests/ghost_test.js
 *
 * Proves the STATE-DEPENDENT ghost predicate end-to-end through the real
 * derivation pipeline (not just isGhostNode in isolation):
 *   - an empty filmstrip / an empty text run is a ghost (isGhostNode true).
 *   - a non-empty filmstrip / non-empty text is NOT a ghost.
 *   - the SAME predicate mechanism (core/derive.isGhostNode consulting
 *     capabilities.ghost OR plugin.isGhost(state)) serves both the static
 *     ghosts (cropbox, group, empty) and these dynamic ones — one
 *     canonical form, no dual paths.
 *
 * PRESENTATION-EXCLUSION SYMMETRY (found by this probe as an asymmetry, fixed
 * by OpusF in the Round 13.4 rich-text overhaul): filmstrip.emit()
 * short-circuits to `[]` when frameUrls is empty (sceneIR emits zero ops for
 * it — the presentation-exclusion the ghost predicate mirrors), and text.emit()
 * now does the SAME — it returns `[]` when richTextIsEmpty(s.text). So an empty
 * text box is a ghost in BOTH the editor (dashed outline + findability via
 * isGhostNode) AND the render (excluded from presentation/export exactly like
 * other ghosts). This probe asserts that symmetry explicitly.
 *
 * Registers only the plugins this probe needs (rect as an ordinary non-ghost
 * control, filmstrip, text, cropbox) — independent of other agents' in-flight
 * plugin files, following the group_integration_probe.js precedent.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { newDocument, foldState, withNewItem } from "../core/document.js";
import { deriveRenderTree, isGhostNode } from "../core/derive.js";
import { sceneIR } from "../render_gpu/ports.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera
import { filmstripPlugin } from "../plugins/filmstrip.js";
import { textPlugin } from "../plugins/text.js";
import { cropboxPlugin } from "../plugins/cropbox.js";

const registry = createRegistry();
for (const p of [rectPlugin, cameraPlugin, filmstripPlugin, textPlugin, cropboxPlugin]) registry.register(p);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

function nodeFor(itemId, doc) {
  const nodes = deriveRenderTree(foldState(doc, 0), registry);
  const node = nodes.find((n) => n.itemId === itemId);
  assert.ok(node, `node ${itemId} not found in derived tree`);
  return node;
}

// ── filmstrip ─────────────────────────────────────────────────────────────

// A SOURCELESS filmstrip is the ghost — the condition changed with the frames
// themselves: they used to be server-fetched stills whose absence (`frameUrls` empty)
// meant "nothing to show", and they are now live scrub frames of `src`, so the ONE
// thing that can leave the widget with nothing is having no video. The ghost-emits-
// nothing symmetry this file exists to police is unchanged.
test("sourceless filmstrip is a ghost and emits nothing", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { ...filmstripPlugin.defaults, active: true });
  const node = nodeFor(id, doc);
  assert.equal(isGhostNode(node), true);
  const ops = sceneIR([node]);
  assert.equal(ops.length, 0);
});

test("filmstrip with a video source is NOT a ghost and emits ops", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, {
    ...filmstripPlugin.defaults, active: true,
    src: "data:video/mp4;base64,aaaa", videoStart: 0, videoEnd: 6,
  });
  const node = nodeFor(id, doc);
  assert.equal(isGhostNode(node), false);
  const ops = sceneIR([node]);
  assert.ok(ops.length > 0);
});

// ── text ──────────────────────────────────────────────────────────────────

test("empty text box is a ghost AND emits nothing (presentation-exclusion symmetry — the gap the file header flagged, now fixed by OpusF)", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, {
    ...textPlugin.defaults, active: true,
    text: { runs: [{ text: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] },
  });
  const node = nodeFor(id, doc);
  assert.equal(isGhostNode(node), true); // the predicate itself is correct
  const ops = sceneIR([node]);
  assert.equal(ops.length, 0); // FIXED: text.emit() short-circuits to [] when richTextIsEmpty (matches filmstrip)
});

test("text with real content is NOT a ghost and emits ops", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { ...textPlugin.defaults, active: true }); // default run text: "Text"
  const node = nodeFor(id, doc);
  assert.equal(isGhostNode(node), false);
  const ops = sceneIR([node]);
  assert.ok(ops.length > 0);
});

// ── ordinary widget stays unaffected (no regression) ───────────────────────

test("an ordinary rect is never a ghost", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { ...rectPlugin.defaults, active: true });
  const node = nodeFor(id, doc);
  assert.equal(isGhostNode(node), false);
});

// ── one mechanism serves BOTH static and dynamic ghosts ────────────────────

test("a static ghost (cropbox, capabilities.ghost) and a dynamic ghost (empty text) both read true through the SAME isGhostNode call", () => {
  let doc = newDocument();
  let cropId, textId;
  [doc, cropId] = withNewItem(doc, 0, { ...cropboxPlugin.defaults, active: true });
  [doc, textId] = withNewItem(doc, 0, {
    ...textPlugin.defaults, active: true,
    text: { runs: [{ text: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] },
  });
  assert.equal(isGhostNode(nodeFor(cropId, doc)), true);
  assert.equal(isGhostNode(nodeFor(textId, doc)), true);
});

console.log(`\n${passed} tests passed`);
