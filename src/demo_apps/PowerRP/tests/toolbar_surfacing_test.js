/**
 * TOOLBAR-SURFACING guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/toolbar_surfacing_test.js
 *
 * WHY THIS EXISTS. The command registry is the single action layer, and the
 * Toolbar is only a VIEW of it — but for most of the project the Toolbar held a
 * `[command id, icon, tooltip]` table, i.e. a hand-kept copy of two fields the
 * registry already owned. Its own comment admitted the risk ("a toolbar tip that
 * disagrees with the palette is the drift the vocabulary pass just removed") and
 * the copy had in fact drifted three times:
 *     "Copy item (Cmd+C)"  vs registry  "Copy Item"
 *     "Zoom to fit camera" vs registry  "Zoom to Fit Camera"
 *     "Show Ghosts"        vs registry  "Toggle Ghost Objects (…)"
 * It also hand-wrote three keybinding hints while omitting four the shortcut
 * registry already knew (Put on Top, Put on Bottom, Present, Box select).
 *
 * WHAT IT PROVES, on the SOURCE (the rendered half is tests/registry_ui_probe.js):
 *   (1) the `groups` declaration holds command IDS ONLY — no icon, no label, no
 *       transcribed keybinding, so the drift is not expressible;
 *   (2) every icon literal left in the file is one of the three documented
 *       exceptions, and there are exactly three;
 *   (3) every plain-text tooltip left in the file belongs to a button that has NO
 *       command entry to read from;
 *   (4) PENDING HANDBACK pin: the toolbar commands that are GATED but carry no
 *       `requires` sentence yet. web/App.svelte is owned by another agent this
 *       round, so this records the exact set the handback patch must cover — the
 *       same pinning technique tests/tool_groups_test.js uses for CAMERA_BIND_KEYS.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolbar = readFileSync(resolve(powerRP, "web/Toolbar.svelte"), "utf8");
const appSvelte = readFileSync(resolve(powerRP, "web/App.svelte"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. The text of the Toolbar's `groups` declaration (the button
 * table), so it can be checked for content that belongs to the registry.
 *
 * @param {string} src - Toolbar.svelte source text
 * @returns {string}
 *
 * @example groupsBlock('a\nconst groups = [\n["undo"],\n];\nb') // '\n["undo"],\n'
 */
export function groupsBlock(src) {
  const start = src.indexOf("const groups = [");
  if (start < 0) throw new Error("toolbar_surfacing_test: no `const groups = [` in Toolbar.svelte — update this test to the new declaration");
  return src.slice(start + "const groups = [".length, src.indexOf("];", start));
}

// ── (1) the button table is ids only ─────────────────────────────────────────
test("the `groups` table holds command ids and nothing else", () => {
  const block = groupsBlock(toolbar);
  const literals = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  // Floor, not a count: a button may be added or removed. It only guards against
  // a silent vacuous pass if the block parse ever stops finding the table.
  assert.ok(literals.length >= 15, `only ${literals.length} entries parsed — the parse broke, not the toolbar`);
  for (const s of literals) {
    // A command id is lower-kebab. A LABEL has spaces/capitals; a transcribed
    // keybinding has a "(Cmd" or "+"; an ICON has a "mdi:" prefix. None may
    // appear here, because all three are the registry's to say.
    assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/, `"${s}" in the groups table is not a bare command id — title, icon and keybinding all come from the registries`);
  }
});

// ── (2) the icon exceptions are exactly the documented three ────────────────
test("only the three documented buttons still name their own glyphs", () => {
  // Each exception is a case the registry's single `icon` string cannot express:
  //   toggle-anchors  — magnet + X composite (round-11 user correction)
  //   toggle-ghosts   — box + eye composite (manifest ARCHITECTURE PLAN #2)
  //   toggle-light-dark — a STATEFUL glyph: it names the theme the click switches
  //     TO, so it is two literals, not one. It used to be here for a WEAKER reason
  //     ("has NO command entry at all"); it has one now, so its label and tip come
  //     from the registry like every other button's and only the glyph is local.
  const EXPECTED = [
    ["mdi:magnet", "mdi:close"], // toggle-anchors
    ["mdi:square-outline", "mdi:eye-outline"], // toggle-ghosts
    ["mdi:weather-night", "mdi:weather-sunny"], // toggle-light-dark
  ];
  const found = [...toolbar.matchAll(/"(mdi:[a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(found, EXPECTED.flat(), "an icon literal appeared (or moved) in Toolbar.svelte — every other button reads app.commands.get(id).icon");
});

// ── (3) plain-text tips only where there is no command to read ──────────────
// TIGHTENED from two to one, then re-widened to an ALLOW-LIST rather than a count.
// The original second allowance was the light/dark toggle, whose tip was
// hand-written because it had no command entry to read one from; the entry exists
// now (`toggle-light-dark`), so that button renders commandTip like the rest and
// that exception stayed retired.
//
// WHY THIS IS NOW A LIST AND NOT A NUMBER: the rule being defended is "no BUTTON
// words its own tip instead of reading the registry", and a bare count enforces
// that only by accident. Bumping the number to admit a legitimate non-command tip
// would silently re-permit a hand-written button tip in its place — the exact
// drift the header documents (three toolbar tips that disagreed with the palette).
// Naming each allowance makes the exception set readable and makes adding to it a
// deliberate edit that says which affordance and why.
//
// The two allowed tips are the only Tooltips here whose target is not a command:
//   doc-name        — a double-click RENAME gesture on the title
//   save-indicator  — a STATUS READOUT (server save state); it runs nothing at all,
//                     and its sentence is derived with its own dot state so the two
//                     cannot disagree (Toolbar.svelte: saveIndicator/saveText)
test("a hardcoded tooltip survives only where no command entry exists", () => {
  // Each <Tooltip text=…> paired with the class of the element it wraps.
  const wrapped = [...toolbar.matchAll(/<Tooltip text=[^>]*>\s*<(?:span|button|div)\s+[^>]*class="([^"{]*)/g)]
    .map((m) => m[1].trim().split(/\s+/)[0]);
  const ALLOWED = ["doc-name", "save-indicator"];
  assert.deepEqual(
    wrapped.slice().sort(),
    ALLOWED.slice().sort(),
    `Toolbar.svelte may hardcode a tip ONLY on these non-command affordances: ${ALLOWED.join(", ")}. Everything else — every button — must render the shared commandTip snippet, which reads the title, the keybinding and the disabled reason from the registries.`,
  );
  // Belt and braces: the allow-list is only meaningful if it accounts for EVERY
  // hardcoded tip, so the count must match too. A <Tooltip text=…> the regex above
  // failed to attribute (a new wrapper shape) would otherwise pass unnoticed.
  const texts = [...toolbar.matchAll(/<Tooltip text=/g)].length;
  assert.equal(texts, ALLOWED.length, "a hardcoded <Tooltip text=…> in Toolbar.svelte was not attributed to an allow-listed affordance — either it belongs to a button (use commandTip) or the allow-list above needs to name it deliberately");
  // And the shared tip snippet must still be the thing every other button uses.
  assert.match(toolbar, /\{#snippet commandTip\(id, note = null\)\}/, "the ONE command-tip body is gone — each button would be free to word its own tip again");
});

// ── (4) every gated toolbar command explains itself ─────────────────────────
// This test used to be a PENDING pin listing the three entries a handback patch
// still had to cover (copy-item, put-on-top, put-on-bottom). That patch has
// landed, so the pin is INVERTED rather than deleted: instead of naming the
// stragglers, it now asserts the invariant they were the last exceptions to.
//
// WHY this is the right shape. A `when` with no `requires` renders a button that
// is greyed out and silent about why — the user ruling this whole pass serves is
// "if something is disabled, the tooltip should say why it's disabled". A pin
// that merely listed the known offenders would go green the moment they were
// fixed and then say nothing about the NEXT gated command someone adds. This
// version fails on that one instead.
test("every Toolbar-surfaced command with a `when` also declares a `requires`", () => {
  const block = groupsBlock(toolbar);
  // The ids the Toolbar actually surfaces, read from its own table so the two
  // can never disagree (the table is ids-only by test 1, which is what makes
  // this scrape safe).
  const surfaced = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(surfaced.length > 0, "could not read any command ids out of the Toolbar's groups table");
  const gatedWithoutReason = [];
  for (const id of surfaced) {
    const line = appSvelte.split("\n").find((l) => l.includes(`id: "${id}"`));
    if (!line || !line.includes("when:")) continue; // ungated: always available, nothing to explain
    if (!line.includes("requires:")) gatedWithoutReason.push(id);
  }
  assert.deepEqual(
    gatedWithoutReason, [],
    `these Toolbar commands are gated by a \`when\` but declare no \`requires\`, so they grey out with no explanation: ${gatedWithoutReason.join(", ")}. ` +
    "Add a `requires` sentence that completes \"Unavailable — requires …\" (the wording rule core/registry.js TOOL_POOL states); " +
    "web/Toolbar.svelte and web/ToolsPane.svelte already render it with no change needed."
  );
});

console.log(`\n${passed} toolbar-surfacing tests passed`);
