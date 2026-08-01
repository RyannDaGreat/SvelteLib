/**
 * THE IR *FIELD* CONTRACT, MECHANICALLY CHECKED — a silently-dropped field fails
 * here instead of shipping a wrong picture.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * tests/ir_op_coverage_test.js gates the OP vocabulary: every op a backend must
 * understand is named and reachable. That is the coarse half. The fine half —
 * whether a backend that CLAIMS an op honours the FIELDS on it — had no gate at
 * all, and the defect it lets through has now been found four separate times:
 *
 *   1. `effectSubtree`'s innerShadow and softEdges vanished from every PDF and
 *      SVG (todo #155). Fixed with a per-field classification in pdf_backend.
 *   2. `path`'s `blur` was honoured by paint_skia and dropped by both exporters,
 *      while ir.js advertised it as "a general soft-path enhancement any consumer
 *      can reuse" (todo #219, convention ledger C-17). An agent nearly built on it.
 *   3. A MATCHED PAIR OF ROUND CAPS on an open path exported butt-capped in both
 *      backends — while opStrokeNeedsRaster's own docstring asserted verbatim that
 *      round caps stay vector because "SVG/PDF express round caps natively".
 *   4. `image`/`video`'s `src` (the edge-crop UV rect) was honoured by the PDF
 *      exporter and IGNORED by the SVG one, so a cropped image exported uncropped;
 *      and `image`'s `sampling` was not merely dropped but INVERTED in SVG (the
 *      IR default is nearest, SVG's initial image-rendering is smooth).
 *
 * Every one of those was invisible: no throw, no warning, exit 0, a wrong
 * picture. The prose was the worse half each time, because a confident comment is
 * what stops the next person checking. So the check cannot be prose.
 *
 * ── THE MEASUREMENT ──────────────────────────────────────────────────────────
 * Grep cannot answer this — a field NAME appearing in a backend proves nothing.
 * So the gate exports each op TWICE through the real irToSVG and irToPDF: once at
 * the identity, once with exactly ONE field moved off it. If both exports come
 * back byte-identical, the backend did not read the field. That is the whole
 * predicate, and it cannot be satisfied by a comment.
 *
 * A field may legitimately produce no VECTOR change — the exporters route what
 * they cannot draw to the raster fallback (opStrokeNeedsRaster, opHasMaskBlur,
 * opHasMaterialFill, opHasMirrorLinearFill). That still changes the output (a
 * raster <image> / image XObject appears), so routing passes and only a true drop
 * fails. Routing and dropping are the two things this file exists to tell apart.
 *
 * ── SCOPE, AND WHY IT IS THIS ────────────────────────────────────────────────
 * VECTOR_OPS plus `cropSubtree` — the ops an exporter draws ITSELF. An op that
 * ALWAYS rasterizes (glassBackdrop, materialBackdrop/Fill, paperCurl,
 * blurBackdrop, magnifyBackdrop, effectSubtree) has its fields honoured by the
 * GPU compositor, which a bare-node suite must stub; a stub returns the same
 * bytes whatever the field says, so testing those here would measure the stub.
 * `effectSubtree`'s fields have their own gate — pdf_backend's import-time guard
 * against RASTER_ONLY_EFFECT_FIELDS/VECTOR_SAFE_EFFECT_FIELDS.
 *
 * Nothing here enumerates a backend's behaviour by hand. The FIELD SET of each op
 * is read off the built op (Object.keys), so adding a field to a builder without
 * adding a variant for it makes this suite name the field you forgot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ir from "../render_gpu/ir.js";
import { DRAW_OPS } from "../render_gpu/ir.js";
import { irToSVG } from "../render_gpu/svg_backend.js";
import { irToPDF, VECTOR_OPS } from "../render_gpu/pdf_backend.js";
import { CHECKER_PNG_DATA_URI } from "./fixtures/checker_png.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A 1×1 transparent PNG — the raster-region stub (the pdf_backend_test fixture). */
const STUB_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
/** A REAL 64×48 image. pdf_backend treats a ≤1px embed as undrawable and skips it,
 *  which makes every image/video field read as dropped on a 1×1 stub — the harness
 *  artifact that nearly turned this gate into four false positives. */
const CHECKER_BYTES = Uint8Array.from(atob(CHECKER_PNG_DATA_URI.split(",")[1]), (c) => c.charCodeAt(0));

const OUT = {
  width: 64, height: 64, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 },
  rasterize: async () => STUB_PNG, textAscent: 0.8,
  videoFrame: async () => ({ bytes: CHECKER_BYTES, mime: "image/png" }),
  resolveImageHref: async () => CHECKER_PNG_DATA_URI,
  resolveImageBytes: async () => CHECKER_BYTES,
};
const exportSVG = (cmds) => irToSVG(cmds, OUT);
const exportPDF = async (cmds) => Buffer.from(await irToPDF(cmds, OUT)).toString("latin1");

const BOX = { x: 0, y: 0, w: 10, h: 10 };
const PAINT = { fill: "#f00", stroke: "#00f", strokeWidth: 2 };
const CROP_UV = { sx: 0.25, sy: 0.25, sw: 0.5, sh: 0.5 };

/**
 * op → {build, variants}. `build(overrides)` makes the op; each variant moves ONE
 * field off its identity. A CANONICAL-ARGUMENT TABLE IS UNAVOIDABLE and that is
 * measured, not assumed — ir_op_coverage_test.js records that 28 of ir.js's 61
 * exported builders throw when called with `{}`. What is NOT hand-maintained is
 * the FIELD LIST: the completeness test below reads it off the built op, so this
 * table cannot silently fall behind a builder.
 *
 * `openPath` is the same builder as `path` with an unclosed `d`, because a CAP is
 * only visible on a free end: core/properties.js states that a closed outline
 * drawn at full length has none, so testing caps on a closed shape measures
 * nothing. It is keyed separately and excluded from the completeness test, which
 * `path` already satisfies.
 */
const CASES = {
  rect: {
    build: (o) => ir.rect({ ...BOX, ...PAINT, ...o }),
    variants: {
      cornerRadius: { cornerRadius: 3 }, opacity: { opacity: 0.5 },
      fill: { fill: "#0f0" }, stroke: { stroke: "#0ff" }, strokeWidth: { strokeWidth: 5 },
      x: { x: 3 }, y: { y: 3 }, w: { w: 20 }, h: { h: 20 },
      strokeStart: { strokeStart: 0.2 }, strokeEnd: { strokeEnd: 0.8 }, strokePhase: { strokePhase: 0.25 },
      strokeCapStart: { strokeCapStart: "round" }, strokeCapEnd: { strokeCapEnd: "round" },
      strokeOffset: { strokeOffset: -1 }, strokeJoin: { strokeJoin: "bevel" }, strokeMiter: { strokeMiter: 8 },
    },
  },
  ellipse: {
    build: (o) => ir.ellipse({ cx: 5, cy: 5, rx: 4, ry: 3, ...PAINT, ...o }),
    variants: {
      cx: { cx: 6 }, cy: { cy: 6 }, rx: { rx: 6 }, ry: { ry: 6 }, opacity: { opacity: 0.5 },
      fill: { fill: "#0f0" }, stroke: { stroke: "#0ff" }, strokeWidth: { strokeWidth: 5 },
      strokeStart: { strokeStart: 0.2 }, strokeEnd: { strokeEnd: 0.8 }, strokePhase: { strokePhase: 0.25 },
      strokeCapStart: { strokeCapStart: "round" }, strokeCapEnd: { strokeCapEnd: "round" },
      strokeOffset: { strokeOffset: -1 }, strokeJoin: { strokeJoin: "bevel" }, strokeMiter: { strokeMiter: 8 },
    },
  },
  polyline: {
    build: (o) => ir.polyline({ points: [[0, 0], [5, 5], [10, 0]], width: 2, color: "#000", ...o }),
    variants: { points: { points: [[0, 0], [9, 9]] }, width: { width: 6 }, color: { color: "#0f0" }, opacity: { opacity: 0.5 } },
  },
  polygon: {
    build: (o) => ir.polygon({ points: [[0, 0], [10, 0], [5, 8]], fill: "#0f0", ...o }),
    variants: { points: { points: [[0, 0], [9, 0], [4, 9]] }, fill: { fill: "#00f" }, opacity: { opacity: 0.5 } },
  },
  path: {
    build: (o) => ir.path({ d: "M0 0L10 0L5 8Z", ...PAINT, ...o }),
    variants: {
      d: { d: "M0 0L9 0L4 9Z" }, fillRule: { fillRule: "evenodd" }, opacity: { opacity: 0.5 },
      fill: { fill: "#0f0" }, stroke: { stroke: "#0ff" }, strokeWidth: { strokeWidth: 5 },
      blur: { blur: 3 },
      strokeStart: { strokeStart: 0.2 }, strokeEnd: { strokeEnd: 0.8 }, strokePhase: { strokePhase: 0.25 },
      strokeCapStart: { strokeCapStart: "round" }, strokeCapEnd: { strokeCapEnd: "round" },
      strokeOffset: { strokeOffset: -1 }, strokeJoin: { strokeJoin: "bevel" }, strokeMiter: { strokeMiter: 8 },
    },
  },
  openPath: {
    build: (o) => ir.path({ d: "M0 0L10 0L5 8", ...PAINT, fill: null, ...o }),
    skipCompleteness: true,
    variants: {
      capsRoundBoth: { strokeCapStart: "round", strokeCapEnd: "round" },
      capsAsymmetric: { strokeCapStart: "round" },
      capsTaper: { strokeCapStart: "taper", strokeCapEnd: "taper" },
      blur: { blur: 3 },
    },
  },
  text: {
    build: (o) => ir.text({ text: "Hi", x: 0, y: 0, size: 12, color: "#000", ...o }),
    variants: {
      text: { text: "Yo" }, x: { x: 4 }, y: { y: 4 }, size: { size: 20 },
      color: { color: "#0f0" }, bold: { bold: true }, opacity: { opacity: 0.5 },
    },
  },
  image: {
    build: (o) => ir.image({ ref: CHECKER_PNG_DATA_URI, ...BOX, ...o }),
    variants: {
      x: { x: 4 }, y: { y: 4 }, w: { w: 20 }, h: { h: 20 }, opacity: { opacity: 0.5 },
      src: CROP_UV, sampling: { sampling: "bilinear" },
    },
  },
  video: {
    build: (o) => ir.video({ ref: "v", ...BOX, ...o }),
    variants: { x: { x: 4 }, y: { y: 4 }, w: { w: 20 }, h: { h: 20 }, opacity: { opacity: 0.5 }, src: CROP_UV },
  },
  latexVector: {
    // A NON-SQUARE box against a square viewBox, deliberately: with w === h the
    // uniform letterbox fit and the non-uniform box-to-box scale are the same
    // number, so `preserveAspect` would read as dropped when it is honoured.
    build: (o) => ir.latexVector({
      ref: "l", x: 0, y: 0, w: 10, h: 20, glyphs: [{ d: "M0 0L8 0L4 8Z", fill: "#000" }],
      viewBox: { minX: 0, minY: 0, w: 8, h: 8 }, ...o,
    }),
    variants: {
      x: { x: 4 }, y: { y: 4 }, w: { w: 20 }, h: { h: 30 }, opacity: { opacity: 0.5 },
      glyphs: { glyphs: [{ d: "M0 0L6 0L3 6Z", fill: "#f00" }] },
      preserveAspect: { preserveAspect: false },
      src: CROP_UV,
    },
  },
  cropSubtree: {
    build: (o) => ir.cropSubtree({ ...BOX, ...PAINT, content: [ir.rect({ x: 0, y: 0, w: 4, h: 4, fill: "#0f0" })], ...o }),
    variants: {
      x: { x: 2 }, y: { y: 2 }, w: { w: 20 }, h: { h: 20 },
      cornerRadius: { cornerRadius: 3 }, opacity: { opacity: 0.5 },
      fill: { fill: "#0f0" }, stroke: { stroke: "#0ff" }, strokeWidth: { strokeWidth: 5 },
      content: { content: [ir.rect({ x: 0, y: 0, w: 6, h: 6, fill: "#00f" })] },
      strokeStart: { strokeStart: 0.2 }, strokeEnd: { strokeEnd: 0.8 }, strokePhase: { strokePhase: 0.25 },
      strokeCapStart: { strokeCapStart: "round" }, strokeCapEnd: { strokeCapEnd: "round" },
      strokeOffset: { strokeOffset: -1 }, strokeJoin: { strokeJoin: "bevel" }, strokeMiter: { strokeMiter: 8 },
    },
  },
};

/**
 * Fields that are STRUCTURE rather than a knob a backend could honour or drop.
 * Listed so the completeness test can tell "not a field" from "a field with no
 * variant" — the EFFECT_STRUCTURAL_FIELDS idea (pdf_backend.js) at op scope.
 */
const STRUCTURAL_FIELDS = new Set([
  "op",
  "ref",       // the media-registry key; changing it changes the ASSET, not the drawing
  "viewBox",   // latexVector's glyph coordinate frame — exercised through `glyphs`
  "font",      // exercised by the font-embedding suites, and it warns loudly when unresolvable
  "rich", "boxW", "boxH", "boxStyle", // rich text has its own layout parity suites
]);

/**
 * MEASURED EXPORT BOUNDS: (op.field → why) pairs whose export is knowingly
 * unchanged. Every entry is a real limitation with a reason, NOT a place to park
 * a bug — and the suite asserts the list has no STALE entries, so fixing a bound
 * without deleting its line here is also red. The list may only shrink.
 */
const KNOWN_EXPORT_BOUNDS = {
  "image.sampling:pdf":
    "pdf-lib has no /Interpolate support, so a bilinear image exports at PDF's default (nearest). " +
    "PDF's default matches the IR's default, so only the rarer bilinear case is affected. " +
    "Fixing it means setting /Interpolate on the embedded XObject dict directly AND keying the " +
    "embed cache by (ref, sampling), since one ref may be drawn at two filters.",
};

/** Pure function. Does this export string contain an embedded raster tile — i.e.
 * did the backend ROUTE the op to its general raster fallback rather than drop it?
 *
 * @example hasRasterEmbed('<image href="data:image/png;base64,AA"/>') // true
 * @example hasRasterEmbed("<rect/>") // false
 */
function hasRasterEmbed(out) {
  return /<image[^>]*href="data:image\/png/.test(out) || /\/Subtype\s*\/Image/.test(out);
}

test("no IR field is SILENTLY DROPPED by a vector exporter", async () => {
  const found = [];
  const seen = new Set();
  const refused = new Set();
  for (const [opName, { build, variants }] of Object.entries(CASES)) {
    const baseOp = build({});
    const [baseSvg, basePdf] = [await exportSVG([baseOp]), await exportPDF([baseOp])];
    for (const [field, overrides] of Object.entries(variants)) {
      // A builder that REFUSES the value is the loudest possible non-drop: the op
      // cannot carry a field no backend can honour, so nothing reaches an exporter
      // to be dropped. It is NOT a free skip, though — an unexpected throw here
      // would be a broken canonical argument quietly excusing a field from the
      // sweep, so only the DECLARED refusals are tolerated and everything else
      // fails with the builder's own message.
      let variantOp;
      try {
        variantOp = build(overrides);
      } catch (e) {
        assert.ok(BUILDER_REFUSED.has(`${opName}.${field}`),
          `${opName}.${field}: the builder threw and this is not a declared refusal, so the sweep silently skipped the field — fix the canonical arguments, or add the key to BUILDER_REFUSED if the refusal is the intended behaviour: ${e.message}`);
        refused.add(`${opName}.${field}`);
        continue;
      }
      const outs = { svg: await exportSVG([variantOp]), pdf: await exportPDF([variantOp]) };
      const bases = { svg: baseSvg, pdf: basePdf };
      for (const backend of ["svg", "pdf"]) {
        const key = `${opName}.${field}:${backend}`;
        if (outs[backend] !== bases[backend]) {
          // Routing to the raster fallback IS honouring the field; note it so the
          // stale-entry check below can tell a fixed bound from a live one.
          seen.add(key);
          continue;
        }
        if (key in KNOWN_EXPORT_BOUNDS) continue;
        found.push(`${key} — moving this field left the ${backend.toUpperCase()} export byte-identical` +
          (hasRasterEmbed(outs[backend]) ? "" : " and produced no raster tile, so it was neither drawn nor routed"));
      }
    }
  }
  assert.deepEqual(found, [],
    "a vector exporter neither DREW these fields nor ROUTED them to its raster fallback — they are silently dropped, " +
    "which exports a wrong picture at exit 0. Either express the field, or add a routing predicate beside " +
    "opStrokeNeedsRaster / opHasMaskBlur so the op rasterizes, or (only for a real limitation) record it in " +
    "KNOWN_EXPORT_BOUNDS with the reason and the shape of the fix");
  for (const key of Object.keys(KNOWN_EXPORT_BOUNDS))
    assert.ok(!seen.has(key),
      `KNOWN_EXPORT_BOUNDS still lists ${key}, but the export now CHANGES when that field moves — the bound was fixed. Delete the entry; this list may only shrink.`);
  assert.deepEqual([...BUILDER_REFUSED].filter((k) => !refused.has(k)), [],
    "BUILDER_REFUSED names these, but the builder ACCEPTED the value — either the guard was removed (in which case the field is droppable again and needs a real check) or the entry is stale");
});

/**
 * `op.field` keys whose BUILDER refuses the non-identity value outright, so the
 * field can never reach an exporter to be dropped. The strongest resolution
 * available for a field no backend can honour, and the reason each is here:
 *
 *   latexVector.src — the SVG/PDF backends map every glyph into the box with no
 *     source-sub-rect clip. plugins/latex.js already emits a plain raster image()
 *     whenever the crop is live, which is why the drop was never SEEN; the op now
 *     enforces that rule itself instead of trusting one caller's discipline.
 */
const BUILDER_REFUSED = new Set(["latexVector.src"]);

test("every field of every covered op has a variant — the table cannot fall behind a builder", () => {
  const missing = [];
  for (const [opName, { build, variants, skipCompleteness }] of Object.entries(CASES)) {
    if (skipCompleteness) continue;
    for (const field of Object.keys(build({})))
      if (!STRUCTURAL_FIELDS.has(field) && !(field in variants)) missing.push(`${opName}.${field}`);
  }
  assert.deepEqual(missing, [],
    "these fields exist on a built op but no variant moves them, so nothing here would notice if a backend dropped one. " +
    "Add a variant to CASES, or STRUCTURAL_FIELDS if the field is not a drawable knob");
});

test("every op the exporters draw as VECTOR is covered by this suite", () => {
  // cropSubtree is not in VECTOR_OPS but has its own emitCrop/emitCropSVG rather
  // than taking the raster fallback, so its fields face the same question.
  const drawnAsVector = new Set([...VECTOR_OPS, "cropSubtree"]);
  const covered = new Set(Object.keys(CASES));
  const uncovered = [...drawnAsVector].filter((op) => !covered.has(op) && !UNCOVERED_VECTOR_OPS.has(op)).sort();
  assert.deepEqual(uncovered, [],
    "these ops are drawn as VECTOR by the exporters but no case here checks their fields — add one to CASES");
  for (const op of UNCOVERED_VECTOR_OPS)
    assert.ok(drawnAsVector.has(op), `UNCOVERED_VECTOR_OPS names "${op}", which is no longer drawn as vector — delete the entry`);
});

/**
 * Vector-claimed ops this suite deliberately does not sweep, each for a reason
 * that is about the OP, not about effort.
 */
const UNCOVERED_VECTOR_OPS = new Set([
  // Both exporters draw NOTHING for it, on purpose and identically: its <video>
  // lives in a browser-only registry unreachable from an export grab. Every field
  // is therefore "dropped" and the sweep would only restate a documented whole-op
  // bound. (That the bound is silent at runtime is a separate, reported finding.)
  "videoV5",
]);

test("ir.js's command-schema docblock names every DRAW_OP", () => {
  // The docblock is the schema reference a widget author reads. It had drifted the
  // same way DRAW_OPS had — `path`, `paperCurl`, `materialFill` and all four video
  // variants were absent, so `path`'s own fields (including the blur that started
  // todo #219) were undocumented at the one place documenting the IR.
  const src = readFileSync(resolve(appRoot, "render_gpu/ir.js"), "utf8");
  const header = src.slice(0, src.indexOf("\n */"));
  const undocumented = DRAW_OPS.filter((op) => !header.includes(`{op:"${op}"`)).sort();
  assert.deepEqual(undocumented, [],
    "these ops are in DRAW_OPS but absent from ir.js's `{op:\"…\"}` command-schema docblock");
});
