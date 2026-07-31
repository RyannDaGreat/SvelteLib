/**
 * EQUATION CARET ALIGNMENT PROBE — the equation field's syntax-highlight overlay
 * and its transparent <input> must be METRIC-IDENTICAL, so the caret lands
 * exactly under the glyph the user clicked at EVERY index of a long expression.
 *
 * THE BUG THIS PINS (user report, verbatim intent: "the caret position is wrong
 * ... I click somewhere and it edits the text in a slightly different place"):
 * `.numfield .eq-input` declared `font-size: var(--a-font-sm)` at specificity
 * 0,2,0, while the generic panel rule `.inspector input[type="text"]` (0,2,1)
 * declared `var(--a-font-md)` and WON. The input rendered 13.6px text under an
 * 11.52px overlay — a 1.18x scale divergence accumulating ~1.25px PER CHARACTER,
 * measured at 55px by index 44 of a 44-char equation. Clicking the 30th glyph
 * put the caret at index 21. Both layers now read ONE --a-eq-* token block.
 *
 * WHAT IT ASSERTS
 *   (a) every glyph-moving computed style is IDENTICAL on both layers
 *   (b) overlay glyph x == the input's own caret x within 0.5px at many indices,
 *       INCLUDING the last
 *   (c) a real page.mouse.click between two glyphs lands selectionStart on the
 *       visually-nearest boundary
 *   (d) alignment still holds after the input SCROLLS (caret driven to far right)
 *   (e) autocomplete still opens, and accepting a suggestion puts the caret
 *       immediately after the inserted text
 *
 * HOW (b) IS MEASURED, and why not with a mirror <span>: a mirror is NOT
 * trustworthy, because the `font:` shorthand RESETS font-kerning,
 * font-variant-ligatures and font-feature-settings to their initial values — a
 * mirror built that way silently measures a different metric than the input and
 * reports drift that isn't there (it did, during this fix). Instead the input's
 * own caret x is read NATIVELY: select [0,i], and the browser's own selection
 * geometry is recovered by binary-searching the x at which the input's hit test
 * flips from <i to >=i. That boundary is the glyph MIDPOINT, so the expected
 * offset from the overlay's left-edge paint is exactly half an advance width —
 * computed from the overlay itself rather than hardcoded.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern
 * as text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

/** The expression under test: ~44 chars, mixed token classes (variable refs,
 *  operators, integers, a decimal), long enough to overflow the field box so the
 *  scrolled case is real and so per-character drift would be unmissable. */
const EQUATION = "= width_scale * 12.5 + offset_amount / 3 - 4";
/** Alignment budget. Sub-pixel: the two layers are the SAME font at the SAME
 *  size, so the only legitimate residue is device-pixel rounding of the two
 *  boxes' origins, which is well under half a pixel. */
const TOLERANCE_PX = 0.5;
/** Binary-search steps for the input's hit-test boundary. The field is ~172px
 *  wide, so 14 halvings resolve it to ~0.01px — an order finer than TOLERANCE_PX. */
const HITTEST_STEPS = 14;
/** The Inspector row under test. Chosen by the row's OWN label rather than
 *  "the first .numfield", because the first one is NOT numeric — it is "Visible",
 *  a boolean. An earlier version of this probe opened that row and logged real
 *  expression errors ("result 23.33 is not a valid boolean value") while still
 *  measuring alignment fine. Width is unambiguously numeric. */
const ROW_LABEL = "Width";
const EQ = ".inspector .numfield.eq-probe-row";

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
  // Errors this probe is NOT about. Backend-absent noise: it self-spins a
  // FRONTEND-ONLY Vite (no server.py), so best-effort asset/thumbnail requests
  // 404 and the GPU/codec surfaces complain. None of it can affect text metrics.
  // Deliberately NARROW: anything not matched here FAILS the probe. There is no
  // allowance for "real errors from other code" — one was added during this fix
  // for a transient `path is not defined` from a concurrent edit, matched nothing
  // on the next run, and was deleted. A standing allowance is a mute waiting to
  // happen; if a foreign error reappears, fail and read the message.
  const IRRELEVANT = /Failed to load resource|thumbnail|\/api\/|listAssets|WebGPU|VideoV7|Skia|CanvasKit/i;
  const note = (msg) => { if (!IRRELEVANT.test(msg)) errors.push(msg); };
  page.on("pageerror", (e) => note(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") note(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint

  // A rect with two document VARIABLES to reference, so the expression exercises
  // the variable/operator/number token classes the overlay colorizes.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const box = { ...def("rect"), name: "Box", x: 100, y: 100, w: 200, h: 120, z: 1, active: true };
    const doc = { meta: { name: "eq-caret-qa", slideW: 1000, slideH: 500, script: "" }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, box }, vars: { width_scale: 2, offset_amount: 7 } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = Object.keys(app.doc.slides[0].delta.items).find((id) => app.doc.slides[0].delta.items[id].type === "rect");
  });
  await sleep(600);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Open equation text entry via the ƒ affordance (the real user path). The ƒ
  // button's aria-label carries its row's label, which is how the numeric row is
  // identified; its .numfield is then tagged so every later query is unambiguous.
  const opened = await page.evaluate((label) => {
    const btn = [...document.querySelectorAll(".inspector .numfield .eq-open")]
      .find((b) => b.getAttribute("aria-label") === `${label}: enter an equation`);
    if (!btn) return false;
    btn.closest(".numfield").classList.add("eq-probe-row");
    btn.click();
    return true;
  }, ROW_LABEL);
  assert(opened, `ƒ affordance on the "${ROW_LABEL}" row opens equation text entry`);
  // Bail immediately rather than null-deref twenty lines later with a stack
  // trace that says nothing about the real problem (the row label went stale).
  if (!opened) {
    const seen = await page.evaluate(() => [...document.querySelectorAll(".inspector .numfield .eq-open")].map((b) => b.getAttribute("aria-label")));
    console.error(`\nEQUATION CARET PROBE FAILED: no Inspector row labelled "${ROW_LABEL}". Rows present:\n${seen.map((s) => `  ${s}`).join("\n")}`);
    process.exit(1);
  }
  await sleep(400);

  await page.evaluate((sel, eq) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    inp.focus();
    inp.value = eq;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, EQ, EQUATION);
  await sleep(400);

  const present = await page.evaluate((sel) => !!document.querySelector(`${sel} .eq-input`) && !!document.querySelector(`${sel} .eq-highlight`), EQ);
  assert(present, "both layers present (transparent input + highlight overlay)");
  const textsMatch = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    return document.querySelector(`${sel} .eq-highlight`).textContent === inp.value;
  }, EQ);
  assert(textsMatch, "overlay paints EXACTLY the input's value (no token dropped/duplicated)");

  // ── (a) every glyph-moving computed style identical on both layers ──────────
  // line-height is deliberately EXCLUDED: it moves glyphs VERTICALLY only, and
  // the overlay needs an explicit one to center its single line the way an
  // <input> centers its own (the input's is `normal`, which a div cannot copy).
  const styleDiff = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    const hl = document.querySelector(`${sel} .eq-highlight`);
    const props = [
      "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
      "letterSpacing", "wordSpacing", "fontKerning", "fontVariantLigatures",
      "fontFeatureSettings", "fontVariantNumeric", "textRendering", "tabSize",
      "textIndent", "textTransform", "whiteSpace", "direction", "boxSizing",
      "paddingLeft", "paddingRight", "borderLeftWidth",
    ];
    const out = {};
    for (const p of props) {
      const a = getComputedStyle(inp)[p], b = getComputedStyle(hl)[p];
      if (a !== b) out[p] = `input=${a} overlay=${b}`;
    }
    return out;
  }, EQ);
  const diffKeys = Object.keys(styleDiff);
  assert(diffKeys.length === 0, `every glyph-moving style identical on both layers${diffKeys.length ? ` — DIVERGED: ${diffKeys.map((k) => `${k} (${styleDiff[k]})`).join("; ")}` : ""}`);

  // A token span must contribute ZERO width of its own — the input has no span
  // boundaries, so any padding/border/margin/weight on a token shifts every
  // glyph after it out from under the caret.
  const tokWidths = await page.evaluate((sel) => {
    const toks = [...document.querySelectorAll(`${sel} .eq-highlight .eq-tok`)];
    return toks.map((t) => {
      const cs = getComputedStyle(t);
      return [cs.paddingLeft, cs.paddingRight, cs.marginLeft, cs.marginRight, cs.borderLeftWidth, cs.borderRightWidth].map(parseFloat).reduce((a, b) => a + b, 0);
    });
  }, EQ);
  assert(tokWidths.length > 0, `overlay actually tokenized the expression (${tokWidths.length} token spans)`);
  assert(tokWidths.every((w) => w === 0), `no token span adds width (max ${Math.max(0, ...tokWidths)}px of padding/margin/border)`);

  // ── Instruments ────────────────────────────────────────────────────────────
  const pinScroll = () => page.evaluate((sel) => { document.querySelector(`${sel} .eq-input`).scrollLeft = 0; document.querySelector(`${sel} .eq-highlight`).scrollLeft = 0; }, EQ);

  /** The x the OVERLAY paints the LEFT EDGE of glyph `i` at (Range geometry over
   *  the real token text nodes — the pixels the user is looking at). */
  const overlayGlyphX = (i) => page.evaluate((sel, idx) => {
    const hl = document.querySelector(`${sel} .eq-highlight`);
    const w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
    const nodes = []; let n;
    while ((n = w.nextNode())) nodes.push(n);
    let acc = 0;
    for (const t of nodes) {
      if (idx < acc + t.data.length) {
        const r = document.createRange();
        r.setStart(t, idx - acc); r.setEnd(t, idx - acc + 1);
        const rc = r.getBoundingClientRect();
        return { left: rc.left, right: rc.right, mid: rc.left + rc.width / 2, top: rc.top, height: rc.height, ch: t.data[idx - acc] };
      }
      acc += t.data.length;
    }
    const r = document.createRange(); r.selectNodeContents(hl);
    const rc = r.getBoundingClientRect();
    return { left: rc.right, right: rc.right, mid: rc.right, top: rc.top, height: rc.height, ch: null };
  }, EQ, i);

  const box = await page.evaluate((sel) => document.querySelector(`${sel} .eq-input`).getBoundingClientRect().toJSON(), EQ);
  const midY = box.top + box.height / 2;
  const selectionStart = () => page.evaluate((sel) => document.querySelector(`${sel} .eq-input`).selectionStart, EQ);

  /** The x at which the INPUT's OWN hit test flips from index <i to >=i — i.e.
   *  where the browser itself believes the boundary before glyph i sits. Binary
   *  search with real mouse clicks, so this is the input's genuine native
   *  geometry and not a reconstruction of it. Scroll is re-pinned each probe
   *  because a click near an edge can scroll the field. */
  async function inputBoundaryX(i) {
    let lo = box.left + 1, hi = box.right - 1;
    for (let k = 0; k < HITTEST_STEPS; k++) {
      const mid = (lo + hi) / 2;
      await pinScroll();
      await page.mouse.click(mid, midY);
      if ((await selectionStart()) < i) lo = mid; else hi = mid;
    }
    await pinScroll();
    return (lo + hi) / 2;
  }

  // ── (b) overlay glyph x == the input's own caret x, at MANY indices ─────────
  // A text input snaps a click to the NEAREST character boundary, so the x at
  // which its hit test starts returning index i is the MIDPOINT OF GLYPH i-1 —
  // past that midpoint, boundary i is closer than boundary i-1. (Measured, and
  // it is why the naive comparison against glyph i's own midpoint reported a
  // constant one-advance error at every index while every real click landed
  // correctly.) So index i's boundary is compared against the overlay's painted
  // midpoint of glyph i-1. Both numbers then mean the same thing — "where the
  // browser and the paint agree the boundary before glyph i is" — and any
  // font/metric divergence shows up directly, with no fudge factor.
  // Index 0 is excluded from THIS check: its boundary is clamped by the box's
  // left content edge rather than by a glyph midpoint, so the binary search
  // saturates instead of resolving a comparable quantity. Index 0 alignment is
  // covered by the click tests in (c) and by the style-identity check in (a).
  console.log(`\n  measuring ${EQUATION.length}-char expression, indices across its whole length:`);
  await pinScroll();
  const visibleLimit = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    return inp.clientWidth - 2 * parseFloat(getComputedStyle(inp).paddingLeft);
  }, EQ);
  const advance = await page.evaluate((sel) => {
    // One monospace advance, measured from the overlay itself.
    const hl = document.querySelector(`${sel} .eq-highlight`);
    const w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
    const t = w.nextNode();
    const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 1);
    return r.getBoundingClientRect().width;
  }, EQ);
  // Only indices whose glyph is fully visible at scrollLeft 0 can be hit-tested
  // by clicking; the scrolled case is covered by (d) below.
  const maxUnscrolled = Math.floor(visibleLimit / advance) - 1;
  const indices = [1, 3, 7, 11, 16, 22].filter((i) => i <= maxUnscrolled);
  indices.push(maxUnscrolled); // the last index reachable without scrolling
  let worst = 0;
  for (const i of Array.from(new Set(indices)).sort((a, b) => a - b)) {
    const prev = await overlayGlyphX(i - 1); // see the note above: boundary i sits at glyph i-1's midpoint
    const bx = await inputBoundaryX(i);
    const d = Math.abs(prev.mid - bx);
    worst = Math.max(worst, d);
    assert(d <= TOLERANCE_PX, `boundary before index ${String(i).padStart(2)}: overlay paints glyph ${i - 1} ('${prev.ch}') midpoint at ${prev.mid.toFixed(2)}, input hit-tests the boundary at ${bx.toFixed(2)} — Δ${d.toFixed(3)}px <= ${TOLERANCE_PX}`);
  }
  console.log(`  worst divergence across ${indices.length} indices: ${worst.toFixed(3)}px (budget ${TOLERANCE_PX}px)`);

  // ── (c) a real click between two glyphs lands on the nearest boundary ───────
  console.log("\n  real mouse clicks at painted glyph positions:");
  for (const target of [2, 6, 13, 19]) {
    if (target > maxUnscrolled) continue;
    await pinScroll();
    const g = await overlayGlyphX(target);
    // Click just LEFT of the glyph's midpoint: the nearest boundary is `target`.
    await page.mouse.click(g.left + advance * 0.25, g.top + g.height / 2);
    await sleep(60);
    const sel = await selectionStart();
    assert(sel === target, `click at 25% into glyph ${target} ('${g.ch}') -> selectionStart ${sel} (nearest boundary is ${target})`);
    // Click just RIGHT of the midpoint: the nearest boundary is `target + 1`.
    await pinScroll();
    const g2 = await overlayGlyphX(target);
    await page.mouse.click(g2.left + advance * 0.75, g2.top + g2.height / 2);
    await sleep(60);
    const sel2 = await selectionStart();
    assert(sel2 === target + 1, `click at 75% into glyph ${target} ('${g2.ch}') -> selectionStart ${sel2} (nearest boundary is ${target + 1})`);
  }

  // ── (d) alignment holds after the input SCROLLS ────────────────────────────
  console.log("\n  after driving the caret to the far right (the input scrolls):");
  await page.evaluate((sel) => document.querySelector(`${sel} .eq-input`).focus(), EQ);
  await page.keyboard.press("End");
  // A real gesture that forces the scroll to settle: End alone can leave
  // scrollLeft stale until the next caret move, so nudge and return.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await sleep(250);
  const scrolled = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    const hl = document.querySelector(`${sel} .eq-highlight`);
    return { inp: inp.scrollLeft, hl: hl.scrollLeft, max: inp.scrollWidth - inp.clientWidth, sel: inp.selectionStart };
  }, EQ);
  assert(scrolled.inp > 0, `the field actually scrolled (scrollLeft ${scrolled.inp} of max ${scrolled.max}) — the scrolled case is real, not vacuous`);
  assert(scrolled.sel === EQUATION.length, `caret is at the end (index ${scrolled.sel} of ${EQUATION.length})`);
  assert(scrolled.inp === scrolled.hl, `overlay scroll tracks the input's EXACTLY while scrolled (input ${scrolled.inp} vs overlay ${scrolled.hl})`);

  // With the field scrolled to the end, the LAST glyph's painted right edge must
  // sit at the input's content right edge — that is the same alignment claim as
  // (b), evaluated at the very last index, where a per-character drift is largest.
  const tail = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    const hl = document.querySelector(`${sel} .eq-highlight`);
    const cs = getComputedStyle(inp);
    const rng = document.createRange();
    rng.selectNodeContents(hl);
    const contentRight = inp.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    return { paintedRight: rng.getBoundingClientRect().right, contentRight };
  }, EQ);
  const tailD = Math.abs(tail.paintedRight - tail.contentRight);
  assert(tailD <= TOLERANCE_PX, `LAST glyph's painted right edge ${tail.paintedRight.toFixed(2)} == input content right edge ${tail.contentRight.toFixed(2)} — Δ${tailD.toFixed(3)}px <= ${TOLERANCE_PX} (a per-char drift is worst here)`);

  // A click while SCROLLED must still land where the paint says.
  const gLast = await overlayGlyphX(EQUATION.length - 3);
  await page.mouse.click(gLast.left + advance * 0.25, gLast.top + gLast.height / 2);
  await sleep(80);
  const selScrolled = await selectionStart();
  assert(selScrolled === EQUATION.length - 3, `click while scrolled at glyph ${EQUATION.length - 3} ('${gLast.ch}') -> selectionStart ${selScrolled} (want ${EQUATION.length - 3})`);

  // ── (e) autocomplete still opens, and insertion leaves the caret after it ───
  console.log("\n  autocomplete (EquationSuggest) unchanged:");
  await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    inp.focus();
    inp.value = "= width_sc";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, EQ);
  await sleep(350);
  const menu = await page.evaluate((sel) => {
    const m = document.querySelector(`${sel} .eqs-menu`);
    return m ? [...m.querySelectorAll("li,button,[role=option],.eqs-item")].map((e) => e.textContent.trim()).filter(Boolean) : null;
  }, EQ);
  assert(menu && menu.length > 0, `dropdown opens on a partial identifier (${menu ? menu.length : 0} candidates: ${menu ? menu.slice(0, 3).join(", ") : "none"})`);
  assert(menu && menu.some((t) => t.includes("width_scale")), `the matching variable is offered (got ${JSON.stringify(menu?.slice(0, 3))})`);

  // Accept with Enter, then verify the caret sits immediately after the insert.
  await page.keyboard.press("Enter");
  await sleep(300);
  const accepted = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    return { value: inp.value, caret: inp.selectionStart };
  }, EQ);
  assert(accepted.value.includes("width_scale"), `accepting inserted the full name (value now ${JSON.stringify(accepted.value)})`);
  const wantCaret = accepted.value.indexOf("width_scale") + "width_scale".length;
  assert(accepted.caret === wantCaret, `caret is immediately AFTER the insertion (at ${accepted.caret}, want ${wantCaret}) — not at end-of-field by accident`);

  // And the overlay repainted the accepted text, still aligned.
  await sleep(100);
  const afterAccept = await page.evaluate((sel) => {
    const inp = document.querySelector(`${sel} .eq-input`);
    return document.querySelector(`${sel} .eq-highlight`).textContent === inp.value;
  }, EQ);
  assert(afterAccept, "overlay repainted to match the value after accepting a suggestion");

  // ── THE SECOND EQUATION SURFACE: AngleField ────────────────────────────────
  // AngleField.svelte is a DIFFERENT component that renders the SAME two-layer
  // DOM (`.numfield > .eq-wrap > .eq-highlight + .eq-input`) for its equation
  // mode, so the one --a-eq-* metrics rule is supposed to cover it too. Asserted
  // rather than assumed: this is the surface a fix applied only to "the numeric
  // field" would silently miss, and a Rotation row is an AngleField.
  console.log("\n  AngleField (the OTHER equation surface, same shared metrics):");
  const angleOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".inspector .numfield .eq-open")]
      .find((b) => b.getAttribute("aria-label") === "Rotation: enter an equation");
    if (!btn) return false;
    btn.closest(".numfield").classList.add("eq-angle-row");
    btn.click();
    return true;
  });
  assert(angleOpened, "the Rotation row (an AngleField) opens equation text entry");
  if (angleOpened) {
    await sleep(400);
    await page.evaluate((eq) => {
      const inp = document.querySelector(".inspector .numfield.eq-angle-row .eq-input");
      inp.focus();
      inp.value = eq;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }, EQUATION);
    await sleep(300);
    const angleDiff = await page.evaluate(() => {
      const inp = document.querySelector(".inspector .numfield.eq-angle-row .eq-input");
      const hl = document.querySelector(".inspector .numfield.eq-angle-row .eq-highlight");
      if (!inp || !hl) return null;
      const props = ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "wordSpacing", "fontKerning", "fontVariantLigatures", "textRendering", "whiteSpace", "paddingLeft", "boxSizing", "borderLeftWidth"];
      const out = {};
      for (const p of props) {
        const a = getComputedStyle(inp)[p], b = getComputedStyle(hl)[p];
        if (a !== b) out[p] = `input=${a} overlay=${b}`;
      }
      return out;
    });
    assert(angleDiff !== null, "AngleField rendered both layers in equation mode");
    const angleKeys = angleDiff ? Object.keys(angleDiff) : ["<no layers>"];
    assert(angleDiff && angleKeys.length === 0, `AngleField's two layers are metric-identical too${angleDiff && angleKeys.length ? ` — DIVERGED: ${angleKeys.map((k) => `${k} (${angleDiff[k]})`).join("; ")}` : ""}`);
    // And the font size is the EQUATION size, not the generic panel size — the
    // exact assertion that would have caught the original bug on this surface.
    // Both expectations are RESOLVED from the live tokens rather than written as
    // pixel literals, so retuning --a-font-sm/--a-font-md cannot make this lie.
    const angleSize = await page.evaluate(() => {
      const inp = document.querySelector(".inspector .numfield.eq-angle-row .eq-input");
      // Resolve a token to px by letting the browser do it on a throwaway element.
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const px = (token) => { probe.style.fontSize = `var(${token})`; return getComputedStyle(probe).fontSize; };
      const eqPx = px("--a-eq-font-size"), panelPx = px("--a-font-md");
      probe.remove();
      return { actual: getComputedStyle(inp).fontSize, eqPx, panelPx };
    });
    assert(angleSize.actual === angleSize.eqPx, `AngleField's input renders at the EQUATION size (--a-eq-font-size = ${angleSize.eqPx}); got ${angleSize.actual}`);
    assert(angleSize.actual !== angleSize.panelPx, `AngleField's input is NOT at the generic panel size (--a-font-md = ${angleSize.panelPx}) — the original bug's signature`);
  }

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nEQUATION CARET PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nEQUATION CARET PROBE PASSED — overlay and input are metric-identical; clicks land on the glyph the user sees, scrolled or not; autocomplete intact.");
} finally {
  await browser.close();
  await server.close();
}
