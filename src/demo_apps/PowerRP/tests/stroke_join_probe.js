/**
 * THE STROKE-JOIN ROWS — BROWSER PROBE (real WebGL2 Skia pixels, real Inspector).
 *
 * The bare-node suite (render_gpu/tests/stroke_join_test.js) proves the algebra
 * and the geometry on a SOFTWARE Skia surface, and pins both vector exporters.
 * What it cannot prove is that any of it reaches the editor: that the two rows
 * are actually rendered, that the select WRITES the document, that the miter
 * limit row appears and disappears with the join it belongs to, and that the
 * hardware path draws the same corner the software path measured.
 *
 * The artwork is a plain SQUARE-CORNERED RECT — see the fixture comment below for
 * why a 90° corner is the RIGHT choice here even though it is the least dramatic
 * one: it turns the measurement into three binary probe points instead of a
 * scanline plus a tolerance, and the acute closed-form check already has a home.
 *
 * Spawns its OWN isolated Vite + headless Chromium, the svg_fill_row_probe
 * pattern. Run from POWERRP or the SvelteLib root.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THE FIXTURE IS A SQUARE-CORNERED RECT, deliberately, and not the acute chevron
// the bare-node suite uses. A 90° corner makes the three joins discriminable by
// THREE BINARY PROBE POINTS whose answers follow from school geometry rather than
// from a scanline plus a tolerance:
//
//   the stroke's outer corner is at (BOX - HALF, BOX - HALF); let r = HALF.
//   DIAG_OUT   a hair outside the round arc AND outside the bevel chord
//              → ink for MITER only (a miter fills the whole square corner)
//   DIAG_MID   inside the arc (dist < r) but outside the chord (x+y < BOX·2 − r)
//              → ink for MITER and ROUND, not BEVEL
//   FLANK      on the straight run, far from the corner → ink for all three,
//              so a blank frame cannot be mistaken for "bevel everywhere"
//
// The closed-form miter REACH at an acute angle is the bare-node suite's job
// (render_gpu/tests/stroke_join_test.js measures it against (w/2)/sin(θ/2)); this
// probe's job is that the choice reaches the editor's real WebGL2 pixels and its
// Inspector at all. A 90° corner also still exercises the LIMIT, since its ratio
// is √2 ≈ 1.414 and the row's floor of 1 sits below it.
const SLIDE = 400;
const BOX = 120, SIZE = 160, STROKE_W = 44, HALF = STROKE_W / 2;
const CORNER = BOX - HALF;                  // 98 — the outer corner of the stroke
const DIAG_OUT = CORNER + 3;                // 101 — dist from (BOX,BOX) = 26.9 > 22
const DIAG_MID = BOX - Math.round(HALF * 0.62); // 106 — dist 19.8 < 22, sum 212 < 218
const FLANK_X = BOX + SIZE / 2, FLANK_Y = BOX - HALF / 2;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  await page.evaluate(({ slide, box, size, strokeW }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: slide, h: slide, z: 1000, active: true, background: "#ffffff" };
    const art = {
      ...def("rect"), name: "Box", x: box, y: box, w: size, h: size, z: 1, active: true,
      cornerRadius: 0, fill: { type: "none" }, stroke: "#0000ff", strokeWidth: strokeW,
    };
    const doc = { meta: { name: "stroke-join-qa", slideW: slide, slideH: slide }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, art } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, { slide: SLIDE, box: BOX, size: SIZE, strokeW: STROKE_W });
  await sleep(700);

  const artId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "rect");
  });
  assert(!!artId, "square-cornered rect created");

  /**
   * Renders through the SHARED pixel service — the same WebGL2 Skia surface
   * thumbnails, the minimap and PNG export use, so a pass means the HARDWARE
   * painter drew it — and reports ink/no-ink at the three probe points.
   */
  const probe = () => page.evaluate(async ({ slide, diagOut, diagMid, flankX, flankY }) => {
    const app = window.__powerrp_app;
    const svc = await import("/gpuService.js");
    const canvas = await svc.renderCameraFrame(app.doc, { slideIndex: 0, alpha: 1, registry: app.registry, width: slide, height: slide });
    const ctx = canvas.getContext("2d");
    const ink = (x, y) => { const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; return d[2] > 128 && d[0] < 128; };
    return { out: ink(diagOut, diagOut), mid: ink(diagMid, diagMid), flank: ink(flankX, flankY) };
  }, { slide: SLIDE, diagOut: DIAG_OUT, diagMid: DIAG_MID, flankX: FLANK_X, flankY: FLANK_Y });

  /** Command. Writes one property through the app's UNIVERSAL edit path — the
   *  same setPreview/commitPreview seam every Inspector field uses. */
  const setProp = async (key, value) => {
    await page.evaluate((id, k, v) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, k], v]]);
      app.commitPreview();
    }, artId, key, value);
    await sleep(350);
  };
  const shape = (p) => `out=${p.out} mid=${p.mid} flank=${p.flank}`;

  // ── THE DEFAULT: a fresh widget miters — the whole square corner is ink. ──
  const asBuilt = await probe();
  assert(asBuilt.flank, `the stroke is drawn at all (flank point is ink); ${shape(asBuilt)}`);
  assert(asBuilt.out && asBuilt.mid, `default (no strokeJoin stored) MITERS — it fills the square corner; ${shape(asBuilt)}`);

  await setProp("strokeJoin", "miter");
  const miter = await probe();
  assert(JSON.stringify(miter) === JSON.stringify(asBuilt),
    `an explicit Miter is the same picture as the absent default; ${shape(miter)} vs ${shape(asBuilt)}`);

  await setProp("strokeJoin", "round");
  const round = await probe();
  assert(!round.out && round.mid && round.flank,
    `Round arcs the corner: inside the r=${HALF} arc is ink, past it is not; ${shape(round)}`);

  await setProp("strokeJoin", "bevel");
  const bevel = await probe();
  assert(!bevel.out && !bevel.mid && bevel.flank,
    `Bevel cuts a straight chord, inside even the round arc; ${shape(bevel)}`);

  // ── THE LIMIT: the sub-option, on the SAME shape. A 90° corner's ratio is
  //    √2 = 1.414, so a limit of 1 gives the point up and 4 keeps it. ────────
  await setProp("strokeJoin", "miter");
  await setProp("strokeMiter", 1);
  const limited = await probe();
  assert(!limited.out && limited.flank,
    `a miter limit of 1 is below √2, so even a square corner gives its point UP; ${shape(limited)}`);
  await setProp("strokeMiter", 4);
  const restored = await probe();
  assert(JSON.stringify(restored) === JSON.stringify(asBuilt),
    `raising the limit back past √2 restores the original pixels exactly; ${shape(restored)}`);

  // ── THE INSPECTOR: both rows present, the select writes, the limit row is a
  //    SUB-OPTION that appears and disappears with the join. ─────────────────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, artId);
  await sleep(600);

  /** Query. The Inspector row labels currently on screen. */
  const labels = () => page.evaluate(() =>
    [...document.querySelectorAll(".inspector .row")].map((r) => r.querySelector(".label")?.textContent.trim()).filter(Boolean));

  const withMiter = await labels();
  assert(withMiter.includes("Stroke join"), `the Inspector shows a Stroke join row; got ${JSON.stringify(withMiter.filter((l) => /stroke|miter/i.test(l)))}`);
  assert(withMiter.includes("Miter limit"), "the Miter limit row shows while the join IS miter");
  // Order: the limit reads as a knob ON the join, so it must sit directly after it.
  assert(withMiter.indexOf("Miter limit") === withMiter.indexOf("Stroke join") + 1,
    "the Miter limit row sits immediately after Stroke join (its sub-option)");

  await setProp("strokeJoin", "round");
  await sleep(400);
  const withoutMiter = await labels();
  assert(withoutMiter.includes("Stroke join"), "the join row stays — it is what turns miter back on");
  assert(!withoutMiter.includes("Miter limit"),
    "the Miter limit row DISAPPEARS under a Round join rather than sitting there inert");

  // The row must actually WRITE the document FROM THE UI (the "declared but not
  // wired" failure mode), driven through the shared Dropdown the rest of the
  // Inspector uses — `.dd-trigger` / `.dd-item`, the same handles
  // tests/material_paint_ui_probe.js and tests/searchable_dropdown_probe.js grab.
  // A select row is NOT a native <select> in this app (app chrome is the shared
  // component), so querying for one would silently pass over a broken control.
  await setProp("strokeJoin", "miter");
  await sleep(400);
  const opened = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Stroke join");
    const trig = row?.querySelector(".dd-trigger");
    if (!trig) return { hasDropdown: false, label: null };
    const label = row.querySelector(".dd-trigger-label")?.textContent.trim() ?? null;
    trig.click();
    return { hasDropdown: true, label };
  });
  await sleep(350);
  assert(opened.hasDropdown, "the Stroke join row renders the SHARED Dropdown, not a bare or missing control");
  assert(opened.label === "Miter (sharp)",
    `the trigger shows the human LABEL, not the stored id; got ${JSON.stringify(opened.label)}`);

  const menu = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".dd-menu .dd-item")].map((li) => li.textContent.trim());
    const bevel = [...document.querySelectorAll(".dd-menu .dd-item")].find((li) => /^Bevel/.test(li.textContent.trim()));
    if (bevel) bevel.click();
    return items;
  });
  await sleep(400);
  const storedJoin = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].strokeJoin, artId);
  assert(menu.length === 3 && /^Miter/.test(menu[0]) && /^Round/.test(menu[1]) && /^Bevel/.test(menu[2]),
    `the menu offers exactly the three modes in STROKE_JOIN_MODES order; got ${JSON.stringify(menu)}`);
  assert(storedJoin === "bevel", `choosing Bevel in the Inspector writes the document; stored ${JSON.stringify(storedJoin)}`);

  // AND IT IS EQUATION-BINDABLE like every other property — the house rule. The
  // row carries the ƒ affordance, and an equation resolving to a valid option id
  // must reach the stored slot and then the pixels.
  const hasEq = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Stroke join");
    return !!row?.querySelector(".eq-open");
  });
  assert(hasEq, "the Stroke join row offers the equation affordance (a select is `=`-bindable in this app)");
  await setProp("strokeJoin", '= "round"');
  const viaEquation = await probe();
  assert(!viaEquation.out && viaEquation.mid,
    `an EQUATION resolving to "round" paints a round corner; ${shape(viaEquation)}`);
  await setProp("strokeJoin", "miter");

  // ── A STROKE MATERIAL hides both rows rather than offering dead controls. ──
  await setProp("stroke", { type: "material", material: { id: "wavy" }, params: {} });
  await sleep(500);
  const underMaterial = await labels();
  assert(!underMaterial.includes("Stroke join") && !underMaterial.includes("Miter limit"),
    `both join rows hide behind a stroke material (a material draws its own resampled geometry); got ${JSON.stringify(underMaterial.filter((l) => /join|miter/i.test(l)))}`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nSTROKE JOIN PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nSTROKE JOIN PROBE PASSED — the three joins and the miter limit change real WebGL2 Skia pixels at a square corner, an equation drives the select, and the Inspector rows appear, write, and hide with what they modify.");
} finally {
  await browser.close();
  await server.close();
}
