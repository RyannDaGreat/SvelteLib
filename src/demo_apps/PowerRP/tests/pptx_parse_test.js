/**
 * PPTX PARSER CORE — bare-node tests against the COMMITTED fixture
 * (tests/fixtures/pptx/minimal.pptx, built by tests/pptx_dev/make_min_fixture.mjs).
 * Run: node src/demo_apps/PowerRP/tests/pptx_parse_test.js
 *
 * This is the fixture half of the gate. tests/pptx_dev/parse_real_deck.mjs
 * (NOT part of this gate — a dev smoke script) is the other half, run by hand
 * against the real 108MB deck in .frenzy/, which is gitignored and cannot be
 * a committed fixture.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePptx } from "../core/pptx/deck.js";
import { parseXml, xmlText, xmlAttr } from "../core/pptx/xml.js";
import { decodeXmlEntities } from "../core/pptx/xml.js";
import { resolvePartPath, relsPathFor, contentTypeFor, parseContentTypes } from "../core/pptx/opc.js";
import { resolveThemeColor, resolveThemeFont, isThemeFontToken } from "../core/pptx/theme.js";
import { startsOnClick, classifyStepTrigger } from "../core/pptx/timing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "pptx", "minimal.pptx");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const fixtureBytes = new Uint8Array(readFileSync(FIXTURE_PATH));
const deck = parsePptx(fixtureBytes);

// ── xml.js: the parser itself, in isolation ─────────────────────────────────

test("xml.js resolves namespaces by URI, not prefix", () => {
  const root = parseXml('<a:sp xmlns:a="urn:x"><a:nv>1</a:nv></a:sp>');
  assert.equal(root.ns, "urn:x");
  assert.equal(root.local, "sp");
  assert.equal(xmlText(root.children[0]), "1");
});

test("xml.js handles xmlns=\"\" resetting the default namespace mid-document (the mc:Fallback trap)", () => {
  const root = parseXml('<a xmlns="urn:outer"><b xmlns=""><c/></b></a>');
  assert.equal(root.ns, "urn:outer");
  assert.equal(root.children[0].ns, null); // <b xmlns=""> has NO default namespace
  assert.equal(root.children[0].children[0].ns, null); // <c> inherits the reset
});

test("xml.js decodes entities and numeric character references", () => {
  assert.equal(decodeXmlEntities("a &amp; b &#39; &#x2013;"), "a & b ' –");
});

test("xml.js throws with line/column on malformed XML", () => {
  assert.throws(() => parseXml("<a><b></a>"), /mismatched close tag/);
  assert.throws(() => parseXml("<a>"), /unclosed element/);
  assert.throws(() => parseXml(""), /empty document/);
});

// ── opc.js: parts, content types, relationships ─────────────────────────────

test("opc.js resolves relative relationship targets against the source part's directory", () => {
  assert.equal(resolvePartPath("ppt/slides", "../media/media1.mp4"), "ppt/media/media1.mp4");
  assert.equal(resolvePartPath("", "/ppt/presentation.xml"), "ppt/presentation.xml");
  assert.throws(() => resolvePartPath("", "../escape.xml"));
});

test("opc.js derives the .rels sibling path per part, including the package root", () => {
  assert.equal(relsPathFor("ppt/slides/slide2.xml"), "ppt/slides/_rels/slide2.xml.rels");
  assert.equal(relsPathFor(""), "_rels/.rels");
});

test("opc.js content type: Override wins over Default", () => {
  const ct = parseContentTypes(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.x+xml"/></Types>',
  );
  assert.equal(contentTypeFor(ct, "ppt/presentation.xml"), "application/vnd.x+xml");
  assert.equal(contentTypeFor(ct, "ppt/other.xml"), "application/xml");
  assert.throws(() => contentTypeFor(ct, "ppt/media/video.mp4"), /no content type/);
});

// ── theme.js: color scheme, font scheme, +mj-lt/+mn-lt tokens ───────────────

test("theme.js resolves +mj-lt/+mn-lt tokens through the font scheme", () => {
  const fontScheme = { major: { latin: "Georgia", ea: "", cs: "" }, minor: { latin: "Verdana", ea: "", cs: "" } };
  assert.equal(resolveThemeFont("+mj-lt", fontScheme), "Georgia");
  assert.equal(resolveThemeFont("+mn-lt", fontScheme), "Verdana");
  assert.equal(resolveThemeFont("Literal Font", fontScheme), "Literal Font");
  assert.equal(isThemeFontToken("+mn-lt"), true);
  assert.equal(isThemeFontToken("Calibri"), false);
});

test("theme.js resolves a schemeClr slot through clrMap to a theme hex, keeping unimplemented transforms raw", () => {
  const colorMap = { bg1: "lt1" };
  const scheme = { lt1: "FFFFFF" };
  const { hex, transforms } = resolveThemeColor("bg1", colorMap, scheme);
  assert.equal(hex, "FFFFFF");
  assert.deepEqual(transforms, []);
});

// ── timing.js: the click-boundary classifier ────────────────────────────────

test("timing.js: a bare delay=indefinite condition means click-triggered", () => {
  const cTn = parseXml('<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>');
  assert.equal(startsOnClick(cTn), true);
  assert.equal(classifyStepTrigger(cTn), "click");
});

test("timing.js: a chained onBegin condition wins over a co-occurring bare indefinite (measured against the real deck's slide17)", () => {
  const cTn = parseXml(
    '<p:cTn xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:stCondLst><p:cond delay="indefinite"/>' +
      '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst></p:cTn>',
  );
  assert.equal(startsOnClick(cTn), false);
  assert.equal(classifyStepTrigger(cTn), "auto");
});

// ── deck.js: the full fixture, top to bottom ────────────────────────────────

test("DeckIR: slide size in raw EMU", () => {
  assert.deepEqual(deck.slideSizeEmu, { w: 12192000, h: 6858000 });
});

test("DeckIR: three slides, in AUTHORED order (sldIdLst), not r:id or filename order", () => {
  // The fixture's sldIdLst names r:id="rId9" (slide1.xml) then "rId2"
  // (slide2.xml) then "rId5" (slide3.xml) — deliberately non-sequential
  // r:ids, so this only passes if deck.js walks sldIdLst's OWN order.
  assert.equal(deck.slides.length, 3);
  assert.equal(deck.slides[0].shapes.some((s) => s.name === "Rect 1"), true);
  assert.equal(deck.slides[1].shapes.some((s) => s.name === "Circle 1"), true);
  assert.equal(deck.slides[2].shapes.some((s) => s.name === "Last Slide Marker"), true);
});

test("DeckIR: refusals are empty for a fixture built entirely from constructs this parser claims to handle", () => {
  assert.deepEqual(deck.refusals, []);
});

test("DeckIR slide 1: rectangle shape carries a resolved solid fill and line", () => {
  const rect = deck.slides[0].shapes.find((s) => s.name === "Rect 1");
  assert.equal(rect.type, "sp");
  assert.deepEqual(rect.geometry, { preset: { name: "rect", adjustments: {} } });
  assert.deepEqual(rect.fill, { kind: "solid", color: { kind: "srgb", hex: "336699" } });
  assert.equal(rect.line.widthEmu, 12700);
  assert.deepEqual(rect.xfrm.offEmu, { x: 457200, y: 457200 });
  assert.deepEqual(rect.xfrm.extEmu, { w: 2743200, h: 1371600 });
});

test("DeckIR slide 1: text box with two differently-styled runs resolves size/bold/italic/color/font independently per run", () => {
  const box = deck.slides[0].shapes.find((s) => s.name === "TextBox 2");
  const runs = box.text.paragraphs[0].runs;
  assert.equal(runs.length, 2);
  assert.deepEqual(
    { text: runs[0].text, sizePt: runs[0].sizePt, bold: runs[0].bold, italic: runs[0].italic, color: runs[0].color, font: runs[0].font },
    { text: "Bold Red Run", sizePt: 32, bold: true, italic: false, color: "CC0000", font: "Georgia" },
  );
  // Second run has NO direct rPr color/font — resolves through the chain to
  // otherStyle's tx1 (-> dk1 -> "000000") and the theme's minor font token.
  assert.deepEqual(
    { sizePt: runs[1].sizePt, bold: runs[1].bold, italic: runs[1].italic, color: runs[1].color, font: runs[1].font },
    { sizePt: 18, bold: false, italic: true, color: "000000", font: "Verdana" },
  );
});

test("DeckIR slide 1: a picture shape resolves its own image reference and registers it in mediaParts", () => {
  const pic = deck.slides[0].shapes.find((s) => s.name === "Picture 3");
  assert.equal(pic.type, "pic");
  assert.equal(pic.media, null);
  assert.deepEqual(pic.image, { relTarget: "ppt/media/image1.png", embedded: true });
  const part = deck.mediaParts.find((p) => p.path === "ppt/media/image1.png");
  assert.ok(part, "image1.png must be in mediaParts");
  assert.equal(part.contentType, "image/png");
  assert.ok(part.bytes instanceof Uint8Array && part.bytes.length > 0);
});

test("DeckIR slide 2: morph transition detected through mc:AlternateContent, with its option and duration", () => {
  const transition = deck.slides[1].transition;
  assert.deepEqual(transition, { type: "morph", durMs: 1500, morphOption: "byObject", advClick: true, advTmMs: null });
});

test("DeckIR slide 2: two click steps — plain clickEffect, then withEffect + afterEffect with the correct chained delay", () => {
  const steps = deck.slides[1].clickSteps;
  assert.equal(steps.length, 2);

  assert.equal(steps[0].trigger, "click");
  assert.equal(steps[0].effects.length, 1);
  assert.equal(steps[0].effects[0].shapeId, 2);
  assert.equal(steps[0].effects[0].presetClass, "entr");
  assert.equal(steps[0].effects[0].delayMs, 0);

  assert.equal(steps[1].trigger, "click");
  assert.equal(steps[1].effects.length, 2);
  const [withEntry, afterEntry] = steps[1].effects;
  assert.equal(withEntry.shapeId, 3);
  assert.equal(withEntry.presetClass, "entr");
  assert.equal(withEntry.delayMs, 0); // withEffect: runs WITH the previous, no extra delay
  assert.equal(afterEntry.shapeId, 3);
  assert.equal(afterEntry.presetClass, "emph");
  assert.equal(afterEntry.delayMs, 750); // afterEffect: the fixture's own <p:cond delay="750">
});

test("DeckIR slide 2: shape fills resolve theme scheme colors (accent1/accent2) to their hex", () => {
  const circle = deck.slides[1].shapes.find((s) => s.name === "Circle 1");
  const square = deck.slides[1].shapes.find((s) => s.name === "Square 1");
  assert.deepEqual(circle.fill, { kind: "solid", color: { kind: "scheme", slot: "accent1", transforms: [] } });
  assert.deepEqual(square.fill, { kind: "solid", color: { kind: "scheme", slot: "accent2", transforms: [] } });
});

test("DeckIR: fontsUsed collects every distinct resolved font family, sorted", () => {
  assert.deepEqual(deck.fontsUsed, ["Georgia", "Verdana"]);
});

test("DeckIR: warnings is present and empty for this fixture", () => {
  assert.deepEqual(deck.warnings, []);
});

test("parsePptx throws loudly on a non-zip byte stream (malformed input, never silent)", () => {
  assert.throws(() => parsePptx(new Uint8Array([1, 2, 3, 4])), /not a valid \.pptx/);
});

console.log(`\n  ${passed} pptx parser tests passed`);
