/**
 * ONE SEAM FOR EVERY PROBE'S `puppeteer.launch`.
 *
 * WHY THIS EXISTS. `page.screenshot()` under new-headless Chrome hangs FOREVER
 * on some hosts — proven by tests/browser_capture_preflight.mjs against a page
 * with nothing but an <h1>, no app involved, on TWO Chrome versions. Old-headless
 * ("shell") captures fine on that same broken host. Before this file, every one
 * of the ~150 probes hand-rolled its own `puppeteer.launch({headless:"new",
 * args:[...]})`, so there was no single place to redirect the headless mode for
 * a diagnostic run — a host-level hang could only be worked around probe by
 * probe, by hand, everywhere.
 *
 * WHAT THIS IS NOT. It is not a fix for the hang, and switching modes is not a
 * substitute for the real gate. See the POWERRP_HEADLESS docs below and
 * CLAUDE.md's TEST GATE section: a run under the override is a MEASUREMENT AID,
 * never "passing".
 *
 * DEFAULT ARGS. `DEFAULT_ARGS` is the flag set the large majority of probes
 * already carried verbatim (inventoried across all ~150 call sites before this
 * file existed): SwiftShader-backed GL so WebGL2 initializes headless, plus
 * `--no-sandbox` for the containers/CI this suite runs in. A handful of probes
 * carry a DELIBERATE difference from this set — an extra autoplay flag for video
 * probes, a longer `protocolTimeout` for a slow multi-theme sweep, a narrower
 * flag list for probes that never touch WebGL. `launchBrowser` takes an options
 * MERGE for exactly that reason: it does not flatten those differences into one
 * forced array. `args` and any other key the caller passes fully REPLACES the
 * default of the same name (ordinary object-spread semantics) — a caller that
 * wants the defaults PLUS one more flag must spread `DEFAULT_ARGS` itself.
 *
 * ENV OVERRIDES (both optional; neither is read unless set).
 *
 *   POWERRP_HEADLESS = "new" (default, unset) | "shell"
 *     Selects Puppeteer's headless mode. "shell" is old-headless — the mode
 *     that keeps capturing on a host where new-headless's capture path hangs.
 *     DIAGNOSTIC ONLY: when active, `launchBrowser` prints one line to stdout
 *     naming the override, because a diagnostic lane must announce itself
 *     rather than silently change what a probe measured.
 *
 *   PUPPETEER_EXECUTABLE_PATH
 *     Not read by this file at all — Puppeteer's own `launch()` already honors
 *     this variable to pick a specific Chrome/Chromium binary. Documented here
 *     only so both knobs for "which browser, which mode" are described in one
 *     place; passing it through `env` before running a probe is sufficient.
 */

const VALID_HEADLESS_MODES = new Set(["new", "shell"]);

/** The flag set the large majority of probes already carried verbatim before
 *  this file existed (see file docblock for the inventory). SwiftShader-backed
 *  GL (WebGL2 in headless Chrome) plus `--no-sandbox`. */
export const DEFAULT_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--no-sandbox",
  "--ignore-gpu-blocklist",
];

/**
 * Query. The headless mode `launchBrowser` will use: `POWERRP_HEADLESS` if set
 * and valid, else `"new"`. Throws loudly on an unrecognized value rather than
 * silently falling back — an env var a caller thinks they set correctly must
 * not be quietly ignored.
 *
 * @returns {"new"|"shell"}
 *
 * Examples:
 *   >>> // with POWERRP_HEADLESS unset: resolveHeadlessMode() === "new"
 *   >>> // with POWERRP_HEADLESS="shell": resolveHeadlessMode() === "shell"
 */
export function resolveHeadlessMode() {
  const raw = process.env.POWERRP_HEADLESS;
  if (raw === undefined || raw === "") return "new";
  if (!VALID_HEADLESS_MODES.has(raw)) {
    throw new Error(
      `POWERRP_HEADLESS=${JSON.stringify(raw)} is not valid — must be "new" or "shell" (unset for the default, "new")`
    );
  }
  return raw;
}

/**
 * Pure function. The exact options object `launchBrowser` would pass to
 * `puppeteer.launch`: this suite's default flags plus `POWERRP_HEADLESS`,
 * merged with `overrides` (plain object spread — any key in `overrides`
 * replaces the default of the same name; `args` replaces wholesale, it does
 * not concatenate). Split out from `launchBrowser` so the OPTION-BUILDING
 * logic can be tested (tests/puppeteer_launch_parity_test.js) without ever
 * importing the real `puppeteer` module — a parity test that has to stub
 * `puppeteer.launch` would itself count as a browser-driving test under
 * run_all.mjs's `drivesBrowser` (it keys on the literal import), which is
 * exactly the misclassification a pure-options seam avoids.
 *
 * @param {object} [overrides] - Extra/overriding puppeteer.launch options.
 * @returns {object}
 *
 * Examples:
 *   >>> buildLaunchOptions().headless
 *   'new'
 *   >>> buildLaunchOptions({ protocolTimeout: 180000 }).protocolTimeout
 *   180000
 */
export function buildLaunchOptions(overrides = {}) {
  return {
    headless: resolveHeadlessMode(),
    args: DEFAULT_ARGS,
    ...overrides,
  };
}

/**
 * Command. Launches Puppeteer with `buildLaunchOptions(overrides)`. Prints
 * one line to stdout naming the headless override before launching, when
 * `POWERRP_HEADLESS` selects a non-default mode — a diagnostic lane must
 * announce itself.
 *
 * Near-pure function (reads `process.env`, launches a real browser process).
 *
 * @param {object} [overrides] - Extra/overriding puppeteer.launch options.
 * @returns {Promise<import("puppeteer").Browser>}
 *
 * Examples:
 *   >>> // const browser = await launchBrowser();
 *   >>> // -> puppeteer.launch({ headless: "new", args: DEFAULT_ARGS })
 *   >>> // const browser = await launchBrowser({ protocolTimeout: 180000 });
 *   >>> // -> same args, protocolTimeout raised for a slow multi-theme sweep
 */
export async function launchBrowser(overrides = {}) {
  const options = buildLaunchOptions(overrides);
  if (options.headless !== "new") {
    console.log(`puppeteerLaunch: headless=${options.headless} override active`);
  }
  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch(options);
}
