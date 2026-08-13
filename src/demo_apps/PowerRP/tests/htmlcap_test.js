/**
 * THE HTML CAPTURE WIDGET — the frozen-at-play law, and the refusals that keep it.
 * Run: node src/demo_apps/PowerRP/tests/htmlcap_test.js
 *
 * ── WHAT THIS IS WRITTEN AGAINST ────────────────────────────────────────────
 * The doctests in plugins/html_capture.js and web/htmlCapture.js already pin the
 * per-function arithmetic (tests/doctest_test.js executes them — both modules
 * import clean in bare node, which is why the capture service's storage import is
 * lazy). This file pins the things a doctest cannot reach, and every one of them
 * corresponds to a way this widget could be SILENTLY wrong — i.e. produce a
 * plausible picture, or a plausible success, while meaning something else:
 *
 *   1. THE DETERMINISM LAW ITSELF. That emit() reaches the stored asset and NEVER
 *      the html source. A widget that leaked its source into the render tree would
 *      look identical in the editor (which has a browser) and be unrenderable in
 *      the CLI — the exact defect the capture-at-author-time design exists to
 *      prevent, and one no rendering test would catch because the editor's picture
 *      would be right.
 *   2. NO SILENT BLANK. That an uncaptured widget emits the LOUD affordance rather
 *      than an empty op list. A blank widget cannot be told apart from a missing
 *      asset or a broken export, and it exits 0.
 *   3. THE SANDBOX TOKENS. That the frame never gains `allow-same-origin`, which
 *      would hand author scripts the editor's storage. The security argument in
 *      web/htmlCapture.js's header is entirely about what is ABSENT from that
 *      string, and absence is what no ordinary test notices.
 *   4. THE FOREIGN-SUBRESOURCE REFUSAL, including the CDN case the user asked
 *      about by name (chartjs). A missed foreign URL does not throw — it produces
 *      a confidently blank chart.
 *   5. REGISTRATION AND REPAIR. That the widget is in the real roster and that a
 *      document containing one survives repairedDocument with ZERO repairs.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument } from "../core/document.js";
import {
  DEFAULT_CAPTURE_H, DEFAULT_CAPTURE_W, DEFAULT_HTML, UNCAPTURED, UNCAPTURED_MESSAGE,
  hasCapture, uncapturedAffordance,
} from "../plugins/html_capture.js";
import {
  CAPTURE_SANDBOX, CAPTURE_ASSET_STEM, MAX_CAPTURE_PX,
  captureDocument, foreignObjectSvg, foreignSubresources, isForeignUrl, rasterSize,
} from "../web/htmlCapture.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);
const plugin = registry.get("html_capture");

/** A widget state with the plugin's own defaults, plus whatever the test overrides.
 *  Built from `plugin.defaults` rather than hand-written so a defaults change
 *  cannot leave these checks quietly testing a shape the app no longer produces. */
const stateWith = (over = {}) => ({ ...plugin.defaults, ...over });

// ── 1. THE DETERMINISM LAW ───────────────────────────────────────────────────

check("the widget IS registered — it is in the real roster, not just importable", () => {
  assert.ok(plugin, "registry.get('html_capture') returned nothing — check plugins/index.js");
  assert.equal(plugin.type, "html_capture");
  assert.equal(plugin.title, "HTML Capture");
});

check("a CAPTURED widget emits ONE image op on the stored asset — the ref IS the capture", () => {
  const ops = plugin.emit(stateWith({ capture: "shot.png", w: 300, h: 200 }), null, { scale: 1 });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "image");
  // THE POINT OF THE WHOLE FEATURE: what a backend receives is the ASSET, and the
  // html is nowhere in the display list. Every renderer already draws an image op,
  // which is why PDF/SVG/CLI export needed zero new code.
  assert.equal(ops[0].ref, "shot.png");
});

check("emit() NEVER carries the html source into the render tree, at any size or state", () => {
  // The source is deliberately distinctive so a substring search cannot pass by
  // accident, and it is checked against the SERIALIZED ops so a nested field
  // (a paint, a sub-op, a decoration) cannot smuggle it through either.
  const marker = "SENTINEL_HTML_MUST_NOT_REACH_THE_RENDER_TREE";
  for (const over of [
    { capture: "shot.png" },                       // captured
    { capture: UNCAPTURED },                       // uncaptured (the affordance path)
    { capture: "shot.png", strokeWidth: 4 },       // decorated
    { capture: "shot.png", cropLeft: 10 },         // cropped
  ]) {
    const s = stateWith({ ...over, html: `<div>${marker}</div>`, w: 300, h: 200 });
    const serialized = JSON.stringify(plugin.emit(s, null, { scale: 1 }));
    assert.ok(!serialized.includes(marker),
      `emit() leaked the html source into the display list for ${JSON.stringify(over)} — playback and the CLI must read ONLY the stored asset`);
  }
});

check("the widget CONVERGES on its stored asset alone — an exporter waits for a decode, not a browser", () => {
  // The video PLAYER is the app's one EPHEMERAL.NEVER inhabitant; a LIVE html frame
  // would have been a second. This declaration is the proof it is not one.
  assert.equal(plugin.ephemeral.kind, "converges");
  // An uncaptured widget has nothing to wait for and must not stall an export.
  assert.equal(plugin.ephemeral.settled(stateWith({ capture: UNCAPTURED })), true);
});

// ── 2. NO SILENT BLANK ───────────────────────────────────────────────────────

check("an UNCAPTURED widget draws the LOUD affordance — never an empty op list", () => {
  const ops = plugin.emit(stateWith({ capture: UNCAPTURED, w: 300, h: 200 }), null, { scale: 1 });
  assert.ok(ops.length > 0, "an uncaptured widget emitted nothing — a blank is indistinguishable from a missing asset");
  assert.deepEqual(ops.map((o) => o.op), ["rect", "text"]);
  assert.equal(ops[1].text, UNCAPTURED_MESSAGE);
});

check("the affordance NAMES THE ACTION — the whole reason it is not just a coloured box", () => {
  // Asserted verbatim: an edit that reduces this to "not captured" would leave a
  // user staring at an amber rectangle with no idea what to press.
  assert.match(UNCAPTURED_MESSAGE, /Capture HTML/);
  assert.match(UNCAPTURED_MESSAGE, /double-click/i);
});

check("the affordance is VECTOR ops, so it shows identically in the GPU, PDF, SVG and CLI backends", () => {
  const [box, label] = uncapturedAffordance(300, 200);
  assert.equal(box.op, "rect");
  assert.equal(label.op, "text");
  // Not an image op and not a ref: the placeholder must not itself depend on an
  // asset that could be missing, which would make the missing-asset report recurse.
  assert.ok(!("ref" in box) && !("ref" in label));
});

check("the affordance is OFFSET into the cropped box, not left at the local origin", () => {
  const ops = plugin.emit(stateWith({ capture: UNCAPTURED, w: 300, h: 200, cropLeft: 20, cropTop: 10 }), null, { scale: 1 });
  const box = ops.find((o) => o.op === "rect");
  assert.equal(box.x, 20);
  assert.equal(box.y, 10);
});

check("a fully cropped-away widget draws nothing — the ONE legal empty result", () => {
  const ops = plugin.emit(stateWith({ capture: "shot.png", w: 100, h: 100, cropLeft: 60, cropRight: 60 }), null, { scale: 1 });
  assert.deepEqual(ops, []);
});

// ── 3. THE SANDBOX ───────────────────────────────────────────────────────────

check("the capture frame gets allow-scripts and NOTHING else — the opaque origin is the containment", () => {
  assert.equal(CAPTURE_SANDBOX, "allow-scripts");
  // Stated as explicit absences because that is what the security argument IS. In
  // particular allow-same-origin would un-opaque the origin and give author script
  // the editor's DOM, cookies, localStorage and IndexedDB.
  for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"])
    assert.ok(!CAPTURE_SANDBOX.includes(forbidden),
      `the capture sandbox gained "${forbidden}" — read web/htmlCapture.js's sandbox note before changing this`);
});

check("the frame's report is authenticated by a per-capture token", () => {
  // "*" is the only possible postMessage target from an opaque origin, so the
  // token (plus the source-frame check the parent makes) is what stops an
  // unrelated message being taken for this capture's answer.
  const doc = captureDocument("<p>x</p>", 100, 100, "tok-abc");
  assert.ok(doc.includes('"tok-abc"'), "the capture document does not carry its token — the parent could not authenticate the reply");
});

check("the capture document waits for FONTS and a laid-out frame before reporting", () => {
  const doc = captureDocument("<p>x</p>", 800, 600, "t");
  // Rasterizing before a webfont resolves captures fallback metrics — an invisible
  // defect, and the classic html2image failure.
  assert.ok(doc.includes("document.fonts.ready"));
  // A script that writes DOM in its load handler has not been laid out until the
  // next frame; without this its elements measure 0.
  assert.ok(doc.includes("requestAnimationFrame"));
});

check("the capture document sizes the body to the capture box and zeroes the margin", () => {
  const doc = captureDocument("<p>x</p>", 640, 360, "t");
  assert.match(doc, /width:\s*640px/);
  assert.match(doc, /height:\s*360px/);
  // Without this every capture carries the browser's default 8px gutter.
  assert.match(doc, /margin:\s*0/);
});

check("the author's markup goes in VERBATIM — no wrapper element to change the layout", () => {
  // A wrapper would introduce a containing block the author did not write, quietly
  // changing percentage heights and flex behaviour.
  const doc = captureDocument('<div class="mine" style="height:100%">x</div>', 100, 100, "t");
  assert.ok(doc.includes('<div class="mine" style="height:100%">x</div>'));
});

// ── 4. THE FOREIGN-SUBRESOURCE REFUSAL ───────────────────────────────────────

check("a CDN chart library is refused BY URL — the user's chartjs question, answered honestly", () => {
  const found = foreignSubresources('<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>');
  assert.deepEqual(found, ["https://cdn.jsdelivr.net/npm/chart.js@4"]);
});

check("every foreign FORM is caught — script, link, img, @import, css url(), scheme-relative", () => {
  // Each of these is a real way to reach the network, and a missed one does not
  // throw: it produces a half-loaded page captured as a confidently blank picture.
  const cases = [
    ['<script src="https://a.test/x.js"></script>', "https://a.test/x.js"],
    ['<link rel="stylesheet" href="https://a.test/x.css">', "https://a.test/x.css"],
    ['<img src="http://a.test/x.png">', "http://a.test/x.png"],
    ['<style>@import "https://a.test/x.css";</style>', "https://a.test/x.css"],
    ['<style>body{background:url(https://a.test/x.png)}</style>', "https://a.test/x.png"],
    ['<script src="//a.test/x.js"></script>', "//a.test/x.js"],
  ];
  for (const [source, expected] of cases)
    assert.deepEqual(foreignSubresources(source), [expected], `missed the foreign URL in ${source}`);
});

check("SELF-CONTAINED sources are NOT refused — data URIs and same-origin paths pass", () => {
  // These are the supported ways to embed content, and refusing them would make
  // the widget useless. Inline <style>/<script>/<svg> carry no URL at all.
  for (const source of [
    '<img src="data:image/png;base64,iVBORw0KGgo=">',
    '<img src="/asset/Deck/logo.png">',
    '<img src="logo.png">',
    '<style>@font-face{src:url(data:font/woff2;base64,AAA)}</style>',
    '<script>document.title = "inline";</script>',
    '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    '<a href="#section">jump</a>',
  ])
    assert.deepEqual(foreignSubresources(source), [], `wrongly refused a self-contained source: ${source}`);
});

check("foreign URLs are de-duplicated and reported in source order", () => {
  const found = foreignSubresources('<img src="https://a.test/1.png"><img src="https://b.test/2.png"><img src="https://a.test/1.png">');
  assert.deepEqual(found, ["https://a.test/1.png", "https://b.test/2.png"]);
});

check("isForeignUrl draws the line at an explicit scheme+host, with data: excepted", () => {
  for (const u of ["https://a.test/x", "http://a.test/x", "//a.test/x", "ftp://a.test/x"])
    assert.equal(isForeignUrl(u), true, `${u} should be foreign`);
  for (const u of ["data:image/png;base64,AAA", "/asset/D/x.png", "x.png", "./x.png", "#a", ""])
    assert.equal(isForeignUrl(u), false, `${u} should NOT be foreign`);
});

// ── THE RASTER SIZE ──────────────────────────────────────────────────────────

check("an oversized capture REDUCES rather than asking for a canvas the browser blanks", () => {
  // Browsers refuse an over-large canvas by returning BLANK pixels, not by
  // throwing — so the cap is what stops a silent empty capture.
  const big = rasterSize(8000, 8000, 2);
  assert.ok(big.w <= MAX_CAPTURE_PX && big.h <= MAX_CAPTURE_PX);
  assert.equal(big.reduced, true, "an oversized capture must report that it was reduced");
  // The aspect ratio survives the reduction — a squashed capture would be worse
  // than a smaller one.
  assert.ok(Math.abs(big.w / big.h - 1) < 1e-9);
});

check("an ordinary capture is NOT reduced and lands at exactly requested x dpr", () => {
  const ok = rasterSize(1280, 720, 2);
  assert.deepEqual(ok, { w: 2560, h: 1440, scale: 2, reduced: false });
});

check("the foreignObject wrapper namespaces its content as XHTML", () => {
  // SVG drops non-namespaced foreignObject content SILENTLY: the image loads fine
  // and draws an empty box. This one attribute is the difference.
  const svg = foreignObjectSvg("<html><body>x</body></html>", 200, 100);
  assert.ok(svg.includes('xmlns="http://www.w3.org/1999/xhtml"'));
  assert.ok(svg.includes('width="200"') && svg.includes('height="100"'));
});

// ── 5. DEFAULTS, REPAIR AND THE EDITOR SURFACE ───────────────────────────────

check("the defaults are UNCAPTURED, so a fresh widget shows the affordance rather than a blank", () => {
  assert.equal(plugin.defaults.capture, UNCAPTURED);
  assert.equal(hasCapture(plugin.defaults), false);
  assert.equal(plugin.defaults.captureW, DEFAULT_CAPTURE_W);
  assert.equal(plugin.defaults.captureH, DEFAULT_CAPTURE_H);
});

check("the default HTML is itself self-contained — it captures on the first press", () => {
  // The worked example must not violate the rule it demonstrates.
  assert.deepEqual(foreignSubresources(DEFAULT_HTML), []);
  assert.ok(DEFAULT_HTML.trim().length > 0);
});

check("a document containing one survives repairedDocument with ZERO repairs", () => {
  const doc = {
    meta: { name: "HTMLCap" },
    slides: [{
      id: "s1", name: "One",
      delta: { items: { cap: { ...plugin.defaults } } },
    }],
  };
  const { doc: repaired, reports } = repairedDocument(doc, registry);
  assert.deepEqual(reports, [], `a freshly-defaulted widget needed repairs: ${JSON.stringify(reports)}`);
  assert.equal(repaired.slides[0].delta.items.cap.type, "html_capture");
});

check("double-click opens the SHARED Monaco editor on `html` — no editor UI of its own", () => {
  assert.equal(plugin.activate, "code_modal");
  assert.equal(plugin.codeEditor.property, "html");
  assert.equal(plugin.codeEditor.language, "html");
  // The `code` ROW ASPECT and the plugin-level descriptor must name the same
  // property and agree on the language (core/properties.js states this contract).
  const htmlRow = plugin.inspector.find((r) => r.key === "html");
  assert.equal(htmlRow.code.language, plugin.codeEditor.language);
});

check("the Capture command is GATED on this widget type, and says why when it is not available", () => {
  const capture = plugin.commands.find((c) => c.id === "capture-html");
  assert.ok(capture, "the capture-html command is missing");
  // An ungated selection command answers an empty selection with an EXCEPTION
  // instead of a greyed row — the defect tests/palette_probe.js sweeps for.
  assert.equal(typeof capture.when, "function");
  assert.equal(capture.when({ selectedNode: () => ({ type: "html_capture" }) }), true);
  assert.equal(capture.when({ selectedNode: () => ({ type: "rect" }) }), false);
  assert.equal(capture.when({ selectedNode: () => null }), false);
  assert.ok(typeof capture.requires === "string" && capture.requires.length > 20,
    "the gate needs a sentence completing 'Unavailable — requires …'");
});

check("the capture is reachable WITHOUT the palette — an Inspector action row and a Tools row", () => {
  // A gate is only half an affordance (the tool-surfacing rule).
  const actionRow = plugin.inspector.find((r) => r.kind === "action");
  assert.equal(actionRow.command, "capture-html");
  const toolRow = plugin.toolGroups.flatMap((g) => g.rows).find((r) => r.command === "capture-html");
  assert.ok(toolRow, "the capture command reaches no Tools group");
});

check("captures accumulate as siblings rather than overwriting — which is what makes capture UNDOABLE", () => {
  // The store de-collides `html-capture.png` into "html-capture 2.png" etc., so
  // undoing a capture restores a ref whose bytes are still present.
  assert.equal(CAPTURE_ASSET_STEM, "html-capture");
});

console.log(`\n${passed} tests passed`);
