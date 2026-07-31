import "../../../styles/theme.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { loadFonts } from "./fontLoader.js";
import { bootDone, bootFailed, bootStage } from "./bootProgress.js";

// Load the committed font FILES (../fonts/) into the browser BEFORE any text
// rasterizes — the WebGPU glyph atlas draws through canvas2D, which silently
// substitutes any font that isn't loaded yet (manifest "Text fonts", offline
// rule). Kicked at module load so BOTH the editor mount and the CLI render hook
// share one memoized promise; each awaits it before its first frame.
const fontsLoaded = loadFonts();
import { assetStore, detectStorageMode, isStatic, projectStore, storageMode } from "./storageMode.js";
import { REPO_PARAM } from "./githubProject.js";
import { isOnline, offlineMessage, startConnectivityWatch } from "./connectivity.js";

// THE CONNECTIVITY SEAM STARTS FIRST, and unconditionally — before the storage
// probe, before fonts, before the mount, and in EVERY mode. Two reasons it sits
// this early rather than inside the editor's mount:
//   · `?repo=`/`?zip=` boot loads run before the user can touch anything, and
//     they need a truthful answer to "is the internet there" to explain a
//     failure rather than reporting an opaque fetch error.
//   · The user's ruling covers Electron and the static site equally ("it's the
//     same mechanism"), and neither of those goes through anything the editor
//     mount alone would run. It is only two event listeners.
startConnectivityWatch();

/**
 * Command (network + app mutation). `?repo=owner/name[@ref]` BOOT WIRING — reads
 * the query parameter and hands it to app.openProjectFromRepo, which is the ONE
 * repo-open path (the modal's "open from…" field lands there too).
 *
 * `@ref` IS A BRANCH, tag or commit and it is carried the whole way: the slug
 * reaches parseRepoSlug intact, the contents API is asked with `?ref=`, and the
 * opened draft remembers the slug so Copy Share Link reproduces the branch rather
 * than silently handing a recipient the default one.
 *
 * Behind that call: the fetched repo files are synthesized into an in-memory
 * archive and opened as an UNSAVED DRAFT through the ONE zip pipeline — a repo is
 * literally a differently-fetched zip, so archive-ref healing, draft staging and
 * the save flow all apply unchanged. A revisit rebuilds the draft fresh (a
 * half-downloaded earlier visit can never be sticky — the flaw the original
 * direct-import shape had). Every failure is LOUD: a share link that silently
 * does nothing is how this shipped broken once.
 */
async function openRepoParamProject() {
  const slug = new URLSearchParams(location.search).get(REPO_PARAM);
  if (!slug || new URLSearchParams(location.search).has("cli")) return;
  const app = await (async () => {
    const APP_WAIT_MS = 10000, POLL_MS = 50; // the app mounts in well under a second; 10s means something broke
    for (let waited = 0; waited < APP_WAIT_MS; waited += POLL_MS) {
      if (window.__powerrp_app) return window.__powerrp_app;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error("?repo=: the app never mounted");
  })();
  try {
    // ONE CODE PATH WITH THE MODAL. The fetch, the archive synthesis, the guard
    // (user ruling: "Can opening a link break my project?" — a boot param is the
    // case that ruling literally names) and the repoSlug that gates the share
    // link all live on app.openProjectFromRepo now. This boot path's whole job is
    // to read the query parameter and report; it used to duplicate the body, and
    // the duplicate is how `?repo=` came to lack the branch-aware share link the
    // modal path has. `@ref` rides along untouched — parseRepoSlug reads it there.
    const result = await app.openProjectFromRepo(slug, ({ message }) => console.info(`PowerRP ?repo=: ${message}`));
    if (result?.cancelled) console.info(`PowerRP ?repo=${slug}: cancelled — kept the project that was already open.`);
  } catch (e) {
    // NAME OFFLINE WHEN OFFLINE IS THE CAUSE. A boot param that fails is the
    // least explicable failure in the app — the user clicked a link and got an
    // editor that is not the deck they were sent — so the console line must not
    // leave them guessing between "the link is wrong", "the repo is private"
    // and "my wifi is off". The seam already knows which; say it.
    const cause = isOnline() ? (e?.message ?? e) : offlineMessage("Opening a shared project");
    console.error(`PowerRP: could not open ?repo=${slug} — ${cause}`);
    throw e;
  }
}
import { buildProjectZip, parseProjectZip } from "./projectZip.js";

// DECIDE WHERE STORAGE LIVES BEFORE THE APP MOUNTS. One cheap GET at
// /api/projects/ answers "is there a backend?"; the answer picks the HTTP
// adapter (today's server behavior) or the IndexedDB adapter (static mode, e.g.
// GitHub Pages). It MUST resolve before the mount, because App.svelte reads
// app.isStatic() during its first render and every storage call goes through the
// chosen adapter — a mount that raced this would read storage before the mode
// existed and throw by design (see storageMode()). ?static=1 forces local;
// ?backend=… forces HTTP and never falls back.
const storageReady = detectStorageMode();
import { deserialize, repairedDocument, printRepairReports } from "../core/document.js";
import { cameraRect } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../core/view.js";
import { parseColor } from "../render_gpu/ir.js";
import { rasterizeIrPng } from "./gpuService.js";
import { cameraFrameIR, evaluatedStateAt } from "./cameraFrame.js";
import { videoUploadCount, videoPlaybackState, videoStatus } from "../render_gpu/gpu/video_registry.js";
import { videoV5UploadCount, videoV5State, videoV5ScrubState } from "../render_gpu/skia/video_v5.js";

// Dev/test seams (like __powerrp_render / __powerrp_app): the running total of
// <video>→GPU-texture uploads (probe confirms the frame-advance gate keeps uploads
// at ~video-rate, not paint-rate), and a per-src playback snapshot (probe confirms
// off-view players PAUSE and RESUME from their prior currentTime). Zero prod effect.
window.__powerrp_videoUploadCount = videoUploadCount;
window.__powerrp_videoState = videoPlaybackState;
// And the LOAD verdict for one src: "unloaded" | "loading" | "ready" | "error".
// Exposed because a probe cannot ask the DOM this question — the registry's
// <video> elements are deliberately NEVER appended (they exist only to be uploaded
// as GPU textures), so `document.querySelectorAll("video")` finds ZERO of them no
// matter how healthy playback is. A release-acceptance script that asserted on
// that selector therefore measured nothing, and would have reported the canvas
// broken while it drew perfectly. This is the honest question: did THIS src decode?
window.__powerrp_videoStatus = videoStatus;
// V5 off-main-thread video diagnostics (its own registry): ImageBitmap→texture
// upload count (the seq gate keeps it at ~video-rate) and a per-src snapshot
// ({status, mode, paused, currentTime, seq, hasBitmap}) — a probe asserts motion
// (seq advances), off-view PAUSE/RESUME, and the active pipeline mode. Zero prod effect.
window.__powerrp_videoV5UploadCount = videoV5UploadCount;
window.__powerrp_videoV5State = videoV5State;
// V5 SCRUBBER diagnostic (its own off-main-thread scrub decoder): a per-src
// snapshot ({status, paused, currentTime, duration}) — a probe asserts a paused
// decoder parks at the requested scrubTime deterministically. Zero prod effect.
window.__powerrp_videoV5ScrubState = videoV5ScrubState;
// STORAGE diagnostics (this feature): the resolved mode plus the live stores and
// the zip round-trip, so a probe can assert the static-mode contract — that an
// asset ref resolves to a blob: URL, that a client-built archive has the SERVER's
// layout, and that a re-import lands as a new project — WITHOUT test-only methods
// being added to the app class. Same zero-prod-effect convention as the video
// diagnostics above.
window.__powerrp_storage = { storageMode, isStatic, assetStore, projectStore, buildProjectZip, parseProjectZip };

/**
 * Browser render hook (a few in-browser pixel-parity probes await it via
 * puppeteer): renders one frame of a document at (slide, alpha) to width×height
 * and returns a PNG data URL — now through the Skia OFFSCREEN rasterizer
 * (gpuService.rasterizeIrPng), so it is WebGPU-free like the rest of the app.
 * The headless CLI no longer uses this hook (cli/render.js renders in Node via
 * canvaskit); it remains only for in-browser probe parity.
 */
window.__powerrp_render = async function (docJson, { slide = 0, alpha = 1, width = 1280, height = 720 } = {}) {
  await fontsLoaded;
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // EXACTLY the editor's load-boundary repair — the SAME repairedDocument the
  // app runs — so probe and editor can never drift (silent repairs forbidden).
  const raw = typeof docJson === "string" ? deserialize(docJson) : docJson;
  const { doc, reports } = repairedDocument(raw, registry);
  printRepairReports(reports);
  // fold → EVALUATE → derive → emit the SAME camera-frame IR the pixel service
  // and editor thumbnails build, then rasterize it through Skia offscreen.
  const state = evaluatedStateAt(doc, slide, alpha, registry);
  const rect = cameraRect(state, doc.meta);
  const view = fitRectView(rect, width, height, 1);
  const png = await rasterizeIrPng(cameraFrameIR(state, doc.meta, registry), view, width, height, parseColor(rect.background));
  return pngBytesToDataUrl(png);
};

/** Pure function. PNG bytes → a data: URL (chunked base64 so large frames don't blow the call stack). */
function pngBytesToDataUrl(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return "data:image/png;base64," + btoa(bin);
}

// `?cli=1` skips mounting the editor UI — the page then exists only to host
// __powerrp_render for the CLI (faster, and headless-safe).
if (!new URLSearchParams(location.search).has("cli")) {
  // AWAIT fonts before the first mount so the editor's opening GPU frame never
  // rasterizes text in a not-yet-loaded face (canvas2D would substitute with no
  // repaint to fix it — there is no font-load repaint nudge on the canvas path,
  // unlike images). Local files load in ~tens of ms; the GPU's ~1s Metal warmup
  // dwarfs it, so this adds no perceptible boot delay while making correctness
  // deterministic rather than timing-dependent. (A font that FAILS to load is
  // reported loudly inside loadFonts and still lets the mount proceed.)
  //
  // ALSO awaits the storage-mode probe (see storageReady above) — the two run
  // CONCURRENTLY (both promises were started at module load) so the probe adds
  // no boot latency beyond the font load it hides behind.
  bootStage("storage", "Checking storage", {});
  Promise.all([fontsLoaded, storageReady])
    .then(() => {
      bootStage("mount", "Building the editor", {});
      mount(App, { target: document.getElementById("app") });
      openRepoParamProject(); // after mount: needs the live app (fire-and-forget, loud on failure)
    })
    // BOOT FAILURE IS THE OTHER GRAY BOX. Anything that throws before the first
    // frame — a font load that rejects, the storage probe, a mount error — used
    // to leave the shell blank forever with only a console line. Now it lands on
    // the splash's loud error surface AND is re-raised, because a reported error
    // that is also swallowed is still a silent failure.
    .catch((e) => {
      bootFailed(e?.stack || e?.message || String(e));
      throw e;
    });
} else {
  // ?cli=1 NEVER MOUNTS CanvasView, so the first-paint seam that normally lifts
  // the splash does not exist on this page. Lift it here instead — leaving it up
  // would put a full-screen overlay over the render host, which is the one place
  // a lingering splash could actually break something rather than just look bad.
  bootDone();
}
