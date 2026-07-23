/**
 * Asset tile metadata-shape tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/asset_meta_test.js
 *
 * The {thumbnail?, badge?} generalization (manifest #25): asserts the ONE pure
 * decision (web/assetThumbnail.js assetTilePresentation) maps every asset kind
 * to the right tile mode, surfaces a cached thumbnail + badge when present, and
 * flags a PDF with no cached thumbnail for client rasterization. Importable in
 * bare node proves the module is DOM-free.
 */

import assert from "node:assert/strict";
import { assetTilePresentation, pageCountBadge, CLIENT_THUMBNAIL_KINDS, KIND_ICON } from "../web/assetThumbnail.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("pageCountBadge: number → text, degenerate → null", () => {
  assert.equal(pageCountBadge(5), "5");
  assert.equal(pageCountBadge(1), "1");
  assert.equal(pageCountBadge(0), null);
  assert.equal(pageCountBadge(undefined), null);
  assert.equal(pageCountBadge(NaN), null);
});

test("image → mode 'image', its own file is the thumbnail", () => {
  const p = assetTilePresentation({ kind: "image", url: "/asset/P/a.png" });
  assert.equal(p.mode, "image");
  assert.equal(p.src, "/asset/P/a.png");
  assert.equal(p.badge, null);
  assert.equal(p.needsClientThumbnail, false);
});

test("video → mode 'video' (frame captured by its own component)", () => {
  const p = assetTilePresentation({ kind: "video", url: "/asset/P/clip.mp4" });
  assert.equal(p.mode, "video");
  assert.equal(p.src, "/asset/P/clip.mp4");
});

test("pdf WITH cached thumbnail + badge → mode 'thumbnail', page-count badge + page glyph", () => {
  const p = assetTilePresentation({ kind: "pdf", url: "/asset/P/d.pdf", thumbnail: "/asset/P/.thumbs/d.pdf/9.png", badge: "5" });
  assert.equal(p.mode, "thumbnail");
  assert.equal(p.src, "/asset/P/.thumbs/d.pdf/9.png");
  assert.equal(p.badge, "5");
  assert.equal(p.badgeIcon, "mdi:file-document-outline");
  assert.equal(p.needsClientThumbnail, false);
});

test("pdf WITHOUT cached thumbnail → icon now + needsClientThumbnail flag", () => {
  const p = assetTilePresentation({ kind: "pdf", url: "/asset/P/d.pdf" });
  assert.equal(p.mode, "icon");
  assert.equal(p.icon, KIND_ICON.pdf);
  assert.equal(p.needsClientThumbnail, true);
  assert.ok(CLIENT_THUMBNAIL_KINDS.has("pdf"));
});

test("font/sound/other → kind icon, no preview, no client render", () => {
  for (const kind of ["font", "sound", "other"]) {
    const p = assetTilePresentation({ kind, url: `/asset/P/x.${kind}` });
    assert.equal(p.mode, "icon", `${kind} mode`);
    assert.equal(p.icon, KIND_ICON[kind]);
    assert.equal(p.needsClientThumbnail, false, `${kind} should not rasterize`);
  }
});

test("a generic badge is surfaced on ANY kind (future: video duration, etc.)", () => {
  const p = assetTilePresentation({ kind: "sound", url: "/asset/P/s.mp3", badge: "1:23" });
  assert.equal(p.badge, "1:23");
});

test("missing/degenerate asset → safe 'other' icon (never throws)", () => {
  const p = assetTilePresentation(undefined);
  assert.equal(p.mode, "icon");
  assert.equal(p.icon, KIND_ICON.other);
});

console.log(`\n${passed} asset-meta tests passed.`);
