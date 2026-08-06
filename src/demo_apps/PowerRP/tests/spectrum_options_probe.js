/**
 * SPECTROGRAM OPTIONS probe (R7-19) — boots the REAL editor headless, inserts an
 * Audio Spectrum node, and reads its Inspector.
 *
 * WHAT IT PROVES, and why only this:
 *
 *   THE ROWS EXIST AS CONTROLS, not merely as declarations. The house law is "NO
 *   JSON-ONLY PROPERTIES" — every option needs an Inspector surface — and a
 *   node-side test can only assert that `plugin.inspector` LISTS a row. That a
 *   row survives the Inspector's own filtering and renders an editor is a
 *   different claim, and this is where it is measured.
 *
 *   THE COLOUR MAP IS THE SHARED RAMP CONTROL. Its stop list is the general list
 *   field with the SAME preset library a gradient fill and a Mandelbrot palette
 *   get — that is the whole point of `colors` being `bundle("ramp")` rather than
 *   a colormap type, and it is checkable here: the library's toggle is present
 *   inside the node's own Inspector, and it lists the colour-map family.
 *
 *   PICKING A MAP WRITES THE WHOLE RAMP VALUE. Its stops AND its aspects land, so
 *   a map published for OKLab is read in OKLab. (The DRAWING under two ramps is
 *   proven at the display-list level instead — a live spectrogram needs a running
 *   AudioContext, which a headless page has no gesture to start.)
 *
 * NOT PROVEN HERE, deliberately: the waterfall's pixels. See
 * .frenzy/round7/w3s/pixel_proof.mjs, which drives the real DSP, the real ring
 * and the real display list.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/spectrum_options_probe.js
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { analysisDisplayRows } from "../core/analysis_display.js";
import { AUDIO_CAT, audioKnobRows } from "../core/audio_nodes.js";
import { SPECTRUM_SPEC } from "../core/audio_specs.js";
import { SEQUENTIAL_RAMPS } from "../core/ramps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

// hmr: false — a sibling agent's save mid-run would reload the page and destroy
// the execution context (tests/list_ui_probe.js's measured reason).
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(url, { waitUntil: "networkidle0" });
  await settle(700);

  const jsonEval = (fn, ...args) => page.evaluate(fn, ...args).then((s) => JSON.parse(s));

  // ── Insert the node under test ──────────────────────────────────────────────
  const id = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("audio_spectrum").defaults);
    return app.selection;
  });
  await settle(400);
  ok(typeof id === "string" && id.length > 0, `an Audio Spectrum node was inserted (${id})`);

  // ── (1) EVERY DECLARED ROW RENDERS ──────────────────────────────────────────
  // The expectation is DERIVED from the declaration, not typed out here: a list
  // of labels in a probe is the hand-maintained mirror this codebase names as its
  // worst defect, and it would go stale the first time a row is added.
  const expected = [
    ...audioKnobRows(SPECTRUM_SPEC),
    ...analysisDisplayRows(SPECTRUM_SPEC.overlay, AUDIO_CAT),
  ].map((r) => r.label);
  const labels = await jsonEval(() => JSON.stringify(
    [...document.querySelectorAll(".inspector .row .label")].map((e) => e.textContent.trim()),
  ));
  const missing = expected.filter((l) => !labels.includes(l));
  ok(missing.length === 0, `every declared spectrum row renders a control (missing: ${JSON.stringify(missing)})`);
  // TEN: the two measurement knobs (bins, window) plus the eight display rows —
  // the shared ramp bundle is FOUR of them (stops, loop, space, phase), which is
  // exactly what reusing the ramp property rather than inventing a colormap type
  // buys. Pinned as a number so a row silently disappearing is a red rather than
  // a shorter list nobody notices.
  ok(expected.length === 10, `all ten R7-19 rows are declared, not fewer (${expected.length}: ${expected.join(", ")})`);

  // ── (2) THEY ARE ONE GROUP, not scattered among the universal rows ──────────
  const grouped = await jsonEval((wanted) => {
    const sections = [...document.querySelectorAll(".inspector .prop-category")];
    const has = sections.map((s) => [...s.querySelectorAll(".row .label")].map((e) => e.textContent.trim()));
    return JSON.stringify(has.filter((rows) => wanted.some((w) => rows.includes(w))).length);
  }, expected);
  ok(grouped === 1, `the display controls and the knobs are ONE collapsible group, not ${grouped}`);

  // ── (3) THE COLOUR MAP IS THE SHARED RAMP CONTROL ───────────────────────────
  const library = await jsonEval(() => {
    const toggle = document.querySelector(".inspector .gradient-presets-toggle");
    if (!toggle) return JSON.stringify(null);
    toggle.scrollIntoView({ block: "center" });
    toggle.click();
    return JSON.stringify(true);
  });
  ok(library === true, "the node's own Inspector mounts the SHARED preset library above its stop list");
  await settle(400);
  const families = await jsonEval(() => JSON.stringify(
    [...document.querySelectorAll(".gradient-presets-family")].map((e) => e.textContent.trim()),
  ));
  ok(families.some((f) => /Colour maps/i.test(f)),
    `the colour maps are offered here, from the same library a gradient fill uses (${JSON.stringify(families)})`);

  // ── (4) PICKING A MAP LANDS THE WHOLE RAMP VALUE ────────────────────────────
  // GREYSCALE, not viridis: the node is BORN with magma, which is already OKLab
  // and clamped, so picking another OKLab map would let a broken aspect write
  // pass. Greyscale differs from the default in stop count AND in space, so both
  // halves of "a preset is a whole ramp value" are observable.
  const target = SEQUENTIAL_RAMPS.greyscale;
  const picked = await page.evaluate((name) => {
    const swatch = [...document.querySelectorAll(".gradient-swatch")].find((e) => (e.getAttribute("aria-label") ?? "").includes(name));
    if (!swatch) return false;
    swatch.scrollIntoView({ block: "center" });
    swatch.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    swatch.click();
    return true;
  }, target.label);
  ok(picked, `the "${target.label}" swatch is reachable in the grid`);
  await settle(400);
  const landed = await jsonEval((itemId) => {
    const s = window.__powerrp_app.state().items?.[itemId] ?? {};
    return JSON.stringify({ stops: s.rampStops, loop: s.rampLoop, space: s.rampSpace });
  }, id);
  ok(landed.stops?.length === target.stops.length && landed.stops[0].color === target.stops[0].color,
    `picking a colour map wrote its stops (${landed.stops?.length} stops, first ${landed.stops?.[0]?.color})`);
  ok(landed.space === target.space && landed.loop === target.loop,
    `...and its ASPECTS travelled with it (space=${landed.space}, loop=${landed.loop}; the node was born "oklab") — a map read in the wrong space is a different map`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok " : "NOT OK"} ${label}`);
console.log(`\n${checks.filter(([p]) => p).length}/${checks.length} spectrum-options checks passed`);
for (const e of errors) console.log(e);
process.exit(errors.length ? 1 : 0);
