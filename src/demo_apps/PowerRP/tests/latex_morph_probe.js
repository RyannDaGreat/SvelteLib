/**
 * LATEX MORPH PROBE — the one thing bare node cannot prove.
 *
 * tests/morph_content_test.js pins every law of this feature that is testable
 * without a browser, and it pins them against REAL captured MathJax geometry. But
 * it cannot answer the question the user actually asked, because MathJax is
 * browser-only: does editing an equation between slides make one equation FLOW
 * into the next, live, in the real app?
 *
 * User ruling, verbatim: "LaTeX to LaTeX should morph… I just edit the equation
 * between slides."
 *
 * So this probe builds exactly that document — one latex widget, two slides,
 * different sources, `latex~interp: "morph"` — waits for both equations to
 * typeset, and renders the transition at five alphas through
 * web/transitionRender.renderTransitionFrame, the SAME seam the presenter and the
 * video exporter drive. Then it asserts, in ink rather than in state:
 *
 *   ENDPOINTS   alpha 0 and alpha 1 must differ from each other (the two
 *               equations really are different pictures) — the control that makes
 *               every other assertion meaningful.
 *   CONTINUITY  the mid frames must differ from BOTH endpoints. A morph that
 *               silently fell back to the discrete switch would render the TARGET
 *               equation at every alpha > 0, so every mid frame would equal the
 *               alpha-1 frame exactly. That is the specific failure this probe
 *               exists to catch, and it is invisible to a state-level test: the
 *               fold is identical either way, and the difference lives entirely
 *               in what derive and ports do with the token.
 *   NO REFUSAL  derive's fallback report must not fire. It is the honest signal
 *               that a morph was asked for and not delivered, so seeing it here
 *               means the pair policy refused — which is a pass at the state
 *               level and a failure of the feature.
 *
 * The frames are also written for VLM inspection — .claude_vlm_checks/
 * latex_morph_a{0,25,50,75,100}.png — because "is that a plausible half-morphed
 * equation" is a judgement no pixel count makes.
 *
 * Spawns its OWN isolated Vite + headless Chromium, the latex_edit_probe.js
 * pattern verbatim (and its TYPESET_MS budget, for the same MathJax bundle).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
mkdirSync(vlmDir, { recursive: true });

const { createServer } = await import("vite");
// HMR OFF, for the same reason cli/render_job.js turns it off (see the app's
// CLAUDE.md): this probe holds live state on `window.__powerrp_app` across
// several seconds of MathJax typesetting, and ANY edit to a repo file — by a
// human or by a concurrent agent — reloads the page and destroys it. Measured:
// an unrelated edit to core/outline.js mid-run produced "Cannot set properties
// of undefined (setting 'slideIndex')", which reads exactly like a PowerRP bug
// and is not one.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TWO EQUATIONS THAT SHARE STRUCTURE BUT NOT CONTENT — a fraction on both sides,
// so the morph has real contours to pair rather than degenerating into "grow
// everything from nothing", which would look like a fade and prove less.
const FROM_LATEX = "E = mc^2";
const TO_LATEX = "a^2 + b^2 = c^2";
const TYPESET_MS = 4000; // MathJax bundle load + tex2svg + flatten, for BOTH equations
const W = 640, H = 220;
// Fractions of the frame's pixels that must differ for two renders to count as
// DIFFERENT pictures. Small, because an equation is thin ink on a wide white
// field: two entirely different equations still share most of their background.
const DIFFER_MIN = 0.005;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    // The derive refusal report is the SIGNAL this probe is watching for, so it
    // is captured rather than filtered — see the NO REFUSAL assertion.
    if (/is keyframed .* with interp "morph"/.test(t)) errors.push(`MORPH REFUSED: ${t}`);
    // THE `latex:` SCHEME NOISE IS PRE-EXISTING AND NOT THIS FEATURE'S, measured
    // by running this exact probe with the interp line removed: the identical two
    // lines appear. A latexRef is a SYNTHETIC image-registry key, not a URL, and
    // the OFFSCREEN render path (renderTransitionFrame → gpuService) has its own
    // registry which has not had the typeset registered into it, so it treats the
    // key as a URL and tries to fetch it. It costs the equation's RASTER in that
    // offscreen frame, not its vector glyphs — which is why the morph, which reads
    // glyphs, renders correctly through it. Filtered by an EXACT pattern rather
    // than broadly, so any other registry failure still fails this probe.
    else if (/URL scheme "latex" is not supported|image_registry: failed to load "latex:/.test(t)) { /* see above */ }
    else if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/|\/asset\/|WebGPU|VideoV7/i.test(t)) errors.push(`console.error: ${t}`);
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ONE latex widget, TWO slides, DIFFERENT sources, morph on the content leaf.
  // Nothing else moves: same box, same ink, same font size, so any pixel that
  // changes mid-transition changed because the EQUATION changed.
  await page.evaluate(({ from, to, w, h }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w, h, z: 1000, active: true, background: "#ffffff" };
    const eq = {
      ...def("latex"), name: "Eq", x: 70, y: 60, w: 500, h: 100, z: 1, active: true,
      latex: from, fontSize: 44, ink: "#101020",
      // THE FEATURE UNDER TEST, stored as an ordinary sibling leaf — no special
      // case anywhere, which is the whole point of the `~interp` storage choice.
      "latex~interp": "morph",
    };
    const doc = { meta: { name: "latex-morph", slideW: w, slideH: h }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.6, curve: "linear", sound: null }, delta: { items: { cam, eq } } },
      { id: "s1", name: "S2", transition: { type: "tween", seconds: 0.6, curve: "linear", sound: null }, delta: { items: { eq: { latex: to } } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, { from: FROM_LATEX, to: TO_LATEX, w: W, h: H });

  // BOTH equations must typeset before any frame is rendered — the morph's own
  // not-ready gate is honest and would refuse otherwise, which would make this
  // probe measure the gate rather than the morph. Visiting slide 2 is what makes
  // the app typeset the TARGET equation.
  await sleep(TYPESET_MS);
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; });
  await sleep(TYPESET_MS);
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; });
  await sleep(1000);

  // Render the transition INTO slide 2 at five alphas, through the presenter's
  // own seam, and read each frame's pixels back.
  const alphas = [0, 0.25, 0.5, 0.75, 1];
  const appDir = resolve(webRoot, "..");
  const frames = await page.evaluate(async (alphasIn, w, h, base, dir) => {
    // The `@fs` absolute-path import — the fade_presenter_probe idiom for
    // reaching a repo module from inside the page.
    const { renderTransitionFrame } = await import(`${base}/@fs${dir}/web/transitionRender.js`);
    const app = window.__powerrp_app;
    const out = [];
    for (const alpha of alphasIn) {
      const canvas = await renderTransitionFrame(app.doc, 1, alpha, app.registry, w, h);
      const c2 = document.createElement("canvas");
      c2.width = w; c2.height = h;
      c2.getContext("2d").drawImage(canvas, 0, 0);
      out.push({ alpha, dataUrl: c2.toDataURL("image/png") });
    }
    return out;
  }, alphas, W, H, baseUrl, appDir).catch((e) => { errors.push(`frame render failed: ${e.message}`); return []; });

  assert(frames.length === alphas.length, `rendered ${alphas.length} transition frames (got ${frames.length})`);
  if (frames.length === alphas.length) {
    // Write them for the VLM: "is that a plausible half-morphed equation" is a
    // judgement no pixel count makes.
    for (const f of frames)
      writeFileSync(resolve(vlmDir, `latex_morph_a${String(Math.round(f.alpha * 100)).padStart(3, "0")}.png`), Buffer.from(f.dataUrl.split(",")[1], "base64"));

    // Pixel comparison, in the page (where the decoders are).
    const diffs = await page.evaluate(async (fs, w, h) => {
      const px = async (dataUrl) => {
        const img = new Image();
        await new Promise((r) => { img.onload = r; img.src = dataUrl; });
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, w, h).data;
      };
      const all = await Promise.all(fs.map((f) => px(f.dataUrl)));
      const frac = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4)
          if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
        return n / (a.length / 4);
      };
      return { vsFirst: all.map((p) => frac(all[0], p)), vsLast: all.map((p) => frac(all[all.length - 1], p)) };
    }, frames, W, H);

    // THE CONTROL: the two equations really are different pictures. Without this,
    // "the mid frames differ from both endpoints" could pass on a blank canvas.
    assert(diffs.vsFirst[4] > DIFFER_MIN,
      `the two equations render DIFFERENTLY (alpha 0 vs 1 differ in ${(diffs.vsFirst[4] * 100).toFixed(2)}% of pixels)`);

    // THE FEATURE: every interior frame is its own picture — neither endpoint.
    // A silent fallback to the discrete switch would make each of these EQUAL the
    // alpha-1 frame, so vsLast would be 0.
    for (const i of [1, 2, 3]) {
      assert(diffs.vsFirst[i] > DIFFER_MIN,
        `alpha ${alphas[i]} differs from the OUTGOING equation (${(diffs.vsFirst[i] * 100).toFixed(2)}%)`);
      assert(diffs.vsLast[i] > DIFFER_MIN,
        `alpha ${alphas[i]} differs from the INCOMING equation (${(diffs.vsLast[i] * 100).toFixed(2)}%) — a discrete switch would make this 0`);
    }
  }

  // THE REFUSAL REPORT IS A FAILURE HERE. It is derive saying out loud that a
  // morph was asked for and not delivered — a pass at the state level and a
  // failure of the feature, which is exactly the gap this probe closes.
  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length})` : "\nALL PASSED");
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
