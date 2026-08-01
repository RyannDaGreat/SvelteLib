/**
 * THE `richtext` ROW KIND — the three facts that must hold together, in bare node.
 *
 * R6-13.3: plugins/text.js stores its content as an ordinary property
 * (items.<id>.text = {runs, paras}) and was the only content-bearing widget with
 * no row for it, which is the whole of the user's "I don't see any property that
 * actually contains this rich text". The row is a plain-text surface over a
 * structured value.
 *
 * WHY A GATE AND NOT JUST THE FEATURE. The kind and its renderer are separable in
 * source and INSEPARABLE in behaviour: `richtext` in ROW_KINDS with no branch in
 * web/Inspector.svelte falls to the catch-all `<input value={state[row.key]}>`,
 * which paints "[object Object]" and whose first keystroke replaces {runs, paras}
 * with a bare string. That state is strictly worse than the row not existing, and
 * nothing else in the suite can see it — the Inspector is a .svelte file no node
 * test can import, so §3 below reads it as TEXT.
 *
 * §4 answers a question the handing agent could not answer from outside the
 * Inspector, and answers it by measurement rather than by reading keyframed():
 * does the ◆ light up over an OBJECT-valued path?
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ROW_KINDS } from "../core/properties.js";
import { JOINT_EDITABLE_KINDS, JOINT_UNEDITABLE_KINDS } from "../core/multiselect.js";
import { richTextToPlain, withPlainTextReplaced } from "../core/richtext.js";
import { hasKeyframe, keyframed } from "../core/document.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RICHTEXT = "richtext";

/**
 * Pure function. Source text with `//` line comments and block comments removed,
 * LINE NUMBERS PRESERVED.
 *
 * Ledger C-14: a comment-blind grep over this codebase fails in both directions,
 * because the codebase explains itself heavily in prose — and the Inspector
 * branch this file greps for is DESCRIBED in a comment two lines above itself, so
 * an unstripped grep would pass on the explanation alone. The blank-out uses a
 * horizontal-whitespace class and never `^\s*`: `\s` matches a newline, so such a
 * stripper eats blank lines and every subsequent line number drifts.
 *
 * @param {string} src Source text.
 * @returns {string} The same text with comment bodies blanked out.
 *
 * @example stripComments('a\n// b\nc')
 * 'a\n\nc'
 * @example // a commented-out branch cannot smuggle in a match
 * stripComments('  // kind === "richtext"').trim()
 * ''
 * @example // ...and the surrounding code keeps its line numbers
 * stripComments('keep\n// gone\nreal').split('\n').length
 * 3
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Query. One web/ or core/ source file, comment-stripped. */
function source(rel) {
  return stripComments(readFileSync(resolve(HERE, "..", rel), "utf8"));
}

let checks = 0;
const ok = (msg) => { checks += 1; console.log(`  ok   ${msg}`); };

// ── §1 THE KIND IS REGISTERED ───────────────────────────────────────────────
assert.ok(ROW_KINDS.includes(RICHTEXT), `"${RICHTEXT}" is missing from ROW_KINDS`);
ok("richtext is a ROW_KIND");

// ── §2 IT IS CLASSIFIED FOR MULTI-SELECTION, AND ON THE UNEDITABLE SIDE ──────
// core/multiselect.js's own import-time gate already refuses an UNCLASSIFIED
// kind, so §2 is not about existence — it is about the SIDE. A future edit moving
// richtext to JOINT_EDITABLE_KINDS would satisfy that gate and silently stamp one
// item's whole run structure onto every other selected item, because the joint
// seam fans ONE already-computed value out to N paths.
assert.ok(!JOINT_EDITABLE_KINDS.includes(RICHTEXT),
  "richtext must NOT be jointly editable: the joint seam fans one computed value to N paths, but a richtext write is a splice against ONE item's own runs");
assert.equal(typeof JOINT_UNEDITABLE_KINDS[RICHTEXT], "string",
  "richtext needs its refusal SENTENCE in JOINT_UNEDITABLE_KINDS — the row is listed and inert, and a disabled control explains itself");
ok("richtext is joint-UNeditable, with a reason");

// ── §3 THE INSPECTOR DISPATCHES IT, AND OFFERS NO ƒ ─────────────────────────
const inspector = source("web/Inspector.svelte");
assert.match(inspector, /\{:else if kind === "richtext"\}/,
  'web/Inspector.svelte has no `{:else if kind === "richtext"}` branch — the kind would fall to the catch-all text input, render "[object Object]" over the runs object, and clobber it on the first keystroke');
ok("web/Inspector.svelte dispatches kind:richtext before the catch-all");

// The ƒ affordance is gated on EQUATION_KINDS, a Set literal in that same file.
// core/expressions.js refuses equations on text values, so an ƒ on this row would
// be a control lying about what it is.
const eqKinds = inspector.match(/const EQUATION_KINDS = new Set\(\[([^\]]*)\]\)/);
assert.ok(eqKinds, "could not find EQUATION_KINDS in web/Inspector.svelte — this gate has gone stale and must be re-pointed, not deleted");
assert.ok(!eqKinds[1].includes(`"${RICHTEXT}"`),
  "richtext must stay OUT of EQUATION_KINDS: core/expressions.js refuses equations on text values, so the ƒ would open an editor whose result is always rejected");
ok("richtext is not equation-capable");

// The branch must come BEFORE the final catch-all, or it is unreachable.
const branchAt = inspector.indexOf('{:else if kind === "richtext"}');
const catchAllAt = inspector.indexOf("value={state[row.key] ?? \"\"}");
assert.ok(catchAllAt > 0, "could not locate the catch-all text input — re-point this gate");
assert.ok(branchAt < catchAllAt,
  "the richtext branch sits AFTER the catch-all input, so it can never be reached");
ok("the richtext branch precedes the catch-all");

// ── §4 THE KEYFRAME DIAMOND LIGHTS UP OVER AN OBJECT-VALUED PATH ────────────
// THE DOUBT, raised by the agent handing this over and worth recording because
// the reasoning behind it is correct: web/app.svelte.js commitPreview() walks a
// preview tree and keyframes its LEAVES, so committing {runs, paras} at
// items.<id>.text writes two leaf paths (text.runs and text.paras) and never
// `text` itself. If the delta were a FLAT path map the ◆ would then read hollow
// over a real keyframe. It is not flat — it is a nested tree, so getPath at
// ["items", id, "text"] finds the object those two leaves live in. Measured here
// rather than argued, because "the diamond is the only place a user can see that
// rich text keyframes" and a wrong answer would have shipped `keyframes: false`.
{
  const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
  const base = { meta: { name: "t", slideW: 100, slideH: 100 }, slides: [
    { id: "s0", name: "S1", transition: tr, delta: { items: { t1: { type: "text", text: { runs: [{ text: "hi" }], paras: [{}] } } } } },
    { id: "s1", name: "S2", transition: tr, delta: {} },
  ] };
  const P = ["items", "t1", "text"];
  assert.equal(hasKeyframe(base, 1, P), false, "slide 1 starts unkeyed — otherwise §4 proves nothing");

  // Exactly what commitPreview does to an object value: descend, keyframe each leaf.
  const edited = withPlainTextReplaced(base.slides[0].delta.items.t1.text, "hi there");
  let doc = base;
  for (const [k, v] of Object.entries(edited)) doc = keyframed(doc, 1, [...P, k], v);

  assert.ok(hasKeyframe(doc, 1, P),
    "the ◆ would read HOLLOW over a real rich-text keyframe: leaf-wise commits at text.runs/text.paras did not make ['items','t1','text'] report keyed");
  assert.equal(richTextToPlain(doc.slides[1].delta.items.t1.text), "hi there");
  ok("a leaf-wise richtext commit keys the OBJECT path — the ◆ reads filled");
}

// ── §5 THE ROW'S WRITE IS A SPLICE, NOT A FLATTEN ───────────────────────────
// The property this row exists to make visible must survive being edited THROUGH
// it. Pinned here (not only in core/richtext.js's own doctests) because it is the
// contract the ROW depends on: if a write flattened the runs, the row would be a
// destructive control wearing a text input's clothes.
{
  const styled = { runs: [{ text: "Big ", size: 48 }, { text: "small", size: 18 }], paras: [{}] };
  const after = withPlainTextReplaced(styled, "Big smaller");
  assert.equal(richTextToPlain(after), "Big smaller");
  assert.deepEqual(after.runs.map((r) => r.size), [48, 18],
    "editing inside the second run must leave the FIRST run's style alone");
  assert.equal(after.runs[1].text, "smaller");
  ok("editing one run through the row preserves every other run's style");

  assert.deepEqual(withPlainTextReplaced(styled, "Big small"), styled,
    "an unchanged string must be an exact no-op — otherwise focusing the row rewrites the document");
  ok("an unchanged value is an exact no-op");
}

console.log(`richtext row: ${checks} checks passed`);
