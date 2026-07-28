/**
 * SUBGRAPH-CLONE core tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/multipaste_test.js
 *
 * The user's ask: "when i select many objects and copy and paste, if they
 * reference each other in any properties of one another within that selection,
 * they should be rerouted to the new copies. and i should be able to copy paste
 * selections of objects which right now I can't".
 *
 * This file pins the PURE half of that — core/document.js clonedItemStates and
 * the core/expressions.js token rewriter it stands on — against the REAL plugin
 * registry, so the reference SHAPES are the ones the widgets actually store:
 *
 *   1. INTERNAL vs EXTERNAL. A reference from a cloned item to ANOTHER cloned
 *      item reroutes to that item's clone; a reference to an item that was NOT
 *      cloned stays pointing at the original and is reported as `external`.
 *      That boundary is the whole difficulty and it is asserted from both sides.
 *   2. EVERY REFERENCE SHAPE the document can hold: `@id.prop`, `@id_anchor.x`
 *      (arrow endpoint bindings), a bare `@id` widget argument, a per-VERTEX
 *      reference inside a declared list, the universal `= …` marker form, and
 *      the two ID-VALUED (non-equation) slots — group `members` and crop box
 *      `target`.
 *   3. NON-REFERENCES stay literal: an `@id` inside a string literal, an `@id`
 *      in a plain TEXT property, and a longer id that merely has a cloned id as
 *      its PREFIX (the bug a string-replace implementation would ship).
 *   4. The declaration can't drift: every `optionsFrom: "items"` inspector row
 *      (the Inspector's item picker — the other face of "this property holds an
 *      itemId") must be listed in its plugin's `itemRefs`.
 *
 * The APP half (the real copy→paste gesture, one undo unit, the pasted set
 * becoming the selection) needs Svelte runes + the server clipboard and lives in
 * tests/multipaste_probe.js.
 */

import assert from "node:assert/strict";
import { newDocument, withNewItem, clonedItemStates } from "../core/document.js";
import { storedRefItemId, withItemRefsRemapped } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { allPlugins } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** An idMap over every key of `states`, mapping "a" → "A" (uppercase = the clone),
 *  so an assertion reads as "the reference now names the CLONE". */
const upperMap = (states) => new Map(Object.keys(states).map((id) => [id, id.toUpperCase()]));

/** clonedItemStates with the uppercase idMap — the shorthand every case uses. */
const clone = (states) => clonedItemStates(states, upperMap(states), registry);

// ── The token rewriter (core/expressions.js) ──────────────────────────────────

test("storedRefItemId reads the itemId out of every stored reference form", () => {
  assert.equal(storedRefItemId("@ab12cd34.x"), "ab12cd34");          // property
  assert.equal(storedRefItemId("@ab12cd34_tm.y"), "ab12cd34");       // anchor
  assert.equal(storedRefItemId("@ab12cd34"), "ab12cd34");            // bare widget argument
  assert.equal(storedRefItemId("speed"), null);                      // a variable
  assert.equal(storedRefItemId("self.anchors.center.x"), null);      // identity-stable
  assert.equal(storedRefItemId("@"), null);                          // names nothing
});

test("withItemRefsRemapped rewrites only in-set ids and reports the rest", () => {
  const map = new Map([["a", "A"]]);
  assert.deepEqual(withItemRefsRemapped("@a.x + 10", map), { src: "@A.x + 10", external: [] });
  assert.deepEqual(withItemRefsRemapped("@a_tm.x", map), { src: "@A_tm.x", external: [] });
  assert.deepEqual(withItemRefsRemapped("@a.x + @c.x", map), { src: "@A.x + @c.x", external: ["c"] });
  assert.deepEqual(withItemRefsRemapped("closest_to_rim(@a, @c).x", map), { src: "closest_to_rim(@A, @c).x", external: ["c"] });
  assert.deepEqual(withItemRefsRemapped("speed * 2", map), { src: "speed * 2", external: [] });
});

test("withItemRefsRemapped survives the UNIVERSAL \"=\" marker (tokenize rejects \"=\")", () => {
  const map = new Map([["a", "A"]]);
  // Without the marker split this falls into the unparseable branch and the
  // clone silently keeps pointing at the ORIGINAL — the whole feature, gone for
  // every any-type binding.
  assert.deepEqual(withItemRefsRemapped("= @a.w / 2", map), { src: "= @A.w / 2", external: [] });
  assert.deepEqual(withItemRefsRemapped("=@a.w", map), { src: "=@A.w", external: [] });
  assert.deepEqual(withItemRefsRemapped("  =  @a.w", map), { src: "  =  @A.w", external: [] });
});

test("withItemRefsRemapped is TOKEN-structural, not a string replace", () => {
  const map = new Map([["a", "A"]]);
  // A longer id that merely STARTS with a cloned id must not be touched.
  assert.deepEqual(withItemRefsRemapped("@ab.x", map), { src: "@ab.x", external: ["ab"] });
  // An "@a" inside a STRING LITERAL is text, not a reference.
  assert.deepEqual(withItemRefsRemapped('= "@a wins"', map), { src: '= "@a wins"', external: [] });
});

// ── clonedItemStates: the internal/external boundary ─────────────────────────

test("A -> B INSIDE the set reroutes to the clone (A' -> B')", () => {
  const out = clone({ a: { type: "rect", x: "@b.x + 20" }, b: { type: "rect", x: 5 } });
  assert.equal(out.states.A.x, "@B.x + 20");
  assert.deepEqual(out.external, []);
  assert.deepEqual(Object.keys(out.states).sort(), ["A", "B"]);
});

test("A -> C OUTSIDE the set still points at C, and C is reported", () => {
  const out = clone({ a: { type: "rect", x: "@c.x + 20" } });
  assert.equal(out.states.A.x, "@c.x + 20", "an external reference must NOT be rerouted or broken");
  assert.deepEqual(out.external, ["c"]);
});

test("one item can hold BOTH an internal and an external reference", () => {
  const out = clonedItemStates(
    { a: { type: "rect", x: "@b.x", y: "@c.y" }, b: { type: "rect" } },
    new Map([["a", "A"], ["b", "B"]]), registry);
  assert.equal(out.states.A.x, "@B.x", "internal → clone");
  assert.equal(out.states.A.y, "@c.y", "external → original");
  assert.deepEqual(out.external, ["c"]);
});

test("ARROW endpoint bindings (@id_anchor.x pairs) reroute as one", () => {
  const out = clone({
    ar: { type: "arrow", from: { x: "@b_tm.x", y: "@b_tm.y" }, to: { x: "@c_tm.x", y: 0 } },
    b: { type: "rect" },
  });
  assert.deepEqual(out.states.AR.from, { x: "@B_tm.x", y: "@B_tm.y" });
  assert.deepEqual(out.states.AR.to, { x: "@c_tm.x", y: 0 }, "the unselected endpoint keeps its binding");
  assert.deepEqual(out.external, ["c"]);
});

test("a per-VERTEX reference inside a DECLARED list reroutes (leaves() cannot see it)", () => {
  const out = clone({
    p: { type: "polygon", points: [[0, "= @b_tm.y"], [10, 20]] },
    b: { type: "rect" },
  });
  assert.deepEqual(out.states.P.points, [[0, "= @B_tm.y"], [10, 20]]);
});

test("the MAGNIFIER origin equation pair reroutes; its self.* twin does not", () => {
  const out = clone({
    mg: { type: "magnifier", origin: { x: "@b_cm.x", y: "self.anchors.center.y" } },
    b: { type: "rect" },
  });
  assert.deepEqual(out.states.MG.origin, { x: "@B_cm.x", y: "self.anchors.center.y" },
    "self is identity-stable: in the clone it already means the clone");
});

// ── clonedItemStates: the ID-VALUED (non-equation) slots ─────────────────────

test("a GROUP's members array rewrites to the cloned members", () => {
  const out = clone({ g: { type: "group", members: ["m", "n"] }, m: { type: "rect" }, n: { type: "circle" } });
  assert.deepEqual(out.states.G.members, ["M", "N"]);
  assert.deepEqual(out.external, []);
});

test("a member left OUT of the set is reported (the double-steering hazard)", () => {
  const out = clonedItemStates({ g: { type: "group", members: ["m"] } }, new Map([["g", "G"]]), registry);
  assert.deepEqual(out.states.G.members, ["m"]);
  assert.deepEqual(out.external, ["m"], "so the app can report it rather than silently steer the original");
});

test("a CROP BOX target rewrites when cloned together, stays when not", () => {
  const together = clone({ cb: { type: "cropbox", target: "r" }, r: { type: "rect" } });
  assert.equal(together.states.CB.target, "R");
  const alone = clonedItemStates({ cb: { type: "cropbox", target: "r" } }, new Map([["cb", "CB"]]), registry);
  assert.equal(alone.states.CB.target, "r", "a second window onto the SAME image is meaningful");
  assert.deepEqual(alone.external, ["r"]);
  // A crop box that targets nothing must not invent one.
  const empty = clonedItemStates({ cb: { type: "cropbox", target: null } }, new Map([["cb", "CB"]]), registry);
  assert.equal(empty.states.CB.target, null);
});

// ── clonedItemStates: what must NOT change ───────────────────────────────────

test("a plain TEXT property holding \"@id\" is left literal", () => {
  const out = clone({ tx: { type: "plaintext", text: "see @b for details", fill: "#000000" } });
  assert.equal(out.states.TX.text, "see @b for details");
  assert.deepEqual(out.external, [], "a text property is not an equation slot, so it holds no references");
});

test("the SOURCE states are never mutated (arrays included)", () => {
  const src = { g: { type: "group", members: ["m"] }, m: { type: "rect", x: "@g.x" } };
  clone(src);
  assert.deepEqual(src.g.members, ["m"], "copiedDeep, not copied(): members must not be shared with the source");
  assert.equal(src.m.x, "@g.x");
});

test("a malformed equation is carried verbatim, never thrown on", () => {
  const out = clone({ a: { type: "rect", x: "@b.x ??? |" }, b: { type: "rect" } });
  assert.equal(out.states.A.x, "@b.x ??? |", "its own error affordance reports it; a clone must not explode");
});

test("clonedItemStates is LOUD about a missing new id", () => {
  assert.throws(() => clonedItemStates({ a: { type: "rect" } }, new Map(), registry), /no new id/);
});

// ── The declaration cannot drift ─────────────────────────────────────────────

test("every optionsFrom:\"items\" row's key is declared in its plugin's itemRefs", () => {
  for (const plugin of allPlugins) {
    const declared = new Set((plugin.itemRefs ?? []).map((path) => path.join(".")));
    for (const row of plugin.inspector ?? [])
      if (row.optionsFrom === "items")
        assert.ok(declared.has(row.key),
          `plugin "${plugin.type}" offers an ITEM PICKER for "${row.key}" but does not list it in itemRefs — a clone of it would silently keep pointing at the original item`);
  }
});

test("itemRefs declarations name REAL state paths (a typo cannot hide)", () => {
  for (const plugin of allPlugins)
    for (const path of plugin.itemRefs ?? []) {
      let cur = plugin.defaults;
      for (const key of path) {
        assert.ok(cur !== null && typeof cur === "object" && key in cur,
          `plugin "${plugin.type}" declares itemRefs path ${JSON.stringify(path)} but its defaults have no such key`);
        cur = cur[key];
      }
    }
});

// ── A whole-document round trip through the real fold ────────────────────────

test("cloning a wired pair into a REAL document leaves the originals wired to each other", () => {
  let doc = newDocument();
  let circleId, arrowId;
  [doc, circleId] = withNewItem(doc, 0, { type: "circle", active: true, x: 100, y: 100, w: 40, h: 40, z: 1 });
  [doc, arrowId] = withNewItem(doc, 0, {
    type: "arrow", active: true, z: 2,
    from: { x: `@${circleId}_cm.x`, y: `@${circleId}_cm.y` }, to: { x: 400, y: 400 },
  });
  const states = { [circleId]: { type: "circle", x: 100, y: 100 }, [arrowId]: { type: "arrow", from: { x: `@${circleId}_cm.x`, y: `@${circleId}_cm.y` } } };
  const idMap = new Map([[circleId, "NEWC"], [arrowId, "NEWA"]]);
  const { states: clones } = clonedItemStates(states, idMap, registry);
  assert.equal(clones.NEWA.from.x, "@NEWC_cm.x", "the clone's arrow follows the CLONED circle");
  assert.equal(doc.slides[0].delta.items[arrowId].from.x, `@${circleId}_cm.x`,
    "the ORIGINAL arrow still follows the ORIGINAL circle (the document was not touched)");
});

console.log(`\n${passed} subgraph-clone tests passed`);
