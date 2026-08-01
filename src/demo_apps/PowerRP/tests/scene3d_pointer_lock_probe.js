/**
 * THE 3D VIEWPORT CAPTURES THE POINTER WHILE YOU LOOK, AND THE PICTURE MOVES.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/scene3d_pointer_lock_probe.js [shot_dir]
 *
 * THE REPORT (todo #254): "I double clicked but it didn't capture my mouse and
 * didn't let me go into mouse lock. I wasn't able to navigate at all."
 *
 * TWO SEPARATE FACTS WERE BEHIND THAT SENTENCE, and this file pins both, because
 * fixing one and declaring victory is how the other survives:
 *   · `requestPointerLock` appeared NOWHERE in the source. The pointer was never
 *     captured, so a look was bounded by the window and the cursor slid off the
 *     thing it was steering.
 *   · The widget was TRANSPARENT for ~98% of the frames of any gesture that
 *     changed a property (todo #255), so a look that DID work looked like a look
 *     that did nothing. Check 4 below is the one that proves he can now see it.
 *
 * WHY THIS PROBE USES REAL POINTER INPUT AND NOT A FLAG. Under pointer lock the
 * pointer's clientX/clientY are FROZEN, so the two-point client difference the
 * drag path used yields (0, 0) forever: capturing the pointer without also
 * switching to movementX/movementY would silently disable the very gesture it was
 * added to improve. A probe asserting `pointerLockElement !== null` would pass on
 * that broken build. So every check below drives page.mouse and reads the
 * DOCUMENT, and check 4 reads PIXELS.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const shots = process.argv[2] ?? "/tmp/scene3d_pointer_lock_probe";
await mkdir(shots, { recursive: true });

const BOX = { x: 200, y: 160, w: 320, h: 240 };
/** One reactive paint plus a Skia frame — tests/scene3d_probe.js's value. */
const SETTLE_MS = 220;
const RASTER_TIMEOUT_MS = 60000;
/** How far to move, in device px, per look step. Well inside the widget so the
 *  UNLOCKED fallback would also stay in the box — the two paths must be compared
 *  on a gesture both can perform, or the comparison measures the box edge. */
const LOOK_PX = 24;
const LOOK_STEPS = 6;

const splatPath = fileURLToPath(new URL("../assets/builtin/splats/spz-test-scene.ply", import.meta.url));
const SPLAT_URL = `/@fs${splatPath}`;

const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  cacheDir: await mkdtemp(join(tmpdir(), "powerrp-lock3d-vite-")),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ protocolTimeout: 180000 });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const warnings = [];
  page.on("console", (m) => { if (/warn/.test(m.type())) warnings.push(m.text()); });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 120000 });
  await sleep(SETTLE_MS * 4);

  const splatId = await page.evaluate((extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("scene3d_splat").defaults, ...extra });
    return app.selection;
  }, { ...BOX, src: SPLAT_URL });

  const stored = (key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), splatId, key);
  const modeId = () => page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId ?? null);
  const lockEl = () => page.evaluate(() => (document.pointerLockElement ? document.pointerLockElement.className || "(unnamed element)" : null));
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, wx, wy);
  const countCommits = () => page.evaluate(() => {
    if (window.__probeCommits !== undefined) return;
    window.__probeCommits = 0;
    const app = window.__powerrp_app;
    const real = app.commit.bind(app);
    app.commit = (d) => { window.__probeCommits += 1; return real(d); };
  });
  const commits = () => page.evaluate(() => window.__probeCommits);

  const tl = await worldToPage(BOX.x, BOX.y);
  const br = await worldToPage(BOX.x + BOX.w, BOX.y + BOX.h);
  const clip = {
    x: Math.round(tl.x), y: Math.round(tl.y),
    width: Math.round(br.x - tl.x), height: Math.round(br.y - tl.y),
  };
  const shot = () => page.screenshot({ encoding: "base64", clip });
  const centre = await worldToPage(BOX.x + BOX.w / 2, BOX.y + BOX.h / 2);

  // Wait for the fixture so the pixel check below compares two RENDERS rather
  // than two empty boxes, which would agree and pass for the wrong reason.
  const deadline = Date.now() + RASTER_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((x) => x.itemId === id);
      return !!n && n.plugin.emit(n.state, null, n.world).some((o) => o.op === "image");
    }, splatId);
    if (ready && (await shot()).length > 20000) break;
    await sleep(300);
  }
  ok(ready, "the shipped splat fixture is drawing before the gesture checks begin");
  await countCommits();

  // ── 1. DOUBLE-CLICK STILL ENTERS THE MODE ─────────────────────────────────
  await page.mouse.click(centre.x, centre.y, { clickCount: 2 });
  await sleep(SETTLE_MS);
  ok((await modeId()) === "navigate_scene", `double-click entered fly mode (got ${await modeId()})`);
  ok((await lockEl()) === null, "entering the mode does NOT itself take the pointer — the mode's own camera bar stays usable");

  // ── 2. PRESSING TO LOOK CAPTURES THE POINTER ──────────────────────────────
  const before = await shot();
  const yaw0 = await stored("camYaw");
  const commits0 = await commits();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await sleep(SETTLE_MS);
  const lockedDuring = await lockEl();
  ok(lockedDuring !== null, `pressing to look CAPTURED the pointer (locked element: ${JSON.stringify(lockedDuring)})`);

  // ── 3. MOVING WHILE LOCKED FLIES THE CAMERA ───────────────────────────────
  // THE CHECK THAT CANNOT BE FAKED. A locked pointer's client coordinates never
  // change, so a build that took the lock but kept reading them would move the
  // camera by exactly zero and every other check here would still pass.
  for (let i = 1; i <= LOOK_STEPS; i++) {
    await page.mouse.move(centre.x + (LOOK_PX * i) / LOOK_STEPS, centre.y);
    await sleep(30);
  }
  await sleep(SETTLE_MS);
  const yawLocked = await page.evaluate((id) => {
    // The PREVIEW value, not the stored one: a look stages a preview and commits
    // on release, so mid-gesture the document is deliberately untouched.
    const app = window.__powerrp_app;
    return app.nodes().find((n) => n.itemId === id)?.state.camYaw ?? null;
  }, splatId);
  ok(typeof yawLocked === "number" && Math.abs(yawLocked - yaw0) > 1e-3,
    `moving a CAPTURED pointer flies the camera: camYaw ${yaw0} -> ${yawLocked} (movementX is read; a frozen-clientX build would report no change)`);

  // ── 4. AND HE CAN SEE IT — THE PICTURE MOVES, MID-GESTURE ─────────────────
  // The other half of "I wasn't able to navigate at all": before todo #255 the
  // widget was blank for ~98% of a gesture's frames, so a working look looked
  // like a broken one. This asserts a mid-look frame is BOTH different from the
  // start AND still a picture rather than the transparent hole.
  const during = await shot();
  writeFileSync(`${shots}/01-before-look.png`, Buffer.from(before, "base64"));
  writeFileSync(`${shots}/02-during-look.png`, Buffer.from(during, "base64"));
  ok(during !== before, "the rendered picture MOVED during the look — the gesture is visible, not just recorded");
  ok(during.length > before.length / 2,
    `and the mid-look frame is still a PICTURE, not the hole: ${during.length} b64 chars against ${before.length} at rest`);

  // ── 5. RELEASE GIVES THE POINTER BACK, AS ONE UNDO UNIT ───────────────────
  await page.mouse.up();
  await sleep(SETTLE_MS);
  ok((await lockEl()) === null, `releasing gave the pointer back (still held: ${JSON.stringify(await lockEl())})`);
  ok((await commits()) - commits0 === 1, `one captured look is ONE undo unit (${(await commits()) - commits0} commits)`);
  ok(Math.abs((await stored("camYaw")) - yaw0) > 1e-3,
    `and it landed in the DOCUMENT on release: camYaw ${yaw0} -> ${await stored("camYaw")}`);

  // ── 6. A REFUSED LOCK SAYS SO, AND THE GESTURE STILL WORKS ────────────────
  // A browser MAY refuse — no user activation, a sandboxed frame, or the
  // anti-abuse rate limit that fires right after an Escape. The requirement is
  // that the user is told rather than left clicking at a dead widget, and that
  // the mode degrades to the plain drag it was before pointer lock existed.
  // Forcing the refusal by replacing the API is the only way to reach that branch
  // deterministically; the fallback it exercises is the real code.
  await page.evaluate(() => {
    window.__realRequestPointerLock = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function refuse() {
      return Promise.reject(new Error("probe: pointer lock refused on purpose"));
    };
  });
  warnings.length = 0;
  const yawRefused0 = await stored("camYaw");
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let i = 1; i <= LOOK_STEPS; i++) {
    await page.mouse.move(centre.x + (LOOK_PX * i) / LOOK_STEPS, centre.y);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(SETTLE_MS);
  ok((await lockEl()) === null, "the forced refusal really did prevent the lock");
  ok(warnings.some((w) => /capture the pointer/i.test(w) && /refused/i.test(w)),
    `a refused capture is REPORTED, not swallowed (${JSON.stringify(warnings.slice(0, 2))})`);
  ok(Math.abs((await stored("camYaw")) - yawRefused0) > 1e-3,
    `and the look STILL WORKS by plain drag: camYaw ${yawRefused0} -> ${await stored("camYaw")} — a refusal costs a sentence, never the gesture`);
  await page.evaluate(() => { Element.prototype.requestPointerLock = window.__realRequestPointerLock; });

  // ── 7. ESCAPE STILL MEANS EXACTLY ONE THING ───────────────────────────────
  // Escape has leaked between handlers twice in this app. The capture is per-drag
  // and released on pointer-up, so no lock is live when Escape is pressed in
  // ordinary use — which is precisely why Escape can keep its single meaning here.
  ok((await modeId()) === "navigate_scene", "still in fly mode after all of the above");
  await page.keyboard.press("Escape");
  await page.mouse.move(4, 4);
  await sleep(SETTLE_MS);
  ok((await modeId()) === null, `Escape left fly mode, once (got ${await modeId()})`);
  ok((await lockEl()) === null, "and left no pointer captured behind it");
  await page.screenshot({ path: `${shots}/03-final.png` });
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} check(s) failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length} pointer-lock checks passed — shots in ${shots}`);
