/**
 * Mermaid widget INSPECTOR-editing browser probe.
 *
 * Self-spins its OWN Vite dev server (absolute configFile → cwd-independent),
 * then in headless Chromium:
 *   1. places a mermaid widget (crosshair drag) → the DEFAULT (multi-line)
 *      flowchart renders on the canvas (proves the async render→raster→image-ref
 *      path handles a multi-line `definition`);
 *   2. double-clicks it → confirms NO floating code-editor overlay opens. The
 *      mermaid→CodeEditController route was REMOVED; mermaid is edited via its
 *      Inspector property, exactly like codeblock's `code`;
 *   3. selects it → confirms `definition` is an ordinary, editable Inspector
 *      property row (a text input surfacing the current source), and that the
 *      plugin declares it as a "text" inspector row;
 *   4. edits `definition` THROUGH THAT INSPECTOR ROW to a different diagram →
 *      the new diagram renders (proves the inspector edit drives the render);
 *   5. edits it (via the Inspector) to a BAD definition → a LOUD red error
 *      affordance appears and the app does NOT crash.
 * Fails on any uncaught exception / dangerous renderer console error, or if any
 * assertion / pixel assertion fails. Saves VLM screenshots.
 *
 * NOTE: the Inspector "text" row is a single-line <input> (the codeblock-shared
 * kind), so inline edits use mermaid's `;` statement separator; the multi-line
 * DEFAULT still renders (step 1). A dedicated multi-line inspector control is a
 * codebase-wide follow-up already flagged on codeblock's `code` row.
 *
 * Backend-absent /api 404s are IGNORED (frontend-only run, per the task).
 *
 * Run:  node tests/mermaid_probe.js [http://localhost:PORT]
 *   (no arg → self-spins a server; an arg → reuses an already-running one)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "..", "web", "vite.config.js");
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks"); // POWERRP/.claude_vlm_checks (per task)

// Dangerous console/page errors (a pageerror is always fatal).
const DANGER = /webgpu|navigator\.gpu|no adapter|requestadapter|not implemented|uncaught|paintir|is not a function|cannot read/i;

// Single-line mermaid (`;` statement separator) — survives the single-line
// inspector <input> that a multi-line source would not (newlines are stripped).
const FLOW_EDIT = "flowchart LR; A[Client]-->B[Server]; B-->C[(Database)]; A-->C";
const BAD_DEF = "flowchart TD; {{{ this is not valid mermaid @@@";

async function spinServer() {
  const { createServer } = await import("vite");
  process.env.NO_OPEN = "1";
  const server = await createServer({
    configFile: CONFIG,
    server: { port: 0, open: false, host: "localhost" },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, "");
  return { server, url };
}

async function armAndPlace(page, cx, cy, half) {
  // Arm mermaid crosshair placement via the app, then drag a box on the canvas.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.armCrosshairPlacement(app.registry.get("mermaid"));
  });
  await page.mouse.move(cx - half, cy - half * 0.72);
  await page.mouse.down();
  await page.mouse.move(cx + half, cy + half * 0.72, { steps: 14 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 500));
}

/** In-page: screenshot the scene canvas, decode it, and count pixels matching a
 * predicate (over the whole canvas). */
async function countPixels(page, predicateSrc) {
  const shot = await (await page.$("canvas.scene")).screenshot({ encoding: "base64" });
  return page.evaluate(async (shot, predicateSrc) => {
    const pred = eval(predicateSrc);
    const im = new Image(); im.src = "data:image/png;base64," + shot; await im.decode();
    const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const cx = c.getContext("2d"); cx.drawImage(im, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2])) n++;
    return { n, px: c.width * c.height };
  }, shot, predicateSrc);
}

/** Select the (first) mermaid item and return its id — populates the Inspector. */
async function selectMermaid(page) {
  return page.evaluate(() => {
    const app = window.__powerrp_app;
    const entry = Object.entries(app.state().items || {}).find(([, s]) => s.type === "mermaid");
    if (!entry) return null;
    app.selection = entry[0];
    return entry[0];
  });
}

/** Read the Inspector's "Definition" property row: is it present as a text
 * <input>, and what value does it surface? */
async function readDefinitionRow(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Definition");
    if (!row) return { present: false, value: null };
    const input = row.querySelector('input[type="text"]');
    return { present: !!input, value: input ? input.value : null };
  });
}

/** Edit `definition` through the Inspector's text input the way a user would:
 * set the value + fire input/change so Svelte's oninput→preview / onchange→commit
 * handlers run. Returns the committed state value for verification. */
async function setDefinitionViaInspector(page, def) {
  const res = await page.evaluate((def) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Definition");
    const input = row?.querySelector('input[type="text"]');
    if (!input) return { found: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, def);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true };
  }, def);
  await new Promise((r) => setTimeout(r, 300));
  const committed = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const item = Object.values(app.state().items || {}).find((s) => s.type === "mermaid");
    return item?.definition ?? null;
  });
  return { ...res, committed };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const arg = process.argv[2];
  const spun = arg ? null : await spinServer();
  const url = arg || spun.url;

  const errors = [];
  const asserts = [];
  const ok = (name, pass, detail) => { asserts.push({ name, pass, detail }); };

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000)); // Skia wasm + fonts + first paint

    const box = await page.evaluate(() => { const c = document.querySelector("canvas.scene"); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

    // 1) PLACE a mermaid widget → the DEFAULT (multi-line) flowchart renders.
    await armAndPlace(page, cx, cy, 320);
    await new Promise((r) => setTimeout(r, 4500)); // lazy mermaid load + render + raster

    const item = await page.evaluate(() => {
      const items = Object.values(window.__powerrp_app.state().items || {});
      const m = items.filter((s) => s.type === "mermaid");
      return { count: m.length, hasNewline: (m[0]?.definition ?? "").includes("\n") };
    });
    ok("mermaid widget created (type=mermaid)", item.count >= 1, `count ${item.count}`);
    ok("default definition is multi-line", item.hasNewline, `hasNewline ${item.hasNewline}`);

    // The white card fill (#ffffff) + dark diagram ink prove the raster landed
    // (not just an empty box). Dark ink = the flowchart text/edges over white.
    const inkPred = "((r,g,b)=>r<90&&g<90&&b<90)";
    const whitePred = "((r,g,b)=>r>240&&g>240&&b>240)";
    const white1 = await countPixels(page, whitePred);
    const ink1 = await countPixels(page, inkPred);
    ok("default flowchart card renders (white fill)", white1.n > 3000, `white ${white1.n}px`);
    ok("default flowchart diagram ink renders (dark pixels)", ink1.n > 400, `ink ${ink1.n}px`);
    await page.screenshot({ path: path.join(SHOTS, "mermaid_default.png") });

    // 2) DOUBLE-CLICK must NOT open a floating code-editor overlay (FIX: the
    //    mermaid→CodeEditController route is gone). The overlay only mounts when
    //    app.codeEditing is set; nothing sets it for mermaid anymore.
    await page.mouse.click(cx, cy, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 500));
    const overlayAbsent = await page.evaluate(() =>
      !window.__powerrp_codeEdit && !document.querySelector(".code-edit-input") && !document.querySelector(".code-edit-overlay-root"));
    ok("double-click opens NO floating code editor", overlayAbsent, `overlayAbsent ${overlayAbsent}`);

    // 3) `definition` is an ordinary, editable Inspector property row.
    const schema = await page.evaluate(() => {
      const insp = window.__powerrp_app.registry.get("mermaid").inspector ?? [];
      const row = insp.find((r) => r.key === "definition");
      return { present: !!row, kind: row?.kind ?? null };
    });
    ok("plugin declares `definition` as a text inspector row", schema.present && schema.kind === "text", `kind ${schema.kind}`);

    const selId = await selectMermaid(page);
    await new Promise((r) => setTimeout(r, 400));
    const defRow = await readDefinitionRow(page);
    ok("Inspector shows an editable Definition row", defRow.present, `present ${defRow.present}`);
    ok("Definition row surfaces the current source", (defRow.value ?? "").startsWith("flowchart"), `value "${(defRow.value ?? "").slice(0, 16)}…"`);

    // 4) EDIT the definition THROUGH the Inspector row → the new diagram renders.
    const edit = await setDefinitionViaInspector(page, FLOW_EDIT);
    ok("Inspector edit commits to the item's definition", edit.found && edit.committed === FLOW_EDIT, `committed "${(edit.committed ?? "").slice(0, 16)}…"`);
    await new Promise((r) => setTimeout(r, 4500)); // re-render + raster
    const ink2 = await countPixels(page, inkPred);
    ok("edited flowchart renders after inspector commit (dark ink)", ink2.n > 400, `ink ${ink2.n}px`);
    await page.screenshot({ path: path.join(SHOTS, "mermaid_inspector_edit.png") });

    // 5) EDIT to a BAD definition via the Inspector → LOUD red error, no crash.
    await setDefinitionViaInspector(page, BAD_DEF);
    await new Promise((r) => setTimeout(r, 4000));
    // ERROR_BG #f6c9c4 = rgb(246,201,196): a distinctive pink-red fill.
    const errPred = "((r,g,b)=>r>235&&g>180&&g<220&&b>175&&b<215)";
    const err = await countPixels(page, errPred);
    ok("bad definition shows the loud red error affordance", err.n > 500, `errBg ${err.n}px`);
    const alive = await page.evaluate(() => !!window.__powerrp_app && Object.keys(window.__powerrp_app.state().items || {}).length > 0);
    ok("app still alive after bad definition (no crash)", alive, `alive ${alive}`);
    await page.screenshot({ path: path.join(SHOTS, "mermaid_error.png") });
  } finally {
    await browser.close();
    if (spun) await spun.server.close();
  }

  const dangerous = errors.filter((e) => e.startsWith("pageerror:") || DANGER.test(e));
  console.log("Mermaid probe assertions:");
  for (const a of asserts) console.log(`  ${a.pass ? "ok  " : "FAIL"} ${a.name}  (${a.detail})`);
  if (dangerous.length) { console.log("\nDangerous errors:"); for (const e of dangerous) console.log("  " + e); }
  console.log(`\nscreenshots: ${SHOTS}/mermaid_{default,inspector_edit,error}.png`);
  const failed = asserts.filter((a) => !a.pass);
  if (failed.length || dangerous.length) {
    console.log(`\nRESULT: FAIL — ${failed.length} assertion(s), ${dangerous.length} dangerous error(s)`);
    process.exit(2);
  }
  console.log("\nRESULT: PASS — render + no floating editor + inspector-editable definition, zero dangerous errors");
})().catch((e) => { console.error("PROBE ERROR:", e.stack || e.message); process.exit(1); });
