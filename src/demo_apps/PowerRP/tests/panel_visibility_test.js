/**
 * PANEL VISIBILITY guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/panel_visibility_test.js
 *
 * WHY THIS EXISTS. Three user rulings, verbatim, that are each a one-word drift
 * away from being lost:
 *
 *   (1) "we're going to have toggle visibility as a prefix. It's convention.
 *       Toggle visibility of different panels: toggle visibility properties
 *       panel, toggle visibility keyframes panel…" — the PREFIX is load-bearing,
 *       not decoration: the palette is fuzzy-searched over titles, so it is what
 *       makes the whole family filter together by typing "toggle visibility". A
 *       single "Toggle Global Variables Panel" would silently fall out of it.
 *   (2) "the variables panel should now be called the global variables panel,
 *       because they're global variables".
 *   (3) The variables panel "by default will be off for now on."
 *
 * WHAT IT PROVES:
 *   (1) EVERY panel has a toggle command REGISTERED in web/App.svelte, and every
 *       registered toggle-panel-* command corresponds to a real panel — both
 *       directions, so neither a new panel without a command nor a command for a
 *       deleted panel can survive.
 *   (2) Every title is EXACTLY `Toggle Visibility: <label> Panel`.
 *   (3) Global Variables is the ONE panel hidden by default, is named "Global
 *       Variables", and its localStorage key is the one App/app.svelte.js read.
 *   (4) columnSplits() produces one boundary per GAP between visible panels —
 *       n visible → n-1 boundaries — which is what makes a hidden pane leave no
 *       dead divider, and re-showing restore the same boundaries.
 *   (5) The layout is driven by the VISIBLE SUBSET, not by fixed pane indices
 *       (the defect this replaced: with one panel hidden, `row === 2` rendered
 *       whichever panel used to be third).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PANELS,
  TOGGLE_VISIBILITY_PREFIX,
  panelById,
  panelsInColumn,
  panelName,
  panelToggleCommand,
  panelSettingKey,
  columnSplits,
} from "../core/panels.js";

const here = dirname(fileURLToPath(import.meta.url));
const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");
const appState = readFileSync(resolve(here, "../web/app.svelte.js"), "utf8");

// ── (1) every panel has a command, and every command has a panel ─────────────

test("EVERY panel's toggle command is registered, and no command names a dead panel", () => {
  // The commands are GENERATED from PANELS by a spread in web/App.svelte, so what
  // this asserts is that the generator is still wired to the registry array — the
  // one thing a refactor could quietly drop while leaving both halves present.
  assert.match(
    appSvelte,
    /\.\.\.PANELS\.map\(\(panel\) => \(\{\s*\n\s*\.\.\.panelToggleCommand\(panel\)/,
    "web/App.svelte no longer spreads panelToggleCommand(panel) over PANELS into the command registry",
  );
  assert.ok(appSvelte.includes("run: (a) => a.togglePanel(panel.id)"), "the generated commands do not call togglePanel");
  assert.ok(/togglePanel\(id\)\s*\{/.test(appState), "web/app.svelte.js has no togglePanel(id) command");

  // And every panel really does produce a distinct id/title pair.
  const ids = PANELS.map((p) => panelToggleCommand(p).id);
  assert.equal(new Set(ids).size, PANELS.length, `duplicate toggle command ids: ${ids.join(", ")}`);
  assert.deepEqual(ids, PANELS.map((p) => `toggle-panel-${p.id}`));
});

test("no hand-written command shadows a generated panel toggle", () => {
  // A literal `id: "toggle-panel-<panelId>"` in the registry would be a SECOND
  // entry for a panel that already has a generated one — two palette rows, one of
  // which would drift out of the convention.
  //
  // Matched against the PANEL IDS, not against `toggle-panel-*` as a shape: the
  // unrelated, pre-existing `toggle-panel-names` (Toggle Panel Names, which shows
  // every panel's title bar and is not a visibility toggle) shares that prefix by
  // coincidence, and a looser regex flagged it. There is no panel called "names".
  const literals = [...appSvelte.matchAll(/id: "(toggle-panel-[a-zA-Z]+)"/g)].map((m) => m[1]);
  const generated = new Set(PANELS.map((p) => panelToggleCommand(p).id));
  const shadowed = literals.filter((id) => generated.has(id));
  assert.deepEqual(shadowed, [], `hand-written panel toggle commands bypass the generator: ${shadowed.join(", ")}`);
  assert.ok(!generated.has("toggle-panel-names"), "a panel is now called `names`, colliding with the Toggle Panel Names command");
});

// ── (2) the title convention, exactly ────────────────────────────────────────

test("EVERY title is exactly `Toggle Visibility: <label> Panel`", () => {
  assert.equal(TOGGLE_VISIBILITY_PREFIX, "Toggle Visibility: ");
  for (const panel of PANELS) {
    const { title } = panelToggleCommand(panel);
    assert.equal(title, `Toggle Visibility: ${panel.label} Panel`, `panel "${panel.id}" breaks the title convention`);
    assert.ok(title.startsWith(TOGGLE_VISIBILITY_PREFIX), `panel "${panel.id}" does not lead with the prefix`);
    assert.ok(title.endsWith(" Panel"), `panel "${panel.id}" does not end with the noun "Panel"`);
    // The whole point of the prefix is that ONE query reaches the whole family.
    assert.ok(title.toLowerCase().includes("toggle visibility"), `typing "toggle visibility" would not match ${title}`);
  }
});

test("the user's own examples come out verbatim", () => {
  // From ruling (1): "toggle visibility properties panel, toggle visibility
  // keyframes panel". Those two are the ones he actually named, so they are
  // pinned by value rather than by rule.
  assert.equal(panelToggleCommand(panelById("properties")).title, "Toggle Visibility: Property Panel");
  assert.equal(panelToggleCommand(panelById("keyframes")).title, "Toggle Visibility: Keyframe Panel");
});

test("a label never carries the word Panel itself (it would double up)", () => {
  for (const panel of PANELS) assert.doesNotMatch(panel.label, /panel/i, `panel "${panel.id}" label already says "Panel"`);
});

// ── (3) Global Variables: named, hidden by default, and the key agrees ────────

test("GLOBAL VARIABLES is the one panel off by default, and is named Global Variables", () => {
  const hidden = PANELS.filter((p) => !p.defaultVisible);
  assert.deepEqual(hidden.map((p) => p.id), ["globalVariables"], "exactly one panel — Global Variables — starts hidden");
  const panel = panelById("globalVariables");
  assert.equal(panel.label, "Global Variables");
  assert.equal(panelName(panel), "Global Variables Panel");
  assert.equal(panelToggleCommand(panel).title, "Toggle Visibility: Global Variables Panel");
  assert.equal(panel.defaultVisible, false);
});

test("no panel is still called plain \"Variables\"", () => {
  for (const panel of PANELS) assert.notEqual(panel.label, "Variables", "the Variables panel was not renamed");
  // The name PLATE is what the user sees; it must come from panelName(), not a
  // literal, or the rename can be undone in the template alone.
  assert.ok(appSvelte.includes("name={panelName(panel)}"), "the Panel name plate no longer reads panelName(panel)");
  assert.doesNotMatch(appSvelte, /name="Variables Panel"/, 'web/App.svelte still hard-codes name="Variables Panel"');
});

test("the persisted key is per panel, and app.svelte.js reads that same key", () => {
  assert.equal(panelSettingKey("globalVariables"), "powerrp.panel.globalVariables");
  const keys = PANELS.map((p) => panelSettingKey(p.id));
  assert.equal(new Set(keys).size, PANELS.length, "two panels share one localStorage key");
  // The DEFAULT travels with the panel declaration, so a fresh profile gets
  // ruling (3) for free rather than from a second literal somewhere.
  assert.ok(
    appState.includes("browserSetting(panelSettingKey(p.id), p.defaultVisible)"),
    "web/app.svelte.js no longer seeds each panel's setting from its own defaultVisible",
  );
});

// ── (4) boundaries: one per GAP, so a hidden pane leaves no dead divider ─────

test("n visible panels produce n-1 boundaries (a hidden pane takes its divider with it)", () => {
  const right = panelsInColumn("right");
  for (let n = 0; n <= right.length; n++) {
    const splits = columnSplits(right.slice(0, n));
    assert.equal(splits.length, Math.max(0, n - 1), `${n} visible panels produced ${splits.length} boundaries`);
  }
  assert.deepEqual(columnSplits([]), [], "an empty column has no boundaries — the caller drops the column itself");
  assert.deepEqual(columnSplits([panelById("tools")]), [], "a lone pane needs no divider");
});

test("boundaries are strictly ascending and strictly inside (0, 1)", () => {
  for (const column of ["left", "right"]) {
    const splits = columnSplits(panelsInColumn(column));
    for (const [i, b] of splits.entries()) {
      assert.ok(b > 0 && b < 1, `${column} boundary ${i} = ${b} is not strictly inside (0, 1)`);
      if (i > 0) assert.ok(b > splits[i - 1], `${column} boundaries are not ascending: ${splits.join(", ")}`);
    }
  }
});

test("hiding a panel REDISTRIBUTES its share; the survivors keep their RATIOS", () => {
  const right = panelsInColumn("right");
  const withoutVars = right.filter((p) => p.id !== "globalVariables");
  const splits = columnSplits(withoutVars);
  const widths = [0, ...splits, 1].slice(1).map((edge, i) => edge - [0, ...splits][i]);
  const total = withoutVars.reduce((s, p) => s + p.weight, 0);
  withoutVars.forEach((panel, i) => {
    assert.ok(Math.abs(widths[i] - panel.weight / total) < 1e-9, `pane ${panel.id} is not its weight's share of the visible total`);
  });
  // The full column and the reduced one are DIFFERENT shapes — i.e. the hidden
  // panel's space actually went to its neighbours instead of leaving a gap.
  assert.notDeepEqual(splits, columnSplits(right));
});

test("re-showing a panel restores exactly the boundaries it had (the sizes are a function of the visible set)", () => {
  const right = panelsInColumn("right");
  const before = columnSplits(right);
  const hidden = columnSplits(right.filter((p) => p.id !== "globalVariables"));
  const after = columnSplits(right);
  assert.deepEqual(after, before, "a hide/show round trip changed the column's boundaries");
  assert.notDeepEqual(hidden, before, "hiding did not change the shape at all");
});

// ── (5) the layout reads the visible subset, never a fixed pane index ────────

test("the layout maps pane index through the VISIBLE subset, not through a literal row number", () => {
  // The bug this pins: `{#if row === 2}` rendered the Global Variables pane
  // whenever the pane at index 2 was ANY panel, so hiding Property Panel put the
  // wrong component in every slot below it.
  assert.ok(appSvelte.includes("visiblePanels(column)[row]"), "the pane snippet no longer indexes visiblePanels()");
  // ONE pane body serves both columns (the {panelPane} snippet), so the
  // index → panel mapping and the six component branches exist exactly once.
  assert.ok(appSvelte.includes("{#snippet panelPane(column, row)}"), "the shared pane-body snippet is gone");
  assert.equal(
    (appSvelte.match(/@render panelPane\(/g) ?? []).length,
    2,
    "both columns must render the SHARED pane snippet — a second copy of the body is how the two columns drift apart",
  );
  assert.ok(appSvelte.includes("visibleColumns()[col]"), "the outer row snippet no longer indexes visibleColumns()");
  assert.doesNotMatch(appSvelte, /\{#if row === \d\}/, "the layout still branches on a literal pane index");
  assert.doesNotMatch(appSvelte, /\{:else if row === \d\}/, "the layout still branches on a literal pane index");
  // Every panel id must have a branch, or a visible panel would render empty.
  for (const panel of PANELS) {
    if (panel.id === "keyframes") continue; // the final `{:else}` arm
    assert.ok(appSvelte.includes(`panel.id === "${panel.id}"`), `the layout renders nothing for panel "${panel.id}"`);
  }
});

test("each column binds splits to a PLAIN IDENTIFIER, never a get/set pair over the column", () => {
  // THE BUG THIS PINS, because it was live and silent: folding both columns into
  // one <SplitPane> requires a conditional binding, and `bind:splits={cond ? a : b}`
  // is illegal — so the obvious next move is a `{get, set}` pair closing over the
  // column. Svelte captures that pair ONCE at component creation, so after a
  // visibility flip the child kept reading and writing the STALE closure: its
  // paneCount never shrank, the hidden panel left an empty pane AND a live divider
  // behind (exactly what the ruling forbids), and the pane body then indexed past
  // the end of the visible list and threw `Cannot read properties of undefined`.
  // Two <SplitPane>s with plain identifier bindings is the fix.
  assert.ok(appSvelte.includes("bind:splits={leftSplits}"), "the left column does not bind splits to a plain identifier");
  assert.ok(appSvelte.includes("bind:splits={rightSplits}"), "the right column does not bind splits to a plain identifier");
  assert.ok(appSvelte.includes("bind:splits={hSplits}"), "the outer row does not bind splits to a plain identifier");
  assert.doesNotMatch(appSvelte, /bind:splits=\{\s*\(\)\s*=>/, "a splits binding is a get/set pair again — it will capture a stale closure");
  assert.doesNotMatch(appSvelte, /bind:splits=\{[^}]*\?[^}]*:/, "a splits binding is conditional — Svelte binds to an identifier, not an expression");
});

test("a pane index past the end of the visible list renders NOTHING rather than throwing", () => {
  // SplitPane can render one flush with the OLD paneCount against the NEW, shorter
  // panel list; without the guard that frame threw and took the layout down.
  assert.ok(appSvelte.includes("{#if panel}"), "the pane body no longer guards against a transient index overrun");
});

test("hiding every panel in a column drops the COLUMN, divider included", () => {
  // A zero-pane SplitPane is not a thing, so an all-hidden column must be
  // filtered out of the outer row rather than rendered empty beside a live handle.
  assert.ok(appSvelte.includes('visiblePanels("left").length > 0'), "the left column is not gated on having a visible panel");
  assert.ok(appSvelte.includes('visiblePanels("right").length > 0'), "the right column is not gated on having a visible panel");
  // The canvas is NOT a panel and must never be filtered out — that is what keeps
  // the outer row non-empty in the all-hidden case.
  assert.ok(appSvelte.includes('{ id: "canvas", weight: columnWeights.canvas, shown: true }'), "the canvas slot is conditional");
  assert.deepEqual(PANELS.filter((p) => p.id === "canvas"), [], "the CANVAS must not be a panel — it has no visibility toggle");
});

test("a drag is remembered PER PANEL, so it survives a hide/show", () => {
  assert.ok(appSvelte.includes("function commitColumnDrag(column, splits)"), "column drags are not written back to per-panel weights");
  assert.ok(appSvelte.includes("function commitRowDrag(splits)"), "outer-row drags are not written back to per-column weights");
  assert.ok(appSvelte.includes("onchange={commitRowDrag}"), "the outer SplitPane does not commit its drag");
  for (const column of ["left", "right"])
    assert.ok(
      appSvelte.includes(`commitColumnDrag("${column}", splits)`),
      `the ${column} column's SplitPane does not commit its drag, so a divider drag there is forgotten on the next hide/show`,
    );
});

// ── the panel inventory itself ───────────────────────────────────────────────

test("every panel declares a complete, well-formed record", () => {
  for (const panel of PANELS) {
    assert.match(panel.id, /^[a-zA-Z]+$/, `panel id "${panel.id}" is not a bare slug`);
    assert.ok(panel.label.length > 0, `panel "${panel.id}" has no label`);
    assert.ok(["left", "right"].includes(panel.column), `panel "${panel.id}" sits in no known column`);
    assert.ok(panel.weight > 0, `panel "${panel.id}" has a non-positive weight`);
    assert.match(panel.icon, /^mdi:/, `panel "${panel.id}" has no mdi icon for the palette row`);
    assert.equal(typeof panel.defaultVisible, "boolean", `panel "${panel.id}" has no defaultVisible`);
  }
  assert.equal(new Set(PANELS.map((p) => p.id)).size, PANELS.length, "duplicate panel ids");
  assert.equal(new Set(PANELS.map((p) => p.label)).size, PANELS.length, "two panels share a user-facing label");
  // Both columns are non-empty by declaration; panelById throws on a typo.
  assert.ok(panelsInColumn("left").length > 0 && panelsInColumn("right").length > 0);
  assert.throws(() => panelById("nope"), /No such panel: nope/);
});
