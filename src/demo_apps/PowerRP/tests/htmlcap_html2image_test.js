/**
 * THE HTML TO IMAGE WIDGET — the frozen-at-play law, the refusals that keep it,
 * and the retirement of the name it shipped under for a day.
 * Run: node src/demo_apps/PowerRP/tests/htmlcap_html2image_test.js
 *
 * ── WHAT THIS IS WRITTEN AGAINST ────────────────────────────────────────────
 * The doctests in plugins/html2image.js and web/html2image.js already pin the
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
 *      web/html2image.js's header is entirely about what is ABSENT from that
 *      string, and absence is what no ordinary test notices.
 *   4. THE FOREIGN-SUBRESOURCE REFUSAL, including the CDN case the user asked
 *      about by name (chartjs). A missed foreign URL does not throw — it produces
 *      a confidently blank chart.
 *   5. REGISTRATION AND REPAIR. That the widget is in the real roster and that a
 *      document containing one survives repairedDocument with ZERO repairs.
 *   6. THE RENAME. That a document written under the retired `html_capture` type
 *      loads as `html2image` — and, the half that is easy to get wrong, that the
 *      migration runs BEFORE the orphan drop. A retired type is absent from the
 *      registry, so a rename placed after that step would find the item already
 *      purged and report only that something unknown went away.
 *   7. THE DEFAULT IS NOT BORING, which is a real requirement here rather than
 *      taste (user: "I don't know how to test this because it's very boring
 *      looking right now"). The default source must be substantial AND must pass
 *      this widget's own foreign-subresource refusal — a worked example that
 *      violated the rule it illustrates would be worse than none.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import {
  RETIRED_ITEM_TYPES, repairedDocument, retirementReason, withItemTypesMigrated,
} from "../core/document.js";
import {
  DEFAULT_CAPTURE_H, DEFAULT_CAPTURE_W, DEFAULT_HTML, DEFAULT_HTML_FIRST_LINE,
  UNCAPTURED, UNCAPTURED_MESSAGE, UNCAPTURED_TITLE,
  hasCapture, sourcePreview, uncapturedAffordance,
} from "../plugins/html2image.js";
import {
  CAPTURE_SANDBOX, CAPTURE_ASSET_STEM, MAX_CAPTURE_PX,
  captureDocument, foreignObjectSvg, foreignSubresources, isForeignUrl, rasterSize,
} from "../web/html2image.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);
const plugin = registry.get("html2image");

/** A widget state with the plugin's own defaults, plus whatever the test overrides.
 *  Built from `plugin.defaults` rather than hand-written so a defaults change
 *  cannot leave these checks quietly testing a shape the app no longer produces. */
const stateWith = (over = {}) => ({ ...plugin.defaults, ...over });

// ── 1. THE DETERMINISM LAW ───────────────────────────────────────────────────

check("the widget IS registered — it is in the real roster, not just importable", () => {
  assert.ok(plugin, "registry.get('html2image') returned nothing — check plugins/index.js");
  assert.equal(plugin.type, "html2image");
  assert.equal(plugin.title, "HTML to Image");
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

check("an UNCAPTURED widget draws the DESIGNED CARD — never an empty op list", () => {
  const ops = plugin.emit(stateWith({ capture: UNCAPTURED, w: 480, h: 270 }), null, { scale: 1 });
  assert.ok(ops.length > 0, "an uncaptured widget emitted nothing — a blank is indistinguishable from a missing asset");
  // card, title, source preview, hint pill, hint text — a designed state, not a
  // one-line warning. The user's complaint was that this widget looked boring.
  assert.deepEqual(ops.map((o) => o.op), ["rect", "text", "text", "rect", "text"]);
  assert.equal(ops[1].text, UNCAPTURED_TITLE);
  assert.equal(ops[4].text, UNCAPTURED_MESSAGE);
});

check("the placeholder PREVIEWS THE SOURCE — two uncaptured widgets must not look identical", () => {
  const a = plugin.emit(stateWith({ capture: UNCAPTURED, html: "<main>alpha</main>", w: 480, h: 270 }), null, { scale: 1 });
  const b = plugin.emit(stateWith({ capture: UNCAPTURED, html: "<aside>beta</aside>", w: 480, h: 270 }), null, { scale: 1 });
  assert.equal(a[2].text, "<main>alpha</main>");
  assert.equal(b[2].text, "<aside>beta</aside>");
  assert.notEqual(a[2].text, b[2].text);
});

check("sourcePreview collapses, elides and survives an empty or blank-led source", () => {
  assert.equal(sourcePreview("<div>\n<p>x</p>", 40), "<div>");
  assert.equal(sourcePreview("\n\n   <p>after blanks</p>", 40), "<p>after blanks</p>");
  assert.equal(sourcePreview("<a>   lots     of   space</a>", 40), "<a> lots of space</a>");
  assert.equal(sourcePreview("", 40), "(empty source)");
  assert.equal(sourcePreview("  \n \n ", 40), "(empty source)");
  // Elision keeps the budget: never longer than max.
  assert.ok(sourcePreview("<section><header><h1>a very long line indeed</h1>", 20).length <= 20);
});

check("the affordance NAMES THE ACTION — the whole reason it is not just a coloured box", () => {
  // Asserted verbatim: an edit that reduces this to "not captured" would leave a
  // user staring at a rectangle with no idea what to press.
  assert.match(UNCAPTURED_MESSAGE, /Capture/);
  assert.match(UNCAPTURED_MESSAGE, /double-click/i);
  // And it says what the widget IS, in the name the user chose.
  assert.equal(UNCAPTURED_TITLE, "HTML to Image");
});

check("the affordance is VECTOR ops, so it shows identically in the GPU, PDF, SVG and CLI backends", () => {
  const ops = uncapturedAffordance(480, 270, "<div>hi</div>");
  for (const op of ops) {
    assert.ok(op.op === "rect" || op.op === "text", `unexpected placeholder op "${op.op}"`);
    // Not an image op and not a ref: the placeholder must not itself depend on an
    // asset that could be missing, which would make the missing-asset report recurse.
    assert.ok(!("ref" in op), "the placeholder must not reference an asset");
  }
});

check("the affordance COMPOSES AT ANY SIZE — a tiny widget must not mint giant type or negative boxes", () => {
  // Fractional sizing with caps: a 40x24 thumbnail and a 4000x2000 banner must both
  // produce a well-formed card, or the placeholder becomes the broken thing.
  for (const [w, h] of [[40, 24], [120, 90], [480, 270], [4000, 2000]]) {
    const ops = uncapturedAffordance(w, h, DEFAULT_HTML);
    for (const op of ops) {
      if (op.op === "rect") assert.ok(op.w > 0 && op.h > 0, `rect collapsed at ${w}x${h}`);
      if (op.op === "text") assert.ok(op.size > 0 && op.boxW > 0, `text collapsed at ${w}x${h}`);
      assert.ok(Number.isFinite(op.x) && Number.isFinite(op.y), `non-finite position at ${w}x${h}`);
    }
  }
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
      `the capture sandbox gained "${forbidden}" — read web/html2image.js's sandbox note before changing this`);
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
  // The worked example must not violate the rule it demonstrates. This is the check
  // that keeps the handsome default honest: the moment someone "improves" it with a
  // Google Font <link>, the widget's own refusal would reject its own default.
  assert.deepEqual(foreignSubresources(DEFAULT_HTML), []);
  assert.ok(DEFAULT_HTML.trim().length > 0);
});

check("the default HTML is NOT BORING — the user's actual complaint, made mechanical", () => {
  // "I don't know how to test this because it's very boring looking right now."
  // A default that is merely valid demonstrates nothing: the argument FOR this
  // widget is layout a native widget cannot do, so the default must actually do
  // some. These are the cheapest structural proxies for "a designed card".
  assert.ok(DEFAULT_HTML.includes("gradient"), "the default should show off gradients — a native rect cannot do a layered radial gradient");
  assert.ok(DEFAULT_HTML.includes("<style>"), "the default should use a real stylesheet, not only inline attributes");
  assert.ok(/flex|grid/.test(DEFAULT_HTML), "the default should demonstrate CSS layout — the whole reason to reach for HTML");
  assert.ok(DEFAULT_HTML.split("\n").length > 20, "a one-liner is the boring default this replaces");
  // And it must be a CARD, not a paragraph: something with structure to look at.
  assert.ok(DEFAULT_HTML.includes("border-radius"), "the default should read as a designed surface");
});

check("the default HTML contains NO BACKTICK — it lives in a template literal that one would close", () => {
  // MEASURED, not hypothetical: a `min-height: 0` written inside a CSS comment in
  // DEFAULT_HTML closed the template literal and made the whole plugin a syntax
  // error, taking every suite that imports the roster with it. The module simply
  // stops parsing, so no assertion anywhere fires — the failure is a boot crash,
  // not a red test. tests/doctest_test.js records the identical trap in a shader.
  // A `${` would be worse: it would INTERPOLATE silently rather than throw.
  assert.ok(!DEFAULT_HTML.includes("`"), "a backtick in DEFAULT_HTML closes its own template literal");
  assert.ok(!DEFAULT_HTML.includes("${"), "a ${ in DEFAULT_HTML would interpolate instead of rendering literally");
});

check("the default's first line is DERIVED, so the placeholder cannot quote a stale source", () => {
  assert.equal(DEFAULT_HTML_FIRST_LINE, DEFAULT_HTML.split("\n")[0]);
  // And the placeholder actually shows it for a default-configured widget.
  const ops = uncapturedAffordance(480, 270, DEFAULT_HTML);
  assert.equal(ops[2].text, sourcePreview(DEFAULT_HTML, Math.max(8, Math.floor((480 - 2 * Math.min(22, 270 * 0.07)) / (Math.min(14, 270 * 0.075) * 0.6)))));
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
  assert.equal(repaired.slides[0].delta.items.cap.type, "html2image");
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
  assert.equal(capture.when({ selectedNode: () => ({ type: "html2image" }) }), true);
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
  // The store de-collides `html2image.png` into "html2image 2.png" etc., so undoing
  // a capture restores a ref whose bytes are still present.
  assert.equal(CAPTURE_ASSET_STEM, "html2image");
});

// ── 6. THE RENAME ────────────────────────────────────────────────────────────

check("the retired name is GONE from the roster — a live alias would make the migration silent", () => {
  assert.equal(registry.all().some((p) => p.type === "html_capture"), false,
    "html_capture must not still be registered: if it resolved, no document would ever migrate and the two names would drift apart");
  assert.equal(RETIRED_ITEM_TYPES.html_capture, "html2image");
});

check("a document written under the OLD type loads as the new one, with every other key untouched", () => {
  const legacy = { slides: [{ delta: { items: { a: { type: "html_capture", html: "<p>mine</p>", capture: "shot.png", x: 40 } } } }] };
  const { doc, migrated } = withItemTypesMigrated(legacy);
  assert.deepEqual(migrated, [{ id: "a", slideIndex: 0, from: "html_capture", to: "html2image" }]);
  // A PURE RENAME: the type leaf moves and nothing else does. The author's source
  // and their already-captured asset must both survive, or the migration would be
  // a data loss wearing a rename's clothes.
  assert.deepEqual(doc.slides[0].delta.items.a, { type: "html2image", html: "<p>mine</p>", capture: "shot.png", x: 40 });
});

check("THE MIGRATION RUNS BEFORE THE ORPHAN DROP — otherwise it is a no-op on a purged item", () => {
  // The ordering IS the migration. A retired type is absent from the registry, so
  // the orphan step would classify it as unknown and PURGE it, and the rename placed
  // after would find nothing. Pinned on a real pipeline run, because reading the
  // source would not prove the outcome.
  const legacy = {
    meta: { name: "Legacy" },
    slides: [{ id: "s1", name: "One", delta: { items: { a: { type: "html_capture", html: "<p>kept</p>" } } } }],
  };
  const { doc, reports } = repairedDocument(legacy, registry);
  const item = doc.slides[0].delta.items.a;
  assert.ok(item, "the item was DROPPED — the rename ran after the orphan step, which is the whole defect this pins");
  assert.equal(item.type, "html2image");
  assert.equal(item.html, "<p>kept</p>");
  assert.ok(reports.some((r) => r.includes('"html_capture" → "html2image"')),
    `the migration must be REPORTED, not silent; got ${JSON.stringify(reports)}`);
});

check("the migration report explains ITSELF rather than another widget's retirement", () => {
  // The report line used to be one hardcoded sentence about anchor points becoming
  // blender-style empties. With a second entry in the table that sentence became a
  // confident lie, so each retirement now carries its own.
  assert.match(retirementReason("html_capture"), /HTML to Image/);
  assert.ok(!/blender|rotation and scale/i.test(retirementReason("html_capture")),
    "the html2image migration is describing the ANCHOR POINT's retirement — the reasons have been crossed");
  // And the anchor point's own sentence is untouched by this change.
  assert.match(retirementReason("anchor_point"), /EMPTY/);
});

check("a retirement with no recorded reason is LOUD, not a blank explanation", () => {
  assert.throws(() => retirementReason("never_existed"), /no sentence in RETIREMENT_REASONS/);
});

check("the OLD NAME still FINDS the widget — an alias, so nothing anyone learned dies", () => {
  const add = plugin.commands.find((c) => c.id === "add-html2image");
  assert.ok(add, "the add command is missing");
  assert.equal(add.title, "Add HTML to Image");
  // Aliases are never displayed (core/commands.js), so the palette shows only the
  // correct name while both spellings match.
  assert.ok(add.aliases.includes("html capture"),
    "the retired name must remain searchable — a user who learned 'HTML Capture' must still find this");
  assert.ok(add.aliases.includes("html2image"));
});

check("the widget's NAME is the one the user chose, everywhere it is displayed", () => {
  assert.equal(plugin.type, "html2image");
  assert.equal(plugin.title, "HTML to Image");
  // No user-visible string may still say "HTML Capture": the title, the row labels
  // and the command titles are what the user reads.
  const visible = [plugin.title, ...plugin.commands.map((c) => c.title), ...plugin.inspector.map((r) => r.label ?? "")];
  for (const s of visible)
    assert.ok(!/HTML Capture/i.test(s), `a user-visible string still says "HTML Capture": ${JSON.stringify(s)}`);
});

// ── 7. THE PRESET SURFACE (for the separate presets program, backburner EG) ──

check("the widget's PRESET SURFACE is declarable — a preset is one `html` write and nothing else", () => {
  // The presets program (>=10 per widget) must be able to add entries WITHOUT
  // touching this plugin's logic. That is true exactly when a preset is a plain
  // property write, so this pins the shape it will write against rather than
  // shipping the presets themselves.
  const htmlRow = plugin.inspector.find((r) => r.key === "html");
  assert.equal(htmlRow.kind, "text", "a preset writes `html` as a plain string — any other row kind would need conversion logic");
  assert.equal(typeof plugin.defaults.html, "string");
  // The two size knobs are ordinary numbers, so a preset may set its own aspect.
  for (const key of ["captureW", "captureH"]) {
    assert.equal(plugin.inspector.find((r) => r.key === key).kind, "number");
    assert.equal(typeof plugin.defaults[key], "number");
  }
  // And a preset must NOT be able to smuggle in a stale capture: the asset ref is
  // written by the command, so a preset that set it would point at another
  // widget's pixels. Presets write source; the user presses Capture.
  assert.equal(plugin.defaults.capture, UNCAPTURED);
});

console.log(`\n${passed} tests passed`);
