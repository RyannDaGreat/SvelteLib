/**
 * RETYPING A MULTI-SELECTION — WORKSTREAM BT, pinned against the LIVE roster.
 *
 * ── THE RULING THIS PINS ─────────────────────────────────────────────────────
 * The multi-select Inspector's widget-type row used to render inert with a
 * reason (WORKSTREAM BE's `UNIVERSAL_TYPE_ROW_PROBLEM`). That refusal was a
 * CLAUDE CHOICE, never a user ruling, and the user overruled it looking at the
 * tooltip itself (2026-08-03, verbatim):
 *
 *   "Hey, why won't it let me edit widget type? No, that's a stupid error. Just
 *    do it to everyone individually. When I do widget type coercion... Look,
 *    this is a stupid error. There's no reason why this should be a problem.
 *    Just do it to them all individually, then change what we see in the
 *    properties. It's not that hard."
 *
 * SO THE SEMANTICS ARE: picking a target type over a multi-selection runs
 * `retypedItem` ONCE PER ITEM, each from that item's OWN folded state and OWN
 * current type — N correct coercion plans, not one shared value. The whole batch
 * is ONE undo unit. Ineligible items (the camera and the other structural types)
 * are SKIPPED with the reason surfaced, never silently converted, and never
 * blocking the eligible rest.
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM tests/retype_test.js ────────────────
 * That suite pins the SINGLE-item rules (the exclusion set, round-trip
 * losslessness, kind coercion, menu/command agreement). This one pins what only
 * a BATCH can be wrong about: that the plans stay per-item rather than collapsing
 * to the primary's, that one undo reverses all of them, and that a camera in the
 * set is skipped rather than converted — BF's pin, whose original failure was
 * exactly "the camera SILENTLY BECAME A RECT".
 *
 * NO app.svelte.js HERE, deliberately: this is bare node (core/ must run without
 * a browser), so the batch is exercised as the FOLD that `app.retypeSelection`
 * performs — `retypedItem` applied N times to one document, committed once. The
 * browser half (the real dropdown, the real Cmd+Z) is
 * tests/multiselect_inspector_probe.js.
 */
import assert from "node:assert";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { foldState, repairedDocument } from "../core/document.js";
import { createUndo } from "../core/undo.js";
import { retypePlan, retypeEligible, retypedItem } from "../core/retype.js";
import { retypeSkips, multiSelectPanel } from "../core/multiselect.js";

const registry = createRegistry();
registerPlugins(registry);

const SLIDE_W = 1280;
const SLIDE_H = 720;

/**
 * Query. A one-slide document holding a camera plus one widget per entry of
 * `specs` ([id, type] pairs), each at its plugin's defaults.
 */
function documentWith(specs) {
  const items = {
    cam: { type: "camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 0, rotation: 0, scale: 1, active: true },
  };
  specs.forEach(([id, type], i) => {
    items[id] = { ...registry.get(type).defaults, type, x: 100 * i, y: 100, w: 200, h: 150, z: i + 1, rotation: 0, scale: 1, active: true };
  });
  return repairedDocument(
    {
      meta: { name: "retype-batch", slideW: SLIDE_W, slideH: SLIDE_H },
      slides: [{ id: "s0", name: "S", transition: { type: "cut", seconds: 0, curve: "linear", sound: "" }, delta: { items } }],
    },
    registry,
  ).doc;
}

/**
 * Command. THE BATCH, exactly as web/app.svelte.js `retypeSelection` performs
 * it: skip the ineligible, fold one `retypedItem` per eligible item into ONE
 * document, commit once. Stated here rather than imported because app.svelte.js
 * is a browser module; the SHAPE is what is being pinned, and the probe pins that
 * the app really does this.
 */
function retypeBatch(undo, slideIndex, ids, newType) {
  const folded = foldState(undo.doc, slideIndex).items;
  const eligible = ids.filter((id) => folded[id] && folded[id].type !== newType && retypeEligible(registry.get(folded[id].type)));
  if (eligible.length === 0) return 0;
  let doc = undo.doc;
  for (const id of eligible) doc = retypedItem(doc, slideIndex, id, newType, folded[id], registry);
  undo.commit(doc);
  return eligible.length;
}

// ── 1. THREE MIXED WIDGETS → TEXT, EACH BY ITS OWN PLAN ─────────────────────
// The driving acceptance. A rect, a circle and an arrow are three different
// bags; picking "text" must leave all three as text, and each one's surviving
// keys must be what ITS OWN plan says — not what the primary's plan said.
{
  const doc = documentWith([["a", "rect"], ["b", "circle"], ["c", "arrow"]]);
  const undo = createUndo(doc);
  const before = foldState(doc, 0).items;

  // The per-item plans, computed BEFORE the write from each item's own type.
  // These are the ground truth the batch must reproduce; if the batch collapsed
  // to the primary's plan, `c`'s arrow-specific coercions would go missing.
  const plans = Object.fromEntries(
    ["a", "b", "c"].map((id) => [id, retypePlan(before[id], registry.get(before[id].type), registry.get("text"))]),
  );
  // The three plans really ARE different — otherwise this test would pass even
  // if the code used one shared plan, and would be pinning nothing.
  const planKeys = (id) => plans[id].map((p) => p.path.join(".")).sort().join(",");
  assert.notStrictEqual(planKeys("a"), planKeys("c"), "a rect and an arrow must plan differently, or this suite proves nothing");

  const n = retypeBatch(undo, 0, ["a", "b", "c"], "text");
  assert.strictEqual(n, 3, "all three eligible items were retyped");

  const after = foldState(undo.doc, 0).items;
  for (const id of ["a", "b", "c"]) assert.strictEqual(after[id].type, "text", `${id} is now text`);

  // PER-ITEM SURVIVORS, per BF's measured semantics (rule 2: a key both types
  // declare under an AGREEING kind carries its stored value; rule 1 fills the
  // rest from the new type's defaults). Checked against each item's OWN plan:
  // every path the plan wrote holds the planned value, and every path it did NOT
  // write holds exactly what the item held before.
  for (const id of ["a", "b", "c"]) {
    const written = new Set(plans[id].map((p) => p.path.join(".")));
    for (const { path, value } of plans[id])
      assert.deepStrictEqual(
        path.reduce((o, k) => o?.[k], after[id]), value,
        `${id}.${path.join(".")} must hold its OWN plan's value`,
      );
    // The carried keys: shared scalars the plan left alone must be byte-identical.
    for (const key of ["x", "y", "w", "h", "z", "rotation", "scale", "opacity"])
      if (!written.has(key) && before[id][key] !== undefined)
        assert.deepStrictEqual(after[id][key], before[id][key], `${id}.${key} was not in the plan, so it must have carried unchanged`);
  }

  // RULE 3 — DORMANT KEYS PRESERVED, over a batch too. The circle's radius-era
  // keys and the arrow's endpoint keys are surplus under `text` and must survive,
  // so retyping back is lossless exactly as the single-item round trip is.
  for (const id of ["b", "c"])
    for (const key of Object.keys(before[id]))
      if (key !== "type" && !plans[id].some((p) => p.path.length === 1 && p.path[0] === key))
        assert.ok(key in after[id], `${id}.${key} is dormant, not deleted`);

  // ── ONE Cmd+Z RESTORES ALL THREE ORIGINAL TYPES ───────────────────────────
  // The whole batch is ONE undo unit: `retypedItem` folds N times into one
  // document and exactly one `commit` happens. A per-item commit would need three
  // presses here, which is the failure this asserts against.
  const restored = foldState(undo.undo(), 0).items;
  assert.strictEqual(restored.a.type, "rect");
  assert.strictEqual(restored.b.type, "circle");
  assert.strictEqual(restored.c.type, "arrow");
  assert.strictEqual(undo.canUndo, false, "ONE undo unit — there is nothing left to undo behind it");
  // …and every value the batch overwrote came back with the types.
  for (const id of ["a", "b", "c"]) assert.deepStrictEqual(restored[id], before[id], `${id} is byte-identical to before the batch`);
}

// ── 2. A SELECTION CONTAINING THE CAMERA ────────────────────────────────────
// BF's pin, restated for the batch: the camera keeps its type, the reason is
// available, and the eligible rest converts anyway.
{
  const doc = documentWith([["a", "rect"], ["b", "circle"]]);
  const undo = createUndo(doc);
  const n = retypeBatch(undo, 0, ["a", "cam", "b"], "text");
  assert.strictEqual(n, 2, "the two eligible items converted — the camera did not block them");

  const after = foldState(undo.doc, 0).items;
  assert.strictEqual(after.a.type, "text");
  assert.strictEqual(after.b.type, "text");
  assert.strictEqual(after.cam.type, "camera", "THE CAMERA KEPT ITS TYPE — it must never silently become a rect (WORKSTREAM BF)");

  // THE REASON IS SURFACED, not merely the skip. The panel's own `retypeSkips`
  // is what the Inspector prints above the rows.
  const entries = ["a", "cam", "b"].map((itemId) => ({ itemId, plugin: registry.get(after[itemId].type), state: after[itemId] }));
  const skips = retypeSkips(entries);
  assert.deepStrictEqual(skips.map((s) => s.itemId), ["cam"], "exactly the camera is named");
  assert.ok(skips[0].reason.length > 0 && /mandatory/.test(skips[0].reason), "and it says WHY, in a sentence about the camera");

  // AND THE ROW SHOWS THE HONEST MIXED STATE AFTER THE PARTIAL APPLY: two text
  // items and one camera really do disagree about `type`, so MIXED is the truth,
  // not a bug. The row is still offered and still carries no refusal.
  const panel = multiSelectPanel(entries);
  const typeRow = panel.rows.find((r) => r.row.key === "type");
  assert.ok(typeRow, "the type row is offered even with the camera in the set");
  assert.strictEqual(typeRow.problem, null, "…with no refusal (WORKSTREAM BT)");
  assert.strictEqual(typeRow.mixed, true, "…and MIXED, because the camera genuinely kept its type");
  assert.deepStrictEqual(panel.retypeSkips.map((s) => s.itemId), ["cam"], "the panel carries the skip so the UI can print it");
}

// ── 3. AN ALL-INELIGIBLE SELECTION WRITES NOTHING ───────────────────────────
// Not an error and not a silent success either: zero items converted, zero undo
// entries pushed (committing an empty write would spend an undo unit on nothing
// — the standing rule unifySelection already obeys).
{
  const undo = createUndo(documentWith([]));
  assert.strictEqual(retypeBatch(undo, 0, ["cam"], "text"), 0, "nothing eligible, nothing written");
  assert.strictEqual(undo.canUndo, false, "and no undo entry was spent");
  assert.strictEqual(foldState(undo.doc, 0).items.cam.type, "camera");
}

// ── 4. ALREADY-THAT-TYPE ITEMS ARE NOT REWRITTEN ────────────────────────────
// Minimal delta over a batch: retyping a set where one item is already the
// target must not keyframe that item, or an undo would "restore" a change nobody
// made. (retypePlan would still fill nothing, but the type keyframe itself would
// be written, which is the redundant write this guards.)
{
  const undo = createUndo(documentWith([["a", "rect"], ["b", "text"]]));
  assert.strictEqual(retypeBatch(undo, 0, ["a", "b"], "text"), 1, "only the rect needed converting");
  const after = foldState(undo.doc, 0).items;
  assert.strictEqual(after.a.type, "text");
  assert.strictEqual(after.b.type, "text");
}

console.log("retype_batch_test: OK");
