/**
 * REGISTRY-SURFACING probe — the browser half of "the command registry is the
 * single action layer, and every surfacing is only a view of it".
 * (tests/toolbar_surfacing_test.js is the bare-node half: it proves the Toolbar
 * source cannot hold a label or an icon. This proves what actually renders.)
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/registry_ui_probe.js <shot_dir>
 *
 * WHAT IT PROVES:
 *   (1) EVERY Toolbar button's label and icon EQUAL its registry entry's, so a
 *       toolbar tip can no longer disagree with the palette row for the same
 *       command (it had drifted twice: "Copy item" vs Copy Item, "Zoom to fit
 *       camera" vs Zoom to Fit Camera, plus "Show Ghosts" vs Toggle Ghost
 *       Objects on the toggle row).
 *   (2) The key chip in a button's tip is the shortcut registry's binding for
 *       that command — the "blocker" that supposedly forced hand-written tips.
 *   (3) A DISABLED button says WHY, from the entry's own `requires`.
 *   (4) The blend-mode dropdown reads as SIX families: one caption per family,
 *       captions are unselectable, and all 26 options remain selectable.
 *   (5) Hover-preview survives the grouping: hovering an option stages
 *       previewDelta with the document UNCHANGED, and a click commits EXACTLY
 *       ONE undo unit.
 *
 * Vite runs with HMR + watching OFF: sibling agents edit these files
 * concurrently, and a reload mid-probe reads as a flaky failure.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Paths resolve from THIS FILE, never process.cwd() — the probe must not care
// which directory it was launched from.
const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const webRoot = resolve(powerRP, "web");
const demoJson = await readFile(resolve(powerRP, "examples/demo.powerrp.json"), "utf8");
const toolbarSrc = await readFile(resolve(webRoot, "Toolbar.svelte"), "utf8");
const shots = process.argv[2] ?? "/tmp";

// A demo-deck item that is ACTIVE on the opening slide, so it has folded state
// (a selected-but-absent item renders the Property Panel's not-created case and
// would pass the dropdown assertions vacuously).
const RECT = "c5c2bed3";

/**
 * Pure function. The command ids the Toolbar surfaces, read out of its own
 * `groups` declaration plus the `commandTip("id", …)` calls its bespoke toggle
 * buttons make. Parsing the source rather than hardcoding a list means a button
 * added to the Toolbar is covered by these checks automatically.
 *
 * @param {string} src - Toolbar.svelte source text
 * @returns {string[]} command ids, deduplicated, in source order
 *
 * @example toolbarCommandIds('const groups = [\n["undo", "redo"],\n];\n{@render commandTip("toggle-snap", "note")}')
 * // ["undo", "redo", "toggle-snap"]
 */
function toolbarCommandIds(src) {
  const groups = src.slice(src.indexOf("const groups = ["), src.indexOf("];", src.indexOf("const groups = [")));
  const ids = [...groups.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  for (const m of src.matchAll(/commandTip\("([a-z0-9-]+)"/g)) ids.push(m[1]);
  return [...new Set(ids)];
}

const ids = toolbarCommandIds(toolbarSrc);
if (ids.length < 20) throw new Error(`registry_ui_probe: only parsed ${ids.length} toolbar command ids — the parse broke, not the toolbar`);

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
  await page.setViewport({ width: 1500, height: 940 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // Start from a known-expanded Property Panel: collapse state persists per
  // category and the blend row lives under Effects.
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.inspectorCollapsed"));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 900));
  const bootErrors = errors.length; // baseline: in-flight WIP noise from siblings

  const check = (name, cond, detail = "") => {
    if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  // ── (1) label + icon come from the registry ────────────────────────────────
  // Compared BY COMMAND ID against the live registry, so this fails if a button
  // ever hardcodes a spelling again (which is what it used to do).
  const buttons = await page.evaluate((commandIds) => {
    const app = window.__powerrp_app;
    const bar = document.querySelector(".toolbar");
    const found = [...bar.querySelectorAll("button")];
    return commandIds.map((id) => {
      const cmd = app.commands.get(id);
      const el = found.find((b) => b.getAttribute("aria-label") === cmd.title);
      const glyphs = el ? [...el.querySelectorAll("iconify-icon")].map((i) => i.getAttribute("icon")) : [];
      return {
        id,
        title: cmd.title,
        icon: cmd.icon,
        requires: cmd.requires ?? null,
        gated: !!cmd.when,
        unavailable: !!cmd.when && !cmd.when(app),
        rendered: !!el,
        disabled: el ? el.disabled : null,
        glyphs,
        keys: app.shortcuts.commandKeys(id),
      };
    });
  }, ids);

  const missing = buttons.filter((b) => !b.rendered).map((b) => `${b.id} (expected label "${b.title}")`);
  check("every toolbar command renders a button labelled with its REGISTRY title", missing.length === 0, missing.join(" | "));

  // THE THREE ICON EXCEPTIONS, and each is a case the registry's single `icon`
  // string cannot express (the same three tests/toolbar_surfacing_test.js pins at
  // the source, so the two halves cannot drift):
  //   toggle-anchors    — magnet + X composite (round-11 user ruling)
  //   toggle-ghosts     — box + eye composite (manifest ARCHITECTURE PLAN #2)
  //   toggle-light-dark — a STATEFUL glyph naming the theme the click switches TO,
  //                       so what it draws depends on the live theme; the registry
  //                       entry carries the neutral both-states glyph the palette
  //                       shows. It is exempt from EQUALITY, not from having an
  //                       entry: it takes its label, tip and binding from the
  //                       registry like every other button, which is what the
  //                       label check above proves for it.
  // Each still has to draw SOMETHING, which is what the length check below asserts.
  const COMPOSITE = ["toggle-anchors", "toggle-ghosts"];
  const OWN_GLYPH = [...COMPOSITE, "toggle-light-dark"];
  const wrongIcon = buttons
    .filter((b) => b.rendered && !OWN_GLYPH.includes(b.id) && !(b.glyphs.length === 1 && b.glyphs[0] === b.icon))
    .map((b) => `${b.id}: drew ${JSON.stringify(b.glyphs)}, registry says "${b.icon}"`);
  check("every toolbar button draws its REGISTRY icon", wrongIcon.length === 0, wrongIcon.join(" | "));
  const glyphless = buttons
    .filter((b) => b.rendered && OWN_GLYPH.includes(b.id) && b.glyphs.length === 0)
    .map((b) => b.id);
  check("each of the three own-glyph buttons still draws a glyph", glyphless.length === 0, glyphless.join(" | "));
  const badComposite = buttons.filter((b) => COMPOSITE.includes(b.id) && b.glyphs.length !== 2).map((b) => `${b.id}: ${b.glyphs.length} glyphs`);
  check("the two documented composite icons still stack two glyphs", badComposite.length === 0, badComposite.join(" | "));

  // ── (2) the keybinding hint comes from the shortcut registry ───────────────
  // THE DISPROVEN BLOCKER. The old table hand-wrote 3 hints and omitted 4 the
  // registry already knew, so this asserts the registry supplies strictly more
  // than the transcription did.
  const bound = buttons.filter((b) => b.keys);
  check("the shortcut registry supplies bindings for the toolbar", bound.length >= 7, `${bound.length} bound: ${bound.map((b) => `${b.id}=${b.keys.join("+")}`).join(", ")}`);

  /** Command. Hovers the button for `id` and returns its tooltip text. */
  async function tipOf(id, title) {
    const at = await page.evaluate((t) => {
      const el = [...document.querySelectorAll(".toolbar button")].find((b) => b.getAttribute("aria-label") === t);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, title);
    if (!at) return null;
    await page.mouse.move(at.x, at.y);
    await settle();
    const tip = await page.evaluate(() => {
      const el = document.querySelector(".tt-tip");
      return el ? { text: el.textContent.trim(), keys: el.querySelector(".cmd-tip-keys kbd")?.textContent?.trim() ?? null } : null;
    });
    return tip;
  }

  const undoTip = await tipOf("undo", buttons.find((b) => b.id === "undo").title);
  check("a bound button's tip carries a KeyCombo chip", !!undoTip?.keys, JSON.stringify(undoTip));
  check("the tip's title is the registry title", undoTip?.text?.startsWith("Undo"), JSON.stringify(undoTip?.text));
  await page.screenshot({ path: `${shots}/toolbar_01_tip_with_keybinding.png` });

  // ── (3) a disabled button explains itself ─────────────────────────────────
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle();
  const gated = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return [...document.querySelectorAll(".toolbar button")]
      .filter((b) => b.disabled)
      .map((b) => b.getAttribute("aria-label"));
  });
  check("clearing the selection disables the selection-gated buttons", gated.length >= 3, gated.join(", "));
  await page.screenshot({ path: `${shots}/toolbar_02_disabled_no_selection.png` });

  // PENDING HANDBACK: `requires` lives on the command entry in web/App.svelte,
  // which another agent owns this round. The RENDER PATH is proven here by
  // injecting the sentence the handback patch adds, so the day the patch lands
  // nothing else has to change. Injecting into the live entry is exactly what
  // the patch does statically.
  const REQUIRES_PROBE = "a selected widget (nothing is selected right now)";
  const copyTitle = buttons.find((b) => b.id === "copy-item").title;
  await page.evaluate((sentence) => { window.__powerrp_app.commands.get("copy-item").requires = sentence; }, REQUIRES_PROBE);
  const copyTip = await tipOf("copy-item", copyTitle);
  check("a disabled button's tip says WHY, from the entry's own `requires`",
    copyTip?.text?.includes(`Unavailable — requires ${REQUIRES_PROBE}`), JSON.stringify(copyTip?.text));
  await page.screenshot({ path: `${shots}/toolbar_03_disabled_reason.png` });
  await page.evaluate(() => { delete window.__powerrp_app.commands.get("copy-item").requires; });
  await page.mouse.move(6, 400);
  await settle();

  // Report (never assert) which gated toolbar commands still lack a reason — the
  // exact list the handback patch must cover. tests/toolbar_surfacing_test.js
  // pins it, so it cannot silently grow.
  console.log(`  PENDING HANDBACK (gated, no \`requires\` yet): ${buttons.filter((b) => b.gated && !b.requires).map((b) => b.id).join(", ")}`);

  // ── (4) the blend dropdown reads as six families ──────────────────────────
  /** Command. Selects the rect and opens its Blend mode dropdown. Returns false
   *  when the row is not on screen (a real failure, never a skip). */
  async function openBlendMenu() {
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, RECT);
    await settle();
    const ok = await page.evaluate(() => {
      // The blend row is the select row labelled "Blend mode" under Effects.
      const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.textContent.includes("Blend mode"));
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      row.querySelector(".dd-trigger").click();
      return true;
    });
    await settle();
    return ok;
  }

  /** Command. Screenshots just the open menu, optionally scrolled to a fraction
   *  of its own scroll height first (the list is height-capped and scrolls). */
  async function shotMenu(name, scrollFraction = 0) {
    await page.evaluate((f) => {
      const list = document.querySelector(".inspector .row .dd-menu .dd-list");
      list.scrollTop = f * (list.scrollHeight - list.clientHeight);
    }, scrollFraction);
    await settle();
    const el = await page.$(".inspector .row .dd-menu");
    await el.screenshot({ path: `${shots}/${name}.png` });
  }

  // BEFORE/AFTER from the SAME build: dropping `optionGroups` off the live row
  // reproduces exactly the flat 26-row list this task replaced (the Inspector then
  // renders the row's plain `options`), so the two shots differ in nothing else.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const row = app.registry.get("rect").inspector.find((r) => r.key === "blendMode");
    window.__probeSavedGroups = row.optionGroups;
    delete row.optionGroups;
    app.selection = null; // force the Inspector to rebuild from the mutated row
  });
  await settle();
  check("the Blend mode row is present and its dropdown opens", await openBlendMenu());
  const flat = await page.evaluate(() => document.querySelectorAll(".inspector .row .dd-insert").length);
  check("BEFORE: without optionGroups the list is flat (no captions at all)", flat === 0, `${flat} captions`);
  await shotMenu("blend_00_flat_before");
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.registry.get("rect").inspector.find((r) => r.key === "blendMode").optionGroups = window.__probeSavedGroups;
    app.selection = null;
  });
  await settle();
  const opened = await openBlendMenu();
  check("the grouped Blend mode dropdown opens", opened);

  const menu = await page.evaluate(() => {
    const dd = [...document.querySelectorAll(".inspector .row .dd")].find((d) => d.querySelector(".dd-menu"));
    if (!dd) return null;
    const rows = [...dd.querySelectorAll(".dd-list > li")];
    const captionStyle = (() => {
      const c = getComputedStyle(dd.querySelector(".dd-insert"));
      return { transform: c.textTransform, size: c.fontSize, borderTop: c.borderTopWidth, color: c.color };
    })();
    const catHeader = document.querySelector(".inspector .cat-header");
    return {
      captions: rows.filter((li) => li.classList.contains("dd-insert")).map((li) => li.textContent.trim()),
      options: rows.filter((li) => li.classList.contains("dd-item")).length,
      // A caption must be aria-hidden + role=presentation, i.e. not an option.
      captionsAreNotOptions: rows.filter((li) => li.classList.contains("dd-insert")).every((li) => li.getAttribute("role") === "presentation"),
      firstIsCaption: rows[0]?.classList.contains("dd-insert") ?? false,
      firstCaptionBorder: getComputedStyle(rows[0]).borderTopWidth,
      captionStyle,
      catHeaderStyle: catHeader ? { transform: getComputedStyle(catHeader).textTransform, size: getComputedStyle(catHeader).fontSize } : null,
    };
  });
  check("the menu renders one caption per family", menu?.captions.length === 6, JSON.stringify(menu?.captions));
  check("all 26 modes are still selectable rows", menu?.options === 26, `${menu?.options} options`);
  check("captions are presentation rows, never options", !!menu?.captionsAreNotOptions);
  check("a family caption leads the list", !!menu?.firstIsCaption);
  check("the FIRST caption draws no boundary rule (the menu edge is the boundary)",
    menu?.firstCaptionBorder === "0px", menu?.firstCaptionBorder);
  check("the family caption speaks the app's section-heading voice (uppercase, --a-font-sm)",
    menu?.captionStyle.transform === "uppercase" && menu?.captionStyle.size === menu?.catHeaderStyle?.size,
    JSON.stringify({ caption: menu?.captionStyle, catHeader: menu?.catHeaderStyle }));
  await page.screenshot({ path: `${shots}/blend_01_grouped_menu.png` });
  // The menu alone, top and middle, so the interior family boundaries are legible.
  await shotMenu("blend_01a_menu_top", 0);
  await shotMenu("blend_01b_menu_middle", 0.45);

  // ── (5) hover-preview across the grouping ─────────────────────────────────
  // Arrow keys must SKIP captions (Dropdown's own contract) and every option must
  // still preview. Hover the LAST family's first option — the furthest one from
  // the top, i.e. the one a broken insert-skip would land wrong on.
  const before = await page.evaluate(() => ({ doc: JSON.stringify(window.__powerrp_app.doc) }));
  const hovered = await page.evaluate(() => {
    const dd = [...document.querySelectorAll(".inspector .row .dd")].find((d) => d.querySelector(".dd-menu"));
    const items = [...dd.querySelectorAll(".dd-item")];
    const target = items[items.length - 1]; // "Luminosity" — last option of the last family
    target.scrollIntoView({ block: "center" });
    const r = target.getBoundingClientRect();
    return { label: target.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(hovered.x, hovered.y);
  await settle();
  const during = await page.evaluate(() => ({
    doc: JSON.stringify(window.__powerrp_app.doc),
    preview: JSON.stringify(window.__powerrp_app.previewDelta ?? null),
  }));
  check("hovering an option in the LAST family stages a preview", during.preview !== "null" && during.preview !== JSON.stringify(null),
    `previewDelta=${during.preview?.slice(0, 120)}`);
  check("the document is UNCHANGED mid-hover", during.doc === before.doc);
  await page.screenshot({ path: `${shots}/blend_02_hover_preview.png` });

  await page.mouse.click(hovered.x, hovered.y);
  await settle();
  const after = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return {
      value: app.state().items[app.selection]?.blendMode ?? null,
      preview: app.previewDelta ?? null,
    };
  });
  check("clicking commits the previewed mode", after.value === "luminosity", `blendMode=${after.value} (hovered "${hovered.label}")`);
  check("the preview is cleared by the commit", after.preview === null);
  // ONE undo unit: a single undo must restore the mode the row started at.
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  const undone = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return app.state().items[app.selection]?.blendMode ?? null;
  });
  check("ONE undo restores the previous mode (exactly one undo unit)", undone === "normal", `after undo: ${undone}`);

  const newErrors = errors.slice(bootErrors);
  check("no page errors during the probe", newErrors.length === 0, newErrors.join(" | "));
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nRESULT: PASS — every Toolbar button is a view of its registry entry; the blend dropdown reads as six families and still hover-previews`);
