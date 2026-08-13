/**
 * HTML TO IMAGE widget — author HTML/CSS, press Capture, and what the deck renders
 * from then on is a FROZEN IMAGE. The html never executes at playback.
 *
 * ── THE ASK, AND WHY THE ANSWER IS A CAPTURE AND NOT A RENDERER ──────────────
 * User, on the idea of teaching PowerRP to lay out CSS: "CSS is complex. You're
 * suggesting we port all of CSS too?? Hmmm..... what if we have html2image as a
 * widget. And it exports SVG. But then what if we wanted to use common livs like
 * chartjs to make our output is that possible? or is that asking too much"
 *
 * ── THE NAME, WHICH THIS WIDGET GOT WRONG ONCE ──────────────────────────────
 * It shipped as `html_capture` / "HTML Capture", and the user's reply was "Why is
 * it called HTML capture? I don't know." followed by "HTML to image should be an
 * actual thing." He is right, and the mistake is instructive: "capture" names the
 * MECHANISM (the thing this file's implementation was preoccupied with), while
 * "HTML to Image" names WHAT IT DOES FOR YOU. A user reaching for this widget is
 * looking for the second. Worse, the right name was in his ORIGINAL sentence above
 * — he wrote "html2image" — so the widget was renamed away from the user's own
 * word by an implementer who had the mechanism on his mind. The type string is now
 * `html2image`, retired through core/document.js's RETIRED_ITEM_TYPES with a loud
 * load-time report. "HTML Capture" survives ONLY as a palette search alias, so
 * nothing anyone already learned to type stops working.
 *
 * Porting CSS is refused (it ends at reimplementing a browser badly, and every
 * generated deck using one unsupported feature pressures the subset wider). But
 * the editor IS a browser, so the honest version of the idea is available for
 * free — provided the browser runs at AUTHOR time and never at PLAY time.
 *
 * ── THE LAW: CAPTURE AT AUTHOR TIME, FROZEN AT PLAY ─────────────────────────
 * The widget stores TWO things: `html` (the source) and `capture` (an ordinary
 * image asset ref). Capture is an AUTHORING ACTION — it runs in the editor, under
 * the user's own click, and writes the asset. Playback, presentation, video export
 * and the bare-node CLI read ONLY `capture`; not one of them ever loads the html.
 *
 * That is what keeps the determinism law (CLAUDE.md, "the four kinds of state")
 * intact. A live iframe in a render tree would be EPHEMERAL state — the kind this
 * codebase has none of and treats as a design failure — because its pixels depend
 * on a host browser's version, fonts and network rather than on
 * `pure(document, [[slide, alpha]])`. A CAPTURED PNG is ordinary PROPERTY STATE: it
 * is bytes in the asset library, identical on every machine that opens the deck.
 * Re-capturing on a different browser may produce different pixels, and that is
 * fine for exactly the reason re-rolling a particle seed is fine — it is an edit
 * the author made, recorded in the document, not a divergence at render time.
 *
 * SECURITY FALLS OUT OF THE SAME LAW rather than needing its own mechanism:
 * author-supplied `<script>` runs only during a capture the user asked for, in a
 * sandboxed frame that is destroyed immediately afterwards (web/html2image.js
 * owns those rules). Opening someone else's deck executes nothing.
 *
 * ── WHY THIS IS NOT THE MERMAID/LATEX SHAPE ─────────────────────────────────
 * plugins/mermaid.js and plugins/latex.js also turn source into pixels, but they
 * rasterize LAZILY AT RENDER TIME into an in-memory registry keyed by the source
 * (render_gpu/gpu/mermaid_raster.js), and the document stores no asset. That is
 * sound for THEM because their engines are BUNDLED and deterministic: the same
 * definition yields the same diagram in every copy of the app. It is NOT sound
 * here, because the "engine" is the whole host browser — its layout, its font
 * stack, its `@media` state. So this widget stores the RESULT, and the mermaid
 * pattern is deliberately not reused. It also means the CLI renders this widget
 * perfectly (an image is an image), which mermaid and latex cannot do.
 *
 * ── EXPORTS: NOTHING NEW, BY CONSTRUCTION ───────────────────────────────────
 * emit() returns a plain `image()` op on the stored asset ref, so the GPU
 * compositor, the PDF backend, the SVG backend and cli/render.js all draw it with
 * ZERO new code — it is raster ink everywhere, exactly like plugins/image.js.
 *
 * VECTOR EXPORT IS THE DESIGNED FOLLOW-UP, NOT AN OVERSIGHT (Amendment 3 route c).
 * No browser API flattens rendered HTML to SVG; the three real routes are
 * (a) foreignObject serialization (raster — what v1 does), (b) dom-to-svg-style
 * libraries (true `<text>`, partial CSS fidelity), and (c) Chrome's
 * `Page.printToPDF`, which is TRUE VECTOR and lands in machinery this repo already
 * has: html → vector PDF → the existing pdf_page widget path
 * (render_gpu/gpu/pdf_page_vector.js), whose cropped-ink localBounds work is done.
 * Route (c) is the intended v2 and is why `capture` is a generic asset ref rather
 * than a PNG-shaped field: a captured .pdf can land in the same slot and emit a
 * pdf op instead. v1 is raster because route (c) needs headless Chrome (the editor
 * tab cannot call printToPDF on itself), i.e. a server-side capture endpoint —
 * a whole second delivery, and the raster route is the one that works in a static
 * no-backend deck too.
 *
 * ── CHART LIBRARIES (the user's chartjs question): BOUNDED, AND SAY SO ──────
 * The capture runs with NO NETWORK: web/html2image.js REFUSES a source with
 * foreign-origin subresources loudly rather than capturing a half-loaded page. So
 * a `<script src="https://cdn.../chart.js">` does not silently produce a blank
 * chart — it produces an error naming the URL. That refusal is the self-
 * containedness law (a deck that CDN-loads a library at capture time depends on
 * that CDN still serving that version, and rots), and it is also the honest answer
 * to "is chartjs possible": not by CDN.
 *
 * THE ANSWER FOR v1 IS "BUNDLED LIBRARIES ONLY, AND THERE ARE NONE YET." No
 * whitelist machinery is implemented — deliberately, because a whitelist with an
 * empty list is indistinguishable from this refusal while costing a mechanism to
 * maintain. The follow-up shape is known and small: bundle the library with the
 * app, expose it at a same-origin path, and let a source `<script src>` it; an
 * SVG-native library (D3, Observable Plot, ECharts-svg) is preferred over
 * Chart.js because Chart.js draws to a `<canvas>` and can therefore only ever be
 * raster, whereas an SVG-native chart becomes real vector ink the day route (c)
 * or an SVG importer lands. What DOES work in v1 with no machinery at all: inline
 * `<script>`, inline `<style>`, inline `<svg>`, and data URIs.
 */

import { convergesOnRefs } from "../render_gpu/gpu/settled.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { image, rect, text } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** THE UNCAPTURED DEFAULT IS THE EMPTY STRING, and it is load-bearing rather than
 * merely tidy: it is the ONE value `hasCapture` tests, so "no asset yet" has a
 * single spelling that emit(), the placeholder and the command gate all agree on.
 * Deliberately NOT the image widget's 1×1 transparent PNG (plugins/image.js
 * BLANK_SRC) — that default renders as a legitimately blank widget, which is the
 * exact silent-blank this widget's placeholder exists to prevent. */
export const UNCAPTURED = "";

/**
 * The HTML a freshly inserted widget carries.
 *
 * IT HAS TO BE HANDSOME, AND THAT IS A REQUIREMENT RATHER THAN A FLOURISH. User,
 * 2026-08-13: "I don't know how to test this because it's very boring looking right
 * now." A default that is merely VALID demonstrates nothing — the whole argument for
 * this widget is "things a native widget cannot lay out", and a centred `<h1>` on a
 * flat background is something six other widgets already do better. So the default
 * is a real dashboard card: a layered gradient, a soft inner highlight, a two-column
 * flex header, letter-spaced small-caps type, tabular figures, a delta pill and a
 * CSS-drawn sparkline. It is a WORKED EXAMPLE of the widget's actual value.
 *
 * EVERY PIXEL OF IT IS SELF-CONTAINED, which is the second job it does: it is the
 * demonstration that the no-foreign-subresource rule (web/html2image.js
 * foreignSubresources, which refuses a CDN URL loudly) is not a crippling
 * restriction. No `<link>`, no webfont, no remote image — the sparkline is a row of
 * flexed `<div>`s with gradient fills, the typography is the system stack, and
 * `tests/htmlcap_html2image_test.js` asserts the default passes the refusal so this
 * example can never drift into violating the rule it exists to illustrate.
 *
 * THE NUMBERS ARE OBVIOUSLY FICTIONAL ("Deck Engagement", a made-up percentage). A
 * default that looked like real data would be a small lie sitting in every new
 * widget, and the user has to be able to tell at a glance that it is placeholder
 * content he is meant to replace.
 */
export const DEFAULT_HTML = `<div class="card">
  <div class="head">
    <div>
      <div class="eyebrow">Deck Engagement</div>
      <div class="stat">86.4<span class="unit">%</span></div>
    </div>
    <div class="pill">&#9650; 12.8%</div>
  </div>

  <div class="spark">
    <i style="height:32%"></i><i style="height:48%"></i><i style="height:41%"></i>
    <i style="height:63%"></i><i style="height:57%"></i><i style="height:78%"></i>
    <i style="height:71%"></i><i style="height:92%"></i><i style="height:86%"></i>
  </div>

  <div class="foot">Rendered from HTML &amp; CSS, then frozen into an image</div>
</div>

<style>
  body { background: #0b1020; }
  .card {
    box-sizing: border-box; height: 100%; padding: 44px 48px;
    display: flex; flex-direction: column; justify-content: space-between;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #e8ecff;
    background:
      radial-gradient(120% 140% at 0% 0%, rgba(129,140,248,0.35) 0%, rgba(129,140,248,0) 55%),
      radial-gradient(110% 130% at 100% 100%, rgba(34,211,238,0.30) 0%, rgba(34,211,238,0) 50%),
      linear-gradient(150deg, #131a35 0%, #0b1020 100%);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 22px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.14);
  }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
  .eyebrow {
    font-size: 15px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: #9aa8d8;
  }
  .stat {
    margin-top: 10px; font-size: 92px; line-height: 0.95; font-weight: 800;
    letter-spacing: -0.035em; font-variant-numeric: tabular-nums;
    background: linear-gradient(100deg, #ffffff 0%, #a5b4fc 55%, #67e8f9 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  /* The unit rides the NUMBER's cap height, not the text baseline. Without the
     explicit vertical alignment it inherits the gradient-clipped block and sinks
     below the digits, which reads as a typo rather than a design. */
  .unit { font-size: 38px; font-weight: 600; margin-left: 6px; vertical-align: 0.55em; }
  .pill {
    flex: none; padding: 9px 16px; border-radius: 999px; font-size: 17px; font-weight: 700;
    color: #6ee7b7; background: rgba(16,185,129,0.14);
    border: 1px solid rgba(110,231,183,0.35);
  }
  /* The sparkline GROWS to fill whatever the header and footer leave, instead of
     being a fixed 132px band that strands itself in the middle of a tall card.
     The min-height:0 is the flex-child rule that makes shrinking legal; without
     it the bars would overflow a short widget rather than compressing. */
  .spark { flex: 1; min-height: 0; display: flex; align-items: flex-end; gap: 9px; margin: 28px 0; }
  .spark i {
    flex: 1; border-radius: 6px 6px 3px 3px;
    background: linear-gradient(180deg, #818cf8 0%, rgba(34,211,238,0.28) 100%);
  }
  .spark i:last-child { background: linear-gradient(180deg, #67e8f9 0%, rgba(103,232,249,0.32) 100%); }
  .foot { font-size: 15px; color: #7f8cba; }
</style>`;

/** The default source's FIRST MEANINGFUL LINE, shown on the uncaptured placeholder
 * so the widget previews what it is about to become. Derived from DEFAULT_HTML
 * rather than restated, so it cannot drift from the source it claims to quote. */
export const DEFAULT_HTML_FIRST_LINE = DEFAULT_HTML.split("\n")[0];

/** The capture's pixel size, and therefore the resolution ceiling of the frozen
 * asset. 1280x720 because it is the common 16:9 authoring size and matches the
 * default widget box's aspect, so the first capture is not letterboxed. Separate
 * from `w`/`h` (the widget's WORLD size) on purpose: the box can be resized freely
 * afterwards without re-capturing, and a user who wants more detail raises these
 * rather than making the widget bigger. */
export const DEFAULT_CAPTURE_W = 1280;
export const DEFAULT_CAPTURE_H = 720;

/**
 * ── WHY INSERTING DOES NOT AUTO-CAPTURE, AND WHAT IT DOES INSTEAD ────────────
 * The obvious cure for "boring on insert" is to run the first capture
 * automatically, so a freshly dropped widget shows the handsome card at once. It
 * was CONSIDERED AND REFUSED, on the grounds this widget's whole security argument
 * stands on:
 *
 *   AUTHOR-SUPPLIED SCRIPT RUNS ONLY UNDER AN EXPLICIT USER ACTION.
 *
 * Insert is not that action. It is the moment the user asks for a widget, not the
 * moment he asks to execute anything — and the gap matters because `html` is
 * ORDINARY DOCUMENT STATE: it arrives by paste, by an undo that restores a
 * different source, by opening someone else's deck, by a preset the EG program is
 * about to add. Auto-capture-on-insert makes "a widget appeared in my document" a
 * sufficient condition for running its script, and that is exactly the property
 * the sandbox-plus-consent design exists to deny. It would also write an asset
 * file into the project library as a side effect of a gesture that promised only
 * to place a box, and it would do so before the user had seen a single line of the
 * source he was executing.
 *
 * SO THE PLACEHOLDER CARRIES THE WEIGHT INSTEAD, and it is built to be worth
 * looking at rather than merely legible: a deep slate card, a bright cyan title, a
 * dimmed monospace PREVIEW OF THE SOURCE'S FIRST LINE, and a pill-shaped hint
 * naming the button. It previews what the widget is ABOUT to become and states the
 * one action that gets there — which is strictly more informative than the captured
 * picture would be, because the captured picture does not tell you it came from
 * HTML or how to change it.
 *
 * (If auto-capture is ever wanted anyway, the honest shape is a per-insert PROMPT —
 * "run this source now?" — not a silent execution. That is a UI question, and this
 * file is the wrong place to answer it.)
 */

/** Placeholder colours — a DARK SLATE card that reads as a deliberate, designed
 * state rather than an error. Deliberately NOT the red plugins/mermaid.js and
 * plugins/latex.js use for a parse failure (an uncaptured widget is not broken —
 * it is a step not yet taken, and crying wolf would devalue their red), and no
 * longer the amber "unfinished" this widget shipped with: amber still says
 * WARNING, and the user's complaint was that the whole thing looked boring. The
 * palette matches the default source's own card, so the placeholder and the
 * picture it becomes are visibly the same widget. Literal because emit() is
 * DOM-free and cannot read app.css's --a-* tokens; redeclared rather than
 * imported because no plugin may import another plugin. */
const PLACEHOLDER_BG = "#131a35";
const PLACEHOLDER_BORDER = "#4c5a94";
const PLACEHOLDER_TITLE = "#67e8f9";
const PLACEHOLDER_SOURCE = "#7f8cba";
const PLACEHOLDER_HINT_BG = "#1f2a52";
const PLACEHOLDER_HINT_TEXT = "#a5b4fc";
/** Border thickness (canvas units) — thicker than a hairline so the frame reads as
 * a deliberate state and not as a widget's ordinary 1px border. */
const PLACEHOLDER_BORDER_WIDTH = 2;
/** The card's corner rounding, matching the default source's own 22px card at the
 * default 480x270 box — so the placeholder and the captured picture share a
 * silhouette. */
const PLACEHOLDER_CORNER_RADIUS = 10;
/** Layout of the three stacked lines, all as FRACTIONS of the box so the affordance
 * composes at any widget size, each capped so a large widget does not mint giant
 * type. The title leads, the source preview sits under it in a dimmer tone, and the
 * hint pill anchors the bottom. */
const PLACEHOLDER_PADDING_FRACTION = 0.07;
const PLACEHOLDER_PADDING_MAX = 22;
const PLACEHOLDER_TITLE_FRACTION = 0.13;
const PLACEHOLDER_TITLE_MAX = 26;
const PLACEHOLDER_BODY_FRACTION = 0.075;
const PLACEHOLDER_BODY_MAX = 14;
/** The hint pill's padding and rounding, as multiples of its own text size, so it
 * stays proportionate at every scale. */
const PLACEHOLDER_PILL_PAD_X = 0.7;
const PLACEHOLDER_PILL_PAD_Y = 0.45;

/** The placeholder's headline — what the widget IS, in the name the user chose. */
export const UNCAPTURED_TITLE = "HTML to Image";

/** The placeholder's call to action. A CONSTANT because it is asserted verbatim by
 * tests/htmlcap_html2image_test.js — the whole point of the affordance is that it
 * names the button, so an edit reducing it to "not captured" must fail. */
export const UNCAPTURED_MESSAGE =
  "Press Capture to render this HTML into an image · double-click to edit the source";

/**
 * Pure function. A one-line PREVIEW of the source for the placeholder: the first
 * line with real content, whitespace collapsed, elided to `max` characters.
 *
 * WHY THE SOURCE AND NOT A GENERIC LABEL: the placeholder's job is to say what
 * THIS widget is about to become, and two uncaptured widgets carrying different
 * pages must not look identical. Showing the author's own first line is the
 * cheapest honest distinguisher, and it needs no rendering.
 *
 * Leading blank lines and pure-whitespace lines are skipped, because a source that
 * opens with a newline would otherwise preview as nothing at all.
 *
 * @param {string} html - the widget's source
 * @param {number} max - maximum characters before eliding
 * @returns {string} a single line, possibly ending in an ellipsis
 *
 * @example sourcePreview('<div class="card">\n  <h1>Hi</h1>\n</div>', 40)
 * '<div class="card">'
 * @example sourcePreview('\n\n   <p>after blanks</p>', 40)
 * '<p>after blanks</p>'
 * @example sourcePreview("<section><header><h1>A very long opening line</h1>", 20)
 * '<section><header><h…'
 * @example sourcePreview("", 40)
 * '(empty source)'
 * @example sourcePreview("   \n  \n", 40)
 * '(empty source)'
 */
export function sourcePreview(html, max) {
  const line = String(html ?? "").split("\n").map((l) => l.trim().replace(/\s+/g, " ")).find((l) => l.length > 0);
  if (!line) return "(empty source)";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * Pure function. Does this widget have a captured asset to draw?
 *
 * THE ONE PREDICATE, shared by emit(), the placeholder branch and the Capture
 * command's own reporting, so those three can never disagree about what
 * "uncaptured" means.
 *
 * @param {object} state - the widget's evaluated state
 * @returns {boolean}
 *
 * @example hasCapture({ capture: "shot.png" })
 * true
 * @example hasCapture({ capture: "" })
 * false
 * @example hasCapture({})
 * false
 */
export function hasCapture(state) {
  return typeof state?.capture === "string" && state.capture.length > 0;
}

/**
 * Pure function. The in-widget "not captured yet" affordance — a DESIGNED CARD, not
 * a warning box: a dark rounded panel, the widget's name in cyan, a dimmed preview
 * of the source's own first line, and a pill naming the button that renders it.
 *
 * IT IS AN AFFORDANCE FIRST AND AN ERROR REPORT NEVER. The alternative this
 * replaces is the failure mode the codebase forbids — an uncaptured widget drawing
 * NOTHING looks exactly like a captured one whose asset went missing, and a deck
 * exported with one would ship a hole while exiting 0. But the previous version
 * over-corrected into an amber warning, and the user's verdict on the result was
 * that the widget "looks very boring". So this states the same fact in a form worth
 * looking at, and it does the thing a captured picture cannot: it says where the
 * picture will come from and how to change it.
 *
 * Vector ops (rects + texts) so it is crisp and IDENTICAL in every backend — the
 * GPU, PDF, SVG and the bare-node CLI alike — and so it needs no asset of its own
 * (a placeholder that could itself go missing would be circular).
 *
 * Args:
 *   w, h (number): the widget's local box size, in canvas units
 *   html (string): the widget's source, for the one-line preview
 *
 * Returns:
 *   object[]: IR ops — [card, title, source preview, hint pill, hint text]
 *
 * @example uncapturedAffordance(480, 270, "<div>hi</div>").length
 * 5
 * @example uncapturedAffordance(480, 270, "<div>hi</div>")[0].op
 * 'rect'
 * @example uncapturedAffordance(480, 270, "<div>hi</div>")[1].text
 * 'HTML to Image'
 * @example uncapturedAffordance(480, 270, "<div>hi</div>")[2].text
 * '<div>hi</div>'
 * @example uncapturedAffordance(480, 270, "<div>hi</div>")[4].text.startsWith("Press Capture")
 * true
 */
export function uncapturedAffordance(w, h, html = "") {
  const pad = Math.min(PLACEHOLDER_PADDING_MAX, h * PLACEHOLDER_PADDING_FRACTION);
  const titleSize = Math.max(1, Math.min(PLACEHOLDER_TITLE_MAX, h * PLACEHOLDER_TITLE_FRACTION));
  const bodySize = Math.max(1, Math.min(PLACEHOLDER_BODY_MAX, h * PLACEHOLDER_BODY_FRACTION));
  const innerW = Math.max(1, w - 2 * pad);

  const card = rect({
    x: 0, y: 0, w, h, cornerRadius: PLACEHOLDER_CORNER_RADIUS,
    fill: PLACEHOLDER_BG, stroke: PLACEHOLDER_BORDER, strokeWidth: PLACEHOLDER_BORDER_WIDTH,
  });
  const title = text({
    text: UNCAPTURED_TITLE,
    x: pad, y: pad, size: titleSize, color: PLACEHOLDER_TITLE, bold: true,
    boxW: innerW, boxH: titleSize * 1.4,
  });
  // The author's own first line — what distinguishes two uncaptured widgets. The
  // character budget is derived from the box rather than fixed, so a narrow widget
  // elides sooner instead of overflowing: ~0.6em per glyph is the usual average
  // advance for a proportional face, which is close enough for an elision bound.
  const preview = text({
    text: sourcePreview(html, Math.max(8, Math.floor(innerW / (bodySize * 0.6)))),
    x: pad, y: pad + titleSize * 1.6, size: bodySize, color: PLACEHOLDER_SOURCE,
    font: "jetbrains", boxW: innerW, boxH: bodySize * 1.4,
  });

  // The hint PILL, bottom-left: a rounded plate behind the call to action, sized to
  // its OWN TEXT so it hugs the words rather than stretching to the card's width —
  // a full-width plate reads as a status bar, which is a different (and duller)
  // thing than a button-shaped hint. The width is estimated from the glyph count at
  // the same ~0.6em average advance the elision budget above uses, and CLAMPED to
  // the card so a long message in a narrow widget cannot overhang the border.
  const pillPadX = bodySize * PLACEHOLDER_PILL_PAD_X;
  const pillPadY = bodySize * PLACEHOLDER_PILL_PAD_Y;
  const pillH = bodySize + 2 * pillPadY;
  const pillW = Math.min(innerW, UNCAPTURED_MESSAGE.length * bodySize * 0.5 + 2 * pillPadX);
  const pillY = Math.max(0, h - pad - pillH);
  const pill = rect({
    x: pad, y: pillY, w: pillW, h: pillH,
    cornerRadius: pillH / 2, fill: PLACEHOLDER_HINT_BG, stroke: null, strokeWidth: 0,
  });
  const hint = text({
    text: UNCAPTURED_MESSAGE,
    x: pad + pillPadX, y: pillY + pillPadY, size: bodySize, color: PLACEHOLDER_HINT_TEXT,
    boxW: Math.max(1, pillW - 2 * pillPadX), boxH: bodySize * 1.4,
  });
  return [card, title, preview, pill, hint];
}

/**
 * Command (async; browser-only). Captures the SELECTED widget's `html` to an image
 * asset and writes the ref onto `capture` as one undo unit.
 *
 * THE DYNAMIC IMPORT IS REQUIRED, not stylistic: this plugin file is reached from
 * plugins/index.js's static import chain, which the bare-node test suites and
 * cli/render.js both walk. web/html2image.js touches `document`, so a static
 * import here would break every node suite at load time. Same discipline
 * plugins/demo/video_time_scrub.js uses for its projectApi import, and the same
 * one render_gpu/gpu/mermaid_raster.js uses for its renderer.
 *
 * LOUD ON EVERY FAILURE — no selection, a source with foreign subresources, a
 * frame that never loads — because a capture that quietly did nothing would leave
 * the previous (or absent) asset in place and look like a successful no-op.
 *
 * @param {object} app - the editor app (selection, state(), setPreview/commitPreview, projectName())
 */
async function captureSelectedHtml(app) {
  const id = app.selection;
  if (id == null) throw new Error("Capture HTML to Image: select an HTML to Image widget first");
  const state = app.state().items[id];
  if (state?.type !== html2imagePlugin.type)
    throw new Error(`Capture HTML to Image: the selection is a "${state?.type}" widget, not an HTML to Image — this command writes THIS widget's own captured asset.`);
  const { captureHtmlToAsset } = await import("../web/html2image.js");
  const ref = await captureHtmlToAsset(app, {
    html: state.html ?? "",
    width: state.captureW ?? DEFAULT_CAPTURE_W,
    height: state.captureH ?? DEFAULT_CAPTURE_H,
  });
  app.setPreview([[["items", id, "capture"], ref]]);
  app.commitPreview();
}

export const html2imagePlugin = {
  type: "html2image",
  // CONVERGES, on the STORED asset and nothing else — the same declaration
  // plugins/image.js makes, because after the capture this widget IS an image
  // widget. That is the whole dividend of the capture-at-author-time law: the
  // thing an exporter must wait for is a bitmap decode with a deterministic
  // limit, NOT a host browser laying out a page. Contrast the video PLAYER, the
  // one EPHEMERAL.NEVER inhabitant — a LIVE html frame would have been a second
  // one, and this widget exists specifically so it is not.
  ephemeral: convergesOnRefs((s) => [s.capture]),
  // THE DISPLAY NAME the user asked for. `type` is `html2image` and this is the
  // human face of it; the retired "HTML Capture" lives on only in the Add command's
  // search aliases below.
  title: "HTML to Image",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // shared full-screen Monaco editor on the `html` source. The "code_modal"
  // precedent exactly — this widget carries no editor UI of its own.
  activate: "code_modal",
  // THE code-editor descriptor both the "code_modal" activation and the `{}` row
  // button read: WHICH string is the source, in what Monaco language, and the
  // modal's title.
  codeEditor: { property: "html", language: "html", title: "Edit HTML source (then press Capture)" },
  defaults: {
    type: "html2image", x: 100, y: 100, w: 480, h: 270, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    html: DEFAULT_HTML,
    // THE FROZEN OUTPUT. Empty until the author presses Capture — see UNCAPTURED.
    capture: UNCAPTURED,
    captureW: DEFAULT_CAPTURE_W,
    captureH: DEFAULT_CAPTURE_H,
    // An image's own pixels are its interior, so like plugins/image.js there is no
    // `fill` — only the stroked BORDER slice, invisible until strokeWidth > 0.
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"),
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("transform"),
    // THE SOURCE. A multi-line string edited inline OR — the real edit — in the
    // full-screen editor behind the `{}` button this row's `code` aspect puts at
    // its value end (core/properties.js THE `code` ROW ASPECT). The language
    // agrees with `codeEditor` above, as that aspect's contract requires.
    { key: "html", label: "HTML", kind: "text", category: "text", code: { language: "html" }, help: "The HTML source this widget captures. It runs ONLY when you press Capture, in a sandboxed frame, and never during playback or export — the deck renders the captured image. Inline <style>/<script>/<svg> and data: URIs work; a subresource from another origin (a CDN script, a remote font or image) is refused loudly rather than captured half-loaded." },
    // The capture's PIXEL size — the resolution of the frozen asset, not the
    // widget's world size (see DEFAULT_CAPTURE_W). Raising these and re-capturing
    // is how you get more detail; resizing the widget alone just scales the image.
    { key: "captureW", label: "Capture width", kind: "number", category: "formatting", help: "Pixel width the HTML is rendered and rasterized at. This is the captured image's resolution, NOT the widget's size on the canvas — resize the widget freely without re-capturing. Raise it (and press Capture again) when the frozen picture looks soft." },
    { key: "captureH", label: "Capture height", kind: "number", category: "formatting", help: "Pixel height the HTML is rendered and rasterized at. Same rule as Capture width: it sets the frozen image's resolution, not the widget's canvas size." },
    // THE CAPTURE ITSELF, surfaced read-only-ish as an ordinary asset row so the
    // author can SEE which asset the widget is frozen to (and repoint it at a
    // different one, which is a legitimate edit). It is written by the command
    // below, not typed.
    { key: "capture", label: "Captured image", kind: "asset", assetKinds: ["image"], assetForm: "url", category: "formatting", help: "The frozen image this widget actually draws — written by Capture into the project's assets. This, not the HTML, is what playback, video export and the CLI renderer read. Empty until the first capture, until which the widget shows its dark 'HTML to Image' card previewing the source instead." },
    // The action row that runs the capture, so the command is reachable without
    // the palette (the tool-surfacing rule: a gate is only half an affordance).
    { key: "__captureHtml", label: "Capture", kind: "action", command: "capture-html", category: "formatting", help: "Render the HTML source right now, in this browser, and freeze the result into an image asset the deck will use from here on. This is the ONLY moment the source executes." },
    // The stroked-BORDER bundle (no fill — the captured pixels are the interior).
    ...bundle("strokedBorder"),
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space).
   *
   * TWO OUTCOMES AND NO THIRD: a captured widget emits the same `image()` op
   * plugins/image.js emits (which is why every backend already draws it), and an
   * uncaptured one emits the LOUD amber affordance. There is deliberately no
   * "draw nothing" branch — a blank is the one thing this widget must never be,
   * because a blank cannot be told apart from a missing asset or a broken export.
   *
   * The crop/border/effects treatment is plugins/image.js's, verbatim in intent:
   * cropInsetsToSource shrinks the quad AND contracts the source UV rect (a source
   * crop, not a stretch); the border decoration frames the CROPPED rect; effects
   * wrap OUTSIDE the border per render_gpu/effects.js's order rule.
   */
  emit(s, _targetWorldIR, world) {
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw
    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const box = { x: c.x, y: c.y, w: c.w, h: c.h };
    if (!hasCapture(s)) {
      // The SOURCE is passed so the placeholder can preview its first line — two
      // uncaptured widgets carrying different pages must not look identical.
      const shifted = uncapturedAffordance(c.w, c.h, s.html ?? "").map((op) => ({ ...op, x: op.x + c.x, y: op.y + c.y }));
      return applyEffects(decorateStrokedBox(shifted, style, world), s, world, box);
    }
    const quad = image({
      ref: s.capture, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1,
      sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh,
      // BILINEAR, unlike plugins/image.js's "nearest" default. A captured page is
      // antialiased type and gradients rendered at a fixed pixel size and then
      // scaled to an arbitrary world box — nearest-neighbour on that is visibly
      // chunky type. Nearest is right for pixel art and QR codes, which is what the
      // image widget's default is for; it is wrong for a screenshot of a document.
      sampling: "bilinear",
    });
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, box);
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    {
      id: "add-html2image",
      title: "Add HTML to Image",
      icon: "mdi:language-html5",
      // THE OLD NAME SURVIVES AS SEARCH, WHICH IS THE POINT OF ALIASES. The widget
      // was called "HTML Capture" for a day, and anyone who learned that word — or
      // read it in a note, or is following an older transcript — must still find it.
      // An alias is never displayed (core/commands.js), so the palette shows only
      // the correct name while both spellings match. "html2image" and "screenshot"
      // are here because they are what people actually type for this.
      aliases: ["html capture", "html2image", "html to png", "screenshot", "render html", "web page"],
      run: (app) => app.armCrosshairPlacement(html2imagePlugin),
    },
    {
      id: "capture-html",
      title: "Capture HTML to Image",
      icon: "mdi:camera-iris",
      aliases: ["capture html", "render html", "freeze html", "rasterize"],
      // GATED on the widget type, not merely on "a selection": this command writes
      // THIS plugin's own `capture` property and is meaningless anywhere else. An
      // ungated selection command answers an empty selection with an exception
      // instead of a greyed row — the defect tests/palette_probe.js sweeps for.
      when: (app) => app.selectedNode()?.type === "html2image",
      requires: "a selected HTML to Image widget — this freezes THAT widget's own source into its image asset",
      run: captureSelectedHtml,
    },
  ],
  // …AND IT REACHES THE TOOLS PANE. A gate is only half an affordance (the
  // tool-surfacing rule): the command rides this plugin's own Edit section rather
  // than living only in the palette. No `applies` is needed — a plugin's own group
  // is already scoped to this widget.
  toolGroups: [
    { id: "edit", rows: [{ kind: "command", command: "capture-html" }] },
  ],
};
