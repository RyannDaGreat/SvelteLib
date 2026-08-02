/**
 * NESTED-BACKDROP GUARD — a blurred surface may not sit inside another one.
 *
 * `backdrop-filter` makes an element a BACKDROP ROOT FOR ITS DESCENDANTS. A
 * descendant that declares its own `backdrop-filter` therefore samples THAT ROOT
 * rather than the page, so a popover hanging outside its blurred parent's box
 * blurs against nothing and the content behind it stays razor sharp.
 *
 * ── WHY THIS EXISTS AS A SEPARATE FILE FROM glass_blur_guard_test.js ─────────
 * That guard asks "does a rule painting a glass token also declare a blur?", and
 * it is good at it. It cannot see this defect, and the reason is structural
 * rather than a gap to patch: BOTH rules involved are individually CORRECT. The
 * toolbar declares a blur, the popover declares a blur, and the bug is only in
 * their DOM relationship. Its two documented blind spots were both about failing
 * to FIND a rule (custom-property indirection; not reading .svelte styles); this
 * is a third kind, and no per-rule scanner over CSS text can reach it, because
 * nesting is a fact about the rendered tree.
 *
 * So this is a BROWSER probe by necessity: it opens the real surfaces and walks
 * real ancestors through getComputedStyle.
 *
 * ── THE HISTORY, so the next author knows the cost ──────────────────────────
 * This is the THIRD recurrence of "a transparent surface with no working blur"
 * in the glass themes. #235 was the filmstrip asset picker; glass_blur_guard was
 * rewritten twice for the earlier two; and the user found this one himself, on
 * the default theme: "there is no blur behind the font selection box in the
 * canvas … which in this theme should be illegal. Please check that." The word
 * "illegal" is the request for this file.
 *
 * Run: node src/demo_apps/PowerRP/tests/nested_backdrop_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

/**
 * Each openable glass surface: how to open it, and what to measure once it is.
 * A surface added here is checked with no further edits — the point is that the
 * NEXT popover cannot quietly repeat this.
 */
const SURFACES = [
  {
    name: "canvas font picker (.fp-pop)",
    selector: ".fp-pop",
    // Enter text editing on a text widget — that is what raises the format
    // toolbar the picker lives in — then click the picker's trigger.
    open: async (page) => {
      const at = await page.evaluate(() => {
        const a = window.__powerrp_app;
        a.addItem(a.registry.get("text").defaults);
        const id = a.selection;
        a.setPreview([[["items", id, "x"], 400], [["items", id, "y"], 400], [["items", id, "text"], "EDIT ME"]]);
        a.commitPreview();
        const n = a.nodes().find((x) => x.itemId === id);
        const s = a.canvasActions.worldToScreen(n.state.x + 20, n.state.y + 10);
        const r = document.querySelector(".overlay").getBoundingClientRect();
        return { x: r.left + s.x, y: r.top + s.y };
      });
      await page.mouse.click(at.x, at.y, { clickCount: 2, delay: 30 });
      await new Promise((r) => setTimeout(r, 700));
      await page.evaluate(() => document.querySelector(".text-format-font .fp-trigger")?.click());
      await new Promise((r) => setTimeout(r, 600));
    },
  },
];

const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle2", timeout: 180000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  for (const surface of SURFACES) {
    await surface.open(page);
    const found = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const own = getComputedStyle(el).backdropFilter;
      const blurred = [];
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const bf = getComputedStyle(a).backdropFilter;
        if (bf && bf !== "none") blurred.push(a.className || a.tagName);
      }
      return { own, blurred };
    }, surface.selector);

    ok(found !== null, `${surface.name}: the surface opened and was found`);
    if (!found) continue;
    // Only a surface that blurs can be broken THIS way — one that paints opaque
    // has no backdrop to sample and is out of scope here.
    if (found.own === "none") { ok(true, `${surface.name}: paints opaque, no backdrop to lose`); continue; }
    // The message differs by outcome on purpose: a passing check that reads like a
    // complaint ("sits inside blurred ancestor(s) []") trains people to skim green
    // output, which is how a real red gets missed.
    ok(found.blurred.length === 0, found.blurred.length === 0
      ? `${surface.name}: blurs against the PAGE — no backdrop-root ancestor between it and the document`
      : `${surface.name}: declares "${found.own}" but sits inside blurred ancestor(s) ` +
        `${JSON.stringify(found.blurred)} — an ancestor with backdrop-filter is a BACKDROP ROOT, so this ` +
        `surface blurs against that root instead of the page and the content behind it stays sharp. ` +
        `Move the ancestor's blur to a ::before pseudo-element (see .text-format-toolbar::before), or portal ` +
        `this surface out of it.`);
  }

  console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
  const failed = checks.filter(([p]) => !p);
  if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exit(1); }
  console.log(`\n${checks.length} nested-backdrop checks passed over ${SURFACES.length} surface(s)`);
} finally {
  await browser.close();
  await server.close();
}
