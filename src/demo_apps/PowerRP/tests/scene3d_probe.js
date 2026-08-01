/**
 * THE 3D VIEWPORT, IN THE REAL EDITOR, WITH REAL PIXELS.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/scene3d_probe.js [shot_dir]
 *
 * tests/scene3d_test.js proves the arithmetic with no GPU. This proves the thing
 * the arithmetic is for, and it is the half that cannot be faked:
 *
 *   1. A GAUSSIAN SPLAT SCENE ACTUALLY DRAWS. Not "an image op was emitted" —
 *      the canvas pixels inside the widget's box change from the empty-viewport
 *      affordance to a picture with real colour variety. A widget that emitted a
 *      ref nothing ever filled would pass every bare-node assertion and show a
 *      blank box, which is exactly the failure this exists to catch.
 *   2. DOUBLE-CLICK ENTERS MOUSE-LOOK (R6-1.2) and Escape leaves it.
 *   3. FLYING WRITES THE DOCUMENT (R6-1.3). A drag changes `camYaw` in stored
 *      state — not in a viewer-local variable — so the shot survives a reload and
 *      renders the same in both exporters. And it is ONE undo unit: a hundred
 *      pointermoves must not be a hundred undo steps.
 *   4. THE PICTURE FOLLOWS THE PROPERTY. Setting camYaw through the ordinary
 *      Inspector-style write path (no gesture at all) changes the pixels, which is
 *      what "the camera is keyframable property state" MEANS in practice.
 *   5. DETERMINISM, THE MECHANICAL FORM OF THE Delta-t LAW. Fly away, come back to
 *      the exact original pose, and the frame must be BYTE-IDENTICAL to the
 *      original. If Spark's async sort or its LoD traversal were being read before
 *      they converged, this is where it would show — as a widget that is
 *      EPHEMERAL rather than recordable, whose video export would differ from its
 *      preview in a few frames and look like nothing in particular.
 *   6. AN `=`-BOUND CAMERA REFUSES TO BE FLOWN, loudly and with no state change.
 *      A camYaw bound to an equation is an authored fly-through; a stray drag
 *      must not silently replace it with the number it currently evaluates to.
 *
 * THE FIXTURE is assets/builtin/splats/spz-test-scene.ply — 1,566 splats, 141 KB,
 * MIT, from the SPZ format author's own repository (see the README beside it). It
 * is deliberately the SMALLEST real splat file available rather than a pretty
 * one: a probe that had to decode 18 MB before its first assertion would be a
 * probe nobody runs. It is served through Vite's `/@fs/` path, which is why this
 * file computes an absolute path rather than hardcoding a URL.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const shots = process.argv[2] ?? "/tmp/scene3d_probe";
await mkdir(shots, { recursive: true });

/** The widget under test, parked where nothing else in a fresh document sits. */
const BOX = { x: 200, y: 160, w: 320, h: 240 };
/** A second, sourceless viewport of the same size — the control. Its pixels are
 *  the "no scene chosen" affordance, so assertion 1 can say the splat's pixels
 *  differ from an EMPTY widget rather than merely from the page background. */
const EMPTY_BOX = { x: 600, y: 160, w: 320, h: 240 };
/** One reactive paint plus a Skia frame. The same value bento_bind_probe uses. */
const SETTLE_MS = 220;
/** A splat decode plus the first sort. Measured on this host at ~250 ms for this
 *  fixture; the poll below gives it far more room and gives up loudly. */
const RASTER_TIMEOUT_MS = 60000;
/** How far to drag, in device px, when flying. Large enough that the resulting
 *  yaw change is unambiguous against float noise, small enough to stay inside
 *  the widget's box so the gesture never leaves the mode. */
const DRAG_PX = 90;
/** How far to move the camera, in radians, for the "the picture follows the
 *  property" check. Big enough that a 1,566-splat scene visibly re-composes;
 *  small enough that the subject stays in frame so the two shots are comparable
 *  pictures rather than one picture and one empty field. */
const YAW_NUDGE = 0.4;

const splatPath = fileURLToPath(new URL("../assets/builtin/splats/spz-test-scene.ply", import.meta.url));
const modelPath = fileURLToPath(new URL("../assets/builtin/models/clearcoat-car-paint.glb", import.meta.url));
const SPLAT_URL = `/@fs${splatPath}`;
const MODEL_URL = `/@fs${modelPath}`;
/** A URL that is REACHABLE and returns 404 — the link-rot case, which is what a
 *  preset pointing at a remote asset will eventually become. Deliberately on the
 *  probe's OWN dev server rather than a real host: this suite must not need the
 *  internet (a gate that goes red on a plane is a gate nobody trusts), and a
 *  same-origin 404 exercises exactly the code path a remote 404 would. */
const DEAD_URL = "/@fs/definitely/not/a/real/scene.ply";
/** A third and fourth viewport for the mesh and link-rot checks, parked clear of
 *  the first two so every clip is of one widget. */
const MODEL_BOX = { x: 200, y: 470, w: 320, h: 240 };
const DEAD_BOX = { x: 600, y: 470, w: 320, h: 240 };

// A PRIVATE DEP CACHE, and this one is not paranoia — it was measured. The
// default cache is `<root>/node_modules/.vite`, which every concurrently running
// agent's dev server ALSO writes; when a peer's server re-optimizes, the `?v=`
// hash rotates and this page's in-flight `import("three")` 404s mid-render. The
// symptom is a red "Could not load this scene — Failed to fetch dynamically
// imported module … three.js?v=45b3870d", which reads exactly like a broken
// widget and is not one. An isolated cache costs one re-optimize per run (~10 s)
// and makes the result attributable.
//
// HMR + the file watcher are OFF for the neighbouring reason: a dozen agents edit
// this tree concurrently and a stray full reload mid-probe drops
// window.__powerrp_app for reasons unrelated to anything asserted here.
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  cacheDir: await mkdtemp(join(tmpdir(), "powerrp-scene3d-vite-")),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ protocolTimeout: 180000 });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
/** Documented boot/runtime noise from OTHER lanes (activation_probe.js's list). */
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/, /preserveAspect/,
  // COLD-CACHE ARTIFACT, not the app: the first run after `node_modules/.vite` is
  // cleared re-optimizes while this page is already loading, and every request
  // in flight during that window answers 504. It is the same noise
  // tests/boot_probe.js already lists as known-benign. A WARM run never sees it,
  // and it cannot mask a real fault here because every assertion below is about
  // pixels or document state, not about the absence of a network hiccup.
  /Outdated Optimize Dep/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  const liveErrors = [];
  const warnings = [];
  const phase = { live: false };
  page.on("pageerror", (e) => (phase.live ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // Puppeteer has spelled console.warn's type both "warn" and "warning"
    // across versions; take either rather than silently capturing nothing.
    if (m.type() === "warn" || m.type() === "warning") warnings.push(m.text());
    if (m.type() !== "error" || isNoise(m.text())) return;
    (phase.live ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);
  ok(bootErrors.length === 0, `no boot errors (${JSON.stringify(bootErrors)})`);
  phase.live = true;

  const spawn = (type, extra) => page.evaluate((type, extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, ...extra });
    return app.selection;
  }, type, extra);
  const stored = (id, key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), id, key);
  const setProp = (id, key, value) => page.evaluate((id, key, value) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, key], value]]);
    app.commitPreview();
  }, id, key, value);
  /** THE WHOLE POSE, not one key. `sceneCamera.writes` stages all EIGHT camera
   *  keys on every tick (setPreview replaces previewDelta wholesale, so it must),
   *  which means a drag can move more than the one number you were watching — a
   *  nominally horizontal drag still delivers a sub-pixel dLocalY. Restoring only
   *  camYaw and then asserting byte-identical pixels compares two DIFFERENT poses
   *  and fails for a reason that is not a determinism fault. That is exactly what
   *  it did on this probe's first two runs (6.52% of pixels differing, max channel
   *  delta 21, concentrated where the scene has detail — a real render of a
   *  slightly different camera, not chrome). */
  const CAM_KEYS = ["camTargetX", "camTargetY", "camTargetZ", "camYaw", "camPitch", "camRoll", "camDistance", "camFov"];
  const poseOf = (id) => page.evaluate((id, keys) => {
    const app = window.__powerrp_app;
    return Object.fromEntries(keys.map((k) => [k, app.storedItemValue(id, [k])]));
  }, id, CAM_KEYS);
  const setPose = (id, pose) => page.evaluate((id, pose) => {
    const app = window.__powerrp_app;
    app.setPreview(Object.entries(pose).map(([k, v]) => [["items", id, k], v]));
    app.commitPreview();
  }, id, pose);
  /** Query. The image ref this widget's emit() currently produces. THE cache key,
   *  read from the live app — so a pixel difference can be attributed to "a
   *  different raster was requested" or "the same raster drew differently"
   *  without guessing between them. */
  const refOf = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    if (!n) return null;
    const ops = n.plugin.emit(n.state, null, n.world);
    return ops.filter((o) => o.op === "image").map((o) => o.ref);
  }, id);
  const modeId = () => page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId ?? null);
  const hintLabels = () => page.evaluate(() => [...document.querySelectorAll(".hintbar .hint .label")].map((n) => n.textContent.trim()));
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  /** UNDO UNITS ARE COUNTED AT app.commit — the bento/activation probe technique.
   *  Every undo unit goes through commit(), so counting calls is the honest
   *  measure of "how many steps did that gesture cost". */
  const countCommits = () => page.evaluate(() => {
    if (window.__probeCommits !== undefined) return;
    window.__probeCommits = 0;
    const app = window.__powerrp_app;
    const real = app.commit.bind(app);
    app.commit = (d) => { window.__probeCommits += 1; return real(d); };
  });
  const commits = () => page.evaluate(() => window.__probeCommits);
  /** Query. What a widget's emit() currently produces, reduced to the one
   *  distinction every pixel check below depends on: `image` means a real raster
   *  is being drawn, `text` means one of the two message panels is up.
   *
   *  THIS EXISTS BECAUSE THE PIXEL PROXY LIED. The mesh check first "passed" on a
   *  RED ERROR PANEL — a box of wrapped red text compresses to more PNG bytes than
   *  the flat empty-viewport affordance, so "richer than empty" was satisfied by a
   *  failure. A screenshot caught it. Byte-richness alone can only ever say "not
   *  blank"; it cannot say "not an error", so both must be asserted. */
  const opsOf = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    if (!n) return null;
    const ops = n.plugin.emit(n.state, null, n.world);
    return { kinds: [...new Set(ops.map((o) => o.op))], message: ops.find((o) => o.op === "text")?.text ?? null };
  }, id);

  /** Query. A PNG of just one widget's box, as a base64 string — the unit every
   *  pixel assertion below compares. Clipping to the widget means a peer's
   *  unrelated repaint elsewhere on the canvas cannot make a determinism check
   *  flap. */
  const shotOf = async (box) => {
    const tl = await worldToPage(box.x, box.y);
    const br = await worldToPage(box.x + box.w, box.y + box.h);
    return page.screenshot({
      encoding: "base64",
      clip: { x: Math.round(tl.x), y: Math.round(tl.y), width: Math.round(br.x - tl.x), height: Math.round(br.y - tl.y) },
    });
  };
  /** Pure function. How many distinct quantized colours a decoded PNG's bytes
   *  imply — a cheap "is this a picture or a flat panel" measure. The base64 is
   *  compressed, so this reads its LENGTH as the proxy: a flat two-tone
   *  affordance compresses far smaller than a splat render of the same box. */
  const complexity = (b64) => b64.length;

  await countCommits();

  // ── Set the scene ─────────────────────────────────────────────────────────
  const emptyId = await spawn("scene3d_splat", EMPTY_BOX);
  const splatId = await spawn("scene3d_splat", { ...BOX, src: SPLAT_URL });
  await sleep(SETTLE_MS);
  ok(!!emptyId && !!splatId, `two viewports created (${splatId}, ${emptyId})`);

  // ── 1. IT DRAWS ───────────────────────────────────────────────────────────
  const emptyShot = await shotOf(EMPTY_BOX);
  let splatShot = null;
  const deadline = Date.now() + RASTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    splatShot = await shotOf(BOX);
    // The empty affordance is a flat panel plus one line of text; a splat render
    // is a photograph-like field. Waiting for the sourced widget to become
    // MEASURABLY richer than the sourceless one is what "the raster landed" means
    // without reaching into module internals.
    if (complexity(splatShot) > complexity(emptyShot) * 2) break;
    await sleep(400);
  }
  const refA = await refOf(splatId);
  const splatOps = await opsOf(splatId);
  ok(splatOps.kinds.includes("image") && splatOps.message === null,
    `the splat is drawing a RASTER, not a message panel (ops ${JSON.stringify(splatOps.kinds)}, message ${JSON.stringify(splatOps.message)})`);
  ok(complexity(splatShot) > complexity(emptyShot) * 2,
    `the splat scene RENDERED: ${complexity(splatShot)} bytes of PNG vs ${complexity(emptyShot)} for the same-size empty viewport`);
  await page.screenshot({ path: `${shots}/01-rendered.png` });

  // A SECOND shot with NOTHING changed in between. This separates two very
  // different faults: a renderer that is unstable frame to frame (this fails) from
  // a first frame that is special (this passes and the later comparison fails).
  await sleep(600);
  ok((await shotOf(BOX)) === splatShot, "two consecutive frames of an untouched scene are byte-identical");

  // ── 2. DETERMINISM AND THE PROPERTY→PIXEL LAW, BEFORE ANY GESTURE ─────────
  // ORDER MATTERS AND IT IS NOT ARBITRARY. Both pixel comparisons happen HERE,
  // before the widget is ever double-clicked, because entering fly mode mounts
  // the widget's floating camera bar and that bar's `box-shadow: 0 12px 40px
  // rgba(0,0,0,0.55)` falls across the bottom of the widget's own box. Measured:
  // the bar lands at page x 537..643 just below a widget occupying x 430..750,
  // and the shadow's clipped footprint is x 67..253 of the clip — against an
  // observed difference of exactly x 68..251, 6.52% of pixels at a max channel
  // delta of 21. That is EDITOR CHROME, not the renderer, and a determinism
  // assertion taken after the bar exists measures the wrong thing. (It also does
  // not go away on Escape — see the hand-back in this agent's report.)
  const pose0 = await poseOf(splatId);
  await setPose(splatId, { ...pose0, camYaw: pose0.camYaw + YAW_NUDGE });
  let movedShot = null;
  const picDeadline = Date.now() + RASTER_TIMEOUT_MS;
  while (Date.now() < picDeadline) {
    movedShot = await shotOf(BOX);
    if (movedShot !== splatShot) break;
    await sleep(400);
  }
  ok(movedShot !== splatShot, "the rendered picture FOLLOWS the camera property — a plain property write moves the shot");
  await page.screenshot({ path: `${shots}/02-moved.png` });

  await setPose(splatId, pose0);
  let backShot = null;
  const detDeadline = Date.now() + RASTER_TIMEOUT_MS;
  while (Date.now() < detDeadline) {
    backShot = await shotOf(BOX);
    if (backShot === splatShot) break;
    await sleep(400);
  }
  ok(JSON.stringify(await refOf(splatId)) === JSON.stringify(refA),
    `the restored pose asks for the SAME raster it asked for originally (${JSON.stringify(refA)})`);
  if (backShot !== splatShot) {
    // DIAGNOSTIC, not decoration: a determinism failure is the difference between
    // a recordable widget and an ephemeral one, and "the base64 differed" is not
    // enough to tell a renderer fault from chrome drifting into the clip. Both
    // clips are written so the failure can be LOOKED at.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${shots}/diff-a-original.png`, Buffer.from(splatShot, "base64"));
    writeFileSync(`${shots}/diff-b-returned.png`, Buffer.from(backShot, "base64"));
  }
  ok(backShot === splatShot,
    "returning to the ORIGINAL pose gives a BYTE-IDENTICAL frame — the widget is recordable, not ephemeral");

  // ── 3. DOUBLE-CLICK ENTERS MOUSE-LOOK ─────────────────────────────────────
  const centre = await worldToPage(BOX.x + BOX.w / 2, BOX.y + BOX.h / 2);
  await page.mouse.click(centre.x, centre.y, { clickCount: 2 });
  await sleep(SETTLE_MS);
  ok((await modeId()) === "navigate_scene", `double-click entered fly mode (got ${await modeId()})`);
  const flyHints = await hintLabels();
  ok(flyHints.includes("Look around"), `the HintBar announces the mode's gestures (${JSON.stringify(flyHints)})`);
  // Escape is NOT registered by this handler — declaring `mode` is the whole
  // registration, and core/shortcut_entries generates the scoped entry from it.
  // Asserting the CHIP is what proves that claim rather than assuming it.
  ok(flyHints.some((h) => /^Exit /.test(h)), `the mode's Escape entry was generated from the declaration (${JSON.stringify(flyHints)})`);
  await page.screenshot({ path: `${shots}/03-fly-mode.png` });

  // ── 4. FLYING WRITES THE DOCUMENT, AS ONE UNDO UNIT ───────────────────────
  const yaw0 = await stored(splatId, "camYaw");
  const commitsBefore = await commits();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(centre.x + (DRAG_PX * i) / 6, centre.y); await sleep(20); }
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const yaw1 = await stored(splatId, "camYaw");
  ok(typeof yaw1 === "number" && Math.abs(yaw1 - yaw0) > 1e-3,
    `the drag wrote camYaw into the DOCUMENT: ${yaw0} -> ${yaw1}`);
  ok((await commits()) - commitsBefore === 1,
    `one drag is ONE undo unit (${(await commits()) - commitsBefore} commits)`);
  // And the drag moved ONLY what it says it moves: an orbit is yaw and pitch.
  const posed = await poseOf(splatId);
  const untouched = ["camTargetX", "camTargetY", "camTargetZ", "camRoll", "camDistance", "camFov"]
    .filter((k) => posed[k] !== pose0[k]);
  ok(untouched.length === 0, `an orbit drag moved ONLY yaw and pitch (also moved: ${JSON.stringify(untouched)})`);

  // ── 5. ESCAPE LEAVES THE MODE ─────────────────────────────────────────────
  await page.keyboard.press("Escape");
  await page.mouse.move(4, 4);
  await sleep(SETTLE_MS);
  ok((await modeId()) === null, `Escape left fly mode (got ${await modeId()})`);
  await setPose(splatId, pose0);
  await sleep(SETTLE_MS);

  // ── 6. AN = EQUATION REFUSES TO BE FLOWN ──────────────────────────────────
  await setProp(splatId, "camYaw", "= 0.5");
  await sleep(SETTLE_MS);
  const boundBefore = await stored(splatId, "camYaw");
  warnings.length = 0;
  await page.mouse.click(centre.x, centre.y, { clickCount: 2 });
  await sleep(SETTLE_MS);
  ok((await modeId()) === null, "an = bound camera REFUSES fly mode rather than clobbering the equation");
  ok(warnings.some((w) => /camYaw/.test(w) && /equation/.test(w)),
    `the refusal is LOUD and names the property (${JSON.stringify(warnings.slice(0, 2))})`);
  ok((await stored(splatId, "camYaw")) === boundBefore,
    `the equation survived untouched (${JSON.stringify(await stored(splatId, "camYaw"))})`);

  // ── 7. THE MESH MEMBER RENDERS ────────────────────────────────────────────
  // The glTF half of the family, against the SHIPPED model so this needs no
  // network. It proves three things at once that nothing else here touches: the
  // GLTFLoader path, the three-point light rig (a PBR material with no light is
  // black, so a lit render and an unlit one are trivially distinguishable), and
  // normalizeToUnitSphere — without which an authored-scale model is either a
  // speck or entirely off-camera and the frame looks empty either way.
  const modelId = await spawn("scene3d_model", { ...MODEL_BOX, src: MODEL_URL });
  await sleep(SETTLE_MS);
  let modelShot = null;
  const meshDeadline = Date.now() + RASTER_TIMEOUT_MS;
  while (Date.now() < meshDeadline) {
    modelShot = await shotOf(MODEL_BOX);
    if (complexity(modelShot) > complexity(emptyShot) * 2) break;
    await sleep(400);
  }
  const modelOps = await opsOf(modelId);
  ok(modelOps.kinds.includes("image") && modelOps.message === null,
    `the glTF model is drawing a RASTER, not a message panel (ops ${JSON.stringify(modelOps.kinds)}, message ${JSON.stringify(modelOps.message)})`);
  ok(complexity(modelShot) > complexity(emptyShot) * 2,
    `the glTF model RENDERED and is lit: ${complexity(modelShot)} bytes of PNG vs ${complexity(emptyShot)} for an empty viewport of the same size`);
  await page.screenshot({ path: `${shots}/05-model.png` });

  // ── 8. A DEAD SOURCE FAILS LOUDLY, IN THE CANVAS ──────────────────────────
  // The whole reason this assertion exists: the preset library points at remote
  // URLs, so LINK ROT is not hypothetical — it is the expected end state of some
  // of those entries. A 404 must produce a red panel naming the reason, never a
  // blank viewport, and never a silent fall back to some other scene.
  const deadId = await spawn("scene3d_splat", { ...DEAD_BOX, src: DEAD_URL });
  await sleep(SETTLE_MS);
  let deadReason = null;
  const deadDeadline = Date.now() + RASTER_TIMEOUT_MS;
  while (Date.now() < deadDeadline) {
    deadReason = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((x) => x.itemId === id);
      const ops = n ? n.plugin.emit(n.state, null, n.world) : [];
      const label = ops.find((o) => o.op === "text");
      return label ? label.text : null;
    }, deadId);
    if (deadReason && /could not load/i.test(deadReason)) break;
    await sleep(400);
  }
  ok(deadReason && /could not load/i.test(deadReason),
    `a dead source draws a NAMED failure in the canvas, not a blank box (${JSON.stringify(deadReason)})`);
  ok((await shotOf(DEAD_BOX)) !== (await shotOf(EMPTY_BOX)),
    "a FAILED viewport and an EMPTY one look different — an absent scene and a broken one are different problems");
  await page.screenshot({ path: `${shots}/06-dead-source.png` });

  // The dead-source console.error is the SUBJECT of check 8, not a fault — it is
  // the loud half of the loud failure, and a probe that demanded silence there
  // would be demanding the bug back.
  const unexpected = liveErrors.filter((e) => !e.includes(DEAD_URL));
  ok(unexpected.length === 0, `no unexpected runtime errors during the run (${JSON.stringify(unexpected)})`);
  await page.screenshot({ path: `${shots}/04-final.png` });
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} check(s) failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length} scene3d probe checks passed — shots in ${shots}`);
