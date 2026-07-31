/**
 * GITHUB FIXTURE probe — the whole assembly path in a real browser, NO NETWORK.
 *
 * WHY THIS EXISTS SEPARATELY FROM github_live_probe.js. That one proves the demo
 * repo really loads from the real GitHub, which is the claim that matters — but
 * it must SKIP when the machine is offline or rate-limited, because the gate
 * cannot depend on GitHub's uptime. A suite that only skips is a suite that
 * proves nothing on a bad day. So this probe covers the same code with GitHub
 * REPLACED by a local fixture server, and therefore never skips: it is the half
 * that must pass on an airplane.
 *
 * WHAT IS ACTUALLY BROWSER-ONLY HERE, as opposed to node-testable:
 *   • `atob` and `btoa`. The node test injects Buffer-based twins, so the REAL
 *     decoders are only exercised here — and base64 is exactly where an encoding
 *     bug produces plausible-looking wrong bytes rather than a crash.
 *   • `fetch` + the streaming `ReadableStream` reader that produces byte
 *     progress. The node test cannot reach that loop at all.
 *   • The >1 MB DOWNLOAD FALLBACK end to end: a real fetch of a real
 *     `download_url`, reassembled from real stream chunks, compared BYTE FOR BYTE
 *     against what was served. This is the defect the whole module exists to
 *     prevent (a 200 OK with empty content silently importing a zero-byte video),
 *     and this is the only place it is proven against a live streaming decoder.
 *
 * THE FIXTURE SERVER speaks the shape of GitHub's contents API — recorded from
 * the real one, so the fork under test is the fork that exists in production —
 * and serves an OVER-1 MB asset so the download path is taken for real.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/github_fixture_probe.js [shot_dir]
 */
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const INLINE_LIMIT = 1024 * 1024;

// A DELIBERATELY OVER-LIMIT asset, so the download fallback is exercised rather
// than described. Its bytes are a fixed pseudo-random pattern (not all zeros):
// a zero-filled buffer would compare equal to the empty-content bug's output for
// every byte it happened to reach, which is precisely the failure being hunted.
const BIG_ASSET_SIZE = INLINE_LIMIT + 4096;
const bigAsset = Buffer.alloc(BIG_ASSET_SIZE);
for (let i = 0; i < BIG_ASSET_SIZE; i++) bigAsset[i] = (i * 31 + 7) & 0xff;

const SMALL_ASSET = Buffer.from("PNGDATA-small-asset", "utf8");

const FIXTURE_DOC = {
  meta: { name: "FixtureDeck", slideW: 1280, slideH: 720, script: "" },
  slides: [{ id: "s1", name: "One", delta: { items: { v: { type: "video", src: "big.bin" } } } }],
};
const docBytes = Buffer.from(JSON.stringify(FIXTURE_DOC, null, 2), "utf8");

const checks = [];
const errors = [];
const ok = (cond, label) => {
  checks.push([!!cond, label]);
  if (!cond) errors.push(`CHECK FAILED: ${label}`);
};

// ── the fake GitHub ──────────────────────────────────────────────────────────
// Mirrors the recorded shape: a directory is an ARRAY; a file is an OBJECT that
// inlines base64 under the limit and reports `encoding: "none"` with EMPTY
// content above it.
//
// SERVED SAME-ORIGIN, as Vite middleware, rather than from a second HTTP server
// on its own port. Measured the other way first and it fails for a reason that
// has nothing to do with this module: Chrome's PRIVATE NETWORK ACCESS rules
// block a page on 127.0.0.1:A from fetching 127.0.0.1:B, so every request died
// as an opaque "Failed to fetch" — indistinguishable from the offline case, and
// a fixture that cannot be reached tests nothing. Mounting the fixture under the
// app's own origin sidesteps the browser rule entirely and keeps the probe to
// ONE server.
const FIXTURE_PREFIX = "/__github_fixture";
let rawRequests = 0;
const fixtureMiddleware = (req, res, next) => {
  if (!req.url.startsWith(FIXTURE_PREFIX)) return next();
  const url = new URL(req.url.slice(FIXTURE_PREFIX.length) || "/", "http://127.0.0.1");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };
  const base = FIXTURE_PREFIX;
  const fileObject = (name, path, bytes) => {
    const over = bytes.length > INLINE_LIMIT;
    return {
      name,
      path,
      type: "file",
      size: bytes.length,
      sha: "0".repeat(40),
      download_url: `${base}/raw/${path}`,
      // THE CLIFF, reproduced exactly: over the limit GitHub answers 200 with
      // encoding "none" and an empty content string.
      encoding: over ? "none" : "base64",
      content: over ? "" : bytes.toString("base64"),
    };
  };
  const p = decodeURIComponent(url.pathname);

  if (p.startsWith("/raw/")) {
    rawRequests++;
    const which = p.slice("/raw/".length);
    const bytes = which === "assets/big.bin" ? bigAsset : which === "assets/small.png" ? SMALL_ASSET : docBytes;
    // Content-Length is REAL here, because the byte-progress assertions below
    // check a true fraction rather than a synthetic one.
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
    res.end(bytes);
    return;
  }
  if (p === "/repos/fix/deck/contents/") {
    return send(200, JSON.stringify([
      { name: "README.md", path: "README.md", type: "file", size: 5, download_url: `${base}/raw/README.md` },
      { name: "assets", path: "assets", type: "dir", size: 0, download_url: null },
      { name: "doc.json", path: "doc.json", type: "file", size: docBytes.length, download_url: `${base}/raw/doc.json` },
    ]));
  }
  if (p === "/repos/fix/deck/contents/doc.json") return send(200, JSON.stringify(fileObject("doc.json", "doc.json", docBytes)));
  if (p === "/repos/fix/deck/contents/assets") {
    return send(200, JSON.stringify([
      { name: "big.bin", path: "assets/big.bin", type: "file", size: bigAsset.length, download_url: `${base}/raw/assets/big.bin` },
      { name: "small.png", path: "assets/small.png", type: "file", size: SMALL_ASSET.length, download_url: `${base}/raw/assets/small.png` },
      { name: ".thumbs", path: "assets/.thumbs", type: "dir", size: 0, download_url: null },
    ]));
  }
  if (p === "/repos/fix/deck/contents/assets/small.png") return send(200, JSON.stringify(fileObject("small.png", "assets/small.png", SMALL_ASSET)));
  if (p === "/repos/fix/deck/contents/assets/big.bin") return send(200, JSON.stringify(fileObject("big.bin", "assets/big.bin", bigAsset)));

  // The RATE LIMIT, reproduced: a 403 whose body is about rate limits.
  if (p === "/repos/rate/limited/contents/") {
    res.writeHead(403, {
      "Content-Type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 900),
    });
    res.end(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }));
    return;
  }
  // A repo with NO doc.json anywhere — the loud-refusal case.
  if (p === "/repos/empty/repo/contents/") {
    return send(200, JSON.stringify([{ name: "README.md", path: "README.md", type: "file", size: 5, download_url: `${base}/raw/README.md` }]));
  }
  send(404, JSON.stringify({ message: "Not Found" }));
};

// ── the app, only as a module host ───────────────────────────────────────────
// HMR off: many agents edit this tree concurrently, and a stray reload mid-probe
// drops the page for reasons unrelated to what is under test.
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
  // The fixture mounts as ordinary middleware on the app's own origin. The hook
  // body is a BLOCK on purpose: an arrow returning `use()`'s value hands Vite a
  // connect app where it expects a post-hook function, and it crashes on boot.
  plugins: [
    {
      name: "github-fixture",
      configureServer(s) {
        s.middlewares.use(fixtureMiddleware);
      },
    },
  ],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async (apiPrefix, expectedSize) => {
    // The module under test, loaded from the real app bundle. GITHUB_API is a
    // module constant, so the fixture is aimed at by rewriting `fetch` for that
    // one origin — the MODULE ITSELF IS UNTOUCHED, which is the point: what runs
    // here is exactly what ships. `apiPrefix` is a same-origin PATH, so the
    // rewritten URL resolves against this page and never leaves it.
    const mod = await import("/githubProject.js");
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const href = typeof input === "string" ? input : input.url;
      return realFetch(href.startsWith(mod.GITHUB_API) ? apiPrefix + href.slice(mod.GITHUB_API.length) : href, init);
    };

    const out = { progress: [] };
    try {
      const project = await mod.fetchProjectFromRepo("fix/deck", {
        onProgress: (p) => out.progress.push({ stage: p.stage, loaded: p.loaded ?? 0, total: p.total ?? 0 }),
      });
      out.docName = project.doc?.meta?.name;
      out.assetNames = project.assets.map((a) => a.name);
      const big = project.assets.find((a) => a.name === "big.bin");
      out.bigLength = big ? big.byteLength ?? big.bytes.byteLength : -1;
      // BYTE-FOR-BYTE, not just length: the pattern is regenerated here and every
      // byte compared, so a truncated or mis-decoded stream cannot pass.
      out.bigBytesCorrect = !!big && (() => {
        const b = big.bytes;
        if (b.byteLength !== expectedSize) return false;
        for (let i = 0; i < b.byteLength; i++) if (b[i] !== ((i * 31 + 7) & 0xff)) return false;
        return true;
      })();
      const small = project.assets.find((a) => a.name === "small.png");
      out.smallText = small ? new TextDecoder().decode(small.bytes) : null;
    } catch (e) {
      out.loadError = String(e?.message ?? e);
    }

    // The rate limit must arrive as its OWN sentence, not a generic failure.
    try {
      await mod.fetchProjectFromRepo("rate/limited");
      out.rateLimitError = "(no error thrown)";
    } catch (e) {
      out.rateLimitError = String(e?.message ?? e);
    }
    // A repo with no doc.json must refuse LOUDLY and say where we looked.
    try {
      await mod.fetchProjectFromRepo("empty/repo");
      out.emptyError = "(no error thrown)";
    } catch (e) {
      out.emptyError = String(e?.message ?? e);
    }
    // Real atob/btoa, which the node test can only stub.
    out.b64RoundTrip = (() => {
      const bytes = new Uint8Array([0, 1, 254, 255, 65, 66]);
      const back = mod.decodedFileContent({ encoding: "base64", content: mod.base64FromBytes(bytes) });
      return Array.from(back).join(",") === Array.from(bytes).join(",");
    })();
    // A token must not survive into any message, in the browser too.
    out.redactionHolds = !mod.redacted("boom ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789").includes("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    return out;
  }, FIXTURE_PREFIX, BIG_ASSET_SIZE);

  ok(!result.loadError, `the fixture repo loads without error (${result.loadError ?? "none"})`);
  ok(result.docName === "FixtureDeck", `doc.json parsed — meta.name is FixtureDeck (got ${result.docName})`);
  // `.thumbs/` is a cache, not content: it must not arrive as an asset.
  ok(
    JSON.stringify(result.assetNames) === JSON.stringify(["big.bin", "small.png"]),
    `assets are the two FILES, caches excluded (got ${JSON.stringify(result.assetNames)})`,
  );
  ok(result.bigLength === BIG_ASSET_SIZE, `the >1MB asset arrived at full length ${BIG_ASSET_SIZE} (got ${result.bigLength})`);
  // THE DEFECT, proven absent: had the module read the empty `content`, this
  // would be 0 bytes and every byte comparison would fail.
  ok(result.bigBytesCorrect === true, "the >1MB asset is byte-for-byte correct (NOT the silent zero-byte import)");
  ok(rawRequests > 0, `the download_url fallback was actually used (${rawRequests} raw requests)`);
  ok(result.smallText === SMALL_ASSET.toString("utf8"), `the small asset decoded inline via real atob (got ${JSON.stringify(result.smallText)})`);
  ok(result.b64RoundTrip === true, "base64 round-trips through the browser's real atob/btoa, including high bytes");

  const progressed = result.progress.filter((p) => p.stage === "assets" && p.total > 0);
  ok(progressed.length > 0, "byte progress was reported for assets with a real total");
  ok(
    progressed.some((p) => p.loaded > 0 && p.loaded <= p.total),
    "progress is REAL bytes within the known total, never a synthetic percentage",
  );

  ok(/rate limit/i.test(result.rateLimitError ?? ""), `a 403 rate limit says so plainly (got ${JSON.stringify(result.rateLimitError)})`);
  ok(
    /60 per hour/.test(result.rateLimitError ?? "") && !/^failed/i.test(result.rateLimitError ?? ""),
    "…names the real limit and does not call it a plain failure",
  );
  ok(/No doc\.json found/i.test(result.emptyError ?? ""), `a repo with no doc.json refuses loudly (got ${JSON.stringify(result.emptyError)})`);
  ok(result.redactionHolds === true, "a token cannot survive redacted() in the browser either");
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) {
  console.log(errors.join("\n"));
  process.exit(1);
}
