/**
 * THE TEXT CONTENT IS AN ORDINARY PROPERTY, AND THE PANEL MUST SAY SO.
 *
 * R6-13.3, the user's question verbatim: "there's the rule that all things that I
 * edit should be contained inside the properties. And yet I don't see any property
 * that actually contains this rich text… what the fuck is happening." The answer
 * measured in wave 1 is reassuring — `items.<id>.text = {runs, paras}` is an
 * ordinary property, folded, keyframed, tweened and undone by exactly the generic
 * machinery — so the defect was never the STORAGE. It was that the widget shipped
 * NO surface for it: no content row, and no way into the editor except knowing to
 * double-click the canvas. Every other content-bearing widget ships BOTH halves of
 * the same pair (mermaid `definition`, latex `latex`, codeblock `code`, graph_line
 * `source`, graph_bars `valueEquation`), and plaintext ships the content row for
 * its plain string — which is why the PLAIN widget showed its content in the panel
 * while the RICH one showed nothing.
 *
 * WHAT THIS SUITE LOCKS, in two parts:
 *
 *   1. THE SPLICE, which is what makes a plain-string surface over a structured
 *      value legitimate at all. plugins/text.js refused a content row for good
 *      reason — "a plain text input can't represent runs and would clobber them" —
 *      and that is true of the naive write `{runs: [{text: typed}]}`, which throws
 *      a whole document's typography away because one letter was retyped.
 *      core/richtext.withPlainTextReplaced writes only the span that actually
 *      changed, through the SAME deleteRange/insertText the canvas editor uses. The
 *      three properties below are the lead's stated condition for the row to exist:
 *      unchanged text is a no-op, an edit preserves run structure it does not
 *      destroy, and what it CANNOT preserve is a deterministic documented rule
 *      rather than an accident.
 *
 *   2. THE SURFACE. The content row + action row pair as this WIDGET declares it,
 *      and the command behind the action, gated on the widget's own `activate`
 *      DECLARATION rather than on the type name.
 *
 * WHERE THE LINE BETWEEN THIS SUITE AND tests/richtext_row_test.js FALLS, so the two
 * are not one fact asserted twice: that one owns the KIND — its registration in
 * ROW_KINDS, its joint-uneditable classification, the Inspector's dispatch branch,
 * its absence from EQUATION_KINDS, and that a `text`-path keyframe reads back. This
 * one owns the MODEL and the widget's DECLARATION. Neither asserts the other's
 * subject, so a failure names the file that would have to change.
 *
 * Bare node, no framework (suite conventions).
 * Run: node src/demo_apps/PowerRP/tests/text_content_row_test.js
 */

import assert from "node:assert/strict";
import {
  withPlainTextReplaced, richTextToPlain, unresolvedRichText, normalizeRichText,
} from "../core/richtext.js";
import { textPlugin } from "../plugins/text.js";

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }

// The measured mixed fixture R6-13.1 was diagnosed on, reused so the two suites
// speak about the same document: one run at 48, one at 18.
const BIG = 48, SMALL = 18;
const MIXED = { runs: [{ text: "Big ", size: BIG }, { text: "small", size: SMALL }], paras: [{}] };
// The user's REAL stored shape, copied from `projects/Untitled cheese` slide 3 item
// 14ko31ovsn (W1-H-measurements.json) — every one of the ten run keys materialized.
// The row has to be safe on THIS, not only on a tidy fixture.
const REAL = {
  runs: [{
    text: "Here's the equation:", bold: false, italic: false, underline: false, strike: false,
    size: 76, font: "futura", color: "#000000", outlineColor: "#000000", outlineWidth: 0, highlight: "",
  }],
  paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }],
};

// ── 1. THE SPLICE ─────────────────────────────────────────────────────────────

test("UNCHANGED TEXT IS A NO-OP — opening the row and leaving it rewrites nothing", () => {
  // The cheapest bug to ship and the most annoying to find. Stated against the
  // value the CANVAS EDITOR itself stages (unresolvedRichText), because that is the
  // canonical storable form and a splice may not invent a different one.
  for (const v of [MIXED, REAL]) {
    assert.deepEqual(withPlainTextReplaced(v, richTextToPlain(v)), unresolvedRichText(v));
  }
  // And on the real shape that means DEEP-EQUAL TO THE INPUT: it is already
  // canonical, so nothing about the document moves — not one stamped key.
  assert.deepEqual(withPlainTextReplaced(REAL, richTextToPlain(REAL)), REAL);
});

test("AN EDIT INSIDE A RUN KEEPS EVERY OTHER RUN'S STYLE — the whole point", () => {
  // Retyping the tail of the SECOND run. If this flattened, it would be R6-13.1's
  // defect reappearing on the content axis instead of the size axis.
  const later = withPlainTextReplaced(MIXED, "Big smaller");
  assert.deepEqual(later.runs, [{ text: "Big ", size: BIG }, { text: "smaller", size: SMALL }]);
  // …and inside the FIRST run, which exercises the common-SUFFIX half of the
  // splice rather than the common-prefix half.
  const earlier = withPlainTextReplaced(MIXED, "Bigger small");
  assert.deepEqual(earlier.runs, [{ text: "Bigger ", size: BIG }, { text: "small", size: SMALL }]);
  // A pure insertion at the very front touches neither boundary.
  const prefixed = withPlainTextReplaced(MIXED, "The Big small");
  assert.deepEqual(prefixed.runs, [{ text: "The Big ", size: BIG }, { text: "small", size: SMALL }]);
  // A pure deletion inside the second run likewise.
  const shortened = withPlainTextReplaced(MIXED, "Big sml");
  assert.deepEqual(shortened.runs, [{ text: "Big ", size: BIG }, { text: "sml", size: SMALL }]);
});

test("THE NAIVE WRITE IT REPLACES REALLY DOES CLOBBER — the two are not interchangeable", () => {
  // The reason plugins/text.js refused a content row, stated as an assertion rather
  // than as prose: the obvious implementation of a plain-text row destroys the run
  // structure on EVERY edit, which is why this splice had to exist first.
  const naive = { runs: [{ text: "Big smaller" }], paras: [{}] };
  const spliced = withPlainTextReplaced(MIXED, "Big smaller");
  assert.equal(naive.runs.length, 1, "the naive write is one bare run");
  assert.equal(spliced.runs.length, 2, "…and the splice is not");
  assert.notDeepEqual(spliced.runs, naive.runs);
});

test("WHAT IT CANNOT PRESERVE IS A RULE, NOT AN ACCIDENT", () => {
  // Replace a run's text ENTIRELY and no character of it survives to carry its
  // style, so the replacement takes the splice point's neighbour. Deterministic,
  // documented at the function, and identical to selecting that word in the canvas
  // editor and retyping it — which is the standard the row is held to.
  const wiped = withPlainTextReplaced(MIXED, "Big SMALL");
  assert.deepEqual(wiped.runs, [{ text: "Big SMALL", size: BIG }]);
  // The rule is about the SPAN, not about the number of runs: leave one character
  // of the second run standing and its style survives.
  const kept = withPlainTextReplaced(MIXED, "Big sMALL");
  assert.deepEqual(kept.runs, [{ text: "Big ", size: BIG }, { text: "sMALL", size: SMALL }]);
});

test("paragraphs, emptying and junk all behave — the row cannot be handed a value it refuses", () => {
  assert.equal(withPlainTextReplaced({ runs: [{ text: "ab" }], paras: [{}] }, "a\nb").paras.length, 2);
  assert.equal(withPlainTextReplaced({ runs: [{ text: "a\nb" }], paras: [{}, {}] }, "ab").paras.length, 1);
  // Clearing the row empties the box (which makes it a ghost) rather than failing.
  assert.equal(richTextToPlain(withPlainTextReplaced(MIXED, "")), "");
  // A LEGACY plain string and outright junk both absorb, via unresolvedRichText.
  assert.equal(richTextToPlain(withPlainTextReplaced("old text", "old TEXT")), "old TEXT");
  assert.equal(richTextToPlain(withPlainTextReplaced(null, "hello")), "hello");
  // Offsets are CODE POINTS, matching insertText/deleteRange — an astral character
  // ahead of the edit must not shift the splice by one UTF-16 unit.
  assert.equal(richTextToPlain(withPlainTextReplaced({ runs: [{ text: "a\u{1F600}b" }], paras: [{}] }, "a\u{1F600}c")), "a\u{1F600}c");
});

test("THE PROJECTION ROUND-TRIPS: whatever is typed is what the row then shows", () => {
  // The row's contract in one line — richTextToPlain(write(v, s)) === s for every s
  // — which is what lets the control read `state` fresh on each keystroke.
  for (const s of ["", "x", "Big small", "Big smaller", "a\nb\nc", "\u{1F600}\u{1F600}"]) {
    assert.equal(richTextToPlain(withPlainTextReplaced(MIXED, s)), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test("a splice WRITES BACK an unresolved value — it may not re-shadow the box rows", () => {
  // The trap TextEditController's header records: writing a RESOLVED value
  // materializes all ten run keys and kills the eight box-level typography rows
  // e3caa3a freed. A bare run must come back bare.
  const bare = { runs: [{ text: "Hello world" }], paras: [{}] };
  const edited = withPlainTextReplaced(bare, "Hello there");
  assert.deepEqual(Object.keys(edited.runs[0]), ["text"], "the edited run must carry NO style it did not have");
  // …and what is DRAWN is unchanged by that choice (the normalizeRichText identity).
  const inherited = { size: 36, font: "system", color: "#000000", bold: false };
  assert.deepEqual(
    normalizeRichText(edited, inherited).runs[0],
    normalizeRichText({ runs: [{ text: "Hello there" }], paras: [{}] }, inherited).runs[0]
  );
});

test("it never mutates its input", () => {
  const before = JSON.stringify(MIXED);
  withPlainTextReplaced(MIXED, "something else entirely");
  assert.equal(JSON.stringify(MIXED), before);
});

// ── 2. THE SURFACE ────────────────────────────────────────────────────────────

const rowsByKey = new Map(textPlugin.inspector.map((r) => [r.key, r]));
const commandsById = new Map(textPlugin.commands.map((c) => [c.id, c]));
const rowIndex = (key) => textPlugin.inspector.findIndex((r) => r.key === key);

test("THE CONTENT HAS A ROW, and it is the property the canvas editor writes", () => {
  // The whole of R6-13.3: the user could not see the property because nothing
  // rendered it. `key` must be the REAL stored key — a mirror property would be the
  // hand-maintained-mirror defect, and the row would then not be the thing the
  // editor writes.
  const row = rowsByKey.get("text");
  assert.ok(row, "the rich-text content must appear in the panel as its own property");
  assert.equal(row.key, "text", "the row writes items.<id>.text, not a mirror of it");
  assert.equal(row.kind, "richtext", "an object-valued property needs the structured kind, not the plain `text` one");
  assert.equal(row.category, "text");
  assert.ok(row.help && row.help.length > 40, "the row explains that editing here splices rather than clobbers");
});

test("the content row KEYFRAMES — that is the only place a user can see that rich text animates", () => {
  // W5-G measured that the ◆ reads correctly on the ["items", id, "text"] path (the
  // delta is a nested tree, so getPath finds the object the two leaves live in), and
  // W1-H measured that rich text really does interpolate per run, per key. So the
  // diamond is not decoration: it is the surfacing of a capability that has existed
  // and been invisible. `keyframes: false` here would hide it again.
  assert.notEqual(rowsByKey.get("text").keyframes, false);
  // …and it is never hidden. visibleWhen exists for a row a run can SHADOW; the
  // content row is the run's own text and has no lower-precedence layer to lose to.
  assert.equal(rowsByKey.get("text").visibleWhen, undefined);
});

test("CONTENT ROW THEN ACTION ROW — the pair, in the order every other widget uses", () => {
  // mermaid/latex/codeblock all put the value first and "…in code editor" beneath
  // it, so the panel reads "here is the content; here is the fuller way to edit it".
  assert.ok(rowIndex("text") >= 0 && rowIndex("__edittext") > rowIndex("text"),
    "the action row is the pair's SECOND half — a button above the value it edits inverts the reading order");
});

test("the panel offers a way into the editor, as an ACTION row on a real command", () => {
  const row = rowsByKey.get("__edittext");
  assert.ok(row, "the text widget must offer its editor from the panel, not only from a double-click");
  assert.equal(row.kind, "action");
  assert.equal(row.category, "text");
  assert.ok(commandsById.has(row.command), `the row names command "${row.command}", which the plugin must declare`);
  // The `action` row branch renders `row.help ?? entry.help` as the tip and BANS a
  // label echo, so the row must carry a sentence about what the click does.
  assert.ok(row.help && row.help.length > 40, "an action row explains what the click does");
});

test("the command's GATE reads the widget's declaration, never its type name", () => {
  const cmd = commandsById.get("edit-text-content");
  assert.ok(cmd.when, "an ungated command would be offered against an empty selection and answer with an exception");
  assert.ok(cmd.requires, "a gated command must be able to say WHY it is unavailable");
  // widget_handlers.js: "resolution is the declaration and NOTHING else". A gate on
  // plugin.type is the canvas if-chain the activation registry replaced.
  const askedPlugins = [];
  const fakeApp = { selectedNode: () => ({ plugin: askedPlugins.at(-1) }) };
  const gate = (plugin) => { askedPlugins.push(plugin); return cmd.when(fakeApp); };
  assert.equal(gate({ type: "text", activate: "rich_text_edit" }), true);
  assert.equal(gate({ type: "plaintext", activate: "inline_text_edit" }), false, "the plain-string editor is a different editor");
  assert.equal(gate({ type: "rect" }), false);
  // A hypothetical second rich-text widget is offered it with NO edit to the gate.
  assert.equal(gate({ type: "callout", activate: "rich_text_edit" }), true);
  assert.equal(gate(undefined), false, "an empty selection is not a crash");
});

test("the command RUNS the one entry point, and the widget still declares the double-click", () => {
  const cmd = commandsById.get("edit-text-content");
  const calls = [];
  cmd.run({ selection: "item7", beginTextEdit: (id) => calls.push(id) });
  assert.deepEqual(calls, ["item7"], "the command must reach app.beginTextEdit, not a second mechanism");
  // The command is a SECOND surfacing of one action, exactly as edit-code-source is
  // — it does not replace the activation, so double-click must still be declared.
  assert.equal(textPlugin.activate, "rich_text_edit");
});

console.log(`\n${passed} text content-row tests passed`);
