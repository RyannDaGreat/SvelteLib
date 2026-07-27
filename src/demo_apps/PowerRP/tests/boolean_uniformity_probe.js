/**
 * BOOLEAN-ROW UNIFORMITY probe — headless puppeteer, exit-code gated.
 *
 * The question the user asked: "checkbox styling across the whole app... should
 * always be the same". This probe answers it with pixels + DOM, across widgets
 * from DIFFERENT sources of the boolean row:
 *   - rows that ALWAYS said kind:"boolean"   (video autoplay/loop/muted, camera retina)
 *   - rows MIGRATED from kind:"checkbox"      (text bold, clock_digital showHours…, latex preserveAspect)
 *   - a row still carrying the RETIRED spelling (cursor spin — owned by another
 *     agent at the time of writing; it must reach the SAME control via the
 *     Inspector's rowKind alias bridge, not fall through to a text input)
 *   - the universal `active` visibility row
 *
 * ASSERTS (any failure = nonzero exit):
 *   1. every boolean row in every pane renders exactly one .boolfield > .boolbtn
 *      with an <iconify-icon>, and ZERO native <input type=checkbox> exists
 *      anywhere in the editor;
 *   2. every boolean control has IDENTICAL box metrics + resting colors;
 *   3. the house contract survives the rename: clicking a MIGRATED row previews
 *      through app.setPreview and commits as EXACTLY ONE undo unit;
 *   4. a MIGRATED row still offers the `=` equation affordance and accepts an
 *      equation (Tier 0), same as an always-boolean row.
 *
 * Writes a per-widget screenshot + a contact sheet to POWERRP/.claude_vlm_checks/.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/boolean_uniformity_probe.js
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Paths resolve from THIS FILE, never process.cwd() — a cwd-relative path silently
// doubles its prefix when the suite is run from anywhere but the repo root (the
// note tests/pdf_p1_vlm_check.js carries after being bitten by exactly that).
const HERE = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(HERE, "..");
const webRoot = resolve(powerrp, "web");
const shots = resolve(powerrp, ".claude_vlm_checks/boolean_uniformity");
await mkdir(shots, { recursive: true });

// The widget types probed, and where each one's boolean rows come from. The mix
// is the point: if the two former spellings render differently, this set shows it.
const CASES = [
  { type: "video", origin: "always-boolean", rows: ["Autoplay", "Loop", "Muted"] },
  { type: "camera", origin: "always-boolean", rows: ["Retina (HiDPI)"] },
  { type: "clock_analog", origin: "always-boolean", rows: ["Numerals", "Tick marks", "Second hand"] },
  // "Visible" is the UNIVERSAL `active` row (manifest Round 12). It overrides
  // the icons (mdi:eye / mdi:eye-off — SlideNav's visual language) but must be
  // the SAME control; that override is the one sanctioned per-row variation.
  { type: "text", origin: "migrated-from-checkbox", rows: ["Bold", "Visible"] },
  { type: "clock_digital", origin: "migrated-from-checkbox", rows: ["Show hours", "Show seconds", "12-hour"] },
  { type: "latex", origin: "migrated-from-checkbox", rows: ["Preserve aspect"] },
  { type: "number", origin: "migrated-from-checkbox", rows: ["Thousands", "Bold"] },
  { type: "cursor", origin: "retired-spelling-still-in-tree", rows: ["Spin", "Preserve aspect"] },
];

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // HMR OFF: sibling agents are editing this tree; a mid-run save must not
  // reload the page underneath the probe.
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

// Same launch flags as boot_probe.js: software GL so the Skia compositor comes
// up headless, and --no-sandbox because the container runs as root.
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

// Boot noise from other agents' in-flight work / stale fixtures — ignored at
// boot ONLY; anything after boot is a real failure of this path.
// (VideoV7's WebGPU init failure is environmental — headless has no adapter.)
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /Failed to load resource/, /no WebGPU adapter/];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// Inserting a `video` widget at its DEFAULTS gives it a placeholder data: PNG as
// `src`; the media element rightly refuses to decode a PNG as video. That is the
// video widget's own empty-source path, not the boolean row's — and the video
// widget is here only because autoplay/loop/muted are the canonical
// always-boolean rows. Scoped narrowly so any other runtime error still fails.
const IGNORE_RUNTIME = [/video_registry: (failed to load|resume of) "data:image\/png/];
const isInsertNoise = (s) => IGNORE_RUNTIME.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 900));
  const realBoot = errors.filter((e) => !isBootNoise(e));
  if (realBoot.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBoot.join("\n")); process.exit(1); }
  errors.length = 0;

  // ── 1+2. Sweep every case: render its rows, measure every boolean control ──
  const metrics = [];
  const rowShots = [];
  for (const c of CASES) {
    const inserted = await page.evaluate((type) => {
      const app = window.__powerrp_app;
      const plugin = app.registry.get(type);
      if (!plugin) return { error: `no plugin "${type}"` };
      // The camera already exists (purgeable:false, exactly one) — select it.
      if (type === "camera") {
        const cam = app.nodes().find((n) => n.state.type === "camera");
        if (!cam) return { error: "no camera node" };
        app.selection = cam.id;
        return { id: cam.id };
      }
      app.addItem({ ...plugin.defaults, x: 100, y: 100 });
      return { id: app.selection };
    }, c.type);
    ok(!inserted.error, `${c.type}: inserted/selected (${inserted.error ?? "ok"})`);
    if (inserted.error) continue;
    await new Promise((r) => setTimeout(r, 320));

    // Expand every collapsed accordion so all rows are measurable.
    await page.evaluate(() => {
      for (const h of document.querySelectorAll(".inspector .cat-head[aria-expanded='false']")) h.click();
    });
    await new Promise((r) => setTimeout(r, 220));

    const probe = await page.evaluate((wanted) => {
      const out = { found: [], missing: [], textInputRows: [] };
      const rows = [...document.querySelectorAll(".inspector .row")];
      for (const label of wanted) {
        const row = rows.find((r) => r.querySelector(".label")?.textContent?.trim() === label);
        if (!row) { out.missing.push(label); continue; }
        const btn = row.querySelector(".boolfield > * .boolbtn, .boolfield .boolbtn");
        // A row that fell through to the catch-all text input is the exact
        // regression this probe is here to catch.
        if (!btn) { out.textInputRows.push({ label, html: row.innerHTML.slice(0, 160) }); continue; }
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        out.found.push({
          label,
          w: Math.round(r.width), h: Math.round(r.height),
          bg: cs.backgroundColor, color: cs.color,
          border: cs.borderWidth, radius: cs.borderTopLeftRadius,
          tag: btn.tagName, icons: btn.querySelectorAll("iconify-icon").length,
          fields: row.querySelectorAll(".boolfield").length,
          hasEq: !!row.querySelector(".eq-open"),
          on: btn.getAttribute("aria-pressed") === "true",
          onClass: btn.classList.contains("on"),
          icon: btn.querySelector("iconify-icon")?.getAttribute("icon") ?? null,
        });
      }
      return out;
    }, c.rows);

    ok(probe.missing.length === 0, `${c.type}: all probed rows present (missing: ${JSON.stringify(probe.missing)})`);
    ok(probe.textInputRows.length === 0,
      `${c.type}: NO boolean row fell through to a text input (${JSON.stringify(probe.textInputRows.map((t) => t.label))})`);
    for (const f of probe.found) {
      ok(f.tag === "BUTTON", `${c.type}.${f.label}: control is a <button>, got <${f.tag.toLowerCase()}>`);
      ok(f.icons === 1, `${c.type}.${f.label}: exactly one iconify-icon, got ${f.icons}`);
      ok(f.fields === 1, `${c.type}.${f.label}: exactly one .boolfield, got ${f.fields}`);
      metrics.push({ case: c.type, origin: c.origin, ...f });
    }

    // Shoot the ROWS THEMSELVES, not the panel: the boolean rows live in the
    // FORMATTING accordion, below the panel's scroll fold, so a panel-level
    // screenshot would show none of them. Each row is scrolled into view and
    // captured at its natural size, which is what makes the contact sheet an
    // apples-to-apples comparison instead of a set of rescaled panels.
    for (const label of c.rows) {
      const handle = await page.evaluateHandle((lbl) => {
        const row = [...document.querySelectorAll(".inspector .row")]
          .find((r) => r.querySelector(".label")?.textContent?.trim() === lbl);
        row?.scrollIntoView({ block: "center" });
        return row ?? null;
      }, label);
      const el = handle.asElement();
      if (el) {
        await new Promise((r) => setTimeout(r, 120));
        const file = `${c.type}__${label.replace(/[^a-zA-Z0-9]+/g, "_")}.png`;
        await el.screenshot({ path: resolve(shots, file) });
        rowShots.push({ file, type: c.type, origin: c.origin, label });
      }
      await handle.dispose();
    }
  }

  // No native checkbox anywhere in the editor chrome.
  const natives = await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length);
  ok(natives === 0, `no native <input type=checkbox> in the editor; got ${natives}`);

  // ── 2. Every control is metrically IDENTICAL, and its ONLY variation is the
  //      ON/OFF foreground color — the manifest's toggle-buttons ruling ("an
  //      active/toggled button must NOT get an opaque gray background… show
  //      active state another way (e.g. icon color)"). So the SHAPE signature
  //      excludes `color`, and `color` is then asserted to be a two-valued
  //      function of the state, never of the widget or the former kind name.
  const sig = (m) => `${m.w}x${m.h}|bg:${m.bg}|b:${m.border}|r:${m.radius}|${m.tag}`;
  const signatures = new Map();
  for (const m of metrics) {
    const s = sig(m);
    if (!signatures.has(s)) signatures.set(s, []);
    signatures.get(s).push(`${m.case}.${m.label} [${m.origin}]`);
  }
  ok(signatures.size === 1,
    `ALL boolean controls share ONE shape signature; got ${signatures.size}:\n` +
      [...signatures.entries()].map(([s, who]) => `    ${s}\n      ${who.join("\n      ")}`).join("\n"));
  ok(metrics.length >= 12, `probed a meaningful number of boolean rows; got ${metrics.length}`);

  // Background is transparent in BOTH states (the toggle-buttons ruling).
  const opaque = metrics.filter((m) => !/rgba\(0, 0, 0, 0\)|transparent/.test(m.bg));
  ok(opaque.length === 0, `no toggled control takes a background fill; offenders: ${JSON.stringify(opaque.map((m) => `${m.case}.${m.label}=${m.bg}`))}`);

  // Exactly TWO foreground colors exist, and each is determined by the state —
  // if a migrated row and an always-boolean row in the SAME state differed, this
  // partition would have more than two buckets or would not align with `on`.
  const onColors = new Set(metrics.filter((m) => m.on).map((m) => m.color));
  const offColors = new Set(metrics.filter((m) => !m.on).map((m) => m.color));
  ok(onColors.size === 1, `every ON control shares one color; got ${JSON.stringify([...onColors])}`);
  ok(offColors.size === 1, `every OFF control shares one color; got ${JSON.stringify([...offColors])}`);
  ok([...onColors][0] !== [...offColors][0], "ON and OFF are distinguishable by icon color");
  ok(metrics.every((m) => m.on === m.onClass), "aria-pressed and the .on class always agree");
  // Both states are actually represented, or the color partition proves nothing.
  ok(metrics.some((m) => m.on) && metrics.some((m) => !m.on), "the probe covers both ON and OFF controls");
  // Both a migrated row and an always-boolean row appear in the SAME state.
  const sameState = [true, false].some((st) =>
    metrics.some((m) => m.on === st && m.origin === "migrated-from-checkbox") &&
    metrics.some((m) => m.on === st && m.origin === "always-boolean"));
  ok(sameState, "a migrated row and an always-boolean row are compared in the same ON/OFF state");
  // The equation affordance (Tier 0) must be present on migrated rows too.
  const noEq = metrics.filter((m) => !m.hasEq && m.case !== "camera");
  ok(noEq.length === 0, `every item boolean row keeps its "=" affordance; missing on ${JSON.stringify(noEq.map((m) => `${m.case}.${m.label}`))}`);

  // ── 3. Preview + ONE undo unit on a MIGRATED row (text "Bold") ─────────────
  const textId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("text").defaults, x: 300, y: 300 });
    return app.selection;
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { for (const h of document.querySelectorAll(".inspector .cat-head[aria-expanded='false']")) h.click(); });
  await new Promise((r) => setTimeout(r, 200));

  const boldBefore = await page.evaluate((id) => window.__powerrp_app.rawState().items[id].bold, textId);
  // Instrument setPreview + undoLog.commit. `past` is private to createUndo, so
  // "exactly one undo unit" is counted at the ONE place a unit is created
  // (undoLog.commit) rather than inferred from a length that is not exposed.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    window.__previewCalls = [];
    window.__commitCount = 0;
    const realPreview = app.setPreview.bind(app);
    app.setPreview = (pairs) => { window.__previewCalls.push(JSON.parse(JSON.stringify(pairs))); return realPreview(pairs); };
    const realCommit = app.undoLog.commit.bind(app.undoLog);
    app.undoLog.commit = (doc) => { window.__commitCount += 1; return realCommit(doc); };
  });
  const clicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent?.trim() === "Bold");
    const b = row?.querySelector(".boolbtn");
    if (!b) return false;
    b.click();
    return true;
  });
  ok(clicked, "migrated row (text Bold): toggle clicked");
  await new Promise((r) => setTimeout(r, 220));
  const after = await page.evaluate((id) => ({
    bold: window.__powerrp_app.rawState().items[id].bold,
    commits: window.__commitCount,
    canUndo: window.__powerrp_app.undoLog.canUndo,
    previews: window.__previewCalls.length,
    previewPath: window.__previewCalls[0]?.[0]?.[0] ?? null,
    previewValue: window.__previewCalls[0]?.[0]?.[1] ?? null,
  }), textId);
  ok(after.previews === 1, `migrated row previews through app.setPreview exactly once; got ${after.previews}`);
  ok(Array.isArray(after.previewPath) && after.previewPath[2] === "bold",
    `preview writes the item's own path; got ${JSON.stringify(after.previewPath)}`);
  ok(after.previewValue === !boldBefore, `preview carries the flipped value (${!boldBefore}); got ${after.previewValue}`);
  ok(after.bold === !boldBefore, `migrated row commits the flip (${boldBefore} -> ${after.bold})`);
  ok(after.commits === 1, `migrated row commits EXACTLY ONE undo unit; undoLog.commit called ${after.commits}x`);
  ok(after.canUndo, "the flip is undoable");
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 180));
  const undone = await page.evaluate((id) => window.__powerrp_app.rawState().items[id].bold, textId);
  ok(undone === boldBefore, `one undo fully reverts the flip (back to ${boldBefore}); got ${undone}`);

  // ── 4. `=` equation still binds a MIGRATED boolean row ─────────────────────
  await page.evaluate((id) => { const a = window.__powerrp_app; a.selection = id; }, textId);
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate((id) => {
    const a = window.__powerrp_app;
    a.setPreview([[["items", id, "bold"], "=true"]]);
    a.commitPreview();
  }, textId);
  await new Promise((r) => setTimeout(r, 300));
  const eq = await page.evaluate((id) => ({
    stored: window.__powerrp_app.rawState().items[id].bold,
    evaluated: window.__powerrp_app.state().items[id].bold,
    eqErrors: (window.__powerrp_app.equationErrors ?? []).length,
  }), textId);
  ok(eq.stored === "=true", `migrated boolean row STORES the equation; got ${JSON.stringify(eq.stored)}`);
  ok(eq.evaluated === true, `migrated boolean row EVALUATES the equation to a real boolean; got ${JSON.stringify(eq.evaluated)}`);
  ok(eq.eqErrors === 0, `no equation errors on a boolean row; got ${eq.eqErrors}`);
  const panel2 = await page.$(".inspector");
  if (panel2) await panel2.screenshot({ path: resolve(shots, "text_bold_equation.png") });

  // ── Contact sheet: every probed pane side by side ──────────────────────────
  const sheet = await browser.newPage();
  await sheet.setViewport({ width: 900, height: 1100, deviceScaleFactor: 1 });
  // Grouped by ORIGIN so the eye compares the two former spellings directly.
  const groups = ["always-boolean", "migrated-from-checkbox", "retired-spelling-still-in-tree"];
  const body = groups.map((g) => {
    const tiles = rowShots.filter((r) => r.origin === g)
      .map((r) => `<figure><figcaption>${r.type} · ${r.label}</figcaption><img src="${r.file}"></figure>`).join("");
    return `<section><h2>${g}</h2><div class="grid">${tiles}</div></section>`;
  }).join("");
  await writeFile(resolve(shots, "sheet.html"),
    `<html><body>
     ${body}
     <style>
       body{margin:0;padding:16px;background:#14161c;color:#cfd3dc;font:13px system-ui}
       h2{font-size:14px;margin:18px 0 8px;color:#9aa4b8;letter-spacing:.08em;text-transform:uppercase}
       .grid{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
       figure{margin:0}
       figcaption{font-size:11px;color:#7d879c;padding-bottom:2px}
       img{display:block;border:1px solid #333;image-rendering:-webkit-optimize-contrast}
     </style>
     </body></html>`);
  await sheet.goto(`file://${resolve(shots, "sheet.html")}`, { waitUntil: "networkidle0" });
  await sheet.screenshot({ path: resolve(shots, "CONTACT_SHEET.png"), fullPage: true });

  const noise = errors.filter(isInsertNoise);
  if (noise.length) { console.warn(`(ignoring ${noise.length} placeholder-video media errors from inserting a default video widget)`); }
  for (let i = errors.length - 1; i >= 0; i--) if (isInsertNoise(errors[i])) errors.splice(i, 1);

  const failed = checks.filter(([p]) => !p);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`unique control signatures: ${signatures.size} -> ${[...signatures.keys()].join(" | ")}`);
  console.log(`shots: ${shots}`);
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log("OK boolean_uniformity_probe");
} finally {
  await browser.close();
  await server.close();
}
