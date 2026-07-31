/**
 * THE LEGACY SHAPE FREEZE — `type: "shape"` (System A, core/shapes.js's 17 baked
 * presets) keeps LOADING and RENDERING exactly as it always did, and stops being
 * INSERTABLE.
 *
 * The consolidation retires System A into the shapeshifter families: new
 * insertions can only make an `ss_*` type. But a deck authored before the split
 * still carries `type: "shape"` items, and the user ruling is that OLD DECKS KEEP
 * THEIR INK — we do not rewrite stored documents and we do not re-render them
 * through a "close enough" family. So the legacy plugin stays registered, its
 * generators stay frozen, and this suite is the assertion that both halves of
 * that promise hold:
 *
 *   1. FROZEN INK — every legacy preset's path `d` is pinned to a stored baseline.
 *      A change to core/shapes.js that moves any of these bytes fails here, which
 *      is the point: those bytes are what old decks draw.
 *   2. STILL RENDERS — the registered plugin emits a real `path` op for a legacy
 *      item, so a loaded deck is not blank.
 *   3. NOT INSERTABLE — no command anywhere arms placement of `type: "shape"`,
 *      and the toolbar picker offers only family tiles.
 *
 * Bare node (core/ + plugins/ are DOM-free); the picker check reads the Svelte
 * source as text, which is how the other markup guards in this suite work.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHAPE_NAMES, shapePath } from "../core/shapes.js";
import { shapePlugin } from "../plugins/shape.js";
import { FAMILIES } from "../plugins/shapeshifter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

// THE FROZEN BASELINE. Generated from core/shapes.js at the commit that retired
// System A, in a 100x100 box at each preset's DEFAULT knobs. These strings are
// the contract with every document already on disk: they are not "current
// output", they are what old decks are entitled to keep drawing.
const FROZEN = {
  star: "M50 0 L64.695 29.775 L97.553 34.549 L73.776 57.725 L79.389 90.451 L50 75 L20.611 90.451 L26.224 57.725 L2.447 34.549 L35.305 29.775 Z",
  triangle: "M50 0 L93.301 75 L6.699 75 Z",
  roundedTriangle: "M43 12.124 Q50 0 57 12.124 L86.301 62.876 Q93.301 75 79.301 75 L20.699 75 Q6.699 75 13.699 62.876 Z",
  pentagon: "M50 0 L97.553 34.549 L79.389 90.451 L20.611 90.451 L2.447 34.549 Z",
  hexagon: "M50 0 L93.301 25 L93.301 75 L50 100 L6.699 75 L6.699 25 Z",
  octagon: "M50 0 L85.355 14.645 L100 50 L85.355 85.355 L50 100 L14.645 85.355 L0 50 L14.645 14.645 Z",
  polygon: "M50 0 L93.301 25 L93.301 75 L50 100 L6.699 75 L6.699 25 Z",
  diamond: "M50 0 L100 50 L50 100 L0 50 Z",
  heart: "M50 98 C20 75 0 55 0 35 C0 12 30 6 50 25 C70 6 100 12 100 35 C100 55 80 75 50 98 Z",
  cloud: "M25 95 C10 95 5 80 15 70 C5 55 15 35 32 42 C38 22 62 22 68 42 C85 35 95 55 85 70 C95 80 90 95 75 95 Z",
  speechBubble: "M10.5 0 L89.5 0 Q100 0 100 10.5 L100 64.5 Q100 75 89.5 75 L42 75 L20 100 L28 75 L10.5 75 Q0 75 0 64.5 L0 10.5 Q0 0 10.5 0 Z",
  chevron: "M0 0 L55 0 L100 50 L55 100 L0 100 L45 50 Z",
  arrowBlock: "M0 30 L60 30 L60 10 L100 50 L60 90 L60 70 L0 70 Z",
  cross: "M33.333 0 L66.667 0 L66.667 33.333 L100 33.333 L100 66.667 L66.667 66.667 L66.667 100 L33.333 100 L33.333 66.667 L0 66.667 L0 33.333 L33.333 33.333 Z",
  lightning: "M60 0 L20 55 L45 55 L35 100 L80 40 L50 40 L70 0 Z",
  parallelogram: "M25 0 L100 0 L75 100 L0 100 Z",
  trapezoid: "M20 0 L80 0 L100 100 L0 100 Z",
};

test("FROZEN INK: every pinned legacy preset's path is byte-identical to its baseline", () => {
  for (const [name, d] of Object.entries(FROZEN)) {
    assert.equal(shapePath(name, 100, 100), d,
      `legacy preset "${name}" changed shape — old decks draw this path, it may not move`);
  }
});

test("FROZEN INK: the baseline covers EVERY legacy preset, so none can be deleted unnoticed", () => {
  assert.equal(SHAPE_NAMES.length, 17, `the legacy table is 17 presets, got ${SHAPE_NAMES.length}`);
  // Pinning only SOME presets would let a deleted or renamed one slip through, so
  // the baseline's key set and the live table's must match exactly.
  assert.deepEqual([...SHAPE_NAMES].sort(), Object.keys(FROZEN).sort(),
    "every legacy preset must be pinned, and the baseline must not name one that no longer exists");
});

test("FROZEN INK: every legacy path stays PDF-expressible (no elliptical arc)", () => {
  // pdf_backend's svgPathToPdfOps throws on `A`; the legacy generators were
  // written to that contract and freezing them must not quietly relax it.
  for (const name of SHAPE_NAMES) {
    const d = shapePath(name, 100, 100);
    assert.ok(d.endsWith("Z"), `${name}: closed`);
    assert.ok(!/[Aa]/.test(d), `${name}: no elliptical arc`);
  }
});

test("STILL RENDERS: the legacy plugin emits a real path op for a stored item", () => {
  const state = { ...shapePlugin.defaults, w: 120, h: 90 };
  const ops = shapePlugin.emit(state, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  assert.ok(Array.isArray(ops) && ops.length >= 1, "legacy shape emits at least one op");
  const paths = ops.filter((o) => o.op === "path");
  assert.equal(paths.length, 1, "exactly one path op (the preset silhouette)");
  assert.ok(paths[0].d.length > 0, "the path carries real geometry, not an empty d");
});

test("NOT INSERTABLE: the legacy plugin declares no placement command", () => {
  const cmds = shapePlugin.commands ?? [];
  assert.equal(cmds.length, 0,
    `the legacy shape must offer no Add command, found: ${cmds.map((c) => c.id).join(", ")}`);
});

test("NOT INSERTABLE: the toolbar picker renders family tiles only", () => {
  const src = readFileSync(resolve(HERE, "../web/ShapePicker.svelte"), "utf8");
  assert.ok(!/SHAPE_NAMES|SHAPE_LABELS/.test(src),
    "ShapePicker must not import the legacy preset table — that row is the bug being removed");
  assert.ok(!/registry\.get\("shape"\)/.test(src),
    "ShapePicker must not arm the legacy `shape` plugin");
  assert.ok(/familyItems/.test(src), "ShapePicker still renders the shapeshifter family tiles");
});

test("ONE PICKER: every family in the submenu is an ss_ type, and there are no duplicates", () => {
  const types = FAMILIES.map((f) => f.type);
  for (const t of types) assert.ok(t.startsWith("ss_"), `${t}: family types are ss_-namespaced`);
  assert.equal(new Set(types).size, types.length, "no duplicate family type");
  assert.ok(!types.includes("shape"), "the legacy type is not a family");
});

console.log(`\n${passed} legacy-freeze tests passed`);
