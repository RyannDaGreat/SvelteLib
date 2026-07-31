/**
 * COMMAND-PALETTE LIVE-PREVIEW PROBE — proves the general previewable-command
 * protocol (CommandPalette.svelte) through its first adopter, the theme
 * entries. Drives the REAL palette DOM (not app methods) so the mechanism under
 * test — the $effect that previews the HIGHLIGHTED entry (hover OR arrow),
 * reverts when focus moves off / the palette closes without selecting, and
 * commits on Enter/click — is exercised end to end.
 *
 * Asserts the APPLIED theme (documentElement[data-theme] + app.theme) changes
 * live on hover/arrow-focus, reverts to the previously-applied theme on move-
 * off / close, and commits (and PERSISTS to localStorage) on select — while a
 * mere preview never touches localStorage.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern
 * as text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
// hmr:false — an edit to app source mid-probe reloads the page and fails the
// run; see theme_probe.js's note for the observed failure.
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Ignore backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no
  // server.py), so best-effort thumbnail-persist POSTs 404. Orthogonal to themes.
  // "no WebGPU adapter" joins the existing whitelist: headless SwiftShader has
  // none, so videoV7 logs its own fallback notice every boot (and falls back
  // correctly). This probe was red at baseline for that reason alone.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|no WebGPU adapter|WebGPU init failed/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  // POLL, do not sleep-then-assume: boot is Skia-wasm + font-load bound, so its
  // duration is machine- and load-dependent. The old `sleep(3500)` + 10s wait
  // timed out whenever another browser probe was running beside this one.
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: 60000 });
  await sleep(400); // let the first paint settle before driving the palette
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Reads of the APPLIED theme state and the PERSISTED preference.
  const applied = () => page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    field: window.__powerrp_app.theme,
    stored: localStorage.getItem("powerrp.theme"),
  }));

  // Deterministic start: commit graphite as the persisted preference.
  await page.evaluate(() => window.__powerrp_app.setTheme("graphite"));
  const ORIGINAL = "graphite";
  assert((await applied()).stored === ORIGINAL, `start committed to "${ORIGINAL}"`);

  // Palette input driver. Opening sets paletteOpen; the component's $effect
  // focuses the input once it renders — poll for it, then type.
  const openPalette = async () => {
    await page.evaluate(() => (window.__powerrp_app.paletteOpen = true));
    await page.waitForSelector(".palette input", { timeout: 4000 });
    await sleep(120);
  };
  const typeQuery = async (text) => { await page.type(".palette input", text); await sleep(140); };
  const clearQuery = async () => {
    // Select-all + delete inside the palette input, then let the effect settle.
    await page.evaluate(() => { const el = document.querySelector(".palette input"); el.focus(); el.select(); });
    await page.keyboard.press("Backspace");
    await sleep(140);
  };
  const pressKey = async (key) => { await page.keyboard.press(key); await sleep(140); };
  // Drill from the top level into the "Color Theme" submenu.
  const enterThemeSubmenu = async () => { await typeQuery("color theme"); await pressKey("Enter"); await sleep(140); };

  // ── 1. ARROW-FOCUS previews LIVE (typing filters to one row → row 0 is the
  //      arrow/keyboard-focused entry → the effect previews it). ──────────────
  // THEMES ARE GROUPED BY FAMILY, and A FAMILY ROW NOW PREVIEWS — it declares
  // `preview` without `run`, which the registry permits (it validates only run
  // XOR children). This assertion is INVERTED from what it said before: the row
  // used to preview nothing, which is exactly the bug the polarity ruling names
  // ("even if I'm hovering over the menu for that theme, it should preview it").
  // Arrow-focusing the family row is also the KEYBOARD half of that ruling: the
  // palette's one preview effect keys off `highlighted`, which hover and the
  // arrow keys both drive, so proving it here proves both inputs.
  await openPalette();
  await enterThemeSubmenu();
  await typeQuery("synthwave");
  let s = await applied();
  assert(s.attr === "synthwave", `a FAMILY row previews its CURRENT-POLE member (attr=${s.attr})`);
  assert(s.stored === ORIGINAL, `a family-row preview does NOT persist (stored=${s.stored})`);
  await pressKey("Enter"); // into the Synthwave family; row 0 = its dark member
  s = await applied();
  assert(s.attr === "synthwave" && s.field === "synthwave", `arrow-focus previews LIVE (attr=${s.attr}, field=${s.field})`);
  assert(s.stored === ORIGINAL, `preview does NOT persist (localStorage still "${s.stored}")`);

  // ── 2. Focus moves OFF (Escape backs out to a non-previewable row) → revert.
  //      TWO levels now: family members -> family list -> top level. Reverting
  //      after the FIRST Escape is the assertion that matters (leaving a
  //      previewed member must not leave its theme applied).
  await pressKey("Escape");
  s = await applied();
  assert(s.attr === ORIGINAL && s.field === ORIGINAL, `focus-off reverts to "${ORIGINAL}" (attr=${s.attr})`);
  await pressKey("Escape"); // out of Color Theme, back to the top level

  // ── 3. Preview a theme, then CLOSE WITHOUT SELECTING (backdrop) → revert. ───
  await enterThemeSubmenu();
  await typeQuery("dracula");
  await pressKey("Enter"); // into the Dracula family (see the note in step 1)
  s = await applied();
  assert(s.attr === "dracula", `re-preview LIVE (attr=${s.attr})`);
  await page.evaluate(() => (window.__powerrp_app.paletteOpen = false)); // backdrop-equivalent close
  await sleep(160);
  s = await applied();
  assert(s.attr === ORIGINAL && s.stored === ORIGINAL, `close-without-select reverts to "${ORIGINAL}" (attr=${s.attr}, stored=${s.stored})`);

  // ── 4. HOVER (pointermove) previews, and moving to another row switches. ────
  await openPalette();
  await enterThemeSubmenu(); // empty query → every theme listed
  const rowIndex = async (title) => page.$$eval(".palette-item .title", (els, t) => els.findIndex((e) => e.textContent.trim() === t), title);
  const hoverRow = async (title) => {
    const i = await rowIndex(title);
    if (i < 0) throw new Error(`theme row "${title}" not found in submenu`);
    const rows = await page.$$(".palette-item");
    await rows[i].hover();
    await sleep(140);
  };
  // THEMES ARE NOW GROUPED BY FAMILY (web/app.svelte.js THEME_FAMILIES): the
  // "Color Theme" submenu lists one row per FAMILY, and each family row is a
  // container whose two children are its dark and light members. So a hover
  // target is "<Family> — Dark", not the bare family name — a family row has no
  // `run` and previews nothing, by the registry's run-XOR-children rule.
  // Drilling into one family first, then hovering its two poles, also exercises
  // the thing worth checking under the new shape: preview follows the MEMBER.
  // Drilling in CLEARS the query itself (CommandPalette's `if (cmd.children)`
  // branch sets query = ""), so no clearQuery() here — calling it would
  // select-all+Backspace and back out of the submenu entirely.
  await typeQuery("monokai");
  await pressKey("Enter"); // into the Monokai family; its two poles are listed
  await hoverRow("Monokai — Dark");
  s = await applied();
  assert(s.attr === "monokai", `HOVER previews LIVE (attr=${s.attr})`);
  await hoverRow("Monokai — Light");
  s = await applied();
  // RE-INVERTED (user ruling 2026-07-31: "Why is it that when I hover over the
  // light or dark it does not preview immediately? Once I click the theme and
  // I hover, they should also preview immediately."). A MEMBER row names its
  // pole, so it previews LITERALLY — the polarity lock previously applied here
  // made "— Light" from a dark base preview the dark member, i.e. visibly
  // nothing. The lock remains correct on FAMILY rows (ambiguous targets, step
  // 6) — skimming the family list still never strobes between poles.
  assert(s.attr === "monokai-light", `hovering a member row previews THAT member literally (attr=${s.attr})`);
  assert(s.stored === ORIGINAL, `hover previews still do NOT persist (stored=${s.stored})`);

  // ── 5. SELECT commits: click the hovered row → change stays AND persists. ───
  await pressKey("Escape"); // back out of Monokai to the family list
  await typeQuery("catppuccin");
  await pressKey("Enter"); // into the Catppuccin family
  const catppuccinRow = await (async () => { const i = await rowIndex("Catppuccin — Dark"); return (await page.$$(".palette-item"))[i]; })();
  await catppuccinRow.hover();
  await sleep(120);
  await catppuccinRow.click();
  await sleep(180);
  s = await applied();
  const closed = await page.evaluate(() => window.__powerrp_app.paletteOpen);
  assert(!closed, "palette closed after select");
  assert(s.attr === "catppuccin" && s.field === "catppuccin", `select COMMITS the applied theme (attr=${s.attr})`);
  assert(s.stored === "catppuccin", `commit PERSISTS to localStorage (stored=${s.stored})`);

  // ── 6. THE POLARITY LOCK, both poles, on the PINNED family (Ember). ─────────
  // USER RULING: "When I hover over the different themes — even if I'm hovering
  // over the menu for that theme — it should preview it. If we're dark, it
  // previews as dark; if we're light, it previews as light."
  //
  // So the SAME three hover targets (the family row, the dark member, the light
  // member) must all preview ONE theme: the member on the pole we are already
  // on. Run the whole set from a dark base and again from a light base — the
  // matrix is the assertion, since a rule that only holds from dark is the bug
  // this replaces, just facing the other way.
  // EMBER is named explicitly rather than looped over: it is the family whose
  // toggle regression the user reported (see tests/theme_family_probe.js), so a
  // failure here must say "Ember", not "family 20".
  for (const [base, pole, want] of [["graphite", "dark", "ember"], ["light", "light", "ember-light"]]) {
    await page.evaluate((t) => (window.__powerrp_app.paletteOpen = false), null);
    await page.evaluate((t) => window.__powerrp_app.setTheme(t), base);
    await openPalette();
    await enterThemeSubmenu();
    await typeQuery("ember");

    // (a) the FAMILY row — arrow-focused by the filter, i.e. the KEYBOARD path.
    s = await applied();
    assert(s.attr === want, `[${pole}] family row previews "${want}" (attr=${s.attr})`);

    // (b) HOVER the family row: same answer through the pointer path.
    await hoverRow("Ember");
    s = await applied();
    assert(s.attr === want, `[${pole}] HOVERING the family row previews "${want}" (attr=${s.attr})`);

    // (c) MEMBER rows preview LITERALLY (user ruling 2026-07-31 — a row named
    // "— Light" names its pole; the lock is for AMBIGUOUS targets only).
    // Drilling in auto-highlights the first child ("Ember — Dark"), so the
    // drill-in preview is that member's literal theme from EITHER base —
    // keyboard and pointer agree, which is the parity the palette guarantees.
    await pressKey("Enter"); // drill into Ember
    s = await applied();
    assert(s.attr === "ember", `[${pole}] drilling in previews the highlighted first member "ember" (attr=${s.attr})`);
    for (const [row, wantMember] of [["Ember — Dark", "ember"], ["Ember — Light", "ember-light"]]) {
      await hoverRow(row);
      s = await applied();
      assert(s.attr === wantMember, `[${pole}] hovering "${row}" previews its LITERAL member "${wantMember}" (attr=${s.attr})`);
    }
    assert(s.stored === base, `[${pole}] none of that persisted (stored=${s.stored})`);

    // (d) ESCAPE / close reverts all the way to the REAL theme — no leak.
    await page.evaluate(() => (window.__powerrp_app.paletteOpen = false));
    await sleep(180);
    s = await applied();
    assert(s.attr === base && s.field === base, `[${pole}] closing reverts to the real theme "${base}" (attr=${s.attr})`);
    assert(s.stored === base, `[${pole}] the persisted preference never moved (stored=${s.stored})`);
  }

  // ── 7. A CLICK IS A DECISION: committing the wrong-pole member APPLIES it. ──
  // The lock is on hovering only. From a DARK theme, clicking "Ember — Light"
  // must cross the pole and persist — otherwise the two member rows would be
  // unreachable by the only gesture that names them.
  await page.evaluate(() => window.__powerrp_app.setTheme("graphite"));
  await openPalette();
  await enterThemeSubmenu();
  await typeQuery("ember");
  await pressKey("Enter");
  const emberLightRow = await (async () => { const i = await rowIndex("Ember — Light"); return (await page.$$(".palette-item"))[i]; })();
  await emberLightRow.hover();
  await sleep(120);
  s = await applied();
  assert(s.attr === "ember-light", `pre-click hover previews the literal member (attr=${s.attr})`);
  await emberLightRow.click();
  await sleep(180);
  s = await applied();
  assert(s.attr === "ember-light" && s.field === "ember-light", `CLICKING the light member crosses the pole (attr=${s.attr})`);
  assert(s.stored === "ember-light", `and persists it (stored=${s.stored})`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nTHEME PREVIEW PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nTHEME PREVIEW PROBE PASSED — family rows preview POLARITY-LOCKED, member rows preview LITERALLY, from either pole; move-off & close revert, select commits + persists.");
} finally {
  await browser.close();
  await server.close();
}
