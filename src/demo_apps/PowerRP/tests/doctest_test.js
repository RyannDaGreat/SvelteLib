/**
 * DOCTESTS AS THE SPEC — now actually EXECUTED.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The house convention says every pure function carries examples and that those
 * examples ARE its specification. Some 5000 `@example` records are checked in
 * across core/, plugins/, render_gpu/, cli/ and web/, and until this file NOTHING
 * ran one of them. They were prose, and prose rots in the direction that misleads:
 * the first sweep found 18 executable examples that disagree with the code, some
 * stale by a nameable commit (core/registry.js's tool-group examples were written
 * before the Keyframes pool group existed — 7e3df60), and one, core/fuzzy.js's
 * ranking claim, asserting the exact OPPOSITE of what the algorithm does.
 *
 * TWO LATER WIDENINGS, both of which found more of the same (todo #216):
 *   `web/` — the app shell, ~24k lines — was outside SEARCH_DIRS entirely. Adding
 *     it turned up four false doctests in four files, among them a roster of canvas
 *     modes frozen at three entries while the registry had grown to seven, and two
 *     id minters whose examples pinned a literal random hex string and so could
 *     never have passed on any run, ever.
 *   The PARSER itself was blind to ` *  @example` (two spaces, the spelling used
 *     when the tag aligns under a `/** Query. …` opener). 73 records app-wide, 53
 *     of them in trees this suite was already reporting green. selfCheck could not
 *     catch it because every fixture in it used the one-space spelling — the
 *     checker was checked only against what it already handled.
 *
 * ── THE CHECKABILITY RULE (declared, because the alternative is a lie) ───────
 * Not every example can be executed, and a runner that silently dropped the ones
 * it could not would recreate the very problem it exists to fix: a number that
 * looks like coverage and is not. So every record lands in EXACTLY ONE bucket,
 * every bucket is counted, and the summary prints all of them.
 *
 * An example is EXECUTED when all of these hold:
 *   1. Its file is importable in bare node. Files whose NAME promises a host
 *      (browser_*, *worker*) are excluded up front, by name — not by catching an
 *      import error, which would also swallow a genuine breakage. Beyond those,
 *      exactly four files are excused, each named in HOST_BOUND with the Vite-only
 *      specifier that stops node PINNED, so a listed module failing for any other
 *      reason is still a hard failure. Every other file imports clean, so one that
 *      stops doing so is a HARD FAILURE here, never a skip. That is not
 *      hypothetical: this suite caught a backtick inside a shader comment closing
 *      the template literal it lived in, minutes after it was written.
 *   2. It states an EXPRESSION and an EXPECTED RESULT. Three checked-in shapes
 *      count: `expr // result`, `expr` then a `// result` line, and `expr` then a
 *      bare result line (the python-doctest shape). A comment-only `@example`
 *      is PROSE.
 *   3. The expected result begins with a JS LITERAL — number, string, template,
 *      array, object, one of true/false/null/undefined/NaN/Infinity, or
 *      `new X(...)` — optionally followed by an annotation. A BARE IDENTIFIER is
 *      NOT a literal: `// Set(["a"])` and `// Uint8Array [65, 66]` are display
 *      NOTATION, and treating `Set` as a value would have compared against the
 *      constructor and called it a pass. That hazard is why this rule is narrow.
 *   4. Nothing in the expression resolves outside the module's own exports and
 *      node's globals. Free names are detected EXACTLY (not by regex, which
 *      cannot tell an object-literal key from a reference) by evaluating the
 *      expression against a scope proxy that records every miss.
 *   5. It is synchronous. One checked-in example awaits, and a hung promise would
 *      hold the process past the gate's timeout and report as a red suite for the
 *      wrong reason.
 *
 * ── THE THRESHOLD POLICY ────────────────────────────────────────────────────
 * Three gates, so the suite is neither unrunnable nor decorative:
 *   HARD — every executed example must match, except quarantined ones (below).
 *   HARD — the SYNTAX bucket must stay empty. An `@example` that is not parseable
 *          JS cannot be a specification of anything. It is zero today.
 *   HARD — at least MIN_EXECUTED examples must actually run. A floor only ever
 *          trips when coverage DROPS, which is the failure mode a parser
 *          regression would otherwise hide behind a green run. Raise it as
 *          coverage grows; lowering it needs a stated reason.
 *
 * ── THE QUARANTINE, and why it cannot rot ───────────────────────────────────
 * Some false doctests live in files this suite's author does not own (concurrent
 * work, one owner per file). Those are listed in QUARANTINE with the owning file,
 * the reason, and — this is the load-bearing part — the OBSERVED value pinned.
 * An entry only excuses the failure it recorded:
 *   same failure          → expected, counted, printed.
 *   DIFFERENT failure     → HARD FAIL. A new defect cannot hide behind an old one.
 *   now passes / gone     → printed as STALE and does not fail the run. A
 *                           quarantine can only ever conceal a FIX, never a
 *                           break, so failing the gate because somebody repaired
 *                           a doctest would be perverse. The stale count is in
 *                           the headline so the list cannot quietly rot.
 * The list must shrink. It is keyed on the expression TEXT, not a line number, so
 * edits above it do not silently unpin it.
 *
 * ── WHO CHECKS THE CHECKER ──────────────────────────────────────────────────
 * tests/ is NOT swept: importing a test RUNS it, and the first draft of this file
 * booted a dev server and a browser by walking render_gpu/tests/. So this file's
 * own examples are verified by `selfCheck()` instead, which asserts the same
 * fixtures with node:assert before the sweep starts and reports its assertion
 * count in the headline. That is also the guard against the worst outcome here —
 * a parser that quietly stops recognising examples and reports a green nothing.
 *
 * Run: node tests/doctest_test.js  [--verbose]
 *   --verbose lists every skipped record with its bucket, not just the counts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import assert from "node:assert";
import { resolve, dirname, relative, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

/** The trees swept for examples. `web` — the app shell — was outside this list
 *  until todo #216, so ~24k lines of it had NEVER executed an example; the sweep
 *  that added it found four false doctests in four different files, one of them a
 *  stale roster of canvas modes that had drifted from three entries to seven.
 *  Most of web/ is DOM-free in practice: 54 of its 73 modules import clean in bare
 *  node. The 19 that do not are the reason HOST_BOUND below exists.
 *
 *  `web/canvas` used to be listed separately, back when `web/` at large was not —
 *  it is now reached by the same walk and needs no entry of its own. */
const SEARCH_DIRS = ["core", "plugins", "render_gpu", "cli", "web"];
/** Files that name a host in their filename: they cannot import without one. */
const BROWSER_ONLY_FILE = /^browser_|worker/;
/** Coverage floor — see THE THRESHOLD POLICY. Measured 2183 at introduction, 3961
 *  once `web` joined the sweep; the margin below the measurement is the same ~4%
 *  the original floor left, so ordinary churn does not trip it but a parser
 *  regression does. */
const MIN_EXECUTED = 3800;
/** Float slack, in units of the last representable bit, for arithmetic that is
 *  mathematically equal but not bit-equal (0.001 / 1000 !== 0.000001). */
const ULP_SLACK = 8;
/** How much of a value is shown in a failure line, and pinned in QUARANTINE. */
const SHOWN_CHARS = 200;
const PINNED_CHARS = 120;
/** How much of an example is echoed in a one-line skip note. */
const NOTE_CHARS = 90;
/** Bare identifiers that ARE values, unlike `Set` — see checkability rule 3. */
const KEYWORD_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "-Infinity"]);
/** What may FOLLOW the literal in an expected result: an annotation, never more
 *  value. Anything else means the split was wrong, so the record is NOTATION. */
const ANNOTATION_OPENERS = ["(", "—", "--", "←", "→", "//", "#"];
/** Free names that only a browser host supplies; their own bucket, so a genuinely
 *  missing export is never mistaken for one of them. */
const HOST_GLOBALS = new Set([
  "document", "window", "navigator", "self", "location", "matchMedia", "getComputedStyle",
  "Image", "ImageData", "OffscreenCanvas", "createImageBitmap", "canvas", "video", "gl", "device",
  "HTMLElement", "HTMLCanvasElement", "Element", "Node", "DOMParser", "customElements",
  "requestAnimationFrame", "ResizeObserver", "CanvasKit", "MathJax",
]);

/**
 * Why a record could not be executed. Every skipped example carries exactly one.
 * PROSE and NON_EXPORTED_SYMBOL are the big two and both are honest facts about
 * the codebase, not runner limitations: a comment-only example asserts nothing,
 * and an example for a module-private helper is unreachable from outside it.
 */
const BUCKETS = {
  PROSE: "comment-only @example — asserts nothing",
  NO_EXPECTATION: "an expression with no stated result",
  NOTATION: "result is display notation, not a JS literal",
  ELLIPSIS: "deliberately abbreviated with ...",
  NON_EXPORTED_SYMBOL: "documents a helper the module does not export",
  EXTERNAL_FIXTURE: "needs a fixture the reader supplies (a registry, an app)",
  HOST_GLOBAL: "needs a browser host global",
  BROWSER_MODULE: "file names a host in its filename",
  ASYNC: "awaits — a hung promise would outlive the gate",
  HOST_MODULE: "the module's file is a declared HOST_BOUND (a Vite-only specifier)",
  SYNTAX: "not parseable as a JS expression (HARD FAIL)",
};

/**
 * Modules that BARE NODE CANNOT PARSE, each with the specifier that stops it.
 * Shrink, never grow — and see below for why the list is only four entries long
 * rather than the eleven the first `web/` sweep produced.
 *
 * TWO DIFFERENT CAUSES, and only one of them belongs here. `web/` is the app
 * shell, so its modules fail to import in bare node for two unrelated reasons, and
 * the codebase's own module headers already name the distinction (see
 * `render_gpu/gpu/pdf_page_vector.js:19` and `render_gpu/gpu/latex_raster.js`'s
 * BARE-NODE SAFETY note — "a Vite-only specifier a bare-node import cannot parse
 * at all"):
 *
 *   A BROWSER GLOBAL read at module scope. `web/projectApi.js:14` does
 *     `new URLSearchParams(location.search)` for the `?backend=` override, and
 *     seven modules inherit it transitively. This is NOT exempted — it is STUBBED,
 *     one line, exactly as tests/project_list_draft_filter_test.js:42-47 already
 *     does it, with that file's reasoning: a test never sets `?backend=`, so
 *     BACKEND resolves to "" precisely as an ordinary same-origin production boot
 *     resolves it. The stub exists so the import does not throw, not to change
 *     behaviour. It buys ~30 examples that would otherwise have been exempted
 *     wholesale, which is the whole argument for preferring a stub to an entry.
 *
 *   A VITE-ONLY SPECIFIER. `?url`, a `.ttf`/`.css` import, `import.meta.glob`.
 *     No stub reaches these: node rejects the specifier before any code runs, so
 *     the module is genuinely unreadable without a bundler. Those are the four
 *     below, and they are the only kind of entry this list may hold.
 *
 * SHAPE follows the house's per-source-file exemption tables — ACCOUNTED
 * (tests/shortcut_sweep_test.js:177, the oldest, 2026-07-27) and the terser
 * ALLOWED (tests/triangulated_paint_ban_test.js:166): keyed by repo-relative
 * source path, every entry carrying a REASON. It is spelled as an array of objects
 * rather than a Map to match QUARANTINE in this same file, which needs the same
 * pinning discipline: `signature` is a stable SUBSTRING of the real import error,
 * so an entry excuses only the failure it recorded and a module that starts
 * failing for a NEW reason is a hard failure rather than something hiding behind
 * an old excuse. A substring and not a prefix because these messages embed
 * absolute paths, which differ per checkout.
 *
 * The polarity is safe, which is what earns a hand-list its place here (the
 * argument is tests/log_elision_singleton_test.js:27-32's): a stale entry makes
 * this suite PRINT and name the file, never pass and hide one. A file NOT listed
 * that fails to import remains a HARD FAILURE, exactly as before.
 */
const HOST_BOUND = [
  {
    file: "web/app.svelte.js",
    signature: "canvaskit.wasm?url",
    why: "reaches render_gpu/skia/browser_canvaskit.js, which imports the wasm binary by Vite `?url`",
  },
  {
    file: "web/gpuService.js",
    signature: "canvaskit.wasm?url",
    why: "the shared offscreen compositor — same `?url` wasm specifier, via browser_canvaskit.js",
  },
  {
    file: "web/renderJobPage.js",
    signature: "canvaskit.wasm?url",
    why: "the render-job worker's page half — same `?url` wasm specifier, via browser_canvaskit.js",
  },
  {
    file: "web/mermaidRenderer.js",
    signature: 'Unknown file extension ".ttf"',
    why: "statically imports a font file, which only a bundler can turn into a module",
  },
];

/** Vite build output: a checked-in copy of third-party bundles, not source we own.
 *  Same constant and same sentence as tests/shortcut_sweep_test.js:97 and
 *  tests/probe_artifact_path_test.js:42, which sweep `web` and skip it for exactly
 *  this reason. 79 built .js files live there; none carries an `@example` today, so
 *  skipping them changes no count — but a bundle that ever did would send this
 *  suite off to `await import()` a minified third-party chunk in bare node. */
const SKIP_PREFIXES = ["web/dist/"];

/**
 * The ONE host global this suite supplies, and the reason it is a stub rather than
 * four more HOST_BOUND entries. See HOST_BOUND's docblock, cause A. Set before the
 * sweep because every module import below is dynamic and therefore later.
 *
 * It THROWS on any property but `search`, which is the only one an import-scope
 * read needs (web/projectApi.js:14). A plain `{search: ""}` would be a lie in the
 * silent direction: `web/githubProject.js:882` reads `location.href` behind a
 * `typeof location !== "undefined"` guard, so a bare object turns a correct
 * fallback into a silent `undefined` — the exact shape the no-silent-fallback rule
 * bans. Bare node genuinely has no page URL; saying so loudly is the honest stub.
 */
globalThis.location = new Proxy({ search: "" }, {
  get(target, key) {
    if (key in target) return target[key];
    throw new Error(`doctest_test stub: bare node has no page URL, so location.${String(key)} does not exist. Guard on the property you need, not on \`typeof location\`, or move the pure part to a module this sweep can import.`);
  },
});

/**
 * Known-false doctests in files owned by other concurrent work. Each excuses ONE
 * observed failure and nothing else; see THE QUARANTINE above. Shrink, never grow.
 *
 * `code` is the expression verbatim (whitespace-collapsed); `observed` is the
 * first PINNED_CHARS of what it really produced, or `THREW <message>`.
 */
const QUARANTINE = [
  {
    file: "core/expressions.js",
    code: 'parseExpression("2 + 3 * x")',
    observed: '{"kind":"bin","op":"+","left":{"kind":"num","value":2},"right":{"kind":"bin","op":"*","left":{"kind":"num","value":3},"r',
    why: "`ref` nodes gained start/end offsets; all three parse examples still show the pre-offset shape",
  },
  {
    file: "core/expressions.js",
    code: 'parseExpression("-(a.x)")',
    observed: '{"kind":"neg","arg":{"kind":"ref","name":"a.x","start":2,"end":5}}',
    why: "`ref` nodes gained start/end offsets",
  },
  {
    file: "core/expressions.js",
    code: 'parseExpression("f(a, b).x")',
    observed: '{"kind":"member","obj":{"kind":"call","name":"f","args":[{"kind":"ref","name":"a","start":2,"end":3},{"kind":"ref","name',
    why: "`ref` nodes gained start/end offsets",
  },
  {
    file: "core/expressions.js",
    code: 'storedToDisplay("self.rotationAnchor.x")',
    observed: "THREW Cannot read properties of undefined (reading 'items')",
    why: "the example omits the state argument the function dereferences",
  },
  {
    file: "core/properties.js",
    code: 'props("x", "y")',
    observed: '[{"key":"x","label":"X","kind":"number","category":"positioning","help":"Horizontal position of the widget\'s top-left co',
    why: "rows gained `help`; the example still lists the pre-help shape",
  },
  {
    file: "plugins/demo/mandelbrot.js",
    code: "cachedOrbit({centerX: 0, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0}).count",
    observed: "1024",
    why: "the reference orbit doubled to 1024 samples; same change as the two mandelbrot_shader entries",
  },
  {
    file: "render_gpu/skia/mandelbrot_shader.js",
    code: "referenceOrbit(0n, 0n, 32, 3)",
    observed: '{"orbit":{"0":0,"1":0,"2":0,"3":0,"4":0,"5":0},"count":3,"escaped":false}',
    why: "the example omits the returned `orbit` array",
  },
  {
    file: "render_gpu/skia/mandelbrot_shader.js",
    code: 'packMandelbrot({cx: 0, cy: 0, halfW: 100, halfH: 100, cornerRadius: 0, angle: 0, centerApproxX: -0.5, centerApproxY: 0, halfWidth: 1, maxIter: 100, refCount: 512, escapeRadius: 256, interiorTest: 1, interiorThreshold: 1e-3, colorAxis: 0, paletteScale: 16, paletteOffset: 0, stripeAmount: 0, stripeDensity: 4, triangleAmount: 0, shadeAmount: 0, lightAngle: 0, lightHeight: 1.5, glowAmount: 0, glowWidth: 1, bandLimit: 1, boundaryAA: 1, interiorColor: "#000000", palette: new Array(96).fill(0), paletteMean: [0, 0, 0], orbit: new Float32Array(1024)}).length',
    observed: 'THREW mandelbrot pack: "orbit" must hold 2048 floats, got 1024',
    why: "the orbit buffer doubled; the example still passes the old 1024-float array",
  },
  {
    file: "render_gpu/skia/sky_clouds_shader.js",
    code: 'packSkyClouds({cx:0,cy:0,halfW:450,halfH:200,cornerRadius:0,angle:0,scale:1, time:0,coverage:0.45,softness:0.28,cloudScale:2.4,speed:1,ambient:"#8fa6c8", base:"#f2efe9",suns:[{sx:0.2,sy:-0.4,color:"#ffddaa",intensity:1}]}).length',
    observed: "43",
    why: "the uniform block is 43 floats, not 44",
  },
  {
    file: "render_gpu/ir.js",
    code: 'parseColor("#0f8")',
    observed: "[0,1,0.5333333333333333,1]",
    why: "the example omits the alpha component the function returns",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PURE: parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure function. One doc-comment line with its decoration removed.
 *
 * The closer is stripped BEFORE the leading star, so a line that is only ` * /`
 * (spelled as a real block end) becomes "" instead of leaking a "/" into the
 * example that precedes it — which is how 20 records were mis-bucketed.
 *
 * @param {string} line - a raw source line inside a doc comment
 * @returns {string} its body
 *
 * @example stripDocLine(" * @example foo() // 1") // "@example foo() // 1"
 * @example stripDocLine("   hello") // "hello"
 */
export function stripDocLine(line) {
  return line.replace(/\s*\*\/\s*$/, "").replace(/^\s*\*[ \t]?/, "");
}

/**
 * Pure function. Splits example text at its first TOP-LEVEL `//`, i.e. the one
 * that is not inside a string or a bracketed group. Top-level matters: the
 * expected result `"16 mm single-perf (1R)"` contains a paren and
 * `parseColor("//x")` could contain the delimiter itself.
 *
 * @param {string} text - one example's text, expression and result together
 * @returns {{code: string, result: string, hasResult: boolean, balanced: boolean}}
 *   `balanced` is false when brackets or a quote are still open, which means the
 *   example continues on the next line.
 *
 * @example splitAtComment("f(1) // 2") // {code: "f(1)", result: "2", hasResult: true, balanced: true}
 * @example splitAtComment('f("a // b")') // {code: 'f("a // b")', result: "", hasResult: false, balanced: true}
 * @example splitAtComment("f({a: 1,").balanced // false
 */
export function splitAtComment(text) {
  let depth = 0;
  let quote = null;
  let i = 0;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) { depth += 1; continue; }
    if (")]}".includes(c)) { depth -= 1; continue; }
    if (c === "/" && text[i + 1] === "/") break;
  }
  const hasResult = i < text.length;
  return { code: text.slice(0, i).trim(), result: hasResult ? text.slice(i + 2).trim() : "", hasResult, balanced: depth === 0 && !quote };
}

/**
 * Pure function. Inclusive [start, end] line indices of every doc comment.
 *
 * A doc comment must OPEN a line, which is the convention everywhere in this
 * codebase and what keeps a `/**` inside a string literal from opening a block.
 *
 * @param {string[]} lines - the source, split on newlines
 * @returns {Array<[number, number]>} 0-based inclusive ranges
 *
 * @example docBlockRanges(["/**", " * hi", " *" + "/", "code"]) // [[0, 2]]
 * @example docBlockRanges(["code"]) // []
 */
export function docBlockRanges(lines) {
  const out = [];
  for (let n = 0; n < lines.length; n += 1) {
    if (!/^\s*\/\*\*/.test(lines[n])) continue;
    let end = n;
    while (end < lines.length && !/\*\//.test(lines[end])) end += 1;
    out.push([n, Math.min(end, lines.length - 1)]);
    n = end;
  }
  return out;
}

/**
 * Pure function. Every `@example` record in a source text.
 *
 * Two joins, both driven by syntax rather than by guessing at prose:
 *   CONTINUATION — while the accumulated text is unbalanced, the example is
 *     mid-literal and the next line belongs to it.
 *   RESULT — when the example line states no `//` result, the following non-blank
 *     lines up to the next tag are the result (the python-doctest shape). A
 *     leading `//` on them is optional; both spellings are checked in.
 *
 * @param {string} src - a whole source file
 * @returns {Array<{line: number, text: string, result: string}>} `line` is 1-based
 *
 * @example examplesInSource("/**\n * @example f(1) // 2\n *" + "/").length // 1
 * @example examplesInSource("/**\n * @example f(1) // 2\n *" + "/")[0].text // "f(1) // 2"
 * @example examplesInSource("// @example f(1) // 2") // []  (not inside a doc comment)
 */
export function examplesInSource(src) {
  const lines = src.split("\n");
  const out = [];
  for (const [blockStart, blockEnd] of docBlockRanges(lines)) {
    for (let n = blockStart; n <= blockEnd; n += 1) {
      // TRIM before matching. stripDocLine removes ONE space after the star, but
      // this codebase also writes ` *  @example` (two spaces, aligning the tag
      // under a `/** Query. …` opener), and without the trim `^@example` failed to
      // anchor on every one of them — 73 records app-wide, 53 of them in trees
      // this suite was already sweeping and reporting green. That is precisely the
      // "parser quietly stops recognising examples and reports a green nothing"
      // failure WHO CHECKS THE CHECKER exists to prevent, and selfCheck missed it
      // because every fixture there is written in the one-space spelling.
      const tag = stripDocLine(lines[n]).trim().match(/^@example\s*(.*)$/);
      if (!tag) continue;
      let text = tag[1];
      let end = n;
      while (!splitAtComment(text).balanced && end < blockEnd) {
        const next = stripDocLine(lines[end + 1]);
        if (/^@/.test(next.trim())) break;
        text += " " + next.trim();
        end += 1;
      }
      const trailing = [];
      if (!splitAtComment(text).hasResult) {
        for (let k = end + 1; k <= blockEnd; k += 1) {
          const body = stripDocLine(lines[k]).trim();
          if (!body || /^@/.test(body)) break;
          trailing.push(body);
          end = k;
        }
      }
      out.push({ line: n + 1, text, result: trailing.join(" ").replace(/^\/\/\s*/, "") });
      n = end;
    }
  }
  return out;
}

/**
 * Pure function. The leading JS LITERAL of an expected-result text, plus the
 * annotation trailing it — or null when the text does not begin with a literal.
 *
 * Rejecting bare identifiers is deliberate and is checkability rule 3: `Set(["a"])`
 * is notation for a Set, and accepting `Set` as the literal would compare a real
 * Set against the CONSTRUCTOR and be capable of reporting a pass.
 *
 * @param {string} text - an expected-result text, annotation and all
 * @returns {{value: string, rest: string}|null}
 *
 * @example leadingLiteral("2 (a circle)") // {value: "2", rest: "(a circle)"}
 * @example leadingLiteral('{x: 1} — moved') // {value: "{x: 1}", rest: "— moved"}
 * @example leadingLiteral('Set(["a"])') // null (notation, not a literal)
 * @example leadingLiteral("new Set([1])").value // "new Set([1])"
 */
export function leadingLiteral(text) {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const start = i;
  const constructed = /^new\s/.test(text.slice(i));
  if (constructed) {
    i += "new".length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
  }
  if (i >= text.length) return null;
  const after = (j) => ({ value: text.slice(start, j), rest: text.slice(j).trim() });

  if (!constructed && "[{\"'`".includes(text[i])) {
    let depth = 0;
    let quote = null;
    let j = i;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (quote) {
        if (c === "\\") { j += 1; continue; }
        if (c === quote) { quote = null; if (!depth) { j += 1; break; } }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if ("([{".includes(c)) depth += 1;
      else if (")]}".includes(c)) { depth -= 1; if (!depth) { j += 1; break; } }
    }
    return after(j);
  }

  let j = i;
  while (j < text.length && /[A-Za-z0-9_$.+\-]/.test(text[j])) j += 1;
  if (constructed) {
    if (text[j] !== "(") return null;
    let depth = 0;
    for (; j < text.length; j += 1) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")") { depth -= 1; if (!depth) { j += 1; break; } }
    }
    return after(j);
  }
  const token = text.slice(i, j);
  if (!KEYWORD_LITERALS.has(token) && !/^[-+]?(\d|\.\d)/.test(token)) return null;
  return after(j);
}

/**
 * Pure function. The absolute tolerance a written number CLAIMS, from how many
 * decimals the author wrote. A doctest saying `0.51` asserts two decimals and
 * nothing finer, so that is what is checked; `2` asserts an exact integer.
 *
 * @param {string} text - the number exactly as written in the doctest
 * @returns {number} half of the last written digit's place, or 0 for an integer
 *
 * @example statedTolerance("0.51") // 0.005
 * @example statedTolerance("2") // 0
 * @example statedTolerance("1e-6") // 5e-7
 */
export function statedTolerance(text) {
  const fraction = String(text).match(/\.(\d+)/);
  const exponent = String(text).match(/[eE]-(\d+)/);
  const decimals = (fraction ? fraction[1].length : 0) + (exponent ? Number(exponent[1]) : 0);
  return decimals ? 0.5 * 10 ** -decimals : 0;
}

/**
 * Pure function. Deep equality, with numbers compared at the precision the
 * doctest states (statedTolerance) or within ULP_SLACK bits, whichever is looser.
 * Key sets must match EXACTLY: an example that lists half an object's keys is not
 * a specification of it, and saying so is most of this suite's value.
 *
 * @param {*} actual - what the expression produced
 * @param {*} expected - what the doctest says it produces
 * @param {number} tolerance - from statedTolerance, applied to every number
 * @returns {boolean}
 *
 * @example valuesEqual({x: 1.004}, {x: 1.0}, 0.005) // true (one decimal claimed)
 * @example valuesEqual({x: 1, y: 2}, {x: 1}, 0) // false (an extra key is a mismatch)
 * @example valuesEqual([1, 2], [1, 2], 0) // true
 * @example valuesEqual(new Set(["a"]), new Set(["a"]), 0) // true
 */
export function valuesEqual(actual, expected, tolerance) {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isNaN(actual) && Number.isNaN(expected)) return true;
    if (actual === expected) return true;
    return Math.abs(actual - expected) <= Math.max(tolerance, ULP_SLACK * Number.EPSILON * Math.max(1, Math.abs(expected)));
  }
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (actual instanceof Set || expected instanceof Set)
    return actual instanceof Set && expected instanceof Set && actual.size === expected.size && [...expected].every((v) => actual.has(v));
  if (actual instanceof Map || expected instanceof Map)
    return actual instanceof Map && expected instanceof Map && actual.size === expected.size
      && [...expected].every(([k, v]) => actual.has(k) && valuesEqual(actual.get(k), v, tolerance));
  if (Array.isArray(actual)) return actual.length === expected.length && actual.every((v, i) => valuesEqual(v, expected[i], tolerance));
  const keysActual = Object.keys(actual).sort();
  const keysExpected = Object.keys(expected).sort();
  if (keysActual.length !== keysExpected.length || keysActual.some((k, i) => k !== keysExpected[i])) return false;
  return keysActual.every((k) => valuesEqual(actual[k], expected[k], tolerance));
}

/**
 * Pure function. A value as a failure line shows it. JSON first because it is the
 * spelling doctests are written in; String() for what JSON drops (undefined,
 * functions, BigInt).
 *
 * @param {*} value - anything an example returned
 * @returns {string}
 *
 * @example display({a: 1}) // '{"a":1}'
 * @example display(undefined) // "undefined"
 */
export function display(value) {
  const json = (() => {
    try { return JSON.stringify(value); }
    catch { return undefined; } // circular or BigInt — String() below is the answer
  })();
  return json === undefined ? String(value) : json;
}

/** Pure function. An expression with its line breaks collapsed, so QUARANTINE can
 *  key on the text of a multi-line example without copying its wrapping.
 *
 *  @param {string} code - an example expression
 *  @returns {string}
 *
 *  @example collapse("f({a: 1,\n  b: 2})") // "f({a: 1, b: 2})"
 */
export function collapse(code) {
  return code.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY / COMMAND: discovery and execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query. Every `.js` file under the searched trees, absolute and sorted. Test
 * directories are excluded because importing a test RUNS it — the first draft of
 * this file booted a dev server and a browser by walking render_gpu/tests/.
 *
 * @param {string} root - the app root
 * @returns {string[]}
 *
 * @example // sourceFiles(appRoot).length // 153 at the time of writing
 */
function sourceFiles(root) {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : walk(path);
    return name.endsWith(".js") ? [path] : [];
  });
  const skipped = (path) => SKIP_PREFIXES.some((prefix) => relative(root, path).startsWith(prefix));
  return SEARCH_DIRS.flatMap((dir) => walk(resolve(root, dir))).filter((path) => !skipped(path)).sort();
}

/**
 * Near-pure function (the SCOPE it returns is not: that proxy reads globalThis on
 * every miss and records the miss into the returned set). evalScope itself takes
 * no input but its argument and allocates fresh objects each call.
 *
 * A scope object for evaluating one example, plus the set that collects every name
 * the example reaches for and does not find.
 *
 * `has: () => true` routes EVERY identifier lookup in a `with` block through
 * `get`, which is what makes free-name detection exact: an object-literal key is
 * not a lookup, so `{x: 1}` never reports `x` as missing the way a regex would.
 * The exports are copied into a plain object first — a module namespace is
 * non-extensible, and a proxy over one may not claim properties it lacks.
 *
 * @param {object} exported - the module namespace's own bindings
 * @returns {{scope: object, missing: Set<string>}}
 *
 * @example // const {scope, missing} = evalScope({f: () => 1});
 * @example // new Function("__s", "with (__s) { return (g()) }")(scope) // missing = Set {"g"}
 */
function evalScope(exported) {
  const missing = new Set();
  const scope = new Proxy({ ...exported }, {
    has: () => true,
    get(target, key) {
      // `with` consults this before treating the object as a scope; undefined
      // means "nothing is unscopable", which is what we want.
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      if (key in globalThis) return globalThis[key];
      missing.add(String(key));
      return undefined;
    },
  });
  return { scope, missing };
}

/**
 * Pure function. Which bucket a free name belongs to, so a genuinely missing
 * export is never filed as a host global or a fixture.
 *
 * @param {string[]} names - the free names an example reached for
 * @param {string} src - the module's own source, searched for a private declaration
 * @returns {string} a BUCKETS key
 *
 * @example bucketForMissing(["document"], "") // "HOST_GLOBAL"
 * @example bucketForMissing(["helper"], "const helper = 1") // "NON_EXPORTED_SYMBOL"
 * @example bucketForMissing(["registry"], "") // "EXTERNAL_FIXTURE"
 */
function bucketForMissing(names, src) {
  if (names.some((n) => HOST_GLOBALS.has(n))) return "HOST_GLOBAL";
  const declared = (n) => new RegExp(`^(export\\s+)?(async\\s+)?(const|let|var|function|class)\\s+${n}\\b`, "m").test(src);
  return names.some(declared) ? "NON_EXPORTED_SYMBOL" : "EXTERNAL_FIXTURE";
}

/**
 * Pure function. Verifies the parser against fixtures, because a runner whose
 * parser silently stopped recognising examples would report a green nothing. This
 * is the answer to "who checks the checker", and it runs before the sweep.
 *
 * @returns {number} how many assertions ran
 */
function selfCheck() {
  const closer = "*" + "/";
  const block = (...body) => ["/**", ...body.map((l) => " * " + l), " " + closer].join("\n");
  let checks = 0;
  const check = (fn) => { fn(); checks += 1; };

  check(() => assert.equal(stripDocLine(" " + closer), ""));
  check(() => assert.equal(stripDocLine(" * @example f() // 1"), "@example f() // 1"));
  check(() => assert.deepEqual(splitAtComment("f(1) // 2"), { code: "f(1)", result: "2", hasResult: true, balanced: true }));
  check(() => assert.equal(splitAtComment('f("a // b")').hasResult, false, "a delimiter inside a string is not a comment"));
  check(() => assert.equal(splitAtComment("f({a: 1,").balanced, false));

  check(() => assert.equal(examplesInSource(block("@example f(1) // 2")).length, 1));
  check(() => assert.equal(examplesInSource(block("@example f(1) // 2"))[0].text, "f(1) // 2"));
  check(() => assert.equal(examplesInSource("// @example f(1) // 2").length, 0, "only doc comments carry examples"));
  check(() => assert.equal(examplesInSource(block("@example f(1)", "2")).at(0).result, "2", "the python-doctest shape"));
  check(() => assert.equal(examplesInSource(block("@example f(1)", "// 2")).at(0).result, "2", "the next-line comment shape"));
  check(() => assert.equal(examplesInSource(block("@example f(1)")).at(0).result, "", "the closer must not leak into a result"));
  // The two-space tag spelling. Its absence here is why 73 records went unseen:
  // every other fixture writes ` * @example`, so the parser was only ever checked
  // against the spelling it could already handle.
  check(() => assert.equal(examplesInSource(["/**", " *  @example f(1) // 2", " " + closer].join("\n")).length, 1, "` *  @example` (two spaces) is still an example"));
  check(() => assert.equal(examplesInSource(["/** Query. One-liner.", " *  @example f(1) // 2 " + closer].join("\n")).at(0).text, "f(1) // 2", "and on a one-line block whose closer trails the example"));
  check(() => assert.equal(examplesInSource(block("@example f({a: 1,", "  b: 2}) // 3")).at(0).text, "f({a: 1, b: 2}) // 3", "unbalanced lines join into ONE example"));
  check(() => assert.equal(splitAtComment(examplesInSource(block("@example f({a: 1,", "  b: 2}) // 3")).at(0).text).result, "3", "and the joined example still states its result"));
  check(() => assert.deepEqual(docBlockRanges(["/**", " * hi", " " + closer, "code"]), [[0, 2]]));
  check(() => assert.deepEqual(docBlockRanges(["code"]), []));

  check(() => assert.equal(leadingLiteral('Set(["a"])'), null, "notation is not a literal"));
  check(() => assert.equal(leadingLiteral("Uint8Array [65]"), null));
  check(() => assert.deepEqual(leadingLiteral("2 (a circle)"), { value: "2", rest: "(a circle)" }));
  check(() => assert.equal(leadingLiteral('"16 mm single-perf (1R)"').rest, "", "a paren inside a string is not an annotation"));
  check(() => assert.equal(leadingLiteral("new Set([1])").value, "new Set([1])"));
  check(() => assert.equal(leadingLiteral("-Infinity").value, "-Infinity"));

  check(() => assert.equal(statedTolerance("0.51"), 0.005));
  check(() => assert.equal(statedTolerance("2"), 0));
  check(() => assert.equal(statedTolerance("1e-6"), 5e-7));
  check(() => assert.equal(display({ a: 1 }), '{"a":1}'));
  check(() => assert.equal(display(undefined), "undefined", "JSON drops it; String does not"));
  check(() => assert.equal(collapse("f({a: 1,\n  b: 2})"), "f({a: 1, b: 2})"));
  check(() => assert.equal(bucketForMissing(["document"], ""), "HOST_GLOBAL"));
  check(() => assert.equal(bucketForMissing(["helper"], "const helper = 1"), "NON_EXPORTED_SYMBOL"));
  check(() => assert.equal(bucketForMissing(["registry"], ""), "EXTERNAL_FIXTURE"));
  check(() => assert.ok(valuesEqual(0.001 / 1000, 0.000001, statedTolerance("0.000001")), "mathematically equal, not bit-equal"));
  check(() => assert.equal(valuesEqual({ x: 1, y: 2 }, { x: 1 }, 0), false, "an extra key is a mismatch"));
  check(() => assert.equal(valuesEqual([1], [1, 2], 0), false));
  check(() => assert.ok(valuesEqual(new Set(["a"]), new Set(["a"]), 0)));

  check(() => {
    const { scope, missing } = evalScope({ f: () => 1 });
    assert.equal(new Function("__s", "with (__s) { return (f()) }")(scope), 1);
    assert.equal(missing.size, 0, "an export resolves");
  });
  check(() => {
    const { scope, missing } = evalScope({});
    new Function("__s", "with (__s) { return ({x: 1}) }")(scope);
    assert.equal(missing.size, 0, "an object-literal key is not a free name");
  });
  check(() => {
    const { scope, missing } = evalScope({});
    new Function("__s", "with (__s) { return (nope) }")(scope);
    assert.deepEqual([...missing], ["nope"]);
  });
  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SWEEP
// ─────────────────────────────────────────────────────────────────────────────

const verbose = process.argv.includes("--verbose");
const selfChecks = selfCheck();

const skipped = new Map(Object.keys(BUCKETS).map((k) => [k, []]));
const skip = (bucket, note) => skipped.get(bucket).push(note);
const failures = [];
const quarantined = [];
const quarantineHits = new Set();
const hostBoundHits = new Set();
let executed = 0;
/** Records in a module that would not import: neither executed nor skipped, so the
 *  headline must name them separately rather than lose them out of the total. */
let unreachable = 0;

for (const file of sourceFiles(appRoot)) {
  const shortPath = relative(appRoot, file);
  const src = readFileSync(file, "utf8");
  const records = examplesInSource(src);
  if (!records.length) continue;
  if (BROWSER_ONLY_FILE.test(basename(file))) {
    for (const r of records) skip("BROWSER_MODULE", `${shortPath}:${r.line}`);
    continue;
  }
  // An unimportable file is a HARD FAILURE, never a skip. Every file in these
  // trees that does not name a host imports clean in bare node today, so failing
  // to is a real regression — and this suite found one within minutes of its
  // introduction (a backtick inside a shader comment closed the template literal
  // it lived in). Reported ONCE per file, then the sweep carries on, because one
  // broken module must not hide the rest of the audit. Importing eagerly rather
  // than on first need is what makes "these trees run in bare node" a gate.
  //
  // The ONE exception is a declared HOST_BOUND file, and it is still not a catch-
  // and-shrug: the entry must have PINNED the specifier that stops node, so a
  // listed module failing for any OTHER reason is a hard failure like everything
  // else. A listed module that imports FINE is stale and gets printed.
  const listed = HOST_BOUND.find((h) => h.file === shortPath);
  let exported = null;
  try { exported = { ...(await import(pathToFileURL(file).href)) }; }
  catch (e) {
    const message = e.message.split("\n")[0];
    if (listed && message.includes(listed.signature)) {
      hostBoundHits.add(listed);
      for (const r of records) skip("HOST_MODULE", `${shortPath}:${r.line} needs a bundler: ${listed.why}`);
      continue;
    }
    unreachable += records.length;
    const note = listed
      ? `HOST_BOUND FOR A DIFFERENT REASON — pinned "${listed.signature}", got: `
      : "MODULE WILL NOT IMPORT in bare node. If a Vite-only specifier is the cause, add it to HOST_BOUND above WITH ITS REASON; anything else is a real breakage: ";
    failures.push({ at: shortPath, code: `${records.length} example(s) unreachable`, why: note + message });
    continue;
  }

  for (const record of records) {
    const at = `${shortPath}:${record.line}`;
    const { code, result, hasResult, balanced } = splitAtComment(record.text);
    if (!balanced) { skip("SYNTAX", `${at} unterminated: ${collapse(record.text).slice(0, NOTE_CHARS)}`); continue; }
    if (!code) { skip("PROSE", at); continue; }
    const stated = hasResult ? result : record.result;
    if (!stated) { skip("NO_EXPECTATION", `${at} ${collapse(code).slice(0, NOTE_CHARS)}`); continue; }
    if (/\bawait\b/.test(code)) { skip("ASYNC", `${at} ${collapse(code).slice(0, NOTE_CHARS)}`); continue; }
    if (/\.\.\.(\s*[),}\]]|\s*$)/.test(code) || /…/.test(code + stated) || /\.\.\./.test(stated)) { skip("ELLIPSIS", at); continue; }

    const literal = leadingLiteral(stated);
    if (!literal) { skip("NOTATION", `${at} // ${stated.slice(0, NOTE_CHARS)}`); continue; }
    if (literal.rest && !ANNOTATION_OPENERS.some((o) => literal.rest.startsWith(o))) { skip("NOTATION", `${at} // ${stated.slice(0, NOTE_CHARS)}`); continue; }
    let expected;
    try { expected = new Function(`return (${literal.value})`)(); }
    catch (e) { skip("NOTATION", `${at} // ${literal.value.slice(0, NOTE_CHARS)} — ${e.message.slice(0, 60)}`); continue; }

    const { scope, missing } = evalScope(exported);
    let run;
    try { run = new Function("__s", `with (__s) { return (${code}); }`); }
    catch (e) { skip("SYNTAX", `${at} ${e.message.slice(0, 60)} :: ${collapse(code).slice(0, NOTE_CHARS)}`); continue; }

    let actual;
    let thrown = null;
    try { actual = run(scope); }
    catch (e) { thrown = e; }
    if (missing.size) { skip(bucketForMissing([...missing], src), `${at} [${[...missing].join(",")}] ${collapse(code).slice(0, NOTE_CHARS)}`); continue; }
    if (actual instanceof Promise) { skip("ASYNC", `${at} ${collapse(code).slice(0, NOTE_CHARS)}`); continue; }

    executed += 1;
    const observed = (thrown ? `THREW ${thrown.message}` : display(actual)).slice(0, PINNED_CHARS);
    const passed = !thrown && valuesEqual(actual, expected, statedTolerance(literal.value));
    if (passed) continue;

    const entry = QUARANTINE.find((q) => q.file === shortPath && q.code === collapse(code));
    const why = thrown ? `THREW ${thrown.message.slice(0, SHOWN_CHARS)}`
      : `want ${display(expected).slice(0, SHOWN_CHARS)}\n     got  ${display(actual).slice(0, SHOWN_CHARS)}`;
    if (!entry) { failures.push({ at, code: collapse(code), why }); continue; }
    quarantineHits.add(entry);
    if (entry.observed === observed) quarantined.push({ at, code: collapse(code), why: entry.why });
    else failures.push({ at, code: collapse(code), why: `QUARANTINED FOR A DIFFERENT FAILURE — pinned:\n     ${entry.observed}\n     now: ${observed}` });
  }
}

const stale = QUARANTINE.filter((q) => !quarantineHits.has(q));
/** A HOST_BOUND entry that excused nothing: the module now imports in bare node, or
 *  it no longer carries examples to excuse. Like a stale quarantine this can only
 *  ever conceal a FIX, so it prints loudly and does not fail the run. */
const staleHostBound = HOST_BOUND.filter((h) => !hostBoundHits.has(h));
const totalSkipped = [...skipped.values()].reduce((n, list) => n + list.length, 0);
const totalRecords = executed + totalSkipped + unreachable;

console.log(`\n${"=".repeat(78)}`);
console.log(`DOCTESTS   ${totalRecords} records   ${executed} executed   ${totalSkipped} skipped   ${failures.length} failed${unreachable ? `   ${unreachable} unreachable (module will not import)` : ""}`);
console.log(`           parser self-checks: ${selfChecks}   quarantined: ${quarantined.length}   stale quarantine: ${stale.length}   stale host-bound: ${staleHostBound.length}`);
console.log("=".repeat(78));
console.log("\nSKIPPED, by declared bucket (nothing is dropped silently):");
for (const [bucket, list] of [...skipped].sort((a, b) => b[1].length - a[1].length)) {
  if (!list.length) continue;
  console.log(`  ${String(list.length).padStart(4)}  ${bucket.padEnd(20)} ${BUCKETS[bucket]}`);
  if (verbose) for (const note of list) console.log(`          ${note}`);
}
if (!verbose) console.log("        (--verbose lists every one of them)");

if (quarantined.length) {
  console.log(`\nQUARANTINED (${quarantined.length}) — known false, owned elsewhere, each pinned to its observed value:`);
  for (const q of quarantined) console.log(`  ${q.at}\n     ${q.code.slice(0, 140)}\n     ${q.why}`);
}
if (stale.length) {
  console.log(`\nSTALE QUARANTINE (${stale.length}) — these now pass or no longer exist. REMOVE THEM:`);
  for (const q of stale) console.log(`  ${q.file}  ${q.code.slice(0, 120)}`);
}
if (staleHostBound.length) {
  console.log(`\nSTALE HOST_BOUND (${staleHostBound.length}) — these import in bare node now, or have no examples left. REMOVE THEM:`);
  for (const h of staleHostBound) console.log(`  ${h.file}  pinned "${h.signature}"`);
}
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.log(`  ${f.at}\n     ${f.code.slice(0, 180)}\n     ${f.why}`);
}

const belowFloor = executed < MIN_EXECUTED;
if (belowFloor)
  console.log(`\nCOVERAGE FLOOR: only ${executed} examples ran, below MIN_EXECUTED=${MIN_EXECUTED}. Either coverage dropped or the parser stopped recognising examples — a green run at this count would prove nothing.`);
const syntaxBroken = skipped.get("SYNTAX").length;
if (syntaxBroken) console.log(`\nUNPARSEABLE (${syntaxBroken}): an @example that is not valid JS cannot specify anything. Fix or delete it.`);

if (failures.length || belowFloor || syntaxBroken) process.exit(1);
console.log(`\n${executed} doctests executed, all agree with the code.`);
