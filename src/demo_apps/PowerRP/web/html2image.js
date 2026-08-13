/**
 * web/html2image.js — THE AUTHORING-TIME CAPTURE SERVICE for plugins/html2image.js.
 *
 * Read plugins/html2image.js's header first; it owns the WHY. This file owns the
 * HOW, and the one sentence that governs every line of it:
 *
 *   THE FRAME EXISTS ONLY DURING A CAPTURE THE USER ASKED FOR, AND IS DESTROYED
 *   BEFORE THIS MODULE RETURNS. IT IS NEVER PART OF A RENDER TREE.
 *
 * ── WHY AN IFRAME IS LEGAL HERE AT ALL ──────────────────────────────────────
 * CLAUDE.md's determinism law forbids iframes in a render tree — the user's own
 * words, quoted there: "perfectly deterministic — no embedding iframes or crap
 * like that (it's not perfectly reproducible, so I don't want it)". The precedent
 * that makes an AUTHORING frame legal is the signal MIDI editor
 * (web/signalEdit.js + web/SignalModal.svelte): one same-origin iframe, open only
 * while the author is editing, contributing nothing to any frame the renderer
 * produces. This is the same category and a stricter version of it — signal's
 * frame lives as long as its modal, whereas this one lives for the duration of one
 * async function and is removed in a `finally`.
 *
 * ── SANDBOXED, AND WHAT EACH TOKEN BUYS ─────────────────────────────────────
 * The frame carries `sandbox="allow-scripts"` and NOTHING else. That is the exact
 * pair of decisions this feature needs:
 *   allow-scripts        — author `<script>` must run, or a chart library could
 *                          never draw. This is the capability the whole widget is
 *                          for, and it is safe precisely because it happens under
 *                          an explicit user action and never at playback.
 *   NO allow-same-origin — with `allow-scripts` alone the frame gets an OPAQUE
 *                          origin, so the author's script cannot touch this page's
 *                          DOM, cookies, localStorage or IndexedDB. It cannot read
 *                          the user's project, and it cannot reach the parent.
 *   NO allow-top-navigation / allow-popups / allow-forms / allow-modals — a
 *                          capture must not be able to navigate the editor away,
 *                          spawn windows, or block on `alert()`.
 * THE OPAQUE ORIGIN IS ALSO WHY THIS MODULE CANNOT READ THE FRAME'S DOM, which
 * shapes everything below: the frame reports its own completion by `postMessage`,
 * and the pixels come from serializing the source into an `<svg><foreignObject>`
 * rather than from walking the rendered tree. Both are consequences of the
 * sandbox, not preferences.
 *
 * ── THE TWO PHASES, AND WHY THEY ARE BOTH NECESSARY ─────────────────────────
 * 1. EXECUTE — the sandboxed frame runs the source (scripts included), then reports
 *    back the HTML its scripts PRODUCED (`document.documentElement.outerHTML`) plus
 *    its `document.fonts.ready`. This is what makes a script-driven page (a chart
 *    library filling a container) capturable at all: what we rasterize is the
 *    POST-SCRIPT markup, not the author's pre-script source.
 * 2. RASTERIZE — that produced markup goes into an `<svg><foreignObject>` data URL,
 *    which an `<img>` decodes and a canvas draws. This is the classic html2image
 *    route (Amendment 3 route a), chosen for v1 because it needs no server and no
 *    headless Chrome; see the plugin header for why the true-vector route (c) is
 *    the follow-up rather than this.
 * SVG-IN-IMAGE IS ITSELF A SANDBOX, and it is the second reason phase 1 exists
 * separately: a browser will not run scripts or fetch external resources inside an
 * `<img>`-loaded SVG. So the rasterize step is inert by construction — which is
 * exactly what we want, and exactly why the scripts have to have already run.
 *
 * ── FOREIGN SUBRESOURCES ARE REFUSED, LOUDLY, BEFORE ANYTHING RUNS ──────────
 * A `<script src="https://cdn…">`, a remote `<img>`, a webfont `@import` — all
 * refused, by URL, with a sentence. Three reasons, in order of weight:
 *   1. SELF-CONTAINEDNESS (Amendment 3): a deck whose picture depended on a CDN
 *      still serving that version rots, silently, months later.
 *   2. THE `<img>`-SVG STEP CANNOT LOAD THEM ANYWAY. Even if phase 1 fetched a
 *      remote image successfully, the foreignObject rasterization would draw it as
 *      a broken/empty box — so permitting it would produce a CONFIDENTLY WRONG
 *      picture (a chart with no data, a page with no logo) that exited 0. This is
 *      the failure class this codebase forbids, and it is why the check is a
 *      refusal rather than a warning.
 *   3. It is the honest answer to the chartjs question — see the plugin header.
 * Refusing on the SOURCE TEXT before the frame is created also means a hostile
 * source never gets to make a network request at all.
 *
 * ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
 * NO WHITELIST MACHINERY. Bundled-library support is a designed follow-up
 * (plugins/html2image.js states its shape); a whitelist whose list is empty is
 * behaviourally identical to the refusal above while costing a mechanism to keep
 * correct, so it is not written yet.
 * NO AUTOMATIC RE-CAPTURE. Capture is an explicit command, and deliberately not a
 * side effect of saving the source in the Monaco modal. Editing HTML is iterative
 * and a capture writes an ASSET into the project library — coupling them would mint
 * a file per keystroke-flurry, and would also make an authoring action happen
 * without the user choosing it, which is the one thing the security argument rests
 * on. The plugin's Inspector row and Tools row are how it is asked for.
 */

// web/assetRef.js is DOM-free by its own docblock, so it is a safe static import.
// web/storageMode.js is NOT — it reaches projectApi.js, which reads `location` at
// module scope — so it is imported LAZILY on the async capture path below. That
// keeps THIS module importable in bare node, which is what lets its pure half
// (foreignSubresources, rasterSize, captureDocument, foreignObjectSvg) carry real
// executable doctests and be pinned by tests/htmlcap_html2image_test.js. The same discipline
// render_gpu/gpu/mermaid_raster.js uses to keep its Vite-only renderer behind a
// lazy import; the alternative was a HOST_BOUND entry excusing the whole file from
// the doctest gate, which would have taken the pure grammar down with it.
import { assetRef, relativeAssetRef } from "./assetRef.js";

/** The sandbox tokens the capture frame gets — `allow-scripts` and nothing else.
 * A CONSTANT because the security argument in this module's header is entirely
 * about what is ABSENT from this string, and a future edit that adds
 * `allow-same-origin` would silently un-opaque the origin and hand author scripts
 * the editor's storage. tests/htmlcap_html2image_test.js asserts this exact value. */
export const CAPTURE_SANDBOX = "allow-scripts";

/** How long the sandboxed frame gets to run its scripts and report back before the
 * capture is abandoned with a loud error. Generous, because an author's script may
 * legitimately do real work (laying out a large chart), but FINITE, because a
 * source with an infinite loop or a never-resolving promise would otherwise leave
 * the editor waiting forever with no message. */
export const CAPTURE_TIMEOUT_MS = 15000;

/** Upper bound on either raster dimension in DEVICE pixels, after the dpr
 * multiply. A 4000x4000 capture at dpr 3 would ask for a 12000px canvas, which
 * browsers refuse — and they refuse it by returning a BLANK canvas rather than
 * throwing, i.e. silently. So the scale is reduced to fit instead, and the
 * reduction is REPORTED. Matches render_gpu/gpu/mermaid_raster.js's
 * MERMAID_MAX_RASTER_PX for the same reason. */
export const MAX_CAPTURE_PX = 4096;

/** The basename stem every capture is stored under, before de-collision. The asset
 * store appends " 2", " 3", … so successive captures accumulate as siblings rather
 * than overwriting — which is what makes a capture UNDOABLE: undo restores the
 * previous `capture` ref, and the asset it names is still there. */
export const CAPTURE_ASSET_STEM = "html2image";

/**
 * Pure function. Every URL in `html` that would load from ANOTHER ORIGIN.
 *
 * WHAT COUNTS AS FOREIGN, and the two cases that deliberately do not:
 *   - `data:` URIs are INLINE bytes. They are the supported way to embed an image
 *     or a font, and they survive the foreignObject rasterization intact.
 *   - a RELATIVE or root-relative path is same-origin, i.e. this app's own server.
 *     It is not foreign, and it is the seam a future bundled-library whitelist
 *     would use.
 * Anything with an explicit scheme+host — `https:`, `http:`, and the
 * scheme-relative `//host/…` form that is easy to forget — is foreign.
 *
 * ATTRIBUTE-BASED, NOT DOM-BASED, and that is required rather than lazy: this runs
 * BEFORE the frame is created, so there is no DOM to walk, which is the whole point
 * (a hostile source must not get to make a request before being refused). It
 * therefore matches `src=`/`href=` attribute values and CSS `url(…)`/`@import`.
 *
 * KNOWN AND STATED BOUND: a URL a SCRIPT builds at runtime (`fetch("https://"+h)`)
 * is not visible to a text scan and is not caught here. That is not a hole this
 * check can close — the opaque-origin sandbox is what contains it, and the
 * foreignObject step cannot draw whatever it fetched anyway. What this function
 * exists to prevent is the ORDINARY case: an author pasting a CDN `<script>` tag
 * and getting a silently blank chart.
 *
 * @param {string} html - the source
 * @returns {string[]} the foreign URLs found, in source order, de-duplicated
 *
 * @example foreignSubresources('<img src="data:image/png;base64,iVBO">')
 * []
 * @example foreignSubresources('<img src="/asset/Deck/logo.png">')
 * []
 * @example foreignSubresources('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>')
 * ['https://cdn.jsdelivr.net/npm/chart.js']
 * @example foreignSubresources('<link href="//fonts.example.com/x.css">')
 * ['//fonts.example.com/x.css']
 * @example foreignSubresources('<style>@import url("https://a.test/f.css");</style>')
 * ['https://a.test/f.css']
 * @example foreignSubresources('<div style="background: url(https://a.test/b.png)"></div>')
 * ['https://a.test/b.png']
 */
export function foreignSubresources(html) {
  const source = String(html ?? "");
  const found = [];
  // Group 2 is the quoted attribute value; group 3 the unquoted url(…) / bare form.
  const patterns = [
    /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi,
    /\burl\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    /@import\s+(["'])(.*?)\1/gi,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const url = (m[2] ?? "").trim();
      if (isForeignUrl(url) && !found.includes(url)) found.push(url);
    }
  }
  return found;
}

/**
 * Pure function. Is this one URL from another origin? See foreignSubresources for
 * why `data:` and relative paths are not.
 *
 * @param {string} url
 * @returns {boolean}
 *
 * @example isForeignUrl("https://cdn.test/a.js")
 * true
 * @example isForeignUrl("//cdn.test/a.js")
 * true
 * @example isForeignUrl("data:image/png;base64,AAA")
 * false
 * @example isForeignUrl("/asset/Deck/logo.png")
 * false
 * @example isForeignUrl("#anchor")
 * false
 */
export function isForeignUrl(url) {
  const u = String(url ?? "").trim();
  if (u.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^data:/i.test(u);
}

/**
 * Pure function. The device-pixel raster size for a requested capture, and the
 * scale that produced it — the requested size times `dpr`, reduced uniformly if
 * either axis would exceed MAX_CAPTURE_PX.
 *
 * REDUCING RATHER THAN THROWING is deliberate: an oversized capture is an ordinary
 * authoring mistake (typing 8000 into a size row), and a smaller-but-correct
 * picture plus a reported reduction is a better answer than a refusal. What must
 * NOT happen is the browser's own behaviour of returning a blank canvas, which is
 * what this exists to prevent.
 *
 * @param {number} width - requested CSS-pixel width
 * @param {number} height - requested CSS-pixel height
 * @param {number} dpr - device pixel ratio
 * @returns {{w: number, h: number, scale: number, reduced: boolean}}
 *
 * @example rasterSize(1280, 720, 2)
 * { w: 2560, h: 1440, scale: 2, reduced: false }
 * @example rasterSize(1280, 720, 1)
 * { w: 1280, h: 720, scale: 1, reduced: false }
 * @example rasterSize(4000, 2000, 2)
 * { w: 4096, h: 2048, scale: 1.024, reduced: true }
 */
export function rasterSize(width, height, dpr) {
  const scale = Math.min(dpr, MAX_CAPTURE_PX / width, MAX_CAPTURE_PX / height);
  return {
    w: Math.round(width * scale),
    h: Math.round(height * scale),
    scale,
    reduced: scale < dpr,
  };
}

/**
 * Pure function. The document loaded into the sandboxed frame: the author's source,
 * plus the small reporter script that tells the parent when the page has finished.
 *
 * THE REPORTER IS APPENDED, NOT WRAPPED AROUND. The author's markup goes in
 * verbatim so that what they wrote is what lays out — a wrapper element would
 * introduce a containing block the author did not write and quietly change
 * percentage heights and flex behaviour.
 *
 * THE BODY IS SIZED IN CSS PIXELS TO THE REQUESTED CAPTURE BOX, and given
 * `margin: 0`. Without the explicit size a percentage-height layout (the common
 * case for a full-bleed card) has nothing to resolve against and collapses; without
 * the margin reset every capture would carry the browser's default 8px gutter.
 *
 * THE REPORT WAITS ON `document.fonts.ready` AND ONE ANIMATION FRAME. Fonts,
 * because rasterizing before a webfont resolves captures fallback metrics — the
 * classic html2image defect, and an invisible one. One frame, because a script that
 * writes DOM in its own load handler has not been laid out until the next frame,
 * and its element sizes would read as 0.
 *
 * @param {string} html - the author's source
 * @param {number} width - capture width in CSS px
 * @param {number} height - capture height in CSS px
 * @param {string} token - the nonce the parent matches on the reply (see captureHtmlToAsset)
 * @returns {string} a complete HTML document
 *
 * @example captureDocument("<p>hi</p>", 800, 600, "t1").includes("<p>hi</p>")
 * true
 * @example captureDocument("<p>hi</p>", 800, 600, "t1").includes("document.fonts.ready")
 * true
 */
export function captureDocument(html, width, height, token) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${width}px; height: ${height}px; overflow: hidden; }
</style>
</head>
<body>
${html}
<script>
(function () {
  var report = function (payload) {
    // "*" is the only possible target: this frame has an OPAQUE origin, so it
    // cannot name the parent's. The parent authenticates the reply by matching
    // BOTH event.source (this exact frame) and the token below, which is why a
    // wildcard target is not a hole here.
    parent.postMessage(Object.assign({ token: ${JSON.stringify(token)} }, payload), "*");
  };
  var finish = function () {
    // The POST-SCRIPT markup: what the author's scripts actually produced, which
    // is what gets rasterized. See this module's TWO PHASES note.
    //
    // XMLSerializer, NOT \`outerHTML\`, AND THIS IS NOT A STYLE CHOICE. \`outerHTML\`
    // produces HTML serialization, in which VOID ELEMENTS ARE UNCLOSED — \`<meta
    // charset="utf-8">\`, \`<br>\`, \`<img src=…>\`. foreignObject content must be
    // well-formed XHTML, so such markup makes the <img>-SVG decode fail, and the
    // failure surfaces one layer away as "the browser could not decode the rendered
    // page as an image" — a sentence that points at the author's html when the
    // offender was OUR OWN injected <meta> tag. MEASURED: the produced default card
    // failed XML parsing with "Unexpected closing tag: head != meta" at line 6.
    // XMLSerializer emits <meta charset="utf-8"/> and self-closes every void element
    // the AUTHOR wrote too, which is the general fix rather than a patch for the one
    // tag this file happens to inject.
    try {
      report({ ok: true, html: new XMLSerializer().serializeToString(document.documentElement) });
    } catch (e) {
      report({ ok: false, error: String(e && e.message || e) });
    }
  };
  // A throw inside author script must reach the author, not vanish into a frame
  // nobody can see — this is the one console they have no other access to.
  window.onerror = function (message) { report({ ok: false, error: String(message) }); return true; };
  var ready = function () {
    var fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    fonts.then(function () { requestAnimationFrame(function () { requestAnimationFrame(finish); }); });
  };
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
})();
<\/script>
</body></html>`;
}

/**
 * Pure function. The `<svg><foreignObject>` wrapper that makes rendered markup
 * rasterizable by an `<img>` — the classic html2image trick, and phase 2 of the
 * capture.
 *
 * THE XHTML NAMESPACE IS MANDATORY. `foreignObject` content must be namespaced
 * XHTML or the SVG parser drops it, and it drops it SILENTLY: the image loads
 * successfully and draws an empty box. That failure mode (a successful load of a
 * blank picture) is why the caller additionally checks that the result is not
 * uniformly transparent.
 *
 * @param {string} html - the produced markup (an entire <html> document's outerHTML)
 * @param {number} width - CSS-pixel width
 * @param {number} height - CSS-pixel height
 * @returns {string} SVG source
 *
 * @example foreignObjectSvg("<html><body>hi</body></html>", 100, 50).startsWith("<svg")
 * true
 * @example foreignObjectSvg("<html><body>hi</body></html>", 100, 50).includes('xmlns="http://www.w3.org/1999/xhtml"')
 * true
 */
export function foreignObjectSvg(html, width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;">${html}</div>` +
    `</foreignObject></svg>`;
}

/**
 * Command (async; browser-only). THE CAPTURE. Runs `html` in a throwaway sandboxed
 * frame, rasterizes what it produced, stores the PNG in the project's asset
 * library, and returns the ref to write onto the widget's `capture` property.
 *
 * IT RETURNS A REF AND WRITES NOTHING TO THE DOCUMENT. The caller
 * (plugins/html2image.js captureSelectedHtml) makes the one undo unit, because
 * the document write is the app's business and this module's is the browser work —
 * the same split plugins/demo/video_time_scrub.js's probe uses.
 *
 * LOUD AT EVERY STEP. Foreign subresources, a script error inside the frame, a
 * timeout, an image that will not decode, an all-transparent result — each throws
 * with a sentence naming the cause. There is no path through this function that
 * returns a ref to something the author did not get.
 *
 * @param {object} app - the editor app (only projectName() is read)
 * @param {{html: string, width: number, height: number}} request
 * @returns {Promise<string>} the asset ref to store (relative for this project)
 */
export async function captureHtmlToAsset(app, { html, width, height }) {
  if (typeof document === "undefined")
    throw new Error("captureHtmlToAsset: no DOM — the HTML capture runs in the editor (a browser), not in bare node or the CLI renderer. That is the point: playback reads the stored asset, never the source.");
  const source = String(html ?? "");
  if (source.trim().length === 0)
    throw new Error("Capture HTML: the source is empty — there is nothing to capture. Double-click the widget to write some HTML first.");
  if (!(width > 0) || !(height > 0))
    throw new Error(`Capture HTML: the capture size must be positive, got ${width}x${height}.`);

  const foreign = foreignSubresources(source);
  if (foreign.length > 0)
    throw new Error(
      `Capture HTML: this source loads ${foreign.length} resource(s) from another origin — ${foreign.join(", ")}. ` +
      "A captured deck must be self-contained (a CDN that stops serving that version breaks the picture months later), " +
      "and the rasterization step cannot load them anyway, so capturing would produce a confidently blank picture. " +
      "Inline the script/style, or embed the image or font as a data: URI.",
    );

  const produced = await runInSandbox(source, width, height);
  const bitmapCanvas = await rasterizeMarkup(produced, width, height);
  const blob = await canvasToPngBlob(bitmapCanvas);

  const project = app.projectName();
  const { assetStoreFor } = await import("./storageMode.js"); // lazy — see the import note at the top
  const store = assetStoreFor(project);
  const res = await store.put(project, blob, `${CAPTURE_ASSET_STEM}.png`);
  // The store DE-COLLIDES, so the stored name is whatever it returns — trusting the
  // requested name is how a document would end up pointing at "html-capture.png"
  // while the bytes landed in "html-capture 2.png" (web/app.svelte.js's
  // localizeForeignAssets records the same trap).
  // RELATIVE, because it is this project's own asset: the document then survives a
  // rename, a Save-As and a zip round-trip (core/asset_ref.js's grammar, and the
  // rule app.#storedSrc applies to every picked asset).
  return relativeAssetRef(assetRef(project, res.name), project);
}

/**
 * Command (async; browser-only). PHASE 1 — run the source in a sandboxed frame and
 * return the markup its scripts produced. The frame is created here and removed in
 * a `finally`, which is the law this module exists to keep.
 *
 * @param {string} html - the author's source
 * @param {number} width - capture width in CSS px
 * @param {number} height - capture height in CSS px
 * @returns {Promise<string>} the produced markup
 */
async function runInSandbox(html, width, height) {
  // A per-capture nonce. The parent accepts a reply only when BOTH the token and
  // the event's source frame match, so a concurrent capture (or any other page
  // posting at us) cannot be mistaken for this one's answer.
  const token = `htmlcap-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", CAPTURE_SANDBOX);
  // ON-SCREEN AND INVISIBLE — NOT OFF-VIEWPORT, AND NOT `display: none`. Both of the
  // obvious ways to hide this frame break it, for two DIFFERENT reasons, and the
  // second one cost a whole probe suite before it was measured:
  //
  //   `display: none` — the frame is not laid out at all, so element sizes read as 0
  //     and any script measuring its container produces a degenerate layout.
  //   `left: -20000px` (WHAT THIS LINE USED TO BE) — the frame IS laid out, but an
  //     OFF-VIEWPORT frame receives EXACTLY ONE requestAnimationFrame tick and is
  //     then stalled by the compositor. captureDocument's report path needs TWO
  //     (fonts.ready → rAF → rAF, so a script that writes DOM in its own load
  //     handler has been laid out before we serialize it). So the second tick never
  //     arrived, the frame never reported, and EVERY capture died at the 15s timeout
  //     — including one built from this widget's own shipped DEFAULT_HTML.
  //
  // MEASURED, not reasoned: a standalone CDP repro counting a child frame's rAF
  // ticks gives 1 for `left:-20000px`, 1 for `clip-path: inset(100%)` (the first
  // proposed fix — it stalls exactly like off-viewport, which is why the shipped
  // combo below does NOT use it), and 10 for both `opacity: 0` and an on-screen
  // `visibility: hidden`. This is NOT headless-specific: offscreen-frame throttling
  // is ordinary compositor behaviour, so the old positioning was a latent defect in
  // real editors too, not merely in the test harness.
  //
  // THE COMBO, and what each token is for: the frame sits at the origin (so it is
  // genuinely on-screen and ticks), `visibility: hidden` + `opacity: 0` make it
  // invisible with no flash, and `pointer-events: none` is belt-and-braces over the
  // fact that a hidden frame is already not hit-tested — verified: with the frame
  // present, elementFromPoint at its own corner still returns the page underneath.
  frame.style.cssText = `position: fixed; left: 0; top: 0; width: ${width}px; height: ${height}px; border: 0; opacity: 0; pointer-events: none; visibility: hidden;`;
  frame.setAttribute("aria-hidden", "true");
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        fn(value);
      };
      const onMessage = (ev) => {
        // BOTH checks are required: the token alone would accept a reply from a
        // different window that had somehow seen it, and the source alone would
        // accept an unrelated message from this same frame.
        if (ev.source !== frame.contentWindow || ev.data?.token !== token) return;
        if (ev.data.ok) settle(resolve, ev.data.html);
        else settle(reject, new Error(`Capture HTML: the source threw while running — ${ev.data.error}`));
      };
      const timer = setTimeout(
        () => settle(reject, new Error(`Capture HTML: the source did not finish within ${CAPTURE_TIMEOUT_MS / 1000}s. A script that never resolves (or an infinite loop) cannot be captured — the frame was destroyed.`)),
        CAPTURE_TIMEOUT_MS,
      );
      window.addEventListener("message", onMessage);
      // `srcdoc` rather than a blob: URL, because a blob: URL inherits an origin
      // this frame is not supposed to have; srcdoc under `allow-scripts` alone is
      // reliably opaque.
      frame.srcdoc = captureDocument(html, width, height, token);
      document.body.appendChild(frame);
    });
  } finally {
    frame.remove();
  }
}

/**
 * Command (async; browser-only). PHASE 2 — rasterize produced markup to a canvas at
 * device resolution.
 *
 * THE ALL-TRANSPARENT CHECK IS NOT PARANOIA. The foreignObject route's
 * characteristic failure is a SUCCESSFUL load of an empty picture (a namespace
 * problem, a resource the SVG sandbox refused, a tainted source), and storing that
 * would freeze a blank image into the deck while reporting success — precisely the
 * silent wrongness the widget's placeholder exists to prevent, reintroduced one
 * layer down.
 *
 * @param {string} markup - the produced markup from phase 1
 * @param {number} width - CSS-pixel width
 * @param {number} height - CSS-pixel height
 * @returns {Promise<HTMLCanvasElement>}
 */
async function rasterizeMarkup(markup, width, height) {
  const size = rasterSize(width, height, window.devicePixelRatio || 1);
  if (size.reduced)
    console.warn(`Capture HTML: ${width}x${height} at dpr ${window.devicePixelRatio} exceeds the ${MAX_CAPTURE_PX}px raster cap, so it was captured at ${size.w}x${size.h} (scale ${size.scale.toFixed(3)}) instead. Lower the capture size for a sharper result.`);

  const svg = foreignObjectSvg(markup, width, height);
  // encodeURIComponent, NOT btoa: the markup is arbitrary Unicode and btoa throws
  // on any character above U+00FF, so a capture containing an em-dash or an emoji
  // would fail at this line for a reason with nothing to do with the author's page.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(
      "Capture HTML: the browser could not decode the rendered page as an image. This usually means the produced markup is not well-formed XHTML (foreignObject requires it) — an unclosed tag or a bare attribute is enough.",
    ));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, size.w, size.h);
  if (isBlank(ctx, size.w, size.h))
    throw new Error(
      "Capture HTML: the capture came out entirely transparent. The page rendered but drew nothing — a fully-empty body, or content positioned outside the capture box. Check that the source draws inside the capture width and height.",
    );
  return canvas;
}

/**
 * Query (reads canvas pixels). Is every pixel fully transparent? See
 * rasterizeMarkup for why a blank result must be an error rather than an asset.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function isBlank(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

/**
 * Command (async; browser-only). Canvas → PNG Blob. PNG rather than JPEG because a
 * captured page routinely has a transparent background (the author lets the slide
 * show through), and JPEG would composite that onto black without saying so.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Capture HTML: the browser refused to encode the captured canvas as a PNG (most likely it is too large). Lower the capture width and height."));
    }, "image/png");
  });
}
