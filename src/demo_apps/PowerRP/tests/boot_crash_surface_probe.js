/**
 * BOOT CRASH SURFACE PROBE (WORKSTREAM AI) — a dead boot must never look like a
 * slow one.
 *
 * The incident, user verbatim: "oh no um, yeah, so it turned out it actually
 * crashed when it was loading and I couldn't tell because ... I'm so used to it
 * taking such a long time to say starting that I didn't even think to look in
 * the console for this error." The thrown error was
 * `properties.bundle: unknown bundle "transform"` — a throw during module-graph
 * EVALUATION, so no boot stage ever called fail(), AH's stage roster simply
 * froze mid-list, and on screen a dead boot was indistinguishable from the
 * honestly-slow one the same roster exists to explain.
 *
 * ── HOW THE CRASH IS INJECTED, AND WHY NOT BY EDITING SOURCE ─────────────────
 * `page.evaluateOnNewDocument` throws inside the page at the same LIFECYCLE
 * MOMENT the real crash occupied — after the inline splash script has installed
 * its handlers, before boot completes — without touching a single committed
 * byte. A probe that had to break a source file to run would be a probe nobody
 * runs twice, and would leave a broken tree behind on any failure path.
 *
 * THE INJECTION MUST WAIT FOR THE HANDLERS, and getting this wrong is how the
 * first version of this probe reported a green app as broken. `evaluateOnNewDocument`
 * runs before ANY page script — including the inline splash — so a plain
 * `setTimeout(…, 0)` throw fires into a document with no handler installed yet,
 * vanishes into the console, and the app then boots perfectly. The injected code
 * therefore POLLS for `window.__powerrp_boot` (the splash's own seam, which only
 * exists once its inline script has run) and throws on the tick after it appears.
 * That is precisely the incident's window: handlers up, boot not finished.
 *
 * TWO INJECTIONS, because the platform reports uncaught failure through two
 * different events and the boot path exercises BOTH: a synchronous throw fires
 * `error`, an async one fires `unhandledrejection`, and PowerRP's boot is mostly
 * async (fetch the wasm, load fonts, open storage). A handler for one is not a
 * handler for the other, so each is asserted separately.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 *   1. THE SPLASH SURVIVES AND TURNS RED. `data-failed="1"` — the splash must
 *      still be on screen (a crash must not let it lift) and must be in its
 *      failure state, which is the difference between "reported" and "froze".
 *   2. THE MESSAGE IS THERE, verbatim enough to identify the crash. This probe
 *      throws a marker string and requires it on screen: a surface that said
 *      only "something went wrong" would pass a laxer check and still leave the
 *      user exactly where the incident left him.
 *   3. THE TOP STACK FRAME IS THERE — one "at …" line. WHERE it broke is the
 *      half a message alone cannot give.
 *   4. GUIDANCE IS THERE, and names the actual remedy. The incident was fixed by
 *      clearing site data (a poisoned SW cache), so the guidance must say to
 *      reload and, failing that, to clear — "an error occurred" with no next
 *      step is barely better than a spinner.
 *   5. THE ROSTER IS STILL SHOWN with a ✕ row. AH's failure surface names WHICH
 *      stage was running, and a crash inherits that: the row left active is
 *      where boot got to, which is true even when the crash is not that stage's
 *      own fault.
 *   6. THE HANDLERS STAND DOWN after the app takes over. A clean boot is run and
 *      a throw is fired AFTER the first painted frame: the splash must be gone
 *      and must NOT come back. A splash that resurrected itself over a working
 *      editor to report a transient runtime rejection would be a new bug.
 *
 * Screenshots of each crash surface are written to the directory given as argv[2]
 * (default: a temp dir), and their paths printed.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/boot_crash_surface_probe.js [shot_dir]
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BOOT_SETTLE_MS = 25000;
/** How long the crash surface may take to appear. It is synchronous DOM work in
 *  the handler, so this is generous by an order of magnitude — a miss here means
 *  it never rendered, not that it was slow. */
const SURFACE_MS = 8000;
/** After the app is up, how long to watch for the splash wrongly reappearing. */
const STAND_DOWN_WATCH_MS = 1500;

const shotDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(resolve(tmpdir(), "powerrp-crash-"));
mkdirSync(shotDir, { recursive: true });

/** The string thrown into the page. Distinctive so assertion 2 is about THIS
 *  crash and cannot be satisfied by some other error the boot happened to hit. */
const SYNC_MARK = "PROBE_SYNTHETIC_BOOT_CRASH_sync";
const ASYNC_MARK = "PROBE_SYNTHETIC_BOOT_CRASH_async";

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const failures = [];
const note = (m) => console.log(`  · ${m}`);

/** Query (async; page). Reads the splash's failure state as one object, so every
 *  assertion below is made against ONE consistent observation of the DOM rather
 *  than a series of races. */
async function readSurface(page) {
  return page.evaluate(() => {
    const el = document.getElementById("boot-splash");
    if (!el) return { present: false };
    const rows = [...el.querySelectorAll(".boot-row")].map((r) => ({
      stage: r.getAttribute("data-stage"),
      state: r.getAttribute("data-state"),
      mark: r.querySelector(".boot-mark").textContent,
    }));
    return {
      present: true,
      failed: el.getAttribute("data-failed") === "1",
      error: document.getElementById("boot-error").textContent,
      guidance: document.getElementById("boot-guidance").textContent,
      rows,
    };
  });
}

/** Command (async; browser). Boots a page with `inject` running at document
 *  start, waits for the crash surface, screenshots it, and asserts the contract.
 *  `mark` is the string the injected crash carries. */
async function crashRun(label, inject, mark) {
  console.log(`\n${label} …`);
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(inject);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });

  const appeared = await page
    .waitForFunction(() => document.getElementById("boot-splash")?.getAttribute("data-failed") === "1", { timeout: SURFACE_MS })
    .then(() => true)
    .catch(() => false);

  const shot = resolve(shotDir, `${label}.png`);
  await page.screenshot({ path: shot });

  const s = await readSurface(page);
  if (!s.present) failures.push(`${label}: the splash was GONE after a boot crash — a dead boot lifted itself`);
  if (!appeared || !s.failed) {
    failures.push(`${label}: the splash never entered its failure state — the crash was invisible, which IS the reported bug`);
  } else {
    note(`splash entered data-failed="1"`);
    if (!s.error.includes(mark)) failures.push(`${label}: the crash message is not on screen (want ${JSON.stringify(mark)}, got ${JSON.stringify(s.error)})`);
    else note(`message shown: ${JSON.stringify(s.error.split("\n").filter(Boolean).slice(0, 2).join(" / "))}`);

    if (!/\bat\s+\S/.test(s.error)) failures.push(`${label}: no stack frame on screen — the surface says WHAT but not WHERE:\n    ${s.error.replace(/\n/g, "\n    ")}`);
    else note(`top stack frame shown`);

    if (!/reload/i.test(s.guidance)) failures.push(`${label}: guidance does not tell the user to reload: ${JSON.stringify(s.guidance)}`);
    else if (!/clear/i.test(s.guidance)) failures.push(`${label}: guidance omits clearing site data — the incident's actual remedy: ${JSON.stringify(s.guidance)}`);
    else note(`guidance names reload + clear site data`);

    const dying = s.rows.filter((r) => r.mark === "✕");
    if (!s.rows.length) failures.push(`${label}: the stage roster vanished on failure — AH's "it broke HERE" is gone`);
    else if (dying.length !== 1) failures.push(`${label}: expected exactly one ✕ row, got ${dying.length} of ${s.rows.length}`);
    else note(`roster kept, ✕ on "${dying[0].stage}" (${s.rows.length} rows)`);
  }
  note(`screenshot: ${shot}`);
  await page.close();
  return shot;
}

/** Pure function. Wraps a crash expression in the wait-for-the-handlers poll
 *  described in the header. `fire` is a statement string evaluated in the page
 *  once `window.__powerrp_boot` exists — i.e. once the splash's inline script has
 *  installed the very handlers under test, which is the whole point.
 *
 *  >>> afterHandlers("throw new Error('x');").includes("__powerrp_boot")
 *  true */
function afterHandlers(fire) {
  return `(function () {
    var iv = setInterval(function () {
      if (!window.__powerrp_boot) return;
      clearInterval(iv);
      ${fire}
    }, 5);
  })();`;
}

const shots = [];
try {
  // ── 1. A SYNCHRONOUS THROW during boot — the incident's own shape. ─────────
  shots.push(
    await crashRun(
      "crash-sync",
      afterHandlers(`throw new Error(${JSON.stringify(SYNC_MARK)});`),
      SYNC_MARK,
    ),
  );

  // ── 2. A REJECTED PROMISE nobody caught — the shape most async boot failures
  // actually take, and invisible to window.onerror. ─────────────────────────
  shots.push(
    await crashRun(
      "crash-async",
      afterHandlers(`Promise.reject(new Error(${JSON.stringify(ASYNC_MARK)}));`),
      ASYNC_MARK,
    ),
  );

  // ── 3. THE HANDLERS STAND DOWN once the editor owns the screen. ───────────
  console.log("\nstand-down (crash AFTER the first painted frame) …");
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });
  const booted = await page
    .waitForFunction(() => !document.getElementById("boot-splash") && !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS })
    .then(() => true)
    .catch(() => false);
  if (!booted) {
    failures.push("stand-down: the app never booted cleanly, so the stand-down claim could not be tested");
  } else {
    note("editor booted, splash lifted");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("PROBE_POST_BOOT_THROW"); }, 0);
      Promise.reject(new Error("PROBE_POST_BOOT_REJECTION"));
    });
    await new Promise((r) => setTimeout(r, STAND_DOWN_WATCH_MS));
    const back = await page.evaluate(() => !!document.getElementById("boot-splash"));
    if (back) failures.push("stand-down: the splash CAME BACK over a working editor to report a post-boot error");
    else note("splash stayed gone — the editor's own error surfaces own this now");
  }
  await page.close();
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAIL boot_crash_surface_probe (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  console.error(`\nscreenshots: ${shotDir}`);
  process.exit(1);
}
console.log(`\nPASS boot_crash_surface_probe — a boot crash renders IN the splash (message + stack frame + remedy + ✕ row) for both a throw and a rejection, and the handlers stand down at the first frame.\n  screenshots: ${shots.join("\n  ")}`);
