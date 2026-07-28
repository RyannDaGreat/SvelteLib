/**
 * THE STATIC MATERIAL RASTER CACHE — correctness gate.
 *
 * A FOREGROUND material (`materialFill`, `backdrop: false`) synthesizes its whole look
 * from its own uniforms: no children, no composite read, and its plugin's emit() never
 * sees the camera. So panning the editor over one re-ran a per-pixel shader to produce
 * a picture that had not changed. paint_skia.js now rasterizes each fill into a
 * REGION-LOCAL raster keyed by its packed uniforms and reuses it while those uniforms
 * repeat (see the "STATIC MATERIAL RASTER CACHE" section there for the full argument).
 *
 * A cache is only ever an optimization, so this suite is about the ways it could stop
 * being one:
 *
 *   1. HIT == MISS, BYTE FOR BYTE, for EVERY foreground material at several device
 *      sizes — compared, not asserted in the abstract. If a hit differed from a miss
 *      the render would depend on how long the widget had been on screen, which the
 *      purity invariant (RenderTree = pure(document, [[slide, alpha]])) forbids.
 *   2. A PAN at constant zoom HITS; a ZOOM, a RESIZE or ANY changed knob MISSES, and a
 *      ROTATION may only reuse a raster when the shader never reads `angle`. Camera
 *      zoom is a real input (more device pixels = finer sampling), pan is not.
 *   3. NOTHING outside the packed uniforms can reach the raster — the structural
 *      reason the key is complete. Asserted against the SkSL itself: a foreground
 *      material may declare no `uniform shader` child and no derivative intrinsic.
 *   4. A material whose knobs MOVE every frame is never admitted, so "cacheable" needs
 *      no declaration and no allowlist to drift out of step with the plugins.
 *   5. The budget refuses an oversized raster and evicts LRU rather than growing.
 *
 * FIXTURES ARE DERIVED, NOT MIRRORED: every materialFill op here comes from a real
 * plugin's emit() at its shipped defaults, and the suite FAILS if a registered
 * foreground material has no plugin that produces one. Hand-written param fixtures are
 * how sibling probes came to die on `pack: "flareScale" must be a finite number`.
 *
 * Run: node tests/material_raster_cache_test.js
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { paintIR, materialRasterStats } from "../render_gpu/skia/paint_skia.js";
import { rect, pushTransform, popTransform } from "../render_gpu/ir.js";
import { allPlugins } from "../plugins/index.js";
import { materialIds, getMaterial, isBackdropMaterial, isSamplerMaterial, isFillCapableMaterial, materialFillParamDefaults } from "../render_gpu/skia/materials.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const HERE = path.dirname(fileURLToPath(import.meta.url)); // resolve from import.meta.url, never process.cwd()

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // the scenes carry no text

// ONE identity-stable surface factory for the whole suite. The cache partitions by
// factory identity (≙ one GrContext — render_gpu/skia/video_v2.js's caller contract),
// so a fresh closure per pass would look like a new context every frame and never hit.
const makeSurface = (w, h) => CanvasKit.MakeSurface(w, h);

// Small boxes on purpose: this suite tests the CACHE, which is agnostic to what the
// shader computes, and a 2048-iteration Mandelbrot costs ~0.33 ms per device pixel on
// the software surface bare node gives us.
const BOX = { halfW: 22, halfH: 15 };
const SINK = { w: 220, h: 150 };
const VIEW = { zoom: 1, panX: 30, panY: 20, dpr: 1 };
// TWO DEVICE SIZES for the identity gate. The sink's size is not one of them — a fill's
// raster is sized by the WIDGET, so the same widget on a bigger canvas is the same
// raster. Camera zoom is what resizes it (and 0.62 also lands the centre on a
// FRACTIONAL device coordinate, the case where re-anchoring the shader's coordinates
// could have changed the arithmetic).
const VIEWS = [VIEW, { ...VIEW, zoom: 0.62 }];
const WORLD = { x: 34, y: 26, rotation: 0, scale: 1 };

/**
 * Query. materialId → a real `materialFill` op, derived from the plugin roster at
 * shipped defaults. Camera-bound frames (`= camera.w` equations) and effect-wrapped
 * emits are resolved with plain numbers and an identity world, which is what sceneIR
 * would hand emit().
 */
function fixtures() {
  const out = new Map();
  for (const plugin of allPlugins) {
    const state = { ...plugin.defaults, x: 0, y: 0, world: { x: 0, y: 0, rotation: 0, scale: 1 } };
    for (const k of ["w", "h", "cx", "cy"]) if (typeof state[k] !== "number") state[k] = k === "w" || k === "cx" ? 240 : 150;
    let ops;
    try { ops = plugin.emit(state, null, { x: 0, y: 0, rotation: 0, scale: 1 }); } catch { continue; }
    if (!Array.isArray(ops)) continue;
    const walk = (list) => {
      for (const op of list) {
        if (op?.op === "materialFill" && !out.has(op.material)) out.set(op.material, op);
        if (Array.isArray(op?.content)) walk(op.content);
      }
    };
    walk(ops);
  }
  // PAINT-ONLY foreground materials have NO widget plugin (metal is applied to shapes as a
  // FILL, never as a standalone widget), so no emit() produces one. Synthesize their
  // fixture the same way handleMaterialPaintShape does — the material's OWN schema defaults
  // through toUniformParams — which is still DERIVED from the single source of truth (its
  // fillParams), not a hand-typed param mirror.
  for (const id of materialIds()) {
    const m = getMaterial(id);
    if (out.has(id) || isSamplerMaterial(m) || isBackdropMaterial(m) || !isFillCapableMaterial(m)) continue;
    const defaults = materialFillParamDefaults(m);
    const params = m.toUniformParams ? m.toUniformParams(defaults) : defaults;
    out.set(id, { op: "materialFill", material: id, params, cornerRadius: 0, opacity: 1 });
  }
  return out;
}

/** Query. The registered FOREGROUND material ids (the cacheable half of the registry). */
function foregroundIds() {
  return materialIds().filter((id) => {
    const m = getMaterial(id);
    return !isSamplerMaterial(m) && !isBackdropMaterial(m);
  });
}

const FIXTURES = fixtures();
const FOREGROUND = foregroundIds();

/** Pure. A scene: an opaque gradient page plus one material fill at `box`. */
function scene(op, size, box = BOX) {
  return [
    rect({ x: 0, y: 0, w: size.w, h: size.h, fill: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#0a1230" }, { offset: 1, color: "#241a10" }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } } } }),
    pushTransform(WORLD),
    { ...op, cx: box.halfW, cy: box.halfH, halfW: box.halfW, halfH: box.halfH },
    popTransform(),
  ];
}

/** Command. Paints `commands` onto a fresh `size` sink and returns its RGBA bytes.
 * `factory` is the offscreen-surface factory whose IDENTITY the cache partitions by. */
function frameBytes(commands, size, view = VIEW, factory = makeSurface) {
  const surface = CanvasKit.MakeSurface(size.w, size.h);
  if (!surface) throw new Error("material_raster_cache_test: sink MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), commands, view, { fontCollection, background: "#05060c", makeSurface: factory });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = Buffer.from(img.readPixels(0, 0, {
    width: size.w, height: size.h,
    colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  }));
  img.delete(); surface.dispose();
  return px;
}

/** Pure. Differing byte count + worst level delta between two equal-length buffers.
 * @example byteDiff(Buffer.from([1, 2]), Buffer.from([1, 5])) // {n: 1, max: 3}
 */
function byteDiff(a, b) {
  assert.equal(a.length, b.length, "frames must be the same size to compare");
  let n = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) { n++; if (d > max) max = d; }
  }
  return { n, max };
}

// ── 0. the fixture floor: every foreground material must be reachable ─────────
test("every registered FOREGROUND material has a plugin-derived fixture", () => {
  const missing = FOREGROUND.filter((id) => !FIXTURES.has(id));
  assert.deepEqual(missing, [], `no plugin emit(defaults) produced a materialFill for: ${missing.join(", ")} — add one, or this suite silently stops covering it`);
  assert.ok(FOREGROUND.length >= 10, `expected the shipped foreground roster (corkboard family, sky family, lens flare, raycast dither, mandelbrot), got ${FOREGROUND.length}`);
});

// ── 3. STRUCTURAL: nothing outside the packed uniforms can reach the raster ───
// This is WHY keying on the packed uniform bytes is complete rather than merely
// thorough. A `uniform shader` child would let the shader sample the composite (which
// the camera moves); a derivative intrinsic would make a pixel depend on its
// neighbours' screen position. Neither may appear in a foreground material.
test("no foreground material can see anything outside its uniforms", () => {
  const rows = [];
  for (const id of FOREGROUND) {
    const m = getMaterial(id);
    assert.ok(typeof m.sksl === "string" && m.sksl.length > 0, `${id}: a foreground material must carry SkSL`);
    const children = m.sksl.match(/uniform\s+shader\s+\w+/g) ?? [];
    assert.deepEqual(children, [], `${id}: declares child shader(s) ${children.join(", ")} — a foreground material that samples the composite is camera-dependent and must not be raster-cached (register it as a backdrop material instead)`);
    const derivatives = m.sksl.match(/\b(fwidth|dFdx|dFdy)\s*\(/g) ?? [];
    assert.deepEqual(derivatives, [], `${id}: uses ${derivatives.join(", ")} — a screen-space derivative makes the raster depend on the sampling grid outside the uniforms`);
    assert.equal(typeof m.pack, "function", `${id}: needs a pure packer — it is the key`);
    rows.push(`  ${id.padEnd(20)} ${String(m.uniformFloats).padStart(5)} uniform floats`);
  }
  console.log(rows.join("\n"));
});

// ── 2b. the KEY's sensitivity, provable without rendering ────────────────────
// The lookup key IS the packed uniform bytes (plus the raster's pixel size), so "can a
// changed input be missed?" reduces to "does pack() move when the input moves?".
// The SDF centre must always be visible — a material that could not see where it is
// would be nonsense. The rest is REPORTED rather than asserted, because an input a
// packer legitimately ignores cannot reach the shader either and so has nothing to
// invalidate (the thumbtack's dome is a disc: it reads halfW and ignores halfH).
// What CANNOT be missed is proven structurally by the test above and empirically by
// the pixel gates below.
const PACK_BASE = { cx: 120, cy: 80, halfW: 60, halfH: 40, cornerRadius: 6, angle: 0.2, scale: 1.5 };

/** Query. A material's packed uniform bytes at PACK_BASE + its fixture params + `u`. */
function packBytes(id, u = {}) {
  const m = getMaterial(id);
  return Buffer.from(new Uint8Array(m.pack({ ...PACK_BASE, ...FIXTURES.get(id).params, ...u }).buffer).slice());
}

/** Pure function. A perturbed copy of a knob value — a number nudged, a flag flipped, a
 * colour changed, the first element of a list (or of a list of records) nudged — or
 * null when the value has no perturbable form.
 *
 * @example perturbed(2) // 3.37
 * @example perturbed("#112233") // "#0f7a3d"
 * @example perturbed([1, 2]) // [2.37, 2]
 * @example perturbed([{intensity: 3}]) // [{intensity: 4.37}]
 */
function perturbed(v) {
  if (typeof v === "number") return v + 1.37;
  if (typeof v === "boolean") return !v;
  if (typeof v === "string") return v.startsWith("#") ? "#0f7a3d" : v === "" ? null : v + "";
  if (ArrayBuffer.isView(v)) { const c = v.slice(); if (!c.length) return null; c[0] = c[0] + 1.37; return c; }
  if (Array.isArray(v)) {
    if (!v.length) return null;
    const head = perturbed(v[0]);
    return head === null ? null : [head, ...v.slice(1)];
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) { const m = perturbed(v[k]); if (m !== null && m !== v[k]) return { ...v, [k]: m }; }
    return null;
  }
  return null;
}

/** Query. The inputs of `id` (geometry fields and fixture knobs) that pack() ignores. */
function unpackedInputs(id, inputs) {
  const ref = packBytes(id);
  return inputs.filter((k) => {
    const v = { ...PACK_BASE, ...FIXTURES.get(id).params }[k];
    const moved = perturbed(v);
    return moved === null || moved === v || packBytes(id, { [k]: moved }).equals(ref);
  });
}

test("the packed uniforms — the key — move with the material's inputs", () => {
  const rows = [];
  for (const id of FOREGROUND) {
    for (const k of ["cx", "cy"])
      assert.notDeepEqual(packBytes(id, { [k]: PACK_BASE[k] + 7 }), packBytes(id), `${id}: moving "${k}" left the packed uniforms unchanged — the material cannot see where its own region is`);
    const geometry = ["halfW", "halfH", "cornerRadius", "angle", "scale"];
    const knobs = Object.keys(FIXTURES.get(id).params);
    const blindGeom = unpackedInputs(id, geometry);
    const blindKnobs = unpackedInputs(id, knobs);
    assert.ok(blindGeom.length < geometry.length, `${id}: pack() ignores its whole geometry block`);
    rows.push(`  ${id.padEnd(20)} ${String(knobs.length).padStart(2)} knobs, ${knobs.length - blindKnobs.length} reach the uniforms${blindKnobs.length ? ` (not packed: ${blindKnobs.join(", ")})` : ""}${blindGeom.length ? `; geometry not packed: ${blindGeom.join(", ")}` : ""}`);
  }
  console.log(rows.join("\n"));
});

// ── 1 + 2. THE PIXEL GATE: hit == miss, and what must miss ───────────────────
test("HIT is byte-identical to MISS for every foreground material, at two device sizes", () => {
  const rows = [];
  for (const id of FOREGROUND) {
    const op = FIXTURES.get(id);
    for (const view of VIEWS) {
      const s0 = materialRasterStats();
      const commands = scene(op, SINK);
      const first = frameBytes(commands, SINK, view);   // miss, first sighting ⇒ not admitted
      const admit = frameBytes(commands, SINK, view);   // miss, ADMITTED (same key two passes running)
      const hit = frameBytes(commands, SINK, view);     // HIT
      const s1 = materialRasterStats();
      assert.equal(s1.admits - s0.admits, 1, `${id} @zoom ${view.zoom}: expected exactly one admission (got ${s1.admits - s0.admits})`);
      assert.equal(s1.hits - s0.hits, 1, `${id} @zoom ${view.zoom}: expected exactly one cache HIT (got ${s1.hits - s0.hits}) — the rest of this check would prove nothing`);
      const d1 = byteDiff(first, admit), d2 = byteDiff(admit, hit);
      assert.equal(d2.n, 0, `${id} @zoom ${view.zoom}: a HIT differs from a MISS in ${d2.n} bytes (max Δ${d2.max}) — the frame depends on cache state`);
      assert.equal(d1.n, 0, `${id} @zoom ${view.zoom}: two MISSES of the same key differ in ${d1.n} bytes — the raster is not a function of its key`);
      rows.push(`  ${id.padEnd(20)} zoom ${String(view.zoom).padEnd(5)} first==admit==hit`);
    }
  }
  console.log(rows.join("\n"));
});

test("a PAN hits; a ZOOM, a RESIZE and a changed knob miss — and nothing serves a stale raster", () => {
  const rows = [];
  for (const id of FOREGROUND) {
    const op = FIXTURES.get(id);
    const commands = scene(op, SINK);
    frameBytes(commands, SINK); frameBytes(commands, SINK); // sight + admit
    const s0 = materialRasterStats();
    // PAN by whole device px: the raster is re-anchored to its own region, so only the
    // blit offset changes. THE point of the whole exercise.
    frameBytes(commands, SINK, { ...VIEW, panX: VIEW.panX + 41, panY: VIEW.panY - 17 });
    const panned = materialRasterStats();
    assert.equal(panned.hits - s0.hits, 1, `${id}: a pan at constant zoom must HIT (it changed nothing the shader sees)`);
    // ZOOM: more device pixels per world unit ⇒ a different sampling ⇒ must re-render.
    frameBytes(commands, SINK, { ...VIEW, zoom: 1.3 });
    const zoomed = materialRasterStats();
    assert.equal(zoomed.hits - panned.hits, 0, `${id}: a camera ZOOM must MISS — the same window sampled at a new resolution is a different picture`);
    // RESIZE: a different raster size, which is part of the key whatever the packer does.
    frameBytes(scene(op, SINK, { halfW: BOX.halfW + 9, halfH: BOX.halfH + 5 }), SINK);
    const resized = materialRasterStats();
    assert.equal(resized.hits - zoomed.hits, 0, `${id}: a RESIZE must MISS`);
    // ROTATION: the circumradius region is rotation-invariant, so a rotation may reuse
    // a raster — but ONLY when the shader never reads `angle` (then the picture really
    // is the same). If it reads `angle`, reuse would be a stale picture.
    const spun = [...commands];
    spun[1] = pushTransform({ ...WORLD, rotation: 0.31 });
    frameBytes(spun, SINK);
    const rotated = materialRasterStats();
    const readsAngle = unpackedInputs(id, ["angle"]).length === 0;
    assert.ok(rotated.hits - resized.hits === 0 || !readsAngle, `${id}: a ROTATION reused a raster although the shader READS \`angle\` — that is a stale picture`);
    // A CHANGED KNOB — the first fixture knob that reaches the uniforms (a knob the
    // packer ignores cannot change the picture, so it is not a staleness risk).
    const knobs = Object.keys(op.params).filter((k) => typeof op.params[k] === "number");
    const blind = new Set(unpackedInputs(id, knobs));
    const knob = knobs.find((k) => !blind.has(k));
    assert.ok(knob, `${id}: fixture exposes no numeric knob that reaches the uniforms`);
    frameBytes(scene({ ...op, params: { ...op.params, [knob]: op.params[knob] + 1.37 } }, SINK), SINK);
    const knobbed = materialRasterStats();
    assert.equal(knobbed.hits - rotated.hits, 0, `${id}: changing "${knob}" must MISS — a stale picture is the worst failure this cache could have`);
    rows.push(`  ${id.padEnd(20)} pan HIT; zoom/resize/${knob} MISS; rotate ${rotated.hits - resized.hits ? "reuse (angle unread)" : "MISS"}`);
  }
  console.log(rows.join("\n"));
});

// ── 4. "cacheable" is declared by the uniforms, not by a list ─────────────────
test("a material whose knobs move every frame is never admitted", () => {
  const op = FIXTURES.get("raycast_dither") ?? FIXTURES.get(FOREGROUND[0]);
  const knobs = Object.keys(op.params).filter((k) => typeof op.params[k] === "number");
  const blind = new Set(unpackedInputs(op.material, knobs));
  const knob = knobs.find((k) => !blind.has(k));
  const s0 = materialRasterStats();
  const FRAMES = 6; // enough passes that a two-touch admission would have fired several times
  // Every frame a value nothing has rendered before — which is what "animating" IS.
  for (let i = 0; i < FRAMES; i++)
    frameBytes(scene({ ...op, params: { ...op.params, [knob]: op.params[knob] + 91 + i * 0.37 } }, SINK), SINK);
  const s1 = materialRasterStats();
  assert.equal(s1.admits - s0.admits, 0, `an animating material was admitted ${s1.admits - s0.admits} times — it would fill the cache with pictures nothing ever asks for again`);
  assert.equal(s1.hits - s0.hits, 0, "an animating material cannot hit — every frame is a new picture");
  assert.equal(s1.misses - s0.misses, FRAMES, "each animated frame must render exactly once");
  console.log(`  ${FRAMES} frames of a moving knob ⇒ ${s1.misses - s0.misses} renders, 0 admissions, 0 evictions`);
});

test("a first sighting is drawn but never retained (a drag inserts nothing)", () => {
  const op = FIXTURES.get(FOREGROUND[0]);
  const s0 = materialRasterStats();
  // A DRAG: a new geometry every frame, so no key ever repeats.
  for (let i = 0; i < 5; i++) frameBytes(scene(op, SINK, { halfW: BOX.halfW + 31 + i, halfH: BOX.halfH }), SINK);
  const s1 = materialRasterStats();
  assert.equal(s1.admits - s0.admits, 0, "a drag admitted an entry — eviction would then thrash for the whole drag");
  assert.equal(s1.evictions - s0.evictions, 0, "a drag evicted an entry it should never have inserted");
});

// ── 4a. the PROXY path neither reads nor writes the cache ────────────────────
test("a proxy-quality pass cannot poison the full-quality cache, or be served by it", () => {
  // At quality:"proxy" every materialFill is replaced by a cheap Skia stand-in
  // (materials.resolveProxyFill) BEFORE it reaches the fill handler, so the two
  // qualities can never exchange rasters. If that ever changed, a thumbnail's
  // flat-colour stand-in could be blitted into the editor.
  const op = FIXTURES.get(FOREGROUND[0]);
  const commands = scene(op, SINK, { halfW: BOX.halfW + 5, halfH: BOX.halfH + 3 });
  const paintProxy = () => {
    const surface = CanvasKit.MakeSurface(SINK.w, SINK.h);
    paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, { fontCollection, background: "#05060c", makeSurface, quality: "proxy" });
    surface.flush(); surface.dispose();
  };
  const s0 = materialRasterStats();
  for (let i = 0; i < 3; i++) paintProxy();
  const s1 = materialRasterStats();
  assert.deepEqual(
    { hits: s1.hits - s0.hits, misses: s1.misses - s0.misses, admits: s1.admits - s0.admits },
    { hits: 0, misses: 0, admits: 0 },
    "a proxy pass touched the material raster cache",
  );
  // And full quality still caches normally afterwards (the proxy passes did not
  // consume the admission frontier).
  frameBytes(commands, SINK); frameBytes(commands, SINK); frameBytes(commands, SINK);
  const s2 = materialRasterStats();
  assert.equal(s2.admits - s1.admits, 1, "full quality must still admit after interleaved proxy passes");
  assert.equal(s2.hits - s1.hits, 1, "full quality must still hit after interleaved proxy passes");
});

// ── 4b. two contexts rendering alternately must BOTH still cache ─────────────
test("interleaved contexts each keep their own admission frontier", () => {
  // The editor surface and the presenter surface (or the offscreen pixel service) are
  // separate GL contexts rendering alternating passes. With ONE shared frontier each
  // pass would wipe the other's keys and NEITHER would ever admit — a silent
  // never-caches, which is why the frontier lives on the partition.
  const other = (w, h) => CanvasKit.MakeSurface(w, h); // a SECOND identity-stable factory
  const op = FIXTURES.get(FOREGROUND[0]);
  const commands = scene(op, SINK, { halfW: BOX.halfW + 17, halfH: BOX.halfH + 11 });
  const paintWith = (factory) => {
    const surface = CanvasKit.MakeSurface(SINK.w, SINK.h);
    paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, { fontCollection, background: "#05060c", makeSurface: factory });
    surface.flush(); surface.dispose();
  };
  const s0 = materialRasterStats();
  for (let i = 0; i < 3; i++) { paintWith(makeSurface); paintWith(other); }
  const s1 = materialRasterStats();
  assert.equal(s1.admits - s0.admits, 2, `each of the two contexts must admit exactly once (got ${s1.admits - s0.admits})`);
  assert.equal(s1.hits - s0.hits, 2, `each context must hit on its third pass (got ${s1.hits - s0.hits})`);
});

// ── 5. the memory bound ──────────────────────────────────────────────────────
test("the budget evicts LRU instead of growing, and refuses a raster no frame can hold", () => {
  // FOUR device frames of RGBA8888 is the budget (MATERIAL_RASTER_CACHE_FRAMES — sized
  // for the shipped four-material sky composition). A TINY surface therefore has a tiny
  // budget: a handful of distinct rasters must start evicting.
  const tiny = { w: 90, h: 60 };
  const budget = 4 * tiny.w * tiny.h * 4;
  const op = FIXTURES.get(FOREGROUND[0]);
  // Its OWN context, so the byte total it can reason about is its own growth (the
  // stats are global across partitions by design).
  const tinyFactory = (w, h) => CanvasKit.MakeSurface(w, h);
  const s0 = materialRasterStats();
  // Six distinct sizes, each admitted (drawn twice in a row), all in one partition.
  for (let i = 0; i < 6; i++) {
    const box = { halfW: 20 + i * 3, halfH: 14 + i * 2 };
    frameBytes(scene(op, tiny, box), tiny, VIEW, tinyFactory);
    frameBytes(scene(op, tiny, box), tiny, VIEW, tinyFactory);
  }
  const s1 = materialRasterStats();
  assert.ok(s1.admits - s0.admits >= 5, `expected the distinct rasters to be admitted, got ${s1.admits - s0.admits}`);
  assert.ok(s1.evictions - s0.evictions > 0, "the budget never evicted — it is not bounding anything");
  assert.ok(s1.bytes - s0.bytes <= budget, `this context retained ${s1.bytes - s0.bytes} B, over the ${budget} B budget for a ${tiny.w}×${tiny.h} frame`);
  // An oversized raster: a fill far bigger than four frames of the surface it draws on
  // is refused (and still drawn correctly — the shader just re-runs every frame).
  const huge = { halfW: 700, halfH: 500 };
  const before = materialRasterStats();
  frameBytes(scene(op, tiny, huge), tiny, VIEW, tinyFactory);
  const drawn = frameBytes(scene(op, tiny, huge), tiny, VIEW, tinyFactory);
  const again = frameBytes(scene(op, tiny, huge), tiny, VIEW, tinyFactory);
  const after = materialRasterStats();
  assert.equal(after.admits - before.admits, 0, "an oversized raster must not be retained");
  assert.ok(after.refusals - before.refusals >= 3, `an oversized raster must be COUNTED as refused each pass (got ${after.refusals - before.refusals}) — a silently slow widget is the failure mode here`);
  assert.equal(byteDiff(drawn, again).n, 0, "an un-retained fill must still be deterministic frame to frame");
  console.log(`  ${tiny.w}×${tiny.h} frame ⇒ ${(budget / 1e6).toFixed(2)} MB budget; this context retained ${((s1.bytes - s0.bytes) / 1e6).toFixed(2)} MB after 6 distinct rasters (${s1.evictions - s0.evictions} evictions)`);
  console.log(`  (artifacts resolve from import.meta.url: ${HERE})`);
});
