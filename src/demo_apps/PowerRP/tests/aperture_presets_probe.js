/**
 * APERTURE PRESET LIBRARY probe (R6-17.1 / R6-3.4) — proves in the BOOTED EDITOR
 * that every lens the table models really draws, really draws something no other
 * row draws, and really explains itself.
 *
 * Run from anywhere (paths resolve off import.meta.url, never the cwd):
 *   node src/demo_apps/PowerRP/tests/aperture_presets_probe.js [shot_dir]
 *
 * SHAPE COPIED FROM tests/lens_flare_presets_probe.js, per R6-3.13's instruction
 * that every future preset family copy that probe — server with HMR off, the real
 * hover→preview→commit path, four checks. ONE DELIBERATE DEPARTURE: the metric.
 * That probe compares a sha256 of the PNG BYTES, which is exact identity and
 * therefore passes any pair differing by one least-significant bit;
 * tests/imageDistinctness.js exists precisely because copying the probe kept
 * copying that. This is its second consumer, and it also lets the probe REPORT
 * THE NARROWEST MARGIN in the table rather than a bare pass/fail — so an author
 * can see two lenses converging before they collide.
 *
 * The checks, each a rendered fact:
 *   (1) THE LIBRARY IS COMPLETE AND ORDERED — the pane's rows are exactly the
 *       plugin's presets, in the plugin's order (the table runs by blade count,
 *       so the order is content).
 *   (2) EVERY ROW EXPLAINS ITSELF — each tip is the preset's own `description`,
 *       which is where the lens is named and therefore where the claim is
 *       checkable, not ToolsPane's generic fallback.
 *   (3) EVERY PRESET RENDERS, DISTINGUISHABLY — hovering repaints, and all N
 *       previews plus the un-hovered baseline are pairwise distinguishable to a
 *       display. Two names on one picture is the failure R6-3.12(b) is about.
 *   (4) PREVIEW IS FREE, COMMIT COSTS ONE UNDO.
 *   (5) THE PARITY LAW SURVIVES THE ROUND TRIP — with the sunstar turned on
 *       through the real write path, the committed document's blade count and the
 *       ray count the widget draws still satisfy core/optics.starburstRayCount.
 *       A law that only holds in a unit test is not a law the app obeys.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { closestPair, imageDistance, indistinguishable, readPng } from "./imageDistinctness.js";
import { aperturePlugin } from "../plugins/aperture.js";
import { starburstRayCount } from "../core/optics.js";

const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const svelteLib = resolve(powerRP, "../../..");
const webRoot = resolve(powerRP, "web");
const demoJson = await readFile(resolve(powerRP, "examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? resolve(powerRP, ".claude_vlm_checks/aperture_presets");
await mkdir(shots, { recursive: true });

const APERTURE_TYPE = aperturePlugin.type;
const PRESETS = aperturePlugin.presets;
// The iris is inserted LARGE and centred rather than at its authored default box.
// This is a measurement decision, not a look one: several of these lenses differ
// only in the shape of the opening's edge (a rounded 14-gon against a rounded
// heptagon), and at the default 220 px that difference is a few dozen pixels in a
// 1440-wide shot — the probe would then be reporting the framing's insensitivity
// rather than the table's distinctness. toolspane_probe.js overrides the box for
// the mirror-image reason.
const BIG_BOX = { x: 420, y: 90, w: 540, h: 540 };
// A dark backdrop so the diaphragm body (a mid-tone metal) and the warm pupil are
// both well clear of the page. Written through the ordinary setPreview →
// commitPreview path BEFORE the baseline is taken, so it is not part of what the
// preview checks measure — the lens-flare probe's precedent exactly.
const DARK_BACKDROP = "#0b0e14";
// ToolsPane.svelte's tip when a preset declares no description — the string check
// (2) must NOT see. Reported as the diagnosis, never asserted on.
const GENERIC_TIP = (name) => `Apply the ${name} preset to the current frame`;
// One rAF-plus-raster of slack after a hover: the preview stages synchronously but
// the Skia surface repaints on the next tick.
const SETTLE_MS = 260;
const BOOT_MS = 900;
// How long the app itself is allowed to appear. Generous because it covers a COLD
// Vite dependency optimize (measured 15 s on this host), which happens once per
// config change and would otherwise look like a broken editor.
const BOOT_TIMEOUT_MS = 60000;
// The blade count check (5) is run at ONE odd count, because odd is the case the
// parity law is ABOUT — an even count would pass even if the doubling were gone.
const PARITY_PROBE_BLADES = 9;
const PARITY_PROBE_SUNSTAR = 0.9;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  root: webRoot,
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;

const browser = await launchBrowser();
const failures = [];
const errors = [];
/** Command. Records one check's outcome and prints it. */
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  // WAIT FOR THE APP, do not sleep at it. A cold Vite dep-optimize reloads the
  // page after `networkidle0`, so a fixed delay races it and the probe dies on
  // `window.__powerrp_app` being undefined — a failure that reads exactly like a
  // broken app and is not one (measured on this host, 2026-08-01: the optimize
  // took 15 s). The fixed settle below is still right for a REPAINT, which is one
  // tick; only the boot needed a condition.
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  await new Promise((r) => setTimeout(r, BOOT_MS));
  const bootErrors = errors.length; // baseline: in-flight WIP noise from siblings

  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  const darkened = await page.evaluate((bg) => {
    const app = window.__powerrp_app;
    const camera = app.cameraState()?.id ?? null;
    if (!camera) return null;
    app.setPreview([[["items", camera, "background"], bg]]);
    app.commitPreview();
    return camera;
  }, DARK_BACKDROP);
  check("the camera backdrop was darkened for a legible iris", !!darkened, "no camera item found");

  const inserted = await page.evaluate(({ t, box }) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(t).defaults, type: t, ...box });
    return !!app.selectedNode();
  }, { t: APERTURE_TYPE, box: BIG_BOX });
  await settle();
  check("an-aperture-is-selected", inserted);

  // ── (1) the library is complete and in the plugin's order ──────────────────
  const rows = await page.evaluate(() => {
    const groups = [...document.querySelectorAll(".toolspane .prop-category")];
    const g = groups.find((x) => x.querySelector(".cat-rows .tool-preset"));
    if (!g) return null;
    return {
      title: g.querySelector(".cat-title")?.textContent?.trim(),
      labels: [...g.querySelectorAll(".cat-rows .tool-preset")].map((b) => b.textContent.trim()),
    };
  });
  check("a-preset-group-is-rendered", !!rows);
  check("preset-group-is-titled-Presets", rows?.title === "Presets", rows?.title);
  check("pane-lists-every-preset-in-the-plugin's-order",
    JSON.stringify(rows?.labels) === JSON.stringify(PRESETS.map((p) => p.name)),
    `${rows?.labels?.length} rows: ${rows?.labels?.join(" | ")}`);

  /** Query. The i-th preset row's viewport centre, scrolled into view first. */
  const rowCenter = (i) => page.evaluate((idx) => {
    const el = [...document.querySelectorAll(".toolspane .tool-preset")][idx];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { label: el.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);

  /** Query. A PNG of the viewport's canvas region (what the preview actually drew). */
  const canvasShot = async () => {
    const el = await page.$(".canvas-wrap");
    return await el.screenshot();
  };

  const docBefore = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const baseline = await canvasShot();
  await writeFile(`${shots}/00_defaults.png`, baseline);
  const frames = [{ name: "(widget defaults, no preview)", png: readPng(baseline) }];

  // ── (2)(3)(4) sweep EVERY row ─────────────────────────────────────────────
  for (let i = 0; i < PRESETS.length; i++) {
    const preset = PRESETS[i];
    const row = await rowCenter(i);
    check(`row-${i}-is-present`, !!row, preset.name);
    if (!row) continue;
    await page.mouse.move(row.x, row.y);
    await settle();

    const staged = await page.evaluate(() => ({
      preview: window.__powerrp_app.previewDelta,
      doc: JSON.stringify(window.__powerrp_app.doc),
      tip: document.querySelector(".tt-tip")?.textContent ?? "",
    }));
    check(`${preset.name}: hover stages a preview`, !!staged.preview);
    check(`${preset.name}: hover leaves the document untouched`, staged.doc === docBefore);
    check(`${preset.name}: tip is the preset's description`,
      staged.tip.includes(preset.description ?? "\0"),
      staged.tip === GENERIC_TIP(preset.name) ? "showing ToolsPane's generic fallback — the preset declares no description" : JSON.stringify(staged.tip.slice(0, 90)));

    const png = await canvasShot();
    const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    await writeFile(`${shots}/${String(i + 1).padStart(2, "0")}_${slug}.png`, png);
    const decoded = readPng(png);
    // (3) DISTINGUISHABLE — against every frame already taken, not just the
    // previous one, and by the shared metric rather than a byte digest.
    for (const seen of frames) {
      const distance = imageDistance(seen.png, decoded);
      check(`${preset.name}: distinguishable from ${seen.name}`, !indistinguishable(distance),
        `maxAbs ${distance.maxAbs} — no display can show these two apart`);
    }
    frames.push({ name: preset.name, png: decoded });

    // (4) Leaving reverts, with no document change either way.
    await page.mouse.move(10, 10);
    await settle();
    const left = await page.evaluate(() => ({
      preview: window.__powerrp_app.previewDelta,
      doc: JSON.stringify(window.__powerrp_app.doc),
    }));
    check(`${preset.name}: leaving reverts the preview`, left.preview === null, JSON.stringify(left.preview));
    check(`${preset.name}: still no document change after revert`, left.doc === docBefore);
  }

  // THE NARROWEST MARGIN IN THE TABLE — reported, not asserted. The bound above
  // is the only one derivable without judgement; this number is what tells an
  // author which two lenses are converging.
  const closest = closestPair(frames);
  if (closest)
    console.log(`\n  closest pair: "${closest.a}" vs "${closest.b}" — meanAbs ${closest.distance.meanAbs.toFixed(3)}, maxAbs ${closest.distance.maxAbs}, ${(closest.distance.fraction * 100).toFixed(1)}% of pixels differ`);

  // ── (4b) a click is EXACTLY one undo unit ─────────────────────────────────
  const last = await rowCenter(PRESETS.length - 1);
  await page.mouse.move(last.x, last.y);
  await settle();
  await page.mouse.click(last.x, last.y);
  await settle();
  const committed = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  check("click commits a change", committed !== docBefore);
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  check("one undo fully reverts the pick",
    (await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc))) === docBefore);

  // ── (5) THE PARITY LAW, IN THE LIVE APP ───────────────────────────────────
  // Written through the real path, then read back off the DOCUMENT: the count the
  // widget renders must be the one the shared law derives, at an ODD blade count.
  const parity = await page.evaluate(({ blades, sunstar }) => {
    const app = window.__powerrp_app;
    const id = app.selectedNode()?.id;
    if (!id) return null;
    app.setPreview([[["items", id, "blades"], blades], [["items", id, "sunstar"], sunstar]]);
    app.commitPreview();
    const node = app.selectedNode();
    const ops = app.registry.get(node.state.type).emit(node.state, null, node.world);
    const star = ops[ops.length - 1];
    return { blades: node.state.blades, subpaths: (star.d.match(/M/g) ?? []).length };
  }, { blades: PARITY_PROBE_BLADES, sunstar: PARITY_PROBE_SUNSTAR });
  check("the parity probe could write the document", !!parity);
  check(`an odd blade count still draws 2N rays in the live app`,
    parity?.blades === PARITY_PROBE_BLADES && parity?.subpaths === starburstRayCount(PARITY_PROBE_BLADES),
    `blades ${parity?.blades} drew ${parity?.subpaths} rays; the law says ${starburstRayCount(PARITY_PROBE_BLADES)}`);
  await settle();
  await writeFile(`${shots}/99_parity_sunstar.png`, await canvasShot());

  const newErrors = errors.slice(bootErrors);
  check("no new console errors", newErrors.length === 0, newErrors.join(" | "));
  console.log(`\n  ${PRESETS.length} presets rendered; shots in ${shots.replace(svelteLib, ".")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\naperture preset probe: all checks passed");
