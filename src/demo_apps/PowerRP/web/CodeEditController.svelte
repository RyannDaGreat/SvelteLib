<!--
  CodeEditController — a multi-line CODE editor mounted as a DOM overlay over the
  canvas at (near) a widget's screen pose, for editing a widget's multi-line
  "code" property (Mermaid's `definition`; reusable for codeblock's `code`). It
  mirrors LatexEditController's mount/commit/one-undo lifecycle, but the editor
  is a plain TEXTAREA with a syntax-highlight overlay rather than a structural
  math field — code is just text.

  WHY A TEXTAREA + HIGHLIGHT-OVERLAY (not CodeMirror): the dump must stay
  self-contained and offline (no extra heavy dependency), and the repo already
  ships a pure, dependency-free highlighter (core/codeHighlight.js) used by the
  codeblock widget. So the editor renders a transparent <textarea> (which owns
  the caret, selection, IME, clipboard, scrolling) over an aria-hidden <pre>
  whose spans are colored by that SAME highlighter — one code-color source of
  truth, zero new deps. Mermaid has no highlighter grammar, so its definition
  shows as plain monospace (still a proper multi-line editor); a codeblock
  language colorizes.

  WHY NO CANVAS "POP" (the deliberate difference from latex): the overlay is just
  text being edited; the canvas diagram beneath is SUPPRESSED during the edit
  (CanvasView paint filter, exactly like the latex equation) so there is no
  double image, and on commit the freshly re-rendered diagram fades in beneath
  this panel as it fades out.

  LIFECYCLE (mirrors the latex seams on app.svelte.js):
    beginCodeEdit(itemId, property, language) → mount here → previewCodeValue
    (every input, stages the string; the canvas is suppressed so nothing
    re-renders per keystroke) → Escape / Cmd+Enter / click-away → commitCodeEdit
    (one undo unit) → closing crossfade → finishCodeEdit (unmount). An invalid
    definition is LOUD on commit: the widget's emit() draws the red error
    affordance from the parser message — never a blank widget.

  Styling lives in app.css (.code-edit-*; app convention: no <style>). The root
  keeps `.code-edit-overlay-root` so App.svelte's click-away dismissal treats
  clicks inside the panel as in-editor, not click-away.
-->
<script>
  import * as T from "../core/transform.js";
  import { highlightCode, KINDS } from "../core/codeHighlight.js";
  import { MERMAID_TEMPLATES } from "../plugins/mermaid.js";

  // EXAMPLE-TEMPLATE registry (widget type → canned example diagrams). Keeps this
  // editor GENERIC: the picker appears ONLY for a type that HAS templates. Only
  // mermaid ships them today (imported as plain data from the mermaid plugin — a
  // small, deliberate in-lane coupling for the showcase); codeblock could add its
  // own entry here later without touching the editor's core.
  const TEMPLATES_BY_TYPE = { mermaid: MERMAID_TEMPLATES };

  // app = the app store; node = the edited item's derived render node;
  // worldToScreen = the PanZoom camera map (render-area frame); zoom =
  // viewport.zoom. The editor reads WHICH property + language from
  // app.codeEditing (so one controller serves mermaid, codeblock, …).
  let { app, node, worldToScreen, zoom } = $props();

  // Crossfade duration for enter/exit. MUST equal --a-code-edit-crossfade in
  // app.css (JS drives the unmount timer; CSS drives the opacity transition).
  const CROSSFADE_MS = 120;
  // Indent unit inserted by Tab / removed by Shift+Tab. Two spaces — the common
  // default for the diagram/markup languages this editor targets (mermaid, YAML-
  // ish); a named unit so the width lives in one place.
  const CODE_EDIT_INDENT = "  ";
  // Bracket auto-close pairs (a light editor affordance; quotes deliberately
  // omitted — they appear in prose labels where auto-closing annoys).
  const AUTO_OPEN = { "(": ")", "[": "]", "{": "}" };
  const AUTO_CLOSE = new Set([")", "]", "}"]);
  const VALID_KINDS = new Set(KINDS); // guard kind → CSS-var name (never inject arbitrary)

  let taEl = $state(null);  // the <textarea>
  let preEl = $state(null); // the highlight <pre>
  let shown = $state(false);// opacity gate: false→true fades in; true→false fades out
  let html = $state("");    // highlighted HTML mirrored into the <pre>
  let seeded = false;       // one-shot mount guard (non-reactive)

  // WHICH property/language this edit targets (from app.codeEditing).
  let property = $derived(app.codeEditing?.property ?? "code");
  let language = $derived(app.codeEditing?.language ?? null);

  // Panel box: pinned to the widget's screen top-left, sized to the widget's
  // on-screen footprint (rotation ignored — a code editor is axis-aligned),
  // then clamped up to a comfortable minimum by app.css. A fixed readable font
  // (not zoom-scaled) keeps code legible at any zoom.
  let box = $derived.by(() => {
    const p = T.apply(node.world, 0, 0);
    const sc = worldToScreen(p.x, p.y);
    const s = zoom * (node.world.scale ?? 1);
    return { x: sc.x, y: sc.y, w: (node.state.w ?? 0) * s, h: (node.state.h ?? 0) * s };
  });

  let title = $derived(`${node.type} · ${property}`);
  // The example templates for THIS widget type, or null (→ no picker shown).
  let templates = $derived(node?.type ? (TEMPLATES_BY_TYPE[node.type] ?? null) : null);

  /** Pure function. Escapes text for safe insertion as <pre> HTML content.
   * @example escapeHtml("a<b & c>") // "a&lt;b &amp; c&gt;"
   */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Pure function. Renders code to highlighted <pre> HTML using the shared
   * highlighter: one color-styled <span> per token, tokens joined verbatim per
   * line, lines joined by "\n" (so the <pre> text matches the textarea value
   * character-for-character — the alignment lever). Each color is an app.css
   * --a-code-<kind> var, so the palette tracks the active theme. An unsupported
   * language yields plain (monochrome) tokens — a valid multi-line editor still.
   *
   * @example highlightToHtml("x", "plain").includes("var(--a-code-plain)") // true
   */
  function highlightToHtml(code, lang) {
    const lines = highlightCode(code, lang);
    return lines
      .map((toks) => toks
        .map((t) => {
          const kind = VALID_KINDS.has(t.kind) ? t.kind : "plain";
          return `<span style="color:var(--a-code-${kind})">${escapeHtml(t.text)}</span>`;
        })
        .join(""))
      .join("\n");
  }

  /** Command. Keeps the highlight <pre> scrolled in lockstep with the textarea. */
  function syncScroll() {
    if (preEl && taEl) { preEl.scrollTop = taEl.scrollTop; preEl.scrollLeft = taEl.scrollLeft; }
  }

  /** Command. Re-reads the textarea, re-highlights, stages the value into the
   * app preview (one undo unit lands on commit), and re-syncs scroll. Called on
   * every input AND after any programmatic edit (Tab, auto-close). */
  function syncFromTextarea() {
    if (!taEl) return;
    html = highlightToHtml(taEl.value, language);
    app.previewCodeValue(taEl.value);
    requestAnimationFrame(syncScroll);
  }

  /** Command. Replaces the textarea value + selection programmatically, then
   * re-syncs (a manual value set does NOT fire `input`). */
  function applyValue(value, selStart, selEnd) {
    taEl.value = value;
    taEl.selectionStart = Math.max(0, selStart);
    taEl.selectionEnd = Math.max(0, selEnd);
    syncFromTextarea();
  }

  function onInput() {
    syncFromTextarea();
  }

  /** Command. Replaces the editor content with the picked example template
   * (staged via applyValue → preview; committed when the editor closes). Resets
   * the select back to its placeholder so it acts as an action MENU, not a
   * persistent value. No-op if the chosen name isn't found. */
  function onPickTemplate(e) {
    const chosen = templates?.find((t) => t.name === e.target.value);
    e.target.selectedIndex = 0; // back to the "Template…" placeholder
    if (chosen) applyValue(chosen.definition, 0, 0); // caret at the top of the new template
  }

  /** Command. Tab indents / Shift+Tab dedents. A caret with no selection inserts
   * one indent unit; a selection indents/dedents every line it spans. */
  function handleTab(dedent) {
    const s = taEl.selectionStart, e = taEl.selectionEnd, v = taEl.value;
    if (s === e && !dedent) {
      applyValue(v.slice(0, s) + CODE_EDIT_INDENT + v.slice(e), s + CODE_EDIT_INDENT.length, s + CODE_EDIT_INDENT.length);
      return;
    }
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    let lineEnd = v.indexOf("\n", e > s ? e : s);
    if (lineEnd === -1) lineEnd = v.length;
    const before = v.slice(0, lineStart), block = v.slice(lineStart, lineEnd), after = v.slice(lineEnd);
    let deltaFirst = 0, deltaTotal = 0;
    const out = block.split("\n").map((ln, i) => {
      if (dedent) {
        const removed = (ln.match(new RegExp(`^ {1,${CODE_EDIT_INDENT.length}}`)) || [""])[0].length;
        if (i === 0) deltaFirst = -removed;
        deltaTotal -= removed;
        return ln.slice(removed);
      }
      if (i === 0) deltaFirst = CODE_EDIT_INDENT.length;
      deltaTotal += CODE_EDIT_INDENT.length;
      return CODE_EDIT_INDENT + ln;
    });
    applyValue(before + out.join("\n") + after, s + deltaFirst, e + deltaTotal);
  }

  /** Command. Inserts an auto-closed bracket pair, caret between the two. */
  function insertPair(open, close) {
    const s = taEl.selectionStart, e = taEl.selectionEnd, v = taEl.value;
    applyValue(v.slice(0, s) + open + v.slice(s, e) + close + v.slice(e), s + 1, s + 1 + (e - s));
  }

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); app.dismissCodeEdit(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); app.dismissCodeEdit(); return; }
    if (e.key === "Tab") { e.preventDefault(); handleTab(e.shiftKey); return; }
    // Skip OVER a just-typed closing bracket instead of inserting a duplicate.
    if (AUTO_CLOSE.has(e.key) && taEl.selectionStart === taEl.selectionEnd
        && taEl.value[taEl.selectionStart] === e.key) {
      e.preventDefault();
      taEl.selectionStart = taEl.selectionEnd = taEl.selectionStart + 1;
      return;
    }
    // Auto-close an opening bracket (wrapping any selection).
    if (AUTO_OPEN[e.key] !== undefined) {
      e.preventDefault();
      insertPair(e.key, AUTO_OPEN[e.key]);
      return;
    }
  }

  // Seed + focus ONCE on mount, then fade in. The value is NEVER re-synced from
  // `node` afterward — during the edit the textarea is the source of truth.
  $effect(() => {
    if (!taEl || seeded) return;
    seeded = true;
    taEl.value = node.state?.[property] ?? "";
    html = highlightToHtml(taEl.value, language);
    taEl.focus();
    taEl.selectionStart = taEl.selectionEnd = taEl.value.length;
    requestAnimationFrame(() => { shown = true; syncScroll(); });
  });

  // CLOSING crossfade: commitCodeEdit sets codeEditing.closing (which un-
  // suppresses the canvas diagram beneath); fade this panel out, then unmount.
  $effect(() => {
    if (!app.codeEditing?.closing) return;
    shown = false;
    const t = setTimeout(() => app.finishCodeEdit(), CROSSFADE_MS);
    return () => clearTimeout(t);
  });

  // FORCED-UNMOUNT SAFETY: if this controller unmounts while still editing and
  // NOT closing (e.g. the edited item left the current slide mid-edit, so
  // codeEditNode went null), drop the staged preview so no dangling previewDelta
  // survives. The normal commit path clears codeEditing before unmount, so this
  // cleanup is a no-op then. (Empty body → runs once; cleanup fires on unmount.)
  $effect(() => () => {
    if (app.codeEditing && !app.codeEditing.closing) app.cancelCodeEdit();
  });

  // Dev/test seam (mirrors window.__powerrp_latexEdit). Headless probes drive
  // the REAL textarea: read/replace the code and commit. Cleared on unmount.
  $effect(() => {
    window.__powerrp_codeEdit = {
      getValue: () => taEl?.value ?? "",
      setValue: (v) => { if (taEl) { taEl.value = v; syncFromTextarea(); } },
      commit: () => app.dismissCodeEdit(),
      box: () => ({ ...box }),
    };
    return () => { if (window.__powerrp_codeEdit) delete window.__powerrp_codeEdit; };
  });
</script>

<!-- Root pinned at the widget's screen top-left (render-area frame). Keeps the
     `.code-edit-overlay-root` class for App.svelte's click-away guard. -->
<div class="code-edit-overlay-root" style:left="{box.x}px" style:top="{box.y}px">
  <div
    class="code-edit-panel"
    class:code-edit-shown={shown}
    style:width="{box.w}px"
    style:height="{box.h}px"
  >
    <div class="code-edit-header">
      <span class="code-edit-title">{title}</span>
      {#if templates}
        <!-- EXAMPLE-TEMPLATE picker: flip the editor content between canned
             diagrams (the showcase). Native <select> so it needs no app.css
             rule (out-of-lane) — it acts as an action menu (resets to the
             placeholder after each pick). -->
        <select class="code-edit-template" onchange={onPickTemplate} aria-label="Insert example template">
          <option value="" disabled selected>Template…</option>
          {#each templates as t}<option value={t.name}>{t.name}</option>{/each}
        </select>
      {/if}
      <span class="code-edit-hint">Esc / ⌘⏎ to apply</span>
    </div>
    <div class="code-edit-body">
      <pre class="code-edit-highlight" aria-hidden="true" bind:this={preEl}>{@html html}</pre>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="code-edit-input"
        bind:this={taEl}
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        oninput={onInput}
        onkeydown={onKeydown}
        onscroll={syncScroll}
      ></textarea>
    </div>
  </div>
</div>
