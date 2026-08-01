/**
 * PLACEMENT GRAMMAR guard — the HintBar chips a crosshair placement shows must
 * match what its geometry ACTUALLY does with the key.
 * Run: node src/demo_apps/PowerRP/tests/placement_grammar_test.js
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 * There are two single-gesture placement grammars and they read Shift DIFFERENTLY:
 * `creationRect` treats it as resize's UNIFORM SCALE, `creationEndpoint` treats it
 * as an AXIS LOCK (a single free point has no second dimension to relate a scale
 * to — that function's own docstring says so). Both ran under ONE drag kind
 * (`place`, declaring `["uniform", "symmetric"]`), so dragging out a line or an
 * arrow put "Uniform scale" on the bar for a key that axis-locks. Measured, not
 * inferred: with the kinds merged, the mid-drag bar for an arrow placement read
 * `Shift = Uniform scale`.
 *
 * The correct chip already existed and was already in use one flow over —
 * web/polygonDraw.js cites `creationEndpoint` BY NAME as the in-house axis-lock
 * precedent and declares `modifiers: ["axisLock"]` for its vertex step. So this
 * was not a missing feature; it was an existing answer not applied here.
 *
 * ── WHY IT IS DERIVED AND NOT RESTATED ───────────────────────────────────────
 * A test that says "placesegment should declare axisLock" is a THIRD copy of the
 * claim and gates nothing — it passes whenever someone edits both copies wrongly.
 * So this suite RUNS each grammar with the key held and CLASSIFIES what happened
 * (did the two extents equalise? did one collapse to zero? did the start become
 * the centre?), then asserts the classification names the modifier the table
 * declares. The expectation comes from the math, which is the thing the user
 * actually experiences.
 *
 * The classification is BIDIRECTIONAL, which is the half that catches the
 * multiresize defect class rather than only this one: a key that CHANGES the
 * geometry must be declared, and a key that is declared must change it.
 *
 * WHAT IT PROVES
 *   (1) every placement grammar's declared modifiers describe what its geometry
 *       does — and no declared modifier is a key that does nothing;
 *   (2) no key that changes the geometry is left unannounced;
 *   (3) CanvasView routes placement through the table (no re-hardcoded kind);
 *   (4) the create-handler id this module cannot import still exists over in
 *       web/widget_handlers.js (the cross-module agreement it cannot share code for).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLACEMENT_GRAMMARS, PLACEMENT_DRAG_KINDS, DRAG_KIND_MODIFIERS, DRAG_KINDS,
  placementDragKind, SEGMENT_CREATE_HANDLER,
} from "../web/canvas/dragKinds.js";
import { DRAG_MODIFIER_HINTS } from "../core/shortcut_entries.js";
import { handlerFor, canvasModes } from "../web/widget_handlers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── THE PROBE DRAG ───────────────────────────────────────────────────────────
// From the origin to (300, 100): both extents NONZERO and UNEQUAL, which is what
// makes the three readings distinguishable at all. A square drag would satisfy
// "uniform" by accident; a drag along one axis would satisfy "axis lock" by
// accident. The classifications below are only meaningful on this shape, which is
// why it is one constant and not a parameter.
const PROBE = Object.freeze({ sx: 0, sy: 0, wx: 300, wy: 100 });
const NO_MODS = Object.freeze({ uniform: false, symmetric: false });

/**
 * The mods-record field each physical KEY sets. The record CanvasView passes a
 * grammar is `{uniform, symmetric}`, named for the box grammar that came first —
 * so the field name and the modifier ID differ for `axisLock`, deliberately and
 * with precedent (web/polygonDraw.js reads `p.mods.uniform` while declaring
 * `modifiers: ["axisLock"]`). Keyed by KEY rather than by modifier id so this
 * suite does not restate the id→behaviour mapping it exists to check.
 */
const MODS_FIELD_FOR_KEY = Object.freeze({ Shift: "uniform", Cmd: "symmetric" });

/** Pure function. The mods field a modifier id's chip key sets, or a loud throw.
 * @example modsFieldFor("axisLock") // "uniform" (its chip key is Shift) */
function modsFieldFor(id) {
  const hint = DRAG_MODIFIER_HINTS[id];
  assert.ok(hint, `modifier id "${id}" has no DRAG_MODIFIER_HINTS entry`);
  assert.equal(hint.keys.length, 1, `modifier "${id}" declares ${hint.keys.length} keys; the mods record has one field per single key`);
  const field = MODS_FIELD_FOR_KEY[hint.keys[0]];
  assert.ok(field, `modifier "${id}" is on key "${hint.keys[0]}", which the {uniform, symmetric} mods record has no field for — a placement grammar could never read it, so its chip would be a key that does nothing`);
  return field;
}

/**
 * Pure function. What a grammar's result LOOKS LIKE, in terms both shapes share:
 * the extent it spans and whether the drag's start point ended up at its centre.
 * `rect` and `endpoint` are the two halves of the union `ctx.gesture` carries, so
 * one observer covers both grammars with no per-grammar branch in the assertions.
 *
 * @example // observe({rect: {x: 0, y: 0, w: 300, h: 100}}, 0, 0)
 * @example //   → {dx: 300, dy: 100, centredOnStart: false}
 * @example // observe({endpoint: {from: {x: -300, y: -100}, to: {x: 300, y: 100}}}, 0, 0)
 * @example //   → {dx: 600, dy: 200, centredOnStart: true}
 */
function observe(g, sx, sy) {
  if (g.rect)
    return { dx: g.rect.w, dy: g.rect.h, centredOnStart: g.rect.x + g.rect.w / 2 === sx && g.rect.y + g.rect.h / 2 === sy };
  const { from, to } = g.endpoint;
  return { dx: to.x - from.x, dy: to.y - from.y, centredOnStart: (from.x + to.x) / 2 === sx && (from.y + to.y) / 2 === sy };
}

const span = (o) => Math.max(Math.abs(o.dx), Math.abs(o.dy));

/**
 * WHAT EACH MODIFIER ID CLAIMS, as a predicate over (unmodified, modified)
 * observations. These ARE the chip labels restated as arithmetic, which is the
 * only form in which a label can be checked:
 *   uniform   ("Uniform scale") — both extents become the SAME magnitude, and it
 *                                 is the larger of the two (the corner rides the
 *                                 diagonal through the anchor).
 *   axisLock  ("Axis lock")     — exactly ONE extent collapses to zero and the
 *                                 other keeps the dominant magnitude.
 *   symmetric ("Symmetric …")   — the start point becomes the CENTRE and each
 *                                 extent doubles (both sides move).
 */
const READINGS = Object.freeze({
  uniform: (base, held) => Math.abs(held.dx) === Math.abs(held.dy) && span(held) === span(base),
  axisLock: (base, held) => (held.dx === 0) !== (held.dy === 0) && span(held) === span(base),
  symmetric: (base, held) => !base.centredOnStart && held.centredOnStart
    && Math.abs(held.dx) === 2 * Math.abs(base.dx) && Math.abs(held.dy) === 2 * Math.abs(base.dy),
});

/** Query-shaped pure helper: run a grammar with `field` held (or nothing held). */
function run(kind, field) {
  const mods = field ? { ...NO_MODS, [field]: true } : NO_MODS;
  return observe(PLACEMENT_GRAMMARS[kind].gesture(PROBE.sx, PROBE.sy, PROBE.wx, PROBE.wy, mods), PROBE.sx, PROBE.sy);
}

const same = (a, b) => a.dx === b.dx && a.dy === b.dy && a.centredOnStart === b.centredOnStart;

// ── (1) every declared modifier describes what the geometry does ─────────────
test("each placement grammar's declared modifiers match its actual behaviour", () => {
  for (const kind of PLACEMENT_DRAG_KINDS) {
    const base = run(kind, null);
    for (const id of PLACEMENT_GRAMMARS[kind].modifiers) {
      const held = run(kind, modsFieldFor(id));
      assert.ok(
        READINGS[id](base, held),
        `placement kind "${kind}" announces "${id}" (${DRAG_MODIFIER_HINTS[id].keys.join("+")} — "${DRAG_MODIFIER_HINTS[id].label}"), but holding that key produced ${JSON.stringify(held)} from ${JSON.stringify(base)}, which is not what "${id}" means. The bar would be describing a behaviour the gesture does not have.`,
      );
      // AND NOT SOMETHING ELSE ON THE SAME KEY. This is the direction that caught
      // the real defect: `uniform` and `axisLock` are both Shift, and the merged
      // kind declared `uniform` for a grammar that axis-locks — a claim that only
      // fails if the OTHER reading is checked too.
      for (const other of Object.keys(READINGS))
        if (other !== id && modsFieldFor(other) === modsFieldFor(id))
          assert.ok(
            !READINGS[other](base, held),
            `placement kind "${kind}" announces "${id}" on ${DRAG_MODIFIER_HINTS[id].keys.join("+")}, but that key actually performs "${other}" (${DRAG_MODIFIER_HINTS[other].label}). Declare "${other}" instead.`,
          );
    }
  }
});

// ── (2) no key that changes the geometry is left unannounced ─────────────────
test("no placement grammar reads a key it does not announce", () => {
  for (const kind of PLACEMENT_DRAG_KINDS) {
    const base = run(kind, null);
    const declaredFields = PLACEMENT_GRAMMARS[kind].modifiers.map(modsFieldFor);
    for (const [key, field] of Object.entries(MODS_FIELD_FOR_KEY)) {
      const changes = !same(base, run(kind, field));
      assert.equal(
        changes, declaredFields.includes(field),
        changes
          ? `placement kind "${kind}" CHANGES its geometry when ${key} is held but declares no modifier on that key — a working modifier with no chip, which is the multiresize defect.`
          : `placement kind "${kind}" declares a modifier on ${key} but holding it changes nothing — a chip for a key that does nothing.`,
      );
    }
  }
});

// ── (3) the table is the single source, and CanvasView reads it ──────────────
test("every placement kind is a declared drag kind with the same modifier list", () => {
  for (const kind of PLACEMENT_DRAG_KINDS) {
    assert.ok(DRAG_KINDS.includes(kind), `placement kind "${kind}" is not in DRAG_KIND_MODIFIERS, so app.dragKind would THROW on it`);
    assert.equal(
      PLACEMENT_GRAMMARS[kind].modifiers, DRAG_KIND_MODIFIERS[kind],
      `PLACEMENT_GRAMMARS["${kind}"].modifiers must BE the DRAG_KIND_MODIFIERS array (same reference), not a copy of it — a copy is a second source and drifts`,
    );
  }
});

test("CanvasView resolves the placement kind through the table, never by hand", () => {
  // Comments STRIPPED first (ledger C-14): this file explains itself in prose, and
  // an unstripped scan would match the very sentences describing the defect. The
  // stripper uses `[ \t]*`, never `^\s*` — `\s` matches newline, which eats the
  // blank lines above a comment and drifts every later line number.
  const raw = fs.readFileSync(path.join(HERE, "../web/CanvasView.svelte"), "utf8");
  const src = raw.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    src, /placementDragKind\(/,
    "CanvasView must resolve a placement drag's kind through placementDragKind (web/canvas/dragKinds.js). Branching on plugin.placement here is how the announced kind came to disagree with the grammar that ran.",
  );
  for (const kind of PLACEMENT_DRAG_KINDS)
    assert.doesNotMatch(
      src, new RegExp(`app\\.dragKind\\s*=\\s*"${kind}"`),
      `CanvasView assigns app.dragKind = "${kind}" as a literal. A placement's kind IS its grammar — take it from placementDragKind so the chips, the preview and the commit cannot pick different answers.`,
    );
  assert.match(
    src, /PLACEMENT_DRAG_KINDS\.includes\(/,
    "CanvasView's pointer-move / pointer-up must route placements by PLACEMENT_DRAG_KINDS membership, or a grammar added to the table would be started and never driven.",
  );
});

// ── (4) the cross-module agreement this module cannot share code for ─────────
test("SEGMENT_CREATE_HANDLER still names a real create handler", () => {
  // dragKinds.js is DOM-free and cannot import the handler registry, so the id is
  // written down twice and must be GATED rather than trusted (ledger C-1's
  // corollary). Resolved through handlerFor, which is the same door CanvasView uses.
  assert.equal(
    handlerFor("create", { placement: SEGMENT_CREATE_HANDLER }).id, SEGMENT_CREATE_HANDLER,
    `web/canvas/dragKinds.js SEGMENT_CREATE_HANDLER is "${SEGMENT_CREATE_HANDLER}", but the create phase does not resolve a plugin declaring it to a handler of that id. If the handler was renamed, rename the constant with it — otherwise every segment placement silently falls back to the box grammar and announces the wrong Shift.`,
  );
  assert.equal(placementDragKind(SEGMENT_CREATE_HANDLER), "placesegment");
  // A MULTI-STEP create handler never reaches placementDragKind (CanvasView enters
  // its mode instead), but if one ever did it must land on a real kind rather than
  // silently borrowing the box grammar's chips. Asserting the whole create-handler
  // population keeps that honest as handlers are added.
  for (const { handlerId } of canvasModes().filter((m) => m.phase === "create"))
    assert.ok(PLACEMENT_DRAG_KINDS.includes(placementDragKind(handlerId)), `placementDragKind("${handlerId}") is not a declared placement kind`);
});

console.log(`\nplacement_grammar_test: ${passed} passed`);
