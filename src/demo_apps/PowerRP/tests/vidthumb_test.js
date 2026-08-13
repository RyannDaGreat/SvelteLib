/**
 * VIDEO THUMBNAIL (POSTER FRAME) — bare-node tests for the optional `thumbnail`
 * image + `showThumbnail` toggle on plugins/video.js, and for carrying a PPTX
 * poster frame through the importer onto that property.
 *
 * Run: node src/demo_apps/PowerRP/tests/vidthumb_test.js
 *
 * THE USER'S ASK, which is what these assertions are measured against: "for
 * powerpoint, they have thumbnail files for their videos to be shown before
 * playing. Right now, we have no concept of that. To faithfully translate videos
 * from pptx to ours, we have to have an optional thumbnail parameter on videos -
 * that has a toggle between whether we show the thumbnail image or show the
 * video".
 *
 * THREE CLAIMS, and the first is the one that could silently break every existing
 * deck rather than merely fail to add a feature:
 *   1. ABSENT IS BYTE-IDENTICAL. A video written before this property existed
 *      must render the same ops and survive load-repair unchanged. This is not a
 *      "the defaults look right" check — it walks the real repair pipeline,
 *      because the hazard lives there: `withMissingDefaultsFilled` writes a
 *      `null` leaf, which is the DELETE SENTINEL, and the question is whether
 *      that folds back to absent (fine) or reports forever (the defect the
 *      `coveredByNull` gate in core/document.js was written for).
 *   2. THE TOGGLE ACTUALLY SWITCHES WHAT IS DRAWN — an `image` op vs a `video`
 *      op, over the SAME rect. Asserted on op KINDS and on geometry, because a
 *      poster drawn at a different size than the clip it replaces is the exact
 *      wrongness "same fit/crop semantics" is supposed to rule out.
 *   3. THE IMPORTER POPULATES IT. Against a SYNTHETIC deck built here rather than
 *      a captured one: the committed fixture (tests/fixtures/pptx/minimal.pptx)
 *      carries NO video — measured, its only media part is image1.png — so there
 *      was nothing to assert against. The synthetic deck REUSES that fixture's
 *      own master/layout/theme/presentation parts and rewrites only slide1, so
 *      what is fabricated is exactly the shape under test (a `p:pic` that is a
 *      video with a poster blip) and everything around it is real.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { parsePptx } from "../core/pptx/deck.js";
import { installPresetDefs } from "../core/pptx/preset_geometry.js";
import { unzipPptx } from "../core/pptx/zip.js";
import { translateDeck } from "../core/pptx_translate/translate.js";
import { videoState } from "../core/pptx_translate/media.js";
import { videoPlugin } from "../plugins/video.js";
import { hasThumbnail } from "../core/properties.js";
import { repairedDocument, foldState } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "pptx", "minimal.pptx");
const PRESET_DEFS_PATH = join(__dirname, "..", "core", "pptx", "preset_shape_defs.json");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

installPresetDefs(JSON.parse(readFileSync(PRESET_DEFS_PATH, "utf8")).shapes);

const registry = createRegistry();
registerAll(registry, createCommands());

/** The identity affine — emit()'s `world` argument for an untransformed widget. */
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Query (pure given the plugin). The op kinds one state emits, in order. */
function opKinds(state) {
  return videoPlugin.emit(state, IDENTITY, IDENTITY).map((o) => o.op);
}

/** A sourced video with the plugin's own defaults — the base every case varies. */
const SOURCED = { ...videoPlugin.defaults, src: "/asset/Deck/clip.mp4" };
const POSTER = "/asset/Deck/poster.png";

// ── 1. ABSENT IS BYTE-IDENTICAL ──────────────────────────────────────────────

test("the two new properties default to OFF: thumbnail null, showThumbnail false", () => {
  assert.equal(videoPlugin.defaults.thumbnail, null);
  assert.equal(videoPlugin.defaults.showThumbnail, false);
});

test("a video with NO thumbnail key emits byte-identically to one holding the filled defaults", () => {
  // The two populations that must agree: a document written before the property
  // existed (key absent), and the same document after the load-time defaults fill
  // wrote the plugin's own default over it.
  const legacy = { ...SOURCED };
  delete legacy.thumbnail;
  delete legacy.showThumbnail;
  const filled = { ...SOURCED, thumbnail: null, showThumbnail: false };
  assert.equal(
    JSON.stringify(videoPlugin.emit(legacy, IDENTITY, IDENTITY)),
    JSON.stringify(videoPlugin.emit(filled, IDENTITY, IDENTITY)),
    "a pre-poster video must render exactly what it rendered before the property existed");
});

test("a legacy video document survives repair with NO poster report, and repair is idempotent", () => {
  // THE REAL PIPELINE, not the plugin in isolation — see this file's header for
  // why: the null default is written by the fill, and a null leaf is the delete
  // sentinel. If that combination ever stops settling, this is where it shows.
  const doc = {
    meta: { name: "legacy" },
    slides: [{
      id: "s0", name: "One",
      transition: { type: "none", seconds: 0, curve: "linear", sound: null },
      delta: { items: { v: { type: "video", x: 10, y: 20, w: 320, h: 180, z: 0, rotation: 0, scale: 1, src: "/asset/Deck/clip.mp4" } } },
    }],
  };
  const first = repairedDocument(doc, registry);
  const posterNoise = first.reports.filter((r) => /thumbnail|poster/i.test(r));
  assert.deepEqual(posterNoise, [], "adding an optional poster must not make every pre-poster deck report on load");

  const second = repairedDocument(first.doc, registry);
  assert.deepEqual(second.reports, [], "second repair pass must report nothing (idempotence)");
  assert.equal(JSON.stringify(first.doc), JSON.stringify(second.doc), "repair must reach a fixed point");
});

test("the filled `thumbnail: null` folds back to ABSENT, so emit sees exactly what it saw before", () => {
  // This is the mechanism claim underneath the byte-identity one, pinned on its
  // own so a change to delta semantics fails HERE with a readable reason rather
  // than as a mysterious rendering difference.
  const doc = {
    meta: { name: "folded" },
    slides: [{
      id: "s0", name: "One",
      transition: { type: "none", seconds: 0, curve: "linear", sound: null },
      delta: { items: { v: { type: "video", x: 0, y: 0, w: 320, h: 180, z: 0, rotation: 0, scale: 1, src: "/asset/Deck/clip.mp4", thumbnail: null, showThumbnail: false } } },
    }],
  };
  const state = foldState(doc, 0).items.v;
  assert.equal("thumbnail" in state, false, "a null leaf is the delete sentinel — it must fold to an absent key");
  assert.equal(hasThumbnail(state), false);
  assert.deepEqual(opKinds({ ...videoPlugin.defaults, ...state }), ["video"]);
});

// ── 2. THE TOGGLE SWITCHES WHAT IS DRAWN ─────────────────────────────────────

test("toggle OFF with a thumbnail set still draws the VIDEO (attaching a poster changes nothing on its own)", () => {
  assert.deepEqual(opKinds({ ...SOURCED, thumbnail: POSTER }), ["video"]);
  assert.deepEqual(opKinds({ ...SOURCED, thumbnail: POSTER, showThumbnail: false }), ["video"]);
});

test("toggle ON with a thumbnail set draws the THUMBNAIL as an ordinary image op", () => {
  const ops = videoPlugin.emit({ ...SOURCED, thumbnail: POSTER, showThumbnail: true }, IDENTITY, IDENTITY);
  assert.deepEqual(ops.map((o) => o.op), ["image"]);
  assert.equal(ops[0].ref, POSTER, "the image op must reference the THUMBNAIL, not the clip");
});

test("toggle ON with NO thumbnail falls back to the video — a toggle with nothing to show is not a blank widget", () => {
  assert.deepEqual(opKinds({ ...SOURCED, showThumbnail: true }), ["video"]);
  assert.deepEqual(opKinds({ ...SOURCED, showThumbnail: true, thumbnail: null }), ["video"]);
  assert.deepEqual(opKinds({ ...SOURCED, showThumbnail: true, thumbnail: "" }), ["video"]);
});

test("a poster-showing widget with NO src still draws — the source gate reads whichever source is displayed", () => {
  // A PPTX import can legitimately produce this while a linked clip is missing;
  // gating on `src` would blank a widget that has a perfectly good picture.
  assert.deepEqual(opKinds({ ...SOURCED, src: "", thumbnail: POSTER, showThumbnail: true }), ["image"]);
});

test("the poster occupies the SAME rect as the clip it replaces (same fit/crop semantics)", () => {
  const geom = (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, opacity: o.opacity, src: o.src });
  const asVideo = videoPlugin.emit({ ...SOURCED, thumbnail: POSTER }, IDENTITY, IDENTITY)[0];
  const asImage = videoPlugin.emit({ ...SOURCED, thumbnail: POSTER, showThumbnail: true }, IDENTITY, IDENTITY)[0];
  assert.deepEqual(geom(asImage), geom(asVideo), "swapping to the poster must not move or resize the widget's ink");
});

test("edge-crop insets apply to the poster exactly as they do to the clip", () => {
  // Insets are WORLD UNITS (px), not fractions — cropInsetsToSource clamps them
  // against w/h. The widget is 320x180, so these trim a visible quarter.
  const cropped = { ...SOURCED, thumbnail: POSTER, cropLeft: 80, cropTop: 18 };
  const geom = (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, src: o.src });
  const asVideo = videoPlugin.emit(cropped, IDENTITY, IDENTITY)[0];
  const asImage = videoPlugin.emit({ ...cropped, showThumbnail: true }, IDENTITY, IDENTITY)[0];
  assert.deepEqual(geom(asImage), geom(asVideo));
  assert.equal(asImage.w, SOURCED.w - 80, "the crop must actually have shrunk the quad (else this proves nothing)");
  assert.equal(asImage.src.sw, (SOURCED.w - 80) / SOURCED.w, "and contracted the SOURCE rect to match — a crop, not a stretch");
});

test("a fully cropped-away poster draws nothing, same as the clip", () => {
  const gone = { ...SOURCED, thumbnail: POSTER, cropLeft: SOURCED.w, cropTop: SOURCED.h };
  assert.deepEqual(opKinds({ ...gone, showThumbnail: true }), []);
  assert.deepEqual(opKinds(gone), [], "the video branch agrees — the gate is shared, not duplicated per branch");
});

// ── the Inspector surfacing ──────────────────────────────────────────────────

test("both rows are on the video widget, and the toggle is hidden until a thumbnail exists", () => {
  const rows = new Map(videoPlugin.inspector.filter((r) => r?.key).map((r) => [r.key, r]));
  assert.ok(rows.has("thumbnail"), "the video widget must carry a `thumbnail` row");
  assert.ok(rows.has("showThumbnail"), "the video widget must carry a `showThumbnail` row");
  assert.equal(rows.get("thumbnail").nullable, true, "the poster row must be clearable — an absent poster is nothing, not \"\"");
  assert.deepEqual(rows.get("thumbnail").assetKinds, ["image"], "a poster is an IMAGE asset");

  const visibleWhen = rows.get("showThumbnail").visibleWhen;
  assert.equal(typeof visibleWhen, "function", "the toggle must declare a visibility gate");
  assert.equal(visibleWhen({}), false, "no thumbnail → no toggle (nothing to choose between)");
  assert.equal(visibleWhen({ thumbnail: null }), false);
  assert.equal(visibleWhen({ thumbnail: POSTER }), true);
});

// ── 3. THE PPTX IMPORTER CARRIES THE POSTER ──────────────────────────────────

test("videoState omits `thumbnail` entirely when there is no poster, and sets it when there is", () => {
  const noPoster = videoState("Deck", "clip.mp4", { loop: true, mute: false, autoplay: false });
  assert.equal("thumbnail" in noPoster, false, "absence is spelled by OMISSION so a posterless import is unchanged");
  const withPoster = videoState("Deck", "clip.mp4", { loop: true, mute: false, autoplay: false }, "poster.png");
  assert.equal(withPoster.thumbnail, "/asset/Deck/poster.png");
  assert.equal(withPoster.src, "/asset/Deck/clip.mp4");
});

/**
 * Pure function. A `p:pic` that IS a video: the media-ness comes from
 * `<a:videoFile>` in `<p:nvPr>` (plus the PPT2010 `p14:media` sibling that real
 * decks all carry), while its `<p:blipFill>` is the POSTER FRAME — the structural
 * fact this whole feature translates (core/pptx/media.js's header).
 */
function videoPicXml({ videoRId, mediaRId, posterRId }) {
  return `<p:pic>
<p:nvPicPr><p:cNvPr id="7" name="Clip With Poster"/><p:cNvPicPr/><p:nvPr>
<a:videoFile r:link="${videoRId}"/>
<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${mediaRId}"/></p:ext></p:extLst>
</p:nvPr></p:nvPicPr>
<p:blipFill><a:blip r:embed="${posterRId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="2743200" cy="1543050"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>`;
}

/**
 * Query. A synthetic single-slide .pptx carrying one video with a poster frame,
 * built by REUSING the committed fixture's real master/layout/theme parts (see
 * this file's header) and replacing slide1 + its rels + the content types.
 *
 * Returns:
 *   Uint8Array — .pptx bytes, parseable by core/pptx/deck.parsePptx
 */
function syntheticVideoDeckBytes() {
  const files = unzipPptx(new Uint8Array(readFileSync(FIXTURE_PATH)));
  const enc = new TextEncoder();

  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${videoPicXml({ videoRId: "rId2", mediaRId: "rId3", posterRId: "rId1" })}
</p:spTree></p:cSld>
<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sld>`;

  // THE DUAL-RELATIONSHIP PATTERN (core/pptx/media.js): rId2 typed "video" and
  // rId3 typed "media" name the SAME target — that is what a real PowerPoint
  // write produces, and the parser refuses if they disagree, so a synthetic deck
  // that got this wrong would fail loudly rather than pass vacuously.
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/clip1.mp4"/>
<Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/clip1.mp4"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="mp4" ContentType="video/mp4"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;

  // presentation.xml lists three slides in the fixture; this deck has one, so its
  // sldIdLst and rels are rewritten to match (a dangling slide reference would be
  // a parse refusal about the DECK, masking what is under test).
  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rIdS1"/></p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;

  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`;

  const entries = {
    "[Content_Types].xml": enc.encode(contentTypes),
    "_rels/.rels": files["_rels/.rels"],
    "ppt/presentation.xml": enc.encode(presentationXml),
    "ppt/_rels/presentation.xml.rels": enc.encode(presentationRels),
    "ppt/theme/theme1.xml": files["ppt/theme/theme1.xml"],
    "ppt/slideMasters/slideMaster1.xml": files["ppt/slideMasters/slideMaster1.xml"],
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": files["ppt/slideMasters/_rels/slideMaster1.xml.rels"],
    "ppt/slideLayouts/slideLayout1.xml": files["ppt/slideLayouts/slideLayout1.xml"],
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"],
    "ppt/slides/slide1.xml": enc.encode(slideXml),
    "ppt/slides/_rels/slide1.xml.rels": enc.encode(relsXml),
    "ppt/media/image1.png": files["ppt/media/image1.png"], // the POSTER
    "ppt/media/clip1.mp4": enc.encode("not a real mp4 — the translator never decodes it, it only names the asset"),
  };
  return zipSync(entries, { level: 0 });
}

const videoDeckIR = parsePptx(syntheticVideoDeckBytes());

test("the parser reads the video's poster blip as `media.posterRel`", () => {
  const shapes = videoDeckIR.slides[0].shapes;
  const vid = shapes.find((s) => s.media?.kind === "video");
  assert.ok(vid, `expected one video shape, got kinds ${JSON.stringify(shapes.map((s) => s.kind ?? s.media?.kind))}`);
  assert.equal(vid.media.relTarget, "ppt/media/clip1.mp4");
  assert.equal(vid.media.posterRel, "ppt/media/image1.png", "the p:pic's blipFill IS the poster frame");
});

test("the TRANSLATOR lands that poster on the video item's `thumbnail`", () => {
  const out = translateDeck(videoDeckIR, { name: "Deck" });
  const items = out.doc.slides[0].delta.items;
  const video = Object.values(items).find((it) => it.type === "video");
  assert.ok(video, `expected a translated video item, got types ${JSON.stringify(Object.values(items).map((i) => i.type))}`);
  assert.equal(video.src, "/asset/Deck/clip1.mp4");
  assert.equal(video.thumbnail, "/asset/Deck/image1.png", "the poster must be wired to the thumbnail property");
  // CLICK-TO-PLAY, so the poster is AVAILABLE and not imposed — see
  // core/pptx_translate/media.js's header for why this default is what it is.
  assert.notEqual(video.showThumbnail, true, "an imported deck must keep showing the video, not silently swap to the still");
});

test("the poster's BYTES are exported as an asset, so the thumbnail reference resolves", () => {
  const out = translateDeck(videoDeckIR, { name: "Deck" });
  const names = out.assets.map((a) => a.name ?? a.assetName ?? a);
  assert.ok(names.includes("image1.png"), `the poster must be written to assets/ (got ${JSON.stringify(names)})`);
  assert.ok(names.includes("clip1.mp4"), `the clip must be written to assets/ (got ${JSON.stringify(names)})`);
});

test("the importer no longer REFUSES the poster (the gap report is gone, replaced by real state)", () => {
  const out = translateDeck(videoDeckIR, { name: "Deck" });
  // `out.report.refusals`, NOT `out.refusals` — the latter is undefined, so a
  // regex over it would pass no matter what the translator said.
  const refusals = out.report.refusals;
  assert.ok(Array.isArray(refusals), "translateDeck must report through report.refusals");
  const posterRefusals = refusals.filter((r) => /poster/i.test(r));
  assert.deepEqual(posterRefusals, [], "the poster is now translated, so nothing may report it as dropped");
});

test("the translated deck passes repairedDocument with no thumbnail-related repair", () => {
  const out = translateDeck(videoDeckIR, { name: "Deck" });
  const { reports } = repairedDocument(out.doc, registry);
  const noise = reports.filter((r) => /thumbnail|poster/i.test(r));
  assert.deepEqual(noise, [], "an imported poster must be valid current-schema state, not something repair has to fix");
});

console.log(`\nvidthumb_test: ${passed} checks passed`);
