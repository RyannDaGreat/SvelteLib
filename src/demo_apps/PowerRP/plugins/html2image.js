/**
 * HTML TO IMAGE widget — author HTML/CSS and the widget RENDERS ITSELF into a stored
 * image, automatically, whenever that source changes. The html never executes at
 * playback: what the deck draws is always the stored picture.
 *
 * ── THE DETERMINISM ANSWER, FIRST, BECAUSE THE OLD FLOW MADE A READER GUESS WRONG ─
 * User, 2026-08-13, looking at the placeholder card: "wtf is this bullcrap? where's
 * the rendering? what the fuq do u mean press capture? that sounds like ephemeral
 * state?"
 *
 * THE EPHEMERAL ACCUSATION IS WRONG, IN A REASSURING DIRECTION, and the button flow
 * is what made it look otherwise. The rendered image is a STORED ASSET — ordinary
 * PROPERTY STATE (CLAUDE.md's four kinds). It is bytes in the project's asset
 * library, identical on every machine that opens the deck. PLAYBACK, PRESENTATION,
 * VIDEO EXPORT AND THE BARE-NODE CLI READ ONLY THAT IMAGE, never the html; not one of
 * them runs a browser, a script or this file's rendering path at all. Reload, export
 * and re-render on another machine all reproduce the same picture. What auto-render
 * changes is only WHEN THE EDITOR refreshes an asset the author owns — an authoring
 * action recorded in the document, exactly like re-rolling a particle seed.
 *
 * ── IT RENDERS ITSELF; THE COMMAND IS ONLY A NUDGE ──────────────────────────
 * User, amending: "i don't want to have to press capture. it should be automatic in
 * every way, when the html property changes so shohuld that."
 *
 * So THE TRIGGER IS THE PROPERTY. The widget stores the image AND a fingerprint of
 * the source it is a picture of (`captureOf`), which makes "is this picture current?"
 * a question about the DOCUMENT rather than about history — decidable on open, after
 * an undo, or on a deck someone else authored. core/html2image_staleness.js owns that
 * predicate; web/html2imageAutoRender.js owns the scheduling (debounced, serialized
 * per widget). OPENING A DECK RE-RENDERS what does not match, which the superseded
 * design refused to do; the containment argument for that is stated in the staleness
 * module's header and rests on the sandbox, not on a button.
 *
 * THE PLACEHOLDER IS THEREFORE RARE, not the resting state it used to be: it shows in
 * the seconds before the first render lands, and after one FAILED.
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
 * ── THE LAW: RENDER AT AUTHOR TIME, FROZEN AT PLAY ──────────────────────────
 * The widget stores THREE things: `html` (the source), `capture` (an ordinary image
 * asset ref) and `captureOf` (which source that image is a picture of). Rendering is
 * an AUTHORING-TIME action — it runs in the editor and writes the asset. Playback,
 * presentation, video export and the bare-node CLI read ONLY `capture`; not one of
 * them ever loads the html.
 *
 * (THE STORED KEYS STILL SAY "capture" AND THAT IS DELIBERATE. R7-43b retired the
 * word from every surface a user READS — the command is "Re-render HTML", the rows
 * are "Render width"/"Render height" — but a stored key is an internal term of art,
 * and renaming one would cost a document migration to change something invisible.)
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
 * SECURITY IS THE SANDBOX, AND IT NEVER WAS THE BUTTON. This paragraph used to end
 * "Opening someone else's deck executes nothing", which R7-43a made FALSE — arrival
 * now renders whatever does not match its fingerprint, so a stranger's html DOES run
 * on open. What contains it is what always contained it, and the button added nothing
 * to the list: an OPAQUE-ORIGIN frame (`sandbox="allow-scripts"` and nothing else, so
 * author script cannot reach this page's DOM, storage, cookies or project), a
 * FOREIGN-SUBRESOURCE REFUSAL that runs before the frame is created (so it cannot
 * phone home or pull code in), and a frame destroyed in a `finally` that is never part
 * of a render tree. web/html2image.js owns those rules in full.
 *
 * (The revert-the-doctrine rule, applied to this file: R7-43a overruled the
 * arrival-refusal design, so the sentence teaching it had to go in the SAME commit
 * that changed the code. Leaving it would have installed a confident lie in the
 * paragraph contributors are pointed at for the security argument.)
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

import { CAPTURE_OF_KEY, NO_FINGERPRINT, sourceFingerprint } from "../core/html2image_staleness.js";
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

/**
 * The placeholder's line, and BOTH of this round's rulings landed on it.
 *
 * IT NO LONGER NAMES A BUTTON. The old text was "Press Capture to render this HTML
 * into an image", which R7-43a made FALSE (the widget renders itself; nobody presses
 * anything) and R7-43b made unsayable ("wtf even is 'capture'?"). It now states what
 * the widget IS and what is about to happen, which is what the user asked the card to
 * do when he said the placeholder told him nothing he could act on.
 *
 * AND IT IS RARE NOW. Before, this card was what a widget looked like until you found
 * the button; today it appears only in the seconds before the first render lands, or
 * after a render FAILED — which is why it says "not rendered yet" rather than
 * describing a state the author has to leave by hand. A failure puts its own sentence
 * in the console and the service's `lastError`.
 *
 * A CONSTANT because it is asserted verbatim by tests/htmlcap_html2image_test.js.
 */
export const UNCAPTURED_MESSAGE =
  "HTML not rendered yet · double-click to edit the source";

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
 * ── THE PRESET LIBRARY (R7-39) ────────────────────────────────────────────────
 * "I don't know how to test this because it's very boring looking right now.
 * Because there's no presets." Thirteen READY-TO-CAPTURE designs — each a
 * complete, self-contained HTML/CSS source an author can drop in and press
 * Capture on immediately. This is the widget's first impression, so every
 * source aims for real typographic and colour quality rather than a placeholder
 * layout with a caption changed.
 *
 * EVERY PRESET WRITES EXACTLY `{html}` — the mermaid precedent
 * (plugins/mermaid.js: "each preset writes `definition` as one undo unit"),
 * applied to this widget's one meaningful leaf. Never the `capture` asset (that
 * would defeat the "capture is an explicit user action" law above), never
 * `captureW`/`captureH` (every design here is happy at the widget's own
 * DEFAULT_CAPTURE_W x DEFAULT_CAPTURE_H, so there is no same-key-set need to
 * open that door), and never a placement key.
 *
 * EACH SOURCE PASSES THE WIDGET'S OWN GUARDS: no external URL (foreignSubresources
 * in web/html2image.js would refuse it at capture time — everything here is inline
 * CSS, no CDN, no webfont, no remote image), and no backtick or `${` (these strings
 * live inside a JS template literal one scope up from DEFAULT_HTML, and the same
 * failure mode applies — a `${` would silently interpolate rather than render
 * literally, a backtick would close the literal early).
 *
 * EACH SOURCE'S FIRST LINE IS ITS OWN DISTINCT ROOT CLASS NAME
 * (`<div class="titlecard">`, `<div class="stattile">`, …). sourcePreview() above
 * shows exactly this line on an uncaptured widget, and it is the ONLY thing that
 * tells two uncaptured preset instances apart before either is captured — a
 * shared "<div class="wrap">" opener across presets would make every uncaptured
 * card in a deck look identical.
 */
const TITLE_CARD_HTML = `<div class="titlecard">
  <div class="eyebrow">Q3 Product Review</div>
  <h1>Everything We<br>Shipped This<br>Quarter</h1>
  <div class="rule"></div>
  <div class="sub">Design, Platform &amp; Growth &middot; August 2026</div>
</div>

<style>
  body { background: #0a0e1a; }
  .titlecard {
    box-sizing: border-box; height: 100%; padding: 64px 68px;
    display: flex; flex-direction: column; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #f4f6ff;
    background:
      radial-gradient(80% 120% at 85% -10%, rgba(236,72,153,0.35) 0%, rgba(236,72,153,0) 55%),
      radial-gradient(70% 100% at -10% 110%, rgba(59,130,246,0.30) 0%, rgba(59,130,246,0) 55%),
      linear-gradient(160deg, #12172b 0%, #090c16 100%);
  }
  .eyebrow {
    font-size: 16px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase;
    color: #f472b6; margin-bottom: 18px;
  }
  h1 {
    margin: 0; font-size: 64px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em;
  }
  .rule { width: 84px; height: 5px; border-radius: 3px; margin: 30px 0 20px;
    background: linear-gradient(90deg, #f472b6, #60a5fa); }
  .sub { font-size: 19px; color: #9aa3c7; font-weight: 500; }
</style>`;

const STAT_TILE_HTML = `<div class="stattile">
  <div class="label">Monthly Active Users</div>
  <div class="row">
    <div class="num">2.4<span class="unit">M</span></div>
    <div class="delta up">&#9650; 18.2%</div>
  </div>
  <div class="caption">vs. previous 30 days</div>
</div>

<style>
  body { background: #ffffff; }
  .stattile {
    box-sizing: border-box; height: 100%; padding: 40px 44px;
    display: flex; flex-direction: column; justify-content: center; gap: 14px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f7f8fc; border: 1px solid #e4e7f2; border-radius: 20px;
  }
  .label { font-size: 15px; font-weight: 600; color: #6b7290; letter-spacing: 0.02em; }
  .row { display: flex; align-items: baseline; gap: 16px; }
  .num { font-size: 76px; font-weight: 800; letter-spacing: -0.03em; color: #171a2e;
    font-variant-numeric: tabular-nums; }
  .unit { font-size: 34px; font-weight: 700; color: #4c5170; margin-left: 2px; }
  .delta { font-size: 17px; font-weight: 700; padding: 6px 12px; border-radius: 999px; }
  .delta.up { color: #15803d; background: #dcfce7; }
  .caption { font-size: 14px; color: #9297b3; }
</style>`;

const GRADIENT_QUOTE_HTML = `<div class="panel">
  <div class="mark">&#8220;</div>
  <p class="quote">Simplicity is the ultimate form of sophistication &mdash; and the hardest thing to keep.</p>
  <div class="attrib">
    <div class="dash"></div>
    <div class="who">Design Notes, Chapter 4</div>
  </div>
</div>

<style>
  body { background: #1a0b2e; }
  .panel {
    box-sizing: border-box; height: 100%; padding: 56px 60px;
    display: flex; flex-direction: column; justify-content: center;
    font-family: Georgia, "Times New Roman", serif; color: #fdf4ff;
    background: linear-gradient(135deg, #4c1d95 0%, #7e22ce 45%, #c026d3 100%);
  }
  .mark { font-family: Georgia, serif; font-size: 96px; line-height: 0.5; color: rgba(255,255,255,0.35);
    font-weight: 700; margin-bottom: 8px; }
  .quote { margin: 0; font-size: 36px; line-height: 1.35; font-style: italic; font-weight: 500; }
  .attrib { display: flex; align-items: center; gap: 16px; margin-top: 32px; }
  .dash { width: 40px; height: 2px; background: rgba(255,255,255,0.6); }
  .who { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px; letter-spacing: 0.08em;
    text-transform: uppercase; color: rgba(255,255,255,0.75); font-weight: 600; }
</style>`;

const CODE_SNIPPET_HTML = `<div class="codewin">
  <div class="titlebar">
    <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
    <span class="filename">fold.js</span>
  </div>
  <pre><code><span class="kw">export function</span> <span class="fn">foldDelta</span>(<span class="pr">state</span>, <span class="pr">delta</span>) {
  <span class="kw">const</span> next = { ...state };
  <span class="kw">for</span> (<span class="kw">const</span> [key, value] <span class="kw">of</span> <span class="pr">delta</span>) {
    next[key] = value;
  }
  <span class="kw">return</span> next;
}</code></pre>
</div>

<style>
  body { background: #0d1117; }
  .codewin {
    box-sizing: border-box; height: 100%; display: flex; flex-direction: column;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #0d1117; border: 1px solid #30363d; border-radius: 14px; overflow: hidden;
  }
  .titlebar { display: flex; align-items: center; gap: 8px; padding: 14px 18px;
    background: #161b22; border-bottom: 1px solid #30363d; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot.red { background: #ff5f57; } .dot.yellow { background: #febc2e; } .dot.green { background: #28c840; }
  .filename { margin-left: 10px; font-size: 13px; color: #8b949e; font-weight: 500; }
  pre { margin: 0; padding: 26px 28px; flex: 1; overflow: hidden; }
  code { font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 17px; line-height: 1.65; color: #c9d1d9; white-space: pre; }
  .kw { color: #ff7b72; } .fn { color: #d2a8ff; } .pr { color: #79c0ff; }
</style>`;

const COMPARISON_TABLE_HTML = `<div class="comparecard">
  <table>
    <thead>
      <tr><th class="row-label"></th><th>Starter</th><th class="hi">Pro</th></tr>
    </thead>
    <tbody>
      <tr><td class="row-label">Projects</td><td>3</td><td class="hi">Unlimited</td></tr>
      <tr><td class="row-label">Exports</td><td>720p</td><td class="hi">4K</td></tr>
      <tr><td class="row-label">Collaborators</td><td>1</td><td class="hi">10</td></tr>
      <tr><td class="row-label">Support</td><td>Community</td><td class="hi">Priority</td></tr>
    </tbody>
  </table>
</div>

<style>
  body { background: #f1f2f7; }
  .comparecard {
    box-sizing: border-box; height: 100%; padding: 30px;
    display: flex; align-items: center;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  table { width: 100%; border-collapse: collapse; background: #ffffff; border-radius: 16px;
    overflow: hidden; box-shadow: 0 1px 0 #e3e5ef; }
  th, td { padding: 16px 20px; text-align: center; font-size: 16px; }
  .row-label { text-align: left; color: #6b7290; font-weight: 600; font-size: 14px; }
  thead th { font-size: 15px; font-weight: 700; color: #2c2f45; border-bottom: 2px solid #edeef5; }
  thead th.hi { color: #ffffff; background: #4338ca; }
  tbody td { border-bottom: 1px solid #edeef5; color: #454969; font-weight: 500; }
  tbody tr:last-child td { border-bottom: none; }
  tbody td.hi { background: #eef0ff; color: #3730a3; font-weight: 700; }
</style>`;

const BADGE_ROW_HTML = `<div class="badgerow">
  <div class="title">Built With</div>
  <div class="badges">
    <span class="badge b1">Svelte 5</span>
    <span class="badge b2">WebGL2</span>
    <span class="badge b3">Skia</span>
    <span class="badge b4">Vite</span>
    <span class="badge b5">Node</span>
    <span class="badge b6">Python</span>
  </div>
</div>

<style>
  body { background: #ffffff; }
  .badgerow {
    box-sizing: border-box; height: 100%; padding: 40px;
    display: flex; flex-direction: column; justify-content: center; gap: 22px;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .title { font-size: 14px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
    color: #9297b3; }
  .badges { display: flex; flex-wrap: wrap; gap: 12px; }
  .badge { padding: 11px 20px; border-radius: 999px; font-size: 16px; font-weight: 700; }
  .b1 { background: #fde2e2; color: #b91c1c; }
  .b2 { background: #dbeafe; color: #1d4ed8; }
  .b3 { background: #dcfce7; color: #15803d; }
  .b4 { background: #ede9fe; color: #6d28d9; }
  .b5 { background: #fef3c7; color: #92400e; }
  .b6 { background: #cffafe; color: #0e7490; }
</style>`;

const TIMELINE_HTML = `<div class="timeline">
  <div class="step">
    <div class="dot done"></div>
    <div class="body"><div class="t">Research</div><div class="d">Interviews &amp; competitive audit</div></div>
  </div>
  <div class="step">
    <div class="dot done"></div>
    <div class="body"><div class="t">Prototype</div><div class="d">Three directions, one validated</div></div>
  </div>
  <div class="step">
    <div class="dot active"></div>
    <div class="body"><div class="t">Build</div><div class="d">In progress &mdash; 60% complete</div></div>
  </div>
  <div class="step">
    <div class="dot pending"></div>
    <div class="body"><div class="t">Launch</div><div class="d">Targeting next quarter</div></div>
  </div>
</div>

<style>
  body { background: #ffffff; }
  .timeline {
    box-sizing: border-box; height: 100%; padding: 40px 44px;
    display: flex; flex-direction: column; justify-content: center; gap: 0;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .step { display: flex; gap: 20px; position: relative; padding-bottom: 34px; }
  .step:not(:last-child)::before {
    content: ""; position: absolute; left: 9px; top: 22px; bottom: 0; width: 2px; background: #e2e4f0;
  }
  .dot { width: 20px; height: 20px; border-radius: 50%; flex: none; margin-top: 2px;
    border: 3px solid #e2e4f0; background: #ffffff; }
  .dot.done { background: #16a34a; border-color: #16a34a; }
  .dot.active { background: #ffffff; border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,0.15); }
  .t { font-size: 19px; font-weight: 700; color: #171a2e; }
  .d { font-size: 15px; color: #767b9c; margin-top: 3px; }
</style>`;

const KANBAN_COLUMN_HTML = `<div class="col">
  <div class="head"><span class="dot"></span>In Progress<span class="count">3</span></div>
  <div class="card">
    <div class="tag tag-design">Design</div>
    <div class="ctitle">Onboarding flow redesign</div>
    <div class="meta">Due Fri &middot; 2 comments</div>
  </div>
  <div class="card">
    <div class="tag tag-eng">Engineering</div>
    <div class="ctitle">Migrate asset store to v2</div>
    <div class="meta">Due Mon &middot; 5 comments</div>
  </div>
  <div class="card">
    <div class="tag tag-copy">Copy</div>
    <div class="ctitle">Rewrite empty states</div>
    <div class="meta">No due date</div>
  </div>
</div>

<style>
  body { background: #eef0f6; }
  .col {
    box-sizing: border-box; height: 100%; padding: 22px;
    display: flex; flex-direction: column; gap: 14px;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .head { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 700;
    color: #454969; text-transform: uppercase; letter-spacing: 0.05em; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #f59e0b; }
  .count { margin-left: auto; background: #dfe1ee; color: #6b7290; font-size: 13px; font-weight: 700;
    padding: 2px 9px; border-radius: 999px; }
  .card { background: #ffffff; border-radius: 12px; padding: 16px 18px;
    box-shadow: 0 1px 3px rgba(20,22,40,0.08); display: flex; flex-direction: column; gap: 8px; }
  .tag { align-self: flex-start; font-size: 11px; font-weight: 800; padding: 3px 9px; border-radius: 6px;
    text-transform: uppercase; letter-spacing: 0.04em; }
  .tag-design { background: #ede9fe; color: #6d28d9; }
  .tag-eng { background: #dbeafe; color: #1d4ed8; }
  .tag-copy { background: #fce7f3; color: #be185d; }
  .ctitle { font-size: 15.5px; font-weight: 600; color: #1f2238; line-height: 1.3; }
  .meta { font-size: 12.5px; color: #9297b3; }
</style>`;

const GLASS_PANEL_HTML = `<div class="scene">
  <div class="glass">
    <div class="icon">&#9729;</div>
    <div class="title">Cloud Sync</div>
    <div class="body">Every change saves automatically and syncs across your devices in real time.</div>
  </div>
</div>

<style>
  body { background: #0a1128; }
  .scene {
    box-sizing: border-box; height: 100%; padding: 46px;
    display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(60% 80% at 20% 20%, rgba(56,189,248,0.55) 0%, rgba(56,189,248,0) 60%),
      radial-gradient(60% 80% at 85% 80%, rgba(168,85,247,0.5) 0%, rgba(168,85,247,0) 60%),
      linear-gradient(160deg, #0a1128 0%, #0d0620 100%);
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .glass {
    width: 100%; box-sizing: border-box; padding: 38px 40px; border-radius: 24px;
    background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.35);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 20px 50px rgba(0,0,0,0.35);
    color: #ffffff;
  }
  .icon { font-size: 40px; margin-bottom: 14px; }
  .title { font-size: 28px; font-weight: 800; margin-bottom: 10px; }
  .body { font-size: 16px; line-height: 1.55; color: rgba(255,255,255,0.85); max-width: 34ch; }
</style>`;

const RECEIPT_HTML = `<div class="paper">
  <div class="shop">SLIDE &amp; CO.</div>
  <div class="addr">142 Presentation Ave &middot; Vector City</div>
  <div class="tear"></div>
  <div class="line"><span>Deck Template</span><span>$0.00</span></div>
  <div class="line"><span>Widget Presets x12</span><span>$0.00</span></div>
  <div class="line"><span>Render Time</span><span>0.67s</span></div>
  <div class="tear"></div>
  <div class="line total"><span>TOTAL</span><span>$0.00</span></div>
  <div class="thanks">THANK YOU FOR RENDERING</div>
</div>

<style>
  body { background: #d8dae0; }
  .paper {
    box-sizing: border-box; height: 100%; padding: 30px 34px;
    display: flex; flex-direction: column; gap: 10px;
    background: #fdfdf8; color: #26261f;
    font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 15px;
  }
  .shop { font-size: 20px; font-weight: 700; letter-spacing: 0.06em; text-align: center; }
  .addr { text-align: center; font-size: 12px; color: #6b6b5e; margin-bottom: 4px; }
  .tear { border-top: 2px dashed #b9b9a8; margin: 6px 0; }
  .line { display: flex; justify-content: space-between; }
  .line.total { font-weight: 700; font-size: 17px; }
  .thanks { text-align: center; font-size: 12px; letter-spacing: 0.1em; color: #8a8a78; margin-top: 8px; }
</style>`;

const TERMINAL_HTML = `<div class="term">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="tabname">zsh &mdash; 80x24</span></div>
  <div class="body">
    <div class="ln"><span class="prompt">&#10095;</span> npm run build</div>
    <div class="ln out">vite v5.4.0 building for production...</div>
    <div class="ln out ok">&#10003; 214 modules transformed.</div>
    <div class="ln out ok">&#10003; built in 1.82s</div>
    <div class="ln"><span class="prompt">&#10095;</span> <span class="cursor">&#9608;</span></div>
  </div>
</div>

<style>
  body { background: #000000; }
  .term {
    box-sizing: border-box; height: 100%; display: flex; flex-direction: column;
    background: #161821; border-radius: 12px; overflow: hidden;
    font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
    border: 1px solid #2a2d3a;
  }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #1e2130; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .dot.r { background: #ff5f57; } .dot.y { background: #febc2e; } .dot.g { background: #28c840; }
  .tabname { margin-left: 8px; font-size: 12px; color: #6b7185; }
  .body { flex: 1; padding: 20px 22px; display: flex; flex-direction: column; gap: 9px; }
  .ln { font-size: 16px; color: #dfe2f0; }
  .prompt { color: #4ade80; margin-right: 8px; }
  .out { color: #8b91ab; padding-left: 26px; }
  .out.ok { color: #4ade80; }
  .cursor { color: #dfe2f0; }
</style>`;

const CHART_BARS_HTML = `<div class="barschart">
  <div class="head">Quarterly Revenue</div>
  <div class="chart">
    <div class="bar" style="height:38%"><span class="v">$1.2M</span></div>
    <div class="bar" style="height:52%"><span class="v">$1.7M</span></div>
    <div class="bar" style="height:47%"><span class="v">$1.5M</span></div>
    <div class="bar hi" style="height:88%"><span class="v">$2.9M</span></div>
  </div>
  <div class="labels"><span>Q1</span><span>Q2</span><span>Q3</span><span>Q4</span></div>
</div>

<style>
  body { background: #ffffff; }
  .barschart {
    box-sizing: border-box; height: 100%; padding: 34px 38px;
    display: flex; flex-direction: column;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .head { font-size: 15px; font-weight: 700; color: #454969; margin-bottom: 20px; }
  .chart { flex: 1; min-height: 0; display: flex; align-items: flex-end; gap: 22px; }
  .bar { flex: 1; border-radius: 8px 8px 3px 3px; background: linear-gradient(180deg, #93c5fd, #3b82f6);
    position: relative; display: flex; justify-content: center; }
  .bar.hi { background: linear-gradient(180deg, #6ee7b7, #10b981); }
  .v { position: absolute; top: -26px; font-size: 13px; font-weight: 700; color: #2c2f45; white-space: nowrap; }
  .labels { display: flex; gap: 22px; margin-top: 10px; }
  .labels span { flex: 1; text-align: center; font-size: 13px; color: #9297b3; font-weight: 600; }
</style>`;

const PROFILE_CARD_HTML = `<div class="profilecard">
  <div class="avatar">MK</div>
  <div class="name">Maya Kessler</div>
  <div class="role">Senior Product Designer</div>
  <div class="stats">
    <div class="stat"><div class="n">47</div><div class="l">Projects</div></div>
    <div class="stat"><div class="n">312</div><div class="l">Reviews</div></div>
    <div class="stat"><div class="n">4.9</div><div class="l">Rating</div></div>
  </div>
</div>

<style>
  body { background: #f4f2ee; }
  .profilecard {
    box-sizing: border-box; height: 100%; padding: 40px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #ffffff; border-radius: 22px; border: 1px solid #eae7df;
  }
  .avatar { width: 88px; height: 88px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 30px; font-weight: 800; color: #ffffff;
    background: linear-gradient(135deg, #fb923c, #ec4899); margin-bottom: 6px; }
  .name { font-size: 23px; font-weight: 800; color: #201d18; }
  .role { font-size: 15px; color: #8a8577; margin-bottom: 18px; }
  .stats { display: flex; gap: 34px; padding-top: 18px; border-top: 1px solid #eee9df; width: 100%;
    justify-content: center; }
  .stat { text-align: center; }
  .n { font-size: 22px; font-weight: 800; color: #201d18; }
  .l { font-size: 12px; color: #a39c8a; font-weight: 600; margin-top: 2px; }
</style>`;

/**
 * THE THIRTEEN, IN GALLERY ORDER. Text/marketing cards first (the widget's most
 * obvious use), then data-shaped cards, then the more illustrative/textured ones
 * — an author scanning top-to-bottom meets the safest, most broadly useful
 * layouts first.
 */
const PRESETS = [
  { name: "Title Card", description: "A hero title slide over a layered dark gradient — an eyebrow line, a big multi-line headline and a short subtitle.", props: { html: TITLE_CARD_HTML } },
  { name: "Stat Tile", description: "A single big metric with a unit and an up/down delta pill, on a soft card — the shape a dashboard KPI tile actually takes.", props: { html: STAT_TILE_HTML } },
  { name: "Gradient Quote", description: "A pull-quote in serif italic over a violet-to-magenta gradient, with an oversized opening quotation mark and an attribution line.", props: { html: GRADIENT_QUOTE_HTML } },
  { name: "Code Snippet Card", description: "A macOS-style code window — traffic-light dots, a filename tab, and a hand-colored JetBrains Mono snippet (keywords, function names, parameters each their own color).", props: { html: CODE_SNIPPET_HTML } },
  { name: "Comparison Table", description: "A two-plan pricing/feature comparison table with the higher tier's column highlighted in a solid accent color.", props: { html: COMPARISON_TABLE_HTML } },
  { name: "Badge Row", description: "A row of wrapping pill badges, each its own hue, for naming a stack of tools or tags at a glance.", props: { html: BADGE_ROW_HTML } },
  { name: "Timeline", description: "A vertical step timeline — done, active and pending stages linked by a connecting rail, each with a title and a one-line note.", props: { html: TIMELINE_HTML } },
  { name: "Kanban Column", description: "A single Trello-style board column: a header with a live count, stacked task cards each carrying a colored category tag and metadata line.", props: { html: KANBAN_COLUMN_HTML } },
  { name: "Glassmorphic Panel", description: "A frosted-glass panel — translucent fill, a bright border and an inner highlight — floating over a two-tone glow backdrop.", props: { html: GLASS_PANEL_HTML } },
  { name: "Receipt", description: "A monospace paper receipt with dashed tear lines between sections and a line-item total, styled like a point-of-sale printout.", props: { html: RECEIPT_HTML } },
  { name: "Terminal Window", description: "A dark terminal window with traffic-light dots, a tab title and a colored command/output transcript ending on a blinking-style cursor glyph.", props: { html: TERMINAL_HTML } },
  { name: "Chart-ish Bars", description: "A small quarterly bar chart built from pure CSS flex bars (no chart library, no canvas) with value labels and a highlighted final bar.", props: { html: CHART_BARS_HTML } },
  { name: "Profile Card", description: "A centered contact/profile card — initials avatar, name, role and a row of three stat counters below a divider.", props: { html: PROFILE_CARD_HTML } },
];

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
  if (id == null) throw new Error("Re-render HTML: select an HTML to Image widget first");
  const state = app.state().items[id];
  if (state?.type !== html2imagePlugin.type)
    throw new Error(`Re-render HTML: the selection is a "${state?.type}" widget, not an HTML to Image — this command re-renders THIS widget's own source.`);
  const { captureHtmlToAsset } = await import("../web/html2image.js");
  const width = state.captureW ?? DEFAULT_CAPTURE_W;
  const height = state.captureH ?? DEFAULT_CAPTURE_H;
  const ref = await captureHtmlToAsset(app, { html: state.html ?? "", width, height });
  // BOTH LEAVES, IN ONE COMMIT — the image AND the fingerprint of the source it is a
  // picture of. Writing only the ref (which is what this did before the auto-renderer
  // existed) would leave the widget permanently STALE by
  // core/html2image_staleness.js's predicate, so the watcher would immediately
  // re-render what the author had just rendered by hand, forever. The manual nudge
  // and the automatic path must agree about provenance or they fight.
  app.setPreview([
    [["items", id, "capture"], ref],
    [["items", id, CAPTURE_OF_KEY], sourceFingerprint({ html: state.html ?? "", captureW: width, captureH: height })],
  ]);
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
  // THE PRESET LIBRARY (R7-39) — see the big comment above PRESETS for the law
  // each row obeys. ONE FLAT array, the qrcode.js declaration form: no family
  // split is needed because every row here writes the same single key (`html`).
  presets: PRESETS,
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // shared full-screen Monaco editor on the `html` source. The "code_modal"
  // precedent exactly — this widget carries no editor UI of its own.
  activate: "code_modal",
  // THE code-editor descriptor both the "code_modal" activation and the `{}` row
  // button read: WHICH string is the source, in what Monaco language, and the
  // modal's title.
  // The title no longer instructs anyone to press anything: saving this editor IS
  // what re-renders the widget (R7-43a), so "(then press Capture)" described a step
  // that no longer exists and named a word the user rejected (R7-43b).
  codeEditor: { property: "html", language: "html", title: "Edit HTML source" },
  defaults: {
    type: "html2image", x: 100, y: 100, w: 480, h: 270, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    html: DEFAULT_HTML,
    // THE RENDERED OUTPUT. Empty on arrival and filled in moments later by the
    // auto-renderer (web/html2imageAutoRender.js) — see UNCAPTURED.
    capture: UNCAPTURED,
    // WHICH SOURCE that image is a picture of (core/html2image_staleness.js). Empty
    // here BY DEFINITION: a fresh widget has no picture, so it has no provenance, and
    // that is exactly the state the staleness predicate reads as "render me". It is
    // declared rather than left absent so the leaf has a default like every other and
    // repairedDocument has nothing to report.
    [CAPTURE_OF_KEY]: NO_FINGERPRINT,
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
    { key: "html", label: "HTML", kind: "text", category: "text", code: { language: "html" }, help: "The HTML source this widget draws. Edit it and the widget re-renders itself automatically — the source runs in a sandboxed frame at authoring time only, never during playback or export, which is what makes the deck reproduce identically everywhere. Inline <style>/<script>/<svg> and data: URIs work; a subresource from another origin (a CDN script, a remote font or image) is refused loudly rather than rendered half-loaded." },
    // The RENDER's pixel size — the resolution of the stored image, not the widget's
    // world size (see DEFAULT_CAPTURE_W). Raising these re-renders automatically;
    // resizing the widget alone just scales the existing picture.
    //
    // THE KEYS STAY `captureW`/`captureH` AND THE LABELS DO NOT (user, R7-43b: "wtf
    // even is 'capture'?"). The ruling is about the words a user READS; a stored key
    // is an internal term of art nobody reads, and churning one would cost a document
    // migration to rename something invisible. So the label is the fix and the key is
    // deliberately left alone.
    { key: "captureW", label: "Render width", kind: "number", category: "formatting", help: "Pixel width the HTML is rendered at. This is the stored image's resolution, NOT the widget's size on the canvas — resize the widget freely and the picture just scales. Raise this when the picture looks soft; it re-renders on its own." },
    { key: "captureH", label: "Render height", kind: "number", category: "formatting", help: "Pixel height the HTML is rendered at. Same rule as Render width: it sets the stored image's resolution, not the widget's canvas size." },
    // THE RENDERED IMAGE ITSELF, surfaced as an ordinary asset row so the author can
    // SEE which asset the widget is drawing (and repoint it at a different one, which
    // is a legitimate edit). It is written by the auto-renderer, not typed.
    { key: "capture", label: "Rendered image", kind: "asset", assetKinds: ["image"], assetForm: "url", category: "formatting", help: "The image this widget actually draws, written into the project's assets when the HTML is rendered. This, not the HTML, is what playback, video export and the CLI renderer read — which is why a deck renders identically on a machine that never runs the source." },
    // The action row for the MANUAL re-render. It is no longer how a picture normally
    // arrives (the widget renders itself); it stays as the nudge for re-running a
    // render that failed, or one whose source is unchanged but whose result you want
    // taken again in this browser.
    { key: "__captureHtml", label: "Re-render", kind: "action", command: "capture-html", category: "formatting", help: "Render this HTML again right now. The widget already re-renders itself whenever the HTML or the render size changes, so this is only needed to retry after a failure — or to take the picture again in this browser." },
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
      // THE ID STAYS `capture-html` — it is an identifier, not copy: it is written
      // into toolGroups above, into tests, and possibly into someone's notes. R7-43b
      // is about the words a user READS.
      id: "capture-html",
      // "Re-render", not "Capture" (user, R7-43b: "wtf even is 'capture'?"), and
      // "re-", not a bare "Render", because the widget renders ITSELF now (R7-43a):
      // this command is the manual nudge for a render that already should have
      // happened, so a title promising the primary way to get a picture would be a
      // lie about what the button is for.
      title: "Re-render HTML",
      icon: "mdi:camera-iris",
      // THE OLD WORD SURVIVES AS SEARCH, WHICH IS THE POINT OF ALIASES. An alias is
      // never displayed (core/commands.js), so the palette shows only the new name
      // while anyone whose muscle memory or notes say "capture" still finds it.
      aliases: ["capture", "capture html", "html capture", "render html", "freeze html", "rasterize", "re-render"],
      // GATED on the widget type, not merely on "a selection": this command writes
      // THIS plugin's own image property and is meaningless anywhere else. An
      // ungated selection command answers an empty selection with an exception
      // instead of a greyed row — the defect tests/palette_probe.js sweeps for.
      when: (app) => app.selectedNode()?.type === "html2image",
      requires: "a selected HTML to Image widget — this re-renders THAT widget's own source into its image",
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
