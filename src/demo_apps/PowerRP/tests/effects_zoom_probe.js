/**
 * EFFECTS-UNDER-ZOOM pixel probe (manifest 15.3 "SHADOWS BROKEN UNDER ZOOM").
 * The 14.7 lesson VERBATIM: a perf/visual probe MUST run at realistic
 * scale/zoom — the committed effects_probe.js runs only at zoom 1 dpr 1, and
 * that toy scale is exactly what hid this bug. Here the user's own scenario (an
 * ellipse with a SOFT drop shadow, their clipboard values dx 3 / dy 3 /
 * blur 21 / opacity 1) renders through the REAL GPU compositor at a retina
 * present surface across FOUR views:
 *
 *   - z1   (zoom 1): whole item + shadow visible.
 *   - z8   (zoom 8): "zoom in hard" — the item's bottom-right EDGE + its soft
 *          shadow band is on screen (the view pans to the shadow corner); the
 *          effect source region exceeds the canvas texture, exercising the
 *          15.3 downscale (the OLD Math.min crop cut the fill + hard-clipped
 *          the shadow into a black blob).
 *   - z8fill (zoom 8, centered): the item DWARFS the screen — asserts the fill
 *          has NO interior hard cliff (a scan across the whole frame is all
 *          fill, never a black-to-white jump at a texture boundary).
 *   - z025 (zoom 0.25): zoomed out — tiny shadow, still soft, no wasted crop.
 *
 * Assertions at the shadow-corner views (z1, z8, z025):
 *   (1) FILL NOT CLIPPED: the item's own fill is present just inside its far
 *       (right/bottom) edge — the screenshot bug erased it with a vertical cliff.
 *   (2) SOFT SHADOW, NO CLIFF: scanning outward across the +dx/+dy shadow band,
 *       the luminance profile is MONOTONE-ish light→dark→light through a
 *       penumbra (intermediate greys exist); a hard fill→background jump with
 *       no greys is the clip artifact and fails.
 *   (3) PENUMBRA SCALES WITH ZOOM: the soft edge's on-screen width (device px)
 *       grows with zoom (a 21-world-unit blur covers ~21·zoom·dpr screen px).
 *
 * Screenshots (full device frame per view, PPM) are written for the record.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/effects_zoom_probe.js [shot_dir]
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const SHOT_DIR = process.argv[2] || join(HERE, "../.claude_shots/effects_zoom");
mkdirSync(SHOT_DIR, { recursive: true });

const { circlePlugin } = await import("../plugins/circle.js");
const { pushTransform, popTransform, rect } = await import("../render_gpu/ir.js");

/** The sceneIR node wrap for a widget state (the effects_probe node() idiom). */
function node(plugin, state) {
  const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
  const local = { ...state, x: 0, y: 0 };
  return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
}

// A realistic retina present surface (14.7: probes at realistic scale). Device
// target = W·dpr × H·dpr = 1400 × 900.
const W = 700, H = 450, DPR = 2;

// The circle plugin emits its ellipse at LOCAL (w/2, h/2) inside a 0..w,0..h
// bbox, so the node's world origin IS the ellipse's TOP-LEFT corner. The
// ellipse thus spans world [X, X+w] × [Y, Y+h].
const ELL = { X: -80, Y: -60, w: 160, h: 120 };
const SHADOW = { dx: 3, dy: 3, blur: 21, color: "#000000", opacity: 1 };
const FILL_RGB = [0x3b, 0x6e, 0xa5]; // #3b6ea5
const scene = [
  rect({ x: -100000, y: -100000, w: 200000, h: 200000, fill: "#ffffff" }), // vast white world bg
  ...node(circlePlugin, {
    ...circlePlugin.defaults,
    x: ELL.X, y: ELL.Y, w: ELL.w, h: ELL.h,
    fill: "#3b6ea5", strokeWidth: 0, shadow: SHADOW,
  }),
];

// Ellipse right-edge MIDPOINT (world) — the ellipse touches its bbox right
// edge here, and the +dx shadow spreads rightward from it. Anchoring THIS at
// screen center keeps the fill edge + its soft shadow horizontally centered and
// on-screen at every zoom (so a horizontal scan through the frame's vertical
// center crosses fill → penumbra → background).
const EDGE_MID = { x: ELL.X + ELL.w, y: ELL.Y + ELL.h / 2 };
const CENTER = { x: ELL.X + ELL.w / 2, y: ELL.Y + ELL.h / 2 };
// The ellipse's TOP-LEFT corner region (manifest 16.1): the LEADING edges,
// OPPOSITE the +dx/+dy offset. Anchoring the top-edge and left-edge midpoints
// at screen center keeps those leading edges + their (should-be-soft) penumbra
// on-screen so a scan outward crosses fill → penumbra → background. The 16.1
// bug clipped these with a straight cliff (the source texture started AT the
// geometry, so the blur that spills up/left had no source texels).
const TOP_MID = { x: ELL.X + ELL.w / 2, y: ELL.Y };
const LEFT_MID = { x: ELL.X, y: ELL.Y + ELL.h / 2 };

// A view that puts a chosen WORLD anchor point at the canvas center at `zoom`.
// panX/panY in CSS px (the compositor multiplies by dpr).
const viewAnchoring = (zoom, anchor) => ({ zoom, panX: W / 2 - anchor.x * zoom, panY: H / 2 - anchor.y * zoom, dpr: DPR });

// Views: the three edge views anchor the ellipse's right-edge midpoint at
// screen center (the far fill edge + rightward soft shadow always visible);
// z8fill centers the whole ellipse to test the interior; the tl* views anchor
// the top/left leading-edge midpoints at zoom 1 AND 8 (16.1 leading-edge
// penumbra — the non-zero dx/dy shadow makes the leading side the STRESSED one).
const VIEWS = {
  z1: viewAnchoring(1, EDGE_MID),
  z8: viewAnchoring(8, EDGE_MID),
  z025: viewAnchoring(0.25, EDGE_MID),
  z8fill: viewAnchoring(8, CENTER),
  tlTop1: viewAnchoring(1, TOP_MID),   tlLeft1: viewAnchoring(1, LEFT_MID),
  tlTop8: viewAnchoring(8, TOP_MID),   tlLeft8: viewAnchoring(8, LEFT_MID),
};
const CORNER_VIEWS = ["z1", "z8", "z025"]; // fill + soft-shadow assertions (offset side)
// Leading-edge (top/left) views: [view, zoom, edge-axis 'top'|'left'].
const LEADING_VIEWS = [
  ["tlTop1", 1, "top"], ["tlLeft1", 1, "left"],
  ["tlTop8", 8, "top"], ["tlLeft8", 8, "left"],
];
const ZOOM_OF = { z1: 1, z8: 8, z025: 0.25, z8fill: 8, tlTop1: 1, tlLeft1: 1, tlTop8: 8, tlLeft8: 8 };

// Pure helper (in-probe): world point → device px under a view.
const w2d = (wx, wy, v) => [(wx * v.zoom + v.panX) * v.dpr, (wy * v.zoom + v.panY) * v.dpr];

let viteServer, browser;
try {
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: join(REPO_ROOT, "vite.config.js"),
    root: REPO_ROOT,
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  const { default: puppeteer } = await import("puppeteer");
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  const pageErrors = [];
  const IGNORE = [/Failed to load resource: the server responded with a status of 404/];
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) pageErrors.push(m.text());
  });
  await page.goto(`${pageBase}/index.html`, { waitUntil: "domcontentloaded" });

  const rendered = await page.evaluate(async (ir, views, w, h, dpr) => {
    const M = { compositor: await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js") };
    const dw = w * dpr, dh = h * dpr;
    const canvas = document.createElement("canvas");
    canvas.width = dw; canvas.height = dh;
    const gpu = await M.compositor.GpuCompositor.create(canvas);
    const out = {};
    for (const [name, view] of Object.entries(views)) {
      gpu.render(ir, view, { background: [1, 1, 1, 1] });
      out[name] = Array.from(await gpu.readPixels(0, 0, dw, dh));
    }
    return { out, dw, dh };
  }, scene, VIEWS, W, H, DPR);

  const { out: framePx, dw, dh } = rendered;

  for (const name of Object.keys(VIEWS)) {
    const px = framePx[name];
    const bytes = Buffer.alloc(dw * dh * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { bytes[j] = px[i]; bytes[j + 1] = px[i + 1]; bytes[j + 2] = px[i + 2]; }
    writeFileSync(join(SHOT_DIR, `effects_zoom_${name}.ppm`), Buffer.concat([Buffer.from(`P6\n${dw} ${dh}\n255\n`, "ascii"), bytes]));
  }

  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const at = (px, x, y) => { const i = (clampI(y, 0, dh - 1) * dw + clampI(x, 0, dw - 1)) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const lum = ([r, g, b]) => (r + g + b) / 3;

  const FILL_LUM = lum(FILL_RGB);       // ~101
  const FILL_LUM_MAX = 175;             // a fill sample must read below this
  const BG_LUM_MIN = 248;               // clean white background
  const SHADOW_DARKEST = 232;           // a soft shadow px is at least this much darker than pure white somewhere

  let checks = 0;
  const ok = (name, cond, detail) => { assert.ok(cond, `${name}: ${detail}`); checks++; console.log(`  ok  ${name}`); };
  const penumbraPx = {}; // per corner-view: device-px width of the right penumbra

  for (const name of CORNER_VIEWS) {
    const px = framePx[name], v = VIEWS[name], zoom = ZOOM_OF[name];
    const [dRx] = w2d(ELL.X + ELL.w, 0, v);         // fill right edge, device x
    const [, dBy] = w2d(0, ELL.Y + ELL.h, v);        // fill bottom edge, device y
    const [cxD, cyD] = w2d(CENTER.x, CENTER.y, v);   // ellipse center, device
    const inset = Math.max(3, Math.round(6 * zoom)); // stay off the AA rim

    // (1) FILL NOT CLIPPED — just inside the right & bottom far edges, on the
    // ellipse's mid axes (guaranteed interior points).
    const fillRight = at(px, Math.round(dRx) - inset, Math.round(cyD));
    const fillBottom = at(px, Math.round(cxD), Math.round(dBy) - inset);
    ok(`${name}: fill NOT clipped at right edge`, lum(fillRight) < FILL_LUM_MAX, `right-edge fill missing (clip bug), got ${fillRight}`);
    ok(`${name}: fill NOT clipped at bottom edge`, lum(fillBottom) < FILL_LUM_MAX, `bottom-edge fill missing (clip bug), got ${fillBottom}`);

    // (2) SOFT SHADOW, NO CLIFF — scan device px OUTWARD to the right starting
    // at the fill's right edge, along the ellipse's vertical center. Classify
    // each px: fill (<FILL_LUM_MAX) / penumbra (between) / background (>BG_LUM_MIN).
    // A correct soft shadow shows a run of penumbra greys between the fill and
    // the background; a clip shows fill→background with NO grey run (or a hard
    // dark cliff then white). Also demand SOME darkening (shadow exists).
    const scan = [];
    const scanLen = Math.ceil((ELL.w * 0.7 + SHADOW.dx + SHADOW.blur * 3) * zoom) + 20;
    for (let k = 0; k < scanLen; k++) scan.push(lum(at(px, Math.round(dRx) + k, Math.round(cyD))));
    // First background index after the fill; penumbra = the grey run before it.
    let firstBg = scan.findIndex((L) => L > BG_LUM_MIN);
    if (firstBg < 0) firstBg = scan.length;
    let penStart = 0; while (penStart < firstBg && scan[penStart] < FILL_LUM_MAX) penStart++;
    const penWidth = firstBg - penStart;                    // device px of grey penumbra
    const greys = scan.slice(penStart, firstBg);
    const darkest = greys.length ? Math.min(...greys) : 255; // most-shadowed grey
    ok(`${name}: right shadow is present (darkens the bg)`, darkest < SHADOW_DARKEST, `no shadow darkening past the fill edge, min grey ${darkest}`);
    ok(`${name}: right shadow is SOFT (penumbra, no cliff)`, penWidth >= Math.max(3, Math.round(2 * zoom)), `penumbra only ${penWidth}px — a hard fill→bg cliff (clip artifact)`);
    // No hard black blob: the penumbra must not contain a near-black core that
    // then jumps straight to white (the screenshot's clipped blob). A monotone
    // soft ramp never dips to near-black for a dx3/blur21 shadow.
    ok(`${name}: no hard black-blob core`, darkest > 120, `penumbra dipped to near-black (${darkest}) — a hard-clipped shadow blob`);
    penumbraPx[name] = penWidth;
  }

  // (3) PENUMBRA SCALES WITH ZOOM (world blur → blur·zoom·dpr device px).
  ok("penumbra grows z1 → z8", penumbraPx.z8 > penumbraPx.z1 + 4, `z1=${penumbraPx.z1} z8=${penumbraPx.z8} device px`);
  ok("penumbra grows z025 → z1", penumbraPx.z1 > penumbraPx.z025, `z025=${penumbraPx.z025} z1=${penumbraPx.z1} device px`);

  // z8fill: the ellipse dwarfs the screen — the whole frame is fill with NO
  // interior hard cliff (the OLD crop cut a vertical black-then-white edge
  // across the middle of the item). Scan the middle row; every px must be fill.
  {
    const px = framePx.z8fill;
    const midY = Math.round(dh / 2);
    let allFill = true, worst = 0;
    for (let x = 0; x < dw; x++) { const L = lum(at(px, x, midY)); if (L > FILL_LUM_MAX) { allFill = false; worst = Math.max(worst, L); } }
    ok("z8fill: no interior fill cliff (item dwarfs screen)", allFill, `a non-fill px (lum ${worst}) appeared mid-item — the clip cliff`);
  }

  // (4) LEADING-EDGE (TOP + LEFT) PENUMBRA — manifest 16.1. OPPOSITE the +dx/+dy
  // offset. Scan OUTWARD past the top edge (upward) / left edge (leftward): a
  // correct render shows the SAME soft grey penumbra as the offset side; the
  // 16.1 bug clipped it to a straight fill→background cliff (penWidth 0), because
  // the effect source texture started AT the geometry — the up/left blur spill
  // read empty texels. Run at zoom 1 AND 8 with the NON-ZERO dx/dy shadow so the
  // leading side is the stressed one (its penumbra is the small offset SUBTRACTED
  // from the blur reach, still a wide soft band — never a cliff).
  const leadPenPx = {};
  for (const [name, zoom, axis] of LEADING_VIEWS) {
    const px = framePx[name], v = VIEWS[name];
    const isTop = axis === "top";
    // The leading geometry edge, on the ellipse's mid axis, in device px.
    const [exD, eyD] = isTop
      ? w2d(ELL.X + ELL.w / 2, ELL.Y, v)          // top edge midpoint
      : w2d(ELL.X, ELL.Y + ELL.h / 2, v);         // left edge midpoint
    const inset = Math.max(3, Math.round(6 * zoom));
    // (4a) FILL present just INSIDE the leading edge (the fill itself is intact).
    const fillIn = isTop ? at(px, Math.round(exD), Math.round(eyD) + inset)
                         : at(px, Math.round(exD) + inset, Math.round(eyD));
    ok(`${name}: fill intact just inside the ${axis} edge`, lum(fillIn) < FILL_LUM_MAX, `${axis}-edge fill missing, got ${fillIn}`);
    // (4b) SOFT PENUMBRA outward (up for top, left for left) — a grey run before
    // the background, exactly like the offset-side test.
    const scan = [];
    const scanLen = Math.ceil((ELL.h * 0.4 + SHADOW.blur * 3) * zoom) + 20;
    for (let k = 0; k < scanLen; k++) {
      const [sx, sy] = isTop ? [Math.round(exD), Math.round(eyD) - k] : [Math.round(exD) - k, Math.round(eyD)];
      scan.push(lum(at(px, sx, sy)));
    }
    let firstBg = scan.findIndex((L) => L > BG_LUM_MIN); if (firstBg < 0) firstBg = scan.length;
    let penStart = 0; while (penStart < firstBg && scan[penStart] < FILL_LUM_MAX) penStart++;
    const penWidth = firstBg - penStart;
    const greys = scan.slice(penStart, firstBg);
    const darkest = greys.length ? Math.min(...greys) : 255;
    ok(`${name}: ${axis} shadow present (darkens bg past the leading edge)`, darkest < SHADOW_DARKEST, `no leading-edge shadow darkening, min grey ${darkest}`);
    ok(`${name}: ${axis} penumbra is SOFT (no leading-edge cliff)`, penWidth >= Math.max(3, Math.round(2 * zoom)), `leading penumbra only ${penWidth}px — the 16.1 top/left cliff`);
    ok(`${name}: ${axis} no hard black-blob core`, darkest > 120, `leading penumbra dipped near-black (${darkest})`);
    leadPenPx[name] = penWidth;
  }
  // The leading-edge penumbra stays SUBSTANTIAL at zoom 8 (the downscale path
  // keeps the up/left blur source, so a wide soft band survives — the 16.1 bug
  // gave 0 here). NB: at zoom 8 the penumbra (blur·zoom·dpr ≈ 336 dev px) exceeds
  // the upward/leftward scan room to the canvas edge, so its measured width is
  // canvas-capped, NOT compared to z1 — the softness checks above already prove
  // no cliff. A cliff would read penWidth 0 regardless of scan room.
  const Z8_LEADING_MIN = 40; // device px — comfortably a soft band, never a cliff
  ok("top leading penumbra stays wide at z8", leadPenPx.tlTop8 >= Z8_LEADING_MIN, `tlTop8=${leadPenPx.tlTop8}px — a soft band must survive the downscale`);
  ok("left leading penumbra stays wide at z8", leadPenPx.tlLeft8 >= Z8_LEADING_MIN, `tlLeft8=${leadPenPx.tlLeft8}px — a soft band must survive the downscale`);

  ok("zero page console errors", pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);

  console.log(`\nEFFECTS ZOOM PROBE: ${checks} checks passed`);
  console.log(`  right penumbra device px: z025=${penumbraPx.z025} z1=${penumbraPx.z1} z8=${penumbraPx.z8}`);
  console.log(`  leading penumbra device px: top z1=${leadPenPx.tlTop1} z8=${leadPenPx.tlTop8}  left z1=${leadPenPx.tlLeft1} z8=${leadPenPx.tlLeft8}`);
  console.log(`  screenshots: ${SHOT_DIR}`);
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
}
