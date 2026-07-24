/**
 * Mermaid widget + CodeEditController browser probe.
 *
 * Self-spins its OWN Vite dev server (absolute configFile → cwd-independent),
 * then in headless Chromium:
 *   1. places a mermaid widget (crosshair drag) → the DEFAULT flowchart renders
 *      on the canvas (proves the async render→raster→image-ref path);
 *   2. double-clicks it → the CodeEditController mounts (window.__powerrp_codeEdit
 *      appears), types a NEW flowchart definition, commits → the new diagram
 *      renders;
 *   3. edits it to a SEQUENCE diagram → renders;
 *   4. edits it to a BAD definition → a LOUD red error affordance appears and the
 *      app does NOT crash.
 * Fails on any uncaught exception / dangerous renderer console error, or if any
 * diagram/error-affordance pixel assertion fails. Saves VLM screenshots.
 *
 * Backend-absent /api 404s are IGNORED (frontend-only run, per the task).
 *
 * Run:  node tests/mermaid_probe.js [http://localhost:PORT]
 *   (no arg → self-spins a server; an arg → reuses an already-running one)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "..", "web", "vite.config.js");
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks"); // POWERRP/.claude_vlm_checks (per task)

// Dangerous console/page errors (a pageerror is always fatal).
const DANGER = /webgpu|navigator\.gpu|no adapter|requestadapter|not implemented|uncaught|paintir|is not a function|cannot read/i;

const FLOWCHART = "flowchart LR\n  A[Client] --> B(API)\n  B --> C{Cache?}\n  C -->|hit| D[Return]\n  C -->|miss| E[(Database)]\n  E --> D";
const SEQUENCE = "sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: Request\n  S-->>U: Response\n  U->>S: Ack";
const BAD_DEF = "flowchart TD\n  A --> {{{ this is not valid mermaid @@@";

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

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const arg = process.argv[2];
  const spun = arg ? null : await spinServer();
  const url = arg || spun.url;

  const errors = [];
  const asserts = [];
  const ok = (name, pass, detail) => { asserts.push({ name, pass, detail }); };

  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000)); // Skia wasm + fonts + first paint

    const box = await page.evaluate(() => { const c = document.querySelector("canvas.scene"); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

    // 1) PLACE a mermaid widget → the DEFAULT flowchart renders.
    await armAndPlace(page, cx, cy, 320);
    await new Promise((r) => setTimeout(r, 4500)); // lazy mermaid load + render + raster

    const item = await page.evaluate(() => {
      const items = Object.values(window.__powerrp_app.state().items || {});
      const m = items.filter((s) => s.type === "mermaid");
      return { count: m.length, def: m[0]?.definition?.slice(0, 20) };
    });
    ok("mermaid widget created (type=mermaid)", item.count >= 1, `count ${item.count}`);

    // The white card fill (#ffffff) + dark diagram ink prove the raster landed
    // (not just an empty box). Dark ink = the flowchart text/edges over white.
    const inkPred = "((r,g,b)=>r<90&&g<90&&b<90)";
    const whitePred = "((r,g,b)=>r>240&&g>240&&b>240)";
    const white1 = await countPixels(page, whitePred);
    const ink1 = await countPixels(page, inkPred);
    ok("default flowchart card renders (white fill)", white1.n > 3000, `white ${white1.n}px`);
    ok("default flowchart diagram ink renders (dark pixels)", ink1.n > 400, `ink ${ink1.n}px`);
    await page.screenshot({ path: path.join(SHOTS, "mermaid_default.png") });

    // 2) DOUBLE-CLICK → the code editor mounts; type a new flowchart; commit.
    await page.mouse.click(cx, cy, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 400));
    const editorUp = await page.evaluate(() => !!window.__powerrp_codeEdit && !!document.querySelector(".code-edit-input"));
    ok("CodeEditController mounts on double-click", editorUp, `editor ${editorUp}`);

    await page.evaluate((def) => window.__powerrp_codeEdit.setValue(def), FLOWCHART);
    const typed = await page.evaluate(() => window.__powerrp_codeEdit.getValue());
    ok("editor round-trips the typed definition", typed === FLOWCHART, `len ${typed.length}`);
    await page.evaluate(() => window.__powerrp_codeEdit.commit());
    await new Promise((r) => setTimeout(r, 4500));

    const ink2 = await countPixels(page, inkPred);
    ok("edited flowchart renders after commit (dark ink)", ink2.n > 400, `ink ${ink2.n}px`);
    await page.screenshot({ path: path.join(SHOTS, "mermaid_flowchart.png") });

    // 3) EDIT to a SEQUENCE diagram.
    await page.mouse.click(cx, cy, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate((def) => window.__powerrp_codeEdit.setValue(def), SEQUENCE);
    await page.evaluate(() => window.__powerrp_codeEdit.commit());
    await new Promise((r) => setTimeout(r, 4500));
    const ink3 = await countPixels(page, inkPred);
    ok("sequence diagram renders after commit (dark ink)", ink3.n > 300, `ink ${ink3.n}px`);
    await page.screenshot({ path: path.join(SHOTS, "mermaid_sequence.png") });

    // 4) EDIT to a BAD definition → LOUD red error affordance, no crash.
    await page.mouse.click(cx, cy, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate((def) => window.__powerrp_codeEdit.setValue(def), BAD_DEF);
    await page.evaluate(() => window.__powerrp_codeEdit.commit());
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
  console.log(`\nscreenshots: ${SHOTS}/mermaid_{default,flowchart,sequence,error}.png`);
  const failed = asserts.filter((a) => !a.pass);
  if (failed.length || dangerous.length) {
    console.log(`\nRESULT: FAIL — ${failed.length} assertion(s), ${dangerous.length} dangerous error(s)`);
    process.exit(2);
  }
  console.log("\nRESULT: PASS — place + render + code-edit + error affordance, zero dangerous errors");
})().catch((e) => { console.error("PROBE ERROR:", e.stack || e.message); process.exit(1); });
