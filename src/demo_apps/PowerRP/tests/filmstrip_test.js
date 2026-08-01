/**
 * FILMSTRIP gate — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/filmstrip_test.js
 *
 * The filmstrip was rebuilt on the video SCRUB path: its frames used to be stills
 * fetched from a server endpoint and cached under `frameUrls`, and they are now one
 * `videoV5Frame` op per element of a LIST property whose single field is a TIME in the
 * clip. This suite pins the parts of that rebuild that a reader cannot verify by
 * looking, and the two defects it fixed.
 *
 *   (1) THE FRAME LIST is a real core/lists.js list: its declaration validates, its
 *       per-element field is a typed equation SLOT, and hide/purge behave the way the
 *       list foundation says they do.
 *   (2) THE DEFAULT EQUATIONS span videoStart→videoEnd at i/N — frame 0 AT the start,
 *       no frame at the exact end, total at N = 1 (see plugins/filmstrip.js's header
 *       for why that indexing and not i/(N-1)).
 *   (3) PER-FRAME ANCHORS exist, are underscore-free (the ref grammar splits on the
 *       last "_"), and are keyed on the STORED index — so HIDING a frame moves the
 *       others but REBINDS NONE of their anchors. This is the index-rebinding trap the
 *       polygon work hit, and hide-never-renumbers is the containment.
 *   (4) THE PICTURES MOVE WITH THE STRIP. The frame ops must carry the strip's own
 *       world: they used to be flattened from IDENTITY, so dragging the widget left its
 *       pictures behind at the canvas origin while its bands and borders moved.
 *   (5) THE GAUGE IS REAL. Perforation size/pitch/radius come from core/film.js's
 *       published millimetre table scaled by the strip's width, so 16 mm reads coarser
 *       than 35 mm, and the rounded-rectangle boundary function is exact at the cases
 *       that have closed forms.
 *   (6) LEGACY DOCUMENTS MIGRATE LOUDLY: a numeric `frames` count becomes a list of the
 *       same length, the dead server-era keys are dropped, and a second pass is silent.
 *   (7) THE GHOST still emits nothing (the symmetry tests/ghost_test.js polices, pinned
 *       here too because emit() is where it is enforced).
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { allPlugins } from "../plugins/index.js";
import { PERF_FAMILIES, PERF_FAMILY_IDS } from "../core/film.js";
import { checkListDeclaration, visibleElements, withElementActive, withElementPurged } from "../core/lists.js";
import { PROPS, ROW_KINDS, NUMERIC_ROW_KINDS } from "../core/properties.js";
import { listSlotKind } from "../core/expressions.js";
import { repairedDocument } from "../core/document.js";
import { flattenIR } from "../render_gpu/ir.js";
import {
  DEFAULT_FRAME_COUNT, DEFAULT_LEADER_GAPS, PERF_FLOOR_PIXELS,
  filmBandOps, filmstripAnchors, filmstripFrameAnchors, filmstripGeom, filmstripPlugin,
  minPerforatedCross, perforatedBandPolygons, perforationPixels,
  perforationsOverlap, perforationsResolve, roundedRectBoundaryPoint,
} from "../plugins/filmstrip.js";
// THE SOURCE HALF MOVED to the declaration the filmstrip now SHARES with the image
// stack (core/video_sampling.js) — the frame list, its default equations and the
// empty-span predicate belong to both widgets, not to the strip.
import { defaultFrameList, frameTimeEquation, spanIsEmpty, visibleFrames } from "../core/video_sampling.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
for (const p of allPlugins) registry.register(p);

/** Pure function. A close-enough float compare for geometry assertions.
 *  @example near(1.0000001, 1) // true */
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── (1) THE FRAME LIST IS A REAL DECLARED LIST ───────────────────────────────

test("`frames` is a declared LIST whose element field is a typed equation slot", () => {
  const decl = PROPS.frames;
  assert.equal(decl.kind, "list");
  // The same loud guard core/properties.js runs at import — restated here so a broken
  // declaration fails in THIS suite too, naming the filmstrip.
  checkListDeclaration("frames", decl, ROW_KINDS, NUMERIC_ROW_KINDS);
  assert.equal(decl.order, "sequence", "the order IS the strip, left to right");
  assert.equal(decl.activeKey, "framesActive");
  assert.equal(decl.minLength, 1, "a strip with no frames is not a filmstrip");
  assert.equal(decl.element.storage, "tuple", "a RECORD would take interpolate()'s rounding int-rule path and snap whole-second times mid-tween");
  assert.deepEqual(decl.element.fields.map((f) => f.name), ["time"]);
  // The payoff: a per-element `=` is a real, typed slot — index-independent, so element
  // 9 of a six-element default types exactly like element 0.
  assert.equal(listSlotKind(["frames", 0, "time"]), "number");
  assert.equal(listSlotKind(["frames", 9, "time"]), "number");
  assert.equal(listSlotKind(["frames", 0, 0]), "number", "the raw tuple-storage spelling names the same slot");
  assert.equal(listSlotKind(["framesActive", 2]), "boolean");
  assert.equal(listSlotKind(["frames", 0]), null, "a whole element has no declared kind of its own");
});

test("hide keeps a frame stored and closes the strip over it; purge removes it", () => {
  const decl = PROPS.frames;
  const value = { list: [[0], [1], [2]] };
  const hidden = withElementActive(decl, value, 1, false);
  assert.deepEqual(hidden.list, value.list, "HIDE writes only the companion — nothing is renumbered");
  assert.deepEqual(visibleElements(decl, hidden), [[0], [2]]);
  const purged = withElementPurged(decl, value, 1);
  assert.deepEqual(purged.list, [[0], [2]], "PURGE really removes it");
});

// ── (2) THE DEFAULT EQUATIONS ────────────────────────────────────────────────

test("default frame times span videoStart→videoEnd at i/N (frame 0 AT the start)", () => {
  assert.equal(frameTimeEquation(0, 6), "self.video_start");
  assert.equal(frameTimeEquation(3, 6), "self.video_start + 3 / 6 * (self.video_end - self.video_start)");
  // N = 1 is TOTAL — i/(N-1) would divide by zero here, which is half the reason for
  // this indexing.
  assert.deepEqual(defaultFrameList(1), [["self.video_start"]]);
  const six = defaultFrameList(6);
  assert.equal(six.length, 6);
  // NO element asks for exactly videoEnd: seeking exactly to a clip's duration is
  // undefined (the reason the scrub path carries a SCRUB_END_EPSILON at all).
  assert.equal(six.some((el) => el[0] === "self.video_end"), false);
  assert.equal(six.some((el) => /\b6 \/ 6\b/.test(el[0])), false);
  assert.deepEqual(filmstripPlugin.defaults.frames, defaultFrameList(DEFAULT_FRAME_COUNT));
  assert.equal(filmstripPlugin.defaults.framesActive, undefined, "absent means visible — a fresh strip mints no companion");
});

test("the equations evaluate to an even sweep once the span is set", () => {
  // What the strip actually shows: the span divided into N equal slots, each cell
  // sampling the START of its slot.
  const N = 4, start = 2, end = 10;
  const times = defaultFrameList(N).map((el, i) => (i === 0 ? start : start + (i / N) * (end - start)));
  assert.deepEqual(times, [2, 4, 6, 8]);
  assert.equal(spanIsEmpty({ videoStart: 0, videoEnd: 0 }), true, "an unsupplied clip length is an EMPTY span, said in-widget");
  assert.equal(spanIsEmpty({ videoStart: 0, videoEnd: 3 }), false);
  assert.equal(spanIsEmpty({ videoStart: 5, videoEnd: 2 }), true, "an inverted span samples nothing");
});

test("visibleFrames pairs each visible frame's STORED index with its evaluated time", () => {
  assert.deepEqual(visibleFrames({ frames: [[0], [1.5]] }), [{ index: 0, time: 0 }, { index: 1, time: 1.5 }]);
  assert.deepEqual(
    visibleFrames({ frames: [[0], [1], [2]], framesActive: [true, false, true] }),
    [{ index: 0, time: 0 }, { index: 2, time: 2 }],
    "the hidden frame is absent, and the survivors keep their STORED indices",
  );
  assert.deepEqual(visibleFrames({ frames: [["self.video_start"]] }), [{ index: 0, time: 0 }],
    "a half-typed equation reads as 0 rather than crashing the paint");
});

// ── (3) PER-FRAME ANCHORS + THE INDEX-REBINDING TRAP ─────────────────────────

const STRIP = { w: 480, h: 90, vertical: false, perfFamily: "BH" };

test("every visible frame exposes the 9 bbox anchors, prefixed f{storedIndex}", () => {
  const anchors = filmstripFrameAnchors({ ...STRIP, frames: [[0], [1], [2]] });
  assert.equal(anchors.length, 27, "3 frames x the standard 9");
  for (const suffix of ["tl", "tm", "tr", "ml", "cm", "mr", "bl", "bm", "br"])
    assert.ok(anchors.some((a) => a.id === `f1${suffix}`), `frame 1 is missing its "${suffix}" anchor`);
  // The full set is the widget's own 9 FIRST, then the frames' — the bento split, so
  // snapFeatures can use the frame half without double-counting the bbox.
  const all = filmstripAnchors({ ...STRIP, frames: [[0], [1], [2]] });
  assert.equal(all.length, 9 + 27);
  assert.equal(all[0].id, "tl");
});

test("no anchor id contains an underscore (the ref grammar splits on the LAST one)", () => {
  // `@<itemSlug>_<anchorId>.x` is split on the last "_", so an "_" inside an id would be
  // mis-split and the anchor would be unreferenceable from an equation.
  for (const a of filmstripAnchors({ ...STRIP, frames: defaultFrameList(6) }))
    assert.equal(a.id.includes("_"), false, `anchor "${a.id}" contains an underscore`);
});

test("HIDING a frame moves the others but REBINDS NONE of their anchors", () => {
  // THE TRAP: an anchor id is a STORED reference, so an id keyed on a frame's POSITION
  // would silently re-point every attached arrow the moment the count changed. The
  // containment is that the id carries the STORED index while the POSITION comes from
  // the visible layout — which is exactly why core/lists.js's "HIDE NEVER RENUMBERS"
  // invariant is load-bearing here.
  const before = filmstripFrameAnchors({ ...STRIP, frames: [[0], [1], [2]] });
  const after = filmstripFrameAnchors({ ...STRIP, frames: [[0], [1], [2]], framesActive: [true, false, true] });
  const idsOf = (list) => new Set(list.map((a) => a.id));
  assert.equal(idsOf(after).has("f1cm"), false, "the hidden frame exposes no anchors (bento's absorbed-cell rule)");
  assert.equal(idsOf(after).has("f2cm"), true, "frame 2 is STILL f2 — it did not become f1");
  assert.equal(idsOf(after).has("f0cm"), true);
  // It MOVED (the strip closed over the gap and the survivors grew to fill the width) —
  // which is the whole point: the id is stable, the position is not.
  const at = (list, id) => list.find((a) => a.id === id);
  assert.ok(at(after, "f2cm").x < at(before, "f2cm").x, "frame 2 slid left into the closed gap");
  assert.ok(at(after, "f0cm").x > at(before, "f0cm").x, "frame 0's cell grew, so its centre moved right");
  // The frame run starts one LEADER in from the strip's own edge, not flush with it,
  // and the leader is a multiple of the inter-frame GAP — which is a fraction of a
  // cell — so a wider cell means a proportionally longer leader. Self-similar by
  // construction (plugins/filmstrip.js filmstripLayout), which is the point.
  assert.ok(at(before, "f0ml").x > 0, "the frame run starts one leader in, not flush with the strip's edge");
  assert.ok(at(after, "f0ml").x > at(before, "f0ml").x, "closing over the hidden frame widened the cells, so the leader grew with them");
});

test("LEADER/TAIL: blank film at both ends by default, adjustable, and the bands run through it", () => {
  const s = (leader) => ({ ...STRIP, leader, frames: defaultFrameList(4) });
  const runOf = (leader) => {
    const cells = filmstripGeom(s(leader), 4).frames;
    return {
      head: cells[0].x,
      tail: STRIP.w - (cells[3].x + cells[3].w),
      // The leader is measured IN GAPS, and the strip's total length is fixed, so a
      // longer leader also makes every cell (and therefore every gap) smaller. The
      // invariant is the RATIO, not an absolute length.
      inGaps: cells[0].x / (cells[1].x - (cells[0].x + cells[0].w)),
    };
  };
  const flush = runOf(0);
  assert.ok(near(flush.head, 0) && near(flush.tail, 0), "leader 0 is the old flush layout, to the unit");
  const one = runOf(DEFAULT_LEADER_GAPS);
  assert.ok(one.head > 0, "the DEFAULT strip does not start on a picture");
  assert.ok(near(one.head, one.tail), "head and tail are equal — it is one piece of film, not a left-aligned run");
  // "the same spacing between them by default": the end run IS the inter-frame gap.
  const cells = filmstripGeom(s(DEFAULT_LEADER_GAPS), 4).frames;
  const innerGap = cells[1].x - (cells[0].x + cells[0].w);
  assert.ok(near(one.head, innerGap), `the default leader is exactly one inter-frame gap (${one.head} vs ${innerGap})`);
  assert.ok(near(one.inGaps, 1), "and so the default reads as exactly 1 gap");
  // "perhaps even more if we set it to be that way" — no cap, and the setting IS the
  // number of gaps, exactly, at every value.
  assert.ok(near(runOf(3).inGaps, 3), "three gaps of leader really is three gaps of leader");
  assert.ok(near(runOf(20).inGaps, 20), "a very long leader is allowed — there is no ceiling on it");
  assert.ok(runOf(20).head > runOf(3).head, "and a longer leader really does push the frames further in");
  // THE BANDS RUN THROUGH THE LEADER — that is the whole point of it looking like film.
  const g = filmstripGeom(s(DEFAULT_LEADER_GAPS), 4);
  assert.equal(g.bandA.x, 0); assert.equal(g.bandA.w, STRIP.w);
  assert.equal(g.bandB.x, 0); assert.equal(g.bandB.w, STRIP.w);
  assert.equal(g.contentRect.w, STRIP.w, "and so does the film base behind the frames");
  // A single frame is centred by the same two end runs (no n === 1 special case).
  const solo = filmstripGeom({ ...STRIP, leader: DEFAULT_LEADER_GAPS, frames: [[0]] }, 1).frames[0];
  assert.ok(near(solo.x, STRIP.w - (solo.x + solo.w)), "one frame sits centred between an equal head and tail");
});

test("snapFeatures offers the frame anchors as points, and NOT the widget bbox again", () => {
  const s = { ...STRIP, frames: [[0], [1]] };
  const feats = filmstripPlugin.snapFeatures(s);
  assert.equal(feats.length, 18);
  assert.ok(feats.every((f) => f.kind === "point"));
  assert.equal(feats.some((f) => f.id === "tl"), false, "core/derive.nodeFeatures adds the bbox points itself");
});

// ── (4) THE PICTURES MOVE WITH THE STRIP (the reported defect) ───────────────

/** Query. Every drawable op inside `ops`, paired with the ABSOLUTE world it will be
 *  painted at — recursing into cropSubtree content exactly as the backends do (each
 *  content list is flattened INDEPENDENTLY from identity, which is why a nested crop
 *  must carry its own absolute world). */
function drawablesWithWorld(ops) {
  const out = [];
  const walk = (list) => {
    for (const { cmd, world } of flattenIR(list)) {
      if (cmd.op === "cropSubtree") walk(cmd.content);
      else out.push({ cmd, world });
    }
  };
  walk(ops);
  return out;
}

test("the frame ops carry the STRIP's world, not identity (the pictures move with it)", () => {
  const world = { x: 500, y: 300, rotation: 0.4, scale: 2 };
  const state = { ...filmstripPlugin.defaults, src: "clip.mp4", videoEnd: 6, frames: [[0], [2], [4]] };
  const drawn = drawablesWithWorld(filmstripPlugin.emit(state, null, world));
  const frames = drawn.filter((d) => d.cmd.op === "videoV5Frame");
  assert.equal(frames.length, 3, "one scrub op per visible frame");
  for (const f of frames)
    assert.deepEqual(f.world, world, `a frame op is pinned at ${JSON.stringify(f.world)} instead of the strip's world — the pictures would stay at the canvas origin while the strip moves`);
  // The bands moved too, and always did — the defect was that ONLY they did. They are
  // ONE even-odd `path` op since R6-11 (they were hundreds of `polygon` ops, which is
  // why this used to filter on that); the world claim is unchanged.
  const bands = drawn.filter((d) => d.cmd.op === "path");
  assert.equal(bands.length, 1, "both perforated bands ride ONE path op");
  for (const b of bands) assert.deepEqual(b.world, world);
});

test("each frame's op asks for that frame's own time, at that frame's own cell", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const state = { ...filmstripPlugin.defaults, src: "clip.mp4", videoEnd: 6, frames: [[0], [2], [4]] };
  const frames = drawablesWithWorld(filmstripPlugin.emit(state, null, world)).filter((d) => d.cmd.op === "videoV5Frame");
  assert.deepEqual(frames.map((f) => f.cmd.seekTime), [0, 2, 4]);
  assert.deepEqual(frames.map((f) => f.cmd.ref), ["clip.mp4", "clip.mp4", "clip.mp4"]);
  assert.ok(frames[0].cmd.x < frames[1].cmd.x && frames[1].cmd.x < frames[2].cmd.x, "laid out left to right");
  // A HIDDEN frame emits no op at all, and the survivors close over it.
  const closed = drawablesWithWorld(filmstripPlugin.emit({ ...state, framesActive: [true, false, true] }, null, world))
    .filter((d) => d.cmd.op === "videoV5Frame");
  assert.deepEqual(closed.map((f) => f.cmd.seekTime), [0, 4]);
  assert.ok(closed[1].cmd.x < frames[2].cmd.x, "the survivor slid into the closed gap");
});

test("the widget NEVER paints a notice on itself — an empty span is REPORTED, not drawn", () => {
  // The user's ruling on the in-widget hint this replaces: "There's also this annoying
  // big text on it that says 'Video end to second length'. I don't want that on my
  // fucking widget." The loud-failure rule still holds, so the condition goes to the
  // console channel (core/report.js, the donut/fancy_arrow precedent) and to the
  // Inspector's own "Video end (s)" help — never onto artwork that ships in the export.
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const withSpan = { ...filmstripPlugin.defaults, src: "clip.mp4", videoEnd: 6 };
  const noSpan = { ...filmstripPlugin.defaults, src: "clip.mp4" }; // videoEnd 0 = not told the clip length
  const textOps = (s) => drawablesWithWorld(filmstripPlugin.emit(s, null, world)).filter((d) => d.cmd.op === "text");
  assert.equal(textOps(withSpan).length, 0);
  assert.equal(textOps(noSpan).length, 0, "an empty span draws NO text op — no widget-mounted hint, in any state");
  // It still draws the real strip, and the predicate that names the condition survives
  // for the reporter and for anything else that needs to ask.
  assert.ok(drawablesWithWorld(filmstripPlugin.emit(noSpan, null, world)).length > 0, "the strip itself is unaffected");
  assert.equal(spanIsEmpty(noSpan), true);
  // The affordance the report points at is a REAL row, spelled exactly as the report
  // spells it — so "set Video end (s)" is findable rather than folklore.
  const row = filmstripPlugin.inspector.find((r) => r.key === "videoEnd");
  assert.equal(row.label, "Video end (s)");
  assert.match(row.help, /span is empty/i, "the row's own help explains the empty span the report names");
});

// ── (5b) THE PERFORATION FLOOR (the reported crash) ──────────────────────────

test("the hole COUNT diverges as the strip thins — that is real, and it is what crashed", () => {
  // The count for a "film"-basis format is (long/cross) * (filmWidthMm/pitchMm): a pure
  // ASPECT-RATIO quantity, so it is unbounded as the cross dimension goes to zero. Pinned
  // here as the ROOT CAUSE, separately from the floor that contains it, because it is not
  // a mistake to fix — a long thin strip really is a long piece of film. DOTS is the
  // format that still works this way (core/film.js PITCH_BASES "film": a decorative
  // pattern at an absolute pitch, not locked to the pictures).
  const holes = (h) => {
    const g = filmstripGeom({ w: 400, h, perfFamily: "DOTS" }, 6);
    return Math.floor(400 / g.perf.pitch);
  };
  assert.ok(holes(90) > 50 && holes(90) < 75, `a 400x90 dotted strip carries ~62 holes per band (got ${holes(90)})`);
  assert.ok(holes(9) > 9 * holes(90) * 0.9, "ten times thinner is ten times as many — it diverges, it does not saturate");
  assert.ok(holes(0.5) > 5000, `a 400x0.5 strip asks for ${holes(0.5)} perforations per band`);
});

test("a FRAME-LOCKED format cannot diverge at all — the count is the pulldown, not the aspect", () => {
  // The complaint "the holes don't respect the positions of the actual film images" was
  // fixed by dividing the FRAME STEP by the format's published perforations-per-frame
  // instead of holding the published millimetre pitch (plugins/filmstrip.perforationPitch).
  // A consequence worth pinning: the pitch then depends only on the LONG axis, so thinning
  // the strip no longer multiplies the holes. The floor above still earns its keep — the
  // "film"-basis DOTS format still diverges, and a frame-locked hole can still fall under
  // one pixel — but for every real stock the divergence is gone by construction.
  const holes = (h) => Math.floor(400 / filmstripGeom({ w: 400, h, perfFamily: "BH" }, 6).perf.pitch);
  assert.equal(holes(90), holes(9), "thinning the strip changes nothing about the count");
  assert.equal(holes(90), holes(0.5), "and it still changes nothing at a hundredth of the height");
  // Four perforations per picture, exactly, at any bbox — that IS the synchronisation.
  for (const [id, perFrame] of [["BH", 4], ["BH3", 3], ["BH2", 2], ["R16", 1]]) {
    for (const box of [{ w: 400, h: 90 }, { w: 1200, h: 220 }, { w: 300, h: 300 }]) {
      const g = filmstripGeom({ ...box, perfFamily: id }, 6);
      const step = g.frames[1].x - g.frames[0].x;
      assert.ok(near(step / g.perf.pitch, perFrame), `${id} at ${box.w}x${box.h}: ${perFrame} perforations per frame`);
    }
  }
});

test("PERF_FLOOR_PIXELS: below one document pixel a hole is refused, and the bound is DERIVED", () => {
  // The floor is stated in PIXELS at the document's own 1:1 output resolution (one
  // pixel per world unit — web/app.svelte.js exportPng renders THE camera at
  // Math.round(rect.w) x Math.round(rect.h)), NOT as a chosen maximum hole count.
  assert.equal(PERF_FLOOR_PIXELS, 1);
  for (const id of PERF_FAMILY_IDS) {
    const fam = PERF_FAMILIES[id];
    // The threshold cross dimension inverts the hole's smallest side, exactly.
    const want = (PERF_FLOOR_PIXELS * fam.filmWidthMm) / Math.min(fam.alongMm, fam.acrossMm);
    assert.ok(near(minPerforatedCross(id, 1), want), `${id}: the threshold must be filmWidthMm / min(alongMm, acrossMm)`);
    // And it IS the crossing point: one unit under refuses, one unit over accepts.
    const at = (h) => perforationsResolve(filmstripGeom({ w: 400, h, perfFamily: id }, 6).perf, 1);
    assert.equal(at(want + 1), true, `${id}: a hole above one pixel is drawn`);
    assert.equal(at(want - 1), false, `${id}: a sub-pixel hole is refused`);
    assert.ok(near(perforationPixels(filmstripGeom({ w: 400, h: want, perfFamily: id }, 6).perf, 1), PERF_FLOOR_PIXELS),
      `${id}: at the threshold the hole measures exactly the floor`);
  }
  // It is a PIXEL bound, so the item's own world SCALE moves it — a tiny strip blown up
  // 20x has perfectly visible perforations and gets them.
  const tiny = filmstripGeom({ w: 400, h: 2, perfFamily: "BH" }, 6).perf;
  assert.equal(perforationsResolve(tiny, 1), false);
  assert.equal(perforationsResolve(tiny, 20), true, "scale is part of the pixel size, so a scaled-up strip keeps its holes");
  assert.ok(near(minPerforatedCross("BH", 4), minPerforatedCross("BH", 1) / 4), "the threshold scales inversely, exactly");
});

test("below the floor the bands are SOLID and the geometry stops diverging (the crash is gone)", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const strip = (h) => ({ ...filmstripPlugin.defaults, src: "clip.mp4", videoEnd: 6, w: 400, h });
  const opCount = (list) => list.reduce((n, c) => n + 1 + (Array.isArray(c.content) ? opCount(c.content) : 0), 0);
  // THE OP COUNT IS NOW FLAT BY CONSTRUCTION — both bands are ONE `path` op at every
  // size (R6-11), where they used to be one convex `polygon` per tessellated quad and a
  // 400x0.5 strip built ~190k of them and threw "RangeError: Maximum call stack size
  // exceeded". So the quantity that can still diverge is the SUBPATH count inside that
  // one op's `d`, and that is what the floor governs now. Both are asserted: the op
  // count because a future emit() could reintroduce a per-piece op, the subpath count
  // because it is what the floor actually decides.
  // Read through emit(), not filmBandOps directly: the floor is emit()'s decision (it is
  // the half that can REPORT), so a probe that hands filmBandOps `perforate: true` would
  // be measuring the generator's obedience rather than the floor.
  const bandSubpaths = (h) => {
    const bands = drawablesWithWorld(filmstripPlugin.emit(strip(h), null, world)).map((d) => d.cmd).filter((c) => c.op === "path");
    assert.equal(bands.length, 1, `a 400x${h} strip must draw its bands as ONE path op, got ${bands.length}`);
    return bands[0].d.split("M").length - 1;
  };
  const healthy = opCount(filmstripPlugin.emit(strip(90), null, world));
  assert.ok(bandSubpaths(90) > 2, "above the floor the band op carries the two band rects PLUS a loop per hole");
  for (const h of [2, 0.5, 0.05, 1e-6]) {
    const ops = opCount(filmstripPlugin.emit(strip(h), null, world));
    assert.equal(ops, healthy, `a 400x${h} strip must emit the same op count as a healthy one, not more (got ${ops} vs ${healthy})`);
    assert.equal(bandSubpaths(h), 2, `a 400x${h} strip must draw two bare band rectangles`);
  }
  // Solid means literally the two band rectangles, from the same generator, so there is
  // no second code path that could disagree with the perforated one.
  const g = filmstripGeom({ w: 400, h: 0.5, perfFamily: "BH" }, 6);
  assert.equal(filmBandOps(g, "#000000", 1, false).length, 1, "one op");
  assert.equal(filmBandOps(g, "#000000", 1, false)[0].d.split("M").length - 1, 2, "two bands, one rectangle each");
});

test("perforations that would RUN INTO EACH OTHER are declined, not merged into slots", () => {
  // The drawn pitch divides the FRAME STEP (the holes lock to the pictures), so enough
  // frames on a short strip squeezes the step below one hole's own length. The retired
  // cellWithHole dropped such holes SILENTLY, per cell; even-odd would instead nest two
  // overlapping loops to depth three and fill their intersection back in as a lens.
  const roomy = filmstripGeom({ w: 480, h: 90, perfFamily: "KS" }, 6).perf;
  const crowded = filmstripGeom({ w: 480, h: 90, perfFamily: "KS" }, 24).perf;
  assert.equal(perforationsOverlap(roomy), false, "six frames leave the published land between holes");
  assert.equal(perforationsOverlap(crowded), true, `24 frames put the pitch (${crowded.pitch.toFixed(2)}) under the hole (${crowded.along.toFixed(2)})`);
  // The generator alone is honest about it, so a caller that forgets to ask still gets a
  // drawable band rather than a self-intersecting one.
  const band = { x: 0, y: 0, w: 480, h: 12 };
  assert.equal(perforatedBandPolygons(band, crowded, crowded.pitch, crowded.phase).length, 1, "the band rectangle, and no hole loops");
  // And it is REPORTED rather than silently dropped, which is the whole difference.
  const said = [];
  const realError = console.error;
  console.error = (...a) => said.push(a.join(" "));
  try {
    filmstripPlugin.emit({ ...filmstripPlugin.defaults, src: "clip.mp4", videoEnd: 6, w: 480, h: 90, perfFamily: "KS", frames: Array.from({ length: 24 }, (_, i) => [i]) }, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  } finally {
    console.error = realError;
  }
  assert.ok(said.some((m) => /overlap|run into each other/i.test(m)), `nothing was reported about the overlap: ${JSON.stringify(said).slice(0, 200)}`);
});

// ── (5c) PRESERVE ASPECT (default ON) ────────────────────────────────────────

test("preserveAspect is ON by default and rides the frame OP, since only the painter knows the size", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const base = { ...filmstripPlugin.defaults, src: "clip.mp4", videoEnd: 6, frames: [[0], [2]] };
  assert.equal(filmstripPlugin.defaults.preserveAspect, true, "default ON (user directive)");
  const framesOf = (s) => drawablesWithWorld(filmstripPlugin.emit(s, null, world)).filter((d) => d.cmd.op === "videoV5Frame");
  assert.ok(framesOf(base).every((f) => f.cmd.preserveAspect === true), "every cell carries the flag");
  assert.ok(framesOf({ ...base, preserveAspect: false }).every((f) => f.cmd.preserveAspect === false), "and turning it off clears it");
  // The letterbox CANNOT be done in emit(): the cell box is unchanged by the flag,
  // because the plugin does not know the clip's pixel size (emit is media-free). The
  // op declares the intent; the painter fits. That contract is what is pinned here.
  const on = framesOf(base).map((f) => [f.cmd.x, f.cmd.y, f.cmd.w, f.cmd.h]);
  const off = framesOf({ ...base, preserveAspect: false }).map((f) => [f.cmd.x, f.cmd.y, f.cmd.w, f.cmd.h]);
  assert.deepEqual(on, off, "the OP's box is identical either way — the fit happens where the intrinsic size exists");
  // The row exists, is a boolean, and is spelled like every other preserve-aspect row.
  const row = filmstripPlugin.inspector.find((r) => r.key === "preserveAspect");
  assert.equal(row.kind, "boolean");
  assert.ok(row.help.length > 0);
});

// ── (5) THE GAUGE IS REAL (published millimetres, one data table) ────────────

test("roundedRectBoundaryPoint is exact at the closed-form cases", () => {
  // A circle (r = hx = hy).
  const [cxp, cyp] = roundedRectBoundaryPoint(10, 10, 10, Math.PI / 4);
  assert.ok(near(Math.hypot(cxp, cyp), 10, 1e-9), "a circle's boundary is its radius in every direction");
  // A plain rectangle (r = 0): straight sides.
  assert.deepEqual(roundedRectBoundaryPoint(10, 4, 0, 0).map((v) => +v.toFixed(9)), [10, 0]);
  assert.deepEqual(roundedRectBoundaryPoint(10, 4, 0, Math.PI / 2).map((v) => +v.toFixed(9)), [0, 4]);
  // A rounded rect: mid-side points are still on the flat side...
  assert.ok(near(roundedRectBoundaryPoint(10, 4, 1, 0)[0], 10));
  // ...and the corner direction is strictly INSIDE the sharp corner it rounds off.
  const corner = roundedRectBoundaryPoint(10, 4, 1, Math.atan2(4, 10));
  assert.ok(Math.hypot(corner[0], corner[1]) < Math.hypot(10, 4), "the rounded corner is nearer than the sharp one");
  // Monotone in angle over a quadrant (what makes the sector tessellation valid).
  let prev = -Infinity;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * (Math.PI / 2);
    const p = roundedRectBoundaryPoint(10, 4, 1.5, a);
    const ang = Math.atan2(p[1], p[0]);
    assert.ok(ang >= prev - 1e-9, "the boundary must be angle-monotone for the sector split to tile");
    prev = ang;
  }
});

test("perforation geometry comes from the published millimetres, scaled by film width", () => {
  for (const id of PERF_FAMILY_IDS) {
    const fam = PERF_FAMILIES[id];
    const g = filmstripGeom({ ...STRIP, perfFamily: id }, 6);
    const perMm = STRIP.h / fam.filmWidthMm; // the strip's CROSS dimension IS the film width
    assert.ok(near(g.perf.across, fam.acrossMm * perMm), `${id}: hole size across the film`);
    assert.ok(near(g.perf.along, fam.alongMm * perMm), `${id}: hole size along travel`);
    assert.ok(near(g.perf.radius, fam.cornerRadiusMm * perMm), `${id}: corner radius`);
    // `filmPitch` is the PUBLISHED pitch scaled by film width; `pitch` is what is DRAWN,
    // which for a frame-locked format divides the frame step instead (see the sync test).
    assert.ok(near(g.perf.filmPitch, fam.pitchMm * perMm), `${id}: published pitch`);
    if (fam.pitchBasis === "film") assert.ok(near(g.perf.pitch, g.perf.filmPitch), `${id}: a "film"-basis format draws its published pitch`);
  }
  // The consequence that makes the table worth having: at the SAME on-screen size, a
  // 16 mm strip's perforations are coarser relative to the strip than a 35 mm one's.
  const bh = filmstripGeom({ ...STRIP, perfFamily: "BH" }, 6);
  const r16 = filmstripGeom({ ...STRIP, perfFamily: "R16" }, 6);
  assert.ok(r16.perf.across > bh.perf.across, "16 mm perforations are proportionally larger");
  assert.ok(r16.perf.pitch > bh.perf.pitch, "and further apart");
  assert.ok(r16.perf.filmPitch > bh.perf.filmPitch, "on the published millimetres too");
  assert.ok(r16.contentRect.h < bh.contentRect.h, "so less of the strip is image");
  // An unknown family falls back to the default rather than producing NaN geometry.
  assert.deepEqual(filmstripGeom({ ...STRIP, perfFamily: "nope" }, 6).perf, bh.perf);
});

test("the stock presets are DATA — a name, a perforation family, a base colour", () => {
  assert.ok(filmstripPlugin.presets.length >= 4);
  for (const p of filmstripPlugin.presets) {
    assert.ok(p.name && p.description, `preset "${p.name}" needs a name and a description`);
    assert.ok(PERF_FAMILY_IDS.includes(p.props.perfFamily), `preset "${p.name}" names an unknown perforation family`);
    assert.match(p.props.filmColor, /^#[0-9a-f]{6}$/i, `preset "${p.name}" needs a base colour`);
    assert.deepEqual(Object.keys(p.props).sort(), ["filmColor", "perfFamily"], `preset "${p.name}" writes a key no preset should`);
  }
  // Presets differ on the axes that are REAL (gauge/type), not on manufacturer — the
  // perforation families are shared across makers, so a brand pair would be look-alikes.
  const combos = new Set(filmstripPlugin.presets.map((p) => `${p.props.perfFamily}|${p.props.filmColor}`));
  assert.equal(combos.size, filmstripPlugin.presets.length, "two presets would render identically");
});

test("no two presets draw the SAME holes at the same spacing (the look-alike complaint)", () => {
  // THE DEFECT THIS GATE EXISTS FOR. The five presets this set replaces varied one
  // nearly-invariant axis: three of them named "BH" and produced BYTE-IDENTICAL
  // perforation geometry, and the fourth ("KS") differed by 0.025 canvas units of pitch
  // on this very bbox. "Why are the film holes always the same regardless of the preset?"
  // was a correct reading of the pixels, so the gate is stated in DRAWN geometry — never
  // in "the preset tables differ", which was true the whole time it looked wrong.
  const box = { w: 480, h: 90, vertical: false };
  const drawn = filmstripPlugin.presets.map((p) => {
    const g = filmstripGeom({ ...box, ...p.props }, 6);
    return { name: p.name, color: p.props.filmColor, perf: g.perf, band: g.bandA.h };
  });
  // Two presets are DISTINGUISHABLE if some drawn hole dimension differs by at least a
  // quarter of a canvas unit, or the film colour differs. A quarter unit is the smallest
  // difference that can survive to a pixel at 1:1 with antialiasing; the old KS-vs-BH
  // pitch difference (0.025) is an order of magnitude under it and correctly fails.
  const VISIBLE_UNITS = 0.25;
  // Perforating one edge instead of two is not a length at all, so it is scored as
  // decisive rather than compared against the length threshold.
  const DECISIVE = Infinity;
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i], b = drawn[j];
      const geometryDiff = Math.max(
        Math.abs(a.perf.along - b.perf.along), Math.abs(a.perf.across - b.perf.across),
        Math.abs(a.perf.radius - b.perf.radius), Math.abs(a.perf.pitch - b.perf.pitch),
        Math.abs(a.band - b.band), a.perf.sides === b.perf.sides ? 0 : DECISIVE
      );
      assert.ok(geometryDiff >= VISIBLE_UNITS || a.color !== b.color,
        `"${a.name}" and "${b.name}" render the same strip (biggest geometry difference ${geometryDiff.toFixed(3)} units, same colour ${a.color})`);
    }
  }
  // And the SET must actually exercise the axes, not just avoid exact ties: more than one
  // pulldown, more than one gauge, and both single- and double-perforated stock.
  const cells = filmstripGeom(box, 6).frames;         // the frame step is family-independent
  const step = cells[1].x - cells[0].x;
  const perFrame = new Set(drawn.map((d) => Math.round(step / d.perf.pitch)));
  assert.ok(perFrame.size >= 4, `the presets should span several pulldowns, they span ${[...perFrame].sort((a, b) => a - b)}`);
  assert.equal(new Set(drawn.map((d) => d.perf.sides)).size, 2, "single-perf and double-perf stock are both represented");
});

test("a perforation can be RECTANGULAR or CIRCULAR — one shape function, chosen by DATA", () => {
  // "What happened to being able to be rectangular holes or circular holes?" — the answer
  // is that a circle is the degenerate rounded rect (along == across == 2*radius), so it
  // needs no renderer of its own, only a table row that asks for one. DOTS is that row.
  const dots = PERF_FAMILIES.DOTS;
  assert.equal(dots.alongMm, dots.acrossMm, "a round hole is as long as it is wide");
  assert.equal(dots.cornerRadiusMm * 2, dots.alongMm, "and its radius is half its width");
  // Proven on the BOUNDARY, not on the parameters: every sampled direction is the same
  // distance from the centre for DOTS, and demonstrably NOT for a 35 mm perforation.
  const spread = (fam) => {
    const r = [];
    for (let i = 0; i < 32; i++) {
      const [px, py] = roundedRectBoundaryPoint(fam.alongMm / 2, fam.acrossMm / 2, fam.cornerRadiusMm, (i / 32) * 2 * Math.PI);
      r.push(Math.hypot(px, py));
    }
    return Math.max(...r) / Math.min(...r);
  };
  assert.ok(near(spread(dots), 1, 1e-9), "DOTS is a circle to machine precision");
  assert.ok(spread(PERF_FAMILIES.BH) > 1.4, "and a BH perforation is emphatically not one");
  assert.ok(spread(PERF_FAMILIES.KS) > 1.4, "nor is a KS one");
});

// ── (6) LEGACY DOCUMENTS MIGRATE LOUDLY ──────────────────────────────────────

/** Pure function. A one-slide document holding one filmstrip with `extra` merged in. */
const docWith = (extra) => ({
  meta: {},
  slides: [{
    id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
    delta: {
      items: {
        cam: { type: "camera", name: "Cam", x: 0, y: 0, w: 480, h: 360, z: 1000, rotation: 0, scale: 1, active: true },
        f: { type: "filmstrip", name: "Strip", x: 10, y: 10, w: 480, h: 90, z: 1, rotation: 0, scale: 1, active: true, src: "clip.mp4", ...extra },
      },
      vars: {},
    },
  }],
});

test("a legacy numeric `frames` COUNT becomes a list of the SAME length, loudly", () => {
  const { doc, reports } = repairedDocument(docWith({ frames: 3, frameUrls: ["a", "b", "c"], frameW: 320, frameH: 240 }), registry);
  const item = doc.slides[0].delta.items.f;
  assert.deepEqual(item.frames, defaultFrameList(3), "the author's frame COUNT is preserved as the list's LENGTH");
  for (const dead of ["frameUrls", "frameW", "frameH"])
    assert.equal(dead in item, false, `the dead server-era key "${dead}" survived — it was the widget's old "do I have frames" signal, so a stale copy is a trap`);
  assert.ok(reports.some((r) => /legacy filmstrip frame COUNT \(3\)/.test(r)), `no report named the frames migration:\n${reports.join("\n")}`);
  assert.ok(reports.some((r) => /dropped dead filmstrip key/.test(r)), `no report named the dropped keys:\n${reports.join("\n")}`);
});

test("the migration is IDEMPOTENT — a repaired document repairs to silence", () => {
  const once = repairedDocument(docWith({ frames: 5 }), registry);
  const twice = repairedDocument(once.doc, registry);
  assert.deepEqual(twice.reports, []);
  assert.deepEqual(twice.doc.slides[0].delta.items.f.frames, once.doc.slides[0].delta.items.f.frames);
});

test("a CURRENT document is not touched, and gains the span defaults", () => {
  const { doc, reports } = repairedDocument(docWith({ frames: [[0], [1]], videoStart: 0, videoEnd: 4 }), registry);
  assert.deepEqual(doc.slides[0].delta.items.f.frames, [[0], [1]]);
  assert.equal(reports.some((r) => /filmstrip frame COUNT/.test(r)), false);
});

// ── (7) THE GHOST ────────────────────────────────────────────────────────────

test("a sourceless strip is a ghost AND emits nothing (the symmetry)", () => {
  assert.equal(filmstripPlugin.isGhost(filmstripPlugin.defaults), true);
  assert.deepEqual(filmstripPlugin.emit(filmstripPlugin.defaults, null, { x: 0, y: 0, rotation: 0, scale: 1 }), []);
  assert.equal(filmstripPlugin.isGhost({ src: "clip.mp4" }), false);
});

console.log(`\nfilmstrip tests: ${passed} passed`);
