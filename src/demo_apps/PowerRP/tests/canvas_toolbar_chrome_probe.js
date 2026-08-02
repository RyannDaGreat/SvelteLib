/**
 * CANVAS TOOLBAR CHROME PROBE (browser) — the floating canvas toolbar's TOOLTIP
 * PLACEMENT and its PANEL CHROME, measured on a live editor.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/canvas_toolbar_chrome_probe.js
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * TWO user reports about the same surface, 2026-08-02, verbatim:
 *
 *   1. "why [do] canvas toolbars always have the hover tooltips in the wrong
 *      place?"
 *   2. "why is it that the style for the QR code floating canvas toolbar is all
 *      not the same style as other things in this app? It looks a little bit out
 *      of place. There's this blue line on the top of it. I don't know why that's
 *      there."
 *
 * Both were invisible to every existing test, because both are FACTS ABOUT
 * RECTANGLES AND COMPUTED STYLE that only a live browser can answer. So this file
 * asserts them as measurements rather than as markup greps: where the tip lands
 * relative to the control it describes, and whether the panel wears the same
 * floating-surface chrome the palette does.
 *
 * ── (1) THE TOOLTIP MEASUREMENT, and why "near the anchor" is the right check ─
 * src/lib/Tooltip.svelte anchors to the CURSOR by default and follows it
 * (`anchor="cursor"`), which is right for a large wrapped target — a panel-wide
 * tip pushed below a 600px pane would land nowhere near what the pointer is on.
 * A canvas-toolbar row is the opposite case: the wrapped thing is one small
 * field or one small button, the tip describes THAT control, and the panel it
 * lives in is itself a floating surface that has already been positioned
 * relative to the widget. So the tip belongs on the control's own box.
 *
 * The assertion is therefore a DISTANCE: the tip's rect must sit within
 * MAX_ANCHOR_GAP px of its anchor's rect, on both axes. That is stated as a
 * tolerance rather than an exact position because the tip legitimately flips
 * side and clamps horizontally at the viewport edge (resolvePlacement /
 * computePosition), and pinning an exact pair of coordinates would fail on those
 * correct behaviours.
 *
 * ── (2) THE CHROME MEASUREMENT ──────────────────────────────────────────────
 * The app's floating-surface convention is one set of four facts, and `.palette`
 * is where they are written down: the glass background, a hairline border, a
 * `--a-radius-floating` corner, and `--a-glass-shadow` (whose FIRST layer is the
 * inset lit rim). The canvas toolbar had three of the four and no radius, which
 * is what made a square-cornered panel sit inside a rounded-panel app.
 *
 * The BLUE LINE is that same rim, read on the theme the user was looking at:
 * Nocturne sets `--a-glass-rim: rgba(200, 220, 255, 0.16)`, a blue-white. On the
 * palette it reads as a lit top edge because the surface is 640px wide, rounded
 * and blurred. On a ~250px square-cornered fields bar it reads as a blue LINE
 * drawn across the top — the same declaration, a different picture, because the
 * rest of the convention was missing. So the fix is not to delete the rim (that
 * would take the toolbar further from the house style, not closer) but to give
 * the panel the radius the rim was designed to curve around.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

/**
 * How far a tooltip's rect may sit from the rect of the control it describes,
 * per axis, in px.
 *
 * WHERE THE NUMBER COMES FROM: the tip is placed one `--tt-gap` (6px default)
 * off the anchor and is horizontally CENTERED on it, so a tip wider than its
 * anchor legitimately overhangs by half the width difference. A canvas-toolbar
 * help sentence caps at --tt-max-width 240px against a 66-232px field, so the
 * honest worst case is ~90px of overhang plus the gap. 120 covers that with room
 * for the viewport clamp and rounds to a number a reader can hold, while still
 * being FAR smaller than the failure it exists to catch: a cursor-anchored tip
 * measured 300-600px away from its field.
 */
const MAX_ANCHOR_GAP = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser();

const failures = [];
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3000);
  if (bootErrors.length) { console.error("BOOT ERRORS:\n" + bootErrors.join("\n")); process.exit(1); }

  // A ONE-WIDGET DECK with a QR code in the middle — the surface the user named,
  // and the FIELDS content kind (the grid kind is covered by the cursor probe).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 800, h: 600, z: 1000, active: true, background: "#20242e" };
    const qr = { ...def("qrcode"), name: "qr", x: 300, y: 260, w: 200, h: 200, z: 1, active: true, data: "https://example.com" };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "toolbar-chrome", slideW: 800, slideH: 600 }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items: { cam, qr } } }] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    window.__qrId = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "qrcode");
  });
  await page.evaluate(() => window.__powerrp_app.commands.get("reset-view")?.run(window.__powerrp_app));
  await sleep(700);

  // Double-click the QR to open its floating toolbar (the activation path).
  const dbl = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((nn) => nn.itemId === window.__qrId);
    const s = app.canvasActions.worldToScreen(n.world.x + n.state.w / 2, n.world.y + n.state.h / 2);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { px: r.left + s.x, py: r.top + s.y };
  });
  await page.mouse.click(dbl.px, dbl.py, { clickCount: 2 });
  await sleep(800);

  const panelUp = await page.evaluate(() => !!document.querySelector(".canvas-toolbar"));
  check("the QR widget's floating toolbar opens on double-click", panelUp);
  if (!panelUp) throw new Error("no .canvas-toolbar — nothing to measure");

  // ── (2) CHROME: the panel against .palette, the house floating surface ─────
  const chrome = await page.evaluate(() => {
    const read = (el) => {
      const cs = getComputedStyle(el);
      return {
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        borderWidth: parseFloat(cs.borderTopWidth) || 0,
        shadow: cs.boxShadow,
        background: cs.backgroundColor,
        backdrop: cs.backdropFilter,
      };
    };
    // .palette is only in the DOM while open, so read the STYLESHEET for it —
    // the convention is what the rule declares, not what happens to be mounted.
    const paletteRule = [...document.styleSheets]
      .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
      .find((r) => r.selectorText === ".palette");
    const floatingRadius = getComputedStyle(document.documentElement)
      .getPropertyValue("--a-radius-floating").trim();
    return {
      panel: read(document.querySelector(".canvas-toolbar")),
      paletteDecls: paletteRule ? paletteRule.style.cssText : null,
      floatingRadius,
      theme: document.documentElement.dataset.theme ?? "(unset)",
    };
  });
  console.log(`  theme=${chrome.theme} --a-radius-floating=${chrome.floatingRadius} panel.radius=${chrome.panel.radius}px`);
  console.log(`  panel.shadow=${chrome.panel.shadow.slice(0, 120)}`);

  const wantsRadius = parseFloat(chrome.floatingRadius) || 0;
  check("the panel wears the floating-surface CORNER RADIUS (the palette's own token)",
    Math.abs(chrome.panel.radius - wantsRadius) < 0.5,
    `panel ${chrome.panel.radius}px vs --a-radius-floating ${chrome.floatingRadius} — a square panel in a rounded-panel app is what "out of place" means`);
  check("the panel keeps its hairline border", chrome.panel.borderWidth > 0);
  check("the panel keeps the glass shadow (whose first layer IS the lit rim)",
    chrome.panel.shadow !== "none");
  check("the panel keeps the backdrop blur", /blur/.test(chrome.panel.backdrop));
  check("the palette rule still declares the convention this is matched against",
    !!chrome.paletteDecls && /border-radius/.test(chrome.paletteDecls),
    "the .palette rule lost its radius — then the convention moved and this check is comparing to nothing");

  await page.screenshot({ path: resolve(SHOTS, "canvas_toolbar_chrome.png") });

  // ── (1) TOOLTIP PLACEMENT: hover the field, measure tip vs anchor ──────────
  // Hovered by REAL MOUSE MOVEMENT, deliberately: the defect is specifically that
  // the tip tracked the CURSOR, so a synthetic pointerenter carrying no position
  // would measure a placement no user ever sees. Two positions in the SAME
  // control, because a cursor-anchored tip MOVES between them and an
  // element-anchored one does not — which is the sharpest available statement of
  // what "the wrong place" meant.
  const fieldBox = await page.evaluate(() => {
    const el = document.querySelector(".canvas-toolbar-field-input");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  check("the fields toolbar rendered its input", !!fieldBox);

  const measureAt = async (fx, fy) => {
    await page.mouse.move(fx, fy);
    await sleep(250);
    return page.evaluate(() => {
      const tip = document.querySelector(".tt-tip");
      const el = document.querySelector(".canvas-toolbar-field-input");
      if (!tip || !el) return null;
      const t = tip.getBoundingClientRect(), a = el.getBoundingClientRect();
      // Per-axis separation between two rects: 0 when they overlap on that axis.
      const gapX = Math.max(0, a.left - t.right, t.left - a.right);
      const gapY = Math.max(0, a.top - t.bottom, t.top - a.bottom);
      return { gapX, gapY, tip: { left: t.left, top: t.top }, anchor: { left: a.left, top: a.top } };
    });
  };

  // Near the field's left end, then near its right end — same control, far apart.
  const left = await measureAt(fieldBox.left + 12, (fieldBox.top + fieldBox.bottom) / 2);
  const right = await measureAt(fieldBox.right - 12, (fieldBox.top + fieldBox.bottom) / 2);
  check("hovering the field shows its tooltip", !!left && !!right);

  if (left && right) {
    console.log(`  tip@left  (${left.tip.left.toFixed(0)}, ${left.tip.top.toFixed(0)})  gap=(${left.gapX.toFixed(0)}, ${left.gapY.toFixed(0)})`);
    console.log(`  tip@right (${right.tip.left.toFixed(0)}, ${right.tip.top.toFixed(0)}) gap=(${right.gapX.toFixed(0)}, ${right.gapY.toFixed(0)})`);
    for (const [where, m] of [["left end", left], ["right end", right]]) {
      check(`the tip lands ON its anchor when hovering the field's ${where}`,
        m.gapX <= MAX_ANCHOR_GAP && m.gapY <= MAX_ANCHOR_GAP,
        `gap (${m.gapX.toFixed(0)}, ${m.gapY.toFixed(0)}) px exceeds ${MAX_ANCHOR_GAP} — the tip is not near the control it describes`);
    }
    // THE DEFINING CHECK. A cursor-anchored tip moves with the pointer; an
    // element-anchored one is placed against a fixed box and cannot.
    const drift = Math.abs(left.tip.left - right.tip.left) + Math.abs(left.tip.top - right.tip.top);
    check("the tip does NOT follow the cursor inside one control (element-anchored)",
      drift < 1,
      `moved ${drift.toFixed(0)}px between two points in the SAME field — that is the cursor anchor, and it is what "in the wrong place" means`);
  }

  await page.screenshot({ path: resolve(SHOTS, "canvas_toolbar_tooltip.png") });
  console.log(`  screenshots → ${SHOTS}/canvas_toolbar_{chrome,tooltip}.png`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\ncanvas toolbar chrome probe: all checks passed");
