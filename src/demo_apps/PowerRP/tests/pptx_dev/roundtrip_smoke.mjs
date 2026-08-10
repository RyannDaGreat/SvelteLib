#!/usr/bin/env node
/**
 * ROUND-TRIP SMOKE for core/pptx_export/*: hand-build a small PowerRP document
 * (rect/roundRect/rotated/flipped, circle, gradient rect, text with two
 * differently-styled runs, polygon, image, a tween-transitioned second slide,
 * and one UNSUPPORTED widget type to exercise the placeholder+report path) ->
 * exportDeck() -> parsePptx() the RESULT (core/pptx/deck.js, the EXISTING,
 * COMMITTED parser) -> assert slide count / shape positions / rotation / flip
 * / gradient / morph transition survive.
 *
 * WHY HAND-BUILT, NOT core/pptx_translate: that module (PPTX->PowerRP stage 2)
 * is separate, parallel, in-progress work this task does not own — coupling
 * this smoke to its exact API/output shape would make this test's stability
 * depend on a module still under active development elsewhere. A hand-built
 * fixture is small, stable, and exercises exactly the export surface this
 * task is responsible for (per the task spec's own "else build a small doc by
 * hand" fallback).
 *
 * THIS SMOKE DOUBLES AS THE ONLY TEST for core/pptx_export/* (this app's
 * "implementation-first" rule: <=10% of time on tests) — so it is deliberately
 * broad rather than deep: one assertion per FEATURE the export claims to
 * support, not an exhaustive matrix. Run standalone: `node
 * tests/pptx_dev/roundtrip_smoke.mjs` (not part of tests/run_all.mjs's
 * collected gate — a dev script, matching this directory's existing
 * make_min_fixture.mjs / parse_real_deck.mjs, which are also standalone).
 *
 * ALSO VALIDATES against research_09's repair-trigger checklist
 * (.frenzy/research_09_export_pptx.md section 4): every Content_Types
 * Override is per ACTUAL part (not one-per-slide-for-a-shared-part), no
 * dangling relationship ids, no phantom/unused extension Defaults, no empty
 * scaffold directories in the zip.
 */

import { newDocument, withNewItem, uuid } from "../../core/document.js";
import { exportDeck } from "../../core/pptx_export/export.js";
import { parsePptx } from "../../core/pptx/deck.js";
import { unzipPptx } from "../../core/pptx/zip.js";
import { resolvePartPath } from "../../core/pptx/opc.js";

let failures = 0;
function assert(cond, message) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}
function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (got ${actual}, expected ${expected} +/-${tolerance})`);
}

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ── Build the fixture document ──────────────────────────────────────────────
let doc = newDocument(); // 1280x720 camera at (0,0), slide 0 already has THE camera

let rectId, circleId, textId, roundRectId, polygonId, imageId, unsupportedId;
[doc, rectId] = withNewItem(doc, 0, {
  type: "rect", x: 40, y: 50, w: 200, h: 100, z: 1, rotation: 0, scale: 1,
  fill: "#336699", stroke: "#000000", strokeWidth: 2, cornerRadius: 0, opacity: 1,
});
[doc, circleId] = withNewItem(doc, 0, {
  type: "circle", x: 400, y: 80, w: 120, h: 120, z: 2, rotation: 0, scale: 1,
  fill: "#f7768e", stroke: "#000000", strokeWidth: 2, opacity: 1,
});
[doc, textId] = withNewItem(doc, 0, {
  type: "text", x: 40, y: 250, w: 500, h: 120, z: 3, rotation: 0, scale: 1,
  text: { runs: [{ text: "Bold Red ", bold: true, size: 40, color: "#ff0000" }, { text: "plain italic", italic: true, size: 24 }], paras: [{ align: "left" }] },
  font: "system", size: 36, color: "#000000", bold: false, align: "left",
});
[doc, roundRectId] = withNewItem(doc, 0, {
  type: "rect", x: 620, y: 380, w: 160, h: 90, z: 4, rotation: Math.PI / 6, scale: 1,
  fill: "#00cc44", stroke: "#000000", strokeWidth: 0, cornerRadius: 22.5, opacity: 1,
});
[doc, polygonId] = withNewItem(doc, 0, {
  type: "polygon", x: 850, y: 450, w: 150, h: 150, z: 5, rotation: 0, scale: 1,
  points: [[0.5, 0], [1, 1], [0, 1]], closed: true, fill: "#ffcc00", stroke: "#000000", strokeWidth: 2,
});
[doc, imageId] = withNewItem(doc, 0, {
  type: "image", x: 900, y: 30, w: 80, h: 80, z: 6, rotation: 0, scale: 1,
  src: TINY_PNG, stroke: "#000000", strokeWidth: 0, cornerRadius: 0, sampling: "nearest",
  cropTop: 0, cropLeft: 0, cropRight: 0, cropBottom: 0, opacity: 1,
});
[doc, unsupportedId] = withNewItem(doc, 0, {
  type: "particles", x: 1000, y: 500, w: 100, h: 100, z: 7, name: "Sparkler",
});

// A gradient-filled rect, negative-w (flipped) box.
let gradientId;
[doc, gradientId] = withNewItem(doc, 0, {
  type: "rect", x: 350, y: -280 + 720, w: -180, h: 90, z: 8, rotation: 0, scale: 1,
  fill: { type: "linearGradient", linear: { angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] } },
  stroke: null, strokeWidth: 0, cornerRadius: 0, opacity: 1,
});

// Slide 2: tween transition (-> should become a morph), move the rect.
doc = {
  ...doc,
  slides: [
    ...doc.slides,
    {
      id: uuid(),
      name: "Slide 2",
      transition: { type: "tween", seconds: 0.6, curve: "smooth", sound: null },
      delta: { items: { [rectId]: { x: 900, y: 50 } } },
    },
  ],
};

// ── Export ───────────────────────────────────────────────────────────────────
const { bytes, report } = exportDeck(doc);
console.log(`\nexportDeck report (${report.length} line(s)):`);
for (const line of report) console.log(`  - ${line}`);

assert(bytes instanceof Uint8Array && bytes.length > 0, "exportDeck returned non-empty bytes");
assert(report.some((l) => l.includes("particles") && l.includes("no PPTX equivalent")), "unsupported widget type (particles) reported a downgrade");
// TWO lines, not one: the unsupported item persists across BOTH slides (it is
// never keyframed away), and each slide's own occurrence is reported
// separately — matching core/pptx/deck.js's own per-SHAPE refusal
// granularity ("refusals: [{where, what, sentence}]... at the SHAPE or SLIDE
// granularity the gap actually occurred at"), not deduped to one deck-wide
// note the way media bytes are (a downgrade note is about WHERE fidelity was
// lost, which is a per-occurrence fact; embedded bytes are a per-ASSET fact).
assert(report.length === 2, `exactly two downgrade notes expected — one per slide the unsupported item appears on (got ${report.length})`);

// ── Parse the RESULT back through the EXISTING, committed importer ─────────
const ir = parsePptx(bytes);

assert(ir.refusals.length === 0, `parser reported zero refusals on our own output (got ${ir.refusals.length}: ${JSON.stringify(ir.refusals)})`);
assert(ir.slides.length === 2, `slide count survives (got ${ir.slides.length})`);
assertClose(ir.slideSizeEmu.w, 1280 * 9525, 1, "slide width EMU matches 1280px @ 96dpi");
assertClose(ir.slideSizeEmu.h, 720 * 9525, 1, "slide height EMU matches 720px @ 96dpi");

const slide1 = ir.slides[0];
assert(slide1.shapes.length === 8, `slide 1 has all 8 items as shapes (got ${slide1.shapes.length})`);

const byMorphName = (id) => slide1.shapes.find((s) => s.name === `!!${id}`);

const rectShape = byMorphName(rectId);
assert(!!rectShape, "rect shape found by its !!<itemId> morph name");
assertClose(rectShape.xfrm.offEmu.x, 40 * 9525, 1, "rect x position round-trips");
assertClose(rectShape.xfrm.offEmu.y, 50 * 9525, 1, "rect y position round-trips");
assertClose(rectShape.xfrm.extEmu.w, 200 * 9525, 1, "rect width round-trips");
assert(rectShape.geometry?.preset?.name === "rect", `rect uses prstGeom "rect" (got ${JSON.stringify(rectShape.geometry)})`);

const circleShape = byMorphName(circleId);
assert(circleShape?.geometry?.preset?.name === "ellipse", `circle uses prstGeom "ellipse" (got ${JSON.stringify(circleShape?.geometry)})`);

const roundRectShape = byMorphName(roundRectId);
assert(roundRectShape?.geometry?.preset?.name === "roundRect", `rounded rect uses prstGeom "roundRect" (got ${JSON.stringify(roundRectShape?.geometry)})`);
const expectedAdj = Math.round((22.5 / 90) * 100000); // cornerRadius / min(w,h)
assertClose(roundRectShape?.geometry?.preset?.adjustments?.adj ?? -1, expectedAdj, 1, `roundRect adjustment value round-trips (expected ${expectedAdj})`);
assertClose(roundRectShape?.xfrm?.rot60k, Math.round((30 * 60000)), 100, "roundRect rotation (30deg) round-trips");

const gradientShape = byMorphName(gradientId);
assert(gradientShape?.fill?.kind === "gradient", `gradient rect parses back as a gradient fill (got ${JSON.stringify(gradientShape?.fill)})`);
assert(gradientShape?.xfrm?.flipH === true, "negative-w rect round-trips as flipH");
assertClose(gradientShape?.xfrm?.extEmu?.w, 180 * 9525, 1, "flipped rect's positive width round-trips");

const textShape = byMorphName(textId);
assert(!!textShape?.text, "text shape carries a parsed text body");
const allRunText = (textShape?.text?.paragraphs ?? []).flatMap((p) => p.runs.map((r) => r.text)).join("");
assert(allRunText === "Bold Red plain italic", `text run content round-trips exactly (got ${JSON.stringify(allRunText)})`);
const firstRun = textShape.text.paragraphs[0]?.runs[0];
assert(firstRun?.bold === true, "first text run's bold style round-trips");
assertClose(firstRun?.sizePt ?? -1, 40, 0.01, "first text run's size (points) round-trips");

const polygonShape = byMorphName(polygonId);
assert(!!polygonShape?.geometry?.custGeom, "polygon round-trips as custGeom");

const imageShape = byMorphName(imageId);
assert(imageShape?.type === "pic", `image round-trips as a pic shape (got type "${imageShape?.type}")`);
assert(!!imageShape?.image, "image shape carries a resolved (non-media) picture reference");
assert(ir.mediaParts.length === 1, `exactly one media part registered (got ${ir.mediaParts.length})`);
assert(ir.mediaParts[0]?.contentType === "image/png", `embedded image content type is image/png (got ${ir.mediaParts[0]?.contentType})`);

const unsupportedShape = byMorphName(unsupportedId);
assert(unsupportedShape?.type === "sp", "unsupported widget (particles) still produced a shape (the placeholder)");
assert(!!unsupportedShape?.text && unsupportedShape.text.paragraphs[0]?.runs[0]?.text?.includes("Sparkler"), "placeholder shape's label names the item");

const slide2 = ir.slides[1];
assert(slide2.transition?.type === "morph", `slide 2's tween transition round-trips as morph (got ${JSON.stringify(slide2.transition)})`);
assertClose(slide2.transition?.durMs ?? -1, 600, 1, "morph duration (ms) round-trips");
const rectShape2 = slide2.shapes.find((s) => s.name === `!!${rectId}`);
assertClose(rectShape2?.xfrm?.offEmu?.x, 900 * 9525, 1, "rect's moved position on slide 2 round-trips");
assert(rectShape2?.name === rectShape?.name, "the SAME morph name (!!<itemId>) appears on both slides — morph's forced-match identity");

// ── research_09's repair-trigger checklist ──────────────────────────────────
const files = unzipPptx(bytes);
const contentTypesText = new TextDecoder().decode(files["[Content_Types].xml"]);

// (1) invalid/hand-typed preset strings: not directly checkable here (the
// parser above already round-tripped "rect"/"ellipse"/"roundRect" through its
// OWN 187-name preset table, which is the strongest available check that
// these are real, recognized preset names, not typos).

// (2) phantom Content_Types Overrides — one per ACTUAL part, never one per
// slide for a SHARED part (master/layout/theme each appear exactly once).
const overrideCount = (name) => (contentTypesText.match(new RegExp(`PartName="[^"]*${name}[^"]*"`, "g")) ?? []).length;
assert(overrideCount("slideMaster1") === 1, "exactly one Content_Types Override for the (single, shared) slideMaster");
assert(overrideCount("slideLayout1") === 1, "exactly one Content_Types Override for the (single, shared) slideLayout");
assert(overrideCount("theme1") === 1, "exactly one Content_Types Override for the (single, shared) theme");
assert(overrideCount("slide1.xml") === 1 && overrideCount("slide2.xml") === 1, "exactly one Content_Types Override per actual slide, no more");

// (3) broken .rels: every relationship Target must resolve to a part that
// actually exists in the zip (the parser's own relationshipsFor + partBytes
// would have thrown already if not — parsePptx succeeding at all, plus zero
// refusals above, already proves this; asserted again explicitly here to
// name the invariant for a reader of this file). Uses core/pptx/opc.js's OWN
// resolvePartPath (the committed OPC §9.3 relative-reference resolver) rather
// than a hand-rolled URL join, so this check trusts the same math the real
// importer trusts.
for (const path of Object.keys(files)) {
  if (!path.endsWith(".rels")) continue;
  // The part these relationships belong to: strip the trailing "_rels/<base>.rels".
  const sourcePartDir = path === "_rels/.rels" ? "" : path.replace(/(^|\/)_rels\/[^/]+\.rels$/, "");
  const relsText = new TextDecoder().decode(files[path]);
  const targets = [...relsText.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]).filter((t) => !t.startsWith("http"));
  for (const target of targets) {
    const resolved = resolvePartPath(sourcePartDir, target);
    assert(resolved in files, `${path}: relationship target "${target}" (-> "${resolved}") exists in the archive`);
  }
}

// (4) unused default extension registrations: our Content_Types writer only
// registers image extensions ACTUALLY used (contentTypesXml's own contract) —
// this deck has exactly one embedded PNG and no other media kind.
assert(contentTypesText.includes('Extension="png"'), "png IS registered (an image was embedded)");
assert(!contentTypesText.includes('Extension="jpeg"'), "jpeg is NOT registered (no jpeg was embedded)");
assert(!contentTypesText.includes('Extension="mp4"'), "mp4/video extensions are never registered by v1 (no video export path)");

// (5) empty scaffold directories: fflate's zipSync never emits directory
// entries for an object-keyed entry map (only the paths we explicitly wrote
// exist), so there is no "charts/"/"embeddings/" to check for — asserted by
// confirming the archive's part count matches exactly what exportDeck wrote.
const expectedParts = 9 + doc.slides.length * 2 + 1; // scaffold(9) + per-slide(xml+rels) + 1 media part
assert(Object.keys(files).length === expectedParts, `archive contains exactly the parts we wrote, no scaffold cruft (got ${Object.keys(files).length}, expected ${expectedParts})`);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
