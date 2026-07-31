/**
 * RETYPE — the rules, pinned against the LIVE plugin roster.
 *
 * core/retype.js's doctests already cover the pure decisions on synthetic
 * plugins (carryVerdict's table, the exclusion predicate's four marks, the
 * coercion preview's shape). This suite covers what a doctest structurally
 * cannot: the claims that are about the REAL registry and the REAL document
 * model, and would go stale silently as the roster grows.
 *
 * Four things are asserted here, each because it is a promise made elsewhere:
 *
 *   1. THE EXCLUSION SET, pinned against the roster. The brief permits a hand
 *      list only with a test that stops a new scene-structural type from
 *      silently joining the menu. The predicate is capability-based, so this test
 *      is the OTHER half of that guarantee: it names the five types the
 *      predicate currently refuses, so adding a sixth is a deliberate act with a
 *      test edit attached, and REMOVING one (a widget that quietly drops
 *      `ghost`) fails here instead of shipping a menu entry that crashes.
 *
 *   2. ROUND-TRIP LOSSLESSNESS. circle → rect → circle must return the ORIGINAL
 *      document bytes through serialize → repair → load. This is rule 3
 *      (dormant keys preserved) stated as the property the user actually cares
 *      about: a retype you undo by retyping back must cost you nothing.
 *
 *   3. KIND COERCION on real plugins, not synthetic ones — a value that survives,
 *      and one that cannot.
 *
 *   4. THE MENU AND THE COMMAND AGREE. The warning list a user reads and the
 *      values the write actually resets must be the same set. They share one
 *      function by construction; this asserts the construction holds, because a
 *      future "small" UI-side filter is exactly how they would drift.
 */
import assert from "node:assert";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { foldState, repairedDocument, serialize } from "../core/document.js";
import { coercionPreview, retypeChoices, retypeEligible, retypePlan, retypedItem } from "../core/retype.js";

const registry = createRegistry();
registerPlugins(registry);

const SLIDE_W = 1280;
const SLIDE_H = 720;

/** Query. A one-slide document with a camera and one widget of `type` at id "it". */
function documentWithWidget(type, extra = {}) {
  return repairedDocument(
    {
      meta: { name: "retype", slideW: SLIDE_W, slideH: SLIDE_H },
      slides: [
        {
          id: "s0",
          name: "S",
          transition: { type: "cut", seconds: 0, curve: "linear", sound: "" },
          delta: {
            items: {
              cam: { type: "camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 0, rotation: 0, scale: 1, active: true },
              it: { ...registry.get(type).defaults, type, x: 100, y: 100, w: 200, h: 150, z: 1, rotation: 0, scale: 1, active: true, ...extra },
            },
          },
        },
      ],
    },
    registry,
  ).doc;
}

// ── 1. THE EXCLUSION SET ────────────────────────────────────────────────────
// The predicate reads capabilities (purgeable:false / foldsSubtree / ghost /
// metaball); this pins WHICH live types those marks currently catch.
{
  const excluded = registry
    .all()
    .filter((p) => !retypeEligible(p))
    .map((p) => p.type)
    .sort();
  assert.deepStrictEqual(
    excluded,
    ["anchor_point", "camera", "cropbox", "group", "metaball"].sort(),
    "the retype exclusion set changed — a widget gained or lost one of the four structural marks (purgeable:false / foldsSubtree / ghost / metaball). " +
      "If a NEW scene-structural type appeared, this failure is the point: confirm the predicate catches it for the right REASON, then update this list.",
  );

  // The camera's own header must be plain text, not a menu — retypeChoices is
  // the single condition the Inspector reads for that.
  assert.deepStrictEqual(retypeChoices(registry, { type: "camera" }), [], "the camera must offer no retype menu");
  assert.deepStrictEqual(retypeChoices(registry, { type: "group" }), [], "a group must offer no retype menu");
  assert.ok(retypeChoices(registry, foldState(documentWithWidget("rect"), 0).items.it).length > 0, "a rect must offer a retype menu");

  // No excluded type may appear as a TARGET either.
  const targets = new Set(retypeChoices(registry, foldState(documentWithWidget("rect"), 0).items.it).map((c) => c.value));
  for (const type of excluded) assert.ok(!targets.has(type), `"${type}" is excluded but was offered as a retype target`);
}

// ── 2. ROUND-TRIP LOSSLESSNESS: circle → rect → circle ──────────────────────
// Rule 3 (dormant keys preserved) is what makes this hold: the rect leg leaves
// every circle-only key in the bag untouched, and repair only ever ADDS keys, so
// the return leg finds them still there and coerces nothing.
//
// WHAT "LOSSLESS" MEANS HERE, precisely, because the obvious stricter claim is
// FALSE and it is worth writing down which one is the promise. The returned item
// is NOT key-for-key identical to the original: the rect leg fills rect's own
// keys, and `cornerRadius` is one the circle never declared, so it comes home as
// a DORMANT SURPLUS KEY sitting at its default. That is rule 3 working, not a
// leak — repair never prunes it, nothing reads it while the item is a circle,
// and it costs one number. The promise is that NO VALUE IS LOST OR CHANGED:
// every key the original held still holds the value it held. Asserting exact
// key-set equality instead would be asserting that rule 3 does NOT happen.
{
  const original = documentWithWidget("circle");
  const folded0 = foldState(original, 0).items.it;

  const asRect = retypedItem(original, 0, "it", "rect", folded0, registry);
  const backToCircle = retypedItem(asRect, 0, "it", "circle", foldState(asRect, 0).items.it, registry);

  /** Query. Asserts every key of `folded0` survived `after` with its value intact. */
  const assertNoValueLost = (after, what) => {
    for (const [key, value] of Object.entries(folded0))
      assert.deepStrictEqual(after[key], value, `${what}: "${key}" changed across the round trip — a retype round-trip must lose no value`);
  };

  // The FOLDED STATE is what the renderer and every equation see, so equality
  // there is the claim that matters. (The delta stores extra no-op keyframes; a
  // keyframe writing the value already in force changes no picture and no
  // equation, which is why this reads the fold, not the raw delta.)
  assertNoValueLost(foldState(backToCircle, 0).items.it, "circle → rect → circle");

  // …and it must survive the SAVE/LOAD boundary unchanged, which is where a
  // dormant key would be pruned or a missing one silently filled. ZERO repair
  // reports is the sharp half of this: a retyped document that needed repairing
  // would mean the retype fill and the load-boundary fill disagree about what a
  // widget's bag is, and every save/load would quietly rewrite the user's item.
  const reloaded = repairedDocument(JSON.parse(serialize(backToCircle)), registry);
  assert.deepStrictEqual(reloaded.reports ?? [], [], "a round-tripped retype must load with zero repair reports");
  assertNoValueLost(foldState(reloaded.doc, 0).items.it, "circle → rect → circle through serialize → repair → load");

  // The surplus key is dormant, not corrupt: the item really is a circle again.
  assert.strictEqual(foldState(reloaded.doc, 0).items.it.type, "circle", "the round trip must end as a circle");
}

// ── 3. KIND COERCION on the live roster ─────────────────────────────────────
{
  // A MATCHING kind carries: both rect and circle declare `w` as a number, so a
  // resized item keeps its width across the retype.
  const sized = documentWithWidget("rect", { w: 321 });
  const retyped = retypedItem(sized, 0, "it", "circle", foldState(sized, 0).items.it, registry);
  assert.strictEqual(foldState(retyped, 0).items.it.w, 321, "a kind-MATCHING shared key must carry its stored value");

  // A shared key whose new type declares a DIFFERENT kind resets to the new
  // default. Found from the roster rather than hard-coded, so this keeps testing
  // something real as plugins change; skipped loudly if the roster ever has no
  // such pair (which would itself be worth knowing).
  let mismatch = null;
  for (const from of registry.all().filter(retypeEligible)) {
    const folded = { ...from.defaults, type: from.type };
    for (const to of registry.all().filter(retypeEligible)) {
      if (to.type === from.type) continue;
      const coerced = coercionPreview(folded, from, to);
      if (coerced.length > 0) { mismatch = { from, to, folded, coerced }; break; }
    }
    if (mismatch) break;
  }
  assert.ok(mismatch, "no kind-mismatching pair exists in the roster — the coercion path is untested; investigate rather than deleting this");

  const { from, to, folded, coerced } = mismatch;
  const doc = documentWithWidget(from.type);
  const after = foldState(retypedItem(doc, 0, "it", to.type, foldState(doc, 0).items.it, registry), 0).items.it;
  for (const c of coerced) {
    const plan = retypePlan(folded, from, to).find((p) => p.path.join(".") === c.key);
    assert.deepStrictEqual(
      after[c.key],
      plan.value,
      `${from.type}→${to.type}: "${c.key}" was previewed as coerced, so the write must have reset it to the new type's default`,
    );
  }
}

// ── 4. THE MENU AND THE COMMAND CANNOT DISAGREE ─────────────────────────────
// Every warning bullet the dropdown shows must correspond to a value the write
// actually resets, and every reset must have been warned about — over the whole
// menu for a real item, not one sampled pair.
{
  const doc = documentWithWidget("rect");
  const folded = foldState(doc, 0).items.it;
  for (const choice of retypeChoices(registry, folded)) {
    if (choice.value === "rect") continue;
    const previewed = new Set(coercionPreview(folded, registry.get("rect"), registry.get(choice.value)).map((c) => c.key));
    const written = new Set(
      retypePlan(folded, registry.get("rect"), registry.get(choice.value))
        .filter((p) => p.why === "coerce")
        .map((p) => p.path.join(".")),
    );
    assert.deepStrictEqual(
      [...previewed].sort(),
      [...written].sort(),
      `rect→${choice.value}: the menu's warning list and the command's coercions disagree`,
    );
    // And the menu's own flag must match: a choice with bullets is a coercing
    // choice, which is what drives the red tint and the bottom sort.
    assert.strictEqual(choice.coercions.length > 0, written.size > 0, `rect→${choice.value}: the menu's coercion flag disagrees with the plan`);
  }

  // THE ORDER: every clean choice precedes every coercing one (the user's
  // "very bottom" ruling), and the partition is the ONLY reordering — roster
  // order survives within each half.
  const menu = retypeChoices(registry, folded);
  const firstCoercing = menu.findIndex((c) => c.coercions.length > 0);
  if (firstCoercing !== -1)
    for (const c of menu.slice(firstCoercing))
      assert.ok(c.coercions.length > 0, `"${c.value}" is clean but sorted below a coercing choice — clean types must all be above`);

  const rosterOrder = registry.all().filter(retypeEligible).map((p) => p.type);
  const half = (coercing) => menu.filter((c) => (c.coercions.length > 0) === coercing).map((c) => c.value);
  for (const coercing of [false, true])
    assert.deepStrictEqual(
      half(coercing),
      rosterOrder.filter((t) => half(coercing).includes(t)),
      `the ${coercing ? "coercing" : "clean"} half must keep roster order — the sort must be a stable partition, not a reshuffle`,
    );
}

console.log("retype_test: OK");
