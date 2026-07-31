/**
 * swBuildPlugin.js — the vite plugin that turns `web/sw.js` into a real service
 * worker, and emits the web app manifest that makes PowerRP installable.
 *
 * ── WHY HAND-ROLLED RATHER THAN vite-plugin-pwa ──────────────────────────────
 * Decided from the code, not from taste. vite-plugin-pwa is the right answer
 * when you want Workbox's routing DSL, precache revisioning across partial
 * updates, and a generated worker you never read. What THIS app needs is one
 * sentence long: "cache every file vite just emitted, plus stale-while-
 * revalidate one third-party origin". That is ~40 lines of routing (web/sw.js,
 * which is readable and reviewable in full) and the ~50 lines here that compute
 * the file list. Against that, the plugin would add a dependency with its own
 * Workbox transitive tree to a repo that vendors its heavy deps deliberately,
 * and would put the offline behaviour behind a config object instead of in a
 * file with the reasoning written next to the rules. The repo's standing
 * preference — "minimal structure now, expand later as need permits" — points
 * the same way. If partial-update revisioning or precache manifests per route
 * ever matter, THAT is the moment to switch, and the SW is small enough to throw
 * away when it comes.
 *
 * ── THE BASE PATH ────────────────────────────────────────────────────────────
 * GitHub Pages serves this under `/SvelteLib/`, and the base is a BUILD-time
 * decision (vite bakes it in; it cannot be discovered at runtime). Every URL
 * this plugin writes — precache entries, the shell path, the manifest's
 * start_url and scope, the icon src — is therefore prefixed with the resolved
 * base. Getting it wrong does not fail the build; it produces a worker that
 * caches 404s, which is why `sw.js`'s install uses the atomic `cache.addAll`
 * and blows up rather than half-installing.
 *
 * ── THE SCOPE RULE THAT DICTATES WHERE sw.js LANDS ───────────────────────────
 * A service worker may only control pages at or below its OWN path. Emitting it
 * as `assets/sw-<hash>.js` would scope it to `assets/`, controlling nothing. So
 * it is emitted at the base root as a stable, unhashed `sw.js`. Cache-busting is
 * handled by VERSION (a hash of the precache list) inside the file instead —
 * a new bundle changes the list, which changes the version, which mints a new
 * cache and collects the old one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Emitted assets NOT worth precaching, and this list is the difference between
 * a 12 MB install and a 90 MB one.
 *
 * MEASURED, not guessed. The full emitted bundle is ~90 MB, of which the app
 * needs a small fraction to BOOT: a 24 MB `.MOV` test fixture, ~35 MB of CJK and
 * colour-emoji font files, and source maps account for nearly all the rest. A
 * worker that precached all of it would spend the user's first visit — and their
 * data plan — downloading a demo video they may never open, to make offline work.
 * That trade is backwards.
 *
 * THE RULE: precache what the app cannot START without; let everything else be
 * cached on demand. Anything skipped here still gets cached the first time it is
 * actually fetched, because the same-origin fetch handler falls through to the
 * network and the browser's own HTTP cache keeps it — the skipped items simply
 * are not GUARANTEED offline until used once. For a CJK font or a demo video
 * that is the correct guarantee; for canvaskit.wasm it would not be, which is
 * why the wasm is deliberately NOT skipped despite being the single largest
 * precached file. Without it the editor cannot paint a frame at all, so an
 * offline boot would hang at the splash the wasm's own progress bar is metering.
 *
 * Source maps are debug-only and can dwarf the code they describe. The worker
 * never precaches itself (it would pin the old worker in the cache meant to
 * replace it) — handled by name in precacheUrls.
 */
const PRECACHE_SKIP = [
  /\.map$/,
  // Media fixtures: demo/test assets, never on the boot path.
  /\.(mov|mp4|webm|m4v)$/i,
  // The CJK + colour-emoji faces (~35 MB). The Latin UI fonts are small and DO
  // precache; these load only when a deck actually contains such text, and that
  // deck's author is the person who benefits from paying for them.
  /Noto(ColorEmoji|Sans(SC|KR|JP|TC))/i,
];

/** The app-manifest icon: PowerRP's own mark as an inline SVG, so installability
 *  costs no binary asset in the tree and no extra request. A single maskable
 *  "P" on the Graphite-dark canvas the boot splash already uses — the app's
 *  first-paint colour, so the launch icon and the launch screen agree.
 *  Deliberately geometric: it must stay legible at a 48px launcher tile. */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1b1b1b"/>
  <path d="M176 128h112a88 88 0 0 1 0 176h-56v80h-56zm56 48v80h56a40 40 0 0 0 0-80z" fill="#e6e6e6"/>
</svg>`;

/**
 * Pure function. The web app manifest — what makes the site INSTALLABLE, which
 * is the user's iOS mitigation as much as a convenience (see below).
 *
 * `display: standalone` so an installed copy opens without browser chrome, and
 * `start_url`/`scope` are base-prefixed so an installed PowerRP launches into
 * the app rather than the domain root (which on Pages is somebody else's page).
 *
 * @param {string} base - the resolved base path, always slash-terminated
 * @returns {object}
 *
 * @example webAppManifest("/SvelteLib/").start_url
 * '/SvelteLib/'
 * @example webAppManifest("/").scope
 * '/'
 */
export function webAppManifest(base) {
  return {
    name: "PowerRP",
    short_name: "PowerRP",
    description: "A presentation and figure editor that runs entirely in the browser — offline or online.",
    start_url: base,
    scope: base,
    display: "standalone",
    background_color: "#1b1b1b", // matches the boot splash, so install → launch has no flash
    theme_color: "#1b1b1b",
    icons: [
      { src: `${base}icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
    ],
  };
}

/**
 * Pure function. The precache URL list for a vite bundle, base-prefixed.
 *
 * Takes vite's emitted-bundle keys (relative filenames) and returns absolute
 * URLs, with the shell document first — order is cosmetic to `addAll` but makes
 * the emitted manifest readable when someone opens sw.js to debug a bad deploy.
 *
 * @param {string[]} fileNames - emitted bundle filenames, relative to outDir
 * @param {string} base - resolved base path, slash-terminated
 * @returns {string[]}
 *
 * @example precacheUrls(["index.html", "assets/main-a1b2.js", "assets/x.js.map"], "/SvelteLib/")
 * [ '/SvelteLib/index.html', '/SvelteLib/assets/main-a1b2.js' ]
 * @example precacheUrls(["assets/canvaskit-9f.wasm", "index.html"], "/")
 * [ '/index.html', '/assets/canvaskit-9f.wasm' ]
 * @example // The heavyweights that are NOT boot-critical are skipped (see PRECACHE_SKIP):
 * precacheUrls(["index.html", "assets/demo-x1.MOV", "assets/NotoColorEmoji-a2.ttf"], "/")
 * [ '/index.html' ]
 */
export function precacheUrls(fileNames, base) {
  const keep = fileNames.filter((f) => !PRECACHE_SKIP.some((re) => re.test(f)) && f !== "sw.js");
  const shell = keep.filter((f) => f === "index.html");
  const rest = keep.filter((f) => f !== "index.html").sort();
  return [...shell, ...rest].map((f) => `${base}${f}`);
}

/**
 * Pure function. A short, stable version string for a precache list.
 *
 * Content-derived so a rebuild that changes nothing keeps the same cache (no
 * pointless re-download on every deploy), while any bundle change mints a new
 * one. 12 hex chars: collision-irrelevant here, and short enough to read in
 * devtools' cache list.
 *
 * @param {string[]} urls
 * @returns {string}
 *
 * @example swVersion(["/a.js", "/b.js"]).length
 * 12
 * @example swVersion(["/a.js"]) === swVersion(["/a.js"])
 * true
 * @example swVersion(["/a.js"]) === swVersion(["/b.js"])
 * false
 */
export function swVersion(urls) {
  return createHash("sha256").update(urls.join("\n")).digest("hex").slice(0, 12);
}

/**
 * The vite plugin. Emits `sw.js`, `manifest.webmanifest` and `icon.svg` at the
 * bundle root, and injects the precache manifest into the worker source.
 *
 * BUILD ONLY (`apply: "build"`): the dev server must never serve a worker, per
 * sw.js's static-mode-only rule. There is nothing to disable at runtime because
 * the file is never emitted in dev at all.
 *
 * @returns {import("vite").Plugin}
 */
/**
 * The DEV twin: serves `manifest.webmanifest` and `icon.svg` on the dev server.
 *
 * index.html links the manifest UNCONDITIONALLY, and in dev the build-only
 * plugin above emits nothing — so the SPA fallback answered the manifest URL
 * with HTML and every dev boot logged "Manifest: Line 1, column 1, Syntax
 * error", which poisoned every probe that counts boot console errors. Serving
 * the two static assets is harmless in dev and makes the link truthful; the
 * WORKER stays build-only — this middleware must never grow an sw.js route
 * (sw.js's static-mode-only rule).
 *
 * @returns {import("vite").Plugin}
 */
export function powerrpManifestDev() {
  let base = "/";
  return {
    name: "powerrp-manifest-dev",
    apply: "serve",
    configResolved(config) {
      base = config.base.endsWith("/") ? config.base : `${config.base}/`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (path === `${base}manifest.webmanifest`) {
          res.setHeader("Content-Type", "application/manifest+json");
          res.end(JSON.stringify(webAppManifest(base)));
          return;
        }
        if (path === `${base}icon.svg`) {
          res.setHeader("Content-Type", "image/svg+xml");
          res.end(ICON_SVG);
          return;
        }
        next();
      });
    },
  };
}

export function powerrpServiceWorker() {
  let base = "/";
  return {
    name: "powerrp-service-worker",
    apply: "build",
    configResolved(config) {
      base = config.base.endsWith("/") ? config.base : `${config.base}/`;
    },
    generateBundle(_options, bundle) {
      const urls = precacheUrls(Object.keys(bundle), base);
      const version = swVersion(urls);
      const source = readFileSync(resolve(HERE, "sw.js"), "utf8");
      // The three build-time substitutions sw.js reads through `??` defaults.
      // Prepended rather than string-replaced so the worker file stays valid
      // JavaScript on its own — readable, lintable, and diffable against what
      // actually ships.
      const preamble =
        `// GENERATED PREAMBLE — powerrpServiceWorker (web/swBuildPlugin.js). Do not edit.\n` +
        `self.__POWERRP_PRECACHE = ${JSON.stringify(urls, null, 2)};\n` +
        `self.__POWERRP_SW_VERSION = ${JSON.stringify(version)};\n` +
        `self.__POWERRP_SHELL = ${JSON.stringify(`${base}index.html`)};\n\n`;

      // Emitted at the BASE ROOT, unhashed — the scope rule (see docblock).
      this.emitFile({ type: "asset", fileName: "sw.js", source: preamble + source });
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify(webAppManifest(base), null, 2),
      });
      this.emitFile({ type: "asset", fileName: "icon.svg", source: ICON_SVG });
    },
  };
}
