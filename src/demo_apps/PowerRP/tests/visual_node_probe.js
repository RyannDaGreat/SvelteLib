/**
 * VISUAL NODE PROBE — the do-nothing node in the REAL editor: its beads and their
 * custom colours on the overlay, a `multiple` input's wires and Inspector control,
 * and the flowchart double-click that edits the text INSIDE the shape.
 *
 * Verifies:
 *   1. The plugin declares `inlineTextEdit` with the `ink` + `box` descriptor
 *      fields the controller reads (plaintext's contract plus the two additions).
 *   2. Every port of a diamond and two source rectangles is a live bead on the
 *      overlay, and a bead carries its PORT'S colour (not the type's).
 *   3. A `multiple` input holding two wires shows the multi-wire Inspector control
 *      with both sources listed.
 *   4. A REAL double-click on the glyphs enters plain in-place edit, and the caret
 *      sits INSIDE the diamond — between its beads, not at the item's top-left —
 *      which is the `box` descriptor doing its job.
 *   5. Typing updates the stored `text` as a plain string; Escape commits.
 *
 * Spawns its OWN Vite + headless Chromium (tests/plaintext_inline_edit_probe.js's
 * pattern). Run from POWERRP or the SvelteLib root (cwd-independent):
 *   node src/demo_apps/PowerRP/tests/visual_node_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shots = process.argv[2] ?? "/tmp/visual_node_probe";
await mkdir(shots, { recursive: true });

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

// The diamond's box, in WORLD units: the text box is its inscribed rectangle
// (core/visual_node.visualContentBox), i.e. the middle half in each axis.
const NODE = { x: 100, y: 100, w: 300, h: 200 };
const SOURCE_Y = [60, 300];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets|could not list project assets|\/api\/assets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // (1) The declaration the controller reads.
  const descriptor = await page.evaluate(() => {
    const d = window.__powerrp_app.registry.get("visual_node")?.inlineTextEdit ?? null;
    return d ? { property: d.property, plain: d.plain, ink: d.ink, box: typeof d.box } : null;
  });
  assert(descriptor && descriptor.plain === true && descriptor.property === "text" && descriptor.ink === "textFill" && descriptor.box === "function",
    `visualNodePlugin declares inlineTextEdit {property:"text", plain, ink:"textFill", box()} (got ${JSON.stringify(descriptor)})`);

  // A diamond with a `multiple` input fed by two source rectangles.
  await page.evaluate(({ NODE, SOURCE_Y }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#f4f4f8" };
    const diamond = {
      ...def("visual_node"), name: "Decision", ...NODE, z: 1, active: true,
      shape: "diamond", cornerRadius: 0, label: "", text: "Hello", size: 28,
      inPorts: [{ label: "", color: "#ff3333", multiple: true }],
      outPorts: [{ label: "yes", color: "#33cc33" }, { label: "no", color: "#cc3333" }],
      inputs: { in0: [{ item: "srcA", port: "out0" }, { item: "srcB", port: "out0" }] },
    };
    const source = (y, name) => ({
      ...def("visual_node"), name, x: 620, y, w: 160, h: 80, z: 1, active: true,
      shape: "rect", cornerRadius: 8, label: name, text: "",
      inPorts: [], outPorts: [{ label: "", color: "#3399ff" }],
    });
    const doc = { meta: { name: "visual-node-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null },
        delta: { items: { cam, diamond, srcA: source(SOURCE_Y[0], "A"), srcB: source(SOURCE_Y[1], "B") } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, { NODE, SOURCE_Y });
  await sleep(600);

  // (2) Beads on the overlay, in their PORT colours.
  const beads = await page.evaluate(() => [...document.querySelectorAll(".nf-bead")].map((c) => ({
    title: c.querySelector("title")?.textContent ?? "", color: c.style.getPropertyValue("--nf-wire-color").trim(),
    cx: Number(c.getAttribute("cx")), cy: Number(c.getAttribute("cy")),
  })));
  assert(beads.length === 5, `five beads on the overlay — 3 on the diamond, 1 per source (got ${beads.length}: ${beads.map((b) => b.title).join(", ")})`);
  assert(beads.some((b) => b.color === "#33cc33") && beads.some((b) => b.color === "#ff3333"),
    `beads wear their PORT'S colour, not the visual type's (colours: ${[...new Set(beads.map((b) => b.color))].join(", ")})`);
  const diamondBeads = beads.filter((b) => b.color !== "#3399ff");
  const inBead = diamondBeads.find((b) => b.color === "#ff3333");
  const outBeads = diamondBeads.filter((b) => b.color !== "#ff3333");
  assert(inBead && outBeads.length === 2 && outBeads.every((b) => b.cx > inBead.cx + 100),
    "the diamond's outputs sit well to the right of its input (on the right-hand slopes)");

  // (3) The `multiple` input's Inspector control lists both wires.
  await page.evaluate(() => { window.__powerrp_app.selection = "diamond"; });
  await sleep(500);
  const multi = await page.evaluate(() => {
    const el = document.querySelector(".nodeinput-multi");
    return el ? [...el.querySelectorAll(".nodeinput-wire-label")].map((e) => e.textContent.trim()) : null;
  });
  assert(multi && multi.length === 2, `the multiple input's control lists its two wires (got ${JSON.stringify(multi)})`);

  // (4) A REAL double-click on the glyphs enters plain in-place edit, INSIDE the diamond.
  await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id, { property: "text", plain: true }), "diamond");
  await sleep(300);
  const caret0 = await page.evaluate(() => {
    const c = window.__powerrp_textEdit?.caretScreen(0);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return c ? { x: r.left + c.x + 10, y: r.top + (c.y + c.y2) / 2, raw: c } : null;
  });
  assert(!!caret0, "got an on-glyph screen point via the mounted editor");
  // The caret must be INSIDE the diamond: between the input bead and the output
  // beads horizontally, and level with them vertically. At the item's origin
  // (the old, box-relative editor) it would be far above and left of both.
  if (caret0) {
    const left = inBead.cx, right = Math.min(...outBeads.map((b) => b.cx));
    const midY = outBeads.reduce((a, b) => a + b.cy, 0) / outBeads.length;
    const cx = caret0.raw.x, cy = (caret0.raw.y + caret0.raw.y2) / 2;
    assert(cx > left + 0.2 * (right - left) && cx < right - 0.05 * (right - left),
      `the caret is INSIDE the diamond horizontally (caret x ${cx.toFixed(0)}, beads ${left.toFixed(0)}..${right.toFixed(0)})`);
    assert(Math.abs(cy - midY) < 40, `the caret is level with the beads (caret y ${cy.toFixed(0)}, beads ${midY.toFixed(0)})`);
  }
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
  await sleep(200);
  assert(!(await page.evaluate(() => !!window.__powerrp_app.textEditing)), "edit cancelled (clean slate before the real double-click)");

  await page.evaluate(({ x, y }) => {
    document.querySelector(".overlay").dispatchEvent(new MouseEvent("dblclick", { clientX: x, clientY: y, bubbles: true }));
  }, caret0 ?? { x: 0, y: 0 });
  await sleep(300);
  const editing = await page.evaluate(() => {
    const t = window.__powerrp_app.textEditing;
    return t ? { itemId: t.itemId, plain: t.plain, property: t.property } : null;
  });
  assert(editing && editing.itemId === "diamond" && editing.plain === true && editing.property === "text",
    `double-click on the shape's text ENTERED plain in-place edit (textEditing=${JSON.stringify(editing)})`);
  assert(await page.evaluate(() => !document.querySelector(".text-format-toolbar")), "no rich format toolbar in plain mode");

  // (5) Typing updates the stored string live; Escape commits it.
  const stored = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    return app.previewDelta?.items?.[id]?.text ?? app.doc.slides[0].delta.items[id].text;
  }, "diamond");
  await page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());
  await sleep(100);
  await page.keyboard.type(" World");
  await sleep(150);
  assert((await stored()) === "Hello World", `typing appended live → "Hello World" (got ${JSON.stringify(await stored())})`);
  await page.keyboard.press("Escape");
  await sleep(200);
  assert(!(await page.evaluate(() => !!window.__powerrp_app.textEditing)), "Escape exits edit mode");
  assert((await stored()) === "Hello World", "the commit kept the plain string");

  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await sleep(300);
  await page.screenshot({ path: resolve(shots, "visual_node.png") });
  console.log(`  shot ${resolve(shots, "visual_node.png")}`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\nvisual node probe: ${fails.length} FAILED`); process.exit(1); }
console.log("\nvisual node probe: all checks passed");
