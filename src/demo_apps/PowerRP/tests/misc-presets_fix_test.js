/**
 * FOUR PRESET PROMISES THAT WERE FALSE, PINNED — bare node, no Skia, no browser.
 * Run: node src/demo_apps/PowerRP/tests/misc-presets_fix_test.js
 *
 * WHY THIS EXISTS. Each check below failed on the code as shipped, and none of
 * them was visible to any existing suite, because every one is a DESCRIPTION
 * disagreeing with the VALUES beside it — text the pixel-distinctness gates
 * never read. The house rule is that a description is a promise about the
 * picture (app CLAUDE.md: "a false sentence in a docblock IS a defect"), so
 * these are the four promises made machine-checkable rather than re-checked by
 * eye. They are grouped in one file because they share exactly that shape, not
 * because they share a module.
 *
 * DELIBERATELY NOT GENERALISED past what was measured. "Any row saying 'soft'
 * must have blur > 0" is a tempting sweep and a bad test: it would fire on rows
 * describing a soft EDGE, a soft light or a soft colour, none of which is a
 * shadow claim. Each check below names its rows.
 */

import assert from "node:assert/strict";
import { materialDisplayName, PRESET_SECTION_MATERIAL_IDS } from "../render_gpu/skia/material_presets.js";
import { particlesPlugin } from "../plugins/particles.js";
import { comicPlugin } from "../plugins/demo/comic.js";
import { videoPlugin } from "../plugins/video.js";
import { videoScrubPlugin } from "../plugins/video_scrub.js";

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. The preset with this name, or throws — a renamed row must fail
 * LOUDLY here rather than turning the check that follows into a silent no-op.
 *
 * @param {{presets: Array<{name: string}>}} plugin - a widget plugin
 * @param {string} name - the preset's exact display name
 * @returns {{name: string, description?: string, props: object}}
 *
 * @example presetNamed({presets: [{name: "Punch", props: {}}]}, "Punch") // {name: "Punch", props: {}}
 * @example presetNamed({presets: []}, "Gone") // throws Error("no preset named \"Gone\" ...")
 */
function presetNamed(plugin, name) {
  const found = plugin.presets.find((p) => p.name === name);
  if (!found) throw new Error(`no preset named "${name}" — it was renamed or removed, so this check no longer pins anything (rows present: ${plugin.presets.map((p) => p.name).join(", ")})`);
  return found;
}

test("every material that can show a preset section has a display NAME, not its id", () => {
  // The widget-authority merge gave nine materials a Tools-pane section without
  // giving them a name, so web/app.svelte.js titled them `${id} fill presets` —
  // "rainy_window fill presets", "corkboardThumbtack fill presets". Nothing else
  // catches this: materialDisplayName's fallback is deliberate (never blank), so
  // the section renders correctly, just wearing an identifier.
  const raw = PRESET_SECTION_MATERIAL_IDS.filter((id) => materialDisplayName(id) === id);
  assert.deepEqual(raw, [],
    `these materials title their preset section with a raw id: ${raw.join(", ")} — add each to MATERIAL_DISPLAY_NAMES in render_gpu/skia/material_presets.js`);
});

test('particles "Magic Sparkle" has the zero gravity its own description claims', () => {
  // "…with no gravity of its own — an enchantment, not a physical object" shipped
  // beside particleGravityY: -6, which is the same upward-drift sign regime the
  // file's embers/steam rows use to mean buoyancy.
  const sparkle = presetNamed(particlesPlugin, "Magic Sparkle");
  assert.match(sparkle.description, /no gravity of its own/, "the description this check is pinning was rewritten — re-read the row before changing the assertion below");
  assert.equal(sparkle.props.particleGravityX, 0, '"Magic Sparkle" claims no gravity but sets particleGravityX');
  assert.equal(sparkle.props.particleGravityY, 0, '"Magic Sparkle" claims no gravity but sets particleGravityY');
});

test('video and video_scrub "Clean Borderless" ship the soft-edged shadow they describe, identically', () => {
  // Both rows shipped `blur: 0` — a HARD silhouette copy offset 14px down — under
  // a description promising a soft shadow. Their own comments also promise the two
  // families' copies are verbatim, which nothing checked either.
  const player = presetNamed(videoPlugin, "Clean Borderless");
  const scrubber = presetNamed(videoScrubPlugin, "Clean Borderless");
  for (const [family, row] of [["video", player], ["video_scrub", scrubber]]) {
    assert.match(row.description, /soft-edged shadow/, `${family} "Clean Borderless": the description this check pins was rewritten`);
    assert.ok(row.props.shadow.blur > 0,
      `${family} "Clean Borderless" describes a soft-edged shadow but ships blur ${row.props.shadow.blur} — a blur-0 shadow is a hard silhouette copy (image.js's "Magazine Bleed" is the row that ships one deliberately, and says so)`);
  }
  assert.deepEqual(scrubber.props, player.props, '"Clean Borderless" differs between video.js and video_scrub.js, whose comments promise the row is verbatim in both');
});

test("no comic rgb preset writes angleY, which the RGB branch never reads", () => {
  // comic_shader.js's RGB branch screens Red/Green/Blue from uAngleC/uAngleK/uAngleM
  // and never touches uAngleY, so an `angleY` on an rgb row is an inert key — and
  // the plugin's own comment claimed rgb "uses all four".
  const rgbRows = comicPlugin.presets.filter((p) => p.props.mode === "rgb");
  assert.ok(rgbRows.length >= 2, `expected the shipped rgb rows; found ${rgbRows.length}`);
  for (const row of rgbRows)
    assert.ok(!("angleY" in row.props), `demo_comic/"${row.name}" (mode "rgb") writes angleY, a key that mode never reads`);
});

console.log(`\n${passed} misc-preset promise tests passed`);
