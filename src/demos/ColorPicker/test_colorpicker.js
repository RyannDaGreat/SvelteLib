/**
 * ColorPicker headless test.
 *
 * Boots the ROOT Vite dev server programmatically, opens the demo page in
 * headless Chromium (puppeteer), and drives the component through synthetic
 * pointer/keyboard events. Also exercises the exported PURE color-math helpers
 * directly (they are the error-prone part). Exits non-zero on any failure
 * (exit-code gating).
 *
 * Run from the SvelteLib repo root:  node src/demos/ColorPicker/test_colorpicker.js
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
function approx(a, b, eps = 1) {
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
const url = `http://127.0.0.1:${port}/src/demos/ColorPicker/demo.html`;
console.log(`Serving demo at ${url}`);

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".cp");

  check("demo page loaded without page errors", pageErrors.length === 0, pageErrors.join("; "));

  const results = await page.evaluate(async () => {
    const H = await import("/src/demos/ColorPicker/test_harness.svelte.js");
    const { mount, unmount, tick, makeValueBox, ColorPicker } = H;
    const out = {};

    // ---- A. Pure helper round-trips (the risky math) ----
    out.hexToRgba_8 = H.hexToRgba("#ff008080"); // {r:255,g:0,b:128,a:~0.502}
    out.hexToRgba_short = H.hexToRgba("#f08c"); // {r:255,g:0,b:136,a:0.8}
    out.hexToRgba_opaque = H.hexToRgba("#ff0080"); // a:1
    out.hexToRgba_bad = H.hexToRgba("nope"); // null
    out.rgbaToHex_half = H.rgbaToHex({ r: 255, g: 0, b: 128, a: 0.5 }); // "#ff008080"
    out.rgbaToHex_opaque = H.rgbaToHex({ r: 255, g: 0, b: 128, a: 1 }); // "#ff0080ff"
    out.isHex_ok = H.isHex("#aa33ff80");
    out.isHex_no = H.isHex("#12");
    // hsv<->rgb round trip for a saturated color
    const rt = H.rgbaToHsva(H.hsvaToRgba({ h: 210, s: 80, v: 60, a: 0.4 }));
    out.roundTrip = rt; // ~{h:210,s:80,v:60,a:0.4}
    out.red = H.hsvaToRgba({ h: 0, s: 100, v: 100, a: 1 }); // pure red
    out.green = H.hsvaToRgba({ h: 120, s: 100, v: 100, a: 1 }); // pure green

    // ---- Instance helper (reactive bind:value) ----
    function makeInstance(props) {
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "40px";
      host.style.top = "40px";
      document.body.appendChild(host);
      const state = makeValueBox(props.value ?? "#000000ff");
      const { value: _drop, ...rest } = props;
      const app = mount(ColorPicker, {
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
      const el = host.querySelector(".cp");
      return { host, app, el, state };
    }
    const rect = (el) => el.getBoundingClientRect();
    function down(el, clientX, clientY) {
      el.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY }),
      );
    }
    function move(el, clientX, clientY) {
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX, clientY }));
    }
    function up(el, clientX, clientY) {
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX, clientY }));
    }
    function key(el, k) {
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: k }));
    }
    function typeHex(input, text) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // ---- B. Initial render: hex field shows the 8-digit value ----
    {
      const inst = makeInstance({ value: "#3b82f6ff" });
      out.initialHex = inst.el.querySelector(".cp-hex").value; // "#3b82f6ff"
      // swatch fill reflects the color
      out.hasSquare = !!inst.el.querySelector(".cp-square");
      out.hasHue = !!inst.el.querySelector(".cp-hue");
      out.hasAlpha = !!inst.el.querySelector(".cp-alpha");
      out.hasSwatch = !!inst.el.querySelector(".cp-swatch");
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- C. Dragging the alpha strip to the LEFT end sets alpha 0 (live,
    //        no Enter). Value's last two hex digits become "00". ----
    {
      const inst = makeInstance({ value: "#ff0000ff" });
      const strip = inst.el.querySelector(".cp-alpha");
      const r = rect(strip);
      down(strip, r.left, r.top + r.height / 2); // far left = alpha 0
      await tick();
      out.alphaZeroValue = inst.state.value; // "#ff000000"
      // now drag to the right end = alpha 1
      down(strip, r.right, r.top + r.height / 2);
      await tick();
      out.alphaOneValue = inst.state.value; // "#ff0000ff"
      up(strip, r.right, r.top + r.height / 2);
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- D. Dragging the hue strip changes the hue (value's RGB shifts). ----
    {
      const inst = makeInstance({ value: "#ff0000ff" }); // hue 0 (red)
      const strip = inst.el.querySelector(".cp-hue");
      const r = rect(strip);
      // Move to 1/3 across ≈ hue 120 (green). Green means g > r and g > b.
      down(strip, r.left + r.width / 3, r.top + r.height / 2);
      await tick();
      const c = H.hexToRgba(inst.state.value);
      out.hueGreen = c.g > c.r && c.g > c.b; // true (now greenish)
      up(strip, r.left + r.width / 3, r.top + r.height / 2);
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- E. Dragging the S/V square to top-right = full saturation & value
    //        (a pure hue). Bottom-left = white (s=0,v=100 → actually low sat,
    //        top-left). We check top-right corner gives max chroma. ----
    {
      const inst = makeInstance({ value: "#808080ff" }); // gray, hue 0
      const sq = inst.el.querySelector(".cp-square");
      const r = rect(sq);
      // top-right: s=100%, v=100% → pure hue-0 red
      down(sq, r.right, r.top);
      await tick();
      out.squareTopRight = inst.state.value; // "#ff0000ff"
      // bottom (any x): v=0 → black
      down(sq, r.left + r.width / 2, r.bottom);
      await tick();
      out.squareBottomBlack = inst.state.value; // "#000000ff"
      up(sq, r.left + r.width / 2, r.bottom);
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- F. Typing a valid hex applies LIVE (no Enter). ----
    {
      const inst = makeInstance({ value: "#000000ff" });
      const input = inst.el.querySelector(".cp-hex");
      typeHex(input, "#00ff0080");
      await tick();
      out.typeLiveValue = inst.state.value; // "#00ff0080"
      // invalid in-progress draft does NOT clobber the value
      typeHex(input, "#00ff00zz");
      await tick();
      out.typeInvalidHeld = inst.state.value; // still "#00ff0080"
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- G. Callbacks: onchange fires on gesture; oninput fires live. ----
    {
      let inputs = 0;
      let changes = 0;
      let lastChange = null;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const state = makeValueBox("#ff0000ff");
      const app = mount(ColorPicker, {
        target: host,
        props: {
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
      const el = host.querySelector(".cp");
      const strip = el.querySelector(".cp-alpha");
      const r = strip.getBoundingClientRect();
      down(strip, r.left + r.width / 2, r.top + r.height / 2); // ~alpha 0.5
      move(strip, r.left + r.width / 4, r.top + r.height / 2);
      up(strip, r.left + r.width / 4, r.top + r.height / 2);
      out.cbInputs = inputs; // >= 1
      out.cbChanges = changes; // exactly 1 (one settle)
      out.cbLastChange = lastChange;
      unmount(app);
      host.remove();
    }

    // ---- H. Keyboard: ArrowRight on the hue strip increases hue. ----
    {
      const inst = makeInstance({ value: "#ff0000ff" });
      const strip = inst.el.querySelector(".cp-hue");
      const before = strip.getAttribute("aria-valuenow");
      key(strip, "ArrowRight");
      await tick();
      const after = strip.getAttribute("aria-valuenow");
      out.hueKeyIncreases = Number(after) > Number(before);
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- I. External value change re-seeds the picker (hex field updates). ----
    {
      const inst = makeInstance({ value: "#111111ff" });
      inst.state.value = "#abcdefff"; // parent sets a new color
      await tick();
      out.externalHex = inst.el.querySelector(".cp-hex").value; // "#abcdefff"
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- J. Disabled ignores drag. ----
    {
      const inst = makeInstance({ value: "#ff0000ff", disabled: true });
      const strip = inst.el.querySelector(".cp-alpha");
      const r = rect(strip);
      down(strip, r.left, r.top + r.height / 2); // would set alpha 0
      await tick();
      out.disabledUnchanged = inst.state.value; // still "#ff0000ff"
      unmount(inst.app);
      inst.host.remove();
    }

    // ---- K. Plain #rrggbb input is normalized to #rrggbbaa (opaque). ----
    {
      const inst = makeInstance({ value: "#12ab34" }); // 6-digit, opaque
      out.sixDigitNormalized = inst.el.querySelector(".cp-hex").value; // "#12ab34ff"
      unmount(inst.app);
      inst.host.remove();
    }

    return out;
  });

  // --- Pure helper assertions ---
  check("hexToRgba('#ff008080') → rgb 255/0/128, a≈0.5", results.hexToRgba_8 &&
    results.hexToRgba_8.r === 255 && results.hexToRgba_8.g === 0 && results.hexToRgba_8.b === 128 &&
    approx(results.hexToRgba_8.a * 255, 128, 1), JSON.stringify(results.hexToRgba_8));
  check("hexToRgba('#f08c') shorthand → 255/0/136 a=0.8", results.hexToRgba_short &&
    results.hexToRgba_short.r === 255 && results.hexToRgba_short.b === 136 &&
    approx(results.hexToRgba_short.a, 0.8, 0.01), JSON.stringify(results.hexToRgba_short));
  check("hexToRgba opaque 6-digit → a=1", results.hexToRgba_opaque && results.hexToRgba_opaque.a === 1);
  check("hexToRgba('nope') → null", results.hexToRgba_bad === null);
  check("rgbaToHex a=0.5 → '#ff008080'", results.rgbaToHex_half === "#ff008080", results.rgbaToHex_half);
  check("rgbaToHex a=1 → '#ff0080ff'", results.rgbaToHex_opaque === "#ff0080ff", results.rgbaToHex_opaque);
  check("isHex('#aa33ff80') true", results.isHex_ok === true);
  check("isHex('#12') false", results.isHex_no === false);
  check("hsva↔rgba round trip preserves h/s/v/a", results.roundTrip &&
    approx(results.roundTrip.h, 210, 2) && approx(results.roundTrip.s, 80, 2) &&
    approx(results.roundTrip.v, 60, 2) && approx(results.roundTrip.a, 0.4, 0.01),
    JSON.stringify(results.roundTrip));
  check("hsvaToRgba pure red", results.red.r === 255 && results.red.g === 0 && results.red.b === 0);
  check("hsvaToRgba pure green", results.green.r === 0 && results.green.g === 255 && results.green.b === 0);

  // --- Component assertions ---
  check("initial value renders in hex field ('#3b82f6ff')", results.initialHex === "#3b82f6ff", results.initialHex);
  check("square/hue/alpha/swatch all present", results.hasSquare && results.hasHue && results.hasAlpha && results.hasSwatch);
  check("alpha strip LEFT end → alpha 0 (live, '#ff000000')", results.alphaZeroValue === "#ff000000", results.alphaZeroValue);
  check("alpha strip RIGHT end → alpha 1 ('#ff0000ff')", results.alphaOneValue === "#ff0000ff", results.alphaOneValue);
  check("hue drag to 1/3 → greenish (g dominant)", results.hueGreen === true);
  check("square top-right → pure hue ('#ff0000ff')", results.squareTopRight === "#ff0000ff", results.squareTopRight);
  check("square bottom → black ('#000000ff')", results.squareBottomBlack === "#000000ff", results.squareBottomBlack);
  check("typing valid hex applies LIVE (no Enter)", results.typeLiveValue === "#00ff0080", results.typeLiveValue);
  check("invalid in-progress hex is held (value unchanged)", results.typeInvalidHeld === "#00ff0080", results.typeInvalidHeld);
  check("oninput fired during gesture (>=1)", results.cbInputs >= 1, `got ${results.cbInputs}`);
  check("onchange fired exactly once on settle", results.cbChanges === 1, `got ${results.cbChanges}`);
  check("onchange carried a valid #rrggbbaa", typeof results.cbLastChange === "string" &&
    /^#[0-9a-f]{8}$/.test(results.cbLastChange), results.cbLastChange);
  check("ArrowRight on hue strip increases hue", results.hueKeyIncreases === true);
  check("external value change re-seeds the hex field", results.externalHex === "#abcdefff", results.externalHex);
  check("disabled ignores drag (value unchanged)", results.disabledUnchanged === "#ff0000ff", results.disabledUnchanged);
  check("plain '#12ab34' normalized to '#12ab34ff'", results.sixDigitNormalized === "#12ab34ff", results.sixDigitNormalized);

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  await browser.close();
  await server.close();
}

if (failed > 0) process.exit(1);
