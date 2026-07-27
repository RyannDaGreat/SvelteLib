/**
 * Modal headless test.
 *
 * Boots the ROOT Vite dev server programmatically, opens the demo page in
 * headless Chromium (puppeteer), and drives the component through synthetic
 * pointer/keyboard events: focus trap (Tab cycling), Escape close + focus
 * restoration, backdrop-click close (and the closeOnBackdrop=false variant),
 * and body-scroll locking.
 *
 * Run from the SvelteLib repo root: node src/demos/Modal/test_modal.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/src/demos/Modal/demo.html`;
console.log(`Serving demo at ${url}`);

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Ignore the dev server's missing /favicon.ico — a browser-level 404 that
    // every demo.html in this repo triggers (no favicon file exists anywhere),
    // unrelated to Modal's own behavior. The failing resource's URL lives on
    // the message's location, not its text (Chrome's text is a generic
    // "Failed to load resource..." string). Any other console.error still fails.
    if (msg.location().url?.includes("favicon.ico")) return;
    consoleErrors.push(`${msg.text()} (${msg.location().url})`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".demo-page");

  /* Test harness runs inside the page: it mounts a fresh, isolated instance of
     Modal (imported from the demo's module graph) into a scratch node, giving
     us direct control of props and the bound `open` state — independent of
     the demo's own wiring. Real dispatched keyboard/pointer events drive it. */
  const results = await page.evaluate(async () => {
    const { mount, unmount, tick, makeOpenBox, Modal } = await import(
      "/src/demos/Modal/test_harness.svelte.js"
    );

    const out = {};
    const settle = () => new Promise((r) => setTimeout(r, 0));

    function key(el, k, opts = {}) {
      (el ?? document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: k, ...opts }),
      );
    }
    function click(el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }

    // --- 1. Opening moves focus into the panel; the panel/close button is
    //        reachable; Tab traps focus cycling only among panel elements;
    //        Escape closes; focus RETURNS to the element that opened it. ---
    {
      const opener = document.createElement("button");
      opener.textContent = "opener";
      document.body.appendChild(opener);
      opener.focus();
      out.openerFocusedBefore = document.activeElement === opener;

      const box = makeOpenBox(false);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          title: "Trap Test",
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });

      // Give the modal some focusable content: two inputs (besides the close button).
      // We do this by re-mounting with children isn't trivial without a snippet, so
      // instead assert against the built-in close button + title header only, then
      // a second richer instance below covers multi-control trapping.
      box.value = true;
      await tick();
      await settle(); // openEffect's queueMicrotask focus-shift

      const panel = document.querySelector(".modal-panel");
      out.panelExists = !!panel;
      out.focusMovedIntoPanel = panel ? panel.contains(document.activeElement) : false;

      // Only one focusable (the close button) in this bare instance: Tab should
      // land back on it (wraps to itself).
      const closeBtn = panel.querySelector(".modal-close");
      out.closeBtnFocused = document.activeElement === closeBtn;
      key(document.activeElement, "Tab");
      await tick();
      out.tabStaysOnCloseBtn = document.activeElement === closeBtn;

      // Escape closes.
      key(document.activeElement, "Escape");
      await tick();
      await settle();
      out.escClosedOpenState = box.value === false;
      out.escRemovedPanel = !document.querySelector(".modal-panel");
      out.focusReturnedToOpener = document.activeElement === opener;

      unmount(app);
      host.remove();
      opener.remove();
    }

    // --- 2. Focus trap with MULTIPLE focusable controls: Tab cycles forward
    //        through all of them and wraps; Shift+Tab reverses and wraps. ---
    {
      const box = makeOpenBox(true);
      const host = document.createElement("div");
      document.body.appendChild(host);

      // Mount with real child content (two inputs + a submit button) via the
      // children snippet is awkward from raw JS, so instead we append extra
      // focusable elements directly into the rendered panel body — the trap
      // logic only cares about focusablesIn(panelEl) at trap time, which reads
      // the live DOM, so this exercises the same code path faithfully.
      const app = mount(Modal, {
        target: host,
        props: {
          title: "Multi Trap",
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      await settle();

      const panel = document.querySelector(".modal-panel");
      const body = panel.querySelector(".modal-body");
      const inputA = document.createElement("input");
      inputA.setAttribute("data-testid", "a");
      const inputB = document.createElement("input");
      inputB.setAttribute("data-testid", "b");
      body.appendChild(inputA);
      body.appendChild(inputB);

      const closeBtn = panel.querySelector(".modal-close");
      closeBtn.focus();
      out.multiFocusablesOrder = [closeBtn, inputA, inputB].every((el, i) => {
        // Just sanity: all three present in the panel.
        return panel.contains(el);
      });

      key(closeBtn, "Tab");
      await tick();
      out.tabAdvancesToA = document.activeElement === inputA;

      key(inputA, "Tab");
      await tick();
      out.tabAdvancesToB = document.activeElement === inputB;

      // Tab from the last (inputB) wraps to the first (closeBtn).
      key(inputB, "Tab");
      await tick();
      out.tabWrapsToClose = document.activeElement === closeBtn;

      // Shift+Tab from the first wraps to the last.
      key(closeBtn, "Tab", { shiftKey: true });
      await tick();
      out.shiftTabWrapsToB = document.activeElement === inputB;

      unmount(app);
      host.remove();
    }

    // --- 3. Backdrop click closes (default closeOnBackdrop=true); a click
    //        INSIDE the panel never closes it. ---
    {
      const box = makeOpenBox(true);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          title: "Backdrop Test",
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      await settle();

      const panel = document.querySelector(".modal-panel");
      // Click inside the panel: must NOT close.
      click(panel);
      await tick();
      out.panelClickKeepsOpen = box.value === true;

      // Click the backdrop itself (not the panel): must close.
      const backdrop = document.querySelector(".modal-backdrop");
      click(backdrop);
      await tick();
      out.backdropClickCloses = box.value === false;

      unmount(app);
      host.remove();
    }

    // --- 4. closeOnBackdrop=false: backdrop click does NOT close. ---
    {
      const box = makeOpenBox(true);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          title: "No Backdrop Close",
          closeOnBackdrop: false,
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      await settle();

      const backdrop = document.querySelector(".modal-backdrop");
      click(backdrop);
      await tick();
      out.backdropDisabledStaysOpen = box.value === true;

      // Escape still works even when closeOnBackdrop is false.
      key(document.activeElement, "Escape");
      await tick();
      out.escStillClosesWhenBackdropDisabled = box.value === false;

      unmount(app);
      host.remove();
    }

    // --- 5. closeOnEscape=false: Escape does NOT close. ---
    {
      const box = makeOpenBox(true);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          title: "No Escape Close",
          closeOnEscape: false,
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      await settle();
      key(document.activeElement, "Escape");
      await tick();
      out.escDisabledStaysOpen = box.value === true;
      unmount(app);
      host.remove();
    }

    // --- 6. Body scroll is locked while open, restored on close. ---
    {
      const before = document.body.style.overflow;
      const box = makeOpenBox(false);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      out.overflowUnlockedBeforeOpen = document.body.style.overflow !== "hidden";

      box.value = true;
      await tick();
      await settle();
      out.overflowLockedWhileOpen = document.body.style.overflow === "hidden";

      box.value = false;
      await tick();
      await settle();
      out.overflowRestoredAfterClose = document.body.style.overflow === before;

      unmount(app);
      host.remove();
    }

    // --- 7. Portal: the panel is a child of document.body, not of the host
    //        mount point (proves the reparent actually happened). ---
    {
      const box = makeOpenBox(true);
      const host = document.createElement("div");
      // Give the host a clipping ancestor to prove escape from overflow:hidden.
      host.style.overflow = "hidden";
      host.style.height = "10px";
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      await settle();
      const root = document.querySelector(".modal-root");
      out.portaledToBody = root && root.parentElement === document.body;
      out.notInsideClippingHost = root && !host.contains(root);
      unmount(app);
      host.remove();
    }

    // --- 8. onclose fires on Escape/backdrop dismissal but NOT on a plain
    //        programmatic `open = false`. ---
    {
      let closeCount = 0;
      const box = makeOpenBox(true);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const app = mount(Modal, {
        target: host,
        props: {
          onclose: () => closeCount++,
          get open() {
            return box.value;
          },
          set open(v) {
            box.value = v;
          },
        },
      });
      await tick();
      await settle();
      key(document.activeElement, "Escape");
      await tick();
      out.oncloseFiredOnEscape = closeCount === 1;

      box.value = true;
      await tick();
      await settle();
      box.value = false; // programmatic close — onclose should NOT fire
      await tick();
      out.oncloseNotFiredOnProgrammatic = closeCount === 1;

      unmount(app);
      host.remove();
    }

    return out;
  });

  check("opener starts focused (sanity)", results.openerFocusedBefore === true);
  check("modal panel renders on open", results.panelExists === true);
  check("focus moves into the panel on open", results.focusMovedIntoPanel === true);
  check("focus lands on the close button (only focusable)", results.closeBtnFocused === true);
  check("Tab with a single focusable stays on it (wraps to self)", results.tabStaysOnCloseBtn === true);
  check("Escape closes (open -> false)", results.escClosedOpenState === true);
  check("Escape removes the panel from the DOM", results.escRemovedPanel === true);
  check("focus returns to the previously-focused opener", results.focusReturnedToOpener === true);

  check("multiple focusables all present in panel", results.multiFocusablesOrder === true);
  check("Tab advances close -> input A", results.tabAdvancesToA === true);
  check("Tab advances input A -> input B", results.tabAdvancesToB === true);
  check("Tab wraps from last (B) back to close button", results.tabWrapsToClose === true);
  check("Shift+Tab wraps from first (close) to last (B)", results.shiftTabWrapsToB === true);

  check("click inside panel does not close", results.panelClickKeepsOpen === true);
  check("backdrop click closes (default)", results.backdropClickCloses === true);

  check("closeOnBackdrop=false: backdrop click does not close", results.backdropDisabledStaysOpen === true);
  check("closeOnBackdrop=false: Escape still closes", results.escStillClosesWhenBackdropDisabled === true);

  check("closeOnEscape=false: Escape does not close", results.escDisabledStaysOpen === true);

  check("body overflow not locked before open", results.overflowUnlockedBeforeOpen === true);
  check("body overflow locked while open", results.overflowLockedWhileOpen === true);
  check("body overflow restored after close", results.overflowRestoredAfterClose === true);

  check("modal portaled to document.body", results.portaledToBody === true);
  check("modal escapes an overflow:hidden host ancestor", results.notInsideClippingHost === true);

  check("onclose fires once on Escape dismissal", results.oncloseFiredOnEscape === true);
  check("onclose does NOT fire on programmatic open=false", results.oncloseNotFiredOnProgrammatic === true);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join("; "));
  check("no console.error output", consoleErrors.length === 0, consoleErrors.join("; "));

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  await browser.close();
  await server.close();
}

if (failed > 0) process.exit(1);
