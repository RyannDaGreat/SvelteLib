/**
 * THE 3D VIEWPORT FAMILY — bare node, no framework, no browser, no GPU.
 * Run: node src/demo_apps/PowerRP/tests/scene3d_test.js
 *
 * WHAT THIS PROVES, and why each one is here rather than in the browser probe:
 *
 *   1. THE FAMILY IS A FAMILY — two members from one factory, distinct types,
 *      both registrable. A duplicate type throws inside registry.register, so
 *      this is the ratchet on the namespacing decision.
 *   2. THE CAMERA IS PROPERTY STATE, mechanically. Every key `sceneCamera.writes`
 *      produces is a real leaf of the widget's own defaults — the same assertion
 *      tests/activation_migration_test.js makes for interiorView, and the reason
 *      it matters is identical: a write to a key the widget does not declare
 *      keyframes a property nothing reads, which is invisible and permanent.
 *   3. pose→writes ROUND-TRIPS. An untouched pose writes the state back
 *      unchanged, so entering fly mode and letting go cannot silently move the
 *      camera. (interiorNav's own round-trip test, one dimension up.)
 *   4. THE REF IS THE CACHE (R6-1.7). Same inputs ⇒ same ref; any pose, size,
 *      source or look change ⇒ a different ref. That is the whole caching claim,
 *      and it is provable with no renderer because the claim is about the KEY.
 *      A pixel-level cache HIT is the probe's job; this is the half that can be
 *      proven for free, and it is the half that breaks silently when someone adds
 *      a property and forgets the look digest.
 *   5. THE RESOLUTION CONTRACT'S ARITHMETIC. Follow-widget-size scales with the
 *      node's own world scale; Fixed does NOT, whatever the zoom — R6-1.8.
 *   6. THE POSE MATH IS GEOMETRY, not vibes: the eye really is `distance` from
 *      the target, the up vector really is unit and really is perpendicular to
 *      the view direction, and roll really rotates it.
 *   7. THE GESTURES ACCUMULATE and clamp — orbit is linear in the drag, dolly and
 *      FOV take the canvas's own exponential law, FOV cannot leave its lens range.
 *   8. BARE NODE REFUSES LOUDLY AND STILL EMITS. There is no DOM here, so the
 *      widget cannot draw — and it must emit the `image` op anyway, because that
 *      op is what cli/render.js counts when it reports the media it OMITTED. A
 *      3D widget that emitted nothing would exit 0 with a silent hole, which is
 *      the exact defect the map widget already recorded.
 *   9. THE ENGINE IS NOT IN THE NODE GRAPH. This file importing at all proves the
 *      three.js import is lazy; assertion 9 makes that explicit rather than
 *      incidental, because it is a rule ("no `import from "three"` outside
 *      scene3d_raster.js") that a future edit could break without any test going
 *      red.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE: that anything renders. That needs a GPU
 * and lives in tests/scene3d_probe.js.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../core/registry.js";
import { allPlugins } from "../plugins/index.js";
import {
  MAX_PITCH, cameraRows, isFixedRaster, resolutionRows, scene3dIsEmpty, scene3dLook,
  scene3dPlugins, scene3dPose, scene3dRasterSize, scene3dWrites,
} from "../plugins/demo/scene3d.js";
import { prepareScene3dViews, scene3dViewDescriptor } from "../render_gpu/scene3d_display.js";
import {
  SCENE3D_RASTER_DENSITY, digest32, ensureScene3dRasterized, orbitEye, orbitUp,
  roundScene3dScale, scene3dAvailable, scene3dDrawRef, scene3dHoldKey,
  scene3dRasterStats, scene3dRef,
} from "../render_gpu/gpu/scene3d_raster.js";
import { sceneIR } from "../render_gpu/ports.js";
import { cameraFrameIR } from "../web/cameraFrame.js";
import { NAVIGATE_SCENE_HANDLER, dollyedPose, fovedPose, orbitedPose } from "../web/sceneNav.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const [splat, model] = scene3dPlugins;
/** A pose with every component distinct and non-zero, so a transposition bug in
 *  any of the eight write keys shows up as a wrong number rather than a match. */
const POSE = { targetX: 1, targetY: 2, targetZ: 3, yaw: 0.4, pitch: 0.5, roll: 0.6, distance: 7, fov: 0.8 };
/** The spec shape ensureScene3dRasterized takes, filled in so a test can vary
 *  exactly one field and attribute the ref change to it. */
const SPEC = { kind: "splat", src: "scene.ply", pose: POSE, look: "exposure=1", w: 512, h: 384, near: 0.07, far: 700 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── 1. THE FAMILY ────────────────────────────────────────────────────────────

test("the family is two members from one factory, with distinct namespaced types", () => {
  assert.deepEqual(scene3dPlugins.map((p) => p.type), ["scene3d_splat", "scene3d_model"]);
  assert.equal(splat.title, "Gaussian Splat");
  assert.equal(model.title, "3D Model");
  // Both must actually register — registry.register throws on a duplicate type,
  // which is the whole reason the ids carry the family prefix.
  const registry = createRegistry();
  for (const p of allPlugins) registry.register(p);
  assert.equal(registry.get("scene3d_splat").type, "scene3d_splat");
  assert.equal(registry.get("scene3d_model").type, "scene3d_model");
});

test("both members declare the fly-mode activation AND the descriptor that goes with it", () => {
  for (const p of scene3dPlugins) {
    assert.equal(p.activate, "navigate_scene");
    assert.equal(typeof p.sceneCamera.pose, "function");
    assert.equal(typeof p.sceneCamera.writes, "function");
    // The asset picker moved to the CREATE phase, which is what frees the
    // double-click for flying — a widget names exactly one activate handler.
    assert.equal(p.placement, "bbox_then_asset");
    assert.equal(p.primaryAsset, "src");
  }
});

// ── 2 + 3. THE CAMERA IS PROPERTY STATE ──────────────────────────────────────

test("EVERY camera write key is a real leaf of the widget's own defaults", () => {
  for (const p of scene3dPlugins) {
    const writes = p.sceneCamera.writes(p.defaults, p.sceneCamera.pose(p.defaults));
    for (const key of Object.keys(writes))
      assert.ok(key in p.defaults, `${p.type}: write key "${key}" is not a declared default — it would keyframe a property nothing reads`);
  }
});

test("every camera key also has an Inspector row, so a flown camera is editable by hand", () => {
  const rowKeys = new Set(cameraRows().map((r) => r.key));
  for (const key of Object.keys(scene3dWrites({}, POSE)))
    assert.ok(rowKeys.has(key), `camera key "${key}" has no Inspector row`);
});

test("pose → writes ROUND-TRIPS: entering fly mode and letting go moves nothing", () => {
  const state = { ...splat.defaults };
  const back = scene3dWrites(state, scene3dPose(state));
  for (const [key, value] of Object.entries(back))
    assert.ok(near(value, state[key]), `${key}: ${value} !== ${state[key]}`);
});

test("pitch is clamped by the STORE, not by the gesture (so an = equation is clamped too)", () => {
  assert.ok(near(scene3dWrites({}, { ...POSE, pitch: 3 }).camPitch, MAX_PITCH));
  assert.ok(near(scene3dWrites({}, { ...POSE, pitch: -3 }).camPitch, -MAX_PITCH));
  assert.equal(scene3dWrites({}, { ...POSE, distance: -5 }).camDistance, 0);
});

test("angle rows store RADIANS and only DISPLAY degrees (the shapeshifter trap)", () => {
  for (const row of cameraRows().filter((r) => r.kind === "angle"))
    assert.equal(row.display, "degrees", `${row.key} must declare display:"degrees", never unit:`);
  // 30 degrees, stored: the default yaw is a radian quantity, not 30.
  assert.ok(near(splat.defaults.camYaw, Math.PI / 6));
  assert.ok(splat.defaults.camFov < Math.PI, "a field of view stored in degrees would be > pi");
});

// ── 4. THE REF IS THE CACHE ──────────────────────────────────────────────────

test("the same inputs give the same ref — which is the entire R6-1.7 cache claim", () => {
  assert.equal(scene3dRef(SPEC), scene3dRef({ ...SPEC, pose: { ...POSE } }));
  assert.ok(scene3dRef(SPEC).startsWith("scene3d:splat:"));
});

test("every input that changes the picture changes the ref", () => {
  const base = scene3dRef(SPEC);
  const differs = (label, patch) =>
    assert.notEqual(scene3dRef({ ...SPEC, ...patch }), base, `${label} did not change the ref — two different pictures would share one cache slot`);
  differs("source", { src: "other.ply" });
  differs("member kind", { kind: "model" });
  differs("look", { look: "exposure=2" });
  differs("width", { w: 513 });
  differs("height", { h: 385 });
  for (const key of Object.keys(POSE)) differs(`pose.${key}`, { pose: { ...POSE, [key]: POSE[key] + 1 } });
});

test("float noise below the pose resolution does NOT mint a second ref", () => {
  // What a preview → commit → re-read round trip does to a number. A ref that
  // changed here would re-render the scene on every idle frame.
  assert.equal(scene3dRef({ ...SPEC, pose: { ...POSE, yaw: POSE.yaw + 1e-12 } }), scene3dRef(SPEC));
});

test("a ref never embeds its source, however large that source is", () => {
  const huge = `data:model/ply;base64,${"A".repeat(100000)}`;
  assert.ok(scene3dRef({ ...SPEC, src: huge }).length < 80);
  assert.equal(digest32("").length, 8);
  assert.notEqual(digest32("a"), digest32("b"));
});

test("the look digest names every non-pose, non-size property that changes pixels", () => {
  assert.notEqual(scene3dLook({ exposure: 1 }), scene3dLook({ exposure: 2 }));
  assert.notEqual(scene3dLook({ background: "#000" }), scene3dLook({ background: "transparent" }));
});

// ── 5. THE RESOLUTION CONTRACT ───────────────────────────────────────────────

test("Follow-widget-size scales the raster with the node's own world scale", () => {
  const s = { w: 200, h: 100 };
  assert.deepEqual(scene3dRasterSize(s, 1), { w: 200 * SCENE3D_RASTER_DENSITY, h: 100 * SCENE3D_RASTER_DENSITY });
  assert.deepEqual(scene3dRasterSize(s, 2), { w: 400 * SCENE3D_RASTER_DENSITY, h: 200 * SCENE3D_RASTER_DENSITY });
});

test("Fixed renders at the chosen size WHATEVER the widget's scale — R6-1.8 verbatim", () => {
  const s = { w: 200, h: 100, renderMode: "raster", rasterWidth: 720, rasterHeight: 840, rasterDPI: 96 };
  assert.deepEqual(scene3dRasterSize(s, 1), { w: 720, h: 840 });
  assert.deepEqual(scene3dRasterSize(s, 8), { w: 720, h: 840 }, "Fixed must ignore the widget's scale entirely");
  assert.deepEqual(scene3dRasterSize(s, 0.1), { w: 720, h: 840 });
});

test("a raster scale quantizes, so a resize drag reuses one raster across small changes", () => {
  assert.equal(roundScene3dScale(2.04), 2);
  assert.equal(roundScene3dScale(2.06), 2.1);
  assert.equal(roundScene3dScale(0), 0.1, "a degenerate scale must not produce a zero-size surface");
  assert.deepEqual(scene3dRasterSize({ w: 200, h: 100 }, 1.01), scene3dRasterSize({ w: 200, h: 100 }, 1.02));
});

test("the resolution rows are spelled the way pdf_page spells the identical control", () => {
  const [mode] = resolutionRows();
  assert.equal(mode.key, "renderMode");
  // "viewport" is ours and FIRST because it is the default; the other two keep
  // pdf_page's spelling exactly, because two widgets with the same control must
  // not grow two names for it.
  assert.deepEqual(mode.options, ["viewport", "live", "raster"]);
  const src = readFileSync(join(here, "..", "plugins", "pdf_page.js"), "utf8");
  for (const key of ["rasterWidth", "rasterHeight", "rasterDPI"])
    assert.ok(src.includes(`key: "${key}"`), `pdf_page no longer declares "${key}" — the shared vocabulary drifted`);
  assert.deepEqual(Object.keys(mode.optionLabels).sort(), [...mode.options].sort(),
    "every mode must have a label — an unlabelled option shows its raw id in the select");
});

// ── 5b. THE MODE SELECTOR AND THE VIEWPORT PRE-PASS (todo #257) ──────────────

test("the Fixed rows exist ONLY in Fixed mode — a mode selector hides, never disables", () => {
  // The user's own words: "fixed height and fixed width should NOT be available
  // options when we have that." Asserted through the SAME predicate the sizing
  // branch reads, so a row cannot come to disagree with the render about what
  // Fixed means.
  const fixedRows = resolutionRows().filter((r) => r.key.startsWith("raster"));
  assert.equal(fixedRows.length, 3, "Fixed width, Fixed height, Fixed density");
  for (const row of fixedRows) {
    assert.equal(typeof row.visibleWhen, "function", `${row.key} must declare visibleWhen`);
    assert.equal(row.visibleWhen({ renderMode: "raster" }), true, `${row.key} belongs to Fixed`);
    for (const mode of ["viewport", "live"])
      assert.equal(row.visibleWhen({ renderMode: mode }), false, `${row.key} must be HIDDEN in ${mode}`);
    assert.equal(row.visibleWhen({}), false, "…and hidden by DEFAULT, which is no longer Fixed");
  }
  assert.equal(isFixedRaster({ renderMode: "raster" }), true);
  assert.equal(isFixedRaster({}), false);
});

test("the pre-pass selects by DECLARATION, so a third family member cannot be forgotten", () => {
  for (const p of scene3dPlugins)
    assert.equal(p.viewportRaster, true, `${p.type} must opt into the viewport pre-pass`);
  // And the flag genuinely gates it: an identical node whose plugin lacks the
  // declaration gets no descriptor. Without this half the check above would pass
  // on a pre-pass that simply sized every node in the scene.
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  const state = { w: 100, h: 100, renderMode: "viewport" };
  assert.equal(prepareScene3dViews([{ itemId: "a", state, world, plugin: {} }], view, 400, 400).size, 0);
  assert.equal(prepareScene3dViews([{ itemId: "a", state, world, plugin: { viewportRaster: true } }], view, 400, 400).size, 1);
  // …and only in the mode it serves. The other two keep the sizing they had.
  for (const mode of ["live", "raster"])
    assert.equal(prepareScene3dViews(
      [{ itemId: "a", state: { ...state, renderMode: mode }, world, plugin: { viewportRaster: true } }], view, 400, 400,
    ).size, 0, `${mode} must take no descriptor`);
});

test("THE BOUND THAT IS THE WHOLE POINT: the raster follows the SCREEN, not the zoom", () => {
  const node = { itemId: "a", state: { w: 100, h: 100 }, world: { x: 0, y: 0, rotation: 0, scale: 1 } };
  const at = (zoom) => scene3dViewDescriptor(node, { zoom, panX: 0, panY: 0, dpr: 1 }, 400, 400);
  // At zoom 1 the whole widget fits and the raster is its on-screen size at the
  // app-wide 2x supersample — the SAME density "Follow widget size" uses, so
  // switching modes at rest cannot make a scene softer.
  assert.deepEqual([at(1).deviceW, at(1).deviceH], [200, 200]);
  // Zoomed 8x, 32x, 128x the widget is far bigger than the canvas, so the raster
  // is the CANVAS — constant. A whole-object raster would have wanted 64x, 1024x
  // and 16384x the pixels of the zoom-1 one, which is the defect being fixed.
  for (const zoom of [8, 32, 128]) {
    const d = at(zoom);
    assert.deepEqual([d.deviceW, d.deviceH], [800, 800], `zoom ${zoom} must still raster one canvas-worth (at 2x density)`);
    // …and the DETAIL is real, not magnification: the same 400x400 surface now
    // covers a smaller and smaller LOCAL window, which is more device px per
    // local unit every time. That is "I can never see the pixels".
    assert.ok(near(d.w, 400 / zoom), `zoom ${zoom}: the window is the canvas back-projected — expected ${400 / zoom} local units, got ${d.w}`);
    // …and the DETAIL is real rather than magnification: the same 400x400 surface
    // now covers 400/zoom local units, so the VIRTUAL image it is a window into
    // grows with the zoom. That number is projection arithmetic, never an
    // allocation, which is why it is allowed to be enormous.
    assert.ok(near(d.viewOffset.fullW, 100 * zoom * 2), `the virtual image must be the whole box at raster scale (got ${d.viewOffset.fullW})`);
  }
});

test("the sub-frustum's window is placed where the widget actually is", () => {
  // Pan the camera so only the widget's RIGHT half is on screen: the offset must
  // move to the middle of the virtual image, not stay at the origin. An offset
  // stuck at 0 would draw the left half everywhere and read as a shifted scene
  // rather than as a bug — which is exactly why this is asserted separately from
  // the size.
  const node = { itemId: "a", state: { w: 100, h: 100 }, world: { x: 0, y: 0, rotation: 0, scale: 1 } };
  const whole = scene3dViewDescriptor(node, { zoom: 1, panX: 0, panY: 0, dpr: 1 }, 400, 400);
  assert.deepEqual([whole.viewOffset.x, whole.viewOffset.y], [0, 0]);
  const right = scene3dViewDescriptor(node, { zoom: 1, panX: -50, panY: 0, dpr: 1 }, 40, 400);
  assert.ok(right.viewOffset.x > 0, `a panned-off left edge must offset the frustum (got ${right.viewOffset.x})`);
  assert.ok(near(right.viewOffset.x, right.x * 2), "the offset is the window's local origin at the raster scale");
  assert.equal(scene3dViewDescriptor(node, { zoom: 1, panX: -9000, panY: 0, dpr: 1 }, 400, 400), null,
    "a widget entirely off screen takes no descriptor at all");
});

test("a viewport-cropped emit draws the WINDOW at the window, and an uncropped one draws the box", () => {
  const state = { ...splat.defaults, src: "scene.ply" };
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const win = { x: 10, y: 20, w: 30, h: 40, deviceW: 60, deviceH: 80, viewOffset: { fullW: 200, fullH: 200, x: 20, y: 40 } };
  const [cropped] = splat.emit(state, null, world, { scene3d: win, live: false }).filter((o) => o.op === "image");
  assert.deepEqual([cropped.x, cropped.y, cropped.w, cropped.h], [10, 20, 30, 40],
    "the raster IS the window, so it is drawn at the window's rect");
  assert.equal(cropped.sw, undefined, "…and carries its whole self: no source sub-rect");
  // No descriptor ⇒ the camera-free path, unchanged. This is the assertion that
  // keeps every export, thumbnail and CLI frame byte-identical to before #257.
  const [whole] = splat.emit(state, null, world).filter((o) => o.op === "image");
  assert.deepEqual([whole.x, whole.y, whole.w, whole.h], [0, 0, state.w, state.h]);
  assert.notEqual(cropped.ref, whole.ref, "two different pictures may never share one cache slot");
});

// ── 6. THE POSE MATH ─────────────────────────────────────────────────────────

test("the eye really is `distance` from the target, in every direction", () => {
  for (const yaw of [0, 0.7, 2.5, -1.9]) {
    for (const pitch of [0, 0.4, -1.2, MAX_PITCH]) {
      const pose = { ...POSE, yaw, pitch };
      const e = orbitEye(pose);
      const d = Math.hypot(e.x - pose.targetX, e.y - pose.targetY, e.z - pose.targetZ);
      assert.ok(near(d, pose.distance, 1e-12), `yaw ${yaw} pitch ${pitch}: |eye-target| = ${d}, want ${pose.distance}`);
    }
  }
  // The zero pose is three.js's own default orientation: on +Z, looking at -Z.
  assert.deepEqual(orbitEye({ targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 3 }), { x: 0, y: 0, z: 3 });
});

test("the up vector is unit and perpendicular to the view direction, at every roll", () => {
  for (const roll of [0, 0.9, -2.2, Math.PI]) {
    const pose = { ...POSE, roll };
    const up = orbitUp(pose);
    const e = orbitEye(pose);
    const view = { x: pose.targetX - e.x, y: pose.targetY - e.y, z: pose.targetZ - e.z };
    assert.ok(near(Math.hypot(up.x, up.y, up.z), 1, 1e-12), `roll ${roll}: up is not unit`);
    const dot = (up.x * view.x + up.y * view.y + up.z * view.z) / pose.distance;
    assert.ok(near(dot, 0, 1e-12), `roll ${roll}: up is not perpendicular to the view (dot ${dot})`);
  }
});

test("roll actually rolls: zero is world-up, a quarter turn is sideways", () => {
  const level = { targetX: 0, targetY: 0, targetZ: 0, yaw: 0, pitch: 0, distance: 1, roll: 0 };
  const flat = orbitUp(level);
  assert.ok(near(flat.x, 0, 1e-12) && near(flat.y, 1, 1e-12) && near(flat.z, 0, 1e-12));
  const canted = orbitUp({ ...level, roll: Math.PI / 2 });
  assert.ok(near(canted.x, -1, 1e-12) && near(canted.y, 0, 1e-12));
});

// ── 7. THE GESTURES ──────────────────────────────────────────────────────────

test("orbit is linear in the drag and touches nothing but yaw and pitch", () => {
  const once = orbitedPose(POSE, 50, 20, 400);
  const twice = orbitedPose(once, 50, 20, 400);
  const straight = orbitedPose(POSE, 100, 40, 400);
  assert.ok(near(twice.yaw, straight.yaw) && near(twice.pitch, straight.pitch), "two half-drags must equal one whole one");
  for (const key of ["targetX", "targetY", "targetZ", "roll", "distance", "fov"])
    assert.equal(once[key], POSE[key], `orbit moved ${key}`);
  // A drag across the whole box width is half a turn, and dragging RIGHT turns
  // the subject to follow the hand (so the camera goes the other way).
  assert.ok(near(orbitedPose(POSE, 400, 0, 400).yaw, POSE.yaw - Math.PI));
});

test("dolly and field of view are the canvas's own exponential law, and FOV is clamped", () => {
  assert.ok(near(dollyedPose(POSE, 2).distance, POSE.distance / 2));
  assert.ok(near(dollyedPose(POSE, 0.5).distance, POSE.distance * 2));
  assert.ok(near(fovedPose(POSE, 2).fov, POSE.fov / 2));
  assert.ok(fovedPose(POSE, 1e6).fov >= 5 * (Math.PI / 180) - 1e-12, "FOV must not collapse below the lens range");
  assert.ok(fovedPose(POSE, 1e-6).fov <= 150 * (Math.PI / 180) + 1e-12, "FOV must not open past the lens range");
});

test("the mode advertises exactly the gestures it implements, and no more", () => {
  const mode = NAVIGATE_SCENE_HANDLER.mode;
  assert.deepEqual(mode.hints.map((h) => h.label), ["Look around", "Move closer / further", "Field of view"]);
  // THE POINT OF THIS ASSERTION: web/CanvasView.svelte's onPan payload is
  // {dLocalX, dLocalY} and carries no modifier keys, so a Shift+drag truck hint
  // would name a gesture nothing can deliver — the HintBar lie the shortcut
  // registry exists to prevent. When that payload gains a modifier, this list
  // grows and so does the mode; until then neither may.
  assert.ok(!mode.hints.some((h) => h.keys.includes("Shift")), "no Shift gesture is deliverable to a mode today");
  assert.equal(typeof mode.onPan, "function");
  assert.equal(typeof mode.onWheel, "function");
  assert.equal(mode.onPick, undefined, "a pick would outrank onPan and kill the look drag");
});

// ── 8. BARE NODE REFUSES LOUDLY AND STILL EMITS ──────────────────────────────

test("an empty viewport draws a message, not a blank box, and is a ghost", () => {
  assert.ok(scene3dIsEmpty({}));
  assert.ok(scene3dIsEmpty({ src: "   " }));
  assert.ok(!scene3dIsEmpty({ src: "a.ply" }));
  for (const p of scene3dPlugins) {
    assert.ok(p.isGhost(p.defaults), `${p.type}: a sourceless viewport must be a ghost`);
    const ops = p.emit({ ...p.defaults }, null, { scale: 1 });
    assert.deepEqual(ops.map((o) => o.op), ["rect", "text"]);
    assert.ok(ops[1].text.length > 0, "the affordance must say something");
  }
});

test("a sourced viewport emits exactly ONE image op — the seam that makes the CLI count it", () => {
  const state = { ...splat.defaults, src: "scene.ply" };
  const ops = splat.emit(state, null, { scale: 1 });
  const images = ops.filter((o) => o.op === "image");
  assert.equal(images.length, 1, "a 3D viewport that emitted no media op would exit the CLI 0 with a silent hole");
  assert.equal(images[0].ref, scene3dRef({
    kind: "splat", src: "scene.ply", pose: scene3dPose(state), look: scene3dLook(state),
    w: scene3dRasterSize(state, 1).w, h: scene3dRasterSize(state, 1).h,
  }), "emit must draw the ref the raster module would produce, or the cache never hits");
});

test("bare node reports that it cannot render rather than letting three.js throw", () => {
  assert.equal(scene3dAvailable(), false, "this suite must run with no DOM");
  const before = scene3dRasterStats();
  const ref = ensureScene3dRasterized(SPEC);
  assert.equal(ref, scene3dRef(SPEC), "the ref is still produced, so the image op still counts as omitted media");
  assert.equal(scene3dRasterStats().renders, before.renders, "nothing may be scheduled with no context");
});

// ── 8b. THE STALE-FRAME HOLD (todo #255) ─────────────────────────────────────
// The pixel half is tests/scene3d_stale_frame_probe.js — flicker cannot be shown
// in a still, so the gate that matters is a screenshot burst mid-gesture. What
// belongs HERE is the part that needs no GPU: the hold's IDENTITY rule, and the
// live/one-shot switch that keeps a stale frame out of an export.

test("a hold key names the SUBJECT, never the view — that is what makes it survive a pose change", () => {
  const key = scene3dHoldKey("splat", "room.ply");
  assert.equal(key, scene3dHoldKey("splat", "room.ply"), "the key must be a pure function of its inputs");
  // Every quantity a live gesture sweeps must be ABSENT from the key, or the hold
  // misses on exactly the frames it exists to cover.
  for (const swept of ["0.4", "512", "384", "exposure"])
    assert.ok(!key.includes(swept), `a hold key must not mention ${swept}`);
  // …and the two things that would make a stale frame a LIE must both be in it.
  assert.notEqual(scene3dHoldKey("splat", "a.ply"), scene3dHoldKey("splat", "b.ply"),
    "a stale frame must never outlive its source — two sources, two keys");
  assert.notEqual(scene3dHoldKey("splat", "x"), scene3dHoldKey("model", "x"),
    "the two members read the same bytes through different loaders");
});

test("with no engine there is no hold, so the true ref is drawn whatever the caller asks for", () => {
  assert.equal(scene3dAvailable(), false, "this suite must run with no DOM");
  // cli/render.js's lane. A hold can only ever name a raster this process
  // produced, and this process produces none — so `hold` must be inert here
  // rather than reaching for something that cannot exist.
  assert.equal(scene3dDrawRef(SPEC, { hold: true }).ref, scene3dRef(SPEC));
  assert.equal(scene3dDrawRef(SPEC).ref, scene3dRef(SPEC), "hold defaults to OFF — the safe answer for an unknown caller");
  // AND THE PLACE COMES BACK UNCHANGED when the true ref is used, which is what
  // makes the return value safe to draw at unconditionally. A hold that could
  // silently null a caller's own placement would move every widget it touched.
  const placed = { x: 3, y: 4, w: 5, h: 6, source: null };
  assert.deepEqual(scene3dDrawRef({ ...SPEC, place: placed }, { hold: true }).place, placed);
});

test("sceneIR's `live` reaches emit(), and its ABSENCE is byte-identical to before it existed", () => {
  // The flag is a property of the SURFACE, so the plugin can only learn it from
  // the walker. A capture plugin is the honest way to assert that: it records the
  // 4th argument it was handed instead of trusting the walker's source text.
  const seen = [];
  const node = {
    itemId: "i1", type: "probe", state: { type: "probe" }, world: { x: 0, y: 0, rotation: 0, scale: 1 },
    plugin: { type: "probe", emit: (_s, _sub, _w, ctx) => { seen.push(ctx); return [{ op: "rect", x: 0, y: 0, w: 1, h: 1 }]; } },
  };
  sceneIR([node], { live: true });
  assert.equal(seen[0]?.live, true, "a live surface must be able to tell a widget so");
  sceneIR([node]);
  assert.equal(seen[1], null, "no pre-pass and no live flag ⇒ NO render context at all, exactly as before");
  sceneIR([node], { live: false });
  assert.equal(seen[2], null, "an explicit live:false is the same nothing — an exporter changes no behaviour by being explicit");
});

test("cameraFrameIR does NOT infer `live` from the view — the presenter would freeze a wrong pose", () => {
  // THE DEFECT THIS PINS, caught before it shipped. `view` and `live` are
  // different questions: a view says "I know where the camera is", `live` says "I
  // WILL REPAINT when an async raster lands". web/PresentMode.svelte passes a view
  // and repaints on navigation, tweens and animated widgets — never on image load.
  // Inferring `live` from `view` handed it the stale-frame hold, so a presented
  // slide could sit indefinitely showing a scene at the WRONG POSE: worse than a
  // hole, because it looks right. A capture plugin is what makes this assertable
  // without a browser — it records the 4th argument it was handed.
  const seen = [];
  const registry = createRegistry();
  registry.register({
    type: "live_probe",
    ephemeral: "none", // a test fixture draws vector ops only
    title: "Live probe",
    capabilities: { bbox: true },
    defaults: { type: "live_probe", x: 0, y: 0, w: 10, h: 10, z: 0, rotation: 0, scale: 1 },
    inspector: [],
    emit: (_s, _sub, _w, ctx) => { seen.push(ctx); return [{ op: "rect", x: 0, y: 0, w: 1, h: 1 }]; },
  });
  const state = { items: { i1: { ...registry.get("live_probe").defaults } }, vars: {} };
  const meta = { slideW: 400, slideH: 300 };
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  cameraFrameIR(state, meta, registry, { view, viewW: 400, viewH: 300 });
  assert.notEqual(seen[0]?.live, true, "a VIEW alone must never turn the hold on");
  cameraFrameIR(state, meta, registry, { view, viewW: 400, viewH: 300, live: true });
  assert.equal(seen[1]?.live, true, "…and an explicit opt-in must still reach the widget");
});

// ── 9. THE ENGINE STAYS CONFINED ─────────────────────────────────────────────

test("three.js is imported LAZILY and in exactly one file", () => {
  const roots = ["core", "plugins", "plugins/demo", "web", "render_gpu", "render_gpu/gpu", "render_gpu/skia", "cli"];
  const offenders = [];
  for (const rel of roots) {
    for (const name of readdirSync(join(here, "..", rel), { withFileTypes: true })) {
      if (!name.isFile() || !/\.(js|svelte)$/.test(name.name)) continue;
      const path = join(rel, name.name);
      const src = readFileSync(join(here, "..", path), "utf8");
      // A STATIC import of the engine anywhere pulls ~1.9 MB into the main bundle
      // for every user, 3D widget or not, and breaks the bare-node lane this very
      // file runs in. A dynamic import() is the legal form, and only here.
      if (/^\s*import[^\n]*from\s+["'](three|@sparkjsdev\/spark)["']/m.test(src)) offenders.push(path);
    }
  }
  assert.deepEqual(offenders, [], "three.js / spark must be reached only through the dynamic import in render_gpu/gpu/scene3d_raster.js");
  const raster = readFileSync(join(here, "..", "render_gpu", "gpu", "scene3d_raster.js"), "utf8");
  assert.ok(raster.includes('import("three")') && raster.includes('import("@sparkjsdev/spark")'));
});

console.log(`\n${passed} scene3d tests passed`);

// ── #270: THE TWO REMAINING COMPLAINTS, ATTACKED AT THEIR MECHANISMS ────────

test("THE SORT IS GATED ON A REAL POSE CHANGE — the latency lever", () => {
  // `await spark.update()` is THE cost of this widget: ~2.0-2.2s per call and
  // RESOLUTION-INDEPENDENT, because it is the splat SORT, not the draw (the render
  // is 0-1ms even at 1080p). It ran on every raster. In viewport mode the surface
  // and view offset change on every canvas pan/zoom, so a pan re-paid two seconds
  // for a sort that was still correct — setViewOffset SHEARS the projection and
  // does not move the camera, and the sort depends only on the camera and the
  // object. The skip is keyed on exactly those.
  const src = readFileSync(join(here, "..", "render_gpu", "gpu", "scene3d_raster.js"), "utf8");
  assert.match(src, /lastSortKey/, "the module remembers what it is sorted for");
  assert.match(src, /if \(sortKey !== lastSortKey\) \{[\s\S]{0,120}spark3d\.update/,
    "update() runs only when that key changed");
  // The key must NOT contain the surface size or the view offset — including
  // either would defeat the whole point, because those are what a canvas pan
  // changes.
  const key = src.match(/const sortKey = [^;]+;/)[0];
  for (const f of ["size.w", "size.h", "viewOffset", "spec.w", "spec.h"])
    assert.ok(!key.includes(f), `the sort key must not include ${f} — a pan would re-sort for nothing`);
  for (const needed of ["spec.pose", "spec.src", "spec.kind"])
    assert.ok(key.includes(needed), `the sort key must include ${needed}`);
});

test("the sort cache is CLEARED with the raster cache, so a fresh engine sorts once", () => {
  const src = readFileSync(join(here, "..", "render_gpu", "gpu", "scene3d_raster.js"), "utf8");
  const reset = src.slice(src.indexOf("export function resetScene3dRaster"));
  assert.match(reset.slice(0, 400), /lastSortKey = null/,
    "a stale key after a reset would skip the ONE update a new scene genuinely needs");
});

test("THE SURFACE CEILING IS THE DEVICE'S, not a constant — the crash class", () => {
  // Asking a GPU for a surface larger than it can allocate loses the WebGL
  // context, which presents as the viewer "crashing" rather than as a readable
  // error. render_gpu/skia/browser_surface.js already queries the real
  // MAX_TEXTURE_SIZE and states the rule ("a limit is a property of the
  // INSTANCE"); this path used a hardcoded 8192 and never asked.
  const src = readFileSync(join(here, "..", "render_gpu", "gpu", "scene3d_raster.js"), "utf8");
  assert.match(src, /renderer\?\.capabilities\?\.maxTextureSize/, "it asks the context for its own limit");
  assert.match(src, /Math\.min\(SCENE3D_MAX_RASTER_DIM, deviceMax\)/,
    "and takes the SMALLER — policy may be stricter than hardware, never laxer");
  assert.match(src, /\|\| SCENE3D_MAX_RASTER_DIM/,
    "a capabilities object reporting 0 falls back rather than clamping everything to nothing");
});
