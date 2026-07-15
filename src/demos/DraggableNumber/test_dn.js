/**
 * DraggableNumber headless test.
 *
 * Boots the ROOT Vite dev server programmatically, opens the demo page in
 * headless Chromium (puppeteer), and drives the component through synthetic
 * pointer/keyboard events. Headless Chromium does NOT grant real Pointer Lock
 * (requires trusted user activation + often a real window), so these tests
 * exercise the FALLBACK drag path (clientY deltas) — which the component must
 * make fully functional without lock. Real pointer-lock pinning needs manual
 * (non-headless) verification.
 *
 * Run from the SvelteLib repo root:  node src/demos/DraggableNumber/test_dn.js
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
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/src/demos/DraggableNumber/demo.html`;
console.log(`Serving demo at ${url}`);

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".dn");

  check("demo page loaded without page errors", pageErrors.length === 0, pageErrors.join("; "));

  /* Test harness runs inside the page: it mounts a fresh, isolated instance of
     DraggableNumber (imported from the demo's module graph) into a scratch
     node, so we control its exact props and read its bound value directly —
     independent of the demo's own reactive wiring. It drives the component with
     real dispatched pointer/keyboard events (the fallback drag path). */
  const results = await page.evaluate(async () => {
    const { mount, unmount, tick, makeValueBox, DraggableNumber } = await import(
      "/src/demos/DraggableNumber/test_harness.svelte.js"
    );

    // Fresh mount with a REACTIVE value box, so the component's bindable `value`
    // round-trips like a real `bind:value` (its derived display re-renders).
    function makeInstance(props) {
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "40px";
      host.style.top = "40px";
      document.body.appendChild(host);
      const state = makeValueBox(props.value ?? 0);
      const { value: _drop, ...rest } = props;
      const app = mount(DraggableNumber, {
        target: host,
        props: {
          ...rest,
          get value() {
            return state.value;
          },
          set value(v) {
            state.value = v;
          },
        },
      });
      const el = host.querySelector(".dn");
      return { host, app, el, state };
    }

    const rect = (el) => el.getBoundingClientRect();

    // Dispatch a pointerdown at the element's center.
    function down(el, opts = {}) {
      const r = rect(el);
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          ...opts,
        }),
      );
    }
    // Dispatch a pointermove with an absolute clientY (fallback path reads clientY).
    function moveTo(el, clientY, opts = {}) {
      const r = rect(el);
      el.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          clientX: r.left + r.width / 2,
          clientY,
          ...opts,
        }),
      );
    }
    function up(el, opts = {}) {
      el.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, ...opts }),
      );
    }
    function key(el, k, opts = {}) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: k, ...opts }),
      );
    }
    // Type into the inline text-entry <input>: set its value + dispatch input
    // (bind:value reads .value on the input event), then a keydown for the key.
    function type(input, text) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // Await the microtask openTextEntry() uses to focus+select the input, so
    // the <input> is in the DOM before the test reads it.
    const settle = () => new Promise((r) => queueMicrotask(r));

    const out = {};

    // --- 1. Initial value renders in the DOM ---
    {
      const inst = makeInstance({ value: 42 });
      out.initialDisplay = inst.el.querySelector(".dn-value").textContent;
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 2. Drag UP increases; magnitude = pixels * coefficient ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 50); // 50px up
      out.dragUpValue = inst.state.value; // expect +50
      await tick(); // let Svelte flush the DOM before reading rendered text
      out.dragUpDisplay = inst.el.querySelector(".dn-value").textContent;
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 3. Drag DOWN decreases ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY + 30); // 30px down
      out.dragDownValue = inst.state.value; // expect -30
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 4. Coefficient scales the change (0.01 units/px) ---
    {
      const inst = makeInstance({ value: 1, coefficient: 0.01 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 100); // 100px up * 0.01 = +1
      out.coeffValue = inst.state.value; // expect 2
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 5. Shift = fine adjustment (0.1x) ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el, { shiftKey: true });
      moveTo(inst.el, startY - 100, { shiftKey: true }); // 100px up * 1 * 0.1 = +10
      out.fineValue = inst.state.value; // expect 10
      up(inst.el, { shiftKey: true });
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 6. min/max clamp ---
    {
      const inst = makeInstance({ value: 0.5, coefficient: 0.01, min: 0, max: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 1000); // way past max
      out.clampMax = inst.state.value; // expect 1
      moveTo(inst.el, startY + 1000); // way past min
      out.clampMin = inst.state.value; // expect 0
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 7. step rounds the value ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1, step: 5, min: 0, max: 100 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 12); // 12px up -> 12, round to step 5 -> 10
      out.stepValue = inst.state.value; // expect 10
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 8. keyboard arrows nudge by step (or coefficient) ---
    {
      const inst = makeInstance({ value: 10, step: 2, min: 0, max: 100 });
      key(inst.el, "ArrowUp");
      out.arrowUp = inst.state.value; // expect 12
      key(inst.el, "ArrowDown");
      key(inst.el, "ArrowDown");
      out.arrowDown = inst.state.value; // expect 8
      unmount(inst.app);
      inst.host.remove();
    }
    {
      // no step -> nudge by coefficient
      const inst = makeInstance({ value: 0, coefficient: 0.5 });
      key(inst.el, "ArrowUp");
      out.arrowNoStep = inst.state.value; // expect 0.5
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 9. Home/End jump to bounds when bounded ---
    {
      const inst = makeInstance({ value: 50, min: 0, max: 100 });
      key(inst.el, "Home");
      out.homeValue = inst.state.value; // expect 0
      key(inst.el, "End");
      out.endValue = inst.state.value; // expect 100
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 10. value display updates after a change ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 7);
      await tick();
      out.displayAfter = inst.el.querySelector(".dn-value").textContent; // "7"
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 11. onchange fires once on settle; oninput fires during drag ---
    {
      let inputs = 0;
      let changes = 0;
      let lastChange = null;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const state = makeValueBox(0);
      const app = mount(DraggableNumber, {
        target: host,
        props: {
          coefficient: 1,
          oninput: () => inputs++,
          onchange: (v) => {
            changes++;
            lastChange = v;
          },
          get value() {
            return state.value;
          },
          set value(v) {
            state.value = v;
          },
        },
      });
      const el = host.querySelector(".dn");
      const r = el.getBoundingClientRect();
      const startY = r.top + r.height / 2;
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: r.left + 2,
          clientY: startY,
        }),
      );
      for (const dy of [-5, -10, -15]) {
        el.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 1,
            clientX: r.left + 2,
            clientY: startY + dy,
          }),
        );
      }
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      out.inputCount = inputs; // >= 1 (3 distinct positions)
      out.changeCount = changes; // exactly 1 on settle
      out.changeValue = lastChange; // 15
      unmount(app);
      host.remove();
    }

    // --- 12. wheel element present by default, absent when wheel=false ---
    {
      const a = makeInstance({ value: 0 });
      out.wheelPresentDefault = !!a.el.querySelector(".dn-wheel");
      unmount(a.app);
      a.host.remove();
      const b = makeInstance({ value: 0, wheel: false });
      out.wheelAbsentWhenFalse = !b.el.querySelector(".dn-wheel");
      unmount(b.app);
      b.host.remove();
    }

    // --- 13. wheel ridge strip transform reflects accumulated drag ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      const ridges = inst.el.querySelector(".dn-ridges");
      const before = ridges.style.transform;
      down(inst.el);
      // 18px: past the click slop AND not a whole multiple of the ridge period
      // (4px), so the wrapped offset genuinely differs from the resting 0.
      moveTo(inst.el, startY - 18);
      await tick();
      const after = ridges.style.transform;
      out.wheelRolls = before !== after && /translateY/.test(after);
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 14. disabled ignores drag ---
    {
      const inst = makeInstance({ value: 5, coefficient: 1, disabled: true });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 50);
      out.disabledValue = inst.state.value; // unchanged 5
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 15. CLICK (down+up, no move) opens the inline text editor ---
    {
      const inst = makeInstance({ value: 7, coefficient: 1 });
      down(inst.el); // at center, no move
      up(inst.el); // released within slop → click
      await settle();
      await tick();
      const input = inst.el.querySelector(".dn-input");
      out.clickOpensEditor = !!input;
      out.clickPrefill = input ? input.value : null; // pre-filled with "7"
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 16. type a number + Enter COMMITS (clamped), closes the editor ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1, min: 0, max: 100 });
      down(inst.el);
      up(inst.el);
      await settle();
      await tick();
      const input = inst.el.querySelector(".dn-input");
      type(input, "42");
      key(input, "Enter");
      await tick();
      out.typeCommitValue = inst.state.value; // 42
      out.typeCommitClosed = !inst.el.querySelector(".dn-input"); // editor gone
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 16b. typed number is CLAMPED to max on commit ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1, min: 0, max: 10 });
      down(inst.el);
      up(inst.el);
      await settle();
      const input = inst.el.querySelector(".dn-input");
      type(input, "999");
      key(input, "Enter");
      await tick();
      out.typeClampValue = inst.state.value; // 10
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 17. Escape CANCELS text entry (value unchanged, editor closes) ---
    {
      const inst = makeInstance({ value: 3, coefficient: 1 });
      down(inst.el);
      up(inst.el);
      await settle();
      const input = inst.el.querySelector(".dn-input");
      type(input, "88"); // typed but not committed
      key(input, "Escape");
      await tick();
      out.escValue = inst.state.value; // unchanged 3
      out.escClosed = !inst.el.querySelector(".dn-input");
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 18. non-numeric text + ontext handler → ontext gets the string ---
    {
      let got = null;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const state = makeValueBox(5);
      const app = mount(DraggableNumber, {
        target: host,
        props: {
          ontext: (s) => (got = s),
          get value() {
            return state.value;
          },
          set value(v) {
            state.value = v;
          },
        },
      });
      const el = host.querySelector(".dn");
      down(el);
      up(el);
      await settle();
      const input = el.querySelector(".dn-input");
      type(input, "speed * 2");
      key(input, "Enter");
      await tick();
      out.ontextGot = got; // "speed * 2"
      out.ontextValueUnchanged = state.value; // still 5 (not a number)
      out.ontextClosed = !el.querySelector(".dn-input");
      unmount(app);
      host.remove();
    }

    // --- 19. onedit DELEGATES the click (built-in editor does NOT open) ---
    {
      let edited = 0;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const state = makeValueBox(1);
      const app = mount(DraggableNumber, {
        target: host,
        props: {
          onedit: () => edited++,
          get value() {
            return state.value;
          },
          set value(v) {
            state.value = v;
          },
        },
      });
      const el = host.querySelector(".dn");
      down(el);
      up(el);
      await settle();
      await tick();
      out.oneditCalled = edited; // 1
      out.oneditNoBuiltinEditor = !el.querySelector(".dn-input"); // delegated → no input
      unmount(app);
      host.remove();
    }

    // --- 19b. non-numeric text with NO ontext → Enter is REJECTED LOUDLY:
    //          editor stays open with the invalid affordance, value unchanged ---
    {
      const inst = makeInstance({ value: 4, coefficient: 1 }); // no ontext
      down(inst.el);
      up(inst.el);
      await settle();
      const input = inst.el.querySelector(".dn-input");
      type(input, "not a number");
      key(input, "Enter");
      await tick();
      const stillOpen = inst.el.querySelector(".dn-input");
      out.rejectStaysOpen = !!stillOpen;
      out.rejectInvalidClass = stillOpen ? stillOpen.classList.contains("dn-invalid") : false;
      out.rejectValueUnchanged = inst.state.value; // still 4
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 20. DRAG (move past slop) still scrubs, does NOT open the editor ---
    {
      const inst = makeInstance({ value: 0, coefficient: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      down(inst.el);
      moveTo(inst.el, startY - 20); // 20px up, well past 4px slop → scrub
      out.dragStillScrubs = inst.state.value; // +20
      up(inst.el);
      await settle();
      out.dragNoEditor = !inst.el.querySelector(".dn-input"); // no text entry
      unmount(inst.app);
      inst.host.remove();
    }

    // --- 21. WHEEL STOPS at a bound: accumulator clamps, so pushing PAST the
    //         wall doesn't roll the ridge strip further (round-9 bug) ---
    {
      const inst = makeInstance({ value: 0.5, coefficient: 0.01, min: 0, max: 1 });
      const startY = rect(inst.el).top + rect(inst.el).height / 2;
      const ridges = inst.el.querySelector(".dn-ridges");
      down(inst.el);
      moveTo(inst.el, startY - 60); // 60px up * 0.01 = +0.6 → clamps to max (1) at 50px
      await tick();
      const atWall = ridges.style.transform; // roll frozen at the wall
      moveTo(inst.el, startY - 400); // shove 340px further past the wall
      await tick();
      const pastWall = ridges.style.transform; // must NOT have moved
      out.wheelStopsAtBound = atWall === pastWall;
      out.wheelAtWallValue = inst.state.value; // pinned at 1
      up(inst.el);
      unmount(inst.app);
      inst.host.remove();
    }

    return out;
  });

  // --- Assertions on the collected results ---
  check("initial value renders as '42'", results.initialDisplay === "42", results.initialDisplay);
  check("drag up 50px @ coeff 1 -> +50", approx(results.dragUpValue, 50), `got ${results.dragUpValue}`);
  check("drag up updates display to '50'", results.dragUpDisplay === "50", results.dragUpDisplay);
  check("drag down 30px @ coeff 1 -> -30", approx(results.dragDownValue, -30), `got ${results.dragDownValue}`);
  check("coefficient 0.01: 100px -> +1 (1->2)", approx(results.coeffValue, 2), `got ${results.coeffValue}`);
  check("Shift fine drag: 100px @ coeff 1 -> +10", approx(results.fineValue, 10), `got ${results.fineValue}`);
  check("clamps to max (1)", approx(results.clampMax, 1), `got ${results.clampMax}`);
  check("clamps to min (0)", approx(results.clampMin, 0), `got ${results.clampMin}`);
  check("step 5: 12px -> rounds to 10", approx(results.stepValue, 10), `got ${results.stepValue}`);
  check("ArrowUp nudges by step (10->12)", approx(results.arrowUp, 12), `got ${results.arrowUp}`);
  check("ArrowDown x2 (12->8)", approx(results.arrowDown, 8), `got ${results.arrowDown}`);
  check("Arrow nudges by coefficient when no step (0->0.5)", approx(results.arrowNoStep, 0.5), `got ${results.arrowNoStep}`);
  check("Home -> min (0)", approx(results.homeValue, 0), `got ${results.homeValue}`);
  check("End -> max (100)", approx(results.endValue, 100), `got ${results.endValue}`);
  check("display updates to '7' after 7px drag", results.displayAfter === "7", results.displayAfter);
  check("oninput fired during drag (>=1)", results.inputCount >= 1, `got ${results.inputCount}`);
  check("onchange fired exactly once on settle", results.changeCount === 1, `got ${results.changeCount}`);
  check("onchange carried the settled value (15)", approx(results.changeValue, 15), `got ${results.changeValue}`);
  check("wheel present by default", results.wheelPresentDefault === true);
  check("wheel absent when wheel=false", results.wheelAbsentWhenFalse === true);
  check("wheel ridge strip rolls with drag", results.wheelRolls === true);
  check("disabled ignores drag (stays 5)", approx(results.disabledValue, 5), `got ${results.disabledValue}`);

  // Click-to-type suite (Task 1).
  check("click (no drag) opens inline text editor", results.clickOpensEditor === true);
  check("editor pre-fills with current value (7)", results.clickPrefill === "7", `got ${results.clickPrefill}`);
  check("type '42' + Enter commits value", approx(results.typeCommitValue, 42), `got ${results.typeCommitValue}`);
  check("commit closes the editor", results.typeCommitClosed === true);
  check("typed number clamps to max (999 -> 10)", approx(results.typeClampValue, 10), `got ${results.typeClampValue}`);
  check("Escape cancels text entry (stays 3)", approx(results.escValue, 3), `got ${results.escValue}`);
  check("Escape closes the editor", results.escClosed === true);
  check("non-numeric text routes to ontext('speed * 2')", results.ontextGot === "speed * 2", `got ${results.ontextGot}`);
  check("ontext text leaves the value unchanged (5)", approx(results.ontextValueUnchanged, 5), `got ${results.ontextValueUnchanged}`);
  check("ontext commit closes the editor", results.ontextClosed === true);
  check("non-numeric + no ontext: editor stays open (rejected)", results.rejectStaysOpen === true);
  check("rejected draft shows the invalid affordance (.dn-invalid)", results.rejectInvalidClass === true);
  check("rejected commit leaves the value unchanged (4)", approx(results.rejectValueUnchanged, 4), `got ${results.rejectValueUnchanged}`);
  check("onedit delegates the click (called once)", results.oneditCalled === 1, `got ${results.oneditCalled}`);
  check("onedit suppresses the built-in editor", results.oneditNoBuiltinEditor === true);
  check("drag past slop still scrubs (+20)", approx(results.dragStillScrubs, 20), `got ${results.dragStillScrubs}`);
  check("drag does NOT open the editor", results.dragNoEditor === true);
  check("wheel STOPS rolling at a bound (round-9)", results.wheelStopsAtBound === true);
  check("value pinned at max while shoved past wall (1)", approx(results.wheelAtWallValue, 1), `got ${results.wheelAtWallValue}`);

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  await browser.close();
  await server.close();
}

if (failed > 0) process.exit(1);
