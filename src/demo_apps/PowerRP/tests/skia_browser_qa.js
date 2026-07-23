/**
 * Browser QA smoke — the "always test every render surface" gate.
 *
 * Exercises the WHOLE editor over a served origin in headless Chromium: loads,
 * adds EVERY widget type (rect/circle/text/arrow + the backdrop/effect ones:
 * magnifier/blur/crop), then ENTERS PRESENT MODE — and fails on ANY uncaught
 * exception or WebGPU/renderer console error at ANY step. This is the test that
 * would have caught the PresentMode WebGPU crash (it never entered present mode
 * before). Screenshots each phase for a VLM look.
 *
 * Run (dev server must be up):
 *   node tests/skia_browser_qa.js [http://localhost:PORT]
 * URL defaults to the localhost URL in .claude_logs/devserver.log.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "..", "..", "..", "..", "..", ".claude_logs", "devserver.log");
const SHOTS = path.join(HERE, "..", "..", "..", "..", "..", ".claude_vlm_checks");
const URL = process.argv[2] || fs.readFileSync(LOG, "utf8").match(/https?:\/\/localhost:\d+/)[0];

// A console.error/pageerror matching this is a HARD failure (a pageerror always is).
const DANGER = /webgpu|navigator\.gpu|no adapter|requestadapter|not implemented|uncaught|paintir|skia.*(null|failed)|is not a function|cannot read/i;

const errors = [];
function since(mark) { return errors.slice(mark); }

async function clickByTitle(page, title) {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((el) => (el.title || el.getAttribute("aria-label")) === t);
    if (b) { b.click(); return true; }
    return false;
  }, title);
  if (!ok) throw new Error(`QA: toolbar button "${title}" not found`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const steps = [];
  const step = async (name, fn) => {
    const mark = errors.length;
    await fn();
    await new Promise((r) => setTimeout(r, 900));
    const dangerous = since(mark).filter((e) => e.startsWith("pageerror:") || DANGER.test(e));
    steps.push({ name, newErrors: since(mark).length, dangerous });
  };

  await step("load", () => page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 }));
  await new Promise((r) => setTimeout(r, 3500)); // Skia wasm + fonts + first paint
  for (const tool of ["Add Rectangle", "Add Circle", "Add Text", "Add Arrow", "Add Magnifier", "Add Blur Layer", "Add Crop Box"]) {
    await step(tool, () => clickByTitle(page, tool));
  }
  await page.screenshot({ path: path.join(SHOTS, "qa_editor_all_widgets.png") });
  await step("Present (fullscreen)", () => clickByTitle(page, "Present (fullscreen)"));
  await page.screenshot({ path: path.join(SHOTS, "qa_present_mode.png") });
  await page.keyboard.press("Escape"); // exit present mode
  await new Promise((r) => setTimeout(r, 600));

  await browser.close();

  const dangerousTotal = steps.reduce((n, s) => n + s.dangerous.length, 0);
  console.log("QA steps:");
  for (const s of steps) console.log(`  ${s.dangerous.length ? "FAIL" : "ok  "} ${s.name}  (+${s.newErrors} console msgs)` + (s.dangerous.length ? "\n      " + s.dangerous.join("\n      ") : ""));
  console.log(`\nscreenshots: ${SHOTS}/qa_editor_all_widgets.png, qa_present_mode.png`);
  if (dangerousTotal) { console.log(`\nRESULT: FAIL — ${dangerousTotal} dangerous error(s)`); process.exit(2); }
  console.log("\nRESULT: PASS — every widget + present mode, zero dangerous errors");
})().catch((e) => { console.error("QA ERROR:", e.message); process.exit(1); });
