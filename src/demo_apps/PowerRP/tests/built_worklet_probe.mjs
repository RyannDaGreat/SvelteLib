/**
 * BUILT-WORKLET PROBE — every AudioWorklet the PRODUCTION build emits actually LOADS.
 *
 * ── THE GAP THIS CLOSES: "the build exited 0" vs "the app makes sound" ───────
 * Measured 2026-08-06 on a real PowerRP build. The emitted AX-2 processor still
 * contained `from "../ax2_kernels.js"` and NO `ax2_kernels` asset had been emitted, so
 * in a browser:
 *
 *     LOADS  processors-D0TLf9eJ.js
 *     LOADS  processors_ax1--8OWussl.js
 *     FAILS  processors_ax2-8GDkHhID.js   AbortError: Unable to load a worklet's module.
 *     LOADS  processors_ax3-z_us9Tup.js
 *
 * `engine.init()` AWAITS every entry, so that single rejection is NO AUDIO AT ALL in
 * the deployed app — off a build that exited 0 with no warning. Nothing else in the
 * suite loads a BUILT worklet: the node lane imports sources, and the browser probes
 * run against the DEV server, where a relative specifier inside a worklet still
 * resolves. That is the entire blind spot, and it is the one where "no sound" lives.
 *
 * ── WHY IT BUILDS RATHER THAN READING AN EXISTING dist-powerrp ───────────────
 * `dist-powerrp/` is gitignored, so on a fresh clone it is absent — and a probe that
 * passes because its subject is missing is worse than no probe (the gate's own header
 * says so, and its SKIP contract exists for prerequisites we cannot provision; a build
 * is one we CAN). A stale dist is the same hazard wearing a different hat: it would
 * measure last week's source and report green. So this builds every run, ~45 s, using
 * the pattern tests/prod_boot_probe.js established — vite's own `build()` + `preview()`
 * against `web/vite.config.js`, because a root `npx vite build` does not build this app.
 *
 * ── WHY THE WORKLET SET IS DERIVED FROM THE SOURCE TREE ─────────────────────
 * `synth/worklets/` IS the list: every `.js` in it is a worklet module, so a new block's
 * processor is covered the day it lands with no edit here. Each source file must have a
 * matching emitted `assets/<stem>-<hash>.js`, and MISSING IS A FAILURE — that half
 * catches the other shape of the same bug, a processor that was written and then never
 * emitted, which is a 404 at `addModule` just as surely as a missing kernel is.
 *
 * The first draft derived the set as "any emitted `.js` calling `registerProcessor(`",
 * which is the honest definition of a worklet module and was still WRONG here: it
 * matched the main app chunk. `synth/modules_ax2.js` statically imports
 * `worklets/processors_ax2.js` for its `AX2_PROCESSORS` roster (deliberately — one
 * source of truth for the names), so the processor's body, guard and all, is inlined
 * into `index-*.js`. Scanning bytes found a worklet where there is only a copy of one.
 *
 * Run standalone:  node src/demo_apps/PowerRP/tests/built_worklet_probe.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(HERE, "../web/vite.config.js");
/** THE LIST. Every `.js` here is a worklet module — see the header. */
const WORKLET_SOURCE_DIR = resolve(HERE, "../synth/worklets");

/** A cold prod build plus Chrome's first navigation; the build alone measured ~45 s. */
const NAVIGATE_BUDGET_MS = 60000;

/** How many surviving specifiers a failure quotes. A byte-for-byte copied processor
 *  keeps its COMMENTS, so the first match can be a docblock example rather than the
 *  guilty line — measured while proving this probe non-vacuous. Quoting several makes
 *  the real one visible without printing a whole file. (A correctly bundled worklet is
 *  minified, comments stripped, so this never adds noise to a passing build.) */
const SPECIFIERS_QUOTED = 3;

/**
 * Pure function. Which modules does this emitted bundle still name for runtime fetch?
 *
 * An AudioWorkletGlobalScope has NO module resolver and no `import()`, so either form is
 * fatal there — a static specifier fetches (and 404s, as ax2_kernels did) and a dynamic
 * one throws. Both are matched because both are ways to lose the audio, and the matched
 * text is returned so the failure names the specifier rather than merely its existence.
 *
 * @param {string} source - the emitted javascript
 * @returns {string[]} the offending snippets, newest-first, empty if self-contained
 *
 * @example survivingSpecifiers('class A{}registerProcessor("a",A);') // []
 * @example survivingSpecifiers('import{k}from"../ax2_kernels.js";')  // ['import{k}from"../ax2_kernels.js"']
 * @example survivingSpecifiers('const m=await import("./k.js");')    // ['import("./k.js"']
 */
export function survivingSpecifiers(source) {
  const PATTERNS = [
    /\bimport\s*[\w${}*,\s]*\bfrom\s*["'][^"']+["']/g, // import x from "…"
    /\bimport\s*["'][^"']+["']/g,                      // import "…"  (side effect)
    /\bimport\s*\(\s*["'][^"']+["']/g,                 // import("…")
  ];
  const hits = new Set();
  for (const pattern of PATTERNS)
    for (const m of source.matchAll(pattern)) hits.add(m[0].replace(/\s+/g, " "));
  return [...hits];
}

/**
 * Query (reads the built tree). Locate the emitted asset for one source worklet.
 *
 * Vite keeps the source basename and appends `-<hash>`, so `processors_ax1.js` becomes
 * `assets/processors_ax1-8OWussl.js`. The `-` separator is what keeps the stems apart:
 * `processors-` cannot match `processors_ax1-…`.
 *
 * @param {string[]} emitted - relative paths of every emitted `.js`
 * @param {string} stem - the source basename without `.js`
 * @returns {string|null} the matching relative path, or null if the build emitted none
 */
function emittedFor(emitted, stem) {
  return emitted.find((rel) => new RegExp(`(^|/)${stem}-[^/]*\\.js$`).test(rel)) ?? null;
}

/** Query (reads a directory tree). Every `.js` under `dir`, as paths relative to it. */
function jsFilesUnder(dir, rel = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...jsFilesUnder(dir, childRel));
    else if (entry.name.endsWith(".js")) out.push(childRel);
  }
  return out;
}

const failures = [];
const note = (m) => console.log(`  · ${m}`);

const { build, preview, resolveConfig } = await import("vite");
// The outDir and base are READ from the app's config rather than restated: this file
// must not be a second opinion about where the build lands.
const config = await resolveConfig({ configFile: CONFIG_FILE }, "build");
const outDir = config.build.outDir;

console.log("building the production bundle …");
await build({ configFile: CONFIG_FILE, logLevel: "warn" });

const sourceStems = readdirSync(WORKLET_SOURCE_DIR).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -".js".length)).sort();
if (sourceStems.length === 0) {
  console.log(`FAIL ${WORKLET_SOURCE_DIR} holds no .js — either the app has no worklets (it has no audio) or this `
    + "probe is looking in the wrong place. An empty subject is not a pass.");
  process.exit(1);
}
const emitted = jsFilesUnder(outDir);
const worklets = [];
for (const stem of sourceStems) {
  const file = emittedFor(emitted, stem);
  if (!file) {
    failures.push(`synth/worklets/${stem}.js exists in the source but the build emitted NO asset for it — `
      + "whatever passes its URL to addModule will 404, which is the same silent no-audio as a missing kernel");
    continue;
  }
  worklets.push({ file, url: `${config.base}${file}`, source: readFileSync(join(outDir, file), "utf8") });
}
note(`${worklets.length}/${sourceStems.length} source worklet(s) emitted: ${worklets.map((w) => w.file).join(", ")}`);

for (const w of worklets) {
  const specifiers = survivingSpecifiers(w.source);
  if (specifiers.length) {
    const shown = specifiers.slice(0, SPECIFIERS_QUOTED).map((s) => JSON.stringify(s)).join(", ");
    failures.push(`${w.file} still names ${specifiers.length} module(s) it would have to FETCH at runtime `
      + `(${shown}) — a worklet has no resolver, so this is a 404 and no audio`);
  }
}

const server = await preview({ configFile: CONFIG_FILE, preview: { port: 0, host: "127.0.0.1", open: false } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  // 127.0.0.1 is a SECURE CONTEXT, which `BaseAudioContext.audioWorklet` requires — the
  // same reason run_server.sh arranges TLS for the app. An OfflineAudioContext is used
  // rather than a live one so no device is opened and the run needs no audio hardware.
  await page.goto(`${origin}${config.base}`, { waitUntil: "domcontentloaded", timeout: NAVIGATE_BUDGET_MS });
  const results = await page.evaluate(async (urls) => {
    const out = [];
    for (const url of urls) {
      const ctx = new OfflineAudioContext(1, 128, 48000);
      try {
        await ctx.audioWorklet.addModule(url);
        out.push({ url, ok: true });
      } catch (e) { out.push({ url, ok: false, why: String(e).slice(0, 200) }); }
    }
    return out;
  }, worklets.map((w) => w.url));

  for (const r of results) {
    if (r.ok) note(`LOADS ${r.url}`);
    else failures.push(`${r.url} did NOT load in a real AudioWorklet: ${r.why}`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\nbuilt worklets: ${failures.length} failed`);
  process.exit(1);
}
console.log(`\nbuilt worklets: all ${worklets.length} load from the production build`);
