/**
 * THE BUILT-IN CLIP-ART LIBRARY (web/builtinClipart.js) — the third built-in
 * asset category, and the home of the drawings that are NOT shapes.
 *
 * `lightning` is here rather than in the shapeshifter families because it has no
 * parameter worth exposing (user: "maybe better as a preset for an SVG"). This
 * suite asserts the two things that makes true: the asset is really present and
 * loadable in BARE NODE (so the CLI renderer and every headless path can reach
 * it, not just the browser bundle), and its geometry is the retired legacy bolt
 * VERBATIM — retiring System A must not quietly redraw the artwork.
 */

import assert from "node:assert";
import { CLIPART_NAMES, builtinClipartAssets, clipartSource, clipartNameFromPath } from "../web/builtinClipart.js";
import { shapePath } from "../core/shapes.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

test("loads in BARE NODE off the committed files (not only the browser glob)", () => {
  const assets = builtinClipartAssets();
  assert.ok(assets.length >= 1, "the clip-art library is not empty");
  assert.deepEqual(assets.map((a) => a.name).sort(), CLIPART_NAMES.map((n) => `${n}.svg`).sort(),
    "the loaded files and the static CLIPART_NAMES list agree");
});

test("every entry has the ASSET-LIST shape the Explorer and the drop handler read", () => {
  for (const a of builtinClipartAssets()) {
    assert.equal(a.kind, "image", `${a.name}: kind`);
    assert.equal(a.builtin, true, `${a.name}: marked built-in (no delete affordance)`);
    assert.ok(a.url.startsWith("data:image/svg+xml;base64,"), `${a.name}: self-contained data URI, no server route`);
    assert.ok(typeof a.src === "string" && a.src.includes("<svg"), `${a.name}: carries the raw SVG source`);
    assert.ok(a.size > 0, `${a.name}: truthful byte size for the totals line`);
  }
});

test("LIGHTNING IS THE LEGACY BOLT VERBATIM — the artwork did not change", () => {
  const src = clipartSource("lightning");
  const legacy = shapePath("lightning", 100, 100);
  assert.ok(src.includes(legacy),
    `the clip-art must carry the retired preset's exact path data\n  want substring: ${legacy}\n  got: ${src}`);
  assert.ok(/viewBox="0 0 100 100"/.test(src), "authored in the same 100x100 box the legacy generator used");
});

test("an unknown name throws LOUDLY rather than drawing nothing", () => {
  assert.throws(() => clipartSource("no-such-clipart"), /unknown built-in clip-art/);
});

test("clipartNameFromPath strips the directory and the extension", () => {
  assert.equal(clipartNameFromPath("../assets/builtin/clipart/lightning.svg"), "lightning");
  assert.equal(clipartNameFromPath("lightning.svg"), "lightning");
  assert.equal(clipartNameFromPath("README"), "README");
});

console.log(`\n${passed} built-in clip-art tests passed`);
