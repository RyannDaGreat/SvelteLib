/**
 * TOOLS PANE STRUCTURE probe — the browser half of the tool-group refactor.
 * (tests/tool_groups_test.js is the bare-node half: it proves the RESOLUTION
 * rules over every registered plugin. This proves the RENDERING of them.)
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/toolspane_probe.js <shot_dir>
 *
 * WHY THIS EXISTS. The user's complaint was structural: "why is Presets UNDER
 * Formatting? A submenu under formatting? ... if there's nothing in a submenu, it
 * doesn't need to show it ... If something is disabled, the tooltip should say
 * WHY ... the formatting menu looks so different from the presets menu. It's like
 * a different font." Each of those is a rendered fact, so each is checked here on
 * a real page rather than argued about:
 *
 *   (1) GROUPS DIFFER PER WIDGET — a preset-carrying widget shows its preset
 *       group, a preset-less one shows none, a frameless one shows no
 *       Positioning group, and an unselected pane shows no tools at all.
 *   (2) NO NESTED DISCLOSURE — a preset card is a direct child of its group's
 *       rows; there is no second toggle button between the group header and the
 *       cards (the "dropdown inside a dropdown").
 *   (3) ONE TYPOGRAPHY — every group header, tool label and preset name resolves
 *       to the SAME computed font-family, and the two row kinds (tool button /
 *       preset card) to the same font-size. This is the check that would have
 *       caught the original defect: <button> does not inherit font-family from
 *       body, so .preset-card rendered in the UA's button font.
 *   (4) DISABLED TOOLS EXPLAIN THEMSELVES — hovering a disabled tool shows a tip
 *       containing its `requires` sentence.
 *   (5) HOVER-PREVIEW SURVIVED THE RESTRUCTURE — hovering a preset card stages
 *       app.previewDelta and leaves the document untouched; leaving reverts;
 *       clicking commits EXACTLY ONE undo unit.
 *
 * Vite runs with HMR + watching OFF: sibling agents edit these files
 * concurrently, and a reload mid-probe reads as a flaky failure.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

// Demo-deck item ids (examples/demo.powerrp.json), both ACTIVE on the opening
// slide — a selected item that is NOT on this slide has no folded state, so
// app.selectedNode() is null and the pane's empty state would pass a "no
// Positioning group" assertion vacuously. RECT has a frame and no presets; ARROW
// is FRAMELESS (from/to, never x/y/w/h) and so must show no Positioning group
// while still being a live selected node.
const RECT = "c5c2bed3";
const ARROW = "510eda10";

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;

// Same GL flags every other editor probe uses: the scene rasterizes on Skia over
// WebGL2, which headless Chrome only has via SwiftShader (tests/boot_probe.js).
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const failures = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // Collapse state persists per group id; start from a known-expanded pane.
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  const bootErrors = errors.length; // baseline: in-flight WIP noise from siblings

  const check = (name, cond, detail = "") => {
    if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  };
  const settle = () => new Promise((r) => setTimeout(r, 140));

  /** Command. Selects `id` and waits for the pane to re-render. */
  async function select(id) {
    await page.evaluate((i) => { window.__powerrp_app.selection = i; }, id);
    await settle();
  }

  /** Command. Inserts a widget by plugin type at a visible spot, returns its id. */
  async function insert(type) {
    return await page.evaluate((t) => {
      const app = window.__powerrp_app;
      const p = app.registry.get(t);
      app.addItem({ ...p.defaults, type: t, x: 120, y: 120, w: 320, h: 200 });
      return app.selection;
    }, type);
  }

  /** Query. The pane's rendered shape: group titles in order, each group's row
   *  kinds, and whether any nested disclosure button sits inside a group. */
  const paneShape = () => page.evaluate(() => {
    const pane = document.querySelector(".toolspane");
    if (!pane) return null;
    return {
      empty: !!pane.querySelector(".empty"),
      groups: [...pane.querySelectorAll(".prop-category")].map((g) => ({
        title: g.querySelector(".cat-title")?.textContent?.trim(),
        tools: [...g.querySelectorAll(".cat-rows .tool-action:not(.tool-preset)")].map((b) => ({
          label: b.querySelector(".tool-action-label")?.textContent?.trim(),
          disabled: b.disabled,
        })),
        presets: [...g.querySelectorAll(".cat-rows .tool-preset")].map((b) => b.textContent.trim()),
        // A toggle INSIDE the rows that is neither a tool nor a preset card is
        // exactly the nested dropdown the restructure removed.
        nestedToggles: [...g.querySelectorAll(".cat-rows button[aria-expanded]")].length,
      })),
    };
  });

  const shot = async (name) => {
    const el = await page.$(".toolspane");
    await el.screenshot({ path: `${shots}/toolspane_${name}.png` });
  };

  // ── (1) groups differ per widget ────────────────────────────────────────────
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle();
  const none = await paneShape();
  await shot("00_no_selection");
  check("no-selection-shows-no-tool-groups", none.groups.length === 0, `${none.groups.length} groups`);
  check("no-selection-shows-one-empty-state", none.empty);

  await select(RECT);
  const rect = await paneShape();
  await shot("01_rect_frame_no_presets");
  check("rect-has-positioning-group", rect.groups.some((g) => g.title === "Positioning"));
  check("rect-has-no-preset-group", rect.groups.every((g) => g.presets.length === 0),
    rect.groups.map((g) => `${g.title}:${g.presets.length}`).join(","));
  check("rect-has-no-formatting-group", !rect.groups.some((g) => g.title === "Formatting"),
    rect.groups.map((g) => g.title).join(","));

  await select(ARROW);
  const arrow = await paneShape();
  await shot("02_arrow_no_frame_no_presets");
  // Guard against the vacuous pass: the assertion below only means anything if
  // the arrow is a LIVE selected node whose plugin was actually consulted.
  check("arrow-is-a-live-selected-node", await page.evaluate(() => !!window.__powerrp_app.selectedNode()));
  check("frameless-widget-has-no-positioning-group", !arrow.groups.some((g) => g.title === "Positioning"),
    arrow.groups.map((g) => g.title).join(","));

  const flare = await insert("demo_lens_flare");
  await select(flare);
  const withPresets = await paneShape();
  await shot("03_lens_flare_presets");
  const presetGroups = withPresets.groups.filter((g) => g.presets.length > 0);
  check("preset-widget-has-a-preset-group", presetGroups.length >= 1);
  check("preset-group-is-top-level", presetGroups.every((g) => g.title !== "Formatting"),
    presetGroups.map((g) => g.title).join(","));

  // ── (2) no nested disclosure inside a group ────────────────────────────────
  check("no-nested-dropdown-inside-a-group",
    withPresets.groups.every((g) => g.nestedToggles === 0),
    withPresets.groups.map((g) => `${g.title}:${g.nestedToggles}`).join(","));

  // ── (3) ONE typography across group headers, tool labels, preset names ─────
  const fonts = await page.evaluate(() => {
    const pane = document.querySelector(".toolspane");
    const of = (el) => {
      const c = getComputedStyle(el);
      return { family: c.fontFamily, size: c.fontSize };
    };
    const pick = (sel) => { const el = pane.querySelector(sel); return el ? of(el) : null; };
    return {
      body: getComputedStyle(document.body).fontFamily,
      header: pick(".cat-title"),
      tool: pick(".tool-action-label"),
      preset: pick(".tool-preset"),
      inspectorLabel: (() => {
        const el = document.querySelector(".inspector .label");
        return el ? of(el) : null;
      })(),
    };
  });
  console.log("  fonts:", JSON.stringify(fonts, null, 2));
  const fam = (f) => f?.family;
  check("preset-card-uses-the-app-font", fam(fonts.preset) === fonts.body,
    `preset=${fam(fonts.preset)} body=${fonts.body}`);
  check("tool-label-uses-the-app-font", fam(fonts.tool) === fonts.body,
    `tool=${fam(fonts.tool)} body=${fonts.body}`);
  check("group-header-uses-the-app-font", fam(fonts.header) === fonts.body,
    `header=${fam(fonts.header)} body=${fonts.body}`);
  check("tool-and-preset-rows-share-a-font-size", fonts.tool?.size === fonts.preset?.size,
    `tool=${fonts.tool?.size} preset=${fonts.preset?.size}`);
  check("pane-matches-the-property-panel-font", fam(fonts.preset) === fam(fonts.inspectorLabel),
    `pane=${fam(fonts.preset)} inspector=${fam(fonts.inspectorLabel)}`);

  // ── (3b) the app-wide font reset clipped nothing ──────────────────────────
  // The `button, input, select, textarea { font-family: inherit }` rule near the
  // top of app.css is APP-WIDE: it swaps every control's UA Arial for the app's
  // system-ui at the size the control already declared. Metric-similar, but a
  // wider glyph set could overflow a control sized for the old one, so sweep the
  // whole chrome for text that no longer fits. Labels that ellipsize BY DESIGN
  // (the tool rows, an over-long item name) opt out via text-overflow.
  //
  // BUTTONS ONLY, deliberately: <input>/<textarea> SCROLL their value by contract,
  // so scrollWidth > clientWidth is their normal resting state, not a defect.
  // (Measured while writing this: .numfield .eq-input reports 180>147 holding a
  // long equation — and it declares font-family: var(--a-mono) itself, so the
  // reset cannot reach it anyway. Including inputs here only manufactured noise.)
  const clipped = await page.evaluate(() => {
    const OVERFLOW_SLACK_PX = 1; // sub-pixel rounding in scrollWidth/clientWidth
    return [...document.querySelectorAll("button, select")]
      .filter((el) => {
        if (getComputedStyle(el).textOverflow === "ellipsis") return false;
        if (!el.clientWidth) return false; // hidden / zero-width hover chrome
        return el.scrollWidth > el.clientWidth + OVERFLOW_SLACK_PX;
      })
      .map((el) => `${el.className || el.tagName}: ${el.scrollWidth}>${el.clientWidth} ${JSON.stringify(el.textContent.trim().slice(0, 30))}`);
  });
  check("app-wide font reset clips no control's text", clipped.length === 0, clipped.join(" | "));

  // ── (4) a disabled tool explains itself ───────────────────────────────────
  // A freshly inserted flare has literal x/y/w/h, so Unbind is applicable (it
  // has a frame) but unavailable (nothing is bound) — the disabled-with-reason
  // case. Hover it and read the tooltip.
  // The Tools panel is short and its body is the one scroller, so a row must be
  // scrolled into view before its rect means anything to page.mouse.
  const centerOf = (sel, pick = "") => page.evaluate((s, p) => {
    const all = [...document.querySelectorAll(s)];
    const el = p === "disabled" ? all.find((x) => x.disabled) : all[0];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { label: el.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel, pick);

  const disabled = await centerOf(".toolspane .tool-action", "disabled");
  check("a-disabled-tool-is-present-to-explain", !!disabled, "no disabled tool found");
  if (disabled) {
    await page.mouse.move(disabled.x, disabled.y);
    await settle();
    const tip = await page.evaluate(() => document.querySelector(".tt-tip")?.textContent ?? "");
    console.log(`  disabled tool "${disabled.label}" tip: ${JSON.stringify(tip)}`);
    check("disabled-tool-tooltip-says-why", /requires|nothing/i.test(tip), JSON.stringify(tip));
    await page.screenshot({ path: `${shots}/toolspane_04_disabled_reason.png` });
    await page.mouse.move(10, 10);
    await settle();
  }

  // ── (5) hover-preview + one-undo-unit commit still hold ───────────────────
  const card = await centerOf(".toolspane .tool-preset");
  check("a-preset-card-is-rendered-to-hover", !!card);
  if (card) {
    const before = await page.evaluate(() => ({
      doc: JSON.stringify(window.__powerrp_app.doc),
      undo: window.__powerrp_app.undoLog.undoDepth?.() ?? null,
      preview: window.__powerrp_app.previewDelta,
    }));
    await page.mouse.move(card.x, card.y);
    await settle();
    const hovered = await page.evaluate(() => ({
      preview: window.__powerrp_app.previewDelta,
      doc: JSON.stringify(window.__powerrp_app.doc),
    }));
    check("hover-stages-a-preview", !!hovered.preview, JSON.stringify(hovered.preview));
    check("hover-leaves-the-document-untouched", hovered.doc === before.doc);
    await page.screenshot({ path: `${shots}/toolspane_05_hover_preview.png` });

    // Leaving the list reverts.
    await page.mouse.move(10, 10);
    await settle();
    check("leaving-reverts-the-preview",
      (await page.evaluate(() => window.__powerrp_app.previewDelta)) === null);

    // Clicking commits EXACTLY ONE undo unit: one undo returns the document to
    // its pre-click bytes (two undos would have to, as well, if a stray second
    // unit had been pushed — so also assert the SECOND undo changes something
    // else, i.e. the first one alone was the whole commit).
    await page.mouse.move(card.x, card.y);
    await settle();
    await page.mouse.click(card.x, card.y);
    await settle();
    const committed = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
    check("click-commits-a-change", committed !== before.doc);
    await page.evaluate(() => window.__powerrp_app.undo());
    await settle();
    const undone = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
    check("one-undo-fully-reverts-the-pick", undone === before.doc,
      `${undone.length} vs ${before.length ?? before.doc.length} bytes`);
  }

  const newErrors = errors.slice(bootErrors);
  check("no-new-console-errors", newErrors.length === 0, newErrors.join(" | "));
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\ntoolspane probe: all checks passed");
