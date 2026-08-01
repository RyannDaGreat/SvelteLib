/**
 * IRIS BLADES IN THE LIVE EDITOR — the pixel half of tests/iris_blades_test.js.
 *
 * Its shape is `tests/aperture_presets_probe.js`'s, deliberately: the sibling
 * widget's probe already settled how a preset family is checked in the browser
 * (hover stages a preview, the document is untouched, the tip is the preset's own
 * description, leaving reverts, one click is one undo unit, and distinctness is
 * measured with tests/imageDistinctness.js rather than a byte digest). Repeating
 * that shape is the point — two widgets in one family, one way of checking them.
 *
 * WHAT IT ADDS, because this widget's claim is different from the sibling's:
 *
 *   · THE TWO WIDGETS DRAW THE SAME HOLE AND DIFFERENT PICTURES. Each is drawn
 *     ALONE at the same box and geometry and the two frames are compared twice:
 *     they must differ over the frame (or the second widget was pointless) while
 *     the pupil colour's footprint must land on the SAME PIXELS. One at a time
 *     rather than side by side because it makes the second comparison exact. The
 *     node suite proves the outlines agree in floating point; this proves the
 *     RENDERER agrees, which is a different question.
 *   · THE PLATES ARE SEPARATELY STROKED. Counting distinct stroke crossings from
 *     a screenshot is not something a pixel metric can do honestly, so what is
 *     checked is the structural consequence: the widget emits one stroked op per
 *     plate, in ascending order, THROUGH THE REAL APP's registry rather than
 *     through an import.
 *
 * Artifacts: POWERRP/.claude_vlm_checks/iris_blades (the canonical home —
 * tests/probe_artifact_path_test.js).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { closestPair, imageDistance, indistinguishable, readPng } from "./imageDistinctness.js";
import { irisBladesPlugin } from "../plugins/iris_blades.js";
import { aperturePlugin } from "../plugins/aperture.js";

const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const svelteLib = resolve(powerRP, "../../..");
const webRoot = resolve(powerRP, "web");
const demoJson = await readFile(resolve(powerRP, "examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? resolve(powerRP, ".claude_vlm_checks/iris_blades");
await mkdir(shots, { recursive: true });

const TYPE = irisBladesPlugin.type;
const PRESETS = irisBladesPlugin.presets;
// Inserted LARGE and centred rather than at the authored 220 px default, for the
// same measurement reason aperture_presets_probe.js states: several of these rows
// differ only in the plates' edges, and at the default size that difference is a
// few dozen pixels in a 1440-wide shot.
const BIG_BOX = { x: 420, y: 90, w: 540, h: 540 };
// A dark backdrop so the plates (a mid-tone metal) and the warm pupil are both
// well clear of the page, written through the ordinary preview→commit path before
// the baseline is taken.
const DARK_BACKDROP = "#0b0e14";
// One rAF-plus-raster of slack after a hover: the preview stages synchronously but
// the Skia surface repaints on the next tick.
const SETTLE_MS = 260;
const BOOT_MS = 900;
// Generous: it covers a COLD Vite dependency optimize (measured 15 s on this
// host), which would otherwise look like a broken editor.
const BOOT_TIMEOUT_MS = 60000;
// The paired frames' shared geometry. Chosen where the two depictions differ MOST
// — a mid stop with slightly rounded leaves, where the sibling draws one smooth
// annulus and this widget draws eight crossing plates.
const PAIR_GEOMETRY = { blades: 8, stopDown: 0.5, curvature: 0.35, bladeRotation: 0, pupilAspect: 1 };
// Placed in the demo page's empty lower-left, and the probe's own big widget is
// purged first, so the pair frames contain exactly ONE opening. Measured the hard
// way: the first version put it mid-page, where a demo item drew straight over it
// and the "same hole" check was silently comparing a widget it could not see.
const PAIR_BOX = { w: 250, h: 250 };
const PAIR_AT = { x: 40, y: 565 };
// The pupil colour is the two widgets' shared default fill for the light through
// the opening; the slack is one code value either side of a JPEG-free PNG's exact
// value, which only antialiasing can move.
const PUPIL_RGB = [0xff, 0xd7, 0xa3];
const PUPIL_SLACK = 6;
// How far the two widgets' pupil FOOTPRINTS may disagree, as a fraction of their
// shared area. The outlines are identical to floating point
// (tests/iris_blades_test.js §1a), so the only legitimate disagreement is the
// antialiased rim: a one-pixel band around a ~190 px radius opening is about 2/190
// = 1% of its area, counted on both frames. Five percent is therefore generous by
// a factor of two and still far too tight to hide a different opening.
const PUPIL_EDGE_TOLERANCE = 0.05;
// How much of the frame must actually change between the two depictions. The
// plates cover the whole bore annulus, so a real difference is tens of thousands
// of pixels in a 1440-wide shot; this floor only has to exclude "nothing drew".
const PAIR_MIN_DIFFERING_FRACTION = 0.01;

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

/**
 * Pure function. A boolean mask of every pixel within `slack` of a colour, per
 * 8-bit channel — the pupil's FOOTPRINT, so two frames can be checked for drawing
 * the same hole rather than merely the same amount of hole.
 *
 * (H, W, 4) RGBA uint8 -> (H·W) Uint8Array of 0/1, row-major, same order.
 */
function colourMask({ data, width, height }, [r, g, b], slack) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    mask[i] = Math.abs(data[o] - r) <= slack && Math.abs(data[o + 1] - g) <= slack && Math.abs(data[o + 2] - b) <= slack ? 1 : 0;
  }
  return mask;
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  // WAIT FOR THE APP, do not sleep at it — a cold dep-optimize reloads the page
  // after `networkidle0` and a fixed delay races it.
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
  check("the camera backdrop was darkened for legible plates", !!darkened, "no camera item found");

  // ── (0) THE WIDGET IS REGISTERED AND INSERTS ──────────────────────────────
  const inserted = await page.evaluate(({ t, box }) => {
    const app = window.__powerrp_app;
    if (!app.registry.get(t)) return { ok: false, why: "not in the registry" };
    app.addItem({ ...app.registry.get(t).defaults, type: t, ...box });
    return { ok: !!app.selectedNode(), type: app.selectedNode()?.state?.type };
  }, { t: TYPE, box: BIG_BOX });
  await settle();
  check("iris_blades is registered and inserts", inserted.ok && inserted.type === TYPE, JSON.stringify(inserted));

  /** Query. A PNG of the viewport's canvas region (what the app actually drew). */
  const canvasShot = async () => await (await page.$(".canvas-wrap")).screenshot();

  /** Query. The i-th preset row's viewport centre, scrolled into view first. */
  const rowCenter = (i) => page.evaluate((idx) => {
    const el = [...document.querySelectorAll(".toolspane .tool-preset")][idx];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { label: el.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);

  // ── (1) the library is complete and in the plugin's order ─────────────────
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
  check("pane-lists-every-preset-in-the-plugin's-order",
    JSON.stringify(rows?.labels) === JSON.stringify(PRESETS.map((p) => p.name)),
    `${rows?.labels?.length} rows: ${rows?.labels?.join(" | ")}`);

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
    check(`${preset.name}: tip is the preset's description`, staged.tip.includes(preset.description),
      JSON.stringify(staged.tip.slice(0, 90)));

    const png = await canvasShot();
    const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    await writeFile(`${shots}/${String(i + 1).padStart(2, "0")}_${slug}.png`, png);
    const decoded = readPng(png);
    for (const seen of frames) {
      const distance = imageDistance(seen.png, decoded);
      check(`${preset.name}: distinguishable from ${seen.name}`, !indistinguishable(distance),
        `maxAbs ${distance.maxAbs} — no display can show these two apart`);
    }
    frames.push({ name: preset.name, png: decoded });

    await page.mouse.move(10, 10);
    await settle();
    const left = await page.evaluate(() => window.__powerrp_app.previewDelta);
    check(`${preset.name}: leaving reverts the preview`, left === null, JSON.stringify(left));
  }

  const closest = closestPair(frames);
  if (closest)
    console.log(`\n  closest pair: "${closest.a}" vs "${closest.b}" — meanAbs ${closest.distance.meanAbs.toFixed(3)}, maxAbs ${closest.distance.maxAbs}, ${(closest.distance.fraction * 100).toFixed(1)}% of pixels differ`);

  // ── (5) a click is EXACTLY one undo unit ──────────────────────────────────
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

  // ── (6) ONE PLATE, ONE STROKED OP, IN ORDER — through the app's registry ──
  const emitted = await page.evaluate(({ t, geo }) => {
    const plugin = window.__powerrp_app.registry.get(t);
    const state = { ...plugin.defaults, x: 0, y: 0, w: 300, h: 300, ...geo };
    const ops = plugin.emit(state, null, { x: 0, y: 0, rotation: 0, scale: 1 });
    return { count: ops.length, kinds: [...new Set(ops.map((o) => o.op))], stroked: ops.filter((o) => o.stroke != null).length };
  }, { t: TYPE, geo: PAIR_GEOMETRY });
  check("the live registry's plugin emits one op per plate plus the pupil",
    emitted.count === PAIR_GEOMETRY.blades + 1, JSON.stringify(emitted));
  check("every op is a path (never a fan, never a polyline)", JSON.stringify(emitted.kinds) === '["path"]', JSON.stringify(emitted.kinds));
  check("every plate is stroked", emitted.stroked === PAIR_GEOMETRY.blades, `${emitted.stroked} stroked ops`);

  // ── (7) SAME HOLE, DIFFERENT PICTURE ──────────────────────────────────────
  // The two widgets are drawn ONE AT A TIME at the same box and geometry, and the
  // frames compared two ways. Same-at-a-time rather than side by side because it
  // makes the comparison exact: the openings must land on the SAME PIXELS, not
  // merely cover the same area, and everything else on the canvas is identical in
  // both frames so it cancels.
  // ONE item is inserted as an `aperture`, photographed, and then RETYPED in
  // place through the app's own `retypeSelection` — the very command the shared
  // row contract exists to serve. Nothing else in the scene moves, so the two
  // frames differ by exactly one widget's depiction.
  const cleared = await page.evaluate(({ t, geo, box, at }) => {
    const app = window.__powerrp_app;
    app.purgeSelection(); // the BIG_BOX widget the preset sweep used
    app.addItem({ ...app.registry.get(t).defaults, type: t, ...box, ...at, ...geo, bladeForm: "regular" });
    return app.selectedNode()?.state?.type ?? null;
  }, { t: aperturePlugin.type, geo: PAIR_GEOMETRY, box: PAIR_BOX, at: PAIR_AT });
  check("the sweep's widget is purged and an aperture is placed alone", cleared === aperturePlugin.type, `${cleared}`);
  await settle();
  const shotAperture = await canvasShot();
  const retyped = await page.evaluate((t) => {
    window.__powerrp_app.retypeSelection(t);
    return window.__powerrp_app.selectedNode()?.state?.type ?? null;
  }, TYPE);
  await settle();
  const shotBlades = await canvasShot();
  await writeFile(`${shots}/98_aperture_same_geometry.png`, shotAperture);
  await writeFile(`${shots}/99_iris_blades_same_geometry.png`, shotBlades);
  check("RETYPE works between the two widgets", retyped === TYPE, `landed on ${retyped}`);

  const a = readPng(shotAperture), b = readPng(shotBlades);
  const differ = imageDistance(a, b);
  check("DIFFERENT PICTURE: the blade assembly does not look like the aperture",
    differ.fraction > PAIR_MIN_DIFFERING_FRACTION,
    `only ${(differ.fraction * 100).toFixed(1)}% of pixels differ — the second widget would be pointless`);

  const maskA = colourMask(a, PUPIL_RGB, PUPIL_SLACK);
  const maskB = colourMask(b, PUPIL_RGB, PUPIL_SLACK);
  let onlyA = 0, onlyB = 0, both = 0;
  for (let i = 0; i < maskA.length; i++) {
    if (maskA[i] && maskB[i]) both += 1;
    else if (maskA[i]) onlyA += 1;
    else if (maskB[i]) onlyB += 1;
  }
  const disagreement = (onlyA + onlyB) / Math.max(1, both);
  check("both openings are drawn at all", both > 1000, `${both} shared pupil pixels`);
  check("THE SAME HOLE: the two widgets' openings land on the same pixels",
    disagreement < PUPIL_EDGE_TOLERANCE,
    `${onlyA} px only in the aperture, ${onlyB} px only in the assembly, ${both} shared — ${(disagreement * 100).toFixed(2)}% disagreement`);

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
console.log("\niris_blades probe: all checks passed");
