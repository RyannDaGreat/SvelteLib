/**
 * HANDLE IDENTITY tests — the two optional modifier-point row fields that answer
 * "what handle is this?" (core/registry.js "HANDLE IDENTITY"): `glyph`, a key into
 * the BANK (core/handle_glyphs.js), and `label`, the hover tooltip's words.
 *
 * The laws under test, and why each is worth a test rather than a reading:
 *
 *   1. THE DEFAULT IS THE OLD LOOK, EXACTLY. An absent glyph and the key "default"
 *      must both give the plain square. This is the whole claim that the feature is
 *      additive — every widget in the app declares no glyph, and if the default
 *      drifted, all of them would change appearance at once.
 *
 *   2. AN UNKNOWN KEY THROWS. A typo'd glyph that fell back to the square would be
 *      invisible in review AND in use: the handle would simply keep looking like
 *      every other handle, which is precisely the confusion the feature removes.
 *      A silent fallback is the one failure mode that must not exist here.
 *
 *   3. PASSTHROUGH IS VERBATIM AND DEFAULTS TO NULL. core/derive.nodeModifierPoints
 *      carries glyph/label through without interpreting them (core/ names the
 *      vocabulary, web/ draws it) and supplies null for rows that declare neither —
 *      so a consumer may read the fields unconditionally, and a plugin that
 *      declares nothing is untouched.
 *
 *   4. THE GRADIENT BEADS ARE IDENTIFIED. Both carry the paint family's glyph and a
 *      label, and the labels DIFFER between the two beads and between fill and
 *      stroke — a tooltip that read the same on two handles would be a fresh way of
 *      failing the user's original question.
 *
 *   5. THE LEGACY `shape` SPELLING IS A BANK KEY. paint_path's bezier handles
 *      declare `shape: "triangle"`, which predates the bank; the renderer resolves
 *      glyph ?? shape through the SAME lookup, so the two spellings cannot grow two
 *      pictures. If "triangle" ever left the bank, that resolution would throw at
 *      runtime on a real widget.
 *
 * Bare-node, no DOM — core/ is DOM-free by contract.
 */

import assert from "node:assert/strict";
import { HANDLE_GLYPHS, handleGlyph, isHandleGlyph } from "../core/handle_glyphs.js";
import { nodeModifierPoints } from "../core/derive.js";
import { paintModifierPoints } from "../core/paint_handles.js";

const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

/** A minimal render node whose plugin returns exactly `rows` from modifierPoints. */
function nodeWithRows(rows) {
  return { world: IDENTITY_WORLD, state: {}, plugin: { modifierPoints: () => rows } };
}

/** A gradient-filled square, the state both gradient beads derive from. */
function gradientState(key = "fill") {
  return { w: 100, h: 100, [key]: { type: "linearGradient", linear: { stops: [], angle: 0 } } };
}

// ── 1. THE DEFAULT IS THE OLD LOOK ──────────────────────────────────────────
{
  const absent = handleGlyph();
  const named = handleGlyph("default");
  assert.deepEqual(absent, { shape: "square", mark: "none", accent: "default" }, "an absent glyph must be the plain square every handle drew before the bank");
  assert.deepEqual(named, absent, '"default" and an absent key must be the same look, or the two spellings could drift');
  assert.deepEqual(handleGlyph(null), absent, "an explicit null (what derive supplies for a row that declares nothing) is also the default");
}

// ── 2. AN UNKNOWN KEY THROWS ────────────────────────────────────────────────
{
  assert.throws(() => handleGlyph("nope"), /unknown handle glyph/, "an unrecognized glyph must throw, not silently draw the default");
  // The message must name the vocabulary, because the fix for this error is
  // always "pick a real key" and the reader should not have to open the bank.
  let msg = "";
  try { handleGlyph("boxedo"); } catch (e) { msg = e.message; }
  assert.match(msg, /boxedO/, "the error must list the real keys so a near-miss typo is self-correcting");
  assert.equal(isHandleGlyph("nope"), false, "isHandleGlyph is the ASK form of the same question");
  assert.equal(isHandleGlyph(undefined), true, "absent is a legal glyph (it means the default)");
  for (const key of Object.keys(HANDLE_GLYPHS)) {
    assert.doesNotThrow(() => handleGlyph(key), `every key in the bank must resolve — ${key} did not`);
    assert.ok(HANDLE_GLYPHS[key].description, `${key} must document what role it is for; the bank is read by whoever picks the next glyph`);
  }
}

// ── 3. PASSTHROUGH IS VERBATIM AND DEFAULTS TO NULL ─────────────────────────
{
  const bare = nodeModifierPoints(nodeWithRows([{ id: "a", x: 1, y: 2 }]))[0];
  assert.equal(bare.glyph, null, "a row declaring no glyph must arrive as null, so consumers may read it unconditionally");
  assert.equal(bare.label, null, "likewise the label — absent means no tooltip, which is every handle predating this");

  const declared = nodeModifierPoints(nodeWithRows([{ id: "g", x: 0, y: 0, glyph: "boxedO", label: "Gradient centre" }]))[0];
  assert.equal(declared.glyph, "boxedO", "the glyph KEY passes through uninterpreted — core names the vocabulary, web draws it");
  assert.equal(declared.label, "Gradient centre", "the label passes through verbatim; derive does not word-smith it");

  // The wrap is still the wrap: identity fields must not disturb the geometry.
  const moved = nodeModifierPoints({ world: { x: 5, y: 0, rotation: 0, scale: 1 }, state: {}, plugin: { modifierPoints: () => [{ id: "g", x: 1, y: 2, glyph: "circle", label: "Free point" }] } })[0];
  assert.deepEqual([moved.x, moved.y], [6, 2], "adding identity fields must not change where a handle lands");
}

// ── 4. THE GRADIENT BEADS ARE IDENTIFIED ────────────────────────────────────
{
  const beads = paintModifierPoints(gradientState(), "fill");
  assert.equal(beads.length, 2, "a linear gradient contributes a centre bead and a direction bead");
  for (const b of beads) {
    assert.equal(b.glyph, "boxedO", "both gradient beads wear the PAINT family's glyph — the user's own pick, and the thing that separates them from the widget's vertex handles");
    assert.ok(b.label, "a gradient bead must carry a label; being unlabelled is the state this feature exists to end");
  }
  assert.notEqual(beads[0].label, beads[1].label, "the two beads must not read the same, or the tooltip answers nothing");
  assert.match(beads[1].label, /angle/i, "the direction bead's label must state the angle it writes (6a4249e made it a free polar handle)");
  assert.match(beads[1].label, /wavelength/i, "…and the wavelength, the other parameter that same drag writes");

  // A shape may carry gradients on BOTH paints; the two centre beads sit on the
  // same widget and would otherwise show an identical tooltip.
  const strokeBeads = paintModifierPoints(gradientState("stroke"), "stroke");
  assert.notEqual(strokeBeads[0].label, beads[0].label, "fill's and stroke's centre beads must be distinguishable by their labels");

  // A radial gradient's single bead is identified too.
  const radial = paintModifierPoints({ w: 100, h: 100, fill: { type: "radialGradient", radial: { stops: [], center: { x: 0.5, y: 0.5 }, r: 0.5 } } }, "fill");
  assert.equal(radial.length, 1, "a radial gradient contributes only a centre bead");
  assert.equal(radial[0].glyph, "boxedO", "the radial centre bead is the same paint family");
  assert.ok(radial[0].label, "and is labelled");

  // The PAINT accent is what says "different subsystem" — assert it, since a bank
  // edit that re-based boxedO onto the default accent would silently undo the fix.
  assert.equal(handleGlyph("boxedO").accent, "paint", "the gradient family must NOT wear the widget-geometry accent");
  assert.notEqual(handleGlyph("boxedO").accent, handleGlyph().accent, "…and must differ from the default handle's accent, which is the whole signal");
  assert.equal(handleGlyph("boxedO").shape, "square", "boxedO keeps the square footprint so the grab target and muscle memory are unchanged");
  assert.equal(handleGlyph("boxedO").mark, "o", "…with the O that makes it unmistakably not a vertex handle");
}

// ── 5. THE LEGACY `shape` SPELLING IS A BANK KEY ────────────────────────────
{
  // web/CanvasView resolves `glyph ?? shape` through handleGlyph, so paint_path's
  // long-standing `shape: "triangle"` must be a live key or the app throws on a
  // real widget's handles.
  assert.equal(isHandleGlyph("triangle"), true, 'paint_path declares shape: "triangle"; removing that key from the bank would break its handles');
  assert.equal(handleGlyph("triangle").shape, "triangle", "and it must still draw a triangle");
  assert.equal(handleGlyph("triangle").accent, "default", "a bezier control point belongs to the WIDGET, not to a paint — it keeps the default accent");
}

console.log("handle_glyphs_test: OK");
