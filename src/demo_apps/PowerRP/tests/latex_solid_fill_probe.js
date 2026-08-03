/**
 * LATEX FILL MATRIX PROBE (WORKSTREAM AB) — every shape the Fill row can produce
 * must paint, on a REAL MathJax typeset.
 *
 * User, 2026-08-02, verbatim: "Why does solid result in unknown item failed to
 * paint, but linear is fine, radial is fine, off is fine, and even arbitrary
 * materials are fine on LaTeX?"
 *
 * THE BUG: `isShaderInk` asked `typeof ink === "object"` rather than what kind of
 * paint it is. The PaintField stores a solid as the multi-sub-state WRAPPER
 * {type:"solid", solid:"#rrggbb"} — an object — so an author's solid was routed
 * onto the SHADER path, where `parsePaint` resolved it to a plain colour and
 * `skShaderForPaint` refused it by name ("expected a gradient Paint (solid paints
 * use setColor, not a shader)"). paintNodeRun contains that throw as the red
 * "failed to paint" box, which is what the user saw. Every OTHER cell of the
 * matrix was excluded for its own separate reason, which is exactly why the
 * simplest case was the only broken one.
 *
 * WHY A BROWSER PROBE AND NOT ONLY tests/material_ink_test.js. That suite pins
 * the dispatch and renders the painter on the bare-node software surface, but it
 * drives HAND-BUILT glyph `d` strings, because MathJax needs a DOM. So it cannot
 * see anything that goes wrong between an author setting the row and the glyphs
 * existing — in particular the RASTER-TINT half of this fix, where the ink is
 * baked into the typeset SVG's `color` AND interpolated into the raster CACHE
 * KEY. Hand a wrapper to that and every equation keys under the literal string
 * "[object Object]": one cache slot for every colour, and an invalid CSS colour
 * so the glyphs typeset at the browser default. Only a real typeset shows it.
 *
 * WHAT IS ASSERTED, per cell of the matrix:
 *   PAINTS      no "failed to PAINT" report reaches the console, and no page
 *               error fires. This is the user's literal complaint.
 *   IS INK      the frame differs from an empty one, so a cell cannot pass by
 *               rendering nothing at all.
 *   AGREE       the two storage forms of a solid — the legacy bare string and the
 *               PaintField wrapper — must be the SAME PICTURE, pixel for pixel.
 *               That is the back-compat half: a document written before the Fill
 *               row was paint-capable must render identically to one authored
 *               today, and it is also what proves the wrapper reached the
 *               typesetter as a real colour rather than as a cache-key collision.
 *   DISTINCT    a solid, a gradient and a material must not all render the same
 *               picture — the control that keeps "it painted something" honest.
 *
 * Frames are written to .claude_vlm_checks/latex_fill_<cell>.png for inspection.
 *
 * Spawns its OWN isolated Vite + headless Chromium (the latex_morph_probe.js
 * pattern verbatim, including HMR OFF and its MathJax typeset budget).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
mkdirSync(vlmDir, { recursive: true });

const { createServer } = await import("vite");
// HMR OFF: this probe holds live state on `window.__powerrp_app` across seconds
// of MathJax typesetting, and any repo edit — human or concurrent agent — would
// reload the page and destroy it. Same reason cli/render_job.js turns it off.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const paintFailures = [];
const mathjaxMissing = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LATEX = "E = mc^2";
const TYPESET_MS = 4000; // MathJax bundle load + tex2svg + flatten
const W = 640, H = 220;
// THE COLOUR both solid forms carry. Deliberately NOT red: the paint-containment
// error box is pink-red, so a red equation would make any "is that the error box"
// pixel heuristic ambiguous. Blue leaves the two unmistakably apart.
const SOLID_HEX = "#1f6feb";
// Fraction of pixels that must differ for two renders to count as different
// pictures. Small, because an equation is thin ink on a wide light field.
const DIFFER_MIN = 0.004;
// Fraction below which two renders count as THE SAME picture. Not zero: the two
// solid forms take the identical code path after unwrapping, but the comparison
// runs through PNG encode/decode, so this is the floor for "no visible pixels
// differ" rather than a tolerance for real drift.
const IDENTICAL_MAX = 0.0005;

// THE USER'S MATRIX, in his order. `null` ink means the row is absent entirely.
const CELLS = [
  { id: "legacy_bare_solid", label: "legacy bare-string solid", ink: SOLID_HEX },
  { id: "wrapped_solid", label: "the PaintField's WRAPPED solid", ink: { type: "solid", solid: SOLID_HEX } },
  { id: "linear", label: "linear gradient", ink: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#0b5" }, { offset: 1, color: "#05b" }] } } },
  { id: "radial", label: "radial gradient", ink: { type: "radialGradient", radial: { stops: [{ offset: 0, color: "#0b5" }, { offset: 1, color: "#05b" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } } },
  { id: "off", label: "OFF", ink: { type: "none" } },
  { id: "material", label: "a material", ink: { type: "material", material: { id: "metal", params: {} } } },
];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    // THE SIGNAL THIS PROBE EXISTS FOR. paintNodeRun reports a contained paint
    // failure here before drawing the red box, so this is the user's symptom in
    // machine-readable form — captured, never filtered.
    if (/failed to PAINT/.test(t)) paintFailures.push(t);
    // Pre-existing and unrelated: a latexRef is a SYNTHETIC image-registry key,
    // not a URL, and the offscreen render path has its own registry that has not
    // had the typeset registered into it, so it tries to fetch the key. Filtered
    // by EXACT pattern (the latex_morph_probe precedent) so any other registry
    // failure still fails this probe.
    else if (/URL scheme "latex" is not supported|image_registry: failed to load "latex:/.test(t)) { /* see above */ }
    // THE HOST HAS NO MATHJAX. Recorded, not treated as an app error, and then
    // used to ABORT rather than to fail — see the guard after the typeset wait.
    else if (/failed to load MathJax bundle/.test(t)) mathjaxMissing.push(t);
    else if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/|\/asset\/|WebGPU|VideoV7/i.test(t)) errors.push(`console.error: ${t}`);
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ONE latex widget on ONE slide. Only the `ink` row changes between cells, so
  // any pixel that differs, differs because of the fill.
  await page.evaluate(({ latex, w, h }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w, h, z: 1000, active: true, background: "#ffffff" };
    const eq = { ...def("latex"), name: "Eq", x: 70, y: 60, w: 500, h: 100, z: 1, active: true, latex, fontSize: 44 };
    const doc = { meta: { name: "latex-fill-matrix", slideW: w, slideH: h }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.6, curve: "linear", sound: null }, delta: { items: { cam, eq } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, { latex: LATEX, w: W, h: H });
  await sleep(TYPESET_MS); // the equation must exist before any ink is judged

  // NO MATHJAX ⇒ NO EQUATION ⇒ NOTHING THIS PROBE ASKS IS ANSWERABLE. Every frame
  // would be blank, so "it painted with no failure" would be true of a blank page
  // and each pixel assertion would fail for a reason that has nothing to do with
  // the fill. That is a FALSE RED and a VACUOUS GREEN in one run, so the probe
  // refuses to report either: it says what is missing and exits non-zero, the same
  // way browser_capture_preflight refuses to let a broken host masquerade as an app
  // regression. Measured on a host where the pre-existing tests/latex_edit_probe.js
  // fails identically, which is how this was identified as environmental.
  if (mathjaxMissing.length) {
    console.error(
      `latex_solid_fill_probe: CANNOT RUN — this host could not load the MathJax bundle, so no equation typesets and there is no ink to judge.\n` +
      `  ${mathjaxMissing[0]}\n` +
      `  MathJax is a dependency ("mathjax" in package.json), served by Vite through \`import("mathjax/es5/tex-svg.js?url")\`.\n` +
      `  Check it is installed AND resolvable from the Vite root (a node_modules SYMLINKED from outside the project root resolves to undefined here).\n` +
      `  tests/latex_edit_probe.js fails the same way on such a host — if it does, the fault is the environment, not the app.`);
    process.exit(1);
  }

  const appDir = resolve(webRoot, "..");
  // Render one still per cell through the presenter's OWN seam (alpha 0 of slide
  // 0 = the plain slide), reading pixels back each time.
  const shots = [];
  for (const cell of CELLS) {
    const before = paintFailures.length;
    const dataUrl = await page.evaluate(async (ink, w, h, base, dir) => {
      const { renderTransitionFrame } = await import(`${base}/@fs${dir}/web/transitionRender.js`);
      const app = window.__powerrp_app;
      // Write the ink straight into the document, exactly as the Fill row does.
      // JSON round-trip rather than structuredClone: app.doc is a Svelte 5 $state
      // PROXY, and structuredClone refuses one ("could not be cloned"). The
      // document is plain JSON by contract, so this is lossless for it.
      const doc = JSON.parse(JSON.stringify(app.doc));
      const eq = doc.slides[0].delta.items.eq;
      if (ink === null) delete eq.ink; else eq.ink = ink;
      app.commit(doc);
      await new Promise((r) => setTimeout(r, 1200)); // re-typeset at the new tint
      const canvas = await renderTransitionFrame(app.doc, 0, 0, app.registry, w, h);
      const c2 = document.createElement("canvas");
      c2.width = w; c2.height = h;
      c2.getContext("2d").drawImage(canvas, 0, 0);
      return c2.toDataURL("image/png");
    }, cell.ink, W, H, baseUrl, appDir).catch((e) => { errors.push(`${cell.id}: frame render threw: ${e.message}`); return null; });

    if (dataUrl) writeFileSync(resolve(vlmDir, `latex_fill_${cell.id}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
    shots.push({ ...cell, dataUrl });
    // THE HEADLINE ASSERTION, per cell: setting this ink produced no contained
    // paint failure. This is the exact line the user reported.
    const newFailures = paintFailures.slice(before);
    assert(newFailures.length === 0,
      `${cell.label}: paints with no "failed to PAINT" report${newFailures.length ? ` — got: ${newFailures[0]}` : ""}`);
  }

  // Pixel comparisons, in the page (where the decoders live).
  const cmp = await page.evaluate(async (entries, w, h) => {
    const pixels = async (dataUrl) => {
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, w, h).data;
    };
    const fractionDiffering = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4)
        if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
      return n / (a.length / 4);
    };
    const px = {};
    for (const e of entries) if (e.dataUrl) px[e.id] = await pixels(e.dataUrl);
    // A blank reference the same size, to prove a cell drew ANY ink at all.
    const blank = new Uint8ClampedArray(w * h * 4).fill(255);
    const out = { vsBlank: {}, pairs: {} };
    for (const id of Object.keys(px)) out.vsBlank[id] = fractionDiffering(px[id], blank);
    const pair = (a, b) => (px[a] && px[b] ? fractionDiffering(px[a], px[b]) : null);
    out.pairs.solidForms = pair("legacy_bare_solid", "wrapped_solid");
    out.pairs.solidVsLinear = pair("wrapped_solid", "linear");
    out.pairs.solidVsMaterial = pair("wrapped_solid", "material");
    out.pairs.linearVsRadial = pair("linear", "radial");
    return out;
  }, shots.map(({ id, dataUrl }) => ({ id, dataUrl })), W, H);

  // IS INK: every cell except OFF must have drawn something. OFF is excluded on
  // purpose — "paint nothing" is its correct behaviour, and asserting it drew ink
  // would be asserting the opposite of the feature.
  for (const cell of CELLS) {
    if (cell.id === "off") continue;
    assert((cmp.vsBlank[cell.id] ?? 0) > DIFFER_MIN,
      `${cell.label}: actually drew ink (${((cmp.vsBlank[cell.id] ?? 0) * 100).toFixed(2)}% of pixels differ from blank)`);
  }

  // AGREE: the two storage forms of one colour are one picture. This is the
  // back-compat law AND the proof the wrapper reached the typesetter as a colour.
  assert(cmp.pairs.solidForms !== null && cmp.pairs.solidForms <= IDENTICAL_MAX,
    `the legacy bare-string solid and the PaintField wrapper render the SAME picture (${((cmp.pairs.solidForms ?? 1) * 100).toFixed(3)}% of pixels differ) — a document written before the Fill row was paint-capable must look identical to one authored today`);

  // DISTINCT: the controls. If these collapsed, "it painted" would be vacuous.
  assert((cmp.pairs.solidVsLinear ?? 0) > DIFFER_MIN, "a solid and a gradient are different pictures");
  assert((cmp.pairs.solidVsMaterial ?? 0) > DIFFER_MIN, "a solid and a material are different pictures");
  assert((cmp.pairs.linearVsRadial ?? 0) > DIFFER_MIN, "a linear and a radial gradient are different pictures");

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
  if (fails.length) { console.error(`\nlatex_solid_fill_probe: ${fails.length} FAILED`); process.exit(1); }
  console.log("latex_solid_fill_probe: OK");
} finally {
  await browser.close();
  await server.close();
}
