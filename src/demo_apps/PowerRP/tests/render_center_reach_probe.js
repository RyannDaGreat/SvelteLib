/**
 * RENDER CENTER REACHABILITY probe — can the user actually PRESS the dialog's
 * primary action, at a small window, in BOTH backend modes?
 *
 * WHY IT EXISTS. A user reported "there's no render button at all for the browser
 * side". Choosing Browser reveals an extra "Encoded by" row plus a hint paragraph,
 * which grows the submit form past the dialog's own height at ordinary laptop
 * viewports — so the "Submit Render Job" button sits BELOW THE FOLD of the
 * dialog's scroll region, with the whole right-hand pane empty beside it and no
 * obvious sign the form continues. The render pipeline had no UI coverage at all
 * while it was broken, and a plain "is it visible" check does NOT catch this: the
 * button is in the DOM with a non-null offsetParent the entire time.
 *
 * WHAT "REACHABLE" MEANS HERE, and why the scroll step is not a cheat. Reachability
 * is measured with `document.elementFromPoint` at the control's own centre, because
 * that is the only check that answers "would a click land on it" — a clipped or
 * escaped control fails it while every visibility predicate passes. Two variants
 * are recorded per case and they answer different questions:
 *   - noScroll  — reachable with the dialog as it OPENS. Must hold whenever the
 *     content actually fits; it is the "nothing is hidden from the user" claim.
 *   - afterScroll — reachable once the control is scrolled into view. This must
 *     hold ALWAYS, at every viewport, and it is what proves the action is
 *     COMPLETABLE rather than lost: it fails if the dialog's scroll region ever
 *     stops working and the content escapes the box instead of scrolling.
 * Do not "simplify" this probe by dropping the afterScroll variant, and do not
 * demand noScroll at every size: a 634px form cannot fit a 540px dialog, so at a
 * 600px-tall window SOMETHING must scroll. Requiring noScroll everywhere would be
 * requiring the form to shrink, which is a different task.
 *
 * MEASURED, so the next reader does not re-derive it (1280x720, Browser mode):
 *   .modal-panel   h 648 = 90% of the viewport, overflowY VISIBLE, clientH === scrollH
 *   .modal-body    clientH 589, scrollH 666  →  IT SCROLLS (overflow-y: auto)
 *   submit button  bottom 705 vs panel bottom 684; elementFromPoint → .modal-backdrop
 *   after scrollIntoView → elementFromPoint → BUTTON.btn
 * The panel's `clientH === scrollH` is NOT evidence that nothing scrolls — that
 * identity holds for every `overflow: visible` box by definition, and the shared
 * Modal's own demo page reproduces the identical signature with no defect present.
 * The element that scrolls is `.modal-body` (src/lib/Modal.svelte), and this probe
 * asserts it is the button's nearest scroll container so that fact stays true.
 *
 * The CLOSE button is checked with NO scrolling at every size, because the header
 * is `flex: none` and must never be scrollable away — a dialog you cannot dismiss
 * is worse than one whose form is long.
 *
 * Frontend-only Vite: reachability is pure layout, so no project backend is needed.
 * The right-hand pane's job poll fails without one; those console errors are
 * PRINTED, and only real page exceptions fail the run.
 *
 * HMR + watching are OFF — sibling agents edit these files concurrently and a
 * reload mid-probe reads as a flaky failure.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/render_center_reach_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Paths resolve from THIS FILE, never process.cwd().
const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const webRoot = resolve(powerRP, "web");

// SwiftShader/ANGLE: this container has no GPU and the editor's Skia surface needs
// a WebGL2 context to boot at all.
const LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const BOOT_TIMEOUT_MS = 40000; // Skia wasm + fonts + first paint, on a busy machine
const SETTLE_MS = 400; // one layout pass after a viewport change or a dropdown pick

// The acceptance grid: a comfortable window, two ordinary laptops, a short one, and
// a deliberately cruel small window. The last three are the sizes where the browser
// -mode form outgrows the dialog, which is the whole point.
const VIEWPORTS = [
  { w: 1600, h: 1000 },
  { w: 1440, h: 800 },
  { w: 1280, h: 720 },
  { w: 1366, h: 640 },
  { w: 1024, h: 600 },
];
// Both backend modes: `browser` is the one that reveals the extra rows.
const MODES = ["server", "browser"];

/**
 * Pure function. One row of the acceptance table, padded for a fixed-width dump.
 *
 * @param {{w:number,h:number}} vp Viewport under test.
 * @param {string} mode Backend mode ("server" | "browser").
 * @param {{submit:object, close:object, body:object}} m Measurement for that case.
 * @returns {string}
 *
 * @example
 * // tableRow({w:1280,h:720}, "browser",
 * //   {submit:{noScroll:false, afterScroll:true, bottom:705},
 * //    close:{noScroll:true}, body:{clientH:589, scrollH:666}})
 * // "  1280x720  browser  submit noScroll=NO  afterScroll=yes  close=yes   body 589/666 scrolls"
 */
function tableRow(vp, mode, m) {
  const yn = (b) => (b ? "yes" : "NO ");
  const scrolls = m.body.scrollH > m.body.clientH ? "scrolls" : "fits";
  return `  ${`${vp.w}x${vp.h}`.padEnd(9)} ${mode.padEnd(8)}`
    + ` submit noScroll=${yn(m.submit.noScroll)} afterScroll=${yn(m.submit.afterScroll)}`
    + ` close=${yn(m.close.noScroll)}  body ${m.body.clientH}/${m.body.scrollH} ${scrolls}`;
}

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({ headless: "new", args: LAUNCH_ARGS });

const failures = [];
const rows = [];
/** Command. Records a named assertion; a false condition fails the whole run. */
function check(name, cond, detail = "") {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The job poll has no backend here; print rather than fail (see the header).
    if (m.type() === "error") console.log(`  (console.error, expected without a backend) ${m.text().slice(0, 120)}`);
  });
  await page.setViewport({ width: VIEWPORTS[0].w, height: VIEWPORTS[0].h });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h });
    for (const mode of MODES) {
      // Re-open per case: the dialog's own `{#if}` remounts RenderCenterModal, so
      // every case starts from the same default form state rather than inheriting
      // the previous viewport's dropdown.
      await page.evaluate(() => window.__powerrp_app.toggleRenderCenter());
      await page.waitForSelector(".render-center", { timeout: 8000 });
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      if (mode === "browser") {
        await page.evaluate(() => {
          const row = [...document.querySelectorAll(".render-center-row")].find((r) => r.textContent.includes("Rendered by"));
          if (!row) throw new Error("the 'Rendered by' row is absent — the form changed shape");
          row.querySelector(".dd-trigger").click();
        });
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        await page.evaluate(() => {
          const item = [...document.querySelectorAll(".dd-menu .dd-item")].find((i) => /^Browser/.test(i.textContent.trim()));
          if (!item) throw new Error("no 'Browser' option in the Rendered-by dropdown");
          item.click();
        });
        await new Promise((r) => setTimeout(r, SETTLE_MS));
      }

      const m = await page.evaluate(() => {
        /** Query. The element a click at `el`'s own centre would actually hit. */
        const hitAtCentre = (el) => {
          const r = el.getBoundingClientRect();
          return document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        };
        /** Query. True when a click at `el`'s centre lands on `el` or inside it. */
        const reachable = (el) => {
          const hit = hitAtCentre(el);
          return !!hit && (hit === el || el.contains(hit));
        };
        /** Query. Nearest ancestor whose computed overflow-y can scroll. */
        const scrollAncestor = (el) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
          }
          return null;
        };
        const submit = [...document.querySelectorAll(".render-center button")]
          .find((b) => /Submit Render Job/.test(b.textContent));
        if (!submit) throw new Error("the Submit Render Job button is not in the DOM at all");
        const close = document.querySelector(".modal-panel .modal-close");
        if (!close) throw new Error("the dialog has no close button");
        const body = document.querySelector(".modal-body");
        const panel = document.querySelector(".modal-panel");

        const submitNoScroll = reachable(submit);
        const closeNoScroll = reachable(close);
        const anc = scrollAncestor(submit);
        // Only now disturb the scroll position: the noScroll answers above must be
        // taken from the dialog exactly as it opened.
        submit.scrollIntoView({ block: "center" });
        const submitAfter = reachable(submit);
        const sr = submit.getBoundingClientRect();
        return {
          submit: { noScroll: submitNoScroll, afterScroll: submitAfter, bottom: Math.round(sr.bottom) },
          close: { noScroll: closeNoScroll },
          body: { clientH: body.clientHeight, scrollH: body.scrollHeight },
          panel: { h: Math.round(panel.getBoundingClientRect().height), w: Math.round(panel.getBoundingClientRect().width) },
          ancestorIsModalBody: !!anc && anc.classList.contains("modal-body"),
        };
      });

      rows.push(tableRow(vp, mode, m));
      const at = `${vp.w}x${vp.h} ${mode}`;
      // THE claim: the action is completable at every size, in both modes.
      check(`${at}: Submit Render Job is clickable once scrolled to`, m.submit.afterScroll,
        `elementFromPoint missed it (button bottom ${m.submit.bottom}, body ${m.body.clientH}/${m.body.scrollH})`);
      // A dialog must always be dismissable — the header never scrolls away.
      check(`${at}: the dialog's Close button is clickable with no scrolling`, m.close.noScroll);
      // The shared Modal owns the overflow; if that seam is ever lost the content
      // escapes the panel instead of scrolling, and afterScroll above cannot help.
      check(`${at}: the submit button's scroll container is the shared Modal's .modal-body`, m.ancestorIsModalBody);
      // When the content DOES fit, nothing may be hidden from the user.
      if (m.body.scrollH <= m.body.clientH) {
        check(`${at}: content fits, so Submit needs no scrolling at all`, m.submit.noScroll);
      }
      // The 90% dialog, re-measured per viewport (size="large").
      check(`${at}: the dialog fills 90% of the viewport`,
        Math.abs(m.panel.w / vp.w - 0.9) <= 0.002 && Math.abs(m.panel.h / vp.h - 0.9) <= 0.002,
        `panel ${m.panel.w}x${m.panel.h} of ${vp.w}x${vp.h}`);

      await page.evaluate(() => window.__powerrp_app.toggleRenderCenter());
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    }
  }

  console.log(`\nREACHABILITY TABLE\n${rows.join("\n")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nRESULT: PASS — the Render Center's primary action is completable at every tested viewport in both backend modes, and the dialog stays dismissable.");
