/**
 * THE AMBIENT POINTER, IN THE REAL APP (manifest R7-24) — the half
 * tests/pointer_input_test.js cannot reach, because the seam's LIVE regime is
 * wired in web/PresentMode.svelte and its FROZEN one in the editor.
 *
 *   node src/demo_apps/PowerRP/tests/pointer_input_probe.js [shot_dir]
 *
 * WHAT IS PROVEN HERE, and why each needs a browser:
 *   1. THE EDITOR IS FROZEN. A deck bound to `= mouse_x` sits at POINTER_REST while
 *      the mouse moves across the canvas — the editor never opens a feed, so a
 *      thumbnail, a PNG export and the canvas all agree with the CLI.
 *   2. THE PRESENTER IS LIVE, and the value that arrives is in WORLD units: a
 *      pointer at the centre of the letterboxed camera rect must evaluate to the
 *      centre of the SLIDE, not to a screen pixel. That conversion is the one thing
 *      a node test cannot check, and getting it wrong would make a deck authored on
 *      one display wrong on the next.
 *   3. `mouse_left` IS THE BUTTON HELD, not a click: it goes true on pointerdown and
 *      false on pointerup, with no movement in between.
 *   4. LEAVING THE PRESENTER RETURNS THE APP TO REST — the editor must not render
 *      the last presented pointer position.
 *   5. Zero console errors throughout.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const shotDir = process.argv[2] ?? resolve(webRoot, "../.claude_logs");

// THE DECK, built through the real document API so it is a document the app would
// have written — a hand-typed JSON literal would be a second, drifting spelling of
// core/document.js's schema.
const { newDocument, withNewItem, serialize } = await import("../core/document.js");
const { createRegistry } = await import("../core/registry.js");
const { createCommands } = await import("../core/commands.js");
const { registerAll } = await import("../plugins/index.js");
const registry = createRegistry();
registerAll(registry, createCommands());
const meta = newDocument().meta;
const FOLLOWER_SIZE = 80; // px in slide units; small enough to read its x/y as a position
const [doc] = withNewItem(newDocument(), 0, {
  ...registry.get("rect").defaults, active: true, name: "Follower",
  x: "= mouse_x", y: "= mouse_y", w: FOLLOWER_SIZE, h: FOLLOWER_SIZE,
  fill: "= mouse_left ? \"#ff0000\" : \"#00ff00\"",
});
const docJson = serialize(doc);

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  const VIEW = { width: 1200, height: 800 };
  await page.setViewport({ ...VIEW, deviceScaleFactor: 1 });
  // Pre-existing headless artifacts, unrelated to this seam (nav_transition_probe.js
  // carries the same two): a zero-sized-canvas paint race, and no WebGPU adapter
  // under SwiftShader.
  const ignore = (t) => /zero-sized canvas/.test(t) || /VideoV7: WebGPU init failed/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), docJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));

  /** Query (in-page). The follower's evaluated x/y/fill at the app's current frame. */
  const follower = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const item = Object.values(app.state().items).find((i) => i.name === "Follower");
    return { x: item.x, y: item.y, fill: item.fill };
  });

  // ── (1) THE EDITOR IS FROZEN ───────────────────────────────────────────────
  const editorRest = await follower();
  await page.mouse.move(VIEW.width * 0.7, VIEW.height * 0.6);
  await new Promise((r) => setTimeout(r, 150));
  const editorAfterMove = await follower();
  if (editorRest.x !== 0 || editorRest.y !== 0)
    throw new Error(`the editor did not start at POINTER_REST: ${JSON.stringify(editorRest)}`);
  if (editorAfterMove.x !== 0 || editorAfterMove.y !== 0)
    throw new Error(`the EDITOR followed the mouse (${JSON.stringify(editorAfterMove)}) — every still consumer in that process is now non-reproducible`);

  // ── (2) THE PRESENTER IS LIVE, IN WORLD UNITS ──────────────────────────────
  await page.evaluate(() => window.__powerrp_app.enterPresentMode());
  await new Promise((r) => setTimeout(r, 600));
  const presenting = await page.evaluate(() => window.__powerrp_app.mode);
  if (presenting !== "present") throw new Error(`enterPresentMode did not take: mode = ${presenting}`);

  // THE VIEWPORT CENTRE. The presenter letterboxes the camera rect into the window,
  // so the centre of the screen IS the centre of the camera rect whatever the
  // aspect — which makes this the one screen point whose world answer is known
  // without re-deriving fitRectView here (a second copy of the mapping under test).
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
  await new Promise((r) => setTimeout(r, 250));
  const atCentre = await follower();
  const expected = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const cam = Object.values(app.state().items).find((i) => i.type === "camera");
    return { x: cam.x + cam.w / 2, y: cam.y + cam.h / 2 };
  });
  const EPS = 1e-6; // an exact inverse of a float mapping, not an approximation
  if (Math.abs(atCentre.x - expected.x) > EPS || Math.abs(atCentre.y - expected.y) > EPS)
    throw new Error(`the pointer at the viewport centre evaluated to ${JSON.stringify(atCentre)}, expected the camera centre ${JSON.stringify(expected)} — the screen→world inverse is wrong`);
  await page.screenshot({ path: resolve(shotDir, "pointer_input_present_centre.png") });

  // A SECOND POINT, off-centre, so the check above cannot pass on a mapping that
  // ignores the pointer and happens to return the centre.
  await page.mouse.move(VIEW.width * 0.25, VIEW.height * 0.25);
  await new Promise((r) => setTimeout(r, 250));
  const offCentre = await follower();
  if (offCentre.x >= atCentre.x || offCentre.y >= atCentre.y)
    throw new Error(`moving up-left did not decrease the world point: ${JSON.stringify(offCentre)} vs ${JSON.stringify(atCentre)}`);

  // ── (3) mouse_left IS THE BUTTON HELD ──────────────────────────────────────
  if (offCentre.fill !== "#00ff00") throw new Error(`mouse_left was true with no button down (fill ${offCentre.fill})`);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 200));
  const held = await follower();
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));
  const released = await follower();
  if (held.fill !== "#ff0000") throw new Error(`mouse_left stayed false while the button was DOWN (fill ${held.fill})`);
  if (released.fill !== "#00ff00") throw new Error(`mouse_left stayed true after the button came UP (fill ${released.fill}) — it is behaving like a latched click, not a held state`);
  if (held.x !== offCentre.x || held.y !== offCentre.y)
    throw new Error("pressing the button moved the pointer position — the press and the position are not independent");

  // ── (4) LEAVING THE PRESENTER RETURNS TO REST ──────────────────────────────
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 600));
  const backInEditor = await follower();
  if (backInEditor.x !== 0 || backInEditor.y !== 0)
    throw new Error(`the editor kept the last presented pointer (${JSON.stringify(backInEditor)}) — stopPointerFeed did not restore POINTER_REST`);

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("POINTER INPUT PROBE OK");
  console.log(`  editor FROZEN at rest across a mouse move: ${JSON.stringify(editorAfterMove)}`);
  console.log(`  presenter LIVE, viewport centre → world ${JSON.stringify(atCentre)} (camera centre ${JSON.stringify(expected)})`);
  console.log(`  off-centre → ${JSON.stringify({ x: offCentre.x, y: offCentre.y })}; mouse_left held ${held.fill} → released ${released.fill}`);
  console.log(`  exit → back to rest ${JSON.stringify(backInEditor)}. Zero console errors.`);
  console.log("  screenshot:", resolve(shotDir, "pointer_input_present_centre.png"));
} finally {
  await browser.close();
  await server.close();
}
