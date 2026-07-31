/**
 * GITHUB LIVE probe — the DEMO REPO really loads, from the real GitHub, in a
 * real browser.
 *
 * WHY A NETWORK PROBE AT ALL, when github_fixture_probe.js covers the same code
 * offline: the fixture proves we handle the API SHAPE WE RECORDED. It cannot
 * prove that shape is still true, that GitHub still sends CORS `*` to a browser
 * on another origin, or that the published demo repo is actually loadable by the
 * link printed in the README. Those are claims about the WORLD, and only a live
 * request can check them. The fixture is the regression test; this is the
 * integration test.
 *
 * IT SKIPS, LOUDLY, RATHER THAN FAILING. The gate must not depend on GitHub's
 * uptime, this machine's connectivity, or the 60-requests/hour anonymous rate
 * limit — a red gate that means "the office IP is busy" trains people to ignore
 * red gates. So an unreachable or rate-limited GitHub prints a SKIP line saying
 * WHICH condition was hit and exits 0. Anything else — a 404 on the demo repo, a
 * malformed document, a short video — is a REAL failure and exits 1.
 *
 * The distinction is drawn from the response, not from a guess: reachability is
 * probed first with one cheap request, and only the two known-benign conditions
 * (no network, rate limited) are skippable.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/github_live_probe.js
 */
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

/** The published demo — the same repo the README's worked example names. If this
 *  string and the README ever disagree, one of them is lying to a reader. */
const DEMO_REPO = "RyannDaGreat/PowerRP-RobotSim-Demo";

/** What the demo is known to contain. Asserted rather than discovered, so that a
 *  repo that loads but has been emptied still fails. */
const EXPECTED_ASSET = "Video_20260726_224007_045.mp4";
const EXPECTED_ASSET_BYTES = 1229177; // over the 1 MB inline limit, on purpose
const EXPECTED_DOC_NAME = "RobotSim";

/** THE STANDING BRANCH FIXTURE — user ruling: "it should support branches too."
 *
 *  `parseRepoSlug` has always PARSED `@ref`, and `repoContents` has always put it
 *  in the query string. Neither fact proves a non-default branch actually loads:
 *  a dropped ref, a query string GitHub ignores, or a default-branch fallback
 *  would all look exactly like success against a repo with one branch. So the
 *  demo repo carries a second branch that differs from `main` BY ONE FIELD —
 *  doc.json's `meta.name` — and loading it must yield that name and not the
 *  default one. The difference is deliberately minimal: anything larger could
 *  pass for a different reason.
 *
 *  DO NOT DELETE THE BRANCH. It is a fixture, not a work in progress; the branch
 *  IS the assertion, and without it this check silently reduces to a rerun of the
 *  default-branch load above. It was created with the doc's own history intact
 *  (branched from main, one commit) so it stays trivially re-derivable. */
const FIXTURE_BRANCH = "branch-fixture";
const FIXTURE_DOC_NAME = "RobotSim (branch-fixture)";

/** Exit 0 with a REASON. A silent skip is indistinguishable from a pass, which
 *  is the failure mode that makes people stop trusting a suite. */
function skip(reason) {
  console.log(`SKIP — ${reason}`);
  console.log("SKIPPED: this probe needs the public internet and GitHub's anonymous API. Not a failure.");
  process.exit(0);
}

// ── is GitHub reachable at all? one cheap request, before any browser ────────
let preflight;
try {
  preflight = await fetch(`https://api.github.com/repos/${DEMO_REPO}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
} catch (e) {
  skip(`cannot reach api.github.com (${e?.message ?? e}) — offline?`);
}
if (preflight.status === 403 && (preflight.headers.get("x-ratelimit-remaining") === "0" || preflight.status === 429)) {
  const reset = Number(preflight.headers.get("x-ratelimit-reset") ?? 0);
  skip(`GitHub's anonymous rate limit (60/hour/IP) is used up${reset ? `; it resets at ${new Date(reset * 1000).toLocaleTimeString()}` : ""}`);
}
if (preflight.status === 429) skip("GitHub returned 429 Too Many Requests");
if (preflight.status >= 500) skip(`GitHub is returning ${preflight.status} — a server-side outage, not our bug`);
// A 404 here is NOT skippable: the README points people at this repo, so its
// absence is exactly the failure this probe exists to catch.
if (!preflight.ok) {
  console.log(`FAIL — the demo repo ${DEMO_REPO} answered ${preflight.status}. The README links it, so it must exist and be public.`);
  process.exit(1);
}
const remaining = Number(preflight.headers.get("x-ratelimit-remaining") ?? "60");
// The default-branch load makes ~4 more calls and the branch-fixture load ~4
// again (it re-walks the same layout at a different ref). Skipping now beats
// failing halfway through either.
if (remaining < 10) skip(`only ${remaining} anonymous GitHub requests left this hour — not enough to load the demo at two refs`);

const checks = [];
const errors = [];
const ok = (cond, label) => {
  checks.push([!!cond, label]);
  if (!cond) errors.push(`CHECK FAILED: ${label}`);
};

// HMR off: concurrent edits in this tree must not reload the page mid-probe.
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // NOTHING IS STUBBED HERE. This is the real module making real cross-origin
  // requests from a real page — which is also what proves GitHub's CORS headers
  // still permit the static site to do this with no server and no proxy.
  const result = await page.evaluate(async (repo) => {
    const mod = await import("/githubProject.js");
    const out = { progress: [] };
    try {
      const project = await mod.fetchProjectFromRepo(repo, {
        onProgress: (p) => out.progress.push({ stage: p.stage, loaded: p.loaded ?? 0, total: p.total ?? 0 }),
      });
      out.docName = project.doc?.meta?.name;
      out.slideCount = Array.isArray(project.doc?.slides) ? project.doc.slides.length : -1;
      out.assets = project.assets.map((a) => ({ name: a.name, bytes: a.bytes.byteLength }));
      // The published doc must be RELATIVE-ref: an absolute "/asset/<project>/…"
      // names a project the visitor's browser has never heard of, which is the
      // exact bug that made a shared RobotSim render no video.
      out.docText = JSON.stringify(project.doc);
    } catch (e) {
      out.error = String(e?.message ?? e);
    }
    return out;
  }, DEMO_REPO);

  if (result.error && /rate limit/i.test(result.error)) skip(`ran into the rate limit mid-load: ${result.error}`);

  ok(!result.error, `the demo repo loads from the real GitHub API (${result.error ?? "no error"})`);
  ok(result.docName === EXPECTED_DOC_NAME, `doc.json is the ${EXPECTED_DOC_NAME} deck (got ${result.docName})`);
  ok(result.slideCount > 0, `the document has slides (got ${result.slideCount})`);

  const asset = (result.assets ?? []).find((a) => a.name === EXPECTED_ASSET);
  ok(!!asset, `the video asset ${EXPECTED_ASSET} came down (got ${JSON.stringify(result.assets)})`);
  // THE POINT OF USING THIS DEMO: the video is over GitHub's 1 MB inline limit,
  // so a full-length arrival proves the download_url fallback works against the
  // REAL raw.githubusercontent.com, CORS and all — not just against a fixture.
  ok(
    asset?.bytes === EXPECTED_ASSET_BYTES,
    `…at its full ${EXPECTED_ASSET_BYTES} bytes, proving the >1MB fallback works live (got ${asset?.bytes})`,
  );

  ok(
    typeof result.docText === "string" && !result.docText.includes("/asset/"),
    "the published document uses RELATIVE asset refs, so it opens in a browser that never had this project",
  );
  ok(
    typeof result.docText === "string" && result.docText.includes(EXPECTED_ASSET),
    "…and those refs name the asset that shipped beside it",
  );

  const assetProgress = (result.progress ?? []).filter((p) => p.stage === "assets" && p.total > 0);
  ok(assetProgress.length > 0, "real byte progress was reported while downloading");

  // ── @ref REALLY REACHES GITHUB (user ruling: "it should support branches too")
  // The SAME call, one `@branch` longer, must come back with the branch's
  // document. This is the check that cannot be faked by a parser: if the ref were
  // dropped anywhere between parseRepoSlug and the query string, GitHub would
  // serve `main` and the name below would be the default one.
  const branch = await page.evaluate(async (slug) => {
    const mod = await import("/githubProject.js");
    try {
      const project = await mod.fetchProjectFromRepo(slug);
      return { docName: project.doc?.meta?.name, ref: project.target?.ref, slides: project.doc?.slides?.length ?? -1 };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }, `${DEMO_REPO}@${FIXTURE_BRANCH}`);

  if (branch.error && /rate limit/i.test(branch.error)) skip(`ran into the rate limit loading the branch fixture: ${branch.error}`);
  ok(!branch.error, `owner/name@${FIXTURE_BRANCH} loads live (${branch.error ?? "no error"})`);
  ok(branch.ref === FIXTURE_BRANCH, `…and the parsed ref survived to the request (got ${JSON.stringify(branch.ref)})`);
  ok(
    branch.docName === FIXTURE_DOC_NAME,
    `…and GitHub served THE BRANCH'S doc.json, not the default branch's: expected ${JSON.stringify(FIXTURE_DOC_NAME)}, got ${JSON.stringify(branch.docName)}`,
  );
  // The negative half, stated separately so a failure says WHICH way it broke:
  // getting `main`'s name back means the ref was silently ignored.
  ok(branch.docName !== EXPECTED_DOC_NAME, `…and specifically NOT ${JSON.stringify(EXPECTED_DOC_NAME)}, which is what a dropped @ref would return`);
  ok(branch.slides > 0, `…and it is a real deck, not an empty shell (got ${branch.slides} slides)`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${DEMO_REPO} (live).`);
if (failed.length) {
  console.log(errors.join("\n"));
  process.exit(1);
}
