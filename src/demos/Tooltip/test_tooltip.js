/**
 * Puppeteer smoke test for Tooltip.svelte.
 *
 * Mirrors the render.js pattern: spin up a programmatic Vite dev server on the
 * SvelteLib repo root, open the Tooltip demo in headless Chromium, and drive
 * real pointer/focus events to verify behavior. Exits non-zero on any failure.
 *
 * Run from the repo root:
 *   node src/demos/Tooltip/test_tooltip.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const { createServer } = await import("vite");
const server = await createServer({
  root: repoRoot,
  configFile: resolve(repoRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
  logLevel: "warn",
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/src/demos/Tooltip/demo.html`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });

let failures = 0;
function check(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

// Query state of the single live tooltip (there is at most one shown at a time).
async function tipState(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".tt-tip");
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    return {
      present: true,
      text: el.textContent.trim(),
      top: el.classList.contains("tt-top"),
      bottom: el.classList.contains("tt-bottom"),
      rectTop: r.top,
      // Tip box geometry, used to check proximity to the cursor.
      left: r.left,
      right: r.right,
      bottom_px: r.bottom,
      centerX: r.left + r.width / 2,
    };
  });
}

// Center point (viewport coords) of a target by testid.
async function centerOf(page, testid) {
  return page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
  }, testid);
}

// Dispatch pointerenter on a target at explicit viewport coords (the cursor
// position the tooltip should anchor near). Defaults to the target's center.
async function hover(page, testid, at = null) {
  const p = at || (await centerOf(page, testid));
  await page.evaluate(({ id, x, y }) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, clientX: x, clientY: y }));
  }, { id: testid, x: p.x, y: p.y });
  return p;
}

// Dispatch pointermove on a target at explicit coords (cursor tracking).
async function move(page, testid, x, y) {
  await page.evaluate(({ id, x, y }) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
  }, { id: testid, x, y });
}

// Dispatch pointerleave (hide + cancel pending) on a target by testid.
async function leave(page, testid) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    el.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
  }, testid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e);
    failures++;
  });
  await page.goto(url, { waitUntil: "networkidle0" });

  // 1. Absent initially.
  check("no tooltip before any hover", !(await tipState(page)).present);

  // 2. Immediate: appears right away (no delay) on pointerenter.
  await hover(page, "immediate");
  await sleep(30); // one microtask tick for Svelte to mount + $effect place()
  {
    const s = await tipState(page);
    check("immediate tooltip appears on hover", s.present && s.text === "Save file", JSON.stringify(s.text));
  }

  // 3. Disappears on pointerleave.
  await leave(page, "immediate");
  await sleep(20);
  check("immediate tooltip hides on pointerleave", !(await tipState(page)).present);

  // 4. Delay=500: NOT shown right away, but shown after the delay elapses.
  const DELAY_MS = 500;
  await hover(page, "delayed");
  await sleep(100); // well under the delay
  check("delayed tooltip absent before delay elapses", !(await tipState(page)).present);
  await sleep(DELAY_MS); // now comfortably past 500ms total
  {
    const s = await tipState(page);
    check("delayed tooltip appears after delay", s.present, s.present ? s.text : "still absent");
  }
  await leave(page, "delayed");
  await sleep(20);

  // 5. Delay cancels if pointer leaves before threshold.
  await hover(page, "delayed");
  await sleep(100);
  await leave(page, "delayed");
  await sleep(DELAY_MS);
  check("delayed tooltip cancelled by early leave", !(await tipState(page)).present);

  // 6. placement="bottom" renders below (tt-bottom) when there's room.
  await hover(page, "bottom");
  await sleep(30);
  {
    const s = await tipState(page);
    check("placement=bottom uses bottom side", s.present && s.bottom && !s.top, JSON.stringify(s));
  }
  await leave(page, "bottom");
  await sleep(20);

  // 7. Rich `tip` snippet renders custom content.
  await hover(page, "rich");
  await sleep(30);
  {
    const s = await tipState(page);
    check("rich tip snippet renders markup content", s.present && s.text.includes("Rich"), JSON.stringify(s.text));
  }
  await leave(page, "rich");
  await sleep(20);

  // 8. Edge flip: hovering near the very top of the viewport (small clientY)
  //    with placement="top" has no room above, so it flips to bottom.
  await hover(page, "edge-top", { x: 500, y: 6 });
  await sleep(30);
  {
    const s = await tipState(page);
    check("top placement flips to bottom near viewport top edge", s.present && s.bottom && !s.top, JSON.stringify(s));
  }
  await leave(page, "edge-top");
  await sleep(20);

  // 8b. NEAR-CURSOR anchoring on a LARGE panel: the tip must appear next to the
  //     dispatched pointer coords, NOT centered on the (huge) panel element.
  //     This is the core fix — pick a cursor point well away from the panel's
  //     center and assert the tip lands near it, and far from the element center.
  const MAX_CURSOR_DIST = 40; // px: tip should hug the cursor (gap + half-clamp)
  {
    const panel = await centerOf(page, "panel");
    // Cursor near the panel's left edge, far from its center.
    const cx = Math.round(panel.rect.left + 30);
    const cy = Math.round(panel.rect.top + 30);
    await hover(page, "panel", { x: cx, y: cy });
    await sleep(30);
    const s = await tipState(page);
    // Horizontal: tip is centered on the cursor X (within half its own width +
    // margin); crucially it is NOT centered on the panel's center X.
    const dxCursor = Math.abs(s.centerX - cx);
    const dxPanelCenter = Math.abs(s.centerX - panel.x);
    check(
      "tip appears near cursor X on large panel",
      s.present && dxCursor <= s.right - s.left, // within its own width of the cursor
      `centerX=${s.centerX.toFixed(0)} cursorX=${cx} dx=${dxCursor.toFixed(0)}`,
    );
    check(
      "tip is NOT centered on the large panel element",
      s.present && dxPanelCenter > dxCursor,
      `dxPanelCenter=${dxPanelCenter.toFixed(0)} vs dxCursor=${dxCursor.toFixed(0)}`,
    );
    // Vertical: default placement="top" → tip sits just above the cursor Y.
    const dyCursor = cy - s.bottom_px; // gap between tip bottom and cursor
    check(
      "tip sits just above the cursor (within gap distance)",
      s.present && dyCursor >= 0 && dyCursor <= MAX_CURSOR_DIST,
      `cursorY=${cy} tipBottom=${s.bottom_px.toFixed(0)} gap=${dyCursor.toFixed(0)}`,
    );

    // 8c. TRACKING: moving the cursor within the panel re-anchors the tip.
    const beforeX = s.centerX;
    const nx = Math.round(panel.rect.right - 30);
    const ny = Math.round(panel.rect.top + 60);
    await move(page, "panel", nx, ny);
    await sleep(30);
    const s2 = await tipState(page);
    check(
      "tip follows the cursor on pointermove",
      s2.present && Math.abs(s2.centerX - nx) <= s2.right - s2.left && s2.centerX > beforeX,
      `movedTo=${nx} newCenterX=${s2.centerX.toFixed(0)} (was ${beforeX.toFixed(0)})`,
    );
  }
  await leave(page, "panel");
  await sleep(20);

  // 9. Escape hides a shown tooltip.
  await hover(page, "immediate");
  await sleep(30);
  await page.keyboard.press("Escape");
  await sleep(20);
  check("Escape hides the tooltip", !(await tipState(page)).present);
  await leave(page, "immediate");

  // 10. Focus shows, blur hides (keyboard accessibility). The focus path has no
  //     cursor, so the tip must anchor to the ELEMENT rect (centered on the
  //     button's X), not to any stale/zero cursor coordinate.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="immediate"]');
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  await sleep(30);
  {
    const s = await tipState(page);
    check("focus shows the tooltip", s.present);
    const btn = await centerOf(page, "immediate");
    const dx = Math.abs(s.centerX - btn.x);
    check(
      "focus path anchors the tip to the element (centered on button X)",
      s.present && dx <= s.right - s.left,
      `tipCenterX=${s.centerX?.toFixed(0)} btnX=${btn.x.toFixed(0)} dx=${dx.toFixed(0)}`,
    );
  }
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="immediate"]');
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await sleep(20);
  check("blur hides the tooltip", !(await tipState(page)).present);
} finally {
  await browser.close();
  await server.close();
}

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
