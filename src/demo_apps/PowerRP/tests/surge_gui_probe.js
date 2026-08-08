/**
 * THE SURGE XT GUI MODAL, in a real browser.
 *
 * ── WHAT ONLY THIS CAN PROVE ────────────────────────────────────────────────
 * web/surgeGui.js is an adapter around 19.8 MB of WebAssembly, a 30.5 MB archive
 * unpacked into an Emscripten filesystem, a canvas, and a pointer/key protocol.
 * Not one of those exists in bare node — the glue module THROWS on import there
 * by design ("not compiled for this environment"). So everything below runs in
 * Chrome, through the app's OWN dev server, against the REAL module.
 *
 * ── THREE PARTS, DELIBERATELY SEPARATED BY WHAT THEY COST ───────────────────
 * A. THE PURE HALF (always runs, no network). The piano layout, the filesystem
 *    plan, the patch index, the JUCE key table, the failure sentence — driven
 *    through the dev server against the REAL vendored surge-data.json, not a
 *    fixture. These are the parts a wasm failure must not be able to hide.
 *
 * B. THE CHROME AND THE LOUD FAILURE (always runs, no network) — and this is the
 *    part worth the most. Every request to the remote host is ABORTED at the
 *    protocol level, which is exactly what an offline author's browser does. The
 *    modal must then render THE SENTENCE, naming the host, in the dialog. That is
 *    the project's no-silent-failure law for the one screen where "it looks fine"
 *    is least trustworthy: a Surge that mounted nothing still draws a complete,
 *    responsive, entirely dead interface. Mounting also proves the CSS is real
 *    (the :has() body-flush rule, the piano's 128 keys, the --a-surge-* tokens),
 *    which no unit test can.
 *
 * C. THE LIVE LOAD (network-gated). Actually downloads 49 MB from
 *    ryanndagreat.github.io, mounts 842 files, runs sgui_init, and asserts SURGE'S
 *    OWN counts — the patch count from its directory scan, not ours from the
 *    index. SKIPPED WITH A SENTENCE, not a failure, when the host is unreachable:
 *    a probe that goes red because a laptop is on a plane is a probe nobody
 *    believes. Set POWERRP_SURGE_SKIP_LIVE=1 to skip it deliberately.
 *
 * ── THE CACHE IS MEASURED, NOT ASSUMED ──────────────────────────────────────
 * Part C's first load is always COLD: puppeteer launches into a throwaway user
 * data directory, so Cache Storage starts empty every run. It then RELOADS the
 * same origin in the same browser and boots Surge a second time, which is the
 * only way to see the thing the caching exists for — the second boot must report
 * its bytes as cached, and be far faster. Part A separately pins the structural
 * rule (the cache is named, versioned, and is not any cache web/sw.js writes).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/surge_gui_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const app = resolve(repo, "src/demo_apps/PowerRP");
const webRoot = resolve(app, "web");

const SURGE_REMOTE_ORIGIN = "https://ryanndagreat.github.io";
/** The smallest remote artefact, used ONLY to decide whether part C can run. */
const REACHABILITY_URL = `${SURGE_REMOTE_ORIGIN}/WebSurge/src/data/surge-remote.json`;
/** 49 MB over a home connection is minutes, not seconds. */
const LIVE_LOAD_TIMEOUT_MS = 420000;

// HMR IS OFF, for the reason cli/render_job.js turns it off and
// tests/note_latch_probe.js records: in a worktree with other agents editing, a
// source save mid-run reloads the page and destroys the session being measured.
// Here it would also abandon a 49 MB download halfway.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const notes = [];
const ok = (cond, label) => {
  checks.push([!!cond, label]);
  if (!cond) errors.push(`CHECK FAILED: ${label}`);
};
const near = (a, b, eps, label) => ok(Math.abs(a - b) < eps, `${label} (got ${a}, want ~${b})`);

/**
 * Query. Opens a page on the app and waits for the splash to lift.
 *
 * THE SPLASH MUST LIFT BEFORE ANY SYNTHETIC CLICK: it is fixed, inset 0,
 * z-index 9999 until the first painted frame, so a tap before then lands on the
 * splash. 120 s for the reason tests/present_reachable_probe.js records — with
 * several agents' Vite servers on one host the dep optimizer keeps the network
 * busy well past the app being interactive.
 *
 * @param {import('puppeteer').Browser} b
 * @param {string[]} sink Where console/page errors are collected.
 * @returns {Promise<import('puppeteer').Page>}
 */
async function openApp(b, sink) {
  const page = await b.newPage();
  await page.setViewport({ width: 1500, height: 940 });
  page.on("pageerror", (e) => sink.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (isWebGpuAbsenceNoise(text)) return;
    if (/\/api\/projects|500 \(Internal Server Error\)/.test(text)) return; // no backend when run alone
    sink.push(`console.error: ${text}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, {
    timeout: 120000,
  });
  return page;
}

/**
 * Query (RUNS IN THE PAGE). The URL of the SAME Svelte the app is running.
 *
 * The probe has to mount a component itself, because nothing surfaces this modal
 * yet — the wiring is the caller's half. That needs `mount`, and a bare `svelte`
 * specifier is not resolvable from a browser. The dep chunk's URL carries a
 * cache-busting `?v=` hash that changes whenever Vite re-optimizes, so it is
 * DISCOVERED from resource timing (the app has already loaded it) rather than
 * guessed — a hardcoded path would rot at the next dependency bump and fail as
 * "cannot import", which reads nothing like the real cause.
 *
 * @returns {Promise<string>} A URL that exports `mount`.
 */
async function resolveSvelteInPage() {
  const hit = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => /\/deps\/svelte\.js(\?|$)/.test(n));
  for (const candidate of [hit, "/node_modules/.vite/deps/svelte.js", "/@id/svelte"]) {
    if (!candidate) continue;
    try {
      const m = await import(candidate);
      if (typeof m.mount === "function") return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("surge probe: could not reach Svelte's mount() from the page");
}

try {
  // ══ PART A — THE PURE HALF ══════════════════════════════════════════════
  const sinkA = [];
  const pageA = await openApp(browser, sinkA);

  const pure = await pageA.evaluate(async () => {
    const m = await import("/surgeGui.js");
    const layout = m.keyLayout();
    const whiteSpan = layout.white.reduce((n, k) => n + k.w, 0);
    const unit = 1 / 75;

    // THE REAL VENDORED INDEX, through the URL THE BUNDLER RESOLVED — not a
    // fixture and not a path this probe guessed. It doubles as the build check
    // that a file outside the Vite root is actually reachable from the app.
    const indexRes = await fetch(m.SURGE_DATA_INDEX_URL);
    if (!indexRes.ok) throw new Error(`vendored index -> HTTP ${indexRes.status}`);
    const index = await indexRes.json();

    const paths = index.files.map((f) => f.p);
    const patches = m.buildPatchIndex(paths, ["patches_3rdparty/A.Liv/Basses/Amen Polska.fxp"], m.SURGE_DATA_ROOT);

    return {
      exports: Object.keys(m).sort(),
      white: layout.white.length,
      black: layout.black.length,
      whiteSpan,
      firstWhite: layout.white[0],
      blackWidth: layout.black[0]?.w,
      unit,
      // C#0 (note 1) sits on the seam after white index 0.
      blackCentre: layout.black[0] ? layout.black[0].x + layout.black[0].w / 2 : null,
      allKeysCovered: layout.white.length + layout.black.length,

      noteNames: [m.noteName(60), m.noteName(0), m.noteName(61), m.noteName(127)],
      isWhite: [m.isWhite(60), m.isWhite(61), m.isWhite(59)],

      dirs: m.directoriesFor([{ p: "a/b/c.fxp" }, { p: "a/d.fxp" }, { p: "w/x/y/z.wt" }]),

      indexUrl: m.SURGE_DATA_INDEX_URL,
      indexFiles: index.files.length,
      factory: patches.filter((p) => p.bank === "Factory").length,
      thirdParty: patches.filter((p) => p.bank === "3rd Party").length,
      wavetablesDropped: patches.every((p) => p.path.endsWith(".fxp")),
      samplePatch: patches.find((p) => p.name === "Attacky") ?? null,
      remoteFlagged: patches.find((p) => p.bank === "3rd Party")?.remote,
      sortedByBank: patches[0]?.bank,

      filterAll: m.filterPatches(patches, "", "").length,
      filterBank: m.filterPatches(patches, "3rd Party", "").length,
      filterTerms: m.filterPatches(patches, "", "amen polska").length,
      filterMiss: m.filterPatches(patches, "", "zzzzz-no-such-patch").length,

      // THE GENERATED table, not gui-app.js's hand-written one — they disagree.
      keyArrowUp: m.juceKeyCode({ key: "ArrowUp" }),
      keyDelete: m.juceKeyCode({ key: "Delete" }),
      keyA: m.juceKeyCode({ key: "a" }),
      keyMeta: m.juceKeyCode({ key: "Meta" }),
      textA: m.juceTextChar({ key: "a" }),
      textEnter: m.juceTextChar({ key: "Enter" }),

      // The chunked base64 helper, against BOTH sizes that matter: a tiny value
      // whose encoding can be read by eye, and a buffer larger than the argument
      // limit the naive `String.fromCharCode(...bytes)` blows up on.
      b64Small: m.patchBytesToBase64(new Uint8Array([67, 99, 110, 75])),
      b64Empty: m.patchBytesToBase64(new Uint8Array(0)),
      b64BigOk: (() => {
        const big = new Uint8Array(300000);
        for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
        try {
          const out = m.patchBytesToBase64(big);
          return out.length === Math.ceil(300000 / 3) * 4;
        } catch (err) {
          return `THREW: ${err?.message}`;
        }
      })(),
      b64NaiveWouldThrow: (() => {
        // Proves the crash this helper exists to avoid is REAL on this engine,
        // not a remembered fact — if a future V8 raises the argument limit, this
        // flips and the docblock above should be revisited rather than trusted.
        try {
          const big = new Uint8Array(300000);
          btoa(String.fromCharCode(...big));
          return false;
        } catch {
          return true;
        }
      })(),
      cacheName: m.SURGE_CACHE_NAME,
      dataRoot: m.SURGE_DATA_ROOT,
      wasmUrl: m.SURGE_GUI_WASM_URL,
      binUrl: m.SURGE_DATA_BIN_URL,
      sentence: m.remoteFailureSentence("https://h/x.wasm", "HTTP 404"),
      booted: m.surgeModuleBooted(),
      attached: m.surgeSessionAttached(),
    };
  });

  ok(pure.white === 75, `keyLayout has 75 white keys (got ${pure.white})`);
  ok(pure.black === 53, `keyLayout has 53 black keys (got ${pure.black})`);
  ok(pure.allKeysCovered === 128, `every MIDI note 0..127 is a key (got ${pure.allKeysCovered})`);
  near(pure.whiteSpan, 1, 1e-9, "white keys tile exactly the full width");
  near(pure.blackWidth, pure.unit * 0.62, 1e-9, "a black key is 0.62 of a white key's width");
  near(pure.blackCentre, pure.unit, 1e-9, "C#0 is centred on the seam after C0");
  ok(
    JSON.stringify(pure.noteNames) === JSON.stringify(["C4", "C-1", "C#4", "G9"]),
    `noteName uses middle-C=C4 (got ${JSON.stringify(pure.noteNames)})`,
  );
  ok(
    JSON.stringify(pure.isWhite) === JSON.stringify([true, false, true]),
    `isWhite: C4 white, C#4 black, B3 white (got ${JSON.stringify(pure.isWhite)})`,
  );
  ok(
    JSON.stringify(pure.dirs) === JSON.stringify(["a", "w", "a/b", "w/x", "w/x/y"]),
    `directoriesFor emits parents before children (got ${JSON.stringify(pure.dirs)})`,
  );

  ok(pure.indexFiles === 842, `the vendored archive index lists 842 files (got ${pure.indexFiles})`);
  ok(pure.factory === 639, `639 factory patches come out of the real index (got ${pure.factory})`);
  ok(pure.thirdParty === 1, `an on-demand path becomes a 3rd Party entry (got ${pure.thirdParty})`);
  ok(pure.wavetablesDropped, "the 203 wavetables are NOT offered as patches");
  ok(
    pure.samplePatch?.category === "Basses" &&
      pure.samplePatch?.bank === "Factory" &&
      pure.samplePatch?.remote === false &&
      pure.samplePatch?.path === "/SurgeXTData/patches_factory/Basses/Attacky.fxp",
    `a real archive entry becomes a full patch record (got ${JSON.stringify(pure.samplePatch)})`,
  );
  ok(pure.remoteFlagged === true, "an on-demand patch is flagged remote");
  ok(pure.sortedByBank === "3rd Party", `sorted by bank first (got ${pure.sortedByBank})`);
  ok(pure.filterAll === 640, `a blank filter matches everything (got ${pure.filterAll})`);
  ok(pure.filterBank === 1, `the bank picker narrows to one bank (got ${pure.filterBank})`);
  ok(pure.filterTerms === 1, `every search TERM must match (got ${pure.filterTerms})`);
  ok(pure.filterMiss === 0, "a filter that matches nothing returns nothing");

  ok(pure.keyArrowUp === 0x10002, `ArrowUp uses the GENERATED juce table (got 0x${pure.keyArrowUp?.toString(16)})`);
  ok(pure.keyDelete === 0x10000, `Delete uses the GENERATED juce table (got 0x${pure.keyDelete?.toString(16)})`);
  ok(pure.keyA === 97, `a printable key is its own code point (got ${pure.keyA})`);
  ok(pure.keyMeta === 0, "a modifier alone maps to 0, which JUCE ignores");
  ok(pure.textA === 97 && pure.textEnter === 0, "textChar is the typed character, 0 for non-printables");

  ok(pure.b64Small === "Q2NuSw==", `patchBytesToBase64 encodes the .fxp magic (got "${pure.b64Small}")`);
  ok(pure.b64Empty === "", "patchBytesToBase64 of nothing is the empty string");
  ok(pure.b64BigOk === true, `patchBytesToBase64 survives 300 KB — the size a 3rd-party patch really is (got ${pure.b64BigOk})`);
  ok(
    pure.b64NaiveWouldThrow === true,
    "the naive String.fromCharCode(...bytes) DOES blow the stack at that size — the helper is not superstition",
  );
  ok(pure.dataRoot === "/SurgeXTData", `the mount point matches the audio half (got ${pure.dataRoot})`);
  ok(pure.wasmUrl.startsWith(SURGE_REMOTE_ORIGIN), "the wasm comes from the declared remote host");
  ok(pure.binUrl.startsWith(SURGE_REMOTE_ORIGIN), "the archive comes from the declared remote host");
  ok(
    pure.sentence.includes(SURGE_REMOTE_ORIGIN) && pure.sentence.includes("HTTP 404"),
    "a fetch failure names BOTH the remote host and what went wrong",
  );
  ok(!pure.booted && !pure.attached, "no Surge module boots merely by importing the adapter");

  // THE CACHE MUST NOT BE THE SERVICE WORKER'S. Read sw.js from disk rather than
  // trusting a remembered name: the rule is "not the shell cache", and the only
  // authority on what the shell cache is called is the worker itself.
  const swSource = readFileSync(resolve(webRoot, "sw.js"), "utf8");
  const swCacheNames = [...swSource.matchAll(/^const (\w*CACHE\w*) = (.+);$/gm)].map((m) => m[2]);
  ok(swCacheNames.length >= 3, `sw.js declares its caches as consts (found ${swCacheNames.length})`);
  ok(
    !swSource.includes(pure.cacheName),
    `the Surge cache "${pure.cacheName}" is NOT any cache web/sw.js writes`,
  );
  ok(
    pure.cacheName.startsWith("powerrp-surge-"),
    `the Surge cache is explicitly named and versioned (got "${pure.cacheName}")`,
  );
  const swPlugin = readFileSync(resolve(webRoot, "swBuildPlugin.js"), "utf8");
  ok(
    !swPlugin.includes("surge") && !swSource.includes("surge"),
    "neither web/sw.js nor web/swBuildPlugin.js mentions surge — the 49 MB is not precached",
  );
  ok(sinkA.length === 0, `part A raised no page errors (${sinkA.join(" | ")})`);
  await pageA.close();

  // ══ PART B — THE CHROME, AND THE LOUD FAILURE WHEN THE HOST IS GONE ═════
  const sinkB = [];
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 1500, height: 940 });
  await pageB.setRequestInterception(true);
  let aborted = 0;
  pageB.on("request", (req) => {
    if (req.url().startsWith(SURGE_REMOTE_ORIGIN)) {
      aborted += 1;
      req.abort("failed").catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });
  pageB.on("pageerror", (e) => sinkB.push(`pageerror: ${e.message}`));
  pageB.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (isWebGpuAbsenceNoise(text)) return;
    if (/\/api\/projects|500 \(Internal Server Error\)/.test(text)) return;
    // The aborted remote fetches are the POINT of this half; the module's own
    // console.error carrying the sentence is asserted below, not treated as noise.
    if (text.includes("ryanndagreat.github.io") || text.includes("SurgeGuiModal")) return;
    if (/net::ERR_FAILED|Failed to load resource/.test(text)) return;
    sinkB.push(`console.error: ${text}`);
  });
  await pageB.goto(url, { waitUntil: "networkidle0" });
  await pageB.waitForFunction(() => document.getElementById("boot-splash") === null, {
    timeout: 120000,
  });

  const svelteUrl = await pageB.evaluate(resolveSvelteInPage);
  notes.push(`Svelte mount() resolved from ${svelteUrl}`);

  const mountResult = await pageB.evaluate(async (svelteSpecifier) => {
    const { mount } = await import(svelteSpecifier);
    const { default: SurgeGuiModal } = await import("/SurgeGuiModal.svelte");
    window.__surgeProbe = { params: [], patches: [], notes: [], closed: 0 };
    window.__surgeProbeApp = mount(SurgeGuiModal, {
      target: document.body,
      props: {
        title: "Surge XT",
        onclose: () => (window.__surgeProbe.closed += 1),
        onparam: (index, value) => window.__surgeProbe.params.push([index, value]),
        onpatch: (p) => window.__surgeProbe.patches.push(p),
        onnote: (n) => window.__surgeProbe.notes.push(n),
      },
    });
    return true;
  }, svelteUrl);
  ok(mountResult === true, "the modal component mounts");

  // The failure has to arrive; without a bound this would hang on a green run.
  await pageB.waitForFunction(() => document.querySelector(".surge-boot .surge-failure") !== null, {
    timeout: 60000,
  });

  const chrome = await pageB.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const body = q(".modal-panel:has(.surge-root) > .modal-body");
    const piano = q(".surge-piano");
    const whiteKeys = [...document.querySelectorAll(".surge-key-white")];
    const blackKeys = [...document.querySelectorAll(".surge-key-black")];
    const labelled = whiteKeys.filter((k) => k.dataset.label);
    const root = getComputedStyle(document.documentElement);
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      hasRoot: !!q(".surge-root"),
      insideDialog: !!q('.modal-panel[role="dialog"] .surge-root'),
      bodyPadding: bodyStyle?.paddingTop,
      bodyDisplay: bodyStyle?.display,
      white: whiteKeys.length,
      black: blackKeys.length,
      labels: labelled.map((k) => k.dataset.label),
      firstWhiteLeft: whiteKeys[0]?.style.left,
      pianoIdle: piano?.classList.contains("surge-piano-idle"),
      pianoHeight: piano ? Math.round(piano.getBoundingClientRect().height) : 0,
      pianoWidth: piano ? Math.round(piano.getBoundingClientRect().width) : 0,
      whiteKeyPainted: whiteKeys[0] ? getComputedStyle(whiteKeys[0]).backgroundColor : null,
      blackKeyPainted: blackKeys[0] ? getComputedStyle(blackKeys[0]).backgroundColor : null,
      tokenPianoH: root.getPropertyValue("--a-surge-piano-h").trim(),
      tokenStageBg: root.getPropertyValue("--a-surge-stage-bg").trim(),
      failure: q(".surge-boot .surge-failure")?.textContent ?? "",
      failureRole: q(".surge-boot .surge-failure")?.getAttribute("role"),
      bootTitle: q(".surge-boot-title")?.textContent ?? "",
      bootTitleFailed: q(".surge-boot-title")?.classList.contains("surge-boot-failed"),
      canvasHidden: getComputedStyle(q(".surge-canvas")).display,
      seam: !!window.__powerrp_surgeModal,
      seamPhase: window.__powerrp_surgeModal?.phase(),
      seamReady: window.__powerrp_surgeModal?.ready(),
      // A dead session must not let the piano fire notes into a caller's engine.
      notesAfterPress: (() => {
        window.__powerrp_surgeModal?.pressNote(60);
        return window.__surgeProbe.notes.length;
      })(),
    };
  });

  ok(chrome.hasRoot && chrome.insideDialog, "the modal renders inside a role=dialog panel");
  ok(
    chrome.bodyPadding === "0px" && chrome.bodyDisplay === "flex",
    `the :has(.surge-root) rule flushes the shared modal's body (padding ${chrome.bodyPadding}, display ${chrome.bodyDisplay})`,
  );
  ok(chrome.white === 75, `75 white key elements in the DOM (got ${chrome.white})`);
  ok(chrome.black === 53, `53 black key elements in the DOM (got ${chrome.black})`);
  ok(
    chrome.labels.length === 11 && chrome.labels[0] === "C-1" && chrome.labels.at(-1) === "C9",
    `only the C's are labelled, C-1..C9 (got ${chrome.labels.length}: ${chrome.labels.join(",")})`,
  );
  ok(chrome.firstWhiteLeft === "0%", `the first white key starts at 0% (got ${chrome.firstWhiteLeft})`);
  ok(chrome.pianoIdle === true, "the piano is visibly idle while there is no session");
  ok(chrome.pianoHeight === 96, `the piano is --a-surge-piano-h tall (got ${chrome.pianoHeight}px)`);
  ok(chrome.pianoWidth > 1000, `the piano spans the 90vw dialog (got ${chrome.pianoWidth}px)`);
  ok(
    chrome.whiteKeyPainted !== chrome.blackKeyPainted,
    `white and black keys are painted differently (${chrome.whiteKeyPainted} vs ${chrome.blackKeyPainted})`,
  );
  ok(chrome.tokenPianoH === "96px", `--a-surge-piano-h resolves (got "${chrome.tokenPianoH}")`);
  ok(chrome.tokenStageBg !== "", "--a-surge-stage-bg resolves (the token group is really in app.css)");
  ok(chrome.canvasHidden === "none", "the canvas is hidden until the session is live, not a black seam");

  ok(aborted > 0, `the remote host was actually blocked (${aborted} requests aborted)`);
  ok(
    chrome.failure.includes("ryanndagreat.github.io"),
    `the dialog's failure sentence NAMES THE HOST (got: ${chrome.failure.slice(0, 160)})`,
  );
  ok(
    /network|offline|connection/i.test(chrome.failure),
    "the failure sentence says this needs a network on first use",
  );
  ok(chrome.failureRole === "alert", "the failure is announced, not just drawn");
  ok(chrome.bootTitleFailed === true, `the boot heading switches to the failed style ("${chrome.bootTitle}")`);
  ok(chrome.seam === true, "the headless seam window.__powerrp_surgeModal is installed");
  ok(chrome.seamReady === false, "the seam reports NOT ready when the session failed");
  ok(chrome.notesAfterPress === 0, "a dead session fires no notes into the caller");

  // Escape must still close the dialog — the one key the canvas deliberately
  // does not swallow (see the KEYBOARD note in web/surgeGui.js).
  await pageB.evaluate(() => document.querySelector(".modal-panel")?.focus());
  await pageB.keyboard.press("Escape");
  const closed = await pageB.evaluate(() => window.__surgeProbe.closed);
  ok(closed === 1, `Escape reaches the Modal and calls onclose (got ${closed})`);

  await pageB.evaluate(async (svelteSpecifier) => {
    const { unmount } = await import(svelteSpecifier);
    unmount(window.__surgeProbeApp);
  }, svelteUrl);
  const seamGone = await pageB.evaluate(() => !window.__powerrp_surgeModal);
  ok(seamGone, "unmounting removes the test seam (the session is destroyed with it)");

  ok(sinkB.length === 0, `part B raised no unexpected page errors (${sinkB.join(" | ")})`);
  await pageB.close();

  // ══ PART C — THE LIVE 49 MB LOAD ════════════════════════════════════════
  let liveSkip = null;
  if (process.env.POWERRP_SURGE_SKIP_LIVE === "1") {
    liveSkip = "POWERRP_SURGE_SKIP_LIVE=1 was set";
  } else {
    try {
      const res = await fetch(REACHABILITY_URL, {
        method: "HEAD",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) liveSkip = `${REACHABILITY_URL} answered HTTP ${res.status}`;
    } catch (err) {
      liveSkip = `${SURGE_REMOTE_ORIGIN} is unreachable from this host (${err?.message ?? err})`;
    }
  }

  if (liveSkip) {
    notes.push(
      `LIVE LOAD SKIPPED — ${liveSkip}. Parts A and B still ran; nothing below was measured.`,
    );
  } else {
    const sinkC = [];
    const pageC = await openApp(browser, sinkC);
    const started = Date.now();
    const live = await pageC.evaluate(
      async (svelteSpecifier, timeoutMs) => {
        const { mount } = await import(svelteSpecifier);
        const { default: SurgeGuiModal } = await import("/SurgeGuiModal.svelte");
        window.__surgeProbe = { params: [], patches: [], notes: [], phases: [] };
        window.__surgeProbeApp = mount(SurgeGuiModal, {
          target: document.body,
          props: {
            title: "Surge XT",
            onclose: () => {},
            onparam: (index, value) => window.__surgeProbe.params.push([index, value]),
            onpatch: (p) => window.__surgeProbe.patches.push(p),
            onnote: (n) => window.__surgeProbe.notes.push(n),
          },
        });
        const seam = () => window.__powerrp_surgeModal;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (seam()?.ready()) break;
          if (seam()?.failure()) return { failed: seam().failure() };
          if (Date.now() > deadline) {
            return { failed: `timed out at phase "${seam()?.phase()}" after ${timeoutMs} ms` };
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        const s = seam().session();
        const counts = seam().counts();
        const canvas = document.querySelector(".surge-canvas");
        // Let a few frames run so the first parameter block and the first paint
        // have both happened.
        await new Promise((r) => setTimeout(r, 600));

        // THE PIANO, for real: press, glissando to another key, release.
        seam().pressNote(60);
        const heldAfterPress = seam().held();
        seam().pressNote(67);
        const heldAfterSecond = seam().held();
        seam().releaseNote(60);
        seam().releaseNote(67);
        const heldAfterRelease = seam().held();

        // A PATCH, for real — a factory one (already mounted, no second download).
        seam().setBank("Factory");
        seam().setQuery("attacky");
        await new Promise((r) => setTimeout(r, 60));
        const matched = seam().matches();
        await seam().loadPatchAt(0);
        await new Promise((r) => setTimeout(r, 400));

        // A REMOTE patch, for real: this is the ONLY path that exercises the
        // on-demand fetch, the mkdir-p walk into MEMFS, and the bytes leaving for
        // the audio half — none of which an archive patch touches.
        seam().setBank("3rd Party");
        seam().setQuery("amen polska");
        await new Promise((r) => setTimeout(r, 60));
        const remoteMatched = seam().matches();
        let remoteError = null;
        try {
          await seam().loadPatchAt(0);
        } catch (err) {
          remoteError = String(err?.message ?? err);
        }
        await new Promise((r) => setTimeout(r, 400));

        const size = s.size();
        return {
          remoteMatched,
          remoteError,
          counts,
          size,
          progressLog: seam().progressLog(),
          zoomApplied: seam().zoom(),
          canvasW: canvas.width,
          canvasH: canvas.height,
          cssW: canvas.style.width,
          cssH: canvas.style.height,
          dpr: window.devicePixelRatio,
          paramsSeen: window.__surgeProbe.params.length,
          distinctParams: new Set(window.__surgeProbe.params.map((p) => p[0])).size,
          heldAfterPress,
          heldAfterSecond,
          heldAfterRelease,
          notes: window.__surgeProbe.notes,
          matched,
          patchesLoaded: window.__surgeProbe.patches.map((p) => ({
            path: p.path,
            name: p.name,
            hasBytes: "bytes" in p,
            // THE .fxp MAGIC. A VST2 preset file starts with the four bytes
            // "CcnK", so this proves readBytes() returned the real patch file and
            // not an empty array the caller would have stored without noticing.
            magic: typeof p.readBytes === "function"
              ? String.fromCharCode(...p.readBytes().subarray(0, 4))
              : null,
            readLength: typeof p.readBytes === "function" ? p.readBytes().length : 0,
          })),
          allParams: s.readAllParams().length,
          failureAfter: seam().failure(),
          // The canvas must actually contain Surge's pixels, not a blank field.
          nonBlank: (() => {
            const c = document.createElement("canvas");
            c.width = 64;
            c.height = 64;
            const g = c.getContext("2d");
            g.drawImage(canvas, 0, 0, 64, 64);
            const d = g.getImageData(0, 0, 64, 64).data;
            const seen = new Set();
            for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
            return seen.size;
          })(),
        };
      },
      svelteUrl,
      LIVE_LOAD_TIMEOUT_MS,
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (live.failed) {
      ok(false, `the live 49 MB load succeeded — instead: ${live.failed}`);
    } else {
      notes.push(`cold load: ${elapsed}s for 49 MB (puppeteer starts in a throwaway profile, so Cache Storage is empty every run)`);
      ok(live.counts.patchCount > 0, `SURGE ITSELF found patches by scanning (got ${live.counts.patchCount})`);
      ok(
        live.counts.patchCount === 639,
        `Surge's own scan agrees with the archive index: 639 (got ${live.counts.patchCount})`,
      );
      ok(live.counts.wavetableCount > 0, `Surge found wavetables (got ${live.counts.wavetableCount})`);
      ok(live.counts.paramCount === 766, `Surge exposes 766 parameters (got ${live.counts.paramCount})`);
      ok(
        live.counts.indexSize === 3559,
        `the selector offers both banks: 639 + 2920 = 3559 (got ${live.counts.indexSize})`,
      );
      ok(live.size.width === 913 && live.size.height === 569, `Surge's native logical size is 913×569 (got ${live.size.width}×${live.size.height})`);
      ok(
        live.canvasW === Math.round(913 * live.dpr) && live.canvasH === Math.round(569 * live.dpr),
        `the backing store is PHYSICAL pixels at dpr ${live.dpr} (got ${live.canvasW}×${live.canvasH})`,
      );
      ok(
        live.cssW === "913px" && live.cssH === "569px",
        `the CSS size is LOGICAL × zoom and NOT × dpr (got ${live.cssW} × ${live.cssH})`,
      );
      ok(live.allParams === 766, `readAllParams returns the whole block (got ${live.allParams})`);
      ok(
        live.distinctParams === 766,
        `the first frame reports every parameter as a baseline (got ${live.distinctParams} distinct)`,
      );
      ok(live.nonBlank > 20, `Surge actually painted its interface (${live.nonBlank} distinct colours in a 64×64 sample)`);
      ok(
        JSON.stringify(live.heldAfterPress) === "[60]" &&
          JSON.stringify(live.heldAfterSecond) === "[60,67]" &&
          JSON.stringify(live.heldAfterRelease) === "[]",
        `the held-note set tracks presses and releases (${JSON.stringify(live.heldAfterPress)} → ${JSON.stringify(live.heldAfterSecond)} → ${JSON.stringify(live.heldAfterRelease)})`,
      );
      ok(
        live.notes.length === 4 &&
          live.notes[0].type === "on" &&
          live.notes[0].note === 60 &&
          live.notes[0].velocity === 100 &&
          live.notes.at(-1).type === "off",
        `four note events reached the caller with velocity 100 (${JSON.stringify(live.notes)})`,
      );
      ok(live.matched === 1, `the filter found exactly the "Attacky" patch (got ${live.matched})`);
      ok(
        live.patchesLoaded.length === 2 && live.patchesLoaded[0].name === "Attacky",
        `onpatch fired once per load, archive then remote (${live.patchesLoaded.map((p) => p.name).join(", ")})`,
      );
      ok(
        live.patchesLoaded[0] && live.patchesLoaded[0].hasBytes === false,
        "an ARCHIVE patch carries no eager bytes — the audio half already has the file",
      );
      ok(
        live.patchesLoaded[0]?.magic === "CcnK",
        `readBytes() returns the REAL .fxp for an archive patch (magic "${live.patchesLoaded[0]?.magic}")`,
      );
      ok(
        live.patchesLoaded[0]?.readLength === 23212,
        `readBytes() returns the whole file — Attacky.fxp is 23,212 bytes per the archive index (got ${live.patchesLoaded[0]?.readLength})`,
      );
      ok(live.remoteMatched === 1, `the filter reached a 3rd-party patch (got ${live.remoteMatched})`);
      ok(!live.remoteError, `the on-demand patch loaded (${live.remoteError ?? "clean"})`);
      const remote = live.patchesLoaded[1];
      ok(
        remote?.name === "Amen Polska" && remote.path.startsWith("/SurgeXTData/patches_3rdparty/"),
        `the remote patch was written into the wasm filesystem at its archive path (${remote?.path})`,
      );
      ok(
        remote?.hasBytes === true,
        "a REMOTE patch DOES carry its bytes — the audio half's filesystem does not have the file yet",
      );
      ok(
        remote?.magic === "CcnK" && remote?.readLength > 0,
        `the fetched .fxp is a real preset file (magic "${remote?.magic}", ${remote?.readLength} bytes)`,
      );
      ok(!live.failureAfter, `nothing failed during the live run (${live.failureAfter ?? "clean"})`);
      ok(
        live.zoomApplied > 0 && live.zoomApplied <= 2,
        `the dialog fits Surge to the panel on open rather than leaving it in a corner (zoom ${live.zoomApplied})`,
      );
      const coldPhases = live.progressLog ?? [];
      ok(
        coldPhases.some((p) => p.phase === "wasm" && !p.cached) &&
          coldPhases.some((p) => p.phase === "archive" && !p.cached),
        `the first load really came off the network (${JSON.stringify(coldPhases)})`,
      );
      ok(
        ["glue", "wasm", "archive", "mount", "init", "attach", "ready"].every((ph) =>
          coldPhases.some((p) => p.phase === ph),
        ),
        `every documented boot phase was reported (${coldPhases.map((p) => p.phase).join(" → ")})`,
      );

      await pageC.screenshot({ path: resolve(app, "tests", "surge_gui_probe.png") });
      notes.push(`screenshot: ${resolve(app, "tests", "surge_gui_probe.png")}`);

      // ── THE WARM CACHE. The same origin in the same browser, so Cache Storage
      // is the one this module wrote a moment ago. This is the ONLY way to see
      // the thing the cache exists for; a finished frame looks identical either
      // way, which is exactly why it needs measuring rather than asserting.
      await pageC.reload({ waitUntil: "networkidle0" });
      await pageC.waitForFunction(() => document.getElementById("boot-splash") === null, {
        timeout: 120000,
      });
      const warmStarted = Date.now();
      const warm = await pageC.evaluate(
        async (svelteSpecifier, timeoutMs) => {
          const { mount } = await import(svelteSpecifier);
          const { default: SurgeGuiModal } = await import("/SurgeGuiModal.svelte");
          mount(SurgeGuiModal, { target: document.body, props: { onclose: () => {} } });
          const seam = () => window.__powerrp_surgeModal;
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            if (seam()?.ready()) break;
            if (seam()?.failure()) return { failed: seam().failure() };
            if (Date.now() > deadline) return { failed: `timed out at "${seam()?.phase()}"` };
            await new Promise((r) => setTimeout(r, 100));
          }
          return { progressLog: seam().progressLog(), counts: seam().counts() };
        },
        svelteUrl,
        LIVE_LOAD_TIMEOUT_MS,
      );
      const warmElapsed = ((Date.now() - warmStarted) / 1000).toFixed(1);
      if (warm.failed) {
        ok(false, `the second (warm) boot succeeded — instead: ${warm.failed}`);
      } else {
        const warmPhases = warm.progressLog ?? [];
        ok(
          warmPhases.find((p) => p.phase === "wasm")?.cached === true,
          `the 19 MB wasm came from the "powerrp-surge-remote-v1" cache on the second open (${JSON.stringify(warmPhases)})`,
        );
        ok(
          warmPhases.find((p) => p.phase === "archive")?.cached === true,
          `the 30 MB archive came from that cache too (${JSON.stringify(warmPhases)})`,
        );
        ok(
          warm.counts.patchCount === 639,
          `the cached bytes really are Surge: 639 patches again (got ${warm.counts.patchCount})`,
        );
        notes.push(`warm (cached) boot: ${warmElapsed}s vs ${elapsed}s cold`);
      }
    }

    ok(sinkC.length === 0, `part C raised no page errors (${sinkC.join(" | ")})`);
    await pageC.close();
  }
} catch (err) {
  errors.push(`THREW: ${err?.stack ?? err}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
for (const n of notes) console.log(`note  ${n}`);
if (errors.length) {
  console.error(`\nsurge_gui_probe: ${errors.length} failure(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`\nsurge_gui_probe: ${checks.length} checks passed`);
