/**
 * BUILT-IN CURSOR + BARE-NODE SVG PARSE guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/builtin_cursor_test.js
 *
 * WHY THIS EXISTS. render_gpu/gpu/svg_raster.js had TWO browser-only steps on the
 * cursor render path, and nothing in bare node ever walked it:
 *   (1) the built-in cursor library loaded through `import.meta.glob`, a VITE
 *       MACRO. The module still IMPORTED fine in node (the call sits inside a lazy
 *       loader), so every node suite stayed green — but the first cursor to render
 *       headlessly threw "(intermediate value).glob is not a function" out of
 *       cli/render.js, and NO PNG was produced. Any deck with a cursor was
 *       unrenderable headlessly.
 *   (2) the SVG→tree parse needed DOMParser, which Node does not ship — so even
 *       with the assets loaded, the flatten could not run.
 * The fix gives each step an environment-specific path (bundle glob / fs read, and
 * DOMParser / the strict pure scanner) behind ONE entry, the same way
 * render_gpu/fonts.js + browser_canvaskit.js + node_render.js split font loading.
 *
 * WHAT IT PROVES, in BARE NODE (no Vite, no browser, no puppeteer):
 *   (1) every name in CURSOR_NAMES resolves to a real committed SVG source, and
 *       the loader finds EXACTLY that set (the drift check's population);
 *   (2) every one of them PARSES and FLATTENS to real path ops (not zero ops);
 *   (3) the pure scanner matches DOMParser's tree shape and fails LOUDLY on
 *       malformed input (the widget's error-affordance contract);
 *   (4) an unknown cursor name still throws loudly;
 *   (5) the ORIGINAL REPRO: a document with a cursor item renders to a valid PNG
 *       through cli/render.js's renderDocToPng, and twice in a row it is
 *       BYTE-IDENTICAL (the headless determinism contract).
 */

import assert from "node:assert/strict";
import {
  CURSOR_NAMES, CURSOR_VIEWBOX, cursorSource, cursorNameFromPath, svgToIR, builtinCursorAssets,
  parseSvgToTree, parseSvgTreeText, parseAttrRun, decodeXmlText, skipNonElement,
} from "../render_gpu/gpu/svg_raster.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { renderDocToPng } from "../cli/render.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]; // \x89 P N G
const MIN_PNG_BYTES = 1000; // a blank/failed encode is far smaller than any real frame
const CURSOR_BOX = 64; // the flatten box these checks map each cursor into

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. A one-slide document holding THE camera plus one cursor item —
 * the minimal repro shape (a deck containing a cursor).
 *
 * @param {object} registry - a plugin registry (for the camera/cursor defaults)
 * @param {string} kind - a built-in cursor name
 * @returns {object} a serializable .powerrp.json document
 *
 * @example // cursorDoc(registry, "default").slides.length  // 1
 */
function cursorDoc(registry, kind) {
  const cursor = { ...registry.get("cursor").defaults, cursorKind: kind, x: 440, y: 180, w: 400, h: 400, z: 1 };
  const camera = { ...registry.get("camera").defaults, x: 0, y: 0, w: 1280, h: 720, z: 1000, background: "#202030" };
  return {
    meta: { name: "cursor repro", slideW: 1280, slideH: 720 },
    slides: [{
      id: "aaaa1111", name: "Slide 1",
      transition: { seconds: 0.5, curve: "smooth", sound: null, type: "tween" },
      delta: { items: { cam00001: camera, cur00001: cursor } },
    }],
  };
}

// ── (1) the library loads in bare node, and matches CURSOR_NAMES ──────────────

test("every CURSOR_NAMES entry resolves to a committed SVG source (bare node, off disk)", () => {
  for (const name of CURSOR_NAMES) {
    const src = cursorSource(name);
    assert.equal(typeof src, "string", `${name}: not a string`);
    assert.match(src, /<svg[\s>]/, `${name}: no root <svg>`);
    assert.match(src, new RegExp(`viewBox=["']0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}["']`), `${name}: not the shared 0..${CURSOR_VIEWBOX} viewBox`);
  }
});

test("the loader finds EXACTLY the CURSOR_NAMES set (the drift check's population)", () => {
  const loaded = builtinCursorAssets().map((a) => a.name.replace(/\.svg$/, "")).sort();
  assert.deepEqual(loaded, [...CURSOR_NAMES].sort(), "committed cursor files differ from CURSOR_NAMES");
  for (const a of builtinCursorAssets()) {
    assert.equal(a.builtin, true, `${a.name}: not marked builtin`);
    assert.match(a.url, /^data:image\/svg\+xml;base64,/, `${a.name}: no self-contained data URI`);
  }
});

test("an unknown cursor name throws loudly (no silent blank)", () => {
  assert.throws(() => cursorSource("no-such-cursor"), /unknown built-in cursor/);
});

test("cursorNameFromPath doctests (the shared bundle/disk key)", () => {
  assert.equal(cursorNameFromPath("../../assets/builtin/cursors/zoomin.svg"), "zoomin");
  assert.equal(cursorNameFromPath("beachball.svg"), "beachball");
});

// ── (2) every cursor flattens to real geometry ────────────────────────────────

test("every built-in cursor flattens to real path ops in bare node", () => {
  for (const name of CURSOR_NAMES) {
    const ops = svgToIR(cursorSource(name), CURSOR_BOX, CURSOR_BOX, { ink: "#000000", preserveAspect: true });
    const paths = ops.filter((o) => o.op === "path");
    assert.ok(paths.length > 0, `${name}: flattened to ZERO path ops`);
    for (const p of paths) assert.ok(p.d.length > 0, `${name}: empty path d`);
  }
});

// ── (3) the bare-node scanner: same shape as DOMParser, loud on malformed ─────

test("parseSvgTreeText builds the DOMParser tree shape (tags lowercase, attribute case kept)", () => {
  const t = parseSvgTreeText("<svg viewBox='0 0 2 2'><g fill=\"red\"><path d='M0 0h1'/></g></svg>");
  assert.equal(t.tag, "svg");
  assert.equal(t.attrs.viewBox, "0 0 2 2"); // NOT viewbox — case preserved
  assert.equal(t.children[0].tag, "g");
  assert.equal(t.children[0].attrs.fill, "red");
  assert.equal(t.children[0].children[0].attrs.d, "M0 0h1");
  assert.equal(t.children[0].children[0].children.length, 0); // self-closing
  assert.equal(parseSvgTreeText("<svg><linearGradient/></svg>").children[0].tag, "lineargradient");
});

test("parseSvgTreeText skips comments / declarations / DOCTYPEs and ignores text nodes", () => {
  const t = parseSvgTreeText(`<?xml version="1.0"?><!DOCTYPE svg><!-- a note --><svg><text x="1">hello</text></svg>`);
  assert.equal(t.tag, "svg");
  assert.equal(t.children.length, 1);
  assert.equal(t.children[0].tag, "text");
  assert.equal(skipNonElement("<!-- hi --><svg/>", 0), 11);
  assert.equal(skipNonElement("<svg/>", 0), 0);
});

test("parseAttrRun / decodeXmlText doctests", () => {
  assert.deepEqual(parseAttrRun(' viewBox="0 0 4 4" fill=\'none\''), { viewBox: "0 0 4 4", fill: "none" });
  assert.deepEqual(parseAttrRun(""), {});
  assert.equal(decodeXmlText("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(decodeXmlText("&#65;&#x42;"), "AB");
  assert.throws(() => decodeXmlText("&nbsp;"), /undeclared XML entity/);
});

test("malformed SVG throws LOUDLY in bare node (the error-affordance contract)", () => {
  assert.throws(() => parseSvgToTree("<svg><g></svg>"), /malformed SVG/); // mismatched close
  assert.throws(() => parseSvgToTree("<svg><g>"), /malformed SVG/);       // unclosed
  assert.throws(() => parseSvgToTree("<svg width=32>"), /malformed SVG/); // unquoted attribute
  assert.throws(() => parseSvgToTree("<svg><!-- unterminated"), /malformed SVG/);
  assert.throws(() => parseSvgToTree("<rect/>"), /expected <svg>/);       // wrong root
  assert.throws(() => parseSvgToTree("not markup at all"), /no element found/);
});

// ── (5) THE REPRO: a cursor document renders headlessly, deterministically ────

const registry = createRegistry();
registerAll(registry, createCommands());

const docJson = JSON.stringify(cursorDoc(registry, "default"));
const png = await renderDocToPng(docJson, { slide: 0, alpha: 1, width: 1280, height: 720 });
test("a document containing a cursor renders to a valid PNG through the headless CLI", () => {
  assert.ok(png instanceof Uint8Array, "expected Uint8Array");
  assert.ok(PNG_MAGIC.every((b, i) => png[i] === b), "not a PNG (bad magic)");
  assert.ok(png.length >= MIN_PNG_BYTES, `PNG too small (${png.length} bytes)`);
});

const again = await renderDocToPng(docJson, { slide: 0, alpha: 1, width: 1280, height: 720 });
test("the headless cursor render is BYTE-IDENTICAL across runs (determinism)", () => {
  assert.equal(again.length, png.length);
  assert.ok(Buffer.from(again).equals(Buffer.from(png)), "two renders of the same doc differ");
});

// The BEACH BALL is the one cursor with linearGradients + a clock-driven spin — the
// richest asset, and the one whose gradient stops exercise the scanner's nested
// <defs>-less gradient collection.
const ballPng = await renderDocToPng(JSON.stringify(cursorDoc(registry, "beachball")), { slide: 0, alpha: 1, width: 640, height: 360 });
test("the gradient-bearing beach ball cursor also renders headlessly", () => {
  assert.ok(PNG_MAGIC.every((b, i) => ballPng[i] === b), "not a PNG (bad magic)");
  assert.ok(ballPng.length >= MIN_PNG_BYTES, `PNG too small (${ballPng.length} bytes)`);
});

console.log(`\n${passed} built-in cursor / bare-node parse tests passed (${CURSOR_NAMES.length} cursors).`);
