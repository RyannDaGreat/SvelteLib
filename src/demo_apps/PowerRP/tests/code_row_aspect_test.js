/**
 * THE `code` ROW ASPECT guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/code_row_aspect_test.js
 *
 * WHY THIS EXISTS. The user asked for ONE universal affordance for every
 * code-valued property (2026-08-02: "we need to have a way and properties for
 * anything that is code… you just have a bracket thing, like a double bracket at
 * the end of it, which would let you edit in the code editor"), replacing the
 * five full-width "Edit in code editor…" button rows that had been copied into
 * graph_line, graph_bars, mermaid, codeblock and latex. (f1af0e3 migrated the
 * first four; latex was missed there and followed, which is precisely the kind
 * of straggler assertion (3) below is for — it is app-wide, not table-driven, so
 * it fails on ANY plugin that keeps both shapes.) That replacement has a failure
 * mode with no visible symptom at the author's desk: DELETE the button row,
 * FORGET the `code` aspect, and the property is still perfectly editable inline
 * — the widget just quietly loses its only route to the full-screen editor, and
 * nothing errors. This file is the reverse direction of that migration.
 *
 * WHAT IT PROVES:
 *   (1) codeRowLanguage resolves BOTH declared forms (a literal string, and a
 *       function of the widget's state — codeblock's, which follows its own
 *       `language` property);
 *   (2) each of the five migrated plugins declares exactly one `code` row, on
 *       the property its `codeEditor` descriptor already names, in an agreeing
 *       language — so the row button and the double-click open the same editor
 *       on the same source;
 *   (3) NO plugin still ships a full-width `edit-code-source` action row for a
 *       property that now carries the aspect (the two would be the same editor
 *       offered twice, which is what the user rejected);
 *   (4) the declaration guard is loud at the author's desk for each malformed
 *       shape, including `code` on a non-text row (the editor writes a string
 *       back, so a number/select row would be corrupted by its own button).
 *
 * Not asserted here: that web/Inspector.svelte RENDERS the button. That is DOM,
 * and it belongs to a browser probe; this file owns the declaration contract.
 */

import assert from "node:assert/strict";
import { builtinRoster } from "../plugins/index.js";
import { codeRowLanguage, customProps } from "../core/properties.js";

const roster = builtinRoster();

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Pure function. The plugin of a given type from a roster, or undefined.
 *
 * @example pluginOf([{type: "mermaid"}], "mermaid").type // "mermaid"
 * @example pluginOf([{type: "mermaid"}], "rect") // undefined
 */
function pluginOf(plugins, type) {
  return plugins.find((p) => p.type === type);
}

/** Pure function. Every row of a plugin's inspector carrying the `code` aspect.
 *
 * @example codeRowsOf({inspector: [{key: "w"}, {key: "src", code: {language: "javascript"}}]}).map((r) => r.key)
 * ["src"]
 * @example codeRowsOf({inspector: []})
 * []
 */
function codeRowsOf(plugin) {
  return (plugin.inspector ?? []).filter((r) => r.code);
}

// ── (1) the resolver, both declared forms ────────────────────────────────────
test("codeRowLanguage resolves a literal language", () => {
  assert.equal(codeRowLanguage({ key: "definition", code: { language: "mermaid" } }, {}), "mermaid");
});

test("codeRowLanguage resolves a STATE-derived language (codeblock's form)", () => {
  const row = { key: "code", code: { language: (s) => s.language ?? null } };
  assert.equal(codeRowLanguage(row, { language: "python" }), "python");
  // Absent state field → plain text rather than a stale or invented id.
  assert.equal(codeRowLanguage(row, {}), null);
});

test("codeRowLanguage is null for a row with no code aspect", () => {
  assert.equal(codeRowLanguage({ key: "w", kind: "number" }, {}), null);
});

// ── (2) the four migrated plugins ────────────────────────────────────────────
// The property each one's code row must sit on. Taken from the plugin's OWN
// `codeEditor` descriptor below rather than repeated here, so this table names
// only which widgets were migrated — the property/language agreement is derived,
// not transcribed (a transcription would be a third opinion to keep in step).
const MIGRATED = ["graph_line", "graph_bars", "mermaid", "codeblock", "latex"];

for (const type of MIGRATED) {
  test(`${type} declares exactly one code row, agreeing with its codeEditor descriptor`, () => {
    const plugin = pluginOf(roster, type);
    assert.ok(plugin, `${type} is not in the builtin roster`);
    const rows = codeRowsOf(plugin);
    assert.equal(rows.length, 1, `${type} declares ${rows.length} code rows (expected exactly 1): ${rows.map((r) => r.key).join(", ")}`);
    const [row] = rows;
    assert.equal(row.kind, "text", `${type}'s code row must be a text row (the editor writes a string back)`);
    const descriptor = plugin.codeEditor;
    assert.ok(descriptor, `${type} carries a code row but no codeEditor descriptor — double-clicking it would open nothing`);
    assert.equal(
      row.key, descriptor.property,
      `${type}'s code row edits "${row.key}" but double-click opens "${descriptor.property}" — one widget, two different sources`,
    );
    // The languages must agree ON THIS WIDGET'S DEFAULTS — the state a freshly
    // inserted widget is actually in, and the one a state-derived language is
    // resolved against.
    //
    // ONE ASYMMETRY IS ALLOWED, in exactly one direction: the descriptor may say
    // null (plaintext) where the row resolves a real id. That is codeblock, whose
    // descriptor was written null because web/monacoSetup.js registers no grammar
    // for most of its languages, while the row now passes the widget's actual
    // `language` through. A row that went null against a NAMED descriptor
    // language would be the reverse — losing highlighting the widget already had
    // — and is refused.
    const rowLanguage = codeRowLanguage(row, plugin.defaults);
    if (descriptor.language != null) {
      assert.equal(
        rowLanguage, descriptor.language,
        `${type}'s code row highlights as "${rowLanguage}" but double-click opens "${descriptor.language}" — one source, two colourings`,
      );
    }
  });
}

// ── (3) the button rows are GONE, app-wide ───────────────────────────────────
test("no plugin offers both a code row and an edit-code-source action row", () => {
  for (const plugin of roster) {
    const codeKeys = new Set(codeRowsOf(plugin).map((r) => r.key));
    if (codeKeys.size === 0) continue;
    const actions = (plugin.inspector ?? []).filter((r) => r.kind === "action" && r.command === "edit-code-source");
    assert.equal(
      actions.length, 0,
      `${plugin.type} keeps a full-width "${actions[0]?.label}" row beside a code-aspect row — that is the same editor offered twice, which is what the row aspect replaced.`,
    );
  }
});

// ── (4) the declaration guard ────────────────────────────────────────────────
test("a malformed code aspect throws where it is written", () => {
  const declare = (code, kind = "text") => () => customProps([{ name: "src", kind, default: "", code }]);
  assert.throws(declare("javascript"), /not an object/, "a bare language string must not pass for the aspect");
  assert.throws(declare({}), /no `language`/, "a code editor with no language cannot highlight");
  assert.throws(declare({ language: 7 }), /must be a string/, "a non-string, non-function language is meaningless");
  assert.throws(declare({ language: "javascript" }, "number"), /code is edited as TEXT/, "the editor writes a string, so only a text row may carry it");
  // The well-formed shapes still pass, so the guard is not simply refusing everything.
  assert.deepEqual(customProps([{ name: "src", kind: "text", default: "", code: { language: null } }]).rows[0].code, { language: null });
  assert.equal(typeof customProps([{ name: "src", kind: "text", default: "", code: { language: (s) => s.lang } }]).rows[0].code.language, "function");
});

console.log(`\n${passed} code-row-aspect tests passed`);
