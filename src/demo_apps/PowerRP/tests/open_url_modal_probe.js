/**
 * OPEN-PROJECT-FROM-URL MODAL PROBE — the surface, not the pipeline.
 *
 * zip_url_boot_probe.js covers the ?zip= boot path and the fetch rules. THIS one
 * covers the thing a user actually clicks: the "Open Project from URL…" command,
 * its modal, and above all ITS PROGRESS BAR — asked for by name (user: "there
 * should be a loading bar in case it takes a while"). A deck with video is tens
 * of megabytes, so a fetch with no visible progress reads as a hung dialog, and
 * "it looked frozen" is a bug even when the download is healthy.
 *
 * WHAT IT ASSERTS:
 *   1. THE COMMAND EXISTS AND IS SURFACED — registry entry, palette-visible
 *      title, and a toolbar button in the file-ops group right after
 *      "open-project" (the order the user specified).
 *   2. THE MODAL OPENS with a focused, select-all URL field (selectAllOnMount, so
 *      typing replaces rather than appends).
 *   3. THE PROGRESS BAR IS REAL AND VISIBLE WHILE THE FETCH RUNS. The origin
 *      here TRICKLES the archive in chunks with a delay, so the bar is observable
 *      mid-flight rather than a frame that flicks past — and its width must
 *      actually ADVANCE, which is what separates a progress bar from a decoration.
 *   4. ENTER LOADS: submitting opens the deck as a draft and closes the modal,
 *      with nothing added to the project library.
 *   5. COPY SHARE LINK IS GATED: enabled for the URL-sourced draft this just
 *      opened, and DISABLED for a project with no URL — a command that cannot do
 *      its job must say so rather than copy a link that 404s.
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
const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";
const b64Bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

/** Pure function. A deck with FILLER so the archive is big enough that a chunked
 *  response has several observable progress steps rather than one. */
function buildDeckZip(name) {
  const enc = new TextEncoder();
  const doc = {
    meta: { name, slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: { items: {
        cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" },
        img: { type: "image", active: true, x: 100, y: 100, w: 320, h: 180, rotation: 0, scale: 1, src: "logo.png" },
      } },
    }],
  };
  return zipSync({
    [`${name}/doc.json`]: enc.encode(JSON.stringify(doc, null, 2)),
    [`${name}/assets/logo.png`]: b64Bytes(PNG_B64),
    // Incompressible filler: the progress bar needs a payload big enough to
    // arrive in several chunks, and random-ish bytes keep deflate from erasing it.
    [`${name}/assets/filler.bin`]: new Uint8Array(Array.from({ length: 400_000 }, (_, i) => (i * 2654435761) % 251)),
  }, { level: 0 });
}

const DECK = Buffer.from(buildDeckZip("UrlDeck"));

/** The number of chunks the origin splits the archive into, and the pause between
 *  them. Chosen so the whole download takes ~1s: long enough to sample the bar
 *  mid-flight several times, short enough not to slow the gate. */
const CHUNKS = 10;
const CHUNK_DELAY_MS = 90;

/** Command. A CORS-enabled origin that TRICKLES the deck, so the progress bar is
 *  observable in flight rather than completing within one frame. */
function startTricklingOrigin() {
  const srv = createHttpServer(async (req, res) => {
    if (!req.url.startsWith("/UrlDeck.zip")) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": String(DECK.length),
      "Access-Control-Allow-Origin": "*",
    });
    const size = Math.ceil(DECK.length / CHUNKS);
    for (let i = 0; i < DECK.length; i += size) {
      res.write(DECK.subarray(i, Math.min(i + size, DECK.length)));
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
    res.end();
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, port: srv.address().port })));
}

const origin = await startTricklingOrigin();
const zipUrl = `http://127.0.0.1:${origin.port}/UrlDeck.zip`;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(3500);

  // ── 1. The command is registered and surfaced ──────────────────────────────
  const cmd = await page.evaluate(() => {
    const c = window.__powerrp_app.commands.get("open-project-url");
    return c ? { title: c.title, icon: c.icon } : null;
  });
  assert(cmd !== null, "the command registry has \"open-project-url\"");
  assert(/URL/i.test(cmd?.title ?? ""), `its title names the transport (got "${cmd?.title}")`);

  // ORDER IS READ FROM aria-label, not a test-only attribute: the toolbar renders
  // each button's aria-label from the command's own title, so this asserts the
  // real rendered order without asking production markup to carry a hook that
  // exists only for this probe.
  const labels = await page.evaluate(() => [...document.querySelectorAll(".toolbar button.btn-icon")].map((b) => b.getAttribute("aria-label") ?? ""));
  const iOpen = labels.findIndex((l) => /^Open Project from (Browser|Server)/.test(l));
  const iUrl = labels.findIndex((l) => /^Open Project from URL/.test(l));
  assert(iUrl >= 0, `the toolbar shows the button (labels: ${JSON.stringify(labels.filter((l) => /Open Project/.test(l)))})`);
  assert(iOpen >= 0 && iUrl === iOpen + 1, `it sits DIRECTLY AFTER "open-project" — the user-specified order (open at ${iOpen}, url at ${iUrl})`);

  // ── 2. The modal opens with a select-all URL field ─────────────────────────
  await page.evaluate(() => window.__powerrp_app.runCommand("open-project-url"));
  await sleep(400);
  const field = await page.evaluate(() => {
    const input = document.querySelector(".name-modal-input");
    return input ? { focused: document.activeElement === input, placeholder: input.placeholder } : null;
  });
  assert(field !== null, "the modal mounted a URL field");
  assert(field?.focused, "the field is FOCUSED on open — the user can type immediately");
  assert(/https?:/i.test(field?.placeholder ?? ""), `the placeholder shows the expected shape (got "${field?.placeholder}")`);

  // ── 3. THE PROGRESS BAR, sampled WHILE the download runs ───────────────────
  await page.type(".name-modal-input", zipUrl);
  await page.evaluate(() => document.querySelector(".name-modal button[type=submit]").click());

  // Sample the bar repeatedly during the ~1s trickle. What is collected is the
  // rendered WIDTH and the byte label, so the assertions below are about what the
  // user can see, not about the state behind it.
  const samples = [];
  for (let i = 0; i < 14; i++) {
    samples.push(await page.evaluate(() => {
      const fill = document.querySelector(".url-progress-fill");
      const label = document.querySelector(".url-progress-label");
      if (!fill) return null;
      return { width: fill.getBoundingClientRect().width, text: label?.textContent?.trim() ?? "" };
    }));
    await sleep(90);
  }
  const seen = samples.filter(Boolean);
  assert(seen.length > 0, `the progress bar was VISIBLE during the download (${seen.length}/${samples.length} samples saw it)`);
  assert(seen.some((s) => /downloading/i.test(s.text)), `it says what it is doing (e.g. "${seen[0]?.text}")`);
  assert(seen.some((s) => /\d/.test(s.text) && /B|KB|MB/i.test(s.text)), `it reports REAL BYTES, not a spinner (e.g. "${seen.find((s) => /B/i.test(s.text))?.text}")`);
  // The origin sends Content-Length, so the DETERMINATE form ("X of Y (N%)") must
  // appear — not just the bytes-so-far form. Both are honest, but showing the
  // indeterminate one when a real denominator exists would waste it.
  const determinate = seen.find((s) => /of .* \(\d+%\)/.test(s.text));
  assert(determinate !== undefined, `with a Content-Length it shows the DETERMINATE form (samples: ${JSON.stringify(seen.map((s) => s.text).slice(0, 4))})`);
  // THE BAR MUST MOVE. A fill that never widens is decoration, and the whole
  // request was "in case it takes a while" — a frozen bar answers nothing.
  const widths = seen.map((s) => s.width);
  assert(Math.max(...widths) > Math.min(...widths), `the fill ADVANCED as bytes arrived (widths ${Math.min(...widths).toFixed(1)} → ${Math.max(...widths).toFixed(1)}px)`);

  // ── 4. The load completes into a DRAFT and the modal closes ────────────────
  await sleep(2500);
  const after = await page.evaluate(async () => ({
    modalOpen: document.querySelector(".url-progress") !== null || document.querySelector(".name-modal-input") !== null,
    draftMode: window.__powerrp_app.draftMode ? { ...window.__powerrp_app.draftMode } : null,
    name: window.__powerrp_app.projectDisplayName(),
    saveState: window.__powerrp_app.saveState(),
    projects: (await window.__powerrp_app.listProjects()).map((p) => p.name),
    shareLink: window.__powerrp_app.shareLink(),
  }));
  assert(!after.modalOpen, "the modal CLOSED once the deck opened");
  assert(after.draftMode !== null, "the deck opened as a DRAFT");
  assert(after.name === "UrlDeck", `the draft carries the deck's name (got "${after.name}")`);
  assert(after.saveState === "unsaved", `it reads UNSAVED (got "${after.saveState}")`);
  assert(after.projects.length === 0, `the project library is UNTOUCHED (found: ${JSON.stringify(after.projects)})`);
  assert(after.draftMode?.sourceUrl === zipUrl, `the draft remembers the URL it came from (got "${after.draftMode?.sourceUrl}")`);

  // ── 5. Copy Share Link is GATED on having a URL ────────────────────────────
  const gate = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const cmd = app.commands.get("copy-share-link");
    const enabledForDraft = cmd.when ? cmd.when(app) : true;
    // Now leave draft mode the way saving does, and re-ask. A saved project has
    // no address a recipient could fetch, so the command must go dark.
    app.draftMode = null;
    return { enabledForDraft, enabledForSaved: cmd.when ? cmd.when(app) : true, link: app.shareLink() };
  });
  assert(gate.enabledForDraft, "Copy Share Link is ENABLED for a URL-sourced draft");
  assert(!gate.enabledForSaved, "Copy Share Link is DISABLED once there is no URL-sourced draft — it must not offer a link that would 404");
  assert(gate.link === null, "shareLink() answers null in that state rather than inventing an address");
  assert(after.shareLink !== null && new URL(after.shareLink).searchParams.get("zip") === zipUrl,
    `while the draft was open the share link round-tripped the source URL (got "${after.shareLink}")`);

  // ── 6. ONE INPUT, BOTH GRAMMARS — the field says so, and the router routes ──
  // User ruling: "Open Project from URL should have a github link example in it —
  // literally the one we have now — saying it can be a zip from anywhere or a
  // github repository/branch", plus "it should support branches too". Checked in
  // the RENDERED modal, because a hint that exists only in the source helps
  // nobody, and checked ROUTE-ONLY (no network) so the gate stays offline-safe —
  // the live half is github_live_probe.js's branch fixture.
  await page.evaluate(() => window.__powerrp_app.runCommand("open-project-url"));
  await sleep(400);
  const hint = await page.evaluate(() => ({
    placeholder: document.querySelector(".name-modal-input")?.placeholder ?? "",
    label: document.querySelector(".name-modal-label")?.textContent?.trim() ?? "",
    notes: [...document.querySelectorAll(".name-modal-note")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
  }));
  const noteText = hint.notes.join(" | ");
  assert(/github|repository/i.test(hint.label), `the LABEL says a repository is accepted, not just a link (got "${hint.label}")`);
  assert(/RyannDaGreat\/PowerRP-RobotSim-Demo/.test(hint.placeholder + noteText), `the hint shows the REAL demo repo, not an invented placeholder (placeholder "${hint.placeholder}", notes ${JSON.stringify(hint.notes)})`);
  assert(/@main|@branch/.test(hint.placeholder + noteText), "…and shows the @branch form, which is the half the user had to ask for twice");
  assert(/\.zip/.test(hint.placeholder + noteText), "…while still showing a .zip example, since both are accepted");
  assert(hint.notes.length <= 3, `the hint stays SHORT — two lines plus the draft note (got ${hint.notes.length}: ${JSON.stringify(hint.notes)})`);

  // THE FOUR INPUT SHAPES, routed by the real app method with the loaders stubbed
  // so nothing leaves the machine. What is measured is WHICH loader each string
  // reaches — the routing decision — and that garbage is refused before either.
  const routed = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const realUrl = app.openProjectFromUrl.bind(app);
    const realRepo = app.openProjectFromRepo.bind(app);
    const out = [];
    for (const input of [
      "http://127.0.0.1:1/Deck.zip",
      "RyannDaGreat/PowerRP-RobotSim-Demo",
      "RyannDaGreat/PowerRP-RobotSim-Demo@branch-fixture",
      "not a deck at all",
    ]) {
      let went = null;
      app.openProjectFromUrl = async (u) => { went = `url:${u}`; };
      app.openProjectFromRepo = async (s) => { went = `repo:${s}`; };
      try { await app.openProjectFromAnySource(input); out.push({ input, went, error: null }); }
      catch (e) { out.push({ input, went, error: String(e?.message ?? e) }); }
    }
    app.openProjectFromUrl = realUrl;
    app.openProjectFromRepo = realRepo;
    return out;
  });
  const routeOf = (input) => routed.find((r) => r.input === input);
  assert(routeOf("http://127.0.0.1:1/Deck.zip")?.went?.startsWith("url:"), `a .zip URL routes to the zip fetcher (got ${JSON.stringify(routeOf("http://127.0.0.1:1/Deck.zip"))})`);
  assert(routeOf("RyannDaGreat/PowerRP-RobotSim-Demo")?.went === "repo:RyannDaGreat/PowerRP-RobotSim-Demo", `a bare slug routes to the GitHub loader (got ${JSON.stringify(routeOf("RyannDaGreat/PowerRP-RobotSim-Demo"))})`);
  assert(routeOf("RyannDaGreat/PowerRP-RobotSim-Demo@branch-fixture")?.went === "repo:RyannDaGreat/PowerRP-RobotSim-Demo@branch-fixture",
    `a slug WITH A BRANCH routes there too, branch intact (got ${JSON.stringify(routeOf("RyannDaGreat/PowerRP-RobotSim-Demo@branch-fixture"))})`);
  const garbage = routeOf("not a deck at all");
  assert(garbage?.went === null, "garbage reaches NEITHER loader — it must not fail as a confusing network error");
  assert(/neither a link nor a GitHub repository/i.test(garbage?.error ?? ""), `…it is refused LOUDLY with a sentence about the input (got ${JSON.stringify(garbage?.error)})`);

  console.log(fails.length ? `\nopen_url_modal_probe: ${fails.length} FAILED` : "\nopen_url_modal_probe: all checks passed");
} finally {
  await browser.close();
  await server.close();
  origin.srv.close();
}
process.exit(fails.length ? 1 : 0);
