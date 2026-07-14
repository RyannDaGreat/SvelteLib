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
    return {
      present: true,
      text: el.textContent.trim(),
      top: el.classList.contains("tt-top"),
      bottom: el.classList.contains("tt-bottom"),
      rectTop: el.getBoundingClientRect().top,
    };
  });
}

// Dispatch a pointerenter (immediate-show trigger) on a target by testid.
async function hover(page, testid) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
  }, testid);
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

  // 8. Edge flip: a "top" target pinned to the viewport top flips to bottom.
  await hover(page, "edge-top");
  await sleep(30);
  {
    const s = await tipState(page);
    check("top placement flips to bottom at viewport top edge", s.present && s.bottom && !s.top, JSON.stringify(s));
  }
  await leave(page, "edge-top");
  await sleep(20);

  // 9. Escape hides a shown tooltip.
  await hover(page, "immediate");
  await sleep(30);
  await page.keyboard.press("Escape");
  await sleep(20);
  check("Escape hides the tooltip", !(await tipState(page)).present);
  await leave(page, "immediate");

  // 10. Focus shows, blur hides (keyboard accessibility).
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="immediate"]');
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  await sleep(30);
  check("focus shows the tooltip", (await tipState(page)).present);
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
