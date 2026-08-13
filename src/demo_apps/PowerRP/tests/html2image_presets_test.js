/**
 * THE HTML2IMAGE PRESET LIBRARY suite — plain node, no browser, no GPU.
 * Run: node src/demo_apps/PowerRP/tests/html2image_presets_test.js
 *
 * R7-39 (the presets law): >=10 intelligent, unique, diverse presets. This widget
 * shipped with none — the user's own complaint ("I don't know how to test this
 * because it's very boring looking right now. Because there's no presets.") — and
 * plugins/html2image.js now carries thirteen ready-to-capture HTML/CSS designs.
 * tests/preset_contract_test.js already sweeps the WHOLE roster for the generic
 * rules (declared keys, non-empty name/description, unique names, legal values,
 * no placement key). This file proves the things that are specific to THIS
 * widget and that the generic sweep cannot see:
 *
 *   (1) EVERY PRESET WRITES EXACTLY {html} — never `capture` (that would defeat
 *       the "capture is an explicit user action" law plugins/html2image.js's
 *       header states) and never a placement key.
 *   (2) EVERY SOURCE PASSES THE WIDGET'S OWN FOREIGN-SUBRESOURCE SCAN
 *       (web/html2image.js foreignSubresources) — the same check
 *       captureHtmlToAsset runs before it ever creates a sandboxed frame. A
 *       preset that failed this would capture instantly and confidently wrong
 *       (a refusal, not a picture) the first time an author pressed Capture.
 *   (3) EVERY SOURCE PASSES THE BACKTICK / ${ GUARD — these strings live inside
 *       a JS template literal in plugins/html2image.js, one scope up from
 *       DEFAULT_HTML (tests/htmlcap_html2image_test.js pins DEFAULT_HTML itself
 *       this same way). A stray backtick closes the literal early; a stray ${
 *       silently INTERPOLATES rather than rendering literally — both are worse
 *       than a normal typo because neither throws at authoring time.
 *   (4) SOURCES ARE PAIRWISE STRUCTURALLY DISTINCT — no two preset strings are
 *       character-identical (the bare-node shadow of the pixel-distinctness the
 *       browser probe proves; two identical sources cannot possibly render
 *       differently, so this is a necessary floor even without a renderer).
 *   (5) THE PLACEHOLDER RENDERS DISTINCTLY PER PRESET — uncapturedAffordance()
 *       previews the source's OWN FIRST LINE (sourcePreview), which is the only
 *       thing that tells two UNCAPTURED preset instances apart before either is
 *       captured. This asserts the thirteen first lines are pairwise distinct
 *       AND that they actually flow into the placeholder's preview text op,
 *       through the real render path (uncapturedAffordance), not just the
 *       source strings themselves.
 */

import assert from "node:assert/strict";
import { html2imagePlugin, sourcePreview, uncapturedAffordance } from "../plugins/html2image.js";
import { foreignSubresources } from "../web/html2image.js";

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const PRESETS = html2imagePlugin.presets;

// ── (0) the sweep is not vacuous, and meets the R7-39 floor ────────────────────
test("the widget declares a preset library of >= 10 rows (R7-39)", () => {
  assert.ok(Array.isArray(PRESETS), `presets is ${typeof PRESETS}`);
  assert.ok(PRESETS.length >= 10, `only ${PRESETS.length} presets — R7-39 requires >= 10`);
  console.log(`      ${PRESETS.length} presets`);
});

// ── (1) every preset writes EXACTLY {html} ──────────────────────────────────────
test("every preset's props is EXACTLY {html: <string>} — never `capture`, never a placement key", () => {
  for (const preset of PRESETS) {
    const keys = Object.keys(preset.props ?? {});
    assert.deepEqual(keys, ["html"], `${JSON.stringify(preset.name)} writes keys ${JSON.stringify(keys)}, expected exactly ["html"]`);
    assert.equal(typeof preset.props.html, "string", `${JSON.stringify(preset.name)}: html is ${typeof preset.props.html}`);
    assert.ok(preset.props.html.trim().length > 0, `${JSON.stringify(preset.name)}: empty html`);
  }
});

test("no preset ever sets `capture`, `captureW` or `captureH` — capture stays an explicit user action", () => {
  for (const preset of PRESETS)
    for (const forbidden of ["capture", "captureW", "captureH"])
      assert.ok(!(forbidden in (preset.props ?? {})), `${JSON.stringify(preset.name)} writes "${forbidden}" — a preset must never populate the capture asset or its resolution`);
});

// ── (2) every source passes the widget's own foreign-subresource scan ──────────
test("every preset source passes foreignSubresources — no CDN script, remote image, webfont or scheme-relative URL", () => {
  for (const preset of PRESETS) {
    const foreign = foreignSubresources(preset.props.html);
    assert.deepEqual(foreign, [], `${JSON.stringify(preset.name)} references foreign URL(s) ${JSON.stringify(foreign)} — captureHtmlToAsset would refuse this loudly instead of capturing it`);
  }
});

// ── (3) every source passes the backtick / ${ guard ─────────────────────────────
test("no preset source contains a backtick — it lives inside a template literal that one would close early", () => {
  for (const preset of PRESETS)
    assert.ok(!preset.props.html.includes("`"), `${JSON.stringify(preset.name)}: contains a backtick`);
});

test("no preset source contains ${ — it would silently interpolate instead of rendering literally", () => {
  for (const preset of PRESETS)
    assert.ok(!preset.props.html.includes("${"), `${JSON.stringify(preset.name)}: contains \${`);
});

// ── (4) sources are pairwise structurally distinct ──────────────────────────────
test("no two preset sources are character-identical", () => {
  for (let i = 0; i < PRESETS.length; i++)
    for (let j = i + 1; j < PRESETS.length; j++)
      assert.notEqual(PRESETS[i].props.html, PRESETS[j].props.html,
        `"${PRESETS[i].name}" and "${PRESETS[j].name}" carry byte-identical html`);
});

// ── (5) the placeholder previews each source distinctly ─────────────────────────
test("every preset's FIRST LINE (what the placeholder previews) is non-empty and pairwise distinct", () => {
  const firstLines = PRESETS.map((p) => sourcePreview(p.props.html, 200));
  for (const [i, line] of firstLines.entries())
    assert.ok(line && line !== "(empty source)", `${JSON.stringify(PRESETS[i].name)}: first line previews as empty`);
  const unique = new Set(firstLines);
  assert.equal(unique.size, firstLines.length,
    `first lines are not pairwise distinct — two uncaptured instances of these presets would look identical: ${JSON.stringify(firstLines)}`);
});

test("uncapturedAffordance() actually carries each preset's own first line into its preview text op", () => {
  const W = 480, H = 270; // the widget's own default box (plugins/html2image.js defaults)
  const previews = PRESETS.map((preset) => {
    const ops = uncapturedAffordance(W, H, preset.props.html);
    const previewOp = ops[2]; // [card, title, preview, pill, hint] — index 2 per the module's own doctest
    assert.equal(previewOp.text, sourcePreview(preset.props.html, Math.max(8, Math.floor((W - 2 * Math.min(22, H * 0.07)) / (Math.min(14, H * 0.075) * 0.6)))),
      `${JSON.stringify(preset.name)}: uncapturedAffordance's preview op does not match sourcePreview() for the same source`);
    return previewOp.text;
  });
  assert.equal(new Set(previews).size, previews.length,
    `two presets rendered the SAME placeholder preview text at the widget's default size: ${JSON.stringify(previews)}`);
});

// ── (6) names read like real, distinguishable designs (not "Preset 1") ─────────
test("every preset name is a real design name, not a placeholder counter", () => {
  for (const preset of PRESETS)
    assert.ok(!/^preset\s*\d*$/i.test(preset.name.trim()), `${JSON.stringify(preset.name)} reads like a placeholder name`);
});

console.log(`\n${passed} tests passed`);
