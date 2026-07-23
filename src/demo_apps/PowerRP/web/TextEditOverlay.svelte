<!--
  TextEditOverlay — the WYSIWYG in-place rich-text editor (Round 13.4).

  THE PROBLEM (user critique of the old dblclick <textarea> stopgap): it was "not
  WYSIWYG — it creates this background on top of the text". What the user LOVED
  and must be KEPT: "it does feel like native browser text editing... wonderful".

  THE DESIGN (transparent-overlay rewrite, render-rewrite-skia): the SKIA canvas
  render is what the user SEES while editing — CanvasView no longer suppresses the
  edited item, so its shadow/glow/border/exact layout are live and update per
  keystroke (app.previewTextValue → previewDelta → the reactive Skia paint). This
  `contenteditable` div is positioned in CANVAS SPACE and CSS-transformed by the
  edited item's FULL world transform (rotation + scale) so it overlays the item
  PIXEL-FOR-PIXEL, but its TEXT is TRANSPARENT (app.css): it contributes ONLY the
  native caret/selection/IME/spellcheck — the visible glyphs are Skia's. The div's
  internal coordinates are the item's LOCAL space: font-size = each run's own
  `size` (world units), width = the box width `w`, `white-space: pre-wrap`. Because
  both the browser here and the shared pure layout (core/richtext) measure the SAME
  faces at the SAME sizes and wrap at the SAME width, the transparent caret and
  selection track the visible Skia glyphs closely; and because Skia is what shows
  both DURING and AFTER edit, there is no exit "jump".

  Native caret/selection/IME behavior is the browser's own (the part the user
  loved). Rich per-character style (bold/italic/underline/strike/color/size/font/
  OUTLINE/HIGHLIGHT) is stored as RUNS (core/richtext); this component serializes
  runs ⇄ styled <span>s both ways — the inline span styles are read back verbatim
  (el.style.*), so the transparent painting in app.css never disturbs the round-
  trip. Selection-range style edits (the floating toolbar + Ctrl/Cmd+B/I/U + Cmd±)
  go through core/richtext.applyRunStyle and the app preview/commit system as ONE
  undo unit.

  Styling lives in app.css (.text-edit-overlay*; app convention: no <style>).
-->
<script module>
  import { runFrom, RUN_STYLE_KEYS } from "../core/richtext.js";
  import { cssFamilyFor } from "../render_gpu/fonts.js";

  /**
   * Pure function. The inline CSS text for a run's character style — the SAME
   * visual the GPU renders (bold/italic/underline/strike/color/size/font, plus
   * OUTLINE via -webkit-text-stroke and HIGHLIGHT via background). Used to build
   * the contenteditable's styled <span>s so editing looks identical to the render.
   *
   * @example runStyleCss({size: 20, color: "#f00", bold: true}).includes("font-weight: bold") // true
   * @example runStyleCss({size: 20, color: "#000", underline: true, strike: true}).includes("underline") // true
   */
  export function runStyleCss(style) {
    const s = runFrom({ text: "", ...style });
    const decos = [];
    if (s.underline) decos.push("underline");
    if (s.strike) decos.push("line-through");
    const parts = [
      `font-size: ${s.size}px`,
      `font-family: ${cssFamilyFor(s.font)}`,
      `font-weight: ${s.bold ? "bold" : "normal"}`,
      `font-style: ${s.italic ? "italic" : "normal"}`,
      `color: ${s.color}`,
      `text-decoration: ${decos.length ? decos.join(" ") : "none"}`,
    ];
    // OUTLINE: -webkit-text-stroke is the CSS glyph-outline (paints the stroke;
    // the fill color stays `color`). Width is in the LOCAL px the whole overlay is
    // scaled by, so it matches the GPU's world-unit outline.
    if ((s.outlineWidth ?? 0) > 0) parts.push(`-webkit-text-stroke: ${s.outlineWidth}px ${s.outlineColor}`);
    // HIGHLIGHT: a background behind the glyphs ("" ⇒ none).
    if (typeof s.highlight === "string" && s.highlight.length > 0) parts.push(`background-color: ${s.highlight}`);
    return parts.join("; ");
  }

  /**
   * Pure function. Escapes text for safe insertion as an HTML text node (so a
   * literal "<" or "&" a user types is not parsed as markup). Newlines are kept
   * as-is (the contenteditable is white-space: pre-wrap; the caller splits runs
   * at "\n" into separate lines only for the plain-text projection).
   *
   * @example escapeHtml("a<b>&c") // "a&lt;b&gt;&amp;c"
   * @example escapeHtml("x\ny") // "x\ny"
   */
  export function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Pure function. Builds the contenteditable's inner HTML from a run list: one
   * <span data-run> per run, styled by runStyleCss, text HTML-escaped. An empty
   * run list yields one empty span (so the caret has a home). Each span carries a
   * data-run index for round-trip debugging (not read back — offsets drive reads).
   *
   * @example runsToHtml([{text: "Hi", bold: true}]).includes("<span") // true
   * @example runsToHtml([]).includes("<span") // true (one empty span)
   */
  export function runsToHtml(runs) {
    const list = runs.length ? runs : [{ text: "" }];
    return list.map((r, i) => {
      const { text, ...style } = r;
      const s = runFrom({ text: "", ...style });
      // data-* carry the keys that don't round-trip from computed CSS (font id,
      // outline spec, highlight) so readRunsFromDom recovers them exactly.
      const data = [
        `data-run="${i}"`,
        `data-font="${s.font}"`,
        `data-outlinecolor="${s.outlineColor}"`,
        `data-outlinewidth="${s.outlineWidth}"`,
        `data-highlight="${s.highlight}"`,
      ].join(" ");
      return `<span ${data} style="${runStyleCss(style)}">${escapeHtml(text ?? "")}</span>`;
    }).join("");
  }
</script>

<script>
  import * as T from "../core/transform.js";
  import { applyRunStyle, applyParaStyle, commonStyle, runStyleAt, normalizeRichText, richTextToPlain, valignOffset, paraStyleFor } from "../core/richtext.js";
  import TextFormatToolbar from "./TextFormatToolbar.svelte";

  // app = the app store; node = the derived render node of the edited item;
  // worldToScreen = (wx,wy)→{x,y} in the render-area frame; zoom = viewport.zoom.
  let { app, node, worldToScreen, zoom } = $props();

  let editEl = $state(null); // the contenteditable div
  // The current character selection [start, end) within the overlay text, tracked
  // on every selectionchange so the toolbar reflects/edits the right range.
  let selRange = $state({ start: 0, end: 0 });
  let seeded = false;

  // ── geometry: overlay is the item's LOCAL box, CSS-transformed to the item's
  // world pose then to screen. font-size is world units; one transform scales the
  // whole local layout to screen so glyphs land where the GPU draws them. ──
  let box = $derived.by(() => {
    const p = T.apply(node.world, 0, 0);        // world top-left
    const s = worldToScreen(p.x, p.y);          // → screen (render-area frame)
    const scale = zoom * (node.world.scale ?? 1); // local units → screen px
    return {
      x: s.x, y: s.y,
      w: node.state.w ?? 0, h: node.state.h ?? 0, // LOCAL box dims (pre-scale)
      scale,
      deg: (node.world.rotation ?? 0) * 180 / Math.PI,
    };
  });

  // The current rich value (preview-blended state — what the user is editing).
  let rich = $derived(normalizeRichText(node.state.text, {
    font: node.state.font, size: node.state.size, color: node.state.color, bold: node.state.bold,
  }));

  // ── VERTICAL ALIGN reflection (Round 15.6): the contenteditable content must
  // sit exactly where the GPU render puts it. The render offsets the whole line
  // stack by core/richtext.valignOffset(valign, boxH, contentH) — so the overlay
  // computes THE SAME offset (NOT a CSS approximation that can drift) and applies
  // it as a local-px padding-top on the editable. contentH is the editable's
  // natural laid-out height, which equals the core layout's height by the WYSIWYG
  // guarantee (same faces, same sizes, same wrap width) — so browser-measured
  // contentH ⇄ core contentH, and the shared valignOffset makes the two placements
  // identical. Measured in LOCAL units directly: the editable's internal layout is
  // local px (font-size = each run's world size), the scale lives on the ROOT's
  // CSS transform, so scrollHeight is already pre-scale local px. min-height sits
  // on the ROOT (not the editable) so the editable stays NATURAL height and
  // scrollHeight is the true content height, never floored to h. ──
  let contentHLocal = $state(0);
  function measureContentH() {
    if (!editEl) return;
    // scrollHeight is the content box INCLUDING the applied valign padding-top;
    // subtract that padding to recover the NATURAL content height (local px,
    // pre-scale). Subtracting the CURRENTLY-applied padding makes the measurement
    // a stable fixed point (natural = scrollHeight − padding; padding =
    // valignOffset(valign, boxH, natural)) — no divergent feedback loop.
    const padTop = parseFloat(getComputedStyle(editEl).paddingTop) || 0;
    contentHLocal = editEl.scrollHeight - padTop;
  }
  // The box-level valign; missing/old ⇒ "top" (a no-op — historical placement).
  let valign = $derived(node.state.valign ?? "top");
  // The local-px top padding that pushes the content stack to top/middle/bottom.
  let vPad = $derived(valignOffset(valign, box.h, contentHLocal));

  // ── HORIZONTAL ALIGN reflection: set the editable's text-align to the box's
  // common paragraph align so a centered/right box reads WYSIWYG-correctly while
  // editing (the single-paragraph and uniform-box cases — the overwhelming
  // majority). FLAG: a box with DIFFERING per-paragraph aligns still edits with
  // one text-align on the overlay (the browser wraps lines into <div> blocks, not
  // one block per paragraph, so per-paragraph text-align in the editable is not
  // reliable); the COMMITTED GPU render is always per-paragraph exact via the
  // model. justify maps to the CSS "justify" the browser supports. ──
  let boxAlign = $derived(node.state.align ?? "left");
  let editAlign = $derived.by(() => {
    // The align shared by every paragraph (via its effective paraStyleFor), else
    // the box default when they differ — a reasonable WYSIWYG choice for a mixed
    // box (the majority case is uniform).
    const aligns = new Set(rich.paras.map((_, i) => paraStyleFor(rich.paras, i, { align: boxAlign }).align));
    return aligns.size === 1 ? [...aligns][0] : boxAlign;
  });

  // ── seed the contenteditable ONCE on mount (subsequent edits flow DOM→runs;
  // re-seeding would fight the browser's live caret/IME state). ──
  $effect(() => {
    if (editEl && !seeded) {
      editEl.innerHTML = runsToHtml(rich.runs); // runsToHtml is in module scope above
      editEl.focus();
      placeCaretEnd(editEl);
      readSelection();
      measureContentH(); // seed the valign content-height measurement
      seeded = true;
    }
  });

  // Re-measure the content height whenever anything that changes the laid-out
  // height changes — the wrap width (box.w), the editable alignment, or the rich
  // value (a run/paragraph edit). Keeps vPad exact after every edit so valign
  // holds while typing. Reads editEl + these deps so Svelte re-runs it.
  $effect(() => {
    void box.w; void editAlign; void rich; // deps
    if (editEl && seeded) measureContentH();
  });

  /** Command. Reads the contenteditable back into a run list, rebuilds the rich
   * value (paras re-derived from the "\n"s), and live-previews it (one undo unit
   * on commit). Runs come from the styled spans; a span with no data-style is a
   * plain run inheriting the box style (typing at a caret extends the neighbor
   * run's style — the browser keeps the span). */
  function onInput() {
    const runs = readRunsFromDom(editEl);
    const paraCount = Math.max(1, richTextToPlain({ runs }).split("\n").length);
    const paras = [];
    for (let i = 0; i < paraCount; i++) paras.push(rich.paras[i] ?? rich.paras[0] ?? {});
    app.previewTextValue({ runs, paras });
    readSelection();
    measureContentH(); // content height may have changed (a new line) → update vPad
  }

  /** Query. Reads the contenteditable DOM back into runs. Walks recursively so the
   * BROWSER's newline representations all map to a "\n" run: a <br>, and the
   * BLOCK BOUNDARY between sibling <div>/<p> blocks the browser wraps lines in when
   * Enter is pressed (Chrome inserts `<div>…</div>` per line). A styled <span> →
   * one run carrying its parsed style; a bare text node → a plain run. Runs stay
   * ~1:1 with the DOM leaves so the caret is stable; applyRunStyle canonicalizes
   * (merges adjacent equal runs) on the next style edit. */
  function readRunsFromDom(root) {
    if (!root) return [{ text: "" }]; // guard: toolbar reads runs before mount
    const runs = [];
    // Block-level children (div/p) each start a NEW line after the first — the
    // boundary IS a "\n". Inline nodes (text/span) contribute their text/style.
    const isBlock = (n) => n.nodeType === Node.ELEMENT_NODE && (n.tagName === "DIV" || n.tagName === "P");
    root.childNodes.forEach((nd, i) => {
      if (isBlock(nd)) {
        if (i > 0) runs.push({ text: "\n" }); // block boundary → newline
        // Recurse into the block for its inline runs.
        for (const r of readRunsFromDom(nd)) runs.push(r);
        return;
      }
      if (nd.nodeType === Node.TEXT_NODE) {
        if (nd.textContent.length) runs.push({ text: nd.textContent });
      } else if (nd.nodeType === Node.ELEMENT_NODE) {
        if (nd.tagName === "BR") { runs.push({ text: "\n" }); return; }
        const text = nd.textContent ?? "";
        if (!text.length) return;
        runs.push({ text, ...styleFromEl(nd) });
      }
    });
    return runs.length ? runs : [{ text: "" }];
  }

  /** Query. Parses an element's inline style back to run-style keys (the inverse
   * of runStyleCss). Only the keys we set are read; anything else defaults via
   * runFrom downstream. */
  function styleFromEl(el) {
    const st = el.style;
    const out = {};
    if (st.fontWeight === "bold" || +st.fontWeight >= 600) out.bold = true;
    if (st.fontStyle === "italic") out.italic = true;
    const deco = st.textDecoration || st.textDecorationLine || "";
    if (deco.includes("underline")) out.underline = true;
    if (deco.includes("line-through")) out.strike = true;
    if (st.fontSize) out.size = parseFloat(st.fontSize);
    if (st.color) out.color = cssColorToHex(st.color);
    // data-* fallbacks carry font id + outline/highlight (not round-trippable
    // from computed CSS reliably) so a style edit preserves them.
    if (el.dataset.font) out.font = el.dataset.font;
    if (el.dataset.outlinecolor) out.outlineColor = el.dataset.outlinecolor;
    if (el.dataset.outlinewidth) out.outlineWidth = parseFloat(el.dataset.outlinewidth);
    if (el.dataset.highlight !== undefined) out.highlight = el.dataset.highlight;
    return out;
  }

  /** Pure-ish. Converts a CSS color (rgb()/hex) to #rrggbb. The browser reports
   * inline colors as "rgb(r, g, b)"; normalize so runs store hex. */
  function cssColorToHex(css) {
    const m = css.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return css.startsWith("#") ? css : "#000000";
    const h = (n) => (+n).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }

  // ── selection tracking (char offsets over the overlay text) ──
  function readSelection() {
    if (!editEl) return; // guard: selectionchange fires globally, incl. mid-unmount
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editEl.contains(sel.anchorNode)) return;
    const a = charOffset(editEl, sel.anchorNode, sel.anchorOffset);
    const b = charOffset(editEl, sel.focusNode, sel.focusOffset);
    selRange = { start: Math.min(a, b), end: Math.max(a, b) };
  }

  /** Query. The character offset of (node, offset) within `root`'s text — MUST
   * count the same characters readRunsFromDom emits (text + a "\n" at each <br>
   * and at each block <div>/<p> boundary after the first) so the selection range
   * maps onto the linear run offset applyRunStyle operates on. */
  const isBlockEl = (n) => n.nodeType === Node.ELEMENT_NODE && (n.tagName === "DIV" || n.tagName === "P");
  function charOffset(root, targetNode, targetOffset) {
    let count = 0, done = false;
    const walk = (n, indexInParent) => {
      if (done) return;
      // Block boundary before a non-first block sibling → a "\n" (matches read).
      if (indexInParent > 0 && isBlockEl(n)) count += 1;
      if (n === targetNode) {
        count += (n.nodeType === Node.TEXT_NODE) ? targetOffset : 0;
        done = true; return;
      }
      if (n.nodeType === Node.TEXT_NODE) { count += n.textContent.length; return; }
      if (n.nodeName === "BR") { count += 1; return; }
      n.childNodes.forEach((c, i) => walk(c, i));
    };
    root.childNodes.forEach((c, i) => walk(c, i));
    return count;
  }

  /** Command. Applies a style delta to the current selection (the toolbar/shortcut
   * primitive). Reads the CURRENT runs from the DOM, applies applyRunStyle over
   * [start, end), previews the new value, and re-seeds the DOM so the styled spans
   * reflect it — then restores the selection. ONE preview (commit on exit = one
   * undo unit). An empty selection updates the caret's pending style by styling
   * nothing (a future keystroke inherits it via runStyleAt). */
  export function applyStyle(delta) {
    const runs = readRunsFromDom(editEl);
    const { start, end } = selRange;
    const newRuns = applyRunStyle(runs, start, end, delta);
    const paraCount = Math.max(1, richTextToPlain({ runs: newRuns }).split("\n").length);
    const paras = [];
    for (let i = 0; i < paraCount; i++) paras.push(rich.paras[i] ?? rich.paras[0] ?? {});
    app.previewTextValue({ runs: newRuns, paras });
    // Re-render the DOM from the new runs and restore the char selection.
    editEl.innerHTML = runsToHtml(newRuns);
    restoreSelection(start, end);
    readSelection();
  }

  /** Command. Applies a PARAGRAPH-style delta (e.g. {align: "center"}) to every
   * paragraph the current selection touches (the align buttons' primitive —
   * core/richtext.applyParaStyle). Reads the CURRENT runs from the DOM (so the
   * live paragraph structure — any typed "\n"s — is honored), overlays the delta
   * on the current paras, and previews the new {runs, paras} value as ONE undo
   * unit (commit on exit). Unlike applyStyle it does NOT re-seed the editable DOM:
   * paragraph align changes no run spans, so the caret/selection stay put; the
   * horizontal reflection is the editable's text-align ($derived editAlign),
   * which re-derives from the previewed paras automatically. */
  export function applyPara(delta) {
    const runs = readRunsFromDom(editEl);
    const { start, end } = selRange;
    const newParas = applyParaStyle(rich.paras, runs, start, end, delta);
    app.previewTextValue({ runs, paras: newParas });
    readSelection();
  }

  /** Command. Restores a char-offset selection [start,end) after re-seeding. */
  function restoreSelection(start, end) {
    const sel = window.getSelection();
    const r = document.createRange();
    const a = nodeAtOffset(editEl, start), b = nodeAtOffset(editEl, end);
    if (!a || !b) return;
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** Query. The (text node, local offset) at char offset `target` within root —
   * counts block-boundary "\n"s the SAME way charOffset/readRunsFromDom do, so a
   * restored selection lands where the char offset expects across newlines. */
  function nodeAtOffset(root, target) {
    let count = 0, found = null;
    const walk = (n, indexInParent) => {
      if (found) return;
      if (indexInParent > 0 && isBlockEl(n)) count += 1; // block boundary "\n"
      if (n.nodeType === Node.TEXT_NODE) {
        if (target <= count + n.textContent.length) { found = { node: n, offset: target - count }; return; }
        count += n.textContent.length;
      } else if (n.nodeName === "BR") {
        count += 1;
      } else {
        n.childNodes.forEach((c, i) => { walk(c, i); });
      }
    };
    root.childNodes.forEach((c, i) => walk(c, i));
    // Past the end → last text node end.
    if (!found) {
      const last = lastTextNode(root);
      if (last) found = { node: last, offset: last.textContent.length };
      else found = { node: root, offset: 0 };
    }
    return found;
  }
  function lastTextNode(root) {
    let last = null;
    const walk = (n) => { if (n.nodeType === Node.TEXT_NODE) last = n; else for (const c of n.childNodes) walk(c); };
    walk(root);
    return last;
  }
  function placeCaretEnd(el) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ── keydown: Enter = newline (NEVER commit — the user ruling "text boxes are
  // REAL boxes"); Ctrl/Cmd+B/I/U toggle on the selection; Cmd+/- step size; Esc
  // commits + exits. Everything else = native typing (contenteditable handles it,
  // and App.onKeydown early-returns on a focused contentEditable so no canvas
  // shortcut fires). ──
  function onKeydown(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") { e.preventDefault(); app.commitTextEdit(); return; }
    if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); toggle("bold"); return; }
    if (mod && (e.key === "i" || e.key === "I")) { e.preventDefault(); toggle("italic"); return; }
    if (mod && (e.key === "u" || e.key === "U")) { e.preventDefault(); toggle("underline"); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); stepSize(SIZE_STEP); return; }
    if (mod && (e.key === "-" || e.key === "_")) { e.preventDefault(); stepSize(-SIZE_STEP); return; }
    // Enter = NEWLINE, never commit (the user ruling "text boxes are REAL boxes").
    // The browser inserts its own line representation (a <div>/<br> in Chrome);
    // readRunsFromDom maps that block boundary to a "\n" run, so onInput (fired
    // natively after) syncs the newline. We do NOT preventDefault — letting the
    // browser keep native caret/IME behavior is exactly the "native text editing"
    // feel the user loved; we just interpret the result into runs.
    // Everything else = native typing (onInput syncs runs after).
  }

  const SIZE_STEP = 2; // px per Cmd+/- step — the PPT default increment

  /** Command. Toggles a boolean run style over the selection: reads the current
   * common value and flips it (mixed → sets true, the PPT convention). */
  function toggle(key) {
    const cur = commonStyle(readRunsFromDom(editEl), selRange.start, selRange.end, key);
    applyStyle({ [key]: cur === true ? false : true });
  }

  /** Command. Steps every covered run's size by `delta`, clamped to >= 1. */
  function stepSize(delta) {
    const runs = readRunsFromDom(editEl);
    const { start, end } = selRange;
    // Size varies per run — apply relative to each run's own size by splitting at
    // the selection then bumping. applyRunStyle sets ONE value, so read the common
    // (or the caret's) size and set the stepped value (PPT steps the whole
    // selection to the next size when uniform; when mixed, from the caret size).
    const base = commonStyle(runs, start, end, "size") ?? runStyleAt(runs, start).size ?? 36;
    applyStyle({ size: Math.max(1, base + delta) });
  }

  // Selection tracking while the overlay is focused.
  $effect(() => {
    const handler = () => readSelection();
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  });

  // Dev/test seam (mirrors window.__powerrp_app): headless probes drive the REAL
  // component methods through this while the overlay is mounted. Cleared on
  // unmount so it never dangles. Not used by the app itself.
  $effect(() => {
    window.__powerrp_textEdit = {
      applyStyle,
      applyPara, // paragraph-align edit path (Round 15.6 — the toolbar's onparastyle)
      setSelection: (a, b) => { selRange = { start: a, end: b }; },
    };
    return () => { if (window.__powerrp_textEdit) delete window.__powerrp_textEdit; };
  });
</script>

<!-- The overlay: an absolutely-positioned box in the render-area frame, at the
     item's world top-left, transformed by its world rotation + scale (about the
     top-left, so it lines up with a rotated/scaled widget). The contenteditable
     inside uses LOCAL (world-unit) font sizes; the transform scales it to screen.
     Dismissal is NOT handled here: every exit path (Esc aside) funnels through
     app.dismissTextEdit() — the capture-phase pointer listener in App.svelte and
     the slideIndex/selection accessors (Round 15.2). No onblur handler exists. -->
<div
  class="text-edit-overlay-root"
  style:left="{box.x}px"
  style:top="{box.y}px"
  style:min-height="{box.h}px"
  style:transform="rotate({box.deg}deg) scale({box.scale})"
>
  <!-- VERTICAL align (Round 15.6): min-height sits on the ROOT (so the editable
       stays natural height and scrollHeight is the true content height), and the
       editable carries a padding-top of vPad (the SAME core valignOffset the GPU
       render uses) to push the stack top/middle/bottom. text-align reflects the
       box's horizontal align so editing reads WYSIWYG. -->
  <div
    class="text-edit-overlay"
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    spellcheck="true"
    bind:this={editEl}
    style:width="{box.w}px"
    style:padding-top="{vPad}px"
    style:text-align={editAlign}
    oninput={onInput}
    onkeydown={onKeydown}
  ></div>
  <TextFormatToolbar
    {app}
    boxScale={box.scale}
    onstyle={applyStyle}
    onparastyle={applyPara}
    {selRange}
    runsAt={() => readRunsFromDom(editEl)}
    parasAt={() => rich.paras}
    {boxAlign}
  />
</div>
