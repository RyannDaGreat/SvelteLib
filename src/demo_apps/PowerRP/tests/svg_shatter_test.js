/**
 * SHATTERING THE SVG FAMILY — Iconify icons and SVG drawings into their pieces.
 *
 * User, 2026-08-02: "Shatter is not offered on Iconify icons — and can we shatter
 * shapes/SVGs to POLYGON?"
 *
 * THE POLYGON QUESTION IS ANSWERED BY GEOMETRY, and this suite pins the answer so
 * it is not quietly reversed: a part is an `svg` widget, not a `polygon`, because
 * an icon's outline is CUBICS and a polygon stores a point list — converting means
 * flattening every curve to chords, which is lossy in a way that worsens on scale
 * and inflates a four-token `d` into dozens of coordinates. A polygon conversion
 * is a useful SEPARATE tool at a fidelity cost the author should choose; it is not
 * this.
 *
 * Run: node src/demo_apps/PowerRP/tests/svg_shatter_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { shatterEligible, svgOpsToParts, partKey } from "../core/shatter.js";
import { pathsToSvgSrc, pathsBounds } from "../core/svg_paths.js";

const registry = createRegistry();
registerAll(registry, createCommands());

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const BOX = { x: 100, y: 50, w: 40, h: 40 };
/** Two disjoint squares — the "body + eye" shape a real icon has. */
const TWO_PIECES = [
  { d: "M0 0H10V10H0Z", fill: "#111" },
  { d: "M20 20H30V30H20Z", fill: "#c33" },
];

// ── ELIGIBILITY: THE USER'S ACTUAL COMPLAINT ────────────────────────────────

test("SHATTER IS NOW OFFERED ON ICONIFY ICONS — the reported gap", () => {
  assert.equal(shatterEligible(registry.get("iconify")), true);
});

test("…and on SVG drawings", () => {
  assert.equal(shatterEligible(registry.get("svg")), true);
});

test("mermaid, which already had it, is unaffected", () => {
  assert.equal(shatterEligible(registry.get("mermaid")), true);
});

test("a widget with no shatter() is still ineligible — the capability is opt-in", () => {
  assert.equal(shatterEligible(registry.get("rect")), false);
});

// ── THE PIECES ──────────────────────────────────────────────────────────────

test("ONE PART PER DRAWABLE PATH — the SVG author's own unit of intent", () => {
  const { parts } = svgOpsToParts(TWO_PIECES, BOX, "icon");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.key), [partKey("icon1"), partKey("icon2")]);
});

test("EVERY PART IS AN `svg` WIDGET, NOT A POLYGON — the fidelity ruling", () => {
  const { parts } = svgOpsToParts(TWO_PIECES, BOX, "icon");
  for (const p of parts) {
    assert.equal(p.state.type, "svg");
    assert.ok(typeof p.state.svgSrc === "string" && p.state.svgSrc.includes("<path"), "it carries the exact path, curves intact");
    assert.ok(!("points" in p.state), "and no flattened point list");
  }
});

test("A CURVE SURVIVES VERBATIM — the whole reason a part is not a polygon", () => {
  const curvy = [{ d: "M0 0C5 0 10 5 10 10L0 10Z", fill: "#000" }];
  const { parts } = svgOpsToParts(curvy, BOX, "icon");
  assert.ok(parts[0].state.svgSrc.includes("C5 0 10 5 10 10"), "the cubic is still a cubic, not a chord run");
});

test("EACH PART IS TIGHTLY BOXED, not given the host's whole box", () => {
  // Three overlapping full-size targets would be impossible to pick apart —
  // the opposite of what shattering is for.
  const { parts } = svgOpsToParts(TWO_PIECES, BOX, "icon");
  assert.deepEqual({ x: parts[0].state.x, y: parts[0].state.y, w: parts[0].state.w, h: parts[0].state.h },
    { x: BOX.x + 0, y: BOX.y + 0, w: 10, h: 10 }, "piece 1 sits at its own ink");
  assert.deepEqual({ x: parts[1].state.x, y: parts[1].state.y, w: parts[1].state.w, h: parts[1].state.h },
    { x: BOX.x + 20, y: BOX.y + 20, w: 10, h: 10 }, "piece 2 at its own, offset inside the host");
});

test("a part's viewBox is its OWN bounds, so preserveAspect:false cannot distort it", () => {
  const { parts } = svgOpsToParts(TWO_PIECES, BOX, "icon");
  assert.equal(parts[1].state.preserveAspect, false);
  assert.ok(parts[1].state.svgSrc.includes('viewBox="20 20 10 10"'), `got ${parts[1].state.svgSrc}`);
});

test("PIECES ARE PLACED RELATIVE TO THE HOST, so the group lands where the icon was", () => {
  const moved = svgOpsToParts(TWO_PIECES, { x: 0, y: 0, w: 40, h: 40 }, "icon").parts;
  const shifted = svgOpsToParts(TWO_PIECES, { x: 500, y: 300, w: 40, h: 40 }, "icon").parts;
  assert.equal(shifted[0].state.x - moved[0].state.x, 500);
  assert.equal(shifted[0].state.y - moved[0].state.y, 300);
});

// ── THE HONEST EDGES ────────────────────────────────────────────────────────

test("A ZERO-AREA PIECE IS REPORTED, not silently dropped", () => {
  // A hairline rule or a degenerate move is real SVG; dropping it in silence
  // would make the shattered group quietly unlike the icon it came from.
  const { parts, notes } = svgOpsToParts([...TWO_PIECES, { d: "M5 5L5 5Z", fill: "#000" }], BOX, "icon");
  assert.equal(parts.length, 2, "the degenerate piece is not a widget");
  assert.equal(notes.length, 1, "…and it is named in the notes");
  assert.match(notes[0], /no measurable area/);
});

test("nothing to shatter yields no parts and no crash", () => {
  assert.deepEqual(svgOpsToParts([], BOX, "icon"), { parts: [], notes: [] });
});

test("every part key is a LEGAL reference token, which shatteredDocument enforces", () => {
  // A key stands in for an itemId in sibling equations, so it must tokenize.
  for (const p of svgOpsToParts(TWO_PIECES, BOX, "icon").parts)
    assert.match(p.key, /^[A-Za-z][A-Za-z0-9]*$/, `${p.key} must be letters and digits, starting with a letter`);
});

// ── THE GATES SAY WHY, RATHER THAN JUST REFUSING ────────────────────────────

test("ICONIFY's not-ready reason names the real cause, per case", () => {
  const p = registry.get("iconify");
  assert.match(p.shatterNotReady({ icon: "" }), /icon to be chosen/);
  assert.match(p.shatterNotReady({ icon: "mdi:robot" }), /still in flight|finished loading/,
    "an un-fetched icon is not ready, and says so");
});

test("SVG's not-ready reason distinguishes ITS two source modes", () => {
  const p = registry.get("svg");
  assert.equal(p.shatterNotReady({ svgSource: "inline", svgSrc: "<svg viewBox='0 0 1 1'><path d='M0 0H1V1Z'/></svg>" }), null,
    "an inline source is ready immediately — there is nothing to wait for");
  assert.match(p.shatterNotReady({ svgSource: "inline", svgSrc: "" }), /empty|no source/i);
  assert.match(p.shatterNotReady({ svgSource: "url", svgUrl: "https://example.test/a.svg" }), /still in flight|finished loading/);
});

test("the shatter THROWS if called when its gate says not ready — they agree", () => {
  // Shattering into nothing while reporting success is the silent failure this
  // codebase forbids, so the gate and the operation share one condition.
  assert.throws(() => registry.get("svg").shatter({ svgSource: "inline", svgSrc: "" }, { box: BOX }), /nothing to shatter|no source/i);
});

console.log(`\n${passed} svg-shatter tests passed`);
