/**
 * RECENT COLORS (the MRU swatch column) — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/recent_colors_test.js
 *
 * WHAT IS PINNED, and why each one is a LAW rather than a behaviour:
 *   - MOVE-TO-FRONT with CASE-INSENSITIVE de-duplication. Without it one drag fills
 *     the column with twelve near-identical shades and the feature is dead within a
 *     single gesture; without the case fold, "#FF0000FF" and "#ff0000ff" both sit
 *     there, and the column is lying about having two colors.
 *   - the cap holds from BOTH ends (nothing over `max` survives, and the newest is
 *     never the one dropped).
 *   - a NON-COLOR is ignored, not stored. Equation-bound fields legitimately hold
 *     "= self.fill", and a column with an equation in it would be unpickable.
 *   - persistence is BEST-EFFORT: a throwing localStorage must not break the list
 *     for the session, because a colour history is not worth taking the Inspector
 *     down for.
 */

import assert from "node:assert/strict";

// The module touches localStorage at import time only through functions, but
// recentColors()/markColorUsed() reach for it — so a stub must exist FIRST.
function installStorage(impl) {
  globalThis.localStorage = impl;
}
installStorage(new Map([["store", null]]) && {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
});

const {
  withColorUsed, isStorableColor, recentColors, markColorUsed, clearRecentColors, RECENT_COLORS_MAX,
} = await import("../web/recentColors.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── the pure reducer ─────────────────────────────────────────────────────────

test("a used color goes to the FRONT, and re-using an old one promotes it", () => {
  assert.deepEqual(withColorUsed([], "#ff0000ff"), ["#ff0000ff"]);
  assert.deepEqual(withColorUsed(["#00ff00ff"], "#ff0000ff"), ["#ff0000ff", "#00ff00ff"]);
  // Promotion, not "already present, skip" — re-picking makes it recent again.
  assert.deepEqual(
    withColorUsed(["#111111ff", "#222222ff", "#333333ff"], "#333333ff"),
    ["#333333ff", "#111111ff", "#222222ff"],
  );
});

test("de-duplication is CASE-INSENSITIVE — one color may not occupy two slots", () => {
  // The picker emits lowercase; a hand-typed hex is often upper. Same color.
  assert.deepEqual(withColorUsed(["#ff0000ff"], "#FF0000FF"), ["#FF0000FF"]);
  assert.deepEqual(
    withColorUsed(["#aaaaaaff", "#ff0000ff", "#bbbbbbff"], "#Ff0000fF"),
    ["#Ff0000fF", "#aaaaaaff", "#bbbbbbff"],
  );
  // The FORM JUST USED is what is kept — it is what the user last saw.
  assert.equal(withColorUsed(["#ff0000ff"], "#FF0000FF")[0], "#FF0000FF");
});

test("the cap holds from both ends: oldest evicted, newest never dropped", () => {
  let list = [];
  for (let i = 0; i < RECENT_COLORS_MAX + 5; i++)
    list = withColorUsed(list, `#${i.toString(16).padStart(2, "0")}0000ff`);
  assert.equal(list.length, RECENT_COLORS_MAX, "the cap must hold");
  assert.equal(list[0], `#${(RECENT_COLORS_MAX + 4).toString(16).padStart(2, "0")}0000ff`,
    "the most recent color must be first");
  // A promotion inside a FULL list must not change its length.
  const promoted = withColorUsed(list, list[list.length - 1]);
  assert.equal(promoted.length, RECENT_COLORS_MAX);
});

test("withColorUsed returns a NEW array and never mutates its input", () => {
  const original = ["#111111ff"];
  const copy = [...original];
  withColorUsed(original, "#222222ff");
  assert.deepEqual(original, copy, "the input list was mutated");
});

// ── what counts as a color ───────────────────────────────────────────────────

test("only real hex is storable — an EQUATION is not a color", () => {
  for (const ok of ["#f08", "#f08c", "#ff0080", "#ff0080ff", "#FF0080FF"])
    assert.equal(isStorableColor(ok), true, `${ok} should be storable`);
  for (const no of ["= self.fill", "self.fill", "rgb(1,2,3)", "", "#12", null, undefined, 5, {}])
    assert.equal(isStorableColor(no), false, `${JSON.stringify(no)} must not be stored`);
});

test("markColorUsed IGNORES a non-color rather than storing it", () => {
  clearRecentColors();
  markColorUsed("#ff0000ff");
  const before = recentColors();
  markColorUsed("= self.fill");
  assert.deepEqual(recentColors(), before, "an equation must not enter the column");
});

// ── storage ──────────────────────────────────────────────────────────────────

test("the list round-trips through storage, newest first", () => {
  clearRecentColors();
  markColorUsed("#111111ff");
  markColorUsed("#222222ff");
  assert.deepEqual(recentColors(), ["#222222ff", "#111111ff"]);
});

test("a corrupt stored value reads as EMPTY, never throws", () => {
  clearRecentColors();
  globalThis.localStorage.setItem("powerrp.recentColors", "{not json");
  // Force a re-read by reloading the module's cache through a fresh import.
  const url = new URL("../web/recentColors.js", import.meta.url).href + "?corrupt";
  return import(url).then((m) => {
    assert.deepEqual(m.recentColors(), [], "unreadable history must be an empty list");
  });
});

test("a THROWING localStorage still leaves the session's list correct", () => {
  clearRecentColors();
  const good = globalThis.localStorage;
  installStorage({
    getItem: () => null,
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() {},
  });
  const url = new URL("../web/recentColors.js", import.meta.url).href + "?quota";
  return import(url).then((m) => {
    const out = m.markColorUsed("#abcdefff"); // must not throw
    assert.deepEqual(out, ["#abcdefff"], "the in-memory list must still be updated");
    assert.deepEqual(m.recentColors(), ["#abcdefff"]);
    installStorage(good);
  });
});

console.log(`\n${passed} recent-color tests passed`);
