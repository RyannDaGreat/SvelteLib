/**
 * THE OFF PAINT + THE SVG/ICONIFY FILL OVERRIDE — bare-node guards.
 * Run: node src/demo_apps/PowerRP/tests/paint_off_test.js
 *
 * The user ruling this pins (verbatim intent): "SVGs, including the iconify icon,
 * should have a fill material. Fill materials should have an option of off … which
 * basically just means nothing, there is no fill. And in the case of an SVG, that
 * means it just keeps the default. We need to be able to color them, because right
 * now it's just always black."
 *
 * WHAT IT PROVES
 *
 *   (A) THE OFF PAINT IS FIRST CLASS, generally.
 *       - {type:"none"} parses to the SAME null an ABSENT paint does, so every
 *         backend's existing `if (cmd.fill)` guard emits no fill op — the off state
 *         costs the painters zero new code, which is a claim worth a test because
 *         the alternative (a new paint kind each backend must learn) is what we
 *         deliberately did not build.
 *       - it ROUND-TRIPS through JSON and survives repairedDocument with ZERO
 *         reports on every widget that declares it.
 *       - it is NOT `null`. That is the load-bearing design decision: core/deltas.js
 *         NONE === null is the DELETE sentinel, so a null fill leaf would REMOVE the
 *         key and fall back to the previous slide / the plugin default instead of
 *         meaning "off here". Pinned by asserting exactly that, so nobody
 *         "simplifies" the tag away.
 *       - it TWEENS DISCRETELY (a colour → off switches at alpha > 0, never a
 *         half-off intermediate), which falls out of the shape-mismatch rule in
 *         core/interpolators.js and is asserted rather than assumed.
 *       - a hollow shape: an off fill on a rect emits a rect op with fill null and
 *         its stroke intact (stroke-only, the "shape becomes hollow" requirement).
 *
 *   (B) SVG FILL OFF IS BYTE-IDENTICAL — THE REGRESSION GATE.
 *       The flatten with `overridePaint: null` (and with the option ABSENT, which is
 *       what a pre-row document produces) deep-equals the flatten of the same
 *       artwork with no override at all, op for op. This is the gate that says
 *       "adding this row changed no existing pixel".
 *
 *   (C) SVG FILL ON RECOLOURS EVERYTHING, including strokes.
 *       Both a FILLED shape and a STROKED (fill="none" stroke="currentColor") shape
 *       take the override — the stroked half matters because half the icon sets are
 *       authored that way, so a fill-only override would read as a broken control.
 *       An UNPAINTED slot stays unpainted (the override replaces paint, never adds
 *       it — filling in an outline icon's interior would be new ink the artist never
 *       drew).
 *
 *   (D) ICONIFY INHERITS THE ROW, by sharing ONE declaration.
 *       Not "has a row of the same name" — the SAME object, so the two widgets
 *       cannot drift on the property name, category, off semantics or help text.
 *       And their ink help is the shared string that names the fill relationship,
 *       because the pair is only comprehensible read together (the "why is it
 *       black?" answer).
 *
 *   (E) A MATERIAL NEVER REACHES A SLOT ITS REGISTRY CANNOT PAINT — the crash gate.
 *       THE LIVE BUG: choosing fill material "crt" on an iconify icon threw
 *       `getStrokeMaterial: unknown stroke material "crt"` EVERY FRAME and killed the
 *       canvas. Cause: (C) above puts the override in the fill AND stroke slot by
 *       design, but fill materials and STROKE materials are two registries with
 *       DISJOINT rosters, and each painter looks up only its own — paint_skia's
 *       drawMaterialStroke calls getStrokeMaterial, its fill twin calls getMaterial,
 *       both unconditionally. The monochrome icon sets make this the COMMON case, not
 *       a corner: they draw fill="none" stroke="currentColor", so on a tabler/lucide
 *       icon the override lands ONLY in stroke slots.
 *
 *       THE ASYMMETRY RUNS BOTH WAYS, and the first fix here only guarded one of them.
 *       A STROKE-only material ("wavy", "brush") in a FILL slot throws just as hard —
 *       caught only because the browser probe rendered the stroke-capable control, and
 *       pinned below so a one-directional guard cannot come back.
 *
 *       The rule pinned here: EACH SLOT ASKS ITS OWN REGISTRY; a material that slot
 *       cannot paint degrades to the paint's own `solid` fallback, reporting ONCE; a
 *       material the slot CAN paint passes through by identity; and capability is asked
 *       of the REGISTRIES, never of a hardcoded name list.
 */

import assert from "node:assert/strict";
import { parsePaint, isPaintOff, PAINT_NONE_TYPE, rect, path, ellipse, polygon } from "../render_gpu/ir.js";
import { vectorCommandToSVG } from "../render_gpu/svg_backend.js";
import { paintOp } from "../render_gpu/pdf_backend.js";
import { flattenSvgTree } from "../core/svg_paths.js";
import { overridePaintOf } from "../core/svg_paths.js";
import { applied, NONE, blendApplied } from "../core/deltas.js";
import { interpolate } from "../core/interpolators.js";
import { svgPlugin } from "../plugins/svg.js";
import { iconifyPlugin } from "../plugins/iconify.js";
import { SVG_FILL_ROW, SVG_FILL_OFF, SVG_INK_HELP, svgOverridePaint, svgOverrideSlotPaint, svgFillOff } from "../render_gpu/gpu/svg_raster.js";
import { getStrokeMaterial, hasStrokeMaterial, strokeMaterialIds } from "../render_gpu/skia/stroke_materials.js";
import { getMaterial, fillCapableMaterialIds } from "../render_gpu/skia/materials.js";
import { readFileSync } from "node:fs";
import { repairedDocument, uuid } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** A tiny artwork exercising BOTH paint shapes an icon set uses: a FILLED rect (the
 *  mdi/solid convention) and a STROKED open path with fill="none" (the tabler/lucide
 *  convention, and the shape a fill-only override would have missed). */
const ART = {
  tag: "svg",
  attrs: { viewBox: "0 0 10 10" },
  children: [
    { tag: "rect", attrs: { width: "10", height: "10", fill: "currentColor" }, children: [] },
    { tag: "path", attrs: { d: "M1 1L9 9", fill: "none", stroke: "currentColor", "stroke-width": "2" }, children: [] },
  ],
};
const BOX = 20;
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

// ── (A) THE OFF PAINT ────────────────────────────────────────────────────────

test("parsePaint({type:'none'}) === null — the SAME null an absent paint gives", () => {
  // This equality IS the reason the off state needed no backend work: every
  // painter/exporter already branches on a null fill.
  assert.equal(parsePaint({ type: PAINT_NONE_TYPE }), null);
  assert.equal(parsePaint(null), null);
  assert.equal(parsePaint(undefined), null);
  // The multi-sub-state form (other modes remembered) parses to null just the same —
  // the render never sees the stashed colours.
  assert.equal(parsePaint({ type: "none", solid: "#ff0000", linear: { stops: [] }, radial: { stops: [] } }), null);
});

test("isPaintOff distinguishes OFF from absent and from every other mode", () => {
  assert.equal(isPaintOff({ type: PAINT_NONE_TYPE }), true);
  assert.equal(isPaintOff({ type: "none", solid: "#f00" }), true);
  assert.equal(isPaintOff(null), false, "an ABSENT paint is not an OFF one");
  assert.equal(isPaintOff("#ff0000"), false);
  assert.equal(isPaintOff({ type: "solid", solid: "#f00" }), false);
  assert.equal(isPaintOff({ type: "linearGradient", linear: { stops: [] } }), false);
  assert.equal(isPaintOff({ type: "material", material: { id: "comic" } }), false);
});

test("an OFF fill emits NO fill op on a plain shape — the shape is HOLLOW, stroke intact", () => {
  const hollow = rect({ x: 0, y: 0, w: 10, h: 5, fill: { type: PAINT_NONE_TYPE }, stroke: "#000000", strokeWidth: 2 });
  assert.equal(hollow.fill, null, "no fill paint reaches the display list");
  assert.deepEqual(hollow.stroke, [0, 0, 0, 1], "the stroke is untouched — stroke-only is the point");
  assert.equal(hollow.strokeWidth, 2);
  // And it is byte-identical to the same shape authored with no fill at all, which is
  // what makes "off" and "there is no fill" the same picture.
  assert.deepEqual(hollow, rect({ x: 0, y: 0, w: 10, h: 5, fill: null, stroke: "#000000", strokeWidth: 2 }));
});

test("EVERY vector backend actually OMITS the fill op — verified, not assumed", () => {
  // The brief's standing requirement, and the reason it is a requirement: the OFF
  // paint's whole design is "parsePaint → null, and every backend's existing
  // `if (cmd.fill)` guard does the rest". That claim is only true if the guard is
  // really there in every op, so this walks the shapes rather than trusting it.
  const W = { x: 0, y: 0, rotation: 0, scale: 1 };
  const off = { type: PAINT_NONE_TYPE };
  // A HOLLOW shape (off fill, live stroke) still draws its outline...
  const hollowSvg = vectorCommandToSVG(rect({ x: 0, y: 0, w: 10, h: 5, fill: off, stroke: "#000000", strokeWidth: 2 }), W, {});
  assert.match(hollowSvg, /fill="none"/, "SVG: the off fill serializes as fill=none");
  assert.match(hollowSvg, /stroke=/, "SVG: and the stroke survives — hollow, not invisible");
  // ...and a shape that is off in BOTH slots vanishes entirely rather than emitting
  // an empty element.
  for (const cmd of [
    rect({ x: 0, y: 0, w: 10, h: 5, fill: off }),
    ellipse({ cx: 0, cy: 0, rx: 4, ry: 4, fill: off }),
    path({ d: "M0 0L10 10", fill: off }),
  ])
    assert.equal(vectorCommandToSVG(cmd, W, {}), "", `SVG: an all-off ${cmd.op} emits nothing`);
  // THE POLYGON REGRESSION. polygon is FILL-ONLY and was the ONE shape op with no
  // null-fill guard, so an off fill reached paintRef and threw "paint is not
  // iterable" (SVG), indexed null as an rgba array (skia applyPaint), and left the
  // PDF's unconditional "h f" filling in the last graphics-state colour. It is
  // reachable from the UI: fancy_arrow and donut pass `s.fill` to polygon(), and
  // every arrow head passes `s.stroke` — all editable paint rows that can be Off.
  const poly = polygon({ points: [[0, 0], [10, 0], [5, 10]], fill: off });
  assert.equal(poly.fill, null, "the off paint collapses to null like any other");
  assert.equal(vectorCommandToSVG(poly, W, {}), "", "SVG: an off polygon emits nothing (used to THROW)");
  // The PDF painter's operator choice, which is the pure decision the polygon case
  // now guards ahead of: no fill and no stroke means there is no paint operator that
  // draws the interior.
  assert.equal(paintOp(null, null, 0), "S", "PDF: nothing to fill");
  assert.equal(paintOp(null, [0, 0, 0, 1], 2), "S", "PDF: stroke-only for a hollow shape");
  assert.equal(paintOp([0, 0, 0, 1], null, 0), "f");
});

test("OFF IS NOT null IN STORAGE — a null leaf DELETES the key (why the tag exists)", () => {
  // THE design decision, pinned. If "off" were spelled `null`, this is what a slide
  // delta would do to it: core/deltas.NONE === null removes the key, so the folded
  // state falls back to the previous slide's paint (here red) — silently painting
  // the very fill the user turned off. The tagged form stores and folds like any
  // other value.
  assert.equal(NONE, null, "the delete sentinel IS null (the collision this avoids)");
  assert.deepEqual(applied({ fill: "#ff0000" }, { fill: NONE }), {}, "a null leaf REMOVES fill");
  assert.deepEqual(
    applied({ fill: "#ff0000" }, { fill: { type: PAINT_NONE_TYPE } }),
    { fill: { type: PAINT_NONE_TYPE } },
    "the OFF tag folds like any other value — the key survives and says 'off'",
  );
});

test("OFF tweens DISCRETELY — a colour → off switches at alpha > 0, no half-off frame", () => {
  const off = { type: PAINT_NONE_TYPE };
  // A hex STRING → a tagged OBJECT is a shape mismatch, so core/interpolators is
  // discrete: the manifest's rule for non-interpolable values, applied to paint.
  assert.deepEqual(interpolate("#ff0000", off, 0.01), off, "switches as soon as alpha > 0");
  assert.deepEqual(interpolate("#ff0000", off, 0), "#ff0000", "and not before");
  assert.deepEqual(interpolate("#ff0000", off, 1), off);
  // The same through the delta blender the slide tween actually uses.
  assert.deepEqual(blendApplied({ fill: "#ff0000" }, { fill: off }, 0.01), { fill: off });
  assert.deepEqual(blendApplied({ fill: "#ff0000" }, { fill: off }, 0), { fill: "#ff0000" });
  // And BACK: off → a colour is equally discrete (no half-appearing fill).
  assert.deepEqual(interpolate(off, "#00ff00", 0.5), "#00ff00");
});

test("OFF round-trips through JSON unchanged (serialize/reload)", () => {
  const stored = { type: PAINT_NONE_TYPE, solid: "#123456", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 45 } };
  const back = JSON.parse(JSON.stringify(stored));
  assert.deepEqual(back, stored);
  assert.equal(isPaintOff(back), true);
  assert.equal(parsePaint(back), null, "still paints nothing after a reload");
  assert.equal(back.solid, "#123456", "and the mode it can return to is remembered");
});

// ── (B) THE BYTE-IDENTICAL GATE ──────────────────────────────────────────────

test("REGRESSION GATE: svg flatten with fill OFF deep-equals the pre-row flatten", () => {
  // The BEFORE shape: the flatten as it was called before this feature existed — no
  // overridePaint option at all.
  const before = flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false });
  // The AFTER shapes, both of which a fill-OFF document produces: the option absent
  // (a document written before the row) and the option explicitly null (what
  // svgOverridePaint returns for the stored OFF tag).
  const afterAbsent = flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false });
  const afterOff = flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false, overridePaint: svgOverridePaint({ fill: SVG_FILL_OFF }) });
  assert.deepEqual(afterAbsent, before, "an absent override changes nothing");
  assert.deepEqual(afterOff, before, "an OFF override changes nothing");
  // Spelled out op-by-op too, so a failure names WHICH field moved rather than
  // dumping two trees.
  assert.equal(before.ops.length, 2);
  for (let i = 0; i < before.ops.length; i++)
    for (const k of ["d", "fill", "stroke", "strokeWidth", "fillRule", "opacity"])
      assert.deepEqual(afterOff.ops[i][k], before.ops[i][k], `op ${i} field "${k}"`);
  // And the values are the ones the REPRO measured: currentColor → ink → BLACK.
  assert.equal(before.ops[0].fill, "#000000", "the filled shape is ink-black (the user's complaint)");
  assert.equal(before.ops[1].stroke, "#000000", "so is the stroked one");
  assert.equal(before.ops[1].fill, null, 'fill="none" stays unpainted');
});

test("REGRESSION GATE: the svg/iconify WIDGET emit is unchanged with fill OFF", () => {
  // One level up from the flatten: the plugin's own emitted ops, since that is what
  // ports.js walks. Compared against the SAME widget with `fill` deleted entirely —
  // i.e. exactly a document authored before the row.
  const base = { ...svgPlugin.defaults, x: 0, y: 0, w: 64, h: 64 };
  const preRow = { ...base };
  delete preRow.fill;
  const withOff = { ...base, fill: SVG_FILL_OFF };
  assert.deepEqual(svgPlugin.emit(withOff, null, IDENTITY_WORLD), svgPlugin.emit(preRow, null, IDENTITY_WORLD));
});

test("overridePaintOf: replaces a painted slot, never creates paint, identity when off", () => {
  assert.equal(overridePaintOf("#00ff00", "#ff00ff"), "#ff00ff");
  assert.equal(overridePaintOf(null, "#ff00ff"), null, "an unpainted slot stays unpainted");
  assert.equal(overridePaintOf("#00ff00", null), "#00ff00", "no override → the artwork's own paint");
  assert.equal(overridePaintOf(null, null), null);
});

test("svgOverridePaint: OFF and ABSENT both mean 'no override'; a real paint passes through", () => {
  assert.equal(svgOverridePaint({ fill: SVG_FILL_OFF }), null);
  assert.equal(svgOverridePaint({}), null, "a pre-row document has no override");
  assert.equal(svgOverridePaint({ fill: null }), null);
  assert.equal(svgOverridePaint({ fill: "#ff00ff" }), "#ff00ff");
  const grad = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 0 } };
  assert.deepEqual(svgOverridePaint({ fill: grad }), grad, "a gradient/material paint passes through whole");
});

// ── (C) FILL ON RECOLOURS EVERY PATH, FILLS AND STROKES ──────────────────────

test("svg fill ON recolours EVERY op — fills AND strokes (the icon-mask semantics)", () => {
  const TINT = "#ff00ff";
  const on = flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false, overridePaint: TINT });
  assert.equal(on.ops[0].fill, TINT, "the FILLED shape takes the override");
  assert.equal(on.ops[1].stroke, TINT, "the STROKED shape takes it too — half the icon sets are authored this way");
  assert.equal(on.ops[1].fill, null, "and its fill='none' interior is still not filled in");
  // GEOMETRY IS UNTOUCHED: only paint changed, which is what makes this a recolour.
  const off = flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false });
  assert.equal(on.ops[0].d, off.ops[0].d);
  assert.equal(on.ops[1].strokeWidth, off.ops[1].strokeWidth, "the override changes colour, never thickness");
  assert.deepEqual(on.transform, off.transform);
});

test("svg fill ON beats the icon's OWN explicit colours, not just currentColor", () => {
  // The full-colour-set case (logos, twemoji): shapes with hard-coded hexes that ink
  // can never reach. This is the half of "we need to be able to color them" that the
  // ink row structurally could not do.
  const multi = {
    tag: "svg",
    attrs: { viewBox: "0 0 10 10" },
    children: [
      { tag: "rect", attrs: { width: "5", height: "10", fill: "#ff0000" }, children: [] },
      { tag: "rect", attrs: { x: "5", width: "5", height: "10", fill: "#0000ff" }, children: [] },
    ],
  };
  const inkOnly = flattenSvgTree(multi, BOX, BOX, { ink: "#00ff00", preserveAspect: false });
  assert.deepEqual(inkOnly.ops.map((o) => o.fill), ["#ff0000", "#0000ff"], "ink cannot touch explicit colours");
  const tinted = flattenSvgTree(multi, BOX, BOX, { ink: "#00ff00", preserveAspect: false, overridePaint: "#ff00ff" });
  assert.deepEqual(tinted.ops.map((o) => o.fill), ["#ff00ff", "#ff00ff"], "the override flattens both to one tint");
});

test("svg fill ON accepts a GRADIENT/MATERIAL paint through to the display list", () => {
  // The row is a full PaintField, so its value may be any paint — the ops must carry
  // it and ir.path() must parse it (a gradient becomes a tagged parsed object, not a
  // colour array).
  const grad = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], angle: 0 } };
  const flat = flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false, overridePaint: grad });
  assert.deepEqual(flat.ops[0].fill, grad, "the flatten passes the paint through unparsed (the op builder parses)");
  // Through the real op builder, the way emit() does it: ir.path() runs parsePaint,
  // so the display list carries a PARSED gradient (tagged object with rgba stops) and
  // the backends' isGradientPaint branch takes over — no SVG-specific paint path.
  const op = path({ ...flat.ops[0] });
  assert.equal(op.fill.type, "linearGradient");
  assert.deepEqual(op.fill.stops.map((s) => s.color), [[1, 0, 0, 1], [0, 0, 1, 1]]);
  // A MATERIAL override reaches the display list as the sparse material paint the
  // resolver expects (ports.resolveMaterialFillPaints adds resolvedParams later).
  const mat = { type: "material", material: { id: "comic", params: {} } };
  const matOp = path({ ...flattenSvgTree(ART, BOX, BOX, { ink: "#000000", preserveAspect: false, overridePaint: mat }).ops[0] });
  assert.equal(matOp.fill.type, "material");
  assert.equal(matOp.fill.material.id, "comic");
});

// ── (D) ICONIFY INHERITS THE ROW ─────────────────────────────────────────────

test("iconify and svg share ONE fill row declaration — not two copies", () => {
  const svgRow = svgPlugin.inspector.find((r) => r.key === "fill");
  const iconRow = iconifyPlugin.inspector.find((r) => r.key === "fill");
  assert.ok(svgRow, "the svg widget declares a fill row");
  assert.ok(iconRow, "so does the iconify widget");
  // IDENTITY, not equality: the same object, so no field can drift between them.
  assert.equal(svgRow, SVG_FILL_ROW);
  assert.equal(iconRow, SVG_FILL_ROW);
  assert.equal(svgRow.paint, true, "it is a real PAINT row (PaintField, not a plain colour swatch)");
  assert.equal(svgRow.kind, "color");
  assert.ok(svgRow.offMeans, "and it tells the field what OFF means in this slot");
});

test("the shared OFF default is FROZEN — one widget's edit cannot rewrite every other's", () => {
  // The aliasing hazard this defends against, concretely: SVG_FILL_OFF is the only
  // OBJECT-valued paint default in the widget set (every other plugin defaults its
  // paint to a colour STRING, immutable for free). Both plugins spread it by
  // reference, so `{...svgPlugin.defaults}` gives EVERY svg and icon in a document
  // the same object — an in-place edit to any one of them would silently rewrite
  // the plugin default and every other widget's fill with it.
  assert.ok(Object.isFrozen(SVG_FILL_OFF), "the shared default is frozen");
  assert.equal(svgPlugin.defaults.fill, iconifyPlugin.defaults.fill, "both plugins do share the one object...");
  // ...and because it is frozen, sharing it is SAFE: the mutation that would have
  // corrupted them throws instead (strict mode — ES modules are always strict).
  assert.throws(() => { SVG_FILL_OFF.type = "solid"; }, TypeError);
  assert.deepEqual(svgPlugin.defaults.fill, { type: PAINT_NONE_TYPE }, "the default survived the attempt");
  // svgFillOff() is the supported way to get a writable one.
  assert.deepEqual(svgFillOff(), { type: PAINT_NONE_TYPE });
  assert.notEqual(svgFillOff(), svgFillOff(), "a fresh object every call");
  assert.ok(!Object.isFrozen(svgFillOff()), "and it is writable");
});

test("both widgets default fill to OFF — an existing icon renders exactly as before", () => {
  assert.deepEqual(svgPlugin.defaults.fill, SVG_FILL_OFF);
  assert.deepEqual(iconifyPlugin.defaults.fill, SVG_FILL_OFF);
  assert.equal(isPaintOff(svgPlugin.defaults.fill), true);
  assert.equal(isPaintOff(iconifyPlugin.defaults.fill), true);
});

test("the ink row's help NAMES the fill relationship on both widgets (one system)", () => {
  // The two rows are only comprehensible together — that is the whole content of the
  // "why is my icon black?" answer — so the ink help must say when it applies AND
  // what supersedes it. Shared string, asserted on both widgets.
  for (const plug of [svgPlugin, iconifyPlugin]) {
    const ink = plug.inspector.find((r) => r.key === "ink");
    assert.equal(ink.help, SVG_INK_HELP, `${plug.type}: ink help is the shared string`);
    assert.match(ink.help, /currentColor/, "it explains the mechanism that makes an icon black");
    assert.match(ink.help, /Fill/, "and points at the row that overrides it");
  }
  assert.match(SVG_FILL_ROW.help, /Off/, "and the fill help points back at the off default");
});

test("iconify emit passes the override through to the flatten (the row is WIRED, not just declared)", () => {
  // A declared row that emit() ignores is exactly the class of live bug this round was
  // asked to look for, so this asserts the wiring, not the declaration. Bare node
  // cannot fetch the Iconify API, so the icon draws its error affordance — which is
  // itself the honest documented degradation, and the reason the FLATTEN-level tests
  // above carry the recolour proof.
  const state = { ...iconifyPlugin.defaults, x: 0, y: 0, w: 64, h: 64, fill: "#ff00ff" };
  const ops = iconifyPlugin.emit(state, null, IDENTITY_WORLD);
  assert.ok(ops.length > 0, "it still emits (the error affordance)");
  // The wiring itself is checked at the seam both widgets share:
  assert.equal(svgOverridePaint(state), "#ff00ff");
});

// ── ZERO-REPAIR ──────────────────────────────────────────────────────────────

test("both widgets' defaults (fill OFF included) survive repairedDocument with ZERO reports", () => {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const doc = {
    meta: { name: "t", slideW: 1280, slideH: 720 },
    slides: [{
      id: uuid(), name: "Slide 1",
      transition: { seconds: 0.5, curve: "smooth", sound: null, type: "tween" },
      delta: { items: {
        [uuid()]: { ...svgPlugin.defaults },
        [uuid()]: { ...iconifyPlugin.defaults },
      } },
    }],
  };
  const { doc: out, reports } = repairedDocument(doc, registry);
  const unexpected = reports.filter((r) => !/camera/i.test(String(r)));
  assert.deepEqual(unexpected, [], `unexpected repairs: ${JSON.stringify(unexpected)}`);
  // And the OFF tag SURVIVED the repair — it was not "fixed" into a colour.
  for (const item of Object.values(out.slides[0].delta.items))
    if (item.type === "svg" || item.type === "iconify")
      assert.deepEqual(item.fill, SVG_FILL_OFF, `${item.type}: fill stayed OFF through repair`);
});

// ── (E) A FILL-ONLY MATERIAL NEVER REACHES A STROKE SLOT ─────────────────────

/** An OUTLINE icon (the tabler/lucide authoring: fill="none" stroke="currentColor")
 * plus a FILLED shape, so one fixture exercises both slots at once. */
const MIXED_ART = { tag: "svg", attrs: { viewBox: "0 0 24 24" }, children: [
  { tag: "path", attrs: { d: "M4 4L20 20", fill: "none", stroke: "currentColor", "stroke-width": "2" }, children: [] },
  { tag: "rect", attrs: { width: "10", height: "10", fill: "#00ff00", stroke: "#0000ff", "stroke-width": "1" }, children: [] },
]};

const CRT_SOLID = "#ff00ff";
const crtPaint = () => ({ type: "material", material: { id: "crt", params: {} }, solid: CRT_SOLID });

/** Flattens MIXED_ART under `paint` exactly as the two plugins' emit() does, and
 * collects the reports instead of printing them. */
function flattenUnderOverride(paint) {
  const lines = [];
  const override = svgOverridePaint({ fill: paint });
  const sink = (_key, line) => lines.push(line);
  const flat = flattenSvgTree(MIXED_ART, 24, 24, {
    preserveAspect: false,
    overridePaint: svgOverrideSlotPaint(override, "fill", sink),
    overrideStrokePaint: svgOverrideSlotPaint(override, "stroke", sink),
  });
  return { ops: flat.ops, lines };
}

test("crt override: FILLS carry the material, STROKES carry its solid, ONE loud report", () => {
  const { ops, lines } = flattenUnderOverride(crtPaint());
  const [outline, filled] = ops;
  // The outline icon: nothing to fill (the override never invents ink), and its
  // stroke — the only ink it has — is the SOLID, not the uncastable material.
  assert.equal(outline.fill, null, "an unpainted fill stays unpainted");
  assert.equal(outline.stroke, CRT_SOLID, "the outline's stroke degraded to the solid fallback");
  // The filled shape: the material survives where it is actually paintable.
  assert.equal(filled.fill.material.id, "crt", "the FILL keeps the material — that is the point of the row");
  assert.equal(filled.stroke, CRT_SOLID, "but its stroke degraded too");
  // ONE report, naming the material and the substitution (a per-op report would be
  // per-frame spam; silence would be the bug this whole section exists for).
  assert.equal(lines.length, 1, `exactly one report, got ${lines.length}`);
  assert.match(lines[0], /crt/, "it names the material the user picked");
  assert.match(lines[0], new RegExp(CRT_SOLID), "and the colour it substituted");
});

test("crt override: ZERO throws through the painter's own getStrokeMaterial call", () => {
  // The live crash, reproduced at its exact call site: drawMaterialStroke does this
  // unconditionally on every material stroke. Before the fix this threw per frame.
  const { ops } = flattenUnderOverride(crtPaint());
  for (const op of ops)
    if (op.stroke && typeof op.stroke === "object" && op.stroke.type === "material")
      getStrokeMaterial(op.stroke.material.id); // throws LOUDLY if a fill-only id slipped through
});

test("THE MIRROR IMAGE: a STROKE-only material degrades in the FILL slot", () => {
  // The half the first fix missed. `wavy` IS stroke-capable, so it passes through to
  // the stroke — but the fill registry has never heard of it, and getMaterial throws
  // exactly as getStrokeMaterial did. A one-directional guard leaves this live.
  const wavy = { type: "material", material: { id: "wavy", params: {} }, solid: "#123456" };
  const { ops, lines } = flattenUnderOverride(wavy);
  assert.equal(ops[0].stroke.material.id, "wavy", "the STROKE keeps it — no needless downgrade");
  assert.equal(ops[1].fill, "#123456", "but the FILL degraded to the solid fallback");
  assert.equal(lines.length, 1, `exactly one report, got ${lines.length}`);
  assert.match(lines[0], /FILL/, "and the report names the slot that could not paint it");
});

test("crt override: ZERO throws through the FILL painter's getMaterial call too", () => {
  // The fill-side twin of the stroke assertion above — both painters, one fixture.
  const { ops } = flattenUnderOverride(crtPaint());
  for (const op of ops)
    if (op.fill && typeof op.fill === "object" && op.fill.type === "material")
      getMaterial(op.fill.material.id); // throws LOUDLY if a stroke-only id slipped through
});

test("capability is asked of the REGISTRIES, not of a hardcoded roster, in BOTH directions", () => {
  // Every registered material must pass through in the slot it serves and degrade in
  // the other. This is what keeps the rule correct as either roster grows.
  for (const id of strokeMaterialIds()) {
    const paint = { type: "material", material: { id, params: {} }, solid: "#abcdef" };
    assert.equal(svgOverrideSlotPaint(paint, "stroke", () => {}), paint, `${id}: passes through its OWN (stroke) slot by identity`);
    if (!fillCapableMaterialIds().includes(id))
      assert.equal(svgOverrideSlotPaint(paint, "fill", () => {}), "#abcdef", `${id}: degrades in the fill slot it cannot paint`);
  }
  for (const id of fillCapableMaterialIds()) {
    const paint = { type: "material", material: { id, params: {} }, solid: "#abcdef" };
    assert.equal(svgOverrideSlotPaint(paint, "fill", () => {}), paint, `${id}: passes through its OWN (fill) slot by identity`);
    if (!hasStrokeMaterial(id))
      assert.equal(svgOverrideSlotPaint(paint, "stroke", () => {}), "#abcdef", `${id}: degrades in the stroke slot it cannot paint`);
  }
  assert.equal(hasStrokeMaterial("crt"), false, "crt is fill-only — the premise of this whole section");
});

test("a SOLID override is untouched, and OFF is byte-identical to no override at all", () => {
  const { ops: solidOps, lines: solidLines } = flattenUnderOverride("#123456");
  assert.equal(solidOps[1].fill, "#123456");
  assert.equal(solidOps[1].stroke, "#123456", "a solid still recolours both slots (C is intact)");
  assert.deepEqual(solidLines, [], "a solid is not a material, so nothing is reported");
  // OFF: the stroke split must not have perturbed the byte-identity gate (B).
  const { ops: offOps, lines: offLines } = flattenUnderOverride(SVG_FILL_OFF);
  const bare = flattenSvgTree(MIXED_ART, 24, 24, { preserveAspect: false }).ops;
  assert.deepEqual(offOps, bare, "OFF renders the artwork's own paints, op for op");
  assert.deepEqual(offLines, [], "and says nothing");
});

test("svgOverrideSlotPaint returns non-materials BY IDENTITY (what makes it safe to call always)", () => {
  const grad = { type: "linearGradient", stops: [] };
  for (const slot of ["fill", "stroke"]) {
    assert.equal(svgOverrideSlotPaint(grad, slot, () => {}), grad, `${slot}: a gradient is the same object back`);
    assert.equal(svgOverrideSlotPaint(null, slot, () => {}), null);
    assert.equal(svgOverrideSlotPaint("#abc", slot, () => {}), "#abc");
  }
});

test("both plugins WIRE BOTH slot guards (a fix only in the helper would be dead code)", () => {
  // The (D) precedent: assert the wiring, not just the helper. Reading the source is
  // the only bare-node way to see an option name a plugin passes into the flatten.
  const src = readFileSync(new URL("../plugins/svg.js", import.meta.url), "utf8")
            + readFileSync(new URL("../plugins/iconify.js", import.meta.url), "utf8");
  const stroke = src.match(/overrideStrokePaint:\s*svgOverrideSlotPaint\(override, "stroke"\)/g) ?? [];
  const fill = src.match(/overridePaint:\s*svgOverrideSlotPaint\(override, "fill"\)/g) ?? [];
  assert.equal(stroke.length, 2, "both svg.js and iconify.js guard the STROKE slot");
  assert.equal(fill.length, 2, "...and both guard the FILL slot too (the mirror-image half)");
});

console.log(`\n${passed} paint-off + svg-fill-override tests passed.`);
