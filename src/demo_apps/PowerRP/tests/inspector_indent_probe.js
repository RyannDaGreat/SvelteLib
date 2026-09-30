/**
 * INSPECTOR INDENT probe — THE NESTING LAW, measured (app.css "THE NESTING LAW").
 *
 * USER, 2026-09-30: "every indent should be a little bit more to the right of the
 * last one, but that's not the case. See how it says three sources, source one,
 * and then weight under that is actually to the left of source one."
 *
 * ONE CLAIM, over every nesting device the Inspector has: a nested label starts
 * STRICTLY RIGHT of its parent's label, and the first column of everything laid
 * out BELOW the parent is EXACTLY one --a-nest-step right of it. A third check
 * pins the guide hairline under the control that opens the block (a header's
 * chevron, a compound's twisty, a row's interp button).
 *
 * A label's PARENT is found by walking up the DOM to the nearest nesting device
 * (DEVICES in `measure`). A label no device claims is reported as UNCLASSIFIED,
 * so a new nesting device cannot slip past this probe by being unknown to it.
 * Each device must be exercised at least once, so the probe cannot pass
 * vacuously if a scenario failed to open.
 *
 * Before the law (default 317px Inspector, x relative to the panel): Fill 53 → its
 * editor 8; "3 sources" 28 → "Source 1" 76 → Weight 13; "Points" 53 → "5 points"
 * 48; "Position" 53 → X 53.
 *
 * Every threshold compares two boxes measured in the same frame; the only
 * absolute number is the step, and that is read from the CSS token itself.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/inspector_indent_probe.js
 * Screenshots: src/demo_apps/PowerRP/.claude_vlm_checks/inspector_indent/
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(HERE, "..");
const webRoot = resolve(powerrp, "web");
const shots = resolve(powerrp, ".claude_vlm_checks/inspector_indent");
await mkdir(shots, { recursive: true });
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

// Browser layout resolves to 1/64px and two boxes laid out from the same tracks
// can land a rounding step apart; the defects this catches were 15-70px.
const EPS = 0.5;
// The guide is a hairline painted at a computed x; it must fall inside the
// opening control's box, give or take a device pixel of rounding.
const GUIDE_SLOP = 1;
const SETTLE_MS = 300;
// Every nesting device the scenarios below must exercise.
const REQUIRED_DEVICES = [
  "row editor", "list body", "custom element body", "list element fields",
  "material knobs", "compound children", "interp strip",
];
// Boot noise the house probes already allow (tests/list_ui_probe.js IGNORE_BOOT):
// fixture migrations, fonts, and the headless renderer's missing GPU adapter.
const IGNORE = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];

/**
 * Query (reads the live DOM; runs IN THE PAGE via page.evaluate). Measures every
 * label in the Inspector against its parent label and returns plain JSON.
 *
 * @param {number} eps - Layout rounding slack, px (the probe's EPS).
 * @returns {string} JSON {step, pairs:[{device, root, child, cx, parent, px, below, key}],
 *   guides:[{device, parent, guideX, ctlL, ctlR}], unclassified:[text]}
 */
function measure(eps) {
  const probe = document.createElement("div");
  probe.style.width = "var(--a-nest-step)";
  document.body.append(probe);
  const step = probe.getBoundingClientRect().width;
  probe.remove();
  const inspector = document.querySelector(".inspector");
  const HEADER_TITLE = ":scope > .tt-anchor > .cat-header .cat-title, :scope > .cat-header .cat-title";
  const HEADER_ICON = ":scope > .tt-anchor > .cat-header > iconify-icon, :scope > .cat-header > iconify-icon";
  // name, whether `a` (an ancestor of label `lbl`) is this device's block, the
  // parent label, the control that opens the block, the element that paints its guide.
  const DEVICES = [
    { name: "list element fields",
      match: (a, lbl) => a.classList.contains("list-el") && lbl.classList.contains("list-field-label"),
      parent: (a) => a.querySelector(":scope > .list-index"),
      // Fields are a nested LEVEL only when they wrap onto their own line; inline
      // beside the index they are the same row and only have to be right of it.
      belowBox: (lbl) => lbl.closest(".list-fields") },
    { name: "custom element body", match: (a) => a.classList.contains("list-el-content"),
      parent: (a) => a.parentElement.querySelector(":scope > .list-fields .cat-title"),
      control: (a) => a.parentElement.querySelector(":scope > .list-fields .cat-header > iconify-icon"),
      guide: (a) => a },
    { name: "list body", match: (a) => a.classList.contains("list-body"),
      parent: (a) => a.parentElement.querySelector(HEADER_TITLE),
      control: (a) => a.parentElement.querySelector(HEADER_ICON),
      guide: (a) => a },
    { name: "material knobs", match: (a) => a.classList.contains("paint-knob-rows"),
      parent: (a) => a.closest(".paintfield").querySelector(HEADER_TITLE),
      control: (a) => a.closest(".paintfield").querySelector(HEADER_ICON),
      guide: (a) => a.parentElement },
    { name: "compound children", match: (a) => a.classList.contains("compound-children"),
      parent: (a) => a.previousElementSibling?.querySelector(".label"),
      control: (a) => a.previousElementSibling?.querySelector(".compound-twisty"),
      guide: (a) => a },
    { name: "interp strip", match: (a) => a.classList.contains("interp-strip"),
      parent: (a) => a.previousElementSibling?.querySelector(".label"),
      control: (a) => a.previousElementSibling?.querySelector(".interp-btn"),
      guide: (a) => a },
    { name: "row editor",
      match: (a) => !!a.parentElement?.matches(".inspector .row") && getComputedStyle(a).gridRowStart === "2",
      parent: (a) => a.parentElement.querySelector(".label"),
      control: (a) => a.parentElement.querySelector(".compound-twisty, .interp-btn"),
      guide: (a) => a },
    { name: "section", root: true,
      match: (a) => a.classList.contains("cat-rows") && !!a.parentElement?.classList.contains("prop-category"),
      parent: (a) => a.parentElement.querySelector(":scope > .cat-header-row .cat-title, :scope > .cat-header .cat-title") },
  ];
  const text = (el) => (el.textContent || el.className).trim().replace(/\s+/g, " ").slice(0, 40);
  const visible = (el) => el.getBoundingClientRect().width > 0;
  const labels = [...inspector.querySelectorAll(
    ".label, .cat-title, .paint-sub-label, .list-index, .list-field-label, .paint-type-tabs, .multipoint-actions, .gradient-presets-toggle",
  )].filter(visible).filter((el) => !el.closest(".inspector-head"))
    // A top-level SECTION title is the tree's root: it has no parent to be right of.
    .filter((el) => !el.closest(".prop-category > .cat-header, .prop-category > .cat-header-row"));
  const pairs = [];
  const unclassified = [];
  const guides = new Map();
  for (const lbl of labels) {
    let found = null;
    for (let a = lbl.parentElement; a && a !== inspector && !found; a = a.parentElement) {
      const d = DEVICES.find((dev) => dev.match(a, lbl));
      if (d) found = { d, a };
    }
    if (!found) { unclassified.push(text(lbl)); continue; }
    const { d, a } = found;
    const p = d.parent(a);
    if (!p) { unclassified.push(`${text(lbl)} (device "${d.name}" found no parent label)`); continue; }
    const c = lbl.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const box = d.belowBox ? d.belowBox(lbl).getBoundingClientRect() : c;
    pairs.push({ device: d.name, root: !!d.root, child: text(lbl), cx: c.left, parent: text(p), px: pr.left, below: box.top >= pr.bottom - eps, key: `${d.name}|${pr.left}|${pr.top}` });
    if (d.guide && !guides.has(a)) {
      const g = d.guide(a);
      const ctl = d.control(a);
      const cs = getComputedStyle(g);
      guides.set(a, ctl ? {
        device: d.name, parent: text(p),
        painted: cs.backgroundImage.includes("gradient"),
        guideX: g.getBoundingClientRect().left + parseFloat(cs.backgroundPositionX),
        ctlL: ctl.getBoundingClientRect().left, ctlR: ctl.getBoundingClientRect().right,
      } : { device: d.name, parent: text(p), noControl: true });
    }
  }
  return JSON.stringify({ step, pairs, guides: [...guides.values()], unclassified });
}

/**
 * Pure function. The law's violations in one measurement.
 *
 * @param {{step:number, pairs:object[], guides:object[], unclassified:string[]}} m
 * @param {string} scenario - Name used in each message.
 * @returns {{failures:string[], devices:Set<string>}} Messages, and the non-root
 *   devices that had at least one nested line to check.
 *
 * @example
 * // lawViolations({step: 15, guides: [], unclassified: [], pairs: [
 * //   {device: "list body", root: false, child: "1", cx: 90, parent: "3 sources", px: 68, below: true, key: "k"}]}, "s")
 * // → {failures: ['s: "list body" under "3 sources" — first nested column is 22.0px right, the step is 15px'], devices: Set{"list body"}}
 */
function lawViolations(m, scenario) {
  const failures = m.unclassified.map((t) => `${scenario}: label "${t}" belongs to no known nesting device`);
  const groups = new Map();
  for (const p of m.pairs) {
    if (!(p.cx > p.px + EPS))
      failures.push(`${scenario}: "${p.child}" at ${p.cx.toFixed(1)} is not right of its parent "${p.parent}" at ${p.px.toFixed(1)} (${p.device})`);
    if (!p.root && p.below) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
  }
  const devices = new Set();
  for (const group of groups.values()) {
    const first = Math.min(...group.map((p) => p.cx));
    const offset = first - group[0].px;
    devices.add(group[0].device);
    if (Math.abs(offset - m.step) > EPS)
      failures.push(`${scenario}: "${group[0].device}" under "${group[0].parent}" — first nested column is ${offset.toFixed(1)}px right, the step is ${m.step}px`);
  }
  for (const g of m.guides) {
    if (g.noControl) continue;
    if (!g.painted) failures.push(`${scenario}: "${g.device}" under "${g.parent}" paints no guide`);
    else if (g.guideX < g.ctlL - GUIDE_SLOP || g.guideX > g.ctlR + GUIDE_SLOP)
      failures.push(`${scenario}: "${g.device}" under "${g.parent}" — guide at ${g.guideX.toFixed(1)} is not under its opening control [${g.ctlL.toFixed(1)}, ${g.ctlR.toFixed(1)}]`);
  }
  return { failures, devices };
}

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();
const failures = [];
const errors = [];
const exercised = new Set();
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => { localStorage.clear(); localStorage.setItem("powerrp.autosave", json); }, demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });
  await settle();

  /** Command. Measures the panel, records violations, and screenshots the
   *  Inspector scrolled to `anchor`. */
  const check = async (scenario, anchor) => {
    const m = JSON.parse(await page.evaluate(measure, EPS));
    const { failures: f, devices } = lawViolations(m, scenario);
    failures.push(...f);
    for (const d of devices) exercised.add(d);
    console.log(`${scenario}: ${m.pairs.length} label pairs, ${m.guides.length} guides, step ${m.step}px, nested levels: ${[...devices].join(", ")}`);
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" }), anchor);
    await page.mouse.move(0, 0);
    await settle();
    const clip = await page.evaluate(() => {
      const r = document.querySelector(".inspector").getBoundingClientRect();
      return { x: r.left, y: Math.max(0, r.top), width: r.width, height: Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top) };
    });
    await page.screenshot({ path: resolve(shots, `${scenario}.png`), clip });
  };

  const rect = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    return id;
  });
  if (!rect) throw new Error("the demo deck has no rect to inspect");
  await settle();

  // 1. Multipoint fill (sources → source → nodes/colours → wrapped node fields),
  //    a linear stroke with dither (ramp list + sub-rows), an open compound, an
  //    open interp strip.
  await page.click('[aria-label="Fill: multipointGradient"]');
  await settle();
  await page.click('[aria-label="Fill: add curve source"]');
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "stroke"], {
      type: "linearGradient", ditherMode: "bayer", ditherEmphasis: 1,
      linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
    }]]);
    app.commitPreview();
    const rowOf = (label) => [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent.trim() === label);
    rowOf("Position")?.querySelector(".compound-twisty")?.click();
    rowOf("Opacity")?.querySelector(".interp-btn")?.click();
  }, rect);
  await settle();
  await check("multipoint_stroke_compound_interp", ".multipoint-field");

  // 2. Material knob accordions: a fill material, and a stroke material whose
  //    `stops` knob mounts a list INSIDE the knob rows.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "fill"], { type: "material", material: { id: "atmosphere", params: {} } }],
      [["items", id, "stroke"], { type: "material", material: { id: "alongGradient", params: {
        stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }],
      } } }],
    ]);
    app.commitPreview();
  }, rect);
  await settle();
  await check("material_knobs", ".paint-knob-rows");

  // 3. An Inspector LIST row: a polygon's points.
  await page.evaluate(() => { const app = window.__powerrp_app; app.addItem(app.registry.get("polygon").defaults); });
  await settle();
  await check("polygon_points", ".row-list");

  for (const d of REQUIRED_DEVICES)
    if (!exercised.has(d)) failures.push(`no scenario exercised a nested "${d}" level — the probe would pass vacuously for it`);
  if (errors.length) failures.push(`browser errors:\n  ${errors.join("\n  ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`inspector_indent_probe FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`inspector_indent_probe: OK — ${REQUIRED_DEVICES.length} nesting devices obey the law. Shots: ${shots}`);
