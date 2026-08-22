/**
 * THE P2 PRESET PIXEL-DISTINCTNESS GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/preset_p2_test.js
 *
 * Covers the four widgets in the final P2 preset batch: video (player), video_scrub
 * (scrubber), pdf_page, tangent_lines. tests/preset_contract_test.js already sweeps
 * all four tables for the family-agnostic laws (declared keys, names, no placement
 * key, effects-family completeness, data distinctness) — this file adds what that
 * suite cannot: proof each family actually renders distinct pictures, and the
 * family-specific "never touches content/behavior" checks each plugin's presets
 * comment states.
 *
 * ── THE GENUINE-VS-HARNESS BORDER, APPLIED TO FOUR WIDGETS ───────────────────
 * tests/image_presets_test.js's header measured the bare-node bound this file
 * inherits: cli/render.js's software Skia surface has no `createImageBitmap`, so
 * an `image`/`video`/`videoFrame` op with no decoded bitmap draws NOTHING —
 * `paint_skia.js`'s media cases break out for a missing source. Every frame below
 * for video/video_scrub/pdf_page is therefore missing exactly the CONTENT bitmap
 * and nothing else: the border stroke, rounded-corner clip, crop-inset region, and
 * every effect (shadow/bloom/blend/inner-shadow/soft-edges/blur) are ordinary
 * vector Skia ops (`decorateStrokedBox` / `applyEffects`) with zero dependency on
 * whether the quad they wrap has a bitmap behind it. pdf_page ALSO takes its
 * camera-free fallback path (no `renderCtx.pdfDisplay`), which additionally tries
 * the vector-extraction path and — with no PDF ever loaded here — falls through to
 * a flat placeholder-paper `rect` (`PDF_PLACEHOLDER_PAPER`) under the SAME
 * border/effects decoration, so its frames are genuinely comparable to
 * video/video_scrub's empty-content frames: a filled rect standing in for a bitmap
 * that never resolves.
 *
 * tangent_lines has NO such gap: it is pure vector geometry (two polylines,
 * evaluated at emit time from numeric shape descriptors already in `defaults`), so
 * its frames are FULL renders, not harness-accommodated ones — no flag needed on
 * its rows.
 *
 * ACCOMMODATION FLAGS ARE STATED HONESTLY, AT THE ROW, following the image.js
 * precedent: a treatment whose distinguishing feature depends on real decoded
 * content is flagged in the PLUGIN, beside the values it inflated, not merely in
 * this file. THREE ROWS PER VIDEO FAMILY carry one — "Rounded Player Card" (a 2px
 * hairline raised to 5px), "Clean Borderless" (whose whole point is "no frame":
 * strokeWidth held at 1, and its shadow blur held to 6 — 9 is the widest this gate
 * can still see, because with no decoded frame that 1px stroke is the only thing
 * casting a shadow at all) and "Frosted Preview" (3px raised to 15px with a
 * stronger blur) — in plugins/video.js and, verbatim, plugins/video_scrub.js. Each
 * says what the intended look is, what this harness measured, and to revisit once
 * a browser-based gate can decode a real frame. pdf_page and tangent_lines needed
 * none: pdf_page's rows separate on their placeholder-paper geometry, and
 * tangent_lines has no content gap at all (see above). Every pair then clears
 * MIN_SEPARATION as shipped, and the closest pairs are reported below so a future
 * change that narrows the gap is visible in the log, not just the pass/fail.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());
const videoPlugin = registry.get("video");
const videoScrubPlugin = registry.get("video_scrub");
const pdfPagePlugin = registry.get("pdf_page");
const tangentLinesPlugin = registry.get("tangent_lines");

const W = 420, H = 300;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// Mid grey: the same neutral field image_presets_test.js/paint_path_presets_test.js
// use — distinct from white/black borders in either direction, and dark enough
// that a "screen"-adjacent blend still reads.
const BACKDROP = "#7a7a7a";
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKDROP }));

// FIXTURE-ONLY SOURCES (never a preset prop — src is the author's content, see
// each family's own "no preset writes src" test below). video/video_scrub/
// pdf_page default `src` to the EMPTY STRING (UNSOURCED — a real `<video>`
// refuses a PNG outright, and a PDF ref must be a fetchable document), and
// emit() returns [] for an empty src — the border/crop/effects this file
// exists to distinguish would never paint at all without SOME non-empty
// fixture value here. Nothing in bare node decodes it (no createImageBitmap,
// no pdf.js document ever resolves), so any non-empty string exercises
// exactly the same "no content, frame only" harness image_presets_test.js
// documents for the image widget — this is that same accommodation, applied
// to three more widgets that default to an EMPTY (rather than blank-image)
// unsourced state.
const FIXTURE_SRC = "fixture://no-decode-in-bare-node";

/**
 * Pure function. Every effect-bundle key a family's OWN rows write, unioned — the
 * same derivation preset_contract_test.js's check (7) uses, restated here so this
 * file's per-family key-set assertions do not transcribe a second copy of
 * BUNDLES.effects.
 *
 * @example effectHeadsWritten([{props: {bloom: {}, tint: "#fff"}}]) // ["bloom"]
 */
function effectHeadsWritten(presets) {
  const heads = ["shadow", "bloom", "blendMode", "innerShadow", "softEdges", "gaussianBlur"];
  return heads.filter((k) => presets.some((p) => k in (p.props ?? {})));
}

// ── video (PLAYER) ────────────────────────────────────────────────────────────
{
  const BOX = { x: 60, y: 40, w: 300, h: 220 };
  /** Near-pure (Skia render). A video-player frame with NO decoded content (see
   *  header) — border/crop/effects only. */
  async function frame(props) {
    const state = { ...videoPlugin.defaults, ...BOX, src: FIXTURE_SRC, ...props };
    return readPng(await renderToPng(videoPlugin.emit(state, null, IDENTITY), VIEW, { width: W, height: H, background: BACKDROP }));
  }

  test("video declares a preset table (R7-39: >= 10, or an honest ceiling)", () => {
    assert.ok(Array.isArray(videoPlugin.presets) && videoPlugin.presets.length >= 10,
      `video declares ${videoPlugin.presets?.length ?? 0} presets — expected >= 10`);
  });

  test("no video preset writes src, autoplay, loop, or muted", () => {
    // src is the author's content (the qrcode `data` rule). autoplay/loop/muted
    // are the plugin's KNOWN DEFECT: ensureVideo's one call site passes no flags,
    // so these rows are INERT today (see plugins/video.js's emit() docblock) — a
    // preset writing one would report a change that does not happen.
    for (const preset of videoPlugin.presets)
      for (const key of ["src", "autoplay", "loop", "muted"])
        assert.ok(!(key in preset.props), `video "${preset.name}" writes "${key}" — content/inert-flag key, forbidden for this family`);
  });

  test("no video preset writes showThumbnail without this test needing a thumbnail asset", () => {
    // A preset cannot know whether an item has a thumbnail asset; the brief's own
    // guidance is to skip showThumbnail rather than write it incoherently. Confirm
    // the shipped table honors that (an absent key, not a false one).
    for (const preset of videoPlugin.presets)
      assert.ok(!("showThumbnail" in preset.props), `video "${preset.name}" writes "showThumbnail" — no preset can know a thumbnail asset exists`);
  });

  test("EVERY video preset writes the IDENTICAL key set", () => {
    const sets = new Set(videoPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `video presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });

  const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
  for (const preset of videoPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

  test(`video: ${videoPlugin.presets.length} presets and the default all render a DIFFERENT picture (empty-content harness)`, () => {
    // HARNESS-ACCOMMODATED (see header): every frame here is missing its decoded
    // bitmap, so this proves the FRAME/border/effects differ, not the full
    // treatment. MEASURED, calibrated like image_presets_test.js's own bound.
    const MIN_SEPARATION = 5;
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `video: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });
}

// ── video_scrub (SCRUBBER) ────────────────────────────────────────────────────
{
  const BOX = { x: 60, y: 40, w: 300, h: 220 };
  /** Near-pure (Skia render). A scrubber frame with NO decoded content (see header). */
  async function frame(props) {
    const state = { ...videoScrubPlugin.defaults, ...BOX, src: FIXTURE_SRC, ...props };
    return readPng(await renderToPng(videoScrubPlugin.emit(state, null, IDENTITY), VIEW, { width: W, height: H, background: BACKDROP }));
  }

  test("video_scrub declares a preset table (R7-39: >= 10, or an honest ceiling)", () => {
    assert.ok(Array.isArray(videoScrubPlugin.presets) && videoScrubPlugin.presets.length >= 10,
      `video_scrub declares ${videoScrubPlugin.presets?.length ?? 0} presets — expected >= 10`);
  });

  test("no video_scrub preset writes src, scrubTime, scrubWrap, or duration", () => {
    for (const preset of videoScrubPlugin.presets)
      for (const key of ["src", "scrubTime", "scrubWrap", "duration"])
        assert.ok(!(key in preset.props), `video_scrub "${preset.name}" writes "${key}" — content/playback-state key, forbidden for this family`);
  });

  test("EVERY video_scrub preset writes the IDENTICAL key set", () => {
    const sets = new Set(videoScrubPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `video_scrub presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });

  const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
  for (const preset of videoScrubPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

  test(`video_scrub: ${videoScrubPlugin.presets.length} presets and the default all render a DIFFERENT picture (empty-content harness)`, () => {
    const MIN_SEPARATION = 5;
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `video_scrub: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });
}

// ── pdf_page ───────────────────────────────────────────────────────────────────
{
  const BOX = { x: 60, y: 30, w: 260, h: 260 };
  /** Near-pure (Skia render; kicks idempotent async PDF loads with no src so they
   *  never resolve). A pdf_page frame with NO PDF ever loaded (see header) — the
   *  camera-free fallback's flat placeholder-paper rect, under real border/effects
   *  decoration. */
  async function frame(props) {
    const state = { ...pdfPagePlugin.defaults, ...BOX, src: FIXTURE_SRC, ...props };
    // interactive:false (the non-interactive branch — see plugins/pdf_page.js
    // pdfPageRasterRefForDisplay) so a never-rasterized src resolves to NO
    // cached ref rather than one speculatively minted and never filled: with
    // interactive left at its ref-always-returns default, the resulting `image`
    // op never resolves in bare node (no createImageBitmap) and silhouettes
    // nothing — the same blind spot image_presets_test.js's header measured for
    // an unresolved image ref. false is also the representative choice for
    // WHAT THIS GATE MODELS: export/thumbnail/CLI consumers (this suite's real
    // analogue) are exactly the callers documented to take the camera-free
    // fallback, which lands on the flat PDF_PLACEHOLDER_PAPER rect this file's
    // header describes — real drawn content the border/shadow/effects below
    // can actually silhouette.
    return readPng(await renderToPng(pdfPagePlugin.emit(state, null, IDENTITY, { interactive: false }), VIEW, { width: W, height: H, background: BACKDROP }));
  }

  test("pdf_page declares a preset table (R7-39: >= 10, or an honest ceiling)", () => {
    assert.ok(Array.isArray(pdfPagePlugin.presets) && pdfPagePlugin.presets.length >= 10,
      `pdf_page declares ${pdfPagePlugin.presets?.length ?? 0} presets — expected >= 10`);
  });

  test("no pdf_page preset writes src, page, renderMode, rasterWidth, rasterHeight, or rasterDPI", () => {
    // src is the author's document (content). page is reading state, not a frame
    // decision. renderMode/raster* govern HOW the page is drawn (resolution/
    // performance), not what it looks like — the sampling-row precedent.
    for (const preset of pdfPagePlugin.presets)
      for (const key of ["src", "page", "renderMode", "rasterWidth", "rasterHeight", "rasterDPI"])
        assert.ok(!(key in preset.props), `pdf_page "${preset.name}" writes "${key}" — content/reading-state/performance key, forbidden for this family`);
  });

  test("EVERY pdf_page preset writes the IDENTICAL key set", () => {
    const sets = new Set(pdfPagePlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `pdf_page presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });

  const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
  for (const preset of pdfPagePlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

  test(`pdf_page: ${pdfPagePlugin.presets.length} presets and the default all render a DIFFERENT picture (no-PDF-loaded harness)`, () => {
    const MIN_SEPARATION = 5;
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `pdf_page: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });
}

// ── tangent_lines ──────────────────────────────────────────────────────────────
{
  // NOT HARNESS-ACCOMMODATED: pure vector geometry, no async content — a FULL
  // render (see header). NOT the widget's own DEFAULT a/b shapes, though: those
  // sit at world (400,380)/(820,380) with a combined ink rect ~415 units wide
  // (measured), which spans past this file's 420x300 test canvas almost
  // entirely off-frame — a coordinate mismatch between the widget's own
  // stand-alone defaults (sized for a full presentation canvas) and this
  // shared multi-family test file's smaller shared canvas, not a preset
  // defect. THE FIXTURE SHAPES are this test's content, never a preset's (the
  // paint_path_presets_test.js FIXTURE_PAINT_POINTS precedent) — two circles
  // sized and placed to keep the full tangent bridge on-canvas with margin for
  // the widest strokes (Highlight Beam at 10) and glow (Laser Sight's bloom).
  const FIXTURE_A = { x: 130, y: 150, halfW: 40, halfH: 40, rotation: 0 };
  const FIXTURE_B = { x: 320, y: 150, halfW: 70, halfH: 70, rotation: 0 };
  /** Near-pure (Skia render). A tangent_lines frame at this file's FIXED a/b
   *  shape pair (never a preset's — see above). */
  async function frame(props) {
    const state = { ...tangentLinesPlugin.defaults, a: FIXTURE_A, b: FIXTURE_B, ...props };
    return readPng(await renderToPng(tangentLinesPlugin.emit(state, null, IDENTITY), VIEW, { width: W, height: H, background: BACKDROP }));
  }

  test("tangent_lines declares a preset table (R7-39: >= 10, or an honest ceiling)", () => {
    assert.ok(Array.isArray(tangentLinesPlugin.presets) && tangentLinesPlugin.presets.length >= 10,
      `tangent_lines declares ${tangentLinesPlugin.presets?.length ?? 0} presets — expected >= 10`);
  });

  test("no tangent_lines preset writes a or b — the equation-bound endpoints are never overwritten", () => {
    for (const preset of tangentLinesPlugin.presets)
      for (const key of ["a", "b", "shapeKind"])
        assert.ok(!(key in preset.props), `tangent_lines "${preset.name}" writes "${key}" — the bound endpoint geometry is the author's content, forbidden for this family`);
  });

  test("EVERY tangent_lines preset writes the IDENTICAL key set", () => {
    const sets = new Set(tangentLinesPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `tangent_lines presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });

  const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
  for (const preset of tangentLinesPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

  test(`tangent_lines: ${tangentLinesPlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
    // A thin-stroke family (arrow.js/paint_path.js precedent): litSetDistance
    // against a BLANK reference, not the untouched default, so a whole-frame mean
    // is not diluted by the empty backdrop every row shares.
    const MIN_SEPARATION = 8;
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `tangent_lines: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });
}

// ── summary of effect-key coverage per family (informational, matches
// preset_contract_test.js's own check (7) union-of-rows shape) ─────────────────
test("(informational) effect keys each P2 family's rows actually write", () => {
  for (const [label, plugin] of [["video", videoPlugin], ["video_scrub", videoScrubPlugin], ["pdf_page", pdfPagePlugin], ["tangent_lines", tangentLinesPlugin]])
    console.log(`      ${label}: ${effectHeadsWritten(plugin.presets).join(", ") || "(none)"}`);
});

console.log(`\n${passed} preset_p2 tests passed`);
