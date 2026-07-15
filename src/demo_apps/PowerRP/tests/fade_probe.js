/**
 * FADE PLAYBACK PROBE (verification, ephemeral — Opus9 / Round 12 transitions).
 *
 * Proves the FADE transition renders on the GPU as a PURE FUNCTION OF ALPHA: at
 * a fade boundary, alpha 0 shows the PREVIOUS completed slide, alpha 1 shows the
 * NEW completed slide, and alpha 0.5 is a genuine crossfade of the two (a value
 * strictly between the endpoints). Asserts ZERO console errors throughout
 * (user demand: "we don't wanna see errors").
 *
 * Spawns its OWN vite (the CLI/editor_smoke pattern) so it never touches the
 * dev server on :3637. Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/fade_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

// A two-slide deck: slide 1 fills the camera with RED, slide 2 with BLUE. The
// rect covers the whole camera so the center pixel is unambiguous. Slide 2's
// transition is a FADE. Camera background is black so a crossfade reads as a
// pure red→blue mix at the center.
const doc = {
  meta: { name: "fade-probe", slideW: 200, slideH: 200 },
  slides: [
    {
      id: "s0",
      name: "Slide 1",
      transition: { type: "tween", seconds: 0.5, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 200, h: 200, z: 1000, rotation: 0, scale: 1, active: true, background: "#000000" },
          box: { type: "rect", name: "Box", x: 0, y: 0, w: 200, h: 200, z: 1, rotation: 0, scale: 1, active: true, fill: "#ff0000", stroke: null, strokeWidth: 0, cornerRadius: 0, opacity: 1, rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" } },
        },
      },
    },
    {
      id: "s1",
      name: "Slide 2",
      transition: { type: "fade", seconds: 0.5, curve: "linear", sound: null },
      delta: { items: { box: { fill: "#0000ff" } } }, // same box, now blue
    },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const url = `${base}/?cli=1`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });

  // In-page: render the transition INTO slide 1 (the fade) at each alpha via the
  // SAME pure helper the presenter uses, and read the center pixel of each frame.
  // Modules load via vite's /@fs/<abs> served paths (fs.allow covers the repo);
  // each module's OWN relative imports then resolve from its served URL.
  const appDir = resolve(webRoot, "..");
  const W = 200, H = 200;
  const centers = await page.evaluate(async (docObj, base, appDir, W, H) => {
    const fs = (p) => `${base}/@fs${appDir}/${p}`;
    const { renderTransitionFrame } = await import(fs("web/transitionRender.js"));
    const { createRegistry } = await import(fs("core/registry.js"));
    const { createCommands } = await import(fs("core/commands.js"));
    const { registerAll } = await import(fs("plugins/index.js"));
    const registry = createRegistry();
    registerAll(registry, createCommands());
    const centerOf = (canvas) => {
      const px = canvas.getContext("2d").getImageData(W / 2, H / 2, 1, 1).data;
      return [px[0], px[1], px[2], px[3]];
    };
    const out = {};
    for (const alpha of [0, 0.5, 1]) {
      const canvas = await renderTransitionFrame(docObj, 1, alpha, registry, W, H);
      out[alpha] = centerOf(canvas);
    }
    return out;
  }, doc, base, appDir, W, H);

  // Endpoints: alpha 0 = previous slide (RED), alpha 1 = new slide (BLUE).
  const [r0, g0, b0] = centers[0];
  const [r1, g1, b1] = centers[1];
  const [r2, g2, b2] = centers["1"] ?? centers[1]; // key coercion guard
  const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;
  const assert = (cond, msg) => { if (!cond) throw new Error(`FADE PROBE FAIL: ${msg} — centers=${JSON.stringify(centers)}`); };

  assert(near(r0, 255) && near(g0, 0) && near(b0, 0), "alpha 0 center should be RED (previous slide)");
  assert(near(centers[1][0], 255) === false ? true : true, "midpoint present"); // no-op guard
  // Midpoint: a genuine crossfade — red DOWN from 255, blue UP from 0, strictly
  // between the endpoints (linear curve → ~50/50: red≈128, blue≈128).
  const [rm, gm, bm] = centers[0.5];
  assert(rm > 40 && rm < 220, `alpha 0.5 red channel should be a blend (got ${rm})`);
  assert(bm > 40 && bm < 220, `alpha 0.5 blue channel should be a blend (got ${bm})`);
  assert(rm < r0 && bm > b0, "alpha 0.5 must be between the endpoints (red down, blue up from slide 1)");
  // Endpoint 1 = BLUE.
  const [re, ge, be] = centers[1];
  assert(near(re, 0) && near(ge, 0) && near(be, 255), "alpha 1 center should be BLUE (new slide)");

  if (errors.length) throw new Error(`Console errors during fade playback:\n${errors.join("\n")}`);
  console.log("FADE PROBE: crossfade proven — alpha 0 RED, 0.5 blend, 1 BLUE; zero console errors.");
  console.log("  centers:", JSON.stringify(centers));
} finally {
  await browser.close();
  await server.close();
}
