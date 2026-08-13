/**
 * HTML CAPTURE widget — author HTML/CSS, press Capture, and what the deck renders
 * from then on is a FROZEN IMAGE. The html never executes at playback.
 *
 * ── THE ASK, AND WHY THE ANSWER IS A CAPTURE AND NOT A RENDERER ──────────────
 * User, on the idea of teaching PowerRP to lay out CSS: "CSS is complex. You're
 * suggesting we port all of CSS too?? Hmmm..... what if we have html2image as a
 * widget. And it exports SVG. But then what if we wanted to use common livs like
 * chartjs to make our output is that possible? or is that asking too much"
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
 * sandboxed frame that is destroyed immediately afterwards (web/htmlCapture.js
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
 * The capture runs with NO NETWORK: web/htmlCapture.js REFUSES a source with
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

/** The HTML a freshly inserted widget carries — a real, self-contained page that
 * captures successfully on the first press, so the widget's whole loop (edit →
 * capture → frozen image) is demonstrated by inserting one. Inline style only: it
 * is also the worked example of the no-foreign-subresource rule. */
export const DEFAULT_HTML = `<div style="font-family: system-ui, sans-serif; padding: 24px;
     background: linear-gradient(135deg, #4f46e5, #06b6d4); color: white; height: 100%;
     box-sizing: border-box; display: flex; flex-direction: column; justify-content: center;">
  <h1 style="margin: 0 0 8px; font-size: 40px;">Hello from HTML</h1>
  <p style="margin: 0; opacity: 0.85; font-size: 18px;">
    Edit this source, then press Capture. The picture is frozen into an image asset —
    this markup never runs during playback.
  </p>
</div>`;

/** The capture's pixel size, and therefore the resolution ceiling of the frozen
 * asset. 1280x720 because it is the common 16:9 authoring size and matches the
 * default widget box's aspect, so the first capture is not letterboxed. Separate
 * from `w`/`h` (the widget's WORLD size) on purpose: the box can be resized freely
 * afterwards without re-capturing, and a user who wants more detail raises these
 * rather than making the widget bigger. */
export const DEFAULT_CAPTURE_W = 1280;
export const DEFAULT_CAPTURE_H = 720;

/** Placeholder colours — an AMBER "unfinished", deliberately NOT the red that
 * plugins/mermaid.js and plugins/latex.js use for a parse ERROR. An uncaptured
 * widget is not broken; it is a step the author has not taken yet, and painting it
 * the same as a syntax error would cry wolf. Literal because emit() is DOM-free
 * and cannot read app.css's --a-* tokens (mermaid's affordance says the same).
 * Redeclared rather than imported: no plugin may import another plugin. */
const PLACEHOLDER_BG = "#fdf1d6";
const PLACEHOLDER_BORDER = "#b7791f";
const PLACEHOLDER_TEXT = "#7c4a03";
/** Border thickness (canvas units) — thicker than a hairline so the frame reads as
 * a deliberate state and not as a widget's ordinary 1px border. */
const PLACEHOLDER_BORDER_WIDTH = 3;
/** Message inset from the box edge, and the text size as a fraction of the box
 * height, capped so a tall widget does not mint giant type. Mermaid's affordance
 * uses the same three-value shape for the same reason. */
const PLACEHOLDER_PADDING = 10;
const PLACEHOLDER_TEXT_FRACTION = 0.14;
const PLACEHOLDER_TEXT_MAX = 18;

/** The sentence the placeholder shows. A CONSTANT because it is asserted verbatim
 * by tests/htmlcap_test.js — the whole point of the placeholder is that it names
 * the action, so a future edit that reduces it to "not captured" should fail. */
export const UNCAPTURED_MESSAGE =
  "HTML not captured yet — press Capture HTML (double-click to edit the source first).";

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
 * Pure function. The LOUD in-widget "not captured yet" affordance: an amber
 * bordered box across the widget's local bbox plus the sentence naming what to do.
 * Vector ops (rect + text), so it is crisp and shows IDENTICALLY in every backend
 * — the GPU, PDF, SVG and the bare-node CLI alike.
 *
 * It exists because the alternative is the failure mode this codebase forbids: an
 * uncaptured widget that draws nothing looks exactly like a captured one whose
 * asset went missing, and a deck exported with one in it would ship a hole that
 * exited 0.
 *
 * Args:
 *   w, h (number): the widget's local box size, in canvas units
 *
 * Returns:
 *   object[]: IR ops — [the amber box, the message]
 *
 * @example uncapturedAffordance(300, 200).length
 * 2
 * @example uncapturedAffordance(300, 200)[0].op
 * 'rect'
 * @example uncapturedAffordance(300, 200)[1].text.startsWith("HTML not captured yet")
 * true
 */
export function uncapturedAffordance(w, h) {
  const box = rect({
    x: 0, y: 0, w, h, cornerRadius: 0,
    fill: PLACEHOLDER_BG, stroke: PLACEHOLDER_BORDER, strokeWidth: PLACEHOLDER_BORDER_WIDTH,
  });
  const size = Math.max(1, Math.min(PLACEHOLDER_TEXT_MAX, h * PLACEHOLDER_TEXT_FRACTION));
  const label = text({
    text: UNCAPTURED_MESSAGE,
    x: PLACEHOLDER_PADDING, y: PLACEHOLDER_PADDING,
    size, color: PLACEHOLDER_TEXT,
    boxW: Math.max(1, w - 2 * PLACEHOLDER_PADDING),
    boxH: Math.max(1, h - 2 * PLACEHOLDER_PADDING),
  });
  return [box, label];
}

/**
 * Command (async; browser-only). Captures the SELECTED widget's `html` to an image
 * asset and writes the ref onto `capture` as one undo unit.
 *
 * THE DYNAMIC IMPORT IS REQUIRED, not stylistic: this plugin file is reached from
 * plugins/index.js's static import chain, which the bare-node test suites and
 * cli/render.js both walk. web/htmlCapture.js touches `document`, so a static
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
  if (id == null) throw new Error("Capture HTML: select an HTML Capture widget first");
  const state = app.state().items[id];
  if (state?.type !== htmlCapturePlugin.type)
    throw new Error(`Capture HTML: the selection is a "${state?.type}" widget, not an HTML Capture — this command writes THIS widget's own captured asset.`);
  const { captureHtmlToAsset } = await import("../web/htmlCapture.js");
  const ref = await captureHtmlToAsset(app, {
    html: state.html ?? "",
    width: state.captureW ?? DEFAULT_CAPTURE_W,
    height: state.captureH ?? DEFAULT_CAPTURE_H,
  });
  app.setPreview([[["items", id, "capture"], ref]]);
  app.commitPreview();
}

export const htmlCapturePlugin = {
  type: "html_capture",
  // CONVERGES, on the STORED asset and nothing else — the same declaration
  // plugins/image.js makes, because after the capture this widget IS an image
  // widget. That is the whole dividend of the capture-at-author-time law: the
  // thing an exporter must wait for is a bitmap decode with a deterministic
  // limit, NOT a host browser laying out a page. Contrast the video PLAYER, the
  // one EPHEMERAL.NEVER inhabitant — a LIVE html frame would have been a second
  // one, and this widget exists specifically so it is not.
  ephemeral: convergesOnRefs((s) => [s.capture]),
  title: "HTML Capture",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): open the
  // shared full-screen Monaco editor on the `html` source. The "code_modal"
  // precedent exactly — this widget carries no editor UI of its own.
  activate: "code_modal",
  // THE code-editor descriptor both the "code_modal" activation and the `{}` row
  // button read: WHICH string is the source, in what Monaco language, and the
  // modal's title.
  codeEditor: { property: "html", language: "html", title: "Edit HTML source (then press Capture HTML)" },
  defaults: {
    type: "html_capture", x: 100, y: 100, w: 480, h: 270, z: 0, rotation: 0, scale: 1,
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
    { key: "html", label: "HTML", kind: "text", category: "text", code: { language: "html" }, help: "The HTML source this widget captures. It runs ONLY when you press Capture HTML, in a sandboxed frame, and never during playback or export — the deck renders the captured image. Inline <style>/<script>/<svg> and data: URIs work; a subresource from another origin (a CDN script, a remote font or image) is refused loudly rather than captured half-loaded." },
    // The capture's PIXEL size — the resolution of the frozen asset, not the
    // widget's world size (see DEFAULT_CAPTURE_W). Raising these and re-capturing
    // is how you get more detail; resizing the widget alone just scales the image.
    { key: "captureW", label: "Capture width", kind: "number", category: "formatting", help: "Pixel width the HTML is rendered and rasterized at. This is the captured image's resolution, NOT the widget's size on the canvas — resize the widget freely without re-capturing. Raise it (and press Capture HTML again) when the frozen picture looks soft." },
    { key: "captureH", label: "Capture height", kind: "number", category: "formatting", help: "Pixel height the HTML is rendered and rasterized at. Same rule as Capture width: it sets the frozen image's resolution, not the widget's canvas size." },
    // THE CAPTURE ITSELF, surfaced read-only-ish as an ordinary asset row so the
    // author can SEE which asset the widget is frozen to (and repoint it at a
    // different one, which is a legitimate edit). It is written by the command
    // below, not typed.
    { key: "capture", label: "Captured image", kind: "asset", assetKinds: ["image"], assetForm: "url", category: "formatting", help: "The frozen image this widget actually draws — written by Capture HTML into the project's assets. This, not the HTML, is what playback, video export and the CLI renderer read. Empty until the first capture, which is when the widget shows its amber 'not captured yet' box." },
    // The action row that runs the capture, so the command is reachable without
    // the palette (the tool-surfacing rule: a gate is only half an affordance).
    { key: "__captureHtml", label: "Capture HTML", kind: "action", command: "capture-html", category: "formatting", help: "Render the HTML source right now, in this browser, and freeze the result into an image asset the deck will use from here on. This is the ONLY moment the source executes." },
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
      const shifted = uncapturedAffordance(c.w, c.h).map((op) => ({ ...op, x: op.x + c.x, y: op.y + c.y }));
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
    { id: "add-html-capture", title: "Add HTML Capture", icon: "mdi:language-html5", run: (app) => app.armCrosshairPlacement(htmlCapturePlugin) },
    {
      id: "capture-html",
      title: "Capture HTML",
      icon: "mdi:camera-iris",
      // GATED on the widget type, not merely on "a selection": this command writes
      // THIS plugin's own `capture` property and is meaningless anywhere else. An
      // ungated selection command answers an empty selection with an exception
      // instead of a greyed row — the defect tests/palette_probe.js sweeps for.
      when: (app) => app.selectedNode()?.type === "html_capture",
      requires: "a selected HTML Capture widget — this freezes THAT widget's own source into its image asset",
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
