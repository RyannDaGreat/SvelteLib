/**
 * GRADIENT SPREAD UI probe — boot the PowerRP editor headless and drive the REAL
 * Spread row (web/PaintField.svelte) and the REAL stop bar
 * (web/GradientStopBar.svelte) that the bare-node suites cannot reach.
 *
 * render_gpu/tests/gradient_spread_test.js already proves the MATH and the three
 * backends. What only a browser can prove is that the row exists, writes the
 * document, and that the bar redraws to match — the half of the feature the
 * user actually touches.
 *
 * Proves, against the REAL app:
 *   - THE SPREAD ROW EXISTS on a LINEAR gradient fill and offers exactly the three
 *     declared modes, defaulting to Mirror (the legacy behaviour).
 *   - IT IS NOT OFFERED ON A RADIAL gradient, which has no wavelength and therefore
 *     no segment to tile — the recorded boundary of this feature, asserted rather
 *     than left as a comment.
 *   - PICKING A MODE WRITES THE DOCUMENT at fill.linear.spread, in EXACTLY ONE undo
 *     unit (the easiest thing to get wrong on a select that writes a nested
 *     sub-state), and undo puts it back.
 *   - AN ABSENT SPREAD IS MIRROR: a gradient authored without the field shows
 *     Mirror selected, so the legacy default is what the UI reports.
 *   - THERE IS EXACTLY ONE BAR, and it is LOOP-AWARE (user ruling, 2026-08-02:
 *     "There should only be one… You don't need two bars. That's weird looking.").
 *     The old second strip (.stopbar-band) is asserted ABSENT. The one track's
 *     painted gradient is read off the live element, so a bar that rendered a
 *     constant would fail: mirror IS the authored ramp, pad is BYTE-IDENTICAL to
 *     mirror ("it would look the same between those two"), and loop's two ends
 *     cross the seam to #800080 — the purple the ruling asks to see on the right.
 *     The fixture ramp is INSET (0.2/0.8) on purpose; see the comment at it.
 *   - THE WAVELENGTH FLOOR IS GONE: the wavelength field accepts 0 and the document
 *     stores it, with no NaN and no console error — the scrub-to-zero the ruling
 *     asked for.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks/gradient_spread_ui");
fs.mkdirSync(SHOTS, { recursive: true });

const { createServer } = await import("vite");
// HMR OFF + no repo watch: this probe writes screenshots INTO the repo, and a
// watched write would reload the page and discard the injected document.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Frontend-only Vite (no server.py): backend-absent noise is expected and named
  // specifically — the gate still fails on anything else (paintfield_probe's list).
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|no.*adapter|adapters/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A rect with a LINEAR gradient fill that OMITS `spread` — the legacy shape, so
  // the "absent is mirror" claim is tested on a real absent field rather than on
  // one this probe wrote. Red→blue: the two ends are far apart, so a wrap is
  // unmistakable in the band's own gradient string.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const fill = {
      type: "linearGradient",
      // AN INSET RAMP (0.2 → 0.8), DELIBERATELY, and this is load-bearing for the
      // one-bar assertions below. A ramp with stops at 0 AND 1 spans the whole
      // window, so its wrap segment has zero length (core/ramps.js's hard seam) and
      // ALL THREE spread modes paint an identical bar — a full-span fixture would
      // make the loop assertion unfalsifiable. Inset leaves a stretch outside the
      // stops, which is exactly where pad/mirror hold flat and loop crosses the seam.
      linear: { stops: [{ offset: 0.2, color: "#ff0000" }, { offset: 0.8, color: "#0000ff" }], angle: 0, wavelength: 0.5 },
    };
    const rect = { ...def("rect"), name: "Box", x: 300, y: 150, w: 400, h: 200, z: 1, active: true, fill };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    app.commit(app.repaired({ meta: { name: "spread-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: tr, delta: { items: { cam, rect } } },
    ] }));
    app.slideIndex = 0;
    app.selection = Object.keys(app.doc.slides[0].delta.items).find((id) => app.doc.slides[0].delta.items[id].type === "rect");
  });
  await sleep(600);

  // Expand collapsed inspector categories so the fill PaintField is in the DOM.
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".cat-header[aria-expanded='false']")) h.click();
  });
  await sleep(400);

  /** The rect's stored fill, as a faithful plain object (the doc is a $state proxy —
   *  stringify in-page, parse in node, the paintfield_probe discipline). */
  const rectFill = () => page.evaluate(() => {
    const it = window.__powerrp_app.doc.slides[0].delta.items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    return JSON.stringify(it[id]?.fill ?? null);
  }).then((s) => JSON.parse(s));

  /**
   * The Spread row's state, read off the REAL control. The app's Dropdown is a
   * custom listbox (src/lib/Dropdown.svelte), not a native <select> — so the
   * current value is the trigger's label and the options only exist in the DOM
   * while the menu is open. Opening it is therefore part of reading it.
   */
  const spreadRow = async () => {
    const present = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".paint-sub-row")];
      const row = rows.find((r) => r.querySelector(".paint-sub-label")?.textContent.trim() === "Spread");
      if (!row) return null;
      return { label: row.querySelector(".dd-trigger-label")?.textContent.trim() ?? null };
    });
    if (!present) return null;
    // Open the menu to enumerate the options, then close it by clicking the SAME
    // trigger again. NOT Escape: Escape bubbles to the Inspector and collapses the
    // panel this probe is reading, which cost a debugging round the first time.
    const toggle = () => page.evaluate(() => {
      const rows = [...document.querySelectorAll(".paint-sub-row")];
      rows.find((r) => r.querySelector(".paint-sub-label")?.textContent.trim() === "Spread")
        .querySelector(".dd-trigger").click();
    });
    await toggle();
    await sleep(250);
    const options = await page.evaluate(() =>
      [...document.querySelectorAll(".dd-menu [role='option']")].map((o) => o.textContent.trim()));
    await toggle();
    await sleep(200);
    return { label: present.label, options };
  };

  // ── THE ROW EXISTS, WITH THE THREE MODES, DEFAULTING TO MIRROR ──────────────
  const row = await spreadRow();
  assert(row !== null, "a linear gradient fill has a Spread row");
  assert(row?.options.length === 3 && row.options.every((o) => /^(Mirror|Loop|Pad)\b/.test(o)),
    `the row offers exactly the three declared modes (got ${JSON.stringify(row?.options)})`);
  assert(/^Mirror\b/.test(row?.label ?? ""), `an ABSENT spread shows Mirror — the legacy default (got ${row?.label})`);
  assert((await rectFill())?.linear?.spread === undefined,
    "…and showing it did NOT write the field: absent stays absent until picked");

  await page.screenshot({ path: resolve(SHOTS, "01-spread-row-mirror.png") });

  /**
   * Command. Picks a spread mode by CLICKING the real listbox — open the trigger,
   * click the option whose label starts with the mode's name. Driving the actual
   * control (rather than writing state) is the point of a probe: it is what proves
   * the row is wired to the document at all.
   */
  const pickSpread = async (modeLabel) => {
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".paint-sub-row")];
      rows.find((r) => r.querySelector(".paint-sub-label")?.textContent.trim() === "Spread")
        .querySelector(".dd-trigger").click();
    });
    await sleep(250);
    await page.evaluate((m) => {
      const opt = [...document.querySelectorAll(".dd-menu [role='option']")]
        .find((o) => o.textContent.trim().startsWith(m));
      if (!opt) throw new Error(`spread option "${m}" not found in the open menu`);
      opt.click();
    }, modeLabel);
    await sleep(450);
  };

  /** THE ONE BAR's painted gradient, read off the LIVE track element. */
  const barCss = () => page.evaluate(() => {
    const el = document.querySelector(".stopbar-track");
    return el ? getComputedStyle(el).getPropertyValue("--sb-ramp").trim() : null;
  });

  // ── THERE IS EXACTLY ONE BAR ───────────────────────────────────────────────
  // User ruling (2026-08-02, verbatim): "What I also don't understand is why
  // there's two bars. There should only be one… You don't need two bars. That's
  // weird looking." The second bar was a shorter CONTINUATION BAND under the track
  // previewing the next tile; its information moved into the one ramp's two ends.
  // Asserted as ABSENCE of the class, so re-adding a second strip fails here.
  assert(await page.evaluate(() => document.querySelectorAll(".stopbar-track").length) === 1,
    "the stop bar draws exactly ONE ramp track");
  assert(await page.evaluate(() => !document.querySelector(".stopbar-band")),
    "…and no second continuation band beside it (the two-bar layout is gone)");

  const mirrorBar = await barCss();
  assert(mirrorBar && mirrorBar.length > 0, "the one bar paints a ramp");
  // MIRROR leaves the [0,1] window exactly as authored — the reflection is the NEXT
  // tile, outside it. So the bar is the literal stop list: red at 20%, blue at 80%.
  assert(/#ff0000 20%/.test(mirrorBar ?? "") && /#0000ff 80%/.test(mirrorBar ?? ""),
    `mirror's bar IS the authored ramp — red at 20%, blue at 80% (got ${(mirrorBar ?? "").slice(0, 70)})`);

  // ── PICKING LOOP: writes the doc, ONE undo unit, and the band wraps ─────────
  const beforePick = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  await pickSpread("Loop");

  assert((await rectFill())?.linear?.spread === "loop", "picking Loop writes fill.linear.spread");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(400);
  assert(await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc)) === beforePick,
    "…in EXACTLY ONE undo unit (a single undo restores the whole document)");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(400);
  assert((await rectFill())?.linear?.spread === "loop", "…and redo puts it back");

  const loopBar = await barCss();
  assert(loopBar !== mirrorBar, "the ONE bar REDRAWS when the mode changes (it is not a constant)");
  // THE RULING'S OWN TEST, now shown IN the ramp instead of beside it: "in order
  // for a loop to work, the very left of it and the very right of it have to take
  // into consideration what would happen if it loops." With period-1 tiling, the
  // stretch past the last stop runs across the seam toward the FIRST stop's colour
  // instead of holding blue flat — so both ends land on the seam's midpoint, which
  // for red→blue is #800080. That is, exactly, "I should see purple on the right".
  assert(/^linear-gradient\(90deg, #800080 0%/.test(loopBar ?? ""),
    `loop's bar STARTS across the seam, not at the first stop's red (got ${(loopBar ?? "").slice(0, 45)})`);
  assert(/#800080 100%\)$/.test(loopBar ?? ""),
    `…and ENDS on the seam colour too — the purple on the right the ruling asks for (got …${(loopBar ?? "").slice(-30)})`);
  await page.screenshot({ path: resolve(SHOTS, "02-spread-loop-bar.png") });

  // ── PAD IS IDENTICAL TO MIRROR inside the window ───────────────────────────
  // The user stated this outcome directly: "If it's mirror or pad, it would look
  // the same between those two. Loop would only be the only one that's different."
  // Both hold/reflect OUTSIDE [0,1], so neither changes the bar — asserted as
  // EQUALITY with the mirror string, which is a stronger claim than a shape match.
  await pickSpread("Pad");
  const padBar = await barCss();
  assert((await rectFill())?.linear?.spread === "pad", "picking Pad writes it too");
  assert(padBar === mirrorBar,
    `pad's bar is BYTE-IDENTICAL to mirror's — the ruling's "it would look the same between those two" (pad ${(padBar ?? "").slice(0, 45)})`);
  await page.screenshot({ path: resolve(SHOTS, "03-spread-pad-bar.png") });

  // ── THE BOUNDARY: a RADIAL gradient has no spread row ───────────────────────
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const it = app.doc.slides[0].delta.items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    app.setPreview([[["items", id, "fill"], {
      type: "radialGradient",
      radial: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], center: { x: 0.5, y: 0.5 }, r: 0.5 },
    }]]);
    app.commitPreview();
  });
  await sleep(500);
  assert(await spreadRow() === null,
    "a RADIAL gradient has NO Spread row — it has no wavelength, so no segment to tile (the recorded boundary)");
  await page.screenshot({ path: resolve(SHOTS, "04-radial-no-spread-row.png") });

  // ── THE FLOOR IS GONE: wavelength accepts 0 ────────────────────────────────
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const it = app.doc.slides[0].delta.items;
    const id = Object.keys(it).find((k) => it[k]?.type === "rect");
    app.setPreview([[["items", id, "fill"], {
      type: "linearGradient",
      linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], angle: 0, wavelength: 0, spread: "loop" },
    }]]);
    app.commitPreview();
  });
  await sleep(600);
  const collapsed = await rectFill();
  assert(collapsed?.linear?.wavelength === 0,
    `wavelength 0 is STORED, not floored to 0.05 (got ${collapsed?.linear?.wavelength})`);
  // The canvas must still be painting — a NaN axis would have thrown by now, and
  // the console listener above would have caught it.
  assert(await page.evaluate(() => !!document.querySelector("canvas")), "the canvas survived a zero-wavelength gradient");
  await page.screenshot({ path: resolve(SHOTS, "05-wavelength-zero-average.png") });

  assert(errors.length === 0, `no console errors during the run (${JSON.stringify(errors)})`);

  console.log(`\ngradient_spread_ui_probe: ${(fails.length === 0 ? "all" : "")} checks done, ${fails.length} failed, screenshots in ${SHOTS}`);
  for (const f of fails) console.error(`CHECK FAILED: ${f}`);
} finally {
  await browser.close();
  await server.close();
}

process.exit(fails.length === 0 ? 0 : 1);
