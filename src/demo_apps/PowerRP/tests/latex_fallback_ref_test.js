/**
 * A WIDGET MAY ONLY EMIT A SYNTHETIC REF IT ALSO RESERVED (workstream BD).
 * Run: node src/demo_apps/PowerRP/tests/latex_fallback_ref_test.js
 *
 * USER REPORT, 2026-08-02, night, console verbatim — a browser render job named
 * "Bloombok" died mid-job:
 *   Fetch API cannot load latex:x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}:#000000:36.
 *     URL scheme "latex" is not supported
 *   PowerRP image_registry: failed to load "latex:x = \frac{-b \pm \…" — Failed to fetch
 *   Browser render job "Bloombok" failed: Error: browser render: 2 media source(s)
 *     FAILED to load, so this frame would be written with a hole …
 *
 * ── THE MECHANISM, WHICH IS NOT WHAT THE MESSAGE LOOKS LIKE ──────────────────
 * The refusal is the DESIGNED no-holed-frames path (web/settledFrame.js) and is
 * correct. So is workstream AS's `isSyntheticImageRef` — this ref never reached
 * an exporter. It reached `fetch` through the ordinary live paint path:
 *
 *   plugins/latex.js emit() → ensureLatexTypeset(latex, scale, ink)  [RESERVES
 *       image_registry slot "latex:<latex>:<ink>:<scale>", synchronously]
 *   … then emits an image op whose ref is latexRef(latex, scale, SOME OTHER INK)
 *   render_gpu/skia/browser_media.sceneMedia → getSkiaImage(ref)
 *   render_gpu/gpu/image_registry.getSkiaImage → ensureImage(ref)
 *
 * `ensureImage` is a no-op ONLY for a ref whose slot is already reserved (read
 * reserveImageSlot's docblock — that guard is the entire reason a non-fetchable
 * ref is safe). An UNRESERVED synthetic ref falls straight through to
 * `fetch("latex:…")`, which no browser can do.
 *
 * The mismatch: the pre-glyph raster fallback hardcoded LATEX_DEFAULT_INK. That
 * is right for a SHADER ink (whose own raster is a white mask that would flash
 * blank — and emit() typesets the legacy solid alongside it for exactly this) and
 * WRONG for every other non-default ink. The user's equation was inked "#ffffff",
 * so it typeset ":#ffffff:36" and emitted ":#000000:36" — hence the ref in the
 * console, ending in the DEFAULT ink the widget never used.
 *
 * ── WHY THE CLASS SWEEP IS HERE TOO ──────────────────────────────────────────
 * "The emitted ref is one this emit reserved" is a law for every widget backed by
 * a raster registry (latex:/mermaid:/pdfpage:/scene3d:…), not a latex fact. The
 * sweep below asks it of the WHOLE roster, so a widget added tomorrow that forgets
 * its reserve fails here rather than in a user's render job.
 */

import assert from "node:assert/strict";
import { latexPlugin } from "../plugins/latex.js";
import { latexRef, LATEX_DEFAULT_INK, resetLatexRaster } from "../render_gpu/gpu/latex_raster.js";
import { imageRefs, isSyntheticImageRef } from "../render_gpu/pdf_backend.js";
import { imageStatus, resetImageRegistry } from "../render_gpu/gpu/image_registry.js";
import { allPlugins } from "../plugins/index.js";

/**
 * BOTH module-global caches, or the measurement lies — and it DID, which is why
 * this is a named function rather than one call. `ensureLatexTypeset` returns at
 * `if (typesets.has(key))` BEFORE it reaches `reserveImageSlot`, so a typeset
 * memoized under an EARLIER ink survives resetImageRegistry() and makes the next
 * ink's emit look like it reserved nothing. That reported the shader-ink case as
 * an unreserved-ref defect when the product was correct; the bug was here.
 */
function resetRasterCaches() {
  resetImageRegistry();
  resetLatexRaster();
}

let passed = 0, failed = 0;
function test(name, fn) {
  resetRasterCaches();
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e.message}`);
    failed++;
  }
}

console.log("\na widget may only emit a synthetic ref it reserved — BD\n");

/** The user's OWN equation, transcribed from the console line. */
const USER_LATEX = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
/** The user's OWN ink, read from their Bloombok deck (slide 5, item 463ab2e1). */
const USER_INK = "#ffffff";
const USER_FONT_SIZE = 36;

/**
 * The synthetic refs `plugin.emit(state)` puts in its display list, paired with
 * the registry status each had immediately after that emit. In bare node no
 * typeset can complete (MathJax needs a DOM), so "loading" is the RESERVED state
 * and "unloaded" means nothing ever claimed the ref — the fetch hazard exactly.
 */
function syntheticRefStatuses(plugin, state) {
  const commands = plugin.emit(state, null, { scale: 1 });
  return [...imageRefs(commands)]
    .filter(isSyntheticImageRef)
    .map((ref) => ({ ref, status: imageStatus(ref) }));
}

test("the user's own equation emits the ref it typeset, not the default ink's", () => {
  const state = { ...latexPlugin.defaults, latex: USER_LATEX, fontSize: USER_FONT_SIZE, ink: USER_INK };
  const refs = syntheticRefStatuses(latexPlugin, state);
  assert.equal(refs.length, 1, `one raster ref, got ${JSON.stringify(refs)}`);
  assert.equal(refs[0].ref, latexRef(USER_LATEX, USER_FONT_SIZE, USER_INK));
  assert.notEqual(refs[0].ref, latexRef(USER_LATEX, USER_FONT_SIZE, LATEX_DEFAULT_INK),
    "this is the exact ref the user's console reported being fetched");
  assert.equal(refs[0].status, "loading", "an emitted synthetic ref must already hold its registry slot");
});

test("every ink kind reserves what it emits — including the shader mask's solid twin", () => {
  const inks = [
    LATEX_DEFAULT_INK,
    "#ffffff",
    { type: "solid", solid: "#ff0000" },
    { type: "material", material: { id: "crt" } }, // a shader ink: the white MASK is unpaintable raw, so the fallback is the legacy solid — which emit() typesets alongside it
  ];
  for (const ink of inks) {
    resetRasterCaches();
    const refs = syntheticRefStatuses(latexPlugin, { ...latexPlugin.defaults, latex: "x^2", fontSize: 36, ink });
    assert.equal(refs.length, 1, `${JSON.stringify(ink)}: one raster ref, got ${JSON.stringify(refs)}`);
    assert.equal(refs[0].status, "loading",
      `ink ${JSON.stringify(ink)} emitted "${refs[0].ref}" with NO reserved slot — image_registry would fetch() it`);
  }
});

test("EVERY plugin: no emit() hands the image registry a synthetic ref it did not reserve", () => {
  const offenders = [];
  for (const plugin of allPlugins) {
    if (typeof plugin.emit !== "function" || !plugin.defaults) continue;
    resetRasterCaches();
    let refs;
    try {
      refs = syntheticRefStatuses(plugin, { ...plugin.defaults });
    } catch {
      continue; // a widget whose bare defaults cannot emit in node says nothing about this law
    }
    for (const { ref, status } of refs)
      if (status === "unloaded") offenders.push(`${plugin.type}: "${ref.slice(0, 60)}"`);
  }
  assert.deepEqual(offenders, [], `these widgets emit a synthetic ref with no registry slot, so image_registry will fetch() it:\n      ${offenders.join("\n      ")}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
