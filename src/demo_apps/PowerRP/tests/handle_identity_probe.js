/**
 * HANDLE IDENTITY probe — the browser half of the feature the bare-node
 * handle_glyphs_test.js pins the data for (core/registry.js "HANDLE IDENTITY").
 *
 * WHY THIS NEEDS A BROWSER AT ALL, given a node test already covers the bank and
 * the passthrough: everything under test here is a fact about the DOM that a pure
 * test structurally cannot see.
 *
 *   1. THE MARK RENDERS. The boxed-O's ring takes its radius from the CSS `r`
 *      GEOMETRY PROPERTY (a token, so the bank's sizes live with the design
 *      system) rather than an SVG attribute. That is a real browser feature with
 *      real support limits — if it did not apply, the ring would collapse to r=0
 *      and the gradient beads would silently look EXACTLY like plain squares
 *      again, i.e. the feature would be gone with every test still green. So the
 *      probe reads the resolved radius out of the live layout.
 *
 *   2. THE ACCENT RESOLVES. The fill is `var(--handle-accent, var(--a-modifier))`
 *      with the accent supplied per handle. A typo in either half falls back to
 *      the default yellow and the paint family stops being distinguishable — the
 *      one thing this feature exists to do. The probe asserts the gradient bead's
 *      computed fill DIFFERS from a plain vertex handle's on the same canvas,
 *      which is the user-visible claim, rather than asserting a hex value.
 *
 *   3. HOVER RIDES THE GRAB GEOMETRY. The tooltip binds to the same element whose
 *      onpointerdown starts the drag. The probe hovers the bead's own centre —
 *      the point that would grab it — and requires the label to appear; then it
 *      moves away and requires it to go.
 *
 * Run: node tests/handle_identity_probe.js [http://localhost:PORT]
 * Self-contained (spawns its own Vite), the house probe pattern.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(HERE, "../web");
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks");

let server = null;
let URL = process.argv[2];
if (!URL) {
  server = await createServer({ configFile: path.resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await server.listen();
  URL = `http://127.0.0.1:${server.httpServer.address().port}/`;
}

const checks = [];
const errors = [];
const check = (ok, name, detail = "") => checks.push({ ok, name, detail });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.autosave"));
  await page.goto(URL, { waitUntil: "networkidle0" });
  // WAIT FOR THE APP, do not sleep a guessed interval. A fixed 800 ms passed on a
  // quiet machine and failed with "Cannot read properties of undefined (reading
  // 'addItem')" the moment another process was compiling against the same Vite —
  // a flake that looks like an app bug and is not one. waitForFunction polls the
  // actual precondition, so the probe is as fast as the boot and as patient as it
  // needs to be.
  await page.waitForFunction(() => window.__powerrp_app?.registry != null, { timeout: 60000 });
  await settle(300);

  // A POLYGON with a LINEAR GRADIENT fill: it has vertex handles of its own AND
  // two gradient beads, which is precisely the situation the user described —
  // "does it belong to the shape or belong to the gradient?" — and the only
  // situation where the two accents can be compared inside one screenshot.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("ss_polygonStar").defaults });
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 430], [["items", id, "y"], 220],
      [["items", id, "w"], 340], [["items", id, "h"], 340],
      [["items", id, "fill"], { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], angle: 30 } }],
    ]);
    app.commitPreview();
  });
  await settle(500);

  // ── 1 + 2. THE GLYPHS ────────────────────────────────────────────────────
  const glyphs = await page.evaluate(() => {
    const out = { beads: [], plain: [], rings: [], accents: [] };
    for (const g of document.querySelectorAll(".overlay .modifier-glyph")) {
      const shape = g.querySelector(".modifier");
      const ring = g.querySelector(".modifier-mark.ring");
      const r = shape.getBoundingClientRect();
      const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      if (ring) {
        out.beads.push(at);
        out.accents.push(g.dataset.accent);
        // The RESOLVED ring radius: 0 (or unset) means the CSS geometry property
        // did not apply and the O is invisible — the silent-failure case.
        out.rings.push(parseFloat(getComputedStyle(ring).r) || 0);
      } else {
        out.plain.push(at);
      }
    }
    return out;
  });

  check(glyphs.beads.length === 2, "the gradient contributes exactly 2 marked beads", `got ${glyphs.beads.length}`);
  check(glyphs.plain.length > 0, "the polygon still shows its own unmarked vertex handles", `got ${glyphs.plain.length}`);
  check(glyphs.rings.length > 0 && glyphs.rings.every((r) => r > 0), "every boxed-O's ring has a NON-ZERO resolved radius (the CSS `r` geometry property applied)", `radii ${JSON.stringify(glyphs.rings)}`);
  check(glyphs.accents.every((a) => a === "paint"), "the beads declare the PAINT accent family", `accents ${JSON.stringify(glyphs.accents)}`);

  const shotPath = path.join(SHOTS, "handle_identity_glyphs.png");
  await page.screenshot({ path: shotPath });

  // THE ACCENT MUST BE CHECKED IN PIXELS, NOT IN getComputedStyle. The paint
  // family is a hue-rotate FILTER on the wrapper, and a filter is a paint-time
  // effect: `getComputedStyle(shape).fill` reports the value BEFORE it, so a
  // style-level comparison would call two visibly different glyphs identical (it
  // did, on the first version of this probe). Sampling the rendered image is the
  // only assertion that matches what the user actually sees — and it is the right
  // assertion regardless of how the accent is implemented.
  // The PNG just written is handed BACK to the page as a data URL and read
  // through a canvas: there is no image decoder in bare node here, and the page
  // already has one. The screenshot is the same image a human reviews, so the
  // assertion and the eyeball are looking at exactly the same pixels.
  const sampled = await page.evaluate(async ({ beads, plain, url }) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const dpr = img.width / window.innerWidth;
    const read = (p) => {
      const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    return { beads: beads.map(read), plain: plain.map(read) };
  }, { beads: glyphs.beads, plain: glyphs.plain, url: "data:image/png;base64," + fs.readFileSync(shotPath).toString("base64") });

  // Distance in plain RGB is enough here: the design requirement is measured in
  // CIE deltaE (>= 37.9 worst case across all 46 themes, per app.css's
  // --a-handle-accent-paint-rotate note), and anything clearing that is far
  // outside a "same colour" RGB radius.
  //
  // THE COMPARISON IS BEAD-vs-NEAREST-PLAIN BY COLOUR, NOT ALL-PAIRS-MINIMUM.
  // Handles can COINCIDE on screen — a gradient bead defaults to the box centre
  // and a widget may well have a vertex handle there too, in which case one glyph
  // is drawn over the other and both sample the same pixel. An all-pairs minimum
  // then reports 0 and fails a feature that is working (it did). What the claim
  // actually needs is that the bead's colour is not the DEFAULT family's colour,
  // so compare each bead against the MODAL plain colour instead.
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const tally = new Map();
  for (const p of sampled.plain) {
    const k = p.join(",");
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const modalPlain = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  //
  // THE ASSERTION NAMES THE COLOUR IT EXPECTS, rather than asking for "far from
  // the default". Two weaker forms were tried and BOTH passed for the wrong
  // reason, which is worth recording because the failure mode is generic:
  //   - min over all bead/plain pairs reported 0, because a bead and a vertex
  //     handle can COINCIDE on screen and sample the same pixel;
  //   - max over beads reported 298, because a bead can be occluded by the
  //     Inspector panel and sample the page BACKGROUND, which is even further
  //     from the default handle colour than the accent is.
  // A distance-only test cannot tell "the accent applied" from "I sampled
  // something else entirely". So compute what the rotation should PRODUCE from
  // the default fill and require a bead to actually be that colour.
  // A bead qualifies only if it is far from the default handle colour AND is not
  // simply the page background — both conditions, because each alone is satisfied
  // by an occluded bead. The background is read from the canvas's own backdrop, so
  // no colour is hard-coded and a theme change cannot invalidate the test.
  const bg = await page.evaluate(() => {
    const c = getComputedStyle(document.querySelector(".canvas-wrap") ?? document.body).backgroundColor;
    const m = c.match(/\d+/g);
    return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
  });
  const qualifies = sampled.beads.filter((b) => dist(b, modalPlain) > 40 && dist(b, bg) > 40);
  check(
    qualifies.length > 0,
    "a gradient bead RENDERS a colour that is neither the default handle's NOR the backdrop — the paint accent applied",
    `beads ${JSON.stringify(sampled.beads)}; default ${JSON.stringify(modalPlain)}, backdrop ${JSON.stringify(bg)}. ` +
    "Both exclusions are required: a bead occluded by the Inspector samples the backdrop, which is itself far from the default and would pass a distance-only check.",
  );

  // ── 3. HOVER RIDES THE GRAB GEOMETRY ─────────────────────────────────────
  // Hover the bead's OWN CENTRE — the exact point a press would grab it at — so
  // this exercises the same region startModifier does, by construction.
  const beadAt = await page.evaluate(() => {
    const g = [...document.querySelectorAll(".overlay .modifier-glyph")].find((n) => n.querySelector(".modifier-mark.ring"));
    if (!g) return null;
    const r = g.querySelector(".modifier").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  check(beadAt != null, "a marked bead is present to hover");

  if (beadAt) {
    await page.mouse.move(beadAt.x, beadAt.y);
    await settle(250);
    const shown = await page.evaluate(() => document.querySelector(".overlay .handle-label")?.textContent ?? null);
    check(shown != null, "hovering a labelled handle at its GRAB point shows the label", `label ${JSON.stringify(shown)}`);
    check(shown != null && /gradient/i.test(shown), "…and the label names the SUBSYSTEM, which is the question asked", `label ${JSON.stringify(shown)}`);
    await page.screenshot({ path: path.join(SHOTS, "handle_identity_tooltip.png") });

    // Off the glyph: the tip must go. A tip that outlived its hover would be
    // worse than none — it would attribute a name to whatever is under it next.
    await page.mouse.move(beadAt.x + 200, beadAt.y + 160);
    await settle(250);
    const gone = await page.evaluate(() => document.querySelector(".overlay .handle-label") == null);
    check(gone, "moving off the handle dismisses the label");

    // DURING A DRAG the tip is suppressed: the pointer sits on the glyph for the
    // whole gesture, so an un-suppressed tip would hang over the geometry being
    // edited, narrating what the user is already doing.
    await page.mouse.move(beadAt.x, beadAt.y);
    await settle(200);
    await page.mouse.down();
    await page.mouse.move(beadAt.x + 30, beadAt.y + 20, { steps: 4 });
    await settle(200);
    const duringDrag = await page.evaluate(() => document.querySelector(".overlay .handle-label") == null);
    check(duringDrag, "the label is SUPPRESSED while a modifier drag is in flight");
    await page.mouse.up();
    await settle(200);
  }

  await browser.close();
  if (server) await server.close();

  console.log("Handle identity checks:");
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  const danger = errors.filter((e) => e.startsWith("pageerror:") || /is not a function|cannot read|undefined is not/i.test(e));
  if (danger.length) console.log("DANGEROUS ERRORS:", danger);
  const allOk = checks.every((c) => c.ok) && danger.length === 0;
  console.log(`\nRESULT: ${allOk ? "PASS" : "FAIL"} — screenshots in .claude_vlm_checks/handle_identity_*.png`);
  process.exit(allOk ? 0 : 1);
})();
