/**
 * Browser regression: SVG drop/paste/tile insertion, legacy image rendering,
 * and immediate reload after Save As, rename, undo and a failed draft save.
 * POWER_RP_TEST_URL can point at a production build under /SvelteLib/; otherwise
 * this owns an isolated frontend-only Vite. No user's browser profile is used.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { zipSync, strToU8 } from "fflate";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><path fill="#ff0000" d="M0 0H180V90H0Z"/></svg>';
const SVG_NAME = "bird.svg";
const MIN_ARTWORK_PIXELS = 500; // far more than a toolbar icon; less than the 180×90 artwork
const BOOT_TIMEOUT = 60_000; // CanvasKit and fonts can be cold under the full gate
const configFile = fileURLToPath(new URL("../web/vite.config.js", import.meta.url));
const server = process.env.POWER_RP_TEST_URL ? null : await createServer({ configFile, server: { port: 0, host: "127.0.0.1", open: false } });
await server?.listen();
const url = process.env.POWER_RP_TEST_URL ?? `http://127.0.0.1:${server.httpServer.address().port}/?static=1`;
const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => { errors.push(e.message); console.error("PAGE ERROR", e.message); });
page.on("console", m => {
  if (m.type() === "error") {
    console.error("BROWSER", m.text());
    // A missing backend probe/favicon is expected on a frontend-only host.
    if (!/^Failed to load resource:|^VideoV7: WebGPU init failed — using 2D drawImage fallback: Error: VideoV7: no WebGPU adapter$/.test(m.text())) errors.push(m.text());
  }
});

/**
 * Command. Wait until the restored editor has mounted.
 * @returns {Promise<void>}
 * @example await ready() // the working copy and assets are available
 */
async function ready() {
  await page.waitForFunction(() => window.__powerrp_app && document.querySelector("svg.overlay"), { timeout: BOOT_TIMEOUT });
}

/**
 * Command. Reload the isolated browser without another edit or artificial delay.
 * @returns {Promise<void>}
 * @example await reload() // exercises persisted recovery, not live object URLs
 */
async function reload() {
  await page.reload({ waitUntil: "networkidle0" });
  await ready();
}

/**
 * Command. List assets (primes URL caches), then read identity, document and SVG bytes.
 * @returns {Promise<object>}
 * @example await facts() // {name: 'Birds', draft: false, state: 'saved', ...}
 */
async function facts() {
  return page.evaluate(async (filename) => {
    const a = window.__powerrp_app;
    const assets = await a.listProjectAssets();
    const asset = assets.find(x => x.name === filename);
    return {
      name: a.projectDisplayName(), key: a.projectName(), draft: a.isDraft(), state: a.saveState(),
      doc: JSON.parse(JSON.stringify(a.doc)), assets,
      bytes: asset ? await (await fetch(window.__powerrp_storage.assetStore().resolveUrl(asset.url))).text() : null,
    };
  }, SVG_NAME);
}

/**
 * Command. Assert the canvas screenshot contains substantial opaque red artwork; log the result.
 * Uses rendered pixels, not a URL or a widget count as a proxy for visibility.
 * @returns {Promise<void>}
 * @example await visibleArtwork() // fails if the red SVG became a blank canvas
 */
async function visibleArtwork() {
  const canvas = await page.$("svg.overlay");
  const { data } = PNG.sync.read(await page.screenshot({ clip: await canvas.boundingBox() }));
  let red = 0;
  const RED_MIN = 220, OTHER_MAX = 40; // tolerate antialiasing, exclude dark UI/background
  for (let i = 0; i < data.length; i += 4)
    if (data[i] > RED_MIN && data[i + 1] < OTHER_MAX && data[i + 2] < OTHER_MAX) red++;
  assert.ok(red > MIN_ARTWORK_PIXELS, `visible artwork, not merely a stored asset: ${red} red pixels`);
  console.log(`  ok rendered artwork (${red} red pixels)`);
}

try {
  await page.setViewport({ width: 1400, height: 900 });
  console.log(`SVG/recovery probe: ${url}`);
  await page.goto(url, { waitUntil: "networkidle0" });
  await ready();
  await page.evaluate((svg) => {
    const a = window.__powerrp_app;
    a.clearDoc();
    const dt = new DataTransfer(); dt.items.add(new File([svg], "bird.svg", { type: "image/svg+xml" }));
    const canvas = document.querySelector("svg.overlay"), r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  }, SVG);
  await page.waitForFunction(() => window.__powerrp_app.nodes().some(n => n.state.type === "svg"));
  let state = await facts();
  assert.equal(state.assets.find(a => a.name === SVG_NAME)?.kind, "svg");
  assert.equal(state.bytes, SVG);
  assert.ok(!JSON.stringify(state.doc).includes("blob:"), "document contains portable references");
  await visibleArtwork();
  console.log("  ok real file drop creates an SVG widget and stores SVG bytes");

  // The actual Save As dialog, not a pre-renamed document passed to a save API.
  await page.evaluate(() => window.__powerrp_app.showSaveModal());
  await page.waitForSelector(".name-modal input");
  await page.$eval(".name-modal input", el => { el.value = "Birds"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.$eval(".name-modal", el => el.requestSubmit());
  await page.waitForFunction(() => window.__powerrp_app.projectName() === "Birds" && !window.__powerrp_app.saving);
  await reload();
  state = await facts();
  assert.equal(state.name, "Birds"); assert.equal(state.draft, false); assert.equal(state.state, "saved"); assert.equal(state.bytes, SVG);
  await visibleArtwork();
  console.log("  ok Save As + immediate reload keeps artwork, name, and saved status");

  await page.evaluate(async () => { await window.__powerrp_app.renameProject("Renamed Birds"); });
  await reload();
  state = await facts();
  assert.equal(state.name, "Renamed Birds"); assert.equal(state.bytes, SVG); assert.equal(state.state, "saved");
  await visibleArtwork();
  console.log("  ok rename + immediate reload keeps the new asset library");

  await page.evaluate(async () => {
    const a = window.__powerrp_app, asset = (await a.listProjectAssets()).find(x => x.name === "bird.svg");
    const dt = new DataTransfer(); dt.setData("application/x-powerrp-asset", JSON.stringify(asset));
    const canvas = document.querySelector("svg.overlay"), r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  });
  await page.waitForFunction(() => window.__powerrp_app.nodes().filter(n => n.state.type === "svg").length === 2);
  await page.evaluate((svg) => {
    document.activeElement?.blur();
    const dt = new DataTransfer(); dt.items.add(new File([svg], "pasted.svg", { type: "image/svg+xml" }));
    window.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  }, SVG);
  await page.waitForFunction(() => window.__powerrp_app.nodes().filter(n => n.state.type === "svg").length === 3);
  console.log("  ok asset-tile drop and clipboard file paste also create SVG widgets");

  // Old documents stored SVGs as images. Verify those without converting them.
  await page.evaluate(() => {
    const a = window.__powerrp_app, doc = JSON.parse(JSON.stringify(a.doc));
    for (const item of Object.values(doc.slides[0].delta.items)) {
      if (item.type === "svg") { item.type = "image"; item.src = item.svgUrl; delete item.svgUrl; }
    }
    a.commit(doc);
  });
  await reload();
  await visibleArtwork();
  console.log("  ok legacy SVG-as-image documents render after reload");

  await page.click('button[aria-label="Insert bird.svg into slide"]');
  await page.waitForFunction(() => window.__powerrp_app.nodes().some(n => n.state.type === "svg"));
  console.log("  ok the library insert button creates an SVG, not an Image");

  const beforeUndo = (await facts()).doc;
  await page.evaluate(() => {
    const a = window.__powerrp_app;
    a.commit({ ...a.doc, meta: { ...a.doc.meta, script: "// regression edit" } });
    a.undo();
  });
  await reload();
  assert.deepEqual((await facts()).doc, beforeUndo);
  console.log("  ok undo is persisted without needing a subsequent edit");

  // Make an imported draft containing SVG and an asset-defined widget. Registry
  // loading must precede repair, or the custom widget is deleted during boot.
  const doc = (await facts()).doc;
  doc.meta.name = "Imported Birds";
  doc.slides[0].delta.items.custom = { type: "recovery_marker", x: 0, y: 0, w: 20, h: 20, active: true };
  const plugin = 'return {type:"recovery_marker",title:"Recovery marker",ephemeral:"none",capabilities:{},defaults:{type:"recovery_marker",x:0,y:0,w:20,h:20},emit:()=>[]};';
  const bytes = zipSync({ "Imported Birds/doc.json": strToU8(JSON.stringify(doc)), "Imported Birds/assets/bird.svg": strToU8(SVG), "Imported Birds/assets/pasted.svg": strToU8(SVG), "Imported Birds/assets/marker.plugin.js": strToU8(plugin) });
  await page.evaluate(async (bytes) => {
    await window.__powerrp_app.openDraftFromZipBytes(new Uint8Array(bytes), "Imported Birds");
  }, [...bytes]);
  await reload();
  state = await facts();
  assert.equal(state.draft, true); assert.equal(state.name, "Imported Birds");
  assert.equal(state.doc.slides[0].delta.items.custom?.type, "recovery_marker");
  await visibleArtwork();
  console.log("  ok draft reload registers custom widgets before repairing the document");

  const failedSave = await page.evaluate(async () => {
    const a = window.__powerrp_app, store = window.__powerrp_storage.projectStore(), save = store.save;
    store.save = async () => { throw new Error("TEST: simulated storage failure"); };
    let message;
    try { await a.commitDraft("Must not adopt this name"); }
    catch (e) { message = e.message; }
    finally { store.save = save; }
    return { message, name: a.projectDisplayName(), draft: a.isDraft() };
  });
  assert.equal(failedSave.message, "TEST: simulated storage failure"); assert.equal(failedSave.draft, true); assert.equal(failedSave.name, "Imported Birds");
  await reload();
  state = await facts();
  assert.equal(state.draft, true); assert.equal(state.name, "Imported Birds"); assert.equal(state.bytes, SVG);
  const cancelled = await page.evaluate(async () => {
    const a = window.__powerrp_app;
    a.confirmUnsavedWork = async () => "cancel";
    let opened = false;
    const allowed = await a.guardedOpen(async () => { opened = true; }, "another project");
    return { allowed, opened };
  });
  assert.deepEqual(cancelled, { allowed: false, opened: false });
  console.log("  ok failed save preserves draft and reload still guards unsaved work");

  await page.evaluate(async () => { await window.__powerrp_app.commitDraft("Kept Birds"); });
  await reload();
  state = await facts();
  assert.equal(state.name, "Kept Birds"); assert.equal(state.draft, false); assert.equal(state.state, "saved"); assert.equal(state.bytes, SVG);
  await visibleArtwork();
  const switched = await page.evaluate(async () => {
    const a = window.__powerrp_app, store = window.__powerrp_storage.projectStore(), save = store.save;
    let release;
    store.save = () => new Promise(resolve => { release = resolve; });
    try {
      const pending = a.saveToServer();
      a.clearDoc();
      const name = a.projectDisplayName();
      release();
      await pending;
      return { expected: name, actual: a.projectDisplayName(), draft: a.isDraft(), saved: a.everSaved };
    } finally { store.save = save; }
  });
  assert.equal(switched.actual, switched.expected); assert.equal(switched.draft, true); assert.equal(switched.saved, false);
  await reload();
  assert.equal((await facts()).name, switched.expected);
  console.log("  ok a late save cannot rename or mark a different document saved");
  assert.deepEqual(errors, [], "no unexpected browser errors");
  // Deliberately broken recovery must not be overwritten or silently repaired.
  const brokenRecovery = '{"doc":';
  await page.evaluate(value => localStorage.setItem("powerrp.autosave", value), brokenRecovery);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('#boot-splash[data-failed="1"]');
  const backup = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll("#boot-remedy button")];
    const retry = buttons.some(b => b.textContent === "Retry opening the editor");
    const download = buttons.find(b => b.textContent === "Download untouched recovery backup");
    let blob;
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = value => { blob = value; return create(value); };
    // Capture the downloadable bytes without writing into a user's Downloads.
    HTMLAnchorElement.prototype.click = () => {};
    try { download.click(); }
    finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; }
    return { retry, bytes: await blob.text(), stored: localStorage.getItem("powerrp.autosave") };
  });
  assert.equal(backup.retry, true); assert.equal(backup.bytes, brokenRecovery); assert.equal(backup.stored, brokenRecovery);
  console.log("  ok broken recovery fails visibly with retry and an untouched downloadable backup (expected boot error above)");
  console.log("PASS SVG import/rendering and save/reload recovery");
} finally {
  console.log("Closing regression browser…");
  await browser.close();
  console.log("Closing regression server…");
  await server?.close();
  console.log("Regression cleanup complete.");
}
