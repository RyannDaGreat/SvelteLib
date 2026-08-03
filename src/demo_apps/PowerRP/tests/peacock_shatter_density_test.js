/**
 * SHATTERING A PAPER PEACOCK, AND THE RASTER DENSITY KNOB BOTH PDF FAN WIDGETS
 * NOW CARRY.
 *
 * User, 2026-08-02, two requests in one breath: "Shatter should work for paper
 * peacock too. Also why no control over DPI in pdf packet and paper peacock?"
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * Two laws, each of which would fail SILENTLY and produce a wrong picture rather
 * than an error:
 *
 *   1. A SHATTERED SHEET LANDS WHERE THE FAN DREW IT. emit() poses each sheet
 *      with `pushTransform(rotationAboutPivot(...))` around a shared base rect;
 *      a shattered sheet has no enclosing frame and must say the same pose in a
 *      stored item's own vocabulary (x/y/w/h + rotation + rotationAnchor). Those
 *      are two different spellings of one geometry, and nothing but a test makes
 *      them agree — a wrong one draws a plausible-looking fan in the wrong place.
 *
 *   2. AN ABSENT `rasterDensity` IS BYTE-IDENTICAL TO BEFORE THE KNOB EXISTED.
 *      This is the absent-is-legacy precedent, and here it is checkable at the
 *      exact place it matters: the CACHE KEY. Density feeds a pdfjs scale, the
 *      scale is rounded into the key, and the key is what decides whether pixels
 *      are reused. So "legacy unchanged" and "a new density mints a new raster"
 *      are the same assertion read in two directions.
 *
 * NO PDF IS LOADED HERE, deliberately: every law above is pure geometry or a
 * pure key function. The async raster path has its own probes.
 *
 * Run: node src/demo_apps/PowerRP/tests/peacock_shatter_density_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { shatterEligible, shatterNotReadyReason } from "../core/shatter.js";
import { paperPeacockPlugin, peacockLayout, rotationAboutPivot, sheetTransform } from "../plugins/paper_peacock.js";
import { pdfPacketPlugin } from "../plugins/pdf_packet.js";
import { pdfPageRef, roundPdfScale } from "../render_gpu/gpu/pdf_page_raster.js";
import * as T from "../core/transform.js";
import { worldTransform } from "../core/derive.js";

const registry = createRegistry();
registerPlugins(registry);

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

/** The fan every geometry check below is measured against — a real one (eight
 * sheets across ±45°, the reference figure's own numbers), not a degenerate. */
const FAN = { w: 520, h: 340, count: 8, fanAngle: 45, hRatio: 1.5, aspect: 792 / 612 };
const BOX = { x: 200, y: 120, w: FAN.w, h: FAN.h };

// ── 1. ELIGIBILITY: THE USER'S ACTUAL REQUEST ───────────────────────────────

test("SHATTER IS NOW OFFERED ON PAPER PEACOCK — the request", () => {
  assert.equal(shatterEligible(registry.get("paper_peacock")), true);
});

test("an empty peacock is refused with a sentence about the PDF, not a crash", () => {
  const why = shatterNotReadyReason(paperPeacockPlugin, { src: "" });
  assert.match(why, /PDF chosen/);
});

test("a peacock whose PDF has not opened yet is refused — shattering would bake in guesses", () => {
  // Nothing has loaded "blob:never", so pdfPageCount is null: the fan would be
  // laid out at DEFAULT_PAGE_ASPECT and an untrimmed page window, and those
  // guesses would become eight permanent items.
  const why = shatterNotReadyReason(paperPeacockPlugin, { src: "blob:never" });
  assert.match(why, /finished opening/);
});

// ── 2. THE POSE: THE SAME GEOMETRY, SPELLED TWO WAYS ────────────────────────

test("THE LAW — a shattered sheet's stored transform reproduces the fan's own pushTransform pose", () => {
  const L = peacockLayout(FAN.w, FAN.h, FAN.count, FAN.fanAngle, FAN.hRatio, FAN.aspect);
  for (let i = 0; i < FAN.count; i++) {
    // What emit() does: the host's frame, then a rotation about the shared pivot,
    // then the shared base rect's corner. (The host is unrotated at the origin of
    // its world box — the frame every shatter consumer lays parts into.)
    const fanFrame = T.compose(
      { x: BOX.x, y: BOX.y, rotation: 0, scale: 1 },
      rotationAboutPivot(L.pivotX, L.pivotY, L.angles[i]),
    );
    // What the shattered item does: worldTransform of the stored state.
    const part = sheetTransform(L, i, BOX);
    const stored = worldTransform(part);
    for (const [lx, ly] of [[0, 0], [L.pageW, 0], [L.pageW, L.pageH], [0, L.pageH]]) {
      const fromFan = T.apply(fanFrame, L.pageX + lx, L.pageY + ly);
      const fromPart = T.apply(stored, lx, ly);
      assert.ok(
        Math.hypot(fromFan.x - fromPart.x, fromFan.y - fromPart.y) < 1e-9,
        `sheet ${i} corner (${lx},${ly}): fan drew (${fromFan.x}, ${fromFan.y}), the part lands at (${fromPart.x}, ${fromPart.y})`,
      );
    }
  }
});

test("the pivot is SHARED — every sheet reports the identical rotationAnchor", () => {
  const L = peacockLayout(FAN.w, FAN.h, FAN.count, FAN.fanAngle, FAN.hRatio, FAN.aspect);
  const anchors = L.angles.map((_, i) => sheetTransform(L, i, BOX).rotationAnchor);
  for (const a of anchors) {
    assert.ok(Math.abs(a.x - anchors[0].x) < 1e-9, `anchor x drifted: ${a.x} vs ${anchors[0].x}`);
    assert.ok(Math.abs(a.y - anchors[0].y) < 1e-9, `anchor y drifted: ${a.y} vs ${anchors[0].y}`);
  }
  // And it is a NUMERIC pair, not the self.anchors.center equation every other
  // widget defaults to — that default structurally cannot say "one shared point".
  assert.equal(typeof anchors[0].x, "number");
  assert.equal(typeof anchors[0].y, "number");
});

test("rotation is stored in RADIANS (degrees are a display unit)", () => {
  const L = peacockLayout(FAN.w, FAN.h, 2, 90, 1, 1);
  assert.equal(sheetTransform(L, 0, BOX).rotation, -Math.PI / 2);
  assert.equal(sheetTransform(L, 1, BOX).rotation, Math.PI / 2);
});

// ── 3. THE PLAN ─────────────────────────────────────────────────────────────

/** A peacock whose fan geometry is fully determined WITHOUT a loaded PDF: the
 * layout falls back to DEFAULT_PAGE_ASPECT and the requested count (that is
 * exactly the fallback `shatterNotReady` refuses to let a USER shatter through —
 * here we call `shatter` directly to measure the plan it builds). */
const stateFor = (over = {}) => ({
  ...paperPeacockPlugin.defaults, src: "blob:test", w: FAN.w, h: FAN.h,
  firstPage: 1, pageCount: FAN.count, fanAngle: FAN.fanAngle, hRatio: FAN.hRatio, ...over,
});

test("N sheets become N parts, each a pdf_page carrying the source and its own page", () => {
  const { parts } = paperPeacockPlugin.shatter(stateFor(), { box: BOX });
  assert.equal(parts.length, FAN.count);
  for (const p of parts) assert.equal(p.state.type, "pdf_page");
  for (const p of parts) assert.equal(p.state.src, "blob:test");
});

test("BACK-TO-FRONT IS PRESERVED BY ORDER — deepest first, so rising z puts page 1 on top", () => {
  // shatteredDocument writes parts in plan order with rising z, and emit() draws
  // deepest-first. So the plan must be deepest-first too, which means the LAST
  // part is page `firstPage`.
  const { parts } = paperPeacockPlugin.shatter(stateFor(), { box: BOX });
  assert.deepEqual(parts.map((p) => p.state.page), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(parts[parts.length - 1].state.page, 1);
});

test("firstPage is honoured — a fan starting at page 5 shatters into pages 5..12", () => {
  const { parts } = paperPeacockPlugin.shatter(stateFor({ firstPage: 5 }), { box: BOX });
  assert.deepEqual(parts.map((p) => p.state.page).slice().reverse(), [5, 6, 7, 8, 9, 10, 11, 12]);
});

test("the parts' poses match sheetTransform against the WORLD box, not the local one", () => {
  // A host whose world box differs from its stored w/h (a scaled group) must
  // still put its sheets where they are drawn.
  const wide = { x: 0, y: 0, w: FAN.w * 2, h: FAN.h * 2 };
  const { parts } = paperPeacockPlugin.shatter(stateFor(), { box: wide });
  const L = peacockLayout(wide.w, wide.h, FAN.count, FAN.fanAngle, FAN.hRatio, 792 / 612);
  // parts[0] is the DEEPEST sheet, which is fan index count-1.
  assert.deepEqual(
    { ...parts[0].state, type: undefined, src: undefined, page: undefined, shadow: undefined },
    { ...sheetTransform(L, FAN.count - 1, wide), type: undefined, src: undefined, page: undefined, shadow: undefined },
  );
});

test("EVERY PART IS VECTOR — a sheet IS a pdf_page, so nothing is disclosed as raster", () => {
  const { parts, notes } = paperPeacockPlugin.shatter(stateFor(), { box: BOX });
  assert.equal(parts.some((p) => p.raster), false);
  assert.deepEqual(notes, []);
});

test("part keys are legal reference tokens — a sibling reference to one must not mis-parse", () => {
  const { parts } = paperPeacockPlugin.shatter(stateFor(), { box: BOX });
  for (const p of parts) assert.match(p.key, /^[A-Za-z][A-Za-z0-9]*$/);
  assert.equal(new Set(parts.map((p) => p.key)).size, parts.length, "keys must be unique");
});

// ── 4. THE SHADOW, CONVERTED OUT OF THE FAN'S FRACTIONAL UNITS ──────────────

test("THE SHADOW CARRIES — the fan's fractional units become the effects bundle's canvas units", () => {
  // The fan stores blur as a FRACTION of page width and each offset as a
  // fraction of the blur; a stored item's shadow bundle stores canvas units.
  // Getting this wrong would give eight sheets a shadow ~5x too small.
  const s = stateFor({ shadowBlur: 0.2, shadowOpacity: 0.5, shadowDx: 0.25, shadowDy: 0.25 });
  const { parts } = paperPeacockPlugin.shatter(s, { box: BOX });
  const L = peacockLayout(BOX.w, BOX.h, FAN.count, FAN.fanAngle, FAN.hRatio, 792 / 612);
  const blur = 0.2 * L.pageW;
  for (const p of parts) {
    assert.ok(Math.abs(p.state.shadow.blur - blur) < 1e-9);
    assert.ok(Math.abs(p.state.shadow.dx - 0.25 * blur) < 1e-9);
    assert.ok(Math.abs(p.state.shadow.dy - 0.25 * blur) < 1e-9);
    assert.equal(p.state.shadow.opacity, 0.5);
  }
});

test("a shadowless fan shatters to shadowless sheets — opacity 0 is the bundle's own OFF gate", () => {
  const { parts } = paperPeacockPlugin.shatter(stateFor({ shadowOpacity: 0 }), { box: BOX });
  for (const p of parts) assert.equal(p.state.shadow.opacity, 0);
});

// ── 5. RASTER DENSITY ───────────────────────────────────────────────────────

test("BOTH widgets carry the row, from ONE shared definition", () => {
  for (const plugin of [paperPeacockPlugin, pdfPacketPlugin]) {
    const row = plugin.inspector.find((r) => r.key === "rasterDensity");
    assert.ok(row, `${plugin.type} has no rasterDensity row`);
    assert.equal(row.label, "Raster density");
    assert.equal(row.kind, "number");
  }
  // Same definition ⇒ identical rows. This is the anti-drift assertion: two
  // hand-written rows would pass every check above and still disagree tomorrow.
  const [a, b] = [paperPeacockPlugin, pdfPacketPlugin].map((p) => p.inspector.find((r) => r.key === "rasterDensity"));
  assert.deepEqual(a, b);
});

test("ABSENT IS LEGACY — the default is 1, which multiplies to today's exact density", () => {
  for (const plugin of [paperPeacockPlugin, pdfPacketPlugin])
    assert.equal(plugin.defaults.rasterDensity, 1, `${plugin.type}`);
});

/** The density math BOTH widgets run, spelled once here so the pin measures the
 * thing that actually reaches the cache: a pdfjs scale (device px per PDF point). */
const scaleFor = (pageLocalW, worldScale, supersample, rasterDensity, pointW) =>
  (pageLocalW * (worldScale * supersample * (rasterDensity ?? 1))) / pointW;

test("THE LEGACY PIN — an absent density leaves the CACHE KEY untouched", () => {
  const legacy = scaleFor(260, 1.5, 2, undefined, 612);
  const explicitOne = scaleFor(260, 1.5, 2, 1, 612);
  assert.equal(legacy, explicitOne);
  assert.equal(pdfPageRef("blob:x", 3, legacy), pdfPageRef("blob:x", 3, explicitOne));
});

test("A DENSITY CHANGE MINTS A NEW KEY — otherwise the knob would move nothing", () => {
  const at1 = scaleFor(260, 1.5, 2, 1, 612);
  const at2 = scaleFor(260, 1.5, 2, 2, 612);
  assert.equal(at2, at1 * 2, "the multiplier must scale the pdfjs scale itself");
  assert.notEqual(pdfPageRef("blob:x", 3, at1), pdfPageRef("blob:x", 3, at2));
  // And the new key really is the DENSER one — a key that merely differs would
  // satisfy the line above while rasterizing at the wrong resolution.
  assert.ok(roundPdfScale(at2) > roundPdfScale(at1));
});

test("density COMPOSES with zoom rather than replacing it — that is what 'multiplier' buys", () => {
  // The same density at two zooms gives two scales; the same zoom at two
  // densities gives two scales. An absolute DPI would flatten the first pair.
  const a = scaleFor(260, 1, 2, 2, 612);
  const b = scaleFor(260, 4, 2, 2, 612);
  assert.equal(b, a * 4);
});

console.log(`\npeacock_shatter_density_test: ${passed} passed`);
