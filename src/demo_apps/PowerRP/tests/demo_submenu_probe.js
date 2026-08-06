/**
 * THE DEMO SUBMENUS, DRIVEN THROUGH THE REAL PALETTE (manifest R7-18).
 *
 * WHAT THIS PROVES THAT tests/demo_insert_test.js CANNOT. That suite checks the
 * DATA — sections, generated children, the directory gate. It cannot check that the
 * entries actually reach a user: whether drilling into "Add Demo Audio Patch" in the
 * live palette shows the patches, whether the run closures survive the bundle (a
 * missing named import is bound to `undefined` and shipped — PowerRP CLAUDE.md), or
 * whether what arrives is ONE undo unit. All three are checked here by driving the
 * palette's own DOM and then pressing Cmd+Z.
 *
 * ONE UNDO UNIT IS THE LOAD-BEARING ASSERTION, and it is why the three kinds are
 * exercised together. R7-18 folded two inserts into one path; if that fold had gone
 * wrong the failure would not be a crash, it would be a patch that takes eleven
 * Cmd+Z to remove — visible only by counting, which is what this does.
 *
 * Run: node src/demo_apps/PowerRP/tests/demo_submenu_probe.js [shot_dir]
 */
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { DEMO_SECTIONS } from "../web/demoInsert.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const shots = resolve(process.argv[2] ?? resolve(here, "..", ".frenzy/round7/w3m/shots"));

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1280, height: 800 };
const BOOT_SETTLE_MS = 1200;
const SETTLE_MS = 350;

/** THE THREE INSERTS, one per section: a demo WIDGET (arms the crosshair, so a
 *  canvas click completes it), a demo AUDIO PATCH (items + wires, wrapped in a
 *  group) and a demo PRESET (items + equations + a script fragment). Each names the
 *  section it belongs to so the roster and this list cannot silently disagree. */
const INSERTS = [
  { section: "widget", command: "demo-insert-video-time-scrub", needsCanvasClick: true, minItems: 1 },
  { section: "patch", command: "demo-patch-whoosh", needsCanvasClick: false, minItems: 7 },
  { section: "preset", command: "demo-preset-double-pendulum", needsCanvasClick: false, minItems: 3 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

await mkdir(shots, { recursive: true });
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`${url}?fresh=demo-submenu`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await sleep(BOOT_SETTLE_MS);

  // ── 1. EVERY SECTION IS A SUBMENU IN THE LIVE PALETTE ─────────────────────
  // Drilling in is the user's own gesture: type the submenu's title, Enter to
  // descend, then read the rows that appear. The crumb trail proves we descended
  // rather than ran something.
  for (const section of DEMO_SECTIONS) {
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
    await sleep(SETTLE_MS);
    await page.type(".palette input", section.title);
    await sleep(SETTLE_MS);
    await page.keyboard.press("Enter");
    await sleep(SETTLE_MS);
    const drilled = await page.evaluate(() => ({
      crumbs: document.querySelector(".palette-crumbs")?.textContent?.trim() ?? "",
      rows: [...document.querySelectorAll(".palette-item .title")].map((n) => n.textContent.trim()),
    }));
    check(`submenu-${section.id}-drills-in`, drilled.crumbs.includes(section.title), `crumbs=${JSON.stringify(drilled.crumbs)}`);
    check(`submenu-${section.id}-has-children`, drilled.rows.length > 0, `${drilled.rows.length} rows: ${JSON.stringify(drilled.rows.slice(0, 4))}`);
    await page.screenshot({ path: `${shots}/submenu-${section.id}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await sleep(SETTLE_MS);
  }

  // ── 2. ONE OF EACH KIND ARRIVES, AND ONE UNDO REMOVES IT COMPLETELY ───────
  const itemCount = () => page.evaluate(() => Object.keys(window.__powerrp_app.state().items).length);
  for (const insert of INSERTS) {
    const before = await itemCount();
    await page.evaluate((id) => { const a = window.__powerrp_app; a.commands.get(id).run(a); }, insert.command);
    await sleep(SETTLE_MS);
    if (insert.needsCanvasClick) {
      // An ARMED crosshair is completed by a click on the canvas — the widget
      // section's verb, and the reason it is not a template.
      await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
      await sleep(SETTLE_MS);
    }
    const after = await itemCount();
    check(`${insert.section}-inserts`, after - before >= insert.minItems, `${insert.command}: +${after - before} items (expected ≥ ${insert.minItems})`);
    await page.screenshot({ path: `${shots}/inserted-${insert.section}.png` });

    // ONE Cmd+Z. Not "undo until it is gone" — the count of undos IS the assertion.
    await page.evaluate(() => { const a = window.__powerrp_app; a.undo(); });
    await sleep(SETTLE_MS);
    const undone = await itemCount();
    check(`${insert.section}-is-ONE-undo-unit`, undone === before, `${insert.command}: after one undo ${undone} items, was ${before} before the insert`);
  }

  // ── 3. THE PATCH ARRIVES AS A GROUP, the preset does not ──────────────────
  const kinds = await page.evaluate(() => {
    const a = window.__powerrp_app;
    const typesAfter = (id) => {
      const before = new Set(Object.keys(a.state().items));
      a.commands.get(id).run(a);
      const added = Object.entries(a.state().items).filter(([k]) => !before.has(k)).map(([, s]) => s.type);
      a.undo();
      return added;
    };
    return { patch: typesAfter("demo-patch-whoosh"), preset: typesAfter("demo-preset-double-pendulum") };
  });
  check("patch-arrives-grouped", kinds.patch.includes("group"), JSON.stringify(kinds.patch));
  check("preset-arrives-ungrouped", !kinds.preset.includes("group"), JSON.stringify(kinds.preset));

  // ── 4. THE OLD TOP-LEVEL ENTRIES ARE GONE, but the ids still resolve ──────
  // `commands.all()` is the FLAT map — children included, by design — so the
  // top-level pool is read the way the palette reads it: an empty search with no
  // parent. `parentOf` then names the submenu each demo now lives under.
  const registry = await page.evaluate(() => {
    const a = window.__powerrp_app;
    return {
      topLevelDemoIds: a.commands.search("", null).filter((c) => /^demo-(patch|preset)-/.test(c.id)).map((c) => c.id),
      patchParent: a.commands.parentOf("demo-patch-whoosh")?.id ?? null,
      presetParent: a.commands.parentOf("demo-preset-double-pendulum")?.id ?? null,
      resolvesChild: !!a.commands.get("demo-patch-whoosh"),
    };
  });
  check("no-top-level-demo-entries", registry.topLevelDemoIds.length === 0, JSON.stringify(registry.topLevelDemoIds));
  check("patch-lives-under-its-section", registry.patchParent === "insert-demo-patch", `parentOf = ${registry.patchParent}`);
  check("preset-lives-under-its-section", registry.presetParent === "insert-demo-preset", `parentOf = ${registry.presetParent}`);
  check("child-ids-still-resolve", registry.resolvesChild);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${checks - failures}/${checks} demo submenu checks passed — shots in ${shots}`);
if (failures) process.exit(1);
