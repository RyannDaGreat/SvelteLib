/**
 * THE RETYPE SWEEP — every ordered pair of retype-eligible widget types, retyped
 * through the REAL command path (core/retype.retypedItem) and walked all the way
 * to the display list.
 *
 * WHY A WHOLE-ROSTER SWEEP AND NOT A HANDFUL OF CASES: retyping is the one edit
 * that hands a plugin's emit() a bag some OTHER plugin filled. There is no
 * "typical" pair to sample — the interesting ones are exactly the pairs nobody
 * thought about, so the only honest coverage is all of them. The predecessor's
 * measurement over this same space is what produced the fill rule: a BARE type
 * write (no defaults filled) broke ~1499 of the 9120 pairs, because plugin
 * defaults are materialized ONLY at the load boundary (core/document.js
 * withMissingDefaultsFilled) and never at fold/derive/emit time.
 *
 * THE TWO ASSERTIONS, and why each is worth its runtime:
 *
 *   1. NOTHING ESCAPES. Not one pair may throw out of the walk. The per-node
 *      containment in render_gpu/ports.js is supposed to turn a bad emit() into a
 *      RED BOX carrying the reason, and a pair that throws past it is a
 *      CONTAINMENT bug, not a retype bug — this suite is the thing that would
 *      notice.
 *
 *   2. THE THROW SET CANNOT GROW SILENTLY. It is asserted EMPTY, and the empty
 *      set is the documented bound. Stating it as a set comparison rather than a
 *      count means a future failure names the pairs.
 *
 * A red box is an accepted outcome, not a failure: rule 2 deliberately carries a
 * KIND-LEGAL BUT VALUE-HOSTILE value (svg's `fill: {type:"none"}` into mermaid,
 * which rejects it), and the product answer for those is a red box with the
 * reason written on it, one undo away. So the suite REPORTS the red-box count
 * for visibility and asserts only that the walk survived.
 */
import assert from "node:assert";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { foldState, keyframed, repairedDocument, withNormalizedZ } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { sceneIR } from "../render_gpu/ports.js";
import { ERROR_BORDER } from "../core/paint_containment.js";
import { retypeEligible, retypedItem } from "../core/retype.js";

const registry = createRegistry();
registerPlugins(registry);

/** The types the dropdown actually offers — the sweep's space is the MENU's space. */
const types = registry.all().filter(retypeEligible).map((p) => p.type);

const SLIDE_W = 1280;
const SLIDE_H = 720;
const CAMERA = { type: "camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 0, rotation: 0, scale: 1, active: true };

/**
 * Query. A one-slide document holding a camera and ONE freshly-inserted widget
 * of `type` under the id "it" — repaired, so the item carries exactly the bag a
 * real insert would (defaults materialized at the load boundary).
 */
function documentWithWidget(type) {
  const defaults = registry.get(type).defaults;
  return repairedDocument(
    {
      meta: { name: "sweep", slideW: SLIDE_W, slideH: SLIDE_H },
      slides: [
        {
          id: "s0",
          name: "S",
          transition: { type: "cut", seconds: 0, curve: "linear", sound: "" },
          delta: {
            items: {
              cam: { ...CAMERA },
              it: { ...defaults, type, x: 100, y: 100, w: 200, h: 150, z: 1, rotation: 0, scale: 1, active: true },
            },
          },
        },
      ],
    },
    registry,
  ).doc;
}

/**
 * Pure function. Whether an IR op IS the containment's red box.
 *
 * The op's `stroke` is the PARSED PAINT — for the error border that is the RGBA
 * array itself, not an object with a `.color`, and not the same array instance
 * ERROR_BORDER is (ir.rect runs it through parsePaint, which copies). So this
 * compares COMPONENTWISE. Both mistakes matter: `op.stroke?.color ===
 * ERROR_BORDER` is `undefined === [...]`, which is false for every op ever
 * emitted — a sweep written that way reports "zero red boxes" whether or not
 * anything broke, and measures nothing at all.
 *
 * @param {object} op - an IR op
 * @returns {boolean}
 */
function isErrorBox(op) {
  return op.op === "rect" && Array.isArray(op.stroke) && op.stroke.length === ERROR_BORDER.length && op.stroke.every((c, i) => c === ERROR_BORDER[i]);
}

/**
 * Query. Walks a document to its display list and reports whether the item
 * red-boxed. Throws whatever the walk throws — catching here is the caller's
 * job, because "which pairs throw" is the assertion.
 */
function walkToDisplayList(doc) {
  const state = evaluateState(foldState(withNormalizedZ(doc), 0, 1), registry, "").state;
  const ir = sceneIR(deriveRenderTree(state, registry), registry, "sweep");
  return ir.some(isErrorBox);
}

const threw = [];
let clean = 0;
let redBoxed = 0;

for (const from of types) {
  const base = documentWithWidget(from);
  const folded = foldState(base, 0).items.it;
  for (const to of types) {
    if (to === from) continue;
    try {
      if (walkToDisplayList(retypedItem(base, 0, "it", to, folded, registry))) redBoxed++;
      else clean++;
    } catch (e) {
      threw.push(`${from}->${to}: ${String(e.message).slice(0, 120)}`);
    }
  }
}

const total = types.length * (types.length - 1);
console.log(`retype sweep: ${types.length} eligible types, ${total} ordered pairs — clean ${clean}, red-boxed ${redBoxed}, threw ${threw.length}`);

// ASSERTION 1+2 in one comparison: the throw set is EMPTY, and a failure names
// the pairs rather than reporting a count that grew.
assert.deepStrictEqual(
  threw,
  [],
  `retype pairs escaped the emit containment (each is a ports.js containment bug, not a retype bug):\n  ${threw.join("\n  ")}`,
);

// A retype must never produce a document the loader then repairs — that would
// mean the fill rule and the load-boundary fill disagree about what a widget's
// bag is, and the very next save/load would silently rewrite the user's item.
const probe = documentWithWidget(types[0]);
const retyped = retypedItem(probe, 0, "it", types[1], foldState(probe, 0).items.it, registry);
const repair = repairedDocument(JSON.parse(JSON.stringify(retyped)), registry);
assert.deepStrictEqual(
  repair.reports ?? [],
  [],
  "a retyped document must load with ZERO repair reports — the retype fill and the load-boundary fill must agree",
);

// A bare type write with NO fill must still be BROKEN, in at least one pair.
// Without this the suite would keep passing if the fill were deleted and the
// defaults happened to be materialized somewhere else — it pins the REASON this
// module exists, not just its current effect.
const bareBroken = types.some((to) => {
  if (to === types[0]) return false;
  try {
    return walkToDisplayList(keyframed(probe, 0, ["items", "it", "type"], to));
  } catch {
    return true;
  }
});
assert.ok(bareBroken, "a bare type write with no defaults fill must break at least one pair — otherwise the fill rule is untested");

console.log("retype_sweep_test: OK");
