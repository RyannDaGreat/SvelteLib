/**
 * OPTION-PARITY PROOF for tests/puppeteerLaunch.js.
 *
 * The sweep that moved ~150 probes onto `launchBrowser` must not change what
 * any of them asked Chrome for. This test freezes the LITERAL option objects a
 * representative sample of probes built by hand before the sweep (copied here
 * verbatim from their pre-sweep source, not re-derived from the helper) and
 * diffs them, key by key, against `buildLaunchOptions` — the pure function
 * `launchBrowser` uses to build its `puppeteer.launch` argument. A mismatch
 * means the sweep silently changed a probe's Chrome flags.
 *
 * DELIBERATELY DOES NOT IMPORT THE REAL BROWSER-AUTOMATION MODULE. Testing
 * against the pure `buildLaunchOptions` (rather than stubbing `.launch` and
 * calling `launchBrowser`) means this file never needs that module — which
 * matters because run_all.mjs's `drivesBrowser` classifies ANY file that
 * imports it by name, statically or dynamically, as a browser-driving test.
 * This is a bare-node test about option-building, not a browser test, and
 * this is how it stays correctly classified as one (a quoted mention of the
 * module's name even in a comment would trip that same detector — see its
 * own docblock in run_all.mjs for the prior bug this is avoiding repeating).
 *
 * Run: node src/demo_apps/PowerRP/tests/puppeteer_launch_parity_test.js
 */
import assert from "node:assert/strict";
import { buildLaunchOptions, DEFAULT_ARGS } from "./puppeteerLaunch.js";

let tests = 0;
let failures = 0;

function test(name, fn) {
  tests++;
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assertOptionsEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Literal pre-sweep option objects, copied verbatim from probe source ---
// (the "modal" variant: 88+41 = 129 of 156 call sites used exactly this array)
const MODAL_PRE_SWEEP = {
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
};

// tests/video_time_scrub_probe.js and 4 siblings: extra autoplay flag
const AUTOPLAY_PRE_SWEEP = {
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
};

// tests/theme_probe.js: modal args + a raised protocolTimeout for a slow sweep
const PROTOCOL_TIMEOUT_PRE_SWEEP = {
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
  protocolTimeout: 180000,
};

// tests/skia_export_qa.js: deliberately narrower — no --ignore-gpu-blocklist
const SKIA_QA_PRE_SWEEP = {
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
};

// tests/pdf_p1_vlm_check.js: deliberately narrowest — no GL flags at all
const PDF_VLM_PRE_SWEEP = {
  headless: "new",
  args: ["--no-sandbox"],
};

test("DEFAULT_ARGS matches the modal pre-sweep flag array", () => {
  assertOptionsEqual(DEFAULT_ARGS, MODAL_PRE_SWEEP.args, "DEFAULT_ARGS");
});

test("buildLaunchOptions() with no overrides matches the modal probe's literal launch object", () => {
  assertOptionsEqual(buildLaunchOptions(), MODAL_PRE_SWEEP, "no-override launch");
});

test("buildLaunchOptions({args: [...autoplay]}) matches the video-probe literal launch object", () => {
  const actual = buildLaunchOptions({ args: AUTOPLAY_PRE_SWEEP.args });
  assertOptionsEqual(actual, AUTOPLAY_PRE_SWEEP, "autoplay-variant launch");
});

test("buildLaunchOptions({protocolTimeout: 180000}) matches theme_probe's literal launch object", () => {
  const actual = buildLaunchOptions({ protocolTimeout: 180000 });
  assertOptionsEqual(actual, PROTOCOL_TIMEOUT_PRE_SWEEP, "protocolTimeout-variant launch");
});

test("buildLaunchOptions({args: [...no-blocklist]}) matches skia_export_qa's literal launch object", () => {
  const actual = buildLaunchOptions({ args: SKIA_QA_PRE_SWEEP.args });
  assertOptionsEqual(actual, SKIA_QA_PRE_SWEEP, "narrower-args variant launch");
});

test("buildLaunchOptions({args: ['--no-sandbox']}) matches pdf_p1_vlm_check's literal launch object", () => {
  const actual = buildLaunchOptions({ args: PDF_VLM_PRE_SWEEP.args });
  assertOptionsEqual(actual, PDF_VLM_PRE_SWEEP, "narrowest-args variant launch");
});

test("POWERRP_HEADLESS=shell overrides the default without touching args", () => {
  process.env.POWERRP_HEADLESS = "shell";
  try {
    const actual = buildLaunchOptions();
    assertOptionsEqual(actual, { ...MODAL_PRE_SWEEP, headless: "shell" }, "shell-override launch");
  } finally {
    delete process.env.POWERRP_HEADLESS;
  }
});

console.log(`\n${tests - failures}/${tests} passed`);
process.exit(failures === 0 ? 0 : 1);
