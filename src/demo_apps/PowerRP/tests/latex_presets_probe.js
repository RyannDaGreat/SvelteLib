/**
 * THE `latex` PRESET LIBRARIES probe — in the BOOTED EDITOR, because there is no
 * other option: MathJax needs a DOM, so a bare-node render of this widget draws
 * nothing at all. Its five sibling text widgets are gated in bare node by
 * tests/text_presets_test.js; this one cannot join them.
 *
 * Run from anywhere (paths resolve off import.meta.url, never the cwd):
 *   node src/demo_apps/PowerRP/tests/latex_presets_probe.js [shot_dir]
 *
 * Shape from tests/aperture_presets_probe.js — server with HMR off, the real
 * hover -> preview -> commit path, the SHARED distinctness metric
 * (tests/imageDistinctness.js) rather than a byte digest. Two checks are this
 * widget's own and neither exists anywhere else:
 *
 *   (3) EVERY SHIPPED EQUATION TYPESETS CLEAN, AND "CLEAN" MEANS MORE THAN "NO
 *       ERROR BOX". The widget's loud red affordance fires on an merror node, and
 *       an UNDEFINED MACRO produces none: MathJax emits the macro's own name as
 *       ordinary glyphs inside a perfectly well-formed, correctly-sized SVG, so
 *       latexErrorFor returns null and nothing warns. It is worse in this widget
 *       than in MathJax alone, because the `ink` tint is applied to EVERY glyph —
 *       so even MathJax's own red is painted over and the failure renders as
 *       ordinary black mathematics that happens to read "\oiint". This check goes
 *       to the page's OWN MathJax and looks for both signals, with two controls
 *       (see LATEX_CONTROLS) so it cannot pass vacuously.
 *
 *   (6) EVERY KNOB THE TREATMENT FAMILY VARIES ACTUALLY MOVES PIXELS. This is here
 *       because the obvious design for that family — order it by `fontSize` — was
 *       written and then MEASURED FALSE: at a fixed box, emit() places the quad at
 *       the WIDGET BOX and draws it with preserveAspect, so the glyph paths are fit
 *       to the box and fontSize reaches only the raster cache bucket. Rendered at a
 *       fixed 900x420 box, fontSize 22 against 200 came back maxAbs 0 — byte
 *       identical — while ink over the same frames moved 175. Rather than pin that
 *       one defect (which would lock the bug in), this check states the general
 *       rule: for each key the family VARIES, swap just that key between two rows
 *       and require the picture to change. A knob written off in every row for
 *       overlay completeness is exempt, since it is not making a claim.
 *
 * The rest: (1) both families are listed, in the plugin's order, under their own
 * titles; (2) each row's tip is its own description; (4) every preset renders
 * distinguishably from every sibling AND from the un-hovered baseline; (5) hover is
 * free and a click is exactly one undo.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { closestPair, imageDistance, indistinguishable, readPng } from "./imageDistinctness.js";
import { latexPlugin } from "../plugins/latex.js";
import { presetFamiliesOf } from "../core/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const svelteLib = resolve(powerRP, "../../..");
const webRoot = resolve(powerRP, "web");
const demoJson = await readFile(resolve(powerRP, "examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? resolve(powerRP, ".claude_vlm_checks/latex_presets");
await mkdir(shots, { recursive: true });

const FAMILIES = presetFamiliesOf(latexPlugin);
// A wide box straddling a LIGHT half and a DARK half. An equation is CENTRED and
// letterboxed into its box by preserveAspect — it does not pick a side the way an
// aligned text box does — so one straddling box gives every ink in the treatment
// family, near-black through cream, contrasting ground under part of itself.
const BOX = { x: 240, y: 130, w: 960, h: 420 };
const LIGHT_HALF = { type: "rect", x: 180, y: 70, w: 540, h: 540, fill: "#f2efe6", strokeWidth: 0 };
const DARK_HALF = { type: "rect", x: 720, y: 70, w: 540, h: 540, fill: "#12141c", strokeWidth: 0 };
// ToolsPane.svelte's tip when a preset declares no description — the string check
// (2) must NOT see. Reported as the diagnosis, never asserted on.
const GENERIC_TIP = (name) => `Apply the ${name} preset to the current frame`;
// One rAF-plus-raster of slack after a hover. A NEW equation source additionally
// needs an async typeset, which is waited for by condition rather than slept at.
const SETTLE_MS = 320;
const TYPESET_TIMEOUT_MS = 20000;
// Generous because it covers a COLD Vite dependency optimize, which on a shared
// tree can take minutes and would otherwise look like a broken editor.
const BOOT_TIMEOUT_MS = 180000;
// THE CONTROLS FOR CHECK (3). A gate that only ever sees good input proves nothing,
// and this one's first draft passed \oiint — which is exactly the failure it
// exists to catch, because that macro DOES NOT EXIST and produces no merror node.
// `clean` must come back with neither signal; `redGlyphs` must be caught by the red
// fill and NOT by merror; `merror` must be caught by merror.
const LATEX_CONTROLS = [
  { kind: "clean", latex: "a^2 + b^2 = c^2", wantMerror: false, wantRed: false },
  { kind: "undefined macro", latex: "\\oiint_{\\partial V} \\mathbf{E}", wantMerror: false, wantRed: true },
  { kind: "syntax error", latex: "\\frac{1}{", wantMerror: true, wantRed: false },
];
// Check (6) skips a key no row varies: written off in all ten purely so the overlay
// cannot leak, it makes no claim and has nothing to be observable about.
const OBSERVABILITY_FAMILY = "presets.treatment";
// What check (6) will accept as proof that a knob is observable, in 8-bit code
// values. The DERIVABLE floor is 1 — below it no display can show the pair apart —
// but 1 is too weak here: an unframed row's `stroke` and `cornerRadius` both nudge a
// handful of antialiased pixels without the frame they describe ever appearing, and
// that would pass a floor of 1 while proving nothing about the knob. 20 of 255 is
// ~8%, which is a frame that is actually drawn.
const STRONG_WITNESS = 20;
// Renders are ~1.5 s each and the pair space is quadratic in the table, so the
// search is bounded. Every knob below is found within a handful of swaps; a knob
// that needs more than this to show itself is not one a preset should headline.
const OBSERVABILITY_MAX_PAIRS = 12;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  root: webRoot,
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;

const browser = await launchBrowser();
const failures = [];
const errors = [];
/** Command. Records one check's outcome and prints it. */
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};

/**
 * Pure function. The keys a family VARIES — written with more than one distinct
 * value across its rows. Derived, so a knob that starts varying tomorrow is
 * demanded to be observable with no edit here.
 *
 * @param {object[]} presets - one family's presets
 * @returns {string[]} keys, in the first row's key order
 *
 * @example varyingKeys([{props: {ink: "#000", opacity: 1}}, {props: {ink: "#fff", opacity: 1}}])
 * // ["ink"]
 */
function varyingKeys(presets) {
  return Object.keys(presets[0]?.props ?? {}).filter((key) =>
    new Set(presets.map((p) => JSON.stringify(p.props[key]))).size > 1);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  page.setDefaultNavigationTimeout(BOOT_TIMEOUT_MS);
  // WAIT FOR THE APP, do not sleep at it, and do not wait on networkidle0 either:
  // a cold dep-optimize reloads the page after it, so both a fixed delay and that
  // lifecycle event race the boot and die on `window.__powerrp_app` undefined — a
  // failure that reads exactly like a broken app and is not one.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  await new Promise((r) => setTimeout(r, SETTLE_MS * 3));
  const bootErrors = errors.length; // baseline: in-flight WIP noise from siblings

  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  const staged = await page.evaluate(({ light, dark, box }) => {
    const app = window.__powerrp_app;
    for (const spec of [light, dark])
      app.addItem({ ...app.registry.get(spec.type).defaults, ...spec });
    app.addItem({ ...app.registry.get("latex").defaults, type: "latex", ...box });
    return app.selectedNode()?.state?.type ?? null;
  }, { light: LIGHT_HALF, dark: DARK_HALF, box: BOX });
  check("a latex widget is selected over a light/dark ground", staged === "latex", String(staged));

  /** Query. Blocks until the selected latex widget emits its VECTOR op (the typeset
   * landed) rather than the raster stand-in or the error affordance. */
  const awaitTypeset = () => page.waitForFunction(() => {
    const app = window.__powerrp_app;
    const node = app.selectedNode();
    if (!node) return false;
    const ops = app.registry.get("latex").emit(node.state, null, node.world);
    return ops.some((o) => o.op === "latexVector");
  }, { timeout: TYPESET_TIMEOUT_MS }).then(() => true, () => false);

  /** Query. A PNG of the viewport's canvas region (what the preview actually drew). */
  const canvasShot = async () => (await page.$(".canvas-wrap")).screenshot();

  check("the first typeset landed", await awaitTypeset());
  await settle();

  // ── (1)(2) both families are listed, titled, ordered, and self-explaining ──
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll(".toolspane .prop-category")]
      .filter((g) => g.querySelector(".cat-rows .tool-preset"))
      .map((g) => ({
        title: g.querySelector(".cat-title")?.textContent?.trim(),
        labels: [...g.querySelectorAll(".cat-rows .tool-preset")].map((b) => b.textContent.trim()),
      })));
  check("both preset families are rendered as their own groups", groups.length === FAMILIES.length,
    `${groups.length} groups: ${groups.map((g) => g.title).join(" | ")}`);
  FAMILIES.forEach((family, i) => {
    check(`family ${i} is titled "${family.title}"`, groups[i]?.title === family.title, groups[i]?.title);
    check(`family ${i} lists every preset in the plugin's order`,
      JSON.stringify(groups[i]?.labels) === JSON.stringify(family.presets.map((p) => p.name)),
      `${groups[i]?.labels?.length} rows: ${groups[i]?.labels?.join(" | ")}`);
  });

  /** Query. The i-th preset row's viewport centre (over ALL families' rows, in pane
   * order), scrolled into view first. */
  const rowCenter = (i) => page.evaluate((idx) => {
    const el = [...document.querySelectorAll(".toolspane .tool-preset")][idx];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { label: el.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);

  // ── (3) every shipped equation typesets CLEAN ─────────────────────────────
  /**
   * Query (typesets in the page). Both failure signals for one source, from the
   * page's OWN MathJax — the same instance the widget uses.
   *
   * @param {string} latex - the equation source
   * @returns {Promise<{merror: boolean, red: number}>}
   */
  const typesetSignals = (latex) => page.evaluate((src) => {
    const svg = globalThis.MathJax.tex2svg(src, { display: true }).querySelector("svg");
    if (!svg) return { merror: true, red: 0 };
    return {
      merror: !!svg.querySelector('[data-mml-node="merror"]'),
      red: svg.querySelectorAll('[fill="red"], [stroke="red"]').length,
    };
  }, latex);

  for (const control of LATEX_CONTROLS) {
    const got = await typesetSignals(control.latex);
    check(`(control) a ${control.kind} behaves as this gate assumes`,
      got.merror === control.wantMerror && (got.red > 0) === control.wantRed,
      `merror ${got.merror} (want ${control.wantMerror}), red glyphs ${got.red} (want ${control.wantRed ? ">0" : "0"})`);
  }
  for (const preset of FAMILIES[0].presets) {
    const got = await typesetSignals(preset.props.latex);
    check(`"${preset.name}" typesets with no error node and no undefined macro`,
      !got.merror && got.red === 0,
      `merror ${got.merror}, ${got.red} red-filled glyphs — an undefined macro renders as its own name IN THE WIDGET'S INK and nothing warns`);
  }

  // ── (4)(5) sweep every row of every family ────────────────────────────────
  const docBefore = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const baseline = readPng(await (async () => { const b = await canvasShot(); await writeFile(`${shots}/00_defaults.png`, b); return b; })());
  let rowIndex = 0;
  for (const family of FAMILIES) {
    const frames = [{ name: "(widget defaults, no preview)", png: baseline }];
    for (const preset of family.presets) {
      const row = await rowCenter(rowIndex);
      check(`row ${rowIndex} is present`, !!row, preset.name);
      rowIndex++;
      if (!row) continue;
      await page.mouse.move(row.x, row.y);
      await settle();
      if (family.id === "presets.equations") await awaitTypeset();
      await settle();

      const hovered = await page.evaluate(() => ({
        preview: window.__powerrp_app.previewDelta,
        doc: JSON.stringify(window.__powerrp_app.doc),
        tip: document.querySelector(".tt-tip")?.textContent ?? "",
      }));
      check(`${preset.name}: hover stages a preview`, !!hovered.preview);
      check(`${preset.name}: hover leaves the document untouched`, hovered.doc === docBefore);
      check(`${preset.name}: tip is the preset's own description`,
        hovered.tip.includes(preset.description ?? "\0"),
        hovered.tip === GENERIC_TIP(preset.name) ? "showing ToolsPane's generic fallback" : JSON.stringify(hovered.tip.slice(0, 90)));

      const png = await canvasShot();
      const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      await writeFile(`${shots}/${family.id.replace(".", "_")}_${slug}.png`, png);
      const decoded = readPng(png);
      for (const seen of frames) {
        const distance = imageDistance(seen.png, decoded);
        check(`${preset.name}: distinguishable from ${seen.name}`, !indistinguishable(distance),
          `maxAbs ${distance.maxAbs} — no display can show these two apart`);
      }
      frames.push({ name: preset.name, png: decoded });

      await page.mouse.move(10, 10);
      await settle();
      const left = await page.evaluate(() => ({ preview: window.__powerrp_app.previewDelta, doc: JSON.stringify(window.__powerrp_app.doc) }));
      check(`${preset.name}: leaving reverts the preview`, left.preview === null, JSON.stringify(left.preview));
      check(`${preset.name}: still no document change after revert`, left.doc === docBefore);
    }
    // THE NARROWEST MARGIN in this family — reported, not asserted. The bound above
    // is the only one derivable without judgement; this is the number that tells an
    // author which two rows are converging, before they collide.
    const closest = closestPair(frames);
    if (closest)
      console.log(`\n  ${family.id}: closest pair "${closest.a}" vs "${closest.b}" — meanAbs ${closest.distance.meanAbs.toFixed(3)}, maxAbs ${closest.distance.maxAbs}, ${(closest.distance.fraction * 100).toFixed(1)}% of pixels differ\n`);
  }

  // ── (5b) a click is EXACTLY one undo unit ─────────────────────────────────
  const last = await rowCenter(rowIndex - 1);
  await page.mouse.move(last.x, last.y);
  await settle();
  await page.mouse.click(last.x, last.y);
  await settle();
  check("click commits a change", (await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc))) !== docBefore);
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  check("one undo fully reverts the pick",
    (await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc))) === docBefore);

  // ── (6) every knob the treatment family VARIES moves pixels ───────────────
  const treatment = FAMILIES.find((f) => f.id === OBSERVABILITY_FAMILY);
  check(`the observability check found "${OBSERVABILITY_FAMILY}"`, !!treatment);
  // The search below re-uses the same props maps many times over, and each render
  // costs a commit, a typeset wait and a screenshot. Memoized on the props map,
  // which is safe because this document is otherwise frozen for the whole check.
  const renderCache = new Map();
  /** Command (writes and commits through the real path, then screenshots; memoized). */
  const renderProps = async (props, label) => {
    const key = JSON.stringify(props);
    if (renderCache.has(key)) return renderCache.get(key);
    await page.evaluate((p) => {
      const app = window.__powerrp_app;
      const id = app.selectedNode().id;
      app.setPreview(Object.entries(p).map(([k, v]) => [["items", id, k], v]));
      app.commitPreview();
    }, props);
    await awaitTypeset();
    await settle();
    const png = await canvasShot();
    await writeFile(`${shots}/observability_${label}.png`, png);
    const decoded = readPng(png);
    renderCache.set(key, decoded);
    return decoded;
  };
  for (const key of varyingKeys(treatment.presets)) {
    let best = { maxAbs: -1, from: null, to: null };
    let attempts = 0;
    // Try each row as the BASE in turn, swapping only this key in from another row.
    // THE BASE MATTERS AND STOPPING AT THE FIRST HIT IS NOT GOOD ENOUGH: swapping
    // `stroke` on an UNFRAMED row moves almost nothing, which is a fact about that
    // row rather than about the knob, and an earlier version of this loop accepted
    // exactly that — it reported cornerRadius "observable" at maxAbs 8 from a pair
    // where the frame was 0 units wide, when the honest witness (a 2-unit frame
    // going square-to-rounded) is far larger. So it keeps searching until it finds a
    // STRONG witness, and reports the best it found either way.
    // SWEEP THE BASES FIRST, not the others: which row you start FROM is what
    // decides whether the knob can act at all, so the outer loop must be the one
    // that changes it. Nested the other way this ran out of budget on `stroke`
    // after thirteen swaps, all of them from unframed rows where a stroke colour
    // has nothing to colour — measured, and it is why the nesting is this way round.
    outer:
    for (const other of treatment.presets)
      for (const base of treatment.presets) {
        if (JSON.stringify(base.props[key]) === JSON.stringify(other.props[key])) continue;
        if (++attempts > OBSERVABILITY_MAX_PAIRS) break outer;
        const a = await renderProps(base.props, `${key}_base`);
        const b = await renderProps({ ...base.props, [key]: other.props[key] }, `${key}_swapped`);
        const distance = imageDistance(a, b);
        if (distance.maxAbs > best.maxAbs) best = { maxAbs: distance.maxAbs, from: base.name, to: other.name };
        if (distance.maxAbs >= STRONG_WITNESS) break outer;
      }
    check(`"${key}" moves pixels somewhere in the treatment table`, best.maxAbs >= STRONG_WITNESS,
      `the best of ${attempts} swaps was "${best.from}" -> "${best.to}" at maxAbs ${best.maxAbs} — a preset writing a knob the renderer all but ignores advertises an axis the picture does not have`);
    console.log(`      ${key.padEnd(14)} observable at maxAbs ${best.maxAbs} after ${attempts} swap(s) ("${best.from}" -> "${best.to}")`);
  }

  const newErrors = errors.slice(bootErrors);
  check("no new console errors", newErrors.length === 0, newErrors.join(" | "));
  console.log(`\n  ${FAMILIES.reduce((n, f) => n + f.presets.length, 0)} presets rendered; shots in ${shots.replace(svelteLib, ".")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nlatex preset probe: all checks passed");
