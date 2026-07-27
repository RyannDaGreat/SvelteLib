/**
 * Headless CLI renderer test — proves cli/render.js renders a real document
 * end-to-end in bare Node (repair → fold → evaluate → cameraFrameIR → Skia
 * CanvasKit CPU surface → PNG), no browser/Vite/puppeteer.
 * Run: node src/demo_apps/PowerRP/tests/cli_render_test.js
 *
 * Covers: (1) a supported slide yields a valid non-trivial PNG at the default
 * size and a mid-tween alpha; (2) Phase 1b has landed — a slide whose widgets
 * emit backdrop ops (blur + magnifier) now renders a valid PNG through the same
 * Skia path (paint_skia implements blurBackdrop/magnifyBackdrop/cropSubtree/
 * effectSubtree/latexVector). This replaces the earlier Phase-1a "throws loudly"
 * bound now that those ops are implemented; and (3) the RENDER TIER contract — the
 * `--quality` escape hatch for material-laden slides is explicit, validated loudly,
 * and defaults to the editor's full quality, so a headless PNG can never quietly be
 * something other than what the editor draws.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocToPng, parseArgs, validatedQuality, heavyOpCount } from "../cli/render.js";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "demo.powerrp.json");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]; // \x89 P N G
const MIN_PNG_BYTES = 1000; // a blank/failed encode is far smaller than any real frame

/** Query. Do the first bytes match the PNG signature? */
function isPng(bytes) {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

const docJson = await readFile(DEMO, "utf8");

// (1) Slides render to valid PNGs (slide 0 full, slide 1 mid-tween) and, with
// Phase 1b landed, (2) slide 2's backdrop ops (blur + magnifier) render through
// the SAME Skia path instead of throwing the old Phase-1a bound.
for (const opts of [
  { slide: 0, alpha: 1, width: 1280, height: 720 },
  { slide: 1, alpha: 0.5, width: 640, height: 360 },
  { slide: 2, alpha: 1, width: 1280, height: 720 },
]) {
  const png = await renderDocToPng(docJson, opts);
  assert.ok(png instanceof Uint8Array, `slide ${opts.slide}: expected Uint8Array`);
  assert.ok(isPng(png), `slide ${opts.slide}: not a PNG (bad magic)`);
  assert.ok(png.length >= MIN_PNG_BYTES, `slide ${opts.slide}: PNG too small (${png.length} bytes)`);
}

// ── (3) THE RENDER TIER is explicit, validated, and defaults to the editor's ───
// A material-laden slide costs tens of seconds to minutes on this software surface,
// so `--quality proxy` exists as an escape hatch. The invariant
// RenderTree = pure(document, [[slide, alpha]]) is what makes the DEFAULT and the
// VALIDATION load-bearing: a headless PNG that is quietly not the editor's render is
// the silent lie this codebase forbids, and a mistyped tier must not choose one.

assert.deepEqual(parseArgs(["d.json", "o.png", "--slide", "2", "--alpha", "0.5"]),
  { positional: ["d.json", "o.png"], flags: { slide: 2, alpha: 0.5 } },
  "numeric flags must still be coerced with Number");
assert.deepEqual(parseArgs(["d.json", "o.png", "--quality", "proxy"]),
  { positional: ["d.json", "o.png"], flags: { quality: "proxy" } },
  "--quality must survive as a STRING — coerced to NaN it would be a silently ignored request");

assert.equal(validatedQuality("full"), "full");
assert.equal(validatedQuality("proxy"), "proxy");
for (const bad of ["prox", "FULL", "", "1", "cheap"])
  assert.throws(() => validatedQuality(bad), /unknown --quality/,
    `--quality ${JSON.stringify(bad)} must be a hard error, never a silent tier choice`);

assert.equal(heavyOpCount([{ op: "rect" }, { op: "text" }]), 0, "a plain slide has no per-pixel material ops");
assert.equal(heavyOpCount([{ op: "materialFill" }, { op: "glassBackdrop" }, { op: "rect" }]), 2);
assert.equal(heavyOpCount([{ op: "effectSubtree", content: [{ op: "materialBackdrop" }, { op: "rect" }] }]), 1,
  "a material nested in an effect costs the same and must be counted");

// The DEFAULT tier is the editor's render, and asking for it explicitly is the same
// render — byte-identical, since only the tier could differ.
const defaultTier = await renderDocToPng(docJson, { slide: 2, alpha: 1, width: 320, height: 180 });
const explicitFull = await renderDocToPng(docJson, { slide: 2, alpha: 1, width: 320, height: 180, quality: "full" });
assert.deepEqual(Array.from(defaultTier), Array.from(explicitFull),
  "the default tier must BE full quality, not merely resemble it");

// Proxy renders a valid PNG through the same pipeline, and it is a DIFFERENT image —
// which is exactly why it is reported rather than silently substituted.
const proxy = await renderDocToPng(docJson, { slide: 2, alpha: 1, width: 320, height: 180, quality: "proxy" });
assert.ok(isPng(proxy) && proxy.length >= MIN_PNG_BYTES, "proxy tier must still produce a valid PNG");
assert.notDeepEqual(Array.from(proxy), Array.from(explicitFull),
  "proxy produced byte-identical output to full on a backdrop slide — then either the stand-ins are not being used or this slide cannot detect the difference, and this check is not testing what it claims");

// A bad tier fails BEFORE any rendering happens.
await assert.rejects(() => renderDocToPng(docJson, { slide: 0, alpha: 1, width: 320, height: 180, quality: "nonsense" }), /unknown --quality/);

console.log("OK cli_render_test — slides 0/1/2 render to valid PNGs (Phase 1b backdrop ops implemented); the render tier is explicit, validated, and defaults to the editor's full quality");
