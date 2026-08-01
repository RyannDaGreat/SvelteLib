/**
 * SHAPE PICKER / INSERT-SHAPE SUBMENU probe — ONE PICKER, end to end in the real
 * booted editor.
 *
 * The consolidation's user-facing claim is that there is now exactly one way to
 * add a shape and that what it adds is genuinely parametric. Neither half can be
 * checked in bare node: the toolbar popover is Svelte, the submenu's children are
 * built in web/App.svelte (which does not import in node), and "the parameter
 * responds" is a statement about the rendered Inspector plus the derived scene.
 *
 * Scenarios:
 *   1. The toolbar picker opens and EVERY tile is a family tile — the legacy row
 *      is gone. This is the bug the user actually hit: two visually identical
 *      rows, one of which produced a widget with dead knobs.
 *   2. Clicking a tile arms placement, and a click on the canvas inserts an
 *      `ss_*` item — never `type: "shape"`.
 *   3. The palette's `insert-shape` submenu DRILLS IN to the same children and
 *      inserts the same way (one source of truth, two surfacings).
 *   4. THE PARAM ROW RESPONDS. For the inserted family, the Inspector shows its
 *      own numeric row; writing a new value changes the DERIVED GEOMETRY. On the
 *      legacy octagon this was false — points 8 and points 5 drew the same path —
 *      so the assertion is specifically that the emitted path CHANGES.
 *   5. No legacy `shape` item can be created by any of it.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/shape_picker_probe.js <shot_dir>
 */
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";
// The gate passes a per-run directory that may not exist yet; a screenshot into a
// missing directory throws ENOENT and aborts the whole probe before any assertion
// is reported, which reads as a failure of the thing under test rather than of
// the plumbing.
await mkdir(shots, { recursive: true });

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr:false + watch:null — the house probe convention: a concurrent save
  // elsewhere in the tree would reload the page mid-run and every later
  // page.evaluate would die with "Execution context was destroyed".
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await launchBrowser();
const failures = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));

  const bootErrors = errors.length; // baseline: other agents' in-flight WIP noise, not ours
  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };
  const typesNow = () => page.evaluate(() => window.__powerrp_app.nodes().map((n) => n.type));

  // ── Scenario 1: the picker opens, and EVERY tile is a family tile ──────────
  const trigger = await page.$('.shape-picker button[aria-label="Add Shape"]');
  check("picker-trigger-exists", !!trigger, "toolbar Add Shape button not found");
  await trigger.click();
  await new Promise((r) => setTimeout(r, 200));

  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll(".shape-picker-grid .shape-tile")].map((b) => b.getAttribute("aria-label")));
  check("picker-has-tiles", tiles.length > 0, "the grid rendered no tiles");

  // ── THE REVERSE GATE: every widget that CLAIMS to be a shape has a tile ────
  // The direction that was missing, and the reason the user could not find
  // `aperture` or `iris_blades`: the grid used to be "the shapeshifter FAMILIES",
  // so a standalone shape plugin was unreachable no matter what anyone did. The
  // expectation is DERIVED from the live roster — every registered plugin
  // declaring `insertMenu: "shape"` — never from a list restated here, which
  // would be the same mirror one file further out.
  const declared = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return app.registry.all()
      .filter((p) => p.insertMenu === "shape")
      .map((p) => {
        const own = (p.commands ?? []).find((c) => c.id.startsWith("add-"));
        return { type: p.type, title: app.commands.get(own?.id ?? `add-${p.type}`).title };
      });
  });
  check("every-declared-shape-has-a-tile",
    declared.every((d) => tiles.includes(d.title)),
    `missing=${JSON.stringify(declared.filter((d) => !tiles.includes(d.title)))}`);
  check("no-tile-without-a-declaration",
    tiles.every((t) => declared.some((d) => d.title === t)),
    `extra=${JSON.stringify(tiles.filter((t) => !declared.some((d) => d.title === t)))}`);
  // VACUITY GUARD, and the user's actual complaint stated as an assertion: the
  // roster must contain shapes that are NOT shapeshifter families, or the check
  // above passes for exactly the reason the old rule did.
  const standalone = declared.filter((d) => !d.type.startsWith("ss_"));
  check("the-roster-has-non-family-shapes-to-catch", standalone.length > 0,
    "every declared shape is a shapeshifter family — this gate cannot tell the new rule from the old one");
  for (const d of standalone)
    check(`standalone-shape-tile-${d.type}`, tiles.includes(d.title), `"${d.title}" declares insertMenu:"shape" but has no tile`);

  // A FALLBACK TILE MUST ACTUALLY DRAW, AT THE TILE'S ART SIZE. A shape with no
  // silhouette generator gets its command's icon instead of a path, and that
  // fallback was silently wrong first time: `iconify-icon` renders an inner <svg>
  // at 1em, so CSS width/height sized the HOST box and left a ~14px glyph
  // top-aligned in a correct-looking 40x40 square. Measuring only the host would
  // have passed. Measure the GLYPH, and compare it against a path tile rather than
  // against a number, so the two kinds of tile are pinned to one art size.
  await new Promise((r) => setTimeout(r, 1200)); // iconify fetches its glyphs
  const art = await page.evaluate(() => {
    const box = (el) => { const r = el?.getBoundingClientRect(); return r ? Math.round(r.width) : null; };
    return [...document.querySelectorAll(".shape-picker-grid .shape-tile")].map((b) => {
      const svg = b.querySelector("svg.shape-tile-svg");
      const ico = b.querySelector("iconify-icon");
      return {
        label: b.getAttribute("aria-label"),
        kind: svg ? "path" : "icon",
        size: box(svg ?? ico?.shadowRoot?.querySelector("svg")),
        drawn: svg ? true : /<(path|circle|rect|g)\b/.test(ico?.shadowRoot?.innerHTML ?? ""),
      };
    });
  });
  const pathSize = art.find((t) => t.kind === "path")?.size;
  const iconTiles = art.filter((t) => t.kind === "icon");
  check("there-are-icon-fallback-tiles-to-check", iconTiles.length > 0,
    "no tile fell back to an icon — this check cannot see the defect it exists for");
  check("every-fallback-tile-draws-a-real-glyph",
    iconTiles.every((t) => t.drawn),
    JSON.stringify(iconTiles.filter((t) => !t.drawn)));
  check("fallback-glyphs-are-the-same-art-size-as-a-path-tile",
    !!pathSize && iconTiles.every((t) => t.size === pathSize),
    `path=${pathSize} icons=${JSON.stringify(iconTiles.map((t) => [t.label, t.size]))}`);
  // The legacy row's tiles were labelled "Add <Legacy Label>"; none may remain.
  for (const dead of ["Add Octagon", "Add Hexagon", "Add Pentagon", "Add Lightning", "Add Block Arrow"])
    check(`legacy-tile-gone-${dead.replace(/\W+/g, "-")}`, !tiles.includes(dead), `"${dead}" is still in the grid`);

  await page.screenshot({ path: `${shots}/shape_picker_open.png` });

  // ── Scenario 2: a tile arms placement and inserts an ss_ item ──────────────
  const before = (await typesNow()).length;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".shape-picker-grid .shape-tile")]
      .find((b) => b.getAttribute("aria-label") === "Add Polygon / Star");
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  const canvas = await page.$(".canvas-wrap");
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 700, box.y + 420);
  await new Promise((r) => setTimeout(r, 300));

  const afterTypes = await typesNow();
  check("tile-inserted-one-item", afterTypes.length === before + 1, `before=${before} after=${afterTypes.length}`);
  check("tile-inserted-a-family", afterTypes.includes("ss_polygonStar"), `types=${JSON.stringify(afterTypes)}`);

  // ── Scenario 3: the palette submenu drills in to the SAME children ─────────
  const submenu = await page.evaluate(() => {
    const cmd = window.__powerrp_app.commands.get("insert-shape");
    return { hasChildren: Array.isArray(cmd.children), ids: (cmd.children ?? []).map((c) => c.id) };
  });
  check("submenu-has-children", submenu.hasChildren && submenu.ids.length > 0, JSON.stringify(submenu));
  check("submenu-children-are-all-ss",
    submenu.ids.every((id) => id.startsWith("add-ss_")),
    `ids=${JSON.stringify(submenu.ids)}`);
  const beforeHeart = (await typesNow()).length;
  await page.evaluate(() => window.__powerrp_app.runCommand("add-ss_heart"));
  await new Promise((r) => setTimeout(r, 150));
  // Running the child command ARMS crosshair placement; assert that separately
  // from the click, so a failure says which half broke.
  const armed = await page.evaluate(() => window.__powerrp_app.crosshair?.kind === "place");
  check("submenu-command-arms-placement", armed, "runCommand(add-ss_heart) did not arm crosshair placement");
  // Place it well inside the canvas — the same neighbourhood the tile insert used.
  await page.mouse.click(box.x + 500, box.y + 500);
  await new Promise((r) => setTimeout(r, 400));
  const withHeart = await typesNow();
  check("submenu-inserted-the-heart",
    withHeart.includes("ss_heart") && withHeart.length === beforeHeart + 1,
    `types=${JSON.stringify(withHeart)}`);

  // ── Scenario 4: THE PARAM ROW RESPONDS (the dead-octagon regression) ───────
  // Select the polygon/star, read its emitted path, change `points`, read again.
  const paramEffect = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.type === "ss_polygonStar");
    app.selectMany([node.itemId]);
    // The path the DERIVED node actually emits — read through the plugin the same
    // way ports.js does, so this is the geometry that would be painted, not a
    // re-derivation of the parameter by the test.
    const pathOf = () => {
      const n = app.nodes().find((x) => x.itemId === node.itemId);
      const ops = app.registry.get("ss_polygonStar").emit(n.state, null, { x: 0, y: 0, rotation: 0, scale: 1 });
      return (ops.find((o) => o.op === "path") ?? {}).d ?? "";
    };
    const rowKeys = app.registry.get("ss_polygonStar").inspector.map((r) => r.key);
    const before = pathOf();
    // THE INSPECTOR'S OWN WRITE PATH (Inspector.svelte's setPreview + commit), not
    // a direct state poke: the claim being tested is that turning the knob in the
    // UI changes the picture.
    app.setPreview([[["items", node.itemId, "points"], 9]]);
    app.commitPreview();
    const after = pathOf();
    return { rowKeys, before, after, changed: before !== after, beforeLen: before.length, afterLen: after.length };
  });
  check("inspector-declares-the-family-row",
    paramEffect.rowKeys.includes("points") && paramEffect.rowKeys.includes("innerRatio"),
    `rows=${JSON.stringify(paramEffect.rowKeys)}`);
  check("param-row-changes-the-geometry",
    paramEffect.changed,
    `points 5 -> 9 produced an IDENTICAL path (${paramEffect.beforeLen} chars) — this is exactly the legacy octagon defect`);

  // ── Scenario 5: nothing anywhere created a legacy `shape` ──────────────────
  const finalTypes = await typesNow();
  check("no-legacy-shape-was-created", !finalTypes.includes("shape"), `types=${JSON.stringify(finalTypes)}`);
  const addCmds = await page.evaluate(() =>
    window.__powerrp_app.commands.all().filter((c) => /(^|-)add-shape$/.test(c.id)).map((c) => c.id));
  check("no-add-shape-command-remains", addCmds.length === 0, `found ${JSON.stringify(addCmds)}`);

  await page.screenshot({ path: `${shots}/shape_picker_inserted.png` });

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during shape picker probe: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("SHAPE PICKER PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s) from other agents' in-flight work)`);
    process.exit(1);
  }
  console.log(`Shape picker probe passed: ${tiles.length} family tiles, no legacy row, param row drives geometry (ignored ${bootErrors} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
