/**
 * PLAY-IS-REACHABLE-ON-A-PHONE probe.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/present_reachable_probe.js [shot_dir]
 *
 * WHY THIS EXISTS. User ruling, 2026-08-01, and the ranking inside it is the
 * spec: "most of the time somebody's on the phone, they're going to be
 * presenting. So the play button needs to be easily accessible no matter what."
 *
 * WHAT WAS MEASURED BEFORE THE FIX (booted editor, demo deck, three real iPhone
 * viewports). Play was not awkward — it was UNREACHABLE BY ANY TAP:
 *
 *     393x852   present button at x=786.75, right edge 812.75  → 420px off screen
 *     375x667   present button at x=786.75, right edge 812.75  → 438px off screen
 *     430x932   present button at x=772.75, right edge 798.75  → 369px off screen
 *
 *     .toolbar  scrollWidth 1107 vs clientWidth 393
 *     .toolbar  overflow-x: visible,  inside  .app  overflow: hidden
 *     no user-scrollable ancestor anywhere; document scrollWidth === clientWidth
 *     the HintBar advertises "P Present" and has ZERO interactive elements
 *
 * THE CRUCIAL NEGATIVE, which is what this probe is careful NOT to re-test:
 * `present` declares no `when` and no `requires`, and `runCommand("present")`
 * enters present mode correctly. The FEATURE was never broken. So this probe
 * asserts REACHABILITY — that a thumb can get to the command — and deliberately
 * does not re-assert that the command works, which core coverage already owns.
 *
 * WHAT IT PROVES, per viewport:
 *   (1) some on-screen control surfaces `present` — its box lies fully within
 *       the viewport, so a tap can land on it;
 *   (2) that control meets the iOS 44pt tap floor;
 *   (3) TAPPING IT (a real touch dispatch at its centre, not a JS call) enters
 *       present mode — the whole point is the tap, so a probe that called
 *       runCommand would prove nothing about reachability;
 *   (4) the app has no hidden horizontal scroll region — `.app`'s scrollWidth
 *       must equal its clientWidth. An overflow:hidden box that overflows is
 *       still a scroll container the BROWSER can scroll on focus, sliding the
 *       whole UI sideways with no gesture available to undo it.
 *
 * (1)-(3) are satisfied by web/PresentDock.svelte + its app.css block; (4) by
 * the toolbar-overflow block. The probe names the owner of whichever piece is
 * missing, because a gate that is red for a reason it does not name costs the
 * reader more than it saves.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

/** iOS Human Interface Guidelines minimum tap target, in points (= CSS px). */
const IOS_TAP_FLOOR_PT = 44;

/**
 * The viewports this gate speaks for: the narrowest iPhone still supported, the
 * current mainstream size, and the widest. Portrait only — a presenter holding
 * a phone holds it upright, and landscape has its own layout question this
 * probe does not claim to answer.
 */
const PHONES = [
  { name: "iPhone-SE", width: 375, height: 667, dpr: 2 },
  { name: "iPhone-16-Pro", width: 393, height: 852, dpr: 3 },
  { name: "iPhone-16-Pro-Max", width: 430, height: 932, dpr: 3 },
];

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr:false + watch:null — the house probe convention. Without it a concurrent
  // save anywhere in the tree full-reloads the page mid-run and every later
  // page.evaluate dies with "Execution context was destroyed".
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await launchBrowser();
const failures = [];
let passed = 0;

/** Command. Records one check's outcome and prints it. */
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL  ${name}: ${detail}`);
  }
}

try {
  for (const phone of PHONES) {
    console.log(`\n── ${phone.name} ${phone.width}x${phone.height} @${phone.dpr}x`);
    const page = await browser.newPage();
    await page.setViewport({
      width: phone.width,
      height: phone.height,
      deviceScaleFactor: phone.dpr,
      isMobile: true,
      hasTouch: true,
    });
    await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
    // domcontentloaded, not networkidle0: with several agents' Vite servers on
    // this host the dep optimizer can keep the network busy well past the app
    // being interactive, and networkidle0 then times out on a healthy app.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector(".app .toolbar button", { timeout: 120000 });
    await page.waitForFunction(() => window.__powerrp_app !== undefined, { timeout: 120000 });
    // WAIT FOR THE BOOT SPLASH TO LIFT BEFORE TOUCHING ANYTHING. #boot-splash is
    // `position: fixed; inset: 0; z-index: 9999` (web/index.html) and is removed
    // at the FIRST REAL CANVAS PAINT — which is strictly later than both waits
    // above, since the toolbar and window.__powerrp_app exist well before the
    // first frame. Tapping through it silently hits the splash instead of the
    // dock. MEASURED, not guessed: with the splash up, elementFromPoint at the
    // dock's centre returns the splash <div> and the tap is swallowed; in the
    // one run of eight where it had already lifted, the hit was the button and
    // the tap landed. That race is what made this probe flaky 1-in-3.
    // This is also the honest model of a real user, who likewise cannot tap a
    // control that is deliberately covered while the app boots.
    await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });

    // ── (1) + (2) Is there an on-screen, thumb-sized control for `present`? ──
    const found = await page.evaluate((floor) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Located by the REGISTRY TITLE, never a hardcoded label: every surfacing
      // sets aria-label from app.commands.get(id).title, so this keeps working
      // if the command is retitled — and correctly stops working if a surfacing
      // starts hardcoding its own name.
      const title = window.__powerrp_app.commands.get("present").title;
      const onScreen = [...document.querySelectorAll("button, [role=button]")]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el }) => el.getAttribute("aria-label") === title)
        .filter(({ r }) => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh);
      if (onScreen.length === 0) return { any: false, vw, vh, title };
      // The biggest one, if a phone somehow shows two: that is the one a thumb
      // is meant for, and it is the one the tap check should exercise.
      const best = onScreen.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      return {
        any: true,
        vw,
        vh,
        title,
        count: onScreen.length,
        w: best.r.width,
        h: best.r.height,
        cx: best.r.x + best.r.width / 2,
        cy: best.r.y + best.r.height / 2,
        meetsFloor: best.r.width >= floor && best.r.height >= floor,
      };
    }, IOS_TAP_FLOOR_PT);

    check(
      `${phone.name} — an on-screen control surfaces \`present\``,
      found.any,
      `no button with aria-label ${JSON.stringify(found.title)} lies within ${found.vw}x${found.vh}. ` +
        `The toolbar's own Play button renders ~420px past the right edge inside an unscrollable parent. ` +
        `EXPECTED FIX: web/PresentDock.svelte (already in HEAD) mounted in web/App.svelte — ONE line, ` +
        `\`<PresentDock {app} />\` after \`<HintBar {hints} />\`, owned by W4-K — plus the \`.present-dock\` ` +
        `block in web/app.css, owned by W4-P (patch: .frenzy/round6/W5-MOBILE-app-css-handback.css). ` +
        `This gate is RED UNTIL BOTH LAND and that is deliberate.`
    );

    if (found.any) {
      check(
        `${phone.name} — that control meets the ${IOS_TAP_FLOOR_PT}pt tap floor`,
        found.meetsFloor,
        `measured ${found.w}x${found.h}; the app-wide control height is --a-control-h: 26px (app.css:153), ` +
          `which is 59% of the iOS floor, so the dock must size itself from --a-tap-min instead`
      );

      // ── (3) A REAL TAP, not a JS call. Reachability is the claim. ──────────
      const before = await page.evaluate(() => window.__powerrp_app.mode);
      await page.touchscreen.tap(found.cx, found.cy);
      // WAIT FOR THE CONDITION, never a fixed sleep. Entering present mode
      // builds a GPU surface, and how long that takes scales with the viewport:
      // a 300ms sleep here passed at 375 and 393 and failed at 430 in 1 run of 3
      // — a flake in the PROBE, measured, not a defect in the app, which enters
      // present mode reliably given the time it actually needs.
      const entered = await page
        .waitForFunction(() => window.__powerrp_app.mode === "present", { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      const after = await page.evaluate(() => window.__powerrp_app.mode);
      check(
        `${phone.name} — tapping it enters present mode`,
        before !== "present" && entered,
        `mode went ${JSON.stringify(before)} -> ${JSON.stringify(after)} within 10s of a touch at (${Math.round(found.cx)}, ${Math.round(found.cy)})`
      );
      await page.screenshot({ path: `${shots}/present-reachable-${phone.name}-presenting.png` });
      // Leave present mode so the last assertion measures the editor, not the
      // presentation surface.
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 200));
    }

    // ── (4) No hidden horizontal scroll region on the shell ─────────────────
    const shell = await page.evaluate(() => {
      const app = document.querySelector(".app");
      const tb = document.querySelector(".toolbar");
      return {
        appScrollWidth: app.scrollWidth,
        appClientWidth: app.clientWidth,
        toolbarOverflowX: getComputedStyle(tb).overflowX,
      };
    });
    check(
      `${phone.name} — the shell has no hidden horizontal scroll region`,
      shell.appScrollWidth === shell.appClientWidth,
      `.app scrollWidth ${shell.appScrollWidth} !== clientWidth ${shell.appClientWidth}. An overflow:hidden box ` +
        `that overflows is still a scroll container: the browser scrolls it whenever focus lands on an ` +
        `off-screen descendant, sliding the whole UI sideways with no gesture to undo it. ` +
        `.toolbar overflow-x is currently ${JSON.stringify(shell.toolbarOverflowX)} — the fix is to make the ` +
        `TOOLBAR the scroll container (block 2 of the W4-P patch), which collapses this overflow to zero.`
    );

    await page.screenshot({ path: `${shots}/present-reachable-${phone.name}.png` });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`\npresent_reachable_probe FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
