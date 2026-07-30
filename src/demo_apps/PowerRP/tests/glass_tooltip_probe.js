/**
 * GLASS TOOLTIP PROBE — the tooltip and the command palette are made of ONE
 * material in a glass theme, and tooltips are BYTE-UNCHANGED everywhere else.
 *
 * What this pins, and why each half matters:
 *
 *  1. SHARED RECIPE, NOT A COPY. In both glass themes (Nocturne, Daybreak) the
 *     .tt-tip and the .palette must report the SAME computed backdrop-filter.
 *     Comparing the computed values (rather than checking each is "some blur")
 *     is what makes this a test of the shared --a-glass-blur token: if someone
 *     later hard-codes a blur on either surface, the two drift and this fails.
 *
 *  2. THE NO-OP CONTRACT. Every non-glass theme's tooltip must have NO
 *     backdrop-filter at all. This is the guarantee that adding the glass rule
 *     to app.css did not quietly restyle 24 other themes — the rule is written
 *     to fall through var() fallbacks to exactly what Tooltip.svelte already
 *     computed, and this half is what proves the fallbacks actually fall.
 *     Checked by CAPTURING each tooltip property under a non-glass theme BEFORE
 *     any glass theme is applied and re-asserting it after, so a regression that
 *     leaked glass into the base rule cannot pass by being consistently wrong.
 *
 *  3. THE WARNING-WASH-ON-GLASS INTERPLAY. The static-mode storage-local tip
 *     carries a 12%-alpha wash. Layered over glass it must keep BOTH: an
 *     opaque-ish surface under the wash (or the warning text sits on blurred
 *     slide art) AND legible warning ink. Asserted as: the tip's background
 *     resolves to TWO layers, the theme's dense tip tint is the bottom one, and
 *     the ink CLEARS A CONTRAST FLOOR against the surface it actually composites
 *     over — including the worst-case backdrop (see WARNING_INK_FLOOR).
 *
 *     THE TINT IS NOT "GOLD", AND ASSUMING IT WAS IS THE TRAP THIS PINS.
 *     --a-storage-local-* derive from --a-modifier, which every theme re-bases on
 *     purpose (Nord purple, Dracula pink, Tokyo Night purple, Nocturne #bb9af7,
 *     Daybreak #7b3fa0). Gold is what GRAPHITE's instance of that token looks
 *     like, not a cross-theme invariant — so a probe that asserted a hue would
 *     fail 20-odd themes that are behaving exactly as designed. What must hold
 *     across themes is READABILITY, which is what is measured here.
 *
 * Spawns its OWN isolated Vite + headless Chromium (the tooltip_singleton_probe
 * pattern). Run from POWERRP or the SvelteLib root.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

// The themes that opt into glass (app.css sets --a-glass-tip-bg in exactly
// these blocks), and a spread of ones that must NOT have been touched.
// Platinum is in the control set DELIBERATELY and is the sharpest case in it:
// it sets --a-glass-rim to a white bevel, so any implementation that inferred
// "is glass" from the rim or from a non-default shadow instead of from the
// opt-in token would hand it a blurred tooltip. Its metal is opaque.
const GLASS_THEMES = ["nocturne", "daybreak"];
const OPAQUE_THEMES = ["graphite", "light", "platinum", "eink", "ember"];

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" }, logLevel: "silent" });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The floor the warning ink must clear against the surface it COMPOSITES over,
   evaluated at the worst backdrop the tip can float on (pure black and pure
   white slide art both get checked; the lower result is the one asserted).
   3.0 rather than 4.5 because this is the pathological case — a translucent tip
   pinned over maximally hostile art — and the tip's own tint is >=0.82 opaque,
   so the realistic backdrop lands far above it (measured: 4.05-7.52 across the
   three themes here). A regression that thinned the tip tint or lightened the
   ink toward its own surface is what this catches. */
const WARNING_INK_FLOOR = 3.0;
/* app.css: --a-storage-local-bg is `color-mix(in srgb, var(--a-modifier) 12%,
   transparent)`. Read back from the live computed style below rather than
   trusted from here — this constant only names the expected value so a drift
   between the two fails loudly instead of silently re-basing the measurement. */
const WARNING_WASH_ALPHA = 0.12;
const EXTREME_BACKDROPS = { "black art": [0, 0, 0], "white art": [255, 255, 255] };

/** Pure function. Parses a CSS rgb()/rgba() string to [r, g, b, a].
 *  >>> parseRgb("rgba(21, 26, 35, 0.82)")  // [21, 26, 35, 0.82] */
const parseRgb = (c) => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`parseRgb: not an rgb() colour: ${c}`);
  const p = m[1].split(",").map((v) => parseFloat(v));
  return [p[0], p[1], p[2], p[3] ?? 1];
};

/** Pure function. Relative luminance (WCAG 2.1) of an [r,g,b] 0-255 triple.
 *  >>> relLuminance([255, 255, 255])  // 1 */
const relLuminance = ([r, g, b]) => {
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** Pure function. WCAG contrast ratio between two opaque [r,g,b] triples.
 *  >>> contrastRatio([255,255,255], [0,0,0])  // 21 */
const contrastRatio = (a, b) => {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Pure function. Source-over composite of [r,g,b] at `alpha` onto an opaque bg.
 *  >>> srcOver([255,255,255], 0.5, [0,0,0])  // [127.5, 127.5, 127.5] */
const srcOver = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: 20000 });
  await sleep(1500);

  const setTheme = (id) => page.evaluate((id) => { document.documentElement.dataset.theme = id; }, id);

  // Per-theme surface tint of an UNMARKED tip, filled in as each theme is
  // visited and used as the expected under-layer for the gold-wash checks.
  const unmarked = {};

  /** Command (in-page). Opens a REAL tooltip on a real toolbar anchor and
   *  returns its computed style; closes it again so the next call is clean.
   *  Anchored on the PROJECT TITLE, which is always present — the save
   *  indicator is conditional on unsaved changes and disappears once the app
   *  settles, which made an earlier version of this probe crash intermittently. */
  const tipStyle = async () => {
    const s = await page.evaluate(() => {
      const anchor = document.querySelector(".doc-name")?.closest(".tt-anchor");
      if (!anchor) return { error: "no .doc-name anchor" };
      const r = anchor.getBoundingClientRect();
      anchor.dispatchEvent(new PointerEvent("pointerenter", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: false }));
      return null;
    });
    if (s?.error) throw new Error(s.error);
    // The tip is mounted by a Svelte effect, so it is not in the DOM in the
    // same tick as the pointerenter — wait for the element, never a flat sleep.
    await page.waitForSelector(".tt-tip", { timeout: 5000 });
    const out = await page.evaluate(() => {
      const tip = document.querySelector(".tt-tip");
      if (!tip) return { error: "tooltip did not open" };
      const cs = getComputedStyle(tip);
      return { backdropFilter: cs.backdropFilter, background: cs.backgroundColor, backgroundImage: cs.backgroundImage, radius: cs.borderTopLeftRadius, color: cs.color };
    });
    await page.evaluate(() => document.querySelector(".doc-name")?.closest(".tt-anchor")?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })));
    await sleep(60);
    if (out.error) throw new Error(out.error);
    return out;
  };

  /** Command (in-page). Opens the command palette, reads .palette's computed
   *  style, closes it with Escape. */
  const paletteStyle = async () => {
    await page.keyboard.down("Meta"); await page.keyboard.down("Shift");
    await page.keyboard.press("KeyP");
    await page.keyboard.up("Shift"); await page.keyboard.up("Meta");
    await sleep(250);
    const out = await page.evaluate(() => {
      const p = document.querySelector(".palette");
      if (!p) return { error: "palette did not open" };
      const cs = getComputedStyle(p);
      return { backdropFilter: cs.backdropFilter, background: cs.backgroundColor, radius: cs.borderTopLeftRadius };
    });
    await page.keyboard.press("Escape");
    await sleep(150);
    if (out.error) throw new Error(out.error);
    return out;
  };

  // ── BASELINE FIRST: capture the opaque-theme tooltip before any glass theme
  // has ever been applied in this page, so the control values are known-clean.
  await setTheme("graphite");
  const baseline = await tipStyle();
  unmarked.graphite = baseline.background;
  assert(baseline.backdropFilter === "none", `graphite tooltip has NO backdrop-filter (got ${baseline.backdropFilter})`);
  console.log(`  ..   baseline graphite tip: bg=${baseline.background} radius=${baseline.radius}`);

  // ── 1. GLASS THEMES: tip and palette share one material.
  for (const theme of GLASS_THEMES) {
    console.log(`\n-- ${theme}`);
    await setTheme(theme);
    const tip = await tipStyle();
    unmarked[theme] = tip.background;
    const pal = await paletteStyle();
    assert(tip.backdropFilter !== "none" && tip.backdropFilter.includes("blur"), `${theme}: tooltip HAS a backdrop blur (got ${tip.backdropFilter})`);
    assert(pal.backdropFilter !== "none" && pal.backdropFilter.includes("blur"), `${theme}: palette HAS a backdrop blur (got ${pal.backdropFilter})`);
    assert(tip.backdropFilter === pal.backdropFilter, `${theme}: tip and palette share the SAME blur token (tip=${tip.backdropFilter} palette=${pal.backdropFilter})`);
    // Translucent, i.e. actually glass and not an opaque pane that merely
    // declares a blur (a backdrop-filter under an opaque fill is invisible).
    const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); return m ? parseFloat(m[1].split(",")[3] ?? "1") : 1; };
    assert(alpha(tip.background) < 1, `${theme}: tooltip surface is TRANSLUCENT (got ${tip.background})`);
    assert(alpha(pal.background) < 1, `${theme}: palette surface is TRANSLUCENT (got ${pal.background})`);
    // The tip is denser than the palette — same material, tuned for small text.
    assert(alpha(tip.background) > alpha(pal.background), `${theme}: tip tint is DENSER than the palette's (tip=${alpha(tip.background)} palette=${alpha(pal.background)})`);
    // Rounded, but at tip scale rather than pane scale.
    const px = (v) => parseFloat(v);
    assert(px(tip.radius) > px(baseline.radius), `${theme}: tooltip is rounded (got ${tip.radius}, baseline ${baseline.radius})`);
    assert(px(tip.radius) < px(pal.radius), `${theme}: tip corner is TIGHTER than the pane's (tip=${tip.radius} palette=${pal.radius})`);
  }

  // ── 2. NON-GLASS THEMES: byte-unchanged tooltips.
  console.log("");
  for (const theme of OPAQUE_THEMES) {
    await setTheme(theme);
    const tip = await tipStyle();
    assert(tip.backdropFilter === "none", `${theme}: tooltip has NO backdrop-filter (got ${tip.backdropFilter})`);
    assert(tip.radius === baseline.radius, `${theme}: tooltip radius unchanged at ${baseline.radius} (got ${tip.radius})`);
    assert(tip.backgroundImage === "none", `${theme}: tooltip background is a single flat layer (got ${tip.backgroundImage})`);
  }

  // Returning to graphite must reproduce the pre-glass baseline EXACTLY — this
  // is what makes "byte-unchanged" a real claim rather than a snapshot of one
  // moment: the glass themes were applied in between.
  await setTheme("graphite");
  const after = await tipStyle();
  assert(JSON.stringify(after) === JSON.stringify(baseline), `graphite tooltip identical after cycling through glass themes (before ${JSON.stringify(baseline)} after ${JSON.stringify(after)})`);

  // ── 3. GOLD-ON-GLASS: the storage-local warning tip stays readable.
  // Drive it by MARKING a tip's content the way Toolbar.svelte does in static
  // mode (the class is the whole contract the :has() rule keys on), rather than
  // by booting a second app in static mode.
  console.log("");
  for (const theme of [...GLASS_THEMES, "graphite"]) {
    await setTheme(theme);
    // Open the tip and let Svelte actually mount it before touching it — the
    // tip is rendered by an effect, so it is NOT in the DOM in the same tick as
    // the pointerenter that requested it.
    await page.evaluate(() => {
      const anchor = document.querySelector(".doc-name")?.closest(".tt-anchor");
      const r = anchor.getBoundingClientRect();
      anchor.dispatchEvent(new PointerEvent("pointerenter", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: false }));
    });
    await sleep(120);
    const got = await page.evaluate(() => {
      const tip = document.querySelector(".tt-tip");
      if (!tip) return { error: "tooltip did not open" };
      // Mark it exactly as Toolbar.svelte does in static mode.
      const mark = document.createElement("span");
      mark.className = "storage-local-tip";
      tip.appendChild(mark);
      const cs = getComputedStyle(tip);
      // backgroundColor is the SECOND layer of the shorthand (the surface under
      // the wash); backgroundImage is the first (the wash itself). Both are
      // needed — reading only backgroundImage cannot see the surface at all,
      // which is how an earlier version of this probe asserted a tautology.
      return { backgroundImage: cs.backgroundImage, backgroundColor: cs.backgroundColor, color: cs.color, backdropFilter: cs.backdropFilter };
    });
    if (got.error) throw new Error(got.error);
    await page.evaluate(() => document.querySelector(".doc-name")?.closest(".tt-anchor")?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })));
    await sleep(60);
    // TWO layers: the warning wash as a gradient over the surface colour beneath.
    assert(got.backgroundImage.includes("gradient"), `${theme}: storage-local tip layers the warning wash OVER a surface (got ${got.backgroundImage})`);
    const layerCount = (got.backgroundImage.match(/gradient/g) || []).length;
    assert(layerCount === 1, `${theme}: exactly one warning wash layer (got ${layerCount})`);
    // THE SURFACE UNDER THE WASH must be the theme's own tip tint — checked
    // against the tint the UNMARKED tip reports in this same theme, so this
    // cannot pass by finding any colour at all. A regression that dropped the
    // second layer would leave backgroundColor transparent here.
    assert(got.backgroundColor === unmarked[theme], `${theme}: the wash sits on the theme's own tip surface (want ${unmarked[theme]}, got ${got.backgroundColor})`);
    if (GLASS_THEMES.includes(theme)) {
      assert(got.backdropFilter.includes("blur"), `${theme}: storage-local tip KEEPS the glass blur (got ${got.backdropFilter})`);
      // Dense enough that small warning text is not read against slide art.
      const a = parseRgb(got.backgroundColor)[3];
      assert(a >= 0.8, `${theme}: warning tip surface stays dense on glass (alpha ${a})`);
    }

    // THE READABILITY CLAIM ITSELF, for every theme including the opaque control.
    // Composite what the eye actually receives — the tip tint over the backdrop,
    // then the 12% warning wash over that — and contrast the ink against it. The
    // ink is read from the computed `color` (= --a-storage-local-ink), so this
    // tracks whatever hue a theme re-bases --a-modifier to instead of assuming
    // one. Both extreme backdrops are measured; the WORSE result is asserted.
    const ink = parseRgb(got.color).slice(0, 3);
    const [surf, surfAlpha] = [parseRgb(got.backgroundColor).slice(0, 3), parseRgb(got.backgroundColor)[3]];
    // The wash's REAL alpha, taken from the rendered gradient rather than
    // assumed, so this measures the tip the browser actually painted. Chrome
    // serialises the color-mix as `color(srgb r g b / a)`.
    const washMatch = got.backgroundImage.match(/color\(srgb[^/)]*\/\s*([0-9.]+)\)/);
    assert(washMatch != null, `${theme}: warning wash alpha is readable from the computed gradient (got ${got.backgroundImage})`);
    const washAlpha = washMatch ? parseFloat(washMatch[1]) : WARNING_WASH_ALPHA;
    assert(
      Math.abs(washAlpha - WARNING_WASH_ALPHA) < 0.005,
      `${theme}: warning wash is the documented ${WARNING_WASH_ALPHA} alpha (got ${washAlpha})`,
    );
    const measured = Object.entries(EXTREME_BACKDROPS).map(([label, back]) => {
      // What the eye receives: ink-over-(tip tint over art).
      const washed = srcOver(ink, washAlpha, srcOver(surf, surfAlpha, back));
      return { label, ratio: contrastRatio(ink, washed) };
    });
    const worst = measured.reduce((a, b) => (a.ratio < b.ratio ? a : b));
    assert(
      worst.ratio >= WARNING_INK_FLOOR,
      `${theme}: warning ink stays readable on its own wash — worst backdrop ${worst.label} at ${worst.ratio.toFixed(2)}:1 (floor ${WARNING_INK_FLOOR}) [${measured.map((m) => `${m.label} ${m.ratio.toFixed(2)}`).join(", ")}]`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`glass_tooltip_probe: ${fails.length} FAILED`); process.exit(1); }
console.log("\nglass_tooltip_probe: all checks passed");
