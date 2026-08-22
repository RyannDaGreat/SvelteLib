/**
 * ROUTING POINT INSERT PROBE — the gesture the user asked for, driven in the REAL
 * editor: "it would be nice if I could double click on a wire to add a routing
 * point widget....just kinda a lone connector...used to make the wires nicer"
 * (2026-08-22).
 *
 * Verifies, against a live document:
 *   1. A double-click ON A WIRE inserts a routing point: the item exists, it
 *      carries the wire's TYPE and COLOUR, and it sits where the pointer was.
 *   2. The cable is CONTINUOUS through it — one wire became two, source → joint →
 *      destination, and the destination's input now names the joint.
 *   3. THE VALUE STILL FLOWS: the display behind the joint reads what it read
 *      before (the pass-through is invisible to the graph).
 *   4. It is ONE UNDO UNIT: a single Cmd+Z restores the original single wire and
 *      removes the joint — never an orphan dot or a dangling input.
 *   5. The joint SPLITS: a second wire dragged out of it reaches another node, so
 *      "split one connector into multiple outputs" is real.
 *   6. A double-click on EMPTY CANVAS inserts nothing (a miss is not an error).
 *
 * Spawns its OWN Vite + headless Chromium. Run from POWERRP or the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/route_insert_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets|could not list project assets|\/api\/assets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A number source wired to a display, both level and far apart, so the cable
  // runs STRAIGHT across a wide empty band with nothing else to hit.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#f4f4f8" };
    const src = { ...def("node_number"), name: "Src", x: 60, y: 200, z: 1, active: true, value: 7 };
    const dst = { ...def("node_display"), name: "Dst", x: 700, y: 200, z: 1, active: true, inputs: { in: { item: "src", port: "out" } } };
    const doc = { meta: { name: "route-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, src, dst } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(700);

  /** Query. The document's items on slide 0, by id. */
  const items = () => page.evaluate(() => {
    const out = {};
    for (const [id, s] of Object.entries(window.__powerrp_app.state().items ?? {})) out[id] = s;
    return JSON.parse(JSON.stringify(out));
  });
  /** Query. Every derived wire as "from>to", so a cable's shape is comparable. */
  const wires = () => page.evaluate(() => window.__powerrp_app.nodes()
    .flatMap((n) => Object.entries(n.state.inputs ?? {})
      .filter(([, c]) => c && typeof c === "object" && typeof c.item === "string")
      .map(([port, c]) => `${c.item}.${c.port}>${n.itemId}.${port}`)).sort());
  /** Query. A WORLD point as a page point, through the canvas's own mapping plus
   *  the overlay's rect — the tests/nodeflow_probe.js idiom (page coordinates and
   *  render-area coordinates differ by the panes to the left and above). */
  const pageAt = (wx, wy) => page.evaluate(({ x, y }) => {
    const p = window.__powerrp_app.canvasActions.worldToScreen(x, y);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, { x: wx, y: wy });

  const before = await wires();
  assert(before.length === 1 && before[0] === "src.out>dst.in", `the fixture is one wire (${before.join(", ")})`);
  const displayBefore = await page.evaluate(() => window.__powerrp_app.nodes().find((n) => n.itemId === "dst")?.state?.nodePorts?.inputs?.in);
  assert(displayBefore === 7, `the display reads its source before the insert (got ${displayBefore})`);

  // The cable's own midpoint: both beads are level, so the drawn bezier passes
  // through the midpoint of the line between them (its control points are
  // symmetric about it — see tests/route_node_test.js).
  // The two beads are level, so the drawn bezier passes through the midpoint of
  // the line between them (its control points are pushed out by the same reach
  // from each end and are therefore symmetric about it — tests/route_node_test.js
  // states this and tests the asymmetric case). Both ports sit at the same y on
  // their cards, so that midpoint is the cable's own middle.
  const mid = await page.evaluate(() => {
    const n = window.__powerrp_app.nodes();
    const s = n.find((x) => x.itemId === "src"), d = n.find((x) => x.itemId === "dst");
    const PORT_TOP_INSET = 34; // core/nodeflow.js — the first port row's y on a card
    return { x: (s.state.x + s.state.w + d.state.x) / 2, y: s.state.y + PORT_TOP_INSET };
  });
  const midPage = await pageAt(mid.x, mid.y);

  // (1) THE GESTURE.
  await page.mouse.click(midPage.x, midPage.y, { clickCount: 2 });
  await sleep(500);
  const after = await items();
  const joints = Object.entries(after).filter(([, s]) => s.type === "route_node");
  assert(joints.length === 1, `a double-click on the wire inserted ONE routing point (got ${joints.length})`);
  const [jointId, joint] = joints[0] ?? ["", {}];
  assert(joint.portType === "number", `it carries the WIRE's type (got ${joint.portType})`);
  assert(joint.color === "#7aa2f7", `…and the wire's colour (got ${joint.color})`);
  assert(Math.abs((joint.x + joint.w / 2) - mid.x) < 2 && Math.abs((joint.y + joint.h / 2) - mid.y) < 2,
    `…centred where the pointer was (item centre ${joint.x + joint.w / 2},${joint.y + joint.h / 2} vs ${mid.x},${mid.y})`);

  // (2) THE CABLE IS CONTINUOUS.
  const wired = await wires();
  assert(wired.length === 2 && wired.includes(`src.out>${jointId}.in`) && wired.includes(`${jointId}.out>dst.in`),
    `one wire became source → joint → destination (${wired.join(", ")})`);

  // (3) THE VALUE STILL FLOWS.
  const displayAfter = await page.evaluate(() => window.__powerrp_app.nodes().find((n) => n.itemId === "dst")?.state?.nodePorts?.inputs?.in);
  assert(displayAfter === 7, `the display behind the joint reads what it read before (got ${displayAfter})`);

  // (4) ONE UNDO UNIT.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(400);
  const undone = await items();
  assert(!Object.values(undone).some((s) => s.type === "route_node"), "ONE undo removed the joint");
  assert((await wires()).join(",") === before.join(","), "…and restored the original single wire in the same step");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(400);
  assert(Object.values(await items()).some((s) => s.type === "route_node"), "redo puts it back (one unit both ways)");

  // (5) IT SPLITS: a second destination wired from the joint's output.
  await page.evaluate((jid) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    app.addItem({ ...def("node_display"), name: "Dst2", x: 700, y: 360, active: true, inputs: { in: { item: jid, port: "out" } } });
  }, jointId);
  await sleep(500);
  const split = await wires();
  assert(split.filter((w) => w.startsWith(`${jointId}.out>`)).length === 2,
    `the joint drives TWO destinations — one connector split (${split.join(", ")})`);
  const second = await page.evaluate(() => window.__powerrp_app.nodes().filter((n) => n.type === "node_display").map((n) => n.state?.nodePorts?.inputs?.in));
  assert(second.every((v) => v === 7), `…and both read the source's value (${JSON.stringify(second)})`);

  // (6) A MISS IS NOT AN ERROR.
  const emptyPage = await pageAt(mid.x, mid.y + 220);
  const countBefore = Object.keys(await items()).length;
  await page.mouse.click(emptyPage.x, emptyPage.y, { clickCount: 2 });
  await sleep(350);
  assert(Object.keys(await items()).length === countBefore, "a double-click on empty canvas inserts nothing");

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\nroute insert probe: ${fails.length} FAILED`); process.exit(1); }
console.log("\nroute insert probe: all checks passed");
