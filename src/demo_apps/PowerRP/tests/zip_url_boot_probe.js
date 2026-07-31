/**
 * ?zip= BOOT PROBE — the share link, from a real HTTP origin, in a real browser.
 *
 * THE FEATURE (user): "there should be a share url", "there should be a loading
 * bar in case it takes a while". So a deck is shareable as
 * `https://…/?zip=<url-to-zip>`, and following one must (a) show REAL download
 * progress on the boot splash, (b) open the deck as an UNSAVED DRAFT, and (c)
 * leave the project library alone — every time, no matter how often the link is
 * opened.
 *
 * WHAT IT ASSERTS:
 *   1. THE SPLASH SHOWS A DOWNLOAD STAGE with honest bytes, and the deck opens as
 *      a draft whose sourceUrl is the link — which is what enables Copy Share Link.
 *   2. THE LIBRARY IS UNTOUCHED, and a REVISIT makes a fresh draft rather than a
 *      second project. This is the assertion that replaced the predecessor's
 *      localStorage idempotency memo: the memo existed to stop a five-times-opened
 *      link leaving five projects, and drafts make it leave zero.
 *   3. THE SHARE LINK ROUND-TRIPS: shareLink() rebuilds a URL whose ?zip= is the
 *      origin URL byte-for-byte, so what the user copies is what a recipient opens.
 *   4. A CORS-BLOCKED HOST produces the HELPFUL refusal — one that NAMES CORS,
 *      states the exact response header a host owner can add, and offers the
 *      download-then-drag path. A bare "Failed to fetch" would be true and useless.
 *   5. NO ?zip= = NO EXTRA STAGE, which is the warm-load no-flash rule: the splash
 *      must not grow a download line for a boot that downloads nothing.
 *
 * TWO ORIGINS, and the split is the point: one sends `Access-Control-Allow-Origin`
 * and one deliberately does not, so cases 1-3 and case 4 are the SAME code path
 * differing only in the header the host chose to send.
 *
 * Runs under ?static=1 (no backend), which also means the proxy is unavailable —
 * exactly the deployment where the CORS message is the only honest answer.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { zipSync } = await import("fflate");
const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";
const b64Bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

/** Pure function. A one-slide deck carrying one image asset, as .zip bytes. */
function buildDeckZip(name) {
  const enc = new TextEncoder();
  const doc = {
    meta: { name, slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" },
          img: { type: "image", active: true, x: 100, y: 100, w: 320, h: 180, rotation: 0, scale: 1, src: "logo.png" },
        },
      },
    }],
  };
  return zipSync({
    [`${name}/doc.json`]: enc.encode(JSON.stringify(doc, null, 2)),
    [`${name}/assets/logo.png`]: b64Bytes(PNG_B64),
  }, { level: 6 });
}

const DECK = Buffer.from(buildDeckZip("SharedDeck"));

/**
 * Command. A static origin serving DECK at /deck.zip.
 *
 * `cors` decides whether it sends Access-Control-Allow-Origin — the ONE
 * difference between the happy path and the blocked path, which is exactly how
 * it works in the wild: the same file, the same request, and the host's own
 * choice of header decides whether a browser will hand it to a page.
 *
 * Content-Length is always sent so the progress bar has a real denominator; the
 * bytes-unknown case is the boot splash's own contract and is covered there.
 */
function startOrigin(cors) {
  const srv = createHttpServer((req, res) => {
    if (!req.url.startsWith("/deck.zip")) { res.writeHead(404).end(); return; }
    const headers = { "Content-Type": "application/zip", "Content-Length": String(DECK.length) };
    if (cors) headers["Access-Control-Allow-Origin"] = "*";
    res.writeHead(200, headers);
    res.end(DECK);
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, port: srv.address().port })));
}

const open = await startOrigin(true);
const blocked = await startOrigin(false);
const openZipUrl = `http://127.0.0.1:${open.port}/deck.zip`;
const blockedZipUrl = `http://127.0.0.1:${blocked.port}/deck.zip`;

/** Query (in-page). The draft facts, with draftMode spread out of its $state proxy
 *  (puppeteer serializes a proxy as {}). */
const draftState = (page) => page.evaluate(async () => ({
  draftMode: window.__powerrp_app.draftMode ? { ...window.__powerrp_app.draftMode } : null,
  displayName: window.__powerrp_app.projectDisplayName(),
  projectName: window.__powerrp_app.projectName(),
  saveState: window.__powerrp_app.saveState(),
  shareLink: window.__powerrp_app.shareLink(),
  projects: (await window.__powerrp_app.listProjects()).map((p) => p.name),
}));

/**
 * Query. Boot a page at `url`, RECORDING every boot-splash stage as it happens.
 *
 * The recorder is installed BEFORE navigation and wraps `window.__powerrp_boot`
 * on the new document, because the splash's stages are transient: by the time the
 * deck is open the splash is gone, so asking afterwards would find nothing and
 * prove nothing. This is the only way to assert "the download had its own stage".
 */
async function bootRecording(page, url) {
  await page.evaluateOnNewDocument(() => {
    window.__stages = [];
    const install = () => {
      const boot = window.__powerrp_boot;
      if (!boot || boot.__wrapped) return false;
      const realStage = boot.stage.bind(boot);
      boot.stage = (id, label, detail) => { window.__stages.push({ id, label, ...detail }); return realStage(id, label, detail); };
      boot.__wrapped = true;
      return true;
    };
    // The splash's inline script may not have run yet at document-start, so retry
    // on a microtask cadence until it appears (bounded by the page's own load).
    if (!install()) {
      const t = setInterval(() => { if (install()) clearInterval(t); }, 5);
      window.addEventListener("load", () => clearInterval(t));
    }
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(5000); // wasm + fonts + the download + first paint
  return page.evaluate(() => window.__stages ?? []);
}

try {
  // ── 1. ?zip= boots, with the download as its own splash stage ──────────────
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const stages = await bootRecording(page, `${baseUrl}/?static=1&zip=${encodeURIComponent(openZipUrl)}`);

  const zipStages = stages.filter((s) => s.id === "zip");
  assert(zipStages.length > 0, `the boot splash got a DOWNLOAD stage of its own (stages seen: ${JSON.stringify([...new Set(stages.map((s) => s.id))])})`);
  assert(zipStages.some((s) => /download/i.test(s.label ?? "")), `the download stage is LABELLED as a download (got "${zipStages[0]?.label}")`);
  // HONEST BYTES: the origin sends Content-Length, so a real total must appear —
  // and the loaded count must actually reach it rather than being a placeholder.
  const withTotal = zipStages.filter((s) => s.total > 0);
  assert(withTotal.length > 0, "the download stage reported a REAL total (the origin sent Content-Length)");
  assert(withTotal.some((s) => s.loaded === DECK.length && s.total === DECK.length),
    `the download stage reached the full ${DECK.length} bytes (last: ${JSON.stringify(withTotal[withTotal.length - 1])})`);

  const s1 = await draftState(page);
  assert(s1.draftMode !== null, "the ?zip= deck opened as a DRAFT");
  assert(s1.displayName === "SharedDeck", `the draft shows the deck's human name (got "${s1.displayName}")`);
  assert(s1.projectName.startsWith("~draft/"), `projectName() answers the draft key (got "${s1.projectName}")`);
  assert(s1.saveState === "unsaved", `the save indicator reads UNSAVED (got "${s1.saveState}")`);
  assert(s1.projects.length === 0, `THE RULING: following a share link added NOTHING to the project library (found: ${JSON.stringify(s1.projects)})`);
  assert(s1.draftMode?.sourceUrl === openZipUrl, `the draft remembers where it came from (got "${s1.draftMode?.sourceUrl}")`);

  // ── 3. The share link round-trips ─────────────────────────────────────────
  assert(s1.shareLink !== null, "a URL-sourced draft HAS a share link");
  assert(new URL(s1.shareLink).searchParams.get("zip") === openZipUrl,
    `the share link's ?zip= is the origin URL byte-for-byte (got "${new URL(s1.shareLink).searchParams.get("zip")}")`);
  assert(!new URL(s1.shareLink).searchParams.has("static"),
    "the share link DROPS the current query — a recipient must not inherit ?static=1");

  // ── 2. A REVISIT is a fresh draft, never a second project ─────────────────
  const stages2 = await bootRecording(page, `${baseUrl}/?static=1&zip=${encodeURIComponent(openZipUrl)}`);
  assert(stages2.filter((s) => s.id === "zip").length > 0, "the revisit downloaded again (no memo, by design — a draft costs nothing to remake)");
  const s2 = await draftState(page);
  assert(s2.draftMode !== null, "the revisit opened another DRAFT");
  assert(s2.projects.length === 0,
    `THE MEMO IS UNNECESSARY: opening the same link twice STILL leaves the library empty (found: ${JSON.stringify(s2.projects)})`);

  // ── 5. No ?zip= means no download stage (the warm-load no-flash rule) ──────
  const stages3 = await bootRecording(page, `${baseUrl}/?static=1`);
  assert(stages3.filter((s) => s.id === "zip").length === 0,
    `a boot with no ?zip= declares NO download stage (found: ${JSON.stringify(stages3.filter((s) => s.id === "zip"))})`);

  // ── 4. THE CORS-BLOCKED HOST gets the helpful refusal ─────────────────────
  // Asserted through the SAME command the modal calls, so what is checked is the
  // message the user actually meets. In static mode there is no proxy to retry
  // through, which is precisely when the explanation has to carry its weight.
  const help = await page.evaluate(async (url) => {
    try {
      await window.__powerrp_app.openProjectFromUrl(url, () => {});
      return { threw: false };
    } catch (e) {
      return { threw: true, name: e?.name ?? null, help: e?.help ? { ...e.help } : null, message: String(e?.message ?? e) };
    }
  }, blockedZipUrl);

  assert(help.threw, "a CORS-blocked download FAILS LOUDLY rather than opening an empty deck");
  assert(help.name === "ZipFetchBlockedError", `the refusal is the typed blocked error (got "${help.name}")`);
  assert(help.help !== null, "the refusal carries STRUCTURED help, so the UI can render the link as a link");
  assert(/CORS/.test(help.help?.title ?? "") || /CORS/.test(help.help?.cause ?? ""), `the message NAMES CORS (title: "${help.help?.title}")`);
  assert(help.help?.hostFix === "Access-Control-Allow-Origin: *", `it states the exact header a host owner adds (got "${help.help?.hostFix}")`);
  assert(/drag/i.test(help.help?.manual ?? ""), `it offers the download-then-drag fallback (got "${help.help?.manual}")`);
  assert(help.help?.url === blockedZipUrl, "it echoes the blocked URL, so the message can also be the link");

  // The blocked attempt must not have disturbed the open draft: a failed open is
  // a no-op, not a half-open that leaves the editor in an unclear state.
  const s4 = await draftState(page);
  assert(s4.projects.length === 0, `a blocked download added nothing to the library (found: ${JSON.stringify(s4.projects)})`);

  console.log(fails.length ? `\nzip_url_boot_probe: ${fails.length} FAILED` : "\nzip_url_boot_probe: all checks passed");
} finally {
  await browser.close();
  await server.close();
  open.srv.close();
  blocked.srv.close();
}
process.exit(fails.length ? 1 : 0);
