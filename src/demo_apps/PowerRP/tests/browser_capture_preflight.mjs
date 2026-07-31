/**
 * BROWSER-CAPTURE PREFLIGHT — is `page.screenshot` usable on THIS HOST AT ALL?
 *
 * WHY THIS FILE EXISTS. A triage sweep spent hours attributing 22 browser-lane
 * reds to PowerRP before measuring the host. The measurement, once taken, was
 * unambiguous: `page.screenshot()` on a page containing nothing but
 * `<h1 style="background:#c00">` — no canvas, no WebGL, no PowerRP, no Vite —
 * HANGS FOREVER. It hangs under the probes' SwiftShader flags, under
 * `--no-sandbox` alone, and under Chrome's bare defaults; the same connection
 * answers `page.evaluate`, `page.$`, `elementHandle.evaluate` and
 * `boundingBox` in ~1 ms each, before AND after the hang. So the fault is
 * Chrome's capture path on this machine, and nothing about the code under test.
 *
 * WHAT THAT DID TO THE GATE. 64 of 166 browser probes call `page.screenshot`.
 * Every one of them dies on a `Page.captureScreenshot timed out` ProtocolError
 * with a puppeteer stack and no assertion text — which reads exactly like a
 * PowerRP regression and is not one. Worse, the failure is EXPENSIVE: each
 * probe burns its full protocolTimeout (180 s by default) before dying, which
 * is why a browser lane that should take minutes took hours.
 *
 * THE RULE THIS ENCODES. An unavailable PREREQUISITE must announce itself as a
 * prerequisite, once, in one sentence — never as N failing tests. `run_all.mjs`
 * already applies that rule to the project backend ("an unavailable prerequisite
 * must not masquerade as 93 failing probes"); capture is the same kind of
 * dependency and had no such check.
 *
 * WHAT IT DOES NOT DO. It does not fix, work around, or silence anything, and it
 * does not skip a single probe. It reports. A green run here means the browser
 * lane's screenshot reds are worth reading as defects; a red run means they are
 * not, and says so in one line instead of leaving it to be rediscovered.
 *
 * Exit code: 0 if capture works, 1 if it hangs or errors. Run:
 *   node src/demo_apps/PowerRP/tests/browser_capture_preflight.mjs
 */

/** One capture must finish inside this. Generous on purpose: a loaded machine
 *  can be slow, and this check must accuse the host only when capture is truly
 *  broken, not merely busy. A working host answers in tens of milliseconds. */
const CAPTURE_BUDGET_MS = 20_000;

/** The simplest page that still produces pixels: no canvas, no WebGL, no fonts,
 *  no network. If THIS cannot be captured, nothing can, and the cause is not the
 *  application. */
const TRIVIAL_PAGE = "<h1 style='background:#c00;width:200px;height:200px;margin:0'>preflight</h1>";

const { default: puppeteer } = await import("puppeteer");

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox"],
  protocolTimeout: CAPTURE_BUDGET_MS,
});

let ok = false;
let detail = "";
try {
  const page = await browser.newPage();
  await page.setContent(TRIVIAL_PAGE);

  // Prove the CDP connection is alive first, so a capture hang cannot be
  // confused with a dead browser. These are the calls that kept working on the
  // broken host, and they are what makes "capture specifically is broken" a
  // measurement rather than an inference.
  const evaluated = await page.evaluate(() => 6 * 7);
  if (evaluated !== 42) throw new Error(`page.evaluate returned ${evaluated}, expected 42`);

  const started = Date.now();
  const b64 = await page.screenshot({ encoding: "base64" });
  const ms = Date.now() - started;
  if (!b64 || b64.length < 100) throw new Error(`screenshot returned ${b64?.length ?? 0} chars`);
  ok = true;
  detail = `captured ${b64.length} base64 chars in ${ms} ms`;
} catch (e) {
  detail = String(e?.message ?? e).split("\n")[0];
} finally {
  await browser.close();
}

if (ok) {
  console.log(`browser capture preflight: OK — ${detail}`);
  process.exit(0);
}

console.log(`browser capture preflight: FAILED — ${detail}`);
console.log("");
console.log("  page.screenshot() cannot capture a plain <h1> on this host. The CDP");
console.log("  connection is otherwise healthy (page.evaluate answered), so this is");
console.log("  Chrome's capture path on this machine, NOT the code under test.");
console.log("");
console.log("  CONSEQUENCE: the 64 browser probes that screenshot will fail with");
console.log("  `Page.captureScreenshot timed out` and a puppeteer stack instead of an");
console.log("  assertion. Those reds carry NO information about PowerRP. Read the");
console.log("  non-screenshot probes, the node/python/shell lanes, or fix the host");
console.log("  (a Chrome reinstall via `npx puppeteer browsers install chrome`, a");
console.log("  reboot, or clearing whatever is pinning the GPU/compositor process).");
process.exit(1);
