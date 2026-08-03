/**
 * WORKSTREAM UU half 2 — THE PASTE BUTTON KNOWS, in the real editor.
 *
 * User, 2026-08-02, verbatim: "the paste button tool tip should... and also the
 * paste icon should change depending on what will happen. There's different
 * modes of pasting... The paste icon should have a little badge on it, on maybe
 * the bottom right or top right or something that says if it's an abnormal kind
 * of paste and I'm not just pasting a widget, what am I pasting? Teeny little
 * badge and of course the hover tool tip should say too."
 *
 * The pure RULES (which glyph, which sentence) are executed by the bare-node
 * tests/paste_targeting_test.js. This probe answers the question a pure test
 * cannot: does the badge actually REACH THE DOM in the shipped app, per clipboard
 * kind, and does the dynamic tooltip actually render its live sentence?
 *
 * WHAT IS ASSERTED, and why each is here rather than in the node suite:
 *  A. NO BADGE after an ordinary widget copy. This is the one the node suite
 *     cannot prove was wired: `pasteBadge` returning null is worthless if the
 *     template renders a badge anyway.
 *  B. A PROPERTIES BADGE after Copy Properties, and the SUBSET badges after Copy
 *     Position / Copy Dimensions — three distinct `data-paste-badge` values off
 *     three real command runs, so the copy verbs and the badge vocabulary are
 *     shown to agree through the actual clipboard rather than through a fixture.
 *  C. THE TOOLTIP IS DYNAMIC: the SAME clipboard produces a different sentence
 *     with and without a selection. That is the whole ruling, and it is the one
 *     assertion that would still pass if the tip were static and wrong.
 *
 * NO SCREENSHOT. The manifest records that a host whose Chrome cannot capture
 * turns every screenshotting probe into a contentless ProtocolError; nothing here
 * needs pixels, so nothing here calls page.screenshot.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/paste_badge_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const UV = process.env.POWERRP_UV || "uv";

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* server not up yet — the retry loop IS the handling */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_paste_badge_"));
const backendPort = await freePort();
const server = spawn(UV, ["run", "server.py", "serve", `--port=${backendPort}`], {
  cwd: join(APP_DIR, "server"),
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
const errors = [];
const note = (ok, msg) => { if (!ok) errors.push(msg); else console.log(`  ok  ${msg}`); };

try {
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);
  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: resolve(APP_DIR, "web/vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageUrl = `http://127.0.0.1:${viteServer.httpServer.address().port}/`;

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // Correctly-reported headless limits, not defects (clipboard_duplicate_probe.js's
  // list): headless Chromium denies OS-clipboard image writes, and there is no
  // WebGPU adapter under SwiftShader. Every copy below therefore reports one of
  // these; they are noise, not failures.
  const EXPECTED_NOISE = [
    /VideoV7: WebGPU init failed/,
    /OS-clipboard image write was denied or failed/,
    /refused the PowerRP ownership marker/,
    /has no Clipboard image-write API/,
  ];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  const consoleErrors = [];
  page.on("pageerror", (e) => { if (!isExpectedNoise(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
  });

  await browser.defaultBrowserContext().overridePermissions(pageUrl, ["clipboard-read", "clipboard-write"]);
  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  if (consoleErrors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + consoleErrors.join("\n"));

  /** Query (drives the page). The `data-paste-badge` id currently rendered on the
   *  toolbar Paste button, or null when no badge is there. Reads the DOM, not the
   *  app — the point of this probe is that the decision REACHES the markup. */
  const badgeId = () => page.evaluate(() => {
    const el = document.querySelector('.toolbar [data-paste-badge]');
    return el ? el.getAttribute("data-paste-badge") : null;
  });

  /** Query (drives the page). The paste button's live tooltip sentence, read
   *  through the app's own affordance — the SAME value Toolbar's tipNoteFor
   *  renders, so this cannot pass while the template shows something else.
   *  The rendered note is asserted separately, once, by hovering. */
  const intent = () => page.evaluate(() => window.__powerrp_app.pasteAffordance().intent);

  /** Command (drives the page). Runs a command and lets the reactive pass settle. */
  const run = async (id) => {
    await page.evaluate((i) => window.__powerrp_app.runCommand(i), id);
    await new Promise((r) => setTimeout(r, 350));
  };

  // Two widgets of DIFFERENT types, so the retarget has something real to
  // intersect and the selection counts below are unambiguous.
  const ids = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.doc.meta.name = "paste_badge";
    app.addItem({ ...app.registry.get("rect").defaults, x: 40, y: 40, w: 120, h: 80 });
    const rectId = app.selection;
    app.addItem({ ...app.registry.get("circle").defaults, x: 300, y: 40, w: 100, h: 100 });
    const circleId = app.selection;
    return { rectId, circleId };
  });
  await new Promise((r) => setTimeout(r, 250));

  // ── A. AN ORDINARY WIDGET PASTE CARRIES NO BADGE ────────────────────────────
  console.log("A. an ordinary widget copy leaves the Paste button unbadged");
  await page.evaluate((id) => window.__powerrp_app.selectMany([id]), ids.rectId);
  await run("copy-item");
  note(await badgeId() === null,
    `no badge after Copy (got ${JSON.stringify(await badgeId())}) — a badge on every paste would distinguish nothing`);
  note(/Paste 1 copied widget/.test(await intent()),
    `the tip counts the copied widgets (got ${JSON.stringify(await intent())})`);

  // ── B. THE ABNORMAL KINDS EACH GET THEIR OWN GLYPH ──────────────────────────
  console.log("B. each abnormal paste kind badges itself");
  for (const [command, expected] of [
    ["copy-properties", "properties"],
    ["copy-position", "position"],
    ["copy-dimensions", "dimensions"],
    ["copy-rotation", "rotation"], // WORKSTREAM VV: new subset, own glyph (mdi:rotate-360)
    ["copy-box", "properties"], // now "Copy Transform" — still shares the general glyph by legibility ruling
  ]) {
    await page.evaluate((id) => window.__powerrp_app.selectMany([id]), ids.rectId);
    await run(command);
    const got = await badgeId();
    note(got === expected, `${command} → badge "${expected}" (got ${JSON.stringify(got)})`);
  }

  // ── C. THE TOOLTIP IS DYNAMIC IN THE SELECTION ──────────────────────────────
  console.log("C. the SAME clipboard says different things with and without a selection");
  await page.evaluate((id) => window.__powerrp_app.selectMany([id]), ids.rectId);
  await run("copy-position");

  await page.evaluate(() => window.__powerrp_app.selectMany([])); // empty ids = full deselect
  await new Promise((r) => setTimeout(r, 250));
  const noSelection = await intent();
  note(/nothing selected/.test(noSelection),
    `with nothing selected the tip names the per-id paste (got ${JSON.stringify(noSelection)})`);

  await page.evaluate((i) => window.__powerrp_app.selectMany([i.rectId, i.circleId]), ids);
  await new Promise((r) => setTimeout(r, 250));
  const withSelection = await intent();
  note(/Apply the copied Position to the 2 selected widgets/.test(withSelection),
    `with 2 selected the tip names the retarget (got ${JSON.stringify(withSelection)})`);
  note(noSelection !== withSelection,
    "the two sentences must DIFFER — a static tip would pass every other assertion here");

  // THE SENTENCE ACTUALLY RENDERS. Everything above read the app; this reads the
  // TOOLTIP, so a correct affordance wired to nothing still fails.
  await page.hover('.toolbar button[aria-label^="Paste"]');
  await new Promise((r) => setTimeout(r, 500));
  const tipText = await page.evaluate(() =>
    [...document.querySelectorAll(".cmd-tip-note")].map((n) => n.textContent).join(" | "));
  note(tipText.includes("Apply the copied Position"),
    `the rendered tooltip carries the live sentence (got ${JSON.stringify(tipText)})`);

  // ── D. THE RETARGET ITSELF, END TO END ──────────────────────────────────────
  // One assertion that the badge is not describing a paste that does not happen:
  // Copy Position from the rect, select the CIRCLE, paste — the circle moves to
  // the rect's x/y and nothing else about it changes.
  console.log("D. the paste the badge describes is the paste that happens");
  const circleBefore = await page.evaluate((id) =>
    ({ ...window.__powerrp_app.rawState().items[id] }), ids.circleId);
  await page.evaluate((id) => window.__powerrp_app.selectMany([id]), ids.circleId);
  await new Promise((r) => setTimeout(r, 200));
  await run("paste");
  const circleAfter = await page.evaluate((id) =>
    ({ ...window.__powerrp_app.rawState().items[id] }), ids.circleId);
  note(circleAfter.x === 40 && circleAfter.y === 40,
    `the circle took the rect's position (${circleAfter.x}, ${circleAfter.y}) — expected (40, 40)`);
  note(circleAfter.w === circleBefore.w && circleAfter.h === circleBefore.h,
    "Copy Position touched only x/y — the circle's size is unchanged");
  note(circleAfter.type === "circle", "the circle is still a circle — `type` never retargets");

  await new Promise((r) => setTimeout(r, 200));
  if (consoleErrors.length) errors.push("CONSOLE ERRORS DURING PROBE:\n" + consoleErrors.join("\n"));

  if (errors.length) throw new Error("PROBE FAILURES:\n" + errors.map((e) => "  - " + e).join("\n"));
  console.log("\nPASTE BADGE PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
