/**
 * WHOLISTIC SCALING + THE MODAL TOGGLES (workstream SCALE_, backburner AA/AB/AC).
 *
 * WHAT IS WORTH PINNING HERE, and it is not "the arithmetic multiplies". Three of
 * these tests catch a defect that is SILENT by construction — a property that fails
 * to scale looks like a slightly wrong picture and raises nothing:
 *   - the DOTTED-KEY read (`shadow.blur` is stored NESTED). The flat read this
 *     replaced returned undefined for ELEVEN of the shared table's fifteen lengths,
 *     emitted no pair, and every flat-key test still passed.
 *   - the IDENTITY writing NOTHING. A factor-1 gesture that emitted pairs would
 *     stamp literals over stored equations — the hazard core/deltas.diffState exists
 *     for, one seam over.
 *   - EQUATION PASS-THROUGH. Multiplying an equation string yields NaN, which paints
 *     nothing; the binding must survive the gesture.
 * The toggle-gating tests pin the OTHER half of the house rule: a key that cannot be
 * announced must also not act, asked of the ONE predicate both halves consult.
 *
 * Bare node, DOM-free: imports core/scaling.js and web/canvas/dragKinds.js only —
 * NOT plugins/index.js, so this suite is independent of the roster.
 */

import { SCALING_BEHAVIORS, SHARED_SCALING, rowScaling, scaledValue, scalingCoverage, wholisticPairs } from "../core/scaling.js";
import { MODAL_TOGGLES, MODAL_TOGGLE_IDS, MODAL_TRANSFORM_KINDS, modalToggleApplies, memberPivot, wholisticMemberPairs } from "../web/canvas/dragKinds.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}\n  got:  ${a}\n  want: ${b}`);
};
const ok = (name, cond) => eq(name, !!cond, true);
const throws = (name, fn) => {
  try { fn(); fail++; console.error(`FAIL ${name} — expected a throw, got none`); }
  catch { pass++; }
};

// ── core/scaling.js: the lookup ────────────────────────────────────────────────
eq("row's own scaling wins over the shared table", rowScaling({ key: "opacity", kind: "number", scaling: "linear" }, {}), "linear");
eq("plugin table answers a row it did not hand-write", rowScaling({ key: "taper", kind: "number" }, { scaling: { taper: "linear" } }), "linear");
eq("row beats plugin table (specificity)", rowScaling({ key: "taper", kind: "number", scaling: "none" }, { scaling: { taper: "linear" } }), "none");
eq("shared table covers the many-plugin keys", rowScaling({ key: "strokeWidth", kind: "number" }, {}), "linear");
eq("an ANGLE row is dimensionless with nothing declared", rowScaling({ key: "fanAngle", kind: "angle" }, {}), "none");
eq("an UNDECLARED number is left alone (today's behaviour)", rowScaling({ key: "wobbleFreq", kind: "number" }, {}), "none");

// THE GESTURE'S OWN COORDINATES MUST NOT BE IN THE SHARED TABLE. If they were, the
// wholistic pass would write w/h a second time and the factor would be applied
// TWICE — a doubling that looks like a scaling bug anywhere but here.
for (const k of ["x", "y", "w", "h", "cx", "cy"])
  eq(`shared table omits the gesture's own coordinate ${k}`, SHARED_SCALING[k], undefined);

// ── core/scaling.js: the arithmetic ───────────────────────────────────────────
eq("linear multiplies", scaledValue(4, "linear", 2.5), 10);
eq("none is untouched", scaledValue(0.8, "none", 2.5), 0.8);
eq("EQUATION passes through (multiplying it would yield NaN)", scaledValue("= title.w / 4", "linear", 2), "= title.w / 4");
eq("an absent property gains nothing", scaledValue(undefined, "linear", 2), undefined);
eq("the identity is EXACT", scaledValue(7, "linear", 1), 7);
throws("a misspelled behaviour THROWS rather than reading as none", () => scaledValue(4, "linnear", 2));
ok("SCALING_BEHAVIORS is the enumeration", SCALING_BEHAVIORS.includes("linear") && SCALING_BEHAVIORS.includes("none"));

// ── core/scaling.js: the write set ────────────────────────────────────────────
const strokedRect = { inspector: [
  { key: "strokeWidth", kind: "number" }, { key: "cornerRadius", kind: "number" }, { key: "opacity", kind: "number" },
] };
eq("a stroked rect x2 grows stroke + corners and leaves opacity alone",
  wholisticPairs({ strokeWidth: 3, cornerRadius: 8, opacity: 0.5 }, strokedRect, 2),
  [["strokeWidth", 6], ["cornerRadius", 16]]);
eq("the IDENTITY writes nothing (no stored equation is disturbed)",
  wholisticPairs({ strokeWidth: 3, cornerRadius: 8 }, strokedRect, 1), []);
eq("a widget declaring nothing scalable is unchanged",
  wholisticPairs({ wobbleFreq: 4 }, { inspector: [{ key: "wobbleFreq", kind: "number" }] }, 2), []);

// THE DOTTED-KEY READ. `shadow.blur` is stored NESTED; a flat state[key] read returns
// undefined, emits no pair, and silently disables most of the shared table.
eq("a DOTTED key reads the NESTED value",
  wholisticPairs({ shadow: { blur: 4, dx: 2, opacity: 0.5 } },
    { inspector: [{ key: "shadow.blur", kind: "number" }, { key: "shadow.dx", kind: "number" }, { key: "shadow.opacity", kind: "number" }] }, 2),
  [["shadow.blur", 8], ["shadow.dx", 4]]);
eq("an absent nested branch is undefined, not a throw",
  wholisticPairs({}, { inspector: [{ key: "shadow.blur", kind: "number" }] }, 2), []);

// THE TEXT WIDGET SPELLS ITS FONT SIZE `size`, NOT `fontSize` (plugins/text.js) —
// the user's headline example, and the reason the table carries both spellings.
eq("text's `size` scales", wholisticPairs({ size: 48 }, { inspector: [{ key: "size", kind: "number" }] }, 1.5), [["size", 72]]);
eq("latex/codeblock's `fontSize` scales", wholisticPairs({ fontSize: 20 }, { inspector: [{ key: "fontSize", kind: "number" }] }, 2), [["fontSize", 40]]);
eq("an EQUATION-valued length keeps its binding through the gesture",
  wholisticPairs({ strokeWidth: "= base.strokeWidth" }, { inspector: [{ key: "strokeWidth", kind: "number" }] }, 2), []);

// ── coverage: the long tail is COUNTABLE, not invisible ───────────────────────
eq("a fully-declared widget has no gaps",
  scalingCoverage({ inspector: [{ key: "strokeWidth", kind: "number" }, { key: "opacity", kind: "number" }] }),
  { answered: ["strokeWidth", "opacity"], unanswered: [] });
eq("an unclassified widget-local length shows up as a gap",
  scalingCoverage({ inspector: [{ key: "tipLength", kind: "number" }] }), { answered: [], unanswered: ["tipLength"] });
eq("declaring it closes the gap",
  scalingCoverage({ inspector: [{ key: "tipLength", kind: "number", scaling: "linear" }] }), { answered: ["tipLength"], unanswered: [] });
eq("non-number rows are not counted (they were never a question)",
  scalingCoverage({ inspector: [{ key: "fill", kind: "color" }, { key: "spin", kind: "angle" }] }), { answered: [], unanswered: [] });

// ── the modal toggles: declaration + gating ───────────────────────────────────
eq("both toggles are declared", MODAL_TOGGLE_IDS, ["individual", "wholistic"]);
eq("individual is I", MODAL_TOGGLES.individual.key, "I");
eq("wholistic is W", MODAL_TOGGLES.wholistic.key, "W");
// EVERY TOGGLE'S `kinds` MUST NAME REAL MODAL KINDS. A typo'd kind would gate the
// chip off forever — a declared key that can never appear and never act.
for (const [id, t] of Object.entries(MODAL_TOGGLES))
  for (const kind of t.kinds)
    ok(`toggle ${id} names the real modal kind ${kind}`, kind in MODAL_TRANSFORM_KINDS);

// USER RULING: "in s and r, the 'i' key ... and 'w' hsould toggle 'wholistic'".
eq("I applies to scale (multi)", modalToggleApplies("individual", "scale", true), true);
eq("I applies to rotate (multi)", modalToggleApplies("individual", "rotate", true), true);
eq("I is withheld on a SINGLE selection (own centre IS the collective centre)", modalToggleApplies("individual", "scale", false), false);
eq("I is withheld from a grab (a translation has no pivot)", modalToggleApplies("individual", "grab", true), false);
eq("W applies to scale, single selection included", modalToggleApplies("wholistic", "scale", false), true);
eq("W is withheld from a rotate (a turn has no factor)", modalToggleApplies("wholistic", "rotate", true), false);
eq("W is withheld from a grab", modalToggleApplies("wholistic", "grab", true), false);
throws("an unknown toggle id THROWS", () => modalToggleApplies("nope", "scale", true));

// ── individual origins: the pivot substitution IS the whole feature ───────────
const boxMember = { startWorld: { x: 0, y: 0, rotation: 0, scale: 1 }, startW: 100, startH: 50 };
eq("toggle OFF: the collective centre stands", memberPivot(boxMember, { x: 500, y: 500 }, false), { x: 500, y: 500 });
eq("toggle ON: the member's own WORLD centre", memberPivot(boxMember, { x: 500, y: 500 }, true), { x: 50, y: 25 });
eq("a member with no box falls back to the collective pivot (stated limit)",
  memberPivot({ plugin: { moveBy: () => [] } }, { x: 500, y: 500 }, true), { x: 500, y: 500 });
// A ROTATED / SCALED member's own centre is its FOLDED world centre, not its stored
// x/y — using the stored pair would put the pivot off the item entirely.
const scaledMember = { startWorld: { x: 10, y: 10, rotation: 0, scale: 2 }, startW: 100, startH: 50 };
eq("the own-centre honours the member's world SCALE", memberPivot(scaledMember, { x: 0, y: 0 }, true), { x: 110, y: 60 });

// ── the member adapter: item-scoped pairs, additive to geometry ───────────────
eq("wholistic pairs are scoped into the item",
  wholisticMemberPairs({ itemId: "r", plugin: strokedRect, rawItem: { strokeWidth: 3, opacity: 0.5 } }, 2),
  [[["items", "r", "strokeWidth"], 6]]);
eq("a dotted key becomes a nested PATH",
  wholisticMemberPairs({ itemId: "r", plugin: { inspector: [{ key: "shadow.blur", kind: "number" }] }, rawItem: { shadow: { blur: 4 } } }, 2),
  [[["items", "r", "shadow", "blur"], 8]]);
eq("the identity writes nothing through the adapter too",
  wholisticMemberPairs({ itemId: "r", plugin: strokedRect, rawItem: { strokeWidth: 3 } }, 1), []);
// NO GEOMETRY KEY MAY EVER COME OUT OF THE WHOLISTIC PASS — that is what keeps the
// factor from being applied twice. Asked of a plugin that declares x/y/w/h rows.
const geomPlugin = { inspector: [{ key: "x", kind: "number" }, { key: "y", kind: "number" }, { key: "w", kind: "number" }, { key: "h", kind: "number" }] };
eq("geometry rows produce NO wholistic pairs (no double-apply)",
  wholisticMemberPairs({ itemId: "r", plugin: geomPlugin, rawItem: { x: 1, y: 2, w: 100, h: 50 } }, 2), []);

console.log(`\nscale_wholistic_test: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
